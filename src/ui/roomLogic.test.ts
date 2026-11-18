import { describe, expect, it } from 'vitest';
import { hasKey } from '../content/strings';
import { ROOM_CODE_ALPHABET } from '../shared/types';
import {
  checkRoomCode,
  codeErrorKey,
  createFailedKey,
  deepLinkVote,
  formatCodeTyping,
  inviteLink,
  isRoomFull,
  joinFailedKey,
  mapCardTitle,
  mapGlyph,
  mapModeKey,
  mapShortKey,
  maxHumansRange,
  memberStatus,
  MemberToastThrottle,
  parseDeepLink,
  readySummary,
  roomNameToSend,
  roomStatusText,
  sanitizeRoomName,
  showVotePanel,
  startButtonState,
  voteOptionKey,
  withRoomParam,
} from './roomLogic';

describe('rooms: map labels', () => {
  it('maps ids to the explicit vote keys and falls back to the full name', () => {
    expect(mapShortKey('island01')).toBe('lobby.vote.island');
    expect(mapShortKey('office')).toBe('lobby.vote.office');
    expect(mapShortKey('moon')).toBe('map.moon.name');
    expect(mapModeKey('vote')).toBe('room.map.vote');
    expect(voteOptionKey('random')).toBe('lobby.vote.random');
    expect(mapGlyph('island01')).toBe('island');
    expect(mapGlyph('office')).toBe('office');
    expect(mapGlyph('vote')).toBe('vote');
    expect(mapGlyph('random')).toBe('random');
    for (const k of ['island01', 'office', 'vote', 'random'] as const) {
      expect(hasKey(k === 'random' ? voteOptionKey(k) : mapModeKey(k))).toBe(true);
    }
  });
});

describe('rooms: browser rows', () => {
  it('status text with glyphs, ticking the elapsed time as m:ss', () => {
    expect(roomStatusText({ status: 'waiting', elapsedSeconds: null })).toEqual({ key: 'browser.status.waiting', vars: {}, glyph: 'waiting' });
    expect(roomStatusText({ status: 'countdown', elapsedSeconds: null }).glyph).toBe('starting');
    expect(roomStatusText({ status: 'playing', elapsedSeconds: 192 })).toEqual({ key: 'browser.status.playing', vars: { time: '3:12' }, glyph: 'playing' });
    expect(roomStatusText({ status: 'playing', elapsedSeconds: null }).vars).toEqual({ time: '0:00' });
    expect(roomStatusText({ status: 'results', elapsedSeconds: null }).key).toBe('browser.status.results');
    for (const s of ['waiting', 'countdown', 'playing', 'results'] as const) expect(hasKey(roomStatusText({ status: s, elapsedSeconds: 1 }).key)).toBe(true);
  });

  it('full rooms', () => {
    expect(isRoomFull({ humans: 8, maxHumans: 8 })).toBe(true);
    expect(isRoomFull({ humans: 7, maxHumans: 8 })).toBe(false);
  });
});

describe('rooms: join by code', () => {
  it('accepts lower case, spaces and dashes', () => {
    expect(checkRoomCode('k7mq2')).toEqual({ ok: true, code: 'K7MQ2' });
    expect(checkRoomCode(' k7-mq 2 ')).toEqual({ ok: true, code: 'K7MQ2' });
  });

  it('empty is a no-op, excluded characters beat a wrong length', () => {
    expect(checkRoomCode('  ')).toEqual({ ok: false, error: 'empty' });
    expect(checkRoomCode('K7M')).toEqual({ ok: false, error: 'length' });
    expect(checkRoomCode('K7MQ22')).toEqual({ ok: false, error: 'length' });
    for (const bad of ['0', 'O', '1', 'I', 'L']) expect(checkRoomCode(`K7M${bad}2`)).toEqual({ ok: false, error: 'chars' });
    expect(checkRoomCode('K0')).toEqual({ ok: false, error: 'chars' });
    // Vowels are not in the alphabet either (no accidental words).
    expect(ROOM_CODE_ALPHABET.includes('A')).toBe(false);
    expect(checkRoomCode('KAMQ2')).toEqual({ ok: false, error: 'chars' });
  });

  it('typing format and error keys', () => {
    expect(formatCodeTyping('k7-mq!2')).toBe('K7-MQ2');
    expect(codeErrorKey('length')).toBe('browser.code.error.length');
    expect(codeErrorKey('chars')).toBe('browser.code.error.chars');
    for (const r of ['notFound', 'full', 'closed', 'rateLimited', 'badCode', 'kicked'] as const) expect(hasKey(joinFailedKey(r))).toBe(true);
    for (const r of ['roomLimit', 'rateLimited', 'badSettings', 'busy'] as const) expect(hasKey(createFailedKey(r))).toBe(true);
    expect(joinFailedKey('notFound')).toBe('browser.error.notFound');
  });
});

describe('rooms: create dialog', () => {
  it('sanitises the name like player names', () => {
    expect(sanitizeRoomName('  Desk\u0007 Wars  ', 24)).toBe('Desk Wars');
    expect(sanitizeRoomName('x'.repeat(40), 24)).toHaveLength(24);
  });

  it('sends null for the untouched default and undefined for an empty name', () => {
    expect(roomNameToSend("Mango's room", "Mango's room", 24)).toBeNull();
    expect(roomNameToSend("  Mango's room ", "Mango's room", 24)).toBeNull();
    expect(roomNameToSend('Snack Attack', "Mango's room", 24)).toBe('Snack Attack');
    expect(roomNameToSend('   ', "Mango's room", 24)).toBeUndefined();
  });

  it('max players never below the current member count', () => {
    expect(maxHumansRange({ maxHumansMin: 1, maxHumansMax: 16 })).toEqual({ min: 1, max: 16 });
    expect(maxHumansRange({ maxHumansMin: 1, maxHumansMax: 16 }, 5)).toEqual({ min: 5, max: 16 });
    expect(maxHumansRange({ maxHumansMin: 1, maxHumansMax: 16 }, 30)).toEqual({ min: 16, max: 16 });
  });
});

describe('rooms: waiting room', () => {
  const m = (isHost: boolean, ready: boolean, extra: Partial<{ spectating: boolean; inMatch: boolean }> = {}) => ({
    isHost,
    ready,
    spectating: false,
    inMatch: false,
    ...extra,
  });

  it('the host counts as ready', () => {
    expect(readySummary([m(true, false), m(false, true), m(false, false)])).toEqual({ ready: 2, count: 3 });
    expect(readySummary([])).toEqual({ ready: 0, count: 0 });
  });

  it('member status chips', () => {
    expect(memberStatus(m(true, false), false)).toBe('host');
    expect(memberStatus(m(false, true), false)).toBe('ready');
    expect(memberStatus(m(false, false), false)).toBe('notReady');
    expect(memberStatus(m(false, false, { spectating: true }), true)).toBe('watching');
    expect(memberStatus(m(false, false, { inMatch: true }), true)).toBe('playing');
    expect(memberStatus(m(false, false, { inMatch: true }), false)).toBe('notReady');
  });

  it('Start: host and waiting only; a disabled Start says why when the string exists', () => {
    const base = { isLocalHost: true, phase: 'waiting' as const, canStart: true, startBlockedReason: null };
    expect(startButtonState(base)).toEqual({ show: true, enabled: true, reasonKey: null });
    expect(startButtonState({ ...base, isLocalHost: false }).show).toBe(false);
    expect(startButtonState({ ...base, phase: 'countdown' }).show).toBe(false);
    const blocked = startButtonState({ ...base, canStart: false, startBlockedReason: 'needTwoWithoutBots' });
    expect(blocked.enabled).toBe(false);
    expect(blocked.reasonKey === null || hasKey(blocked.reasonKey)).toBe(true);
    expect(startButtonState({ ...base, canStart: false }).reasonKey).toBe('room.start.needHuman');
  });

  it('map card title and vote panel visibility', () => {
    expect(mapCardTitle(null, null)).toBeNull();
    expect(mapCardTitle(null, 'office')).toEqual({ key: 'lobby.map', mapId: 'office' });
    expect(mapCardTitle({ id: 'office', via: 'vote' }, null)).toEqual({ key: 'lobby.vote.locked', mapId: 'office' });
    expect(mapCardTitle({ id: 'office', via: 'rotation' }, null)?.key).toBe('lobby.vote.locked');
    expect(mapCardTitle({ id: 'island01', via: 'random' }, null)?.key).toBe('lobby.vote.lockedRandom');
    expect(mapCardTitle({ id: 'island01', via: 'pinned' }, null)?.key).toBe('lobby.map');
    const vote = { options: [], mine: null, locked: false, pinned: false };
    expect(showVotePanel({ vote, map: null })).toBe(true);
    expect(showVotePanel({ vote: { ...vote, locked: true }, map: null })).toBe(false);
    expect(showVotePanel({ vote, map: { id: 'office', via: 'vote' } })).toBe(false);
    expect(showVotePanel({ vote: null, map: null })).toBe(false);
  });
});

describe('rooms: deep links', () => {
  it('parses ?room= with normalizeRoomCode and flags broken codes', () => {
    expect(parseDeepLink('?room=k7mq2')).toEqual({ room: 'K7MQ2', roomInvalid: false, map: null });
    expect(parseDeepLink('?room=k7-mq2&map=Office')).toEqual({ room: 'K7MQ2', roomInvalid: false, map: 'office' });
    expect(parseDeepLink('?room=OOPS1')).toEqual({ room: null, roomInvalid: true, map: null });
    expect(parseDeepLink('')).toEqual({ room: null, roomInvalid: false, map: null });
    expect(parseDeepLink('?map=<script>').map).toBeNull();
  });

  it('?map= becomes a vote only for maps the server offers', () => {
    expect(deepLinkVote('office', ['island01', 'office'])).toBe('office');
    expect(deepLinkVote('island', ['island01', 'office'])).toBe('island01');
    expect(deepLinkVote('random', ['island01'])).toBe('random');
    expect(deepLinkVote('moon', ['island01', 'office'])).toBeNull();
    expect(deepLinkVote(null, ['island01'])).toBeNull();
  });

  it('keeps other params when syncing ?room=, and builds the invite link', () => {
    expect(withRoomParam('https://x.test/play?map=office#a', 'K7MQ2')).toBe('https://x.test/play?map=office&room=K7MQ2#a');
    expect(withRoomParam('https://x.test/play?room=K7MQ2&map=office', null)).toBe('https://x.test/play?map=office');
    expect(inviteLink('https://x.test', '/play', 'K7MQ2')).toBe('https://x.test/play?room=K7MQ2');
  });
});

describe('rooms: join / leave toast throttle', () => {
  it('shows one per 2 s, then folds the rest into "+N more"', () => {
    const th = new MemberToastThrottle(2000);
    expect(th.offer(0)).toBe(true);
    expect(th.offer(100)).toBe(false);
    expect(th.offer(200)).toBe(false);
    expect(th.flush(1000)).toBe(0);
    expect(th.flush(2000)).toBe(2);
    expect(th.flush(2100)).toBe(0);
    // While a "+N" is pending, new ones join it instead of jumping the queue.
    expect(th.offer(3000)).toBe(false);
    expect(th.flush(4000)).toBe(1);
    expect(th.offer(6100)).toBe(true);
    th.reset();
    expect(th.offer(6200)).toBe(true);
  });
});
