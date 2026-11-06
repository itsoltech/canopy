import type { ConfigContext, ExpoConfig } from "expo/config";

// CNG owns ios/ and android/. Do not maintain native project files by hand.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Canopy",
  slug: "canopy-mobile",
  platforms: ["ios", "android"],
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
  plugins: [
    ...(config.plugins ?? []),
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
