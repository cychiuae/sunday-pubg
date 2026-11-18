/**
 * Player-facing strings. All display text goes through `t()`. Never hard-code UI copy.
 *
 * Keys are flat and dotted (`hud.alive`). Placeholders look like `{count}`.
 * Random variants are numbered from 0 with no gaps (`feed.kill.0`, `feed.kill.1`, ...).
 * Use `keysWithPrefix()` / `tCount()` / `tRandom()` to pick one.
 *
 * Pure module: no DOM, no Three.js. Safe to import from server, sim-adjacent code and UI.
 */
import en from './en.json';

export type StringVars = Record<string, string | number>;

const table: Readonly<Record<string, string>> = en as Record<string, string>;

const PLACEHOLDER = /\{(\w+)\}/g;

/** Replaces `{var}` tokens. Tokens with no matching var are left as-is so gaps are visible. */
export function format(template: string, vars?: StringVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** Looks up a string by key and interpolates `vars`. Returns the key itself if missing. */
export function t(key: string, vars?: StringVars): string {
  const template = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  return format(template ?? key, vars);
}

/** True if the key exists in the string table. */
export function hasKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

const prefixCache = new Map<string, string[]>();

/**
 * Returns the numbered variant keys under `prefix`, in numeric order.
 * `keysWithPrefix('feed.kill')` → ['feed.kill.0', 'feed.kill.1', ...]. A trailing dot is optional.
 * Only direct numeric children are returned (so `bot.name.3` but never `bot.name.3.x`).
 */
export function keysWithPrefix(prefix: string): string[] {
  const base = prefix.endsWith('.') ? prefix : `${prefix}.`;
  const cached = prefixCache.get(base);
  if (cached) return cached;
  const keys: { key: string; n: number }[] = [];
  for (const key of Object.keys(table)) {
    if (!key.startsWith(base)) continue;
    const rest = key.slice(base.length);
    if (/^\d+$/.test(rest)) keys.push({ key, n: Number(rest) });
  }
  const result = keys.sort((a, b) => a.n - b.n).map((k) => k.key);
  prefixCache.set(base, result);
  return result;
}

/** Number of numbered variants under `prefix` (e.g. `tCount('bot.name')` → 24). */
export function tCount(prefix: string): number {
  return keysWithPrefix(prefix).length;
}

/**
 * Picks a variant under `prefix` and interpolates it. `rng` returns [0, 1). Pass a seeded
 * RNG for determinism. Falls back to the prefix itself if there are no variants.
 */
export function tRandom(prefix: string, vars?: StringVars, rng: () => number = Math.random): string {
  const keys = keysWithPrefix(prefix);
  if (keys.length === 0) return format(prefix, vars);
  const i = Math.min(keys.length - 1, Math.floor(rng() * keys.length));
  return t(keys[i]!, vars);
}

/** Picks variant `index` (wraps). Useful for deterministic choices like bot names by slot. */
export function tIndex(prefix: string, index: number, vars?: StringVars): string {
  const keys = keysWithPrefix(prefix);
  if (keys.length === 0) return format(prefix, vars);
  const i = ((Math.floor(index) % keys.length) + keys.length) % keys.length;
  return t(keys[i]!, vars);
}
