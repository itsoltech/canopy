# API dla UI i architektura frontendu

## No project i katalogi scratch

`GetOverview.projects` zawiera projekt systemowy właściciela o `Project.kind = "scratch"`
(nowe pole **410**); zwykłe projekty mają `kind = "project"`. Jest pierwszy w odpowiedzi.
Klient ukrywa go w zarządzaniu projektami, ale pokazuje w pickerze nowego wątku, filtrze
sidebaru, domyślnym wyborze workspace'u i harmonogramach. Workspace'y scratch są provisionowane
automatycznie na dostępnych dla właściciela workerach z allowed roots. Zmiany workerów publikują
również aktualny projekt scratch przez `WatchOverview.project`.

`CreateThread` zachowuje istniejący kontrakt: `project_id` i `workspace_id` wskazują systemowe
zasoby wybrane z overview. Dla nowego głównego wątku scratch `cwd` musi być pusty: gateway nadaje
`<workspace.root_path>/<thread.id>`. Wymuszenie własnego cwd daje `InvalidArgument`.
Fork i wątek boczny dziedziczą katalog źródła. Komenda workera ma `ThreadSpec.scratch = true`
(nowe pole **410**): worker tworzy katalog przed uruchomieniem harnessu i sprawdza allowed roots.
Błąd utworzenia/walidacji to `SCRATCH_NOT_ALLOWED`; zwykłe wątki nie tworzą brakujących katalogów.

`Thread.cwd` pokazuje pełną ścieżkę. `ListThreads`, wyszukiwanie, wzmianki, archiwum i szyna
zachowują dotychczasowe reguły właściciela oraz drzewa. `sidebar.project_ids` może wskazywać
systemowy projekt, a `ThreadDefaults.workspace_id` — jego workspace. `NewThreadSchedule`
używa jego `project_id` i wybranego `workspace_id` z `placement = "specific"`; każdy run ma nowy cwd.
Botowy `list_projects` zwraca także `kind = "scratch"`; `start_thread` z identyfikatorem
projektu systemowego i workspace'em wybranego workera korzysta z tego samego nadawania cwd.
`CreateWorkspace`, `UpdateWorkspace`, `RemoveWorkspace`
i `UpdateProjectSettings` nie pozwalają ręcznie modyfikować zasobów systemowych.

Scratch powstaje dopiero przy `CreateThread`. `SearchFiles` w scope nowego wątku scratch
zwraca pustą listę; `ListMentionCatalog` pobiera komendy i umiejętności z pierwszego allowed root.
Scope istniejącego wątku używa jego cwd. Pliki są zachowywane bez automatycznego cleanupu,
także po archiwizacji lub soft delete; panel szczegółów opisuje ręczne sprzątanie.

## Bots

`RenameProject` zmienia nazwę zwykłego projektu właściciela. `ArchiveProject` atomowo
archiwizuje projekt, workspace'y i wątki przez istniejący lifecycle oraz anuluje
harmonogramy projektu, zachowując historię i pliki workerów. Scratch jest wykluczony.
`OverviewUpdate.project` z `Project.archived_at` (pole **480**) usuwa projekt z indeksu.
Obie operacje są dostępne również botom z tą samą walidacją; archiwizacja wymaga zgody.

Sekcja Bots korzysta z tego samego `GatewayService` i uwierzytelnienia BFF. Osobny
kontrakt `bots.proto` opisuje CRUD botów, rozmowy i ich stream, zgody oraz zdalne MCP.
`SidebarSettings.pinned_bot_ids` ma numer 350. Pełny zakres: [bots.md](bots.md).

## Pasek boczny i cykl życia wątku

`UserSettings.sidebar` przechowuje filtr projektów (`project_ids`, puste = wszystkie), przypięcia
(`pinned_thread_ids`) i rozwinięcie sekcji Archived (`archived_expanded`, pole 310). Dawne `archived`
pozostaje w kontrakcie jako przestarzałe i nie steruje listą. `UpdateUserSettings.sidebar` zastępuje sekcję
z kontrolą `expected_version`; `WatchOverview.user_settings` dostarcza zmiany innym urządzeniom.
Wyszukiwanie i przypięcia respektują filtr. Przypięte wątki boczne są samodzielnie dostępne w „Pinned”.

`ListThreads.sidebar_only` (310) zwraca aktywne wątki oraz archiwalnych bocznych pod aktywnym rodzicem
do „Previous agents”. Wyklucza boczne pod zarchiwizowanym rodzicem, także w danych sprzed kaskady.
BFF `GET /api/threads` używa tego indeksu. `include_archived` (270) zachowuje znaczenie dla starszych
klientów; nie jest używane do pobierania całego archiwum przez sidebar.

`ListArchivedThreads` przyjmuje `project_ids` (puste = wszystkie), `query` (fragment tytułu głównego,
bocznego albo nazwy projektu, bez rozróżniania wielkości liter), `page_size` (domyślnie 20, maks. 100),
`page_token` i `count_only`. Zwraca `threads`, `side_threads` tylko rodziców na tej stronie,
`next_page_token` i `total_count` głównych wierszy. Boczne nie są osobnymi pozycjami ani nie zwiększają
licznika. Porządek: `archived_at DESC, id DESC`. Kursor zachowuje mikrosekundy PostgreSQL i jest
związany z właścicielem i filtrami; zmiana filtra wymaga pierwszej strony. `%` i `_` są zwykłym tekstem.
BFF `GET /api/threads/archived?q=…&projectId=…&pageToken=…&countOnly=true` ustala strony po 20.
Zwinięta sekcja pobiera wyłącznie licznik, a bieżący wątek przez istniejące `GetThread`.
Zmiana live lub reconnect odświeża licznik i już załadowane strony z nowymi kursorami.

| Metoda | Działanie |
|---|---|
| `SetThreadArchived` | `{thread_id, archived}`: główny wątek archiwizuje też aktywne boczne w tej samej transakcji (`archived_by=cascade`, `archived_by_thread_id=rodzic`). Przywraca tylko te boczne; wcześniejsze `user` / `agent` pozostają archiwalne. Boczne można niezależnie archiwizować; przywrócenie wymaga aktywnego rodzica. Każdy objęty wątek przerywa turę, anuluje kolejkę i harmonogramy oraz otrzymuje aktualizację live. Przywrócenie nie wznawia pracy. `Thread.archived_at`, `archived_by`, `archived_by_thread_id`, `archived_by_thread_title` opisują czas i autora. `close_thread` zapisuje wątek zamykającego agenta. |
| `SetThreadRead` | `{thread_id, unread}`: jawny stan `Thread.marked_unread`; znacznik zdarzeń z migracji 0019 pozostaje monotoniczny. `MarkThreadSeen` usuwa też jawne nieprzeczytanie. |
| `DeleteThread` | `{thread_id}` → `thread_ids`: soft delete wątku i nieusuniętych wcześniej dzieci. Trwały outbox zapisuje przerwania przed ukryciem; kolejka i harmonogramy są anulowane, interakcje wygaszane. `deleted_at` ukrywa wątki w API, listach, wyszukiwaniu, wzmiankach i szynie. Zmiana live z `Thread.deleted_at` usuwa wpis z indeksu klienta. |
| `RestoreThread` | `{thread_id}` → przywrócone `threads`: cofa tylko tę partię usunięcia i zachowuje wcześniejsze archiwum. Dzieci usunięte wcześniej pozostają usunięte. Najpierw trzeba przywrócić rodzica. Anulowana praca nie wraca do kolejki. |

Pola cyklu życia zajmują numery 270–289, a nowe pola indeksu i ustawień archiwum 310–329.
Migracja `0026_sidebar_threads` dodaje metadane cyklu życia i znacznik nieprzeczytania;
`0028_archive_cascade` rozszerza autora o `cascade` i dodaje indeks archiwum. Filtr, przypięcia
i rozwinięcie sekcji korzystają z JSON ustawień, bez osobnej tabeli.
BFF: `POST /api/threads/:id/lifecycle`, `action`: `archive`, `unarchive`, `delete`, `restore`, `read`,
`unread`. UI potwierdza usunięcie i oferuje toast „Undo” przez sześć sekund.

`UpdateThread.title` umożliwia rename (`title_source=user`), a `RegenerateTitle` zleca asynchroniczną generację. Globalne ustawienia `textGeneration`, źródła tytułu i aktualizacje live opisuje [thread-titles.md](thread-titles.md).

Status: **zaimplementowane**:
- kontrakt: `proto/openagents/ui/v1/gateway.proto`,
- rdzeń: `apps/gateway/src/core`,
- dane: `apps/gateway/src/store`,
- serwis: `apps/gateway/src/api`,
- frontend: `apps/web` (SvelteKit 3, Svelte 5, Tailwind 4, `adapter-node`).

Potwierdzone na żywo (2026-11-01, Codex przez CLIProxyAPI): przez BFF utworzenie projektu, workspace'u (wybór katalogu na workerze) i wątku w trybie `ASK`, zgoda na komendę, plik powstaje, odpowiedź i statusy przychodzą przez SSE; kolejna wiadomość (idempotentna), przerwanie tury, restart gateway z ponownym połączeniem workera.

## 1. Architektura

```mermaid
flowchart LR
    B["Przeglądarka"]
    K["SvelteKit / adapter-node<br/>powłoka SPA, assety, akcje, JSON, SSE"]
    G["Gateway<br/>stan globalny (PostgreSQL)"]
    W["Workery"]
    B -- "HTTP/1.1: strony, akcje, JSON" --> K
    K -- "SSE: zmiany na żywo" --> B
    K -- "gRPC (HTTP/2): GatewayService<br/>token usługi" --> G
    W -- "gRPC (HTTP/2): WorkerLinkService" --> G
```

- **Gateway jest jedynym stanem globalnym.** Przechowuje projekty, wątki, tury, transkrypty, interakcje i komendy. Orkiestruje workery.
- **SvelteKit jest BFF.** Przeglądarka rozmawia tylko z nim, po HTTP/1.1. Serwer SvelteKit woła gateway po gRPC z prywatnym tokenem usługi, a zmiany na żywo przekazuje przeglądarce przez **SSE**. W przeglądarce nie ma adresu gateway, tokenów ani klienta gRPC.
- **Frontend jest SPA (`ssr = false` w głównym `+layout.ts`).** adapter-node podaje powłokę i pliki statyczne, przekazuje `/api/*` do gateway i obsługuje istniejące akcje formularzy. Dane tras pobierają klientowe `+page.ts` przez `/api/*`; overview, ustawienia i katalog modeli pobierają stany funkcji. Akcje tworzenia wątku/projektu/workspace pozostają po stronie BFF: `enhance` zachowuje walidację, błędy pól i przekierowania bez SSR.
- Gateway podaje `GatewayService` na tym samym serwerze HTTP/2 co `WorkerLinkService`. Interceptor (`serviceTokenAuth`) przepuszcza wywołania `GatewayService` tylko z tokenem usługi (`OA_UI_SERVICE_TOKEN`, porównanie odporne na pomiar czasu). Workery uwierzytelniają się osobno, w handlerze `WorkerLinkService`.

## 2. `GatewayService`

| Metoda | Co robi |
|---|---|
| `GetOverview` | workery (online, wykryte CLI, profile, dozwolone katalogi, wersja konfiguracji i raport) oraz projekty z workspace'ami |
| `WatchOverview` | strumień zmian workerów, projektów i wątków |
| `ListDirectory` | przeglądanie katalogów na workerze, w dozwolonych katalogach (wybór workspace'u) |
| `CreateProject`, `CreateWorkspace` | projekt; workspace = katalog na workerze |
| `UpdateWorkspace`, `RemoveWorkspace` | projekt na workerach: projekt żyje na workerach, na których ma workspace. `UpdateWorkspace` zmienia katalog na tym samym workerze (`optional root_path`, `label`; te same sprawdzenia co `CreateWorkspace`: ścieżka bezwzględna, w dozwolonych katalogach, bez duplikatu w projekcie na tym workerze); istniejące wątki zostają w swoim katalogu. `RemoveWorkspace` zdejmuje projekt z workera (archiwizacja): znika z `Project.workspaces` i z nowych wątków głównych, istniejące wątki działają dalej, a ich wątki boczne i forki (`CreateThread` z `parent_thread_id`) powstają w tym samym workspace'ie. Obie zmiany idą w `OverviewUpdate.project`; nieznany albo usunięty workspace = `NotFound` |
| `ListThreads`, `GetThread`, `CreateThread` | wątki projektu (pusty projekt = wszystkie wątki użytkownika); jeden wątek; nowy wątek (główny albo boczny, opcjonalnie fork) z opcjonalną pierwszą wiadomością. Gateway sprawdza według ostatniego raportu workera, że dostawca jest dostępny, a profil istnieje, jest dostępny i obsługuje tego dostawcę; fork zachowuje dostawcę rodzica. Fork od tury („Fork from here”, [threads.md](threads.md#fork-od-tury-fork-from-here)): `fork_at_turn_id` (zakończona tura z widocznej historii wątku `fork_thread_id`, także odziedziczona) bez `parent_thread_id` tworzy nowy wątek główny z miejscem i ustawieniami tamtego wątku (pola miejsca, dostawcy i modelu z żądania są pomijane; pusty tytuł = „Fork of ‹tytuł›”); tura w toku, spoza historii albo bez punktu u dostawcy = `InvalidArgument`. `Thread.fork_after_turn_id` i `fork_after_turn_ordinal` mówią, od której tury (numer w wątku źródłowym). `model` i `effort` to domyślne wątku (`Thread.model`, `Thread.effort`), sprawdzane z katalogiem profilu, gdy worker go zgłosił i jest kompletny (model po `id` albo `resolved_model`; wysiłek z `efforts` modelu, a bez modelu z modelu `is_default`). Model z katalogu bez `efforts` nie ma wysiłku: `Thread.effort` zostaje pusty ([reguła wysiłku](protocol.md#modele-effort-i-steer)) |
| `SendMessage` | wiadomość; idempotentne po `client_request_id` (także między kolejką a steerem). `model` i `effort` nadpisują domyślne wątku tylko dla tej tury. Z katalogiem sprawdzany jest model i wysiłek podany w wiadomości; domyślny wysiłek wątku nie blokuje wyboru modelu: przy starcie tury model bez `efforts` nie dostaje wysiłku, a wysiłek, którego model nie oferuje, zamienia się na `default_effort` modelu albo pusty (`Turn.effort` = to, z czym tura ruszyła; [reguła wysiłku](protocol.md#modele-effort-i-steer)). `delivery`: `QUEUE` (domyślnie, następna tura → `response.turn`) albo `STEER` (do tury w toku → `response.steer`; bez tury w toku działa jak `QUEUE`). Steer ma statusy `pending` → `accepted` → `delivered` albo `queued` (nie wszedł: tura skończyła się wcześniej albo dostawca odmówił; jest następną turą `queued_turn_id`, powód w `reason`); model i wysiłek z wiadomości obowiązują dopiero w tej turze. `permission_mode` nadpisuje tryb uprawnień wątku tylko dla tej tury (`UNSPECIFIED` = domyślny wątku); steer zostaje przy trybie tury, do której wchodzi, a nadpisanie obowiązuje, gdy wraca do kolejki ([tryb uprawnień tury](protocol.md#modele-effort-i-steer)); nieznana wartość = błąd. W transkrypcie steer to item `user_message` z `client_id = steer.id` w turze, do której wszedł, w miejscu, w którym wszedł. Zmiany na żywo: `ThreadUpdate.steer`, snapshot ma `steers` |
| `UpdateThread` | domyślny model, wysiłek i tryb uprawnień wątku (`permission_mode`: nieustawiony albo `UNSPECIFIED` = bez zmian; zmienia go tylko właściciel, agenci nie mają do tego narzędzia) (`optional`: nieustawione = bez zmian, pusty = domyślny profilu); dotyczy tur bez nadpisania. Podany wysiłek jest sprawdzany z katalogiem; przy samej zmianie modelu dotychczasowy wysiłek idzie za modelem według tej samej reguły (model bez `efforts`: pusty, wysiłek spoza listy: `default_effort` albo pusty). Zmiana idzie w `ThreadUpdate.thread` |
| `ListModels` | katalog modeli workerów (`WorkerModels`: worker → `ProfileModels` per dostawca i profil → `ModelInfo`: `id`, `resolved_model`, `display_name`, `description`, `hidden`, `is_default`, `efforts`, `default_effort`; `detail` = lista niepełna). Bez `refresh` ostatni raport workera (wysyłany po każdej zmianie konfiguracji), z `refresh` lista od nowa z workera (musi być online). Zmiany na żywo: `OverviewUpdate.models`. Puste `efforts` = model bez wyboru wysiłku albo spoza katalogu dostawcy (np. inne modele pośrednika); taki model jest w pełni używalny. Katalog ma tylko modele, które poprowadzą turę agenta (bez obrazów, wideo, TTS, embeddingów itd.; worker je usuwa). `default_effort` = domyślny wysiłek ustawiony przez użytkownika w harnessie na urządzeniu, jeśli model go oferuje, inaczej domyślny modelu, inaczej pusty; tura bez wysiłku działa właśnie z nim ([protocol.md](protocol.md#modele-effort-i-steer)) |
| `InterruptThread` | przerwanie tury w toku |
| `AnswerInteraction` | odpowiedź na zgodę albo pytanie |
| `WatchThread` | najpierw snapshot (wątek, tury ze zużyciem tokenów, itemy, oczekujące interakcje, ostatnie komunikaty, `last_seq`), potem zmiany na żywo: zdarzenia (`seq` + `ThreadEvent`), wątek, tura, interakcja. Snapshot forka zawiera odziedziczoną historię: tury i itemy wątku źródłowego do punktu forka z `inherited = true` i `from_thread_id`. Tura ma `model` i `effort`: nadpisanie z wiadomości, a od startu wartości faktycznie wysłane do workera (puste = domyślne profilu); tak samo `permission_mode` (od startu zawsze ustawiony). Tura ma swoje źródło (`source_kind`: task, message, report, question, schedule; `source_thread_id`, `schedule_id`, `interaction_request_id`; dla raportu `source_status`, dla pytania `question_kind` i `question_tool`), odczytane z relacji w bazie (widok `turn_sources`), nie z treści. `input_text` to dokładnie to, co dostał model; `platform_note` i `message_text` to ta sama treść rozdzielona na notatkę platformy i właściwą wiadomość. Tura od agenta (task, message, report) i steer agenta mają `sender` (`AgentSender`: wątek nadawcy, tytuł, dostawca, instancja, model, projekt, worker), także spoza drzewa. Snapshot ma `bus_deliveries`, a zmiany przychodzą jako `bus_delivery`: dokąd dotarły wywołania `spawn_thread` / `send_message` tego wątku i status tur docelowych ([agent-bus.md](agent-bus.md#wiadomości-między-dowolnymi-wątkami)) |
| `ListSchedules`, `CreateSchedule`, `UpdateSchedule`, `PreviewSchedule`, `SetScheduleStatus` | harmonogram platformy: lista z autorem i ostatnim edytującym, tworzenie, edycja z kontrolą wersji, podgląd terminów cronu, wstrzymanie, wznowienie i anulowanie. Użytkownik może edytować także zadania agenta. Zakończonego ani anulowanego zadania nie da się edytować ani wznowić. Zmiany na żywo w `ThreadUpdate.schedule` i `OverviewUpdate.schedule`, a snapshot wątku zawiera jego aktywne i wstrzymane harmonogramy |
| `SetGoal` | cel harnessu w wątku ([goals.md](goals.md)): `action` = `set` (nowy cel z `objective`, opcjonalnie `token_budget` tylko dla Codexa; zastępuje otwarty), `pause`, `resume`, `clear`. Zwraca `Goal`; decyzja jest zapisana od razu, harness potwierdza ją raportem (`Goal.native_status`). Codex: komenda `SetGoal` do workera; Claude: tura `/goal …` w kolejce (`trigger = goal`; pauza i usunięcie najpierw przerywają turę). Błędy: brak otwartego celu do pauzy/wznowienia/usunięcia, budżet dla Claude, `objective` > 4000 znaków |
| `StopBackgroundTask` | zatrzymanie zadania w tle (`thread_id`, `item_id` itemu `background_task`, musi być `in_progress`) → komenda `StopTask`; item kończy się `interrupted` (`stop_reason = stopped_by_user`), gdy worker to zgłosi ([execution.md](execution.md#4-zadania-w-tle)) |
| `ListProviderInstances`, `SaveProviderInstance`, `DeleteProviderInstance`, `SetInstanceWorkers`, `SetInstanceWorker`, `SetInstanceModels`, `RefreshProviders`, `StartProviderLogin` | globalne instancje dostawców ([worker-config.md](worker-config.md#9-globalne-instancje-dostawców)): lista z definicją (bez wartości sekretów: `api_key_set`, zmienna-sekret z pustą wartością), wyborem modeli, liczbą wątków i stanem na każdym workerze (`InstanceOnWorker`: włączona, wybór jawny czy z `all_workers`, nadpisania, ostatni raport: `available`, `detail`, `version`, `auth`, `authenticated`, `checked_at`, `synced`); nowa (`create`, id: małe litery, cyfry, `-`, `_`; unikalne w obrębie dostawcy; od razu `all_workers` albo `worker_ids`) albo zmieniona definicja (`expected_revision`; inna = `FailedPrecondition`); usunięcie nieużywanej (używana: `FailedPrecondition`); gdzie działa (wszystkie workery albo wybrane); włączenie i nadpisania na jednym workerze (sekret bez wartości = bez zmian, `api_key` pusty = klucz definicji); modele (`favorites_only` = sama gwiazdka z pickera); ponowne sprawdzenie na workerach online (`ProbeProviders`, `skipped` = pominięte z powodem); logowanie ChatGPT kodem urządzenia (Codex z `own_login`). Każda zmiana definicji albo przypisania zapisuje nowe wersje konfiguracji tylko workerom, których efektywne instancje się zmieniły, i wysyła je tym online; zmiany na żywo w `OverviewUpdate.worker` (`Worker.provider_instances`: id, dostawca, nazwa, kolor, włączona, dostępna, ulubione) |
| `GetSettings`, `UpdateUserSettings`, `UpdateProjectSettings` | ustawienia użytkownika (wygląd: schemat kolorów, akcent, szerokość czatu, panel wątku; domyślne wartości nowych wątków, w tym model osobno dla każdego dostawcy; ulubione modele `model_favorites`: dostawca, profil (pusty = dowolny), model) i projektu (domyślne wartości wątków, nadpisują użytkownika). Przechowuje je gateway (`user_settings`, `project_settings`); przeglądarka jest tylko klientem. Zapis zastępuje podane sekcje i podaje wersję, od której zaczął: konflikt z innym urządzeniem = `FailedPrecondition` (BFF: 409), klient pobiera ustawienia od nowa. Zmiany na żywo w `OverviewUpdate.user_settings` / `project_settings` |

UI składa itemy na żywo tym samym reducerem co gateway (`reduceItem` z `@open-agents/domain`).

### Harmonogramy tworzące nowe wątki

`CreateScheduleRequest.target` to `thread` (także pusty, zgodność wsteczna) albo `new_thread`.
Istniejący cel wymaga `thread_id`. Nowy cel wymaga `new_thread: NewThreadSchedule` i pustego `thread_id`:
`project_id`, `placement` (`any`, `least_busy`, `round_robin`, `specific`), `workspace_id` tylko dla
`specific`, `provider`, `provider_profile_id` (pusty = `native`), `model`, `effort` (pusty dozwolony,
modele bez wysiłku działają), `permission_mode` (domyślnie `ASK`), opcjonalny `title`.
Wiadomość pozostaje w `prompt`; opcjonalne `name` nazywa harmonogram (bez niego pierwsze 60 znaków wiadomości).
`concurrency` to `skip_if_running` (domyślne) albo `allow`. Obowiązują dotychczasowe `run_at`/`cron`,
strefy czasowe, minimalny odstęp 5 minut, `until`, `max_runs` i `missed_policy`.

`Schedule` zwraca te ustawienia oraz `recent_runs` — pięć ostatnich wystąpień z `scheduled_for`,
numerem udanego uruchomienia, `thread_id`, `turn_id`, `worker_id`, `workspace_id`, `outcome`, `created_at`.
Pominięcie ma numer 0 i puste odnośniki do wątku/tury. `Thread.schedule_id`, `schedule_name`,
`schedule_run` opisują pochodzenie wątku; UI pokazuje „Started by schedule ‹name› · run N” i ikonę zegara.
Nowe pola istniejących wiadomości zajmują numery 290–309. Nowe harmonogramy są tylko dla użytkownika;
narzędzia agentów nadal planują wyłącznie tury istniejących wątków.

Settings → Scheduled tasks pozwala wybrać cel również bez istniejących wątków. Formularz nowego wątku
używa wspólnych pickerów modelu/instancji, wysiłku i uprawnień, ogranicza wybór workera do workspace projektu
i podaje aktualnie kwalifikujące się workery. Z panelu wątku domyślnie wybiera „In this thread”.
Lista pokazuje projekt, politykę, model i historię z linkiem do wątku i nazwą workera. Zmiany harmonogramów
nowych wątków przychodzą w `OverviewUpdate.schedule`; istniejących również w `ThreadUpdate.schedule`.
Przy braku workera puli ponawianie trwa co 5 s; po 2 minutach `skip` pomija, `run_once` zachowuje
jedno zaległe wykonanie (do `until`, jeśli ustawione). `specific` może utworzyć wątek na offline workerze,
korzystając z jego ostatniej dostępności instancji. Szczegóły: [agent-bus.md, sekcja 5](agent-bus.md#5-harmonogram).

### Edycja harmonogramów

`UpdateScheduleRequest` zawiera `schedule_id`, wymagane `expected_version` i `configuration`
(`CreateScheduleRequest`, pełna konfiguracja). Walidacja jest wspólna z tworzeniem, a odpowiedź
`UpdateScheduleResponse.schedule` zawiera nowy stan. Konflikt z innym zapisem, zmianą statusu albo
zatwierdzonym wykonaniem zwraca `FailedPrecondition` (BFF: 409); formularz zachowuje wpisane wartości
i wskazuje konieczność ponownego otwarcia. Odnowienie lease nie zmienia wersji.

Nowe pola `Schedule` mają numery 330–333: `version`, `last_edited_by_user_id`, `last_edited_at`,
`configured_name`. Ostatnie pole zachowuje jawną nazwę, również pustą; dotychczasowe `name` nadal
zwraca etykietę z pierwszych 60 znaków wiadomości, gdy nazwy nie podano. Edycja nie zmienia autora
utworzenia, historii, licznika `runs`, ostatniej tury ani pauzy. Najbliższy termin jest liczony od nowa;
limit `max_runs` jest łączny, a nie od chwili edycji. `thread` można zamienić na `new_thread` i odwrotnie,
ale przy pozostaniu w trybie `thread` nie można wybrać innego istniejącego wątku.
Przejęte, jeszcze niezatwierdzone wystąpienie zachowuje swój klucz historii i użyje nowej konfiguracji
o nowym terminie. Już uruchomiona praca pozostaje bez zmian.

Settings i panel wątku używają wspólnego menu „…”: `Edit…`, `Pause` lub `Resume`,
`Cancel schedule…` (nieodwracalne anulowanie wymaga dialogu potwierdzenia). Stan jest kropką z etykietą
przy tytule lub w metadanych. Zakończone i anulowane zadania nie mają akcji. `Edit scheduled task`
otwiera ten sam `ScheduleDialog` co tworzenie, wypełniony zapisaną konfiguracją; `Save changes`
zapisuje wersję z chwili otwarcia. `PreviewSchedule` działa również w edytorze, pokazując trzy
najbliższe terminy po zmianie cronu lub strefy. Menu i dialog używają istniejących tokenów ruchu
z `layout.css` i `motion.css`, również przy ograniczonym ruchu.

BFF: `PUT api/schedules/[id]` przyjmuje `UpdateScheduleRequest` (identyfikator z URL jest wiążący),
a `POST api/schedules/preview` przyjmuje `PreviewScheduleRequest`. Zapis zwraca pełny harmonogram,
podgląd — terminy `next_runs`; błędy walidacji mają HTTP 400, konflikt wersji HTTP 409.

Cele i praca w tle w modelu UI (pola od 60, osobno od innych zmian kontraktu):
- `Thread.goal_status` (status otwartego celu albo pusty) i `Thread.background_tasks` (zadania w tle w toku) — także w `WatchOverview`, np. na plakietki w pasku bocznym,
- `Goal`: `objective`, `status` (`active | paused | blocked | budget_limited | usage_limited | achieved | cancelled`), `created_by` (`user | provider`), `token_budget`, `tokens_used`, `time_used_seconds`, `iterations` (Codex: tury kontynuacji, Claude: oceny ewaluatora), `last_reason` (werdykt ewaluatora), `native_status`, czasy,
- `ThreadSnapshot.goal` (otwarty cel albo ostatni zakończony), na żywo `ThreadUpdate.goal`; `Turn.goal_id` (tury celu),
- zadania w tle to itemy `background_task` na osi czasu (`kind`, `command`, `output`, `started_in_turn_id`, `source_item_id`, `stop_reason`); po turze przychodzą jako zdarzenia bez `turn_id`.

Restart workera i błędy komend (pola od 70):
- `Thread.runtime`: `gateway` (agent czatowy w gateway: bez celów i pracy w tle) albo `worker`; UI ukrywa przy wątkach gateway pigułkę „Goal” i „Set a goal…”,
- `Thread.last_turn_status`: jak skończyła się ostatnia zakończona tura (`completed` | `failed` | `interrupted`), do stanu subagentów w panelu nad kompozytorem,
- `Thread.last_message`: w wątkach bocznych początek ostatniej wiadomości agenta (wynik subagenta, do 600 znaków), w głównych pusty; karta subagenta na osi czasu rodzica ([agent-bus.md](agent-bus.md#subagenci-platformy-zamiast-natywnych)),
- `Turn.interrupt_reason`: dlaczego tura jest `interrupted`, np. `worker restarted` (worker już jej nie prowadzi), `the turn was no longer running on the worker` (przerwanie tury, której worker nie zna), `superseded: …`,
- `Turn.error_source` (72): przy `failed` skąd błąd — `platform` (nasza strona) albo `harness` (Codex/Claude zgłosił błąd); treść w `error`, krótki kod w `Turn.error_code` (74), np. `http_connection_failed:401`, `process_exit`,
- `Turn.interrupt_source` (73): przy `interrupted` kto przerwał — `user` albo `system` (np. `worker restarted mid-turn`). Stopka tury w UI pokazuje „Harness error: …” / „Platform error: …”, „by you”, „by the system: …” i dla przerwania przez system akcję „Continue” (wiadomość wznawiająca sesję). Stany i macierz: [durability.md](durability.md#47-stany-tury-i-wątku). Wątek po każdym końcu tury jest `idle`; `failed` tylko dla wątku, który nie powstał,
- `Goal.error`, `Goal.error_at`: ostatnia komenda celu nie powiodła się na workerze; status wraca wtedy do ostatniego stanu harnessu ([goals.md](goals.md#3-statusy)). `goalPending` w UI nie pokazuje wtedy „Starting… / Pausing…”, a `GoalBar` pokazuje błąd.

### Kompaktowy kompozytor podczas czytania historii

Kompozytor wątku zwija się po celowym przewinięciu w górę o co najmniej 96 px, gdy od końca dzieli co najmniej 192 px. Histereza utrzymuje wąski widok aż do powrotu na dół (wspólny próg feedu: 8 px) albo interakcji z kompozytorem. Nowy fokus, kliknięcie edytora, pisanie, upuszczenie/wklejenie pliku, otwarcie kontrolek i „Jump to latest” rozwijają pole. Celowe przewijanie ma pierwszeństwo przed istniejącym fokusem; edytor pozostaje zamontowany i zachowuje fokus również na telefonie.

Wąski widok pozostawia pierwszą linię tego samego edytora i przycisk wysyłania/zatrzymania; narzędzia i metadane są zwinięte i `inert`. Nad nim pozostają gęstsze nagłówki subagentów, kolejki i pytań asynchronicznych. Ich treść jest zwinięta i zachowuje stan, a kliknięcie nagłówka rozwija kompozytor i wybrany panel. Synchroniczne `ask_user` utrzymuje pełny widok. Szkic, wzmianki i historia cofania nie są odtwarzane z kopii.

`ComposerCompaction` obsługuje stan niezależnie od DOM. `ScrollIntent` rozróżnia gesty z inercją, własne korekty `scrollTop` i przewijanie programowe; `VirtualFeed.onreaderscroll` przekazuje wyłącznie ruch czytelnika. Stopka jest nakładką poza scrollerem. Jej rezerwa miejsca pod historią podczas czytania może tylko rosnąć, więc żadna klatka animacji nie ogranicza `scrollTop`. Przy opuszczaniu dołu odświeżana jest kotwica bieżącego wiersza, zanim streaming może uruchomić `ResizeObserver`. Natywne `overflow-anchor` pozostaje wyłączone. Gradient i „Jump to latest” są związane z rzeczywistą geometrią nakładki. `ComposerFold` współdzieli przejścia narzędzi na tokenach `--duration-slow` przy otwieraniu i `--duration-medium` przy zamykaniu; `ComposerPanelBody` współdzieli accordion paneli na `--duration-fast`. Reduced motion przełącza natychmiast. Ustawienia i protokół pozostają bez nowego przełącznika.

`ComposerPanelHeader` współdzieli nagłówki subagentów, kolejki i pytań (32 px desktop / 36 px telefon; 28 px w kompakcie). `ComposerPanelBody` utrzymuje ich treść zamontowaną i `inert` po zwinięciu. Ring `ComposerTop` jest poza przycinanym body; nie przechodzi przez `ComposerFold`. Kolejka ma wiersze 36 px, a subagent z podglądem ostatniej wiadomości 40 px. Tytuły mają 14/13 px, tekst pomocniczy 13/12 px, ikony dostawców 14 px, chevrony 12 px. `Icon`/`ProviderIcon` mają jawny `size`, a `TouchTarget size="sm"` zachowuje co najmniej 40 px obszaru dotyku.

Panel subagentów filtruje wyłącznie pracujących i oczekujących na odpowiedź/zgodę (`subagentsOf`). Podsumowanie liczy tylko aktywnych; przy pustej liście znika cały panel, także w kompakcie. Zakończony wiersz wychodzi przez `--duration-quick`; wejście panelu używa `t-rise` / `--duration-fast`, również przy pierwszym montowaniu stosu. Reduced motion wyłącza oba przejścia. Filtr nie dotyczy kart na osi czasu, Lineage ani paska bocznego.

Przy nawigacji TurnRail rezerwa do wyrównania ostatniego wiersza jest liczona razem z wysokością nakładki (`footerHeight + alignmentSpace`). `scrollend` odświeża kotwicę tylko po nawigacji smooth; własne korekty całkowitoliczbowego `scrollTop` zachowują pierwotny offset ułamkowy, aby streaming nie kumulował błędu zaokrągleń.


### Pytania nad kompozytorem

`Interaction.asynchronous` i `InteractionPrompt.asynchronous` (pole **250** w odpowiednich wiadomościach) oznaczają pytanie, przy którym agent pracuje dalej. Domyślne `false` zachowuje zachowanie natywnych interakcji. Async pozostaje w `snapshot.interactions` i strumieniu interakcji, lecz nie zwiększa `Thread.pending_interactions` ani komunikatu czytnika ekranu „waiting for you”.

`ComposerTop` to wspólna powierzchnia/slot nad polem wiadomości: panel subagentów, kolejka i pytania tworzą jeden stos z jednym nachodzeniem na composer. Warianty `embedded` paneli nie dodają własnych obwódek ani przesunięć. `Composer` wybiera najstarszy zestaw blokujący przed async, przechowuje szkice per id zestawu i używa osobnego `MessageComposer` do zwykłych wiadomości.

`QuestionForm`, `QuestionOption` i `QuestionSession` obsługują kroki, Back, Skip, Skip all, Dismiss (sync), zwijanie i przełączanie async na wiadomości. Pole odpowiedzi używa placeholdera „Type your own answer, or leave this blank to use the selected option” i przycisku „Submit”; wpisany tekst ma pierwszeństwo przed zaznaczeniami. Rekomendacja jest oznaczeniem, bez automatycznego wyboru. Zwykły szkic wiadomości zostaje zamontowany przy przełączaniu. Natywne pytania poufne zachowują pole hasła i ukryte odpowiedzi w rekordzie osi czasu.

Opcje to semantyczne inputy radio/checkbox ze wspólnego `Input`, z własną grafiką `ChoiceControl`; grupa ma `fieldset`/`legend`. Przy fokusie w grupie 1–9 wybiera opcję, ↑/↓ przenosi fokus, Enter zatwierdza; cyfry w composerze pozostają tekstem. Przejście kroku przenosi fokus na legendę, jeśli użytkownik operował w panelu. Zwijanie ma `aria-expanded`, `aria-controls` i `inert`; ruch korzysta z istniejących `.t-acc-panel`/`.t-acc-chevron` i tokenów `layout.css`, z wyłączeniem przejść dla reduced motion.

Odpowiedź nadal idzie przez `AnswerInteraction` / `POST api/interactions/[id]`. Dla `ask_user`: `{answerJson: JSON.stringify({answers: [{id, kind: "choice", labels: [...]}, {id, kind: "text", text: "..."}, {id, kind: "skipped"}]})}`; kompletna lista odpowiada zestawowi pytań. Dismiss: `{cancelled: true}`. Adaptery zachowują natywne formaty Claude i Codexa. `interaction_prompt` zostaje na osi czasu jako skrót tematu i odpowiedzi z autorem; rozwinięcie pokazuje cały zestaw i jawnie pominięte pytania.


### Załączniki

Pliki dołączone do wiadomości (obrazy, zrzuty ekranu, tekst, kod, PDF, archiwa). Platforma nie zgaduje limitów modeli: agent dostaje pliki na dysku workera i sam decyduje, co z nimi zrobić (obrazy może obejrzeć przez `view_image`, [agent-bus.md](agent-bus.md#view_image)).

| Metoda | Co robi |
|---|---|
| `UploadAttachment` | `{name, data}` → `Attachment` (`id`, `name`, `mime_type`, `kind`, `size_bytes`, `width`, `height`, `sha256`, `has_thumbnail`). Typ z treści (`sniff`, `packages/domain`), nie z nazwy ani typu przeglądarki. Odrzuca (`InvalidArgument` z powodem): pusty plik, ponad limit, program (ELF, PE, Mach-O, rozszerzenia `.exe`/`.dll`/...). PNG, JPEG, WebP: zapisane obrócone według EXIF i bez metadanych (EXIF, GPS, XMP), JPEG/WebP ponownie kodowane (jakość 92), PNG bezstratnie; GIF bez zmian; HEIC/HEIF, AVIF, TIFF → JPEG/PNG, jeśli libvips je dekoduje (HEIC zwykle nie: zostaje plikiem `image/heic`); obrazy dostają miniaturę WebP (512 px). Limit pikseli 100 Mpx. SVG i HTML to zawsze `kind = file` |
| `GetAttachment` | `{attachment_id, thumbnail}` → bajty i typ; tylko właściciel (cudzy = `NotFound`) |
| `GetThreadBlob` | `{thread_id, sha256}` → podgląd obrazu z transkryptu (`Image.blob`, `ToolCall.images`); tylko właściciel, tylko blob wskazany przez wątek z tego samego drzewa (`thread_blobs`) |
| `MarkThreadSeen` | `{thread_id, up_to_seq}` → użytkownik widział wątek do zdarzenia (strona wątku: ostatnia wiadomość na ekranie przez chwilę, karta widoczna); znacznik `thread_reads.seen_seq` tylko rośnie (najwyżej do `Thread.last_seq`). `Thread.unseen_result` = wynik ostatniej zakończonej tury za znacznikiem (`completed` / `failed` / `interrupted`, pusty = widziane); zmiana idzie do wszystkich urządzeń przez `OverviewUpdate.thread` |
| `SendMessage.attachment_ids`, `CreateThread.initial_attachment_ids` (110) | załączniki wiadomości. Każdy tylko raz (wiązanie z turą w tej samej transakcji co tura), tylko własne. Wiadomość z załącznikami może nie mieć tekstu i zawsze jest następną turą (`delivery = STEER` → kolejka) |
| `Turn.attachments` (110) | pliki wiadomości (bez ścieżek); UI pokazuje je zamiast notatki |
| `GetSettingsResponse.attachment_limits` (110) | `max_file_bytes`, `max_message_bytes`, `max_files` |

Limity (gateway, zmienne środowiskowe): `OA_ATTACHMENT_MAX_FILE_MB` (domyślnie 20), `OA_ATTACHMENT_MAX_MESSAGE_MB` (50), `OA_ATTACHMENT_MAX_FILES` (10). Kompozytor sprawdza je przed wysłaniem pliku; ostatnie słowo ma gateway.

**Notatka platformy.** Gateway składa wejście tury przy przyjęciu wiadomości: `input_text` = notatka + pusta linia + wiadomość (sama notatka, gdy tekstu nie ma), `platform_note` = notatka, `message_text` = wiadomość. UI bierze notatkę i wiadomość osobno (`platform_note`, `message_text`); z cytatami notatka ma też ich blok (niżej, „Cytaty”):

```text
[open-agents] The user attached 2 files to this message, saved on this machine. Read them as needed; view_image shows you an image:
- /home/me/.local/share/open-agents/attachments/<thread>/<attachment>/screenshot.png (image/png, 245.3 KB, 1920×1080 px)
- /home/me/.local/share/open-agents/attachments/<thread>/<attachment>/notes.txt (text/plain, 2.0 KB)

Co jest na zrzucie?
```

Ścieżki liczy gateway z `Hello.attachments_root` workera wątku; worker zapisuje plik dokładnie tam przed turą ([protocol.md](protocol.md#załączniki)).

**Worker offline.** Wiadomość z załącznikami do istniejącego wątku idzie do kolejki jak każda (bajty czekają w gateway, worker pobiera je przy starcie tury). Nowego wątku na workerze offline kompozytor nie wysyła (jak dotąd). Worker, który nigdy nie zgłosił `attachments_root` (starsza wersja), nie przyjmie załączników: `SendMessage` zwraca powód.

### Kolejka

Panel nad kompozytorem pokazuje wyłącznie wiadomości użytkownika (`trigger = user`, puste `source_kind` i `source_thread_id`). Raporty szyny agentów, fallbacki steerów platformy, notatki zadań w tle i inne wyzwalacze platformowe są z niego wykluczone, także przy lokalnym przestawianiu kolejności. Nie wyglądają jak wiadomości użytkownika oczekujące na wysłanie. Reguły dostarczenia i wygaszania raportów: [agent-bus.md](agent-bus.md#asynchroniczność). API kolejki zachowuje możliwość przestawiania tur platformy przez innych klientów.

Wiadomości czekające za turą w toku (tury `queued`) użytkownik układa jak w aplikacji Codex. Kolejność kolejki to `Turn.ordinal` (gateway startuje najniższą). Operacje działają tylko na turach `queued`, których gateway jeszcze nie wystartował (jego `StartTurn` nie jest w outboxie); taka tura, albo tura, która już wyszła z kolejki, daje `FailedPrecondition` z powodem („this message already started running”, „this message is no longer in the queue”). Każda zmiana idzie do wszystkich klientów jako `ThreadUpdate.turn`.

| Metoda | Co robi |
|---|---|
| `ReorderQueuedTurns` | `{thread_id, turn_ids}` → podane tury dostają, w tej kolejności, miejsca (`ordinal`), które zajmują razem; tury, których klient nie zna (przyszły w międzyczasie), zostają na swoich. Kolejność zmienia się wśród tur kolejki, więc wystartowane tury nie zmieniają miejsca na osi czasu. Także tury agentów i harmonogramów |
| `EditQueuedTurn` | `{turn_id, text, expected_revision, mentions}` → nowy tekst wiadomości użytkownika, złożony jak w `SendMessage`: wzmianki sprawdzone i rozwiązane ([Wzmianki](#wzmianki)), notatka załączników przed tekstem; nadpisania (model, wysiłek, tryb) i załączniki zostają; `/goal` nie czeka w kolejce (`InvalidArgument`). Inna `Turn.revision` (161) niż oczekiwana = `FailedPrecondition` (zmieniona gdzie indziej) |
| `DeleteQueuedTurn` | wiadomość użytkownika wychodzi z kolejki: `status = cancelled`, `Turn.withdrawn` (160) = `deleted`; oś czasu jej nie pokazuje |
| `RestoreQueuedTurn` | cofnięcie usunięcia: tura wraca do kolejki na swoje miejsce (idempotentne) |
| `SteerQueuedTurn` | wiadomość użytkownika (bez załączników; z jej wzmiankami, wejście takie, jakie dostałaby tura) idzie teraz do tury w toku: w jednej transakcji powstaje steer (`Steer.from_turn_id` (160) = ta tura) i tura wychodzi z kolejki (`withdrawn = steered`). Dalej jak steer z `SendMessage` (`pending` → `accepted` → `delivered`); gdy nie wejdzie, wraca ta sama tura na swoje miejsce w kolejce (`Steer.queued_turn_id = from_turn_id`), nie nowa na końcu. Bez tury w toku = `FailedPrecondition`, wiadomość zostaje w kolejce |
| `UserSettings.composer` (160) | `ComposerSettings.running_delivery`: co robi Enter, gdy trwa tura — `STEER` (domyślnie; Mod+Enter = kolejka) albo `QUEUE` (Enter = kolejka, Mod+Enter = steer) |

**Wyścig z głową kolejki.** Zmiany kolejki i start jej głowy blokują najpierw wiersz wątku, więc idą jedna po drugiej. Scheduler (`pump`) zapisuje `StartTurn` tylko wtedy, gdy tura nadal jest głową kolejki z rewizją, którą przeczytał (`QueueStore.whileHead`); inaczej czyta kolejkę od nowa. Wystartowana tura ma więc zawsze tekst i miejsce, które użytkownik widział jako ostatnie przyjęte, a zmiana tury, którą scheduler wziął pierwszy, kończy się czytelnym błędem.
### Wzmianki

Komendy, skille, pluginy, pliki i inne wątki wstawione w tekst wiadomości jako chipy (jak w aplikacji Codex). Wyzwalacze w kompozytorze: `/` komendy, `$` skille i pluginy (konwencja Codexa: `$Skill`, aplikacje `$app`), `@` pliki folderu wątku, `#` wątki; te same pozycje są w menu „+” obok „Attach files”.

Boty używają tego samego edytora z osobnym źródłem: tylko `@` i pozostałe boty właściciela.
`Mention.kind=BOT`, `name=bot_id`, znacznik `@label`; `SendBotMessage.mentions` i
`BotMessage.mentions` mają numer 450. Wątki workera odrzucają ten rodzaj. Brak skillsów
i plików w composerze botów; rejestr ma pustą grupę przyszłych konektorów. Szczegóły:
[bots.md](bots.md#wzmianki-i-cytaty-użytkownika).

Na ekranach poniżej `40rem` lub ze wskaźnikiem `coarse` sugestie są częścią powierzchni kompozytora, nad edytorem, z własnym przewijaniem i limitem wysokości 40% `visualViewport` (aktualizowanym przy zmianie klawiatury/viewportu). Desktop zachowuje popover nad kompozytorem. Każdy `input`, także `insertCompositionText` i `insertReplacementText`, aktualizuje model i sugestie; formatowanie DOM czeka na zatwierdzenie kompozycji. `compositionend` sam ponawia odczyt, a zwykły input i utrata fokusu zerują stan kompozycji. Lista zapobiega utracie fokusu przy `pointerdown`; wybór przez `pointerup` działa także w WebKit, który może pominąć późniejszy `click`. `pointercancel` lub ruch palca większy niż 8 px wyklucza wybór podczas przewijania.

**Kontrakt.** Wiadomość niesie tekst i listę `Mention` (`worker/v1`): `kind` (`COMMAND | SKILL | PLUGIN | FILE | THREAD`), `name` (nazwa w harnessie; plik: ścieżka względem folderu wątku z `/`; wątek: id), `label` (to, co pokazuje chip), `[start, end)` w jednostkach UTF-16 tekstu (znacznik wzmianki: `/review`, `$transitions-dev`, `@docs/notatka.md`, `#Tytuł wątku`), `path` (skill: SKILL.md; plugin: `app://…` / `plugin://…`; plik: ścieżka absolutna na workerze, ustawia gateway), `source` (`built-in | user | project | plugin | system | admin | app | mcp | platform`), `is_dir`. Tekst bez wzmianek nadal czyta się jak zwykła wiadomość (np. dla starszych klientów).

| Pole / metoda (od 140) | Co robi |
|---|---|
| `SendMessage.mentions`, `CreateThread.initial_mentions` | wzmianki w tekście. Gateway sprawdza je (`checkMentions`, `packages/domain`: zakres w tekście, bez nakładania, znacznik zaczyna się wyzwalaczem, najwyżej jedna komenda i 50 wzmianek, plik bez `..` i ścieżek absolutnych, wątek: uuid **własnego** wątku, nie bieżącego), uzupełnia (`path` pliku, tytuł wątku jako `label`) i składa wejście tury dla dostawcy (niżej) |
| `Turn.mentions`, `Steer.mentions` | wzmianki w `message_text` / `text`: UI rysuje chipy w dymku. Item `user_message` w transkrypcie ma `UserMessage.mentions` (zakresy w jego tekście, razem z notatką platformy) |
| `SendMessageResponse.goal` | wiadomość z komendą platformy `/goal`: reszta tekstu to cel (`SetGoal set`); Codex bez tury, Claude z turą celu |
| `ListMentionCatalog` | `{scope, refresh}` → `MentionCatalog` (`entries`: kind, name, label, description, argument_hint, source, path, icon, aliases, plugin, color; `notes`: czego brakuje i dlaczego). Najpierw komendy platformy (`/goal`), potem katalog harnessu z workera. Pamięć: gateway 30 s, worker (Claude) 5 min albo do zmiany katalogów skilli/komend; `refresh` omija obie |
| `SearchFiles` | `{scope, query, limit}` → `FileSearchResult` (`matches`: path, is_dir, indices; `truncated`; `source`: git / walk). Wyszukiwanie na workerze, tylko w folderze wątku |
| `SearchThreads` | `{query, exclude_thread_id, limit}` → wątki użytkownika po tytule (fuzzy), przy równym dopasowaniu najnowsza aktywność; bez workera |

`MentionScope`: istniejący wątek (`thread_id`) albo nowy (`workspace_id`, dostawca, profil, opcjonalnie `cwd`). Worker offline: `Unavailable` z nazwą workera, popup to pokazuje.

**Dostarczenie per dostawca** (`composeMessage`, `packages/domain/src/mentions`; zakresy przesunięte o notatkę):

| | Claude | Codex |
|---|---|---|
| komenda | Claude Code wykonuje `/nazwa` tylko na początku wejścia: chip z środka tekstu idzie na początek (`/review please …`), reszta się zamyka | brak komend z tekstu (komendy Codexa to funkcje jego TUI); tylko komendy platformy |
| skill | skill na początku wiadomości → `/nazwa` (Claude Code ładuje go jak komendę); pozostałe → notatka „use it with the Skill tool: …” | item `skill {name, path}` (Codex wstrzykuje SKILL.md) |
| plugin / aplikacja | notatka (Claude w wątkach platformy nie ładuje pluginów) | item `mention {name, path}` (`app://<id>`, `plugin://<nazwa>@<marketplace>`) |
| plik | `@ścieżka` zostaje w tekście (Claude Code sam dołącza treść, potwierdzone na żywo) + notatka ze ścieżką absolutną | `@ścieżka` w tekście (jak wstawia ją kompozytor Codexa); obraz dodatkowo jako `localImage` |
| wątek | notatka z tytułem i `thread_id` | jak Claude |

Każda wzmianka ma też `text_element` w wejściu Codexa (zakres bajtów UTF-8 i znacznik). Notatka (bez pustych linii, za notatką załączników):

```text
[open-agents] The user mentioned another thread; read it with get_thread / read_thread when you need it:
- "Plan sprintu" (thread_id: 0193…)

Zobacz #Plan sprintu
```

Wątek wspomniany przez użytkownika agent może czytać (`get_thread`, `read_thread`) także spoza swojego drzewa ([agent-bus.md](agent-bus.md#6-reguły-dostępu-i-limity)).

**Co oferuje każdy harness** (zmierzone na żywo 2026-11-02, Codex 0.164.0, Claude Code przez SDK 0.3.316):

- Codex: `skills/list` dla folderu wątku: `repo` (`.agents/skills` repozytorium, w UI `project`), `user` (`$CODEX_HOME/skills` oraz `~/.agents/skills` właściciela urządzenia: Codex czyta je mimo izolowanego `CODEX_HOME`), `system` (wbudowane, z ikonami i nazwami wyświetlanymi); `plugin/list` (zainstalowane i włączone; w izolowanym domu brak), `app/list` (konektory konta, tylko gdy worker je włączył, `NativeToolsConfig.connectors`). Komend brak.
- Claude: `Query.supportedCommands()` procesu uruchomionego jak tura (folder wątku, izolowany `CLAUDE_CONFIG_DIR`, `settingSources` project + local), bez promptu. Skillem jest wiersz, którego nazwa to folder `.claude/skills/<nazwa>/SKILL.md` w folderze wątku lub wyżej albo w `skills/` katalogu konfiguracji; reszta to komendy (wbudowane, `.claude/commands` projektu, MCP). Wbudowane komendy terminala, sesji i ustawień, które trzyma platforma (`model`, `effort`, `clear`, `config`, …), subagentów i harmonogramu (gdy wyłączone) oraz natywny `/goal` (zastępuje go `/goal` platformy) są pominięte. Pluginów brak. Skille właściciela urządzenia (`~/.claude/skills`) nie są widoczne (izolacja), skille projektu tak.

### Cytaty

`Quote` ma wspólny kontrakt w `quotes.proto` (dotychczasowe `ui.Quote` i numery pól
bez zmian). Boty przesyłają go przez `SendBotMessage.quotes` / `BotMessage.quotes`
(451), zapisują osobno od tekstu i używają tych samych komponentów Reply/Cite oraz
notatki `quotesNote`. `source_thread_id` cytatu z bota wskazuje jego rozmowę (id bota).

Użytkownik cytuje fragment tego, co agent wytworzył w wątku (odpowiedź, wcześniejsze wiadomości, rozumowanie, wejście i wynik narzędzia, wynik polecenia, blok kodu, diff) i odsyła go z wiadomością, z opcjonalnym komentarzem do każdego cytatu.

| Pole | Co robi |
|---|---|
| `Quote` | `text` (dokładnie zaznaczony tekst, tak jak widać: bez znaczników markdown, z podziałami linii), `comment` (opcjonalny), `source_item_id`, `source_thread_id` (item i jego wątek, także odziedziczona historia forka), `source_kind` (`agent_message` \| `reasoning` \| `command_output` \| `tool_call` \| `code` \| `diff`, pusty = tekst), `language` (blok kodu z językiem) |
| `SendMessage.quotes` (150) | cytaty wiadomości, do 20; tekst cytatu niepusty i do 20 000 znaków, komentarz do 4 000 (`QUOTE_LIMITS`, `packages/domain`). Wiadomość może mieć same cytaty. Działa z `delivery = STEER` (cytaty są w tekście, więc steer ich nie kolejkuje) |
| `Turn.quotes`, `Steer.quotes` (150) | cytaty wiadomości dla bańki użytkownika; `message_text` / `Steer.text` to sama treść użytkownika. Steer, który nie wszedł do tury, staje się turą z tymi samymi cytatami |

`CreateThread` nie ma cytatów: cytuje się w wątku, w którym jest źródło.

Ze wzmiankami notatka cytatów idzie do `composeMessage` razem z notatką załączników, więc zakresy wzmianek w dostarczonym tekście przesuwają się także o nią.

**Format dla agenta.** Cytaty to notatka platformy przed treścią (`quotesNote`, `packages/domain/src/quotes`): po notatce załączników (jeśli są), oddzielone pustą linią, potem pusta linia i wiadomość. Proza jako blockquote (każda linia z `> `), wynik polecenia, wywołanie narzędzia, kod i diff jako blok kodu z płotkiem dłuższym niż najdłuższy ciąg backticków w tekście (język bloku kodu, `diff`, inaczej `text`). Komentarz po cytacie jako `Comment: …`:

````text
[open-agents] The user quoted 2 passages of this conversation. Each quote is the exact text they selected, followed by their comment on it when they wrote one; their message comes after the quotes.

Quote 1, from your message:
> Dostępność i ruch: pełna obsługa.

Comment: Skróć to.

Quote 2, from command output:
```text
FAIL src/a.test.ts
```

Popraw oba miejsca.
````

Źródła cytatu (`your message`, `your reasoning`, `command output`, `a tool call`, `a code block`, `a diff`, `this conversation`) mówią agentowi, skąd fragment pochodzi; identyfikatory itemów zostają tylko dla UI (przejście do źródła).

## 3. Rdzeń gateway (`GatewayCore`)

- **Workery:**
  - przy połączeniu zapisuje stan i ponownie dostarcza outbox,
  - zdarzenia przechodzą przez `Ingest` (jedna transakcja na wątek), a potwierdzenie (`EventAck`) idzie po commicie,
  - zapisuje raport konfiguracji,
  - interakcje zapisuje i rozsyła, a ponownie wysłane i już rozstrzygnięte dostają zapisaną odpowiedź,
  - raporty celów (`goal_state`) aktualizuje w transakcji ingestu (`store/goals.ts`), a zmiany celu i itemów tła odświeżają `Thread` (status celu, liczba zadań w tle).
- **Outbox komend:** każda komenda najpierw trafia do `worker_commands`, potem do workera, jeśli jest online. Po ponownym połączeniu jest dostarczana jeszcze raz, a worker deduplikuje ją po `command_id`.
- **Planista tur:** startuje najstarszą tura `queued`, jeśli wątek jest gotowy (`provider_thread_id`), nic w nim nie biegnie i dla tej tury nie ma jeszcze komendy w outboxie. Uruchamia się po wiadomości, po `thread_ready` i po zakończeniu tury.
- **Wyniki komend:**
  - odrzucone utworzenie wątku → wątek `failed` z powodem (`status_detail`),
  - odrzucony start tury → tura `failed`.
- **Zmiany na żywo:** przez `Hub` (proces gateway). Przy wielu instancjach będzie to `LISTEN/NOTIFY` (docs/durability.md, 4.3).

## 4. Frontend (`apps/web`)

**Background tasks w panelu wątku.** `BackgroundTasksSection` pokazuje własne itemy `background_task`, także bez `turn_id`: najpierw działające, potem trzy ostatnio utworzone zakończone, w każdej grupie od najnowszych (`first_seq`). „Show N more” odsłania resztę. Wiersz, chip nad kompozytorem i „Open output” w itemie otwierają wspólny `BackgroundTaskDialog` (880 px na desktopie, pełny ekran telefonu). Współdzielony `ui/Terminal` jest ciemny w obu motywach: pasek okna zawiera krótki tytuł (opis harnessu albo program i argument po zdjęciu wrapperów powłoki), skrócone cwd, status z czasem i akcje Stop, Copy command, Copy output. Prompt z kolorowaniem Shiki zawija komendę do trzech wierszy; „Show full command” rozwija resztę we własnym obszarze. Przy kilku działających zadaniach chip najpierw pokazuje menu wyboru. Widoki używają tego samego stanu SSE co oś czasu; bez dodatkowego pollingu. Stop czeka na potwierdzenie workera, błąd pozwala ponowić.

`ui/TerminalOutput` używa `LineReveal` i wirtualizacji wierszy o wysokości 20 px (widok + po 8 wierszy zapasu). Nowy output trzyma dół, przewinięcie w górę zwalnia pin; „Jump to latest”, End w obszarze wyjścia albo ręczny powrót na dół przypina ponownie. Esc zamyka natywny Dialog. Parser ANSI renderuje kolory SGR (16/256/truecolour) i podstawowe atrybuty tekstu; pozostałe sekwencje sterujące są usuwane. Copy output kopiuje cały dostępny strumień jako czysty tekst. Log przewija się poziomo wyłącznie we własnym obszarze, dialog nie przewija się poziomo. Oczekiwanie jest przygaszonym wierszem terminala; po zakończeniu pojawia się wiersz statusu wyjścia. Animacje korzystają z tokenów zestawu (`t-modal`, `t-pulse`, reduced motion).

Ograniczenia kontraktu: `BackgroundTask` i snapshot `TimelineItem` nie zawierają czasów startu/końca ani kodu wyjścia. `ThreadState` zachowuje czasy zdarzeń itemu odebrane na żywo (także po reconnect w tej samej karcie); po pełnym odświeżeniu pokazuje „Time unavailable”. Kod wyjścia i cwd pochodzą z powiązanego `commandExecution`, jeśli jest dostępny; w przeciwnym razie cwd z wątku i „exit unavailable”. `output_blob` nie ma obecnie API do odczytu outputu zadania: modal jawnie wskazuje, że wyświetla i kopiuje dostępny strumień.

**Kontrolki formularzy.** `Select` przyjmuje `options: readonly SelectOption[]` (`value`, `label`, opcjonalnie `description`, `icon`, `group`, `separator`, `disabled`), `bind:value` albo `value` + `onchange(value)`. Renderuje przycisk combobox z listboxem w `Popover`; `name` wysyła wartość przez ukryte pole. Strzałki, Home/End i typeahead zmieniają aktywną opcję; Enter/Space/Tab zatwierdzają, Escape anuluje. Fokus pozostaje na przycisku, a aktywna opcja jest wskazywana przez `aria-activedescendant`. Grupy mają nazwy dostępne, wybrana opcja ptaszek, opisy osobne `aria-describedby`. Na telefonach lista jest arkuszem. Dzieci `<option>` nie są już obsługiwane; wszystkie użycia zostały zmigrowane.

`Popover.maxHeight` nadpisuje limit wysokości zakotwiczonego panelu przez styl komponentu (bez konfliktu klas Tailwind). Picker daty używa większego limitu zależnego od dostępnego miejsca; mobilny arkusz zachowuje własny limit wysokości ekranu.

`Input` pozostaje wspólnym publicznym API pól. Dla `number` używa wewnętrznego `NumberControl`: tekstowe pole `spinbutton`, własne −/+, min/max/step, strzałki i ograniczenie wartości przy zatwierdzeniu. Puste pole wiąże `null`, nieprawidłowy tekst `NaN`, aby walidacja wywołującego nie uznała go za pustą wartość. Dla `date`, `time`, `datetime-local` używa `DateTimeControl`: sformatowany lokalnie przycisk, `Calendar` z jednym przystankiem Tab i nawigacją po dniach/tygodniach/miesiącach, tekstowy czas HH:MM ze steperami, szybkie wybory i jawne Apply/Cancel. Dane zachowują format `YYYY-MM-DD`, `HH:MM`, `YYYY-MM-DDTHH:MM` bez `Z`. Nieistniejące godziny w luce DST są odrzucane; podwójna godzina jesienią oznacza wcześniejszy moment, zgodnie z dotychczasowym `Date`. `PickerTrigger` współdzieli wygląd i integrację `Field`, `StepperButtons` przyciski zmiany wartości, `ChoiceControl` rysowanie checkboxów/radio w `Input`, `Checkbox`, `Radio` i markdown. Wysoki kontrast (`forced-colors`) świadomie przywraca systemowy wygląd checkboxów/radio; zwykłe motywy używają własnej grafiki. Szczegóły w [raporcie weryfikacji](custom-form-controls-verification.md).

Kod wg funkcji (`#lib/features/*`), kod tylko serwerowy w katalogach `server/` (SvelteKit nie pozwala go zaimportować w przeglądarce).

| Ścieżka | Rola |
|---|---|
| `src/env.ts` | `GATEWAY_URL`, `GATEWAY_SERVICE_TOKEN` (`defineEnvVars`, odczyt przy starcie, nie przy buildzie) |
| `src/hooks.server.ts`, `lib/server/shell-appearance.ts` | `init`: wymaga tokenu usługi; `handle`: wpisuje wygląd w `<html>` przez `transformPageChunk` (schemat, akcent, szerokość czatu, szerokość i zwinięcie sidebara, zwinięcie panelu wątku). Cache wyglądu w procesie: 3 s, wspólne trwające pobranie, deadline 750 ms; podczas awarii ostatni znany wygląd albo domyślny. SPA odczytuje te atrybuty przed pierwszym renderem; „system” rozstrzyga skrypt w `<head>`. Ustawienia pozostają wyłącznie w gateway; cache dotyczy obecnego pojedynczego użytkownika deweloperskiego |
| `lib/server/gateway.ts` | klient gRPC z tokenem; `call` (błędy gateway → HTTP: 400, 404, 409, 503, reszta 502), `attempt` dla akcji formularzy (4xx → `fail`, komunikat przy formularzu) |
| `lib/server/sse.ts`, `body.ts` | strumień gRPC → SSE: po krótkim sprawdzeniu gateway ramka `ready`, heartbeat co 10 s, przy błędzie ramka `failure`; zwykłe wywołania gRPC mają deadline 3 s, strumienie bez limitu całkowitego czasu. Ścisłe dekodowanie JSON (nadmiarowe pola → 400): `readBody` (Effect Schema) i `readMessage` (wiadomość kontraktu w JSON protobuf) |
| `lib/shared/wire.ts`, `http.ts` | JSON protobuf (`toJson` / `fromJson`) między serwerem a przeglądarką: te same schematy po obu stronach; `requestJson` (wywołania BFF z przeglądarki, `HttpError` ze statusem, np. 409) |
| `lib/shared/ui` | prymitywy UI: `Button`, `ButtonLink`, `IconButton`, `Field` + `Input` / `Select` / `Textarea` / `Checkbox` (opcjonalny `aside` obok etykiety, np. znaczniki) / `Radio`, `Fieldset` (grupa kontrolek pod jedną etykietą, z opisem i błędem), `FieldError`, `SearchField` (pole wyszukiwania z lupą), `Badge`, `StatusBadge`, `StatusDot`, `ProjectAvatar`, `Alert`, `EmptyState`, `Dialog` (`size="lg"`: szerszy od `sm`), `Drawer`, `Disclosure` (`remember`: stan w pamięci UI wiersza), `CodeBlock`, `Skeleton`, `SettingsGroup` + `SettingsRow`; wygląd przełącznika segmentowego (`segmented.ts`); `virtual/VirtualFeed` (przewijany czat, opis niżej; `reveal(key)` przewija do wiersza i daje mu fokus) z `SizeIndex` (wysokości wierszy: zmierzone po kluczu, reszta ze średniej grupy, sumy prefiksowe) i `memory.ts` (stan UI wierszy, które lista odmontowała, np. rozwinięte szczegóły); ikony Heroicons Micro (`icons.ts`); warstwa pływająca bez zależności (Popover API, `popover="manual"`, pozycjonowanie z flip/shift w `floating.ts`): `Popover` (zakotwiczony, Escape / klik poza / wyjście fokusu zamyka, fokus wraca do wyzwalacza, na telefonie opcjonalnie arkusz), `DropdownMenu` + `MenuItem` / `MenuCheckItem` / `MenuGroup` / `MenuSeparator` / `MenuSub` (wzorzec menu button: strzałki, Home/End, typeahead, submenu), `Combobox` (WAI-ARIA combobox: autouzupełnianie albo lista inline w pickerach, gotowy na wyszukiwanie po stronie serwera), `SearchPicker` (pigułka otwierająca listę z wyszukiwarką: `Popover` z `Combobox` inline, na telefonie arkusz, opcjonalny link w stopce) + `PickerRow` (opcja listy: znak, nazwa, linia pod nią, status, ptaszek), `TextLink` (link w tekście), `DialogActions` (przyciski dialogu), `ActionForm` (formularz akcji strony z `enhance`: `busy`, `submitted` — błąd strony należy do formularza, który wysłał — i `onsuccess`), `tooltip` (attachment: opóźnienie, od razu przy fokusie z klawiatury, długie przytrzymanie na ekranach dotykowych), `HoverCard` (hover / fokus, stuknięcie na dotyku), `Slider` (dyskretne, podpisane stopnie), `Kbd` + `hotkeys.ts` (`Mod` = ⌘ albo Ctrl), `PillButton` / `PillText` (pigułki kompozytora), `Toaster` + `toast()` (krótkie potwierdzenia, np. „Copied”, z rysowanym ptaszkiem), `GrowIn` (treść, która wrasta i znika wysokością), `ResizeSlot` (miejsce w rzędzie kontrolek płynnie zmieniające szerokość), `ResizeHandle` (uchwyt zmiany szerokości panelu, WAI-ARIA window splitter: przeciąganie myszą / piórem / palcem z pointer capture, jedna aktualizacja na klatkę; strzałki co 16 px, z Shift co 64 px, Home / End, Enter i dwuklik = szerokość domyślna, Escape anuluje; opcjonalnie zwinięcie przy przeciągnięciu poniżej połowy minimum; logika w `resize-handle.ts`), `SheetHandle` (uchwyt arkusza na telefonie: przeciągnięcie w dół zamyka), `Rule` (linia wypełniająca resztę rzędu za etykietą granicy); ruch: tokeny w `routes/layout.css` (jedna skala transitions.dev: `--duration-*`, `--ease-*`, `--distance-*`, `--scale-*`, `--blur-*`; przy `prefers-reduced-motion` odległości, skale i rozmycie są zerowane, zostaje przezroczystość), przepisy w `motion.css` (klasy `t-*`: menu i popovery rosną od wyzwalacza, dialogi skalują się, arkusze i szuflada wjeżdżają, podpowiedzi, przesuwana pigułka przełącznika segmentowego, akordeon, toast, potrząśnięcie błędu, wejścia `t-swap` / `t-rise` / `t-reveal` / `t-stream`, puls szkieletów; wejście i wyjście warstwy górnej czystym CSS przez `@starting-style`), ich odpowiedniki dla Svelte w `motion.ts` (`expand`, `rise`, `swap`, `iconSwap`, `reorder`, `stagger`, `shake`, `resizeToContent`); otwieranie wolniejsze niż zamykanie, zawartość zamykanego `Popover` / `Dialog` zostaje (inert) do końca wyjścia; `markdown/` renderuje markdown agentów z tokenów `marked` komponentami Svelte (bez `{@html}`, linki tylko http(s)/mailto, obrazy jako linki); `CopyButton` (kopiuje tekst, ikona na chwilę zmienia się w ptaszek); `code/`: podświetlanie składni (`CodeFence` — blok kodu markdown z językiem i kopiowaniem, `CodeFrame` — wspólna rama bloku kodu z nagłówkiem, `LanguagePicker` — pigułka wyboru języka, `CodeLines`, `DiffLines`, `CodeTokens`; opis niżej) |
| `lib/shared/format.ts`, `clock.svelte.ts` | liczby, czasy, JSON; zegar etykiet względnych (tyka co 30 s) |
| `features/navigation` | powłoka w stylu T3 Code: sekcje „Threads” i „Bots” (`SectionSwitch`, `sections.svelte.ts`: aktywna sekcja z trasy, Settings zachowuje ostatnią, powrót do ostatniej strony sekcji w pamięci karty); skrzynka `SidebarThreads` (projekt, status, tytuł, worker; najpierw czekające na użytkownika, potem `last_activity_at` drzewa; boczne wątki pod otwartym drzewem, forki i wątki agentów oznaczone); wyszukiwarka, stopka ze stanem połączenia, `TopBar`, menu mobilne. Desktop: `SidebarColumn` / `SidebarLayout`, szerokość 220–560 px, najwyżej 45% okna, Mod+B i `SidebarToggle`; kolumna animuje szerokość, panel zachowuje szerokość tekstu. `AppearanceSettings.sidebar_width` / `sidebar_collapsed` zapisują się w gateway po 400 ms; powłoka podaje atrybuty, z których SPA odtwarza geometrię przed pierwszym renderem |
| `features/commands` | paleta poleceń (Mod+K): `registry.ts` (`Command`, `CommandRegistry`: źródła poleceń dodawane przez funkcje i strony, warunki `when`, podmenu `children`), `contributeCommands` (`commands.svelte.ts`: polecenia strony na czas jej życia), `app-commands.ts` (polecenia całej aplikacji), `palette.ts` (co lista pokazuje dla zapytania, podmenu, ruch klawiszami), `fuzzy.ts` (dopasowanie rozmyte z podświetleniem), `CommandPalette` / `CommandRow` |
| `features/overview` | stan workerów, projektów i wszystkich wątków (kontekst, SSE `api/overview/events`; start i każde ponowne połączenie: `GetOverview` + jedno `ListThreads` z pustym projektem, bo strumień niesie tylko zmiany; `subscribe` przekazuje pozostałe zmiany strumienia — ustawienia, harmonogramy — a `resyncs` mówi, że po przerwie trzeba je pobrać od nowa), karta workera w ustawieniach |
| `features/projects` | nowy projekt, lista wątków projektu (wątki główne z bocznymi); gdzie biegnie nowy wątek: `placement.ts` (`defaultProject`: `?project=`, projekt twojego domyślnego workspace'u, projekt, w którym ostatnio zacząłeś wątek, pierwszy projekt na jakimś workerze, pierwszy projekt; `defaultWorkspace`: domyślny workspace — projektu nad twoim — jeśli należy do projektu, ostatnio użyty w projekcie, pierwszy na workerze online, pierwszy; „ostatnio użyty” wynika z twoich wątków głównych, nic nie jest zapisywane w przeglądarce), `ProjectPicker` (pigułka projektu: wyszukiwarka, przy projekcie workery, na których żyje, albo „Not on any worker yet”, link „Manage projects”), `WorkerPicker` (pigułka workera: tylko workery projektu, ze statusem i katalogiem projektu na nich; offline zostaje na liście, oznaczony; przy kilku katalogach na jednym workerze pigułka podaje nazwę katalogu; link do ustawień projektu) |
| `features/threads` | `ThreadState` (snapshot + zdarzenia, `reduceItem`; komunikaty ze snapshotu, zużycie i czas tur z `ui.Turn`, odziedziczona historia forka osobno od własnych tur, tury startowane przez workera, aktywne i wstrzymane harmonogramy wątku), `timeline.ts` (granice tur, zagnieżdżenie po `parent_item_id`; niezmienione itemy zachowują swoje węzły), `feed.ts` (wiersze strony wątku: nagłówek zwiniętej historii forka, jej części i wiersze, linia „Forked from ‹źródło› · Turn N”, własna oś czasu, fold pracy na żywo, steery w drodze — tury w kolejce nie są wierszami osi czasu, pokazuje je panel kolejki; niezmienione wiersze zachowują tożsamość, więc delta przerysowuje jeden wiersz), `work-groups.ts` (domyślnie zwinięte „Working for …” od startu, po końcu „Worked for …”; grupy kolejnych narzędzi przeplatane postępem; bieżąca wiadomość poza foldem do wznowienia narzędzi, na końcu tylko odpowiedź), `WorkFold`, `WorkGroup`, `AnswerSlot` (stały wiersz odpowiedzi z przejściem wysokości), `WorkFolds` (stan rozwinięcia tury i grup w pamięci strony; przetrwa wirtualizację i zakończenie tury; szczegóły: [timeline-folding.md](timeline-folding.md)), `turn-origin.ts` (skąd przyszło wejście tury: użytkownik, zadanie albo wiadomość od agenta, raport, pytanie wątku bocznego, harmonogram twój albo agenta; z `source_kind`, `source_thread_id`, `schedule_id`, `interaction_request_id`, nie z treści; notatka platformy `[open-agents] …` do pierwszej pustej linii jest oddzielona od dostarczonej wiadomości, pełny tekst pod „Full text the agent received”), `TurnInput` (wejście tury z pochodzeniem i `hops`), `FeedRowView` (wiersz osi czasu; odziedziczona historia jako zwinięta „History from …” nad turami forka; przy łańcuchu forków części podpisane wątkiem z `from_thread_id`), widoki itemów (`components/items`), karty interakcji (zgoda, pytania, formularz MCP; przy `routed_to = parent` kto odpowiada), `ComposerBox` (pole wiadomości jak w T3: okrągły przycisk wysyłania / zatrzymania, „pigułki” ustawień; `canSend = false` zostawia pole edytowalne, a wstrzymuje wysłanie — powód podaje `ComposerNotice` pod polem), kompozytor wątku z wyborem modelu i wysiłku na dostawcy i profilu wątku (wybór zostaje w kompozytorze tego wątku i idzie z każdą wiadomością w `SendMessage.model` / `effort` jako nadpisanie jej tury; model wątku i brak wyboru wysiłku = nic nie jest nadpisywane, z wyjątkiem modelu, który nie przyjmuje wysiłku wątku: wtedy idzie jego domyślny), steer i kolejka: w trakcie tury Enter (przycisk „Steer”) wysyła wiadomość do tury w toku (`delivery = steer`), Mod+Enter albo menu przycisku (`SteerSendButton`) dodaje ją do kolejki — z włączonym queueing (`UserSettings.composer.running_delivery = QUEUE`) odwrotnie; steer w drodze (`pending`, `accepted`) jest wierszem na końcu osi czasu, dostarczony to item `user_message` z `client_id` = id steera w turze („Steered into this turn”, `isSteerMessage`), a ten, który nie wszedł, to tura w kolejce z powodem (znacznik w panelu kolejki); gdy tura skończyła się przed wysłaniem, kompozytor mówi, że wiadomość pójdzie jako następna tura. Zadania w tle: `BackgroundTaskView` (koniec wyjścia na żywo z rozwinięciem, Stop ze stanem oczekiwania), `BackgroundTasksChip` („N running in background” nad kompozytorem, podgląd wyjścia zadania), `ThreadWorkBadges` (cel i zadania w tle w pasku bocznym); zdarzenia zadania po turze (bez `turn_id`) zostawiają item w turze, w której powstał. Tury celu mają znacznik „Goal” (`Turn.goal_id`). `TurnEnd` (stopka tury: status, czas, model i wysiłek tury z `ui.Turn.model` / `effort` nazwami z katalogu, pełne id w podpowiedzi, tryb uprawnień tury z `ui.Turn.permission_mode` — „Full auto” bursztynowo z tarczą ostrzegawczą, tury sprzed zapisu trybu bez niego — zużycie), `PermissionPicker` (pigułka trybu uprawnień pod polem, po prawej: w nowym wątku tryb wątku, w kompozytorze wątku tryb następnych wiadomości — wybór zostaje w kompozytorze tego wątku i idzie w `SendMessage.permission_mode` jako nadpisanie tury, tryb wątku = bez nadpisania; menu oznacza domyślny wątku; „Full auto” bursztynowo z odznaką „No prompts”), `ThreadPermissionsDialog` („Permissions…” w menu akcji wątku: domyślny tryb wątku przez `UpdateThread`, od następnej tury; ostrzeżenie przy wyborze „Full auto”), `PermissionModeTitle`, `permissionLook` w `labels.ts` (ikona i kolory trybu, wspólne dla pigułki, panelu i stopki), worker pod polem z podglądem (`WorkerHoverCard`), menu akcji wątku (wątek boczny, harmonogram, „Model and effort…” — domyślne wątku przez `UpdateThread`, wysyłane tylko zmienione pola, w `ThreadModelDialog` — kopiowanie linku / katalogu / ID), `providers.ts` (dostawcy i profile dostępne na workerze), fork od tury (`fork.svelte.ts`, `fork-point.ts`, `ForkButton`: „Fork from here” w stopce zakończonej tury obok „Copy answer” — te same zasady pokazywania co Copy, na dotyku zawsze widoczny; spinner w przycisku do otwarcia nowego wątku, błąd jako toast; „Fork thread” w menu akcji i palecie od ostatniej zakończonej tury; BFF `POST /api/threads/[id]/fork { turnId }`), panel kontekstu wątku (worker, agent, kto odpowiada na zgody, zużycie tur, harmonogramy wątku z wstrzymaniem, wznowieniem, anulowaniem i „Schedule a task”, źródło forka z numerem tury („Forked from … Turn N”), linia wątków; otwarty albo zwinięty według ustawień użytkownika), tworzenie wątków (`server/create-thread.ts`, wspólna akcja; dostawcę i profil sprawdza gateway; wątek boczny bierze projekt, workspace i dostawcę z rodzica przez `GetThread`) |
| `features/models` | `model-catalog.svelte.ts` (`ModelCatalogState`: katalog `ListModels` per worker; ziarno z loadu layoutu — brak katalogu nie psuje strony — potem `OverviewUpdate.models` ze strumienia, po przerwie `GET api/models`; `refresh(workerId)` = `POST api/models`, czeka do 100 s, błąd, np. worker offline, w stopce pickera). `catalog.ts`: `ModelOption` (dostawca, profil, id modelu, nazwa i opis z katalogu, `resolved_model`, `is_default`, obsługiwane wysiłki, domyślny wysiłek, `detail` niepełnej listy) — interfejs, którym karmione są pickery; modele profilu z katalogu workera bez `hidden`; puste `efforts` = model bez wyboru wysiłku (pigułka wysiłku znika, nic nie jest zgadywane); pusty `default_effort` = „Default” (decyduje dostawca). Tylko profil bez zgłoszonego katalogu (worker, który go nigdy nie wysłał, np. offline albo starszy) dostaje listę zastępczą: domyślny profilu, model z domyślnych, aliasy CLI, modele z wątków i zastępcze wysiłki per dostawca. `findOption` (id albo `resolved_model`, pusty = `is_default`), `threadModelOptions` (modele dostawcy i profilu wątku + jego bieżący model, także spoza listy), `modelOption` (model spoza listy: co katalog o nim wie, także ukryty, inaczej własny bez wysiłków), `turnOverride` (co wiadomość wysyła dla swojej tury); `useThreadModels` w `model-catalog.svelte.ts` (opcje wątku na żywo, dla kompozytora i dialogu). `ModelPicker` + `ModelRow` (jak w T3, na telefonie arkusz: szyna Ulubione / dostawcy, wyszukiwarka po nazwie, id, opisie i profilu, nagłówki profili (przyklejone), gdy dostawca ma ich kilka, gwiazdka, ⌘1…⌘9 dla pierwszych ulubionych, Mod+Shift+F gwiazdkuje podświetlony, własny id modelu; stopka: niepełna lista z powodem, odświeżenie listy workera), `EffortPicker` (jak w ChatGPT: nazwa wysiłku, model otwierający picker, reset do domyślnego, suwak; bez wyboru pigułka pokazuje domyślny — wątku, jeśli model go przyjmuje, inaczej modelu, albo „Default”, a suwak pusty kciuk), `ModelControls` (obie pigułki razem, odświeżanie katalogu workera), `ModelIdField` (id modelu z podpowiedziami z katalogów workerów, aliasów i wątków w ustawieniach i dialogu wątku bocznego), `favorites.ts` (ulubione w `UserSettings.model_favorites` przez `SettingsState`: od razu widoczne, błąd zapisu przywraca stan gateway; natywny profil zapisany jako `native`, bo pusty profil znaczy „dowolny”) |
| `features/goals` | cel harnessu w wątku: `goals.ts` (wygląd statusów, dozwolone akcje jak w gateway: pauza tylko aktywnego, wznowienie innego otwartego, budżet tokenów tylko Codex, iteracje jako tury Codexa albo oceny Claude, `goalPending`: „Starting… / Pausing… / Resuming…”, dopóki harness nie potwierdzi decyzji w `native_status`, `showsGoal`: pasek dla otwartego celu, osiągniętego do zamknięcia w tej karcie, nigdy dla usuniętego), `GoalBar` (nad kompozytorem: treść, status, zużycie; rozwija się w pełną treść, ostatni werdykt i `GoalStats`; pauza, wznowienie, usunięcie z potwierdzeniem), `GoalDialog` (ustawienie albo zastąpienie celu; pole budżetu tylko dla Codexa), `SetGoalPill` (pigułka „Goal” w kompozytorze, gdy nie ma otwartego celu; także „Set a goal…” w menu wątku) |
| `features/schedules` | harmonogramy: opisy terminów (typowe crony słowami), statusy, `ScheduleRow` (wiadomość, kiedy, następne uruchomienie, liczba uruchomień, wątek, kto ustawił: ty albo agent z linkiem do jego wątku), `ScheduleActions` (wstrzymaj, wznów, anuluj z potwierdzeniem), `ScheduleDialog` (jednorazowo albo cyklicznie: godzinowo, dziennie, w dni robocze, tygodniowo albo własny cron; strefa czasowa, koniec: nigdy, data albo liczba uruchomień; zachowanie po przestoju) |
| `features/bots` | boty (agenci żyjący w gateway, nie na workerach) — na razie bez backendu, tylko komponenty prezentacyjne z lokalnym modelem widoku (`model.ts`: `BotView`, `ParticipantView`, `ConversationView` z `pinned` i `pinOrder`, `ChatMessageView`, `ChatEventView`, `QuestionView`, `LinkView`; bez typów proto, żeby przyszły kontrakt mapował się w jednym miejscu). Awatary-maskotki wyliczane z id bota (`mascot.ts`: kształt, kolor, oczy), `AvatarStack`, przypięte czaty jako duże awatary z gwiazdką na górze sekcji (`PinnedConversations`), wiersze `BotListItem` / `GroupListItem` (przypnij/odepnij, oznacz jako przeczytane: przycisk „…”, prawy klik, Shift+F10, długie przytrzymanie), `ConversationHeader` (bot, grupa, bot ⇄ bot), oś czatu (`chat-timeline.ts`: linie dat, „New” przed pierwszą nieprzeczytaną, serie wiadomości z awatarem przy ostatniej i nazwą nadawcy w grupach), `ChatBubble` (markdown botów przez bezpieczny renderer), `ChatEventLine` (rutyny, wiadomości przekazane od innych botów), `QuestionCard` (opcje A/B…, wybór klawiszem litery), `LinkChip`, `MessageActions`, `BotComposer` (załączniki i mikrofon jako „coming soon”), `WatchBar` (czytanie rozmowy dwóch botów, „Close chat”). Menu akcji to `DropdownMenu` z zestawu (`ActionItems`: akcje jako dane; menu kontekstowe kotwiczy się przez `anchorOnly` z `Popover`, więc link zachowuje swoje kliknięcie), podpowiedzi to attachment `tooltip`. Przypięcia będą ustawieniem użytkownika w gateway (nie `localStorage`). W produkcji sekcja Bots pokazuje tylko uczciwy pusty stan (`BotsSectionEmpty`) |
| `features/profiles` | profile dostawców workera (Settings → Workers → worker): `profiles.ts` (stan formularza `ProfileDraft` → `SaveProviderProfileRequest`: sekret bez zmian nie wysyła wartości, klucz „keep / replace / clear”; podpowiedzi przy polach według wspólnych reguł zmiennych z `@open-agents/domain`; `withReport`: dostępność na żywo z raportu workera w overview; `initialShown` / `newSince` dla wyboru modeli; wywołania BFF), `ProfileRow` (połączenie, endpoint, zmienne, wątki, status Ready / Pending / Unavailable / Off, menu: edycja, modele per dostawca, wyłącz, usuń), `ProfileDialog` (nazwa, połączenie jako karty `KindChoice`, agenci, endpoint i klucz, `EnvVarEditor` ze zmiennymi i przełącznikiem „Secret”, „Use this profile”; pierwszy błędny element dostaje fokus), `SecretValue` (sekret zapisany: „Set” + Replace / Clear; wpisywanie: pole hasła i „Keep current”), `DeleteProfileDialog` (używany profil: wyjaśnienie i „Turn off”), `ModelSelection` (pełny katalog z wyszukiwarką, All / None dla wyników wyszukiwania, licznik, znaczniki Default / New / Hidden by Codex, „Show new models”, zapis albo „Use the default list”) |
| `features/attachments` | `draft.svelte.ts` (`AttachmentDraft`: pliki wiadomości; każdy wysyłany od razu po dodaniu `POST api/attachments` przez XHR z postępem; wstępne sprawdzenie limitów z `SettingsState.attachmentLimits`, pustych plików i programów; `blocker`, gdy coś się jeszcze wysyła albo nie udało; `filesOf` dla upuszczenia i wklejenia), `DraftTray` (miniatury obrazów i chipy plików nad tekstem w kompozytorze, pasek wysyłania, błąd na czerwono z powodem, usuwanie; chipy wskakują `pop`, reszta przesuwa się `reorder`), `MessageAttachments` (w wiadomości: miniatury obrazów z `?thumbnail`, inne pliki jako chipy, które pobierają plik), `FileChip` (ikona, nazwa, druga linia: rozmiar i typ albo błąd; z `href` pobiera), `ZoomableImage` (miniatura, dotknięcie otwiera `Lightbox`), `Lightbox` (pełny obraz na `<dialog>` z `t-modal`, podpis, pobieranie), `SeenImage` (podgląd tego, co zobaczył agent, w itemie transkryptu). `ComposerBox` przyjmuje `draft` (`AttachmentDraft`): sam dokłada tackę, upuszczanie i wklejanie, a wybór plików jest w menu „+” |
| `features/mentions` | wzmianki w kompozytorze: `MentionEditor` (pole tekstowe na `contenteditable`: model = tekst + zakresy wzmianek, każda zmiana przez przeglądarkę — `insertText`, `insertHTML`, `insertLineBreak` — więc cofanie, IME, sprawdzanie pisowni i klawiatury telefonów działają natywnie; wklejanie zawsze jako czysty tekst, pliki do załączników; Backspace usuwa chip w całości; wyzwalacz na początku linii albo po spacji), `editor.ts` (DOM ↔ model, wykrywanie wyzwalacza, przycinanie z przesunięciem zakresów), `caret.ts` (zaznaczenie i kursor), `kinds.ts` (wygląd chipów: ikona rodzaju albo pluginu, kolor akcentu; rejestr elementów w linii `INLINE_RENDERERS`), `MentionList` (lista popupu: grupy, ikony, opisy, dopasowane litery), `sources.svelte.ts` (`MentionSources`: katalog raz na zakres i filtr fuzzy lokalnie, pliki i wątki szukane z opóźnieniem 120 ms, spóźnione odpowiedzi odrzucane), `ComposerPlusMenu` („+”: Attach files i wyzwalacze), `MentionChip` (chip w wysłanej wiadomości). Popup to `Popover` zakotwiczony na całym polu (nad nim, jego szerokość, `t-dropdown`), fokus zostaje w tekście (`aria-activedescendant`). Dlaczego nie biblioteka edytora: jedyną bogatą treścią są chipy, a ProseMirror/Lexical to 60–150 kB. Elementy blokowe szkicu (załączniki, później cytaty) są nad tekstem w `ComposerBox` (`elements`), a nowy rodzaj w linii to nowy element unii `InlineElement` z rendererem w `INLINE_RENDERERS`. Markdown na żywo (opis niżej): `markdown.ts` (reguły: kod inline, płoty), `inline-code.ts` (DOM kodu inline, wyciszone backticki), `code-blocks.ts` + `CodeBlockField` (blok kodu w polu) |
| `features/settings`, `features/workspaces` | ustawienia jako panel modalny nad aplikacją (nawigacja z wyszukiwarką; breadcrumb strony pod sekcją: projekt albo worker; `SettingsHeading`: tytuł strony pod sekcją z opisem i akcjami), podgląd schematów kolorów; wybór katalogu na workerze (`api/workers/[id]/directory`); `ProjectWorkers` + `ProjectWorkerRow` (sekcja „Workers” ustawień projektu: każdy worker ze statusem i katalogiem projektu albo „Add”; zmiana katalogu i usunięcie z workera), `WorkspaceDirectoryDialog` (dodanie projektu do workera albo zmiana katalogu: `DirectoryPicker`, wymaga workera online), `RemoveWorkspaceDialog` (usunięcie z workera z wyjaśnieniem, że istniejące wątki działają dalej) |
| `features/settings/SettingsOverlay`, `SettingsDialog`, `SettingsBreadcrumb`, `settings-overlay.svelte.ts`, `settings-route.ts` | ustawienia nad bieżącą stroną przez `beforeNavigate`, `preloadData` (klientowe loady) i `goto(url, { shallow: true, persistState: true })`; własny `+page.svelte` z `import.meta.glob`, URL/parametry/wynik akcji z `useSettingsRoute()`, odświeżenie przez `route.refresh("app:…")`. Strona pod spodem pozostaje zamontowana (szkic, scroll, SSE), jest `inert`; fokus wraca do wyzwalacza. Jedna pozycja historii: Wstecz, Escape, X lub tło zamyka dialog; Dalej go odtwarza. Akcje `enhance` odświeżają też dane nakładki. Przy wejściu wprost SPA pokazuje dialog, po czym odtwarza stronę spod niego (`page.state.settingsOver` albo `/`). Błąd danych 5xx ma ręczne i automatyczne ponawianie co 3 s. Po wykryciu nowej wersji pierwszeństwo ma pełna nawigacja. Zagnieżdżone layouty ustawień nie są obsługiwane w nakładce |
| `features/settings/settings-state.svelte.ts` | `SettingsState`: ustawienia z gateway (przeglądarka nic nie zapisuje lokalnie). Wygląd początkowy z atrybutów powłoki, pełny stan z `GET api/settings` po pierwszym połączeniu i każdej przerwie; zmiany z innych urządzeń przez `OverviewUpdate.user_settings` / `project_settings` (nowsza wersja zastępuje). Zapis zastępuje jedną sekcję i podaje `expected_version`; zapisy idą po kolei, zmianę widać od razu i jest nakładana na stan gateway w chwili wysłania. 409: pobranie ustawień, ponowne nałożenie zmiany (raz) i komunikat, jeśli ta sekcja zmieniła się gdzie indziej; inny błąd: komunikat i stan z gateway |
| `features/settings/appearance.ts`, `thread-defaults.ts`, `ThreadDefaultsFields` | enumy wyglądu ↔ atrybuty `<html>`; domyślne wartości nowego wątku: projekt nad użytkownikiem (agent — dostawca, profil, model — jako całość, workspace i uprawnienia osobno); wspólne pola dla Settings → Threads i ustawień projektu („Use my default”) |

Trasy:
- `/`: „What should we work on?”; projekt i workspace z `placement.ts`, domyślne projektu nad użytkownikiem, ręczny wybór wygrywa, `?project=` wstępnie wybiera projekt. `ProjectPicker` / `WorkerPicker` pokazują tylko właściwe powiązania. Model, profil dostawcy i wysiłek pochodzą z katalogu wybranego workera (ulubione pierwsze); niewybrany model pozostawia `CreateThread.model` puste. Projekt bez workera, worker offline lub brak agenta blokują wysłanie i wyjaśniają powód; pole pozostaje edytowalne. Bez projektów jest link do ustawień.
- `/threads/[id]`: klientowy `+page.ts` pobiera `GetThread` przez BFF (404 dla nieznanego); SSE daje snapshot i dalsze zmiany. Panel kontekstu pokazuje drzewo, cele i zadania; `?/createSideThread` tworzy wątek boczny z opcjonalnym forkiem. `/settings/appearance` i `/settings/threads` edytują wygląd i domyślne nowych wątków; `/settings/schedules` pokazuje wszystkie harmonogramy, także zakończone, i pozwala je tworzyć, wstrzymywać, wznawiać i anulować.
- `/settings/projects` i `/settings/projects/[id]`: projekty, powiązania z workerami i katalogami (`?/createWorkspace`, `?/updateWorkspace`, `?/removeWorkspace`), domyślne wątków projektu i lista wątków. Stare `/projects/[id]` przekierowuje tutaj. `/settings/workers` i `/settings/workers/[id]` pokazują maszyny i linki do ich dostawców.
- `/settings/providers`: klientowy `+page.ts` pobiera instancje i pełne katalogi modeli; strona działa też w nakładce. Zakres All workers / worker, status i wersja CLI instancji, definicja (id, kolor, połączenie, runtime i zmienne), nadpisania workera, modele (filtry, ukrywanie, ulubione, własne id i tagi), logowanie, usuwanie. „Add” prowadzi przez Provider → Identity → Config (`pageSlide`). Na telefonie lista i szczegóły są osobnymi panelami.
- `/bots` pokazuje zapowiedź bez sztucznych danych; `/bots/[id]` daje 404. `/dev/bots` to galeria komponentów, a `/dev/long-thread` to syntetyczna długa historia; obie trasy działają wyłącznie w development, chronione `import.meta.env.DEV`.

`features/bots/wizard` dostarcza prezentacyjne `CreateBotWizard` i `EditBotAppearance`: współdzielony podgląd maskotki, 14 kształtów, kolory i własny picker HSV/HEX, walidację nazwy oraz istniejące pickery modelu/effortu. Instancje i modele przychodzą przez props, zapis przez asynchroniczny callback. API, adapter i weryfikacja: [bots-wizard.md](bots-wizard.md).
- API (JSON): `GET api/overview`, `GET api/threads` (wszystkie wątki użytkownika), `POST api/threads/[id]/messages` (`{text, clientRequestId, model?, effort?, permissionMode?, delivery?}`; `permissionMode` = klucz enuma, tylko ta tura: model i wysiłek tylko tej tury; `delivery` = `queue` (domyślnie) albo `steer`), `POST api/threads/[id]/goal` (`{action: set | pause | resume | clear, objective?, tokenBudget?}` → `SetGoal`), `POST api/threads/[id]/background-tasks/stop` (`{itemId}` → `StopBackgroundTask`), `POST api/threads/[id]/seen` (`{upToSeq}` dziesiętnie → `MarkThreadSeen`), `POST api/threads/[id]/settings` (`{model?, effort?, permissionMode?}` → `UpdateThread`: brak = bez zmian, pusty = domyślny profilu), `GET api/models?workerId=` (ostatnie katalogi), `POST api/models` (`{workerId}`: lista od nowa z workera, 503 gdy offline), `POST .../interrupt`, `POST api/interactions/[id]` (`{allow}` albo odpowiedzi), `GET api/workers/[id]/directory?path=`, `GET api/settings`, `PUT api/settings/user` (`UpdateUserSettingsRequest`), `PUT api/settings/projects/[id]` (`UpdateProjectSettingsRequest`; konflikt wersji → 409), `GET api/schedules?threadId=&projectId=&includeFinished=true`, `POST api/schedules` (`CreateScheduleRequest`), `POST api/schedules/[id]/status` (`{status: active | paused | cancelled}`), `GET api/providers` (`ListProviderInstances`), `POST api/providers/{save,delete,workers,worker,models,refresh,login}` (odpowiednio `SaveProviderInstanceRequest`, `DeleteProviderInstanceRequest`, `SetInstanceWorkersRequest`, `SetInstanceWorkerRequest`, `SetInstanceModelsRequest`, `RefreshProvidersRequest`, `StartProviderLoginRequest`; nieaktualna wersja albo instancja w użyciu: 409), `GET api/models?unfiltered=1` (katalogi bez wyborów instancji),
- Wzmianki: `POST api/mentions/catalog`, `api/mentions/files`, `api/mentions/threads` (ciało: `ListMentionCatalogRequest`, `SearchFilesRequest`, `SearchThreadsRequest` w JSON protobuf; odczyty, POST tylko dlatego, że ciałem jest wiadomość kontraktu); `POST api/threads/[id]/messages` przyjmuje `mentions` (JSON protobuf `Mention`, najwyżej 50), formularz nowego wątku ukryte pole `mentions` (to samo jako JSON) obok `message`.
- Kolejka: `POST api/threads/[id]/queue` (`{turnIds}`, nowa kolejność), `POST api/threads/[id]/queue/[turnId]` (`{action: "edit", text, expectedRevision, mentions?}` | `{action: "delete" | "restore" | "steer"}`); wiadomość, która już ruszyła = 409 z powodem.
- Załączniki: `POST api/attachments` (surowe bajty w ciele, nazwa w `x-file-name` zakodowana URI, wymagany nagłówek `x-requested-with: open-agents`, a `Origin`, jeśli jest, musi wskazywać ten host → `Attachment`), `GET api/attachments/[id]` (`?thumbnail`, `?download`), `GET api/threads/[id]/blobs/[sha256]` (podgląd z transkryptu). Odpowiedzi z bajtami: typ od gateway, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, immutable`; inline tylko PNG, JPEG, GIF, WebP, reszta `Content-Disposition: attachment` (SVG jako `application/octet-stream`, tekst i HTML jako `text/plain`). `POST api/threads/[id]/messages` przyjmuje `attachmentIds` (tekst może być pusty), formularz nowego wątku pola `attachmentId`.
- SSE: `api/overview/events`, `api/threads/[id]/events`. Po zerwaniu `EventSource` łączy się ponownie, a serwer zaczyna od świeżego snapshotu, więc stan klienta nie wymaga uzgadniania. W `api/threads/[id]/events` BFF łączy kolejne `item_delta` tego samego itemu i pola w jedno zdarzenie (`lib/server/coalesce.ts`): wychodzi, gdy fragment niesie koniec linii, po 200 ms, przed każdą inną zmianą i na końcu strumienia; kolejność i wynik reduktora są te same co dla pojedynczych delt, scalone zdarzenie ma `seq` ostatniej delty i puste `raw_json`.

Strumieniowany tekst (wiadomość agenta, rozumowanie, wyjście komendy, narzędzia i zadania w tle) pojawia się linia po linii (`lib/shared/ui/streaming`: `LineReveal`, reguły w `line-buffer.ts`): stan trzyma pełny tekst, a widok pokazuje go do ostatniego końca linii; niepełna linia dochodzi po 300 ms od ostatniego odsłonięcia (do ostatniego pełnego słowa), a całość od razu, gdy item się kończy albo kończy się jego tura (`ThreadDirectory.turnEnded`). Nagłówek tabeli czeka na wiersz separatora, niepełny płot kodu i wiersz tabeli nie są pokazywane jako surowy markdown, otwarty płot renderuje się jako kod. Markdown jest parsowany tylko przy zmianie widocznego tekstu, a niezmienione bloki, punkty list i wiersze tabel zachowują obiekty tokenów (`shareTokens`), więc renderuje się tylko blok, który urósł. Każdy nowy blok, punkt listy, wiersz tabeli i linia kodu (`code/CodeLines`) wchodzi raz przez `t-stream` (wyostrzenie z przenikaniem, `--duration-medium`); przy `prefers-reduced-motion` od razu.

Markdown na żywo w kompozytorze (`features/mentions`): pole formatuje markdown podczas pisania, a tekst zostaje dokładnie ten sam (`value` trzyma backticki i płoty). **Kod inline**: fragment w pojedynczych backtickach w jednej linii (`markdown.ts` `codeSpans`) staje się `<code>` w chwili wpisania zamykającego backticka; backticki zostają tekstem obok, wyciszone przez CSS Custom Highlight API (bez znaczników, więc kursor i pisanie są nietknięte). Po każdej edycji linie, w których DOM nie zgadza się z tekstem (dopisany lub usunięty backtick, `<font>` / `<span style>` zostawione przez przeglądarkę), są pisane od nowa przez `insertHTML` — jeden krok cofania: Ctrl+Z najpierw zdejmuje formatowanie; samo cofanie i ponawianie nie jest formatowane. Chip, `<br>` i blok kończą fragment, więc wzmianki obok kodu działają, a wewnątrz kodu wyzwalacze się nie otwierają. **Blok kodu**: linia samego płotu (`` ``` `` albo `` ```ts ``) i Enter zamienia ją w blok (jedna edycja przeglądarki); wklejony albo przywrócony kompletny płot też jest blokiem. Blok to nieedytowalny element z kodem i językiem w atrybutach `data-*` (z nich czyta serializacja), w który montuje się `CodeBlockField`: pigułka języka (`LanguagePicker`: wyszukiwanie po nazwie i aliasach, wybór zapisuje krótki tag, np. `ts`, „Plain text” — żaden), przycisk usuwania i `<textarea>` z przezroczystym tekstem nad podświetloną kopią (`CodeLines`, leniwie i przyrostowo), więc pisanie, IME, wklejanie (dosłowne), cofanie i klawiatury telefonów są natywne. Klawisze w bloku: Enter / Shift+Enter nowa linia z wcięciem poprzedniej (nigdy nie wysyła; Mod+Enter wysyła), Tab / Shift+Tab wcięcie / cofnięcie wcięcia linii albo zaznaczonych linii (2 spacje), ArrowDown w ostatniej linii, ArrowRight na końcu, Enter w pustej ostatniej linii albo wpisany płot zamykający wychodzą pod blok, ArrowUp w pierwszej linii i ArrowLeft na początku nad blok, Backspace w pustym bloku go usuwa. W tekście: Backspace na początku linii za blokiem i ArrowUp z niej wchodzą na koniec bloku, Delete na końcu linii przed blokiem i ArrowDown z niej — na początek (przeglądarka usunęłaby go w całości albo przeskoczyła). Blok na początku pola albo zaraz za innym blokiem ma przed sobą niewidoczną linię (spacja zerowej szerokości, serializacja ją pomija): bez niej przeglądarka nie usunie elementu nieedytowalnego ani nie postawi kursora nad nim. Serializacja: blok to dokładnie ```` ```lang\nkod\n``` ```` (pusty kod: ```` ```lang\n``` ````); kod z własną linią backticków dostaje dłuższy płot. Tylko płoty, które blok zapisze z powrotem tak samo, stają się blokami (niezamknięte, `~~~`, info ze spacjami zostają tekstem), więc tekst zawsze wraca bez zmian. Kopiowanie i wycinanie z pola dają tekst wiadomości (płoty, znaczniki wzmianek). **Pogrubienie i kursywa** są formatowane na żywo w tym samym edytorze Threads i Bots (`inlineSpans`, lexer używany też przez renderer wiadomości); znaczniki pozostają edytowalnym tekstem. Listy pozostają zwykłym tekstem.

Podświetlanie składni (`lib/shared/ui/code`): Shiki (gramatyki TextMate) na silniku wyrażeń regularnych JavaScript (bez WASM), z `@shikijs/primitive` (bez hast/HTML). Język z tagu płotu albo ścieżki pliku (`languages.ts`: aliasy jak `ts`, `py`, `sh`, `yml`, `Dockerfile`); nieznany albo brak → zwykły tekst, kod inline zawsze zwykły. Highlighter (`highlighter.ts`) i każda gramatyka to osobne chunki ładowane przy pierwszym bloku, który ich potrzebuje. Motyw (`theme.ts`) mapuje zakresy gramatyk na role `--code-*` (wartości dla jasnego i ciemnego schematu w `syntax.css`), więc zmiana schematu nie tokenizuje ponownie; bez pogrubień i kursyw, by kolorowanie nie zmieniało szerokości. `Highlight` (`highlight.svelte.ts`) tokenizuje w kawałkach po ~6 ms między klatkami; linia bez kolorów renderuje się jako zwykły tekst w tym samym miejscu. `IncrementalHighlight` trzyma stan gramatyki po każdej linii: rosnący (strumieniowany) blok kontynuuje od ostatniej niezmienionej linii, a niezmienione linie zachowują obiekty i DOM. Diff (`DiffLines`, `diff.ts`) podświetla kod w języku pliku, osobno stronę nową (kontekst + dodane) i starą (kontekst + usunięte); płot ```` ```diff ```` renderuje się jako diff. Wyjście komend i narzędzi zostaje zwykłe.

**Panel kolejki** (`features/threads/queue`, [Kolejka](#kolejka)). Wiadomości czekające za turą w toku są panelem przyczepionym nad kompozytorem jak w aplikacji Codex (ta sama powierzchnia, zaokrąglone tylko górne rogi, dolna krawędź chowa się pod kompozytorem): wiersz na wiadomość z ikoną kolejki, tekstem w jednej linii, podpowiedzią nadpisań („GPT-5.5 · High effort · Read only · 2 files”; na telefonie w menu) i akcjami — „↳ Steer” (do tury w toku teraz; tylko gdy tura trwa, nieaktywny dla wiadomości z plikami), kosz (usuwa od razu, toast z „Undo” przywraca na miejsce) i „…” (Edit message, Move to top / bottom, Turn on / off queueing; na telefonie arkusz). Kolejność: przeciąganie za uchwyt (ikona kolejki zamienia się w uchwyt po najechaniu albo fokusie, na dotyku zawsze; palcem też, `touch-action: none` tylko na uchwycie) albo Alt+↑/↓ w wierszu (↑/↓ na uchwycie), z komunikatem dla czytników ekranu; wiersze płyną na nowe miejsca (FLIP, `reorder` na `--duration-fast`), wchodzą i wychodzą `expand`, przeciągany wiersz unosi się i idzie za wskaźnikiem. Edycja jest w wierszu (Enter zapisuje, Shift+Enter nowa linia, Escape anuluje), a nie przez kompozytor: wiadomość zostaje na swoim miejscu z nadpisaniami i załącznikami (te są już związane z turą i nie dałoby się ich wysłać drugi raz). Zmiany widać od razu (`QueueState`: lokalna kolejność, ukryte usunięte i wysterowane); gateway je potwierdza, odmowa (wiadomość właśnie ruszyła) przywraca stan z gateway i mówi dlaczego w toaście. Tury wyjęte z kolejki (`Turn.withdrawn`) nie są na osi czasu, a numer „Turn N” je pomija. Usunięcie wiadomości agenta, harmonogramu albo celu nie jest możliwe (tylko kolejność).

**Cytaty na osi czasu (Cite).** Zaznaczenie tekstu wytworzonego przez agenta (odpowiedź, wcześniejsze wiadomości, rozumowanie, wejście i wynik narzędzia, wynik polecenia, blok kodu, diff) pokazuje mały przycisk „Cite” przy końcu zaznaczenia: z myszą po puszczeniu przycisku (nie w trakcie przeciągania), z klawiatury po ustaleniu się zaznaczenia, na ekranach dotykowych pod uchwytami zaznaczenia (systemowe menu zostaje nad nim). Przycisk jest w top layer (`features/quotes/CiteLayer.svelte`), więc transkrypt się nie przesuwa; `Alt+Q` cytuje bieżące zaznaczenie z klawiatury (Ctrl+Shift+C otwiera narzędzia deweloperskie przeglądarki). Cite otwiera popover „Add an optional comment…” (Enter zapisuje, Shift+Enter nowa linia, Esc anuluje, Tab krąży w środku; ten sam popover posłuży do edycji z chipa). Zapisany cytat trafia do szkicu cytatów wątku (`useQuoteDrafts()`, `quote-drafts.svelte.ts`: `list/add/edit/remove/clear/wire`, w pamięci karty) i pojawia się w kompozytorze jako chip nad tekstem, obok zasobnika załączników (`QuoteTray` w slocie `elements` `ComposerBox`): ikona cytatu, początek fragmentu, ołówek (ponownie otwiera popover komentarza; z komentarzem w kolorze marki) i usunięcie (×, także Delete/Backspace na przycisku chipa; fokus przechodzi na sąsiada). Chipy wskakują i znikają jak chipy plików (`pop`, `reorder`). Wiadomość idzie z cytatami w `SendMessage.quotes` (także steer), może składać się z samych cytatów (`elementCount` w `ComposerBox` odblokowuje wysyłanie); po udanym wysłaniu znikają tylko wysłane cytaty. Przycisk Cite trzyma się między górą feedu a górą jego lepkiej stopki (kompozytor, karty), więc przy zaznaczeniu tuż nad kompozytorem staje nad zaznaczeniem. Reguły zaznaczenia (`selection.ts`): cytat to tekst, jaki widać (wyrenderowany markdown bez `**`, kod i diff z podziałami linii i wcięciami, bez przycisków, etykiet języka i kontrolek), jedno zaznaczenie = jeden cytat i tylko wewnątrz jednego obszaru jednego itemu (`data-quote-item` na `ItemNodeView`, `data-quote-kind` na obszarach widoków); zaznaczenie przez kilka itemów, we własnych wiadomościach albo w interfejsie dookoła nie pokazuje Cite. Bańka wiadomości pokazuje cytaty (początek fragmentu na linii z lewej i komentarz pod nim); kliknięcie przewija do źródła (otwiera zwinięte „Worked for …” albo odziedziczoną historię) i na chwilę je podświetla (`data-flash`), a gdy źródła już nie ma, mówi o tym.

**Załączniki w kompozytorze i na osi czasu.** Oba kompozytory (nowy wątek i wątek) przyjmują pliki spinaczem (na telefonie systemowy wybór z aparatem, galerią i plikami), upuszczeniem na pole (obwódka w kolorze marki podczas przeciągania) i wklejeniem (zrzut ekranu ze schowka; wklejenie samego obrazu nie wkleja tekstu). Pliki wysyłają się od razu po dodaniu, z paskiem postępu; błąd (limit, program, odrzucenie przez gateway) stoi przy pliku i pod polem, a wysłanie czeka, aż wszystkie pliki są gotowe albo usunięte. Wiadomość może mieć same pliki. Z plikami wiadomość jest zawsze następną turą (w trakcie tury przycisk wysyłania nie steeruje). Wiadomość użytkownika na osi czasu pokazuje obrazy jako miniatury (dotknięcie: pełny obraz w lightboxie z pobieraniem) i pliki jako chipy (nazwa, rozmiar, typ, pobranie) zamiast ścieżek; pełny tekst z notatką platformy jest zwinięty pod „Full text the agent received”. Item `image` pokazuje podgląd tego, co zobaczył model („Viewed image” dla `view_image`, „Image” dla natywnego odczytu, „Generated image”), z wymiarami oryginału, gdy obraz był zmniejszony; nieudany `view_image` pokazuje powód. Item narzędzia z obrazami w wyniku (np. `Read` Claude) pokazuje je pod wejściem.

Strona wątku przewija historię w jednym kontenerze (`VirtualFeed`): wirtualizowana oś `role="feed"` (artykuły z `aria-posinset` / `aria-setsize`). Nakładka kompozytora, gradient i „Jump to latest” są poza nim. `ResizeObserver` mierzy zamontowane wiersze, viewport i stopkę. Do pierwszego snapshotu SSE w miejscu wiadomości stoi `TimelineSkeleton`; snapshot montuje ostatnie wiersze i przypina dół przed malowaniem. Nie ma serwerowego pobrania końca wątku ani skryptu przed hydratacją. Gradient ma geometrię nakładki bez opóźnienia pomiaru. Nowe wiersze animują transform/przezroczystość; wiersze spoza widoku i dołożone na początku nie animują, a wstawione pośrodku tylko według `inserted` (`t-unfold`). Dół pozostaje przypięty podczas strumieniowania, zmiany wysokości kompozytora i otwarcia klawiatury; czytanie wyżej kotwiczy pierwszy widoczny wiersz. Klawiatura: Page Up/Down, Home/End w obszarze przewijania, Page Up/Down między artykułami, Ctrl+End do kompozytora. `/dev/long-thread` (tylko development) dostarcza syntetyczną historię i pomiary.

**Paleta poleceń i skróty klawiszowe** (`features/commands`). Mod+K (⌘K na Macu, Ctrl+K gdzie indziej) albo przycisk lupy w górnym pasku (wąskie i dotykowe ekrany) otwiera panel nad przyciemnioną stroną: wyszukiwarka „Search commands, projects, and threads…”, lista w grupach Actions, Recent threads, Projects, Settings (puste zapytanie: akcje i 8 ostatnich wątków głównych; projekty tylko w wynikach wyszukiwania), stopka z podpowiedziami klawiszy. Pisanie filtruje dopasowaniem rozmytym (znaki zapytania po kolei, premie za początek słowa i ciągłość, odrzucane dopasowania rozsiane po środku słów; każde słowo zapytania musi pasować do tytułu albo słów kluczowych — wątek znajdzie się też po projekcie, workerze i katalogu); grupy zachowują kolejność, w grupie decyduje wynik, dopasowane znaki tytułu są podświetlone, limity: 30 wątków i 10 projektów. Szukanie znajduje też wpisy podmenu oznaczonych `searchChildren` (np. „Change theme › Ocean”), ale tylko po ich własnej nazwie. Podmenu (›) otwiera się w miejscu z okruszkiem; Backspace przy pustym zapytaniu, ← albo przycisk wstecz wraca i przywraca poprzednie zapytanie. Klawisze: ↑↓ (zawijają), Home/End, PageUp/PageDown, Enter, → (wejście do podmenu), Escape zamyka; najechanie myszą podświetla, kliknięcie / dotknięcie wybiera. Wzorzec WAI-ARIA combobox + listbox (fokus zostaje w polu, `aria-activedescendant`, grupy `role="group"`, licznik wyników w `role="status"`); modalny `<dialog>` trzyma fokus, po zamknięciu wraca on do elementu, który był aktywny przed otwarciem (chyba że polecenie otworzyło inny dialog). Polecenia z `href` są prawdziwymi linkami (`<a role="option">`), więc nawigacja idzie zwykłą drogą linków (router, nowa karta z modyfikatorem). Ruch: otwarcie i zamknięcie jak dialogi zestawu (`t-modal`), zmiana poziomu podmenu wjeżdża z boku (`pageIn`, „page side-by-side”), filtrowanie bez animacji wierszy; przy `prefers-reduced-motion` tylko przenikanie.

Nowe polecenie dodaje funkcja albo strona: `contributeCommands(() => [{ id, title, group: "actions", icon, keywords, hotkey, when: () => …, run | href | children }])` — źródło czytane przy każdym listowaniu, więc może zależeć od stanu komponentu; usuwane razem z komponentem. Strona wątku dodaje w ten sposób swoje akcje.

Skróty (paleta wiąże globalnie skróty, które pokazuje; skróty z modyfikatorem działają też podczas pisania w polu, gołe klawisze tylko poza polami tekstowymi; żaden, gdy otwarty jest inny modalny dialog — poza Mod+K):

| Skrót | Działanie |
|---|---|
| Mod+K | paleta poleceń (otwiera / zamyka) |
| Mod+Shift+O | nowy wątek w bieżącym projekcie (projekt wątku, wybrany na stronie nowego wątku, inaczej domyślny); Mod+N / Mod+Shift+N należą do przeglądarki (nowe okno, okno prywatne) i strona ich nie dostaje |
| Mod+B | zwiń / rozwiń pasek boczny (poniżej `lg` otwiera szufladę nawigacji) |
| Enter / Mod+Enter (kompozytor) | wyślij lub wpleć w trwającą turę / dodaj do kolejki |

Polecenia palety: New thread in ‹bieżący projekt›, New thread in… (podmenu projektów), Toggle sidebar, Change theme (akcenty), Change appearance (System / Light / Dark), Chat width, Open settings, New project; na stronie wątku dodatkowo Interrupt (gdy pracuje), Side thread…, Schedule a task…, Model and effort…, Permissions…, Set / Replace the goal… (wątki workera; wyszarzone, gdy cel nie może być teraz ustawiony), Toggle thread details, Copy thread link, Copy thread id, Copy working directory (tylko w wynikach); Recent threads; projekty (podmenu: nowy wątek, ustawienia projektu, jego wątki); sekcje ustawień (Appearance, Thread defaults, Scheduled tasks, Projects, Workers).

Stany: brak gateway (powłoka renderuje się dalej, baner i ponawianie), ponowne łączenie SSE, worker offline (wątek i wiadomości czekają), wątek w tworzeniu lub nieudany, ładowanie (szkielety), puste listy. Układ od telefonu (skrzynka wątków w szufladzie, panel kontekstu jako arkusz) do desktopu (pasek boczny, czat pośrodku, panel z prawej).

Bezpieczeństwo:
- przeglądarka nie zna adresu gateway ani tokenu,
- formularze chroni kontrola `Origin` SvelteKit (CSRF), a endpointy JSON wymagają `content-type: application/json` (formularz z innej strony go nie ustawi),
- workspace musi leżeć w dozwolonych katalogach workera: gateway sprawdza to leksykalnie przy tworzeniu (według systemu workera), worker ścieżki rzeczywiste przy starcie wątku ([threads.md](threads.md#projekt-na-wielu-workerach-i-systemach)).

Projekt może żyć na wielu workerach (workspace na każdym): ustawienia projektu pokazują każdy worker (system, online) z katalogiem projektu, lista wątków i nagłówek wątku pokazują workera, a wybór katalogu buduje ścieżki separatorem systemu workera. Nowego wątku nie da się wysłać na worker offline (kompozytor mówi dlaczego); istniejące wątki i ich wiadomości na workerze offline czekają na jego połączenie.

## 5. Uruchomienie (development)

```bash
docker run -d --name oa-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=open_agents -p 127.0.0.1::5432 postgres:17
export OA_DATABASE_URL=postgres://postgres:dev@127.0.0.1:<port>/open_agents
export OA_SECRETS_KEY=$(openssl rand -base64 32)   # trzymać stały: szyfruje sekrety w bazie
export OA_UI_SERVICE_TOKEN=$(openssl rand -hex 32) # ten sam dla SvelteKit

# rejestracja workera (wypisuje worker.json; zapisać z chmod 600)
OA_CLIPROXYAPI_API_KEY=... bun apps/gateway/src/cli.ts worker add --name laptop --root ~/code \
  --gateway-url http://127.0.0.1:7443 [--cliproxy-url https://proxy:8443]

bun apps/gateway/src/main.ts          # migracje (OA_MIGRATE=1, domyślnie), serwer gRPC na :7443
OA_WORKER_CONFIG=./worker.json bun apps/worker/src/main.ts
OA_UI_SERVICE_TOKEN=... bun tests/integration/smoke/bff-client.ts "Reply OK"   # klient BFF do testów

# frontend
cd apps/web
GATEWAY_SERVICE_TOKEN=$OA_UI_SERVICE_TOKEN bun run dev                     # http://localhost:5173
bun run build && GATEWAY_SERVICE_TOKEN=... PORT=3000 node build/index.js    # produkcyjnie
```

Załączniki idą przez BFF: `adapter-node` ma domyślnie `BODY_SIZE_LIMIT=512K`, więc w produkcji trzeba ustawić co najmniej limit pliku gateway, np. `BODY_SIZE_LIMIT=25M`.

`adapter-node` przyjmuje `https`, jeśli nie zna protokołu. Za reverse proxy ustawić `PROTOCOL_HEADER=x-forwarded-proto` (i `HOST_HEADER`, jeśli proxy zmienia host). Inaczej kontrola `Origin` odrzuci formularze. Build nie potrzebuje sekretów.

### Wydania web bez przebudowy działającego katalogu

`bun run build` zachowuje domyślne `build/`; `BUILD_DIR` zmienia katalog adapter-node. Do restartowanego stacka używać `bun run release` z `apps/web`:

```text
apps/web/releases/
  <commit>-<czas-builda>/
    index.js, adapter-node.js, server/, client/, immutable-files.json
  current -> <commit>-<czas-builda>
```

Skrypt buduje w nowym katalogu, zachowuje hashowane `_app/immutable` z poprzednich wydań, po powodzeniu atomowo zmienia symlink `current` i zostawia trzy wydania (`WEB_RELEASE_KEEP`, minimum 2). `WEB_RELEASES_DIR` zmienia katalog wydań. Każdy manifest zapisuje tylko własne assety, więc retencja nie kumuluje ich bez końca. Stary katalog `build/client/_app/immutable` też jest uwzględniany przy pierwszych wydaniach migracji.

Kopiowanie odbywa się w hooku adaptera **przed** wygenerowaniem tabeli plików statycznych adapter-node 6; późniejsze skopiowanie plików do gotowego `client/` nie wystarcza. Nie kopiujemy starych dokumentów HTML, `version.json` ani modułów serwera. Nieudany build pozostawia poprzednie `current`. Blokada `.build-lock` zapobiega równoległym wywołaniom skryptu w tym samym katalogu wydań. Nie uruchamiać jednocześnie ręcznego builda ani wydania z innym `WEB_RELEASES_DIR`: współdzielą `.svelte-kit/output`. Po przerwaniu procesu można usunąć blokadę dopiero po upewnieniu się, że żaden build już nie działa.

Zmiana dla skryptu restartu stacka:

1. Uruchomić `bun install` w repozytorium i `(cd apps/web && bun run release)`, gdy poprzednie procesy nadal działają. Przy błędzie zakończyć restart bez zatrzymywania działającego stacka.
2. Zapamiętać rzeczywistą ścieżkę nowego wydania: `web_release=$(readlink -f apps/web/releases/current)`.
3. Zatrzymać dotychczasowy web, gateway i worker po ich zapisanych PID-ach; uruchomić gateway i worker dotychczasowymi komendami i poczekać na gotowość gateway.
4. Uruchomić web z zapamiętanego katalogu, zachowując dotychczasowe zmienne proxy, origin, limity uploadu i logowanie PID-a:

   ```bash
   GATEWAY_SERVICE_TOKEN="$OA_UI_SERVICE_TOKEN" \
   GATEWAY_URL=http://127.0.0.1:17443 HOST=127.0.0.1 PORT=5180 \
   BODY_SIZE_LIMIT=25M PROTOCOL_HEADER=x-forwarded-proto \
   bun "$web_release/index.js"
   ```

Symlink wybiera wydanie dla **następnego procesu**; działający serwer nadal używa własnego katalogu. Rozwiązanie symlinka raz przy uruchomieniu gwarantuje to także dla modułów ładowanych leniwie. Nie usuwać katalogu używanego przez proces i nie pozostawiać starego procesu przez więcej cykli niż okno retencji. Sam restart nadal może dać krótkie 502 na proxy; frontend odzyskuje połączenie automatycznie. Rollback: atomowo ustawić `current` na zachowane wydanie i ponownie uruchomić web z jego rzeczywistej ścieżki.

### Nowa wersja, błędy chunków i przerwy w połączeniu

`version.name` to commit + czas builda, identyczny we wszystkich fazach jednego builda. SvelteKit sprawdza `updated` co 60 s, po powrocie fokusu/widoczności i przez nagłówki odpowiedzi danych. Banner „A new version is available — Reload” oraz toast pojawiają się bez odświeżania bieżącego kompozytora. Następna nawigacja klientowa przechodzi przez pełne `location.href`; kliknięcie Reload jawnie przeładowuje stronę. Zmiana wersji ma pierwszeństwo przed nakładką ustawień.

`vite:preloadError`, odrzucone importy dynamiczne, klientowy `handleError` i błędy importu highlightera uruchamiają ten sam banner. Nie ma automatycznego reloadu przy takim błędzie, więc nie ma pętli odświeżeń ani nieoczekiwanej utraty szkicu. Starsze chunki są dostępne w oknie retencji.

`live-source.ts` sam zamyka uszkodzony EventSource i otwiera nowy z opóźnieniami 1/2/4/8/15 s oraz jitterem 75–100%. Udane otwarcie z resynchronizacją zeruje backoff. Retry czeka w ukrytej/offline karcie; focus, widoczność i online wznawiają je od razu. Zdrowy strumień może działać w tle. Heartbeat ma watchdog 30 s; HTTP 200 bez ramki `ready` nie oznacza połączenia. Overview pobiera świeży stan po przerwie i buforuje równoczesne aktualizacje; wątek dostaje nowy snapshot. Status stopki przechodzi przez Connected / Reconnecting… / Gateway unavailable i wraca sam.

Powłoka odpowiada 200 także bez gateway; początkowy HTML zawiera szkielet z właściwym schematem i geometrią. BFF zwraca szybko 502/503 dla niedostępnego gateway, a widoki błędów tras i nakładki ponawiają dane co 3 s w widocznej karcie oraz mają Try again. Przy istniejących danych aplikacja zachowuje ostatni stan i szkic podczas ponawiania SSE. Wywołania celowo czekające na worker, np. odświeżanie modeli i logowanie dostawcy, mają osobne dłuższe deadline'y.

## 6. Ograniczenia na teraz

- **Jeden użytkownik deweloperski** (`OA_DEV_USER_EMAIL`). Logowanie powstanie w SvelteKit (sesja w cookie `HttpOnly`), a tożsamość użytkownika trafi do gateway w metadanych wywołania z tokenem usługi.
- **Jedna instancja gateway** (`Hub` w procesie).
- Rejestracja workerów na razie przez CLI; instancje dostawców (globalne, włączane per worker), ich zmienne i modele są w UI.
