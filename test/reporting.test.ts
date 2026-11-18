import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LcovFileCoverage } from '../src/lcov-parser';
import { calculateDiffCoverage, nonCodeLineNumbers } from '../src/calculator';
import { printReport } from '../src/reporter';
import { buildReportDict, generateHtmlReport, generateMarkdownReport } from '../src/report-generator';
import { FileDiff } from '../src/git-diff';
import { findRepoRoot } from '../src/path-utils';

function diffFor (filePath: string, lines: number[]): FileDiff {
  return { filePath, addedLines: new Set(lines), isNew: false };
}

function linesFromNonCode (source: string): number[] {
  return [...nonCodeLineNumbers(source)].sort((a, b) => a - b);
}

describe('nonCodeLineNumbers: code after a comment is code', () => {
  it('treats a JSDoc line with code after the comment as code', () => {
    expect(linesFromNonCode('/** @type {X} */ const a = foo();')).toEqual([]);
  });

  it('treats a block comment followed by code as code', () => {
    expect(linesFromNonCode('/* x */ code();')).toEqual([]);
  });

  it('treats a line that closes a block comment and then has code as code', () => {
    // line 1 opens a block, line 2 closes it and then has code
    expect(linesFromNonCode('/*\n */ const z = foo();')).toEqual([1]);
  });

  it('still skips a line that is only a comment with trailing // comment text', () => {
    expect(linesFromNonCode('/* x */ // note')).toEqual([1]);
  });

  it('treats a closed block comment on its own line as non-code', () => {
    expect(linesFromNonCode('/* x */')).toEqual([1]);
  });

  it('treats a comment that opens another block after the close as code', () => {
    // conservative: an unterminated /* after */ is counted as code
    expect(linesFromNonCode('/* a */ /* b')).toEqual([]);
  });
});

describe('strict mode reads the working tree by default', () => {
  const fixtureRel = 'test/.strict-default-read-fixture.ts';
  const fixtureAbs = path.join(findRepoRoot(), fixtureRel);

  beforeAll(() => {
    // line 1: code, line 2: blank, line 3: comment
    fs.writeFileSync(fixtureAbs, 'const a = 1;\n\n// comment\n');
  });

  afterAll(() => {
    fs.rmSync(fixtureAbs, { force: true });
  });

  it('skips blank and comment lines using the file on disk', () => {
    const result = calculateDiffCoverage(
      [diffFor(fixtureRel, [1, 2, 3])],
      new Map<string, LcovFileCoverage>(),
      { strict: true },
    );

    expect(result.files[0].uncoveredLineNumbers).toEqual([1]);
    expect(result.files[0].coverableAddedLines).toBe(1);
  });
});

describe('console report branch output', () => {
  let logs: string[];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureReport (result: ReturnType<typeof calculateDiffCoverage>): string {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    printReport(result);
    return logs.join('\n');
  }

  it('shows branch percentages, partial branch lines and overall branch totals', () => {
    const lcov = new Map<string, LcovFileCoverage>([
      ['src/a.ts', {
        filePath: 'src/a.ts',
        lines: new Map([[5, 2]]),
        branches: new Map([[5, new Map([['0:0', 0], ['0:1', 2]])]]),
      }],
    ]);
    const result = calculateDiffCoverage([diffFor('src/a.ts', [5])], lcov);

    const output = captureReport(result);

    expect(output).toContain('50% branch coverage');
    expect(output).toContain('(1/2 branches on changed lines)');
    expect(output).toContain('Partially covered branches: 5');
    expect(output).toContain('Overall branch coverage: 50%');
    expect(output).toContain('1/2 branches on changed lines covered');
  });

  it('omits branch lines when changed lines have no branches', () => {
    const lcov = new Map<string, LcovFileCoverage>([
      ['src/a.ts', { filePath: 'src/a.ts', lines: new Map([[1, 1]]) }],
    ]);
    const result = calculateDiffCoverage([diffFor('src/a.ts', [1])], lcov);

    const output = captureReport(result);

    expect(output).not.toContain('branch');
    expect(output).not.toContain('Partially covered');
  });

  it('uses code-line wording for strict-mode files missing from lcov', () => {
    const result = calculateDiffCoverage(
      [diffFor('src/new.ts', [1, 2])],
      new Map(),
      { strict: true, readSource: () => '// only a comment\nconst x = 1;' },
    );

    const output = captureReport(result);

    expect(output).toContain('1 code lines treated as uncovered');
    expect(output).not.toContain('changed lines treated as uncovered');
  });

  it('shows a strict-mode file with only comment changes as covered, not 0%', () => {
    const result = calculateDiffCoverage(
      [diffFor('src/new.ts', [1, 2])],
      new Map(),
      { strict: true, readSource: () => '// only a comment\n' },
    );

    const output = captureReport(result);

    expect(output).toContain('✓  src/new.ts');
    expect(output).toContain('100% diff coverage  (not in coverage data, no code lines changed)');
    expect(output).not.toContain('✗');
    expect(output).not.toContain('0 code lines treated as uncovered');
    // Shown once in the files list, not again in the "not collected" section.
    expect(output).not.toContain('Changed files not collected');
  });
});

describe('strict-mode file with no code lines changed in file reports', () => {
  const result = calculateDiffCoverage(
    [diffFor('src/comments.ts', [1, 2]), diffFor('src/code.ts', [1])],
    new Map(),
    {
      strict: true,
      readSource: (p) => p === 'src/comments.ts' ? '/**\n * doc\n */' : 'const x = 1;',
    },
  );

  it('uses a null percentCovered in JSON, like a file with no coverable lines', () => {
    const dict = buildReportDict(result, 'main');

    expect(dict.srcStats['src/comments.ts']).toMatchObject({
      percentCovered: null,
      coverableLines: 0,
      violationLines: [],
      missingFromLcov: true,
    });
    expect(dict.srcStats['src/code.ts']).toMatchObject({
      percentCovered: 0,
      coverableLines: 1,
      violationLines: [1],
      missingFromLcov: true,
    });
    expect(dict.totalNumLines).toBe(1);
    expect(dict.totalPercentCovered).toBe(0);
  });

  it('does not show it as 0% in Markdown or HTML', () => {
    const markdown = generateMarkdownReport(result, 'main');
    expect(markdown).toContain('- src/comments.ts (100%): Not in coverage data, no code lines changed');
    expect(markdown).toContain('- src/code.ts (0%): Not in coverage data');

    const html = generateHtmlReport(result, 'main');
    expect(html).toContain('N/A (not collected)');
    expect(html.match(/0% \(not collected\)/g)).toHaveLength(1);
  });
});

describe('buildReportDict branch fields', () => {
  it('includes per-file and total branch counts in the JSON dictionary', () => {
    const lcov = new Map<string, LcovFileCoverage>([
      ['src/a.ts', {
        filePath: 'src/a.ts',
        lines: new Map([[1, 1], [2, 1]]),
        branches: new Map([[2, new Map([['0:0', 1], ['0:1', 0]])]]),
      }],
    ]);
    const result = calculateDiffCoverage([diffFor('src/a.ts', [1, 2])], lcov);

    const dict = buildReportDict(result, 'main');

    expect(dict.srcStats['src/a.ts']).toMatchObject({
      coverableBranches: 2,
      coveredBranches: 1,
      percentBranchesCovered: 50,
    });
    expect(dict.totalNumBranches).toBe(2);
    expect(dict.totalNumCoveredBranches).toBe(1);
    expect(dict.totalPercentBranchesCovered).toBe(50);
  });

  it('uses null branch percentages when there are no branches', () => {
    const lcov = new Map<string, LcovFileCoverage>([
      ['src/a.ts', { filePath: 'src/a.ts', lines: new Map([[1, 1]]) }],
    ]);
    const result = calculateDiffCoverage([diffFor('src/a.ts', [1])], lcov);

    const dict = buildReportDict(result, 'main');

    expect(dict.srcStats['src/a.ts'].percentBranchesCovered).toBeNull();
    expect(dict.totalPercentBranchesCovered).toBeNull();
  });
});

describe('printReport with a result built by hand in the 0.2.0 shape (no branch fields)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the line report and no branch lines instead of throwing', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    const legacy = {
      files: [{
        filePath: 'src/a.ts',
        addedLines: 2,
        coverableAddedLines: 2,
        coveredLines: 2,
        coveredLineNumbers: [1, 2],
        uncoveredLineNumbers: [],
        coveragePercent: 100,
        inLcov: true,
      }],
      missingFromLcov: [],
      totalAdded: 2,
      totalCoverable: 2,
      totalCovered: 2,
      overallPercent: 100,
    } as unknown as ReturnType<typeof calculateDiffCoverage>;

    expect(() => printReport(legacy)).not.toThrow();

    const output = logs.join('\n');
    expect(output).toContain('100% diff coverage');
    expect(output).not.toContain('branch coverage');
    expect(output).not.toContain('undefined');
  });
});
