export { getGitDiff } from './git-diff';
export { parseLcov, mergeLcovCoverage } from './lcov-parser';
export { calculateDiffCoverage, DEFAULT_EXCLUDES } from './calculator';
export { printReport } from './reporter';
export { normalizePath, toRepoRelativePath, findRepoRoot, clearRepoRootCache } from './path-utils';
export {
  generateJsonReport,
  generateMarkdownReport,
  generateHtmlReport,
  buildReportDict,
  combineAdjacentLines,
  parseFormatOption,
  writeFormats,
} from './report-generator';
export { loadConfig } from './config';

export type { FileDiff, RangeNotation, GitDiffOptions } from './git-diff';
export type { LcovFileCoverage, LineBranches } from './lcov-parser';
export type { FileStats, DiffCoverageResult, CalculatorOptions } from './calculator';
export type { ReportDict, SrcStats } from './report-generator';
export type { DiffCoverConfig } from './config';
