# ADR 0007: M2c: per-match layouts, item levels, melee, rockets, smoke, scopes and the snapshot budget

- Status: Accepted. **C-gate done 2026-11-18** (§10).
- Date: 2026-11-18
- Owner: tech-lead
- Related: [ARCHITECTURE.md](../tech/ARCHITECTURE.md) §16 (build contract, C-gate checklist, build plan),
  [ADR 0004](0004-m2a-stance-ads-grenades-armor.md) (grenade blast, ADS), [ADR 0005](0005-m2b-maps-indoor-office-and-carrier-drop.md)
  (map union, prepareMap, C-gate method), [ADR 0006](0006-m2b-rooms.md) (lock, World per match).
  Specs: `docs/design/systems/{levels,melee,rpg,smoke,scopes,layout}.md`, the M2c parts of `combat/loot/armor/grenades/maps.md`,
  `docs/design/levels/variety.md`, `docs/art/M2c.md`, `docs/ui/M2c.md` (§12, §14, §16.8), `docs/audio/M2c.md` (§11),
  `docs/narrative/M2c.md`, `balance.json` `_m2cPending`.

## Context
M2c adds five things at once: a different layout every match on both maps, levels 1-4 on weapons and armor, melee
weapons in slot 2, a rocket launcher with a sim projectile, and a smoke grenade with a cloud that blocks sight. Mid-design
the user also asked for scope attachments. Each one touches the sim, the wire, render, UI and audio.

Three constraints shape the contract:
- **Determinism across engines.** The layout is generated on the server (V8) and in every browser, and colliding props
  must match bit for bit. `Math.sin/cos/hypot` are not exactly specified in JavaScript.
- **The snapshot budget.** The worst-case full snapshot was 8,134 B against an 8,192 B budget (58 B headroom). M2c adds
  per-player fields, rockets, clouds and broken glass.
- **A green tree during the build.** QA is still running M2a/M2b tests. The M2b C-gate method worked, so it is reused.

Contract code for this ADR: [`types.ts`](../../src/shared/types.ts) (M2c section),
[`contracts.ts`](../../src/shared/contracts.ts), [`events.ts`](../../src/shared/events.ts),
[`balance.ts`](../../src/shared/balance.ts) (types, validator, effective stats), and four new pure modules:
[`detmath.ts`](../../src/shared/detmath.ts), [`layout.ts`](../../src/shared/layout.ts),
[`smoke.ts`](../../src/shared/smoke.ts), [`rocket.ts`](../../src/shared/rocket.ts), plus `glassPanes` in
[`maps.ts`](../../src/shared/maps.ts). Tests: [`m2c.test.ts`](../../src/shared/m2c.test.ts).

## Decision

### 1. Per-match layout (`MatchLayout`)
1. **Shape.** `MatchLayout { version, mapId, seed, picks, look, props, lootSpawns, hash, fallbacks, decor, lightsOn? }`
   in `types.ts`, as the level-designer proposed (variety.md §8) plus `fallbacks`. `LootSpawn` gains `group?` and
   `guarantee?: 'weapon'`. Placements gain a render-only `variant?` (art). `DecorPlacement.kind` is a string that keys
   a render decor table; a level test asserts every kind the generator can emit exists in that table.
2. **Where the generator lives.** `src/game/levels/layout/` (level-designer): `buildMatchLayout(base, seed, opts?:
   { decor?: boolean })`, `applyLayout(base, layout): AnyMapData` (props and lootSpawns replaced; same type), and a
   cheap `pickVariants(base, seed): LayoutPick[]` for repeat avoidance. It may import `src/shared/*.ts` and the variety
   JSON only. The sim never imports it: the World receives the applied map.
3. **Seeds.** `worldSeed = mixSeed(roomSeed, matchSerial)` (as today). `layoutSeed = layoutSeedFor(worldSeed, attempt)`
   = `mixSeed(worldSeed, LAYOUT_SALT + attempt)`, never 0. Seed 0 = the baseline layout; only `LAYOUT_SEED=baseline`
   or `0` selects it. Streams: `streamSeed(layoutSeed, name)`. `LAYOUT_SEED` (server env) and `?layoutSeed=` (offline
   preview only) use `parseLayoutSeed`. A pin is never re-rolled.
4. **Determinism rules** (`detmath.ts`, owned by tech-lead). Decisions use only `+ - * /`, comparisons, `Math.sqrt`,
   `Math.round/floor`, `Math.imul`, and the helpers: `detSin/detCos(step)` read a 1024-step table built at load from a
   fixed Taylor polynomial with `+` and `*` only (identical on every engine; within 1e-15 of `Math.sin`);
   `radToStep/degToStep/stepToRad`; `roundMm/roundMrad` applied before any check reads a value; `fnv1a32`, `mixSeed`
   (identical to `server/common.ts`), `streamSeed`. Arbitrary angles (level data at module load, `wallFrame`):
   `sinRad/cosRad/atanDet/atan2Det/hypot2` (Cody-Waite reduction plus the same polynomials; `Math.atan2` signed zeros;
   added at the final review, moved from `src/game/levels/detTrig.ts`). No iteration over objects with numeric-like keys; arrays in data
   order. Golden values in `m2c.test.ts` pin the table, the hash and the mixer.
5. **Hash and transport.** (`LAYOUT_FORMAT_VERSION` history: 1 at launch; 2 for BUG-015, which added an
   `ep.perchSW` candidate and moved office seed `0x00000001`. Any data or generator change that alters an existing
   seed's output bumps it.) `layoutHash(props, lootSpawns)` (`layout.ts`) = FNV-1a 32 over the canonical integer string
   (`kind,x_mm,y_mm,z_mm,rot_mrad,scale_cm;` per prop, then `x_mm,y_mm|-,z_mm,tier,guarantee|-;` per loot point).
   Variants, decor and the look are not hashed. Nothing about props goes on the wire. At the vote lock the server sends
   `WelcomeInfo.layout = { seed, version, hash, look }` (also to mid-match joiners) and `RoomState.map.layout = { seed,
   look }` (waiting-room card). The client builds the layout itself (`ClientGameDeps.buildLayout`), then:
   - version or hash mismatch: **throws in dev and tests**; in production logs seed, version and both hashes and
     continues (director decision).
   - emits `mapChanged` on every welcome whose `(mapId, seed)` differs, with the **applied** map, `layout` and `look`.
     Render, UI and audio rebuild from it every match (the look is known before the carrier: audio §11.5).
6. **Repeat avoidance** (director decision). At the lock the server compares `pickVariants` of attempt 0 with the
   previous match's picks in the same room on the same map (`countRepeatedPicks`). More than half repeated: try
   attempts 1..8 and keep the first at or under half, else the fewest repeats (ties: lowest attempt). Only the final
   seed is sent.
7. **Per-match `prepareMap` and nav.** `prepareMap(appliedMap, balance)` runs at the lock, during the 3 s before the
   carrier. Server cache key `${mapId}:${seed}:${LAYOUT_FORMAT_VERSION}`, LRU of 4 (a `LAYOUT_SEED` pin always hits).
   The client caches only the current and previous runtime. The server logs `layoutMs` and `navMs` per match and warns
   above 250 ms. The build is synchronous and blocks the event loop of every room for that time. That is accepted for
   M2c (one stall per match start, ≤ 250 ms target). If the measured server p95 exceeds 150 ms, the next step is a
   `worker_threads` build (network-engineer), not a smaller nav.
8. **Look presets** (`LookId`: island `morning|noon|golden|overcast`, office `day|evening|afterHours`; `noon`/`day` =
   today) are cosmetic: no sim reads them. The pick weights stay in the level data (game-designer confirmed).

### 2. Item levels
- `ItemLevel = 1|2|3|4`. Weapons carry it per instance (`WeaponSlotState.level`, `MeleeSlotState.level`,
  `LootState.level`, `RocketState.level`). Armor's level is its id suffix; `ArmorTier` becomes `ItemLevel` at the gate.
- **One stat rule, in shared code:** `effectiveWeapon(balance, id, level, scope)` in `balance.ts` applies
  `levels.overrides.<id>`, else the class default (`levels.gun` / `levels.melee`), else 1, to damage, reloadMs,
  fireIntervalMs (melee: also hitFrameMs) and spreadDeg. `rocketBlastMaxDamage(balance, level)` scales the rocket blast.
  The sim, client prediction, HUD and bots all call it (cache per `(id, level, scope)` on hot paths).
- Remotes see the held level as `PlayerState.weaponLevel` (field block `PlayerM2cFields`). `damage` and `kill` events
  carry `weapon` and `weaponLevel`; `pickup` carries `level`.
- `WeaponSlotState.level` and `.scope` **stay optional after the gate** (absent = L1, built-in sight). The sim always
  writes them; fixtures do not have to.

### 3. Melee
- `MeleeId = knife|machete|paddle` ⊂ `WeaponId` (after the gate); `GunId` then excludes fists and melee. Slot 2 is the
  melee slot (`MELEE_SLOT` = `FISTS_SLOT` = 2); `LocalM2cFields.melee: { weapon, level } | null` (null = fists).
- Balance: `MeleeBalance = WeaponBalance & { hitFrameMs, sweepRadius, knockbackSpeed, knockbackLift }`; validated
  sight 'none', ammo null, magSize 0, `0 < hitFrameMs < fireIntervalMs`.
- Timing is events, not per-tick state: `meleeSwing { playerId, weapon, level, pos, hitAt, cycleMs }` at the click
  (remotes animate the wind-up from it; late joiners miss at most one swing), `meleeHit` when the hit check finds
  anything, then `damage` with **cause `melee`** (armor like `weapon`: vest body, helmet head). The owner predicts its
  own swing (viewmodel, `HudLocalView.meleeRecovery`) and ignores the echo.
- Knockback is server velocity on the victim. Its own client reconciles it (the snapshot `movement.vel` carries it).

### 4. Rockets
- `RocketState { id, ownerId, level, pos, vel, firedAt }` is the **immutable launch record**. Position at any time is
  the closed form `rocketPosAt` (`rocket.ts`): `p0 + v0·s − ½·g·s²` on y. The sim samples it at each tick time and
  sweeps the segment between samples (terrain, water, props, intact glass, edge, players except the owner), so
  server and client agree exactly and no per-tick rocket data exists.
- Events: `rocketFired` (= the record; replaces `shot` for the rpg), `rocketDud`, `glassBroken`, `damage` cause
  `rocket` (impact, body zone, vest absorbs), then the shared blast. The blast model is extracted from the grenade into
  one function used by both (`BlastBalance`: flat on `items.grenade`, nested at `weapons.rpg.rocket.blast`).
  `explosion` gains `source: 'grenade'|'rocket'`, `direct?`, `airburst?`. Emit order per rocket on its tick:
  `glassBroken`, `damage(rocket)`, `explosion`, `damage(explosion)`…, `kill`s. A kill carries `direct: true` when the
  rocket struck that victim.
- **One id space** per World for grenades, rockets and smoke clouds (a cloud keeps its canister's id). Same-tick
  resolution is by id ascending across kinds (rpg.md edge cases).

### 5. Scopes
- `ScopeId`, `SightType += 'scope_2x'` (gate). Per gun instance `scope: ScopeId | null`; per player
  `LocalM2cFields.spareScope` (pouch of 1) and `scopeSwapRemainingMs`.
- Effective ADS numbers come from `effectiveWeapon`. The movement step reads them through the new optional
  `MovementInput.adsSpec { sight, adsTimeMs, adsMoveMultiplier }` filled by `toMovementInput` on both sides, so ADS
  prediction keeps matching the server with a scope mounted.
- `PlayerState.sight` = the **effective** sight of the held item (remote scope model and glint). `isScopeSight`
  (4x/8x) stays the glint and bot "scoped" rule; `hasScopeOverlay` (2x/4x/8x) is the Ui overlay rule.
  `localAdsChanged.sight` is the effective sight.
- Input: `PlayerInput.cycleScope?` edge (T; stays optional, absent = false). `UiCallbacks.onCycleScope` and
  `IClientGame.cycleScope` latch the same edge from a chip click.
- `FailedAction += 'scope'`; `ActionFailReason += 'scopePouchFull' | 'scopeCantFit' | 'scopeNoneFits'`
  (`scopePouchFull` is the director's name; the Ui draft's `scopeStashFull` is superseded). The HUD keeps the Ui's
  field names `scopeStash` / `scopeStashMax`.
- `scopeChanged { playerId, slot, gun, from, to, auto, pos }` is public (positional click). It also answers the Ui's
  "stable per-slot identity" ask: no per-slot uid is needed.

### 6. Smoke, throwable slot
- `ThrowableId += 'smoke'` (gate). `GrenadeState.kind` and `kind` on `grenadeCook/Thrown/Bounce` (required at the gate;
  audio needs it). The canister uses the grenade list and `stepGrenade` with `items.smoke` throw keys
  (`ThrowableBalance`, shared with the frag).
- Carry: frags stay in `LocalPlayerState.grenades`; smoke in `LocalM2cFields.smokes`; `selectedThrowable` persists.
  Cycling is the existing `selectSlot = 3` edge while slot 3 is active and ready; it costs `combat.throwableCycleMs`
  through `swapRemainingMs`. No new input field. ClientGame predicts the selection (`throwableSelected`,
  `throwableCycled`).
- Cloud: `SmokeCloudState { id, ownerId, pos, deployedAt, fadeAt }` (immutable except a forced earlier `fadeAt`).
  Its shape is the pure `smokeRadiusAt` (`smoke.ts`). Event `smokeDeployed` (= the record).
- **One visibility rule**: `segmentBlockedBySmoke(clouds, from, to, t, cfg)` and `pointInSmoke` in `src/shared/smoke.ts`
  (tech-lead), used by bots (sim), ClientGame (`HudView.inSmoke`, `localHitConfirmed.obscured`,
  `PlayerView.smokeHidden`) and audio/render through `SmokeCloudView`. It lives in `src/shared/` rather than
  `src/shared/sim/` so render, UI and audio may import it under the §3 dependency rules.

### 7. Glass panes
- `glassPanes(map)` (`maps.ts`) gives every breakable pane a `PaneId` in a fixed order: glass walls in `walls` order,
  then glass kit parts in prop and collider order (props are per layout, so ids are per match, the same on both sides).
  No glass WALL pane wider than `GLASS_PANE_MAX_WIDTH` (8.1 m): the level-designer splits the office glass runs.
  **Glass kit parts are exempt** (decided at the C-gate): a kit part is one door-sized piece of its prop, e.g. the
  phone-booth door at 9.54 m (office x9 scale = a 1.06 m real door), so breaking it never opens more than that prop. No
  art change.
- State: `WorldSnapshot.brokenPanes: PaneId[]` (grows only). Melee centre-ray hits and rocket contacts break a pane;
  bullets and grenades never do. A broken pane's colliders are skipped by movement, raycasts, grenade flight and blast
  line of sight from that tick on, **in client prediction too** (the movement context takes the broken set from the
  snapshot). Bot nav keeps treating it as a wall (designer: simplest); bot sight uses the current state.
- Event `glassBroken { paneId, pos, byId, cause }` (the GameEvent of the same name is audio's `glassShattered`).

### 8. Events and views requested by UI, audio and art
All are in `events.ts` / `contracts.ts`, optional until the gate unless listed in §10 as P2-optional:
- GameEvents: `meleeSwing`, `meleeHit`, `rocketFired`, `rocketDud`, `smokeDeployed`, `glassBroken`, `scopeChanged`,
  `throwableCycled`; payload additions `playerDamaged.weapon/weaponLevel`, `localHitConfirmed.weapon/weaponLevel/
  obscured`, `playerKilled.weaponLevel/direct/throughSmoke(P2)`, `itemPickedUp.level/scope`, `reloadStarted.rounds`,
  `weaponSwitched.level`, `grenade*.kind`, `explosion.source/direct/airburst`, `interactPromptChanged.level/scope/
  replacesSlot/scopeTarget`, `mapChanged.layout/look`.
- Views: `HudSlotView.level/scope/sight/builtInSight/compatibleScopes` (index 3's `weapon` = the selected throwable);
  `HudLocalView.weaponLevel/throwables/throwableMax/throwableSelected/meleeRecovery/scopeStash/scopeStashMax/
  scopeSwapProgress`; `HudCookView.throwable`; `HudView.inSmoke/layout/lootPeek(P2)`, `spectate.weapon/weaponLevel(P2)`;
  `HudMinimapView.layout` (and `map` is the applied map); `RoomView.lockedLayout`; `FrameView.rockets/smokes/
  brokenPanes/look`; `PlayerView.smokeHidden/swing`; `GrenadeView.kind`; `ViewmodelView.level/sight/hitFraction` and
  actions `swing`, `scopeSwap`, `cycle`; `IAudio.setRockets/setSmokes`; `ClientGameDeps.buildLayout`.
- Not added: `shotFired.barrels` (the dbshotgun fires one barrel per click, so it is always 1); an incoming-rocket HUD
  warning (UI decision); per-level 3D models (out of scope; the art collar, tint and pips are the plan).

### 9. Snapshot budget: compact rows on the wire
**Decision: keep the 8 KB budget and make room with a compact row encoding plus immutable entity records.** Measured
with the M2a worst-case method (`encodeQuantized`, full format, no loot, long names, 3-decimal coordinates):

| Scenario | Today's object format | Rows (this decision) | Wire (deflate, rows) |
|---|---|---|---|
| 16 players, 10 grenades, M2c fields, no rockets or clouds | 9,135 B (over) | 4,609 B | 1.5 KB |
| 16 players, 10 grenades, 8 rockets, 12 clouds, 12 broken panes | 11,575 B | 5,781 B | 1.8 KB |
| 24 players, 10 grenades, 8 rockets, 12 clouds | 14,491 B | 6,913 B | 2.0 KB |
| **24 players, 16 grenades, 16 rockets, 12 clouds (worst case)** | 16,579 B | **7,843 B** | 2.2 KB |

(`match.maxPlayers` is 16 today; 24 is the director's headroom case.) The rules (network-engineer implements, in
`src/shared/protocol/`):
1. **Rows for full-format entity lists.** A full-format `PlayerState` becomes a JSON array in a fixed column order
   (about 139 B instead of 328 B): `id, name, x, y, z, velY, yaw, pitch, hp, vestTier, helmetTier, alive(0/1), weapon,
   weaponLevel(0 = null), sight, stance, stanceFrom, stanceProgress, anim(mask), skin, outfit, hair, isBot(0/1), kills,
   aboard(0/1), dropPhase(0/1/2)`. Grenades, rockets and clouds are rows too (`[id, ownerId, x, y, z, vx, vy, vz,
   explodesAt, inWater, kind]`, `[id, ownerId, level, x, y, z, vx, vy, vz, firedAt]`, `[id, ownerId, x, y, z,
   deployedAt, fadeAt]`). The column order is protocol: append only, bump `PROTOCOL_VERSION`. Delta **patches stay
   keyed objects** (they carry only changed fields). Decoding turns rows back into objects before validation, so
   in-memory types and every consumer are unchanged.
2. **No per-tick data for immutable things.** `rockets`, `smokes` and `brokenPanes` are omitted from a delta snapshot
   while equal to the base (the M2b `route` rule); a change sends the whole list. A rocket's path is its launch record;
   a cloud's shape is a function of time.
   **Record deltas (added after the review, REVIEW-M2c SF4).** A changed `rockets` or `smokes` list may instead ride as
   `rocketsDelta` / `smokesDelta` = `RecordDelta<T> { add: T[]; remove: number[] }` (`protocol/messages.ts`): `add`
   holds the records that are new or changed by value (a forced early fade replaces a cloud record), `remove` the ids
   that left. The encoder (`diffRecords`, `protocol/delta.ts`) uses it only when fewer records are added than the
   whole list holds; otherwise it sends the list. Rules: delta snapshots only; never together with the whole list in
   the same snapshot (both refused by the shape check); `add` uses rows for CAP_ROWS sessions like the lists. The
   decoder (`applyRecords`) applies it to the carried base list and returns the list sorted by id; a `remove` of an id
   that is not in the base fails the snapshot and triggers a resync. `brokenPanes` (grow-only ids) is always whole.
   Budget test: 16 players moving and aiming on the tick a 16th rocket fires < 4,096 B (`protocol/m2c.test.ts`).
3. **Melee swings are events only** (`meleeSwing`), not a `PlayerState` field or anim bit.
4. M2c per-player wire cost is two row columns (`weaponLevel`, `sight`).
5. **Budget tests** (network-engineer, replacing the M2a/M2b worst cases): the 24-player worst case above < 8,192 B; the
   16-player M2b worst case < 6,500 B; the worst-case delta snapshot < 4,096 B. `server/tools/measure-snapshot.ts`
   reports rows vs objects.

Rejected: raising the budget (the full snapshot is rare, but it also bounds stringify time and the resync spike, and
rows fix it for good); short key aliases (saves about 90 B per player, not enough for 24 players); interest culling
(changes what spectators, the minimap and the kill feed can know; not needed now); binary encoding (bigger change;
still the next step after rows if needed).

### 10. Migration: optional now, C-gate later
Same method as ADR 0005 §1. Today every M2c field is optional or lives in a field block, and every new union member
lives in an `M2c*` addition type, so `npx tsc --noEmit -p .` and `npx vitest run` stay green. New code targets the
`M2c*` names (`M2cWeaponId`, `M2cGunId`, `M2cHeldId`, `M2cItemId`, `M2cSightType`…), which compile before and after
the flip. At the C-gate tech-lead flips, in one commit:
- unions: `WeaponId += MeleeId | 'dbshotgun' | 'revolver' | 'rpg'`; `GunId` excludes fists and melee; `AmmoId +=
  'ammo_rocket'`; `ThrowableId += 'smoke'`; `VestId/HelmetId += _4`; `ArmorTier = ItemLevel`; `ItemId += MeleeId |
  ScopeId` (+ the new guns, ammo, armor, smoke through their unions); `SightType += 'scope_2x'`; `DeathCause += 'melee' |
  'rocket'`; `FailedAction += 'scope'`; `ActionFailReason +=` the three scope reasons; `SimEvent += M2cSimEvent`; the id
  lists and `ARMOR_PIECES` widen;
- blocks: `PlayerState extends PlayerM2cFields`, `LocalPlayerState extends LocalM2cFields` (required);
- required: `GrenadeState.kind`, `WorldSnapshot.rockets/smokes/brokenPanes`, `WelcomeInfo.layout`, `kind` on the
  `grenadeCook/Thrown/Bounce` SimEvents and GameEvents, `explosion.source` (SimEvent and GameEvent; network-engineer
  asked: the decoder requires them, so a producer omitting them would be dropped), `playerKilled.weaponLevel`, `interactPromptChanged.level`, `mapChanged.layout/look`, `FrameView.rockets/
  smokes/brokenPanes/look`, `HudView.inSmoke/layout`, the `HudSlotView` and `HudLocalView` M2c fields,
  `HudMinimapView.layout`, `GrenadeView.kind`;
- `M2C_BALANCE_REQUIRED = true` (the M2c balance blocks become required; the merged balance passes it, tested in the
  trial); `PROTOCOL_VERSION = 4`.
- Stay optional for good: `WeaponSlotState.level/scope`, `LootState.level/scope`, `PlayerInput.cycleScope`, the P2 view
  fields, `explosion.direct/airburst`, `kill.direct`, `reloadStart.rounds`.

**Done 2026-11-18.** Besides the list above the gate also: widened `ITEM_IDS` (melee and scope ids), made the M2c
`Balance` blocks required in the type (`levels`, `scopes`, `layout`, `loot.guaranteedWeapon`, `items.smoke`,
`combat.throwableCycleMs`, `bots.melee/rpg/smoke/scopes`, the melee and rpg weapon entries), and wired `main.ts`
(`buildLayout`, `onCycleScope`, `setRockets`, `setSmokes`). Residue: 10 errors in game-developer test fixtures
(SimEvent literals without `kind` / `source`), ARCHITECTURE §16.2.

**Trial flip (2026-11-18, in a scratch copy): 126 tsc errors in 38 files, none in `tests/`.** The per-owner checklist
is ARCHITECTURE.md §16.2. The gate is **early** this time: the new weapons cannot exist in typed state before the
unions widen, so the gate comes after a short "gate prep" round and before the feature build (§16.5).

### 11. Balance validator
`validateBalance` accepts the live file and the file with `_m2cPending` merged (both tested). New rules: melee sight
'none' / ammo null / magSize 0 / hitFrameMs; rpg mag 1 and the rocket and blast blocks; armor tier 4 (`M2C_ARMOR_PIECES`);
`GrenadeBalance = ThrowableBalance & BlastBalance`, `SmokeBalance = ThrowableBalance & { cloud }`; `levels` (arrays of
4, L1 exactly 1, [0.5, 2], known fields, no fists override, loot weights); `scopes` (ScopeIds, never the built-in sight,
guns only, zoom ≥ 1, factors > 0, unique ranks); `layout`; `loot.guaranteedWeapon`; `bots.melee/rpg/smoke/scopes`;
`smokeChanceMultiplier`; new ids in loot tiers, `weaponPrefs` and `fpRecoil`. `OPEN_RECORD_PATHS` adds
`loot.guaranteedWeapon.weights`, `levels.overrides`, `scopes.compatible`, `clientFeel.fpRecoil`.

**The merge happens in two steps.** Step 1 (now): every new key and block. Step 2 (after the sim spawns and handles the
new items): `loot.tiers.*`, `maps.office.loot.tiers.*` and `bots.eagernessCurve`. Merging the tier tables early would
make today's sim spawn items that today's protocol rejects.

## Consequences
- Builders work in parallel against one contract. The early gate costs one short prep round (126 errors, mostly
  fixtures and exhaustive tables).
- The layout is reproducible from one integer, and a desync is detected (hash) instead of silently playing on different
  maps. The cost: the generator must follow the determinism rules, which tests check (golden hashes, server-vs-client
  builds in LV1).
- The office nav is rebuilt every match: up to about 250 ms of server stall per match start, measured and logged.
- Rows make the wire less readable in devtools; the decoder and `measure-snapshot.ts` keep it inspectable.
- `src/shared/` gains four small pure modules; dependency rules do not change (they are `src/shared/*.ts`).

## Alternatives considered
- **Sending the prop list** instead of the seed: simpler, but 20-60 KB per match start and still needs the same
  generator for previews. Rejected by the brief.
- **Using `Math.sin` with rounding** in the generator: rounding does not make a 1-ulp difference safe at a threshold.
  Rejected for the table.
- **Rockets as per-tick snapshot entities** like grenades: about 150 B per rocket per snapshot; grenades need it because
  they bounce, rockets do not.
- **Smoke as an anim/state field** or a per-tick radius: needless; the shape is a function of time.
- **A late gate** as in M2b: the feature work would need casts everywhere a new weapon id enters typed state.
