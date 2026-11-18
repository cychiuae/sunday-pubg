import { describe, expect, it } from 'vitest';
import { readConfig } from './config';
import { ANY_ORIGIN, SAME_ORIGIN, describeOriginPolicy, isOriginAllowed, normalizeOrigin, parseOriginPolicy } from './origin';

describe('parseOriginPolicy', () => {
  it('defaults to same-origin in production and any origin in dev', () => {
    expect(parseOriginPolicy(undefined, true)).toEqual(SAME_ORIGIN);
    expect(parseOriginPolicy(' , ', true)).toEqual(SAME_ORIGIN);
    expect(parseOriginPolicy('', false)).toEqual(ANY_ORIGIN);
  });

  it('parses *, self and normalised origins', () => {
    expect(parseOriginPolicy('*', true).any).toBe(true);
    const p = parseOriginPolicy(' self , HTTPS://Play.Example.com:443/ , http://localhost:5180,https://play.example.com', true);
    expect(p).toEqual({ any: false, self: true, origins: ['https://play.example.com', 'http://localhost:5180'] });
    expect(describeOriginPolicy(p)).toBe('same-origin, https://play.example.com, http://localhost:5180');
  });

  it.each(['example.com', 'ftp://x.com', 'https://x.com/path', 'https://user@x.com', 'null', 'https://x.com?q=1'])(
    'fails fast on %j',
    (bad) => {
      expect(() => parseOriginPolicy(bad, true)).toThrow(/ALLOWED_ORIGINS/);
    },
  );

  it('is read from the environment by readConfig', () => {
    expect(readConfig({ NODE_ENV: 'production' }).originPolicy).toEqual(SAME_ORIGIN);
    expect(readConfig({}).originPolicy).toEqual(ANY_ORIGIN);
    expect(readConfig({ ALLOWED_ORIGINS: 'https://a.example' }).originPolicy.origins).toEqual(['https://a.example']);
    expect(() => readConfig({ ALLOWED_ORIGINS: 'nope' })).toThrow(/ALLOWED_ORIGINS/);
  });
});

describe('normalizeOrigin', () => {
  it('drops default ports and lowercases the host', () => {
    expect(normalizeOrigin('https://A.example:443')).toBe('https://a.example');
    expect(normalizeOrigin('http://a.example:80')).toBe('http://a.example');
    expect(normalizeOrigin('http://a.example:8080')).toBe('http://a.example:8080');
  });
});

describe('isOriginAllowed', () => {
  const list = parseOriginPolicy('https://play.example.com', true);

  it('any: accepts everything, including no Origin', () => {
    expect(isOriginAllowed(ANY_ORIGIN, {}, false)).toBe(true);
    expect(isOriginAllowed(ANY_ORIGIN, { origin: 'https://evil.example' }, false)).toBe(true);
  });

  it('list: exact origin match after normalisation; missing or "null" Origin is rejected', () => {
    expect(isOriginAllowed(list, { origin: 'https://play.example.com' }, false)).toBe(true);
    expect(isOriginAllowed(list, { origin: 'https://PLAY.example.com:443' }, false)).toBe(true);
    expect(isOriginAllowed(list, { origin: 'http://play.example.com' }, false)).toBe(false);
    expect(isOriginAllowed(list, { origin: 'https://play.example.com.evil.example' }, false)).toBe(false);
    expect(isOriginAllowed(list, {}, false)).toBe(false);
    expect(isOriginAllowed(list, { origin: 'null' }, false)).toBe(false);
  });

  it('self: Origin host must equal the Host header (default ports normalised)', () => {
    const ok = (origin: string, host: string) => isOriginAllowed(SAME_ORIGIN, { origin, host }, false);
    expect(ok('https://play.example.com', 'play.example.com')).toBe(true);
    expect(ok('https://play.example.com', 'play.example.com:443')).toBe(true);
    expect(ok('http://127.0.0.1:8797', '127.0.0.1:8797')).toBe(true);
    expect(ok('http://127.0.0.1:5173', '127.0.0.1:8797')).toBe(false);
    expect(ok('https://evil.example', 'play.example.com')).toBe(false);
    expect(ok('https://play.example.com', 'bad host/x')).toBe(false);
    expect(isOriginAllowed(SAME_ORIGIN, { host: 'play.example.com' }, false)).toBe(false);
  });

  it('self: X-Forwarded-Host counts only with TRUST_PROXY', () => {
    const h = { origin: 'https://play.example.com', host: 'game-backend:8797', 'x-forwarded-host': 'play.example.com' };
    expect(isOriginAllowed(SAME_ORIGIN, h, false)).toBe(false);
    expect(isOriginAllowed(SAME_ORIGIN, h, true)).toBe(true);
  });
});
