# Canopy

Platforma do zarządzania agentami AI dla wielu użytkowników. W kodzie (pakiety `@open-agents/*`, zmienne `OA_*`, pakiet proto `openagents`) zostaje robocza nazwa „open-agents”.

- **Gateway** — centralny serwer (Bun + TypeScript). Jedyny punkt kontaktu UI z agentami. Uruchamia też agentów czatowych.
- **Worker** — usługa instalowana na edge device (Linux, macOS, Windows). Uruchamia agentów przez Claude Agent SDK i Codex app-server w wielu katalogach. Opcjonalnie przez [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).
- **PostgreSQL** — baza danych.
- Komunikacja gateway ↔ worker: gRPC, strumień dwukierunkowy po HTTP/2, inicjowany przez workera.

Status: system działa end to end z Codexem i Claude: frontend (SvelteKit jako BFF, SSE), gateway (PostgreSQL, orkiestracja, API dla UI), worker (dziennik, zdalna konfiguracja, Codex app-server z izolowanym `CODEX_HOME`, Claude Agent SDK z izolowanym `CLAUDE_CONFIG_DIR`, zgody), szyna agentów (wątki boczne tworzone przez agentów, wiadomości, powiadomienia, pytania do rodzica, harmonogram platformy), cele harnessów (Codex goals, Claude `/goal`) śledzone i sterowane z UI, praca w tle (procesy Codexa, background Bash Claude) widoczna i zatrzymywana z UI. W budowie: logowanie użytkowników.

## Struktura

Monorepo na Bun workspaces. Aplikacje wdraża się osobno, pakiety są współdzielone.

```text
apps/
  gateway/        serwer centralny: WorkerLinkService i GatewayService (gRPC), orkiestracja, PostgreSQL; docelowo chat runtime, agent bus
  worker/         usługa na edge device: klient WorkerLinkService, dziennik, zdalna konfiguracja, adaptery Codex (app-server) i Claude (Agent SDK)
  web/            frontend SvelteKit (BFF): strony i API po HTTP/1.1, SSE do przeglądarki, gRPC do gateway
  mobile/         Canopy iOS/Android (Expo development build): Connect, streaming fetch, parowanie urządzeń
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
bun run check        # gen:check + typecheck + test (przez check:tmp)
bun run check:tmp    # bun test z prywatnym TMPDIR; błąd, gdy testy zostawią tam katalog oa-* / open-agents-*
```

Katalogi tymczasowe testów tylko przez `tempDir(prefix)` / `tempDirs()` z `@open-agents/testing`: usuwane po zakresie (plik, describe), resztę (pominięty describe, przerwany przebieg) usuwa preload z `bunfig.toml` na końcu przebiegu albo obsługa sygnału. `/tmp` to tmpfs z ograniczoną liczbą i-węzłów, wspólny dla wszystkich przebiegów na maszynie.

Ręczne uruchomienie (PostgreSQL, gateway, rejestracja i uruchomienie workera, frontend): [ui-api.md](docs/ui-api.md#5-uruchomienie-development). Worker ma lokalnie tylko połączenie z gateway; całą resztę konfiguracji dostaje z gateway ([worker-config.md](docs/worker-config.md)).

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
- [Cele (goals): cele harnessów śledzone przez platformę](docs/goals.md)
- [Adapter Codex (app-server)](docs/codex-adapter.md)
- [API dla UI i architektura frontendu (SvelteKit BFF)](docs/ui-api.md)
- [Canopy mobile: development build, parowanie i Tailscale](docs/mobile.md)
- [Adapter Claude (Agent SDK)](docs/claude-adapter.md)
- [Model danych](docs/data-model.md)
- [Trwałość i aktualizacje w trakcie działania](docs/durability.md)
- [Wyniki spike'a gRPC po HTTP/2 w Bun](docs/spikes/grpc-http2-bun.md)
- [Kontrakt gRPC](proto/openagents/worker/v1/worker_link.proto)
