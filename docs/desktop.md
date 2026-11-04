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
2. **Baza:** pełny PostgreSQL 18.6 z binariów `@embedded-postgres`, pobieranych tylko
   po wybraniu trybu lokalnego. Aplikacja nie zawiera PostgreSQL. Pierwszy lokalny start
   wymaga internetu; gotowy cache działa offline. Nie wymaga ręcznej instalacji ani
   działającego serwera PostgreSQL na komputerze.
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
   Settings → Network access otwiera jeden listener TLS dla telefonów, połączonych komputerów i workerów
   na wszystkich interfejsach, z portem wybieranym i zapisywanym w bazie. Parowanie
   przypina certyfikat komputera; zmiany sieci odświeżają ogłaszane adresy.
   Dawny wybór interfejsu w Desktop settings został usunięty; zapisane stare ustawienia
   nie otwierają listenera HTTP. BFF i baza pozostają na loopback.
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
Grok (`grok`)** instaluje i aktualizuje użytkownik. Desktop ani żadna dystrybucja
workera nie zawiera ani nie pobiera CLI. Claude Agent SDK pozostaje biblioteką JS;
każde wywołanie otrzymuje `pathToClaudeCodeExecutable` z PATH lub konfiguracji instancji.
Brak Claude daje status „Claude Code is not installed on this computer” w istniejącym
sondowaniu providerów. Własne pliki wykonywalne, loginy i profile native są zachowane.

Preload udostępnia status, konfigurację trybu w zaufanym lokalnym ekranie,
otwarcie ustawień oraz typowane operacje i subskrypcję aktualizacji aplikacji.
Brak dostępu do plików, shella i dowolnego IPC.
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

Mapę regionów i geometrię zoomu sprawdzono w Chromium 156 z `data-canopy-platform="darwin"`;
przeciąganie i trafianie w kontrolki wymagają potwierdzenia na macOS.

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
ustawień (`/desktop?settings=1`); zapis ustawień na czas operacji pokazuje ekran startu.
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
Trzy błędy kontroli zdrowia restartują odpowiedni proces. Restart po wyjściu ma
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
app-shortcuts.json          # quitShortcut; zapis atomowy w main, bez gatewaya
postgres/data/              # pełny klaster PostgreSQL
postgres/versions/<pin>/    # zweryfikowany runtime; installed.json oznacza pełną instalację
postgres/versions/*.download/ # częściowe pobranie do wznowienia; nigdy nie służy do startu
local-worker/worker.json    # credential; 0600 na POSIX
remote-workers/<hash>/      # osobna tożsamość dla każdego gatewaya
logs/                       # redakcja sekretów; 5 MiB + 3 rotacje na usługę
```

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
Ogłoszenie sleep jest best effort: system może uśpić proces przed wysłaniem;
wtedy peer pokaże Unreachable. Implementacja i zakres etapów: [linked-computers.md](linked-computers.md).

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
dla trybu lokalnego. CLI agentów trzeba zainstalować samodzielnie.
Linux potrzebuje zwykłych bibliotek Electron i odblokowanego Secret Service/KWallet;
nie stosujemy fallbacku plaintext ani `--no-sandbox`.
Narzędzie fpm do deb potrzebuje `libcrypt.so.1` (na Arch: `libxcrypt-compat`).
Do pakowania zapewnij kilka GiB wolnego miejsca w `TMPDIR`; na tej maszynie
użyto katalogu roboczego na dysku zamiast ograniczonego tmpfs `/tmp`.

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

Adres rejestru można nadpisać tylko testowym argumentem albo
`NODE_ENV=test CANOPY_TEST_POSTGRES_REGISTRY=http://127.0.0.1:<port>/` w procesie
testowego kontrolera. Produkcyjne środowisko i konfiguracja UI nie mają takiego pola.

### Rozmiary i blokady regresji

Linux x64, Bun 1.4.4, pomiar `du -sk` rozpakowanej aplikacji, MiB (2026-11-03;
składniki zaokrąglone):

| Składnik | Przed | Po |
| --- | ---: | ---: |
| Electron i pozostały shell | 274 | 274 |
| app.asar | 49,9 | 0,6 |
| app.asar.unpacked | 57,8 | 0 |
| Bun + cztery usługi | 525,1 | 107,2 |
| runtime/node_modules | 485,5 | 19,6 |
| PostgreSQL w aplikacji | 59,8 | 0 |
| web, licencje, pozostałe | około 16 | około 16 |
| **Cała aplikacja** | **1468,2** | **417,5** |

Gotowy AppImage zmniejszył się z **586,4 MiB** (614 880 223 bajty) do
**184,0 MiB** (192 904 303 bajty). Oba pomiary pochodzą z lokalnego pakowania
Linux x64. Cel deb nie został ukończony: host nie ma `libcrypt.so.1` wymaganej przez fpm.

Pomiary etapów: sam bundling shellu **1361,1 MiB**; minimalne zależności runtime
i oczyszczony PG **1206,4 MiB**; jeden Bun **788,5 MiB**; bez CLI i PostgreSQL
**417,5 MiB**. Guard używa długości plików (bez narzutu bloków filesystemu):
aktualnie **414,2 MiB**; limity Linux 550 MiB, macOS arm64 600 MiB, Windows x64
650 MiB. `package-sizes-<target>.json` powstaje w release i jest artefaktem CI.
Guard odrzuca też app node_modules, asar.unpacked, dołączoną bazę/CLI, nieoczekiwane
zależności runtime, kopie Bun, identyczne pliki ≥8 MiB i nie-arm64 Mach-O na macOS.
Wspólny plugin kompilatora blokuje import pakietów CLI także w binarkach i Dockerze.

macOS nie został zbudowany tutaj: z pomiaru użytkownika **1,8 GiB** szacujemy
**około 380–450 MiB** aplikacji po zmianie (Framework Electron zostaje). PG i CLI
w pakiecie mają 0 MiB; Bun około 85–90 MiB, JS około 5 MiB, natywne zależności/SDK
około 20 MiB, web około 16 MiB. Osobny cache PG po deduplikacji/thinning szacujemy
na **70–110 MiB**, do pomiaru na Macu. To nie jest pomiar artefaktu macOS.

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
JIT aplikacji. Fetch Bun i rozpakowanie nie dodają quarantine; Canopy nie usuwa
quarantine, nie wyłącza Gatekeepera i nie zmienia polityki systemu. Jeśli system
zablokuje wykonanie, instalacja zgłasza błąd i nie publikuje runtime.
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

**Desktop settings → Desktop shortcuts → Quit shortcut** (również Settings → App updates)
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

`electron-updater` **6.8.3** sprawdza publiczne GitHub Releases przy starcie i co
6 godzin. Settings → **App updates** oraz lokalny ekran Desktop settings pokazują
wersję/kanał buildu, własny combobox Stable/Beta/Nightly, Check for updates,
procent pobierania i Restart to update. Sekcja istnieje wyłącznie przy obecności
bridge desktopu. Wybór jest atomowo zapisany w `userData/app-updates.json` przez main;
bez zapisu domyślny jest kanał zainstalowanego buildu.

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
akcji użytkownika i najpierw zamyka kontroler oraz usługi. Zwykłe zamknięcie nie instaluje
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

## Weryfikacja

Odchudzenie paczki i pobieranie PostgreSQL (Linux x64, 2026-11-03):
`bun install`, `gen:check`, typecheck, produkcyjny build web i pakowanie AppImage
przeszły. Pełny `check:tmp`: **687 pass, 146 skip, 0 fail**; testy desktopu/guardów:
**15 pass**, testy konfiguracji i generowania tekstu workera: **13 pass**.
Po poprawieniu katalogu raportu w fixture ponownie przeszedł izolowany
`check:tmp apps/desktop/test/packaging.test.ts` (**6 pass**, bez pozostałości).
Ekran pobierania i błędu sprawdzono w prawdziwej przeglądarce: jasny/ciemny motyw,
szerokość desktop/telefon i reduced motion. Spakowany main uruchomiono z aktywnym
sandboxem i magazynem kluczy OS. Mac, Windows i rzeczywiste tury providerów
w nowej paczce wymagają osobnej weryfikacji.

Szybkie zamykanie mierzą testy `apps/desktop/test/shutdown.integration.test.ts` i
`tests/integration/worker-shutdown.test.ts`; fizyczne puszczenie ⌘Q w trybie Hold wymaga macOS.

Aktualne dowody wyboru kanału i jednej tożsamości aplikacji:
[raport i zrzuty Chromium](../artifacts/desktop/update-channel/verification.md).

Historyczna weryfikacja podpisywania przed ujednoliceniem aplikacji (2026-11-03, Linux x64):

- `actionlint -shellcheck= .github/workflows/release.yml`, instalacja zależności,
  typecheck i `gen:check` przeszły; desktop build obejmuje także produkcyjny build web.
- Końcowy `bun run check:tmp`: **659 pass, 144 skip, 0 fail**, bez pozostawionych
  katalogów testowych. Pierwszy przebieg miał trzy błędy w niezmienionych testach
  `thread-secrets`; nie odtworzyły się w izolacji ani w drugim pełnym przebiegu.
- Powstały AppImage i deb wszystkich trzech kanałów. Metadane deb mają osobne nazwy
  `canopy`, `canopy-beta`, `canopy-nightly` (ten podział usunięto); ikony w paczkach różnią się, a stable ma
  identyczny SHA-256 jak źródłowy PNG. Gotowe shelle uruchomiono na prywatnym Xvfb
  z osobnymi katalogami danych; stable i nightly działały równolegle.
- Testy resolvera chronią granice kanałów/downgrade, scalanie feedów zachowuje oba
  zipy macOS i odrzuca błędne SHA-512; skaner znajduje także niewykonywalne pliki
  Mach-O bez rozszerzenia i biblioteki w podkatalogach.
- `electron-builder --mac --dir` na Linuxie przyjął konfigurację i utworzył layout app,
  po czym kontrola zasobów odrzuciła runtime Linux („No macOS runtime binaries found”).
  Podpisy, notaryzacja, Gatekeeper i instalacja aktualizacji wymagają macOS CI oraz
  ręcznej próby z następnego wydania; lista kontroli jest w [release.md](release.md#pierwszy-przebieg-ci-na-macos).

```sh
bun test apps/desktop/test/runtime.integration.test.ts
bun run typecheck
bun run gen:check
bun run check:tmp
```

Integracja kopiuje finalny runtime poza repozytorium, używa jednego Bun i bundli JS,
lokalnego rejestru HTTP z prawdziwym pakietem PG z node_modules, temp data dirów
i losowych portów. PG jest pobierany i weryfikowany jak u użytkownika.
Obejmuje lokalny enrollment i online przez gRPC,
zdalny enrollment do testowego gatewaya, trwałość projektu/tożsamości po restarcie,
SIGKILL serwera i WAL recovery, redakcję sekretów, brak pozostałych grup procesów
oraz zamknięcie kontrolera po utracie stdin rodzica. Nie dodano testów UI.
Osobne integracje obejmują zły SHA-512, wznowienie HTTP, anulowanie, cache offline
i blokadę zmiany major. Test remote potwierdza brak pobrania i katalogu PG.
Release CI uruchamia integracje na spakowanym runtime Linux/macOS; Windows czeka
na osobne potwierdzenie na natywnym runnerze.
Przed integracją wykonaj desktop build; przy braku sidecarów testy są pomijane,
aby zwykły checkout monorepo nie wymagał instalowania toolchainu Electron do testów backendu.

Smoke okna jest wykonywany lokalnie przez Playwright/CDP na Xvfb z aktywnym
sandboxem i prawdziwym OS keychain. Zrzuty w `artifacts/desktop/` przedstawiają
wspólny web shell w jasnym/ciemnym motywie oraz ekran pierwszego uruchomienia.
Skrypt browserowy jest roboczą weryfikacją i nie jest częścią repozytorium.
Wyniki końcowych kontroli i smoke są zapisane razem ze zrzutami.
Wykonany smoke AppImage potwierdził także zakończenie procesu Electron i czyste
zamknięcie PostgreSQL. Pełny `check:tmp`: **629 pass, 144 skip, 0 fail**, bez
pozostałych katalogów testowych. Szczegóły: [dowody weryfikacji](../artifacts/desktop/verification.md).

Nie zweryfikowano tutaj innych OS/arch, podpisywania, interfejsu sieciowego
udostępnionego innym komputerom ani rzeczywistych tur płatnych providerów. Znalezienie
CLI i obecność workera online nie potwierdzają autoryzacji konkretnego providera.

Źródła sprawdzone podczas implementacji: dokumentacja Electron
[security](https://www.electronjs.org/docs/latest/tutorial/security),
[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage),
[electron-builder](https://www.electron.build/configuration.html), rejestr npm
(Electron 45.2.1, electron-builder 26.18.0, binaria PostgreSQL 18.6.0-beta.19).

## Uprawnienia wykonania

Zakres: implementacja i lokalne commity według jawnego zlecenia, bez push/PR.
`workflow_mode: direct`, `mode_source: explicit-user-task-instruction`,
`decision_authority: delegated`, `scope: current-task`, `artifact_state: not-required`,
`execution_mode: inline`. Ograniczenia chronione: brak zmian produkcji, Tailscale,
portów 17443/17444/5180/8444 i prywatnego stacka live; brak odczytu sekretów dev-live.
