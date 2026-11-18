# Architecture (M1 "First Playable" + M2a "Arsenal & Stance" + M2b "Office, Drop & Rooms")

Owner: tech-lead. Decisions: [ADR 0001 stack and netcode](../adr/0001-stack-and-netcode.md),
[ADR 0002 M1 netcode and boundary clarifications](../adr/0002-m1-netcode-and-boundary-clarifications.md),
[ADR 0003 low-health signal, typed bot tuning, graphics status](../adr/0003-low-health-signal-and-typed-bot-tuning.md),
[ADR 0004 M2a stance, ADS, grenades, two-piece armor](../adr/0004-m2a-stance-ads-grenades-armor.md) (+ D2 addendum),
[ADR 0005 M2b maps, indoor office, per-map balance, carrier drop](../adr/0005-m2b-maps-indoor-office-and-carrier-drop.md),
[ADR 0006 M2b rooms](../adr/0006-m2b-rooms.md).
**M2a build contract: §14. M2b build contract: §15** (each supersedes older sections where they disagree).
Latest review: [REVIEW-M2b.md](REVIEW-M2b.md) (earlier: [REVIEW-M2a.md](REVIEW-M2a.md), [REVIEW-M1.md](REVIEW-M1.md)).
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
  M2a: stance and the ADS timer are part of `MovementState`, so they are predicted too (ADR 0004 §1, §5).
  Grenades are not predicted, but clients extrapolate them with the shared `stepGrenade` (ADR 0004 §3).
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
| `src/shared/*.ts` | tech-lead | `types`, `events`, `contracts`, `balance`, `constants`, `math`, M2b `maps` |
| `src/shared/kits/` | graphics-designer | M2b: pure-data prop kits (`PropKit`, no three.js), e.g. `office.ts` `OFFICE_KIT` |
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
| `src/shared/kits/` (M2b) | `src/shared/types.ts` (types only). Imported by `src/game/levels/` and `src/render/`; **never by the sim**, which reads `map.kit` |
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
  [0, `SIM_DT`]; booleans coerced; `selectSlot` in {-1, 0, 1, 2, 3} (M2a); `ads` coerced (absent = false, M2a);
  `stanceToggle` absent → null, present and not `'crouch' | 'prone' | null` → bad frame (M2a). More than
  `2 * INPUT_HZ` inputs per second → drop extras.
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
(M2a: eye height, hitbox and spread now depend on stance and ADS; see ADR 0004 §2 and combat.md "Spread".)
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
| `stanceChange` (M2a) | `stanceChanged` (remotes only; the local one comes from prediction) |
| `grenadeCook` / `grenadeThrown` / `grenadeBounce` / `explosion` (M2a) | `grenadeCooked` / `grenadeThrown` / `grenadeBounced` / `explosion` (`localDistance` added) |

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
M2a adds RMB (ADS), C (crouch), Z (prone), 4 and G (grenade), and the mouse wheel. Ctrl is never bound.

## 9. Balance keys the code requires

`src/shared/balance.ts` defines `Balance` and `validateBalance()`. It runs at startup on client and server, and it
throws with a list of every missing or mistyped key. The current `docs/design/balance.json` passes. Required paths:

- `match.{targetPlayers, minHumansToStart, countdownSeconds, resultsSeconds, dropHeight, maxPlayers, spawnJitter, killCreditWindowSeconds, deathScreenSeconds, endWhenNoHumansAlive(bool), lastHumanDeathDelaySeconds}`
- `player.{maxHp, radius, height, eyeHeight, pickupRange, headZoneFraction}` (M2a: `maxArmor` removed)
- `movement.{walkSpeed, sprintSpeed, airControl, jumpVelocity, gravity, accel, friction, waterSpeedMultiplier, waterDepthThreshold, fallDamageMinSpeed, fallDamagePerMs, terminalVelocity, stepHeight, healMoveMultiplier, dropFallSpeed, dropSteerSpeed}`
- M2a `movement.stances.{stand|crouch|prone}.{speedMultiplier, height, eyeHeight}`, `movement.stances.transitionMs.<stand_crouch|stand_prone|crouch_stand|crouch_prone|prone_stand|prone_crouch>` (unknown transition keys rejected), `movement.stances.{proneMaxWaterDepth, crouchMaxWaterDepth, headroomCheck(bool), headroomMargin}`; `stand.height/eyeHeight` must equal `player.height/eyeHeight`
- `combat.{swapMs, airSpreadMultiplier, moveSpreadSpeedThreshold, deathDropScatter}`, M2a `combat.fireMoveWindowMs`, `combat.stanceSpreadMultiplier.{stand, crouch, prone}`, `combat.hitbox.{crouchHeadZoneFraction, proneLength, proneWidth, proneHeadLength}`
- `weapons.<fists|pistol|smg|shotgun|rifle|lmg|dmr|sniper>.{damage, headshotMultiplier, fireIntervalMs, magSize, reloadMs, ammo (AmmoId, null for fists), range, spreadDeg, pellets, automatic(bool), falloffStart, falloffEnd, minDamageFactor, moveSpreadMultiplier}` plus M2a `{sight ('none' for fists only; iron|red_dot|scope_4x|scope_8x for guns), adsZoom (>= 1), adsSpreadMultiplier, adsMoveMultiplier, adsTimeMs (>= 0), fireMoveMultiplier}`
- `items.<bandage|medkit>.{heal, healCap, useMs, maxStack, spawnQty}`, `items.<ammo_light|ammo_heavy|ammo_shell|ammo_sniper>.{pickupQty, maxCarry}`
- M2a `items.<vest_1..3|helmet_1..3>.{slot ('vest'|'helmet', matching the id), tier (1-3, matching the suffix), durability (> 0), absorbFraction ([0, 1))}`; `items.vest` is rejected
- M2a `items.grenade.{maxCarry, spawnQty, cookable(bool), fuseMs, throwSpeedMin, throwSpeedMax, throwPitchMinDeg, throwPitchMaxDeg, throwLiftDeg, throwOriginForward, throwSpeedProneMultiplier, throwRecoveryMs, dropOnSwitchSpeed, gravity, restitution, friction, collisionRadius, restSpeed, waterVelocityDamping, bounceEventMinSpeed, radius, innerRadius, maxDamage, minDamageFactor, selfDamage(bool), losHeightOffset}` with `0 <= innerRadius < radius`, `throwSpeedMin <= throwSpeedMax`, `throwPitchMinDeg < throwPitchMaxDeg`
- `armor.dropOnDeath(bool)` (M2a; `armor.absorbFraction` removed)
- `loot.tiers.<common|rare|epic>` (ItemId → weight >= 0; M2a: unknown ids rejected), `loot.{extraAmmoWithWeapon, spawnChance, weaponSpawnsWithFullMag(bool), extraAmmoScatter, pickupBobHeight}`
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
M2a optional: `clientFeel.{adsCameraDistance, adsCameraShoulderOffset, adsExitBlendMs, grenadeArcPreviewSeconds}`,
`bots.ai.{lootScoreHelmet, lootScoreArmorPerTier, lootScoreGrenade}`, `bots.personalities.*.{stanceChance,
grenadeChanceMultiplier}`, `bots.ads.{minRange, aimErrorMultiplier, scopedVisionRange}`, `bots.stance.{minRange,
holdMs, proneShare}`, `bots.grenade.{minRange, maxRange, throwChancePerDecision, cooldownMs, cookMs, coverMemoryMs,
aimErrorMetres, fleeRadius}`, and `bots.weaponPrefs.<GunId>` (each listed gun needs all of `{minRange, maxRange,
lootValue}` with `minRange <= maxRange`; an unknown gun key is an error). Design invariants (armor effective HP,
sniper vs helmet) are asserted in `balance.test.ts`, not at runtime.

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
| 15 | `UiCallbacks.onSpectate?: () => void`, `IClientGame.requestSpectate?(): void` (BUG-001) | game-developer: `ClientGame.requestSpectate()` ends the death-screen delay so spectating starts on the next `update()`; no-op unless dead and not spectating. | ui-ux-designer: death card "Spectate" button calls `callbacks.onSpectate?.()` (keep closing the card). main.ts (done): wires `onSpectate` to `game.requestSpectate?.()`. |

Notes: the Renderer's 4th constructor param `balance` is now required (contracts.ts header fixed; supersedes row 10's
fallback). `src/shared/sim/tools/` keeps its `Date.now` exemption (ADR 0002 item 6 amendment).

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

## 14. M2a build contract ("Arsenal & Stance")

Decisions: [ADR 0004](../adr/0004-m2a-stance-ads-grenades-armor.md). Specs: `docs/design/systems/{combat,stance,
armor,grenades,loot}.md`. The shared files (`src/shared/*.ts`) are the source of truth for every name below. The
same rules apply as in §12: edit only your own files, and ask tech-lead for shared changes. Stub first: your first
change makes your files compile against these types, then you build features.

**State of the tree after B1:** `BALANCE` loads again (`npx vitest run src/shared/balance.test.ts`: 14 passed).
`npx tsc --noEmit -p .` reports **178 errors**, all in Phase C files and assigned below. `npx vitest run` reports
46 failing tests in 8 files, listed per owner below. `PROTOCOL_VERSION` is 2.

> **P0 for game-developer (the user's dev server):** `World.ts:880` and `:917` still read
> `balance.armor.absorbFraction`, which no longer exists. Every weapon and zone hit makes HP `NaN`, so no one can die.
> Land the two-piece armor change (or a stub that skips armor) first.

### What changed in the shared contract (summary)
| Area | Change (file) |
|---|---|
| Ids | `WeaponId` adds `lmg`, `dmr` and `sniper`. `AmmoId` adds `ammo_sniper`. `ArmorId = VestId \| HelmetId` (`vest_1..3`, `helmet_1..3`); the old `vest` id is gone. `ThrowableId = 'grenade'`. `ItemId` includes armor and the grenade. `HeldId = WeaponId \| 'grenade'`. `SightType`, `Stance`, `StanceRequest`, `StanceTransitionKey`, `ArmorSlot`, `ArmorTier`, `ArmorTierOrNone`. Lists: `VEST_IDS`, `HELMET_IDS`, `ARMOR_IDS`, `THROWABLE_IDS`, `SIGHT_TYPES`, `STANCES`, `STANCE_TRANSITION_KEYS`, `SLOT_INDICES`. Helpers: `ARMOR_PIECES`, `armorIdOf`, `isArmorId`, `stanceTransitionKey` (types.ts) |
| Slots | `SlotIndex = 0\|1\|2\|3`. `GRENADE_SLOT = 3` (types.ts) |
| Input | `PlayerInput.ads` (held) and `PlayerInput.stanceToggle` (edge, `'crouch'\|'prone'\|null`). `selectSlot` may be 3 (types.ts) |
| Movement | `MovementState` adds `stance`, `stanceFrom`, `stanceMs` and `adsMs`. `MovementInput` adds `stanceToggle`, `ads`, `held` and `adsBlocked`. `MovementStepResult` adds `stanceChanged: StanceChange \| null`, `stanceRefused: StanceRefusal \| null` and `adsEngaged` (types.ts) |
| Snapshot | `PlayerState` removes `armor` and adds `vestTier`, `helmetTier`, `stance`, `stanceFrom` and `stanceProgress`. Its `weapon` is now a `HeldId`. `PlayerAnim` adds `ads` and `cooking`. `LocalPlayerState` adds `vest`, `helmet` (`ArmorPieceState \| null`), `grenades`, `cookExplodesAt` and `throwRecoveryMs`, and `ammo` gains `ammo_sniper`. `LootState.durability?` is added. `WorldSnapshot.grenades: GrenadeState[]` is new (types.ts) |
| SimEvents | `damage` replaces `armorAfter` and `armorBefore` with `vest`/`helmet: ArmorHit \| null` and adds `grenadeId?`; `amount` is the raw damage before armor. `kill.weapon` is now `HeldId \| null`. `pickup.durability?`. `weaponSwitch.weapon` is now `HeldId`. New events: `stanceChange`, `grenadeCook`, `grenadeThrown`, `grenadeBounce` and `explosion`. `DeathCause` adds `'explosion'`. `FailedAction` adds `swap` and `stance`; `ActionFailReason` adds `noGrenades`, `tooDeep` and `noHeadroom` (types.ts) |
| GameEvents | `playerDamaged` and `localHitConfirmed` carry `vest`/`helmet: ArmorHit \| null` (and `localHitConfirmed` carries `cause`). `playerKilled.weapon` and `weaponSwitched.weapon` are `HeldId`. `itemPickedUp.durability?`. `interactPromptChanged` adds `durability` and `refusal`. New events: `stanceChanged`, `localAdsChanged`, `grenadeCooked`, `grenadeThrown`, `grenadeBounced` and `explosion` (events.ts) |
| Views | `CameraView.firstPerson`. `FrameView.grenades`, `grenadeArc` and `ads`. `AdsView`, `GrenadeView` and `GrenadeArcView` are new. `HudSlotView.count` is added and `weapon` is now a `HeldId`. `HudLocalView` drops `armor`/`maxArmor`, adds `vest`, `helmet`, `grenades`, `grenadeMax`, `cook`, `stance`, `stanceFrom` and `stanceProgress`, and `slots` now has four entries. `HudView` adds `ads` and `grenadeDanger`. `Settings` adds `adsMode?` and `adsSensitivity?`, with `AdsMode`, `ADS_MODES`, `DEFAULT_ADS_MODE` and `DEFAULT_ADS_SENSITIVITY` (contracts.ts) |
| Balance | `WeaponBalance` adds `sight`, `adsZoom`, `adsSpreadMultiplier`, `adsMoveMultiplier`, `adsTimeMs` and `fireMoveMultiplier`. New types: `ArmorBalance`, `GrenadeBalance`, `StanceBalance`, `StancesBalance`, `HitboxBalance`, `BotWeaponPrefBalance`, `BotAdsBalance`, `BotStanceBalance` and `BotGrenadeBalance`. `player.maxArmor`, `items.vest` and `armor.absorbFraction` are removed. Helpers: `sightOf`, `isScopeSight` and `armorBalance` (balance.ts) |
| Constants | `PROTOCOL_VERSION = 2`, `GRENADE_EXTRAPOLATION_MAX_MS = 250` (constants.ts) |

**`actionFailed` reason → string key (M2a additions to the §12 table)**
| `action` | `reason` | When (sim) | String key |
|---|---|---|---|
| `pickup` | `betterArmor` | E on an armor piece with tier <= the worn piece's tier in that slot | `hud.vest.better` or `hud.helmet.better`, chosen by the slot of the prompt's item (fallback `hud.armor.better`) |
| `pickup` | `inventoryFull` | E on grenades at `maxCarry` (and on ammo/heals as in M1) | `hud.grenade.full` when the prompt item is `grenade`, else `hud.inventory.full` |
| `swap` | `noGrenades` | slot 3 (key 4 or G) with 0 grenades | `hud.grenade.none` |
| `stance` | `noHeadroom` | C/Z/Space to a taller stance under a collider | `hud.stance.noRoom` |
| `stance` | `tooDeep` | C/Z into a stance not allowed at this water depth | `hud.stance.tooDeep` (**narrative-designer: please add**, e.g. "Too deep here"); until it exists use `hud.stance.proneWater` |

### game-developer (`src/shared/sim/`, `src/game/`): 2a-C1..C5
**Deliver** (exact exports; other agents code against them):
- `src/shared/sim/stance.ts` (new, pure):
  `isStanceSettled(m: MovementState): boolean`,
  `stanceProgress(m: Pick<MovementState,'stance'|'stanceFrom'|'stanceMs'>, b: Balance): number` (0..1, 1 = settled),
  `eyeHeightOf(m, b): number` (lerped during transitions), `hitboxHeightOf(m, b): number` (the taller stance during
  transitions), `chestPoint(feet: Vec3, m, b): Vec3`,
  `rayHitbox(o: Vec3, dir: Vec3, maxT: number, feet: Vec3, yaw: number, m, b): { t: number; headshot: boolean } | null`.
  The shapes are in ADR 0004 §2. The prone box is centred on the feet `(x, z)`.
- `movement.ts`: `toMovementInput(input, status, b)` with `MovementStatus` extended by `held: HeldId`, `swapping`
  and `fireSlowed` (true within `combat.fireMoveWindowMs` of a shot, server-exact; ClientGame approximates it, ADR
  0004 Consequences). It fills the new `MovementInput` fields, with dead → `stanceToggle: null`, `ads: false` and
  `adsBlocked: true`. `stepMovement` runs the stance.md per-tick order and the ADS rules from combat.md, and returns
  `stanceChanged`, `stanceRefused` and `adsEngaged`. It must stay pure (it reads only its arguments).
- `combat.ts`: `effectiveSpreadDeg(weapon: WeaponId, b, status: { horizontalSpeed; airborne; adsProgress: number;
  stance: Stance; stanceSettled: boolean })`, the full A x S x M x J cone, and
  `adsProgressOf(m: MovementState, held: HeldId, b): number`. Armor goes per piece:
  `applyArmorPiece(piece: ArmorPieceState | null, dmg: number, absorbFraction: number)` →
  `{ piece: ArmorPieceState | null; absorbed: number; broken: boolean; hpLoss: number }` (name free, behaviour as in
  armor.md).
- `grenade.ts` (new, pure, no RNG): `interface GrenadeBody { pos: Vec3; vel: Vec3; inWater: boolean }`,
  `stepGrenade(body, dt, ctx: MovementContext): { body: GrenadeBody; contact: { pos: Vec3; surface:
  GrenadeContactSurface; speed: number } | null }`,
  `throwLaunch(eye: Vec3, yaw: number, pitch: number, proneSettled: boolean, ctx): { pos: Vec3; vel: Vec3 }`,
  `dropLaunch(eye: Vec3, yaw: number, ctx): { pos: Vec3; vel: Vec3 }`,
  `predictGrenadeArc(launch: { pos: Vec3; vel: Vec3 }, fuseRemainingMs: number, ctx, maxSeconds: number):
  Omit<GrenadeArcView, 'radius'>`, and `explosionDamage(dist: number, b): number`.
- `World.ts`: stance, ADS and armor per piece (the `SimPlayer.armor` field is replaced, and `tickStartHpArmor` uses
  hp + vest + helmet durability). It also covers grenade entities (cook, throw, drop on swap/death/disconnect,
  cook-out, explosion with line of sight, vest-only absorb, self-damage, kill credit, removal at match end), the
  slot 3 rules (`noGrenades`, auto-switch after the last throw), death drops of armor and grenades, `LootState`
  `durability`, and snapshot fields (`PlayerState` and `LocalPlayerState` as above, `grenades` sorted by id). Every
  new SimEvent fires on the tick it happens. `stanceChange` is public. `actionFailed` stays private.
- `loot.ts` and `inventory.ts`: armor pickups (all-or-nothing, keep their durability, `betterArmor` rule), grenade
  stacks (partial pickup), `ammo_sniper`, and `spawnQuantity` for armor and the grenade.
- `bots.ts`: armor scoring (`lootScoreHelmet`, `lootScoreArmorPerTier`), `bots.weaponPrefs` range bands, `bots.ads`,
  `bots.stance`, `bots.grenade` (throw at covered targets 8-30 m, flee) and the personality `stanceChance` and
  `grenadeChanceMultiplier`. Every bot input sets `ads` and `stanceToggle`.
- `src/game/`:
  - Input: RMB for `ads`, using `Settings.adsMode` (the toggle latch rule is in the `Settings.adsMode` JSDoc). C and
    Z set `stanceToggle`, and the later press wins. Keys 4 and G set `selectSlot` 3. The mouse wheel cycles slots
    and skips empty slots. Never bind Ctrl.
  - Look sensitivity: divide by `ads.zoom` and multiply by `Settings.adsSensitivity`.
  - Prediction: pass the new `MovementStatus` from `snapshot.local` (reload, heal, swap, active held item).
  - `camera.ts`: build `AdsView`, apply it to `CameraView` (fov, distance, shoulder, `firstPerson` when
    `ads.scoped`), and use the stance eye height as the pivot.
  - Grenades: the `FrameView.grenades` extrapolation (ADR 0004 §3) and the `FrameView.grenadeArc` preview.
  - `hudBuilder`: build the new `HudLocalView`, `HudView.ads` and `grenadeDanger` fields.
  - `simEvents.ts`: translate the new events. Emit `stanceChanged` and `localAdsChanged` for the local player from
    prediction. Set `explosion.localDistance`, `interactPromptChanged.durability`/`refusal`, and the armor fields on
    hits.
- Tests: the acceptance tests in combat.md, stance.md, armor.md, grenades.md and loot.md that run on the sim, plus
  a prediction equivalence test for stance and ADS (stance.md test 16).

**Must not touch:** the shared `src/shared/*.ts` files, protocol, server, net, render, ui, audio.

**Current tsc errors (96), yours:**
- `src/shared/sim` (44): `World.ts` 13, `World.test.ts` 8, `movement.test.ts` 5, `bots.ts` 4, `movement.ts` 3,
  `inventory.ts` 3, `combat.test.ts` 3, `inventory.test.ts` 2, `testkit.ts` 2, `tools/matchReport.ts` 1.
- `src/game` (52): `hudBuilder.ts` 10, `simEvents.ts` 6, `derived.test.ts` 6, `ClientGame.ts` 5,
  `simEvents.test.ts` 5, `hudBuilder.test.ts` 4, `testFixtures.ts` 4, `camera.ts` 2, `ClientGame.test.ts` 2,
  `prediction.test.ts` 2, `actionPrediction.test.ts` 2, `derived.ts` 1, `prediction.ts` 1, `input/InputState.ts` 1,
  `tuning.test.ts` 1.

**Failing vitest (runtime):** `World.test.ts` (29), `combat.test.ts` (3), `inventory.test.ts` (1), `loot.test.ts`
(1). The causes are the removed `armor.absorbFraction` and `items.vest`, and the new loot ids.

### network-engineer (`src/shared/protocol/`, `server/`, `src/net/`): 2a-C6
**Deliver:**
- `messages.ts`, `decodePlayerInput`: `ads` is coerced to boolean (absent = false). `stanceToggle` is
  absent → null, and anything other than `'crouch' | 'prone' | null` makes the frame bad (dropped, and it counts
  toward the bad-frame limit). `selectSlot` is in {-1, 0, 1, 2, 3}. `server/validate.ts` gets the same rules.
- `isPlayerState` / `PLAYER_FIELDS`: remove `armor`. Add `vestTier` and `helmetTier` (an integer 0 to 3),
  `stance` and `stanceFrom` (in `STANCES`), and `stanceProgress` (a number in [0, 1]). `weapon` must be in
  `[...WEAPON_IDS, 'grenade']`. `anim.ads` and `anim.cooking` are booleans.
- `LocalPlayerState` validation: `vest` and `helmet` are `null | {tier 1-3, durability > 0}`. `grenades` is an
  integer >= 0. `cookExplodesAt` is `number | null`. `throwRecoveryMs` is >= 0. `ammo` includes `ammo_sniper`.
  `movement` includes the stance fields and `adsMs`.
- `isLoot`: `durability?` is a number > 0 when present. `item` must be in `ITEM_IDS`.
- `WireSnapshot.grenades: GrenadeState[]` is validated (`inWater` is a boolean, `explodesAt` a number). It is sent
  as a full list every snapshot. Delta-encoding grenades is optional (ADR 0004 §8).
- `isSimEvent`: the new `damage` shape (`vest`/`helmet: null | {tier, absorbed, broken}`, `grenadeId?`); `kill.weapon`
  may be `'grenade'`; `cause` includes `'explosion'`; `pickup.durability?`; `weaponSwitch.weapon` may be `'grenade'`
  and `slot` may be 3. It also covers `stanceChange`, `grenadeCook`, `grenadeThrown`, `grenadeBounce` and
  `explosion`. The new `FailedAction` and `ActionFailReason` values must be in the record maps (`messages.ts:147/149`).
  `privateEventRecipient` is unchanged: only `actionFailed` is private, and every new event is public.
- `delta.ts`: the new `PlayerState` fields go through `diffPlayer` the same way as the existing ones. In steady
  state they should cost nothing.
- `src/net/`: `getInterpolated` lerps `stanceProgress` when `stance` and `stanceFrom` match in both snapshots, and
  otherwise takes it from the newer snapshot (contracts.ts `InterpolatedWorld` JSDoc). Grenades are not
  interpolated. `latestSnapshot()` must expose `grenades`. NetClient keeps refilling `loot`, and must keep
  `grenades` as received.
- The `PROTOCOL_VERSION` bump is done (constants.ts = 2). Make sure `bad_version` tests use the constant.
- **Bandwidth:** measure the snapshot size at 16 players with 10 live grenades, all in transitions and ADS. It must
  stay under 8 KB without loot (§11). Add it as a test.
- Tests: round-trip every new field and event; reject a bad `stanceToggle`; coerce `ads`.

**Current tsc errors (14), yours:** `protocol/messages.ts` 5, `protocol/testing.ts` 5, `protocol/messages.test.ts` 3,
`server/testClient.ts` 1. `src/net/` has none, but needs the behaviour above.
**Failing vitest:** `server/server.integration.test.ts` (7), `server/Room.delta.test.ts` (2).

### graphics-engineer (`src/render/`): 2a-C7, C8, C9
Art API from graphics-designer: `src/render/procedural/{wearables,grenade}.ts` and the sight anchor
(`getWeaponSight`) in `weapons.ts`. Attach notes are in `docs/art/ASSET_LIST.md` ("Wearables (M2a)", gun table)
and `docs/art/STYLE.md` §14 (armor), §15 (grenade), §16 (stances).
- **ADS camera and scope view:** apply `FrameView.camera` as given. ClientGame has already folded ADS into
  `fovDeg`, `distance` and `shoulderOffset`. When `camera.firstPerson` is true, put the camera exactly at
  `camera.target` (the eye), and hide the local player's body, wearables and held item. Do not add a second render
  pass (budget: 60 fps scoped). Ui draws the scope overlay. You only provide the view. For the local weapon pose,
  use `FrameView.ads.cameraBlend`.
- **Sights:** read the sight from Balance (`sightOf(balance, held)`, `isScopeSight` in balance.ts). The procedural
  `SightType` and `WEAPON_SIGHT_TYPES` are a model-anchor mirror only; do not use them for behaviour.
- **Stance poses:** use `PlayerState.stance`, `stanceFrom` and `stanceProgress`. Pose the chibi's `parts.stance`
  pivot using `CHIBI_STANCES` and `crouchLegAngle` (STYLE.md §16). Blend with progress, using the
  stand → crouch → prone staging in §16. The sim's prone hitbox is centred on the feet position (`PlayerState.pos`),
  which is exactly what `CHIBI_STANCES.prone.back = 0.62` assumes (ADR 0004 §2), so do not offset the root.
- **Wearables:** read `vestTier` and `helmetTier` (0 = none). Use `createVestModel(tier)` and
  `createHelmetModel(tier)`, attached with `attachWearable` to `CharacterModel.body` and `CharacterModel.head`
  (`WEARABLE_ATTACH`). Use helmet-safe hair through `setVariant({ helmet: true })` (`HELMET_HAIR_HINT`,
  `hairHiddenByHelmet`). On a tier change, swap or remove the piece. On `playerDamaged` with `vest?.broken` or
  `helmet?.broken`, play the shard burst at the chest or head.
- **Grenade:** when `weapon === 'grenade'`, use `createGrenadeModel({ pin: !anim.cooking })` on `handR` with
  `GRENADE_DIMENSIONS.handOffset`. In flight, draw one model per `FrameView.grenades` entry, with a faint trail
  while moving, and a fuse blink whose rate rises as `explodesAt - FrameView.serverTime` shrinks.
- **Arc preview:** draw `FrameView.grenadeArc` (a polyline through `points`, and a ring of `radius` at `end`). It is
  null when there is nothing to show.
- **Explosion VFX:** on the `explosion` event, draw a puff sized to `radius`. Use a water spray when
  `heightAt(pos) < 0`, else sand. Camera shake scales with `localDistance`, with none beyond 2 x `radius` and none
  when it is null. Also add a splash on `grenadeBounced` when the surface is `'water'`, and on `stanceChanged` when
  it is `forced`.
- **Scope glint:** show it on remote players with `anim.ads && isScopeSight(sightOf(balance, weapon))`, at the
  `getWeaponSight(weapon)` anchor, visible at any range.
- **New guns** (`lmg`, `dmr`, `sniper`): `createWeaponModel` already covers them. Check that `shotFired` handles
  them for tracers and muzzle flash.

**Current tsc errors (5), yours:** `PlayerViews.ts` 3 (the `PlayerAnim` default and `HeldId` in the weapon model
lookup), `cameraRig.test.ts` 1, `helpers.test.ts` 1.

### ui-ux-designer (`src/ui/`): 2a-C10
Art specs: `docs/art/STYLE.md` §17 has the reticle and scope SVGs (iron, red dot, 4x, 8x), and §18 has the HUD and
kill-feed icon specs for the M2a items (`src/ui/icons.ts`).
- **Crosshair, ADS and scope:** use `HudView.ads`. When `ads.cameraBlend` > 0 and the sight is iron or red_dot,
  shrink the crosshair to a dot (a red dot for `red_dot`). When `ads.scoped`, show the full-screen scope overlay
  (a different reticle for 4x and 8x). The cone size is still `crosshairSpreadDeg`. Hip-fire ADS-blocked hints come
  from `hud.ads.*`.
- **Slots:** `HudLocalView.slots` now has four entries. Slot 3 is `'grenade'` with `count` (dimmed at 0). Use
  `HudLocalView.weapon` as the `HeldId`.
- **Armor:** `HudLocalView.vest` and `helmet` are `HudArmorView | null`. Show tier numerals and colours, and a
  `ceil(durability) / maxDurability` bar (`hud.gear.durability`). `armor` and `maxArmor` are gone.
- **Stance icon:** from `stance`, `stanceFrom` and `stanceProgress`.
- **Cook ring:** from `HudLocalView.cook`; it turns red when `fuseRemainingMs` <= 1000.
- **Grenade danger:** draw `HudView.grenadeDanger` icons using `bearing`, on screen or at the screen edge.
- **Hit markers:** `localHitConfirmed.vest` and `helmet` give the armor-hit and helmet-hit variants and the break
  flash. `playerDamaged` with `isLocalVictim` replaces the old `armorBefore`/`armorAfter` logic.
- **Kill feed:** `playerKilled.weapon` may be `'grenade'`, which shows the grenade icon.
- **Pickup prompt:** `interactPromptChanged.durability` gives "[E] Vest (Lv 2) 31/55", and `refusal` lets the
  prompt warn before the press. The refusal strings are in the table above.
- **Settings:** `adsMode` (Hold/Toggle, default `DEFAULT_ADS_MODE`) and `adsSensitivity` (0.1..3, default
  `DEFAULT_ADS_SENSITIVITY`). Both are optional in `Settings`. Add them to `normalizeSettings`, `settingsEqual` and
  the tests. Controls help covers RMB, C, Z, Space, 4/G and the wheel.

**Current tsc errors (30), yours:** `logic.test.ts` 14, `logic.ts` 7, `Ui.ts` 4, `hud.ts` 3, `icons.ts` 2. These
cover the `vest` id, `armor`/`maxArmor`, `armorBefore`/`armorAfter`, `HeldId` in the kill feed, and exhaustive
switches over `ItemId`.

### audio-designer (`src/audio/`): 2a-C11
- **Shots:** `shotFired` has the `lmg`, `dmr` and `sniper` weapons. The sniper bolt-cycle sound plays
  `weapons.sniper.fireIntervalMs` after the shot, using the injected balance.
- **Armor:** in `playerDamaged`, a vest hit is `vest !== null` (pitch by `vest.tier`) and a break is
  `vest?.broken`. The helmet works the same way. This replaces the `armorBefore`/`armorAfter` logic in
  `AudioDirector.ts:134`. `localHitConfirmed.vest`/`helmet` drive the attacker-side variants.
- **Stance:** on `stanceChanged`, play the cloth rustle (positional for remotes, about 15 m, 2D when `isLocal`), and
  the prone thud `durationMs` later when `to === 'prone'`. Crouch and crawl footsteps: `footstep` is unchanged, so
  read the stance from FrameView only if needed (or ask game-developer to add `stance` to `footstep`).
- **ADS:** `localAdsChanged` gives the rustle, plus the scope-in lens sound when the sight is a scope.
- **Grenades:** `grenadeCooked` (pin click, about 10 m), `grenadeThrown` (whoosh unless `dropped`),
  `grenadeBounced` (clink pitched by `speed`, a plop on `'water'`), and `explosion` (very loud, positional about
  120 m; play the muffled ring when `localDistance !== null && localDistance <= radius`). The fuse tick from live
  grenades within about 8 m can come from `FrameView.grenades` through main.ts if you need it. Ask tech-lead before
  adding a facade method.
- **Equip:** `itemPickedUp` with an armor item (`isArmorId(item)`) plays velcro for vests and a strap click for
  helmets.

**Current tsc errors (32), yours:** `AudioDirector.test.ts` 19, `AudioDirector.ts` 5, `AudioEngine.test.ts` 4,
`soundMap.ts` 3, `soundMap.test.ts` 1. The causes are `armorBefore`/`armorAfter`, the `vest` id, an exhaustive
`ItemId` switch, and the new `interactPromptChanged` and `localHitConfirmed` fields.
**Failing vitest:** `soundMap.test.ts` (2).

### qa-tester (`tests/`): 2a-D1
- Map every acceptance test in combat.md, stance.md, armor.md, grenades.md and loot.md to a Vitest test (most will
  live next to the sim code, written by game-developer) or to a manual step in `docs/qa/`.
- E2E: RMB zoom and scope overlay, the C/Z/Space stance flow, key 4/G and a grenade throw, a no-Ctrl binding check,
  and the HUD vest, helmet, grenade and stance elements.
- Grep checks in sim for `Math.random`, `Date.now` and `performance.now` (D2 risk row).
- M1 tests to update: `tests/sim/zone-collapse.test.ts:30` (`player.maxArmor`; the only tsc error, 1) and
  `tests/integration/pvp-over-ws.test.ts` (2 failing at runtime: protocol v2 and the new damage shape). Check any
  e2e that reads `armor`.
- Pacing: `npx tsx src/shared/sim/tools/matchReport.ts --matches 30 --variant both` once C4 lands (median 330-480
  s; no gun above 35% of weapon kills).

### level-designer, narrative-designer (requests)
- level-designer: no type errors. `MapData` is unchanged. C12 only if the loot tables need more epic spawns.
- narrative-designer: add `hud.stance.tooDeep` (see the table above). The item names for the new ids already
  exist (`item.<id>.name`).

## 15. M2b build contract ("Office, Drop & Rooms")

Decisions: [ADR 0005](../adr/0005-m2b-maps-indoor-office-and-carrier-drop.md) (map union, indoor geometry, per-map
balance, map switching, nav, zone theme, carrier drop) and [ADR 0006](../adr/0006-m2b-rooms.md) (rooms, a World per
match, the vote in the room).
Specs:
- `docs/design/systems/{maps,drop,rooms}.md`
- `docs/design/levels/office.md`
- `docs/ui/UI.md` §12
- NETCODE.md "Rooms (M2b proposal)"
- STYLE.md §19

The same rules apply as in §12 and §14: edit only your own files, and ask tech-lead for shared changes.

**State of the tree after Phase B:** `npx tsc --noEmit -p .` was clean and `npx vitest run` was green. Every M2b type
was in `src/shared/`, but the breaking parts waited behind the **C-gate** (ADR 0005 §1), so M2a QA was never blocked.
**The C-gate was done on 2026-11-18.** Every "At the C-gate" item below is now in the code. The residue per owner is in
[REVIEW-M2b.md](REVIEW-M2b.md).

### 15.1 What is in the shared contract now
| Area | Now (Phase B) | At the C-gate (tech-lead, one commit) |
|---|---|---|
| Maps (`types.ts`) | `AnyMapData = IslandMapData \| IndoorMapData`, `MapBase`, `LootSpawn.y?`, `Rect`, `WallSegment`, `WallMaterial`, `FloorMaterial`, `FloorZone`, `IndoorPropPlacement`, `KitV3`, `KitCollider`, `PropKitEntry`, `PropKit`, `ClimbRoute`, `CarrierModel`, `MAP_KINDS`. `MapData` = `IslandMapData` (transitional; `kind` and `carrier` optional) | `MapData = AnyMapData`; `kind` and `carrier` required |
| Map helpers (`maps.ts`, new) | `isIndoor`, `mapBounds`, `mapExtent`, `wallFrame`, `carrierPosAt`, `carrierHeading`, `validateIndoorMap`, `CLIMB_JUMP_RISE_MAX` | none |
| Drop (`types.ts`) | `DropPhase`, `DropRoute`; field blocks `DropMovementFields`, `DropStepFields`, `PlayerDropFields`, `LocalDropFields`, `MatchMapFields`, `DropSimEvent` | merged into `MovementState`, `MovementStepResult`, `PlayerState`, `LocalPlayerState`, `MatchState` and `SimEvent` (all required) |
| Surfaces | `GlassSurface`, `IndoorSurface` | `ImpactSurface` and `GrenadeContactSurface` `\| 'glass'`; `Surface \| FloorMaterial` |
| Rooms (`types.ts`) | `MapId`, `MapVoteOption`, `RoomMapMode`, `MapPickVia`, `RoomId`, `MemberId`, `RoomVisibility`, `RoomPhase`, `ROOM_PHASES`, `ROOM_CODE_ALPHABET`, `ROOM_CODE_LENGTH`, `normalizeRoomCode`, `RoomSettings`, `RoomSummary`, `RoomMember`, `RoomState`, `RejectCode`; `WelcomeInfo.roomId?` | `roomId` required |
| Views (`contracts.ts`) | `HudView.rooms?`, `.drop?`, `.zoneTheme?`; `HudMinimapView.route?`; `MinimapRouteView`, `HudDropView`, `RoomsView`, `RoomBrowserView`, `RoomListEntryView`, `RoomLimitsView`, `RoomView`, `RoomMemberView`, `MapVoteView`. First person: `CameraView.view?` (`CameraCase`), `.subjectId?`, `.roll?`; `FrameView.viewmodel?` (`ViewmodelView`, `ViewmodelAction`), `.reducedMotion?`; `HudView.cameraView?`, `spectate.view?`; `Settings.fovDeg?`, `.headBob?`, `.reducedMotion?`; `FP_FOV_MIN_DEG`, `FP_FOV_MAX_DEG`, `DEFAULT_FP_FOV_DEG`, `FP_FOV_REFERENCE_ASPECT` | `rooms`, `drop`, `zoneTheme`, `route`, `view`, `viewmodel`, `cameraView` required; `cameraFovDeg` required |
| Facades (`contracts.ts`) | optional room methods on `INetClient` and `IClientGame`; optional `NetHandlers.onHello/onRoomList/onRoomJoined/onRoom/onRoomLeft/onReject`; `ServerHello`; `UiCallbacks.on{RefreshRooms,CreateRoom,JoinRoom,LeaveRoom,SetRoomSettings,StartMatch,CancelCountdown,SetReady,Vote,Kick}`; `RoomSettingsInput`, `RoomJoinTarget`; `CLIENT_TOKEN_STORAGE_KEY` | room methods required on `INetClient` and `IClientGame` |
| GameEvents (`events.ts`) | `mapChanged`, `carrierDeparted`, `playerJumped`, `parachuteOpened`, `roomJoined`, `roomJoinFailed`, `roomCreateFailed`, `roomLeft`, `roomHostChanged`, `roomMemberChanged`, `roomSettingsChanged`, `mapVoteLocked` | none |
| Balance (`balance.ts`) | required `drop` (`DropBalance`); optional `movement.stances.pronePitchMinDeg/MaxDeg` (pair, ±80), `clientFeel` FP keys and `fpRecoil` (validated); optional `maps` (`MapBalanceEntry`, validated, merged), `rooms` (`RoomsBalance`), `bots.drop`, `bots.nav`, `match.mapVoteLockSeconds`, `zone.indoorCenterInset`, personality `jumpTimingBiasMs` and `dropEpicWeightMultiplier`; `deepMergeBalance`, `balanceForMap`, `zoneThemeOf`, `ZoneTheme`, `ZONE_THEMES`, `MAP_OVERRIDE_FORBIDDEN`, `OPEN_RECORD_PATHS` | `maps`, `rooms`, `bots.nav`, `mapVoteLockSeconds`, `indoorCenterInset` and `pronePitchMin/MaxDeg` required; `CLIENT_FEEL_FP_KEYS` (incl. `carrierCameraDistance`) and `fpRecoil` (`FpRecoilBalance`) join `ClientFeelBalance` (validated already; game-developer adds the matching `ClientTuning` keys, since `tuning.test.ts` pins the key set); `match.dropHeight` and `spawnJitter` optional |
| Protocol | none | `PROTOCOL_VERSION = 3` |

**C-gate trial (2026-11-18).** Flipping `MapData` to the union with a required `kind` gave 83 tsc errors. This is
each owner's island-coupling checklist (do it before the gate by switching your signatures to `AnyMapData`):

| Owner | Files (errors) |
|---|---|
| game-developer | `sim/terrain.ts` 7, `sim/terrain.test.ts` 10, `sim/colliders.test.ts` 5, `sim/colliders.ts` 2, `sim/testkit.ts` 2, `sim/movement.test.ts` 2, `sim/movement.ts` 1, `sim/grenade.ts` 1, `sim/grenade.test.ts` 1, `sim/World.test.ts` 1, `game/camera.ts` 2, `game/testFixtures.ts` 1 |
| graphics-engineer | `Water.ts` 6, `TerrainMesh.ts` 6, `Renderer.ts` 6, `helpers.test.ts` 6, `m1fix.test.ts` 5, `PropLayer.ts` 3, `visualTerrain.ts` 1 |
| level-designer | `levels/island.test.ts` 7, `levels/island.ts` 2 (add `kind: 'island'`, `carrier: 'seaplane'`) |
| ui-ux-designer | `minimap.ts` 5 |
| qa-tester | `tests/sim/m2a-edge.test.ts` 1 |

The other gate items add expected errors in exhaustive tables:
- `protocol/messages.ts` (`PLAYER_FIELDS`, the movement and local tables, `SURFACES`, `GRENADE_SURFACES`,
  `EVENT_CHECKS`): network-engineer;
- `vfx/Vfx.ts` `SURFACE_CODE`: graphics-engineer;
- `soundMap.ts` `impactCue`: audio-designer;
- `tuning.ts`: game-developer, for `carrierCameraDistance`.

**Gate procedure.** Each owner reports "C-gate ready". tech-lead flips. Owners fix any residue the same day.

### 15.2 Data flow (M2b additions)
```
server: RoomManager ── GameRoom (waiting/countdown, votes, host) ──lock──▶ resolveMapChoice ─▶ balanceForMap ─▶
        prepareMap (cached per map id) ─▶ createWorld({ runtime, matchStart, timeOriginMs }) ─▶ welcome{mapId} ─▶ ...
client: NetClient(hello, room msgs) ─▶ ClientGame ─▶ HudView.rooms / room GameEvents ─▶ Ui
        welcome{mapId} ─▶ ClientGame: getMap, balanceForMap, MovementContext cache, reset ─▶ bus mapChanged ─▶
        Renderer (rebuild scene) / Ui (minimap, theme) / Audio (ambience, zone loop)
        snapshot MatchState.route ─▶ ClientGame: carrier pose, HudMinimapView.route, HudDropView, CameraView view 'carrier'
        prediction + snapshot.local ─▶ ClientGame camera.ts ─▶ CameraView (FP eye, bob, roll, FOV) + FrameView.viewmodel ─▶ Renderer (2 passes)
```

### 15.3 game-developer (`src/shared/sim/`, `src/game/`)
**Sim deliverables (exact exports):**
- `terrain.ts`: dispatch on `kind` for `heightAt`, `surfaceAt` (indoor: floor zones) and `raycastTerrain` (indoor:
  the floor and ceiling planes), as in ADR 0005 §2. `coastlineRadius` is island only.
- `colliders.ts`:
  - `buildColliders(map: AnyMapData, stepHeight: number)` builds walls through `wallFrame`, kit parts through the
    placement transform, ramps as stairs (rise <= 0.8 x stepHeight), and `Collider.glass`. The grid comes from
    `mapBounds`.
  - `raycastStatic` returns kind `'glass'`.
  - Indoor grid: insert boxes by oriented-box cell coverage, not by bounding circle (a 68 m wall would otherwise fill
    dozens of cells), or split walls into <= 10.8 m modules (office.md T6). Budget: about 1,250-1,400 parts.
- `movement.ts`:
  - Indoor bounds: the floor rectangle inset by `player.radius`.
  - The drop phases (`DropMovementFields`, `DropStepFields`, ADR 0005 §8). Use the per-map balance only.
  - `MovementContext` is unchanged.
  - Also export `prepareMap(map: AnyMapData, balance: Balance, opts?: { nav?: boolean }): MapRuntime` with
    `MapRuntime = { map, balance, ctx: MovementContext, nav: NavGraph | null }`. `nav` is built only for indoor
    maps and only when `opts.nav !== false`. ClientGame passes `{ nav: false }`.
- `grenade.ts`: the indoor rectangle edge and the ceiling bounce, and `'glass'` contacts. Fold in REVIEW-M2a M2 (an
  optional `out` buffer in `predictGrenadeArc`).
- `zone.ts`: the indoor centre rule (`zone.indoorCenterInset`). The first centre is (0, 0) on every map.
- `loot.ts`: `LootSpawn.y`. `World.ts`:
  - `WorldOptions.{timeOriginMs?, matchStart?, runtime?, drop?: boolean}` (`drop` defaults to true; false = the M1
    spawn, for tests) and `World.finished`.
  - The route at creation (`MatchMapFields`).
  - Aboard rules: invulnerable, untargetable, and ignored by zone damage and blasts. Only look and the jump edge
    work aboard.
  - Jump and auto-eject.
  - The events `dropJump` and `chuteOpen`.
  - Bot drop picks (drop.md).
- `mapVote.ts` (new): `resolveMapChoice({ pin, mode, votes, maps, previous, rng }): { mapId, via }` (ADR 0006 §4,
  maps.md tests 1-4).
- `nav.ts` (new): the API in ADR 0005 §6. bots.ts uses it on indoor maps: paths, climb routes with jumps, zone
  urgency by path length, and the per-tick budget.
- Tests:
  - drop.md 1-13 (sim parts) and maps.md 10-17b and 19-20;
  - nav determinism (a hash per map);
  - the World with `matchStart` and `timeOriginMs`;
  - a prediction-equivalence test through a jump and a manual deploy.

**Client deliverables:**
- `ClientGame`:
  - Map switching per ADR 0005 §5: the `mapChanged` emit and a `MovementContext` cache per map id.
  - Room state into `HudView.rooms` and the room GameEvents.
  - The room intents (`IClientGame` methods).
  - The `hello` client token through NetClient.
  - The carrier camera (CameraView `view: 'carrier'`), the aboard view position from `carrierPosAt`, `HudDropView`,
    and `HudMinimapView.route`.
  - **First person (ADR 0005 §9, camera.md):** `camera.ts` builds every `CameraCase`: FP on foot, freefall, chute
    and spectate; 3P carrier, death, V chase and results.
    - FP camera: the eye from `eyePoint`, plus bob and landing dip capped at `fpMaxCameraOffset` (0 at full ADS and
      with `Settings.headBob` off).
    - `roll` and the FOV punch come from `fpRecoil`.
    - Hor+ FOV from `Settings.fovDeg`; ADS FOV as true magnification from the default FOV.
    - `AdsView.zoom` is redefined as the look-speed divisor.
    - Build `FrameView.viewmodel` (local and FP spectate), `HudView.cameraView` and `spectate.view` (V toggles
      them).
    - Copy `Settings.reducedMotion` into `FrameView.reducedMotion` and scale everything per camera.md.
    - Add the sim helper `pitchLimits(m, b)` in `stance.ts` (prone clamp), used by World sanitize, bots and the
      client look clamp.
    - Stop reading `adsCameraDistance` and `adsCameraShoulderOffset`.
    - At the gate, add the FP `ClientTuning` keys.
  - A predicted local jump and deploy, with `playerJumped` and `parachuteOpened` for the local player from
    prediction.
  - `carrierDeparted`. F maps to the `jump` edge only while aboard or dropping.
  - `HudView.zoneTheme`.
- Fill the M2a addendum fields too: `footstep.stance`, `interactPromptChanged.maxDurability`,
  `HudGrenadeDangerView.fuseRemainingMs` and `HudView.adsBlocked`. Read `items.grenade.dangerMargin` and
  `bots.ads.scopedFireMinProgress`.
- REVIEW-M2a M1: extract `src/shared/sim/actions.ts` (the shared action step) before adding drop actions to the
  predictor.

**Must not touch:** shared `src/shared/*.ts`, `src/shared/kits/`, protocol, server, net, render, ui and audio.

### 15.4 network-engineer (`src/shared/protocol/`, `server/`, `src/net/`)
- **Server:** `server/Session.ts`, `server/GameRoom.ts` and `server/RoomManager.ts` per NETCODE R1/R6 and ADR 0006,
  with the room lifecycle of ADR 0006 §2:
  - World creation at the lock, through `resolveMapChoice`, `balanceForMap` and a `prepareMap` cache per map id.
  - `matchStart` and `timeOriginMs`.
  - Rooms rules from `balance.rooms`.
  - Host migration, kick via the client token (never IP), and `cancelCountdown`.
  - `server/config.ts`: `MAX_ROOMS`, `MAX_CONNECTIONS`, `MAP` (validated against the level ids; an invalid value
    warns once) and `SEED`.
  - Server startup also runs `validateIndoorMap` for every indoor level, and checks that every map id has a
    `maps.<id>` entry once the block exists.
- **Protocol** (`messages.ts`):
  - `hello` (`clientToken?`) and the legacy `join` → `bad_version`; every R3 message plus `cancelCountdown`; `rid`
    echo; the `RoomState` and `RoomSummary` shapes from `types.ts`.
  - At the gate: the `PlayerDropFields`, `LocalDropFields`, `DropMovementFields`, `MatchMapFields` (`route`
    validated: finite numbers, `startsAt <= noJumpUntil <= ejectAt <= endsAt`), the `dropJump` and `chuteOpen`
    events, the `'glass'` surfaces, and `PROTOCOL_VERSION` 3.
- **Net:**
  - NetClient sends `hello` (with the token from `CLIENT_TOKEN_STORAGE_KEY`; create it if missing).
  - It implements the `INetClient` room methods and handlers, applies `roomListDelta` (resubscribing on a `rev`
    gap), and resets the delta decoder and the snapshot buffer on every `welcome`.
- **Tests:** NETCODE R7, including the multi-room no-leak test and the delta rebuild across a World swap.
- Fold in REVIEW-M2a L5 (import `MAX_MOVE_INPUT_LEN`).

### 15.5 level-designer (`src/game/levels/`)
- `office.ts`: `export const OFFICE: IndoorMapData` (id `'office'`, `carrier: 'drone'`, `kit: OFFICE_KIT`). Floor,
  walls (solid and glass, doorways >= 3 m, lintels), floor zones, props, climb routes, loot spawns (with `y` on
  plateaus), zone centres, POIs (no real names) and fallback `playerSpawns`, all from `docs/design/levels/office.md`.
- `index.ts`:
  - `MAPS = { island01, office }` typed `Record<string, AnyMapData>`.
  - `MAP_IDS` in display order (`['island01', 'office']`).
  - `getMap` returns `AnyMapData` (after the gate).
- `island.ts`: add `kind: 'island'` and `carrier: 'seaplane'`.
- Tests: `validateIndoorMap(OFFICE, stepHeight)` is empty, plus the maps.md 17 level checks (with the sim's
  colliders through `prepareMap`).
- **Answers to office.md §11 T1-T10:**
  - **T1 shape:** use `IndoorMapData` as defined. The differences from the proposal:
    - Walls carry `bottom` and `top` (27) instead of `height`.
    - There is **no `doors` array**: door frames are ordinary `doorFrame` props (their jambs and lintel are kit
      colliders), and the wall runs are already split at the gaps.
    - Climb routes are `{ id, points, mode?, plateau? }`.
    - Loot spawns are `{ x, z, tier, y? }`, so give `y` on every plateau spawn.
  - **T2:** `IndoorPropPlacement.y` is required (0 on the floor).
  - **T3:** yes, `LootSpawn.y`.
  - **T4:** no: island `PropKind` is unchanged. Indoor kinds are `kit` keys (`OFFICE_KIT`, moved to
    `src/shared/kits/office.ts`). Kit ramps compile to stairs in the sim (0.8 x stepHeight rises). Your 20-step
    whiteboard ramp needs nothing extra.
  - **T5:** multi-part kit entries are supported as listed.
  - **T6:** game-developer sizes the grid from `mapBounds` and inserts boxes by OBB cell coverage (or splits walls
    longer than 10.8 m), §15.3.
  - **T7:** yes, ADR 0005 §2.
  - **T8:** the nav grid is built once per map on the server (`prepareMap` cache), never per match.
  - **T9:** spawn sets are dropped. The carrier drop replaces spawns (ADR 0005 §8), `playerSpawns` is a flat
    fallback list, and bots pick drop targets from loot spawns (drop.md).
  - **T10:** the sim may merge vertically stacked boxes of one prop into one collider.
- **Superseded in office.md 7.1:** "y = 25 drop start" and `spawnJitter`. The start is the drone route
  (`maps.office.drop.carrierAltitude` 25), so update the text.

### 15.6 graphics-designer (`src/shared/kits/`, `src/render/procedural/`)
- First person: `viewmodel.ts` (done in Phase A). `VIEWMODEL_FOV` (50) must follow `clientFeel.viewmodelFovDeg`
  (55), because the balance key wins. The graphics-engineer passes it in. Keep `VIEWMODEL_FOV` only as a fallback,
  or delete it.
- Move the collider, size and origin tables of `OFFICE_PROP_INFO` into `src/shared/kits/office.ts` as
  `OFFICE_KIT: PropKit` (types from `types.ts`; pure data, no three.js). Mark glass parts with `glass: true`.
- `office.ts` imports the kit. `getOfficePropInfo` = the kit entry plus `budget` and `notes`.
- A test asserts that the drawn bounds match `size` within a tolerance.
- Carrier models (`createCarrierModel('seaplane' | 'drone')`) and the parachute (`createParachuteModel(kind:
  'island' | 'napkin')`) for the graphics-engineer.

### 15.7 graphics-engineer (`src/render/`)
- **Map switching:** `Renderer` keeps the constructor map for the title screen. On `mapChanged` it disposes the
  current map's groups and builds:
  - island: terrain, sea, tide wall and `PropLayer`;
  - indoor: a new `IndoorScene` (floor with zone materials, walls through `wallFrame`, glass with see-through
    materials, kit props instanced per kind, ceiling clutter from the kit's `'ceiling'` origin, nothing above
    `ceilingHeight`) and a new `RainCurtain` for `zoneTheme === 'sprinklers'`.

  Use `mapChanged.balance` for per-match numbers.
- **Camera:** behaviour by `CameraView.view`.
  - `firstPerson`: the camera exactly at `target`, `roll` applied, near plane <= 0.05 m, no boom collision, no body
    fade, and `subjectId`'s body hidden (own shadow optional).
  - 3P cases (`carrier`, `chase`, `death`, `results`): the existing rig with floor and ceiling clamps and wall fade or
    cut-away. For `carrier`, the carrier model moves along `carrierPosAt`, and aboard characters are hidden.
- **Viewmodel pass:** render `FrameView.viewmodel` in a second pass at `clientFeel.viewmodelFovDeg` with
  `src/render/procedural/viewmodel.ts`:
  - poses from `VIEWMODEL_POSES` (ADS pose blend by `adsBlend`; the `sight` anchor at the screen centre at 1);
  - action animations by `action` and `actionProgress`, and recoil kick per `shotCount` increment from
    `fpRecoil` (x `fpAdsRecoilFactor` in ADS, 2x stack cap);
  - bob and sway from `bobPhase`, `bobAmount`, `lookRate` and `motionScale`;
  - hidden when `visible` is false;
  - the canopy over the eye when `dropPhase === 'chute'`.

  No camera shake when `FrameView.reducedMotion`. Render's `PRONE_PITCH_MIN/MAX` read
  `movement.stances.pronePitch*Deg`.
- **Drop visuals:** freefall pose and speed lines, the parachute when `dropPhase === 'chute'`, `playerJumped` hatch
  puff and `parachuteOpened` pop.
- **Glass:** `'glass'` impact sparks and decals. Minimap is not yours.
- **Performance:** the office at 60 fps on integrated GPUs with instancing (§11). Measure draw calls with all
  desks in view.
- REVIEW-M2a: remove the `BALANCE` fallback (M3 from REVIEW-M1 is still open).

### 15.8 ui-ux-designer (`src/ui/`)
- UI.md §12, from `HudView.rooms` and the `UiCallbacks` room intents:
  - browser, create dialog, waiting room, vote panel, countdown map card, toasts;
  - deep links `?room=` (with `normalizeRoomCode`) and `?map=`.
- **Indoor minimap:** walls (glass lighter), floor zones, and plateau outlines from kit `size` for desk kinds. Also
  the route overlay from `HudMinimapView.route`.
- **Aboard and freefall HUD** from `HudView.drop`.
- **Zone strings** by `HudView.zoneTheme`.
- Fold in REVIEW-M2a: `adsBlocked` hints, the prompt `maxDurability`, the danger `fuseRemainingMs` (M6), and
  importing the shared `isScopeSight` (L2).
- **First person (UI.md §13):**
  - Settings gets the FOV slider (`FP_FOV_MIN_DEG`..`FP_FOV_MAX_DEG`, default `DEFAULT_FP_FOV_DEG`, stored as
    `Settings.fovDeg`), head bob and reduce motion. `Settings.headBob` and `Settings.reducedMotion` are the
    *effective* values; the auto/on/off and system prefs stay Ui-only.
  - The crosshair is at the screen centre, with the ADS fade from `adsCrosshairFade*`.
  - The V hint and the spectate view label come from `HudView.spectate.view` and `cameraView`.
  - The drop state comes from `HudView.drop.stage` (not a new `HudLocalView.dropPhase`).

### 15.9 audio-designer (`src/audio/`)
- **On `mapChanged`:** the theme loops (tide or sprinkler rain), indoor reverb and ambience. Use
  `mapChanged.balance`.
- **Drop:** the carrier engine (seaplane or drone) from `carrierDeparted` until `route.endsAt` (positional from
  `carrierPosAt`), the cabin muffle while aboard, the `playerJumped` whoosh, the freefall wind, the
  `parachuteOpened` pop and the `'glass'` impact.
- **Footsteps:** use `footstep.stance` (REVIEW-M2a M4) and the indoor surfaces after the gate.
- **Grenades:** implement `IAudio.setGrenades` (ADR 0004 A2).
- Remove the `BALANCE` fallback (REVIEW-M2a M5).

### 15.10 game-designer (`docs/design/balance.json`)
- Add `maps` (`island01: { zoneTheme: 'tide' }`, `office` from maps.md §3 plus `drop` overrides from drop.md).
  `validateBalance` will check every path.
- Add `rooms` (rooms.md), `bots.nav` (maps.md §4), `match.mapVoteLockSeconds`, `zone.indoorCenterInset` and
  `bots.ads.scopedFireMinProgress`.
- First person:
  - Delete `clientFeel.fpFovDefault`, `fpFovMin`, `fpFovMax` and `fpFovReferenceAspect`. The settings range is
    `FP_FOV_*` in contracts.ts (ADR 0005 §9).
  - Add `clientFeel.carrierCameraDistance`.
  - Delete `adsCameraDistance` and `adsCameraShoulderOffset` once game-developer stops reading them.

### 15.11 narrative-designer (`src/content/strings/`)
- Theme sets for `tide`, `sprinklers` and `lightsOut`.
- Room, browser and vote strings (UI.md §12.12), `map.<id>.*`, and the drop HUD strings.
- First person: the FOV, head bob and reduce motion setting labels, and the V hint (UI.md §13.6).
- `room.create.name.default` with `{name}`.

### 15.12 build-engineer
- README: `MAX_ROOMS`, `MAX_CONNECTIONS`, `MAP` and `SEED`.
- ESLint `no-restricted-imports`: `src/shared/sim/**` may not import `src/shared/kits/**` (§3).
- A CI check that `tsc` is clean after the C-gate.

### 15.13 qa-tester (`tests/`)
- Map the acceptance criteria to Vitest or manual steps: maps.md 1-21, drop.md 1-13, rooms.md 1-11 and camera.md 1-12
  (camera math headless in `camera.test.ts`; sight-anchor and wall-clip checks in Playwright).
- **E2E:** two contexts, a private room, join by code and by `?room=`, back to the same waiting room after results,
  and an office match with a carrier jump.
- Fix `tests/sim/m2a-edge.test.ts` for the gate.

### 15.14 tech-lead (after Phase C)
- The C-gate commit.
- `main.ts`: forward the new `UiCallbacks` to `IClientGame`, pass `balance` to `AudioEngine`, and call
  `audio.setGrenades` (the edits pending from REVIEW-M2a).
- The D2 review of M2b.
