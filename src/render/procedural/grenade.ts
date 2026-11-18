/**
 * Pineapple frag grenade (M2a). Owner: graphics-designer. Spec: docs/art/STYLE.md "Grenade".
 *
 * Frame: origin at the centre of the round body (spin / tumble about it), crown (fuse cap + leaves) on +Y.
 * Body diameter 0.13 m (about the size of the chibi's hand ball), 0.2 m tall with the leaves.
 * Look: bright tangerine checker body (pineapple segments), dark lever and fuse cap, a short green leaf crown
 * and a hot-pink pin ring. The pin is optional so the in-flight model can drop it.
 */
import * as THREE from 'three';
import { buildMerged, xf, type ColorFn, type Merged, type Piece } from './builder';
import { addOutline, OUTLINE, palette, vertexColorToon } from './materials';

export const GRENADE_DIMENSIONS = {
  bodyRadius: 0.065,
  /** Fuse top (spark VFX anchor 'fuse'), in the grenade frame. */
  fuseY: 0.098,
  /**
   * In-hand attach: child of `hand_R_socket` (CharacterModel.handR) at this position, no rotation. The crown then
   * points along the socket's +Y (the same "up" as a gun's top).
   */
  handOffset: [0, 0, -0.075] as const,
  /** Suggested uniform scale for the in-flight model so it reads at 20-30 m (outline min width keeps it inked). */
  flightScale: 1.5,
} as const;

/** Checker of the sphere quads in two oranges: reads as pineapple / frag segments. */
const checker: ColorFn = (_n, c) => {
  const az = Math.atan2(c.x, c.z);
  const el = Math.atan2(c.y, Math.hypot(c.x, c.z));
  const i = Math.floor((az + Math.PI) / (Math.PI / 4)) + Math.floor((el + Math.PI / 2) / (Math.PI / 6));
  return i % 2 === 0 ? palette.grenade : palette.grenadeDark;
};

function grenadePieces(withPin: boolean): Piece[] {
  const R = GRENADE_DIMENSIONS.bodyRadius;
  const d = palette.gunDark;
  const P: Piece[] = [
    // Sphere quads line up with the checker bins (no rotation), so every quad is one pineapple "segment".
    { geo: new THREE.SphereGeometry(R, 8, 6), color: palette.grenade, matrix: xf([0, 0, 0], [0, 0, 0], [1, 1.1, 1]), colorFn: checker },
    { geo: new THREE.CylinderGeometry(0.024, 0.03, 0.034, 6), color: d, matrix: xf([0, 0.078, 0]) },
    // spoon lever hugging the +X side, from the fuse cap down to the shoulder of the body
    { geo: new THREE.BoxGeometry(0.01, 0.07, 0.024), color: d, matrix: xf([0.046, 0.06, 0], [0, 0, 0.62]) },
  ];
  // leaf crown: three short open cones fanning out of the cap
  for (const [rx, rz] of [[0, -0.45], [0.4, 0.25], [-0.4, 0.25]] as const) {
    P.push({ geo: new THREE.ConeGeometry(0.017, 0.06, 4, 1, true).translate(0, 0.03, 0), color: palette.grenadeLeaf, matrix: xf([0, 0.09, 0], [rx, 0, rz]) });
  }
  if (withPin) {
    P.push({ geo: new THREE.BoxGeometry(0.03, 0.008, 0.008), color: d, matrix: xf([-0.03, 0.084, 0]), outline: false });
    P.push({ geo: new THREE.TorusGeometry(0.022, 0.0065, 4, 8), color: palette.grenadePin, matrix: xf([-0.062, 0.078, 0], [0, 0.35, 0]) });
  }
  return P;
}

const cache = new Map<string, Merged>();
/** Shared grenade geometry (also used by loot). */
export function getGrenadeGeometry(withPin = true): Merged {
  const key = withPin ? 'pin' : 'nopin';
  let m = cache.get(key);
  if (!m) {
    m = buildMerged(grenadePieces(withPin), `grenade:${key}`);
    cache.set(key, m);
  }
  return m;
}

export interface GrenadeModelOptions {
  /** Draw the pin ring (default true: held, not yet cooking). Use false for cooking / in-flight. */
  pin?: boolean;
}

/**
 * Grenade for the hand and for flight. Returns a Group named 'grenade' with a mesh 'grenadeMesh' (+ 'outline'
 * child) and an empty 'fuse' at the top of the fuse cap (spark VFX). Origin = body centre.
 * In hand: `handR.add(g); g.position.set(...GRENADE_DIMENSIONS.handOffset)`.
 */
export function createGrenadeModel(opts: GrenadeModelOptions = {}): THREE.Object3D {
  const m = getGrenadeGeometry(opts.pin ?? true);
  const root = new THREE.Group();
  root.name = 'grenade';
  const mesh = new THREE.Mesh(m.geometry, vertexColorToon());
  mesh.name = 'grenadeMesh';
  mesh.castShadow = true;
  if (m.outline) addOutline(mesh, OUTLINE.small * 1.5, palette.ink, m.outline);
  root.add(mesh);
  const fuse = new THREE.Object3D();
  fuse.name = 'fuse';
  fuse.position.set(0, GRENADE_DIMENSIONS.fuseY, 0);
  root.add(fuse);
  return root;
}
