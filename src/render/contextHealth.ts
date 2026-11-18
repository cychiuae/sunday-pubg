/**
 * WebGL context health for IRenderer.getGraphicsStatus (ADR 0003 §5). Owner: graphics-engineer.
 * Pure and clock-injected (no timers): the 'failed' timeout is evaluated when polled, so it is unit-testable.
 */
import type { GraphicsStatus } from '../shared/contracts';

export class ContextHealth {
  /** Clock time of the current loss, or -1 while the context is healthy. */
  private lostAt = -1;
  private losses = 0;

  constructor(private readonly timeoutMs: number) {}

  /** webglcontextlost. A second loss before a restore keeps the original start time. */
  lost(nowMs: number): void {
    if (this.lostAt < 0) {
      this.lostAt = nowMs;
      this.losses++;
    }
  }

  /** webglcontextrestored (also after 'failed': a late restore goes back to 'ok'). */
  restored(): void {
    this.lostAt = -1;
  }

  get isLost(): boolean {
    return this.lostAt >= 0;
  }

  get lossCount(): number {
    return this.losses;
  }

  status(nowMs: number): GraphicsStatus {
    if (this.lostAt < 0) return 'ok';
    return nowMs - this.lostAt >= this.timeoutMs ? 'failed' : 'restoring';
  }
}
