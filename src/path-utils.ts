import path from 'path';
import { spawnSync } from 'child_process';

// Module-level cache — findRepoRoot() is called once per toRepoRelativePath() call,
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
 * Normalize a raw unified-diff path ("a/src/foo.ts", "b/src/foo.ts") to a relative posix form.
 * Strips one a/ or b/ prefix, then applies toRepoRelativePath.
 *
 * Only use this on paths that still carry a diff prefix. Paths from parse-diff, git ls-files
 * and lcov have none, and a real top-level directory named a/ or b/ would be stripped by mistake
 * ("b/foo.ts" → "foo.ts"); use toRepoRelativePath for those.
 */
export function normalizePath (filePath: string, repoRoot?: string): string {
  // Strip a/ or b/ prefix from unified diff paths
  const p = /^[ab]\//.test(filePath) ? filePath.slice(2) : filePath;
  return toRepoRelativePath(p, repoRoot);
}

/**
 * Normalize a file path (e.g. an lcov SF: path) to a consistent repo-relative posix form.
 * Handles:
 *   - absolute paths          ("/vd/src/foo.ts" → "src/foo.ts")
 *   - leading ./              ("./src/foo.ts"  → "src/foo.ts")
 *   - Windows backslashes     ("src\\foo.ts"   → "src/foo.ts")
 */
export function toRepoRelativePath (filePath: string, repoRoot?: string): string {
  let p = filePath;

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
