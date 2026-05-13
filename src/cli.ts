#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { getGitDiff, RangeNotation } from './git-diff';
import { parseLcov } from './lcov-parser';
import { calculateDiffCoverage } from './calculator';
import { printReport } from './reporter';
import { parseFormatOption, writeFormats } from './report-generator';
import { loadConfig, DiffCoverConfig } from './config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('diff-cover-js')
  .description(
    'Diff-aware test coverage: reports coverage only for lines you changed,\n' +
    'not the entire file. JS/TS equivalent of Python diff-cover.'
  )
  .version(version)

  // Both use .option (not .requiredOption) so config-file values can satisfy them.
  // Manual validation after config merge replaces Commander's built-in enforcement.
  .option('--lcov <path>', 'Path to lcov.info coverage file')
  .option('--compare-branch <ref>', 'Git branch or ref to compare against (e.g. origin/main, FETCH_HEAD)')

  // No defaults here — defaults would silently shadow config-file values.
  // Defaults are applied after config merge below.
  .option('--format <formats>', 'Output formats: html, json, markdown — with optional paths')
  .option('--fail-under <percent>', 'Exit with code 1 if diff coverage is below this percentage')
  .option('--diff-range-notation <notation>', 'Git diff range notation: "..." (symmetric) or ".." (simple)')

  .option('--exclude <patterns...>', 'Additional glob patterns to exclude (test files excluded by default)')
  .option('--no-default-excludes', 'Do not apply the built-in test/spec/.d.ts file exclusions')
  .option('--strict', 'Count files missing from coverage data as 0% covered')
  // Boolean flags (.option without <value>) are undefined when absent, true when present — safe to use directly.
  .option('-q, --quiet', 'Suppress the console report — only print errors and the final percentage')
  .option('-c, --config-file <path>', 'Path to .diff-cover-js.json config file (auto-discovered if omitted)')

  .action((cliOptions) => {
    // ── Load config file ───────────────────────────────────────────────────
    let fileConfig: DiffCoverConfig = {};
    if (cliOptions.configFile) {
      if (!fs.existsSync(cliOptions.configFile)) {
        console.error(`❌ Config file not found: ${cliOptions.configFile}`);
        process.exit(1);
      }
      try {
        fileConfig = JSON.parse(fs.readFileSync(cliOptions.configFile, 'utf8')) as DiffCoverConfig;
      } catch (err) {
        console.error(`❌ Could not parse config file: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    } else {
      fileConfig = loadConfig();
    }

    // ── Merge: config file provides defaults, CLI always wins ──────────────
    // For string options, Commander leaves them undefined when not passed, so
    // ?? correctly falls through to the config file value then the hardcoded default.
    //
    // For boolean flags (.option without <value>), Commander sets true when
    // passed and leaves undefined when absent — so cliOptions.quiet === true
    // is a reliable "was this flag passed?" check, no argv.includes() needed.
    const lcovPath      = cliOptions.lcov          ?? fileConfig.lcov;
    const compareRef    = cliOptions.compareBranch  ?? fileConfig.compareBranch;
    const failUnder     = parseFloat(String(cliOptions.failUnder  ?? fileConfig.failUnder  ?? 0));
    if (isNaN(failUnder)) {
      console.error('❌ --fail-under must be a number (e.g. 80 or 80.5)');
      process.exit(1);
    }
    const rangeNotation = (cliOptions.diffRangeNotation ?? fileConfig.diffRangeNotation ?? '...') as RangeNotation;
    const formatRaw     = cliOptions.format         ?? fileConfig.format ?? '';
    const quiet             = cliOptions.quiet   === true || fileConfig.quiet   === true;
    const strict            = cliOptions.strict  === true || fileConfig.strict  === true;
    // Commander --no-default-excludes sets cliOptions.defaultExcludes = false when the flag is passed,
    // true when absent. So false means the user explicitly opted out of default exclusions.
    const noDefaultExcludes = cliOptions.defaultExcludes === false || fileConfig.noDefaultExcludes === true;
    const extraExcludes     = [...(cliOptions.exclude ?? []), ...(fileConfig.exclude ?? [])];
    const formats           = parseFormatOption(formatRaw);

    // ── Validate required values ───────────────────────────────────────────
    if (!lcovPath) {
      console.error('❌ --lcov is required (or set "lcov" in .diff-cover-js.json)');
      process.exit(1);
    }
    if (!compareRef) {
      console.error('❌ --compare-branch is required (or set "compareBranch" in .diff-cover-js.json)');
      process.exit(1);
    }
    if (!['...', '..'].includes(rangeNotation)) {
      console.error('❌ --diff-range-notation must be "..." or ".."');
      process.exit(1);
    }

    // ── Get git diff ───────────────────────────────────────────────────────
    let diffs;
    try {
      diffs = getGitDiff(compareRef, rangeNotation);
    } catch (err: unknown) {
      console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // ── Parse lcov ────────────────────────────────────────────────────────
    const resolvedLcov = path.resolve(lcovPath);
    let lcovData;
    try {
      lcovData = parseLcov(resolvedLcov);
    } catch (err: unknown) {
      console.error(`❌ Could not read lcov file at ${resolvedLcov}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // ── Calculate ──────────────────────────────────────────────────────────
    const result = calculateDiffCoverage(diffs, lcovData, { strict, exclude: extraExcludes, noDefaultExcludes });

    // ── Console report ────────────────────────────────────────────────────
    if (!quiet) {
      printReport(result);
    } else {
      console.log(`Diff coverage: ${result.overallPercent}%`);
    }

    // ── Write file reports (pass failUnder so HTML colours match threshold) ─
    if (Object.keys(formats).length > 0) {
      writeFormats(formats, result, compareRef, failUnder);
    }

    // ── Fail-under check ──────────────────────────────────────────────────
    if (failUnder > 0 && result.overallPercent < failUnder) {
      console.error(`❌ Failure. Diff coverage ${result.overallPercent}% is below ${failUnder}%`);
      process.exit(1);
    }
  });

program.parse(process.argv);
