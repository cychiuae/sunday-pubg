/**
 * Kill feed (top-left) plus the two timed message slots: announcer banner and one-time hints.
 * M2c (docs/ui/M2c.md §8): rocket / melee routing (logic.killFeedPrefix), the rocket glyph on rocket lines, and the
 * killer's weapon icon + level badge after the sentence (none for fists, frags, smoke, zone, fall, self-kills).
 * Owner: ui-ux-designer.
 */
import { t, type StringVars } from '../content/strings';
import { h, retrigger } from './dom';
import type { ItemLevel } from '../shared/types';
import { icon, levelBadge, setLevelBadge } from './icons';
import {
  isGrenadeFeedPrefix,
  isRocketFeedPrefix,
  killFeedPrefix,
  killWeaponTag,
  levelLabel,
  MessageQueue,
  pickVariantKey,
  splitTemplate,
  type KillInfo,
} from './logic';

const FEED_MAX = 5;
const FEED_MS = 6000;

interface FeedEntry {
  el: HTMLElement;
  until: number;
}

export interface FeedKill extends KillInfo {
  headshot: boolean;
  /** M2c: the kill weapon's level (playerKilled.weaponLevel). */
  weaponLevel?: ItemLevel | null;
  isLocalKiller: boolean;
  isLocalVictim: boolean;
}

export class KillFeed {
  readonly el: HTMLOListElement;
  private readonly entries: FeedEntry[] = [];

  constructor(private readonly rng: () => number = Math.random) {
    this.el = h('ol', 'ui-feed', { 'aria-live': 'polite', 'aria-relevant': 'additions' });
  }

  add(k: FeedKill, nowMs: number): void {
    const prefix = killFeedPrefix(k, k.headshot);
    const key = pickVariantKey(prefix, this.rng);
    const vars: StringVars = {
      killer: k.killerName ?? '',
      victim: k.victimName,
      weapon: k.weapon ? t(`item.${k.weapon}.name`) : '',
    };
    const li = h('li', 'ui-feed__item');
    if (k.isLocalKiller) li.classList.add('is-mine');
    if (k.isLocalVictim) li.classList.add('is-me');
    if (k.headshot && (prefix === 'feed.headshot' || prefix === 'feed.meleeHeadshot')) {
      li.appendChild(h('span', 'ui-glyph ui-glyph--target', { 'aria-hidden': 'true' }));
    }
    // M2a: grenade / explosion kills (and self-grenade lines) lead with the pineapple icon (STYLE.md §18).
    if (isGrenadeFeedPrefix(prefix)) {
      li.classList.add('is-grenade');
      li.appendChild(icon('grenade', 'ui-feed__icon'));
    }
    // M2c: rocket lines lead with the rocket glyph (like the pineapple).
    if (isRocketFeedPrefix(prefix)) {
      li.classList.add('is-rocket');
      li.appendChild(icon('ammo_rocket', 'ui-feed__icon'));
    }
    for (const part of splitTemplate(t(key), vars)) {
      if (part.varName === 'killer' || part.varName === 'victim') {
        li.appendChild(h('b', `ui-feed__name ui-feed__name--${part.varName}`, null, part.text));
      } else if (part.varName === 'weapon') {
        li.appendChild(h('span', 'ui-feed__weapon', null, part.text));
      } else {
        li.appendChild(document.createTextNode(part.text));
      }
    }
    // M2c: weapon icon + level badge after the line (the numeral is the non-colour tell).
    const tag = killWeaponTag(k, k.weaponLevel);
    if (tag) {
      const badge = levelBadge('ui-feed__badge');
      setLevelBadge(badge, tag.level);
      const sr = tag.level !== null ? h('span', 'ui-sr', null, ` ${levelLabel(tag.level)}`) : null;
      li.appendChild(h('span', 'ui-feed__tag', null, icon(tag.weapon, 'ui-feed__icon'), badge, sr));
    }
    this.el.appendChild(li);
    this.entries.push({ el: li, until: nowMs + FEED_MS });
    while (this.entries.length > FEED_MAX) this.entries.shift()?.el.remove();
  }

  update(nowMs: number): void {
    while (this.entries.length > 0 && (this.entries[0]?.until ?? 0) <= nowMs) this.entries.shift()?.el.remove();
  }

  clear(): void {
    for (const e of this.entries) e.el.remove();
    this.entries.length = 0;
  }
}

export interface Message {
  key: string;
  vars: StringVars;
  /** 'big' banners for match moments, 'warn' for tide alerts. */
  tone: 'normal' | 'big' | 'warn';
}

/** One message at a time from a queue; each new message replays the entry animation. */
export class MessageSlot {
  readonly el: HTMLDivElement;
  private readonly queue: MessageQueue<Message>;
  private shownId: string | null = null;

  constructor(
    cls: string,
    private readonly defaultMs: number,
    role: 'status' | 'alert' = 'status',
  ) {
    this.el = h('div', cls, { role, 'aria-live': role === 'alert' ? 'assertive' : 'polite' });
    this.el.hidden = true;
    this.queue = new MessageQueue<Message>(4);
  }

  push(id: string, msg: Message, durationMs = this.defaultMs): void {
    this.queue.push({ id, payload: msg, durationMs });
  }

  /** Returns the id currently shown (or null). */
  update(nowMs: number): string | null {
    const cur = this.queue.update(nowMs);
    const id = cur ? cur.id : null;
    if (id !== this.shownId) {
      this.shownId = id;
      this.el.hidden = cur === null;
      if (cur) {
        this.el.textContent = t(cur.payload.key, cur.payload.vars);
        this.el.dataset['tone'] = cur.payload.tone;
        retrigger(this.el, 'is-in');
      }
    }
    return id;
  }

  clear(): void {
    this.queue.clear();
  }
}
