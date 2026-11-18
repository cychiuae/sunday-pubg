/**
 * Game server entry. `npm run dev:server` (tsx watch) or `npm start` (NODE_ENV=production, serves dist/).
 * Environment variables: see server/config.ts and docs/tech/NETCODE.md.
 */
import { createWorld } from '../src/shared/sim/World';
import { WS_PATH } from '../src/shared/constants';
import { startServer } from './app';
import { readConfig } from './config';
import { describeOriginPolicy } from './origin';

async function main(): Promise<void> {
  const config = readConfig();
  const server = await startServer({
    createWorld,
    balance: config.balance,
    port: config.port,
    host: config.host,
    serveStatic: config.production,
    distDir: config.distDir,
    lag: config.lag,
    seed: config.seed,
    maxRooms: config.maxRooms,
    maxConnections: config.maxConnections,
    mapPin: config.mapPin,
    maxConnsPerIp: config.maxConnsPerIp,
    originPolicy: config.originPolicy,
    trustProxy: config.trustProxy,
  });

  const notes = [
    config.production ? `serving ${config.distDir}` : 'dev (no static files)',
    config.balanceOverridden ? 'BALANCE_OVERRIDE active' : null,
    config.lag.latencyMs || config.lag.jitterMs
      ? `simulated lag ${config.lag.latencyMs} ms RTT + ${config.lag.jitterMs} ms jitter`
      : null,
    config.seed !== null ? `SEED ${config.seed} (deterministic room seeds)` : 'random room seeds',
    `max ${config.maxRooms} rooms / ${config.maxConnections} connections`,
    config.mapPin ? `MAP pinned to ${config.mapPin}` : null,
    `ws origins: ${describeOriginPolicy(config.originPolicy)}`,
  ].filter(Boolean);
  if (config.production && config.originPolicy.any) {
    console.warn('[server] ALLOWED_ORIGINS=* in production: any web page can open game sockets from its visitors');
  }
  console.info(`[server] listening on :${server.port} (ws ${WS_PATH}); ${notes.join('; ')}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[server] ${signal}: shutting down`);
    const force = setTimeout(() => process.exit(1), 3000);
    force.unref();
    server.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('[server] shutdown error', err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => console.error('[server] uncaught exception', err));
  process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection', err));
}

main().catch((err: unknown) => {
  console.error('[server] failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
