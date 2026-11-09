/**
 * A value a service reads each time it uses it. The Hub server passes Hub settings (server/hub-settings.mjs) as functions so a change
 * on the Settings page applies without a restart; tests and older callers pass plain values, which are used as they are.
 */
export const live = value => (typeof value === 'function' ? value() : value);

/**
 * An object that is `build(value)` for the current `live(input)`: built again only when that value changes, and read through on every
 * property access, so a service holding it uses the rebuilt one at once (a client built from settings, for example). `input` must be
 * JSON-serializable; it is compared in memory only and never logged.
 */
export function rebuilt(input, build) {
  let last = null;
  const current = () => {
    const value = live(input);
    const key = JSON.stringify(value ?? null);
    if (!last || last.key !== key) last = { key, target: build(value) };
    return last.target;
  };
  return new Proxy(Object.create(null), {
    get: (_, property) => { const target = current(); const found = target?.[property]; return typeof found === 'function' ? found.bind(target) : found; },
    has: (_, property) => property in (current() ?? {}),
  });
}
