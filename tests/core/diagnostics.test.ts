import { describe, expect, it } from 'vitest';
import type { WebExtensionManifest } from '../../src/parsers/manifest-parser.js';
import {
  analyzeSources,
  buildDiagnosticReport,
  renderReportMarkdown,
  type DiagnosticSource,
} from '../../src/core/diagnostics.js';

/** Minimal MV3 manifest for report tests. */
const MANIFEST: WebExtensionManifest = {
  manifest_version: 3,
  name: 'Demo',
  version: '1.2.3',
};

describe('analyzeSources', () => {
  it('detects a Chrome-only API with its file and line number', () => {
    const sources: DiagnosticSource[] = [
      { path: 'js/bg.js', content: 'const x = 1;\nchrome.offscreen.createDocument({});\n' },
    ];
    const findings = analyzeSources(sources);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'js/bg.js',
      line: 2,
      code: 'chrome.offscreen',
      severity: 'warning',
    });
  });

  it('matches API prefixes at a dot boundary only', () => {
    const sources: DiagnosticSource[] = [
      { path: 'a.js', content: 'chrome.offscreen.createDocument();' },
      { path: 'b.js', content: 'chrome.offscreenish.doThing();' },
    ];
    const findings = analyzeSources(sources);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('a.js');
  });

  it('de-duplicates the same API within a single line', () => {
    const sources: DiagnosticSource[] = [
      { path: 'a.js', content: 'chrome.tabGroups.query(); chrome.tabGroups.get();' },
    ];
    expect(analyzeSources(sources)).toHaveLength(1);
  });

  it('does not flag APIs Firefox already supports', () => {
    const sources: DiagnosticSource[] = [
      { path: 'a.js', content: 'chrome.storage.local.get("k"); chrome.tabs.query({});' },
    ];
    expect(analyzeSources(sources)).toEqual([]);
  });

  it('flags importScripts as info', () => {
    const sources: DiagnosticSource[] = [{ path: 'a.js', content: 'importScripts("util.js");' }];
    const findings = analyzeSources(sources);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'importScripts', severity: 'info', line: 1 });
  });

  it('orders findings by file then line', () => {
    const sources: DiagnosticSource[] = [
      { path: 'z.js', content: 'chrome.tabGroups.query();\nimportScripts("x");' },
      { path: 'a.js', content: 'chrome.offscreen.createDocument();' },
    ];
    const findings = analyzeSources(sources);
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      'a.js:1',
      'z.js:1',
      'z.js:2',
    ]);
  });
});

describe('buildDiagnosticReport', () => {
  it('aggregates metadata and findings', () => {
    const report = buildDiagnosticReport(MANIFEST, [
      { path: 'a.js', content: 'chrome.offscreen.createDocument();' },
      { path: 'b.js', content: 'no api here' },
    ]);
    expect(report.name).toBe('Demo');
    expect(report.version).toBe('1.2.3');
    expect(report.scannedFiles).toBe(2);
    expect(report.findings).toHaveLength(1);
  });
});

describe('renderReportMarkdown', () => {
  it('renders a summary and the static-analysis disclaimer', () => {
    const md = renderReportMarkdown(buildDiagnosticReport(MANIFEST, []));
    expect(md).toContain('**Extension:** Demo v1.2.3');
    expect(md).toContain('Static analysis only');
    expect(md).toContain('No Chrome-only API usage');
  });

  it('renders each finding with severity, location and suggestion', () => {
    const report = buildDiagnosticReport(MANIFEST, [
      { path: 'js/bg.js', content: 'chrome.offscreen.createDocument();' },
    ]);
    const md = renderReportMarkdown(report);
    expect(md).toContain('**warning**');
    expect(md).toContain('`js/bg.js:1`');
    expect(md).toContain('`chrome.offscreen`');
    expect(md).toContain('Suggestion:');
    expect(md).toContain('1 warning(s), 0 info');
  });

  it('counts info findings separately from warnings', () => {
    const report = buildDiagnosticReport(MANIFEST, [
      { path: 'a.js', content: 'chrome.storage.session.set({});\nimportScripts("x");' },
    ]);
    const md = renderReportMarkdown(report);
    expect(md).toContain('0 warning(s), 2 info');
  });
});
