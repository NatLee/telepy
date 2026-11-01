# rustdesk-web-core (vendored)

This is the open TypeScript core of [temandroid/rustdesk-web](https://github.com/temandroid/rustdesk-web), a browser client for RustDesk. The Flutter shell of that project is not used.

Telepy loads this one script on demand and drives it from its own RustDesk viewer. The script installs `setByName`, `getByName` and `init` on `window`, and calls back through `onGlobalEvent`, `onVideoFrame` and `onRgba`.

Never edit the bundle by hand. Replace it with a newer release instead.

## Version

- Release `v0.1.5` (2026-10-13): the file `js/rustdesk-web-core.js` from `rustdesk-web.tar.gz`, sha256 `117e6ffdbf6169fbce6131b18d1a2ecc3511e973be2fee647244a404aa880e53`.
- Built against RustDesk commit `851d2df88cc8ef7a8368f74e8b2e7254861ee00a` (`RUSTDESK_REF`). The peer protocol rarely changes, but when a RustDesk release does change it, a newer core is needed.
- License: AGPL-3.0-only (`LICENSE.txt`), attribution in `NOTICE.txt`. Telepy itself is AGPL-3.0-only too.

## Updating

1. Download the release tarball and verify its `.sha256`.
2. Copy `js/rustdesk-web-core.js`, `LICENSE` and `NOTICE` into this folder.
3. Record the new version, hash and `RUSTDESK_REF` above.
