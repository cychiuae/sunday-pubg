/**
 * Mouse-look spike filter (BUG-002). Owner: game-developer. Pure; InputController feeds it every mousemove.
 *
 * When pointer lock engages, Chromium reports the cursor's jump back to the lock point as one mousemove of hundreds
 * of pixels (measured: (-639, -275) at 1280x720), and some Windows/Chrome setups emit similar one-off spikes. Fed
 * into look() that snaps the view by tens of degrees.
 * - The first locked mousemove of every lock session is dropped (the session starts when the lock is taken, as
 *   seen by either `pointerlockchange` or a mousemove while locked, whichever comes first).
 * - Any later event whose movement is longer than `maxDeltaPx` is scaled down to that length (direction kept), so
 *   a stray spike turns the view by at most maxDeltaPx * radiansPerPixel while fast real flicks still turn.
 */

/**
 * Default cap. A fast human flick at 1000 Hz polling is well under 100 px per event and at 125 Hz rarely above
 * 300 px. Not a gameplay number; candidate for `clientFeel.lookMaxDeltaPx` (needs a ClientFeelBalance key).
 */
export const DEFAULT_LOOK_MAX_DELTA_PX = 300;

export class LookFilter {
  /** True until the first locked mousemove of the current lock session has been dropped. */
  private armed = true;

  constructor(private readonly maxDeltaPx: number = DEFAULT_LOOK_MAX_DELTA_PX) {}

  /** pointerlockchange: any change (lock or unlock) starts a new session whose first move is dropped. */
  onLockChange(): void {
    this.armed = true;
  }

  /** Returns the movement to apply, or null to ignore the event. */
  filter(dx: number, dy: number, locked: boolean): { dx: number; dy: number } | null {
    if (!locked) {
      this.armed = true;
      return null;
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    if (this.armed) {
      this.armed = false;
      return null;
    }
    const len = Math.hypot(dx, dy);
    if (len > this.maxDeltaPx && len > 0) {
      const k = this.maxDeltaPx / len;
      return { dx: dx * k, dy: dy * k };
    }
    return { dx, dy };
  }
}
