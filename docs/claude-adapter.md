# Adapter Claude (Agent SDK)

Aktualizacja (2026-11-24): adapter maskuje znane wartości sekretów w synchronicznych
wynikach narzędzi przed wysłaniem ich do modelu. Gotowość do wydania sekretu projektu
potwierdza bieżący proces podczas `UserPromptSubmit`.

Aktualizacja (2026-11-22): nazwany profil Sandbox wymaga nowego procesu
z obowiązkowym sandboxem powłoki i ścisłą listą domen. Warunki zgodności
opisuje [Profile Sandbox](sandbox-profiles.md).

Aktualizacja (2026-11-21) obejmuje obsługę preferencji instancji zapisanych
w [ustawieniach CLI Canopy](worker-config.md#ustawienia-cli-zapisane-w-canopy).

Aktualizacja (2026-11-19): automatyczna zgoda na edycje w `FULL_AUTO` jest ograniczona do `cwd` wątku (tabela trybów niżej).

Status: **działa** (2026-11-18), w tym uruchamianie z importowanymi hookami w trybach z jawną konfiguracją sandboxa, odkrywanie i wybór fast per model/konto, 15-minutowy limit `show_images`, osobiste hooki `PreToolUse` i `PermissionRequest`, import osobistych skilli i komend wraz z zasobami pomocniczymi do 100 000 plików i katalogów oraz 256 MiB z pominięciem kosza skilli, obsługa pustych opcjonalnych metadanych oraz zmiana uprawnień i sandboxa podczas bieżącej tury:
- runtime wątków: `ClaudeThreads` w `apps/worker/src/providers/claude/threads.ts`,
- mapowanie wiadomości SDK na zdarzenia transkryptu: `ClaudeEventMapper` w `mapping.ts`, z testami na nagranych strumieniach (`fixtures/*.jsonl`),
- tryby uprawnień: `permissions.ts`,
- narzędzia szyny agentów: serwer MCP w procesie workera (`bus.ts`),
- trzy tryby katalogu konfiguracji Claude: izolowany (domyślny), lokalny z oczyszczoną nakładką ustawień oraz współdzielony z katalogiem sesji wskazanym przez użytkownika,
- profil CLIProxyAPI przez zmienne środowiskowe: `profile.ts`,
- podpięcie do workera: `WorkerHost` (obok Codexa, wybór po `ThreadSpec.provider`),
- zadania w tle (background Bash) i cele (`/goal`): sekcja „Praca w tle i cele”.

Lokalna automatyzacja (`agent-browser`, `agent-desktop`, `agent-device`) trafia
do sesji jako prywatny, workerowy MCP HTTP uruchamiany przez wspólny bridge
stdio. Gateway sprawdza grant i bieżącą turę przed każdym callem
([automation-tools.md](automation-tools.md)).

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

Przy starcie i wznowieniu procesu, także pierwszej tury forka, adapter utrzymuje
sesję otwartą przez inicjalizację SDK i ładowanie MCP aż do przyjęcia wejścia.
Wiadomość statusu otrzymana przed wejściem nie oznacza końca bezczynnej sesji.
Anulowanie albo błąd przygotowania zwalnia tę blokadę; proces bez tury i zadań
kończy się normalnie. Test `providers/claude/startup-admission.test.ts` odtwarza
tę kolejność z prawdziwym SDK i skryptowanym CLI, także dla anulowania.
To opis implementacji; dostępność zależy od kanału wydania ([release.md](release.md)).

- **Fork od tury** ([threads.md](threads.md#fork-od-tury-fork-from-here)): `forkSession(źródło, { upToMessageId: provider_turn_ref tury })` kopiuje transkrypt do ostatniego wpisu tej tury włącznie i daje nową sesję; późniejsze tury źródła zostają poza nią. Bez `after_provider_turn_ref` przy podanej turze worker odmawia (`FORK_POINT_UNKNOWN`) zamiast kopiować całą sesję. Test bez modelu: `providers/claude/fork.test.ts` (trzy tury, fork od drugiej); na żywo: `fork-from-turn.live.test.ts`.
- **`thread_ready` bez wywołania modelu:** id sesji wybiera platforma, a fork kopiuje transkrypt (`forkSession`) bez modelu. Tak jak w Codexie wątek jest gotowy od razu.
- **Rekoncyliacja z transkryptu sesji:** każda tura zapisuje w dzienniku workera katalog konfiguracji, id sesji i offset transkryptu (`turn_harness`). Proces, który kończy się w trakcie tury bez `result`, i start workera po restarcie rozliczają turę z transkryptu (`transcript.ts`): bloki asystenta pod id `<message.id>:<indeks>`, narzędzia z `tool_use`/`tool_result`, koniec z ostatniego wpisu (`isApiErrorMessage`: błąd harnessu z kodem `apiError`; „[Request interrupted by user…]”; zatrzymany wpis asystenta: `completed`). Bez końca: `failed` przez harness (`process_exit`), a po restarcie workera `interrupted` przez system. `result` z błędem to błąd harnessu (kod: `subtype`), przerwanie na prośbę platformy jest użytkownika, zatrzymanie workera systemowe. Szczegóły: [durability.md](durability.md#35-rekoncyliacja-z-transkryptu-harnessu).
- **Trwały dom sesji:** dziennik workera przypisuje katalog `CLAUDE_CONFIG_DIR` do id wątku platformy przy pierwszym użyciu. Przypisanie przeżywa ACK zdarzeń, koniec tury i restart. Zmiana bieżącego katalogu lub polityki konfiguracji instancji dotyczy nowych sesji; wznowienie i cofanie zachowują dom istniejącego wątku. Fork odczytuje przypisanie źródła bez jego zmiany i zapisuje ten sam dom dla nowego wątku, bo `forkSession` kopiuje transkrypt w obrębie jednego domu. Niedostępność przypisanego domu kończy operację błędem z prośbą o przywrócenie katalogu; worker nie przenosi sesji automatycznie. Starsza sesja bez przypisania jest najpierw szukana w znanym prywatnym domu instancji; fork takiego źródła nie przypisuje domu źródłu.
- **Sesja, której nigdy nie było** (wątek bez tury, także po restarcie workera): pierwsza tura sprawdza transkrypt (`getSessionMessages`); bez niego proces startuje z `sessionId`, a nie z `resume`. Dziennik osobno zachowuje id sesji, dla których odczytano historię albo rozpoczęto turę; brak ich transkryptu jest błędem zamiast pustej historii. Zachowane receipty `started_turns` chronią też starsze używane wątki bez nowego wpisu sesji. Fork ma transkrypt od razu (`forkSession`). Puste cofnięcie zapisuje jawnie puste, nowe id sesji i może rozpocząć historię od początku w dotychczasowym domu, także po restarcie.
- **Koniec tury:** wiadomość `result`, z wyjątkiem udanego potwierdzenia `origin.kind = task-notification`, `num_turns = 0` (bez wywołania modelu). Po restarcie Claude może najpierw wysłać `task_notification stopped → init → result` o zadaniu z poprzedniego procesu, a dopiero potem odpowiedzieć na nowe wejście. Potwierdzenie zostaje jako `raw_json` bez tury; nie kończy oczekującego `StartTurn`, nie zwalnia go i nie rozlicza oczekującego steer. Właściwa odpowiedź i jej wynik nadal należą do tury notatki `background_task`. Pozostałe wyniki (także błędy i komendy bez wywołania modelu) kończą turę normalnie. Adapter zwalnia wątek przed zapisaniem `turn_finished`, żeby gateway mógł od razu zacząć kolejną turę. Bez zadań w tle zamyka wejście (proces się kończy, sesja jest już zapisana); z zadaniami proces zostaje.
- **Tury Claude:** `system init`, `assistant`, `stream_event` albo właściwy `result` między turami oznacza, że Claude sam zaczął turę (np. po `task_notification`): tura `PROVIDER` z nowym ID. Samo zerowe potwierdzenie powiadomienia nie zaczyna tury ani nie kończy oczekującego wejścia. `init` nadal rezerwuje turę przed pierwszym outputem wolniejszego modelu: zatrzymuje zamknięcie bezczynnego procesu po 3 s i daje gateway informację o pobudce w oknie 15 s. Naturalne zakończenie zadania nadal może budzić Claude; gateway czeka 15 s na jego turę, zanim dostarczy własną notatkę ([execution.md](execution.md#pobudka-agent-dowiaduje-się-o-każdym-końcu-zadania)).
- **Ponownie dostarczony `StartTurn`** z tym samym `turn_id` nie zaczyna drugiej tury.

## Modele, wysiłek, steer

- **Lista modeli bez tury:** `query()` ze strumieniem wejścia, który nic nie daje, `supportedModels()`, potem zamknięcie (ok. 0,5 s, model nie jest wołany). `ModelInfo.value` → `id`, `resolvedModel`, `supportedEffortLevels` (bez `supportsEffort` = brak wysiłków); wiersz `default` to model domyślny. Z profilem CLIProxyAPI lista obejmuje modele pośrednika (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, 62 na żywo; modele innych dostawców pod id `claude-fable-5-dd-<odwrócone id>`). Modele, które nie poprowadzą tury agenta, worker usuwa: metadane pośrednika (`GET /v1beta/models`, dopasowane po id, `resolvedModel` albo nazwie wyświetlanej), inaczej słowa w nazwie (`isAgentModel`); na żywo zostaje 47.
- **Domyślny wysiłek:** Claude Code go nie podaje (SDK `ModelInfo` nie ma pola, a wiadomość `init` z `effort` dostają tylko hosty Remote Control). Worker czyta ustawienie właściciela urządzenia: `CLAUDE_CODE_EFFORT_LEVEL`, potem `settings.json` urządzenia (`modelSettings.<model>.effortLevel`, potem `effortLevel`), i raportuje je jako `default_effort`, jeśli model je oferuje. Wątki nie ładują ustawień użytkownika (`settingSources: ["project", "local"]`, izolowany `CLAUDE_CONFIG_DIR`), więc tura bez wybranego wysiłku dostaje to ustawienie jako `Options.effort` (aliasy jak `opus` i wiersz `default` rozwiązane według ostatniej listy). Bez ustawienia `default_effort` jest pusty, a Claude Code bierze domyślny modelu. Kolejność w CLI 2.1.316: `CLAUDE_CODE_EFFORT_LEVEL` > wysiłek sesji (`Options.effort`) > ustawienia (per model przed ogólnym) > domyślny modelu.
- **Wysiłek:** `Options.effort` (`low | medium | high | xhigh | max`); inna wartość kończy start tury błędem.
- **Steer:** Claude Code bierze wiadomość z `priority: "next"` między wywołaniami narzędzi. `command_lifecycle` z `command_uuid = input_id` mówi, kiedy weszła (`queued` → `started` → `completed`); przy `started` adapter zapisuje item `user_message` z `client_id = input_id`, więc oś czasu pokazuje ją tam, gdzie weszła.
  - Wiadomość, która przy `result` nadal czeka w kolejce, Claude Code wykonuje zaraz po nim w tym samym `query()`. Adapter traktuje to jako ciąg dalszy tury: ten `result` zapisuje bez ciała i kończy turę dopiero na następnym (jeden `turn_finished`; zużycie z ostatniego wyniku). Bez dalszych zdarzeń przez 60 s pierwszy wynik kończy turę.
  - Przerwanie, błąd albo koniec bez wejścia wiadomości: `Notice steer_dropped` (`data_json {"input_id"}`), gateway kolejkuje ją jako następną turę. Steer do tury zakończonej, przerywanej albo spoza tego procesu: `STEER_NOT_RUNNING`.

## Mapowanie

| Claude | Zdarzenie platformy |
|---|---|
| start tury (adapter) | `turn_started` + item `user_message` z treścią wejścia |
| `stream_event` `content_block_start/delta` (text, thinking) | `item_started` + `item_delta` (item `<message id>:<index>`) |
| `assistant` text / thinking | `item_completed` (`agent_message` / `reasoning`); pusty, zredagowany thinking nie tworzy itemu |
| `stream_event` `message_delta` z `stop_reason: "end_turn"` (wiadomość główna, nie subagenta) | ponowne `item_completed` ostatniego tekstu tej wiadomości z `phase: "final_answer"` (docs/timeline-folding.md) |
| `assistant` `tool_use` | `item_started`: `Bash` → `command_execution`, `Write`/`Edit`/`MultiEdit`/`NotebookEdit` → `file_change`, `WebSearch` → `web_search`, `TodoWrite` → `todo_list`, `mcp__canopy__*` → `agent_bus_call`, inne → `tool_call` |
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

## Uprawnienia

| Tryb | Claude | Pytania |
|---|---|---|
| `ASK` | `default` | każda edycja i komenda przez `canUseTool` do platformy |
| `ACCEPT_EDITS` | `acceptEdits` | edycje w workspace przechodzą, reszta pyta; edycja poza `cwd` wątku trafia do pytania o zgodę |
| `READ_ONLY` | `dontAsk` | nic nie pyta; to, co wymaga zgody (edycje, shell), jest odrzucane |
| `FULL_AUTO` | `acceptEdits` + sandbox dla Bash + automatyczna zgoda `canUseTool` | nic nie pyta; automatyczna zgoda na narzędzia edycji (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) dotyczy tylko ścieżek w `cwd` wątku po rozwiązaniu dowiązań (także nowych plików, bez `..` i strumieni ADS); inne są odrzucane, a `FULL_ACCESS` tego nie zawęża; komendy w sandboxie systemu (zapis tylko w workspace), bez sandboxa komenda nie ruszy (`failIfUnavailable`). Na Windows Claude Code nie ma sandboxa: tura startuje bez niego (`failIfUnavailable: false`), a komenda shella (`Bash`, `PowerShell`) czeka na zgodę użytkownika, zamiast ruszyć bez izolacji |
| `FULL_ACCESS` | `acceptEdits`, `sandbox: { enabled: false }` + automatyczna zgoda `canUseTool` | nic nie pyta; edycje i komendy wszędzie, gdzie może użytkownik OS workera, z siecią; sandbox wyłączony jawnie, także gdy włączają go ustawienia repozytorium |

- Tryb tury (`StartTurn.permission_mode`): nowy proces startuje z nim; proces trzymany przez zadania w tle przełącza się przed turą (`setPermissionMode`, sandbox przez `applyFlagSettings`, wyłączenie jako `{ enabled: false }`, automatyczna zgoda `canUseTool` czytana przy każdym pytaniu). Szczegóły: [protocol.md](protocol.md#modele-effort-i-steer).
- `FULL_AUTO` nigdy nie oznacza `bypassPermissions`. `FULL_ACCESS` też nie: `bypassPermissions` (z `allowDangerouslySkipPermissions`) pomija `canUseTool`, a wtedy `AskUserQuestion` nie trafiłoby do platformy. Automatyczna zgoda w `canUseTool` przepuszcza wszystko poza pytaniami; w `FULL_AUTO` na Windows także poza komendami shella, które biegną tam bez izolacji. Na Linux i macOS komenda, która trafia do `canUseTool`, i tak biegnie w sandboxie: `autoAllowBashIfSandboxed` zatwierdza większość objętych komend, ale nie wszystkie (np. `cd x && rm y`), więc pytanie o shell dawałoby tam zbędne pytania.
- Przełączenie trybu procesu trzymanego przez zadania w tle (`mode-switch.ts`): na czas zmiany automatyczna zgoda jest wyłączona; `FULL_AUTO` ↔ `FULL_ACCESS` włącza albo wyłącza sandbox przez `applyFlagSettings`.
- Bieżąca tura: jawne `UpdateTurnPermissions` właściciela, z capability `claude_live_permissions_v1`, stosuje te same ustawienia bez restartu procesu. Komenda wskazuje dokładne `thread_id` i `turn_id`; worker szereguje zmiany i nie przenosi ich na nowszą turę. Koniec tury czeka na zakończenie trwającej zmiany. Po sukcesie worker zapisuje `turn_permissions_changed` w journalu przed wynikiem komendy; gateway utrwala tryb tury również po ponownym połączeniu. Błąd częściowej zmiany zatrzymuje sesję zamiast pozostawiać ją z niepotwierdzonym sandboxem. Domyślne wątku pozostają osobnym ustawieniem.
- Przejście na `FULL_ACCESS` rozstrzyga oczekujące zgody `PERMISSION` tej tury; pytania i formularze pozostają do odpowiedzi. Inne zmiany nie zatwierdzają wcześniej przechwyconych natywnych operacji: komenda oczekująca na zgodę mogła powstać jeszcze bez sandboxa. Przyznana automatyzacja przez bridge ponownie sprawdza tryb, więc jej zgody zwalnia także `FULL_AUTO` ([automation-tools.md](automation-tools.md#grant-workera-i-uprawnienia-tury)). Nowy tryb dotyczy kolejnych operacji, nie cofa skutków komend już uruchomionych.
- `AskUserQuestion` zawsze trafia do platformy jako pytanie (`QUESTION`), odpowiedź wraca jako `answers`.
- Różnica względem Codexa: w `READ_ONLY` Codex może uruchamiać komendy w sandboxie tylko do odczytu, Claude nie uruchamia shella.

## Maskowanie sekretów w wynikach narzędzi

Worker uznaje filtr za gotowy po callbacku SDK `UserPromptSubmit` dla oczekiwanej
sesji i komunikacie `init` od Claude Code 2.1.316 lub nowszego w serii 2.1.
Gotowość wygasa z procesem. Synchroniczny `PostToolUse.updatedToolOutput` maskuje
tekst wyników natywnych i MCP. Serwer MCP Canopy filtruje również własne
odpowiedzi błędów przed przekazaniem ich do Claude. Filtr obejmuje także
ręczne sekrety tego wątku, które zachowują dotychczasową ścieżkę dostępu.

Przy znanej wartości sekretu adapter uruchamia polecenie Bash w osobnej
powłoce pod kontrolą tego samego narzędzia i jego sandboxa. Dzięki temu stdout
i stderr po niezerowym wyjściu trafiają do `PostToolUse`, które może je podmienić.
Model widzi prawdziwy kod wyjścia w tekście stderr. Natywny status narzędzia
oznacza powodzenie zewnętrznego polecenia, a zmiany stanu lokalnego powłoki
pozostają w powłoce potomnej. Claude sprawdza oryginalne polecenie regułami
uprawnień, a Canopy stosuje osłonę dopiero po przyznaniu zgody. Przy aktywnym
sekrecie w trybie tylko do odczytu dostęp do plików zapewniają narzędzia odczytu.
Aktywny sekret projektu blokuje jawne uruchomienie powłoki w tle i narzędzie
monitorujące.

Mechanizm obejmuje zwykłe niezerowe wyjście Bash. SDK zgłasza niektóre awarie
wykonania, np. przerwanie samego narzędzia, przez `PostToolUseFailure`,
które w Claude nie podmienia wyniku. Przy dostępnym sekrecie projektu hook
odmawia wywołania natywnego PowerShell z powodu jego niefiltrowalnych
błędów. Test z lokalnym endpointem modelu potwierdza
pierwsze wywołanie o sekret, odczyt, stdout, stderr, błąd MCP, czysty
transkrypt sprawdzanej sesji oraz wznowienie na Claude Code 2.1.331.

## Szyna agentów

- Serwer MCP `canopy` w procesie workera (`createSdkMcpServer`), narzędzia `mcp__canopy__<nazwa>` z tych samych definicji co `dynamicTools` Codexa (`packages/domain`, Effect Schema → JSON Schema → `z.fromJSONSchema`).
- `alwaysLoad`: bez tego Claude Code chowa narzędzia MCP za wyszukiwaniem narzędzi i model musi je najpierw znaleźć (zaobserwowane na żywo).
- `show_images` ma limit 15 min; pozostałe wywołania do gatewaya zachowują 330 s, dłużej niż najdłuższe `wait_threads` (300 s). SDK ma wspólny limit serwera 15 min, a worker przekazuje termin konkretnego narzędzia do gatewaya i anuluje oczekiwanie po jego przekroczeniu.
- `call_id` z id `tool_use` (z `_meta` wywołania albo dopasowany po nazwie i argumentach ze strumienia), więc ponowione wywołanie po ponownym połączeniu dostaje zapisany wynik.
- Narzędzia szyny są dozwolone w każdym trybie uprawnień (`allowedTools`); autoryzuje je gateway.
- Zmiana konektorów dotyczy następnej tury. Nowe query/resume dostaje aktualne `mcpServers`; query z zadaniami w tle usuwa i dodaje serwer przez `setMcpServers`, ponieważ SDK zachowuje instancję przy samej podmianie tej samej nazwy. Worker czeka do 15 s na `connected` i aktualny katalog w `mcpServerStatus`: samo zakończenie rejestracji może jeszcze zwrócić `pending`. Notatka `[canopy]` informuje model tylko o zmianach ([connectors.md](connectors.md#ograniczenia-sesji-harnessów)).

## Załączniki i obrazy

- Katalog załączników wątku (`<data_dir>/attachments/<thread_id>`) jest w `additionalDirectories`: `Read` czyta załączniki bez pytania w każdym trybie.
- `mcp__canopy__view_image` ([agent-bus.md](agent-bus.md#view_image)) — serwer `canopy` jest zawsze, narzędzia szyny tylko z `enable_agent_bus`. Mapowanie: item `image` (`source = view_image`), błąd w `detail`.
- Obrazy w `tool_result` (np. `Read` na pliku obrazu) → `ToolCall.images`: podgląd z bloku `image` (base64) wyniku, czyli dokładnie to, co dostał model.
- Obrazy umieszczone w tekście wiadomości: blok `image` (base64, skalowany jak `view_image`) zaraz za znacznikiem `[Attachment N: nazwa]`, między blokami `text` (`claude/input.ts`, [protocol.md](protocol.md#załączniki-w-tekście)). Bez umieszczonych obrazów treść jest zwykłym tekstem jak dotąd.

## Wzmianki

- **Katalog** (`claude/catalog.ts`): `query()` bez promptu z folderem wątku, izolowanym `CLAUDE_CONFIG_DIR` i `settingSources` project + local (jak tura), potem `supportedCommands()` (ok. 0,3–0,5 s, bez modelu). Claude Code traktuje skille jak komendy, a wiersz mówi tylko, czy jest wbudowany: skillem jest wiersz z folderem `.claude/skills/<nazwa>/SKILL.md` (w folderze wątku lub wyżej, albo w `skills/` katalogu konfiguracji). Źródło z końcówki opisu („(project)”, „(user)”). Pominięte: wbudowane komendy terminala, sesji i ustawień platformy, subagentów i harmonogramu (gdy wyłączone) oraz natywny `/goal`. Pamięć workera 5 min albo do zmiany katalogów `skills` / `commands`.
- **Wejście:** komenda na początku (`/stamp pelican`), skill na początku jako `/nazwa`, inne skille przez narzędzie Skill (notatka), `@ścieżka` pliku Claude Code rozwija sam.

## Izolacja

- Zapisane w Canopy preferencje `settings.json` zastępują odpowiadające
  klucze z zaimportowanej konfiguracji użytkownika, projektu i lokalnej.
  Worker przekazuje wynik do SDK przy otwarciu procesu zapytania i zachowuje
  pierwszeństwo zarządzanych ustawień Canopy. Domyślny wysiłek instancji
  zastępuje wartość ze źródłowego pliku po uwzględnieniu
  `CLAUDE_CODE_EFFORT_LEVEL`. Bieżący proces zachowuje swój zestaw ustawień.
- **Tryb izolowany:** `CLAUDE_CONFIG_DIR` = prywatny katalog platformy (`<data_dir>/claude-home` albo katalog instancji). Ustawienia, hooki, wtyczki i serwery MCP właściciela urządzenia nie działają w wątkach platformy. Dowiązane jest tylko logowanie (`.credentials.json`), chyba że worker używa CLIProxyAPI.
- **Tryb lokalny:** sesje pozostają w prywatnym katalogu, a worker odczytuje ze wskazanego źródła wyłącznie bezpieczną listę preferencji. Instrukcje, skille i hooki są osobnymi, domyślnie kontrolowanymi zakresami; skille i komendy trafiają do prywatnej oczyszczonej kopii pluginu `canopy-user`.
- **Tryb współdzielony:** `CLAUDE_CONFIG_DIR` wskazuje źródło użytkownika, więc sesje i historia są tam zapisywane. Ustawienia nadal są scalane jako `user < project < local`, MCP i logowanie pozostają kontrolowane przez Canopy. Uprawnienia wynikają z trybu Canopy oraz jawnie włączonych hooków użytkownika. Prywatny katalog platformy służy do zarządzanych artefaktów i nie jest czyszczony w katalogu źródłowym.
- Funkcje sesji SDK (`forkSession`, `getSessionMessages`) działają w procesie workera, więc adapter ustawia `CLAUDE_CONFIG_DIR` dla całego procesu.
- `strictMcpConfig`: tylko serwery MCP platformy.
- `settingSources: ["project", "local"]`: `CLAUDE.md` i ustawienia repozytorium działają, ustawienia użytkownika nie. Hooki i ustawienia projektu są świadomie zaufanym kodem tego projektu we wszystkich trybach (uruchamia je Claude Code poza sandboxem Bash), więc granicą jest wybór projektu i tryb uprawnień, a nie ich usuwanie. Wyjątkiem jest pasywne czytanie katalogu wzmianek (`listMentionCatalog`): proces bez promptu dostaje w ustawieniach wywołania `disableAllHooks: true` (także w prywatnym pliku ustawień, gdy użytkownik zaimportował hooki), więc hooki projektu, lokalne i zaimportowane nie wykonują się przy samym wypełnianiu listy, a nazwy komend i skilli pozostają. Hooki i polityki administratora (managed) działają jak zawsze, a zwykłe tury zachowują dotychczasową decyzję operatora o zaufaniu projektu. Konfiguracja sandboxa trybu `FULL_AUTO` jest nadawana przez Canopy z wyższym priorytetem niż ustawienia repozytorium i nie pozwala na polecenia poza sandboxem; edycje plików poza `cwd` odrzuca `canUseTool`.
- Gdy import dostarcza hooki, worker zapisuje oczyszczone preferencje i definicje hooków w prywatnym pliku ustawień. W tym samym pliku zapisuje konfigurację sandboxa wynikającą z trybu uprawnień Canopy, ponieważ SDK nie przyjmuje jednocześnie ścieżki pliku i osobnej opcji `sandbox`. Bez importowanych definicji worker używa ustawień inline oraz osobnej opcji `sandbox`, gdy tryb jej wymaga. Import pomija surowe pola `env`, `permissions`, sandbox, MCP, pluginów ani helperów. Po jawnym włączeniu hooków użytkownika do CLI trafiają również `PreToolUse` i `PermissionRequest`, bez blokowania zdarzeń lub ich decyzji o uprawnieniach przez Canopy. `PreToolUse` może zatwierdzić narzędzie przed wywołaniem `canUseTool`, więc takie wywołanie nie pyta o zgodę w Canopy. Obecny CLI w trybie SDK nie uruchamia `PermissionRequest`; żądanie obsługuje wtedy `canUseTool`. Samo istnienie tej definicji nie blokuje tury. Przy wyłączonych hookach te definicje nie są przekazywane. Testy `configuration-runtime.test.ts` sprawdzają oba zdarzenia przez rzeczywisty adapter i CLI w trybach lokalnym i współdzielonym, z syntetycznym endpointem modelu. Skille i komendy są kopiowane do prywatnego pluginu z usuniętymi metadanymi uprawnień, a `disableSkillShellExecution` pozostaje wymuszone. Dostępność zmiany w nightly/beta/stable wynika z wydań ([release.md](release.md)).
- Frontmatter jest oczyszczany tylko w definicjach `SKILL.md` i plikach Markdown katalogu `commands`, także w podkatalogach. Pomocnicze dokumenty skilli są kopiowane bajt w bajt: ich własne metadane, kodowanie albo początkowy separator Markdown `---` nie blokują importu. Opisowe pola definicji zachowują tekst, liczby, wartości logiczne i `null`, a flagi wywołania — wartości logiczne i `null`, zgodnie z interpretacją CLI. Inne metadane nadal są usuwane. Błąd importu podaje kategorię problemu (np. rozmiar pliku, cykl dowiązań lub niepoprawny frontmatter), bez ścieżek, nazw ani treści źródłowych; wskazuje sprawdzenie źródła lub wyłączenie `Personal skills` w `Settings → Providers`. Testy przygotowania konfiguracji odtwarzają odkrywanie skilli przez prawdziwy CLI bez inferencji. Dostępność poprawki w nightly/beta/stable wynika z wydań ([release.md](release.md)).
- `claudeMdExcludes` w ustawieniach wywołania odcina instrukcje globalne oraz przodków powyżej repozytorium/worktree, a w scratch powyżej cwd. Samo `settingSources` nie blokuje pamięci użytkownika: CLI 2.1.308 nadal czyta `<HOME>/.claude/CLAUDE.md` oraz nadrzędne `CLAUDE.md`. Zarządzany blok jest jawnie dopisywany do system promptu; pozostała treść izolowanego `CLAUDE.md` nie trafia przez automatyczny odczyt. `HOME` pozostaje bez zmian, więc poprawka nie zmienia odkrywania macOS Keychain. Testy przechwytują żądania prawdziwego CLI w tymczasowym HOME, bez logowania i bez inferencji; nie zastępują sprawdzenia loginu na Macu.
- Wyłączone narzędzia natywne: subagenci (`Agent`, `Task`, `Workflow`, `ListAgents`, `SendMessage`, `SubagentHandback`) i harmonogramy (`ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`); zastępuje je szyna ([agent-bus.md](agent-bus.md)). Sprawdzone na żywo: lista narzędzi z `system/init` nie ma `Agent` ani `Task` (`worker-claude.live.test.ts`), a prośba o subagenta kończy się `mcp__canopy__spawn_thread` (`platform-subagents.live.test.ts`).

Łączny limit kopii osobistych `skills` i `commands` wynosi 100 000 plików
i katalogów, zamiast wcześniejszych 2048. Obejmuje definicje i wszystkie zasoby
pomocnicze importowanej biblioteki. Worker pomija `skills/.trash`, chyba że
bezpośrednio w nim znajduje się definicja skilla `SKILL.md`. Pominięty katalog
pozostaje na dysku, a jego zawartość nie wlicza się do limitów kopii.
Kopia przyjmuje definicje skilli i komend do 10 MiB, pliki pomocnicze do
64 MiB każdy i całą bibliotekę do 256 MiB. Worker kopiuje pliki pomocnicze
strumieniowo. Dopuszcza do 32 poziomów zagnieżdżenia oraz odrzuca cykle
dowiązań i pliki specjalne.
Test przygotowania konfiguracji importuje bibliotekę przekraczającą dawny próg,
sprawdza oczyszczanie definicji, kompletność zasobów i usunięcie prywatnej kopii.
To opis implementacji; dostępność nightly/beta/stable wynika z wydań
([release.md](release.md)).

## Otwarte

1. **macOS:** login z pęku kluczy wybiera `CLAUDE_SECURESTORAGE_CONFIG_DIR`, niezależnie od izolowanego `CLAUDE_CONFIG_DIR`. Domyślny login wymaga pustej wartości (bez skrótu katalogu w nazwie wpisu), własny katalog — jego ścieżki. Worker przekazuje ten sam magazyn odczytowi konta i turom instancji; dostęp nadal zależy od uprawnień procesu do pęku kluczy. Nie eksportuje tokenów.
2. **Sandbox w `FULL_AUTO`** wymaga bubblewrap (Linux) albo Seatbelt (macOS). Na Windows Claude Code go nie udostępnia, więc komendy shella w `FULL_AUTO` pytają o zgodę; gdy Claude Code go tam włączy, wrócić do `failIfUnavailable: true` i pełnej automatycznej zgody.
3. Cel `/goal` żyje w procesie: nie sprawdzono, czy wznowiona sesja go odtwarza. Werdykty są czytane z wewnętrznego formatu transkryptu.
4. Zadania w tle typu agent i workflow są mapowane, ale nie testowane (natywni subagenci są domyślnie wyłączeni).

## Szybkość niezależna od wysiłku

SDK 0.3.316 udostępnia `ModelInfo.supportsFastMode`,
`Query.initializationResult().fast_mode_state` i `fast_mode_disabled_reason`
oraz `Settings.fastMode` / `Query.applyFlagSettings({ fastMode })`.
Jawne `fastMode: true` w warstwie ustawień flag jest wymaganym opt-in sesji SDK;
nie ustawiamy nieudokumentowanych flag środowiska i nie wyprowadzamy wsparcia z nazwy modelu.
Katalog uruchamia query bez promptu z tym opt-in, a następnie czyta wynik
inicjalizacji. `fast` pojawia się tylko dla modelu z `supportsFastMode: true`,
gdy CLI raportuje stan szybkości i brak powodu blokady konta. Brak metadanych,
`pending`, wyłączone extra usage, konto free i inne blokady nie ogłaszają fast.
Instancje proxy nie dziedziczą natywnych poziomów. Claude nie raportuje `ultrafast`.

Każdy proces otrzymuje jawne `settings.fastMode`, także na resume; nakładka
wygrywa z ustawieniami projektu. Przed wejściem każdej tury worker stosuje
`applyFlagSettings`, więc proces utrzymywany przez zadania w tle też wraca do
zwykłej szybkości. Wybór tury wygrywa z wyborem wątku; puste pole tury dziedziczy
wątek, a `default` jawnie wyłącza fast. Wybrany fast wymaga następnie świeżej
inicjalizacji potwierdzającej stan `on` lub `cooldown` bez blokady; odmowa nie
wysyła promptu. Zmiana szybkości w steer odrzuca dołączenie (`STEER_REJECTED`),
żeby kolejka mogła rozpocząć osobną turę. Botowe query przekazuje ten sam
wybór w `settings.fastMode`, również na resume. Dla wybranego fast jego strumień
wejściowy czeka na świeżą inicjalizację CLI: ta sama kontrola wsparcia modelu,
blokady konta i stanu szybkości poprzedza wysłanie pierwszej wiadomości. Utrata
uprawnień po zapisaniu konfiguracji kończy botową turę błędem
`SERVICE_TIER_UNAVAILABLE`, bez promptu i cichego przejścia na zwykłą szybkość;
zamknięcie query zwalnia także oczekujący strumień i proces.

`providers/claude/service-tiers.test.ts` używa prawdziwego SDK ze skryptowanym CLI:
sprawdza odkrywanie bez inferencji, różne blokady konta, metadane modelu,
zmianę szybkości w żywym procesie oraz reset po zimnym resume.
`bots/service-tiers.test.ts` sprawdza również zmianę wyboru botów na istniejącej sesji,
utratę uprawnień przed wznowioną turą oraz zakończenie procesu po odmowie. Nie wykonuje
płatnej inferencji; źródłem kontraktu jest opublikowane `sdk.d.ts` przypiętego SDK.
