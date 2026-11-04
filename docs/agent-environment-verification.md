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
