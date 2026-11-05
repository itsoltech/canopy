# Transkrypt: zapis wszystkiego, co dzieje się w wątku

Status: **projekt**, kontrakt i schemat zaimplementowane (`ThreadEvent` w proto, `thread_events` / `thread_items` / `blobs` w `0001_init.sql`, reducer w `packages/domain`).

Wymaganie: frontend pokazuje **wszystko**: wiadomości, rozumowanie, każde narzędzie z wejściem i pełnym wynikiem, zmiany plików, plany, subagentów, zadania w tle, zgody, wywołania innych agentów i zdarzenia systemowe. Także to, co dzieje się **między turami**.

## 1. Zasady

1. **Nic nie ginie.** Każde zdarzenie dostawcy trafia do `thread_events`, także takie, którego jeszcze nie umiemy zmapować. Oryginał zawsze leży w `raw`.
2. **Nic nie jest przycinane.** Treść większa niż limit wiadomości trafia do `blobs` (adresowane sha256) i jest wskazywana przez `BlobRef`.
3. **Jedna oś czasu na wątek.** `seq` nadaje gateway przy zapisie. Zdarzenia workera i platformy (wejście użytkownika, decyzje o zgodach, szyna agentów, komunikaty) mają jedną, wspólną kolejność.
4. **Zdarzenia poza turą są pełnoprawne.** `turn_id` jest pusty, gdy zdarzenie nie należy do tury.
5. **Log + projekcja.** `thread_events` to log tylko do dopisywania (źródło prawdy). `thread_items` to bieżący stan każdego elementu, aktualizowany w tej samej transakcji tym samym reducerem, którego używa frontend.

## 2. Źródła zdarzeń

| Źródło | Przykłady | `origin` |
|---|---|---|
| Dostawca w turze | wiadomości, rozumowanie, komendy, zmiany plików, MCP, plan, subagenci | `worker` |
| Dostawca między turami | zadania w tle (Claude `SDKTask*`), kompaktowanie kontekstu, zmiana statusu wątku, zużycie tokenów, hooki | `worker` |
| Worker | `thread_ready`, przerwanie tury przez drain lub restart, błąd procesu dostawcy | `worker` |
| Gateway | wejście użytkownika (od razu, także gdy worker jest offline), prośba o zgodę i decyzja (kto, kiedy), wywołania szyny agentów, komunikaty platformy | `gateway` |

Worker nie wyłącza słuchania dostawcy po zakończeniu tury. Wątek z pracą w tle zostaje załadowany do jej końca i dopiero potem może być zwolniony.

## 3. Model zdarzeń

`ThreadEvent` (proto) ma kopertę i jedno ciało:

- koperta: `thread_id`, `event_id` (UUIDv7, klucz idempotencji), `journal_seq` (tylko do potwierdzeń workera), `turn_id` (pusty poza turą), `occurred_at`, `raw_json`,
- ciało: `thread_ready`, `turn_started`, `turn_finished` (wynik, `provider_turn_ref`, usage, powód), `item_started`, `item_delta`, `item_completed`, `status_changed`, `usage_updated`, `notice`.

**Item** to element osi czasu ze stabilnym `item_id` (Codex `item.id`, Claude `tool_use_id`, uuid wiadomości albo `task_id`), opcjonalnym `parent_item_id` (zagnieżdżenie subagentów) i statusem. Treść jest ściśle typowana:

| Typ itemu | Zawartość |
|---|---|
| `user_message` | tekst, załączniki (bloby), autor: użytkownik albo agent |
| `agent_message` | tekst, faza (`commentary` w trakcie pracy, `final_answer`) |
| `reasoning` | tekst, podsumowanie |
| `command_execution` | komenda, `cwd`, kod wyjścia, pełny output (inline albo blob), czas |
| `file_change` | lista zmian: ścieżka, rodzaj, diff (inline albo blob) |
| `tool_call` | serwer MCP / wbudowane, nazwa, wejście JSON, pełny wynik, błąd |
| `web_search` | zapytanie, wyniki |
| `plan`, `todo_list` | kroki / pozycje ze statusem |
| `subagent` | typ, opis, prompt, wynik, postęp, w tle czy nie, wątek subagenta u dostawcy (Codex); jego itemy mają `parent_item_id` |
| `background_task` | praca w tle (shell, agent, workflow, proces): tura startowa, postęp, pełny output, powód zatrzymania; może kończyć się po turze |
| `agent_bus_call` | wywołanie narzędzia szyny (`spawn_thread`, `send_message`, `wait_threads`, ...): argumenty, wynik, link do uruchomionego wątku i tury |
| `image` | blob, ścieżka, prompt |
| `context_compaction` | podsumowanie |
| `interaction_prompt` | zgoda, pytanie albo formularz MCP: żądanie, odpowiedź, adresat (`human` / `parent`), kto odpowiedział (użytkownik albo agent rodzica) i kiedy |
| `provider_item` | typ dostawcy bez dedykowanego mapowania, pełny JSON |

Strumieniowanie: `item_started` → `item_delta` (`text`, `summary`, `output`) → `item_completed` z pełnym, końcowym stanem.

## 4. Mapowanie dostawców

| Item | Claude Agent SDK | Codex app-server |
|---|---|---|
| `agent_message` | `assistant` (blok `text`), delty z `stream_event` | `agentMessage`, `item/agentMessage/delta` |
| `reasoning` | blok `thinking` | `reasoning`, `item/reasoning/textDelta`, `summaryTextDelta` |
| `command_execution` | `tool_use` Bash + `tool_result`, `tool_progress` | `commandExecution`, `item/commandExecution/outputDelta` |
| `file_change` | `tool_use` Edit/Write/MultiEdit + wynik | `fileChange`, `item/fileChange/patchUpdated` |
| `tool_call` | pozostałe `tool_use` + `tool_result` (Read, Grep, MCP, ...) | `mcpToolCall`, `dynamicToolCall` |
| `web_search` | `tool_use` WebSearch/WebFetch | `webSearch` |
| `plan` / `todo_list` | `tool_use` TodoWrite, tryb planu | `plan`, `turn/plan/updated` |
| `subagent` | `tool_use` Task; wiadomości z `parent_tool_use_id` jako dzieci | `collabAgentToolCall`, `subAgentActivity` |
| `background_task` | `task_started` (w tle) / `task_updated` (przeniesione do tła) / `task_notification`; output z pliku zadania | `commandExecution` z `processId`, który trwa po `turn/completed`; dalsze `outputDelta`, `item/completed` ([execution.md](execution.md#4-zadania-w-tle)) |
| `context_compaction` | `SDKCompactBoundaryMessage` | `contextCompaction`, `thread/compacted` |
| `image` | blok `image` | `imageView`, `imageGeneration` |
| `provider_item` | każdy inny typ wiadomości z treścią | `hookPrompt`, `enteredReviewMode`, `sleep`, ... |
| `notice` | `api_retry`, `rate_limit`, hooki, `permission_denied`, `notification` | `error`, `turn/moderationMetadata`, `thread/status/changed` |
| `usage_updated` | `result.usage`, `thinking_tokens` | `thread/tokenUsage/updated` |

Mapowanie sprawdzamy na przypiętych wersjach adapterów. Nowy typ dostawcy bez mapowania nie jest błędem: trafia do `thread_events` z `raw`, a jeśli ma treść, także jako `provider_item`.

## 5. Zapis po stronie gateway

W jednej transakcji per paczka zdarzeń wątku:

1. `SELECT ... FROM threads WHERE id = $1 FOR UPDATE` (serializacja zapisu w wątku),
2. odrzucenie zdarzeń, których `event_id` już jest,
3. nadanie kolejnych `seq` i `INSERT INTO thread_events`,
4. dla zdarzeń itemów: `reduceItem` (z `@canopy/domain`) i upsert `thread_items` (`first_seq`, `last_seq`),
5. aktualizacja `threads.last_seq`, `turns` (status, `first_seq` / `last_seq`, `provider_turn_ref`),
6. po commicie: `EventAck(journal_seq)` do workera i `NOTIFY` dla subskrybentów UI.

Bloby: worker wysyła `BlobChunk` przed zdarzeniem, które je wskazuje. Gateway sprawdza sha256 i zapisuje blob przed przyjęciem zdarzenia. Zdarzenie wskazujące brakujący blob jest odrzucane i zostaje w dzienniku workera do ponowienia.

### Obrazy

Każdy obraz, który widział model, ma podgląd na osi czasu: `Image.blob` (`view_image`, natywne odczyty, wygenerowane) albo `ToolCall.images` (obrazy w wynikach narzędzi). Worker robi podgląd przed zapisem zdarzenia i wysyła go jako `BlobChunk` przed zdarzeniem ([protocol.md](protocol.md#załączniki)); gateway wiąże blob z wątkiem (`thread_blobs`), a UI czyta go przez `GetThreadBlob` (właściciel, wątek z tego samego drzewa).

## 6. Frontend

1. **Snapshot:** `thread_items_view(thread_id)` zwraca itemy w kolejności `first_seq`, z odziedziczonymi z forków (`inherited`). Treść dużych pól pobiera się leniwie po `sha256`.
2. **Na żywo:** subskrypcja zdarzeń z `seq > max(last_seq)` i ten sam `reduceItem` po stronie przeglądarki.
3. **Wznowienie** po zerwaniu: od ostatniego `seq`.
4. **Pełna historia surowa** (debug, audyt): `thread_timeline(thread_id)`.

Dla itemów odziedziczonych z forka, które zmieniały się w źródle po punkcie forka (`changed_after_fork`, np. zadanie w tle), stan w punkcie forka odtwarza się z `thread_timeline`.

## 7. Retencja

- MVP: bez kompaktowania. Delty zostają w `thread_events`.
- Później: delty danego itemu można usunąć, gdy `item_completed` ma pełną treść. Dotyczy to tylko typów, dla których to sprawdzono.
- Bloby można przenosić do magazynu obiektów (`storage_url`) bez zmiany odwołań.
