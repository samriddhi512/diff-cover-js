import fs from 'fs';
import path from 'path';

export interface DiffCoverConfig {
  lcov?: string;
  compareBranch?: string;
  failUnder?: number;
  exclude?: string[];
  strict?: boolean;
  quiet?: boolean;
  diffRangeNotation?: '...' | '..';
  format?: string;
  noDefaultExcludes?: boolean;
}

const CONFIG_FILE_NAMES = [
  '.diff-cover-js.json',
  'diff-cover-js.json',
];

/**
 * Load config from the first matching file found, searching upward from cwd.
 * Mirrors diff-cover's config_parser.py — CLI args always override config file values.
 */
export function loadConfig (startDir = process.cwd()): DiffCoverConfig {
  let dir = startDir;

  while (true) {
    for (const name of CONFIG_FILE_NAMES) {
      const filePath = path.join(dir, name);
      if (fs.existsSync(filePath)) {
        try {
          return JSON.parse(fs.readFileSync(filePath, 'utf8')) as DiffCoverConfig;
        } catch (err) {
          console.warn(
            `⚠  Could not parse config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`
          );
          return {};
        }
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return {};
}
