# Canopy mobile

Natywna aplikacja iOS/Android: Expo SDK 58, TypeScript, Expo Router i development client.
Expo web i Expo Go nie są wspierane. Bundle ID / Android package: `app.canopy.mobile`.

Z root wykonaj `bun install`, potem z tego katalogu:

```bash
bunx expo run:android
# albo na Macu
bunx expo run:ios --device
```

Kolejne sesje Metro: `bun run start`. Projekty `android/` i `ios/` generuje CNG;
nie są commitowane. Po zmianie modułu native/configu przebuduj development client.

[Pełna instrukcja](../../docs/mobile.md) opisuje parowanie, prywatny Tailscale HTTPS,
Android Emulator (`10.0.2.2`), iPhone/EAS, transport Connect i weryfikację bez urządzeń.
