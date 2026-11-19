# System: Scope Attachments (M2c, Addendum 1)

Numbers: `balance.json` `scopes.*` and `bots.scopes.*` (live), loot weights in
`loot.tiers`. Server-authoritative: what is mounted where, the spare stash, effective ADS values. Related: `combat.md` (ADS, spread),
`camera.md` (ADS view, overlay, sensitivity), `loot.md`, `levels.md`.
Scope tags: **M2c**, **Later**, **Maybe**. Only scopes; other attachments stay out of scope.

## Purpose
Let a player shape a gun for the fight they expect: a 2x on the SMG for mid-range, a 4x on the rifle to hold a ridge, a red dot on the
DMR for close fights in the office. Every scope is a trade: more zoom and a slightly tighter cone, but a slower aim-in, a slower ADS walk
and a narrower view. A gun's built-in sight never gets worse, so finding nothing is never a loss.

## Player-facing rules
### Items
`ScopeId` = `scope_red_dot | scope_2x | scope_4x | scope_8x`, giving the sight types `red_dot`, `scope_2x` (new), `scope_4x`, `scope_8x`.
Ground pickups, qty 1, **no level**, neutral glow. Every gun keeps its built-in **default sight** (`weapons.<id>.sight`); a mounted scope
replaces it until removed.

### Compatibility (`scopes.compatible`; the default sight is never listed)
| Gun | Default sight | Accepts |
|---|---|---|
| Pistol, Revolver, Shotgun | iron | red dot |
| SMG | iron | red dot, 2x |
| Double barrel | iron | none (a close-range gun stays simple) |
| Rifle, LMG | red dot | 2x, 4x |
| DMR | 4x | red dot, 2x, 8x |
| Sniper | 8x | 4x |
| RPG, melee, fists | - | none |

### What a scope changes (only while ADS)
- **Zoom** = `scopes.<id>.zoom` (red dot 1.5, 2x 2, 4x 4, 8x 8), replacing `weapons.<id>.adsZoom`. Same true-magnification camera,
  sensitivity scaling and overlay rules as today (`camera.md`), keyed by the sight type.
- **ADS time, ADS spread multiplier and ADS move multiplier** = the gun's base value x `sightFactors[mounted].x / sightFactors[default].x`.

| Sight | rank | adsTime | adsSpread | adsMove | View |
|---|---|---|---|---|---|
| iron | 0 | 1.0 | 1.0 | 1.0 | iron post on the viewmodel |
| red_dot | 1 | 1.0 | 0.95 | 1.0 | dot on the viewmodel sight |
| scope_2x | 2 | 1.2 | 0.9 | 0.95 | full-screen overlay (new 2x reticle) |
| scope_4x | 3 | 1.5 | 0.8 | 0.85 | full-screen overlay + scope glint |
| scope_8x | 4 | 1.9 | 0.75 | 0.75 | full-screen overlay + scope glint |

Hip fire, damage, range and falloff never change. Scope glint (remote players) shows for an effective 4x or 8x sight, default or mounted;
never for 2x or red dot.

Resulting ADS values (still, standing, L1; cone = spreadDeg x adsSpread; "body to" = d at which a 0.45 m body fills the cone, ~26 / cone):

| Gun + sight | ADS time | ADS cone | ADS move | Zoom | Body to |
|---|---|---|---|---|---|
| Pistol iron (default) / red dot | 150 / 150 ms | 0.90 / 0.855 deg | 0.85 / 0.85 | 1.25 / 1.5 | 29 / 30 m |
| Revolver iron / red dot | 170 / 170 | 0.60 / 0.57 | 0.85 | 1.3 / 1.5 | 43 / 46 m |
| SMG iron / red dot / 2x | 170 / 170 / 204 | 1.95 / 1.85 / 1.76 | 0.8 / 0.8 / 0.76 | 1.25 / 1.5 / 2 | 13 / 14 / 15 m |
| Shotgun iron / red dot | 200 / 200 | 5.95 / 5.65 | 0.8 | 1.2 / 1.5 | - |
| Rifle red dot / 2x / 4x | 230 / 276 / 345 | 0.80 / 0.76 / 0.67 | 0.65 / 0.62 / 0.55 | 1.6 / 2 / 4 | 33 / 34 / 39 m |
| LMG red dot / 2x / 4x | 350 / 420 / 525 | 1.17 / 1.11 / 0.99 | 0.5 / 0.475 / 0.425 | 1.5 / 2 / 4 | 22 / 23 / 26 m |
| DMR red dot / 2x / 4x / 8x | 200 / 240 / 300 / 380 | 0.356 / 0.338 / 0.30 / 0.281 | 0.59 / 0.56 / 0.5 / 0.44 | 1.5 / 2 / 4 / 8 | 73 / 77 / 87 / 92 m |
| Sniper 4x / 8x | 316 / 400 | 0.128 / 0.12 | 0.45 / 0.4 | 4 / 8 | 203 / 217 m |

Reading it: scopes add 5-20% reach to a gun's accurate range, not a new role. A 4x rifle is still a rifle (cone 0.67 deg, falloff from
30 m), not a DMR (0.30 deg, 42 damage). The real gain is seeing the target: 4x makes a 60 m chibi four times bigger. A red dot on the
DMR or a 4x on the sniper is a close-quarters choice (faster aim-in) that costs a little cone. Bold choices only, no strict upgrades
except red dot over iron (same speed, 5% tighter, more zoom), which is the common, low-value scope.

### Mounting, the scope pouch and the T key
- **A mounted scope stays on its gun**: it travels with the gun when dropped (death, swap, upgrade swap) and comes with it on pickup.
  Ground gun pickups carry `scope` (null = default sight). Loot spawns guns with no scope (Maybe: pre-scoped epic guns).
- **Scope pouch: one shared spare slot** (`scopes.spareSlots` 1; the UI's `scopeStashMax` = 1), holding any one scope. Chosen over
  one-per-type because it keeps the HUD to a single chip and T to a simple toggle.
- **Picking up a scope (E)**, first rule that applies:
  1. The **held** gun accepts it and its current sight (mounted, else default) has a **lower rank**: mount it there.
  2. Else the **other** gun accepts it with a lower current rank: mount it there.
  3. Else the pouch is empty: put it in the pouch.
  4. Else: refused, `actionFailed { action: 'pickup', reason: 'scopePouchFull' }` ("Scope pouch full!"; the UI's blocked prompt). The
     scope stays on the ground. (To make room, mount the spare with T, or swap it.)
  A scope displaced by rule 1 or 2 goes into the pouch if it is empty, else drops at your feet (it is never lost silently; the drop is
  the result of your E press, and the prompt says "-> Rifle (4x to the ground)" in that case).
  Prompt names the outcome: "-> Rifle", "-> SMG (2)", "-> Pouch", "Fits: DMR, Sniper" (UI §16.3).
- **T (new key): switch sight on the held gun.** While holding a gun (slot 0 or 1), not aiming: the gun's sight cycles through
  mounted scope -> each pouch scope that fits -> built-in sight (= remove; the scope goes into the pouch) -> around. "Built-in" is skipped
  when the pouch is full, so a scope is never lost. With a one-scope pouch this reduces to:
  - pouch scope fits the held gun: exchange (mounted scope, or none, goes into the pouch);
  - pouch empty and a scope mounted: remove it to the pouch (built-in sight again);
  - refusals (`actionFailed { action: 'scope', reason }`): the held item accepts no scope at all (fists, melee, throwables, RPG,
    double barrel) -> `scopeCantFit`; nothing mounted and nothing in the pouch fits -> `scopeNoneFits`; a scope is mounted and the pouch
    holds one that does not fit -> `scopePouchFull`.
  - **Timed**: `scopes.swapMs` (600 ms). Same blocks as a weapon swap: no fire, no ADS, cancels reload and heal; not allowed during a
    stance transition, while dropping or while cooking. T while ADS is ignored (no toast; leave ADS first). The sight state is predicted
    on the client for the HUD; the sim applies the change at the end of the 600 ms.
- **Death**: guns drop with their scopes; the pouch scope drops as a scope pickup.
- Touch: tap the active slot's sight chip (UI §16.4). Gamepad (Maybe): D-pad down.

## States and transitions
Per gun instance: `scope: ScopeId | null`. Per player: `spareScope: ScopeId | null`.
`Gun(default)` -> pickup (rule 1/2) -> `Gun(s)`; `Gun(s)` <-> T <-> `Gun(pouch scope)` (exchange, `swapMs`); `Gun(s)` + empty pouch
-> T -> `Gun(default)` + pouch `s`; death -> ground gun keeps `s`, pouch scope -> ground pickup.

## Tunable values
`scopes.<scopeId>.{sight, zoom}`, `scopes.sightFactors.<sight>.{rank, adsTime, adsSpread, adsMove}`, `scopes.compatible.<gunId>`,
`scopes.spareSlots`, `scopes.swapMs`, `bots.scopes.*`, loot weights. Validation (tech-lead): every compatible list holds ScopeIds whose sight
differs from that gun's default sight; zoom >= 1; factors > 0; ranks unique; `sightFactors` covers every SightType except none.
**Expected to need playtest tuning**: `scope_4x.adsTime` 1.5 and `adsMove` 0.85 (does a 4x rifle feel worth it?), 2x loot weight, the
rifle's compatibility with 4x (cut it if the rifle share climbs above 30%).

## Edge cases
- Upgrade swap (`levels.md`) to a higher-level copy of your gun: the old gun keeps its scope and drops with it; the new one comes with
  whatever it carries. Players who want the scope move it by hand (T to put it in the pouch first, then T on the new gun).
- Rail fit (art spec `docs/art/M2c.md` §14.2): 4x and 8x mount footprints fit only rifle, LMG, DMR and sniper rails. The compatibility
  lists respect this (4x: rifle, LMG, sniper; 8x: DMR). Any future list change must keep it; the art test asserts it.
- Picking up a 4x while holding a DMR (4x default, rank 3) and carrying an SMG: not better for the DMR, not compatible with the SMG -> spare.
- Picking up a red dot while holding a rifle (red dot default): rule 1 fails (rank equal and not compatible), so the other gun or the spare.
- Two identical guns, one scoped: separate instances; each keeps its own scope.
- RMB pressed during a T swap: ADS starts from 0 when the swap ends (same as a weapon swap). T pressed while aiming is ignored.
- Smoke (`smoke.md`): no scope sees through smoke.
- A scope on a gun in the other slot keeps working when you switch to it (the swap does not touch scopes).

## What the UI must show (ui-ux-designer; keep it tiny)
As `docs/ui/M2c.md` §16 (agreed): a sight chip on each gun slot, a pouch chip (max 1 spare) next to the slots, "[T] Switch sight",
pickup prompts naming the target ("-> Rifle", "-> Pouch", blocked "Scope pouch full!"), refusal toasts for `scopeCantFit`,
`scopeNoneFits`, `scopePouchFull`, and the timed variant: a "Mounting..." chip with the reload ring for `scopes.swapMs`. New 2x overlay
reticle (simpler than the 4x).

## What audio and VFX feedback is needed
- Graphics: four scope models that mount on each compatible gun model (viewmodel and world model), a red-dot reticle on the viewmodel
  for guns with an iron default, the 2x overlay, glint unchanged (4x/8x).
- Audio: scope pickup click, a mount/unmount "snap" (local, and positional ~10 m), scope-in lens sound for 2x/4x/8x (existing for 4x/8x).

## Network (for tech-lead and network-engineer)
`ScopeId` type and `SightType += 'scope_2x'`. `PlayerState` carries the held gun's **effective sight** (others draw the scope and the
glint). Local slots carry `scope`; `LocalPlayerState` carries `spareScope`. Ground gun pickups carry `scope`. New input action
`cycleScope` (T). New `actionFailed` action `scope` with reasons `scopeCantFit`, `scopeNoneFits`, `scopePouchFull` (the last also for
pickups). Helpers: overlay = 2x/4x/8x; glint and
bot "scoped" = 4x/8x (split today's `isScopeSight`).

## Bots (numbers in `bots.scopes`)
- Pick up a scope (score `lootScoreScope`) only when it would auto-mount (rule 1 or 2); never stash, never press T.
- Range bands: while a gun has a **mounted** scope, its `weaponPrefs.maxRange` x `mountedMaxRangeMultiplier[scope]` (rifle with 4x: 45 x
  1.35 = 61 m). Default sights x1.
- ADS: scope_2x behaves like red_dot/iron in the `bots.ads` rule (ADS beyond `bots.ads.minRange`); scope_4x and scope_8x as today
  (always ADS, `scopedFireMinProgress`, `scopedVisionRange`), default or mounted.

## Acceptance tests (QA, Vitest on src/shared/sim)
1. Defaults unchanged: for every gun with no scope mounted, effective adsZoom, adsTimeMs, adsSpreadMultiplier and adsMoveMultiplier equal
   `weapons.<id>`.
2. Rifle + 4x: zoom 4, adsTimeMs 345, still ADS cone 0.674 deg (+-0.001), ADS walk speed 5 x 0.5525 = 2.76 m/s.
3. DMR + red dot: adsTimeMs 200, ADS cone 0.356 deg; DMR + 8x: 380 ms, 0.281 deg. Sniper + 4x: 315.8 ms (+-0.1), zoom 4.
4. Hip cone and damage are identical with and without a scope (rifle hip still 1.6 deg; body 19 at 10 m).
5. Pickup rules: holding a rifle (default red dot) with an SMG in the other slot, E on a 2x: mounted on the rifle. E on a second 2x: the
   rifle has a 2x (rank equal), the SMG accepts 2x with rank 0 -> mounted on the SMG. E on a 4x: mounted on the rifle; the rifle's 2x goes
   to the empty pouch. E on a red dot: the rifle does not accept it, the SMG's 2x outranks it, the pouch is full -> refused
   `scopePouchFull`, the red dot stays on the ground.
6. Holding a DMR, E on a 4x: not mounted (rank equal), goes to the pouch.
7. T: rifle with 4x, pouch 2x: after 600 ms the rifle has the 2x and the pouch holds the 4x; no shot can fire during the 600 ms; T again
   swaps back (built-in is skipped while the pouch is full). Rifle with 4x, pouch empty: T removes the 4x to the pouch, the rifle is back
   on its red dot. Rifle with nothing mounted and an 8x in the pouch: refused `scopeNoneFits`. Rifle with a 4x and an 8x in the pouch:
   refused `scopePouchFull`. T with a knife or the RPG: refused `scopeCantFit`. T while ADS: nothing happens.
8. Travel: drop (death) a rifle with a 4x and pick it up again: the 4x is still mounted; the spare scope dropped as its own pickup.
9. Snapshot: a remote player holding a 4x rifle reports sight `scope_4x`; at full ADS other clients draw the glint. With a 2x: no glint.
10. Loot: 10,000 rolls per tier match the scope weights within 2 points; common never yields 2x/4x/8x; 8x only from epic.
11. Bots (seeded): a bot with a rifle walks to a nearby 4x and mounts it; it then engages a target at 55 m with the rifle (band 8-61 m);
    a bot never picks up a scope that would only go to the spare.
12. Validation: `scopes.compatible.rifle` containing `scope_red_dot` (the default) or an unknown id fails `validateBalance`.

## Affected agents
tech-lead (ScopeId, SightType scope_2x, effective-sight resolution, validation, helpers), game-developer (mounting, pouch, T swap, bots),
network-engineer (scope fields, effective sight, input, reasons), ui-ux-designer (slot scope icons, pouch chip, prompts, 2x overlay, T
hint), graphics-designer and graphics-engineer (scope models per gun, red dot reticle, 2x overlay), audio-designer (snap, lens),
narrative-designer (scope names, prompts, refusals), qa-tester.
