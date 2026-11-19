import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliIo } from '../../src/cli.js';
import { parseCliArgs, runCli } from '../../src/cli.js';

const FIXTURE_PATH = new URL('../fixtures/sample-mv3 (crx2xpi).crx', import.meta.url);

/** In-memory IO double recording every message for assertions. */
function recordingIo(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (message: string): void => {
      out.push(message);
    },
    error: (message: string): void => {
      err.push(message);
    },
  };
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'crx2xpi-cli-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('parseCliArgs', () => {
  it('parses positional input and output with flags off by default', () => {
    expect(parseCliArgs(['a.crx', 'b.xpi'])).toEqual({
      input: 'a.crx',
      output: 'b.xpi',
      verbose: false,
      keepTemp: false,
    });
  });

  it('recognises the long and short forms of both options', () => {
    expect(parseCliArgs(['-v', '--keep-temp', 'a.crx', 'b.xpi'])).toMatchObject({
      verbose: true,
      keepTemp: true,
    });
    expect(parseCliArgs(['--verbose', '-k', 'a.crx', 'b.xpi'])).toMatchObject({
      verbose: true,
      keepTemp: true,
    });
  });

  it('rejects a missing output argument', () => {
    expect(() => parseCliArgs(['a.crx'])).toThrow(CommanderError);
  });

  it('rejects unknown options', () => {
    expect(() => parseCliArgs(['a.crx', 'b.xpi', '--wat'])).toThrow(CommanderError);
  });
});

describe('runCli', () => {
  const fixtureBytes = (): Buffer => readFileSync(FIXTURE_PATH);

  it('converts the real sample and returns exit code 0', () => {
    const crxPath = join(workDir, 'sample.crx');
    const outputPath = join(workDir, 'out', 'sample.xpi');
    writeFileSync(crxPath, fixtureBytes());
    const io = recordingIo();

    const exitCode = runCli([crxPath, outputPath], io);

    expect(exitCode).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
    expect(io.out[0]).toContain('downgraded: yes');
    expect(io.err).toEqual([]);
  });

  it('prints one progress log per stage when --verbose is set', () => {
    const crxPath = join(workDir, 'sample.crx');
    const outputPath = join(workDir, 'sample.xpi');
    writeFileSync(crxPath, fixtureBytes());
    const io = recordingIo();

    const exitCode = runCli(['--verbose', crxPath, outputPath], io);

    expect(exitCode).toBe(0);
    const stages = io.out.map((line) => line.replace(/^\[crx2xpi\] /, ''));
    // The engine emits header, manifest, polyfill and repack stages in order.
    expect(stages.some((line) => line.startsWith('CRX3 header validated'))).toBe(true);
    expect(stages.some((line) => line.startsWith('manifest parsed'))).toBe(true);
    expect(stages.some((line) => line.includes('polyfill'))).toBe(true);
    expect(stages.some((line) => line.startsWith('XPI written to'))).toBe(true);
    expect(io.out.at(-1)).toContain('downgraded: yes');
  });

  it('silences progress logs without --verbose', () => {
    const crxPath = join(workDir, 'sample.crx');
    const outputPath = join(workDir, 'sample.xpi');
    writeFileSync(crxPath, fixtureBytes());
    const io = recordingIo();

    const exitCode = runCli([crxPath, outputPath], io);

    expect(exitCode).toBe(0);
    expect(io.out.filter((line) => line.startsWith('[crx2xpi]'))).toEqual([]);
  });

  it('keeps the extracted payload directory with --keep-temp', () => {
    const crxPath = join(workDir, 'sample.crx');
    const outputPath = join(workDir, 'sample.xpi');
    writeFileSync(crxPath, fixtureBytes());
    const io = recordingIo();

    const exitCode = runCli(['--keep-temp', crxPath, outputPath], io);

    expect(exitCode).toBe(0);
    const keptLine = io.out.find((line) => line.startsWith('kept extracted payload'));
    expect(keptLine).toBeDefined();
    // Parse the reported path back out of the log and verify the dump.
    const tempDir = (keptLine as string).split('at: ')[1];
    expect(existsSync(tempDir)).toBe(true);
    expect(existsSync(join(tempDir, 'manifest.json'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(tempDir, 'manifest.json'), 'utf8')) as {
      background?: { scripts?: string[] };
    };
    expect(manifest.background?.scripts?.slice(0, 2)).toEqual([
      'chrome-promise-shim.js',
      'browser-polyfill.js',
    ]);
  });

  it('fails with exit code 1 and an error message for missing input', () => {
    const io = recordingIo();

    const exitCode = runCli([join(workDir, 'missing.crx'), join(workDir, 'out.xpi')], io);

    expect(exitCode).toBe(1);
    expect(io.err.some((line) => line.startsWith('conversion failed'))).toBe(true);
    expect(io.out).toEqual([]);
  });

  it('fails with exit code 1 and usage hint for missing arguments', () => {
    const io = recordingIo();

    const exitCode = runCli(['only-input.crx'], io);

    expect(exitCode).toBe(1);
    expect(io.err.some((line) => line.startsWith('usage: crx2xpi'))).toBe(true);
  });
});
