import { FileDiff } from './git-diff';
import { LcovFileCoverage } from './lcov-parser';
import { normalizePath } from './path-utils';

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
}

export function calculateDiffCoverage (
  diffs: FileDiff[],
  lcovData: Map<string, LcovFileCoverage>,
  options: CalculatorOptions = {}
): DiffCoverageResult {
  const rawPatterns = options.noDefaultExcludes
    ? [...(options.exclude ?? [])]
    : [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])];
  // Pre-compile once — not per file/pattern pair
  const compiledExcludes = rawPatterns.map(globToRegex);

  const normalizedLcov = new Map<string, LcovFileCoverage>();
  for (const [filePath, coverage] of lcovData) {
    normalizedLcov.set(normalizePath(filePath), coverage);
  }

  const files: FileStats[] = [];
  const missingFromLcov: string[] = [];
  let totalAdded = 0;
  let totalCoverable = 0;
  let totalCovered = 0;

  for (const diff of diffs) {
    if (isExcluded(diff.filePath, compiledExcludes)) continue;

    const coverage = normalizedLcov.get(diff.filePath);

    if (coverage === undefined) {
      missingFromLcov.push(diff.filePath);

      if (options.strict === true) {
        const lines = Array.from(diff.addedLines).sort((a, b) => a - b);
        files.push({
          filePath: diff.filePath,
          addedLines: diff.addedLines.size,
          coverableAddedLines: diff.addedLines.size,
          coveredLines: 0,
          coveredLineNumbers: [],
          uncoveredLineNumbers: lines,
          coveragePercent: 0,
          inLcov: false,
        });
        totalAdded += diff.addedLines.size;
        totalCoverable += diff.addedLines.size;
      }
      continue;
    }

    let covered = 0;
    let coverable = 0;
    const coveredLineNumbers: number[] = [];
    const uncoveredLineNumbers: number[] = [];

    for (const lineNum of diff.addedLines) {
      const hitCount = coverage.lines.get(lineNum);
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

    // Floor to match diff-cover's int() truncation behavior.
    // Example: 79.9% → 79 (not 80), so --fail-under 80 correctly fails.
    const coveragePercent = coverable === 0
      ? 100
      : Math.floor((covered / coverable) * 100);

    files.push({
      filePath: diff.filePath,
      addedLines: diff.addedLines.size,
      coverableAddedLines: coverable,
      coveredLines: covered,
      coveredLineNumbers,
      uncoveredLineNumbers,
      coveragePercent,
      inLcov: true,
    });

    totalAdded += diff.addedLines.size;
    totalCoverable += coverable;
    totalCovered += covered;
  }

  const overallPercent = totalCoverable === 0
    ? 100
    : Math.floor((totalCovered / totalCoverable) * 100);

  return { files, missingFromLcov, totalAdded, totalCoverable, totalCovered, overallPercent };
}
