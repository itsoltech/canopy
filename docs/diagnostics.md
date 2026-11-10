# Diagnostyka wydajności

Status: **projekt do decyzji**, bez implementacji. Settings → Diagnostics ma pomóc
właścicielowi ustalić, co spowalnia Canopy i co zrobić dalej. Jeden ekran pokazuje
lokalny komputer i **wszystkie połączone komputery**, ich gatewaye, workery i łącza.
Telefon widzi ten sam zbiór przez sparowany gateway; nie łączy się osobno z każdym domem.

Powiązane: [architektura](architecture.md), [protokół](protocol.md), [UI API](ui-api.md),
[połączone komputery](linked-computers.md), [ustawienia](settings-map.md),
[mobile](mobile.md), [trwałość](durability.md), [dostęp sieciowy](network-access.md),
[wydajność klientów](client-performance.md), [wydajność DB](database-performance.md),
[retencja DB](database-retention.md), [process governor](process-governor.md).

## 1. Decyzje i granice

- **Wydajność jest priorytetem produktu nr 1.** Zwykła diagnostyka ma kosztować mniej
  niż 1% jednego rdzenia CPU na proces, pamięć jest ograniczona, a p95 operacji
  użytkownika nie może wykazywać mierzalnej regresji. Budżet trzeba potwierdzić pomiarem (§10).
- Właściciel dostaje porównywalne agregaty, wskazówki, raport i zbieranie logów.
  Nie budujemy pełnego systemu obserwowalności, alertowania dyżurowego ani automatycznej optymalizacji.
- Brak zewnętrznej telemetrii i automatycznego wysyłania raportów. Dane pozostają
  w procesach i gatewayach właściciela oraz jego uwierzytelnionych klientach.
  Eksport i przekazanie raportu agentowi są osobnymi, jawnymi akcjami.
- Domyślnie agregaty w pamięci, bez tabeli metryk i zapisów na każde RPC.
  Szczegółowe próbki tylko po czasowym włączeniu na wskazanym komputerze.
- Zbieranie logów obejmuje wyłącznie zarejestrowane źródła Canopy. Nie pobiera
  transkryptów, katalogów projektów, konfiguracji sekretów ani dowolnych plików.

## 2. Co już istnieje i co wykorzystać

| Źródło | Obecna granica i decyzja |
|---|---|
| `apps/gateway/src/computers/write-diagnostics.ts`, wywołania w `api/routed.ts` | `linkedWrite` mierzy wyłącznie `SendMessage`, osobno `sender`/`home`, loguje wynik i próg 1000 ms. Zachować rozróżnienie stron, zasilić agregaty; nie parsować logów ani kopiować `clientRequestId` do etykiet. |
| `packages/transport/src/sync-metrics.ts`, `computers/sync-codec.ts`, `core/thread-update-bytes.ts`, `apps/web/src/lib/server/sse.ts` | #409–#411: opt-in `CANOPY_SYNC_METRICS`, bajty już kodowanych wiadomości, encode/decode, rodzaj snapshot/delta/heartbeat, CPU kodeka. Obecne rate to średnia od resetu, bez histogramów. Nowy kolektor współdzieli hooki i zakodowane bajty; nie włącza per-message `cpuUsage()` domyślnie. Cache encode nie reprezentuje całego kosztu kodeka. |
| `core/thread-watch-revisions.ts`, `store/thread-watch-revision.ts`, `core/hub.ts`, `computers/thread-watch.ts`, `runtime-mirrors.ts` | Wspólne odczyty rewizji, ograniczone kolejki i powody resubskrypcji. Dodać liczniki w tych miejscach, nie drugi polling rewizji. `reason: revision` może wynikać z metadanych/heartbeatów workera, nie dowodzi awarii sieci. |
| `scripts/bench/{db,concurrent,trace,plan-capture,stats}.ts`, dalsze harnessy opisane w `database-performance.md` | DB2 #430–#447 mierzy magazyny, współbieżność, reserve i plany SQL. Tracer przechowuje próbki/parametry w pamięci, liczy JSON wierszy i wykonuje osobny przebieg diagnostyczny. **Nie przenosić go do produkcji.** Wykorzystać nazwy rodzin operacji i granice reserve/execute, bez parametrów, JSON wyników i EXPLAIN. |
| `packages/process-governor/src/governor.ts` | `snapshot()` już udostępnia `active`, `byKind`, `queued`, `started`, `joined`, `cacheHits`, `dropped`. Brakuje histogramu oczekiwania i czasu wykonania. Dodać hooki admission/release/drop, zachować limity, priorytety i cache. |
| `apps/web/src/lib/server/gateway-logging.ts`, `gateway.ts`, `gateway-transport.ts` | Wrapper mierzy unary, lecz loguje tylko część błędów 5xx (`gateway call failed { method, durationMs }`), pomija `MarkThreadSeen`, stream tylko przekazuje. Rozszerzyć to samo miejsce o agregaty sukcesów i błędów wszystkich metod oraz lifecycle streamów. Log błędów nie jest licznikiem ruchu. |
| `apps/gateway/src/network/session-liveness.ts`, `computers/watch-liveness.ts`, `apps/worker/src/main.ts`, `gateway-link/link.ts` | #386 i kolejne: transport PING, heartbeat łącza i aktualność subskrypcji to trzy różne sygnały. Workerowy `Heartbeat` nie ma dziś echo/RTT; `computer_routes.latency_ms` mierzy zestawienie trasy/handshake, nie bieżący RTT. |
| `apps/web/src/lib/features/threads/dev/{navigation,session,bench,network}.ts`, `scripts/bench/{client-js,image-cache}.ts` | #413–#419: syntetyczny renderer, otwieranie przez prawdziwy BFF, dekoder/reducer i cache. Zachować definicje; remount do drugiej klatki nie jest cold FCP ani TTI. To narzędzia developerskie, nie istniejący kanał metryk właściciela. |
| `apps/desktop/src/runtime/{log,process,runtime,database}.ts`, `apps/desktop/src/main.ts` | `Logs` już redaguje znane sekrety/Bearer i rotuje po około 5 MiB do `.1`–`.3`; `Supervisor` przechwytuje stdout/stderr własnych usług. Wspólne źródła: `desktop.log`, `gateway.log`, `worker.log`, `postgres.log`, `web.log`, `initdb.log`. Potrzebne ścisłe limity i redakcja eksportu (§7), także dla usług poza desktopem. |

Ścieżki w tabeli oznaczają kod istniejący. Nazwy nowych RPC, capability i modułów
poniżej są propozycją. Nie zakładamy istniejącego serwisu diagnostyki, pomiaru RTT,
produkcyjnego pomiaru SQL ani gotowego wykresu.

## 3. Model pomiaru i koszt

Każda próbka czasu korzysta z monotonicznego zegara tego samego procesu.
UTC służy tylko etykietom okien. Nie odejmujemy timestampów dwóch komputerów.
Klucz serii to zamknięty zestaw: warstwa, deskryptor metody/rodzina operacji,
kierunek i autoryzowany właściciel. Id komputera/procesu jest zakresem kolektora,
nie etykietą mnożoną przez wątek, projekt, model, adres i każdy kod błędu.
Kody mają stałą tablicę liczników. Nigdy nie tworzymy serii z tekstu wejścia.

**Okna:** 1 min / 15 min / 24 h. Pierścienie mają 12 slotów po 5 s,
15 po 1 min i 96 po 15 min. Aktualizacja dotyka trzech bieżących slotów;
odczyt scala histogramy. Obejmuje bieżący slot i poprzednie sloty danego pierścienia:
granica jest zaokrąglona, a odpowiedź podaje rzeczywiste `window_start/end` i rozdzielczość.
UI nie obiecuje dowolnego dokładnego zakresu historycznego.

Histogram czasu ma 128 stałych kubełków: granice `1 µs × 2^(i/4)`,
osobny underflow i overflow. Percentyl to górna granica kubełka zawierającego
rangę `ceil(q × n)`; błąd kwantyzacji do około 19% jest jawny w szczegółach.
Overflow daje „≥” zamiast fikcyjnej wartości; `max` zachowujemy dokładnie.
Wspólne kubełki pozwalają sumować histogramy; **nie uśredniamy percentyli**.
Rozmiary mają osobny histogram 32 kubełków log2 bajtów, sumę i max.
Liczniki nie mogą zawijać się: saturacja slotu oznacza niepełność danych.

Budżet całej diagnostyki: **64 MiB na gateway, 16 MiB na worker,
2 MiB na BFF/klienta**. Gateway dopuszcza do 384 pełnych serii, worker do 64;
rezerwujemy serie metod z deskryptorów przed rodzinami opcjonalnymi. Jeden histogram
128 × uint32 × 123 sloty to około 62 KiB; sumy, błędy, rozmiary, cache partnerów
i tracing muszą zmieścić się w całościowym limicie, sprawdzanym przy alokacji.
Brak miejsca ogranicza szczegóły i zwiększa `dropped_series/samples`, nie zatrzymuje RPC.
Nie tworzymy macierzy worker × wszystkie metody: workery mają osobne ograniczone podsumowania.
Przekroczenie liczby metod po rozbudowie kontraktu wymaga zmiany budżetu lub schematu,
nie cichego usunięcia metryk metody. Odczyty są stronicowane.
BFF i klienci trzymają tylko agregaty bieżącej partii, do wysłania; pełne trzy
okna ich danych utrzymuje gateway. Limit 2 MiB nie zakłada lokalnej historii 24 h.

Hot path wykonuje tylko odczyt zegara i aktualizację liczb, bez synchronicznego
I/O, logowania na sukces, serializacji do liczenia rozmiaru i procesów pomocniczych.
Zasoby próbkujemy co 5 s, dysk co 60 s przez API systemu, bez skanowania projektów.
Reguły działają raz na minutę na agregatach, nie po każdym zdarzeniu.
Szczegóły CPU kodeków, stosy i aktywne sondy są poza trybem podstawowym.

### 3.1 Gateway: RPC

Jeden wrapper lifecycle przy rejestracji tras obejmuje `GatewayService`,
`WorkerLinkService`, enrollment, `UpdateService` i `ComputerLinkService` na porcie
procesu oraz Network access. Punkty integracji: `apps/gateway/src/main.ts`,
`worker-link/routes.ts`, `api/ui-service.ts`, `network/devices.ts` i adaptery
`packages/transport/src/{server,http-server}.ts`. Wewnętrzne metody linked RPC
instrumentujemy też przy `computers/runtime-serving.ts` / `remote.ts`, ponieważ
nie przechodzą przez publiczny interceptor. Wywołanie logiczne ma jedną obserwację
na obsługującym domu; transport `Connect` ma osobną serię. Zdalne oczekiwanie
nadawcy jest osobną warstwą, nie drugim wykonaniem domowego RPC.
Wewnątrz WorkerLink osobno mierzymy typowane komendy w
`worker-link/connection.ts`: `sendCommand` → dopasowany `CommandResult` lub timeout,
count/rate/in-flight i kod wyniku per rodzaj komendy, bez `command_id` jako etykiety.
To czas całej obsługi komendy (także kolejki/git/harness), nie RTT sieci.

| Metryka | Dokładna definicja |
|---|---|
| `started`, `completed`, `calls/min` | Próby wejścia do handlera, zakończenia i `60 × started / observed_seconds` w wybranym oknie. Retry liczy się jako nowa próba. Odpowiedź podaje oba liczniki i czas pokrycia od startu/resetu. |
| `duration_ms` p50/p95/p99/max | Unary: wejście wrappera → rozstrzygnięcie handlera z wynikiem/błędem, łącznie z lokalnym oczekiwaniem i routowaniem. Nie obejmuje całego transferu do klienta; to osobny pomiar BFF/klienta. Histogram dotyczy zakończonych prób, także błędów; UI może filtrować wynik, jeśli istnieje osobna seria. |
| `errors_by_code`, `error_ratio` | Ostateczny kod Connect/gRPC z wyjątku lub końca generatora; OK osobno. Udział błędów = nie-OK / zakończone. Oczekiwane `Canceled` i planowy drain są widoczne, ale wyłączone z reguły awarii. Nieznany kod trafia do `Unknown`, bez message. |
| `in_flight` | Rozpoczęte minus zakończone teraz; zwolnienie dokładnie raz także po abort, błędzie generatora i zerwaniu transportu. Oprócz wartości bieżącej zapisujemy maksimum slotu. |
| `request/response_bytes` | Rozmiar protobuf na granicy istniejącego encode/decode, przed ramkowaniem, TLS i kompresją, w każdym kierunku osobno. Brak dostępnego hooka oznacza brak pomiaru, nie zero. Nie kodujemy wiadomości drugi raz. |
| Stream | Otwarcia/zamknięcia i kody, aktywne streamy, czas do pierwszej wiadomości, czas życia zakończonego streamu oraz wiek aktywnego. Wiadomości/s = wiadomości w oknie / sekundy pokrycia; bajty/s analogicznie. Snapshot, delta, heartbeat i sterowanie osobno. Długi zdrowy watch nie jest „wolnym RPC”; nie trafia do rankingu unary. |

Nieautoryzowane i anonimowe żądania nie mają odgadniętego właściciela.
Ich ograniczone liczniki są tylko dla właściciela procesu; publiczny health/Check
nie udostępnia metryk. Auth w handlerach workera/linków musi najpierw rozwiązać
właściciela. Metryki nie zmieniają kontraktu ani auth zamrożonego `update/v1`.

### 3.2 Gateway: wnętrze procesu

| Metryka | Definicja i miejsce |
|---|---|
| Event-loop lag | Dodatnie opóźnienie wywołania timera względem monotonicznego terminu; histogram ms i max, bez odtwarzania pominiętych ticków. Wzorzec pomiaru w `tests/integration/support/sync-process-entry.ts` używa `monitorEventLoopDelay`; rozdzielczość produkcyjna 20 ms, zgodność Bun sprawdzana w benchmarku. Suspend oznacza lukę, nie serię fikcyjnych próbek. |
| CPU/pamięć | `Δ(user+system CPU µs) / Δwall µs × 100%`, gdzie 100% = jeden rdzeń; RSS, heap used/total w bajtach, uptime procesu. Ostatnia, średnia ważona czasem i max w oknie; brak pomiaru pamięci harnessów nie oznacza całego kosztu hosta. |
| SQL i pula | `gateway/runtime.ts`: reserve od żądania połączenia do jego otrzymania, także zestawienie; execute od wysłania przez zarezerwowany driver do zakończenia/dekodowania. Liczba, błędy, p50/p95/p99/max per stała rodzina, np. `thread.page`, `watch.revision`, `commands.pending`. Czas transakcji osobno; nie sumować zagnieżdżonych czasów jako kosztu niezależnego. Oczekujący reserve i zajęte połączenia jako gauges. Top 10 według p95 lub sumy czasu z liczbą próbek. |
| Ingest i kolejki | `core/core-workers.ts`, `store/ingest.ts`, `core/core-commands.ts`: odebrane, czekające, rozpoczęte i zatwierdzone eventy, ms od odbioru do commitu/ACK; głębokość i wiek najstarszego oczekującego eventu/komendy. Obserwować istniejące enqueue/dequeue i ograniczone odczyty outboxa, bez pełnych COUNT/skanów na każdy tick; szacunek ma znacznik jakości. |
| Subskrypcje/fan-out | `core/hub.ts`, `core/thread-watch-revisions.ts`, `computers/runtime-mirrors.ts`: liczba watchy wątków/overview/luster, liczba wspólnych odczytów rewizji/min, publikacje i próby dostarczenia/min, odbiorcy/publikację, maksimum kolejki w wiadomościach/bajtach i overflow. Liczniki bez id wątków. |
| Process governor | Obecny `snapshot()` jako gauges i różnice liczników. Nowe: próby admission, przyjęte/start, odmowy według stałej przyczyny, wait = enqueue → start/drop w ms, execution = start → release w ms, per `kind` i `priority`. Joined/cache hit nie są nowym procesem; anulowany wpis nie jest udanym admission. |

Rodziny SQL nadaje kod magazynu; nie fingerprintujemy dowolnego SQL w hot path.
Nieznane zapytanie to `other`, a pokrycie rodzin jest jawne. Nie pobieramy
produkcyjnego `pg_stat_statements`, tekstu SQL, parametrów ani planów automatycznie.
Powiązanie RPC → rodzina DB wymaga kontekstu lokalnego wywołania; bez niego
można wskazać współwystępowanie, nie „przyczynę”. Nie odejmujemy p95 SQL od p95 RPC.

### 3.3 Worker i jakość sieci

| Metryka | Definicja i granica |
|---|---|
| Link RTT, heartbeat, jitter | Capability `diagnostics_v1`: do istniejącego heartbeat workera dodać numer sekwencji, gateway odsyła krótkie echo przed pracą DB. Worker mierzy send → echo na własnym zegarze, najwyżej jedno echo oczekujące. Jitter = histogram `abs(RTT[n] − RTT[n−1])` w jednej sesji. Odbiorca osobno mierzy interwał nadejść i wiek ostatniego heartbeat; to nie jednokierunkowa latency. Brak echo/timeout to osobny licznik, nie próbka zakończona timeoutem udająca RTT. |
| Reconnect/journal | Próby i udane zestawienia/min oraz przyczyna: planowy drain, zmiana trasy, transport, auth. Backlog = liczba/bajty niepotwierdzonych eventów i wiek najstarszego; redelivery = event ponownie wysłany po wcześniejszej próbie, rozróżniony od pierwszego wysłania danych zgromadzonych offline. `gateway-link/delivery.ts`, `journal/journal.ts`, `main.ts`; bez zmiany ACK i zapisu przed wysłaniem. |
| Harness/provider | Start wejścia do adaptera → pierwsza tekstowa delta asystenta (proxy TTFT), start → terminalny wynik (turn duration), liczba/typ wyniku. Tura bez tekstu ma brak TTFT. Kolejka przed adapterem i oczekiwanie na człowieka osobno, nie odejmowane heurystycznie. `runtime/host-events.ts`, `runtime/thread-commands.ts`, `providers/*`; pomiar obejmuje CLI, narzędzia i inferencję, nie samą sieć dostawcy. |
| Git i zasoby | Governor: queue wait oraz wykonanie per zamknięta rodzina `status`, `refs`, `fetch`, `worktree`; żadnego argv/cwd. CPU/RSS/heap workera jak gateway. Wolne/całkowite bajty filesystemu katalogu danych, rozmiar journala z istniejących zapisów; brak ścieżki. Brak dostępu/API daje brak pomiaru, bez spawnowania `df`, `ps` ani rekursywnego `du`. |
| Gateway/provider network | RTT i timeouty pochodzą z heartbeatów/istniejącego ruchu. Błędy DNS/TLS/timeout/refused tylko jako zamknięta klasa. HTTP timing dostawcy wyłącznie jeśli adapter już go udostępnia; inaczej „Not measured”. TTFT nie rozstrzyga, czy winna jest sieć, provider czy narzędzie. Aktywne sondy domyślnie wyłączone; ewentualne opt-in tylko do skonfigurowanego endpointu, bez inferencji i ujawnienia adresu, z limitem czasu/liczby. |

Worker wysyła agregat przez istniejący WorkerLink najwyżej co 30 s, do 32 KiB,
bez journala, outboxa i wymogu trwałego ACK. Numer sesji i sekwencja partii
zapobiegają podwójnemu scaleniu; utrata partii daje lukę pokrycia, nigdy replay
transkryptu. Pobranie szczegółów odwołuje się do kolektora workera, bez wykonywania
komend git lub modelu. Starszy worker nadal działa, lecz nie ma nowego pomiaru RTT.

### 3.4 Połączone komputery i wspólny obraz

Każdy dom utrzymuje własne agregaty gatewaya i swoich workerów. Lokalny gateway
buduje katalog z własnego komputera i autoryzowanych komputerów znanych przez
`GetComputers`, obecność, bezpośrednie linki oraz istniejące trasy onward (maks. jeden relay).
Nie odkrywa sam obcych gatewayów. Wszystkie te komputery mają kartę, także offline,
starsze i bez zgody; brak danych nie usuwa komputera z widoku.

**Transport:** preferujemy polling gotowego agregatu po istniejących
`RemoteRequest/RemoteResponse` i `api/routed.ts`, nie stały nowy stream na każdą kartę.
Odczyt domu ma zakres `local_only`: zwraca tylko ten gateway, jego workery i jego
obserwacje łączy. Nigdy rekurencyjnie nie odpytuje katalogu partnerów.
Capability `diagnostics_v1` oraz jawna allowlista w `computers/remote-policy.ts`
i descriptor w `methodNamed` dopuszczają w tym przepływie tylko odczyt snapshotów. Dom autoryzuje
partnera/trasę i zakres; poświadczenia klienta nie są przekazywane dalej.
Onward wymaga osobnej zgody na diagnostykę od domu, nie wynika z udostępnienia wątków.

Lokalna odpowiedź natychmiast pokazuje lokalny kolektor i cache partnerów.
Odświeżanie w tle: overview co 30 s, wskazany drill-down co 10 s, maks. dwa
odczyty zdalne naraz, deadline 3 s i backoff do 5 min. Jeden odczyt na dom jest
współdzielony przez klientów tego gatewaya; strona lokalna nigdy nie czeka na
timeout najwolniejszego partnera. Bez otwartego Diagnostics pobieramy tylko
lekki overview co 60 s dla ostatniego stanu offline; brak szczegółów jest jawny.
Cache do 32 komputerów/8 MiB; przy większym katalogu rotacja odświeża strony,
zachowując wszystkie karty i informację o braku zachowanego snapshotu.

Overview domu ma limit 16 KiB, pełna strona metod 64 KiB; łączny budżet zwykłego
odświeżania 64 KiB/s na gateway, do 256 KiB cache szczegółów na komputer.
Przesyłamy gotowe agregaty trzech okien i najwyżej 96 punktów trendu, nie wszystkie
wewnętrzne sloty ani per-call samples. Przy braku zmiany rewizji wystarcza `not_modified`.
Budżet obejmuje relay; po wyczerpaniu odkładamy odczyt, nie zagęszczamy timerów.
Dom scala sloty raz na rewizję (najwyżej co 5 s) i współdzieli wynik wszystkim
odbiorcom. Koszt serializacji/odświeżania wchodzi do budżetu CPU z §1.

Snapshot niesie wersję aplikacji/schematu, `process_session`, reset epoch,
okres pokrycia, `sampled_at`, lokalny wiek próbki i stany niepełności.
Odbiorca zapisuje własny monotoniczny czas odbioru; wiek pokazuje jako wiek
źródłowy + czas od odbioru, z uwzględnieniem niepewności transferu, bez zaufania
do zgodności zegarów. Po 90 s overview jest `Stale`, po utracie połączenia
`Offline` z ostatnim snapshotem i „Last updated 2 min ago”. Offline nie jest zerowym
ruchem ani zdrowiem. Bez capability: „Update to see diagnostics”. Unlink usuwa
cache, zgody i aktywne zadania; restart odbiorcy może oznaczać brak starego snapshotu (§5).

**Metryki łącza:** RTT i jitter mierzone echo w już wysyłanym heartbeat, jak
u workera, przy capability obu stron; czas zestawienia trasy pozostaje osobno.
Mirror sync lag = lokalny czas od wykrycia nowszego kursora domu do atomowego
commitu receivera; dodatkowo liczba zaległych rewizji, tylko w tej samej epoce,
oraz wiek ostatniego potwierdzenia. Brak znanej nowszej rewizji nie dowodzi braku laga.
`sync-codec.ts` dostarcza rozmiary snapshotów/delt; `thread-watch.ts` liczy
resubskrypcje/min według `revision/gap/stall/legacy_probe` i aktywnych watchy.
Nie przechowuje ich id ani kursora jako etykiety. Liczymy ponowienia także przy
zdrowym transporcie, oddzielnie od reconnectu całego linku.

Łącze ma wspólny klucz pary nieuporządkowanych id komputerów i dwa kierunki.
Widok scala finding z obu końców bez sumowania tych samych prób jako nowych RPC.
Pokazuje np. „The link between A and B is slow” oraz osobno RTT obu obserwatorów,
pokrycie i świeżość. Jeden koniec offline daje wynik jednostronny, nie domniemany
pomiar drugiej strony. Dom generuje swoje findings także na własnym ekranie;
agregator nie rozsyła automatycznie ustaleń ani topologii do innych partnerów.

### 3.5 Klienci i dostarczenie agregatów

BFF mierzy unary od wejścia do `transport.unary` do wyniku/błędu; zawiera transport,
kolejki HTTP/2 i czas gatewaya. Stream: czas do pierwszej wiadomości, lifetime,
liczniki wiadomości/bajtów na istniejącym kodowaniu SSE. BFF i gateway pokazujemy
osobno; różnica percentyli nie jest latency sieci. `gateway-logging.ts` pozostaje
wspólnym punktem obserwacji, z rozróżnieniem lokalnych/zdalnych pul transportu.

Web/desktop: otwarcie wątku = nawigacja → zamontowana pierwsza widoczna porcja osi
czasu do drugiej klatki (proxy paint, z rozróżnieniem cache/network).
Pierwszy snapshot: odbiór → parse/decode/reducer. Cold FCP z Paint Timing osobno;
long task = wpis PerformanceObserver >50 ms, liczba, suma czasu i max.
Gdy API nie istnieje, pole jest nieobsługiwane. Nie wysyłamy URL ani nazwy wątku.
Mobile: nawigacja → pierwszy widoczny feed po layout/klatce, koszt decode/reducer
oraz opóźnione klatki JS jako **proxy**, bez nazywania ich natywnym FCP/long tasks.
Definicje i ograniczenia z `client-performance.md` pozostają obowiązujące.

W produkcji losujemy 10% otwarć wątków, maks. 20/min na klienta; histogramy mają
liczbę obserwacji i sampling rate, bez odtwarzania fikcyjnych dokładnych countów.
Klient wysyła zamknięte histogramy najwyżej raz na 60 s, do 16 KiB; BFF jako
procesowy kolektor do 32 KiB/30 s. Przeglądarka → uwierzytelniony BFF → gateway,
desktop analogicznie, mobile → Connect przez istniejący przypięty transport.
`SubmitDiagnostics` wiąże owner/device po auth, waliduje schemat, liczbę kubełków,
zakresy i limit 60 KiB/min na nadawcę; nie ufa ownerowi ani metodzie z payloadu.
Sesja+sekwencja deduplikuje partie. Raporty klientów są danymi niezaufanymi,
oddzielonymi od zaufanych liczników serwera i nie wywołują automatycznych działań.
Brak bufora na dysku i bezterminowego retry; utrata sieci daje luki pokrycia.

## 4. Reguły zdrowia i zalecenia

Mały deterministyczny moduł domeny otrzymuje agregaty i capability, zwraca
`rule_id`, komputer/łącze, `severity` (`info`, `warning`, `critical`), dowód
(wartość, próg, okno, liczba próbek, pokrycie), poziom pewności i rekomendację.
Bez modelu, zewnętrznych usług i samoczynnego restartowania/zmieniania ustawień.
Stan karty wynika z najpoważniejszego aktywnego finding; brak pokrycia daje
`Not enough data`, nie zielone „Healthy”. Stan sieci/offline jest osobny od zdrowia.

| Reguła startowa | Próg wejścia i rekomendacja w UI |
|---|---|
| Wolne łącze | RTT p95 >500 ms / 15 min, ≥30 próbek; critical >2000 ms. „Worker X: link round-trip is 850 ms at p95 over 15 min.” „Check this computer's network or move the worker closer to the gateway.” Dla komputerów wspólny finding pary z §3.4. |
| Wolne interaktywne RPC | p95 >1000 ms / 15 min, ≥100 zakończeń, ≥5 wolnych prób; critical >3000 ms lub błędy transportu/serwera >5% (≥10 błędów). Długie operacje import/update/generacja mają osobną klasę, watch lifetime jest wyłączone. „GetThread p95 is 1.8 s.” Szczegóły: „Largest measured DB contributor: thread.page.” „Ask an agent to investigate Canopy.” |
| Event loop/sync | p99 lag >100 ms w trzech kolejnych minutach, critical >500 ms. Gdy te same sloty mają ruch sync: „Event-loop lag spikes during sync.” „Collect a short trace to investigate Canopy.” To korelacja, dopóki span nie potwierdzi miejsca kosztu. |
| Backlog i governor | Najstarszy niepotwierdzony event >30 s i rosnący backlog przez trzy minuty; lub governor wait p95 >1 s przy ≥30 admission i niepustej kolejce przez trzy minuty. „Events are waiting to reach the gateway.” „Check the link and gateway load.” W szczegółach DB/pool waits i limity procesów; nie proponować zwiększania limitów bez pomiaru. |
| Resubskrypcje i zasoby | >3 resubskrypcje `revision` na aktywny watch/min przez trzy minuty przy ≥3 watchach oraz większej liczbie snapshotów niż zmian treści; `stall/gap` osobno. „Thread views keep refreshing.” „Ask an agent to investigate synchronization.” CPU >90% rdzenia przez 5 min lub wolny dysk <10% i <2 GiB: odpowiednio sprawdzenie obciążenia lub zwolnienie miejsca. Sama wysoka RSS bez limitu hosta/trendu nie dowodzi wycieku. |

Reguły przeliczamy co minutę. Wejście zwykle po trzech kolejnych ocenach,
wyjście po pięciu ocenach poniżej 70% progu; dla CPU/dysku osobne progi powrotu
70% i >15% lub >3 GiB. Zmiana severity zachowuje to samo id finding.
Brak świeżych próbek zawiesza ocenę, nie rozwiązuje problemu. Po starcie/reset
zbieramy wymagane pokrycie, minimum trzy minuty; dla okna 15 min wymagamy co
najmniej 10 min obserwacji. p99 przy n<1000 pozostaje liczbą o małej próbie,
z takim oznaczeniem i bez samodzielnej eskalacji. Planowy drain, sen, zmiana
trasy i legacy revalidation nie uruchamiają alarmu sieci. Deduplikacja per reguła/
komputer/łącze, bez toastu na każdy tick i bez systemowych powiadomień w tym zakresie.

## 5. Pamięć, retencja i restart

**Decyzja: bez persystencji metryk w pierwszym stosie.** Każdy proces utrzymuje
ograniczone okna, gateway dodatkowo ostatnie snapshoty partnerów. Restart/reset
czyści jego obserwacje; UI podaje „Collected since …” i luki. Po restarcie odbiorcy
offline komputer pozostaje w katalogu, ale może mieć „No saved diagnostics”.
To jawny koszt niższego narzutu i braku konkurencji o pulę DB, zgodny z utratą
wyłącznie pomocniczej telemetrii, nigdy stanu wykonania z `durability.md`.
Obecny runtime ma jeden proces gatewaya na dom. Przy przyszłych N instancjach
każdy wynik zachowuje id sesji/instancji; bez kompletnego zbioru nie pokazujemy
go jako sumy gatewaya. Wspólny odczyt musi scalić histogramy wszystkich instancji
albo jawnie podać niepełne pokrycie, także po przełączeniu load balancera.

Opcję minutowych snapshotów na 24–72 h odkładamy. Przy 256 seriach i 1 KiB/min
na serię to około 360 MiB/dobę/komputer przed indeksami/WAL; nie jest „tanim”
domyślnym zapisem. Jeżeli restart okaże się realnym problemem, osobny projekt
ograniczy rekordy/bajty i częstotliwość, zachowa owner scoping i użyje joba
`maintenance/job.ts` z partiami jak `database-retention.md`. Nowa migracja ma numer
najwyższy+1, bez edycji zastosowanych migracji, z aktualizacją
`packages/db/test/schema.test.ts`. Ten dokument nie rezerwuje numeru migracji.

Logi mają oddzielną ograniczoną rotację (§7); nie są magazynem per-call metrics.
Tymczasowe pliki eksportu mają TTL 15 min i limit z §7, są usuwane po anulowaniu,
odwołaniu dostępu i przy następnym starcie po crashu. Nie trafiają do DB, journalu,
luster ani historii konfiguracji. Ukończony download jest już plikiem właściciela.

## 6. API, autoryzacja tras i aktualizacja widoku

Proponowane wiadomości w nowym `proto/canopy/ui/v1/diagnostics.proto`, metody
addytywne w istniejącym **`GatewayService`**. Dzięki temu mobilny transport,
service token BFF, odwołanie tokenu urządzenia i `serviceTokenAuth` mają tę samą
granicę; nowa publiczna usługa wymagałaby jawnego rozszerzenia auth.

| RPC/protokół | Zakres |
|---|---|
| `GetDiagnostics` | Zsumowany lokalny widok kart, findings i znaczników świeżości; lokalne dane + cache, nigdy blokujące gather do wszystkich partnerów. |
| `GetComputerDiagnostics` | Wskazany komputer/worker, okno i strona metod/SQL/zasobów; `revision/not_modified`, coverage, missing/dropped. Zdalny wariant zwraca wyłącznie dane domu. |
| `SubmitDiagnostics` | Ograniczone agregaty BFF/klienta; owner z auth, bez swobodnych etykiet i tekstów. Worker raportuje oddzielnie przez addytywną wiadomość WorkerLink. |
| `ResetDiagnostics`, `StartDiagnosticsTrace`, `StopDiagnosticsTrace`, `ReadDiagnosticsTrace` | Sterowanie i odczyt próbek wyłącznie jawnie wybranego domu/workera, epoch i lease, autoryzacja ponownie u celu. Żadnego domyślnego resetu/tracingu wszystkich komputerów i żadnego relay tych metod. |
| `StartLogCollection`, `GetLogCollection`, `ReadLogCollection`, `CancelLogCollection` | Owner-scoped zadanie zbiorcze i postęp/manifest; odczyt ZIP jako bounded server stream chunków. Wewnętrzna capability `diagnostics_logs_v1` umożliwia domowi wyeksportowanie tylko swoich źródeł. Retry wskazanych nieudanych komputerów jest nową autoryzowaną próbą. |

Linked część dostaje osobny wewnętrzny descriptor w `proto/canopy/link/v1/link.proto`
(np. `DiagnosticsService.ReadSnapshot` i `CollectLogs`), obsługiwany istniejącą
kopertą remote i jawnie dołączony do `methodNamed`/allowlist/relay policy.
Sterowanie reset/trace ma oddzielną allowlistę direct-only i capability
`diagnostics_control_v1`; przyjmuje jawną akcję ownera, nie żądanie agregatora.
Odczyt snapshotu i zbieranie logów mają osobne zgody; `CollectLogs` jest efektem
wymagającym identyfikatora jawnej akcji i audytu także na domu. Relayed wywołanie
sprawdza aktywną zgodę domu dla origin, maks. jeden hop i brak dalszego gather.
Nie wolno użyć ogólnej allowlisty wątków jako uprawnienia do logów komputera.
Utrata linku kończy próbę, nie kolejkuje jej do wykonania po powrocie bez właściciela.

Worker: addytywne pola heartbeat/echo i raporty agregatów przez `worker_link.proto`,
capability, bez nowego portu. Logi workera przez osobny anulowalny kanał chunków
na istniejącym WorkerLink, bez journala i bez payloadów w outboxie.
Desktop udostępnia zarejestrowane źródła gatewayowi prywatnym kanałem kontrolera,
a BFF własne logi przez ograniczony uwierzytelniony kanał rejestracji źródła.
Nie wystawiamy rendererowi API czytania ścieżek. Gateway nie czyta dysków workerów.

Numery pól nowe, bez zmiany istniejących znaczeń; `WORKER_LINK_PROTOCOL` i
`COMPUTER_LINK_PROTOCOL` zostają przy negocjacji capability. `canopy.update.v1`
**pozostaje nietknięte**; mierzymy wywołania wrapperem poza zamrożonym proto.
W PR zmieniającym proto obowiązuje `bun run gen` i czyste `gen:check`.
Starszy gateway/worker/partner ma jawne unsupported zamiast fikcyjnych zer.

**Live view:** polling snapshotów, bez nowego stale otwartego streamu metryk.
Web wykorzystuje `@canopy/domain/shared-query`, `shared/queries.svelte.ts`
i `revalidateEvery`; mobile `state/queries.ts` i `useSettingsResource`.
Jeden timer per aktywny zakres, pause w tle, backoff przy błędzie; overview/
`computer_removed` unieważnia katalog, nie wszystkie tabele na każdą próbkę.
Po reconnect odświeżenie raz, zachowanie starego wyniku z błędem do nowej odpowiedzi.
Progress joba odczytujemy co 1 s tylko podczas zbierania. Streaming ZIP i próbek
trace korzysta z BFF HTTP download na web oraz Connect na mobile; nie wkładamy
binarnego ZIP w SSE. Brak odczytu diagnostyki z modelu bez akcji ownera.

## 7. Zbieranie logów ze wszystkich komputerów

**Collect logs** otwiera wybór ostatniej **1 h / 6 h / 24 h** (domyślnie 1 h)
i listę lokalnego oraz wszystkich połączonych komputerów, domyślnie zaznaczonych.
Komputery niedostępne/bez uprawnienia pozostają widoczne z powodem. Gateway
koordynuje jedno zadanie właściciela, najwyżej dwa komputery równolegle i jeden
eksporter na komputer. Nie zbiera logów okresowo ani po samym otwarciu Settings.

### 7.1 Źródła i rotacja na komputerze

Eksporter posiada stały rejestr źródeł: `desktop.log`, `gateway.log`, `worker.log`,
`postgres.log`, `web.log`, `initdb.log`, dla każdego lokalnego workera oddzielny
alias. Przenosimy/reużywamy mechanizm `Logs` z desktop runtime jako wspólny writer,
zamiast importować aplikację desktopową do gatewaya/workera. Supervisor nadal
zbiera wyłącznie własne stdout/stderr. Zdalny worker redaguje u siebie, zanim
wyśle porcję do swojego gatewaya; BFF analogicznie.

Obecna rotacja desktopu nie gwarantuje ścisłego limitu: sprawdza rozmiar przed
dopisaniem, `write()` nie ma limitu długości takiego jak `stream()`, brak TTL.
Docelowo maks. **5 MiB × 4 pliki na źródło, 128 MiB łącznie na komputer i 7 dni**,
limit linii 16 KiB; najstarsze rotacje są usuwane jako pierwsze. `initdb.log`
może nie występować w ostatnim zakresie; manifest podaje brak/wygaśnięcie.
Nie obiecujemy całych 24 h przy dużym ruchu — manifest podaje dostępne pokrycie.

Standalone worker/gateway/BFF dostają taki sam ograniczony writer; w desktopie
unikamy podwójnego zapisu przez proces i supervisor. Dla zewnętrznego PostgreSQL
lub logów zarządzanych przez kontener/system dostępny jest wyłącznie lokalny,
jawnie skonfigurowany adapter do zarejestrowanego źródła. Bez dostępu raportujemy
`not_available`; nie odczytujemy dowolnego journala systemowego, nie używamy SSH,
nie zmieniamy uprawnień i nie włączamy `log_statement` ani logowania parametrów SQL.
Rotację źródeł zewnętrznych egzekwuje ich operator; stan nieweryfikowalny jest jawny.

### 7.2 Eksport, przepływ i granice

Filtrujemy według timestampu nadanego przez writer, zachowując granice rekordów.
Zakres względny interpretuje komputer źródłowy; manifest podaje jego UTC i
ewentualną niepewność zegara. Starsze linie bez wiarygodnego czasu nie udają
dopasowanych: osobny oznaczony tail tylko po wyborze właściciela.

Limity dotyczą **bajtów po redakcji i przed kompresją**: 2 MiB na źródło,
12 MiB na komputer (także jego zdalne workery), 96 MiB na całą akcję,
100 MiB końcowego ZIP. Przy limicie wybieramy najnowsze pełne linie, czyli tail;
pominięte bajty/linie i zakres wpisujemy do manifestu. Dom przydziela limit
sprawiedliwie źródłom i workerom; koordynator przydziela limit komputerom przed
transferem, bez faworyzowania najszybszej maszyny. Dla dużego katalogu UI uprzedza
o mniejszym budżecie na komputer, pozwala zmniejszyć wybór. Limit skanowania
to lokalna retencja 128 MiB, bez nieograniczonego szukania starych plików.

Redakcja działa **przed opuszczeniem każdego źródłowego komputera**, także dla
workerów i BFF. Najpierw przetwarzamy pełny rekord, potem dzielimy go na chunki
32 KiB z numerem i checksumem. Nie redagujemy niezależnych chunków, bo sekret
może przecinać granicę. Nierozpoznany format/niezamknięta zbyt długa linia zostaje
pominięta z licznikiem, nie przesłana surowo. Źródło buduje ograniczony redagowany
spool, nigdy surowy plik tymczasowy do wysyłki.

Transport używa istniejącej trasy linked, chunków `RemoteResponse` i backpressure:
kolejka do 256 KiB/transfer, 512 KiB/s/komputer, 1 MiB/s/koordynator, niski priorytet
wobec heartbeat/transkryptu i oddawanie event loop między porcjami. Kompresja ZIP
niska lub store, pomiar kosztu; zwykły budżet CPU metryk nie obejmuje jawnego
eksportu, lecz eksport ma limit średnio 10% rdzenia i nie pogarsza p95 pracy
użytkownika. Przekroczenie odkłada porcje. Transfer ma idle deadline 15 s,
deadline komputera 60 s i całej akcji 3 min; anulowanie zamyka upstream i pliki.
ZIP powstaje strumieniowo na dysku gatewaya, nie w całości w heap. Limit spool
źródła 12 MiB, koordynatora 100 MiB, jeden job, TTL z §5. Nie zwiększamy limitu
pojedynczego RPC ani istniejących kolejek synchronizacji.

Postęp per komputer: `Waiting`, `Collecting`, `Redacting`, `Transferring`,
`Done`, `Truncated`, `Offline`, `Timed out`, `Not permitted`, `Update needed`.
Offline nie blokuje pozostałych. Można pobrać częściowy ZIP i wybrać **Retry failed**;
retry ma nowy wynik/audyt i nie przedłuża starego zadania bez końca. Niepełne źródło
ma jawny status w manifeście; nie opisujemy archiwum jako kompletnego.

Struktura ZIP: alias komputera → sześć nazw źródeł, aliasy workerów oraz
`manifest.json`. Manifest zawiera wersję/schemat, OS/arch, uptime, zakres,
czas zebrania, snapshot metryk, findings, świeżość, status każdego źródła,
liczbę zredagowanych/pominiętych rekordów i obcięcie. Nie zawiera fizycznych ścieżek,
hostname, tokenów ani surowych komunikatów błędów. Root manifest opisuje pokrycie
wszystkich wybranych komputerów, także nieobecnych. Nazwy wpisów ZIP są stałe lub
generowane z bezpiecznych aliasów; żadnych symlinków, `..` i absolutnych ścieżek.

Web/desktop: uwierzytelniony download `application/zip`, `no-store`, plik
`canopy-diagnostics-<czas>.zip`; download nie wymaga linku publicznego ani tokenu
w URL. Mobile zapisuje ograniczony plik w prywatnym cache i otwiera systemowy
share sheet po akcji właściciela; anuluje/usunie plik zgodnie z TTL/unpair.
W etapie 5 należy ocenić wymagania natywnej zależności share sheet
względem istniejącego buildu aplikacji mobilnej.

## 8. Prywatność, raport i działania

**Uprawnienia:** owner-only w gateway, z ponowną kontrolą celu. Obecny produkt
ma jednego ownera gatewaya; nie nadajemy przyszłym użytkownikom/adminom wglądu
w cudzy ruch. Na współdzielonym workerze użytkownik widzi tylko swoje operacje;
zasoby całego procesu i logi wymagają właściciela/admina tego zasobu. Partner
widzi własny dozwolony dom lub jawnie udostępnioną diagnostykę/logi; nie dostaje
całego katalogu i snapshotów innych partnerów. Osobne grants `diagnostics_read`
i `diagnostics_logs` dla onward są sprawdzane na domu, odwoływalne i audytowane.
Ich trwały zapis może wymagać migracji najwyższy+1 i testu schema; nie jest
persystencją metryk. Revoke/unlink przerywa stream i unieważnia download.

**Redakcja:** metryki zawierają tylko liczby i zamknięte identyfikatory definicji.
Nazwa metody pochodzi wyłącznie z lokalnego deskryptora, nie z tekstu remote request;
nieznana = `unknown_method`. Rodzina SQL ma alias, nigdy SQL/parametry/wiersze.
Kod błędu to allowlista; error message, stack/cause, nagłówki, query string,
adresy, ścieżki, argv/env, prompty i wyniki narzędzi nie trafiają do agregatów.

Eksporter logów ponawia redakcję niezależnie od ochrony przy zapisie: usuwa
sekrety znane lokalnemu runtime oraz rozpoznane tokeny/Bearer, klucze API,
credentials, cookies, DSN, poświadczenia URL, prywatne hosty/IP i ścieżki.
Bezpieczny szablon rekordu ma pierwszeństwo przed blacklistą regexów;
payloady PostgreSQL (`STATEMENT`, `DETAIL`, parametry) i nierozpoznane struktury
mogące zawierać treść użytkownika są pomijane. `Logs.redact` jest punktem wyjścia,
nie dowodem kompletnej redakcji prywatnych hostów/ścieżek. Nazwy wybrane przez
użytkownika także mogą być sekretem: eksport zamienia je na `Computer A`,
`Worker 1`, `Project 1` ze stabilnością tylko w jednym raporcie.

Ścieżki workspace i prywatne hosty **zawsze** znikają. Dodatkowe zastąpienie
każdego wystąpienia home/login użytkownika aliasem `<home>` jest domyślnie On;
wyłączenie nie przywraca ścieżek ani sekretów. Nie ma przełącznika „bez redakcji”.
Znaczniki redakcji pozostają czytelne, nowe linie i kody ANSI są normalizowane.
Przekazywanie bajtów wymaga przejścia lokalnego filtra; błąd redakcji kończy dane
źródło jako pominięte. Nie przekazujemy sekretów do centralnego redaktora/modelu.

**Działania właściciela:**

- **Copy report**: JSON albo Markdown z wybranym oknem i komputerami, metrykami,
  findings, sampling/coverage i lukami. Ten sam lokalny filtr/aliasy co ZIP;
  limit 256 KiB, kontrolowane skrócenie z listą pominiętych sekcji. Bez automatycznej wysyłki.
- **Ask an agent to investigate**: wybór istniejącego projektu/workspace i workera
  na tym samym domu, np. checkout Canopy, podgląd raportu, opcjonalnie **Attach logs**.
  Tworzy zwykły wątek z raportem jako załącznikiem/danymi i z jawnym zadaniem ownera.
  Raport i logi są **niezaufanym tekstem**, nie instrukcją systemową, grantem ani
  zgodą na shell/deploy. Normalne uprawnienia i zgody obowiązują; brak auto-start
  przy samym zebraniu raportu. Gateway ponownie waliduje placement i właściciela.
- ZIP można dołączyć do tej akcji po podglądzie zakresu. Reużywamy attachment/blob
  i transfer do domu wątku, bez wysyłania sekretów. Nie omijamy limitu pliku/wiadomości:
  jeżeli ZIP przekracza efektywny limit (domyślnie 20 MiB/plik), proponujemy mniejszy
  zakres/zestaw komputerów; raport tekstowy można nadal dołączyć. ZIP dostaje
  krótki manifest tekstowy dla agenta, bez automatycznego rozpakowania/wykonania.
- **Reset counters**: wybrany komputer/proces, nowa epoch i czas początku.
  Nie zeruje live gauges, trwałego journala/outboxa ani statystyk procesu governora
  używanych przez runtime; resetuje tylko bazę/okna diagnostyki. Stare odpowiedzi
  po epoch są ignorowane; offline reset nie jest kolejkowany.
- **Start deeper tracing**: wybrany komputer, 1/5/10 min, domyślnie 5,
  maks. 10 min i jedna lease. Maks. 1% wywołań, 100 próbek/s, 2000 spanów/4 MiB,
  ring w pamięci, automatyczne off po deadline, restart i ręczne **Stop tracing**.
  Spany tylko stałych operacji RPC/DB/pool/ingest/governor z losowym trace id,
  bez payloadów. Zwykły snapshot pokazuje tylko aktywność/termin tracingu;
  pobranie próbek z innego komputera wymaga jawnej akcji na nim i prawa eksportu.

Zlecenie badania pokazuje, dokąd trafi raport: uruchomiony harness może przekazać
go wybranemu providerowi tak jak zwykły załącznik. To świadomy eksport właściciela,
nie telemetria w tle. Na tym ekranie można zrezygnować z logów.
Pobrany ZIP i załącznik mają inne retencje: załączony plik staje się historią
wątku, zgodnie ze zwykłą polityką blobów; TTL joba nie usuwa historii rozmowy.

Audyt w istniejącym `audit_log`: aktor/urządzenie lub uwierzytelniony origin,
dom docelowy, zakres czasu, wybrane źródła, rozpoczęcie/zakończenie/anulowanie,
liczba bajtów, partial/truncated i wynik autoryzacji. Dom i koordynator zapisują
ten sam id akcji; brak treści, ścieżek i sekretów. Zbieranie/log-export, tracing,
reset i dołączenie do wątku są audytowane osobno. Nie logujemy każdego odczytu metryk.

## 9. UI web/desktop i mobile

**Settings → Diagnostics**, w grupie General, wspólny rejestr
`packages/ui/src/settings.ts`; dostępne na serwerze i desktopie, a linked sekcja
zależna od capability roli gatewaya. Nie tworzymy osobnego ekranu na każdym komputerze.
Mobile ma tę samą funkcjonalność przez `src/app/settings/[section].tsx`, natywny
stos Back oraz wspólny QueryCache parowania. Zmiana zakresu, sortowania i rozwinięcia
jest lokalnym stanem widoku, nie synchronizowaną preferencją konta.

| Obszar | Zachowanie |
|---|---|
| Overview | Karty wszystkich komputerów: gateway, workery, linki, status kolorem **i tekstem**, ostatnia aktualizacja, top finding, CPU i RTT. Filtr komputera oraz `1 min / 15 min / 24 h` (domyślnie 15 min). Offline zachowuje ostatnie liczby jako nieaktualne; `Update to see diagnostics` zamiast pustej zielonej karty. |
| Findings | Najpierw critical/warning, potem info; max 5 na początku, rozwinięcie reszty. Wartość, okno, prosty powód i zalecana akcja; techniczne dowody pod `Show details`. Wspólny finding pary linku ma obie obserwacje. |
| RPC i DB | Sekcja `Calls`, tabela sortowana po calls/min, p50/p95/p99/max, błędach i in-flight, z nazwą metody i komputerem. Grupowanie per dom, bez sumowania warstw BFF/home/transport. W drill-down `RPC details`, streamy oddzielnie, kody i payload sizes; top 10 rodzin SQL i pool wait. Na telefonie wybór sortowania i karty wierszy zamiast tabeli szerszej niż ekran. |
| Linki/zasoby/trendy | RTT/jitter, backlog/lag, reconnect/resubscribe, CPU/RSS/dysk. Małe sparklines: do 96 punktów, widoczna jednostka, min/max/ostatnia wartość tekstem; przerwa w danych jest przerwą linii. Brak pomiaru ≠ 0. Szczegóły komputera/workerów zachowują filtr i czas, dostępne z każdej karty. |
| Raport/logi/trace | Akcje `Copy report`, `Collect logs`, `Ask an agent to investigate`; wybrany komputer pokazuje `Reset counters` i `Start deeper tracing`. Zbieranie ma postęp per komputer, rozmiar, truncation/partial, `Download logs` i `Retry failed`; mobile `Share logs`. Trace ma czas końca i `Stop tracing`; nic nie włącza go zbiorczo. |

Kit web: `SettingsGroup`, `SettingsCard`, `SettingsRow`, `Select`, `Button`,
`Badge`, `Dialog`/`Popover` z `apps/web/src/lib/shared/ui`; bez natywnych selectów.
Gęstość i stopnie z [ui-scale.md](ui-scale.md), kolory semantyczne i ruch z tokenów,
`tabular-nums`, stałe miejsce liczników/akcji, kompaktowe nakładki, reduced motion.
Mobile używa `src/ui`, tokenów i celów dotykowych minimum 48 dp.

Przegląd `shared/ui`, funkcji web i `apps/mobile/src/ui` nie wykazał gotowego
komponentu Chart/Sparkline ani biblioteki wykresów. Wzorzec repo to lekkie SVG
(np. `ProgressRing.svelte`), mobile ma już `react-native-svg`. Proponujemy mały
współdzielony model punktów i po jednym komponencie platformy, bez nowego frameworka
wykresów, animacji każdego ticka ani aktualizacji całej strony przy zmianie liczby.
Sortowanie nie przestawia wiersza pod fokusem co odświeżenie; kolejność zatwierdza użytkownik.

Stany: pierwszy odczyt jako istniejący skeleton; zero ruchu: **No calls yet** —
„Use Canopy to collect performance data.”; za mała próba: **Not enough data**;
cisza przy dobrym pokryciu: **No issues found**; błąd: „Could not refresh diagnostics.
Retry to get the latest data.” z **Retry** i zachowaniem poprzednich danych.
Brak workerów nie ukrywa gatewaya. Brak logu (`initdb` nie działał, zewnętrzny
Postgres) nie generuje fałszywej awarii, ale pozostaje w manifeście pokrycia.
Wyłączony Network access nie jest sugestią włączenia go tylko dla lokalnych metryk.

Copy według [copy.md](copy.md): protokoły/rodziny SQL/kody w szczegółach,
krótkie zdania, bez obwiniania sieci lub providera bez dowodu. Nazwa produktu
i worker/gateway/computer zgodne ze słownikiem. `Ask an agent to investigate`
zachowuje wymagane brzmienie jako świadomy wyjątek od 1–3 słów akcji.
Każdy etap UI robi audyt §8 copy i ręczny przegląd jasny/ciemny, desktop/wąski/
telefon, długie nazwy i małe/duże liczby, overlay/scroll/sticky bez szczelin.
Nie dodajemy testów komponentów ani Playwright.

## 10. Realizacja: jeden stos sześciu PR-ów

Rozmiary S/M/L oznaczają odpowiednio jedną powierzchnię, kilka powiązanych modułów
lub zmianę przekrojową; nie są deklaracją liczby godzin. Każdy etap jest kompletną,
testowalną funkcją, z UI **web/desktop i mobile w tym samym etapie**.
Każdy branch bazuje na poprzednim; dolny na aktualnym `dev`. Całość pozostaje
draftem do ukończenia i weryfikacji stosu, potem merge razem przez `gh stack`
zgodnie z `AGENTS.md`, nigdy pojedynczy niegotowy etap do `dev`.

| Etap | Zakres, rozmiar i zależność | Dowód zakończenia |
|---|---|---|
| 1. Wspólny overview + RPC + RTT | **L**, baza `dev`: kolektor RPC, heartbeat echo workerów i komputerów, owner-scoped odczyty/capability/grants, shared-query, cache/freshness, karty wszystkich domów, RPC table/drill-down, 1/15/24 h, findings link/RPC. Direct i dozwolony onward, unsupported/offline. **Pierwsza wartość już tutaj**, bez otwierania Settings na każdym komputerze. | Integracja gRPC dwóch gatewayów i workerów, plus trzeciego przez relay: histogram/count/stream cleanup, deduplikacja, brak recursive gather, owner denial/revoke, offline cache, starsze wersje, RTT vs heartbeat, limity i narzut; migracja grants jeśli potrzebna. Ręcznie te same dane na trzech klientach. |
| 2. Gateway/DB/governor | **M**, po 1: event loop, zasoby, SQL families/pool waits i powiązanie RPC, ingest/outbox/watch/fan-out/queue, governor wait/admission, kolejne findings i szczegóły. | Integracja gRPC przy obciążeniu ingest i wolnym odbiorcy, zachowane ACK/durability, owner-scoped SQL, błędy reserve/execute i release. Porównanie DB2/concurrent i process-governor z kolektorem on/off, bez EXPLAIN w produkcji. |
| 3. Workery i synchronizacja | **M**, po 2: journal/redelivery, harness TTFT/turn, git, dysk, mirror lag i resubscribe reasons, oba końce finding linku, szczegóły wszystkich workerów. | Gateway↔worker: reconnect/drain/restart, redelivery bez podwójnego naliczania, luki/mirror commit, symulowana wolna sieć, bez dodatkowych probes. Harness adaptery na deterministycznych CLI, brak prompt/path w wynikach, reuse #386 i #409–#411. |
| 4. Klienci i raport/agent | **M**, po 3: agregaty BFF, sampled web/desktop/mobile timings, eksport JSON/Markdown, wybór placement i utworzenie zwykłego wątku, reset epoch. | Integracja auth, rate/size/schema, stara sekwencja/epoch, unpair/revoke, redakcja, załącznik na właściwym domu i idempotentne utworzenie. Benchmarki #413–#419 z oddzieleniem JS od native; ręczny copy audit i parity. |
| 5. Collect logs | **L**, po 4: źródła/rotacja także standalone, lokalna redakcja, autoryzowane zbieranie ze wszystkich domów/workerów, chunk/backpressure, spool/ZIP/manifest/partial/retry, download/share sheet, opcjonalne dołączenie ZIP do akcji agent. | Integracja wielogatewayowa/workerowa: sekrety przecięte chunkami, SQL payload/host/path, odmowa cudzych logów, relay grant/revoke, offline/timeout/rotation, limity/tail, wolny odbiorca/anulowanie, restart cleanup i ZIP bez traversal. Test migracji grants jeśli potrzebna. Test bezpieczeństwa prywatnego kanału desktopu; ręczny download i share, limit załącznika. |
| 6. Czasowy tracing i domknięcie budżetów | **M**, po 5: lease, spany bez payloadów, opt-in eksport na danym komputerze, auto-off oraz pomiar wszystkich trybów. Aktywne sondy pozostają odłożone do decyzji. | Gateway↔worker: start/stop/expiry/restart, brak tracingu na innym domu bez akcji, ograniczenie pamięci i próbek. Współbieżny sync + eksport logów + RPC: wynik budżetu i brak regresji. Ręczny przegląd wszystkich stanów, copy/parity i pełna lista kontroli z `AGENTS.md`. |

**Pomiar narzutu jest bramką każdego etapu**, nie pracą zostawioną wyłącznie na 6.
Porównanie off/on na tej samej rewizji, danych syntetycznych, wersji runtime i maszynie,
naprzemiennie minimum trzy serie po rozgrzewce. Idle (10 min), steady load/sync,
reconnect i wolny odbiorca; procesy osobno jak sync-process fixture.
Raport: różnica CPU w punktach procentowych jednego rdzenia (<1 pp), CPU-sekundy/
RPC, RSS/heap, event-loop p99/max, p95 RPC i otwarcia wątku, przepustowość,
bajty na łączu i liczba alokowanych serii. Baseline idle bliski zeru nie nadaje się
na mianownik względnego „1%”. Brak rosnącej pamięci po wypełnieniu pierścieni
sprawdzamy również w przebiegu 30 min z churnem klientów/partnerów.

Warunek p95: brak powtarzalnego pogorszenia poza rozrzutem baseline; wzrost
`> max(1 ms, 1%)` wymaga wyjaśnienia/profilu i poprawy przed merge, nie automatycznej
akceptacji. Trzy krótkie serie nie dowodzą braku mniejszej regresji: zapisujemy
niepewność i także niekorzystne wyniki. Eksport/tracing mają oddzielny profil
on/off i własny limit CPU; przy zbyt wysokim koszcie ograniczamy szczegóły,
częstotliwość lub transfer, nie zwiększamy budżetu bez decyzji.

Testy stosu: istniejące meaningful gRPC/durability/security/harness i migracje,
bez trywialnych unitów i testów UI. Wdrożenie każdego etapu wymaga pełnej listy
kontroli z `AGENTS.md`: `bun install`, `bun run gen:check`, `bun run typecheck`,
`bun run lint`, `bun run format:check`, `bun run check:tmp` (pełny przebieg testów,
w tym integracyjnych, oraz kontrola czystości katalogu tymczasowego) i build web
(`bun run --filter @canopy/web build`). Benchmarki uruchamiamy w izolowanych
stosach na własnych portach; ich artefakty nie trafiają do repo.

## 11. Otwarte decyzje dla maintainera

| Pytanie | Zalecana odpowiedź |
|---|---|
| Diagnostics czy Performance? | **Diagnostics**, w General; obejmuje także sieć, świeżość i logi. |
| Historia po restarcie? | Bez persystencji metryk w pierwszym stosie; jawne luki. Wrócić do ograniczonych snapshotów dopiero po pomiarze rzeczywistej potrzeby/kosztu. |
| Dokładność percentyli a pamięć? | Stałe 128 kubełków (~19% kwantyzacji) i jawny max/pokrycie; jeśli to za mało do decyzji o optymalizacji, zwiększyć precyzję dopiero po pomiarze budżetu 64/16 MiB. |
| Zgoda na dane partnerów/onward? | Bezpośredni partner tego samego właściciela ma odczyt diagnostyki; logi tylko na jawną akcję ownera. Onward wymaga osobnych, odwoływalnych grants read/logs od domu. Brak grant nie ukrywa karty komputera. |
| Domyślny zakres logów i prywatność? | 1 h, wszystkie komputery, 2/12/96 MiB przed kompresją, 100 MiB ZIP, redakcja home On, bez opcji eksportu sekretów. 6/24 h tylko w ramach dostępnej rotacji. |
| Zewnętrzny PostgreSQL i logi systemowe? | Brak automatycznego dostępu administracyjnego. Lokalny adapter jawnie udostępnionych logów i manifest `not_available`, jeśli operator go nie skonfigurował; rotację operator potwierdza osobno. |
| ZIP dla agenta większy niż limit attachment? | Nie zwiększać globalnego limitu; mniejszy zakres/wybór komputerów i tekstowy manifest. Agent otrzymuje załącznik wyłącznie po podglądzie właściciela. |
| Aktywne sondy providerów? | Odłożyć; istniejący ruch i oznaczenie niepewności wystarczą do pierwszej wersji. Tracing maks. 10 min per jawnie wybrany komputer, nigdy automatycznie na wszystkich. |
