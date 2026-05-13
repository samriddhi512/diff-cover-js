import path from 'path';
import { spawnSync } from 'child_process';

// Module-level cache — findRepoRoot() is called once per normalizePath() call,
// which happens for every LCOV entry. Cache avoids spawning hundreds of subprocesses.
let _repoRoot: string | null = null;

export function clearRepoRootCache (): void {
  _repoRoot = null;
}

export function findRepoRoot (): string {
  if (_repoRoot !== null) return _repoRoot;

  const proc = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  _repoRoot = proc.status === 0 && proc.stdout
    ? proc.stdout.trim()
    : process.cwd();

  return _repoRoot;
}

/**
 * Normalize a file path to a consistent relative posix form for comparison.
 * Handles:
 *   - git diff a/b prefixes  ("a/src/foo.ts" → "src/foo.ts")
 *   - absolute paths          ("/vd/src/foo.ts" → "src/foo.ts")
 *   - leading ./              ("./src/foo.ts"  → "src/foo.ts")
 *   - Windows backslashes     ("src\\foo.ts"   → "src/foo.ts")
 */
export function normalizePath (filePath: string, repoRoot?: string): string {
  let p = filePath;

  // Strip a/ or b/ prefix from unified diff paths
  if (/^[ab]\//.test(p)) {
    p = p.slice(2);
  }

  // Strip absolute path to relative
  if (path.isAbsolute(p)) {
    const root = repoRoot ?? findRepoRoot();
    p = path.relative(root, p);
  }

  // Strip leading ./
  if (p.startsWith('./')) {
    p = p.slice(2);
  }

  // Normalize Windows backslashes to forward slashes
  p = p.replace(/\\/g, '/');

  return p;
}
