# Canopy Desktop — weryfikacja Linux x64

Data: 2026-11-02. Kod aplikacji: `1e350c5`, baza gałęzi/main: `a768b62`.
Środowisko: Linux x64, Bun 1.4.4, Electron 45.2.1, PostgreSQL 18.6,
dystrybucja binariów `@embedded-postgres/linux-x64@18.6.0-beta.19`.

| Kontrola | Wynik |
| --- | --- |
| `bun install` | OK |
| `bun run typecheck` | OK, wszystkie workspace, w tym mobile; Svelte: 0 errors / 0 warnings |
| `bun run gen:check` | OK, bez zmian wygenerowanych kontraktów |
| `bun run check:tmp` | 629 pass, 144 skip, 0 fail; 773 testy / 129 plików; nic nie zostało w katalogu testowym |
| `bun run --cwd apps/desktop build` | OK; obejmuje zwykły web build oraz cztery skompilowane sidecary |
| electron-builder AppImage + deb | OK; dodatkowa kontrola finalnych zasobów (Postgres, Bun, sharp, SDK, SvelteKit) |
| Playwright / CDP, rzeczywisty AppImage | OK, Xvfb, aktywny sandbox i Secret Service; bez `--no-sandbox` |

Testy desktop (2 pass, 38 asercji) sprawdziły rzeczywisty gateway/worker/BFF/DB:
lokalny i zdalny enrollment, online przez gRPC, trwałość projektu/tożsamości po
restarcie, SIGKILL PostgreSQL i odzyskanie danych, redakcję sekretów oraz brak
pozostałych grup procesów po shutdown i po utracie stdin kontrolera.
Pełny `check:tmp` uruchomił je ponownie z finalnymi sidecarami.

Smoke używał nowego katalogu danych i jednorazowo wygenerowanych sekretów.
Potwierdził lokalnego workera online, brak błędów JavaScript renderera,
przeładowanie `/settings/desktop` przy aktywnym CSP, odrzucenie konfiguracji
z głównego UI oraz wypełnienie formularza przez drugą instancję z deep linkiem.
Token w zrzucie formularza jest syntetyczny, nie daje dostępu do gatewaya.
Po SIGTERM śledzonego PID Electron proces zakończył się, a log PostgreSQL
potwierdził `database system is shut down`. Następnie usunięto dane smoke.
Po zakończeniu nie było procesów `canopy` / `canopy-controller`.

Zrzuty rendererów prawdziwego okna Electron:

- [Jasny motyw](appimage-light.png)
- [Ciemny motyw](appimage-dark.png)
- [Pierwsze uruchomienie](first-run-light.png)
- [Konfiguracja zdalna po deep linku](remote-setup.png)

Wynik maszynowy: [appimage-smoke.json](appimage-smoke.json).
Skrypt Playwright pozostaje roboczy, nie został dodany do repozytorium.
Podczas zamykania BFF renderer może zgłaszać błędy sieciowe SSE; końcowy smoke
nie zgłosił błędów JavaScript podczas działania aplikacji.

Pliki instalacyjne są lokalnymi artefaktami, poza git, w `apps/desktop/release/`:

```text
e45c3f88c5ef6abb942eb056b2b329d94c6c0370c7384e077264e6fb1a3d198c  Canopy-0.1.0-linux-x86_64.AppImage
6a488a6888bf69f89ac52f77db696029e8349632f02d934526ed356b92a19119  Canopy-0.1.0-linux-amd64.deb
```

Linux arm64, oba macOS i Windows x64: konfiguracja gotowa, build/run niewykonane.
Deb zbudowany i sprawdzono metadane archiwum; nie instalowano go w systemie Arch.
Nie wykonywano podpisywania/notaryzacji, live tur providerów ani testu udostępnienia
workera na interfejsie sieciowym. Szczegóły i macierz hostów: `docs/desktop.md`.
