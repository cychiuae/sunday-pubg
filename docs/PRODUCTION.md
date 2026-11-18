# Production Plan

Owner: `producer`. Last updated: 2026-11-18. Status values: `todo` / `doing` / `review` / `done`.

## Vision

A chibi, cel-shaded battle royale in the browser. Everyone drops onto a bright tropical island, grabs loot off the sand,
and fights while "the tide" (the safe zone) closes in. The last player standing wins. Matches are short, readable, and
start fast. Bots fill empty slots so a single human always gets a full match.

## Roadmap

| Milestone | Goal | Exit test |
|---|---|---|
| **M1 First Playable** (current) | Full match loop on localhost: lobby, drop, loot, fight, tide, death/spectate, results, reset. Bots fill the lobby. | Definition of Done below. |
| **M2 Polish & Feel** | Make it feel good. Plane drop, crouch/prone, scopes/ADS, lag compensation (server rewind for hitscan), animation and VFX polish, music, hit/kill feedback pass, quality presets for low-end laptops, accessibility options, balance from playtests. Hunger/thirst and light crafting only if the director confirms them (see Open questions). | Playtester rates movement, shooting, and pacing "good" in 3 sessions; 60 fps on the reference laptop at "Medium". |
| **M3 Online Launch** | Strangers can play on the public internet. Deployment (single-port production server, hosting, TLS/`wss`, CI deploy), multiple concurrent lobbies with simple matchmaking, binary protocol, basic anti-cheat validation, server metrics and crash logging, load test. | 4 lobbies x 16 players on one server instance with stable 30 Hz tick; public URL works. |
| Backlog (unscheduled) | Vehicles, building, squads, accounts, mobile controls. | Pulled in by director decision only. |

## M1 scope

**In scope**
- **Lobby**: title screen, enter name, join the single running lobby. Countdown starts when 1 or more humans are
  waiting. At countdown end the server fills up to `match.targetPlayers` (balance.json) with bots.
- **Spawn**: players start ~30 m in the air above map player spawns and fall with steering. No plane.
- **Movement**: WASD, Shift sprint, Space jump, mouse look (pointer lock), third-person over-the-shoulder camera.
- **Loot**: weapons, ammo, heals, and armor vest on the ground at loot spawns. `E` picks up the nearest item in range.
- **Inventory**: 2 weapon slots + fists (keys 1/2/3), ammo pools, heals (`Q` uses the best heal, with channel time), armor.
- **Combat**: server-authoritative hitscan. LMB fire, R reload, headshot multiplier, shotgun spread.
- **The tide**: zone phases (wait, then shrink) from balance.json; damage per second outside.
- **Death and results**: death, then spectate (killer or another alive player), then results (placement + kills).
  Last alive wins; server resets to lobby after `match.resultsSeconds`.
- **Bots**: server-side AI that wanders to loot, chases and shoots the nearest visible enemy, and moves into the zone.
- **HUD**: health + armor bars, ammo, weapon slots, alive count, kill count, zone timer/phase, minimap (circle map with
  zone rings and self arrow), kill feed, pickup prompt, hit marker, damage direction indicator, crosshair.
- **Menus** (minimal): title/name entry, lobby waiting (player count + countdown), death, results, settings (mouse
  sensitivity, volume).
- **Audio**: synthesized Web Audio SFX, no files: shot per weapon, hit, footsteps, pickup, reload, ambient waves, zone
  warning. Other players' shots are positional.
- **Art**: procedural low-poly models in code, no external files. Chibi (head ~40% of height, stubby limbs, skin/outfit/
  hair variants), palm, rock, bush, crate, hut, dock, umbrella, rowboat, tiki torch, driftwood, weapons, floating and
  spinning loot pickups.
- **Rendering**: MeshToonMaterial with one shared 3-step gradient map, inverted-hull outlines, stylised water with
  shoreline foam, sand/grass terrain from the shared `heightAt`, sky gradient, soft fog, sun shadows, hit VFX, muzzle
  flash, translucent animated tide wall at the zone edge.

**Out of scope for M1** (moved to M2/M3/Backlog above): plane drop, vehicles, crafting/building, hunger/thirst,
crouch/prone, scopes/ADS, squads, accounts, multi-lobby matchmaking, mobile controls, binary protocol, lag compensation.

**Fixed tech decisions** (from the director's brief; changes need a tech-lead ADR)
- One npm package, no workspaces. TypeScript strict, Vite, Three.js, `ws` server run with `tsx`, Vitest, Playwright.
- Dev: Vite on 5173 proxies `/ws` to the server on 8797. Production: the server serves `dist/` and `/ws` on one port.
- Entries: `index.html` + `src/main.ts` (client), `server/index.ts` (server).
- Metres, Y up, sea level y = 0, yaw 0 looks toward -Z. Sim tick 30 Hz, snapshots 20 Hz, client input 30 Hz. JSON protocol.
- Shared contracts fixed in the brief: `MapData`/`PropKind`/`LootTier` types (verbatim in `src/shared/types.ts`), item ids
  (`fists`, `pistol`, `smg`, `shotgun`, `rifle`, `ammo_light`, `ammo_heavy`, `ammo_shell`, `bandage`, `medkit`, `vest`),
  chibi variant indices `{ skin, outfit, hair }` (small ints that wrap, assigned by the server). Prop colliders come from
  `kind` x `scale` in `src/shared/sim`; prop models come from `kind` in `src/render/procedural`.

## M1 task board

Rule for Phase B: every builder's **first** change is a stub that compiles against `src/shared/contracts.ts`, so
integration (I1) can start before features are finished.

| ID | Task | Owner | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|
| **Phase A: foundations** | | | | | |
| A1 | Project scaffold: package.json scripts, Vite + proxy, tsconfig strict + resolveJsonModule, Vitest, Playwright install | build-engineer | none | `npm install && npm run dev` starts Vite on 5173 and the server on 8797; `/ws` proxies to 8797; `npm run typecheck`, `npm test`, `npm run build` all exit 0 on the empty project. | doing |
| A2 | Architecture + contracts: `docs/tech/ARCHITECTURE.md`, `src/shared/types.ts`, `events.ts`, `contracts.ts`, math helpers | tech-lead | A1 | `MapData` matches the brief verbatim; every Phase B module has a named facade interface in `contracts.ts`; event names and payloads are typed; the doc names the owner of `src/main.ts` and the data flow server -> net -> game -> render/ui/audio; typecheck passes. | doing |
| A3 | GDD + `docs/design/balance.json` | game-designer | none | Valid JSON with `match.targetPlayers`, `match.resultsSeconds`, lobby countdown, drop height, movement speeds, gravity/jump, per-weapon damage/fire rate/mag/reload/range/spread/headshot mult (+ shotgun pellets), ammo per pickup, heal amounts + channel times, vest absorption, zone phases (wait s, shrink s, end radius, DPS), loot tier tables. GDD explains each system in under 1 page each. | doing |
| A4 | Island map: `docs/design/levels/` + `src/game/levels/` exporting `MapData` | level-designer | A2 (type) | Typechecks as `MapData`; ~300 props across all 10 kinds; player spawns >= `match.targetPlayers`; every spawn and loot spawn lies inside `islandRadius` and outside prop footprints; >= 3 `zoneCenters` at least 30% of radius inland; every `nameKey` exists in en.json. | doing |
| A5 | Strings: `src/content/strings/en.json` + `index.ts` with `t(key, vars)` | narrative-designer | none | Keys for every item id, map + POI names, all HUD labels, all menus, kill feed and results templates; `t()` interpolates `{var}` and returns the key when missing (unit test). | doing |
| A6 | Art style + procedural models: `docs/art/STYLE.md`, `src/render/procedural/` | graphics-designer | A2 | A factory per `PropKind`, chibi, each weapon, and each loot pickup; chibi head is 38-42% of total height; variant indices wrap; tri budget: chibi <= 1,500, each prop <= 800; one shared 3-step gradient map; no external files; `docs/art/CREDITS.md` says "all procedural, original". | doing |
| **Phase B: build (parallel)** | | | | | |
| B1 | Sim core: `heightAt`, prop colliders, player movement step, drop/fall steering | game-developer | A2, A3, A4 | Unit tests: same inputs give identical state (deterministic); player cannot pass through rock/hut/palm colliders; jump and gravity match balance.json; a 30 m drop lands on terrain; position clamped to `worldRadius`. No imports from Three/DOM/audio (checked by test). | todo |
| B2 | Sim gameplay: inventory, loot pickup, hitscan combat, heals, armor, zone | game-developer | B1 | Unit tests: pickup only within range; 2 weapon slots + fists; ammo pool per type; reload consumes pool ammo; hitscan hits/misses a capsule correctly; headshot multiplier applies; shotgun pellets use seeded spread; vest absorbs per balance; heal channel completes after channel time and cancels on fire/swap; zone follows balance phases and damages outside. | todo |
| B3 | Sim match state machine + bots | game-developer | B2 | States lobby -> countdown -> drop -> playing -> results -> lobby. Bot fill to `targetPlayers`. Headless test: a 16-bot match ends with exactly 1 alive within the total zone duration; at least half the bots pick up a weapon; at least 1 kill by gunfire. | todo |
| B4 | Protocol: `src/shared/protocol/` message types + encode/decode | network-engineer | A2 | Typed join/input/snapshot/event/matchState messages; round-trip tests for each; malformed or oversize messages are rejected without throwing. | todo |
| B5 | Server: `server/` ws server, lobby, 30 Hz tick, 20 Hz snapshots, input validation | network-engineer | B3, B4 | Two browser tabs see each other move; NaN/oversized/too-fast inputs are clamped or dropped; disconnect mid-match removes the player cleanly; `npm run build && npm start` serves `dist/` + `/ws` on one port; env `BALANCE_OVERRIDE=<path>` loads a test balance file (for fast e2e). | todo |
| B6 | Net client: `src/net/` connection, input send, snapshot buffer, interpolation, prediction + reconciliation | network-engineer | B1, B4 | Remote players interpolate with ~100 ms delay and no visible jitter; local player predicts with the shared movement step; at 100 ms simulated latency (`LATENCY_MS` on server) local movement shows no rubber-banding while walking; disconnect shows a message key from en.json. | todo |
| B7 | Client game controller: `src/game/` input, pointer lock, camera yaw/pitch, spectate, event emission | game-developer | A2, B1 | All M1 keybinds work; mouse sensitivity setting applies; spectate follows killer, then next alive player on click; emits typed bus events only (no direct render/ui/audio calls). | todo |
| B8 | World rendering: terrain, water + foam, sky, fog, sun shadows, instanced props with outlines | graphics-engineer | A2, A4, A6, B1 | Terrain matches `heightAt` within 0.05 m at sampled points; props drawn with one InstancedMesh per kind (+ outline); <= 250 draw calls and <= 600k triangles in the busiest view; settings in `docs/tech/RENDERING.md`. | todo |
| B9 | Entities + VFX + camera: animated chibis, held weapons, loot pickups, muzzle flash, hit VFX, tide wall | graphics-engineer | B8 | Chibis show idle/run/jump/fall poses and the correct variant; loot floats and spins; muzzle flash + hit VFX appear on fire/hit events; tide wall tracks the zone radius each frame; over-the-shoulder camera does not clip into terrain. | todo |
| B10 | HUD: `src/ui/` | ui-ux-designer | A2, A5 | Every HUD element from M1 scope is present and driven by bus events; all text via `t()`; readable at 1280x720; hit marker and damage direction appear within one frame of the event. | todo |
| B11 | Menus + settings: title/name, lobby, death, results, settings | ui-ux-designer | A2, A5 | Full flow works by keyboard and mouse; name is 1-16 chars, validated; lobby shows player count + countdown; results shows placement + kills; sensitivity and volume persist in localStorage. | todo |
| B12 | Audio: `src/audio/` Web Audio engine + synthesized SFX | audio-designer | A2 | Every SFX in M1 scope plays on its bus event; each weapon sounds distinct; other players' shots use a PannerNode; AudioContext resumes on first user gesture; master volume setting applies; no audio files. | todo |
| B13 | CI + e2e harness: Playwright config with headless WebGL flags, `.github/` workflow | build-engineer | A1 | CI runs typecheck, unit tests, and e2e on push; Chromium launches with SwiftShader WebGL and a trivial Three.js page renders non-black pixels in CI. | todo |
| I1 | Walking skeleton: wire `src/main.ts` (stubs OK) | game-developer (pending A2 owner decision) | A2 + stubs of B4-B12 | Two tabs: both chibis visible walking on the island, HUD shell shows, a sound plays on jump. Done as early as possible; repeat as features land. | todo |
| **Phase C: verify** | | | | | |
| C1 | Unit test gap pass + sim purity test | qa-tester | B1-B4 | Coverage of `src/shared/sim` >= 70% lines; a test fails if any file in `src/shared/sim` imports three, DOM, or audio code; a test fails if a weapon number literal appears outside balance.json. | todo |
| C2 | Playwright smoke | qa-tester | I1, B5, B11, B13 | With fast balance override: title -> name -> lobby -> countdown -> in-game HUD visible -> canvas non-black -> results screen -> back to lobby, with zero console errors. Runs in CI under 3 min. | todo |
| C3 | Manual acceptance pass against the DoD checklist; bugs in `docs/qa/` | qa-tester | C2 | Each DoD item marked pass/fail with steps; every fail has a bug with owner. | todo |
| C4 | Code review | tech-lead | B1-B12 | No cross-ownership edits; no hard-coded gameplay numbers or player-facing strings; contracts respected; findings filed as tasks. | todo |
| C5 | Performance pass | graphics-engineer | B9, I1 | Full 16-player match at 1080p holds >= 60 fps average and >= 45 fps 1% low on the reference laptop (see Open questions); results recorded in RENDERING.md. | todo |
| C6 | Fix round | per bug owner | C3, C4, C5 | All P0/P1 bugs closed; C2 green. | todo |
| **Phase D: tune** | | | | | |
| D1 | Playtest: 3 solo matches vs bots | playtester | C6 | Written feedback on movement, shooting, loot density, tide pacing, bot difficulty, match length. | todo |
| D2 | Balance tuning | game-designer | D1 | Only balance.json changes; median match length 6-10 min (or the director's target); C2 still green. | todo |

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Parallel integration**: 9 builders working against contracts at once; mismatches show up late. | High | `contracts.ts` + typed events land first (A2); stub-first rule; I1 walking skeleton is the spike and runs as soon as stubs exist, then again after each B task; tech-lead is the only one who changes contracts. |
| **Sim does not terminate a match** (bots stall, zone bug). | High | B3 headless 16-bot test runs in Vitest without a browser; it is the gate for B5. |
| **WebGL in headless CI**: Chromium headless may have no GPU, so the canvas is black or creation fails. | Medium | B13 proves SwiftShader (`--use-angle=swiftshader`, `--enable-unsafe-swiftshader`) early; smoke test checks game state through a debug hook and DOM, and only one loose "canvas not black" pixel check; renderer errors are surfaced as console errors so the test fails loudly. |
| **Netcode feel**: JSON at 20 Hz with no lag compensation; shots may feel unfair above ~80 ms ping. | Medium | Client prediction with the shared movement step; 100 ms interpolation buffer; `LATENCY_MS` test knob; immediate local muzzle flash and sound, server-confirmed hit marker. Lag compensation is planned for M2. Localhost is the M1 target, so this is a feel risk, not a blocker. |
| **Performance**: ~300 props + 16 chibis, each with outline hulls (doubles draw calls), plus shadows. Target 60 fps on a mid laptop. | High | InstancedMesh per prop kind for body and outline; chibi parts share materials; one directional shadow map (2048) whose frustum follows the player; pixel ratio capped at 1.5; tri and draw-call budgets in A6/B8; C5 measures on real hardware. Fallback cuts, in order: shadows on props only near the player, outlines off for distant props, fewer palms. |
| **Scope creep** during Phase B. | Medium | Anything not on this board goes to M2/Backlog. A playable build beats a complete feature list. |

## Definition of Done for M1

- [ ] Fresh clone: `npm install && npm run dev`, open http://localhost:5173, and play with no extra steps.
- [ ] One human enters a name, joins, sees the countdown; bots fill to `match.targetPlayers` at countdown end.
- [ ] Players drop from ~30 m with steering and land at player spawns.
- [ ] WASD, Shift, Space, mouse look, 1/2/3, E, Q, R, and LMB all work as specified.
- [ ] All 5 weapons, 3 ammo types, 2 heals, and the vest can be found and used.
- [ ] Headshots deal more damage than body shots; the shotgun spreads.
- [ ] The tide shrinks per balance.json and damages players outside it; the tide wall is visible.
- [ ] Bots loot, fight, and move into the zone; a bots-only match always ends with one winner.
- [ ] Death leads to spectate, then the results screen with placement and kills; the server resets to the lobby after `match.resultsSeconds` and a new match can start.
- [ ] Every HUD element and menu in scope is present; settings persist.
- [ ] Every SFX in scope plays; other players' shots are positional.
- [ ] Chibi look: toon shading, ink outlines, variants visible; all props in the map render.
- [ ] Two browser tabs can play against each other.
- [ ] `npm run build && npm start` serves the game and `/ws` on one port.
- [ ] Typecheck, unit tests, and the Playwright smoke are green in CI.
- [ ] >= 60 fps average in a full match on the reference laptop.
- [ ] No hard-coded gameplay numbers or player-facing strings; sim purity test passes.
- [ ] No open P0/P1 bugs.

## Open questions for the director

1. CLAUDE.md pitches "gather and craft to survive"; the M1 brief is a PUBG-style looter. Are crafting and hunger/thirst part of the long-term game (M2) or cut for good?
2. Reference "mid laptop" for the 60 fps target: which machine (for example Intel Iris Xe, 16 GB, 1080p)?
3. Confirm `match.targetPlayers` = 16 and a target match length (proposed 6-10 min).
4. Who owns `src/main.ts`? Proposed: tech-lead decides in A2; game-developer wires it.
