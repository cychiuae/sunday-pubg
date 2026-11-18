# System: Combat, Inventory and Heals (MVP)

Numbers: `balance.json` sections `weapons`, `combat`, `armor`, `items`, `player`. Server-authoritative: everything here.

## Purpose
Short, readable gunfights where aim and positioning win, and loot choices (2 slots, heals) matter.

## Player-facing rules
See GDD section 7. The precise algorithms follow.

### Shot resolution (per fire event, server)
1. Can fire: alive, not dropping, not reloading, not swapping, mag > 0 (fists are always able), and `now - lastShot >= fireIntervalMs`.
   For semi-auto weapons, LMB must have been released since the last shot (the client sends a fire-pressed edge).
2. Origin = feet + (0, `player.eyeHeight`, 0). Direction = from aim yaw/pitch.
3. Cone half-angle = `spreadDeg` * (`moveSpreadMultiplier` if horizontal speed > `combat.moveSpreadSpeedThreshold`) * (`combat.airSpreadMultiplier` if airborne).
4. For each of `pellets`: pick a direction uniformly inside the cone, then raycast up to `range` against terrain, prop colliders and every other
   alive player's cylinder. The first hit wins. The shooter is excluded.
5. Player hit: headshot if hitY >= feetY + `player.height` * (1 - `player.headZoneFraction`).
   `dmg = damage * (headshot ? headshotMultiplier : 1) * falloff(dist)`, where falloff = 1 at or below `falloffStart`, lerps to `minDamageFactor` at `falloffEnd`, and is clamped beyond that.
6. Apply armor: `a = min(armor, dmg * armor.absorbFraction)`, then `armor -= a` and `hp -= dmg - a`. HP and armor are floats. The HUD shows `ceil`.
7. Shotgun pellets are summed into one damage event per target per shot, so the client shows one hit marker and the kill is credited once.
8. Mag decreases by 1 per shot (not per pellet). If the mag is now 0 and reserve > 0, an auto-reload starts.

### Inventory state
`slots: [WeaponInstance|null, WeaponInstance|null]`, fists implicit (slot index 2), `active: 0|1|2`, `ammo: {light, heavy, shell}`,
`heals: {bandage, medkit}`, `hp`, `armor`. `WeaponInstance = {id, mag}`.

### Healing
Q runs the selection in GDD 7.4. Channel `useMs`. On completion: `hp = max(hp, min(hpCap, hp + heal))` with hpCap = item `healCap`, then the item count decreases by 1.
Cancelled by fire input, swap, reload, Q, death or match end, with no item consumed.

## States and transitions (per player weapon state)
`Ready` -> fire -> `Cooldown (fireIntervalMs)` -> `Ready`
`Ready` -> R or empty-fire with reserve -> `Reloading (reloadMs)` -> `Ready` (swap or Q cancels)
any -> slot key -> `Swapping (combat.swapMs)` -> `Ready` (cancels reload and heal)
`Ready` or `Reloading` -> Q -> `Healing (useMs)` -> `Ready` (fire, swap, reload or Q cancels). Starting a heal cancels a reload with no ammo moved:
heal and reload are mutually exclusive and the latest input wins. This makes "heal or reload first?" a deliberate choice.

## Edge cases
- Reload with a full mag or 0 reserve: no-op.
- Reload partially fills when reserve < missing rounds.
- Picking up a weapon while reloading or healing: allowed, and it cancels both if the active slot changes.
- A dropped weapon keeps its `mag`, and a picked-up weapon keeps it too (no free ammo from swapping the same gun back and forth).
- Two of the same weapon is allowed.
- Damage to a dead or dropping player is ignored. Dropping players cannot be hit (they are falling for about 4 s; this avoids spawn-sniping).
- Shots fired on the same tick as the shooter's own death still resolve (inputs are processed in order).
- Fists hit only players (no prop damage in M1).

## UI must show
Ammo `mag / reserve` for the held weapon, slot icons with the active one highlighted, a crosshair sized to the current cone, hit markers
(body/head/kill), a damage-direction arc, HP and armor bars, a heal channel bar, a reload progress bar, the pickup prompt with name and quantity, and
"Armor full" / "Inventory full" / "Can't heal" prompts.

## Audio and VFX
Per weapon: shot sound (positional for others), dry-fire click, reload start and end, swap. Hits: body thud, head ping, armor-hit clink, armor break,
kill confirm. Heal: channel loop plus finish chime. VFX: muzzle flash, tracer, sand puff on terrain hits, cartoon hit spark (no blood; stars or confetti fit the chibi tone).

## Acceptance tests (QA, mostly Vitest on src/shared/sim)
1. Rifle body hit at 10 m on 100 HP / 0 armor deals 22. At 110 m it deals 15.4. At 151 m it misses.
2. A rifle head hit on a target whose feet are at y = 0, hitting at y = 1.0, deals 38.5. Hitting at y = 0.7 deals 22.
3. 100 HP / 50 armor takes 30 damage, ending at hp 85 and armor 35. Then 100 damage: armor absorbs 35 (to 0) and hp goes to 20.
4. Shotgun point-blank, all pellets hit, 0 spread (forced): a 100 HP target ends at 1 HP. A second shot kills.
5. Semi-auto pistol: holding LMB fires exactly one shot.
6. Reload with mag 3/12 and reserve 5 ends at 8/12 and reserve 0.
7. Swapping during a reload: after the swap the mag is unchanged and no ammo is consumed.
8. Bandage at 70 HP ends at 75 HP. Bandage at 75 HP is refused. Medkit at 30 HP ends at 100 HP.
9. Firing during a heal cancels it and the item count is unchanged.
9b. Pressing Q during a reload (mag 3/12, reserve 30) starts the heal; the reload is cancelled and the mag stays 3/12 with reserve 30.
10. A full inventory (both slots) picking up a weapon while holding slot 2 drops the slot-2 weapon at your feet with its mag intact.
11. Picking up 30 light ammo with 170 carried takes 10 and leaves 20 on the ground.
12. A vest pickup at 50 armor is refused. At 10 armor it sets armor to 50.
