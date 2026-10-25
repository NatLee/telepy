# rustdesk-web-core (vendored)

The open TypeScript core of [temandroid/rustdesk-web](https://github.com/temandroid/rustdesk-web), a browser
client for RustDesk. Telepy loads this one file on demand (a classic script that installs `window.setByName`,
`getByName`, `init` and reads `window.onGlobalEvent` / `onVideoFrame` / `onRgba`) and drives it from
`src/components/desktop/RustDeskViewer.tsx`; the Flutter shell of that project is not used.

- Release: `v0.1.5` (2026-10-13), file `js/rustdesk-web-core.js` from `rustdesk-web.tar.gz`
  (sha256 `117e6ffdbf6169fbce6131b18d1a2ecc3511e973be2fee647244a404aa880e53`).
- Built against RustDesk commit `851d2df88cc8ef7a8368f74e8b2e7254861ee00a` (`RUSTDESK_REF`); the peer protocol
  changes rarely, but a RustDesk release that does needs a newer core.
- License: AGPL-3.0-only (`LICENSE.txt`), attribution in `NOTICE.txt`. Telepy itself is AGPL-3.0-only.

To update: download the release tarball, verify its `.sha256`, copy `js/rustdesk-web-core.js`, `LICENSE`
and `NOTICE` here, and record the new version, hash and `RUSTDESK_REF` above.
