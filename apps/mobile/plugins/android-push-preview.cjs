const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

const expoService = "expo.modules.notifications.service.ExpoFirebaseMessagingService";

/** @type {import("expo/config-plugins").ConfigPlugin} */
module.exports = (config) =>
  withAndroidManifest(config, (mod) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    mod.modResults.manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    app.service = [
      ...(app.service ?? []).filter((service) => service.$["android:name"] !== expoService),
      { $: { "android:name": expoService, "tools:node": "remove" } },
    ];

    return mod;
  });
