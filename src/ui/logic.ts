/**
 * Pure, DOM-free UI helpers. Everything here is unit-tested in node (logic.test.ts).
 * Owner: ui-ux-designer.
 *
 * Angle convention (src/shared/types.ts): yaw 0 looks toward -Z, forward = (-sin yaw, 0, -cos yaw),
 * right = (cos yaw, 0, -sin yaw). The minimap is north-up with north = -Z.
 */
import { hasKey, keysWithPrefix, t, type StringVars } from '../content/strings';
import { hasScopeOverlay, isScopeSight, type ZoneTheme } from '../shared/balance';
import { MAX_NAME_LENGTH } from '../shared/constants';
import type {
  AdsView,
  GraphicsStatus,
  HudArmorView,
  HudCookView,
  HudDropView,
  HudLocalView,
  HudSlotView,
  HudZoneView,
} from '../shared/contracts';
import {
  isMeleeId,
  isScopeId,
  M2C_ARMOR_PIECES,
  type ArmorSlot,
  type ItemLevel,
  type ConnectionStatus,
  type M2cActionFailReason,
  type M2cArmorId,
  type M2cArmorTier,
  type M2cDeathCause,
  type M2cFailedAction,
  type M2cHeldId,
  type M2cItemId,
  type M2cSightType,
  type M2cThrowableId,
  type MapId,
  type MatchPhase,
  type ScopeId,
  type Rect,
  type RoomPhase,
  type Stance,
  type Vec2,
} from '../shared/types';

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Mirrors the server rule: strip control chars, trim, cap at MAX_NAME_LENGTH (code points). */
export function sanitizeName(raw: string): string {
  const cleaned = raw.replace(CONTROL_CHARS, '').trim();
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
}

/** Returns the name to send, or null if it is empty after sanitising. */
export function validateName(raw: string): string | null {
  const name = sanitizeName(raw);
  return name.length >= 1 ? name : null;
}

// ---------------------------------------------------------------------------------------------
// Time / numbers
// ---------------------------------------------------------------------------------------------
/** Whole seconds → "m:ss". Negative and non-finite values show 0:00. */
export function formatClock(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** 0..1 ratio, safe for max <= 0. */
export function ratio(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return value <= 0 ? 0 : value >= max ? 1 : value / max;
}

// ---------------------------------------------------------------------------------------------
// Directions
// ---------------------------------------------------------------------------------------------
/**
 * Bearing of `to` relative to a viewer at `from` looking along `yaw`, in degrees (-180, 180].
 * 0 = straight ahead (top of the screen), +90 = to the right, ±180 = behind. null if the points coincide.
 */
export function relativeBearingDeg(from: Vec2, yaw: number, to: Vec2): number | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (dx * dx + dz * dz < 1e-6) return null;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const forward = -dx * sin - dz * cos;
  const right = dx * cos - dz * sin;
  let deg = (Math.atan2(right, forward) * 180) / Math.PI;
  if (deg <= -180) deg += 360;
  return deg;
}

/** Canvas rotation (radians, clockwise) for a north-up minimap arrow that points along `yaw`. */
export function minimapArrowRotation(yaw: number): number {
  return -yaw;
}

// ---------------------------------------------------------------------------------------------
// Crosshair
// ---------------------------------------------------------------------------------------------
/** Screen-space radius in CSS px of a cone with half-angle `spreadDeg`, for a perspective camera. */
export function spreadToPx(spreadDeg: number, fovDeg: number, viewportHeightPx: number): number {
  if (!(spreadDeg > 0) || !(fovDeg > 0) || !(viewportHeightPx > 0)) return 0;
  const half = Math.tan((Math.min(fovDeg, 170) * Math.PI) / 360);
  const s = Math.tan((Math.min(spreadDeg, 80) * Math.PI) / 180);
  return (s / half) * (viewportHeightPx / 2);
}

// ---------------------------------------------------------------------------------------------
// Screen selection
// ---------------------------------------------------------------------------------------------
/**
 * M2b (UI.md §12.1): `lobby` is the legacy single-lobby screen, used only while ClientGame does not fill
 * HudView.rooms (before the C-gate). With rooms: browser → room (waiting room, countdown) → match → results → room.
 */
export type ScreenId = 'title' | 'connecting' | 'connectionLost' | 'lobby' | 'browser' | 'room' | 'match' | 'results';

/** M2b: the rooms part of the screen decision (from HudView.rooms). */
export interface RoomScreenInputs {
  location: 'none' | 'browser' | 'room';
  /** RoomView.phase, null outside a room. */
  roomPhase: RoomPhase | null;
  /** RoomView.localSpectating. */
  localSpectating: boolean;
}

export interface ScreenInputs {
  /** The player pressed Play (or Rejoin) at least once. */
  joinRequested: boolean;
  connection: ConnectionStatus;
  joined: boolean;
  phase: MatchPhase;
  /** Player pressed "Play again" on this results screen. */
  resultsDismissed: boolean;
  /** M2b: absent / null = legacy single lobby. */
  rooms?: RoomScreenInputs | null;
  /** M2b: HudView.local !== null (a participant of the running match). */
  hasLocal?: boolean;
  /** M2b: HudView.spectate !== null. */
  spectating?: boolean;
}

/**
 * M2b: is the room's match in its results? The room phase leads; the World phase only fills the moment where a
 * room update lags a snapshot (room still 'playing', World already 'results'). A stale World phase after the room went
 * back to 'waiting' never wins.
 */
export function roomInResults(phase: MatchPhase, roomPhase: RoomPhase | null): boolean {
  return roomPhase === 'results' || (roomPhase === 'playing' && phase === 'results');
}

/** M2b: is the room's match being played? Same rule: the World's 'playing' only counts while the room is in countdown. */
export function roomInPlay(phase: MatchPhase, roomPhase: RoomPhase | null): boolean {
  return (roomPhase === 'playing' && phase !== 'results') || (roomPhase === 'countdown' && phase === 'playing');
}

/** Which full-screen state to show. In-match sub-states (alive / dead / spectating) are decided by the HUD. */
export function selectScreen(s: ScreenInputs): ScreenId {
  if (!s.joinRequested) return 'title';
  if (s.connection === 'disconnected' || s.connection === 'error') return 'connectionLost';
  const rooms = s.rooms ?? null;
  if (rooms) {
    if (rooms.location === 'none') return 'connecting';
    if (rooms.location === 'browser') return 'browser';
    const watching = s.hasLocal === true || s.spectating === true || rooms.localSpectating;
    if (roomInResults(s.phase, rooms.roomPhase)) return s.resultsDismissed || !watching ? 'room' : 'results';
    if (roomInPlay(s.phase, rooms.roomPhase)) return watching ? 'match' : 'room';
    return 'room';
  }
  if (!s.joined) return 'connecting';
  switch (s.phase) {
    case 'lobby':
    case 'countdown':
      return 'lobby';
    case 'results':
      return s.resultsDismissed ? 'lobby' : 'results';
    case 'playing':
      return 'match';
  }
}

/** Connection-error copy key from the server reason code (contracts: 'full', 'bad_name', 'bad_version'). */
export function connectionErrorKey(reason: string | undefined, wasJoined: boolean): string {
  switch (reason) {
    case 'full':
      return 'menu.connection.full';
    case 'bad_version':
      return 'menu.connection.version';
    case 'bad_name':
      return 'menu.name.invalid';
    default:
      return wasJoined ? 'menu.connection.lost' : 'menu.connection.failed';
  }
}

// ---------------------------------------------------------------------------------------------
// Kill feed
// ---------------------------------------------------------------------------------------------
export interface KillInfo {
  killerName: string | null;
  victimName: string;
  /** M2a: HeldId ('grenade' for explosion kills). M2c: 'rpg' for rocket kills, a MeleeId for melee kills. */
  weapon: M2cHeldId | null;
  cause: M2cDeathCause;
  /** M2a: the victim's own grenade (M2c: or rocket) killed them (see isSelfBlastKill). */
  self?: boolean;
  /** M2c: a rocket kill by a direct hit (playerKilled.direct). */
  direct?: boolean;
  /** M2c (P2): the local camera's line to the victim crossed smoke (playerKilled.throughSmoke). */
  throughSmoke?: boolean;
}

/** M2c: a blast or rocket-impact death (frag or rocket). */
export function isBlastCause(cause: M2cDeathCause): boolean {
  return cause === 'explosion' || cause === 'rocket';
}

/**
 * M2a: was this explosion death caused by the victim's own grenade? grenades.md: a self-kill credits the last enemy
 * who hit the victim (or nobody), so `killerId` alone cannot tell. `lastBlastAttacker` is the attackerId of the
 * victim's most recent explosion damage (playerDamaged arrives before playerKilled).
 */
export function isSelfGrenadeKill(
  cause: M2cDeathCause,
  killerId: number | null,
  victimId: number,
  lastBlastAttacker: number | null | undefined,
): boolean {
  if (!isBlastCause(cause)) return false;
  return killerId === null || killerId === victimId || lastBlastAttacker === victimId;
}

/** M2c name (UI M2c §5): the same rule covers rockets. */
export const isSelfBlastKill = isSelfGrenadeKill;

/** M2c: a rocket kill (cause 'rocket' impact, or a blast from the rpg). */
export function isRocketKill(k: Pick<KillInfo, 'cause' | 'weapon'>): boolean {
  return k.cause === 'rocket' || (k.cause === 'explosion' && k.weapon === 'rpg');
}

/**
 * Which `feed.*` variant group describes a kill (UI M2c §8, narrative M2c §5 routing). `has` checks that a per-weapon
 * group exists (feed.<meleeId>.N), so a future melee id without lines falls back to feed.meleeWeapon.
 */
export function killFeedPrefix(k: KillInfo, headshot: boolean, has: (prefix: string) => boolean = hasVariants): string {
  if (k.cause === 'zone') return 'feed.zone';
  if (k.cause === 'fall') return 'feed.fall';
  if (isRocketKill(k)) {
    if (k.self === true) return 'feed.rocketSelf';
    if (k.killerName === null) return 'feed.generic';
    return k.direct === true && has('feed.rocketDirect') ? 'feed.rocketDirect' : 'feed.rocket';
  }
  if (k.cause === 'explosion' || k.weapon === 'grenade') {
    if (k.self === true) return 'feed.grenadeSelf';
    return k.killerName === null ? 'feed.generic' : 'feed.grenade';
  }
  if (k.killerName === null || k.weapon === null) return 'feed.generic';
  if (k.weapon === 'fists') return 'feed.melee';
  if (isMeleeId(k.weapon)) {
    if (headshot) return 'feed.meleeHeadshot';
    return has(`feed.${k.weapon}`) ? `feed.${k.weapon}` : 'feed.meleeWeapon';
  }
  if (k.throughSmoke === true && has('feed.smoke')) return 'feed.smoke';
  return headshot ? 'feed.headshot' : 'feed.kill';
}

function hasVariants(prefix: string): boolean {
  return keysWithPrefix(prefix).length > 0;
}

/** M2a: feed lines that get the grenade glyph. */
export function isGrenadeFeedPrefix(prefix: string): boolean {
  return prefix === 'feed.grenade' || prefix === 'feed.grenadeSelf';
}

/** M2c: feed lines that lead with the rocket glyph. */
export function isRocketFeedPrefix(prefix: string): boolean {
  return prefix === 'feed.rocket' || prefix === 'feed.rocketDirect' || prefix === 'feed.rocketSelf';
}

/**
 * M2c (UI M2c §8): the weapon icon + level badge after a feed line / on the death card. null for fists, frags,
 * smoke, zone, fall, self-kills and lines without a killer weapon.
 */
export function killWeaponTag(
  k: Pick<KillInfo, 'weapon' | 'cause' | 'self' | 'killerName'>,
  level: ItemLevel | null | undefined,
): { weapon: M2cHeldId; level: ItemLevel | null } | null {
  if (k.cause === 'zone' || k.cause === 'fall' || k.self === true || k.killerName === null) return null;
  const w = k.weapon;
  if (w === null || w === 'fists' || w === 'grenade' || w === 'smoke') return null;
  return { weapon: w, level: level ?? null };
}

/** Death-card cause line key (+ whether it takes the killer's name). */
export function deathCauseKey(
  cause: M2cDeathCause,
  killerName: string | null,
  self: boolean,
  weapon: M2cHeldId | null = null,
): string | null {
  if (cause === 'zone') return 'death.eliminatedByTide';
  if (cause === 'fall') return 'death.eliminatedByFall';
  if (self && isRocketKill({ cause, weapon })) return 'death.eliminatedBySelfRocket';
  if (cause === 'explosion' && self) return 'death.eliminatedBySelf';
  return killerName ? 'death.eliminatedBy' : null;
}

/** Picks a numbered variant key under `prefix` (rng in [0, 1)). Returns the prefix when there are none. */
export function pickVariantKey(prefix: string, rng: () => number): string {
  const keys = keysWithPrefix(prefix);
  if (keys.length === 0) return prefix;
  const i = Math.min(keys.length - 1, Math.max(0, Math.floor(rng() * keys.length)));
  return keys[i] ?? prefix;
}

export interface TemplatePart {
  text: string;
  /** Placeholder name when this part came from `{var}`. */
  varName: string | null;
}

/**
 * Splits a template into literal and placeholder parts, so names can be styled without innerHTML.
 * Unknown placeholders are kept as literal text (same as format()).
 */
export function splitTemplate(template: string, vars: StringVars): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    const name = m[1] ?? '';
    if (!Object.prototype.hasOwnProperty.call(vars, name)) continue;
    if (m.index > last) parts.push({ text: template.slice(last, m.index), varName: null });
    parts.push({ text: String(vars[name]), varName: name });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last), varName: null });
  return mergeLiterals(parts);
}

function mergeLiterals(parts: TemplatePart[]): TemplatePart[] {
  const out: TemplatePart[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev && prev.varName === null && p.varName === null) prev.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Items / pickup prompt
// ---------------------------------------------------------------------------------------------
export type ItemCategory = 'gun' | 'melee' | 'ammo' | 'heal' | 'armor' | 'throwable' | 'scope';

export function itemCategory(item: M2cItemId): ItemCategory {
  switch (item) {
    case 'pistol':
    case 'smg':
    case 'shotgun':
    case 'rifle':
    case 'lmg':
    case 'dmr':
    case 'sniper':
    case 'dbshotgun':
    case 'revolver':
    case 'rpg':
      return 'gun';
    case 'knife':
    case 'machete':
    case 'paddle':
      return 'melee';
    case 'ammo_light':
    case 'ammo_heavy':
    case 'ammo_shell':
    case 'ammo_sniper':
    case 'ammo_rocket':
      return 'ammo';
    case 'bandage':
    case 'medkit':
      return 'heal';
    case 'vest_1':
    case 'vest_2':
    case 'vest_3':
    case 'vest_4':
    case 'helmet_1':
    case 'helmet_2':
    case 'helmet_3':
    case 'helmet_4':
      return 'armor';
    case 'grenade':
    case 'smoke':
      return 'throwable';
    case 'scope_red_dot':
    case 'scope_2x':
    case 'scope_4x':
    case 'scope_8x':
      return 'scope';
  }
}

/** M2c: armor ids including level 4 (M2C_ARMOR_PIECES). */
export function isM2cArmorId(item: unknown): item is M2cArmorId {
  return typeof item === 'string' && item in M2C_ARMOR_PIECES;
}

export interface PromptChoice {
  key: string;
  /** Item name is resolved by the caller (t(`item.${item}.name`)); qty is passed as `count`. */
  usesCount: boolean;
  /** True when the pickup will be refused (shown greyed with a lock glyph). */
  blocked: boolean;
}

/** Local fields the prompt reads. The M1-fix carry limits are optional until every producer fills them. */
export type PromptLocal = Pick<HudLocalView, 'slots' | 'heals' | 'reserve'> &
  Partial<
    Pick<
      HudLocalView,
      'vest' | 'helmet' | 'grenades' | 'grenadeMax' | 'healMax' | 'reserveMax' | 'ammoType' | 'throwables' | 'throwableMax'
    >
  >;

/** M2c: carried count and carry limit of a throwable (throwables / throwableMax, else the M2a grenade fields). */
export function throwableCarry(id: M2cThrowableId, local: PromptLocal): { count: number; max: number | null } {
  const count = local.throwables?.[id] ?? (id === 'grenade' ? (local.grenades ?? 0) : 0);
  const max = local.throwableMax?.[id] ?? (id === 'grenade' ? (local.grenadeMax ?? null) : null);
  return { count, max: typeof max === 'number' && max > 0 ? max : null };
}

/** True when the pickup will be refused because that item is already at its carry limit (unknown limit = false). */
export function isCarryFull(item: M2cItemId, local: PromptLocal): boolean {
  if (item === 'bandage' || item === 'medkit') {
    const max = local.healMax?.[item];
    return max !== undefined && max > 0 && (local.heals[item] ?? 0) >= max;
  }
  if (item === 'grenade' || item === 'smoke') {
    const c = throwableCarry(item, local);
    return c.max !== null && c.count >= c.max;
  }
  if (itemCategory(item) === 'ammo') {
    // HudView only carries the reserve of the active weapon's ammo type, so other ammo types stay "unknown".
    const max = local.reserveMax;
    return local.ammoType === item && typeof max === 'number' && max > 0 && (local.reserve ?? 0) >= max;
  }
  return false;
}

/** The worn piece in the slot an armor item would fill. */
export function wornPiece(local: Pick<PromptLocal, 'vest' | 'helmet'>, slot: ArmorSlot): HudArmorView | null {
  return (slot === 'vest' ? local.vest : local.helmet) ?? null;
}

/** armor.md "Equipping": a same-or-lower tier is refused unless the worn piece is broken (broken pieces are removed). */
export function armorRefused(item: M2cItemId, local: Pick<PromptLocal, 'vest' | 'helmet'>): boolean {
  if (!isM2cArmorId(item)) return false;
  const piece = M2C_ARMOR_PIECES[item];
  const worn = wornPiece(local, piece.slot);
  return worn !== null && worn.durability > 0 && piece.tier <= worn.tier;
}

/** Refusal string for an armor item by its slot (ARCHITECTURE §14 table); generic when the item is unknown. */
export function betterArmorKey(item: M2cItemId | null): string {
  if (item !== null && isM2cArmorId(item)) return M2C_ARMOR_PIECES[item].slot === 'vest' ? 'hud.vest.better' : 'hud.helmet.better';
  return 'hud.armor.better';
}

/** "Carry full" string: the grenade, smoke and scope pouches have their own lines. */
export function inventoryFullKey(item: M2cItemId | null): string {
  if (item === 'grenade') return 'hud.grenade.full';
  if (item === 'smoke') return 'hud.smoke.full';
  if (item !== null && isScopeId(item)) return 'hud.scope.stashFull';
  return 'hud.inventory.full';
}

/**
 * Which prompt string to show for the loot in range. `refusal` is ClientGame's prediction from
 * interactPromptChanged (M2a); when absent the UI predicts from the HUD fields itself.
 */
export function pickupPromptChoice(
  item: M2cItemId,
  qty: number,
  local: PromptLocal | null,
  refusal: M2cActionFailReason | null = null,
): PromptChoice {
  const cat = itemCategory(item);
  if (refusal === 'betterArmor' || (cat === 'armor' && local !== null && armorRefused(item, local))) {
    return { key: betterArmorKey(item), usesCount: false, blocked: true };
  }
  if (refusal === 'scopePouchFull') return { key: 'hud.scope.stashFull', usesCount: false, blocked: true };
  if (refusal === 'inventoryFull' || (local !== null && isCarryFull(item, local))) {
    return { key: inventoryFullKey(item), usesCount: false, blocked: true };
  }
  if (cat === 'gun') {
    const full = local !== null && local.slots[0].weapon !== null && local.slots[1].weapon !== null;
    return { key: full ? 'hud.pickup.swap' : 'hud.pickup', usesCount: false, blocked: false };
  }
  if (cat === 'melee') {
    const held = local?.slots[2]?.weapon ?? null;
    return { key: held !== null && isMeleeId(held) ? 'hud.pickup.swap' : 'hud.pickup', usesCount: false, blocked: false };
  }
  if (cat === 'armor') {
    const worn = local !== null && isM2cArmorId(item) ? wornPiece(local, M2C_ARMOR_PIECES[item].slot) : null;
    return { key: worn !== null ? 'hud.pickup.upgrade' : 'hud.pickup', usesCount: false, blocked: false };
  }
  if (cat === 'ammo' || qty > 1) return { key: 'hud.pickup.ammo', usesCount: true, blocked: false };
  return { key: 'hud.pickup', usesCount: false, blocked: false };
}

/** Tier + durability detail for an armor pickup ("Lv.2" and "31/55"); null for other items. */
export function armorPromptDetail(
  item: M2cItemId,
  durability: number | null,
  maxDurability: number | null,
): { tier: M2cArmorTier; tierKey: string; durability: string | null } | null {
  if (!isM2cArmorId(item)) return null;
  const tier = M2C_ARMOR_PIECES[item].tier;
  const cur = durability !== null && Number.isFinite(durability) ? Math.max(0, Math.ceil(durability)) : null;
  return {
    tier,
    tierKey: `gear.tier.${tier}`,
    durability: cur === null ? null : maxDurability !== null && maxDurability > 0 ? `${cur}/${Math.ceil(maxDurability)}` : String(cur),
  };
}

// ---------------------------------------------------------------------------------------------
// M2c: item levels (docs/ui/M2c.md §1, §3)
// ---------------------------------------------------------------------------------------------
export interface LevelBadgeModel {
  numeral: string;
  /** CSS token / data-level value. */
  token: 'lv1' | 'lv2' | 'lv3' | 'lv4';
  /** L4 only: the sparkle corner (a shape cue on top of the numeral). */
  sparkle: boolean;
}

export function levelBadgeModel(level: ItemLevel | null | undefined): LevelBadgeModel | null {
  if (level !== 1 && level !== 2 && level !== 3 && level !== 4) return null;
  return { numeral: String(level), token: `lv${level}`, sparkle: level === 4 };
}

/** "Lv.3 Hot" (level.label), or '' without a level. */
export function levelLabel(level: ItemLevel | null | undefined): string {
  if (level !== 1 && level !== 2 && level !== 3 && level !== 4) return '';
  return t('level.label', { short: t(`level.${level}.short`), name: t(`level.${level}.name`) });
}

export type LevelCompare = 'up' | 'down' | 'same';

/** ▲ / ▼ / = for a same-id swap; null when either level is unknown. */
export function levelCompare(next: ItemLevel | null | undefined, current: ItemLevel | null | undefined): LevelCompare | null {
  if (next == null || current == null) return null;
  return next > current ? 'up' : next < current ? 'down' : 'same';
}

/** Pickup prompt inputs from interactPromptChanged (M2c fields optional; absent = M2a behaviour). */
export interface PromptInput {
  item: M2cItemId;
  qty: number;
  refusal: M2cActionFailReason | null;
  level?: ItemLevel | null;
  /** Scope on a ground gun. */
  scope?: ScopeId | null;
  replacesSlot?: number | null;
  scopeTarget?: 0 | 1 | 'pouch' | null;
}

export interface PromptModel extends PromptChoice {
  /** Template vars: item (name, with level.item when levelled), current (the replaced item's name). */
  vars: StringVars;
  level: ItemLevel | null;
  /** The replaced item (swap prompts), its level, and the compare tag (same id only). */
  replaced: { item: M2cHeldId; level: ItemLevel | null } | null;
  compare: LevelCompare | null;
  /** Scope pickups: where it goes. */
  scopeTarget: { slot: 0 | 1; weapon: M2cHeldId | null } | 'pouch' | null;
  /** "Fits: …" names, when the scope fits neither carried gun. */
  fitsKey: boolean;
  /** Extra detail key (e.g. hud.melee.replacesFists). */
  noteKey: string | null;
  /** Scope mounted on a ground gun. */
  groundScope: ScopeId | null;
}

/** Slot fields the prompt reads (M2c optional). */
type PromptSlots = PromptLocal['slots'];

/**
 * M2c pickup prompt (UI M2c §3, §16.3). Wraps the M2a choice with levels, swapFrom / levelUp, the compare tag, the melee
 * note and the scope target. `has` guards keys narrative may not have yet.
 */
export function pickupPromptModel(p: PromptInput, local: PromptLocal | null, has: (key: string) => boolean = hasKey): PromptModel {
  const base = pickupPromptChoice(p.item, p.qty, local, p.refusal);
  const cat = itemCategory(p.item);
  const level = p.level ?? null;
  const name = t(`item.${p.item}.name`);
  const model: PromptModel = {
    ...base,
    vars: { item: name, count: p.qty },
    level,
    replaced: null,
    compare: null,
    scopeTarget: null,
    fitsKey: false,
    noteKey: null,
    groundScope: cat === 'gun' ? (p.scope ?? null) : null,
  };
  if (base.blocked || local === null) return model;
  const slots: PromptSlots = local.slots;
  if (cat === 'gun' || cat === 'melee') {
    const idx = p.replacesSlot ?? null;
    const replacedSlot = idx !== null && idx >= 0 && idx <= 2 ? (slots[idx as 0 | 1 | 2] as HudSlotView | undefined) : undefined;
    const replacedWeapon = replacedSlot?.weapon ?? null;
    if (replacedSlot && replacedWeapon !== null && replacedWeapon !== 'fists') {
      const rLevel = replacedSlot.level ?? null;
      model.replaced = { item: replacedWeapon, level: rLevel };
      const same = replacedWeapon === p.item;
      model.compare = same ? levelCompare(level, rLevel) : null;
      if (same && model.compare === 'up' && has('hud.pickup.levelUp')) model.key = 'hud.pickup.levelUp';
      else if (has('hud.pickup.swapFrom')) {
        model.key = 'hud.pickup.swapFrom';
        model.vars = { ...model.vars, current: t(`item.${replacedWeapon}.name`) };
      } else model.key = 'hud.pickup.swap';
    }
    if (cat === 'melee' && (slots[2]?.weapon ?? 'fists') === 'fists' && has('hud.melee.replacesFists')) {
      model.noteKey = 'hud.melee.replacesFists';
    }
    return model;
  }
  if (cat === 'scope') {
    const target = p.scopeTarget ?? null;
    if (target === 'pouch') model.scopeTarget = 'pouch';
    else if (target === 0 || target === 1) model.scopeTarget = { slot: target, weapon: slots[target]?.weapon ?? null };
    if (isScopeId(p.item)) {
      const fitsEither = [0, 1].some((i) => (slots[i as 0 | 1] as HudSlotView | undefined)?.compatibleScopes?.includes(p.item as ScopeId) === true);
      const known = [0, 1].some((i) => (slots[i as 0 | 1] as HudSlotView | undefined)?.compatibleScopes !== undefined);
      model.fitsKey = known && !fitsEither;
    }
  }
  return model;
}

// ---------------------------------------------------------------------------------------------
// M2c: throwable slot (UI M2c §2.1)
// ---------------------------------------------------------------------------------------------
export interface ThrowableSlotModel {
  /** The selected type (main icon). */
  main: M2cThrowableId;
  mainCount: number;
  /** The other type, only when carried (mini chip). */
  other: M2cThrowableId | null;
  otherCount: number;
  /** Nothing carried at all (dashed, grey). */
  empty: boolean;
  /** The "[4] Swap" hint: only while the slot is active and both types are carried. */
  cycleHint: boolean;
}

export function throwableSlotModel(local: PromptLocal & Partial<Pick<HudLocalView, 'throwableSelected' | 'activeSlot'>>): ThrowableSlotModel {
  const selected: M2cThrowableId = local.throwableSelected ?? ((local.slots[3]?.weapon as M2cHeldId | null | undefined) === 'smoke' ? 'smoke' : 'grenade');
  const other: M2cThrowableId = selected === 'grenade' ? 'smoke' : 'grenade';
  const mainCount = throwableCarry(selected, local).count;
  const otherCount = throwableCarry(other, local).count;
  return {
    main: selected,
    mainCount,
    other: otherCount > 0 ? other : null,
    otherCount,
    empty: mainCount <= 0 && otherCount <= 0,
    cycleHint: local.activeSlot === 3 && mainCount > 0 && otherCount > 0,
  };
}

// ---------------------------------------------------------------------------------------------
// M2c: sight chip and scope pouch (UI M2c §16.1, §16.2)
// ---------------------------------------------------------------------------------------------
export interface SightChipModel {
  /** none = built-in iron (or not a gun); builtIn = outline chip; mounted = filled chip. */
  kind: 'none' | 'builtIn' | 'mounted';
  /** "2×" / "4×" / "8×", or null for the red-dot glyph. */
  label: string | null;
  sight: M2cSightType;
}

const ZOOM_LABEL: Partial<Record<M2cSightType, string>> = { scope_2x: '2×', scope_4x: '4×', scope_8x: '8×' };

export function sightChipModel(slot: Pick<HudSlotView, 'weapon' | 'scope' | 'sight' | 'builtInSight'> | null | undefined): SightChipModel {
  const none: SightChipModel = { kind: 'none', label: null, sight: 'none' };
  if (!slot || slot.weapon === null) return none;
  const sight = slot.sight ?? 'none';
  if (sight === 'none' || sight === 'iron') return { ...none, sight };
  const mounted = slot.scope != null;
  return { kind: mounted ? 'mounted' : 'builtIn', label: ZOOM_LABEL[sight] ?? null, sight };
}

/** Scope id -> sight type (balance scopes.<id>.sight is the same mapping by decision). */
export function scopeSight(scope: ScopeId): M2cSightType {
  return scope === 'scope_red_dot' ? 'red_dot' : scope;
}

export interface PouchChip {
  scope: ScopeId;
  /** Fits the active gun (full opacity); else faded AND slashed. */
  fits: boolean;
}

export function pouchModel(stash: readonly ScopeId[] | undefined, active: Pick<HudSlotView, 'compatibleScopes'> | null | undefined): PouchChip[] {
  const compatible = active?.compatibleScopes ?? [];
  return (stash ?? []).slice(0, 4).map((scope) => ({ scope, fits: compatible.includes(scope) }));
}

// ---------------------------------------------------------------------------------------------
// M2c: smoke and per-match layout
// ---------------------------------------------------------------------------------------------
/** UI M2c §6.2: obscured body/head/armor markers hide; the kill marker always shows. */
export function hitMarkerVisible(obscured: boolean | undefined, killed: boolean): boolean {
  return killed || obscured !== true;
}

/** "Forecast: Mango Hour" (lobby.look.<mapId> + look.<mapId>.<look>), or null when either key is missing. */
export function lookLine(mapId: MapId | null | undefined, look: string | null | undefined, has: (key: string) => boolean = hasKey): string | null {
  if (!mapId || !look) return null;
  const lineKey = `lobby.look.${mapId}`;
  const nameKey = `look.${mapId}.${look}`;
  if (!has(lineKey) || !has(nameKey)) return null;
  return t(lineKey, { look: t(nameKey) });
}

/** Look family for the map-card glyph (sun / sunset / moon / cloud); the text always carries the meaning. */
export function lookGlyph(look: string | null | undefined): 'sun' | 'sunset' | 'moon' | 'cloud' {
  if (look === 'golden' || look === 'evening') return 'sunset';
  if (look === 'afterHours') return 'moon';
  if (look === 'overcast') return 'cloud';
  return 'sun';
}

// ---------------------------------------------------------------------------------------------
// Refused actions (GameEvent actionFailed, ARCHITECTURE.md §12 "Contract revision 1")
// ---------------------------------------------------------------------------------------------
/**
 * String key for a refused action, or null when the UI should stay silent (fire is covered by dryFire).
 * `promptItem` (the loot the prompt points at) picks the vest/helmet/grenade variants (ARCHITECTURE §14 table).
 */
export function actionFailedKey(
  action: M2cFailedAction,
  reason: M2cActionFailReason,
  promptItem: M2cItemId | null = null,
  has: (key: string) => boolean = hasKey,
): string | null {
  if (action === 'fire') return null;
  switch (reason) {
    case 'noHeals':
      return 'hud.heal.none';
    case 'fullHp':
      return 'hud.heal.full';
    case 'inventoryFull':
      return inventoryFullKey(promptItem);
    case 'betterArmor':
      return betterArmorKey(promptItem);
    case 'noAmmo':
      return 'hud.ammo.empty';
    case 'noGrenades':
      // M2c: the throwable slot covers frags and smoke.
      return has('hud.throwable.none') ? 'hud.throwable.none' : 'hud.grenade.none';
    case 'scopePouchFull':
      return 'hud.scope.pouchFull';
    case 'scopeCantFit':
      return 'hud.scope.cantFit';
    case 'scopeNoneFits':
      return 'hud.scope.noneFits';
    case 'noHeadroom':
      return 'hud.stance.noRoom';
    case 'tooDeep':
      return has('hud.stance.tooDeep') ? 'hud.stance.tooDeep' : 'hud.stance.proneWater';
  }
}

// ---------------------------------------------------------------------------------------------
// Vitals / damage feedback
// ---------------------------------------------------------------------------------------------
/**
 * Local HP at or below this (and above 0) shows the low-health treatment. Absolute HP, the same number audio uses
 * for the heartbeat (src/audio/cues.ts lowHealthHp = 30), so stripes and heartbeat start together (REVIEW-M1 m5).
 * Proposed balance key: `player.lowHpThreshold` (game-designer); revision 2 replaces this with the
 * `localLowHealthChanged` bus event (tech-lead).
 */
export const LOW_HP_THRESHOLD = 30;

export function isLowHp(hp: number, threshold: number = LOW_HP_THRESHOLD): boolean {
  return hp > 0 && hp <= threshold;
}

/** HudLocalView.lowHpThreshold (balance player.lowHpThreshold, ADR 0003) when valid, else LOW_HP_THRESHOLD. */
export function lowHpThresholdOf(fromHud: number | undefined): number {
  return fromHud !== undefined && Number.isFinite(fromHud) && fromHud > 0 ? fromHud : LOW_HP_THRESHOLD;
}

// ---------------------------------------------------------------------------------------------
// Graphics status (IUi.setGraphicsStatus, ADR 0003)
// ---------------------------------------------------------------------------------------------
export interface GraphicsStatusView {
  /** Full-screen blocking overlay with the Reload button. */
  blocking: boolean;
  /** Small non-blocking "restoring graphics…" note. */
  note: boolean;
}

export function graphicsStatusView(status: GraphicsStatus): GraphicsStatusView {
  switch (status) {
    case 'failed':
      return { blocking: true, note: false };
    case 'restoring':
      return { blocking: false, note: true };
    case 'ok':
      return { blocking: false, note: false };
  }
}

/** A hit of at least this fraction of max HP draws the thick ("heavy") damage arc. */
export const HEAVY_HIT_FRACTION = 0.25;
/** A hit of this fraction of max HP (or more) drives the red hit vignette to full strength. */
export const VIGNETTE_FULL_FRACTION = 0.4;
const VIGNETTE_MIN = 0.35;

export function isHeavyHit(amount: number, maxHp: number): boolean {
  return maxHp > 0 && amount >= maxHp * HEAVY_HIT_FRACTION;
}

/** 0.35..1 vignette strength for one hit, scaled by max HP. */
export function hitVignetteStrength(amount: number, maxHp: number): number {
  if (!(maxHp > 0) || !(amount > 0)) return VIGNETTE_MIN;
  return Math.min(1, VIGNETTE_MIN + amount / (maxHp * VIGNETTE_FULL_FRACTION));
}

// ---------------------------------------------------------------------------------------------
// Tide status
// ---------------------------------------------------------------------------------------------
export interface TideStatus {
  key: string;
  vars: StringVars;
  /** Shrinking or final collapse: shown with the urgent style (icon + stripes, not colour alone). */
  urgent: boolean;
  /** "m:ss" for the separate timer chip; '' when the label already embeds it. */
  clock: string;
}

/**
 * M2b (ADR 0005 §7): the zone's string family for the map's fiction: `hud.<theme>.*`, `announcer.<theme>.*` and
 * `hint.<theme>`. Falls back to the tide key when a themed key is missing, so a new theme never shows raw keys.
 */
export function zoneKey(family: 'hud' | 'announcer' | 'hint', theme: ZoneTheme | undefined, suffix = ''): string {
  const th = theme ?? 'tide';
  const key = `${family}.${th}${suffix ? `.${suffix}` : ''}`;
  return th === 'tide' || hasKey(key) ? key : `${family}.tide${suffix ? `.${suffix}` : ''}`;
}

export function tideStatus(zone: HudZoneView | null, theme?: ZoneTheme): TideStatus | null {
  if (!zone) return null;
  const clock = formatClock(zone.secondsLeft);
  if (zone.isFinal) return { key: zoneKey('hud', theme, 'final'), vars: {}, urgent: true, clock };
  if (zone.shrinking) return { key: zoneKey('hud', theme, 'shrinking'), vars: {}, urgent: true, clock };
  return { key: zoneKey('hud', theme, 'wait'), vars: { time: clock }, urgent: false, clock: '' };
}

/** 1-based phase label numbers, or null before the first phase. Final collapse shows count/count. */
export function tidePhaseNumbers(zone: HudZoneView | null): { index: number; count: number } | null {
  if (!zone || zone.phaseIndex < 0 || zone.phaseCount <= 0) return null;
  return { index: Math.min(zone.phaseIndex + 1, zone.phaseCount), count: zone.phaseCount };
}

// ---------------------------------------------------------------------------------------------
// Announcer
// ---------------------------------------------------------------------------------------------
export const REMAIN_THRESHOLDS: readonly number[] = [10, 5, 3];

/** Announcement for an alive-count drop, or null. */
export function aliveAnnouncement(prev: number, next: number, total: number): { key: string; vars: StringVars } | null {
  if (!(next < prev) || next < 2) return null;
  if (next === 2) return { key: 'announcer.finalTwo', vars: {} };
  for (const th of REMAIN_THRESHOLDS) {
    if (total > th && prev > th && next <= th) return { key: 'announcer.remain', vars: { count: next } };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Timed message queue (announcer banners, hints, toasts)
// ---------------------------------------------------------------------------------------------
export interface QueuedMessage<T> {
  id: string;
  payload: T;
  durationMs: number;
}

/** FIFO of timed messages; one is "current" at a time. Duplicate ids already queued are ignored. */
export class MessageQueue<T> {
  private readonly queue: QueuedMessage<T>[] = [];
  private current: QueuedMessage<T> | null = null;
  private currentEndsAt = 0;

  constructor(private readonly maxQueued = 4) {}

  push(msg: QueuedMessage<T>): void {
    if (this.current?.id === msg.id || this.queue.some((q) => q.id === msg.id)) return;
    this.queue.push(msg);
    while (this.queue.length > this.maxQueued) this.queue.shift();
  }

  /** Advances to `nowMs`; returns the message to show (same object while it is current). */
  update(nowMs: number): QueuedMessage<T> | null {
    if (this.current && nowMs >= this.currentEndsAt) this.current = null;
    if (!this.current) {
      const next = this.queue.shift();
      if (next) {
        this.current = next;
        this.currentEndsAt = nowMs + next.durationMs;
      }
    }
    return this.current;
  }

  clear(): void {
    this.queue.length = 0;
    this.current = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Map projection (minimap)
// ---------------------------------------------------------------------------------------------
export interface MapProjection {
  /** CSS px per metre. */
  scale: number;
  cx: number;
  cy: number;
}

/** Fits a circle of `worldRadius` metres into a square of `sizePx` with `padPx` padding. North (-Z) is up. */
export function fitProjection(worldRadius: number, sizePx: number, padPx: number): MapProjection {
  const r = Math.max(1, worldRadius);
  return { scale: Math.max(0.01, (sizePx / 2 - padPx) / r), cx: sizePx / 2, cy: sizePx / 2 };
}

/**
 * M2b: fits an axis-aligned rectangle (indoor floor) into a square of `sizePx`, centred, with `padPx` padding and the
 * same scale on both axes (the longer side fills the square). North (-Z) is up.
 */
export function fitRectProjection(r: Rect, sizePx: number, padPx: number): MapProjection {
  const w = Math.max(1, r.maxX - r.minX);
  const d = Math.max(1, r.maxZ - r.minZ);
  const scale = Math.max(0.01, (sizePx - 2 * padPx) / Math.max(w, d));
  return { scale, cx: sizePx / 2 - ((r.minX + r.maxX) / 2) * scale, cy: sizePx / 2 - ((r.minZ + r.maxZ) / 2) * scale };
}

/**
 * M2b: where a flight route first enters `r` (Liang-Barsky clip of from→to), or null when it never does. The route's
 * entry lies outside the play area (drop.routeEntryMargin), so the waiting carrier icon is drawn here instead.
 */
export function routeEntryPoint(from: Vec2, to: Vec2, r: Rect): Vec2 | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (!clip(-dx, from.x - r.minX) || !clip(dx, r.maxX - from.x) || !clip(-dz, from.z - r.minZ) || !clip(dz, r.maxZ - from.z)) return null;
  return { x: from.x + dx * t0, z: from.z + dz * t0 };
}

export function projectXZ(p: MapProjection, x: number, z: number): { px: number; py: number } {
  return { px: p.cx + x * p.scale, py: p.cy + z * p.scale };
}

// ---------------------------------------------------------------------------------------------
// Minimap labels (BUG-004): keep every drawn label fully inside the map, never overlapping another label or POI dot
// ---------------------------------------------------------------------------------------------
export interface LabelBox {
  /** Top-left corner, CSS px. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelRequest {
  /** POI dot position, CSS px. */
  px: number;
  py: number;
  /** Text block size (all lines), CSS px. */
  w: number;
  h: number;
}

export interface PlacedLabel {
  /** Index into the request array. */
  index: number;
  box: LabelBox;
}

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Greedy label placement in request order (earlier = higher priority). Each label tries: above its dot, below, right,
 * left, then the four corner anchors; each candidate is shifted inward to stay `pad` px inside the `size`-px square. The first candidate that does
 * not overlap an already placed label or another POI dot wins; labels with no free spot (or wider than the map) are
 * dropped rather than clipped.
 */
export function layoutMapLabels(items: readonly LabelRequest[], size: number, pad: number, gap = 3, dotR = 3): PlacedLabel[] {
  // Greedy placement depends on order: also try rim-first (rim labels have the fewest in-bounds spots) and keep the
  // order that fits the most labels. Ties keep the caller's priority order.
  const c = size / 2;
  const byIndex = items.map((_, i) => i);
  const rimFirst = [...byIndex].sort((a, b) => {
    const ia = items[a];
    const ib = items[b];
    if (!ia || !ib) return 0;
    return Math.hypot(ib.px - c, ib.py - c) - Math.hypot(ia.px - c, ia.py - c);
  });
  let best: PlacedLabel[] = [];
  for (const order of [byIndex, rimFirst]) {
    const placed = placeLabelsInOrder(items, order, size, pad, gap, dotR);
    if (placed.length > best.length) best = placed;
  }
  return best.sort((a, b) => a.index - b.index);
}

function placeLabelsInOrder(
  items: readonly LabelRequest[],
  order: readonly number[],
  size: number,
  pad: number,
  gap: number,
  dotR: number,
): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const dots: LabelBox[] = items.map((it) => ({ x: it.px - dotR, y: it.py - dotR, w: dotR * 2, h: dotR * 2 }));
  const clampBox = (b: LabelBox): LabelBox => ({
    w: b.w,
    h: b.h,
    x: Math.min(Math.max(b.x, pad), size - pad - b.w),
    y: Math.min(Math.max(b.y, pad), size - pad - b.h),
  });
  for (const index of order) {
    const it = items[index];
    if (!it || it.w > size - 2 * pad || it.h > size - 2 * pad) continue;
    const candidates: LabelBox[] = [
      { x: it.px - it.w / 2, y: it.py - gap - it.h, w: it.w, h: it.h },
      { x: it.px - it.w / 2, y: it.py + gap, w: it.w, h: it.h },
      { x: it.px + gap + dotR, y: it.py - it.h / 2, w: it.w, h: it.h },
      { x: it.px - gap - dotR - it.w, y: it.py - it.h / 2, w: it.w, h: it.h },
      // Corner anchors: label edge flush with the dot, above or below.
      { x: it.px - dotR, y: it.py - gap - it.h, w: it.w, h: it.h },
      { x: it.px + dotR - it.w, y: it.py - gap - it.h, w: it.w, h: it.h },
      { x: it.px - dotR, y: it.py + gap, w: it.w, h: it.h },
      { x: it.px + dotR - it.w, y: it.py + gap, w: it.w, h: it.h },
    ];
    for (const c of candidates) {
      const box = clampBox(c);
      if (placed.some((p) => boxesOverlap(p.box, box))) continue;
      if (dots.some((d, i) => i !== index && boxesOverlap(d, box))) continue;
      placed.push({ index, box });
      break;
    }
  }
  return placed;
}

/** Splits a label into at most two lines that each fit `maxWidth` (word boundaries; the best split if none fits). */
export function wrapLabel(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  if (measure(text) <= maxWidth) return [text];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 2) return [text];
  let best: string[] = [text];
  let bestWidth = Infinity;
  for (let i = 1; i < words.length; i++) {
    const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const w = Math.max(...lines.map(measure));
    if (w < bestWidth) {
      bestWidth = w;
      best = lines;
    }
  }
  return best;
}

/** Minimap name for a POI: the short `<nameKey>.short` label when it exists, else the full name. */
export function minimapPoiLabel(nameKey: string): string {
  const short = `${nameKey}.short`;
  return hasKey(short) ? t(short) : t(nameKey);
}

// ---------------------------------------------------------------------------------------------
// M2a: aim down sights (HudView.ads)
// ---------------------------------------------------------------------------------------------
/** M2c: the sights with a full-screen overlay (hasScopeOverlay: 2x, 4x, 8x). */
export type ScopeSight = 'scope_2x' | 'scope_4x' | 'scope_8x';
export type DotSight = 'iron' | 'red_dot';

export interface AdsReticle {
  /** Hip crosshair opacity 0..1 (0 = hidden). */
  hip: number;
  /** Multiplier on the hip spread gap: the crosshair closes in toward the dot as the sight comes up. */
  gapScale: number;
  /** Over-shoulder sight reticle at the centre, or null. */
  dot: DotSight | null;
  dotOpacity: number;
  /** Full-screen scope overlay, or null. */
  scope: ScopeSight | null;
}

const q2 = (v: number): number => Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 50) / 50;

/** REVIEW-M2a L2: the shared helper (balance.ts), re-exported for the Ui modules and tests. */
export { isScopeSight };

/**
 * Crosshair state for this frame (STYLE.md §17, ARCHITECTURE §14 ui).
 * - No ADS / no sight: the normal hip crosshair.
 * - iron / red_dot: the hip crosshair closes and fades by `cameraBlend` while the sight dot fades in.
 * - scope_4x / scope_8x: same small dot while zooming in, then the full-screen scope once `scoped`.
 * M2b first person (UI.md §13.1): the viewmodel's own sight is the aim, so there is never a Ui dot; the hip reticle
 * fades and closes by `1 - cameraBlend` for every sight; scoped is unchanged.
 * Values are quantised (1/50) so the diffed DOM writes stay rare.
 */
export function adsReticle(ads: AdsView | null, firstPerson = false): AdsReticle {
  if (!ads || ads.sight === 'none') return { hip: 1, gapScale: 1, dot: null, dotOpacity: 0, scope: null };
  const b = q2(ads.cameraBlend);
  const sight = ads.sight as Exclude<M2cSightType, 'none'>;
  if (hasScopeOverlay(sight)) {
    if (ads.scoped) return { hip: 0, gapScale: 0, dot: null, dotOpacity: 0, scope: sight };
    if (firstPerson) return { hip: q2(1 - b), gapScale: q2(1 - b), dot: null, dotOpacity: 0, scope: null };
    return { hip: q2(1 - b), gapScale: q2(1 - b), dot: b > 0 ? 'iron' : null, dotOpacity: b, scope: null };
  }
  if (firstPerson) return { hip: q2(1 - b), gapScale: q2(1 - b), dot: null, dotOpacity: 0, scope: null };
  return { hip: q2(1 - b), gapScale: q2(1 - b), dot: b > 0 ? sight : null, dotOpacity: b, scope: null };
}

/**
 * M2b (UI.md §13.1): what the centre shows. 'full' = ticks + dot (a gun at the hip), 'dot' = the centre dot only
 * (fists, grenade in hand), 'spectate' = a dim dot where an FP spectate target looks, 'none' = nothing (aboard, falling,
 * chase / orbit cams, dead).
 */
export type ReticleMode = 'full' | 'dot' | 'spectate' | 'none';

export function reticleMode(o: {
  cameraView: 'firstPerson' | 'chase' | 'orbit' | undefined;
  alive: boolean;
  /** Aboard or dropping (freefall / chute). */
  airborne: boolean;
  /** HudLocalView.weapon, null when there is no local player. */
  weapon: string | null;
  spectating: boolean;
}): ReticleMode {
  if (o.alive && o.weapon !== null) {
    if (o.airborne || o.cameraView === 'orbit' || o.cameraView === 'chase') return 'none';
    // M2c: melee weapons and the smoke can are dot-only too (UI M2c §4).
    return o.weapon === 'fists' || o.weapon === 'grenade' || o.weapon === 'smoke' || isMeleeId(o.weapon) ? 'dot' : 'full';
  }
  return o.spectating && o.cameraView === 'firstPerson' ? 'spectate' : 'none';
}

// ---------------------------------------------------------------------------------------------
// M2a: armor pieces (vest + helmet icons with tier pips and durability)
// ---------------------------------------------------------------------------------------------
export interface GearView {
  state: 'none' | 'worn' | 'broken';
  tier: 0 | M2cArmorTier;
  /** 0..1, quantised. */
  ratio: number;
  /** "31/55", "Broken" or '' (empty slot). */
  text: string;
  /** At or below a quarter left: the bar gets the striped "low" pattern. */
  low: boolean;
}

/** `brokenTier` = tier of a piece that broke recently (shown crossed out for a moment), else 0. */
export function gearView(piece: HudArmorView | null, brokenTier: 0 | M2cArmorTier = 0): GearView {
  if (piece && piece.durability > 0) {
    const r = ratio(piece.durability, piece.maxDurability);
    return {
      state: 'worn',
      tier: piece.tier,
      ratio: Math.round(r * 100) / 100,
      text: t('hud.gear.durability', { current: Math.ceil(piece.durability), max: Math.ceil(piece.maxDurability) }),
      low: r <= 0.25,
    };
  }
  if (brokenTier > 0) return { state: 'broken', tier: brokenTier, ratio: 0, text: t('hud.gear.broken'), low: false };
  return { state: 'none', tier: 0, ratio: 0, text: '', low: false };
}

// ---------------------------------------------------------------------------------------------
// M2a: stance indicator
// ---------------------------------------------------------------------------------------------
export interface StanceViewModel {
  /** Icon to draw: the target stance (the transition animates toward it). */
  stance: Stance;
  moving: boolean;
  /** 0..1, quantised. */
  progress: number;
  labelKey: string;
}

export function stanceView(stance: Stance, from: Stance, progress: number): StanceViewModel {
  const p = q2(progress);
  return { stance, moving: from !== stance && p < 1, progress: from === stance ? 1 : p, labelKey: `hud.stance.${stance}` };
}

// ---------------------------------------------------------------------------------------------
// M2a: grenade cook ring
// ---------------------------------------------------------------------------------------------
/** grenades.md: the fuse ring turns red in the last second. */
export const COOK_URGENT_MS = 1000;

export interface CookViewModel {
  /** Fuse left, 0..1 (the ring empties). */
  ratio: number;
  urgent: boolean;
  /** Seconds left, rounded UP to tenths (never shows 0.0 while the grenade is still live). */
  seconds: number;
}

export function cookView(cook: HudCookView | null): CookViewModel | null {
  if (!cook) return null;
  const left = Math.max(0, Number.isFinite(cook.fuseRemainingMs) ? cook.fuseRemainingMs : 0);
  return {
    ratio: Math.round(ratio(left, cook.fuseMs) * 200) / 200,
    urgent: left <= COOK_URGENT_MS,
    seconds: Math.ceil(left / 100) / 10,
  };
}

// ---------------------------------------------------------------------------------------------
// M2a: grenade danger indicator
// ---------------------------------------------------------------------------------------------
export interface DangerPlacement {
  /**
   * CSS px offset from the screen centre (+x right, +y down). On-screen icons get y = 0: CSS drops them a fixed
   * em distance below the crosshair (between the cook text and the pickup prompt, which are em-sized too).
   */
  x: number;
  y: number;
  /** Pinned to the screen edge (pointer arrow shown) rather than drawn over the grenade's direction on screen. */
  edge: boolean;
  /** Pointer rotation, degrees clockwise from "up" (= the relative bearing). */
  arrowDeg: number;
}

/** Same 2.2:1 clamp as `.ui-hud` (ui.css), so edge icons stay inside the HUD box on ultrawide screens. */
export const HUD_MAX_ASPECT = 2.2;

/**
 * Where to draw a grenade danger icon. `bearing` is HudGrenadeDangerView.bearing (radians, 0 = ahead, +PI/2 = right).
 * Roughly ahead (inside 85% of the horizontal half-FOV) → on screen at the projected x, just under the crosshair
 * (grenades lie on the ground; the exact height is unknown to the HUD); otherwise on an ellipse just
 * inside the HUD box edge, like the damage arcs. Without the camera FOV everything goes to the edge.
 */
export function dangerPlacement(
  bearing: number,
  fovDeg: number | undefined,
  viewW: number,
  viewH: number,
  margin: number,
): DangerPlacement {
  const b = Number.isFinite(bearing) ? bearing : 0;
  const boxW = Math.min(viewW, viewH * HUD_MAX_ASPECT);
  const rx = Math.max(0, boxW / 2 - margin);
  const ry = Math.max(0, viewH / 2 - margin);
  const arrowDeg = Math.round((b * 180) / Math.PI);
  if (fovDeg !== undefined && fovDeg > 0 && viewH > 0) {
    const halfV = (Math.min(fovDeg, 170) * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * (viewW / viewH));
    if (Math.abs(b) <= halfH * 0.85) {
      const x = (Math.tan(b) / Math.tan(halfH)) * (viewW / 2);
      return {
        x: Math.round(Math.max(-rx, Math.min(rx, x))) + 0,
        y: 0,
        edge: false,
        arrowDeg,
      };
    }
  }
  // `+ 0` folds -0 into 0 (CSS does not care, but it keeps the values comparable).
  return { x: Math.round(rx * Math.sin(b)) + 0, y: Math.round(-ry * Math.cos(b)) + 0, edge: true, arrowDeg };
}

/**
 * M2a addendum (REVIEW-M2a M6): ring pulse period by fuse time left, so the icon blinks faster near detonation.
 * Without `fuseRemainingMs` (older producer) the calm rate is used. `urgent` (last second) also thickens the ring,
 * which is the cue that survives reduced motion.
 */
export function dangerBlink(fuseRemainingMs: number | undefined): { periodMs: number; urgent: boolean } {
  if (fuseRemainingMs === undefined || !Number.isFinite(fuseRemainingMs)) return { periodMs: 420, urgent: false };
  const ms = Math.max(0, fuseRemainingMs);
  if (ms <= 1000) return { periodMs: 110, urgent: true };
  if (ms <= 2000) return { periodMs: 220, urgent: false };
  return { periodMs: 420, urgent: false };
}

/** Presentation only: icons grow from 1x at this distance (m) and beyond to DANGER_MAX_SCALE at 0 m. */
export const DANGER_SCALE_FROM_M = 6;
export const DANGER_MAX_SCALE = 1.35;

export function dangerScale(distance: number): number {
  const d = Number.isFinite(distance) ? Math.max(0, distance) : DANGER_SCALE_FROM_M;
  const k = 1 - Math.min(1, d / DANGER_SCALE_FROM_M);
  return Math.round((1 + (DANGER_MAX_SCALE - 1) * k) * 20) / 20;
}

// ---------------------------------------------------------------------------------------------
// M2a: hit-marker variant (localHitConfirmed.vest / helmet)
// ---------------------------------------------------------------------------------------------
export interface HitVariant {
  head: boolean;
  kill: boolean;
  /** Absorbed by the target's vest (blue dashed ring). */
  vest: boolean;
  /** Absorbed by the target's helmet (dome cap). */
  helmet: boolean;
  /** A piece broke on this hit (shard burst). */
  broke: boolean;
}

export function hitVariant(e: {
  headshot: boolean;
  killed: boolean;
  vest: { broken: boolean } | null;
  helmet: { broken: boolean } | null;
}): HitVariant {
  return {
    head: e.headshot && !e.killed,
    kill: e.killed,
    vest: e.vest !== null && !e.killed,
    helmet: e.helmet !== null && !e.killed,
    broke: !e.killed && (e.vest?.broken === true || e.helmet?.broken === true),
  };
}

// ---------------------------------------------------------------------------------------------
// M2b: aboard / freefall / chute HUD (HudView.drop, drop.md "What the UI must show")
// ---------------------------------------------------------------------------------------------
export interface DropHudModel {
  stage: HudDropView['stage'];
  /** Centre prompt: the jump key (aboard), the steer reminder (falling). */
  promptKey: string;
  /** Aboard and the doors are still shut: the jump prompt is dimmed. */
  promptBlocked: boolean;
  /** Second prompt line (open chute now), or null. */
  secondKey: string | null;
  /** Top-centre timer chip: doors open in / auto-eject in, with "m:ss". null while falling. */
  timer: { key: string; time: string; urgent: boolean } | null;
  /** Aboard: players still aboard. */
  aboardCount: number | null;
  /** Falling: altitude bar 0..1 (of `maxAltitude`) and the auto-deploy marker 0..1; null aboard. */
  altitude: { ratio: number; deployRatio: number; metres: number; deployMetres: number } | null;
}

/** Seconds of auto-eject countdown at or below which the timer chip turns urgent. */
export const EJECT_URGENT_S = 5;

export function dropHudModel(drop: HudDropView, maxAltitude: number): DropHudModel {
  if (drop.stage === 'aboard') {
    const doorsShut = drop.noJumpSecondsLeft > 0;
    return {
      stage: 'aboard',
      promptKey: 'hud.carrier.jump',
      promptBlocked: doorsShut,
      secondKey: null,
      timer: doorsShut
        ? { key: 'hud.carrier.doorsIn', time: formatClock(drop.noJumpSecondsLeft), urgent: false }
        : { key: 'hud.carrier.eject', time: formatClock(drop.ejectSecondsLeft), urgent: drop.ejectSecondsLeft <= EJECT_URGENT_S },
      aboardCount: Math.max(0, drop.aboardCount),
      altitude: null,
    };
  }
  const top = Math.max(1, maxAltitude, drop.altitude, drop.deployHeight);
  const q = (v: number): number => Math.round(Math.min(1, Math.max(0, v / top)) * 200) / 200;
  return {
    stage: drop.stage,
    promptKey: 'hud.drop',
    promptBlocked: false,
    secondKey: drop.stage === 'freefall' && drop.canDeploy ? 'hud.chute.open' : null,
    timer: null,
    aboardCount: null,
    altitude: {
      ratio: q(drop.altitude),
      deployRatio: q(drop.deployHeight),
      metres: Math.max(0, Math.round(drop.altitude)),
      deployMetres: Math.max(0, Math.round(drop.deployHeight)),
    },
  };
}

/**
 * M2b: flight announcer moments from two consecutive aboard frames. 'doorsOpen' when jumping becomes allowed,
 * 'lastCall' when the auto-eject countdown reaches EJECT_URGENT_S.
 */
export function flightCue(prev: HudDropView | null, next: HudDropView | null): 'doorsOpen' | 'lastCall' | null {
  if (!prev || !next || prev.stage !== 'aboard' || next.stage !== 'aboard') return null;
  if (prev.noJumpSecondsLeft > 0 && next.noJumpSecondsLeft <= 0) return 'doorsOpen';
  if (next.noJumpSecondsLeft <= 0 && prev.ejectSecondsLeft > EJECT_URGENT_S && next.ejectSecondsLeft <= EJECT_URGENT_S) return 'lastCall';
  return null;
}
