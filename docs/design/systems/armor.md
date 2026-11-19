# System: Armor (vests and helmets, tiers 1-3 in M2a; tier 4 in M2c)

Numbers: `balance.json` `items.vest_1..3`, `items.helmet_1..3` (`{ slot, tier, durability, absorbFraction }`), `armor.dropOnDeath`,
`bots.ai.lootScoreVest / lootScoreHelmet / lootScoreArmorPerTier`. Server-authoritative.
Replaces the M1 single `vest` (`items.vest`, `player.maxArmor` and `armor.absorbFraction` are removed).

## Purpose
Armor turns loot into a power curve you can see: a castaway in a tier-3 vest and helmet is visibly tougher, which makes epic POIs worth
contesting. Splitting body and head armor creates a second decision (a helmet protects only the head, which matters most against the
DMR and sniper), and tiers give a reason to keep looting after you have "a vest".

## Player-facing rules
### Pieces
| Item | Covers | Tier | Durability | Absorb | Effective HP vs the hits it covers (full HP) |
|---|---|---|---|---|---|
| vest_1 | body hits, grenades | 1 | 35 | 30% | 135 |
| vest_2 | body hits, grenades | 2 | 55 | 40% | 155 |
| vest_3 | body hits, grenades | 3 | 75 | 50% | 175 |
| helmet_1 | head hits | 1 | 30 | 30% | 130 |
| helmet_2 | head hits | 2 | 45 | 40% | 145 |
| helmet_3 | head hits | 3 | 75 | 50% | 175 |
| vest_4 (M2c) | body hits, grenades, rockets | 4 | 100 | 55% | 200 |
| helmet_4 (M2c) | head hits | 4 | 100 | 55% | 200 |

Each player wears at most one vest and one helmet. Armor is worn on pickup, never carried in the inventory.

### Level 4 and the shared level scale (M2c)
- Armor tiers are **levels** (`levels.md`): tier N = level N, drawn with the same colour, numeral/pips and name as weapon levels. Tier 4
  is new: `vest_4` and `helmet_4` (live since balance v5), epic loot only, about 0.1 of each per match (one of them in about 1 match
  in 5; `loot.md`).
- Invariant check: 100 < 100 x 0.55 / 0.45 = 122.2. A fresh tier-4 piece adds exactly 100 effective HP.
- What tier 4 buys:
  - **helmet_4 survives one headshot from any sniper**: L1 160 - min(100, 88) = 72 HP loss; L4 192 - min(100, 105.6) = 92. (A helmet_3
    stops one headshot only from an L1-L2 sniper: L3 179.2 - 75 = 104.2 kills.)
  - **vest_4 survives an L4 rocket direct hit** (172.5 - 100 = 72.5 loss) and any frag (120 - 66 = 54 loss).
  - Body TTK at L1 vs vest_4 (threshold 200): rifle 11 shots 1.50 s, SMG 15 shots 1.12 s, pistol 10 shots 2.25 s, revolver 6 shots 2.25 s,
    DMR 5 shots 1.60 s, sniper 3 shots 2.80 s, pump 3 shots 1.80 s, double barrel 2 shells 0.25 s at point blank. Every mag still covers the
    worst case (revolver 6 = 6 exactly, pistol 12 >= 10, rifle 25 >= 11).
- Tier 4 is visibly distinct on the chibi (shape and the L4 colour), so a fight against one is a choice.
- Rockets: the impact and the blast are body damage through the vest (`rpg.md`); helmets never absorb rocket damage.

### Damage application (per damage event)
```
piece = (hit zone == head) ? helmet : vest          // grenades always use the vest; zone and fall damage use no piece
if piece exists:
    a = min(piece.durability, dmg x items[piece.id].absorbFraction)
    piece.durability -= a
    hp -= dmg - a
    if piece.durability <= 1e-6: piece is destroyed (tier 0), emit the armor-break cue
else:
    hp -= dmg
```
- Shotgun: the head-pellet sum and the body-pellet sum are applied to their pieces separately within one damage event (`combat.md`).
- Zone (`zone.ignoresArmor`) and fall damage ignore armor and do not reduce durability.
- Durability is a float; the HUD shows `ceil`.

### Effective-HP invariant (design rule for tuning)
Every piece must satisfy `durability < 100 x absorbFraction / (1 - absorbFraction)` (tier 1: < 42.9, tier 2: < 66.7, tier 3: < 100).
Then a full-HP player never dies while the covering piece still has durability, and a fresh piece adds exactly `durability` effective
HP against the hits it covers (proof in `combat.md` "Shots to kill"). This keeps armor easy to reason about: "a tier-2 vest is +55 HP
against body shots". `balance.test.ts` should assert it.

### Equipping
Pressing E on a vest or helmet pickup (slot = `items.<id>.slot`), with T = the tier you wear in that slot (0 if none) and N = the pickup's tier:
- **N > T**: wear the pickup with **its** durability (ground pieces keep their remaining durability). If T > 0, your old piece drops at your
  feet as a pickup with its remaining durability (same placement as a weapon swap drop). Event `pickup` (+ the drop's new loot entity).
- **N <= T**: refused, `actionFailed { action: 'pickup', reason: 'betterArmor' }`. The pickup stays.
- A piece at 0 durability is destroyed at once, so "yours is broken" from the brief means T = 0 and any tier is accepted.
- Picking up armor is instant and never cancels reload, heal, ADS, cooking or a stance transition.

### Death
With `armor.dropOnDeath` true, a dying player's vest and helmet (if worn, durability > 0) drop as pickups with their remaining
durability, scattered like other death drops (`combat.deathDropScatter`). This is new in M2a (M1 dropped no armor) so a won fight can
upgrade you.

### Placement tie-break
Where the GDD ranks by "HP + armor" (same-tick deaths, bot-only resolution), use `hp + vest.durability + helmet.durability`.

## States and transitions (per slot)
`None (tier 0)` -> pick up tier N -> `Worn(N, durability)` -> damage -> `Worn(N, lower)` -> durability 0 -> `None`.
`Worn(T)` -> pick up N > T -> `Worn(N, ground durability)` + old piece on the ground. Death -> `None` + drop.

## Tunable values
`items.vest_N.{tier,durability,absorbFraction}`, `items.helmet_N.*`, `armor.dropOnDeath`, loot weights in `loot.tiers`, bot scores in
`bots.ai`. Keep the invariant above and the sniper constraint in `combat.md` when tuning.
**Expected to need playtest tuning**: `vest_3.durability` (75) and `helmet_3.durability` (75; must stay > 60 for the sniper rule);
tier-1 drop rates if early fights feel too long.

## Edge cases
- Same tier, fresher piece on the ground (e.g. vest_2 at 55 while you wear vest_2 at 5): refused (brief rule). **Maybe**: allow the swap
  when the ground piece has more durability; decide after playtests.
- Two players press E on the same armor on the same tick: first input processed wins (M1 loot rule).
- An armor swap drop lands inside a prop collider: use the same placement fallback as weapon swap drops.
- The old piece dropped by a swap can be re-picked only if it is better than what you now wear (it never is), so there is no swap loop.
- A damage event that destroys the piece and kills in the same hit emits both the armor-break cue and the kill.
- Dropping (parachute) players cannot be hit, so their armor is never touched.
- Grenade damage on a player with a helmet only: the helmet is ignored and the full amount hits HP.

## What the UI must show
- Two equipment icons next to the HP bar: vest and helmet, each with the tier numeral (1-4; M2c: the shared level colours of `levels.md`
  replace the M2a white / blue / gold) and a
  durability bar `ceil(durability) / items.<id>.durability`. Empty slot = dim outline.
- Pickup prompt names the tier and durability for armor: "[E] Vest (Lv 2) 31/55". Refusal prompt "Better armor equipped".
- Hit markers: a distinct marker variant when your hit was absorbed by a vest vs a helmet; an armor-break flash on the target.
- Remote players: drawn with their `vestTier` and `helmetTier` (graphics), so you can judge a target before engaging.
- The HUD no longer uses `player.maxArmor`.

## What audio and VFX feedback is needed
- Hit sounds (attacker and victim): vest hit (fabric/plate clink, pitch rises with tier), helmet hit (hollow "tonk"), separate break
  sounds for vest and helmet.
- VFX: a small shard burst on armor break at the piece's position (chest or head); the piece disappears from the chibi.
- Equip sound on pickup (velcro for vests, strap click for helmets).
- Art: three visually distinct tiers per piece readable at 30 m (shape and colour, not only colour).

## Network
`PlayerState` gains `vestTier` and `helmetTier` (0-3) and drops `armor`. `LocalPlayerState` gains `vest: {tier, durability} | null`
and `helmet: {tier, durability} | null`. `LootState` gains `durability?` for armor pickups. The `damage` event must let clients tell
which piece absorbed and whether it broke: per piece before/after durability (e.g. `vestBefore/vestAfter/helmetBefore/helmetAfter`) -
exact shape is the tech-lead's call.

## Bots
Bots value an armor pickup at `(lootScoreVest or lootScoreHelmet) + lootScoreArmorPerTier x tier` when it would be accepted, otherwise 0.
They pick up and wear better armor the same way humans do.

## Acceptance tests (QA)
1. vest_2 at 55, body hit 30: a = 12, hp 82, vest 43. Body hit 100: a = min(43, 40) = 40, hp 22, vest 3. Body hit 10: a = min(3, 4) = 3,
   hp 15, vest destroyed (vestTier 0) and the damage event shows the break.
2. A head hit never changes vest durability; a body hit never changes helmet durability.
3. Zone damage (4/s for 3 s) and a fall-damage landing leave vest and helmet durability unchanged.
4. Grenade damage 50 on a target with vest_1 (35) and helmet_3 (75): a = 15, hp 65, vest 20, helmet 75.
5. Wearing vest_1 at 20, pick up vest_2 (55): wearing vest_2 at 55, and a vest_1 pickup with durability 20 is at the feet.
6. Wearing vest_2 at 1, pick up vest_1: refused `betterArmor`, nothing changes. Wearing vest_2 at 10, pick up a fresh vest_2: refused.
7. No helmet, pick up a helmet_1 dropped at 12 durability: wearing helmet_1 at 12.
8. Death while wearing vest_2 at 30 and helmet_1 at 30: two armor pickups with durability 30 are dropped. A destroyed piece drops nothing.
9. Remote snapshots carry `vestTier` / `helmetTier`; only the owner's snapshot carries durability values.
10. Rifle body hits (19, <= 30 m) on a full-HP vest_3 player: after 9 hits hp = 100 - (171 - 75) = 4; the 10th hit kills.
11. `balance.test`: every vest_N and helmet_N satisfies `durability < 100 x f / (1 - f)` and `tier` matches the id suffix.
12. Placement tie-break: two players die on the same tick; the one with the higher hp + vest + helmet durability at the start of the tick
    places better.

M2c (tier 4):
13. vest_4 at 100, body hit 50: a = min(100, 27.5) = 27.5, hp 77.5, vest 72.5.
14. Sniper L1 headshot on a fresh helmet_4: hp 28, helmet 12. Sniper L4 headshot on a fresh helmet_4: hp 8, helmet destroyed.
15. Wearing vest_3 at 10, pick up vest_4: wearing vest_4 at 100, a vest_3 pickup at 10 at the feet. Wearing vest_4 at 5, pick up a fresh
    vest_3: refused `betterArmor`.
16. Rifle L1 body hits (19, <= 30 m) on a fresh vest_4: after 10 hits hp = 100 - (190 - 100) = 10; the 11th kills.
17. Snapshot `vestTier` / `helmetTier` accept 0-4; the HUD and the world model show tier 4 with its numeral.
18. vest_4 and helmet_4 never come from common or rare tables (10,000 rolls each).
