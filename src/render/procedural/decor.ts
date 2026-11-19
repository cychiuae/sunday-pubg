/**
 * M2c decor (client-only, no collider): the render table keyed by `DecorPlacement.kind`. Owner: graphics-designer.
 * Spec: docs/art/M2c.md §9; kinds and sizes: src/shared/kits/decor.ts (the level data's names are canonical).
 *
 * Every kind: ONE body part (shared vertex-colour toon material), NO outline hull, NO shadow casting, about 60-130
 * colour tris, <= 0.5 m tall. Origin at ground centre, front -Z. Island kinds are in island metres; `paperSheets` is
 * already at the office 9x scale (merge it into the office chunks). Instancing: one InstancedMesh per (kind, variant)
 * on the island, i.e. +1 draw call per visible kind/variant (variety.md §7: about 8 decor calls).
 */
import * as THREE from 'three';
import { DECOR_KIND_INFO, DECOR_KIND_IDS, type DecorKindId } from '../../shared/kits/decor';
import { buildMerged, rng, xf, type Piece } from './builder';
import { palette, vertexColorToon } from './materials';
import type { PropPart } from './props';

export { DECOR_KIND_IDS, DECOR_KIND_INFO, type DecorKindId };

const HALF_PI = Math.PI / 2;
const shellCols = [0xfff1dc, 0xffb3a7, 0xffd3a8] as const;

function shellCluster(v: number): Piece[] {
  const r = rng(301 + v);
  const P: Piece[] = [];
  const spots: [number, number][] = v === 0 ? [[0, 0], [0.18, 0.12], [-0.15, 0.1]] : [[0, 0], [-0.17, -0.08], [0.12, -0.14]];
  spots.forEach(([x, z], i) => {
    const col = shellCols[(i + v) % 3];
    if (i === 1) {
      // conch: a short 6-sided cone lying down + a pink lip
      P.push({ geo: new THREE.ConeGeometry(0.06, 0.18, 6).rotateZ(HALF_PI), color: col, matrix: xf([x, 0.05, z], [0, r() * 6, 0]), flat: true });
      P.push({ geo: new THREE.SphereGeometry(0.05, 5, 2), color: 0xff8fa3, matrix: xf([x - 0.09, 0.05, z], [0, 0, 0], [0.4, 1, 1]) });
    } else {
      // scallop: a flattened ridged half-dome
      P.push({
        geo: new THREE.SphereGeometry(0.1, 7, 3, 0, Math.PI * 2, 0, HALF_PI), color: col,
        matrix: xf([x, 0, z], [0, r() * 6, 0], [1, 0.45, 0.85]), flat: true,
        colorFn: (n) => (Math.abs(n.x) > 0.3 && Math.abs(n.z) < 0.6 ? col : 0xf2c9a8),
      });
    }
  });
  return P;
}

function starfish(v: number): Piece[] {
  const col = v === 0 ? 0xffc43d : 0xff7a5c;
  const P: Piece[] = [{ geo: new THREE.CylinderGeometry(0.05, 0.055, 0.03, 6), color: col, matrix: xf([0, 0.015, 0]) }];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    P.push({ geo: new THREE.ConeGeometry(0.04, 0.15, 4).rotateZ(-HALF_PI), color: col, matrix: xf([Math.cos(a) * 0.09, 0.014, Math.sin(a) * 0.09], [0, -a, 0], [1, 0.35, 1]), flat: true });
  }
  return P;
}

function sandcastle(): Piece[] {
  const s = palette.sandDark, w = palette.wetSand;
  const P: Piece[] = [
    { geo: new THREE.RingGeometry(0.3, 0.4, 10, 1).rotateX(-HALF_PI), color: w, matrix: xf([0, 0.005, 0]) }, // moat
    { geo: new THREE.BoxGeometry(0.38, 0.14, 0.38), color: s, matrix: xf([0, 0.07, 0], [0, 0.4, 0]) },
  ];
  for (const [x, z, h] of [[0.12, 0.1, 0.32], [-0.13, 0.06, 0.26], [0.02, -0.14, 0.22]] as const) {
    P.push({ geo: new THREE.CylinderGeometry(0.065, 0.075, h, 6, 1, true), color: s, matrix: xf([x, h / 2, z]), flat: true });
    P.push({ geo: new THREE.ConeGeometry(0.075, 0.1, 6), color: palette.sandLight, matrix: xf([x, h + 0.05, z]), flat: true });
  }
  P.push({ geo: new THREE.BoxGeometry(0.004, 0.05, 0.035), color: 0xff5a5f, matrix: xf([0.12, 0.42, 0.1]) }); // flag
  P.push({ geo: new THREE.CylinderGeometry(0.003, 0.003, 0.08, 3), color: palette.woodDark, matrix: xf([0.12, 0.4, 0.085]) });
  return P;
}

const TOWELS: readonly [number, number][] = [[palette.towel, palette.stripeCream], [0xff5a5f, palette.stripeCream], [0xffc43d, 0x2ec4b6], [0xc9b6f2, 0xffffff]];
function beachTowel(v: number): Piece[] {
  const [a, b] = TOWELS[v % TOWELS.length];
  const P: Piece[] = [{ geo: new THREE.BoxGeometry(0.95, 0.02, 1.7), color: a, matrix: xf([0, 0.01, 0.05]) }];
  for (const z of [-0.45, 0.55]) P.push({ geo: new THREE.BoxGeometry(0.96, 0.022, 0.14), color: b, matrix: xf([0, 0.011, z]) });
  // rolled end as a pillow
  P.push({ geo: new THREE.CylinderGeometry(0.06, 0.06, 0.94, 6).rotateZ(HALF_PI), color: a, matrix: xf([0, 0.06, -0.82]) });
  return P;
}

function fernTuft(): Piece[] {
  const P: Piece[] = [];
  const r = rng(77);
  for (let i = 0; i < 7; i++) {
    const yaw = (i / 7) * Math.PI * 2 + r() * 0.4;
    const len = 0.36 + r() * 0.08;
    const pitch = 0.55 + r() * 0.25;
    const d = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const c = d.clone().multiplyScalar(len / 2);
    P.push({
      geo: new THREE.SphereGeometry(1, 4, 2), color: i % 2 ? palette.bushDark : palette.bush,
      matrix: xf([c.x, c.y, c.z], [-pitch, yaw, 0], [0.08, 0.012, len / 2], 'YXZ'),
    });
  }
  return P;
}

function flowerTuft(v: number): Piece[] {
  const petal = v === 0 ? palette.hibiscus : 0xffffff;
  const P: Piece[] = [];
  for (let i = 0; i < 4; i++) {
    const yaw = (i / 4) * Math.PI * 2 + 0.3;
    P.push({ geo: new THREE.SphereGeometry(1, 4, 2), color: palette.bush, matrix: xf([Math.sin(yaw) * 0.09, 0.09, Math.cos(yaw) * 0.09], [-0.7, yaw, 0], [0.06, 0.012, 0.13], 'YXZ') });
  }
  for (const [x, y, z] of [[0.08, 0.36, 0.0], [-0.07, 0.3, 0.07], [0.0, 0.26, -0.1]] as const) {
    P.push({ geo: new THREE.CylinderGeometry(0.006, 0.006, y, 3), color: palette.bushDark, matrix: xf([x, y / 2, z]) });
    P.push({ geo: new THREE.OctahedronGeometry(0.06, 0), color: petal, matrix: xf([x, y, z], [0.4, 0.3, 0], [1, 0.5, 1]) });
    P.push({ geo: new THREE.OctahedronGeometry(0.022, 0), color: palette.flowerCenter, matrix: xf([x, y + 0.025, z]) });
  }
  return P;
}

function coconutPile(): Piece[] {
  const P: Piece[] = [];
  for (const [x, y, z] of [[0, 0.09, 0], [0.16, 0.09, 0.06], [-0.13, 0.09, 0.1], [0.03, 0.22, 0.05]] as const) {
    P.push({ geo: new THREE.SphereGeometry(0.1, 5, 3), color: palette.coconut, matrix: xf([x, y, z], [0.3, x * 9, 0], [1, 0.9, 1]), flat: true });
  }
  P.push({ geo: new THREE.SphereGeometry(0.06, 5, 3, 0, Math.PI * 2, 0, HALF_PI), color: palette.stripeCream, matrix: xf([-0.12, 0.0, -0.13]) }); // half shell
  return P;
}

function seaweed(): Piece[] {
  const col = 0x6e8f3a, dark = 0x55732c;
  const P: Piece[] = [];
  const pts: [number, number, number][] = [[-0.5, 0, 0.18], [-0.15, 0.4, 0.18], [0.2, -0.3, 0.16], [0.5, 0.2, 0.14]];
  for (let i = 0; i < 3; i++) {
    const [x0, , w] = pts[i];
    const x1 = pts[i + 1][0];
    const zc = (pts[i][1] + pts[i + 1][1]) * 0.25;
    P.push({ geo: new THREE.BoxGeometry(Math.abs(x1 - x0) + 0.05, 0.02, w), color: i % 2 ? dark : col, matrix: xf([(x0 + x1) / 2, 0.012, zc], [0, (i % 2 ? -1 : 1) * 0.5, 0]) });
  }
  P.push({ geo: new THREE.BoxGeometry(0.5, 0.018, 0.1), color: dark, matrix: xf([0.05, 0.02, -0.18], [0, 0.3, 0]) });
  return P;
}

/** Office paper sheets (world metres, 9x): fanned A4 sheets with grey abstract bars. No text, names or logos. */
function paperSheets(v: number): Piece[] {
  const W = 0.21 * 9, L = 0.297 * 9;
  const P: Piece[] = [];
  const n = v === 0 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const yaw = (i - (n - 1) / 2) * 0.35;
    const m = xf([(i - 1) * 0.35, 0.02 + i * 0.022, (i % 2) * 0.25], [0, yaw, 0]);
    P.push({ geo: new THREE.BoxGeometry(W, 0.02, L), color: i % 2 ? 0xfff8e7 : 0xffffff, matrix: m });
    for (const z of [-0.6, 0.2]) {
      P.push({ geo: new THREE.BoxGeometry(W * 0.62, 0.022, 0.12), color: 0xc5ccd6, matrix: m.clone().multiply(xf([-0.1, 0.002, z])) });
    }
  }
  if (v === 1) P.push({ geo: new THREE.BoxGeometry(0.68, 0.06, 0.68), color: 0xfff07a, matrix: xf([0.6, 0.06, -0.7], [0, 0.4, 0]) }); // sticky note
  return P;
}

const BUILD: Readonly<Record<DecorKindId, (variant: number) => Piece[]>> = {
  shellCluster, starfish, sandcastle, beachTowel, fernTuft, flowerTuft, coconutPile, seaweed, paperSheets,
};

const cache = new Map<string, PropPart[]>();
/** Clamp a variant index into range for a decor kind. */
export function decorVariant(kind: DecorKindId, variant: number | undefined): number {
  const n = DECOR_KIND_INFO[kind].variants;
  if (variant === undefined || !Number.isFinite(variant)) return 0;
  return ((Math.floor(variant) % n) + n) % n;
}

/**
 * Instanceable parts of a decor kind: a single 'body' part (no hull, no shadow cast, identity matrix). Cached and
 * shared; do not dispose per instance. Throws for an unknown kind.
 */
export function getDecorParts(kind: DecorKindId | string, variant = 0): PropPart[] {
  if (!Object.prototype.hasOwnProperty.call(BUILD, kind)) throw new Error(`Unknown decor kind: ${kind}`);
  const k = kind as DecorKindId;
  const v = decorVariant(k, variant);
  const key = `${k}|${v}`;
  let parts = cache.get(key);
  if (!parts) {
    const m = buildMerged(BUILD[k](v).map((p) => ({ ...p, outline: false })), `decor:${key}`);
    parts = [{ name: 'body', geometry: m.geometry, material: vertexColorToon(), matrix: new THREE.Matrix4(), castShadow: false, receiveShadow: true }];
    cache.set(key, parts);
  }
  return parts;
}

/** A ready-to-add decor object (shared meshes). */
export function createDecor(kind: DecorKindId | string, variant = 0): THREE.Object3D {
  const g = new THREE.Group();
  g.name = `decor:${kind}`;
  for (const p of getDecorParts(kind, variant)) {
    const m = new THREE.Mesh(p.geometry, p.material);
    m.name = p.name;
    m.castShadow = false;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}
