# Production Plan

Owner: `producer`. Last updated: 2026-11-18 (M2a added). Status values: `todo` / `doing` / `review` / `done`.

## Vision

A chibi, cel-shaded battle royale in the browser. Everyone drops onto a bright tropical island, grabs loot off the sand,
and fights while "the tide" (the safe zone) closes in. The last player standing wins. Matches are short, readable, and
start fast. Bots fill empty slots so a single human always gets a full match.

## Roadmap

| Milestone | Goal | Exit test |
|---|---|---|
| **M1 First Playable** (done) | Full match loop on localhost: lobby, drop, loot, fight, tide, death/spectate, results, reset. Bots fill the lobby. | Definition of Done below. |
| **M2a Arsenal & Stance** (current) | ADS (RMB), dmr/sniper/lmg, vest and helmet tiers 1-3, frag grenades, crouch and prone. See the M2a section below. | M2a board Phase D green; director playtest sign-off. |
| **M2b Office Map** (next; design now) | Second map: the office at 9x scale ("tiny heroes"), lobby map vote, island kept; plane drop with a random route on both maps; rooms (browser, create, join by code, waiting room with host). See the M2b section below. | M2b board Phase D green; director playtest sign-off on both maps. |
| **M2 Polish & Feel** | Make it feel good. Lag compensation (server rewind for hitscan), animation and VFX polish, music, hit/kill feedback pass, quality presets for low-end laptops, accessibility options, balance from playtests. Hunger/thirst and light crafting only if the director confirms them (see Open questions). | Director rates movement, shooting, and pacing "good" in their own playtests; 60 fps on the reference laptop at "Medium". |
| **M3 Online Launch** | Strangers can play on the public internet. (Multiple concurrent lobbies were pulled forward to M2b as rooms.) Deployment (single-port production server, hosting, TLS/`wss`, CI deploy), binary protocol, basic anti-cheat validation, server metrics and crash logging, load test. | 4 lobbies x 16 players on one server instance with stable 30 Hz tick; public URL works. |
| Backlog (unscheduled) | Vehicles, building, squads, accounts, mobile controls. | Pulled in by director decision only. |

## M2a — Arsenal & Stance

Source: the director's M2a brief (fixed IDs and rules; specs fill in numbers). Out of scope: attachments, smoke/flash,
vehicles, lean, first-person outside scopes, lag compensation. **The director playtests personally; there is no
playtester agent pass.** Builders' first change is a stub that compiles against the B1 contract.

| Task | Owner agent | Depends on | Status | Acceptance criteria |
|---|---|---|---|---|
| **Phase A: specs (parallel)** | | | | |
| 2a-A1 Specs (ADS, stance, armor/helmet, grenade, new guns, loot, bots) + balance.json | game-designer | none | doing | balance.json has per-weapon `sight`/`adsZoom`/`adsSpreadMultiplier`/`adsMoveMultiplier`/`adsTimeMs`, `movement.stances`, vest/helmet tiers, `grenade`, `ammo_sniper`, updated loot tables; each system spec under 1 page. |
| 2a-A2 Models for dmr/sniper/lmg/grenade/vest_1-3/helmet_1-3, chibi wearables, reticle specs, crouch/prone pose spec | graphics-designer | none | doing | A factory per new item; vest and helmet tiers readable on a chibi at 30 m; reticle spec per sight type; tri budgets kept; CREDITS.md updated. |
| 2a-A3 Strings for new items, `betterArmor`, stance/ADS/grenade HUD, settings, controls help, kill feed | narrative-designer | none | doing | Every new item id and UI label has an en.json key; no hard-coded text needed by C-phase tasks. |
| 2a-A4 This board + risks | producer | none | done | M2a section, M1 marked done, risks updated. |
| **Phase B: contract** | | | | |
| 2a-B1 Contract revision: types.ts (IDs, stance, `ads`, `stanceToggle`, grenade entities, armor fields), protocol messages, balance validation, ARCHITECTURE.md §14 "M2a contract", ADR 0004 (stance + grenade sim) | tech-lead | 2a-A1 | todo | Typecheck passes with stubs; balance validation rejects a missing M2a field; §14 and ADR name owners and data flow for each new field/event. |
| **Phase C: build (parallel; C1 and C3 are spikes, start first)** | | | | |
| 2a-C1 Sim stance: crouch/prone movement, transition timer, stance hitboxes and eye height, headroom, water auto-stand | game-developer | 2a-B1 | todo | Unit tests: prone hitbox lies along yaw; cannot stand under the hut roof; prone in deep water auto-stands; same inputs give identical state. |
| 2a-C2 Sim ADS + new weapons + vest/helmet tiers + `ammo_sniper` | game-developer | 2a-B1 | todo | Unit tests: ADS blocked while sprint/reload/heal/swap; sniper headshot kills through helmet_2; higher tier replaces and drops old with durability; same-or-lower refused unless broken. |
| 2a-C3 Sim grenades: cook, throw, bounce, fuse, falloff, LOS, vest absorb, self-damage, kill credit | game-developer | 2a-B1 | todo | Unit tests: same seed gives identical bounce path and damage; props block blast LOS; cooked-out grenade explodes in hand; thrower gets kill credit. |
| 2a-C4 Bots: armor pickup, range-aware gun use, grenades at covered enemies 8-30 m, cautious crouch/prone | game-developer | 2a-C1, 2a-C2, 2a-C3 | todo | Headless 16-bot match ends with 1 winner; bots log at least one grenade throw and one sniper/dmr kill over 30 matches. |
| 2a-C5 Client: input (RMB hold/toggle, C/Z/Space, 4/G, cooking), prediction of stance/ADS, hud/frame view | game-developer | 2a-C1, 2a-C2 | todo | All new binds work, Ctrl unbound; at 100 ms `LATENCY_MS`, crouch/prone and ADS show no rubber-banding. |
| 2a-C6 Net: protocol, validation, delta encoding for stance, ads, armor fields, grenades | network-engineer | 2a-B1 | todo | Round-trip tests for every new field and event; invalid `stanceToggle`/`ads` dropped; snapshot size at 16 players + 10 grenades within the ADR budget. |
| 2a-C7 ADS camera + scope first-person view (body hidden) | graphics-engineer | 2a-A2, 2a-B1 | todo | Iron/red dot zoom over shoulder; 4x/8x switch to scope view after `adsTimeMs`; sensitivity scales with zoom; 60 fps held while scoped. |
| 2a-C8 Stance poses + vest/helmet wearables on chibis | graphics-engineer | 2a-A2, 2a-B1 | todo | Remote chibis show stand/crouch/prone and their vest/helmet tier from snapshots. |
| 2a-C9 Grenade in-hand, flight, predicted arc, explosion VFX | graphics-engineer | 2a-A2, 2a-B1 | todo | Arc shows while cooking; flight matches server pos within interpolation; explosion VFX on `explosion` event. |
| 2a-C10 Scope overlays, reticles, HUD vest/helmet/grenade/stance, settings (ADS hold/toggle, ADS sensitivity), controls help | ui-ux-designer | 2a-A2, 2a-A3, 2a-B1 | todo | Every new HUD element driven by bus events; text via `t()`; settings persist; grenade icon in kill feed. |
| 2a-C11 Audio: dmr/sniper/lmg shots, grenade pin/throw/bounce/explosion, ADS and stance foley | audio-designer | 2a-B1 | todo | Each new SFX plays on its bus event; explosion is positional; each new gun sounds distinct. |
| 2a-C12 Loot spawn tier tweaks (only if A1 needs them) | level-designer | 2a-A1 | todo | Map still typechecks; level-3 armor and snipers only reachable at epic spawns. |
| **Phase D: verify and tune** | | | | |
| 2a-D1 Unit + e2e tests for every acceptance criterion above | qa-tester | Phase C | todo | Typecheck, vitest, and `npm run e2e:local` green; each criterion mapped to a test or a manual step in `docs/qa/`. |
| 2a-D2 Code review | tech-lead | Phase C | todo | No cross-ownership edits, hard-coded numbers/strings, Math.random in sim, or sim imports of render/DOM/audio; findings filed as fix tasks. |
| 2a-D3 Pacing + rifle dominance check | game-designer | 2a-C4 | todo | `matchReport --matches 30 --variant both`: median match 6-7 min; rifle no longer the top killer by a wide margin; balance.json only. |
| 2a-D4 Fix round | per bug owner | 2a-D1, 2a-D2, 2a-D3 | todo | All P0/P1 closed; D1 still green; build handed to the director for playtest. |

## M2b — Office Map

Source: the director's M2b brief. Indoor map from the office seat plan at world = real x 9 (~234 x 144 m), map vote
(Island / Office / Random), same rules on both maps. Phase A is design only and runs now; Phase B starts only after
M2a lands (2a-D4), because M2a builders are editing the same code. **The director playtests personally; no playtester
agent pass.** Reference images stay in the repo root.

| Task | Owner agent | Depends on | Status | Acceptance criteria |
|---|---|---|---|---|
| 2b-R0 **Privacy/IP rule** (applies to every M2b task) | all agents | none | doing | No real person's name (the plan's person-named room → Corner Office), no company name/sign/logo, no likeness of people in the photo, no copy of the plan's cartoon; department colours only as neutral zones; reference images never copied into `public/` or `src/`. |
| **Phase A: design (parallel, now)** | | | | |
| 2b-A1 This board + risks | producer | none | done | M2b section, risks, roadmap row. |
| 2b-A2 Map vote rules, office zone phases + fiction, per-map balance overrides, verticality rules | game-designer | none | doing | Spec under 1 page per system; per-map overrides limited to zone radii, drop height, and what's strictly needed; climb steps <= `movement.stepHeight` or jumpable <= ~1.0 m. |
| 2b-A3 `docs/design/levels/office.md`: full layout with coordinates | level-designer | none | doing | All rooms, 4 desk blocks (5x2, 5x2, 5x2, 6x2), aisles, doorways, climb routes, crawlspaces, spawns >= `targetPlayers`, loot spawns, >= 3 zone centres, POIs; neutral names only. |
| 2b-A4 Procedural office props + indoor look in STYLE.md | graphics-designer | none | doing | Factories for desk, chair, monitor, glass wall, phone pod, light panel, duct, extinguisher, clutter; tri budgets kept; instancing-friendly; CREDITS.md updated. |
| 2b-A5 Strings: map names, zone fiction, POI names, vote text | narrative-designer | 2b-A2 (fiction pick) | doing | Every office POI and vote label has an en.json key; no real names or company name. |
| 2b-A6 `docs/design/systems/drop.md` + balance: route RNG and margins, no-jump time, auto-eject, freefall, auto/early chute, per-map carrier altitude/speed, bot jump rules | game-designer | none | doing | Every drop number in balance.json (`maps.<id>` overrides for altitude, speed, margins); spec under 1 page; flight time fits the 330-480 s median. |
| 2b-A7 Drop strings: "Press Space/F to jump", players aboard, jump-window countdown, carrier names | narrative-designer | 2b-A6 | doing | Every aboard HUD label has an en.json key with `{var}` placeholders. |
| 2b-A8 Seaplane, toy delivery drone, and parachute models (original) | graphics-designer | none | doing | One factory each; readable from 120 m (seaplane) and 25 m (drone); tri budgets kept; CREDITS.md updated. |
| 2b-A9 Rooms UX spec: room browser, create room, join by code, waiting room, host controls, mid-match join (spectate) | ui-ux-designer | none | doing | Flow title -> browser -> waiting room -> match -> results -> same waiting room is specified for keyboard and mouse; Leave returns to the browser. |
| 2b-A10 Rooms server proposal: RoomManager, lobby messages, rate limits, room-list throttling | network-engineer | none | doing | Proposal lists every lobby message with validation and host-only checks; `MAX_ROOMS` (default 8); room list sent only to clients on the browser screen. |
| 2b-A11 `docs/design/systems/rooms.md`: host rules, ready, auto-start, fill-with-bots toggle, per-room human cap, map mode | game-designer | none | doing | Auto-start and bot-fill decisions written down; numbers in balance.json. |
| 2b-A12 Rooms strings: browser, create, code, waiting room, host, ready, "Waiting for host…", errors | narrative-designer | 2b-A9 | doing | Every rooms label and error has an en.json key; default room name is the `{name}` template. |
| **Phase B: contract (after M2a lands)** | | | | |
| 2b-B1 `MapData` union (`island` / `indoor`), map id in welcome/match messages, vote messages, per-map balance validation, plane drop (route in match state, `jumpPlane` input, aboard/freefall/chute states, fate of `playerSpawns`), ARCHITECTURE.md §15, ADR 0005 | tech-lead | 2a-D4, 2b-A2, 2b-A3, 2b-A6 | todo | Island map typechecks as `kind: 'island'` with no behaviour change; indoor and drop fields match the brief; ADR lists every consumer file to change and its owner. |
| 2b-B2 ADR 0006 rooms (inside §15): Room/RoomManager boundaries, lobby protocol types, room code format, host migration | tech-lead | 2a-D4, 2b-A9, 2b-A10, 2b-A11 | todo | Lobby message types typecheck; ADR states that the sim World is unchanged and one World runs per room. |
| **Phase C: build (parallel; C1 and C3 are spikes)** | | | | |
| 2b-C1 Sim: indoor world (flat floor, solid/glass walls, doorways, desk plateaus, climb routes); island path unchanged | game-developer | 2b-B1 | todo | Unit tests: glass blocks movement and bullets; player climbs a route onto a desktop; prone fits under desks; M2a sim tests still green on island. |
| 2b-C2 `src/game/levels/office.ts` exporting indoor `MapData` | level-designer | 2b-B1, 2b-A3 | todo | Typechecks; spawns and loot outside collider footprints; every `nameKey` in en.json; every desktop reachable by a climb route. |
| 2b-C3 Bots: nav grid/waypoints from colliders at map load, deterministic cached A*, climb-route use; matchReport `--map` | game-developer | 2b-C1, 2b-C2 | todo | Same seed gives the same path; headless 16-bot office match ends with 1 winner in 30/30 runs; no bot stuck > 10 s. |
| 2b-C4 Server map selection: vote tally, random tie-break, rotation with no votes, `MAP` env pin; map id sent before drop | network-engineer | 2b-B1 | todo | Tests: tie-break uses seeded RNG; `MAP=office` pins; a client joining mid-lobby receives the current map id. |
| 2b-C5 Client: load map by id, `?map=office` pre-selects vote, vote input | game-developer | 2b-B1, 2b-C4 | todo | Two tabs voting Office both load the office before the drop; switching map between matches leaks no old-map entities. |
| 2b-C6 Indoor rendering: floor materials, walls, glass, ceiling lights/ducts, instanced desks/chairs/monitors, zone fiction visual | graphics-engineer | 2b-A4, 2b-B1 | todo | Within existing draw-call (<= 250) and triangle (<= 600k) budgets in the busiest office view; nothing rendered above the ceiling. |
| 2b-C7 Camera: wall collision plus fade/cutaway of near walls | graphics-engineer | 2b-C6 | todo | Camera never ends up behind a wall with the player hidden, checked in every room and under desks. |
| 2b-C8 Lobby map vote UI, office minimap (rooms, desks, walls), zone-fiction HUD text | ui-ux-designer | 2b-A5, 2b-B1 | todo | Vote shows counts and the result; minimap matches the layout; all text via `t()`. |
| 2b-C9 Audio: indoor ambience, zone fiction SFX, floor-material footsteps | audio-designer | 2b-A2, 2b-B1 | todo | Ambience swaps by map; footsteps differ on wood/carpet/tile; zone SFX plays on its bus event. |
| 2b-C10 Sim drop: carrier on a seeded route, aboard (invulnerable, untargetable, no actions), no-jump time, auto-eject, freefall, auto chute, landing (extends `dropping`) | game-developer | 2b-B1 | todo | Unit tests: same seed gives the same route; route crosses the playable area on both maps; jump blocked in no-jump time; everyone aboard is ejected before the carrier exits. |
| 2b-C11 Bot jump choice: jump points near loot POIs on the line, spread, early/late by personality, steer to the POI | game-developer | 2b-C10 | todo | Headless: bots land spread over >= 4 POIs on average; no bot lands outside the playable area. |
| 2b-C12 Net: route in match state (sent during countdown), `jumpPlane` input, aboard/chute state in snapshots | network-engineer | 2b-B1 | todo | Round-trip tests for the new fields; a client joining during the countdown gets the route; `jumpPlane` before the no-jump time ends is ignored. |
| 2b-C13 Client: aboard orbit camera, Space/F jump input, prediction of freefall/chute, HUD view data | game-developer | 2b-C10, 2b-C12 | todo | F and Space jump; orbit camera has free mouse look; no rubber-banding during freefall at 100 ms `LATENCY_MS`. |
| 2b-C14 Render: carrier along the route, parachute, freefall and chute poses | graphics-engineer | 2b-A8, 2b-B1 | todo | Carrier position matches the server within interpolation; parachute opens on the deploy event; poses switch by state. |
| 2b-C15 UI: dashed route + moving carrier icon on the minimap (countdown and flight), aboard HUD | ui-ux-designer | 2b-A7, 2b-B1 | todo | Route shows during the countdown on both maps; aboard HUD shows the jump prompt, players aboard, and the jump-window countdown via `t()`. |
| 2b-C16 Audio: carrier engine (seaplane, drone), freefall wind, parachute pop | audio-designer | 2b-B1 | todo | Engine is positional and fades after the jump; wind scales with fall speed; pop plays on the deploy event. |
| 2b-C17 Net: RoomManager (many Rooms, each with its own World, tick, seed, map), lobby protocol, validation, rate limits, host migration, room close | network-engineer | 2b-B2 | todo | Tests: 5-char code from the unambiguous alphabet, case-insensitive; private rooms never listed; host leaves -> oldest human is host; last human leaves -> room closes; `MAX_ROOMS` enforced. |
| 2b-C18 Client lobby flow and view model (`src/game` or `main`): browser, create, join by code, `?room=CODE` deep link, waiting room, back to the same room after results | game-developer | 2b-B2, 2b-C17 | todo | Deep link joins after name entry; joining mid-match spectates, then lands in the waiting room. |
| 2b-C19 UI: room browser and waiting room (list, create form, code field, big code + copy, player list with crown/ready, host controls, map vote) | ui-ux-designer | 2b-A12, 2b-B2 | todo | Non-hosts see "Waiting for host…"; host Start works with >= 1 human; all text via `t()`. |
| 2b-C20 Sim: confirm the World is per-room and unchanged (no globals, no shared RNG) | game-developer | 2b-B2 | todo | Two Worlds in one process with different seeds run side by side and give the same results as when each runs alone. |
| **Phase D: verify and tune** | | | | |
| 2b-D1 Unit + e2e on both maps, plus a privacy check | qa-tester | Phase C | todo | Tests green; e2e runs one match on each map; a test fails if en.json or the map data contains a name from a privacy blocklist. |
| 2b-D5 Plane drop QA on both maps | qa-tester | 2b-C10 to 2b-C16 | todo | e2e: route on the minimap in the countdown, F jumps, chute deploys, player lands; auto-eject works if the player never jumps; two matches give different routes. |
| 2b-D6 Multi-room e2e | qa-tester | 2b-C17 to 2b-C20 | todo | Two rooms run matches at once without crosstalk; create -> join by code -> start -> results -> back to the same waiting room; private room hidden from the browser. |
| 2b-D2 Code review | tech-lead | Phase C | todo | No cross-ownership edits, hard-coded numbers/strings, or sim imports of render/DOM/audio; island behaviour unchanged. |
| 2b-D3 Pacing check on both maps, including flight time | game-designer | 2b-C3, 2b-C11 | todo | `matchReport --map island` and `--map office`, 30 matches each: median match 330-480 s; balance.json only. |
| 2b-D4 Fix round, then hand over for the director's playtest | per bug owner | 2b-D1, 2b-D2, 2b-D3, 2b-D5, 2b-D6 | todo | All P0/P1 closed; D1 green. |

## M1 scope (done)

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

## M1 task board (done)

Rule for Phase B: every builder's **first** change is a stub that compiles against `src/shared/contracts.ts`, so
integration (I1) can start before features are finished.

| ID | Task | Owner | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|
| **Phase A: foundations** | | | | | |
| A1 | Project scaffold: package.json scripts, Vite + proxy, tsconfig strict + resolveJsonModule, Vitest, Playwright install | build-engineer | none | `npm install && npm run dev` starts Vite on 5173 and the server on 8797; `/ws` proxies to 8797; `npm run typecheck`, `npm test`, `npm run build` all exit 0 on the empty project. | done |
| A2 | Architecture + contracts: `docs/tech/ARCHITECTURE.md`, `src/shared/types.ts`, `events.ts`, `contracts.ts`, math helpers | tech-lead | A1 | `MapData` matches the brief verbatim; every Phase B module has a named facade interface in `contracts.ts`; event names and payloads are typed; the doc names the owner of `src/main.ts` and the data flow server -> net -> game -> render/ui/audio; typecheck passes. | done |
| A3 | GDD + `docs/design/balance.json` | game-designer | none | Valid JSON with `match.targetPlayers`, `match.resultsSeconds`, lobby countdown, drop height, movement speeds, gravity/jump, per-weapon damage/fire rate/mag/reload/range/spread/headshot mult (+ shotgun pellets), ammo per pickup, heal amounts + channel times, vest absorption, zone phases (wait s, shrink s, end radius, DPS), loot tier tables. GDD explains each system in under 1 page each. | done |
| A4 | Island map: `docs/design/levels/` + `src/game/levels/` exporting `MapData` | level-designer | A2 (type) | Typechecks as `MapData`; ~300 props across all 10 kinds; player spawns >= `match.targetPlayers`; every spawn and loot spawn lies inside `islandRadius` and outside prop footprints; >= 3 `zoneCenters` at least 30% of radius inland; every `nameKey` exists in en.json. | done |
| A5 | Strings: `src/content/strings/en.json` + `index.ts` with `t(key, vars)` | narrative-designer | none | Keys for every item id, map + POI names, all HUD labels, all menus, kill feed and results templates; `t()` interpolates `{var}` and returns the key when missing (unit test). | done |
| A6 | Art style + procedural models: `docs/art/STYLE.md`, `src/render/procedural/` | graphics-designer | A2 | A factory per `PropKind`, chibi, each weapon, and each loot pickup; chibi head is 38-42% of total height; variant indices wrap; tri budget: chibi <= 1,500, each prop <= 800; one shared 3-step gradient map; no external files; `docs/art/CREDITS.md` says "all procedural, original". | done |
| **Phase B: build (parallel)** | | | | | |
| B1 | Sim core: `heightAt`, prop colliders, player movement step, drop/fall steering | game-developer | A2, A3, A4 | Unit tests: same inputs give identical state (deterministic); player cannot pass through rock/hut/palm colliders; jump and gravity match balance.json; a 30 m drop lands on terrain; position clamped to `worldRadius`. No imports from Three/DOM/audio (checked by test). | done |
| B2 | Sim gameplay: inventory, loot pickup, hitscan combat, heals, armor, zone | game-developer | B1 | Unit tests: pickup only within range; 2 weapon slots + fists; ammo pool per type; reload consumes pool ammo; hitscan hits/misses a capsule correctly; headshot multiplier applies; shotgun pellets use seeded spread; vest absorbs per balance; heal channel completes after channel time and cancels on fire/swap; zone follows balance phases and damages outside. | done |
| B3 | Sim match state machine + bots | game-developer | B2 | States lobby -> countdown -> drop -> playing -> results -> lobby. Bot fill to `targetPlayers`. Headless test: a 16-bot match ends with exactly 1 alive within the total zone duration; at least half the bots pick up a weapon; at least 1 kill by gunfire. | done |
| B4 | Protocol: `src/shared/protocol/` message types + encode/decode | network-engineer | A2 | Typed join/input/snapshot/event/matchState messages; round-trip tests for each; malformed or oversize messages are rejected without throwing. | done |
| B5 | Server: `server/` ws server, lobby, 30 Hz tick, 20 Hz snapshots, input validation | network-engineer | B3, B4 | Two browser tabs see each other move; NaN/oversized/too-fast inputs are clamped or dropped; disconnect mid-match removes the player cleanly; `npm run build && npm start` serves `dist/` + `/ws` on one port; env `BALANCE_OVERRIDE=<path>` loads a test balance file (for fast e2e). | done |
| B6 | Net client: `src/net/` connection, input send, snapshot buffer, interpolation, prediction + reconciliation | network-engineer | B1, B4 | Remote players interpolate with ~100 ms delay and no visible jitter; local player predicts with the shared movement step; at 100 ms simulated latency (`LATENCY_MS` on server) local movement shows no rubber-banding while walking; disconnect shows a message key from en.json. | done |
| B7 | Client game controller: `src/game/` input, pointer lock, camera yaw/pitch, spectate, event emission | game-developer | A2, B1 | All M1 keybinds work; mouse sensitivity setting applies; spectate follows killer, then next alive player on click; emits typed bus events only (no direct render/ui/audio calls). | done |
| B8 | World rendering: terrain, water + foam, sky, fog, sun shadows, instanced props with outlines | graphics-engineer | A2, A4, A6, B1 | Terrain matches `heightAt` within 0.05 m at sampled points; props drawn with one InstancedMesh per kind (+ outline); <= 250 draw calls and <= 600k triangles in the busiest view; settings in `docs/tech/RENDERING.md`. | done |
| B9 | Entities + VFX + camera: animated chibis, held weapons, loot pickups, muzzle flash, hit VFX, tide wall | graphics-engineer | B8 | Chibis show idle/run/jump/fall poses and the correct variant; loot floats and spins; muzzle flash + hit VFX appear on fire/hit events; tide wall tracks the zone radius each frame; over-the-shoulder camera does not clip into terrain. | done |
| B10 | HUD: `src/ui/` | ui-ux-designer | A2, A5 | Every HUD element from M1 scope is present and driven by bus events; all text via `t()`; readable at 1280x720; hit marker and damage direction appear within one frame of the event. | done |
| B11 | Menus + settings: title/name, lobby, death, results, settings | ui-ux-designer | A2, A5 | Full flow works by keyboard and mouse; name is 1-16 chars, validated; lobby shows player count + countdown; results shows placement + kills; sensitivity and volume persist in localStorage. | done |
| B12 | Audio: `src/audio/` Web Audio engine + synthesized SFX | audio-designer | A2 | Every SFX in M1 scope plays on its bus event; each weapon sounds distinct; other players' shots use a PannerNode; AudioContext resumes on first user gesture; master volume setting applies; no audio files. | done |
| B13 | CI + e2e harness: Playwright config with headless WebGL flags, `.github/` workflow | build-engineer | A1 | CI runs typecheck, unit tests, and e2e on push; Chromium launches with SwiftShader WebGL and a trivial Three.js page renders non-black pixels in CI. | done |
| I1 | Walking skeleton: wire `src/main.ts` (stubs OK) | game-developer (pending A2 owner decision) | A2 + stubs of B4-B12 | Two tabs: both chibis visible walking on the island, HUD shell shows, a sound plays on jump. Done as early as possible; repeat as features land. | done |
| **Phase C: verify** | | | | | |
| C1 | Unit test gap pass + sim purity test | qa-tester | B1-B4 | Coverage of `src/shared/sim` >= 70% lines; a test fails if any file in `src/shared/sim` imports three, DOM, or audio code; a test fails if a weapon number literal appears outside balance.json. | done |
| C2 | Playwright smoke | qa-tester | I1, B5, B11, B13 | With fast balance override: title -> name -> lobby -> countdown -> in-game HUD visible -> canvas non-black -> results screen -> back to lobby, with zero console errors. Runs in CI under 3 min. | done |
| C3 | Manual acceptance pass against the DoD checklist; bugs in `docs/qa/` | qa-tester | C2 | Each DoD item marked pass/fail with steps; every fail has a bug with owner. | done |
| C4 | Code review | tech-lead | B1-B12 | No cross-ownership edits; no hard-coded gameplay numbers or player-facing strings; contracts respected; findings filed as tasks. | done |
| C5 | Performance pass | graphics-engineer | B9, I1 | Full 16-player match at 1080p holds >= 60 fps average and >= 45 fps 1% low on the reference laptop (see Open questions); results recorded in RENDERING.md. | done |
| C6 | Fix round | per bug owner | C3, C4, C5 | All P0/P1 bugs closed; C2 green. | done |
| **Phase D: tune** | | | | | |
| D1 | Playtest: 3 solo matches vs bots | playtester | C6 | Written feedback on movement, shooting, loot density, tide pacing, bot difficulty, match length. | done |
| D2 | Balance tuning | game-designer | D1 | Only balance.json changes; median match length 6-10 min (or the director's target); C2 still green. | done |

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Parallel integration**: 9 builders working against contracts at once; mismatches show up late. | High | `contracts.ts` + typed events land first (A2); stub-first rule; I1 walking skeleton is the spike and runs as soon as stubs exist, then again after each B task; tech-lead is the only one who changes contracts. |
| **Sim does not terminate a match** (bots stall, zone bug). | High | B3 headless 16-bot test runs in Vitest without a browser; it is the gate for B5. |
| **WebGL in headless CI**: Chromium headless may have no GPU, so the canvas is black or creation fails. | Medium | B13 proves SwiftShader (`--use-angle=swiftshader`, `--enable-unsafe-swiftshader`) early; smoke test checks game state through a debug hook and DOM, and only one loose "canvas not black" pixel check; renderer errors are surfaced as console errors so the test fails loudly. |
| **Netcode feel**: JSON at 20 Hz with no lag compensation; shots may feel unfair above ~80 ms ping. | Medium | Client prediction with the shared movement step; 100 ms interpolation buffer; `LATENCY_MS` test knob; immediate local muzzle flash and sound, server-confirmed hit marker. Lag compensation is planned for M2. Localhost is the M1 target, so this is a feel risk, not a blocker. |
| **Performance**: ~300 props + 16 chibis, each with outline hulls (doubles draw calls), plus shadows. Target 60 fps on a mid laptop. | High | InstancedMesh per prop kind for body and outline; chibi parts share materials; one directional shadow map (2048) whose frustum follows the player; pixel ratio capped at 1.5; tri and draw-call budgets in A6/B8; C5 measures on real hardware. Fallback cuts, in order: shadows on props only near the player, outlines off for distant props, fewer palms. |
| **M2a stance hitboxes + prediction**: three hitbox shapes, transition timer, and headroom must match on client and server; mispredicts look like rubber-banding. | High | One shared movement step owns stance (2a-C1, spike); prone capsule spec fixed in ADR 0004; C5 tests at 100 ms `LATENCY_MS`. |
| **M2a grenade determinism**: bounce physics with float error or stray `Math.random` diverges client arc from server. | High | Seeded World RNG only; same-seed unit test (2a-C3, spike); client arc is a visual guide, server position is truth; D2 greps for `Math.random` in sim. |
| **M2a scope overlay on low-end**: second FOV/first-person view plus overlay may drop frames. | Medium | Reuse the main camera (FOV change + hide local body), CSS/2D overlay, no extra render pass; C7 checks 60 fps scoped. |
| **M2a protocol change size**: new fields on every player plus grenades touch types, server, net client, sim, render, UI at once. | High | Single contract gate (2a-B1) owned by tech-lead; stub-first rule; delta encoding and a snapshot size budget in C6. |
| **M2a sniper feel without lag compensation**: one-shot headshots at range may feel unfair above ~80 ms. | Medium | Accepted for M2a (localhost target); lag compensation stays in M2. |
| **M2b MapData refactor**: the union touches ~15 files across sim, net, render, UI, levels, and tests, while M2a is still landing. | High | Phase B waits for 2a-D4; ADR 0005 lists every consumer and owner; island becomes `kind: 'island'` first with no behaviour change (D2 checks it). |
| **M2b bot navigation indoors**: walls, desk mazes, and climb routes break the M1 straight-line bots. | High | Nav grid/waypoints built from colliders, deterministic cached A* (2b-C3, spike); stuck detector; 30-match headless gate. |
| **M2b camera vs walls**: the third-person camera ends up inside or behind walls in small rooms and under desks. | Medium | Camera collision plus near-wall fade/cutaway (2b-C7); checked in every room. |
| **M2b draw calls**: hundreds of desks, chairs, monitors, and clutter. | High | InstancedMesh per prop kind (body + outline), merged static walls, clutter capped per desk; 2b-C6 measures against the existing budgets. Cuts in order: clutter, outlines on distant props, ducts. |
| **M2b map-switch netcode**: a client loads the wrong map or loads it too late for the drop. | Medium | Map id in welcome and match messages; client confirms the load before the drop; mid-lobby join test in 2b-C4/C5. |
| **M2b drop pacing vs zone timing**: the flight (plus late jumps and the chute) eats into phase 1, so players land with less time to loot, or late jumpers land outside the zone. | Medium | Route margins and carrier speed per map in balance.json; auto-eject before the carrier leaves the playable area; 2b-D3 measures the median with flight time on both maps and tunes the phase-1 wait. |
| **M2b CPU with many rooms on one process**: up to `MAX_ROOMS` (8) Worlds x 16 players and bots, each with a 30 Hz tick and A* bots, on one Node thread. | High | Measure tick cost per room early (C17 adds a tick-time metric); bots-only rooms with no humans close; cached nav; lower `MAX_ROOMS` if one tick budget (33 ms) is exceeded; worker threads per room deferred to M3. |
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
5. M2a: should C (crouch) and Z (prone) also get a hold/toggle setting like ADS, or stay toggle-only?
6. ~~After M2a, which M2 item comes first?~~ Answered: M2b (Office Map) comes next; lag compensation follows unless the director says otherwise.
