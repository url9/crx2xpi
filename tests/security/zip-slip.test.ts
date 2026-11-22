import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertCrxToXpi } from '../../src/core/converter.js';

/**
 * Wrap a raw ZIP payload in a minimal CRX3 container (zero-length header).
 *
 * @param payload - ZIP archive bytes to embed after the 12-byte CRX header.
 * @returns A complete CRX3 file image.
 */
function buildCrx3(payload: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.write('Cr24', 0, 'ascii');
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(0, 8);
  return Buffer.concat([head, payload]);
}

/**
 * Recursively list every file below a directory as root-relative POSIX paths.
 *
 * @param dir - Directory to walk.
 * @param base - Root used to compute relative paths (defaults to `dir`).
 * @returns Relative file paths using forward slashes.
 */
function listFilesRecursive(dir: string, base: string = dir): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFilesRecursive(full, base));
    } else {
      found.push(relative(base, full).split(sep).join('/'));
    }
  }
  return found;
}

/** Paths an untrusted archive must never be able to write outside the target. */
const MALICIOUS_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['../../evil-up.js', 'EVIL-UP'],
  ['/abs/evil-abs.js', 'EVIL-ABS'],
  ['..\\..\\evil-win.js', 'EVIL-WIN'],
];

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'crx2xpi-zipslip-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Run a conversion with `keepTempDir: true` and return the extracted directory.
 *
 * The debug extraction path calls `AdmZip.extractAllTo` on the repacked payload,
 * which is the same code path a real user hits when inspecting a conversion.
 *
 * @param extraEntries - Additional ZIP entries to inject into the extension.
 * @returns The extracted payload directory reported by the converter.
 */
function convertWithTempDir(extraEntries: ReadonlyArray<readonly [string, string]>): string {
  const zip = new AdmZip();
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify({ manifest_version: 3, name: 'ZipSlip Probe', version: '1.0.0' }),
      'utf8'
    )
  );
  zip.addFile('good.txt', Buffer.from('legit-content', 'utf8'));
  for (const [name, content] of extraEntries) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }

  const crxPath = join(workDir, 'input.crx');
  const xpiPath = join(workDir, 'output.xpi');
  writeFileSync(crxPath, buildCrx3(zip.toBuffer()));

  const result = convertCrxToXpi(crxPath, xpiPath, { keepTempDir: true });
  expect(result.tempDir).toBeDefined();
  return result.tempDir as string;
}

describe('Zip Slip traversal containment', () => {
  it('keeps every extracted file inside the target directory', () => {
    const tempDir = convertWithTempDir(MALICIOUS_ENTRIES);
    try {
      const root = resolve(tempDir);
      const files = listFilesRecursive(root);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const absolute = resolve(root, file);
        expect(absolute.startsWith(`${root}${sep}`)).toBe(true);
        expect(file.split('/')).not.toContain('..');
        expect(file.startsWith('/')).toBe(false);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('clamps malicious entries into the target instead of escaping it', () => {
    const tempDir = convertWithTempDir(MALICIOUS_ENTRIES);
    try {
      const root = resolve(tempDir);
      // Walk up from the target and assert no escaped payload landed alongside
      // it. The grandparent is enough to catch `../..` and `/abs` payloads.
      const grandparent = dirname(dirname(root));
      const escaped = ['evil-up.js', 'evil-abs.js', 'evil-win.js'].some((name) =>
        existsSync(join(grandparent, name))
      );
      expect(escaped).toBe(false);

      // The malicious payload bytes must still be present, now under the clamped
      // root-relative names. Matching by content proves containment rather than
      // silent dropping, without depending on the exact rename adm-zip chooses.
      const contents = listFilesRecursive(root).map((file) =>
        readFileSync(join(root, file), 'utf8')
      );
      for (const [, marker] of MALICIOUS_ENTRIES) {
        expect(contents).toContain(marker);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts a legitimate control entry unchanged alongside malicious ones', () => {
    const tempDir = convertWithTempDir(MALICIOUS_ENTRIES);
    try {
      const root = resolve(tempDir);
      const goodPath = join(root, 'good.txt');
      expect(existsSync(goodPath)).toBe(true);
      expect(readFileSync(goodPath, 'utf8')).toBe('legit-content');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
