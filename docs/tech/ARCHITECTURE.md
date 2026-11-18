# Architecture (M1 "First Playable")

Owner: tech-lead. Decisions: [ADR 0001 stack and netcode](../adr/0001-stack-and-netcode.md),
[ADR 0002 M1 netcode and boundary clarifications](../adr/0002-m1-netcode-and-boundary-clarifications.md),
[ADR 0003 low-health signal, typed bot tuning, graphics status](../adr/0003-low-health-signal-and-typed-bot-tuning.md).
Latest review: [REVIEW-M1.md](REVIEW-M1.md).
Contracts in code (the source of truth when this doc and the code disagree):
[`src/shared/types.ts`](../../src/shared/types.ts), [`src/shared/events.ts`](../../src/shared/events.ts),
[`src/shared/contracts.ts`](../../src/shared/contracts.ts), [`src/shared/balance.ts`](../../src/shared/balance.ts),
[`src/shared/constants.ts`](../../src/shared/constants.ts), [`src/shared/math.ts`](../../src/shared/math.ts),
[`src/main.ts`](../../src/main.ts).

## 1. Overview

```
 Browser (Vite, :5173)                                       Node server (tsx, :8797)
 ┌────────────────────────────────────────────────┐          ┌─────────────────────────────────┐
 │ main.ts (composition root, rAF loop)           │          │ server/index.ts  http + ws      │
 │  ClientGame ── input, prediction, spectate ────┼─ input ─▶│ server/Room.ts   30 Hz tick     │
 │     │  ▲        (shared/sim/movement)          │  30 Hz   │   validate → World.applyInput   │
 │     │  └── NetClient (snapshot buffer, clock) ◀┼─ snap ───│   World.step → SimEvent[]       │
 │     │                                          │  20 Hz   │   World.snapshotFor(id)         │
 │     ├─ FrameView ─▶ Renderer (Three.js)        │◀ events ─│ src/shared/sim/World (pure)     │
 │     ├─ HudView ───▶ Ui (DOM)                   │  30 Hz   └─────────────────────────────────┘
 │     └─ EventBus<GameEvents> ─▶ Renderer/Ui/Audio│
 └────────────────────────────────────────────────┘
```

- **Authoritative server.** The server runs the only real simulation (`src/shared/sim/World`). Clients send
  intent (inputs) and render what the server says.
- **Client prediction only for local movement.** The client runs the same pure `stepMovement` on its own inputs and
  reconciles against the server. Combat, inventory, loot, zone and match state are never predicted in M1.
- **Remote entities are interpolated** 100 ms in the past between snapshots.
- **Units:** metres, Y up, sea level y = 0. Yaw 0 looks toward -Z; forward = (-sin yaw, 0, -cos yaw); pitch > 0 is up.
  `dt` is seconds; `...Ms` is milliseconds; `serverTime` / `...At` are server-clock ms.

| Rate | Value | Source |
|---|---|---|
| Server sim tick | 30 Hz (`SIM_DT` = 1/30 s) | `balance.net.simHz` → `SIM_HZ` |
| Snapshots to each client | 20 Hz (2 of every 3 ticks) | `balance.net.snapshotHz` → `SNAPSHOT_HZ` |
| Client input send | 30 Hz, one input per local fixed step | `balance.net.inputHz` → `INPUT_HZ` |
| Remote interpolation delay | 100 ms | `balance.net.interpolationDelayMs` → `INTERP_DELAY_MS` |
| Sim events | sent on the tick they happen | server |

## 2. Folder layout and ownership

| Path | Owner | Contents |
|---|---|---|
| `src/main.ts` | tech-lead | Client composition root and rAF loop |
| `src/shared/*.ts` | tech-lead | `types`, `events`, `contracts`, `balance`, `constants`, `math` |
| `src/shared/sim/` | game-developer | Pure deterministic sim: terrain, colliders, movement, combat, inventory, loot, zone, match, bots, `World` |
| `src/shared/protocol/` | network-engineer | Wire message types, encode/decode, validation |
| `server/` | network-engineer | ws server, static `dist/` in production, room, tick loop |
| `src/net/` | network-engineer | `NetClient`: socket, clock sync, snapshot buffer, interpolation |
| `src/game/` (except `levels/`) | game-developer | `ClientGame`: input capture, prediction/reconciliation, camera yaw/pitch, spectate, view building, server→bus translation |
| `src/game/levels/` | level-designer | Map data + `getMap(id)`, `DEFAULT_MAP_ID` |
| `src/render/` (except `procedural/`) | graphics-engineer | `Renderer`, scene, terrain mesh, water, sky, entity views, animation, VFX, camera |
| `src/render/procedural/` | graphics-designer | Model factories (characters, props, weapons, loot), toon materials |
| `src/ui/` | ui-ux-designer | DOM/CSS HUD and menus, settings persistence |
| `src/audio/` | audio-designer | Web Audio engine, synthesized SFX |
| `src/content/strings/` | narrative-designer | `en.json`, `t()`, `tIndex()`, `keysWithPrefix()` |
| `docs/design/balance.json` | game-designer | All gameplay numbers (typed and validated by `src/shared/balance.ts`) |
| root config, `scripts/`, `.github/` | build-engineer | Tooling |
| `tests/` | qa-tester | E2E and cross-module tests |

## 3. Dependency rules

An arrow means "may import". Anything not listed is forbidden. `type`-only imports follow the same rules.

| Module | May import |
|---|---|
| `src/shared/*.ts` | `src/shared/*.ts`, `docs/design/balance.json` |
| `src/shared/sim/` | `src/shared/*.ts`, `src/shared/sim/`. **Never** DOM, `three`, audio, `src/net`, `src/game`, `server`. No `Math.random`, `Date.now`, `performance.now` (use `Rng` from `math.ts` and world time). |
| `src/shared/protocol/` | `src/shared/*.ts` (types only) |
| `server/` | `src/shared/**`, `src/game/levels/`, `src/content/strings/`, `ws`, node built-ins |
| `src/net/` | `src/shared/**` (including `protocol/`) |
| `src/game/` | `src/shared/**` (not `protocol/`), `src/game/**`. It sees the network only through `INetClient`. |
| `src/render/` | `src/shared/*.ts`, `src/shared/sim/terrain.ts`, `src/shared/sim/colliders.ts` (read-only constants; ADR 0002), `src/render/**`, `three` |
| `src/ui/` | `src/shared/*.ts`, `src/shared/sim/terrain.ts`, `src/content/strings/`, `src/ui/**` |
| `src/audio/` | `src/shared/*.ts`, `src/audio/**` |
| `src/main.ts` | everything (composition root) |

Test files (`*.test.ts`), `src/shared/sim/testkit.ts` and dev tools in `src/shared/sim/tools/` may also import
`src/game/levels/` (pure map data). Tools are exempt from the determinism rule, and no sim module imports them
(ADR 0002 §6).

Render, UI and audio **never import each other, `src/game`, or `src/net`**. They get continuous state from
`FrameView` / `HudView` each frame, and discrete moments from the event bus. build-engineer: please enforce this
table with ESLint `no-restricted-imports` overrides per folder.

## 4. Shared simulation API (game-developer delivers; server and ClientGame call)

All functions are pure or operate only on the `World` they belong to. Deterministic for a given seed and input
sequence.

### `src/shared/sim/terrain.ts`
```ts
export function heightAt(x: number, z: number, map: MapData): number;      // terrain y; < 0 in the sea
export function surfaceAt(x: number, z: number, map: MapData): Surface;    // 'water' if heightAt < 0, sand band, grass inland
export function coastlineRadius(angle: number, map: MapData): number;      // distance from origin where y = 0 at atan2 angle (minimap)
```
Cheap and allocation-free: the renderer calls `heightAt` per terrain vertex, movement calls it every step.

### `src/shared/sim/movement.ts`
```ts
export interface MovementContext { /* sim-owned: map, balance, prebuilt colliders */ }
export function createMovementContext(map: MapData, balance: Balance): MovementContext;
export function toMovementInput(input: PlayerInput, status: { alive: boolean; healing: boolean; reloading: boolean },
                                balance: Balance): MovementInput;
export function stepMovement(state: MovementState, input: MovementInput, dt: number,
                             ctx: MovementContext): MovementStepResult;
```
`stepMovement` must not mutate its arguments and must not read anything outside them. It covers walk, sprint,
air control, jump, gravity, terminal velocity, step-up, prop collision, water slow-down, drop phase
(`dropping` uses `movement.dropFallSpeed` / `dropSteerSpeed`) and the `worldRadius` boundary. Fall damage is
computed by the World from `landingSpeed`, not inside `stepMovement`.

### `src/shared/sim/combat.ts` (used by ClientGame for the crosshair)
```ts
export function effectiveSpreadDeg(weapon: WeaponId, balance: Balance,
                                   status: { horizontalSpeed: number; airborne: boolean }): number;
```

### `src/shared/sim/World.ts`
```ts
export interface WorldOptions { map: MapData; balance: Balance; seed: number; botNames: readonly string[] }
export function createWorld(opts: WorldOptions): World;
export interface World {
  readonly tick: number;
  readonly timeMs: number;                    // server clock: tick * SIM_DT * 1000
  readonly map: MapData;
  addPlayer(name: string): PlayerId | null;   // human; null when match.maxPlayers humans already connected
  removePlayer(id: PlayerId): void;           // disconnect; a live participant is removed without a kill event
  applyInput(id: PlayerId, input: PlayerInput): void;  // enqueue; ignored for unknown/dead/non-participant ids
  step(dt: number): SimEvent[];               // server always passes SIM_DT
  snapshotFor(viewerId: PlayerId | null): WorldSnapshot;
  getMatch(): MatchState;
}
```
- Input queue per player, capped at `MAX_QUEUED_INPUTS` (drop oldest). Each `step` consumes **one** queued input per
  human. If the queue is empty it repeats the last input's held fields (move, yaw, pitch, sprint, fire) with all edge
  fields false and `lastProcessedInputSeq` unchanged, for at most `MAX_INPUT_REPEAT_TICKS` consecutive ticks. After
  that it uses neutral held fields (no move, sprint or fire) and keeps yaw and pitch (ADR 0002 §4).
- The sim keeps each player's previous `fire` value to detect trigger edges for non-`automatic` weapons.
- Bots are created and driven inside the World (they produce `PlayerInput`s through the same path). Bot names come
  from `botNames` (server passes `keysWithPrefix('bot.name').map(k => t(k))`).
- The World assigns `Appearance` (seeded) and all ids.

### Match lifecycle (inside World)
1. **lobby**: humans added by `addPlayer` are queued (`lobbyCount`). When `lobbyCount >= match.minHumansToStart` →
   countdown.
2. **countdown**: `phaseEndsAt = now + match.countdownSeconds`. If queued humans drop below the minimum → lobby.
3. **playing**: at countdown end, spawn queued humans and fill with bots up to `match.targetPlayers`, at shuffled
   `playerSpawns` + `match.spawnJitter`, `match.dropHeight` above terrain (`dropping = true`). Emit `spawn` per
   player. Zone phase 0 wait starts. Loot is spawned at lobby→countdown or at start (game-developer's choice).
4. **results**: when alive participants <= 1, or `match.endWhenNoHumansAlive` and no human is alive (after
   `match.lastHumanDeathDelaySeconds`). Emit `matchEnded` with standings. `phaseEndsAt = now + match.resultsSeconds`.
5. Back to **lobby**: bots and loot removed, `matchId++`, every connected human is re-queued automatically.

Humans joining during countdown are queued into that match; during playing/results they are queued for the next
match and spectate meanwhile (`snapshot.local = null`).

## 5. Server (network-engineer)

```
server/index.ts   http server on PORT (default 8797); production: serves dist/; ws upgrade on WS_PATH ('/ws')
server/Room.ts    owns the World and the tick loop
```
Tick loop (fixed-step accumulator on `performance.now()`, at most 4 catch-up ticks, then drop time):
1. Apply queued, already-validated client inputs: `world.applyInput(id, input)`.
2. `events = world.step(SIM_DT)`; if non-empty broadcast `events`. **Private events** go only to their own player:
   `privateEventRecipient(ev)` (protocol/messages.ts) returns the recipient for `actionFailed` (an opponent's empty
   mag or heal stock must not leak) and `null` for every other (public) event. `server/Room.ts` sends each private
   event only on that player's connection and broadcasts the rest. A new private SimEvent type needs a case there.
3. On snapshot ticks (when `floor(tick * SNAPSHOT_HZ / SIM_HZ)` increments) send each connection
   `world.snapshotFor(conn.playerId)`; omit `loot` when that connection already has `lootVersion`.

Server "now" for `welcome` and `pong` = `world.timeMs + (performance.now() - lastTickWallMs)`.

### Protocol (`src/shared/protocol/messages.ts`, JSON text frames, one message per frame)
```ts
// client -> server
{ t: 'join';  name: string; protocolVersion: number }       // first and only once per socket
{ t: 'input'; input: PlayerInput }
{ t: 'ping';  clientTime: number }                           // every PING_INTERVAL_MS
// server -> client
{ t: 'welcome';  welcome: WelcomeInfo }
{ t: 'snapshot'; snap: Omit<WorldSnapshot, 'loot'> & { loot?: LootState[] } }
{ t: 'events';   tick: number; serverTime: number; events: SimEvent[] }
{ t: 'pong';     clientTime: number; serverTime: number }
{ t: 'error';    code: 'bad_version' | 'bad_name' | 'full' | 'bad_message'; message?: string }  // then close
```
Exports: `ClientMessage`, `ServerMessage`, `encode(msg): string`, `decodeClientMessage(raw: unknown): ClientMessage | null`,
`decodeServerMessage(raw: unknown): ServerMessage | null` (never throw).

### Validation at the network edge (never trust the client)
- Frames > 4 KB, non-JSON, or unknown `t`: drop; more than 5 bad frames in 1 s → `error bad_message` and close.
- `join`: `protocolVersion === PROTOCOL_VERSION`; name trimmed, control chars stripped, 1..`MAX_NAME_LENGTH` chars.
  Messages before `join` other than `ping` are dropped.
- `input`: every number finite; `seq` integer and greater than the last accepted seq; `moveForward/moveRight` clamped
  to [-1, 1] and their vector length to 1; `pitch` clamped to [`PITCH_MIN`, `PITCH_MAX`]; `dt` clamped to
  [0, `SIM_DT`]; booleans coerced; `selectSlot` in {-1, 0, 1, 2}. More than `2 * INPUT_HZ` inputs per second → drop
  extras.
- Socket close → `world.removePlayer(id)`. A handler error must be caught and logged, never crash the room.

## 6. Client netcode

### Clock sync (NetClient)
Ping every `PING_INTERVAL_MS`. `rtt = now - clientTime`; offset sample = `serverTime + rtt/2 - now`. Use the sample
with the lowest RTT among the last 5. `serverNow() = performance.now() + offset`.

### Local prediction and reconciliation (ClientGame)
- Fixed-step accumulator at `SIM_DT`, capped at `MAX_STEPS_PER_FRAME`. Each step, while `phase === 'playing'` and the
  local player is alive: build a `PlayerInput` (`seq++`, `dt = SIM_DT`, latched edge buttons), `net.sendInput`, push
  it to `pending`, then `stepMovement(pred, toMovementInput(input, status), SIM_DT, ctx)`. `status` comes from the
  latest `snapshot.local` (`healRemainingMs > 0`, `reloadRemainingMs > 0`).
- On each snapshot with `local`: drop `pending` with `seq <= lastProcessedInputSeq`, set `pred = local.movement`,
  replay the remaining pending inputs. If the new prediction differs from the old by more than 3 m, snap; otherwise
  add the difference to a visual offset that decays exponentially (about 100 ms).
- Rendered local position = lerp(previous step, current step, accumulator / SIM_DT) + visual offset. Rendered yaw and
  pitch are the latest mouse values (not tick-quantised).
- Not predicted in M1: firing, damage, reload, heal, pickup, weapon switch. Their feedback comes from server events
  (about 1 RTT late; fine on LAN). Exception: `dryFire` is emitted locally.

### Remote interpolation (NetClient)
`renderTime = net.serverNow() - INTERP_DELAY_MS`. Keep about 1 s of snapshots. Find the two snapshots bracketing
`renderTime` and lerp positions (`lerpAngle` for yaw/pitch); take discrete fields from the newer one. Clamp to the
newest snapshot; no extrapolation (confirmed in ADR 0002 §2).

### Fire input
`fire` is a held field. There is no `firePressed` edge on the wire in M1 (ADR 0002 §1). InputState guarantees that a
click shorter than one tick produces at least one `fire = true` input, and that a re-press within one tick gets a
one-tick gap. `firePressed` exists only client-side, for `dryFire`.

### Hitscan (server, no lag compensation in M1)
On a fire tick, rays start at the eye (`pos + (0, player.eyeHeight, 0)`) along `aimDirection(yaw, pitch)` plus seeded
spread (`effectiveSpreadDeg`), one ray per pellet, up to `range`. Targets are vertical cylinders (`player.radius`,
`player.height`), head = top `player.headZoneFraction`. Rays stop at prop colliders and terrain. Targets are at their
**current** server positions, so players must lead by about `INTERP_DELAY_MS + RTT/2`. The over-the-shoulder camera ray is
parallel to the eye ray, offset by `shoulderOffset` (under 0.6 m), which is acceptable for M1.

## 7. Event flow

```
World.step ─SimEvent[]─▶ ws 'events' ─▶ NetClient.onEvents ─▶ ClientGame queue ─┐
snapshots ─────────────▶ ws 'snapshot' ─▶ NetClient buffer ─▶ ClientGame ───────┤ (in update())
                                                                                ▼
                            EventBus<GameEvents>  (ClientGame is the only emitter)
                              ├─▶ Renderer (VFX)   ├─▶ Ui (feed, markers, screens)   └─▶ AudioEngine (SFX)
```
- **Events are for discrete moments; views are for state.** HP, ammo, timers and positions are read from
  `HudView`/`FrameView` every frame and never carried by events.
- NetClient handlers fire from socket callbacks. ClientGame only queues them and processes the queue at the start of
  `update()`, so bus events are emitted at a predictable point in the frame.

| SimEvent (server) | GameEvent (client bus) |
|---|---|
| `spawn` (local id) | `localPlayerSpawned` (others ignored) |
| `shot` | `shotFired` |
| `damage` | `playerDamaged`; plus `localHitConfirmed` when the attacker is local (`killed = hpAfter <= 0`) |
| `kill` | `playerKilled` (names from the latest snapshot) |
| `pickup` | `itemPickedUp` |
| `reloadStart` / `reloadEnd` | `reloadStarted` / `reloadFinished` |
| `healStart` / `healEnd` | `healStarted` / `healFinished` (completed) or `healCancelled` |
| `weaponSwitch` | `weaponSwitched` |
| `matchEnded` | `matchEnded` (local placement/kills from standings) |
| `actionFailed` (Contract revision 1; the server sends it only to its own player, §5) | `actionFailed` (local player only, not for `fire`) |

Client-derived (ClientGame): `matchPhaseChanged`, `countdown` (from snapshots); `zoneChanged`, `zoneWarning`,
`localZoneStatusChanged` (zone + predicted position); `footstep`, `jump`, `land` (local from `MovementStepResult`,
remotes from `anim.airborne`/position deltas of interpolated states); `dryFire`; `interactPromptChanged` (nearest
loot within `player.pickupRange` of the predicted position); `spectateTargetChanged`; `connectionStatus`. Events
without a server position (reload, heal) get the player's current view position.

## 8. Client frame loop (`src/main.ts`)

```
dt = clamp((now - last) / 1000, 0, 0.1)
{frame, hud} = game.update(dt)
    1. drain queued net messages: reconcile, emit translated + derived bus events
    2. local fixed steps: sample input → send → predict (0..MAX_STEPS_PER_FRAME)
    3. remotes = net.getInterpolated(net.serverNow() - INTERP_DELAY_MS)
    4. camera yaw/pitch, spectate target, interact prompt, footsteps
    5. build FrameView + HudView
renderer.render(frame, dt)
if renderer.getGraphicsStatus() changed: ui.setGraphicsStatus(status)   (ADR 0003 §5)
audio.setListener(renderer.getListenerPose()); audio.update(dt)
ui.update(hud)
```
Startup: `main.ts` builds the Renderer with `getMap(DEFAULT_MAP_ID)` so the island shows behind the title screen
(camera `mode: 'orbit'`). M1 has one map; if `welcome.mapId` differs, ClientGame logs an error.

Input: keyboard on `window`, mouse on `renderer.canvas` with pointer lock. Clicking the canvas during `playing`
requests pointer lock. The UI root has `pointer-events: none`; only interactive panels enable pointer events. Esc releases the lock
(browser) → `hud.pointerLocked = false` → UI shows the Resume/Settings overlay → `onResume` → `game.requestPointerLock()`.
Keys: WASD, Shift, Space (jump, or next spectate target while spectating), E, R, Q, 1/2/3, LMB.

## 9. Balance keys the code requires

`src/shared/balance.ts` defines `Balance` and `validateBalance()`. It runs at startup on client and server, and it
throws with a list of every missing or mistyped key. The current `docs/design/balance.json` passes. Required paths:

- `match.{targetPlayers, minHumansToStart, countdownSeconds, resultsSeconds, dropHeight, maxPlayers, spawnJitter, killCreditWindowSeconds, deathScreenSeconds, endWhenNoHumansAlive(bool), lastHumanDeathDelaySeconds}`
- `player.{maxHp, maxArmor, radius, height, eyeHeight, pickupRange, headZoneFraction}`
- `movement.{walkSpeed, sprintSpeed, airControl, jumpVelocity, gravity, accel, friction, waterSpeedMultiplier, waterDepthThreshold, fallDamageMinSpeed, fallDamagePerMs, terminalVelocity, stepHeight, healMoveMultiplier, dropFallSpeed, dropSteerSpeed}`
- `combat.{swapMs, airSpreadMultiplier, moveSpreadSpeedThreshold, deathDropScatter}`
- `weapons.<fists|pistol|smg|shotgun|rifle>.{damage, headshotMultiplier, fireIntervalMs, magSize, reloadMs, ammo (AmmoId, null for fists), range, spreadDeg, pellets, automatic(bool), falloffStart, falloffEnd, minDamageFactor, moveSpreadMultiplier}`
- `items.<bandage|medkit>.{heal, healCap, useMs, maxStack, spawnQty}`, `items.<ammo_light|ammo_heavy|ammo_shell>.{pickupQty, maxCarry}`, `items.vest.armor`
- `armor.absorbFraction`
- `loot.tiers.<common|rare|epic>` (ItemId → weight), `loot.{extraAmmoWithWeapon, spawnChance, weaponSpawnsWithFullMag(bool), extraAmmoScatter, pickupBobHeight}`
- `zone.{damageTickMs, startRadius, ignoresArmor(bool), landCheckMinHeight, landCheckMaxTries, finalCollapseDelaySeconds, finalCollapseSeconds, finalCollapseDps, warningSecondsBeforeShrink}`, `zone.phases[].{waitSeconds, shrinkSeconds, radiusFraction, dps}`
- `bots.{reactionMs, aimErrorDeg, aimErrorDegMoving, aimSettleMs, aimSettleFactor, visionRange, fovDeg, hearingRange, fireBurstMs, burstPauseMs, lootSearchRadius, decisionIntervalMs, loseTargetMs, strafeChangeMs, healBelowHp, zoneSafetyMargin}`
- `net.{simHz, snapshotHz, inputHz, interpolationDelayMs}`

Optional (Contract revision 1/1b; validated only when present, each must be a finite number):
`clientFeel.*` (`ClientFeelBalance`), `bots.ai.*` (`BotAiBalance`, including the `lootScore*`, `gunUpgradeFactor`,
`lootDistanceFalloff` loot scores), `items.medkit.preferAtOrBelowHp`, `player.lowHpThreshold`, and the bot pacing
keys `bots.{lootPhaseSeconds, lootPhaseEngageRange, avoidRange, dropSpreadRange, eagernessRampSeconds,
eagernessFullAtPhase, eagernessCurve, fireRangeFalloffFraction, minEngageRange, disengageRangeFactor, retaliateMs,
focusPenalty, targetBiasSpread, healBeforeFightBelowHp, retreatMs, holdWanderRadius, holdPauseMs, roamEagerness,
zoneEntryFraction, zoneEntrySpread}` and `bots.personalities.<aggressive|balanced|cautious>.{share,
engageRangeMultiplier, lootPhaseMultiplier, reactionMultiplier, retreatBelowHp}` (`BotPacingBalance`). An unknown
personality name is an error; `_`-prefixed keys are comments.

Units: ms unless the key ends in `Seconds`; angles in degrees. Code receives `Balance` by injection; only
`src/main.ts` and `server/index.ts` (server config) import `BALANCE`. Interim exception (ADR 0003 §2): `AudioEngine`
and `Renderer` keep a `BALANCE` fallback until their owners remove it; main.ts already injects both.

## 10. Coding standards

- TypeScript strict. No `any` (use `unknown` + narrowing at edges). Named exports only.
- Relative, extensionless imports; no path aliases.
- No gameplay numbers in code (use `Balance`) and no player-facing text in code (use `t()`).
- `src/shared/sim/` is deterministic: seeded `Rng`, world time, no globals or module-level mutable state.
- Every module can be tested headlessly. Unit tests live next to the code as `*.test.ts`. The sim, protocol decode,
  NetClient interpolation, and ClientGame reconciliation must have tests.
- Code at network edges never throws to the caller: decode returns `null`, and handlers catch and log errors.
- Bus payloads are plain data and handlers must not mutate them. Subscribers unsubscribe in `dispose()`.

## 11. Performance budgets

60 fps on a mid-range integrated GPU at 1080p (16 players, about 300 props); initial download < 15 MB (JS < 1.5 MB gzip);
time-to-playable < 10 s; snapshot < 8 KB per client without loot; server tick < 5 ms at 16 players.

## 12. Phase B build contract

Everything below must typecheck against `src/shared/*.ts` as written. If you need a change to a shared file, ask
tech-lead. Do not edit it yourself.

### game-developer
- **Deliver:** `src/shared/sim/terrain.ts`, `movement.ts`, `combat.ts`, and `World.ts` with exactly the §4 exports,
  plus any internal sim files (colliders, zone, loot, inventory, bots, match). Also `src/game/ClientGame.ts`
  `export class ClientGame implements IClientGame` with `constructor(deps: ClientGameDeps)`. Include unit tests for
  movement, combat, zone, the match lifecycle, and reconciliation.
- **Consumes:** `types`, `events`, `contracts` (`INetClient`, `FrameView`, `HudView`, `Settings`), `balance`,
  `constants`, `math`; `getMap` through deps.
- **Must not touch:** `server/`, `src/net/`, `src/shared/protocol/`, `src/render/`, `src/ui/`, `src/audio/`,
  `src/shared/*.ts`, `src/main.ts`. Do not import the `NetClient` class; use `INetClient`.

### network-engineer
- **Deliver:** `src/shared/protocol/messages.ts` (§5); `server/index.ts`, `server/Room.ts` (and helpers in
  `server/`); `src/net/NetClient.ts` `export class NetClient implements INetClient` with `constructor()`. Include
  tests for decode/validation, interpolation, and clock sync.
- **Consumes:** `createWorld`/`World` from `src/shared/sim/World.ts`. Until it lands, code against the §4 interface
  with a local fake in tests. Also uses `getMap`/`DEFAULT_MAP_ID` from `src/game/levels`, `BALANCE`, and
  `keysWithPrefix`/`t` for bot names.
- **Must not touch:** `src/shared/sim/`, `src/game/`, `src/render/`, `src/ui/`, `src/audio/`, `src/shared/*.ts`,
  `src/main.ts`.

### graphics-engineer
- **Deliver:** `src/render/Renderer.ts` `export class Renderer implements IRenderer`,
  `constructor(container: HTMLElement, map: MapData, bus: EventBus<GameEvents>)`. It appends its own canvas to
  `container` and owns the Three.js camera, placing it from `FrameView.camera` (it may pull the camera in to avoid
  clipping into terrain or props). Terrain comes from `heightAt`/`surfaceAt`. The renderer also owns water, sky, fog,
  shadows, toon materials and outlines, the tide wall from `FrameView.zone`, loot bob/spin
  (`loot.pickupBobHeight`), and dead-player poses.
- **Bus subscriptions (VFX):** `shotFired` (muzzle flash, tracers per impact, impact puffs), `playerDamaged`,
  `playerKilled`, `itemPickedUp`, `land`, `zoneChanged`.
- **Procedural models:** comes from `src/render/procedural/index.ts` (graphics-designer). The agreed exports are:
  `createCharacter(appearance: Appearance)` → `{ root: THREE.Group; head; body; armL; armR; legL; legR; handR: THREE.Object3D }`,
  `createProp(kind: PropKind)` → `THREE.Object3D` (unit scale; the renderer applies `scale`/`rotY`),
  `createWeaponModel(id: WeaponId)`, `createLootModel(item: ItemId)`, `createToonMaterial(color: number)`, and
  `getToonGradient(): THREE.Texture`. Until they land, use primitive placeholders behind those same names.
- **Must not touch:** anything outside `src/render/` (except `docs/tech/RENDERING.md`). No DOM beyond the container and
  canvas. No imports from ui, audio, game, or net.

### ui-ux-designer
- **Deliver:** `src/ui/Ui.ts` `export class Ui implements IUi`,
  `constructor(root: HTMLElement, bus: EventBus<GameEvents>, callbacks: UiCallbacks)`, with CSS imported from
  `src/ui/`. Ui also persists `Settings` in `localStorage[SETTINGS_STORAGE_KEY]` (falling back to `DEFAULT_SETTINGS`)
  and calls `onSettingsChanged` once after load.
- **Consumes:** `HudView` every frame. Screens are chosen from `hud.connection`, `hud.joined`, `hud.phase`,
  `hud.local`, and `hud.spectate`. Bus events: `playerKilled` (kill feed, death screen when `isLocalVictim`),
  `localHitConfirmed` (hit marker), `playerDamaged` with `isLocalVictim` (damage direction from `sourcePos` vs
  `hud.local.pos/yaw`), `interactPromptChanged`, `itemPickedUp` (local toast), `matchEnded` (results screen),
  `spectateTargetChanged`, `countdown`, `zoneWarning`, `connectionStatus`. All text goes through `t()`. The minimap
  coastline comes from `coastlineRadius`.
- **Must not touch:** anything outside `src/ui/` and `docs/ui/`. Never request pointer lock directly (call
  `onResume`). Never draw into the WebGL canvas.

### audio-designer
- **Deliver:** `src/audio/AudioEngine.ts` `export class AudioEngine implements IAudio`,
  `constructor(bus: EventBus<GameEvents>)`. It must not create an `AudioContext` before `unlock()`, and events that
  arrive before unlock are dropped silently.
- **Bus subscriptions:** positional for remotes (`shotFired` at `origin`, `footstep`, `jump`, `land`, `reloadStarted`,
  `itemPickedUp`, `playerDamaged` at `victimPos`), 2D for local (`isLocal`). UI-style sounds: `localHitConfirmed`,
  `dryFire`, `countdown`, `zoneWarning`, `localZoneStatusChanged`, `matchPhaseChanged`, `playerKilled` (local
  kill/death), `healStarted`/`healFinished`, `weaponSwitched`, `matchEnded`. An ambient waves loop runs after unlock.
- **Must not touch:** anything outside `src/audio/` and `docs/audio/`. No imports from render, ui, game, or net.

### level-designer (dependency for everyone)
- `src/game/levels/index.ts`: `export function getMap(id: string): MapData` (throws on unknown id) and
  `export const DEFAULT_MAP_ID: string`. Data only; it may import `src/shared/types.ts`.

### Contract revision 1 (M1-fix, after the Phase B review)

Every item is **optional/additive**. Producers and consumers can land in any order, and consumers must keep their
current fallback until the field is present. Each item is marked `// M1-fix:` in code. Unless a row says otherwise,
it is already in the shared files.

| # | Contract | Producer (must fill it) | Consumers (should use it) |
|---|---|---|---|
| 1 | `LootState.tier?: LootTier` (types.ts) | game-developer: sim loot spawn sets the spawn-point tier; death drops are `'common'`. network-engineer: `isLoot` validates it when present. | graphics-engineer: tier ring from `tier`; keep nearest-spawn inference only as fallback. |
| 2 | SimEvent `damage.armorBefore?` → GameEvent `playerDamaged.armorBefore?` | game-developer: sim sets it; ClientGame (`simEvents.ts`) copies it. network-engineer: `isSimEvent` checks it is a number when present. | audio-designer: armor-hit (`armorBefore > 0`) and armor-break (`armorBefore > 0 && armorAfter === 0`); drop the per-victim tracking. ui-ux-designer: optional armor-break marker. |
| 3 | GameEvent `weaponSwitched.pos?` | game-developer: ClientGame sets `ctx.posOf(playerId)`, the same as for reload and heal. | audio-designer: positional remote swap sound. |
| 4 | SimEvent `kill.headshot?` → GameEvent `playerKilled.headshot?` | game-developer: sim (whether the lethal hit was a headshot; false for zone and fall) and ClientGame copy. network-engineer: `isSimEvent`. | ui-ux-designer: kill feed icon; drop the `lastHeadshot` fallback. |
| 5 | `ActionFailedSimEvent` / `FailedAction` / `ActionFailReason` (types.ts) → GameEvent `actionFailed` (events.ts) | game-developer: World emits it for human edge presses only (at most one per press, never for bots). In ONE change: add `\| ActionFailedSimEvent` to the `SimEvent` union in types.ts (pre-approved one-line edit), add `case 'actionFailed'` in `simEvents.ts` (emit only when `isLocal`; do not forward `action: 'fire'`, because `dryFire` covers it), **and** network-engineer adds `case 'actionFailed'` to protocol `isSimEvent`. Without that case, the client decoder filters the event out. | ui-ux-designer: toast with the string key below. audio-designer: refusal cue. |
| 6 | `HudView.cameraFovDeg?`, `HudView.deathScreenSeconds?`, `HudView.spectate.targetMaxHp?`, `HudLocalView.healMax?`, `reserveMax?`, `ammoType?` | game-developer (`hudBuilder.ts`): `camera.fovDeg`, `balance.match.deathScreenSeconds`, `balance.player.maxHp`, `items.<heal>.maxStack`, `items.<ammo>.maxCarry`. | ui-ux-designer: drop `DEFAULT_FOV_DEG`, `DEATH_CARD_MS` and `knownMaxHp` fallbacks once the fields are present; show `hud.inventory.full` in the prompt before the press. |
| 7 | `Settings.quality?: QualityLevel`, `QUALITY_LEVELS`, `DEFAULT_QUALITY` ('medium'), `IRenderer.setQuality?` | ui-ux-designer: settings control, `normalizeSettings` / `settingsEqual` (and add `quality` to tests). | main.ts (done): calls `renderer.setQuality` only when the value changes. graphics-engineer: already implemented. |
| 8 | `UiSoundId`, `IAudio.playUi?`, `UiCallbacks.playUiSound?` | ui-ux-designer: call `callbacks.playUiSound?.('ui.click' / 'ui.hover' / 'ui.slider')` from buttons, hovers and sliders. | main.ts (done): wires it to `audio.playUi`. audio-designer (done): `uiDom.ts` document listeners removed. main.ts now calls `audio.unlock()` on every pointerdown or keydown, so the gesture retry is kept. |
| 9 | `Balance.clientFeel?` (`ClientFeelBalance`, key names = `ClientTuning`), `items.medkit.preferAtOrBelowHp?`, `bots.ai?` (`BotAiBalance`) | game-designer: add the numbers to balance.json. Note the units: `bots.ai.idleTurnDegPerSecond` and `combatTurnDegPerSecond` are deg/s, and `zoneUrgencyBufferSeconds` is in seconds. | game-developer: `tuning.ts` reads `balance.clientFeel` without the cast; `inventory.ts` reads `preferAtOrBelowHp` without the cast; `bots.ts` merges `balance.bots.ai` over `BOT_AI` (convert deg→rad and s→ms). `validateBalance` accepts all three and rejects mistyped keys. |
| 10 | Renderer constructor optional 4th param `balance?: Balance` (contracts.ts header) | graphics-engineer: accept it and stop importing `BALANCE` (falling back to `BALANCE` is fine until main.ts passes it). | main.ts (done): passes `BALANCE`. graphics-engineer: drop the `BALANCE` import and `?? BALANCE` fallback. |
| 11 | `MAX_INPUT_REPEAT_TICKS` (constants.ts, 6) | — | game-developer: `World.dequeue` bounds the repeat (ADR 0002 §4) and adds a test. |

### Contract revision 1b (after revision 1 landed; ADR 0003)

Same rules as revision 1: optional/additive, consumers keep their fallback until the producer lands.

| # | Contract | Producer | Consumers |
|---|---|---|---|
| 12 | `Balance.player.lowHpThreshold?`, `bots.*` pacing keys, `bots.personalities?`, `bots.ai` loot scores (`BotPacingBalance`, `BotPersonalityBalance`, `BotAiBalance`); `BotPersonalityId`/`BOT_PERSONALITY_IDS` (types.ts) | game-designer: numbers in balance.json. | game-developer: `botTuning`/`botAi` in `bots.ts` read the typed fields without `as unknown as Record` casts (also `World.test.ts` personalities override). |
| 13 | `HudLocalView.lowHpThreshold?` (low = `alive && hp > 0 && hp <= lowHpThreshold`) | game-developer (`hudBuilder.ts`): copy `balance.player.lowHpThreshold`; omit when absent. | ui-ux-designer: `isLowHp(local.hp, local.lowHpThreshold ?? LOW_HP_THRESHOLD)`. main.ts (done): passes the same number to `AudioEngine` as `lowHealthHp`. audio-designer: drop the `BALANCE` import in `resolveLowHealthHp` before M2. |
| 14 | `IRenderer.getGraphicsStatus?()`, `GraphicsStatus`, `IUi.setGraphicsStatus?()`, `CONTEXT_RESTORE_TIMEOUT_MS` | graphics-engineer: `'restoring'` on context lost, `'failed'` after the timeout without restore, `'ok'` on restore. | ui-ux-designer: blocking reload overlay on `'failed'` (narrative-designer: strings). main.ts (done): forwards changes. qa-tester: Playwright `WEBGL_lose_context` test (`loseContext()` without `restoreContext()` → overlay after 5 s). |

**`actionFailed` reason → string key** (`src/content/strings/en.json`; Ui shows it as a short toast or prompt line):

| `action` | `reason` | When (sim) | String key |
|---|---|---|---|
| `heal` | `noHeals` | Q with no bandage or medkit | `hud.heal.none` |
| `heal` | `fullHp` | Q when no carried heal would add HP (hp ≥ its `healCap`) | `hud.heal.full` |
| `pickup` | `inventoryFull` | E on ammo or a heal at `maxCarry` / `maxStack` | `hud.inventory.full` |
| `pickup` | `betterArmor` | E on a vest while current armor ≥ `items.vest.armor` | `hud.armor.better` |
| `reload` | `noAmmo` | R with a non-full mag and 0 reserve | `hud.ammo.empty` |
| `fire` | `noAmmo` | trigger press with an empty mag and 0 reserve (not forwarded to the bus in M1) | (`hud.ammo.empty`, via `dryFire`) |

A full gun-slot pickup is a swap, not a failure (`hud.pickup.swap`). R with a full mag, or while already reloading,
is silently ignored.

## 13. Future work (out of M1)
Lag compensation (server rewind of hitboxes by the shooter's interpolation time), predicted muzzle flash/recoil,
aim convergence from the camera ray, binary/delta protocol, interest management, multiple rooms/matchmaking,
reconnect into a running match.
