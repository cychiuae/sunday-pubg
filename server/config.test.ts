import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BALANCE } from '../src/shared/balance';
import { checkLevels } from './app';
import { deepMerge, describeLayoutPin, levelIds, loadBalance, parseLayoutSeedEnv, parseMapPin, readConfig } from './config';
import { createStaticHandler, safeJoin } from './static';

describe('BALANCE_OVERRIDE', () => {
  it('merges inline JSON over balance.json without mutating it', () => {
    const b = loadBalance('{"match":{"countdownSeconds":1}}');
    expect(b.match.countdownSeconds).toBe(1);
    expect(b.match.maxPlayers).toBe(BALANCE.match.maxPlayers);
    expect(BALANCE.match.countdownSeconds).not.toBe(1);
  });

  it('loads a file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsp-'));
    const file = join(dir, 'fast.json');
    writeFileSync(file, JSON.stringify({ zone: { phases: [{ waitSeconds: 1, shrinkSeconds: 1, radiusFraction: 0.5, dps: 5 }] } }));
    const b = loadBalance(file);
    expect(b.zone.phases).toHaveLength(1); // arrays replace
  });

  it('fails fast on bad JSON or a broken balance', () => {
    expect(() => loadBalance('{nope')).toThrow(/BALANCE_OVERRIDE/);
    expect(() => loadBalance('{"match":{"countdownSeconds":"soon"}}')).toThrow(/match.countdownSeconds/);
  });

  it('ignores prototype keys', () => {
    const out = deepMerge({ a: 1 }, JSON.parse('{"__proto__":{"x":1},"b":2}')) as Record<string, unknown>;
    expect(out).toEqual({ a: 1, b: 2 });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('reads env with defaults and validation', () => {
    const c = readConfig({ LATENCY_MS: '120', SEED: '7' });
    expect(c.port).toBe(8797);
    expect(c.lag).toEqual({ latencyMs: 120, jitterMs: 0 });
    expect(c.seed).toBe(7);
    expect(c.production).toBe(false);
    expect(() => readConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });
});

describe('M2b room env (ADR 0006 §8)', () => {
  it('MAX_ROOMS (8), MAX_CONNECTIONS (MAX_ROOMS x maxPlayers + 32), SEED absent = random room seeds', () => {
    const c = readConfig({});
    expect(c.maxRooms).toBe(8);
    expect(c.maxConnections).toBe(8 * BALANCE.match.maxPlayers + 32);
    expect(c.seed).toBeNull();
    expect(c.mapPin).toBeNull();
    const d = readConfig({ MAX_ROOMS: '3', MAX_CONNECTIONS: '50' });
    expect([d.maxRooms, d.maxConnections]).toEqual([3, 50]);
    expect(readConfig({ MAX_ROOMS: '2' }).maxConnections).toBe(2 * BALANCE.match.maxPlayers + 32);
    expect(() => readConfig({ MAX_ROOMS: '0' })).toThrow(/MAX_ROOMS/);
  });

  it('MAP: a level id pins; an invalid value warns once and is ignored', () => {
    const warnings: string[] = [];
    expect(readConfig({ MAP: 'island01' }, (m) => warnings.push(m)).mapPin).toBe('island01');
    expect(warnings).toHaveLength(0);
    expect(readConfig({ MAP: 'bogus' }, (m) => warnings.push(m)).mapPin).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bogus');
    expect(parseMapPin('  ', ['a'], () => warnings.push('x'))).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('startup level checks pass for the shipped levels and the balance', () => {
    expect(levelIds()[0]).toBe('island01');
    expect(() => checkLevels(BALANCE)).not.toThrow();
  });
});

describe('M2c LAYOUT_SEED (ADR 0007 §1.3)', () => {
  it('decimal, 0x hex and baseline; absent = per match; invalid = one warning and ignored', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(parseLayoutSeedEnv(undefined, warn)).toBeNull();
    expect(parseLayoutSeedEnv('  ', warn)).toBeNull();
    expect(parseLayoutSeedEnv('12345', warn)).toBe(12345);
    expect(parseLayoutSeedEnv('0xDEADBEEF', warn)).toBe(0xdeadbeef);
    expect(parseLayoutSeedEnv('baseline', warn)).toBe(0);
    expect(parseLayoutSeedEnv('0', warn)).toBe(0);
    expect(warnings).toEqual([]);
    expect(parseLayoutSeedEnv('4294967296', warn)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/LAYOUT_SEED/);
    const cfgWarnings: string[] = [];
    expect(readConfig({ LAYOUT_SEED: 'tuesday' }, (m) => cfgWarnings.push(m)).layoutSeed).toBeNull();
    expect(cfgWarnings).toHaveLength(1);
    expect(readConfig({ LAYOUT_SEED: '0x10' }).layoutSeed).toBe(16);
    expect(readConfig({}).layoutSeed).toBeNull();
    expect([describeLayoutPin(null), describeLayoutPin(0), describeLayoutPin(16)]).toEqual([
      'per match', 'baseline (0x00000000)', 'pinned 0x00000010',
    ]);
  });
});

describe('static server', () => {
  const root = mkdtempSync(join(tmpdir(), 'bsp-dist-'));
  let base = '';
  const server = createServer((req, res) => void createStaticHandler(root)(req, res));

  beforeAll(async () => {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
    writeFileSync(join(root, 'assets', 'main-abc123.js'), 'console.log(1)');
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('serves files with MIME types and cache headers', async () => {
    const js = await fetch(`${base}/assets/main-abc123.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toContain('immutable');
    const html = await fetch(`${base}/`);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('cache-control')).toBe('no-cache');
  });

  it('falls back to index.html for routes, 404 for missing assets', async () => {
    expect((await fetch(`${base}/lobby`)).status).toBe(200);
    expect(await (await fetch(`${base}/lobby`)).text()).toContain('<title>');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  });

  it('blocks path traversal', () => {
    expect(safeJoin(root, '/../../etc/passwd')).toBeNull();
    expect(safeJoin(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(safeJoin(root, '/a%00b')).toBeNull();
    expect(safeJoin(root, '/%E0%A4%A')).toBeNull();
    expect(safeJoin(root, '/assets/x.js')).toBe(join(root, 'assets', 'x.js'));
  });
});
