# Adapter Claude (Agent SDK)

Status: **działa** (2026-11-01):
- runtime wątków: `ClaudeThreads` w `apps/worker/src/providers/claude/threads.ts`,
- mapowanie wiadomości SDK na zdarzenia transkryptu: `ClaudeEventMapper` w `mapping.ts`, z testami na nagranych strumieniach (`fixtures/*.jsonl`),
- tryby uprawnień: `permissions.ts`,
- narzędzia szyny agentów: serwer MCP w procesie workera (`bus.ts`),
- izolowany katalog konfiguracji: `home.ts` (`CLAUDE_CONFIG_DIR`),
- profil CLIProxyAPI przez zmienne środowiskowe: `profile.ts`,
- podpięcie do workera: `WorkerHost` (obok Codexa, wybór po `ThreadSpec.provider`),
- zadania w tle (background Bash) i cele (`/goal`): sekcja „Praca w tle i cele”.

Potwierdzone na żywo (`tests/integration/worker-claude.live.test.ts`, Claude przez CLIProxyAPI): gateway konfiguruje workera, wątek w trybie `ASK`, zgody na zapis i komendę idą przez gateway, plik powstaje; druga tura wznawia sesję; wywołanie narzędzia szyny (`list_threads`) wraca z gateway i jest powiązane z `tool_use`; fork po pierwszej turze dostaje własną sesję i zna historię; natywni subagenci i harmonogramy są wyłączone.

## Model

| Platforma | Claude |
|---|---|
| wątek | sesja Claude Code |
| `provider_thread_id` | id sesji: przy nowym wątku = id wątku platformy (`sessionId`), przy forku nowe id z `forkSession` |
| tura | wejście w strumieniu procesu Claude Code (`query()` z async iterable): nowy proces z `sessionId` przy pierwszej turze, z `resume` przy kolejnych; `model` i `effort` ze `StartTurn` (żywy proces: `setModel`) |
| proces | jeden na wątek; kończy się z turą, chyba że działają zadania w tle (wtedy zostaje i przyjmuje kolejne tury) |
| steer | wiadomość w strumieniu wejścia tury z `priority: "next"` i `uuid = input_id` |
| `provider_turn_ref` | uuid ostatniego wpisu tury w transkrypcie Claude (punkt forka, `upToMessageId`) |
| przerwanie | `query.interrupt()`, po 10 s bez odpowiedzi `abort` |

- **`thread_ready` bez wywołania modelu:** id sesji wybiera platforma, a fork kopiuje transkrypt (`forkSession`) bez modelu. Tak jak w Codexie wątek jest gotowy od razu.
- **Koniec tury:** wiadomość `result`. Adapter zwalnia wątek przed zapisaniem `turn_finished`, żeby gateway mógł od razu zacząć kolejną turę. Bez zadań w tle zamyka wejście (proces się kończy, sesja jest już zapisana); z zadaniami proces zostaje.
- **Tury Claude:** wiadomość tury (`system init`, `assistant`, `stream_event`, `result`) między turami oznacza, że Claude sam zaczął turę (np. po `task_notification`): tura `PROVIDER` z nowym ID.
- **Ponownie dostarczony `StartTurn`** z tym samym `turn_id` nie zaczyna drugiej tury.

## Modele, wysiłek, steer

- **Lista modeli bez tury:** `query()` ze strumieniem wejścia, który nic nie daje, `supportedModels()`, potem zamknięcie (ok. 0,5 s, model nie jest wołany). `ModelInfo.value` → `id`, `resolvedModel`, `supportedEffortLevels` (bez `supportsEffort` = brak wysiłków); wiersz `default` to model domyślny. Claude nie podaje domyślnego wysiłku. Z profilem CLIProxyAPI lista obejmuje modele pośrednika (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, 62 na żywo).
- **Wysiłek:** `Options.effort` (`low | medium | high | xhigh | max`); inna wartość kończy start tury błędem. Na żywo potwierdzone przez `CLAUDE_EFFORT` w Bash.
- **Steer:** Claude Code bierze wiadomość z `priority: "next"` między wywołaniami narzędzi. `command_lifecycle` z `command_uuid = input_id` mówi, kiedy weszła (`queued` → `started` → `completed`); przy `started` adapter zapisuje item `user_message` z `client_id = input_id`, więc oś czasu pokazuje ją tam, gdzie weszła.
  - Wiadomość, która przy `result` nadal czeka w kolejce, Claude Code wykonuje zaraz po nim w tym samym `query()`. Adapter traktuje to jako ciąg dalszy tury: ten `result` zapisuje bez ciała i kończy turę dopiero na następnym (jeden `turn_finished`; zużycie z ostatniego wyniku). Bez dalszych zdarzeń przez 60 s pierwszy wynik kończy turę.
  - Przerwanie, błąd albo koniec bez wejścia wiadomości: `Notice steer_dropped` (`data_json {"input_id"}`), gateway kolejkuje ją jako następną turę. Steer do tury zakończonej, przerywanej albo spoza tego procesu: `STEER_NOT_RUNNING`.
  - Potwierdzone na żywo: steer w trakcie komendy (wchodzi po wyniku narzędzia) i w trakcie odpowiedzi bez narzędzi (dwa wyniki, jedna tura).

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
| `system` `task_started` (w tle) / `task_updated` (`is_backgrounded`) | `item_started` `background_task` `bg:<task_id>` (bez tury po jej końcu) |
| `system` `task_notification` | `item_completed` tego itemu (`completed` / `failed` / `stopped` → `interrupted`), podsumowanie i zużycie w `progress` |
| syntetyczna odpowiedź `/goal` (`Goal set: …`, `Goal cleared: …`) | `goal_state` (`active` / `cleared`) |
| `goal_status` z transkryptu sesji (czytany po `result`) | `goal_state` (`met`, `failed`, `active` z werdyktem) |

Pełne wiadomości nigdy nie giną: bez mapowania trafiają do dziennika jako `raw_json` bez ciała. Zdarzenia strumienia, które tylko odtwarzają pełne wiadomości (częściowy JSON wejścia narzędzi, podpisy, granice wiadomości), nie są zapisywane.

## Praca w tle i cele

- **Otwarte wejście** i `perTaskStopAffordance: true`: przerwanie tury nie zabija zadań w tle, zatrzymuje je `StopTask` → `stopTask(task_id)` ([execution.md](execution.md#4-zadania-w-tle)).
- **Output** zadania pisze Claude Code do pliku (ścieżka w `tool_result`: „Output is being written to: …”). Worker czyta go przyrostowo co sekundę i przed `task_notification` doczytuje resztę.
- **Bezczynny proces** po zadaniach czeka 3 s na turę Claude (`task_notification` → `system init` przychodzi po ~50 ms), potem się kończy. Zadania, które zostały przy końcu procesu, dostają `interrupted`.
- **`/goal`** przychodzi z gateway jako wejście tury (`trigger = goal`). Claude Code nie przekazuje `active_goal` klientom SDK; werdykty ewaluatora (`goal_status`) adapter czyta z transkryptu sesji po każdym `result` ([goals.md](goals.md#claude-co-zaobserwowano-claude-code-21316-sdk-03316)).

Potwierdzone na żywo (2026-11-01, `tests/integration/goals-background.live.test.ts`, cały łańcuch od UI API): background Bash z outputem z pliku, zatrzymany z UI (`stopped_by_user`, bez tury Claude), krótkie zadanie po zakończeniu uruchamia turę Claude, która o nim informuje; `/goal` ustawiony z UI kończy się `achieved` z werdyktem ewaluatora. Nagrania: `fixtures/background-bash-*.jsonl`, `goal-turn.jsonl`, `goal-transcript.jsonl`.

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
3. Cel `/goal` żyje w procesie: nie sprawdzono, czy wznowiona sesja go odtwarza. Werdykty są czytane z wewnętrznego formatu transkryptu.
4. Zadania w tle typu agent i workflow są mapowane, ale nie testowane (natywni subagenci są domyślnie wyłączeni).
