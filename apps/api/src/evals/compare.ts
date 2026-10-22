/** `pnpm eval:compare a.json b.json [...]`: prints eval reports side by side (WA-019). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderComparison, type EvalReport } from './report.js';

export function compareFiles(paths: string[], cwd: string): string {
  const reports = paths.map((p) => JSON.parse(readFileSync(resolve(cwd, p), 'utf8')) as EvalReport);
  return renderComparison(reports);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const paths = process.argv.slice(2).filter((a) => a !== '--');
  if (paths.length < 2) {
    console.error('Usage: pnpm eval:compare <report-a.json> <report-b.json> [...]');
    process.exit(2);
  }
  // pnpm runs the script in apps/api; relative paths are the caller's.
  console.log(compareFiles(paths, process.env.INIT_CWD ?? process.cwd()));
}
