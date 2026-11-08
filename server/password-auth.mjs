import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { digest, token, transaction, HttpError } from './sms-auth.mjs';

const derive = promisify(scrypt);
// OWASP's N=2^15, r=8, p=3 scrypt profile: 32 MiB per derivation.
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const hashPattern = /^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const dummyHash = `scrypt$32768$8$3$${'0'.repeat(32)}$${'0'.repeat(64)}`;
let hashing = 0;
async function key(password, salt) {
  // Bound memory/CPU as well as persisted request counts; do not queue an
  // unbounded number of expensive jobs on the shared libuv worker pool.
  if (hashing >= 2) throw new HttpError(429, 'Sign-in is busy. Please try again shortly.');
  hashing++;
  try { return await derive(password, salt, 32, options); }
  finally { hashing--; }
}
export function normalizeUsername(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  const username = value.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) return username;
  const email = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  return username.length <= 254 && username.indexOf('@') <= 64 && email.test(username) ? username : null;
}
const normalizedPassword = value => typeof value === 'string' && value.length <= 256 && Buffer.byteLength(value) <= 1024
  && [...value.normalize('NFC')].length <= 128 ? value.normalize('NFC') : null;
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$32768$8$3$${salt}$${(await key(password, Buffer.from(salt, 'hex'))).toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const match = hashPattern.exec(encoded ?? '');
  const [, salt, expected] = match ?? hashPattern.exec(dummyHash);
  const actual = await key(password, Buffer.from(salt, 'hex'));
  return timingSafeEqual(actual, Buffer.from(expected, 'hex')) && Boolean(match);
}
const invalidLogin = () => new HttpError(401, 'The sign-in details are incorrect.');
const commonPasswords = new Set(['password12', 'password123', '1234567890', 'qwertyuiop', 'letmein1234', 'passwordpassword', 'passwordpassword123', '123456789012345', '1234567890123456', 'qwertyuiopasdfgh', 'letmeinletmeinletmein']);
function credentials(input, setting = false) {
  const username = normalizeUsername(input?.username), password = normalizedPassword(input?.password);
  if (!username || password === null) throw new HttpError(400, setting ? 'Use a valid email address or a username of 3–64 letters, numbers, dots, underscores or hyphens and a password of 10–128 characters.' : 'Enter your email or username and password.');
  if (setting && ([...password].length < 10 || commonPasswords.has(password.toLowerCase()) || /^(.)\1+$/u.test(password))) {
    throw new HttpError(400, 'Choose a password of 10–128 characters that is not a common or repeated password.');
  }
  return { username, password };
}
const ownerSessionQuery = `select s.id,s.user_id,s.identity_version,s.auth_method,
  s.created_at>now()-interval '10 minutes' as recent_sms,
  c.username,c.password_hash,c.credential_version
  from private.sms_sessions s left join private.password_credentials c on c.user_id=s.user_id
  where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now()
    and private.password_owner_is_usable(s.user_id,s.identity_version)
    and (s.auth_method='sms' or (c.identity_version=s.identity_version and c.credential_version=s.credential_version))`;

export function passwordAuth({ pool }) {
  async function ownerSession(db, sessionToken) {
    if (!sessionToken) throw new HttpError(401, 'Sign in to manage your password.');
    const { rows: [session] } = await db.query(ownerSessionQuery, [digest(sessionToken)]);
    if (!session) throw new HttpError(401, 'Sign in to manage your password.');
    return session;
  }
  async function limit(username, clientAddress) {
    await transaction(pool, async db => {
      await db.query("select pg_advisory_xact_lock(hashtextextended('hub_password_attempts',0))");
      const hashes = [digest(username), digest(clientAddress || 'unknown')];
      const { rows: [counts] } = await db.query(`select count(*) as total,
        count(*) filter(where username_hash=$1) as username_count,
        count(*) filter(where client_hash=$2) as client_count
        from private.password_attempts where created_at>now()-interval '15 minutes'`, hashes);
      if (Number(counts.total) >= 300 || Number(counts.username_count) >= 10 || Number(counts.client_count) >= 40) {
        throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes or use SMS recovery.');
      }
      await db.query("delete from private.password_attempts where created_at<now()-interval '1 day'");
      await db.query('insert into private.password_attempts(username_hash,client_hash) values($1,$2)', hashes);
    });
  }
  async function lock(db, user) {
    await db.query("select pg_advisory_xact_lock(hashtextextended('hub_password:'||$1,0))", [user]);
  }
  async function session(db, identity) {
    const value = token();
    await db.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,auth_method,credential_version,expires_at)
      values($1,$2,$3,$4,'password',$5,now()+interval '8 hours')`,
    [randomUUID(), digest(value), identity.user_id, identity.identity_version, identity.credential_version]);
    return value;
  }
  return {
    async login(input, clientAddress, previousSession) {
      const { username, password } = credentials(input);
      await limit(username, clientAddress);
      const query = `select c.* from private.password_credentials c where c.username=$1
        and private.password_owner_is_usable(c.user_id,c.identity_version)`;
      const { rows: [identity] } = await pool.query(query, [username]);
      const accepted = await verifyPassword(password, identity?.password_hash);
      if (!accepted || !identity) throw invalidLogin();
      return transaction(pool, async db => {
        await lock(db, identity.user_id);
        const { rows: [current] } = await db.query(query + ' for update of c', [username]);
        if (!current || current.credential_version !== identity.credential_version || current.password_hash !== identity.password_hash) throw invalidLogin();
        const value = await session(db, current);
        if (previousSession) await db.query('update private.sms_sessions set revoked_at=now() where token_hash=$1', [digest(previousSession)]);
        return value;
      });
    },
    async settings(sessionToken) {
      const current = await ownerSession(pool, sessionToken);
      return { username: current.username ?? '', configured: Boolean(current.password_hash),
        can_reset: current.auth_method === 'sms' && (!current.password_hash || current.recent_sms) };
    },
    async save(sessionToken, input, clientAddress) {
      const { username, password } = credentials(input, true);
      const before = await ownerSession(pool, sessionToken);
      await limit(`change:${before.user_id}`, clientAddress);
      const smsReset = before.auth_method === 'sms' && (!before.password_hash || before.recent_sms);
      if (!smsReset) {
        const oldPassword = normalizedPassword(input?.currentPassword);
        if (oldPassword === null || !await verifyPassword(oldPassword, before.password_hash)) {
          throw new HttpError(401, 'Enter your current password, or sign in with a new SMS code to reset it.');
        }
      }
      const encoded = await hashPassword(password);
      return transaction(pool, async db => {
        await lock(db, before.user_id);
        const current = await ownerSession(db, sessionToken);
        if (current.credential_version !== before.credential_version || current.password_hash !== before.password_hash
          || current.identity_version !== before.identity_version
          || (smsReset && current.password_hash && !current.recent_sms)) {
          throw new HttpError(409, 'Your sign-in changed. Reload and try again.');
        }
        const { rows: [saved] } = await db.query(`insert into private.password_credentials(user_id,identity_version,username,password_hash)
          values($1,$2,$3,$4) on conflict(user_id) do update set identity_version=excluded.identity_version,
          username=excluded.username,password_hash=excluded.password_hash returning user_id,identity_version,credential_version`,
        [current.user_id, current.identity_version, username, encoded]);
        // The credential trigger revoked all earlier sessions. Issue a fresh
        // password session only after that write, in this same transaction.
        return session(db, saved);
      }).catch(error => {
        if (error?.code === '23505') throw new HttpError(409, 'That email or username is unavailable. Choose another.');
        throw error;
      });
    },
  };
}
