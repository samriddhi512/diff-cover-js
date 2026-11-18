import fs from 'fs';

/**
 * Branch records for one line. Key is `${block}:${branch}` from the BRDA record.
 * Value is the taken count, or null when lcov reports '-' (branch not instrumented / never reached).
 */
export type LineBranches = Map<string, number | null>;

export interface LcovFileCoverage {
  filePath: string;
  /** lineNumber → hitCount  (0 = not covered, >0 = covered) */
  lines: Map<number, number>;
  /**
   * lineNumber → branches on that line (from BRDA records). parseLcov always sets it, as an empty Map
   * when the file has no branch data. Optional so records built by hand in the 0.2.0 shape still type-check.
   */
  branches?: Map<number, LineBranches>;
}

/**
 * Merge the line and branch data of `from` into `into` (mutates and returns `into`).
 * Hit counts for the same line are added together, as lcov's own merge does, so a
 * line covered in either record stays covered. Branch taken counts are added the same way.
 * `into.filePath` is kept.
 *
 * Use this whenever two coverage records describe the same source file: repeated SF:
 * blocks in one lcov file, different raw paths that normalize to the same file, or
 * records from several lcov files.
 */
export function mergeLcovCoverage (into: LcovFileCoverage, from: LcovFileCoverage): LcovFileCoverage {
  for (const [lineNum, hitCount] of from.lines) {
    into.lines.set(lineNum, (into.lines.get(lineNum) ?? 0) + hitCount);
  }

  if (from.branches !== undefined) {
    if (into.branches === undefined) into.branches = new Map();
    for (const [lineNum, fromBranches] of from.branches) {
      const intoBranches: LineBranches = into.branches.get(lineNum) ?? new Map();
      for (const [key, taken] of fromBranches) {
        const existing = intoBranches.get(key);
        // null ('-') means "no data for this branch"; it only wins if nothing else reported it.
        if (existing === undefined || existing === null) {
          intoBranches.set(key, taken);
        } else if (taken !== null) {
          intoBranches.set(key, existing + taken);
        }
      }
      into.branches.set(lineNum, intoBranches);
    }
  }
  return into;
}

/**
 * Parse an lcov.info file.
 * SF: (source file), DA: (line data) and BRDA: (branch data) records are used.
 *
 * lcov format per file block:
 *   TN:<test name>
 *   SF:<source file path>
 *   DA:<line number>,<hit count>
 *   BRDA:<line number>,<block>,<branch>,<taken or ->
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
      current = { filePath: line.slice(3), lines: new Map(), branches: new Map() };
    } else if (line.startsWith('DA:') && current !== null) {
      const [lineNumStr, hitCountStr] = line.slice(3).split(',');
      const lineNum = parseInt(lineNumStr, 10);
      const hitCount = parseInt(hitCountStr, 10);
      if (!isNaN(lineNum) && !isNaN(hitCount)) {
        // If the same line appears multiple times within one block, keep the max hit count
        const existing = current.lines.get(lineNum) ?? 0;
        current.lines.set(lineNum, Math.max(existing, hitCount));
      }
    } else if (line.startsWith('BRDA:') && current !== null) {
      const [lineNumStr, blockStr, branchStr, takenStr] = line.slice(5).split(',');
      const lineNum = parseInt(lineNumStr, 10);
      if (isNaN(lineNum) || blockStr === undefined || branchStr === undefined || takenStr === undefined) continue;
      // '-' means the branch was not instrumented or never reached; it still counts as a branch, but not as taken.
      const taken = takenStr.trim() === '-' ? null : parseInt(takenStr, 10);
      // Skip a malformed count, as DA does, so NaN never reaches the totals.
      if (taken !== null && isNaN(taken)) continue;
      const key = `${blockStr}:${branchStr}`;
      const lineBranches: LineBranches = current.branches!.get(lineNum) ?? new Map();
      const existing = lineBranches.get(key);
      // Within one block, keep the highest taken count for a repeated branch, as DA does.
      if (existing === undefined || existing === null) {
        lineBranches.set(key, taken);
      } else if (taken !== null) {
        lineBranches.set(key, Math.max(existing, taken));
      }
      current.branches!.set(lineNum, lineBranches);
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
