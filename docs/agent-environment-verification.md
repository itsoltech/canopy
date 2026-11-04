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
