---
description: CRX3 header parsing rules — magic bytes, offsets, and required inline comments. Apply when working on CRX3 header / container code.
alwaysApply: false
paths: src/crx3/**/*.ts
---

# CRX3 parsing rules

Apply these constraints whenever implementing or reviewing CRX3 container
parsing (header stripping, signature reading, ZIP payload extraction).

## Required inline comments

When stripping the CRX3 signature header, the code **must** comment the CRX
magic-byte layout at the point of use:

- The ASCII magic number `Cr24` = bytes `0x43 0x72 0x32 0x34` (4 bytes).
- The 4-byte little-endian version field immediately after the magic.
- The 4-byte little-endian `public_key` length field offset.
- The 4-byte little-endian `signature` length field offset.
- The payload (ZIP archive) starts after
  `magic(4) + version(4) + pubkey_len(4) + sig_len(4) + pubkey + signature`.

The comment must explain why the offsets are fixed and why lengths are read as
little-endian, not merely restate the arithmetic.

## Design constraints

- Validate magic and length fields before slicing buffers; throw a typed error
  on malformed input.
- Keep the header parser under 50 lines; split validation and offset calculation
  into helpers if it grows.
- Never trust declared lengths that exceed the buffer — clamp and reject.
- Export parsing APIs with full TSDoc (`@param`, `@returns`, `@throws`).
