/**
 * WebSocket upgrade Origin policy (cross-site WebSocket hijacking guard). See docs/tech/NETCODE.md "Origin policy".
 *
 * Browsers always send `Origin` on a WebSocket upgrade, and page scripts cannot forge it. Without a check, any web
 * page could open sockets to the game server from its visitors' browsers (free bot farm, per-IP cap burned on the
 * visitor's IP). Non-browser clients can send any Origin they like, so this is not authentication; the edge
 * validation and rate limits in Room still apply to everyone.
 *
 * ALLOWED_ORIGINS grammar (comma-separated, whitespace ignored):
 *   (empty)   production: `self`; dev: `*`
 *   `*`       any origin, including a missing header (dev default; not recommended in production)
 *   `self`    Origin host equals the request Host (or X-Forwarded-Host with TRUST_PROXY); the production default,
 *             because the production process serves the client from the same origin as /ws
 *   `https://play.example.com`  an exact origin (scheme + host + port; normalised, default ports dropped)
 */

export interface OriginPolicy {
  /** Accept everything, including a missing Origin header. */
  any: boolean;
  /** Accept an Origin whose host matches the request's Host header. */
  self: boolean;
  /** Exact, normalised origins (`URL.origin` form). */
  origins: string[];
}

export const ANY_ORIGIN: OriginPolicy = { any: true, self: false, origins: [] };
export const SAME_ORIGIN: OriginPolicy = { any: false, self: true, origins: [] };

/** Normalises an origin string to `URL.origin` form, or returns null if it is not an http(s) origin. */
export function normalizeOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  return u.origin;
}

/** Parses ALLOWED_ORIGINS. Throws on an entry that is not `*`, `self` or an http(s) origin (fail fast at startup). */
export function parseOriginPolicy(raw: string | undefined, production: boolean): OriginPolicy {
  const entries = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return production ? SAME_ORIGIN : ANY_ORIGIN;
  const policy: OriginPolicy = { any: false, self: false, origins: [] };
  for (const e of entries) {
    if (e === '*') policy.any = true;
    else if (e.toLowerCase() === 'self') policy.self = true;
    else {
      const o = normalizeOrigin(e);
      if (o === null) throw new Error(`ALLOWED_ORIGINS: "${e}" is not "*", "self" or an http(s) origin like https://host[:port]`);
      if (!policy.origins.includes(o)) policy.origins.push(o);
    }
  }
  return policy;
}

/** Human-readable policy for the startup log. */
export function describeOriginPolicy(p: OriginPolicy): string {
  if (p.any) return 'any origin';
  const parts = [...(p.self ? ['same-origin'] : []), ...p.origins];
  return parts.length > 0 ? parts.join(', ') : 'no origin (all upgrades rejected)';
}

const first = (v: string | string[] | undefined): string | undefined =>
  (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() || undefined;

export interface UpgradeHeaders {
  origin?: string | string[];
  host?: string | string[];
  'x-forwarded-host'?: string | string[];
}

/** Decides whether a WebSocket upgrade with these headers may proceed. */
export function isOriginAllowed(policy: OriginPolicy, headers: UpgradeHeaders, trustProxy: boolean): boolean {
  if (policy.any) return true;
  const rawOrigin = first(headers.origin);
  if (!rawOrigin) return false; // every browser sends Origin on upgrades; tools can send one too
  const origin = normalizeOrigin(rawOrigin); // 'null' (sandboxed iframe, file://) fails here
  if (origin === null) return false;
  if (policy.origins.includes(origin)) return true;
  if (!policy.self) return false;
  const originUrl = new URL(origin);
  const hosts = [first(headers.host), trustProxy ? first(headers['x-forwarded-host']) : undefined];
  for (const h of hosts) {
    if (!h) continue;
    try {
      // Parse the Host with the Origin's scheme so a default port written explicitly (":443") still matches.
      if (new URL(`${originUrl.protocol}//${h}`).host === originUrl.host) return true;
    } catch {
      // malformed Host header
    }
  }
  return false;
}
