import fs from 'fs';
import { FileDiff } from './git-diff';
import { LcovFileCoverage, mergeLcovCoverage } from './lcov-parser';
import { toRepoRelativePath, findRepoRoot } from './path-utils';

export interface FileStats {
  filePath: string;
  /** Total added lines in the diff (includes non-executable lines) */
  addedLines: number;
  /** Added lines that appear as executable in lcov (blank/comment lines excluded) */
  coverableAddedLines: number;
  /** Count of covered executable changed lines */
  coveredLines: number;
  /** Actual covered line numbers (for JSON report consumers) */
  coveredLineNumbers: number[];
  /** Line numbers that are executable but not covered */
  uncoveredLineNumbers: number[];
  /** Integer percent, floored to match diff-cover's int() behavior */
  coveragePercent: number;
  /** False when the file was in the diff but had no entry in lcov */
  inLcov: boolean;
  /** Branches (BRDA records) on added lines */
  coverableBranches: number;
  /** Branches on added lines that were taken at least once */
  coveredBranches: number;
  /** Integer percent of branches covered; null when the changed lines have no branches */
  branchPercent: number | null;
  /** Added lines with at least one branch that was never taken */
  partialBranchLines: number[];
}

export interface DiffCoverageResult {
  files: FileStats[];
  /** Files that appeared in the diff but had no lcov entry at all */
  missingFromLcov: string[];
  totalAdded: number;
  totalCoverable: number;
  totalCovered: number;
  /** Integer percent, floored (matches diff-cover's int() truncation) */
  overallPercent: number;
  totalBranches: number;
  totalCoveredBranches: number;
  /** Integer percent of branches covered across all files; null when there are no changed branches */
  overallBranchPercent: number | null;
}

/**
 * Whether the text after a closing `*\/` still contains code. Anything other than blank or a
 * // comment counts as code, including another /* that is left open. When unsure, count the line:
 * a false "code" only lowers the score a little, but a false "comment" hides uncovered code.
 */
function hasCodeAfterComment (rest: string): boolean {
  const trimmed = rest.trim();
  return trimmed !== '' && !trimmed.startsWith('//');
}

/**
 * Line numbers (1-based) that are blank or comment-only in `source`.
 * Used in strict mode, where there is no lcov data to say which changed lines are executable.
 * Handles //, and /* ... *\/ blocks (including JSDoc). A line that has code after a comment
 * (e.g. `/** @type {X} *\/ const a = foo();`) is code. It does not handle comment markers inside strings.
 * A block comment opened after code (`foo(); /* note`) is not tracked, so the lines after it count as
 * code. Both limits err toward counting a line as code.
 */
export function nonCodeLineNumbers (source: string): Set<number> {
  const result = new Set<number>();
  let inBlockComment = false;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    const lineNum = i + 1;
    if (inBlockComment) {
      const close = text.indexOf('*/');
      if (close === -1) {
        result.add(lineNum);
      } else {
        inBlockComment = false;
        if (!hasCodeAfterComment(text.slice(close + 2))) result.add(lineNum);
      }
    } else if (text === '' || text.startsWith('//')) {
      result.add(lineNum);
    } else if (text.startsWith('/*')) {
      const close = text.indexOf('*/', 2);
      if (close === -1) {
        result.add(lineNum);
        inBlockComment = true;
      } else if (!hasCodeAfterComment(text.slice(close + 2))) {
        result.add(lineNum);
      }
    }
  }
  return result;
}

/**
 * Reads the file from the working tree, not from the compared ref. Diff line numbers refer to the
 * new side of the diff, so if the file was edited after the diff was made, the skipped lines can be
 * wrong. This is the normal case in CI and for local runs; it only matters when comparing an old ref.
 */
function defaultReadSource (filePath: string): string | null {
  try {
    return fs.readFileSync(`${findRepoRoot()}/${filePath}`, 'utf8');
  } catch {
    return null;
  }
}

/** Copy coverage so merging never mutates the caller's data. */
function copyCoverage (coverage: LcovFileCoverage): LcovFileCoverage {
  const copy: LcovFileCoverage = { filePath: coverage.filePath, lines: new Map(coverage.lines) };
  if (coverage.branches !== undefined) {
    copy.branches = new Map();
    for (const [line, branches] of coverage.branches) {
      copy.branches.set(line, new Map(branches));
    }
  }
  return copy;
}

// Glob → RegExp converter, processed character-by-character.
// Supports **/ (path prefix), ** (any chars), * (single segment), ? (single char).
function globToRegex (pattern: string): RegExp {
  let result = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        result += '(.+/)?'; // **/ → match zero or more path segments
        i += 3;
      } else {
        result += '.*';     // ** → match anything
        i += 2;
      }
    } else if (ch === '*') {
      result += '[^/]*';    // * → match within a single segment
      i++;
    } else if (ch === '?') {
      result += '[^/]';     // ? → single non-slash char
      i++;
    } else {
      // Escape all regex special characters in literal parts
      result += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  result += '$';
  return new RegExp(result);
}

function isExcluded (filePath: string, compiled: RegExp[]): boolean {
  return compiled.some(re => re.test(filePath));
}

export const DEFAULT_EXCLUDES = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.js',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.spec.js',
  '**/*.test.jsx',
  '**/*.spec.jsx',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/*.d.ts',
];

export interface CalculatorOptions {
  /**
   * When true, files in the diff but absent from lcov are counted as 0% covered.
   * Default (false): those files are listed as warnings but excluded from the %.
   */
  strict?: boolean;
  /** Additional glob patterns to exclude from the diff analysis */
  exclude?: string[];
  /**
   * When true, the built-in DEFAULT_EXCLUDES (test/spec/.d.ts files) are not applied.
   * Only the patterns in `exclude` are used.
   */
  noDefaultExcludes?: boolean;
  /**
   * Returns the source text of a repo-relative file, or null if it can't be read.
   * Used in strict mode to skip blank and comment lines. Defaults to reading from the repo root.
   */
  readSource?: (filePath: string) => string | null;
}

export function calculateDiffCoverage (
  diffs: FileDiff[],
  lcovData: Map<string, LcovFileCoverage>,
  options: CalculatorOptions = {}
): DiffCoverageResult {
  const readSource = options.readSource ?? defaultReadSource;
  const rawPatterns = options.noDefaultExcludes
    ? [...(options.exclude ?? [])]
    : [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])];
  // Pre-compile once — not per file/pattern pair
  const compiledExcludes = rawPatterns.map(globToRegex);

  // Different raw paths (e.g. "/abs/repo/src/a.ts" and "src/a.ts") can normalize to the
  // same file. Merge them instead of letting the last one win. Each entry is copied before
  // merging so the caller's lcovData is never mutated.
  const normalizedLcov = new Map<string, LcovFileCoverage>();
  for (const [filePath, coverage] of lcovData) {
    const key = toRepoRelativePath(filePath);
    const existing = normalizedLcov.get(key);
    if (existing === undefined) {
      normalizedLcov.set(key, copyCoverage(coverage));
    } else {
      mergeLcovCoverage(existing, coverage);
    }
  }

  const files: FileStats[] = [];
  const missingFromLcov: string[] = [];
  let totalAdded = 0;
  let totalCoverable = 0;
  let totalCovered = 0;
  let totalBranches = 0;
  let totalCoveredBranches = 0;

  for (const diff of diffs) {
    if (isExcluded(diff.filePath, compiledExcludes)) continue;

    const coverage = normalizedLcov.get(diff.filePath);

    if (coverage === undefined) {
      missingFromLcov.push(diff.filePath);

      if (options.strict === true) {
        // No lcov data for this file, so we can't tell executable lines from blank/comment ones.
        // Read the source and skip non-code lines. If it can't be read, every added line counts.
        const source = readSource(diff.filePath);
        const skip = source === null ? new Set<number>() : nonCodeLineNumbers(source);
        const lines = Array.from(diff.addedLines).filter(n => !skip.has(n)).sort((a, b) => a - b);
        files.push({
          filePath: diff.filePath,
          addedLines: diff.addedLines.size,
          coverableAddedLines: lines.length,
          coveredLines: 0,
          coveredLineNumbers: [],
          uncoveredLineNumbers: lines,
          // Only blank/comment lines changed: nothing to cover. 100%, same as a file in lcov
          // with no coverable changed lines.
          coveragePercent: lines.length === 0 ? 100 : 0,
          inLcov: false,
          coverableBranches: 0,
          coveredBranches: 0,
          branchPercent: null,
          partialBranchLines: [],
        });
        totalAdded += diff.addedLines.size;
        totalCoverable += lines.length;
      }
      continue;
    }

    let covered = 0;
    let coverable = 0;
    const coveredLineNumbers: number[] = [];
    const uncoveredLineNumbers: number[] = [];

    let fileBranches = 0;
    let fileCoveredBranches = 0;
    const partialBranchLines: number[] = [];

    for (const lineNum of diff.addedLines) {
      const hitCount = coverage.lines.get(lineNum);

      // Branch data is counted on added lines regardless of line hit counts.
      const lineBranches = coverage.branches?.get(lineNum);
      if (lineBranches !== undefined && lineBranches.size > 0) {
        let takenHere = 0;
        for (const taken of lineBranches.values()) {
          if (taken !== null && taken > 0) takenHere++;
        }
        fileBranches += lineBranches.size;
        fileCoveredBranches += takenHere;
        if (takenHere < lineBranches.size) partialBranchLines.push(lineNum);
      }

      if (hitCount === undefined) {
        // Not in lcov = blank line / comment / import istanbul skips → not executable
        continue;
      }
      coverable++;
      if (hitCount > 0) {
        covered++;
        coveredLineNumbers.push(lineNum);
      } else {
        uncoveredLineNumbers.push(lineNum);
      }
    }

    coveredLineNumbers.sort((a, b) => a - b);
    uncoveredLineNumbers.sort((a, b) => a - b);
    partialBranchLines.sort((a, b) => a - b);

    // Floor to match diff-cover's int() truncation behavior.
    // Example: 79.9% → 79 (not 80), so --fail-under 80 correctly fails.
    const coveragePercent = coverable === 0
      ? 100
      : Math.floor((covered / coverable) * 100);
    const branchPercent = fileBranches === 0
      ? null
      : Math.floor((fileCoveredBranches / fileBranches) * 100);

    files.push({
      filePath: diff.filePath,
      addedLines: diff.addedLines.size,
      coverableAddedLines: coverable,
      coveredLines: covered,
      coveredLineNumbers,
      uncoveredLineNumbers,
      coveragePercent,
      inLcov: true,
      coverableBranches: fileBranches,
      coveredBranches: fileCoveredBranches,
      branchPercent,
      partialBranchLines,
    });

    totalAdded += diff.addedLines.size;
    totalCoverable += coverable;
    totalCovered += covered;
    totalBranches += fileBranches;
    totalCoveredBranches += fileCoveredBranches;
  }

  const overallPercent = totalCoverable === 0
    ? 100
    : Math.floor((totalCovered / totalCoverable) * 100);
  const overallBranchPercent = totalBranches === 0
    ? null
    : Math.floor((totalCoveredBranches / totalBranches) * 100);

  return {
    files,
    missingFromLcov,
    totalAdded,
    totalCoverable,
    totalCovered,
    overallPercent,
    totalBranches,
    totalCoveredBranches,
    overallBranchPercent,
  };
}
