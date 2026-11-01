# Adapter Codex (app-server)

Status: **w budowie**.

Gotowe:
- typy protokołu z przypiętej wersji: `packages/codex-protocol` (Codex 0.164.0),
- klient JSON-RPC: `apps/worker/src/providers/codex/rpc.ts`,
- serwis procesu: `CodexAppServer` w `app-server.ts`,
- mapowanie powiadomień na zdarzenia transkryptu: `CodexEventMapper` w `mapping.ts`,
- testy na żywo: `app-server.live.test.ts`.

Następne: komendy wątków (create, fork, resume, turn, interrupt, steer), zgody i pytania, narzędzia szyny (`dynamicTools`), nakładka celów, praca w tle (procesy unified exec).

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
| `thread/goal/updated` / `cleared` | `goal_state` |
| hooki, `readState`, metadane moderacji, diff tury, ... | zdarzenie bez ciała, tylko `raw_json` |

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

Opt-in, bo zużywają limity kont: `OA_LIVE=1 bun test apps/worker/src/providers/codex/app-server.live.test.ts`.

- `OA_LIVE_CLIPROXYAPI_URL`, `OA_LIVE_CLIPROXYAPI_KEY`: tura przez profil CLIProxyAPI platformy. Lokalnie trzymane w pliku poza repozytorium (`~/.config/open-agents/dev-live.env`, `0600`).
- `OA_LIVE_NATIVE=1`: tura z konfiguracją Codexa właściciela urządzenia (wymaga, żeby działała bez interakcji).
- Nagrania strumieni: `OA_LIVE_RECORD_DIR` (domyślnie `/tmp/oa-codex-recordings`), materiał do mapowania zdarzeń.

Potwierdzone na żywo (2026-11-01):
- handshake, wątki i nakładka celów (bez modelu),
- **profil CLIProxyAPI z autoryzacją przez `env_key`** (`Authorization: Bearer`), czyli punkt otwarty od początku,
- **izolowany `CODEX_HOME`**: bez hooków, serwerów MCP i wtyczek urządzenia.

## Izolacja od konfiguracji właściciela urządzenia

Bez `CODEX_HOME` app-server czyta `~/.codex` właściciela urządzenia: jego provider, model, serwery MCP, wtyczki i hooki działają także w wątkach platformy. Zmierzone na tej samej turze „OK”:

| | Tokeny wejściowe | Hooki / MCP urządzenia |
|---|---|---|
| `~/.codex` właściciela | 18 693 | tak (`sessionStart` z wtyczki, 2 serwery MCP) |
| izolowany `CODEX_HOME` | 11 744 | nie |

Profil natywny z `~/.codex` zależy też od środowiska właściciela. W teście tura padła na `Missing environment variable: CLIPROXY_API_KEY`, bo jego provider czyta klucz ze zmiennej, której worker nie ma.

### Ustalenia (2026-11-01)

1. **Worker zawsze uruchamia app-server z własnym `CODEX_HOME`** (`<data_dir>/codex-home`, `0700`, `prepareCodexHome`). Konfiguracja (dostawcy, MCP, instrukcje) przychodzi z platformy.
2. **Logowanie właściciela urządzenia jest dowiązywane** (`~/.codex/auth.json` → `codex-home/auth.json`; token odświeża się wspólnie z CLI). Wyjątek: workery korzystające z CLIProxyAPI, gdzie gateway ustawia `WorkerConfig.codex.device_login = NONE` i dowiązanie jest usuwane. Bez uprawnień do dowiązań (Windows) plik jest kopiowany, a raport to zgłasza.
3. **Konektory konta są wyłączone** (`features.apps=false`). Po zalogowaniu kontem ChatGPT Codex uruchamia wbudowany serwer MCP `codex_apps` z aplikacjami połączonymi z kontem właściciela. W wątkach platformy byłby to dostęp do jego prywatnych kont. Można je świadomie włączyć (`NativeToolsConfig.connectors`).

Potwierdzone na żywo: profil natywny w izolowanym `CODEX_HOME` z dowiązanym logowaniem odpowiada poprawnie, bez hooków, serwerów MCP i aplikacji urządzenia.
