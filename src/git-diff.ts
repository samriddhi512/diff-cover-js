import { spawnSync } from 'child_process';
import parseDiff from 'parse-diff';
import { normalizePath } from './path-utils';

export interface FileDiff {
  /** Normalized relative path of the file in the new version */
  filePath: string;
  /** Line numbers (in the new file) that were added in this diff */
  addedLines: Set<number>;
  /** True if this is a brand-new file (all lines are additions) */
  isNew: boolean;
}

export type RangeNotation = '...' | '..';

/**
 * Run `git diff <compareRef><rangeNotation>HEAD` and return added line numbers per file.
 *
 * Uses spawnSync (no shell) to prevent command injection from user-supplied compareRef.
 * --no-color and --no-ext-diff prevent ANSI escape codes from corrupting parse-diff output.
 * --unified=0 gives no context lines so every hunk line is purely + or -.
 * --diff-filter=ACMR skips deleted files.
 */
export function getGitDiff (compareRef: string, rangeNotation: RangeNotation = '...'): FileDiff[] {
  const args = [
    // Suppress prefix and mnemonic-prefix config that could alter path format
    '-c', 'diff.noprefix=no',
    '-c', 'diff.mnemonicprefix=no',
    // Force plain path output so parse-diff sees unquoted paths for non-ASCII filenames
    '-c', 'core.quotePath=false',
    'diff',
    `${compareRef}${rangeNotation}HEAD`,
    '--unified=0',
    '--diff-filter=ACMR',
    '--no-color',
    '--no-ext-diff',
  ];

  const proc = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });

  if (proc.error) {
    const isNotFound = (proc.error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(
      isNotFound
        ? 'git not found. Make sure git is installed and available in your PATH.'
        : `git diff failed: ${proc.error.message}\nMake sure "${compareRef}" is fetched before running diff-cover-js.`
    );
  }
  if (proc.status !== 0) {
    const stderr = proc.stderr?.trim() ?? '';
    throw new Error(
      `git diff exited with code ${proc.status}: ${stderr}\nMake sure "${compareRef}" is fetched before running diff-cover-js.`
    );
  }

  const diffOutput = proc.stdout ?? '';
  const files = parseDiff(diffOutput);
  const result: FileDiff[] = [];

  for (const file of files) {
    if (file.deleted === true || file.to === '/dev/null') continue;

    const rawPath = file.to ?? file.from ?? '';
    if (!rawPath) continue;

    const filePath = normalizePath(rawPath);
    const addedLines = new Set<number>();

    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === 'add' && 'ln' in change && typeof (change as Record<string, unknown>).ln === 'number') {
          addedLines.add((change as { ln: number }).ln);
        }
      }
    }

    if (addedLines.size === 0) continue;

    result.push({ filePath, addedLines, isNew: file.new === true });
  }

  return result;
}
