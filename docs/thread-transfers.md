# Przenoszenie wątku na inny worker

Status (2026-11-28): zaimplementowane w web i desktopie dla workerów jednego gatewaya: wątek
przechodzi razem z natywną sesją harnessu (Claude, Codex) i stanem plików. **Move to…** między
połączonymi komputerami kontynuuje tę samą sesję, gdy obie strony to potrafią (sekcja
[Połączone komputery](#połączone-komputery)); w przeciwnym razie zostaje notatka przekazania
([linked-computers.md](linked-computers.md#konkretny-protokół-etapu-8)). Dostępność w kanałach
wynika z [promocji wydań](release.md).

## Cel

Ktoś pracuje w wątku na laptopie, musi go zamknąć, a ten sam gateway ma inny worker, który może pracować dalej.
Menu wątku (sidebar i nagłówek) ma **Move to another worker…** dla wątków głównych tego komputera, gdy gateway ma
inny worker. Po przeniesieniu ten sam wątek (id, tytuł, historia, ustawienia, harmonogramy, załączniki) działa na
drugim workerze, a model ma pełny kontekst rozmowy, bo kolejna tura wznawia tę samą sesję harnessu. Na starym
workerze wątek już nie działa.

## Co przechodzi

- **Historia Canopy** zostaje w PostgreSQL gatewaya; zmienia się tylko miejsce wątku: `worker_id`, `workspace_id`,
  `cwd`, `worktree_id` i instancja dostawcy (`provider_profile_id`).
- **Sesja harnessu** (`provider_thread_id` zostaje ten sam):
  - Claude: transkrypt `<dom>/projects/<katalog projektu>/<sesja>.jsonl` i katalog `<sesja>/` (subagenci,
    wyniki narzędzi). Katalog projektu zachowuje nazwę od starego folderu: Claude wznawia sesję po id w dowolnym
    katalogu projektu i dalej pisze tam, tak jak po zmianie worktree.
  - Codex: rollout `rollout-…-<id>.jsonl` z `sessions/` albo `archived_sessions/` (skompresowany `.zst` jest
    rozpakowywany) trafia do `sessions/RRRR/MM/DD/` domu instancji celu. `thread/resume` dostaje nowe `cwd`.
- **Pliki** — na celu zawsze powstaje nowy worktree w workspace'ie tego samego projektu, więc checkout
  użytkownika na celu zostaje nietknięty:
  - commity HEAD, których cel nie ma (także niewypchnięte), jako `git bundle` ucięty na wierzchołkach gałęzi,
    remote'ów i tagów repozytorium celu;
  - zmiany w indeksie i w katalogu roboczym jako dwie łatki binarne (`git apply --index`, potem `git apply`);
  - nowe nieśledzone pliki nieobjęte ignorowaniem, z bitami uprawnień — poza plikami mogącymi zawierać sekrety
    (`copySecret`, np. `deploy.pem`), które przechodzą tylko wybrane;
  - wybrane ignorowane pliki lokalne (konfiguracja jak `.env`, do 1 MiB, bez zależności i wyniku builda).
- **Gałąź** na celu ma nazwę gałęzi wątku; zajęta nazwa dostaje sufiks `-moved`, `-moved-2`…; odłączony HEAD
  dostaje `moved-<8 znaków id>`.

Kolejna tura dostaje notatkę `[canopy]` (przez `settings.branchNote`) ze starym i nowym folderem, bo ścieżki
w historii wskazują stary folder. Oś czasu każdego wątku rodziny pokazuje komunikat „Moved from Laptop to Office”.

## Czego nie przenosi (lista „To do again” w podglądzie)

- zależności i wyniku builda (`COPY_GENERATED_DIRECTORIES`), procesów, terminali i serwerów,
- sekretów podanych agentowi: na starym workerze były plikami, więc decyzja wygasza je, a agent prosi ponownie,
- nowych dowiązań symbolicznych spoza Git,
- punktów cofania plików Claude sprzed przeniesienia (cofanie samej rozmowy działa na całej historii).

Przy ruchu między połączonymi komputerami rekord ruchu na celu (`GetMoves`) mówi, co zaszło: w trybie
natywnym „The agent continues its session here in a new worktree”, a bez niego nową sesję z notatką
przekazania.

## Kiedy przeniesienie jest niemożliwe

Podgląd i start odmawiają z powodem, gdy:

- worker źródła lub celu jest offline albo nie ma capability `thread_transfer_v1` („Update Office to move threads.”),
- poprzedni, cofnięty ruch tego wątku jeszcze sprząta na workerach (`cleanup_pending`),
- cel nie ma workspace'u projektu („Add this project on Office first…”) albo worktree,
- wątek nie ma projektu (No project), nie ma jeszcze sesji, ma profil Sandbox, jest wątkiem bocznym (przechodzi
  z rodzicem), a jego wątki boczne są w innym folderze,
- wątek jest zajęty: tura w toku lub w kolejce, pytanie, steer, zadanie w tle, aktywny cel, praca szyny agentów
  albo niedokończone komendy workera — odmowa, nie czekanie,
- harness to Grok albo Antigravity: nie potrafią wznowić sesji w innym folderze (jak przy `switch_worktree`),
- historia sesji zawiera sekret projektu (znacznik w dzienniku workera, jak przy wznowieniu): sesja nie opuszcza
  workera; podgląd i eksport odmawiają,
- folder wątku nie jest szczytem checkoutu Git z commitem, repozytorium ma submoduły albo śledzone pliki z filtrem
  Git LFS (efektywne atrybuty, `:(attr:filter=lfs)`),
- na celu nie ma gotowej instancji tego samego harnessu (preferowana ta sama instancja, inaczej pierwsza gotowa).

Pliki mogące zawierać sekrety (`copySecret`) — ignorowane i nowe nieignorowane — wymagają wyboru i osobnego
potwierdzenia; gateway sprawdza je przy starcie, a worker przy eksporcie odrzuca plik spoza podglądu.

## Przebieg

Rekord `thread_transfers` (migracja `0227`) prowadzi każdy ruch: `preparing` → `prepared` → `committed` → `done`
albo `aborted`, z fazą (`freezing`, `exporting`, `copying`, `checking_out`, `applying`, `switching`, `releasing`)
i liczbą bajtów. Jeden ruch przed decyzją na wątek (indeks częściowy na `preparing`/`prepared`); ruch `committed`,
który czeka na zwolnienie paczek przez offline'owy worker, nie blokuje kolejnego.

1. **Zamrożenie (gateway, jedna transakcja).** Blokada wątku głównego, potem całej rodziny, ponowny odczyt rodziny,
   miejsca i sesji (inne niż w podglądzie: „The thread changed. Review the move again.”), sprawdzenie zajętości,
   wstrzymanie harmonogramów (z zapisem stanu) i `threads.transfer_pending_id`. Triggery odrzucają nową pracę
   („This thread is moving to another worker. Try again in a moment.”): wstawienie i przywrócenie tury
   (przejście w `queued`/`running`, także gdy wątek jest zamrożony ruchem do połączonego komputera), steer, cel, wywołanie szyny agentów, nowy wątek boczny (pod blokadą rodzica)
   i zmianę statusu harmonogramu. `threads_before_update` nie pozwala archiwizować, usuwać, cofać wątku ani zmieniać
   instancji dostawcy i profilu sandboxa. Zapis i usunięcie pliku oraz zmiana gałęzi i pull z Canopy w tym
   checkoucie lub jego podkatalogu (z dowolnego wątku) są odrzucane do decyzji: zapis rejestruje się przed
   sprawdzeniem, a ruch przed czekaniem (do 30 s) na zapisy w toku (`CheckoutWrites`); po restarcie sprawdza to
   baza. Ścieżki są porównywane jak w systemie workera (bez wielkości liter na Windows i macOS, oba separatory na
   Windows).
2. **Opróżnienie źródła.** Gateway kolejkuje `UnloadThread` dla rodziny i czeka (60 s od pierwszego wysłania), aż
   każde z nich się zakończy (nieudane lub wygasłe przerywa ruch), worker nie ma innych komend wątków, a gateway
   zapisał wszystkie ich zdarzenia.
3. **Eksport (źródło).** Worker sprawdza, że HEAD jest tym z podglądu, i buduje paczkę w prywatnym
   `<data_dir>/thread-transfers/out/<id>/`: `git/head.bundle`, `git/index.patch`, `git/worktree.patch`,
   `files/…`, `sessions/<wątek>/…` i `transfer.json` (opis checkoutu ze skrótem SHA-256 każdej zmienionej
   ścieżki i odciskiem całego checkoutu: HEAD, indeks, zmienione i nowe ścieżki z treścią, wybrane pliki lokalne;
   odcisk przed i po eksporcie musi być równy). Ścieżki sesji wskazuje dziennik workera i domy instancji, nigdy
   gateway; każdy plik sesji jest czytany przez deskryptor zamknięty w domu harnessu (bez dowiązań po drodze), a
   rollouty Codexa rozpoznaje jego własny parser nazw (także z sufiksem, w archiwum i skompresowane; tylko taki
   rollout jest rozpakowywany, inne pliki sesji przechodzą bajt w bajt). Opis paczki
   ma limit 32 MiB.
4. **Kopia (gateway).** Ramki jak w [kopiowaniu workspace'u](workspace-copy.md) (te same limity, tory i suma
   całości) trafiają do `<data_dir>/thread-transfers/in/<id>/files/` celu; cel haszuje każdy plik.
5. **Stage (cel).** Cel sprawdza sumę całości, weryfikuje bundle i pobiera commity do
   `refs/canopy/transfers/<id>` w repozytorium workspace'u (bez hooków, fsmonitor i tagów).
6. **Worktree (gateway).** Zwykłe tworzenie worktree agenta na commicie HEAD wątku (bez hooków i filtrów).
7. **Apply (cel).** W świeżym worktree cel stosuje łatki, zapisuje pliki (istniejący plik albo dowiązanie po
   drodze przerywa ruch) i porównuje SHA-256 każdej zmienionej ścieżki z opisem źródła. Następnie adoptuje sesje.
   Worker adoptuje dokładnie żądane sesje (jedna na wątek) i sprawdza wcześniej wszystkie ścieżki opisu paczki
   (przenośne, bez dowiązania w żadnym przodku przy odczycie i tworzeniu katalogów). Każda sesja musi mieć
   identyfikatory UUID i dokładnie układ dostawcy (Claude: jeden katalog projektu z
   `<sesja>.jsonl` i `<sesja>/…`; Codex: jeden rollout w `sessions/RRRR/MM/DD/`; identyfikatory małymi literami), więc paczka nie nazwie innego
   pliku domu. Plan adopcji (pliki z SHA-256, odkładane kopie w osobnym katalogu każdej sesji) trafia do
   `state.json` przed pierwszą zmianą, a cofnięcie jest powtarzalne i nie nadpisuje pliku zmienionego od adopcji
(jego kopia zostaje); plik opublikowany przez adopcję rozpoznaje po tożsamości (urządzenie i i-węzeł zapisane od
razu po publikacji) i treści, więc spóźnione anulowanie wcześniejszego ruchu nie usunie kopii późniejszego, a plik,
do którego CLI coś dopisało, zostaje. Worker szuka plików tej sesji w całym domu (Claude: każdy katalog projektu; Codex: każda data,
`archived_sessions`, `.zst`) i odkłada każdy, więc dom ma jedną historię sesji. Istniejący plik sesji worker
odkłada tylko, gdy należy do Canopy: dom związany z wątkiem
w dzienniku, prywatny `CODEX_HOME`, sesja Codexa zapamiętana we wspólnym domu CLI albo plik kopii z manifestu
(powiązanie sesji z domem CLI zapisane przez adopcję jest w rekordzie i anulowanie je usuwa; powiązanie z innym
domem — także przy prywatnym `CODEX_HOME` — odmawia);
inaczej (np. sesja samego CLI we wspólnym domu) odmawia: „This worker already has this session outside
Canopy.” Pliki są publikowane strumieniowo kopią
   prywatną importu (bez dowiązań, z tożsamością plików i manifestem): Claude do domu przypisanego wątkowi
   w dzienniku celu albo do domu instancji z wpisem `claude_import_homes`; Codex do prywatnego `CODEX_HOME`
   instancji z manifestem importu (normalizacja providera przy wznowieniu), a przy współdzielonym domu CLI do
   tego domu z wpisem `codex_cli_homes`. Plik, który cel już miał (wątek był tu wcześniej), jest najpierw
   odkładany obok i wraca przy anulowaniu. Dla sesji Codexa adopcja zapisuje też w dzienniku celu dowód historii
   (`codex_session_history`), jeśli go tam nie było: gdy pierwsze wznowienie na celu dostanie „no rollout found”,
   worker zgłasza błąd zamiast zaczynać nową sesję i podmieniać jej identyfikator. Anulowanie usuwa tylko wpis
   dodany przez tę adopcję.
8. **Sprawdzenie źródła.** `verify` liczy odcisk checkoutu źródła ponownie; inny (zapis edytora lub terminala po
   eksporcie) przerywa ruch: „The thread's files changed while moving. Nothing was moved; try again.”
9. **Decyzja (gateway, jedna transakcja) — punkt przełączenia.** `canopy.thread_transfer` = id ruchu pozwala
   triggerowi zmienić miejsce wątków rodziny dokładnie na przygotowany cel. W tej samej transakcji: wznowienie
   harmonogramów, wygaszenie sekretów wątku, nowy kontekst GitHub, notatka dla następnej tury i komunikat osi
   czasu; stan `committed`.
10. **Zwolnienie.** Oba workery usuwają paczkę i staging (cel także `refs/canopy/transfers/<id>` i odłożone
   pliki); potem `done`. Gateway ponawia zwolnienie co 30 s, gdy worker jest offline.

Źródło zachowuje swój checkout i kopię sesji jako zapas; nie są usuwane automatycznie.

**Odporność.** Gateway najpierw odczytuje trwałą decyzję: ruch `committed` (także gdy potem coś zawiodło) tylko
dochodzi do `done`. Przed decyzją każdy błąd (worker offline, odmowa, przekroczony czas, restart gatewaya) cofa
ruch: transakcja odmraża rodzinę (stan `aborted`, `cleanup_pending`), a dopiero potem cel anuluje staging, ref
i adopcję, gateway usuwa każdy worktree z `worktree_attempts` (próby zapisane przed utworzeniem; próbę bez wiersza
powtarza po tym samym identyfikatorze komendy i usuwa to, co zwróci), a źródło usuwa paczkę. Worker pamięta wynik
takiej komendy, a przed `git worktree add` zapisuje zamiar (`worktree-intents`): powtórka po przerwaniu między
utworzeniem a zapamiętaniem wyniku dostaje ten sam worktree zamiast błędu zajętej gałęzi, a gdy Git nie może tego
sprawdzić (także nieczytelny zamiar), zamiar zostaje i sprzątanie próbuje później. Ścieżkę z listy Git
porównuje jak przy cofaniu worktree (separatory i krótkie nazwy Windows).
Sprzątanie, któremu przeszkodził offline'owy worker, gateway ponawia co 30 s do skutku. Po restarcie ruchy
`preparing`/`prepared` są cofane, a `committed` dochodzą do `done`; przygotowanie, którego żaden proces nie
prowadzi od 2 minut (start przerwany przed uruchomieniem), cykliczne sprawdzenie cofa. Paczki bez adopcji worker usuwa po tygodniu;
staging z adoptowanymi sesjami czeka na zwolnienie albo anulowanie przez gateway. Worker trzyma naraz najwyżej
4 ruchy i 40 GB stagingu, licząc je do zwolnienia lub anulowania (także odczytane z dysku po restarcie, zanim
przyjmie jakąkolwiek operację ruchu). Nieczytelny `state.json` nigdy nie jest traktowany jak brak: operacja kończy
się błędem do ponowienia. Cofnięcie
adopcji zmienia manifest tylko, gdy jest wciąż tym, który zapisała.

## Kontrakty

- Łącze workera: `Command.thread_transfer` (240) i `CommandResult.thread_transfer` (242) z
  `canopy.worker.v1.ThreadTransferOperation` (`inspect`, `export`, `read_batch`, `release`, `tips`, `prepare`,
  `write_batch`, `stage`, `apply`, `cancel`) w `proto/canopy/worker/v1/thread_transfer.proto`. Komendy nietrwałe:
  bez outboxa, journala i zapamiętanych wyników; bajty nigdy nie trafiają do logów ani diagnostyki. Worker
  sprawdza katalogi jak każde `cwd` (`checkCwd`). `WORKER_LINK_PROTOCOL` bez zmian; capability
  `thread_transfer_v1` (`THREAD_TRANSFER_CAPABILITY`).
- UI: `PreviewThreadTransfer`, `StartThreadTransfer`, `GetThreadTransfer` w `canopy.ui.v1`
  (`proto/canopy/ui/v1/thread_transfer.proto`), BFF `PUT`/`POST /api/threads/[id]/transfer`
  i `GET /api/thread-transfers/[id]`. Metody nie są trasowane do połączonych komputerów; wymagają modułu Threads.
- Kod: worker `apps/worker/src/thread-transfer/` i `runtime/thread-transfer-host.ts`, gateway
  `apps/gateway/src/thread-transfers/`, web `ThreadTransferDialog.svelte` i `thread-transfer.ts`.

## Połączone komputery

Przeniesienie wątku do [połączonego komputera](linked-computers.md#konkretny-protokół-etapu-8) (etap 8,
**Move to…**) używa tych samych operacji workerów. Komputer ogłasza `move_native_sessions_v1`
(`MOVE_NATIVE_SESSIONS`), gdy jego gateway obsługuje przenoszenie; ścieżkę natywną wybiera ta sama funkcja w
podglądzie i przy ruchu: cel ją ogłasza, cała rodzina to Claude albo Codex z sesją w jednym folderze, a worker
źródła ma `thread_transfer_v1`. Podgląd (`MovePreviewItem.native_files`) mówi wtedy przed potwierdzeniem, że przechodzą sesja agenta i zmiany
wątku (niewypchnięte commity, edycje, nowe pliki), a zostają nowe pliki z sekretami, pliki ignorowane, zależności
i wynik builda. W przeciwnym razie podgląd zapowiada notatkę przekazania. Klient przekazuje potwierdzony tryb
(`StartMoveRequest.native_files`), a źródło zapisuje go w ruchu: wątek spoza listy (także od starszego klienta)
przechodzi z notatką, a wątek z listy, który nie może już przejść natywnie, kończy ruch prośbą o nowy podgląd.

1. Rodzina jest już zamrożona przez ruch; zanim gateway źródła odczyta historię do `PrepareMove`, opróżnia worker
   (jak wyżej; potwierdzony tryb natywny wymaga udanego opróżnienia, inaczej ruch kończy się prośbą o nowy podgląd),
   a potem prowadzi
   pliki przez `ComputerMoveService.TransferMoveFiles(MoveFiles)`: `tips` na workerze workspace'u wybranego na celu,
   lokalny `export`, potem `prepare`, ramki `write_batch`, `stage`, utworzenie worktree agenta (`checkout_head`,
   `checkout_branch`) i `apply` z sesjami. Paczka źródła zostaje do decyzji: `verify` checkoutu źródła odbywa się po
   odpowiedzi celu na `PrepareMove`, tuż przed zatwierdzeniem, a paczka jest zwalniana po decyzji.
2. Pierwszy krok zapisuje na celu rezerwację (`computer_move_files`, migracja `0227`) związaną z uwierzytelnionym
   partnerem, ruchem, workspace'em i jego workerem, z tokenem workera wybranym przez cel; inny partner nie
   kontynuuje, nie odrzuca ani nie rozstrzyga cudzego ruchu, a jeden partner ma naraz najwyżej 4 ruchy w toku.
   Wszystko jednego ruchu (kroki, `discard`, `PrepareMove`, decyzja, sprzątanie) cel wykonuje po kolei, a worker
   wykonuje operacje jednego tokenu po kolei (anulowanie czeka na trwający `apply`). Cel wykonuje tylko `tips`,
   `prepare`, `write_batch`, `stage`, `apply` ze ścieżką repozytorium z własnego workspace'u. Worktree tworzy raz
   (każdą próbę zapisuje przed utworzeniem), `apply` przyjmuje tylko ten worktree, rezerwuje sesje
   (`computer_move_file_sessions`, jedna sesja w jednym ruchu, do jego końca) i odmawia sesji, którą ma
   jakikolwiek wątek celu (także usunięty): w jednej transakcji najpierw rezerwuje, potem sprawdza wątki,
   z identyfikatorami sesji małymi literami (worker przyjmuje tylko takie); ponowiony `apply` musi nieść ten sam
   zestaw sesji, a rezerwacja trwa do sprzątania. Ruch nie może nieść jednej sesji
   dwa razy (sprawdzają to cel i worker), a `native` w ruchu bota jest odrzucane.
   Worker adoptuje dokładnie żądane sesje i zwraca potwierdzenie adopcji (`ThreadTransferResult.adopted`), które
   trafia do rezerwacji. Worker stosuje paczkę raz: ponowne `prepare` albo `apply` po stagingu jest odrzucane, a
   częściowe zastosowanie cofa tylko anulowanie. Po przygotowaniu ruchu (`PrepareMove`) kroki są odrzucane,
   a `discard` niczego nie usuwa. `PrepareMove` z identyfikatorem ruchu, który ma rezerwację innego partnera, jest
   odrzucany, a `PrepareMove` bez plików najpierw usuwa rezerwację tego partnera. Heartbeat (`MoveOutcome`)
   i odłączenie partnera rozstrzygają ruch tą samą blokującą decyzją, w kolejce ruchu.
3. `MovePrepare.native` (`MoveNative`: `worktree_id`, `cwd`, sesje wątków) trafia do `PrepareMove`. Cel przyjmuje go
   tylko, gdy zgadza się z rezerwacją tego partnera: stan `applied`, ten workspace i worktree oraz dokładnie te
   wątki z sesjami, harnessem i instancją z potwierdzenia adopcji; rezerwacja przechodzi wtedy w `staged` i odtąd
   tylko decyzja ruchu usuwa pliki. Worktree rezerwacji (i nowy worktree ruchu na tym samym gatewayu) jest dla
   sprzątania worktree zajęty, dopóki nie należy do wątku; `PrepareMove` sprawdza, że wciąż istnieje. Przy
   zastosowaniu ruchu cel ustawia ten worktree, `cwd` i ten sam
   `provider_thread_id`; zamiast notatki przekazania kolejna tura dostaje notatkę `[canopy]` o zmianie folderu,
   także gdy zastosowanie wznawia się po restarcie.
4. Błąd przed `PrepareMove` (albo odmowa ruchu) wysyła `MoveFiles.discard` i ruch kończy się błędem z powodem
   („The thread's session and files could not move: …”); nic się nie zmienia, użytkownik ponawia ruch. Pliki na
   celu idą za trwałą decyzją: przerwany ruch (także decyzja poznana przez `MoveOutcome` albo odłączenie partnera)
   usuwa staging, adopcję i worktree; zastosowany (`done`) zwalnia staging i ref, a sesja i worktree zostają, a
   rezerwacja sesji znika razem z zakończeniem, w jednej instrukcji. Heartbeat czyta stan już w kolejce ruchu i
   ponawia oba do skutku, a rezerwację bez przygotowanego ruchu i bez kroku od godziny usuwa. Źródło usuwa swoją
   paczkę zawsze po kroku 1.

Starsza strona (bez capability) przenosi wątek jak dotąd, z notatką przekazania.

## UI

Okno: wybór workera (offline wyłączony z opisem), workspace celu gdy jest więcej niż jeden, co przechodzi
(liczba zmienionych plików, niewypchnięte commity, wątki boczne, instancja na celu), pliki lokalne z polem wyboru
i osobnym potwierdzeniem plików z sekretami, lista „To do again on …”, potem postęp (faza, bajty, pasek) do wyniku
„Moved to Office.” albo powodu cofnięcia. Ruch działa w tle; zamknięcie okna go nie przerywa. Kontrolki z kitu.

## Weryfikacja

- `apps/worker/src/thread-transfer/transfer.test.ts`: dwa „workery” na prawdziwym Git — niewypchnięty commit,
  zmiana w indeksie i nad nią w katalogu roboczym, usunięcie z indeksu z nowym plikiem binarnym, skrypt
  wykonywalny, `.env`, niewybrany nowy `deploy.pem`, rodzina dwóch sesji Claude; zapis po eksporcie odrzuca
  `verify`; anulowanie przywraca starsze kopie obu sesji celu i usuwa ref; paczka nazywająca inny plik domu jest
  odrzucana przed zmianą domu; eksport odmawia przy innym HEAD.
- `tests/integration/thread-transfer.test.ts`: gateway z PostgreSQL i dwa prawdziwe workery z fixture Codexa —
  odmowa bez potwierdzenia sekretu, ruch do folderu bez repozytorium cofnięty po zamrożeniu (wątek dalej działa na
  starym workerze), potem udany ruch: miejsce, wszystkie rodzaje zmian, adopcja rolloutu, wznowienie tej samej
  sesji Codexa w nowym folderze na drugim workerze i komunikat osi czasu.
- `packages/db/test/thread-transfers.test.ts`: zamrożony wątek odrzuca turę, przywrócenie tury, wątek boczny,
  zmianę harmonogramu i archiwizację; miejsce zmienia tylko zatwierdzający ruch.
- `tests/integration/computer-move-files.test.ts`: rezerwacja celu — inny partner nie kontynuuje ani nie odrzuca
  ruchu, krok nie wskaże obcego folderu, po przygotowaniu ruchu kroki są odrzucane.
- `packages/db/test/schema.test.ts`: migracja `0227`.

- `tests/integration/computer-moves.test.ts`: ruch między komputerami ze skryptowanymi workerami bez
  `thread_transfer_v1` dalej przechodzi od notatki przekazania.
- `tests/integration/computer-moves-native.test.ts`: dwa gatewaye połączonych komputerów, każdy z prawdziwym
  workerem i fixture Codexa — podgląd proponuje tryb natywny, ruch przenosi rollout, niewypchnięty commit i nowy
  plik do nowego worktree celu, a kolejna tura na celu kończy się powodzeniem i wznawia tę samą sesję (sonda
  fixture) w tym worktree; gdy Codex celu nie znajduje rolloutu przy pierwszej turze, tura kończy się błędem,
  a identyfikator sesji zostaje.
- `tests/integration/computer-moves-archived.test.ts`: zarchiwizowany wątek z dwoma wątkami bocznymi dociera
  w całości i zachowuje stan archiwum każdego wiersza z jego czasem i powodem; przywrócenie głównego na celu
  przywraca tylko wątek boczny zamknięty razem z nim.

Odroczone: wątki bez projektu (scratch), wątki boczne w osobnych folderach, sprzątanie zapasowej kopii na
źródle i aplikacja mobilna. Grok i Antigravity pozostają zablokowane: ich CLI wznawia sesję tylko w folderze,
w którym powstała, więc przeniesiony wątek nie mógłby kontynuować w nowym worktree.
