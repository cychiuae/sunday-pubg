import { describe, expect, it } from 'vitest';
import balanceJson from '../../docs/design/balance.json';
import { validateBalance } from './balance';

const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(balanceJson)) as Record<string, unknown>;

describe('validateBalance', () => {
  it('accepts the shipped balance.json', () => {
    expect(() => validateBalance(clone())).not.toThrow();
  });

  it('lists every missing required key', () => {
    const raw = clone();
    delete (raw['player'] as Record<string, unknown>)['maxHp'];
    delete (raw['net'] as Record<string, unknown>)['simHz'];
    expect(() => validateBalance(raw)).toThrow(/player\.maxHp[\s\S]*net\.simHz/);
  });

  // Contract revision 1: optional sections.
  it('accepts absent or partial optional sections', () => {
    const raw = clone();
    delete raw['clientFeel'];
    expect(() => validateBalance(raw)).not.toThrow();
    raw['clientFeel'] = { cameraFovDeg: 75 };
    (raw['bots'] as Record<string, unknown>)['ai'] = { detourMs: 900 };
    ((raw['items'] as Record<string, Record<string, unknown>>)['medkit'])['preferAtOrBelowHp'] = 50;
    expect(validateBalance(raw).clientFeel?.cameraFovDeg).toBe(75);
  });

  it('rejects mistyped optional keys', () => {
    const raw = clone();
    raw['clientFeel'] = { cameraFovDeg: '75' };
    (raw['bots'] as Record<string, unknown>)['ai'] = 3;
    ((raw['items'] as Record<string, Record<string, unknown>>)['medkit'])['preferAtOrBelowHp'] = Number.NaN;
    expect(() => validateBalance(raw)).toThrow(/clientFeel\.cameraFovDeg[\s\S]*bots\.ai[\s\S]*items\.medkit\.preferAtOrBelowHp/);
  });

  // Revision 1b: bot pacing keys, personalities, loot scores, player.lowHpThreshold.
  it('accepts absent or partial revision 1b keys and types them', () => {
    const raw = clone();
    const bots = raw['bots'] as Record<string, unknown>;
    for (const k of ['lootPhaseSeconds', 'avoidRange', 'personalities']) delete bots[k];
    delete (raw['player'] as Record<string, unknown>)['lowHpThreshold'];
    expect(() => validateBalance(raw)).not.toThrow();
    bots['lootPhaseSeconds'] = 60;
    bots['personalities'] = { cautious: { retreatBelowHp: 33 }, _note: 'comment keys are allowed' };
    bots['ai'] = { lootScoreVest: 12 };
    (raw['player'] as Record<string, unknown>)['lowHpThreshold'] = 25;
    const b = validateBalance(raw);
    expect(b.bots.lootPhaseSeconds).toBe(60);
    expect(b.bots.personalities?.cautious?.retreatBelowHp).toBe(33);
    expect(b.bots.ai?.lootScoreVest).toBe(12);
    expect(b.player.lowHpThreshold).toBe(25);
  });

  it('rejects mistyped revision 1b keys and unknown personalities', () => {
    const raw = clone();
    const bots = raw['bots'] as Record<string, unknown>;
    bots['retaliateMs'] = '4000';
    bots['personalities'] = { agressive: { share: 0.3 }, balanced: { share: null } };
    bots['ai'] = { lootDistanceFalloff: Number.POSITIVE_INFINITY };
    (raw['player'] as Record<string, unknown>)['lowHpThreshold'] = '30';
    expect(() => validateBalance(raw)).toThrow(
      /bots\.ai\.lootDistanceFalloff[\s\S]*bots\.retaliateMs[\s\S]*bots\.personalities\.agressive[\s\S]*bots\.personalities\.balanced\.share[\s\S]*player\.lowHpThreshold/,
    );
    bots['personalities'] = 5;
    expect(() => validateBalance(raw)).toThrow(/bots\.personalities must be an object/);
  });
});
