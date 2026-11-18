/**
 * The match-start carrier (M2b plane drop, STYLE.md §20.1): the island seaplane or the office delivery drone flying
 * the DropRoute, props / rotors spinning (blur discs above the toon threshold), a gentle bob. Owner:
 * graphics-engineer.
 *
 * Position: `carrierPosAt(route, serverNow)` at `route.altitude` with `carrierHeading` (no per-tick sync, ADR 0005 §8).
 * The route arrives with the `carrierDeparted` GameEvent. Before it (countdown, or a late join) the carrier camera
 * case (CameraView.view 'carrier', target = the carrier) places it at the camera target, heading for the map centre.
 * Indoors it is only drawn over the floor (it enters through the outer wall). Never mutates sim state.
 */
import * as THREE from 'three';
import type { CameraView } from '../shared/contracts';
import { carrierHeading, carrierPosAt } from '../shared/maps';
import type { CarrierModel, DropRoute, Rect, Vec2 } from '../shared/types';
import { createDeliveryDrone, createSeaplane } from './procedural';

/** Visual spin rate of props / rotors (rad/s) and the toon blur threshold (STYLE.md §20.1). */
export const CARRIER_SPIN = 32;
const BLUR_ABOVE = 15;

/** Where the carrier is drawn this frame, or null. Pure; exported for tests. */
export function carrierPlacement(
  route: DropRoute | null,
  serverTime: number,
  cam: Pick<CameraView, 'view' | 'target'>,
  out: { x: number; y: number; z: number; yaw: number },
): boolean {
  if (route && serverTime <= route.endsAt) {
    const p: Vec2 = carrierPosAt(route, serverTime, _xz);
    out.x = p.x;
    out.y = route.altitude;
    out.z = p.z;
    out.yaw = carrierHeading(route);
    return true;
  }
  if (cam.view === 'carrier') {
    out.x = cam.target.x;
    out.y = cam.target.y;
    out.z = cam.target.z;
    // Heading toward the map centre (routes cross the middle within the lateral bound).
    out.yaw = Math.hypot(out.x, out.z) > 1 ? Math.atan2(out.x, out.z) : 0;
    return true;
  }
  return false;
}
const _xz: Vec2 = { x: 0, z: 0 };

interface Spinner {
  obj: THREE.Object3D;
  axis: 'y' | 'z';
  dir: number;
  blur: THREE.Object3D | null;
}

export class CarrierLayer {
  readonly group = new THREE.Group();
  /** World position while drawn (indoor light panels retract around it). */
  readonly position = new THREE.Vector3();
  visible = false;
  private readonly models = new Map<CarrierModel, { root: THREE.Group; spinners: Spinner[] }>();
  private active: { root: THREE.Group; spinners: Spinner[] } | null = null;
  private kind: CarrierModel | null = null;
  private route: DropRoute | null = null;
  private bounds: Rect | null = null;
  private readonly place = { x: 0, y: 0, z: 0, yaw: 0 };

  constructor() {
    this.group.name = 'carrier';
  }

  /** Map change: pick the model, forget the old route; `bounds` = the indoor floor (drawn only above it). */
  setMap(kind: CarrierModel, bounds: Rect | null): void {
    this.route = null;
    this.bounds = bounds;
    if (this.kind === kind) return;
    this.kind = kind;
    if (this.active) this.group.remove(this.active.root);
    let m = this.models.get(kind);
    if (!m) {
      const root = kind === 'drone' ? createDeliveryDrone() : createSeaplane();
      root.rotation.order = 'YXZ';
      const spinners: Spinner[] = [];
      root.traverse((o) => {
        if (/^(propeller[LR]|rotor\d)$/.test(o.name)) {
          spinners.push({
            obj: o,
            axis: o.name.startsWith('rotor') ? 'y' : 'z',
            dir: typeof o.userData.spin === 'number' ? o.userData.spin : o.name === 'propellerL' ? 1 : -1,
            blur: o.getObjectByName('blur') ?? null,
          });
        }
        if ((o as THREE.Mesh).isMesh && o.name !== 'outline' && o.name !== 'blur') o.castShadow = true;
      });
      m = { root, spinners };
      this.models.set(kind, m);
    }
    this.active = m;
    this.group.add(m.root);
  }

  setRoute(route: DropRoute | null): void {
    this.route = route;
  }

  update(serverTime: number, cam: CameraView, time: number): void {
    const m = this.active;
    this.visible = false;
    if (!m) return;
    const pl = this.place;
    let show = carrierPlacement(this.route, serverTime, cam, pl);
    const b = this.bounds;
    if (show && b && (pl.x < b.minX || pl.x > b.maxX || pl.z < b.minZ || pl.z > b.maxZ)) show = cam.view === 'carrier';
    m.root.visible = show;
    if (!show) return;
    const bob = this.kind === 'drone' ? 0.18 : 0.45;
    m.root.position.set(pl.x, pl.y + Math.sin(time * 1.7) * bob, pl.z);
    m.root.rotation.set(Math.sin(time * 1.1) * 0.02, pl.yaw, Math.sin(time * 0.8) * 0.03);
    for (const s of m.spinners) {
      s.obj.rotation[s.axis] = (time * CARRIER_SPIN * 0.25 * s.dir) % (Math.PI * 2);
      if (s.blur) s.blur.visible = CARRIER_SPIN > BLUR_ABOVE;
    }
    this.position.copy(m.root.position);
    this.visible = true;
  }

  dispose(): void {
    // Geometry and materials are procedural caches (carrier.ts); only drop our references.
    this.group.clear();
    this.models.clear();
    this.active = null;
  }
}
