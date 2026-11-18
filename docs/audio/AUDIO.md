# Audio: Last One Dry (M1)

Owner: audio-designer. Code: [`src/audio/`](../../src/audio/). Cue numbers (priority, limits, ranges, gains) live in
[`src/audio/cues.ts`](../../src/audio/cues.ts) and are the source of truth if they differ from the tables below.

**M1 ships no audio files.** Every sound is synthesised at runtime with the Web Audio API: oscillators, filtered
noise buffers, envelopes and LFOs. There is nothing to license, and `public/assets/audio/` stays empty until M2.

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
  | Coral Rifle | sharp **crack** over a solid thump, short tail | full range, heaviest | steady (150 ms) |

- **Feedback is crisp and dry.** Hit confirms are short 2D blips: a tick-thup for body, a bell **ping** for head, a
  plastic **tunk** for armor, a crunchy **shatter** for armor break, and a bubble **pop-ding** for a knockout.
  Damage you take is a felt low thump, not a sharp sound.
- **The island is warm.** Slow brown-noise swells, a foam hiss that trails each crest, light wind, and the odd
  synthesised gull. The ambience sits under gameplay and ducks out of the way when you get hit.
- **Musical stings are cheeky.** A steel-drum arpeggio for victory, a gentle sad-trombone "wah wah wah waaah" when
  you are washed out (never a death sound), ukulele strums for results, and a conch horn plus lifeguard whistle for
  the tide.

## 2. Mix buses

```
voice (gain: cue gain x jitter x distance) -> [air low-pass] -> [Panner] -> bus
bus: sfx (0.9) / ui (0.7) / ambience (0.5) -> duck gain -> master (settings volume^2) -> limiter -> destination
```

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
| Must-hear feedback | 88 to 99 | hit confirms, damage taken, zone hurt tick, zone warning, heartbeat, victory/defeat, countdown |
| Own weapon | 72 to 80 | local shots, dry fire, surf enter, refusal `ui.nope` (72, 1 instance, 250 ms cooldown so mashing E/Q/R stays gentle) |
| Remote threats | 55 to 75 | remote shots (70), remote eliminations (75), **remote footsteps (65)**, remote jumps and landings, reloads, remote hits |
| Items and own movement | 45 to 62 | pickups, heals, weapon switch (3 instances, local 2D or remote 3D), local footsteps |
| World detail | 38 to 40 | bullet impacts |
| Decoration | 10 to 35 | gulls, hover, prompt tick |

Per-cue limits (examples): SMG remote 6, rifle remote 5, remote footsteps 8, impacts 5 to 6, local footsteps 2, most
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
| | remote | `shot.<weapon>.remote` at `origin` | 3D, 25 m (fists) to 180 m (rifle) |
| | each impact (≤1 per surface, ≤2 per shot) | `impact.ground` / `impact.prop` / `impact.water` at `point` | 3D, 30 to 35 m |
| `dryFire` | | `weapon.dryFire` (variant weapon) | 2D |
| `playerDamaged` | local victim, weapon | `damage.hp` / `damage.armor` / `damage.armorBreak` + duck ambience (kind from `armorBefore`/`armorAfter`, see below) | 2D |
| | local victim, zone | `zone.hurtTick` + light duck | 2D |
| | local victim, fall | `damage.fall` + duck | 2D |
| | local attacker | (remembers body/armor/break for the confirm) | |
| | remote-on-remote weapon hit | `hit.remote` at `victimPos` | 3D, 45 m |
| `localHitConfirmed` | killed | `hitConfirm.kill` (+ `hitConfirm.head` if headshot) | 2D |
| | armor broke | `hitConfirm.armorBreak` (+ head) | 2D |
| | headshot / armor / body | `hitConfirm.head` / `hitConfirm.armor` / `hitConfirm.body` | 2D |
| `playerKilled` | local victim | `ui.defeat` + duck; stops own heal/reload/drop loops and heartbeat | 2D |
| | anyone else | `death.remote` (bonk + splash; variant `head` adds a coconut "tok" when `headshot`) at `victimPos` | 3D, 70 m |
| `itemPickedUp` | | `pickup.weapon` / `.ammo` / `.heal` / `.vest` (variant item) | 2D local, 3D remote (12 to 15 m) |
| `reloadStarted` | | `reload.start`, keyed `reload:<id>`; shotgun schedules one shell per ~0.55 s | 2D / 3D 18 m |
| `reloadFinished` | completed | stop key + `reload.finish` (shotgun: pump) | 2D / 3D 18 m |
| | cancelled | stop key (scheduled shells never play) | |
| `healStarted` | | `heal.start` (bandage tear / medkit zip) + `heal.loop` keyed `heal:<id>` | 2D / 3D 14 to 18 m |
| `healFinished` | | stop loop + `heal.finish` chime | 2D / 3D 14 m |
| `healCancelled` | | stop loop; local: `heal.cancel` down-blip | 2D |
| `weaponSwitched` | local | `weapon.switch` (fists: swish + knuckles; guns: click-clack by weapon) | 2D |
| | remote with `pos` | `weapon.switch` at `pos` (silent while `pos` is absent) | 3D, 15 m |
| `actionFailed` | local, action ≠ `fire` | `ui.nope`: two soft falling wooden bloops, variant = reason (`noAmmo` lower and drier). `fire` is ignored (`dryFire` covers it) | 2D (ui bus) |
| `zoneChanged` | shrinking starts | `zone.tideRising` whoosh + `zone.tideLoop` keyed `tide` | 2D (ambience bus) |
| | shrinking ends | stop `tide` | |
| `zoneWarning` | | `zone.warning` (conch horn + 2 whistles, 3 from phase 3) + duck ambience | 2D |
| `localZoneStatusChanged` | outside | `zone.enterSurf` splash + ambience surf roar on | 2D |
| | inside | `zone.exitSurf` + surf roar off | 2D |
| `footstep` | | `foot.local` / `foot.remote` (variant surface: sand crunch, grass swish, water splash; sprint = louder and shorter) | 2D / 3D 30 m |
| `jump` | | `jump.local` (whoosh + tiny "hup") / `jump.remote` | 2D / 3D 25 m |
| `land` | | `land.local` / `land.remote`, intensity = fallSpeed / 15; local landing stops the drop wind; remote < 1.5 m/s silent | 2D / 3D 30 m |
| `localPlayerSpawned` | | `drop.wind` loop keyed `drop` (max 20 s) | 2D |
| `countdown` | N..1 | `ui.countdown` marimba; last 3 s higher | 2D |
| `matchPhaseChanged` | countdown → playing | `ui.matchStart` (whistle + chord) | 2D |
| | → lobby / results | reset state, stop all loops, heartbeat off, surf off | |
| `matchEnded` | local winner | `ui.victory` + duck sfx and ambience | 2D |
| | other participant | `ui.results` | 2D |
| `interactPromptChanged` | new loot in range | `ui.prompt` soft tick | 2D |
| `spectateTargetChanged` | new target | `ui.spectate` whoosh | 2D |
| `connectionStatus` | disconnected / error | `ui.error` | 2D |
| (engine) | local HP ≤ 30 and > 0 | `heartbeat` every 0.85 s (threshold injected by main.ts from balance `player.lowHpThreshold`, else 30, matching the HUD stripes) | 2D |
| (engine) | every 7 to 18 s | `amb.gull` 30 to 80 m around the listener, 15 to 30 m up | 3D |
| `IAudio.playUi(id)` | Ui → `UiCallbacks.playUiSound` → main.ts | `ui.click` / `ui.hover` / `ui.slider` (unknown ids ignored) | 2D |

**Hit kind** (armor thump / armor break / body): `armorAfter > 0` → armor; else `armorBefore > 0` → armor break; else
body. `armorBefore` comes from `playerDamaged.armorBefore` (Contract revision 1 #2). When it is absent, the director
falls back to the victim's last seen `armorAfter`.

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

## 7. Ambience

These beds start on unlock with a 2.5 s fade-in and run continuously. All modulation runs on audio-rate LFOs, so they
cost nothing per frame.

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
  `VoicePool.ts` · `Ducker.ts` · `spatial.ts` · `noise.ts` · `synth.ts` (primitives) · `recipes.ts` (one function
  per cue) · `Ambience.ts` · `AudioEngine.ts`.
- Tests (`npx vitest run src/audio`, node, no real AudioContext) cover distance and priority math, voice stealing,
  ducking, noise generation, every mapping in §4, every recipe built against a structural fake context (finite
  length, every node registered, every source started and stopped), and engine behaviour: no context before unlock,
  culling, caps, reaping and disconnecting, loops, cooldowns, ducking, heartbeat, and dispose.

## 9. Contract status

Resolved in Contract revision 1 (ARCHITECTURE.md §12): UI sounds via `IAudio.playUi` (the `uiDom.ts` document
listeners are removed), `playerDamaged.armorBefore`, `weaponSwitched.pos`, `playerKilled.headshot`, and the
`actionFailed` event. Each consumer keeps a fallback while its producer has not landed: armor inference from the last
`armorAfter`, silent remote swaps without `pos`, and a body-variant death without `headshot`.

Open:
1. **Low-health threshold.** main.ts injects it (ADR 0003): `new AudioEngine(bus, { lowHealthHp:
   BALANCE.player.lowHpThreshold })`. Audio does not import `BALANCE`. An undefined or invalid value falls back to
   `AUDIO_TUNING.lowHealthHp` (30, the same as the HUD). If Contract revision 2 adds a ClientGame
   `localLowHealthChanged { low }` event (review m5), audio switches to it and drops its own HP tracking.
2. The `AudioEngine` constructor takes an optional second argument `options?: AudioEngineOptions` (fake-context
   factory, seeded random) for tests, plus `lowHealthHp`, which main.ts passes. `new AudioEngine(bus)` still works and uses 30.
3. Credits: there are no external audio assets in M1, so `docs/art/CREDITS.md` needs no audio entries. If
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
