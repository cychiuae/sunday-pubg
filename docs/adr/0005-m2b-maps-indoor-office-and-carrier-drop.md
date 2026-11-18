# ADR 0005: M2b maps: the MapData union, indoor geometry, per-map balance, map switching and the carrier drop

- Status: Accepted
- Date: 2026-11-18
- Owner: tech-lead
- Related: [ARCHITECTURE.md](../tech/ARCHITECTURE.md) §15 (build contract), [ADR 0006](0006-m2b-rooms.md) (rooms, map
  vote location), [ADR 0004](0004-m2a-stance-ads-grenades-armor.md); specs [maps.md](../design/systems/maps.md),
  [drop.md](../design/systems/drop.md), [rooms.md](../design/systems/rooms.md), `docs/design/levels/office.md`
  (level-designer), STYLE.md §19 and `src/render/procedural/office.ts` (graphics-designer)

## Context
M2b adds a second map: the office at 9x scale, with walls, glass rooms, desk plateaus 6.7 m up and a crawlspace
under every desk. It also adds map switching between matches and a carrier drop that replaces the M1 spawn. The
M1 code assumes one island:
- `MapData` has only heightfield fields.
- Movement and grenades use a circular `worldRadius` wall.
- The renderer builds terrain and sea once in its constructor.
- `BALANCE` is one global value.
- The client only logs an error when `welcome.mapId` differs.

Contract code for this ADR:
- [`types.ts`](../../src/shared/types.ts) (map union, drop types)
- [`maps.ts`](../../src/shared/maps.ts) (shared map helpers)
- [`balance.ts`](../../src/shared/balance.ts) (`drop`, `maps`, `rooms`, `bots.drop`, `bots.nav`, deep merge)
- [`events.ts`](../../src/shared/events.ts) (`mapChanged`, drop events)
- [`contracts.ts`](../../src/shared/contracts.ts) (drop HUD, route view, zone theme)

## Decision

### 1. `MapData` is a discriminated union on `kind`, migrated behind a C-gate
- `AnyMapData = IslandMapData | IndoorMapData`.
  - `MapBase` holds what every map has: id, nameKey, playerSpawns, lootSpawns (with an optional support height
    `y`), zoneCenters, pois and `carrier`.
  - The island keeps its M1 fields unchanged.
  - Indoor maps add `floor: Rect`, `floorMaterial`, `floorZones`, `ceilingHeight`, `walls: WallSegment[]`,
    `props: IndoorPropPlacement[]`, `kit: PropKit` and `climbRoutes`.
- **Branch on `map.kind === 'indoor'`.** Everything else is the island. `isIndoor(map)` in `maps.ts` narrows.
- **Migration** (the C-gate was done on 2026-11-18; see REVIEW-M2b). Phase C agents were working, and M2a QA had to
  keep a green tree. So:
  - `MapData` is today an alias of `IslandMapData`, whose `kind` and `carrier` are optional for now.
  - Each owner switches their own signatures to `AnyMapData` and narrows; the compiler then lists every island-only
    read in that file.
  - The other M2b fields wait in **C-gate blocks** in `types.ts` and `contracts.ts`: `DropMovementFields`,
    `DropStepFields`, `PlayerDropFields`, `LocalDropFields`, `MatchMapFields`, `DropSimEvent`, `GlassSurface`,
    `IndoorSurface`. Producers may fill them already.
  - **At the C-gate** (when every owner reports their checklist done), tech-lead does the flip in one commit:
    - `MapData = AnyMapData`, with `kind` and `carrier` required.
    - The field blocks are merged into their targets, and become required.
    - `SimEvent` gets `| DropSimEvent`.
    - `ImpactSurface` and `GrenadeContactSurface` get `| 'glass'`.
    - `Surface` gets `| FloorMaterial`.
    - The optional M2b view fields (`CameraView.view/subjectId/roll`, `FrameView.viewmodel/reducedMotion`,
      `HudView.rooms/drop/zoneTheme/cameraView`) become required.
    - The first-person `clientFeel` keys (`CLIENT_FEEL_FP_KEYS`, `fpRecoil`) join `ClientFeelBalance`, together
      with game-developer's matching `ClientTuning` keys.
    - `PROTOCOL_VERSION` becomes 3.

    A trial flip on 2026-11-18 gave 83 errors in 23 files (§15 lists them per owner). The flip is what proves the
    migration complete.
- A `MapData` never goes on the wire. Both sides look it up by id (`getMap`), so it may carry the prop kit and large
  tables.

### 2. Indoor geometry: walls, floor, props, colliders and glass
- **Floor.** Flat at y = 0 over `floor`, with no water and no heightfield. The sim's terrain functions dispatch on
  `kind`:

  | Function | Indoor behaviour |
  |---|---|
  | `heightAt` | 0 |
  | `surfaceAt` | the `floorZones` material (later zones win), else `floorMaterial` |
  | `raycastTerrain` | ray vs the planes y = 0 and y = `ceilingHeight` |
  | `coastlineRadius` | island only; never called for indoor maps |

  Water rules then never trigger indoors, because depth is always 0 (ADR 0004 A1.1).
- **Walls.** Each `WallSegment` is one box prism, built with `wallFrame(w)` from `maps.ts`. Sim colliders, render
  meshes and the minimap all use that function. Doorways are gaps, and lintels are segments with `bottom > 0`.
- **Props.** An indoor `kind` is a key of `map.kit`. The kit is pure data with no three.js imports:
  - It lives in **`src/shared/kits/office.ts`** (`OFFICE_KIT: PropKit`), owned by graphics-designer.
  - It is moved out of the `OFFICE_PROP_INFO` collider and size tables in `src/render/procedural/office.ts`.
    `office.ts` then imports it, so the geometry and its colliders have one source.
  - The level module sets `kit: OFFICE_KIT` in its `IndoorMapData`.
  - **The sim never imports a kit.** It reads `map.kit`, so it stays data-driven.
- **Colliders.** `buildColliders(map, stepHeight)` (sim) turns every part into the existing prism colliders
  (box or circle footprint, flat top, bottom):
  - **Placement transform:** `T(x, y, z) · R_y(rotY) · S(scale)` applied to the kit part.
  - **Ramp:** a kit `ramp` becomes a stair of flat boxes with rises <= 0.8 x `movement.stepHeight`, because colliders
    stay vertical prisms. The renderer still draws the smooth ramp.
  - **Glass:** glass walls and kit parts with `glass: true` set `Collider.glass`.
  - **Spatial grid:** sized from `mapBounds(map)` (`maps.ts`), not `worldRadius`.
- **Glass in the sim is solid** (maps.md 2.5). It blocks movement, shots, grenades, blast line of sight and bot
  sight. `raycastStatic` reports a hit kind `'glass'`, so the shot impact and the grenade contact surface become
  `'glass'` (C-gate union). There is no shattering in M2b.
- **Bounds.**
  - Movement clamps the feet to `floor` inset by `player.radius`. The outer walls are colliders too.
  - Grenades bounce off the floor-rectangle edge (contact `'edge'`) and off the ceiling (normal -Y).
  - Shots stop at the ceiling.
- **Spawns on tops.** `LootSpawn.y` is a support-height hint. The sim places the item with
  `groundHeightAt(ctx, x, z, y)`, so plateau loot lands on the desk, not under it.
- **Validation.** `validateIndoorMap(map, stepHeight)` (`maps.ts`) checks the data: rectangles, wall numbers,
  material, kit keys, spawns inside the floor, unique route ids and climb rises <= 0.95 m. The level tests and the
  server startup run it. Collider-aware checks (spawns inside props, reachability, plateau gaps) are sim level tests.

### 3. Island-coupled call sites: each one branches (or goes through a helper) in Phase C
| # | File (owner) | Today | M2b |
|---|---|---|---|
| 1 | `sim/terrain.ts` (gd) | heightfield | dispatch on kind (§2) |
| 2 | `sim/colliders.ts` (gd) | grid from `worldRadius`, island prop shapes | `mapBounds`, walls, kit parts, ramps, glass |
| 3 | `sim/movement.ts` (gd) | circle boundary | indoor: floor rectangle; drop phases (§8) |
| 4 | `sim/grenade.ts` (gd) | circle edge | indoor: rectangle edge plus ceiling; glass contact |
| 5 | `sim/zone.ts` (gd) | land check `heightAt >= landCheckMinHeight` | indoor: inside `floor` inset by `zone.indoorCenterInset` |
| 6 | `sim/World.ts` (gd) | spawns at `playerSpawns` + `dropHeight` | carrier drop (§8); `MatchMapFields`; one World per match (ADR 0006) |
| 7 | `sim/loot.ts` (gd) | ground loot | `LootSpawn.y` |
| 8 | `sim/bots.ts` (gd) | open-terrain steering | indoor nav graph (§6); drop choice |
| 9 | `game/ClientGame.ts`, `camera.ts`, `derived.ts`, `tuning.ts` (gd) | one map | map switching (§5), carrier camera, floor surfaces |
| 10 | `render/Renderer.ts` (ge) | terrain + sea built once | scene per map on `mapChanged` |
| 11 | `render/TerrainMesh.ts`, `visualTerrain.ts`, `heightField.ts`, `Water.ts`, `TideWall.ts`, `Sky.ts` (ge) | island only | built only for island maps; indoor: `IndoorScene` + `RainCurtain` |
| 12 | `render/PropLayer.ts` (ge) | island kinds | island only; indoor kit instancing in `IndoorScene` |
| 13 | `render/cameraRig.ts` (ge) | terrain collision | floor/ceiling plus wall fade and cut-away |
| 14 | `render/LootLayer.ts`, `GrenadeLayer.ts`, `vfx/Vfx.ts` (ge) | `heightAt` for water | no change needed (`heightAt` = 0 indoors); `'glass'` impact |
| 15 | `ui/minimap.ts`, `Ui.ts`, `logic.ts` (ui) | coastline | indoor: walls, floor zones, plateaus from `map.kit`; route overlay |
| 16 | `server/app.ts`, `server/tools/measure-snapshot.ts` (ne) | `getMap(DEFAULT_MAP_ID)` | per-room, per-match maps (ADR 0006) |
| 17 | `game/levels/*` (ld), `testFixtures.ts`, `sim/testkit.ts` (gd) | island literal | `kind`, `carrier`, office level |

(gd = game-developer, ge = graphics-engineer, ui = ui-ux-designer, ne = network-engineer, ld = level-designer)

### 4. Per-map balance: `maps.<id>`, validation, deep merge and the per-match balance
- **Data.** `balance.json` `maps.<mapId>` holds `zoneTheme` (required, one of `tide | sprinklers | lightsOut`) plus
  override paths.
- **Merge.** `deepMergeBalance` merges objects key by key. Arrays and scalars replace wholesale, so `zone.phases` is
  a full array. `_` keys are skipped.
- **Validation** (`validateBalance`, at startup on both sides):
  - Every override path must exist in the base. The exceptions are the open id records in `OPEN_RECORD_PATHS`
    (`loot.tiers.*`, `bots.weaponPrefs`, `bots.personalities`).
  - A leaf must keep its JSON type.
  - Paths in `MAP_OVERRIDE_FORBIDDEN` are rejected: `net` (module constants such as `SIM_HZ`), `maps`, `rooms`,
    and the lobby-time keys `match.maxPlayers`, `match.minHumansToStart`, `match.countdownSeconds` and
    `match.mapVoteLockSeconds`.
  - **The merged balance of every entry must pass the full validation.** An override cannot break a cross-key
    rule.
- **Effective balance.** `balanceForMap(base, mapId)` is pure, has no `maps` block, and plays the base when the map
  has no entry. It is computed:
  - on the **server** once per match, when the room resolves the map; the World receives the merged balance;
  - on the **client** on every map change.

  Prediction, bots, zone and drop all read the merged values, so `fallDamageMinSpeed` 18 indoors is predicted
  exactly.
- **`BALANCE` stays the base.** Only composition roots import it. Everything per-match receives the effective
  balance:
  - the World through `createWorld`;
  - ClientGame through its own `balanceForMap`;
  - render, Ui and audio through the `mapChanged` event payload (§5).

  `constants.ts` reads only `net`, which cannot be overridden.
- **Theme.** `zoneThemeOf(base, mapId, kind)` returns the entry's theme. Until the `maps` block exists, it falls
  back to `tide` for island maps and `sprinklers` for indoor ones.
- New keys:
  - Required now: `drop` (game-designer added it).
  - Optional until the C-gate: `maps`, `rooms`, `bots.nav`, `match.mapVoteLockSeconds`, `zone.indoorCenterInset`.
    They are checked when present.
  - Optional: `bots.drop`, plus the personality keys `jumpTimingBiasMs` and `dropEpicWeightMultiplier`.

### 5. Map id plumbing and client map switching
- The map is resolved by the room at its lock (ADR 0006 §2). `WelcomeInfo.mapId` and `MatchState.mapId` carry it.
  The server env `MAP` pins every room, and `?map=<id>` pre-selects the client's vote (ADR 0006).
- **ClientGame owns the switch.** On a `welcome` whose `mapId` differs from the loaded one (and on the first
  welcome), ClientGame:
  1. calls `getMap` and `balanceForMap`;
  2. gets a fresh `MovementContext` from a per-map-id cache (colliders are about 2 ms to build indoors, so they are
     built once per map per session);
  3. resets prediction, the grenade tracker and the ADS blend;
  4. emits **`mapChanged { mapId, map, balance, zoneTheme }`** before the next `FrameView` is returned.
- **Renderer** rebuilds on `mapChanged` and disposes the old map's groups: island = terrain, sea, tide wall and
  island props; indoor = `IndoorScene` (floor, walls, kit instancing, ceiling clutter) plus `RainCurtain`.
  `FrameView` gains nothing. The renderer keeps the map it built and ignores a `mapChanged` for the same id.
  The welcome comes at the lock, about 3 s before the drop (ADR 0006), so the rebuild is hidden in the countdown.
- **Ui** rebuilds the minimap from `HudMinimapView.map` (it already gets the same object each frame) and reads
  `HudView.zoneTheme`. **Audio** switches ambience and zone loops on `mapChanged`.
- No main.ts change is needed, because the bus carries the switch. Map selection and loading need no new facade
  methods.

### 6. Bot navigation API (indoor maps only; the island keeps M1 steering)
In a new `src/shared/sim/nav.ts` (game-developer). It is pure and deterministic, with no RNG and no module-level
caches:
```ts
export type NavNodeId = number;
export interface NavGraph { readonly mapId: string; readonly nodeCount: number; readonly hash: string /* determinism tests */ }
export interface NavPath { points: Vec3[]; /** true where reaching points[i] needs a jump (rise > stepHeight) */ jump: boolean[]; length: number }
export function buildNavGraph(map: IndoorMapData, colliders: ColliderSet, b: Balance): NavGraph;
export function nearestNode(g: NavGraph, pos: Vec3): NavNodeId | -1;          // snaps to a reachable cell
export function findPath(g: NavGraph, from: Vec3, to: Vec3, cache: PathCache): NavPath | null; // A*, ties by node id
export class PathCache { constructor(size: number) }                           // LRU keyed (startCell, goalCell)
export function pathLength(g: NavGraph, from: Vec3, to: Vec3, cache: PathCache): number;        // zone urgency
```
- Grid cells of `bots.nav.cellSize` on the floor and on every walkable top. Climb links come from
  `map.climbRoutes`, and drop links from plateau edges, as in maps.md §4.
- **Caching across Worlds without sim globals.** `prepareMap(map, balance): MapRuntime` (sim) returns
  `{ map, balance, ctx, nav }`. The server keeps one per map id (in RoomManager) and passes it as
  `WorldOptions.runtime`. ClientGame keeps one per map id for its `MovementContext` and never builds `nav`.
- Each World owns its `PathCache` and a per-tick search budget of `bots.nav.maxPathsPerTick`. Searches over the
  budget wait a tick.
- **Extensions added by the bots agent in Phase C (accepted, 2026-11-18).** The API above is the core; these are
  part of the contract too:
  ```ts
  export class NavBudget { constructor(perTick: number); take(now: number): boolean }   // per-tick search budget, owned by a World
  export function requestPath(g, from, to, cache: PathCache, budget: NavBudget, now: number): NavPath | null | 'wait';
      // the budgeted findPath: cache hits are free; 'wait' = budget spent this tick, keep the old path. Bots use only this.
  export function startNode(g, pos: Vec3): NavNodeId | -1;   // the node a walker stands on (own cell, then a small snap)
  export function nodePos(g, id: NavNodeId): Vec3;
  export function plateauNodes(g): Int32Array;               // raised walkable nodes (plateau hold points, tests)
  export function isReachableNode(g, id: NavNodeId): boolean; // in the main connected component
  interface NavPath { points; jump; route: boolean[] /* climb-route waypoint: commit once on it */;
                      climbs: number /* climb-up links: bots do not chase up a route */; length }
  ```
  - `findPath` and `pathLength` stay unbudgeted, for tools and tests. **Bot code must call `requestPath`**, so the
    per-tick budget holds (REVIEW-M2b).
  - `navColliders` and `NavGraphData` are internal: tests and bots helpers only.

### 7. `zoneTheme` plumbing
`zoneThemeOf` → ClientGame → `mapChanged.zoneTheme` and `HudView.zoneTheme`.
- **Ui** picks `hud.<theme>.*`, `announcer.<theme>.*`, `hint.<theme>` and `feed.<theme>.*`. A missing key is a test
  failure (maps.md 18b).
- **Render** picks the tide wall or the rain curtain, and **audio** the tide loop or the sprinkler rain.
- The theme never reaches the sim.

### 8. The carrier drop (drop.md) replaces the M1 spawn
- **Route.** `DropRoute { mapId, entry, exit, eject, altitude, speed, startsAt, noJumpUntil, ejectAt, endsAt }` is
  drawn by the World from its seeded match RNG **when the World is created**, which is the room's lock (ADR 0006).
  It goes in `MatchState.route` and is sent with every snapshot, so late joiners get it.
  - The play area is the island circle of `islandRadius` or the indoor `floor`.
  - Everything else follows drop.md: support, entry margin, eject inset, window check and redraws.
  - Clients compute the carrier with `carrierPosAt(route, serverNow)` and `carrierHeading` (`maps.ts`); there is
    no per-tick carrier sync.
- **Carrier per map.** `MapBase.carrier` (`'seaplane' | 'drone'`) picks the model and the engine sound. Altitude,
  speed, margins and timings are `drop.*`, overridden per map in `maps.<id>.drop`.
- **Aboard** is World state on the player (`PlayerDropFields.aboard`, `LocalDropFields.aboard`,
  `MatchState.aboardCount`). Its position = the carrier's position. Aboard players are excluded from:
  - hitscan, blasts and zone damage;
  - every input except look and the jump edge.

  Aboard is **not** movement state, and it is not predicted: ClientGame draws the local player at the carrier.
- **Jump input: the existing `jump` edge.** Space is jump. The client also maps **F** to the `jump` edge while the
  predicted local state is aboard or dropping (F is unbound otherwise). **No new `PlayerInput` field**, so no
  protocol change for input. The jump counts on or after `noJumpUntil`, and everyone left is ejected at
  `ejectAt`.
  - The local jump **is predicted**: ClientGame starts freefall at the carrier's predicted position on the press.
  - The server applies the jump on the tick it processes the input, so the start point differs by about
    RTT/2 x speed, under 1 m at 100 ms RTT. Normal reconciliation smooths it.
- **Freefall and parachute extend `dropping`.**
  - `DropMovementFields { dropPhase: 'freefall' | 'chute' | null; dropMs }`.
  - The step owns the phase rules:
    - Freefall uses `drop.freefallSpeed` and `drop.freefallSteerSpeed`.
    - It auto-deploys at `drop.chuteDeployHeight` above `heightAt` (props ignored).
    - Manual deploy is the jump edge at `dropMs >= drop.minFreefallMs` when `drop.manualDeploy`.
    - The chute uses `movement.dropFallSpeed` and `movement.dropSteerSpeed`.
    - Landing never deals fall damage.
  - The step reports `chuteOpened` (`DropStepFields`). The World emits `chuteOpen`, and ClientGame emits the local
    event from prediction.
- **Events.** SimEvents `dropJump { playerId, pos, auto }` and `chuteOpen { playerId, pos, manual }`, both public.
  They become GameEvents `playerJumped` and `parachuteOpened`. `carrierDeparted` is client-derived when
  `serverNow >= route.startsAt`.
- **Camera aboard.** CameraView `mode: 'follow'`, `firstPerson: false`, `view: 'carrier'`. `target` = the carrier,
  mouse look is free, and `distance` = `clientFeel.carrierCameraDistance`. The renderer draws the carrier and hides
  aboard characters. Freefall and the chute are first person (§9).
- **HUD.** `HudView.drop: HudDropView` (aboard countdowns, aboard count, altitude, deploy height, `canDeploy`) and
  `HudMinimapView.route` (dashed line, eject marker, carrier icon).
- **Bots** pick a target and a jump time at World creation (drop.md "Bots: jump choice", seeded, in id order). They
  steer to the target and deploy by the reach rule.
- **`playerSpawns` stay as level data** (fallback and test placement, nav reachability tests). `match.dropHeight`
  and `match.spawnJitter` are used only by a drop-less test World (`WorldOptions.drop: false`). They become optional
  at the C-gate.

### 9. First-person camera (brief Addendum 3, [camera.md](../design/systems/camera.md), UI.md §13, STYLE.md §21)
- **No new camera mode.** The M2a `CameraView` already has a first-person path: `mode: 'follow'` with
  `firstPerson: true` puts the camera exactly at `target`, uses `fovDeg` and hides the local body. M2b uses it for
  every FP case. A descriptive `CameraView.view: CameraCase` says which case it is: `firstPerson`, `carrier`,
  `chase` (V spectate), `death`, `results` or `title`. The renderer uses it to pick its behaviour:
  - boom collision and wall fade only in the 3P cases;
  - carrier drawing;
  - hiding `subjectId`'s body in FP.

  This replaces the C-gate `'carrier'` mode widening.
- **Camera math stays in `src/game/camera.ts`** (ADR 0004 §5):
  - Eye = sim `eyePoint` (stance-lerped), plus bob and landing dip, capped at `clientFeel.fpMaxCameraOffset` and 0
    at full ADS.
  - The rotation is exactly the look yaw and pitch.
  - Recoil roll goes in `CameraView.roll`, and the FOV punch is folded into `fovDeg`.
  - The ADS FOV is true magnification from the **default** FOV: `vFovAds = 2 atan(tan(vFovDefault / 2) /
    adsZoom)`, blended by `cameraBlend`. This replaces the M2a `fov / adsZoom` formula and `AdsView.zoom`'s
    definition. `AdsView.zoom` becomes `tan(vFovPlayer / 2) / tan(vFovCurrent / 2)`, the look-speed divisor.
  - The renderer adds nothing in FP: no boom and no clipping avoidance.
- **Viewmodel state** is `FrameView.viewmodel: ViewmodelView`, built by ClientGame. It is plain data:
  - the item (the held item, or the heal item while healing), `cooking`, `action` and `actionProgress`;
  - `adsBlend`, `visible` (false under the scope overlay), and `shotCount` (a recoil impulse counter);
  - stance and progress, `dropPhase`, `bobPhase` and `bobAmount`, `lookRate` (sway), and `motionScale`
    (reduced motion);
  - appearance and `vestTier`.

  The graphics-engineer renders it in a second pass at `clientFeel.viewmodelFovDeg` with
  `src/render/procedural/viewmodel.ts` poses. Recoil numbers are `clientFeel.fpRecoil.<gun>` (validated now).
  FP spectating builds the same view from the target's interpolated state.
- **Settings:**
  - `Settings.fovDeg` is the **horizontal FOV at 16:9**, converted once to a vertical FOV (Hor+).
  - `Settings.headBob` and `Settings.reducedMotion` are effective values that Ui resolves from its prefs.
  - The FOV range and default are **settings constants** in `contracts.ts` (`FP_FOV_MIN_DEG` 70, `FP_FOV_MAX_DEG` 100,
    `DEFAULT_FP_FOV_DEG` 80, `FP_FOV_REFERENCE_ASPECT` 16/9), like the mouse-sensitivity range.

  The duplicate `clientFeel.fpFovDefault/Min/Max/ReferenceAspect` keys should be deleted from balance.json
  (game-designer). `FrameView.reducedMotion` tells the renderer to drop camera shake.
- **Prone pitch is a sim rule.**
  - `movement.stances.pronePitchMinDeg/MaxDeg` (-30 / +45; validated as a pair within ±80) clamp the sim pitch while
    prone or in a prone transition.
  - World sanitize, the client look clamp (prediction) and bots all use one sim helper,
    `pitchLimits(m, b): { min, max }` in `stance.ts`.
  - Render's `PRONE_PITCH_MIN/MAX` read these keys.
- **Obsolete:** `clientFeel.adsCameraDistance` and `adsCameraShoulderOffset`. They are deleted once the code stops
  reading them.
- Recoil stays **visual only**. The sim spread is unchanged (camera.md decision), so the sim needs no new state.

## Consequences
- First person removes the over-shoulder ray offset noted in §6 of ARCHITECTURE. The screen centre is the shot ray,
  up to 6 cm of bob.
- Fifteen-odd island call sites branch once, mostly through four helpers: `isIndoor`, `mapBounds`, `wallFrame` and
  the kind dispatch in `terrain.ts`. The compiler finds the rest after the flip.
- The per-match balance flows by value. No module keeps a stale global, as long as render and audio stop falling
  back to `BALANCE` (REVIEW-M2a M5).
- Glass is a render property only. "Bullets pass, glass shatters" would need a breakable-collider set in the sim
  and is deferred.
- The office collider count (~several hundred prisms plus wall segments) raises the cost of raycasts. The REVIEW-M2a
  M2 and M3 limits (arc preview, bot throw solve) must be measured on the office.
- Aboard players have no movement prediction, and the jump start is corrected by under 1 m.

## Alternatives considered
- **A generic "map provides height, surface and bounds" interface object instead of a union.** Rejected for now.
  Two kinds with very different render paths read more clearly as a union. The helpers in `maps.ts` give the shared
  questions one implementation.
- **Ramps as sloped colliders.** Rejected. It would change push-out and platform logic for every collider. Stairs
  of prisms walk the same at 0.8 x `stepHeight` rises.
- **Kit tables stay in `render/procedural/office.ts`.** Rejected. The sim and the server may not import three.js
  modules, and a copy would drift.
- **A new `jumpPlane` input edge (the director's first sketch).** Rejected in favour of the designer's rule: reuse
  `jump`, with F mapped by the client. No input field, no protocol change. The ground jump and the carrier jump can
  never be pressed in the same state, so the edge is never ambiguous.
- **Rebuilding the renderer from main.ts on a new facade method.** Rejected. The bus already carries discrete
  moments to render, Ui and audio together, and ClientGame is the one place that knows when the map changes.
- **One persistent World per room with `setMap`.** Rejected in ADR 0006 (a new World per match).
