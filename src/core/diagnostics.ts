/**
 * Static compatibility diagnostics for a converted extension.
 *
 * A CRX payload can only be inspected statically: whether an add-on truly works
 * in Firefox needs a real browser. This module therefore does one safe thing —
 * REPORT. It scans the payload for API usage and manifest patterns that Firefox
 * handles differently, and renders an actionable Markdown report. It never
 * rewrites source code or injects shims: unconditional shim injection is exactly
 * the failure mode seen in other converters (shadowing native APIs, assigning
 * to read-only namespaces), so the decision stays with the human reviewer.
 */
import type { WebExtensionManifest } from '../parsers/manifest-parser.js';

/** How confident the diagnostic is that an entry needs manual attention. */
export type DiagnosticSeverity = 'warning' | 'info';

/** A single static finding attached to a source location. */
export interface DiagnosticFinding {
  /** Payload-relative path of the file that triggered the finding. */
  file: string;
  /** 1-based line number inside that file. */
  line: number;
  /** API or pattern identifier that was detected. */
  code: string;
  /** Severity: `warning` needs review, `info` is informational. */
  severity: DiagnosticSeverity;
  /** Human-readable explanation in English. */
  message: string;
  /** Suggested manual action in English. */
  suggestion: string;
}

/** A source file scanned by the diagnostics pass. */
export interface DiagnosticSource {
  /** Payload-relative path, e.g. `js/background.js`. */
  path: string;
  /** UTF-8 text content of the file. */
  content: string;
}

/** Aggregated diagnostics for one extension. */
export interface DiagnosticReport {
  /** Add-on display name. */
  name: string;
  /** Add-on version string. */
  version: string;
  /** Number of JavaScript files scanned. */
  scannedFiles: number;
  /** Findings ordered by file, then line. */
  findings: DiagnosticFinding[];
}

/**
 * A Chrome-only API rule: a dotted prefix matched under either WebExtension
 * namespace (`chrome.*` or `browser.*`).
 *
 * Only APIs that are genuinely absent or materially different in Firefox are
 * listed; common APIs Firefox implements (`tabs`, most of `storage.local`,
 * `runtime`, ...) are intentionally excluded to avoid false alarms. A specific
 * Chrome-only method inside an otherwise-supported namespace (for example
 * `storage.local.setAccessLevel`) is still listed by its full path.
 */
interface ApiRule {
  /** Dotted API prefix without the `chrome.`/`browser.` root, e.g. `offscreen`. */
  api: string;
  /** Severity attached to a match. */
  severity: DiagnosticSeverity;
  /** Why this API is problematic in Firefox. */
  message: string;
  /** Concrete next step for the reviewer. */
  suggestion: string;
}

/**
 * Conservative catalogue of Chrome-only / divergent APIs worth flagging.
 *
 * Kept as data (not code) so the catalogue can grow without touching scanner
 * logic. Prefixes are matched at a dot boundary under both namespaces, so
 * `offscreen` matches `chrome.offscreen.createDocument` and
 * `browser.offscreen.createDocument`, but not `chrome.offscreenish`.
 */
const API_RULES: readonly ApiRule[] = [
  {
    api: 'offscreen',
    severity: 'warning',
    message: 'chrome.offscreen has no Firefox equivalent.',
    suggestion: 'Move offscreen work into a background script or hidden document.',
  },
  {
    api: 'sidePanel',
    severity: 'warning',
    message: 'chrome.sidePanel differs from Firefox sidebarAction.',
    suggestion: 'Verify sidebar behaviour or adapt to browser.sidebarAction.',
  },
  {
    api: 'tabGroups',
    severity: 'warning',
    message: 'Firefox does not implement chrome.tabGroups.',
    suggestion: 'Provide a fallback or remove the tab-group feature.',
  },
  {
    api: 'declarativeContent',
    severity: 'warning',
    message: 'chrome.declarativeContent is not supported in Firefox.',
    suggestion: 'Replace with content scripts and a matches declaration.',
  },
  {
    api: 'userScripts',
    severity: 'info',
    message: 'chrome.userScripts support differs across Firefox versions.',
    suggestion: 'Confirm the minimum Firefox version and feature flags.',
  },
  {
    api: 'declarativeNetRequest',
    severity: 'info',
    message: 'declarativeNetRequest rule semantics differ in Firefox.',
    suggestion: 'Review dynamic rules and rule resources in a real browser.',
  },
  {
    api: 'storage.session',
    severity: 'warning',
    message: 'storage.session is not available in Firefox; the entire namespace is missing.',
    suggestion: 'Use storage.local or a guarded fallback, and test the affected feature.',
  },
  {
    // Firefox implements storage.local but not this Chrome-only method; a call
    // early in a module throws and can abort listener registration (StayFocusd).
    api: 'storage.local.setAccessLevel',
    severity: 'warning',
    message: 'storage.local.setAccessLevel is not implemented in Firefox.',
    suggestion: 'Remove the call; Firefox needs no storage access-level declaration.',
  },
  {
    // Firefox lacks these three bookmark events (MDN compatibility data; bug
    // 1319530 open since 2016). Verified at runtime: YueVision's background
    // threw `TypeError: chrome.bookmarks.onChildrenReordered is undefined`
    // at background.js:183 while `--report` showed zero findings — a literal
    // `chrome.*` call the catalogue did not cover yet.
    api: 'bookmarks.onChildrenReordered',
    severity: 'warning',
    message: 'bookmarks.onChildrenReordered is not implemented in Firefox.',
    suggestion:
      'Guard the call (typeof check or try/catch) or drop the listener; bookmark reorder sync cannot fire on Firefox.',
  },
  {
    api: 'bookmarks.onImportBegan',
    severity: 'warning',
    message: 'bookmarks.onImportBegan is not implemented in Firefox.',
    suggestion: 'Guard the call or drop the listener; Firefox never fires this event.',
  },
  {
    api: 'bookmarks.onImportEnded',
    severity: 'warning',
    message: 'bookmarks.onImportEnded is not implemented in Firefox.',
    suggestion: 'Guard the call or drop the listener; Firefox never fires this event.',
  },
  {
    api: 'runtime.getPackageDirectoryEntry',
    severity: 'warning',
    message: 'chrome.runtime.getPackageDirectoryEntry is Chrome-only.',
    suggestion: 'Avoid relying on direct package filesystem access.',
  },
  // The rules below were reconciled against MDN Browser Compat Data
  // (webextensions.api, 2026-11) at DEVELOPMENT time only — the data set is
  // ~20 MB and is not a runtime dependency. Each entry is a method or event
  // that Chrome implements and Firefox does not, so a literal call is always
  // a real gap rather than a version-dependent nuance.
  {
    api: 'dom',
    severity: 'warning',
    message: 'chrome.dom has no Firefox equivalent.',
    suggestion: 'Avoid DOM access from the extension API; use page scripts instead.',
  },
  {
    api: 'extension.sendRequest',
    severity: 'warning',
    message: 'chrome.extension.sendRequest is a Chrome-only legacy messaging API.',
    suggestion: 'Use runtime.sendMessage, which Firefox implements.',
  },
  {
    api: 'extension.onRequest',
    severity: 'warning',
    message: 'chrome.extension.onRequest is a Chrome-only legacy event.',
    suggestion: 'Use runtime.onMessage instead.',
  },
  {
    api: 'extension.onRequestExternal',
    severity: 'warning',
    message: 'chrome.extension.onRequestExternal is a Chrome-only legacy event.',
    suggestion: 'Use runtime.onMessageExternal instead.',
  },
  {
    api: 'extension.getExtensionTabs',
    severity: 'warning',
    message: 'chrome.extension.getExtensionTabs is not implemented in Firefox.',
    suggestion: 'Use runtime.getViews or tabs.query.',
  },
  {
    api: 'tabs.sendRequest',
    severity: 'warning',
    message: 'chrome.tabs.sendRequest is a Chrome-only legacy messaging API.',
    suggestion: 'Use tabs.sendMessage, which Firefox implements.',
  },
  {
    api: 'management.uninstall',
    severity: 'warning',
    message: 'chrome.management.uninstall is not implemented in Firefox.',
    suggestion: 'Remove the call or provide a Firefox-safe fallback.',
  },
  {
    api: 'management.getPermissionWarningsById',
    severity: 'warning',
    message: 'chrome.management.getPermissionWarningsById is not implemented in Firefox.',
    suggestion: 'Guard the call or drop the dependency on it.',
  },
  {
    api: 'management.getPermissionWarningsByManifest',
    severity: 'warning',
    message: 'chrome.management.getPermissionWarningsByManifest is not implemented in Firefox.',
    suggestion: 'Guard the call or drop the dependency on it.',
  },
  {
    api: 'notifications.onButtonClicked',
    severity: 'warning',
    message: 'chrome.notifications.onButtonClicked is not implemented in Firefox.',
    suggestion: 'Avoid notification buttons or guard the listener registration.',
  },
  {
    api: 'notifications.update',
    severity: 'warning',
    message: 'chrome.notifications.update is not implemented in Firefox.',
    suggestion: 'Create a new notification instead of updating an existing one.',
  },
  {
    api: 'notifications.onClosed',
    severity: 'info',
    message: 'chrome.notifications.onClosed is not implemented in Firefox.',
    suggestion: 'Do not rely on a close callback; verify notification behaviour.',
  },
  {
    api: 'downloads.acceptDanger',
    severity: 'warning',
    message: 'chrome.downloads.acceptDanger is not implemented in Firefox.',
    suggestion: 'Remove the call; Firefox downloads handle danger prompts differently.',
  },
  {
    api: 'downloads.setShelfEnabled',
    severity: 'warning',
    message: 'chrome.downloads.setShelfEnabled is not implemented in Firefox.',
    suggestion: 'Remove the call; the download shelf is a Chrome-only UI concept.',
  },
  {
    api: 'events.Event',
    severity: 'info',
    message: 'chrome.events.Event rule APIs are not implemented in Firefox.',
    suggestion: 'Review declarative WebRequest rule methods for a Firefox fallback.',
  },
];

/**
 * Match an API member against the rule catalogue at a dot boundary.
 *
 * @param member - Dotted API path after the `chrome.` or `browser.` root.
 * @returns The first matching rule, or undefined when none applies.
 */
function matchApiRule(member: string): ApiRule | undefined {
  return API_RULES.find((rule) => member === rule.api || member.startsWith(`${rule.api}.`));
}

/** A `chrome.*` / `browser.*` API reference found on a source line. */
interface ApiReference {
  namespace: string;
  member: string;
}

/**
 * Collect API references from one line in both member-access notations.
 *
 * WHY bracket form: minified and generated bundles often rewrite
 * `chrome.offscreen` into `chrome["offscreen"]`. The string literal is still
 * statically knowable, so ignoring it silently missed real calls. Only a bare
 * quoted literal is matched — computed access (`chrome[api]`) is deliberately
 * skipped because resolving it statically would risk false positives.
 *
 * @param line - A single line of JavaScript source.
 * @returns Namespace/member pairs in source order (duplicates allowed).
 */
function collectApiReferences(line: string): ApiReference[] {
  const refs: ApiReference[] = [];
  for (const match of line.matchAll(/\b(chrome|browser)\.([a-zA-Z_][\w.]*)/g)) {
    refs.push({ namespace: match[1], member: match[2] });
  }
  for (const match of line.matchAll(/\b(chrome|browser)\[['"]([a-zA-Z_][\w.]*)['"]\]/g)) {
    refs.push({ namespace: match[1], member: match[2] });
  }
  return refs;
}

/**
 * Scan one source line for Chrome-only API usage under either namespace.
 *
 * WHY both roots: Chrome MV3 code calls `chrome.*`, but framework-generated or
 * polyfilled payloads (for example wxt builds) emit `browser.*` instead. Firefox
 * exposes both namespaces, so a Chrome-only API under `browser.*` is just as
 * broken at runtime. Checking only `chrome.*` silently missed the real crash
 * seen in StayFocusd (`browser.storage.session.setAccessLevel`).
 *
 * @param line - A single line of JavaScript source.
 * @param file - Payload-relative path, used in emitted findings.
 * @param lineNumber - 1-based line number.
 * @returns Findings for that line, de-duplicated by namespace and API.
 */
function scanLineForApis(line: string, file: string, lineNumber: number): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  const seen = new Set<string>();
  for (const { namespace, member } of collectApiReferences(line)) {
    const rule = matchApiRule(member);
    if (rule === undefined) {
      continue;
    }
    const code = `${namespace}.${rule.api}`;
    if (seen.has(code)) {
      continue;
    }
    seen.add(code);
    findings.push({
      file,
      line: lineNumber,
      code,
      severity: rule.severity,
      message: rule.message,
      suggestion: rule.suggestion,
    });
  }
  return findings;
}

/**
 * Scan one source line for `importScripts()` calls.
 *
 * WHY flagged: the service-worker downgrade keeps importScripts paths as
 * background scripts, but inline `importScripts()` in nested workers or content
 * scripts may still need manual review.
 *
 * @param line - A single line of JavaScript source.
 * @param file - Payload-relative path.
 * @param lineNumber - 1-based line number.
 * @returns One finding when the line calls `importScripts`.
 */
function scanLineForImportScripts(
  line: string,
  file: string,
  lineNumber: number
): DiagnosticFinding[] {
  if (!/\bimportScripts\s*\(/.test(line)) {
    return [];
  }
  return [
    {
      file,
      line: lineNumber,
      code: 'importScripts',
      severity: 'info',
      message: 'importScripts() relies on the worker script being loaded first.',
      suggestion: 'Confirm imported files are present and ordered before this script.',
    },
  ];
}

/**
 * Scan JavaScript sources for static compatibility findings.
 *
 * @param sources - Source files with payload-relative paths and text content.
 * @returns All findings ordered by file path, then line number.
 */
export function analyzeSources(sources: readonly DiagnosticSource[]): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  for (const source of sources) {
    const lines = source.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      findings.push(...scanLineForApis(line, source.path, lineNumber));
      findings.push(...scanLineForImportScripts(line, source.path, lineNumber));
    });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Build a full diagnostic report for an extension payload.
 *
 * @param source - Parsed manifest supplying the display name and version.
 * @param sources - JavaScript sources to scan; non-JS entries should be excluded by the caller.
 * @returns An aggregated, deterministically ordered report.
 */
export function buildDiagnosticReport(
  source: WebExtensionManifest,
  sources: readonly DiagnosticSource[]
): DiagnosticReport {
  return {
    name: source.name,
    version: source.version,
    scannedFiles: sources.length,
    findings: analyzeSources(sources),
  };
}

/**
 * Render a bullet list for a set of findings, or a reassurance line when empty.
 *
 * @param findings - Findings to render.
 * @returns Markdown snippet for the findings section.
 */
function renderFindings(findings: DiagnosticFinding[]): string {
  if (findings.length === 0) {
    return '_No Chrome-only API usage or importScripts() calls detected._\n\n';
  }
  const bullets = findings.map(
    (finding) =>
      `- **${finding.severity}** \`${finding.file}:${finding.line}\` \`${finding.code}\` — ` +
      `${finding.message} Suggestion: ${finding.suggestion}`
  );
  return `${bullets.join('\n')}\n\n`;
}

/**
 * Render a diagnostic report as Markdown.
 *
 * The report explicitly states that static analysis cannot prove runtime
 * correctness; this keeps the tool honest and shifts final validation to a
 * real Firefox run rather than implying the conversion is verified.
 *
 * @param report - Report produced by `buildDiagnosticReport`.
 * @returns A Markdown document with summary, findings and next steps.
 */
export function renderReportMarkdown(report: DiagnosticReport): string {
  const warnings = report.findings.filter((finding) => finding.severity === 'warning').length;
  const infos = report.findings.length - warnings;
  return [
    '# crx2xpi compatibility report',
    '',
    `**Extension:** ${report.name} v${report.version}`,
    `**JavaScript files scanned:** ${report.scannedFiles}`,
    `**Findings:** ${warnings} warning(s), ${infos} info`,
    '',
    '> Static analysis only. It cannot guarantee the add-on works in Firefox;',
    '> always validate the converted XPI in a real browser.',
    '',
    '## Findings',
    '',
    renderFindings(report.findings),
    '## Next steps',
    '',
    '1. Load the converted XPI in Firefox (`about:debugging`).',
    '2. Review each warning above and test the affected feature.',
    '3. Check the Browser Console for runtime errors.',
    '',
  ].join('\n');
}
