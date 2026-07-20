#!/usr/bin/env tsx
/**
 * Questionnaire definition validator CLI (spec 07: `pnpm qdef validate <file>`).
 *
 * Usage:
 *   pnpm --filter @assessify/questionnaire-schema validate <file.json> [...]
 *   pnpm qdef validate <file.json> [...]           (root convenience script)
 *
 * Exit code 0 when every file is valid, 1 otherwise.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateDefinition } from './validate';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = 'usage: qdef validate <definition.json> [more.json ...]';

/**
 * pnpm scripts run with cwd = the package directory; INIT_CWD is where the
 * user actually invoked pnpm, so relative paths behave as expected.
 */
function resolveInputPath(file: string): string {
  if (isAbsolute(file)) return file;
  return resolve(process.env['INIT_CWD'] ?? process.cwd(), file);
}

async function validateFile(file: string, io: CliIo): Promise<boolean> {
  const fullPath = resolveInputPath(file);

  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf8');
  } catch (cause) {
    io.err(`${file}: cannot read file (${cause instanceof Error ? cause.message : String(cause)})`);
    return false;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    io.err(`${file}: not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`);
    return false;
  }

  const result = validateDefinition(json);
  if (result.ok) {
    const questionCount = result.value.sections.reduce((n, s) => n + s.questions.length, 0);
    io.out(
      `${file}: OK — "${result.value.key}" (schemaVersion ${result.value.schemaVersion}, ` +
        `${result.value.sections.length} section${result.value.sections.length === 1 ? '' : 's'}, ` +
        `${questionCount} question${questionCount === 1 ? '' : 's'})`
    );
    return true;
  }

  io.err(`${file}: INVALID — ${result.error.issues.length} issue${result.error.issues.length === 1 ? '' : 's'}`);
  for (const issue of result.error.issues) {
    io.err(`  ${issue.path}: ${issue.message}`);
  }
  return false;
}

export async function runCli(
  argv: string[],
  io: CliIo = { out: console.log, err: console.error }
): Promise<number> {
  const [command, ...files] = argv;

  if (command !== 'validate' || files.length === 0) {
    io.err(USAGE);
    return 1;
  }

  let allValid = true;
  for (const file of files) {
    const valid = await validateFile(file, io);
    allValid &&= valid;
  }
  return allValid ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await runCli(process.argv.slice(2));
}
