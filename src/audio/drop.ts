/**
 * Carrier-drop audio state (M2b, ARCHITECTURE §15.9, drop.md "Audio and VFX"). Pure: no Web Audio, so it is unit-tested
 * in node. The AudioDirector feeds it events; the AudioEngine calls frame() once per frame and applies the resulting
 * DropMix to the persistent DropLayers (engine drone, cabin, door wind, freefall wind, canopy flutter).
 * Owner: audio-designer.
 *
 * Local phase: 'none' -> localSpawned -> 'aboard' (only counts while the carrier flies and before the eject grace) ->
 * playerJumped -> 'freefall' -> parachuteOpened -> 'chute' -> land -> 'none'. Death and match reset go to 'none'.
 */
import { carrierPosAt } from '../shared/maps';
import type { CarrierModel, DropRoute, PlayerId, Vec2, Vec3 } from '../shared/types';
import { AUDIO_TUNING } from './cues';

export type LocalDropPhase = 'none' | 'aboard' | 'freefall' | 'chute';

/** Per-frame targets for the drop layers. One instance per tracker, rewritten in place (no per-frame allocation). */
export interface DropMix {
  /** The carrier is flying (between carrierDeparted and route.endsAt). */
  carrierActive: boolean;
  carrierModel: CarrierModel;
  /** Carrier world position (route altitude). Valid while carrierActive. */
  readonly carrierPos: Vec3;
  /** 0..1: local player aboard (cabin muffle, interior engine, door wind). */
  aboard: number;
  /** 0..1: freefall / chute wind, rising with the measured fall speed. */
  wind: number;
  /** 0..1: canopy flutter while the local chute is open. */
  flutter: number;
}

export class DropTracker {
  private route: DropRoute | null = null;
  private model: CarrierModel = 'seaplane';
  private phase: LocalDropPhase = 'none';
  private localId: PlayerId | null = null;
  /** Remote players with an open chute (their landing adds the canopy fold). */
  private readonly remoteChutes = new Set<PlayerId>();

  private readonly last: Vec3 = { x: 0, y: 0, z: 0 };
  private hasLast = false;
  private speed = 0;
  private readonly pos2: Vec2 = { x: 0, z: 0 };

  readonly mix: DropMix = { carrierActive: false, carrierModel: 'seaplane', carrierPos: { x: 0, y: 0, z: 0 }, aboard: 0, wind: 0, flutter: 0 };

  /** Carrier model of the active map (mapChanged). */
  setModel(model: CarrierModel): void {
    this.model = model;
  }

  carrierDeparted(route: DropRoute): void {
    this.route = route;
  }

  localSpawned(id: PlayerId): void {
    this.localId = id;
    this.phase = 'aboard';
  }

  /** A player left the carrier. Local: freefall starts (speed measurement restarts). */
  jumped(id: PlayerId, isLocal: boolean): void {
    if (isLocal) {
      this.localId = id;
      this.phase = 'freefall';
      this.hasLast = false;
    }
  }

  chuteOpened(id: PlayerId, isLocal: boolean): void {
    if (isLocal) this.phase = 'chute';
    else this.remoteChutes.add(id);
  }

  /** A landing. Returns true when it ended a drop (local freefall/chute, or a remote open chute). */
  landed(id: PlayerId, isLocal: boolean): boolean {
    if (isLocal) {
      const was = this.phase === 'freefall' || this.phase === 'chute';
      if (was) this.phase = 'none';
      return was;
    }
    return this.remoteChutes.delete(id);
  }

  died(id: PlayerId, isLocal: boolean): void {
    if (isLocal) this.phase = 'none';
    else this.remoteChutes.delete(id);
  }

  reset(): void {
    this.route = null;
    this.phase = 'none';
    this.remoteChutes.clear();
    this.hasLast = false;
    this.speed = 0;
  }

  get localPhase(): LocalDropPhase {
    return this.phase;
  }

  get localPlayerId(): PlayerId | null {
    return this.localId;
  }

  get activeRoute(): DropRoute | null {
    return this.route;
  }

  /** Smoothed listener speed, m/s (tests and debugging). */
  get measuredSpeed(): number {
    return this.speed;
  }

  /**
   * Updates `mix` for this frame. `serverNowMs` is the server clock (route times are server ms); `listener` is the
   * listener position this frame (the FP eye in freefall), used to measure the fall speed; `dt` in seconds.
   */
  frame(serverNowMs: number, listener: Vec3, dt: number): DropMix {
    const T = AUDIO_TUNING;
    const m = this.mix;
    m.carrierModel = this.model;

    // Fall speed from the listener's motion, smoothed; teleports (map change, respawn, camera cut) are ignored.
    if (dt > 0 && Number.isFinite(dt)) {
      if (this.hasLast) {
        const dx = listener.x - this.last.x;
        const dy = listener.y - this.last.y;
        const dz = listener.z - this.last.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (Number.isFinite(d) && d <= T.listenerTeleportM) {
          const k = 1 - Math.exp(-dt / T.windSmoothTc);
          this.speed += (d / dt - this.speed) * k;
        }
      }
      this.last.x = listener.x;
      this.last.y = listener.y;
      this.last.z = listener.z;
      this.hasLast = true;
    }

    const r = this.route;
    m.carrierActive = r !== null && Number.isFinite(serverNowMs) && serverNowMs < r.endsAt;
    if (r && m.carrierActive) {
      carrierPosAt(r, serverNowMs, this.pos2);
      m.carrierPos.x = this.pos2.x;
      m.carrierPos.y = r.altitude;
      m.carrierPos.z = this.pos2.z;
    }

    // Aboard only while the carrier flies and before the auto-eject (plus grace, in case the jump event is late).
    const aboard = this.phase === 'aboard' && r !== null && m.carrierActive && serverNowMs < r.ejectAt + T.carrierEjectGraceMs;
    m.aboard = aboard ? 1 : 0;

    const norm = Math.min(1, Math.max(0, this.speed / T.windFullSpeed));
    if (this.phase === 'freefall') m.wind = Math.max(T.freefallWindFloor, norm);
    else if (this.phase === 'chute') m.wind = Math.min(T.chuteWindMax, Math.max(T.chuteWindFloor, norm * T.chuteWindScale));
    else m.wind = 0;
    m.flutter = this.phase === 'chute' ? 1 : 0;
    return m;
  }
}
