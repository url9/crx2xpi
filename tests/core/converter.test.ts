import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  POLYFILL_ENTRY_NAME,
  CHROME_SHIM_ENTRY_NAME,
  ConversionError,
  CrxFormatError,
  analyzeCrx,
  convertCrxToXpi,
  extractCrxZipPayload,
  injectChromeShimIntoHtml,
  parseCrx3Header,
} from '../../src/core/converter.js';
import { InvalidGeckoIdError } from '../../src/core/manifest-rewrite.js';
import { ManifestValidationError } from '../../src/parsers/manifest-parser.js';

/**
 * Build a synthetic CRX3 container from a ZIP payload.
 *
 * @param payload - ZIP archive bytes to embed after the CRX header.
 * @param options - Overrides for the header block and container version.
 * @returns A complete CRX3 file image.
 */
function buildCrx3(payload: Buffer, options?: { header?: Buffer; version?: number }): Buffer {
  const header = options?.header ?? Buffer.alloc(0);
  const version = options?.version ?? 3;
  const head = Buffer.alloc(12);
  head.write('Cr24', 0, 'ascii');
  head.writeUInt32LE(version, 4);
  head.writeUInt32LE(header.length, 8);
  return Buffer.concat([head, header, payload]);
}

/**
 * Build an in-memory ZIP archive for a minimal extension.
 *
 * @param manifest - Manifest object stored as manifest.json.
 * @param extraFiles - Additional payload entries by name.
 * @returns The ZIP archive bytes.
 */
function makeExtensionZip(
  manifest: Record<string, unknown>,
  extraFiles: Record<string, string> = {}
): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
  for (const [name, content] of Object.entries(extraFiles)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

const MV3_MANIFEST: Record<string, unknown> = {
  manifest_version: 3,
  name: 'Demo',
  version: '1.0.0',
  background: { service_worker: 'background.js' },
};

const MV2_MANIFEST: Record<string, unknown> = {
  manifest_version: 2,
  name: 'Legacy',
  version: '0.9.0',
  background: { scripts: ['legacy.js'], persistent: true },
};

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'crx2xpi-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('parseCrx3Header', () => {
  it('returns the declared header length and the payload offset after it', () => {
    const crx = buildCrx3(Buffer.from('zip-payload'), { header: Buffer.from('CRX3-HEADER') });
    expect(parseCrx3Header(crx)).toEqual({ headerLength: 11, payloadOffset: 23 });
  });

  it('rejects a buffer shorter than the fixed 12-byte header', () => {
    expect(() => parseCrx3Header(Buffer.alloc(8))).toThrow(CrxFormatError);
  });

  it('rejects a container without the Cr24 magic bytes', () => {
    const crx = buildCrx3(Buffer.from('payload'));
    crx.write('Xr24', 0, 'ascii');
    expect(() => parseCrx3Header(crx)).toThrow(/magic bytes/);
  });

  it('rejects CRX2 containers instead of misreading the CRX3 length field', () => {
    const crx = buildCrx3(Buffer.from('payload'), { version: 2 });
    expect(() => parseCrx3Header(crx)).toThrow(/version 2/);
  });

  it('rejects a declared header length that overruns the buffer', () => {
    const crx = buildCrx3(Buffer.from('payload'));
    crx.writeUInt32LE(5000, 8);
    expect(() => parseCrx3Header(crx)).toThrow(/overruns/);
  });
});

describe('extractCrxZipPayload', () => {
  it('returns exactly the bytes after magic, version and header block', () => {
    const payload = makeExtensionZip(MV3_MANIFEST);
    const crx = buildCrx3(payload, { header: Buffer.from('SIGNED-HEADER') });
    expect(Buffer.compare(extractCrxZipPayload(crx), payload)).toBe(0);
  });

  it('returns a payload even when the header block is empty', () => {
    const payload = Buffer.from('12345');
    expect(extractCrxZipPayload(buildCrx3(payload)).toString()).toBe('12345');
  });
});

describe('injectChromeShimIntoHtml', () => {
  it('inserts the shim script immediately after the opening head tag', () => {
    const html =
      '<!doctype html><html><head><meta charset="utf-8"></head>' +
      '<body><script src="app.js"></script></body></html>';
    expect(injectChromeShimIntoHtml(html, '../chrome-promise-shim.js')).toBe(
      '<!doctype html><html><head>' +
        '<script src="../chrome-promise-shim.js"></script>' +
        '<meta charset="utf-8"></head><body><script src="app.js"></script></body></html>'
    );
  });

  it('returns null for documents without any script element', () => {
    const html = '<html><head><title>static</title></head><body><p>hi</p></body></html>';
    expect(injectChromeShimIntoHtml(html, 'chrome-promise-shim.js')).toBeNull();
  });

  it('returns null when the document already references the shim (idempotence)', () => {
    const html =
      '<html><head><script src="chrome-promise-shim.js"></script>' +
      '<script src="app.js"></script></head></html>';
    expect(injectChromeShimIntoHtml(html, 'chrome-promise-shim.js')).toBeNull();
  });

  it('prepends the shim tag when the document has no head element', () => {
    const html = '<html><body><script src="app.js"></script></body></html>';
    expect(injectChromeShimIntoHtml(html, 'chrome-promise-shim.js')).toBe(
      '<script src="chrome-promise-shim.js"></script><html><body><script src="app.js"></script></body></html>'
    );
  });
});

describe('convertCrxToXpi', () => {
  it('downgrades an MV3 service worker and injects the shim and polyfill at package root', () => {
    const crxPath = join(workDir, 'demo.crx');
    const outputPath = join(workDir, 'dist', 'demo.xpi');
    writeFileSync(
      crxPath,
      buildCrx3(makeExtensionZip(MV3_MANIFEST, { 'background.js': 'init();' }))
    );

    const result = convertCrxToXpi(crxPath, outputPath);

    expect(existsSync(outputPath)).toBe(true);
    expect(result).toEqual({
      outputPath,
      manifestName: 'Demo',
      manifestVersion: 3,
      downgraded: true,
    });

    const xpi = new AdmZip(outputPath);
    const rewritten = JSON.parse(xpi.readAsText('manifest.json')) as {
      background?: { scripts?: string[]; persistent?: boolean; service_worker?: string };
    };
    expect(rewritten.background).toEqual({
      scripts: [CHROME_SHIM_ENTRY_NAME, POLYFILL_ENTRY_NAME, 'background.js'],
      persistent: false,
    });
    // The Chromium-only field must not survive into the Gecko manifest.
    expect(rewritten.background?.service_worker).toBeUndefined();
    expect(xpi.getEntry(POLYFILL_ENTRY_NAME)).not.toBeNull();
    expect(xpi.getEntry(CHROME_SHIM_ENTRY_NAME)).not.toBeNull();
    // Non-manifest payload files are carried over untouched.
    expect(xpi.readAsText('background.js')).toBe('init();');
  });

  it('preserves background.type=module so a downgraded worker can use static import', () => {
    const crxPath = join(workDir, 'module.crx');
    const outputPath = join(workDir, 'module.xpi');
    const moduleManifest: Record<string, unknown> = {
      ...MV3_MANIFEST,
      background: { service_worker: 'background.js', type: 'module' },
    };
    writeFileSync(
      crxPath,
      buildCrx3(
        makeExtensionZip(moduleManifest, {
          'background.js': 'import { x } from "./chunk.js"; console.log(x);',
          'chunk.js': 'export const x = 1;',
        })
      )
    );

    convertCrxToXpi(crxPath, outputPath);

    const rewritten = JSON.parse(new AdmZip(outputPath).readAsText('manifest.json')) as {
      background?: { scripts?: string[]; type?: string };
    };
    // Without type:"module" Firefox parses the import as classic-script syntax
    // and throws SyntaxError, so the background would never start.
    expect(rewritten.background).toEqual({
      scripts: [CHROME_SHIM_ENTRY_NAME, POLYFILL_ENTRY_NAME, 'background.js'],
      persistent: false,
      type: 'module',
    });
  });

  it('ships a chrome alias shim that no-ops where browser already exists', () => {
    const crxPath = join(workDir, 'demo.crx');
    const outputPath = join(workDir, 'demo.xpi');
    writeFileSync(crxPath, buildCrx3(makeExtensionZip(MV3_MANIFEST)));

    convertCrxToXpi(crxPath, outputPath);

    const shim = new AdmZip(outputPath).readAsText(CHROME_SHIM_ENTRY_NAME);
    // The shim only aliases chrome to the promise-capable browser namespace,
    // restoring Chromium semantics for `await chrome.*` calls on Firefox.
    expect(shim).toContain('globalThis.chrome = browser');
    expect(shim).toContain("typeof browser !== 'undefined'");
  });

  it('ships the official Mozilla webextension-polyfill bundle', () => {
    const crxPath = join(workDir, 'demo.crx');
    const outputPath = join(workDir, 'demo.xpi');
    writeFileSync(crxPath, buildCrx3(makeExtensionZip(MV3_MANIFEST)));

    convertCrxToXpi(crxPath, outputPath);

    const polyfill = new AdmZip(outputPath).readAsText(POLYFILL_ENTRY_NAME);
    // The injected asset must be the unmodified upstream dist build.
    expect(polyfill).toContain('webextension-polyfill');
    expect(polyfill).toContain('browser.runtime.id');
  });

  it('rewrites an MV2 manifest for Gecko but injects no shim or polyfill', () => {
    const crxPath = join(workDir, 'legacy.crx');
    const outputPath = join(workDir, 'legacy.xpi');
    writeFileSync(crxPath, buildCrx3(makeExtensionZip(MV2_MANIFEST, { 'legacy.js': 'a();' })));

    const result = convertCrxToXpi(crxPath, outputPath);

    expect(result.downgraded).toBe(false);
    const xpi = new AdmZip(outputPath);
    const manifest = JSON.parse(xpi.readAsText('manifest.json')) as Record<string, unknown>;
    // MV2 keeps its fields verbatim (including persistent:true) and gains a
    // stable Gecko id, but receives no service-worker shim or polyfill.
    expect(manifest).toEqual({
      ...MV2_MANIFEST,
      browser_specific_settings: { gecko: { id: '1432897a6136@crx2xpi.local' } },
    });
    expect(xpi.getEntry(POLYFILL_ENTRY_NAME)).toBeNull();
    expect(xpi.getEntry(CHROME_SHIM_ENTRY_NAME)).toBeNull();
  });

  it('injects the shim into scripted extension pages with correct relative paths', () => {
    const crxPath = join(workDir, 'pages.crx');
    const outputPath = join(workDir, 'pages.xpi');
    writeFileSync(
      crxPath,
      buildCrx3(
        makeExtensionZip(MV3_MANIFEST, {
          'background.js': 'init();',
          'popup.html': '<!doctype html><html><head><script src="popup.js"></script></head></html>',
          'ui/options/index.html':
            '<html><head><title>Options</title><script src="options.js" defer></script></head></html>',
        })
      )
    );

    convertCrxToXpi(crxPath, outputPath);

    const xpi = new AdmZip(outputPath);
    // Root-level pages reference the shim directly; nested pages must climb
    // out of their own directory or the browser would 404 inside the package.
    expect(xpi.readAsText('popup.html')).toContain(
      '<head><script src="chrome-promise-shim.js"></script>'
    );
    expect(xpi.readAsText('ui/options/index.html')).toContain(
      '<head><script src="../../chrome-promise-shim.js"></script>'
    );
  });

  it('leaves extension pages without scripts untouched', () => {
    const crxPath = join(workDir, 'static.crx');
    const outputPath = join(workDir, 'static.xpi');
    writeFileSync(
      crxPath,
      buildCrx3(
        makeExtensionZip(MV3_MANIFEST, {
          'background.js': 'init();',
          'banner.html': '<html><head></head><body><p>static</p></body></html>',
        })
      )
    );

    convertCrxToXpi(crxPath, outputPath);

    const banner = new AdmZip(outputPath).readAsText('banner.html');
    expect(banner).not.toContain('chrome-promise-shim.js');
  });

  it('never double-injects the shim when a page already references it', () => {
    const crxPath = join(workDir, 'prefab.crx');
    const outputPath = join(workDir, 'prefab.xpi');
    writeFileSync(
      crxPath,
      buildCrx3(
        makeExtensionZip(MV3_MANIFEST, {
          'background.js': 'init();',
          'popup.html': '<html><head><script src="chrome-promise-shim.js"></script></head></html>',
        })
      )
    );

    convertCrxToXpi(crxPath, outputPath);

    const popup = new AdmZip(outputPath).readAsText('popup.html');
    expect(popup.match(/chrome-promise-shim\.js/g)).toHaveLength(1);
  });

  it('rejects a payload without a manifest.json entry', () => {
    const crxPath = join(workDir, 'nolib.crx');
    const outputPath = join(workDir, 'nolib.xpi');
    const bare = new AdmZip();
    bare.addFile('background.js', Buffer.from('init();'));
    writeFileSync(crxPath, buildCrx3(bare.toBuffer()));

    expect(() => convertCrxToXpi(crxPath, outputPath)).toThrow(ConversionError);
  });

  it('propagates manifest schema violations as ManifestValidationError', () => {
    const crxPath = join(workDir, 'broken.crx');
    const outputPath = join(workDir, 'broken.xpi');
    writeFileSync(crxPath, buildCrx3(makeExtensionZip({ ...MV3_MANIFEST, manifest_version: 4 })));

    expect(() => convertCrxToXpi(crxPath, outputPath)).toThrow(ManifestValidationError);
  });

  it('reports unreadable input as ConversionError', () => {
    const missing = join(workDir, 'does-not-exist.crx');
    expect(() => convertCrxToXpi(missing, join(workDir, 'out.xpi'))).toThrow(ConversionError);
  });

  it('applies the safe manifest rewrites during an MV3 conversion', () => {
    const crxPath = join(workDir, 'rewrite.crx');
    const outputPath = join(workDir, 'rewrite.xpi');
    const manifest: Record<string, unknown> = {
      ...MV3_MANIFEST,
      update_url: 'https://clients2.google.com',
      key: 'chrome-key',
      permissions: ['storage', 'https://example.com/*'],
      content_security_policy: "script-src 'self'",
    };
    writeFileSync(crxPath, buildCrx3(makeExtensionZip(manifest, { 'background.js': 'init();' })));

    convertCrxToXpi(crxPath, outputPath);

    const rewritten = JSON.parse(new AdmZip(outputPath).readAsText('manifest.json')) as Record<
      string,
      unknown
    >;
    expect(rewritten.update_url).toBeUndefined();
    expect(rewritten.key).toBeUndefined();
    expect(rewritten.permissions).toEqual(['storage']);
    expect(rewritten.host_permissions).toEqual(['https://example.com/*']);
    expect(rewritten.content_security_policy).toEqual({ extension_pages: "script-src 'self'" });
    expect(rewritten.browser_specific_settings).toEqual({
      gecko: { id: '8a2cc0673b1c@crx2xpi.local' },
    });
    // Downgrade-specific fields are still present alongside the rewrites.
    expect(rewritten.background).toEqual({
      scripts: [CHROME_SHIM_ENTRY_NAME, POLYFILL_ENTRY_NAME, 'background.js'],
      persistent: false,
    });
  });

  it('applies a valid customGeckoId end to end', () => {
    const crxPath = join(workDir, 'demo.crx');
    const outputPath = join(workDir, 'demo-custom-id.xpi');
    writeFileSync(crxPath, buildCrx3(makeExtensionZip(MV3_MANIFEST)));

    convertCrxToXpi(crxPath, outputPath, { customGeckoId: 'my-ext@domain.com' });

    const rewritten = JSON.parse(new AdmZip(outputPath).readAsText('manifest.json')) as Record<
      string,
      unknown
    >;
    expect(rewritten.browser_specific_settings).toEqual({
      gecko: { id: 'my-ext@domain.com' },
    });
  });

  it('throws InvalidGeckoIdError before any conversion work for a malformed customGeckoId', () => {
    const crxPath = join(workDir, 'demo.crx');
    writeFileSync(crxPath, buildCrx3(makeExtensionZip(MV3_MANIFEST)));
    const outputPath = join(workDir, 'demo-bad-id.xpi');

    expect(() =>
      convertCrxToXpi(crxPath, outputPath, { customGeckoId: '悦览@local' })
    ).toThrowError(InvalidGeckoIdError);
    // Fail-fast contract: no output file may exist for a rejected id.
    expect(existsSync(outputPath)).toBe(false);
  });

  it('round-trips a real converted XPI through the unpacking path again', () => {
    const crxPath = join(workDir, 'demo.crx');
    const outputPath = join(workDir, 'demo.xpi');
    writeFileSync(crxPath, buildCrx3(makeExtensionZip(MV3_MANIFEST)));

    convertCrxToXpi(crxPath, outputPath);

    // The produced XPI is a plain ZIP whose manifest validates as MV2-shaped
    // background scripts, proving the downgrade output is itself parseable.
    // Entry count: manifest + the two injected compatibility assets.
    const xpiBytes = readFileSync(outputPath);
    const zip = new AdmZip(xpiBytes);
    expect(zip.getEntry('manifest.json')).not.toBeNull();
    expect(zip.getEntryCount()).toBe(3);
  });
});

describe('analyzeCrx', () => {
  it('reports Chrome-only API usage without modifying the source CRX', () => {
    const crxPath = join(workDir, 'analyze.crx');
    const before = buildCrx3(
      makeExtensionZip(MV3_MANIFEST, {
        'background.js': 'chrome.offscreen.createDocument({});',
        'ui/popup.js': 'chrome.tabGroups.query({});',
      })
    );
    writeFileSync(crxPath, before);

    const report = analyzeCrx(crxPath);

    expect(report.name).toBe('Demo');
    expect(report.scannedFiles).toBe(2);
    expect(report.findings.map((finding) => finding.code)).toEqual([
      'chrome.offscreen',
      'chrome.tabGroups',
    ]);
    // Read-only: the input file is byte-identical after analysis.
    expect(readFileSync(crxPath)).toEqual(before);
  });

  it('returns an empty finding set when no Chrome-only API is used', () => {
    const crxPath = join(workDir, 'clean.crx');
    writeFileSync(
      crxPath,
      buildCrx3(makeExtensionZip(MV3_MANIFEST, { 'background.js': 'chrome.tabs.query({});' }))
    );

    expect(analyzeCrx(crxPath).findings).toEqual([]);
  });

  it('propagates header and manifest errors like the converter', () => {
    const missing = join(workDir, 'missing.crx');
    expect(() => analyzeCrx(missing)).toThrow(ConversionError);
  });
});
