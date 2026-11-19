import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  POLYFILL_ENTRY_NAME,
  convertCrxToXpi,
  extractCrxZipPayload,
  parseCrx3Header,
} from '../../src/core/converter.js';

/**
 * End-to-end fixture: a REAL CRX3 container (not a synthetic buffer) produced
 * with the official `crx3` packing tool from a minimal MV3 extension.
 *
 * Regenerate with:
 *   pnpm dlx crx3 extension/ -o sample-mv3.crx -p key.pem
 * The self-signed RSA header makes the signed-header block a genuine CRX3
 * protobuf, so header offsets are exercised against production layout.
 */
const FIXTURE_PATH = new URL('../fixtures/sample-mv3.crx', import.meta.url);
const EXPECTED_PAYLOAD_FILES = ['background.js', 'content.js', 'manifest.json'];
// manifest.json is the one entry the engine is EXPECTED to rewrite; it is
// verified separately and must never take part in the untouched-bytes check.
const UNTOUCHED_PAYLOAD_FILES = ['background.js', 'content.js'];

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'crx2xpi-e2e-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('e2e: real CRX3 sample conversion', () => {
  const fixtureBytes = (): Buffer => readFileSync(FIXTURE_PATH);

  it('fixture is a genuine CRX3 container with a signed header', () => {
    const bytes = fixtureBytes();
    // Sanity guard: the committed binary must never silently become synthetic.
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('Cr24');
    expect(parseCrx3Header(bytes)).toMatchObject({ headerLength: 581, payloadOffset: 593 });

    const payload = new AdmZip(extractCrxZipPayload(bytes));
    expect(
      payload
        .getEntries()
        .map((e) => e.entryName)
        .sort()
    ).toEqual(EXPECTED_PAYLOAD_FILES);
  });

  it('converts the real sample and downgrades the MV3 service worker', () => {
    const crxPath = join(workDir, 'sample-mv3.crx');
    const outputPath = join(workDir, 'sample-mv3.xpi');
    writeFileSync(crxPath, fixtureBytes());

    const result = convertCrxToXpi(crxPath, outputPath);

    expect(result).toEqual({
      outputPath,
      manifestName: 'crx2xpi E2E Sample',
      manifestVersion: 3,
      downgraded: true,
    });

    const xpi = new AdmZip(readFileSync(outputPath));
    const manifest = JSON.parse(xpi.readAsText('manifest.json')) as {
      background?: { scripts?: string[]; persistent?: boolean; service_worker?: string };
    };

    // The Chromium-only service_worker must be gone, replaced by the
    // event-page scripts form with the polyfill evaluated first.
    expect(manifest.background).toEqual({
      scripts: [POLYFILL_ENTRY_NAME, 'background.js'],
      persistent: false,
    });
    expect(manifest.background?.service_worker).toBeUndefined();
    expect(xpi.getEntry(POLYFILL_ENTRY_NAME)).not.toBeNull();
  });

  it('preserves every non-manifest payload file byte-for-byte', () => {
    const crxPath = join(workDir, 'sample-mv3.crx');
    const outputPath = join(workDir, 'sample-mv3.xpi');
    writeFileSync(crxPath, fixtureBytes());

    convertCrxToXpi(crxPath, outputPath);

    const original = new AdmZip(extractCrxZipPayload(fixtureBytes()));
    const converted = new AdmZip(readFileSync(outputPath));

    for (const name of UNTOUCHED_PAYLOAD_FILES) {
      const before = original.getEntry(name)?.getData();
      const after = converted.getEntry(name)?.getData();
      expect(after, `${name} must survive conversion`).toBeDefined();
      // Byte-for-byte comparison: repackaging may not alter payload content.
      expect(Buffer.compare(before as Buffer, after as Buffer)).toBe(0);
    }

    // The XPI adds exactly the polyfill on top of the original payload.
    const expectedEntries = [...EXPECTED_PAYLOAD_FILES, POLYFILL_ENTRY_NAME].sort();
    expect(
      converted
        .getEntries()
        .map((e) => e.entryName)
        .sort()
    ).toEqual(expectedEntries);
  });
});
