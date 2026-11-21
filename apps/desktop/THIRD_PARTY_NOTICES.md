# Canopy Desktop third-party notices

The build generates `THIRD_PARTY_NOTICES.txt` from the JavaScript bundles,
native npm packages, Bun runtime and web assets. The app shows the notices
in Settings under **Open-source licenses**.

Electron's distribution includes `LICENSE.electron.txt` and
`LICENSES.chromium.html` with the installed app. The files are in
`Canopy.app/Contents/Resources` on macOS and beside the executable on Windows
and Linux.

Canopy downloads PostgreSQL only for local mode. The selected distribution's
MIT license, the PostgreSQL copyright notice and Zonky's Apache-2.0 license are
in `resources/runtime/licenses`. Sources and build recipes for the binary
distribution are available from
[embedded-postgres](https://github.com/leinelissen/embedded-postgres) and
[Zonky](https://github.com/zonkyio/embedded-postgres-binaries).

The Bun license includes upstream library notices and links to Bun's WebKit
source and relinking instructions.
