import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LcovFileCoverage, mergeLcovCoverage, parseLcov } from '../src/lcov-parser';
import { calculateDiffCoverage, nonCodeLineNumbers } from '../src/calculator';
import { FileDiff } from '../src/git-diff';
import { findRepoRoot } from '../src/path-utils';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-cover-js-branch-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeLcov (name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content);
  return file;
}

function diffFor (filePath: string, lines: number[]): FileDiff {
  return { filePath, addedLines: new Set(lines), isNew: false };
}

describe('parseLcov branch records', () => {
  it('reads BRDA taken counts and treats "-" as an untaken branch with no data', () => {
    const file = writeLcov('brda.info', [
      'SF:src/a.ts',
      'DA:5,3',
      'BRDA:5,0,0,2',
      'BRDA:5,0,1,0',
      'BRDA:6,0,0,-',
      'end_of_record',
    ].join('\n'));

    const coverage = parseLcov(file).get('src/a.ts')!;

    expect(coverage.branches!.get(5)).toEqual(new Map([['0:0', 2], ['0:1', 0]]));
    expect(coverage.branches!.get(6)).toEqual(new Map([['0:0', null]]));
  });

  it('sums branch taken counts when the same file appears in several SF blocks', () => {
    const file = writeLcov('brda-dup.info', [
      'SF:src/a.ts',
      'BRDA:5,0,0,1',
      'BRDA:5,0,1,0',
      'end_of_record',
      'SF:src/a.ts',
      'BRDA:5,0,0,0',
      'BRDA:5,0,1,4',
      'end_of_record',
    ].join('\n'));

    const coverage = parseLcov(file).get('src/a.ts')!;

    expect(coverage.branches!.get(5)).toEqual(new Map([['0:0', 1], ['0:1', 4]]));
  });

  it('skips a BRDA record with a malformed taken count', () => {
    const file = writeLcov('brda-bad.info', [
      'SF:src/a.ts',
      'BRDA:5,0,0,abc',
      'BRDA:5,0,1,1',
      'end_of_record',
      'SF:src/a.ts',
      'BRDA:5,0,0,2',
      'end_of_record',
    ].join('\n'));

    const coverage = parseLcov(file).get('src/a.ts')!;

    expect(coverage.branches!.get(5)).toEqual(new Map([['0:1', 1], ['0:0', 2]]));
  });

  it('keeps "-" from overriding a real taken count when records are merged', () => {
    const into: LcovFileCoverage = { filePath: 'src/a.ts', lines: new Map(), branches: new Map([[5, new Map([['0:0', null]])]]) };
    const from: LcovFileCoverage = { filePath: 'src/a.ts', lines: new Map(), branches: new Map([[5, new Map([['0:0', 3]])]]) };

    mergeLcovCoverage(into, from);

    expect(into.branches!.get(5)!.get('0:0')).toBe(3);
  });
});

describe('calculateDiffCoverage branch coverage', () => {
  it('counts taken branches on added lines and lists partially covered lines', () => {
    const lcov = new Map<string, LcovFileCoverage>([
      ['src/a.ts', {
        filePath: 'src/a.ts',
        lines: new Map([[10, 1], [11, 1]]),
        branches: new Map([
          [10, new Map([['0:0', 4], ['0:1', 0]])], // one of two paths taken
          [11, new Map([['0:0', 2], ['0:1', 1]])], // both taken
        ]),
      }],
    ]);

    const result = calculateDiffCoverage([diffFor('src/a.ts', [10, 11])], lcov);
    const file = result.files[0];

    expect(file.coverableBranches).toBe(4);
    expect(file.coveredBranches).toBe(3);
    expect(file.branchPercent).toBe(75);
    expect(file.partialBranchLines).toEqual([10]);
    expect(result.totalBranches).toBe(4);
    expect(result.totalCoveredBranches).toBe(3);
    expect(result.overallBranchPercent).toBe(75);
  });

  it('ignores branches on lines that were not changed', () => {
    const lcov = new Map<string, LcovFileCoverage>([
      ['src/a.ts', {
        filePath: 'src/a.ts',
        lines: new Map([[10, 1]]),
        branches: new Map([[10, new Map([['0:0', 1], ['0:1', 0]])], [20, new Map([['0:0', 0]])]]),
      }],
    ]);

    const result = calculateDiffCoverage([diffFor('src/a.ts', [10])], lcov);

    expect(result.files[0].coverableBranches).toBe(2);
    expect(result.files[0].partialBranchLines).toEqual([10]);
  });

  it('reports null branch percentages when changed lines have no branches', () => {
    const lcov = new Map<string, LcovFileCoverage>([
      ['src/a.ts', { filePath: 'src/a.ts', lines: new Map([[1, 1]]) }],
    ]);

    const result = calculateDiffCoverage([diffFor('src/a.ts', [1])], lcov);

    expect(result.files[0].branchPercent).toBeNull();
    expect(result.overallBranchPercent).toBeNull();
    expect(result.files[0].coveragePercent).toBe(100);
  });

  it('does not change line coverage', () => {
    const lcov = new Map<string, LcovFileCoverage>([
      ['src/a.ts', {
        filePath: 'src/a.ts',
        lines: new Map([[10, 1], [11, 0]]),
        branches: new Map([[10, new Map([['0:0', 0], ['0:1', 0]])]]),
      }],
    ]);

    const result = calculateDiffCoverage([diffFor('src/a.ts', [10, 11])], lcov);

    expect(result.files[0].coveragePercent).toBe(50);
    expect(result.files[0].uncoveredLineNumbers).toEqual([11]);
  });

  it('does not mutate the caller\'s branch data when normalized paths are merged', () => {
    const original = new Map([[10, new Map([['0:0', 1], ['0:1', 0]])]]);
    const absPath = path.join(findRepoRoot(), 'src/a.ts');
    const lcov = new Map<string, LcovFileCoverage>([
      [absPath, { filePath: absPath, lines: new Map([[10, 1]]), branches: original }],
      ['src/a.ts', { filePath: 'src/a.ts', lines: new Map([[10, 1]]), branches: new Map([[10, new Map([['0:1', 5]])]]) }],
    ]);

    const result = calculateDiffCoverage([diffFor('src/a.ts', [10])], lcov);

    expect(result.files[0].coveredBranches).toBe(2);
    expect(original.get(10)!.get('0:1')).toBe(0);
  });
});

describe('strict mode for files missing from lcov', () => {
  const source = [
    "import { x } from './x';",   // 1 code
    '',                           // 2 blank
    '// a comment',               // 3 comment
    '/**',                        // 4 block comment start
    ' * JSDoc text',              // 5 inside block
    ' */',                        // 6 block comment end
    'export const y = x + 1;',    // 7 code
  ].join('\n');

  it('counts only code lines as coverable and uncovered', () => {
    const lcov = new Map<string, LcovFileCoverage>();
    const result = calculateDiffCoverage(
      [diffFor('src/new.ts', [1, 2, 3, 4, 5, 6, 7])],
      lcov,
      { strict: true, readSource: () => source },
    );

    const file = result.files[0];
    expect(file.inLcov).toBe(false);
    expect(file.coverableAddedLines).toBe(2);
    expect(file.uncoveredLineNumbers).toEqual([1, 7]);
    expect(file.coveragePercent).toBe(0);
    expect(result.totalCoverable).toBe(2);
    expect(result.totalCovered).toBe(0);
    expect(result.totalAdded).toBe(7);
  });

  it('treats a file where only blank and comment lines changed as having nothing to cover', () => {
    const result = calculateDiffCoverage(
      [diffFor('src/new.ts', [2, 3, 4, 5, 6])],
      new Map(),
      { strict: true, readSource: () => source },
    );

    const file = result.files[0];
    expect(file.inLcov).toBe(false);
    expect(file.coverableAddedLines).toBe(0);
    expect(file.uncoveredLineNumbers).toEqual([]);
    expect(file.coveragePercent).toBe(100);
    expect(result.missingFromLcov).toEqual(['src/new.ts']);
    expect(result.totalAdded).toBe(5);
    expect(result.totalCoverable).toBe(0);
    expect(result.overallPercent).toBe(100);
  });

  it('falls back to counting every added line when the source cannot be read', () => {
    const result = calculateDiffCoverage(
      [diffFor('src/new.ts', [2, 3])],
      new Map(),
      { strict: true, readSource: () => null },
    );

    expect(result.files[0].coverableAddedLines).toBe(2);
  });

  it('does not list missing files unless strict is on', () => {
    const result = calculateDiffCoverage([diffFor('src/new.ts', [1])], new Map(), { readSource: () => source });

    expect(result.files).toHaveLength(0);
    expect(result.missingFromLcov).toEqual(['src/new.ts']);
  });
});

describe('nonCodeLineNumbers', () => {
  it('marks blank, line-comment and block-comment lines, including multi-line blocks', () => {
    const source = ['code();', '', '// note', '/* one line */', '/*', ' * a', ' */', 'more();'].join('\n');

    expect([...nonCodeLineNumbers(source)].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
  });
});
