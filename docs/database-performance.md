# Wydajność bazy danych

## Powtarzalne pomiary

`bun scripts/bench/db.ts --run --explain` uruchamia opt-in benchmark warstwy
magazynów gatewaya. Wymaga Dockera; tworzy własny PostgreSQL 18, bazę i katalog
w `/var/tmp`, a następnie usuwa je także po błędzie. Nie przyjmuje adresu istniejącej
bazy. Kontener ma limit 1,5 GiB RAM, dwa CPU i 40 połączeń. Dane i port są prywatne;
nie używa działającego gatewaya ani workera.

Domyślne dane obejmują 240 wątków, 24 projekty, 13 workerów, po 32 zakończone tury
w zwykłym wątku i 2048 w najdłuższym, teksty po 4096 bajtów, zadania w tle,
metadane załączników, boty z historią, harmonogramy i lustro połączonego komputera.
Wszystkie treści są syntetyczne. Import mierzy utworzenie 100 pozycji oraz odczyt
przebiegów i znanych źródeł. Nie uruchamia CLI ani inferencji.

Parametry: `--threads`, `--turns`, `--long-turns`, `--text-bytes`, `--iterations`,
filtr nazwy `--operation` (np. `--operation thread/`) oraz `--agent-tail`
(domyślnie 0: wszystkie tury użytkownika). Ten ostatni zamienia
końcowe N tur każdego wątku na tury dostawcy, pozostawiając co najmniej jedną turę
użytkownika. Pozwala sprawdzić odczyty ostatniego wyboru po długiej pracy agenta;
`--explain` pokazuje także liczbę wierszy odrzuconych przez filtr.
Limit treści przed narzutem tabel, zdarzeń i indeksów wynosi 512 MiB; zwiększanie profilu wymaga
uwzględnienia pamięci innych procesów. Mały smoke:

```sh
bun scripts/bench/db.ts --run --threads 8 --turns 8 --long-turns 40 --text-bytes 256 --iterations 2 --explain
```

Wynik JSON trafia na stdout, postęp na stderr. Plików wynikowych nie dodajemy do
repozytorium; tabele porównawcze trafiają do opisów PR. Porównujemy identyczne
parametry, kolejność operacji i wersję PostgreSQL przed i po zmianie. Wyniki nie
obejmują transportu HTTP/gRPC, renderowania ani czasu pracy modelu. `overview/projects`
mierzy magazyn projektów, `sidebar/threads` magazyn lokalnych wątków; nie są pełnym
RPC `GetOverview`.

Każda operacja ma dwa rozgrzania i domyślnie 20 sekwencyjnych próbek. p50/p95
liczymy metodą najbliższej rangi. Operacje zapisujące dodają syntetyczne dane,
dlatego liczba iteracji musi być jednakowa przy porównaniu. Mark seen mierzy
powtarzany, już zapisany checkpoint. Steer mierzy przyjęcie przez magazyn,
bez dostarczenia do harnessu. Pełny snapshot jest celowo osobnym pomiarem od stron.

`pg_stat_statements` dostarcza średnią liczbę wywołań, wierszy, czas SQL oraz
bloki shared/temp na iterację. Osobny przebieg diagnostyczny instrumentuje
połączenia Effect SQL: liczy zapytania (włącznie z BEGIN/COMMIT/SAVEPOINT), zwrócone
wiersze oraz rozmiar ich reprezentacji JSON po dekodowaniu. **To nie bajty na
łączu ani fizyczny odczyt dysku.** Instrumentacja nie działa w pomiarze latency ani
w aplikacji. Parametry pozostają tylko w pamięci procesu; wynik nie zawiera treści
zapytań, parametrów ani wierszy.

`--explain` wykonuje `EXPLAIN (ANALYZE, BUFFERS)` dla odczytów z przebiegu
diagnostycznego (także odczytowe CTE), z pominięciem blokujących SELECT FOR UPDATE. Nie powtarza zapisów.
Wynik opisuje węzły, relacje, indeksy, wiersze/pętle oraz bloki, bez warunków
i wartości. Dla zapytań wewnątrz transakcji plan jest osobną obserwacją, poza
pierwotnym snapshotem MVCC.

`--explain-writes` zamiast tego zbiera plany przed rzeczywistymi instrukcjami
przebiegu diagnostycznego, na tym samym połączeniu i z kontekstem FK/blokad.
Obejmuje SELECT z blokadami, INSERT, UPDATE, DELETE i CTE. Dodatkowe wykonanie
`EXPLAIN (ANALYZE, BUFFERS)` jest cofane przez SAVEPOINT lub własne BEGIN/ROLLBACK,
po czym wykonywana jest właściwa instrukcja. Ten tryb działa wyłącznie w harnessie
tworzącym własną bazę. Pomija znane efekty sesji i sekwencji, których rollback
nie cofa; raportuje pominięcia i błędy zamiast uznawać je za pokrycie. DDL i sterowanie
transakcją nie mają planu EXPLAIN. Plany nie zawierają wartości ani warunków.
Diagnostyka ogrzewa cache i ponownie wywołuje triggery, dlatego nie działa w pomiarze
latency. Nie zastępuje testów konkurencji ani audytu zimnych gałęzi kodu.

## Inwentaryzacja SQL

`bun scripts/bench/routines.ts --run` mierzy planistę 16 botów z czterema rutynami
każdy. Osobny przebieg dodaje prywatny trigger opóźniający enqueue o 5 ms i mierzy
edycję ostatniego bota po rozpoczęciu pierwszego enqueue; ten czas obejmuje
oczekiwanie na blokadę. Zwykłe p95 dispatch nie zawiera sztucznego opóźnienia.
Planista blokuje jeden bot na transakcję, do 100 takich transakcji na przebieg.
Sprawdza zajętość wszystkich jego rutyn jednym odczytem, bez pobierania instrukcji,
a stan następnego wystąpienia i przyjęcie tury zatwierdza atomowo.

`bun scripts/bench/secrets.ts --run` mierzy kolejkę 1024 syntetycznych grantów:
polling, pierwszy reset po połączeniu i pierwszą partię wygaszania.
Stan wejściowy jest przywracany poza pomiarem; diagnostyka wykonuje osobne plany
`EXPLAIN (ANALYZE, BUFFERS)` z rollbackiem. Dostawy są ograniczone do 64,
reset i wygaszanie do 256 zapisów. Jeden trwały zapis kursora kolejności ponowień ogranicza
koszt pojedynczego przebiegu i zachowuje sprawiedliwość po restarcie;
sam limit nie oznacza niższego p95 ani szybszego opróżnienia całej kolejki.
Trzy serie porównują naprzemiennie każdą próbkę dawnej i bieżącej ścieżki na tej samej bazie.
Każda seria ma dwa rozgrzania i 20 próbek; stan ACK, TTL i kursory są przywracane
poza pomiarem. Dawna ścieżka służy wyłącznie jako punkt odniesienia benchmarku.
Domyślnie polling ma stabilną kolejkę, a reset i expiry usuwają martwe wpisy fixture
przez VACUUM poza pomiarem. `--churn` przywraca wszystkie granty przed każdą próbką
bez VACUUM; pozwala oddzielnie zobaczyć koszt narastania martwych wpisów indeksu.

`bun scripts/bench/audit.ts` wypisuje miejsca instrukcji i fragmentów SQL w
`apps/gateway/src` i `packages/db/src`, także migracje. Podaje operację, relacje
i kandydatów do przeglądu: szeroką projekcję, brak LIMIT, blokady, duże agregacje,
usuwanie i składane fragmenty. To pomoc w audycie, nie lista potwierdzonych błędów;
fragmenty mogą się nakładać, a nieograniczony SELECT po kluczu jest poprawny.
Dynamiczne generatory i wywołania funkcji SQL trzeba sprawdzić w kodzie źródłowym.

`CANOPY_SQL_AUDIT_DIR` włącza osobny przebieg diagnostyczny testowych gatewayów.
Wskazuje istniejący prywatny katalog poza repozytorium; po zamknięciu gatewaya
trafiają tam plany z buforami, fingerprinty i dokładnie dopasowane szablony SQL
ze ścieżką oraz linią źródła. Parametry, wiersze wyników i tekst SQL nie są zapisywane.
Plan ma syntetyczny fixture danego testu, więc nie zastępuje pomiaru dużego zbioru
benchmarku ani dowodu wywołania konkretnej gałęzi kodu. Niedopasowane fragmenty
dynamiczne pozostają jawnie bez ścieżki. Nie należy używać tego trybu do pomiaru
latency; zwykły przebieg testów nie ma instrumentacji.

Plany zapisywane przez `PlanCapture` w benchmarkach również zawierają kandydatów
źródła na podstawie szablonu. `audit.ts --benchmark-directory <katalog>
--integration-directory <katalog>` łączy te dowody z inwentaryzacją. Raport oddziela
plany benchmarków od małych fixture testów i jawnie liczy miejsca bez dowodu,
błędy oraz niedopasowane plany. Należy wskazywać wyłącznie wyniki tej samej rewizji
źródeł: numery linii zmieniają się podczas edycji. Dopasowanie nie jest werdyktem
wydajności ani potwierdzeniem wykonania każdej z pasujących ścieżek.

Gateway używa `@effect/sql-pg`, z domyślnie włączonym cache prepared statements
(100 na połączenie) i pulą do 10 połączeń. Bun SQL obsługuje administrację baz
testowych. Zmiana limitów i timeoutów wymaga pomiaru współbieżnego obciążenia;
skrót czasu statement nie jest zamiennikiem ograniczenia kosztu zapytania.

### Kolejki, importy i współbieżność

Fixture obejmuje dodatkowo 50 zakończonych importów po 2000 pozycji, 4096 oczekujących
komend i 16 384 zakończone komendy. `imports/progress` mierzy samą agregację, oddzielnie
od pełnego katalogu znanych źródeł; `commands/pending`, `worktrees/branch-context`
i `schedules/claim-empty` uzupełniają odczyty kolejek.

`bun scripts/bench/concurrent.ts --run` uruchamia osiem klientów odczytujących projekty,
stronę historii, postęp importów i komendy. Równolegle zapisuje partie po osiem delt
itemu oraz aktualizacje lustra. Domyślnie wykonuje 40 iteracji na klienta, używa
64 wątków, 2048 tur w długim wątku i tekstów po 4096 bajtów. Delty trafiają do
oddzielnej działającej tury; harness sprawdza kompletny tekst i status po pomiarze.
Parametry `--clients`, `--gateways`, `--pool`, `--iterations`, `--statement-timeout-ms`
pozwalają porównać nasycenie jednej lub kilku niezależnych pul gatewaya;
domyślna pula 10 odpowiada gatewayowi, limit serwera wynosi 40.
Łączna pojemność pul nie może przekroczyć 36, aby zostawić połączenia administracyjne.
To współbieżność warstwy SQL, bez transportu kilku procesów gatewaya.

Osobne połączenie próbkuje `pg_stat_activity` i `pg_blocking_pids` co około 10 ms.
Wynik podaje maksimum aktywnych/otwartych połączeń, sumę zaobserwowanych oczekiwań
na blokady, p95 rezerwacji połączenia i opóźnienie pętli zdarzeń. Próbkowanie może
pominąć krótsze blokady; liczników nie należy interpretować jako dokładnego czasu
oczekiwania. Rezerwacja obejmuje także utworzenie połączenia. Latency obejmuje
oczekiwanie na pulę i dekodowanie. Błędy są liczone według kategorii, bez treści;
osobna próba `SET LOCAL statement_timeout` sprawdza anulowanie i rollback.

Postęp importu agreguje liczniki i sumy w jednym skanie pozycji na przebieg, po
wyborze maksymalnie 50 przebiegów właściciela. Sumy pozostają dokładnymi liczbami
dziesiętnymi, także powyżej precyzji JS number. Pobranie pozycji do UI nie dekoduje
snapshotów źródła, bazy dopisywania ani kursorów wznowienia; wewnętrzne przejścia
importu nadal odczytują pełne rekordy.

Pętla importu sprawdza stan przebiegu po kluczu i właścicielu przed kolejną pozycją.
Pełne liczniki wylicza dopiero przed zakończeniem przebiegu; odświeżanie postępu UI
nadal zwraca dokładne agregaty. Anulowany przebieg nie zostaje ponownie zakończony.

Lista konektorów UI pobiera metadane bez katalogów narzędzi i rozwiązuje granty
dwoma zapytaniami grupowymi, niezależnie od liczby kont. Wykonanie narzędzia nadal
odczytuje pełny katalog i sprawdza grant. Ustawienia instancji filtrują właściciela
instancji, proxy, workerów i liczników w SQL, przed przesłaniem konfiguracji do JS.
Wewnętrzna synchronizacja nadal może odczytać konfigurację wszystkich właścicieli.
Przypisanie instancji do workerów i zapis referencji sekretów używają `unnest`,
z zachowaniem walidacji i transakcji wywołującego.

`bun scripts/bench/config.ts --run` mierzy 32 konta z katalogami po 64 KiB,
32 obce instancje z konfiguracją po 64 KiB, przypisanie do 13 workerów i kontrolę
przebiegu importu z 2000 pozycji. `--baseline` służy do porównania z wcześniejszym
kodem magazynów. Każdy wariant tworzy własną bazę; 20 próbek po dwóch rozgrzaniach
nie zawiera instrumentacji. Oddzielny przebieg zbiera plany i rozmiar zwróconych danych.

`bun scripts/bench/schedule-lock.ts --run` mierzy konflikt edycji z przygotowaniem
workspace'u: 20 próbek i dwa rozgrzania, 50 ms syntetycznego I/O. Edycja wersji
zaczyna się po wejściu w przygotowanie. Wynik podaje p50/p95 edycji (w tym czas
oczekiwania na blokadę wiersza) i liczbę tur zapisanych mimo równoległej edycji.
Przygotowanie działa poza transakcją; końcowa transakcja ponownie sprawdza fence
i placement, a claim schedulera pobiera jedno zadanie tuż przed obsługą.

`bun scripts/bench/retention.ts --run` porównuje dawną blokadę checkpointu i usunięcie
4096 starych snapshotów po 4096 bajtów z pełną transakcją joba i partią 256 rekordów.
Podaje też czas opróżnienia całego backlogu. W tym ostatnim pomiarze przyspiesza
termin joba między partiami; normalny timer oddaje zasoby innym operacjom.

## Odczyty wątków

Zwykła strona historii korzysta z istniejącego ograniczonego okna tur w SQL;
nie przesyła wszystkich historycznych id do JS. Odczyt itemów nakłada granicę forka
i wybrane tury bezpośrednio
na `thread_items`, przed sortowaniem treści. Zachowuje zadania w tle, itemy bez tury
oraz kolejkę.
Pełny snapshot starszych klientów, skok do itemu i odtworzenie okna od `fromTurnId`
zachowują wcześniejszy zakres; nie są po cichu obcinane.

Dekodowanie protobuf dużych snapshotów oddaje sterowanie do fazy I/O co około
4 ms (kontrola co 32 rekordy), po zamknięciu transakcji odczytu. Samo oddanie
microtaska nie wystarcza do obsługi socketów. `bun scripts/bench/decode.ts --run`
porównuje dekodowanie tych samych 32 768 syntetycznych itemów i przerwy timera
1 ms. Nie mierzy parsowania JSON przez driver ani serializacji transportu.
Pojedynczy ogromny item nadal dekoduje się synchronicznie; pełny kontrakt historii
nie pozwala go obciąć. Ograniczenie tego przypadku wymaga osobnego kontraktu
fragmentacji payloadu lub przeniesienia kodeka poza główną pętlę.

Kontekst nazwy gałęzi wybiera pierwszy i trzy ostatnie prompty przez indeks porządku
tur. Nie pobiera środkowej historii. Fakty agent busa pobierają nagłówki wszystkich
adresatów jednym zapytaniem. Powiadomienia mają strony po 50 rekordów, a fallbacki
po 64; kursor `(created_at, id)` pozwala ominąć chwilowo zajęte cele, a kolejny
przebieg wraca na początek. Status dostarczenia pozostaje trwały w bazie. Ostatnia
odpowiedź jest liczona raz na turę celu i zwracana tylko do limitu podglądu;
licznik obcięcia zachowuje długość UTF-16. Watch i wakeup botów przyjmują do 32
rekordów, a teksty watchy pobierają grupowo, bez payloadów narzędzi.

Konfiguracja workera rozwiązuje zaszyfrowane referencje jednym odczytem grupowym;
nie wykonuje osobnego SELECT dla każdego sekretu. Uwierzytelnianie workera używa
indeksu hasha credentiala; lookup aktualizacji porównuje UUID bez rzutowania kolumny
na tekst. Migracja `0106` rejestruje te indeksy oraz indeksy pollingu agent busa
i botów jako zadania obsługujące budowanie online.

`bun scripts/bench/stores.ts --run` mierzy 32 adresatów, 256 powiadomień,
24 referencje sekretów i lookup wśród 10 013 workerów. Pomiar rozróżnia pierwszą
stronę powiadomień od pełnego opróżnienia; ma tę samą metodę p95 i diagnostyki
wierszy/bajtów co główny harness.

Wyszukiwanie tytułów odczytuje małe nagłówki kandydatów, zachowuje fuzzy ranking
i kolejność aktywności, a dopiero dla maksymalnie 50 wyników pobiera pełne metadane
i buduje podglądy powiadomień. Oba odczyty sprawdzają właściciela i widoczność.
Kandydaci pozostają niepaginowani, ponieważ ranking obejmuje wszystkie aktywne tytuły;
rozmiar treści rozmów nie powiększa tego zbioru. Mark seen łączy sprawdzenie
właściciela i rosnący zapis checkpointu w jednym zapytaniu, także dla powtórzeń.

## Zapisy grupowe

`bun scripts/bench/move-previews.ts --run` mierzy podgląd bota z ponad 2000
wiadomościami po 4 KiB oraz sprawdzenie zależności 16 botów i ośmiu wątków.
Podgląd pobiera tylko nazwy połączeń potrzebne w liście czynności po przeniesieniu.
Sprawdzenie zależności używa dwóch grupowych odczytów nagłówków i projektów,
z filtrem właściciela także dla wątków bocznych. Syntetyczna odpowiedź inspection
zastępuje transport; serializacja rzeczywistego eksportu i transfer nie są mierzone.

`bun scripts/bench/environment.ts --run` mierzy snapshot biblioteki i ustawienia
jednego workera: 32 skille z dwiema wersjami po 16 KiB, 13 workerów, 16 historycznych
pinów. Bieżące niezmienne artefakty są używane ponownie z biblioteki właściciela;
historyczne piny mają grupowy odczyt zamiast zapytania dla każdego skilla i workera.
Pełny snapshot nadal zachowuje pliki wymagane przez podgląd i uzgadnianie środowiska.
Harness używa rzeczywistego serwisu bez transportu, z tą samą metodą próbek i EXPLAIN
co pozostałe pomiary. Wyniki na współdzielonej maszynie mogą różnić się w p95 mimo
redukcji liczby zapytań; liczba wywołań i bajtów nie jest deklaracją poprawy latency.
`--profile` wykonuje trzy serie po 20 próbek z dwoma rozgrzaniami każdej serii.
Podaje p50/p95 każdej serii, CPU procesu oraz osobny przebieg z czasem sterownika
dla każdego fingerprintu SQL. Czas sterownika obejmuje transport i dekodowanie,
bez liczenia rozmiaru JSON; cały przebieg diagnostyczny obejmuje również to liczenie
i ma zimne połączenie diagnostyczne. Nie należy odejmować jego czasów od zwykłego
p95, aby wyliczyć czas JS. Plany pokazują czas po stronie PostgreSQL oddzielnie.
Przed porównaniem wersji należy zakończyć inne własne benchmarki, testy i buildy.
Regresja wymaga profilu i porównania wszystkich serii, z zachowaniem niekorzystnych
wyników; sam spadek liczby zapytań nie zamyka weryfikacji wydajności.

Przyjęcie świeżego importu i jego biblioteki używa typowanego
`jsonb_to_recordset`, do 128 pozycji lub około 512 KiB JSON na partię. Pojedyncza
wcześniej zwalidowana duża pozycja może przekroczyć cel bajtowy. Pozycje zachowują
kolejność, właściciela, snapshot i dokładne bigint; dane wszystkich partii są w tej
samej transakcji. Konflikt późniejszej partii wycofuje także wcześniejsze.
Import dopisujący historię zachowuje dotychczasowe walidacje i blokady wątków;
nie omija ich przez ścieżkę zapisu grupowego.

## Trwałość i retencja

Migracja `0100_history_read_indexes` dodaje indeksy:

| Indeks | Odczyt |
|---|---|
| `turns_unseen` | najnowsza zakończona, niewidziana tura według `last_seq` |
| `thread_items_turn_order` | itemy wybranych tur oraz itemy bez tury |
| `thread_items_last_answer` | ostatnia odpowiedź bez skanowania innych rodzajów itemów |
| `thread_events_notices` | ostatnie komunikaty bez skanowania transkryptu |

Migrator wykonuje migracje w transakcji z blokadą, więc nie można użyć
`CREATE INDEX CONCURRENTLY` wewnątrz migracji schematu. Od `0103` nowe indeksy
wydajnościowe mogą być zarejestrowane jako zadania wykonywane po jej zatwierdzeniu.
`CANOPY_DATABASE_INDEX_MODE=concurrent` wybiera budowanie online; domyślne `blocking`
zachowuje zwykłe budowanie. Każde uruchomienie sprawdza definicję i poprawność indeksu,
także gdy numer migracji jest już zapisany. Przerwany build jest bezpiecznie ponawiany.
Nie dotyczy to indeksów unikalnych ani ograniczeń. Procedura: [deploy.md](deploy.md).

Istniejąca migracja `0098_thread_read_metadata`
opróżnia odroczone zdarzenia triggerów po wcześniejszych naprawach danych.
Indeks aktywności również pochodzi z 0098 i nie jest tutaj powielany.
Zwykłe budowanie indeksu blokuje zapisy do danej
tabeli; duża baza serwerowa wymaga okna utrzymaniowego. Dla wdrożeń bez takiego
okna dla starszych migracji nadal potrzebna jest osobna procedura operacyjna.
Indeksy zwiększają koszt zapisów i zajętość dysku;
benchmark obejmuje również send/steer/import, żeby uwidocznić ten kompromis.

Odczyt outboxa wybiera do 2048 kandydatów, wylicza budżet około 512 KiB
i zwraca identyfikatory, terminy ważności oraz payloady mieszczące się w budżecie.
Payloady są dekodowane dopiero po tym filtrze. Pojedyncza większa komenda przechodzi,
żeby nie zatrzymać kolejki. Kolejność `(created_at, id)` i stronicowanie po trwałym id
zachowują wszystkie komendy, także przy jednakowych timestampach i zakończeniu komendy
stanowiącej kursor. Od `0107` indeks `worker_commands_redelivery_expiry` zastępuje
`worker_commands_open` i `worker_commands_redelivery` dopiero po poprawnym zbudowaniu.
Zawiera także `expires_at`: skan odrzuca wygasłe wpisy w indeksie, przed pobraniem
payloadów. Rozmiary są sprawdzane dopiero dla wybranych kandydatów.
Status przeterminowanej komendy pozostaje bez zmian, żeby nie zwolnić bramki
deduplikacji `startTurn`. Ponowne dostarczanie ma do
64 komend w locie i czeka na odpowiedzi po każdej takiej grupie, także wewnątrz
strony SQL. Przed wysłaniem każdej komendy sprawdza ponownie jej termin ważności,
więc czekanie na wcześniejsze ACK nie pozwala wysłać przeterminowanej komendy.
Zmiana połączenia kończy
stary drain; restart odtwarza oczekujące komendy z bazy. Kolejka nie potrzebuje nowego
claimu SQL: ogrodzenie połączenia workera i deduplikacja po id pozostają obowiązujące.

`bun scripts/bench/outbox.ts --run` porównuje poprzedni odczyt całej kolejki
z ograniczonymi stronami. Fixture zawiera 4096 prawidłowych komend protobuf oraz
16384 zakończone wpisy. Trzy rundy po 20 próbek i dwie rozgrzewki przeplatają
obie wersje w każdej próbce. Pierwsza strona i pełny odczyt są mierzone osobno;
transport i ACK nie wchodzą do tego pomiaru. Osobny przebieg zbiera plany z rollbackiem.
Większa strona SQL amortyzuje przejścia do bazy, a limit 64 w locie ogranicza fan-out.

Inventory worktree pobiera najnowszą aktywność przez istniejący indeks wyrażenia
dat tur, z zachowaniem pustych `started_at`/`completed_at` i wszystkich współdzielących
wątków. Częściowe indeksy `turns_busy` i `worker_commands_thread_busy` pomijają historię
podczas sprawdzania bezpieczeństwa usunięcia. Lista i podgląd sekretów nie odczytują
szyfrogramów; dostarczanie workera nadal odczytuje je wyłącznie w wewnętrznej ścieżce.

`bun scripts/bench/lifecycle.ts --run` mierzy 8192 tury worktree, prefiks 32 768
wygasłych komend przed 64 aktywnymi i widok 64 sekretów z szyfrogramami po 8192 bajty.
`--large-active-queue` zwiększa aktywną kolejkę do 4096. Metoda: dwa rozgrzania,
20 próbek bez instrumentacji i osobny przebieg EXPLAIN z buforami. Nie mierzy I/O Git.

Transkrypty, itemy, importy, audyt i zakończone komendy nie są danymi do usuwania
wyłącznie według wieku. Zakończone `worker_commands` uczestniczą m.in. w
deduplikacji i rozpoznawaniu wysłanej tury. Usunięcie może ponownie uruchomić pracę.
Migracje `0104`–`0105` i trwały job zachowują te znaczniki, kompaktują zbędne payloady
i usuwają surowe eventy harnessów dopiero za trwałym ACK. Dziennik zmian luster
zachowuje 10 000 rewizji; starszy kursor wymusza pełny odczyt. Usuwanie starych
generacji wymaga trwałej rejestracji stagingu i fence'u subskrypcji.
Dokładne warunki, limity i dane bez retencji: [database-retention.md](database-retention.md).
