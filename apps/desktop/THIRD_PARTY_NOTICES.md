# Canopy Desktop — third-party notices

The packaged application includes the following runtimes and database distribution.
License files in `resources/runtime/licenses`, the binary distribution's MIT
license, Electron's `LICENSE` / `LICENSES.chromium.html`, and installed npm package
notices are retained. Upstream source and license references below cover the
relocatable database distribution and its bundled libraries.

| Component | Version | License / source |
| --- | --- | --- |
| Electron / Chromium / Node | 45.2.1 | MIT and bundled Chromium/Node notices; https://github.com/electron/electron |
| Bun | 1.4.4 | MIT; WebKit/JavaScriptCore LGPL-2.1 and additional notices; https://github.com/oven-sh/bun/blob/main/LICENSE.md |
| PostgreSQL | 18.6 | PostgreSQL License; https://www.postgresql.org/about/licence/ |
| embedded-postgres relocatable binary distribution | 18.6.0-beta.19 | MIT packaging; Apache-2.0 Zonky distribution; https://github.com/leinelissen/embedded-postgres and https://github.com/zonkyio/embedded-postgres-binaries |
| PostgreSQL bundled libraries | per target binary distribution | OpenSSL, ICU, zlib, libxml2, libxslt, liblzma, ossp-uuid; sources and build recipes: https://github.com/zonkyio/embedded-postgres-binaries |
| sharp / libvips | 0.35.5 | Apache-2.0 / LGPL-2.1-or-later and included library notices |
| Claude Agent SDK | 0.3.316 | Anthropic's license/terms in the npm package; not relicensed by Canopy |

Binary packages are pinned separately for linux-x64, linux-arm64, darwin-x64,
darwin-arm64 and windows-x64. No Windows arm64 distribution is built.

For redistribution, retain all upstream license files. macOS and Windows installers
must be signed under the distributor's own identity. No credentials are bundled.

`Bun-LICENSE.md` is taken from `oven-sh/bun`, tag `bun-v1.4.4`, `LICENSE.md`;
`PostgreSQL-COPYRIGHT` from `postgres/postgres`, tag `REL_18_6`, `COPYRIGHT`;
`Zonky-LICENSE` from `zonkyio/embedded-postgres-binaries`, `master`, `LICENSE`.
Bun's license file links its static dependencies, WebKit source and relinking
instructions. PostgreSQL binary packaging does not change upstream library licenses.
