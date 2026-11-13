# Retencja danych bazy

Gateway uruchamia trwałe sprzątanie dla swojego właściciela. `database_maintenance`
przechowuje termin następnej partii. Instancje konkurują przez `FOR UPDATE SKIP LOCKED`;
wycofanie transakcji przywraca zarówno dane, jak i termin. Timer budzi job co 5 sekund.
Po partii z pracą termin przesuwa się o sekundę, po pustej o minutę. Stop gatewaya
czeka na trwającą partię przed zamknięciem puli.

Każda tabela ma limit 256 usuwanych albo kompaktowanych rekordów na transakcję.
Job obsługuje najwyżej jeden zakończony harness i jedną generację lustra naraz.
Lokalny `lock_timeout=100ms` i `statement_timeout=1000ms` ograniczają zajęcie puli;
błąd wycofuje całą partię, a następne wybudzenie ją ponawia. Nie ma zewnętrznego I/O
w transakcji. Usunięte wersje MVCC i TOAST odzyskuje zwykły autovacuum; job nie
wykonuje `VACUUM FULL` ani nie obiecuje natychmiastowego zmniejszenia pliku bazy.

| Dane | Warunek i zachowany kontrakt |
|---|---|
| `computer_thread_changes` | Zachowujemy ostatnie 10 000 rewizji właściciela. Starsze usuwamy partiami poza triggerem commit. Nie zmieniamy epoki ani numerów rewizji. Brak ciągłości zakresu wymusza pełny snapshot lub konserwatywną rewalidację. |
| `worker_commands` | Po 7 dniach od zakończenia kompaktujemy wyłącznie payload komend wątku w stanie `completed`/`failed`, bez referencji harnessu. Id, status, wynik, czasy, thread/turn/worker i indeksy deduplikacji zostają. Komendy `pending`/`delivered`, także przeterminowane, i komendy bez wątku pozostają w całości. |
| `bot_harness_events` | Surowe rekordy terminalnego harnessu po 7 dniach, wyłącznie do trwale zapisanego ACK `(worker,journal,bot)`. Watermark, tekst, wynik, itemy projekcji i historia rozmowy pozostają. Terminalny replay przesuwa ACK bez odtworzenia surowych rekordów i bez zmiany wyniku. |
| `computer_mirror_threads` | Tylko nieaktywna generacja po wygaśnięciu dzierżawy albo zmianie `subscription_id`. Aktywna generacja nigdy nie jest kandydatem. Rejestracja poprzedza pierwszy zapis, checkpoint i sprzątanie blokują ten sam stan; wygasły producent musi rozpocząć nową subskrypcję. |
| `config_history` | Dotychczasowe 90 dni; bieżące rekordy konfiguracji, tombstone'y i kursory synchronizacji zostają. Usuwanie nie działa już pod blokadą publikacji konfiguracji. |
| `connector_oauth_states` | 7 dni po TTL. Przez ten okres zachowujemy rozróżnienie kodu wygasłego, użytego i zakończonego. Nowe logowanie nadal unieważnia stany tego samego konta właściciela. |
| `agent_skill_source_previews` | Po TTL, partiami. Zapis nowego preview dodatkowo usuwa do 256 nadmiarowych wpisów poza czterema najnowszymi; nie skanuje globalnie cudzych danych. |
| `diagnostics_rollups` | Minuty przez 2 h po zapisaniu godziny, godziny przez 30 dni. Zwykła partia minutowa zapisuje też zakończoną godzinę; maintenance uzupełnia brakującą godzinę po crashu i usuwa stare wiersze. Ta sama blokada stanu domu chroni retry, spóźnione minuty i pruning przed podwójnym naliczeniem. Twarde kwoty 180 minut / 720 godzin; szczegóły w `diagnostics.md` §5. |
| `diagnostics_investigations` | Receipt owner/request → zwykły wątek; usuwany kaskadowo z wątkiem lub właścicielem. Brak osobnego TTL, aby ponowienie potwierdzonej akcji po restarcie nie tworzyło duplikatu. Raport jako załącznik podlega zwykłej retencji historii wątku. |

Migracja backfilluje ACK harnessów i rejestr istniejących generacji. Stary staging
bez dzierżawy jest zachowany do zmiany subskrypcji. Czynne strumienie starego
gatewaya nie są uznawane za martwe tylko dlatego, że generacja nie jest aktywna.
W mieszanym wdrożeniu starsze instancje nadal mogą wykonywać dawną ścieżkę usuwania;
pełną politykę zapewnia aktualizacja wszystkich instancji. Historyczne dane harnessu
dostają od migracji nowy siedmiodniowy okres ochronny.

Nie usuwamy według wieku `thread_events`, `thread_items`, tur, importów, audytu,
wiadomości botów, `schedule_runs`, receiptów, tombstone'ów poleceń ani
`worker_journal_cursors`. Są źródłem historii, wznowienia, deduplikacji lub
rozstrzygania niepewnej wysyłki. Te tabele mogą nadal rosnąć: ich usuwanie wymaga
osobnego kontraktu archiwizacji lub jawnej operacji użytkownika, a nie limitu wieku.
Job nie usuwa też szkiców `bot_composer_drafts` ani załączników rozmów.
Rejestr ACK również pozostaje trwały po usunięciu surowych eventów. Komendy harnessów
i konfiguracji zachowują payload, ponieważ ścieżki odtworzenia nadal go odczytują.
