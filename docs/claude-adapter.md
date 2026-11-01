# Adapter Claude (Agent SDK)

Status: **działa** (2026-11-01):
- runtime wątków: `ClaudeThreads` w `apps/worker/src/providers/claude/threads.ts`,
- mapowanie wiadomości SDK na zdarzenia transkryptu: `ClaudeEventMapper` w `mapping.ts`, z testami na nagranych strumieniach (`fixtures/*.jsonl`),
- tryby uprawnień: `permissions.ts`,
- narzędzia szyny agentów: serwer MCP w procesie workera (`bus.ts`),
- izolowany katalog konfiguracji: `home.ts` (`CLAUDE_CONFIG_DIR`),
- profil CLIProxyAPI przez zmienne środowiskowe: `profile.ts`,
- podpięcie do workera: `WorkerHost` (obok Codexa, wybór po `ThreadSpec.provider`).

Potwierdzone na żywo (`tests/integration/worker-claude.live.test.ts`, Claude przez CLIProxyAPI): gateway konfiguruje workera, wątek w trybie `ASK`, zgody na zapis i komendę idą przez gateway, plik powstaje; druga tura wznawia sesję; wywołanie narzędzia szyny (`list_threads`) wraca z gateway i jest powiązane z `tool_use`; fork po pierwszej turze dostaje własną sesję i zna historię; natywni subagenci i harmonogramy są wyłączone.

## Model

| Platforma | Claude |
|---|---|
| wątek | sesja Claude Code |
| `provider_thread_id` | id sesji: przy nowym wątku = id wątku platformy (`sessionId`), przy forku nowe id z `forkSession` |
| tura | jedno `query()`: pierwsza tura z `sessionId`, kolejne z `resume` |
| `provider_turn_ref` | uuid ostatniego wpisu tury w transkrypcie Claude (punkt forka, `upToMessageId`) |
| przerwanie | `query.interrupt()`, po 10 s bez odpowiedzi `abort` |

- **`thread_ready` bez wywołania modelu:** id sesji wybiera platforma, a fork kopiuje transkrypt (`forkSession`) bez modelu. Tak jak w Codexie wątek jest gotowy od razu.
- **Koniec tury:** wiadomość `result`. Adapter zwalnia wątek przed zapisaniem `turn_finished`, żeby gateway mógł od razu zacząć kolejną turę, i kończy iterację (proces Claude Code się zamyka, sesja jest już zapisana).
- **Ponownie dostarczony `StartTurn`** z tym samym `turn_id` nie zaczyna drugiej tury.

## Mapowanie

| Claude | Zdarzenie platformy |
|---|---|
| start tury (adapter) | `turn_started` + item `user_message` z treścią wejścia |
| `stream_event` `content_block_start/delta` (text, thinking) | `item_started` + `item_delta` (item `<message id>:<index>`) |
| `assistant` text / thinking | `item_completed` (`agent_message` / `reasoning`); pusty, zredagowany thinking nie tworzy itemu |
| `assistant` `tool_use` | `item_started`: `Bash` → `command_execution`, `Write`/`Edit`/`MultiEdit`/`NotebookEdit` → `file_change`, `WebSearch` → `web_search`, `TodoWrite` → `todo_list`, `mcp__openagents__*` → `agent_bus_call`, inne → `tool_call` |
| `user` `tool_result` | `item_completed` tego narzędzia z wynikiem (`is_error` → `failed`) |
| `result` | `turn_finished` (wynik, przyczyna, zużycie tokenów i koszt) |
| `system` `api_retry` | `notice` (warning) |

Pełne wiadomości nigdy nie giną: bez mapowania trafiają do dziennika jako `raw_json` bez ciała. Zdarzenia strumienia, które tylko odtwarzają pełne wiadomości (częściowy JSON wejścia narzędzi, podpisy, granice wiadomości), nie są zapisywane.

## Uprawnienia

| Tryb | Claude | Pytania |
|---|---|---|
| `ASK` | `default` | każda edycja i komenda przez `canUseTool` do platformy |
| `ACCEPT_EDITS` | `acceptEdits` | edycje w workspace przechodzą, reszta pyta |
| `READ_ONLY` | `dontAsk` | nic nie pyta; to, co wymaga zgody (edycje, shell), jest odrzucane |
| `FULL_AUTO` | `acceptEdits` + sandbox dla Bash | nic nie pyta; komendy w sandboxie systemu (zapis tylko w workspace), bez sandboxa komenda nie ruszy (`failIfUnavailable`) |

- `FULL_AUTO` nigdy nie oznacza `bypassPermissions`.
- `AskUserQuestion` zawsze trafia do platformy jako pytanie (`QUESTION`), odpowiedź wraca jako `answers`.
- Różnica względem Codexa: w `READ_ONLY` Codex może uruchamiać komendy w sandboxie tylko do odczytu, Claude nie uruchamia shella.

## Szyna agentów

- Serwer MCP `openagents` w procesie workera (`createSdkMcpServer`), narzędzia `mcp__openagents__<nazwa>` z tych samych definicji co `dynamicTools` Codexa (`packages/domain`, Effect Schema → JSON Schema → `z.fromJSONSchema`).
- `alwaysLoad`: bez tego Claude Code chowa narzędzia MCP za wyszukiwaniem narzędzi i model musi je najpierw znaleźć (zaobserwowane na żywo).
- Limit czasu wywołania 330 s, dłuższy niż najdłuższe `wait_threads` (300 s).
- `call_id` z id `tool_use` (z `_meta` wywołania albo dopasowany po nazwie i argumentach ze strumienia), więc ponowione wywołanie po ponownym połączeniu dostaje zapisany wynik.
- Narzędzia szyny są dozwolone w każdym trybie uprawnień (`allowedTools`); autoryzuje je gateway.

## Izolacja

- **`CLAUDE_CONFIG_DIR`** = `<data_dir>/claude-home`. Ustawienia, hooki, wtyczki i serwery MCP właściciela urządzenia nie działają w wątkach platformy. Dowiązane jest tylko logowanie (`.credentials.json`), chyba że worker używa CLIProxyAPI.
- Funkcje sesji SDK (`forkSession`, `getSessionMessages`) działają w procesie workera, więc adapter ustawia `CLAUDE_CONFIG_DIR` dla całego procesu.
- `strictMcpConfig`: tylko serwery MCP platformy.
- `settingSources: ["project", "local"]`: `CLAUDE.md` i ustawienia repozytorium działają, ustawienia użytkownika nie.
- Wyłączone narzędzia natywne: subagenci (`Agent`, `Task`, `Workflow`, `ListAgents`, `SendMessage`, `SubagentHandback`) i harmonogramy (`ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`); zastępuje je szyna ([agent-bus.md](agent-bus.md)).

## Otwarte

1. **macOS:** Claude Code trzyma logowanie w pęku kluczy, nie w pliku, więc dowiązanie nie działa. Na macOS: profil CLIProxyAPI albo `claude setup-token`.
2. **Sandbox w `FULL_AUTO`** wymaga bubblewrap (Linux) albo Seatbelt (macOS); na Windows do sprawdzenia.
3. Wiadomości w trakcie tury (`steer`) i praca w tle (zadania Claude Code) jeszcze nie są obsługiwane.
