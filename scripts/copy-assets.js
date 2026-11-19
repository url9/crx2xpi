/**
 * Copies the bundled compatibility assets into dist/.
 *
 * tsc only compiles TypeScript sources, so the vendored assets would be
 * missing from dist/ and the published CLI would fail at conversion time
 * ("asset is missing"). The build therefore runs this script after tsc to
 * mirror src/assets into dist/assets.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcAssetsDir = fileURLToPath(new URL('../src/assets/', import.meta.url));
const outDir = fileURLToPath(new URL('../dist/assets/', import.meta.url));

mkdirSync(outDir, { recursive: true });
for (const name of readdirSync(srcAssetsDir)) {
  copyFileSync(join(srcAssetsDir, name), join(outDir, name));
  process.stdout.write(`copied asset ${name} to ${join(outDir, name)}\n`);
}
