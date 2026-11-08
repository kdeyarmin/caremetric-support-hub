/** Resolve an old hash-router link only when it stays on this application's origin. */
export function legacyRoute(hash: string, origin: string): string | null {
  if (!hash.startsWith("#/")) return null;
  try {
    const target = new URL(hash.slice(1), origin);
    return target.origin === origin ? `${target.pathname}${target.search}${target.hash}` : null;
  } catch { return null; }
}
