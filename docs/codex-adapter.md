# Adapter Codex (app-server)

Status: **w budowie**.

Gotowe:
- typy protokołu z przypiętej wersji: `packages/codex-protocol` (Codex 0.164.0),
- klient JSON-RPC: `apps/worker/src/providers/codex/rpc.ts`,
- serwis procesu: `CodexAppServer` w `app-server.ts`,
- mapowanie powiadomień na zdarzenia transkryptu: `CodexEventMapper` w `mapping.ts`,
- runtime wątków: `CodexThreads` w `threads.ts` (create, fork, resume po restarcie procesu, tury, przerwanie; zdarzenia najpierw do dziennika, potem publikacja; zgody, pytania i elicitation do brokera interakcji),
- tryby uprawnień platformy → polityka zgód i sandbox Codexa: `permissions.ts`,
- testy na żywo: `app-server.live.test.ts`, `threads.live.test.ts`.

- podpięcie do workera: `WorkerHost` i `serveLink` (`apps/worker/src/runtime`): komendy z gateway (`CreateThread`, `StartTurn`, `InterruptTurn`, `ListDirectory`), kontrola `cwd` względem dozwolonych katalogów, interakcje przez link (ponawiane po ponownym połączeniu), przebudowa runtime'u Codexa przy zmianie konfiguracji, ale nigdy pod turą w toku.

- szyna agentów: narzędzia jako `dynamicTools` przy `thread/start`, wywołania `item/tool/call` przekazywane do gateway (`AgentToolCall`) i odpowiadane wynikiem ([agent-bus.md](agent-bus.md)).
- konektory: prywatny lokalny MCP `canopy_connectors`; aktualizacja na granicy tur przez unsubscribe/resume tej samej sesji z historią i sprawdzenie jej natywnego katalogu. Sam reload MCP nie odświeża niezmienionego połączenia w 0.164.0 ([connectors.md](connectors.md#ograniczenia-sesji-harnessów)).

- modele, wysiłek i steer: `model/list` (katalog dla każdego profilu; profil CLIProxyAPI także `GET /v1/models` pośrednika, `providers/models.ts`), `turn/start` z `model` i `effort`, `turn/steer` ([protocol.md](protocol.md#modele-effort-i-steer)).

- cele: komenda `SetGoal` → `thread/goal/set` (`origin: user`, z `objective` i `tokenBudget` przy nowym celu, sam `status` przy pauzie i wznowieniu) albo `thread/goal/clear`; wątek nieznany procesowi jest najpierw wznawiany ([goals.md](goals.md)),
- procesy w tle: komenda unified exec, która trwa po `turn/completed`, dostaje item `background_task`; `StopTask` → `thread/backgroundTerminals/terminate` ([execution.md](execution.md#4-zadania-w-tle)).

## Runtime wątków

- **Konfiguracja instancji:** jeden app-server per instancja, także bez własnych zmiennych. Każda zmiana oznacza runtime jako nieaktualny; nowa praca czeka na koniec jego tur i zadań w tle, potem jeden restart stosuje najnowszą konfigurację. Inne instancje działają dalej. Ścieżka `CODEX_HOME` nie zależy od rodzaju połączenia, a proxy jest wpisem `model_providers` przez `-c`. `thread/resume` jawnie wybiera bieżący provider (`openai` po powrocie do Device login). Równoczesne wznowienia tej samej sesji korzystają z jednego rejestru.

- **Zmiana połączenia:** wątek zachowuje `provider_profile_id` (id instancji), a jawna zmiana jej połączenia obejmuje kolejne tury istniejących wątków. Device login używa providera `openai`, proxy — `canopy_<id instancji>` (myślniki zamienione na podkreślenia). `canopy_native` oznacza zatem proxy instancji o id `native`, nie logowanie urządzenia. App-server dostaje również `-c model_provider=…` z tym samym wyborem: samo `modelProvider` w żądaniu nie wystarcza wersjom CLI sprawdzającym bieżący provider procesu przy `turn/start`. Sekrety nadal trafiają wyłącznie do env; plik konfiguracyjny domu CLI urządzenia pozostaje bez zmian.
- **Historia przy zmianie połączenia:** Codex 0.164.0 obsługuje jawne `modelProvider` w zimnym `thread/resume`, więc id sesji, pełna historia i referencje tur pozostają te same. Nie potrzeba nowej sesji, skrótu historii z importu ani notatki o takim przeniesieniu. Źródła przypiętego tagu: [app-server — wznowienie i fork](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/thread_processor.rs), [core — wznowienie z historią](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/thread_manager.rs), [kontrola wymagań providera](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/config_manager.rs). Fork także przyjmuje provider, ale tworzyłby zbędną nową tożsamość sesji. Zarządzane wymagania Codexa mogą nadal zabronić danej trasy; Canopy ich nie omija. Odmowa „This chat uses …, but your current provider is …” ma klasę `connection_changed`, opis przywrócenia poprzedniego połączenia i akcję ustawień, zamiast komunikatu o błędzie wewnętrznym.
- **Pokrycie:** `connections.test.ts` uruchamia prawdziwy app-server z lokalnymi atrapami API, prywatnym home i sztucznym kluczem: Device login → proxy → inne proxy → inny profil → Device login, z zachowaniem całej historii. `tests/integration/instance-changes.test.ts` sprawdza przełączenia i drain wszystkich trzech harnessów; atrapa Codexa sprawdza zgodność providera procesu i wątku. `codex-connections.test.ts` sprawdza wznowienie po restarcie i prezentację odmowy przez gateway↔worker. Te testy nie wykonują płatnej inferencji.
- **Import z obcym providerem:** Codex 0.166 sprawdza zapisany provider przed nadpisaniem w `thread/resume` ([źródło](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/config_manager.rs)). Dla importów worker przygotowuje wyłącznie kopię potwierdzoną manifestem oraz jej wiersz w prywatnym indeksie Codexa; szczegóły w [import.md](import.md#codex-natywnie). Wcześniejsze importy naprawiają się przy następnej turze. `codex-resume.test.ts` sprawdza Device login i proxy, obcy provider, ponowne zimne wznowienie, pełną historię oraz nienaruszone źródło; na 0.166 także odmowę przed naprawą. `codex-provider.test.ts` sprawdza zakres aktualizacji indeksu, dowiązania, idempotencję i Undo. Odmowa „which is no longer configured” również trafia do `connection_changed`.

- **Tury platformy:** `turn/start` dostaje `clientUserMessageId = turn_id`. Wyłącznie odpowiedź tego RPC wiąże ID tury Codexa z turą platformy. Powiadomienia wątku przychodzące przed odpowiedzią czekają w buforze tego wątku (inne wątki działają dalej), a potem trafiają do dziennika w pierwotnej kolejności. Samoczynne `turn/started` (np. kontynuacja celu) dostaje własne ID i `origin = PROVIDER`, nawet gdy wyprzedzi odpowiedź na start użytkownika. Odmowa RPC również zwalnia bufor; pobudka nie przejmuje wtedy odrzuconego wejścia. Ponowny koniec lub późny output modelu zachowuje stare ID tury i daje najwyżej jeden log `codex_late_turn_event` na turę; zwykły output procesów w tle nie ostrzega.
- **Ponownie dostarczony `StartTurn`** z tym samym `turn_id` nie startuje drugiej tury.
- **Regresje granic tur:** `turn-boundaries.test.ts` używa skryptowanego app-servera: pobudka przed odpowiedzią RPC, odmowa startu, późne wiadomości i koniec poprzedniej tury oraz nowe wejście przy zajętych slotach harnessów governor’a. To wymuszone sekwencje protokołu, bez płatnej inferencji; nie są nagraniem incydentu z urządzenia.
- **Model i wysiłek:** `turn/start` zawsze dostaje `model` i `effort`: wartości ze `StartTurn`, a bez nich domyślny model katalogu (`model/list`, `isDefault`) i jego domyślny wysiłek: `model_reasoning_effort` z `config.toml` urządzenia (z profilu wybranego przez `profile`, potem główny), jeśli model go oferuje, inaczej `defaultReasoningEffort`. Izolowany `CODEX_HOME` nie ma tych ustawień, więc czyta je worker (tylko odczyt, [protocol.md](protocol.md#modele-effort-i-steer)). Nadpisanie w Codexie obowiązuje „tę i kolejne tury”, więc bez jawnych wartości tura po nadpisaniu zostałaby na poprzednim modelu.
- **Katalog:** `model/list` zwraca wbudowany katalog, ten sam dla każdego dostawcy modeli (`model_provider` go nie zmienia). Dla profilu CLIProxyAPI worker pyta pośrednika (`GET /v1/models`, a o modalności `GET /v1beta/models`): modele katalogu, których pośrednik nie obsługuje, odpadają; jego pozostałe modele agenta dochodzą bez danych o wysiłku, a modele obrazów, wideo, mowy, embeddingów itd. są pomijane (`isAgentModel`). `default_effort` każdego modelu to skonfigurowany domyślny wysiłek, jeśli model go oferuje, inaczej `defaultReasoningEffort`.
- **Steer:** `turn/steer` z `expectedTurnId` (Codex odmawia, gdy aktywna jest inna tura albo żadna) i `clientUserMessageId = input_id`. Codex emituje item `userMessage` z `clientId`, mapowany na `UserMessage.client_id`, i kontynuuje turę z tym wejściem (wejście przyjęte w trakcie odpowiedzi też trafia do tej tury). Tura już zakończona: `STEER_NOT_RUNNING`.
- **Wznowienie:** wątek nieznany bieżącemu procesowi jest wznawiany przez `thread/resume` z `ThreadSpec.provider_thread_id` (źródłem prawdy jest gateway).
- **Rekoncyliacja z rolloutu:** każda tura zapisuje w dzienniku workera ścieżkę rolloutu i id tury Codexa (`turn_harness`). Gdy worker przegapi koniec tury (restart, awaria app-servera), czyta rollout (`transcript.ts`): `event_msg item_completed` przez ten sam mapper co na żywo, koniec z `task_complete` (z `error`: błąd harnessu, kod z `codex_error_info`) albo `turn_aborted`. Gdy app-server kończy się sam, jego tury są rozliczane od razu (bez zapisanego końca: `failed`, `process_exit`), a następna komenda startuje nowy app-server. Przerwanie bez `turn/interrupt` od platformy jest systemowe (Codex przerywa turę także, gdy zamknie mu się wejście). Szczegóły: [durability.md](durability.md#35-rekoncyliacja-z-transkryptu-harnessu).
- **Wątek bez rolloutu:** Codex zapisuje rollout wątku dopiero z pierwszą turą, więc wątek utworzony tuż przed restartem workera i bez żadnej tury nie da się wznowić (`thread/resume` → `no rollout found for thread id …`). Worker zaczyna wtedy nowy wątek (`thread/start` z tymi samymi parametrami i narzędziami szyny), zapisuje go pod tym samym `thread_id` platformy i zgłasza `thread_ready` z `replaces_provider_thread_id` = stary id; gateway podmienia `provider_thread_id` (dozwolone tylko przed pierwszą turą). Nic nie ginie: stary wątek nie miał historii. Fork bez tury (z historią źródła) wznawia się normalnie. Potwierdzone na żywo (`threads.live.test.ts`, 2026-11-01): pusty wątek i pusty fork po restarcie, potem trzeci proces wznawia nowy wątek.
- **Przerwanie tury spoza procesu:** `InterruptTurn` dla tury, której ten proces workera nie prowadzi, kończy się `TURN_NOT_RUNNING` (sprawdza `WorkerHost`, wspólnie dla Codexa i Claude).
- **Wyścig końca z przerwaniem:** adapter sprawdza również `finishedTurns`, zanim wyśle `turn/interrupt`; ponowne Stop tej samej tury nie wysyła drugiego RPC. Otrzymane `turn/completed` oznacza koniec przed odczytem rolloutu i zapisem końcowych zdarzeń. Steer nadal używa wyłącznie `turn/steer`, także dla notatek zadań w tle. Odmowa RPC usuwa znacznik przerwania, aby można było ponowić Stop.
- **Uprawnienia:**

  | Tryb | Polityka zgód | Sandbox |
  |---|---|---|
  | `ASK` (i nieustawiony) | `on-request` | `read-only`, każdy zapis pyta |
  | `ACCEPT_EDITS` | `on-request` | `workspace-write` |
  | `READ_ONLY` | `never` | `read-only` |
  | `FULL_AUTO` | `never` | `workspace-write`, nigdy `danger-full-access` domyślnie |
  | `FULL_ACCESS` | `never` | `danger-full-access` (w turze `sandboxPolicy: { type: "dangerFullAccess" }`), tylko jawny wybór |

  Ta sama tabela idzie w każdym `turn/start` jako `approvalPolicy` + `sandboxPolicy` (tryb tury ze `StartTurn.permission_mode`), bo Codex trzyma nadpisanie dla kolejnych tur ([protocol.md](protocol.md#modele-effort-i-steer)).

- **Żądania serwera:** zgody na komendy i zmiany plików, uprawnienia, pytania i elicitation idą do brokera interakcji, a `item/tool/call` (narzędzia szyny) do gateway. Inne żądania kończą się błędem JSON-RPC.

**Fork od tury** ([threads.md](threads.md#fork-od-tury-fork-from-here)): `thread/fork { threadId: źródło, lastTurnId: provider_turn_ref tury }` (codex-cli 0.164, schemat v2 `ThreadForkParams.lastTurnId`: tury po niej są pominięte; nie z tury w toku, a tury nieudane i przerwane są dozwolone). `thread/rollback` nie jest potrzebny. Bez `after_provider_turn_ref` przy podanej turze worker odmawia (`FORK_POINT_UNKNOWN`) zamiast forkować całą historię. Na żywo: `fork-from-turn.live.test.ts` (trzy tury, fork od drugiej pamięta drugą jako ostatnią).

## Mapowanie zdarzeń

`CodexEventMapper` (jeden na wątek) zamienia każde powiadomienie wątku na co najmniej jedno zdarzenie `ThreadEvent` z `raw_json`. Bez mapowania zdarzenie nie ma ciała, ale nie ginie. Testy odtwarzają nagrane strumienie z fixture'ów (`fixtures/*.jsonl`, bez ścieżek lokalnych i metadanych moderacji) i przepuszczają wynik przez tę samą projekcję co gateway i UI (`reduceItem`).

| Codex | Zdarzenie platformy |
|---|---|
| `turn/started` | `turn_started` (`provider_turn_ref`, `origin`: komenda platformy albo tura dostawcy, np. kontynuacja celu) |
| `turn/completed` | `turn_finished` (wynik, powód błędu, ostatnie zużycie tokenów) |
| `thread/status/changed` | `activity` (`active` → running, z flagami → waiting_input, `systemError` → failed) |
| `item/started` / `item/completed` | `item_started` / `item_completed` z itemem: wiadomość (z `phase`: komentarz / odpowiedź końcowa), rozumowanie, komenda, zmiana plików, MCP, narzędzie dynamiczne (narzędzia szyny → `agent_bus_call`), wyszukiwanie, plan, obraz, kompaktowanie, subagent; reszta → `provider_item` |
| `item/agentMessage/delta`, `item/reasoning/*Delta`, `item/commandExecution/outputDelta` | `item_delta` (`text`, `summary`, `output`) |
| `turn/plan/updated` | item `plan:<turn>` z krokami (każda aktualizacja zastępuje stan) |
| `thread/tokenUsage/updated` | `usage_updated` |
| `error` | `notice` (`warning`, gdy Codex ponowi; inaczej `error`) |
| `thread/goal/updated` / `cleared` | `goal_state` (status, `objective`, `tokensUsed`, `timeUsedSeconds`, `tokenBudget`; `cleared`) |
| `commandExecution` z `processId` w toku przy `turn/completed` | item `background_task` `bg:<id>` (`kind = PROCESS`, `task_id = processId`) tuż przed `turn_finished`; dalsze `outputDelta` i `item/completed` (kod wyjścia, zatrzymanie) trafiają do niego, bez `turn_id` |
| rollout: `custom_tool_call` `exec` + `custom_tool_call_output`, `function_call` `wait` | item `tool_call` (komórka trybu kodu: skrypt i pełny wynik), patrz [Tryb kodu](#tryb-kodu-code-mode) |
| rollout: `function_call` `exec_command` bez itemu Codexa | `command_execution` złożony z wywołania i wyniku (kod wyjścia, output), na końcu tury |
| hooki, `readState`, metadane moderacji, diff tury, ... | zdarzenie bez ciała, tylko `raw_json` |

`error` nigdy nie kończy tury, również przy `willRetry = false`: dalsze itemy
pozostają w tej samej turze, a wynik określa dopiero `turn/completed.status`.
Diagnostyka z pustym `turnId` dostaje ID ostatniej rozpoczętej tury tego mappera,
także tuż po jej końcu; jawne ID starej tury pozostaje nadrzędne. Powiązanie jest
zapisywane w journalu i gatewayu, więc nie zależy od aktualnego stanu interfejsu.
`systemError`/`idle` w aktywności nie zeruje działającej tury gatewaya. Późny
koniec starej tury nie zmienia statusu nowszej. `provider-errors.test.ts`
odtwarza skryptowane sekwencje app-servera, a `provider-error-turns.test.ts`
sprawdza ich ingest przez gRPC, snapshot/live, pobudkę po `worker_shutdown`
i położenie stopki starej tury przed działającym foldem. To sekwencje regresji,
nie nagranie incydentu. Transport proxy: [proxies.md](proxies.md#codex-przerwanie-odpowiedzi-przez-proxy).
`codex-provider-warnings.test.ts` sprawdza prawdziwy WorkerHost i łącze gRPC ze
skryptowanym app-serverem: koniec zadania w tle dostarcza jeden platformowy steer
bez Stop, trzy błędy proxy bez ID zachowują turę, a poprawny koniec daje jedno
ostrzeżenie po live sync i ponownym odczycie. Spóźnione Stop i steer nie dochodzą
do app-servera. Nie odtwarza to połączenia upstream ani konkretnego urządzenia.

## Załączniki i obrazy

- Pliki leżą poza repozytorium (`<data_dir>/attachments/...`); sandbox Codexa (`read-only`, `workspace-write`) czyta cały dysk, więc nic nie trzeba dodawać.
- `view_image` platformy: narzędzie dynamiczne `canopy` › `view_image` ([agent-bus.md](agent-bus.md#view_image)); item `dynamicToolCall` z tą przestrzenią nazw → item `image` (`source = view_image`), podgląd z `contentItems[].inputImage`.
- Wbudowane `view_image` Codexa → item `imageView` → `image` (`source = native`), podgląd z pliku (`path`). Wygenerowane obrazy (`imageGeneration`, `savedPath`) → `source = generated`.
- Obrazy w wynikach narzędzi MCP (`result.content[].type = image`) → `ToolCall.images`.
- Obrazy umieszczone w tekście wiadomości: tekst dzieli się za znacznikiem `[Attachment N: nazwa]`, a tam idzie `localImage {path}` (`codex/input.ts`, [protocol.md](protocol.md#załączniki-w-tekście)). Echo `userMessage` dostaje z powrotem tekst wysłany.

## Wzmianki

- **Katalog** (`codex/catalog.ts`, `ListMentionCatalog`): `skills/list { cwds: [folder wątku], forceReload }` → skille (`enabled`; `interface.displayName`, `shortDescription`, `iconSmall` jako data URI do 24 KB, `brandColor`; zakres `repo` jako `project`), `plugin/list` → zainstalowane i włączone pluginy (`plugin://<id>`), `app/list` → dostępne i włączone aplikacje (`app://<id>`), tylko gdy worker włączył konektory. Komend Codex nie ma (jego `/komendy` to TUI).
- **Wejście** (`codex/input.ts`): tekst z `text_elements` (zakres bajtów UTF-8 + znacznik, jak zapisuje je kompozytor Codexa), itemy `skill`, `mention` i `localImage` (wspomniany plik obrazu). Plik zostaje jako `@ścieżka` w tekście.
- **Skille użytkownika:** proces platformowy zachowuje `HOME` i konfigurację narzędzi shella. Przy starcie app-servera worker wyłącza znalezione `~/.agents/skills/**/SKILL.md` przez natywne `skills.config` z selektorami ścieżek. Zachowuje skille biblioteki w izolowanym `$CODEX_HOME/skills`, skille projektu i własne skille systemowe w `$CODEX_HOME/skills/.system`; katalog pokazuje ich źródło. CLI 0.164.0 nadal odkrywa skille, gdy rozszerzenie ich wymaga, mimo `features.skip_host_skill_discovery=true`, więc ta flaga nie wystarcza. Lista wyłączeń jest snapshotem przy starcie procesu; po dodaniu skilli urządzenia trzeba zrestartować app-server (worker).

## Tryb kodu (code mode)

**Czym jest:** zamiast osobnych narzędzi model dostaje jedno narzędzie `exec` (custom tool), któremu podaje skrypt JavaScript. Skrypt działa w izolacie V8 i woła narzędzia Codexa przez `tools.*` (`tools.exec_command`, `tools.apply_patch`, MCP, ...), także równolegle. Wynik skryptu (`text(...)`, `notify(...)`) wraca do modelu jako `custom_tool_call_output`. Długi skrypt może oddać sterowanie (`Script running with cell ID ...`), a model wraca do niego narzędziem `wait`.

**Kto go włącza:** model, nie flagi. W katalogu modeli Codexa 0.164.0 (`codex debug models`) każdy aktualny model (`gpt-6.1-sol`, `gpt-6-*`, `gpt-5.6-*`) ma `"tool_mode": "code_mode_only"`. Wyjątek to `gpt-5.5` (`tool_mode: null`). Dlatego `codex features list` pokazuje `code_mode false`, a model i tak używa trybu kodu.

**Brakujące itemy komend:** użytkownik prosi o `ping 8.8.8.8`, `ls -lah` i `git status` w `workspace-write`; UI pokazuje tylko `ls` i `git status`. Przyczyny są dwie:

1. **App-server nie ma itemu dla komórki `exec`.** W protokole v2 (`ThreadItem`) nie ma typu dla custom tool call. Zagnieżdżone komendy przychodzą jako `commandExecution` (źródło `unifiedExecStartup`), ale skrypt i jego łączny wynik nie trafiają w żadne powiadomienie.
2. **Codex gubi item komendy, której wynik wygląda jak odmowa sandboxa.** To błąd Codexa, niezależny od trybu kodu. W trybie bezpośrednim (katalog bez `tool_mode`, jedno `exec_command` na komendę) `false`, `ls /brak`, `sh -c "exit 3"` i `nonexistent-cmd` (127) mają item. `ping` (`socket: Operation not permitted`, kod 2) i nawet `echo "Operation not permitted" >&2; exit 1` nie mają ani `item/started`, ani `item/completed`, także w rolloucie i w `turn/completed.items`. Model dostaje pełny wynik, transkrypt nic.

**Rozważone i odrzucone:**
- `features.code_mode_host=false`: model dalej dostaje `exec`, ale każde wywołanie kończy się `code-mode host is disabled`, więc agent nie może uruchomić żadnej komendy.
- Wyłączenie trybu kodu podmienionym katalogiem (`model_catalog_json` z `tool_mode` usuniętym): działa, ale zamraża katalog modeli, idzie wbrew temu, do czego model jest trenowany (Codex ostrzega o gorszej jakości), a luka nr 2 zostaje.
- `thread/start { experimentalRawEvents: true }` (powiadomienia `rawResponseItem/completed`): mają komórkę i wywołania, ale tylko w wątku utworzonym w tym procesie. Po `thread/fork` i po `thread/resume` w nowym procesie surowych zdarzeń już nie ma, a resume zdarza się po każdym restarcie workera.

**Odtwarzanie z rolloutu:** zachowujemy tryb kodu. Źródłem brakujących itemów jest rollout wątku, czyli własny zapis Codexa (`Thread.path`, `rollout.ts`). Działa tak samo po starcie, forku i wznowieniu:
- worker czyta przyrost pliku przy `item/started|completed` i przed `turn/completed` (czeka, aż w pliku będzie koniec tury). Linie tur spoza tego procesu (historia forka lub wznowienia) są pomijane,
- `ResponseItem` z rolloutu trafia do mappera jako `rawResponseItem/completed` (ten sam kształt co surowe zdarzenia protokołu, `raw_json` w dzienniku),
- komórka `exec` → item `tool_call` (`name = exec`, `input_json = {"code": ...}`, wynik ze wszystkich `custom_tool_call_output`). Startuje przed zagnieżdżonymi komendami, a jej wynik zawiera każdą komendę, także nieudaną, z `exit_code`. `wait` → `tool_call` z kolejną porcją wyniku,
- `exec_command` / `shell_command` / `shell`, dla których do końca tury nie przyszedł item Codexa o tym samym id (`call_id`), → `command_execution` z komendą, kodem wyjścia i outputem z wyniku wywołania. Rozstrzygane dopiero na końcu tury, bo rollout bywa przeczytany przed powiadomieniem o itemie tego samego wywołania,
- pozostałe elementy rolloutu (wiadomości, rozumowanie, narzędzia z itemami) nie dają zdarzeń, bo pokrywają je itemy app-servera.

Ograniczenie: w trybie kodu nieudana komenda jest widoczna w wyniku komórki `exec`, a nie jako osobny `command_execution`. Skrypt jest dowolnym JS, więc nie da się go wiarygodnie rozłożyć na komendy. Osobny item dla każdej komendy wymaga naprawy w Codexie (patrz niżej).

Do zgłoszenia w Codexie:
- item `commandExecution` (z `exitCode`) także dla komendy, której wynik wygląda jak odmowa sandboxa, przy `approvalPolicy: never`,
- item v2 dla komórki trybu kodu (`exec`, `wait`),
- `experimentalRawEvents` także w `thread/resume` i `thread/fork`.

## Protokół (zaobserwowany na 0.164.0)

- **Ramki:** jeden obiekt JSON na linię przez stdio, bez pola `jsonrpc`.
  - Klient → serwer: żądania `{id, method, params}` i powiadomienia `{method, params}`.
  - Serwer → klient: odpowiedzi `{id, result | error}`, powiadomienia `{method, params}` i żądania `{id, method, params}` (zgody, pytania, narzędzia dynamiczne), które czekają na odpowiedź.
- **Handshake:** `initialize { clientInfo, capabilities: { experimentalApi: true } }`, potem powiadomienie `initialized`. `experimentalApi` jest potrzebne dla `dynamicTools` (szyna agentów).
- **`thread/start`** zwraca wątek od razu, bez wywołania modelu.
- **Cele** (`thread/goal/set|get|clear`) działają bez wywołań modelu, dopóki cel nie jest `active`.

Przebieg tury (nagranie, odpowiedź „OK”):

```text
thread/status/changed (active) → turn/started → [mcpServer/startupStatus/updated, hook/*]
→ item/started|completed (userMessage) → item/started (agentMessage) → item/agentMessage/delta
→ turn/moderationMetadata → item/completed (agentMessage, pełny tekst) → thread/tokenUsage/updated
→ thread/readState/changed → thread/status/changed (idle) → turn/completed (items, status)
```

Błąd konfiguracji dostawcy: `thread/status/changed (systemError)` → `error { error: { message, codexErrorInfo }, willRetry }` → `turn/completed { status: failed, error }`.

## Testy na żywo

Opt-in, bo zużywają limity kont: `CANOPY_LIVE=1 bun test apps/worker/src/providers/codex/app-server.live.test.ts`.

- `CANOPY_LIVE_CLIPROXYAPI_URL`, `CANOPY_LIVE_CLIPROXYAPI_KEY`: tura przez profil CLIProxyAPI platformy. Lokalnie trzymane w pliku poza repozytorium (`~/.config/canopy/dev-live.env`, `0600`).
- `CANOPY_LIVE_NATIVE=1`: tura z konfiguracją Codexa właściciela urządzenia (wymaga, żeby działała bez interakcji).
- Nagrania strumieni: `CANOPY_LIVE_RECORD_DIR` (domyślnie `/tmp/canopy-codex-recordings`), materiał do mapowania zdarzeń.
- Testy przez gateway (`tests/integration/*.live.test.ts`) zakładają proxy jak produkt: `useLiveProxy` (`tests/integration/support/live.ts`) zapisuje workerowi jego część konfiguracji (katalogi, harnessy, bez logowania urządzenia) i globalną instancję `cliproxyapi` każdego harnessu przez API UI, włączoną na tym workerze ([worker-config.md](worker-config.md), sekcja 9).

## Izolacja od konfiguracji właściciela urządzenia

Bez `CODEX_HOME` app-server czyta `~/.codex` właściciela urządzenia: jego provider,
model, serwery MCP, wtyczki i hooki działałyby także w wątkach platformy.
Taka konfiguracja może też wymagać zmiennych środowiskowych niedostępnych workerowi.
Izolowany katalog zapobiega dziedziczeniu prywatnej konfiguracji i dodatkowego kontekstu.

### Konfiguracja izolacji

1. **Worker zawsze uruchamia app-server z własnym `CODEX_HOME`** (`<data_dir>/codex-home`, `0700`, `prepareCodexHome`). Konfiguracja (dostawcy, MCP, instrukcje) przychodzi z platformy.
   Wątki zachowują `HOME`, `USERPROFILE` i XDG: komendy potomne nadal widzą git identity, SSH, gh i konfigurację narzędzi użytkownika. Globalne instrukcje Codexa pozostają poza izolowanym `CODEX_HOME`; skille urządzenia wyłączają selektory opisane wyżej. Wątki scratch przekazują `project_root_markers=[]`, aby nie odczytywać nadrzędnego `~/AGENTS.md`; projekty zachowują wykrywanie korzenia Git i repozytoryjne instrukcje. Dowód: przechwycenie żądań CLI 0.164.0 w `providers/instruction-isolation.test.ts` i odczyt fixture git identity przez proces potomny w `providers/thread-environment.test.ts`. Źródło i ścieżka loginu nie zmieniają się; samodzielny login istniejący wyłącznie w keyringu nie jest przenoszony przez plik `auth.json`. Prywatne HOME pozostaje tylko dla botów bez shella.
2. **Logowanie właściciela urządzenia jest dowiązywane** (`~/.codex/auth.json` → `codex-home/auth.json`; token odświeża się wspólnie z CLI). Wyjątek: workery korzystające z CLIProxyAPI, gdzie gateway ustawia `WorkerConfig.codex.device_login = NONE` i dowiązanie jest usuwane. Windows może użyć twardego dowiązania na tym samym wolumenie: przypięty Codex zapisuje refresh w miejscu. Jeśli system odmawia obu rodzajów dowiązania, nie kopiujemy pliku; potrzebne są uprawnienia do symlinków albo własny login instancji.
3. **Natywni subagenci są wyłączeni** także dla modeli z `multi_agent_version: "v2"` w katalogu: `-c agents.enabled=false` obok `features.multi_agent*=false` (same feature'y nie wygrywają z katalogiem; [agent-bus.md](agent-bus.md#1-natywna-orkiestracja-dostawców-wyłączona)).
4. **Konektory konta są wyłączone** (`features.apps=false`). Po zalogowaniu kontem ChatGPT Codex uruchamia wbudowany serwer MCP `codex_apps` z aplikacjami połączonymi z kontem właściciela. W wątkach platformy byłby to dostęp do jego prywatnych kont. Można je świadomie włączyć (`NativeToolsConfig.connectors`).
