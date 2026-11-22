/**
 * Core shared types. Owner: tech-lead. Pure types plus a few readonly id lists.
 * Imported by sim, server, net, game, render, ui and audio. Never import anything non-shared here.
 *
 * Conventions (see docs/tech/ARCHITECTURE.md):
 * - Units: metres, Y up, sea level y = 0. Angles in radians unless a name ends in `Deg`.
 * - Yaw 0 looks toward -Z. Forward = (-sin(yaw), 0, -cos(yaw)), right = (cos(yaw), 0, -sin(yaw)).
 *   Pitch > 0 looks up. Same convention as Three.js `rotation.y`.
 * - Durations: `dt` is seconds; anything named `...Ms` is milliseconds; `serverTime`/`...At` are server-clock ms.
 * - Everything here is plain JSON-serialisable data (no classes, no Maps, no undefined in arrays).
 */

// ---------------------------------------------------------------------------------------------
// Map data. M2b (ADR 0005): a discriminated union on `kind`. The island fields are the M1 brief's, unchanged.
// MapData is never sent on the wire (clients and server look it up by id with getMap), so it may hold larger tables.
// ---------------------------------------------------------------------------------------------
export type Vec2 = { x: number; z: number };
export type PropKind = 'palm' | 'rock' | 'bush' | 'crate' | 'hut' | 'dock' | 'umbrella' | 'boat' | 'tikiTorch' | 'driftwood' | 'grass';
export interface PropPlacement {
  kind: PropKind;
  x: number;
  z: number;
  rotY: number;
  scale: number;
  /**
   * M2c (ADR 0007 §1.2; art M2c.md §9): render-only geometry or colourway variant with the SAME collider (umbrella
   * colours, crate dressings, rock facets). Seed-derived by the layout generator from a client-layer stream; never
   * read by the sim and not part of the layout hash. Absent = 0.
   */
  variant?: number;
}
export type LootTier = 'common' | 'rare' | 'epic';

/** M2b: which geometry model a map uses. 'island' = M1 heightfield + sea; 'indoor' = flat floor, walls, prop kit. */
export type MapKind = 'island' | 'indoor';
export const MAP_KINDS: readonly MapKind[] = ['island', 'indoor'];

/**
 * M2b: a loot spawn. `y` (optional) is the support height hint for spawns on raised tops (office desk plateaus): the
 * sim places the item on the highest walkable top at or below y + stepHeight (groundHeightAt with feetY = y). Absent =
 * the ground (terrain or floor).
 */
export interface LootSpawn {
  x: number;
  z: number;
  tier: LootTier;
  y?: number;
  /** M2c (ADR 0007 §1): the layout loot group this activated point came from ('beach.g07', 'gw.nw'). Logs and tests. */
  group?: string;
  /**
   * M2c (layout.md rule 2, loot.md "Guaranteed weapons"): 'weapon' = always spawns (spawnChance 1) one gun from
   * `loot.guaranteedWeapon` at a level from its `levels` table, plus the normal extra ammo. Counts as a common point.
   */
  guarantee?: 'weapon';
}
export interface MapPoi { id: string; nameKey: string; x: number; z: number; radius: number }

/** Fields every map kind has. */
export interface MapBase {
  id: string;
  /** String key in en.json (`map.<id>.name`). */
  nameKey: string;
  /**
   * M2b: no longer used for the match start (the carrier drop replaces it, ADR 0005 §8). Kept as level data for
   * fallback placement (a dev/test World option, bot nav reachability tests) and for level-design review.
   */
  playerSpawns: Vec2[];
  lootSpawns: LootSpawn[];
  /** Candidate final-circle centres. */
  zoneCenters: Vec2[];
  pois: MapPoi[];
  /** M2b: which carrier model flies the drop route (render/audio only; route numbers are balance `drop.*`). */
  carrier: CarrierModel;
}

/** The M1 island (docs/design/levels/island.md). */
export interface IslandMapData extends MapBase {
  kind: 'island';
  islandRadius: number;         // where sand meets sea level (y=0), metres from origin
  worldRadius: number;          // hard boundary, out in shallow water
  baseHeight: number;           // terrain height near island centre before hills
  beachWidth: number;           // width of sand band inside islandRadius (grass inland of it)
  shoreNoise: { amplitude: number; frequency: number; seed: number }; // makes coastline irregular
  hills: { x: number; z: number; radius: number; height: number }[];
  props: PropPlacement[];
}

/** M2b: axis-aligned rectangle on the XZ plane, metres. min < max. */
export interface Rect { minX: number; minZ: number; maxX: number; maxZ: number }

/** M2b: indoor floor finish. Footstep and landing sound, decals. Gameplay-neutral. */
export type FloorMaterial = 'wood' | 'carpet' | 'tile';
export const FLOOR_MATERIALS: readonly FloorMaterial[] = ['wood', 'carpet', 'tile'];

/**
 * M2b: wall material. Both are solid in the sim (block movement, bullets, grenades, blast LOS and bot sight;
 * maps.md 2.5). 'glass' only changes rendering (see-through), the impact surface ('glass') and its sound.
 */
export type WallMaterial = 'solid' | 'glass';

/**
 * M2b: one straight wall, a box prism from (x1, z1) to (x2, z2) along its centre line, `thickness` across, spanning
 * y in [bottom, top]. Doorways are gaps between segments. A lintel over a doorway is a segment with bottom > 0.
 */
export interface WallSegment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  thickness: number;
  /** 0 for a floor-standing wall. */
  bottom: number;
  top: number;
  material: WallMaterial;
}

/** M2b: a floor finish area. Later entries win where zones overlap; outside every zone the floor's own material. */
export interface FloorZone extends Rect { material: FloorMaterial }

/**
 * M2b: an indoor prop. `kind` is a key of the map's `kit` (validated by validateIndoorMap). Position is the kit
 * entry's origin (floor centre, surface centre, wall back face or ceiling top; see PropKitEntry.origin), `y` is that
 * origin's height (0 on the floor, the desk-top height for 'surface' props on a desk). Uniform `scale` (1 = as authored).
 */
export interface IndoorPropPlacement {
  kind: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
  /** M2c: render-only variant with the same collider (see PropPlacement.variant). */
  variant?: number;
}

/** M2b: [x, y, z] in metres (kit data is authored as tuples, like src/render/procedural/office.ts). */
export type KitV3 = readonly [number, number, number];

/**
 * M2b: one collider part of a kit entry, at scale 1 and rotY 0, relative to the prop origin. The sim turns boxes and
 * cylinders into prisms (vertical extrusions with a flat top and a bottom) and a ramp into a stair of flat boxes with
 * rises <= 0.8 x movement.stepHeight (ADR 0005 §3). `glass` parts are solid with impact surface 'glass'.
 */
export type KitCollider =
  /** Box (min/max corners), axis-aligned before the placement's rotY. */
  | { type: 'box'; name: string; min: KitV3; max: KitV3; glass?: boolean }
  /** Vertical cylinder at (x, z) from y0 to y1. */
  | { type: 'cylinder'; name: string; x: number; z: number; r: number; y0: number; y1: number }
  /** Ramp over min..max: the walkable top rises from min.y at z = max.z to max.y at z = min.z (climbs toward -Z). */
  | { type: 'ramp'; name: string; min: KitV3; max: KitV3 };

/** M2b: collision and placement data of one indoor prop kind (pure data; no three.js). */
export interface PropKitEntry {
  origin: 'floor' | 'surface' | 'wall' | 'ceiling';
  /** Footprint width (x), height (y) and depth (z) at scale 1 (render culling, minimap, nav). */
  size: KitV3;
  /** Empty = visual only (no collision, never blocks shots or sight). */
  colliders: readonly KitCollider[];
}
export type PropKit = Readonly<Record<string, PropKitEntry>>;

/**
 * M2b: a climb route from a lower walkable surface to a higher one (office desk plateaus). Waypoints in order from the
 * bottom; consecutive rises are <= movement.stepHeight (walk) or <= 0.95 m (jump; maps.md 2.4). Bots follow them
 * (nav graph climb links); level tests check them.
 */
export interface ClimbRoute {
  id: string;
  points: Vec3[];
  /** office.md 4.3: 'walk' (every rise <= stepHeight, ramps) or 'jump'. Informational; bots derive jumps from rises. */
  mode?: 'walk' | 'jump';
  /** office.md 4.3: plateau label (tests, debug views). */
  plateau?: string;
}

/** M2b: an indoor level (docs/design/levels/office.md). Flat floor at y = 0, no water, no heightfield. */
export interface IndoorMapData extends MapBase {
  kind: 'indoor';
  /** The walkable floor rectangle. Movement and grenades are bounded by it (the outer walls are also colliders). */
  floor: Rect;
  /** Floor finish outside every floorZones entry. */
  floorMaterial: FloorMaterial;
  floorZones: FloorZone[];
  /** Shots and grenades stop at this height (grenades bounce with normal -Y). Renderer draws nothing above it. */
  ceilingHeight: number;
  walls: WallSegment[];
  props: IndoorPropPlacement[];
  /** Collider and placement table for `props[].kind` (the level module sets it, e.g. the office kit). */
  kit: PropKit;
  climbRoutes: ClimbRoute[];
}

/**
 * M2b (ADR 0005 §1): every map. Branch on `map.kind` (or `isIndoor` in maps.ts); never read island-only fields
 * without narrowing.
 */
export type AnyMapData = IslandMapData | IndoorMapData;
/** M2b C-gate (2026-11-18): MapData is the union. `AnyMapData` stays as a synonym. */
export type MapData = AnyMapData;

/** M2b: carrier model of the drop (art and audio pick their model and engine loop from it). */
export type CarrierModel = 'seaplane' | 'drone';

// ---------------------------------------------------------------------------------------------
// Basics and ids
// ---------------------------------------------------------------------------------------------
export interface Vec3 { x: number; y: number; z: number }

/** Assigned by the sim (`World.addPlayer` for humans, internally for bots). Positive integer, unique per server run. */
export type PlayerId = number;
/** Assigned by the sim. Positive integer, unique per match. */
export type LootId = number;

/** M2a (ADR 0004): adds 'lmg' | 'dmr' | 'sniper'. Every WeaponId has a `balance.weapons.<id>` entry. */
export type WeaponId = 'fists' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'lmg' | 'dmr' | 'sniper' | 'knife' | 'machete' | 'paddle' | 'dbshotgun' | 'revolver' | 'rpg';
/** Weapons that occupy a slot and can lie on the ground (everything except fists). */
export type GunId = Exclude<WeaponId, 'fists' | 'knife' | 'machete' | 'paddle'>;
/** M2a: adds 'ammo_sniper' (sniper only). */
export type AmmoId = 'ammo_light' | 'ammo_heavy' | 'ammo_shell' | 'ammo_sniper' | 'ammo_rocket';
export type HealId = 'bandage' | 'medkit';
/** M2a: armor is two worn pieces, each tier 1-3 (systems/armor.md). The M1 id 'vest' is gone. */
export type VestId = 'vest_1' | 'vest_2' | 'vest_3' | 'vest_4';
export type HelmetId = 'helmet_1' | 'helmet_2' | 'helmet_3' | 'helmet_4';
export type ArmorId = VestId | HelmetId;
/** Which worn piece an ArmorId fills. Equals `balance.items.<id>.slot` (validated). */
export type ArmorSlot = 'vest' | 'helmet';
/** Equals `balance.items.<id>.tier` and the id suffix (validated). */
export type ArmorTier = 1 | 2 | 3 | 4;
/** 0 = no piece worn (snapshot `vestTier` / `helmetTier`). */
export type ArmorTierOrNone = 0 | ArmorTier;
/** M2a: the frag grenade. Stackable item; held in slot GRENADE_SLOT; numbers in `balance.items.grenade`. */
export type ThrowableId = 'grenade' | 'smoke';
/** Anything that can exist as a ground loot item. Fists never appear as loot. */
export type ItemId = GunId | 'knife' | 'machete' | 'paddle' | AmmoId | HealId | ArmorId | ThrowableId | 'scope_red_dot' | 'scope_2x' | 'scope_4x' | 'scope_8x';
/**
 * M2a: what a player holds in hand. A WeaponId for slots 0-2, 'grenade' for slot 3. Used by PlayerState.weapon,
 * weaponSwitch and kill events (kill feed weapon 'grenade'). `balance.weapons` is keyed by WeaponId only, so code
 * must narrow (`held !== 'grenade'`) before indexing it.
 */
export type HeldId = WeaponId | ThrowableId;
/**
 * M2a: weapon sight (`balance.weapons.<id>.sight`, validated). Fists 'none'; every gun has a real sight.
 * The grenade slot behaves as 'none' (no ADS). src/render/procedural/weapons.ts keeps its own mirror of the gun
 * sights for model anchors; gameplay and camera code read the sight from Balance.
 */
export type SightType = 'none' | 'iron' | 'red_dot' | 'scope_2x' | 'scope_4x' | 'scope_8x';
/** M2a: player stance (systems/stance.md). */
export type Stance = 'stand' | 'crouch' | 'prone';
/** M2a: edge request from the C (crouch) and Z (prone) keys. Space stays the `jump` edge (the step interprets it). */
export type StanceRequest = 'crouch' | 'prone';
/** M2a: keys of `balance.movement.stances.transitionMs`, `<from>_<to>`. */
export type StanceTransitionKey =
  | 'stand_crouch' | 'stand_prone' | 'crouch_stand' | 'crouch_prone' | 'prone_stand' | 'prone_crouch';

export const WEAPON_IDS: readonly WeaponId[] = ['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper', 'knife', 'machete', 'paddle', 'dbshotgun', 'revolver', 'rpg'];
export const GUN_IDS: readonly GunId[] = ['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper', 'dbshotgun', 'revolver', 'rpg'];
export const AMMO_IDS: readonly AmmoId[] = ['ammo_light', 'ammo_heavy', 'ammo_shell', 'ammo_sniper', 'ammo_rocket'];
export const HEAL_IDS: readonly HealId[] = ['bandage', 'medkit'];
export const VEST_IDS: readonly VestId[] = ['vest_1', 'vest_2', 'vest_3', 'vest_4'];
export const HELMET_IDS: readonly HelmetId[] = ['helmet_1', 'helmet_2', 'helmet_3', 'helmet_4'];
export const ARMOR_IDS: readonly ArmorId[] = [...VEST_IDS, ...HELMET_IDS];
export const THROWABLE_IDS: readonly ThrowableId[] = ['grenade', 'smoke'];
/** M2c gate: melee ids and scope ids are items too (literals here: MELEE_IDS / SCOPE_IDS are declared below). */
export const ITEM_IDS: readonly ItemId[] = [
  ...GUN_IDS, 'knife', 'machete', 'paddle', ...AMMO_IDS, ...HEAL_IDS, ...ARMOR_IDS, ...THROWABLE_IDS,
  'scope_red_dot', 'scope_2x', 'scope_4x', 'scope_8x',
];
export const SIGHT_TYPES: readonly SightType[] = ['none', 'iron', 'red_dot', 'scope_2x', 'scope_4x', 'scope_8x'];
export const STANCES: readonly Stance[] = ['stand', 'crouch', 'prone'];
export const STANCE_TRANSITION_KEYS: readonly StanceTransitionKey[] = [
  'stand_crouch', 'stand_prone', 'crouch_stand', 'crouch_prone', 'prone_stand', 'prone_crouch',
];

/** M2a: slot and tier encoded by an ArmorId (pure id data, not tuning). */
export const ARMOR_PIECES: Readonly<Record<ArmorId, { slot: ArmorSlot; tier: ArmorTier }>> = {
  vest_1: { slot: 'vest', tier: 1 },
  vest_2: { slot: 'vest', tier: 2 },
  vest_3: { slot: 'vest', tier: 3 },
  helmet_1: { slot: 'helmet', tier: 1 },
  helmet_2: { slot: 'helmet', tier: 2 },
  helmet_3: { slot: 'helmet', tier: 3 },
  vest_4: { slot: 'vest', tier: 4 },
  helmet_4: { slot: 'helmet', tier: 4 },
};
/** M2a: inverse of ARMOR_PIECES, e.g. armorIdOf('helmet', 2) === 'helmet_2'. */
export const armorIdOf = (slot: ArmorSlot, tier: ArmorTier): ArmorId => `${slot}_${tier}` as ArmorId;
export const isArmorId = (v: unknown): v is ArmorId => typeof v === 'string' && v in ARMOR_PIECES;
/** Transition key for a stance change, e.g. stanceTransitionKey('stand', 'prone') === 'stand_prone'. from !== to. */
export const stanceTransitionKey = (from: Stance, to: Stance): StanceTransitionKey => `${from}_${to}` as StanceTransitionKey;

/** Bot personality (server-only; never on the wire). Keys of balance `bots.personalities`. */
export type BotPersonalityId = 'aggressive' | 'balanced' | 'cautious';
export const BOT_PERSONALITY_IDS: readonly BotPersonalityId[] = ['aggressive', 'balanced', 'cautious'];

/**
 * 0 and 1 are the two weapon slots (keys 1 and 2). 2 is always fists (key 3).
 * M2a: 3 is the grenade slot (key 4 or G); selectable only while carrying >= 1 grenade.
 */
export type SlotIndex = 0 | 1 | 2 | 3;
export const FISTS_SLOT: SlotIndex = 2;
/** M2a. */
export const GRENADE_SLOT: SlotIndex = 3;
export const SLOT_INDICES: readonly SlotIndex[] = [0, 1, 2, 3];

/** M2b: indoor maps add the floor materials. */
export type Surface = 'sand' | 'grass' | 'water' | IndoorSurface;

/** Chibi variant indices. Small non-negative ints; the character factory wraps them. Assigned by the sim. */
export interface Appearance { skin: number; outfit: number; hair: number }

// ---------------------------------------------------------------------------------------------
// Input (client -> server, and the input to the shared movement step)
// ---------------------------------------------------------------------------------------------
/**
 * One input = one sim tick (SIM_DT) of player intent. The client produces exactly one per local fixed step
 * (30 Hz) and sends each one. Held buttons are the state during the tick. Edge buttons are true for exactly
 * one input after the key was pressed (the client latches key-down events until the next input).
 */
export interface PlayerInput {
  /** Strictly increasing per connection, starting at 1. Echoed back as `lastProcessedInputSeq`. */
  seq: number;
  /** Seconds this input covers. Always SIM_DT in M1; the server clamps to [0, SIM_DT]. */
  dt: number;
  /** Camera-relative intent in [-1, 1]. +1 = forward (toward look yaw). Magnitude of (forward, right) is clamped to 1. */
  moveForward: number;
  /** Camera-relative intent in [-1, 1]. +1 = strafe right. */
  moveRight: number;
  /** Radians, any value (wrapped by the sim). */
  yaw: number;
  /** Radians, clamped by the sim to [PITCH_MIN, PITCH_MAX]. */
  pitch: number;
  // Held
  sprint: boolean;
  /** Guns/fists: trigger held. M2a grenade slot: held = cook (pin pulled on the press), release = throw. */
  fire: boolean;
  /**
   * M2a: aim down sights held (RMB). The client turns the Settings "toggle" mode into this held flag. Read by the
   * shared movement step (speed, adsMs) and by combat (spread), so it is part of prediction. Holding it suppresses
   * sprint even when ADS itself is blocked (reload, heal, swap, transition, sight 'none').
   */
  ads: boolean;
  // Edge (pressed since the previous input)
  /** Space. Standing + grounded: jump. M2a: crouch -> stand, prone -> crouch (never jumps from crouch/prone). */
  jump: boolean;
  reload: boolean;
  interact: boolean;
  useHeal: boolean;
  /** -1 = no change. Otherwise the slot whose key was pressed this tick (M2a: 3 = grenade, keys 4 and G). */
  selectSlot: SlotIndex | -1;
  /**
   * M2a edge: C -> 'crouch', Z -> 'prone', else null. If both were pressed since the last input, the later press
   * wins. Toggle semantics are applied by the movement step (stance.md "Keys"): 'crouch' from crouch = stand,
   * 'prone' from prone = stand (falls back to crouch without headroom).
   */
  stanceToggle: StanceRequest | null;
  /**
   * M2c edge (scopes.md "T"): T pressed since the previous input = switch sight on the held gun. Stays optional
   * (absent = false; ADR 0007 §10); the protocol carries it from PROTOCOL_VERSION 4.
   */
  cycleScope?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Movement (shared by server sim and client prediction)
// ---------------------------------------------------------------------------------------------
/** M2b: includes DropMovementFields (dropPhase, dropMs). */
export interface MovementState extends DropMovementFields {
  /** Feet position. */
  pos: Vec3;
  vel: Vec3;
  grounded: boolean;
  /** True from spawn (in the air at match.dropHeight) until first ground contact. Uses drop fall/steer speeds. */
  dropping: boolean;
  /**
   * M2a (stance.md, ADR 0004 §1). Target stance; equals the current stance once settled. Spawn: 'stand'.
   * Predicted by the client exactly like position (the step owns every stance rule: requests, water, headroom).
   */
  stance: Stance;
  /** M2a: stance the current transition started from. Equals `stance` when settled (stanceMs === 0). */
  stanceFrom: Stance;
  /**
   * M2a: remaining transition ms, 0 = settled. Starts at `movement.stances.transitionMs[stanceFrom_stance]` and
   * counts down by dt x 1000 per step (clamped at 0). progress = 1 - stanceMs / transitionMs[key].
   */
  stanceMs: number;
  /**
   * M2a (combat.md "ADS"): ms aimed so far, in [0, weapons[held].adsTimeMs]. 0 = not engaged. Advanced by the step
   * while engaged, reset to 0 the tick ADS is not engaged (instant exit). adsProgress = adsMs / adsTimeMs.
   * ADR 0004 addendum A1.7: ADS never engages when adsTimeMs is 0 (adsMs stays 0); validateBalance requires
   * adsTimeMs > 0 for every weapon with a sight, so only fists (sight 'none') have 0. Lives here so ADS is predicted
   * and reconciled with movement.
   */
  adsMs: number;
}

/**
 * The subset of input the movement step reads, plus status modifiers computed by `toMovementInput` in the sim.
 * M2a: the step also owns stance and the ADS timer, so it receives the raw stance/ads intent plus the status it
 * cannot see (held item, ADS blockers). Stance, ADS and water multipliers are applied INSIDE the step; callers
 * must not fold them into speedMultiplier.
 */
export interface MovementInput {
  moveForward: number;
  moveRight: number;
  yaw: number;
  /** Raw Space edge. The step turns it into a jump (standing, settled, grounded) or a stance request (crouch/prone). */
  jump: boolean;
  /** Raw held sprint. While crouched with forward intent and every other sprint condition met, starts crouch_stand. */
  sprint: boolean;
  /**
   * Product of the non-stance, non-ADS, non-water multipliers: movement.healMoveMultiplier while healing, the held
   * weapon's fireMoveMultiplier within combat.fireMoveWindowMs of a shot (LMG). 1 normally; 0 when dead.
   */
  speedMultiplier: number;
  /** False while healing or while `fire` is held (includes cooking a grenade). ADS suppression is done by the step. */
  canSprint: boolean;
  /** M2a: PlayerInput.stanceToggle (null when dead). */
  stanceToggle: StanceRequest | null;
  /** M2a: PlayerInput.ads (false when dead). Suppresses sprint whenever true. */
  ads: boolean;
  /** M2a: item in hand; the step reads weapons[held].sight/adsTimeMs/adsMoveMultiplier ('grenade' = sight 'none'). */
  held: HeldId;
  /**
   * M2a: true while ADS may not engage for reasons outside movement: dead, reloading, healing, swapping.
   * (Dropping, stance transitions and sight 'none' are checked by the step itself.)
   */
  adsBlocked: boolean;
  /**
   * M2c (scopes.md, ADR 0007 §5): the held item's EFFECTIVE ADS numbers (effectiveWeapon with the mounted scope), filled
   * by toMovementInput on the server and in client prediction from the same slot state. Absent = weapons[held] (the
   * M2b rule). The step reads sight / adsTimeMs / adsMoveMultiplier from here when present.
   */
  adsSpec?: { sight: M2cSightType; adsTimeMs: number; adsMoveMultiplier: number };
}

/** M2a: a stance transition that began this step. */
export interface StanceChange {
  from: Stance;
  to: Stance;
  /** True for the automatic water stand-up (stance.md step 1). */
  forced: boolean;
  /** movement.stances.transitionMs[from_to]. */
  durationMs: number;
}

/** M2a: why a C/Z/Space stance request was refused (sprint-triggered stand-ups fail silently and never report). */
export type StanceRefusal = 'tooDeep' | 'noHeadroom';

/** M2b: includes DropStepFields (chuteOpened). */
export interface MovementStepResult extends DropStepFields {
  state: MovementState;
  /** A jump started this step. */
  jumped: boolean;
  /** Transitioned from airborne to grounded this step. */
  landed: boolean;
  /** Downward speed (m/s, >= 0) at the moment of landing; 0 if not landed. Used for fall damage and land SFX. */
  landingSpeed: number;
  /** M2a: non-null when a stance transition started this step (World emits `stanceChange`). */
  stanceChanged: StanceChange | null;
  /** M2a: non-null when a C/Z/Space request was refused this step (World emits actionFailed 'stance' for humans). */
  stanceRefused: StanceRefusal | null;
  /** M2a: ADS engaged this step (adsMs advanced). False on the tick it ends. */
  adsEngaged: boolean;
}

// ---------------------------------------------------------------------------------------------
// Snapshot state
// ---------------------------------------------------------------------------------------------
export interface PlayerAnim {
  moving: boolean;
  sprinting: boolean;
  airborne: boolean;
  dropping: boolean;
  inWater: boolean;
  /** True for the weapon's fire interval after a shot (or 150 ms, whichever is longer). */
  firing: boolean;
  reloading: boolean;
  healing: boolean;
  /** M2a: ADS engaged (adsMs > 0). Drives the scope glint when the held weapon's sight is scope_4x/scope_8x. */
  ads: boolean;
  /** M2a: holding a cooking grenade (pin pulled, not yet thrown). */
  cooking: boolean;
}

/** A player as every client sees it. Dead players stay in the list (alive = false) until the match ends. */
export interface PlayerState extends PlayerDropFields, PlayerM2cFields {
  id: PlayerId;
  name: string;
  /** Feet position. */
  pos: Vec3;
  /** Vertical velocity, for jump/fall poses. */
  velY: number;
  yaw: number;
  pitch: number;
  hp: number;
  /** M2a: worn vest tier, 0 = none (replaces the M1 `armor` number). Durability is owner-only (LocalPlayerState). */
  vestTier: ArmorTierOrNone;
  /** M2a: worn helmet tier, 0 = none. */
  helmetTier: ArmorTierOrNone;
  alive: boolean;
  /** Item currently in hand. M2a: 'grenade' while the grenade slot is active. */
  weapon: HeldId;
  /** M2a: MovementState.stance (target stance). */
  stance: Stance;
  /** M2a: MovementState.stanceFrom (=== stance when settled). */
  stanceFrom: Stance;
  /**
   * M2a: transition progress in [0, 1]; 1 = settled. = 1 - stanceMs / transitionMs[stanceFrom_stance].
   * Lets remotes animate transitions and pick the transition hitbox without reading balance.
   */
  stanceProgress: number;
  anim: PlayerAnim;
  appearance: Appearance;
  isBot: boolean;
  kills: number;
}

export interface WeaponSlotState {
  weapon: GunId;
  mag: number;
  /**
   * M2c (levels.md): the instance's level. Stays optional after the C-gate (ADR 0007 §10: fixtures and M2b-era states
   * read as L1): absent = 1. The sim always writes it.
   */
  level?: ItemLevel;
  /** M2c (scopes.md): mounted scope; null or absent = the gun's built-in sight. The sim always writes it. */
  scope?: ScopeId | null;
}
/** M2c name for a gun in a slot (combat.md "Inventory and keys"). Same shape as WeaponSlotState. */
export type WeaponInstance = WeaponSlotState;

/** M2a: a worn armor piece (owner-only). The id is armorIdOf(slot, tier); max durability = items[id].durability. */
export interface ArmorPieceState {
  tier: ArmorTier;
  /** Float, > 0 (a piece at 0 is destroyed and becomes null). The HUD shows ceil. */
  durability: number;
}

/** Extra state only the owning client receives. */
export interface LocalPlayerState extends LocalDropFields, LocalM2cFields {
  id: PlayerId;
  /** Seq of the last input the server applied to this player. Inputs <= this are acknowledged. */
  lastProcessedInputSeq: number;
  /**
   * Authoritative movement state at snapshot time: after `lastProcessedInputSeq`, plus any ticks the server ran on a
   * repeated input while the queue was empty (bounded by MAX_INPUT_REPEAT_TICKS). Reconciliation base.
   */
  movement: MovementState;
  slots: [WeaponSlotState | null, WeaponSlotState | null];
  /** M2a: may be GRENADE_SLOT (3). */
  activeSlot: SlotIndex;
  ammo: Record<AmmoId, number>;
  heals: Record<HealId, number>;
  /** M2a: worn vest, null = none. */
  vest: ArmorPieceState | null;
  /** M2a: worn helmet, null = none. */
  helmet: ArmorPieceState | null;
  /** M2a: carried (uncooked) grenades, 0..items.grenade.maxCarry. The cooking one is already subtracted. */
  grenades: number;
  /**
   * M2a: server ms when the grenade in hand explodes (cook-out); null when not cooking.
   * Fuse ring: remaining = cookExplodesAt - serverNow(), total = items.grenade.fuseMs.
   */
  cookExplodesAt: number | null;
  /** M2a: ms until the next pin pull is allowed (items.grenade.throwRecoveryMs after a throw); 0 = ready. */
  throwRecoveryMs: number;
  /** 0 when not reloading. */
  reloadRemainingMs: number;
  reloadTotalMs: number;
  /** 0 when not healing. */
  healRemainingMs: number;
  healTotalMs: number;
  healItem: HealId | null;
  /** 0 when not swapping weapons (combat.swapMs). */
  swapRemainingMs: number;
}

export interface LootState {
  id: LootId;
  item: ItemId;
  qty: number;
  /** Resting position on the ground (the renderer adds bob/spin). */
  pos: Vec3;
  /**
   * Rarity glow (producer: game-developer, sim loot.ts). Spawned items: the tier of the spawn point they came from.
   * M2a: dropped items (death, weapon swap and armor swap drops) use the fixed per-item rarity table in
   * docs/design/systems/loot.md ("UI"; `dropTierOf` in sim loot.ts), e.g. sniper and vest_3 'epic', rifle 'rare'.
   * Renderer draws the tier ring from it and only falls back to nearest-spawn inference when absent.
   */
  tier?: LootTier;
  /**
   * M2a: remaining durability of an armor pickup (present iff `item` is an ArmorId; qty is always 1 then).
   * Spawned pieces have items[id].durability; dropped pieces keep what was left.
   */
  durability?: number;
  /**
   * M2c (levels.md): the item's level, present iff the item is a weapon (gun, melee or rpg). Armor's level is its id
   * suffix; ammo, heals, throwables and scopes have none. The ground marker colour and pips come from it.
   */
  level?: ItemLevel;
  /** M2c (scopes.md): the scope mounted on a ground gun, null or absent = built-in sight. Guns only. */
  scope?: ScopeId | null;
}

/** M2a: assigned by the sim. Positive integer, unique per match. */
export type GrenadeId = number;

/**
 * M2a (ADR 0004 §3): a live grenade entity, in the snapshot for every client. Everything the shared
 * `stepGrenade` needs to continue the path deterministically, so clients extrapolate it exactly.
 */
export interface GrenadeState {
  id: GrenadeId;
  /** Thrower (kill credit). Kept even if the owner died or left. */
  ownerId: PlayerId;
  /** Centre, at the snapshot's serverTime. */
  pos: Vec3;
  /** m/s. All zero while resting. */
  vel: Vec3;
  /** Server ms of the fuse end (explosion tick). Drives the blink rate. */
  explodesAt: number;
  /** Has entered water (the one-off waterVelocityDamping was applied). Needed to continue the path exactly. */
  inWater: boolean;
  /**
   * M2c (smoke.md): 'grenade' (frag) or 'smoke' (canister). Clients pick the model, the fuse tick and the danger
   * indicator (frags only) from it.
   */
  kind: M2cThrowableId;
}

export interface ZoneState {
  /**
   * -1 before the first phase starts. 0..phases.length-1 = balance zone.phases[i].
   * phases.length = final collapse (shrinks to radius 0 using zone.finalCollapse*).
   */
  phaseIndex: number;
  phaseCount: number;
  /** Current safe circle. */
  center: Vec2;
  radius: number;
  /** Circle at the end of this phase's shrink. Equal to current while not yet decided. */
  targetCenter: Vec2;
  targetRadius: number;
  /** Server ms when the current wait (if !shrinking) or shrink (if shrinking) ends. */
  phaseEndsAt: number;
  shrinking: boolean;
  /** HP per second applied outside the circle, in whole-tick chunks of zone.damageTickMs. */
  dps: number;
}

export type MatchPhase = 'lobby' | 'countdown' | 'playing' | 'results';

export interface MatchState extends MatchMapFields {
  /** Increments each time a new lobby opens. */
  matchId: number;
  phase: MatchPhase;
  /** Server ms when countdown or results end; null in lobby/playing. */
  phaseEndsAt: number | null;
  /** Humans queued for the next match (lobby/countdown). */
  lobbyCount: number;
  targetPlayers: number;
  /** Alive participants (humans + bots) while playing. */
  aliveCount: number;
  /** Participants the match started with. 0 before playing. */
  totalPlayers: number;
  winnerId: PlayerId | null;
  winnerName: string | null;
}

export interface WorldSnapshot {
  tick: number;
  /** Server clock ms at this tick (sim time). */
  serverTime: number;
  match: MatchState;
  /** null outside 'playing'/'results'. */
  zone: ZoneState | null;
  /** Match participants (empty in lobby/countdown). */
  players: PlayerState[];
  /** Bumped whenever the loot set changes. */
  lootVersion: number;
  /**
   * Full loot list. The wire protocol may omit it when lootVersion is unchanged, but NetClient always
   * re-fills it so consumers always see the full list.
   */
  loot: LootState[];
  /** M2a: every live grenade, sorted by id. Empty outside 'playing'. Always present (no version gating). */
  grenades: GrenadeState[];
  /**
   * M2c (ADR 0007 §6): every live rocket as its immutable launch record, sorted by id. Clients compute the position
   * with rocketPosAt (src/shared/rocket.ts). On the wire it is carried forward in delta snapshots while unchanged.
   * Optional until the C-gate (absent = []).
   */
  rockets: RocketState[];
  /** M2c (ADR 0007 §6): every live smoke cloud, sorted by id; carried forward like `rockets`. Absent = []. */
  smokes: SmokeCloudState[];
  /**
   * M2c (ADR 0007 §8): ids of the glass panes broken this match (glassPanes in maps.ts), ascending. Only grows during
   * a match; carried forward like `rockets`. Absent = [].
   */
  brokenPanes: PaneId[];
  /** Per-recipient. null if the recipient is not a participant (lobby, mid-match spectator). */
  local: LocalPlayerState | null;
}

export interface Standing {
  id: PlayerId;
  name: string;
  isBot: boolean;
  kills: number;
  /** 1 = winner. */
  placement: number;
}

/**
 * Sent at each match start (one World per match, ADR 0006) and when joining a room mid-match. M2b: the client loads
 * `mapId` and resets per-match state on every welcome.
 */
export interface WelcomeInfo {
  /** The local player's id in THIS match's World (changes every match; rooms use memberId, ADR 0006 §3). */
  playerId: PlayerId;
  mapId: MapId;
  /** Server clock ms when the welcome was sent. */
  serverTime: number;
  matchId: number;
  /** M2b: the room this match belongs to. */
  roomId: RoomId;
  /**
   * M2c (ADR 0007 §1.5): this match's layout. The client builds the MatchLayout from (getMap(mapId), layout.seed),
   * checks `version` and `hash`, and uses `look`. Sent at the vote lock with the welcome (also to mid-match joiners).
   * Optional until the C-gate; absent = the base map (no layout).
   */
  layout: MatchLayoutRef;
}

// ---------------------------------------------------------------------------------------------
// M2b: maps, drop and rooms (ADR 0005, ADR 0006)
// ---------------------------------------------------------------------------------------------
/** Map id (`MapData.id`): 'island01' | 'office' today. A plain string on the wire; validated against the server's list. */
export type MapId = string;
/** A map vote: a map id or 'random' (maps.md 1). */
export type MapVoteOption = MapId | 'random';
/** Room map setting: a fixed map or a vote among the room's humans (rooms.md). */
export type RoomMapMode = MapId | 'vote';
/** How the match's map was chosen (UI banner). */
export type MapPickVia = 'pinned' | 'fixed' | 'vote' | 'random' | 'rotation';

/** M2b drop phase (drop.md). 'aboard' is not a movement phase: it is PlayerState.aboard. */
export type DropPhase = 'freefall' | 'chute';

/*
 * M2b field blocks (ADR 0005 §1). Since the C-gate (2026-11-18) each is merged into its target with `extends`
 * (MovementState, MovementStepResult, PlayerState, LocalPlayerState, MatchState; DropSimEvent into SimEvent) and every
 * field is required. The block names stay exported for code that names them.
 */

/** → MovementState. Predicted like position. */
export interface DropMovementFields {
  /** Phase of the drop while `dropping`; null when not dropping (drop.md "Freefall and parachute"). */
  dropPhase: DropPhase | null;
  /** ms since the jump while dropping (manual deploy needs >= drop.minFreefallMs); 0 otherwise. */
  dropMs: number;
}

/** → MovementStepResult. */
export interface DropStepFields {
  /**
   * The parachute opened this step: 'manual' (jump edge in freefall at dropMs >= drop.minFreefallMs, when
   * drop.manualDeploy) or 'auto' (height above the terrain or floor below <= drop.chuteDeployHeight; props ignored).
   * World emits SimEvent `chuteOpen`; ClientGame emits the local GameEvent from prediction.
   */
  chuteOpened: 'manual' | 'auto' | null;
}

/** → PlayerState. */
export interface PlayerDropFields {
  /** Riding the carrier: pos = the carrier position; not drawn as a character, invulnerable, not targetable. */
  aboard: boolean;
  /** MovementState.dropPhase (freefall pose, open parachute); null when not dropping. */
  dropPhase: DropPhase | null;
}

/** → LocalPlayerState. */
export interface LocalDropFields {
  /** Aboard: no prediction; ClientGame derives the view position from MatchState.route. */
  aboard: boolean;
}

/** → MatchState. */
export interface MatchMapFields {
  /** Map of this World's match (one World per match, ADR 0006 §2). */
  mapId: MapId;
  /** The carrier route from the World's creation (= the room's map lock) to the match end; null in drop-less test Worlds. */
  route: DropRoute | null;
  /** Participants still aboard (HUD "N aboard"); 0 outside the flight. */
  aboardCount: number;
}

/** → SimEvent (public; both also exist for bots). */
export type DropSimEvent =
  /** Left the carrier (jump edge, or `auto` = the eject point). pos = the carrier position on that tick. */
  | { type: 'dropJump'; playerId: PlayerId; pos: Vec3; auto: boolean }
  /** Parachute opened (manual or auto, see DropStepFields). */
  | { type: 'chuteOpen'; playerId: PlayerId; pos: Vec3; manual: boolean };

/** → ImpactSurface and GrenadeContactSurface ('glass' walls and glass kit parts, maps.md 2.5). */
export type GlassSurface = 'glass';
/** → Surface (indoor footsteps and landings). */
export type IndoorSurface = FloorMaterial;

/**
 * M2b (drop.md "Route generation"): the carrier's straight route, drawn by the World's seeded RNG when the World is
 * created (the room's map lock). Clients derive the carrier position: lerp(entry, exit, (now - startsAt) /
 * (endsAt - startsAt)), clamped; y = altitude. No per-tick carrier sync.
 */
export interface DropRoute {
  mapId: MapId;
  /** Start of the flight (play area expanded by drop.routeEntryMargin). */
  entry: Vec2;
  /** End of the flight. */
  exit: Vec2;
  /** Auto-eject point (play area inset by drop.ejectInset). */
  eject: Vec2;
  /** Absolute y. */
  altitude: number;
  /** m/s. */
  speed: number;
  /** Server ms when the carrier leaves `entry` (first tick of 'playing'). */
  startsAt: number;
  /** Server ms before which jump edges are ignored (startsAt + drop.noJumpMs). */
  noJumpUntil: number;
  /** Server ms of the auto-eject (carrier at `eject`). */
  ejectAt: number;
  /** Server ms when the carrier reaches `exit` and despawns. */
  endsAt: number;
}

/** M2b (ADR 0006): server-unique room id ('r' + counter, never reused). Not the shareable code. */
export type RoomId = string;
/** M2b: room-scoped member id (stable while the member stays in the room; not a World PlayerId). */
export type MemberId = number;
export type RoomVisibility = 'public' | 'private';
/** M2b: room lifecycle (rooms.md "States"). 'countdown' covers both the vote-open part and the post-lock part. */
export type RoomPhase = 'waiting' | 'countdown' | 'playing' | 'results';
export const ROOM_PHASES: readonly RoomPhase[] = ['waiting', 'countdown', 'playing', 'results'];

/** M2b (ADR 0006 §4): room code alphabet (28 symbols: no 0/O/1/I/L, no vowels). Codes are ROOM_CODE_LENGTH long. */
export const ROOM_CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';
export const ROOM_CODE_LENGTH = 5;
/**
 * M2b: canonical form of a typed or linked code: upper-cased, spaces and '-' removed. Returns null unless the result
 * is exactly ROOM_CODE_LENGTH alphabet characters. Shared by Ui (?room= and the field), NetClient and the server.
 */
export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const c = raw.toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of c) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return c;
}

/** M2b: host-editable settings (rooms.md "Room settings"). */
export interface RoomSettings {
  /** null = default: clients render `room.create.name.default` with the host name (ADR 0006 §6, Q5). */
  name: string | null;
  visibility: RoomVisibility;
  mapMode: RoomMapMode;
  /** rooms.minMaxHumans..rooms.maxMaxHumans, never below the current member count. */
  maxHumans: number;
  /** Fill to match.targetPlayers with bots at match start (default rooms.fillWithBotsDefault). */
  fillBots: boolean;
}

/** M2b: one public room in the browser list. Private rooms never appear. Never carries the code. */
export interface RoomSummary {
  id: RoomId;
  name: string | null;
  hostName: string;
  mapMode: RoomMapMode;
  /** Map of the running or locked match; null while a vote is open or before the first match. */
  mapId: MapId | null;
  humans: number;
  maxHumans: number;
  phase: RoomPhase;
  /** Server ms when the current phase began (clients tick "In match 3:12" locally). */
  phaseSince: number;
}

export interface RoomMember {
  memberId: MemberId;
  name: string;
  /** Always false for the host (the host counts as ready, rooms.md). Reset after every match. */
  ready: boolean;
  /** Persists across matches while the member stays in the room (director ruling Q4). */
  vote: MapVoteOption | null;
  /** 'playing' = a participant of the running match (alive or dead); 'spectating' = joined mid-match. */
  status: 'waiting' | 'playing' | 'spectating';
  /** Server ms; host migration picks the oldest (ties: lower memberId). */
  joinedAt: number;
}

/** M2b: full room state, sent to members on every change (coalesced <= 5/s). */
export interface RoomState {
  id: RoomId;
  /** ROOM_CODE_LENGTH chars from ROOM_CODE_ALPHABET. Members only. */
  code: string;
  settings: RoomSettings;
  hostId: MemberId;
  hostName: string;
  members: RoomMember[];
  phase: RoomPhase;
  phaseSince: number;
  /** Server MAP env pin (votes disabled), else null. */
  pinnedMap: MapId | null;
  /**
   * Map of the running or locked match and how it was chosen; null while the vote is open.
   * M2c: `layout` (seed and look) once locked, for the waiting-room map card (UI M2c §7.2). Optional until the C-gate.
   */
  map: { id: MapId; via: MapPickVia; layout?: { seed: number; look: LookId } } | null;
  /** Server ms when the countdown ends; null outside 'countdown'. */
  countdownEndsAt: number | null;
  /** Server ms of the map lock (countdownEndsAt - match.mapVoteLockSeconds); null outside 'countdown'. */
  lockAt: number | null;
  /** Auto-start timer (rooms.md): reason and server ms when it fires; null when none runs. */
  autoStart: { reason: 'allReady' | 'timer'; at: number } | null;
  /** Live vote tally (vote mode only, else null). Always island01, office, random order (server's map list + random). */
  votes: { option: MapVoteOption; count: number }[] | null;
  /** Bot seats that will be filled at start (fillBots ? max(0, targetPlayers - humans) : 0). */
  botSeats: number;
  /** The match in progress, if any (welcome.matchId of it). */
  matchId: number | null;
}

/** M2b: non-fatal lobby refusal codes (ADR 0006 §3). */
export type RejectCode =
  | 'room_not_found' | 'bad_code' | 'room_full' | 'max_rooms' | 'server_busy'
  | 'not_host' | 'bad_state' | 'bad_settings' | 'already_in_room' | 'not_in_room'
  | 'kicked' | 'rate_limited' | 'vote_closed' | 'too_few_humans';


export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

// ---------------------------------------------------------------------------------------------
// Sim events (returned by World.step, broadcast by the server, translated to GameEvents by ClientGame)
// ---------------------------------------------------------------------------------------------
/**
 * Why a player took damage. M2a adds 'explosion' (grenades; the kill event's weapon is then 'grenade').
 * Armor applies to 'weapon' (vest or helmet by hit zone) and 'explosion' (vest only); never to 'zone' or 'fall'.
 */
export type DeathCause = 'weapon' | 'zone' | 'fall' | 'explosion' | 'melee' | 'rocket';
/** M2b: 'glass' = glass walls and glass kit parts (solid; cosmetic difference only). */
export type ImpactSurface = 'player' | 'terrain' | 'prop' | 'water' | 'none' | GlassSurface;
/** M2a: what a grenade bounced off. 'edge' = the worldRadius wall. */
export type GrenadeContactSurface = 'terrain' | 'prop' | 'water' | 'edge' | GlassSurface;

export interface ShotImpact {
  /** End point of the ray (hit point, or origin + dir * range when it hit nothing). */
  point: Vec3;
  surface: ImpactSurface;
  playerId: PlayerId | null;
  headshot: boolean;
}

/**
 * M2a: what one armor piece did in one damage event (systems/armor.md). Present only when the victim wore that
 * piece at the start of the event AND the event's damage was routed to it (helmet: head hits; vest: body hits and
 * explosions). A shotgun event can carry both.
 */
export interface ArmorHit {
  /** Tier of the piece before the hit (audio pitch by tier, hit-marker variant). */
  tier: ArmorTier;
  /** Durability removed by this event (> 0 unless the raw damage was 0). */
  absorbed: number;
  /** The piece reached 0 and was destroyed (snapshot tier becomes 0). */
  broken: boolean;
}

export type SimEvent =
  /** A player entered the match world (spawned in the air for the drop). */
  | { type: 'spawn'; playerId: PlayerId; pos: Vec3 }
  /** One trigger pull. `impacts` has one entry per pellet (1 for non-shotguns). Fists: one short-range impact. */
  | { type: 'shot'; shooterId: PlayerId; weapon: WeaponId; origin: Vec3; impacts: ShotImpact[] }
  /**
   * One damage application (pellets of one shot are summed into a single event per victim; one event per victim
   * per explosion).
   */
  | {
      type: 'damage';
      victimId: PlayerId;
      /** Shooter, or the grenade owner for explosions (even if the owner is dead or gone); null for zone/fall. */
      attackerId: PlayerId | null;
      /** Raw damage BEFORE armor (falloff and headshot multiplier applied). HP lost = amount - absorbed total. */
      amount: number;
      headshot: boolean;
      cause: DeathCause;
      /** Attacker eye position, the blast centre for explosions, or the nearest zone-edge point for zone damage. */
      sourcePos: Vec3;
      hpAfter: number;
      /** M2a (replaces M1 armorAfter/armorBefore): vest involvement, null if no vest absorbed in this event. */
      vest: ArmorHit | null;
      /** M2a: helmet involvement (head hits only), null otherwise. */
      helmet: ArmorHit | null;
      /**
       * M2a: explosion id when cause === 'explosion', else absent. M2c: the blast entity id of a grenade OR a rocket
       * (one id space, ADR 0007 §6), and the rocket id for cause 'rocket' (impact).
       */
      grenadeId?: GrenadeId;
      /**
       * M2c (gate: required): the attacker's weapon: the gun or melee id (cause weapon/melee), 'rpg' (rocket impact and
       * rocket blasts), 'grenade' (frag blasts); null for zone/fall.
       */
      weapon?: HeldId | M2cWeaponId | null;
      /** M2c (gate: required): that weapon's level; null for fists, frags, zone and fall. */
      weaponLevel?: ItemLevel | null;
    }
  | {
      type: 'kill';
      victimId: PlayerId;
      killerId: PlayerId | null;
      /** M2a: HeldId so the kill feed can show 'grenade' (cause 'explosion'). null for zone/fall. */
      weapon: HeldId | null;
      cause: DeathCause;
      /** Victim's final placement (aliveCount after death + 1). */
      placement: number;
      /** M1-fix (producer: game-developer): the lethal hit was a headshot. Always false for zone/fall/explosion. */
      headshot?: boolean;
      /** M2c (gate: required): level of `weapon` at the kill (kill feed badge); null for fists, frags, zone, fall. */
      weaponLevel?: ItemLevel | null;
      /** M2c: a rocket kill whose rocket struck the victim (impact or its blast on the same tick). Absent = false. */
      direct?: boolean;
    }
  /** M2a: `durability` is set when `item` is an ArmorId (the worn piece's durability after the pickup). */
  | {
      type: 'pickup';
      playerId: PlayerId;
      lootId: LootId;
      item: ItemId;
      qty: number;
      pos: Vec3;
      durability?: number;
      /** M2c: the picked weapon's level (weapons only). */
      level?: ItemLevel;
      /** M2c: scope mounted on a picked gun (guns only; null = built-in). */
      scope?: ScopeId | null;
    }
  /** M2c: `rounds` = rounds this reload will load when it completes (audio: shell count). */
  | { type: 'reloadStart'; playerId: PlayerId; weapon: GunId; durationMs: number; rounds?: number }
  | { type: 'reloadEnd'; playerId: PlayerId; weapon: GunId; completed: boolean }
  | { type: 'healStart'; playerId: PlayerId; item: HealId; durationMs: number }
  | { type: 'healEnd'; playerId: PlayerId; item: HealId; completed: boolean; hpAfter: number }
  /** M2a: weapon is 'grenade' with slot 3. Also emitted for the auto-switch after the last grenade is thrown. */
  | { type: 'weaponSwitch'; playerId: PlayerId; weapon: HeldId; slot: SlotIndex; /** M2c: held item's level. */ level?: ItemLevel | null }
  | { type: 'matchEnded'; winnerId: PlayerId | null; standings: Standing[] }
  /**
   * M2a: a stance transition started (player request or forced water stand-up). Public: remotes play the cloth
   * rustle. ClientGame emits the LOCAL player's GameEvent from prediction and ignores this echo for the local id.
   */
  | { type: 'stanceChange'; playerId: PlayerId; from: Stance; to: Stance; forced: boolean; durationMs: number }
  /** M2a: pin pulled (cook started). Public (positional click ~10 m). */
  | { type: 'grenadeCook'; playerId: PlayerId; pos: Vec3; explodesAt: number; /** M2c. */ kind: M2cThrowableId }
  /**
   * M2a: a grenade entity was created. `dropped` = released by a swap-away, death or disconnect while cooking (no
   * throw whoosh). pos/vel at this tick's serverTime; the entity also appears in the next snapshot.
   */
  | {
      type: 'grenadeThrown';
      id: GrenadeId;
      ownerId: PlayerId;
      pos: Vec3;
      vel: Vec3;
      explodesAt: number;
      dropped: boolean;
      /** M2c: frag or smoke canister. For smoke, `explodesAt` is the cloud deploy time. */
      kind: M2cThrowableId;
    }
  /** M2a: a contact with impact normal speed >= items.grenade.bounceEventMinSpeed, or the water entry. */
  | { type: 'grenadeBounce'; id: GrenadeId; pos: Vec3; surface: GrenadeContactSurface; speed: number; /** M2c. */ kind: M2cThrowableId }
  /**
   * M2a: emitted BEFORE the damage events of the same blast; the entity is gone from the next snapshot.
   * `inHand` = cook-out (exploded at the thrower's eye; `id` is still a fresh GrenadeId).
   */
  | {
      type: 'explosion';
      id: GrenadeId;
      ownerId: PlayerId;
      pos: Vec3;
      radius: number;
      inHand: boolean;
      /** M2c: 'grenade' (frag) or 'rocket'. Smoke never explodes. */
      source: 'grenade' | 'rocket';
      /** M2c: a rocket that struck a player (VFX star flash). Absent = false. */
      direct?: boolean;
      /** M2c: a rocket that reached max range with no contact (no ground ring). Absent = false. */
      airburst?: boolean;
    }
  /** M1-fix (Contract revision 1 #5): translated by src/game/simEvents.ts, validated by protocol isSimEvent. */
  | ActionFailedSimEvent
  /** M2b: carrier jump and parachute (public). */
  | DropSimEvent
  | M2cSimEvent;

/**
 * M1-fix (producer: game-developer). A human's edge action was refused. Emitted at most once per press (edge
 * inputs), never for bots, never for held `fire`. See ARCHITECTURE.md §12 "Contract revision 1" and §14 for the
 * reason -> string-key table. Private: sent only to `playerId`.
 */
export interface ActionFailedSimEvent { type: 'actionFailed'; playerId: PlayerId; action: FailedAction; reason: ActionFailReason }

/** Actions that can be refused by the sim. M2a: 'swap' (slot 3 with no grenades), 'stance'. */
export type FailedAction = 'heal' | 'pickup' | 'reload' | 'fire' | 'swap' | 'stance' | 'scope';
/**
 * Why an action was refused.
 * - noHeals: Q with no bandage/medkit.        - fullHp: Q when no carried heal would add HP (at/above healCap).
 * - inventoryFull: E on ammo/heal/grenades at maxCarry/maxStack.
 * - betterArmor: E on an armor piece whose tier <= the worn piece's tier in that slot (armor.md "Equipping").
 * - noAmmo: R (or a fire press) with an empty mag and no reserve.
 * - noGrenades (M2a): slot 3 selected with 0 grenades (action 'swap').
 * - tooDeep (M2a): C/Z/Space stance request into a stance not allowed at this water depth (action 'stance').
 * - noHeadroom (M2a): stance request to a taller stance blocked by a collider overhead (action 'stance').
 */
export type ActionFailReason =
  | 'noHeals' | 'fullHp' | 'inventoryFull' | 'betterArmor' | 'noAmmo' | 'noGrenades' | 'tooDeep' | 'noHeadroom' | 'scopePouchFull' | 'scopeCantFit' | 'scopeNoneFits';

export type SimEventType = SimEvent['type'];

// ---------------------------------------------------------------------------------------------
// M2c "Fresh Every Match & Bigger Arsenal" (ADR 0007). Transitional like M2b: the live unions and state types above are
// unchanged until the C-gate, so every exhaustive table in the tree still compiles. New code targets the `M2c*` names
// below (they are the final unions) and fills the optional fields; at the C-gate tech-lead widens the live unions and
// merges the field blocks in one commit (ARCHITECTURE.md §16.2 lists the flips and the per-owner checklist).
// ---------------------------------------------------------------------------------------------

/** M2c (levels.md): weapon and armor level. 1 = today's numbers. */
export type ItemLevel = 1 | 2 | 3 | 4;
export const ITEM_LEVELS: readonly ItemLevel[] = [1, 2, 3, 4];
export const isItemLevel = (v: unknown): v is ItemLevel => v === 1 || v === 2 || v === 3 || v === 4;

/** M2c (melee.md): melee weapons. A subset of WeaponId (after the gate); they live in slot 2 and never take a gun slot. */
export type MeleeId = 'knife' | 'machete' | 'paddle';
export const MELEE_IDS: readonly MeleeId[] = ['knife', 'machete', 'paddle'];
export const isMeleeId = (v: unknown): v is MeleeId => v === 'knife' || v === 'machete' || v === 'paddle';

/** M2c (scopes.md): scope attachments (loot items, no level). */
export type ScopeId = 'scope_red_dot' | 'scope_2x' | 'scope_4x' | 'scope_8x';
export const SCOPE_IDS: readonly ScopeId[] = ['scope_red_dot', 'scope_2x', 'scope_4x', 'scope_8x'];
export const isScopeId = (v: unknown): v is ScopeId => (SCOPE_IDS as readonly unknown[]).includes(v);

/** M2c additions to the live unions (each joins its union at the C-gate). */
export type M2cGunAdd = 'dbshotgun' | 'revolver' | 'rpg';
export type M2cWeaponAdd = MeleeId | M2cGunAdd;
export type M2cAmmoAdd = 'ammo_rocket';
export type M2cThrowableAdd = 'smoke';
export type M2cArmorAdd = 'vest_4' | 'helmet_4';
export type M2cSightAdd = 'scope_2x';
export type M2cDeathCauseAdd = 'melee' | 'rocket';
export type M2cFailedActionAdd = 'scope';
export type M2cActionFailReasonAdd = 'scopePouchFull' | 'scopeCantFit' | 'scopeNoneFits';

/** The M2c unions (after the gate each equals the live name, which stays the canonical one; these remain synonyms). */
export type M2cWeaponId = WeaponId | M2cWeaponAdd;
/** Guns: slot weapons that use ammo. Never fists or melee. */
export type M2cGunId = GunId | M2cGunAdd;
export type M2cAmmoId = AmmoId | M2cAmmoAdd;
export type M2cThrowableId = ThrowableId | M2cThrowableAdd;
export type M2cVestId = VestId | 'vest_4';
export type M2cHelmetId = HelmetId | 'helmet_4';
export type M2cArmorId = M2cVestId | M2cHelmetId;
/** Armor tier = the item level (levels.md). */
export type M2cArmorTier = ItemLevel;
export type M2cArmorTierOrNone = 0 | ItemLevel;
export type M2cHeldId = M2cWeaponId | M2cThrowableId;
export type M2cItemId = M2cGunId | MeleeId | M2cAmmoId | HealId | M2cArmorId | M2cThrowableId | ScopeId;
/** 'scope_2x' is new (2x overlay). */
export type M2cSightType = SightType | M2cSightAdd;
export type M2cDeathCause = DeathCause | M2cDeathCauseAdd;
export type M2cFailedAction = FailedAction | M2cFailedActionAdd;
/**
 * M2c reasons (scopes.md):
 * - scopePouchFull: E on a scope that fits nowhere while the pouch holds one (action 'pickup'), or T with a mounted
 *   scope and a pouch scope that does not fit the held gun (action 'scope').
 * - scopeCantFit: T while the held item accepts no scope (fists, melee, throwables, rpg, dbshotgun) (action 'scope').
 * - scopeNoneFits: T on a gun with nothing mounted and nothing in the pouch that fits (action 'scope').
 * The throwable slot keeps 'noGrenades' for "no throwables" (grenades.md).
 */
export type M2cActionFailReason = ActionFailReason | M2cActionFailReasonAdd;

export const M2C_GUN_ADD_IDS: readonly M2cGunAdd[] = ['dbshotgun', 'revolver', 'rpg'];
export const M2C_WEAPON_IDS: readonly M2cWeaponId[] = WEAPON_IDS;
export const M2C_GUN_IDS: readonly M2cGunId[] = GUN_IDS;
export const M2C_AMMO_IDS: readonly M2cAmmoId[] = AMMO_IDS;
export const M2C_THROWABLE_IDS: readonly M2cThrowableId[] = ['grenade', 'smoke'];
export const M2C_VEST_IDS: readonly M2cVestId[] = VEST_IDS;
export const M2C_HELMET_IDS: readonly M2cHelmetId[] = HELMET_IDS;
export const M2C_ARMOR_IDS: readonly M2cArmorId[] = [...M2C_VEST_IDS, ...M2C_HELMET_IDS];
export const M2C_ITEM_IDS: readonly M2cItemId[] = [
  ...M2C_GUN_IDS, ...MELEE_IDS, ...M2C_AMMO_IDS, ...HEAL_IDS, ...M2C_ARMOR_IDS, ...M2C_THROWABLE_IDS, ...SCOPE_IDS,
];
export const M2C_SIGHT_TYPES: readonly M2cSightType[] = ['none', 'iron', 'red_dot', 'scope_2x', 'scope_4x', 'scope_8x'];
/** Sights a gun can have (every sight but 'none'); the keys of balance `scopes.sightFactors`. */
export type ScopedSightType = Exclude<M2cSightType, 'none'>;
export const SCOPED_SIGHT_TYPES: readonly ScopedSightType[] = ['iron', 'red_dot', 'scope_2x', 'scope_4x', 'scope_8x'];
export const isM2cGunId = (v: unknown): v is M2cGunId => (M2C_GUN_IDS as readonly unknown[]).includes(v);
export const isM2cThrowableId = (v: unknown): v is M2cThrowableId => v === 'grenade' || v === 'smoke';

/** M2c: ARMOR_PIECES with the level 4 pieces (ARMOR_PIECES itself widens at the gate). */
export const M2C_ARMOR_PIECES: Readonly<Record<M2cArmorId, { slot: ArmorSlot; tier: M2cArmorTier }>> = {
  ...ARMOR_PIECES,
  vest_4: { slot: 'vest', tier: 4 },
  helmet_4: { slot: 'helmet', tier: 4 },
};

/**
 * M2c slot rules (combat.md "Inventory and keys"): index 2 is the MELEE slot (key 3): fists, or the carried melee
 * weapon. Index 3 is the THROWABLE slot (key 4 / G; again = cycle frag <-> smoke). FISTS_SLOT and GRENADE_SLOT keep
 * their names and values; these are the M2c names for the same indices.
 */
export const MELEE_SLOT: SlotIndex = 2;
export const THROWABLE_SLOT: SlotIndex = 3;

/** M2c (melee.md): the melee slot's weapon. null in LocalM2cFields.melee = fists. */
export interface MeleeSlotState {
  weapon: MeleeId;
  level: ItemLevel;
}

/** M2c ids. Grenades, rockets and smoke clouds share ONE per-World id counter (a smoke cloud keeps its canister's id). */
export type RocketId = number;
export type SmokeId = number;
/** M2c: index into glassPanes(map) (src/shared/maps.ts) of the match's (layout-applied) map. */
export type PaneId = number;

/**
 * M2c (rpg.md, ADR 0007 §6): a live rocket as its immutable launch record. Position at server time t (ms):
 * rocketPosAt(this, t, weapons.rpg.rocket.gravity) in src/shared/rocket.ts; the sim samples the same closed form at
 * every tick, so server and clients agree exactly. The rocket ends with `explosion` (source 'rocket') or `rocketDud`.
 */
export interface RocketState {
  id: RocketId;
  /** Shooter (kill credit; kept if the owner dies or leaves). */
  ownerId: PlayerId;
  /** Level of the rpg that fired it (impact and blast damage scale). */
  level: ItemLevel;
  /** Launch origin (eye + aim x rocket.originForward) at `firedAt`. */
  pos: Vec3;
  /** Launch velocity, m/s (aim within the launch cone x rocket.speed). */
  vel: Vec3;
  /** Server ms of the launch tick. */
  firedAt: number;
}

/**
 * M2c (smoke.md, ADR 0007 §7): a live smoke cloud. Its shape is a pure function of time (src/shared/smoke.ts):
 * centre = pos + (0, cloud.centerHeight, 0); radius grows over growMs from deployedAt, holds, and fades over fadeMs from
 * fadeAt; gone at fadeAt + fadeMs. fadeAt = deployedAt + growMs + holdMs unless `cloud.maxActive` forced it earlier.
 */
export interface SmokeCloudState {
  /** = the canister's GrenadeId. */
  id: SmokeId;
  ownerId: PlayerId;
  /** Deploy point (in water: the point at y = 0 above it). */
  pos: Vec3;
  /** Server ms of the deploy tick. */
  deployedAt: number;
  /** Server ms when the fade starts. */
  fadeAt: number;
}

/** M2c: what a rocket ended on (rocketDud.surface). */
export type RocketContactSurface = 'player' | 'terrain' | 'prop' | 'water' | 'edge' | GlassSurface | 'range';

/**
 * M2c field block → PlayerState (merged with `extends` at the C-gate, every field required). Producer: World snapshot.
 */
export interface PlayerM2cFields {
  /** Level of the held weapon (gun, melee or rpg); null for fists and throwables. Remotes draw the level collar. */
  weaponLevel: ItemLevel | null;
  /**
   * Effective sight of the held item (scopes.md): the mounted scope's sight, else the gun's built-in sight; 'none'
   * for fists, melee and throwables. Remotes draw the scope model and the glint (isScopeSight) from it.
   */
  sight: M2cSightType;
}

/** M2c field block → LocalPlayerState (merged at the C-gate). Owner-only. */
export interface LocalM2cFields {
  /** Slot 2: the carried melee weapon, null = fists. */
  melee: MeleeSlotState | null;
  /**
   * Carried smoke canisters, 0..items.smoke.maxCarry (grenades.md "Throwable slot"). Frags stay in
   * LocalPlayerState.grenades. A smoke held for a throw is NOT subtracted until release (not cookable).
   */
  smokes: number;
  /** The throwable slot's selected type (persists across slot changes; reset to 'grenade' at match start). */
  selectedThrowable: M2cThrowableId;
  /** The spare-scope pouch (scopes.spareSlots = 1): null = empty. */
  spareScope: ScopeId | null;
  /** ms left of a T sight switch (scopes.swapMs total); 0 = none. The throwable cycle uses swapRemainingMs. */
  scopeSwapRemainingMs: number;
}

/** M2c sim events (public unless noted). Join SimEvent at the C-gate. */
export type M2cSimEvent =
  /**
   * A melee swing started (melee.md "Swing"). Remotes play the wind-up from it (no per-tick swing state on the wire);
   * the owner's ClientGame predicts its own swing and treats this as the echo. hitAt = server ms of the hit frame.
   */
  | { type: 'meleeSwing'; playerId: PlayerId; weapon: MeleeId; level: ItemLevel; pos: Vec3; hitAt: number; cycleMs: number }
  /**
   * The hit check found something within reach (centre ray or sweep). Not emitted on a clean miss. `surface` 'player'
   * with victimId; 'glass' when the pane broke (glassBroken follows). Damage arrives as a `damage` event (cause melee).
   */
  | {
      type: 'meleeHit';
      attackerId: PlayerId;
      weapon: MeleeId;
      level: ItemLevel;
      pos: Vec3;
      surface: ImpactSurface;
      victimId: PlayerId | null;
      headshot: boolean;
      /** Paddle knockback was applied to the victim. */
      knockback: boolean;
    }
  /** A rocket was launched; the same data as its RocketState (late joiners get it from WorldSnapshot.rockets). */
  | ({ type: 'rocketFired' } & RocketState)
  /** A rocket ended within rocket.armDistance (no blast; impact damage only if it struck a player). */
  | { type: 'rocketDud'; id: RocketId; ownerId: PlayerId; pos: Vec3; surface: RocketContactSurface; victimId: PlayerId | null }
  /** A smoke canister became a cloud; the same data as its SmokeCloudState. The canister leaves `grenades`. */
  | ({ type: 'smokeDeployed' } & SmokeCloudState)
  /** A glass pane broke for the rest of the match (melee centre ray or rocket contact). */
  | { type: 'glassBroken'; paneId: PaneId; pos: Vec3; byId: PlayerId | null; cause: 'melee' | 'rocket' }
  /**
   * A scope was mounted, removed or exchanged on a gun (pickup auto-mount, or the end of a T switch). to null =
   * removed (built-in sight). Positional click for everyone; the HUD needs no per-slot identity.
   */
  | {
      type: 'scopeChanged';
      playerId: PlayerId;
      slot: 0 | 1;
      gun: M2cGunId;
      from: ScopeId | null;
      to: ScopeId | null;
      /** true = auto-mount from a scope pickup; false = T. */
      auto: boolean;
      pos: Vec3;
    };
export type M2cSimEventType = M2cSimEvent['type'];

// ---- Per-match layout (ADR 0007 §1; docs/design/levels/variety.md §8) ----

/** M2c look presets (art M2c.md §10). `noon` and `day` are today's looks. Cosmetic only: no sim effect. */
export type IslandLookId = 'morning' | 'noon' | 'golden' | 'overcast';
export type OfficeLookId = 'day' | 'evening' | 'afterHours';
export type LookId = IslandLookId | OfficeLookId;
export const ISLAND_LOOK_IDS: readonly IslandLookId[] = ['morning', 'noon', 'golden', 'overcast'];
export const OFFICE_LOOK_IDS: readonly OfficeLookId[] = ['day', 'evening', 'afterHours'];
export const LOOK_IDS: readonly LookId[] = [...ISLAND_LOOK_IDS, ...OFFICE_LOOK_IDS];
export const isLookId = (v: unknown): v is LookId => (LOOK_IDS as readonly unknown[]).includes(v);
/** Look used when there is no layout (title screen, tests, LAYOUT_SEED=baseline). */
export const baselineLook = (kind: MapKind): LookId => (kind === 'indoor' ? 'day' : 'noon');

/** One zone's choice, in generation order (logs, dev overlay, repeat avoidance, tests). */
export interface LayoutPick {
  /** 'summit', 'TL', 'fishbowl', 'K3', ... */
  zone: string;
  /** 'cairns', 'pods', 'rotated', 'wall', ... ('baseline' variants keep their data name). */
  variant: string;
  /** e.g. { column: 3 }, { removed: 'N.1,N.2' }, { mirror: 1, turn: 2 }. */
  params?: Record<string, number | string>;
}

/** M2c: a client-only, no-collider placement (decor). `kind` keys the render decor table (graphics-designer). */
export interface DecorPlacement {
  kind: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
  variant?: number;
}

/**
 * M2c (ADR 0007 §1): the result of the pure generator `buildMatchLayout(base, seed, opts)` in
 * src/game/levels/layout/ (level-designer). Identical on server and clients for the same (base map data, seed,
 * LAYOUT_FORMAT_VERSION). `applyLayout(base, layout)` returns an ordinary AnyMapData (props and lootSpawns replaced),
 * so colliders, nav, prepareMap, World, renderer, minimap and bots keep their signatures. Never sent on the wire.
 */
export interface MatchLayout {
  /** LAYOUT_FORMAT_VERSION (src/shared/layout.ts) of the generator that built it. */
  version: number;
  mapId: MapId;
  /** layoutSeed (uint32). 0 = baseline (every zone's baseline variant, baseline look). */
  seed: number;
  picks: LayoutPick[];
  look: LookId;
  /** Sim part: replaces the base map's props (island PropPlacement[], indoor IndoorPropPlacement[]). */
  props: PropPlacement[] | IndoorPropPlacement[];
  /** Sim part: the activated loot points (with group and guarantee); replaces the base map's lootSpawns. */
  lootSpawns: LootSpawn[];
  /** layoutHash(props, lootSpawns) (src/shared/layout.ts): FNV-1a 32 over the canonical sim part. */
  hash: number;
  /** Fallback uses (variety.md §3.2): logged per match; tests bound it. */
  fallbacks: number;
  /** Client part: decor (empty when built with { decor: false }). Not in the hash. */
  decor: DecorPlacement[];
  /** Indoor client part: sorted indices into `props` of lit lightPanel placements (afterHours). Absent = all lit. */
  lightsOn?: number[];
}

/** M2c: what travels on the wire about a layout (WelcomeInfo.layout). The client rebuilds the rest. */
export interface MatchLayoutRef {
  seed: number;
  version: number;
  hash: number;
  look: LookId;
}
