import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { databaseConfig, guardPool } from './database-config.mjs';

const host = 'db.xgauehtwksmnoqhgqegm.supabase.co';
const url = `postgresql://hub_app_server:synthetic-test-password@${host}:5432/postgres`;
const ca = readFileSync(new URL('./fixtures/supabase-prod-ca-2021.crt', import.meta.url), 'utf8');
const now = Date.UTC(2026, 8, 11);
const config = (value = url, extra = {}) => databaseConfig({ HUB_DATABASE_URL: value, ...extra }, now);

describe('restricted PostgreSQL connection configuration', () => {
  it('keeps exact role, host and strict CA/hostname verification in the real pg client', () => {
    const client = new pg.Client(config(url, { HUB_DATABASE_CA_PEM: ca }));
    expect(client.connectionParameters).toMatchObject({ host, port: 5432, user: 'hub_app_server', database: 'postgres' });
    expect(client.connectionParameters.ssl).toMatchObject({ rejectUnauthorized: true, servername: host, ca });
    expect(client.connectionParameters.ssl.checkServerIdentity).toBeUndefined();
    expect(config().connectionString).toBeUndefined();
    expect(config().ssl).toEqual({ rejectUnauthorized: true, servername: host });
  });
  it('supports project-qualified session-pooler identities without inventing a pooler host', () => {
    const pooled = 'postgresql://hub_app_server.xgauehtwksmnoqhgqegm:synthetic@verified-fixture.pooler.supabase.com:5432/postgres';
    expect(config(pooled)).toMatchObject({ host: 'verified-fixture.pooler.supabase.com', user: 'hub_app_server.xgauehtwksmnoqhgqegm' });
    expect(() => config(pooled.replace('xgauehtwksmnoqhgqegm', 'anotherproject'))).toThrow('exact Hub application role');
    expect(() => config(pooled.replace(':5432', ':6543'))).toThrow('port 5432');
  });
  it('rejects owner roles, lookalike roles and other database destinations', () => {
    for (const role of ['postgres', 'service_role', 'hub_app_server_admin', 'hub_app_server.other', 'hub_app_server.xgauehtwksmnoqhgqegm']) {
      expect(() => config(url.replace('hub_app_server:', `${role}:`))).toThrow('exact Hub application role');
    }
    for (const replacement of ['evil.test', `${host}.evil.test`, 'db.anotherproject.supabase.co']) {
      expect(() => config(url.replace(host, replacement))).toThrow('exact Hub application role');
    }
    expect(() => config(url.replace('/postgres', '/other'))).toThrow('postgres database');
  });
  it('blocks every URL option that could override TLS or the dedicated connection identity', () => {
    for (const query of ['sslmode=disable', 'sslmode=no-verify', 'sslmode=require', 'sslrootcert=/tmp/other.pem', 'sslcert=/tmp/cert', 'sslkey=/tmp/key', 'ssl=0', 'uselibpqcompat=true', 'user=postgres', 'host=evil.test', 'database=other']) {
      expect(() => config(`${url}?${query}`)).toThrow('must not contain query parameters');
    }
  });
  it('rejects malformed, non-certificate and expired CA input before creating a connection', () => {
    for (const pem of ['', '-----BEGIN PRIVATE KEY-----abc', `${ca}untrusted extra text`, '-----BEGIN CERTIFICATE-----invalid-----END CERTIFICATE-----', ca.repeat(5)]) {
      expect(() => config(url, { HUB_DATABASE_CA_PEM: pem })).toThrow('HUB_DATABASE_CA_PEM');
    }
    expect(() => databaseConfig({ HUB_DATABASE_URL: url, HUB_DATABASE_CA_PEM: ca }, Date.UTC(2032, 0, 1))).toThrow('currently valid');
    expect(() => databaseConfig({ HUB_DATABASE_URL: url, HUB_DATABASE_CA_PEM: ca }, Date.UTC(2020, 0, 1))).toThrow('currently valid');
  });
  it('never echoes malformed URLs or their credential values in configuration errors', () => {
    for (const value of [undefined, 'not-a-url:synthetic-secret', url.replace('synthetic-test-password', '%zz'), url.replace('postgresql:', 'https:')]) {
      let failure;
      try { databaseConfig({ HUB_DATABASE_URL: value }, now); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).not.toContain('synthetic');
      expect(failure.message).not.toContain('%zz');
    }
    expect(config(url.replace('synthetic-test-password', 'encoded%40password%3Avalue')).password).toBe('encoded@password:value');
  });
});

describe('a dropped database connection', () => {
  const lostConnection = () => new Error('Connection terminated unexpectedly: host db.example password=synthetic-secret');
  it('is an uncaught error on an unguarded pool, which stops the process', () => {
    const pool = new pg.Pool(config());
    expect(() => pool.emit('error', lostConnection())).toThrow(/terminated/);
  });
  it('is logged once, without its text, whether the connection was idle or held in a transaction', () => {
    const lines = [];
    const pool = guardPool(new pg.Pool(config()), { warn: line => lines.push(line) });
    // A connection the pool opens gets its own listener: pg-pool removes its idle listener while a connection is checked out.
    const held = new EventEmitter();
    pool.emit('connect', held);
    expect(() => held.emit('error', lostConnection())).not.toThrow();
    // An idle connection's failure reaches the pool too; that one is not counted twice.
    expect(() => pool.emit('error', lostConnection(), held)).not.toThrow();
    expect(lines).toEqual(['A database connection dropped; the next query opens a new one.']);
    expect(lines.join('')).not.toContain('synthetic');
  });
});
