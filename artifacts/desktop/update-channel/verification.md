# Desktop: wybór kanału aktualizacji

Data: 2026-11-03. Host Linux x64. Gałąź `feat/desktop-update-channel`, baza
`fff02136f79b9040837d37e3b6351d126d715d29` (`origin/dev` przy rozpoczęciu pracy).
Zmiany w `main.ts`: wyłącznie broadcast statusu aktualizacji i cztery autoryzowane
handlery IPC; bez zmian traffic lights ani regionów przeciągania.

## Projekt

Jedna aplikacja `Canopy` / `app.canopy.desktop`, wspólne userData i `canopy://`.
Wersja pliku zawiera prerelease, np. `Canopy-0.3.0-beta.1-linux-x64.AppImage`.
Ikona odzwierciedla zainstalowany build, bez zmiany tożsamości aplikacji.

Settings → App updates oraz lokalny ekran `/desktop` korzystają z jednego komponentu
Svelte i istniejącego kitu (SettingsGroup/Row, Select, Button, Badge). Select to własny
combobox; popover używa istniejących tokenów ruchu i obsługi reduced-motion.
Main zapisuje wybór atomowo w `app-updates.json`. Bridge udostępnia tylko typowane
operacje i status, bez plików, poświadczeń ani dowolnego IPC.

| Wybór | Dopuszczone wydania | Feed | Prerelease |
| --- | --- | --- | --- |
| Stable | stable | latest | nie |
| Beta | stable, beta | beta | tak |
| Nightly | stable, beta, nightly | nightly | tak |

Wygrywa najwyższy SemVer wśród ukończonych wydań z feedem platformy i manifestem.
Stable publikuje trzy aliasy, beta dwa, nightly jeden; aliasy wskazują ten sam zestaw
plików w konkretnym release. Manifest ma nadal `app: desktop`, a checksums obejmuje
także feedy i blockmapy. Mac ZIP pozostaje wymagany.

Przejście do mniej stabilnego kanału jest wyłącznie w przód. Przejście do stabilniejszego
wymaga natywnego potwierdzenia ryzyka starszej wersji, nieczytelnych danych i awarii.
`allowDowngrade` dotyczy tylko sprawdzenia/pobrania po tej zgodzie i jest resetowane
w `finally`. Nie utrwala się na kolejne sprawdzenia ani restart. Zmiana preferencji
unieważnia wcześniej pobraną aktualizację; operacje są serializowane między oknami.

## Weryfikacja

- `bun install`: sukces, przypięte zależności bez zmian lockfile.
- `bun run typecheck`: sukces, Svelte 0 błędów i 0 ostrzeżeń; dodatkowo desktop typecheck po korekcie kierunku przełączenia.
- `bun run gen:check`: sukces.
- `actionlint -shellcheck= .github/workflows/release.yml`: sukces, binarka actionlint 1.7.12 z katalogu mise; shim bez ustawionej wersji nie działał.
- Testy aktualizacji: **6 pass, 0 fail**, prawdziwy electron-updater 6.8.3 i GenericProvider przez lokalny HTTP na losowym porcie; stub wyłącznie pobierania/instalacji binarki.

Testy obejmują wybór feedów latest/beta/nightly, brak przecieku prerelease do Stable,
nowsze stable dla Beta, odrzucenie draftu/niekompletnego wydania, odmowę i zgodę na
downgrade, reset flagi po sukcesie i błędzie, zmianę do mniej stabilnego kanału bez
downgrade'u, serializację potwierdzenia i odtworzenie preferencji po restarcie.
Scalanie macOS zachowuje obie architektury w fixture i odrzuca błędny hash.

Pakiety Linux x64 AppImage + deb wszystkich trzech kanałów: sukces.

| Build | Pliki (w `apps/desktop/release/<kanał>/`) | Feedy po merge |
| --- | --- | --- |
| stable 0.3.0 | `Canopy-0.3.0-linux-x64.{AppImage,deb}` | latest/beta/nightly-linux.yml |
| beta 0.3.0-beta.1 | `Canopy-0.3.0-beta.1-linux-x64.{AppImage,deb}` | beta/nightly-linux.yml |
| nightly 0.3.0-nightly.1 | `Canopy-0.3.0-nightly.1-linux-x64.{AppImage,deb}` | nightly-linux.yml |

Sprawdzono `dist/identity.json` i `package.json` wewnątrz każdego końcowego ASAR:
wszędzie Canopy, `app.canopy.desktop`, `canopy`, `canopy://`, `canopy.desktop`.
Wszystkie deb mają `Package: canopy` (prerelease wersjonowane przez deb jako `~beta.1`
i `~nightly.1`). `app-update.yml` ma odpowiednio latest/beta/nightly i jeden cache
`canopy-updater`. Realne pliki każdego buildu przeszły merge z kontrolą SHA-512 oraz
generację manifestu: po dwa instalatory `app: desktop`. Porównanie `cmp` potwierdziło
identyczną treść aliasów stabilnego i beta. Wyniki: `.tmp/update-feeds/<kanał>/assets/`.

Build każdego kanału zawierał produkcyjny build web oraz kompilację sidecarów z jego
wersją. Lokalny fpm wymagał `libcrypt.so.1`: użyto biblioteki libxcrypt-compat wyłącznie
w ignorowanym `apps/desktop/build/compat/`, bez zmian systemu. TMPDIR pakowania
ustawiono na dysk (`.tmp/desktop-package`), ponieważ próba deb na tmpfs zakończyła się
błędem tar. Po tej korekcie wszystkie pakiety przeszły. Stable przepakowano po ostatniej
zmianie kontrolera; rozpakowany shell zawiera końcową regułę kierunku przełączenia.

Pierwszy pełny `check:tmp`: dwa błędy w niezmienionych `tests/integration/bots.test.ts`
(timeout 5 s i kolejne porównanie), następnie SIGTERM/143 bez podsumowania.
Boty osobno: **17 pass, 0 fail**; worker-restart osobno: **6 pass, 0 fail**.
Własny katalog tymczasowy przerwanego przebiegu usunięto po ustaniu procesu.
Drugi pełny `bun run check:tmp`, po zakończeniu pakowania: **651 pass, 144 skip,
2 fail** (797 testów / 138 plików, 650 s), katalog tymczasowy czysty. Błędy dotyczyły
niezmienionych testów: gotowości PostgreSQL w `background-task-notes.test.ts` oraz
limitu 5 s przy restarcie bota w `bots.test.ts`.
Powtórka obu zestawów przez `bun run check:tmp tests/integration/background-task-notes.test.ts
tests/integration/bots.test.ts --timeout 30000`: **27 pass, 0 fail**, katalog czysty.
Ostatni pełny `bun run check:tmp --timeout 30000`: **662 pass, 144 skip, 0 fail**
(806 testów / 138 plików, 3645 asercji, 584,22 s), katalog tymczasowy czysty.
144 pominięcia dotyczą testów opt-in/live. Limit podniesiono tylko argumentem runnera;
nie zmieniono kodu ani testów spoza zakresu. Oba wcześniejsze błędy nie powtórzyły się
w pełnym przebiegu; test restartu bota trwał w nim 447 ms.
Logi lokalne: `/var/tmp/canopy-update-check-tmp-final.log` (drugi przebieg),
`/var/tmp/canopy-update-check-focused.log` (powtórka obu zestawów),
`/var/tmp/canopy-update-check-tmp-30s.log` (ostatni pełny przebieg).

Końcowy przegląd objął autoryzację IPC, zgodę i reset downgrade'u, unieważnienie
poprzednio pobranej aktualizacji, wspólną tożsamość pakietów oraz kompletność aliasów
i manifestu. Nie wykazał blokad w implementacji. Ograniczenia platformowe i migracji
opisano poniżej.

## Kontrola Chromium

Mock bridge w pamięci strony, bez gatewaya i bez rzeczywistych poświadczeń.
Produkcyjny build web pod własnym portem 5387; serwer i karty zamknięto po kontroli.
Desktop 1280 px oraz telefon 390 px, light/dark: brak przewijania poziomego.
Otwarto combobox i wybrano Nightly; fokus wrócił do kontrolki. Sprawdzono stany idle,
downloading (47%, kanał i Check zablokowane), downloaded (Restart to update).
Nie dodano testów web UI. Nie zweryfikowano całej ścieżki Settings z żywym gatewayem;
ten sam komponent sprawdzono na lokalnym ekranie konfiguracji.

Zrzuty: [light](light.png), [dark/progress](dark.png),
[mobile light](mobile-light.png), [mobile dark/restart](mobile-dark.png).

## Migracja i Mac

Stare `Canopy Beta` / `Canopy Nightly`, w tym 0.2.0-nightly.2, wymagają jednorazowej
ręcznej instalacji Canopy. Squirrel nie zmieni designated requirement dawnego bundle ID.
Brak automatycznego importu; stare userData pozostaje nietknięte. Kopia działającej bazy
i ciphertext związany z dawną tożsamością Keychain wymagają osobnej procedury odtworzenia.

Na prawdziwym Macu pozostaje potwierdzić Developer ID/notaryzację/staple/Gatekeeper,
ten sam designated requirement przy zmianach kanału, rzeczywisty download ZIP i restart
Squirrel, natywne Cancel/potwierdzenie downgrade'u oraz zachowanie danych na ich kopii.
Build ad-hoc musi pokazywać „Updates need a signed build” i nie pobierać feedu.

## Uprawnienia

Przy przekazaniu `origin/dev` wskazywało już `c6d5564`: w trakcie pracy doszły
commity #5–#8, w tym drag regions i wydajność desktopu. Gałęzi nie rebazowano po
weryfikacji. Rodzic powinien uwzględnić te zmiany przy integracji; pięć dodanych linii
`main.ts` dotyczy wyłącznie broadcastu i IPC aktualizacji.

`workflow_mode: direct`, `mode_source: explicit-user-task-instruction`,
`decision_authority: delegated`, `scope: current-task`, `artifact_state: not-required`,
`execution_mode: inline`. Lokalna implementacja i commit; bez push/PR, publikacji,
zmian produkcji i odczytu sekretów. Nie użyto chronionych portów, `/tmp/oa-stack`
ani `~/canopy`. Bez podagentów.
