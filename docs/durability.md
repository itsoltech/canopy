# Trwałość, graceful shutdown i aktualizacje w trakcie działania

Status: **projekt** (2026-11-01). Wymaganie: zatrzymanie lub aktualizacja dowolnego procesu nie gubi stanu i nie kończy się błędem widocznym dla użytkownika. Wyjątkiem jest tura agenta przerwana twardym zabiciem procesu (patrz [macierz awarii](#9-macierz-awarii)).

Powiązane: [architecture.md](architecture.md), [protocol.md](protocol.md), [data-model.md](data-model.md).

## 1. Zasady

1. **Crash-only.** Poprawność nie zależy od graceful shutdown. SIGKILL, OOM albo zanik zasilania nie mogą zgubić stanu, który system już potwierdził. Graceful shutdown tylko skraca przerwę i pozwala uniknąć przerwanych tur.
2. **Najpierw zapis, potem efekt (write-ahead).** Komenda trafia do PostgreSQL, zanim pójdzie do workera. Zdarzenie trafia do lokalnego dziennika workera, zanim pójdzie do gateway. ACK wychodzi dopiero po commicie.
3. **At-least-once i idempotencja na każdym styku.** Klucze: `command_id`, `(thread_id, event_id)`, `call_id`, `request_id`. Także identyfikator generowany przez UI dla każdej akcji użytkownika.
4. **Pamięć to tylko cache.** Każdy proces po starcie odtwarza stan z trwałego nośnika: gateway z PostgreSQL, worker z SQLite i plików historii dostawcy.
5. **Wersje N i N+1 działają razem.** Proto zmieniamy tylko addytywnie. Migracje bazy idą w trybie expand/contract. Nieznane pola i wartości enumów są tolerowane.
6. **Efektów ubocznych agenta nie powtarzamy automatycznie.** Komendy shell i zmiany plików mogły się wykonać częściowo. Granicą bezpiecznego wznowienia jest tura, nie pojedyncze narzędzie.

## 2. Inwentarz stanu

| Stan | Nośnik | Po restarcie |
|---|---|---|
| Użytkownicy, projekty, agenci, workery, wątki, tury, transkrypty | PostgreSQL | bez zmian |
| Komendy gateway → worker | PostgreSQL `worker_commands` (outbox) | ponowne dostarczenie, worker deduplikuje po `command_id` |
| Zdarzenia wątków jeszcze niepotwierdzone przez gateway (także między turami) | SQLite workera `journal` | dosłanie po `Welcome`, deduplikacja po `event_id` |
| Rejestr wątków na workerze (`thread_id` ↔ wątek dostawcy, `cwd`, profil, tura w toku, ostatnie `seq`) | SQLite workera `threads` (cache; źródłem prawdy jest `ThreadSpec` z gateway) | wznowienie albo oznaczenie tury jako przerwanej |
| Historia wątku agenta SDK | pliki dostawcy (`~/.claude/projects`, `~/.codex/sessions`) | Claude `resume`, Codex `thread/resume` |
| Przetworzone `command_id` | SQLite workera `processed_commands` (TTL) | deduplikacja |
| Interakcje (zgody, pytania, formularze) | PostgreSQL `interaction_requests` + SQLite workera | proces dostawcy zginął → `expired` |
| Zadania w tle i subagenci w toku | itemy w `thread_items`; otwarte zadania w dzienniku workera (`background_tasks`); procesy tylko na workerze | `interrupted` (`worker_restart`), output zostaje taki, jaki przyszedł deltami ([execution.md](execution.md#8-trwałość)) |
| Cele | PostgreSQL `goals` (odbicie celu harnessu: ostatni raport w `native_state`) | gateway nie ustawia celu ponownie; Codex trzyma go w stanie wątku, cel Claude ginie z procesem ([goals.md](goals.md#6-trwałość)) |
| Konfiguracja workera | PostgreSQL `worker_configs` (+ historia); w workerze tylko w pamięci (sekrety) | po starcie `Hello.config_version = 0`, gateway wysyła ją ponownie |
| Harmonogramy | PostgreSQL `schedules`, odpalane przez gateway z dzierżawą | po przestoju jedna tura nadrabiająca albo pominięcie (`missed_policy`) |
| Wywołania szyny agentów | PostgreSQL `agent_bus_calls` (wynik, powiadomienie jako outbox) + SQLite workera | ponowienie po `call_id` |
| Tury agentów czatowych | PostgreSQL `turns` (kolejka z dzierżawą) | inna instancja przejmuje po wygaśnięciu dzierżawy |
| Połączenia workerów, subskrypcje UI | pamięć | odtwarzane przez ponowne połączenie |
| Delty tekstu w locie | ulotne | pełna wiadomość jest trwała |

## 3. Worker

### 3.1 Dziennik lokalny

**Zaimplementowany:** `apps/worker/src/journal` (serwis Effect `Journal`) i `apps/worker/src/gateway-link/delivery.ts` (`journalHello`, `resendPending`, `applyAck`). Testy jednostkowe na pliku SQLite oraz test integracyjny przez gRPC: zdarzenia zapisane offline, częściowe potwierdzenie, ponowne połączenie z dosłaniem tylko niepotwierdzonych, deduplikacja po `event_id`, nowy dziennik po reinstalacji.

`bun:sqlite` w trybie WAL z `synchronous = FULL`, żeby przetrwać zanik zasilania, nie tylko awarię procesu. `journal_seq` rośnie per wątek i nigdy się nie cofa (tabela `thread_seq`), także po potwierdzeniu wszystkich zdarzeń i restarcie. Tabele: `threads`, `journal`, `processed_commands`, `pending_interactions`, `pending_bus_calls`. Jeden plik w katalogu danych workera z uprawnieniami 0600.

### 3.2 Wątki dostawców

- **Claude:** nowy wątek startuje z `sessionId = thread_id` platformy (identyfikator znany przed pierwszym zdarzeniem); fork przez `forkSession` daje nowy identyfikator. `persistSession: true`. Wznowienie przez `resume: provider_thread_id`.
- **Codex:** `thread.id` trafia do dziennika i do gateway (`thread_ready`) zaraz po `thread/start` / `thread/fork`, przed pierwszą turą. Wznowienie przez `thread/resume`.
- Dziennik i rejestr wątków są aktualizowane, zanim zdarzenie wyjdzie do gateway.

### 3.3 Zatrzymanie łagodne (drain): SIGTERM, aktualizacja

```mermaid
sequenceDiagram
    autonumber
    participant S as Supervisor (systemd / launchd / usługa Windows)
    participant W as Worker
    participant P as Wątki dostawców
    participant GW as Gateway

    S->>W: SIGTERM
    W->>GW: Heartbeat(state = DRAINING)
    Note over W: nowe tury (CreateThread, StartTurn)<br/>odrzucane z WORKER_DRAINING,<br/>gateway trzyma je w outboxie
    W->>P: czeka na koniec bieżących tur (do drain_timeout)
    alt tura nie skończyła się w czasie
        W->>P: interrupt (Claude interrupt(), Codex turn/interrupt)
        W->>GW: ThreadEvent(turn_finished: interrupted, powód: drain)
    end
    W->>GW: dosłanie dziennika, czekanie na EventAck
    W->>W: zamknięcie procesów dostawców, zamknięcie SQLite
    W-->>S: exit 0
```

- `drain_timeout` jest konfigurowalny. Aktualizacja workera domyślnie czeka na brak aktywnych tur („update when idle”) z maksymalnym terminem.
- Jeśli gateway jest niedostępny w trakcie drain, zdarzenia zostają w dzienniku i zostaną dosłane po starcie. Drain się nie blokuje.

### 3.4 Start po awarii

1. Otwarcie dziennika. Tury w toku dostają `turn_finished` (`interrupted`, powód: `worker restarted`). **Zaimplementowane:** dziennik śledzi otwarte tury w tej samej transakcji co ich zdarzenia (tabela `open_turns`, jak `background_tasks`), a `WorkerHost.recover` dopisuje ich koniec przy starcie.
2. Prośby o zgodę i wywołania szyny przypięte do zabitych procesów dostają `expired`. **Zaimplementowane w gateway** dla zgód tur, które gateway kończy (punkt 5).
3. Połączenie, `Hello` z kursorami wątków i turami, które proces prowadzi (`running_turns`, capability `running_turns`), dosłanie dziennika.
4. Przerwane tury są wznawiane według polityki (decyzja 1 w sekcji 11). Na razie nie są: kończą się `interrupted`, a wątek przechodzi do następnej tury z kolejki.
5. **Gateway** po `Hello` (najpierw odczyt outboxu, potem to): tury `running` wątków tego workera spoza `running_turns` kończą się `interrupted` z powodem `worker restarted` (`ui.Turn.interrupt_reason`). To łapie także tury, których dziennik nie zna (stary proces bez śledzenia tur, nowy dziennik). Ich oczekujące interakcje wygasają, steery `pending`/`accepted` są `dropped` (pump kolejkuje je z powodem), kolejka wątku rusza. `InterruptTurn` dla tury, której worker nie prowadzi (`TURN_NOT_RUNNING`), kończy ją tak samo.
6. Wątek Codexa bez żadnej tury nie ma rolloutu, więc nowy proces nie może go wznowić (`thread/resume: no rollout found`): worker zaczyna nowy wątek Codexa z tym samym `thread_id` platformy i zgłasza go w `thread_ready.replaces_provider_thread_id` ([codex-adapter.md](codex-adapter.md#runtime-wątków)).

### 3.5 Opcja na później: host wątków niezależny od workera

Procesy dostawców w osobnym procesie, który przeżywa restart procesu workera. Worker po aktualizacji podłącza się do niego przez lokalny socket. Daje aktualizację workera bez przerywania długich tur, ale sporo kosztuje: osobny proces, IPC, własny cykl życia. Wracamy do tego, jeśli drain okaże się niewystarczający.

## 4. Gateway

### 4.1 Bez stanu tylko w pamięci, N ≥ 1 instancji

Każda instancja może obsłużyć dowolne żądanie. Wdrożenie może zacząć się od jednej instancji. Projekt nie może tego jednak zakładać, bo aktualizacja bez przerwy to rolling update na co najmniej dwóch instancjach.

### 4.2 Outbox komend

```mermaid
sequenceDiagram
    autonumber
    participant UI
    participant GA as Gateway A (przyjmuje żądanie)
    participant DB as PostgreSQL
    participant GB as Gateway B (ma połączenie workera)
    participant W as Worker

    UI->>GA: SendMessage(thread_id, client_request_id)
    GA->>DB: INSERT turns + worker_commands(StartTurn) ON CONFLICT (client_request_id) DO NOTHING
    GA->>DB: NOTIFY worker_commands, worker_id
    GA-->>UI: przyjęte (command_id)
    DB-->>GB: notyfikacja
    GB->>DB: SELECT pending ... FOR UPDATE SKIP LOCKED
    GB->>W: Command(command_id)
    W-->>GB: CommandResult
    GB->>DB: UPDATE worker_commands (completed | failed)
    DB-->>UI: zdarzenie wyniku (przez subskrypcję)
```

- Każda komenda ma `expires_at` zależne od typu. `InterruptTurn` i `UnloadThread` mają sens krótko. `CreateThread` i `StartTurn` mogą czekać na powrót workera. Przeterminowana komenda kończy się błędem widocznym w UI.
- Po `Welcome` instancja dosyła wszystkie `pending` i `delivered` bez wyniku. Worker deduplikuje po `command_id` i odsyła zapamiętany wynik.
- **Własność połączenia:** `worker_connections(worker_id, instance_id, epoch)`. Nowe połączenie podbija `epoch`, a stara instancja zamyka swoje (fencing). Wynik komendy z nieaktualnego `epoch` jest ignorowany.

- **Jedna tura startuje raz.** Planista tur działa z wielu miejsc naraz (koniec tury, nowa wiadomość, kilka instancji). Unikalny indeks `worker_commands_one_start` dopuszcza jeden żywy `StartTurn` na turę; przegrany przebieg uznaje, że turę wystartował ktoś inny (wcześniej dwa przebiegi mogły wystartować tę samą turę dwa razy).

### 4.3 Transkrypt i zdarzenia live

- `INSERT ... ON CONFLICT (thread_id, seq) DO NOTHING`, `EventAck` po commicie (już w protokole).
- **Jeden wątek nie blokuje pozostałych.** Zdarzenia są zapisywane w transakcji na wątek (`Ingest`). Gdy zapis wątku się nie uda, ten wątek nie dostaje `EventAck`, a jego kolejne zdarzenia na tym połączeniu są pomijane (żeby nie trafiły do bazy w złej kolejności). Pozostałe wątki są zapisywane i potwierdzane. Gateway prosi workera o ponowne połączenie (`Drain`, 10 s), a worker wysyła niepotwierdzone zdarzenia ponownie ze swojego dziennika.
- **Utracone `turn_finished`.** Dostawca prowadzi jedną turę naraz w wątku. Gdy zaczyna kolejną, a tura w bazie nadal jest `running` (np. po awarii dostawcy), gateway zamyka ją jako `interrupted` (`superseded`). Wcześniej ten stan łamał `turns_one_running` i zatrzymywał cały strumień workera (zdarzenie, które po każdym połączeniu psuło zapis od nowa).
- Zdarzenia live do UI idą przez `NOTIFY` z `(thread_id, seq)`. Instancja z subskrypcją UI czyta wiersze z bazy. Działa przy N instancjach, a UI po ponownym połączeniu wznawia od swojego `seq`.

### 4.4 Tury agentów czatowych

- Tury wątków `runtime = gateway` (`turns`) to kolejka z dzierżawą: `SELECT ... FOR UPDATE SKIP LOCKED`, `lease_until`, przedłużanie heartbeatem.
- Każde wywołanie narzędzia przez agenta czatowego jest zapisywane z wynikiem, zanim tura pójdzie dalej. Powtórzona tura nie wykonuje drugi raz narzędzia, które ma zapisany wynik.
- Po śmierci instancji dzierżawa wygasa i inna instancja powtarza turę od ostatniego zapisanego stanu. Delty z przerwanej próby są ulotne. UI dostaje zdarzenie „ponowienie tury”.

### 4.5 Szyna agentów

- `agent_bus_calls.id = call_id`. Worker po ponownym połączeniu ponawia `AgentToolCall`; gateway zwraca zapisany wynik zamiast wykonywać drugi raz (nie powstaje drugi wątek boczny).
- Powiadomienia zwrotne to outbox (`notify_status = pending` → `delivered` z turą w wątku wywołującym). Przeżywają restart gateway.
- `wait_threads` jest ograniczone w czasie i tylko czyta stan, więc przerwanie go niczego nie psuje.
- Harmonogramy są w bazie, a odpalanie z dzierżawą (`FOR UPDATE SKIP LOCKED`, 60 s), więc przy kilku instancjach każdy termin odpala jedna. Po przestoju harmonogram cykliczny odpala jedną turę nadrabiającą (albo pomija zaległe przy `missed_policy = skip`), a następny termin liczy się od teraz.
- Szczegóły: [agent-bus.md](agent-bus.md#6-trwałość).

### 4.6 Drain instancji gateway

```mermaid
sequenceDiagram
    autonumber
    participant O as Orkiestrator (rolling update)
    participant G as Gateway (stara wersja)
    participant W as Workery
    participant UI
    participant G2 as Gateway (nowa wersja)

    O->>G: SIGTERM
    G->>G: readiness = false (LB przestaje kierować ruch)
    G->>W: Drain(reconnect_after_ms z jitterem)
    W->>G2: ponowne połączenie przez LB
    G->>G: przestaje brać nowe tury czatowe, kończy bieżące do terminu, potem oddaje dzierżawy
    G->>UI: koniec strumieni (kod: reconnect)
    UI->>G2: ponowna subskrypcja od seq
    G->>G: WorkerLink.shutdown(), server.close(grace)
    G-->>O: exit 0
```

Przy jednej instancji kroki są te same, tylko workery i UI łączą się z nową wersją po jej starcie. Agenci na workerach pracują dalej, a zdarzenia czekają w dzienniku.

## 5. UI

- Subskrypcje wznawiane od ostatniego `seq`.
- Każda akcja użytkownika ma `client_request_id`. Ponowienie po zerwaniu połączenia lub podwójne kliknięcie nie dubluje komendy.

## 6. PostgreSQL i migracje

- Expand/contract: najpierw dodajemy (kolumny, tabele), wdrażamy aplikację, potem usuwamy stare. Wersje N i N+1 muszą działać na schemacie po kroku expand.
- Migracje są osobnym krokiem wdrożenia, nie efektem startu aplikacji przy N instancjach.
- Kopie zapasowe, PITR, RPO/RTO: do ustalenia przy projekcie infrastruktury.

## 7. Kompatybilność wersji

- Proto zmieniamy tylko addytywnie (już w [protocol.md](protocol.md#wersjonowanie)).
- `Hello.capabilities`: worker zgłasza obsługiwane funkcje. Gateway nie wysyła komend, których worker nie zna.
- Okno wsparcia: gateway N obsługuje workery N i N-1.
- `thread_events.payload` ma wersję formatu (`format`).

## 8. Health i supervisor

- Gateway: `/livez` (proces żyje), `/readyz` (baza dostępna, nie trwa drain).
- Worker działa pod supervisorem systemowym: systemd user unit (Linux, Omarchy), launchd (macOS), usługa Windows. Supervisor wysyła SIGTERM (Windows: odpowiednik), czeka `drain_timeout + margines`, dopiero potem zabija.

## 9. Macierz awarii

| Zdarzenie | Co się dzieje | Utrata |
|---|---|---|
| SIGTERM gateway | drain (4.6); workery i UI łączą się ponownie | brak |
| SIGKILL gateway | workery i UI łączą się ponownie; dzierżawy tur czatowych wygasają i tury są powtarzane | brak potwierdzonych danych; delty w locie |
| SIGTERM worker | drain (3.3); tury dokończone albo czysto przerwane, dziennik opróżniony | brak; przerwana tura jest oznaczona |
| SIGKILL lub zanik zasilania workera | tura przerwana w dowolnym miejscu (kończy się `interrupted`, `worker restarted`, kolejka rusza dalej); zdarzenia z dziennika dosłane po starcie; transkrypt dostawcy do ostatniego zapisu | **tura w toku**, efekty uboczne mogły zajść częściowo |
| Restart PostgreSQL | gateway ponawia z backoffem, `readyz = false`; workery buforują w dzienniku | brak |
| Zerwanie sieci worker ↔ gateway | ponowne połączenie, dosłanie dziennika | brak |
| Aktualizacja CLI dostawcy na urządzeniu | nowe tury na nowej wersji (wznowienie wątku); restart Codex app-server przechodzi przez drain wątków | brak |

## 10. Wpływ na dotychczasowe decyzje

- „MVP: jedna instancja gateway” zmienia się na: projekt dla N ≥ 1 od początku, wdrożenie może zacząć od jednej instancji.
- „Komendy do workera offline od razu kończą się błędem, nie kolejkujemy” zmienia się na: outbox w PostgreSQL z `expires_at` per typ.
- **Effect:** `Scope`, finalizery i przerwania fiberów wprost wspierają drain i kolejność zamykania. `effect/workflow` i `effect/cluster` są w 4.1.1 `@stability unstable`, więc nie opieramy na nich trwałości. Ich zapisany format mógłby się zmienić między wersjami, a to uderza w wymaganie aktualizacji w trakcie działania. Zamiast tego własne, dobrze znane mechanizmy na PostgreSQL: outbox, dzierżawy z `SKIP LOCKED`, `LISTEN/NOTIFY`.

## 11. Decyzje do podjęcia

1. **Polityka przerwanej tury.** Propozycja: przerwanie czyste (drain) wznawiamy automatycznie z wiadomością systemową o restarcie; przerwanie twarde (crash) czeka na decyzję użytkownika („Kontynuuj”), bo efekty uboczne mogły zajść częściowo. Ewentualnie konfigurowalne per agent.
2. **Domyślny `drain_timeout` workera** i zachowanie „update when idle”.
3. **Gateway: od jednej instancji czy od razu ≥ 2.**
4. **Mechanizm aktualizacji workera:** samoaktualizacja sterowana z gateway czy menedżer pakietów systemu.
