# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `13909c9e07590f5a85d93c62712259fe14a883f7`
(2026-10-13, plugin version `0.1.2`). MIT, see `LICENSE` (copied verbatim from the upstream root).

Installed with the upstream skill's procedure (`skills/install-anti-slop/scripts/install.mjs`): the files are the skill's
`assets/anti-slop/` bundle, which is byte-identical to upstream `src/` without the `*.test.ts` RuleTester suites.

- `index.ts`, `rules/`, `shared/`: generic plugin, registered as `anti-slop`.
- `effect/`: opt-in Effect plugin, registered as `anti-slop-effect` (the repo depends on `effect` directly).
- `vendor/eslint-stylistic/`: comment-aware padding engine behind `require-readable-spacing`, with its own `LICENSE`
  and `UPSTREAM.md`.

Configuration lives in the root `oxlint.config.ts`; the policy and measurements are in `docs/code-quality.md`.

## Deviations

- None in the code. The repository's stricter compiler flags (`noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`) are relaxed for this directory in `tools/tsconfig.json` instead of patching two
  upstream reads (`rules/no-runtime-typeof.ts`, `shared/dictionary-types.ts`).
- Dependencies: `oxlint` and `@oxlint/plugins` pinned exactly to `1.91.0` (upstream tested `1.78.0`). All 24 upstream
  RuleTester suites passed against `1.91.0` at install time (run from a scratch copy of upstream `src/`; the CLI suite
  with `node_modules/.bin/oxlint` instead of `pnpm exec`).

## Updating

Follow upstream `skills/install-anti-slop/references/update.md`: stage the new revision separately, three-way merge
against the commit above, keep local rule changes, then update this record.
