/**
 * Tests for the pre-publish security audit script.
 *
 * Each case builds a minimal synthetic package in a temporary directory and
 * runs `scripts/publish-audit.mjs` there, so the checks are exercised against
 * real npm packing behavior instead of re-implementing it.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/publish-audit.mjs');
const PUBLIC_REPO = 'https://github.com/url9/crx2xpi';

/** Directories created by the suite, removed after the run. */
const createdDirs: string[] = [];

/**
 * Build a synthetic package skeleton inside a fresh temporary directory.
 *
 * @param {string} name Package name used in the fixture manifest.
 * @returns {string} The package root directory.
 */
function makePackage(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `audit-${name}-`));
  createdDirs.push(dir);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '0.1.0',
      author: 'url9 and the crx2xpi contributors',
      repository: { type: 'git', url: `git+${PUBLIC_REPO}.git` },
      bugs: { url: `${PUBLIC_REPO}/issues` },
      homepage: `${PUBLIC_REPO}#readme`,
      files: ['dist', 'README.md'],
      scripts: { prepare: '' },
    })
  );
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  writeFileSync(join(dir, 'dist', 'cli.js'), 'console.log("ok");\n');
  return dir;
}

/**
 * Run the audit script in a package directory.
 *
 * @param {string} dir Package root to audit.
 * @returns {{status: number, output: string}} Exit status and combined output.
 */
function runAudit(dir: string): { status: number; output: string } {
  try {
    const output = execFileSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8' });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

afterAll(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('publish-audit script', () => {
  it('passes on a clean synthetic package', () => {
    const dir = makePackage('clean');
    const result = runAudit(dir);
    expect(result.status).toBe(0);
    expect(result.output).toContain('all checks passed');
  });

  it('fails when a packaged file contains a credential-shaped token', () => {
    const dir = makePackage('token');
    writeFileSync(
      join(dir, 'dist', 'cli.js'),
      'const t = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";\n'
    );
    const result = runAudit(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('GitHub token');
  });

  it('fails when an email address ships in a published file', () => {
    const dir = makePackage('email');
    writeFileSync(join(dir, 'dist', 'cli.js'), '// contact me@example.org\n');
    const result = runAudit(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('email address');
  });

  it('allows the generated Gecko add-on id but still rejects real emails', () => {
    const dir = makePackage('addon-id');
    writeFileSync(
      join(dir, 'dist', 'cli.js'),
      'const id = "my-extension@crx2xpi.local";\n// contact real.person@example.org\n'
    );
    const result = runAudit(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('example.org');
    expect(result.output).not.toContain('crx2xpi.local');
  });

  it('fails when package.json author carries an email address', () => {
    const dir = makePackage('author');
    const manifest = JSON.parse(readFileSyncSafe(join(dir, 'package.json')));
    manifest.author = 'Someone <someone@gmail.com>';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    const result = runAudit(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('"author" must not contain an email');
  });

  it('fails when repository points away from the public repo', () => {
    const dir = makePackage('repo');
    const manifest = JSON.parse(readFileSyncSafe(join(dir, 'package.json')));
    manifest.repository.url = 'git+https://github.com/other/private-repo.git';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    const result = runAudit(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('"repository" must point at');
  });

  it('fails when a packed file escapes the files whitelist', () => {
    const dir = makePackage('whitelist');
    writeFileSync(join(dir, 'local-notes.md'), 'private note\n');
    const manifest = JSON.parse(readFileSyncSafe(join(dir, 'package.json')));
    manifest.files = ['dist', 'README.md', 'local-notes.md'];
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    const result = runAudit(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('outside the "files" whitelist');
  });

  it('fails when a local filesystem path leaks into packaged code', () => {
    const dir = makePackage('path');
    writeFileSync(join(dir, 'dist', 'cli.js'), 'const p = "/root/secrets/key.pem";\n');
    const result = runAudit(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('local filesystem path');
  });
});

/**
 * Read a file as UTF-8 text (small wrapper keeps assertions above terse).
 *
 * @param {string} path Absolute file path.
 * @returns {string} File contents.
 */
function readFileSyncSafe(path: string): string {
  return readFileSync(path, 'utf8');
}
