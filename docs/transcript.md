# Transkrypt: zapis wszystkiego, co dzieje się w wątku

Status (2026-11-16): log zdarzeń, projekcja itemów i bloby obrazów są zaimplementowane,
w tym bezstratne wyniesienie obrazów wyników trybu kodu Codexa z `raw_json`
oraz trwały, oddzielny od rozliczeń pomiar bieżącego kontekstu głównej sesji.
Plany retencji oznaczono osobno poniżej; dostępność wydań opisuje [release.md](release.md).

Wymaganie: frontend pokazuje **wszystko**: wiadomości, rozumowanie, każde narzędzie z wejściem i pełnym wynikiem, zmiany plików, plany, subagentów, zadania w tle, zgody, wywołania innych agentów i zdarzenia systemowe. Także to, co dzieje się **między turami**.

## 1. Zasady

1. **Trwałe przyjęcie przed ACK.** Zdarzenia dostawcy trafiają do `thread_events`, także bez mapowania. `raw` zachowuje JSON po zastąpieniu NUL i niesparowanych surogatów znakiem U+FFFD; dokładne bajty obrazów wyników trybu kodu Codexa mogą zostać zastąpione referencją do blobu dopiero po ich zapisaniu i wzbogaceniu itemu (poniżej). Inny błąd danych SQLSTATE `22xxx` zapisuje oryginalny protobuf w `worker_event_quarantine` oraz ostrzeżenie w historii, atomowo z kursorem journalu; odrzucone zdarzenie nie wykonuje projekcji. [Reguły trwałości](durability.md#31-dziennik-lokalny).
2. **Treść dostawcy nie jest przycinana.** Treść większa niż limit wiadomości trafia do `blobs` (adresowane sha256) i jest wskazywana przez `BlobRef`. Wyjątek dla jawnych komend powłoki właściciela: worker przechwytuje ograniczony początek i koniec outputu, z oznaczeniem pominiętego środka (poniżej).
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
| `usage_updated` | `assistant.message.usage`, usage ze `stream_event`, limit z `result.modelUsage` | `thread/tokenUsage/updated`: rozliczenia z `total`, kontekst z `last` |

Mapowanie sprawdzamy na przypiętych wersjach adapterów. Nowy typ dostawcy bez mapowania nie jest błędem: trafia do `thread_events` z `raw`, a jeśli ma treść, także jako `provider_item`.

### Bieżące okno kontekstu

`UsageUpdated.context_usage` oraz `ui.Thread.context_usage` mają wspólny typ
`ContextUsage`: opcjonalne `used_tokens` i `limit_tokens`. To najnowszy pomiar
głównej sesji zgłoszony przez harness, niezależny od rozliczeń `Usage` i historii
tur. Brak pola oznacza niewiadomą, a `used_tokens = 0` jest poprawnym pomiarem.
UI może pokazać procent dopiero przy znanym zużyciu i dodatnim limicie. Nie
sumuje tur, nie dodaje cache drugi raz, nie wyprowadza limitu z nazwy modelu
ani katalogu modeli.

Źródła i znaczenie pól:

- **Codex 0.164.0:** `thread/tokenUsage/updated.tokenUsage.last.totalTokens`
  opisuje ostatnie wywołanie modelu (input wraz z output); `total` jest
  skumulowanym rozliczeniem sesji i pozostaje w dotychczasowym `Usage`.
  `modelContextWindow` to limit zgłoszony przez harness, bez lokalnego fallbacku.
  `cachedInputTokens` jest częścią input i nie powiększa `last.totalTokens`.
  Źródła: [przypięty kontrakt ThreadTokenUsage](../packages/codex-protocol/src/gen/v2/ThreadTokenUsage.ts),
  [TokenUsageBreakdown](../packages/codex-protocol/src/gen/v2/TokenUsageBreakdown.ts)
  i [nagranie kilku wywołań w jednej turze](../apps/worker/src/providers/codex/fixtures/tools-turn.jsonl).
- **Claude Agent SDK 0.3.316:** wyłącznie główne wiadomości (`parent_tool_use_id`
  pusty), bez syntetycznych odpowiedzi i komunikatów błędów. Zużycie jednej
  odpowiedzi API to `input_tokens + cache_creation_input_tokens +
  cache_read_input_tokens + output_tokens`; początek strumienia i `assistant`
  dają usage odpowiedzi, a `message_delta.usage` zastępuje końcowy licznik output,
  także gdy blok `assistant` przyszedł wcześniej. Nie dodajemy kolejnych bloków
  tej samej wiadomości. Limit pochodzi z `result.modelUsage[model].contextWindow`
  dla dokładnego modelu ostatniej głównej odpowiedzi; inny model/subagent nie
  dostarcza zastępczego limitu. Przed pierwszym takim raportem limit jest nieznany.
  `result.usage` sumuje wywołania głównej pętli w turze, a tokeny w `modelUsage`
  obejmują wiele wywołań i subagentów; żaden z tych agregatów nie mierzy kontekstu.
  Źródła: [typy i komentarze przypiętego SDK](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.316/sdk.d.ts)
  (`SDKAssistantMessage`, `SDKPartialAssistantMessage`, `SDKResultMessage`, `ModelUsage`)
  oraz [nagranie kolejnych odpowiedzi](../apps/worker/src/providers/claude/fixtures/tools-turn.jsonl).
- **Grok ACP:** `session/update` z `usage_update` dostarcza bieżące `used`
  i pojemność `size`, niezależnie od kosztu `cost`. Oba pola trafiają do
  `ContextUsage`; zerowy albo niepoprawny limit pozostaje nieznany.
  Źródła: [schemat ACP](https://agentclientprotocol.com/protocol/schema),
  [typ SessionUpdate](../packages/grok-acp/src/types.ts)
  i [adapter](../apps/worker/src/providers/grok/mapping.ts).

Każdy raport zastępuje poprzedni w całości; mniejszy pomiar po kompaktowaniu
jest poprawny. Puste `context_usage` unieważnia poprzedni pomiar po granicy
kompaktowania Claude lub zdarzeniu kompaktowania Codexa, aż dostawca zgłosi
następny. Claude `conversation_reset` (m.in. `/clear`) również unieważnia pomiar.
Udany rewind/restore unieważnia pomiar poprzedniej sesji. Fork nie
kopiuje zużycia źródła. To ostatnia obserwacja dostawcy, bez lokalnego szacowania
nowo wpisanego promptu, wyników narzędzi ani liczby tokenów między raportami.

Gateway zapisuje `threads.context_usage` w transakcji przyjęcia zdarzenia,
a następnie publikuje nowy `Thread` do obserwatorów, overview i checkpointów.
Reconnect i nowy proces gatewaya czytają ten sam pomiar; paginacja historii
nie ma wpływu. Starsze zdarzenie `usage_updated` bez nowego pola nie zmienia
pomiaru. Migracja nie zgaduje wartości na podstawie dawnych agregatów.
Pola proto są addytywne, bez zmiany `WORKER_LINK_PROTOCOL`.

## 5. Zapis po stronie gateway

W jednej transakcji per paczka zdarzeń wątku:

1. `SELECT ... FROM threads WHERE id = $1 FOR UPDATE` (serializacja zapisu w wątku),
2. odrzucenie zdarzeń, których `event_id` już jest,
3. nadanie kolejnych `seq` i `INSERT INTO thread_events`,
4. dla zdarzeń itemów: `reduceItem` (z `@canopy/domain`) i upsert `thread_items` (`first_seq`, `last_seq`),
5. aktualizacja `threads.last_seq`, `turns` (status, `first_seq` / `last_seq`, `provider_turn_ref`),
6. po commicie: `EventAck(journal_seq)` do workera i `NOTIFY` dla subskrybentów UI.

Sąsiadujące `item_delta` tego samego itemu, pola i tury pozostają osobnymi wierszami
dziennika, ale w jednej transakcji reduktor ładuje projekcję raz i zapisuje ją raz.
Granica przed innym itemem, zdarzeniem kończącym lub zmianą tury opróżnia partię.
Snapshot widzi tylko stan przed albo po transakcji, więc reconnect i restart mogą
odtworzyć każdy delta z `payload`; `first_seq` pozostaje sekwencją pierwszego zapisu
itemu, a `last_seq` ostatnią deltą, która faktycznie zmieniła projekcję.

Bloby: worker wysyła `BlobChunk` przed zdarzeniem, które je wskazuje. Gateway sprawdza sha256 i zapisuje blob przed przyjęciem zdarzenia. Zdarzenie wskazujące brakujący blob jest odrzucane i zostaje w dzienniku workera do ponowienia.

### Obrazy

Każdy obraz, który widział model, ma podgląd na osi czasu: `Image.blob` (`view_image`, natywne odczyty, wygenerowane) albo `ToolCall.images` (obrazy w wynikach narzędzi). Worker robi podgląd przed zapisem zdarzenia i wysyła go jako `BlobChunk` przed zdarzeniem ([protocol.md](protocol.md#załączniki)); gateway wiąże blob z wątkiem (`thread_blobs`), a UI czyta go przez `GetThreadBlob` (właściciel, wątek z tego samego drzewa).

**Wyniki trybu kodu Codexa.** `rawResponseItem/completed` z
`custom_tool_call_output` albo wynikiem `wait` (`function_call_output`) wskazuje
item przez `call_id`, niezależnie od własnego `id` wyniku. Obrazy z
`output[].input_image.image_url` są zapisywane jako dokładne bajty PNG/JPEG/WebP/GIF
do 8 MiB (limit istniejącego transportu blobów), bez ponownego kodowania.
Worker najpierw zapisuje i synchronizuje plik, dodaje `ToolCall.images`, a dopiero
potem czysta transformacja skraca `raw_json`, przed dopisaniem zdarzenia do journalu.
`image_url` przyjmuje obiekt
`{canopyBlob: {sha256, sizeBytes, mimeType}, dataUrlPrefix}`; `sizeBytes` jest
dziesiętnym stringiem jak w JSON `BlobRef`. Prefiks URI i bajty blobu pozwalają
odtworzyć pierwotne URI base64. Typ bloku, jego pozycja, `detail`, identyfikatory,
metadane dostawcy i wszystkie pozostałe pola pozostają w JSON. Treść tekstowa,
audio, szyfrowane i nierozpoznane bloki nie są usuwane ani skracane.

Transformacja wymaga zgodności hasha, rozmiaru i typu z referencją itemu; nie
powiększa `raw_json`. Niepoprawne, niekanoniczne base64, zewnętrzne URL-e,
nieobsługiwane typy, obrazy ponad limit oraz błąd dekodowania lub zapisu pozostawiają
obraz inline. Kilka wyników tej samej komórki zachowuje pełny dotychczasowy tekst
i zebrane referencje obrazów. Oryginalny rollout harnessu pozostaje bez zmian;
optymalizacja obejmuje nowe zdarzenia, bez przepisywania zapisanej historii.

Pliki blobów starsze niż siedem dni są sprzątane przy starcie dopiero po odczycie
journalu. Referencje zdarzeń czekających na ACK, także ze wstrzymaną dostawą,
chronią pliki przed usunięciem. Po ACK gateway posiada blob związany z wątkiem;
lokalna kopia może zostać usunięta przy następnym sprzątaniu.

### Wynik komendy właściciela

`shell_input_prepared` zapisuje stan `running`, potem jeden końcowy `completed`, `failed`
albo `interrupted`. Gateway w tej samej transakcji aktualizuje JSONB wejścia tury i steera
po `shell_input_id`, również tury powstałej po odrzuceniu steera. Końcowy wynik jest niezmienny;
powtórzone zdarzenia nie nadpisują go. Nie potrzeba migracji PostgreSQL.

Wejście zachowuje komendę, cwd, kod wyjścia, ograniczony wynik i dokładny tekst dostarczony
harnessowi. Inne urządzenia, przeładowanie strony i replay po reconnect pokazują te same dane.
UI renderuje je jako komendę z akcentem rose, plakietką kodu i zwiniętym outputem, zamiast
zwykłej wiadomości `!…`. Pełny tekst wejścia można rozwinąć. Nieudany albo przerwany wynik
nie jest dostarczany agentowi. Limity i restart opisuje [protocol.md](protocol.md#komendy-powłoki-właściciela).

## 6. Frontend

1. **Snapshot:** `thread_items_view(thread_id)` zwraca itemy w kolejności `first_seq`, z odziedziczonymi z forków (`inherited`). Zakończona wiadomość agenta dostaje `completed_at`: `occurred_at` zdarzenia o jej `last_seq` (granica segmentów tury, docs/timeline-folding.md). Treść dużych pól pobiera się leniwie po `sha256`.
2. **Na żywo:** subskrypcja zdarzeń z `seq > max(last_seq)` i ten sam `reduceItem` po stronie przeglądarki.
3. **Wznowienie** po zerwaniu: od ostatniego `seq`.
4. **Pełna historia surowa** (debug, audyt): `thread_timeline(thread_id)`.

Dla itemów odziedziczonych z forka, które zmieniały się w źródle po punkcie forka (`changed_after_fork`, np. zadanie w tle), stan w punkcie forka odtwarza się z `thread_timeline`.

Delty tekstu są dopisywane bez przycinania, także gdy zawierają wyłącznie spację,
tabulator albo nową linię. Koalescencja łączy je w kolejności przez pusty separator;
nie normalizuje białych znaków. Sanitizacja przed zapisem zastępuje wyłącznie NUL
i niesparowane surogaty przez U+FFFD. Nie usuwa spacji Unicode ani zakończeń linii.

## 7. Retencja

- `thread_events` nie są usuwane ani zmieniane sekwencyjnie: zachowują payloady,
  granice forków, notice, kwarantannę i kursory ACK.
- Po godzinie od zapisu, gdy wątek nie ma aktywnej tury ani otwartego itemu,
  maintenance skanuje najwyżej 256 zdarzeń pod blokadą wątku. Dla znanych
  `item_started`, `item_delta` i `item_completed` zastępuje tylko długie teksty,
  które są dokładną kopią tekstu w tym samym payloadzie, wartością `null` i ścieżką
  w `raw_payload_refs`. `thread_event_raw(raw,payload,raw_payload_refs)` odtwarza
  pełny JSON dostawcy; metadane, identyfikatory i nieznane pola pozostają dostępne.
- Zdarzenia z obrazami, notice i bez mapowania zachowują pełny `raw`. Wiersze po
  purge nie są kompaktowane; kursor `thread_transcript_compaction` omija już
  sprawdzone stare wiersze i nie pozwala, by nieredukowalny obraz blokował późniejszy
  tekst.
- Bloby można przenosić do magazynu obiektów (`storage_url`) bez zmiany odwołań.
