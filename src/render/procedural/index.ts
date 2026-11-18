/**
 * Procedural model factories (graphics-designer). Public surface consumed by src/render/.
 * Contract: docs/tech/ARCHITECTURE.md §12 (graphics-engineer). Art spec: docs/art/STYLE.md.
 */
import type * as THREE from 'three';
import type { Appearance } from '../../shared/types';
import { createChibi, type ChibiModel } from './chibi';
import { toonMaterial } from './materials';

export * from './materials';
export * from './chibi';
export * from './props';
export * from './weapons';
export * from './loot';
export { buildMerged, countTris, type Merged, type Piece } from './builder';

export interface CharacterModel {
  root: THREE.Group;
  head: THREE.Object3D;
  body: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  /** Weapon socket at the right hand (= chibi `hand_R_socket`). */
  handR: THREE.Object3D;
  handL: THREE.Object3D;
  /** Full chibi model: colour meshes, setVariant(), resetPose(). */
  chibi: ChibiModel;
}

/** Architecture-contract alias of `createChibi`. */
export function createCharacter(appearance: Appearance): CharacterModel {
  const chibi = createChibi(appearance);
  const p = chibi.parts;
  return {
    root: chibi.root,
    head: p.head,
    body: p.body,
    armL: p.armL,
    armR: p.armR,
    legL: p.legL,
    legR: p.legR,
    handR: p.hand_R_socket,
    handL: p.hand_L_socket,
    chibi,
  };
}

/** Architecture-contract alias of `toonMaterial(color)` (cached, shared 3-step gradient). */
export function createToonMaterial(color: number): THREE.MeshToonMaterial {
  return toonMaterial(color);
}
