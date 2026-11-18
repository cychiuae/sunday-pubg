# Audio: Last One Dry (M1 + M2a "Arsenal & Stance" + M2b "Office, Drop & Rooms")

Owner: audio-designer. Code: [`src/audio/`](../../src/audio/). Cue numbers (priority, limits, ranges, gains) live in
[`src/audio/cues.ts`](../../src/audio/cues.ts) and are the source of truth if they differ from the tables below.

M2c ("Fresh Every Match & Bigger Arsenal": melee, dbshotgun, revolver, RPG, smoke, item levels, look presets) is
specified in [M2c.md](M2c.md) and will be folded into this document once it is built.

**M1, M2a and M2b ship no audio files.** Every sound is synthesised at runtime with the Web Audio API: oscillators,
filtered noise buffers, envelopes, LFOs and (M2b) a generated reverb impulse. There is nothing to license, and
`public/assets/audio/` stays empty.

---

## 1. Sonic identity

The tone is a holiday postcard with a tense duel inside it, so the audio is toy-like on the surface and very
readable underneath.

- **Weapons are toys, not firearms.** Pops, squirts, thwumps and cracks, with no realistic gunfire and no gore.
  Each weapon still owns its own frequency band and rhythm, so you can identify it with your eyes closed:

  | Weapon (in-world) | Character | Band | Rhythm cue |
  |---|---|---|---|
  | Fists | cartoon whoosh, thwack on hit | low-mid noise sweep | slow (450 ms) |
  | Conch Pistol | cork **pop** with a woody body | mid (1.1 kHz to 160 Hz drop) | single taps |
  | Spritzer SMG | bright **tsk** squirt | high (4 to 2 kHz spray) | fast stream (80 ms) |
  | Scatter Clam (shotgun) | deep **thwump** plus clam-shell clack, then an audible **pump** | sub/low | boom ... chk-chk (the pump tells enemies the gap) |
  | Coral Rifle | sharp **crack** over a solid thump, short tail | full range | steady (150 ms) |
  | LMG (M2a) | chunky crack a little lower than the rifle, with a receiver **chug** | low-mid (520 Hz to 100 Hz saw, 100 Hz thump) | rolling stream (120 ms) |
  | DMR (M2a) | punchy, snappy **crack** (higher and sharper than the rifle), short tail | full range, bright top | measured taps (400 ms) |
  | Sniper (M2a) | the biggest **crack**, a deep body, a 1 s tail and three low-passed **echoes across the bay** (0.38 / 0.74 / 1.15 s) | full range, loudest; heard to 260 m | boom ... then a **bolt cycle** whose lock click lands exactly `weapons.sniper.fireIntervalMs` after the shot, so enemies can count the gap |

- **Feedback is crisp and dry.** Hit confirms are short 2D blips: a tick-thup for body, a bell **ping** for head, a
  bubble **pop-ding** for a knockout. Armor (M2a) has its own voice per piece: a fabric-and-plate **clink** for a vest,
  a hollow coconut-shell **tonk** with a short ring for a helmet (both rise in pitch with tier 1 to 3), and a separate
  break per piece (vest: low plate shatter plus a fabric rip; helmet: a sharp crack, falling clang and tumbling bits).
  Damage you take is a felt low thump, not a sharp sound.
- **The island is warm.** Slow brown-noise swells, a foam hiss that trails each crest, light wind, and the odd
  synthesised gull. The ambience sits under gameplay and ducks out of the way when you get hit.
- **The office is a giant's workplace at toy scale (M2b).** An air-handling rumble with a slow breath, a faint mains
  hum, a fluorescent buzz with a flicker, bursts of distant typing somewhere across the floor, and a big, slightly dark
  room reverb on every gameplay sound, so gunfire indoors rings off the walls and the beach suddenly feels far away.
- **The drop is a ride (M2b).** The carrier drones overhead (a seaplane's chopped prop roar on the island, a toy
  delivery drone's four-rotor whine in the office). Aboard, the world goes muffled behind the cabin wall and the open
  hatch roars; the jump throws the door open, the wind rises with your fall speed, the canopy pops and flutters, and the
  landing folds it down with a soft rustle.
- **Musical stings are cheeky.** A steel-drum arpeggio for victory, a gentle sad-trombone "wah wah wah waaah" when
  you are washed out (never a death sound), ukulele strums for results, and a conch horn plus lifeguard whistle for
  the tide.

## 2. Mix buses

```
voice (gain: cue gain x jitter x distance) -> [air low-pass] -> [Panner] -> bus
bus: sfx (0.9) / ambience (0.5) -> duck gain -> world muffle low-pass -> cabin low-pass -> master
bus: ui (0.7)                    -> duck gain ---------------------------------------------> master
drop bus (0.9: cabin engine, door wind, freefall wind, flutter) ----------------------------> master
indoor only: sfx bus level -> reverb send (0.22) -> convolver (2.4 s) -> sfx duck gain
master (settings volume^2) -> limiter -> destination
```

- **cabin** (M2b): a second low-pass after the muffle, idle at 20 kHz. While the local player is aboard it closes to
  700 Hz (τ 0.4 s) and the ambience ducks -8 dB, so the world sounds like it is outside a wall; the jump opens it fast
  (τ 80 ms). The drop bus bypasses it, so the cabin engine and the hatch stay clear.
- **reverb** (M2b): only on indoor maps. The sfx bus feeds a send into a ConvolverNode whose impulse is generated
  (`noise.fillReverbIr`: exponentially decaying stereo noise, -60 dB at 2.4 s, 20 ms pre-delay, darkening over time,
  unit energy). The return joins the sfx duck, so ducks and muffles apply to the tail too. On the island the send and
  convolver are disconnected (a convolver costs CPU even when silent).

- **world muffle** (M2a): one low-pass shared by sfx and ambience, idle at 20 kHz. A grenade blast inside the
  blast radius sweeps it down (1.8 kHz at the radius edge to 450 Hz point blank, 100 ms after the bang so the bang
  stays punchy), holds 0.6 to 2 s by closeness, then recovers (τ 0.5 s). The ear ring plays on the ui bus, so it is
  the one clear sound while the world is muffled.

- **sfx**: all gameplay sounds, local and remote.
- **ui**: menus, countdown, match start, victory, defeat, results, prompts.
- **ambience**: sea, wind, gulls, tide whoosh and tide loop.
- **music** is reserved for M2 (§10). It will sit between `ui` and `ambience` and duck under `sfx`.
- **master** = `masterVolume^2`. The squared curve gives a roughly perceptual slider, and it is smoothed with
  `setTargetAtTime` so dragging the slider never clicks.
- **limiter**: a DynamicsCompressor (-6 dB threshold, 12:1, 3 ms attack) that catches shotgun plus kill-confirm
  pile-ups.

## 3. Priorities and voice limits

- **Global cap:** 48 pooled voices. The ambience beds (about 5 sources) sit outside the pool.
- **Stealing** (`VoicePool`):
  1. At a cue's `maxInstances`, the engine steals the lowest-priority, then oldest, instance of that same cue. If every
     instance outranks the new sound, the new sound is dropped instead.
  2. When the pool is full, the engine steals the lowest-priority, then oldest, voice overall. If nothing ranks at or
     below the new sound, the new sound is dropped.
  3. Stolen voices fade out over 20 ms (no clicks) and disconnect 50 ms later.
- **Effective priority** = base + 0..5 for closeness (2D sounds get +5). Base classes are 10 points apart, so
  distance reorders sounds within a class but never across classes.

| Class | Base | Cues |
|---|---|---|
| Must-hear feedback | 88 to 99 | **explosion (99)**, ear ring (97), hit confirms (vest/helmet/break 92 to 95), damage taken (vest/helmet/break 96 to 97), zone hurt tick, zone warning, heartbeat, victory/defeat, countdown |
| Own weapon | 70 to 82 | local shots (sniper 82), dry fire, surf enter, refusal `ui.nope` (72, 1 instance, 250 ms cooldown so mashing E/Q/R stays gentle), cook fuse tick (70) |
| Remote threats | 55 to 78 | **grenade bounce (78)**, **nearby fuse tick (77, M2b)**, pin pull (76), drop jump (66), chute pop (64), drop land (60), remote shots (70, sniper 74), remote eliminations (75), throw whoosh (68), **remote footsteps (65)**, crouch steps (64), crawl (63), bolt cycle (62), stance rustle (57), remote jumps and landings, reloads, remote hits |
| Items and own movement | 44 to 62 | pickups (vest/helmet 60, grenade 58), heals, weapon switch (3 instances, local 2D or remote 3D), ADS in/out (48 to 50), local footsteps and crawl |
| World detail | 38 to 41 | bullet impacts (glass 41) |
| Decoration | 10 to 35 | gulls, office typing, hover, prompt tick |

The persistent beds (ambience scenes and the M2b drop layers) are outside the pool.

Per-cue limits (examples): SMG remote 6, LMG remote 6, rifle remote 5, sniper remote 3, explosion 3, grenade bounce 4,
bolt 3, stance rustle 4, crouch/crawl remote 6, cook tick 1, remote footsteps 8, impacts 5 to 6, local footsteps 2, most
UI cues 1. Cooldowns drop rapid duplicates, for example impacts within 20 ms, label-plus-input double clicks within
30 ms, and zone ticks within 200 ms.

**Variation:** every play gets a random pitch offset (up to ±2 semitones for impacts, ±0.6 for local shots) and a
gain offset (up to ±2 dB). Noise layers start at random buffer offsets, so even identical parameters never repeat
sample-for-sample.

## 4. Sound list (GameEvents to cues)

"2D" means the sound has no panner (it is local or UI). "3D" means it plays at the given position. Local and remote
variants of the same action are separate cues, so they can have different priority and character.

| GameEvent | Condition | Cue(s) | Space |
|---|---|---|---|
| `shotFired` | `isLocal` | `shot.<weapon>.local` | 2D |
| | remote | `shot.<weapon>.remote` at `origin` | 3D, 25 m (fists), 130 to 140 m (pistol, smg, shotgun), 180 m (rifle, lmg), 200 m (dmr), 260 m (sniper) |
| | weapon `sniper` | `weapon.bolt` keyed `bolt:<shooter>`, `durationS = weapons.sniper.fireIntervalMs / 1000`: bolt opens at 30 %, brass tinkle, lock click at the end. Stopped by a sniper `reloadStarted`, any `weaponSwitched` and death of the shooter | 2D / 3D 30 m |
| | each impact (≤1 per surface, ≤2 per shot) | `impact.ground` / `impact.prop` / `impact.water` / `impact.glass` (M2b: dull thunk + short glassy ring) at `point` | 3D, 30 to 40 m |
| `dryFire` | | `weapon.dryFire` (variant weapon) | 2D |
| `playerDamaged` | local victim, weapon or explosion | one cue per armor piece in the event: `damage.vest` / `damage.helmet` (variant `vest1..3` / `helmet1..3`) or `damage.vestBreak` / `damage.helmetBreak`; no piece: `damage.hp` (variant head/body). Duck ambience | 2D |
| | local victim, zone | `zone.hurtTick` + light duck | 2D |
| | local victim, fall | `damage.fall` + duck | 2D |
| | local attacker | nothing (voiced by `localHitConfirmed`) | |
| | remote-on-remote weapon hit, or an explosion that broke a piece | `hit.remote` at `victimPos`, variant (break > armor > head > body): `helmetBreak`, `vestBreak`, `helmet1..3`, `vest1..3`, `head`, `body` | 3D, 45 m |
| `localHitConfirmed` | killed | `hitConfirm.kill` (+ `hitConfirm.head` if headshot) | 2D |
| | armor in the event | per piece: `hitConfirm.helmet` / `hitConfirm.vest` (variant tier) or `hitConfirm.helmetBreak` / `hitConfirm.vestBreak` (shotgun can play both) | 2D |
| | no armor | `hitConfirm.head` / `hitConfirm.body` (explosion hits included) | 2D |
| `playerKilled` | local victim | `ui.defeat` + duck; stops own heal/reload/drop loops and heartbeat | 2D |
| | anyone else | `death.remote` (bonk + splash; variant `head` adds a coconut "tok" when `headshot`) at `victimPos` | 3D, 70 m |
| `itemPickedUp` | | `pickup.weapon` / `.ammo` / `.heal` / `.vest` (velcro rip, lower for higher tiers) / `.helmet` (strap buckle + shell tap, pitched by tier) / `.grenade` (metal clink), variant item | 2D local, 3D remote (12 to 15 m) |
| `reloadStarted` | | `reload.start`, keyed `reload:<id>`, spread over `durationMs`: shotgun one shell per ~0.55 s; **lmg** cover up, belt rattle, box in at 50 %, belt laid at 65 %; **sniper** bolt open then five rounds thumbed in; others a mag-out pitched by weapon | 2D / 3D 18 m |
| `reloadFinished` | completed | stop key + `reload.finish` (shotgun: pump; lmg: cover slam + charge; sniper: bolt forward + lock) | 2D / 3D 18 m |
| | cancelled | stop key (scheduled shells never play) | |
| `healStarted` | | `heal.start` (bandage tear / medkit zip) + `heal.loop` keyed `heal:<id>` | 2D / 3D 14 to 18 m |
| `healFinished` | | stop loop + `heal.finish` chime | 2D / 3D 14 m |
| `healCancelled` | | stop loop; local: `heal.cancel` down-blip | 2D |
| `weaponSwitched` | local | `weapon.switch` (fists: swish + knuckles; grenade: pouch rustle + spoon rattle; guns: click-clack by weapon) | 2D |
| | remote with `pos` | `weapon.switch` at `pos` (silent while `pos` is absent) | 3D, 15 m |
| `actionFailed` | local, action ≠ `fire` | `ui.nope`: two soft falling wooden bloops, variant = reason (`noAmmo` lower and drier). `fire` is ignored (`dryFire` covers it) | 2D (ui bus) |
| `zoneChanged` | shrinking starts, theme `tide` | `zone.tideRising` whoosh + `zone.tideLoop` keyed `zone` | 2D (ambience bus) |
| | shrinking starts, theme `sprinklers` (M2b) | `zone.sprinklerStart` (pipe knock, gurgle, pressure hiss swelling to rain) + `zone.sprinklerLoop` keyed `zone` (distant rain hiss); the first shrink also turns on the indoor rain bed (`zoneBed`) | 2D (ambience bus) |
| | shrinking starts, theme `lightsOut` (M2b, data-switchable) | `zone.lights` variant `down` (relay clunk, tubes winding down); no loop | 2D |
| | shrinking ends | stop `zone` | |
| `zoneWarning` | | `zone.warning` + duck ambience. Variant = theme: island conch horn; indoors a two-tone PA chime. Then 2 whistles (3 from phase 3) | 2D |
| `localZoneStatusChanged` | outside | tide: `zone.enterSurf` splash + surf roar on. Sprinklers: `zone.enterSpray` (spray burst + fat drops) + close spray bed on. Lights out: `zone.lights` `enter` + the fluorescent buzz cuts | 2D |
| | inside | `zone.exitSurf` / `zone.exitSpray` (drip-off) / `zone.lights` `exit` (tube flicker), bed off | 2D |
| `footstep` | standing | `foot.local` / `foot.remote` (variant surface: sand crunch, grass swish, water splash; M2b floors: **wood** hollow knock, **carpet** soft muffled pad, **tile** hard heel click with a short ring; sprint = louder and shorter). Stance = `footstep.stance`, else the last `stanceChanged` | 2D / 3D 30 m |
| | crouched | local: `foot.local` at gain 0.6, intensity 0.2; remote: `foot.crouch.remote` (gain 0.45) | 2D / 3D 18 m |
| | prone | `foot.crawl.local` / `foot.crawl.remote`: slow drag (sand drag, grass swish, water slosh; wood scrape, carpet rub, tile slide with a rubber squeak) | 2D / 3D 12 m |
| `stanceChanged` | | `stance.change`, variant `<from>_<to>`, `durationS = durationMs / 1000`: cloth rustle and gear jingle at the start (falling for down, rising for up); a body thud plus elbow pats at `durationS` when `to = prone`, a light knee/foot plant otherwise; `forced` (water stand-up) adds a splash. Stance is remembered per player for footsteps | 2D / 3D 15 m |
| `localAdsChanged` | engaged | `ads.in` (variant sight): shoulder rustle and stock tap; `red_dot` adds a tiny emitter tick; `scope_4x` / `scope_8x` add a lens "zoom" sweep (longer for 8x) and a ring click | 2D |
| | released | `ads.out`: falling rustle (scopes add a short down sweep) | 2D |
| `grenadeCooked` | local | `grenade.pin` (pin scrape, pop, spoon **ping**) + `grenade.tick` keyed `cook`, length `items.grenade.fuseMs` + 0.3 s: quiet ticks that speed up toward the end | 2D |
| | remote | `grenade.pin` at `pos` | 3D, ~10 m (12 m cull) |
| `grenadeThrown` | | local: stop `cook`. Unless `dropped`: `grenade.throw` whoosh | 2D / 3D 25 m |
| `grenadeBounced` | | `grenade.bounce`, variant surface (`terrain` sand thud + casing tink, `prop`/`edge` metal clink, `water` plop, M2b `glass` bright glassy clink and ring), intensity = speed / 12 m/s. Remembers the last contact per grenade | 3D, 30 m |
| `IAudio.setGrenades` (M2b) | each live grenade within 8 m | `grenade.fuseTick` at its position, intensity = urgency; spacing 0.55 s with a full fuse down to 0.11 s at the end (`items.grenade.fuseMs` from the per-map balance; without it, relative to the fuse left when first seen) | 3D, 10 m |
| `explosion` | | `explosion`, variant `water` when the grenade's last contact was water or `pos.y < 0` (sea level), else `ground`. Delayed by `distance / 343 m/s` (max 0.45 s) so the flash comes first; far away it loses its crack and gains a rolling echo; close it rains sand. Local owner `inHand`: stop `cook` | 3D, 150 m |
| | `localDistance ≤ radius` | `explosion.ring` (two beating sines near 3.6 kHz, 0.8 to 2.4 s by closeness, ui bus) + world muffle (§2) + duck ambience -14 dB 2 s | 2D |
| | `radius < localDistance ≤ 2 × radius` | duck ambience -6 dB 0.8 s | |
| `jump` | | `jump.local` (whoosh + tiny "hup") / `jump.remote` | 2D / 3D 25 m |
| `land` | | `land.local` / `land.remote` (variant surface, floors included), intensity = fallSpeed / 15; remote < 1.5 m/s silent | 2D / 3D 30 m |
| | ends a drop (local freefall/chute, or a remote open chute) | + `drop.land`: canopy folding down after a light settle | 2D / 3D 25 m |
| `localPlayerSpawned` | | nothing (M2b: players spawn aboard; the M1 spawn wind is gone). Arms the "aboard" state | |
| `mapChanged` (M2b) | | per-map balance into the director; reset match state and loops; ambience scene `island` / `indoor` crossfade (1.5 s); indoor reverb on/off; carrier model from `map.carrier`; zone theme from `zoneTheme`. Kept before unlock | |
| `carrierDeparted` (M2b) | | carrier engine bed, positional at `carrierPosAt(route, serverNow)` and `route.altitude`, until `route.endsAt` (seaplane heard to 480 m, drone to 170 m). Seeds the clock at `route.startsAt` if `setGrenades` has not | 3D bed |
| | local player aboard (spawned, carrier flying, before `ejectAt` + 1 s) | cabin low-pass + ambience duck, interior engine copy (2D, 520 Hz low-pass), door wind rush | 2D beds |
| `playerJumped` (M2b) | local | `drop.jump` (door rush swelling past, cloth whoosh, hand slap); the cabin opens, the door wind cuts, the freefall wind starts | 2D |
| | remote | `drop.jump` at `pos` (smaller) | 3D, 60 m |
| (engine, M2b) | local freefall / chute | freefall wind bed: roar + whistle whose level and brightness follow the listener's measured speed / 30 m/s (floor 0.4 in freefall; chute ×0.6, 0.12..0.45), with buffeting | 2D bed |
| `parachuteOpened` (M2b) | local | `drop.chutePop` (fabric fwump, line snap, harness tug, canopy fill) + canopy flutter bed (~9 Hz flap) until landing | 2D |
| | remote | `drop.chutePop` at `pos`: tells you where someone will land | 3D, 90 m |
| `countdown` | N..1 | `ui.countdown` marimba; last 3 s higher | 2D |
| `matchPhaseChanged` | countdown → playing | `ui.matchStart` (whistle + chord) | 2D |
| | → lobby / results | reset state, stop all loops, heartbeat off, surf off | |
| `matchEnded` | local winner | `ui.victory` + duck sfx and ambience | 2D |
| | other participant | `ui.results` | 2D |
| `interactPromptChanged` | new loot in range | `ui.prompt` soft tick | 2D |
| `spectateTargetChanged` | new target | `ui.spectate` whoosh | 2D |
| `connectionStatus` | disconnected / error | `ui.error` | 2D |
| (engine) | local HP ≤ 30 and > 0 | `heartbeat` every 0.85 s (threshold injected by main.ts from balance `player.lowHpThreshold`, else 30, matching the HUD stripes) | 2D |
| (engine) | island, every 7 to 18 s | `amb.gull` 30 to 80 m around the listener, 15 to 30 m up | 3D |
| (engine, M2b) | indoor, every 2.5 to 7 s | `amb.keys`: a burst of 3 to 9 key clicks (the odd space bar) 12 to 38 m away on the floor | 3D (ambience bus), 50 m |
| `IAudio.playUi(id)` | Ui → `UiCallbacks.playUiSound` → main.ts | `ui.click` / `ui.hover` / `ui.slider` (unknown ids ignored) | 2D |

**Armor** (M2a, replaces the M1 `armorBefore`/`armorAfter` inference): `playerDamaged.vest` / `helmet` and
`localHitConfirmed.vest` / `helmet` are `ArmorHit | null`. A piece is hit when it is non-null, broken when
`.broken`, and `.tier` picks the pitch. The director keeps no armor state.

## 5. Spatialisation

- **Listener** = the camera pose from `renderer.getListenerPose()`, set every frame (position plus forward from yaw,
  up = +Y). The deprecated `setPosition`/`setOrientation` are used as a fallback where AudioParams are missing.
- **Local sounds are 2D** (`isLocal` → `pos: null`). The camera sits behind the player, so panning your own gun would
  feel wrong.
- **Remote sounds**: the PannerNode handles direction only (`rolloffFactor = 0`). Loudness comes from
  `spatial.distanceGain()`, computed once at voice start:
  `ref / (ref + rolloff * (d - ref))`, plus a linear fade to exactly 0 over the last 20 % of `maxDistance`, so nothing
  pops at the cull radius. Sounds beyond `maxDistance` are culled before any node is created.
- **Air absorption**: a low-pass at `20 kHz * e^(-d/45)`, clamped to 900 Hz. It is skipped (no node) when above
  16 kHz, which is anything closer than about 10 m. Gunshots past 30 m also get a brown-noise "distant tail" that
  grows to 150 m. Together these make far fights sound far.
- **Panning model**: HRTF under 40 m, where direction decides fights; equal-power beyond that, which is cheaper.
- One-shots do not track movement after they start. They are under 0.6 s, so this is inaudible. Remote heal loops
  stay where they started (healing players are slowed).

## 6. Ducking

`Ducker` keeps the deepest active duck per bus. Ducks do not stack. Each bus has a duck GainNode with a fast attack
(τ 15 ms) and a slow release (τ 300 ms).

| Trigger | Bus | Depth | Hold |
|---|---|---|---|
| Local weapon or fall damage | ambience | -9 dB | 0.35 s |
| Zone damage tick | ambience | -4 dB | 0.2 s |
| Zone warning horn | ambience | -6 dB | 2.2 s |
| Local washed out (defeat sting) | ambience | -10 dB | 2.5 s |
| Victory jingle | sfx and ambience | -8 dB | 3 s |
| Explosion inside the blast radius (with the muffle and ring) | ambience | -14 dB | 2 s |
| Explosion within 2 × radius | ambience | -6 dB | 0.8 s |

## 7. Ambience

These beds start on unlock with a 2.5 s fade-in and run continuously. All modulation runs on audio-rate LFOs, so they
cost nothing per frame. M2b: one **scene** per map kind. `mapChanged` crossfades to the new scene over 1.5 s and the
old scene's nodes are stopped and disconnected once faded (`Ambience.update`). A map change also clears the outside
and zone-bed layers.

### 7.1 Island scene (unchanged)

- **Waves**: stereo brown noise → low-pass at 420 Hz. A swell LFO (0.11 Hz + 0.071 Hz, incommensurate so it never
  audibly loops) opens the filter and raises the level together.
- **Foam**: high-passed pink noise whose level follows the swell through a 1.4 s delay, so the hiss lands after each
  crest like a wave breaking on sand.
- **Wind**: band-passed pink noise (550 Hz ± 200 Hz at 0.05 Hz), very low level.
- **Surf roar**: while the local player is outside the safe sand, the waves get louder (×1.6) and a brown-noise roar
  fades in.
- **Gulls**: 2 to 3 synthesised "kyow" calls (a triangle wave with a rise-fall pitch through a band-pass), positioned
  around the listener.

Loop buffers (6 to 7 s, stereo, decorrelated channels) crossfade their tail into their head, so the seam is
continuous.

### 7.2 Indoor scene (M2b, office)

- **HVAC**: brown noise low-passed at 150 Hz (the rumble) plus a soft band of pink "air rush" at 420 Hz whose level
  and centre breathe slowly (0.045 / 0.021 Hz).
- **Mains hum**: 58 Hz + 116 Hz sines, barely audible under the rumble.
- **Fluorescent buzz**: a 120 Hz saw through a narrow 2.4 kHz band-pass, very low, with a slow flicker (0.07 Hz) and a
  tube flutter (11 Hz).
- **Distant typing**: `amb.keys` one-shots (§4), instead of gulls.
- **Reverb**: the sfx send (§2).
- **Sprinkler rain bed** (`sprinklers` theme): from the first shrink on there is always rain somewhere, so a soft,
  wide band-passed hiss (3.2 kHz) fades in and stays until the match resets.
- **Spray** (`sprinklers`, local player outside the circle): close high-passed spray, a droplet patter (band-passed
  noise chopped at 13 and 7.3 Hz) and water drumming on the floor. The rain bed steps aside while the spray plays.
- **Lights out** (`lightsOut` theme, outside the circle): the buzz cuts and the air handling swells (×1.4).

## 8. Engine rules and performance

- `new AudioEngine(bus)` subscribes to the bus but creates **no AudioContext**. Every event is dropped silently until
  `unlock()` runs. `unlock()` is idempotent: it creates the context, graph, noise bank and ambience, then resumes the
  context. If Web Audio is missing, it logs once and stays silent; it never throws.
- `main.ts` calls `unlock()` on every pointerdown and keydown, so a context that stayed suspended recovers on the next
  gesture. The engine's only document listener is `visibilitychange` (suspend while hidden, resume when visible).
  There are no document click/hover/gesture listeners: UI sounds come through `playUi()`.
- **No per-frame allocation**: `update()` reaps the pool in place, applies duck targets only when they change, and
  ticks the heartbeat and gull timers. `setListener()` copies into a preallocated vector.
- **Shared noise**: three mono buffers (white 1 s, pink 2 s, brown 2 s) and two stereo loop buffers, generated once
  per context. Sources start at random offsets.
- **Every node is tracked**: recipes register each node and source on their voice. When the voice ends (reaped in
  `update`) or is stolen or stopped (fade, then a `dying` list), every node is disconnected.
- Module map: `cues.ts` (table) · `AudioDirector.ts` (event→command mapping, pure) · `soundMap.ts` (pure helpers) ·
  `drop.ts` (DropTracker, pure) · `fuseTicks.ts` (pure) · `VoicePool.ts` · `Ducker.ts` · `spatial.ts` · `noise.ts`
  (noise and reverb impulse) · `synth.ts` (primitives) · `recipes.ts` (one function per cue) · `Ambience.ts` (scenes)
  · `DropLayers.ts` · `AudioEngine.ts`.
- **Delayed layers instead of timers**: the sniper bolt, the prone thud, the cook tick and the far-explosion delay are
  scheduled inside one voice at offsets from its start (`durationS`), so there are no JS timers to cancel; a keyed
  voice that is stopped takes its future layers with it.
- **Balance** (M2b, REVIEW-M2a M5): the director reads `weapons.sniper.fireIntervalMs` and `items.grenade.fuseMs`
  from `mapChanged.balance` (the effective per-map balance). `AudioEngineOptions.balance` only seeds it until the first
  `mapChanged`. There is no `BALANCE` import any more: with neither, the bolt cycle and the cook tick are skipped (the
  pin still plays), which in practice never happens because `mapChanged` precedes every match. A per-map
  `player.lowHpThreshold` also moves the heartbeat threshold. No gameplay numbers are copied into audio.
- **Persistent drop beds** (M2b, `DropLayers.ts`): the carrier engine, door wind, freefall wind and canopy flutter
  follow live state, so they are beds, not pooled voices. The pure `DropTracker` (`drop.ts`, fed by the director)
  returns one preallocated `DropMix` per frame; the engine applies it with smoothed `setTargetAtTime` calls that are
  skipped when the target barely moved. Each group is built on first need and released 1.2 s after it went silent.
- **Server clock** (M2b): `setGrenades(grenades, serverTime)` sets it each frame; `update(dt)` advances it when no
  fresh value arrived (so the carrier also moves while main.ts does not call `setGrenades` yet). `carrierDeparted`
  seeds it at `route.startsAt` when it is unknown; `mapChanged` clears it.
- **Fuse ticks** (M2b, `fuseTicks.ts`): a pure scheduler keyed by grenade id; grenades missing from a frame are
  forgotten. FrameView.grenades holds thrown grenades only, so the local in-hand cook (2D cook tick) never doubles.
- Tests (`npx vitest run src/audio`, node, no real AudioContext) cover distance and priority math, voice stealing,
  ducking, noise generation, every mapping in §4, every recipe built against a structural fake context (finite
  length, every node registered, every source started and stopped), and engine behaviour: no context before unlock,
  culling, caps, reaping and disconnecting, loops, cooldowns, ducking, heartbeat, and dispose. M2b adds the map
  switch (before and after unlock, crossfade disposal, reverb on and off), office typing vs gulls, glass and floor
  cues, the drop tracker (route position, aboard window, wind by speed, teleports, landings), the drop beds through a
  whole jump, the cabin filter, fuse tick scheduling, and the reverb impulse.

## 9. Contract status

**M2b (ARCHITECTURE §15.9): delivered.** Consumes `mapChanged` (`map.kind`, `map.carrier`, `balance`, `zoneTheme`),
`carrierDeparted`, `playerJumped`, `parachuteOpened`, `footstep.stance`, the `'glass'` impact and grenade-contact
surface, the indoor `FloorMaterial` footstep and landing surfaces, and `IAudio.setGrenades`, exactly as typed in
`src/shared/`. Everything compiles before and after the C-gate (`impactCue` takes `ImpactSurface | GlassSurface`;
surfaces reach recipes as variant strings).

Pending outside audio (tech-lead, main.ts, §15.14):
- `audio.setGrenades?.(view.grenades, view.serverTime)` each frame after `setListener`. Until then there are no
  nearby fuse ticks, and the carrier position is dead-reckoned from `carrierDeparted`.
- `new AudioEngine(bus, { lowHealthHp, balance: BALANCE })` is optional now: `mapChanged.balance` supplies it.

History (M1 and M2a):

Resolved in Contract revision 1 (ARCHITECTURE.md §12): UI sounds via `IAudio.playUi` (the `uiDom.ts` document
listeners are removed), `playerDamaged.armorBefore`, `weaponSwitched.pos`, `playerKilled.headshot`, and the
`actionFailed` event. Each consumer keeps a fallback while its producer has not landed: armor inference from the last
`armorAfter`, silent remote swaps without `pos`, and a body-variant death without `headshot`.

Open after M2a (status updated for M2b):
1. **M2a.** Audio consumes `stanceChanged`, `localAdsChanged`, `grenadeCooked`, `grenadeThrown`, `grenadeBounced`,
   `explosion`, and the `vest`/`helmet` fields of `playerDamaged` and `localHitConfirmed`, exactly as typed in
   `src/shared/events.ts`. Requested (optional, audio already works without them):
   - `footstep.stance?: Stance`: done in M2b. The director reads it directly; the last `stanceChanged.to` per player
     is only the fallback while a producer omits it (REVIEW-M2a M4).
   - Fuse ticks of live grenades within ~8 m: done in M2b through `IAudio.setGrenades`.
   - Balance: M2b uses `mapChanged.balance`; the `BALANCE` fallback is removed (REVIEW-M2a M5).
2. **Low-health threshold.** main.ts injects it (ADR 0003): `new AudioEngine(bus, { lowHealthHp:
   BALANCE.player.lowHpThreshold })`. An undefined or invalid value falls back to
   `AUDIO_TUNING.lowHealthHp` (30, the same as the HUD). If Contract revision 2 adds a ClientGame
   `localLowHealthChanged { low }` event (review m5), audio switches to it and drops its own HP tracking.
3. The `AudioEngine` constructor takes an optional second argument `options?: AudioEngineOptions` (fake-context
   factory, seeded random) for tests, plus `lowHealthHp`, which main.ts passes. `new AudioEngine(bus)` still works and uses 30.
4. Credits: there are no external audio assets in M1 or M2a, so `docs/art/CREDITS.md` needs no audio entries. If
   graphics-designer keeps a section per medium, they can add "Audio: all sounds synthesised in code
   (`src/audio/recipes.ts`), original."

## 10. M2 ideas

- **Music**, on a `music` bus: an adaptive steel-drum and ukulele loop with three layers (calm while looting, a
  percussion layer added while the tide shrinks, a tense bass layer in the final circle and the last 3 players). It
  ducks -6 dB under local gunfire and drops out entirely for the victory and defeat stings. Lobby gets a laid-back
  beach-bar loop. Either authored OGG/Opus files (CC0 or commissioned) or a generative Web Audio sequencer.
- **Coastline wave emitters**: positional wave sources along `coastlineRadius()`, so the sea is louder at the shore
  and quieter on Sunburn Summit.
- **Occlusion**: a low-pass and -6 dB on remote sounds when a prop collider blocks the line of sight (one ray per
  sound start).
- **Bullet whiz**: a short Doppler whistle when a remote ray passes within 2 m of the listener's player.
- **Per-POI ambience**: creaky planks at Rickety Dock, a tiki-bar wind chime, and palm rustle in Shady Palms.
- **Announcer stingers**: "Last dry spot!" and "3 castaways left" (lines from narrative-designer, voiced or
  synthesised).
- Recorded and processed foley for footsteps and pickups, if playtests find the synth versions too samey.
