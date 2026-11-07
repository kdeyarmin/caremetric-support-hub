import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizePhone } from './sms-provider.mjs';

export const sessionCookie = '__Host-caremetric_session';
export const challengeCookie = '__Host-caremetric_challenge';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const cookie = (name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
export function readCookie(header, name) {
  const values = (header || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[a-zA-Z0-9_-]{43}$/.test(value) ? value : null;
}
export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export async function transaction(pool, operation) {
  const connection = await pool.connect();
  try {
    await connection.query('begin');
    await connection.query("set local statement_timeout='12s'");
    const result = await operation(connection);
    await connection.query('commit');
    return result;
  } catch (error) {
    await connection.query('rollback').catch(() => {});
    throw error;
  } finally { connection.release(); }
}

export function smsAuth({ pool, provider, log = console }) {
  // Codes in flight, by challenge: a verify for one waits for its send to be recorded (in this process).
  const deliveries = new Map();
  // The text is sent after the challenge is committed and outside the global lock, so a registered and an unregistered number
  // get the same answer at the same speed, and a slow provider never holds up other sign-ins. A failed send is not reported to
  // the requester (that would say the number is registered); they ask again after the 60-second wait.
  const deliver = (id, phone) => {
    const delivery = (async () => {
      try {
        const providerId = await provider.send(phone);
        await pool.query('update private.sms_challenges set provider_id=$2 where id=$1 and consumed_at is null', [id, providerId]);
      } catch {
        log.warn?.('An SMS sign-in code could not be sent; the requester can ask again.');
      }
    })().finally(() => deliveries.delete(id));
    deliveries.set(id, delivery);
  };
  return {
    async start(rawPhone, clientAddress) {
      const phone = normalizePhone(rawPhone);
      if (!phone) throw new HttpError(400, 'Enter a mobile number with country code.');
      const browserToken = token();
      const id = randomUUID();
      const phoneHash = digest(phone);
      const clientHash = digest(clientAddress || 'unknown');
      const registered = await transaction(pool, async db => {
        // Global + per-number persisted limits also cover restarts and multiple replicas. The global cap guards real
        // sends, so requests for unregistered numbers (which send nothing) cannot use it up and lock the owner out;
        // those stay bounded per visitor and per number.
        await db.query("select pg_advisory_xact_lock(hashtextextended('hub_sms_start',0))");
        const { rows: [limits] } = await db.query(`select
          count(*) filter(where user_id is not null) as total,
          count(*) filter(where phone_hash=$1) as phone_count,
          count(*) filter(where client_hash=$2) as client_count,
          count(*) filter(where phone_hash=$1 and created_at>now()-interval '60 seconds') as recent
          from private.sms_challenges where created_at>now()-interval '15 minutes'`, [phoneHash, clientHash]);
        if (Number(limits.total) >= 100 || Number(limits.phone_count) >= 5 || Number(limits.client_count) >= 30 || Number(limits.recent) > 0) {
          throw new HttpError(429, 'Please wait before requesting another code.');
        }
        const { rows: [identity] } = await db.query('select * from private.usable_sms_identity($1)', [phone]);
        await db.query('update private.sms_challenges set consumed_at=now() where phone_hash=$1 and consumed_at is null', [phoneHash]);
        await db.query(`insert into private.sms_challenges(id,user_id,identity_version,phone_hash,client_hash,browser_hash)
          values($1,$2,$3,$4,$5,$6)`, [id, identity?.user_id ?? null, identity?.identity_version ?? null, phoneHash, clientHash, digest(browserToken)]);
        return Boolean(identity);
      });
      // Unknown numbers receive the same response without creating a user or sending SMS.
      if (registered) deliver(id, phone);
      return { id, browserToken };
    },
    async verify(id, browserToken, code, previousSession) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '') || !browserToken || !/^[0-9]{6}$/.test(code || '')) {
        throw new HttpError(400, 'The code could not be verified. Request a new code.');
      }
      await deliveries.get(id);
      const result = await transaction(pool, async db => {
        const { rows: [challenge] } = await db.query(`select c.*,i.phone_e164 from private.sms_challenges c
          left join private.sms_identities i on i.user_id=c.user_id and i.identity_version=c.identity_version and i.revoked_at is null
          where c.id=$1 and c.browser_hash=$2 and c.consumed_at is null and c.expires_at>now() and c.attempts<5
          for update of c`, [id, digest(browserToken)]);
        if (!challenge) return null;
        await db.query('update private.sms_challenges set attempts=attempts+1 where id=$1', [id]);
        let accepted = false;
        if (challenge.provider_id && challenge.phone_e164) {
          try { accepted = await provider.verify(challenge.provider_id, challenge.phone_e164, code); } catch { /* No credentials or code in error output. */ }
        }
        if (!accepted) return null;
        const { rows: [identity] } = await db.query('select * from private.usable_sms_identity($1)', [challenge.phone_e164]);
        if (!identity || identity.user_id!==challenge.user_id || identity.identity_version!==challenge.identity_version) return null;
        await db.query('update private.sms_identities set verified_at=coalesce(verified_at,now()) where user_id=$1 and identity_version=$2', [challenge.user_id,challenge.identity_version]);
        await db.query('update private.sms_challenges set consumed_at=now() where id=$1', [id]);
        const sessionToken = token();
        const sessionId = randomUUID();
        await db.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at)
          values($1,$2,$3,$4,now()+interval '8 hours')`, [sessionId, digest(sessionToken), challenge.user_id, challenge.identity_version]);
        if (previousSession) await db.query('update private.sms_sessions set revoked_at=now() where token_hash=$1', [digest(previousSession)]);
        return sessionToken;
      });
      if (!result) throw new HttpError(401, 'The code is incorrect, expired, or already used.');
      return result;
    },
    async logout(sessionToken) {
      if (sessionToken) await pool.query('update private.sms_sessions set revoked_at=now() where token_hash=$1', [digest(sessionToken)]);
    },
  };
}

/** The Hub is private to its owner, the platform administrator. Every check rereads the database, so revoking access takes effect on the next request. */
export function ownerAccess(pool) {
  return { allows: token => withSession(pool, token, async db => { await db.query('select hub.authorize_app_admin()'); return true; }).catch(() => false) };
}

export async function withSession(pool, sessionToken, operation, required = true) {
  return transaction(pool, async db => {
    let session = null;
    if (sessionToken) {
      const result = await db.query(`select s.id,s.user_id from private.sms_sessions s
        join private.sms_identities i on i.user_id=s.user_id and i.identity_version=s.identity_version
        where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now() and i.revoked_at is null`, [digest(sessionToken)]);
      session = result.rows[0] ?? null;
    }
    if (!session && required) throw new HttpError(401, 'Sign in with an SMS code to continue.');
    await db.query(session ? 'set local role authenticated' : 'set local role anon');
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(session
      ? { sub: session.user_id, role: 'authenticated', sms_session_id: session.id, amr: [{ method: 'sms' }] }
      : { role: 'anon' })]);
    return operation(db, session);
  });
}
