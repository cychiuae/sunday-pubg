# System: Stance (stand, crouch, prone) (M2a)

Numbers: `balance.json` `movement.stances`, `combat.stanceSpreadMultiplier`, `combat.hitbox`, `player.radius`, `player.headZoneFraction`.
Server-authoritative and **predicted**: stance lives in `MovementState` and is advanced by the shared movement step, so the client
predicts it exactly like position.

## Purpose
Give players a choice between mobility and a smaller, steadier body. Crouch is a quick peek-and-steady tool; prone is a commitment
(slow to enter, slow to leave, slow to move) that pays off with the lowest profile and the tightest spread. Each costs speed, and each
transition is a window where you cannot shoot, so stance spam is never free.

## Player-facing rules
| | Stand | Crouch | Prone |
|---|---|---|---|
| Speed multiplier | 1.0 (5.0 m/s walk, 7.2 sprint) | 0.55 (2.75 m/s) | 0.25 (1.25 m/s crawl) |
| Hitbox | cylinder r 0.45, h 1.3 | cylinder r 0.45, h 0.95 | flat box 1.5 x 0.8 x 0.6 along the look yaw (0.5 before BUG-008) |
| Eye height | 1.05 | 0.72 | 0.35 |
| Spread multiplier (settled) | 1.0 | 0.8 | 0.6 |
| Sprint / jump | yes / yes | Shift or Space stands you up first | no / Space goes to crouch |
| Water | any depth | depth <= 0.55 m | depth <= 0.2 m |

### Keys (mouse + keyboard)
- **C** toggles crouch: stand -> crouch, crouch -> stand, prone -> crouch.
- **Z** toggles prone: stand -> prone, crouch -> prone, prone -> stand (falls back to crouch if only crouch has headroom).
- **Space**: stand -> jump (M1). crouch -> stand. prone -> crouch. Space never jumps from crouch or prone.
- **Shift** (sprint held) while crouched and moving forward: starts crouch -> stand, then sprints once settled. Shift while prone: nothing.
- Ctrl is never bound (Ctrl+W closes the tab).
- Gamepad (Maybe): B tap = crouch, B hold 300 ms = prone. Touch (Later): one stance button cycling stand -> crouch -> prone -> stand.

## States and transitions
State in `MovementState`: `stance` (target / current stance), `stanceFrom`, `stanceMs` (remaining transition ms, 0 = settled).
- Starting a transition from settled stance `a` to `b`: `stanceFrom = a`, `stance = b`, `stanceMs = movement.stances.transitionMs["a_b"]`.
- Each tick: `stanceMs = max(0, stanceMs - dt x 1000)`. Settled when `stanceMs = 0`. `progress = 1 - stanceMs / transitionMs["a_b"]`.

| From \ To | stand | crouch | prone |
|---|---|---|---|
| stand | - | 200 ms | 600 ms |
| crouch | 220 ms | - | 450 ms |
| prone | 700 ms | 500 ms | - |

### Per-tick order (inside the shared movement step, before the fire check)
1. **Forced water check** (only when settled): settled prone and water depth > `proneMaxWaterDepth` -> start `prone_stand`.
   Settled crouch and depth > `crouchMaxWaterDepth` -> start `crouch_stand`. Forced transitions ignore headroom. Water depth =
   `max(0, -terrainHeight(x, z))` at the feet (sea level y = 0).
2. **Stance request**, from the edges this tick in this priority: `stanceToggle` (C or Z), then `jump` (Space) if not standing,
   then held `sprint` if crouched (with forward movement and all other sprint conditions met). Only the first applicable one is
   used; the others are ignored this tick. A `jump` edge consumed as a stance request never makes a jump.
3. **Request validation** (any failure = no change):
   - Ignored silently while: dead, dropping, airborne, already transitioning (no buffering), or the request maps to the current stance.
   - Refused with `actionFailed { action: 'stance', reason: 'tooDeep' }` if the target is prone and depth > `proneMaxWaterDepth`, or
     the target is crouch and depth > `crouchMaxWaterDepth`.
   - Refused with reason `noHeadroom` if the target is taller than the current stance and headroom is blocked (below). Exception:
     Z from prone falls back to crouch when stand is blocked but crouch fits; refused only if both are blocked.
   - A sprint-triggered stand-up that is blocked fails **silently** (held input; no prompt spam) and the player stays crouched.
4. Advance `stanceMs`.
5. ADS update (`combat.md`), then movement with the speed formula below, then actions (fire, throw, pickup, heal) in the existing order.

### Speed formula
```
base       = sprinting ? movement.sprintSpeed : movement.walkSpeed
stanceMult = settled ? stances[stance].speedMultiplier : min(stances[stanceFrom].speedMultiplier, stances[stance].speedMultiplier)
speed      = base x stanceMult
               x (adsEngaged ? weapons[w].adsMoveMultiplier : 1)
               x (healing ? movement.healMoveMultiplier : 1)
               x (in water, depth > waterDepthThreshold ? movement.waterSpeedMultiplier : 1)
               x (within combat.fireMoveWindowMs of a shot ? weapons[w].fireMoveMultiplier : 1)
```
Sprinting requires: stance stand and settled, `ads` not held, not healing, LMB not held, not dropping, moving forward (M1 rules).
Jumping requires: stance stand and settled, grounded. Examples: prone in 0.18 m water = 5 x 0.25 x 0.6 = 0.75 m/s; crouched rifle ADS =
5 x 0.55 x 0.65 = 1.79 m/s.

### Hitboxes (shots and grenade line of sight)
- **Stand**: vertical cylinder, radius `player.radius`, height `stances.stand.height`; head = hitY >= feetY + height x (1 - `player.headZoneFraction`) (0.78 m).
- **Crouch**: vertical cylinder, radius `player.radius`, height `stances.crouch.height`; head = hitY >= feetY + height x (1 - `combat.hitbox.crouchHeadZoneFraction`) (0.4275 m). The head stays about as big as standing (0.52 m), only the legs fold.
- **Prone**: a level box, bottom at feetY, height `stances.prone.height`, centred on the feet (x, z), long axis along the current look
  yaw: forward f = (-sin yaw, 0, -cos yaw), right r = (cos yaw, 0, -sin yaw). A point p is inside when
  `|dot(p - feet, f)| <= proneLength / 2`, `|dot(p - feet, r)| <= proneWidth / 2` and `0 <= p.y - feetY <= height`.
  Head = `dot(p - feet, f) >= proneLength / 2 - proneHeadLength` (the front 0.5 m). The box ignores slope (it stays level).
- **During a transition**: the cylinder of the taller of `stanceFrom` and `stance` (going down you stay exposed until you are down;
  getting up you are exposed at once).
- **Chest point** (grenade LOS and distance, bot aim): feet + (0, height x 0.5, 0) using the hitbox height above
  (prone 0.3 m, crouch 0.475 m, stand 0.65 m).
- **Eye height**: settled = `stances[stance].eyeHeight`; during a transition = lerp(`stanceFrom` eye, `stance` eye, progress). Used for
  the shot origin, the throw origin, bot line of sight and the camera pivot.
- **Prone pitch clamp (M2b, `camera.md`)**: while the stance is prone, or a transition has prone at either end, the sim clamps aim pitch
  to [`movement.stances.pronePitchMinDeg` -30, `pronePitchMaxDeg` +45]; stand and crouch keep +-80. The prone pose must reach the same
  limits.
- The **movement collision radius** stays `player.radius` in every stance (prone players do not snag on walls). The **collision height**
  is the hitbox height (taller stance during transitions), so a crouched or prone player passes under raised colliders whose bottom is
  above it (for example a leaning palm trunk).

### Visual fit: what you see is what you hit (BUG-008 decision, M2b)
**Rule: the sim is the source of truth. The posed chibi must fit its stance hitbox, and its eyes sit at the stance `eyeHeight`.**
The established tolerance is the standing one: the standing chibi is 1.39 m against a 1.30 m cylinder, so **at most 0.1 m of head
(hair tuft) may stick out above `height`**. Anything more is a visible head top that bullets pass through, which breaks the
"readable fights" pillar. First person makes this stricter: the shot origin is the eye, so the head others see must be where the eye is.

Decision per stance:
- **Crouch: keep `stances.crouch.height` 0.95; lower the pose.** The office low cover is calibrated on 0.95 (`boxSmall` 0.99 hides a
  crouched player, `office.md` 5.3), and a taller crouch would also shrink every crouch-only gap. The shipped pose puts the head top at
  about 1.24 m because it only drops the pivot 0.16 m; the head must come down to the 0.72 m eye.
- **Prone: raise `stances.prone.height` 0.5 -> 0.6 and lower the pose.** The chibi head is 0.34 m from its centre to the hair top. A
  head centred on the prone eye (0.35 m) has its top at about 0.69 m, which is 0.19 m over a 0.5 m box and cannot fit without pressing
  the chin into the sand. At 0.6 the overhang is 0.09 m, the same as standing. The cost is small: the prone box face grows from 0.8 x 0.5
  to 0.8 x 0.6 m, the eye (shot origin, camera) is unchanged, and every office prone cover is still taller (chair base 0.81, mug 0.86,
  `bookStack` 0.95). Prone is still by far the smallest stance. `prone.eyeHeight` stays 0.35.
- **Stand: unchanged** (1.39 vs 1.30).

Pose targets (settled, at aim pitch 0 and at both prone pitch limits -30 / +45; checked by `tests/render/prone-hitbox-match.test.ts`):

| | Crouch | Prone |
|---|---|---|
| Head top (incl. hair) | <= 1.05 m (0.95 + 0.1) | <= 0.70 m (0.6 + 0.1) |
| Eyes (face centre) | 0.72 m +- 0.05 (stance eyeHeight) | 0.35 m +- 0.05 |
| Head horizontally | inside radius 0.45 + 0.12 of the feet | head centre z <= -0.45 (well inside the front 0.5 m head zone, -0.75..-0.25); whole head inside x +-0.4 |
| Torso, legs | inside the cylinder (+0.12) | inside the 1.5 x 0.8 x 0.6 box (+0.12); torso centre behind the head zone (z > -0.25) |

How to get there (graphics' choice): a deeper crouch drop (about 0.3 m) with more forward body lean and less head compensation; prone with
the chest lower (`chestUp` smaller), the neck and head forward along -Z, and `headUp` reduced so the face looks forward from just above the
sand. Aim pitch may tilt the head but not lift its top over the limit.

Transitions are not checked: during a transition the taller stance's cylinder applies, which already covers the in-between poses.

Gameplay side effects of prone 0.6: chest point 0.25 -> 0.3 (bot aim, grenade LOS); a prone player now needs a gap above 0.6 m to crawl
under something (no shipped map has a raised collider between 0.5 and 1.35 m, see Headroom below); a horizontal shot at 0.55-0.6 m now
hits a prone target. Expected to need playtest tuning: none beyond the existing prone keys.

### Headroom
When `movement.stances.headroomCheck` is true, a request that raises height from h_cur to h_new is blocked if any prop collider overlaps
the footprint circle (feet x, z, radius `player.radius`) and its vertical span [bottom, top] intersects
(feetY + h_cur, feetY + h_new + `headroomMargin`]. Ground-rooted colliders the player is not inside never match (their footprint does
not overlap a player who is standing next to them), so in practice this only triggers under raised parts and roofs.

**Headroom on the shipped maps (BUG-005 decision): N/A on both maps in M2b; the rule stays.** The M2a "cannot stand under the hut roof"
case is withdrawn: the hut is a solid ground-rooted prism with no interior, and every other floating island collider (upper palm trunk
segments) is more than 1.35 m up. The case does **not** move to the office either: desk undersides are about 6 m up (tunnel clearance
6.39 m) and the lowest raised office collider a player can stand under is the monitor screen, 1.395 m above the desk top, which is
deliberately just above `stand.height + headroomMargin` (1.35) so a standing player fits under the canopy (maps.md 2.4 ruling). So nothing
on either map has a raised bottom in the 0.6-1.35 m band where the rule can fire.
- The rule is kept: it costs nothing, it is verified by AT7 on a synthetic raised collider, and it guards future low gaps (the office's
  Later kit pieces: a sofa with a crouch-only gap and a drawer pedestal with a prone-only gap).
- The acceptance criterion is "the rule works under a raised collider" (AT7) plus AT7b below. No live-map headroom test in M2b.
- Level constraint (level-designer, graphics-designer): a raised collider whose bottom is between `prone.height` (0.6) and 1.35 m above
  a walkable surface is a deliberate crawl or crouch gap and must be listed in the level doc. The monitor screen bottom must stay above
  1.35 m above the desk top, or standing under monitors becomes blocked.

### Interactions with other systems
- **Fire** (guns and fists): blocked during any transition. Held automatic fire resumes when settled; a semi-auto click during the
  transition is dropped.
- **ADS**: blocked during any transition; starting a transition sets `adsMs = 0`.
- **Grenade**: pulling the pin (starting a cook) is blocked during a transition; **releasing (throwing) is always allowed**, from the
  current (lerped) eye height. Settled prone: throw speed x `items.grenade.throwSpeedProneMultiplier`. Stance requests are allowed while
  cooking.
- **Heal, reload, swap, pickup**: allowed in every stance and during transitions; none is cancelled by a stance change.
- **Fall damage, zone damage**: unchanged by stance. Walking off a ledge keeps the stance; landing does not change it.
- **Spawn and drop**: every player spawns standing and settled; stance requests are ignored while dropping.
- **Death**: the stance is irrelevant (death pose); death drops scatter as normal.

## Tunable values
`movement.stances.{stand,crouch,prone}.{speedMultiplier,height,eyeHeight}`, `movement.stances.transitionMs.<from>_<to>`,
`movement.stances.proneMaxWaterDepth`, `crouchMaxWaterDepth`, `headroomCheck`, `headroomMargin`, `combat.stanceSpreadMultiplier.*`,
`combat.hitbox.*`. `stances.stand.height/eyeHeight` must equal `player.height/eyeHeight` (validated).
**Expected to need playtest tuning**: prone `speedMultiplier` (0.25), `stand_prone` / `prone_stand` (600 / 700 ms), `prone` spread (0.6),
`crouchMaxWaterDepth` (0.55; it must keep the crouched eye at 0.72 above the water surface on screen).

## Edge cases
- Crawling from 0.15 m into 0.25 m water: forced `prone_stand` on the first settled tick above 0.2 m; you cannot fire for 700 ms. This
  is the cost of crawling into the surf.
- Z pressed at 100 ms into a 200 ms `stand_crouch`: ignored; you end crouched. Press again once settled.
- C and Space pressed on the same tick while prone: `stanceToggle` wins (prone -> crouch); the jump edge is ignored.
- Sprint held while crouched under a low trunk: stays crouched, no sprint, no prompt.
- Prone on a steep slope: the box stays level, so part of it sinks into the hill (terrain blocks those rays) and part floats. Accepted.
- Prone box poking through a wall or rock: shots hit the collider first. Accepted.
- Turning while prone swings the box instantly with the look yaw (same as the M1 standing body). Maybe later: a prone turn-rate limit.
- Two prone players overlapping: no player-player collision (M1 rule); both hitboxes are tested, first hit wins.
- Bushes are soft (no collision, no line-of-sight block): a prone player in a bush is hidden only visually. This is intended.
- Disconnect mid-transition: normal elimination; nothing special.

## What the UI must show
- A stance icon (stand / crouch / prone silhouette) next to the HP bar; it animates during transitions.
- Prompts: "No room to stand" (`noHeadroom`), "Too deep" (`tooDeep`). Strings come from `en.json` (narrative-designer).
- The camera pivot follows the eye height (lerped), and the crosshair follows the cone (crouch and prone shrink it).
- Controls help and the settings key list: C, Z, Space.

## Audio and VFX feedback
- Cloth rustle on every transition start (local and positional for others, ~15 m), plus a soft body thud when a prone transition ends.
- Footsteps: crouch footsteps quieter and with a shorter audible range than standing; crawl uses a slow sand-drag loop, quieter still.
  (Exact volumes and ranges are the audio-designer's.)
- Animations (graphics): crouch idle/walk, prone idle/crawl lying along the look yaw, and transition clips whose length matches
  `transitionMs`. Remote players need `stance`, `stanceFrom` and transition progress (or `stanceMs`) in `PlayerState`.
- Splash VFX when a forced water stand-up starts.

## Network (for network-engineer and tech-lead)
`PlayerInput.stanceToggle: 'crouch' | 'prone' | null` (edge). Space stays the existing `jump` edge, interpreted by the movement step.
`MovementState` gains `stance`, `stanceFrom`, `stanceMs` (predicted, reconciled). `PlayerState` gains `stance` (+ transition progress) for
remote animation and hitbox display in debug views. The server is authoritative for headroom and water checks.

## Acceptance tests (QA; Vitest on the shared movement step and World)
1. Stand, `stanceToggle: 'crouch'`: still transitioning after 5 ticks (166.7 ms), settled crouch after 6 ticks (200 ms) (allow 1 extra
   tick for float rounding). Crouch walking forward settles at 2.75 m/s (+-0.01).
2. Prone crawl settles at 1.25 m/s. Prone in 0.18 m water: 0.75 m/s.
3. Crouched, hold `sprint` + forward: a `crouch_stand` transition starts that tick; speed reaches 7.2 m/s only after it settles.
4. Space while standing on the ground jumps (vertical velocity 6.5). Space while crouched: stance -> stand, vertical velocity stays 0.
   Space while prone: stance -> crouch.
5. Z at water depth 0.3: refused with `tooDeep`, stance unchanged. C at depth 0.6: refused with `tooDeep`.
6. Prone settled at depth 0.1, move to depth 0.25: a forced `prone_stand` starts on the first tick at depth > 0.2; standing after 700 ms.
7. **Headroom**: test collider with bottom at feetY + 1.1 above a prone player. C -> crouch succeeds (0.95 + 0.05 = 1.0 < 1.1).
   Space from crouch -> refused `noHeadroom`. Back to prone, Z -> ends crouched (fallback), not standing. With `headroomCheck` false,
   Space stands.
7b. **Headroom on the shipped maps (BUG-005)**: a prone player hugging each hut wall stands up (no false `noHeadroom`); on the office, a
   prone player under a monitor on a desk top stands up (screen bottom 1.395 > 1.35). This replaces the withdrawn "cannot stand under the
   hut roof" case.
8. **Fire in transition**: rifle, LMB held, press C: no `shot` events during the 200 ms transition, shots resume on settle. Pistol clicked
   once during a transition: no shot during or after the transition until a new click.
9. **ADS in transition**: `ads` held while a transition runs: adsProgress = 0 throughout; ramps after settle.
10. **Crouch hitbox**: crouched target, feet y = 0: hit at y = 0.9 is a headshot, y = 0.4 a body hit, y = 1.0 misses (ray passing above).
11. **Prone hitbox**: target yaw 0 (facing -Z), feet (0, 0, 0). A vertical downward ray at (0, -, -0.6) hits the head; at (0, -, 0.6) the
    body; at (0.5, -, 0) misses (|right| 0.5 > 0.4). A horizontal ray at y = 0.55 hits; at y = 0.7 it misses (above 0.6; BUG-008 changed
    this from "y = 0.6 misses"). Rotate yaw 90 deg: the same three vertical rays give miss / miss / body.
12. **Transition hitbox**: during `stand_prone`, a hit at y = 1.2 counts and is a headshot (stand cylinder).
13. **Eye lerp**: 300 ms into `stand_prone` (9 ticks), eye height = 1.05 + (0.35 - 1.05) x 0.5 = 0.70 (+-0.02).
14. Requests while airborne or dropping are ignored; a spawned player is standing and settled.
15. Z pressed 100 ms into `stand_crouch`: ignored; settled crouch at 200 ms.
16. **Prediction**: for a scripted sequence of C/Z/Space/sprint inputs, the client prediction and the server produce identical
    `stance`, `stanceFrom`, `stanceMs` on every tick (no reconciliation correction).
17. Heal started standing continues through C and Z and completes; a reload does the same.
18. **Visual fit (BUG-008)**: `tests/render/prone-hitbox-match.test.ts` passes as plain `it` (no longer `it.fails`): the settled crouched
    head top is <= 1.05 m and every settled prone part lies inside the 1.5 x 0.8 x 0.6 box within 0.12 m; the prone head centre is at
    z <= -0.45. Also check prone at aim pitch -30 and +45 (head top <= 0.70 m). Headless render check: the crouched and prone eyes are
    within 0.05 m of `eyeHeight`.
