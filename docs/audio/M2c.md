# Audio spec: M2c "Fresh Every Match & Bigger Arsenal"

Owner: audio-designer. Status: **design spec (round 1)**. Implementation follows once the tech-lead's M2c contract
(ADR 0007, ARCHITECTURE §16) is in place. Event and field names in §11 are **requests**. The tech-lead may rename
or reshape them, and audio will follow the contract.

Base system: [AUDIO.md](AUDIO.md). M2c adds no audio files. Every sound below is synthesised in
`src/audio/recipes.ts` from the existing primitives (`tone`, `noise`, `click`, `bell`, `pluck`, `loopNoise`, `lfo`,
envelopes) on the existing buses, pool, ducker and muffle. `public/assets/audio/` stays empty, and there is nothing to
credit.

Gameplay numbers (swing timing, knockback length, smoke grow/hold/fade, rocket speed, blast radius, reload times) come
from `mapChanged.balance` and the event payloads, never from audio constants. Audio tuning (gains, ranges, priorities,
filter frequencies) lives in `src/audio/cues.ts` and `AUDIO_TUNING`, as in M1 to M2b.

---

## 0. Design rules for M2c

1. **Every new weapon gets its own band and rhythm**, so it stays readable among the eight existing guns. The table in
   §1 extends AUDIO.md §1.
2. **Toys, not gore.** Melee hits on bodies sound like pool noodles, beach balls and cushions: thwacks, bonks and
   paps. There are no flesh-cutting sounds, and nothing wet except actual water.
3. **Level is audible only where it is a reward.** The local pickup sparkle (§7) and the tier-4 armor clink rise with
   level. Shots, swings and reloads sound the same at every level. Level must never change a weapon's identity, or
   players would stop recognising guns by ear.
4. **Smoke is a frag's quiet cousin.** It is lower, hollower and tick-free, so a player can tell "duck" from "they're
   about to push" from the pin alone (§5).
5. **Ambience presets never borrow gameplay sounds.** There is no thunder (it reads as a far explosion), no clock
   ticks (fuse tick), no chimes in the UI-sting register, and no rhythmic clicks (footsteps). Every preset's bed level
   stays within +1.5 dB of the M2b baseline, so footstep audibility does not depend on the roll (§8).

## 1. Sonic identity of the new weapons

| Weapon | Character | Band | Rhythm cue |
|---|---|---|---|
| `knife` | thin, fast **fwip** (an air slice), with a tiny blade **tik** on contact | high (2.5 to 5 kHz) | quick, light, repeated |
| `machete` | mid **whoosh** with a faint metal ring, and a **chok** on contact | mid (1 to 3 kHz) | even, deliberate |
| `paddle` | low, heavy **whuuum** air push, with a hollow wooden **BONK** on contact | low-mid (250 to 900 Hz) | slow wind-up, big payoff |
| `dbshotgun` | the deepest gun: a fat **BWOMF** plus a hollow two-barrel "bottle" ring; both barrels = a doubled flam | sub to low-mid (45 to 420 Hz) | boom (boom) ... long silence ... **break-open clack** |
| `revolver` | a heavy cork **BONK-pop**, lower and longer than the Conch Pistol, with a cylinder **tick** 120 ms after each shot | mid-low (700 Hz to 90 Hz drop) | slow, heavy single taps, each followed by the ratchet |
| `rpg` | a cardboard-tube **FWOOMP** and a long back-blast hiss, then the rocket's **sputtering whistle** flying away | sub thump plus a broadband hiss, and a 700 to 1100 Hz whistle in flight | launch ... whistle (doppler) ... explosion |
| `smoke` (throwable) | a plastic **twist-pop** (no spoon ping), a hollow tin-can **tonk** bounce, then a **PFFF** and a long hiss | low-mid can resonance (500 to 700 Hz) plus a 2.5 to 4 kHz hiss | silent fuse (no ticks) ... pop ... hiss that tapers |

## 2. Melee: swing, hit and knockback

### 2.1 Timing model

A melee attack has a wind-up. The sim tests the hit once, at the swing's hit frame. Audio splits it into two events
(§11.1):

- `meleeSwing` at swing start: the whoosh is scheduled inside one voice so that its **peak lands on the hit frame**
  (`windupMs`). Local swings come from prediction for instant feedback. Remote swings come from the server.
- `meleeHit` at the hit frame (server): the contact sound at the contact point. It is not emitted on a miss, so the
  whoosh alone means a miss.

**Fallback:** if the contract routes melee through `shotFired` (as fists do today) and adds no `meleeSwing`, the
whoosh plays on `shotFired` with no wind-up lead, and contacts come from `shotFired.impacts` plus `playerDamaged`.
This is functional but less readable.

### 2.2 Swing whoosh (`melee.swing.local` 2D / `melee.swing.remote` 3D, variant = weapon)

The whoosh is a band-passed pink noise sweep with a rising then falling centre, plus a thin high-passed "edge" layer.
Its peak sits at `peakAt = clamp(windupMs / 1000, 0.04, 0.6)`: the attack ramps from `peakAt - rise` to `peakAt`, then
decays.

| Variant | Sweep centre (Hz) | Q | Rise / decay (s) | Edge layer | Extra |
|---|---|---|---|---|---|
| knife | 2500 to 5200 to 3800 | 2.2 | 0.05 / 0.07 | high-pass 5 kHz, 30 ms, gain 0.2 | none. It is the shortest and thinnest sound in the game |
| machete | 1000 to 3000 to 2000 | 1.6 | 0.09 / 0.12 | high-pass 4 kHz, 50 ms, gain 0.15 | very faint bell 3.1 kHz (partials 1, 2.7), decay 0.15, gain 0.05: blade ring |
| paddle | 250 to 900 to 500 | 0.9 | 0.16 / 0.20 | none | brown noise low-pass 300 Hz with the same envelope, gain 0.5: the "push of air". A 60 ms wooden creak (band-pass 700 Hz, Q 8, noise) at the wind-up start (`at 0`): the paddle being pulled back |

The local swing is 2D at `gain 0.6`. The remote swing is 3D (ranges in §9). It is a close-range threat cue, so it
outranks remote footsteps.

### 2.3 Contact matrix (`melee.hit`, 3D, variant `<weapon>.<material>`)

`material` is one of `body`, `head`, `vest`, `helmet`, `glass`, `wall`, `ground`, `water`.

| Weapon \ material | body | head (no helmet) | vest (armor) | helmet | wall / prop | ground (sand, floor) | water | glass |
|---|---|---|---|---|---|---|---|---|
| **knife** | pool-noodle **tap**: triangle 520 to 260 Hz, 40 ms, plus a pink noise pap 1.8 kHz, 30 ms | same, plus a coconut **tok** (triangle 900 Hz, 25 ms) | fabric **scritch** (band-pass noise 3.2 kHz, Q 4, 60 ms) plus `vestClink` at tier | blade on shell: **tink** (`click` 4.2 kHz) plus `helmetTonk` at tier, short | **tik-thunk**: a blade sticking into wood (`click` 3.6 kHz, then triangle 340 Hz, 50 ms) | sand stab: brown noise low-pass 600 Hz, 50 ms | small slap-splash (`splash` 0.4, 0.15 s) | thin glassy tick (`bell` 4.6 kHz, 0.12 s) |
| **machete** | **thwack**: sine 180 to 90 Hz, 70 ms, plus band-pass noise 1.2 kHz, 60 ms | plus a bigger tok (700 Hz) | padded **thud** plus a plate **clank** (`vestClink` at tier, gain x1.2) | **clang-tonk**: `helmetTonk` plus a bell 2.2 kHz (partials 1, 2.4), 0.25 s | **chok**: a woody chop (triangle 260 Hz, 60 ms, plus a 2.4 kHz click) | sand chop (brown noise 800 Hz, 70 ms) | splash 0.6 | dull glassy **thunk** plus a ring (as `impact.glass`, gain x1.3) |
| **paddle** | beach-ball **WHAP**: sine 140 to 60 Hz, 120 ms, plus pink noise 900 Hz, 90 ms, gain 0.9 | cartoon **BONK**: hollow wood (band-pass noise 500 Hz, Q 6, 120 ms) plus a sine 320 to 180 Hz with an 18 Hz pitch wobble (the toy "boing"), 0.3 s | heavy padded **WHUMP** plus `vestClink` at tier, low | big **TONK**: `helmetTonk` at 0.8 pitch, long ring (0.4 s) | **THOCK**: wood on wood (triangle 190 Hz plus band-pass noise 1.1 kHz, Q 3, 100 ms) | sand **fwump** (brown noise 400 Hz, 120 ms, plus crackle grains) | big oar slap: `splash` 0.9, 0.35 s | heavy dull thunk |

`glass` is the contact only. The pane breaking is a separate cue from `glassShattered` (§2.5), so a melee strike
on glass plays both.

**Who hears what for player hits.** The existing confirms stay, and the melee contact is layered on top:

- **Local attacker:** the `melee.hit` contact plays 2D, plus the usual `hitConfirm.*` from `localHitConfirmed`, so
  hit feedback stays one system. The melee contact is the "feel", and the confirm is the "information".
- **Local victim:** the `damage.*` cues from `playerDamaged` as today, plus `melee.hit` 2D at gain x0.7, so you know
  what hit you.
- **Remote on remote:** `melee.hit` at the contact point **replaces** `hit.remote` for that damage event, so it is not
  voiced twice. This needs the weapon on `playerDamaged` (§11.1).

### 2.4 Paddle knockback (`melee.knockback`)

When `meleeHit.knockback` is true, two layers are scheduled in one voice:

1. **Shove:** at `0`, a short brown noise "huff" (low-pass 500 Hz, 80 ms) and a cloth whoosh (band-pass 600 to
   1400 Hz, 0.18 s), on top of the paddle WHAP.
2. **Thud:** at `knockbackMs / 1000` (from `balance.weapons.paddle.knockbackMs`; 0.3 s if absent), a body **thud** on
   the ground: sine 90 to 45 Hz, 0.15 s, plus a surface scuff that matches the victim's footstep surface (sand drag,
   wood knock, carpet pad or tile squeak, reusing `surfaceStep` at gain 0.6).

The local victim hears it 2D with an ambience duck of -9 dB for 0.4 s (same as weapon damage). Everyone else hears it
3D at the victim. The cue is keyed `kb:<victimId>`, so a second knockback restarts it and never stacks two thuds.

### 2.5 Glass shatter (`glass.shatter`, 3D)

M2c makes office glass breakable (by melee and rockets). The shatter has a sharp break transient (high-passed noise,
6 kHz, 15 ms), 3 to 4 inharmonic bells (2.8 to 5.6 kHz, random partials, 0.3 to 0.6 s) and a shard rain (`crackle`
of 10 to 14 grains over 0.5 s, 3 to 7 kHz, falling gain). It plays at the pane centre. A rocket that breaks several
panes in one blast is capped by the cue's instance limit (3) and a 30 ms cooldown. The shatter is **intel** (someone
just opened a route) and is heard to 50 m, through the indoor reverb.

## 3. Close-range gun and revolver

### 3.1 `dbshotgun` shot (`shot.dbshotgun.local` / `.remote`, variant `1` or `2` barrels)

The base layers for **one barrel** (`barrels = 1` or absent):

- Body: sine 95 to 38 Hz, glide 0.12, decay 0.28, gain 0.95. This is lower and rounder than the Scatter Clam.
- Punch: brown noise low-pass 1.6 kHz to 250 Hz, decay 0.22, gain 0.8.
- Crack: high-pass 2 kHz noise, decay 0.04, gain 0.45.
- **Barrel ring** (the signature): two band-passed noise resonators at 380 Hz and 415 Hz (Q 14), attack 2 ms, decay
  0.3 s, gain 0.18 each. It sounds like blowing across two bottles. The pump shotgun has no ring, so this is how you
  tell the two apart.
- Remote: plus `distantTail(v, 0.5)`.

**Both barrels** (`barrels = 2`): the whole stack plays twice, 16 ms apart (a flam). The second copy is pitched
-1 semitone and the body decay is longer (0.4 s). There is an extra sub thump (sine 55 to 30 Hz, decay 0.35, gain 0.6),
and the overall gain is +2 dB. It reads as one huge "BWOMF-mf", not two shots.

There is no pump afterwards. The silence is the tell: after two barrels, the enemy is empty.

### 3.2 `dbshotgun` reload (break-open, `reload.start` variant `dbshotgun`, spread over `durationMs`)

| At (% of duration) | Layer |
|---|---|
| 0 | latch **click** (2.2 kHz, Q 6) plus a hinge creak (band-pass noise 900 to 600 Hz, Q 5, 0.12 s): the barrels drop |
| 8 | **shell eject**: two hollow plastic pops (triangle 700 Hz and 640 Hz, 25 ms, 40 ms apart) plus a tinkle as they land (`crackle` of 3 grains, 2.5 to 3.5 kHz, 0.25 s later). Only spent shells pop, so the count is `rounds` (§11.2), default 2 |
| 45 | shell 1 in: a soft cardboard **thup** (band-pass noise 1.1 kHz, 35 ms) plus a seat click (1.6 kHz) |
| 65 | shell 2 in (only when `rounds = 2`) |

`reload.finish` (variant `dbshotgun`): the **break-shut CLACK**, a hard double click (2.6 kHz and 1.4 kHz, 10 ms
apart) plus a short wood knock (triangle 300 Hz, 40 ms). It is loud enough (gain 0.75) that enemies within 18 m hear
"loaded".

### 3.3 `revolver` shot (`shot.revolver.local` / `.remote`)

- Pop: sine 700 to 110 Hz, glide 0.07, decay 0.13, gain 0.8 (the pistol's pop, a fifth lower and longer).
- Body: triangle 180 to 70 Hz, decay 0.16, gain 0.6.
- Crack: high-pass 2.2 kHz, decay 0.045, gain 0.55.
- Thump: sine 70 to 38 Hz, decay 0.16, gain 0.55.
- **Cylinder tick** at +0.12 s: `click` 3.1 kHz, gain 0.25, plus a smaller one at 2.7 kHz 25 ms later. This is the
  revolver's rhythm signature.
- Remote: plus `distantTail(v, 0.4)`.

### 3.4 `revolver` reload (`reload.start` variant `revolver`)

| At | Layer |
|---|---|
| 0 | cylinder swing-out: a ratchet of 3 clicks (2.4 kHz, 30 ms apart) plus a metal slide (band-pass 2 kHz, 80 ms) |
| 10 % | ejector rod push: a soft thunk, then a **casing rattle** of 6 tinkles (`crackle` 6 grains, 3.2 to 4.5 kHz, over 0.3 s) |
| 40 to 70 % | rounds in: one tick per round loaded (`rounds`, default 6), evenly spaced, 1.9 kHz, gain 0.3 |

`reload.finish` (variant `revolver`): cylinder snap shut (a 2 kHz click plus a triangle 420 Hz, 30 ms) then a spin
ratchet (8 clicks, accelerating from 25 to 12 ms apart, falling gain).

### 3.5 Dry fire, switch and pickup (new weapons)

`WEAPON_PITCH` gains: knife 1.35, machete 1.1, paddle 0.7, dbshotgun 0.78, revolver 1.0, rpg 0.62, smoke 0.95.

| Cue | knife | machete | paddle | dbshotgun | revolver | rpg | smoke |
|---|---|---|---|---|---|---|---|
| `weapon.switch` | sheath **shing** (band-pass noise 3.5 to 6 kHz, Q 6, 0.15 s) | heavier shing (2 to 4 kHz, 0.2 s) | wooden **clack** on the palm (triangle 260 Hz plus a 1.2 kHz click) | hinge clack | cylinder spin (5 ratchet clicks) | tube shoulder thump plus a latch | can rattle (`crackle` 4 grains, 1.6 kHz, no spoon) |
| `weapon.dryFire` | n/a | n/a | n/a | double hammer click (1.8 kHz, 2.1 kHz, 60 ms apart) | single hammer **click** on an empty chamber (2 kHz, Q 8) | hollow tube clunk (triangle 220 Hz, 50 ms) | n/a |
| `pickup.weapon` | as today, pitched by `WEAPON_PITCH`, plus the level sparkle (§7) | ← | ← | ← | ← | ← | `pickup.grenade` variant `smoke`: a can tonk instead of the metal clink |

Melee weapons have no reload, no ADS and no dry fire. The fists' `shot.fists.*` stays unchanged.

## 4. RPG

### 4.1 Launch (`rocket.launch.local` 2D / `rocket.launch.remote` 3D)

This plays on `rocketFired`. If the contract also emits `shotFired` for `rpg`, the director ignores it, so the launch
is voiced exactly once.

- Tube **FWOOMP**: sine 70 to 32 Hz, glide 0.2, attack 3 ms, decay 0.35, gain 1.
- Cardboard tube resonance: band-passed brown noise 320 Hz, Q 3, decay 0.18, gain 0.5.
- **Back-blast hiss**: white noise high-pass 1.5 kHz, attack 5 ms, decay 0.55, with the filter falling to 900 Hz,
  gain 0.55. This is the long "fssshhh" that says "rocket" and not "gun".
- Ignition crackle: `crackle` 8 grains, 2 to 5 kHz, over 0.25 s, gain 0.25.
- Remote: plus `distantTail(v, 0.6)`. Heard to 220 m (it is a big, rare, important sound).

### 4.2 Rocket in flight (persistent emitters, `RocketLayers.ts`)

The rocket moves and lives for up to a few seconds, so it is a **bed**, like the carrier engine (DropLayers), not a
pooled one-shot. Positions come each frame from `IAudio.setRockets?(rockets, serverTime)` (§11.3).

**Graph per emitter** (built once, reused, and released 2 s after it goes idle):

```
brownLoop/pinkLoop source (loop) -> band-pass 1.8 kHz, Q 1.2 --\
sawtooth whistle 900 Hz -> low-pass 2.4 kHz -> gain 0.18 ------+-> sputter gain (LFO 13 Hz square, depth 0.35)
                                                                 -> air low-pass -> PannerNode (HRTF) -> distance gain -> sfx bus
```

**Per-frame update** (allocation-free, with `setTargetAtTime` and skipped when the change is under 1 %):

- Panner position = rocket position.
- **Doppler-ish pitch:** with `u` = the unit vector from the rocket to the listener,
  `vr = dot(rocket.vel, u)` (positive when approaching) and
  `ratio = clamp(343 / (343 - vr), 0.78, 1.35)`, smoothed with τ 50 ms. The ratio multiplies the whistle frequency,
  the band-pass centre and the noise `playbackRate`. Listener velocity is ignored (it is small next to a rocket's).
  A rocket flying at you climbs in pitch, and one flying away from you (including your own) sinks.
- Gain = `spatial.distanceGain(d, ref 5, max 90, rolloff 0.9)` x 0.7, plus the air low-pass from `spatial.ts`.
- **Voice cap: 3 emitters.** The 3 nearest live rockets within 90 m get one each. A rocket that loses its emitter
  fades out over 60 ms.

**Fly-by** (`rocket.flyby`, 3D one-shot): when a rocket's closest approach to the listener passes inside 6 m (it was
approaching last frame and is receding this frame, at a distance under 6 m), play a fast whoosh: band-pass noise 3 to
0.8 kHz over 0.25 s, gain by closeness. It fires once per rocket.

**Stop:** on `explosion` with `source = 'rocket'` and the same `id`, the emitter cuts with a 25 ms fade, so the
whistle never outlives the bang. A rocket missing from `setRockets` for more than 150 ms fades over 80 ms.

**Fallback without `setRockets`:** the director dead-reckons from `rocketFired.pos` and `vel` (straight line plus the
balance gravity, if exposed) until the explosion or `balance.weapons.rpg.maxFlightMs`. This is the same approach as
the carrier before `setGrenades` landed.

### 4.3 Explosion

This reuses the `explosion` event, recipe, delay by distance, ring, world muffle and ducks (AUDIO.md §4 and §6) with no
changes for grenades. Rockets use a sibling cue, `explosion.rocket`. It is a separate cue so it can have its own range
and instance limit, and so a rocket barrage cannot steal every grenade bang.

- Same recipe with variant `rocket` (or `water` when `pos.y < seaLevelY`), plus:
  - a sharper front: high-pass 3 kHz, decay 0.03, gain 0.6, at the delay;
  - **size from the event radius**: `size = clamp(radius / 6, 0.8, 1.5)` (6 m is the frag radius). It scales the sub
    decay (0.9 s x size), the rolling-echo gain and the debris crackle count (6 x size). Bigger blasts sound longer,
    not louder, because the limiter would only flatten louder;
  - debris: wood and plastic chunks (`crackle` 5 grains, 400 to 1200 Hz, 0.2 to 0.7 s after) on top of the sand rain.
- The ring, muffle and ambience ducks use `localDistance` and `radius` exactly as for frags. The director does not
  care what made the blast.
- Direct-hit damage is voiced by `playerDamaged` and `localHitConfirmed` as usual.

### 4.4 Rocket reload (`reload.start` variant `rpg`)

| At | Layer |
|---|---|
| 0 | tube tilted down: cloth rustle plus a strap creak (band-pass 1.4 kHz, Q 6, 0.15 s) |
| 30 % | rocket pulled from the pack: Velcro-ish rip (pink noise band-pass 2.5 kHz, 0.12 s) |
| 40 to 65 % | rocket slides in: a long rising scrape (band-pass noise 600 to 1600 Hz, Q 4, over 0.4 s) |
| 70 % | seat **thunk**: sine 120 to 70 Hz, 80 ms, plus a 1.8 kHz click |

`reload.finish` (variant `rpg`): latch snap (two clicks at 2.4 kHz) plus the shoulder thump. A remote RPG reload is
heard to 18 m like other reloads. It tells you the next rocket is coming.

## 5. Smoke bomb

### 5.1 Throw cycle (same events as the frag, with `kind = 'smoke'`)

| Event | Frag (unchanged) | Smoke |
|---|---|---|
| `grenadeCooked` | `grenade.pin`: pin scrape, pop, **spoon ping** | `smoke.pin`: a plastic cap **twist** (band-pass noise 1.8 kHz, Q 3, with a 22 Hz amplitude ratchet, 0.12 s) plus a hollow **pop** (triangle 520 to 380 Hz, 30 ms). No spoon, no bell. Heard to 10 m |
| local cook loop | `grenade.tick`: ticks that speed up | none. A smoke's fuse is not a threat, and a tick would make it read as a frag. The HUD fuse bar covers timing |
| `grenadeThrown` | `grenade.throw` whoosh | `grenade.throw` variant `smoke`: the same whoosh, lower (sweep 300 to 1300 Hz) plus a can rattle (`crackle` 3 grains, 1.5 kHz) |
| `grenadeBounced` | `grenade.bounce`: metallic clink | `smoke.bounce` (variant surface): a hollow **tin-can tonk**, a band-pass noise resonator at 620 Hz (Q 10, 80 ms) plus triangle 300 Hz (40 ms). Water: a duller plop. Glass: a soft tok with no ring. Intensity = speed / 12 |
| `IAudio.setGrenades` fuse ticks | ticks within 8 m | **skipped** for `kind = 'smoke'` (requires `GrenadeView.kind`) |
| `explosion` | bang | never. A smoke ends with `smokeDeployed` |

### 5.2 Deploy and hiss (`smokeDeployed`)

- `smoke.pop` (3D, 60 m): a hollow **PFFF-POOF**. Brown noise low-pass 900 to 300 Hz with a 5 ms attack and 0.25 s
  decay, plus a band-pass noise burst at 2.8 kHz (0.4 s, fast attack) and a can-body tonk. It announces "smoke here"
  across a fight without sounding like a blast.
- `smoke.hiss` (3D loop, keyed `smoke:<id>`, at `pos`, heard to 35 m): a continuous **canister hiss** shaped by the
  cloud's lifetime, all scheduled at start (no per-frame work):

| Layer | Sound |
|---|---|
| Hiss | pink loop through a band-pass at 3.4 kHz (Q 0.8), with a slow random wobble (LFO 0.3 Hz plus 0.71 Hz on the centre, ±400 Hz) |
| Billow | brown loop, low-pass 280 Hz, breathing at 0.2 Hz: the cloud rolling out |

| Phase (from balance, §11.4) | Envelope |
|---|---|
| grow (`growMs`) | hiss ramps 0 to 1.0 in 80 ms and stays at full; billow rises 0 to 0.6 |
| hold (`holdMs`) | hiss decays linearly to 0.35 and its centre slides 3.4 to 2.4 kHz (the canister emptying); billow eases to 0.25 |
| fade (`fadeMs`) | both fade to 0 |

A late joiner or spectator starts the loop at `offset = serverTime - t`: the envelope is computed from that offset,
and the pop is skipped when the offset is over 0.5 s. `matchPhaseChanged` (to lobby or results) and `mapChanged` stop
every `smoke:*` key.

### 5.3 Muffling inside smoke: decision

**Gameplay sounds are not muffled by smoke.** This holds when the listener is inside a cloud and when the line from a
sound to the listener crosses a cloud. The reasons:

1. **Readability first.** In smoke you cannot see. Sound is the one sense left, and the brief already takes away name
   tags, hit markers and scopes. Muffling footsteps and gunshots too would make smoke fights a coin flip rather than
   a tense ear-led duel.
2. **Fairness and consistency.** Bullets go through smoke (no blocking in the sim), so dulling them would lie about the
   threat. Bots do not use hearing in smoke differently, so the client should not either.
3. **Cost.** A per-sound segment-vs-sphere test is cheap, but a muffled variant of every cue doubles the tuning surface
   for little gain.

**Instead, a light "cocoon" on ambience only.** While the listener's ear is inside an active cloud (distance to
centre < current radius), the ambience bus gets a dedicated low-pass at 2.5 kHz (τ 0.25 s) and a -6 dB duck, and the
nearest smoke's hiss gets +3 dB. Gameplay sounds stay full-band, so footsteps and reloads stand out **more** in smoke.
The cocoon is one extra BiquadFilter on the ambience path (separate from the shared world muffle) and costs nothing
when open.

Revisit after the user's playtests if smoke feels too "transparent" to the ear. The fallback is a mild sfx high-shelf
of -4 dB above 3 kHz, for sounds whose source-to-listener segment crosses a cloud.

### 5.4 Hit confirms on targets hidden by smoke

The UI hides hit markers on targets you cannot see through smoke. A crisp `hitConfirm.*` would give away the same
information, so audio mirrors the UI:

- When `localHitConfirmed.hiddenBySmoke` is true (§11.1), the body, head and armor confirms are **skipped**. The kill
  confirm still plays (the kill feed shows it anyway).
- The shooter still hears their own shot and the world impacts. The victim's experience is unchanged.

Without the field, confirms play as today. ClientGame should compute the flag with the same test the UI uses.

## 6. Armor level 4

The existing `vestN` / `helmetN` variants extend to tier 4 (`tierPitch = 1 + 0.14 x (tier - 1)`, so tier 4 = x1.42).
Tier 4 adds one bright partial to the clink and the tonk (bell at 2.4x the base, gain 0.08) so it reads as "premium"
without a new sound. This applies to `hitConfirm.vest/helmet`, `damage.vest/helmet` and `hit.remote` vest4 and
helmet4. The pickups `pickup.vest` and `pickup.helmet` extend to tier 4 the same way, and they also get the level
sparkle (§7).

## 7. Pickup level sparkle (`pickup.level`, 2D, local only)

This is a tiny kalimba run on top of the normal pickup sound, for any **levelled** item (weapons, melee, armor) picked
up by the local player. It starts 80 ms after the pickup so the mechanical click lands first. The notes are plucks
(`pluck`, decay 0.25 s) a major-pentatonic step apart, rising with level:

| Level | Notes (MIDI) | Spacing | Extra |
|---|---|---|---|
| 1 | 79 (G5) | none | none. A single soft blip |
| 2 | 79, 84 | 55 ms | none |
| 3 | 79, 84, 88 | 55 ms | a soft high bell tail (5.3 kHz, 0.3 s, gain 0.05) |
| 4 | 79, 84, 88, 91 | 50 ms | a shimmer: the bell tail plus a white-noise sparkle (high-pass 7 kHz, 8 grains over 0.4 s) |

The gain is 0.3, the pitch is fixed (no jitter, so the level stays learnable), and there is 1 instance. It is the
same run in every map and for every item class. This is "one level system" in sound, matching the shared colour scale.

- **Remote pickups get no sparkle.** It is a personal reward, and a 3D sparkle would add clutter for little intel.
- A **swap** (the existing swap prompt) is a pickup of the new item, so the sparkle plays for the new item's level.
- The sparkle is original (a 4-note pentatonic run). It does not imitate any game's rarity jingle.

## 8. Look presets and ambience

The look is part of the `MatchLayout` (seeded per match), so all players hear the same mood. Audio needs the preset id
when the map and layout are known (§11.5). On a change, the scene parameters cross-fade over 1.5 s (`sceneFadeS`),
using the same machinery as the M2b scene switch. An unknown or missing id uses the default (`noon` or `day`).

The preset ids below are proposals. graphics-designer and tech-lead own the final ids, and audio maps whatever they
choose with one table (`AMBIENCE_LOOKS` in `Ambience.ts`).

### 8.1 Island

Baseline = the M2b island scene (waves, foam, wind, gulls).

| Preset | Waves | Wind | Gulls (interval) | Extra layers |
|---|---|---|---|---|
| `morning` | x0.8, low-pass 380 Hz, swell LFOs x0.85 (calmer) | x0.7 | **5 to 12 s**, more lively | **reef birds**: one-shot `amb.bird` (a sine "tui-tui" chirp pair, 3.2 to 4.4 kHz) every 6 to 14 s, 20 to 50 m away, 8 to 15 m up |
| `noon` (default) | baseline | baseline | 7 to 18 s | none. Exactly the M2b bed |
| `golden` | x0.9, low-pass 360 Hz (warmer, darker) | x1.1, centre 450 Hz | 12 to 25 s | **crickets**: `amb.crickets` one-shot (3 to 5 sine pulses at 4.3 kHz, 18 ms each, 60 ms apart) every 4 to 9 s, 15 to 40 m away, very quiet. **Tiki wind chime**: `amb.chime` (2 to 3 pentatonic bell notes, 1.5 to 2.4 kHz, slow decay) every 18 to 35 s, 30 to 60 m away |
| `overcast` | x1.2, low-pass 520 Hz, swell LFOs x1.25 (choppier) | **x1.8**, wider band (Q 0.5), gust LFO 0.09 Hz with depth x2 | 20 to 40 s | **palm rustle gusts**: `amb.palms` one-shot (pink noise band-pass 2 to 4 kHz, 1.5 to 3 s swell) every 5 to 12 s, 15 to 40 m away. **No thunder** (rule 5) |

### 8.2 Office

Baseline = the M2b indoor scene (HVAC, air rush, mains hum, fluorescent buzz, `amb.keys` typing, reverb).

| Preset | HVAC | Fluorescent buzz | Typing (`amb.keys`) | Extra layers |
|---|---|---|---|---|
| `day` (default) | baseline | baseline | 2.5 to 7 s | none. Exactly the M2b bed |
| `evening` | x0.85 (setback) | x0.9 | **8 to 18 s**, bursts of 3 to 6 keys | **photocopier**: `amb.copier` one-shot (a 2.5 s run: band-pass noise swish at 1.4 kHz chopped at 1.6 Hz, plus a soft roller hum at 95 Hz) every 25 to 50 s, 20 to 45 m away |
| `afterHours` | x0.7, with an `amb.hvacCycle` (a damper clunk at 130 Hz, then a 1.2 s air sigh) every 30 to 60 s | **x0.5, with a deeper flicker** (0.07 Hz depth x2, plus a 0.4 Hz stutter) to match the fewer lit fixtures | **one burst every 30 to 60 s** (someone still working late) | **water cooler glug**: `amb.cooler` (3 to 5 bubble bloops, sine 180 to 420 Hz rising, 70 to 120 ms apart) every 20 to 40 s, 15 to 35 m away. **Server fan whir**: a quiet steady band (pink noise band-pass 1.1 kHz, Q 2, plus a 210 Hz sine) as a bed layer at gain 0.06 |

The `lightsOut` zone theme still cuts the buzz outside the circle, on top of whichever preset is active.

### 8.3 Rules for every preset

- The **bed level** (waves + wind, or HVAC + buzz + hum) stays between -2 dB and +1.5 dB of the baseline, measured as
  RMS over 30 s of the ambience bus (§12 AC-L2). Mood comes from colour and detail one-shots, not loudness.
- New detail one-shots go on the ambience bus at priority 10 (decoration) with `maxInstances` 2. They are first to be
  stolen and duck with the ambience.
- None of them is rhythmic in the 1.5 to 3 Hz footstep range, none sits in the 3.5 to 4 kHz ear-ring or fuse-tick
  register at a matching rhythm, and none has a low thump under 100 Hz with a fast attack (explosion and
  landing territory). The cricket pulses are deliberately 4.3 kHz, quiet and irregular.

## 9. Cue table (new cues)

Priorities follow the AUDIO.md §3 classes. Remote ranges are maximum distances in metres (ref / max / rolloff).

| Cue | Bus | 2D/3D | Priority | Max inst. | Gain | Ref / max / rolloff | Pitch jitter (st) | Gain jitter (dB) | Cooldown |
|---|---|---|---|---|---|---|---|---|---|
| `melee.swing.local` | sfx | 2D | 78 | 2 | 0.6 | n/a | 0.8 | 1 | 0.05 |
| `melee.swing.remote` | sfx | 3D | 69 | 4 | 0.7 | 2 / 14 knife, 16 machete, 20 paddle (scaled in the recipe) / 1.1 | 1 | 1.5 | 0 |
| `melee.hit` | sfx | 2D local, 3D remote | 72 local 2D, 66 remote | 4 | 0.75 | 2 / 30 / 1 | 1.2 | 1.5 | 0.02 |
| `melee.knockback` | sfx | 2D victim, 3D others | 90 victim, 68 remote | 3 (keyed per victim) | 0.8 | 3 / 35 / 1 | 0.6 | 1 | 0 |
| `glass.shatter` | sfx | 3D | 73 | 3 | 0.8 | 3 / 50 / 0.9 | 1.5 | 1.5 | 0.03 |
| `shot.dbshotgun.local` | sfx | 2D | 81 | 2 | 1 | n/a | 0.5 | 1 | 0 |
| `shot.dbshotgun.remote` | sfx | 3D | 71 | 3 | 1 | 6 / 140 / 0.8 | 0.8 | 1.5 | 0 |
| `shot.revolver.local` | sfx | 2D | 80 | 2 | 0.9 | n/a | 0.6 | 1 | 0 |
| `shot.revolver.remote` | sfx | 3D | 70 | 4 | 0.95 | 6 / 150 / 0.8 | 0.8 | 1.5 | 0 |
| `rocket.launch.local` | sfx | 2D | 84 | 1 | 1 | n/a | 0.4 | 0.5 | 0 |
| `rocket.launch.remote` | sfx | 3D | 77 | 3 | 1 | 8 / 220 / 0.6 | 0.6 | 1 | 0 |
| `rocket.flyby` | sfx | 3D | 79 | 2 | 0.8 | 2 / 12 / 1 | 0.5 | 1 | 0.1 |
| (rocket in-flight emitters) | sfx | 3D bed | outside the pool, max 3 | 3 | 0.7 | 5 / 90 / 0.9 | n/a | n/a | n/a |
| `explosion.rocket` | sfx | 3D | 99 | 3 | 1 | 8 / 180 / 0.5 | 1 | 1 | 0 |
| `smoke.pin` | sfx | 3D (2D local) | 74 | 3 | 0.55 | 2 / 10 / 1.2 | 0.4 | 1 | 0 |
| `smoke.bounce` | sfx | 3D | 67 | 4 | 0.6 | 2 / 30 / 1 | 1.5 | 1.5 | 0.02 |
| `smoke.pop` | sfx | 3D | 64 | 3 | 0.7 | 4 / 60 / 0.9 | 0.6 | 1 | 0 |
| `smoke.hiss` | sfx | 3D loop | 52 | 4 | 0.4 | 3 / 35 / 1 | 0.3 | 0 | 0 |
| `pickup.level` | sfx | 2D | 61 | 1 | 0.3 | n/a | 0 | 0 | 0.1 |
| `amb.bird`, `amb.crickets`, `amb.chime`, `amb.palms`, `amb.copier`, `amb.hvacCycle`, `amb.cooler` | ambience | 3D | 10 | 2 each | 0.25 to 0.45 | 6 to 15 / 50 to 120 / 0.6 to 0.8 | 1 to 2 | 2 | 0.3 |

Existing cues gain variants: `weapon.switch`, `weapon.dryFire`, `pickup.weapon`, `pickup.grenade` (`smoke`),
`reload.start` and `reload.finish` (`dbshotgun`, `revolver`, `rpg`), `grenade.throw` (`smoke`), and the tier-4 armor
variants (§6).

**Ordering notes.**

- The frag's `grenade.bounce` (78) stays above `smoke.bounce` (67), and `grenade.pin` (76) above `smoke.pin` (74).
  When both fly at once, the lethal one wins a contested voice.
- `rocket.flyby` (79) and the rocket emitters sit above footsteps, so an incoming rocket is never masked.
- `melee.swing.remote` (69) outranks remote footsteps (65). A swing within 20 m is a more urgent threat than a step.
- `explosion.rocket` and `explosion` are separate cues, each with 3 instances. A rocket spam cannot steal every
  grenade bang, and the total stays at 6 bangs, which the limiter handles.

**Voice budget.** The global pool stays at **48**. In the worst plausible M2c moment (a final-circle fight with
2 rockets in flight, 2 smoke hisses and a dbshotgun exchange), the counted peak is about 30 pooled voices plus
3 rocket beds plus the ambience beds. If profiling shows starvation, the smoke hiss (52) and the detail one-shots (10)
are the first to go. That is intended.

## 10. Implementation plan (next round, audio only)

| File | Change |
|---|---|
| `cues.ts` | the new cue ids and defs (§9); `AUDIO_TUNING` additions: rocket emitters (3, 90 m, flyby 6 m, doppler clamp 0.78 to 1.35, effective c 343), smoke cocoon (2.5 kHz, -6 dB, +3 dB hiss), level sparkle notes, look preset tables |
| `soundMap.ts` | `shotCue` for dbshotgun/revolver (rpg returns null, voiced by `rocketFired`); `meleeHitCue` and `meleeMaterial`; `itemClass` for melee/smoke/tier-4 armor; `levelSparkle(level)`; `lookOf(mapKind, lookId)`; `explosionCue(source)` |
| `AudioDirector.ts` | handlers for `meleeSwing`, `meleeHit`, `rocketFired`, `smokeDeployed`, `glassShattered`; `kind` routing on the grenade events; skipping the `hit.remote` double-up for melee; the `hiddenBySmoke` skip; the level sparkle on `itemPickedUp` |
| `recipes.ts` | one recipe per new cue, plus the variants in §2 to §8 |
| `RocketLayers.ts` (new) | the persistent rocket emitters (§4.2), modelled on `DropLayers.ts` |
| `Ambience.ts` | per-look parameter sets for both scenes, the new detail layers, and the ambience-only cocoon filter |
| `AudioEngine.ts` | `setRockets` and `setSmokes`; the cocoon test (listener vs the cloud list); the look cross-fade; the detail one-shot timers (like gulls and keys) |
| tests | soundMap, director mappings, every new recipe against the fake context, rocket emitter doppler and cap, smoke envelope offsets, the cocoon toggle, look tables |
| `AUDIO.md` | fold this spec into §1, §3, §4, §7 and §9 once built |

## 11. What audio needs from the contract (requests to the tech-lead)

All new fields are requested as **optional**, so audio compiles and degrades gracefully in either order. The fallback
for each is given.

### 11.1 Melee (proposed new GameEvents)

```ts
/** Swing started. Local: from prediction (instant). Remote: from SimEvent meleeSwing. */
meleeSwing: {
  playerId: PlayerId; weapon: MeleeId; pos: Vec3;
  /** ms from swing start to the hit frame (balance). Audio lands the whoosh peak there. */
  windupMs: number;
  isLocal: boolean;
};
/** Hit frame resolved on the server. Not emitted on a miss (the whoosh alone means a miss). */
meleeHit: {
  attackerId: PlayerId; weapon: MeleeId;
  /** Contact point (victim chest/head, or the surface point). */
  pos: Vec3;
  surface: 'player' | 'terrain' | 'prop' | 'water' | 'glass';
  victimId: PlayerId | null;
  headshot: boolean;
  /** Paddle: the victim was knocked back (thud after balance knockbackMs). */
  knockback: boolean;
  isLocalAttacker: boolean; isLocalVictim: boolean;
};
```

- **`playerDamaged.weapon?: HeldId | null`** and **`localHitConfirmed.weapon?: HeldId | null`**: which weapon did the
  damage. Audio uses it to swap `hit.remote` for the melee contact (§2.3) and to pick the melee flavour of the armor
  layer. Fallback: `hit.remote` plays as today, so a remote melee hit may voice twice.
- **`localHitConfirmed.hiddenBySmoke?: boolean`**: the same test the UI uses to hide hit markers (§5.4). Fallback:
  confirms always play.
- `MeleeId` must be in the `WeaponId` union, as the brief fixes, so `weaponSwitched.weapon` and `itemPickedUp.item`
  already carry `knife`, `machete` and `paddle`.

### 11.2 Guns

- **`shotFired.barrels?: 1 | 2`** for `dbshotgun` (both barrels vs one). Fallback: one barrel.
- **`reloadStarted.rounds?: number`**: rounds this reload will load (dbshotgun 1 or 2 shells, revolver 1 to 6).
  Fallback: a full load (2 and 6).
- `GunId` (used by `reloadStarted` and `reloadFinished`) must include `dbshotgun`, `revolver` and `rpg`.
- No level is needed on shots (rule 3).

### 11.3 RPG

- **`rocketFired { id: RocketId; ownerId: PlayerId; pos: Vec3; vel: Vec3; isLocal: boolean }`** (brief).
- **`explosion.source?: 'grenade' | 'rocket'`**, and `explosion.id` typed to accept a `RocketId`. Fallback: every blast
  uses the grenade cue (no rocket flavour, and the in-flight loop stops on the explosion nearest to its last
  position).
- **`IAudio.setRockets?(rockets: readonly RocketView[], serverTime: number)`**, called each frame after
  `setGrenades`, with `RocketView = { id, ownerId, pos, vel }` (extrapolated like `GrenadeView`). Fallback:
  dead-reckoning from `rocketFired` (§4.2).
- **`glassShattered { pos: Vec3; cause: 'melee' | 'explosion' | 'shot' }`**, a new event when a pane breaks (a
  SimEvent echoed by ClientGame). Fallback: no shatter sound, only the contact.
- Balance read through `mapChanged.balance`: `weapons.paddle.knockbackMs` (or wherever the designer puts it), and
  the rocket `maxFlightMs` and gravity for the fallback only.

### 11.4 Smoke

- **`kind: ThrowableId`** on `grenadeCooked`, `grenadeThrown` and `grenadeBounced`, and **`GrenadeView.kind`**.
  Fallback: the director remembers `kind` per grenade id from `grenadeThrown`. Without any `kind`, smoke sounds like a
  frag (wrong intel), so this one is **required**.
- **`smokeDeployed { id: SmokeId; pos: Vec3; t: number }`** (brief), `t` in server ms.
- **`IAudio.setSmokes?(clouds: readonly SmokeCloudView[], serverTime: number)`**, each frame, with
  `SmokeCloudView = { id, pos, deployedAt, radius }` (`radius` = the current radius from the shared pure cloud-shape
  function). This covers late joiners and spectators (the loop starts at an offset) and the cocoon test. Fallback:
  only clouds seen through `smokeDeployed` play, and the cocoon uses the balance shape.
- The balance names for the cloud lifetime (grow, hold and fade ms, radius), for example `items.smoke.growMs`,
  `holdMs`, `fadeMs` and `radius`. Audio reads whatever the designer names. The hiss envelope (§5.2) needs all three
  durations.
- The sim emits **no `explosion`** for smoke.

### 11.5 Levels and looks

- **`itemPickedUp.level?: ItemLevel`** for levelled items. Fallback: no sparkle.
- `ArmorHit.tier` must allow 4 (vest_4 and helmet_4).
- **The look preset id on `mapChanged`** (`look?: LookPresetId`), or a new `matchLayoutChanged { layoutSeed, look }`
  emitted once the layout is known (vote lock, before the carrier). Audio needs it before the drop so the mood is set
  while players are aboard. Fallback: the default mood (`noon` or `day`). Audio does not compute the layout itself:
  it is a client-side view consumer and should not run the layout function.

## 12. Acceptance criteria

The tests run in node against the structural fake context (`npx vitest run src/audio`) unless marked **(ear)**, which
the user checks in a playtest.

**Melee**
- AC-M1: `meleeSwing` plays `melee.swing.local` (2D) or `.remote` (3D at `pos`) with variant = weapon. The whoosh's
  envelope peak is at `windupMs` (±10 ms, clamped to 40 to 600 ms).
- AC-M2: `meleeHit` picks the material from surface, headshot and the matching damage event's vest/helmet:
  `knife.body`, `machete.helmet`, `paddle.glass` and so on. All 3 x 8 variants build a finite voice with every node
  registered.
- AC-M3: for a remote-on-remote melee damage event (with `weapon`), `hit.remote` is **not** played; for a gun damage
  event it still is.
- AC-M4: `knockback: true` schedules the thud at `balance knockbackMs / 1000` (0.3 s without it). It is keyed
  `kb:<victimId>`, and a local victim gets the -9 dB ambience duck.
- AC-M5 **(ear)**: with eyes closed, knife, machete and paddle swings are identifiable at 10 m, and the paddle bonk
  sounds like a toy, not an injury.

**Guns**
- AC-G1: `shotFired` dbshotgun with `barrels: 2` builds a longer voice (at least 16 ms longer start-to-peak spread and
  a longer tail) than `barrels: 1`. The absent field equals 1.
- AC-G2: dbshotgun and revolver reload schedules put layers at the percentages in §3.2 and §3.4, scaled by
  `durationMs`. `rounds` changes the shell and round tick count. A cancelled reload stops the key, and no further
  layers play.
- AC-G3: `shotFired` with weapon `rpg` plays nothing; `rocketFired` plays the launch exactly once.
- AC-G4 **(ear)**: in a blind test, the dbshotgun is told apart from the Scatter Clam (ring, no pump) and the revolver
  from the Conch Pistol (lower, plus the cylinder tick).

**RPG**
- AC-R1: `setRockets` with 5 rockets in range voices only the 3 nearest. A rocket leaving the set fades within 150 ms
  plus 80 ms.
- AC-R2: the doppler ratio is above 1 for an approaching rocket and below 1 for a receding one, clamped to
  [0.78, 1.35]. A unit test covers the formula.
- AC-R3: the fly-by fires once per rocket when the closest approach is under 6 m, and never when it is over 6 m.
- AC-R4: `explosion` with `source: 'rocket'` plays `explosion.rocket` and stops that rocket's emitter in the same
  update. The ring, muffle and ducks follow `localDistance` and `radius` exactly as for frags.
- AC-R5: `update()` with live rockets allocates nothing per frame (same check as DropLayers).

**Smoke**
- AC-S1: the grenade events with `kind: 'smoke'` play `smoke.pin`, `grenade.throw`(`smoke`) and `smoke.bounce`.
  They never play `grenade.pin`, `grenade.tick` or `grenade.bounce`, and `setGrenades` never fuse-ticks a smoke.
- AC-S2: `smokeDeployed` plays `smoke.pop` plus the keyed `smoke.hiss`, whose length equals grow + hold + fade from
  balance (±50 ms). A start offset over 0.5 s skips the pop and shortens the loop by the offset.
- AC-S3: a listener inside a cloud closes the ambience cocoon filter (≤ 2.6 kHz) and ducks ambience -6 dB. The sfx
  bus filter is untouched (world muffle stays at 20 kHz). Leaving the cloud reopens it.
- AC-S4: `localHitConfirmed` with `hiddenBySmoke: true` skips the body, head and armor confirms and still plays the
  kill confirm.
- AC-S5 **(ear)**: a smoke pin and bounce is never mistaken for a frag at 8 m.

**Levels**
- AC-V1: a local `itemPickedUp` with `level` N plays `pickup.level` with exactly N notes (1 to 4). There is no
  sparkle for remote pickups, ammo, heals or a missing level.
- AC-V2: tier-4 armor variants (`vest4`, `helmet4`, and the pickups) build, and they are higher-pitched than tier 3.

**Looks and ambience**
- AC-L1: every look id (4 island, 3 office) maps to a parameter set. An unknown id falls back to `noon` or `day`. A
  look change cross-fades within `sceneFadeS` and disposes no node that is still audible.
- AC-L2: over 30 s of the offline-rendered bed (fake context with an RMS probe, or an OfflineAudioContext check), each
  preset's ambience RMS is within -2 / +1.5 dB of its scene's baseline.
- AC-L3: detail one-shots (`amb.*`) only start on their scene and look, at priority 10, within their interval ranges
  (seeded random).
- AC-L4 **(ear)**: a remote standing footstep at 20 m is clearly audible over every preset, including the
  overcast wind and the morning birds.

**General**
- AC-X1: every new cue is in `CUE_IDS`, `CUES` and `RECIPES`. Each recipe builds against the fake context with a
  finite length, all nodes registered, and all sources started and stopped.
- AC-X2: with every new optional field absent, the director still runs without throwing and uses the fallbacks
  listed in §11.
- AC-X3: no audio files are added. `npx tsc --noEmit -p .` and `npx vitest run src/audio` pass.
- AC-X4: audio imports nothing from `src/game/` or `src/render/`, and nothing in `src/shared/sim/` imports audio.
