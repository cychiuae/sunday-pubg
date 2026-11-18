/**
 * Item / weapon glyphs. Every item has a distinct SHAPE as well as its family colour, so nothing is told
 * apart by colour alone (docs/ui/UI.md, "Accessibility"). Pure CSS shapes: no image assets.
 * Owner: ui-ux-designer.
 */
import type { ItemId, WeaponId } from '../shared/types';
import { h } from './dom';

export type IconId = ItemId | WeaponId;

const SHAPE: Record<IconId, string> = {
  fists: 'ring',
  pistol: 'circle',
  smg: 'triangle',
  shotgun: 'square',
  rifle: 'diamond',
  ammo_light: 'circle',
  ammo_heavy: 'diamond',
  ammo_shell: 'square',
  bandage: 'plus',
  medkit: 'crossbox',
  vest: 'shield',
};

/** Family colours (palette: weapons/ammo share a family colour; see materials.ts). */
const COLOUR: Record<IconId, string> = {
  fists: '#fffaf0',
  pistol: '#ffc43d',
  smg: '#2ec4b6',
  shotgun: '#e94f37',
  rifle: '#3e9b5a',
  ammo_light: '#ffc43d',
  ammo_heavy: '#3e9b5a',
  ammo_shell: '#e94f37',
  bandage: '#ff8fb1',
  medkit: '#2fb36b',
  vest: '#4fa8ff',
};

export function iconShape(id: IconId): string {
  return SHAPE[id];
}

/** A decorative glyph; the accompanying text label carries the meaning for assistive tech. */
export function icon(id: IconId | null, extraCls = ''): HTMLSpanElement {
  const el = h('span', `ui-icon ${extraCls}`.trim(), { 'aria-hidden': 'true' });
  setIcon(el, id);
  return el;
}

export function setIcon(el: HTMLElement, id: IconId | null): void {
  if (el.dataset['icon'] === (id ?? '')) return;
  el.dataset['icon'] = id ?? '';
  el.dataset['shape'] = id ? SHAPE[id] : 'none';
  el.style.setProperty('--icon-colour', id ? COLOUR[id] : 'transparent');
}
