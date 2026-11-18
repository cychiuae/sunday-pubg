# Last One Dry

A multiplayer browser battle royale: chibi, cel-shaded castaways wash up on a tropical island, grab loot, and fight
while the tide closes in. The last castaway standing on dry sand wins.

("Beach Survival PvP" is the working title. It stays in the repo and folder names only.)

Stack: TypeScript, Vite, Three.js, Node WebSocket server (`ws`, run with `tsx`), Vitest, Playwright.

## Requirements

- Node.js 20.19+ (developed and tested in CI on Node 24) and npm 10+.

## Quick start

```sh
npm install
npm run dev
```

Open http://localhost:5173. `npm run dev` starts the Vite client and the game server together; Vite proxies `/ws`
to the server.

| Port | What |
|---|---|
| 5173 | Vite dev client (`npm run dev`, `npm run dev:client`) |
| 8797 | Game server, HTTP + WebSocket on `/ws` (`npm run dev:server`, `npm start`). Override with `PORT` |
| 4173 | `npm run preview` (built client only, no game server) |

If you run the server on another port, start Vite with the same `PORT` so its proxy follows:
`PORT=8790 npm run dev`.

## Controls

| Key | Action |
|---|---|
| WASD | Move |
| Shift | Sprint |
| Space | Jump (next castaway, while spectating) |
| Mouse | Aim (click the game to lock the pointer) |
| Left mouse button | Fire |
| R | Reload |
| E | Pick up |
| 1 / 2 / 3 | Switch weapon |
| Q | Heal |
| Esc | Release the mouse |

The in-game Controls panel (lobby and settings) is the source of truth; its text lives in
`src/content/strings/en.json`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Client (Vite, :5173) + server (`tsx watch`, :8797) together |
| `npm run dev:client` | Vite dev server only |
| `npm run dev:server` | Game server only, restarts on change |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `server/`, `tests/` and root configs |
| `npm run build` | Typecheck, then build the client to `dist/` |
| `npm run size` | Bundle budget check on `dist/` (initial JS < 1.5 MB gzip, initial download < 15 MB). Run after `build` |
| `npm run preview` | Serve the built client only (no game server) |
| `npm start` | Production: one server process on `PORT` (default 8797) serving `dist/` and `/ws` |
| `npm test` | Unit tests (Vitest) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run e2e` | Playwright E2E tests in `tests/e2e/`. Alias: `test:e2e` |
| `npm run e2e:local` | Same, but uses Chromium libraries from `npm run setup:chromium-libs` if present |
| `npm run setup:chromium-libs` | No-sudo download of missing Chromium system libraries into `.cache/chromium-libs/` |

## Environment variables

The server is configured only through environment variables. The full table is in
[docs/tech/NETCODE.md, "Environment (server)"](docs/tech/NETCODE.md#environment-server). The common ones:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 8797 | HTTP + WS port (`0` = random). Vite's dev proxy reads it too |
| `HOST` | all interfaces | Bind address |
| `NODE_ENV=production` | | Serve `dist/` (set by `npm start`) |
| `BALANCE_OVERRIDE` | | Inline JSON or a file path, deep-merged over `docs/design/balance.json`, e.g. `'{"match":{"countdownSeconds":3}}'` |
| `LATENCY_MS` / `JITTER_MS` | 0 | Simulated network lag |
| `SEED` | random | World seed |
| `ALLOWED_ORIGINS` | production: `self`; dev: `*` | WebSocket Origin policy: comma list of `*`, `self` and exact origins. Set it only when the client is served from another origin, e.g. `self,https://play.example.com` |
| `TRUST_PROXY` | | `1` behind a reverse proxy: per-IP limit uses `X-Forwarded-For`, and `self` accepts `X-Forwarded-Host` |

Never commit `.env*` files; they are gitignored.

## Production

```sh
npm ci
npm run build
PORT=8797 npm start
```

Then open http://localhost:8797. `npm start` execs a single Node process (`node --import tsx server/index.ts`), so
SIGTERM/SIGINT, whether sent to npm or to the server, closes sockets (code 1001) and exits within 3 s. The client and `/ws` share one
origin, so the default `ALLOWED_ORIGINS=self` needs no configuration.

Behind a reverse proxy:
- Pass WebSocket upgrades on `/ws` and allow idle sockets of at least 30 s.
- Forward the original `Host` header (nginx: `proxy_set_header Host $host;`), or set `TRUST_PROXY=1` and send
  `X-Forwarded-Host`. Otherwise the `self` Origin check rejects every browser with HTTP 403.

See `docs/tech/BUILD.md` and NETCODE.md "Origin policy".

## E2E tests

Each spec starts its own game server and Vite on random free ports (`tests/e2e/support/stack.ts`), so E2E never
touches a running `npm run dev` on 5173/8797. Chromium runs with SwiftShader (software WebGL), so no GPU is needed.

One-time setup:

```sh
npx playwright install chromium
```

Run:

```sh
npm run e2e                               # all specs
npm run e2e -- tests/e2e/boot.spec.ts     # one spec
npx playwright show-report                # HTML report after a run
```

### Linux: Chromium fails to start with missing shared libraries

Errors such as `libatk-1.0.so.0: cannot open shared object file` mean the system libraries are missing.

With sudo (simplest):

```sh
sudo npx playwright install-deps chromium
npm run e2e
```

Without sudo (Debian/Ubuntu): download the packages and unpack them into a local directory.

```sh
npm run setup:chromium-libs   # apt-get download + dpkg-deb -x into .cache/chromium-libs/ (gitignored)
npm run e2e:local             # prepends that directory to LD_LIBRARY_PATH, then runs playwright test
```

The script fetches `libatk1.0-0t64`, `libatk-bridge2.0-0t64`, `libxcomposite1`, `libxdamage1`, `libxrandr2` and
`libatspi2.0-0t64` (it falls back to the non-`t64` names on older releases). To do it by hand:

```sh
mkdir -p .cache/chromium-libs/debs && cd .cache/chromium-libs/debs
apt-get download libatk1.0-0t64 libatk-bridge2.0-0t64 libxcomposite1 libxdamage1 libxrandr2 libatspi2.0-0t64
for f in *.deb; do dpkg-deb -x "$f" ../root; done
cd -
export LD_LIBRARY_PATH="$PWD/.cache/chromium-libs/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
npx playwright test
```

If Chromium still reports a missing library, pass its package name as an extra argument:
`bash scripts/setup-chromium-libs.sh libfoo1`.

### Shared stack (opt-in)

For ad-hoc specs that use the config `baseURL` instead of their own stack, `E2E_WEB_SERVER=1` makes Playwright start
one game server + Vite on ports 8897/5273 (override with `E2E_SERVER_PORT`/`E2E_CLIENT_PORT`). The whole environment
is passed through, so server variables work:

```sh
E2E_WEB_SERVER=1 BALANCE_OVERRIDE='{"match":{"countdownSeconds":3}}' npm run e2e
```

## CI

`.github/workflows/ci.yml` runs on pushes and pull requests: `npm ci`, typecheck, unit tests, client build, bundle
budget, and Playwright E2E (Chromium, `npx playwright install --with-deps chromium`). On failure it uploads the HTML
report and `test-results/` (traces, screenshots, server and Vite logs) as artifacts.

## Layout

See `CLAUDE.md` for team ownership and `docs/tech/ARCHITECTURE.md` for the architecture.
Toolchain notes are in `docs/tech/BUILD.md`.
