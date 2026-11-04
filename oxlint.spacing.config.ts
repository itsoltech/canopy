import { defineConfig } from "oxlint";
import config from "./oxlint.config.ts";

// CLI category switches do not disable explicitly configured JS plugin rules.
export default defineConfig({
  ignorePatterns: config.ignorePatterns,
  categories: { correctness: "off" },
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  rules: { "anti-slop/require-readable-spacing": "error" },
});
