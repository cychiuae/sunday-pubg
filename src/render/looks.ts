/**
 * M2c look presets (art M2c.md §10; ADR 0007 §1.8). One preset per match, picked by the layout generator and carried
 * on `mapChanged.look` (later also `FrameView.look`). Cosmetic only: no sim code reads them. Owner: graphics-engineer.
 *
 * `noon` IS `ISLAND_LOOK` and `day` IS `OFFICE_LOOK` (the same objects), so the default look and every pinned QA
 * baseline stay exactly as they were. Every optional field below falls back to today's value when absent.
 *
 * Mapping the art table onto the code: the art spec's `noon` column (sun 2.4, hemisphere 1.0, fog 60 / 260 m,
 * direction (-0.55, 0.75, 0.35)) does not match the shipped M1 look (sun 1.65, hemisphere 1.55, fog 140 / 900 m,
 * direction (0.48, 0.78, 0.40)). Colours are taken from the art table as written (they match the palette at noon).
 * Intensities and fog distances are taken RELATIVE to the art noon column and applied to the shipped noon values
 * (morning sun = 2.0 / 2.4 x 1.65), so each preset keeps its intended mood against the real baseline and the
 * guardrails hold (fog far >= 200 m, hemisphere >= 0.85). Directions are taken as written (they encode east / west).
 * The office `day` column equals the shipped office look, so the office presets use the art numbers directly.
 */
import * as THREE from 'three';
import type { IslandLookId, LookId, MapKind, OfficeLookId } from '../shared/types';
import { OFFICE_LOOK } from './IndoorScene';
import { ISLAND_LOOK, LIGHTING, type SceneLook } from './Sky';

export { sunDiscCosines } from './Sky';
export { glintCut } from './Water';

/** Art noon column (the reference the relative numbers are measured against). */
const ART_NOON = { sun: 2.4, hemi: 1.0, fogNear: 60, fogFar: 260 } as const;

interface IslandArt {
  sunColor: number;
  sunIntensity: number;
  sunDir: [number, number, number];
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  skyTop: number;
  horizon: number;
  /** null = hidden (overcast). */
  sunDisc: number | null;
  sunDiscScale: number;
  fogNear: number;
  fogFar: number;
  clouds: NonNullable<SceneLook['clouds']>;
  sea: NonNullable<SceneLook['sea']>;
  flameScale: number;
  exposure: number;
}

const ISLAND_ART: Record<Exclude<IslandLookId, 'noon'>, IslandArt> = {
  morning: {
    sunColor: 0xffe6cc, sunIntensity: 2.0, sunDir: [0.72, 0.53, 0.45],
    hemiSky: 0xcde6ff, hemiGround: 0xebd9b0, hemiIntensity: 1.05,
    skyTop: 0x6fb8f2, horizon: 0xe4f2fa, sunDisc: 0xfff0d8, sunDiscScale: 1,
    fogNear: 50, fogFar: 240,
    clouds: { count: 10, lit: 0xffffff, mid: 0xf1f8ff, shade: 0xd9ecfa, height: 1, size: 1 },
    sea: { shallow: 0x5adcd5, deep: 0x2284c2, abyss: 0x14609a, glint: 0.8, glintColor: 0xffffff },
    flameScale: 1, exposure: 1,
  },
  golden: {
    sunColor: 0xffd2a1, sunIntensity: 2.0, sunDir: [-0.88, 0.36, 0.3],
    hemiSky: 0xb9c8f0, hemiGround: 0xe8c49a, hemiIntensity: 1.0,
    skyTop: 0x6f8fe0, horizon: 0xffd7b0, sunDisc: 0xffe1b0, sunDiscScale: 1.6,
    fogNear: 60, fogFar: 250,
    clouds: { count: 14, lit: 0xffe3cf, mid: 0xe8c6cc, shade: 0xc9a9c8, height: 1, size: 1 },
    sea: { shallow: 0x5fcfc0, deep: 0x2a74ae, abyss: 0x1e4f86, glint: 1.2, glintColor: 0xffe1b0 },
    flameScale: 1.3, exposure: 1,
  },
  overcast: {
    sunColor: 0xf0f2f5, sunIntensity: 1.1, sunDir: [-0.3, 0.86, 0.4],
    hemiSky: 0xdde5ee, hemiGround: 0xd9cdb4, hemiIntensity: 1.5,
    skyTop: 0xa9b7c6, horizon: 0xc9d3dc, sunDisc: null, sunDiscScale: 1,
    fogNear: 45, fogFar: 210,
    clouds: { count: 22, lit: 0xe4e8ee, mid: 0xced4dd, shade: 0xb8c0cc, height: 0.6, size: 1.35 },
    sea: { shallow: 0x6fc9c6, deep: 0x3a7da8, abyss: 0x2a5f85, glint: 0.25, glintColor: 0xffffff },
    flameScale: 1.15, exposure: 1.05,
  },
};

function islandLookFromArt(id: IslandLookId, a: IslandArt): SceneLook {
  return {
    id,
    sunDir: new THREE.Vector3(...a.sunDir).normalize(),
    sunColor: a.sunColor,
    sunIntensity: (a.sunIntensity / ART_NOON.sun) * LIGHTING.sun,
    hemiSky: a.hemiSky,
    hemiGround: a.hemiGround,
    hemiIntensity: (a.hemiIntensity / ART_NOON.hemi) * LIGHTING.hemi,
    fogColor: a.horizon,
    fogNear: (a.fogNear / ART_NOON.fogNear) * LIGHTING.fogNear,
    fogFar: (a.fogFar / ART_NOON.fogFar) * LIGHTING.fogFar,
    background: a.horizon,
    sky: { top: a.skyTop, horizon: a.horizon, sunDisc: a.sunDisc, sunDiscScale: a.sunDiscScale },
    clouds: a.clouds,
    sea: a.sea,
    flameScale: a.flameScale,
    exposure: a.exposure,
  };
}

const OFFICE_EVENING: SceneLook = {
  id: 'evening',
  sunDir: new THREE.Vector3(-0.85, 0.45, -0.25).normalize(),
  sunColor: 0xffc99a,
  sunIntensity: 1.35,
  hemiSky: 0xe6e0f0,
  hemiGround: 0xd9ae7a,
  hemiIntensity: 1.05,
  fogColor: 0x43393f,
  fogNear: 115,
  fogFar: 290,
  background: 0x43393f,
  shadowBias: OFFICE_LOOK.shadowBias,
  shadowNormalBias: OFFICE_LOOK.shadowNormalBias,
  office: { panelColor: 0xfff1dc, underDesk: 0.75, panelsDimmed: false, screensGlow: false, lampsOn: false, blinds: true },
};

const OFFICE_AFTER_HOURS: SceneLook = {
  id: 'afterHours',
  sunDir: new THREE.Vector3(0.2, 0.95, 0.25).normalize(),
  sunColor: 0xbfd2ff,
  sunIntensity: 0.6,
  hemiSky: 0x8e9bc0,
  hemiGround: 0x6e5a48,
  hemiIntensity: 0.9,
  fogColor: 0x1e2230,
  fogNear: 100,
  fogFar: 260,
  background: 0x1e2230,
  shadowBias: OFFICE_LOOK.shadowBias,
  shadowNormalBias: OFFICE_LOOK.shadowNormalBias,
  office: { panelColor: 0xf4fbff, underDesk: 0.85, panelsDimmed: true, screensGlow: true, lampsOn: true, blinds: false },
};

const ISLAND_LOOKS: Record<IslandLookId, SceneLook> = {
  noon: ISLAND_LOOK,
  morning: islandLookFromArt('morning', ISLAND_ART.morning),
  golden: islandLookFromArt('golden', ISLAND_ART.golden),
  overcast: islandLookFromArt('overcast', ISLAND_ART.overcast),
};
const OFFICE_LOOKS: Record<OfficeLookId, SceneLook> = {
  day: OFFICE_LOOK,
  evening: OFFICE_EVENING,
  afterHours: OFFICE_AFTER_HOURS,
};

const isIslandLook = (id: LookId): id is IslandLookId => id in ISLAND_LOOKS;
const isOfficeLook = (id: LookId): id is OfficeLookId => id in OFFICE_LOOKS;

/**
 * The SceneLook for a map kind and look id. An absent id, or one from the other map kind (a bad pin), gives the
 * baseline (`noon` / `day`). Pure; the returned objects are shared and must not be mutated.
 */
export function sceneLookFor(kind: MapKind, id?: LookId | null): SceneLook {
  if (kind === 'indoor') return id && isOfficeLook(id) ? OFFICE_LOOKS[id] : OFFICE_LOOK;
  return id && isIslandLook(id) ? ISLAND_LOOKS[id] : ISLAND_LOOK;
}
