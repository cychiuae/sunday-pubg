/**
 * Isolated test stack for E2E specs (owner: qa-tester).
 *
 * Each spec file gets its own game server (random port, its own BALANCE_OVERRIDE / LATENCY_MS / SEED) and its own
 * Vite dev server whose `/ws` proxy points at that game server (vite.config.ts reads PORT for the proxy target).
 * This keeps specs independent of each other and of a developer's `npm run dev` on 5173/8797.
 *
 * Why not page.routeWebSocket + connectToServer(url)? In Playwright 1.65 the browser still dials the original URL,
 * so the redirect does not work (verified 2026-11-18). Spawning a Vite per stack is the reliable option.
 *
 * Processes are spawned detached (own process group) and stopped by group PID, never by name.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LOG_DIR = join(ROOT, 'test-results', 'stack-logs');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const VITE_CONFIG = join(ROOT, 'tests', 'e2e', 'support', 'vite.e2e.config.ts');

export interface Health {
  ok: boolean;
  connections: number;
  joined: number;
  tick: number;
  phase: 'lobby' | 'countdown' | 'playing' | 'results';
  matchId: number;
  avgTickMs: number;
  maxTickMs: number;
  droppedTicks: number;
  bytesOut: number;
}

export interface StackOptions {
  /** Deep-merged over docs/design/balance.json by the server (BALANCE_OVERRIDE). */
  balance?: Record<string, unknown>;
  latencyMs?: number;
  jitterMs?: number;
  seed?: number;
  /** Name used for log files under test-results/stack-logs. */
  label: string;
}

export interface Stack {
  readonly baseURL: string;
  readonly serverPort: number;
  readonly vitePort: number;
  health(): Promise<Health>;
  /** Kill only the game server (simulates a crash / network loss). */
  killServer(): Promise<void>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

function waitForLine(proc: ChildProcess, re: RegExp, timeoutMs: number, what: string): Promise<RegExpMatchArray> {
  return new Promise((res, rej) => {
    let buf = '';
    const timer = setTimeout(() => rej(new Error(`${what}: no "${re}" within ${timeoutMs} ms. Output:\n${buf}`)), timeoutMs);
    const onData = (d: Buffer): void => {
      buf += d.toString();
      const m = buf.match(re);
      if (m) {
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        res(m);
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', (d: Buffer) => {
      buf += d.toString();
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`${what} exited early with code ${code}. Output:\n${buf}`));
    });
  });
}

async function waitHttp(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      last = r.status;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}: ${String(last)}`);
}

function killGroup(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.pid === undefined) return Promise.resolve();
  const pid = proc.pid;
  return new Promise((res) => {
    const done = (): void => res();
    proc.once('exit', done);
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      res();
      return;
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      res();
    }, 4000).unref();
  });
}

function tee(proc: ChildProcess, file: string): void {
  mkdirSync(LOG_DIR, { recursive: true });
  const out = createWriteStream(join(LOG_DIR, file));
  proc.stdout?.on('data', (d: Buffer) => out.write(d));
  proc.stderr?.on('data', (d: Buffer) => out.write(d));
  proc.once('exit', () => out.end());
}

export async function startStack(opts: StackOptions): Promise<Stack> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    BALANCE_OVERRIDE: opts.balance ? JSON.stringify(opts.balance) : '',
    LATENCY_MS: String(opts.latencyMs ?? 0),
    JITTER_MS: String(opts.jitterMs ?? 0),
    FORCE_COLOR: '0',
  };
  if (opts.seed !== undefined) env.SEED = String(opts.seed);
  else delete env.SEED;

  const server = spawn(process.execPath, [TSX, 'server/index.ts'], { cwd: ROOT, env, detached: true, stdio: 'pipe' });
  tee(server, `${opts.label}-server.log`);
  let vite: ChildProcess | null = null;
  try {
    const m = await waitForLine(server, /listening on :(\d+)/, 30_000, 'game server');
    const serverPort = Number(m[1]);
    const vitePort = await freePort();
    vite = spawn(process.execPath, [VITE, '--config', VITE_CONFIG, '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(serverPort), FORCE_COLOR: '0' },
      detached: true,
      stdio: 'pipe',
    });
    tee(vite, `${opts.label}-vite.log`);
    const baseURL = `http://127.0.0.1:${vitePort}`;
    await waitHttp(`${baseURL}/`, 30_000);
    const v = vite;
    return {
      baseURL,
      serverPort,
      vitePort,
      async health() {
        const r = await fetch(`http://127.0.0.1:${serverPort}/healthz`);
        return (await r.json()) as Health;
      },
      killServer: () => killGroup(server),
      async stop() {
        await Promise.all([killGroup(v), killGroup(server)]);
      },
    };
  } catch (err) {
    await Promise.all([killGroup(vite), killGroup(server)]);
    throw err;
  }
}

/** Poll the server's /healthz until `pred` holds. */
export async function waitForHealth(stack: Stack, pred: (h: Health) => boolean, timeoutMs: number): Promise<Health> {
  const until = Date.now() + timeoutMs;
  let h = await stack.health();
  while (!pred(h)) {
    if (Date.now() > until) throw new Error(`health condition not met in ${timeoutMs} ms; last: ${JSON.stringify(h)}`);
    await new Promise((r) => setTimeout(r, 250));
    h = await stack.health();
  }
  return h;
}

/**
 * Fast-match balance for E2E. Bots never react (huge reactionMs) so the human is not killed by gunfire, and the
 * tide closes in ~25 s so a match always resolves. Client-side BALANCE is still the default file (the client does not
 * receive balance from the server), so client-only numbers (e.g. prediction) stay default.
 */
export const FAST_BALANCE = {
  match: { countdownSeconds: 4, resultsSeconds: 6, targetPlayers: 6, lastHumanDeathDelaySeconds: 1 },
  bots: { reactionMs: 600_000 },
  zone: {
    phases: [
      { waitSeconds: 10, shrinkSeconds: 5, radiusFraction: 0.2, dps: 20 },
      { waitSeconds: 2, shrinkSeconds: 3, radiusFraction: 0.03, dps: 40 },
    ],
    finalCollapseDelaySeconds: 2,
    finalCollapseSeconds: 3,
    finalCollapseDps: 100,
    warningSecondsBeforeShrink: 3,
  },
};

/** Long match (tide never closes in test time), bots passive. For HUD/input/exploratory specs. */
export const CALM_BALANCE = {
  match: { countdownSeconds: 4, resultsSeconds: 6, targetPlayers: 6 },
  bots: { reactionMs: 600_000 },
};
