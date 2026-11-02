import type { ConfigContext, ExpoConfig } from 'expo/config';

// CNG owns ios/ and android/. Do not maintain native project files by hand.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Canopy',
  slug: 'canopy-mobile',
  platforms: ['ios', 'android'],
  plugins: [
    ...(config.plugins ?? []),
    ['expo-build-properties', { android: { usesCleartextTraffic: process.env.CANOPY_DEV_HTTP === '1' } }],
  ],
});
