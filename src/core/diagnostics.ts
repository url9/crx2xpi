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
 * A Chrome-only API rule: a dotted prefix matched against `chrome.*` usage.
 *
 * Only APIs that are genuinely absent or materially different in Firefox are
 * listed; common APIs Firefox implements (`tabs`, `storage.local`, `runtime`,
 * ...) are intentionally excluded to avoid false alarms.
 */
interface ApiRule {
  /** Dotted API prefix without the `chrome.` root, e.g. `offscreen`. */
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
 * logic. Prefixes are matched at a dot boundary, so `offscreen` matches
 * `chrome.offscreen.createDocument` but not `chrome.offscreenish`.
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
    severity: 'info',
    message: 'chrome.storage.session landed later in Firefox than local storage.',
    suggestion: 'Confirm the target Firefox version supports session storage.',
  },
  {
    api: 'runtime.getPackageDirectoryEntry',
    severity: 'warning',
    message: 'chrome.runtime.getPackageDirectoryEntry is Chrome-only.',
    suggestion: 'Avoid relying on direct package filesystem access.',
  },
];

/**
 * Match a `chrome.*` member against the rule catalogue at a dot boundary.
 *
 * @param member - Dotted API path after the `chrome.` root.
 * @returns The first matching rule, or undefined when none applies.
 */
function matchApiRule(member: string): ApiRule | undefined {
  return API_RULES.find((rule) => member === rule.api || member.startsWith(`${rule.api}.`));
}

/**
 * Scan one source line for Chrome-only API usage.
 *
 * @param line - A single line of JavaScript source.
 * @param file - Payload-relative path, used in emitted findings.
 * @param lineNumber - 1-based line number.
 * @returns Findings for that line, de-duplicated by API.
 */
function scanLineForApis(line: string, file: string, lineNumber: number): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  const seen = new Set<string>();
  const pattern = /\bchrome\.([a-zA-Z_][\w.]*)/g;
  for (const match of line.matchAll(pattern)) {
    const member = match[1];
    const rule = matchApiRule(member);
    if (rule === undefined || seen.has(rule.api)) {
      continue;
    }
    seen.add(rule.api);
    findings.push({
      file,
      line: lineNumber,
      code: `chrome.${rule.api}`,
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
