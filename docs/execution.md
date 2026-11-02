# Wykonanie wątku: tury, praca w tle, subagenci, interakcje

Status: **częściowo zaimplementowane**. Tury, interakcje, steer i **praca w tle** (sekcja 4: procesy Codexa, background Bash Claude, zatrzymanie z UI, notatki dla agenta o każdym końcu zadania, narzędzia agenta) działają. Subagenci pierwszoplanowi, `BackgroundItem` (Ctrl+B) i limity zasobów (sekcja 7) jeszcze nie.

Powiązane: [threads.md](threads.md), [transcript.md](transcript.md), [durability.md](durability.md).

## 1. Rodzaje pracy w wątku

| Rodzaj | Kto startuje | Czas życia | Na osi czasu |
|---|---|---|---|
| **Tura** | użytkownik, szyna agentów, **dostawca** (pobudka po zadaniu w tle), **odzysk** po restarcie | do `turn_finished` | `turns` + itemy z `turn_id` |
| **Subagent pierwszoplanowy** (tylko gdy agent ma `native_subagents`; domyślnie wyłączone, patrz [agent-bus.md](agent-bus.md)) | model w turze (Claude Agent, Codex `spawnAgent`) | w obrębie tury | item `subagent`, jego itemy z `parent_item_id` |
| **Zadanie w tle** | model (Claude background Bash, subagent w tle, workflow; Codex proces unified exec) albo użytkownik (`BackgroundItem`, odpowiednik Ctrl+B) | **niezależnie od tury**, może trwać po jej końcu | item `background_task` (+ `subagent` dla agenta w tle) |
| **Interakcja** | dostawca czeka na człowieka: zgoda, pytanie, formularz MCP | do odpowiedzi, wygaśnięcia albo zatrzymania wątku | item `interaction_prompt` + `interaction_requests` |
| **Wątek boczny** | użytkownik albo agent przez szynę (`spawn_thread`) — **domyślny sposób delegowania** | trwały | osobny wątek w drzewie ([threads.md](threads.md), [agent-bus.md](agent-bus.md)) |

### Subagenci dostawcy to nie wątki boczne

- **Subagent dostawcy** to wewnętrzna praca Claude/Codex w tym samym wątku. Platforma go pokazuje (zagnieżdżone itemy), może go zatrzymać, ale nie wznawia, nie forkuje i nie adresuje.
- **Wątek boczny** to obiekt platformy: trwały, z własnym placementem, forkowalny, widoczny w drzewie projektu.
- **Codex:** subagent ma własny wątek u dostawcy (`receiverThreadIds`, `agentThreadId`). Worker subskrybuje jego zdarzenia i mapuje je do wątku rodzica jako dzieci itemu `subagent` (`Subagent.provider_thread_id`). Nie powstaje dla niego wiersz w `threads`.
- **Claude:** wiadomości subagenta mają `parent_tool_use_id`; worker ustawia z niego `parent_item_id`.

## 2. Aktywność wątku

Jeden status nie wystarczy, bo wątek może nie mieć tury, a mieć zadania w tle. Worker wysyła `ThreadActivity` przy każdej zmianie:

- `status`: `idle | running | waiting_input | interrupted | failed`,
- `running_turn_id`,
- `background_task_ids`,
- `pending_interaction_ids`.

**Wątek jest zajęty**, gdy trwa tura, działa zadanie w tle albo czeka interakcja. Konsekwencje:

- zajętego wątku worker nie zwalnia z pamięci (`UnloadThread` jest odrzucane albo odkładane),
- UI pokazuje panel pracy w tle i skrzynkę interakcji per wątek i per projekt,
- `Heartbeat` niesie sumy (`running_turns`, `background_tasks`, `pending_interactions`) dla decyzji o drain.

## 3. Tury

### Wyzwalacze

| `trigger` | `turn_id` nadaje | Uwagi |
|---|---|---|
| `user` | gateway (przed wysłaniem) | kolejkowane w `turns` (`queued`); zeruje licznik przeskoków |
| `agent_bus` | gateway | `send_message`, `spawn_thread` albo powiadomienie zwrotne (`agent_call_id`, `hops > 0`) |
| `schedule` | gateway | harmonogram platformy (`schedule_id`) — [agent-bus.md](agent-bus.md#5-harmonogram) |
| `interaction` | gateway | wątek boczny pyta rodzica-agenta (`interaction_request_id`) — [agent-bus.md](agent-bus.md#4-interakcje-w-wątkach-bocznych) |
| `goal` | gateway | Claude: komenda `/goal …` jako tura celu (`goal_id`); kontynuacje Codexa są turami `provider` z `goal_id` — [goals.md](goals.md) |
| `provider` | worker | dostawca sam zaczyna turę: Claude po `task_notification` zadania w tle, Codex przy aktywnym celu; nigdy nie jest `queued` |
| `background_task` | gateway | notatka platformy o zakończonych zadaniach w tle wątku (sekcja 4, „Pobudka”); `hops` tury startowej zadania + 1 |
| `recovery` | worker | automatyczne wznowienie przerwanej tury (`resumes_turn_id`, `resume_reason`) |

Worker zna tylko pochodzenie tury (`TurnStarted.origin`: `COMMAND`, `PROVIDER`, `RECOVERY`). Wyzwalacz platformy zapisuje gateway. Dla `provider` / `recovery` gateway tworzy wiersz `turns` przy `turn_started` od workera.

### Serializacja

- W wątku trwa najwyżej jedna tura (`turns_one_running`). Tury `provider` mogą zacząć się w dowolnym momencie, więc **kolejność ustala worker**: ma per wątek trwałą skrzynkę wejść (w dzienniku) i startuje `StartTurn` dopiero, gdy wątek nie ma tury w toku.
- Wejście użytkownika w trakcie tury domyślnie czeka jako następna tura. **Wstrzyknięcie do tury w toku** to świadoma akcja (`SteerTurn`): Claude dokleja wiadomość do strumienia wejścia, Codex `turn/steer`.

### Przerwanie

- `InterruptTurn` przerywa **tylko turę**. Subagenci pierwszoplanowi kończą się z nią (`interrupted`).
- Zadania w tle działają dalej. Claude: worker deklaruje `perTaskStopAffordance: true`; bez tego przerwanie zabija zadania w tle.
- Zatrzymanie zadania w tle to osobna komenda `StopTask` (Claude `stopTask`, Codex zakończenie procesu / `closeAgent`).
- „Zatrzymaj wszystko” w UI = `InterruptTurn` + `StopTask` dla każdego zadania.
- Claude: zaimplementowane (`perTaskStopAffordance: true`, sprawdzone na żywo: zatrzymanie jednego zadania). Codex: przerwanie tury nie zatrzymuje procesów unified exec, które trwają po turze.

## 4. Zadania w tle

Zaimplementowane (2026-11-01). Decyzja użytkownika: długo żyjące procesy i zadania w tle harnessów są widoczne i da się je zatrzymać.

Cykl życia itemu `background_task` (`item_id = bg:<id>`): `in_progress` → `completed | failed | interrupted`. Pola: `task_id` (uchwyt do zatrzymania), `kind`, `command`, `description`, `output`, `started_in_turn_id`, `source_item_id` (item, który je uruchomił), `progress` (Claude: podsumowanie, zużycie), `started_at` / `ended_at` (worker stempluje je przy zdarzeniach zadania, gateway uzupełnia brakujące czasem zdarzenia; UI nie pokazuje już „Time unavailable” po przeładowaniu), `exit_code` (Codex).

`stop_reason` (słowa dla modelu i UI: `packages/domain/src/background-tasks`):

| `stop_reason` | Kiedy | Model czyta | UI |
|---|---|---|---|
| `stopped_by_user` | Stop w UI albo `stop_background_task` agenta | stopped by the user | Stopped by you |
| `stopped` | harness sam zatrzymał zadanie | stopped by the harness | Stopped by the harness |
| `error` | niezerowy kod wyjścia, błąd zadania (`failed`) | failed with exit code N | Failed · exit N |
| `worker_shutdown` | łagodne zatrzymanie workera (SIGTERM: restart, wdrożenie) | stopped because the worker was shut down for a restart or deploy | Stopped: worker restarted for a deploy |
| `worker_lost` | worker zginął bez zapisu zatrzymania (awaria, `kill -9`); zamknięte przy następnym starcie | lost: the worker process ended unexpectedly | Lost: the worker crashed |
| `worker_restart` | runtime dostawcy uruchomiony od nowa (zmiana ustawień, proces app-servera się zakończył) | stopped because the provider runtime was restarted | Stopped: provider runtime restarted |
| `drain`, `limit` | zarezerwowane (sekcje 7, 8) | | |

| | Codex (unified exec) | Claude (background Bash) |
|---|---|---|
| Start | komenda (`commandExecution` z `processId`) jeszcze trwa, gdy kończy się jej tura: tuż przed `turn_finished` powstaje item tła (`kind = PROCESS`, `task_id = processId`) z dotychczasowym outputem | `task_started` z `is_backgrounded` (albo później `task_updated.is_backgrounded`): `Bash` z `run_in_background`; `kind = SHELL` (`AGENT`, `WORKFLOW` dla innych typów) |
| Output | `item/commandExecution/outputDelta` z ID tury startowej trafiają już do itemu tła | worker czyta przyrostowo plik wyjścia (ścieżka z `tool_result`: „Output is being written to: …”, albo z `task_notification.output_file`), co sekundę |
| Koniec | `item/completed` komendy (kod wyjścia; niezerowy = `failed`) | `task_notification` (`completed`, `failed`, `stopped`); przed nim worker doczytuje plik |
| Zatrzymanie | `thread/backgroundTerminals/terminate { processId }` → `item/completed` ze statusem `failed` → item tła `interrupted`, `stopped_by_user` | `stopTask(task_id)` → `task_notification stopped` → `interrupted`, `stopped_by_user` |
| Pobudka harnessu | nigdy | po zakończeniu zadania Claude sam zaczyna turę (`system init` po `result`): tura `PROVIDER`; po zatrzymaniu nie |

Zasady:

- **Poza turą.** Zdarzenia zadania po zakończeniu jego tury nie mają `turn_id`. Item zachowuje `turn_id` tury startowej (z `item_started`). Ingest nie tworzy tury z niczego poza `turn_started` (`resolveTurn`), więc późny output nie robi „widmowych” tur. Codex: ID tury wiąże się z oczekującym `StartTurn` tylko przy `turn/started`, więc output starego procesu nie przejmie nowej tury.
- **Item komendy Codexa** zostaje `in_progress` do wyjścia procesu i pokazuje output z czasu tury; pełny output ma item tła.
- **Proces Claude Code żyje dłużej niż tura.** Adapter używa otwartego wejścia (streaming input) i `perTaskStopAffordance: true`: po `result` proces zostaje, dopóki działają zadania w tle; przerwanie tury ich nie zabija. Gdy nic już nie działa, proces czeka 3 s na turę, którą Claude może zacząć sam, i się kończy. `StartTurn` w tym czasie idzie do tego samego procesu.
- **UI:** `ui.Thread.background_tasks` (liczba w toku), itemy `background_task` w snapshotcie i na żywo, `StopBackgroundTask(thread_id, item_id)` → komenda `StopTask(thread_id, task_id)`. Zadanie, którego żaden proces już nie ma, a dziennik workera ma otwarte, jest zamykane jako przerwane.
- **Zgody z tła:** zadanie w tle może poprosić o zgodę po zakończeniu tury (`InteractionRequest` bez `turn_id`, z `item_id` zadania).
- **Agent sprawdza swoje zadania** narzędziami szyny `list_background_tasks`, `get_background_task`, `stop_background_task` ([agent-bus.md](agent-bus.md#zadania-w-tle)).

### Pobudka: agent dowiaduje się o każdym końcu zadania

Zaimplementowane (2026-11-02). Codex nigdy nie budzi się sam, a Claude tylko po zakończeniu (nie po zatrzymaniu i nie, gdy jego proces zginął), więc platforma mówi agentowi o każdym końcu zadania w tle.

- **Notatka** (`background_task_notes`, migracja `0024`): Ingest zapisuje ją w tej samej transakcji co koniec itemu, raz na zadanie (klucz `thread_id, item_id`; pierwszy koniec zadania jest jego końcem, późniejsze zamknięcie tego samego zadania przez inny proces niczego nie zmienia). Przeżywa restart gateway. Dostarcza ją `BackgroundTasks` (`apps/gateway/src/core/background-tasks.ts`): po zapisaniu zdarzeń (koniec zadania, start tury), gdy steer notatki nie wszedł do tury, i co 2 s (`tick`).
- **Treść** (`backgroundTaskNote`): które zadanie (`task_id` = `item_id`), polecenie, jak i dlaczego się skończyło, kiedy (start, koniec, czas trwania), kod wyjścia, ogon outputu (40 linii; przy kilku zadaniach 15), „uruchom ponownie, jeśli nadal potrzebne” przy restartach workera, i jak przeczytać więcej (`get_background_task`, `list_background_tasks`). Kilka zadań naraz (np. restart zabił trzy) = jedna notatka.
- **Dostarczenie:** gdy w wątku trwa tura, notatka wchodzi do niej jako steer platformy (`turn_steers.background_note`, bez autora). Bez tury w toku: nowa tura `trigger = background_task` z `hops` tury, która zadanie uruchomiła, + 1, więc zadanie, które w kółko uruchamia samo siebie, zatrzyma się na limicie przeskoków (8). Powyżej limitu notatka nie budzi wątku, tylko dołącza do następnej tury.
- **Steer, który nie wszedł** (tura skończyła się wcześniej, dostawca odmówił): notatka wraca do oczekujących i jest dostarczana od nowa (własna tura albo następna tura). Nigdy nie staje się turą użytkownika.
- **Zatrzymanie przez użytkownika:** bez tury pobudki (użytkownik wie, co zrobił). Notatka trafia do tury w toku, a bez niej do następnej tury, która się zacznie (steer zaraz po jej starcie). Zatrzymanie przez agenta (`stop_background_task`) nie daje notatki wcale: agent wie.
- **Claude bez podwójnych tur:** zadanie Claude, które skończyło się samo (`completed`, `failed` z błędem), czeka `graceMs` (15 s) od końca. Jeśli w tym czasie trwała albo zaczęła się tura wątku (Claude opisuje zadanie w turze, która trwała, albo zaczyna własną turę `provider`), notatka ma status `harness` i nic nie jest wysyłane. Inaczej (np. proces Claude Code się skończył) platforma dostarcza notatkę sama.
- **Wątek zarchiwizowany:** notatka `cancelled`.
- **UI:** tura `background_task` i steer notatki to zwarty wiersz systemowy na osi czasu (`BackgroundNoteRow`: „Background task stopped: worker restarted for a deploy · <nazwa>”, link do outputu zadania), nie wiadomość; `ui.Turn.background_item_ids`, `ui.Steer.background_item_ids`. Panel zadań pokazuje powód słowami i czas końca.
- Testy: `tests/integration/background-task-notes.test.ts` (skryptowany worker), `background-task-notes.live.test.ts` (Codex i Claude przez CLIProxyAPI: restart workera w trakcie zadania, notatka po restarcie, agent odpowiada, co się stało).

## 5. Subagenci

Domyślnie wyłączeni w obu harnessach; delegowanie idzie przez szynę agentów ([agent-bus.md](agent-bus.md)). Poniższe dotyczy agentów z włączonym `native_subagents`.


- Pierwszoplanowy: item `subagent` (`in_progress` → `completed | failed | interrupted`), postęp w `progress`, wynik w `result`. Wszystkie jego narzędzia, wiadomości i zgody są dziećmi tego itemu.
- W tle: dodatkowo `background = true` i `task_id`. Steruje nim się jak zadaniem w tle (`StopTask`).
- Zagnieżdżenie: subagent może uruchamiać subagentów (`spawn_depth`, `parent_task_id`). Głębokość ogranicza limit z sekcji 7.
- Szyna agentów z wnętrza subagenta: `AgentToolCall.item_id` wskazuje zagnieżdżony item narzędzia, więc wywołany wątek boczny jest podpięty pod właściwe miejsce na osi czasu.
- Zużycie tokenów subagentów wlicza się do tury i do budżetu wątku (`task_notification.usage`, `TaskProgress`).

## 6. Interakcje z użytkownikiem

| `kind` | Claude | Codex | Odpowiedź |
|---|---|---|---|
| `permission` | `canUseTool` | `item/commandExecution|fileChange|permissions/requestApproval` | `allow` / odmowa z powodem / `allow_for_session` / zmienione wejście |
| `question` | narzędzie `AskUserQuestion` (dialog) | `item/tool/requestUserInput` | `answer_json` albo `cancelled` |
| `elicitation` | MCP elicitation | `mcpServer/elicitation/request` | `answer_json` albo `cancelled` |

- Adresat zależy od `threads.interaction_route`: użytkownik albo, dla wątków bocznych tworzonych przez agenta, agent wątku głównego ([agent-bus.md](agent-bus.md#4-interakcje-w-wątkach-bocznych)). Użytkownik może odpowiedzieć zawsze.
- Gateway zapisuje `interaction_requests`, dodaje item `interaction_prompt` na oś czasu i powiadamia UI. Odpowiedź (kto, kiedy, co) trafia do tabeli i na oś czasu.
- Czas oczekiwania: zgoda ma termin (brak decyzji = odmowa), pytanie i formularz czekają do odpowiedzi albo zatrzymania wątku (`expires_at` opcjonalne).
- Po restarcie workera oczekujące interakcje zabitego procesu dostają `expired`. Jeśli dostawca wznowi turę (`recovery`), zapyta ponownie.

## 7. Limity i zasoby

Konfigurowane per worker (właściciel urządzenia), z możliwością zaostrzenia per agent:

- maksymalna liczba tur w toku na workerze,
- maksymalna liczba zadań w tle na wątek i na worker,
- maksymalny czas życia zadania w tle (po nim `StopTask`, `stop_reason = limit`),
- maksymalna głębokość subagentów,
- budżet tokenów/kosztu per tura i per wątek (z subagentami i zadaniami w tle).

Długo żyjące procesy (np. serwer deweloperski) są dozwolone, ale zawsze widoczne w panelu tła i zatrzymywane przy limitach, drain i `UnloadThread`.

## 8. Trwałość

Uzupełnienie [durability.md](durability.md#33-zatrzymanie-łagodne-drain-sigterm-aktualizacja):

- **Drain workera:** czeka na koniec tur do `drain_timeout`. Zadania w tle, które skończą się w tym czasie, kończą się normalnie. Pozostałe są zatrzymywane (`stop_reason = drain`), a ich output jest zapisywany jako blob przed wyjściem. (Do zrobienia; dziś patrz niżej.)
- **Łagodne zatrzymanie (SIGTERM: restart, wdrożenie)** — zaimplementowane: worker wysyła `DRAINING`, zatrzymuje runtime'y dostawców, póki łącze jeszcze działa (`WorkerHost.shutdown`), i zamyka ich zadania w tle w dzienniku jako `interrupted` z `stop_reason = worker_shutdown` i `ended_at`. Wysyła je i czeka do 3 s na potwierdzenie gateway (`flush`); dopiero potem zamyka łącze. Czego gateway nie potwierdził, idzie po następnym starcie z dziennika (trwałe). Agent dostaje notatkę (sekcja 4, „Pobudka”), a jego tura notatki czeka w outboxie, aż worker wróci; Codex wznawia wątek jak zwykle (`thread/resume`).
- **„Update when idle”** liczy także zadania w tle i oczekujące interakcje.
- **Restart po awarii:** zadania w tle i subagenci zabitego procesu dostają `interrupted` (`worker_lost`: proces nie zapisał zatrzymania; czas końca = chwila, w której nowy proces to stwierdził). Zaimplementowane dla zadań w tle: dziennik workera śledzi otwarte zadania w tej samej transakcji co ich zdarzenia (tabela `background_tasks`); przy starcie (`WorkerHost.recover`) i po zatrzymaniu runtime'u dostawcy (zmiana konfiguracji) worker zamyka te, których już nikt nie prowadzi. Tury są rozliczane z transkryptu harnessu (tabela `open_turns` i `turn_harness`; bez zapisanego końca `turn_finished` z powodem `worker restarted mid-turn`, przerwanie przez system; [durability.md](durability.md#35-rekoncyliacja-z-transkryptu-harnessu)), a gateway kończy też tury, których worker w `Hello.running_turns` nie zgłasza ([durability.md](durability.md#34-start-po-awarii)). Claude ma natywne automatyczne wznowienie przerwanej tury (`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, `resume_reason`); jeśli działa z lokalnym SDK, worker raportuje ją jako turę `recovery`. Do sprawdzenia w spike'u.
- Procesów w tle nie da się przenieść przez restart. Wznowiona tura dostaje informację, które zadania zostały przerwane.

## 9. Decyzje do podjęcia

1. **Domyślne limity:** zadania w tle na wątek, czas życia zadania, głębokość subagentów.
2. **Wejście w trakcie tury:** domyślnie kolejka (propozycja) czy wstrzyknięcie (`SteerTurn`)?
3. **Automatyczne wznowienie po restarcie** natywnym mechanizmem Claude (`recovery`) czy tylko na żądanie użytkownika ([durability.md](durability.md#11-decyzje-do-podjęcia), decyzja 1).
4. **Termin zgody:** jak długo czekać na decyzję, zanim zostanie potraktowana jako odmowa?
