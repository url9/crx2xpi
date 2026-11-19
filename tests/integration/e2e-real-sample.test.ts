import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  POLYFILL_ENTRY_NAME,
  CHROME_SHIM_ENTRY_NAME,
  convertCrxToXpi,
  extractCrxZipPayload,
  parseCrx3Header,
} from '../../src/core/converter.js';

/** Declarative description of one committed real-world CRX3 sample. */
interface SampleSpec {
  /** Fixture filename under tests/fixtures, including the developer suffix. */
  file: string;
  /** Signed-header size in bytes, as produced by the real packer. */
  headerLength: number;
  /** Byte offset where the ZIP payload starts (12 + headerLength). */
  payloadOffset: number;
  /** Every payload entry name, sorted, including directory markers. */
  payloadEntries: string[];
  /** Manifest name the engine must report back. */
  manifestName: string;
  /** The MV3 service_worker entry the downgrade must move into scripts. */
  serviceWorker: string;
  /** Expected background.type in the downgraded manifest, when declared. */
  backgroundType?: 'classic' | 'module';
  /** Files verified byte-for-byte after conversion; manifest excluded. */
  untouchedFiles: string[];
}

/**
 * The committed fixture is the project's own synthetic CRX3 container,
 * packed with the official `crx3` tool (small signed header). Regenerate with:
 * `pnpm dlx crx3 extension/ -o sample-mv3.crx -p key.pem`
 *
 * Third-party extension binaries are deliberately not checked in:
 * redistributing them is not license-compliant. Production-shaped inputs are
 * covered by the synthetic in-memory CRX builders in the unit tests instead.
 *
 * Naming rule: `<extension-name> (<developer>).<ext>` — a space, then the
 * developer name in ASCII parentheses. Applies to every extension binary in
 * the repository (see .codebuddy/rules/testing-and-ci.md).
 */
const SAMPLES: SampleSpec[] = [
  {
    file: 'sample-mv3 (crx2xpi).crx',
    headerLength: 581,
    payloadOffset: 593,
    payloadEntries: ['background.js', 'content.js', 'manifest.json'],
    manifestName: 'crx2xpi E2E Sample',
    serviceWorker: 'background.js',
    untouchedFiles: ['background.js', 'content.js'],
  },
];

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'crx2xpi-e2e-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Register the full conversion assertions for one committed real sample:
 * fixture genuineness, service_worker downgrade, and payload fidelity.
 *
 * @param spec - Declarative sample description; see {@link SampleSpec}.
 */
function registerRealSampleSuite(spec: SampleSpec): void {
  const fixtureBytes = (): Buffer =>
    readFileSync(new URL(`../fixtures/${spec.file}`, import.meta.url));

  describe(`e2e: ${spec.file}`, () => {
    it('fixture is a genuine CRX3 container with the expected production layout', () => {
      const bytes = fixtureBytes();
      // Sanity guard: the committed binary must never silently become synthetic.
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('Cr24');
      expect(parseCrx3Header(bytes)).toMatchObject({
        headerLength: spec.headerLength,
        payloadOffset: spec.payloadOffset,
      });

      const payload = new AdmZip(extractCrxZipPayload(bytes));
      expect(
        payload
          .getEntries()
          .map((e) => e.entryName)
          .sort()
      ).toEqual(spec.payloadEntries);
    });

    it('converts the sample and downgrades the MV3 service worker', () => {
      const crxPath = join(workDir, spec.file);
      const outputPath = join(workDir, `${spec.file.replace(/\.crx$/, '')}.xpi`);
      writeFileSync(crxPath, fixtureBytes());

      const result = convertCrxToXpi(crxPath, outputPath);

      expect(result).toEqual({
        outputPath,
        manifestName: spec.manifestName,
        manifestVersion: 3,
        downgraded: true,
      });

      const xpi = new AdmZip(readFileSync(outputPath));
      const manifest = JSON.parse(xpi.readAsText('manifest.json')) as {
        background?: {
          scripts?: string[];
          persistent?: boolean;
          service_worker?: string;
          type?: 'classic' | 'module';
        };
      };

      // The Chromium-only service_worker must be gone, replaced by the
      // event-page scripts form with the shim and polyfill evaluated first.
      // A module worker keeps its `type` so static `import` stays parseable
      // in Firefox.
      expect(manifest.background).toEqual({
        scripts: [CHROME_SHIM_ENTRY_NAME, POLYFILL_ENTRY_NAME, spec.serviceWorker],
        persistent: false,
        ...(spec.backgroundType === undefined ? {} : { type: spec.backgroundType }),
      });
      expect(manifest.background?.service_worker).toBeUndefined();
      expect(xpi.getEntry(POLYFILL_ENTRY_NAME)).not.toBeNull();
      expect(xpi.getEntry(CHROME_SHIM_ENTRY_NAME)).not.toBeNull();
    });

    it('preserves every non-manifest payload file byte-for-byte', () => {
      const crxPath = join(workDir, spec.file);
      const outputPath = join(workDir, `${spec.file.replace(/\.crx$/, '')}.xpi`);
      writeFileSync(crxPath, fixtureBytes());

      convertCrxToXpi(crxPath, outputPath);

      const original = new AdmZip(extractCrxZipPayload(fixtureBytes()));
      const converted = new AdmZip(readFileSync(outputPath));

      for (const name of spec.untouchedFiles) {
        const before = original.getEntry(name)?.getData();
        const after = converted.getEntry(name)?.getData();
        expect(after, `${name} must survive conversion`).toBeDefined();
        // Byte-for-byte comparison: repackaging may not alter payload content
        // (for _metadata this keeps Web Store content verification intact).
        expect(Buffer.compare(before as Buffer, after as Buffer)).toBe(0);
      }

      // The XPI adds exactly the two compatibility assets on top of the
      // original payload.
      const expectedEntries = [
        ...spec.payloadEntries,
        CHROME_SHIM_ENTRY_NAME,
        POLYFILL_ENTRY_NAME,
      ].sort();
      expect(
        converted
          .getEntries()
          .map((e) => e.entryName)
          .sort()
      ).toEqual(expectedEntries);
    });
  });
}

for (const spec of SAMPLES) {
  registerRealSampleSuite(spec);
}
