const { readFileSync } = require("node:fs");
const { basename, dirname, resolve } = require("node:path");

// SDK 58's balanced preset ignores marketing/build numbers, while retaining native app identity.
/** @type {import("@expo/fingerprint").Config} */
module.exports = {
  preset: "balanced",
  fileHookTransform(source, chunk, isEndOfFile) {
    // SDK 58 hashes the adaptive foreground only on Android. Include the two native masks it skips.
    if (isEndOfFile && source.type === "file" && basename(source.filePath) === "adaptive-foreground.png") {
      return Buffer.concat([
        readFileSync(resolve(__dirname, dirname(source.filePath), "adaptive-monochrome.png")),
        readFileSync(resolve(__dirname, "assets/notification-icon.png")),
      ]);
    }

    // This field describes JS, never native code. Keep every other extra/config field in the hash.
    if (source.type === "contents" && source.id === "expoConfig" && chunk) {
      const config = JSON.parse(chunk.toString());
      delete config.extra?.canopyVersion;

      return JSON.stringify(config);
    }

    return chunk;
  },
};
