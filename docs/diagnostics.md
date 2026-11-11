# Diagnostyka wydajności

Status: **zaakceptowany 2026-11-10; implementacja etapu 1 w draft PR**. Dokumentacyjny PR #495
jest podstawą stosu diagnostyki i zostanie scalony razem z nim (§10).
Settings → Diagnostics ma pomóc
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
- Agregaty zbieramy w pamięci i utrwalamy lekkimi partiami w bazie domowego gatewaya
  od etapu 1: minuty przez 2 h, godziny przez 30 dni, bez zapisów na każde RPC.
  Budżet narzutu obejmuje zapis i retencję. Szczegółowe próbki tylko po czasowym
  włączeniu na wskazanym komputerze; nie są utrwalane.
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

**Okna:** 1 min / 15 min / 1 h / 24 h. RAM zawiera 12 slotów po 5 s oraz bieżącą
minutę i ostatnie 60 minut. Aktualizacja RPC dotyka tylko dwóch bieżących slotów.
Zamknięte minuty wchodzą i wychodzą z gotowych sum 15 min / 1 h raz na minutę;
odczyt dodaje do nich bieżącą minutę. Scalanie nie tworzy pośrednich kopii protobuf.
Widok 24 h pobiera najwyżej 23 zakończone godziny z DB i dodaje bieżącą godzinę
z RAM. Jedna współdzielona odpowiedź historyczna ma cache 5 s, bez odczytu SQL
na każdy tick ani ładowania całej historii do pierścieni. Po crashu ostatnia
zakończona godzina może przejściowo użyć najwyżej 60 minut, zanim powstanie jej
rollup godzinowy. Granica jest zaokrąglona do rozdzielczości widoku, a odpowiedź
podaje rzeczywiste `window_start/end` i rozdzielczość (24 h: 1 h).
UI nie obiecuje dowolnego dokładnego zakresu historycznego.

Histogram czasu ma 128 stałych kubełków: granice `1 µs × 2^(i/4)`,
osobny underflow i overflow. Percentyl to górna granica kubełka zawierającego
rangę `ceil(q × n)`; błąd kwantyzacji do około 19% jest jawny w szczegółach.
Overflow daje „≥” zamiast fikcyjnej wartości; `max` zachowujemy dokładnie.
Wspólne kubełki pozwalają sumować histogramy; **nie uśredniamy percentyli**.
Rozmiary mają osobny histogram 32 kubełków log2 bajtów, sumę i max.
Liczniki nie mogą zawijać się: saturacja slotu oznacza niepełność danych.

Budżet całej diagnostyki: **64 MiB na gateway, 16 MiB na worker,
2 MiB na BFF/klienta** to limity całego planu. Etap 1 ma cel przyrostu RSS i startowego
VmHWM **≤10 MiB** względem wyłączonego kolektora. Rezerwacje live są ograniczone
do 6 MiB dla metod i 2 MiB dla łączy, historyczny widok DB do 1 MiB.
Histogramy zarówno w RAM, jak i na dysku zawierają tylko niezerowe pary indeks/licznik;
na dysku indeksy i liczniki są pakowanymi varintami. Zerowe kubełki nie mają alokacji.
Gateway dopuszcza do 512 deskryptorów i 16 łączy worker/komputer; cache overview
do 32 partnerów. Nadmiarowe serie łączy są pomijane z jawnym licznikiem strat,
bez nieograniczonego rejestru identyfikatorów. Przykład: 24 metody × 60 minut ×
4 niezerowe kubełki to 5760 par, zamiast 187 200 kubełków jednego pełnego histogramu;
pozostałe histogramy również są rzadkie. Sumy okien i cache są ograniczone deskryptorami.
Brak miejsca ogranicza szczegóły i zwiększa `dropped_series/samples`, nie zatrzymuje RPC.
Nie tworzymy macierzy worker × wszystkie metody: workery mają osobne ograniczone podsumowania.
Przekroczenie liczby metod po rozbudowie kontraktu wymaga zmiany budżetu lub schematu,
nie cichego usunięcia metryk metody. Odczyty są stronicowane.
BFF i klienci trzymają tylko agregaty bieżącej partii, do wysłania; okna i trwałą
historię ich danych utrzymuje gateway. Limit 2 MiB nie zakłada lokalnej historii 24 h.

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
| `started`, `completed`, `calls/min` | Próby wejścia do handlera, zakończenia i `60 × started / observed_seconds` w wybranym oknie. Retry liczy się jako nowa próba. Odpowiedź podaje oba liczniki i rzeczywiste pokrycie, także odtworzone po restarcie; downtime nie jest czasem obserwacji. |
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
| CPU/pamięć | `Δ(user+system CPU µs) / Δwall µs × 100%`, gdzie 100% = jeden rdzeń; RSS, heap used/total w bajtach, uptime procesu. Ostatnia, średnia ważona czasem i max w oknie; uptime pokazuje tylko ostatnią wartość. Pokrycie czasowe raz w nagłówku grupy. Brak pomiaru pamięci harnessów nie oznacza całego kosztu hosta. |
| SQL i pula | `gateway/runtime.ts`: reserve od żądania połączenia do jego otrzymania, także zestawienie; execute od wysłania przez zarezerwowany driver do zakończenia/dekodowania. Liczba, błędy, p50/p95/p99/max per stała rodzina, np. `thread.page`, `watch.revision`, `commands.pending`. Czas transakcji osobno; nie sumować zagnieżdżonych czasów jako kosztu niezależnego. Oczekujący reserve i zajęte połączenia jako gauges. Top 10 według p95 lub sumy czasu z liczbą próbek. |
| Ingest i kolejki | `core/core-workers.ts`, `store/ingest.ts`, `core/core-commands.ts`: odebrane, czekające, rozpoczęte i zatwierdzone eventy, ms od odbioru do commitu/ACK; głębokość i wiek najstarszego oczekującego eventu/komendy. Obserwować istniejące enqueue/dequeue i ograniczone odczyty outboxa, bez pełnych COUNT/skanów na każdy tick; szacunek ma znacznik jakości. |
| Subskrypcje/fan-out | `core/hub.ts`, `core/thread-watch-revisions.ts`, `computers/runtime-mirrors.ts`: liczba watchy wątków/overview/luster, liczba wspólnych odczytów rewizji/min, publikacje i próby dostarczenia/min, odbiorcy/publikację, maksimum kolejki w wiadomościach/bajtach i overflow. Liczniki bez id wątków. |
| Process governor | Obecny `snapshot()` jako gauges i różnice liczników. Nowe: próby admission, przyjęte/start, odmowy według stałej przyczyny, wait = enqueue → start/drop w ms, execution = start → release w ms, per `kind` i `priority`. Joined/cache hit nie są nowym procesem; anulowany wpis nie jest udanym admission. |

Rodziny SQL nadaje kod magazynu; nie fingerprintujemy dowolnego SQL w hot path.
Nieznane zapytanie to `other`, a pokrycie rodzin jest jawne. Nie pobieramy
produkcyjnego `pg_stat_statements`, tekstu SQL, parametrów ani planów automatycznie.
Wspólne granice magazynów przypisują rodziny także zagnieżdżonym helperom;
szczegółowa etykieta wewnętrznego call site ma pierwszeństwo. Fixture stałego
ruchu gRPC wymaga co najmniej 95% sklasyfikowanych wykonań.
Powiązanie RPC → rodzina DB wymaga kontekstu lokalnego wywołania; bez niego
można wskazać współwystępowanie, nie „przyczynę”. Nie odejmujemy p95 SQL od p95 RPC.

**Etap 2 — implementacja:** serie wnętrza gatewaya współdzielą pierścienie i limit
6 MiB etapu 1, przejściowy budżet scalania 512 KiB oraz cache godzin 1 MiB.
Nie powstaje drugi kolektor ani osobna migracja: nowe pola protobuf mieszczą się
w istniejących payloadach rollupów. Kontekst rodziny jest referencją Effect,
a kontekst lokalnego RPC trafia do niej na granicy wykonania; streamy linked
przekazują kontekst także podczas iteracji. Zapisane identyfikatory metryk są
liczbowe i stabilne (`packages/domain/src/diagnostics/metrics.ts`).
Histogramy zapisują opcjonalne minimum i maksimum; wspólny helper ogranicza
każdy percentyl do tych granic, także dla underflow/overflow. Starsze rollupy bez
minimum używają dolnej granicy 0. Dodatkowy skalar mieści się w niezmienionych
limitach: rezerwacja agregatu wynosi 1600 B, histogramu pojedynczej metryki 144 B.
Pula korzysta z oryginalnego PgClient i jego rezerwacji, z osobnym zakresem
finalizacji do pomiaru rzeczywistego release; transakcje zachowują savepointy
i rollback po błędzie COMMIT. Liczniki faz mogą się różnić: transakcja może
rezerwować połączenie w rodzinie zewnętrznej, a wykonywać zapytania w kilku
rodzinach wewnętrznych. Rodzina `other` i pokrycie klasyfikacji pozostają jawne.
Brak miejsca na histogram nie usuwa liczników błędów; rodzina oznacza swój
niepełny rozkład i nie wyzwala na jego podstawie findingu o wolnym zapytaniu.

Korelacje RPC są opcjonalnym szczegółem: nowe klucze korelacji są pomijane po
192 wpisach metryk slotu, globalne serie nadal podlegają wspólnemu limitowi RAM.
Przy przekroczeniu 64 KiB odpowiedzi najpierw wypadają korelacje, potem szczegóły
governora i rodzin; wiersze RPC pozostają. Rollup przekraczający 64 KiB najpierw
odrzuca korelacje, potem nowe serie, oznaczając niepełność. Odtworzone gauges
mają czas próbki i znacznik historyczny; nie reprezentują aktualnych wartości.
Event loop ma timer 20 ms bez nadrabiania ticków, a opóźnienie ≥10 s oznacza lukę.

Ingest zachowuje tylko monotoniczne czasy do 4096 zdarzeń i 16 połączeń,
rozliczane w tym samym budżecie. Odebrane/rozpoczęte obejmują retry;
zatwierdzone oznaczają nowe eventy zwykłego ingestu. BotStore zwraca też replay
jako obsłużony, więc ACK botów ma czas, ale nie zwiększa tego licznika nowych
eventów. Outbox pokazuje ostatnią odczytaną ograniczoną stronę i jej najstarszy
czas utworzenia: to estymata, bez COUNT całej kolejki i bez dodatkowego pollingu.
Watches, kolejki i overflow obserwują istniejący Hub; lustra obejmują aktywne
subskrypcje mirrorów wątków/botów, bez pomiaru ich lagu (etap 3).

Nowe findings oceniają świeżą minutę: p99 event loop >100 ms przy ≥1000 próbek
(critical >500 ms), średnio >0,5 oczekującego reserve przez ≥30 s
(critical >5), execute p95 rodziny >100 ms przy ≥30 próbkach
(critical >1 s), governor wait p95 >1 s przy ≥30 admissions i niepustej kolejce.
Wymagają ≥3 min pokrycia, trzech ocen wejścia i pięciu ocen wyjścia poniżej 70%
progu; brak świeżości zawiesza ocenę. Ruch ingest/fan-out w tej samej minucie
dopisuje korelację sync do event loop, bez przypisania przyczyny.

Harness `scripts/bench/diagnostics.ts` przy `CANOPY_BENCH_STAGE=2` pozostawia
etap 1 włączony w obu członach pary, a `CANOPY_BENCH_DIAGNOSTICS` przełącza
wyłącznie nowe pomiary. Wariant off korzysta z natywnego klienta DB bez adaptera
rezerwacji, aby koszt adaptera również należał do porównania. Pozostają bramki
hosta, idle 10 min i scenariusze
DB/concurrent, dochodzi faza `governor`: osiem `git --version` co 200 ms,
cztery sloty i kolejka, bez nakładających się burstów. Narzut tej pracy jest
w obu członach pary; liczba prób/błędów trafia do artefaktów pomiaru.
Nagrania rozpoczynają się dopiero po potwierdzeniu spokojnego okna przez maintainera.

Skrócony protokół etapu 2 uruchamia jedna komenda:
`bash scripts/bench/diagnostics-stage2.sh`. Cztery przyjęte pary mają kolejność
AB / BA / AB / BA (dwa pełne bloki ABBA), gdzie A wyłącza wyłącznie etap 2, a B go włącza.
Idle trwa 3 min, każda z sześciu pozostałych faz 90 s, łącznie 96 min obciążenia;
z preflightem, rozgrzewką i uruchomieniem około 110 min, dłużej po odrzuceniu pary.
`diagnostics-series.ts` uruchamia każdy człon w osobnym procesie Bun, z nowym
klastrem PostgreSQL, bazą i prywatnym katalogiem stanu gatewaya/workera. Czeka
na zakończenie procesu i usunięcie klastra przed kolejnym członem. Log zawiera
PID, identyfikator bazy, katalog i początkowe liczby wątków/tur/itemów/rollupów.
Fixture pool contention zajmuje osiem z dziesięciu slotów; ingest może zająć
dziewiąty, a jeden pozostaje dla odczytów. Dziewięć zablokowanych aktualizacji
mogło razem z ingestem wyczerpać pulę aż do zwolnienia 70-sekundowej blokady.
Osobny `diagnostics-focus.sh <2|3> pool <8|9>` zapisuje stany, czasy oczekiwań
i PID-y blokujących sesji bez treści SQL ani parametrów; nie jest pomiarem narzutu.

Przed bramką każdego etapu `CANOPY_DIAGNOSTICS_CONTROL=1` z tym samym launcherem
uruchamia dwie pary A/A (około 55 min): wszystkie cztery świeże człony mają
wyłączony bieżący etap, niższe etapy pozostają włączone. Kontrola etapu 3 musi
więc zachować etap 2. Zapisane sloty A/B określają kolejność, a osobne `on`
rzeczywisty stan instrumentacji. `CANOPY_DIAGNOSTICS_AA_REPORT` wskazuje raport
kontroli podczas bramki A/B. Raport podaje bezwzględną i względną zmianę p95.
Opisowa granica szumu fazy to największa bezwzględna delta jej dwóch par A/A;
nie jest przedziałem ufności. Cel RPC to brak regresji powyżej większej z wartości
0,25 ms i tej granicy. Nie odejmujemy szumu od wyników ani nie odrzucamy na jego
podstawie par. Mikrobenchmark `diagnostics-rpc-path.ts` obejmuje interceptor,
kontekst, zegary i zapis rodziny DB; profil rzeczywistej fazy steady przygotowuje
`diagnostics-focus.sh <2|3> profile`, oddzielnie od nagrań bramki.
Blokady w fazach write/pool pozostają 70 s; okno obserwacji powrotu do normy
jest krótsze (20 s), więc retry po następnym rolloverze może wypaść poza fazą.
Pełny test durability/restart sprawdza odtworzenie niezależnie od tego pomiaru.
Bramki etapów 2–3 wymagają user scope z `MemorySwapMax=0` dla wszystkich
procesów pomiaru. Launcher obejmuje sterownik, gatewaye, workery i ich dzieci;
PostgreSQL działa bezpośrednio z przypiętego pakietu `@embedded-postgres`,
w oddzielnym user scope, także z `MemorySwapMax=0`. Proces tworzony przez
daemon Dockera nie dziedziczy scope'u klienta, więc nie uczestniczy w tym protokole.
Wersja PostgreSQL trafia do metadanych; A i B używają tej samej wersji binarki,
ale osobnych klastrów.
Wyniki z nowym PostgreSQL nie są bezpośrednim porównaniem do historycznych
nagrań z kontenerem PostgreSQL 17. CPU/I/O PostgreSQL pochodzą z jego scope'u.
Jeśli user manager nie ma delegowanego kontrolera I/O, fizyczne zapisy i podział
per urządzenie mają wartość `null` z jawnym powodem w metadanych; nie raportujemy
zera ani estymacji. Liczniki WAL/payloadu z bazy pozostają dostępne. Ten pomiar
nie potwierdza wtedy bramki fizycznego I/O, lecz nadal mierzy CPU/p95/RSS/heap.
`memory.swap.max` musi wynosić 0, a `memory.swap.current` w obu scope'ach
musi wynosić 0 na początku, co sekundę i na końcu każdej pary. Nieczytelny
licznik albo naruszenie unieważnia parę. Sprawdzamy przynależność gatewaya
i workera do scope'u sterownika oraz PostgreSQL do własnego user scope'u.
Swap-in hosta odrzuca parę przy ≥4 MiB/s przez trzy kolejne sekundy.
Swap-out hosta jest wyłącznie rejestrowany, bez odrzucenia pary przy zerowym
swapie scope'ów. Load powyżej liczby CPU także unieważnia parę.
Każda próbka i sumy swap-in/out na parę są zapisywane, również poniżej progów.
Pierwsze naruszenie zapisuje też PID/PPID, wiek, CPU, RSS i nazwę aktywnych
procesów z `ps`, bez argumentów ani środowiska. Ten odczyt dotyczy wyłącznie
odrzuconej pary i nie obciąża przyjętych nagrań.
Monitor zapisuje też ticki CPU i ostatni CPU wątków kswapd/zram oraz I/O zram.
`diagnostics-paired-report.ts` raportuje mediany wszystkich przyjętych par
oraz analizę wrażliwości bez oznaczonych par. Para jest oznaczona, gdy dowolna
delta CPU, p95, RSS lub heap dla fazy/procesu odbiega od mediany o więcej niż
2× MAD i szczyt host swap-out tej pary przekracza 4 MiB/s. MAD to mediana
bezwzględnych odchyleń od mediany; przy MAD=0 każde niezerowe odchylenie spełnia
warunek. Oznaczenie obejmuje całą parę, nie jest odrzuceniem ani zmianą głównej
mediany. Raport zachowuje powody, liczebność i wszystkie wyniki bez zaokrągleń.
Etap 1 zachowuje wcześniejsze bramki. Kryteria narzutu: mediana delty CPU <1 pp,
RPC p95 bez regresji powyżej max(1 ms, 10% wartości bazowej), odczyt 24 h <50 ms,
synchroniczne odtworzenie CPU <100 ms. Po profilowaniu cel etapu 2 jest ostrzejszy:
delta CPU <0,5 pp i RPC p95 <0,5 ms, a zatrzymany heap po pełnym GC różni się
od samego etapu 1 o najwyżej około 2 MiB w fazach governor i slow receiver.
Profilowanie jest osobnym przebiegiem: `CANOPY_BENCH_SMOKE=1`,
`CANOPY_BENCH_STAGE=2`, `CANOPY_BENCH_FORENSICS_DIR` oraz
`CANOPY_BENCH_FORENSIC_PHASE=steady|slow_reader|governor` wybierają fazę.
JSC próbuje stos co 1 ms tylko podczas fazy; po fazie zapisujemy statystyki
przed/po pełnym GC, liczby typów obiektów i heap snapshot w prywatnym katalogu.
Artefakty mogą zawierać syntetyczne dane i poświadczenia prywatnej bazy testowej;
nie trafiają do repo ani logów. Launcher końcowy usuwa te flagi: profile, snapshoty
i wymuszone GC nie uczestniczą w trzech parach akceptacyjnych.
Odtworzenie pełnej sekwencji ustawia też `CANOPY_BENCH_FORENSIC_CHECKPOINTS=1`
oraz te same flagi historii, widoków, checkpointów i kompaktowania co launcher.
Zapisuje slow receiver i governor oraz trzy punkty write failure: przed blokadą,
pod jej koniec i 20 s po zwolnieniu. Statystyki sprzed snapshotu i po jawnym GC
obejmują liczbę typów obiektów; sam snapshot JSC także może wykonać GC.
Snapshoty służą więc ścieżkom retencji, a wcześniejsze statystyki — rozmiarowi
niezebranych jeszcze obiektów. Nie porównujemy ich CPU/RSS z nagraniem akceptacyjnym.

Skupiony test retencji przygotowuje `bash scripts/bench/diagnostics-retention.sh 2 write_failure`.
Uruchamiamy go wyłącznie w przyznanym oknie, po aktualizacji stosu do bieżącego dev.
Każdy checkpoint (przed blokadą, po 65 s blokady i 20 s po zwolnieniu) otrzymuje
osobny świeży przebieg A/B, z historią, widokami, checkpointami DB i kompaktowaniem.
Prelude slow receiver trwa 15 s, blokada 70 s, faza awarii 90 s; razem około
12–18 minut dla trzech checkpointów, zależnie od seedowania i zapisu snapshotów.
Argument `write_failure_without_watches` jest kontrolą bez otwierania watchy.
Po punkcie przed blokadą test wykonuje rzeczywisty, owner-scoped INSERT z błędnym
parametrem JSON 8 MiB rzutowanym na timestamptz. Zwraca tylko bit niepowodzenia;
błąd, jego message i parametry nie trafiają do IPC ani raportu. Pozwala to
sprawdzić retencję błędu sterownika niezależnie od wielkości metryk. Dodatkowy
parametr jest syntetyczny, ale nadal pozostaje wyłącznie w prywatnych artefaktach.
`CANOPY_DIAGNOSTICS_RETENTION_PROBE=0` wyłącza ten INSERT dla kontroli oryginalnej
fazy awarii; nie wyłącza 70-sekundowej blokady zapisu diagnostyki.
`bash scripts/bench/diagnostics-retention.sh 3 governor` przygotowuje oddzielne
porównanie przed governor i po 90 s obciążenia (około 8–12 minut).
Etap 2 utrzymuje etap 1 w obu członach; etap 3 utrzymuje etapy 1 i 2.
Każdy proces pracuje w swap-disabled scope. To przebieg forensyczny, bez statusu
akceptacji narzutu; nie zastępuje trzech par z bramkami hosta.
Prywatny katalog ma tryb 0700, artefakty 0600. Plik `post-gc.json` zawiera surowe
statystyki przed GC, po dwóch `Bun.gc(true)` rozdzielonych oddaniem event loop
oraz deltę B−A heap/RSS po GC. Natywny snapshot JSC powstaje dopiero po tym odczycie;
analizator obsługuje także format V8.
`bun scripts/bench/diagnostics-heap-report.ts off.json on.json` porównuje liczby
obiektów według konstruktora oraz self bytes, pokazuje 20 największych stringów
i obiektów wraz z najkrótszą ścieżką od korzenia. Format V8 pozwala pominąć weak edges;
JSC nie klasyfikuje ich oddzielnie, więc jego ścieżka nie dowodzi silnej retencji.
Self bytes nie są rozmiarem dominatorów; ścieżki mają limit 100 krawędzi.
Fixture zachowuje także legacy watch bez flagi `sequence`, aby usunięcie pełnych
snapshotów w nowym protokole nie ukryło kosztu diagnostyki dla starszych klientów.
Raport nie wypisuje treści stringów, błędów, nazw closure ani dynamicznych kluczy.
Nieznane nazwy konstruktorów są hashowane, a nazwy pól pochodzą z allowlisty.
Snapshoty i surowe liczniki typów pozostają prywatne; mogą zawierać dane testowe
i poświadczenia prywatnej bazy. Nie dołączamy ich do PR.
Pamięć etapu 2 mieści się w dotychczasowych
rezerwacjach; przyrost RSS/VmHWM oraz każdą parę należy pokazać osobno, bez
uznawania szumu za dodatkowy budżet. Skrypt wymaga czystego commita, zapisuje
HEAD i zachowuje odrzucone próby; po trzech odrzuceniach tej samej pary kończy pracę.

Zwykłe zapytania korzystają z natywnego `PgPool.use`, bez osobnego scope'u
i finalizera na zapytanie. Transakcje i strumienie nadal rezerwują sesję;
rollback, savepoint i błąd COMMIT zachowują semantykę sterownika.
Instrumentacja nie zachowuje `Exit.Failure`, błędu sterownika ani jego pól;
reserve/execute/release zapisuje tylko rodzinę, czas, id RPC i bit błędu.
Rozdzielenie błędu pracy od cleanupu wykorzystuje wyłącznie liczby reasons/defects,
bez porównywania i hashowania błędów. Callbacki zakończenia nie zamykają SQL,
parametrów ani fizycznego połączenia. Klasyfikacja RPC czyta tylko kod rozpoznanego
`ConnectError`; pozostałe wyjątki dają `Unknown`, bez kopiowania message.
Obserwator governora otrzymuje wyłącznie rodzaj, priorytet, zdarzenie i czas;
nie dostaje operacji, klucza, wyniku ani błędu. Kolektor jest jedyną referencją
utrzymywaną przez callback obserwatora. Stop usuwa obserwatora i jego unsubscribe.
Próbkowanie statystyk puli ma najwyżej jedno zadanie w toku i nie zachowuje
zakończonych promise'ów ani przyczyn ich błędów.
Wrappery fizycznych połączeń są w WeakMap, z rezerwacją 4 KiB w istniejącym
budżecie kolektora dla domyślnej puli dziesięciu sesji. Nie ma map per zapytanie,
watch ani admission. Hook kończący fazę SQL zapisuje wyłącznie cztery liczby
w pierścieniu do 1024 próbek: id metryki/bit błędu, czas trwania, id RPC i czas
obserwacji. Bufor i jego narzut zajmują 33 280 B w istniejących 6 MiB;
przepełnienie zwiększa dropy i oznacza rozkłady rodziny jako niepełne.
Wspólny interwał 20 ms przetwarza najwyżej 256 próbek poza ścieżką zapytania;
odczyt i rollup opróżniają bufor przed utworzeniem widoku. Próbki zachowują
pierwotny kubełek czasu i nie zawierają SQL, parametrów, wyników ani błędów.
Hub przy publikacji aktualizuje tylko stałe liczniki i maksima liczbowe,
rozliczone jako 256 B kolektora; tick 5 s przenosi ich sumy do metryk.
Próbkowanie event loop nie tworzy kolejnego timera ani closure na każdą próbkę.
Overview scala z wnętrza gatewaya tylko CPU; nie wylicza odrzucanych potem
rodzin SQL ani korelacji RPC. Każde okno zachowuje jeden cache: wejście
w szczegóły zastępuje uboższy widok pełnym, bez drugiej kopii. Rewizja
odróżnia oba zakresy, aby overview nie potwierdziło niepobranego drill-downu.

Wewnętrzne serie (proces, kolejki, governor, rodziny SQL i ich powiązania z RPC),
łącznie z odtworzoną historią, mają wspólny podlimit 1 MiB wewnątrz istniejących
6 MiB kolektora. Podlimit obejmuje obiekty i sparse kubełki, oddaje rezerwacje
po wygaśnięciu slotu i zwiększa jawne dropy po wyczerpaniu. Rodziny SQL i korelacje
mają dodatkowy podlimit 512 KiB w tym 1 MiB, aby nie wypierać serii procesu,
kolejek i governora. Przy presji pamięci szczegóły są niepełne, nie rozszerzają limitu.
Odtwarzanie historii może wykorzystać najwyżej połowę każdego podlimitu,
aby zostawić miejsce na bieżące próbki po restarcie.
Nie powiększa to budżetu: merge widoku nadal korzysta z istniejących 512 KiB, SQL z 33 280 B,
a wrappery puli z 4 KiB. Callback rezerwacji jest wspólny dla pierścienia,
zamiast osobnej closure na etykietę i slot. Aktualizacja liczników używa dokładnych
liczb całkowitych `number`; po przekroczeniu bezpiecznego zakresu przechodzi na
`BigInt`, zachowując saturację uint64 i format trwały. Percentyle pojedynczego
histogramu w pamięci nie tworzą jego kopii ani pośredniego protobufu.
To ogranicza alokacje przy każdym SQL/admission i podczas okresowych odczytów;
wpływ na CPU, p95 i RSS wymaga nowego pomiaru.

Retry trwałości przechowuje gotowe payloady do 64 KiB, maksymalnie 60 minut
w istniejącym limicie 4 MiB, razem z rezerwacją 4 KiB na rekord/Map/Uint8Array.
Nie zatrzymuje większych, nieprzyciętych obiektów rollupu ani błędów sterownika.
Miejsce jest zwalniane przed dodaniem nowej minuty; usunięcie zwiększa jawny
licznik dropów i ustawia `persistence_gap`. Podsumowanie checkpointów dekoduje
po jednej minucie, z limitem 126 watermarków; zapis dekoduje payload dopiero po
otrzymaniu blokady domu. Flaga niepełności przetrwa retry i kompaktowanie.
Przycinanie payloadu odejmuje rozmiary usuwanych pól, zamiast kodować cały
rollup lub odpowiedź ponownie dla każdego usuniętego szczegółu.

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
zapobiegają podwójnemu scaleniu, także po odtworzeniu gatewaya (§5). Gateway
utrwala odebrane agregaty; worker nie ma bazy ani osobnego trwałego magazynu metryk.
Utrata nieodebranej partii daje lukę pokrycia, nigdy replay transkryptu.
Szczegóły łączą zapisane okna z aktualnym agregatem workera, bez wykonywania
komend git lub modelu. Starszy worker nadal działa, lecz nie ma nowego pomiaru RTT.

**Etap 3 — implementacja:** `worker_diagnostics_v1` negocjuje nowe serie niezależnie
od echo RTT. Worker ma limit **512 KiB**: 256 KiB na rzadkie agregaty i histogramy,
256 KiB na indeksy, aktywne czasy i przejściowy raport. Nie utrzymuje historii.
Indeks prób wysyłki przechowuje najwyżej 256 identyfikatorów wątków (do 80 znaków),
a pomiary tur najwyżej 64 klucze (do 160 znaków); przekroczenia zwiększają jawny
licznik drops. Po restarcie lub wyparciu indeksu replay jest niesklasyfikowany,
nie udaje potwierdzonej redelivery. Oczekiwanie na człowieka używa liczników
aktywnych tur, bez dodatkowych callbacków utrzymujących interakcje.

Proces próbkowany jest co 5 s, filesystem i trzy znane pliki journala co 60 s.
Journal utrzymuje dokładne liczniki liczby/bajtów przez transakcyjne triggery TEMP;
inicjalizacja liczy zastane eventy raz, a wiek bierze z indeksu `created_at`.
Nie powstaje drugi trwały magazyn diagnostyki. Nowe pomiary nie zmieniają zapisu
przed wysłaniem, sekwencji, ACK ani prune. Hook trwałego eventu rozpoznaje pierwszy
tekst asystenta i wynik tury; błąd obserwatora nie unieważnia zapisanego eventu.
Rodziny git są zamknięte, cache hit/join nie tworzy fikcyjnego czasu wykonania.

Gateway scala serie w **istniejącym wspólnym limicie 2 MiB dla linków**, bez nowego pierścienia.
Odtwarzanie dopuszcza najwyżej osiem partii z rozliczeniem ich rozmiaru w tym samym
budżecie; raporty powyżej 32 KiB lub z obcymi identyfikatorami są odrzucane.
Granica WorkerLink rekonstruuje wyłącznie dozwolone pola liczbowe i usuwa nieznane
pola protobuf. Znaczniki próbek są przenoszone względem czasu odbioru, bez założenia
zsynchronizowanych zegarów. Świeżość workerów wynosi 90 s przy raporcie co 30 s;
przerwa pozostaje widoczna, a zapisane minuty/godziny przeżywają restart gatewaya.
Findings backlogu wymagają wzrostu i wieku, CPU co najmniej 5 min obserwacji,
a niski dysk jednocześnie <10% i <2 GiB. Histereza nie postępuje w lukach.

Mirror obserwuje istniejący odbiornik: od wykrycia zmiany do zakończonego atomowego
commitu lokalnej repliki. Niekompletna delta nie emituje lag ani fałszywego zera
backlogu; liczba oczekujących zmian jest znana tylko przy wspólnej epoce kursora.
Powody resubskrypcji pochodzą z istniejącego supervisora, bez nowych probes.

Launcher `bash scripts/bench/diagnostics-stage3.sh` jest gotowy do ręcznego pomiaru
po potwierdzeniu wolnego hosta. Etapy 1–2 pozostają włączone w obu wariantach,
zmienia się tylko etap 3. Skrócony protokół uzgodniony dla etapów 2–3: trzy pary
AB/BA/AB, idle po 3 min, pozostałe fazy po 90 s, w tym governor; około **75 min**
bez odrzuconych par. Load ponad liczbę CPU, swap-out ≥128 KiB/s w próbce lub
≥1 MiB/parę oraz swap-in ≥4 MiB/s przez trzy kolejne sekundy odrzucają całą parę.
Pozostała aktywność swapu jest tylko raportowana; odrzucenie zapisuje też listę
procesów bez argv/env. Kryteria kosztu pozostają z §10; gate nie jest domyślnie
zaakceptowany. Fixture obejmuje prawdziwy journal/ACK/replay, deterministyczny ACP,
git i lokalny odbiornik mirroru z commitami PostgreSQL. Generowane lokalnie ramki
mirroru nie zastępują osobnego testu wolnego zdalnego transportu gRPC.

### 3.4 Połączone komputery i wspólny obraz

Każdy dom utrzymuje i zapisuje własne agregaty gatewaya i swoich workerów (§5).
Po restarcie udostępnia odtworzone okna i findings tymi samymi trasami.
Lokalny gateway
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
Przesyłamy gotowe agregaty wybranego okna i najwyżej 96 punktów trendu, nie wszystkie
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
cache, zgody i aktywne zadania. Ograniczony zapis ostatniego overview (§5) pozwala
pokazać offline partnera również po restarcie odbiorcy, zawsze z pierwotną świeżością.

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
Brak świeżych próbek zawiesza ocenę, nie rozwiązuje problemu. Po pierwszym starcie/reset
zbieramy wymagane pokrycie, minimum trzy minuty; odtworzenie uwzględnia zapisaną
historię i wymaga świeżych ocen (§5.3). Dla okna 15 min wymagamy co
najmniej 10 min obserwacji. p99 przy n<1000 pozostaje liczbą o małej próbie,
z takim oznaczeniem i bez samodzielnej eskalacji. Planowy drain, sen, zmiana
trasy i legacy revalidation nie uruchamiają alarmu sieci. Deduplikacja per reguła/
komputer/łącze, bez toastu na każdy tick i bez systemowych powiadomień w tym zakresie.

## 5. Trwałe agregaty, retencja i restart

Migracja etapu 1 to `0129_diagnostics`, po zarezerwowanych migracjach `0124–0128`.
Etapy 2 i 3 nie dodają migracji; korzystają z tych samych tabel i budżetów.
Panel Thread sync z #543 pozostaje w tym samym widoku Diagnostics na web i mobile:
jego owner-scoped, trwały postęp jest źródłem seq/head oraz błędów synchronizacji,
bez drugiej tabeli ani duplikowania tych rekordów w kolektorze metryk procesu.

**Decyzja: persystencja od etapu 1.** Każdy proces nadal zbiera metryki w pamięci;
tylko domowy gateway zapisuje je do PostgreSQL. Dotyczy to także agregatów workerów
przesłanych przez WorkerLink oraz później BFF/klientów. Każdy dom zapisuje własne
dane; odbiorca linked czyta jego trwałe okna przez istniejące trasy, bez kopiowania
historii do luster. Nie utrwalamy pojedynczych wywołań, payloadów ani spanów.

### 5.1 Format i zapis poza obsługą RPC

Minutowy rollup zawiera per proces: zamknięte id serii, liczniki i sumy,
niezerowe pary indeks kubełka/liczność z histogramów §3, max, ważone czasem zasoby,
zakresy pokrycia i luki. Wersjonowany binarny `bytea` używa słownika id i varintów,
bez powtarzania nazw metod w każdym rekordzie, JSON-u per próbka i nowych granic
kubełków. Wszystkie kubełki dają się odtworzyć, także zerowe; nie zapisujemy samych
percentyli. Liczniki po scaleniu mają co najmniej 64 bity, z kontrolą przepełnienia.
Id procesu jest stabilne, sesja zmienia się przy restarcie; reset epoch jest trwały.

Gateway raz na minutę zamraża partię i zapisuje **jednym wielowierszowym UPSERT-em**
rollupy i ostatnie findings/stan (np. przez CTE w jednej transakcji). Łączy procesy
w tej samej partii: najwyżej jeden cykliczny zapis na minutę na proces, zwykle
jeden na cały dom; przy braku zmian rzadziej. Serializacja i SQL są poza hot path,
z oddawaniem event loop, jedną operacją zapisu naraz i timeoutami jak maintenance.
Zapis cache partnerów dołączamy do partii najwyżej co 5 min, tylko przy zmianie;
maintenance i jawny reset są oddzielnymi, ograniczonymi operacjami.
Stan findings zawiera id reguły, severity, wartości, pokrycie i stan histerezy,
bez swobodnego tekstu błędu. Kontrola deduplikacji partii workerów/klientów jest
zapisywana atomowo z ich agregatami. Retry zastępuje tę samą wersję kubełka,
nie dodaje ponownie liczników; bieżąca minuta i zapis nigdy nie są sumowane dwa razy.

Przy błędzie SQL dane pozostają w ograniczonych buforach pamięci; następna minuta
ponawia zapis bez blokowania RPC i bez ciasnej pętli retry. Bufor zaległych minut
ma limit 4 MiB i obejmuje najwyżej 60 slotów minutowych w budżecie gatewaya.
Po przekroczeniu pamięci lub wieku najstarsze niezapisane minuty tracą trwałość,
z jawnym `persistence_gap`. Nie odtwarzamy zaległych minut po ich downsamplingu
i usunięciu przez retencję. Pierścienie live nadal działają.
Odpowiedź niesie `persisted_through`, `pending_minutes` i błąd jako zamknięty kod.
Graceful shutdown próbuje opróżnić partię w istniejącym limicie drain; crash może
utracić ostatnią nieutrwaloną minutę i trwającą partię, a przy awarii DB więcej. UI pokazuje
faktyczną lukę; diagnostyka nie zmienia gwarancji journala/ACK z `durability.md`.

### 5.2 Tabele, ograniczenia i sprzątanie

Nowe, zwykłe zalogowane tabele (proponowane nazwy):

| Tabela | Klucz i ograniczenie |
|---|---|
| `diagnostics_rollups` | `(owner_user_id, computer_id, resolution, bucket_start)`; jeden blob z procesami domu na minutę/godzinę. Do 64 KiB payloadu na rekord, około 120 minut i 720 godzin na komputer; twarda kwota 180 minut pozostawia godzinę na opóźnienie maintenance. Sesje/restarty nie tworzą osobnych wierszy. Indeks klucza obsługuje zakres czasu i pruning. |
| `diagnostics_state` | `(owner_user_id, computer_id)`; do 64 KiB stanu lokalnych procesów/findings, reset epoch i watermarków. Cache partnera przechowuje wyłącznie ostatni overview do 16 KiB, findings i oryginalny czas próbki, do 32 partnerów/512 KiB; nie ich historię. |
| `diagnostics_peer_cache` | Osobna tabela ostatnich overview: `(owner_user_id, computer_id)`, do 16 KiB na partnera. Oddzielenie pozwala zachować limit 64 KiB stanu domu i 512 KiB cache. FK do partnera usuwa cache przy unlink; trwały tombstone odwołania blokuje spóźniony snapshot. |

Wszystkie odczyty, UPSERT-y i pruning wymagają owner/computer scope po autoryzacji.
Maks. 64 procesy w utrwalonym podsumowaniu domu; większy zestaw ma jawne niepełne
pokrycie. Kwota 64 KiB dotyczy całego komputera, nie każdej serii/procesu.
Najpierw pomijamy opcjonalne szczegóły; przekroczenie nadal potrzebnego payloadu
oznacza `persistence_gap/dropped_series`, nigdy ciche zniknięcie metody ani wzrost
limitu. Rozmiar i liczba wierszy są sprawdzane pod blokadą stanu domu przed zapisem;
gdy pruning nie nadąża, odraczamy nowy zapis zamiast przekraczać kwotę.
Nie mnożymy stanu przez stare sesje i epoki; usunięte procesy wygasają z retencją,
a revoke/unlink usuwa cache partnera także z DB.

**Retencja: 1 min przez 2 h, 1 h przez 30 dni.** Pierwszy zapis po zamknięciu
godziny dołącza jej rollup do tej samej partii UPSERT; spóźniona minuta ponownie
wylicza i zastępuje godzinę pod blokadą stanu domu. Sumuje kubełki/liczniki,
bierze max i zachowuje pokrycie, nigdy nie dodaje ponownie zapisanych minut.
Maintenance uzupełnia brakujące godziny po crashu i usuwa stare minuty. Minut nie usuwa się
przed zapisaniem rollupu godzinowego lub jawnym oznaczeniem luki przy limicie.
Odczyt wybiera jedną rozdzielczość dla danego odcinka, bez podwójnego naliczania.
Widoki 15 min / 1 h korzystają z RAM; 24 h i przyszłe dłuższe zakresy z godzin w DB.
Latest findings to zastępowany stan, nie rosnąca historia.

Rozszerzamy `apps/gateway/src/maintenance/{job,prune}.ts` według
[database-retention.md](database-retention.md): trwały checkpoint, `SKIP LOCKED`,
do 256 rekordów na tabelę/partię, lock timeout 100 ms, statement timeout 1000 ms,
bez I/O poza DB w transakcji. Downsampling ma osobno ograniczony koszt dekodowania
jednej godziny i korzysta z tego samego harmonogramu; rollback ponawia całą partię.
Migracje addytywne w `packages/db/src/migrations/`: numer najwyższy+1 **w chwili
implementacji**, bez edycji zastosowanych, z aktualizacją
`packages/db/test/schema.test.ts`. Nie rezerwujemy numeru w projekcie.

Szacunek per komputer, łącznie gateway/workery/BFF: przy średnio **2 KiB/min**
i **4 KiB/godzinę**, 120 + 720 rekordów zajmuje około **3,1 MiB** payloadu;
z metadanymi/indeksami planujemy około **5–10 MiB**. To założenie do sprawdzenia
na liczbie aktywnych serii i procesów, nie gwarancja kompresji. Przy limicie 64 KiB
i twardej kwocie 180 + 720 rekordów jest to **56,25 MiB** payloadu,
planowany budżet tabel/TOAST/indeksów **96 MiB/komputer**
po autovacuum. MVCC/WAL są mierzone osobno; pruning nie obiecuje natychmiastowego
zmniejszenia pliku. Cache partnerów nie mnoży kosztu historii przez liczbę domów.

### 5.3 Odtworzenie i koszt

Po uruchomieniu listenera gateway w tle odczytuje bieżącą epoch, stan findings i
wyłącznie ostatnią godzinę minut, po 8 wierszy z oddawaniem event loop.
Nie czyta 72 h ani 24 h minut. Start i RPC nie oczekują zakończenia restore;
cel CPU synchronicznej ścieżki startu to **<100 ms**, VmHWM do **+10 MiB**.
Oddzielnie mierzymy cały koszt odtwarzania w tle, bez ukrywania go za gotowością listenera.
Widok pełnej historii pobiera godziny dopiero na żądanie (cel p95 **<50 ms**).
Odtwarzanie jest jednokrotne i współdzielone, nie wykonywane na każde otwarcie UI;
RPC aplikacji nie czekają. Widoki **15 min / 1 h / 24 h** kontynuują zapisaną historię,
z rzeczywistą luką między ostatnim pokrytym pomiarem a wznowieniem procesu.
`Restoring diagnostics` odróżnia brak załadowania od braku danych. Minutowa historia
nie udaje rozdzielczości 5 s; widok 1 min zbiera ją ponownie live. Odtworzone gauges
są oznaczone jako historyczne, nigdy jako aktywne streamy/procesy. Histereza wymaga
nowych świeżych ocen, downtime nie jest oceną „Healthy”. Czas próbki i zakresy UTC
są trwałe; po utracie monotonicznego zegara wiek wyliczamy z UTC z oznaczeniem
niepewności/przestawienia zegara, bez udawania świeżości przy samym odczycie DB.

Restart workera nie kasuje jego utrwalonych okien na gatewayu; nowa sesja dodaje
wyłącznie nowe dane. Przy przyszłych N instancjach gatewaya wpisy procesów i
watermarki muszą być scalane bez nadpisywania cudzych danych; brak instancji daje
niepełne pokrycie, także po przełączeniu load balancera. Nie uśredniamy percentyli.

Implementacja etapu 1 rozdziela odtworzone kubełki od bieżących w ramach wspólnego
budżetu pamięci: odczyt je scala, ale zapis nowej sesji nigdy nie utrwala ponownie
historii poprzedniej. Odtworzone szczegóły mogą zająć najwyżej 50% budżetu
kolektora; najstarsze sloty historyczne ustępują nowszym, a wygasłe są zwalniane.
Pozostały budżet chroni bieżące próbki i minutowy zapis przed zagłodzeniem przez
pełną historię. Ograniczenie szczegółów zwiększa `dropped_samples` i zachowuje
luki pokrycia; zapis w DB pozostaje pod pełną retencją. Raporty RTT mają osobne checkpointy sesji nadawcy, zapisane
atomowo z agregatem sesji odbiorcy. Dwie ostatnie sesje na łącze mieszczą się w
ograniczonym stanie deduplikacji także przy reconnect w tej samej minucie.

Odczyt scala agregaty w pamięci bez pośrednich kopii protobuf. Sumy zamkniętych
minut są aktualizowane dodaniem nowego i odjęciem wygasłego slotu; dokładne min/max
odświeżamy z pozostałych slotów raz na minutę. Odtworzenie lub saturacja wymusza
ponowne scalenie, bo odjęcie nasyconego licznika nie odtworzyłoby danych.
Bieżące liczniki i gauges są dodawane od nowa, bez modyfikowania sumy.
Po rzeczywistej stracie findings wznawiają ocenę po 15 kolejnych
minutowych ocenach bez nowych strat; licznik skumulowany nie blokuje ich na zawsze.

Publiczny interceptor nie ma hooka istniejących zakodowanych bajtów protobuf:
rozmiary tych RPC pozostają `Not measured`. Wewnętrzne linked RPC wykorzystują
bajty istniejącego encode/decode. Zasoby procesu, DB/pool, eksport, logi i tracing
pozostają w kolejnych etapach; karta etapu 1 oznacza CPU jako `Not measured`.

**Budżet zapisu wliczony w <1% rdzenia i brak regresji p95:** obejmuje serializację,
SQL, dodatkowy CPU PostgreSQL, odtwarzanie, downsampling, pruning i autovacuum.
Docelowo ≤32 MiB WAL/h i ≤64 MiB zapisu I/O/h na komputer (I/O raportowane także
oddzielnie od WAL), przy payloadzie nowych minut ≤3,75 MiB/h. Budżet WAL/I/O
obejmuje również stan/findings, retry, zapis cache partnerów i maintenance.
W izolowanym stosie (§10)
porównujemy diagnostykę off/on, także pełną retencję i zaległości po awarii;
mierzymy różnicę CPU gatewaya/PostgreSQL, WAL bytes i zapisane bajty procesu/dysku
na godzinę, rozmiar tabel/indeksów, pool wait oraz p95 RPC. Koszt startu mierzymy
oddzielnie z czasem odtworzenia i szczytem RSS/I/O, bez amortyzowania regresji p95.
Przekroczenie wymaga poprawy lub jawnego ograniczenia szczegółów/częstotliwości,
z zachowaniem pokrycia i wymogu trwałości; nie przenosimy zapisu do obsługi RPC.

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
| `GetComputerDiagnostics` | Wskazany komputer/worker, okno i strona metod/SQL/zasobów; `revision/not_modified`, coverage, missing/dropped. Łączy utrwalone rollupy z bieżącymi danymi bez duplikacji; podaje resolution, gaps, stan odtwarzania i watermark persystencji. Zdalny wariant zwraca wyłącznie dane domu, także odtworzone po restarcie. |
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
Ich trwały zapis może wymagać dodatkowej migracji najwyższy+1 i testu schema.
Te same uprawnienia obowiązują historyczne rollupy i findings; DB nie rozszerza
dostępu partnera. Revoke/unlink przerywa stream, unieważnia download i usuwa cache
partnera z pamięci i DB. Własna historia domu nadal podlega jego retencji.

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
  używanych przez runtime; resetuje tylko bazę/okna diagnostyki. Gateway utrwala
  nową epoch przed potwierdzeniem; restart nie przywraca starych liczników/findings.
  Stare odpowiedzi po epoch są ignorowane, stare rollupy sprząta retention;
  offline reset nie jest kolejkowany.
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
| Overview | Karty wszystkich komputerów: gateway, workery, linki, status kolorem **i tekstem**, ostatnia aktualizacja, top finding, CPU i RTT. Filtr komputera oraz `1 min / 15 min / 1 h / 24 h` (domyślnie 15 min). Historia 15 min/1 h/24 h przetrwa restart, przerwy mają jawne oznaczenie. Offline zachowuje ostatnie liczby jako nieaktualne; `Update to see diagnostics` zamiast pustej zielonej karty. |
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
Odtwarzanie: **Restoring diagnostics**, luka: **No data during this period**,
zaległy zapis: **History could not be saved. Live data is still available.**
Snapshot z DB nie dostaje nowego czasu próbki tylko dlatego, że został wczytany.
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

## 10. Realizacja: PR dokumentacji i sześć etapów implementacji

Rozmiary S/M/L oznaczają odpowiednio jedną powierzchnię, kilka powiązanych modułów
lub zmianę przekrojową; XL oznacza rozszerzony etap przekrojowy z trwałością.
Nie są deklaracją liczby godzin. Każdy etap jest kompletną,
testowalną funkcją, z UI **web/desktop i mobile w tym samym etapie**.
**PR dokumentacji #495 jest dolnym PR-em stosu**, bazuje na `dev`; etap 1 bazuje
na jego branchu `docs/diagnostics`, a każdy następny na poprzednim. Całość pozostaje
draftem do ukończenia i weryfikacji stosu, potem merge razem przez `gh stack`
zgodnie z `AGENTS.md`, nigdy pojedynczy niegotowy etap do `dev`.

| Etap | Zakres, rozmiar i zależność | Dowód zakończenia |
|---|---|---|
| 1. Wspólny overview + RPC + RTT + trwałość | **XL**, po PR #495: kolektor RPC, heartbeat echo workerów i komputerów, owner-scoped odczyty/capability/grants, shared-query, cache/freshness, karty wszystkich domów, RPC table/drill-down, 1 min/15 min/1 h/24 h, findings link/RPC. Minutowy zapis rollupów i findings, odtworzenie ostatniej godziny, retencja 2 h/30 dni, downsampling przy zapisie i cache offline (§5). Direct i dozwolony onward, unsupported/offline. **Pierwsza wartość już tutaj**, dla wszystkich linked komputerów i po restarcie. | Integracja gRPC dwóch gatewayów i workerów, plus trzeciego przez relay: histogram/count/stream cleanup, deduplikacja, brak recursive gather, owner denial/revoke, starsze wersje, RTT vs heartbeat. Test migracji tabel i grants/schema; restart gatewaya/workera i offline cache, ciągłość okien/findings z rzeczywistą luką, retry po awarii DB bez podwójnego naliczania, atomowy watermark. Retencja 2 h/30 dni, downsampling, kwoty i rollback/concurrent pruning; brak oczekiwania RPC na restore oraz owner-scoped godziny pobierane na żądanie. Pomiar kosztu zapisu CPU/WAL/I/O, odtworzenia i p95 on/off. Ręcznie te same dane na trzech klientach. |
| 2. Gateway/DB/governor | **M**, po 1: event loop, zasoby, SQL families/pool waits i powiązanie RPC, ingest/outbox/watch/fan-out/queue, governor wait/admission, kolejne findings i szczegóły. | Integracja gRPC przy obciążeniu ingest i wolnym odbiorcy, zachowane ACK/durability, owner-scoped SQL, błędy reserve/execute i release. Porównanie DB2/concurrent i process-governor z kolektorem on/off, bez EXPLAIN w produkcji. |
| 3. Workery i synchronizacja | **M**, po 2: journal/redelivery, harness TTFT/turn, git, dysk, mirror lag i resubscribe reasons, oba końce finding linku, szczegóły wszystkich workerów. | Gateway↔worker: reconnect/drain/restart, redelivery bez podwójnego naliczania, luki/mirror commit, symulowana wolna sieć, bez dodatkowych probes. Harness adaptery na deterministycznych CLI, brak prompt/path w wynikach, reuse #386 i #409–#411. |
| 4. Klienci i raport/agent | **M**, po 3: agregaty BFF, sampled web/desktop/mobile timings, eksport JSON/Markdown, wybór placement i utworzenie zwykłego wątku, reset epoch. | Integracja auth, rate/size/schema, stara sekwencja/epoch, unpair/revoke, redakcja, załącznik na właściwym domu i idempotentne utworzenie. Benchmarki #413–#419 z oddzieleniem JS od native; ręczny copy audit i parity. |
| 5. Collect logs | **L**, po 4: źródła/rotacja także standalone, lokalna redakcja, autoryzowane zbieranie ze wszystkich domów/workerów, chunk/backpressure, spool/ZIP/manifest/partial/retry, download/share sheet, opcjonalne dołączenie ZIP do akcji agent. | Integracja wielogatewayowa/workerowa: sekrety przecięte chunkami, SQL payload/host/path, odmowa cudzych logów, relay grant/revoke, offline/timeout/rotation, limity/tail, wolny odbiorca/anulowanie, restart cleanup i ZIP bez traversal. Test migracji grants jeśli potrzebna. Test bezpieczeństwa prywatnego kanału desktopu; ręczny download i share, limit załącznika. |
| 6. Czasowy tracing i domknięcie budżetów | **M**, po 5: lease, spany bez payloadów, opt-in eksport na danym komputerze, auto-off oraz pomiar wszystkich trybów. Aktywne sondy pozostają odłożone do decyzji. | Gateway↔worker: start/stop/expiry/restart, brak tracingu na innym domu bez akcji, ograniczenie pamięci i próbek. Współbieżny sync + eksport logów + RPC: wynik budżetu i brak regresji. Ręczny przegląd wszystkich stanów, copy/parity i pełna lista kontroli z `AGENTS.md`. |

**Pomiar narzutu jest bramką każdego etapu**, nie pracą zostawioną wyłącznie na 6.
Porównanie off/on na tej samej rewizji, danych syntetycznych, wersji runtime i maszynie,
**pięć par off/on po rozgrzewce**, kolejność AB/BA/AB/BA/AB (bloki ABBA).
Procesy gatewaya, workera i PostgreSQL przypinamy do oddzielnych fizycznych rdzeni;
`nice -n -5` tylko jeśli host pozwala. Nie zmieniamy affinity innych procesów ani
globalnych cache. Przed każdą parą zapisujemy `/proc/loadavg`, a przez całą parę
próbkujemy swap-in/out (`vmstat 1`). Poniższe progi opisują oryginalny protokół
etapu 1; etapy 2–3 stosują user scope i nowsze bramki opisane w §3.2.
Load powyżej liczby CPU unieważnia parę.
Swap-out ≥128 KiB/s w dowolnej próbce albo ≥1 MiB łącznie na parę także ją
unieważnia. Swap-in odrzuca parę przy ≥1 MiB/s albo ≥128 KiB/s przez trzy
kolejne sekundy. Drobne odczyty starych stron swapu są dozwolone i raportowane
łącznie na parę; zajętość swapu nie jest aktywnością. Zapisujemy odrzucenie
i ponawiamy całą parę, bez wybierania korzystnych fragmentów.
Raport zawiera wszystkie pary, medianę i min/max sparowanych różnic, bez
uśredniania wyłącznie korzystnych przebiegów. Idle (10 min), steady load/sync,
reconnect i wolny odbiorca; procesy osobno jak sync-process fixture.
Raport: różnica CPU w punktach procentowych jednego rdzenia (<1 pp), CPU-sekundy/
RPC, RSS/heap, event-loop p99/max, p95 RPC i otwarcia wątku, przepustowość,
bajty na łączu i liczba alokowanych serii. Od etapu 1 także CPU PostgreSQL,
WAL bytes/h, I/O bytes/h, wielkość rollupów/tabel/indeksów, liczba zapisów/min,
koszt downsamplingu/pruningu/autovacuum i odtworzenia. Pełną retencję testujemy
na syntetycznej historii 30 dni, także przy awarii zapisu i konkurencji o pulę.
Baseline idle bliski zeru nie nadaje się
na mianownik względnego „1%”. Brak rosnącej pamięci po wypełnieniu pierścieni
sprawdzamy również w przebiegu 30 min z churnem klientów/partnerów.

Warunek CPU: mediana sparowanego przyrostu **<1 pp** jednego rdzenia.
Warunek p95: mediana sparowanego przyrostu **< max(1 ms, 10% baseline)**.
RSS w steady i startup VmHWM mają przyrost najwyżej **10 MiB**, synchroniczny
restore na ścieżce startu CPU **<100 ms**, odczyt pełnej historii z DB p95 **<50 ms**.
Przekroczenie wymaga profilu i poprawy przed merge, nie automatycznej
akceptacji. Pięć krótkich par nie dowodzi braku mniejszej regresji: zapisujemy
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

## 11. Decyzje maintainera — zaakceptowane 2026-11-10

Wszystkie wcześniejsze rekomendacje przyjęto. Jedyna zmiana: metryki mają
przetrwać restart dzięki lekkiej persystencji z §5, dostarczanej w etapie 1.

| Obszar | Przyjęta decyzja |
|---|---|
| Nazwa | **Diagnostics**, w General; obejmuje także sieć, świeżość i logi. |
| Historia po restarcie | **Trwała od etapu 1**: rzadkie histogramy/liczniki i ostatnie findings, batch najwyżej raz/min/proces w domowym gatewayu. Minuty 2 h, godziny 30 dni, kwoty i pruning z §5; worker bez DB. Restore ostatniej godziny w tle po uruchomieniu listenera, 24 h z godzin w DB na żądanie. Okna kontynuują historię z oznaczoną faktyczną luką. Koszt zapisu w budżecie narzutu. |
| Dokładność percentyli a pamięć | Stałe 128 kubełków (~19% kwantyzacji) i jawny max/pokrycie; jeśli to za mało do decyzji o optymalizacji, zwiększyć precyzję dopiero po pomiarze budżetu 64/16 MiB. |
| Dane partnerów/onward | Bezpośredni partner tego samego właściciela ma odczyt diagnostyki; logi tylko na jawną akcję ownera. Onward wymaga osobnych, odwoływalnych grants read/logs od domu. Brak grant nie ukrywa karty komputera. |
| Domyślny zakres logów i prywatność | 1 h, wszystkie komputery, 2/12/96 MiB przed kompresją, 100 MiB ZIP, redakcja home On, bez opcji eksportu sekretów. 6/24 h tylko w ramach dostępnej rotacji. |
| Zewnętrzny PostgreSQL i logi systemowe | Brak automatycznego dostępu administracyjnego. Lokalny adapter jawnie udostępnionych logów i manifest `not_available`, jeśli operator go nie skonfigurował; rotację operator potwierdza osobno. |
| ZIP większy niż limit attachment | Nie zwiększać globalnego limitu; mniejszy zakres/wybór komputerów i tekstowy manifest. Agent otrzymuje załącznik wyłącznie po podglądzie właściciela. |
| Aktywne sondy providerów | Odłożone; istniejący ruch i oznaczenie niepewności wystarczą do pierwszej wersji. Tracing maks. 10 min per jawnie wybrany komputer, nigdy automatycznie na wszystkich. |
