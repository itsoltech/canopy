# Wykonanie wątku: tury, praca w tle, subagenci, interakcje

Status: **projekt**. Kontrakt (`TurnOrigin`, `ThreadActivity`, `BackgroundTask`, `Subagent`, `InteractionRequest`, komendy `SteerTurn` / `StopTask` / `BackgroundItem`) i schemat (`turns.trigger`, `interaction_requests`) są zaimplementowane. Zachowanie workera powstanie w spike'u adapterów.

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
| `goal` | gateway | kontynuacja celu przez silnik platformy (`goal_id`); przy silniku natywnym kontynuacje są turami `provider` z `goal_id` — [goals.md](goals.md) |
| `provider` | worker | dostawca sam zaczyna turę, np. Claude po `task_notification` zadania w tle; nigdy nie jest `queued` |
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

## 4. Zadania w tle

Cykl życia itemu `background_task`: `in_progress` → `completed | failed | interrupted` (`stop_reason`: `stopped_by_user`, `drain`, `worker_restart`, `limit`, `error`).

| | Claude | Codex |
|---|---|---|
| Start | `task_started` (`task_id`, `tool_use_id`, `task_type`, `is_backgrounded`, `parent_task_id`, `spawn_depth`) | `commandExecution` z `processId` (unified exec) |
| Postęp | `task_progress` (tokeny, użycia narzędzi, ostatnie narzędzie, podsumowanie), `task_updated` | `item/commandExecution/outputDelta`, `terminalInteraction` |
| Output | **plik** `output_file` | strumień delt |
| Koniec | `task_notification` (`completed | failed | stopped`, podsumowanie, usage) | `item/completed` |
| Zatrzymanie | `stopTask(task_id)` | zakończenie procesu |
| Lista | `background_tasks_changed` | stan procesów w workerze |

- **Output z pliku (Claude):** worker czyta `output_file` przyrostowo i wysyła delty `OUTPUT`, a po zakończeniu cały plik jako blob. Item jest kompletny dopiero, gdy blob jest zapisany w gateway.
- **Pobudka:** zakończenie zadania może sprawić, że dostawca sam zacznie turę (`trigger = provider`). To normalny przypadek, nie błąd.
- **Zgody z tła:** zadanie w tle może poprosić o zgodę po zakończeniu tury (`InteractionRequest` bez `turn_id`, z `item_id` zadania).

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

- **Drain workera:** czeka na koniec tur do `drain_timeout`. Zadania w tle, które skończą się w tym czasie, kończą się normalnie. Pozostałe są zatrzymywane (`stop_reason = drain`), a ich output jest zapisywany jako blob przed wyjściem.
- **„Update when idle”** liczy także zadania w tle i oczekujące interakcje.
- **Restart po awarii:** zadania w tle i subagenci zabitego procesu dostają `interrupted` (`worker_restart`). Claude ma natywne automatyczne wznowienie przerwanej tury (`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, `resume_reason`); jeśli działa z lokalnym SDK, worker raportuje ją jako turę `recovery`. Do sprawdzenia w spike'u.
- Procesów w tle nie da się przenieść przez restart. Wznowiona tura dostaje informację, które zadania zostały przerwane.

## 9. Decyzje do podjęcia

1. **Domyślne limity:** zadania w tle na wątek, czas życia zadania, głębokość subagentów.
2. **Wejście w trakcie tury:** domyślnie kolejka (propozycja) czy wstrzyknięcie (`SteerTurn`)?
3. **Automatyczne wznowienie po restarcie** natywnym mechanizmem Claude (`recovery`) czy tylko na żądanie użytkownika ([durability.md](durability.md#11-decyzje-do-podjęcia), decyzja 1).
4. **Termin zgody:** jak długo czekać na decyzję, zanim zostanie potraktowana jako odmowa?
