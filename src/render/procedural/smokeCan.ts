/**
 * M2c Candyfloss Smoke Bomb canister. Owner: graphics-designer. Spec: docs/art/M2c.md §4.1.
 *
 * Must never read as the frag: the frag is a ROUND tangerine pineapple with a leaf crown and a hot-pink pin; the smoke
 * can is a stubby lilac CYLINDER with pink hoops, a fluffy 3-blob candyfloss cap and a cream pin ring.
 * Same frame and anchors as the frag (grenade.ts): origin at the body centre, cap on +Y, child 'fuse' at the cap top,
 * the same hand offset and flight scale (GRENADE_DIMENSIONS). Loot outline width.
 */
import * as THREE from 'three';
import { buildMerged, xf, type Merged, type Piece } from './builder';
import { GRENADE_DIMENSIONS } from './grenade';
import { addOutline, OUTLINE, palette, vertexColorToon } from './materials';

export const SMOKE_CAN_DIMENSIONS = {
  radius: 0.055,
  height: 0.15,
  /** Cap top (puff VFX anchor 'fuse'), in the can frame. */
  fuseY: 0.118,
  handOffset: GRENADE_DIMENSIONS.handOffset,
  flightScale: GRENADE_DIMENSIONS.flightScale,
} as const;

function smokePieces(withPin: boolean): Piece[] {
  const R = SMOKE_CAN_DIMENSIONS.radius, H = SMOKE_CAN_DIMENSIONS.height;
  const d = palette.gunDark;
  const P: Piece[] = [
    { geo: new THREE.CylinderGeometry(R, R, H, 10), color: palette.smokeCan, matrix: xf([0, 0, 0]) },
    { geo: new THREE.CylinderGeometry(R + 0.002, R + 0.002, 0.02, 10, 1, true), color: palette.smokeHoop, matrix: xf([0, 0.035, 0]), outline: false },
    { geo: new THREE.CylinderGeometry(R + 0.002, R + 0.002, 0.02, 10, 1, true), color: palette.smokeHoop, matrix: xf([0, -0.035, 0]), outline: false },
    { geo: new THREE.CylinderGeometry(0.026, 0.03, 0.02, 8), color: d, matrix: xf([0, H / 2 + 0.008, 0]) },
    // spoon lever down the +X side
    { geo: new THREE.BoxGeometry(0.01, 0.08, 0.022), color: d, matrix: xf([R + 0.004, 0.04, 0], [0, 0, 0.12]) },
  ];
  // candyfloss cap: three fluffy blobs
  for (const [x, y, z, r, c] of [[0, 0.1, 0, 0.034, palette.smokeCap], [0.024, 0.09, 0.014, 0.024, palette.smokeCap2], [-0.022, 0.092, -0.012, 0.026, palette.smokeCap2]] as const) {
    P.push({ geo: new THREE.IcosahedronGeometry(r, 0), color: c, matrix: xf([x, y, z]) });
  }
  if (withPin) {
    P.push({ geo: new THREE.BoxGeometry(0.03, 0.008, 0.008), color: d, matrix: xf([-0.03, 0.085, 0]), outline: false });
    P.push({ geo: new THREE.TorusGeometry(0.022, 0.0065, 4, 8), color: palette.gunTip, matrix: xf([-0.062, 0.08, 0], [0, 0.35, 0]) });
  }
  return P;
}

const cache = new Map<string, Merged>();
/** Shared smoke-can geometry (also used by loot). */
export function getSmokeCanGeometry(withPin = true): Merged {
  const key = withPin ? 'pin' : 'nopin';
  let m = cache.get(key);
  if (!m) cache.set(key, (m = buildMerged(smokePieces(withPin), `smoke:${key}`)));
  return m;
}

/**
 * Smoke can for the hand and for flight: Group 'smoke' with 'smokeMesh' (+ 'outline') and an empty 'fuse' at the cap
 * top (candyfloss puff VFX). `pin: false` for the cooking / in-flight look.
 */
export function createSmokeModel(opts: { pin?: boolean } = {}): THREE.Object3D {
  const m = getSmokeCanGeometry(opts.pin ?? true);
  const root = new THREE.Group();
  root.name = 'smoke';
  const mesh = new THREE.Mesh(m.geometry, vertexColorToon());
  mesh.name = 'smokeMesh';
  mesh.castShadow = true;
  if (m.outline) addOutline(mesh, OUTLINE.small * 1.5, palette.ink, m.outline);
  root.add(mesh);
  const fuse = new THREE.Object3D();
  fuse.name = 'fuse';
  fuse.position.set(0, SMOKE_CAN_DIMENSIONS.fuseY, 0);
  root.add(fuse);
  return root;
}

/** Smoke cloud palette (render: SmokeLayer). docs/art/M2c.md §4.2. */
export const SMOKE_CLOUD_COLORS = {
  lit: palette.smokeLight,
  mid: palette.smokeMid,
  shadow: palette.smokeShadow,
  veil: palette.smokeVeil,
  hull: palette.inkSoft,
  /** Hull width (m) of the puffs. */
  hullWidth: 0.035,
  /** Throw-arc landing ring (never danger red). */
  arcRing: palette.smokeShadow,
} as const;
