/**
 * M2b rooms: pure, DOM-free helpers for the room browser, the create/settings dialog, the waiting room, deep links and
 * the room toasts (docs/ui/UI.md §12). Unit-tested in node (roomLogic.test.ts).
 * Owner: ui-ux-designer.
 */
import { hasKey } from '../content/strings';
import type { StringVars } from '../content/strings';
import type { RoomListEntryView, RoomMemberView, RoomView } from '../shared/contracts';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  normalizeRoomCode,
  type MapId,
  type MapPickVia,
  type MapVoteOption,
  type RoomMapMode,
} from '../shared/types';
import { formatClock } from './logic';

// ---------------------------------------------------------------------------------------------
// Map labels and glyphs
// ---------------------------------------------------------------------------------------------
/**
 * Short map name (browser rows, vote buttons). The vote keys are named by the map's family, not its id
 * (`island01` → `lobby.vote.island`), so the mapping is explicit; unknown ids use the full `map.<id>.name`.
 */
export function mapShortKey(id: MapId): string {
  if (id === 'island01') return 'lobby.vote.island';
  if (id === 'office') return 'lobby.vote.office';
  return `map.${id}.name`;
}

export const mapNameKey = (id: MapId): string => `map.${id}.name`;

/** Room map setting label: a map, or "Vote". */
export function mapModeKey(mode: RoomMapMode): string {
  return mode === 'vote' ? 'room.map.vote' : mapShortKey(mode);
}

export function voteOptionKey(option: MapVoteOption): string {
  return option === 'random' ? 'lobby.vote.random' : mapShortKey(option);
}

/** Shape glyph next to a map name (never colour alone): island ◆, office ▣, vote ◈, random ?. */
export type MapGlyph = 'island' | 'office' | 'vote' | 'random' | 'map';

export function mapGlyph(v: RoomMapMode | MapVoteOption): MapGlyph {
  if (v === 'vote' || v === 'random') return v;
  if (v === 'island01') return 'island';
  if (v === 'office') return 'office';
  return 'map';
}

// ---------------------------------------------------------------------------------------------
// Room browser
// ---------------------------------------------------------------------------------------------
export type StatusGlyph = 'waiting' | 'starting' | 'playing' | 'results';

export interface RoomStatusText {
  key: string;
  vars: StringVars;
  glyph: StatusGlyph;
}

export function roomStatusText(entry: Pick<RoomListEntryView, 'status' | 'elapsedSeconds'>): RoomStatusText {
  switch (entry.status) {
    case 'waiting':
      return { key: 'browser.status.waiting', vars: {}, glyph: 'waiting' };
    case 'countdown':
      return { key: 'browser.status.countdown', vars: {}, glyph: 'starting' };
    case 'playing':
      return { key: 'browser.status.playing', vars: { time: formatClock(entry.elapsedSeconds ?? 0) }, glyph: 'playing' };
    case 'results':
      return { key: 'browser.status.results', vars: {}, glyph: 'results' };
  }
}

export function isRoomFull(entry: Pick<RoomListEntryView, 'humans' | 'maxHumans'>): boolean {
  return entry.humans >= entry.maxHumans;
}

/** Room-list count announcements are polite and at most this often (UI.md §12.6). */
export const ROOM_COUNT_ANNOUNCE_MS = 5000;

// ---------------------------------------------------------------------------------------------
// Join by code
// ---------------------------------------------------------------------------------------------
export type CodeCheck = { ok: true; code: string } | { ok: false; error: 'empty' | 'length' | 'chars' };

/**
 * Client check on Join / Enter (UI.md §12.2). Spaces and dashes are allowed while typing and stripped; case does not
 * matter. A character outside the alphabet wins over a wrong length, because a player who typed O or 0 needs to know why.
 */
export function checkRoomCode(raw: string, length = ROOM_CODE_LENGTH, alphabet = ROOM_CODE_ALPHABET): CodeCheck {
  const c = raw.toUpperCase().replace(/[\s-]/g, '');
  if (c.length === 0) return { ok: false, error: 'empty' };
  for (const ch of c) if (!alphabet.includes(ch)) return { ok: false, error: 'chars' };
  if (c.length !== length) return { ok: false, error: 'length' };
  const code = length === ROOM_CODE_LENGTH && alphabet === ROOM_CODE_ALPHABET ? normalizeRoomCode(c) : c;
  return code ? { ok: true, code } : { ok: false, error: 'chars' };
}

/** What the field shows while typing: upper case, with any character other than letters, digits, spaces and dashes removed. */
export function formatCodeTyping(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9\s-]/g, '');
}

export function codeErrorKey(error: 'length' | 'chars'): string {
  return error === 'length' ? 'browser.code.error.length' : 'browser.code.error.chars';
}

/** Inline error for a refused join (GameEvent roomJoinFailed). */
export function joinFailedKey(reason: 'notFound' | 'full' | 'closed' | 'rateLimited' | 'badCode' | 'kicked'): string {
  switch (reason) {
    case 'notFound':
      return 'browser.error.notFound';
    case 'full':
      return 'browser.error.full';
    case 'closed':
      return 'browser.error.closed';
    case 'rateLimited':
      return 'browser.error.rateLimited';
    case 'badCode':
      return 'browser.code.error.chars';
    case 'kicked':
      // The rejoin cooldown after a kick: the dedicated line when narrative adds it.
      return hasKey('browser.error.kicked') ? 'browser.error.kicked' : 'room.toast.kicked';
  }
}

/** Inline error for a refused create (GameEvent roomCreateFailed). */
export function createFailedKey(reason: 'roomLimit' | 'rateLimited' | 'badSettings' | 'busy'): string {
  switch (reason) {
    case 'roomLimit':
      return 'browser.error.roomLimit';
    case 'rateLimited':
      return 'browser.error.rateLimited';
    case 'badSettings':
      return 'browser.error.badSettings';
    case 'busy':
      return hasKey('browser.error.busy') ? 'browser.error.busy' : 'browser.error.roomLimit';
  }
}

// ---------------------------------------------------------------------------------------------
// Create / settings dialog
// ---------------------------------------------------------------------------------------------
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Same rule as player names: strip control characters, trim, cap at `max` code points. */
export function sanitizeRoomName(raw: string, max: number): string {
  const cleaned = raw.replace(CONTROL_CHARS, '').trim();
  return Array.from(cleaned).slice(0, Math.max(1, max)).join('').trim();
}

/**
 * The `name` to send: null keeps the server default ("{host}'s room", rendered by each client), so leaving the
 * prefilled default untouched never pins today's host name. Returns undefined when the name is empty (inline error).
 */
export function roomNameToSend(raw: string, renderedDefault: string, max: number): string | null | undefined {
  const name = sanitizeRoomName(raw, max);
  if (name.length === 0) return undefined;
  return name === sanitizeRoomName(renderedDefault, max) ? null : name;
}

/** Max-players slider range. When editing, it never goes below the current member count (rooms.md). */
export function maxHumansRange(limits: { maxHumansMin: number; maxHumansMax: number }, members = 0): { min: number; max: number } {
  const max = Math.max(1, limits.maxHumansMax);
  return { min: Math.min(max, Math.max(1, limits.maxHumansMin, members)), max };
}

// ---------------------------------------------------------------------------------------------
// Waiting room
// ---------------------------------------------------------------------------------------------
/** The host counts as ready (rooms.md; the host has no ready tick). */
export function readySummary(members: readonly Pick<RoomMemberView, 'isHost' | 'ready'>[]): { ready: number; count: number } {
  let ready = 0;
  for (const m of members) if (m.isHost || m.ready) ready++;
  return { ready, count: members.length };
}

export type MemberStatus = 'host' | 'ready' | 'notReady' | 'watching' | 'playing';

/** Status chip of one member row: glyph + text, never colour alone. */
export function memberStatus(m: Pick<RoomMemberView, 'isHost' | 'ready' | 'spectating' | 'inMatch'>, roomBusy: boolean): MemberStatus {
  if (m.spectating) return 'watching';
  if (roomBusy && m.inMatch) return 'playing';
  if (m.isHost) return 'host';
  return m.ready ? 'ready' : 'notReady';
}

export interface StartButtonState {
  /** Shown at all (host, waiting phase). */
  show: boolean;
  enabled: boolean;
  /** Sub-label under a disabled Start, or null. */
  reasonKey: string | null;
}

export function startButtonState(room: Pick<RoomView, 'isLocalHost' | 'phase' | 'canStart' | 'startBlockedReason'>): StartButtonState {
  const show = room.isLocalHost && room.phase === 'waiting';
  if (!show) return { show, enabled: false, reasonKey: null };
  if (room.canStart) return { show, enabled: true, reasonKey: null };
  const key = room.startBlockedReason ? `room.start.${room.startBlockedReason}` : 'room.start.needHuman';
  return { show, enabled: false, reasonKey: hasKey(key) ? key : null };
}

/** Map card title: "Next map: …" once the vote locked, "Map: …" for a fixed or pinned map. */
export function mapCardTitle(map: { id: MapId; via: MapPickVia } | null, fixed: MapId | null): { key: string; mapId: MapId } | null {
  if (map) {
    if (map.via === 'random') return { key: 'lobby.vote.lockedRandom', mapId: map.id };
    if (map.via === 'vote' || map.via === 'rotation') return { key: 'lobby.vote.locked', mapId: map.id };
    return { key: 'lobby.map', mapId: map.id };
  }
  return fixed ? { key: 'lobby.map', mapId: fixed } : null;
}

/** Vote panel or map card? The vote stays live until the lock resolves the map. */
export function showVotePanel(room: Pick<RoomView, 'vote' | 'map'>): boolean {
  return room.vote !== null && room.map === null && !room.vote.locked;
}

/** Countdown announcements are polite at these seconds only (UI.md §12.6). */
export const COUNTDOWN_ANNOUNCE: readonly number[] = [10, 5, 3, 2, 1];

/** Two-step confirm (kick, leave during the countdown): the armed state lasts this long. */
export const CONFIRM_MS = 3000;

// ---------------------------------------------------------------------------------------------
// Deep links (UI.md §12.9)
// ---------------------------------------------------------------------------------------------
export interface DeepLink {
  /** Valid `?room=` code, normalised. */
  room: string | null;
  /** `?room=` was present but not a valid code (the browser says so once). */
  roomInvalid: boolean;
  /** `?map=` lower-cased (validated against the server's maps when used). */
  map: string | null;
}

export function parseDeepLink(search: string): DeepLink {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return { room: null, roomInvalid: false, map: null };
  }
  const rawRoom = params.get('room');
  const room = rawRoom !== null ? normalizeRoomCode(rawRoom) : null;
  const rawMap = params.get('map');
  const map = rawMap !== null && /^[a-z0-9_-]{1,32}$/i.test(rawMap) ? rawMap.toLowerCase() : null;
  return { room, roomInvalid: rawRoom !== null && room === null, map };
}

/** `?map=` as a vote option for this room, or null when the server does not offer it. */
export function deepLinkVote(map: string | null, offered: readonly MapId[]): MapVoteOption | null {
  if (map === null) return null;
  if (map === 'random') return 'random';
  if (map === 'island') return offered.includes('island01') ? 'island01' : null;
  return offered.includes(map) ? map : null;
}

/** The URL with `?room=` set (or removed for null), every other param and the hash kept. */
export function withRoomParam(href: string, code: string | null): string {
  const url = new URL(href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  return url.toString();
}

/** Invite link for the Copy-link button: this page with only `?room=CODE`. */
export function inviteLink(origin: string, pathname: string, code: string): string {
  return `${origin}${pathname}?room=${encodeURIComponent(code)}`;
}

// ---------------------------------------------------------------------------------------------
// Join / leave toast throttle (UI.md §12.8: max 1 per 2 s, then "+N more")
// ---------------------------------------------------------------------------------------------
export const MEMBER_TOAST_GAP_MS = 2000;

export class MemberToastThrottle {
  private lastAt = -Infinity;
  private pending = 0;

  constructor(private readonly gapMs = MEMBER_TOAST_GAP_MS) {}

  /** True = show this one now; false = folded into the next "+N more". */
  offer(nowMs: number): boolean {
    if (nowMs - this.lastAt >= this.gapMs && this.pending === 0) {
      this.lastAt = nowMs;
      return true;
    }
    this.pending++;
    return false;
  }

  /** Call every frame: the "+N more" count to show now, else 0. */
  flush(nowMs: number): number {
    if (this.pending === 0 || nowMs - this.lastAt < this.gapMs) return 0;
    const n = this.pending;
    this.pending = 0;
    this.lastAt = nowMs;
    return n;
  }

  reset(): void {
    this.pending = 0;
    this.lastAt = -Infinity;
  }
}
