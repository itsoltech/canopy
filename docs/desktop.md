# Canopy Desktop

Implementacja: `apps/desktop`. Zweryfikowany cel: **Linux x64**. Pozostałe cele mają
konfigurację i układ zasobów, ale nie zostały tutaj zbudowane ani uruchomione.
Produkt: **Canopy** — jedna instalacja z lokalnym wyborem kanału aktualizacji.

## Decyzje

1. **Runtime:** Electron main (Node) uruchamia kontroler Bun przez prywatne stdin/stdout
   z typowanymi komunikatami JSON. Kontroler nadzoruje PostgreSQL → gateway → enrollment
   → worker → adapter-node SvelteKit. Wszystkie usługi to procesy potomne, z osobnymi
   grupami procesów i ograniczonym restartem z backoff. Przy zamykaniu worker kończy
   pracę przed gatewayem, a gateway przed PostgreSQL; bezstanowy BFF kończy się równolegle.
   Zamknięcie stdin po śmierci Electron uruchamia sprzątanie kontrolera. Renderer ładuje
   zwykły origin HTTP i dokładnie ten sam build web, bez kopii komponentów. adapter-node 6
   nie czyta `ORIGIN`, a bez nagłówka proxy przyjmuje `https`, więc build desktopu podmienia
   w `adapter-node.js` stały origin na `CANOPY_WEB_ORIGIN` (dokładnie `http://127.0.0.1:<port>`
   okna). Kontrola CSRF formularzy SvelteKit zostaje bez zmian.
   Jedyny wyjątek dla obcego origin to nawigacja GET dokumentu na dokładny
   `/api/connectors/oauth/callback`; Host nadal musi się zgadzać. OAuth otwiera
   przeglądarkę systemową, więc powiązanie rozpoczętej autoryzacji zostaje w procesie BFF,
   zamiast w cookie Electrona. Gateway sprawdza jednorazowy state, właściciela,
   konto i TTL. Strona wyniku próbuje `canopy://connectors`; ten stały link
   pokazuje aplikację i otwiera ustawienia konektorów bez parametrów dostawcy.
   Powrót `canopy://oauth/callback` kończy logowanie przez ten sam proces BFF;
   otwarty dialog tego konta zamyka się po sukcesie. Ponowne wklejenie kodu
   potwierdza zakończenie bez drugiej wymiany. Restart procesu nadal unieważnia
   rozpoczęte logowanie, nawet przy zachowanym porcie; trzeba rozpocząć je ponownie.
   Okna odmawiają wszystkich uprawnień przeglądarki poza zapisem do schowka
   (`clipboard-sanitized-write`, potrzebnym dla `navigator.clipboard.writeText`)
   i powiadomieniami (`notifications`), i to tylko stronom z originu setupu albo web UI
   (`window-permissions.ts`). Odczyt schowka, media i reszta pozostają zablokowane.
   Alerty wątków i botów idą przez IPC `canopy:notification` do natywnego `Notification`
   procesu main (tylko ścieżki wątku lub bota, każdy klucz raz; [notifications.md](notifications.md));
   uprawnienie `notifications` jest rezerwą dla Notification API strony.
2. **Baza:** pełny PostgreSQL 18.6 z binariów `@embedded-postgres`, pobieranych tylko
   po wybraniu trybu lokalnego. Aplikacja nie zawiera PostgreSQL. Pierwszy lokalny start
   wymaga internetu; gotowy cache działa offline. Nie wymaga ręcznej instalacji ani
   działającego serwera PostgreSQL na komputerze. Inna instalacja (Homebrew, Postgres.app,
   `PATH`, serwer na 5432) nie przeszkadza: binarki są uruchamiane po ścieżce bezwzględnej,
   środowisko usług pomija zmienne `PG*`, serwer słucha na losowym porcie `127.0.0.1`
   bez gniazda Unix, a klaster leży we własnym katalogu danych.
   Decyzja użytkownika wyklucza PGlite i SQLite: ten sam silnik co na serwerze zachowuje
   transakcje, blokady, LISTEN/NOTIFY, typy i istniejące migracje bez zmian. Nie dodajemy
   drugiego drivera Effect SQL ani wariantów zapytań. Aktualny checkout zawiera już
   migrację mobile `0046`; desktop nie dodaje żadnej. Pakiet dystrybucyjny ma
   oznaczenie beta; sam serwer PostgreSQL to wydanie 18.6. Zmiana głównej wersji wymaga
   osobnej procedury eksportu/upgrade, nie automatycznego usuwania katalogu.
3. **Dane i sekrety:** wszystko pod `app.getPath('userData')`. Klucz szyfrowania gatewaya,
   token BFF i hasło bazy powstają raz. Plik 0600 zawiera wyłącznie ciphertext
   asynchronicznego `safeStorage` (Keychain na macOS, DPAPI na Windows,
   Secret Service/KWallet na Linuxie). Backend
   `basic_text` jest odrzucany; aplikacja wymaga działającego magazynu kluczy.
   `worker.json` zachowuje istniejący format enrollment i uprawnienia 0600.
4. **Porty:** losowe wolne porty; Postgres, web i domyślnie gRPC na `127.0.0.1`.
   Port web jest wybierany raz i zapisywany w `web-port` w katalogu runtime, bo origin
   `http://127.0.0.1:<port>` wyznacza localStorage z preferencjami urządzenia. Zajęty
   zapisany port zastępuje nowy, również zapisany.
   Settings → Network access otwiera jeden listener TLS dla telefonów, połączonych komputerów i workerów
   na wszystkich interfejsach, z portem wybieranym i zapisywanym w bazie. Parowanie
   przypina certyfikat komputera; zmiany sieci odświeżają ogłaszane adresy.
   Dawny wybór interfejsu w Desktop settings został usunięty; zapisane stare ustawienia
   nie otwierają listenera HTTP. BFF i baza pozostają na loopback.
   Gateway dostaje ten sam `CANOPY_WEB_ORIGIN` co BFF: opcjonalne HTTPS over Tailscale przekazuje
   żądania z tailnetu przez lokalny front gatewaya do BFF, z originem przepisanym dopiero po
   sprawdzeniu tożsamości i originu przeglądarki ([tailscale.md](tailscale.md#https-over-tailscale)).
5. **Pakowanie:** electron-builder, AppImage + deb na Linuxie, dmg + zip na macOS, NSIS
   na Windows x64.
   Osobny build zasobów dla każdej pary OS/arch; Bun i natywne zależności nie mogą
   pochodzić z innej architektury. Aktualizacje desktopu korzystają z electron-updater;
   nie zmieniają protokołu aktualizacji gatewaya/workera.

## Granice i zgodność

Tryb lokalny korzysta ze zwykłego `CreateWorkerEnrollment` i `enrollWorker`, zamiast
tworzyć poświadczenia bezpośrednio w bazie. Oba tryby ładują dołączony frontend
z lokalnego BFF na loopback. Tryb zdalny uruchamia BFF i worker, bez gatewaya/bazy;
BFF używa osobnego poświadczenia desktopu przez przypięty TLS Network access.
Token usługi serwera nie opuszcza serwera. Nowe urządzenie paruje się zaproszeniem
z Settings → Devices; stara instalacja automatycznie migruje przez zapisane
uwierzytelnienie własnego desktopowego workera. Szczegóły, ograniczenia i kolejne
etapy: [desktop-remote-frontend.md](desktop-remote-frontend.md).
Poświadczenie klienta jest ciphertext `safeStorage` w `desktop-client.enc` obok
zachowanego `worker.json`. Token enrollmentu nie trafia do `desktop.json`.
Otwarcie lokalnego UI nie czeka na gateway ani worker; ustawienia desktopu i
aktualizacje są dostępne offline. Zmiana trybu zatrzymuje lokalnie wykonywane zadania.

CLI agentów są wymaganiami komputera: **Claude Code (`claude`), Codex (`codex`),
Grok (`grok`)** instaluje i aktualizuje użytkownik, także przyciskiem w ustawieniach
workera. Desktop ani dystrybucja workera nie zawierają CLI; pobranie wymaga jawnej
akcji użytkownika. Claude Agent SDK pozostaje biblioteką JS;
każde wywołanie otrzymuje `pathToClaudeCodeExecutable` z PATH lub konfiguracji instancji.
Brak Claude daje status „Claude Code is not installed on this computer” w istniejącym
sondowaniu providerów. Własne pliki wykonywalne, loginy i profile native są zachowane.

Preload udostępnia status, konfigurację trybu w zaufanym lokalnym ekranie,
otwarcie ustawień oraz typowane operacje i subskrypcję aktualizacji aplikacji.
Brak dostępu do plików, shella i dowolnego IPC.
Menu „Settings…” (`CmdOrCtrl+,`) pokazuje główne okno i otwiera ostatnią stronę
ustawień używaną w tym oknie (domyślnie `/settings`). Main wysyła `canopy:open-route`
wyłącznie dla ścieżek `/settings` i ich podstron; preload oraz web ponawiają walidację.
Root layout używa `goto`, więc nakładka Settings zachowuje stronę pod spodem bez
przeładowania dokumentu. Żądanie czeka na `canopy:routes-ready` po zamontowaniu
aplikacji; ekran startowy bez działającej aplikacji ignoruje skrót.
`canopy://connectors` i powroty OAuth używają tej samej nawigacji SPA.
„Change desktop mode…” w menu i trayu nie ma skrótu; dotychczasowy bridge
`openSettings()` (`canopy:settings`) nadal otwiera osobny wybór trybu `/desktop?settings=1`.
Każde wywołanie jest sprawdzane względem nadawcy i originu; obcy web nie może
zmienić lokalnej konfiguracji ani przesłać tokenu enrollment. Renderer ma sandbox,
contextIsolation i wyłączoną integrację Node. Linki zewnętrzne otwierają systemową
przeglądarkę. `canopy://enroll` jedynie wypełnia formularz — nie zużywa tokenu bez akcji użytkownika.
Format: `canopy://enroll?gateway=<encoded-origin>&web=<encoded-origin>&token=<encoded-token>`.
Formularz potwierdza gotowość przez IPC przed dostarczeniem sekretu z linku.
Lokalny frontend ma też dostęp do wyboru kanału, sprawdzenia i restartu aktualizacji;
zgodę na downgrade wyświetla natywny dialog main, z domyślnym Cancel.
Konfigurację trybu oraz odbiór tokenu
może wykonać wyłącznie lokalna strona `/desktop`.

Polityka CSP dopuszcza skrypty z wybranego originu i hashe skryptów startowych
SvelteKit, bez `unsafe-eval` i `unsafe-inline` dla skryptów. Przy przeładowaniu dokumentu
main ponownie pobiera lokalny HTML, aby policzyć hashe. Okno nie ładuje zdalnego webu.
Hooki `webRequest` mają filtr `types: ["mainFrame"]`: skrypty, fetch i fonty nie czekają
na proces main, który na macOS obsługuje też wejście z klawiatury i myszy.

Migracja 0057 dodaje rodzaj klienta i jednorazowe migracje desktopów; proto rozszerza
parowanie i handshake addytywnie. `packages/ui/desktop` jest opcjonalnym
kontraktem typów. Mobile i przeglądarka nie muszą go implementować. Root workspaces
już obejmuje `apps/*`, więc nowa aplikacja nie wymaga zmiany konfiguracji workspaces.

### Kolory okna i paski tytułu

Pełne palety Light / Dark z Settings → Appearance obejmują też tło okna.
Main zachowuje opcjonalny `appearance-cache.json` w userData (wyłącznie nazwy
motywów i schemat), aby dobrać tło przed utworzeniem BrowserWindow. Preload
odczytuje go przez walidowane synchroniczne IPC; lokalny ekran `/desktop`
stosuje te same tokeny przed pierwszym renderem. Po połączeniu ustawienia
właściciela z gatewaya aktualizują cache i okno. Błąd zapisu cache nie blokuje
zmiany kolorów. Szczegóły kontraktu i pomiarów: [appearance.md](appearance.md).

Linux i Windows używają `titleBarStyle: hidden` oraz natywnego titleBarOverlay
o wysokości 48 px, z tłem canvas i symbolami ink aktywnej palety. Nagłówek
rezerwuje po prawej miejsce dla kontrolek, z uwzględnieniem zoomu. Regiony
przeciągania i bezpieczna wysokość są wspólne dla wszystkich platform desktop.
Zmiana schematu ustawia nativeTheme; System reaguje na preferencję systemu.
Integracja jest sprawdzona typami; wyglądu natywnego okna nie potwierdzono
w tej sesji na Linux, Windows ani macOS.

### Pozycja i rozmiar okna

Główne okno zapisuje `window-state.json` w userData: normalne bounds
(`getNormalBounds`), maksymalizację, pełny ekran i id ekranu. Zapis jest atomowy,
z opóźnieniem 500 ms po przesunięciu, zmianie rozmiaru i zmianie stanu, oraz
natychmiast przy zamknięciu okna i w `before-quit` (ukryte okno zapisuje ostatni stan sprzed ukrycia).
Stan ukrytego lub zminimalizowanego okna nie jest zapisywany; minimalizacja nigdy
nie jest odtwarzana.

Przy tworzeniu okna `restoredBounds` (`window-bounds.ts`, czysta funkcja z testem)
sprawdza zapis względem obszarów roboczych ekranów. Bounds w całości na jednym
ekranie zostają. W pozostałych przypadkach (odłączony monitor, mniejsza
rozdzielczość, okno częściowo poza ekranem) okno trafia na zapisany ekran, a gdy go
nie ma, na ten, który pokazuje największą część okna, albo na najbliższy. Rozmiar
mieści się w obszarze roboczym, ale nie spada poniżej minimum okna; pozycja jest
przycinana tak, by lewy górny róg był widoczny, a okno całkiem poza ekranem jest
centrowane. Bez ekranów okno dostaje domyślny rozmiar i centrowanie systemu.
Maksymalizacja i pełny ekran są przywracane po pierwszym `show()` w normalnych
bounds, więc cofnięcie maksymalizacji wraca do zapisanego rozmiaru. Okno wyboru
trybu ma stały, domyślny rozmiar. Na Linux pod Waylandem kompozytor może pominąć
pozycję; rozmiar i stany nadal działają.

### Paski okna macOS

Okna używają `hiddenInset` i pozycji kontrolek `{ x: 18, y: 18 }`. Regiony przeciągania
są ograniczone do jawnych pasków `data-window-drag` / `data-window-titlebar`.
Nagłówki stron działają przy rozwiniętym i zwiniętym sidebarze; wspólna wysokość to
48 px. Tylko kontrolki wewnątrz aktywnego paska dostają `no-drag`. Nie wolno ustawiać
`app-region` na dialogach, popoverach ani ich treści, nawet na `none`: Chromium 156
dziedziczy tę właściwość, a animacja dużego poddrzewa przebudowuje mapę regionów co klatkę.

Akcja `windowModal` oznacza ostatni otwarty modal przez `data-window-modal-top`.
Paski pod nim nie mają deklaracji regionu; `no-drag` na zasłoniętym pasku odejmowałby
obszar szuflady występującej wcześniej w DOM. Zamknięcie przez Escape, przycisk lub
odmontowanie przywraca poprzedni modal. Obserwowany jest wyłącznie atrybut `open`
samego dialogu. Otwarty popover lub toast zawiesza paski, bez regionów na nakładce.
Baner braku gatewaya i toasty są odsunięte poniżej kontrolek okna.

Typowany bridge `windowState()` / `onWindowState()` przenosi `{ zoomFactor, fullscreen }`
przez `canopy:window-state`; odczyt wymaga tego samego sprawdzenia nadawcy i originu
co pozostałe IPC. Main publikuje stan po załadowaniu dokumentu, zmianie zoomu gestem
lub z menu, fokusie oraz wejściu/wyjściu z pełnego ekranu. Zoom pozostaje dostępny.
Renderer ustawia `--window-zoom` i `data-window-fullscreen`; rezerwa pozioma
`80px / zoom` oraz minimalna wysokość `48px / zoom` chronią stałe położenie natywnych
kontrolek. Rezerwa znika w pełnym ekranie i dotyczy tylko lewej kolumny pod kontrolkami.
Zdalny web rozpoznaje nowe metody bridge, więc starszy shell nadal może go otworzyć.

Przeciąganie i trafianie w kontrolki wymagają kontroli na natywnym macOS;
emulowanie `data-canopy-platform="darwin"` w przeglądarce nie sprawdza zachowania okna.

Zmiany wspólnego kodu są addytywne:

- `packages/ui/desktop`: opcjonalne typy bridge, bez zmian protokołu gatewaya.
- Gateway: telefony, połączone komputery i zdalne workery korzystają ze wspólnego TLS
  w Settings → Network access. Bootstrap i lokalny worker pozostają na loopback.
- Worker: opcjonalny `CANOPY_WORKER_STATUS_FILE`, raportujący stan linku bez sekretów.
- Web: dotychczasowy shell wyodrębniony do `AppShell.svelte`, ekran `/desktop`
  i feature-detectowana sekcja Settings → Desktop. Normalna przeglądarka zachowuje UI.

Mobile nie musi zmieniać kontraktów ani konfiguracji. Root zmieniono tylko w `bun.lock`.

## Cykl życia i katalogi

`initdb` tworzy `userData/postgres/data` przy pierwszym uruchomieniu, z UTF-8,
locale C, użytkownikiem `canopy` i uwierzytelnianiem SCRAM na TCP. Katalog danych
i hasło nie są odnawiane przy kolejnym starcie. PostgreSQL działa jako proces
pierwszoplanowy na losowym porcie `127.0.0.1`, bez unix socketów, z limitem
40 połączeń (pula gatewaya oraz zapas dla inicjalizacji i kontroli zdrowia).
Dotyczy to również Windows; nie używamy named pipes ani poleceń powłoki do ścieżek.

Postgres sam sprawdza `postmaster.pid` po awarii i odtwarza WAL. Aplikacja nigdy
nie kasuje pliku PID w ciemno; konflikt z żywym serwerem kończy się błędem.
Niepełne `initdb` również zgłasza błąd zamiast usuwać istniejące dane.

### Ekran uruchamiania

Kontroler odczytuje zapisany tryb z `desktop.json` przed otwarciem pierwszego okna.
Skonfigurowana aplikacja ładuje `/desktop` jako ekran startu: logo Canopy, krótki
status połączenia ze zdalnym hostem lub startu usług lokalnych, a przy pobieraniu
PostgreSQL pasek postępu. Błędy udostępniają „Try again” i „Open desktop settings”.
Niepoprawny plik konfiguracji również prowadzi do odzyskiwania, zamiast do pierwszego uruchomienia.
Formularz wyboru trybu pojawia się tylko bez konfiguracji albo po jawnym otwarciu
wyboru trybu (`/desktop?settings=1`). Ekran zawiera wyłącznie wybór local/remote
i pola połączenia. Aktualizacje pozostają w Settings → App updates, a skrót Quit w Settings → General → Desktop app.
„Back to Settings” i Escape zamykają osobne okno wyboru, przywracając poprzedni
widok Settings bez zapisu ani przeładowania; pierwsze uruchomienie nie ma przycisku powrotu.
Zapis niezmienionych pól tylko wraca. Main i kontroler również pomijają wtedy
zapis, parowanie i restart usług. Nowe zaproszenie lub enrollment są zmianą.
Wyłącznie rzeczywista zmiana zapisanej konfiguracji pokazuje ostrzeżenie o zatrzymaniu
agentów oraz natywne potwierdzenie z domyślnym Cancel. Postęp i błąd zapisu są inline;
pierwszy start usług nadal pokazuje ekran startu.
Okno pozostaje ukryte do `ready-to-show`, a natywne tło odpowiada jasnemu/ciemnemu
motywowi systemu także podczas nawigacji. Ekran startu ma ten sam pasek przeciągania
i `--window-safe-top` co konfiguracja; wskaźnik respektuje ograniczenie ruchu.
Zdalny web ma 3-sekundowy limit sondy dokumentu. Jeśli działa, otwiera się od razu,
a niedostępny gateway obsługuje istniejący ekran webu; jeśli sam web nie odpowiada,
lokalny ekran startu pokazuje błąd i działania naprawcze.

Procesy uruchamiają się w kolejności: baza → migracje/start gatewaya → enrollment
→ worker. Lokalny BFF służy także jako ekran konfiguracji przed uruchomieniem bazy.
Gotowość sprawdzana jest przez SQL, gRPC i HTTP; potem co 5 sekund przez gRPC/HTTP.
Kontroler wysyła status do Electron tylko przy zmianie; każde zdarzenie przebudowuje menu
aplikacji i traya w wątku UI, który dostarcza też wejście; ten sam stan nie jest powtarzany co sekundę.
Nadzorca sprawdza liveness co 5 sekund, z limitem 5 sekund na sondę. Gateway odpowiada
anonimowym `UpdateService.Check` bez tokenu, zapytań do bazy i odpytywania połączonych
komputerów. BFF odpowiada istniejącym `/api/health`, bez renderowania strony i wywołań
gatewaya. `GetOverview` służy danym aplikacji, nigdy kontroli procesu.
Restart wymaga co najmniej 30 sekund kolejnych nieudanych sond; sukces zeruje ten czas.
Nowy proces, również po restarcie, musi najpierw odpowiedzieć poprawnie. Nadzorca nie
zabija procesu, który nadal startuje. `suspend` zatrzymuje sondy, a `resume` i `unlock-screen`
zerują porażki i dają 30 sekund ochrony. Luka timera powyżej 15 sekund lub sonda
obejmująca taką lukę daje tę samą ochronę, także bez zdarzenia Electrona. Wynik sprzed
uśpienia, zmiany konfiguracji lub wymiany procesu jest ignorowany.
Każda porażka zapisuje timeout, kod gRPC albo status HTTP; restart zapisuje czas
nieprzerwanej awarii i ostatnią przyczynę. Przejściowy błąd nie zmienia fazy aplikacji
na startowanie. Przed restartem gatewaya kontroler próbuje ogłosić `restarting`;
SIGTERM pozwala też gatewayowi zamknąć łącza z zapowiedzią. Po 10 sekundach bez wyjścia
nadzorca kończy wyłącznie własną grupę procesu. Gdy gateway nie odpowiada ani nie
obsługuje sygnału, zapowiedź jest niemożliwa i partner widzi nieoczekiwaną utratę.
Worker raportuje stan plikiem, ale utrata połączenia z gatewayem ani nieświeży status
nie powodują jego zabicia; własny reconnect przywraca łącze. PostgreSQL również nie
jest restartowany na podstawie operacji aplikacyjnych. Restart po wyjściu procesu ma
backoff 1–30 sekund i budżet 8 prób; kod 78 workera nie jest ponawiany.

Zamykanie: worker → gateway → PostgreSQL → BFF. POSIX używa własnych grup procesów
(Postgres dostaje SIGINT, czyli fast shutdown); Windows zamyka stdin sidecarów
i wykonuje `pg_ctl stop -m fast`. Po 10 sekundach dla danej usługi następuje
wymuszone sprzątanie grupy lub `taskkill /PID <owned-pid> /T /F`. Nie ma wyszukiwania
procesów po nazwie. Kontroler otrzymuje EOF po śmierci Electron i ma 30-sekundowy
limit całego sprzątania, również podczas trwającego startu. SIGKILL całego drzewa
procesów lub awaria OS nie daje możliwości wykonania shutdown; trwałość zapewnia WAL.

Jedna baza naraz: Electron trzyma blokadę jednej instancji, a PostgreSQL odmawia startu
na katalogu danych zajętym przez żywy postmaster. Gdy kontroler zginie bez sprzątania
(`kill -9`, OOM), sidecary Bun kończą się same po EOF na stdin, ale postmaster nie obserwuje
rodzica i zostaje osierocony. Następny start (`stopOrphan` w `runtime/database.ts`) czyta PID
z `postmaster.pid` i — tylko gdy to postgres obsługujący dokładnie ten katalog (Linux
`/proc/<pid>/cmdline`, macOS `ps`, Windows `pg_ctl status`) — zatrzymuje go `pg_ctl stop -m fast`,
w razie potrzeby `-m immediate`, i dopiero wtedy uruchamia własny. Wcześniej taki start wisiał.
Pokrywa to test integracyjny „a postmaster orphaned by a killed guardian…”.

Pliki pod `userData`:

```text
secrets.enc                 # ciphertext OS keychain; 0600 na POSIX
desktop.json                # tryb/adresy; bez tokenu enrollment
app-updates.json            # wybrany kanał desktopu; zapis atomowy w main, bez gatewaya
remote-update.json.<hash>    # historia zdalnej aktualizacji per desktop device; bez credentiali
remote-update.json          # tryb lokalny: historia aktualizacji zleconych przez połączone komputery
app-shortcuts.json          # quitShortcut; zapis atomowy w main, bez gatewaya
app-update-checks.json      # częstotliwość i ostatnie sprawdzenie aktualizacji desktopu
web-port                    # stały port web UI, więc localStorage (preferencje urządzenia) przetrwa restart
window-state.json           # pozycja, rozmiar, maksymalizacja, pełny ekran i ekran głównego okna
postgres/data/              # pełny klaster PostgreSQL
postgres/versions/<pin>/    # zweryfikowany runtime; installed.json oznacza pełną instalację
postgres/versions/*.download/ # częściowe pobranie do wznowienia; nigdy nie służy do startu
local-worker/worker.json    # credential; 0600 na POSIX
remote-workers/<hash>/      # osobna tożsamość dla każdego gatewaya
logs/                       # redakcja sekretów; 5 MiB + 3 rotacje na usługę
```

Nowe worktree lokalnego workera nie leżą w tym katalogu, tylko w `~/canopy/worktrees`. Starsze zostają w
`local-worker/data/worktrees` i pozostają zarządzane ([worktrees.md](worktrees.md#położenie)).

### Settings → Linked computers

Tryb lokalny może dodatkowo sparować swój gateway z innym własnym komputerem;
to nie nowy tryb pracy. Telefony i komputery łączą się przez **Settings → Network access**
([network-access.md](network-access.md)): jeden przełącznik, listener na wszystkich interfejsach,
port wybrany raz i zapisany w bazie, adresy wykrywane przy każdej zmianie sieci. Nie trzeba niczego
wybierać w Desktop settings. „Link a computer” przy wyłączonym dostępie włącza go jednym kliknięciem.
Listener używa przypiętego TLS; firewall systemu może zapytać o zgodę na połączenia przychodzące.
Kod jednorazowy i lista adresów są w „Link a computer”; druga strona wybiera „Enter code”.
Porównanie odcisków obu certyfikatów jest dostępne na liście.

Gdy oba komputery są w tej samej podsieci, znajdują się przez mDNS i zapisują nową trasę
(źródło „Local network”) dopiero po przypiętym handshake'u; ogłoszenie zawiera wyłącznie rotowany,
nieprzezroczysty identyfikator ([etap 6](linked-computers.md#konkretny-protokół-etapu-6)).
Przełącznik „Find linked computers on this network” wyłącza to dla danego komputera. Na macOS
pierwsze ogłoszenie wywołuje systemowe pytanie o dostęp do sieci lokalnej: `Info.plist` zawiera
`NSLocalNetworkUsageDescription`. `NSBonjourServices` nie jest potrzebne, bo gateway używa gniazda
UDP, nie API Bonjour, a typy usług są losowe i rotowane. Odmowa dostępu wyłącza tylko wykrywanie;
trasy ręczne i ogłaszane działają dalej. Włączony Network access jest potrzebny, żeby
inne komputery mogły znaleźć ten; przy wyłączonym komputer tylko szuka partnerów.

Electron ogłasza sleep/resume oraz quit/update prywatnym kanałem do kontrolera,
który wywołuje lokalne API gatewaya. Sekrety i klucze pozostają w gatewayu.
`suspend` wysyła zapowiedź snu od razu, poza kolejką startu, z deadline 500 ms, bez
blokowania systemu. Jest to best effort: gdy zapowiedź nie zdąży, partner pokaże
Unreachable since …; gdy dotrze, zachowuje Asleep since … do wznowienia. `resume`
resetuje nadzór od razu, a online ogłasza po 5 sekundach; ponowny sen anuluje ten timer,
co ogranicza zmiany stanu podczas krótkich dark wake/Power Nap. `unlock-screen` ogłasza
powrót od razu. Quit anuluje oczekujące ogłoszenie online. Aktualizacja, również zdalna,
ogłasza Updating…, zwykłe wyjście Offline since …, a restart nadzorcy Restarting….
Okno powrotu aktualizacji/restartu wynosi 5 minut; potem partner pokazuje Unreachable.
Pełna tabela i zgodność starszych partnerów: [linked-computers.md](linked-computers.md#obecność-i-odwołanie).

Menu aplikacji otwiera ustawienia i katalog logów; tray pokazuje stan workera
i znalezione CLI. macOS używa hidden-inset z miejscem na traffic lights w sidebarze;
Linux i Windows zachowują natywną ramkę. Jedna instancja przypada na katalog danych.

Kopię zapasową katalogu danych wykonuj po zamknięciu aplikacji. `secrets.enc` jest
związany z magazynem kluczy użytkownika/OS; samo skopiowanie go na inny komputer
nie zapewnia możliwości odszyfrowania bazy sekretów gatewaya. Przed zmianą głównej
wersji PostgreSQL potrzebny jest eksport i jawna procedura migracji.

## Build i uruchomienie

Wymagania środowiska budującego: Bun **1.4.4**, Node **24 lub nowszy**, natywny host
zgodny z docelowym OS/arch. Aplikacja zawiera jeden Bun; PostgreSQL pobiera osobno
dla trybu lokalnego. CLI agentów instaluje się osobno: ręcznie albo przyciskiem
w ustawieniach workera.
Linux potrzebuje zwykłych bibliotek Electron i odblokowanego Secret Service/KWallet;
nie stosujemy fallbacku plaintext ani `--no-sandbox`.
Narzędzie fpm do deb potrzebuje `libcrypt.so.1` (na Arch: `libxcrypt-compat`).
Do pakowania zapewnij kilka GiB wolnego miejsca w `TMPDIR`. Jeśli tmpfs `/tmp`
jest zbyt mały, ustaw `TMPDIR` na katalog na dysku.

Z katalogu repozytorium:

```sh
bun install
bun run --cwd apps/desktop build
bun run --cwd apps/desktop dev
```

Instalatory (wybierz polecenie na odpowiednim hoście):

```sh
bun run --cwd apps/desktop package:linux
bun run --cwd apps/desktop package:mac
bun run --cwd apps/desktop package:windows
```

`CANOPY_TARGET` opcjonalnie deklaruje cel i musi zgadzać się z hostem. Build odrzuca
cross-host, zamiast dołączyć niezgodne biblioteki sharp lub pin PostgreSQL. Do ponownego
pakowania już zbudowanego runtime: `bun run --cwd apps/desktop scripts/package.ts`.
`CANOPY_CHANNEL=stable|beta|nightly` określa kanał buildu i domyślny wybór aktualizacji (domyślnie stable).
Przykład: `CANOPY_CHANNEL=beta CANOPY_VERSION=0.2.0-beta.1 bun run --cwd apps/desktop package:mac`.
Wynik jest w `apps/desktop/release/<kanał>/`; katalog jest ignorowany przez git.
Skrypt pakowania w razie zmiany kanału odświeża shell i ikonę, zachowując zbudowany runtime.

| Cel | Host / przykład runnera GitHub Actions | Pakiet PG | Instalator | Weryfikacja tutaj |
| --- | --- | --- | --- | --- |
| Linux x64 | `ubuntu-24.04` | `linux-x64` | AppImage, deb | build + run AppImage |
| Linux arm64 | `ubuntu-24.04-arm` lub natywny self-hosted ARM64 | `linux-arm64` | AppImage, deb | niewykonana |
| macOS arm64 | `macos-15` lub self-hosted Apple Silicon | `darwin-arm64` | dmg, zip | niewykonana |
| Windows x64 | `windows-2025` | `windows-x64` | NSIS | niewykonana |

Te joby realizuje `desktop` w `.github/workflows/release.yml` ([release.md](release.md)):
z `CANOPY_VERSION` i `CANOPY_CHANNEL` nazwy plików to `Canopy[-Beta|-Nightly]-<wersja>-<linux|darwin|windows>-<x64|arm64>.<ext>`,
macOS dostaje też `zip`, podpisywanie jest warunkowe. Każdy job CI: checkout tego samego commita → instalacja Node/Bun → `bun install`
→ `package:linux`, `package:mac` albo `package:windows` → zachowanie plików z
`apps/desktop/release/<kanał>`. Przed budową sprawdź `process.platform/process.arch`;
host musi odpowiadać wierszowi tabeli. Brak Windows arm64 jest celowy.
Runner nie potrzebuje sekretów gatewaya ani kluczy providerów. Publikowanie
wyłączono (`--publish never`). Metadata `homepage` używa identyfikatora `canopy://desktop`;
repozytorium nie deklaruje publicznej strony produktu.

Układ zasobów jest taki sam dla każdego celu (`.exe` wyłącznie przy Bun na Windows):

```text
resources/runtime/
  canopy-controller.js
  canopy-gateway.js
  canopy-worker.js
  canopy-web.js
  bun[.exe]
  postgres.json             # dokładna wersja, major, platforma i SHA-512 z bun.lock
  web/                      # assets identycznego adapter-node build
  node_modules/             # sdk.mjs Claude Agent SDK oraz natywne @img sharp/libvips
  licenses/
  THIRD_PARTY_NOTICES.md
  target.json
```

Źródło relokowalnych binariów: `@embedded-postgres/<platform-arch>`
**18.6.0-beta.19**, bazujące na dystrybucji Zonky. Wersja i integralność npm są
przypięte w `bun.lock`; podczas build wersja jest dodatkowo sprawdzana. Licencje
PostgreSQL, MIT opakowania, Apache-2.0 dystrybucji oraz odnośniki do bibliotek
zależnych zapisano w `apps/desktop/THIRD_PARTY_NOTICES.md` i dołączono do paczki.

Shell main/preload wraz z electron-updater jest zbundlowany do `dist/*.cjs`.
Zależności desktopu są `devDependencies`, więc asar zawiera wyłącznie `dist` i
`package.json`. Gateway, worker, web i kontroler są minifikowanymi bundlami JS
uruchamianymi jako `bun <entry>.js`; zachowują stdin i grupy procesów.
`CANOPY_INSTALL_KIND=desktop` nadal wyłącza samodzielną podmianę workera/gatewaya.
Nie wykonujemy drugiego `bun install --production` z zależnościami całego monorepo.

### PostgreSQL pobierany dla trybu lokalnego

Build zapisuje pin z `bun.lock`; runtime pobiera wyłącznie tę wersję tarballa z npm,
bez rozwiązywania `latest` i ponownego zaufania do metadanych rejestru. SHA-512
jest sprawdzane przed rozpakowaniem. Ponowienie częściowego pobrania używa HTTP Range;
serwer bez Range powoduje bezpieczne pobranie od początku. Zły hash usuwa pobranie.
Rozpakowanie odbywa się w katalogu tymczasowym, a rename publikuje cały runtime
wraz z `installed.json`. Niepełny runtime nigdy nie służy do `initdb` ani startu.
Zamykanie aplikacji przerywa pobieranie, zachowując plik do wznowienia.

Ekran konfiguracji pokazuje procent pobrania, weryfikację i przygotowanie, a przy
błędzie „Try again”. Także przy przywracaniu zapisanej konfiguracji najpierw otwiera
się ekran lokalny. Tryb remote nie czyta nawet manifestu PG i nic nie pobiera.
Po poprawnym starcie nowej wersji i zatrzymaniu ewentualnego osieroconego postmastera
usuwane są poprzednie, nieużywane katalogi wersji. Katalog danych pozostaje osobno.
Inny major w `PG_VERSION` blokuje start **przed pobraniem i sprzątaniem cache**;
dane i stare binaria zostają. Canopy nie wykonuje `pg_upgrade` ani nie usuwa klastra.
Bez jawnej migracji i backupu użyj poprzedniej wersji aplikacji.

Przy przygotowaniu odtwarzamy symlinki z `pg-symlinks.json`, zastępując także
zduplikowane zwykłe pliki. Usuwamy wyłącznie nagłówki i statyczne archiwa `.a`;
SQL, rozszerzenia, locale, biblioteki dynamiczne i licencje zostają. Na macOS
wybieramy slice arm64 plików universal bez wymagania Xcode/lipo u użytkownika,
podpisujemy Mach-O ad-hoc i sprawdzamy `codesign --verify --strict`. Przed atomowym
opublikowaniem wszystkie trzy narzędzia PG muszą wykonać `--version`.

Pierwsze uruchomienie świeżo zapisanego pliku wykonywalnego macOS sprawdza
(syspolicyd/XProtect). Pomiar na macOS 27.0.1 (Mac Studio, bez obciążenia):
pierwsze `postgres --version` trwa 3–3,6 s, kolejne ok. 20 ms; `pg_ctl` i `initdb`
0,15–0,45 s. Ocena dotyczy nowych plików, a nie treści: każda próba rozpakowuje
runtime od nowa i znów płaci ten koszt, także gdy ten sam pin jest już zainstalowany
gdzie indziej. Na świeżo zainstalowanym, zajętym Macu przekraczało to dawny limit
10 s na binarkę i kończyło się ogólnym błędem. Teraz trzy sprawdzenia mają wspólny,
twardy budżet 3 min (`postgres-check.ts`). Po 5 s ekran pokazuje „Checking PostgreSQL
with macOS security…”. Po przekroczeniu budżetu proces dostaje SIGKILL, a oczekiwanie
na jego wyjście i stdout/stderr jest dodatkowo ograniczone, więc ponowienie nie może
zawisnąć. Błąd rozróżnia przekroczenie czasu, zablokowanie przez system (sygnał),
nieudane uruchomienie i złą wersję. Do `logs/desktop.log` trafia binarka, kod wyjścia
lub sygnał, czy zadziałał limit, czas oraz przycięte stdout/stderr ze ścieżką runtime
zastąpioną `<runtime>`. Udana instalacja zapisuje czasy pierwszych uruchomień.

Ponowienie po błędzie używa zweryfikowanego `package.tgz.partial` (SHA-512 jest liczone
ponownie przed użyciem), więc nie pobiera pakietu jeszcze raz. Katalogi `extracted/`
i `install/` są usuwane po każdej nieudanej próbie i przed następną.

Adres rejestru można nadpisać tylko testowym argumentem albo
`NODE_ENV=test CANOPY_TEST_POSTGRES_REGISTRY=http://127.0.0.1:<port>/` w procesie
testowego kontrolera. Produkcyjne środowisko i konfiguracja UI nie mają takiego pola.

### Limity rozmiaru pakietu

Guard liczy długości plików bez narzutu bloków filesystemu. Limity wynoszą
550 MiB dla Linux, 600 MiB dla macOS arm64 i 650 MiB dla Windows x64.
`package-sizes-<target>.json` powstaje jako artefakt CI, poza źródłami.
Guard odrzuca też app node_modules, asar.unpacked, dołączoną bazę/CLI, nieoczekiwane
zależności runtime, kopie Bun, identyczne pliki ≥8 MiB i nie-arm64 Mach-O na macOS.
Wspólny plugin kompilatora blokuje import pakietów CLI także w binarkach i Dockerze.

## Jedna instalacja i kanały

Wszystkie buildy mają `appId: app.canopy.desktop`, `productName: Canopy`, executable
`canopy` i jeden schemat `canopy://`. Instalatory nazywają się
`Canopy-<wersja>-<os>-<arch>.<ext>`; wersja zawiera `-beta.N` lub `-nightly.N`.
Zmiana kanału zastępuje tę samą aplikację. userData jest wspólne: macOS
`~/Library/Application Support/Canopy`, Windows `%APPDATA%/Canopy`, Linux
`${XDG_CONFIG_HOME:-~/.config}/Canopy`. `CANOPY_USER_DATA` pozostaje nadpisaniem diagnostycznym.

Ikona zależy od **zainstalowanego buildu**: stable zachowuje źródłowy PNG, beta jest
bursztynowa, nightly fioletowa. Kolor nie wpływa na bundle ID, podpis ani schemat.
Zmiana preferencji nie zmienia ikony przed instalacją. Sidebar oznacza wersję
uruchomionego web buildu; sekcja App updates pokazuje wersję i kanał samego Electrona,
także gdy lokalny frontend łączy się ze zdalnym gatewayem o innej wersji.

### Przejście ze starych Canopy Beta / Canopy Nightly

**Zainstaluj Canopy jeden raz ręcznie.** Dotyczy m.in. `Canopy Nightly`
`0.2.0-nightly.2` (`app.canopy.desktop.nightly`) i dawnego `app.canopy.desktop.beta`.
Ich updater na macOS nie może zmienić bundle ID: Squirrel wymaga tego samego
designated requirement. Ponawianie aktualizacji starej aplikacji tego nie naprawi.
Po instalacji Canopy wybierz Beta/Nightly w App updates. Stare aplikacje zamknij
i usuń ich bundle/instalator, gdy nowa instalacja działa; ich dane pozostają nietknięte.

Nie ma automatycznego importu: `secrets.enc` jest związany z magazynem kluczy OS
i dawną aplikacją, a kopia działającego klastra PostgreSQL nie jest poprawnym backupem.
Stare `Canopy Beta` / `Canopy Nightly` userData nie jest odczytywane, przenoszone ani
kasowane. Zachowaj jego kopię przy zamkniętej starej aplikacji. Dla nowej instalacji
skonfiguruj tryb i enrollment; przeniesienie danych wymaga osobnego eksportu/odtworzenia
i sprawdzenia dostępu do kluczy. Nie kopiuj w ciemno samego `secrets.enc`.

## Podpisywanie macOS i Gatekeeper

Hardened runtime jest włączony. `resources/entitlements.mac.plist` i
`entitlements.inherit.plist` nadają app/helpers/sidecarom uprawnienia JIT,
unsigned executable memory i ładowania bibliotek natywnych. Nie włączają debugowania
ani sandboxu App Store. `afterPack` wykrywa po nagłówku wszystkie Mach-O w
`Contents/Resources/runtime` i przekazuje je do `mac.binaries` przed podpisaniem:
Bun oraz natywne moduły sharp/libvips. Usługi JS, PG i CLI nie dodają kolejnych
kopii runtime do aplikacji. Symlinki wskazują na podpisane pliki; rozszerzenie i bit executable
nie decydują o wykryciu. Nic nie jest zmieniane po podpisaniu.

Pobrany PostgreSQL jest osobnym procesem potomnym, nie biblioteką ładowaną przez
hardened Bun. Jego podpis ad-hoc nie wymaga dziedziczenia Developer ID ani uprawnień
JIT aplikacji. Fetch Bun i rozpakowanie nie dodają quarantine; pliki dostają tylko
`com.apple.provenance` przypisane do Canopy. Mimo to `preparePostgres` usuwa
`com.apple.quarantine` z rozpakowanego katalogu (`xattr -dr`), bo plik z quarantine
uruchomiony bez widocznej aplikacji czeka w syspolicyd do zabicia: w teście
`postgres --version` z quarantine wisiało 180 s, a bez niego kończyło się w 3 s.
Integralność zapewnia przypięte SHA-512 sprawdzane przed rozpakowaniem, więc nie
osłabiamy kontroli pochodzenia. Canopy nie wyłącza Gatekeepera i nie zmienia polityki
systemu. Jeśli system zablokuje wykonanie, instalacja zgłasza błąd i nie publikuje runtime.
[Apple opisuje](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web)
także śledzenie pochodzenia plików zapisanych przez pobrane aplikacje. Dlatego Linux
ani sam terminal CI nie potwierdzają zachowania app z quarantine: konieczny jest
test na czystym Macu z [release.md](release.md#pierwszy-przebieg-ci-na-macos).

Z `MAC_CSC_LINK` workflow wymaga poprawnego Developer ID Application; brak certyfikatu
lub błąd signing zatrzymuje job. Pełny zestaw API key ma pierwszeństwo przed Apple ID.
Klucz `.p8` jest dekodowany w prywatnym pliku runnera i usuwany także po błędzie.
Wbudowane `mac.notarize` electron-builder wysyła app do Apple i stapluje bilet przed
utworzeniem zip/dmg. Bez kompletnego zestawu notaryzacji podpis pozostaje Developer ID,
ale app nie otrzymuje biletu. Bez certyfikatu konfiguracja jawnie używa `identity: "-"`
(podpis ad-hoc), zamiast pomijać signing.

Przypięty `@electron/notarize@2.5.0` ma lokalny patch Bun: przekazuje błąd staplera
do callbacku `promise-retry` (oryginał go nie wywołuje) i sprawdza bilet przez
`xcrun stapler validate` po każdym udanym `staple`. Maksymalnie pięć prób, odstępy
15, 30, 60 i 60 sekund. Ponawiany jest tylko stapling z walidacją; zgłoszenie
do Apple pozostaje jedno i musi zostać zaakceptowane. Wyczerpanie prób zatrzymuje
pakowanie przed utworzeniem instalatorów. Patch jest w `patches/` i `bun.lock`.

| Pobrana aplikacja z quarantine | Co zobaczy użytkownik | Aktualizacje |
| --- | --- | --- |
| Developer ID + notaryzacja + staple | zwykłe potwierdzenie aplikacji pobranej z Internetu; potem uruchomienie | włączone |
| Developer ID bez notaryzacji | ostrzeżenie, że Apple nie może sprawdzić aplikacji / braku notaryzacji; potrzebne świadome Open Anyway | włączone po uruchomieniu |
| ad-hoc | brak zaufanego dewelopera; Gatekeeper nadal blokuje, potrzebne Open Anyway lub usunięcie quarantine po sprawdzeniu źródła | „Updates need a signed build” w menu/trayu |
| stara, niepodpisana 0.1.0 | na arm64 może pojawić się „Canopy is damaged and can't be opened”; nie jest to dowód uszkodzenia pobrania | konieczna ręczna instalacja nowego wydania |

Dokładne komunikaty i możliwość użycia right-click → Open zależą od wersji macOS
i polityki urządzenia; ad-hoc nie zastępuje notaryzacji i nie gwarantuje innego tekstu
komunikatu Gatekeepera. Najpierw sprawdź źródło i `checksums.txt`. Dla zaufanego buildu
ad-hoc można użyć System Settings → Privacy & Security → Open Anyway; jeśli system
nadal pokazuje „damaged”, usuń quarantine z konkretnej zainstalowanej aplikacji:
`xattr -dr com.apple.quarantine '/Applications/Canopy.app'`
Nie wyłączaj Gatekeepera globalnie.
Procedura uzyskania certyfikatu i sekretów: [release.md](release.md#sekrety-podpisywania-desktop).

## Okno na macOS: pasek tytułu i przeciąganie

Okno ma `titleBarStyle: "hiddenInset"` i `trafficLightPosition: { x: 18, y: 18 }`:
światła siedzą w lewym górnym rogu, ich środek wypada na środku wiersza nagłówka (48 px).
Web oznacza `html[data-canopy-platform="darwin"]`; wszystkie reguły poniżej działają
tylko wtedy (`routes/layout.css`, wariant Tailwind `macos:`), web, Linux i Windows się
nie zmieniają.

`routes/layout.css` jest jednym źródłem wymiarów: `--window-titlebar-size` (48 px)
obejmuje dół świateł (około 34 px) z zapasem. `--window-safe-top` wynosi ten wymiar
podzielony przez `--window-zoom`: 48 px przy zoomie 1, 60 px przy 0,8. Zoom i
`data-window-fullscreen` pochodzą z `windowState()` / `onWindowState()` bridge'a
(`features/desktop/window-chrome.ts`); w pełnym ekranie i poza macOS safe top wynosi
0 px. Zarejestrowana właściwość CSS typu `<length>` udostępnia także obliczoną
wartość w pikselach dla pozycjonowania JS. `--window-safe-height` to pozostała
wysokość viewportu. Rezerwa nagłówków pod światła z lewej wynosi `80px / zoom`
i również znika w pełnym ekranie.

Poza sidebarem powierzchnie UI omijają obszar świateł. Dialogi (także zagnieżdżone),
Settings, drawer, paleta komend i lightbox mają górne wcięcie oraz wysokość ograniczoną
do bezpiecznego viewportu. Dotyczy to również pełnoekranowych arkuszy w wąskim oknie
desktopowym. Przesuwa się krawędź panelu, nie jego wnętrze; backdrop nadal pokrywa
całe okno. Toasty używają safe top, a baner niedostępnego gatewaya pozostaje pod
paskiem tytułu, którego wysokość uwzględnia tę samą rezerwę. Warstwa Quit i baner
aktualizacji ograniczają zawartość do bezpiecznego viewportu. Menu, popovery,
hover cards i tooltipy współdzielą `shared/ui/floating.ts`: safe top ogranicza
miejsce nad kotwicą, przesuwanie i dostępną wysokość; otwarte menu przelicza pozycję
także po zmianie zoomu lub pełnego ekranu. Nowa warstwa nad oknem powinna używać
tych samych zmiennych na swoim kontenerze, a nie dodawać pusty pasek wewnątrz panelu.

Electron liczy obszary przeciągania z prostokątów elementów z `-webkit-app-region`,
w kolejności dokumentu, **bez względu na z-index**. Właściwość się dziedziczy: każdy
potomek paska dokłada własny prostokąt, także wystający poza pasek albo przycięty
przez `overflow-hidden`. Element nad obszarem `drag`, który sam nie jest `no-drag`,
traci kliknięcia. Zasady:

- **Jeden pasek tytułu na stan okna**, oznaczony `data-window-drag`; przeciąga tylko
  jego własny prostokąt. Dekoracje wychodzące poza wiersz (tint i słoje buildu w
  `SidebarHeader`) leżą obok wiersza, nie w nim.
  - Sidebar widoczny: nagłówek sidebara (`pl` 88 px pod światła).
  - Sidebar zwinięty lub okno węższe niż `lg`: górny pasek strony
    (`data-window-titlebar`: `TopBar`, `ConversationHeader`) staje się paskiem tytułu
    i dostaje 80 px z lewej (ikona wyrównana z logo). Stan niesie `data-sidebar` na
    shellu; wcięcie animuje się razem z kolumną (`motion.css`).
  - Settings: wiersz breadcrumb i przycisku zamknięcia; cały dialog leży poniżej
    świateł, bez dodatkowego pustego paska nad wyszukiwarką. Ekran `/desktop`:
    stały pasek 48 px u góry.
- **Kontrolki w pasku** (`a`, `button`, pola, `label`, role `button`/`tab`/`menuitem`/…,
  elementy z `tabindex`) są `no-drag`; przeciąga tylko pusta przestrzeń i tekst.
- **Warstwy nad oknem** nie dodają własnych regionów `app-region` na swoich
  kontenerach: `dialog`, `[popover]` i `data-window-no-drag` (toasty, warstwa Quit).
  `windowModal` oznacza ostatnio otwarty modal przez `data-window-modal-top`;
  przeciągać mogą wyłącznie jego jawne paski, nigdy paski pod nim. Otwarcie popovera
  lub warstwy `data-window-no-drag` zawiesza wszystkie paski. Klik w backdrop nie
  łapie okna. Zamknięcie zagnieżdżonego modalu przywraca pasek poprzedniego.

Nowy pasek: daj mu `data-window-drag` (zawsze) albo `data-window-titlebar` (tylko przy
schowanym sidebarze). Nowa warstwa nad oknem poza `dialog`/`[popover]`: `data-window-no-drag`.

## Zamykanie i skrót Quit

Po rozpoczęciu zamykania main od razu chowa wszystkie okna. Proces Electron pozostaje
aktywny do zakończenia sprzątania kontrolera; zachowane są limity kontrolera (30 s)
i main (35 s). Bezstanowy lokalny BFF jest kończony od razu, równolegle z usługami:
otwarte połączenia HTTP/SSE przeglądarki nie wymagają oczekiwania na drain adapter-node.
Usługi zachowują kolejność worker → gateway → PostgreSQL. Postgres nadal dostaje
czyste fast shutdown (`SIGINT`, na Windows `pg_ctl stop -m fast`).

Worker anuluje kanał aktualizacji i przerywa oczekiwanie na reconnect. Kończy runtime
dostawców, zapisuje zatrzymanie zadań w tle, czeka do 3 s na potwierdzenie dziennika
przez gateway i dopiero potem zamyka WorkerLink. Po flush nie czeka bez końca na
odpowiedź zdalnego serwera na half-close. Niepotwierdzone zdarzenia zostają w SQLite
i są wysyłane po kolejnym starcie ([durability.md](durability.md)).

**Settings → General → Desktop app → Quit shortcut**
wybiera zachowanie `⌘Q` na macOS i `Ctrl+Q` na Linux/Windows:

- **Press twice** (domyślnie): wymagane są dwa osobne naciśnięcia w oknie krótszym
  niż **500 ms**. Po pojedynczym naciśnięciu, dopiero po upływie tego okna, pojawia
  się „Press ⌘Q twice to quit” na **2,5 s**. Późniejsze naciśnięcie rozpoczyna nowe
  okno; powtórzenia przytrzymanego klawisza nigdy go nie potwierdzają ani nie odnawiają.
- **Hold**: zamyka dopiero na powtórzeniu potwierdzającym trzymanie przez co najmniej
  **1 s**; żaden timer sam nie zamyka aplikacji. Pierwsze powtórzenie musi przyjść
  przed systemowym initial delay + 100 ms, następne przed repeat interval + 100 ms.
  Brak powtórzenia anuluje próbę i opróżnia pierścień. Szybki tap nie zamyka nawet
  wtedy, gdy żaden key-up nie dociera. Otrzymany key-up Q lub puszczenie ostatniego
  Command/Control, utrata fokusu, zamknięcie okna i nawigacja także anulują próbę.
  Przy ograniczonym ruchu zostaje statyczny skrót i „Keep holding…”, bez animacji pierścienia.
  Długi initial delay wydłuża Hold do `max(1000 ms, initial delay + repeat interval)`;
  przy Repeat Off, initial delay > 5 s, interval > 500 ms lub nieprawidłowych wartościach
  działa Press twice z komunikatem „Hold needs key repeat. Press ⌘Q twice to quit”.
- **Quit immediately**: pierwsze naciśnięcie zamyka aplikację.

Preferencja jest lokalna i wspólna dla okna głównego oraz ustawień. Main zapisuje ją
atomowo w `userData/app-shortcuts.json` (0600); nie przechodzi przez gateway.
IPC sprawdza okno nadawcy, główną ramkę i zaufany origin oraz dozwoloną wartość.
Preload udostępnia wyłącznie typowane odczyt/zapis preferencji i subskrypcje.

Na macOS `⌘Q` jest natywnym **key equivalent** menu. Punktem wejścia jest
`MenuItem.click` z `triggeredByAccelerator`; renderer może w ogóle nie dostać key-down,
a key-up Q pod Command nie jest wiarygodnym sygnałem. Jeżeli `before-input-event`
dostanie zdarzenie, przekazuje `isAutoRepeat` i blokuje ponowną obsługę przez menu.
Key-up Command jest tylko dodatkową ścieżką anulowania; guard nie zależy od niego.
Menu nie ma roli `quit`, która omijałaby zabezpieczenie. Kliknięcie „Quit Canopy”
myszą, tray Quit, shutdown/logout systemu, SIGTERM/SIGINT i restart aktualizacji
omijają guard. Bez fokusu akcelerator próbuje otworzyć okno; przy braku wiarygodnego
zdarzenia pokazuje instrukcję użycia menu zamiast zamykać w trybie chronionym.
Zamknięcie aplikacji nadal samo nie instaluje aktualizacji; tylko wybrany przez użytkownika
restart aktualizacji prowadzi po sprzątaniu do `updates.install()`.

**Rozpoznawanie powtórzeń:** Electron 45.2.1 / Chromium 156.0.8078.75 zachowuje
`NSEvent.isARepeat` w natywnych flagach, ale usuwa tę flagę podczas tworzenia obiektu
JS callbacku menu. Z samych odstępów czasowych nie da się pewnie rozróżnić drugiego
naciśnięcia od pierwszego powtórzenia. Mały adapter Node-API w
`apps/desktop/native/quit-key-event.mm` odczytuje wyłącznie `isARepeat` bieżącego
`NSApp.currentEvent`, synchronicznie podczas callbacku menu, oraz efektywne czasy
`NSEvent.keyRepeatDelay/keyRepeatInterval`. Nie zakłada monitorów wejścia, nie
odczytuje treści klawiszy i nie wymaga Accessibility/Input Monitoring.
Main odczytuje też `systemPreferences.getUserDefault("InitialKeyRepeat", "integer")`
i `("KeyRepeat", "integer")`; przeliczenie ticków po 15 ms jest ścieżką rezerwową.
Preferuje efektywne czasy AppKit, także gdy wartości defaults nie zostały zapisane.
Oficjalne API Electron dokumentuje odczyt NSUserDefaults, ale nie jednostkę tych
dwóch nieudokumentowanych kluczy; poprawność Hold nie zależy od tego przeliczenia.
Przy niedostępnym adapterze nie zgaduje flagi repeat: chroniony akcelerator pokazuje
„Use Quit Canopy from the application menu to quit”; kliknięcie menu nadal zamyka.

`build:shell` na macOS kompiluje adapter przez `xcrun clang++` (Xcode Command Line
Tools, nagłówki `node-api-headers`, stabilne Node-API v8). Pakowanie kopiuje go do
`Contents/Resources/native/quit-key-event.node`, poza ASAR, i obejmuje podpisem
Developer ID oraz kontrolą architektury. Linux/Windows nie kompilują ani nie ładują adaptera.

**Dostarczenie UI:** main wysyła `canopy:quit-guard` do okna głównego i Settings.
Bundlowany preload subskrybuje od początku i zapamiętuje ostatni stan dla późnego
`QuitGuardOverlay.onMount`. Aktualny layout web montuje overlay także na `/desktop`.
Gdy strona nie subskrybuje `onQuitGuard` z wersją overlay `1` (np. podczas błędu ładowania UI),
preload pokazuje własną wskazówkę w izolowanym Shadow DOM. Nie wymaga aktualizacji
gatewaya, sieci, zgody na powiadomienia ani poluzowania CSP; style są constructed
stylesheet. Stary, niewersjonowany overlay dostaje `cancel`, aby nie pokazywał
mylącego „press again” ani drugiej wskazówki. Po wersjonowanej subskrypcji web
fallback znika. Starszy shell ignoruje opcjonalny argument wersji. Fallback pokazuje statyczną wskazówkę
lub obracający się wskaźnik Hold i respektuje reduced motion; pełny pierścień
postępu/opróżniania jest w aktualnym web UI.

**Diagnostyka:** `userData/logs/desktop.log` zapisuje `quit-guard press`, `repeat`,
`release`, `cancel reason=…`, `timeout`, `quit`, efektywne czasy repeat oraz potwierdzenia
`feedback phase=… surface=web|shell window=main|settings`. Nie zapisuje treści
klawiszy, adresów gatewaya ani poświadczeń. Menu → Open logs folder otwiera katalog.

Źródła sprawdzone dla wersji z repozytorium:

1. [Apple: Handling Key Events](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/HandlingKeyEvents/HandlingKeyEvents.html)
   opisuje specjalną ścieżkę key equivalents i `flagsChanged:`;
   [Event Objects and Types](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/EventObjectsTypes/EventObjectsTypes.html)
   definiuje `keyRepeatDelay` i `keyRepeatInterval`.
2. [Electron 45.2.1: menu Cocoa](https://github.com/electron/electron/blob/v45.2.1/shell/browser/ui/cocoa/electron_menu_controller.mm)
   tworzy `NSMenuItem.keyEquivalent`, a `itemSelected:` przekazuje bieżące zdarzenie
   do modelu bez filtrowania powtórzeń;
   [konwerter JS](https://github.com/electron/electron/blob/v45.2.1/shell/browser/api/ui_event.cc)
   pomija repeat w obiekcie callbacku. Źródła potwierdzają ścieżkę obsługi powtórzeń;
   ich rzeczywisty strumień z klawiatury Maca wymaga próby na macOS.
3. [Chromium 156.0.8078.75: Cocoa flags](https://github.com/chromium/chromium/blob/156.0.8078.75/ui/events/cocoa/cocoa_event_utils.mm)
   mapuje `NSEvent.isARepeat` na `EF_IS_REPEAT` oraz Command `flagsChanged` na key-up;
   [widok renderera](https://github.com/chromium/chromium/blob/156.0.8078.75/content/app_shim_remote_cocoa/render_widget_host_view_cocoa.mm)
   rozdziela `performKeyEquivalent:` od zwykłego `keyDown:`. Nie traktujemy tych
   źródeł jako gwarancji dostarczenia key-up Q do `before-input-event`.
4. [Electron: before-input-event](https://github.com/electron/electron/blob/v45.2.1/docs/api/web-contents.md#event-before-input-event),
   [KeyboardEvent menu](https://github.com/electron/electron/blob/v45.2.1/docs/api/structures/keyboard-event.md)
   i [systemPreferences](https://github.com/electron/electron/blob/v45.2.1/docs/api/system-preferences.md)
   dokumentują dostępne pola i odczyt NSUserDefaults;
   [DEPS](https://github.com/electron/electron/blob/v45.2.1/DEPS) przypina Chromium.

Przed wydaniem na prawdziwym Macu, w podpisanym buildzie:

1. Hold: krótki tap ⌘Q, osobno puszczenie Q przy nadal wciśniętym Command,
   puszczenie Command, utrata fokusu i nawigacja. Każda próba ma zostać anulowana;
   ciągłe trzymanie ma zamknąć po ok. 1 s, a długi initial delay odpowiednio później.
2. Press twice: pojedyncze naciśnięcie pokazuje wskazówkę po 500 ms na 2,5 s;
   dwa naciśnięcia < 500 ms zamykają, odstęp > 500 ms tylko ponownie uzbraja.
   Trzymanie przy najszybszym repeat nigdy nie liczy się jako drugie naciśnięcie.
3. Sprawdź Repeat Off i długi delay; Hold ma wyjaśnić fallback do Press twice
   lub wymagać trzymania przez wydłużone okno. Sprawdź także domyślne ustawienia
   systemu bez ręcznie zapisanych wartości `defaults`.
4. Powtórz w oknie głównym i Settings, w local oraz remote, także z gatewayem o starszym protokole;
   sprawdź brak podwójnej wskazówki i oba rodzaje `feedback` w `desktop.log`.
5. Sprawdź Immediate, kliknięcie Quit w menu, tray Quit i restart aktualizacji;
   nie powinny wymagać potwierdzenia. Zweryfikuj ładowanie podpisanego adaptera
   (brak `native-repeat-adapter-unavailable`) i brak nowych próśb o uprawnienia OS.

Testy logiki: `bun test apps/desktop/test/quit-guard.test.ts` (wstrzykiwany zegar,
bez Electron). Opcjonalny smoke prawdziwego Electron na Linuxie, bez gatewaya,
workera i bazy: po buildzie web `bun run --filter @canopy/desktop smoke:quit`.
Używa własnego katalogu danych, BFF na losowym porcie i headless Ozone; obejmuje
`sendInputEvent` Ctrl+Q, repeat, oba okna, późną subskrypcję, fallback pod ścisłym
CSP oraz produkcyjny `QuitGuardOverlay`. `CANOPY_QUIT_SMOKE_ARTIFACTS=/ścieżka`
zachowuje zrzuty. Smoke Linux nie potwierdza natywnego menu ani adaptera macOS.

## Automatyczne aktualizacje desktopu

Trzecia ikona w stopce sidebara otwiera wspólne centrum aktualizacji. Dla własnej
aplikacji pokazuje spoczynek, sprawdzanie, postęp pobierania oraz restart po
pobraniu. Hover i kliknięcie otwierają ten sam przewijany popover (na telefonie
sheet), z historią GitHub Releases między zainstalowaną a pobieraną wersją,
najnowszą najpierw, według wybranego kanału. Sprawdzanie respektuje reduced motion.
Brak feedu platformy dla nowszego wydania jest wyjaśniony osobnym komunikatem;
nie oznacza braku nowej wersji serwera. Web bez bridge nie pokazuje sekcji własnej aplikacji.

`electron-updater` **6.8.3** sprawdza publiczne GitHub Releases przy starcie i domyślnie co
6 godzin, także po pobraniu gotowej paczki. Settings → **App updates** pozwala zmienić
częstotliwość (Never wyłącza automatyczne sprawdzanie i pobieranie) i pokazuje
wersję/kanał buildu, własny combobox Stable/Beta/Nightly, Check for updates,
procent pobierania i Restart to update. Sekcja istnieje wyłącznie przy obecności
bridge desktopu. Wybór jest atomowo zapisany w `userData/app-updates.json` przez main;
bez zapisu domyślny jest kanał zainstalowanego buildu.

**Check now** w centrum aktualizacji i **Check for updates** w ustawieniach działają
również przy stanie Ready. Najpierw sprawdzamy metadane bez automatycznego pobierania
(`autoDownload=false`), potem pobieramy tylko cel nowszy od gotowej paczki.
Brak nowszego wydania zachowuje poprzedni cel. Zgoda na downgrade przy zmianie kanału
nadal dotyczy tylko jednej próby; zmiana kanału unieważnia poprzednią gotowość w UI.

Wersję gotową do instalacji (`stagedVersion`) przechowujemy osobno od wersji aktualnie
pobieranej (`updateVersion`). Ready publikujemy dopiero po zdarzeniu `update-downloaded`
**i zakończeniu całego promise pobierania**, łącznie z zapisem cache. Podczas pobierania
wiersz pokazuje nowy cel i procent, a przycisk restartu zachowuje miejsce. Restart wybrany
w tym czasie czeka na zakończenie próby i blokuje następne sprawdzenia. Sukces instaluje
nowszą paczkę; błąd zachowuje starszą, z krótkim komunikatem i możliwością ponowienia.
Zdalny restart po idle także blokuje kolejne próby i raportuje dokładnie wybraną wersję.

Zachowanie platform wynika ze źródeł przypiętej biblioteki:

- **macOS:** `MacUpdater.updateDownloaded` zastępuje lokalny serwer proxy i feed ZIP.
  Przy naszym `autoInstallOnAppQuit=false` nie wywołuje jeszcze natywnego Squirrel.
  Kolejny ZIP może zastąpić poprzedni; dopiero `quitAndInstall` uruchamia natywne
  pobranie z aktualnego proxy, walidację podpisu i instalację. Ready oznacza plik
  w cache electron-updater, nie zakończoną walidację/staging Squirrel. Nie włączamy
  automatycznej instalacji przy zamknięciu ani nie zmieniamy flag Squirrel.
- **Windows / NSIS:** `BaseUpdater.install` i `NsisUpdater.doInstall` używają pliku
  aktualnego `DownloadedUpdateHelper`. Kolejny udany download zastępuje instalator;
  `quitAndInstall` uruchamia najnowszy zaakceptowany plik.
- **Linux / AppImage:** ten sam helper wskazuje gotowy AppImage; `doInstall` przenosi
  go na miejsce uruchomionego obrazu. Kolejny udany download może zastąpić poprzedni.
- **Linux / deb:** biblioteka ma `DebUpdater`, ale Canopy wyłącza updater bez `APPIMAGE`.
  Instalację nadal aktualizuje menedżer pakietów; popover pokazuje dotychczasowe wyjaśnienie.

Samo ponowne wywołanie biblioteki nie wystarcza do bezpiecznej podmiany:
`DownloadedUpdateHelper` usuwa wspólny `pending` przy innym SHA-512, a `executeDownload`
czyści go po błędzie/anulowaniu. Nasze adaptery używają dwóch naprzemiennych katalogów
cache (główny i `replacement`) i zachowują poprzedni helper do pełnego sukcesu.
Błąd przywraca helper i pozostawia poprzedni plik. Na macOS finalizacja cache poprzedza
podmianę proxy/feedu. Zwykłe zamknięcie i osłona Quit pozostają bez automatycznej instalacji.

Źródła dla **electron-updater 6.8.3**:
[instrukcja](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/pages/auto-update.md),
[AppUpdater](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/AppUpdater.ts),
[DownloadedUpdateHelper](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/DownloadedUpdateHelper.ts),
[MacUpdater](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/MacUpdater.ts),
[BaseUpdater](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/BaseUpdater.ts),
[NSIS](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/NsisUpdater.ts),
[AppImage](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/AppImageUpdater.ts),
[deb](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.3/packages/electron-updater/src/DebUpdater.ts).

Na podpisanym Macu sprawdź: pobierz nightly A, bez restartu udostępnij nowszy B,
użyj Check now oraz osobno Check for updates i poczekaj na Ready → B. Powtórz
z timerem ustawionym na Every hour. Podczas pobierania B wybierz Restart to update:
aplikacja ma poczekać, zamknąć usługi, przejść walidację Squirrel i uruchomić B.
Osobno przerwij pobieranie B: Ready ma wrócić do A z błędem, a restart zainstalować A.
Sprawdź też brak nowszej wersji, Cancel/zgodę na stabilniejszy kanał na kopii danych,
zwykłe Quit bez instalacji i zdalną aktualizację po idle/force. Testy na Linuxie nie
potwierdzają podpisu, rzeczywistego staging Squirrel ani restartu macOS.

W trybie zdalnym Workers gatewaya może zażądać **Update Canopy app** przez
uwierzytelniony kanał desktopu. Main zachowuje powyższy updater i kanał, odmawia
downgrade oraz czeka na idle własnego workera przed restartem. Właściciel może
jawnie wymusić restart oczekującego żądania; desktop pokazuje powiadomienie.
Postęp i wynik są widoczne zdalnie i audytowane. Szczegóły:
[updates.md](updates.md#zdalna-aktualizacja-aplikacji-desktopowej).
Tryb lokalny, także połączony jako komputer, nie obsługuje aktualizacji przez
drugi komputer w tym etapie.

Na macOS aktualizacje są włączone, gdy aplikację podpisał Developer ID (odczyt podpisującego przez
`codesign --display`). Pieczęć zasobów nie jest warunkiem: buildy do 0.2.0-nightly.7 nie ustawiały
`CANOPY_INSTALL_KIND=desktop`, więc ich worker podmieniał się wewnątrz bundla na wersję gatewaya
(`runtime/canopy-worker` + `.bak`), co łamie pieczęć. Aktualizacja i tak zastępuje cały bundle, a
Squirrel weryfikuje nowy. Od tej wersji binarka z `resources/runtime/` zawsze ma rodzaj instalacji
`desktop`, także bez zmiennej, i nigdy nie aktualizuje się sama. Buildy z wcześniejszym, błędnym
sprawdzeniem wymagania (`--test-requirement` bez `=`) nie aktualizują się wcale: trzeba raz
zainstalować nowy DMG ręcznie.

Resolver wybiera najwyższą wersję SemVer z publicznych GitHub Releases (do 1000
ostatnich), bez draftów, z feedem platformy i końcowym `manifest.json`.
Przekazuje niezmienny URL konkretnego release do generic providera electron-updater.
Nie używa zmiennego GitHub `/latest`, który nie obsługuje poprawnie nightly.

| Wybrany kanał | Dopuszczone wydania | Feed bazowy | `allowPrerelease` |
| --- | --- | --- | --- |
| Stable | stable | `latest` | false |
| Beta | stable, beta | `beta` | true |
| Nightly | stable, beta, nightly | `nightly` | true |

Stable publikuje aliasy `latest`, `beta`, `nightly`; beta `beta`, `nightly`;
nightly tylko `nightly`. Wszystkie aliasy w danym release wskazują na jeden zestaw
Canopy, nigdy na inne wydanie. Dlatego beta dostanie nowsze stable, ale nowsze beta
wygrywa ze starszym stable. Ochronę przed prerelease w Stable zapewnia resolver;
`allowPrerelease` samo nie filtruje generic feedów.

Przejście do mniej stabilnego kanału aktualizuje tylko w przód. Powrót do stabilniejszego
wymaga natywnego potwierdzenia: może zainstalować starszą wersję, dane zapisane przez
nowszą wersję mogą być nieczytelne i aplikacja może przestać działać. Po zgodzie
`allowDowngrade=true` obowiązuje tylko w sprawdzeniu/pobraniu tego przełączenia.
Po sukcesie, braku wydania lub błędzie wraca do false; nie jest zapisywane i nie przechodzi
na timer, przycisk Check ani następne uruchomienie. Po nieudanej próbie ponowna zgoda
wymaga przełączenia kanału ponownie. Kierunek przełączenia porównuje starą i nową
preferencję; przejście w stronę Nightly nigdy nie zezwala na starszą wersję, nawet gdy
zainstalowany build nadal pochodzi z Nightly. Podczas operacji wybór jest zablokowany;
późniejsza zmiana unieważnia poprzednio pobraną aktualizację w UI.

Feed to `latest-mac.yml` / `beta-mac.yml` / `nightly-mac.yml` na macOS,
odpowiednio `*-linux.yml` (ARM: `*-linux-arm64.yml`) i `latest.yml` / `beta.yml` /
`nightly.yml` na Windows. ZIP jest wymagany przez updater macOS. Workflow scala listy
plików obu architektur macOS, sprawdza SHA-512 i publikuje feedy oraz blockmapy obok
instalatorów. Alias ma ten sam hash/ZIP; manifest zachowuje `app: desktop`,
a `checksums.txt` obejmuje również feedy i blockmapy.

Pobieranie odbywa się w tle; menu/tray pokazują postęp i „Restart to update”.
Powiadomienie systemowe sygnalizuje gotowość, jeśli system je obsługuje. Restart wymaga
akcji lokalnego użytkownika albo zaakceptowanego zdalnego żądania i idle/force;
najpierw zamyka kontroler oraz usługi. Zwykłe zamknięcie nie instaluje
automatycznie aktualizacji. Trwające lokalne zadania zostaną przerwane po wybraniu restartu.
Na macOS podpis jest sprawdzany lokalnie przez codesign i wymaganie Developer ID;
build ad-hoc/unsigned nie kontaktuje się z feedem i nie publikuje własnego feedu,
więc podpisany klient nie wybierze go jako aktualizacji. Linux aktualizuje AppImage;
instalacje deb używają menedżera pakietów. Build deweloperski nie sprawdza aktualizacji.
Status błędu pozwala ponowić sprawdzenie z menu. Feed nie zawiera tokena GitHub.
Jeśli końcowa walidacja/instalacja po zatrzymaniu usług zawiedzie, aplikacja pokazuje
błąd i uruchamia ponownie bieżącą wersję zamiast zostawiać zatrzymany runtime.

Aktualizacja aplikacji nie służy do automatycznej zmiany głównej wersji PostgreSQL.
Wycofanie wadliwego wydania wymaga nowszego wydania naprawczego tego samego kanału;
aplikacja nie wykonuje rollbacku bazy. Jawny downgrade desktopu nie sprawdza zgodności
danych i nie daje gwarancji uruchomienia. Wcześniej wykonaj backup.

## Sprawdzanie runtime i paczek

`apps/desktop/test/runtime.integration.test.ts` kopiuje finalny runtime poza repo,
uruchamia rzeczywiste gateway/worker/BFF/DB na losowych portach i sprawdza
enrollment, trwałość po restarcie, WAL recovery, redakcję sekretów oraz sprzątanie
grup procesów po zamknięciu i utracie stdin kontrolera. Wymaga wcześniejszego
desktop builda; bez sidecarów test jest pomijany. Osobne integracje obejmują
SHA-512 pobieranego PostgreSQL, wznowienie HTTP, anulowanie, cache offline
i blokadę zmiany major. Tryb remote nie pobiera PostgreSQL.

`shutdown.integration.test.ts` i `worker-shutdown.test.ts` chronią ścieżkę
zamykania. Fizyczny gest Hold ⌘Q, Keychain, Gatekeeper i instalacja aktualizacji
wymagają natywnego macOS. Test paczki uruchamiaj z aktywnym sandboxem i magazynem
kluczy OS. Wykrycie CLI i worker online nie potwierdzają loginu providera.

Jedna tożsamość aplikacji i cache aktualizatora obowiązuje wszystkie kanały;
feed oraz manifest muszą zachowywać oba ZIP-y macOS i ich SHA-512. Zmiana kanału
nie może zmieniać bundle ID ani designated requirement. Starsze osobne instalacje
Canopy Beta / Canopy Nightly wymagają ręcznej instalacji zgodnie z sekcją migracji.
Podpisywanie i kontrolę wydania opisuje [release.md](release.md#pierwszy-przebieg-ci-na-macos).
