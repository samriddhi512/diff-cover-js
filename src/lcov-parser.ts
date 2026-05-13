import fs from 'fs';

export interface LcovFileCoverage {
  filePath: string;
  /** lineNumber → hitCount  (0 = not covered, >0 = covered) */
  lines: Map<number, number>;
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
 */
export function parseLcov (lcovPath: string): Map<string, LcovFileCoverage> {
  const content = fs.readFileSync(lcovPath, 'utf8');
  const result = new Map<string, LcovFileCoverage>();
  let current: LcovFileCoverage | null = null;

  for (const raw of content.split('\n')) {
    const line = raw.trim();

    if (line.startsWith('SF:')) {
      current = { filePath: line.slice(3), lines: new Map() };
    } else if (line.startsWith('DA:') && current !== null) {
      const [lineNumStr, hitCountStr] = line.slice(3).split(',');
      const lineNum = parseInt(lineNumStr, 10);
      const hitCount = parseInt(hitCountStr, 10);
      if (!isNaN(lineNum) && !isNaN(hitCount)) {
        // If the same line appears multiple times (branches), keep the max hit count
        const existing = current.lines.get(lineNum) ?? 0;
        current.lines.set(lineNum, Math.max(existing, hitCount));
      }
    } else if (line === 'end_of_record' && current !== null) {
      result.set(current.filePath, current);
      current = null;
    }
  }

  // Flush the last block in case the file is truncated (no trailing end_of_record)
  if (current !== null) {
    result.set(current.filePath, current);
  }

  return result;
}
