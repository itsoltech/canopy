# Weryfikacja środowiska agentów — etap 1

Data: 2026-11-04. Gałąź `feat/agent-environment-1`, utworzona z `origin/dev`
(`d590c983`). Ponowny fetch przed zakończeniem potwierdził, że najwyższa migracja
na dev to `0054`; nowa migracja ma numer `0055`. Bez push, PR ani tagów.

## Wynik

Settings → Agent environment obsługuje wersjonowaną bibliotekę instrukcji Claude
i Codex: dokumenty, uporządkowane fragmenty, przypisania everyone/any/all/exclude,
automatyczne i ręczne tagi oraz dodatki/wyłączenia per maszyna. Podgląd szkicu liczy
gateway bez zapisu; status i porównanie driftu aktualizuje strumień overview.

Worker uzgadnia osobno dom CLI urządzenia i rzeczywiste izolowane domy instancji.
Zachowuje prywatny tekst poza managed block, zapisuje atomowo przez plik tymczasowy,
fsync i rename; błąd dziennika wycofuje własny zapis. Dziennik własności przeżywa
restart. Zmiany lokalne wymagają Keep mine / Overwrite / Import into library;
decyzja ma checksum całego obejrzanego pliku i jest jednorazowa. Offline worker
dostaje najnowszy stan po reconnect. Starsze workery nie dostają nowego payloadu.

Badanie CLI, źródła, uzasadnienia i plan stosu: [agent-environment.md](agent-environment.md).
Sprawdzono lokalne wersje Claude 2.1.308, Codex 0.164.0 i Grok 1.0.70 przez pomoc
i wersję, bez uruchamiania instalatorów. Istotny wynik: Codex ma plugin CLI,
a globalne skille `~/.agents/skills` nie izolują się samym `CODEX_HOME`.
Grok rozpoznaje globalny `~/.grok/AGENTS.md` i zgodne nazwy Claude.

## Sprawdzenia

| Polecenie | Wynik |
| --- | --- |
| `bun install` | PASS; bez zmiany lockfile; Bun zgłosił dwa zablokowane postinstall, nie uruchamiano ich ręcznie |
| `bun run gen:check` | PASS; nowe protokoły i wygenerowany kod są zgodne, paleta UI bez zmian |
| `bun run typecheck` | PASS we wszystkich pakietach, scripts i tools; Svelte 0 błędów i 0 ostrzeżeń |
| `bun run lint` | PASS; użyto dozwolonego `lint:spacing`, bez globalnego `oxlint --fix` |
| `bun run format:check` | PASS po `bun run format` |
| `bun run check:tmp` | PASS: **845 pass, 150 skip, 0 fail**, 995 testów / 161 plików; nic z `canopy-*` nie zostało w prywatnym TMPDIR |
| `bun run check:tmp tests/integration/agent-environment.test.ts tests/integration/agent-environment-files.test.ts` | PASS po końcowych poprawkach plików i compatibility: **14 pass, 0 fail**, 97 asercji; TMPDIR czysty |
| `bun test tests/integration/agent-environment.test.ts tests/integration/agent-environment-files.test.ts packages/db/test/schema.test.ts` | PASS: **34 pass, 0 fail**, w tym idempotencja migracji |
| `bun run --filter @canopy/web build` | PASS; standardowe ostrzeżenie bundlera o chunkach >500 kB |

Pełny log testów: `/home/nix/.cache/canopy-agent-environment/check-tmp.log`.
Końcowe logi typecheck/build: ten sam katalog, `typecheck.log` i `web-build.log`.
Po poprawce kolejności odświeżania UI ponowiono typecheck i build; nie dodawano
testów komponentów ani trwałego zestawu E2E UI.

## Pokrycie zachowania

1. Prawdziwe UI RPC → gateway → gRPC WorkerLink → WorkerHost: auto/manual tags,
   fragment Windows nie trafia na Linux, AND i exclude, wyłączenie per maszyna,
   niezapisany preview, izolacja ownera wszystkich operacji i stare `expected_revision`.
2. Pliki w tymczasowych domach: zachowanie lokalnej treści, idempotencja bez zmiany
   inode, odtworzenie własności po restarcie, rollback po błędzie dziennika, CAS,
   symlinki pliku i katalogu, nieznane/uszkodzone znaczniki, CRLF oraz lokalny drift
   przy usuwaniu. Limit odczytu jest ograniczony buforem, pliki specjalne odrzucane.
3. Keep/overwrite/import i ponowna identyczna lokalna edycja po overwrite: brak
   ponownego użycia starej zgody. Import pozostaje przypisany jednej maszynie.
   Offline catch-up i usunięcie tylko własnego bloku. Worker bez capability dostaje
   zwykłe komendy, lecz jego pliki instrukcji pozostają nietknięte.
4. Domy platformy: wspólne, own-login i jawny shadow home; adapter Claude czyta
   wyłącznie managed block. Codex `AGENTS.override.md` daje widoczny błąd.
   Nowe fakty workera przekraczające budżet instrukcji nie przerywają połączenia.

## Kontrola UI i komponentów

Zastosowano skille `design` i osobny końcowy przebieg `componentize`. Wykorzystano
istniejący UI kit. Edytor podzielono na AssignmentEditor, FragmentEditor,
MachineOverrides, TagInput; InstructionText współdzielą preview i diff. Komponenty
przyjmują `class`, odstępy między sekcjami pozostają w miejscu użycia.

Kontrola w prawdziwej przeglądarce: desktop **1280×800** oraz telefon **390×844**
CSS px, light i dark. Sprawdzono tagi, edytor, zawijanie długiej ścieżki, diff,
Keep mine oraz żywy podgląd po edycji. Kliknięcie Save and sync zakończyło się
potwierdzeniem w UI i nowymi bajtami w `data/claude-home/CLAUDE.md` fixture'a.
Nie stwierdzono poziomego przepełnienia treści funkcji ani błędów jej wywołań.

Zrzuty ekranu, lokalne artefakty poza repo:

- `/home/nix/.cache/canopy-agent-environment/evidence/desktop-light.png`
- `/home/nix/.cache/canopy-agent-environment/evidence/desktop-dark.png`
- `/home/nix/.cache/canopy-agent-environment/evidence/phone-light.png`
- `/home/nix/.cache/canopy-agent-environment/evidence/phone-dark.png`
- `/home/nix/.cache/canopy-agent-environment/evidence/editor-dark.png`

Fixture korzystał z osobnego PostgreSQL, losowego portu gRPC, web na **18680**,
wyłączonych harnessów i domów w `~/.cache/canopy-agent-environment/browser`.
Procesy fixture'a zatrzymano, kartę aplikacji zamknięto. Nie używano stosu
maintainera, jego domów CLI ani Tailscale.

## Przegląd i granice dowodów

`itsol-self-review`: sprawdzono owner scoping, addytywny capability gate, transakcje
rewizji, jednorazowe rozstrzygnięcia, zachowanie prywatnego tekstu, ograniczenia
odczytu i kompozycji oraz obsługę wyścigu odpowiedzi mutacji ze statusem SSE.
Nie stwierdzono blokera w zakresie etapu 1.

Skille, upload ZIP, pobieranie git/skills CLI, marketplace plugins i udostępnianie
między gatewayami pozostają etapami 2–4, opisanymi w projekcie. Nie są częścią
tej implementacji. Żaden kod upstream nie został zainstalowany.

Testy wykonano na Linux; tag Windows jest symulowany, nie zastępuje natywnego
testu zapisu na Windows/macOS. Testy live są pominięte; nie wykonywano sesji modeli.
Przerwanie procesu między rename instrukcji a zapisem dziennika wymaga decyzji
drift po restarcie. Nie ma transakcji obejmującej wiele plików. Już działające
sesje harnessów mogą zachować wcześniejsze instrukcje.

Lokalny commit etapu: `feat(agents): sync tagged global instruction environments`.
Dokładny SHA znajduje się w raporcie końcowym zadania.

---

## Etap 3 — źródła i utrzymanie

Data: 2026-11-04. Gałąź `feat/agent-environment-3`, po `git fetch origin`
utworzona z lokalnego `feat/agent-environment-2` (`a3fbec63`). Migracja
`0057_agent_skill_sources`, po najwyższej lokalnej migracji `0056`; wpis w indeksie
i schema test. Bez push, PR, tagów i zmian stosu maintainera.

### Badanie i rezultat

Przeczytano źródła skills **1.7.6**, commit
`9197d919034d19010ae303cf96bf19ad087dd4be`, bez wykonywania `npx`: parser,
discovery, add, konfigurację skills.sh.json i wyszukiwanie katalogu.
Linki do przypiętych źródeł oraz konkretny protokół:
[agent-environment.md](agent-environment.md#źródła--badanie-etapu-3).
Repozytoria mogą zawierać wiele skilli, root ma pierwszeństwo, katalog skills.sh
prowadzi do repo, a nie do paczki npm. Oddzielono limity całego repo i wybranych
artefaktów: duże zasoby projektu poza katalogami skilli nie są ich uploadem.

Gateway parsuje komendę bez shella, pobiera Git HTTPS do prywatnego stagingu,
zamraża commit/pliki w trwałym preview i importuje dopiero po Add and sync.
Śledzi ref, udostępnia diff i ręczne update, opt-in auto dla zmian bez skryptów,
pin i rollback z provenance. Istniejący reconcile synchronizuje wersje do workerów.
Prywatne źródła używają wyłącznie zaszyfrowanego magazynu konektorów; token
pozostaje w gateway. Docker gateway zawiera Git, BFF desktop/Docker/compose
i przykładowy env ustawiają 50M, co mieści maksymalny folder 25 MiB jako JSON.

### Sprawdzenia etapu 3

| Polecenie | Wynik |
| --- | --- |
| `bun install` | PASS; bez zmiany lockfile, dwa zablokowane postinstall pozostawiono bez ręcznego uruchamiania |
| `bun run gen:check` | PASS; addytywne UI RPC i wygenerowany kod zgodne, WorkerLink bez zmiany |
| `bun run typecheck` | PASS wszystkich pakietów; Svelte 0 błędów i 0 ostrzeżeń |
| `bun run lint` | PASS po dozwolonym lint:spacing; bez globalnego oxlint --fix |
| `bun run format:check` | PASS po bun run format |
| `bun run --filter @canopy/web build` | PASS; standardowe ostrzeżenie o chunkach >500 kB |
| `bun run check:tmp` | Końcowy pełny przebieg PASS: **870 pass, 150 skip, 0 fail**, 5338 asercji, 1020 testów / 164 pliki; TMPDIR czysty |
| `bun run check:tmp tests/integration/agent-skill-sources.test.ts tests/integration/thread-secrets.test.ts tests/integration/thread-mirrors.test.ts` | PASS: **28 pass, 0 fail**, 271 asercji, TMPDIR czysty; po zmianie oczekiwania na shutdown |
| `bun run check:tmp tests/integration/agent-skill-sources.test.ts` | PASS po końcowych poprawkach DNS/Git i teście tagu: **7 pass, 0 fail**, 73 asercje; TMPDIR czysty |

Logi w `/home/nix/.cache/canopy-agent-environment-3/`: `check-tmp.log`,
`check-tmp-final.log`, `focused-tests.log`, `final-focused-tests.log`,
`source-tests-final.log`, `gen-check.log`, `typecheck-final.log`, `lint.log`,
`format-check.log`, `web-build.log`, `browser.log`. Testy używają lokalnych bare Git,
lokalnego smart HTTP przez git http-backend, fałszywego registry oraz osobnego
PostgreSQL. Nie pobierają pakietów ani repo z Internetu i nie uruchamiają modeli.

### Pokrycie etapu 3

1. Pasted command z wersją CLI i flagami, repo z wieloma skillami, subpath,
   historyczny SHA, tag i GitHub tree ref, root preference, full-depth, skills.sh.json,
   skills.sh przez lokalny katalog oraz odrzucenie podmienionej tożsamości katalogu.
   Preview nie zmienia rewizji; upstream przesunięty przed Add nie zmienia
   zamrożonych bajtów. Executable i źródłowy commit są zachowane.
2. Update detection, diff z wyróżnionym skryptem, jawne Apply, gRPC reconcile
   i odczyt nowych bajtów w temp HOME. Rollback odtwarza pliki i wcześniejszy SHA,
   pin pauzuje scheduler. Odtworzony serwis działa z trwałym stanem; auto-update
   dopuszcza dokumentację i zatrzymuje zmianę skryptu do review.
3. Owner scoping preview/konta/update/historii. Oficjalny konektor GitHub i własne
   konto tego samego origin autoryzują prawdziwy lokalny HTTP fetch (test obserwuje
   tylko zgodność nagłówka jako boolean). Obcy owner/host i odłączone konto są
   odrzucane; snapshoty, preview, artefakty, raporty workerów i audyt nie zawierają
   tokena. Registry nigdy nie dostaje Authorization.
4. Hostile shell, nieznane flagi, poświadczenia w URL, SSH/file/plain-local,
   loopback/metadata, traversal, zbyt duży plik skilla i symlink są odrzucane.
   Dumb HTTP kończy się błędem przed pobieraniem obiektów/alternates; URI bundli
   i packfile są wyłączone. Oczekiwanie na DNS podlega anulowaniu i deadline.
   Dwa równoległe resolve nie przekraczają limitu. Zawieszony lokalny fetch jest
   anulowany przy stop; shutdown czeka na cleanup, biblioteka pozostaje bez zmian
   i checker nie znajduje tymczasowych repo.

Po końcowym pełnym przebiegu ponowiono testy źródeł dla dodatkowej ochrony Git/DNS
i tag ref, a także typecheck, lint, format:check oraz web build. Nie rozszerzano
zestawu E2E. Oba pełne przebiegi były bez błędów; pierwszy miał 869 pass przed
dodaniem testu anulowania.

### UI, design i componentize

Zastosowano `design` i osobny przebieg `componentize`: kit Input/Select/Checkbox,
Disclosure/Alert/Button, wspólne SkillDestinations dla edycji i importu,
SkillSourceFiles dla przeglądu i update, VersionComparison także dla diffu źródła.
SourceCredentialPicker i SourceState oddzielają wybór konta oraz obsługę żądań.

Prawdziwa przeglądarka: **1280×800**, **390×844**, light/dark. Sprawdzono diff,
wyróżnienie skryptów, długie URL, zawijanie treści, import `bunx skills add …
--skill test-design --agent codex`, preview SHA/licencji/plików, Add and sync oraz
Apply update and sync. UI potwierdziło v2 istniejącego skilla i v1 nowego;
odczyt temp HOME Codexa potwierdził oba zestawy bajtów. Naprawiono wyścig rewizji:
odpowiedź check zmienia stan, a równoczesne SSE może pozostawić starszy snapshot
podczas własnego refresh; apply używa teraz rewizji zwróconej przez zakończony
odczyt. Po poprawce rzeczywiste kliknięcie Apply zakończyło się sukcesem.
Nie stwierdzono poziomego przepełnienia treści; jednoliniowy input przewija
wewnętrznie długą komendę. Nie dodano testów komponentów ani zestawu E2E UI.

Zrzuty poza repo, `/home/nix/.cache/canopy-agent-environment-3/evidence/`:

- `desktop-light.png`, `desktop-dark.png` — przegląd kandydata i diff.
- `phone-light.png`, `phone-dark.png` — ten sam widok na telefonie.
- `import-phone-light.png` — commit, licencja, pliki i wyróżnienie skryptu.
- `import-success-desktop-light.png` — potwierdzenie importu, wybrany commit i v2.

Fixture: własny web **18683**, losowe porty gatewaya i PostgreSQL, lokalne bare repo,
wyłączone harnessy i domy w `~/.cache/canopy-agent-environment-3/browser`.
Kartę zamknięto, własne procesy fixture'a zatrzymano. Nie dotykano prawdziwych
domów CLI, zastrzeżonych portów, procesów maintainera ani Tailscale.

### Przegląd i granice dowodów etapu 3

`itsol-self-review` lokalnie: owner/revision/CAS, zamrożenie i historia provenance,
brak sekretów w argv/artefaktach/workerze, URL-scoped auth, DNS pinning i brak
redirectów, limity Git/tree/blob, cleanup/anulowanie, brak wykonania upstream,
script review i rollback oraz współdzielone komponenty i bootstrap body limit.

Testy wykonano na Linux, bez live modeli, zdalnego prywatnego konta ani budowy
obrazu Docker. Natywne Windows/macOS wymagają osobnej weryfikacji Git i procesu;
istniejąca polityka izolowanych katalogów harnessów pozostaje bez zmian.
Resolver obsługuje HTTPS IPv4; SSH, lokalne i HTTP sources są świadomie odrzucane.
Flagi i discovery to opisany podzbiór skills CLI, nie wykonywanie dowolnej komendy.
64 MiB transferu jest limitem próbkowanym, nie twardą quota; auto-review skryptów
jest heurystyką i nie wykrywa ryzykownej treści instrukcji. Marketplace, npm
artefakty i linked library pozostają etapem 4.

Lokalny commit: `feat(agents): resolve skill sources and maintain pinned versions`.
Dokładny SHA znajduje się w raporcie końcowym zadania.

---

## Etap 2 — skille i tag picker

Data: 2026-11-04. Gałąź `feat/agent-environment-2`, oparta o lokalną
`feat/agent-environment-1`; wykonano fetch origin przed utworzeniem gałęzi.
Nowa migracja `0056_agent_skills` następuje po najwyższej migracji etapu 1 (`0055`),
z wpisem w indeksie i oczekiwanej liście schema test. Bez push, PR ani tagów.

Biblioteka przyjmuje folder/ZIP z walidowanym SKILL.md, przechowuje niezmienne
wersje i przypisuje je selektorami oraz wyłączeniami/pinami per maszyna.
Capability `agent_skills_v1` działa obok instrukcji. Worker uzgadnia rzeczywiste
cele Claude/Codex/Grok, prowadzi manifest własności, journal swapu i rollback,
zachowuje prywatne pliki. Drift ma porównanie plików, keep/overwrite/import;
import tworzy wersję przypiętą tylko komputerowi z konfliktem. Opis protokołu,
katalogów i ograniczeń: [agent-environment.md](agent-environment.md).

### Sprawdzenia etapu 2

| Polecenie | Wynik |
| --- | --- |
| `bun install` | PASS; bez zmiany lockfile |
| `bun run gen:check` | PASS; addytywne protokoły i wygenerowany kod zgodne |
| `bun run typecheck` | PASS wszystkich pakietów, scripts i tools; Svelte 0 błędów i 0 ostrzeżeń |
| `bun run lint` | PASS; bez wyłączeń reguł rozmiaru i bez globalnego autofix |
| `bun run format:check` | PASS po formatowaniu |
| `TMPDIR=~/.cache/canopy-agent-environment-2 bun run check:tmp` | PASS: **863 pass, 150 skip, 0 fail**, 1013 testów / 163 pliki, 5233 asercje; TMPDIR bez pozostałości testów `canopy-*` |
| `bun run check:tmp tests/integration/agent-skills.test.ts tests/integration/agent-skills-files.test.ts` | PASS: **18 pass, 0 fail, 165 asercji**, TMPDIR czysty; także zastrzeżona nazwa folderu Windows, duże raporty driftu i izolacja komponentów pluginu Claude |
| `bun run --filter @canopy/web build` | PASS; standardowe ostrzeżenie bundlera o dużych chunkach |

Pełne logi w `/home/nix/.cache/canopy-agent-environment-2/`: `check-tmp.log`,
`check-tmp-final.log`, `skills-tests-final.log`, `gen-check.log`, `typecheck.log`, `lint.log`,
`format-check.log`, `web-build.log`. Pełny przebieg obejmował działający PostgreSQL
17 i idempotencję migracji. Po nim dodano jeszcze odrzucanie zastrzeżonej nazwy
folderu skilla (`con`), budżet dużych raportów driftu i kontrolę komponentów pluginu
Claude; powtórzono testy skilli,
kontrole statyczne i pełny check:tmp (końcowy wynik w tabeli powyżej).
Narzędzie Claude pozostawiło własny `claude-1000`; checker odróżnia go od
katalogów testów Canopy. Nie dodawano testów web UI ani live sesji modeli.

### Pokrycie etapu 2

1. Prawdziwe UI RPC → gateway → gRPC WorkerLink → WorkerHost, temp HOMEs:
   folder/ZIP, traversal, symlink/specjalne wpisy ZIP, limity archiwum/pliku/sumy
   i liczby plików, zip bomb, kolizje katalogów i wielkości liter, SKILL.md oraz
   zastrzeżone nazwy Windows. Błędny upload nie zapisuje rewizji ani wersji.
2. Instalacja do domów CLI oraz wspólnych i jawnych domów instancji wszystkich
   trzech harnessów, w tym Codex `.agents/skills` i namespace pluginu Claude.
   Windows-only selector nie instaluje na Linux; disable i pin wersji działają.
   Worker bez skill capability zachowuje instrukcje i nie dostaje artefaktów.
   Adapter Claude odrzuca symlinki i komponenty spoza `skills/` w korzeniu pluginu,
   zachowując obce pliki zamiast włączania ich hooks/MCP przy starcie sesji.
3. Aktualizacja, rollback, własność po restarcie, idempotencja, błąd zapisu
   manifestu, odtworzenie przerwanego swapu, zachowanie równoczesnej edycji/backupów.
   Test sześciu rzeczywistych celów skilla z 7 MiB zasobów i równoczesnym driftem
   potwierdza limit raportu oraz udostępnienie odroczonego diffu po rozwiązaniu
   wcześniejszego konfliktu, bez nadpisania lokalnych zmian.
   Usunięcie zachowuje obce skille, prywatne pliki i puste katalogi; istniejącego
   folderu ani symlinku nie można przejąć. Usunięty element z driftem nadal
   wymaga świeżego rozstrzygnięcia.
4. Drift keep/stale CAS/overwrite/import, jednorazowość resolution, prywatność
   dodatków, import przypięty tylko jednej maszynie, offline catch-up do najnowszej
   wersji oraz owner scoping odczytu wersji, mutacji i resolutions.

### UI, design i componentize

Zastosowano `design` oraz osobny przebieg `componentize`. Wspólny TagInput używa
Combobox kitu z multi-select, chipami, licznikami automatic/manual tags oraz
tworzeniem tagu inline. AssignmentSummary współdzieli selektor z gatewayem.
Wyodrębniono SkillUpload, SkillEditor, SkillOverrides, SkillsLibrary, ComputerSkills
i SkillDiff; VersionComparison jest wspólny dla driftu instrukcji i skilli.

Prawdziwa przeglądarka: **1280×800** i **390×844** CSS px, light i dark.
Sprawdzono selekcję/usuwanie/tworzenie tagów i żywe podsumowanie, upload ZIP,
Save and sync (wersja 2 i odczyt nowych bajtów w temp HOME), porównanie lokalnego
driftu, Keep mine (status kept i zachowane bajty), następnie Overwrite (przywrócona
treść biblioteki). Brak poziomego przepełnienia funkcji; długie ścieżki zawijają
się, długie sugestie są celowo skrócone. Rozstrzygnięcie import potwierdzają testy
integracyjne. Karta przeglądarki i procesy fixture'a zostały zamknięte.

Zrzuty w `/home/nix/.cache/canopy-agent-environment-2/evidence/`:

- `desktop-light.png`, `desktop-dark.png`
- `phone-light.png`, `phone-dark.png`
- `tag-picker-light.png`, `phone-tag-picker-light.png`
- `skill-drift-dark.png`

Fixture: osobny PostgreSQL, losowy port gRPC, web **18682**, wyłączone harnessy,
domy wyłącznie pod `~/.cache/canopy-agent-environment-2/browser-final`.
Nie dotykano domów CLI maintainera, jego portów, procesów ani Tailscale.

`itsol-self-review`: owner scoping, walidacja ZIP i nazw, prawdziwe katalogi
harnessów, capability gate, manifest, odzyskiwanie przerwanego swapu, CAS,
zachowanie obcych plików, import z przypiętej wersji oraz blokowanie Save podczas
odczytu/błędu uploadu. Kontrola wykonana lokalnie, bez delegowania.

Granice dowodów: Linux; tag Windows jest symulowany. Nie wykonano natywnych testów
Windows/macOS ani live sesji CLI/modeli. Portable zamiana katalogu ma dwa rename
i krótkie okno braku ścieżki; nie ma transakcji obejmującej wiele celów. Przerwany
staging sprzed journalu wymaga ręcznego przeglądu. Prywatne `~/.agents/skills`
pozostają wykrywalne dla Codexa mimo izolowanego CODEX_HOME. Produkcyjny BFF
wymaga `BODY_SIZE_LIMIT=50M` dla maksymalnego folderu. Git/skills.sh, update tracking,
marketplace i linked library pozostają etapami 3–4.

Lokalny commit: `feat(agents): sync versioned skills and add tag pickers`.
Dokładny SHA znajduje się w raporcie końcowym zadania.
