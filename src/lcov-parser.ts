import fs from 'fs';

export interface LcovFileCoverage {
  filePath: string;
  /** lineNumber → hitCount  (0 = not covered, >0 = covered) */
  lines: Map<number, number>;
}

/**
 * Merge the line data of `from` into `into` (mutates and returns `into`).
 * Hit counts for the same line are added together, as lcov's own merge does, so a
 * line covered in either record stays covered. `into.filePath` is kept.
 *
 * Use this whenever two coverage records describe the same source file: repeated SF:
 * blocks in one lcov file, different raw paths that normalize to the same file, or
 * records from several lcov files.
 */
export function mergeLcovCoverage (into: LcovFileCoverage, from: LcovFileCoverage): LcovFileCoverage {
  for (const [lineNum, hitCount] of from.lines) {
    into.lines.set(lineNum, (into.lines.get(lineNum) ?? 0) + hitCount);
  }
  return into;
}

/**
 * Parse an lcov.info file.
 * Only SF: (source file) and DA: (line data) records matter for diff coverage.
 *
 * lcov format per file block:
 *   TN:<test name>
 *   SF:<source file path>
 *   DA:<line number>,<hit count>
 *   ...
 *   end_of_record
 *
 * The same SF: path can appear in several blocks (Jest multi-project setups,
 * concatenated or sharded reports); those blocks are merged with mergeLcovCoverage.
 */
export function parseLcov (lcovPath: string): Map<string, LcovFileCoverage> {
  const content = fs.readFileSync(lcovPath, 'utf8');
  const result = new Map<string, LcovFileCoverage>();
  let current: LcovFileCoverage | null = null;

  const flush = (block: LcovFileCoverage): void => {
    const existing = result.get(block.filePath);
    if (existing === undefined) {
      result.set(block.filePath, block);
    } else {
      mergeLcovCoverage(existing, block);
    }
  };

  for (const raw of content.split('\n')) {
    const line = raw.trim();

    if (line.startsWith('SF:')) {
      // A new SF: before end_of_record means the previous block was not terminated; keep its data.
      if (current !== null) flush(current);
      current = { filePath: line.slice(3), lines: new Map() };
    } else if (line.startsWith('DA:') && current !== null) {
      const [lineNumStr, hitCountStr] = line.slice(3).split(',');
      const lineNum = parseInt(lineNumStr, 10);
      const hitCount = parseInt(hitCountStr, 10);
      if (!isNaN(lineNum) && !isNaN(hitCount)) {
        // If the same line appears multiple times within one block, keep the max hit count
        const existing = current.lines.get(lineNum) ?? 0;
        current.lines.set(lineNum, Math.max(existing, hitCount));
      }
    } else if (line === 'end_of_record' && current !== null) {
      flush(current);
      current = null;
    }
  }

  // Flush the last block in case the file is truncated (no trailing end_of_record)
  if (current !== null) {
    flush(current);
  }

  return result;
}
