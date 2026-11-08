// SDK 58's balanced preset ignores marketing/build numbers, while retaining native app identity.
/** @type {import("@expo/fingerprint").Config} */
module.exports = {
  preset: "balanced",
  fileHookTransform(source, chunk) {
    // This field describes JS, never native code. Keep every other extra/config field in the hash.
    if (source.type === "contents" && source.id === "expoConfig" && chunk) {
      const config = JSON.parse(chunk.toString());
      delete config.extra?.canopyVersion;

      return JSON.stringify(config);
    }

    return chunk;
  },
};
