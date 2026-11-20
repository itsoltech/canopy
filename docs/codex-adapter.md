# Adapter Codex (app-server)

Aktualizacja (2026-11-19): karty zgód pokazują faktyczną treść żądania (sekcja „Treść zgód”), a podglądy obrazów natywnych i wygenerowanych dotyczą tylko ukończonych elementów w zakresie wątku.

Status (2026-11-20): runtime wątków, lokalny MCP z narzędziem wiadomości do delegującego bota, poziomy szybkości z katalogu konta,
bezstratny zapis obrazów wyników trybu kodu oraz per-modelowe liczniki tokenów i kosztów USD tur
oraz szacunki równowartości API OpenAI z trwałym cache cennika są zaimplementowane.
Rekoncyliacja odczytuje rollout przeniesiony przez Codexa między `sessions`
i `archived_sessions`, również w formacie `.jsonl.zst`.
Codex ponawia przerwane żądania proxy w bieżącej turze. Na Windows worker uruchamia
app-server także przez skrypt npm z katalogu ze spacjami. Dostępność wydań według [release.md](release.md).

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
- `message_delegating_bot` korzysta z katalogu MCP `canopy_connectors` przypisanego do konkretnego wątku. Dzięki temu dostaje je również wznowiony wątek założony przez bota, a fork właściciela ma własny katalog.
- konektory: prywatny lokalny MCP `canopy_connectors`; aktualizacja na granicy tur przez unsubscribe/resume tej samej sesji z historią i sprawdzenie jej natywnego katalogu. Sam reload MCP nie odświeża niezmienionego połączenia w 0.164.0 ([connectors.md](connectors.md#ograniczenia-sesji-harnessów)).
- lokalna automatyzacja: ten sam workerowy bridge wystawia gotowe `agent-browser`, `agent-desktop` i `agent-device` jako prywatne MCP HTTP per `threadId`; gateway autoryzuje każdy call ([automation-tools.md](automation-tools.md)).

- modele, wysiłek i steer: `model/list` (katalog dla każdego profilu; profil CLIProxyAPI także `GET /v1/models` pośrednika, `providers/models.ts`), `turn/start` z `model` i `effort`, `turn/steer` ([protocol.md](protocol.md#modele-effort-i-steer)).

- cele: komenda `SetGoal` → `thread/goal/set` (`origin: user`, z `objective` i `tokenBudget` przy nowym celu, sam `status` przy pauzie i wznowieniu) albo `thread/goal/clear`; wątek nieznany procesowi jest najpierw wznawiany ([goals.md](goals.md)),
- procesy w tle: komenda unified exec, która trwa po `turn/completed`, dostaje item `background_task`; `StopTask` → `thread/backgroundTerminals/terminate` ([execution.md](execution.md#4-zadania-w-tle)).

## Runtime wątków

- **Start procesu:** na Windows argumenty `-c` (m.in. wybór providera, konfiguracja proxy i selektory skilli)
  zachowują cudzysłowy przy starcie przez `codex.cmd`, także gdy ścieżka zawiera spacje.
  Log workera podaje etap awarii startu i kod wyjścia procesu, jeśli jest dostępny.

- **Konfiguracja instancji:** jeden app-server per instancja, także bez własnych zmiennych. Każda zmiana oznacza runtime jako nieaktualny; nowa praca czeka na koniec jego tur i zadań w tle, potem jeden restart stosuje najnowszą konfigurację. Inne instancje działają dalej. Ścieżka `CODEX_HOME` nie zależy od rodzaju połączenia, a proxy jest wpisem `model_providers` przez `-c`. `thread/resume` jawnie wybiera bieżący provider (`openai` po powrocie do Device login). Równoczesne wznowienia tej samej sesji korzystają z jednego rejestru.

- **Zmiana połączenia:** wątek zachowuje `provider_profile_id` (id instancji), a jawna zmiana jej połączenia obejmuje kolejne tury istniejących wątków. Device login używa providera `openai`, proxy — `canopy_<id instancji>` (myślniki zamienione na podkreślenia). `canopy_native` oznacza zatem proxy instancji o id `native`, nie logowanie urządzenia. App-server dostaje również `-c model_provider=…` z tym samym wyborem: samo `modelProvider` w żądaniu nie wystarcza wersjom CLI sprawdzającym bieżący provider procesu przy `turn/start`. Sekrety nadal trafiają wyłącznie do env; plik konfiguracyjny domu CLI urządzenia pozostaje bez zmian.
- **Historia przy zmianie połączenia:** Codex 0.164.0 obsługuje jawne `modelProvider` w zimnym `thread/resume`, więc id sesji, pełna historia i referencje tur pozostają te same. Nie potrzeba nowej sesji, skrótu historii z importu ani notatki o takim przeniesieniu. Źródła przypiętego tagu: [app-server — wznowienie i fork](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/thread_processor.rs), [core — wznowienie z historią](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/thread_manager.rs), [kontrola wymagań providera](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/config_manager.rs). Fork także przyjmuje provider, ale tworzyłby zbędną nową tożsamość sesji. Zarządzane wymagania Codexa mogą nadal zabronić danej trasy; Canopy ich nie omija. Odmowa „This chat uses …, but your current provider is …” ma klasę `connection_changed`, opis przywrócenia poprzedniego połączenia i akcję ustawień, zamiast komunikatu o błędzie wewnętrznym.
- **Pokrycie:** `connections.test.ts` uruchamia prawdziwy app-server z lokalnymi atrapami API, prywatnym home i sztucznym kluczem: Device login → proxy → inne proxy → inny profil → Device login, z zachowaniem całej historii. `tests/integration/instance-changes.test.ts` sprawdza przełączenia i drain wszystkich trzech harnessów; atrapa Codexa sprawdza zgodność providera procesu i wątku. `codex-connections.test.ts` sprawdza wznowienie po restarcie i prezentację odmowy przez gateway↔worker. Te testy nie wykonują płatnej inferencji.
- **Import z obcym providerem:** Codex 0.166 sprawdza zapisany provider przed nadpisaniem w `thread/resume` ([źródło](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/config_manager.rs)). Dla importów worker przygotowuje wyłącznie kopię potwierdzoną manifestem oraz jej wiersz w prywatnym indeksie Codexa; szczegóły w [import.md](import.md#codex-natywnie). Wcześniejsze importy naprawiają się przy następnej turze. `codex-resume.test.ts` sprawdza Device login i proxy, obcy provider, ponowne zimne wznowienie, pełną historię oraz nienaruszone źródło; na 0.166 także odmowę przed naprawą. `codex-provider.test.ts` sprawdza zakres aktualizacji indeksu, dowiązania, idempotencję i Undo. Odmowa „which is no longer configured” również trafia do `connection_changed`.

- **Tury platformy:** `turn/start` dostaje `clientUserMessageId = turn_id`. Wyłącznie odpowiedź tego RPC wiąże ID tury Codexa z turą platformy. Powiadomienia wątku przychodzące przed odpowiedzią czekają w buforze tego wątku (inne wątki działają dalej), a potem trafiają do dziennika w pierwotnej kolejności. Samoczynne `turn/started` (np. kontynuacja celu) dostaje własne ID i `origin = PROVIDER`, nawet gdy wyprzedzi odpowiedź na start użytkownika. Odmowa RPC również zwalnia bufor; pobudka nie przejmuje wtedy odrzuconego wejścia. Ponowny koniec lub późny output modelu zachowuje stare ID tury i daje najwyżej jeden log `codex_late_turn_event` na turę; zwykły output procesów w tle nie ostrzega.
- **Ponownie dostarczony `StartTurn`** z tym samym `turn_id` nie startuje drugiej tury.
- **Zerwany strumień Responses:** wspólna konfiguracja app-servera dla wątków i botów ogranicza liczbę prób jednego kroku przez proxy. Ponowienia odbywają się wewnątrz CLI z wynikami narzędzi w historii. Testy `stream-retries.test.ts` i `bots/codex-tools.test.ts` sprawdzają wyczerpanie limitu oraz wznowienie po wywołaniu narzędzia przy użyciu rzeczywistego CLI i lokalnego serwera Responses. [Limity prób i backoff](proxies.md#ponawianie-kroku-codexa)
- **Regresje granic tur:** `turn-boundaries.test.ts` używa skryptowanego app-servera: pobudka przed odpowiedzią RPC, odmowa startu, późne wiadomości i koniec poprzedniej tury oraz nowe wejście przy zajętych slotach harnessów governor’a. To wymuszone sekwencje protokołu, bez płatnej inferencji; nie są nagraniem incydentu z urządzenia.
- **Model i wysiłek:** `turn/start` zawsze dostaje `model` i `effort`: wartości ze `StartTurn`, a bez nich domyślny model katalogu (`model/list`, `isDefault`) i jego domyślny wysiłek: `model_reasoning_effort` z `config.toml` urządzenia (z profilu wybranego przez `profile`, potem główny), jeśli model go oferuje, inaczej `defaultReasoningEffort`. Izolowany `CODEX_HOME` nie ma tych ustawień, więc czyta je worker (tylko odczyt, [protocol.md](protocol.md#modele-effort-i-steer)). Nadpisanie w Codexie obowiązuje „tę i kolejne tury”, więc bez jawnych wartości tura po nadpisaniu zostałaby na poprzednim modelu.
- **Katalog:** `model/list` zwraca katalog procesu instancji. Metadane poziomów szybkości zależą od jego konta; nie przenosimy uprawnień między instancjami. Dla profilu CLIProxyAPI worker pyta pośrednika (`GET /v1/models`, a o modalności `GET /v1beta/models`): modele katalogu, których pośrednik nie obsługuje, odpadają; jego pozostałe modele agenta dochodzą bez danych o wysiłku, a modele obrazów, wideo, mowy, embeddingów itd. są pomijane (`isAgentModel`). `default_effort` każdego modelu to skonfigurowany domyślny wysiłek, jeśli model go oferuje, inaczej `defaultReasoningEffort`.
- **Szybkość:** `ModelInfo.service_tiers` kopiuje `model/list.serviceTiers` (identyfikator, nazwa i opis), np. `fast` lub `ultrafast` tylko wtedy, gdy oferuje je konto i model. Przestarzałe `additionalSpeedTiers` nie jest źródłem uprawnień. Katalog pośrednika nie dziedziczy poziomów konta OpenAI; brak potwierdzonego mechanizmu odkrywania poziomów przez proxy daje pustą listę. `thread/start`, `thread/resume`, `thread/fork` oraz każde `turn/start` dostają jawne `serviceTier`: wybór tury, w przeciwnym razie wybór wątku, w przeciwnym razie `default`. Wartość `default` wymusza zwykłą szybkość również po wznowieniu lub forku sesji fast; puste pole tury dziedziczy wybór wątku. Worker odrzuca poziom spoza katalogu bieżącego modelu/konta. Zmiana szybkości w steer daje `STEER_REJECTED`, więc wiadomość może przejść do kolejki kolejnej tury; `turn/steer` nie ma pola szybkości. Boty przekazują wybór również przy starcie/wznowieniu sesji i przy każdej turze. Przed dopuszczeniem botowej tury z niestandardową szybkością świeże `model/list` procesu potwierdza poziom dla modelu i konta; brak uprawnień kończy ją błędem `SERVICE_TIER_UNAVAILABLE` bez `turn/start`. `service-tiers.test.ts` sprawdza katalog konta, brak zgadywania z `additionalSpeedTiers`, start/resume/fork, reset i steer na granicy procesu.
- **Steer:** `turn/steer` z `expectedTurnId` (Codex odmawia, gdy aktywna jest inna tura albo żadna) i `clientUserMessageId = input_id`. Codex emituje item `userMessage` z `clientId`, mapowany na `UserMessage.client_id`, i kontynuuje turę z tym wejściem (wejście przyjęte w trakcie odpowiedzi też trafia do tej tury). Tura już zakończona: `STEER_NOT_RUNNING`.
- **Wznowienie:** wątek nieznany bieżącemu procesowi jest wznawiany przez `thread/resume` z `ThreadSpec.provider_thread_id` (źródłem prawdy jest gateway).
- **Rekoncyliacja z rolloutu:** każda tura zapisuje w dzienniku workera ścieżkę rolloutu i id tury Codexa (`turn_harness`). Gdy worker przegapi koniec tury (restart, awaria app-servera), czyta rollout (`transcript.ts`): `event_msg item_completed` przez ten sam mapper co na żywo, koniec z `task_complete` (z `error`: błąd harnessu, kod z `codex_error_info`) albo `turn_aborted`. Gdy app-server kończy się sam, jego tury są rozliczane od razu (bez zapisanego końca: `failed`, `process_exit`), a następna komenda startuje nowy app-server. Przerwanie bez `turn/interrupt` od platformy jest systemowe (Codex przerywa turę także, gdy zamknie mu się wejście). Szczegóły: [durability.md](durability.md#35-rekoncyliacja-z-transkryptu-harnessu).
- **Przeniesiony rollout.** Dla kanonicznej nazwy z identyfikatorem sesji z dziennika worker szuka tej samej nazwy
  w katalogu zapisanym przez Codexa, a następnie w drugim katalogu tego samego domu. W każdym katalogu
  pierwszeństwo ma `.jsonl` przed `.jsonl.zst`. Odczyt nie podąża za dowiązaniami wewnątrz domu.
  Dekoder Zstandard stosuje zapisany offset do bajtów po dekompresji i przyjmuje do 64 MiB danych od tego offsetu.
  Nieczytelny plik rozlicza się zgodnie z regułą braku zapisu. Testy `reconcile.test.ts` sprawdzają offset,
  przeniesienie w obie strony, jednoczesną obecność obu wersji, uszkodzony plik i dowiązanie.
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

- **Treść zgód:** karta zgody pokazuje faktyczną treść żądania Codexa w istniejącym kontrakcie `requestJson` (`command`, `reason`, `permissions`). Worker składa `reason` z powodu, rodzaju akcji, katalogu roboczego, środowiska, katalogu z dodatkowym zapisem, kontekstu sieci i dodatkowych uprawnień, więc użytkownik widzi je także, gdy oś czasu ma już komendę lub diff. Zgoda na `item/permissions/requestApproval` przyznaje dokładnie żądane uprawnienia; anulowanie lub odmowa daje pusty zestaw, a zakres sesji tylko po jawnej zgodzie.
- **Żądania serwera:** zgody na komendy i zmiany plików, uprawnienia, pytania i elicitation idą do brokera interakcji, a `item/tool/call` (narzędzia szyny) do gateway. Inne żądania kończą się błędem JSON-RPC.

**Fork od tury** ([threads.md](threads.md#fork-od-tury-fork-from-here)): `thread/fork { threadId: źródło, lastTurnId: provider_turn_ref tury }` (codex-cli 0.164, schemat v2 `ThreadForkParams.lastTurnId`: tury po niej są pominięte; nie z tury w toku, a tury nieudane i przerwane są dozwolone). `thread/rollback` nie jest potrzebny. Bez `after_provider_turn_ref` przy podanej turze worker odmawia (`FORK_POINT_UNKNOWN`) zamiast forkować całą historię. Na żywo: `fork-from-turn.live.test.ts` (trzy tury, fork od drugiej pamięta drugą jako ostatnią).

## Kompresja historii na dysku

**Odłożone:** automatyczna kompresja plików sesji przez Canopy. Eksperymentalne
`rollout/compress` w Codexie 0.171.0 uruchamia w tle przegląd obu katalogów,
`sessions` i `archived_sessions`, w całym `CODEX_HOME`. RPC potwierdza zlecenie
przed końcem operacji. Zapisem `.jsonl.zst` dla plików starszych niż siedem dni
i koordynacją z natywnymi writerami zarządza Codex. Włączenie wymaga zgodności
wszystkich czytników, także importu, naprawy i cofania kopii, trwałego usuwania oraz
starszych CLI po zmianie wersji. Obsługa tego formatu w workerze obejmuje odczyt
podczas rekoncyliacji. [RPC Codexa](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server/src/request_processors/rollout.rs),
[implementacja kompresji](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/rollout/src/compression.rs).

`thread_history_1.sqlite` przechowuje stronicowaną historię Codexa. W wersji 0.171.0
mechanizm odzyskiwania wolnych stron dostawcy pomija tę bazę. Canopy nie otwiera jej
do konserwacji ani nie wykonuje na niej `VACUUM`.
[Konfiguracja baz Codexa](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/state/src/sqlite.rs).

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
| `thread/tokenUsage/updated` | `usage_updated`: przyrost zużycia sesji przypisany do bieżącej tury; kontekst osobno z `last` |
| `rawResponse/completed` | per-response tokeny scalane bez podwójnego naliczania; `usageMetadata.amount` jest kosztem odpowiedzi w USD, z rozróżnieniem zera i braku kwoty |
| `error` | Ponawiane połączenie strumienia (`willRetry` i kod `responseStreamDisconnected` lub `responseStreamConnectionFailed`) trafia tylko do `raw_json`. Pozostałe zdarzenia tworzą `notice` z poziomem `warning` przy ponowieniu lub `error`. |
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

### Rozliczanie zużycia

`Usage.scope=TURN` oznacza narastający snapshot jednej tury platformy i jednego
modelu, a nie przyrost do bezwarunkowego dodania. `inputTokens` zawiera tokeny
cache read/write; `reasoningOutputTokens` jest podzbiorem `outputTokens`.
Nie dodajemy rozumowania ponownie do outputu. `reportedCostUsd` jest opcjonalną
kwotą przekazaną przez dostawcę; znane zero pozostaje zerem, brak kwoty jest
nieznanym zgłoszonym kosztem. Osobny szacunek `estimatedCostUsd` korzysta z cennika OpenAI opisanego niżej.

`thread/tokenUsage/updated.total` jest licznikiem sesji. Adapter odejmuje poprzedni
snapshot; przy pierwszej obserwacji bez bazowego licznika przyjmuje wyłącznie
`last`, a historyczne powiadomienie po resume/fork służy tylko jako baza.
Późne liczniki wcześniejszej tury nie zmieniają bazy trwającej tury. Dzięki temu
odziedziczona historia i fork nie zwiększają zużycia. Rekoncyliacja rolloutu
stosuje tę samą zasadę i zachowuje reasoning jako podzbiór outputu.
Odzyskane snapshoty są niezależne od zapisanego zakończenia tury i trafiają do
dziennika przed jej zamknięciem. Model musi być udowodniony w źródle; sam
`turn_context.model` jest żądanym modelem, a model-less `token_count` nie pozwala
przypisać sumy po reroute. Taki niejednoznaczny pomiar nie tworzy drugiego
licznika pod żądanym modelem. Niejednoznacznego zużycia po awarii nie szacujemy.

Nowe wątki włączają `experimentalRawEvents`. Każde `rawResponse/completed`
dostarcza tokeny jednej odpowiedzi i ewentualne `usageMetadata.amount`; adapter
deduplikuje `responseId`. Liczniki raw i sesyjne opisują te same wywołania,
więc nie są do siebie dodawane. Model pochodzi z konfiguracji tury oraz
`model/rerouted`; zmiana modelu zachowuje osobne snapshoty.
`usageMetadata.amount` jest dziesiętną kwotą USD jednej odpowiedzi. Adapter sumuje
te kwoty per tura/model, bez przeliczania według szybkości. Jawne `"0"` oznacza
znany zerowy koszt; null, brak, kwota ujemna lub niepoprawna pozostają nieznane.
`reportedCostUsd` jest dostępny, gdy wszystkie odpowiedzi mają poprawne kwoty,
a liczniki sesyjne nie wskazują dodatkowego zużycia poza odpowiedziami raw.
Opóźnione metadane raw mogą uzupełnić wycenę; odtworzenie tej samej odpowiedzi
nie dodaje kosztu ponownie.
Natywne raw itemy pozostają w historii, ale ich normalizacja nie dubluje
itemów odczytanych z rolloutu.

`thread/resume` i `thread/fork` nie udostępniają przełącznika raw, więc po
zimnym wznowieniu/forku tokeny nadal są rozliczane z liczników sesji, a zgłoszony koszt
pozostaje nieznany bez raportów `usageMetadata.amount`. Pojedyncze udowodnione
odpowiedzi mogą otrzymać osobny szacunek API opisany niżej. Snapshoty
napływają w trakcie pracy także dla tur później przerwanych lub błędnych;
niezgłoszonego zużycia po awarii nie szacujemy. Tury ukrytych botów emitują
te same snapshoty, a izolowane `GenerateText` przekazuje je do workera przez
callback rozliczeń.

Każdy snapshot ma `requestedServiceTier`: zaakceptowany wybór przechwycony
przy wysłaniu tury, zachowany także po zmianie ustawień wątku. Wartości natywne
(np. `priority`) pozostają bez zmian; `GenerateText` jawnie żąda `default`.
To atrybucja żądanej szybkości, nie dowód rzeczywistego poziomu rozliczeń.
Odzyskiwanie nie zgaduje tego pola z bieżących ustawień; brakujące dane może
uzupełnić tylko trwały zapis pierwotnej tury.

## Załączniki i obrazy

- Pliki leżą poza repozytorium (`<data_dir>/attachments/...`); sandbox Codexa (`read-only`, `workspace-write`) czyta cały dysk, więc nic nie trzeba dodawać.
- `view_image` platformy: narzędzie dynamiczne `canopy` › `view_image` ([agent-bus.md](agent-bus.md#view_image)); item `dynamicToolCall` z tą przestrzenią nazw → item `image` (`source = view_image`), podgląd z `contentItems[].inputImage`.
- Wbudowane `view_image` Codexa → item `imageView` → `image` (`source = native`), podgląd z pliku (`path`). Wygenerowane obrazy (`imageGeneration`, `savedPath`) → `source = generated`.
- Obrazy w wynikach narzędzi MCP (`result.content[].type = image`) → `ToolCall.images`.
- Tryb kodu: `custom_tool_call_output` i wynik `wait` (`function_call_output`)
  z `output[].input_image.image_url` → `ToolCall.images`, powiązanie przez `call_id`.
  Dokładne bajty PNG/JPEG/WebP/GIF do 8 MiB trafiają do blobu przed journalem;
  dopiero po wzbogaceniu itemu `raw_json` zastępuje inline URI obiektem
  `{canopyBlob: {sha256, sizeBytes, mimeType}, dataUrlPrefix}`. Szczegóły audytu,
  fallbacku i ochrony plików przed sprzątaniem: [transcript.md](transcript.md#obrazy).
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

Powiadomienia z jednego odczytu rolloutu są mapowane, wzbogacane i zapisywane
kolejno. Mapper zapamiętuje referencje obrazów po zapisie do journalu, więc
późniejszy wynik tekstowy tej samej komórki nie usuwa obrazów z jej projekcji.
Sam mapper zachowuje oryginalny `raw_json`; skracanie jest osobnym, czystym krokiem
po ekstrakcji obrazów. Pozostałe dane surowe i cały tekst wyniku pozostają bez zmian.

`images.test.ts` uruchamia skryptowany app-server i prawdziwy odczyt rolloutu:
kilka wyników w jednej paczce, `exec` i `wait`, obraz ponad 4 MiB, deduplikacja,
odtworzenie oryginalnego JSON i obrazów po restarcie journalu oraz upload per wątek.
`images/codex-output.test.ts` sprawdza zachowanie nieznanych i nieobrazowych pól,
brakujące referencje, niepoprawne dane, limit transportu i błąd zapisu.
`images/previews.test.ts` obejmuje też ochronę starych plików przez pending/held
journal i ich sprzątanie po ACK. To syntetyczne sekwencje adaptera, bez inferencji.

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

## Szacunek równowartości API OpenAI

Wątki, boty i generowanie tekstu współdzielą jeden `OpenAiPricingCatalog` workera,
inicjalizowany z `dataDir`; plik `pricing/openai.json` zachowuje ostatni poprawny
cennik, brakujące modele i cooldown także po restarcie. To wycena tokenów według
API OpenAI, nie rachunek za subskrypcję ani deklaracja kosztu proxy. Kwota
`usageMetadata.amount` pozostaje niezależnym `reportedCostUsd`.

Przed mapowaniem własnej `rawResponse/completed` adapter przygotowuje cennik
dokładnego identyfikatora modelu. Pobiera wyłącznie pliki TOML z katalogu
`providers/openai/models/` w repozytorium [models.dev](https://github.com/anomalyco/models.dev),
bez szukania modelu u innych dostawców i bez zgadywania aliasów. Jedno pobranie
jest współdzielone między równoległymi wywołaniami; cały cache ma najwyżej 256 modeli,
a odpowiedź HTTP limit 256 kB i timeout 4 s. Świeże ceny i brak modelu są ważne
dobę. Odświeżanie jest leniwe; błąd HTTP, parsowania lub sieci daje pięciominutowy
cooldown, zapisany przed żądaniem. Błąd nigdy nie przerywa tury. W tym czasie
oraz podczas awarii dostępne są ostatnie poprawne ceny. Katalog nie jest pobierany
przy każdym wywołaniu modelu ani przy licznikach odzyskanych z historii.

Obsługiwany jest schemat 2: ceny tekstowego wejścia i wyjścia, odczyt cache,
zapis cache oraz nadpisania `when.context.gt`. Próg dotyczy wejścia jednej
odpowiedzi, nigdy sumy całej tury. Tokeny cache są podzbiorami wejścia; reasoning
jest już częścią wyjścia i nie jest doliczany drugi raz. Codex nie przekazuje TTL
zapisu cache: jeżeli stawki zapisu zależą od TTL (np. `30m` i `12h`), odpowiedź
z zapisami pozostaje bez szacunku. Nie zgadujemy mnożników regionalnych.
Obsługiwane mnożniki `service_tier` pochodzą z katalogu; `fast` mapuje się na
`priority` wyłącznie na potrzeby wyceny. Natywne identyfikatory `fast`, `priority`,
`ultrafast` i `default` zachowują osobną tożsamość w żądaniach i agregatach.
Warunki czasowe mnożników (`date.lt`, `date.gte`) stosują datę zaobserwowania
odpowiedzi w `America/Los_Angeles`, zgodnie z granicą Pacific time w cenniku OpenAI.
Adapter zamraża ten czas przed ewentualnym pobieraniem katalogu; przekroczenie
granicy w trakcie pobierania ani późniejszy duplikat nie zmienia wcześniejszej wyceny.
Punktem odniesienia jest [oficjalny cennik OpenAI](https://developers.openai.com/api/docs/pricing).

Każda odpowiedź zamraża kwotę i pochodzenie cennika: URL, datę źródła i SHA-256
treści. `estimatedCostUsd` sumuje zamrożone kwoty w obrębie modelu i tury,
a `pricingVersion` przechowuje do 16 opisów wersji oraz skrót dalszych wersji.
Odświeżenie stawek nie przelicza wcześniejszych odpowiedzi. Brak surowego usage,
nieobsługiwana cena lub licznik zbiorczy przewyższający pokrycie surowych
odpowiedzi oznaczają nieznany szacunek, analogicznie do pokrycia zgłoszonego kosztu.
Po wznowieniu bez raw adapter może wycenić pojedynczą odpowiedź z `last`, jeśli
przyrost każdego licznika sesji jest dokładnie równy `last` (z wcześniejszym
baseline lub dla sesji, której `total` równa się `last`). Powtórzony snapshot nie
dodaje kosztu. Przyrost obejmujący kilka odpowiedzi albo brak baseline pozostaje
bez szacunku; nigdy nie wyceniamy sumy tury jako jednego kontekstu. Surowy i
zbiorczy strumień mają osobne sumy oraz współdzielą zamrożone wyceny odpowiadających
sobie odpowiedzi; żaden snapshot nie sumuje obu źródeł.

`providers/pricing/openai-catalog.test.ts` i `providers/codex/pricing.test.ts`
sprawdzają cache HTTP, restart i adaptery na lokalnym serwerze oraz skryptowanym
app-serverze, bez płatnej inferencji.

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
