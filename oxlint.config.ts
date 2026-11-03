import { defineConfig } from "oxlint";

// Lint policy (docs/code-quality.md). The anti-slop plugin is vendored in tools/oxlint/anti-slop (see its UPSTREAM.md);
// it is ours to adjust, so change the rules there rather than suppressing them here.
const maxLines = { max: 400, skipBlankLines: true, skipComments: true };

export default defineConfig({
  ignorePatterns: [
    // Agent tooling, not application source.
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
    // Generated code (`bun run gen`, `bun run gen:codex`).
    "**/gen/**",
    // Build outputs and local artefacts.
    "**/node_modules/**",
    "**/build/**",
    "**/dist/**",
    "**/.svelte-kit/**",
    "**/.expo/**",
    "apps/web/releases/**",
    "artifacts/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
  ],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",

    // File and function size. Counts code lines only, so comments never push a file over.
    "max-lines": ["error", maxLines],
    "max-lines-per-function": ["error", { max: 120, skipBlankLines: true, skipComments: true, IIFEs: true }],
  },
  overrides: [
    {
      // Effect policy only where a package depends on `effect` directly; elsewhere `Match` is not available.
      files: [
        "apps/gateway/**",
        "apps/web/**",
        "apps/worker/**",
        "packages/db/**",
        "packages/domain/**",
        "tests/integration/**",
      ],
      rules: {
        "anti-slop-effect/no-manual-effect-error-tag": "error",
        "anti-slop-effect/no-manual-tag-comparison": "error",
        "anti-slop-effect/no-manual-tagged-construction": "error",
        "anti-slop-effect/no-service-constructor-imports": "error",
        "anti-slop-effect/prefer-effect-match": "error",
      },
    },
    {
      // Tests read top to bottom as scenarios: a suite may be longer, and a `describe`/`test` body is one function.
      files: ["**/*.test.ts", "**/*.test.tsx", "**/test/**", "tests/**"],
      rules: {
        "max-lines": ["error", { ...maxLines, max: 800 }],
        "max-lines-per-function": "off",
      },
    },
    {
      // Hand-maintained data tables (SVG paths); splitting them by size would only scatter lookups.
      files: ["packages/ui/src/icons.ts", "packages/ui/src/mascot.ts"],
      rules: { "max-lines": "off", "max-lines-per-function": "off" },
    },
  ],
});
