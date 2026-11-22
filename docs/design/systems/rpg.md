# System: RPG (rocket launcher) (M2c)

Numbers: `balance.json` `weapons.rpg` (including `weapons.rpg.rocket.*`), `items.ammo_rocket`, `levels.overrides.rpg`, `bots.rpg`
(live). Server-authoritative and deterministic (seeded RNG only). Rockets are sim projectiles like grenades: not
predicted, drawn from events and snapshots. Related: `grenades.md` (blast model), `combat.md`, `melee.md` (glass), `levels.md`.
Scope tags: **M2c**, **Later**, **Maybe**.

## Purpose
A rare, loud answer to a player who has dug in: behind a rock, on a desk plateau, in a glass room. It turns a stalemate into a
decision for both sides. The shooter commits to one slow, visible rocket and a long reload. The target sees the rocket coming and can
move. It must never be the best gun in a straight fight: one rocket, then 3.8 s of reloading.

## Player-facing rules
### The weapon
- `rpg`: slot weapon (takes a gun slot), `ammo_rocket`, mag 1, `reloadMs` 3800 (auto-reload after firing if you carry rockets), semi
  (one rocket per click), iron sight with rifle-like ADS zoom (`adsZoom` 1.6, `adsTimeMs` 350, `adsMoveMultiplier` 0.6).
- Launch cone (normal spread formula): hip 1.5 deg, ADS 0.225 deg, moving x3. Aim down sights for anything past ~10 m.
- `items.ammo_rocket`: `pickupQty` 1, `maxCarry` 3. An RPG spawn = 1 loaded + 2 loose (`loot.extraAmmoWithWeapon` x 1) = 3 rockets.
- Epic loot only: about 0.21 RPGs per island match (one match in five) and 0.24 on the office; loose rockets are rarer still (`loot.md`).

### Firing and flight (per sim tick, server)
1. Fire: normal "can fire" rules (`combat.md`). Mag -1. Emit `rocketFired {id, ownerId, pos, vel, level, t}`.
2. Origin = eye + aim direction x `rocket.originForward` (0.6 m); if the segment eye -> origin hits a collider, the rocket is a dud at that
   point (step 5). Direction = aim within the launch cone. Velocity = direction x `rocket.speed` (45 m/s). Shooter velocity not inherited.
3. Each tick: `vel.y -= rocket.gravity x dt` (1.5 m/s^2), then sweep the segment pos -> pos + vel x dt. The first contact along the
   segment wins:
   - The rocket's **centre point** (no radius) is tested against the terrain or indoor floor, the water surface (y = 0 where the terrain
     is below sea level) and the world-edge wall. This keeps level shots landing where the arc says (acceptance test 1).
   - A **sphere** of radius `rocket.collisionRadius` (0.12) is tested against prop colliders, intact glass panes and the stance hitboxes
     of every alive, non-dropping player **except the owner**. This makes near misses on players and cover count.
   Travelled distance accumulates.
4. **Contact or range**: on first contact, or when travelled distance reaches `weapons.rpg.range` (120 m; air burst at that point), the
   rocket ends:
   - Travelled < `rocket.armDistance` (5 m): **dud**. A struck player takes the impact damage only; a struck glass pane breaks; no blast.
     Event `rocketDud {id, pos}`.
   - Else: if a player was struck, apply the **impact damage** first (`weapons.rpg.damage` x level, body zone, through the vest; cause
     `rocket`, weapon `rpg`). If a glass pane was struck, it breaks (`glassBroken`). Then the **blast** at the contact point (pulled back
     `collisionRadius` along the incoming direction): `explosion {id, pos, radius, ownerId}` with the grenade blast model (`grenades.md`
     "Explosion") using `rocket.blast.*`: falloff from `innerRadius` to `radius`, line of sight from `pos + losHeightOffset` to each chest
     (glass broken by this rocket no longer blocks), vests absorb, helmets do not, `selfDamage` true, kill credit the owner (even if dead).
5. Rockets do not interact with each other, grenades, smoke, loot or bullets. Match end removes them with no explosion.

Flight: 0.67 s to 30 m (drop 0.33 m), 1.11 s to 50 m (0.93 m), 2.22 s to 100 m (3.7 m), 2.67 s to 120 m (5.3 m). Aim slightly high at
long range; the arc is part of the skill.

### Damage arithmetic (L1: impact 40, blast 110; L4 x1.15: impact 46, blast 126.5)
Blast at chest distance d: `maxDamage` if d <= 1.0, else `maxDamage x (1 - 0.2125 x (d - 1))`, 0 beyond 5 m.

| d (m) | <= 1.0 | 1.5 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| L1 blast | 110 | 98.3 | 86.6 | 63.3 | 39.9 | 16.5 |
| L4 blast | 126.5 | 113.1 | 99.6 | 72.7 | 45.9 | 19.0 |

A direct hit always lands within `innerRadius` of the chest (standing: at most sqrt(0.45^2 + 0.65^2) = 0.79 m; prone box corner about
0.9 m), so direct hit = impact + full blast.

Rockets to kill a full-HP player (thresholds: none 100, vest_1 135, vest_2 155, vest_3 175, vest_4 200; helmets never absorb):

| Hit | No armor | vest_1 | vest_2 | vest_3 | vest_4 |
|---|---|---|---|---|---|
| L1 direct (150) | 1 | 1 | 2 (5 HP left after 1) | 2 (25 left) | 2 (50 left) |
| L4 direct (172.5) | 1 | 1 | 1 | 2 (2.5 left) | 2 (27.5 left) |
| L1 splash at 1 m (110) | 1 | 2 (25 left) | 2 | 2 | 2 |
| L1 splash at 3 m (63.3) | 2 | 3 | 3 | 3 | 4 |

Time between rockets = `reloadMs` (L1 3.8 s, L4 3.04 s), so a second rocket is a long wait. In practice the RPG softens or flushes, and a
gun finishes: L1 direct on vest_2 leaves 5 HP and no vest, which any gun finishes in one hit. An unarmored player dies within 1.43 m of
an L1 blast (1.99 m at L4). The frag (140 inner since balance v9, 6 m radius) is still the bigger blast; the rocket's strengths are speed, range and the
direct hit.

### Self-damage and point blank
- `selfDamage` is on (the grenade rule). The dud rule (`armDistance` 5 m) means a rocket fired into a wall in your face does not explode.
  An armed rocket ends at least 5.6 m from your eye (0.6 m origin + 5 m), which is outside the 5 m blast radius, so a rocket fired
  straight ahead cannot hurt you while you stand still. Self-damage happens when you run toward your own blast point, or when it explodes
  next to you in another way (a rocket fired at a steep angle into a slope beside you). This is deliberate: no point-blank panic use and
  no self-kill by accident, while other players near the blast are still hit.
- Kill credit for a self-kill follows the grenade rule (last enemy damager within `match.killCreditWindowSeconds`).

### Office glass
A rocket that strikes an intact pane breaks it (whole pane, `melee.md` "Glass") and explodes there; the blast then reaches through the new
opening. Bullets and grenades still never break glass.

## States and transitions
Weapon: normal gun states (`Ready` -> fire -> `Reloading 3800` -> `Ready`). Rocket entity: `Flying` -> contact / max range ->
`Dud` or `Exploded` (removed the same tick).

## Tunable values
`weapons.rpg.*`, `weapons.rpg.rocket.{speed, gravity, collisionRadius, originForward, armDistance}`,
`weapons.rpg.rocket.blast.{radius, innerRadius, maxDamage, minDamageFactor, losHeightOffset, selfDamage}`, `items.ammo_rocket.*`,
`levels.overrides.rpg`, `bots.rpg.*`, loot weights. Validation: `0 <= innerRadius < radius`, `speed > 0`, `armDistance >= 0`, mag 1.
Design invariant: L4 `impact + blast.maxDamage - min(vest_3.durability, (impact + blast) x vest_3.absorbFraction)` < 100 (a fresh vest_3
survives any single rocket). **Expected to need playtest tuning**: `speed` (45: dodgeable at 40 m+?), `blast.maxDamage` (110),
`reloadMs` (3800), loot weight (epic 4).

## Edge cases
- Rocket fired while prone: origin from the prone eye; pitch clamp applies (`camera.md`). Fired while airborne: allowed (air spread x2).
- Rocket into the tide: explodes at the water surface (y = 0).
- Rocket through a doorway past a dropping player: dropping players are not hit (no contact).
- Owner dies or leaves while the rocket flies: it continues and keeps the owner id for credit.
- Rocket fired at point blank into a player: dud (impact 40 only) if under 5 m of travel.
- Air burst at 120 m: normal blast at that point (rarely hits anything; it stops infinite rockets).
- Two rockets hit the same tick: resolve in rocket id order. A rocket and a grenade explode on the same tick: resolve in entity id order.
- Rocket vs smoke: passes through; the explosion is visible through the cloud (big flash), damage is unaffected.

## What the UI must show (ui-ux-designer)
Ammo `1 / reserve` with rocket icon; reload progress. Kill feed: RPG icon with level. Damage direction arc from the blast position. No
arc preview (straight shot). Hit markers: impact and blast may arrive as two damage events on the same tick; show one merged marker.
Optional (Later): an incoming-rocket edge warning.

## What audio and VFX feedback is needed
- Audio: loud launch "whoomp" (positional ~150 m), a whistle/whoosh on the flying rocket (positional, ~40 m, Doppler optional) so a target
  hears it coming, explosion (reuse frag, slightly deeper), dud "clunk", glass shatter.
- VFX: rocket model with a bright tail and a puffy smoke trail that lingers ~1.5 s (shows where it came from), backblast puff at the
  launcher, explosion puff sized to `blast.radius`, camera shake (as grenades).

## Network (for tech-lead and network-engineer)
Snapshot projectile list (or event-driven extrapolation, ADR 0007): rockets as `{id, ownerId, pos, vel}`; with fixed speed and gravity
the client can extrapolate from `rocketFired` alone (`pos`, `vel`, `t`). Events: `rocketFired`, `rocketDud`, `explosion` (reused),
`glassBroken`. Damage cause `rocket` for the impact, `explosion` for the blast; both carry weapon `rpg` and level.

## Bots (numbers in `bots.rpg`)
- The RPG is **never** chosen by the `weaponPrefs` range-band rule; it is a special action like the grenade.
- Each decision tick: carrying the RPG with a rocket (loaded or reserve), engaged on a **visible** target at distance in [`minRange` 12,
  `maxRange` 50], fire with probability `fireChancePerDecision` x personality `grenadeChanceMultiplier` (at most once per `cooldownMs`)
  if any of: a collider within `coverRadius` (3 m) of the target's feet; another enemy within `groupRadius` (6 m) of the target; the
  target slower than `stillSpeed` (1.5 m/s). Never if the aim ray hits anything within `selfSafeDistance` (10 m).
- Aim at the target's feet + target velocity x flight time x `leadFactor` + a uniform offset within `aimErrorMetres` (seeded). Swap,
  ADS (iron rule: beyond `bots.ads.minRange`), fire, swap back to the best gun for the range.
- Out of combat (no target for `bots.loseTargetMs`), re-equip and reload an empty RPG, then swap back.
- Loot value `bots.rpg.lootValue` 3.0 (x level), for slot decisions only.

## Acceptance tests (QA, Vitest on src/shared/sim)
1. Flat ground, no colliders, fire level (pitch 0) from a standing eye (1.05 m): the rocket travels at 45 m/s horizontally and hits the
   ground at t = sqrt(2 x 1.05 / 1.5) = 1.18 s, 0.6 + 45 x 1.18 = about 53.8 m from the eye (+-1 m); `explosion` there.
2. Max range: fired 20 deg up over open sea with nothing to hit: explodes after 120 m of travel (+-1 tick of travel).
3. Direct hit on an unarmored standing player 20 m away: one damage event of 40 (cause rocket) then 110 (explosion); dead.
4. Direct hit on a full-HP vest_2 (55): impact 40 -> hp 76, vest 39; blast 110 -> vest absorbs 39, hp 5, vest destroyed.
5. L4 direct hit on vest_2: dead. L4 direct hit on fresh vest_3: hp 2.5.
6. Splash: unarmored chest 3 m from the blast with clear LOS: 63.25. Behind a crate: 0. Helmet durability never changes from a rocket.
7. Dud: a target 3 m in front of the shooter is hit: 40 damage, no explosion event, the shooter takes nothing.
8. Arming and self-damage: standing, firing level at a wall 5.4 m from the eye: dud (4.8 m travelled), no explosion. At 5.8 m: explosion
   (5.2 m travelled), the shooter (chest about 5.8 m from the blast) takes 0. A test that moves the shooter 3 m toward the blast point
   before impact: the shooter takes blast damage per distance and the kill credit rule for self-kills applies. A bystander 1 m from a
   direct-hit target takes blast damage per distance.
9. Glass (office test map): a rocket at an intact pane 20 m away emits `glassBroken` then `explosion`; a player 2 m behind the pane takes
   blast damage (LOS through the opening).
10. Reload: after firing with 2 reserve, mag 0 -> 1 after 3800 ms (L4: 3040); reserve 1.
11. Determinism: same seed and inputs give identical rocket paths, ticks and damage across runs.
12. Snapshot/events: a client receiving only `rocketFired` can draw the rocket within 0.2 m of the server position for its whole flight.
13. Bots (seeded): a bot with an RPG and a visible, stationary target at 25 m fires within a few decision ticks with chance forced to 1;
    with the target at 8 m it never fires the RPG.

## Affected agents
tech-lead (rocket entity, events, projectile list in ADR 0007, damage causes), game-developer (rocket sim, blast reuse, glass, bots),
network-engineer (projectile wire format, late-join rockets), ui-ux-designer (ammo, kill feed, merged marker), graphics-designer and
graphics-engineer (launcher, rocket, trail, explosion), audio-designer (launch, whistle, dud), level-designer (rocket-worthy cover at epic
POIs), narrative-designer (names), qa-tester.
