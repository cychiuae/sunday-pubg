/**
 * Name tags above other players (B9 optional). Owner: graphics-engineer.
 *
 * One draw call for all tags: names are rasterised once into a shared canvas atlas (one row per player, redrawn only
 * when a name changes) and drawn as camera-facing quads from one InstancedBufferGeometry. Tags keep a constant
 * on-screen height, are depth-tested (terrain and props hide them, so they are not a wallhack), fade out with
 * distance, and are hidden for the local player, the spectate target and the dead. Names come from PlayerState, so
 * no player-facing text lives here.
 */
import * as THREE from 'three';
import type { PlayerView } from '../shared/contracts';
import type { PlayerId } from '../shared/types';
import { palette } from './procedural';

const ATLAS_W = 512;
const ROW_H = 40;
/** Enough rows for maxPlayers (16) plus churn between matches; rows are recycled. */
const SLOTS = 32;
const ATLAS_H = ROW_H * SLOTS; // 1280
const FONT_PX = 26;
const PAD_PX = 6;
/** Tag height as a fraction of the viewport height (about 19 px at 720p, 28 px at 1080p). */
const SCREEN_HEIGHT_FRAC = 0.026;
/** Metres above the feet (balance player height + this). */
const HEAD_CLEARANCE = 0.45;
const FADE_START = 30;
const FADE_END = 45;
const INK_CSS = `#${palette.ink.toString(16).padStart(6, '0')}`;
const FILL_CSS = '#fff8ea';
const FONT = `600 ${FONT_PX}px ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', 'Varela Round', 'Nunito', system-ui, sans-serif`;

const vertex = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aRect;      // u0, v0, u1, v1
attribute vec2 aAspectAlpha; // width / height, alpha
uniform float uScale;      // view-space height per unit view depth
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  float h = uScale * max(-mv.z, 0.1);
  mv.xy += vec2(position.x * aAspectAlpha.x, position.y + 0.5) * h;
  vUv = mix(aRect.xy, aRect.zw, uv);
  vAlpha = aAspectAlpha.y;
  gl_Position = projectionMatrix * mv;
}
`;

const fragment = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 c = texture2D(uAtlas, vUv);
  float a = c.a * vAlpha;
  if (a < 0.02) discard;
  gl_FragColor = vec4(c.rgb, a);
  #include <colorspace_fragment>
}
`;

function markRange(a: THREE.InstancedBufferAttribute, count: number): void {
  a.clearUpdateRanges();
  a.addUpdateRange(0, count * a.itemSize);
  a.needsUpdate = true;
}

interface Slot {
  row: number;
  name: string;
  /** Text width in atlas pixels (with padding). */
  widthPx: number;
  seen: number;
}

/** Atlas-space rectangle for a row (flipY texture: canvas row 0 is v = 1). Pure; exported for tests. */
export function tagRect(row: number, widthPx: number, out: Float32Array, offset: number): void {
  const u0 = (ATLAS_W - widthPx) * 0.5 / ATLAS_W;
  const u1 = (ATLAS_W + widthPx) * 0.5 / ATLAS_W;
  out[offset] = u0;
  out[offset + 1] = 1 - ((row + 1) * ROW_H) / ATLAS_H;
  out[offset + 2] = u1;
  out[offset + 3] = 1 - (row * ROW_H) / ATLAS_H;
}

export class NameTags {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly rect: THREE.InstancedBufferAttribute;
  private readonly aspectAlpha: THREE.InstancedBufferAttribute;
  private readonly slots = new Map<PlayerId, Slot>();
  private readonly freeRows: number[] = [];
  private readonly releaseList: PlayerId[] = [];
  private frame = 0;
  private enabled = true;

  constructor(private readonly playerHeight: number) {
    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(ATLAS_W, ATLAS_H)
        : Object.assign(document.createElement('canvas'), { width: ATLAS_W, height: ATLAS_H });
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('NameTags: 2D canvas unavailable');
    this.ctx = ctx;
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (let r = SLOTS - 1; r >= 0; r--) this.freeRows.push(r);

    this.texture = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.anisotropy = 1;
    this.texture.name = 'nameTags:atlas';

    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(SLOTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.rect = new THREE.InstancedBufferAttribute(new Float32Array(SLOTS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aspectAlpha = new THREE.InstancedBufferAttribute(new Float32Array(SLOTS * 2), 2).setUsage(
      THREE.DynamicDrawUsage,
    );
    this.geometry.setAttribute('aPos', this.pos);
    this.geometry.setAttribute('aRect', this.rect);
    this.geometry.setAttribute('aAspectAlpha', this.aspectAlpha);
    this.geometry.instanceCount = 0;
    this.geometry.name = 'nameTags';

    this.material = new THREE.ShaderMaterial({
      name: 'nameTags',
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: { uAtlas: { value: this.texture }, uScale: { value: 0.05 } },
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'nameTags';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Call when the camera FOV changes (keeps a constant on-screen height). */
  setFov(fovDeg: number): void {
    this.material.uniforms.uScale.value = SCREEN_HEIGHT_FRAC * 2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.mesh.visible = on;
  }

  update(players: readonly PlayerView[], cam: THREE.Vector3): void {
    this.frame++;
    let n = 0;
    if (this.enabled) {
      const pos = this.pos.array as Float32Array;
      const rect = this.rect.array as Float32Array;
      const aa = this.aspectAlpha.array as Float32Array;
      const y = this.playerHeight + HEAD_CLEARANCE;
      for (let i = 0; i < players.length && n < SLOTS; i++) {
        const p = players[i];
        const s = p.state;
        if (p.isLocal || p.isSpectateTarget || !s.alive || !s.name) continue;
        const d = Math.hypot(s.pos.x - cam.x, s.pos.y - cam.y, s.pos.z - cam.z);
        if (d >= FADE_END) continue;
        const slot = this.slotFor(s.id, s.name);
        if (!slot) continue;
        slot.seen = this.frame;
        pos[n * 3] = s.pos.x;
        pos[n * 3 + 1] = s.pos.y + y;
        pos[n * 3 + 2] = s.pos.z;
        tagRect(slot.row, slot.widthPx, rect, n * 4);
        aa[n * 2] = slot.widthPx / ROW_H;
        aa[n * 2 + 1] = d <= FADE_START ? 1 : 1 - (d - FADE_START) / (FADE_END - FADE_START);
        n++;
      }
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      markRange(this.pos, n);
      markRange(this.rect, n);
      markRange(this.aspectAlpha, n);
    }
    // Recycle rows of players that have not been tagged for a while (left, or out of range for ~5 s at 60 fps).
    if ((this.frame & 63) === 0) {
      this.releaseList.length = 0;
      for (const [id, slot] of this.slots) if (this.frame - slot.seen > 300) this.releaseList.push(id);
      for (const id of this.releaseList) {
        const slot = this.slots.get(id)!;
        this.slots.delete(id);
        this.freeRows.push(slot.row);
      }
    }
  }

  private slotFor(id: PlayerId, name: string): Slot | null {
    let slot = this.slots.get(id);
    if (slot && slot.name === name) return slot;
    if (!slot) {
      const row = this.freeRows.pop();
      if (row === undefined) return null;
      slot = { row, name: '', widthPx: 0, seen: this.frame };
      this.slots.set(id, slot);
    }
    slot.name = name;
    slot.widthPx = this.draw(slot.row, name);
    return slot;
  }

  /** Rasterise one name into its atlas row. Returns the used width in pixels. Only on join or rename. */
  private draw(row: number, name: string): number {
    const ctx = this.ctx;
    const y0 = row * ROW_H;
    ctx.clearRect(0, y0, ATLAS_W, ROW_H);
    // Names are 1-16 chars (server-validated); maxWidth squeezes anything wider instead of clipping it.
    const maxText = ATLAS_W - PAD_PX * 2 - 8;
    const w = Math.min(maxText, Math.ceil(ctx.measureText(name).width));
    const cx = ATLAS_W / 2;
    const cy = y0 + ROW_H / 2 + 1;
    ctx.lineWidth = 6;
    ctx.strokeStyle = INK_CSS;
    ctx.strokeText(name, cx, cy, maxText);
    ctx.fillStyle = FILL_CSS;
    ctx.fillText(name, cx, cy, maxText);
    this.texture.needsUpdate = true;
    return w + PAD_PX * 2;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.slots.clear();
  }
}
