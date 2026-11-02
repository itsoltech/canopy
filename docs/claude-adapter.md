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
| tura | wejście w strumieniu procesu Claude Code (`query()` z async iterable): nowy proces z `sessionId` przy pierwszej turze, z `resume` przy kolejnych; `model`, `effort` i `permission_mode` ze `StartTurn` (żywy proces: `setModel`, `setPermissionMode`) |
| proces | jeden na wątek; kończy się z turą, chyba że działają zadania w tle (wtedy zostaje i przyjmuje kolejne tury) |
| steer | wiadomość w strumieniu wejścia tury z `priority: "next"` i `uuid = input_id` |
| `provider_turn_ref` | uuid ostatniego wpisu tury w transkrypcie Claude (punkt forka, `upToMessageId`); też dla tur nieudanych i przerwanych |
| przerwanie | `query.interrupt()`, po 10 s bez odpowiedzi `abort` |

- **Fork od tury** ([threads.md](threads.md#fork-od-tury-fork-from-here)): `forkSession(źródło, { upToMessageId: provider_turn_ref tury })` kopiuje transkrypt do ostatniego wpisu tej tury włącznie i daje nową sesję; późniejsze tury źródła zostają poza nią. Bez `after_provider_turn_ref` przy podanej turze worker odmawia (`FORK_POINT_UNKNOWN`) zamiast kopiować całą sesję. Test bez modelu: `providers/claude/fork.test.ts` (trzy tury, fork od drugiej); na żywo: `fork-from-turn.live.test.ts`.
- **`thread_ready` bez wywołania modelu:** id sesji wybiera platforma, a fork kopiuje transkrypt (`forkSession`) bez modelu. Tak jak w Codexie wątek jest gotowy od razu.
- **Rekoncyliacja z transkryptu sesji:** każda tura zapisuje w dzienniku workera katalog konfiguracji, id sesji i offset transkryptu (`turn_harness`). Proces, który kończy się w trakcie tury bez `result`, i start workera po restarcie rozliczają turę z transkryptu (`transcript.ts`): bloki asystenta pod id `<message.id>:<indeks>`, narzędzia z `tool_use`/`tool_result`, koniec z ostatniego wpisu (`isApiErrorMessage`: błąd harnessu z kodem `apiError`; „[Request interrupted by user…]”; zatrzymany wpis asystenta: `completed`). Bez końca: `failed` przez harness (`process_exit`), a po restarcie workera `interrupted` przez system. `result` z błędem to błąd harnessu (kod: `subtype`), przerwanie na prośbę platformy jest użytkownika, zatrzymanie workera systemowe. Szczegóły: [durability.md](durability.md#35-rekoncyliacja-z-transkryptu-harnessu).
- **Sesja, której nigdy nie było** (wątek bez tury, także po restarcie workera): pierwsza tura sprawdza transkrypt (`getSessionMessages`); bez niego proces startuje z `sessionId`, a nie z `resume`, więc odpowiednik Codexowego „no rollout found” nie występuje. Fork ma transkrypt od razu (`forkSession`).
- **Koniec tury:** wiadomość `result`, z wyjątkiem udanego potwierdzenia `origin.kind = task-notification`, `num_turns = 0` (bez wywołania modelu). Po restarcie Claude może najpierw wysłać `task_notification stopped → init → result` o zadaniu z poprzedniego procesu, a dopiero potem odpowiedzieć na nowe wejście. Potwierdzenie zostaje jako `raw_json` bez tury; nie kończy oczekującego `StartTurn`, nie zwalnia go i nie rozlicza oczekującego steer. Właściwa odpowiedź i jej wynik nadal należą do tury notatki `background_task`. Pozostałe wyniki (także błędy i komendy bez wywołania modelu) kończą turę normalnie. Adapter zwalnia wątek przed zapisaniem `turn_finished`, żeby gateway mógł od razu zacząć kolejną turę. Bez zadań w tle zamyka wejście (proces się kończy, sesja jest już zapisana); z zadaniami proces zostaje.
- **Tury Claude:** `assistant`, `stream_event` albo właściwy `result` między turami oznacza, że Claude sam zaczął turę (np. po `task_notification`): tura `PROVIDER` z nowym ID. Samo `system init` i zerowe potwierdzenie powiadomienia nie tworzą tury. Naturalne zakończenie zadania nadal może budzić Claude; gateway czeka 15 s na jego turę, zanim dostarczy własną notatkę ([execution.md](execution.md#pobudka-agent-dowiaduje-się-o-każdym-końcu-zadania)).
- **Ponownie dostarczony `StartTurn`** z tym samym `turn_id` nie zaczyna drugiej tury.

## Modele, wysiłek, steer

- **Lista modeli bez tury:** `query()` ze strumieniem wejścia, który nic nie daje, `supportedModels()`, potem zamknięcie (ok. 0,5 s, model nie jest wołany). `ModelInfo.value` → `id`, `resolvedModel`, `supportedEffortLevels` (bez `supportsEffort` = brak wysiłków); wiersz `default` to model domyślny. Z profilem CLIProxyAPI lista obejmuje modele pośrednika (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, 62 na żywo; modele innych dostawców pod id `claude-fable-5-dd-<odwrócone id>`). Modele, które nie poprowadzą tury agenta, worker usuwa: metadane pośrednika (`GET /v1beta/models`, dopasowane po id, `resolvedModel` albo nazwie wyświetlanej), inaczej słowa w nazwie (`isAgentModel`); na żywo zostaje 47.
- **Domyślny wysiłek:** Claude Code go nie podaje (SDK `ModelInfo` nie ma pola, a wiadomość `init` z `effort` dostają tylko hosty Remote Control). Worker czyta ustawienie właściciela urządzenia: `CLAUDE_CODE_EFFORT_LEVEL`, potem `settings.json` urządzenia (`modelSettings.<model>.effortLevel`, potem `effortLevel`), i raportuje je jako `default_effort`, jeśli model je oferuje. Wątki nie ładują ustawień użytkownika (`settingSources: ["project", "local"]`, izolowany `CLAUDE_CONFIG_DIR`), więc tura bez wybranego wysiłku dostaje to ustawienie jako `Options.effort` (aliasy jak `opus` i wiersz `default` rozwiązane według ostatniej listy). Bez ustawienia `default_effort` jest pusty, a Claude Code bierze domyślny modelu. Kolejność w CLI 2.1.316: `CLAUDE_CODE_EFFORT_LEVEL` > wysiłek sesji (`Options.effort`) > ustawienia (per model przed ogólnym) > domyślny modelu.
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

- Tryb tury (`StartTurn.permission_mode`): nowy proces startuje z nim; proces trzymany przez zadania w tle przełącza się przed turą (`setPermissionMode`, sandbox przez `applyFlagSettings`, wyłączenie jako `{ enabled: false }`, automatyczna zgoda `canUseTool` czytana przy każdym pytaniu). Szczegóły: [protocol.md](protocol.md#modele-effort-i-steer).
- `FULL_AUTO` nigdy nie oznacza `bypassPermissions`.
- `AskUserQuestion` zawsze trafia do platformy jako pytanie (`QUESTION`), odpowiedź wraca jako `answers`.
- Różnica względem Codexa: w `READ_ONLY` Codex może uruchamiać komendy w sandboxie tylko do odczytu, Claude nie uruchamia shella.

## Szyna agentów

- Serwer MCP `openagents` w procesie workera (`createSdkMcpServer`), narzędzia `mcp__openagents__<nazwa>` z tych samych definicji co `dynamicTools` Codexa (`packages/domain`, Effect Schema → JSON Schema → `z.fromJSONSchema`).
- `alwaysLoad`: bez tego Claude Code chowa narzędzia MCP za wyszukiwaniem narzędzi i model musi je najpierw znaleźć (zaobserwowane na żywo).
- Limit czasu wywołania 330 s, dłuższy niż najdłuższe `wait_threads` (300 s).
- `call_id` z id `tool_use` (z `_meta` wywołania albo dopasowany po nazwie i argumentach ze strumienia), więc ponowione wywołanie po ponownym połączeniu dostaje zapisany wynik.
- Narzędzia szyny są dozwolone w każdym trybie uprawnień (`allowedTools`); autoryzuje je gateway.

## Załączniki i obrazy

- Katalog załączników wątku (`<data_dir>/attachments/<thread_id>`) jest w `additionalDirectories`: `Read` czyta załączniki bez pytania w każdym trybie (sprawdzone na żywo w trybie `ASK`).
- `mcp__openagents__view_image` ([agent-bus.md](agent-bus.md#view_image)) — serwer `openagents` jest zawsze, narzędzia szyny tylko z `enable_agent_bus`. Mapowanie: item `image` (`source = view_image`), błąd w `detail`.
- Obrazy w `tool_result` (np. `Read` na pliku obrazu) → `ToolCall.images`: podgląd z bloku `image` (base64) wyniku, czyli dokładnie to, co dostał model.

## Wzmianki

- **Katalog** (`claude/catalog.ts`): `query()` bez promptu z folderem wątku, izolowanym `CLAUDE_CONFIG_DIR` i `settingSources` project + local (jak tura), potem `supportedCommands()` (ok. 0,3–0,5 s, bez modelu). Claude Code traktuje skille jak komendy, a wiersz mówi tylko, czy jest wbudowany: skillem jest wiersz z folderem `.claude/skills/<nazwa>/SKILL.md` (w folderze wątku lub wyżej, albo w `skills/` katalogu konfiguracji). Źródło z końcówki opisu („(project)”, „(user)”). Pominięte: wbudowane komendy terminala, sesji i ustawień platformy, subagentów i harmonogramu (gdy wyłączone) oraz natywny `/goal`. Pamięć workera 5 min albo do zmiany katalogów `skills` / `commands`.
- **Wejście:** komenda na początku (`/stamp pelican`), skill na początku jako `/nazwa`, inne skille przez narzędzie Skill (notatka), `@ścieżka` pliku Claude Code rozwija sam (na żywo odpowiedź z treścią pliku bez wywołania Read).
- Potwierdzone na żywo (`tests/integration/mentions.live.test.ts`, `claude-haiku-5-5` przez CLIProxyAPI): skill projektu, komenda projektu z argumentem przeniesiona z końca wiadomości, plik, wspomniany wątek czytany przez `get_thread` i `read_thread`.

## Izolacja

- **`CLAUDE_CONFIG_DIR`** = `<data_dir>/claude-home`. Ustawienia, hooki, wtyczki i serwery MCP właściciela urządzenia nie działają w wątkach platformy. Dowiązane jest tylko logowanie (`.credentials.json`), chyba że worker używa CLIProxyAPI.
- Funkcje sesji SDK (`forkSession`, `getSessionMessages`) działają w procesie workera, więc adapter ustawia `CLAUDE_CONFIG_DIR` dla całego procesu.
- `strictMcpConfig`: tylko serwery MCP platformy.
- `settingSources: ["project", "local"]`: `CLAUDE.md` i ustawienia repozytorium działają, ustawienia użytkownika nie.
- Wyłączone narzędzia natywne: subagenci (`Agent`, `Task`, `Workflow`, `ListAgents`, `SendMessage`, `SubagentHandback`) i harmonogramy (`ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`); zastępuje je szyna ([agent-bus.md](agent-bus.md)). Sprawdzone na żywo: lista narzędzi z `system/init` nie ma `Agent` ani `Task` (`worker-claude.live.test.ts`), a prośba o subagenta kończy się `mcp__openagents__spawn_thread` (`platform-subagents.live.test.ts`).

## Otwarte

1. **macOS:** Claude Code trzyma logowanie w pęku kluczy, nie w pliku, więc dowiązanie nie działa. Na macOS: profil CLIProxyAPI albo `claude setup-token`.
2. **Sandbox w `FULL_AUTO`** wymaga bubblewrap (Linux) albo Seatbelt (macOS); na Windows do sprawdzenia.
3. Cel `/goal` żyje w procesie: nie sprawdzono, czy wznowiona sesja go odtwarza. Werdykty są czytane z wewnętrznego formatu transkryptu.
4. Zadania w tle typu agent i workflow są mapowane, ale nie testowane (natywni subagenci są domyślnie wyłączeni).
