import { describe, expect, it } from 'vitest';
import type { WebExtensionManifest } from '../../src/parsers/manifest-parser.js';
import {
  injectGeckoId,
  normalizeContentSecurityPolicy,
  removeChromeOnlyFields,
  renameBrowserAction,
  rewriteManifestForGecko,
  sanitizeExtensionIdLocalPart,
  sanitizeWebAccessibleResources,
  splitHostPermissions,
} from '../../src/core/manifest-rewrite.js';

/**
 * Build a minimal MV3 manifest fixture.
 *
 * @returns A fresh manifest with no optional fields.
 */
function mv3(): WebExtensionManifest {
  return { manifest_version: 3, name: 'Demo', version: '1.0.0' };
}

describe('sanitizeExtensionIdLocalPart', () => {
  it('lowercases and collapses illegal characters into hyphens', () => {
    expect(sanitizeExtensionIdLocalPart('My Cool.Extension')).toBe('my-cool.extension');
  });

  it('trims leading and trailing separators', () => {
    expect(sanitizeExtensionIdLocalPart('-Test_')).toBe('test_');
  });

  it('falls back to a stable hash for an all-non-ASCII name', () => {
    const a = sanitizeExtensionIdLocalPart('暗色阅读器');
    const b = sanitizeExtensionIdLocalPart('暗色阅读器');
    expect(a).toBe(b);
    expect(a).toMatch(/^ext-[0-9a-f]+$/);
    expect(sanitizeExtensionIdLocalPart('别的名字')).not.toBe(a);
  });
});

describe('injectGeckoId', () => {
  it('adds an email-style id derived from the name', () => {
    const result = injectGeckoId(mv3());
    const settings = result.browser_specific_settings as {
      gecko: { id: string };
    };
    expect(settings.gecko.id).toBe('demo@crx2xpi.local');
  });

  it('never overwrites an existing non-empty id', () => {
    const manifest: WebExtensionManifest = {
      ...mv3(),
      browser_specific_settings: {
        gecko: { id: 'keep-me@example.com', strict_min_version: '115.0' },
      },
    };
    const result = injectGeckoId(manifest);
    expect(result).toBe(manifest);
    expect(result.browser_specific_settings).toEqual(manifest.browser_specific_settings);
  });

  it('preserves sibling gecko keys when only the id is missing', () => {
    const manifest: WebExtensionManifest = {
      ...mv3(),
      browser_specific_settings: { gecko: { strict_min_version: '121.0' } },
    };
    const result = injectGeckoId(manifest);
    expect(result.browser_specific_settings).toEqual({
      gecko: { strict_min_version: '121.0', id: 'demo@crx2xpi.local' },
    });
  });
});

describe('removeChromeOnlyFields', () => {
  it('removes Chrome-only keys and leaves the rest intact', () => {
    const manifest: WebExtensionManifest = {
      ...mv3(),
      key: 'abc',
      update_url: 'https://clients2.google.com',
      minimum_chrome_version: '120',
      oauth2: {},
      export: {},
      description: 'kept',
    };
    const result = removeChromeOnlyFields(manifest);
    expect(result).toEqual({
      manifest_version: 3,
      name: 'Demo',
      version: '1.0.0',
      description: 'kept',
    });
  });

  it('returns the original object when nothing was removed', () => {
    const manifest = mv3();
    expect(removeChromeOnlyFields(manifest)).toBe(manifest);
  });
});

describe('renameBrowserAction', () => {
  it('renames an MV3 browser_action to action', () => {
    const manifest: WebExtensionManifest = { ...mv3(), browser_action: { default_title: 'Hi' } };
    const result = renameBrowserAction(manifest);
    expect(result.action).toEqual({ default_title: 'Hi' });
    expect(result.browser_action).toBeUndefined();
  });

  it('does not overwrite an existing action', () => {
    const manifest: WebExtensionManifest = {
      ...mv3(),
      action: { default_title: 'New' },
      browser_action: { default_title: 'Old' },
    };
    expect(renameBrowserAction(manifest)).toBe(manifest);
  });

  it('leaves MV2 browser_action untouched', () => {
    const manifest: WebExtensionManifest = {
      manifest_version: 2,
      name: 'Legacy',
      version: '1.0.0',
      browser_action: {},
    };
    expect(renameBrowserAction(manifest)).toBe(manifest);
  });
});

describe('splitHostPermissions', () => {
  it('moves match patterns into host_permissions and keeps API permissions', () => {
    const manifest: WebExtensionManifest = {
      ...mv3(),
      permissions: ['storage', 'https://example.com/*', '<all_urls>', '*://*.foo.com/*'],
    };
    const result = splitHostPermissions(manifest);
    expect(result.permissions).toEqual(['storage']);
    expect(result.host_permissions).toEqual([
      'https://example.com/*',
      '<all_urls>',
      '*://*.foo.com/*',
    ]);
  });

  it('merges with existing host_permissions without duplicating', () => {
    const manifest: WebExtensionManifest = {
      ...mv3(),
      permissions: ['storage', 'https://example.com/*'],
      host_permissions: ['https://example.com/*', 'https://other.com/*'],
    };
    const result = splitHostPermissions(manifest);
    expect(result.host_permissions).toEqual(['https://example.com/*', 'https://other.com/*']);
  });

  it('does nothing when no host patterns are present', () => {
    const manifest: WebExtensionManifest = { ...mv3(), permissions: ['storage', 'tabs'] };
    expect(splitHostPermissions(manifest)).toBe(manifest);
  });

  it('leaves MV2 permissions untouched', () => {
    const manifest: WebExtensionManifest = {
      manifest_version: 2,
      name: 'Legacy',
      version: '1.0.0',
      permissions: ['https://example.com/*'],
    };
    expect(splitHostPermissions(manifest)).toBe(manifest);
  });
});

describe('sanitizeWebAccessibleResources', () => {
  it('strips use_dynamic_url from MV3 resources', () => {
    const manifest: WebExtensionManifest = {
      ...mv3(),
      web_accessible_resources: [
        { resources: ['a.png'], matches: ['https://example.com/*'], use_dynamic_url: true },
      ],
    };
    const result = sanitizeWebAccessibleResources(manifest);
    expect(result.web_accessible_resources).toEqual([
      { resources: ['a.png'], matches: ['https://example.com/*'] },
    ]);
  });

  it('does not fabricate a broad matches pattern when one is missing', () => {
    const manifest: WebExtensionManifest = {
      ...mv3(),
      web_accessible_resources: [{ resources: ['a.png'], use_dynamic_url: false }],
    };
    const result = sanitizeWebAccessibleResources(manifest);
    expect(result.web_accessible_resources).toEqual([{ resources: ['a.png'] }]);
  });

  it('returns the original when there is no use_dynamic_url', () => {
    const manifest: WebExtensionManifest = {
      ...mv3(),
      web_accessible_resources: [{ resources: ['a.png'], matches: ['<all_urls>'] }],
    };
    expect(sanitizeWebAccessibleResources(manifest)).toBe(manifest);
  });
});

describe('normalizeContentSecurityPolicy', () => {
  it('converts a string CSP to the MV3 object form', () => {
    const manifest: WebExtensionManifest = {
      ...mv3(),
      content_security_policy: "script-src 'self'; object-src 'self'",
    };
    const result = normalizeContentSecurityPolicy(manifest);
    expect(result.content_security_policy).toEqual({
      extension_pages: "script-src 'self'; object-src 'self'",
    });
  });

  it('does not add wasm-unsafe-eval to an existing object CSP', () => {
    const manifest: WebExtensionManifest = {
      ...mv3(),
      content_security_policy: { extension_pages: "script-src 'self'" },
    };
    expect(normalizeContentSecurityPolicy(manifest)).toBe(manifest);
  });
});

describe('rewriteManifestForGecko', () => {
  it('applies the full safe rewrite set for a typical MV3 manifest', () => {
    const manifest: WebExtensionManifest = {
      manifest_version: 3,
      name: 'Demo',
      version: '1.0.0',
      update_url: 'https://clients2.google.com',
      browser_action: { default_title: 'Hi' },
      permissions: ['storage', 'https://example.com/*'],
      content_security_policy: "script-src 'self'",
      web_accessible_resources: [{ resources: ['a.png'], use_dynamic_url: true }],
    };
    const result = rewriteManifestForGecko(manifest);
    expect(result.update_url).toBeUndefined();
    expect(result.browser_action).toBeUndefined();
    expect(result.action).toEqual({ default_title: 'Hi' });
    expect(result.permissions).toEqual(['storage']);
    expect(result.host_permissions).toEqual(['https://example.com/*']);
    expect(result.content_security_policy).toEqual({ extension_pages: "script-src 'self'" });
    expect(result.web_accessible_resources).toEqual([{ resources: ['a.png'] }]);
    expect((result.browser_specific_settings as { gecko: { id: string } }).gecko.id).toBe(
      'demo@crx2xpi.local'
    );
  });

  it('is idempotent: re-running the chain changes nothing', () => {
    const once = rewriteManifestForGecko({
      manifest_version: 3,
      name: 'Demo',
      version: '1.0.0',
      permissions: ['https://example.com/*'],
    });
    const twice = rewriteManifestForGecko(once);
    expect(twice).toEqual(once);
  });

  it('never touches content_scripts all_frames (a risky behaviour change)', () => {
    const manifest: WebExtensionManifest = {
      ...mv3(),
      content_scripts: [{ matches: ['<all_urls>'], js: ['c.js'] }],
    };
    const result = rewriteManifestForGecko(manifest);
    expect(result.content_scripts).toEqual(manifest.content_scripts);
  });
});
