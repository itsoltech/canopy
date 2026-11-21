const { execFileSync } = require("node:child_process");
const { resolve } = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

// Expo start, native release bundles and EAS Update all enter through Metro.
const root = resolve(__dirname, "../..");

execFileSync(
  "bun",
  [
    resolve(root, "scripts/open-source-licenses.ts"),
    "mobile",
    resolve(__dirname, "src/features/licenses/notices.generated.json"),
  ],
  { cwd: root, stdio: "inherit" },
);

// Expo configures Bun workspaces and TS package exports, including contracts, automatically.
module.exports = getDefaultConfig(__dirname);
