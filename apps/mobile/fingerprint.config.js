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

    if (source.type === "contents" && source.id === "expoConfig" && chunk) {
      const config = JSON.parse(chunk.toString());
      // This version describes the JS bundle.
      delete config.extra?.canopyVersion;

      // Expo hashes the project directory and layer bytes as an iOS-only external source.
      // Drop the duplicated path from the config hash shared with Android.
      if (config.ios?.icon?.endsWith?.(".icon")) delete config.ios.icon;

      return JSON.stringify(config);
    }

    return chunk;
  },
};
