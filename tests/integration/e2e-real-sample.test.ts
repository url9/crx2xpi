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
 * All committed fixtures are REAL CRX3 containers, each exercising a
 * different production axis:
 *
 * - `sample-mv3 (crx2xpi).crx` — synthetic minimal sample packed with the
 *   official `crx3` tool (small signed header). Regenerate with:
 *   `pnpm dlx crx3 extension/ -o sample-mv3.crx -p key.pem`
 * - `chrome-remote-desktop (Google).crx` — official Chrome Web Store build
 *   (Google-signed large header + `_metadata/verified_contents.json`).
 * - `digital-memory (pankajdhameliya).crx` — indie-developer Vite build
 *   (module-type service_worker, 30+ bundled assets, `_metadata/`).
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
  {
    file: 'chrome-remote-desktop (Google).crx',
    headerLength: 1309,
    payloadOffset: 1321,
    payloadEntries: [
      '_metadata/',
      '_metadata/verified_contents.json',
      'chromoting128.png',
      'chromoting48.png',
      'event_page_binary.js',
      'manifest.json',
    ],
    manifestName: 'Chrome Remote Desktop',
    serviceWorker: 'event_page_binary.js',
    untouchedFiles: [
      '_metadata/verified_contents.json',
      'chromoting128.png',
      'chromoting48.png',
      'event_page_binary.js',
    ],
  },
  {
    file: 'digital-memory (pankajdhameliya).crx',
    headerLength: 1309,
    payloadOffset: 1321,
    payloadEntries: [
      '_metadata/',
      '_metadata/verified_contents.json',
      'assets/chunk-BoLyMdNB.js',
      'assets/chunk-CCGN3lja.js',
      'assets/chunk-CWs-kNBM.js',
      'assets/chunk-CfnOVvxt.js',
      'assets/chunk-CqtLmHto.js',
      'assets/chunk-D-WzIiMq.js',
      'assets/chunk-DFF8H6gq.js',
      'assets/chunk-DGH2ApZi.js',
      'assets/chunk-DLw8Ve-Q.js',
      'assets/chunk-FR0lKTDZ.js',
      'assets/chunk-HAwQ1aUs.js',
      'assets/chunk-bjXwXwo3.js',
      'assets/dashboard-CsLN3Agy.js',
      'assets/dm-toy-C_3HW79i.css',
      'assets/offscreen-BX9BLJue.js',
      'assets/pdf.worker.min.mjs',
      'assets/popup-Dk7lWfbm.js',
      'assets/sidepanel-DQ4Hd_bW.js',
      'background.js',
      'content.js',
      'icons/icon-128.png',
      'icons/icon-16.png',
      'icons/icon-32.png',
      'icons/icon-48.png',
      'manifest.json',
      'src/dashboard/index.html',
      'src/offscreen/index.html',
      'src/popup/index.html',
      'src/sidepanel/index.html',
      'theme-boot.js',
    ],
    manifestName: 'Digital Memory',
    serviceWorker: 'background.js',
    // The source worker is an ES module (static `import`); the flag must be
    // preserved or Firefox throws SyntaxError and the background never starts.
    backgroundType: 'module',
    untouchedFiles: [
      '_metadata/verified_contents.json',
      'assets/pdf.worker.min.mjs',
      'background.js',
      'content.js',
      'icons/icon-128.png',
      'theme-boot.js',
    ],
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
      // event-page scripts form with the polyfill evaluated first. A module
      // worker keeps its `type` so static `import` stays parseable in Firefox.
      expect(manifest.background).toEqual({
        scripts: [POLYFILL_ENTRY_NAME, spec.serviceWorker],
        persistent: false,
        ...(spec.backgroundType === undefined ? {} : { type: spec.backgroundType }),
      });
      expect(manifest.background?.service_worker).toBeUndefined();
      expect(xpi.getEntry(POLYFILL_ENTRY_NAME)).not.toBeNull();
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

      // The XPI adds exactly the polyfill on top of the original payload.
      const expectedEntries = [...spec.payloadEntries, POLYFILL_ENTRY_NAME].sort();
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
