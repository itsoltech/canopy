const { readFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const adaptiveForeground = /^\.\.\/web\/static\/channels\/[^/]+\/adaptive-foreground\.png$/;

// SDK 58's balanced preset ignores marketing/build numbers, while retaining native app identity.
/** @type {import("@expo/fingerprint").Config} */
module.exports = {
  preset: "balanced",
  fileHookTransform(source, chunk, isEndOfFile) {
    // SDK 58 skips the notification and themed masks. Hash them with this channel's Android-only foreground.
    if (isEndOfFile && source.type === "file") {
      const path = source.filePath.replaceAll("\\", "/");

      if (adaptiveForeground.test(path))
        return Buffer.concat([
          readFileSync(resolve(__dirname, dirname(path), "adaptive-monochrome.png")),
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
