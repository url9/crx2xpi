/**
 * Minimal WebExtension manifest representation used by the parser.
 *
 * The index signature keeps the type open to unknown MV3 fields while the
 * named fields describe exactly the data this module validates and rewrites.
 * Keeping the surface narrow is deliberate: the conversion engine can grow
 * field by field without weakening type safety on implemented parts.
 */
export interface WebExtensionManifest {
  /** Manifest specification version (2 or 3 for the supported targets). */
  manifest_version: 2 | 3;
  /** Add-on display name; required by both MV2 and MV3. */
  name: string;
  /** Add-on version string; required by both MV2 and MV3. */
  version: string;
  /** Chromium MV3 declares the background worker here; MV2 uses `scripts`. */
  background?: {
    /** Chromium MV3 service worker entry — unsupported by Gecko. */
    service_worker?: string;
    /** Script paths Gecko loads in the background context. */
    scripts?: string[];
    /** Legacy flag retained for MV2 compatibility. */
    persistent?: boolean;
    /** Whether background scripts are ES modules (needed for `import`). */
    type?: 'classic' | 'module';
  };
  /** Any other manifest fields are preserved verbatim. */
  [key: string]: unknown;
}

/**
 * Firefox-compatible background configuration produced by the downgrade.
 *
 * Gecko still expects the MV2 event-page model, so the generated shape always
 * uses a script list and runs non-persistently (event page semantics).
 */
export interface GeckoBackgroundConfig {
  /** Background script paths, headed by the downgraded service worker. */
  scripts: string[];
  /** Firefox uses event pages; a persistent background page is never wanted. */
  persistent: boolean;
  /**
   * ES-module flag carried over from the source worker. An MV3 `service_worker`
   * with `type: "module"` uses static `import`; loading those scripts as
   * classic scripts throws SyntaxError in Firefox, so the flag must survive
   * the downgrade. Absent when the source worker was classic.
   */
  type?: 'classic' | 'module';
}

/**
 * Result of a successful manifest parse.
 *
 * The parse deliberately does NOT mutate or rewrite the manifest itself: it
 * returns the validated copy plus the downgrade plan so the conversion engine
 * can decide when and how to apply it.
 */
export interface ManifestParseResult {
  /** Validated manifest copy; untrusted unknown input is narrowed to this. */
  manifest: WebExtensionManifest;
  /** Gecko downgrade structure; present only for MV3 + service_worker. */
  geckoBackground: GeckoBackgroundConfig | undefined;
  /** Whether a service_worker downgrade structure was generated. */
  downgradeApplied: boolean;
}

/**
 * Typed error thrown when the raw manifest fails validation.
 *
 * A dedicated error class lets callers distinguish "invalid input" from
 * unexpected runtime failures without string matching on messages.
 */
export class ManifestValidationError extends Error {
  /**
   * Create a validation error.
   *
   * @param message - Human-readable description of the violated constraint.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

/** A narrowed plain object with string keys and unknown values. */
type PlainRecord = Record<string, unknown>;

/**
 * Narrow untrusted input to a plain (non-array) object.
 *
 * @param value - Value of unknown origin, e.g. JSON.parse output.
 * @returns True when the value is a non-null, non-array object.
 */
function isPlainObject(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Assert that a manifest field is a non-empty string.
 *
 * @param field - Field path used in the error message (e.g. "name").
 * @param value - Untrusted field value.
 * @returns Void; throws instead of returning on violation.
 * @throws {ManifestValidationError} When the value is not a non-empty string.
 */
function assertRequiredString(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ManifestValidationError(`manifest.${field} must be a non-empty string`);
  }
}

/**
 * Assert that the manifest declares a supported specification version.
 *
 * Only 2 and 3 are accepted: MV2 is the Gecko-native baseline and MV3 is the
 * conversion input; anything else has no defined rewrite semantics.
 *
 * @param value - Untrusted `manifest_version` value.
 * @returns Void; throws instead of returning on violation.
 * @throws {ManifestValidationError} When the version is not 2 or 3.
 */
function assertManifestVersion(value: unknown): asserts value is 2 | 3 {
  if (value !== 2 && value !== 3) {
    throw new ManifestValidationError('manifest.manifest_version must be 2 or 3');
  }
}

/**
 * Validate and narrow the background section for the declared manifest version.
 *
 * MV2 must not declare `service_worker` because the field only exists since
 * MV3; accepting it would silently hide an authoring mistake.
 *
 * @param value - Untrusted `background` value (may be undefined).
 * @param manifestVersion - Already-validated manifest version.
 * @returns The narrowed background record, or undefined when absent.
 * @throws {ManifestValidationError} When the shape violates the version rules.
 */
function parseBackground(
  value: unknown,
  manifestVersion: 2 | 3
): { service_worker?: string; scripts?: string[]; type?: 'classic' | 'module' } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new ManifestValidationError('manifest.background must be an object');
  }
  if (manifestVersion === 2 && value.service_worker !== undefined) {
    throw new ManifestValidationError('manifest.background.service_worker is not allowed in MV2');
  }

  const serviceWorker = parseOptionalWorker(value.service_worker);
  const scripts = parseScripts(value.scripts);
  const type = parseBackgroundType(value.type);

  // Conditional spread instead of assigning undefined: exactOptionalPropertyTypes
  // forbids explicitly setting an optional property to undefined.
  return {
    ...(serviceWorker === undefined ? {} : { service_worker: serviceWorker }),
    ...(scripts === undefined ? {} : { scripts }),
    ...(type === undefined ? {} : { type }),
  };
}

/**
 * Validate the optional `background.type` module flag.
 *
 * Chrome uses this to mark an MV3 worker as an ES module. It must be narrowed
 * before it can be copied into the Gecko downgrade: an unchecked string would
 * let arbitrary values reach the rewritten manifest.
 *
 * @param value - Untrusted `background.type` value.
 * @returns The validated flag, or undefined when not declared.
 * @throws {ManifestValidationError} When the value is neither classic nor module.
 */
function parseBackgroundType(value: unknown): 'classic' | 'module' | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== 'classic' && value !== 'module') {
    throw new ManifestValidationError(
      'manifest.background.type must be "classic" or "module" when present'
    );
  }
  return value;
}

/**
 * Validate an optional, non-empty service worker entry.
 *
 * @param value - Untrusted `background.service_worker` value.
 * @returns The validated worker path, or undefined when not declared.
 * @throws {ManifestValidationError} When present but not a non-empty string.
 */
function parseOptionalWorker(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManifestValidationError(
      'manifest.background.service_worker must be a non-empty string when present'
    );
  }
  return value;
}

/**
 * Validate the optional background script list.
 *
 * @param value - Untrusted `background.scripts` value.
 * @returns The validated script list, or undefined when not declared.
 * @throws {ManifestValidationError} When present but not a non-empty string array.
 */
function parseScripts(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const isValid =
    Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  if (!isValid) {
    throw new ManifestValidationError(
      'manifest.background.scripts must be an array of non-empty strings'
    );
  }
  return value;
}

/**
 * Parse and validate a raw manifest of unknown origin.
 *
 * <parsing steps>
 * 1. Type-guard the raw input into a plain object.
 * 2. Validate required fields (manifest_version, name, version).
 * 3. Validate the background section against the declared version.
 * 4. Build a narrowed manifest copy (input is never mutated).
 * 5. Generate the Gecko downgrade structure for MV3 service workers.
 * </parsing steps>
 *
 * @param manifestRaw - Raw manifest data, e.g. the result of JSON.parse.
 * @returns The validated manifest plus its Gecko downgrade plan.
 * @throws {ManifestValidationError} When any field violates the schema above.
 */
export function parseManifest(manifestRaw: unknown): ManifestParseResult {
  if (!isPlainObject(manifestRaw)) {
    throw new ManifestValidationError('manifest must be a plain JSON object');
  }
  assertManifestVersion(manifestRaw.manifest_version);
  assertRequiredString('name', manifestRaw.name);
  assertRequiredString('version', manifestRaw.version);
  // Destructure so the assertion functions narrow these to string before the
  // object literal below: spreading a PlainRecord alone loses that narrowing.
  const { name, version } = manifestRaw;

  const manifestVersion = manifestRaw.manifest_version;
  const background = parseBackground(manifestRaw.background, manifestVersion);

  const manifest: WebExtensionManifest = {
    ...manifestRaw,
    manifest_version: manifestVersion,
    name,
    version,
    ...(background === undefined ? {} : { background }),
  };

  // Firefox / GeckoView does not implement Chromium's MV3 service workers, so
  // a declared worker must be turned into MV2-style event-page scripts. The
  // downgrade is returned as data (not written anywhere) to keep parsing pure
  // and to let the conversion engine own all filesystem decisions.
  const worker = background?.service_worker;
  const downgradeApplied = manifestVersion === 3 && worker !== undefined;
  const existingScripts = downgradeApplied ? (background?.scripts ?? []) : [];
  const geckoBackground: GeckoBackgroundConfig | undefined = downgradeApplied
    ? {
        scripts: existingScripts.includes(worker) ? existingScripts : [...existingScripts, worker],
        persistent: false,
        // A module worker's static `import` statements only parse when the
        // downgraded event-page scripts are also loaded as ES modules.
        ...(background?.type === undefined ? {} : { type: background.type }),
      }
    : undefined;

  return { manifest, geckoBackground, downgradeApplied };
}

/**
 * Downgrade a Chromium MV3 `background.service_worker` into the
 * Firefox-compatible `background.scripts` form in place.
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
  const worker = manifest.background?.service_worker;

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
  delete manifest.background?.service_worker;

  return manifest;
}
