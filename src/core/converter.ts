/**
 * CRX3 → XPI conversion engine.
 *
 * The engine owns every filesystem decision: parsing stays pure
 * (`parsers/manifest-parser.ts` returns downgrade data without writing), and
 * this module is the only place that reads CRX containers, mutates the payload
 * and repackages an XPI.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import type {
  GeckoBackgroundConfig,
  ManifestParseResult,
  WebExtensionManifest,
} from '../parsers/manifest-parser.js';
import { ManifestValidationError, parseManifest } from '../parsers/manifest-parser.js';

/**
 * Thrown when a CRX container is structurally malformed: bad magic bytes,
 * unsupported container version, or length fields that do not fit the buffer.
 *
 * A dedicated class lets callers separate "input is not a CRX3 file" from
 * runtime IO failures without matching on error messages.
 */
export class CrxFormatError extends Error {
  /**
   * Create a CRX format error.
   *
   * @param message - Human-readable description of the violated constraint.
   */
  constructor(message: string) {
    super(message);
    this.name = 'CrxFormatError';
  }
}

/**
 * Thrown when the conversion fails outside of header parsing and manifest
 * validation: unreadable input, missing manifest entry, or an unwritable
 * output path.
 */
export class ConversionError extends Error {
  /**
   * Create a conversion error, preserving the underlying cause when present.
   *
   * @param message - Human-readable description of the failed step.
   * @param options - Standard `ErrorOptions`; `cause` carries the original error.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConversionError';
  }
}

/** Stages reported through `ConversionOptions.onProgress`, in execution order. */
export type ConversionStage =
  'header-parsed' | 'manifest-parsed' | 'polyfill-injected' | 'repacked';

/** A single progress event emitted while a conversion runs. */
export interface ConversionProgress {
  /** The stage that just finished. */
  stage: ConversionStage;
  /** Human-readable detail for CLI verbose output. */
  detail: string;
}

/** Optional behaviour knobs for `convertCrxToXpi`. */
export interface ConversionOptions {
  /** Receives one event per finished stage; used for verbose CLI logging. */
  onProgress?: (event: ConversionProgress) => void;
  /** Keep the extracted payload directory on disk for debugging. */
  keepTempDir?: boolean;
}

/** Summary of a finished conversion, returned to callers for reporting. */
export interface ConversionResult {
  /** Path the repacked XPI was written to. */
  outputPath: string;
  /** Display name of the parsed manifest. */
  manifestName: string;
  /** Manifest specification version detected in the payload. */
  manifestVersion: 2 | 3;
  /** Whether the MV3 service_worker downgrade was applied. */
  downgraded: boolean;
  /** Extracted payload directory, present only with `keepTempDir: true`. */
  tempDir?: string;
}

/** Layout of the fixed CRX header, derived from the container spec. */
export interface Crx3HeaderInfo {
  /** Byte length of the signed header block declared by the container. */
  headerLength: number;
  /** Absolute offset where the ZIP payload begins (`12 + headerLength`). */
  payloadOffset: number;
}

/**
 * CRX3 fixed header size: magic(4) + version(4) + header_length(4).
 *
 * CRX2 used two length fields here (public_key_len at 8, signature_len at 12);
 * CRX3 replaced both with a single little-endian header_length at offset 8,
 * so the payload start is computed from one field instead of two.
 */
const CRX_FIXED_HEADER_LENGTH = 12;
/** CRX3 is the only supported container version; CRX2 lacks a CRX3 header. */
const CRX3_FORMAT_VERSION = 3;
/** Entry name of the manifest inside the ZIP payload. */
const MANIFEST_ENTRY_NAME = 'manifest.json';

/**
 * Entry name under which the polyfill is injected into the XPI root.
 *
 * Exported because rewrite and packaging code (and their tests) must agree on
 * a single canonical path for the injected asset.
 */
export const POLYFILL_ENTRY_NAME = 'browser-polyfill.js';

/** Pre-computed asset location so the polyfill is read lazily, not at import. */
const POLYFILL_ASSET_URL = new URL('../assets/polyfill.js', import.meta.url);

/**
 * Read the bundled browser-polyfill source from the package assets.
 *
 * @returns Raw polyfill script bytes, ready to be stored in the XPI.
 * @throws {ConversionError} When the asset is missing from the package layout.
 */
function readPolyfillSource(): Buffer {
  try {
    return readFileSync(fileURLToPath(POLYFILL_ASSET_URL));
  } catch (cause) {
    throw new ConversionError('browser-polyfill asset is missing from the package', { cause });
  }
}

/**
 * Check the four magic bytes of a CRX container.
 *
 * The CRX magic number is the ASCII string `Cr24`, i.e. the byte sequence
 * `0x43 0x72 0x32 0x34` at offset 0. The bytes are compared individually
 * because a multi-byte read would depend on host endianness, while the CRX
 * magic is defined as a byte sequence independent of platform.
 *
 * @param buffer - Raw CRX file content.
 * @returns True when the buffer starts with `Cr24`.
 */
function hasCrxMagic(buffer: Buffer): boolean {
  return (
    buffer[0] === 0x43 && // 'C'
    buffer[1] === 0x72 && // 'r'
    buffer[2] === 0x32 && // '2'
    buffer[3] === 0x34 // '4'
  );
}

/**
 * Parse and validate the fixed CRX header, computing where the ZIP begins.
 *
 * <parsing steps>
 * 1. Reject buffers shorter than the fixed 12-byte header.
 * 2. Verify the `Cr24` magic bytes.
 * 3. Read the little-endian container version and require CRX3.
 * 4. Read the little-endian header length and reject it if the declared
 *    payload offset overruns the buffer (never trust declared sizes).
 * </parsing steps>
 *
 * @param crxBuffer - Raw CRX file content.
 * @returns The header length and the absolute ZIP payload offset.
 * @throws {CrxFormatError} On truncated input, bad magic, wrong version, or
 * a header length that would push the payload past the end of the file.
 */
export function parseCrx3Header(crxBuffer: Buffer): Crx3HeaderInfo {
  if (crxBuffer.length < CRX_FIXED_HEADER_LENGTH) {
    throw new CrxFormatError(
      `CRX header truncated: expected at least ${CRX_FIXED_HEADER_LENGTH} bytes`
    );
  }
  if (!hasCrxMagic(crxBuffer)) {
    throw new CrxFormatError('not a CRX container: magic bytes "Cr24" missing');
  }

  // Length fields are stored little-endian because the Chromium writers emit
  // fixed-width LE uint32 values regardless of host platform.
  const version = crxBuffer.readUInt32LE(4);
  if (version !== CRX3_FORMAT_VERSION) {
    throw new CrxFormatError(`unsupported CRX version ${version}; only CRX3 is supported`);
  }

  const headerLength = crxBuffer.readUInt32LE(8);
  const payloadOffset = CRX_FIXED_HEADER_LENGTH + headerLength;
  if (payloadOffset > crxBuffer.length) {
    throw new CrxFormatError(
      `CRX header length ${headerLength} overruns the ${crxBuffer.length}-byte buffer`
    );
  }
  return { headerLength, payloadOffset };
}

/**
 * Strip the CRX3 container and return the pristine ZIP payload.
 *
 * The ZIP archive starts after magic(4) + version(4) + header_length(4) plus
 * the signed header block; everything before it is signature material that
 * Firefox package verification does not use and must not leak into the XPI.
 *
 * @param crxBuffer - Raw CRX file content.
 * @returns The ZIP payload as a zero-copy view of the input.
 * @throws {CrxFormatError} When the container header is malformed.
 */
export function extractCrxZipPayload(crxBuffer: Buffer): Buffer {
  const { payloadOffset } = parseCrx3Header(crxBuffer);
  return crxBuffer.subarray(payloadOffset);
}

/**
 * Read a CRX file from disk and unpack it into its ZIP payload.
 *
 * @param crxPath - Path to the source `.crx` file.
 * @returns The ZIP payload plus the validated header layout for reporting.
 * @throws {ConversionError} When the file cannot be read.
 * @throws {CrxFormatError} When the container header is malformed.
 */
function unpackCrx(crxPath: string): { zip: Buffer; header: Crx3HeaderInfo } {
  let crxBuffer: Buffer;
  try {
    crxBuffer = readFileSync(crxPath);
  } catch (cause) {
    throw new ConversionError(`cannot read CRX file at ${crxPath}`, { cause });
  }
  const header = parseCrx3Header(crxBuffer);
  return { zip: crxBuffer.subarray(header.payloadOffset), header };
}

/**
 * Locate and decode `manifest.json` inside the ZIP payload.
 *
 * @param zip - In-memory ZIP archive of the extension payload.
 * @returns The raw manifest data, handed to `parseManifest` for validation.
 * @throws {ConversionError} When the entry is missing, unreadable, or not JSON.
 */
function loadZipManifest(zip: AdmZip): unknown {
  const entry = zip.getEntry(MANIFEST_ENTRY_NAME);
  if (entry === null) {
    throw new ConversionError('CRX payload does not contain a manifest.json entry');
  }

  let raw: string;
  try {
    raw = zip.readAsText(entry);
  } catch (cause) {
    throw new ConversionError('cannot read manifest.json from the CRX payload', { cause });
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new ConversionError('manifest.json is not valid JSON', { cause });
  }
}

/**
 * Prepend the browser-polyfill entry to a background script list.
 *
 * WHY prepend rather than append: the polyfill must be evaluated before any
 * script that calls the promise-based `browser.*` API — an appended polyfill
 * leaves those calls hitting `undefined` at load time. Injecting once is
 * guaranteed by checking for an existing entry first, so re-running the
 * conversion on an already-converted payload cannot duplicate the file.
 *
 * @param scripts - Background script paths produced by the manifest parser.
 * @returns A new script list headed by the polyfill, original order preserved.
 */
export function injectPolyfillScript(scripts: string[]): string[] {
  return scripts.includes(POLYFILL_ENTRY_NAME) ? scripts : [POLYFILL_ENTRY_NAME, ...scripts];
}

/**
 * Build the Firefox-compatible manifest with the background downgrade applied.
 *
 * WHY the background section is replaced wholesale: Firefox / GeckoView does
 * not implement Chromium's MV3 service workers, so a manifest still carrying
 * `background.service_worker` describes background behaviour Firefox cannot
 * run. The parser's downgrade plan is already Gecko-shaped (event-page
 * scripts, non-persistent); here it becomes the authoritative background
 * section and the Chromium-only field disappears with the replacement.
 *
 * @param manifest - Validated manifest from the parser (never mutated).
 * @param geckoBackground - Downgrade plan generated by `parseManifest`.
 * @returns A new manifest object; the input copy is left untouched.
 */
function buildGeckoManifest(
  manifest: WebExtensionManifest,
  geckoBackground: GeckoBackgroundConfig
): WebExtensionManifest {
  return {
    ...manifest,
    background: {
      scripts: injectPolyfillScript(geckoBackground.scripts),
      // Firefox uses event pages, never a persistent background page.
      persistent: false,
    },
  };
}

/**
 * Apply the Gecko downgrade to the ZIP payload in place.
 *
 * Parsing is pure and never writes; this helper is the single point where the
 * parsed downgrade plan becomes payload mutation, and it only runs when a
 * service_worker downgrade was actually generated.
 *
 * @param zip - In-memory ZIP archive of the extension payload (mutated).
 * @param parseResult - Validated parse result carrying the downgrade plan.
 * @returns True when the manifest was rewritten and the polyfill injected.
 * @throws {ConversionError} When the bundled polyfill asset cannot be read.
 */
function applyGeckoDowngrade(zip: AdmZip, parseResult: ManifestParseResult): boolean {
  const geckoBackground = parseResult.geckoBackground;
  if (geckoBackground === undefined) {
    return false;
  }
  const rewritten = buildGeckoManifest(parseResult.manifest, geckoBackground);
  zip.updateFile(MANIFEST_ENTRY_NAME, Buffer.from(JSON.stringify(rewritten, null, 2), 'utf8'));
  zip.addFile(POLYFILL_ENTRY_NAME, readPolyfillSource());
  return true;
}

/**
 * Extract the final payload to a fresh temporary directory for debugging.
 *
 * @param zip - Repacked (already converted) ZIP payload.
 * @returns The created directory path; the caller decides whether to clean up.
 * @throws {ConversionError} When the directory cannot be created or written.
 */
function extractForDebugging(zip: AdmZip): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'crx2xpi-debug-'));
  try {
    zip.extractAllTo(tempDir, true);
  } catch (cause) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new ConversionError(`cannot extract payload for debugging to ${tempDir}`, { cause });
  }
  return tempDir;
}

/**
 * Convert a Chrome CRX3 extension into a Firefox-compatible XPI package.
 *
 * <conversion steps>
 * 1. Read the CRX file, validate the CRX3 header, strip it, keep the ZIP
 *    payload.
 * 2. Locate `manifest.json` in the payload and validate it with
 *    `parseManifest`.
 * 3. When the parser generated a service_worker downgrade, rewrite the
 *    manifest with the Gecko background section (polyfill prepended) and add
 *    the polyfill asset to the package root.
 * 4. Repack the payload as an XPI at `outputPath`, creating parent
 *    directories as needed; optionally extract the result to a temporary
 *    directory for debugging.
 * </conversion steps>
 *
 * @param crxPath - Path to the source `.crx` file.
 * @param outputPath - Path the converted `.xpi` is written to.
 * @param options - Optional progress reporting and debug-directory behaviour.
 * @returns A summary of the conversion for reporting and testing.
 * @throws {ConversionError} On unreadable input, missing/invalid manifest
 * entry JSON, or an unwritable output path.
 * @throws {CrxFormatError} When the CRX header is malformed.
 * @throws {ManifestValidationError} When the manifest fails schema validation.
 */
export function convertCrxToXpi(
  crxPath: string,
  outputPath: string,
  options: ConversionOptions = {}
): ConversionResult {
  const emit = (stage: ConversionStage, detail: string): void => {
    options.onProgress?.({ stage, detail });
  };

  const { zip: zipBuffer, header } = unpackCrx(crxPath);
  emit(
    'header-parsed',
    `CRX3 header validated (header_length=${header.headerLength}, ZIP payload starts at byte ${header.payloadOffset})`
  );

  const zip = new AdmZip(zipBuffer);
  const parseResult = parseManifest(loadZipManifest(zip));
  emit(
    'manifest-parsed',
    `manifest parsed: "${parseResult.manifest.name}" (manifest v${parseResult.manifest.manifest_version})`
  );

  const downgraded = applyGeckoDowngrade(zip, parseResult);
  if (downgraded) {
    emit(
      'polyfill-injected',
      `service_worker downgraded to background.scripts; ${POLYFILL_ENTRY_NAME} prepended first`
    );
  }

  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    zip.writeZip(outputPath);
  } catch (cause) {
    throw new ConversionError(`cannot write XPI package at ${outputPath}`, { cause });
  }
  emit('repacked', `XPI written to ${outputPath}`);

  // Debugging aid only: the conversion itself stays in memory unless asked.
  const tempDir = options.keepTempDir === true ? extractForDebugging(zip) : undefined;

  return {
    outputPath,
    manifestName: parseResult.manifest.name,
    manifestVersion: parseResult.manifest.manifest_version,
    downgraded,
    ...(tempDir === undefined ? {} : { tempDir }),
  };
}

// ManifestValidationError is re-exported so callers of the engine can catch
// manifest problems without importing from the parser module directly.
export { ManifestValidationError };
