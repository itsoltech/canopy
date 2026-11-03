# No project — decyzje i weryfikacja

Gałąź: `feat/no-project-threads`. Zmiany zapisane lokalnie, bez push i PR.

Aktualizacja `feat/workers-any-directory`: bieżąca baza nowych rozmów to
`<data_dir>/scratch/<owner-user-id>/<thread-id>`, zgłaszana w `Hello.scratch_root`.
Roots nie są już konfigurowane ani sprawdzane. Istniejące katalogi ze starej lokalizacji
zachowują zapisane cwd. Poniższy zapis weryfikacji opisuje wcześniejsze wdrożenie;
aktualne wyniki i zasady są w [workers-any-directory-verification.md](workers-any-directory-verification.md).

## Decyzje

Każdy właściciel ma jeden systemowy projekt `kind = scratch`, ukryty w ustawieniach
projektów. Automatyczny workspace na dostępnego workera zachowuje istniejące wymagania
dotyczące projektu, właściciela, workspace'u i drzewa wątków.

Worker tworzy na `CreateThread` katalog
`<allowed_roots[0]>/<ukryty katalog aplikacji>/scratch/<owner-user-id>/<thread-id>`.
UUID jest jedynym składnikiem nazwy zależnym od rozmowy: tytuły nie trafiają do ścieżek.
Nowe katalogi mają uprawnienia POSIX `0700`; worker sprawdza rzeczywiste ścieżki i odrzuca
symlinki w zarządzanym poddrzewie. Nie rozszerza allowed roots. Forki i wątki boczne,
także `spawn_thread`, współdzielą cwd źródła. Każdy run harmonogramu dostaje osobny katalog.
Archiwizacja i usunięcie rozmowy nie usuwają plików; nie ma automatycznego cleanupu.
Panel rozmowy pokazuje pełną ścieżkę i opisuje ręczne sprzątanie.

Migracja `0032_scratch_projects` została wybrana jako pierwotny main `0029` + 3.
Po scaleniu zmian agent-bus i botów kolejność indeksu oraz testu schematu to
`0030_bus_notify_delivery`, `0031_bots`, `0032_scratch_projects`.
Migracja scratch dodaje wyłącznie kolumnę, indeks i ochronę tożsamości w `projects`;
nie zastępuje widoków ani ograniczeń przebudowanych przez poprzednie migracje.

## UI i pass componentize

Zastosowano skille `design`, `componentize` i `transitions-dev`.
Pass componentize obejmował wydzielenie `ProjectMark.svelte`: jedna implementacja
przerywanego kwadratu dla pickerów, sidebaru, archiwum, filtra, hover card, breadcrumbs
i palety. Istniejący `PanelRow` ma opcję `wrap` do pełnych ścieżek.
Kontrolki korzystają z istniejących SearchPicker/Select/Popover i ich przejść oraz
obsługi reduced motion; nie dodano natywnych selectów ani nowych zależności UI.

## Weryfikacja

| Sprawdzenie | Wynik |
| --- | --- |
| `bun install` po scaleniu botów | OK, bez zmian zależności |
| `bun run typecheck` | OK, Svelte: 0 błędów i 0 ostrzeżeń |
| `bun run gen:check` | OK, wygenerowany kontrakt zawiera scratch i Bots |
| `bun run --filter @canopy/web build` | OK |
| Końcowy pełny `bun run check:tmp` po scaleniu botów | 908 pass, 185 skip, 0 fail; 5156 asercji, brak pozostawionych katalogów testowych |
| Po scaleniu botów: integracje scratch, Bots i schemat DB | 60 pass, 0 fail; brak pozostawionych katalogów |
| Chromium po scaleniu botów | 4 pass, 0 fail; 64 asercje |
| Rzeczywisty agent przez CLIProxyAPI (`pwd`) | Niewykonany: brak bazowego URL proxy; sekret dostarczono oddzielnie, karta z URL wygasła bez odpowiedzi |

Jednostkowe sprawdzenia obejmują nazwy ścieżek, odrzucanie traversal, Windows/POSIX,
tworzenie i zachowanie katalogów, symlinki, allowed roots oraz wybór projektu/workera.
Integracje ze scripted workerem obejmują tworzenie bez zwykłego projektu, współbieżne
overview, izolację właścicieli, listowanie, filtr, wyszukiwanie, wzmianki, defaults,
archiwizację/usuwanie/cofnięcie, forki, side threads, `spawn_thread`, harmonogramy i zmianę
rootów. Test WorkerHost sprawdza przygotowanie katalogu przed wywołaniem providera i odmowę
utworzenia ścieżki poza allowed roots. Bot odkrywa `kind: scratch` przez `list_projects`,
a `start_thread` tworzy wątek z poprawnym workspace'em, workerem i cwd oraz dostarcza wynik.

Browser suite uruchamia własny PostgreSQL, gateway, scripted worker i produkcyjny web
na porcie `5391`, używa `/usr/bin/chromium` przez playwright-core. Nie korzysta ze stacka
prywatnego stacka live ani portów `17443`, `5180`, `8444`.
W każdym wariancie sprawdza pierwszą pozycję No project, zmianę projektu, worker offline,
utworzenie rozmowy przez composer, ścieżkę i informację o zachowaniu plików, filtr,
grupę defaults, ukrycie projektu systemowego w Settings → Projects i formularz harmonogramu.
Sprawdza też brak poziomego overflow, natywnych selectów i błędów JS strony.

Lokalny fixture HTTP używa `PROTOCOL_HEADER=x-forwarded-proto` i nagłówka `http`;
ochrona CSRF SvelteKit pozostaje włączona. Build i test Chromium uruchamiano kolejno.
Pełna suite Docker i Chromium również wymagają rozdzielenia: zmiany interfejsów hosta
podczas tworzenia kontenerów potrafią przerwać połączenia przeglądarki.

Test live jest w `tests/integration/no-project-threads.live.test.ts` i korzysta z
`useLiveProxy`, rzeczywistego WorkerHost i Codex. Wymaga wykonania komendy `pwd`, zgodności
odpowiedzi z `thread.cwd`, statusu completed i zachowania katalogu po archiwizacji.
Dane można przekazać przez `CANOPY_LIVE_PROXY_FILE` (prywatny JSON z `url` i `key`) albo
osobne `CANOPY_LIVE_PROXY_URL_FILE` i `CANOPY_LIVE_PROXY_KEY_FILE`. Test z `CANOPY_LIVE=1` odmawia
cichego pominięcia przy brakujących danych lub Dockerze. Nie zapisuje danych proxy w repo.
W tym przebiegu próba live zatrzymała się na weryfikacji danych wejściowych, przed połączeniem
z modelem. Nie potwierdzono uruchomienia rzeczywistego agenta ani jego `pwd`.
Host i klucz nie zostały zapisane w repo, commitach ani logach.

## Screenshoty

W katalogu `artifacts/no-project-threads/` są po sześć ujęć dla każdej kombinacji
1440/390 px i light/dark: `picker`, `composer`, `path`, `filter`, `defaults`, `schedule`.
Pliki pozostają lokalnymi artefaktami; katalog jest ignorowany przez Git.

| Wariant | Picker | Pełna ścieżka | Harmonogram |
| --- | --- | --- | --- |
| 1440 light | [picker](../artifacts/no-project-threads/1440-light-picker.png) | [path](../artifacts/no-project-threads/1440-light-path.png) | [schedule](../artifacts/no-project-threads/1440-light-schedule.png) |
| 1440 dark | [picker](../artifacts/no-project-threads/1440-dark-picker.png) | [path](../artifacts/no-project-threads/1440-dark-path.png) | [schedule](../artifacts/no-project-threads/1440-dark-schedule.png) |
| 390 light | [picker](../artifacts/no-project-threads/390-light-picker.png) | [path](../artifacts/no-project-threads/390-light-path.png) | [schedule](../artifacts/no-project-threads/390-light-schedule.png) |
| 390 dark | [picker](../artifacts/no-project-threads/390-dark-picker.png) | [path](../artifacts/no-project-threads/390-dark-path.png) | [schedule](../artifacts/no-project-threads/390-dark-schedule.png) |

## Commity implementacyjne

| Commit | Zakres |
| --- | --- |
| `af9a2c4` | Model, migracja, kontrakt, gateway, worker, testy i dokumentacja backendu |
| `3355786` | UI No project, współdzielona ikona, browser suite i dokumentacja |
| `6bad55c` | Zachowanie zwykłych projektów, zmiany rootów, obsługa etykiet w browser suite |
| `3d6ad13` | Lista migracji w teście schematu po integracji agent-bus |
| `fab4f44` | Prywatne pliki danych proxy i jawne wymagania testu live |
| `523e9d4` | Integracja narzędzi botów z No project i test rzeczywistego przepływu platformy |

Merge main: `1bb782a`, `86e7afc`, `3e76086`, `293fb12`.
Ostatni obejmuje main `f4314ad` z botami i migracją `0031`.
Po tej integracji ponowiono instalację, typecheck, gen:check, build, pełny check:tmp
oraz wszystkie cztery warianty Chromium. Przy końcowej kontroli main nadal wskazywał `f4314ad`.
