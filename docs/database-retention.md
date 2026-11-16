# Retencja danych bazy

Status (2026-11-16): zaimplementowane sprzątanie techniczne i opcjonalne trwałe
usuwanie historii zarchiwizowanych wątków i 31-dniowe okno odtworzenia ręcznie
usuniętych wątków, bezstratna kompakcja transkryptu, ograniczanie dziennika
replikacji i GC nieużywanych uploadów; replikacja notice obejmuje wyłącznie
zdarzenia tego rodzaju. Purge czeka na potwierdzenie zamknięcia zasobów workera,
również gdy termin polecenia sprzątania już minął.
Dostępność nightly/beta/stable według
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

W zachowanych wątkach nie usuwamy według wieku `thread_events`, `thread_items`, tur, importów, audytu,
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

Ręczne **Delete** daje osobne okno odtworzenia: 31 pełnych dni od `deleted_at`,
niezależnie od opcjonalnego okresu archiwum. Po nim ten sam job kwalifikuje wątek
do trwałego czyszczenia. Stare `archived_at` nie skraca tego okna. Restore przed
kwalifikacją zatrzymuje usunięcie; kolejne Delete zaczyna nowe 31 dni. Wyłączenie
retencji archiwum nie wyłącza sprzątania ręcznie usuniętych wątków.

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

Migracja `0157_deleted_thread_retention` dodaje indeks kwalifikacji kosza.
Po 31 dniach od ręcznego Delete pozostała projekcja `background_task` w stanie
`in_progress` nie blokuje już purge: zdarzenia usuniętego wątku są ACK-owane bez
aktualizacji projekcji, więc taki znacznik mógłby pozostać na zawsze. Pozostałe
blokady pracy i zależności nadal obowiązują. Sprzątanie plików workera sprawdza
osobno rzeczywisty stan procesów i nie usuwa plików w trakcie ich używania.

Migracja `0158_thread_cleanup_retention` chroni również oczekujące
`unloadThread` niezależnie od `expires_at`. Archiwizacja offline nie może
przejść do purge przed potwierdzeniem sprzątania zasobów przez worker.

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

Usunięcie `thread_events` obejmuje całe `payload` i `raw`, w tym historyczne obrazy
zapisane jako base64 wewnątrz JSON. Znikają także wersje w
`thread_replication_journal` i bajty w `thread_replication_content` tego wątku.
Migracja `0153_thread_notice_replication` ogranicza nowe invalidacje notice do
`kind='notice'`, zachowując przejścia do i z tego rodzaju. Nie usuwa dawnych
rekordów ze środka dziennika: retencja przycina wyłącznie ciągły prefiks.

Załączniki i `thread_blobs` są odpinane partiami, a ich bajty usuwane tylko bez
referencji z innych załączników lub wątków. Załącznik używany przez inny szkic
zachowuje bajty i staje się niezależny od usuniętej tury. Wstawienie bloba lub
referencji i GC serializują się po hashach przez blokadę transakcyjną. Nowy worker
podaje `BlobChunk.thread_id`; gateway zapisuje referencję razem z bajtami pod
blokadą wątku, jeszcze przed zdarzeniem. Starsze uploady bez właściciela są
oznaczane `retention_exempt`, aby GC nie usunęło podglądu oczekującego na event.
Pliki projektu, worktree i scratch nie są usuwane przez retencję historii.
Cache paczek aktualizacji ma osobną politykę opisaną w [updates.md](updates.md).

## Kompakcja transkryptu

Zapis scala kolejne delty tego samego itemu w obrębie jednej transakcji ingestu.
Każdy event i jego numer sekwencji pozostają w bazie, ale projekcja `thread_items`
nie wymaga przepisywania całego narastającego tekstu dla każdej delty z partii.
Przed zdarzeniem innego rodzaju oraz końcem transakcji projekcja jest zapisana;
ACK nadal potwierdza trwale utrwalony stan. Forki zachowują dokładny prefiks historii.

Migracja `0155_transcript_raw_payload_refs` umożliwia bezstratne przechowywanie
duplikatów tekstu z `raw` przez referencje do `payload` tego samego eventu.
Zastępowane są tylko identyczne, dostatecznie długie ciągi, gdy referencje wraz
z mniejszym JSON-em zajmują mniej miejsca. Metadane providera pozostają;
`thread_event_raw(raw,payload,raw_payload_refs)` odtwarza kompletny JSON.
Nie usuwamy delt, nie zmieniamy `payload`, sekwencji ani treści projekcji.
Obrazy, notice i niezmapowane zdarzenia nie podlegają tej kompakcji.
Historyczny skan działa partiami z trwałym watermarkiem i omija pracujące wątki.

## Nieużywane uploady i bloby

Niezwiązany upload jest kandydatem po 30 dniach. Chronią go referencje szkicu
wątku, szkicu bota i szkicu przywracanego przez rewind. Opaque payloady starych
szkiców botów są indeksowane partiami; nieodczytany szkic konserwatywnie blokuje
GC uploadów właściciela. Migracja `0156_storage_cleanup` dodaje ten indeks referencji.

Bloby bez żadnej referencji można usuwać po 7 dniach. Hash jest wspólny dla
właścicieli, dlatego sprawdzane są wszystkie załączniki, miniatury i `thread_blobs`,
również innych kont. Po uzyskaniu blokady hasha job ponownie sprawdza referencje.
Historyczne `retention_exempt` pozostają chronione: bez informacji o źródle
nie można wykluczyć oczekującego replayu starszego workera.

## Pliki workera po purge

Gateway może zlecić sprzątanie dopiero po `purge_completed_at`, wyłącznie workerowi
przypisanemu do wątku i w zakresie tego samego właściciela. Zlecenie wymienia
identyfikatory wątku, providera i sesji; nie dostarcza ścieżek do usunięcia.
Nie obejmuje sesji nadal wskazywanych przez zachowany wątek lub rewind.

Worker utrwala autoryzację lokalnie i odracza usuwanie podczas pracy, otwartych
interakcji oraz oczekiwania na ACK journalu. Przyjęcie nowej komendy i konfiguracji
jest zsynchronizowane ze sprzątaniem. Dopiero po zatrzymaniu bezczynnych runtimów
usuwa kopie załączników wątku i dokładnie wskazane sesje w zarządzanych domach.
Restart ponawia niedokończone zlecenia; bez konfiguracji nie zgaduje domu profilu.
Własne domy CLI, źródła importu, manifesty kopii importów i symlinki pozostają
chronione. Ponowny import tej samej sesji chroni ją także przed starszym zleceniem.
To celowe wyjątki od GC, a nie wiekowy limit wszystkich katalogów użytkownika.

Zmiana wymaga obsługi `thread_storage_cleanup_v1` po obu stronach linku;
starszy worker zachowuje dotychczasowe pliki. Pliki projektu, worktree i scratch
pozostają niezależne od historii rozmowy. Kontrakt opisują
[protocol.md](protocol.md) i [worker-config.md](worker-config.md).

## Dziennik replikacji

Migracja `0154_thread_replication_retention` dodaje `replay_floor_seq` i dzierżawy
publikowanych zakresów oraz referencji do treści. Dziennik zachowuje sufiks
10 000 rekordów i co najmniej godzinny okres ochronny; aktywny, niezakończony
odczyt może czasowo zachować więcej. Sprzątanie usuwa ciągły prefiks i przesuwa
floor w tej samej transakcji. Nigdy nie przesuwa kursora odbiorcy przez dziurę.

Spóźniony połączony komputer odbudowuje pełne lustro przez zmianę epoki i seed
identyfikatorów z zachowanej historii, bez tworzenia monolitycznego snapshotu.
Klient UI odtwarza swoje ograniczone okno istniejącą ścieżką snapshotu.
Nieaktywne epoki są usuwane partiami; nieużywane `thread_replication_content`
można usunąć dopiero bez referencji zachowanego journalu, seedów, bieżących encji
i żywych dzierżaw. Bieżąca encja ma najwyżej jeden trwały wskaźnik do treści;
zmiana encji unieważnia go w transakcji zapisu. Dzięki temu nieodwinięty wynik
narzędzia pozostaje dostępny także w długo otwartym, bezczynnym kliencie.
Historyczne zapieczętowane rekordy są indeksowane przed GC ich treści.
Szczegóły protokołu opisuje [linked-computers.md](linked-computers.md).

## Pomiar i oddanie miejsca systemowi

`canopy-gateway storage inspect` wykonuje odczyt katalogów PostgreSQL: rozmiar
bazy, heap, TOAST, indeksy oraz szacowane liczby żywych i martwych wierszy.
Nie wypisuje treści rozmów ani parametrów połączenia i nie uruchamia migracji.

Po dużym purge zwykły autovacuum pozostawia wolne strony do kolejnych zapisów.
Jawne `canopy-gateway storage reclaim --offline --table thread_events`
przepisuje wybraną tabelę przez `VACUUM FULL`, oddając wolne miejsce systemowi.
Wymaga zatrzymanego gatewaya, zablokowania ponownych połączeń, dodatkowego miejsca
na przebudowę i wyłącznej blokady tabeli. Narzędzie przyjmuje wyłącznie nazwy
z allowlisty, odmawia przy innych sesjach i nie rozłącza ich samodzielnie.
Nie jest częścią automatycznego maintenance. Procedura operacyjna:
[deploy.md](deploy.md).
