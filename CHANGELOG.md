# Changelog

## 0.2.0

### Breaking

- **Staged and unstaged changes are now counted by default**, as Python diff-cover does. 0.1.x only counted committed changes (`git diff <compare-branch>...HEAD`). With a clean checkout the output is unchanged. If your CI modifies tracked files before running diff-cover-js, those edits are now counted. Pass `--ignore-staged --ignore-unstaged` to get the 0.1.x behaviour.

### Added

- `--ignore-staged`, `--ignore-unstaged` and `--include-untracked` flags, the matching `ignoreStaged`, `ignoreUnstaged` and `includeUntracked` config keys, and an optional third `options` argument to `getGitDiff()`. Reported line numbers always match the file on disk.
- `mergeLcovCoverage()` and `toRepoRelativePath()` exports.
- Clearer errors when the merge base can't be found (shallow clone, unrelated histories) and when git itself fails (not a repository, `safe.directory`).

### Fixed

- Several `SF:` blocks for the same file (Jest multi-project, concatenated or sharded lcov) are merged by adding hit counts. Before, the last block won, so lines could be reported as uncovered.
- lcov paths that differ but resolve to the same file (e.g. absolute and relative) are merged too.
- Files under a top-level `a/` or `b/` directory were reported without that directory (`b/foo.ts` became `foo.ts`).
- A compare ref starting with `-` is rejected instead of being passed to git, where it could be read as an option.

### Known issues

- With `--strict`, blank and comment lines in changed files that are missing from lcov are counted as uncovered, so they lower the percentage. Only code lines should count. Fixed in 0.2.1.
