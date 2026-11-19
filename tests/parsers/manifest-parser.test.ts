import { describe, expect, it } from 'vitest';
import {
  downgradeServiceWorker,
  type WebExtensionManifest,
} from '../../src/parsers/manifest-parser.js';

/**
 * Build a fresh MV3 manifest fixture so each test starts from an isolated object.
 *
 * @returns A minimal MV3 manifest with a service_worker and no background field.
 */
function makeMv3Manifest(): WebExtensionManifest {
  return {
    manifest_version: 3,
    name: 'demo',
    service_worker: 'sw.js',
  };
}

describe('downgradeServiceWorker', () => {
  it('converts an MV3 service_worker into background.scripts', () => {
    const manifest = makeMv3Manifest();

    const result = downgradeServiceWorker(manifest);

    expect(result.background?.scripts).toEqual(['sw.js']);
    expect(result.service_worker).toBeUndefined();
  });

  it('preserves existing background scripts and appends the worker', () => {
    const manifest: WebExtensionManifest = {
      manifest_version: 3,
      service_worker: 'sw.js',
      background: { scripts: ['polyfill.js'] },
    };

    downgradeServiceWorker(manifest);

    expect(manifest.background?.scripts).toEqual(['polyfill.js', 'sw.js']);
  });

  it('is idempotent when the worker is already present', () => {
    const manifest: WebExtensionManifest = {
      manifest_version: 3,
      service_worker: 'sw.js',
      background: { scripts: ['sw.js'] },
    };

    downgradeServiceWorker(manifest);

    expect(manifest.background?.scripts).toEqual(['sw.js']);
  });

  it('leaves MV2 manifests untouched', () => {
    const manifest: WebExtensionManifest = {
      manifest_version: 2,
      service_worker: 'sw.js',
    };

    downgradeServiceWorker(manifest);

    expect(manifest.service_worker).toBe('sw.js');
    expect(manifest.background).toBeUndefined();
  });

  it('leaves MV3 manifests without a service_worker untouched', () => {
    const manifest: WebExtensionManifest = {
      manifest_version: 3,
      name: 'no-worker',
    };

    downgradeServiceWorker(manifest);

    expect(manifest.background).toBeUndefined();
    expect(manifest.name).toBe('no-worker');
  });
});
