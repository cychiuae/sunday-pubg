# Test plan (M1 "First Playable")

Owner: qa-tester. Results for M1: [M1-test-report.md](M1-test-report.md). Bugs: [bugs/](bugs/).

## How to run

| What | Command | Time |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | ~10 s |
| Unit + integration (Vitest) | `npx vitest run` | ~30 s |
| QA static checks only | `npx vitest run tests/static` | <1 s |
| ws integration only | `npx vitest run tests/integration` | ~30 s |
| E2E (Playwright, Chromium + SwiftShader) | `npx playwright test` | ~8-10 min |
| One E2E spec | `npx playwright test gameplay` | 1-2 min |
| Load (16 sockets) | `PORT=8798 npx tsx server/index.ts` and then `npx tsx server/tools/bots.ts --url ws://127.0.0.1:8798/ws --clients 15 --seconds 30` | 35 s |

Locally without system Chromium libraries, prefix Playwright runs with `LD_LIBRARY_PATH=<extracted libs>`.

E2E specs never use the dev ports. Each spec file starts its own game server (random port, own `BALANCE_OVERRIDE`,
`LATENCY_MS`, `JITTER_MS`, `SEED`) and its own Vite with HMR and file watching off (`tests/e2e/support/stack.ts`,
`tests/e2e/support/vite.e2e.config.ts`). Server and Vite logs go to `test-results/stack-logs/`, and screenshots go to
`test-results/shots/`.

Authoritative state comes from a spectator socket (`tests/e2e/support/observer.ts`), which joins after the match starts
and records every snapshot and event. Client state comes from `window.__game` (dev/`?e2e` only), and render stats come
from `window.__render` (dev only).

## Coverage map

| Area | Unit (owner's `*.test.ts`) | QA Vitest (`tests/`) | E2E (`tests/e2e/`) | Manual |
|---|---|---|---|---|
| Sim purity / no hard-coded numbers / string keys | | `static/sim-purity`, `static/no-hardcoded` | | |
| Movement, jump, gravity, colliders | sim `movement`, `colliders` | | `gameplay` (walk 5.0, sprint 7.2 m/s, jump height, server time) | slopes, dock, world edge (island.md checklist) |
| Drop and steering | sim `movement`, `World` | | `gameplay` (drop steered onto loot) | |
| Loot, pickup, inventory | sim `loot`, `inventory`, `World` | `integration/pvp-over-ws` | `gameplay` (prompt, E, ammo then gun, slot) | swap prompt, vest blocked |
| Hitscan, damage, kill, standings | sim `combat`, `World` (combat.md AT1-12) | `integration/pvp-over-ws` (A kills B over sockets) | `gameplay` (LMB fires: mag and shot event) | headshot feel, hit markers |
| Reload, switch, heal | sim `World` AT6-9 | | `gameplay` (R, 3 to fists, 1 back) | Q heal channel and cancel |
| Tide | sim `zone` AT1-5 | | `gameplay` (drain = dps on server time, armor unchanged, outside banner) | tide wall visuals |
| Match loop | sim `World` lifecycle, headless 16-bot | `integration/pvp-over-ws` (results, then next match) | `match-loop` (death, spectate, results, lobby, next match, Play again) | |
| Lobby / join / HUD | ui `logic` | | `join` (lobby count, countdown, bots fill to target, HUD alive and health) | UI size 80/150 %, ultrawide |
| Two clients | | `integration/pvp-over-ws` | `join` (c): alive count agrees, disconnect drops by 1 | |
| Netcode | net `NetClient`, `SnapshotBuffer`, `clock`; server `Room`, `transport` | | `netcode` (B6 at 100 ms + 20 ms jitter, mid-match join, server death) | |
| Cheating client | server `validate`, `Room` | `integration/pvp-over-ws` (speed hack, fire-rate hack, garbage frames) | | |
| Settings | ui `settings` | | `settings` (persist, clamp corrupt, Esc and backdrop, focus return, name prefill) | |
| Boot / WebGL | | | `boot` (WebGL2, non-blank pixels, no console errors, name validation) | WebGL-unavailable overlay |
| Production one-port | server `config` (static) | | | `vite build` + `NODE_ENV=production`: page, assets, SPA fallback, `/ws` origin policy |
| Performance | | | `gameplay` (draw calls and tris in a live match) | fps on the reference laptop (headless SwiftShader cannot measure it) |
| Audio | audio unit tests | | | every SFX by ear, positional shots |

## Known harness limits (headless Chromium + SwiftShader)
- The page runs at about 9-13 fps. Key-up/mouse-up reach the DOM 0.5-1.3 s after Playwright sends them. Never assert
  timing from wall-clock polling; use the observer's snapshot history (`track`, `speed`), which uses server time.
- Under pointer lock, `page.mouse.move` produces paired +N/-N `movementX` events (net zero). Look input is driven by
  dispatching `MouseEvent('mousemove', { movementX })` on the document. Real-mouse feel is a manual check.
- `page.routeWebSocket(...).connectToServer(url)` does not redirect in Playwright 1.65, so every stack gets its own Vite.
- fps, audio and visual polish cannot be judged headless.

## Manual playtest checklist (per milestone)
Run on real hardware with `npm run dev`, then two tabs.
- [ ] Title: Tab to the name field, Enter submits, empty name shows the error. Settings gear works by keyboard.
- [ ] Lobby: the countdown number is fully inside the panel, and the seat pips and "Bots will fill" text are visible.
- [ ] Drop: steer with WASD; landing has no fall damage.
- [ ] Mouse look feels right at sensitivity 0.5 / 1 / 3. Invert Y works.
- [ ] Walk, sprint (Shift), and jump onto a crate. You can't walk through rocks/huts/palms and can't get wedged in the boulder field.
- [ ] E on each item kind (5 guns, 3 ammo, 2 heals, vest). Swap prompt when both slots are full. A vest at full armor is refused with feedback.
- [ ] LMB with each gun (distinct sound and muzzle flash), R reload bar, 1/2/3 and wheel, Q heal channel cancelled by firing.
- [ ] Headshot shows a yellow marker and deals more damage. Shotgun spread is visible.
- [ ] Tide: chip timer, warning banner, wall visible, outside banner + vignette, drain while outside.
- [ ] Die, then death card, then Spectate (immediately), then Space cycles targets, then results, then Play again, then next match.
- [ ] Two tabs see each other move smoothly. Tab hidden 30 s then visible: no rubber band and no stuck keys.
- [ ] Window resize and alt-tab mid-fight: no stuck movement or fire.
- [ ] Audio starts on first click, and the volume slider applies.
- [ ] `npm run build && npm start`: game on one port, fps overlay or devtools ≥ 60 fps at Medium on the reference laptop.
