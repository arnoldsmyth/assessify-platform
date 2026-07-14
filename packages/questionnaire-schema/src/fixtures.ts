import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Test helper: load a JSON fixture from src/fixtures/. */
export function loadFixture(relativePath: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${relativePath}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Absolute path of a fixture file, for CLI tests. */
export function fixturePath(relativePath: string): string {
  return fileURLToPath(new URL(`./fixtures/${relativePath}`, import.meta.url));
}
