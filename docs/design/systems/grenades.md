# System: Frag Grenades (M2a)

Numbers: `balance.json` `items.grenade`, loot weights in `loot.tiers`, bot keys in `bots.grenade` and `bots.personalities.*.grenadeChanceMultiplier`.
Server-authoritative and deterministic (the World's seeded RNG only; no `Math.random`). Grenade entities are **not** predicted; the
client predicts only the aim arc preview.

## Purpose
Counterplay to camping. A player prone behind a rock or crouched behind a crate can be flushed out. The grenade gives three decisions:
when to throw (it costs your gun hand for a second), how long to cook (deny escape time vs risk blowing up in your hand), and where to
run when one lands near you (a readable blinking fuse gives you 1-3 s).

## Player-facing rules
### Carrying and equipping
- Item `grenade`, stackable, up to `maxCarry` (3). Loot spawns hold `spawnQty` (2). E picks up as many as fit; the rest stay on the ground.
- On death, uncooked grenades drop as one stack with the other death drops.
- **Key 4 or G** selects the grenade slot (slot index 3). It costs `combat.swapMs` like any swap. With 0 grenades it is refused with
  `actionFailed { action: 'swap', reason: 'noGrenades' }` (new action and reason). The mouse wheel skips slot 3 when you have none.
- RMB does nothing with the grenade slot (sight `none`).

### Cooking and throwing
1. **Pull the pin**: press LMB with the grenade slot ready (not swapping, not in `throwRecoveryMs`, not in a stance transition, not
   dropping). The carried count drops by 1 now. `fuseRemainingMs = fuseMs` (3500). Starting a cook cancels a heal channel (fire input
   rule from M1).
2. **Cooking**: while LMB is held, `fuseRemainingMs -= dt x 1000` each tick. Sprint is suppressed (LMB held, M1 rule). Walking,
   jumping and stance requests are allowed. Q, R and E are ignored while cooking.
3. **Throw**: releasing LMB spawns the grenade entity with the remaining fuse, on that tick, in any stance or transition:
   - `t = clamp((pitchDeg - throwPitchMinDeg) / (throwPitchMaxDeg - throwPitchMinDeg), 0, 1)` with pitchDeg = aim pitch (up positive).
   - `speed = lerp(throwSpeedMin, throwSpeedMax, t)` x (`throwSpeedProneMultiplier` if prone and settled).
   - Launch direction = aim yaw with pitch `min(89, pitchDeg + throwLiftDeg)`.
   - Origin = eye (stance eye height, lerped in transitions) + aim direction x `throwOriginForward`. If the segment eye -> origin hits a
     collider or terrain, origin = the hit point pulled back `collisionRadius` toward the eye.
   - Thrower velocity is not inherited (keeps the arc preview honest).
   - Then `throwRecoveryMs` (600) before the next pin pull. If the carried count is now 0, auto-switch to the last gun slot used (or fists)
     with `combat.swapMs`.
4. **Cook-out**: if `fuseRemainingMs` reaches 0 while LMB is still held, the grenade explodes at the thrower's eye position that tick
   (normal blast rules; self-damage applies).
5. **Switch away while cooking** (slot key, wheel): the grenade is released as a short drop: origin = eye, velocity = horizontal look
   direction x `dropOnSwitchSpeed` (2 m/s), remaining fuse. Then the swap proceeds normally.
6. **Death or disconnect while cooking**: the grenade drops at the eye with zero velocity and the remaining fuse, still owned by the
   dead player.

Typical throws (flat ground, standing, no cook):

| Aim pitch | t | Speed | Launch angle | Air time | First landing |
|---|---|---|---|---|---|
| -40 deg | 0 | 7.0 m/s | -32 deg | 0.20 s | ~1.2 m |
| -20 deg | 0.267 | 11.0 m/s | -12 deg | 0.25 s | ~2.7 m |
| 0 deg | 0.533 | 15.0 m/s | 8 deg | 0.54 s | ~8.0 m |
| 15 deg | 0.733 | 18.0 m/s | 23 deg | 1.07 s | ~17.7 m |
| 35 deg | 1 | 22.0 m/s | 43 deg | 2.07 s | ~33 m |

(Landing = `v cos a / g x (v sin a + sqrt(v^2 sin^2 a + 2 g h))`, g = 15, h = 1.05.) A max-range throw explodes ~1.4 s after landing; a
short throw sits for ~3 s. Cooking 1-2 s removes the escape window, at the risk of a cook-out.

### Flight physics (per sim tick, server)
1. `vel.y -= gravity x dt`. Candidate `next = pos + vel x dt`.
2. Sweep the segment pos -> next against the terrain heightfield, prop colliders and the world-edge wall (`MapData.worldRadius`), treating
   the grenade as a point and pushing contacts out by `collisionRadius` along the contact normal. **Players are not colliders** for
   grenades.
3. On the first contact: place the grenade at the contact point + normal x `collisionRadius`. Split velocity into normal
   `vn = dot(vel, n) n` and tangent `vt = vel - vn`. New `vel = vt x (1 - friction) - vn x restitution`. The rest of the tick's motion is
   dropped (at most one bounce per tick). Normals: terrain = heightfield gradient; circle prism = horizontal radial, or +Y on its top;
   box prism = the face normal, or +Y on its top; world edge = inward radial.
4. Emit `grenadeBounce` if the impact normal speed `|dot(vel_before, n)|` >= `bounceEventMinSpeed`.
5. **Rest**: after a bounce, if `|vel| < restSpeed` and `n.y > 0.7`, set `vel = 0`; the grenade stays put until it explodes.
6. **Water**: on the first tick the grenade's y goes below 0 (sea level) where the terrain is below 0, multiply `vel` by
   `waterVelocityDamping` once and emit `grenadeBounce` with surface `water`. It then sinks under gravity and rests on the seabed.
7. Fuse: `fuseRemainingMs -= dt x 1000`; at <= 0 the grenade explodes this tick (after moving).

### Explosion
- Emit `explosion { id, pos, radius, ownerId }` first, then damage, then remove the entity.
- For every alive, non-dropping player (the owner included when `selfDamage` is true), take the **chest point** C (`stance.md`:
  feet + half the hitbox height). `d = |C - pos|` (3D).
- Skip if `d > radius`. Skip if the segment from `pos + (0, losHeightOffset, 0)` to C hits terrain or a prop collider (soft props such as
  bushes do not block; players do not block).
- `dmg = maxDamage` if `d <= innerRadius`, else `maxDamage x (1 + (minDamageFactor - 1) x (d - innerRadius) / (radius - innerRadius))`.
- Apply through the **vest only** (`armor.md`); helmets never absorb grenade damage. Zone-style armor ignore does not apply.
- Damage event: `cause` = explosion, `attackerId` = owner, `sourcePos` = blast pos, `headshot` false.
- **Kill credit**: the owner, even if the owner is already dead or disconnected. Self-kill: credit goes to the last enemy who damaged the
  victim within `match.killCreditWindowSeconds` (the M1 rule for zone/fall deaths), otherwise nobody. Kill feed weapon = `grenade`.
- Several victims of one explosion die on the same tick: the GDD same-tick placement tie-break applies.
- Several grenades exploding on one tick resolve in grenade id order. Grenades never trigger each other and never move or destroy loot.

Damage by distance (`maxDamage` 120, `innerRadius` 1.2, `radius` 6, `minDamageFactor` 0.1; factor = 1 - 0.1875 x (d - 1.2)):

| d (m) | <= 1.2 | 2 | 3 | 4 | 5 | 6 | > 6 |
|---|---|---|---|---|---|---|---|
| Raw damage | 120 | 102 | 79.5 | 57 | 34.5 | 12 | 0 |
| HP loss, vest_2 (55) | 72 | 61.2 | 47.7 | 34.2 | 20.7 | 7.2 | 0 |

Kills a full-HP **unarmored** player within 2.09 m (factor >= 100/120). Never kills a full-HP player wearing any vest (max 120 < 135).
A grenade is a flush-and-finish tool, not a guaranteed kill.

## States and transitions (grenade slot)
`NotHeld` -> select slot 3 (count > 0) -> `Swapping (swapMs)` -> `Ready`
`Ready` -> LMB press -> `Cooking (fuseRemainingMs)` -> LMB release -> `Recovery (throwRecoveryMs)` -> `Ready` (or auto-swap if count = 0)
`Cooking` -> fuse 0 -> `Explode in hand` -> `Recovery`
`Cooking` -> slot change -> drop grenade -> `Swapping`
`Cooking` -> death -> drop grenade.
Entity: `Flying` -> contact -> `Flying` (bounce) or `Resting` -> fuse 0 -> `Exploded` (removed). Match end removes all grenade entities
with no explosion.

## Tunable values
All in `items.grenade` (see its `_note`) plus `bots.grenade.*`. **Expected to need playtest tuning**: `fuseMs` (3500), `maxDamage` (120),
`radius` / `innerRadius` (6 / 1.2), `throwSpeedMax` (22, sets max range ~33 m), `restitution` / `friction` (feel of bounces), loot weights.

## Edge cases
- Throw while facing a wall at point blank: origin pulled back to the eye; the grenade bounces back toward your feet. That is on you.
- Release with less than one tick of fuse left: the entity spawns and explodes on the next tick at its first moved position.
- Cooking through a stance change: allowed; throwing during a transition uses the lerped eye height.
- Pin pull while healing: cancels the heal (no item used). Pin pull during `throwRecoveryMs`: ignored, a new press is needed afterward.
- Grenade lands on a crate top: rests there (top normal is +Y).
- Grenade thrown past the world edge: bounces off the edge wall.
- Grenade resting in the tide (outside the zone): explodes normally; the zone does not affect grenades.
- Owner leaves the match: the grenade stays live and keeps the owner's id.
- Picking up a grenade stack while cooking: E is ignored while cooking.
- Bot or human hit while cooking: no interruption.

## What the UI must show
- Slot 4 icon with the carried count; dimmed at 0.
- While the grenade slot is held (client prediction only): the arc from the throw origin using the same throw formula and physics for
  `clientFeel.grenadeArcPreviewSeconds`, with bounces, and a landing ring of the blast radius at the first resting or fuse-end point.
- While cooking: a fuse ring around the crosshair that empties over the remaining fuse, turning red in the last 1 s.
- **Danger indicator**: any live grenade within `radius + dangerMargin` m (6 + 2 = 8 m; `items.grenade.dangerMargin`, never hard-coded) of the local player shows a grenade icon on screen (or at the screen edge
  pointing to it), visible through walls. This is the counterplay to cooking.
- Kill feed: grenade icon. Prompts: "No grenades".

## What audio and VFX feedback is needed
- Audio: pin pull click (positional, ~10 m), throw whoosh, bounce clinks (positional, per `grenadeBounce`, pitched by speed), water plop,
  a quiet fuse tick from live grenades within ~8 m, explosion (very loud, positional ~120 m), and a short muffled ring for the local player
  if inside the blast radius.
- VFX: grenade model (a cute coconut-shaped frag fits the tone; art call) with a faint trail in flight, a **blinking light that speeds up
  as the fuse runs out** (needs `explodesAt` or remaining fuse in the snapshot), a cartoon explosion puff with sand or water spray sized to
  `radius`, and camera shake for the local player scaled by distance (none beyond 2 x radius).

## Network (for network-engineer and tech-lead)
- Snapshot list `grenades: { id, ownerId, pos, vel?, explodesAt? }[]` (server ms for `explodesAt`; needed for the blink rate).
- Events: `grenadeThrown { id, ownerId, pos, vel }`, `grenadeBounce { id, pos, surface, speed }`, `explosion { id, pos, radius, ownerId }`.
  Damage and kill events reference the explosion (cause explosion, weapon `grenade`).
- Input: no new field; LMB (`fire`) with slot 3 active means cook/throw. `selectSlot` gains 3.
- The client never spawns authoritative grenades. MVP: draw the entity from `grenadeThrown`. Later: a cosmetic local copy on release,
  replaced when the event arrives.

## Bots (numbers in `bots.grenade`)
- **Throw**: on a decision tick, a bot carrying grenades whose engaged target was last seen within `coverMemoryMs` but is not visible now,
  at a last-known distance in [`minRange`, `maxRange`] (8-30 m), throws with probability `throwChancePerDecision` x personality
  `grenadeChanceMultiplier`, at most once per `cooldownMs`. It swaps to the grenade, cooks `cookMs`, aims at the last-known position plus a
  uniform random offset within `aimErrorMetres` (seeded RNG) by solving the throw formula for the pitch (flat-ground estimate), throws,
  and swaps back to its best gun for the range.
- **Flee**: a bot that has line of sight to a live grenade within `fleeRadius` (7 m) moves directly away from it until it is out of range
  or the grenade explodes. Priority: just below "Escape tide" and above "Retreat" in the GDD bot state list.
- Bots never throw at a target closer than `minRange` (self-damage) and never cook longer than `cookMs`.

## Acceptance tests (QA)
1. Quick throw (no cook), standing on flat ground at y = 0, no colliders, pitch 0: initial speed 15.0 m/s, launch pitch 8 deg; first ground
   contact at 8.0 m +- 0.5 m. Pitch 35: speed 22.0; pitch 60: speed 22.0 with launch angle 68 deg. Pitch -40: speed 7.0.
2. Prone (settled) throw at pitch 35: speed 13.2.
3. Cook-out: pin pull at tick 0 with LMB held: the explosion happens at the thrower's eye on the tick where 3500 ms have elapsed. An
   unarmored 100 HP thrower dies; with vest_2 at 55 the thrower ends at 28 HP and vest 7.
4. Release after a 1000 ms cook: the entity has 2500 ms fuse; the explosion is 3500 ms after the pin pull (+- 1 tick).
5. Falloff: unarmored targets with clear LOS, chest distances 1.0 / 2 / 3 / 4 / 5 / 6 / 6.1 m take 120 / 102 / 79.5 / 57 / 34.5 / 12 / 0.
6. LOS: a crate between the blast and the chest blocks all damage; a bush does not; another player does not.
7. Vest yes, helmet no: target with vest_2 (55) and helmet_3 (75) at 3 m: vest absorbs 31.8, hp 52.3, helmet stays 75.
8. Self-damage: the thrower 2 m from their own grenade takes 102 and dies unarmored. Kill credit: the last enemy who hit them within 10 s,
   else `killerId` null; weapon `grenade`.
9. A's grenade kills B after A died: the kill event has `killerId` A, weapon `grenade`, and A's kill count increases.
10. Switching to slot 1 after a 1000 ms cook: an entity appears at the eye with horizontal speed 2.0 m/s and 2500 ms fuse; the swap completes
    after `swapMs`.
11. Death while cooking: an entity appears at the eye with zero velocity and the remaining fuse.
12. Bounce: dropped from rest 3 m above flat ground: at least one `grenadeBounce` event (first impact ~9.5 m/s >= 2), rebound speed ~35% of
    impact, and the grenade rests (vel 0) within 4 contacts; no bounce event for impacts below 2 m/s.
13. Water: thrown into flat 0.6 m deep water: one `grenadeBounce` with surface `water` when it crosses y = 0, it then rests on the seabed and
    explodes at fuse end; a standing unarmored player 3 m from it with clear LOS takes 79.5 (+- 1 for the seabed offset).
14. Determinism: the same seed and inputs give identical grenade paths, explosion ticks and damage across runs.
15. Slot 4 with 0 grenades: refused `noGrenades`. Throwing the last grenade auto-switches to the last gun slot.
16. Carry: holding 3, a stack of 2 is refused `inventoryFull`; holding 2, a stack of 2 gives 1 and leaves 1.
17. Match end with a live grenade: the grenade is removed and no `explosion` event is emitted.
18. While cooking, Q, R and E have no effect; a stance toggle works.
19. Bot (seeded): target at 20 m disappears behind a rock; with chance forced to 1 the bot throws within one decision tick, and its grenade
    lands within `aimErrorMetres` + 3 m of the last-known position on flat ground.
