/**
 * Tiny DOM helpers with change-diffing so per-frame update() only writes when a value changes.
 * Owner: ui-ux-designer. Never use innerHTML with game data (player names are user input).
 */

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | null | undefined | false;

/** Creates an element. `cls` is a space-separated class list. Boolean attrs: true = present, false/null = absent. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Node[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) el.appendChild(c);
  return el;
}

/** A text node holder that only writes when the string changes. */
export class TextSlot {
  private value: string | null = null;
  constructor(readonly el: HTMLElement) {}
  set(text: string): void {
    if (text === this.value) return;
    this.value = text;
    this.el.textContent = text;
  }
}

/** Diffed boolean class toggles / visibility on one element. */
export class Flags {
  private readonly state = new Map<string, boolean>();
  constructor(readonly el: Element) {}
  set(cls: string, on: boolean): void {
    if (this.state.get(cls) === on) return;
    this.state.set(cls, on);
    this.el.classList.toggle(cls, on);
  }
}

/** Diffed `hidden` flag. Visible elements are display-controlled by CSS ([hidden] → display:none). */
export class Shown {
  private value: boolean | null = null;
  constructor(readonly el: HTMLElement) {}
  set(visible: boolean): boolean {
    if (visible === this.value) return false;
    this.value = visible;
    this.el.hidden = !visible;
    return true;
  }
  get visible(): boolean {
    return this.value === true;
  }
}

/** Diffed CSS custom property / style write (quantised by the caller). */
export class StyleVar {
  private value: string | null = null;
  constructor(
    readonly el: HTMLElement,
    readonly prop: string,
  ) {}
  set(v: string): void {
    if (v === this.value) return;
    this.value = v;
    this.el.style.setProperty(this.prop, v);
  }
}

/**
 * Restarts a one-shot CSS animation class without forcing layout (no offsetWidth read):
 * remove now, re-add on the next animation frame.
 */
export function retrigger(el: Element, cls: string): void {
  el.classList.remove(cls);
  requestAnimationFrame(() => el.classList.add(cls));
}
