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
| 5173 | Vite dev client (`npm run dev`, `npm run dev:client`). Override with `CLIENT_PORT` |
| 5174 / 8798 | `npm run dev:office` client / server |
| 8797 | Game server, HTTP + WebSocket on `/ws` (`npm run dev:server`, `npm start`). Override with `PORT` |
| 4173 | `npm run preview` (built client only, no game server) |

If you run the server on another port, start Vite with the same `PORT` so its proxy follows:
`PORT=8790 npm run dev`.

## How to play

### Rooms

1. Enter a name on the title screen and press Play. You land in the **Room browser**.
2. **Create room**: pick a name, Public or Private, the map (Island, Office or Vote) and the max humans. You are the
   host. Bots fill the empty slots.
3. **Join**: click a public room in the list, or type its 5-character code in **Join by code** (not case-sensitive).
   Private rooms can only be joined by code.
4. **Deep link**: open `http://localhost:5173/?room=CODE`. After name entry, Play joins that room directly. The
   waiting room shows the code with Copy and Link buttons. `?map=island01|office|random` pre-selects your map vote.
5. In the **waiting room** the host presses Start (one human is enough). After the results you return to the same
   room; Leave goes back to the browser. Joining a room mid-match lets you spectate until the next match.

Each match starts aboard a carrier (a seaplane on the island, a delivery drone in the office) on a random route.
Jump when you like; anyone still aboard is ejected near the edge of the map. Your parachute opens on its own.

### Controls

| Key | Action |
|---|---|
| WASD | Move |
| Shift | Sprint |
| Mouse | Look (click the game to lock the pointer) |
| Left mouse button | Fire. With a grenade: hold to cook, release to throw |
| Right mouse button | Aim down sights (hold or toggle, see Settings) |
| C | Crouch (toggle) |
| Z | Lie down (toggle) |
| Space | Jump; stand up from crouch or prone |
| Space / F | Jump from the plane or drone |
| R | Reload |
| E | Pick up |
| 1 / 2 / 3 | Switch weapon |
| 4 / G | Grenade |
| Mouse wheel | Cycle weapons |
| Q | Heal |
| V | Spectating: switch between first person and chase view |
| Space | Spectating: next castaway |
| Esc | Release the mouse (pause menu) |

The in-game Controls panel (pause menu and waiting room) is the source of truth; its text lives in
`src/content/strings/en.json`.

### First-person settings

The camera is first person on foot and while falling; it is third person only aboard the carrier and on the death
cam. Open Settings from the gear button:

| Setting | Default | Notes |
|---|---|---|
| Field of view | 80 deg | 70 to 100, horizontal at 16:9 (wider screens see more to the sides) |
| Head bob | on | Off by default while Reduce motion is on (OS setting or toggle); tick it to force it on |
| Aim mode | Hold | Hold or Toggle for right-mouse ADS |
| ADS sensitivity | 1.00 | Mouse sensitivity multiplier while aiming |

The weapon viewmodel's FOV is fixed. Settings are saved in the browser.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Client (Vite, :5173) + server (`tsx watch`, :8797) together |
| `npm run dev:client` | Vite dev server only |
| `npm run dev:server` | Game server only, restarts on change |
| `npm run dev:office` | Same as `dev` with `MAP=office` (every room plays the office), on http://localhost:5174 with the server on 8798, so it can run next to `npm run dev` |
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
| `SEED` | random | Base seed. When set, room seeds are deterministic (`SEED` mixed with the room's serial number) |
| `MAX_ROOMS` | 8 | Rooms open at once. Creating one more fails with "max rooms" |
| `MAX_CONNECTIONS` | `MAX_ROOMS` x `match.maxPlayers` + 32 (8 x 16 + 32 = 160) | Total WebSocket connections on the process |
| `MAX_CONNS_PER_IP` | 128 | Connections per remote address (`0` = unlimited). High because a whole office can share one IP |
| `MAP` | | `island01` or `office`. Pins every room to that map; the map vote and the host's map setting are ignored. An invalid value logs one warning and is ignored |
| `ALLOWED_ORIGINS` | production: `self`; dev: `*` | WebSocket Origin policy: comma list of `*`, `self` and exact origins. Set it only when the client is served from another origin, e.g. `self,https://play.example.com` |
| `TRUST_PROXY` | | `1` behind a reverse proxy: per-IP limit uses `X-Forwarded-For`, and `self` accepts `X-Forwarded-Host` |

Example: `MAP=office SEED=42 MAX_ROOMS=2 npm run dev:server`.

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
