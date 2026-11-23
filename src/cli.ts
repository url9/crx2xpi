#!/usr/bin/env node
/**
 * crx2xpi command-line interface.
 *
 * Wraps the conversion engine with argument parsing (commander), verbose
 * progress logging and a debug flag that keeps the extracted payload
 * directory on disk. The CLI owns presentation only: all conversion logic
 * lives in `src/core/` so the engine stays embeddable as a library.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { analyzeCrx, convertCrxToXpi } from './core/converter.js';
import { renderReportMarkdown } from './core/diagnostics.js';

/** Parsed CLI invocation. */
export interface CliOptions {
  /** Path to the source `.crx` file. */
  input: string;
  /** Path the converted `.xpi` is written to. */
  output: string;
  /** Whether detailed progress logs were requested (`--verbose`). */
  verbose: boolean;
  /** Whether to keep the extracted payload directory (`--keep-temp`). */
  keepTemp: boolean;
  /** Optional path to write a static compatibility Markdown report (`--report`). */
  report: string | undefined;
  /** Optional custom Gecko add-on id (`--id`), used when the manifest has none. */
  id: string | undefined;
}

/** Output channels injected into the CLI, swappable for tests. */
export interface CliIo {
  /** Standard output sink (progress and success messages). */
  log: (message: string) => void;
  /** Error sink (usage problems and conversion failures). */
  error: (message: string) => void;
}

/** Default IO: stdout/stderr via process streams, avoiding console coupling. */
const defaultIo: CliIo = {
  log: (message: string): void => {
    process.stdout.write(`${message}\n`);
  },
  error: (message: string): void => {
    process.stderr.write(`${message}\n`);
  },
};

/** Version reported by `--version`, read once from package.json. */
const CLI_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/**
 * Build the commander program with output streams silenced and overrides on.
 *
 * WHY shared: `parseCliArgs` needs the parsed values, `runCli` needs the exact
 * same program to render `--help` text on a `commander.helpDisplayed` signal.
 * Constructing it in one place guarantees the two can never drift.
 *
 * @returns A configured, unparsed commander program.
 */
function createProgram(): Command {
  return new Command()
    .configureOutput({ writeOut: (): void => undefined, writeErr: (): void => undefined })
    .exitOverride()
    .name('crx2xpi')
    .description('Convert Chrome MV3 extensions (CRX3) into Firefox-compatible XPI add-ons.')
    .version(CLI_VERSION, '-V, --version', 'output the version number')
    .argument('<input.crx>', 'source Chrome CRX3 extension file')
    .argument('<output.xpi>', 'destination Firefox XPI add-on file')
    .option('-v, --verbose', 'print detailed conversion progress', false)
    .option('-k, --keep-temp', 'keep the extracted payload directory for debugging', false)
    .option('-r, --report <path>', 'write a static compatibility Markdown report')
    .option(
      '-i, --id <id>',
      'custom Gecko add-on ID used when the source manifest has none (e.g., my-ext@domain.com)'
    );
}

/**
 * Parse CLI arguments without spawning or exiting the process.
 *
 * Output streams are silenced because commander otherwise writes usage and
 * error text directly to the terminal; the caller renders errors itself so
 * logging stays testable and consistent.
 *
 * @param argv - Argument vector WITHOUT the node binary and script path.
 * @returns The parsed options for a successful invocation.
 * @throws {CommanderError} On missing arguments, unknown options, `--help` or
 * `--version` (the latter two are control-flow signals handled by `runCli`).
 */
export function parseCliArgs(argv: string[]): CliOptions {
  const program = createProgram();
  program.parse(argv, { from: 'user' });
  const [input, output] = program.args;
  const { verbose, keepTemp, report, id } = program.opts<{
    verbose: boolean;
    keepTemp: boolean;
    report?: string;
    id?: string;
  }>();
  return { input, output, verbose, keepTemp, report, id };
}

/**
 * Run one CLI invocation end to end.
 *
 * @param argv - Argument vector WITHOUT the node binary and script path.
 * @param io - Output channels; defaults to the process streams.
 * @returns Process-style exit code: 0 on success, 1 on any failure.
 */
export function runCli(argv: string[], io: CliIo = defaultIo): number {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    // `--help` and `--version` are successful control-flow signals, not errors:
    // commander throws them under exitOverride() after writing to a silenced
    // stream. Render the real text on our own IO and exit 0 instead of leaking
    // the raw internal message (`(outputHelp)`) as a fake error.
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed') {
        io.log(createProgram().helpInformation().trimEnd());
        return 0;
      }
      if (error.code === 'commander.version') {
        io.log(CLI_VERSION);
        return 0;
      }
    }
    // Other commander errors carry a precise message (e.g. the missing
    // argument name); surfacing it verbatim beats re-parsing the cause.
    const message = error instanceof CommanderError ? error.message.trim() : String(error);
    io.error(`crx2xpi: ${message}`);
    io.error(
      'usage: crx2xpi <input.crx> <output.xpi> [--verbose] [--keep-temp] [--report <path>] [--id <id>]'
    );
    return 1;
  }

  try {
    const result = convertCrxToXpi(options.input, options.output, {
      ...(options.verbose ? { onProgress: (event) => io.log(`[crx2xpi] ${event.detail}`) } : {}),
      ...(options.keepTemp ? { keepTempDir: true } : {}),
      ...(options.id !== undefined ? { customGeckoId: options.id } : {}),
    });

    io.log(
      `done: ${result.manifestName} -> ${result.outputPath} (downgraded: ${result.downgraded ? 'yes' : 'no'})`
    );
    if (result.tempDir !== undefined) {
      io.log(`kept extracted payload for debugging at: ${result.tempDir}`);
    }
    if (options.report !== undefined) {
      try {
        const report = analyzeCrx(options.input);
        writeFileSync(options.report, renderReportMarkdown(report), 'utf8');
        io.log(`compatibility report written to: ${options.report}`);
      } catch (error) {
        io.error(
          `report generation failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return 1;
      }
    }
    return 0;
  } catch (error) {
    io.error(`conversion failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Direct execution entry point: the shebang script runs the CLI, while
// library consumers import from the same module without side effects.
/* c8 ignore next 3 -- exercised through the published bin, not unit tests */
const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === entryPath) {
  process.exitCode = runCli(process.argv.slice(2));
}
