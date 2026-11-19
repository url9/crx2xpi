/**
 * Copies the bundled browser-polyfill asset into dist/.
 *
 * tsc only compiles TypeScript sources, so the vendored polyfill asset would
 * be missing from dist/ and the published CLI would fail at conversion time
 * ("polyfill asset is missing"). The build therefore runs this script after
 * tsc to mirror src/assets into dist/assets.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcAsset = fileURLToPath(new URL('../src/assets/polyfill.js', import.meta.url));
const outDir = fileURLToPath(new URL('../dist/assets/', import.meta.url));
const outAsset = join(outDir, 'polyfill.js');

mkdirSync(outDir, { recursive: true });
copyFileSync(srcAsset, outAsset);
process.stdout.write(`copied polyfill asset to ${outAsset}\n`);
