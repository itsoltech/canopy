# Supplemental third-party licenses

The versioned package directories contain license texts and notices missing
from the corresponding npm tarballs or native distributions. The links point
to upstream release commits. Where npm publishes `gitHead`, it identifies the
source revision.

| npm package | Release tag | Release commit | Source and scope |
| --- | --- | --- | --- |
| `@bufbuild/protobuf@2.17.0` | `v2.17.0` | `01a8c3b7c95d17758c641b2b9e8ee2f14a3ee9d7` | `LICENSE` is the upstream Apache-2.0 license. `LICENSE-BSD-3-Clause` reproduces the entire Google header from `src/wire/varint.ts` with its comment markers removed. [Apache-2.0](https://github.com/bufbuild/protobuf-es/blob/01a8c3b7c95d17758c641b2b9e8ee2f14a3ee9d7/LICENSE) · [BSD-3-Clause](https://github.com/bufbuild/protobuf-es/blob/01a8c3b7c95d17758c641b2b9e8ee2f14a3ee9d7/packages/protobuf/src/wire/varint.ts#L1-L32) |
| `@connectrpc/connect@2.3.0`, `@connectrpc/connect-web@2.3.0`, `@connectrpc/connect-node@2.3.0` | `v2.3.0` | `6b7c593d1a26db0be3c2c35500f50e9925354444` | All three packages use the Apache-2.0 license from the repository root. [License](https://github.com/connectrpc/connect-es/blob/6b7c593d1a26db0be3c2c35500f50e9925354444/LICENSE) |
| `sirv@3.0.2` | `v3.0.2` | `1135207e92c40354543cbd15c763c7a61d79d432` | The MIT license from the repository root covers `packages/sirv`. [License](https://github.com/lukeed/sirv/blob/1135207e92c40354543cbd15c763c7a61d79d432/license) |
| `@polka/url@1.0.0-next.29` | `v1.0.0-next.29` | `02cbdb529ddca0a9f3d225e2abb2931924219cc3` | The MIT license from the repository root covers `packages/url`. [License](https://github.com/lukeed/polka/blob/02cbdb529ddca0a9f3d225e2abb2931924219cc3/license) |
| `katex@0.18.10` | `v0.18.10` | `411da7029f5c095943c2805ce6db16c2be5f214d` | The npm tarball supplies the MIT license. `OFL.txt` covers the KaTeX fonts in `dist/fonts/` and `NOTICE-SVG` reproduces the notice for SVG artwork adapted from these glyphs. [MIT license](https://github.com/KaTeX/KaTeX/blob/411da7029f5c095943c2805ce6db16c2be5f214d/LICENSE) · [Fonts](https://github.com/KaTeX/KaTeX/tree/411da7029f5c095943c2805ce6db16c2be5f214d/fonts) · [SVG notice](https://github.com/KaTeX/KaTeX/blob/411da7029f5c095943c2805ce6db16c2be5f214d/src/stretchy.ts#L72-L76) |
| `expo-router@58.0.32` | `expo-router@58.0.32` | `0213a291129222bfc0e0ad6b0fa9bd7a78762169` | [Expo repository MIT license](https://github.com/expo/expo/blob/0213a291129222bfc0e0ad6b0fa9bd7a78762169/LICENSE) |
| `expo-updates@58.0.22` | `expo-updates@58.0.22` | `e01cf4a62bf7c85d8ff04547498ae40e4f640969` | [Expo repository MIT license](https://github.com/expo/expo/blob/e01cf4a62bf7c85d8ff04547498ae40e4f640969/LICENSE) |
| `expo-structured-headers@58.0.1` | `expo-structured-headers@58.0.1` | `f5f64f984edbd49d013d244448c2a1a724ba371e` | [Expo repository MIT license](https://github.com/expo/expo/blob/f5f64f984edbd49d013d244448c2a1a724ba371e/LICENSE) |
| `@react-native/js-polyfills@0.88.1`, `@react-native/normalize-colors@0.88.1`, `@react-native/virtualized-lists@0.88.1` | — | `c30b7f86850d47422637a64c70508e7411dbd8ea` | [React Native repository MIT license](https://github.com/facebook/react-native/blob/c30b7f86850d47422637a64c70508e7411dbd8ea/LICENSE) |
| `metro-runtime@0.87.1` | — | `c7597f88c3e5b2a0d5e5915dfed2413aadcdfcce` | [Metro repository MIT license](https://github.com/facebook/metro/blob/c7597f88c3e5b2a0d5e5915dfed2413aadcdfcce/LICENSE) |
| libvips | `v8.18.7` | `24ad4d042940e6bf99a68871ba886ca8847c9c82` | [Upstream LGPL text](https://github.com/libvips/libvips/blob/24ad4d042940e6bf99a68871ba886ca8847c9c82/LICENSE), selected by the libvips version in sharp's native packages. |

KaTeX's 60 distributed TTF, WOFF and WOFF2 font files match the tagged
source files byte for byte. The copyright notice and 12 Reserved Font
Names in `OFL.txt` come from the fonts' OpenType name ID 13. The full
SIL Open Font License 1.1 terms are copied from SIL's Charis release
`v7.000`, commit `5382abf45c42bc51d338ac8e9c30d080bc46831a`.
[KaTeX name table template](https://github.com/KaTeX/KaTeX/blob/411da7029f5c095943c2805ce6db16c2be5f214d/src/fonts/lib/Space.ttx#L133-L143) · [SIL license text](https://github.com/silnrsi/font-charis/blob/5382abf45c42bc51d338ac8e9c30d080bc46831a/OFL.txt#L10)

The npm and source packages for `heic-decode@2.1.0` and `lazy-val@1.0.5`
declare ISC and MIT, respectively. The sources have no license file at the
published commits. [heic-decode manifest](https://github.com/catdad-experiments/heic-decode/blob/47773f7b17acc22bfb8bb7869b6ef087d24c0ca9/package.json)
· [lazy-val manifest](https://github.com/develar/lazy-val/blob/b69ad4119f1b19bdab13c61ee2fcc88d46b89071/package.json)
