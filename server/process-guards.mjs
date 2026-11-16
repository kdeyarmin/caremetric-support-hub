/**
 * Last-resort logging for errors nothing else caught, installed once the Hub has started (server/main.mjs).
 *
 * - A rejected promise nobody handled is logged as one line and the Hub keeps running. Under Node's default it would stop the process:
 *   every request in flight, every sweep and the AI team's tasks, for what is almost always one forgotten `.catch` on background work.
 * - An uncaught exception is logged as one line and stays fatal: only the monitor listens, so Node still prints it and exits, and
 *   Railway restarts the service. State after an exception thrown from an event handler cannot be trusted.
 *
 * Each line names the error's type, its code and where it was thrown, never its message, which can carry a person's details or a
 * connection string. Railway's log search finds them by `event`.
 */
const frames = error => String(error?.stack ?? '').split('\n').slice(1).map(line => line.trim()).filter(line => line.startsWith('at ')).slice(0, 3);
const described = error => ({
  name: error instanceof Error ? error.name : typeof error,
  ...(typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(error.code) ? { code: error.code } : {}),
  at: frames(error),
});

export function guardProcess({ target = process, log = console } = {}) {
  target.on('unhandledRejection', reason => log.error(JSON.stringify({ event: 'hub_unhandled_rejection', ...described(reason) })));
  target.on('uncaughtExceptionMonitor', error => log.error(JSON.stringify({ event: 'hub_uncaught_exception', ...described(error) })));
}
