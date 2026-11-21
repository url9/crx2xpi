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
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import type {
  GeckoBackgroundConfig,
  ManifestParseResult,
  WebExtensionManifest,
} from '../parsers/manifest-parser.js';
import { ManifestValidationError, parseManifest } from '../parsers/manifest-parser.js';
import { rewriteManifestForGecko } from './manifest-rewrite.js';
import {
  buildDiagnosticReport,
  type DiagnosticReport,
  type DiagnosticSource,
} from './diagnostics.js';

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
  'header-parsed' | 'manifest-parsed' | 'polyfill-injected' | 'manifest-rewritten' | 'repacked';

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

/**
 * Entry name under which the Firefox `chrome`-to-`browser` alias shim is
 * injected into the XPI root.
 *
 * Exported because rewrite and packaging code (and their tests) must agree on
 * a single canonical path for the injected asset.
 */
export const CHROME_SHIM_ENTRY_NAME = 'chrome-promise-shim.js';

/** Pre-computed asset locations so assets are read lazily, not at import. */
const POLYFILL_ASSET_URL = new URL('../assets/polyfill.js', import.meta.url);
const CHROME_SHIM_ASSET_URL = new URL('../assets/chrome-shim.js', import.meta.url);

/**
 * Read a bundled asset source from the package assets.
 *
 * @param assetUrl - `file:` URL of the asset inside the package layout.
 * @param label - Asset name used in error messages.
 * @returns Raw asset bytes, ready to be stored in the XPI.
 * @throws {ConversionError} When the asset is missing from the package layout.
 */
function readAssetSource(assetUrl: URL, label: string): Buffer {
  try {
    return readFileSync(fileURLToPath(assetUrl));
  } catch (cause) {
    throw new ConversionError(`${label} asset is missing from the package`, { cause });
  }
}

/**
 * Read the bundled browser-polyfill source from the package assets.
 *
 * @returns Raw polyfill script bytes, ready to be stored in the XPI.
 * @throws {ConversionError} When the asset is missing from the package layout.
 */
function readPolyfillSource(): Buffer {
  return readAssetSource(POLYFILL_ASSET_URL, 'browser-polyfill');
}

/**
 * Read the bundled `chrome`-alias shim source from the package assets.
 *
 * @returns Raw shim script bytes, ready to be stored in the XPI.
 * @throws {ConversionError} When the asset is missing from the package layout.
 */
function readChromeShimSource(): Buffer {
  return readAssetSource(CHROME_SHIM_ASSET_URL, 'chrome-promise-shim');
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
 * Prepend the Firefox compatibility entries to a background script list.
 *
 * WHY two entries and why they are prepended rather than appended: the shim
 * and the polyfill must both be evaluated before any script that calls the
 * WebExtension API — an appended entry leaves those calls hitting `undefined`
 * at load time. Order of the two entries:
 *
 * 1. `chrome-promise-shim.js` — Firefox keeps `chrome` callback-only while
 *    Chrome MV3 code calls `await chrome.*`; on Firefox the shim aliases
 *    `chrome` to the promise-capable `browser` namespace, which is the only
 *    way promise-style calls resolve to real values. It runs first so the
 *    alias exists before anything (including the polyfill below) touches
 *    `chrome`.
 * 2. `browser-polyfill.js` — Mozilla's polyfill for code that references the
 *    promise-based `browser.*` API; it is a no-op where `browser` already
 *    exists natively.
 *
 * Injecting each entry once is guaranteed by checking for it first, so
 * re-running the conversion on an already-converted payload cannot duplicate
 * either file.
 *
 * @param scripts - Background script paths produced by the manifest parser.
 * @returns A new script list headed by the shim and polyfill, original order
 *          preserved.
 */
export function injectPolyfillScript(scripts: string[]): string[] {
  const head = [CHROME_SHIM_ENTRY_NAME, POLYFILL_ENTRY_NAME].filter(
    (entry) => !scripts.includes(entry)
  );
  return [...head, ...scripts];
}

/**
 * Rewrite one extension HTML page so it loads the chrome alias shim first.
 *
 * WHY pages need the shim at all: Firefox exposes the `chrome` namespace in
 * extension pages (popup, options, devtools, ...) exactly like it does in the
 * background — callback-only. Chrome MV3 popup code calls `await chrome.*`,
 * so a converted popup silently stalls on its loading screen with no visible
 * error. Background scripts alone cannot fix this because the page is a
 * separate document; each HTML file must reference the shim itself.
 *
 * Steps:
 * 1. Skip documents without any `<script` element — nothing can call the
 *    API there, and injecting would only bloat the package.
 * 2. Skip documents that already reference the shim (idempotence, so
 *    re-running a conversion cannot double-inject).
 * 3. Insert a `<script src="...">` tag immediately after the opening
 *    `<head>` tag, or at the very start when no `<head>` exists. The shim
 *    must run before every other script in the page, which an in-head first
 *    position guarantees regardless of `defer`/`async` attributes elsewhere.
 *
 * @param html - Raw HTML document text (not mutated).
 * @param shimSrc - Shim URL as referenced from this document, already
 *        relative to the document's own directory.
 * @returns The rewritten document, or `null` when nothing had to change.
 */
export function injectChromeShimIntoHtml(html: string, shimSrc: string): string | null {
  if (!/<\s*script[\s>]/i.test(html) || html.includes(shimSrc)) {
    return null;
  }
  const tag = `<script src="${shimSrc}"></script>`;
  const headMatch = /<\s*head\b[^>]*>/i.exec(html);
  if (headMatch === null) {
    return `${tag}${html}`;
  }
  const insertAt = headMatch.index + headMatch[0].length;
  return `${html.slice(0, insertAt)}${tag}${html.slice(insertAt)}`;
}

/**
 * Inject the chrome alias shim into every scripted extension page of the
 * payload, in place.
 *
 * WHY relative URLs are computed per page: extension pages live in nested
 * directories (`ui/popup/index.html`, `options/options.html`, ...), while the
 * shim asset sits at the package root; a wrong relative path would 404 inside
 * the extension package and silently disable the alias again.
 *
 * @param zip - In-memory ZIP archive of the extension payload (mutated).
 * @returns The number of HTML pages that were rewritten.
 * @throws {ConversionError} When a page entry cannot be read or updated.
 */
function injectChromeShimIntoExtensionPages(zip: AdmZip): number {
  let rewritten = 0;
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.endsWith('.html') || entry.isDirectory) {
      continue;
    }
    let html: string;
    try {
      html = entry.getData().toString('utf8');
    } catch (cause) {
      throw new ConversionError(`cannot read extension page ${entry.entryName}`, { cause });
    }
    const shimSrc = relative(dirname(entry.entryName), CHROME_SHIM_ENTRY_NAME).split(sep).join('/');
    const updated = injectChromeShimIntoHtml(html, shimSrc);
    if (updated === null) {
      continue;
    }
    zip.updateFile(entry, Buffer.from(updated, 'utf8'));
    rewritten += 1;
  }
  return rewritten;
}

/**
 * Build the Firefox-compatible manifest with every rewrite applied.
 *
 * WHY the background section is replaced wholesale when a downgrade exists:
 * Firefox / GeckoView does not implement Chromium's MV3 service workers, so a
 * manifest still carrying `background.service_worker` describes background
 * behaviour Firefox cannot run. The parser's downgrade plan is already
 * Gecko-shaped (event-page scripts, non-persistent); here it becomes the
 * authoritative background section and the Chromium-only field disappears.
 *
 * The remaining rules (Gecko id, permission split, Chrome-only key removal,
 * CSP normalisation, ...) come from `rewriteManifestForGecko` and run for MV2
 * and MV3 alike — an MV2 CRX still needs a stable Gecko id and must not keep a
 * Chrome `update_url`. See that module for why each rule is safe and why the
 * risky "fixes" used elsewhere are deliberately absent.
 *
 * @param manifest - Validated manifest from the parser (never mutated).
 * @param geckoBackground - Downgrade plan generated by `parseManifest`, if any.
 * @returns A new manifest object; the input copy is left untouched.
 */
function buildGeckoManifest(
  manifest: WebExtensionManifest,
  geckoBackground: GeckoBackgroundConfig | undefined
): WebExtensionManifest {
  const rewritten = rewriteManifestForGecko(manifest);
  if (geckoBackground === undefined) {
    return rewritten;
  }
  return {
    ...rewritten,
    background: {
      scripts: injectPolyfillScript(geckoBackground.scripts),
      // Firefox uses event pages, never a persistent background page.
      persistent: false,
      // A module worker uses static `import`; without type:"module" Firefox
      // loads these scripts as classic and throws SyntaxError on the first
      // import, so the original worker's module flag must be preserved.
      ...(geckoBackground.type === undefined ? {} : { type: geckoBackground.type }),
    },
  };
}

/**
 * Apply all Gecko compatibility rewrites to the ZIP payload in place.
 *
 * Parsing is pure and never writes; this helper is the single point where the
 * parsed rewrite plan becomes payload mutation. The manifest is rewritten for
 * every input (MV2 included — it still needs a Gecko id and must not keep a
 * Chrome `update_url`), while the alias shim and polyfill are added only when a
 * service_worker downgrade actually generated Gecko background scripts.
 *
 * @param zip - In-memory ZIP archive of the extension payload (mutated).
 * @param parseResult - Validated parse result carrying the downgrade plan.
 * @returns True when a service_worker downgrade was applied.
 * @throws {ConversionError} When a bundled compatibility asset cannot be read.
 */
function applyGeckoRewrites(zip: AdmZip, parseResult: ManifestParseResult): boolean {
  const geckoBackground = parseResult.geckoBackground;
  const rewritten = buildGeckoManifest(parseResult.manifest, geckoBackground);
  zip.updateFile(MANIFEST_ENTRY_NAME, Buffer.from(JSON.stringify(rewritten, null, 2), 'utf8'));

  if (geckoBackground === undefined) {
    return false;
  }
  zip.addFile(CHROME_SHIM_ENTRY_NAME, readChromeShimSource());
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
 *    manifest with the Gecko background section (shim + polyfill prepended),
 *    add both compatibility assets to the package root, and inject the shim
 *    into every scripted extension page (popup/options/...) — pages are
 *    separate documents and need their own shim reference.
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

  const downgraded = applyGeckoRewrites(zip, parseResult);
  if (downgraded) {
    // Only MV3 conversions inject the shim at all, so page injection must be
    // gated identically: MV2 popups keep callback-style chrome calls that
    // Firefox already supports natively.
    const pages = injectChromeShimIntoExtensionPages(zip);
    emit(
      'polyfill-injected',
      `service_worker downgraded to background.scripts; ${CHROME_SHIM_ENTRY_NAME} and ${POLYFILL_ENTRY_NAME} prepended first` +
        (pages > 0 ? `; shim injected into ${pages} extension page(s)` : '')
    );
  } else {
    emit('manifest-rewritten', 'Gecko id and manifest compatibility rewrites applied');
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

/**
 * Collect JavaScript payload entries as diagnostic sources.
 *
 * @param zip - In-memory ZIP archive of the extension payload.
 * @returns One source per `.js` file with its payload-relative path.
 */
function collectJavaScriptSources(zip: AdmZip): DiagnosticSource[] {
  const sources: DiagnosticSource[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.endsWith('.js')) {
      continue;
    }
    sources.push({ path: entry.entryName, content: entry.getData().toString('utf8') });
  }
  return sources;
}

/**
 * Produce a static compatibility report for a Chrome CRX3 extension.
 *
 * This is read-only: the source CRX is never modified and no XPI is written.
 * Findings are advisory — they flag Chrome-only API usage and `importScripts`
 * calls that need human review, but deliberately do not rewrite source code or
 * inject runtime shims (see `diagnostics.ts` for the rationale).
 *
 * @param crxPath - Path to the source `.crx` file.
 * @returns A deterministic diagnostic report for the payload.
 * @throws {ConversionError} When the file cannot be read or has no manifest.
 * @throws {CrxFormatError} When the CRX header is malformed.
 * @throws {ManifestValidationError} When the manifest fails schema validation.
 */
export function analyzeCrx(crxPath: string): DiagnosticReport {
  const { zip: zipBuffer } = unpackCrx(crxPath);
  const zip = new AdmZip(zipBuffer);
  const parseResult = parseManifest(loadZipManifest(zip));
  return buildDiagnosticReport(parseResult.manifest, collectJavaScriptSources(zip));
}

// ManifestValidationError is re-exported so callers of the engine can catch
// manifest problems without importing from the parser module directly.
export { ManifestValidationError };
