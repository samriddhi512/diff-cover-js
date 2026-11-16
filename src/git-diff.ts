import fs from 'fs';
import path from 'path';
import { spawnSync, SpawnSyncReturns } from 'child_process';
import parseDiff from 'parse-diff';

export interface FileDiff {
  /** Normalized relative path of the file in the new version */
  filePath: string;
  /** Line numbers (in the new file) that were added in this diff */
  addedLines: Set<number>;
  /** True if this is a brand-new file (all lines are additions) */
  isNew: boolean;
}

export type RangeNotation = '...' | '..';

export interface GitDiffOptions {
  /** Exclude changes that are staged in the index (Python diff-cover: --ignore-staged). */
  ignoreStaged?: boolean;
  /** Exclude changes in the working tree that are not staged (Python diff-cover: --ignore-unstaged). */
  ignoreUnstaged?: boolean;
  /**
   * Also report untracked files (not ignored by .gitignore), with every line
   * counted as added (Python diff-cover: --include-untracked). Default: false.
   */
  includeUntracked?: boolean;
  /** Directory to run git in. Defaults to process.cwd(). */
  cwd?: string;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

interface ParsedFile {
  /** Normalized path on the old side of the diff, or null for added files */
  from: string | null;
  /** Normalized path on the new side of the diff, or null for deleted files */
  to: string | null;
  isNew: boolean;
  isDeleted: boolean;
  addedLines: Set<number>;
  hunks: Hunk[];
}

const GIT_CONFIG_OVERRIDES = [
  // Suppress prefix and mnemonic-prefix config that could alter path format
  '-c', 'diff.noprefix=no',
  '-c', 'diff.mnemonicprefix=no',
  // Force plain path output so parse-diff sees unquoted paths for non-ASCII filenames
  '-c', 'core.quotePath=false',
];

// --no-color and --no-ext-diff prevent ANSI escape codes / external tools from corrupting
// parse-diff output. --unified=0 gives no context lines so every hunk line is purely + or -,
// and makes hunk headers describe exactly the changed ranges (needed for line mapping).
const DIFF_FLAGS = ['--unified=0', '--no-color', '--no-ext-diff'];

/** Diffs whose added lines we report. --diff-filter=ACMR skips deleted files. */
function changesDiffArgs (revs: string[]): string[] {
  return [...GIT_CONFIG_OVERRIDES, 'diff', ...revs, ...DIFF_FLAGS, '--diff-filter=ACMR'];
}

/**
 * Diffs used only to translate line numbers into working-tree coordinates.
 * No --diff-filter, because we must see deletions to drop files that no longer exist.
 * diff.renames=true forces rename detection (and turns off copy detection, which would
 * give one source path several destinations) regardless of the user's git config.
 */
function mappingDiffArgs (revs: string[]): string[] {
  return [...GIT_CONFIG_OVERRIDES, '-c', 'diff.renames=true', 'diff', ...revs, ...DIFF_FLAGS];
}

function fetchHint (compareRef: string): string {
  return `Make sure "${compareRef}" is fetched before running diff-cover-js.`;
}

/** Spawn git without a shell. Throws only if git could not be started. */
function spawnGit (args: string[], cwd: string | undefined, name: string, hint?: string): SpawnSyncReturns<string> {
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });

  if (proc.error) {
    const isNotFound = (proc.error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(
      isNotFound
        ? 'git not found. Make sure git is installed and available in your PATH.'
        : `${name} failed: ${proc.error.message}${hint ? `\n${hint}` : ''}`
    );
  }
  return proc;
}

/** Run git and return stdout. Throws on a non-zero exit status. */
function runGit (args: string[], cwd: string | undefined, name: string, hint?: string): string {
  const proc = spawnGit(args, cwd, name, hint);
  if (proc.status !== 0) {
    const stderr = proc.stderr?.trim() ?? '';
    throw new Error(`${name} exited with code ${proc.status}: ${stderr}${hint ? `\n${hint}` : ''}`);
  }
  return proc.stdout ?? '';
}

/**
 * Resolve the commit that changes are measured against:
 *   "..."  → git merge-base <compareRef> HEAD
 *   ".."   → <compareRef> itself
 * Returns a full commit hash, so later git commands never see a user-supplied string.
 */
function resolveDiffBase (compareRef: string, rangeNotation: RangeNotation, cwd: string | undefined): string {
  if (rangeNotation !== '...' && rangeNotation !== '..') {
    throw new Error(`Invalid diff range notation "${String(rangeNotation)}": must be "..." or "..".`);
  }
  if (!compareRef) {
    throw new Error('A compare ref is required (e.g. origin/main).');
  }
  // Without this, a ref like "--output=x" would be parsed by git as an option.
  if (compareRef.startsWith('-')) {
    throw new Error(`Invalid compare ref "${compareRef}": a git ref cannot start with "-".`);
  }

  const hint = fetchHint(compareRef);
  const rev = spawnGit(['rev-parse', '--verify', '--quiet', `${compareRef}^{commit}`], cwd, 'git rev-parse', hint);
  const refSha = rev.status === 0 ? rev.stdout.trim() : '';
  if (!refSha) {
    // --quiet silences only "ref not found". Anything on stderr is a different failure
    // (not a git repository, safe.directory "dubious ownership", corrupt repo), so show git's
    // own message instead of telling the user to fetch.
    const stderr = rev.stderr?.trim() ?? '';
    throw new Error(stderr
      ? `git rev-parse exited with code ${rev.status}: ${stderr}`
      : `Could not resolve "${compareRef}" to a commit.\n${hint}`);
  }
  if (rangeNotation === '..') return refSha;

  const mb = spawnGit(['merge-base', refSha, 'HEAD'], cwd, 'git merge-base', hint);
  const base = mb.status === 0 ? mb.stdout.trim().split('\n')[0] : '';
  if (base) return base;

  const stderr = mb.stderr?.trim() ?? '';
  if (mb.status === 1 && !stderr) {
    // Exit 1 with no output means "no common ancestor".
    const shallow = spawnGit(['rev-parse', '--is-shallow-repository'], cwd, 'git rev-parse');
    const isShallow = shallow.status === 0 && shallow.stdout.trim() === 'true';
    throw new Error(
      `No merge base found between "${compareRef}" and HEAD.\n` +
      (isShallow
        ? 'This is a shallow clone, so their common ancestor is probably outside the fetched history. ' +
          'Fetch more history (e.g. "git fetch --unshallow", or "fetch-depth: 0" with actions/checkout), ' +
          'or use --diff-range-notation "..".\n'
        : `"${compareRef}" and HEAD do not share any history. Use --diff-range-notation ".." to diff against "${compareRef}" directly.\n`) +
      hint
    );
  }
  throw new Error(`git merge-base exited with code ${mb.status}: ${stderr}\n${hint}`);
}

/**
 * parse-diff has already stripped the a/ b/ prefixes, and git prints repo-relative posix paths,
 * so the path is used as-is. (normalizePath would strip a second "a/" or "b/", mangling files
 * under a real top-level a/ or b/ directory.)
 */
function toPath (raw: string | undefined): string | null {
  return raw && raw !== '/dev/null' ? raw : null;
}

function parseGitDiff (diffOutput: string): ParsedFile[] {
  return parseDiff(diffOutput).map(file => {
    const addedLines = new Set<number>();
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === 'add') addedLines.add(change.ln);
      }
    }
    return {
      from: toPath(file.from),
      to: toPath(file.to),
      isNew: file.new === true,
      isDeleted: file.deleted === true || file.to === '/dev/null',
      addedLines,
      hunks: file.chunks.map(({ oldStart, oldLines, newStart, newLines }) => ({ oldStart, oldLines, newStart, newLines })),
    };
  });
}

/** Files with at least one added line, in diff order. */
function toFileDiffs (files: ParsedFile[]): FileDiff[] {
  const result: FileDiff[] = [];
  for (const file of files) {
    if (file.isDeleted || file.to === null || file.addedLines.size === 0) continue;
    result.push({ filePath: file.to, addedLines: file.addedLines, isNew: file.isNew });
  }
  return result;
}

function runChangesDiff (revs: string[], cwd: string | undefined, hint?: string): FileDiff[] {
  return toFileDiffs(parseGitDiff(runGit(changesDiffArgs(revs), cwd, 'git diff', hint)));
}

function runMappingDiff (revs: string[], cwd: string | undefined): ParsedFile[] {
  return parseGitDiff(runGit(mappingDiffArgs(revs), cwd, 'git diff'));
}

/**
 * Map a line number on the old side of a --unified=0 diff to the new side.
 * Returns null when the line was deleted or replaced by the diff.
 */
function mapOldLineToNew (hunks: Hunk[], line: number): number | null {
  let offset = 0;
  for (const h of hunks) {
    if (h.oldLines > 0) {
      if (line < h.oldStart) break;
      if (line < h.oldStart + h.oldLines) return null;
    } else if (line <= h.oldStart) {
      // Pure insertion after old line h.oldStart: lines up to and including it are unaffected.
      break;
    }
    offset += h.newLines - h.oldLines;
  }
  return line + offset;
}

/**
 * Translate line numbers of `files` (taken from some snapshot, e.g. HEAD or the index) into
 * working-tree line numbers, using `mapping` = the diff from that snapshot to the working tree.
 * Lines that the mapping diff deleted or rewrote are dropped: their current content comes from
 * a change that was excluded. Files deleted in the working tree are dropped.
 */
function mapToWorktree (files: FileDiff[], mapping: ParsedFile[]): FileDiff[] {
  const bySource = new Map<string, ParsedFile>();
  for (const m of mapping) {
    if (m.from !== null) bySource.set(m.from, m);
  }

  const result: FileDiff[] = [];
  for (const file of files) {
    const m = bySource.get(file.filePath);
    if (m === undefined) {
      result.push(file); // unchanged between the snapshot and the working tree
      continue;
    }
    if (m.isDeleted || m.to === null) continue;

    const addedLines = new Set<number>();
    for (const line of file.addedLines) {
      const mapped = mapOldLineToNew(m.hunks, line);
      if (mapped !== null) addedLines.add(mapped);
    }
    if (addedLines.size > 0) {
      result.push({ filePath: m.to, addedLines, isNew: file.isNew });
    }
  }
  return result;
}

/** Remove `remove`'s lines from `from`, per file. Files left with no lines are dropped. */
function subtractLines (from: FileDiff[], remove: FileDiff[]): FileDiff[] {
  const removeByPath = new Map(remove.map(f => [f.filePath, f.addedLines]));
  const result: FileDiff[] = [];
  for (const file of from) {
    const toRemove = removeByPath.get(file.filePath);
    if (toRemove === undefined) {
      result.push(file);
      continue;
    }
    const addedLines = new Set([...file.addedLines].filter(line => !toRemove.has(line)));
    if (addedLines.size > 0) result.push({ ...file, addedLines });
  }
  return result;
}

/**
 * Count the lines of a text file, reading it in fixed-size chunks so that a huge untracked file
 * is never loaded into memory at once. Returns null for binary files, using git's heuristic:
 * a NUL byte in the first 8000 bytes.
 */
function countTextLines (filePath: string): number | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let count = 0;
    let total = 0;
    let lastByte = -1;
    let bytesRead: number;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      if (total === 0 && buf.subarray(0, Math.min(bytesRead, 8000)).includes(0)) return null;
      for (let i = buf.indexOf(0x0a); i !== -1 && i < bytesRead; i = buf.indexOf(0x0a, i + 1)) count++;
      lastByte = buf[bytesRead - 1];
      total += bytesRead;
    }
    if (total === 0) return 0;
    return lastByte === 0x0a ? count : count + 1;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Untracked, non-ignored files with every line marked as added.
 * Binary files, symlinks, nested repositories and unreadable files are skipped.
 */
function getUntrackedFiles (cwd: string | undefined): FileDiff[] {
  // ls-files prints paths relative to the directory it runs in, while git diff prints
  // repo-root-relative paths, so list from the root to get matching paths for the whole repo.
  const root = runGit(['rev-parse', '--show-toplevel'], cwd, 'git rev-parse').trim();
  const output = runGit(['ls-files', '--others', '--exclude-standard', '-z'], root, 'git ls-files');

  const result: FileDiff[] = [];
  for (const relPath of output.split('\0')) {
    if (!relPath) continue;
    const fullPath = path.join(root, relPath);
    let lineCount: number | null;
    try {
      if (!fs.lstatSync(fullPath).isFile()) continue;
      lineCount = countTextLines(fullPath);
    } catch {
      continue;
    }
    if (lineCount === null || lineCount === 0) continue;

    const addedLines = new Set<number>();
    for (let i = 1; i <= lineCount; i++) addedLines.add(i);
    // ls-files -z output is repo-relative (we run it from the root) and never quoted.
    result.push({ filePath: relPath, addedLines, isNew: true });
  }
  return result;
}

/**
 * Return the lines added relative to the base, per file. Line numbers always refer to the
 * file as it is on disk now, because lcov is generated from the working tree.
 *
 * The base is `git merge-base <compareRef> HEAD` for "..." notation, or <compareRef> for "..".
 * Rather than running the committed, staged and unstaged diffs separately and merging their line
 * numbers (which gives wrong numbers when several of them touch one file), each mode uses one
 * diff against the base, then translates line numbers to the working tree when needed:
 *
 *   default (all changes):  git diff <base>                 (base → working tree)
 *   ignoreUnstaged:         git diff --cached <base>        (base → index), then mapped through
 *                           `git diff` (index → working tree)
 *   ignoreStaged + ignoreUnstaged:
 *                           git diff <base> HEAD            (base → HEAD), then mapped through
 *                           `git diff HEAD` (HEAD → working tree)
 *   ignoreStaged only:      no single git diff gives "committed + unstaged". Python diff-cover
 *                           applies the committed and unstaged diffs one after the other,
 *                           dropping "deleted" line numbers and adding "added" ones without
 *                           shifting the rest, so its line numbers drift whenever both touch one
 *                           file. Instead we take the default result (git diff <base>) and remove
 *                           the lines whose current content was written by a staged change: the
 *                           lines added by `git diff --cached HEAD`, mapped to the working tree
 *                           through `git diff`. Staged lines that were edited again later
 *                           (unstaged) count as unstaged changes and are kept.
 *
 * In the mapping steps, a line that an excluded change later rewrote or deleted is dropped,
 * because its current content comes from that excluded change. When the working tree is clean,
 * the mapping diffs are empty and every mode returns plain `git diff <base>` results.
 *
 * Known limitations:
 *   - ignoreStaged only: a line added by a commit and then modified by a staged change counts as
 *     staged and is excluded. Python counts it, at its HEAD line number.
 *   - With the user's git config diff.renames=false, the reported diffs follow that config (a
 *     renamed file is all new) but the staged and mapping diffs force rename detection. After a
 *     staged `git mv`, ignoreStaged alone therefore still reports every line of the renamed file,
 *     while ignoreStaged + ignoreUnstaged reports only its committed lines. This over-reports, so
 *     it can lower coverage but never hide an uncovered line. Forcing renames on the reported diff
 *     instead would make ignoreStaged differ from the default mode even with nothing staged.
 *
 * Uses spawnSync (no shell) to prevent command injection from user-supplied compareRef.
 * --diff-filter=ACMR skips deleted files.
 */
export function getGitDiff (
  compareRef: string,
  rangeNotation: RangeNotation = '...',
  options: GitDiffOptions = {}
): FileDiff[] {
  const { ignoreStaged = false, ignoreUnstaged = false, includeUntracked = false, cwd } = options;
  const hint = fetchHint(compareRef);
  const base = resolveDiffBase(compareRef, rangeNotation, cwd);

  let result: FileDiff[];
  if (!ignoreStaged && !ignoreUnstaged) {
    result = runChangesDiff([base], cwd, hint);
  } else if (!ignoreStaged && ignoreUnstaged) {
    result = runChangesDiff(['--cached', base], cwd, hint);
    if (result.length > 0) result = mapToWorktree(result, runMappingDiff([], cwd));
  } else if (ignoreStaged && ignoreUnstaged) {
    result = runChangesDiff([base, 'HEAD'], cwd, hint);
    if (result.length > 0) result = mapToWorktree(result, runMappingDiff(['HEAD'], cwd));
  } else {
    result = runChangesDiff([base], cwd, hint);
    // diff.renames=true so a staged `git mv` is not treated as a staged rewrite of every line.
    const staged = toFileDiffs(runMappingDiff(['--cached', 'HEAD'], cwd));
    if (result.length > 0 && staged.length > 0) {
      result = subtractLines(result, mapToWorktree(staged, runMappingDiff([], cwd)));
    }
  }

  if (includeUntracked) {
    const byPath = new Map(result.map(f => [f.filePath, f]));
    for (const file of getUntrackedFiles(cwd)) {
      const existing = byPath.get(file.filePath);
      if (existing === undefined) {
        result.push(file);
        byPath.set(file.filePath, file);
      } else {
        for (const line of file.addedLines) existing.addedLines.add(line);
      }
    }
  }

  return result;
}
