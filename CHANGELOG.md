# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The npm "Homepage" link now points to the documentation site, https://samriddhi512.github.io/diff-cover-js/, which has guides for Jest, Vitest and GitHub Actions.

## [0.3.1] - 2026-11-19

### Removed

- The package no longer includes source maps (`dist/*.js.map`, `dist/*.d.ts.map`). They pointed to `src/*.ts`, which was never published. With `node --enable-source-maps`, stack traces named `.ts` files that weren't on disk, and webpack's `source-map-loader` warned that it couldn't load them. Stack traces now point to `dist/*.js`. The unpacked package is about a third smaller: 21 files instead of 39.

### Changed

- `npm run build` deletes `dist/` before compiling, so files left over from earlier builds can no longer be published.

## [0.3.0] - 2026-11-18

### Breaking (TypeScript types)

- Library API types that can break TypeScript code that builds these objects by hand: `FileStats` gains required `coverableBranches`, `coveredBranches`, `branchPercent` and `partialBranchLines`. `DiffCoverageResult` gains required `totalBranches`, `totalCoveredBranches` and `overallBranchPercent`. `SrcStats` and `ReportDict` gain the branch fields listed above. Results returned by `calculateDiffCoverage()` need no change, and `printReport()` accepts a result without branch fields.

### Added

- **Branch coverage on changed lines.** lcov `BRDA` records are parsed. The console and JSON reports show "branch coverage" next to line coverage, and the console report lists the lines where a branch was never taken. The Markdown and HTML reports don't show branch data yet. It counts the branches on added lines that were taken at least once. It is a separate figure: line coverage and `--fail-under` are unchanged. A branch with `-` in lcov counts as untaken. JSON gains `coverableBranches`, `coveredBranches`, `percentBranchesCovered` per file and `totalNumBranches`, `totalNumCoveredBranches`, `totalPercentBranchesCovered` at the top level.
- `readSource` option for `calculateDiffCoverage()`, to supply file contents in `--strict` mode instead of reading the working tree.
- `LcovFileCoverage` gains an optional `branches` map, and the `LineBranches` type is exported.

### Changed

- Overall diff coverage with `--strict` can be higher than in 0.2.0, because comment and blank lines no longer count as uncovered. If CI checks the exact percentage or uses `--fail-under`, check the threshold again.
- Console wording for a file missing from coverage data in `--strict` mode: "all N changed lines treated as uncovered" is now "N code lines treated as uncovered". Check any script that matches this text.
- `mergeLcovCoverage()` now merges branch data as well as line data.

### Fixed

- With `--strict`, blank and comment lines in changed files missing from lcov no longer count as uncovered. The source is read from the repo working tree and non-code lines are skipped. A line with code after a comment (e.g. `/** @type {X} */ const a = foo();`) is code. A file where only blank or comment lines changed has nothing to cover. It shows as ✓ 100% in the console, `percentCovered: null` in JSON, `(100%): Not in coverage data, no code lines changed` in Markdown and `N/A (not collected)` in HTML, like a file in lcov with no coverable changed lines. If the source can't be read, every added line counts, as before. If you compare against an older ref and the file has changed since, the skipped lines may be off. A block comment opened after code on the same line (`foo(); /* note`) isn't detected, so the lines after it count as code.

## [0.2.0] - 2026-11-16

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

## [0.1.0] - 2026-05-13

### Added

- Initial release. Diff coverage from `lcov.info`: reports test coverage only for the lines added in a git diff against `--compare-branch`.
- `--fail-under`, `--strict`, `--exclude`, `--no-default-excludes`, `--diff-range-notation`, `--quiet` and `--config-file` flags.
- Console, HTML, JSON and Markdown reports (`--format`).
- `.diff-cover-js.json` config file.

[Unreleased]: https://github.com/samriddhi512/diff-cover-js/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/samriddhi512/diff-cover-js/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/samriddhi512/diff-cover-js/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/samriddhi512/diff-cover-js/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/samriddhi512/diff-cover-js/releases/tag/v0.1.0
