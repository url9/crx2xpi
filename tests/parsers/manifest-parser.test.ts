import { describe, expect, it } from 'vitest';
import {
  downgradeServiceWorker,
  ManifestValidationError,
  parseManifest,
  type WebExtensionManifest,
} from '../../src/parsers/manifest-parser.js';

/**
 * Build a valid MV3 manifest fixture with a background service worker.
 *
 * @returns A fresh fixture so each test starts from an isolated object.
 */
function makeMv3Manifest(): WebExtensionManifest {
  return {
    manifest_version: 3,
    name: 'demo',
    version: '1.0.0',
    background: { service_worker: 'sw.js' },
  };
}

/**
 * Build a valid MV2 manifest fixture using background scripts.
 *
 * @returns A fresh fixture so each test starts from an isolated object.
 */
function makeMv2Manifest(): WebExtensionManifest {
  return {
    manifest_version: 2,
    name: 'demo',
    version: '1.0.0',
    background: { scripts: ['bg.js'] },
  };
}

describe('parseManifest — happy path', () => {
  it('extracts an MV3 background.service_worker into a Gecko downgrade plan', () => {
    const raw = makeMv3Manifest();

    const result = parseManifest(raw);

    expect(result.manifest).toEqual(raw);
    expect(result.downgradeApplied).toBe(true);
    expect(result.geckoBackground).toEqual({ scripts: ['sw.js'], persistent: false });
  });

  it('keeps existing background scripts and appends the worker to the plan', () => {
    const raw: WebExtensionManifest = {
      ...makeMv3Manifest(),
      background: { service_worker: 'sw.js', scripts: ['polyfill.js'] },
    };

    const result = parseManifest(raw);

    expect(result.geckoBackground?.scripts).toEqual(['polyfill.js', 'sw.js']);
    expect(result.geckoBackground?.persistent).toBe(false);
  });

  it('carries a module worker type into the downgrade plan', () => {
    const raw: WebExtensionManifest = {
      ...makeMv3Manifest(),
      background: { service_worker: 'sw.js', type: 'module' },
    };

    const result = parseManifest(raw);

    // Static `import` in the worker only parses in Firefox when the downgraded
    // scripts are also marked as modules.
    expect(result.geckoBackground).toEqual({
      scripts: ['sw.js'],
      persistent: false,
      type: 'module',
    });
  });

  it('does not mutate the raw input object', () => {
    const raw = makeMv3Manifest();

    parseManifest(raw);

    expect(raw.background).toEqual({ service_worker: 'sw.js' });
  });

  it('produces no downgrade plan for MV3 without a service worker', () => {
    const raw: WebExtensionManifest = {
      manifest_version: 3,
      name: 'no-worker',
      version: '1.0.0',
    };

    const result = parseManifest(raw);

    expect(result.downgradeApplied).toBe(false);
    expect(result.geckoBackground).toBeUndefined();
  });
});

describe('parseManifest — missing / invalid fields', () => {
  it.each([
    ['null', null],
    ['a string', 'manifest'],
    ['an array', [1, 2]],
    ['a number', 42],
  ])('rejects %s as manifest root', (_label, raw) => {
    expect(() => parseManifest(raw)).toThrow(ManifestValidationError);
  });

  it('rejects a manifest without manifest_version', () => {
    const raw = { name: 'demo', version: '1.0.0' };

    expect(() => parseManifest(raw)).toThrow(/manifest_version/);
  });

  it('rejects an unsupported manifest_version (e.g. 4)', () => {
    const raw = { manifest_version: 4, name: 'demo', version: '1.0.0' };

    expect(() => parseManifest(raw)).toThrow(/manifest_version/);
  });

  it('rejects a manifest without a name', () => {
    const raw = { manifest_version: 3, version: '1.0.0' };

    expect(() => parseManifest(raw)).toThrow(/name/);
  });

  it('rejects a manifest with an empty version', () => {
    const raw = { manifest_version: 3, name: 'demo', version: '   ' };

    expect(() => parseManifest(raw)).toThrow(/version/);
  });

  it('rejects a non-object background section', () => {
    const raw = { ...makeMv3Manifest(), background: 'sw.js' };

    expect(() => parseManifest(raw)).toThrow(/background/);
  });

  it('rejects a MV3 service_worker that is not a string', () => {
    const raw = { ...makeMv3Manifest(), background: { service_worker: 7 } };

    expect(() => parseManifest(raw)).toThrow(/service_worker/);
  });

  it('rejects a background.type that is neither classic nor module', () => {
    const raw = { ...makeMv3Manifest(), background: { service_worker: 'sw.js', type: 'worker' } };

    expect(() => parseManifest(raw)).toThrow(/background.type/);
  });

  it('rejects background.scripts containing non-string entries', () => {
    const raw = {
      ...makeMv3Manifest(),
      background: { scripts: ['bg.js', 3] },
    };

    expect(() => parseManifest(raw)).toThrow(/scripts/);
  });

  it('rejects a background.persistent that is not boolean', () => {
    const raw = { ...makeMv2Manifest(), background: { scripts: ['bg.js'], persistent: 'yes' } };

    expect(() => parseManifest(raw)).toThrow(/persistent/);
  });
});

describe('parseManifest — legacy MV2', () => {
  it('accepts MV2 and produces no downgrade plan', () => {
    const raw = makeMv2Manifest();

    const result = parseManifest(raw);

    expect(result.downgradeApplied).toBe(false);
    expect(result.geckoBackground).toBeUndefined();
    expect(result.manifest.background).toEqual({ scripts: ['bg.js'] });
  });

  it('preserves a valid background.persistent flag for MV2', () => {
    const raw: WebExtensionManifest = {
      ...makeMv2Manifest(),
      background: { scripts: ['bg.js'], persistent: true },
    };

    expect(parseManifest(raw).manifest.background).toEqual({
      scripts: ['bg.js'],
      persistent: true,
    });
  });

  it('rejects an MV2 manifest that declares a service_worker', () => {
    const raw = {
      ...makeMv2Manifest(),
      background: { service_worker: 'sw.js', scripts: ['bg.js'] },
    };

    expect(() => parseManifest(raw)).toThrow(/MV2/);
  });

  it('accepts an MV2 manifest without any background section', () => {
    const raw: WebExtensionManifest = {
      manifest_version: 2,
      name: 'plain',
      version: '0.1.0',
    };

    const result = parseManifest(raw);

    expect(result.manifest.background).toBeUndefined();
    expect(result.geckoBackground).toBeUndefined();
  });
});

describe('downgradeServiceWorker', () => {
  it('converts an MV3 service_worker into background.scripts in place', () => {
    const manifest = makeMv3Manifest();

    const result = downgradeServiceWorker(manifest);

    expect(result.background?.scripts).toEqual(['sw.js']);
    expect(result.background?.service_worker).toBeUndefined();
  });

  it('preserves existing background scripts and appends the worker', () => {
    const manifest: WebExtensionManifest = {
      ...makeMv3Manifest(),
      background: { service_worker: 'sw.js', scripts: ['polyfill.js'] },
    };

    downgradeServiceWorker(manifest);

    expect(manifest.background?.scripts).toEqual(['polyfill.js', 'sw.js']);
  });

  it('is idempotent when the worker is already present', () => {
    const manifest: WebExtensionManifest = {
      ...makeMv3Manifest(),
      background: { service_worker: 'sw.js', scripts: ['sw.js'] },
    };

    downgradeServiceWorker(manifest);

    expect(manifest.background?.scripts).toEqual(['sw.js']);
  });

  it('leaves MV2 manifests untouched', () => {
    const manifest = makeMv2Manifest();

    downgradeServiceWorker(manifest);

    expect(manifest.background).toEqual({ scripts: ['bg.js'] });
  });
});
