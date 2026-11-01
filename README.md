# Open Agents

Platforma do zarządzania agentami AI dla wielu użytkowników.

- **Gateway** — centralny serwer (Bun + TypeScript). Jedyny punkt kontaktu UI z agentami. Uruchamia też agentów czatowych.
- **Worker** — usługa instalowana na edge device (Linux, macOS, Windows). Uruchamia agentów przez Claude Agent SDK i Codex app-server w wielu katalogach. Opcjonalnie przez [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).
- **PostgreSQL** — baza danych.
- Komunikacja gateway ↔ worker: gRPC, strumień dwukierunkowy po HTTP/2, inicjowany przez workera.

Status: szkielet monorepo, kanał gateway ↔ worker (gRPC po HTTP/2) z drain, profile dostawców (CLIProxyAPI) i schemat bazy (projekty, wątki, wątki boczne, forki) z testami. Brak UI i adapterów SDK.

## Struktura

Monorepo na Bun workspaces. Aplikacje wdraża się osobno, pakiety są współdzielone.

```text
apps/
  gateway/        serwer centralny: WorkerLinkService (gRPC), docelowo API, chat runtime, agent bus
  worker/         usługa na edge device: klient WorkerLinkService, pętla reconnect, profile dostawców, docelowo adaptery Claude/Codex
packages/
  contracts/      kontrakt generowany z /proto (protoc-gen-es) — jedyne źródło typów protokołu
  transport/      serwer i klient HTTP/2 (Connect/gRPC), AsyncChannel
  db/             schemat PostgreSQL (migracje SQL), migrator (Effect, @effect/sql-pg)
  domain/         logika domenowa współdzielona przez gateway, worker i UI (projekcja itemów, narzędzia i reguły szyny agentów)
tests/
  integration/    testy gateway ↔ worker (Bun ↔ Bun) i interop z @grpc/grpc-js na Node
proto/            źródłowe pliki .proto
docs/             architektura, protokół, model danych
```

Zasady:

- `apps/*` zależą od `packages/*`, nigdy od siebie nawzajem. Testy przekrojowe są w `tests/`.
- Typy protokołu pochodzą wyłącznie z `@open-agents/contracts`. Kod w `src/gen` jest generowany i commitowany. CI sprawdza, czy jest aktualny (`bun run gen:check`).
- TypeScript w trybie strict (`tsconfig.base.json`): m.in. `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.

## Praca lokalna

Wymagania: [mise](https://mise.jdx.dev) (przypina Bun 1.4.4 z `mise.toml`), `openssl` i `node` (testy TLS i interop), Docker (testy schematu na PostgreSQL 17; bez Dockera są pomijane).

```bash
bun install
bun run gen          # proto -> packages/contracts/src/gen
bun run typecheck    # wszystkie workspace'y
bun test             # testy jednostkowe i integracyjne
bun run check        # gen:check + typecheck + test
```

Ręczne uruchomienie (tymczasowe tokeny workerów do czasu enrollmentu i bazy):

```bash
OA_PORT=7443 OA_WORKER_TOKENS="t1=worker-1" bun apps/gateway/src/main.ts
OA_GATEWAY_URL=http://127.0.0.1:7443 OA_WORKER_ID=worker-1 OA_WORKER_CREDENTIAL=t1 bun apps/worker/src/main.ts
```

TLS: gateway `OA_TLS_CERT` / `OA_TLS_KEY`, worker `OA_GATEWAY_CA` (dla certyfikatu spoza systemowych CA).

CLIProxyAPI (opcjonalnie, worker): `OA_CLIPROXYAPI_URL=http://127.0.0.1:8317` i `OA_CLIPROXYAPI_API_KEY` (klucz z `api-keys` w configu CLIProxyAPI). Worker ogłasza wtedy profil `cliproxyapi`.

## Dokumentacja

- [Architektura i przepływy danych](docs/architecture.md)
- [Protokół gateway ↔ worker](docs/protocol.md)
- [Projekty, wątki i wątki boczne](docs/threads.md)
- [Transkrypt: zapis wszystkiego dla frontendu](docs/transcript.md)
- [Wykonanie: tury, praca w tle, subagenci, interakcje](docs/execution.md)
- [Szyna agentów: delegowanie, interakcje, harmonogram](docs/agent-bus.md)
- [Cele (goals)](docs/goals.md)
- [Model danych](docs/data-model.md)
- [Trwałość i aktualizacje w trakcie działania](docs/durability.md)
- [Wyniki spike'a gRPC po HTTP/2 w Bun](docs/spikes/grpc-http2-bun.md)
- [Kontrakt gRPC](proto/openagents/worker/v1/worker_link.proto)
