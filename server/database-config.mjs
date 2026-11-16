import { X509Certificate } from 'node:crypto';

const projectRef = 'xgauehtwksmnoqhgqegm';
const directHost = `db.${projectRef}.supabase.co`;
const appRole = 'hub_app_server';

function trustedCa(value, now) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 32768) throw new Error('HUB_DATABASE_CA_PEM must contain trusted CA certificates.');
  const certificates = value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (!certificates.length || certificates.length > 4 || value.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) {
    throw new Error('HUB_DATABASE_CA_PEM must contain only PEM CA certificates.');
  }
  for (const pem of certificates) {
    let certificate;
    try { certificate = new X509Certificate(pem); }
    catch { throw new Error('HUB_DATABASE_CA_PEM contains an invalid certificate.'); }
    if (!certificate.ca || Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
      throw new Error('HUB_DATABASE_CA_PEM requires currently valid CA certificates.');
    }
  }
  return certificates.join('\n') + '\n';
}

export function databaseConfig(environment = process.env, now = Date.now()) {
  let url, user, password;
  try {
    url = new URL(environment.HUB_DATABASE_URL);
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    // URL/parser errors can include credentials. Return only configuration guidance.
    throw new Error('HUB_DATABASE_URL must be a valid private PostgreSQL connection URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !password || url.pathname !== '/postgres' || (url.port && url.port !== '5432') || url.hash) {
    throw new Error('HUB_DATABASE_URL requires the postgres database, port 5432 and a private application-role password.');
  }
  const direct = url.hostname === directHost && user === appRole;
  const pooled = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) && user === `${appRole}.${projectRef}`;
  if (!direct && !pooled) throw new Error('Use the exact Hub application role and the verified Supabase direct or session-pooler host.');
  if (url.search) throw new Error('HUB_DATABASE_URL must not contain query parameters. Configure trusted TLS with HUB_DATABASE_CA_PEM.');
  const ca = trustedCa(environment.HUB_DATABASE_CA_PEM, now);
  // Explicit fields prevent pg connection-string parameters from overriding TLS,
  // role, host or database. Normal hostname verification remains enabled.
  return {
    host: url.hostname,
    port: 5432,
    database: 'postgres',
    user,
    password,
    application_name: 'caremetric-support-hub',
    max: 8,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    ssl: { rejectUnauthorized: true, servername: url.hostname, ...(ca ? { ca } : {}) },
  };
}

/**
 * Keeps a dropped database connection from stopping the Hub. pg-pool emits 'error' on the pool when an idle connection fails, and a pg
 * client emits 'error' on itself when its socket dies while it is checked out (pg-pool removes its own listener on checkout, and the Hub
 * holds connections across Stripe and Telnyx calls inside transactions). With no listener either one is an uncaught exception and the
 * process exits. The query in flight still fails and its caller handles that; the pool opens a new connection for the next one.
 * One line per lost connection, logged by the connection's own listener, without the error's text, which can name the host or role.
 */
export function guardPool(pool, log = console) {
  const dropped = () => log.warn('A database connection dropped; the next query opens a new one.');
  // An idle connection's failure is reported on the connection first (below), then on the pool: counted once.
  pool.on('error', () => {});
  pool.on('connect', client => client.on('error', dropped));
  return pool;
}
