# Security Policy

## Supported Versions

Security fixes are provided for the `0.2.x` line. Older releases are no longer
supported; upgrade to the latest `0.2.x` patch to receive fixes.

| Version | Supported |
| --- | --- |
| 0.2.x | Yes — patch fixes only |
| < 0.2.0 | No |

## Reporting a Vulnerability

Please report suspected vulnerabilities privately to **url9_npm@163.com**.
Do **not** open a public GitHub issue for security reports.

> This address is the package's npm maintainer email and is already public in
> the npm registry (`maintainers[].email` and each version's `_npmUser.email`);
> it is used here only as a private reporting channel.

Include a description, reproduction steps, the affected version, and any
proof-of-concept you can share. You should receive an acknowledgement after
we have had a chance to review the report — this is a single-maintainer
project with no rotation, so we aim to acknowledge within a few days rather
than guarantee a fixed window. For complex issues, the remediation timeline
is communicated after triage.

## Scope

In scope — security defects in conversion output and the handling of
untrusted extension input:

- Archive path traversal (Zip Slip) and symlink escape during CRX unpacking or
  XPI repacking.
- Manifest rewrites that could grant unintended privileges or break isolation.
- Filesystem path handling for input/output and extracted payload directories.

Out of scope — toolchain vulnerability reports in development dependencies
(`vitest`, `vite`, `esbuild`, and similar). These are handled routinely through
Dependabot pull requests and do not affect the published runtime package.
