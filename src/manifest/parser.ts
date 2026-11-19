/**
 * Minimal WebExtension manifest representation used by the parser.
 *
 * The index signature keeps the type open to unknown MV3 fields while the
 * named fields describe exactly the data this module rewrites. Keeping the
 * surface narrow is deliberate: the conversion engine can grow field by field
 * without weakening type safety on the parts already implemented.
 */
export interface WebExtensionManifest {
  /** Manifest specification version (2 or 3 for the supported targets). */
  manifest_version: number;
  /** Chromium MV3 background service worker entry — unsupported by Gecko. */
  service_worker?: string;
  /** Firefox-compatible background script declaration. */
  background?: {
    /** Script paths Gecko loads in the background context. */
    scripts: string[];
    /** Legacy flag retained for MV2 compatibility. */
    persistent?: boolean;
  };
  /** Any other manifest fields are preserved verbatim. */
  [key: string]: unknown;
}

/**
 * Downgrade a Chromium MV3 `service_worker` declaration into the
 * Firefox-compatible `background.scripts` form.
 *
 * Firefox / GeckoView does not implement Chromium's MV3 service workers; it
 * still expects the MV2-style event page declared via `background.scripts`.
 * Without this rewrite the generated XPI would lose all background behaviour.
 * The function is idempotent: a worker already present in `background.scripts`
 * is not added twice.
 *
 * @param manifest - Parsed manifest object. Mutated in place so callers can pass
 * the same object through a chain of rewrite steps.
 * @returns The same manifest object, with the downgrade applied when relevant.
 */
export function downgradeServiceWorker(manifest: WebExtensionManifest): WebExtensionManifest {
  const worker = manifest.service_worker;

  // Only MV3 manifests carrying a non-empty service_worker need a rewrite.
  // MV2 manifests already use background.scripts and must be left untouched.
  if (manifest.manifest_version !== 3 || typeof worker !== 'string' || worker.length === 0) {
    return manifest;
  }

  // Merge instead of overwrite: other rewrite steps may already have populated
  // background.scripts, and dropping them would silently break the add-on.
  const existingScripts = manifest.background?.scripts ?? [];
  const scripts = existingScripts.includes(worker) ? existingScripts : [...existingScripts, worker];

  manifest.background = { ...manifest.background, scripts };
  delete manifest.service_worker;

  return manifest;
}
