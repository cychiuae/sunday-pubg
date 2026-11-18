# Beach Survival PvP: Game Design Document (M1 "First Playable")

Owner: game-designer. Every number lives in `docs/design/balance.json`; this doc names keys as `section.key`.
Units: metres, m/s, degrees. Times are in ms unless the key ends in `Seconds`. Y is up, sea level is y = 0.
Detail specs: `systems/combat.md` (combat, inventory, heals), `systems/zone.md` (the tide), `systems/loot.md` (loot).

Scope tags: **MVP** = in M1. **Later** = planned after M1. **Maybe** = only if playtests ask for it.

## 1. Pitch
Twelve cute chibi castaways wash up on a bright tropical island. They grab whatever is lying on the sand,
the tide rises and squeezes everyone together, and the last one standing wins. The game looks like a holiday
postcard and plays like a tense duel. Matches take 6 to 9 minutes in a browser tab, and you are holding a gun within 30 seconds.

## 2. Pillars
1. **Cute outside, tense inside.** Toon-shaded chibis, beach umbrellas and tiki torches. The stakes are still real:
   one life, and every fight could be your last. The contrast is the point, so keep the art soft and the rules sharp.
2. **Readable fights.** Every shot has a tracer, a muzzle flash and a positional sound. Every hit shows a hit
   marker, and every hit you take shows where it came from. You lose because you were outplayed, not because you were confused.
3. **Fast to fun.** Spawn, drop, loot and fight in under 30 seconds. There is no plane and no menus mid-match.
4. **Always a decision.** Loot now or rotate? Heal now or push? Keep the shotgun or swap it for a rifle? Mechanics without a decision are cut.

## 3. Core loop
**Drop -> Loot -> Rotate with the tide -> Fight -> Win (or spectate -> results -> next match).**

| Beat | Time | Player decision |
|---|---|---|
| Drop | ~4 s | Where to land: a busy rare/epic POI or a quiet beach |
| Loot | 0:00-1:30 | What to keep (2 weapon slots), when to leave. Bots mostly loot here too (section 10) |
| Rotate | each phase | Which path into the next circle: open beach (fast, exposed) or treeline (slow, cover) |
| Mid-game | 1:30-5:20 | Roomy circles (65 m, then 47.5 m). Pick your fights, third-party others, or hold and heal |
| Fight | anytime | Engage, disengage, or heal behind cover |
| Endgame | ~6:00+ | The circle drops to 27.5 m, then 14 m, then 5 m. Hold position or force the last fights |

## 4. Session flow (MVP)
1. **Title**: enter a name (1-16 chars) and press Join. You join the single lobby.
2. **Lobby**: shows the player count and countdown. The countdown (`match.countdownSeconds`) starts when at least
   `match.minHumansToStart` humans are waiting. Humans who join during the countdown are added (up to `match.maxPlayers`).
   At zero, the server adds bots until the match has `match.targetPlayers` players. If there are more humans than that, no bots are added.
   Someone who joins while a match is running waits in the lobby for the next match.
3. **Drop**: each player is assigned a shuffled `MapData.playerSpawns` point and starts `match.dropHeight` m above the terrain.
   If there are more players than spawn points, points are reused with a random offset of up to `match.spawnJitter`.
   While dropping, a player falls at a constant `movement.dropFallSpeed` and steers horizontally at up to `movement.dropSteerSpeed`.
   They cannot fire, pick up items or heal. Landing never deals fall damage. Zone phase 1 starts its timer at match start.
4. **Match**: no respawns. On death the player gets a death screen for `match.deathScreenSeconds`
   (killer, weapon, your placement and kills), then spectates. Spectate follows the killer if they are alive, otherwise any alive
   player (humans first). Click or Space cycles through targets.
5. **End**: the match ends when one player is alive. The winner sees "Winner" and everyone else sees the results screen
   (placement, name, kills, bot tag) for `match.resultsSeconds`. Then everyone returns to the lobby, and the countdown restarts
   immediately if enough humans remain.
6. **All humans dead** (`match.endWhenNoHumansAlive`): `match.lastHumanDeathDelaySeconds` after the last human dies, the match
   resolves. Remaining bots are ranked by current HP + armor, then kills, then entity id. The top bot wins. Nobody waits minutes for a bot-only match.
7. **Disconnect mid-match**: the player is eliminated on the spot (counted as "left"). Their loot drops. Kill credit follows the rule in section 8.

Expected length: the tide schedule ends at 8:00 (480 s), and the final collapse guarantees an end by 8:40 (520 s). Target: median 6-7 min,
nearly all matches between 5:30 and 8:40. Timeline (detail in `systems/zone.md`):

| Time | Tide | Bots |
|---|---|---|
| 0:00-1:15 | Phase 1 wait, circle 125 m (whole island) | Loot phase: fight only at point blank or when shot |
| 1:15-2:00 | Shrink to 87.5 m | Loot phase ends at about 1:15-2:00 (depends on personality) |
| 2:00-3:45 | Phase 2: wait, then shrink to 65 m | Eagerness ramping; mostly local fights |
| 3:45-5:20 | Phase 3: wait, then shrink to 47.5 m | Mid-range fights, third parties |
| 5:20-6:30 | Phase 4: wait, then shrink to 27.5 m | Full eagerness at about 6:30 |
| 6:30-8:00 | Phases 5-6: 13.75 m, then 5 m | Everyone in range |
| 8:00-8:40 | Final hold 20 s, collapse to 0 | Match always ends |

## 5. Controls (mouse + keyboard, MVP)
| Input | Action |
|---|---|
| Mouse (pointer lock) | Look / aim (sensitivity setting) |
| W A S D | Move |
| Shift (hold) | Sprint. Works only while moving forward and not firing, healing or dropping |
| Space | Jump |
| LMB | Fire. Hold for automatic weapons; semi-auto fires once per click |
| R | Reload. Firing an empty magazine also auto-reloads if you have reserve ammo |
| E | Pick up the nearest pickup within `player.pickupRange` |
| 1 / 2 / 3 | Weapon slot 1 / slot 2 / fists. Mouse wheel cycles |
| Q | Use the best heal (see 7.4). Press again to cancel |
| Esc | Release the pointer and open settings (sensitivity, volume) |

Later: G to drop the held weapon, Tab for the scoreboard, M for the full map, crouch. Touch (Later): twin virtual sticks, a fire button on
the right stick, and context buttons for E/Q/R. Gamepad (Maybe): left stick move, L3 sprint, right stick aim, RT fire, X reload/pick up, Y swap,
LB heal. Gamepad aim needs aim slowdown near targets.

**Camera**: third-person over the right shoulder. The authoritative shot ray starts at the player's eye
(`player.eyeHeight` above the feet) along the aim yaw/pitch. The client draws the crosshair where that ray's
first hit (or the point 50 m along it) lands on screen. You never hit something your crosshair is not on, and you cannot
shoot around a corner your character cannot see past.

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

## 7. Combat and inventory (MVP; full rules in `systems/combat.md`)
### 7.1 Hitscan
- Server-authoritative and instant. Shots are blocked by terrain and prop colliders. Water does not block shots.
- Hitbox: a vertical cylinder with radius `player.radius` and height `player.height`. The **head** is the top `player.headZoneFraction`
  (40%, because chibis have big heads). Headshot damage = damage * `headshotMultiplier`.
- Damage falloff: full damage up to `falloffStart`, then a linear drop to `minDamageFactor` at `falloffEnd`, flat after that. Shots never hit beyond `range`.
- Spread: each pellet deviates randomly inside a cone with half-angle `spreadDeg`. The cone is multiplied by `moveSpreadMultiplier`
  when horizontal speed > `combat.moveSpreadSpeedThreshold`, and by `combat.airSpreadMultiplier` when airborne (both can apply).
  The crosshair grows with the current cone.
- Fire modes: `automatic: true` fires every `fireIntervalMs` while LMB is held. Otherwise one shot per click, at most once per `fireIntervalMs`.
  Fists are melee hitscan with `range` 2 m.

### 7.2 Armor
- One armor type: `vest`. Picking one up sets armor to `items.vest.armor`, capped at `player.maxArmor`. Vests are applied on pickup, never carried.
  You cannot pick up a vest while your armor is full.
- Each weapon hit: `armorTaken = min(armor, dmg * armor.absorbFraction)` and `hpTaken = dmg - armorTaken`. This applies to head and body hits.
  A full vest adds 50 effective HP (150 total). Zone and fall damage ignore armor.

### 7.3 Weapons and reloads
- 2 weapon slots plus fists (always slot 3, cannot be dropped). Picking up a weapon fills the first empty slot. If both slots are full, it
  replaces the **held** weapon (slot 1 if you are holding fists). The replaced weapon drops at your feet with its loaded ammo.
  If you were holding fists, the new weapon is equipped automatically.
- Ammo is shared per type (`ammo_light`, `ammo_heavy`, `ammo_shell`) up to `items.<ammo>.maxCarry`. Reloading (`reloadMs`) moves
  rounds from the pool into the magazine when it finishes. Switching weapons cancels a reload. You cannot fire while reloading.
- Switching weapons takes `combat.swapMs`, during which you cannot fire.
- Holding LMB cancels sprint. Sprint resumes when you release LMB.

| Weapon | Role | TTK body, no armor | TTK body, full vest |
|---|---|---|---|
| Fists | Desperation | 7 hits / 2.7 s | 10 hits / 4.1 s |
| Pistol (semi) | Early sidearm | 5 / 1.0 s | 8 / 1.75 s |
| SMG (auto) | Close-mid, sprays wide | 8 / 0.56 s | 11 / 0.8 s |
| Shotgun (pump) | Point-blank burst, 99 max | 2 shots / 0.9 s | 2 / 0.9 s |
| Rifle (auto) | Mid-long, punishes moving | 5 / 0.6 s | 7 / 0.9 s |

Counterplay: the SMG falls off past 12 m and the rifle is inaccurate on the move. The shotgun is useless past ~15 m. Every shot has a tracer, so the target always knows where fire is coming from.

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
- On death, everything you carry drops (both weapons with their loaded ammo, all ammo pools, all heals; not armor), scattered within `combat.deathDropScatter`.

## 8. The tide (shrinking zone, MVP; full rules in `systems/zone.md`)
- It starts as a circle of radius `zone.startRadius` (125 m) centred on the origin, which covers the whole island (radius ~110). Each phase is: wait `waitSeconds` with the next circle shown,
  then shrink linearly (radius and centre) over `shrinkSeconds` to `radiusFraction * startRadius`.
- The next circle lies fully inside the current one and is centred on land. The final circle is biased to `MapData.zoneCenters`.
- Outside the circle you take the current phase's `dps` every `zone.damageTickMs`, ignoring armor.
- 6 phases end at radius 5 m at 8:00. The middle phases are long and roomy and the late phases are short and tight (see the timeline in section 4). After `zone.finalCollapseDelaySeconds` the tide closes to 0 over `zone.finalCollapseSeconds` at `zone.finalCollapseDps`. This safety net guarantees the match ends.
- The tide is a translucent animated water wall at the circle edge. A warning plays `zone.warningSecondsBeforeShrink` before each shrink.

## 9. Kills, placement, winning (MVP)
- Placement = number of players alive just before you died (the winner gets 1). If several players die on the same tick, the one with more HP + armor
  at the start of that tick places better, then the one with more kills, then the lower entity id.
- Kill credit goes to whoever dealt the lethal hit. For zone, fall or disconnect deaths, credit goes to the last enemy who damaged the victim within
  `match.killCreditWindowSeconds`. Otherwise no one gets the kill.
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
3. **Retreat**: below the personality's `retreatBelowHp`, carrying a heal and facing an enemy, break off for `retreatMs` and heal.
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

## 11. Feedback requirements (summary for UI, audio, VFX)
- **Shots**: muzzle flash, tracer from muzzle toward the hit point, positional shot sound per weapon type.
- **Hits dealt**: hit marker (white for body, yellow for head, red X for a kill), hit sound (separate head ping), plus an armor-break cue when the target's armor reaches 0.
- **Hits taken**: red damage-direction arc and a brief screen-edge vignette. A separate armor-hit sound vs an HP-hit sound.
- **Tide**: a phase timer ("Tide rising in 0:23" / "Tide moving 0:12"), minimap rings (current and next), a warning sting, a blue screen tint plus a damage tick sound while outside.
- **Heals**: a channel progress bar with a cancel hint. **Reload**: progress on the ammo counter.
- Kill feed (killer, weapon icon, victim; headshot icon), alive count, your kills, and a pickup prompt that names the item and quantity.

## 12. Out of scope for M1
Later: plane drop, vehicles, crafting, building, hunger/thirst, crouch/prone, scopes/ADS, helmets/backpacks, squads, accounts, multiple lobbies
and matchmaking, mobile/touch controls, gamepad, binary protocol, lag compensation (M1 checks hits against the server's current state; the design assumes
it will be added later), weapon drop key, scoreboard, spectator free-cam, cosmetics selection.
Maybe: grenades/coconuts, swimming in deep water, weapon attachments, revive.
