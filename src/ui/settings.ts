/**
 * Settings + UI-preference persistence. Pure parsing (tested) plus thin, exception-safe storage wrappers.
 * Owner: ui-ux-designer.
 *
 * - `Settings` (contracts.ts) is shared with ClientGame/Audio and stored under SETTINGS_STORAGE_KEY.
 * - `UiPrefs` are presentation-only (UI scale, reduced motion, the head-bob choice) and never leave src/ui.
 * - M2b: `Settings.headBob` and `Settings.reducedMotion` are the EFFECTIVE values (the Ui resolves its prefs and the OS
 *   `prefers-reduced-motion` into them; see effectiveSettings). `Settings.fovDeg` is a plain stored setting.
 */
import {
  ADS_MODES,
  DEFAULT_ADS_MODE,
  DEFAULT_ADS_SENSITIVITY,
  DEFAULT_FP_FOV_DEG,
  DEFAULT_QUALITY,
  DEFAULT_SETTINGS,
  FP_FOV_MAX_DEG,
  FP_FOV_MIN_DEG,
  QUALITY_LEVELS,
  SETTINGS_STORAGE_KEY,
  type AdsMode,
  type QualityLevel,
  type Settings,
} from '../shared/contracts';
import { clamp } from '../shared/math';

export const SENSITIVITY_MIN = 0.1;
export const SENSITIVITY_MAX = 3;
export const SENSITIVITY_STEP = 0.05;

export const UI_PREFS_STORAGE_KEY = 'bsp.uiprefs.v1';
export const NAME_STORAGE_KEY = 'bsp.name.v1';
export const HINTS_STORAGE_KEY = 'bsp.hints.v1';

export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_STEP = 0.05;

export type ReducedMotionPref = 'system' | 'on' | 'off';
/** M2b (UI.md §13.4): 'auto' = on, except off while reduced motion is in effect. */
export type HeadBobChoice = 'auto' | 'on' | 'off';

export interface UiPrefs {
  uiScale: number;
  reducedMotion: ReducedMotionPref;
  /** M2b. Saves without it load as 'auto'. */
  headBob: HeadBobChoice;
}

/** M2b: FOV slider step (degrees). */
export const FOV_STEP = 1;

/**
 * What a fresh install gets. Same as the contract DEFAULT_SETTINGS plus the M1-fix graphics preset, which the UI always
 * persists explicitly (contracts.ts keeps `quality` optional and out of DEFAULT_SETTINGS).
 */
export const UI_DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  quality: DEFAULT_QUALITY,
  adsMode: DEFAULT_ADS_MODE,
  adsSensitivity: DEFAULT_ADS_SENSITIVITY,
  fovDeg: DEFAULT_FP_FOV_DEG,
  headBob: true,
  reducedMotion: false,
};

/** M2a: ADS sensitivity multiplier range (Settings.adsSensitivity JSDoc: 0.1..3). */
export const ADS_SENSITIVITY_MIN = 0.1;
export const ADS_SENSITIVITY_MAX = 3;
export const ADS_SENSITIVITY_STEP = 0.05;

export function isAdsMode(v: unknown): v is AdsMode {
  return typeof v === 'string' && (ADS_MODES as readonly string[]).includes(v);
}

export function isQualityLevel(v: unknown): v is QualityLevel {
  return typeof v === 'string' && (QUALITY_LEVELS as readonly string[]).includes(v);
}

export const DEFAULT_UI_PREFS: UiPrefs = { uiScale: 1, reducedMotion: 'system', headBob: 'auto' };

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Clamps every field into range; unknown / missing fields fall back to defaults. */
export function normalizeSettings(v: unknown): Settings {
  const o = isObj(v) ? v : {};
  return {
    mouseSensitivity: clamp(num(o['mouseSensitivity'], DEFAULT_SETTINGS.mouseSensitivity), SENSITIVITY_MIN, SENSITIVITY_MAX),
    masterVolume: clamp(num(o['masterVolume'], DEFAULT_SETTINGS.masterVolume), 0, 1),
    invertY: typeof o['invertY'] === 'boolean' ? o['invertY'] : DEFAULT_SETTINGS.invertY,
    quality: isQualityLevel(o['quality']) ? o['quality'] : DEFAULT_QUALITY,
    // M2a: settings saved before M2a have neither field and load with the defaults (Hold, 1.00).
    adsMode: isAdsMode(o['adsMode']) ? o['adsMode'] : DEFAULT_ADS_MODE,
    adsSensitivity: clamp(num(o['adsSensitivity'], DEFAULT_ADS_SENSITIVITY), ADS_SENSITIVITY_MIN, ADS_SENSITIVITY_MAX),
    // M2b: saves without the fields load as the default FOV, head bob on and no reduced motion (the Ui then
    // overwrites the two effective flags from its prefs, see effectiveSettings).
    fovDeg: Math.round(clamp(num(o['fovDeg'], DEFAULT_FP_FOV_DEG), FP_FOV_MIN_DEG, FP_FOV_MAX_DEG)),
    headBob: typeof o['headBob'] === 'boolean' ? o['headBob'] : true,
    reducedMotion: typeof o['reducedMotion'] === 'boolean' ? o['reducedMotion'] : false,
  };
}

/** M2b: is reduced motion in effect for this pref and the OS setting? */
export function isReducedMotion(pref: ReducedMotionPref, systemReduced: boolean): boolean {
  return pref === 'on' || (pref === 'system' && systemReduced);
}

/** M2b (UI.md §13.4): the head bob ClientGame gets. */
export function effectiveHeadBob(choice: HeadBobChoice, reducedMotion: boolean): boolean {
  return choice === 'on' || (choice === 'auto' && !reducedMotion);
}

/**
 * M2b: the choice to store when the user sets the head-bob checkbox to `checked`. Setting it to what 'auto' would show
 * stores 'auto', so the checkbox never pins a value the user did not deviate from (and two clicks restore 'auto').
 */
export function headBobChoiceFor(checked: boolean, reducedMotion: boolean): HeadBobChoice {
  if (checked === effectiveHeadBob('auto', reducedMotion)) return 'auto';
  return checked ? 'on' : 'off';
}

/** M2b: stored settings plus the effective head bob and reduced motion resolved from the prefs. */
export function effectiveSettings(stored: Settings, prefs: UiPrefs, systemReduced: boolean): Settings {
  const reduced = isReducedMotion(prefs.reducedMotion, systemReduced);
  return { ...stored, headBob: effectiveHeadBob(prefs.headBob, reduced), reducedMotion: reduced };
}

export function parseSettings(raw: string | null): Settings {
  return normalizeSettings(parseJson(raw));
}

export function normalizeUiPrefs(v: unknown): UiPrefs {
  const o = isObj(v) ? v : {};
  const rm = o['reducedMotion'];
  return {
    uiScale: clamp(num(o['uiScale'], DEFAULT_UI_PREFS.uiScale), UI_SCALE_MIN, UI_SCALE_MAX),
    reducedMotion: rm === 'on' || rm === 'off' || rm === 'system' ? rm : DEFAULT_UI_PREFS.reducedMotion,
    headBob: o['headBob'] === 'on' || o['headBob'] === 'off' || o['headBob'] === 'auto' ? o['headBob'] : DEFAULT_UI_PREFS.headBob,
  };
}

export function parseUiPrefs(raw: string | null): UiPrefs {
  return normalizeUiPrefs(parseJson(raw));
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  return (
    a.mouseSensitivity === b.mouseSensitivity &&
    a.masterVolume === b.masterVolume &&
    a.invertY === b.invertY &&
    (a.quality ?? DEFAULT_QUALITY) === (b.quality ?? DEFAULT_QUALITY) &&
    (a.adsMode ?? DEFAULT_ADS_MODE) === (b.adsMode ?? DEFAULT_ADS_MODE) &&
    (a.adsSensitivity ?? DEFAULT_ADS_SENSITIVITY) === (b.adsSensitivity ?? DEFAULT_ADS_SENSITIVITY) &&
    (a.fovDeg ?? DEFAULT_FP_FOV_DEG) === (b.fovDeg ?? DEFAULT_FP_FOV_DEG) &&
    (a.headBob ?? true) === (b.headBob ?? true) &&
    (a.reducedMotion ?? false) === (b.reducedMotion ?? false)
  );
}

/** Hints already shown (persisted so a returning player is not re-taught). */
export function parseHintSet(raw: string | null): Set<string> {
  const v = parseJson(raw);
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
}

// ---------------------------------------------------------------------------------------------
// Storage wrappers (localStorage may throw in private mode or be missing in tests)
// ---------------------------------------------------------------------------------------------
export function getStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function readItem(storage: StorageLike | null, key: string): string | null {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

export function writeItem(storage: StorageLike | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Quota / private mode: settings still apply for this session.
  }
}

export const loadSettings = (s: StorageLike | null): Settings => parseSettings(readItem(s, SETTINGS_STORAGE_KEY));
export const saveSettings = (s: StorageLike | null, v: Settings): void => writeItem(s, SETTINGS_STORAGE_KEY, JSON.stringify(v));
export const loadUiPrefs = (s: StorageLike | null): UiPrefs => parseUiPrefs(readItem(s, UI_PREFS_STORAGE_KEY));
export const saveUiPrefs = (s: StorageLike | null, v: UiPrefs): void => writeItem(s, UI_PREFS_STORAGE_KEY, JSON.stringify(v));
