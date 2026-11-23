const { execFileSync } = require("node:child_process");
const { resolve } = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

// Expo start, native release bundles and EAS Update all enter through Metro.
const root = resolve(__dirname, "../..");

execFileSync(
  "bun",
  [
    resolve(root, "apps/web/scripts/mobile-markdown.ts"),
    resolve(__dirname, "src/features/workspace/markdown-preview.generated.json"),
    resolve(__dirname, "src/features/licenses/notices.generated.json"),
  ],
  { cwd: root, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } },
);

// Expo configures Bun workspaces and TS package exports, including contracts, automatically.
module.exports = getDefaultConfig(__dirname);
