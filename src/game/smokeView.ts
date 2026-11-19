/**
 * M2c smoke clouds on the client (smoke.md, ADR 0007 §6-§7). Owner: game-developer.
 *
 * A cloud is an immutable record (`SmokeCloudState`); its radius over time is the shared `smokeRadiusAt`. Sources:
 * `WorldSnapshot.smokes` (carried forward) and the `smokeDeployed` event. A cloud is gone at `smokeGoneAt`.
 * Every visibility decision goes through the shared `segmentBlockedBySmoke` / `pointInSmoke` (src/shared/smoke.ts):
 * PlayerView.smokeHidden (head AND chest blocked), localHitConfirmed.obscured (chest), HudView.inSmoke (camera).
 */
import type { SmokeCloudBalance } from '../shared/balance';
import type { CameraView, SmokeCloudView } from '../shared/contracts';
import { smokeCenter, smokeGoneAt, smokeRadiusAt, segmentBlockedBySmoke } from '../shared/smoke';
import type { SmokeCloudState, SmokeId, Vec3 } from '../shared/types';

export class SmokeTracker {
  private readonly clouds = new Map<SmokeId, SmokeCloudState>();
  /** Sorted list cache for the visibility helpers (rebuilt on change). */
  private list: SmokeCloudState[] = [];
  private dirty = false;

  reset(): void {
    this.clouds.clear();
    this.list = [];
    this.dirty = false;
  }

  /** WorldSnapshot.smokes at `serverTime`: the server's list wins (a forced earlier fadeAt included). */
  onSnapshot(smokes: readonly SmokeCloudState[], serverTime: number): void {
    const listed = new Set<SmokeId>();
    for (const c of smokes) {
      listed.add(c.id);
      this.clouds.set(c.id, cloneCloud(c));
    }
    for (const [id, c] of this.clouds) if (!listed.has(id) && c.deployedAt <= serverTime) this.clouds.delete(id);
    this.dirty = true;
  }

  /** SimEvent smokeDeployed (= the record). */
  onDeployed(c: SmokeCloudState): void {
    this.clouds.set(c.id, cloneCloud(c));
    this.dirty = true;
  }

  /** Live clouds (not yet gone at `now`), sorted by id. Same objects until the next change. */
  active(now: number, cfg: SmokeCloudBalance): readonly SmokeCloudState[] {
    for (const [id, c] of this.clouds) {
      if (now >= smokeGoneAt(c, cfg)) {
        this.clouds.delete(id);
        this.dirty = true;
      }
    }
    if (this.dirty) {
      this.list = [...this.clouds.values()].sort((a, b) => a.id - b.id);
      this.dirty = false;
    }
    return this.list;
  }

  /** FrameView.smokes at `now`. */
  views(now: number, cfg: SmokeCloudBalance): SmokeCloudView[] {
    return this.active(now, cfg).map((c) => ({
      id: c.id,
      ownerId: c.ownerId,
      pos: { ...c.pos },
      center: smokeCenter(c, cfg),
      radius: smokeRadiusAt(c, now, cfg),
      deployedAt: c.deployedAt,
      fadeAt: c.fadeAt,
    }));
  }
}

/** PlayerView.smokeHidden: the camera's lines to the head AND the chest both cross an opaque cloud. */
export function hiddenBySmoke(
  clouds: readonly SmokeCloudState[],
  camera: Vec3,
  head: Vec3,
  chest: Vec3,
  now: number,
  cfg: SmokeCloudBalance,
): boolean {
  if (clouds.length === 0) return false;
  return segmentBlockedBySmoke(clouds, camera, head, now, cfg) && segmentBlockedBySmoke(clouds, camera, chest, now, cfg);
}

/**
 * World position of the camera (smoke checks from the eye the player actually sees through): the pivot in first
 * person, else the pivot pulled back along -aim by `distance` and moved right by `shoulderOffset` (yaw convention:
 * forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw), pitch up positive). Orbit cameras use the pivot.
 */
export function cameraWorldPos(c: CameraView): Vec3 {
  if (c.mode !== 'follow' || (c.distance === 0 && c.shoulderOffset === 0)) return { ...c.target };
  const cp = Math.cos(c.pitch);
  const fx = -Math.sin(c.yaw) * cp;
  const fy = Math.sin(c.pitch);
  const fz = -Math.cos(c.yaw) * cp;
  const rx = Math.cos(c.yaw);
  const rz = -Math.sin(c.yaw);
  return {
    x: c.target.x - fx * c.distance + rx * c.shoulderOffset,
    y: c.target.y - fy * c.distance,
    z: c.target.z - fz * c.distance + rz * c.shoulderOffset,
  };
}

const cloneCloud = (c: SmokeCloudState): SmokeCloudState => ({
  id: c.id,
  ownerId: c.ownerId,
  pos: { ...c.pos },
  deployedAt: c.deployedAt,
  fadeAt: c.fadeAt,
});
