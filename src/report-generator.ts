import fs from 'fs';
import path from 'path';
import { DiffCoverageResult } from './calculator';

// ─── Shared data structure (mirrors diff-cover's report_dict()) ───────────────

export interface SrcStats {
  percentCovered: number | null;
  /** Raw uncovered line numbers — matches diff-cover's integer-array JSON schema */
  violationLines: number[];
  coveredLines: number[];
  coverableLines: number;
  /** True when the file was in the diff but had no lcov entry (strict mode) */
  missingFromLcov: boolean;
}

export interface ReportDict {
  diffName: string;
  srcStats: Record<string, SrcStats>;
  totalNumLines: number;
  totalNumViolations: number;
  totalPercentCovered: number;
  numChangedLines: number;
}

/**
 * Collapse adjacent line numbers into range strings.
 * [1, 2, 5, 6, 100] → ["1-2", "5-6", "100"]
 * Mirrors diff-cover's TemplateReportGenerator.combine_adjacent_lines()
 */
export function combineAdjacentLines (lineNumbers: number[]): string[] {
  if (lineNumbers.length === 0) return [];
  const sorted = [...lineNumbers].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? String(start) : `${start}-${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges;
}

export function buildReportDict (result: DiffCoverageResult, diffName: string): ReportDict {
  const srcStats: Record<string, SrcStats> = {};

  for (const file of result.files) {
    // Include strict-mode files (inLcov: false) so JSON/HTML/Markdown are
    // consistent with the console report — both show these files at 0%.
    srcStats[file.filePath] = {
      percentCovered: file.inLcov
        ? (file.coverableAddedLines === 0 ? null : file.coveragePercent)
        : 0,
      violationLines: file.uncoveredLineNumbers,
      coveredLines: file.coveredLineNumbers,
      coverableLines: file.coverableAddedLines,
      missingFromLcov: !file.inLcov,
    };
  }

  return {
    diffName,
    srcStats,
    totalNumLines: result.totalCoverable,
    totalNumViolations: result.totalCoverable - result.totalCovered,
    totalPercentCovered: result.overallPercent,
    numChangedLines: result.totalAdded,
  };
}

// ─── JSON Report (mirrors JsonReportGenerator) ────────────────────────────────

export function generateJsonReport (result: DiffCoverageResult, diffName: string): string {
  return JSON.stringify(buildReportDict(result, diffName), null, 2);
}

// ─── Markdown Report (mirrors MarkdownReportGenerator) ────────────────────────

export function generateMarkdownReport (result: DiffCoverageResult, diffName: string): string {
  const dict = buildReportDict(result, diffName);
  const entries = Object.entries(dict.srcStats).sort(([a], [b]) => a.localeCompare(b));

  const fileLines = entries.map(([srcPath, stats]) => {
    if (stats.missingFromLcov) {
      return `- ${srcPath} (0%): Not in coverage data`;
    }
    if (stats.percentCovered === null || stats.percentCovered === 100) {
      return `- ${srcPath} (100%)`;
    }
    const missing = combineAdjacentLines(stats.violationLines).join(', ');
    return `- ${srcPath} (${stats.percentCovered}%): Missing lines ${missing}`;
  });

  const noData = entries.length === 0;
  const lineWord = (n: number) => n === 1 ? 'line' : 'lines';

  return [
    '# Diff Coverage',
    `## Diff: ${dict.diffName}`,
    '',
    noData
      ? 'No lines with coverage information in this diff.'
      : fileLines.join('\n'),
    '',
    ...(noData ? [] : [
      '## Summary',
      '',
      `- **Total**: ${dict.totalNumLines} ${lineWord(dict.totalNumLines)}`,
      `- **Missing**: ${dict.totalNumViolations} ${lineWord(dict.totalNumViolations)}`,
      `- **Coverage**: ${dict.totalPercentCovered}%`,
    ]),
  ].join('\n');
}

// ─── HTML Report (mirrors HtmlReportGenerator) ────────────────────────────────

/**
 * @param failUnder - the --fail-under threshold, used to colour the summary green/red.
 *                    Defaults to 0 (always green) when not provided.
 */
export function generateHtmlReport (
  result: DiffCoverageResult,
  diffName: string,
  failUnder = 0
): string {
  const dict = buildReportDict(result, diffName);
  const entries = Object.entries(dict.srcStats).sort(([a], [b]) => a.localeCompare(b));
  const noData = entries.length === 0;
  const lineWord = (n: number) => n === 1 ? 'line' : 'lines';

  const tableRows = entries.map(([srcPath, stats]) => {
    let pct: string;
    let pctColor: string;

    if (stats.missingFromLcov) {
      pct = '0% (not collected)';
      pctColor = '#c0392b';
    } else if (stats.percentCovered === null) {
      pct = 'N/A';
      pctColor = '#888';
    } else {
      pct = `${stats.percentCovered}%`;
      pctColor = stats.percentCovered === 100 ? '#27ae60' : '#c0392b';
    }

    const missing = stats.violationLines.length > 0
      ? `<span style="color:#c0392b">${combineAdjacentLines(stats.violationLines).join(', ')}</span>`
      : '&nbsp;';

    return `
      <tr>
        <td style="padding:6px 12px;font-family:monospace">${escapeHtml(srcPath)}</td>
        <td style="padding:6px 12px;color:${pctColor};font-weight:bold;text-align:center">${pct}</td>
        <td style="padding:6px 12px;font-family:monospace;font-size:0.9em">${missing}</td>
      </tr>`;
  }).join('');

  // Use --fail-under threshold for summary colour, not a hardcoded 80%
  const summaryColor = dict.totalPercentCovered >= failUnder ? '#27ae60' : '#c0392b';

  const summary = noData
    ? '<p style="color:#666">No lines with coverage information in this diff.</p>'
    : `
      <ul>
        <li><b>Total</b>: ${dict.totalNumLines} ${lineWord(dict.totalNumLines)}</li>
        <li><b>Missing</b>: ${dict.totalNumViolations} ${lineWord(dict.totalNumViolations)}</li>
        <li><b>Coverage</b>: <span style="font-weight:bold;color:${summaryColor}">${dict.totalPercentCovered}%</span></li>
      </ul>`;

  const table = noData ? '' : `
    <table style="border-collapse:collapse;width:100%;margin-top:16px">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #ddd">Source File</th>
          <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #ddd">Diff Coverage (%)</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #ddd">Missing Lines</th>
        </tr>
      </thead>
      <tbody>${tableRows}
      </tbody>
    </table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Diff Coverage</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px; color: #333; }
    h1 { border-bottom: 2px solid #eee; padding-bottom: 8px; }
    table { border: 1px solid #ddd; }
    tr:nth-child(even) { background: #fafafa; }
    tr:hover { background: #f0f4ff; }
  </style>
</head>
<body>
  <h1>Diff Coverage</h1>
  <p style="color:#666">Diff: <code>${escapeHtml(dict.diffName)}</code></p>
  ${summary}
  ${table}
</body>
</html>`;
}

function escapeHtml (str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── File writer ──────────────────────────────────────────────────────────────

const KNOWN_FORMATS = new Set(['html', 'json', 'markdown']);

const DEFAULT_PATHS: Record<string, string> = {
  html: 'diff-cover.html',
  json: 'diff-cover.json',
  markdown: 'diff-cover.md',
};

/**
 * Parse --format string the same way diff-cover does:
 *   "html:path/to/report.html,json:path/to/report.json"
 *   → { html: "path/to/report.html", json: "path/to/report.json" }
 *
 * Format name alone (no colon) uses the default path for that format.
 * Unknown format names produce a warning.
 */
export function parseFormatOption (raw: string): Record<string, string> {
  const formats: Record<string, string> = {};
  if (!raw) return formats;

  for (const item of raw.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(':');
    const name = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx).trim();
    const outPath = colonIdx === -1
      ? (DEFAULT_PATHS[name] ?? `diff-cover.${name}`)
      : trimmed.slice(colonIdx + 1).trim();

    if (!KNOWN_FORMATS.has(name)) {
      console.warn(`⚠  Unknown --format name "${name}". Known formats: html, json, markdown`);
    }

    formats[name] = outPath;
  }
  return formats;
}

function writeReport (outPath: string, content: string, label: string): void {
  try {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, content, 'utf8');
    console.log(`  ${label} report written to: ${outPath}`);
  } catch (err) {
    console.error(`❌ Could not write ${label} report to ${outPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export function writeFormats (
  formats: Record<string, string>,
  result: DiffCoverageResult,
  diffName: string,
  failUnder = 0
): void {
  if (formats.json) {
    writeReport(formats.json, generateJsonReport(result, diffName), 'JSON');
  }
  if (formats.markdown) {
    writeReport(formats.markdown, generateMarkdownReport(result, diffName), 'Markdown');
  }
  if (formats.html) {
    writeReport(formats.html, generateHtmlReport(result, diffName, failUnder), 'HTML');
  }
}
