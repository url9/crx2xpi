/**
 * Firefox-compatible manifest rewrites beyond the service worker downgrade.
 *
 * The Chrome-to-Firefox gap is not limited to `background.service_worker`:
 * Chrome accepts manifest keys and permission layouts that Firefox rejects or
 * interprets differently. This module owns a set of small, idempotent, pure
 * rules that close those gaps. Every rule returns a NEW manifest object so the
 * conversion engine stays deterministic and the rules remain trivially
 * testable; the caller decides when the rewritten copy is persisted.
 *
 * Deliberately NOT copied from other converters (each would introduce a real
 * bug or a security regression):
 * - force `content_scripts[].all_frames = true` — changes page behaviour and
 *   injects into every iframe;
 * - add `'wasm-unsafe-eval'` to CSP — needlessly widens the policy;
 * - drop `background.type` — module workers need it to parse static imports;
 * - inject a fixed set of runtime shims into every add-on — unconditional
 *   shims can shadow native APIs (e.g. assigning to read-only `scripting`).
 */
import type { WebExtensionManifest } from '../parsers/manifest-parser.js';

/**
 * Domain used for the synthesised email-style Gecko id.
 *
 * Firefox accepts any syntactically valid `local@domain` id; the domain is not
 * required to resolve. A project-owned domain keeps generated ids recognisable
 * and stable across conversions.
 */
const GECKO_ID_DOMAIN = 'crx2xpi.local';

/** Manifest keys that are Chrome-only and meaningless (or harmful) in Firefox. */
const CHROME_ONLY_FIELDS = [
  'key',
  'update_url',
  'minimum_chrome_version',
  'oauth2',
  'export',
] as const;

/**
 * Narrow untrusted JSON data to a plain (non-array) object.
 *
 * @param value - Value of unknown origin, e.g. a `JSON.parse` result.
 * @returns True when the value is a non-null, non-array object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check that an unknown manifest array contains only strings.
 *
 * @param value - Untrusted array value from the manifest.
 * @returns True when every element is a string.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Detect a Chrome host match pattern that belongs in `host_permissions`.
 *
 * @param value - A single entry from `manifest.permissions`.
 * @returns True when the entry is `<all_urls>` or a `scheme://` match pattern.
 */
function isHostMatchPattern(value: string): boolean {
  return value === '<all_urls>' || /^\s*(\*|https?|wss?|ftp|file|data):\/\//i.test(value);
}

/**
 * Deterministic fallback id fragment derived from a name with no ASCII letters.
 *
 * A djb2 hash keeps the rewrite pure (no `node:crypto` IO) and stable, so two
 * conversions of the same extension produce the same Gecko id.
 *
 * @param name - Original extension name, possibly non-ASCII.
 * @returns An unsigned hexadecimal hash fragment.
 */
function stableHash(name: string): string {
  let hash = 5381;
  for (let index = 0; index < name.length; index += 1) {
    hash = ((hash << 5) + hash + name.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/**
 * Convert an extension name into a valid email-style id local part.
 *
 * Firefox only allows `[a-zA-Z0-9._-]` before the `@`. Non-ASCII names (e.g.
 * Chinese) would otherwise yield an invalid or empty id, so illegal characters
 * collapse to `-` and an all-illegal name falls back to a stable hash.
 *
 * @param name - Add-on display name from the manifest.
 * @returns A non-empty, lowercase local part safe for a Gecko id.
 */
export function sanitizeExtensionIdLocalPart(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.length > 0 ? cleaned : `ext-${stableHash(name)}`;
}

/**
 * Inject a stable, email-style `browser_specific_settings.gecko.id`.
 *
 * WHY this is required: Firefox needs a stable add-on id for storage,
 * `browser.management` and AMO submission. Without it a side-loaded build gets
 * a fresh random id on every load, silently breaking id-scoped state.
 *
 * Idempotence: an existing non-empty id is never overwritten, and sibling
 * `browser_specific_settings` / `gecko` keys are preserved verbatim.
 *
 * @param manifest - Manifest to rewrite (not mutated).
 * @returns A copy carrying a valid Gecko id when one was absent.
 */
export function injectGeckoId(manifest: WebExtensionManifest): WebExtensionManifest {
  const settings = manifest.browser_specific_settings;
  if (isPlainObject(settings)) {
    const gecko = settings.gecko;
    if (isPlainObject(gecko) && typeof gecko.id === 'string' && gecko.id.length > 0) {
      return manifest;
    }
  }
  const id = `${sanitizeExtensionIdLocalPart(manifest.name)}@${GECKO_ID_DOMAIN}`;
  const baseGecko = isPlainObject(settings) && isPlainObject(settings.gecko) ? settings.gecko : {};
  return {
    ...manifest,
    browser_specific_settings: {
      ...(isPlainObject(settings) ? settings : {}),
      gecko: { ...baseGecko, id },
    },
  };
}

/**
 * Remove Chrome-only manifest keys that Firefox ignores or misinterprets.
 *
 * `update_url` is the most important: it makes some Firefox builds attempt a
 * Chrome Web Store update. The other fields are inert at best.
 *
 * @param manifest - Manifest to rewrite (not mutated).
 * @returns A copy without the Chrome-only keys, or the original when none were present.
 */
export function removeChromeOnlyFields(manifest: WebExtensionManifest): WebExtensionManifest {
  const rewritten = { ...manifest };
  let removed = false;
  for (const field of CHROME_ONLY_FIELDS) {
    if (field in rewritten) {
      delete rewritten[field];
      removed = true;
    }
  }
  return removed ? rewritten : manifest;
}

/**
 * Rename an MV3 `browser_action` to the standard `action` key.
 *
 * @param manifest - Manifest to rewrite (not mutated).
 * @returns A copy using `action`, or the original when no rename was needed.
 */
export function renameBrowserAction(manifest: WebExtensionManifest): WebExtensionManifest {
  if (manifest.manifest_version !== 3) {
    return manifest;
  }
  if (manifest.action !== undefined || manifest.browser_action === undefined) {
    return manifest;
  }
  const action = manifest.browser_action;
  // Annotate explicitly: spreading an interface drops its index signature in
  // inference, which would make the `delete` below a type error.
  const rewritten: WebExtensionManifest = { ...manifest, action };
  delete rewritten.browser_action;
  return rewritten;
}

/**
 * Move host match patterns from `permissions` into `host_permissions` (MV3).
 *
 * Chrome historically allowed host patterns in `permissions`; Firefox MV3
 * treats them as unknown API permissions and denies the host access. Only
 * string arrays are touched, and duplicates are collapsed without dropping a
 * host the author declared in either list.
 *
 * @param manifest - Manifest to rewrite (not mutated).
 * @returns A copy with host patterns separated, or the original when unchanged.
 */
export function splitHostPermissions(manifest: WebExtensionManifest): WebExtensionManifest {
  if (manifest.manifest_version !== 3 || !isStringArray(manifest.permissions)) {
    return manifest;
  }
  const apiPermissions: string[] = [];
  const movedHosts: string[] = [];
  for (const entry of manifest.permissions) {
    if (isHostMatchPattern(entry)) {
      movedHosts.push(entry);
    } else {
      apiPermissions.push(entry);
    }
  }
  if (movedHosts.length === 0) {
    return manifest;
  }
  const existingHosts = isStringArray(manifest.host_permissions) ? manifest.host_permissions : [];
  return {
    ...manifest,
    permissions: apiPermissions,
    host_permissions: [...new Set([...existingHosts, ...movedHosts])],
  };
}

/**
 * Strip the Chrome-only `use_dynamic_url` flag from MV3 web-accessible resources.
 *
 * Firefox does not implement dynamic URL ids; leaving the flag in place can
 * cause the whole resource declaration to be rejected. We intentionally do NOT
 * synthesise `matches: ["<all_urls>"]` for entries missing match patterns: that
 * would silently widen access to every site, a security decision the author
 * must make explicitly.
 *
 * @param manifest - Manifest to rewrite (not mutated).
 * @returns A copy without `use_dynamic_url`, or the original when unchanged.
 */
export function sanitizeWebAccessibleResources(
  manifest: WebExtensionManifest
): WebExtensionManifest {
  if (manifest.manifest_version !== 3 || !Array.isArray(manifest.web_accessible_resources)) {
    return manifest;
  }
  let changed = false;
  const resources = manifest.web_accessible_resources.map((entry) => {
    if (!isPlainObject(entry) || !('use_dynamic_url' in entry)) {
      return entry;
    }
    changed = true;
    const cleaned = { ...entry };
    delete cleaned.use_dynamic_url;
    return cleaned;
  });
  return changed ? { ...manifest, web_accessible_resources: resources } : manifest;
}

/**
 * Normalise a string-valued CSP to Firefox's MV3 object form.
 *
 * WHY: MV3 requires `content_security_policy` to be an object with
 * `extension_pages` / `sandbox` keys; a bare string is MV2 syntax that Firefox
 * rejects. We move the existing policy unchanged and do NOT add
 * `'wasm-unsafe-eval'` — widening CSP is a security change outside a converter's
 * remit.
 *
 * @param manifest - Manifest to rewrite (not mutated).
 * @returns A copy with an object CSP, or the original when no conversion applied.
 */
export function normalizeContentSecurityPolicy(
  manifest: WebExtensionManifest
): WebExtensionManifest {
  if (manifest.manifest_version !== 3 || typeof manifest.content_security_policy !== 'string') {
    return manifest;
  }
  return {
    ...manifest,
    content_security_policy: { extension_pages: manifest.content_security_policy },
  };
}

/**
 * Apply every Firefox compatibility rewrite in a deterministic order.
 *
 * <rewrite steps>
 * 1. Drop Chrome-only manifest keys.
 * 2. Ensure a stable Gecko id.
 * 3. Rename an MV3 `browser_action` to `action`.
 * 4. Separate host match patterns into `host_permissions` (MV3).
 * 5. Clean MV3 web-accessible resource declarations.
 * 6. Normalise a string CSP to the MV3 object form.
 * </rewrite steps>
 *
 * Each rule is idempotent, so re-running the chain on its own output is a
 * no-op. Version-specific rules gate themselves on `manifest_version`.
 *
 * @param manifest - Manifest to rewrite (not mutated).
 * @returns A fully rewritten copy safe to serialise into the XPI.
 */
export function rewriteManifestForGecko(manifest: WebExtensionManifest): WebExtensionManifest {
  let rewritten = removeChromeOnlyFields(manifest);
  rewritten = injectGeckoId(rewritten);
  rewritten = renameBrowserAction(rewritten);
  rewritten = splitHostPermissions(rewritten);
  rewritten = sanitizeWebAccessibleResources(rewritten);
  rewritten = normalizeContentSecurityPolicy(rewritten);
  return rewritten;
}
