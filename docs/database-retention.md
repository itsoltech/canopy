# Retencja danych bazy

Status (2026-11-15): zaimplementowane sprzątanie techniczne i opcjonalne trwałe
usuwanie historii zarchiwizowanych wątków. Dostępność nightly/beta/stable według
[release.md](release.md).

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
| `thread_mirror_recent_ranges` | Zapis każdej partii przycina sufiks do 256 rekordów / 256 KiB na epokę i wątek. Podczas odbudowy zachowuje również poprzednią widoczną epokę; inne epoki usuwa. Brak sufiksu resetuje wyłącznie ograniczone okno cache klienta. Unlink usuwa wszystko przez FK. |
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

Bez włączonej retencji archiwum nie usuwamy według wieku `thread_events`, `thread_items`, tur, importów, audytu,
wiadomości botów, `schedule_runs`, receiptów, tombstone'ów poleceń ani
`worker_journal_cursors`. Są źródłem historii, wznowienia, deduplikacji lub
rozstrzygania niepewnej wysyłki. Te tabele mogą nadal rosnąć: ich usuwanie wymaga
osobnego kontraktu archiwizacji lub jawnej operacji użytkownika, a nie limitu wieku.
Job nie usuwa też szkiców `bot_composer_drafts` ani załączników rozmów botów.
Rejestr ACK również pozostaje trwały po usunięciu surowych eventów. Komendy harnessów
i konfiguracji zachowują payload, ponieważ ścieżki odtworzenia nadal go odczytują.

## Retencja archiwum wątków

Osobnym, jawnym kontraktem jest **Settings → Threads → Archived threads**.
`ThreadRetentionSettings.archived_thread_days` przyjmuje `0` (wyłączone, domyślnie)
albo `1–36500` pełnych dni od `threads.archived_at`. Zapis obejmuje istniejące
archiwum. Czas ostatniego zapisu ani wynik zadania w tle nie przedłużają terminu.
Przywrócenie przed kwalifikacją zatrzymuje usunięcie; kolejna archiwizacja zaczyna
nowy okres. Ustawienie jest wersjonowaną sekcją konta, z istniejącą synchronizacją
konfiguracji. Każdy dom sprząta tylko własne dane właściciela, bez zdalnego I/O.

Kwalifikacja bierze blokadę `SHARE` ustawień i `FOR UPDATE SKIP LOCKED` wątku.
Zapis treści bierze współdzieloną blokadę advisory wątku; maintenance próbuje
uzyskać najpierw globalną blokadę dziennika replikacji, potem wyłączną stronę
blokady treści — obie bez oczekiwania. Zajęty wątek odracza przez rollback
savepointu, zwalniając także blokadę rekordu. Zwykły zapis treści nie blokuje
rekordu wątku w triggerze, co zachowuje kolejność blokad archiwizacji i usuwania.
Kwalifikacja ponownie sprawdza termin i zależności po uzyskaniu blokad. Trwające tury,
zadania w tle, niedokończone importy, przeniesienia i wykonania connectorów
odraczają usunięcie. Zachowany fork, również przywracalny po ręcznym Delete,
chroni rekurencyjnie źródła swojej historii. Zachowane dzieci chronią rodzica.
Przetwarzanie liści pozwala później zwolnić całą wygasłą rodzinę.

Migracja `0150_thread_retention` dodaje `threads.purged_at` (nieodwracalny start)
i `purge_completed_at` (koniec). Zapis `deleted_at` publikuje zwykłe usunięcie do
klientów i workera; `RestoreThread` odrzuca wątek po przekroczeniu tej granicy.
Od tego momentu sprzątanie kończy się również po wyłączeniu retencji. Każda
transakcja usuwa lub kompaktuje ograniczoną partię jednej kategorii treści;
rollback cofa partię, restart kontynuuje według trwałych znaczników i pozostałych
danych. Nie resetuje numerów sekwencji, ACK ani zegarów replikacji.
Partie pomijają zajęte rekordy przez `SKIP LOCKED`, ale przed przejściem do
następnej kategorii sprawdzają, czy pozostały dane. Brak dostępnego rekordu
nie oznacza zakończenia purge.

Usuwane są eventy, projekcje itemów, notatki, visuals, kwarantanna eventów,
szkice wątku, przeniesiona historia i kopie treści replikacji. Payloady tur,
steerów, wywołań szyny, interakcji, celów, harmonogramów, komend i receiptów
są opróżniane z zachowaniem identyfikatorów, stanów i relacji wymaganych przez FK
oraz deduplikację. Małe szkielety wątków i kursory workera pozostają: późne
zdarzenia są ACK-owane bez odtwarzania historii. Nie jest to globalny limit
wielkości bazy: aktywne wątki, chronione źródła, boty i techniczne znaczniki
nadal zajmują miejsce. Autovacuum udostępnia usuniętą przestrzeń do ponownego użycia.

Załączniki i `thread_blobs` są odpinane partiami, a ich bajty usuwane tylko bez
referencji z innych załączników lub wątków. Załącznik używany przez inny szkic
zachowuje bajty i staje się niezależny od usuniętej tury. Wstawienie bloba lub
referencji i GC serializują się po hashach przez blokadę transakcyjną. Nowy worker
podaje `BlobChunk.thread_id`; gateway zapisuje referencję razem z bajtami pod
blokadą wątku, jeszcze przed zdarzeniem. Starsze uploady bez właściciela są
oznaczane `retention_exempt`, aby GC nie usunęło podglądu oczekującego na event.
Pliki projektu, worktree, scratch i sesje harnessów nie są usuwane przez tę retencję.
