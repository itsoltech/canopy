# Open Agents

Platforma do zarządzania agentami AI dla wielu użytkowników.

- **Gateway** — centralny serwer (Bun + TypeScript). Jedyny punkt kontaktu UI z agentami. Uruchamia też agentów czatowych.
- **Worker** — usługa instalowana na edge device (Linux, macOS, Windows). Uruchamia agentów przez Claude Agent SDK i Codex app-server w wielu katalogach. Opcjonalnie przez [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).
- **PostgreSQL** — baza danych.
- Komunikacja gateway ↔ worker: gRPC, strumień dwukierunkowy po HTTP/2, inicjowany przez workera.

Status: backend działa end to end z Codexem: gateway (PostgreSQL, orkiestracja, API dla UI), worker (dziennik, zdalna konfiguracja, Codex app-server z izolowanym `CODEX_HOME`, zgody), model domenowy (wątki, transkrypt, szyna agentów, harmonogram, cele). W budowie: frontend (SvelteKit), adapter Claude, szyna agentów i cele w runtime.

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
  codex-protocol/ typy protokołu `codex app-server` generowane z przypiętej wersji Codexa
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

Ręczne uruchomienie (PostgreSQL, gateway, rejestracja i uruchomienie workera, klient BFF do testów): [ui-api.md](docs/ui-api.md#4-uruchomienie-development). Worker ma lokalnie tylko połączenie z gateway; całą resztę konfiguracji dostaje z gateway ([worker-config.md](docs/worker-config.md)).

- TLS: gateway `OA_TLS_CERT` / `OA_TLS_KEY`; worker `ca_file` w pliku lokalnym (certyfikat spoza systemowych CA).
- CLIProxyAPI (opcjonalnie): `cli.ts worker add --cliproxy-url …` z kluczem w zmiennej środowiskowej; klucz trafia zaszyfrowany do bazy i do workera jako profil `cliproxyapi`.

Testy na żywo z prawdziwymi modelami są opt-in (zużywają limity kont): `OA_LIVE=1 bun test …live.test.ts`, szczegóły w [codex-adapter.md](docs/codex-adapter.md#testy-na-żywo).

## Dokumentacja

- [Architektura i przepływy danych](docs/architecture.md)
- [Protokół gateway ↔ worker](docs/protocol.md)
- [Konfiguracja workerów (zdalna)](docs/worker-config.md)
- [Projekty, wątki i wątki boczne](docs/threads.md)
- [Transkrypt: zapis wszystkiego dla frontendu](docs/transcript.md)
- [Wykonanie: tury, praca w tle, subagenci, interakcje](docs/execution.md)
- [Szyna agentów: delegowanie, interakcje, harmonogram](docs/agent-bus.md)
- [Cele (goals)](docs/goals.md)
- [Adapter Codex (app-server)](docs/codex-adapter.md)
- [API dla UI i architektura frontendu (SvelteKit BFF)](docs/ui-api.md)
- [Model danych](docs/data-model.md)
- [Trwałość i aktualizacje w trakcie działania](docs/durability.md)
- [Wyniki spike'a gRPC po HTTP/2 w Bun](docs/spikes/grpc-http2-bun.md)
- [Kontrakt gRPC](proto/openagents/worker/v1/worker_link.proto)
