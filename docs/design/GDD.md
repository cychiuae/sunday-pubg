# Beach Survival PvP: Game Design Document (M1 "First Playable" + M2a "Arsenal & Stance" + M2b "Office & Drop" + M2c "Fresh Every Match & Bigger Arsenal")

Owner: game-designer. Every number lives in `docs/design/balance.json`; this doc names keys as `section.key`.
Units: metres, m/s, degrees. Times are in ms unless the key ends in `Seconds`. Y is up, sea level is y = 0.
Detail specs: `systems/combat.md` (combat, ADS, weapons, inventory, heals), `systems/armor.md` (vests and helmets),
`systems/stance.md` (crouch and prone), `systems/grenades.md` (frag grenades), `systems/zone.md` (the tide), `systems/loot.md` (loot),
`systems/maps.md` (map vote, office rules, per-map overrides; M2b), `systems/drop.md` (carrier drop; M2b), `systems/rooms.md` (rooms; M2b), `systems/camera.md` (first-person camera; M2b),
M2c: `systems/levels.md` (item levels L1-L4), `systems/melee.md` (knife, machete, paddle, breakable glass), `systems/rpg.md`, `systems/smoke.md`,
`systems/scopes.md` (scope attachments), `systems/layout.md` (per-match layout variety rules). M2c numbers are live in `balance.json` since v6
(the `_m2cPending` staging block is gone).

Scope tags: **MVP** = in M1. **M2a** / **M2b** / **M2c** = added in that milestone. **Later** = planned after that. **Maybe** = only if playtests ask for it.

## 1. Pitch
Twelve cute chibi castaways wash up on a bright tropical island. They grab whatever is lying on the sand,
the tide rises and squeezes everyone together, and the last one standing wins. The game looks like a holiday
postcard and plays like a tense duel. Matches take 5 to 8 minutes in a browser tab, and you are holding a gun within 30 seconds.

## 2. Pillars
1. **Cute outside, tense inside.** Toon-shaded chibis, beach umbrellas and tiki torches. The stakes are still real:
   one life, and every fight could be your last. The contrast is the point, so keep the art soft and the rules sharp.
2. **Readable fights.** Every shot has a tracer, a muzzle flash and a positional sound. Every hit shows a hit
   marker, and every hit you take shows where it came from. You lose because you were outplayed, not because you were confused.
3. **Fast to fun.** Spawn, drop, loot and fight in under 30 seconds. There is no plane and no menus mid-match.
4. **Always a decision.** Loot now or rotate? Heal now or push? Keep the shotgun or swap it for a rifle? Aim down sights (accurate, slow)
   or hip-fire on the move? Go prone (small, steady, stuck) or stay mobile? Throw the grenade now or cook it? Mechanics without a decision are cut.
   M2c: an L2 SMG or an L1 rifle? A 4x on the rifle or keep the red dot? Smoke out to heal, or smoke in to push? Rocket the rock, or save
   it? Knife (first hit) or paddle (reach and push)?
5. **Fresh every match (M2c).** Same island and office, different details: loot positions, prop arrangements and light change per match from a
   seed, while POI loot counts, routes and fairness stay fixed (`systems/layout.md`). Knowledge of the map pays; memorised loot routes do not.

## 3. Core loop
**Drop -> Loot -> Rotate with the tide -> Fight -> Win (or spectate -> results -> next match).**

| Beat | Time | Player decision |
|---|---|---|
| Flight + drop | ~10-25 s (M2b) | When to jump off the carrier and where to land: a busy POI under the route or a quiet edge; open the parachute early to glide far |
| Loot | 0:00-1:30 | What to keep (2 weapon slots), when to leave. Bots mostly loot here too (section 10) |
| Rotate | each phase | Which path into the next circle: open beach (fast, exposed) or treeline (slow, cover) |
| Mid-game | 1:30-4:45 | Roomy circles (65 m, then 47.5 m). Pick your fights, third-party others, or hold and heal |
| Fight | anytime | Engage, disengage, or heal behind cover |
| Endgame | ~5:30+ | The circle drops to 27.5 m, then 14 m, then 5 m. Hold position or force the last fights |

## 4. Session flow (MVP)
1. **Title**: enter a name (1-16 chars). M2b: then the **room browser** (public rooms, Create room, Join by code; `?room=CODE` deep link).
2. **Waiting room (M2b, replaces the single lobby; full rules in `systems/rooms.md`)**: the host starts with >= 1 human (>= 2 with "fill with
   bots" off); the countdown also starts when all humans (>= 2) are ready, or after a 60 s timer in public rooms. Countdown
   `match.countdownSeconds`; the map (fixed by the host, or the `maps.md` vote) and the carrier route lock 3 s before the end. At zero, bots
   fill to `match.targetPlayers` when the fill toggle is on. Someone who joins mid-match spectates, then waits in the waiting room.
2b. **Layout (M2c, `systems/layout.md`)**: at the map lock the match gets a `layoutSeed`; server and clients build the same layout from it
   (loot positions from candidate pools, POI / desk-zone arrangements, decoration, look or lighting preset). The office nav grid is built here.
   The seed is shown in the Esc panel and on results; `LAYOUT_SEED=` pins it for QA.
3. **Drop (M2b carrier drop, full rules in `systems/drop.md`; replaces the M1 spawn-in-the-air start)**: everyone starts aboard one carrier
   (island: a seaplane at 120 m; office: a toy delivery drone at 25 m) flying a random straight route, shown on the map from the vote lock.
   Aboard you are invulnerable and cannot act. After `drop.noJumpMs`, Space or F jumps; anyone left is auto-ejected at the eject point.
   Freefall (`drop.freefallSpeed`, `freefallSteerSpeed`), then a parachute at `drop.chuteDeployHeight` (or earlier with Space/F) at
   `movement.dropFallSpeed` / `dropSteerSpeed`. Dropping players cannot fire, pick up, heal or be hit. Landing never deals fall damage.
   Zone phase 1 starts its timer at match start; average landing is about 17 s on the island.
4. **Match**: no respawns. On death the player gets a death screen for `match.deathScreenSeconds`
   (killer, weapon, your placement and kills), then spectates. Spectate follows the killer if they are alive, otherwise any alive
   player (humans first). Click or Space cycles through targets. M2b: spectating is first person from the target's eye; V toggles a
   third-person chase view.
5. **End**: the match ends when one player is alive. The winner sees "Winner" and everyone else sees the results screen
   (placement, name, kills, bot tag) for `match.resultsSeconds`. Then everyone returns to the same waiting room (same host and
   settings, ready flags reset); the next countdown starts by the room's start rules.
6. **All humans dead** (`match.endWhenNoHumansAlive`): `match.lastHumanDeathDelaySeconds` after the last human dies, the match
   resolves. Remaining bots are ranked by current HP + vest durability + helmet durability, then kills, then entity id. The top bot wins. Nobody waits minutes for a bot-only match.
7. **Disconnect mid-match**: the player is eliminated on the spot (counted as "left"). Their loot drops. Kill credit follows the rule in section 8.

Expected length (balance v9 schedule): the tide schedule ends at 7:30 (450 s), and the final collapse guarantees an end by 8:10 (490 s).
Target: median 320-400 s (about 5.5-6.5 min; acceptance 300-480 s), nearly all matches between 5:00 and 8:10. Timeline (detail in
`systems/zone.md`):

| Time | Tide | Bots |
|---|---|---|
| 0:00-1:00 | Phase 1 wait, circle 125 m (whole island) | Loot phase: fight only at point blank or when shot |
| 1:00-1:45 | Shrink to 87.5 m | Loot phase ends at about 1:15-2:00 (depends on personality) |
| 1:45-3:20 | Phase 2: wait 50 s, then shrink to 65 m | Eagerness ramping; mostly local fights |
| 3:20-4:45 | Phase 3: wait 45 s, then shrink to 47.5 m | Mid-range fights, third parties |
| 4:45-6:00 | Phase 4: wait 45 s, then shrink to 27.5 m | Eagerness near full; the ramp completes at about 6:30 |
| 6:00-7:30 | Phases 5-6: 13.75 m, then 5 m | Everyone in range |
| 7:30-8:10 | Final hold 20 s, collapse to 0 | Match always ends |

## 5. Controls (mouse + keyboard, MVP)
| Input | Action |
|---|---|
| Mouse (pointer lock) | Look / aim (sensitivity setting) |
| W A S D | Move |
| Shift (hold) | Sprint. Works only while standing, moving forward and not firing, aiming, healing or dropping. From crouch it stands you up first |
| Space | Jump when standing. From crouch: stand up. From prone: crouch (M2a). Aboard the carrier: jump out; in freefall: open the parachute (M2b) |
| F | Aboard: jump out; in freefall: open the parachute (M2b; same as Space) |
| LMB | Fire. Hold for automatic weapons; semi-auto and bolt fire once per click. With the grenade: hold to cook, release to throw (M2a) |
| RMB (hold) | Aim down sights (M2a). Settings: Hold/Toggle, ADS sensitivity |
| C | Toggle crouch (M2a) |
| Z | Toggle prone (M2a) |
| R | Reload. Firing an empty magazine also auto-reloads if you have reserve ammo |
| E | Pick up the nearest pickup within `player.pickupRange` |
| 1 / 2 / 3 / 4 | Weapon slot 1 / slot 2 / melee (fists, or the knife/machete/paddle; M2c) / throwable (M2a; M2c: frag or smoke). G also selects the throwable slot. Mouse wheel cycles |
| 4 or G again (M2c) | While holding the throwable slot: cycle frag <-> smoke (only types you carry; 250 ms). Ignored while cooking |
| T (M2c) | Switch sight on the held gun: mounted scope <-> pouch scope, or remove to the pouch (600 ms; not while aiming; `systems/scopes.md`) |
| Q | Use the best heal (see 7.4). Press again to cancel |
| V | While spectating: switch first person / third-person chase (M2b) |
| Esc | Release the pointer and open settings (sensitivity, ADS mode, ADS sensitivity, FOV, head bob, reduce motion, volume) |

Ctrl is never bound (Ctrl+W closes the tab). Later: a drop-weapon key, Tab for the scoreboard, M for the full map, lean, key rebinding.
RMB with a melee weapon does nothing (M2c decision; a block/shove is Maybe). Touch (M2c notes): the sight switch is a tap on the active slot's
sight chip; the throwable button cycles on a second tap. Gamepad (Maybe): D-pad down for the sight switch.
Touch (Later): twin virtual sticks, a fire button on the right stick, context buttons for E/Q/R, an ADS button, one stance button
(stand -> crouch -> prone), and a grenade button that shows the arc while held. Gamepad (Maybe): left stick move, L3 sprint, right stick aim,
LT ADS, RT fire, X reload/pick up, Y swap, LB heal, RB grenade, B tap crouch / hold prone. Gamepad aim needs aim slowdown near targets.

**Camera (M2b: first person; full rules in `systems/camera.md`)**: on foot, in freefall and under the parachute the camera is at the
player's eye (the current stance's `eyeHeight` above the feet), which is also where the authoritative shot ray starts. The crosshair is the
screen centre, so you hit what you aim at and nobody can peek around corners (the M1 over-shoulder peek is gone). The local body is
hidden; you see chibi arms holding your item. FOV setting 70-100 (default 80, horizontal at 16:9), head bob toggle, reduce motion.
Third person remains only aboard the carrier (orbit), on the death cam, in the V chase view while spectating, and on results.
**ADS**: iron sights and red dots bring the sight to the screen centre and zoom by `adsZoom`; 4x and 8x scopes switch to a full-screen
scope overlay once fully aimed. Recoil is visual only. Prone limits aim pitch to -30..+45 deg (`movement.stances.pronePitch*`).

## 6. Movement (MVP)
- Ground speed is `movement.walkSpeed`, or `movement.sprintSpeed` while sprinting. Acceleration `movement.accel` and friction `movement.friction`.
- Jump: `movement.jumpVelocity` with `movement.gravity`, about 1.05 m high, enough to hop onto crates. In the air, players have `movement.airControl` of normal steering.
- Water: when the terrain under you is more than `movement.waterDepthThreshold` below sea level, speed is multiplied by
  `movement.waterSpeedMultiplier`. The world edge (`MapData.worldRadius`) is a hard wall.
- Fall damage (not during the drop): if landing speed > `movement.fallDamageMinSpeed`, damage =
  (speed - minSpeed) * `movement.fallDamagePerMs` (HP per m/s over the threshold; the key name is historical). Fall damage ignores armor.
  Fall speed is capped at `movement.terminalVelocity`.
- While healing, speed is multiplied by `movement.healMoveMultiplier` and you cannot sprint.
- Ledges up to `movement.stepHeight` (0.35 m) are stepped over without jumping. This covers driftwood logs (0.35 m). Crates need a jump.
- **Stances (M2a, `systems/stance.md`)**: stand, crouch (x0.55 speed, 0.95 m tall, spread x0.8) and prone (x0.25 crawl, a 1.5 m long and
  0.6 m tall box along your aim, spread x0.6). Transitions take 200-700 ms (`movement.stances.transitionMs`) and you cannot shoot or aim
  during them. No prone in water deeper than `movement.stances.proneMaxWaterDepth` (0.2 m) and no crouch deeper than
  `crouchMaxWaterDepth` (0.55 m); crawling or crouching into deeper water stands you up. You cannot stand up under a low overhead collider.
- **Speed** = base x stance x ADS x heal x water x LMG-firing multipliers (formula in `systems/stance.md`).

## 7. Combat and inventory (MVP; full rules in `systems/combat.md`)
### 7.1 Hitscan
- Server-authoritative and instant. Shots are blocked by terrain and prop colliders. Water does not block shots.
- Hitbox: standing, a vertical cylinder with radius `player.radius` and height `player.height`. The **head** is the top `player.headZoneFraction`
  (40%, because chibis have big heads). Headshot damage = damage * `headshotMultiplier`. Crouch and prone hitboxes (M2a): `systems/stance.md`.
- Damage falloff: full damage up to `falloffStart`, then a linear drop to `minDamageFactor` at `falloffEnd`, flat after that. Shots never hit beyond `range`.
- Spread (M2a formula): each pellet deviates randomly inside a cone with half-angle
  `spreadDeg x ADS x stance x move x air`: ADS = lerp(1, `adsSpreadMultiplier`, ADS progress); stance = `combat.stanceSpreadMultiplier`
  (1 during a stance transition); move = `moveSpreadMultiplier` when horizontal speed > `combat.moveSpreadSpeedThreshold`; air =
  `combat.airSpreadMultiplier` when airborne. The crosshair grows with the current cone.
- Fire modes: `automatic: true` fires every `fireIntervalMs` while LMB is held. Otherwise one shot per click, at most once per `fireIntervalMs`
  (the sniper's 1400 ms is its bolt cycle). Fists are melee hitscan with `range` 2 m.

### 7.2 Armor (M2a: vests and helmets, full rules in `systems/armor.md`)
- Two equipment slots, each tier 1-3: a **vest** (`vest_1..3`) absorbs body hits and grenade damage, a **helmet** (`helmet_1..3`) absorbs
  head hits only. Each piece has `durability` and `absorbFraction` (`items.<id>`). Worn on pickup, never carried.
- Per hit on the covered zone: `a = min(durability, dmg x absorbFraction)`, `durability -= a`, `hp -= dmg - a`. At 0 durability the piece
  is destroyed. Zone and fall damage ignore armor.
- A fresh piece adds exactly its durability as effective HP against the hits it covers: vests +35 / +55 / +75, helmets +30 / +45 / +75.
- Picking up a higher tier replaces yours and drops the old one with its remaining durability. Same or lower tier is refused
  ("Better armor equipped"). Worn armor drops on death (`armor.dropOnDeath`).

### 7.3 Weapons and reloads
- 2 weapon slots plus fists (always slot 3, cannot be dropped). Picking up a weapon fills the first empty slot. If both slots are full, it
  replaces the **held** weapon (slot 1 if you are holding fists). The replaced weapon drops at your feet with its loaded ammo.
  If you were holding fists, the new weapon is equipped automatically. M2a: the grenade is key 4 (slot index 3) and behaves like fists
  for weapon pickups (a full inventory replaces slot 1).
- Ammo is shared per type (`ammo_light`, `ammo_heavy`, `ammo_shell`, `ammo_sniper` (M2a)) up to `items.<ammo>.maxCarry`. Reloading
  (`reloadMs`) moves rounds from the pool into the magazine when it finishes. Switching weapons cancels a reload. You cannot fire while reloading.
- Switching weapons takes `combat.swapMs`, during which you cannot fire.
- Holding LMB cancels sprint. Sprint resumes when you release LMB.

Body shots to kill / time to kill at full damage range (full table with headshots and arithmetic in `systems/combat.md`):

| Weapon | Sight | Role | No armor | vest_2 | vest_3 |
|---|---|---|---|---|---|
| Fists | - | Desperation | 7 / 2.7 s | 11 / 4.5 s | 12 / 4.95 s |
| Pistol (semi) | iron | Early sidearm | 5 / 1.0 s | 7 / 1.5 s | 8 / 1.75 s |
| SMG (auto) | iron | Close range, run and gun | 6 / 0.4 s | 10 / 0.72 s | 11 / 0.8 s |
| Shotgun (pump) | iron | Point-blank burst, 117 max | 1 / 0 s | 2 / 0.9 s | 2 / 0.9 s |
| Rifle (auto) | red dot | All-rounder 10-45 m, needs ADS at range | 5 / 0.6 s | 7 / 0.9 s | 8 / 1.05 s |
| LMG (auto, M2a) | red dot | Planted suppression, 60 rounds | 5 / 0.48 s | 8 / 0.84 s | 9 / 0.96 s |
| DMR (semi, M2a) | 4x | Long-range picks; head + body kills | 3 / 0.8 s | 4 / 1.2 s | 4 / 1.2 s |
| Sniper (bolt, M2a) | 8x | One-shot headshot on a bare head or through helmet_1; helmet_2+ caps it at 70 HP | 2 / 1.4 s | 2 / 1.4 s | 2 / 1.4 s |

Counterplay: the SMG falls off past 12 m; the rifle and LMG are inaccurate on the move; the shotgun is useless past ~15 m; the DMR and
sniper are clumsy up close, slow to aim and show a **scope glint** while aimed. A sniper body shot never kills a full-HP player, and a sniper headshot never kills a full-HP player who wears helmet_2 or better (the helmet breaks or is badly damaged instead; `combat.helmetHeadshotCap`, `minHelmetTier` 2 since balance v9). A helmet_1 does not save you from a sniper headshot (176 - 30 = 146 HP loss). Damage pass 2026-11: every weapon does about 20% more damage than at M2c lock, except the L4 sniper, which keeps 96 / 192. Balance v9 took some of it back: DMR 50 -> 44 (3 body shots unarmored), paddle 94 -> 78; frags went up 120 -> 140.
Every shot has a tracer, so the target always knows where fire is coming from.

### 7.3b Aim down sights (M2a, `systems/combat.md` "ADS")
Hold RMB to aim. ADS ramps over the weapon's `adsTimeMs`, shrinks spread toward `adsSpreadMultiplier`, slows you by `adsMoveMultiplier`,
and zooms by `adsZoom`. No ADS while reloading, healing, swapping, dropping or changing stance. Holding RMB suppresses sprint. Firing keeps ADS.

### 7.4 Heals
- `bandage` heals `heal` HP but never above `healCap` (75). `medkit` heals up to `healCap` (100). The heal is applied all at once when the channel (`useMs`) finishes.
- **Q picks the best heal**: if HP >= 75, use a medkit (fail if you have none). If HP <= `items.medkit.preferAtOrBelowHp` (50) and you have a medkit, use the medkit. Otherwise use a bandage, falling back to a medkit.
  A heal fails with a prompt when you are at full HP, have no usable item, or are dropping.
- Firing, switching weapons, reloading or pressing Q again **cancels** the channel, and the item is not used up. Taking damage does not cancel it. You can move at reduced speed while healing.
- Heal and reload are mutually exclusive, and the latest input wins: pressing Q during a reload cancels the reload (no ammo is moved), and R during a heal cancels the heal.
- Low HP: at or below `player.lowHpThreshold` (30) the HUD and audio show a low-health warning (heartbeat, pulsing HP bar).
- Stack limits are `items.<heal>.maxStack`. Extra items stay on the ground.

### 7.5 Pickups
- E picks up the nearest pickup within `player.pickupRange` (3D distance from the player's feet to the pickup). Pickups are instant. If you can only take part of a stack, the rest stays on the ground.
- On death, everything you carry drops (both weapons with their loaded ammo, all ammo pools, all heals, grenades, and (M2a) your worn
  vest and helmet with their remaining durability), scattered within `combat.deathDropScatter`.

### 7.6 Grenades (M2a, full rules in `systems/grenades.md`)
- Frag `grenade`, carry up to `items.grenade.maxCarry` (3). Key 4 or G equips. Hold LMB to pull the pin and cook (fuse `fuseMs` 3.5 s,
  the HUD shows the arc and a fuse ring), release to throw. Looking higher throws harder (`throwSpeedMin`..`throwSpeedMax`, about 1-33 m).
- It bounces off terrain and props and explodes when the fuse ends: `maxDamage` within `innerRadius`, falling to `minDamageFactor` at
  `radius` (6 m). It needs line of sight from the blast to your chest. Vests absorb it, helmets do not. It hurts the thrower too.
- If the fuse runs out in your hand, it explodes in your hand. Switching weapons while cooking drops it at your feet.
- It can kill an unarmored player within about 2.7 m and a vest_1 wearer within about 1.4 m, but never a full-HP player in vest_2 or
  better (`maxDamage` 140 since balance v9): it flushes campers out of cover.
  Live grenades near you show an on-screen warning and blink faster as they are about to explode.

### 7.7 Bigger arsenal (M2c)
- **Item levels L1-L4** (`systems/levels.md`) on every weapon except fists, and armor tiers 1-4 (`vest_4`, `helmet_4`, epic only). L1 = the
  numbers above. Guns: damage x1.08 / 1.16 / 1.25 and reload x0.95 / 0.90 / 0.85; melee: damage as guns and a faster swing. The pump,
  DMR, sniper and RPG have overrides (since the damage pass the sniper's L4 stays at the pre-pass 96 and L1-L3 sit between 88 and 93.3). Result: about 25-35% faster TTK at L4 on the same gun. Loot spot tier rolls the
  level (common spots never give L4). One colour + numeral/pips scale shared by every HUD element, the ground glow and the weapon models.
  Picking up a higher level of a gun you carry swaps that copy.
- **New guns**: revolver (heavy, 6 rounds, 3 body / 2 head) and double barrel (2 shells, 140 per barrel at point blank, useless past 8 m).
- **Melee** (`systems/melee.md`): knife, machete, paddle in slot 3 (replacing fists, never a gun slot). One hit check at the swing's hit frame
  (centre ray for headshots, plus a short sweep for body hits); the paddle knocks back. Melee and rockets **break office glass**; bullets and
  grenades still do not.
- **RPG** (`systems/rpg.md`): epic only, 3 rockets per spawn. A visible rocket (45 m/s, slight drop); impact 40 + frag-style blast 110 (5 m).
  A direct hit kills unarmored and vest_1 players and leaves a vest_2 player at 5 HP. Rockets that hit within 5 m are duds.
- **Smoke** (`systems/smoke.md`): a throwable sharing slot 4 with frags (4/G cycles). A 6.5 m cloud for about 22 s. It blocks sight (and bot
  sight), name tags and hit markers, but not bullets, blasts or the kill marker.
- **Scopes** (`systems/scopes.md`): red dot, 2x, 4x and 8x as loot. They mount on compatible guns (auto on pickup when better), travel with the
  gun, and there is one spare in a pouch; T switches. A scope changes zoom, ADS time, ADS cone and ADS move speed, never damage. Built-in sights
  (DMR 4x, sniper 8x) never get worse.

M2c TTK at L1 and L4, kill-share expectations and pacing: `systems/combat.md` "M2c". Expected items per match per map: `systems/loot.md` "M2c".

## 8. The tide (shrinking zone, MVP; full rules in `systems/zone.md`)
- It starts as a circle of radius `zone.startRadius` (125 m) centred on the origin, which covers the whole island (radius ~110). Each phase is: wait `waitSeconds` with the next circle shown,
  then shrink linearly (radius and centre) over `shrinkSeconds` to `radiusFraction * startRadius`.
- The next circle lies fully inside the current one and is centred on land. The final circle is biased to `MapData.zoneCenters`.
- Outside the circle you take the current phase's `dps` every `zone.damageTickMs`, ignoring armor.
- 6 phases end at radius 5 m at 7:30 (balance v9; 8:25 in v8, 8:00 before that). The middle phases are long and roomy and the late phases are short and tight (see the timeline in section 4). After `zone.finalCollapseDelaySeconds` the tide closes to 0 over `zone.finalCollapseSeconds` at `zone.finalCollapseDps`. This safety net guarantees the match ends.
- The tide is a translucent animated water wall at the circle edge. A warning plays `zone.warningSecondsBeforeShrink` before each shrink.

## 8b. Maps (M2b; full rules in `systems/maps.md`, layout in `levels/office.md`)
- Two maps with one rule set: `island01` (the tide) and `office` (the real office scaled x9: desks are 6.7 m plateaus, chibis run under them).
- **Map vote** in the lobby: Island / Office / Random. Most votes wins, ties are random, Random picks uniformly, and with no votes the maps
  rotate. Votes lock 3 s before the countdown ends so clients can load. The server env `MAP` pins a map; `?map=` pre-selects your vote.
- **Office differences** (per-map overrides, `maps.office` in balance.json after Phase B): zone theme `sprinklers` ("Sprinkler Flood":
  rain outside the circle, cosmetic water only), start radius 140 and radii 95/70/50/30/15/5 on the island's schedule, a drone drop at 25 m,
  `fallDamageMinSpeed` 18 so walking off a desk is free, shorter bot vision, more grenades and fewer snipers.
- Glass walls are solid (they block movement, bullets, grenades and bot sight) and only look transparent. Grenades bounce off all walls.
- Desk tops are reached by climb routes (steps <= 0.35 m walk or <= 0.95 m jump, at least 2 per desk block). Bots use a nav graph indoors
  and climb only for loot or hold positions.
- **M2c layout variety** (`systems/layout.md`): each match picks loot positions from candidate pools (fixed counts per POI and tier), POI and
  desk-zone arrangements with comparable cover, scattered decoration and a look/lighting preset, all from a shared seed. Walls, rooms, doors,
  glass and climb routes stay fixed. M2c also makes glass panes breakable by melee and rockets (`systems/melee.md`).

## 9. Kills, placement, winning (MVP)
- Placement = number of players alive just before you died (the winner gets 1). If several players die on the same tick, the one with more
  HP + vest durability + helmet durability at the start of that tick places better, then the one with more kills, then the lower entity id.
- Kill credit goes to whoever dealt the lethal hit (for a grenade: its thrower, even if the thrower has died). For zone, fall, disconnect or
  own-grenade deaths, credit goes to the last enemy who damaged the victim within `match.killCreditWindowSeconds`. Otherwise no one gets the kill.
- Win: last player alive. Results show placement, kills, and whether each player is a bot.

## 10. Bots (MVP, server-side, design level)
Goal (M1-fix, after playtests found bots far too aggressive): bots should feel like other castaways, not hunters. A human who lands and loots
should usually get 1-2 minutes before a real fight, and the field should thin out across the whole match, not in one burst at 3-4 minutes.

**Pacing model** (all keys in `bots`):
- **Loot phase.** For `lootPhaseSeconds` (90) x the personality's `lootPhaseMultiplier` after landing, a bot only fights an enemy within
  `lootPhaseEngageRange` (4 m) or one that damaged it in the last `retaliateMs`. It skips loot within `avoidRange` of a visible enemy and backs away.
  While dropping, bots spread out: they skip guns within `dropSpreadRange` of another bot's chosen landing gun.
- **Eagerness ramp.** After the loot phase, eagerness rises from 0 to 1 over `eagernessRampSeconds`, shaped by `eagernessCurve` (> 1 keeps the
  mid-game calm and the late game hot). The tide sets a floor: phase index / `eagernessFullAtPhase`. The engagement range is
  lerp(`lootPhaseEngageRange`, max(fire range, `minEngageRange`), eagerness) x `engageRangeMultiplier`, capped at `visionRange`. Avoidance fades as eagerness grows.
- **Fire range.** Bots fire only within lerp(falloffStart, falloffEnd, `fireRangeFalloffFraction`) of the held weapon. They keep a target until it
  is beyond engage range x `disengageRangeFactor`.
- **Spread over targets.** Each other bot already fighting a target lowers its score by `focusPenalty`, and each bot-target pair has a random bias
  of +/- `targetBiasSpread`, so 11 bots do not converge on one player (especially the human).
- **Personalities**, rolled per bot by `share`: `aggressive` (30%: shorter loot phase, longer reach, faster reactions, never retreats),
  `balanced` (40%), and `cautious` (30%: longer loot phase, shorter reach, retreats to heal below 60 HP). Fields: `engageRangeMultiplier`,
  `lootPhaseMultiplier`, `reactionMultiplier` (x `reactionMs`), `retreatBelowHp`.

**State priority** (decided every `bots.decisionIntervalMs`):
1. **Drop**: steer toward a loot spawn under the drop point, avoiding other bots' picks.
2. **Escape tide**: if outside the next circle (or the current one) and time is running out, head into it toward a point at
   `zoneEntryFraction` (minus up to `zoneEntrySpread`, per bot) of its radius from the centre, so bots spread along the edge instead of
   stacking in the middle. "Safe" means at least `zoneSafetyMargin` m inside the edge. This overrides looting.
2b. **Flee grenade (M2a)**: a visible live grenade within `bots.grenade.fleeRadius`: run directly away from it.
3. **Retreat**: below the personality's `retreatBelowHp`, carrying a heal and facing an enemy, break off for `retreatMs` and heal
   (behind cover when there is some, see "Tactics" below; cover for reloads and for fire it cannot answer sits at the same level).
4. **Engage**: a visible enemy (within `visionRange` and `fovDeg`, with line of sight) inside the current engagement range, or a recent attacker.
   A bot below `healBeforeFightBelowHp` that carries a heal does not start new fights. Gunfire within `hearingRange` turns the bot toward it.
   Wait `reactionMs` x personality, then fire bursts of `fireBurstMs` with `burstPauseMs` pauses at **chest height**, with error `aimErrorDeg`
   (`aimErrorDegMoving` if either party moves) that narrows to `aimSettleFactor` after `aimSettleMs`. Bots strafe every `strafeChangeMs` and drop the target after `loseTargetMs` without sight.
5. **Heal**: no enemy in sight and HP < `healBelowHp`.
6. **Loot**: the best-scoring pickup within `lootSearchRadius`. Scores are in `bots.ai` (`lootScore*`, divided by 1 + distance / `lootDistanceFalloff`).
7. **Hold**: inside the next circle with nothing to loot, drift between points within `holdWanderRadius`, pausing about `holdPauseMs`.
   Aggressive bots roam toward the centre once eagerness reaches `roamEagerness`.
- **Fists**: a fallback only. A bot with no usable gun fights back with fists and punches enemies already in fist range. It chases with fists only
  an enemy who is also unarmed, or when no wanted gun is in reach; otherwise it goes for a gun first. A bot never switches to fists while it has a loaded gun.
Bots never cheat on information (no wallhacks) and never aim at heads deliberately. Bot names come from narrative strings.

**M2a bot additions** (numbers in `bots.weaponPrefs`, `bots.ads`, `bots.stance`, `bots.grenade`, `bots.ai`, personalities):
- **Weapons by range**: in a fight at distance d, hold the usable gun whose `weaponPrefs` band contains d (sniper 35-120 m, DMR 25-80 m,
  rifle 8-45 m, LMG 8-40 m, SMG 0-18 m, shotgun 0-8 m, pistol 0-25 m); else the best expected DPS at d. Gun upgrades compare `lootValue`.
- **ADS**: always with scoped guns, and with other guns beyond `bots.ads.minRange`; aim error x `aimErrorMultiplier` while aiming. A bot
  carrying a usable scoped gun sees to `scopedVisionRange` (70 m) instead of `visionRange` (45 m).
- **Stance**: when engaged at >= `bots.stance.minRange` with a non-iron-sight gun, roll the personality's `stanceChance` at each strafe change
  to stop and crouch (or prone, `proneShare`) for `holdMs`. Cautious 35%, balanced 10%, aggressive never.
- **Grenades**: throw at an engaged target 8-30 m away who just broke line of sight (behind cover), per `bots.grenade`; aggressive bots
  throw more (`grenadeChanceMultiplier`). Bots flee visible grenades.
- **Armor**: bots pick up and wear better vests and helmets (`lootScoreVest` / `lootScoreHelmet` + `lootScoreArmorPerTier` x tier).
- Bots aim at the chest of the target's current stance.

**M2c bot additions** (numbers in `bots.melee/rpg/smoke/scopes`, `levels.botValueMultiplier`):
- **Levels**: loot value x 1 / 1.2 / 1.4 / 1.6 by level, so a bot swaps an L1 rifle for an L2 one.
- **Melee**: the melee weapon replaces the fists fallback; it is also used when the target is within 2.5 m and the held gun is empty.
- **RPG**: a special action like the grenade, at 12-50 m, against a visible target that is near cover, grouped or standing still. Never at
  point blank (needs 10 m of clear aim line).
- **Smoke**: thrown toward the attacker when retreating to heal, or when crossing into the zone after being hit (cautious bots most). All
  bot sight tests treat clouds as opaque.
- **Scopes**: picked up only to auto-mount; a mounted 2x/4x/8x stretches the gun's range band.
- Pacing: `bots.eagernessCurve` 1.5 -> 1.75 to keep the median at 6-7 min with slightly faster M2c fights (`systems/combat.md` "Pacing").

**Tactics** (numbers in `bots.tactics`, `personalities.*.investigateChance`; plumbing in `BOT_TACTICS_AI` in `src/shared/sim/bots.ts`).
Bots play smarter, not more accurately: aim error, reaction time, bursts and chest aim are unchanged, so the difficulty note still holds
(a scripted strafing, head-aiming human with the same gun wins about 80% of open or rock-strewn 1v1s, as before).
- **Cover**: a spot behind a collider (within `coverSearchRadius`, the `coverMaxCandidates` nearest, at least crouch-high and a player wide)
  that hides the bot from the threat's eye, standing or crouched. It prefers short walks that do not move toward the threat
  (`coverTowardThreatPenalty`). Bots take cover for three reasons:
  1. **Heal**: the Retreat trigger (state 3) runs to cover, crouches behind low cover, and heals once hidden. If no spot is found, the old
     run-away is the fallback, and the bot keeps looking on the way.
  2. **Reload**: a mid-fight reload with at least `coverReloadMinMs` left goes to cover the bot can reach before the reload ends, when it
     has no loaded second gun to swap to.
  3. **Under fire**: hit by an enemy it cannot answer (out of sight, or beyond its best fire range: a sniper vs an SMG), it breaks line of
     sight for `coverHoldMs` (then `coverCooldownMs`) instead of charging across open ground.
  A cover ends when its reason is over, after `coverMaxMs`, or when the threat can see the spot (it looks for another spot first). In cover
  the bot pre-aims where the threat was; when it leaves, it peeks back out toward that position.
- **Range plan**: against the gun in the enemy's hands, the bot compares damage share = its best DPS / (its DPS + the enemy's) at a few
  distances up to its fire range (and 3/4 of its sight). When another distance is better by `rangeAdvantageMargin`, it closes in or backs off
  to the nearest distance that gets most of that advantage: a rifle backs off a shotgun to about 15 m, a shotgun closes on a rifle, an SMG
  closes on a sniper. It never backs out of the tide circle. Mirror matches keep the weapon's preferred range (`weaponPrefs` band middle).
- **Reloads**: with the enemy in sight within `swapInsteadOfReloadRange`, an empty or reloading gun gives way to a loaded second gun. With
  the target out of sight, the bot reloads below `hiddenReloadFraction` of the mag. Between fights it tops up both guns.
- **Pressure**: a visible enemy who is reloading or healing (both visible animations) is pushed into the held gun's full-damage range. A
  target that breaks line of sight within `pushWindowMs` of the bot hitting it is chased at a sprint. Out of sight, the bot pre-aims the
  target's last known chest.
- **Evasion**: when hit while fighting, flip strafe direction with chance `hitJukeChance`.
- **Investigate**: gunfire within `hearingRange` (rolled once per `investigateMemoryMs`, at eagerness >= `investigateMinEagerness`, with the
  personality's `investigateChance`: aggressive 0.6, balanced 0.3, cautious 0) sends an armed bot with nothing to loot toward the shot. It
  stops at `investigateStandoffFraction` x its best fire range, and only if the shot is inside the safe circle (third-partying).
- Information rule: bots use only what a player could know: the enemy's held weapon and reload/heal animations, their own hit markers,
  damage direction and heard shots.
- Cost: at most `BOT_TACTICS_AI.coverSearchesPerTick` (2) cover searches per tick across all bots and one per bot per
  `coverSearchCooldownMs`, each at most 2 sight rays per candidate. The range plan is closed-form DPS math once per decision.

## 11. Feedback requirements (summary for UI, audio, VFX)
- **Shots**: muzzle flash, tracer from muzzle toward the hit point, positional shot sound per weapon type.
- **Hits dealt**: hit marker (white for body, yellow for head, red X for a kill), hit sound (separate head ping), vest-hit and helmet-hit
  variants, plus an armor-break cue (separate for vest and helmet) when a piece reaches 0.
- **Hits taken**: red damage-direction arc and a brief screen-edge vignette. Separate vest-hit, helmet-hit and HP-hit sounds.
- **M2b**: first-person viewmodel (arms, per-weapon visual recoil, reload/heal/throw/punch animations), parachute canopy overhead.
- **M2a**: ADS camera zoom and scope overlay, scope glint on remote scoped players, stance icon and stance animations, vest and helmet tier
  icons with durability on the HUD and tier visuals on every chibi, grenade arc preview, fuse ring, live-grenade danger indicator, blinking
  grenade light, explosion puff and camera shake, grenade icon in the kill feed.
- **Tide**: a phase timer ("Tide rising in 0:23" / "Tide moving 0:12"), minimap rings (current and next), a warning sting, a blue screen tint plus a damage tick sound while outside.
- **Heals**: a channel progress bar with a cancel hint. **Reload**: progress on the ammo counter.
- Kill feed (killer, weapon icon, victim; headshot icon), alive count, your kills, and a pickup prompt that names the item and quantity.
- **M2c**: level colour + numeral/pips on slots, ground glow, prompts, kill feed, armor icons and weapon models; melee wind-ups readable at
  15 m and swing whooshes; glass shatter; rocket launch, whistle, smoke trail and explosion; smoke cloud volume and hiss; the throwable slot
  showing the selected type and both counts; scope chips on slots, the pouch chip, the 2x overlay; the layout seed in the Esc panel and on
  results.

## 12. Out of scope
Delivered in M2a: crouch/prone, ADS with sights and scopes, helmets and armor tiers, frag grenades, DMR, sniper, LMG.
Out of scope for M2a: attachments (scopes as separate pickups), smoke and flash grenades, vehicles, lean (Q/E), first-person mode outside
scopes, lag compensation.
Delivered in M2b: plane/drone carrier drop, the office map, map vote, rooms, first-person camera (no 3P toggle on foot).
M2c (in design): per-match layout variety, item levels, revolver, double barrel, melee weapons, RPG, smoke, scope attachments, tier-4 armor,
breakable glass (melee and rockets only). Out of scope for M2c: destructible walls and terrain, vehicles, attachments other than scopes,
weapon skins, airdrops, new maps, lag compensation, incendiary and flash grenades, procedural terrain shape, bots spraying into smoke or
using smoke offensively (Later), pre-scoped loot guns (Maybe), a melee block/shove (Maybe), bot nav through broken glass (Later).
Later: vehicles, crafting, building, hunger/thirst, backpacks, squads, accounts, multiple lobbies and matchmaking,
mobile/touch controls, gamepad, binary protocol, lag compensation (hits are checked against the server's current state; the design assumes
it will be added later), weapon drop key, scoreboard, spectator free-cam, cosmetics selection, a cosmetic local grenade on release.
Maybe: swimming in deep water, attachments other than scopes, revive, same-tier armor swap when the ground piece is fresher, a prone
turn-rate limit, water muffling grenade damage.

## 13. M2c acceptance summary (detail and exact tests in each system spec)
1. Two matches with different layout seeds on the same map differ in loot positions and arrangements; the same seed gives the same layout on
   server and every client; per-POI loot counts and the hard guarantees hold over 200+ seeds per map (`systems/layout.md`).
2. Every weapon except fists carries a level 1-4 through pickup, drop and death; L1 stats equal today's; the L1/L4 TTK table in
   `systems/combat.md` holds shot for shot (`systems/levels.md`).
3. Knife, machete and paddle live in slot 3, hit once at their hit frame, and the paddle knocks back; melee and rockets break office glass
   (`systems/melee.md`).
4. The RPG fires a deterministic rocket that explodes on contact or at 120 m with the frag blast model and the impact bonus; duds under 5 m
   (`systems/rpg.md`).
5. Smoke shares the throwable slot (4/G cycles), deploys a cloud whose radius is a pure function of time, and blocks bot sight, name tags
   and hit markers, but not bullets (`systems/smoke.md`, `systems/grenades.md`).
6. Scopes mount by the auto-mount rule, travel with their gun, and switch with T; default sights are unchanged (`systems/scopes.md`).
7. `matchReport.ts` (30 matches per map): median match 300-480 s (target 320-400 s since balance v9), no weapon above 35% of weapon kills.
