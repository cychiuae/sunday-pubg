/**
 * Browser input binding: keyboard on `window`, mouse + pointer lock on the renderer canvas (ARCHITECTURE §8).
 * Everything game-relevant is forwarded to an InputState; this class only deals with DOM plumbing.
 *
 * - Input is ignored unless the pointer is locked to `target` (menus/overlays are open otherwise).
 * - Losing the lock or window focus releases all held keys so nothing sticks (the server would otherwise keep
 *   repeating the last held input).
 * - Clicking the canvas while unlocked requests the lock when `shouldLockOnClick()` says so.
 * - The context menu is suppressed on the canvas (RMB = aim down sights, M2a).
 * - Mouse look goes through LookFilter: the first locked move after taking the lock (the browser's re-centring
 *   spike) is dropped and single huge deltas are capped (BUG-002).
 */
import { InputState } from './InputState';
import { LookFilter } from './lookFilter';

/** What ClientGame needs from an input source. Tests supply a fake. */
export interface InputDriver {
  readonly state: InputState;
  isLocked(): boolean;
  /** Must be called from a user-gesture handler. */
  requestLock(): void;
  dispose(): void;
}

export interface InputControllerOptions {
  /** Called on canvas mousedown while unlocked. */
  shouldLockOnClick: () => boolean;
  /** Mouse-look spike filter; default `new LookFilter()`. */
  lookFilter?: LookFilter;
}

export class InputController implements InputDriver {
  private readonly cleanups: (() => void)[] = [];
  private readonly lookFilter: LookFilter;

  constructor(
    readonly state: InputState,
    private readonly target: HTMLElement,
    private readonly options: InputControllerOptions,
  ) {
    this.lookFilter = options.lookFilter ?? new LookFilter();
    const doc = target.ownerDocument;
    const win = doc.defaultView;

    const listen = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ): void => {
      el.addEventListener(type, fn);
      this.cleanups.push(() => el.removeEventListener(type, fn));
    };

    listen(target, 'mousedown', (e) => {
      if (!this.isLocked()) {
        if (e.button === 0 && this.options.shouldLockOnClick()) this.requestLock();
        return;
      }
      e.preventDefault();
      this.state.buttonDown(e.button);
    });
    // M2a: RMB is aim down sights, so the browser context menu never opens on the game canvas.
    listen(target, 'contextmenu', (e) => {
      e.preventDefault();
    });
    listen(target, 'wheel', (e) => {
      if (!this.isLocked()) return;
      e.preventDefault();
      this.state.wheel(e.deltaY);
    });

    const onMouseMove = (e: MouseEvent): void => {
      const d = this.lookFilter.filter(e.movementX, e.movementY, this.isLocked());
      if (d) this.state.look(d.dx, d.dy);
    };
    // Mouse up is tracked on the document so releasing outside the canvas still releases fire.
    const onMouseUp = (e: MouseEvent): void => this.state.buttonUp(e.button);
    const onLockChange = (): void => {
      this.lookFilter.onLockChange();
      if (!this.isLocked()) this.state.releaseAll();
    };
    doc.addEventListener('mousemove', onMouseMove);
    doc.addEventListener('mouseup', onMouseUp);
    doc.addEventListener('pointerlockchange', onLockChange);
    this.cleanups.push(() => {
      doc.removeEventListener('mousemove', onMouseMove);
      doc.removeEventListener('mouseup', onMouseUp);
      doc.removeEventListener('pointerlockchange', onLockChange);
    });

    if (win) {
      const onKeyDown = (e: KeyboardEvent): void => {
        if (!this.isLocked()) return;
        if (e.code === 'Escape') return; // the browser releases the lock itself
        if (this.state.keyDown(e.code, e.repeat)) e.preventDefault();
      };
      const onKeyUp = (e: KeyboardEvent): void => {
        // Always process key-up so a key released after unlocking does not stay held.
        if (this.state.keyUp(e.code) && this.isLocked()) e.preventDefault();
      };
      const onBlur = (): void => this.state.releaseAll();
      win.addEventListener('keydown', onKeyDown);
      win.addEventListener('keyup', onKeyUp);
      win.addEventListener('blur', onBlur);
      this.cleanups.push(() => {
        win.removeEventListener('keydown', onKeyDown);
        win.removeEventListener('keyup', onKeyUp);
        win.removeEventListener('blur', onBlur);
      });
    }
  }

  isLocked(): boolean {
    return this.target.ownerDocument.pointerLockElement === this.target;
  }

  requestLock(): void {
    if (this.isLocked()) return;
    try {
      const result: unknown = this.target.requestPointerLock();
      if (result instanceof Promise) {
        result.catch((err: unknown) => console.warn('[ClientGame] pointer lock rejected', err));
      }
    } catch (err) {
      console.warn('[ClientGame] pointer lock failed', err);
    }
  }

  dispose(): void {
    for (const fn of this.cleanups.splice(0)) fn();
    this.state.releaseAll();
    if (this.isLocked()) this.target.ownerDocument.exitPointerLock();
  }
}
