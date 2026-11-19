# System: Smoke Grenade (M2c)

Numbers: `balance.json` `items.smoke` (throw and physics keys, `cloud.*`), `bots.smoke`, `bots.personalities.*.smokeChanceMultiplier`
(live). Server-authoritative and deterministic. Slot rules: `grenades.md` "Throwable slot". Related: `combat.md`,
`scopes.md`, `rpg.md`.
Scope tags: **M2c**, **Later**, **Maybe**.

## Purpose
A way out, and a way in. Smoke lets a player who is losing a fight break line of sight to heal or run, lets a rotation cross open beach
under fire, and lets an attacker cover a push. It deals no damage, so it is purely a decision tool. Counterplay is built in: bullets
still pass through smoke, tracers show where shooters are, a frag thrown into the cloud still kills, and the cloud is on a clock.

## Player-facing rules
### Carrying and throwing
- Item `smoke` (ThrowableId), `maxCarry` 2, loot stacks of `spawnQty` 2. It shares the throwable slot (slot 3, key 4 / G) with frags;
  each type has its own stack (`grenades.md`).
- **Not cookable** (`cookable` false). Press LMB: the arc preview shows (same as frags) with a landing ring of the cloud radius; nothing is
  consumed. Release: the canister is thrown with the frag throw formula and physics (`grenades.md`) using `items.smoke.*`; the count
  drops by 1 at release; `throwRecoveryMs` follows. The fuse (`fuseMs` 1800) starts at release.
- Switching away while holding LMB with smoke cancels the throw (nothing consumed, nothing dropped). Death while holding: nothing is
  thrown; carried smokes drop as one stack.
- Flight, bounces, rest and water behave exactly like a frag (`grenadeBounce` events). Players are not colliders.

### The cloud
- At fuse end the canister is removed and a cloud is created: event `smokeDeployed {id, ownerId, pos, t}` (`pos` = the deploy point;
  in water, the point at y = 0 above it).
- Shape: a sphere centred `cloud.centerHeight` (1.2 m) above `pos`. Opaque radius over time (t = ms since deploy):

| Phase | Time | Opaque radius |
|---|---|---|
| Grow | 0-1500 ms | 6.5 x t / 1500 |
| Hold | 1.5-19.5 s | 6.5 m |
| Fade | 19.5-22.5 s | 6.5 x (1 - (t - 19500) / 3000) |
| Gone | 22.5 s | removed |

  The cloud is a pure function of `(pos, t)`; clients need no per-tick data. At ground level the hold-phase cloud covers a disc of radius
  sqrt(6.5^2 - 1.2^2) = 6.39 m, enough to hide 4-6 chibis.
- `cloud.maxActive` (12): when a 13th cloud deploys, the oldest one starts its fade at once (perf and readability guard; expected ~4.6
  smokes per match, so this almost never triggers).
- Clouds ignore walls in the sim (a sphere). Visually they are clipped by walls and glass indoors (graphics-engineer).

### What smoke blocks
- **Vision (client)**: a dense cel-shaded volume. Inside it you see almost nothing beyond `cloud.closeSightRange` (2 m). Name tags,
  hit markers and hit sounds on targets you cannot see, and the spectate outline, are hidden when the segment from your eye to the
  target's head and chest both pass through an opaque cloud (same pure function, current time), unless the two points are closer than
  `closeSightRange`. ADS and scopes do not see through.
- **Kill marker**: the kill hit marker (red X) and kill sound **are shown** even through smoke. The kill feed reveals the kill anyway, so
  hiding it would only feel broken.
- **Bot sight (sim)**: every bot line-of-sight test treats each live cloud as an opaque sphere of its current radius (segment vs sphere),
  except between points closer than `closeSightRange`.
- **Not blocked**: bullets (shooting into smoke still hits), melee, rockets, grenade flight and blast damage, damage-direction arcs (the
  victim still sees where damage came from), tracers and muzzle flashes (drawn over the smoke, so shooters inside give themselves away),
  sound, the minimap.
- Smoke never damages, never slows, never affects the zone, and is not affected by the zone.

## States and transitions
Slot: see `grenades.md` (`Ready` -> LMB held `Aiming` -> release `Thrown` -> `Recovery` -> `Ready`; `Aiming` -> swap / death -> cancelled).
Canister: `Flying` -> `Resting` -> fuse 0 -> cloud. Cloud: `Growing` -> `Holding` -> `Fading` -> removed (or forced to `Fading` by
`maxActive`). Match end removes canisters and clouds.

## Tunable values
`items.smoke.*` (throw and physics keys as `items.grenade`, plus `maxCarry`, `spawnQty`, `cookable`, `fuseMs`),
`items.smoke.cloud.{radius, centerHeight, growMs, holdMs, fadeMs, closeSightRange, maxActive}`, `bots.smoke.*`,
`bots.personalities.*.smokeChanceMultiplier`, loot weights. Types (tech-lead): split today's GrenadeBalance into shared throw/physics
keys plus a frag-only blast block and a smoke-only cloud block.
**Expected to need playtest tuning**: `holdMs` (18 s), `radius` (6.5), `maxCarry` (2), loot weights, whether hiding hit sounds feels fair.

## Edge cases
- A cloud deployed while the canister is still flying (thrown far, short bounce): deploys where the canister is at fuse end, even in the
  air (the sphere is then partly above head height; fine).
- A cloud on a desk top (office): centred 1.2 m above the plateau; players below the desk are mostly outside it.
- Two clouds overlap: each blocks independently; there is no density sum.
- A player inside the cloud shooting out: hits normally; their tracer and flash show their position to everyone.
- A frag thrown into the cloud: explodes normally; blast line of sight ignores smoke.
- Spectating a player inside smoke: the spectator sees what that player sees (first person) or the chase view (the cloud is drawn).
- Late joiners and spectators: the server sends every live cloud `{id, pos, t}` in the welcome or snapshot, so they draw it correctly.
- Bots inside a cloud: they see only within 2 m; an enemy who is 1.5 m away is visible to them (melee range).

## What the UI must show (ui-ux-designer)
Throwable slot icon shows the selected type and its count, plus a small count of the other type (`grenades.md`). Arc preview with a
landing ring of the cloud radius (6.5 m). No danger indicator for smoke. While inside a cloud: no special HUD, just the view. Name tags
and markers follow the hiding rule above.

## What audio and VFX feedback is needed
- Audio: pin/tab click on release, throw whoosh, canister clinks, a hiss on deploy (positional, ~40 m) that stays as a soft loop while
  the cloud holds and fades out with it, muffling of nothing (sounds pass through smoke).
- VFX: canister model (a cute coconut-shell or bottle smoke pot; art call), a few puffs at deploy, then a dense cel-shaded cloud volume
  that matches the opaque radius curve (the visible edge must match the sim radius within about 0.5 m, so what you see is what bots
  "see"). Island: pale sea-mist colour; office: grey-white. Must stay inside the office draw-call budget (one cloud = a few draw calls).

## Network (for tech-lead and network-engineer)
`ThrowableId += 'smoke'`. Canister uses the grenade entity list and events (`grenadeThrown`, `grenadeBounce`) with a type field. Cloud:
event `smokeDeployed {id, ownerId, pos, t}`; live clouds in the welcome/late-join state. Nothing per tick. Inventory: per-type throwable
counts and the selected type (local). Input: no new field (LMB, slot 3, the 4/G cycle).

## Bots (numbers in `bots.smoke`)
- Line of sight: clouds are opaque (above). A target that vanishes into smoke is lost after `bots.loseTargetMs` as today; bots do not
  spray into smoke (Later).
- Throw (quick throw, no cook, at most once per `cooldownMs` 15 s), at the point `throwDistance` (4 m) from the bot toward the attacker:
  - on entering **Retreat** (GDD bot state 3) with probability `retreatThrowChance` (0.6) x `smokeChanceMultiplier`;
  - while **escaping the zone** after taking damage in the last `recentDamageMs` (3 s), with probability `zoneCrossThrowChance` (0.4) x
    `smokeChanceMultiplier`.
- Personalities: aggressive 0.5, balanced 1, cautious 1.5. Loot score `lootScoreSmoke` (14) while below `maxCarry`.
- Bots never throw smoke offensively in M2c (Later: smoke a push).

## Acceptance tests (QA, Vitest on src/shared/sim unless noted)
1. Throw at pitch 0 standing on flat ground: speed 15.0, launch pitch 8 deg, first contact at 8.0 +- 0.5 m (same as the frag).
2. Not cookable: holding LMB for 5 s does nothing (count unchanged, no entity); releasing throws; the cloud deploys 1800 ms after release
   (+-1 tick).
3. Cancel: hold LMB, press 1: no entity, smoke count unchanged.
4. Radius: `smokeDeployed` at t0; the opaque radius is 0 at t0, 3.25 at t0 + 750, 6.5 at t0 + 1500 and t0 + 19500, 3.25 at t0 + 21000,
   and the cloud is gone at t0 + 22500.
5. Bot LOS: a bot and a target 20 m apart on flat ground, cloud at the midpoint during hold: the bot cannot see the target. Cloud 7 m off
   the line: it can. Both inside the same cloud 1.5 m apart: it can (closeSightRange 2). 3 m apart: it cannot.
6. Bullets: a rifle shot through a holding cloud hits a target behind it for full damage.
7. Grenade: a frag exploding inside the cloud damages a player 3 m away (79.5 unarmored).
8. `maxActive`: deploying 13 clouds makes the oldest enter its fade at once (gone 3 s later).
9. Water: a smoke thrown into 0.6 m deep water deploys with `pos.y` = 0.
10. Late join: a client joining 10 s after a deploy receives the cloud and draws it at full radius.
11. Client (unit or e2e): with a target behind a holding cloud, the name tag is hidden; a body hit marker on that target is not shown;
    a kill marker is shown; a victim inside the cloud still gets the damage-direction arc toward the shooter.
12. Bots (seeded, chance forced to 1): a bot entering Retreat with a smoke throws it within one decision tick toward its attacker and the
    cloud deploys between them (within 3 m of the 4 m point on flat ground).
13. Death while carrying 2 smokes and 1 frag: two stacks drop (smoke x2, grenade x1).
14. Determinism: same seed and inputs give identical canister paths and deploy ticks.

## Affected agents
tech-lead (ThrowableId, balance type split, cloud entity, events), game-developer (smoke throw, cloud function, bot LOS, bot throws),
network-engineer (smokeDeployed, late-join clouds), ui-ux-designer (throwable slot, hiding rules), graphics-designer and graphics-engineer
(canister, cloud volume, budget), audio-designer (hiss loop), narrative-designer (name, prompts), qa-tester.
