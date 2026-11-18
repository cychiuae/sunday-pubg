import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADS_MODE,
  DEFAULT_ADS_SENSITIVITY,
  DEFAULT_FP_FOV_DEG,
  DEFAULT_QUALITY,
  DEFAULT_SETTINGS,
  FP_FOV_MAX_DEG,
  FP_FOV_MIN_DEG,
  QUALITY_LEVELS,
  SETTINGS_STORAGE_KEY,
} from '../shared/contracts';
import {
  ADS_SENSITIVITY_MAX,
  ADS_SENSITIVITY_MIN,
  DEFAULT_UI_PREFS,
  effectiveHeadBob,
  effectiveSettings,
  headBobChoiceFor,
  isReducedMotion,
  loadSettings,
  parseHintSet,
  parseSettings,
  parseUiPrefs,
  saveSettings,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  settingsEqual,
  UI_DEFAULT_SETTINGS,
  UI_SCALE_MAX,
} from './settings';

class MemStorage {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

describe('settings', () => {
  it('falls back to defaults on missing or corrupt data', () => {
    expect(UI_DEFAULT_SETTINGS).toEqual({
      ...DEFAULT_SETTINGS,
      quality: DEFAULT_QUALITY,
      adsMode: DEFAULT_ADS_MODE,
      adsSensitivity: DEFAULT_ADS_SENSITIVITY,
      fovDeg: DEFAULT_FP_FOV_DEG,
      headBob: true,
      reducedMotion: false,
    });
    expect(parseSettings(null)).toEqual(UI_DEFAULT_SETTINGS);
    expect(parseSettings('{not json')).toEqual(UI_DEFAULT_SETTINGS);
    expect(parseSettings('[1,2]')).toEqual(UI_DEFAULT_SETTINGS);
    expect(parseSettings('{"mouseSensitivity":"fast"}')).toEqual(UI_DEFAULT_SETTINGS);
  });

  it('clamps ranges and keeps valid values', () => {
    expect(parseSettings('{"mouseSensitivity":99,"masterVolume":-1,"invertY":true}')).toEqual({
      mouseSensitivity: SENSITIVITY_MAX,
      masterVolume: 0,
      invertY: true,
      quality: DEFAULT_QUALITY,
      adsMode: DEFAULT_ADS_MODE,
      adsSensitivity: DEFAULT_ADS_SENSITIVITY,
      fovDeg: DEFAULT_FP_FOV_DEG,
      headBob: true,
      reducedMotion: false,
    });
    expect(parseSettings('{"mouseSensitivity":0}').mouseSensitivity).toBe(SENSITIVITY_MIN);
    expect(parseSettings('{"masterVolume":0.25}').masterVolume).toBe(0.25);
  });

  it('round-trips through storage under the contract key', () => {
    const s = new MemStorage();
    const v = {
      mouseSensitivity: 1.5,
      masterVolume: 0.4,
      invertY: true,
      quality: 'high' as const,
      adsMode: 'toggle' as const,
      adsSensitivity: 0.6,
      fovDeg: 92,
      headBob: false,
      reducedMotion: true,
    };
    saveSettings(s, v);
    expect(s.data.has(SETTINGS_STORAGE_KEY)).toBe(true);
    expect(loadSettings(s)).toEqual(v);
    expect(settingsEqual(loadSettings(s), v)).toBe(true);
  });

  it('survives a throwing storage', () => {
    const bad = {
      getItem: (): string | null => {
        throw new Error('denied');
      },
      setItem: (): void => {
        throw new Error('quota');
      },
    };
    expect(loadSettings(bad)).toEqual(UI_DEFAULT_SETTINGS);
    expect(() => saveSettings(bad, DEFAULT_SETTINGS)).not.toThrow();
    expect(loadSettings(null)).toEqual(UI_DEFAULT_SETTINGS);
  });

  it('persists the graphics quality preset and rejects unknown values', () => {
    for (const q of QUALITY_LEVELS) expect(parseSettings(JSON.stringify({ quality: q })).quality).toBe(q);
    expect(parseSettings('{"quality":"ultra"}').quality).toBe(DEFAULT_QUALITY);
    expect(parseSettings('{"quality":2}').quality).toBe(DEFAULT_QUALITY);
    // Settings saved before M1-fix (no quality) load as the default preset.
    expect(parseSettings('{"mouseSensitivity":1,"masterVolume":0.8,"invertY":false}').quality).toBe(DEFAULT_QUALITY);
  });

  it('compares quality, treating a missing preset as the default', () => {
    expect(settingsEqual(UI_DEFAULT_SETTINGS, { ...UI_DEFAULT_SETTINGS, quality: 'low' })).toBe(false);
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, quality: DEFAULT_QUALITY })).toBe(true);
  });
});

describe('settings: M2a aim mode and ADS sensitivity', () => {
  it('migrates pre-M2a settings to Hold and 1.00', () => {
    const old = parseSettings('{"mouseSensitivity":1.2,"masterVolume":0.5,"invertY":false,"quality":"low"}');
    expect(old.adsMode).toBe('hold');
    expect(old.adsSensitivity).toBe(1);
    expect(old.mouseSensitivity).toBe(1.2);
    expect(old.quality).toBe('low');
  });

  it('keeps valid values, rejects unknown modes, clamps the multiplier', () => {
    expect(parseSettings('{"adsMode":"toggle"}').adsMode).toBe('toggle');
    expect(parseSettings('{"adsMode":"press"}').adsMode).toBe(DEFAULT_ADS_MODE);
    expect(parseSettings('{"adsMode":1}').adsMode).toBe(DEFAULT_ADS_MODE);
    expect(parseSettings('{"adsSensitivity":0.75}').adsSensitivity).toBe(0.75);
    expect(parseSettings('{"adsSensitivity":50}').adsSensitivity).toBe(ADS_SENSITIVITY_MAX);
    expect(parseSettings('{"adsSensitivity":0}').adsSensitivity).toBe(ADS_SENSITIVITY_MIN);
    expect(parseSettings('{"adsSensitivity":"high"}').adsSensitivity).toBe(DEFAULT_ADS_SENSITIVITY);
  });

  it('compares both fields, treating missing values as the defaults', () => {
    expect(settingsEqual(UI_DEFAULT_SETTINGS, { ...UI_DEFAULT_SETTINGS, adsMode: 'toggle' })).toBe(false);
    expect(settingsEqual(UI_DEFAULT_SETTINGS, { ...UI_DEFAULT_SETTINGS, adsSensitivity: 1.5 })).toBe(false);
    expect(settingsEqual(DEFAULT_SETTINGS, UI_DEFAULT_SETTINGS)).toBe(true);
  });
});

describe('ui prefs', () => {
  it('parses and clamps', () => {
    expect(parseUiPrefs(null)).toEqual(DEFAULT_UI_PREFS);
    expect(parseUiPrefs('{"uiScale":9,"reducedMotion":"on"}')).toEqual({ uiScale: UI_SCALE_MAX, reducedMotion: 'on', headBob: 'auto' });
    expect(parseUiPrefs('{"reducedMotion":"maybe"}').reducedMotion).toBe('system');
    expect(parseUiPrefs('{"headBob":"off"}').headBob).toBe('off');
    expect(parseUiPrefs('{"headBob":true}').headBob).toBe('auto');
  });
});

describe('settings: M2b first person (FOV, head bob, reduced motion)', () => {
  it('migrates older saves to the default FOV and clamps / rounds the slider value', () => {
    expect(parseSettings('{"mouseSensitivity":1}').fovDeg).toBe(DEFAULT_FP_FOV_DEG);
    expect(parseSettings('{"fovDeg":200}').fovDeg).toBe(FP_FOV_MAX_DEG);
    expect(parseSettings('{"fovDeg":10}').fovDeg).toBe(FP_FOV_MIN_DEG);
    expect(parseSettings('{"fovDeg":87.6}').fovDeg).toBe(88);
    expect(parseSettings('{"fovDeg":"wide"}').fovDeg).toBe(DEFAULT_FP_FOV_DEG);
    expect(settingsEqual(UI_DEFAULT_SETTINGS, { ...UI_DEFAULT_SETTINGS, fovDeg: 90 })).toBe(false);
    expect(settingsEqual(UI_DEFAULT_SETTINGS, { ...UI_DEFAULT_SETTINGS, headBob: false })).toBe(false);
    expect(settingsEqual(UI_DEFAULT_SETTINGS, { ...UI_DEFAULT_SETTINGS, reducedMotion: true })).toBe(false);
    expect(settingsEqual(DEFAULT_SETTINGS, UI_DEFAULT_SETTINGS)).toBe(true);
  });

  it('resolves reduced motion from the pref and the OS', () => {
    expect(isReducedMotion('system', true)).toBe(true);
    expect(isReducedMotion('system', false)).toBe(false);
    expect(isReducedMotion('on', false)).toBe(true);
    expect(isReducedMotion('off', true)).toBe(false);
  });

  it('head bob: auto follows reduced motion, an explicit choice wins', () => {
    expect(effectiveHeadBob('auto', false)).toBe(true);
    expect(effectiveHeadBob('auto', true)).toBe(false);
    expect(effectiveHeadBob('on', true)).toBe(true);
    expect(effectiveHeadBob('off', false)).toBe(false);
  });

  it('head bob checkbox stores auto when it matches what auto shows', () => {
    expect(headBobChoiceFor(true, false)).toBe('auto');
    expect(headBobChoiceFor(false, false)).toBe('off');
    expect(headBobChoiceFor(true, true)).toBe('on');
    expect(headBobChoiceFor(false, true)).toBe('auto');
  });

  it('effectiveSettings fills the two effective flags and keeps the rest', () => {
    const stored = { ...UI_DEFAULT_SETTINGS, fovDeg: 95 };
    expect(effectiveSettings(stored, DEFAULT_UI_PREFS, true)).toEqual({ ...stored, headBob: false, reducedMotion: true });
    expect(effectiveSettings(stored, { ...DEFAULT_UI_PREFS, headBob: 'on' }, true)).toMatchObject({ headBob: true, reducedMotion: true });
    expect(effectiveSettings(stored, { ...DEFAULT_UI_PREFS, reducedMotion: 'off' }, true)).toMatchObject({ headBob: true, reducedMotion: false });
  });
});

describe('hint set', () => {
  it('keeps only strings', () => {
    expect([...parseHintSet('["hint.loot", 3, null, "hint.heal"]')]).toEqual(['hint.loot', 'hint.heal']);
    expect(parseHintSet('oops').size).toBe(0);
  });
});
