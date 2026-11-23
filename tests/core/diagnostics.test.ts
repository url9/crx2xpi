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

  it('detects a Chrome-only API under the browser namespace', () => {
    const sources: DiagnosticSource[] = [
      { path: 'js/bg.js', content: 'const x = 1;\nbrowser.offscreen.createDocument({});\n' },
    ];
    const findings = analyzeSources(sources);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'js/bg.js',
      line: 2,
      code: 'browser.offscreen',
      severity: 'warning',
    });
  });

  it('detects the browser.storage.session crash seen in StayFocusd', () => {
    // wxt-built payloads emit browser.*; Firefox has no storage.session namespace.
    const sources: DiagnosticSource[] = [
      { path: 'background.js', content: 'browser.storage.session.setAccessLevel();' },
    ];
    const findings = analyzeSources(sources);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'background.js',
      line: 1,
      code: 'browser.storage.session',
      severity: 'warning',
    });
  });

  it('flags setAccessLevel where the namespace exists but the method does not', () => {
    // Open Stay Focused crashed on chrome.storage.local.setAccessLevel; the
    // storage.local namespace is supported, so only the full method path matches.
    const sources: DiagnosticSource[] = [
      {
        path: 'background.js',
        content: 'chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED"});',
      },
    ];
    const findings = analyzeSources(sources);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'chrome.storage.local.setAccessLevel',
      severity: 'warning',
    });
  });

  it('flags the bookmarks.onChildrenReordered crash seen in YueVision', () => {
    // YueVision's background threw `TypeError: chrome.bookmarks
    // .onChildrenReordered is undefined` at runtime in Firefox ESR 153 while
    // the report showed zero findings; bug 1319530 has been open since 2016.
    const sources: DiagnosticSource[] = [
      { path: 'background.js', content: 'chrome.bookmarks.onChildrenReordered.addListener(sync);' },
    ];
    const findings = analyzeSources(sources);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'background.js',
      line: 1,
      code: 'chrome.bookmarks.onChildrenReordered',
      severity: 'warning',
    });
  });

  it('flags the other unimplemented bookmark import events under both roots', () => {
    // onImportBegan/onImportEnded share the same Firefox gap as
    // onChildrenReordered; browser.* must match just like chrome.*.
    const sources: DiagnosticSource[] = [
      { path: 'background.js', content: 'browser.bookmarks.onImportBegan.addListener(a);' },
      { path: 'other.js', content: 'chrome.bookmarks.onImportEnded.addListener(b);' },
    ];
    const findings = analyzeSources(sources);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.code)).toEqual([
      'browser.bookmarks.onImportBegan',
      'chrome.bookmarks.onImportEnded',
    ]);
  });

  it('does not flag bookmark APIs Firefox supports', () => {
    // The bookmarks namespace itself is supported; only the three unimplemented
    // event names must trigger findings.
    const sources: DiagnosticSource[] = [
      {
        path: 'background.js',
        content: [
          'chrome.bookmarks.create({title:"x"});',
          'browser.bookmarks.onCreated.addListener(a);',
          'chrome.bookmarks.onMoved.addListener(b);',
          'browser.bookmarks.onChanged.addListener(c);',
        ].join('\n'),
      },
    ];
    expect(analyzeSources(sources)).toEqual([]);
  });

  it('does not flag Firefox-supported APIs used by extensions such as Dark Reader', () => {
    // browser.* must not be matched wholesale: only catalogue entries are flagged.
    const sources: DiagnosticSource[] = [
      {
        path: 'content.js',
        content: [
          'browser.tabs.query({});',
          'browser.storage.local.get("settings");',
          'browser.runtime.getManifest();',
          'browser.action.setBadgeText({text:"on"});',
          'browser.scripting.executeScript({target:{tabId:1},func:()=>1});',
        ].join('\n'),
      },
    ];
    expect(analyzeSources(sources)).toEqual([]);
  });

  it('keeps chrome and browser roots as distinct findings on one line', () => {
    const sources: DiagnosticSource[] = [
      { path: 'a.js', content: 'chrome.offscreen.close(); browser.offscreen.createDocument();' },
    ];
    const findings = analyzeSources(sources);
    expect(findings.map((finding) => finding.code)).toEqual([
      'chrome.offscreen',
      'browser.offscreen',
    ]);
  });

  it('de-duplicates the same API under the same namespace within a single line', () => {
    const sources: DiagnosticSource[] = [
      {
        path: 'a.js',
        content: 'chrome.tabGroups.query(); chrome.tabGroups.get(); browser.tabGroups.get();',
      },
    ];
    const findings = analyzeSources(sources);
    expect(findings.map((finding) => finding.code)).toEqual([
      'chrome.tabGroups',
      'browser.tabGroups',
    ]);
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
    expect(md).toContain('1 warning(s), 1 info');
  });
});
