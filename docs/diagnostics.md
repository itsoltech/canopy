# Diagnostyka wydajności

Status (2026-11-18): **v1 wdrożone**: metryki RPC, procesu, DB, workerów i klientów,
trwałe agregaty, findings, raport, zbieranie logów i czasowy tracing.
Limit katalogu 640 deskryptorów obejmuje także RPC statystyk użycia i postępu przygotowania wątku.
Settings → Diagnostics jest dostępne w web/desktop/mobile i pokazuje lokalny
komputer oraz znane połączone komputery, ich gatewaye, workery i łącza.
Telefon korzysta ze sparowanego gatewaya. Brak dostępu, starsza wersja i offline
są odrębnymi stanami. Budżety wydajności poniżej są celami i procedurą pomiaru,
nie deklaracją zmierzonego narzutu obecnej wersji. Na `dev` (2026-11-15) wysyłka
pomiarów klientów obsługuje równoległe okna i przeładowania, a web/desktop i BFF
wstrzymują ją po limicie gatewaya. Web/desktop i BFF pomijają puste partie.
Gateway rezerwuje miejsce na metadane aktywnych klientów przed zapełnieniem budżetu przez RPC.
Dostępność według [wydań](release.md).
Na `dev` widok obejmuje też bieżącą zajętość plików Canopy, oddzielnie dla
gatewaya/desktopu i workerów, z wyłączeniem plików projektów, worktree i scratch (§3.3.1).

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
- Agregaty zbieramy w pamięci i utrwalamy lekkimi partiami w bazie domowego gatewaya:
  minuty przez 2 h, godziny przez 30 dni, bez zapisów na każde RPC.
  Budżet narzutu obejmuje zapis i retencję. Szczegółowe próbki tylko po czasowym
  włączeniu na wskazanym komputerze; nie są utrwalane.
- Zbieranie logów obejmuje wyłącznie zarejestrowane źródła Canopy. Nie pobiera
  transkryptów, katalogów projektów, konfiguracji sekretów ani dowolnych plików.

## 2. Co już istnieje i co wykorzystać

| Źródło | Obecna odpowiedzialność |
|---|---|
| `apps/gateway/src/diagnostics/{service,collector,interceptor,registry}.ts` | Wspólny kolektor RPC i rejestr zamkniętych metod; publiczne RPC bez dodatkowego kodowania do pomiaru bajtów. |
| `diagnostics/{process,database,ingest,sync}.ts`, `packages/process-governor/src/governor.ts` | Zasoby procesu, rodziny SQL/pula, ingest/fan-out, governor i synchronizacja; bez parametrów SQL, treści zdarzeń i argv. |
| `diagnostics/{persistence,history,store,peers}.ts` | Minutowe/godzinowe rollupy, odtwarzanie, cache partnerów i odświeżanie poza obsługą RPC. |
| `apps/worker/src/diagnostics/`, `apps/gateway/src/diagnostics/{links,worker-report}.ts` | RTT z echo heartbeat, agregaty journala, tur, git i zasobów, negocjowane przez WorkerLink. |
| `packages/transport/src/sync-metrics.ts`, `computers/sync-codec.ts`, `core/thread-update-bytes.ts`, `apps/web/src/lib/server/sse.ts` | Wykorzystanie istniejących zakodowanych bajtów; szczegółowe `CANOPY_SYNC_METRICS` pozostaje osobnym opt-in, bez per-message `cpuUsage()` w zwykłej diagnostyce. |
| `apps/web/src/lib/server/gateway-logging.ts`, `apps/web/src/lib/features/diagnostics/`, `apps/mobile/src/features/settings/Diagnostics*.tsx` | Agregaty BFF, próbkowane pomiary klientów, Settings i jawne działania właściciela. |
| `apps/gateway/src/diagnostics/{report,actions,log-jobs,tracing}.ts`, `packages/logs/` | Zredagowany raport, wątek badania, logi ze stałych źródeł i tracing z terminem wygaśnięcia. Desktop używa tego samego writera logów. |
| `scripts/bench/diagnostics*.ts`, `scripts/bench/diagnostics*.sh` | Izolowane porównania narzutu. Benchmarki DB/klienta nie są produkcyjnym kanałem metryk; ich ślady i wyniki pozostają poza repo. |

RTT, wiek heartbeat i czas zestawienia trasy mają różne definicje. Zdarzenie
resubskrypcji `revision` samo nie dowodzi awarii sieci. Pomiar renderera JS
nie jest natywnym paint/FPS, a tracer benchmarków DB nie działa w produkcji.

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
2 MiB na BFF/klienta** to ogólne budżety funkcji, nie zmierzone zużycie. Cel przyrostu RSS i startowego
VmHWM wynosi **≤10 MiB** względem wyłączonego kolektora. Rezerwacje live są ograniczone
do 6 MiB dla metod i 2 MiB dla łączy, historyczny widok DB do 1 MiB.
Histogramy zarówno w RAM, jak i na dysku zawierają tylko niezerowe pary indeks/licznik;
na dysku indeksy i liczniki są pakowanymi varintami. Zerowe kubełki nie mają alokacji.
Gateway dopuszcza do 640 deskryptorów i 16 łączy worker/komputer; cache overview
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
| `request/response_bytes` | Rozmiar protobuf na granicy istniejącego encode/decode wewnętrznych linked RPC, przed ramkowaniem, TLS i kompresją, w każdym kierunku osobno. Publiczny interceptor nie ma tego hooka: pokazuje `Not measured`, nie zero. Nie kodujemy wiadomości drugi raz. |
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

**Serie wnętrza gatewaya** współdzielą pierścienie i limit
6 MiB kolektora, przejściowy budżet scalania 512 KiB oraz cache godzin 1 MiB.
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
256 korelacjach slotu; globalne serie nie zużywają tego limitu i nadal podlegają
wspólnemu limitowi RAM.
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
Watche, kolejki i overflow obserwują istniejący Hub; lustra obejmują aktywne
subskrypcje mirrorów wątków/botów. Pomiar lagu opisuje §3.3.

Nowe findings oceniają świeżą minutę: p99 event loop >100 ms przy ≥1000 próbek
(critical >500 ms), średnio >0,5 oczekującego reserve przez ≥30 s
(critical >5), execute p95 rodziny >100 ms przy ≥30 próbkach
(critical >1 s), governor wait p95 >1 s przy ≥30 admissions i niepustej kolejce.
Wymagają ≥3 min pokrycia, trzech ocen wejścia i pięciu ocen wyjścia poniżej 70%
progu; brak świeżości zawiesza ocenę. Ruch ingest/fan-out w tej samej minucie
dopisuje korelację sync do event loop, bez przypisania przyczyny.

Pomiar kosztu korzysta z istniejącego harnessu `scripts/bench/diagnostics.ts`
i launcherów `diagnostics-stage2.sh`–`diagnostics-stage6.sh`. Numer etapu wybiera
warstwę instrumentacji do porównania, nie stan wdrożenia. Launchery zachowują
kontrolę nazw dawnych gałęzi etapów; nie są uniwersalnymi komendami uruchamianymi
na dowolnej bieżącej gałęzi. Niższe warstwy pozostają
włączone w obu członach pary; badana warstwa jest przełączana off/on.
Każdy człon ma świeży proces, klaster PostgreSQL i prywatny stan. Fixture obejmuje
RPC, synchronizację, wolnego odbiorcę, awarię zapisu, pulę i governor; dodatkowe
fazy raportu/logów/tracingu zależą od launchera.

Pełne nagrania wymagają spokojnego hosta i osobnego okna. Aktualne launchery
stosują cztery pary AB/BA/AB/BA oraz kontrolę A/A, user scope z `MemorySwapMax=0`
dla drivera/gatewaya/workerów i oddzielny dla PostgreSQL. Nieczytelny licznik swapu,
swap w scope, load ponad liczbę CPU lub host swap-in ≥4 MiB/s przez trzy kolejne
sekundy unieważnia parę. Host swap-out jest rejestrowany; raport zachowuje wyniki
i powody odrzuceń. Analiza wrażliwości nie zastępuje mediany wszystkich przyjętych par.
Bez delegowanego licznika I/O raport ma `null` z powodem i nie potwierdza tego budżetu.
Nie porównujemy wyników z różnych wersji PostgreSQL jak jednej pary.

Profilowanie CPU/heap i `diagnostics-retention.sh` są osobnymi przebiegami
badania kosztu i retencji. Ich wymuszone GC/snapshoty nie uczestniczą w nagraniu
akceptacyjnym. Ślady mogą zawierać prywatne dane testowe i poświadczenia bazy;
pozostają poza repo. Gotowy launcher ani przegląd kodu nie są dowodem spełnienia
budżetów; potrzebne są wyniki konkretnej rewizji (§10).

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
łącznie z odtworzoną historią, mają wspólny podlimit 4 MiB wewnątrz istniejących
6 MiB kolektora. Podlimit obejmuje obiekty i sparse kubełki, oddaje rezerwacje
po wygaśnięciu slotu i zwiększa jawne dropy po wyczerpaniu. Rodziny SQL i korelacje
mają dodatkowy podlimit 3 MiB w tych 4 MiB, aby nie wypierać serii procesu,
kolejek i governora. Przy presji pamięci szczegóły są niepełne, nie rozszerzają limitu.
Odtwarzanie historii może wykorzystać najwyżej połowę każdego podlimitu,
aby zostawić miejsce na bieżące próbki po restarcie.
Limit korelacji obejmuje wyłącznie korelacje, bez globalnych serii. Metryka
`Dropped measurements per second` pokazuje przyrost jawnego licznika dropów
podzielony przez rzeczywiście obserwowany czas ticka; przerwy ponad 10 s i skoki
zegara nie tworzą sztucznej szybkości. Średnia jest ważona czasem obserwacji.
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
| Link RTT, heartbeat, jitter | Capability `diagnostics_v1`: istniejący heartbeat workera zawiera numer sekwencji, gateway odsyła krótkie echo przed pracą DB. Worker mierzy send → echo na własnym zegarze, najwyżej jedno echo oczekujące. Jitter = histogram `abs(RTT[n] − RTT[n−1])` w jednej sesji. Odbiorca osobno mierzy interwał nadejść i wiek ostatniego heartbeat; to nie jednokierunkowa latency. Brak echo/timeout to osobny licznik, nie próbka zakończona timeoutem udająca RTT. |
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

**Agregaty workera:** `worker_diagnostics_v1` negocjuje serie niezależnie
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

Pomiar workerów ma osobny launcher `diagnostics-stage3.sh`; utrzymuje pozostałe
warstwy w obu wariantach. Fixture używa prawdziwego journala/ACK/replay,
deterministycznego ACP, git i lokalnego odbiornika mirroru z commitami PostgreSQL.
Lokalne ramki mirroru nie zastępują próby wolnego zdalnego transportu gRPC.

### 3.3.1 Bieżąca zajętość plików Canopy

`DiagnosticsStorage` jest aktualnym snapshotem, niezależnym od okna metryk.
Ma zamknięte kategorie `logs`, `data`, `cache`, `application`, `database`, czas,
wiek próbki i stan `measuring`, `ready`, `partial` albo `unavailable`.
Nie sumujemy komponentów ani próbek w czasie. Kategorie mierzą długości zwykłych
plików, bez narzutu bloków, kompresji, klonów CoW i rozmiarów katalogów.
Zagnieżdżony root ma pierwszeństwo przed rodzicem; wspólne inode plików i katalogów
są liczone raz w obrębie skanu. Symlinki, w tym rooty z symlinkiem w ścieżce,
nie są śledzone. Nazwy plików, ścieżki i treści nie przekraczają granicy źródła.

Wspólny `StorageSampler` wykonuje asynchroniczny skan najwyżej raz na minutę,
koalescuje odczyty i oddaje event loop co 64 wpisy. Budżet skanu to 100 000 wpisów
lub 2 s; limit czasu jest kooperacyjny, sprawdzany między operacjami metadanych,
i nie przerywa trwającego systemowego `lstat` ani innego odczytu metadanych.
Przekroczenie daje `partial` i dolne ograniczenie rozmiaru. Odczyt API
zwraca od razu poprzedni snapshot i uruchamia odświeżenie w tle. Nie uruchamia
`du`, nie czyta zawartości plików ani nie blokuje RPC oczekiwaniem na skan.

Gateway serwerowy rejestruje własne logi, spool eksportu diagnostyki, rzeczywiście
wybrany cache wydań i rozpakowanego web, także prywatny fallback tymczasowy.
Instalacja binarna dodaje plik wykonywalny, jego kopię rollback `.bak` oraz znane
pliki stanu i blokady aktualizacji; nie skanuje całego katalogu instalacji.
Checkout źródeł i uruchamiający go Bun nie są aplikacją do policzenia.
`pg_database_size(current_database())` jest osobną kategorią poza sumą plików hosta:
baza może działać na innym komputerze,
a wynik SQL nie obejmuje WAL ani całego klastra. Obraz kontenera nie jest skanowany.

Gateway desktopu korzysta z katalogów przekazanych prywatnie przez kontroler:
`CANOPY_DESKTOP_DATA_DIR`, opcjonalnego `CANOPY_DESKTOP_APP_PATH` i cache aktualizacji
`CANOPY_DESKTOP_UPDATE_CACHE`. Liczy pliki `postgres/data` jako bazę, bez dodatkowej
sumy SQL. Desktop obejmuje zarejestrowane, zarządzane wpisy katalogu danych:
wspólne logi, profil, cache, instalację i dane workerów, także zachowane instancje
zdalne. Nieznane wpisy, w tym umieszczony tam projekt, są pomijane. Osobny wiersz
workera pokazuje szczegół danych już uwzględnionych w sumie desktopu i nie jest
do niej dodawany ponownie. Rooty są współdzielone z lokalnym BFF.

Przed skanem gateway pobiera owner-scoped ścieżki workspace, cwd wątków i worktree
i wyklucza je z rootów. Lista jest ograniczona do 4096 wpisów, odczyt do 3 s,
pojedynczy SQL do 1 s. Niepełna lista, ścieżka względna lub błąd blokuje nowy skan i zachowuje
poprzedni pomiar jako `partial`, z pierwotnym czasem; bez poprzedniego wyniku
stan jest `unavailable`. Absolutne ścieżki innych systemów operacyjnych są poprawnymi
metadanymi workerów; do lokalnego skanera trafiają tylko ścieżki natywne gatewaya.
Ścieżka Windows zależna od bieżącego katalogu dysku, np. `C:project`, jest względna.
Stałe wykluczenia workera i desktopu obejmują scratch,
zarządzane worktree i robocze workspace botów, również wewnątrz katalogu danych.

Worker przesyła wynik istniejącym uwierzytelnionym raportem WorkerLink, bez
journala i outboxa. Gateway rekonstruuje zamknięte pola, odrzuca niepoprawne
kategorie i zachowuje reguły sesji, sekwencji oraz trwałego baseline. Wiek skanu
przenosi względem końca partii na zegar gatewaya; ponowne przesłanie tego samego
skanu nie odświeża jego czasu. Początkowy `measuring` po zmianie sesji nie zastępuje
ostatniego poprawnego wyniku, podobnie jak próbka starsza po przeliczeniu jej daty
na zegar gatewaya. Istniejący trwały stan diagnostyki zapisuje maksymalnie 16
ostatnich pomiarów workerów, także pełnych sum zdalnego desktopu, oddzielnie od
sesji i sekwencji chroniących przed replay. Po restarcie gatewaya wynik i czas
pozostają dostępne dla workera offline. Wiek odtworzonej próbki nie maleje poniżej
zapisanego wieku; po cofnięciu zegara przyszła data jest przesuwana ostrożnie
wstecz, a dalszy upływ czasu jest mierzony monotonicznie.
Połączone komputery udostępniają dane przez istniejący
snapshot i grant `diagnostics_read`, bez nowego portu ani uprawnienia logów.
Odbiorca przesuwa datę próbki na własny zegar, a wiek zwiększa czasem pobytu
w cache mierzonym monotonicznie; po odtworzeniu cache oznacza niepewność wieku.

Desktop remote przesyła sumę całej aplikacji przez uwierzytelniony raport
bundlowanego workera jako komponent `desktop`, więc domowy gateway udostępnia
ją także swoim klientom web/mobile i połączonym komputerom z dostępem do
diagnostyki. Zwykły worker oraz worker lokalnego desktopu raportują komponent
`worker`. Gdy własny worker desktopu nie dostarcza sumy aplikacji, lokalny BFF
dodaje zapasowy snapshot `DiagnosticsSnapshot.desktop_storage` przez istniejącą
sesję main/kontrolera. Ten fallback pozostaje prywatny dla urządzenia i znika,
gdy dostępny jest raport całej aplikacji, aby nie powielać wiersza. Osobny zwykły
BFF nie otrzymuje ścieżek desktopu. Lokalny BFF może zwrócić ten pomiar także przy
niedostępnym zdalnym gatewayu; błędy uwierzytelnienia nadal odrzucają żądanie.

### 3.4 Połączone komputery i wspólny obraz

Każdy dom utrzymuje i zapisuje własne agregaty gatewaya i swoich workerów (§5).
Po restarcie udostępnia odtworzone okna i findings tymi samymi trasami.
Lokalny gateway
buduje katalog z własnego komputera i autoryzowanych komputerów znanych przez
`GetComputers`, obecność, bezpośrednie linki oraz istniejące trasy onward (maks. jeden relay).
Nie odkrywa sam obcych gatewayów. Wszystkie te komputery mają kartę, także offline,
starsze i bez zgody; brak danych nie usuwa komputera z widoku.

**Transport:** polling gotowego agregatu po istniejących
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
Przesyłamy gotowe agregaty wybranego okna, bez wewnętrznych slotów ani per-call samples.
Przy braku zmiany rewizji wystarcza `not_modified`.
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

Identyfikatory 364–399 zawierają po 12 stałych serii dla web, desktop i mobile:
10 liczników kategorii awarii watcha wątku, kod RPC i rozmiar odrzuconej partii.
Kategorie obejmują limit rozmiaru, lukę seq, błędny checkpoint/odczyt/rekord,
brak dostępu, niedostępny komputer, utratę streamu, timeout i pozostałą awarię.
Nie są próbkowane; obowiązują istniejące limity kolektora. Żaden tekst wyjątku,
identyfikator wątku, trasa ani treść wiadomości nie staje się etykietą lub payloadem.
Eksport korzysta z tych samych agregatów. Partia klienta przyjmuje do 24 miar,
nadal do 16 KiB oraz 60 KiB/min; kod RPC mieści się w 1–16, rozmiar w uint32.

W wolnych offsetach 12–15 istniejących rejestrów klientów dodano: czas do
aktualnego stanu wątku (nawigacja → pierwsze rAF po aktualnym cache lub catch-up),
trafienie aktualnego cache (0/100, średnia daje procent), liczbę odczytów historii
w tle oraz bajty payloadu cache. To nie jest pomiar heapu ani prezentacji klatki.
Aktualność odnosi się do ostatniego owner-scoped headu z overview, którego sonda
działa co 2 s. Tło i offline nie tworzą pozornych trafień. Czasy otwarć są próbkowane
jak dotąd; stałe liczniki trafień/żądań oraz próbka bajtów co minutę są ograniczone
niezależnie. Szczegóły i budżety: [client-performance.md](client-performance.md).

BFF mierzy unary od wejścia do `transport.unary` do wyniku/błędu; zawiera transport,
kolejki HTTP/2 i czas gatewaya. Stream: czas do pierwszej wiadomości, lifetime,
liczniki wiadomości/bajtów na istniejącym kodowaniu SSE. BFF i gateway pokazujemy
osobno; różnica percentyli nie jest latency sieci. `gateway-deadlines.ts` współdzieli
rozpoznanie lokalnych/zdalnych pul; `gateway-logging.ts` zachowuje logowanie błędów.

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

**Agregaty klientów:** każda partia zawiera najwyżej 24 serie, bez identyfikatorów
wątków, adresów i treści. Web/desktop mierzy rozmiar cache wątku przy zmianie jego
rozmiaru lub gdy zebrał inne obserwacje. Okno z niezmienionym cache i BFF bez
nowych pomiarów pomijają wysyłkę. Jedna wysyłka może być w toku;
błąd porzuca partię. Po `ResourceExhausted` (HTTP 429) przeglądarka/desktop i BFF
wstrzymują wysyłkę wykładniczo: pierwsza przerwa co najmniej 60 s, potem podwajana do
5 min; odrzucona partia nie jest kolejkowana, a pierwsza przyjęta wysyłka zeruje
przerwę; kontrakty HTTP i proto się nie zmieniają. Suspend czyści obserwacje; partia
starsza niż dwie minuty nie dostaje nowego czasu próbki. Mobile mierzy pierwszy reducer snapshotu/batcha;
dekoder wewnątrz biblioteki Connect nie udostępnia osobnego hooka. Ta seria nosi
nazwę `First snapshot reducer`, bez deklarowania kosztu decode lub native paint.
Feed jest obserwowany od montowania do dwóch klatek JS po layout; opóźnienia JS
nie są miarą płynności natywnego UI. Web używa buforowanego Paint Timing dla FCP.

Gateway dopuszcza 30 aktywnych sesji (nadawca + źródło + sesja klienta) i 30
wspólnych limitów nadawców, wygasających po pięciu minutach bez aktywności. Każde
okno, karta i przeładowanie ma własny checkpoint: hash nadawcy, źródła i sesji
oraz najnowszą przyjętą sekwencję. Równoległe okna jednego nadawcy są przyjmowane
niezależnie, a szybkie przeładowania nie wymagają założeń o „wycofanej” sesji;
powtórzona lub starsza sekwencja tej samej sesji jest ignorowana. Trzydziesta pierwsza
jednoczesna sesja dostaje `ResourceExhausted`. Wygaśnięcie (300 s)
jest dłuższe niż tolerancja świeżości partii (±120 s w obie strony, razem 240 s), więc
po nim stare partie są już nieświeże i nie dają się powtórzyć; checkpointy odtworzone
po restarcie nadal je zatrzymują. Limit 60 KiB/min jest wspólny dla całego
uwierzytelnionego nadawcy (BFF, przeglądarka, wszystkie sesje), nie osobny dla źródła.
Tożsamość pochodzi z tokenu urządzenia
lub HttpOnly cookie nadanego przez BFF. Etykiety mają wyłącznie stałe numery 300–399 i 450–455.
Numery 450–455 obejmują liczbę odzyskań osi czasu i czas żądanie starszej strony →
gotowość renderera, osobno dla web, desktop i mobile; nie dodają etykiet z treści.
Z istniejącego limitu 6 MiB gateway z góry rezerwuje 92 KiB na metadane klientów,
w tym 30 wpisów nadawców, 30 sesji i 60 checkpointów. Dzięki temu równoległy ruch
RPC nie odbiera klientom miejsca na przyjęcie partii podczas zmiany minuty.
Zamrożenie minuty przenosi checkpointy do rollupu i zwalnia ich miejsca dla nowych
partii. Przy zaległym zapisie dodatkowe checkpointy przed zamrożeniem wymagają
wolnego miejsca we wspólnym limicie. Rezerwacja na metadane resetu wynosi 8 KiB. Hash sesji i sekwencja trafiają
atomowo do watermarków wraz z rollupem, więc restart nie nalicza partii ponownie.

Raport to jawna projekcja allowlisty: JSON/Markdown do 256 KiB, aliasy komputerów
i workerów oraz lista pominiętych serii/stron. Podgląd ma podpis ważny dziesięć
minut; utworzenie zwykłego wątku wymaga osobnego potwierdzenia placement i providera.
Migracja `0130_diagnostics_actions` wiąże idempotencję z ownerem i trwałym wątkiem;
receipt znika z wątkiem, bez niezależnego TTL. Załącznik, wątek ASK, outbox i receipt
powstają w jednej transakcji. Ponowienie po restarcie zwraca zapisany wątek.

Reset zapisuje epoch i granicę wybranego procesu przed ACK. Usuwa tylko jego
historię/findings; nie zmienia journala, outboxa ani runtime governora. Partie
workera rozpoczęte przed zapisaną granicą są pomijane również po restarcie;
niedokładny zegar workera może przedłużyć tę lukę. Klienci odrzucają starsze epoch
i usuwają cache odczytów rozpoczętych przed potwierdzeniem. Offline reset nie jest
kolejkowany, a sterowanie linked wymaga bezpośredniego połączenia bez relay.

Launcher `diagnostics-stage4.sh` porównuje koszt BFF i syntetycznych partii
klientów, osobno od gatewaya/workera. Faza `report` mierzy jawny eksport;
probe JS wykorzystuje istniejący decoder/reducer/feed/cache. To pomiar JS,
bez deklarowania wyniku natywnego urządzenia.

## 4. Reguły zdrowia i zalecenia

Mały deterministyczny moduł domeny otrzymuje agregaty i capability, zwraca
`rule_id`, komputer/łącze, `severity` (`info`, `warning`, `critical`), dowód
(wartość, próg, okno, liczba próbek, pokrycie), poziom pewności i rekomendację.
Bez modelu, zewnętrznych usług i samoczynnego restartowania/zmieniania ustawień.
Stan karty wynika z najpoważniejszego aktywnego finding; brak pokrycia daje
`Not enough data`, nie zielone „Healthy”. Stan sieci/offline jest osobny od zdrowia.
Wystarczające dane oznaczają pokrycie co najmniej 75% wybranego zakresu
(45 s / 11 min 15 s / 45 min / 18 h). Krótki restart nie zeruje zakresu:
odtworzone minuty i godziny wchodzą do pokrycia razem z bieżącymi pomiarami.
Karta pozwala rozwinąć rzeczywiste luki z czasem rozpoczęcia i długością;
nie przypisuje im przyczyny aktualizacji bez takiego dowodu.
Utrata pomiarów daje osobne `Partial data`, a zawieszone findings
`Some checks are pending`, zamiast unieważniać całe pokrycie.

Licznik odrzuceń kolektora pozostaje dożywotni dla pomiarów wewnętrznych.
Odpowiedź UI liczy odrzucenia wyłącznie z wybranego okna, w ograniczonym
pierścieniu minutowym, z zamkniętymi kodami `limit_reasons`.
Liczba i powody utraty w minucie są utrwalane z procesem i sumowane w godzinach,
więc restart zachowuje również informację o rzeczywistych brakach.
Pominięcie starego slotu podczas odtwarzania jest przypisane do czasu slotu,
nie do startu nowego procesu. Przyczyny rozróżniają pamięć, bufor SQL,
korelacje, pokrycie, historię, kolekcję zdarzeń, zapis, linki, rozmiar
odpowiedzi i walidację. Tracing ma własne limity i nie ustawia tej flagi.
Kody nie zawierają nazw hostów, SQL ani tekstów wyjątków.

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
historię i wymaga świeżych ocen (§5.3). Próg wystarczającego pokrycia karty
jest niezależny od minimum próbek i histerezy poszczególnych findings.
p99 przy n<1000 pozostaje liczbą o małej próbie,
z takim oznaczeniem i bez samodzielnej eskalacji. Planowy drain, sen, zmiana
trasy i legacy revalidation nie uruchamiają alarmu sieci. Deduplikacja per reguła/
komputer/łącze, bez toastu na każdy tick i bez systemowych powiadomień w tym zakresie.

## 5. Trwałe agregaty, retencja i restart

Migracja `0129_diagnostics` wprowadza tabele agregatów, stanu, cache partnerów
i grantów odczytu. `0130_diagnostics_actions` dodaje trwałe receipty działania
agenta, a `0131_diagnostics_logs` granty logów i zakres uprawnienia.
Panel Thread sync z #543 pozostaje w tym samym widoku Diagnostics na web i mobile:
jego owner-scoped, trwały postęp jest źródłem seq/head oraz błędów synchronizacji,
bez drugiej tabeli ani duplikowania tych rekordów w kolektorze metryk procesu.

**Persystencja:** każdy proces zbiera metryki w pamięci;
tylko domowy gateway zapisuje je do PostgreSQL. Dotyczy to także agregatów workerów
przesłanych przez WorkerLink oraz BFF/klientów. Każdy dom zapisuje własne
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

Zwykłe zalogowane tabele:

| Tabela | Klucz i ograniczenie |
|---|---|
| `diagnostics_rollups` | `(owner_user_id, computer_id, resolution, bucket_start)`; jeden blob z procesami domu na minutę/godzinę. Do 64 KiB payloadu na rekord, około 120 minut i 720 godzin na komputer; twarda kwota 180 minut pozostawia godzinę na opóźnienie maintenance. Sesje/restarty nie tworzą osobnych wierszy. Indeks klucza obsługuje zakres czasu i pruning. |
| `diagnostics_state` | `(owner_user_id, computer_id)`; do 64 KiB stanu lokalnych procesów/findings, reset epoch i watermarków. Cache partnerów jest oddzielony do `diagnostics_peer_cache`; stan domu nie zawiera ich historii. |
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

Sprzątanie korzysta z `apps/gateway/src/maintenance/{job,prune}.ts` według
[database-retention.md](database-retention.md): trwały checkpoint, `SKIP LOCKED`,
do 256 rekordów na tabelę/partię, lock timeout 100 ms, statement timeout 1000 ms,
bez I/O poza DB w transakcji. Downsampling ma osobno ograniczony koszt dekodowania
jednej godziny i korzysta z tego samego harmonogramu; rollback ponawia całą partię.
Kolejne zmiany schematu wymagają addytywnej migracji i aktualizacji
`packages/db/test/schema.test.ts`, zgodnie z [AGENTS.md](../AGENTS.md#contracts-and-database).

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

Kolektor rozdziela odtworzone kubełki od bieżących w ramach wspólnego
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
bajty istniejącego encode/decode. Zasoby procesu, DB/pool, eksport, logi i tracing są wdrożone osobnymi modułami;
nie usuwają tego ograniczenia pomiaru publicznych payloadów.

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

Wiadomości znajdują się w `proto/canopy/ui/v1/diagnostics.proto`, a metody
w istniejącym **`GatewayService`**. Dzięki temu mobilny transport,
service token BFF, odwołanie tokenu urządzenia i `serviceTokenAuth` mają tę samą
granicę; nowa publiczna usługa wymagałaby jawnego rozszerzenia auth.

| RPC/protokół | Zakres |
|---|---|
| `GetDiagnostics` | Zsumowany lokalny widok kart, findings i znaczników świeżości; lokalne dane + cache, nigdy blokujące gather do wszystkich partnerów. |
| `GetComputerDiagnostics` | Wskazany komputer/worker, okno i strona metod/SQL/zasobów; `revision/not_modified`, coverage, missing/dropped. Łączy utrwalone rollupy z bieżącymi danymi bez duplikacji; podaje resolution, gaps, stan odtwarzania i watermark persystencji. Zdalny wariant zwraca wyłącznie dane domu, także odtworzone po restarcie. |
| `SubmitDiagnostics` | Ograniczone agregaty BFF/klienta; owner z auth, bez swobodnych etykiet i tekstów. Worker raportuje oddzielnie przez addytywną wiadomość WorkerLink. |
| `ResetDiagnostics`, `ControlDiagnosticsTrace`, `ExportDiagnosticsTrace` | Reset epoch oraz start/stop/eksport tracingu wyłącznie jawnie wybranego domu/workera; autoryzacja ponownie u celu. Bez zbiorczego sterowania i bez relay tych metod. |
| `CollectDiagnosticsLogs`, `GetDiagnosticsLogsJob`, `DownloadDiagnosticsLogs`, `CancelDiagnosticsLogs` | Owner-scoped zadanie zbiorcze i postęp/manifest; odczyt ZIP jako ograniczony stream chunków. Capability `diagnostics_logs_v1` umożliwia domowi wyeksportowanie tylko swoich źródeł. Retry jest nową autoryzowaną próbą. |
| `PrepareDiagnosticsReport`, `InvestigateDiagnostics` | Zredagowany podgląd JSON/Markdown, potem osobno potwierdzone utworzenie zwykłego wątku z raportem i opcjonalnymi logami. |
| `GetDiagnosticsGrants`, `SetDiagnosticsGrant` | Odczyt i zmiana odwoływalnych uprawnień onward na domu: diagnostyka i logi osobno. |
| `WatchDiagnosticsLogSource`, `ReplyDiagnosticsLogSource` | Uwierzytelniona rejestracja stałych źródeł lokalnego BFF/kontrolera i wymiana ograniczonych porcji; bez ścieżek od renderera. |

Wewnętrzny `DiagnosticsService` w `proto/canopy/link/v1/link.proto` działa
przez istniejącą kopertę remote i jawną allowlistę. `ReadDiagnosticsSnapshot`
zwraca tylko dane domu; `ResetDiagnosticsCounters` jest direct-only.
Oba używają `diagnostics_v1`. `CollectHomeDiagnosticsLogs` wymaga
`diagnostics_logs_v1`, a `ControlHomeDiagnosticsTrace`/`ExportHomeDiagnosticsTrace`
— `diagnostics_trace_v1` i bezpośredniego łącza. Nie ma osobnej publicznej usługi
ani capability `diagnostics_control_v1` dla resetu.
Odczyt snapshotu i zbieranie logów mają osobne zgody; `CollectHomeDiagnosticsLogs` jest efektem
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
Progress joba odczytujemy co 1 s tylko podczas zbierania. ZIP jest strumieniowany
przez BFF HTTP download na web oraz Connect na mobile, bez binarnego ZIP w SSE.
Eksport trace jest ograniczoną odpowiedzią unary JSON; klient zapisuje ją jako
`canopy-trace.json`. Brak odczytu diagnostyki z modelu bez akcji ownera.

## 7. Zbieranie logów ze wszystkich komputerów

**Collect logs** otwiera wybór ostatniej **1 h / 6 h / 24 h** (domyślnie 1 h)
i listę lokalnego oraz wszystkich połączonych komputerów, domyślnie zaznaczonych.
Komputery niedostępne/bez uprawnienia pozostają widoczne z powodem. Gateway
koordynuje jedno zadanie właściciela, najwyżej dwa komputery równolegle i jeden
eksporter na komputer. Nie zbiera logów okresowo ani po samym otwarciu Settings.

### 7.1 Źródła i rotacja na komputerze

Eksporter posiada stały rejestr źródeł: `desktop.log`, `gateway.log`, `worker.log`,
`postgres.log`, `web.log`, `initdb.log`, dla każdego lokalnego workera oddzielny
alias. Wspólny writer `Logs` pochodzi z `@canopy/logs`; desktop runtime go re-eksportuje.
Gateway, worker i BFF nie importują aplikacji desktopowej. Supervisor nadal
zbiera wyłącznie własne stdout/stderr. Zdalny worker redaguje u siebie, zanim
wyśle porcję do swojego gatewaya; BFF analogicznie.

Writer ogranicza źródło do **5 MiB × 4 pliki**, z sufitem 128 MiB dla sześciu
źródeł lokalnego rejestru i retencją 7 dni. Linia ma limit 16 KiB; nadmiarowe
lub niepełne rekordy są pomijane. Rotacja jest sprawdzana przed dopisaniem,
a czyszczenie przy starcie i najwyżej raz na godzinę podczas zapisu.
`initdb.log` może nie występować w ostatnim zakresie; manifest podaje brak/wygaśnięcie.
Nie obiecujemy całych 24 h przy dużym ruchu — manifest podaje dostępne pokrycie.

Standalone worker/gateway/BFF korzystają z tego samego ograniczonego writera; w desktopie
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
w URL. Mobile zapisuje ograniczony plik w prywatnym cache i usuwa go po eksporcie,
TTL lub unpair. Eksport mobilny wykorzystuje istniejące API:
iOS używa istniejącego Share, Android — **Save logs** z wyborem katalogu
przez Storage Access Framework. Po zapisie pokazuje nazwę pliku i katalogu;
**Open folder** pojawia się, jeśli system obsługuje otwarcie URI katalogu.
Natywny share sheet Androida pozostaje możliwym rozszerzeniem przy następnym
wydaniu wymagającym nowego buildu natywnego.

Na `dev` eksport rozpoznaje też błędy botów. `bot_turn_failed` zachowuje
wyłącznie `failureSource` (`provider`, `harness`, `platform`) i zamkniętą klasę
`failureClass`. Starszy komunikat błędu bez tych pól daje tylko rodzaj zdarzenia,
bez odtwarzania klasy z prozy. `bot_tool_finished` zachowuje `toolSource`,
`operation` (`start_thread`, `send_message`, `send_bot_message`, `other`) oraz
`outcome` (`completed`, `failed`, `discarded`, `changes_requested`, `expired`,
`interrupted`). Wynik oznacza zatwierdzony wynik narzędzia, a nie zakończenie
pracy docelowego agenta. Źródłem wyników narzędzi jest wyłącznie gateway.
Rozpoznawane są również stałe zdarzenia błędu tick/wake kolejki, rozliczenia tury
i journala harnessu. Koordynator niezależnie waliduje zamknięty format i źródło;
nieznane wartości i dodatkowe pola pozostają pominięte. Archiwum starej wersji
nie odzyskuje rekordów pominiętych przy jego tworzeniu.

Eksport wykorzystuje zamknięte szablony zdarzeń. Nie kopiuje swobodnych
komunikatów, parametrów SQL, stacków ani nieznanych JSON-ów; manifest podaje
liczbę pominiętych rekordów. Koordynator ponownie sprawdza format przed ZIP.
Pierwszy pull przygotowuje jedno źródło, zamiast blokować na skanowaniu wszystkich.
Rotacje są czyszczone przy starcie i najwyżej raz na godzinę podczas zapisu.

Wyniki ingestu mają rozpoznawane szablony `worker_events_not_stored`,
`worker_events_dropped`, `worker_events_quarantined` i `worker_events_deferred`.
Pierwszy obejmuje też wcześniejszy komunikat `events of thread … not stored`.
Eksport zachowuje wyłącznie typ zdarzenia, źródło i czas; identyfikatory wątku
i workera, treść i szczegóły błędu nie opuszczają lokalnego filtra.
W szczegółach kolejek gatewaya są liczniki nieudanych prób zapisu (41), zdarzeń
odrzuconych po usunięciu (42) i kwarantanny (43). Worker raportuje liczbę journali
wstrzymanych po drainie starego gatewaya (116); ich wznowienie wymaga aktualizacji
gatewaya i następuje automatycznie. Liczniki nie zawierają identyfikatorów wątków.

Launcher `diagnostics-stage5.sh` mierzy także jawny eksport sześciu źródeł,
redakcję, zapis ZIP i pobranie podczas równoległej pracy RPC/workerów. Raport
akcji podaje bajty i czas osobno od zwykłego narzutu; wymaga osobnego nagrania.

## 8. Prywatność, raport i działania

**Uprawnienia:** owner-only w gateway, z ponowną kontrolą celu. Obecny produkt
ma jednego ownera gatewaya; nie nadajemy przyszłym użytkownikom/adminom wglądu
w cudzy ruch. Na współdzielonym workerze użytkownik widzi tylko swoje operacje;
zasoby całego procesu i logi wymagają właściciela/admina tego zasobu. Partner
widzi własny dozwolony dom lub jawnie udostępnioną diagnostykę/logi; nie dostaje
całego katalogu i snapshotów innych partnerów. Osobne grants `diagnostics_read`
i `diagnostics_logs` dla onward są sprawdzane na domu, odwoływalne i audytowane.
Grants są trwałe w `diagnostics_grants` i `diagnostics_log_grants`.
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

Ścieżki workspace, prywatne hosty i nazwy użytkownika są usuwane przez projekcję
bezpiecznych szablonów. Nie ma trybu surowego eksportu ani przełącznika
przywracającego sekrety. Rekord, którego nie da się rozpoznać, jest pomijany
z licznikiem w manifeście; błąd redakcji kończy źródło jako pominięte.

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
  maks. 10 min i jedna lease. Maks. 1% wywołań, 100 próbek/s, 10 000 spanów/4 MiB,
  ring w pamięci, automatyczne off po deadline, restart i ręczne **Stop tracing**.
  Spany tylko stałych operacji RPC/DB/pool/ingest/governor z losowym trace id,
  bez payloadów. Zwykły snapshot pokazuje tylko aktywność/termin tracingu.
  Pierścień liczb zajmuje 720 000 B (bez scratch 16 B). Eksport negocjuje polem
  `max_samples` liczbę rozumianą przez odbiorcę: brak pola zachowuje 2000 spanów
  dla starszych gatewayów i workerów, nowe klienty proszą o 10 000.
  Przycięcie eksportu zwiększa jego `dropped_samples`, nie usuwa próbek z pierścienia.
  Pobranie próbek z innego komputera wymaga jawnej akcji na nim i prawa eksportu.

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
| Canopy storage | Zaraz po overview, przed findings: oddzielne sumy i kategorie logów/danych/cache/aplikacji/bazy dla gatewaya lub desktopu oraz każdego workera. Są to bieżące rozmiary plików, niezależne od okna czasu, bez plików projektów/worktree. Nie sumujemy komponentów: mogą nakładać się albo należeć do różnych komputerów. Desktop obejmuje dane własnych workerów, także nieaktywnych. Gateway pokazuje bazę SQL osobno, poza sumą plików; baza może działać na innym komputerze. Desktop wlicza własne pliki PostgreSQL w sumę. Każdy pomiar ma czas i stan; starszy niż 5 min jest nieaktualny, offline/stale zachowuje ostatnie wartości. `Partial` i `At least` oznaczają dolne ograniczenie, brak pomiaru/kategorii nie staje się zerem. Starszy build dostaje polecenie aktualizacji. Web pokazuje `This desktop` wyłącznie przy lokalnym `desktopStorage`. Web i mobile pokazują też pełne zużycie aplikacji zdalnego desktopu zgłoszone przez jego worker: etykieta `Desktop`, własna nazwa workera i informacja o uwzględnieniu danych workerów. |
| Findings | Najpierw critical/warning, potem info; max 5 na początku, rozwinięcie reszty. Wartość, okno, prosty powód i zalecana akcja; techniczne dowody pod `Show details`. Wspólny finding pary linku ma obie obserwacje. |
| RPC i DB | Sekcja `Calls`, tabela sortowana po calls/min, p50/p95/p99/max, błędach i in-flight, z nazwą metody i komputerem. Grupowanie per dom, bez sumowania warstw BFF/home/transport. W drill-down `RPC details`, streamy oddzielnie, kody i payload sizes; top 10 rodzin SQL i pool wait. Na telefonie wybór sortowania i karty wierszy zamiast tabeli szerszej niż ekran. |
| Linki/zasoby | RTT/jitter, backlog/lag, reconnect/resubscribe, CPU/RSS/dysk jako tabele i grupy liczb z jednostką, pokryciem oraz rozkładem. Brak pomiaru ≠ 0. Szczegóły komputera/workerów zachowują filtr i czas. Sparklines nie są częścią obecnego widoku. |
| Raport/logi/trace | Akcje `Copy report`, `Collect logs`, `Ask an agent to investigate`; wybrany komputer pokazuje `Reset counters` i `Start deeper tracing`. Zbieranie ma postęp per komputer, rozmiar, truncation/partial, `Download logs` i `Retry failed`; mobile `Share logs` na iOS oraz `Save logs` na Androidzie. Trace ma czas końca i `Stop tracing`; nic nie włącza go zbiorczo. |

Kit web: `SettingsGroup`, `SettingsCard`, `SettingsRow`, `Select`, `Button`,
`Badge`, `Dialog`/`Popover` z `apps/web/src/lib/shared/ui`; bez natywnych selectów.
Gęstość i stopnie z [ui-scale.md](ui-scale.md), kolory semantyczne i ruch z tokenów,
`tabular-nums`, stałe miejsce liczników/akcji, kompaktowe nakładki, reduced motion.
Mobile używa `src/ui`, tokenów i celów dotykowych minimum 48 dp.

Widok korzysta z tabel i małych grup metryk, bez osobnej biblioteki wykresów.
Przyszły trend wymagałby ograniczonego modelu punktów i osobnego przeglądu UI;
retencja histogramów sama nie oznacza gotowego wykresu historii.
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
Zmiany UI wymagają audytu §8 copy i ręcznego przeglądu jasny/ciemny, desktop/wąski/
telefon, długie nazwy i małe/duże liczby, overlay/scroll/sticky bez szczelin.
Nie dodajemy testów komponentów ani Playwright.

## 10. Utrzymanie i weryfikacja budżetów

Sześć warstw diagnostyki jest wdrożonych: RPC/RTT i trwałość, wnętrze gatewaya,
workery/synchronizacja, klienci/raport/reset, logi oraz czasowy tracing.
Numery etapów pozostały w skryptach benchmarkowych jako wybór zakresu porównania,
nie harmonogram przyszłych PR. Aktywne sondy providerów pozostają poza v1.

**Budżety są celami, nie zmierzonym wynikiem obecnej wersji.** Przegląd kodu
potwierdza limity danych i pamięci kolektorów; CPU, RSS, p95, WAL/I/O oraz koszt
natywnego klienta wymagają nagrania z podaniem rewizji, runtime, sprzętu i obciążenia.
Gotowy fixture, zaliczony test trwałości ani wynik JS nie zastępują takiego pomiaru.

| Zakres | Cel i dowód |
|---|---|
| Zwykłe zbieranie | Mediana sparowanego przyrostu CPU <1 pp jednego rdzenia i p95 RPC <max(1 ms, 10% baseline). Raport podaje także bezwzględne wartości, rozrzut i niekorzystne pary. |
| Pamięć/start | Przyrost RSS i startup VmHWM ≤10 MiB dla kolektora względem wariantu off; synchroniczny koszt restore <100 ms. Osobno pełny restore w tle i brak wzrostu po zapełnieniu pierścieni. |
| Trwałość | Odczyt historii 24 h p95 <50 ms, ≤32 MiB WAL/h i ≤64 MiB I/O/h na komputer; CPU PostgreSQL, pruning i autovacuum są częścią kosztu. Brak licznika I/O pozostawia ten cel niezweryfikowany. |
| Jawne akcje | Raport, eksport logów i tracing mają osobne fazy off/on, rozmiary i czas. Eksport ma cel średnio ≤10% rdzenia bez regresji p95 zwykłej pracy. |
| Klienci | Pomiary BFF i JS oddzielnie od natywnego paint/FPS i pamięci WebView; ograniczenia pomiaru pozostają widoczne. |

Aktualny protokół launcherów i warunki unieważniania par opisuje §3.2.
Nie należy mieszać go z dawnymi progami lub liczbą par etapu 1. Wyniki i ślady
pozostają poza repo; przekroczenie budżetu wymaga pomiaru przyczyny i poprawy,
a nie uznania deklarowanego limitu za osiągnięty wynik.

Przy zmianach zachowujemy testy integracyjne gRPC, owner scoping, migracje,
restart/deduplikację i granice adapterów. Zmiany UI wymagają ręcznego przeglądu
klientów i copy; nie dodajemy testów komponentów ani Playwright. Wymagane checki
wykonuje GitHub CI, lokalny zakres określa [AGENTS.md](../AGENTS.md#testing-policy).
Dokumentacyjne korekty wymagają przeglądu treści, linków i diffu.

## 11. Decyzje maintainera — zaakceptowane 2026-11-10

Utrzymywane granice v1: trwałość agregatów z §5, jawne działania właściciela
i osobne uprawnienia do diagnostyki oraz logów. Poniższe decyzje nie są raportem
pomiarów wydajności ani listą oczekujących etapów.

| Obszar | Przyjęta decyzja |
|---|---|
| Nazwa | **Diagnostics**, w General; obejmuje także sieć, świeżość i logi. |
| Historia po restarcie | **Trwała**: rzadkie histogramy/liczniki i ostatnie findings, batch najwyżej raz/min/proces w domowym gatewayu. Minuty 2 h, godziny 30 dni, kwoty i pruning z §5; worker bez DB. Restore ostatniej godziny w tle po uruchomieniu listenera, 24 h z godzin w DB na żądanie. Okna kontynuują historię z oznaczoną faktyczną luką. Koszt zapisu w budżecie narzutu. |
| Dokładność percentyli a pamięć | Stałe 128 kubełków (~19% kwantyzacji) i jawny max/pokrycie; jeśli to za mało do decyzji o optymalizacji, zwiększyć precyzję dopiero po pomiarze budżetu 64/16 MiB. |
| Dane partnerów/onward | Bezpośredni partner tego samego właściciela ma odczyt diagnostyki; logi tylko na jawną akcję ownera. Onward wymaga osobnych, odwoływalnych grants read/logs od domu. Brak grant nie ukrywa karty komputera. |
| Domyślny zakres logów i prywatność | 1 h, wszystkie komputery, 2/12/96 MiB przed kompresją, 100 MiB ZIP, redakcja szablonami, bez opcji eksportu sekretów. 6/24 h tylko w ramach dostępnej rotacji. |
| Zewnętrzny PostgreSQL i logi systemowe | Brak automatycznego dostępu administracyjnego. Lokalny adapter jawnie udostępnionych logów i manifest `not_available`, jeśli operator go nie skonfigurował; rotację operator potwierdza osobno. |
| ZIP większy niż limit attachment | Nie zwiększać globalnego limitu; mniejszy zakres/wybór komputerów i tekstowy manifest. Agent otrzymuje załącznik wyłącznie po podglądzie właściciela. |
| Aktywne sondy providerów | Odłożone; istniejący ruch i oznaczenie niepewności wystarczą do pierwszej wersji. Tracing maks. 10 min per jawnie wybrany komputer, nigdy automatycznie na wszystkich. |
