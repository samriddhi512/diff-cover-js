import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import parseDiff from 'parse-diff';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getGitDiff, GitDiffOptions, RangeNotation } from '../src/git-diff';

// ── Isolate git from the developer's global/system config ─────────────────────

let tmpRoot: string;
const savedEnv: Record<string, string | undefined> = {};
const ISOLATION_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

beforeAll(() => {
  // realpath: on macOS os.tmpdir() is a symlink, while git reports the resolved path.
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diff-cover-js-git-')));
  const globalConfig = path.join(tmpRoot, 'gitconfig');
  fs.writeFileSync(globalConfig, '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  for (const [key, value] of Object.entries({ ...ISOLATION_ENV, GIT_CONFIG_GLOBAL: globalConfig })) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function git (cwd: string, ...args: string[]): string {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (proc.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr}`);
  }
  return proc.stdout;
}

function write (repo: string, file: string, lines: string[] | string): void {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Array.isArray(lines) ? lines.join('\n') + '\n' : lines);
}

function read (repo: string, file: string): string[] {
  return fs.readFileSync(path.join(repo, file), 'utf8').split('\n');
}

const BASE_A = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10'];
// a.ts on the feature branch: "c1" committed after L2, so it is line 3.
const HEAD_A = ['L1', 'L2', 'c1', ...BASE_A.slice(2)];

let counter = 0;

/**
 * main:     a.ts (L1..L10), b.ts (b1..b5), .gitignore
 * feature:  branches from main, commits "c1" as line 3 of a.ts
 * main:     then advances, changing b.ts line 2 (b2 → B2)
 * HEAD is feature, with a clean working tree.
 */
function makeRepo (): string {
  const repo = path.join(tmpRoot, `repo-${counter++}`);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'checkout', '-q', '-b', 'main');
  write(repo, 'a.ts', BASE_A);
  write(repo, 'b.ts', ['b1', 'b2', 'b3', 'b4', 'b5']);
  write(repo, '.gitignore', ['ignored.ts']);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');

  git(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'a.ts', HEAD_A);
  git(repo, 'commit', '-q', '-am', 'feature work');

  git(repo, 'checkout', '-q', 'main');
  write(repo, 'b.ts', ['b1', 'B2', 'b3', 'b4', 'b5']);
  git(repo, 'commit', '-q', '-am', 'main moves on');
  git(repo, 'checkout', '-q', 'feature');
  return repo;
}

type Summary = Record<string, number[]>;

function diff (repo: string, options: GitDiffOptions = {}, notation: RangeNotation = '...', ref = 'main'): Summary {
  const result: Summary = {};
  for (const file of getGitDiff(ref, notation, { cwd: repo, ...options })) {
    result[file.filePath] = [...file.addedLines].sort((a, b) => a - b);
  }
  return result;
}

const MODES: Array<[string, GitDiffOptions]> = [
  ['default', {}],
  ['ignoreStaged', { ignoreStaged: true }],
  ['ignoreUnstaged', { ignoreUnstaged: true }],
  ['ignoreStaged + ignoreUnstaged', { ignoreStaged: true, ignoreUnstaged: true }],
];

/** The pre-change implementation: `git diff <ref>...HEAD`, added lines per file. */
function legacyDiff (repo: string, ref: string, notation: RangeNotation): Summary {
  const out = git(repo, '-c', 'diff.noprefix=no', '-c', 'diff.mnemonicprefix=no', '-c', 'core.quotePath=false',
    'diff', `${ref}${notation}HEAD`, '--unified=0', '--diff-filter=ACMR', '--no-color', '--no-ext-diff');
  const result: Summary = {};
  for (const file of parseDiff(out)) {
    const lines = file.chunks.flatMap(c => c.changes).filter(c => c.type === 'add').map(c => (c as { ln: number }).ln);
    if (lines.length > 0) result[file.to as string] = lines.sort((a, b) => a - b);
  }
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getGitDiff', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  describe('committed changes only (clean working tree)', () => {
    it.each(MODES)('%s reports only the committed line', (_name, options) => {
      expect(diff(repo, options)).toEqual({ 'a.ts': [3] });
    });

    it.each(['...', '..'] as RangeNotation[])('default output matches the old `git diff ref%sHEAD` output', notation => {
      expect(diff(repo, {}, notation)).toEqual(legacyDiff(repo, 'main', notation));
    });

    it('works without an options argument (backward compatible signature)', () => {
      const cwd = process.cwd();
      process.chdir(repo);
      try {
        const files = getGitDiff('main');
        expect(files.map(f => f.filePath)).toEqual(['a.ts']);
        expect(getGitDiff('main', '..').map(f => f.filePath).sort()).toEqual(['a.ts', 'b.ts']);
      } finally {
        process.chdir(cwd);
      }
    });
  });

  describe('range notation', () => {
    it('"..." diffs against the merge base, ignoring later changes on the compare branch', () => {
      expect(diff(repo, {}, '...')).toEqual({ 'a.ts': [3] });
    });

    it('".." diffs against the compare ref itself, so its newer changes show up', () => {
      expect(diff(repo, {}, '..')).toEqual({ 'a.ts': [3], 'b.ts': [2] });
    });

    it('".." includes uncommitted changes too', () => {
      write(repo, 'b.ts', ['b1', 'b2', 'b3', 'b4', 'b5', 'u']);
      expect(diff(repo, {}, '..')).toEqual({ 'a.ts': [3], 'b.ts': [2, 6] });
      expect(diff(repo, { ignoreUnstaged: true }, '..')).toEqual({ 'a.ts': [3], 'b.ts': [2] });
    });
  });

  describe('staged change', () => {
    beforeEach(() => {
      write(repo, 'a.ts', [...HEAD_A, 's1']); // s1 is line 12
      git(repo, 'add', 'a.ts');
    });

    it.each<[string, GitDiffOptions, Summary]>([
      ['default', {}, { 'a.ts': [3, 12] }],
      ['ignoreStaged', { ignoreStaged: true }, { 'a.ts': [3] }],
      ['ignoreUnstaged', { ignoreUnstaged: true }, { 'a.ts': [3, 12] }],
      ['ignoreStaged + ignoreUnstaged', { ignoreStaged: true, ignoreUnstaged: true }, { 'a.ts': [3] }],
    ])('%s', (_name, options, expected) => {
      expect(diff(repo, options)).toEqual(expected);
    });

    it('a new staged file is included unless staged changes are ignored', () => {
      write(repo, 'new.ts', ['n1', 'n2']);
      git(repo, 'add', 'new.ts');
      const files = getGitDiff('main', '...', { cwd: repo });
      expect(files.find(f => f.filePath === 'new.ts')).toEqual({ filePath: 'new.ts', addedLines: new Set([1, 2]), isNew: true });
      expect(diff(repo, { ignoreStaged: true })).toEqual({ 'a.ts': [3] });
    });
  });

  describe('unstaged change', () => {
    beforeEach(() => {
      write(repo, 'a.ts', ['u1', ...HEAD_A]); // u1 is line 1, c1 moves to line 4
    });

    it.each<[string, GitDiffOptions, Summary]>([
      ['default', {}, { 'a.ts': [1, 4] }],
      ['ignoreStaged', { ignoreStaged: true }, { 'a.ts': [1, 4] }],
      // c1 is reported where it is on disk (line 4), not where it is in the index (line 3)
      ['ignoreUnstaged', { ignoreUnstaged: true }, { 'a.ts': [4] }],
      ['ignoreStaged + ignoreUnstaged', { ignoreStaged: true, ignoreUnstaged: true }, { 'a.ts': [4] }],
    ])('%s', (_name, options, expected) => {
      expect(diff(repo, options)).toEqual(expected);
    });

    it('maps line numbers through unstaged deletions and replacements', () => {
      // Delete L1, replace L5 with X, append u-end.
      // On disk: L2 c1 L3 L4 X L6 L7 L8 L9 L10 u-end
      write(repo, 'a.ts', ['L2', 'c1', 'L3', 'L4', 'X', 'L6', 'L7', 'L8', 'L9', 'L10', 'u-end']);
      expect(diff(repo)).toEqual({ 'a.ts': [2, 5, 11] });
      expect(diff(repo, { ignoreStaged: true })).toEqual({ 'a.ts': [2, 5, 11] });
      expect(diff(repo, { ignoreUnstaged: true })).toEqual({ 'a.ts': [2] });
      expect(diff(repo, { ignoreStaged: true, ignoreUnstaged: true })).toEqual({ 'a.ts': [2] });
    });

    it('drops a file deleted in the working tree', () => {
      fs.rmSync(path.join(repo, 'a.ts'));
      for (const [, options] of MODES) {
        expect(diff(repo, options)).toEqual({});
      }
    });
  });

  describe('staged and unstaged edits to the same file', () => {
    beforeEach(() => {
      // Staged: s1 after L1. Then unstaged: u1 at the top.
      write(repo, 'a.ts', ['L1', 's1', ...HEAD_A.slice(1)]);
      git(repo, 'add', 'a.ts');
      write(repo, 'a.ts', ['u1', 'L1', 's1', ...HEAD_A.slice(1)]);
      // On disk: u1=1, L1=2, s1=3, L2=4, c1=5
    });

    it.each<[string, GitDiffOptions, string[]]>([
      ['default', {}, ['u1', 's1', 'c1']],
      ['ignoreStaged', { ignoreStaged: true }, ['u1', 'c1']],
      ['ignoreUnstaged', { ignoreUnstaged: true }, ['s1', 'c1']],
      ['ignoreStaged + ignoreUnstaged', { ignoreStaged: true, ignoreUnstaged: true }, ['c1']],
    ])('%s: line numbers point at the right lines on disk', (_name, options, expectedContent) => {
      const result = diff(repo, options);
      const onDisk = read(repo, 'a.ts');
      expect(Object.keys(result)).toEqual(['a.ts']);
      expect(result['a.ts'].map(n => onDisk[n - 1])).toEqual(expectedContent);
    });

    it('default reports lines 1, 3 and 5 (not the union of per-stage line numbers)', () => {
      expect(diff(repo)).toEqual({ 'a.ts': [1, 3, 5] });
    });

    it('a staged line edited again in the working tree counts as unstaged', () => {
      write(repo, 'a.ts', ['u1', 'L1', 's1-edited', ...HEAD_A.slice(1)]);
      expect(diff(repo, { ignoreStaged: true })).toEqual({ 'a.ts': [1, 3, 5] });
      expect(diff(repo, { ignoreUnstaged: true })).toEqual({ 'a.ts': [5] });
    });
  });

  describe('staged rename', () => {
    beforeEach(() => {
      git(repo, 'mv', 'a.ts', 'renamed.ts');
    });

    it.each(MODES)('%s reports the committed line under the new path', (_name, options) => {
      expect(diff(repo, options)).toEqual({ 'renamed.ts': [3] });
    });

    // Known limitation, documented in getGitDiff and the README: with diff.renames=false the
    // reported diff sees the renamed file as new, while the internal staged/mapping diffs force
    // rename detection. So --ignore-staged over-reports (every line) and the two ignore modes
    // disagree. Over-reporting is the safe direction for a coverage gate: it never hides lines.
    it('with diff.renames=false: known limitation, --ignore-staged over-reports a staged rename', () => {
      git(repo, 'config', 'diff.renames', 'false');
      const allLines = HEAD_A.map((_, i) => i + 1);
      // The reported diff follows the user's config: without rename detection the file is new.
      expect(diff(repo)).toEqual({ 'renamed.ts': allLines });
      expect(diff(repo, { ignoreStaged: true })).toEqual({ 'renamed.ts': allLines });
      // HEAD's a.ts lines are mapped to renamed.ts on disk instead of being dropped.
      expect(diff(repo, { ignoreStaged: true, ignoreUnstaged: true })).toEqual({ 'renamed.ts': [3] });
    });
  });

  describe('untracked files', () => {
    beforeEach(() => {
      write(repo, 'new.ts', ['n1', 'n2', 'n3']);
      write(repo, 'dir/no-newline.ts', 'x1\nx2');
      write(repo, 'empty.ts', '');
      write(repo, 'ignored.ts', ['should not appear']);
      fs.writeFileSync(path.join(repo, 'binary.dat'), Buffer.from([0x61, 0x00, 0x0a, 0x62]));
    });

    it('are excluded by default', () => {
      expect(diff(repo)).toEqual({ 'a.ts': [3] });
    });

    it('are included with includeUntracked: every line added, isNew true; binary/empty/ignored skipped', () => {
      const files = getGitDiff('main', '...', { cwd: repo, includeUntracked: true });
      const byPath = Object.fromEntries(files.map(f => [f.filePath, f]));

      expect(Object.keys(byPath).sort()).toEqual(['a.ts', 'dir/no-newline.ts', 'new.ts']);
      expect(byPath['new.ts']).toEqual({ filePath: 'new.ts', addedLines: new Set([1, 2, 3]), isNew: true });
      expect(byPath['dir/no-newline.ts'].addedLines).toEqual(new Set([1, 2]));
      expect(byPath['a.ts'].isNew).toBe(false);
    });

    it('are reported with repo-root-relative paths when run from a subdirectory', () => {
      const files = getGitDiff('main', '...', { cwd: path.join(repo, 'dir'), includeUntracked: true });
      expect(files.map(f => f.filePath).sort()).toEqual(['a.ts', 'dir/no-newline.ts', 'new.ts']);
    });

    it('counts lines of a large file read in chunks, without a trailing newline', () => {
      // 70,001 lines over ~490 KB: crosses several 64 KB read chunks.
      const lines = Array.from({ length: 70001 }, (_, i) => `line${i}`);
      write(repo, 'big.ts', lines.join('\n'));
      const big = getGitDiff('main', '...', { cwd: repo, includeUntracked: true }).find(f => f.filePath === 'big.ts');
      expect(big?.addedLines.size).toBe(70001);
      expect(big?.addedLines.has(70001)).toBe(true);
    });

    it.each(MODES)('are included independently of %s', (_name, options) => {
      expect(diff(repo, { ...options, includeUntracked: true })).toEqual({
        'a.ts': [3],
        'dir/no-newline.ts': [1, 2],
        'new.ts': [1, 2, 3],
      });
    });
  });

  describe('paths under a top-level a/ or b/ directory', () => {
    it('are reported unchanged (the diff prefix is stripped only once)', () => {
      write(repo, 'b/foo.ts', ['f1', 'f2']);
      git(repo, 'add', 'b/foo.ts');
      git(repo, 'commit', '-q', '-m', 'add b/foo.ts');
      write(repo, 'a/untracked.ts', ['u1']);

      expect(diff(repo, { includeUntracked: true })).toEqual({
        'a.ts': [3],
        'b/foo.ts': [1, 2],
        'a/untracked.ts': [1],
      });
    });
  });

  describe('errors', () => {
    it("shows git's own error when git itself fails, not a fetch hint", () => {
      const notARepo = path.join(tmpRoot, `not-a-repo-${counter++}`);
      fs.mkdirSync(notARepo);
      // GIT_CEILING_DIRECTORIES stops git from finding a repository in a parent directory.
      const saved = process.env.GIT_CEILING_DIRECTORIES;
      process.env.GIT_CEILING_DIRECTORIES = tmpRoot;
      try {
        let message = '';
        try {
          getGitDiff('main', '...', { cwd: notARepo });
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toMatch(/git rev-parse exited with code \d+: .*not a git repository/);
        expect(message).not.toMatch(/is fetched/);
      } finally {
        if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
        else process.env.GIT_CEILING_DIRECTORIES = saved;
      }
    });

    it('explains that a missing ref needs fetching', () => {
      expect(() => diff(repo, {}, '...', 'origin/does-not-exist'))
        .toThrow(/Could not resolve "origin\/does-not-exist"[\s\S]*Make sure "origin\/does-not-exist" is fetched/);
      expect(() => diff(repo, {}, '..', 'origin/does-not-exist')).toThrow(/is fetched/);
    });

    it('explains a missing merge base for "..." and still allows ".."', () => {
      git(repo, 'checkout', '-q', '--orphan', 'unrelated');
      git(repo, 'commit', '-q', '-m', 'unrelated history');
      git(repo, 'checkout', '-q', 'feature');

      expect(() => diff(repo, {}, '...', 'unrelated')).toThrow(/No merge base found between "unrelated" and HEAD/);
      expect(() => diff(repo, {}, '..', 'unrelated')).not.toThrow();
    });

    it('explains a missing merge base in a shallow clone', () => {
      const clone = path.join(tmpRoot, `shallow-${counter++}`);
      git(tmpRoot, 'clone', '-q', '--depth', '1', '--branch', 'feature', `file://${repo}`, clone);
      git(clone, 'fetch', '-q', '--depth', '1', 'origin', 'main:refs/remotes/origin/main');

      expect(() => diff(clone, {}, '...', 'origin/main')).toThrow(/shallow clone[\s\S]*is fetched/);
    });

    it('rejects a ref that looks like an option', () => {
      expect(() => diff(repo, {}, '...', `--output=${tmpRoot}/pwned`)).toThrow(/cannot start with "-"/);
    });

    it('rejects an invalid range notation', () => {
      expect(() => diff(repo, {}, '.' as RangeNotation)).toThrow(/Invalid diff range notation/);
    });
  });
});
