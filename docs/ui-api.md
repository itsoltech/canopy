# API dla UI i architektura frontendu

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
    K["SvelteKit (BFF)<br/>strony, akcje, endpointy JSON, SSE"]
    G["Gateway<br/>stan globalny (PostgreSQL)"]
    W["Workery"]
    B -- "HTTP/1.1: strony, akcje, JSON" --> K
    K -- "SSE: zmiany na żywo" --> B
    K -- "gRPC (HTTP/2): GatewayService<br/>token usługi" --> G
    W -- "gRPC (HTTP/2): WorkerLinkService" --> G
```

- **Gateway jest jedynym stanem globalnym.** Przechowuje projekty, wątki, tury, transkrypty, interakcje i komendy. Orkiestruje workery.
- **SvelteKit jest BFF.** Przeglądarka rozmawia tylko z nim, po HTTP/1.1. Serwer SvelteKit woła gateway po gRPC z prywatnym tokenem usługi, a zmiany na żywo przekazuje przeglądarce przez **SSE**. W przeglądarce nie ma adresu gateway, tokenów ani klienta gRPC.
- Gateway podaje `GatewayService` na tym samym serwerze HTTP/2 co `WorkerLinkService`. Interceptor (`serviceTokenAuth`) przepuszcza wywołania `GatewayService` tylko z tokenem usługi (`OA_UI_SERVICE_TOKEN`, porównanie odporne na pomiar czasu). Workery uwierzytelniają się osobno, w handlerze `WorkerLinkService`.

## 2. `GatewayService`

| Metoda | Co robi |
|---|---|
| `GetOverview` | workery (online, wykryte CLI, profile, dozwolone katalogi, wersja konfiguracji i raport) oraz projekty z workspace'ami |
| `WatchOverview` | strumień zmian workerów, projektów i wątków |
| `ListDirectory` | przeglądanie katalogów na workerze, w dozwolonych katalogach (wybór workspace'u) |
| `CreateProject`, `CreateWorkspace` | projekt; workspace = katalog na workerze |
| `ListThreads`, `GetThread`, `CreateThread` | wątki projektu (pusty projekt = wszystkie wątki użytkownika); jeden wątek; nowy wątek (główny albo boczny, opcjonalnie fork) z opcjonalną pierwszą wiadomością. Gateway sprawdza według ostatniego raportu workera, że dostawca jest dostępny, a profil istnieje, jest dostępny i obsługuje tego dostawcę; fork zachowuje dostawcę rodzica. `model` i `effort` to domyślne wątku (`Thread.model`, `Thread.effort`), sprawdzane z katalogiem profilu, gdy worker go zgłosił i jest kompletny (model po `id` albo `resolved_model`; wysiłek z `efforts` modelu, a bez modelu z modelu `is_default`) |
| `SendMessage` | wiadomość; idempotentne po `client_request_id` (także między kolejką a steerem). `model` i `effort` nadpisują domyślne wątku tylko dla tej tury (sprawdzane z katalogiem). `delivery`: `QUEUE` (domyślnie, następna tura → `response.turn`) albo `STEER` (do tury w toku → `response.steer`; bez tury w toku działa jak `QUEUE`). Steer ma statusy `pending` → `accepted` → `delivered` albo `queued` (nie wszedł: tura skończyła się wcześniej albo dostawca odmówił; jest następną turą `queued_turn_id`, powód w `reason`); model i wysiłek z wiadomości obowiązują dopiero w tej turze. W transkrypcie steer to item `user_message` z `client_id = steer.id` w turze, do której wszedł, w miejscu, w którym wszedł. Zmiany na żywo: `ThreadUpdate.steer`, snapshot ma `steers` |
| `UpdateThread` | domyślny model i wysiłek wątku (`optional`: nieustawione = bez zmian, pusty = domyślny profilu); dotyczy tur bez nadpisania. Zmiana idzie w `ThreadUpdate.thread` |
| `ListModels` | katalog modeli workerów (`WorkerModels`: worker → `ProfileModels` per dostawca i profil → `ModelInfo`: `id`, `resolved_model`, `display_name`, `description`, `hidden`, `is_default`, `efforts`, `default_effort`; `detail` = lista niepełna). Bez `refresh` ostatni raport workera (wysyłany po każdej zmianie konfiguracji), z `refresh` lista od nowa z workera (musi być online). Zmiany na żywo: `OverviewUpdate.models`. Puste `efforts` = model bez wyboru wysiłku albo spoza katalogu dostawcy (np. inne modele pośrednika); taki model jest w pełni używalny. Katalog ma tylko modele, które poprowadzą turę agenta (bez obrazów, wideo, TTS, embeddingów itd.; worker je usuwa). `default_effort` = domyślny wysiłek ustawiony przez użytkownika w harnessie na urządzeniu, jeśli model go oferuje, inaczej domyślny modelu, inaczej pusty; tura bez wysiłku działa właśnie z nim ([protocol.md](protocol.md#modele-effort-i-steer)) |
| `InterruptThread` | przerwanie tury w toku |
| `AnswerInteraction` | odpowiedź na zgodę albo pytanie |
| `WatchThread` | najpierw snapshot (wątek, tury ze zużyciem tokenów, itemy, oczekujące interakcje, ostatnie komunikaty, `last_seq`), potem zmiany na żywo: zdarzenia (`seq` + `ThreadEvent`), wątek, tura, interakcja. Snapshot forka zawiera odziedziczoną historię: tury i itemy wątku źródłowego do punktu forka z `inherited = true` i `from_thread_id`. Tura ma `model` i `effort`: nadpisanie z wiadomości, a od startu wartości faktycznie wysłane do workera (puste = domyślne profilu). Tura ma swoje źródło (`source_kind`: task, message, report, question, schedule; `source_thread_id`, `schedule_id`, `interaction_request_id`; dla raportu `source_status`, dla pytania `question_kind` i `question_tool`), odczytane z relacji w bazie (widok `turn_sources`), nie z treści. `input_text` to dokładnie to, co dostał model; `platform_note` i `message_text` to ta sama treść rozdzielona na notatkę platformy i właściwą wiadomość |
| `ListSchedules`, `CreateSchedule`, `PreviewSchedule`, `SetScheduleStatus` | harmonogram platformy (podgląd najbliższych terminów cronu przed utworzeniem; zakończonego ani anulowanego nie da się wznowić): lista (wątek, projekt albo wszystkie; z autorem: użytkownik albo agent i jego wątek), nowy harmonogram użytkownika (jednorazowy `run_at` albo `cron` ze strefą czasową; może być bez końca), wstrzymanie, wznowienie, anulowanie. Zmiany na żywo w `ThreadUpdate.schedule` i `OverviewUpdate.schedule`, a snapshot wątku zawiera jego aktywne i wstrzymane harmonogramy |
| `SetGoal` | cel harnessu w wątku ([goals.md](goals.md)): `action` = `set` (nowy cel z `objective`, opcjonalnie `token_budget` tylko dla Codexa; zastępuje otwarty), `pause`, `resume`, `clear`. Zwraca `Goal`; decyzja jest zapisana od razu, harness potwierdza ją raportem (`Goal.native_status`). Codex: komenda `SetGoal` do workera; Claude: tura `/goal …` w kolejce (`trigger = goal`; pauza i usunięcie najpierw przerywają turę). Błędy: brak otwartego celu do pauzy/wznowienia/usunięcia, budżet dla Claude, `objective` > 4000 znaków |
| `StopBackgroundTask` | zatrzymanie zadania w tle (`thread_id`, `item_id` itemu `background_task`, musi być `in_progress`) → komenda `StopTask`; item kończy się `interrupted` (`stop_reason = stopped_by_user`), gdy worker to zgłosi ([execution.md](execution.md#4-zadania-w-tle)) |
| `GetSettings`, `UpdateUserSettings`, `UpdateProjectSettings` | ustawienia użytkownika (wygląd: schemat kolorów, akcent, szerokość czatu, panel wątku; domyślne wartości nowych wątków, w tym model osobno dla każdego dostawcy; ulubione modele `model_favorites`: dostawca, profil (pusty = dowolny), model) i projektu (domyślne wartości wątków, nadpisują użytkownika). Przechowuje je gateway (`user_settings`, `project_settings`); przeglądarka jest tylko klientem. Zapis zastępuje podane sekcje i podaje wersję, od której zaczął: konflikt z innym urządzeniem = `FailedPrecondition` (BFF: 409), klient pobiera ustawienia od nowa. Zmiany na żywo w `OverviewUpdate.user_settings` / `project_settings` |

UI składa itemy na żywo tym samym reducerem co gateway (`reduceItem` z `@open-agents/domain`).

Cele i praca w tle w modelu UI (pola od 60, osobno od innych zmian kontraktu):
- `Thread.goal_status` (status otwartego celu albo pusty) i `Thread.background_tasks` (zadania w tle w toku) — także w `WatchOverview`, np. na plakietki w pasku bocznym,
- `Goal`: `objective`, `status` (`active | paused | blocked | budget_limited | usage_limited | achieved | cancelled`), `created_by` (`user | provider`), `token_budget`, `tokens_used`, `time_used_seconds`, `iterations` (Codex: tury kontynuacji, Claude: oceny ewaluatora), `last_reason` (werdykt ewaluatora), `native_status`, czasy,
- `ThreadSnapshot.goal` (otwarty cel albo ostatni zakończony), na żywo `ThreadUpdate.goal`; `Turn.goal_id` (tury celu),
- zadania w tle to itemy `background_task` na osi czasu (`kind`, `command`, `output`, `started_in_turn_id`, `source_item_id`, `stop_reason`); po turze przychodzą jako zdarzenia bez `turn_id`.

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

Kod wg funkcji (`#lib/features/*`), kod tylko serwerowy w katalogach `server/` (SvelteKit nie pozwala go zaimportować w przeglądarce).

| Ścieżka | Rola |
|---|---|
| `src/env.ts` | `GATEWAY_URL`, `GATEWAY_SERVICE_TOKEN` (`defineEnvVars`, odczyt przy starcie, nie przy buildzie) |
| `src/hooks.server.ts` | `init`: serwer nie wystartuje bez tokenu usługi; `handle`: dla żądania strony pobiera ustawienia (`GetSettings`) i wpisuje wygląd w `<html>` (`transformPageChunk`, placeholdery `%oa.*%` w `app.html`: klasa `dark`, `data-color-scheme`, `data-accent`, `data-chat-width`, `meta color-scheme`), więc nie ma mignięcia; tylko schemat „system” rozstrzyga w przeglądarce jedna linijka skryptu (`prefers-color-scheme`). Główny layout używa tych samych ustawień |
| `lib/server/gateway.ts` | klient gRPC z tokenem; `call` (błędy gateway → HTTP: 400, 404, 409, 503, reszta 502), `attempt` dla akcji formularzy (4xx → `fail`, komunikat przy formularzu) |
| `lib/server/sse.ts`, `body.ts` | strumień gRPC → SSE (heartbeat co 15 s, ramka `failure`); ścisłe dekodowanie JSON (nadmiarowe pola → 400): `readBody` (Effect Schema) i `readMessage` (wiadomość kontraktu w JSON protobuf) |
| `lib/shared/wire.ts`, `http.ts` | JSON protobuf (`toJson` / `fromJson`) między serwerem a przeglądarką: te same schematy po obu stronach; `requestJson` (wywołania BFF z przeglądarki, `HttpError` ze statusem, np. 409) |
| `lib/shared/ui` | prymitywy UI: `Button`, `ButtonLink`, `IconButton`, `Field` + `Input` / `Select` / `Textarea` / `Checkbox`, `Badge`, `StatusBadge`, `StatusDot`, `ProjectAvatar`, `Alert`, `EmptyState`, `Dialog`, `Drawer`, `Disclosure` (`remember`: stan w pamięci UI wiersza), `CodeBlock`, `Skeleton`, `SettingsGroup` + `SettingsRow`; wygląd przełącznika segmentowego (`segmented.ts`); `virtual/VirtualFeed` (przewijany czat, opis niżej) z `SizeIndex` (wysokości wierszy: zmierzone po kluczu, reszta ze średniej grupy, sumy prefiksowe) i `memory.ts` (stan UI wierszy, które lista odmontowała, np. rozwinięte szczegóły); ikony Heroicons Micro (`icons.ts`); warstwa pływająca bez zależności (Popover API, `popover="manual"`, pozycjonowanie z flip/shift w `floating.ts`): `Popover` (zakotwiczony, Escape / klik poza / wyjście fokusu zamyka, fokus wraca do wyzwalacza, na telefonie opcjonalnie arkusz), `DropdownMenu` + `MenuItem` / `MenuCheckItem` / `MenuGroup` / `MenuSeparator` / `MenuSub` (wzorzec menu button: strzałki, Home/End, typeahead, submenu), `Combobox` (WAI-ARIA combobox: autouzupełnianie albo lista inline w pickerach, gotowy na wyszukiwanie po stronie serwera), `tooltip` (attachment: opóźnienie, od razu przy fokusie z klawiatury, długie przytrzymanie na ekranach dotykowych), `HoverCard` (hover / fokus, stuknięcie na dotyku), `Slider` (dyskretne, podpisane stopnie), `Kbd` + `hotkeys.ts` (`Mod` = ⌘ albo Ctrl), `PillButton` / `PillText` (pigułki kompozytora); `markdown/` renderuje markdown agentów z tokenów `marked` komponentami Svelte (bez `{@html}`, linki tylko http(s)/mailto, obrazy jako linki) |
| `lib/shared/format.ts`, `clock.svelte.ts` | liczby, czasy, JSON; zegar etykiet względnych (tyka co 30 s) |
| `features/navigation` | powłoka w stylu T3 Code: pasek boczny z sekcjami „Threads” i „Bots” (`SectionSwitch`, `sections.svelte.ts`: aktywna sekcja wynika z trasy, Settings zostawia ostatnią; przełączenie wraca do ostatniej strony sekcji zapamiętanej w pamięci karty albo do jej strony głównej; kropka na Threads, gdy jakiś wątek czeka na użytkownika; wyszukiwarka i akcja „nowy” należą do bieżącej sekcji, nowy czat z botem na razie wyłączony z podpowiedzią „Coming soon”); sekcja Threads jako skrzynka wątków (`SidebarThreads`: projekt, status, tytuł, worker; najpierw wątki czekające na użytkownika, potem według `last_activity_at` całego drzewa; „Working 30m”, wiek ostatniej aktywności; wątek boczny z `interaction_route = parent` czekający na agenta to „Asking agent”, nie „Needs input”; wątki boczne otwartego drzewa pod nim, forki i wątki agentów oznaczone), wyszukiwarka, stopka (ustawienia, workery, połączenie), `TopBar` z breadcrumbem, menu mobilne |
| `features/overview` | stan workerów, projektów i wszystkich wątków (kontekst, SSE `api/overview/events`; start i każde ponowne połączenie: `GetOverview` + jedno `ListThreads` z pustym projektem, bo strumień niesie tylko zmiany; `subscribe` przekazuje pozostałe zmiany strumienia — ustawienia, harmonogramy — a `resyncs` mówi, że po przerwie trzeba je pobrać od nowa), karta workera w ustawieniach |
| `features/projects` | nowy projekt, lista wątków projektu (wątki główne z bocznymi) |
| `features/threads` | `ThreadState` (snapshot + zdarzenia, `reduceItem`; komunikaty ze snapshotu, zużycie i czas tur z `ui.Turn`, odziedziczona historia forka osobno od własnych tur, tury startowane przez workera, aktywne i wstrzymane harmonogramy wątku), `timeline.ts` (granice tur, zagnieżdżenie po `parent_item_id`; niezmienione itemy zachowują swoje węzły), `feed.ts` (wiersze strony wątku: nagłówek zwiniętej historii forka, jej części i wiersze, linia „Forked from”, własna oś czasu, „Working…”, kolejka; niezmienione wiersze zachowują tożsamość, więc delta przerysowuje jeden wiersz), `turn-origin.ts` (skąd przyszło wejście tury: użytkownik, zadanie albo wiadomość od agenta, raport, pytanie wątku bocznego, harmonogram twój albo agenta; z `source_kind`, `source_thread_id`, `schedule_id`, `interaction_request_id`, nie z treści; notatka platformy `[open-agents] …` do pierwszej pustej linii jest oddzielona od dostarczonej wiadomości, pełny tekst pod „Full text the agent received”), `TurnInput` (wejście tury z pochodzeniem i `hops`), `FeedRowView` (wiersz osi czasu; odziedziczona historia jako zwinięta „History from …” nad turami forka; przy łańcuchu forków części podpisane wątkiem z `from_thread_id`), widoki itemów (`components/items`), karty interakcji (zgoda, pytania, formularz MCP; przy `routed_to = parent` kto odpowiada), `ComposerBox` (pole wiadomości jak w T3: okrągły przycisk wysyłania / zatrzymania, „pigułki” ustawień), kompozytor wątku z wyborem modelu i wysiłku na dostawcy i profilu wątku (na razie tylko lokalnie: kontrakt nie ma modelu ani wysiłku per wiadomość), worker pod polem z podglądem (`WorkerHoverCard`), menu akcji wątku (wątek boczny, harmonogram, kopiowanie linku / katalogu / ID), `providers.ts` (dostawcy i profile dostępne na workerze), panel kontekstu wątku (worker, agent, kto odpowiada na zgody, zużycie tur, harmonogramy wątku z wstrzymaniem, wznowieniem, anulowaniem i „Schedule a task”, źródło forka, linia wątków; otwarty albo zwinięty według ustawień użytkownika), tworzenie wątków (`server/create-thread.ts`, wspólna akcja; dostawcę i profil sprawdza gateway; wątek boczny bierze projekt, workspace i dostawcę z rodzica przez `GetThread`) |
| `features/models` | `ModelOption` (dostawca, profil, id modelu, nazwa, obsługiwane wysiłki, domyślny wysiłek) — interfejs, którym karmione są pickery; dziś składany z profili workera (`ui.Worker.profiles`), modeli z wątków, modelu z domyślnych per dostawca i aliasów CLI, z zastępczymi wysiłkami per dostawca (katalog modeli z gateway zastąpi `profileModels` i `fallbackEfforts` w `catalog.ts`). `ModelPicker` (jak w T3: szyna Ulubione / dostawcy, wyszukiwarka, lista z profilem i znakiem dostawcy, gwiazdka, ⌘1…⌘9 dla pierwszych ulubionych, Mod+Shift+F gwiazdkuje podświetlony, własny id modelu), `EffortPicker` (jak w ChatGPT: nazwa wysiłku, model otwierający picker, reset, suwak), `ModelControls` (obie pigułki razem), `ModelIdField` (id modelu z podpowiedziami w ustawieniach i dialogu wątku bocznego), `favorites.svelte.ts` (ulubione na razie w pamięci karty, do czasu pola ustawień w gateway) |
| `features/schedules` | harmonogramy: opisy terminów (typowe crony słowami), statusy, `ScheduleRow` (wiadomość, kiedy, następne uruchomienie, liczba uruchomień, wątek, kto ustawił: ty albo agent z linkiem do jego wątku), `ScheduleActions` (wstrzymaj, wznów, anuluj z potwierdzeniem), `ScheduleDialog` (jednorazowo albo cyklicznie: godzinowo, dziennie, w dni robocze, tygodniowo albo własny cron; strefa czasowa, koniec: nigdy, data albo liczba uruchomień; zachowanie po przestoju) |
| `features/bots` | boty (agenci żyjący w gateway, nie na workerach) — na razie bez backendu, tylko komponenty prezentacyjne z lokalnym modelem widoku (`model.ts`: `BotView`, `ParticipantView`, `ConversationView` z `pinned` i `pinOrder`, `ChatMessageView`, `ChatEventView`, `QuestionView`, `LinkView`; bez typów proto, żeby przyszły kontrakt mapował się w jednym miejscu). Awatary-maskotki wyliczane z id bota (`mascot.ts`: kształt, kolor, oczy), `AvatarStack`, przypięte czaty jako duże awatary z gwiazdką na górze sekcji (`PinnedConversations`), wiersze `BotListItem` / `GroupListItem` (przypnij/odepnij, oznacz jako przeczytane: przycisk „…”, prawy klik, Shift+F10, długie przytrzymanie), `ConversationHeader` (bot, grupa, bot ⇄ bot), oś czatu (`chat-timeline.ts`: linie dat, „New” przed pierwszą nieprzeczytaną, serie wiadomości z awatarem przy ostatniej i nazwą nadawcy w grupach), `ChatBubble` (markdown botów przez bezpieczny renderer), `ChatEventLine` (rutyny, wiadomości przekazane od innych botów), `QuestionCard` (opcje A/B…, wybór klawiszem litery), `LinkChip`, `MessageActions`, `BotComposer` (załączniki i mikrofon jako „coming soon”), `WatchBar` (czytanie rozmowy dwóch botów, „Close chat”). `Menu` i `Tooltip` to lokalne zastępstwa do podmiany na zestaw komponentów. Przypięcia będą ustawieniem użytkownika w gateway (nie `localStorage`). W produkcji sekcja Bots pokazuje tylko uczciwy pusty stan (`BotsSectionEmpty`) |
| `features/settings`, `features/workspaces` | ustawienia jako panel modalny nad aplikacją (nawigacja z wyszukiwarką, Escape wraca na poprzednią stronę), podgląd schematów kolorów; wybór katalogu na workerze (`api/workers/[id]/directory`), dodawanie workspace'ów |
| `features/settings/settings-state.svelte.ts` | `SettingsState`: ustawienia z gateway (przeglądarka nic nie zapisuje lokalnie). Ziarno z loadu serwera, zmiany z innych urządzeń przez `OverviewUpdate.user_settings` / `project_settings` (nowsza wersja zastępuje), po przerwie w strumieniu `GET api/settings`. Zapis zastępuje jedną sekcję i podaje `expected_version`; zapisy idą po kolei, zmianę widać od razu i jest nakładana na stan gateway w chwili wysłania. 409: pobranie ustawień, ponowne nałożenie zmiany (raz) i komunikat, jeśli ta sekcja zmieniła się gdzie indziej; inny błąd: komunikat i stan z gateway |
| `features/settings/appearance.ts`, `thread-defaults.ts`, `ThreadDefaultsFields` | enumy wyglądu ↔ atrybuty `<html>`; domyślne wartości nowego wątku: projekt nad użytkownikiem (agent — dostawca, profil, model — jako całość, workspace i uprawnienia osobno); wspólne pola dla Settings → Threads i ustawień projektu („Use my default”) |

Trasy:
- strony: `/` (nowy wątek: „What should we work on?”; model z pickera — Claude albo Codex na profilu dostępnym na workerze wybranego workspace'u — i wysiłek rozumowania jako pigułki, wysiłek idzie w formularzu jako `reasoningEffort`, ale gateway go jeszcze nie przyjmuje; workspace i uprawnienia jako menu; startowe wartości z domyślnych projektu nad domyślnymi użytkownika, ręczny wybór wygrywa; `?project=` wybiera projekt i jego domyślny workspace), `/threads/[id]` (wątek z `GetThread` przed strumieniem, 404 dla nieznanego; przy pełnym załadowaniu też koniec osi czasu; oś czasu na żywo, panel kontekstu z linią wątków i nowym wątkiem bocznym z opcjonalnym forkiem; akcja `?/createSideThread`), `/settings/appearance` (schemat kolorów, motywy, szerokość czatu), `/settings/threads` (domyślne wartości nowych wątków), `/settings/schedules` („Scheduled tasks”: wszystkie harmonogramy, nadchodzące i zakończone, na żywo; nowy, wstrzymanie, wznowienie, anulowanie), `/settings/projects` (lista, nowy projekt), `/settings/projects/[id]` (workspace'y, domyślne wartości wątków projektu, wątki), `/settings/workers`, `/bots` (strona główna sekcji Bots: czym będą boty, bez wymyślonych danych), `/bots/[id]` (na razie zawsze 404), `/dev/bots` (galeria komponentów botów z danymi testowymi tylko w trybie deweloperskim: import chroniony `import.meta.env.DEV`, więc build produkcyjny nie zawiera galerii ani danych, a trasa odpowiada 404); stare `/projects/[id]` przekierowuje do ustawień,
- API (JSON): `GET api/overview`, `GET api/threads` (wszystkie wątki użytkownika), `POST api/threads/[id]/messages` (`{text, clientRequestId}`), `POST .../interrupt`, `POST api/interactions/[id]` (`{allow}` albo odpowiedzi), `GET api/workers/[id]/directory?path=`, `GET api/settings`, `PUT api/settings/user` (`UpdateUserSettingsRequest`), `PUT api/settings/projects/[id]` (`UpdateProjectSettingsRequest`; konflikt wersji → 409), `GET api/schedules?threadId=&projectId=&includeFinished=true`, `POST api/schedules` (`CreateScheduleRequest`), `POST api/schedules/[id]/status` (`{status: active | paused | cancelled}`),
- SSE: `api/overview/events`, `api/threads/[id]/events`. Po zerwaniu `EventSource` łączy się ponownie, a serwer zaczyna od świeżego snapshotu, więc stan klienta nie wymaga uzgadniania.

Strona wątku przewija się w jednym kontenerze (`VirtualFeed`): oś czasu jako `role="feed"` (artykuły z `aria-posinset` / `aria-setsize`) i kompozytor (z kartami oczekujących interakcji) przyklejony do dołu kolumny czatu (`position: sticky`, szerokość jak czat, łagodne wygaszenie nad nim, „Jump to latest” nad kompozytorem). Montowane są tylko wiersze blisko widoku; wysokości mierzy `ResizeObserver`. Czytelnik na dole zostaje na dole (nowe wiersze, strumień, wyższy kompozytor, klawiatura ekranowa); po przewinięciu w górę pierwszy widoczny wiersz trzyma miejsce na ekranie, gdy wiersze nad nim zmieniają wysokość albo dochodzą (także wstawione na początku). Klawiatura: obszar przewijania jest fokusowalny (Page Up/Down, Home/End), w wierszu Page Up/Down przechodzi do poprzedniego/następnego (wzorzec feed), Ctrl+End do kompozytora. Przy pełnym załadowaniu strony serwer renderuje koniec wątku (pierwszy komunikat `WatchThread`, ostatnie 60 itemów, `server/snapshot.ts`), a skrypt inline przewija na dół przed pierwszym malowaniem. `/dev/long-thread` (tylko serwer deweloperski): syntetyczny długi wątek i pomiar montowania, strumienia i przewijania.

Stany: brak gateway (powłoka renderuje się dalej, baner i ponawianie), ponowne łączenie SSE, worker offline (wątek i wiadomości czekają), wątek w tworzeniu lub nieudany, ładowanie (szkielety), puste listy. Układ od telefonu (skrzynka wątków w szufladzie, panel kontekstu jako arkusz) do desktopu (pasek boczny, czat pośrodku, panel z prawej).

Bezpieczeństwo:
- przeglądarka nie zna adresu gateway ani tokenu,
- formularze chroni kontrola `Origin` SvelteKit (CSRF), a endpointy JSON wymagają `content-type: application/json` (formularz z innej strony go nie ustawi),
- workspace musi leżeć w dozwolonych katalogach workera: gateway sprawdza to leksykalnie przy tworzeniu (według systemu workera), worker ścieżki rzeczywiste przy starcie wątku ([threads.md](threads.md#projekt-na-wielu-workerach-i-systemach)).

Projekt może mieć workspace'y na wielu workerach: strona projektu grupuje je według workera (system, online), lista wątków i nagłówek wątku pokazują workera, a wybór katalogu buduje ścieżki separatorem systemu workera. Dla workera offline UI informuje, że wątek i wiadomości poczekają na jego połączenie.

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

`adapter-node` przyjmuje `https`, jeśli nie zna protokołu. Za reverse proxy ustawić `PROTOCOL_HEADER=x-forwarded-proto` (i `HOST_HEADER`, jeśli proxy zmienia host). Inaczej kontrola `Origin` odrzuci formularze. Build nie potrzebuje sekretów.

## 6. Ograniczenia na teraz

- **Jeden użytkownik deweloperski** (`OA_DEV_USER_EMAIL`). Logowanie powstanie w SvelteKit (sesja w cookie `HttpOnly`), a tożsamość użytkownika trafi do gateway w metadanych wywołania z tokenem usługi.
- **Jedna instancja gateway** (`Hub` w procesie).
- Brak ekranów administracji workerami: na razie CLI.
