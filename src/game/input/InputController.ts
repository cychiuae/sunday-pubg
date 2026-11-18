/**
 * Browser input binding: keyboard on `window`, mouse + pointer lock on the renderer canvas (ARCHITECTURE §8).
 * Everything game-relevant is forwarded to an InputState; this class only deals with DOM plumbing.
 *
 * - Input is ignored unless the pointer is locked to `target` (menus/overlays are open otherwise).
 * - Losing the lock or window focus releases all held keys so nothing sticks (the server would otherwise keep
 *   repeating the last held input).
 * - Clicking the canvas while unlocked requests the lock when `shouldLockOnClick()` says so.
 */
import { InputState } from './InputState';

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
}

export class InputController implements InputDriver {
  private readonly cleanups: (() => void)[] = [];

  constructor(
    readonly state: InputState,
    private readonly target: HTMLElement,
    private readonly options: InputControllerOptions,
  ) {
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
    listen(target, 'contextmenu', (e) => {
      if (this.isLocked()) e.preventDefault();
    });
    listen(target, 'wheel', (e) => {
      if (!this.isLocked()) return;
      e.preventDefault();
      this.state.wheel(e.deltaY);
    });

    const onMouseMove = (e: MouseEvent): void => {
      if (this.isLocked()) this.state.look(e.movementX, e.movementY);
    };
    // Mouse up is tracked on the document so releasing outside the canvas still releases fire.
    const onMouseUp = (e: MouseEvent): void => this.state.buttonUp(e.button);
    const onLockChange = (): void => {
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
