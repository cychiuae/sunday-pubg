/**
 * Server configuration from environment variables. See docs/tech/NETCODE.md "Environment".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BALANCE, validateBalance, type Balance } from '../src/shared/balance';
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

export interface ServerConfig {
  port: number;
  host: string | undefined;
  production: boolean;
  /** Directory served in production. */
  distDir: string;
  balance: Balance;
  balanceOverridden: boolean;
  lag: LagConfig;
  seed: number;
  /** Max sockets per remote address (0 = unlimited). */
  maxConnsPerIp: number;
  /** WebSocket upgrade Origin policy from ALLOWED_ORIGINS (server/origin.ts). Empty: `self` in production, `*` in dev. */
  originPolicy: OriginPolicy;
  /** Trust X-Forwarded-For for the per-IP limit (behind a reverse proxy). */
  trustProxy: boolean;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const seedRaw = env.SEED;
  const production = env.NODE_ENV === 'production';
  return {
    port: num(env, 'PORT', 8797, 0, 65535),
    host: env.HOST?.trim() || undefined,
    production,
    distDir: resolve(process.cwd(), env.DIST_DIR?.trim() || 'dist'),
    balance: loadBalance(env.BALANCE_OVERRIDE),
    balanceOverridden: Boolean(env.BALANCE_OVERRIDE?.trim()),
    lag: { latencyMs: num(env, 'LATENCY_MS', 0, 0, 10_000), jitterMs: num(env, 'JITTER_MS', 0, 0, 10_000) },
    seed: seedRaw ? num(env, 'SEED', 0, 0, 0xffffffff) : Math.floor(Math.random() * 0xffffffff),
    maxConnsPerIp: num(env, 'MAX_CONNS_PER_IP', 32, 0, 100_000),
    originPolicy: parseOriginPolicy(env.ALLOWED_ORIGINS, production),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  };
}
