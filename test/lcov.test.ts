import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeLcovCoverage, parseLcov, LcovFileCoverage } from '../src/lcov-parser';
import { calculateDiffCoverage } from '../src/calculator';
import { FileDiff } from '../src/git-diff';
import { findRepoRoot } from '../src/path-utils';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-cover-js-lcov-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeLcov (name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content);
  return file;
}

function linesOf (coverage: LcovFileCoverage | undefined): Record<number, number> {
  return Object.fromEntries(coverage?.lines ?? []);
}

function diffFor (filePath: string, lines: number[]): FileDiff {
  return { filePath, addedLines: new Set(lines), isNew: false };
}

describe('mergeLcovCoverage', () => {
  it('adds hit counts per line and keeps lines from both records', () => {
    const into: LcovFileCoverage = { filePath: 'src/a.ts', lines: new Map([[1, 2], [2, 0]]) };
    const from: LcovFileCoverage = { filePath: '/abs/src/a.ts', lines: new Map([[2, 3], [3, 0]]) };

    const merged = mergeLcovCoverage(into, from);

    expect(merged).toBe(into);
    expect(merged.filePath).toBe('src/a.ts');
    expect(linesOf(merged)).toEqual({ 1: 2, 2: 3, 3: 0 });
    // `from` is left untouched
    expect(linesOf(from)).toEqual({ 2: 3, 3: 0 });
  });
});

describe('parseLcov', () => {
  it('merges duplicate SF blocks for the same file instead of keeping only the last', () => {
    const file = writeLcov('dup.info', [
      'TN:project-a',
      'SF:src/a.ts',
      'DA:1,1',
      'DA:2,0',
      'end_of_record',
      'TN:project-b',
      'SF:src/a.ts',
      'DA:2,4',
      'DA:3,0',
      'end_of_record',
      '',
    ].join('\n'));

    const result = parseLcov(file);

    expect(result.size).toBe(1);
    expect(linesOf(result.get('src/a.ts'))).toEqual({ 1: 1, 2: 4, 3: 0 });
  });

  it('sums hit counts for a line covered in several blocks', () => {
    const file = writeLcov('sum.info', 'SF:src/a.ts\nDA:1,2\nend_of_record\nSF:src/a.ts\nDA:1,3\nend_of_record\n');
    expect(linesOf(parseLcov(file).get('src/a.ts'))).toEqual({ 1: 5 });
  });

  it('parses a file without a trailing end_of_record', () => {
    const file = writeLcov('truncated.info', 'SF:src/a.ts\nDA:1,1\nend_of_record\nSF:src/b.ts\nDA:7,0\nDA:8,2');
    const result = parseLcov(file);

    expect(linesOf(result.get('src/a.ts'))).toEqual({ 1: 1 });
    expect(linesOf(result.get('src/b.ts'))).toEqual({ 7: 0, 8: 2 });
  });

  it('merges an unterminated final block into an earlier block for the same file', () => {
    const file = writeLcov('truncated-dup.info', 'SF:src/a.ts\nDA:1,0\nend_of_record\nSF:src/a.ts\nDA:1,1');
    expect(linesOf(parseLcov(file).get('src/a.ts'))).toEqual({ 1: 1 });
  });

  it('keeps a block whose end_of_record is missing before the next SF:', () => {
    const file = writeLcov('missing-eor.info', 'SF:src/a.ts\nDA:1,1\nSF:src/b.ts\nDA:2,1\nend_of_record\n');
    const result = parseLcov(file);

    expect(linesOf(result.get('src/a.ts'))).toEqual({ 1: 1 });
    expect(linesOf(result.get('src/b.ts'))).toEqual({ 2: 1 });
  });

  it('handles CRLF line endings', () => {
    const file = writeLcov('crlf.info', 'SF:src/a.ts\r\nDA:1,1\r\nend_of_record\r\nSF:src/a.ts\r\nDA:2,1\r\nend_of_record\r\n');
    expect(linesOf(parseLcov(file).get('src/a.ts'))).toEqual({ 1: 1, 2: 1 });
  });
});

describe('calculateDiffCoverage with duplicate lcov entries', () => {
  it('counts a line as covered when one block covers it and another block does not', () => {
    const file = writeLcov('covered-once.info', [
      'SF:src/a.ts', 'DA:1,0', 'DA:2,1', 'end_of_record',
      'SF:src/a.ts', 'DA:1,1', 'DA:2,0', 'end_of_record',
    ].join('\n'));

    const result = calculateDiffCoverage([diffFor('src/a.ts', [1, 2])], parseLcov(file));

    expect(result.files[0].coveredLineNumbers).toEqual([1, 2]);
    expect(result.files[0].uncoveredLineNumbers).toEqual([]);
    expect(result.overallPercent).toBe(100);
  });

  it('merges raw paths that differ but normalize to the same file', () => {
    // normalizePath makes absolute paths relative to the git repo root, so build one under it.
    const absPath = path.join(findRepoRoot(), 'src', 'a.ts');

    const lcovData = new Map<string, LcovFileCoverage>([
      [absPath, { filePath: absPath, lines: new Map([[1, 1], [2, 0], [3, 0]]) }],
      ['src/a.ts', { filePath: 'src/a.ts', lines: new Map([[2, 2], [3, 0]]) }],
      ['./src/a.ts', { filePath: './src/a.ts', lines: new Map([[4, 0]]) }],
    ]);

    const result = calculateDiffCoverage([diffFor('src/a.ts', [1, 2, 3, 4])], lcovData);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].coveredLineNumbers).toEqual([1, 2]);
    expect(result.files[0].uncoveredLineNumbers).toEqual([3, 4]);
    expect(result.overallPercent).toBe(50);
  });

  it('matches an lcov path under a top-level b/ directory (no diff-prefix stripping)', () => {
    const file = writeLcov('ab-dirs.info', 'SF:b/foo.ts\nDA:1,1\nend_of_record\nSF:./a/bar.ts\nDA:1,0\nend_of_record\n');
    const result = calculateDiffCoverage([diffFor('b/foo.ts', [1]), diffFor('a/bar.ts', [1])], parseLcov(file));

    expect(result.missingFromLcov).toEqual([]);
    expect(result.files.map(f => [f.filePath, f.coveragePercent])).toEqual([['b/foo.ts', 100], ['a/bar.ts', 0]]);
  });

  it('does not mutate the lcov data passed in', () => {
    const lcovData = new Map<string, LcovFileCoverage>([
      ['src/a.ts', { filePath: 'src/a.ts', lines: new Map([[1, 0]]) }],
      ['./src/a.ts', { filePath: './src/a.ts', lines: new Map([[1, 1]]) }],
    ]);

    calculateDiffCoverage([diffFor('src/a.ts', [1])], lcovData);

    expect(linesOf(lcovData.get('src/a.ts'))).toEqual({ 1: 0 });
    expect(linesOf(lcovData.get('./src/a.ts'))).toEqual({ 1: 1 });
  });
});
