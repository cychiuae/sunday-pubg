/**
 * Server configuration from environment variables. See docs/tech/NETCODE.md "Environment".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAP_IDS } from '../src/game/levels';
import { BALANCE, validateBalance, type Balance, type RoomsBalance } from '../src/shared/balance';
import type { LagConfig } from './lag';
import { parseOriginPolicy, type OriginPolicy } from './origin';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Recursive merge: objects merge key by key, everything else (arrays included) replaces. Inputs are not mutated. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = deepMerge(base[k], v);
  }
  return out;
}

/**
 * BALANCE_OVERRIDE: inline JSON (starts with `{`) or a path to a JSON file (relative to cwd). Merged over
 * docs/design/balance.json and validated. Throws with a clear message on bad input (fail fast at startup).
 */
export function loadBalance(override: string | undefined, base: Balance = BALANCE): Balance {
  const spec = override?.trim();
  if (!spec) return base;
  let parsed: unknown;
  try {
    const text = spec.startsWith('{') ? spec : readFileSync(resolve(process.cwd(), spec), 'utf8');
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`BALANCE_OVERRIDE could not be read/parsed: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new Error('BALANCE_OVERRIDE must be a JSON object');
  return validateBalance(deepMerge(base, parsed));
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} must be a number in [${min}, ${max}], got "${raw}"`);
  return n;
}

/** Every level id, in display and rotation order (island01 first). */
export function levelIds(): string[] {
  return [...MAP_IDS];
}

/** The `rooms` balance block (ADR 0006). Required by the room server; balance.json carries it. */
export function roomsBalance(b: Balance): RoomsBalance {
  if (!b.rooms) throw new Error('balance: the "rooms" block is required by the room server (systems/rooms.md)');
  return b.rooms;
}

/** `match.mapVoteLockSeconds` (maps.md 1.3). Required by the room server; balance.json carries it. */
export function mapVoteLockSeconds(b: Balance): number {
  const v = b.match.mapVoteLockSeconds;
  if (v === undefined) throw new Error('balance: match.mapVoteLockSeconds is required by the room server (maps.md 1.3)');
  return v;
}

/**
 * MAP env (maps.md 1.4.1): a valid level id pins every room's map. An invalid value logs one warning and is ignored.
 */
export function parseMapPin(raw: string | undefined, ids: readonly string[], warn: (msg: string) => void): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (ids.includes(v)) return v;
  warn(`[server] MAP="${v.slice(0, 40)}" is not a map id (${ids.join(', ')}); ignored, rooms choose their maps`);
  return null;
}

export interface ServerConfig {
  port: number;
  host: string | undefined;
  production: boolean;
  /** Directory served in production. */
  distDir: string;
  balance: Balance;
  balanceOverridden: boolean;
  lag: LagConfig;
  /** SEED env; null = random room seeds. */
  seed: number | null;
  /** MAX_ROOMS (default 8). */
  maxRooms: number;
  /** MAX_CONNECTIONS (default MAX_ROOMS x match.maxPlayers + 32). */
  maxConnections: number;
  /** MAP env pin (validated), else null. */
  mapPin: string | null;
  /** Max sockets per remote address (0 = unlimited). */
  maxConnsPerIp: number;
  /** WebSocket upgrade Origin policy from ALLOWED_ORIGINS (server/origin.ts). Empty: `self` in production, `*` in dev. */
  originPolicy: OriginPolicy;
  /** Trust X-Forwarded-For for the per-IP limit (behind a reverse proxy). */
  trustProxy: boolean;
}

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (m) => console.warn(m),
): ServerConfig {
  const seedRaw = env.SEED;
  const production = env.NODE_ENV === 'production';
  const balance = loadBalance(env.BALANCE_OVERRIDE);
  const maxRooms = num(env, 'MAX_ROOMS', 8, 1, 1000);
  return {
    port: num(env, 'PORT', 8797, 0, 65535),
    host: env.HOST?.trim() || undefined,
    production,
    distDir: resolve(process.cwd(), env.DIST_DIR?.trim() || 'dist'),
    balance,
    balanceOverridden: Boolean(env.BALANCE_OVERRIDE?.trim()),
    lag: { latencyMs: num(env, 'LATENCY_MS', 0, 0, 10_000), jitterMs: num(env, 'JITTER_MS', 0, 0, 10_000) },
    seed: seedRaw?.trim() ? num(env, 'SEED', 0, 0, 0xffffffff) : null,
    maxRooms,
    maxConnections: num(env, 'MAX_CONNECTIONS', maxRooms * balance.match.maxPlayers + 32, 1, 1_000_000),
    mapPin: parseMapPin(env.MAP, levelIds(), warn),
    maxConnsPerIp: num(env, 'MAX_CONNS_PER_IP', 128, 0, 100_000),
    originPolicy: parseOriginPolicy(env.ALLOWED_ORIGINS, production),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  };
}
