# Build and toolchain notes

Owner: build-engineer.

## Layout
- A single npm package (`"type": "module"`), no workspaces. Dependencies are pinned to exact versions (`.npmrc`
  sets `save-exact=true`) and `package-lock.json` is committed.
- One `tsconfig.json` covers the client (DOM libs, `vite/client` types) and the server (`node` types). It uses
  `moduleResolution: "Bundler"`, so imports are extensionless relative paths, for example
  `import { heightAt } from '../shared/sim/terrain'`. There are no path aliases.
- JSON imports work everywhere (`resolveJsonModule`), for example
  `import balance from '../../docs/design/balance.json'`. Vite's `server.fs.allow` is set to the repo root.

## How code runs
| Context | Runner |
|---|---|
| Client dev | Vite 8 (`vite.config.ts`), port 5173, proxies `/ws` (WebSocket) to `localhost:${PORT ?? 8797}` |
| Server dev | `tsx watch server/index.ts` (esbuild transpile, no typecheck) |
| Server prod (`npm start`) | `NODE_ENV=production exec node --import tsx server/index.ts`: one Node process, no tsx CLI wrapper (ADR 0002 §5). `exec` replaces npm's `sh -c`, so SIGTERM/SIGINT reach `server/index.ts` whether sent to npm or to node |
| Unit tests | Vitest, `environment: node`, files `{tests,src,server}/**/*.test.ts`, excluding `tests/e2e/` |
| E2E | Playwright (`playwright.config.ts`), `tests/e2e/*.spec.ts`, Chromium only, SwiftShader WebGL. No shared webServer: each spec starts its own server + Vite on random ports (`tests/e2e/support/stack.ts`). Opt-in shared stack with `E2E_WEB_SERVER=1` (ports 8897/5273, env passed through) |
| Bundle budget | `npm run size` (`scripts/check-bundle-size.mjs`) on `dist/`: initial JS < 1.5 MB gzip, initial download < 15 MB gzip. "Initial" = files reachable from `index.html` by static references; lazy `import()` chunks are excluded |
| Typecheck | `tsc --noEmit -p .` (TypeScript 7). Vite, tsx and Vitest do not typecheck, so run `npm run typecheck` |

## Production
`npm run build` writes the client to `dist/`. `npm start` runs `server/index.ts` with `NODE_ENV=production`; the server
serves `dist/` statically and accepts WebSocket connections on `/ws` on the same `PORT` (default 8797).
Config comes from environment variables only (docs/tech/NETCODE.md "Environment"). Never commit `.env*` files (they are
gitignored). `ALLOWED_ORIGINS` defaults to `self` in production (NETCODE.md "Origin policy"): the WebSocket Origin must
match the request `Host`. Set an explicit list only when the client is served from another origin.

Reverse proxy deploy note: forward the original `Host` header (nginx `proxy_set_header Host $host;`), or set
`TRUST_PROXY=1` and send `X-Forwarded-Host`; otherwise every browser upgrade on `/ws` fails the `self` check (HTTP 403).
The proxy must also pass WebSocket upgrades (`Upgrade`/`Connection` headers) and allow idle sockets of at least 30 s.

Verified 2026-11-18: build, `PORT=8811 npm start`, `/healthz` and `/` return 200, SIGTERM to the node process or to
npm logs `[server] SIGTERM: shutting down` and exits 0, port released.

## CI
`.github/workflows/ci.yml`, two parallel jobs on ubuntu-24.04 with Node 24:
- `check`: `npm ci`, `npm run typecheck`, `npx vitest run`, `npx vite build`, `npm run size`.
- `e2e`: `npm ci`, `npx playwright install --with-deps chromium` (browser cache keyed on the lockfile),
  `npx playwright test`. On failure it uploads `playwright-report/` and `test-results/` (traces, screenshots,
  per-spec server/Vite logs from `test-results/stack-logs/`).

## Local E2E without sudo
Playwright's Chromium needs libatk, libatk-bridge, libXcomposite, libXdamage, libXrandr and libatspi. Without sudo,
`npm run setup:chromium-libs` (`scripts/setup-chromium-libs.sh`) runs `apt-get download` + `dpkg-deb -x` into
`.cache/chromium-libs/` (gitignored) and records the lib dir in `.cache/chromium-libs/LD_LIBRARY_PATH`.
`npm run e2e:local` (`scripts/e2e-local.sh`) prepends it to `LD_LIBRARY_PATH` when present, then runs
`playwright test` with any extra arguments.

## Install scripts
npm 11 blocks dependency install scripts until approved. `esbuild`'s postinstall is not approved and is not needed:
the platform binary comes from esbuild's optional dependency.

## Planned (not yet done)
- ESLint/Prettier (REVIEW-M1 M2, deferred by the user): `no-restricted-imports` per ARCHITECTURE §3, the sim
  determinism globals rule with the `sim/tools/` exemption (REVIEW-M1 m6), and a `lint` step in `build` and CI.
- `server/Dockerfile`, and the asset pipeline (`scripts/assets/`). M1 uses procedural assets only.
- A bundled server build (ADR 0002 §5, M2).
