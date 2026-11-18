/**
 * C1: the simulation stays pure (ARCHITECTURE §3, CLAUDE.md "Simulation never imports rendering, DOM, or audio code").
 * Every runtime file in src/shared/sim (tests, test kits and the offline tools/ folder excluded) may import only
 * src/shared/**, and must not touch three, DOM, audio, wall clocks or Math.random. The sim's import closure is
 * followed from World.ts so an indirect import through another folder is caught too.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const SIM = join(ROOT, 'src/shared/sim');
const SHARED = join(ROOT, 'src/shared');

const isRuntime = (f: string): boolean =>
  f.endsWith('.ts') && !f.endsWith('.test.ts') && !/testkit|testFixtures|testing\.ts$/.test(f) && !f.includes(`${SIM}/tools`);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Code with comments and string contents blanked (keeps import specifiers, which are read separately). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(cand) && statSync(cand).isFile()) return cand;
  return base; // .json etc.
}

const FORBIDDEN_TOKENS: [RegExp, string][] = [
  [/\bdocument\./, 'DOM document'],
  [/\bwindow\./, 'DOM window'],
  [/\bnavigator\./, 'navigator'],
  [/\blocalStorage\b/, 'localStorage'],
  [/\brequestAnimationFrame\b/, 'requestAnimationFrame'],
  [/\b(Offline)?AudioContext\b/, 'Web Audio'],
  [/\bMath\.random\s*\(/, 'Math.random (use the seeded Rng)'],
  [/\bDate\.now\s*\(/, 'Date.now (use world time)'],
  [/\bperformance\.now\s*\(/, 'performance.now (use world time)'],
];

describe('sim purity (C1)', () => {
  const files = walk(SIM).filter(isRuntime);

  it('finds the sim runtime files', () => {
    expect(files.map((f) => relative(SIM, f))).toEqual(expect.arrayContaining(['World.ts', 'movement.ts', 'combat.ts', 'zone.ts']));
  });

  it('no sim runtime file uses DOM, audio, wall clocks or Math.random', () => {
    const hits: string[] = [];
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const [re, what] of FORBIDDEN_TOKENS) if (re.test(code)) hits.push(`${relative(ROOT, f)}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  it('the import closure of the sim stays inside src/shared (no three, render, ui, audio, net, game, server, node built-ins)', () => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const queue = [...files];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const spec of importsOf(f)) {
        const target = resolveImport(f, spec);
        if (target === null) {
          bad.push(`${relative(ROOT, f)} imports package "${spec}"`);
          continue;
        }
        const allowed = target.startsWith(SHARED + '/') || target === join(ROOT, 'docs/design/balance.json');
        if (!allowed) bad.push(`${relative(ROOT, f)} imports ${relative(ROOT, target)}`);
        else if (target.endsWith('.ts') && existsSync(target)) queue.push(target);
      }
    }
    expect(bad).toEqual([]);
  });

  it('M2b: the sim import closure never reaches src/shared/kits (map kit data is passed in through MapData.kit)', () => {
    const KITS = join(SHARED, 'kits');
    const seen = new Set<string>();
    const bad: string[] = [];
    const queue = [...files];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const spec of importsOf(f)) {
        const target = resolveImport(f, spec);
        if (target === null) continue;
        if (target === KITS || target.startsWith(KITS + '/')) bad.push(`${relative(ROOT, f)} imports ${relative(ROOT, target)}`);
        else if (target.endsWith('.ts') && existsSync(target)) queue.push(target);
      }
    }
    expect(seen.size).toBeGreaterThan(files.length - 1);
    expect(bad).toEqual([]);
  });

  it('no sim runtime file imports the offline tools/ folder', () => {
    const bad = files.filter((f) => importsOf(f).some((s) => s.includes('tools/')));
    expect(bad.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
