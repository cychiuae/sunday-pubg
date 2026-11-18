# ADR 0004: M2a "Arsenal & Stance": stance, ADS, grenades and two-piece armor in the shared sim

- Status: Accepted
- Date: 2026-11-18
- Owner: tech-lead
- Related: [ARCHITECTURE.md](../tech/ARCHITECTURE.md) §14 (build contract), [ADR 0001](0001-stack-and-netcode.md),
  [ADR 0002](0002-m1-netcode-and-boundary-clarifications.md); specs
  [combat.md](../design/systems/combat.md), [stance.md](../design/systems/stance.md),
  [armor.md](../design/systems/armor.md), [grenades.md](../design/systems/grenades.md),
  [loot.md](../design/systems/loot.md)

## Context
M2a adds aim down sights, crouch and prone, three new guns, tiered vests and helmets, and frag grenades. Four of
these touch the netcode model from ADR 0001/0002:
- Stance and ADS change movement speed, so they must be predicted or the local player rubber-bands.
- Stance changes the hitbox and the eye height, which the server needs for hitscan and blast line of sight.
- Grenades are the first non-player moving entity. They need a snapshot list, events, and a client view.
- Armor goes from one number to two pieces whose durability other players must not see.

Contract code: [`types.ts`](../../src/shared/types.ts), [`events.ts`](../../src/shared/events.ts),
[`contracts.ts`](../../src/shared/contracts.ts), [`balance.ts`](../../src/shared/balance.ts),
[`constants.ts`](../../src/shared/constants.ts).

## Decision

### 1. Stance lives in `MovementState` and the shared movement step owns every stance rule
- `MovementState` gains `stance` (target), `stanceFrom` and `stanceMs` (remaining transition ms, 0 = settled).
- `PlayerInput.stanceToggle: 'crouch' | 'prone' | null` is a new edge. Space stays the existing `jump` edge, and
  the step decides whether it jumps or changes stance. Sprint-from-crouch is read from the held `sprint`.
- `stepMovement` runs the stance.md per-tick order: forced water stand-up, then the request, then validation
  (water depth from `heightAt`, headroom from `ctx.colliders`), then the timer, then ADS, then motion. Stance
  multipliers are applied **inside** the step, never folded into `MovementInput.speedMultiplier` by callers.
- The step reports `stanceChanged` (World emits SimEvent `stanceChange`) and `stanceRefused` (World emits
  `actionFailed { action: 'stance' }` for humans). Both are plain return values, so the step stays pure.
- The client predicts stance exactly like position. Reconciliation replays pending inputs from
  `local.movement`, which now includes the stance fields. Headroom and water use the same map, colliders and
  balance on both sides, so a correct client never mispredicts. This is acceptance test 16 of stance.md.
- Sim helpers for eye height, hitbox height, chest point and progress go in a new `src/shared/sim/stance.ts`
  (game-developer). They are the only implementation, used by World, bots, ClientGame (camera pivot) and tests.

### 2. Hitbox model per stance
All three shapes are tested by one function, `rayHitbox` in `stance.ts`, which replaces the M1 `rayCylinder` call
site in World hitscan.
| Stance (settled) | Shape | Head zone |
|---|---|---|
| stand | vertical cylinder, r `player.radius`, h `stances.stand.height` | hitY >= feetY + h x (1 - `player.headZoneFraction`) |
| crouch | vertical cylinder, r `player.radius`, h `stances.crouch.height` | hitY >= feetY + h x (1 - `combat.hitbox.crouchHeadZoneFraction`) |
| prone | level box, bottom at feetY, **centred on the feet position (x, z)**, long axis along the look yaw, `proneLength` x `proneWidth` x `stances.prone.height` | the front `proneHeadLength` m (toward the look direction) |
| any transition | cylinder of the taller of `stanceFrom` / `stance` | as that stance |

- **The prone box is centred on `PlayerState.pos`, the feet point.** It is not offset forward or back. The
  graphics-designer's chibi prone pose (`CHIBI_STANCES.prone.back = 0.62`, STYLE.md §16) already assumes this
  centring, so the drawn body and the hitbox line up. If the box centre ever moves, the designer changes `back` to
  match.
- The box uses the same yaw the snapshot carries (`PlayerState.yaw`). It turns instantly with the look yaw, like the
  M1 body. Remote clients can rebuild any hitbox from `PlayerState.{pos, yaw, stance, stanceFrom, stanceProgress}`
  plus balance (debug views, QA). The client never runs hit tests itself, because there is no lag compensation.
- Collision radius stays `player.radius` in every stance. Collision height = hitbox height.

### 3. Grenades are deterministic sim projectiles with a snapshot list and client extrapolation
- **Physics** is one pure function, `stepGrenade(body, dt, ctx)` in `src/shared/sim/grenade.ts`, using the
  `MovementContext` (map, balance, colliders). It sweeps terrain, prop colliders and the world edge, gives at most
  one bounce per tick, handles rest and the one-off water damping, and returns the contact for `grenadeBounce`.
  **It uses no RNG at all**: identical launch state means an identical path on server and client. Randomness that
  touches grenades (the bot aim offset) comes from the World's seeded `Rng`. `Math.random` stays banned in sim.
- **Lifecycle** is owned by the World: cook (pin pull; count - 1), throw or drop, flight, explosion (fuse <= 0
  after moving), and removal. Ids are sequential per match. Several explosions on one tick resolve in id order.
  At match end grenades are removed without exploding.
- **Explosion**: `explosion` event first, then one `damage` event per victim (cause `'explosion'`, `grenadeId`,
  vest only), then kills. Line of sight goes from `pos + (0, losHeightOffset, 0)` to the stance chest point
  (`stance.ts` `chestPoint`) against terrain and props, using the existing `lineOfSight`. Players never block.
- **Wire**: `WorldSnapshot.grenades: GrenadeState[]` with `{id, ownerId, pos, vel, explodesAt, inWater}`. That is
  every field `stepGrenade` needs to continue the path. Events are `grenadeCook`, `grenadeThrown` (`dropped` for
  swap-away, death and disconnect), `grenadeBounce` and `explosion`.
- **Client view: extrapolated, not interpolated.** ClientGame keeps each grenade's latest authoritative sample
  (snapshot or `grenadeThrown` event, stamped with its server time). It re-runs `stepGrenade` at `SIM_DT` up to
  `net.serverNow()` and lerps inside the last tick. Extrapolation stops `GRENADE_EXTRAPOLATION_MAX_MS` (250) past the
  sample. The result goes to `FrameView.grenades`. The grenade is drawn at **present** server time, so the
  `explosion` event (sent on its tick) matches the drawn position. Snapshot quantisation (3 decimals) and engine
  `Math.sin` differences make the result visually exact, not bit-exact, and every snapshot re-anchors it. A
  grenade disappears on `explosion`, or when a snapshot no longer lists it. Remote players stay interpolated 100 ms in
  the past (ADR 0002 §2). That mismatch is accepted.
- NetClient does not interpolate grenades. `InterpolatedWorld` is unchanged apart from `stanceProgress`.

### 4. The arc preview is a pure sim function, called by ClientGame, drawn by the renderer
`predictGrenadeArc(launch, fuseRemainingMs, ctx, maxSeconds)` in `src/shared/sim/grenade.ts` samples
`stepGrenade` from `throwLaunch(...)`, the same launch function the World uses. ClientGame calls it each frame
while the grenade slot is active and ready or cooking. It passes the predicted eye, the live yaw and pitch, and
`fuseRemainingMs` (`items.grenade.fuseMs` before the pin pull, or `cookExplodesAt - serverNow()` while cooking).
The result goes to `FrameView.grenadeArc`. The renderer only draws the points and the ring, because §3 of
ARCHITECTURE forbids it from importing the sim beyond terrain and colliders. The preview is guaranteed to match the
real throw, because both use one function. The only error is the yaw and pitch changing between the frame and the
tick.

### 5. ADS is a held input bit, and its timer is predicted in `MovementState`
- `PlayerInput.ads` is held. The Settings hold/toggle option is converted to the held flag by ClientGame, so the
  server never knows the mode.
- `MovementState.adsMs` is the ADS timer. The step advances it while engaged and resets it to 0 otherwise. Engaged
  means `ads` held, held item sight not `'none'`, `!adsBlocked` (dead, reloading, healing, swapping, all passed in
  `MovementInput`), not dropping, and stance settled. Starting a stance transition sets it to 0 in the same step.
  `ads` held always suppresses sprint. While engaged, speed is multiplied by `adsMoveMultiplier`.
- Combat reads `adsProgress = adsMs / adsTimeMs` from the shooter's movement state for the spread `A` term. Because
  the timer is in `MovementState`, it is reconciled with position for free, and the crosshair and camera use the
  predicted value.
- **Where the client ADS view lives:** ClientGame builds one `AdsView` (`sight`, `progress`, `cameraBlend`,
  `zoom`, `scoped`) from the predicted state. It applies it to `CameraView` itself: `fovDeg`, `distance`,
  `shoulderOffset`, and the new `firstPerson`. It puts the same object in `FrameView.ads` and `HudView.ads`. The
  renderer drives the Three.js camera from `CameraView` (scope view: camera at the eye, local body, wearables and
  held item hidden). Ui draws the crosshair dot, red dot and scope overlay from `HudView.ads`. The camera math stays
  in one headless, testable place (`src/game/camera.ts`). The renderer adds only clipping avoidance, and Ui adds no
  math. The `adsExitBlendMs` ease-out is cosmetic and applies only to `cameraBlend` and `zoom`.
- Remote players get `anim.ads` (and `weapon`) for the scope glint. The renderer shows it when
  `isScopeSight(sightOf(balance, weapon))`.

### 6. Armor is two pieces; tiers are public, durability is private
- `SimPlayer` holds `vest` and `helmet` as `{tier, durability} | null` (armor.md damage formula per piece).
  `PlayerState` carries only `vestTier` and `helmetTier` (0 to 3), which replace `armor`. `LocalPlayerState`
  carries the pieces with durability. `LootState.durability` carries a ground piece's remaining durability.
- The `damage` event replaces `armorBefore` and `armorAfter` with `vest: ArmorHit | null` and
  `helmet: ArmorHit | null`, where `ArmorHit = {tier, absorbed, broken}`. One shotgun event can carry both.
  Clients get hit and break cues per piece without seeing remaining durability. `amount` stays the raw damage
  before armor.
- `ArmorId` is `vest_1..3 | helmet_1..3`. `ARMOR_PIECES` and `armorIdOf` map ids to and from slot and tier.
  `validateBalance` checks that `items.<id>.slot` and `tier` match the id.
- The placement tie-break `tickStartHpArmor` becomes `hp + vest.durability + helmet.durability`.

### 7. Held item, slots and ids
- `SlotIndex` is `0 | 1 | 2 | 3`. `GRENADE_SLOT = 3`. `HeldId = WeaponId | 'grenade'` is the type of
  `PlayerState.weapon`, `weaponSwitch.weapon` and `kill.weapon`. `balance.weapons` stays keyed by `WeaponId`, so
  code must narrow `'grenade'` before indexing. `sightOf(balance, held)` in `balance.ts` does this for sights.
- `SightType` lives in `types.ts`. Gameplay, camera, Ui and render read the sight from `balance.weapons.<id>.sight`.
  `src/render/procedural/weapons.ts` keeps its own `SightType` and `WEAPON_SIGHT_TYPES` only as a model-anchor
  mirror. The graphics-engineer should not use it for behaviour.
- `DeathCause` gains `'explosion'`. `FailedAction` gains `'swap' | 'stance'`, and `ActionFailReason` gains
  `'noGrenades' | 'tooDeep' | 'noHeadroom'`.

### 8. Protocol and balance gating
- `PROTOCOL_VERSION` is now 2 (constants.ts). There is no mixed-version play.
- Input validation: `ads` is coerced to boolean (absent = false). If `stanceToggle` is absent it becomes null. If
  it is present and not `'crouch' | 'prone' | null`, the frame is rejected as a bad frame. `selectSlot` is in
  {-1, 0, 1, 2, 3}. On an input-repeat tick (ADR 0002 §4), `ads` repeats like the other held fields and
  `stanceToggle` is null.
- Bandwidth: the new player fields are delta-encoded like the M1 ones. Steady state costs nothing; `stanceProgress`
  changes only during transitions. Grenades are sent as a full list in every snapshot, about 120 B each after
  quantisation. **Budget: 16 players plus 10 live grenades stays under the §11 limit of 8 KB per snapshot without
  loot.** network-engineer may delta-encode resting grenades if a measurement shows the need.
- `validateBalance` now covers every M2a key (see ARCHITECTURE §9). It rejects unknown `loot.tiers` item ids and
  unknown `bots.weaponPrefs` guns, skips `_` keys everywhere, and checks the internal constraints: sight none only
  for fists, armor slot and tier matching the id, `absorbFraction` in [0, 1), grenade `innerRadius < radius`,
  `throwSpeedMin <= throwSpeedMax`, and stand height and eye height equal to `player.height` and `eyeHeight`. The
  design invariants (armor effective HP, the sniper helmet rule) are asserted in `balance.test.ts`, not at runtime.

## Consequences
- The step's input grows (`held`, `adsBlocked`, `ads`, `stanceToggle`), and `toMovementInput` must compute the
  blockers from World state on the server and from `snapshot.local` on the client. Reload, heal and swap are still
  not predicted, so ADS can lag them by one RTT. This is the same accepted error as M1's heal slow-down.
- The LMG fire slow-down (`fireMoveMultiplier`) depends on shot timing, which is not predicted. ClientGame
  approximates it: fire held, LMG in hand, mag > 0, settled. Reconciliation hides the rest. It affects one weapon.
- A grenade path is computed in three places (World, ClientGame extrapolation, arc preview) through one function.
  A physics change is a single edit, and determinism has one test (grenades.md test 14).
- `HeldId` makes every `balance.weapons[state.weapon]` site a compile error until it is narrowed. This is
  intended: each site must decide what a grenade means.
- Removing `armor` from `PlayerState` and the damage event is a breaking change. It is gated by
  `PROTOCOL_VERSION` 2. M1 tests that used `armorBefore` and `armorAfter` must migrate (ARCHITECTURE §14).

## Alternatives considered
- **Stance and ADS as server-only state with snapshot correction.** Rejected. Both change speed, so every toggle
  would rubber-band at 100 ms RTT, which is the main risk in the PRODUCTION risk table.
- **ADS timer in a separate predicted "action state".** Rejected for M2a. It would need a second reconciliation
  path for one number. `MovementState` already has the right lifecycle.
- **Prone as a capsule, or as a cylinder lowered to prone height.** A capsule needs a new ray test with the same
  cost as a box but a fuzzier head rule. A short cylinder would leave the legs unhittable and does not match the
  pose. The box is what the spec defines, and it is cheap (slab test in yaw space).
- **Interpolating grenades 100 ms behind, like players.** Rejected. A cooked grenade exploding in flight would show
  its VFX up to about 1.5 m from the drawn grenade. Delaying explosion events to match would desync audio and
  damage feedback.
- **Arc preview computed in the renderer.** Rejected. It would make the renderer import sim physics (§3) and
  duplicate the launch math.
- **Public armor durability on `PlayerState`.** Rejected. It gives information the design does not want to show,
  and it costs bandwidth for every player. Tiers are enough to draw wearables and judge a target.

## Addendum (2026-11-18, Phase D2 review)
Review: [REVIEW-M2a.md](../tech/REVIEW-M2a.md). These decisions settle the game-developer's open interpretations and the
UI and audio contract requests. They are binding for M2b.

### A1. The sim agent's eight interpretations
| # | Interpretation | Decision | Notes |
|---|---|---|---|
| 1 | Stance water depth = `max(0, -max(terrainHeight, feetY))` | **Confirmed** | A dock deck or crate over water is dry. On the seabed it equals stance.md's `-terrainHeight`. Indoor maps (ADR 0005) have no water, so the depth is always 0. |
| 2 | A trigger press during a stance transition, swap or reload is dropped | **Confirmed** | No press buffering: a semi-auto or grenade press must be repeated once the block ends. Held fire on an automatic weapon resumes on its own (M1 behaviour). The same rule applies to the grenade pin pull. |
| 3 | A resting grenade is stateless | **Confirmed** | Rest = zero velocity plus support within `2 x collisionRadius` below the centre. There is no rest flag on the wire. This is required for exact extrapolation from `GrenadeState`. If geometry ever becomes dynamic, this must be revisited. |
| 4 | A water splash always emits `grenadeBounce` | **Confirmed** | It matches the SimEvent JSDoc ("or the water entry"). It fires at most once per grenade, because `inWater` is one-way. `bounceEventMinSpeed` does not apply to it. |
| 5 | Bots aim grenades by searching the shared arc prediction | **Confirmed, with a budget** | Deterministic, and it uses the same physics as the throw, so bots never mis-throw because of a model mismatch. It runs once per throw plan, never per tick. The aim error is applied to the aim point from the World `Rng` (`bots.grenade.aimErrorMetres`). The cost must be measured (REVIEW M3): p95 < 1 ms, at most one solve per tick across bots. |
| 6 | Scoped bots fire only at >= 90% ADS progress | **Confirmed, number moves to data** | Optional `bots.ads.scopedFireMinProgress` in [0, 1], default 0.9 (validated in `balance.ts`). |
| 7 | ADS never engages when `adsTimeMs` is 0 | **Confirmed** | `adsMs` stays 0, which is the "not engaged" state. `validateBalance` now requires `adsTimeMs > 0` for every weapon with a sight, so only fists (sight `none`) have 0. The stale "1 when adsTimeMs is 0" note in `MovementState.adsMs` is fixed. |
| 8 | `zone.ignoresArmor: false` routes zone damage to the vest only | **Confirmed** | Zone damage is whole-body area damage like a blast, and the helmet protects only against head hits. The shipped balance has `ignoresArmor: true`, so nothing changes in play. |

### A2. Contract additions (all optional, so no producer breaks)
- `GameEvents.interactPromptChanged.maxDurability?: number | null`: producer derived.ts (`items.<id>.durability` for
  armor). It lets Ui show "31/55" for tiers the player never wore.
- `HudGrenadeDangerView.fuseRemainingMs?: number`: producer grenades.ts, on the same clock as `HudCookView`.
- `HudView.adsBlocked?: 'reloading' | 'healing' | null` (`AdsBlockReason`): producer hudBuilder. It is non-null only
  while ADS is held with a sighted weapon. **'sprinting' was dropped**: holding RMB cancels sprint in the step, so it
  can never block ADS.
- `GameEvents.footstep.stance?: Stance`: producer ClientGame (local, predicted) and derived.ts (remote, interpolated).
  It replaces audio's inference from `stanceChanged` history, which is wrong for players first seen already crouched.
- `IAudio.setGrenades?(grenades, serverTime)`: **accepted, not deferred**. The fuse tick of nearby grenades is a
  readability cue, the data already exists in `FrameView.grenades`, and the call costs nothing. main.ts calls it once
  per frame after `setListener`. The range (about 8 m) and the skipping of the local player's own cooked grenade are
  audio tuning.
- `GrenadeBalance.dangerMargin?` (>= 0, default 2): balance.json already had the key, but the code hard-coded 2.
- `LootState.tier` JSDoc: drops take the per-item rarity table in loot.md, not 'common'.
- `isScopeSight` is now a type guard, so Ui can drop its copy.
