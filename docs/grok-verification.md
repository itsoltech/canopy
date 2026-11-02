# Odbiór providera Grok

Data: 2026-11-02. Gałąź `feat/grok-provider`; bazą końcowego odbioru jest merge `68d2090` z `main` (`a2b4ec6`), po poprawce katalogu i układu Agents `dff9ad6`. Nie wykonano push, PR ani wdrożenia. Architektura, tabela ACP → itemy i instrukcja włączenia: [grok-adapter.md](grok-adapter.md).

## Sprawdzenia repozytorium

| Polecenie | Wynik |
| --- | --- |
| `bun install` | OK, lockfile bez dodatkowych zmian |
| `bun run typecheck` | OK; także Svelte: 0 błędów, 0 ostrzeżeń |
| `bun run gen:check` | OK, wygenerowane kontrakty zgodne z proto |
| `bun run check:tmp` | Końcowy pełny przebieg po `68d2090`: 607 pass, 141 skip, 0 fail; 3190 asercji, 748 testów / 124 pliki, 311,33 s; brak pozostawionych katalogów testowych |
| `bun run --cwd apps/web build` | OK, produkcyjny build adapter-node |

Logi lokalne ostatnich sprawdzeń: `/tmp/canopy-grok-install-final2.log`, `/tmp/canopy-grok-types-final3.log`, `/tmp/canopy-grok-gen-final3.log`, `/tmp/canopy-grok-tmp-final2.log`, `/tmp/canopy-grok-build-final2.log`. Pierwszy pełny przebieg uruchomiony podczas scalania odrzucono jako dowód końcowy: zawierał odczyt markerów konfliktu i wcześniejszej listy migracji. Poprawiono też oczekiwania istniejących testów listy instancji, które nie uwzględniały trzeciego harnessu.

## Kontrakty bez płatnego modelu

| Zakres | Dowód |
| --- | --- |
| SDK → fake proces ACP | 6 testów: framing UTF-8, kolejne tury/load, permission round-trip, cancel i ponowne użycie sesji, crash/redakcja, timeout, abort callbacka, nieposłuszne anulowanie i zebranie procesu |
| MCP Groka | 1 test: bearer, dostępne narzędzia, konto connectora oraz jego metadane w itemach |
| Gateway/PostgreSQL ↔ WorkerHost → fake CLI | `tests/integration/grok-provider.test.ts`: native i proxy instance, sekret poza configiem, katalog effort rosnąco mimo odwrotnej kolejności ACP, start/completion, komenda/diff/reasoning/plan, MCP i podgląd obrazu, Allow/Deny, restart/load, steer→queue, interrupt oraz wygaśnięcie oczekującej zgody |
| Delegowanie między providerami | Test resolvera `packages/domain/src/agent-bus/agents.test.ts`: Claude/Codex → Grok i Grok → Claude/Codex, walidacja modelu/effort |
| Bot API | `apps/gateway/src/bots/model.test.ts`: request/reply chat completions i function tools; pełna wspólna pętla botów objęta istniejącymi testami integracyjnymi |

SDK i MCP razem: ostatni osobny przebieg 7 pass, 0 fail, 22 asercje (`/tmp/canopy-grok-sdk-final.log`). Nie dodano web UI testów ani testów powielających pojedynczą funkcję implementacji.

## Commity implementacji

| Zakres | Commity |
| --- | --- |
| SDK i odporność transportu | `7ecd3ab`, `a1c7cd4`, `db3c17a` |
| Worker, kontrakty, instancje, UI i boty | `d14cc36` |
| Resume, obrazy i anulowanie zgód | `187a73b`, `e296a63` |
| Platformowe connectory i settlement | `5181370` |
| Katalog effort i układ Agents | `dff9ad6` |
| Dokumentacja adaptera | `4c750c1` oraz końcowy commit raportu odbioru |

Scalenia `main`: `bae9fe7`, `223099c`, `20d426d`, `04249fd`, `68d2090`. Końcowy merge zawiera m.in. usuwanie kont connectorów; testy tego zakresu są częścią ponownego pełnego przebiegu. Nie zmieniano numeracji migracji z main; Przy merge do main Grok dostał 0043 (0042 zajęła migracja odpowiedzi botów).

## Live

CLI: `/home/nix/.local/bin/grok`, wersja `1.0.70 (f50904eaee6c)`. Publiczne źródła oraz lokalne materiały CLI opisuje dokument adaptera.

| Przebieg | Wynik |
| --- | --- |
| `packages/grok-acp/src/client.live.test.ts` | Handshake ACP v1 OK; loadSession, image, embeddedContext, MCP HTTP/SSE; auth `grok.com` |
| `apps/worker/src/providers/grok/launch.live.test.ts` przez proxy | OK: katalog, `run_terminal_command` z `pwd`, odpowiedź, platformowe `list_threads` przez HTTP MCP, dispose/cleanup i `session/load` w nowym procesie |
| Wybór modelu i trybu | `session/set_model` OK; `session/set_mode("default")` OK; brak ogłoszonej listy `modes` |
| Bot przez direct API | `grok-3-mini-fast`: function call `list_projects`, przekazanie tool result w następnym żądaniu i kolejna odpowiedź — OK, 1 test / 4 asercje |
| Native płatna tura | Pominięta: brak loginu `~/.grok/auth.json` i brak klucza native |

Proxy potwierdzono z `grok-4.7-build-fast` i `grok-composer-2.5-fast`. Ostatni przebieg launch: 1 pass, 1 skip, 0 fail, 7 asercji; log `/tmp/canopy-grok-live-final.log`. Bot: `/tmp/canopy-grok-bot-live.log`. Nie ponawiano płatnych tur po samych zmianach testów i dokumentacji.

Testy są opt-in, np. `OA_LIVE=1 bun test apps/worker/src/providers/grok/launch.live.test.ts`. Wymagają prywatnych `OA_LIVE_CLIPROXYAPI_URL` i `OA_LIVE_CLIPROXYAPI_KEY`; można ustawić `OA_LIVE_GROK_MODEL`. Host, klucz proxy i tokeny auth nie są umieszczone w repozytorium, zrzutach ani logach testów.

## Ręczny odbiór Chromium

Własny jednorazowy gateway/PostgreSQL/WorkerHost z deterministycznym fake Grokiem oraz web na porcie 5193. Chromium `/usr/bin/chromium`, Playwright Core z `/tmp/ro-shot`, nagłówek `x-forwarded-proto: http`. Przeglądarkę oraz własne procesy web/gateway/workera zatrzymano po odbiorze. Nie korzystano z `/tmp/oa-stack` ani portów 17443, 5180, 8444.

Sprawdzono: streaming i rozwijanie komendy/diffu/planu, kartę zgody Allow/Deny i odpowiedź po odmowie, wybór modelu, effort Low ↔ High klawiaturą, kreator Grok/API endpoint, listę Agents z Grok 1.0.70. Oba motywy przy 1440×1000 i 390×844; na mobile `innerWidth=scrollWidth=390`.

Zrzuty są lokalnymi artefaktami odbioru poza Git. W każdym wierszu: desktop light/dark, mobile light/dark.

| Widok | Zrzuty |
| --- | --- |
| Wątek, komenda i diff | [1440 light](/tmp/canopy-grok-screenshots/thread-light-1440.png), [1440 dark](/tmp/canopy-grok-screenshots/thread-dark-1440.png), [390 light](/tmp/canopy-grok-screenshots/thread-light-390.png), [390 dark](/tmp/canopy-grok-screenshots/thread-dark-390.png) |
| Zgoda | [1440 light](/tmp/canopy-grok-screenshots/approval-light-1440.png), [1440 dark](/tmp/canopy-grok-screenshots/approval-dark-1440.png), [390 light](/tmp/canopy-grok-screenshots/approval-light-390.png), [390 dark](/tmp/canopy-grok-screenshots/approval-dark-390.png) |
| Model | [1440 light](/tmp/canopy-grok-screenshots/picker-light-1440.png), [1440 dark](/tmp/canopy-grok-screenshots/picker-dark-1440.png), [390 light](/tmp/canopy-grok-screenshots/picker-light-390.png), [390 dark](/tmp/canopy-grok-screenshots/picker-dark-390.png) |
| Effort | [1440 light](/tmp/canopy-grok-screenshots/effort-light-1440.png), [1440 dark](/tmp/canopy-grok-screenshots/effort-dark-1440.png), [390 light](/tmp/canopy-grok-screenshots/effort-light-390.png), [390 dark](/tmp/canopy-grok-screenshots/effort-dark-390.png) |
| Agents | [1440 light](/tmp/canopy-grok-screenshots/agents-light-1440.png), [1440 dark](/tmp/canopy-grok-screenshots/agents-dark-1440.png), [390 light](/tmp/canopy-grok-screenshots/agents-light-390.png), [390 dark](/tmp/canopy-grok-screenshots/agents-dark-390.png) |
| Konfiguracja instancji | [1440 light](/tmp/canopy-grok-screenshots/instance-light-1440.png), [1440 dark](/tmp/canopy-grok-screenshots/instance-dark-1440.png), [390 light](/tmp/canopy-grok-screenshots/instance-light-390.png), [390 dark](/tmp/canopy-grok-screenshots/instance-dark-390.png) |

Zastosowano `design`, `componentize` i `transitions-dev`. Końcowy componentize pass objął ProviderIcon, wspólne pola Runtime/Connection, kreator instancji, ModelControls/EffortPicker oraz reprezentację providera w wątku/sidebarze/subagentach. Rozszerzono istniejące komponenty i katalogi; formularze używają wspólnych Input/Field/ChoiceCard/SecretValue. Grok nie wprowadza własnych animacji ani klas walczących z pozycjonowaniem/paddingiem kitowych kontrolek; korzysta z istniejącego Popover/GrowIn/Slider i motion. Self-review objął cleanup procesu, anulowanie zgód, scope connectorów, model/load, migracje i konwersje providerów.

## Granice dowodów i dalsza praca

Nie potwierdzono live obrazów, rzeczywistych diffów Groka ani mieszanego spawn Claude/Codex↔Grok. Obrazy/diffy mają dowód fake integracji, a wybór mieszanego spawn — test resolvera domain, bez deklaracji pełnego live parytetu. Odbiór przeglądarki używa fake CLI; prawdziwy CLI sprawdzono osobno przez SDK i MCP.

ASK ma fake round-trip Allow/Deny i anulowanie oczekującej zgody. Proxy live korzystał z FULL_AUTO. Nie wykonano pełnej macierzy zachowania rzeczywistego CLI w READ_ONLY/ACCEPT_EDITS/FULL_AUTO; konfiguracja sandboxa i automatyczne odpowiedzi callbacków przeszły self-review, ale nie należy utożsamiać tego z testem wszystkich polityk CLI.

Live bota sprawdza bezpośredni adapter API i kontynuację po wyniku funkcji. Nie uruchamia trwałej pętli bota z bazą danych; jej restart i zapisy mają osobne wspólne testy integracyjne bez płatnego modelu.

ACP fork, native goals, background-task lifecycle/stopTask i rekoncyliacja przerwanej tury z transkryptu pozostają niezaimplementowane. Cele i fork są jawnie niedostępne. Po restarcie wspólny mechanizm kończy utraconą turę, a kolejne wejście może załadować sesję. Dalszy native smoke wymaga zalogowania użytkownika workera; nie jest warunkiem działania instancji proxy.
