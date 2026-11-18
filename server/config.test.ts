import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BALANCE } from '../src/shared/balance';
import { deepMerge, loadBalance, readConfig } from './config';
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
