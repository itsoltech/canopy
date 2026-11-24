# Canopy Desktop

Aktualizacja (2026-11-24): skrót zamykania aplikacji znajduje się w zakładce **Device** ustawień General.

Status: opis zaimplementowanego runtime i pakowania (2026-11-23). CI po pushu sprawdza
runtime i instalator Windows. Release buduje paczki dystrybucyjne i sprawdza ich podpisy.
Ekran startu, okna, zasobnik i instalatory używają osobnych ikon dla Stable, Beta,
Nightly i lokalnego Dev. Ekran startu pokazuje pełną wersję uruchomionego pakietu
Desktop przed połączeniem z gatewayem. Ikona w nagłówku sidebara ma bok 32 px przy domyślnej
skali w każdym kanale. Opis obejmuje też dzienny ping użycia z przełącznikiem
prywatności i pomijaniem wysyłki offline. Aktualizator używa
`electron-updater` 6.8.11. Build i ustawienia
udostępniają licencje dołączonych komponentów. Powłoka ładowania
korzysta z wyglądu tej instalacji także przy niedostępnym gatewayu.
Na macOS włączenie alertów o wątkach lub botach prosi o zgodę systemu.
Ustawienia Desktopu i konfiguracja połączenia są dostępne także przed
odebraniem pierwszego stanu z gatewaya.
Na Windows i Linuksie otwarte Ustawienia pozwalają przeciągać okno za jego górny pasek.
Na macOS Finder odczytuje nazwę aplikacji dla danego kanału z `InfoPlist.strings`.
Finder i Dock renderują ikony Stable, Beta i Nightly z katalogu zasobów skompilowanego
z projektów Icon Composer. Build Dev używa własnego ICNS z małymi reprezentacjami 1× i 2×.
Runner `macos-26` kompiluje ikony dla paczek wydania i testu natywnego CI.
Desktop w trybie lokalnym aktywuje relay Canopy po weryfikacji sparowanego
telefonu. Od 2026-11-23 oba tryby Desktopu pozwalają wybrać relay Canopy lub
skonfigurować własny na bieżącym gatewayu przez **Settings → Network access**.
Gateway szyfruje poświadczenie i stosuje zapis bez restartu.
[Konfiguracja relaya](deploy.md#relay-powiadomień-push).
Build przypina Electron 45.4.1,
Bun 1.4.5 i PostgreSQL 18.7 dla trybu lokalnego. Opis obejmuje też ograniczenia
prywatnej kopii aktywnego wątku przed wysłaniem jej do procesu głównego oraz przekazywania
systemowej zmiennej `OS` do instalatora Codex Standalone na Windows,
ręcznego kopiowania pełnego zaproszenia do parowania przy odmowie dostępu do schowka oraz selektywnego CI dla powłoki Electron, ponawiania
startu lokalnego gatewaya po serii nieoczekiwanych wyjść, poprawki kodowania
obrazów w gatewayu na Windows, osobnego okna stanu zamykania i restartu do aktualizacji oraz ponawiania
pakowania macOS i Windows w CI, menu ścieżek plików z rozmowy
z postępem pobierania z innych workerów i lokalnym wskazywaniem plików w Finder/Explorer,
pomijania cache przy ręcznym sprawdzaniu aktualizacji, wykrywania pojedynczego procesu przez instalator Windows
i wykluczenia własnego PID instalatora/deinstalatora z wyszukiwania i zamykania procesów,
ręcznego odzyskiwania aktualizacji Windows
i odmowy startu lokalnej bazy z uprawnieniami administratora, sesji dostępu do lokalnego BFF,
samodzielnego okna Preview automatyzacji ze zmianą rozmiaru po powiększeniu
podglądu i odzyskiwaniem po błędzie odczytu stanu wątku,
podglądu bieżącej zajętości plików Canopy w Diagnostics oraz własnego HTML w rozmowie
z odizolowanego renderera offscreen, bezpiecznego zamykania po zniszczeniu głównego okna
oraz stałego zakresu preferencji urządzenia po restarcie lokalnego gatewaya
i przeciągania okna przy widocznym przycisku „Cite”, podpowiedzi,
toaście lub komunikacie o zakończonej aktualizacji. Dyskowy cache HTTP Electron
ma budżet 64 MiB, a kontroler ustala origin formularzy osobno dla każdego żądania.
Aktualizacje Nightly mają własny feed. Updater sprawdza historię kodu każdego
kandydata przed pobraniem.
Pakowanie Desktop sprawdza, czy ikony sidebara wraz z wariantami Brotli i gzip
są identyczne z plikami z buildu web. Smoke na Windows sprawdza odpowiedzi
z BFF zainstalowanej aplikacji po aktualizacji instalacji.
Drzewo kanału uruchomionego frontendu tworzy tło górnej części sidebara.
Koronę widać za nagłówkiem i zakładkami. Przy dolnej krawędzi wyszukiwarki krycie rysunku spada do zera.
Tryb Local przypina certyfikat własnego gatewaya, używa osobnej roli PostgreSQL
i sprawdza pochodzenie żądania otwarcia pliku w aplikacji systemowej. Kreator
przenoszenia gatewaya koordynuje próbę odtworzenia, blokadę lokalnego startu,
przełączenie na Remote oraz osobne dołączenie do wspólnego serwera.
Dostępność w nightly/beta/stable określają [zasady wydań](release.md) i GitHub Releases.

Implementacja: `apps/desktop`. Cele wydania na każdym kanale: **Linux x64,
macOS arm64 i Windows x64**. Linux arm64 pozostaje eksperymentalny.
Produkt: **Canopy** — jedna instalacja z lokalnym wyborem kanału aktualizacji.

## Dzienny ping użycia

Canopy Desktop domyślnie wysyła do `https://analytics.itsol.tech/api/send` sygnał
`/ping` w Umami, najwyżej raz na dobę UTC na profil aplikacji. Służy do
szacowania liczby aktywnych instalacji i używanych wersji. Podczas pierwszej
konfiguracji lub później w **Settings → Desktop → Privacy** przełącznik
**Send daily usage ping** pozwala wyłączyć kolejne wysyłki bez restartu.
Przełącznik jest też w oknie wyboru trybu desktopu, dostępnym z ekranu
odzyskiwania nawet przy niedostępnym gatewayu.
Pierwsza próba następuje po zapisaniu konfiguracji. Przy kolejnych uruchomieniach
aplikacja próbuje wysłać ping na starcie, przy odzyskaniu fokusu głównego okna
lub po zgłoszeniu powrotu łączności w aktywnym oknie. Gdy Electron zgłasza brak
sieci, aplikacja pomija próbę. Dostępność sieci nie gwarantuje, że Umami odpowie.
Żądanie ma limit 10 s. Po błędzie następne zdarzenie może ponowić próbę po co
najmniej 15 minutach. Aplikacja nie odpytuje sieci cyklicznie.

Ping zachowuje identyfikator witryny i format istniejącego raportu Umami. Zawiera
wersję aplikacji, platformę, architekturę procesora, język aplikacji, rozmiar głównego
ekranu i standardowy nagłówek User-Agent Electrona. Canopy nie dodaje identyfikatora
użytkownika ani urządzenia, ciasteczek, poświadczeń, danych projektów ani zdarzeń
interakcji. Odbiorca widzi adres IP połączenia HTTPS. Ustawienie i data pingu
są lokalne dla profilu desktopu, wspólne dla trybów Local i Remote oraz kanałów
aktualizacji. Ping działa w pakowanej aplikacji desktopowej.

## Decyzje

Menu ścieżki w rozmowie pozwala otworzyć plik i skopiować pełną lub względną ścieżkę.
Dla pliku z innego workera `Download file` uruchamia mechanizm zapisu Electrona.
Interfejs od razu pokazuje przygotowanie pobierania. Po wybraniu miejsca zapisu
pokazuje pasek, odebrane bajty i przewidywany czas do końca, gdy zmierzy tempo.
Proces główny przekazuje do okna inicjującego pobranie tylko liczniki i stan
powiązane z identyfikatorem żądania. Dane pliku zapisuje Electron.
Ścieżki plików w rozmowie i menu `File actions` udostępniają `Reveal in Finder`
na macOS, `Reveal in Explorer` na Windows oraz `Reveal in file manager` na Linux.
Akcja działa wyłącznie w lokalnym trybie desktopu dla jego wbudowanego workera;
nie otwiera okna na komputerze zdalnego workera, sparowanego desktopu ani linked computer.
Gateway wymaga prywatnej tożsamości lokalnego BFF przy `RevealThreadFile` i
`OpenThreadFile`. Przy otwieraniu w aplikacji systemowej porównuje też workera
wątku z ID enrollmentu zgłoszonym przez kontroler desktopu na aktywnym kanale
`WatchAppControl`. Do czasu połączenia kontrolera akcja jest niedostępna.
Szczegóły kontraktu i kontroli dostępu opisuje [ui-api.md](ui-api.md#pliki-wątku).

1. **Runtime:** Electron main (Node) uruchamia kontroler Bun przez prywatne stdin/stdout
   z typowanymi komunikatami JSON. Kontroler nadzoruje PostgreSQL → gateway → enrollment
   → worker jako procesy potomne, z osobnymi grupami procesów i ograniczonym restartem
   z backoff. Na Windows kontroler i worker dziedziczą systemową zmienną `OS`,
   z której korzysta [instalator Codex Standalone](provider-cli.md#przepisy).
   Web (adapter-node SvelteKit, UI i BFF) działa **w procesie kontrolera**
   (`runtime/web.ts`), nie jako osobny proces i nigdy z gatewaya: kontroler istnieje
   w obu trybach i żyje dłużej niż gateway, więc UI z dołączonego buildu działa offline,
   w trybie remote i podczas restartu lub aktualizacji lokalnego gatewaya. Przy zamykaniu
   worker kończy pracę przed gatewayem, a gateway przed PostgreSQL; bezstanowy web zamyka
   swoje połączenia od razu. Zamknięcie stdin po śmierci Electron uruchamia sprzątanie
   kontrolera. Renderer ładuje zwykły origin HTTP i dokładnie ten sam build web, bez kopii
   komponentów. Kontroler wyłącza konfigurację `ORIGIN` i nadpisuje
   `X-Forwarded-Proto` wartością `http` po weryfikacji nagłówka `Host`. adapter-node
   wyznacza origin osobno dla każdego żądania z tego schematu i sprawdzonego
   hosta z portem (`http://127.0.0.1:<port>` okna). Dostęp do BFF wymaga sekretu
   sesji uruchomienia, sprawdzanego przed adapter-node także dla plików statycznych,
   setupu, API i SSE (szczegóły poniżej).
   Kontrola CSRF formularzy SvelteKit zostaje bez zmian. Jedyny wyjątek bez sekretu
   sesji i dla obcego origin to GET dokładnej ścieżki `/api/connectors/oauth/callback`;
   Host nadal musi się zgadzać, a obecne nagłówki Fetch Metadata muszą wskazywać
   nawigację dokumentu (`navigate`/`document`). OAuth otwiera
   przeglądarkę systemową, więc powiązanie rozpoczętej autoryzacji zostaje w procesie BFF
   (kontrolera: przetrwa restart gatewaya i zmianę trybu, nie przetrwa restartu aplikacji),
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
   Wklejanie plików tego nie potrzebuje: zdarzenie `paste` po akcji użytkownika niesie pliki
   skopiowane w systemie, bez IPC do plików ([ui-api.md](ui-api.md#wklejanie-i-upuszczanie-plików)).
   Alerty wątków i botów idą przez IPC `canopy:notification` do natywnego `Notification`
   procesu main (tylko ścieżki wątku lub bota, każdy klucz raz; [notifications.md](notifications.md));
   uprawnienie `notifications` jest rezerwą dla Notification API strony. Na macOS
   osobne, autoryzowane wywołania IPC odczytują zgodę systemu i wywołują pytanie przez
   moduł natywny `notification-permission.node` dołączony do paczki aplikacji.
   Natywne menu kontekstowe (`context-menu.ts`) daje Copy dla zaznaczenia oraz role
   Undo, Redo, Cut, Copy, Paste i Select All w polach edycji. Przy włączonym sprawdzaniu
   pisowni pokazuje propozycje poprawek. Linki mają Copy link, a zewnętrzne linki
   `http:` i `https:` także Open link in browser. Wewnętrzne adresy setupu i BFF
   nie mogą być otwierane w przeglądarce, również przez `window.open`.
   Akcja wątku Open in new tab jest ukryta na desktopie w menu i palecie poleceń.
   Własne menu renderera i chronione wartości nadal blokują menu systemowe przez
   lokalne `contextmenu.preventDefault()`.
   Nie ma dodatkowego IPC ani zmiany izolacji renderera.
   Typography korzysta najpierw z `window.queryLocalFonts()`. Uprawnienie `local-fonts`
   jest dostępne wyłącznie głównej ramce web UI; setup, iframe i obce originy nie mają
   dostępu. Jeśli API nie działa, typowany `listFonts()` wywołuje `canopy:fonts`.
   Main sprawdza nadawcę tym samym mechanizmem co inne IPC, następnie główną ramkę
   i origin aplikacji. Enumeracja nie przyjmuje argumentów od renderera: Linux używa
   `fc-list`, macOS `NSFontManager` przez systemowy JXA, Windows `InstalledFontCollection`
   przez PowerShell. Polecenia mają limit 10 s i 4 MiB wyjścia, bez shella i bez sieci.
   Wynik zawiera unikalne rodziny, bez duplikatów nazw pełnych i wariantów stylu.
2. **Baza:** pełny PostgreSQL 18.7 z binariów `@embedded-postgres`, pobieranych tylko
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
   oznaczenie beta; sam serwer PostgreSQL to wydanie 18.7. Zmiana głównej wersji wymaga
   osobnej procedury eksportu/upgrade, nie automatycznego usuwania katalogu.
3. **Dane i sekrety:** wszystko pod `app.getPath('userData')`. Klucz szyfrowania gatewaya,
   token usługi BFF → gateway oraz osobne hasła administratora bazy i roli aplikacji
   powstają raz. Przy pierwszym starcie po aktualizacji aplikacja dopisuje do
   zaszyfrowanego pliku hasło roli aplikacji, zachowując wcześniejsze poświadczenia.
   Sekret sesji Electron → BFF
   powstaje przy każdym uruchomieniu i pozostaje wyłącznie w pamięci main/kontrolera.
   Plik 0600 zawiera wyłącznie ciphertext
   asynchronicznego `safeStorage` (Keychain na macOS, DPAPI na Windows,
   Secret Service/KWallet na Linuxie). Backend
   `basic_text` jest odrzucany; aplikacja wymaga działającego magazynu kluczy.
   `worker.json` zachowuje istniejący format enrollment i uprawnienia 0600.
4. **Porty:** losowe wolne porty; Postgres, web i domyślnie gRPC na `127.0.0.1`.
   Port web jest wybierany raz i zapisywany w `web-port` w katalogu runtime, bo origin
   `http://127.0.0.1:<port>` wyznacza localStorage z preferencjami urządzenia. Zajęty
   zapisany port zastępuje nowy, również zapisany.
   Zakres preferencji lokalnego desktopu nie zależy od losowego portu gRPC gatewaya:
   ponowny start zachowuje m.in. grupowanie sidebara. Tryb zdalny nadal rozdziela
   preferencje według tożsamości sparowanego gatewaya.
   Settings → Network access otwiera jeden listener TLS dla telefonów, połączonych komputerów i workerów
   na wszystkich interfejsach, z portem wybieranym i zapisywanym w bazie. Parowanie
   przypina certyfikat komputera; zmiany sieci odświeżają ogłaszane adresy.
   Dawny wybór interfejsu w Desktop settings został usunięty; zapisane stare ustawienia
   nie otwierają listenera HTTP. BFF i baza pozostają na loopback.
   HTTPS over Tailscale jest niedostępne dla gatewaya z rolą `desktop`: gateway ani proxy
   nie dostają sekretu sesji BFF. Istniejący wpis Serve nie daje dostępu do aplikacji;
   automatyczne przejście w stan niedostępności nie zmienia tego wpisu.
   Network access i przypięte połączenia sparowanych klientów nadal działają,
   także przez Tailscale ([tailscale.md](tailscale.md#https-over-tailscale)).
5. **Pakowanie:** electron-builder, AppImage + deb na Linuxie, dmg + zip na macOS, NSIS
   na Windows x64.
   Osobny build zasobów dla każdej pary OS/arch; Bun i natywne zależności nie mogą
   pochodzić z innej architektury. Aktualizacje desktopu korzystają z electron-updater;
   nie zmieniają protokołu aktualizacji gatewaya/workera.

## Granice i zgodność

**Osobne okno Preview.** Główne okno może otworzyć samodzielny Preview bieżącego
wątku w trybie lokalnym i zdalnym. Electron dopuszcza wyłącznie trasę Preview
tego wątku na aktualnym originie BFF. Natywne okno można przenieść na drugi
monitor i zmieniać jego rozmiar także po użyciu `Expand preview`, które wypełnia
wnętrze okna. Ma własny renderer w sandboxie i nie dostaje mostka preload. Nadal
korzysta z bieżącego BFF i autoryzacji sesji wątku. Zmiana trybu lub celu
gatewaya, utrata parowania oraz zatrzymanie usług zamykają okna Preview.

**Sesja lokalnego BFF.** Electron main generuje losowy 256-bitowy sekret na każde
uruchomienie i przekazuje go kontrolerowi prywatnym stdin. `web-session.ts` dodaje
`X-Canopy-Desktop-Session` wyłącznie do żądań na dokładny origin BFF, z głównego
okna, okna ustawień lub zatwierdzonego okna Preview i ich głównych ramek. Hook obejmuje wszystkie typy zasobów;
żądania niezaufanych ramek do BFF są blokowane. Nagłówek jest usuwany przed
wysłaniem do innych celów, także przy przekierowaniach.
Przy rozpoczynaniu zamykania aplikacji main unieważnia sesję przed zatrzymaniem
kontrolera. Po nieoczekiwanym wyjściu kontrolera robi to natychmiast i odmawia IPC.
Unieważnienie zatrzymuje ładowanie własnych okien; hook blokuje kolejne żądania do BFF, a bezpośredni
fetch nie otrzymuje nagłówka, dzięki czemu przejęcie zwolnionego portu nie ujawnia sekretu.

Surowy listener HTTP kontrolera (`runtime/web-auth.ts`) sprawdza Host, Origin,
Fetch Metadata i sekret, porównywany w stałym czasie przy zgodnej długości.
Działa przed adapter-node, więc obejmuje również statyczne assety i `/desktop`.
Odmowa to 403 z `Cache-Control: no-store`; nagłówek jest usuwany przed przekazaniem
żądania handlerowi. Jedynym wyjątkiem bez sekretu jest opisany wyżej callback OAuth,
który nadal wymaga prawidłowego state i powiązania z rozpoczętym logowaniem.

Sekret sesji nie trafia do renderera, URL, cookies, localStorage, plików, logów
ani gatewaya. Jest oddzielny od trwałego tokenu usługi i poświadczenia sparowanego
klienta. Przeglądarka i lokalny klient HTTP bez sekretu nie uzyskają dostępu do UI
ani API. Origin, profil Chromium i zapisany port pozostają bez zmian; preferencje,
szkice i metadane workspace zachowują dotychczasowe magazyny i zakresy.

To ochrona przed nieuprawnionymi żądaniami HTTP, nie izolacja od procesu tego samego
użytkownika zdolnego odczytać pamięć aplikacji lub podłączyć debugger. Samo gniazdo
Unix nie usuwa tego ograniczenia. Runtime używa tego samego mechanizmu loopback
z sekretem na Linuxie, macOS i Windows.

**Połączenie z lokalnym gatewayem.** Kontroler przygotowuje samopodpisany certyfikat
dla bieżącego uruchomienia trybu Local. Prywatny katalog `local-gateway-tls` pod
`userData` zawiera certyfikat i klucz potrzebne do restartu procesu. Kontroler, BFF,
sonda gotowości i lokalny worker sprawdzają przypięty certyfikat przy połączeniu
TLS z portem gRPC. Przy następnym uruchomieniu trybu Local kontroler odnawia
certyfikat i atomowo zapisuje nowy adres, certyfikat i pin w dotychczasowym
`local-worker/worker.json`, zachowując ID, poświadczenie i katalog danych workera.
Certyfikat Network access i parowania urządzeń mają własny cykl życia.

Na początku zmiany trybu kontroler synchronicznie odłącza klienta presence i BFF.
BFF anuluje strumień `WatchOverview` poprzedniej sesji i odrzuca jej dalsze aktualizacje.
Podczas konfiguracji i po nieudanym uruchomieniu powłoka może obsłużyć ekran
ustawień bez dostępu do poprzedniego gatewaya. Zdarzenia zasilania korzystają
wyłącznie z prywatnego celu utworzonego dla działającej konfiguracji Local.

Visuals (docs/agent-visuals.md) są iframe `srcdoc` w rendererze, nie `<webview>`.
Dokument `srcdoc` dziedziczy CSP okna, więc `DocumentPolicy` dopuszcza dokładnie
hash przypiętego skryptu kitu (`KIT_SCRIPT_CSP`); inne skrypty inline pozostają
zablokowane. `frame-src 'none'` nie blokuje `srcdoc`. Ramka bez `allow-same-origin`
nie widzi preloadu, IPC ani DOM okna; `setWindowOpenHandler` i blokady nawigacji
pozostają bez zmian. Własny HTML (`render_html`) ma podgląd w rozmowie przez
canvas z klatek osobnego procesu Electron, który zachowuje prywatny profil,
odmowę sieci i DNS oraz niezależny watchdog. Główne okno przyjmuje wyłącznie
klatki i przekazuje walidowane wejście, bez wykonania HTML agenta ani zmiany CSP.
Open in window pozostaje alternatywą dla natywnej dostępności i zaznaczania tekstu;
uruchomienie jednej formy zamyka drugą. Granice i limity: [agent-visuals.md §9](agent-visuals.md#9-własny-html-render_html).

Tryb lokalny korzysta ze zwykłego `CreateWorkerEnrollment` i `enrollWorker`, zamiast
tworzyć poświadczenia bezpośrednio w bazie. Oba tryby ładują dołączony frontend
z lokalnego BFF na loopback. Tryb zdalny uruchamia tylko worker, bez gatewaya/bazy;
BFF w kontrolerze używa osobnego poświadczenia desktopu przez przypięty TLS Network access.

**Web w procesie kontrolera.** Kontroler importuje `canopy-web.js` (handler adapter-node
bez własnego listenera, `scripts/build.ts`) przy pierwszym `initialize` i obsługuje go
własnym listenerem HTTP na stałym porcie okna. Każde żądanie ma własną granicę błędu
(500 albo zamknięcie połączenia), a nieobsłużony rejection lub wyjątek z modułu web jest
logowany zamiast kończyć kontroler z nadzorowanymi usługami
(`apps/gateway/src/web/faults.ts`, `requests.ts`). Stdout kontrolera to prywatny protokół
Electronu, więc `console.*` w kontrolerze trafia do logu `web` (`logs/web.log`, to samo źródło
co wcześniej w Diagnostyce). Zmiana trybu (local ↔ remote) lub sparowanego komputera nie
restartuje web: kontroler zmienia cel BFF (`@canopy/domain/bff-target`: adres gatewaya,
token usługi, poświadczenie desktopu i trasy), BFF buduje nowego klienta gRPC, a otwarte
połączenia okna są zamykane, żeby SSE połączyło się z nowym gatewayem. Web nie ma osobnej
sondy liveness; sondowany jest tylko lokalny gateway. Pomiary (linux-x64, tryb lokalny):
web nie jest już osobnym procesem Bun (ok. 74 MB), kontroler rośnie z ok. 64 do ok. 92 MB;
UI odpowiada po ok. 130–145 ms zamiast 230–300 ms od startu kontrolera.
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
`appUpdateHistory()` (`canopy:app-update-history`) zwraca wyłącznie własną wersję,
poprzednią wersję i jednorazową flagę powiadomienia po aktualizacji.
Zapis w `userData/app-update-history.json` używa klientowego helpera preferencji
i atomowej wymiany pliku; pozostaje wspólny dla trybu lokalnego i zdalnego.
`releaseNotes()` (`canopy:release-notes`) odczytuje w main wyłącznie stały indeks
notatek Pages i zwraca zwalidowany JSON. Obie operacje sprawdzają nadawcę i origin
jak pozostały bridge, nie przyjmują URL-a, ścieżki ani danych innego komputera.
Renderer zachowuje `connect-src 'self'`. Przepływ UI opisuje [updates.md](updates.md#whats-new-po-aktualizacji).
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
Lokalny frontend ma też dostęp do wyboru kanału, sprawdzenia i restartu aktualizacji.
Main weryfikuje historię kodu przed pobraniem wydania.
Konfigurację trybu oraz odbiór tokenu
może wykonać wyłącznie lokalna strona `/desktop`.

Polityka CSP dopuszcza skrypty z wybranego originu i hashe skryptów startowych
SvelteKit, bez `unsafe-eval` i `unsafe-inline` dla skryptów. Przy przeładowaniu dokumentu
main ponownie pobiera lokalny HTML, aby policzyć hashe. `DocumentPolicy.prepare`
wykonuje fetch poza sesją Chromium, więc dodaje nagłówek sesji bezpośrednio i odrzuca
przekierowania. Okno nie ładuje zdalnego webu. Hooki CSP mają filtr
`types: ["mainFrame"]`; osobny hook `onBeforeSendHeaders` autoryzuje wszystkie typy
zasobów i usuwa prywatny nagłówek na innych originach.

Migracja 0057 dodaje rodzaj klienta i jednorazowe migracje desktopów; proto rozszerza
parowanie i handshake addytywnie. `packages/ui/desktop` jest opcjonalnym
kontraktem typów. Mobile i przeglądarka nie muszą go implementować. Root workspaces
już obejmuje `apps/*`, więc nowa aplikacja nie wymaga zmiany konfiguracji workspaces.

### Ekran startu

Ekran startu i odzyskiwania wyświetla wersję z metadanych uruchomionego pakietu
Electron, razem z sufiksem wydania Beta lub Nightly. Proces główny przekazuje
wartość do preloadu przy tworzeniu okna, więc jest dostępna przy pierwszym
renderze także offline. Przy braku wersji, w tym w uruchomieniu z kodu źródłowego,
ekran pomija cały wiersz z numerem.

### Kolory okna i paski tytułu

Pełne palety Light / Dark z Settings → Appearance obejmują też tło okna.
Main zachowuje opcjonalny `appearance-cache.json` w userData (wyłącznie nazwy
motywów i schemat), aby dobrać tło przed utworzeniem BrowserWindow. Preload
odczytuje go przez walidowane synchroniczne IPC. Przed pierwszym renderem
powłoka aplikacji oraz ekrany `/desktop` i `/desktop/migration` stosują paletę
z profilu Electron lub z pliku startowego. Zmiany w Appearance aktualizują
profil, kolory okna i plik startowy. Ustawienia właściciela z gatewaya służą
do pierwszego importu przy braku zapisu lokalnego. Błąd zapisu cache nie
blokuje zmiany kolorów.
Szczegóły kontraktu i pomiarów opisuje [appearance.md](appearance.md).

Linux i Windows używają `titleBarStyle: hidden` bez natywnego overlay. Minimize,
maximize/restore i close rysuje web (`features/desktop/WindowControls.svelte`)
tokenami palety, więc podążają za motywem i schematem jasny/ciemny. Bridge
`windowControl()` wysyła `canopy:window-control` (ta sama autoryzacja co
pozostałe IPC), a `DesktopWindowState.maximized` przełącza ikonę i etykietę.
Kontrolki leżą w DOM po aplikacji i mają `no-drag`, więc biorą kliknięcia nad
regionem przeciągania nagłówka; w pełnym ekranie są ukryte. Skalują się z zoomem,
dlatego `--window-safe-top` (48 px) i rezerwa `--window-controls-width` (7,5 rem)
nie dzielą się przez zoom. Rezerwę po prawej dostają paski przy prawej krawędzi:
nagłówki stron (`data-window-titlebar`), chyba że obok stoi otwarty panel
(`data-window-side-panel`: `xl` dla panelu wątku, `shown` dla panelu bota), oraz
górne paski paneli (`data-window-end`). Panel szczegółów wątku ma na każdej
platformie desktop pasek tytułu 48 px, więc jego treść zaczyna się pod
kontrolkami. Otwarty modal przykrywa kontrolki backdropem jak resztę okna; na
Windows 11 nie ma menu Snap Layouts przy maximize (Win+Z działa). Zmiana schematu
ustawia nativeTheme; System reaguje na preferencję systemu.

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
samego dialogu. Otwarty popover zawiesza paski, bez regionów na nakładce.
Toast w prawym dolnym rogu nie zawiesza pasków i nie deklaruje regionu.
Baner braku gatewaya jest odsunięty poniżej kontrolek okna.

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

Przed uruchomieniem gatewaya kontroler wykonuje `canopy-gateway migrate` na tej
samej bazie, także po aktualizacji starego klastra. Jednorazowy proces otrzymuje
poświadczenia administratora `canopy` i osobnego loginu `canopy_runtime`. Po jego
pomyślnym zakończeniu uruchamia się gateway z `CANOPY_MIGRATE=0` i połączeniem
roli `canopy_runtime`. Automatyczny restart procesu używa tej samej roli. Przy
błędzie migracji kontroler zatrzymuje start, a następna próba używa tej samej
bazy i tego samego zaszyfrowanego magazynu haseł.

Postgres sam sprawdza `postmaster.pid` po awarii i odtwarza WAL. Aplikacja nigdy
nie kasuje pliku PID w ciemno; konflikt z żywym serwerem kończy się błędem.
Niepełne `initdb` również zgłasza błąd zamiast usuwać istniejące dane.

### Ekran uruchamiania

Kontroler odczytuje zapisany tryb z `desktop.json` przed otwarciem pierwszego okna.
Skonfigurowana aplikacja ładuje `/desktop` jako ekran startu. Ikona pochodzi
z kanału zainstalowanej aplikacji i jest dostępna przed połączeniem z gatewayem.
Ekran pokazuje krótki status połączenia ze zdalnym hostem lub startu usług lokalnych,
a przy pobieraniu PostgreSQL także pasek postępu. Błędy udostępniają „Try again”
i „Open desktop settings”.
Jeśli PostgreSQL zgłosi odmowę pracy z uprawnieniami administratora, ekran od razu
wyjaśnia przyczynę i poleca zamknąć Canopy oraz otworzyć je bez „Run as administrator”.
Komunikat wynika z odpowiedzi procesu bazy, nie z samego braku gotowości SQL;
pozostałe przyczyny nie są przypisywane uprawnieniom administratora.
Niepoprawny plik konfiguracji również prowadzi do odzyskiwania, zamiast do pierwszego uruchomienia.
Formularz wyboru trybu pojawia się tylko bez konfiguracji albo po jawnym otwarciu
wyboru trybu (`/desktop?settings=1`). Ekran zawiera wyłącznie wybór local/remote
i pola połączenia. Aktualizacje pozostają w Settings → App updates, a skrót Quit w Settings → General → Device → Desktop app.
„Back to Settings” i Escape zamykają osobne okno wyboru, przywracając poprzedni
widok Settings bez zapisu ani przeładowania; pierwsze uruchomienie nie ma przycisku powrotu.
Zapis niezmienionych pól tylko wraca. Main i kontroler również pomijają wtedy
zapis, parowanie i restart usług. Nowe zaproszenie lub enrollment są zmianą.
Wyłącznie rzeczywista zmiana zapisanej konfiguracji pokazuje ostrzeżenie o zatrzymaniu
agentów oraz natywne potwierdzenie z domyślnym Cancel. Postęp i błąd zapisu są inline;
pierwszy start usług nadal pokazuje ekran startu.
Okno pozostaje ukryte do `ready-to-show`, a natywne tło podczas nawigacji odpowiada
zapisanemu schematowi. W trybie System podąża za wyglądem systemu.
Ekran startu ma ten sam pasek przeciągania
i `--window-safe-top` co konfiguracja; wskaźnik respektuje ograniczenie ruchu.
Zdalny web ma 3-sekundowy limit sondy dokumentu. Jeśli działa, otwiera się od razu,
a niedostępny gateway obsługuje istniejący ekran webu; jeśli sam web nie odpowiada,
lokalny ekran startu pokazuje błąd i działania naprawcze.
Komunikat o niedostępnym gatewayu i szczegóły połączenia w sidebarze otwierają
lokalną konfigurację przez **Open desktop settings**. Tę samą konfigurację otwiera
**Change desktop mode…** w menu aplikacji, niezależnie od stanu połączenia.

Procesy uruchamiają się w kolejności: baza → migracje/start gatewaya → enrollment
→ worker. Lokalny BFF (w kontrolerze) służy także jako ekran konfiguracji przed uruchomieniem bazy.
Gotowość sprawdzana jest przez SQL, gRPC i HTTP; potem co 5 sekund przez gRPC/HTTP.
Kontroler wysyła status do Electron tylko przy zmianie; każde zdarzenie przebudowuje menu
aplikacji i traya w wątku UI, który dostarcza też wejście; ten sam stan nie jest powtarzany co sekundę.
Nadzorca sprawdza liveness co 5 sekund, z limitem 5 sekund na sondę. Gateway odpowiada
anonimowym `UpdateService.Check` bez tokenu, zapytań do bazy i odpytywania połączonych
komputerów. Web działa w procesie kontrolera, więc nie ma osobnej sondy ani restartu.
`GetOverview` służy danym aplikacji, nigdy kontroli procesu.
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
jest restartowany na podstawie operacji aplikacyjnych. Po wyjściu procesu nadzorca
loguje kod lub sygnał, PID i czas działania, na Windows także pełny kod procesu
uzyskany z systemu. Lokalny gateway ponawia start z
opóźnieniem 0,5–30 sekund aż do zamknięcia aplikacji lub zmiany konfiguracji.
Po co najmniej 30 sekundach działania gatewaya następna próba wraca do 0,5 sekundy.
Początkowa konfiguracja nadal ma osobne limity gotowości. Pozostałe procesy
mają budżet 8 prób z opóźnieniem 0,5–30 sekund; kod 78 workera nie jest ponawiany.

Opóźnione zdarzenie statusu lub IPC podczas zamykania może trafić na okno, którego `WebContents`
został już zniszczony. Dostarczanie do okien sprawdza oba poziomy życia i ignoruje wyłącznie
ten wyścig, żeby zamykanie nie kończyło głównego procesu wyjątkiem Electrona.
Odczyt `WebContents` dla autoryzacji IPC, nagłówków sesji i unieważnienia sesji
pomija zniszczone okna, zanim dotknie natywnego gettera.
Zamknięcie ostatniego okna na Windows/Linux może więc
dokończyć Quit i zatrzymać usługi; martwe okno nie blokuje też żądań drugiego okna.
Callbacki nawigacji zachowują wcześniej przechwycony obiekt lub id, zamiast odczytywać
go ponownie ze zniszczonego okna.
Uruchomienie drugiej instancji w trakcie zamykania jest zapamiętywane i powoduje relaunch po
zakończeniu sprzątania, zamiast ginąć w blokadzie jednej instancji.

Zamykanie: worker → gateway → PostgreSQL, a web w kontrolerze zamyka listener i połączenia
od razu, równolegle. POSIX używa własnych grup procesów
(Postgres dostaje SIGINT, czyli fast shutdown); Windows zamyka stdin sidecarów
i wykonuje `pg_ctl stop -m fast`. Po 10 sekundach dla danej usługi następuje
wymuszone sprzątanie grupy lub `taskkill /PID <owned-pid> /T /F`. Nie ma wyszukiwania
procesów po nazwie. Kontroler otrzymuje EOF po śmierci Electron i ma 30-sekundowy
limit całego sprzątania, również podczas trwającego startu. SIGKILL całego drzewa
procesów lub awaria OS nie daje możliwości wykonania shutdown; trwałość zapewnia WAL.
Przed instalacją aktualizacji main czeka na wyjście kontrolera. Na Windows także
35-sekundowy awaryjny limit main kończy całe własne drzewo przez `taskkill /T /F`,
zamiast zabijać wyłącznie kontroler i pozostawiać procesy blokujące pliki aplikacji.

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

Settings → Diagnostics pokazuje bieżące rozmiary plików Canopy w kategoriach
logów, danych, cache, aplikacji i bazy. Lokalny gateway otrzymuje rooty przez
prywatne środowisko kontrolera; wspólny rejestr skanuje wyłącznie znane, zarządzane
wpisy katalogu danych, pomijając nieznane wpisy i projekty. Wyklucza też scratch,
worktree oraz robocze workspace botów. Dane workerów, również
zachowanych instancji zdalnych, należą do sumy desktopu; osobnych wierszy
workerów nie dodaje się ponownie. `postgres/data` jest mierzony na dysku,
bez dodatkowej sumy SQL. Wersje runtime PostgreSQL są aplikacją.

W trybie remote bundlowany worker raportuje rozmiary całej aplikacji przez
uwierzytelniony WorkerLink do wybranego gatewaya. Widzą je także klienci web/mobile
tego gatewaya i połączone komputery z dostępem do diagnostyki. Gdy taki raport
nie jest dostępny, lokalny BFF dodaje zapasowy snapshot `This desktop`, dostępny
przez tę samą sesję uruchomienia co pozostałe API, również przy niedostępnym zdalnym
gatewayu; błędy uwierzytelnienia nadal odrzucają żądanie. Samego fallbacku nie przesyła
dalej. Po nadejściu sumy aplikacji z workera zapasowy wiersz znika. Oba tryby używają
ograniczonego, asynchronicznego skanu najwyżej raz na minutę i zwracają cache bez
czekania na odczyt dysku; częściowy wynik oraz czas próbki pozostają jawne.
Szczegóły zakresu i limitów: [diagnostics.md](diagnostics.md#331-bieżąca-zajętość-plików-canopy).

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

Wake oraz zmiana sieci wymuszają nowe sesje partnerów z tymi samymi pinami; przed
zamknięciem starych sesji gateway wysyła nowe trasy. Niedostępność partnera nie blokuje
lokalnych Settings ani list. Wspólny overview zachowuje ostatnie workery, projekty i wątki;
zdalne akcje są wyłączone z powodem, a treść lustra pozostaje do czytania. BFF rozdziela
sesje lokalnych i zdalnych unary oraz lokalnych i zdalnych streamów.

Menu aplikacji otwiera ustawienia i katalog logów; tray pokazuje stan workera
i znalezione CLI. macOS używa hidden-inset z miejscem na traffic lights w sidebarze;
Linux i Windows zachowują natywną ramkę. Jedna instancja przypada na katalog danych.

Kopię zapasową katalogu danych wykonuj po zamknięciu aplikacji. `secrets.enc` jest
związany z magazynem kluczy użytkownika/OS; samo skopiowanie go na inny komputer
nie zapewnia możliwości odszyfrowania bazy sekretów gatewaya. Przed zmianą głównej
wersji PostgreSQL potrzebny jest eksport i jawna procedura migracji.

## Migracja gatewaya Local

W **Settings → Desktop** otwórz **Migrate gateway**. Operator najpierw przygotowuje
host zgodnie z [instrukcją wdrożenia](deploy.md), w tym adresy Network access
używane po przełączeniu. Podaj nazwę hosta SSH, alias z konfiguracji SSH lub
adres w formie `user@host`. Klucz hosta musi być wcześniej zaufany w OpenSSH,
a logowanie ma działać bez interakcji. Desktop używa zainstalowanych narzędzi
`psql` i `pg_dump` w wersji co najmniej takiej jak główna wersja lokalnego
PostgreSQL. Zwykły start Local nie wymaga tych narzędzi.

Próba odtworzenia działa na odizolowanej bazie po stronie celu. Przy właściwym
przełączeniu kontroler utrwala blokadę startu i czeka, aż gateway zakończy
przyjmowanie zadań i sam zamknie się po opróżnieniu pracy. Kontroler czeka
na wyjście lokalnego workera, sprawdza blokadę w PostgreSQL, wykonuje końcowy
eksport i czeka na potwierdzenie celu. Przerwana migracja jest widoczna na
ekranie startowym. Przed zatwierdzeniem można wycofać operację po potwierdzeniu
przez cel. Po zatwierdzeniu kontroler sprawdza stan celu i kontynuuje
odzyskiwanie z zatrzymanym źródłem.

Tryb Remote używa osobnego poświadczenia klienta przechowywanego przez magazyn
kluczy systemu. Worker zachowuje ID, poświadczenie, dziennik i istniejące
katalogi sesji. Klucz szyfrowania przenoszonego gatewaya jest wysyłany
przez uwierzytelnione SSH z prywatnego kontrolera. Renderer widzi stan,
czasy i publiczne adresy.

Dołączenie kolejnego Desktopu uruchamia się osobno na tym komputerze,
również gdy wróci do sieci później. Kontroler przekazuje dane należące do
gatewaya tego komputera, a przed importem użytkownik lokalnie zatwierdza
końcowy raport, rozstrzyga konflikty i zezwala na przekazanie wybranych
sekretów. Zmiana raportu wymaga ponownej zgody. Klucz szyfrowania dołączanego
gatewaya pozostaje na źródle.

## Build i uruchomienie

Wymagania środowiska budującego: Bun **1.4.5**, Node **24 lub nowszy**, natywny host
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
`CANOPY_CHANNEL` jawnie wybiera wygląd buildu. Bez tej zmiennej powłoka rozpoznaje
Stable, Beta i Nightly po `CANOPY_VERSION`; wersja deweloperska i uruchomienie
ze źródeł bez wersji mają ikonę Dev. Wydania ustawiają obie zmienne.
Przykład: `CANOPY_CHANNEL=beta CANOPY_VERSION=0.2.0-beta.1 bun run --cwd apps/desktop package:mac`.
Wynik jest w `apps/desktop/release/<kanał>/`; katalog jest ignorowany przez git.
Skrypt pakowania w razie zmiany kanału przebudowuje powłokę i zachowuje
zbudowany runtime. Ikony klienta web trafiają do paczki razem z plikami
skompresowanymi przez adapter SvelteKit, zgodnie z manifestem tego buildu.
Do zasobów Electrona skrypt kopiuje PNG wybranego kanału.
Pakowanie wydań na macOS wymaga aktywnego Xcode 26 lub nowszego, aby skompilować ikony.

| Cel | Host / przykład runnera GitHub Actions | Pakiet PG | Instalator | Weryfikacja tutaj |
| --- | --- | --- | --- | --- |
| Linux x64 | `ubuntu-24.04` | `linux-x64` | AppImage, deb | build + run AppImage |
| Linux arm64 | `ubuntu-24.04-arm` lub natywny self-hosted ARM64 | `linux-arm64` | AppImage, deb | niewykonana |
| macOS arm64 | `macos-26` (pakowanie), `macos-15` (build runtime wydania i smoke w Push CI) | `darwin-arm64` | dmg, zip | niewykonana |
| Windows x64 | `windows-2025` | `windows-x64` | NSIS `.exe` + `.blockmap`, feed kanału; Azure Trusted Signing | CI po pushu instaluje NSIS i sprawdza sidecary |

Linux x64, macOS arm64 i Windows x64 są pełnymi celami każdego kanału: nightly,
beta i stable. Linux arm64 pozostaje eksperymentalny (`continue-on-error`): beta
i stable budują go zawsze, nightly tylko z `desktop_all_targets: true`.
PR-y ze zmianami powłoki Electron lub wspólnego interfejsu web uruchamiają
[sprawdzenia dotkniętych klientów](release.md#workflowy-github-actions). Podpisany instalator
Windows buduje i weryfikuje workflow wydania (`release.yml`).
Workflow `desktop-windows.yml` uruchamiany ręcznie (`workflow_dispatch`) buduje
Windows na `windows-2025`, wymaga sekretów Azure i kontroli podpisów.
Instaluje NSIS i uruchamia zainstalowane
sidecary gateway/worker z `--version`.
Nie publikuje tagów ani wydań; artefakt Actions przechowuje przez 3 dni.

Po potwierdzeniu wyniku Push CI job `desktop-build` w Release buduje runtime dla wskazanego
SHA. Job `desktop` pakuje go akcją `.github/actions/package-desktop` z wersją i kanałem wydania,
a następnie sprawdza wymagane podpisy. Z `CANOPY_VERSION` i `CANOPY_CHANNEL` nazwy plików
to `Canopy-<wersja>-<linux|darwin|windows>-<x64|arm64>.<ext>`. macOS dostaje też `zip`.
Gotowe pliki trafiają do `apps/desktop/release/<kanał>`. Przed budową sprawdź `process.platform/process.arch`;
host musi odpowiadać wierszowi tabeli. Brak Windows arm64 jest celowy.
Runner nie potrzebuje sekretów gatewaya ani kluczy providerów. Publikowanie
wyłączono (`--publish never`). Metadata `homepage` używa identyfikatora `canopy://desktop`;
repozytorium nie deklaruje publicznej strony produktu.

W CI pakowanie macOS i Windows ma maksymalnie trzy próby z przerwami 30 i 60 sekund,
aby przetrwać przejściowe błędy podpisywania i notaryzacji Apple/Azure. Ponawiane jest
całe wywołanie `scripts/package.ts` po niezerowym kodzie wyjścia, bez analizy tekstu błędu.
Runtime buduje się raz; błąd kompilacji nie uruchamia retry. Przed ponownym pakowaniem
akcja usuwa katalog wynikowy bieżącego kanału, aby nie zachować częściowych instalatorów,
feedów ani podpisów. Cache pobrań i zbudowany runtime pozostają. Anulowanie i ostatni
błąd kończą job. Upload w Release wymaga poprawnego wyniku kontroli podpisów. Linux i lokalne
polecenia `package:*` zachowują jedną próbę. Istniejący retry staplera macOS działa
niezależnie, wewnątrz próby pakowania.

Układ zasobów jest taki sam dla każdego celu (`.exe` wyłącznie przy Bun na Windows):

```text
resources/runtime/
  canopy-controller.js
  canopy-gateway.js
  canopy-worker.js
  canopy-web.js             # handler web (UI + BFF) ładowany przez kontroler, bez osobnego procesu
  bun[.exe]
  postgres.json             # dokładna wersja, major, platforma i SHA-512 z bun.lock
  web/                      # assets identycznego adapter-node build
  node_modules/             # sdk.mjs Claude Agent SDK oraz natywne @img sharp/libvips
  licenses/
  THIRD_PARTY_NOTICES.md    # skąd pochodzą licencje środowiska natywnego
  THIRD_PARTY_NOTICES.txt   # wygenerowany wykaz tego buildu
  target.json
```

Źródło relokowalnych binariów: `@embedded-postgres/<platform-arch>`
**18.7.0-beta.19**, bazujące na dystrybucji Zonky. Wersja i integralność npm są
przypięte w `bun.lock`; podczas build wersja jest dodatkowo sprawdzana. Licencje
PostgreSQL, MIT opakowania, Apache-2.0 dystrybucji oraz odnośniki do bibliotek
zależnych dołączono do paczki. Ekran **Settings → Open-source licenses** korzysta
z wykazu lokalnego buildu także w trybie zdalnym. Informacja o plikach Electron
i Chromium jest w [notach desktopowych](../apps/desktop/THIRD_PARTY_NOTICES.md).

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

Nazwa widoczna i ikona pochodzą z metadanych zbudowanej powłoki. Stable ma nazwę
`Canopy` i zielone drzewo na jasnym tle. Beta (`Canopy (Beta)`) ma bursztynowe
tło i dwa opadające liście. Nightly (`Canopy (Nightly)`) ma fioletowe tło,
półksiężyc i gwiazdy. Lokalny Dev zachowuje nazwę `Canopy` i ma jasny obrys
drzewa na niebieskiej siatce. [Ikony aplikacji](../design/brand/README.md#ikony-aplikacji)

Lokalne uruchomienie Electron czyta PNG z `apps/web/static/channels/<kanał>/`
(dla Dev: `development`). Instalator umieszcza wybrany PNG w zasobach aplikacji
jako `icon.png` na potrzeby okien i zasobnika. Dla Stable, Beta i Nightly
Electron Builder kompiluje odpowiedni projekt `.icon` do `Assets.car` oraz ICNS.
macOS używa katalogu zasobów w Finderze i Docku, a na starszych systemach odczytuje ICNS.
Nazwa pliku ICNS zależy od zawartości projektu, aby po aktualizacji Finder mógł odczytać nową ikonę.
Spakowany Dev korzysta z własnego ICNS w Finderze. Electron ustawia ikonę Docka z PNG
w Dev i przy uruchomieniu ze źródeł.
Ekran startu otrzymuje ścieżkę ikony powłoki przez preload. Sidebar oznacza
wersję uruchomionego web buildu i używa tej samej skali nagłówka co [web](ui-api.md).
Sekcja App updates pokazuje wersję i kanał
aktualizacji samego Electrona także w trybie Remote, gdy gateway ma inną wersję.
Nowa ikona pojawia się po instalacji wybranego wydania. Aktualizator obsługuje
Stable, Beta i Nightly; dla lokalnego Dev domyślnym wyborem jest Stable.

| Platforma | Zależne od kanału | Stałe przy zmianie kanału |
|---|---|---|
| macOS | Nazwa w Finderze i Docku z `InfoPlist.strings`, ikona aplikacji, menu, About i tytuł okna | Nazwa katalogu `canopy.app`, executable, bundle ID i identyfikatory helperów |
| Windows | Nazwy skrótów NSIS, `uninstallDisplayName`, ikona ICO i tytuł okna | `productName`, katalog instalacji, appId/GUID, executable, klucze rejestru instalatora i cache aktualizacji |
| Linux | `Name` wpisu desktop, PNG i tytuł okna | `canopy.desktop`, `StartupWMClass`, nazwa pakietu deb, katalog instalacji i wzorzec `artifactName` |

Dla 16 i 32 pt w skali 1× ICNS kanału Dev używa osobnych danych RGB i maski alfa, a w skali 2×
używa PNG. Zapobiega to zniekształceniu małych ikon, które macOS może pokazać przy
odczycie PNG zapisanych w blokach `icp4` i `icp5` z bundla aplikacji. Weryfikacja
konkretnego launchera wymaga sprawdzenia zainstalowanej aplikacji na macOS.

`desktopUserData()` jawnie przypina katalog do `Canopy`, niezależnie od nazwy
widocznej. Także `app.setName()` pozostaje `Canopy`: Electron 45 używa tej wartości
do wyboru klucza Keychain na macOS i Secret Service/KWallet na Linuxie. Zmiana
wewnętrznej nazwy odcięłaby istniejące zaszyfrowane dane. W głównym `Info.plist`
`CFBundleName` wskazuje nazwę, której Electron używa do odnajdywania helperów.
Menu i panel About otrzymują osobno nazwę widoczną. NSIS odczytuje poprzednią nazwę
skrótu z rejestru i aktualizuje ją podczas instalacji; kanały nie tworzą osobnych instalacji.

Weryfikacja kontraktu: `bun test scripts/channel-identity.test.ts` sprawdza konfigurację
electron-builder i Expo, w tym stałe ścieżki, identyfikatory oraz zasoby wszystkich kanałów.
Źródła: [macOS electron-builder](https://www.electron.build/mac/),
[NSIS](https://www.electron.build/nsis/), implementacje przypiętych wersji
`app-builder-lib@26.18.0` (`AppInfo`, `createMacApp`, `MacPackager.applyCommonInfo`,
`NsisTarget`, szablon `setLinkVars`) i `electron-updater@6.8.3` (`MacUpdater`, `NsisUpdater`).
Nazwę magazynu kluczy ustala
[Electron 45.2.1](https://github.com/electron/electron/blob/v45.2.1/shell/browser/electron_browser_main_parts.cc).

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

## Podpisywanie Windows

electron-builder korzysta z Azure Trusted Signing (Artifact Signing), bez pliku
PFX. Maintainer dodaje repository secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`
i `AZURE_CLIENT_SECRET`: tenant, identyfikator aplikacji i sekret service principal
z rolą **Trusted Signing Certificate Profile Signer** na profilu `canopy` konta
ITSOL. Wartości nie są kopiowane z innego repozytorium ani zapisywane w kodzie.

Jawna konfiguracja `build.win.azureSignOptions` w `apps/desktop/package.json`:

| Pole | Wartość |
| --- | --- |
| `publisherName` | `IT SOL SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ` |
| `endpoint` | `https://plc.codesigning.azure.net/` |
| `certificateProfileName` | `canopy` |
| `codeSigningAccountName` | `ITSOL` |

Beta i stable wymagają pełnego kompletu trzech sekretów; brak któregokolwiek
kończy job Windows czytelnym błędem przed pakowaniem. Nightly używa podpisu przy
pełnym komplecie, a bez niego buduje niepodpisaną paczkę z notice w logu.
Przy próbie podpisania `forceCodeSigning` odrzuca niepodpisany wynik. Błąd Azure
nie powoduje przejścia na unsigned.

Builder podpisuje instalator i deinstalator NSIS, aplikację `canopy.exe`, helpery
Electron oraz pliki `.exe` z `extraResources`, w tym `resources/runtime/bun.exe`.
Gateway, worker, web i kontroler są bundlami JS uruchamianymi tym Bunem, a nie
osobnymi kompilowanymi `.exe`. PostgreSQL jest pobierany dopiero w trybie lokalnym
i nie jest częścią podpisywanej paczki.

Po pakowaniu workflow uruchamia `verify-windows.ps1`: instalator i wszystkie
`.exe` w `win-unpacked` muszą mieć `Get-AuthenticodeSignature.Status = Valid`
oraz dokładnie powyższego wydawcę. Kontrola obowiązuje przy każdej wymaganej lub
podjętej próbie podpisania i blokuje upload artefaktu. Podpis identyfikuje wydawcę;
wyświetlenie SmartScreen zależy też od polityk Windows i reputacji pliku.

Updater NSIS działa we wszystkich kanałach. Stable publikuje `latest.yml` i `beta.yml`,
beta publikuje `beta.yml`, a nightly publikuje `nightly.yml`.
Podpisany build zapisuje nazwę wydawcy do konfiguracji electron-updater, który
weryfikuje podpis pobranego instalatora; nie wyłączamy tej kontroli dla unsigned
nightly. Instalator ma wpis `desktop/windows/x64` w `manifest.json`, a sumy
instalatora, feedów i blockmap są w `checksums.txt`.

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
całe okno. Toasty omijają dolny i boczne safe area, a baner niedostępnego gatewaya
pozostaje pod paskiem tytułu, którego wysokość uwzględnia tę samą rezerwę. Warstwa Quit i baner
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
  jego własny prostokąt. Drzewo zajmuje osobną warstwę tła od góry sidebara do końca wyszukiwarki.
  - Sidebar widoczny: nagłówek sidebara (`pl` 88 px pod światła) zawiera ikonę i nazwę Canopy.
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
  kontenerach: `dialog`, `[popover]` i `data-window-no-drag` (np. warstwa Quit).
  `windowModal` oznacza ostatnio otwarty modal przez `data-window-modal-top`;
  przeciągać mogą wyłącznie jego jawne paski, nigdy paski pod nim. Otwarcie popovera
  lub warstwy `data-window-no-drag` zawiesza wszystkie paski. Popovery oznaczone
  `data-window-keep-drag` zachowują możliwość przeciągania. Przycisk „Cite” pojawia
  się w obszarze treści, a podpowiedzi przepuszczają zdarzenia wskaźnika.
  Klik w backdrop nie łapie okna. Zamknięcie zagnieżdżonego modalu przywraca pasek poprzedniego.

Nowy pasek: daj mu `data-window-drag` (zawsze) albo `data-window-titlebar` (tylko przy
schowanym sidebarze). Nowa warstwa nad paskami poza `dialog`/`[popover]`: `data-window-no-drag`.
Toast i komunikat „Updated to …” w dolnym rogu nie zasłaniają pasków, więc nie
dostają tego znacznika i nie wyłączają przeciągania okna
([notifications.md](notifications.md#toasty-w-aplikacji)).

### Przeciąganie okna z otwartymi Ustawieniami na Windows i Linuksie

Gdy Ustawienia są wierzchnim modalem, górny pasek po lewej od przycisków okna
zachowuje obszar przeciągania. Działa też nagłówek samych Ustawień.
Tło wraz z przyciskami okna pozostaje nieaktywne, a fokus zostaje w dialogu.
Otwarcie kolejnego modalu, zwykłego popovera lub przejście na pełny ekran wyłącza
dodatkowy obszar.

## Zamykanie i skrót Quit

`⌘W` na macOS i `Ctrl+W` na Windows/Linux zamyka aktywną kartę pliku lub modułu
workspaceu, z potwierdzeniem niezapisanych zmian. Stała karta rozmowy pozostaje
otwarta. `Ctrl+Tab` / `Ctrl+Shift+Tab` przełącza wszystkie karty, także podczas
pisania w composerze lub edytorze. Skróty można zmienić w Settings → Keybindings.
Natywna pozycja zamknięcia okna na Windows/Linux nie ma akceleratora, żeby nie
przejmowała `Ctrl+W`, również po zmianie lub usunięciu skrótu karty.

Po potwierdzeniu niezapisanych zmian main od razu chowa okna aplikacji i unieważnia sesję
BFF. Jeśli kontroler jeszcze działa, pokazuje osobne, niewielkie okno `Closing Canopy…`
z komunikatem o zapisie ostatniego stanu i zatrzymywaniu usług. Restart do aktualizacji
pokazuje `Restarting Canopy…`. Okno używa bieżącej palety, respektuje ograniczenie ruchu
i znika po zakończeniu sprzątania; zwykłe zamknięcie tego okna nie przerywa wyłączania.
Tray pokazuje ten sam stan i jedyną akcję `Show closing status`, która przywraca okno;
kliknięcie ikony również je przywraca. Spóźnione statusy nie odtwarzają zwykłego menu.
Widok jest samowystarczalnym dokumentem `data:` w osobnej, nietrwałej sesji Electron,
bez preloadu, JavaScript, sieci ani dostępu do IPC aplikacji. Nie zależy od zatrzymywanego
BFF ani jego unieważnionego sekretu. Działa również po zniszczeniu ostatniego okna
na Windows/Linux. Na macOS zamknięcie ostatniego okna bez Quit nadal pozostawia aplikację
uruchomioną i nie pokazuje stanu zamykania.
Ładowanie startowe przerwane przez Quit nie wyświetla błędu uruchomienia aplikacji.
Proces Electron pozostaje aktywny do zakończenia sprzątania kontrolera; zachowane są
limity kontrolera (30 s) i main (35 s).
Bezstanowy lokalny web w kontrolerze zamyka listener i wszystkie połączenia
od razu, równolegle z usługami: otwarte połączenia HTTP/SSE przeglądarki nie wymagają
oczekiwania na drain adapter-node.
Usługi zachowują kolejność worker → gateway → PostgreSQL. Postgres nadal dostaje
czyste fast shutdown (`SIGINT`, na Windows `pg_ctl stop -m fast`).

Worker anuluje kanał aktualizacji i przerywa oczekiwanie na reconnect. Kończy runtime
dostawców, zapisuje zatrzymanie zadań w tle, czeka do 3 s na potwierdzenie dziennika
przez gateway i dopiero potem zamyka WorkerLink. Po flush nie czeka bez końca na
odpowiedź zdalnego serwera na half-close. Niepotwierdzone zdarzenia zostają w SQLite
i są wysyłane po kolejnym starcie ([durability.md](durability.md)).

**Settings → General → Device → Desktop app → Quit shortcut**
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

Resolver Canopy czyta indeks GitHub Pages przy starcie i domyślnie co
6 godzin, także po pobraniu gotowej paczki. Settings → **App updates** pozwala zmienić
częstotliwość (Never wyłącza automatyczne sprawdzanie i pobieranie) i pokazuje
wersję/kanał buildu, własny combobox Stable/Beta/Nightly, Check for updates,
procent pobierania i Restart to update. Sekcja istnieje wyłącznie przy obecności
bridge desktopu. Wybór jest atomowo zapisany w `userData/app-updates.json` przez main;
bez zapisu domyślny jest kanał zainstalowanego buildu.

**Check now** w centrum aktualizacji i **Check for updates** w ustawieniach działają
również przy stanie Ready. Najpierw sprawdzamy metadane bez automatycznego pobierania
(`autoDownload=false`), potem pobieramy tylko cel nowszy od gotowej paczki.
Brak nowszego wydania zachowuje poprzedni cel. Zmiana kanału unieważnia poprzednią
gotowość w UI i od razu sprawdza aktualizacje w wybranym kanale.

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
  `quitAndInstall(true, true)` uruchamia najnowszy zaakceptowany plik z argumentami
  `--updated /S --force-run`. Aktualizacja nie otwiera kreatora, a po instalacji
  automatycznie uruchamia Canopy. Lokalny Restart to update i żądania z gatewaya
  lub połączonego komputera mają tę samą ścieżkę.
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
Warstwa podmiany przekazuje do biblioteki obiekt `DownloadExecutorResult` z plikiem
aktualizacji i ewentualną paczką. Publiczna metoda `downloadUpdate()` zwraca listę ścieżek.

Dokumentacja aktualizacji oraz źródła **electron-updater 6.8.11**.
[Instrukcja](https://www.electron.build/docs/features/auto-update/),
[AppUpdater](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.11/packages/electron-updater/src/AppUpdater.ts),
[DownloadedUpdateHelper](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.11/packages/electron-updater/src/DownloadedUpdateHelper.ts),
[MacUpdater](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.11/packages/electron-updater/src/MacUpdater.ts),
[BaseUpdater](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.11/packages/electron-updater/src/BaseUpdater.ts),
[NSIS](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.11/packages/electron-updater/src/NsisUpdater.ts),
[AppImage](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.11/packages/electron-updater/src/AppImageUpdater.ts),
[deb](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.11/packages/electron-updater/src/DebUpdater.ts).

**Windows — zakres i ograniczenia.** `oneClick: false`,
`allowToChangeInstallationDirectory: true` i `perMachine: false` pozostają bez zmian:
pierwsza instalacja nadal ma kreator i wybór katalogu. Cichy update nie wybiera
nowego katalogu: `assistedInstaller.nsh/initMultiUser` oraz
`multiUser.nsh/setInstallModePerUser` odczytują poprzedni `InstallLocation` z HKCU.
Instalacja dla bieżącego użytkownika nie wymaga UAC. Po wymianie plików
`installSection.nsh` uruchamia aplikację także dla instalatora assisted, gdy otrzyma
`/S --force-run`; aplikacja odtwarza usługi i połączenia.

Istniejąca instalacja dla wszystkich użytkowników może wymagać UAC:
`isAdminRightsRequired` pobranej paczki uruchamia `elevate.exe`, a assisted NSIS
sam podnosi uprawnienia przy maszynowym `InstallLocation`, również w trybie silent.
Metadane paczki per-user nie wystarczają więc do wykrycia tego przypadku.
Przed restartem sprawdzamy także maszynowy wpis NSIS w 64-bitowym rejestrze oraz
możliwość utworzenia i usunięcia katalogu w katalogu aplikacji. Wykrycie potrzeby
administratora blokuje instalację: lokalny komunikat oraz zdalny wynik `failed`
polecają zamknąć Canopy, uruchomić pobrany instalator jako administrator,
a potem otworzyć aplikację bez uprawnień administratora. Usługi nadal działają; nie zostawiamy
ukrytego instalatora oczekującego na zgodę. Aktualizację takiej instalacji wykonaj
ręcznie z uprawnieniami administratora albo zastąp ją instalacją dla bieżącego użytkownika.
Lokalny Restart to update otwiera wtedy natywny dialog „Update manually” z instrukcją
krok po kroku oraz „Show installer”. Przycisk zaznacza już pobrany, zaakceptowany
instalator w Eksploratorze; użytkownik zamyka Canopy, uruchamia ten plik przez
„Run as administrator” i po aktualizacji otwiera aplikację bez podniesionych uprawnień.
Nie musi wyszukiwać wydania ani ponownie pobierać pliku. Anulowanie dialogu zachowuje
działającą aplikację. Main wybiera plik z gotowego updatera, bez ścieżki z renderera.
Zdalna aktualizacja nadal kończy się `failed`, bez otwierania lokalnego dialogu.

NSIS `CHECK_APP_RUNNING` daje procesom czas na wyjście przy `--updated`, potem
próbuje je zamknąć; w silent ewentualne pytania mają domyślne odpowiedzi.
Gdy nie może zamknąć aplikacji, domyślnie anuluje instalację. Nie zastępuje to
naszego shutdown: worker i gateway zamykają stdin, Postgres dostaje
`pg_ctl stop -m fast`, a nadzorca czeka na zamknięcie procesów i używa
`taskkill /PID <owned-pid> /T /F` po limicie. Dopiero wyjście kontrolera uruchamia NSIS.
Przypięte `app-builder-lib` 26.18.0 ma patch w `patches/`, zarejestrowany
w `package.json` i `bun.lock`: `FIND_PROCESS` opakowuje wynik `Get-CimInstance`
w `@(...)`. Windows PowerShell 5.1 bez tego zwraca pusty `.Count` dla pojedynczego
`CimInstance`, przez co instalator przeocza ostatni proces, a deinstalator może
zakończyć wymianę zablokowanych plików kodem 2. Wyszukiwanie i zamykanie pomijają
własny PID NSIS, aby deinstalator uruchomiony z katalogu instalacji nie wykrywał
i nie kończył sam siebie. Patch obejmuje nowe instalatory
i deinstalatory; stary zainstalowany deinstalator nie jest przepisywany.
Windows smoke ponownie instaluje paczkę z jednym pozostawionym procesem Bun
z jej katalogu i sprawdza jego zakończenie oraz uruchomienie sidecarów z `--version`.
Preflight porównuje politykę PowerShell z nazwą `Restricted`; sprzątanie uruchamia
deinstalator w miejscu i zachowuje pierwotny błąd testu, jeśli deinstalacja też zawiedzie.
Przyczynę błędu konkretnej instalacji nadal trzeba potwierdzić stanem procesów
lub logiem instalatora; sam kod 2 nie identyfikuje blokującego procesu.
Zgłoszenie upstream: [electron-builder #10454](https://github.com/electron-userland/electron-builder/issues/10454).
Źródła **electron-builder 26.18.0**:
[konfiguracja NSIS](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.18.0/website/docs/nsis.md),
[tryb i poprzedni katalog](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.18.0/packages/app-builder-lib/templates/nsis/assistedInstaller.nsh),
[katalog użytkownika](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.18.0/packages/app-builder-lib/templates/nsis/multiUser.nsh),
[elevacja](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.18.0/packages/app-builder-lib/templates/nsis/installer.nsi),
[relaunch](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.18.0/packages/app-builder-lib/templates/nsis/installSection.nsh),
[kontrola procesów](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.18.0/packages/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh).

Na Windows sprawdź lokalny Restart to update i osobno aktualizację z gatewaya
oraz połączonego komputera podczas nieobecności użytkownika. W każdym przypadku
niestandardowy katalog ma pozostać bez zmian, bez kreatora i UAC dla instalacji
per-user; Canopy ma samoczynnie wrócić z nową wersją oraz działającymi usługami.
Zdalny journal ma zgłosić `succeeded` i nową wersję po reconnect. Osobno sprawdź
instalację per-machine: czytelny błąd lokalnie/zdalnie, brak UAC i restartu usług.
Testy na Linuxie nie potwierdzają działania instalatora, UAC ani restartu Windows.
Poprawka działa od wersji, która ją zawiera: starszy desktop nadal uruchamia
instalator według poprzednich reguł podczas pierwszego przejścia na tę wersję.

Na podpisanym Macu sprawdź: pobierz nightly A, bez restartu udostępnij nowszy B,
użyj Check now oraz osobno Check for updates i poczekaj na Ready → B. Powtórz
z timerem ustawionym na Every hour. Podczas pobierania B wybierz Restart to update:
aplikacja ma poczekać, zamknąć usługi, przejść walidację Squirrel i uruchomić B.
Osobno przerwij pobieranie B: Ready ma wrócić do A z błędem, a restart zainstalować A.
Sprawdź też przejście z Nightly do Beta z kodem starszym, identycznym i nowszym,
zwykłe Quit bez instalacji i zdalną aktualizację po idle/force. Testy na Linuxie nie
potwierdzają podpisu, rzeczywistego staging Squirrel ani restartu macOS.

W trybie zdalnym Workers gatewaya może zażądać **Update Canopy app** przez
uwierzytelniony kanał desktopu. Main używa bieżącego kanału oraz wymaga wyższego
SemVer do zdalnej instalacji i czeka na idle własnego workera przed restartem. Właściciel może
jawnie wymusić restart oczekującego żądania; desktop pokazuje powiadomienie.
Postęp i wynik są widoczne zdalnie i audytowane. Szczegóły:
[updates.md](updates.md#zdalna-aktualizacja-aplikacji-desktopowej).
Tryb lokalny obsługuje żądania połączonego komputera przez kanał własnego gatewaya;
obie ścieżki używają tego samego `RemoteAppUpdate` i journalu.
Ten kanał obsługuje także potwierdzone `ManageUpdates.app` od telefonu sparowanego
z tym gatewayem lub jego web/BFF. Nie wymaga nowego instalatora ani zmiany kontraktu
`canopy.update.v1`: zachowuje cichy NSIS, odmowę przy potrzebie administratora,
barierę idle, trwałe id i wynik po restarcie. Telefon nie otwiera kanału kontrolera.

Na macOS aktualizacje są włączone, gdy aplikację podpisał Developer ID (odczyt podpisującego przez
`codesign --display`). Pieczęć zasobów nie jest warunkiem: buildy do 0.2.0-nightly.7 nie ustawiały
`CANOPY_INSTALL_KIND=desktop`, więc ich worker podmieniał się wewnątrz bundla na wersję gatewaya
(`runtime/canopy-worker` + `.bak`), co łamie pieczęć. Aktualizacja i tak zastępuje cały bundle, a
Squirrel weryfikuje nowy. Od tej wersji binarka z `resources/runtime/` zawsze ma rodzaj instalacji
`desktop`, także bez zmiennej, i nigdy nie aktualizuje się sama. Buildy z wcześniejszym, błędnym
sprawdzeniem wymagania (`--test-requirement` bez `=`) nie aktualizują się wcale: trzeba raz
zainstalować nowy DMG ręcznie.

Resolver wybiera najwyższą wersję SemVer ze statycznego indeksu
`https://itsoltech.github.io/canopy/releases/v1.json`, bez draftów, z feedem platformy
i końcowym `manifest.json`. Wspólny klient metadanych ma cache 15 min, ETag i deduplikację;
sprawdzenie z połączonego komputera korzysta z tego samego klienta co lokalne.
Ręczne **Check now** w popoverze i ustawieniach, **Check for updates** w App updates,
zmiana kanału i zdalne zlecenie sprawdzenia omijają TTL cache oraz przerwę po awarii
indeksu. Wymagają walidacji przez sieć (`Cache-Control: no-cache`, z zachowaniem ETag
i obsługi `304`), a wynik uaktualnia wspólny cache. Timer nadal korzysta z cache.
Ręczna akcja dołącza do już trwającego sprawdzania lub pobierania.
Tylko awaria indeksu uruchamia fallback do REST API, z backoffem według nagłówków
limitu. UI pokazuje „Checks paused” i czas następnej próby, bez „Failed”.
Gotowy instalator zachowuje możliwość restartu. Szczegóły: [updates.md](updates.md#release-i-mirror).
Przekazuje niezmienny URL konkretnego release do generic providera electron-updater.
Nie używa zmiennego GitHub `/latest`, który nie obsługuje poprawnie nightly.

| Wybrany kanał | Dopuszczone wydania | Feed bazowy | `allowPrerelease` |
| --- | --- | --- | --- |
| Stable | stable | `latest` | false |
| Beta | stable, beta | `beta` | true |
| Nightly | nightly | `nightly` | true |

Alias `beta` w wydaniu stable wskazuje na te same instalatory co `latest`.
Beta wybiera najwyższą wersję SemVer spośród beta i stable. Nightly ignoruje
wydania stable i beta, także gdy starsze wydanie zawiera alias feedu `nightly`.
Tę samą regułę stosują notatki aktualizacji i stan publikacji.

Zmiana kanału zapisuje preferencję. Desktop może zaczekać w uruchomionym buildzie,
aż wybrany kanał opublikuje zgodne wydanie. Resolver porównuje przez GitHub commit
uruchomionego buildu z tagiem kandydata. Dopuszcza identyczny commit lub jego potomka.
Wydanie oficjalne zawiera SHA buildu do porównania po usunięciu starego tagu nightly.
Pozostałe buildy używają tagu wersji. Brak potwierdzenia historii wstrzymuje pobieranie.
Przejście z zainstalowanego Nightly do Beta może mieć niższy SemVer. W takim przypadku
electron-updater przyjmuje numer wyłącznie dla zweryfikowanego wydania beta, którego
wersja zgadza się z feedem. Pozostałe przejścia wymagają wyższego SemVer.
Podczas operacji wybór jest zablokowany. Zmiana kanału unieważnia poprzednią gotowość w UI.

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
Wycofanie wadliwego wydania wymaga nowszego wydania naprawczego tego samego kanału.
Updater zachowuje historię kodu i używa istniejącej bazy danych.

## Dyskowy cache HTTP

Desktop ustawia przed startem Electron budżet 64 MiB dla dyskowego cache HTTP
Chromium. Zwalnianiem starszych wpisów zajmuje się Chromium podczas pracy.
Prywatna kopia historii, dane profilu i pobrane aktualizacje mają osobne zasady.

## Prywatna kopia historii

Powłoka Electron utrwala ostatnie snapshoty wątków, rozmów botów i wymian
w `userData/history-v1`. Dostęp prowadzi przez wąski, typowany preload i IPC,
sprawdzający zaufane okno oraz aktywne połączenie. Katalog ma uprawnienia 0700,
pliki 0600. To dane profilu aplikacji bieżącego użytkownika systemu; nie jest
to ochrona przed innym procesem działającym jako ten sam użytkownik.

Wspólny LRU mieści 32 widoki / 96 MiB, najwyżej 16 MiB na wpis. Zapis używa
pliku tymczasowego i atomowego rename. Odczyt odrzuca uszkodzone i nieznane
pola protobuf. Przechowujemy publiczne projekcje, bez wartości sekretów,
tokenów, poświadczeń konektorów i konfiguracji providerów. Zwykła treść rozmowy
pozostaje prywatnymi danymi użytkownika.

Przed pierwszym watchem renderer odczytuje kopię i wysyła jej trwały kursor.
Zmiana trybu lub unpair/revocation usuwa katalog i pamięć; fence generacji
odrzuca spóźnione zapisy poprzedniej sesji. Zmiana wersji aplikacji sama nie
czyści historii. Zwykły web pozostaje wyłącznie w pamięci SPA: bez preloadu
nie zapisuje treści w IndexedDB, localStorage ani na serwerze BFF.
Podczas pracy w wątku renderer zapisuje jego ostatnie wpisy i kursor synchronizacji
najwyżej raz na dwie sekundy. Dopiero w chwili zapisu wybiera ogon historii
przez `threadCacheTail` (do 128 wpisów osi, z budżetem 384 KiB na wpisy i powiązane
steery), koduje go i wysyła przez IPC. Doczytane strony pozostają w pamięci widoku.
Po restarcie starsze strony są dostępne z gatewaya. W rozmowach botów starsze strony
powiększają zapisane okno razem z jego checkpointem. Odświeżenie listy botów usuwa
z dysku także nieotwarte wpisy botów usuniętych, zarchiwizowanych lub przeniesionych.

## Sprawdzanie runtime i paczek

`apps/desktop/test/runtime.integration.test.ts` kopiuje finalny runtime poza repo,
uruchamia rzeczywiste gateway/worker/DB na losowych portach (web w procesie testu
albo kontrolera) i sprawdza enrollment, trwałość po restarcie, WAL recovery, redakcję
sekretów, odpowiedzi UI podczas restartu gatewaya, to, że logi BFF trafiają do `web.log`,
a nie na stdout kontrolera, oraz sprzątanie grup procesów po zamknięciu i utracie stdin
kontrolera. Wymaga wcześniejszego
desktop builda; bez sidecarów test jest pomijany. Osobne integracje obejmują
SHA-512 pobieranego PostgreSQL, wznowienie HTTP, anulowanie, cache offline
i blokadę zmiany major. Tryb remote nie pobiera PostgreSQL.

`shutdown.integration.test.ts` i `worker-shutdown.test.ts` chronią ścieżkę
zamykania. Fizyczny gest Hold ⌘Q, Keychain, Gatekeeper i instalacja aktualizacji
wymagają natywnego macOS. Test paczki uruchamiaj z aktywnym sandboxem i magazynem
kluczy OS. Wykrycie CLI i worker online nie potwierdzają loginu providera.
Windows smoke uruchamia test kodowania obrazów Bunem z zainstalowanej paczki.
Sprawdza poprawny obraz oraz systemowy limit zapisu pliku wyjściowego kodera.

Jedna tożsamość aplikacji i cache aktualizatora obowiązuje wszystkie kanały;
feed oraz manifest muszą zachowywać oba ZIP-y macOS i ich SHA-512. Zmiana kanału
nie może zmieniać bundle ID ani designated requirement. Starsze osobne instalacje
Canopy Beta / Canopy Nightly wymagają ręcznej instalacji zgodnie z sekcją migracji.
Podpisywanie i kontrolę wydania opisuje [release.md](release.md#pierwszy-przebieg-ci-na-macos).
