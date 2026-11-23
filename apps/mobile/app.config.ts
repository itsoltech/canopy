import type { ConfigContext, ExpoConfig } from "expo/config";
import release from "./canopy-version.json";
import { appIdentity } from "@canopy/domain/release/identity";
import { releaseChannel } from "@canopy/domain/release/version";

const profile = process.env.EAS_BUILD_PROFILE;
const googleServicesFile = process.env.CANOPY_ANDROID_GOOGLE_SERVICES_FILE;

const profileChannel =
  profile === "production" || profile === "preview"
    ? "nightly"
    : profile?.endsWith("-beta")
      ? "beta"
      : profile?.endsWith("-stable")
        ? "stable"
        : undefined;

const versionChannel = releaseChannel(release.version);

const appAttestEnvironment =
  process.env.CANOPY_APP_ATTEST_ENV ?? (versionChannel === "development" ? "development" : "production");

const identity = appIdentity(process.env.CANOPY_CHANNEL || profileChannel || versionChannel);

const assets = `../web/static${identity.assets}`;

// CNG owns ios/ and android/. Do not maintain native project files by hand.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: identity.displayName,
  icon: `${assets}/expo-icon.png`,
  slug: "canopy-mobile",
  platforms: ["ios", "android"],
  extra: { ...config.extra, canopyVersion: release.version, canopyChannel: identity.channel },
  ios: {
    ...config.ios,
    entitlements: {
      ...config.ios?.entitlements,
      "com.apple.developer.devicecheck.appattest-environment": appAttestEnvironment,
    },
    infoPlist: {
      ...config.ios?.infoPlist,
      // The paired computer has a self-signed certificate, trusted only through its pinned SHA-256
      // (modules/canopy-pinned-fetch). With ATS on, URLSession re-checks it against the system roots
      // after the pin check and fails (-1200 / -9802); IP hosts can't get a per-domain exception.
      // NSAllowsLocalNetworking must stay unset: iOS ignores NSAllowsArbitraryLoads when it is present.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
    },
  },
  android: {
    ...config.android,
    googleServicesFile: googleServicesFile || config.android?.googleServicesFile,
    adaptiveIcon: {
      foregroundImage: `${assets}/adaptive-foreground.png`,
      backgroundImage: `${assets}/adaptive-background.png`,
      monochromeImage: `${assets}/adaptive-monochrome.png`,
      backgroundColor: identity.background,
    },
  },
  plugins: [
    "./plugins/media-network.cjs",
    "./plugins/push-opt-in.cjs",
    ["expo-notifications", { defaultChannel: "canopy-updates", icon: "./assets/notification-icon.png" }],
    "./plugins/android-push-preview.cjs",
    "./plugins/push-preview-ios.cjs",
    ["expo-video", { supportsBackgroundPlayback: false, supportsPictureInPicture: false }],
    ...(config.plugins ?? []),
    [
      "expo-splash-screen",
      {
        backgroundColor: identity.background,
        image: `${assets}/splash.png`,
        imageWidth: 96,
        dark: {
          backgroundColor: identity.background,
          image: `${assets}/splash.png`,
        },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          usesCleartextTraffic: process.env.CANOPY_DEV_HTTP === "1",
          // Expo's inspector peeks 1 MiB before delivering HTTP/2 bodies, blocking quiet Connect streams.
          networkInspector: false,
        },
      },
    ],
  ],
});
