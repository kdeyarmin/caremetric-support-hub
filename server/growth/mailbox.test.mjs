import { createServer, connect as netConnect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addressFits, addressGuesses, learnPattern, localPart, mailboxChecker, nameParts } from './mailbox.mjs';

describe('names and address shapes', () => {
  it('reads a person\'s first and last name, whatever is written around them', () => {
    expect(nameParts('Jane Doe')).toEqual({ first: 'jane', last: 'doe' });
    expect(nameParts('Dr. Jane A. Doe, RN, BSN')).toEqual({ first: 'jane', last: 'doe' });
    expect(nameParts('Jane Doe, RN, COS-C')).toEqual({ first: 'jane', last: 'doe' });
    expect(nameParts('DOE, JANE')).toEqual({ first: 'jane', last: 'doe' });
    expect(nameParts('Robert "Bob" Smith Jr.')).toEqual({ first: 'robert', last: 'smith' });
    expect(nameParts('María de la Cruz')).toEqual({ first: 'maria', last: 'delacruz' });
    expect(nameParts("Shannon O'Brien-Hale")).toEqual({ first: 'shannon', last: 'obrienhale' });
    for (const notAPerson of ['Jane', 'Valley Hospice LLC 2', 'jane@example.org', '', null, 'A B']) expect(nameParts(notAPerson)).toBeNull();
  });

  it('builds the usual shapes, a learned one first, never a role address', () => {
    expect(localPart({ first: 'jane', last: 'doe' }, 'flast')).toBe('jdoe');
    expect(addressGuesses('Jane Doe', 'valleyhospice.org')).toEqual(['jane.doe@valleyhospice.org', 'jdoe@valleyhospice.org', 'jane@valleyhospice.org',
      'janedoe@valleyhospice.org', 'j.doe@valleyhospice.org', 'jane_doe@valleyhospice.org']);
    expect(addressGuesses('Jane Doe', 'valleyhospice.org', { learned: 'firstl' })[0]).toBe('janed@valleyhospice.org');
    expect(addressGuesses('Sam Admin', 'x.org').some(address => address.startsWith('admin@'))).toBe(false);
    expect(addressGuesses('Jane Doe', 'not a domain')).toEqual([]);
  });

  it('learns the shape from the business\'s own addresses of people it knows, and ties an address to a person only by a full shape', () => {
    const people = [{ name: 'John Smith' }, { name: 'Jane Doe' }];
    expect(learnPattern(['info@x.org', 'jsmith@x.org'], people)).toBe('flast');
    expect(learnPattern(['jane.doe@x.org', 'john.smith@x.org', 'jsmith@x.org'], people)).toBe('first.last');
    expect(learnPattern(['info@x.org', 'billing@x.org'], people)).toBeNull();
    expect(addressFits('jdoe@x.org', 'Jane Doe', 'x.org')).toBe(true);
    expect(addressFits('jdoe@other.org', 'Jane Doe', 'x.org')).toBe(false);
    expect(addressFits('jane@x.org', 'Jane Doe', 'x.org')).toBe(false);
  });
});

// A mail server on the loopback interface. `rcpt` answers each RCPT TO by its address; every command is recorded.
const servers = [];
async function mailServer({ rcpt = () => '550 5.1.1 No such user', greeting = '220 mx.valleyhospice.org ESMTP', mailFrom = '250 OK', ehlo = '250-mx.valleyhospice.org\r\n250 SIZE 1000', starttls = '220 2.0.0 Ready to start TLS' } = {}) {
  const commands = [];
  const server = createServer(socket => {
    socket.setEncoding('latin1');
    socket.write(`${greeting}\r\n`);
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line);
        const [verb] = line.split(/[ :]/);
        const answer = verb === 'EHLO' ? ehlo : verb === 'MAIL' ? mailFrom : verb === 'RCPT' ? rcpt(/<([^>]*)>/.exec(line)[1]) : verb === 'QUIT' ? '221 Bye' : verb === 'STARTTLS' ? starttls : '250 OK';
        socket.write(`${answer}\r\n`);
        if (verb === 'QUIT') socket.end();
      }
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { commands, port: server.address().port };
}
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });

const publicMx = vi.fn(async () => [{ exchange: 'mx2.valleyhospice.org', priority: 20 }, { exchange: 'mx1.valleyhospice.org', priority: 10 }]);
const publicLookup = vi.fn(async () => [{ address: '203.0.113.25', family: 4 }]);
const checker = (port, options = {}) => mailboxChecker({ heloName: 'hub.caremetric.ai', resolveMx: publicMx, lookup: publicLookup,
  connect: () => netConnect({ host: '127.0.0.1', port }), made: () => 'cmmadeup', timeoutMs: 2000, ...options });
const guesses = ['jane.doe@valleyhospice.org', 'jdoe@valleyhospice.org', 'jane@valleyhospice.org'];

describe('asking the business\'s mail server', () => {
  // Review 2026-11-17: 25 of 44 checks came back unanswered and the reason was not kept; servers that want TLS refuse a plain sender.
  it('asks over TLS when the server offers it, and says why when a server wants TLS it did not offer', async () => {
    const tls = await mailServer({ ehlo: '250-mx.valleyhospice.org\r\n250-SIZE 1000\r\n250 STARTTLS', rcpt: address => (address === 'jdoe@valleyhospice.org' ? '250 2.1.5 OK' : '550 5.1.1 User unknown') });
    const upgraded = vi.fn(async socket => socket);
    expect(await checker(tls.port, { startTls: upgraded }).check('valleyhospice.org', guesses)).toEqual({ result: 'verified', email: 'jdoe@valleyhospice.org' });
    expect(upgraded).toHaveBeenCalledWith(expect.anything(), 'mx1.valleyhospice.org');
    expect(tls.commands.slice(0, 4)).toEqual(['EHLO hub.caremetric.ai', 'STARTTLS', 'EHLO hub.caremetric.ai', 'MAIL FROM:<>']);
    // A handshake that fails is not followed by questions in the clear.
    const broken = await mailServer({ ehlo: '250-mx.valleyhospice.org\r\n250 STARTTLS' });
    expect(await checker(broken.port, { startTls: async () => { throw new Error('handshake'); } }).check('valleyhospice.org', guesses)).toEqual({ result: 'unknown', reason: 'tls_failed' });
    expect(broken.commands.some(command => command.startsWith('MAIL'))).toBe(false);
    const wants = await mailServer({ mailFrom: '530 5.7.0 Must issue a STARTTLS command first' });
    expect(await checker(wants.port).check('valleyhospice.org', guesses)).toEqual({ result: 'unknown', reason: 'tls_required' });
  });

  it('confirms the address its server accepts after refusing a made-up one, and never sends a message', async () => {
    const server = await mailServer({ rcpt: address => (address === 'jdoe@valleyhospice.org' ? '250 2.1.5 OK' : '550 5.1.1 User unknown') });
    expect(await checker(server.port).check('valleyhospice.org', guesses)).toEqual({ result: 'verified', email: 'jdoe@valleyhospice.org' });
    expect(server.commands).toEqual(['EHLO hub.caremetric.ai', 'MAIL FROM:<>', 'RCPT TO:<cmmadeup@valleyhospice.org>', 'RSET',
      'MAIL FROM:<>', 'RCPT TO:<jane.doe@valleyhospice.org>', 'RSET', 'MAIL FROM:<>', 'RCPT TO:<jdoe@valleyhospice.org>', 'RSET', 'QUIT']);
    expect(server.commands.some(command => command.startsWith('DATA'))).toBe(false);
    expect(publicLookup).toHaveBeenCalledWith('mx1.valleyhospice.org', { all: true });
  });

  it('confirms nothing on a catch-all, a block, a temporary answer or when every guess is refused', async () => {
    expect(await checker((await mailServer({ rcpt: () => '250 OK' })).port).check('valleyhospice.org', guesses)).toEqual({ result: 'catch_all' });
    expect(await checker((await mailServer({ rcpt: () => '550 5.7.1 Client host blocked using zen.spamhaus.org' })).port).check('valleyhospice.org', guesses))
      .toEqual({ result: 'unknown', reason: 'blocked' });
    expect(await checker((await mailServer({ rcpt: () => '451 4.7.1 Greylisted, try again later' })).port).check('valleyhospice.org', guesses))
      .toEqual({ result: 'unknown', reason: 'temporary' });
    expect(await checker((await mailServer({ mailFrom: '553 5.7.1 Sender address rejected' })).port).check('valleyhospice.org', guesses))
      .toEqual({ result: 'unknown', reason: 'blocked' });
    expect(await checker((await mailServer({ greeting: '554 5.7.1 Service unavailable; client host blocked' })).port).check('valleyhospice.org', guesses))
      .toEqual({ result: 'unknown', reason: 'blocked' });
    const refusing = await mailServer();
    expect(await checker(refusing.port).check('valleyhospice.org', guesses)).toEqual({ result: 'rejected' });
    expect(refusing.commands.filter(command => command.startsWith('RCPT'))).toHaveLength(4);
  });

  it('asks only about addresses on the business\'s domain, never a private address, and nothing without a name to introduce itself', async () => {
    const connect = vi.fn();
    const base = { heloName: 'hub.caremetric.ai', resolveMx: publicMx, connect };
    expect(await mailboxChecker({ ...base, lookup: async () => [{ address: '10.0.0.5', family: 4 }] }).check('valleyhospice.org', guesses)).toEqual({ result: 'unreachable' });
    expect(await mailboxChecker({ ...base, lookup: publicLookup }).check('valleyhospice.org', ['jane@other.org', 'bad\r\nDATA@valleyhospice.org']))
      .toEqual({ result: 'unknown', reason: 'invalid' });
    expect(await mailboxChecker({ ...base, lookup: publicLookup, resolveMx: async () => { throw Object.assign(new Error('none'), { code: 'ENODATA' }); } })
      .check('valleyhospice.org', guesses)).toEqual({ result: 'unknown', reason: 'no_mail' });
    expect(await mailboxChecker({ ...base, lookup: publicLookup, resolveMx: async () => [{ exchange: '', priority: 0 }] })
      .check('valleyhospice.org', guesses)).toEqual({ result: 'unknown', reason: 'no_mail' });
    const unnamed = mailboxChecker({ resolveMx: publicMx, lookup: publicLookup, connect });
    expect(unnamed.available()).toBe(false);
    expect(await unnamed.check('valleyhospice.org', guesses)).toEqual({ result: 'unknown', reason: 'invalid' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('rests for six hours after three businesses in a row cannot be reached (outbound port 25 blocked)', async () => {
    let clock = 1_000_000;
    const closed = mailboxChecker({ heloName: 'hub.caremetric.ai', resolveMx: publicMx, lookup: publicLookup, now: () => clock, timeoutMs: 500,
      connect: () => netConnect({ host: '127.0.0.1', port: 1 }) });
    expect(closed.state()).toBe('unknown');
    for (let i = 0; i < 3; i += 1) expect(await closed.check('valleyhospice.org', guesses)).toEqual({ result: 'unreachable' });
    expect([closed.available(), closed.state()]).toEqual([false, 'unreachable']);
    clock += 6 * 60 * 60 * 1000;
    expect(closed.available()).toBe(true);
  });
});
