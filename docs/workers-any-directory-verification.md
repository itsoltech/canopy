# Workery bez roots — wdrożenie i weryfikacja

Gałąź: `feat/workers-any-directory`. Zmiany lokalne, bez push i PR.

## Rezultat i decyzje

Worker nie konfiguruje listy dozwolonych katalogów. Rejestracja `worker add` wymaga
`--name`, bez `--root`. Workspace może wskazywać dowolny istniejący katalog absolutny
dostępny dla użytkownika systemowego workera. Połączony worker sprawdza go przy
dodaniu/zmianie; ponowna walidacja przy starcie chroni przed użyciem usuniętego katalogu.
Brak katalogu, wskazanie pliku i ścieżka względna mają odrębne błędy. Istniejące tryby
uprawnień i sandboxy nadal obowiązują osobno dla każdego wątku.

Nowa baza scratch to **`<data_dir>/scratch/<user-id>/<thread-id>`**. Worker zgłasza
`scratch_root` oraz `home_directory` w Hello. Zmiana bazy aktualizuje workspace tylko dla
przyszłych rozmów; zapisane cwd istniejących wątków, forków i wątków bocznych pozostaje
bez zmian. Istniejące stare `.open-agents/scratch/...` oraz katalogi z poprzedniego
`data_dir` działają dalej. Nie są przenoszone ani odtwarzane, gdy ich brakuje. Zarządzane
poddrzewo scratch odrzuca symlinki; nowe katalogi POSIX mają `0700`.

Stare lokalne `allowedRoots` i `allowed_roots`, zdalne pole protobuf oraz JSON w bazie
są przyjmowane i ignorowane. Pola wire pozostają oznaczone jako deprecated; UI zwraca
pustą historyczną listę roots. **Migracja SQL nie jest potrzebna**: baza nie ma
ograniczenia wymagającego roots. Historyczne migracje pozostają niezmienione.

## UI i componentize

DirectoryPicker przy dodawaniu otwiera **home workera**, przy edycji — obecny katalog.
Można wpisać lub wkleić ścieżkę i użyć Go/Enter, przejść wyżej, wybrać Home albo skrót
do jednego z maksymalnie czterech katalogów już używanych przez projekty na tym workerze.
Nie dodano tworzenia folderów. Niezweryfikowana lub błędna ścieżka blokuje zapis.

WorkerPicker pokazuje nazwę, status online i OS. Ustawienia Threads grupują opcje według
projektu; etykietą opcji jest wyłącznie nazwa workera, również dla No project.
Harmonogramy i pozostałe listy workerów nie wyświetlają ścieżek. Szczegóły workera nie
mają sekcji roots. Ścieżki pozostają w ustawieniach projektu, panelu katalogu roboczego,
tooltipach i kopiowaniu.

Zastosowano skille `design` i `componentize`. Pass componentize przed końcowym commitem
wydzielił `DirectoryShortcuts.svelte` z własnym API `locations`, `disabled`, `onopen`
i `class`. Reużywa wspólnego Button; DirectoryPicker używa Input, Button, IconButton
i istniejących stanów ładowania/błędu. Układ otacza kontrolki wrapperami; nie dodano
natywnych kontrolek formularza ani osobnego zestawu testów web UI.

## Commity i main

| Commit | Zakres |
|---|---|
| `c9cb75c` | Backend, CLI, protokół i testy integracyjne dowolnych katalogów |
| `d8862f2` | Listy workerów, DirectoryPicker i pass componentize |
| `b72bfd8` | Merge main `fd097149e210906ed74504971c73885b62ab4b9e` |

Ostatni commit dokumentacyjny zawiera ten raport, aktualizację dokumentacji funkcji
i poprawki nieaktualnych komentarzy. Weryfikację kompilacji i testów wykonano po merge
main; późniejsze zmiany dotyczą wyłącznie dokumentacji i komentarzy.

## Weryfikacja automatyczna

| Sprawdzenie | Wynik |
|---|---|
| `bun install` | OK, bez zmian zależności |
| `bun run typecheck` | OK, Svelte: 0 błędów i 0 ostrzeżeń |
| `bun run gen:check` | OK |
| `bun run check:tmp` | OK: 575 pass, 127 skip, 0 fail; 2837 asercji, 111 plików, 301,28 s; brak pozostawionych katalogów testowych |
| `bun run --filter @open-agents/web build` i `git diff --check` | OK |

Znaczące scenariusze integracyjne obejmują rzeczywisty PostgreSQL, gateway, gRPC,
WorkerHost i adapter Codex: dowolny istniejący katalog trafia do uruchomionego CLI,
brak katalogu i wskazanie pliku dają błąd, usunięcie katalogu po dodaniu workspace'u
blokuje start wątku, scratch powstaje w data_dir, a stary scratch zachowuje cwd.
Stara konfiguracja z nieistniejącymi/względnymi allowedRoots stosuje się bez issues.
Bot `add_workspace` działa bez roots, `list_workers` ich nie ujawnia, a
`list_directory` otwiera home i zwraca odczytaną ścieżkę. Poprawiono dotychczasowe
fixture'y zakładające roots oraz oczekiwanie na gotową konfigurację i katalog workera.

Testy nie wymagają zewnętrznego modelu: lokalny zastępczy CLI obsługuje protokół
app-server i zapisuje rzeczywisty cwd procesu. Testów live przez CLIProxyAPI nie
uruchamiano; nie potwierdzono rzeczywistej odpowiedzi modelu. Web build zgłasza
ostrzeżenie Vite o rozmiarze chunka, ale kończy się kodem 0.
`check:tmp` odnotował wyłącznie runtime narzędzia `claude-1000`, wyłączony z kontroli
przez samą procedurę; katalogi testowe `oa-*` i `open-agents-*` zostały posprzątane.

Logi końcowe:

- [typecheck](/tmp/canopy-any-directory-typecheck-final.log)
- [web build](/tmp/canopy-any-directory-build-final.log)
- [check:tmp](/tmp/canopy-any-directory-check-tmp-final.log)

## Ręczne oględziny Chromium

Użyto `/usr/bin/chromium` i Playwright Core z `/tmp/ro-shot/node_modules/playwright-core`.
Osobny stack: gateway `18453`, web `5287`, PostgreSQL `25437`, dane w
`/tmp/canopy-any-directory-stack`. Workera zarejestrowano bez `--root`; plik lokalny
zawierał historyczne allowedRoots, które nie zablokowały zastosowania konfiguracji.
Po oględzinach zamknięto Chromium i zatrzymano wyłącznie własne procesy i kontener.
Artefakty pozostawiono na dysku.

Potwierdzono dodanie projektu/workspace'u, start w home, wpisywanie katalogu, Go,
Home, edycję, skrót używanej lokalizacji, czytelny błąd brakującego katalogu oraz
zablokowany zapis. Pickery kompozytora i ustawień Threads nie zawierają ścieżek;
Workers nie ma sekcji Directories. W harmonogramie opcja workera również zawiera
tylko nazwę. Nie stwierdzono błędów JavaScript ani poziomego przepełnienia
w sprawdzonych widokach; picker używa niestandardowego combobox/listbox.

| Widok | Jasny 1440 px | Ciemny 1440 px | Jasny 390 px | Ciemny 390 px |
|---|---|---|---|---|
| DirectoryPicker | [PNG](/tmp/canopy-any-directory-stack/artifacts/directory-light-1440.png) | [PNG](/tmp/canopy-any-directory-stack/artifacts/directory-dark-1440.png) | [PNG](/tmp/canopy-any-directory-stack/artifacts/directory-light-390.png) | [PNG](/tmp/canopy-any-directory-stack/artifacts/directory-dark-390.png) |
| WorkerPicker | [PNG](/tmp/canopy-any-directory-stack/artifacts/worker-light-1440.png) | [PNG](/tmp/canopy-any-directory-stack/artifacts/worker-dark-1440.png) | [PNG](/tmp/canopy-any-directory-stack/artifacts/worker-light-390.png) | [PNG](/tmp/canopy-any-directory-stack/artifacts/worker-dark-390.png) |
| Threads: Project and worker | [PNG](/tmp/canopy-any-directory-stack/artifacts/defaults-light-1440.png) | [PNG](/tmp/canopy-any-directory-stack/artifacts/defaults-dark-1440.png) | [PNG](/tmp/canopy-any-directory-stack/artifacts/defaults-light-390.png) | [PNG](/tmp/canopy-any-directory-stack/artifacts/defaults-dark-390.png) |
| Workers: szczegóły | [PNG](/tmp/canopy-any-directory-stack/artifacts/settings-workers-light-1440.png) | [PNG](/tmp/canopy-any-directory-stack/artifacts/settings-workers-dark-1440.png) | [PNG](/tmp/canopy-any-directory-stack/artifacts/settings-workers-light-390.png) | [PNG](/tmp/canopy-any-directory-stack/artifacts/settings-workers-dark-390.png) |

## Instrukcja aktualizacji istniejącego stacka dla lead

Nie odczytywano ani nie modyfikowano `/tmp/oa-stack/worker.json`, live env ani sekretów
CLIProxyAPI. Nie użyto portów `17443`, `5180`, `8444`.

1. Po merge zaktualizować i zrestartować gateway, worker oraz web. Worker zgłosi home
   i bazę scratch w Hello; nie potrzeba migracji SQL ani zmiany env.
2. W `/tmp/oa-stack/worker.json` zachować `gateway_url`, `worker_id`, `credential`,
   `data_dir` i pozostałe ustawienia połączenia. `allowedRoots`/`allowed_roots` można
   usunąć, ale nie jest to wymagane — nowa wersja je ignoruje.
3. Zachować obecny `data_dir`. Nowe scratch pojawią się automatycznie w jego
   podkatalogu `scratch`; nie przenosić starych katalogów i nie zmieniać `threads.cwd`.
4. Z przyszłych komend rejestracji usunąć `--root`.

Dokładnej wartości live `data_dir` nie podano, ponieważ nie odczytywano tego pliku.
