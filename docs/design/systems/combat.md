# System: Combat, Inventory and Heals (M1 MVP + M2a "Arsenal & Stance" + M2c "Bigger Arsenal")

M2c additions (new weapons, levels, scopes, melee slot, TTK at L1/L4, kill-share and pacing expectations) are in the section "M2c" near
the end. Everything above it remains true for L1 weapons with their default sights.

Numbers: `balance.json` sections `weapons`, `combat`, `items`, `armor`, `player`, `movement.stances`. Server-authoritative: everything here.
Related specs: `armor.md` (vests, helmets), `stance.md` (stand/crouch/prone, hitboxes), `grenades.md` (frag grenades).
Scope tags: **MVP** = M1, **M2a** = this milestone, **Later**, **Maybe**.

## Purpose
Short, readable gunfights where aim and positioning win, and loot choices (2 slots, armor tiers, heals, grenades) matter.
M2a adds a choice of *how* to fight each range: hip fire on the move vs aiming down sights (slower, accurate), standing vs
crouched or prone (smaller, steadier, slower), and close guns vs long guns.

## Player-facing rules
See GDD section 7 for the summary. The precise algorithms follow.

### Weapon roster (M2a)
| Weapon | Fire | Ammo | Sight | Role | Main weakness |
|---|---|---|---|---|---|
| Fists | auto melee | - | none | Desperation | 2 m reach |
| Pistol | semi | light | iron | Early sidearm | Low damage |
| SMG | auto | light | iron | Close range, run and gun | Falls off past 12 m, wide cone |
| Shotgun | pump | shell | iron | Point blank burst (117 max, one-shots an unarmored body) | Useless past ~15 m, 0.9 s pump |
| Rifle | auto | heavy | red_dot | All-rounder at 10-45 m | Needs ADS beyond ~20 m (hip 1.6 deg), terrible on the move (x2.5) |
| LMG (M2a) | auto | heavy | red_dot | Planted suppression, 60 round mag | 5 s reload, wide hip cone, x0.55 move speed while firing, slow ADS |
| DMR (M2a) | semi | heavy | scope_4x | Long-range picks, 2 body / 2 head | Poor hip fire (3 deg), 400 ms per shot |
| Sniper (M2a) | bolt | sniper | scope_8x | One-shot headshot on a bare head; a helmet turns it into a 70 HP hit | 1.4 s bolt, 5 rounds, 6 deg hip fire, 0.4 move speed scoped |

### Shot resolution (per fire event, server)
1. **Can fire**: alive, not dropping, not reloading, not swapping, **not in a stance transition** (M2a, `stance.md`), not holding the
   grenade slot (`grenades.md` handles LMB there), mag > 0 (fists are always able), and `now - lastShot >= fireIntervalMs`.
   For semi-auto and bolt weapons LMB must have been released since the last shot (fire-pressed edge). A press that arrives while
   firing is blocked (transition, swap, reload) is dropped; the player must click again. Holding LMB on an automatic weapon fires as
   soon as the block ends.
2. **Origin** = feet + (0, `eyeHeight(stance)`, 0), where `eyeHeight(stance)` is `movement.stances.<stance>.eyeHeight` (stand =
   `player.eyeHeight`). Direction = aim yaw/pitch. ADS does not move the origin; the scope view is drawn from the same eye point.
3. **Cone half-angle** = `effectiveSpreadDeg` (see "Spread" below).
4. For each of `pellets`: pick a direction uniformly inside the cone, then raycast up to `range` against terrain, prop colliders and
   every other alive, non-dropping player's **stance hitbox** (`stance.md` "Hitboxes"). The first hit wins. The shooter is excluded.
5. **Zone of the hit**: head or body, per the stance hitbox rule (stand: hitY >= feetY + height x (1 - `player.headZoneFraction`);
   crouch: `combat.hitbox.crouchHeadZoneFraction`; prone: the front `combat.hitbox.proneHeadLength` m of the box).
   `dmg = damage x (head ? headshotMultiplier : 1) x falloff(dist)`, falloff = 1 at or below `falloffStart`, lerps to
   `minDamageFactor` at `falloffEnd`, clamped beyond. If `falloffStart >= falloffEnd` the factor is 1 up to `falloffStart` and
   `minDamageFactor` beyond (the sniper uses 300/300/1.0 = no falloff anywhere in range).
6. **Armor** (`armor.md`): body damage goes through the vest, head damage through the helmet:
   `a = min(durability, dmg x absorbFraction)`, `durability -= a`, `hp -= dmg - a`. A piece that reaches 0 durability is destroyed.
   HP and durability are floats; the HUD shows `ceil`.
7. **Pellets** (shotgun): per target per shot, sum the head pellets' damage and the body pellets' damage separately, apply the
   helmet to the head sum and the vest to the body sum (head first; the pools are independent so order does not matter), then
   emit **one** damage event (headshot = true if any pellet hit the head). One hit marker, one kill credit.
8. Mag decreases by 1 per shot (not per pellet). If the mag is now 0 and reserve > 0, an auto-reload starts (this ends ADS).

### Spread (M2a, replaces the M1 step 3 formula)
```
cone = spreadDeg x A x S x M x J
A = 1 + (adsSpreadMultiplier - 1) x adsProgress          (adsProgress in [0, 1], see ADS)
S = combat.stanceSpreadMultiplier[stance]  if the stance is settled, else 1   (stand 1.0, crouch 0.8, prone 0.6)
M = moveSpreadMultiplier  if horizontal speed > combat.moveSpreadSpeedThreshold, else 1
J = combat.airSpreadMultiplier  if airborne, else 1
```
All four factors always multiply; there is no floor or cap. Crawling (1.25 m/s) and crouch-walking (2.75 m/s) are above the 1.0 m/s
threshold, so they count as moving. ADS walking slows you but stays above the threshold, except prone + ADS with a weapon whose
`adsMoveMultiplier` <= 0.8 (crawl 1.25 x 0.8 = 1.0, which is not above 1.0). An ADS crawl (0.5-1.0 m/s) is steady by design.

Resulting cones (degrees), `adsProgress` = 1 where ADS:

| Weapon | Hip still | Hip moving | ADS still | ADS moving | ADS crouch still | ADS prone still |
|---|---|---|---|---|---|---|
| Pistol | 1.5 | 3.0 | 0.9 | 1.8 | 0.72 | 0.54 |
| SMG | 3.0 | 4.2 | 1.95 | 2.73 | 1.56 | 1.17 |
| Shotgun | 7.0 | 8.4 | 5.95 | 7.14 | 4.76 | 3.57 |
| Rifle | 1.6 | 4.0 | 0.8 | 2.0 | 0.64 | 0.48 |
| LMG | 2.6 | 7.8 | 1.17 | 3.51 | 0.936 | 0.702 |
| DMR | 3.0 | 7.5 | 0.3 | 0.75 | 0.24 | 0.18 |
| Sniper | 6.0 | 18.0 | 0.12 | 0.36 | 0.096 | 0.072 |

Rule of thumb for players: a 0.45 m body at distance d is fully covered by the cone when tan(cone) x d <= 0.45, i.e. about
d <= 26 / cone_deg metres. Rifle ADS still: ~32 m; DMR ADS: ~86 m; sniper ADS: ~215 m; rifle hip moving: ~6.5 m.

### Aim down sights (ADS, M2a)
- **Input**: `PlayerInput.ads` (held). RMB, hold by default; Settings offers Hold/Toggle (the client turns toggle into the held flag,
  see UI). ADS is part of client prediction because it changes movement speed.
- **Engaged** on a tick iff `ads` is held AND the active weapon's `sight != "none"` (fists and the grenade slot have none) AND the
  player is alive, not dropping, not reloading, not healing, not swapping, and not in a stance transition. Airborne is allowed (air
  spread still applies).
- **Sprint**: while `ads` is held, sprint is suppressed (ADS wins, even if ADS is blocked by a reload). Pressing RMB while sprinting
  ends the sprint on that tick.
- **Progress**: per tick, before the fire check: if engaged, `adsMs = min(adsTimeMs, adsMs + dt x 1000)`, else `adsMs = 0`.
  `adsProgress = adsMs / adsTimeMs` (1 when `adsTimeMs` = 0 and engaged). Leaving ADS is instant in the sim; the client may blend the
  camera out over `clientFeel.adsExitBlendMs` (cosmetic).
- **Movement**: while engaged, ground speed x `adsMoveMultiplier` (full value from the first engaged tick; see `stance.md` speed formula).
- **Firing does not end ADS.** A swap, reload start (manual or auto), heal start, stance-change start, or death sets `adsMs = 0`. If RMB
  is still held when the block ends, ADS re-engages from 0.
- **Camera** (client, M2b first person; full rules in `camera.md` "ADS in first person"): the camera is at the eye, so the screen centre
  is the shot ray. Zoom is true magnification from the default FOV: `vFovAds = 2 atan(tan(vFovDefault / 2) / adsZoom)` (rifle at the
  default 80 deg: 32.8 deg vertical), blended by `cameraBlend`. Iron and red_dot: the viewmodel's sight anchor moves onto the screen
  centre and the hip crosshair fades out. scope_4x / scope_8x: at `adsProgress = 1` the full-screen scope overlay appears and the
  viewmodel is hidden. (Replaces the M2a over-shoulder ADS camera and its linear `fov / adsZoom` formula.)
- **Sensitivity** (client): look speed = base x `lerp(1, adsSensitivity, cameraBlend) / zoom`, where `adsSensitivity` is the Settings
  "ADS sensitivity" multiplier (default 1.0), `cameraBlend` in [0, 1] is the client's camera ADS blend (follows `adsProgress` in, eases
  out over `clientFeel.adsExitBlendMs`), and `zoom = tan(vFovPlayer / 2) / tan(vFovCurrent / 2)` is the current magnification. Blending
  both terms means the look speed never jumps when aiming starts or ends. Hip fire: cameraBlend 0, so the factor is 1. Full ADS with the
  sniper at the default FOV and setting: about 1 / 8.
- **Recoil** is visual only (`camera.md`): viewmodel kick, camera roll and FOV punch, never an aim offset. The spread formula above is the
  only accuracy rule.
- Per-weapon ADS numbers: see `weapons.<id>.adsZoom / adsSpreadMultiplier / adsMoveMultiplier / adsTimeMs`.

### LMG fire penalty (M2a)
For `combat.fireMoveWindowMs` (300) after each shot, ground speed x the weapon's `fireMoveMultiplier` (LMG 0.55, every other weapon 1).
Holding the trigger keeps the window open. Hip-firing LMG: 5 x 0.55 = 2.75 m/s; ADS + firing: 5 x 0.5 x 0.55 = 1.375 m/s.

### Sniper rules (M2a; reworked in the damage pass 2026-11)
- Bolt action: `fireIntervalMs` (1400) is the bolt cycle. The scope stays up between shots. No separate key.
- No falloff, so every rule below holds at any distance up to `range` (300 m).
- Damage by level (`levels.overrides.sniper`): L1 88, L2 90.64, L3 93.28, L4 96 body; head x2 (176 / 181.3 / 186.6 / 192). The damage
  pass raised L1-L3 and deliberately left L4 at its old value.
- **Body shot never kills a full-HP player** at any level, with or without armor: L1 no armor 88 -> 12 HP left; vest_2: a = min(55,
  88 x 0.4 = 35.2) = 35.2, hp loss 52.8 -> 47.2 left.
- **Headshot on a bare head kills** at every level (176+ raw).
- **Helmet cap** (`combat.helmetHeadshotCap`, weapons `["sniper"]`, `maxHpLoss` 70): when a sniper headshot hits a player who wears a
  helmet with any durability left, the helmet absorbs as usual (`armor.md`: a = min(D, H x f)) and the head HP loss is
  `min(H - a, 70)`. A full-HP helmeted player is left on 30 HP. Every helmet below tier 4 is destroyed by the hit; a fresh helmet_4
  keeps 3.2 durability after an L1 shot and breaks on an L4 shot. The next headshot then kills.
- Why: a helmet should always buy the wearer one mistake against a sniper, at the cost of the helmet. Below 70 HP the capped hit
  still kills, so the sniper stays the best finisher.
- Tuning constraint (keep it when changing numbers): `effective damage x 1 < 100` at every level and `maxHpLoss < 100`.

### Shots to kill (M2a)
**Method.** Every armor piece obeys the invariant `durability < 100 x f / (1 - f)` (`armor.md`). Over a series of hits on one piece
with total raw damage X, the piece absorbs `min(D, f x X)` in total, so HP loss = `X - min(D, f x X)`. While the piece holds
(f X <= D) the loss is (1 - f) X <= (1 - f) D / f < 100, so nobody dies before their armor breaks. Death therefore needs
**X >= 100 + D**: a fresh piece adds exactly its durability as effective HP against the hits it covers.

Raw damage thresholds (full HP): no armor 100 · vest_2 100 + 55 = **155** · helmet_2 100 + 45 = **145** · vest_3 100 + 75 = **175** ·
helmet_3 100 + 75 = **175**. Shots = ceil(threshold / raw per hit). Time = (shots - 1) x fireIntervalMs (ideal; the 30 Hz tick can add
up to 33 ms per shot). All values at or below `falloffStart`; shotgun = all 9 pellets on the same zone.

Raw per hit at L1 (damage pass 2026-11, roughly +20% on every weapon). Sniper helmet columns use the helmet cap (above), so the
"threshold" method does not apply to them. Generated from `balance.json` with the same rules as `World.applyWeaponDamage`:

| Weapon | Raw body / head | No armor body | No armor head | vest_2 body | helmet_2 head | vest_3 body | helmet_3 head |
|---|---|---|---|---|---|---|---|
| fists | 15 / 15 | 7 (2.70 s) | 7 (2.70 s) | 11 (4.50 s) | 10 (4.05 s) | 12 (4.95 s) | 12 (4.95 s) |
| pistol | 24 / 42 | 5 (1.00 s) | 3 (0.50 s) | 7 (1.50 s) | 4 (0.75 s) | 8 (1.75 s) | 5 (1.00 s) |
| smg | 17 / 25.5 | 6 (0.40 s) | 4 (0.24 s) | 10 (0.72 s) | 6 (0.40 s) | 11 (0.80 s) | 7 (0.48 s) |
| shotgun | 117 / 175.5 | 1 (0.00 s) | 1 (0.00 s) | 2 (0.90 s) | 1 (0.00 s) | 2 (0.90 s) | 1 (0.00 s) |
| rifle | 23 / 41.4 | 5 (0.60 s) | 3 (0.30 s) | 7 (0.90 s) | 4 (0.45 s) | 8 (1.05 s) | 5 (0.60 s) |
| lmg | 20 / 30 | 5 (0.48 s) | 4 (0.36 s) | 8 (0.84 s) | 5 (0.48 s) | 9 (0.96 s) | 6 (0.60 s) |
| dmr | 50 / 87.5 | 2 (0.40 s) | 2 (0.40 s) | 4 (1.20 s) | 2 (0.40 s) | 4 (1.20 s) | 2 (0.40 s) |
| sniper | 88 / 176 | 2 (1.40 s) | 1 (0.00 s) | 2 (1.40 s) | 2 (1.40 s) | 2 (1.40 s) | 2 (1.40 s) |

Reading the table: armor still adds about 40-60% to body TTK at tier 3 (rifle 0.60 s -> 1.05 s). Every mag covers its worst case
(rifle 25 >= 8, SMG 30 >= 11, LMG 60 >= 9, DMR 10 >= 4, pistol 12 >= 8). The pump now one-shots an unarmored body when all 9 pellets
land (117), and the DMR kills an unarmored player with 2 body shots (100).

### Why the rifle no longer dominates (M1 finding: rifle took most kills)
1. **Damage 22 -> 19.** Unarmored body kill 5 -> 6 hits (0.60 -> 0.75 s). Headshot multiplier 1.75 -> 1.8 keeps 3 headshots lethal
   (3 x 34.2 = 102.6; 3 x 19 x 1.75 = 99.75 would leave 0.25 HP, which reads as a bug).
2. **Hip spread 1.0 -> 1.6 deg, falloff 40/110/0.7 -> 30/90/0.65.** Past ~20 m the rifle needs ADS, which costs 230 ms and 35% move
   speed. At 90 m it does 12.35 per hit (M1: 15.4 at 110 m).
3. **Competition at every range.** SMG still wins under ~12 m (0.56 s), the LMG out-DPSes it when planted (0.60 s), the DMR kills in
   3 shots at 40-180 m with a 0.3 deg cone, and the sniper owns 100 m+.
4. **Loot**: about 2.7 rifles per match (M1: 4.7), see `loot.md`.
5. **Bots** pick guns by range band (`bots.weaponPrefs`), so long-range bot kills move to the DMR and sniper.
Target (to confirm with `matchReport.ts` once the sim has the items): no single gun above 35% of weapon kills; rifle 15-30%.

### Inventory state
`slots: [WeaponInstance|null, WeaponInstance|null]`, fists implicit (slot 2), grenade slot (slot 3, M2a), `active: 0|1|2|3`,
`ammo: {light, heavy, shell, sniper}`, `heals: {bandage, medkit}`, `grenades: number` (M2a), `hp`,
`vest: {tier, durability} | null`, `helmet: {tier, durability} | null` (M2a, replaces `armor`), `stance`, stance transition timer,
`adsMs` (M2a). `WeaponInstance = {id, mag}`.
- Keys 1 / 2 / 3 / 4 select slot 0 / 1 / 2 / 3. **G** also selects slot 3. Selecting slot 3 with 0 grenades is refused
  (`actionFailed { action: 'swap', reason: 'noGrenades' }`). The mouse wheel cycles 0 -> 1 -> 2 -> 3 -> 0, skipping empty gun slots and slot 3 when
  `grenades` = 0.
- When the last grenade is thrown, the player auto-switches to the last gun slot used (or fists), paying `combat.swapMs`.

### Healing
Q runs the selection in GDD 7.4. Channel `useMs`. On completion: `hp = max(hp, min(hpCap, hp + heal))` with hpCap = item `healCap`,
then the item count decreases by 1. Cancelled by fire input, swap, reload, Q, death or match end, with no item consumed.
M2a: healing is allowed in every stance. Starting a heal ends ADS. Q while cooking a grenade is ignored (`grenades.md`).

## States and transitions (per player weapon state)
`Ready` -> fire -> `Cooldown (fireIntervalMs)` -> `Ready`
`Ready` -> R or empty-fire with reserve -> `Reloading (reloadMs)` -> `Ready` (swap or Q cancels)
any -> slot key -> `Swapping (combat.swapMs)` -> `Ready` (cancels reload and heal)
`Ready` or `Reloading` -> Q -> `Healing (useMs)` -> `Ready` (fire, swap, reload or Q cancels). Heal and reload are mutually exclusive
and the latest input wins.
M2a, orthogonal to the above: `ADS: Off <-> Engaged(adsMs)` per the ADS rules; `Stance: Settled(s) <-> Transition(from, to, ms)`
(`stance.md`); grenade slot states in `grenades.md`.

## Tunable values
`weapons.<id>.*` (including `sight`, `adsZoom`, `adsSpreadMultiplier`, `adsMoveMultiplier`, `adsTimeMs`, `fireMoveMultiplier`),
`combat.swapMs`, `combat.airSpreadMultiplier`, `combat.moveSpreadSpeedThreshold`, `combat.stanceSpreadMultiplier.*`,
`combat.fireMoveWindowMs`, `combat.hitbox.*`, `combat.deathDropScatter`, `items.<ammo>.*`, `items.vest_N/helmet_N.*`, `player.*`.
Nothing in this spec may be hard-coded.

**Expected to need playtest tuning**: rifle `damage` (19) and `spreadDeg` (1.6); LMG `fireIntervalMs` (120) and `fireMoveMultiplier`;
DMR `damage` (42) and `fireIntervalMs` (400); sniper `fireIntervalMs` (1400) and `adsMoveMultiplier`; all `adsTimeMs`;
`stanceSpreadMultiplier.prone` (0.6); armor durabilities (keep the invariant and the sniper constraint).

## Edge cases
- Reload with a full mag or 0 reserve: no-op. Reload partially fills when reserve < missing rounds.
- Picking up a weapon while reloading or healing: allowed, and it cancels both if the active slot changes.
- A dropped weapon keeps its `mag`, and a picked-up weapon keeps it too. Two of the same weapon is allowed.
- Picking up a gun while holding the grenade slot with both gun slots full replaces slot 0 (same as holding fists) and equips it.
- Damage to a dead or dropping player is ignored. Dropping players cannot be hit.
- Shots fired on the same tick as the shooter's own death still resolve (inputs are processed in order).
- Fists hit only players. Fists have no ADS; RMB with fists does nothing (no error prompt).
- ADS with an empty mag is allowed. An empty-fire auto-reload ends ADS.
- ADS held while swapping to a scoped gun: ADS starts from 0 when the swap ends.
- Sniper hip fire is allowed (6 deg cone). It is a gamble, not a bug.
- Shots against a prone player whose box pokes into a wall or rock: the ray hits the collider first, so the hidden part is safe.
- Overkill: damage events report the full amount; HP is clamped at 0 for display only.

## UI must show
Ammo `mag / reserve` (sniper ammo has its own reserve), slot icons 1-4 (slot 4 shows the grenade count), a screen-centre crosshair sized to the current
cone (hip) that fades out during ADS (the iron post or red dot is then the reticle; `camera.md`), a full-screen scope overlay for scope_4x/8x (4x and 8x reticles differ),
hit markers (body/head/kill, plus an "armor hit" and "helmet hit" variant, `armor.md`), damage-direction arc, HP bar, vest and helmet
icons with tier and durability (`armor.md`), stance icon (`stance.md`), heal channel bar, reload progress, pickup prompt, and the
prompts "Armor full", "Better armor equipped", "Inventory full", "Can't heal", "No grenades", "No room to stand", "Too deep".
Settings: ADS Hold/Toggle (default Hold) and ADS sensitivity (default 1.0); FOV, head bob and reduce motion are in `camera.md`.

## Audio and VFX
Per weapon: shot sound (positional for others), dry-fire click, reload start and end, swap. New: LMG (heavy rolling chatter), DMR (sharp
crack), sniper (very loud crack plus a bolt cycle sound that plays `fireIntervalMs` after the shot so enemies can count the gap).
ADS in/out cloth rustle (local only), scope-in lens sound for scopes. Hits: body thud, head ping, vest-hit clink, helmet-hit "tonk",
armor-break shatter (separate vest and helmet variants). Heal: channel loop plus finish chime.
VFX: muzzle flash, tracer, sand puff on terrain hits, cartoon hit spark. **Scope glint (M2a, counterplay)**: a remote player who is
ADS with a scope_4x or scope_8x weapon shows a bright glint sprite at the scope, visible at any range. Needs `anim.ads` and the weapon
in `PlayerState`.

## Bots (M2a additions; numbers in `bots.weaponPrefs`, `bots.ads`, `bots.ai`)
- Weapon choice at distance d: hold a usable gun whose `[minRange, maxRange]` contains d; ties go to the higher `lootValue`; if no
  gun's band contains d, use the best `expectedBodyDps(d)` (M1 rule). `expectedBodyDps` should use the ADS cone when the bot will ADS
  at that distance.
- Loot upgrade: replace the carried gun with the lower `lootValue` when the new gun's `lootValue` > old x `bots.ai.gunUpgradeFactor`.
- ADS: per `bots.ads._note`. While ADS, aim error x `bots.ads.aimErrorMultiplier`. A bot carrying a usable scoped gun uses
  `bots.ads.scopedVisionRange` (70 m) instead of `visionRange` for sight and for the engage-range cap.
- Bots aim at the chest of the target's current stance: feet + `stances.<stance>.height x bots.ai.aimHeightFraction`.
- **Build-round measurement (M2a, `matchReport.ts`)**: median match 365 s (idle human) / 357 s (looter); kill share SMG 27-33%, rifle 25%,
  DMR 14-19%, shotgun 10%, sniper 7-8%, LMG 6%. All inside the targets, and the rifle no longer dominates. Keep `bots.ads.scopedVisionRange`
  at 70: lowering it to 55 pushed the SMG to 34.6%. `bots.grenade.throwChancePerDecision` raised 0.08 -> 0.2 after measuring only
  1.3-1.8 bot throws per match. Next lever if the LMG stays under 8%: `weapons.lmg.fireMoveMultiplier` 0.55 -> 0.65.

## M2c: bigger arsenal, levels and scopes (live since balance v6)
Detail specs: `levels.md` (L1-L4), `melee.md` (knife, machete, paddle, glass), `rpg.md`, `smoke.md`, `scopes.md`, `grenades.md`
(throwable slot), `armor.md` (tier 4).

### Roster additions
| Weapon | Fire | Ammo | Sight (default) | Role | Main weakness |
|---|---|---|---|---|---|
| Revolver | semi, 450 ms | heavy | iron | Skill sidearm: 3 body / 2 head unarmored | 6 rounds, 2.6 s reload, slow trigger |
| Double barrel (`dbshotgun`) | semi, 250 ms | shell | iron | Closet gun: 120 per barrel at point blank, both barrels kill any armor <= ~3 m | 2 shells, 2.8 s reload, ~15 per barrel at 8 m, no scopes |
| RPG | single, mag 1 | rocket | iron (1.6x) | Flush cover and groups at 12-50 m | 3.8 s reload, visible slow rocket, dud under 5 m, epic only |
| Knife / Machete / Paddle | melee | - | none | Slot 3 (replaces fists) | 2.0-2.8 m reach, wind-up |
| Smoke | throwable | - | none | Break sight, cover a rotation | No damage |

### Inventory and keys (M2c)
- `slots: [WeaponInstance|null, WeaponInstance|null]` with `WeaponInstance = {id, mag, level, scope}`; melee slot `{id, level} | null`
  (null = fists); throwables `{grenade, smoke}` plus `selectedThrowable`; `spareScope: ScopeId | null`; ammo adds `rocket`; vest and
  helmet tiers 0-4.
- Keys: 1 / 2 = gun slots, **3 = melee slot** (fists or the melee weapon), **4 or G = throwable slot** (again: cycle frag <-> smoke),
  **T = switch sight** (`scopes.md`). The wheel cycles 0 -> 1 -> 2 -> 3, skipping empty gun slots and an empty throwable slot.
- Pickup rules gain: the same-id **upgrade swap** (`levels.md`), the melee slot swap (`melee.md`), scope auto-mount (`scopes.md`).
  Picking up the same gun at an equal or lower level is not refused (normal rules apply).
- Damage causes add `melee`, `rocket` (impact) and `explosion` (rocket blast, as frags). Kill feed weapons add the new ids with level.

### Time to kill at L1 and L4 (body / head at or below falloffStart; same method as "Shots to kill")
Thresholds: no armor 100, vest_2 155 (body), helmet_2 145 (head). Shots = ceil(threshold / per hit); time = (shots - 1) x interval.
Level multipliers: `levels.md` (guns: damage x1.25 and reload x0.85 at L4; pump, DMR, sniper and RPG have overrides).

| Weapon | L | Per hit body / head | Interval | No armor (body) | vest_2 (body) | helmet_2 (head) |
|---|---|---|---|---|---|---|
| pistol | 1 | 24 / 42 | 250 | 5 (1.00 s) | 7 (1.50 s) | 4 (0.75 s) |
| pistol | 4 | 30 / 52.5 | 250 | 4 (0.75 s) | 6 (1.25 s) | 3 (0.50 s) |
| revolver | 1 | 46 / 78.2 | 450 | 3 (0.90 s) | 4 (1.35 s) | 2 (0.45 s) |
| revolver | 4 | 57.5 / 97.75 | 450 | 2 (0.45 s) | 3 (0.90 s) | 2 (0.45 s) |
| smg | 1 | 17 / 25.5 | 80 | 6 (0.40 s) | 10 (0.72 s) | 6 (0.40 s) |
| smg | 4 | 21.25 / 31.875 | 80 | 5 (0.32 s) | 8 (0.56 s) | 5 (0.32 s) |
| shotgun | 1 | 117 / 175.5 | 900 | 1 (0.00 s) | 2 (0.90 s) | 1 (0.00 s) |
| shotgun | 4 | 117 / 175.5 | 765 | 1 (0.00 s) | 2 (0.77 s) | 1 (0.00 s) |
| dbshotgun | 1 | 140 / 210 | 250 | 1 (0.00 s) | 2 (0.25 s) | 1 (0.00 s) |
| dbshotgun | 4 | 175 / 262.5 | 250 | 1 (0.00 s) | 1 (0.00 s) | 1 (0.00 s) |
| rifle | 1 | 23 / 41.4 | 150 | 5 (0.60 s) | 7 (0.90 s) | 4 (0.45 s) |
| rifle | 4 | 28.75 / 51.75 | 150 | 4 (0.45 s) | 6 (0.75 s) | 3 (0.30 s) |
| lmg | 1 | 20 / 30 | 120 | 5 (0.48 s) | 8 (0.84 s) | 5 (0.48 s) |
| lmg | 4 | 25 / 37.5 | 120 | 4 (0.36 s) | 7 (0.72 s) | 4 (0.36 s) |
| dmr | 1 | 50 / 87.5 | 400 | 2 (0.40 s) | 4 (1.20 s) | 2 (0.40 s) |
| dmr | 4 | 57.5 / 100.625 | 320 | 2 (0.32 s) | 3 (0.64 s) | 2 (0.32 s) |
| sniper | 1 | 88 / 176 | 1400 | 2 (1.40 s) | 2 (1.40 s) | 2 (1.40 s) |
| sniper | 4 | 96 / 192 | 1120 | 2 (1.12 s) | 2 (1.12 s) | 2 (1.12 s) |
| knife | 1 | 41 / 61.5 | 350 | 3 (0.70 s) | 4 (1.05 s) | 3 (0.70 s) |
| knife | 4 | 51.25 / 76.875 | 280 | 2 (0.28 s) | 4 (0.84 s) | 2 (0.28 s) |
| machete | 1 | 62 / 93 | 650 | 2 (0.65 s) | 3 (1.30 s) | 2 (0.65 s) |
| machete | 4 | 77.5 / 116.25 | 520 | 2 (0.52 s) | 2 (0.52 s) | 2 (0.52 s) |
| paddle | 1 | 94 / 141 | 1000 | 2 (1.00 s) | 2 (1.00 s) | 2 (1.00 s) |
| paddle | 4 | 117.5 / 176.25 | 800 | 1 (0.00 s) | 2 (0.80 s) | 1 (0.00 s) |
| RPG | 1 / 4 | impact 48 + blast 132 -> 55.2 + 151.8 | reload 3.8 -> 3.04 s | 1 rocket | 1 (vest_2 dies to impact + blast) | (helmets never absorb) |

_Regenerated for the damage pass 2026-11. Shot counts are ideal (every hit lands); time = (shots - 1) x interval. The "Reading it" notes below were written for the pre-pass numbers; the ratios between L1 and L4 are unchanged because the level multipliers did not change, except the sniper (L4 now gains only bolt speed over L1-L3)._

Reading it:
- **The +25-35% guide holds on average**: per-gun mean of the three columns: pistol 1.28, revolver 1.44, SMG 1.33, rifle 1.30, LMG 1.26,
  DMR 1.25, sniper 1.25, knife 1.39, machete 1.25, paddle 1.25. Outliers come from shot-count rounding: the revolver gains nothing vs an
  unarmored body but halves its helmet_2 head time (2 headshots at L4); the knife gains most vs vest_2. The pump gains at point blank only
  1.18, but its tighter L4 cone makes it about 2.3x faster at 8 m (estimate: about 3.5 of 9 pellets land at L1 for 3 shots, 1.80 s; about
  5.7 at L4 for 2 shots, 0.77 s). The double barrel's point-blank kill is already instant; its level shows at 4-8 m and on the reload.
- **No L4 one-shot surprises**: the sniper body (96), two DMR body shots (96.6) and a pump body shot (99) never kill a full-HP player; an
  L4 rocket never kills a fresh vest_3 in one hit. The only new one-shots are deliberate and close: the double barrel at point blank
  (any level), and a paddle headshot (unarmored at L1, through helmet_2 at L4), both inside 3 m with a visible wind-up or a 2-shell
  limit.
- **Every mag covers its worst case** at L1 against vest_4 (200): pistol 10 <= 12, revolver 6 = 6, SMG 15 <= 30, rifle 11 <= 25, LMG 12 <=
  60, DMR 5 <= 10, sniper 3 <= 5, pump 3 <= 5, double barrel 2 = 2.

### Kill share expectations (to confirm with `matchReport.ts`; target: no weapon above 35% of weapon kills)
| Weapon | M2a measured | M2c expected | Why |
|---|---|---|---|
| SMG | 27-33% (office looter 33.7%) | 23-29% (office 25-30%) | 7.2 -> 6.5 per island match, 5.1 on the office (guaranteed roll leans away from the SMG there); the revolver, double barrel and melee take close kills |
| Rifle | 25% | 22-27% | Same count; 2x/4x scopes add a little reach (cut 4x from the rifle if it passes 30%) |
| DMR | 14-19% | 12-17% | Same count; more competition at 30-60 m from scoped rifles |
| Shotgun (pump) | 10% | 6-9% | 6.3 -> 4.8 per match (office 5.5) |
| Sniper | 7-8% | 6-8% | Unchanged count |
| LMG | 6% | 5-7% | Unchanged |
| Revolver | - | 4-7% | 3.4 per match (office 4.4), a common-tier upgrade over the pistol |
| Pistol | small | 3-6% | 6.5 per match (office 8.1), the most common early gun (guaranteed spawns) |
| Double barrel | - | 3-5% (office 5-8%) | 0.8 per match, devastating in rooms |
| Melee (all) | fists < 1% | 3-6% | 3.6 per match; bots use melee as a fallback, humans in close quarters |
| RPG | - | 1-2% | 0.2 per match, 3 rockets |
| Frag grenade | (counted separately) | unchanged | Slightly fewer frags (4.9) |
No single weapon should approach 35%. Watch items: SMG on the office (lever: `maps.office.loot.tiers.common.smg` 3 -> 2, then
`maps.office.loot.guaranteedWeapon.weights.smg` 15 -> 10); the double barrel on the office (lever: `maps.office.loot.tiers.rare.dbshotgun`
4 -> 2); the rifle with 4x (lever: drop `scope_4x` from `scopes.compatible.rifle`).

**Pacing run 1 (M2c step 2 previewed, 30 matches x 30 layout seeds per map; idle / looter human):**
| | Island | Office |
|---|---|---|
| Median match | 338 / 350 s (M2b 371 / 362) | 376 / 364 s |
| First kill (median) | 37 / 70 s (M2b 109 / 101) | 12 / 12 s |
| Top kill shares | idle: smg 26.5, dmr 21.5, rifle 17.1; looter: rifle 23.2, smg 22.6, dmr 14.7 | idle: rifle 20.8, smg 19.2, fists 15.6, pump 15.6; looter: rifle 22.7, smg 19.4, fists 15.5 |
| L4 share of kills | 17.4 / 10.6% | 5.0 / 8.0% |
| Per match | rockets 0.03-0.10, smokes 0.8-1.2, swings 0.03, scope mounts 2.2-2.3 | rockets 0.03-0.17, smokes 0.6, swings 0.07-0.10, scope mounts 2.3-2.4 |

**BUG-013 (rifle above 30% of kills) is resolved.** M2b had the rifle at 32.3% (idle) and 33.9% (looter) on the island. Run 1 puts it at
17.1% / 23.2% (island) and 20.8% / 22.7% (office), inside the 15-30% band. No weapon is above 27%. Close BUG-013. Re-check after tuning
round 1.

**Tuning round 1 (balance v6), and why:**
- Early fights were a side effect of gun scarcity, not of the guaranteed weapons themselves. The step-1 run (same guaranteed points, M2b
  tables) had a first kill at 146 s, but the step-2 tables cut plain common guns from 39 to 15, so unarmed bots crowded the few guns in the
  loot phase. That is not intended (GDD 10: a looting human should get 1-2 minutes before a real fight). Plain common guns go back up to
  20 (island) and 14 (office, which also gets knife 6 -> 9).
- `bots.eagernessCurve` 1.5 -> **1.75** (the next planned lever after 1.6, which run 1 used).
- Office fists 15.6% (M2b 8.4%): bots barely took melee weapons. `bots.melee.lootScoreMelee` 30 -> 60, `closeSwitchRange` 2.5 -> 3.0.
- L4 at 10-17% of island kills from about 3% of guns is a snowball (winners keep the best gun from death drops). It is partly intended,
  but L4 loot weights are cut (rare 3 -> 2, epic 20 -> 15). Target: at most 12% of weapon kills.
- RPG, smoke and melee are barely visible from bots. RPG: `lootValue` 3.0 -> 3.6, `maxRange` 50 -> 60, `coverRadius` 3 -> 4,
  `fireChancePerDecision` 0.35 -> 0.6, `cooldownMs` 6000 -> 4000. Smoke: `lootScoreSmoke` 14 -> 20, `retreatThrowChance` 0.6 -> 0.9,
  `zoneCrossThrowChance` 0.4 -> 0.7, `cooldownMs` 15000 -> 10000.
- Glass broken 0 per match is expected: bots never break glass on purpose (melee.md); humans will.

**Pacing run 2 (live v6, 30 matches x 30 layout seeds; idle / looter):** island median 364 / 360 s, first kill 155 / 94 s, top shares
rifle 21.4 / smg 23.9, L4 8.9 / 12.8% of kills. Island with eagernessCurve 2.0: 360 / 348 s and L4 16.4%, no better, so 1.75 stays.
Office median 355 / 368 s, first kill 12 / 12 s, top shares smg 22.7 / 25.6, fists 14.0 / 13.1%, L4 2.7 / 5.2%. Bots per match:
rockets 0.10-0.30, smokes 0.7-1.0, swings 0.2-0.3.

**Tuning round 2 (balance v7), office only:**
- The office fists share and its short idle median have one cause: landing brawls. The first kill comes about 4 s after landing, and 4
  of 12 are dead before phase 2. Loot changes cannot fix fights that happen before anyone loots, and the island must not move, so the
  levers are office-only bot overrides: `maps.office.bots.drop.maxBotsPerTarget` 2 -> 1, `maps.office.bots.dropSpreadRange` 15 -> 20 and
  `maps.office.bots.lootPhaseEngageRange` 4 -> 3. Expected: office first kill above 25 s, fists under 9%, median about 365-380 s.
- **Accepted as-is:**
  - Island looter L4 at 12.8%. It is within run-to-run noise of the 12% target, and the idle variant is at 8.9%.
  - Bot smoke (about 0.7-1.0 per match) and melee swings (about 0.2-0.3 per match). These are nice-to-have for bots, and humans are the
    main users. Raising them further needs new bot triggers (code), not numbers, and must not distort loot. The targets for bots drop to
    "visible in most matches"; Later: an offensive smoke throw and a melee finish on a low-HP target.

**Pacing run 3 (office, live v7; idle / looter):** median 360 / 392 s, fists 8.3 / 7.9%, top shares rifle 26.1 / 20.8, pump 20.1,
smg 18.5 / 19.6, L4 5.8 / 4.5% of kills; bots per match: swings 0.37-0.50, smokes 0.97, rockets 0.03-0.07. First kill median 18 / 15 s
misses the > 25 s goal, which is accepted: the real problem (fist brawls at landing) is fixed. The island was not rerun because no island
key changed (run 2 stands).

**Balance v7 was LOCKED for M2c QA.** Changes from here go through a bug or playtest report and a new balance version.

**After the bot zone-entry fix (v7, game-developer; idle / looter):** in-match bot stuck time fell (office 10.6% -> 1.7-2.4%, island
-> 0.2-0.4%). Bots now really reach the circle, so matches got shorter: island 341 / 353 s, office 354 / 358 s. Kill shares stayed fine
(max SMG 25.7%, office fists 7.3-8.1%, RPG 1-2.3%), and alive at P3 / P4 is unchanged (about 7 / 3).

**Balance v8: one shared lever, zone waits** P2 60 -> 70, P3 55 -> 65, P4 40 -> 45 (+25 s, both maps; `zone.md`). Why this lever: endings
cluster at the phase 3 shrink and phase 4, so they are zone-driven, and eagernessCurve 2.0 was already shown not to help (run 2). Radii,
DPS, loot and bots are untouched, so kill shares should not move. Expected median about 365-380 s on both maps; worst case now 9:05.
Lock status: suspended until pacing run 4 passes (median 360-420 s in all four map/variant cells, no weapon above 35%, office fists < 9%).
Tests that hard-code the old phase end times (`src/shared/sim/zone.test.ts` AT6, `src/shared/sim/indoor.test.ts`) need the new values or,
better, values derived from balance.

**Pacing run 4 (v8; idle / looter):** island median 365 / 358 s, office 388 / 387 s. Max weapon share 24.7% (island SMG), office fists
8.4 / 7.3%, L4 4-11% of kills. In-match bot stuck time: island 0.35-0.56%, office 1.5-2.7%. The island looter's 358 s is accepted as within
noise of 360.
- **Playtest watch item:** alive at the start of P4 fell to a median of 2.0 in all four cells (was about 3). The longer middle waits let
  more fights resolve before the endgame circle, so some endgames start as a duel. If the user finds endgames too thin, the levers in
  order are:
  1. Move 10 s of wait from P2/P3 to P4 (P2 65, P3 60, P4 55): same total length, more players reach the tight circles.
  2. Raise `bots.eagernessRampSeconds` 300 -> 360: a calmer mid-game that keeps more bots alive.

**Balance v8 is LOCKED for M2c QA** (director decision after run 4). Changes from here go through a bug or playtest report and a new
balance version.

### Pacing (median match 6-7 min, acceptance 330-480 s)
The match length is set mostly by the zone schedule (v8: shrinks end at 8:25, collapse at 9:05) and bot eagerness. M2c pushes both ways:
shorter fights (mean gun damage x1.045 from levels, about 24% fewer heals, the double barrel and RPG) vs longer survival (smoke escapes,
tier-4 armor, melee instead of guns for some early fights). The M2a baseline (357-365 s) already sits at the bottom of the 6-7 min target,
and run 1 came in at 338-350 s on the island, so `bots.eagernessCurve` is now 1.75 (a calmer mid-game; late game unchanged because the zone
floor still forces full eagerness by phase 5). Expected after round 1: 360-390 s on both maps, island first kill back above 90 s. Levers if
still below 360 s, in order: eagernessCurve 1.75 -> 2.0; `bots.lootPhaseEngageRange` 4 -> 3; common bandage 17 -> 20. If above 420 s
(office first): eagernessCurve 1.75 -> 1.6. Tuning target, not a unit test.

### Bots (M2c summary)
Levels: lootValue x `levels.botValueMultiplier`. New guns in `bots.weaponPrefs` (revolver 0-30 m, value 1.8; double barrel 0-6 m, value
2.8). Melee (`bots.melee`), RPG as a special action (`bots.rpg`), smoke on retreat and zone escapes (`bots.smoke`), scopes auto-mount only
(`bots.scopes`). Bots treat smoke as opaque. `matchReport.ts` must report kills by weapon id and level, melee and RPG kills, smokes thrown,
scopes mounted, and median match length per map (request to game-developer).

## Acceptance tests (QA, mostly Vitest on src/shared/sim)
1. Rifle body hit at 10 m on 100 HP / no armor deals 19. At 60 m it deals 15.675. At 90 m and at 120 m it deals 12.35. At 151 m it misses.
2. Standing rifle target (feet y = 0): a hit at y = 1.0 is a headshot and deals 34.2; at y = 0.7 it is a body hit and deals 19.
3. Three rifle headshots (no armor, <= 30 m) kill a 100 HP target; two leave it at 31.6.
4. Shotgun point-blank, all pellets on the body, 0 spread (forced): a 100 HP target ends at 1 HP. A second shot kills.
5. Shotgun with 5 head pellets and 4 body pellets on a target with helmet_2 and vest_2: helmet absorbs min(45, 82.5 x 0.4) = 33,
   vest absorbs min(55, 44 x 0.4) = 17.6, HP loss = 126.5 - 50.6 = 75.9; exactly one damage event with headshot = true.
6. Semi-auto pistol: holding LMB fires exactly one shot. Sniper: holding LMB fires one shot; a second click 1000 ms later does nothing;
   a click at >= 1400 ms fires.
7. Reload with mag 3/12 and reserve 5 ends at 8/12 and reserve 0.
8. Swapping during a reload: after the swap the mag is unchanged and no ammo is consumed.
9. Bandage at 70 HP ends at 75 HP. Bandage at 75 HP is refused. Medkit at 30 HP ends at 100 HP.
10. Firing during a heal cancels it and the item count is unchanged. Q during a reload starts the heal and keeps mag/reserve.
11. A full inventory (both slots) picking up a weapon while holding slot 2 drops the slot-2 weapon at your feet with its mag intact.
12. Picking up 30 light ammo with 170 carried takes 10 and leaves 20 on the ground. Picking up 5 sniper ammo with 18 carried takes 2.
13. **ADS spread**: standing still with the rifle, hold `ads` for 7 inputs (233 ms >= 230): `effectiveSpreadDeg` = 0.8. After 3 inputs
    (100 ms): 1.6 x (1 - 0.5 x 100/230) = 1.2522 (+-0.001). Releasing `ads` returns it to 1.6 on the next tick.
14. **ADS blocks**: with `ads` held, a reload start sets adsProgress to 0 and spread to hip; when the reload ends with `ads` still held,
    ADS ramps again from 0. Same for swap and heal. `ads` with fists or the grenade slot: adsProgress stays 0, speed unchanged.
15. **ADS vs sprint**: holding `sprint` + forward + `ads`: speed settles at walkSpeed x adsMoveMultiplier (rifle 3.25 m/s), never
    sprintSpeed. Releasing `ads` (still holding sprint) resumes sprint.
16. **Spread combination**: sniper, prone settled, ADS full, still, grounded: 6 x 0.02 x 0.6 = 0.072. Same while crawling
    (5 x 0.25 x 0.4 = 0.5 m/s < 1.0): still 0.072. LMG crouched, ADS full, walking: 2.6 x 0.45 x 0.8 x 3.0 = 2.808.
17. **LMG fire slow**: LMG holding fire and forward (no ADS), speed settles at 2.75 m/s; 300 ms after the last shot it returns to 5.0.
18. **Sniper rules** (L1, no falloff, test at 10 m and 250 m): body vs 100 HP no armor -> 12 HP; body vs vest_2 (55) -> 47.2 HP,
    vest 19.8; head with no helmet -> dead; head vs helmet_1 (30), helmet_2 (45), helmet_3 (75) and helmet_3 at 1 durability -> 30 HP
    and the helmet is destroyed (helmetTier 0); head vs a fresh helmet_4 -> 30 HP, helmet 3.2.
19. **Shots-to-kill table** (forced 0 spread, at 5 m): for every row and column of the table above, the target dies on exactly the
    listed shot and not one shot earlier (parametrised test).
20. **DMR**: semi-auto, at 40 m a body hit deals 50 and a head hit 87.5; at 180 m+ a body hit deals 40.
21. Stance hitbox and transition firing rules: see `stance.md` tests. Armor rules: `armor.md`. Grenades: `grenades.md`.
22. Pacing and weapon mix (headless, `matchReport.ts --matches 30 --variant both`): median match 330-480 s; no weapon above 35% of
    weapon kills; the rifle between 15% and 30%. Tuning target, not a unit test.

M2c (system details in each linked spec):
23. **TTK table** above (forced 0 spread, 5 m, single-pellet guns; pump and double barrel with all pellets on one zone at 1 m): for every
    row and column, the target dies on exactly the listed shot or hit at L1 and L4, not one earlier (parametrised over level).
24. Revolver: semi; 3 body hits (114) kill unarmored; 2 headshots (129.2) kill unarmored; mag 6, reload 2600 ms; at 60 m+ a body hit
    deals 22.8.
25. Double barrel: one barrel per click, the second click after >= 250 ms fires the second barrel; a 1 m full-pellet body hit deals 120
    (unarmored: dead); two barrels on a fresh vest_4 at 1 m kill (240 >= 200); reload refills both barrels (2 shells) in 2800 ms; at 8 m
    on a standing target, the mean damage per barrel over 1,000 seeded shots is 8-25.
26. Damage causes and kill feed: a knife kill reports weapon `knife` with its level; a rocket direct-hit kill reports `rpg`.
27. Inventory: key 3 selects the melee slot (fists when none); key 4 / G and T behave as in `grenades.md` and `scopes.md`.
28. Equal-level pickup: carrying an L2 rifle and an empty slot, E on an L2 rifle fills the empty slot (not refused).
29. Pacing and mix (`matchReport.ts`, 30 matches each on island and office): median 330-480 s (target 360-420 s); no weapon id above 35%
    of weapon kills; melee kills > 0 and RPG kills > 0 in the totals. Tuning target, not a unit test.

## Affected agents when this spec changes
game-developer (sim combat, ADS, bots), tech-lead (types, validation), network-engineer (`ads` input, snapshot fields),
ui-ux-designer (crosshair, scope overlay, slot 4, settings), graphics-designer and graphics-engineer (new gun models, scope glint,
scope overlay art), audio-designer (new gun sounds, ADS sounds, armor hit variants), narrative-designer (weapon names, prompts),
qa-tester (tests above).
