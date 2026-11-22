const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

/** @type {import("expo/config-plugins").ConfigPlugin} */
module.exports = (config) =>
  withAndroidManifest(config, (mod) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    // Firebase otherwise generates a device token at startup, before the user opts in.
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, "firebase_messaging_auto_init_enabled", "false");
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, "firebase_analytics_collection_enabled", "false");

    return mod;
  });
