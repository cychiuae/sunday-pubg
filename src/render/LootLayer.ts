/**
 * Ground loot, fully instanced. Every distinct (geometry, material) part of every createLootModel(item, tier)
 * becomes one InstancedMesh shared by all loot (~30 draw calls for any amount of loot). Items bob and spin
 * (`loot.pickupBobHeight`), epic sparkles orbit, the highlighted loot gets a pulsing ring and a slight scale-up.
 * Owner: graphics-engineer.
 */
import * as THREE from 'three';
import type { Balance } from '../shared/balance';
import type { ItemId, LootId, LootState, LootTier, MapData } from '../shared/types';
import { ITEM_IDS } from '../shared/types';
import { anchorRestMatrix, extractParts, makeInstancedMesh, type TemplatePart } from './instancing';
import { createLootModel, palette } from './procedural';

const TIERS: readonly LootTier[] = ['common', 'rare', 'epic'];
const SPIN_SPEED = 1.6; // rad/s, visual only
const BOB_SPEED = 2.2;
const SPARKLE_SPEED = 0.9;
const BATCH_CAPACITY = 320;

interface Batch {
  mesh: THREE.InstancedMesh;
  cursor: number;
}
interface PartRef {
  batch: Batch;
  local: THREE.Matrix4;
  anchor: 'spin' | 'sparkles' | null;
}

/**
 * Fallback only (LootState.tier absent): the nearest map loot spawn within `radius` decides the tier ring. Dropped or
 * scattered loot away from spawns shows as common. Pure; exported for tests.
 */
export function tierForPosition(spawns: MapData['lootSpawns'], x: number, z: number, radius: number): LootTier {
  let best: LootTier = 'common';
  let bestD = radius * radius;
  for (const s of spawns) {
    const d = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = s.tier;
    }
  }
  return best;
}

/** Tier ring for one loot item: the sim's `tier` when present (Contract revision 1 #1), else nearest-spawn inference. */
export function lootTierOf(l: LootState, spawns: MapData['lootSpawns'], radius: number): LootTier {
  return l.tier ?? tierForPosition(spawns, l.pos.x, l.pos.z, radius);
}

export class LootLayer {
  readonly group = new THREE.Group();
  private readonly batches = new Map<string, Batch>();
  private readonly batchList: Batch[] = [];
  private readonly itemParts = new Map<ItemId, PartRef[]>();
  private readonly glowParts = new Map<LootTier, PartRef[]>();
  private readonly spinRest: THREE.Matrix4;
  private readonly sparkleRest: THREE.Matrix4;
  private readonly tierCache = new Map<LootId, LootTier>();
  private readonly highlight: THREE.Mesh;
  private readonly bobHeight: number;
  private readonly tierRadius: number;
  // scratch
  private readonly mBase = new THREE.Matrix4();
  private readonly mAnim = new THREE.Matrix4();
  private readonly mTmp = new THREE.Matrix4();
  private readonly mOut = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();

  constructor(
    private readonly map: MapData,
    balance: Balance,
  ) {
    this.group.name = 'loot';
    this.bobHeight = balance.loot.pickupBobHeight;
    this.tierRadius = balance.loot.extraAmmoScatter + 1.5;

    const anchors = ['spin', 'sparkles'] as const;
    let spinRest: THREE.Matrix4 | null = null;
    let sparkleRest: THREE.Matrix4 | null = null;
    for (const item of ITEM_IDS) {
      const t = createLootModel(item, 'common');
      spinRest ??= anchorRestMatrix(t, 'spin');
      const refs = extractParts(t, anchors)
        .filter((p) => p.anchor === 'spin')
        .map((p) => this.ref(p));
      this.itemParts.set(item, refs);
    }
    for (const tier of TIERS) {
      const t = createLootModel('bandage', tier);
      if (tier === 'epic') sparkleRest = anchorRestMatrix(t, 'sparkles');
      const refs = extractParts(t, anchors)
        .filter((p) => p.anchor !== 'spin')
        .map((p) => this.ref(p));
      this.glowParts.set(tier, refs);
    }
    this.spinRest = spinRest ?? new THREE.Matrix4();
    this.sparkleRest = sparkleRest ?? new THREE.Matrix4();

    const ringGeo = new THREE.RingGeometry(0.66, 0.78, 32).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: palette.foam, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    ringMat.name = 'loot:highlight';
    this.highlight = new THREE.Mesh(ringGeo, ringMat);
    this.highlight.name = 'loot:highlight';
    this.highlight.visible = false;
    this.highlight.renderOrder = 4;
    this.group.add(this.highlight);
  }

  private ref(p: TemplatePart): PartRef {
    const key = `${p.geometry.uuid}|${p.material.uuid}`;
    let batch = this.batches.get(key);
    if (!batch) {
      batch = { mesh: makeInstancedMesh(p, BATCH_CAPACITY, `loot:${p.name}`), cursor: 0 };
      this.batches.set(key, batch);
      this.batchList.push(batch);
      this.group.add(batch.mesh);
    }
    return { batch, local: p.matrix, anchor: p.anchor === 'spin' ? 'spin' : p.anchor === 'sparkles' ? 'sparkles' : null };
  }

  private tierOf(l: LootState): LootTier {
    // M1-fix: the sim's spawn-point tier wins (Contract revision 1 #1); no cache needed. Nearest-spawn inference is
    // only the fallback for producers that do not send it yet.
    if (l.tier !== undefined) return l.tier;
    let t = this.tierCache.get(l.id);
    if (t === undefined) {
      if (this.tierCache.size > 1024) this.tierCache.clear();
      t = lootTierOf(l, this.map.lootSpawns, this.tierRadius);
      this.tierCache.set(l.id, t);
    }
    return t;
  }

  private push(ref: PartRef, world: THREE.Matrix4): void {
    const b = ref.batch;
    if (b.cursor >= BATCH_CAPACITY) return;
    this.mOut.multiplyMatrices(world, ref.local);
    this.mOut.toArray(b.mesh.instanceMatrix.array as Float32Array, b.cursor * 16);
    b.cursor++;
  }

  update(
    loot: readonly LootState[],
    highlightId: LootId | null,
    time: number,
    frustum: THREE.Frustum,
    cam: THREE.Vector3,
    drawDistance: number,
  ): void {
    for (let i = 0; i < this.batchList.length; i++) this.batchList[i].cursor = 0;
    const far2 = drawDistance * drawDistance;
    let highlightPos: LootState | null = null;

    for (let i = 0; i < loot.length; i++) {
      const l = loot[i];
      const isHi = l.id === highlightId;
      if (isHi) highlightPos = l;
      const d2 = (l.pos.x - cam.x) ** 2 + (l.pos.y - cam.y) ** 2 + (l.pos.z - cam.z) ** 2;
      if (d2 > far2 && !isHi) continue;
      this.sphere.center.set(l.pos.x, l.pos.y + 0.6, l.pos.z);
      this.sphere.radius = 1.4;
      if (!frustum.intersectsSphere(this.sphere)) continue;

      const phase = l.id * 0.73;
      this.mBase.makeTranslation(l.pos.x, l.pos.y, l.pos.z);
      // Item: base * spinRest * T(bob) * Ry(spin) * S(highlight)
      const bob = (Math.sin(time * BOB_SPEED + phase) * 0.5 + 0.5) * this.bobHeight;
      this.mAnim.makeRotationY(time * SPIN_SPEED + phase);
      if (isHi) this.mAnim.scale(_hiScale);
      this.mAnim.setPosition(0, bob, 0);
      this.mTmp.multiplyMatrices(this.mBase, this.spinRest).multiply(this.mAnim);
      const items = this.itemParts.get(l.item);
      if (items) for (let k = 0; k < items.length; k++) this.push(items[k], this.mTmp);

      const glow = this.glowParts.get(this.tierOf(l));
      if (glow) {
        for (let k = 0; k < glow.length; k++) {
          const ref = glow[k];
          if (ref.anchor === 'sparkles') {
            this.mAnim.makeRotationY(time * SPARKLE_SPEED + phase);
            this.mTmp.multiplyMatrices(this.mBase, this.sparkleRest).multiply(this.mAnim);
            this.push(ref, this.mTmp);
          } else {
            this.push(ref, this.mBase);
          }
        }
      }
    }

    for (let i = 0; i < this.batchList.length; i++) {
      const b = this.batchList[i];
      const m = b.mesh;
      m.count = b.cursor;
      m.visible = b.cursor > 0;
      m.instanceMatrix.clearUpdateRanges();
      if (b.cursor > 0) {
        m.instanceMatrix.addUpdateRange(0, b.cursor * 16);
        m.instanceMatrix.needsUpdate = true;
      }
    }

    if (highlightPos) {
      const s = 1 + 0.08 * Math.sin(time * 6);
      this.highlight.visible = true;
      this.highlight.position.set(highlightPos.pos.x, highlightPos.pos.y + 0.04, highlightPos.pos.z);
      this.highlight.scale.set(s, 1, s);
    } else {
      this.highlight.visible = false;
    }
  }

  /** Forget cached tiers (new match). */
  reset(): void {
    this.tierCache.clear();
  }

  dispose(): void {
    for (const b of this.batchList) b.mesh.dispose();
    this.highlight.geometry.dispose();
    (this.highlight.material as THREE.Material).dispose();
    this.group.clear();
  }
}

const _hiScale = new THREE.Vector3(1.15, 1.15, 1.15);
