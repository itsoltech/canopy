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

Parametry: `--threads`, `--turns`, `--long-turns`, `--text-bytes`, `--iterations`
oraz filtr nazwy `--operation` (np. `--operation thread/`). Limit treści przed
narzutem tabel, zdarzeń i indeksów wynosi 512 MiB; zwiększanie profilu wymaga
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
diagnostycznego, z pominięciem blokujących SELECT FOR UPDATE. Nie powtarza zapisów.
Wynik opisuje węzły, relacje, indeksy, wiersze/pętle oraz bloki, bez warunków
i wartości. Dla zapytań wewnątrz transakcji plan jest osobną obserwacją, poza
pierwotnym snapshotem MVCC.

## Inwentaryzacja SQL

`bun scripts/bench/audit.ts` wypisuje miejsca instrukcji i fragmentów SQL w
`apps/gateway/src` i `packages/db/src`, także migracje. Podaje operację, relacje
i kandydatów do przeglądu: szeroką projekcję, brak LIMIT, blokady, duże agregacje,
usuwanie i składane fragmenty. To pomoc w audycie, nie lista potwierdzonych błędów;
fragmenty mogą się nakładać, a nieograniczony SELECT po kluczu jest poprawny.
Dynamiczne generatory i wywołania funkcji SQL trzeba sprawdzić w kodzie źródłowym.

Gateway używa `@effect/sql-pg`, z domyślnie włączonym cache prepared statements
(100 na połączenie) i pulą do 10 połączeń. Bun SQL obsługuje administrację baz
testowych. Zmiana limitów i timeoutów wymaga pomiaru współbieżnego obciążenia;
skrót czasu statement nie jest zamiennikiem ograniczenia kosztu zapytania.

## Odczyty wątków

Zwykła strona historii korzysta z istniejącego ograniczonego okna tur w SQL;
nie przesyła wszystkich historycznych id do JS. Odczyt itemów nakłada granicę forka
i wybrane tury bezpośrednio
na `thread_items`, przed sortowaniem treści. Zachowuje zadania w tle, itemy bez tury
oraz kolejkę.
Pełny snapshot starszych klientów, skok do itemu i odtworzenie okna od `fromTurnId`
zachowują wcześniejszy zakres; nie są po cichu obcinane.

Wyszukiwanie tytułów odczytuje małe nagłówki kandydatów, zachowuje fuzzy ranking
i kolejność aktywności, a dopiero dla maksymalnie 50 wyników pobiera pełne metadane
i buduje podglądy powiadomień. Oba odczyty sprawdzają właściciela i widoczność.
Kandydaci pozostają niepaginowani, ponieważ ranking obejmuje wszystkie aktywne tytuły;
rozmiar treści rozmów nie powiększa tego zbioru. Mark seen łączy sprawdzenie
właściciela i rosnący zapis checkpointu w jednym zapytaniu, także dla powtórzeń.

## Trwałość i retencja

Migracja `0100_history_read_indexes` dodaje indeksy:

| Indeks | Odczyt |
|---|---|
| `turns_unseen` | najnowsza zakończona, niewidziana tura według `last_seq` |
| `thread_items_turn_order` | itemy wybranych tur oraz itemy bez tury |
| `thread_items_last_answer` | ostatnia odpowiedź bez skanowania innych rodzajów itemów |
| `thread_events_notices` | ostatnie komunikaty bez skanowania transkryptu |

Migrator wykonuje migracje w transakcji z blokadą, więc nie można użyć
`CREATE INDEX CONCURRENTLY`. Istniejąca migracja `0098_thread_read_metadata`
opróżnia odroczone zdarzenia triggerów po wcześniejszych naprawach danych.
Indeks aktywności również pochodzi z 0098 i nie jest tutaj powielany.
Zwykłe budowanie indeksu blokuje zapisy do danej
tabeli; duża baza serwerowa wymaga okna utrzymaniowego. Dla wdrożeń bez takiego
okna potrzebna jest osobna procedura migracji online, obejmująca także odtworzenie
po nieudanym budowaniu. Indeksy zwiększają koszt zapisów i zajętość dysku;
benchmark obejmuje również send/steer/import, żeby uwidocznić ten kompromis.

Transkrypty, itemy, importy, audyt i zakończone komendy nie są danymi do usuwania
wyłącznie według wieku. Zakończone `worker_commands` uczestniczą m.in. w
deduplikacji i rozpoznawaniu wysłanej tury. Usunięcie może ponownie uruchomić pracę.
Nowa retencja wymaga zachowania tych znaczników i testów odtworzenia po restarcie.
Obecne dzienniki zmian luster zachowują 10 000 rewizji; starszy kursor wymusza
pełny odczyt. Historia wspólnej konfiguracji ma retencję opisaną w
[modelu danych](data-model.md). Ten benchmark nie zmienia zasad retencji.
