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
| `ListThreads`, `GetThread`, `CreateThread` | wątki projektu (pusty projekt = wszystkie wątki użytkownika); jeden wątek; nowy wątek (główny albo boczny, opcjonalnie fork) z opcjonalną pierwszą wiadomością. Gateway sprawdza według ostatniego raportu workera, że dostawca jest dostępny, a profil istnieje, jest dostępny i obsługuje tego dostawcę; fork zachowuje dostawcę rodzica |
| `SendMessage` | nowa tura; idempotentne po `client_request_id` |
| `InterruptThread` | przerwanie tury w toku |
| `AnswerInteraction` | odpowiedź na zgodę albo pytanie |
| `WatchThread` | najpierw snapshot (wątek, tury ze zużyciem tokenów, itemy, oczekujące interakcje, ostatnie komunikaty, `last_seq`), potem zmiany na żywo: zdarzenia (`seq` + `ThreadEvent`), wątek, tura, interakcja. Snapshot forka zawiera odziedziczoną historię: tury i itemy wątku źródłowego do punktu forka z `inherited = true` i `from_thread_id`. Tura ma swoje źródło (`source_kind`: task, message, report, question, schedule; `source_thread_id`, `schedule_id`, `interaction_request_id`), odczytane z relacji w bazie (widok `turn_sources`), nie z treści |
| `ListSchedules`, `CreateSchedule`, `SetScheduleStatus` | harmonogram platformy: lista (wątek, projekt albo wszystkie; z autorem: użytkownik albo agent i jego wątek), nowy harmonogram użytkownika (jednorazowy `run_at` albo `cron` ze strefą czasową; może być bez końca), wstrzymanie, wznowienie, anulowanie. Zmiany na żywo w `ThreadUpdate.schedule` i `OverviewUpdate.schedule`, a snapshot wątku zawiera jego aktywne i wstrzymane harmonogramy |
| `GetSettings`, `UpdateUserSettings`, `UpdateProjectSettings` | ustawienia użytkownika (wygląd: schemat kolorów, akcent, szerokość czatu, panel wątku; domyślne wartości nowych wątków) i projektu (domyślne wartości wątków, nadpisują użytkownika). Przechowuje je gateway (`user_settings`, `project_settings`); przeglądarka jest tylko klientem. Zapis zastępuje podane sekcje i podaje wersję, od której zaczął: konflikt z innym urządzeniem = `FailedPrecondition` (BFF: 409), klient pobiera ustawienia od nowa. Zmiany na żywo w `OverviewUpdate.user_settings` / `project_settings` |

UI składa itemy na żywo tym samym reducerem co gateway (`reduceItem` z `@open-agents/domain`).

## 3. Rdzeń gateway (`GatewayCore`)

- **Workery:**
  - przy połączeniu zapisuje stan i ponownie dostarcza outbox,
  - zdarzenia przechodzą przez `Ingest` (jedna transakcja na wątek), a potwierdzenie (`EventAck`) idzie po commicie,
  - zapisuje raport konfiguracji,
  - interakcje zapisuje i rozsyła, a ponownie wysłane i już rozstrzygnięte dostają zapisaną odpowiedź.
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
| `src/hooks.server.ts` | `init`: serwer nie wystartuje bez tokenu usługi |
| `lib/server/gateway.ts` | klient gRPC z tokenem; `call` (błędy gateway → HTTP: 400, 404, 409, 503, reszta 502), `attempt` dla akcji formularzy (4xx → `fail`, komunikat przy formularzu) |
| `lib/server/sse.ts`, `body.ts` | strumień gRPC → SSE (heartbeat co 15 s, ramka `failure`); ścisłe dekodowanie JSON (nadmiarowe pola → 400) |
| `lib/shared/wire.ts` | JSON protobuf (`toJson` / `fromJson`) między serwerem a przeglądarką: te same schematy po obu stronach |
| `lib/shared/ui` | prymitywy UI: `Button`, `ButtonLink`, `IconButton`, `Field` + `Input` / `Select` / `Textarea` / `Checkbox`, `Badge`, `StatusBadge`, `StatusDot`, `ProjectAvatar`, `Alert`, `EmptyState`, `Dialog`, `Drawer`, `Disclosure`, `CodeBlock`, `Skeleton`, `SettingsGroup` + `SettingsRow`; ikony Heroicons Micro (`icons.ts`); `markdown/` renderuje markdown agentów z tokenów `marked` komponentami Svelte (bez `{@html}`, linki tylko http(s)/mailto, obrazy jako linki) |
| `lib/shared/preferences.svelte.ts`, `format.ts`, `clock.svelte.ts` | wygląd zapisany w przeglądarce: schemat (system / jasny / ciemny), motyw akcentu (`--brand-*`, klasy `brand-*`), szerokość czatu (`--chat-width`); `app.html` stosuje je przed pierwszym renderem; liczby, czasy, JSON; zegar etykiet względnych (tyka co 30 s) |
| `features/navigation` | powłoka w stylu T3 Code: pasek boczny jako skrzynka wątków (projekt, status, tytuł, worker; najpierw wątki czekające na użytkownika, potem według `last_activity_at` całego drzewa; „Working 30m”, wiek ostatniej aktywności; wątek boczny z `interaction_route = parent` czekający na agenta to „Asking agent”, nie „Needs input”; wątki boczne otwartego drzewa pod nim, forki i wątki agentów oznaczone), wyszukiwarka, stopka (ustawienia, workery, połączenie), `TopBar` z breadcrumbem, menu mobilne |
| `features/overview` | stan workerów, projektów i wszystkich wątków (kontekst, SSE `api/overview/events`; start i każde ponowne połączenie: `GetOverview` + jedno `ListThreads` z pustym projektem, bo strumień niesie tylko zmiany), karta workera w ustawieniach |
| `features/projects` | nowy projekt, lista wątków projektu (wątki główne z bocznymi) |
| `features/threads` | `ThreadState` (snapshot + zdarzenia, `reduceItem`; komunikaty ze snapshotu, zużycie i czas tur z `ui.Turn`, odziedziczona historia forka osobno od własnych tur, tury startowane przez workera), `timeline.ts` (granice tur, zagnieżdżenie po `parent_item_id`), `turn-origin.ts` (skąd przyszło wejście tury: użytkownik, zadanie albo wiadomość od agenta, raport wątku bocznego, pytanie wątku bocznego, harmonogram; z `trigger` i koperty `[open-agents]` gateway), `TurnInput` (wejście tury z pochodzeniem i `hops`), `InheritedHistory` (zwinięta „History from …” nad turami forka), widoki itemów (`components/items`), karty interakcji (zgoda, pytania, formularz MCP; przy `routed_to = parent` kto odpowiada), `ComposerBox` (pole wiadomości jak w T3: okrągły przycisk wysyłania / zatrzymania, „pigułki” ustawień, `ModelPill`), `providers.ts` (dostawcy i profile dostępne na workerze), panel kontekstu wątku (worker, agent, kto odpowiada na zgody, zużycie tur, źródło forka, linia wątków), tworzenie wątków (`server/create-thread.ts`, wspólna akcja: sprawdza dostawcę i profil na workerze; wątek boczny bierze projekt, workspace i dostawcę z rodzica przez `GetThread`) |
| `features/settings`, `features/workspaces` | ustawienia jako panel modalny nad aplikacją (nawigacja z wyszukiwarką, Escape wraca na poprzednią stronę), podgląd schematów kolorów; wybór katalogu na workerze (`api/workers/[id]/directory`), dodawanie workspace'ów |
| `features/threads/thread-defaults.svelte.ts` | domyślne wartości nowego wątku (workspace, dostawca, profil, model per dostawca, uprawnienia), zapisane w przeglądarce |

Trasy:
- strony: `/` (nowy wątek: „What should we work on?”; agent jako pigułka: Claude albo Codex z profilem, tylko pary dostępne na workerze wybranego workspace'u; model per dostawca; workspace i uprawnienia; `?project=` wybiera projekt), `/threads/[id]` (wątek z `GetThread` przed strumieniem, 404 dla nieznanego; oś czasu na żywo, panel kontekstu z linią wątków i nowym wątkiem bocznym z opcjonalnym forkiem; akcja `?/createSideThread`), `/settings/appearance` (schemat kolorów, motywy, szerokość czatu), `/settings/threads` (domyślne wartości nowych wątków), `/settings/projects` (lista, nowy projekt), `/settings/projects/[id]` (workspace'y, wątki), `/settings/workers`; stare `/projects/[id]` przekierowuje do ustawień,
- API (JSON): `GET api/overview`, `GET api/threads` (wszystkie wątki użytkownika), `POST api/threads/[id]/messages` (`{text, clientRequestId}`), `POST .../interrupt`, `POST api/interactions/[id]` (`{allow}` albo odpowiedzi), `GET api/workers/[id]/directory?path=`,
- SSE: `api/overview/events`, `api/threads/[id]/events`. Po zerwaniu `EventSource` łączy się ponownie, a serwer zaczyna od świeżego snapshotu, więc stan klienta nie wymaga uzgadniania.

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
