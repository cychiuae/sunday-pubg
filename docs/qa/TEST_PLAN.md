# Test plan (M1, M2a "Arsenal & Stance", M2b "Office, Drop, Rooms & First person", M2c "Fresh Every Match & Bigger Arsenal")

Owner: qa-tester. Results: [M1-test-report.md](M1-test-report.md), [M2a-test-report.md](M2a-test-report.md),
[M2b-test-report.md](M2b-test-report.md), [M2c-test-report.md](M2c-test-report.md) (acceptance-criterion traceability). Bugs: [bugs/](bugs/).

## How to run

| What | Command | Time |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | ~10 s |
| Unit + integration (Vitest) | `npx vitest run` | ~30 s |
| QA static checks only | `npx vitest run tests/static` | <1 s |
| ws integration only | `npx vitest run tests/integration` | ~30 s |
| E2E (Playwright, Chromium + SwiftShader) | `npm run e2e:local` (adds the local Chromium libs) | ~12-15 min |
| M2a E2E only | `npm run e2e:local -- tests/e2e/m2a.spec.ts tests/e2e/m2a-soak.spec.ts` | ~4 min |
| M2a QA sim tests | `npx vitest run tests/sim tests/render tests/static` | ~5 s |
| One E2E spec | `npx playwright test gameplay` | 1-2 min |
| M2b E2E only | `npm run e2e:local -- tests/e2e/m2b-rooms.spec.ts tests/e2e/m2b-fp.spec.ts tests/e2e/m2b-office.spec.ts` | ~8 min |
| M2b QA Vitest | `npx vitest run tests/sim/m2b-edge.test.ts tests/server` | ~3 s |
| Load: 8 rooms | server on a QA port (8800-8999), then `npx tsx server/tools/bots.ts --url ws://127.0.0.1:<port>/ws --rooms 8 --clients 64 --seconds 60 --map office` | 70 s |
| M2c QA Vitest | `npx vitest run tests/sim/m2c-gaps.test.ts tests/sim/m2c-layout-qa.test.ts` | ~15 s |
| M2c E2E | `npm run e2e:local -- tests/e2e/m2c-layout.spec.ts tests/e2e/m2c.spec.ts tests/e2e/m2c-office.spec.ts tests/e2e/m2c-seeds.spec.ts` | ~25 min |
| Snapshot sizes | `npx tsx server/tools/measure-snapshot.ts --players 16 --seconds 60 --synthetic-grenades 16 --synthetic-rockets 16 --synthetic-smokes 12 --synthetic-panes 12` | 1 min |
| Office nav stuck rate | `npx tsx src/shared/sim/tools/matchReport.ts --map office --layout-seeds 30 --nav-walk 120` | 1-2 min |
| Pacing per map | `npx tsx src/shared/sim/tools/matchReport.ts --matches 30 --variant both --map office` (and `--map island01`) | 1-2 min |
| Load (16 sockets) | `PORT=8798 npx tsx server/index.ts` and then `npx tsx server/tools/bots.ts --url ws://127.0.0.1:8798/ws --clients 15 --seconds 30` | 35 s |

Locally without system Chromium libraries, prefix Playwright runs with `LD_LIBRARY_PATH=<extracted libs>`.

E2E specs never use the dev ports. Each spec file starts its own game server (a free port in 8800-8999) and Vite (a
free port in 5300-5399), each with its own `BALANCE_OVERRIDE`,
`LATENCY_MS`, `JITTER_MS`, `SEED`) and its own Vite with HMR and file watching off (`tests/e2e/support/stack.ts`,
`tests/e2e/support/vite.e2e.config.ts`). Server and Vite logs go to `test-results/stack-logs/`, and screenshots go to
`test-results/shots/`.

Authoritative state comes from a spectator socket (`tests/e2e/support/observer.ts`): since M2b it says `hello` and joins
the spec's room by its code after the match started (so it spectates), and records every snapshot and event. Specs reach
a match through the room flow (`tests/e2e/support/game.ts`: `toBrowser`, `createRoom`, `joinByCode`, `startMatch`,
`soloMatch`, `jumpAndLand`). `/healthz` is the RoomManager stats (`perRoom[]`). Client state comes from `window.__game` (dev/`?e2e` only), and render stats come
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
| Settings | ui `settings` | | `settings` (persist, clamp corrupt, Esc and backdrop, focus return, name prefill); `m2a` (Aim mode, ADS sensitivity, persist) | |
| M2a stance (C/Z/Space, water, headroom, hitboxes, prediction) | sim `stance`, `World.m2a`; game `prediction`, `camera`, `InputState` | `sim/m2a-acceptance`, `sim/m2a-edge`, `render/prone-hitbox-match` | `m2a` (eye height, server stance, lastCorrection, Ctrl unbound) | prone feel, crawl anim, hut/rock edges |
| M2a ADS and new guns | sim `combat`, `stance`, `World.m2a`; game `camera`, `ClientGame`; ui `logic` | `sim/m2a-acceptance`, `sim/m2a-edge` | `m2a` (RMB hold/toggle, FOV, scope view, sprint cancel, ADS sensitivity) | scope reticles, glint, recoil feel, 60 fps scoped |
| M2a armor and helmets | sim `combat`, `inventory`, `World.m2a`; `balance` | `sim/m2a-acceptance`, `sim/m2a-edge` | `m2a` (HUD gear cells) | wearables on chibis at 30 m, break VFX |
| M2a grenades | sim `grenade`, `World.m2a`; game `grenades`, `ClientGame` | `sim/m2a-acceptance`, `sim/m2a-edge` | `m2a` (4/G refused, pickup, cook arc, throw, server explosion) | arc vs real path, explosion VFX/audio |
| M2a loot and bots | sim `loot`, `World.m2a` bots | `sim/m2a-edge` (8 seeded bot matches) | | `matchReport --matches 30 --variant both` (pacing, weapon mix) |
| M2a soak | | | `m2a-soak` (60 s of mashed inputs: no console errors, no NaN, stance settles) | |
| Boot / WebGL | | | `boot` (WebGL2, non-blank pixels, no console errors, name validation) | WebGL-unavailable overlay |
| Production one-port | server `config` (static) | | | `vite build` + `NODE_ENV=production`: page, assets, SPA fallback, `/ws` origin policy |
| M2b map vote and rooms | sim `indoor` (resolveMapChoice), server `rooms`, `rooms.world`, `config`; ui `roomLogic`, `m2b`; game `rooms` | `server/m2b-rooms-qa` | `m2b-rooms` (3 contexts: private room, code, `?room=` + `?map=`, never listed, vote, results back to the room, host migration), `join`, `netcode` | host kick UX, toasts, copy invite link |
| M2b carrier drop | sim `World.m2b`, `bots`; game `drop`, `dropPrediction`, `ClientGame.m2b` | `sim/m2b-edge` (zone while aboard) | `m2b-fp` (stage order, cameras, drop HUD, corrections), `m2b-rooms` (Space, F, auto-eject), `m2b-office` (aimed jump) | drop feel, canopy look-up |
| M2b office level | level `office`, sim `indoor`, `nav`, `bots`; render `m2b`, `procedural/office` | `sim/m2b-edge` (real office: glass, walls, net, monitor tops, camera QA 2) | `m2b-office` (climb route onto a desk, stance on the plateau, console-clean match) | glass look, sprinkler rain, indoor audio |
| M2b first person | game `camera`, `viewmodel`, `ClientGame.m2b`; render `viewmodelAnim`, `m2b` | `sim/m2b-edge` (shot under the screen centre, prone pitch clamp incl. bots) | `m2b-fp` (FP on foot, FOV setting, rifle red dot, spectate V) | viewmodel vs walls, bob/recoil feel, reduced motion |
| Performance | | | `gameplay` (draw calls and tris in a live match) | fps on the reference laptop (headless SwiftShader cannot measure it) |
| Audio | audio unit tests | | | every SFX by ear, positional shots |

## Known harness limits (headless Chromium + SwiftShader)
- The page runs at about 9-13 fps. Key-up/mouse-up reach the DOM 0.5-1.3 s after Playwright sends them. Never assert
  timing from wall-clock polling; use the observer's snapshot history (`track`, `speed`), which uses server time.
- Under pointer lock, `page.mouse.move` produces paired +N/-N `movementX` events (net zero). Look input is driven by
  dispatching `MouseEvent('mousemove', { movementX })` on the document. Real-mouse feel is a manual check.
- `page.routeWebSocket(...).connectToServer(url)` does not redirect in Playwright 1.65, so every stack gets its own Vite.
- fps, audio and visual polish cannot be judged headless.
- CDP key events do not reach the browser UI, so Escape does not release pointer lock; specs call
  `document.exitPointerLock()` to reach the pause overlay.
- M2c: every match has a random layout. Specs that walk pin `LAYOUT_SEED` (`stack.ts` `layoutSeed`; `baseline` = seed 0,
  the M2b props and loot). On the office, long walks follow the bots' nav graph (`support/nav.ts` -> `support/office-path.ts`
  in a tsx child process) instead of raw W-pulse steering, which stalls on furniture. `window.__game` has the M2c state
  since BUG-014 (layout ref and `hashMatched`, slots and levels, throwables, rockets, smokes, broken panes, `inSmoke`,
  per-player `smokeHidden` and `swing`).
- M2b: three WebGL pages in one run get a few fps each; `window.__game` only changes per rendered frame, so a short
  stage (office freefall 1 s, chute 1.25 s) can fall between two frames. Sample in the page (`requestAnimationFrame`)
  and check strict stage order single-page. Frames over 200 ms make the server run ticks the client did not predict,
  so `lastCorrection` shows whole ticks of motion (1.000 m per tick of freefall); compare against the frame gap.

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

### M2a additions
- [ ] RMB with pistol/smg/shotgun (iron), rifle/lmg (red dot): camera tightens, crosshair becomes a dot. dmr (4x) and sniper (8x): scope overlay after the zoom-in, own body hidden, 60 fps held while scoped.
- [ ] Aim mode Toggle and ADS sensitivity in Settings feel right; sprinting then RMB stops the sprint.
- [ ] C / Z / Space through every stance pair; crawl animation; no rubber-banding at `LATENCY_MS=100`.
- [ ] Prone into the sea: auto-stand with a splash and "Too deep here" on Z.
- [ ] Shoot a crouched and a prone friend in the head from the front and the side: hit markers match what you see (BUG-008).
- [ ] Vest/helmet tiers readable on a chibi at 30 m; break flash and sound; swap prompt shows "Lv N cur/max"; old piece drops.
- [ ] Grenade: 4/G, cook ring turns red at 1 s, arc preview, throw, bounce sounds, explosion VFX and screen shake; cook-out in hand; swap while cooking drops it at your feet ("Dropped it! Run!").
- [ ] Kill feed shows the grenade icon; danger indicator for nearby live grenades.
- [ ] Bots wear helmets, snipe at range, throw grenades at you behind cover, sometimes crouch or go prone.

### M2b additions
- [ ] Rooms: create public and private, join by code (lower case, with a dash), invite link opens the room after the
  name, the private room never shows in another browser's list, kick (then the same browser cannot rejoin for 2 min),
  host leaves -> crown moves, toasts readable, Copy / Copy invite link work.
- [ ] Map vote: tallies update live, "Next map: Office" at the lock, `?map=office` pre-selects, `MAP=office` shows
  "Map locked".
- [ ] Carrier: orbit camera around the seaplane / drone, doors timer, Space and F jump, freefall wind, chute opens
  (manual and auto), landing on a desk top, auto-eject if you never jump.
- [ ] First person: no own body, viewmodel arms in every state (fists, guns, grenade cook/throw, heal, reload, swap),
  never clipping into walls when hugging one; head bob on/off; reduced motion; FOV slider 70/80/100; red dot and iron
  sights centred; scopes hide the arms; canopy visible looking up in the chute.
- [ ] Spectate: FP of the target, V toggles the chase view, "V: switch view" hint, Space/click cycles.
- [ ] Office: climb every route kind (ramp, book stairs, perch tower), crawl under desks, glass rooms see-through but
  solid, ping-pong net cannot be hopped, sprinkler rain inside the circle edge, no names or logos anywhere.
- [ ] Monitor tops next to the perches (BUG-011): after the fix, no landing on them.

### M2c additions
- [ ] Levels: every levelled weapon looks different at L1-L4 (ground, third person, viewmodel); badge numerals readable in
  greyscale; L4 sparkle; armor tier 4 models and 4 pips.
- [ ] Melee: knife / machete / paddle swings, recovery ring, paddle knockback, glass shatter by melee, hit markers.
- [ ] RPG: launch, trail, whistle, explosion, dud clunk at short range, self-damage line on the death card.
- [ ] Smoke: cloud look from inside and outside; name tags, hit markers and the spectate outline hidden through it; no
  minimap cloud; hiss for a late joiner.
- [ ] Scopes: 2x overlay, red dot on the viewmodel, T switch chip and stash, glint at 4x / 8x only.
- [ ] Layouts: 3 seeds per map look sane (no floating props, no blocked doors), looks (morning / golden / overcast; day /
  evening / after hours), results screen shows "Layout #".
- [ ] Office glass: break by melee and rocket, walk through, pieces on the floor.
- [ ] Audio "(ear)" checks in docs/audio/M2c.md §12.
