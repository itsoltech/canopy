# API dla UI i architektura frontendu

Status: **backend zaimplementowany**:
- kontrakt: `proto/openagents/ui/v1/gateway.proto`,
- rdzeń: `apps/gateway/src/core`,
- dane: `apps/gateway/src/store`,
- serwis: `apps/gateway/src/api`.

Frontend (SvelteKit) jest w budowie.

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
| `ListThreads`, `CreateThread` | wątki projektu; nowy wątek (główny albo boczny, opcjonalnie fork) z opcjonalną pierwszą wiadomością |
| `SendMessage` | nowa tura; idempotentne po `client_request_id` |
| `InterruptThread` | przerwanie tury w toku |
| `AnswerInteraction` | odpowiedź na zgodę albo pytanie |
| `WatchThread` | najpierw snapshot (wątek, tury, itemy, oczekujące interakcje, `last_seq`), potem zmiany na żywo: zdarzenia (`seq` + `ThreadEvent`), wątek, tura, interakcja |

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

## 4. Uruchomienie (development)

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
```

## 5. Ograniczenia na teraz

- **Jeden użytkownik deweloperski** (`OA_DEV_USER_EMAIL`). Logowanie powstanie w SvelteKit (sesja w cookie `HttpOnly`), a tożsamość użytkownika trafi do gateway w metadanych wywołania z tokenem usługi.
- **Jedna instancja gateway** (`Hub` w procesie).
- Brak ekranów administracji workerami: na razie CLI.
