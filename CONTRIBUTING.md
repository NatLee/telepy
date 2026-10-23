# Contributing to Telepy

Thanks for helping out. Bug reports and feature ideas are welcome as GitHub issues; pull requests are welcome
too.

## Pull requests

- Keep a PR to one change, and describe what it does and how you tested it.
- Backend: `cd src/backend-api && cargo test`. Anything on an SSH path (gateway, device login, terminal, SFTP,
  permissions) needs an end-to-end test on the SSH lab in `tests/common/lab.rs`.
- Frontend: `cd src/frontend && npm run build`. Every user-visible string goes through i18n: add the key to
  `src/locales/en.ts`, then to `zh-TW.ts` and `ja.ts`.
- New dependencies must be compatible with the AGPL-3.0 (MIT, BSD, Apache-2.0, MPL-2.0, LGPL and the like are
  fine; GPL-2.0-only, SSPL and proprietary licenses are not).
- Agree to the Contributor License Agreement below by ticking the box in the PR description.

## Contributor License Agreement

Telepy is released under the [AGPL-3.0](./LICENSE) and is also offered under a commercial license (see
[NOTICE](./NOTICE)). To keep both possible, every contribution is made under this agreement; in return, every
release that contains your work stays open source (clause 6). You accept it by ticking the CLA box in your pull
request, or by writing "I agree to the Telepy CLA" in the pull request or issue that carries your contribution.

### Telepy Individual Contributor License Agreement, version 1.1

**Definitions.** "You" means the person or legal entity making a Contribution. "Contribution" means any work of
authorship (code, documentation, artwork or other material) that You submit to the Telepy project, by pull
request, patch, issue or any other means, other than material You clearly mark as "Not a Contribution".
"Maintainer" means Nat Lee, the copyright holder of Telepy, and their successors and assigns.

1. **Copyright license.** You keep the copyright in Your Contributions. You grant the Maintainer, and recipients
   of software distributed by the Maintainer, a perpetual, worldwide, non-exclusive, no-charge, royalty-free,
   irrevocable license to reproduce, prepare derivative works of, publicly display, publicly perform,
   sublicense and distribute Your Contributions and such derivative works, under any license terms, including
   the AGPL-3.0 and commercial licenses.
2. **Patent license.** You grant the Maintainer, and recipients of software distributed by the Maintainer, a
   perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable patent license to make, have made,
   use, offer to sell, sell, import and otherwise transfer Your Contributions, covering the patent claims You
   can license that are necessarily infringed by a Contribution alone or by its combination with Telepy.
3. **Your right to contribute.** Each Contribution is Your original work, or You otherwise have the right to
   submit it under this agreement. If Your employer has rights in what You create, You have its permission to
   make the Contribution or it has waived those rights. Material by third parties is identified as such in the
   Contribution, together with its license.
4. **No warranty.** Contributions are provided "as is", without warranties or conditions of any kind, and You
   are not expected to provide support for them.
5. **No obligation.** The Maintainer is not required to use any Contribution.
6. **Open-source promise.** In return, every version of Telepy that the Maintainer distributes and that includes
   Your Contribution will also be made available to the public, in source form, under the AGPL-3.0 or another
   license approved by the Open Source Initiative. Commercial licenses are offered alongside that open-source
   release, never instead of it.
