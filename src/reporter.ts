import { DiffCoverageResult } from './calculator';

const LINE = '─'.repeat(64);

export function printReport (result: DiffCoverageResult): void {
  console.log(`\n${LINE}`);
  console.log('  diff-cover-js  ·  Diff Coverage Report');
  console.log(`${LINE}\n`);

  if (result.files.length === 0 && result.missingFromLcov.length === 0) {
    console.log('  No changed source files found in the diff.\n');
  }

  // Track which missing files are already shown in the files list (strict mode)
  // to avoid printing them twice in the "missing" section below.
  const shownAsStrict = new Set(
    result.files.filter(f => !f.inLcov).map(f => f.filePath)
  );

  for (const file of result.files) {
    const pct = `${file.coveragePercent}%`.padStart(4);

    if (!file.inLcov && file.coverableAddedLines === 0) {
      // Strict mode, but only blank/comment lines changed: nothing to cover.
      console.log(`  ✓  ${file.filePath}`);
      console.log(`       ${pct} diff coverage  (not in coverage data, no code lines changed)`);
    } else if (!file.inLcov) {
      console.log(`  ✗  ${file.filePath}`);
      console.log(`       ${pct} diff coverage  (not in coverage data, ${file.coverableAddedLines} code lines treated as uncovered)`);
      if (file.uncoveredLineNumbers.length > 0) {
        console.log(`       Missing lines: ${file.uncoveredLineNumbers.join(', ')}`);
      }
    } else {
      const icon = file.coveragePercent === 100 ? '✓' : '✗';
      console.log(`  ${icon}  ${file.filePath}`);
      console.log(
        `       ${pct} diff coverage` +
        `  (${file.coveredLines}/${file.coverableAddedLines} coverable changed lines)`
      );
      if (file.uncoveredLineNumbers.length > 0) {
        console.log(`       Missing lines: ${file.uncoveredLineNumbers.join(', ')}`);
      }
    }
    // `!= null` (not `!== null`): a result built by hand in the 0.2.0 shape has no branch fields at all.
    if (file.branchPercent != null) {
      console.log(
        `       ${`${file.branchPercent}%`.padStart(4)} branch coverage` +
        `  (${file.coveredBranches}/${file.coverableBranches} branches on changed lines)`
      );
      if (file.partialBranchLines?.length > 0) {
        console.log(`       Partially covered branches: ${file.partialBranchLines.join(', ')}`);
      }
    }
    console.log();
  }

  // Only list files that are genuinely missing (not already shown above via --strict)
  const missingToShow = result.missingFromLcov.filter(f => !shownAsStrict.has(f));
  if (missingToShow.length > 0) {
    console.log('  ℹ  Changed files not collected for coverage (pass --strict to fail on these):');
    for (const f of missingToShow) {
      console.log(`       ${f}`);
    }
    console.log();
  }

  console.log(LINE);
  const pct = `${result.overallPercent}%`;
  console.log(`  Overall diff coverage: ${pct}`);
  console.log(`  ${result.totalCovered}/${result.totalCoverable} coverable changed lines covered`);
  if (result.overallBranchPercent != null) {
    console.log(`  Overall branch coverage: ${result.overallBranchPercent}%`);
    console.log(`  ${result.totalCoveredBranches}/${result.totalBranches} branches on changed lines covered`);
  }
  console.log(`${LINE}\n`);
}
