# Lokalny frontend desktopu ze zdalnym gatewayem

Status: etapy 1–2 zaimplementowane; etap 3 opisuje pierwotny plan odczytu offline,
którego aktualne zachowanie dokumentuje [desktop.md](desktop.md#prywatna-kopia-historii).
Zabezpieczenie lokalnego BFF sesją uruchomienia i współdzielony model odczytu
w pamięci BFF są zaimplementowane (2026-11-15).
Parowanie z zaproszenia jest wymagane dla starej instalacji remote bez zapisanego
poświadczenia UI (2026-11-19). Sparowany Desktop konfiguruje relay powiadomień
na zdalnym gatewayu, jeśli gateway ogłasza tę możliwość (2026-11-23).
Ręczny adres HTTPS w ustawieniach Desktopu jest trasą przypiętą do dotychczasowego
certyfikatu gatewaya i może też posłużyć do wymiany zaproszenia (2026-11-23).
Ustawienia Workers i Desktop pokazują lokalny stan workera oraz zapisany adres
gatewaya. Dostęp do edycji tego adresu działa również podczas awarii (2026-11-24).
Nowe i ponowne parowanie Desktopu odróżnia przyjęcie zaproszenia od pierwszego
uwierzytelnionego połączenia w Settings → Devices (2026-11-24).
Zdalny worker dołączony do Desktopu może odzyskać połączenie przez inną trasę
swojego sparowanego gatewaya po utracie zapisanej trasy (2026-11-24).
Opis implementacji nie określa dostępności w nightly/beta/stable; tę podają
[zasady wydań](release.md) i GitHub Releases.

Device access pokazuje datę każdego parowania desktopu i rozróżnia wpisy,
gdy platforma i wyświetlana data są identyczne (2026-11-24).

Settings → Linked computers kieruje do aplikacji na komputerze uruchamiającym gateway.
Wskazówka działa także bez połączenia z gatewayem (2026-11-25).
W aplikacji webowej i desktopowej **Settings → App updates → Status** pokazuje stan
aktualizacji sparowanego desktopu i akcję **Update Canopy app** (2026-11-25).
Nowe parowanie może przejąć nieaktywny kanał aktualizacji tej samej rejestracji
workera (2026-11-27).

## Decyzja

Desktop zawsze ładuje dołączony frontend przez swój BFF na `127.0.0.1`.
W trybie lokalnym BFF używa lokalnego tokenu usługi; w zdalnym — osobnego,
odwoływalnego poświadczenia desktopu. Nigdy nie kopiujemy tokenu usługi serwera.
Nie uruchamiamy lokalnego gatewaya ani bazy w trybie zdalnym.

Alternatywa z ładowaniem zdalnego webu uzależnia nawet ustawienia aplikacji od
łączności i wersji serwera. Tunel HTTP do zdalnego BFF zachowuje ten problem.
Poświadczenie workera nie może zastąpić poświadczenia UI: ma inny zakres i cykl
życia. Parowanie urządzenia z osobnym rodzajem `desktop` wykorzystuje istniejącą
infrastrukturę urządzeń, ale nie rozszerza uprawnień telefonów.

## Parowanie i bezpieczeństwo

1. Na gatewayu użytkownik otwiera Settings → Devices, włącza Network access
   i tworzy kod dla desktopu. Zaproszenie zawiera adresy oraz pełny SHA-256
   certyfikatu tożsamości; kod jest jednorazowy i ważny dziesięć minut.
2. Lokalny ekran desktopu przyjmuje zaproszenie. Jeśli ogłoszone adresy są
   niedostępne z tego komputera, można wpisać inny adres HTTPS tego samego
   listenera Network access. Main sprawdza pin z zaproszenia przed wysłaniem
   kodu przez TLS. Fałszywa trasa nie otrzymuje żadnego HTTP.
3. Transakcja zużywa kod i tworzy token 256-bitowy przypisany do właściciela
   gatewaya oraz rodzaju `desktop`. Baza trzyma wyłącznie hashe kodu i tokenu.
   Rodzaj zaproszenia ustala gateway podczas tworzenia; kod telefonu nie działa
   w wymianie desktopowej ani odwrotnie. Wymiana ma wspólny limit prób.
4. Electron main szyfruje token przez `safeStorage` (OS Keychain/DPAPI/Secret
   Service); `basic_text` jest zabroniony. Controller przekazuje go wyłącznie
   procesowi BFF. Renderer dostaje metadane i capabilities, nigdy token klienta
   ani token usługi. Pliki konfiguracji bez sekretów i ciphertext mają 0600.
5. Każdy RPC weryfikuje hash, właściciela i odwołanie; otwarte strumienie są
   anulowane przy odwołaniu. Settings → Devices pokazuje nazwę, platformę,
   rodzaj, ostatnie użycie i Revoke. Audyt obejmuje zaproszenie, parowanie
   i odwołanie, bez kodów i tokenów.

Potwierdzenie w oknie zaproszenia oznacza, że gateway przyjął zaproszenie
i utworzył poświadczenie. W Device access nowy wpis na liście Paired devices,
także przy ponownym parowaniu, pokazuje „Not connected yet” do pierwszego
żądania uwierzytelnionego tym poświadczeniem. „Last seen” podaje czas ostatniego
uwierzytelnionego żądania aplikacji. Parowanie aplikacji remote zapewnia dostęp
do wybranego gatewaya. Listę Linked computers tworzą osobne powiązania między
lokalnymi gatewayami desktopów ([linked-computers.md](linked-computers.md)).

Desktop otrzymuje pełny zakres UI tego samego właściciela, włącznie z administracją
urządzeń, workerów i Network access, w tym relaya powiadomień push. Zakres
odpowiada zalogowanemu web UI tego właściciela. Telefony zachowują ograniczony zakres UI;
dodatkowo nie mogą tworzyć enrollmentu ani rotować poświadczeń workera.
Nie ma parametru pozwalającego klientowi wybrać właściciela. Zapytania core/store
pozostają ograniczone do właściciela gatewaya. Nie zmieniamy sekretów dostawców
ani ich granic przechowywania.

Każde wykorzystane zaproszenie desktopowe tworzy osobne uprawnienie. Nazwa
i platforma nie identyfikują konkretnej instalacji. W Device access data
„Paired” oraz identyfikator dostępu przy zbieżnej platformie i dacie pomagają
rozróżnić uprawnienia, także po odwołaniu. „Revoke access” odwołuje wyłącznie
poświadczenie wybranego wpisu.

BFF słucha wyłącznie na loopback i wymaga `X-Canopy-Desktop-Session` z losowym
256-bitowym sekretem uruchomienia. Electron main przekazuje go kontrolerowi prywatnym
stdin; sekret pozostaje w pamięci tych procesów. Nie trafia do renderera, gatewaya,
plików, logów, URL ani magazynów przeglądarki. Jest niezależny od
poświadczenia urządzenia i tokenu usługi. Main dodaje nagłówek tylko na dokładny
origin BFF, dla własnego głównego okna i ustawień oraz ich głównej ramki, dla
wszystkich typów zasobów. Na innych celach i przekierowaniach usuwa nagłówek.
`DocumentPolicy` dodaje go bezpośrednio do własnego fetch HTML.

Listener kontrolera przed adapter-node sprawdza sekret w stałym czasie przy zgodnej
długości oraz Host/Origin i Fetch Metadata, również dla statycznych assetów, setupu,
GET, API i SSE. Usuwa nagłówek przed handlerem; odmowa daje 403 z `no-store`.
Origin i profil Chromium pozostają stałe, więc localStorage i stan workspace nie
wymagają migracji. Formularze zachowują CSRF SvelteKit. IPC wymaga własnego głównego
frame i lokalnego originu, a operacje konfiguracji — strony `/desktop`.

Jedyny wyjątek bez sekretu sesji i dla obcego origin to GET dokładnego
`/api/connectors/oauth/callback`, z kontrolą Host i nawigacji dokumentu
(`navigate`/`document`, gdy nagłówki Fetch Metadata są obecne). Gateway nadal sprawdza
jednorazowy state, binding, właściciela, konto i TTL; szczegóły w
[connectors.md](connectors.md#oauth). Pozostałe UI i API są niedostępne dla zwykłej
przeglądarki i lokalnych żądań HTTP bez sekretu. Open in new tab jest ukryte na
desktopie, a main i menu kontekstowe blokują otwarcie wewnętrznego adresu w przeglądarce.
HTTPS over Tailscale jest niedostępne dla roli `desktop`; sekret nie trafia do proxy.
Automatyczna odmowa pozostawia istniejące wpisy Serve, a sparowane połączenia
Network access działają bez zmian. Proces tego samego użytkownika zdolny odczytać
pamięć lub użyć debuggera pozostaje poza tą granicą ochrony; samo gniazdo Unix
nie daje takiej izolacji. Szczegóły: [desktop.md](desktop.md#granice-i-zgodność).

Połączenia z gatewayem nie dopuszczają wyjątków TLS, przekierowań ani TOFU.
Lista tras jest wskazówką; wszystkie trasy muszą dowieść tego samego pinu.
Trasę wybiera wyścig sond TLS; zweryfikowana trasa obsługuje kolejne RPC bez
nowych sond, bo każde nowe połączenie jej transportu i tak sprawdza pin.
Ponowny wybór następuje przed kolejnym RPC po `Unavailable` albo zamknięciu sesji
pod wywołaniem, po zmianie listy tras oraz w tle najwyżej co 30 s. Nie ponawiamy
mutacji po niejednoznacznej utracie odpowiedzi. Uwierzytelnione informacje o trasach
odświeżają listę, zachowując adres bootstrap jako fallback i niezmienny pin.
Zapisany adres HTTPS bierze udział w sondach razem z adresami ogłoszonymi przez
gateway. Zmiana adresu tego samego gatewaya używa zapisanego tokenu i pinu,
również po ponownym uruchomieniu aplikacji.

## Migracja i własny worker

Stary `desktop.json` (`gatewayUrl`, `webUrl`) jest czytelny. Startup zachowuje
stary katalog i `worker.json`; worker nadal łączy się niezależnie, również podczas
parowania UI. Przy braku zapisanego poświadczenia klient przechodzi do parowania
przez zaproszenie z Settings → Devices na docelowym gatewayu. Wcześniej sparowane
klienty zachowują odwoływalny token zapisany w systemowym magazynie kluczy.
Starsze klienty mogą pobrać trasy przez DesktopMigrationService, a próba odebrania
tokena tym RPC kieruje do zwykłego parowania. Baza zachowuje wcześniejsze
powiązania w `desktop_worker_migrations` i wpisy audytu `desktop.migrate`.
Administrator może przejrzeć historyczne urządzenia i odwołać pojedyncze tokeny
w Settings → Devices.

Nowy adres Network access i pin z zaproszenia dotyczą BFF. Startup zachowuje
adres, tożsamość i dane już istniejącego workera oraz pomija zapisany adres
starego zdalnego webu. Ręczna zmiana adresu dla BFF zachowuje też katalog profilu,
z którego Desktop odczytuje `worker.json` i zaszyfrowane poświadczenie klienta.
Zaproszenie z innym pinem wybiera profil odpowiadający nowemu gatewayowi. Jeśli
wszystkie podane adresy są już przypisane do innych profili, trzeba podać dodatkowy
adres HTTPS tego gatewaya. Zaproszenie z tym samym pinem zachowuje bieżący profil.

Nowa konfiguracja może dodatkowo przyjąć dotychczasowy token enrollmentu
workera; jego link, journal, status i aktualizacje pozostają osobnym mechanizmem.
Przy starcie kontroler przekazuje workerowi kandydatów tras z parowania i zapisany
adres Desktopu przez prywatne środowisko procesu. Worker próbuje najpierw użyć
swojego zapisanego adresu. Po błędzie dostępności WorkerLink może spróbować
alternatyw, jeśli pin Desktopu zgadza się z zapisanym pinem workera. Każda
alternatywa musi przedstawić ten certyfikat i przyjąć poświadczenie workera w
`ProbeNetworkRoute`. Jeżeli jest alternatywa, oczekiwanie na pierwszy `Welcome`
jest ograniczone do 30 s. Worker przełącza WorkerLink i UpdateService w pamięci,
zachowując własne poświadczenie, tożsamość, journal i zapisany adres na następny
start. Działające połączenie zachowuje swoją trasę.
Nie wymagamy połączenia workera do otwarcia UI. Zmiana trybu nadal restartuje
własne usługi po potwierdzeniu rzeczywistej zmiany. Zapis niezmienionego trybu
i adresów oraz powrót do Settings (przycisk lub Escape) nie zapisują konfiguracji
ani nie restartują usług. Nowe zaproszenie lub enrollment wymagają potwierdzenia.
Tryb lokalny oraz połączone komputery nie zmieniają semantyki.

## Zgodność wersji

Przed zdalnymi RPC BFF pyta o wersję gatewaya, nazwę komputera, obsługiwany zakres
protokołu klienta oraz listę metod UI. Wersje wydań są informacyjne; zgodność
wynika z `DESKTOP_CLIENT_PROTOCOL` / `MIN_DESKTOP_CLIENT_PROTOCOL` z
`packages/domain/src/release/protocol.ts` i capabilities. Etap 1 używa protokołu 1.
Ten sam protokół i obsługiwane funkcje przy różnych buildach nie pokazują banera.
Addytywne pola protobuf i nieznane capabilities są ignorowane.

- Za stary gateway lub brak handshake (`Unimplemented`): „Update Canopy on
  <gateway>”. Lokalny startup i ustawienia pozostają dostępne.
- Minimalny protokół gatewaya wyższy od desktopu: „Update this app”. Aktualizator
  aplikacji działa niezależnie od UI RPC gatewaya.
- Zgodny protokół, brak metod opcjonalnych: UI ukrywa niedostępne sekcje;
  bezpośrednie wejście i brak RPC wykryty po handshake dają czytelny stan
  aktualizacji zamiast ogólnego błędu gatewaya. Rdzeń to overview, lista wątków,
  odczyt wątku oraz ustawienia; pozostałe funkcje są bramkowane capabilities.
- Po ponownym połączeniu handshake jest odświeżany; cache metadanych ma krótki
  TTL i nie obejmuje danych użytkownika. Błędy auth i pinu nie są zgodnością.

## Offline

Start BFF i otwarcie lokalnej powłoki nie czekają na zdalny gateway. Ustawienia
desktopu, wybór trybu/kanału, quit-guard i interfejs aktualizacji działają offline
(pobieranie aktualizacji wymaga internetu). Wywołania gatewaya mają krótki deadline;
ekrany danych korzystają z istniejącego stanu „gateway unavailable”. Brak kolejki
mutacji i automatycznego odtwarzania poleceń po powrocie sieci.
**Edit gateway address** otwiera lokalny formularz wyboru trybu zarówno z ustawień,
jak i z komunikatu o niedostępnym gatewayu. Wybór adresu HTTPS dla tego samego
gatewaya używa istniejącego parowania i zachowuje osobny profil workera. Parowanie
z innym gatewayem wymaga jego zaproszenia.

BFF materializuje overview, indeks wątków i ustawienia z gRPC oraz współdzieli
wczytane projekcje i ograniczone ogony historii między oknami. Ten stan istnieje
wyłącznie w pamięci i jest usuwany przy zmianie celu gatewaya. Nie dodaje kolejki
mutacji ani trwałego trybu offline. Szczegóły: [ui-api.md](ui-api.md#współdzielone-odczyty).

Etap 1 nie utrwala rozmów ani danych projektów. Lustra połączonych komputerów
wymagają lokalnego gatewaya i bazy, więc nie dołączamy ich tylko dla cache BFF.
Osobny etap może dodać szyfrowany, ograniczony cache tylko do odczytu, z kursorem,
tombstone, czasem ostatniej synchronizacji i usuwaniem przy odwołaniu/zmianie konta.
Musi jawnie oznaczać dane nieaktualne i nigdy nie udawać wykonania mutacji offline.

## Etapy i dostarczenie

1. **Fundament i przełączenie zdalnego desktopu** — poświadczenie, parowanie,
   audyt/revoke, pinned TLS i fallback tras, lokalny BFF/frontend, migracja oraz
   handshake i degradacja podstawowych ekranów. Samodzielnie użyteczny bez cache.
   Gałąź `feat/desktop-remote-frontend-1`, podstawa `dev`.
2. **Zdalna aktualizacja całej aplikacji desktopowej** — osobna gałąź/PR na
   etapie 1. Workers zdalnego gatewaya oferuje „Update Canopy app” dla
   `installKind=desktop`, zamiast aktualizacji samej binarki workera. Żądanie
   i postęp używają istniejącego uwierzytelnionego kanału; gateway sprawdza
   właściciela i zapisuje audyt. Offline wyłącza akcję z jawnym powodem.
   Gateway nie przesyła binarek. Desktop pobiera aktualizację normalnym updaterem,
   na swoim kanale, bez downgrade i z zachowaniem macOS codesign/Developer ID
   z `apps/desktop/src/updates.ts`. Powiadomienie na desktopie informuje o żądaniu.
   Restart czeka na zakończenie tur („Will restart after the current turns”);
   zdalny właściciel może jawnie wymusić restart. Worker po restarcie zachowuje
   tożsamość. Workers pokazuje na żywo dostępną wersję, procent pobierania,
   waiting for idle, restarting oraz failed z przyczyną. Id żądania zapewnia
   deduplikację, także po zerwaniu kanału. Bez zmian zamrożonego
   `canopy.update.v1`: addytywne komendy/raporty WorkerLink lub kanał desktopu.
   Testy gateway ↔ desktop: żądanie, postęp, odmowa niepodpisanej/starszej wersji,
   idle wait, force, offline, audyt, właściciel i restart/reconnect.
   Zaimplementowane na `feat/desktop-remote-frontend-2`, na bazie etapu 1.
3. **Opcjonalny odczyt offline** — po osobnym zatwierdzeniu zasad retencji,
   szyfrowania i unieważniania; nie jest warunkiem etapu 1.

Implementacja etapu 2: osobny długotrwały strumień sterowania desktopu przez
ten sam pinned TLS, uwierzytelniony poświadczeniem desktopu. Controller przekazuje
komendę do Electron main przez prywatne IPC; tylko main wywołuje `DesktopUpdates`.
Własny worker zachowuje osobne uwierzytelnienie i nie podmienia swoich sidecarów.
Gateway wiąże urządzenie z workerem po potwierdzeniu przez oba uwierzytelnione
kanały tego samego właściciela; samo przesłanie `worker_id` ani `installKind`
nie wystarcza. Żywa sesja raportuje wersję i kanał aplikacji, możliwości updatera
oraz postęp z numerem rewizji. Workers obserwuje te dane przez overview.
Komenda zawiera id żądania i tryb restartu, nigdy URL binarki, feedu, kanał ani
zgodę na downgrade. Nie wykorzystuje lokalnego wyjątku downgrade po zmianie kanału.
Decyzję o idle podejmuje desktop na podstawie rzeczywistych bieżących tur;
osobne, audytowane force jest związane z tym samym żądaniem. Gateway zachowuje
ostatni stan do reconnect i nie przyjmuje nowego żądania dla nieaktywnej sesji.

Przy realizacji wieloetapowego planu: osobne draft PR w stosie, najniższy do `dev`,
pozostałe na poprzednich gałęziach. Wszystkie gotowe i zweryfikowane przed wspólnym
squash merge; bez częściowej promocji. Etap 2 kończy się lokalnym commitem.

## Kryteria weryfikacji

Integracja gateway ↔ klient desktopowy: jednokrotność i rodzaj kodu, właściciel,
pełny zakres desktopu i ograniczony zakres telefonu, audyt, revoke nowych
RPC i aktywnych strumieni, pin sprawdzony przed sekretami, fallback tras bez replay.
Integracja runtime: lokalny frontend/BFF, brak lokalnej bazy w remote, worker
niezależny, szyfrowany magazyn przez main, migracja i restart offline. Zgodność:
brak handshake/metody, starszy i nowszy protokół. Bez testów UI; ręczny przegląd
jasny/ciemny, desktop/telefon. Na macOS potrzebna weryfikacja Keychain,
uprawnień Local Network, podpisanej paczki, tytułu okna, zoomu i quit-guard.

## Wynik etapu 1

Migracja `0062_desktop_clients` rozróżnia zaproszenia i urządzenia mobile/desktop
i zachowuje dawne powiązania migracji w osobnej tabeli. `client-vault.ts` obsługuje
magazyn kluczy systemu w procesie Electron main.
`routed-pinned.ts` wybiera trasę przez równoległe próby TLS, zanim wyśle RPC.
`desktop-gateway.ts` w lokalnym BFF sprawdza protokół i dostępne metody.
Enrollment workera może się nie udać bez blokowania sparowanego UI; ponowienie
jest dostępne w lokalnych ustawieniach desktopu.

| Weryfikacja | Pokrycie |
|---|---|
| `tests/integration/desktop-clients.test.ts` | Jednokrotne parowanie, hash/audyt, rodzaj zaproszenia, zakres właściciela, ograniczenia telefonu, revoke streamu, zły pin, fallback, odmowa emisji poświadczenia workera, izolacja listenerów i cofnięcie dostępu przed publikacją snapshotu |
| `tests/integration/desktop-version-skew.test.ts` | Różne buildy przy zgodnym protokole, oba kierunki niezgodności, brak handshake/RPC, rdzeń działający bez funkcji opcjonalnej, brak replay mutacji |
| `apps/desktop/test/runtime.integration.test.ts` | Prawdziwy dołączony BFF/runtime, parowanie ze starej konfiguracji, zachowanie `worker.json`, origin/Host, offline, brak bazy w remote, UI bez enrollmentu workera |
| `tests/integration/network-workers.test.ts` | Istniejące enrollment, WorkerLink i UpdateService na tym samym listenerze; credential workera nadal nie autoryzuje UI |

Natywne `safeStorage`, uprawnienia Local Network, podpisana paczka i zachowanie
okna wymagają kontroli w aplikacji na docelowym systemie. Stub mostka Electron
w przeglądarce sprawdza jedynie układ i stany, bez natywnego IPC i magazynu kluczy.

## Wynik etapu 2

`DesktopControlService.Watch/Report` działa wyłącznie na Network access, przez
przypięty TLS i poświadczenie desktopu. `DesktopWorkerService.Confirm` wymaga
osobnego credentialu własnego workera i losowego identyfikatora bieżącej sesji.
Migracja `0063_desktop_updates` zapisuje powiązanie właściciela, urządzenia i workera,
ostatnią komendę oraz raport. Od 2026-11-27 nowe parowanie może zastąpić
powiązanie, gdy poprzednie urządzenie straciło dostęp lub jego potwierdzony
strumień aktualizacji się zakończył. Nowa sesja potwierdza poświadczenie tej samej
rejestracji workera i dostaje własny stan i komendę. Dostęp sparowanych urządzeń
nadal można odwołać indywidualnie. Odwołanie zamyka strumień urządzenia.
`canopy.update.v1` i protokół WorkerLink pozostają bez zmian.

Controller przekazuje komendę prywatnym stdio do main; `RemoteAppUpdate` wywołuje
istniejący `DesktopUpdates`, bez URL, wyboru kanału i zgody na downgrade w komendzie.
Aktywne lokalne przełączenie kanału blokuje zdalną próbę. Pobraną wersję sprawdzamy
ponownie jako ściśle nowszą. Natywne sprawdzanie Developer ID/codesign i Squirrel
pozostaje w normalnej ścieżce aktualizatora. Powiadomienie informuje o żądaniu.

Po pobraniu prywatne stdin workera ustawia barierę przyjmowania pracy. Aktualny
raport z PID, czasem i stanem bariery potwierdza zakończenie tur, generacji i zadań
w tle. Stan „Will restart after the current turns” pozwala właścicielowi otworzyć
dialog wymuszenia; audytowane force dotyczy konkretnego oczekującego żądania.
Desktop zatrzymuje własne usługi i instaluje aplikację normalnym updaterem, po czym
odtwarza połączenie i tożsamość workera. Worker nie podmienia sidecarów.

Lokalny plik `remote-update.json.<sha256(device_id)>` deduplikuje żądania także po
restarcie. Osiągnięcie docelowej wersji po stanie restarting raportuje sukces;
przerwana próba raportuje błąd zamiast ponawiać instalację. Nieczytelna historia
wyłącza zdalne aktualizacje bez blokowania startu aplikacji i bez nadpisania pliku.
Gateway audytuje `desktop.update.request`, `desktop.update.force` i końcowy
`desktop.update.outcome` z aktorem, id żądania, wersją oraz przyczyną wyniku.
Wersja celu żądania pozostaje osobna od najnowszej dostępnej wersji, również gdy
normalny updater po restarcie znajdzie już następne wydanie.

Klient otrzymuje przez overview oraz snapshot wersję i kanał aplikacji, dostępną
wersję, postęp pobierania, stan oczekiwania na zakończenie tur, restart i ewentualny błąd.
Brak sesji, parowania lub obsługi funkcji wyłącza akcję z powodem. Starszej aplikacji
bez strumienia nie da się odróżnić od niesparowanej: komunikat wskazuje parowanie lub ręczną aktualizację.

Podsumowanie w stopce paska bocznego prowadzi do **Settings → App updates → Status**.
Poza trwającą aktualizacją zbiorczą można tam wybrać **Update Canopy app** dla jednego
desktopu. **Update all** kolejkuje połączone, obsługiwane aplikacje z wykrytą nowszą
wersją. Po aktualizacji gatewaya mogą aktualizować się równolegle z binarnymi workerami.
Kolejka czeka na zakończenie pracy i raport sukcesu po restarcie. Własny desktop
ma w zakładce **Status** osobną akcję restartu.

**Tryb lokalny:** desktop połączony z innym gatewayem jako komputer nie otrzymuje
tego kanału sterowania. Aktualizacje między połączonymi komputerami są możliwym
późniejszym etapem, wymagającym osobnego zakresu uprawnień i protokołu.

`tests/integration/desktop-updates.test.ts` używa prawdziwego gatewaya, PostgreSQL,
parowania i pinned TLS oraz aktualizatora zastąpionego na granicy main. Pokrywa
żądanie/postęp, deduplikację, odmowę unsigned/older, idle/force, offline,
właściciela, osobne uwierzytelnienie workera, revoke/re-pair, audyt,
restart/reconnect i nieczytelną historię. Integracja dołączonego runtime sprawdza
rzeczywiste drain/resume workera. Nie dodano testów UI.

Natywne powiadomienie, podpisany upgrade i odrzucenie unsigned/older przez macOS,
instalacja Squirrel oraz restart/reconnect bundla wymagają sprawdzenia na macOS.
