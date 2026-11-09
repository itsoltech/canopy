import type { ConfigContext, ExpoConfig } from "expo/config";
import release from "./canopy-version.json";
import { releaseIdentity } from "@canopy/domain/release/identity";
import { releaseChannel } from "@canopy/domain/release/version";

const profile = process.env.EAS_BUILD_PROFILE;

const profileChannel =
  profile === "production" || profile === "preview"
    ? "nightly"
    : profile?.endsWith("-beta")
      ? "beta"
      : profile?.endsWith("-stable")
        ? "stable"
        : undefined;

const versionChannel = releaseChannel(release.version);

const identity = releaseIdentity(
  process.env.CANOPY_CHANNEL || profileChannel || (versionChannel === "development" ? "stable" : versionChannel),
);

const assets = `../web/static${identity.assets}`;

// CNG owns ios/ and android/. Do not maintain native project files by hand.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: identity.displayName,
  icon: `${assets}/expo-icon.png`,
  slug: "canopy-mobile",
  platforms: ["ios", "android"],
  extra: { ...config.extra, canopyVersion: release.version },
  ios: {
    ...config.ios,
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
    adaptiveIcon: {
      foregroundImage: `${assets}/adaptive-foreground.png`,
      backgroundImage: `${assets}/adaptive-background.png`,
      backgroundColor: identity.background,
    },
  },
  plugins: [
    ...(config.plugins ?? []).filter((plugin) => !(Array.isArray(plugin) && plugin[0] === "expo-splash-screen")),
    [
      "expo-splash-screen",
      {
        backgroundColor: identity.background,
        image: `${assets}/icon-512.png`,
        imageWidth: 96,
        dark: {
          backgroundColor: identity.channel === "stable" ? "#000000" : identity.background,
          image: `${assets}/icon-512.png`,
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
