/**
 * Pure, DOM-free UI helpers. Everything here is unit-tested in node (logic.test.ts).
 * Owner: ui-ux-designer.
 *
 * Angle convention (src/shared/types.ts): yaw 0 looks toward -Z, forward = (-sin yaw, 0, -cos yaw),
 * right = (cos yaw, 0, -sin yaw). The minimap is north-up with north = -Z.
 */
import { keysWithPrefix, type StringVars } from '../content/strings';
import { MAX_NAME_LENGTH } from '../shared/constants';
import type { GraphicsStatus, HudLocalView, HudZoneView } from '../shared/contracts';
import type {
  ActionFailReason,
  ConnectionStatus,
  DeathCause,
  FailedAction,
  ItemId,
  MatchPhase,
  Vec2,
  WeaponId,
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
export type ScreenId = 'title' | 'connecting' | 'connectionLost' | 'lobby' | 'match' | 'results';

export interface ScreenInputs {
  /** The player pressed Play (or Rejoin) at least once. */
  joinRequested: boolean;
  connection: ConnectionStatus;
  joined: boolean;
  phase: MatchPhase;
  /** Player pressed "Play again" on this results screen. */
  resultsDismissed: boolean;
}

/** Which full-screen state to show. In-match sub-states (alive / dead / spectating) are decided by the HUD. */
export function selectScreen(s: ScreenInputs): ScreenId {
  if (!s.joinRequested) return 'title';
  if (s.connection === 'disconnected' || s.connection === 'error') return 'connectionLost';
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
  weapon: WeaponId | null;
  cause: DeathCause;
}

/** Which `feed.*` variant group describes a kill. */
export function killFeedPrefix(k: KillInfo, headshot: boolean): string {
  if (k.cause === 'zone') return 'feed.zone';
  if (k.cause === 'fall') return 'feed.fall';
  if (k.killerName === null || k.weapon === null) return 'feed.generic';
  if (k.weapon === 'fists') return 'feed.melee';
  return headshot ? 'feed.headshot' : 'feed.kill';
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
export type ItemCategory = 'gun' | 'ammo' | 'heal' | 'armor';

export function itemCategory(item: ItemId): ItemCategory {
  switch (item) {
    case 'pistol':
    case 'smg':
    case 'shotgun':
    case 'rifle':
      return 'gun';
    case 'ammo_light':
    case 'ammo_heavy':
    case 'ammo_shell':
      return 'ammo';
    case 'bandage':
    case 'medkit':
      return 'heal';
    case 'vest':
      return 'armor';
  }
}

export interface PromptChoice {
  key: string;
  /** Item name is resolved by the caller (t(`item.${item}.name`)); qty is passed as `count`. */
  usesCount: boolean;
  /** True when the pickup will be refused (shown greyed with a lock glyph). */
  blocked: boolean;
}

/** Local fields the prompt reads. The M1-fix carry limits are optional until every producer fills them. */
export type PromptLocal = Pick<HudLocalView, 'slots' | 'armor' | 'maxArmor' | 'heals' | 'reserve'> &
  Partial<Pick<HudLocalView, 'healMax' | 'reserveMax' | 'ammoType'>>;

/** True when the pickup will be refused because that item is already at its carry limit (unknown limit = false). */
export function isCarryFull(item: ItemId, local: PromptLocal): boolean {
  if (item === 'bandage' || item === 'medkit') {
    const max = local.healMax?.[item];
    return max !== undefined && max > 0 && (local.heals[item] ?? 0) >= max;
  }
  if (itemCategory(item) === 'ammo') {
    // HudView only carries the reserve of the active weapon's ammo type, so other ammo types stay "unknown".
    const max = local.reserveMax;
    return local.ammoType === item && typeof max === 'number' && max > 0 && (local.reserve ?? 0) >= max;
  }
  return false;
}

/** Which prompt string to show for the loot in range. */
export function pickupPromptChoice(item: ItemId, qty: number, local: PromptLocal | null): PromptChoice {
  const cat = itemCategory(item);
  if (cat === 'gun') {
    const full = local !== null && local.slots[0].weapon !== null && local.slots[1].weapon !== null;
    return { key: full ? 'hud.pickup.swap' : 'hud.pickup', usesCount: false, blocked: false };
  }
  if (cat === 'armor' && local !== null && local.maxArmor > 0 && local.armor >= local.maxArmor) {
    return { key: 'hud.armor.better', usesCount: false, blocked: true };
  }
  if (local !== null && isCarryFull(item, local)) return { key: 'hud.inventory.full', usesCount: false, blocked: true };
  if (cat === 'ammo' || qty > 1) return { key: 'hud.pickup.ammo', usesCount: true, blocked: false };
  return { key: 'hud.pickup', usesCount: false, blocked: false };
}

// ---------------------------------------------------------------------------------------------
// Refused actions (GameEvent actionFailed, ARCHITECTURE.md §12 "Contract revision 1")
// ---------------------------------------------------------------------------------------------
/** String key for a refused action, or null when the UI should stay silent (fire is covered by dryFire). */
export function actionFailedKey(action: FailedAction, reason: ActionFailReason): string | null {
  if (action === 'fire') return null;
  switch (reason) {
    case 'noHeals':
      return 'hud.heal.none';
    case 'fullHp':
      return 'hud.heal.full';
    case 'inventoryFull':
      return 'hud.inventory.full';
    case 'betterArmor':
      return 'hud.armor.better';
    case 'noAmmo':
      return 'hud.ammo.empty';
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

export function tideStatus(zone: HudZoneView | null): TideStatus | null {
  if (!zone) return null;
  const clock = formatClock(zone.secondsLeft);
  if (zone.isFinal) return { key: 'hud.tide.final', vars: {}, urgent: true, clock };
  if (zone.shrinking) return { key: 'hud.tide.shrinking', vars: {}, urgent: true, clock };
  return { key: 'hud.tide.wait', vars: { time: clock }, urgent: false, clock: '' };
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

export function projectXZ(p: MapProjection, x: number, z: number): { px: number; py: number } {
  return { px: p.cx + x * p.scale, py: p.cy + z * p.scale };
}
