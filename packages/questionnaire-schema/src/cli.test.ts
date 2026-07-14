import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from './cli';
import { fixturePath } from './fixtures';

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

describe('runCli', () => {
  it('exits 0 and prints a summary for a valid definition', async () => {
    const { io, out } = captureIo();
    const code = await runCli(['validate', fixturePath('valid/full.json')], io);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('OK');
    expect(out.join('\n')).toContain('pro-d-core');
  });

  it('exits 1 and prints path + message for an invalid definition', async () => {
    const { io, err } = captureIo();
    const code = await runCli(['validate', fixturePath('invalid/forward-reference.json')], io);
    expect(code).toBe(1);
    const output = err.join('\n');
    expect(output).toContain('INVALID');
    expect(output).toContain('sections[0].questions[0].showIf');
    expect(output).toContain('earlier in document order');
  });

  it('exits 1 when any of several files is invalid', async () => {
    const { io } = captureIo();
    const code = await runCli(
      ['validate', fixturePath('valid/minimal.json'), fixturePath('invalid/self-reference.json')],
      io
    );
    expect(code).toBe(1);
  });

  it('exits 1 for a missing file', async () => {
    const { io, err } = captureIo();
    const code = await runCli(['validate', '/nonexistent/definition.json'], io);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('cannot read file');
  });

  it('exits 1 for malformed JSON', async () => {
    const { io, err } = captureIo();
    // Any non-JSON file will do; use this test file itself.
    const code = await runCli(['validate', fixturePath('../cli.test.ts')], io);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('not valid JSON');
  });

  it('prints usage when no command or files are given', async () => {
    const { io, err } = captureIo();
    expect(await runCli([], io)).toBe(1);
    expect(await runCli(['validate'], io)).toBe(1);
    expect(await runCli(['frobnicate', 'x.json'], io)).toBe(1);
    expect(err.some((l) => l.startsWith('usage:'))).toBe(true);
  });
});
