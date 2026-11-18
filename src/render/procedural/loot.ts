/**
 * Ground loot pickups. Owner: graphics-designer. Spec: docs/art/STYLE.md "Loot".
 *
 * Structure of createLootModel(item, tier):
 *   root 'loot:<item>' (origin on the ground)
 *   ├─ 'spin'  Group at y = LOOT_HOVER_Y: the item mesh. Renderer bobs (`loot.pickupBobHeight`) and spins THIS.
 *   └─ 'glow'  tier marker on the ground (unlit, no shadows):
 *        disc + ring + ink rim (all tiers), short beam (rare), double ring + tall beam + 'sparkles' (epic)
 *        'sparkles' is a Group of 4 diamonds the renderer may rotate.
 * Tier is shape-coded as well as colour-coded (colour-blind safe):
 *   common = 1 ring, no beam | rare = 1 ring + 1.2 m beam | epic = 2 rings + 2.4 m beam + sparkles.
 */
import * as THREE from 'three';
import type { ItemId, LootTier } from '../../shared/types';
import { buildMerged, xf, type Merged, type Piece } from './builder';
import { addOutline, OUTLINE, palette, vertexColorToon } from './materials';
import { getPropParts } from './props';
import { getWeaponGeometry } from './weapons';

export const LOOT_HOVER_Y = 0.45;
export const TIER_COLORS: Record<LootTier, number> = {
  common: palette.tierCommon,
  rare: palette.tierRare,
  epic: palette.tierEpic,
};
const LOOT_OUTLINE = OUTLINE.small * 1.5;

// -------------------------------------------------------------------------------------------------
// Item meshes
// -------------------------------------------------------------------------------------------------
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (r: number, h: number, seg = 6) => new THREE.CylinderGeometry(r, r, h, seg);

function ammoPieces(kind: 'ammo_light' | 'ammo_heavy' | 'ammo_shell'): Piece[] {
  const P: Piece[] = [];
  const col = kind === 'ammo_light' ? palette.ammoLight : kind === 'ammo_heavy' ? palette.ammoHeavy : palette.ammoShell;
  const w = kind === 'ammo_heavy' ? 0.4 : 0.34;
  P.push({ geo: box(w, 0.2, 0.24), color: col, matrix: xf([0, -0.05, 0]) });
  P.push({ geo: box(w + 0.006, 0.06, 0.246), color: palette.gunDark, matrix: xf([0, -0.05, 0]), outline: false });
  for (const x of [-0.1, 0, 0.1]) {
    if (kind === 'ammo_light') {
      // short round-nose
      P.push({ geo: cyl(0.03, 0.07), color: palette.brass, matrix: xf([x, 0.085, 0]) });
      P.push({ geo: new THREE.SphereGeometry(0.03, 6, 2, 0, Math.PI * 2, 0, Math.PI / 2), color: 0xd9844a, matrix: xf([x, 0.12, 0]) });
    } else if (kind === 'ammo_shell') {
      // fat flat-top shells with brass base
      P.push({ geo: cyl(0.045, 0.1), color: palette.ammoShell, matrix: xf([x, 0.1, 0]) });
      P.push({ geo: cyl(0.048, 0.03), color: palette.brass, matrix: xf([x, 0.065, 0]), outline: false });
    } else {
      // tall pointed
      P.push({ geo: cyl(0.026, 0.14), color: palette.brass, matrix: xf([x * 1.2, 0.12, 0]) });
      P.push({ geo: new THREE.ConeGeometry(0.026, 0.06, 8), color: 0xd9844a, matrix: xf([x * 1.2, 0.22, 0]) });
    }
  }
  return P;
}

function bandagePieces(): Piece[] {
  return [
    { geo: cyl(0.09, 0.16, 10), color: palette.bandage, matrix: xf([-0.06, -0.06, 0], [0, 0, Math.PI / 2]) },
    { geo: cyl(0.092, 0.04, 10).rotateZ(Math.PI / 2), color: palette.bandageStripe, matrix: xf([-0.06, -0.06, 0]), outline: false },
    { geo: cyl(0.075, 0.14, 10), color: palette.bandage, matrix: xf([0.13, -0.08, 0.04]) },
    { geo: cyl(0.077, 0.035, 10), color: palette.bandageStripe, matrix: xf([0.13, -0.08, 0.04]), outline: false },
    { geo: box(0.14, 0.006, 0.08), color: palette.bandage, matrix: xf([-0.06, -0.15, -0.12], [0.2, 0.3, 0]), outline: false },
  ];
}

function medkitPieces(): Piece[] {
  const g = palette.medkitCross;
  return [
    { geo: box(0.44, 0.3, 0.26), color: palette.medkit, matrix: xf([0, -0.03, 0]) },
    { geo: box(0.445, 0.04, 0.265), color: 0xdfe6ea, matrix: xf([0, 0.07, 0]), outline: false },
    // green plus (NOT a red cross) on both faces and lid
    { geo: box(0.17, 0.055, 0.012), color: g, matrix: xf([0, -0.04, -0.132]), outline: false },
    { geo: box(0.055, 0.17, 0.012), color: g, matrix: xf([0, -0.04, -0.132]), outline: false },
    { geo: box(0.17, 0.055, 0.012), color: g, matrix: xf([0, -0.04, 0.132]), outline: false },
    { geo: box(0.055, 0.17, 0.012), color: g, matrix: xf([0, -0.04, 0.132]), outline: false },
    { geo: box(0.17, 0.012, 0.055), color: g, matrix: xf([0, 0.122, 0]), outline: false },
    { geo: box(0.055, 0.012, 0.17), color: g, matrix: xf([0, 0.122, 0]), outline: false },
    { geo: box(0.16, 0.03, 0.04), color: palette.gunDark, matrix: xf([0, 0.19, 0]) },
    { geo: box(0.03, 0.06, 0.04), color: palette.gunDark, matrix: xf([-0.065, 0.15, 0]) },
    { geo: box(0.03, 0.06, 0.04), color: palette.gunDark, matrix: xf([0.065, 0.15, 0]) },
  ];
}

function vestPieces(): Piece[] {
  const c = palette.vest, s = palette.vestStrap;
  return [
    { geo: new THREE.CapsuleGeometry(0.17, 0.16, 3, 10), color: c, matrix: xf([0, 0, 0], [0, 0, 0], [1, 1, 0.55]) },
    { geo: new THREE.SphereGeometry(0.07, 8, 4), color: palette.gunDark, matrix: xf([0, 0.2, 0], [0, 0, 0], [1, 0.4, 0.8]), outline: false }, // neck hole
    { geo: box(0.1, 0.06, 0.2), color: c, matrix: xf([-0.12, 0.2, 0]) },
    { geo: box(0.1, 0.06, 0.2), color: c, matrix: xf([0.12, 0.2, 0]) },
    { geo: box(0.36, 0.045, 0.2), color: s, matrix: xf([0, -0.02, 0]), outline: false },
    { geo: box(0.35, 0.045, 0.2), color: s, matrix: xf([0, -0.14, 0]), outline: false },
    { geo: box(0.05, 0.05, 0.012), color: palette.brass, matrix: xf([0, -0.02, -0.1]), outline: false },
    { geo: box(0.05, 0.05, 0.012), color: palette.brass, matrix: xf([0, -0.14, -0.1]), outline: false },
  ];
}

const itemCache = new Map<string, Merged>();
function itemGeometry(item: string): { merged: Merged; scale: number; rotY: number } | null {
  const gun = getWeaponGeometry(item);
  if (gun) {
    // Guns are shown side-on and enlarged so they read at range.
    return { merged: gun.merged, scale: item === 'pistol' ? 1.9 : 1.35, rotY: Math.PI / 2 };
  }
  let m = itemCache.get(item);
  if (!m) {
    let pieces: Piece[] | null = null;
    if (item === 'ammo_light' || item === 'ammo_heavy' || item === 'ammo_shell') pieces = ammoPieces(item);
    else if (item === 'bandage') pieces = bandagePieces();
    else if (item === 'medkit') pieces = medkitPieces();
    else if (item === 'vest') pieces = vestPieces();
    if (!pieces) return null;
    m = buildMerged(pieces, `loot:${item}`);
    itemCache.set(item, m);
  }
  return { merged: m, scale: 1, rotY: 0.4 };
}

// -------------------------------------------------------------------------------------------------
// Tier glow
// -------------------------------------------------------------------------------------------------
const glowGeo = {
  disc: new THREE.CircleGeometry(0.55, 24).rotateX(-Math.PI / 2),
  ring: new THREE.RingGeometry(0.47, 0.57, 24).rotateX(-Math.PI / 2),
  rim: new THREE.RingGeometry(0.57, 0.62, 24).rotateX(-Math.PI / 2),
  ring2: new THREE.RingGeometry(0.3, 0.36, 24).rotateX(-Math.PI / 2),
  sparkle: new THREE.OctahedronGeometry(0.06, 0).scale(0.7, 1.4, 0.7),
};

/** Open cylinder whose vertex colour fades from the tier colour at the base to black (additive => invisible) at the top. */
function beamGeometry(height: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.32, 0.42, height, 16, 4, true).translate(0, height / 2, 0);
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = 1 - pos.getY(i) / height;
    const a = t * t;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = a;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
const beamGeos = new Map<number, THREE.BufferGeometry>();
const beamGeo = (h: number) => {
  let g = beamGeos.get(h);
  if (!g) beamGeos.set(h, (g = beamGeometry(h)));
  return g;
};

const glowMats = new Map<string, THREE.Material>();
function glowMat(key: string, make: () => THREE.Material): THREE.Material {
  let m = glowMats.get(key);
  if (!m) {
    m = make();
    m.name = `lootGlow:${key}`;
    glowMats.set(key, m);
  }
  return m;
}
const flat = (color: number, opacity: number) =>
  new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false,
  });

function glowMesh(name: string, geo: THREE.BufferGeometry, mat: THREE.Material, y: number, renderOrder: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.position.y = y;
  m.renderOrder = renderOrder;
  m.castShadow = false;
  m.receiveShadow = false;
  m.raycast = () => {};
  return m;
}

function createGlow(tier: LootTier): THREE.Group {
  const c = TIER_COLORS[tier];
  const g = new THREE.Group();
  g.name = 'glow';
  g.add(glowMesh('disc', glowGeo.disc, glowMat(`disc|${tier}`, () => flat(c, 0.28)), 0.02, 1));
  g.add(glowMesh('rim', glowGeo.rim, glowMat('rim', () => flat(palette.ink, 0.55)), 0.025, 2));
  g.add(glowMesh('ring', glowGeo.ring, glowMat(`ring|${tier}`, () => flat(c, 0.95)), 0.025, 2));
  if (tier === 'epic') g.add(glowMesh('ring2', glowGeo.ring2, glowMat(`ring|${tier}`, () => flat(c, 0.95)), 0.025, 2));
  if (tier !== 'common') {
    const beamMat = glowMat(`beam|${tier}`, () =>
      new THREE.MeshBasicMaterial({
        color: c, vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      }),
    );
    g.add(glowMesh('beam', beamGeo(tier === 'epic' ? 2.4 : 1.2), beamMat, 0.02, 3));
  }
  if (tier === 'epic') {
    const sp = new THREE.Group();
    sp.name = 'sparkles';
    const mat = glowMat(`sparkle|${tier}`, () => new THREE.MeshBasicMaterial({ color: mixWhite(c), toneMapped: false }));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const s = glowMesh('sparkle', glowGeo.sparkle, mat, 0.35 + (i % 2) * 0.35, 0);
      s.position.x = Math.cos(a) * 0.5;
      s.position.z = Math.sin(a) * 0.5;
      sp.add(s);
    }
    g.add(sp);
  }
  return g;
}
const mixWhite = (c: number) => new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.45).getHex();

// -------------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------------
/**
 * Pickup model for a ground item. Unknown items fall back to a mini crate.
 * Renderer: bob/spin the child named 'spin'; optionally rotate 'glow/sparkles'.
 */
export function createLootModel(item: ItemId | string, tier: LootTier = 'common'): THREE.Object3D {
  const root = new THREE.Group();
  root.name = `loot:${item}`;
  root.userData.item = item;
  root.userData.tier = tier;

  const spin = new THREE.Group();
  spin.name = 'spin';
  spin.position.y = LOOT_HOVER_Y;
  root.add(spin);

  const geo = itemGeometry(item);
  if (geo) {
    const mesh = new THREE.Mesh(geo.merged.geometry, vertexColorToon());
    mesh.name = 'item';
    mesh.castShadow = true;
    if (!geo.merged.geometry.boundingBox) geo.merged.geometry.computeBoundingBox();
    const centre = geo.merged.geometry.boundingBox!.getCenter(new THREE.Vector3());
    mesh.scale.setScalar(geo.scale);
    mesh.rotation.y = geo.rotY;
    // Centre the item on the spin axis.
    mesh.position.copy(centre.multiplyScalar(-geo.scale).applyAxisAngle(new THREE.Vector3(0, 1, 0), geo.rotY));
    if (geo.merged.outline) addOutline(mesh, LOOT_OUTLINE, palette.ink, geo.merged.outline);
    spin.add(mesh);
  } else {
    for (const p of getPropParts('crate')) {
      const m = new THREE.Mesh(p.geometry, p.material);
      m.name = p.name === 'body' ? 'item' : p.name;
      m.scale.setScalar(0.38);
      m.position.y = -0.19;
      m.castShadow = p.castShadow;
      spin.add(m);
    }
  }

  root.add(createGlow(tier));
  return root;
}
