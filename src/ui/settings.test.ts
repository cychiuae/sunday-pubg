import { describe, expect, it } from 'vitest';
import { DEFAULT_QUALITY, DEFAULT_SETTINGS, QUALITY_LEVELS, SETTINGS_STORAGE_KEY } from '../shared/contracts';
import {
  DEFAULT_UI_PREFS,
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
    expect(UI_DEFAULT_SETTINGS).toEqual({ ...DEFAULT_SETTINGS, quality: DEFAULT_QUALITY });
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
    });
    expect(parseSettings('{"mouseSensitivity":0}').mouseSensitivity).toBe(SENSITIVITY_MIN);
    expect(parseSettings('{"masterVolume":0.25}').masterVolume).toBe(0.25);
  });

  it('round-trips through storage under the contract key', () => {
    const s = new MemStorage();
    const v = { mouseSensitivity: 1.5, masterVolume: 0.4, invertY: true, quality: 'high' as const };
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

describe('ui prefs', () => {
  it('parses and clamps', () => {
    expect(parseUiPrefs(null)).toEqual(DEFAULT_UI_PREFS);
    expect(parseUiPrefs('{"uiScale":9,"reducedMotion":"on"}')).toEqual({ uiScale: UI_SCALE_MAX, reducedMotion: 'on' });
    expect(parseUiPrefs('{"reducedMotion":"maybe"}').reducedMotion).toBe('system');
  });
});

describe('hint set', () => {
  it('keeps only strings', () => {
    expect([...parseHintSet('["hint.loot", 3, null, "hint.heal"]')]).toEqual(['hint.loot', 'hint.heal']);
    expect(parseHintSet('oops').size).toBe(0);
  });
});
