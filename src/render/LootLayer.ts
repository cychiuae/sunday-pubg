/**
 * Ground loot. Owner: graphics-engineer.
 *
 * Items bob and spin (`loot.pickupBobHeight`), the highlighted loot gets a pulsing ring and a slight scale-up.
 *
 * M2c (Addendum 2: a distinct model per weapon level, plus mounted scopes): the item meshes are batched BY MATERIAL in
 * one `ModelBatch` (a BatchedMesh for every toon body + one for every ink hull), keyed `item|level|scope` and built
 * lazily, so any mix of 13 weapons x 4 levels x scopes on the ground costs 2 draw calls (+1 shadow). Parts with other
 * materials (`extras`, e.g. a see-through lens) and the ground markers stay instanced per distinct (geometry, material)
 * as before (InstancedMesh, 1 call per part kind in view).
 *
 * Markers: the M2b tier glow (disc, ring, sparkles by spot tier) until the sim sends `LootState.level`; from the first
 * levelled loot of a match on, the M2c markers (art M2c §1.3): level marker for weapons (level) and armor (id tier),
 * the cream supply marker for everything else. Pips turn with the item spin; L4 sparkles orbit.
 *
 * `LOOT_LAYER_DEFAULTS.batched = false` keeps the M2b path (one InstancedMesh per distinct item part) for measurements.
 */
import * as THREE from 'three';
import type { Balance } from '../shared/balance';
import type { ItemLevel, LootId, LootState, LootTier, MapBase } from '../shared/types';
import { anchorRestMatrix, extractParts, makeInstancedMesh, type TemplatePart } from './instancing';
import { ModelBatch, type ModelHandle } from './ModelBatch';
import { createLootMarker, createLootModel, isLevelledLootItem, palette } from './procedural';

const TIERS: readonly LootTier[] = ['common', 'rare', 'epic'];
const SPIN_SPEED = 1.6; // rad/s, visual only
const BOB_SPEED = 2.2;
const SPARKLE_SPEED = 0.9;
const BATCH_CAPACITY = 320;
const ANCHORS = ['spin', 'sparkles', 'pips'] as const;

/** Dev / measurement knob: batch item meshes by material (M2c) or one InstancedMesh per item part (M2b). */
export const LOOT_LAYER_DEFAULTS = { batched: true };

interface Batch {
  mesh: THREE.InstancedMesh;
  cursor: number;
  /** Marker batches: white material, the part colour per instance. */
  tinted: boolean;
}
interface PartRef {
  batch: Batch;
  local: THREE.Matrix4;
  anchor: 'spin' | 'sparkles' | 'pips' | null;
  /** Per-instance colour (tinted batches only). */
  color: THREE.Color | null;
}
interface MarkerSet {
  refs: PartRef[];
  sparkleRest: THREE.Matrix4;
}
interface ItemSlot {
  key: string;
  handle: ModelHandle;
  extras: PartRef[];
  seen: number;
}

/**
 * Fallback only (LootState.tier absent): the nearest map loot spawn within `radius` decides the tier ring. Dropped or
 * scattered loot away from spawns shows as common. Pure; exported for tests.
 */
export function tierForPosition(spawns: MapBase['lootSpawns'], x: number, z: number, radius: number): LootTier {
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
export function lootTierOf(l: LootState, spawns: MapBase['lootSpawns'], radius: number): LootTier {
  return l.tier ?? tierForPosition(spawns, l.pos.x, l.pos.z, radius);
}

/** ModelBatch key of a ground item: `item|level|scope` ('-' = none). Pure; exported for tests. */
export function lootModelKey(l: Pick<LootState, 'item' | 'level' | 'scope'>): string {
  return `${l.item}|${l.level ?? '-'}|${l.scope ?? '-'}`;
}

/**
 * M2c marker key: the item's level for weapons, the id tier for armor (vest_3 -> L3), else 'supply'. Pure; exported
 * for tests.
 */
export function lootMarkerKey(l: Pick<LootState, 'item' | 'level'>): string {
  if (l.level != null) return `L${l.level}`;
  const m = /^(?:vest|helmet)_([1-4])$/.exec(l.item);
  if (m) return `L${m[1]}`;
  return isLevelledLootItem(l.item) ? 'L1' : 'supply';
}

export class LootLayer {
  readonly group = new THREE.Group();
  private readonly batches = new Map<string, Batch>();
  private readonly batchList: Batch[] = [];
  private readonly ownedMats: THREE.Material[] = [];
  /** M2b path: item parts per item id. */
  private readonly itemParts = new Map<string, PartRef[]>();
  private readonly markers = new Map<string, MarkerSet>();
  private readonly spinRest: THREE.Matrix4;
  private readonly tierCache = new Map<LootId, LootTier>();
  private readonly highlight: THREE.Mesh;
  private readonly bobHeight: number;
  private readonly tierRadius: number;
  /** M2c item batch (null on the M2b path). */
  readonly items: ModelBatch | null;
  private readonly ownsItems: boolean;
  private readonly slots = new Map<LootId, ItemSlot>();
  private frame = 0;
  /** Sticky per match: switches the markers to the M2c set once the sim sends levels. */
  private levelMarkers = false;
  // scratch
  private readonly mBase = new THREE.Matrix4();
  private readonly mAnim = new THREE.Matrix4();
  private readonly mTmp = new THREE.Matrix4();
  private readonly mOut = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();

  /**
   * @param batch a shared ModelBatch (Renderer: the same one draws held items; not owned here), `true` for an own
   *   batch, `false` for the M2b instanced path.
   */
  constructor(
    private map: Pick<MapBase, 'lootSpawns'>,
    balance: Balance,
    batch: ModelBatch | boolean = LOOT_LAYER_DEFAULTS.batched,
  ) {
    this.group.name = 'loot';
    this.bobHeight = balance.loot.pickupBobHeight;
    this.tierRadius = balance.loot.extraAmmoScatter + 1.5;
    this.spinRest = anchorRestMatrix(createLootModel('bandage', 'common'), 'spin');
    if (batch instanceof ModelBatch) {
      this.items = batch;
      this.ownsItems = false;
    } else if (batch) {
      // Loot item meshes cast shadows but do not receive them (as the M2b meshes).
      this.items = new ModelBatch('loot', { instances: 128, vertices: 1 << 15, receiveShadow: false });
      this.group.add(this.items.body, this.items.hull);
      this.ownsItems = true;
    } else {
      this.items = null;
      this.ownsItems = false;
    }

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

  private ref(p: TemplatePart, tint = false): PartRef {
    // Markers: parts that differ only in colour (the level / tier disc, ring, ring2, sparkles) share one instanced
    // mesh with a white copy of the material and the colour per instance (art M2c §11.1: "instanced across all loot").
    const src = p.material as THREE.MeshBasicMaterial;
    const tinted = tint && src.isMeshBasicMaterial === true && !src.map;
    const key = tinted
      ? `tint|${p.geometry.uuid}|${src.opacity}|${src.transparent}|${src.blending}|${src.vertexColors}|${src.side}|${src.depthWrite}|${p.renderOrder}`
      : `${p.geometry.uuid}|${p.material.uuid}`;
    let batch = this.batches.get(key);
    if (!batch) {
      let part = p;
      if (tinted) {
        const mat = src.clone();
        mat.color.set(0xffffff);
        mat.name = `${src.name}:tinted`;
        this.ownedMats.push(mat);
        part = { ...p, material: mat };
      }
      batch = { mesh: makeInstancedMesh(part, BATCH_CAPACITY, `loot:${p.name}`), cursor: 0, tinted };
      if (tinted) batch.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BATCH_CAPACITY * 3), 3).setUsage(THREE.DynamicDrawUsage);
      this.batches.set(key, batch);
      this.batchList.push(batch);
      this.group.add(batch.mesh);
    }
    const a = p.anchor;
    return {
      batch,
      local: p.matrix,
      anchor: a === 'spin' || a === 'sparkles' || a === 'pips' ? a : null,
      color: tinted ? src.color.clone() : null,
    };
  }

  /** M2b path: the item parts of `item` (built on first use). */
  private itemRefs(item: string): PartRef[] {
    let refs = this.itemParts.get(item);
    if (!refs) {
      refs = extractParts(createLootModel(item, 'common'), ANCHORS).filter((p) => p.anchor === 'spin').map((p) => this.ref(p));
      this.itemParts.set(item, refs);
    }
    return refs;
  }

  /** Marker parts for a key: 'tier:<t>' (M2b glow), 'L1'..'L4' or 'supply' (M2c). Built on first use. */
  private markerSet(key: string): MarkerSet {
    let m = this.markers.get(key);
    if (!m) {
      let root: THREE.Object3D;
      if (key.startsWith('tier:')) root = createLootModel('bandage', key.slice(5) as LootTier);
      else {
        root = new THREE.Group();
        root.add(createLootMarker(key === 'supply' ? 'supply' : (Number(key.slice(1)) as ItemLevel)));
      }
      const refs = extractParts(root, ANCHORS).filter((p) => p.anchor !== 'spin').map((p) => this.ref(p, true));
      m = { refs, sparkleRest: anchorRestMatrix(root, 'sparkles') };
      this.markers.set(key, m);
    }
    return m;
  }

  /** M2c path: the batch handle for loot `l` (acquired, or swapped when its model key changed). */
  private slotFor(l: LootState): ItemSlot {
    const items = this.items!;
    const key = `loot:${lootModelKey(l)}`;
    let s = this.slots.get(l.id);
    if (!s) {
      if (!items.has(key)) {
        const item = l.item, level = l.level ?? null, scope = l.scope ?? null;
        items.register(key, () => createLootModel(item, 'common', { level, scope, marker: 'tier' }), 'spin');
      }
      const handle = items.acquire(key);
      s = { key, handle, extras: handle.entry.extras.map((p) => this.ref(p)), seen: 0 };
      this.slots.set(l.id, s);
    } else if (s.key !== key) {
      if (!items.has(key)) {
        const item = l.item, level = l.level ?? null, scope = l.scope ?? null;
        items.register(key, () => createLootModel(item, 'common', { level, scope, marker: 'tier' }), 'spin');
      }
      items.swap(s.handle, key);
      s.key = key;
      s.extras = s.handle.entry.extras.map((p) => this.ref(p));
    }
    return s;
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
    if (ref.color && b.mesh.instanceColor) ref.color.toArray(b.mesh.instanceColor.array as Float32Array, b.cursor * 3);
    b.cursor++;
  }

  /** M2b map change: tier inference uses the new map's loot spawns; a new match starts with the tier markers. */
  setMap(map: Pick<MapBase, 'lootSpawns'>): void {
    this.map = map;
    this.tierCache.clear();
    this.levelMarkers = false;
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
    const frame = ++this.frame;
    const items = this.items;

    for (let i = 0; i < loot.length; i++) {
      const l = loot[i];
      if (!this.levelMarkers && l.level != null) this.levelMarkers = true;
      const isHi = l.id === highlightId;
      if (isHi) highlightPos = l;
      const slot = items ? this.slotFor(l) : null;
      if (slot) slot.seen = frame;
      const d2 = (l.pos.x - cam.x) ** 2 + (l.pos.y - cam.y) ** 2 + (l.pos.z - cam.z) ** 2;
      this.sphere.center.set(l.pos.x, l.pos.y + 0.6, l.pos.z);
      this.sphere.radius = 1.4;
      if ((d2 > far2 && !isHi) || !frustum.intersectsSphere(this.sphere)) {
        if (slot && items) items.setVisible(slot.handle, false);
        continue;
      }

      const phase = l.id * 0.73;
      const spin = time * SPIN_SPEED + phase;
      this.mBase.makeTranslation(l.pos.x, l.pos.y, l.pos.z);
      // Item: base * spinRest * T(bob) * Ry(spin) * S(highlight)
      const bob = (Math.sin(time * BOB_SPEED + phase) * 0.5 + 0.5) * this.bobHeight;
      this.mAnim.makeRotationY(spin);
      if (isHi) this.mAnim.scale(_hiScale);
      this.mAnim.setPosition(0, bob, 0);
      this.mTmp.multiplyMatrices(this.mBase, this.spinRest).multiply(this.mAnim);
      if (slot && items) {
        items.setMatrix(slot.handle, this.mTmp);
        items.setVisible(slot.handle, true);
        for (let k = 0; k < slot.extras.length; k++) this.push(slot.extras[k], this.mTmp);
      } else {
        const refs = this.itemRefs(l.item);
        for (let k = 0; k < refs.length; k++) this.push(refs[k], this.mTmp);
      }

      const marker = this.markerSet(this.levelMarkers ? lootMarkerKey(l) : `tier:${this.tierOf(l)}`);
      for (let k = 0; k < marker.refs.length; k++) {
        const ref = marker.refs[k];
        if (ref.anchor === 'sparkles') {
          this.mAnim.makeRotationY(time * SPARKLE_SPEED + phase);
          this.mTmp.multiplyMatrices(this.mBase, marker.sparkleRest).multiply(this.mAnim);
          this.push(ref, this.mTmp);
        } else if (ref.anchor === 'pips') {
          // Pips turn with the item (art M2c §1.3); the pips group sits at the marker origin.
          this.mAnim.makeRotationY(spin);
          this.mTmp.multiplyMatrices(this.mBase, this.mAnim);
          this.push(ref, this.mTmp);
        } else {
          this.push(ref, this.mBase);
        }
      }
    }

    // Loot that left the list (picked up, despawned): free its batch instance.
    if (items && this.slots.size > 0) {
      for (const [id, s] of this.slots) {
        if (s.seen === frame) continue;
        items.release(s.handle);
        this.slots.delete(id);
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
        if (b.tinted && m.instanceColor) {
          m.instanceColor.clearUpdateRanges();
          m.instanceColor.addUpdateRange(0, b.cursor * 3);
          m.instanceColor.needsUpdate = true;
        }
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
    for (const m of this.ownedMats) m.dispose();
    if (this.ownsItems) this.items?.dispose();
    else if (this.items) for (const sl of this.slots.values()) this.items.release(sl.handle);
    this.slots.clear();
    this.highlight.geometry.dispose();
    (this.highlight.material as THREE.Material).dispose();
    this.group.clear();
  }
}

const _hiScale = new THREE.Vector3(1.15, 1.15, 1.15);
