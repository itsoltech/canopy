# Canopy na iOS i Android

Zwinięty kompozytor wątku pokazuje ikony z licznikami załączników i rodzajów
wzmianek przed pierwszą, skróconą linią szkicu. Cytaty są tokenami w tekście, bez
osobnego licznika. Dotknięcie podsumowania lub tekstu
rozwija nakładkę i ustawia fokus w polu. Pełne chipy pozostają zamontowane w zwijanym
obszarze; rezerwa osi czasu nie zależy od ich liczby ani stanu rozwinięcia.

Pierwsza wersja to **development build** Expo, nie Expo Go ani Expo web.
Identyfikatory: iOS `tech.itsol.canopy-remote`, Android `tech.itsol.canopy_remote` (Android nie dopuszcza myślnika w identyfikatorze); scheme: `canopy`.
Konfiguracja: `apps/mobile/app.json`, `app.config.ts`, `eas.json`.

Po OTA lub aktualizacji sklepowej zamykana karta „Updated to …” otwiera
„What's new” z zakresem poprzedniej i bieżącej wersji bundla. Historia jest lokalna
dla instalacji i pozostaje po zmianie parowania. Settings → App updates i Updates
otwierają ten sam arkusz. Notatki oraz podgląd notatek dostępnego OTA czytają
wyłącznie statyczny JSON Pages, bez API GitHuba. Implementacja jest wyłącznie JS,
bez nowych modułów, konfiguracji natywnej lub wejść fingerprintu; [updates.md](updates.md#whats-new-po-aktualizacji).

Natywna nazwa oraz ikony zależą od kanału: `Canopy (Nightly)`, `Canopy (Beta)` albo
`Canopy` (stable). `app.config.ts` wybiera kanał z `CANOPY_CHANNEL`, następnie profilu
`EAS_BUILD_PROFILE`, a na końcu wersji w `canopy-version.json` (lokalny development
domyślnie stable). Każdy profil wydania EAS przekazuje własny `CANOPY_CHANNEL`;
rozszerzające profile beta/stable jawnie nadpisują nightly. Publikacja OTA bez profilu
rozpoznaje kanał z przygotowanej wersji, więc fingerprint zgadza się z natywnym buildem.
Nie zmieniamy bundle ID, nazwy pakietu Androida ani `canopy://`.

Ikona iOS jest pełnym kwadratem RGB PNG 1024 px, bez kanału alfa, ramki, fazowania
i połysku. Samo drzewo zajmuje 70% szerokości, lekko powyżej środka; maskę nakłada iOS.
Android ma osobny foreground mieszczący się w kole 66 dp na płótnie 108 dp,
pomniejszony o dodatkowe 14%, aby pozostawić co najmniej 8% średnicy widocznej maski
między drzewem a jej krawędzią. Ma pełne tło sceny oraz monochromatyczną sylwetkę
dla ikon tematycznych Androida 13+.
Księżyc/słońce i gwiazdy mają osobne pozycje dla masek launcherów.
Splash pokazuje samo drzewo na kolorze kanału, również w trybie ciemnym.
**Nazwa, ikony launchera i splash wymagają nowego buildu natywnego. OTA ich nie zmienia.**
Konfiguracja natywna oraz assety wpływają na fingerprint; stare IPA/APK pozostają ze
starą tożsamością do instalacji nowej binarki. Publiczną konfigurację można sprawdzić
w `apps/mobile` przez `CANOPY_CHANNEL=nightly bunx expo config --type public`.

## Transport: czy React Native obsługuje gRPC?

W otwartym wątku pliki zajmują lokalne zakładki obok `Thread`. Nagłówek zawiera
sygnet projektu, skrócony tytuł oraz przycisk aktywnej karty z arkuszem Switch tab.
Arkusz obsługuje Keep tab, Move up/down i zamykanie z potwierdzeniem szkicu.
Jeden czysty preview można zastąpić kolejnym plikiem; Edit utrwala go przed edycją.
Android Back wraca do `Thread` bez zamykania karty. Rozmowa i composer zachowują
stan podczas czytania pliku. Metadane maks. 12 kart na wątek / 30 wątków / 256 KiB
są lokalne dla parowania; szkice i zawartość nie trafiają do pliku metadanych.
Cache czystych plików ma limit 8 MiB, suma baz i szkiców 4 MiB.
Najwyżej dwa czyste pliki pozostają rozgrzane; pozostałe zachowują metadane do
ponownego odczytu. Unpair i odwołanie dostępu czyszczą dokumenty, tokeny i streamy,
również przy późnej odpowiedzi rozpoczętego zapisu. Zmiana korzenia zachowuje szkic
do jawnego skopiowania lub porzucenia; nie nadpisuje pliku w nowym worktree.

Viewer zachowuje Markdown/source, kopiowanie i obrazy. Source jest oknem linii
z numerami, pozycją i zakresem z linku lub Go to line. Powrót do karty przywraca
zapamiętany offset dopiero po
ukończeniu indeksowania i pomiarze listy. Nowy link do linii ma pierwszeństwo;
zdarzenia przewijania podczas przygotowania listy nie nadpisują starego offsetu.
Bardzo długie linie dzieli na fragmenty do 4096 znaków bez utraty treści i par
surogatów, pod tym samym numerem.
Edycja pozostaje natywnym polem tekstowym bez kolorów podczas pisania. Tokenizacja
viewera i Preview changes korzysta z ograniczonych okien tokenów z workera.
Nie dodajemy modułu natywnego. Link pliku z izolowanego transkryptu przechodzi do
workspace'u właściwego wątku; załączniki i bloby zachowują swoje viewery.

`+` obok przełącznika kart otwiera moduły Files, Pull requests, Tasks i Connectors w pełnej
karcie bieżącego wątku. Modules otwiera arkusz minimalnego modułu z wyborem,
Open in tab i Close module. Szczegóły wątku mają osobny arkusz; otwarcie jednego
zamyka drugi. Nie ma dokowanego panelu na telefonie. Wybrany moduł i karty są
metadanymi urządzenia, a otwartość arkuszy jest przejściowa.

Lista PR przenosi się do modułu Pull requests; w podsumowaniu pozostaje skrót
najnowszego PR. Pełna karta zachowuje Summary/Timeline/Code i istniejące akcje,
a przygotowanie kontekstu/cytowanie wybiera Thread i aktualizuje jego szkic bez
zmiany trasy. Tasks rozdziela harmonogramy od zadań w tle i otwiera wynik zadania
w karcie. Connectors zachowuje granty całego workera. Nieaktywne moduły są
odmontowane, dane korzystają ze współdzielonego cache parowania, a ponowne
otwarcie sekcji PR korzysta z zapamiętanej prezentacji. Nie zmieniamy konfiguracji
natywnej ani fingerprintów.

Files używa `FlatList` ze stałą wysokością wiersza co najmniej 48 dp, dostosowaną
do skali tekstu. Okno montowania ma do 80 wierszy na obsługiwanych viewportach;
`Load more` pobiera po 100 dzieci bieżącego katalogu. Arkusz i pełna karta
współdzielą model drzewa, bez zagnieżdżania listy w scrollu arkusza. Dotknięcie pliku
otwiera preview; Keep tab utrwala go w przełączniku kart. Litery statusu Git i opisy
dostępności uzupełniają kolory. Symlinki i usunięte wpisy są nieaktywne.

Cache drzewa ma osobny limit 1 MiB zakodowanego payloadu, do 30 wątków, po 128
węzłów katalogów i 30 rozwinięć. Listowania mają wspólny limit dwóch równoległych
odczytów; po zamknięciu ostatniego widoku odczyty i kursory są zwalniane. Brak
pollingu w tle. `Reload files` odświeża zmiany spoza Canopy; własny zapis i usunięcie
unieważniają drzewo wątku. Przekroczenie budżetu lub wygaśnięcie kursora pokazuje
ponowny odczyt folderu. Starszy gateway/worker dostaje komunikat o aktualizacji.

Ścieżki plików w wiadomościach agenta (kod inline i linki Markdown) otwierają podgląd przez
`ReadThreadFile` z ID wątku i elementu źródłowego. Rozstrzygnięcie nazw, wybór spośród kilku dopasowań,
uprawnienia i limity są wspólne z webem; dla połączonego komputera odczyt wykonuje gateway domowy.
Podgląd pokazuje względną ścieżkę i komputer, tekst/Markdown, a dla obrazów rastrowych również
wymiary i rozmiar. Binaria nie mają akcji Edit. Reload zachowuje rozstrzygniętą ścieżkę i hash;
edycja tekstu oraz Delete file wymagają hasha odczytu. Nieudany zapis i reconnect nie porzucają szkicu,
a zamknięcie lub porzucenie zmian wymaga potwierdzenia. Limit odczytu to 2 MiB, edycji 400 KiB.
Implementacja `features/files` używa istniejących komponentów i modułów; nie zmienia konfiguracji natywnej.

Natywne gRPC wymaga HTTP/2 i dostępu do trailers; fetch React Native nie udostępnia
takiego interfejsu. Nie używamy natywnego transportu gRPC ani biblioteki Node w telefonie.
`@connectrpc/connect-web@2.3.0` wysyła **Connect z binarnym protobuf** przez jawnie
przekazany transport z `src/api/pinned.ts`. Gateway korzysta z `connectNodeAdapter`, więc obsługuje ten
sam `ui.GatewayService` bez translacji DTO i bez pośrednictwa BFF. gRPC-Web również
jest obsługiwany przez serwer, ale aplikacja wybiera Connect. Unary i server streaming
działają po HTTP/1.1; bidirectional streaming WorkerLink nadal wymaga HTTP/2.

Lokalny moduł Expo `modules/canopy-pinned-fetch` używa URLSession/Network na iOS oraz
OkHttp/SSLSocket na Androidzie. Weryfikuje dokładny SHA-256 certyfikatu komputera przed
wysłaniem kodu lub tokenu; nie ufa systemowym CA ani nazwie hosta. Odrzuca przekierowania,
nie używa cookies i przekazuje porcje odpowiedzi do `ReadableStream` z anulowaniem.
`WatchOverview` i `WatchThread` nie czekają na zakończenie całej odpowiedzi. Moduł wymaga
nowego development buildu; poprzedni build z samym `expo/fetch` nie wystarczy.

Telefon korzysta z tego samego listenera [Network access](network-access.md), co połączone
komputery, bez certyfikatu klienta. Ten listener obsługuje HTTP/1.1 i HTTP/2, GatewayService
i MobilePairingService. Żądania z `Origin` są odrzucane; przeglądarka używa BFF.
Nie wymaga Tailscale Serve, systemowego CA, konfiguracji portu mobilnego ani proxy HTTPS.
VPN jest opcjonalną trasą między sieciami; TLS musi kończyć sam Canopy.

### iOS: ATS i przypięty certyfikat

Na iOS moduł używa URLSession; delegat porównuje SHA-256 certyfikatu z pinem i odpowiada
`.useCredential`. Przy włączonym ATS CFNetwork po tej odpowiedzi ocenia zaufanie jeszcze raz:
polityką SSL z nazwą hosta i systemowymi CA, niezależnie od kotwic i polityki ustawionych na
obiekcie zaufania. Samopodpisany certyfikat komputera tej oceny nie przechodzi (`AnchorTrusted`,
`SSLHostname`, `ServerAuthEKU`, `OtherTrustValidityPeriod`). Log CFNetwork pokazuje wtedy
`ATS failed system trust`, a żądanie kończy się `NSURLErrorDomain -1200` (błąd TLS `-9802`), także
dla adresów IP. `probe` używa Network.framework, którego ATS nie dotyczy, więc handshake
przechodził i błąd pojawiał się dopiero przy pierwszym RPC.

Dlatego `app.config.ts` ustawia `NSAllowsArbitraryLoads: true`. Wyjątek per domena nie wystarczy:
`NSExceptionDomains` nie przyjmuje adresów IP, a nazwy hostów ustawia użytkownik. Klucz
`NSAllowsLocalNetworking` nie może być ustawiony, bo iOS ignoruje wtedy `NSAllowsArbitraryLoads`.
Granicą zaufania jest pin, nie ATS. Aplikacja łączy się z komputerem tylko przez ten moduł, który
przyjmuje wyłącznie HTTPS i ufa tylko przypiętemu certyfikatowi. HTTP poza adresami lokalnymi blokuje
kod klienta (wyłącznie JS development), linki otwiera przeglądarka systemowa, a Markdown nie pobiera obrazów.

App Store: `NSAllowsArbitraryLoads` wymaga uzasadnienia przy przeglądzie. Uzasadnienie: aplikacja
łączy się z serwerem hostowanym przez użytkownika (adres IP lub własna nazwa) z certyfikatem
samopodpisanym, weryfikowanym przez przypięty odcisk SHA-256 przekazany przy parowaniu.

Połączenie z iOS sprawdzaj buildem `bunx expo run:ios --configuration Release` z HTTPS i pinem.
Lokalne HTTP z `CANOPY_DEV_HTTP=1` omija tę ścieżkę.

Błędy transportu niosą natywną domenę i kod, bez adresu: na iOS `NSURLErrorDomain -1200 / -9802`
(drugi to kod błędu TLS strumienia), z probe `POSIX 61`, `TLS -9808` albo `timeout`; na Androidzie
klasę wyjątku i jego przyczyny (`SSLHandshakeException / CertPathValidatorException`). Aplikacja
dopisuje kod w nawiasie do komunikatu przy parowaniu i w „Cannot reach this computer securely”
po nieudanym probe. Kod ostatniego błędu streamu („Last error: …”) pokazuje arkusz statusu połączenia
(stopka listy lub „Details” w banerze). Każda trasa ma osobny wynik: rodzaj i skrócony adres,
„DNS failed”, „Timed out after N ms”, „TLS pin mismatch”, „Connection refused” albo „OK in N ms”.
„In use” oznacza wybraną trasę. „Copy details” kopiuje pełne adresy, wyniki i czas sprawdzenia;
nie kopiuje tokenu, pinu ani danych żądań. Wyniki pozostają tylko w pamięci aplikacji.

## Wersje i Bun workspace

Zależności aplikacji: Expo **58.0.23**, React Native **0.88.1**,
React **19.3.0**, Expo Router **58.0.30**. Wersje przypina `apps/mobile/package.json`.
Zachowane są `src/app`, Router, Hermes, domyślna New Architecture i CNG.
Bez `react-native-web`, Expo web, NativeWind i dodatkowego systemu komponentów.

Metro korzysta z `getDefaultConfig` z `expo/metro-config`. SDK 58 sam wykrywa
workspaces Bun, eksporty TS `@canopy/contracts` i współdzielony reducer itemów
`@canopy/domain/items`. Nie dodawaj dawnych `watchFolders` ani ręcznych aliasów.
Po zmianie linkera lub przeniesieniu checkoutu uruchom `bunx expo start --dev-client --clear`.

W `bunfig.toml` jest `install.linker = "hoisted"`. Izolowany linker Bun powodował,
że Expo Doctor widział kilka fizycznych instalacji tych samych wersji modułów native.
Po `bun install` z hoisted Doctor przechodzi. Pakiety wymagające JS API TypeScript
(SvelteKit i typescript-eslint) potrzebują TS 6. Root używa oficjalnego aliasu
`typescript: npm:@typescript/typescript6@6.0.2`, a `@typescript/native: npm:typescript@7.0.2`
zachowuje binarkę `tsc` 7 dla pozostałych workspace'ów. Web/mobile mają własny TS 6.0.3.
ESLint 9.39.5 jest przypięty, bo obecny eslint-plugin-react nie obsługuje ESLint 10.

Animacje stanu UI robi `react-native-reanimated` **4.7.1** z `react-native-worklets` **0.13.0**
(wersje z `bunx expo install`). Wtyczkę Babel worklets konfiguruje sam `babel-preset-expo`,
więc aplikacja nie ma `babel.config.js`. To moduły natywne: po ich dodaniu potrzebny jest nowy
development build (lokalny `expo run:*` albo `eas build --profile development`); stary build
z nowym bundlem JS kończy się błędem braku modułu. Nightly TestFlight i buildy EAS budują je same.

Hermes obsługuje BigInt wymagany przez protobuf-es (`uint64`, m.in. seq).
SDK 58 / RN 0.88 udostępnia TextEncoder i TextDecoder; Expo inicjalizuje
`structuredClone` oraz ReadableStream przed wejściem Routera. Nie dodajemy konkurencyjnych
polyfilli. Idempotency key kompozytora pochodzi z natywnego `expo-crypto.randomUUID()`;
aplikacja i Connect nie wymagają globalnego `crypto.getRandomValues`.

## Parowanie i granica uprawnień

1. Na już połączonym urządzeniu otwórz **Settings → Devices → Pair a phone**.
   `CreateMobilePairing` akceptuje token BFF albo sparowanego telefonu/desktopu.
   Nowy telefon nigdy nie otrzymuje service tokenu.
2. Gateway generuje 64 losowe bity jako kod `XXXX-XXXX-XXXX-XXXX`, ważny 10 minut.
   QR zawiera lokalnie wygenerowany JSON `{type:"canopy-pair",version:2,addresses,fingerprint,code}`,
   nie URL z sekretem. Kod nie trafia do zewnętrznego serwisu QR.
3. Telefon skanuje kod przez expo-camera albo użytkownik wkleja kod, HTTPS URL i pełny odcisk SHA-256.
   Po skanie użytkownik potwierdza adres i nazwę przyciskiem **Pair this phone**.
4. Publiczny `MobilePairingService.ExchangeMobilePairing` atomowo zużywa kod i zwraca
   token urządzenia `canopy_device_…` (256 losowych bitów). Baza przechowuje tylko SHA-256.
5. `expo-secure-store` zapisuje token, pin, listę tras i ostatnią działającą trasę. Na iOS używa
   `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; Android backup wyklucza klucze SecureStore.
   Nie ma logowania tokenu, cookies, storage przeglądarki ani service tokenu w aplikacji.

Migracja **0046_mobile_devices** tworzy `mobile_pairings` i `mobile_devices`:
właściciel, nazwa/platforma, utworzenie, last seen, revocation, hash kodu/tokenu.
Transakcja z blokadą wiersza i ponownym sprawdzeniem czasu zapobiega podwójnej wymianie,
wyścigowi z revoke i zużyciu po wygaśnięciu. Maksymalnie 20 aktywnych zaproszeń właściciela.
Wymiana ma wspólny limit 30 prób/min na proces; zmiana kodu/IP/forwarded headers nie resetuje go.
Restarty resetują licznik. Architektura zakłada jeden proces gatewaya.

Migracja **0056_mobile_network** odwołuje starsze tokeny i niewykorzystane kody. Urządzenia
z `pairing_version=1` mają w Settings jasne „Pair again”; zapis telefonu bez pinu prowadzi
na ekran ponownego parowania. Nowe urządzenia mają `pairing_version=2`.
`OverviewUpdate.mobile_routes` (764) ogłasza nowe adresy i nazwy hostów. Telefon zapisuje
je wyłącznie przy zgodnym pinie. Nie ponawia RPC po wysłaniu, aby nie dublować komend.

Wybór trasy (`src/api/routes.ts`, `route-selector.ts`, `route-race.ts`): handshake TLS bez HTTP sprawdza najpierw IP
Tailscale, potem ostatni sukces i pozostałe adresy; trasy, które zawiodły w ostatnich 10 s, idą na koniec.
MagicDNS nie jest potrzebny, gdy działa IP tailnetu. Kolejna próba startuje 250 ms po poprzedniej albo
od razu po jej błędzie; wygrywa pierwsza ze zgodnym pinem. Szybka próba trwa maksymalnie 2 s,
a po timeoucie ta sama trasa dostaje jeszcze 8 s na obudzenie tunelu VPN lub radia. Błąd DNS,
odmowa połączenia i niezgodny pin nie są ponawiane w tym wyścigu. Obie próby obejmuje także
termin po stronie JS, więc zawieszony DNS nie blokuje wyścigu bez końca.
Wszystkie żądania czekające na trasę dzielą jeden wyścig; anulowane żądanie go nie przerywa.
Trasa ze zgodnym pinem jest od razu współdzielona również podczas oczekiwania na nagłówki RPC.
Pozostaje wybrana bez limitu czasu: same upływ czasu i cisza w strumieniach nie uruchamiają probe.
Nagłówki odpowiedzi oraz dane i heartbeat strumienia potwierdzają zdrowie bieżącego wyboru.
Błąd transportu unieważnia trasę dla kolejnych żądań; anulowanie przez wywołującego nie psuje
jej innym żądaniom. Nie ma okresowych wyścigów ani probe szukających lepszej trasy w tle.
Nowy wyścig następuje po błędzie, zmianie sieci, powrocie z tła, „Reconnect now” lub usunięciu
bieżącego adresu z ogłoszenia. Dodanie lub przestawienie pozostałych adresów zachowuje działającą
trasę i strumienie. Reset anuluje stary wyścig; spóźnione odpowiedzi i błędy porzuconego wyboru
nie zmieniają nowego, nawet jeżeli oba wybory używają tego samego adresu.
Details zachowuje wyniki ostatniego wyścigu i trasę „In use” bez nowych sprawdzeń przy zwykłych żądaniach.
Starsze zapisy parowania i ogłoszenia są filtrowane także w telefonie: prywatne IPv4 kończące się `.0`
są pomijane jako prawdopodobne adresy sieci wirtualnych /24. Bez maski podsieci w kontrakcie to heurystyka:
może pominąć poprawny prywatny adres `.0` w większej podsieci; publiczne i Tailscale `.0` zostają.
Aktualne, przefiltrowane adresy gatewaya zastępują zapis telefonu przez `mobile_routes` i `UpdateNetworkAccess`.
Przegrane i anulowane probe zamykają natywne sockety. Na Androidzie `probe` działa na własnych wątkach: Expo wykonuje
`AsyncFunction` wszystkich modułów na jednym wątku, a blokujący connect wstrzymywał inne wywołania.

Martwe połączenia: po powrocie z tła i po zmianie sieci (typ lub łączność z `expo-network`) aplikacja
woła `reset()` w samym zdarzeniu, zanim React wznowi strumienie. Kolejne żądania idą przez nowe
połączenia (iOS: nowa `URLSession`, Android: nowy klient i nowa pula OkHttp), wyścig tras startuje od nowa,
a po zmianie sieci strumienie subskrybują się ponownie. URLSession nie wysyła HTTP/2 PING, więc bez tego
iOS wysyłał żądania w połączenie zerwane podczas uśpienia (np. wygasłe mapowanie NAT), a pusta
odpowiedź wisiała do 24 h. Samo `evictAll()` usuwa tylko bezczynne połączenia: aktywne HTTP/2
mogłoby nadal przyjmować nowe żądania. OkHttp wysyła PING co 60 s i zamyka połączenie bez odpowiedzi
w kolejnym interwale; zwykłe odczyty strumienia nie mają read timeoutu. Strumień bez
nagłówków odpowiedzi po 40 s kończy się błędem `timeout` i łączy ponownie (każdy obserwowany strumień
zaczyna się od snapshotu, z którym idą nagłówki); żądania unary nie mają takiego limitu. Status
połączenia używa wspólnej maszyny `@canopy/domain/connection-recovery`, opisanej poniżej.
„Reconnect now” resetuje transport i backoff wszystkich subskrypcji; sukces streamu
zeruje jego backoff. Zmiany natywnego probe i puli wymagają nowego builda iOS/Android, nie samego OTA.
Po zmianie portu zapisuje nowe trasy również z odpowiedzi `UpdateNetworkAccess`, nawet
bez strumienia overview. Usuwa nieaktualną ostatnią trasę; restart telefonu korzysta
z nowych adresów, zachowując ten sam pin i token urządzenia.
Bez żadnej znanej działającej trasy potrzebny jest wspólny VPN lub nowy QR — sama aplikacja
nie zapewnia relaya ani przejścia przez NAT.

### Stany połączenia i ponawianie

Jedno źródło reguł dla mobile i web/desktop: `packages/domain/src/connection-recovery.ts`.
Stan dostępności jest niezależny od aktywności próby (`retrying`, `retryAt`):

| Stan | Zdarzenie | Następny stan |
| --- | --- | --- |
| `live` | utrata streamu / nowe połączenie po wznowieniu | `reconnecting` |
| `reconnecting` | 3 nieudane próby lub 12 s bez udanego połączenia | `unavailable` |
| `reconnecting` / `unavailable` | nowa próba, probe, ręczne ponowienie, zmiana sieci, foreground | ten sam stan |
| dowolny | snapshot streamu potwierdzający synchronizację (web: `ready` i udana resynchronizacja) | `live` |

`unavailable` jest zatrzaśnięty do sukcesu. Sam handshake, nowe żądanie ani aktywny wyścig
tras nie cofają tej decyzji. `offline` i `paused` są nakładkami prezentacji: brak sieci lub
tło wstrzymują subskrypcje bez usuwania zapamiętanego `unavailable`. Nieodwracalne błędy
uprawnień lub brakującego wątku kończą subskrypcję stanem `error`; odwołanie tokenu usuwa sesję.
Zaplanowane restarty nadal korzystają z osobnego komunikatu i próby co 2,5 s w ograniczonym oknie.

Backoff: 1 / 2 / 4 / 8 / 16 / 30 s z jitterem 80–100%, nigdy ponad 30 s. Czas oczekiwania
liczy się od zakończenia nieudanej próby. Dla watcha wątku sukces zeruje backoff
dopiero po 10 s stabilnego live; pojedynczy odebrany batch nie kasuje kolejnych awarii.
Dla pozostałych subskrypcji sukces zeruje go od razu. Zmiana sieci (`expo-network`, bez nowej
zależności NetInfo), foreground oraz „Reconnect now” zerują backoff. Reset nie usuwa
decyzji o niedostępności. Wszystkie żądania telefonu dzielą także cooldown po nieudanym
wyścigu tras; odczyty i niezależne subskrypcje nie uruchamiają dodatkowych probe w tym oknie.
Nowe żądanie w cooldownie dostaje ostatni błąd; nie jest kolejkowane do późniejszego wysłania.
Anulowanie pojedynczego wywołania nie przerywa wspólnego wyścigu. Reset transportu go anuluje
i odgradza spóźnione wyniki. Żadne RPC, które mogło dotrzeć do gatewaya, nie jest odtwarzane.

Arkusz pokazuje aktywność wyłącznie w zarezerwowanym wierszu „Retrying in N s” / „Retrying…”.
Opis, ostatni błąd, wiersze tras i przyciski mają stałe sloty; długa lista tras przewija się.
Każda trasa zachowuje ostatni wynik i czas sprawdzenia podczas kolejnego probe, a mały
wskaźnik obok oznacza sprawdzanie. Nagłówek „Routes” pozostaje stały. Ruch wskaźników
respektuje ograniczenie animacji. Retry nie zamyka arkusza ani go nie montuje ponownie,
również gdy otwarto go z banera i połączenie właśnie wróciło.
Baner pojawia się przy tej samej decyzji `unavailable` i znika po sukcesie; w sidebarze
jest nakładką pod nagłówkiem, więc nie przesuwa listy ani jej scrolla. Scrim arkusza
pozostaje niezależny od kolejnych prób. Web/desktop używa tego samego backoffu i histerezy,
popovera statusu z ręcznym retry oraz banera nad treścią bez zmiany jej geometrii.

Odświeżenie `WatchThread.controls` co 5 s pozostaje na tym samym strumieniu
i zachowuje `live`; tylko jawny catch-up lub utrata transportu zmienia gotowość.
Wspólny helper kompozytora toleruje 1 s non-live po synchronizacji, bez zmiany
geometrii przycisków. Send czeka z niezmiennym żądaniem do live, Stop pozostaje
osiągalny i po powrocie dotyczy wyłącznie nadal działającej tury. Szczegóły:
[potwierdzenie wiadomości](ui-api.md#potwierdzenie-wiadomości).
Build developerski loguje znaczniki czasu, powody zmian stanu i licznik otwarć
watcha (`Stream connection changed`, `Stream watch started`), bez treści,
identyfikatorów wątków, adresów ani tokenów. Licznik rozróżnia zmianę gotowości
od rzeczywistego ponownego otwarcia transportu.

Awaria watcha wątku zachowuje własny powód w Details, również przy zdrowym overview.
Opis mówi np. o zbyt dużej aktualizacji lub brakujących aktualizacjach; szczegóły
zawierają kod RPC i kategorię z zamkniętej listy. Luka seq wznawia ostatni atomowy
checkpoint bez usuwania cache ani stron historii. Trzecia kolejna awaria kończy
automatyczne naprawy; 10 s stabilnego live odnawia ich budżet. Diagnostyka zlicza
te kategorie i rozmiar odrzuconej partii, bez tekstu błędu i treści wątku.
Przedwczesny koniec streamu bez błędu również liczy się jako awaria watcha;
anulowanie przy przejściu w tło nie zużywa budżetu i zachowuje checkpoint.
Planowy koniec offline watcha po odzyskaniu obecności domu zachowuje kategorię
`computer_unreachable` i nie zużywa budżetu błędów samego wątku.

### Tailscale na telefonie

Na Androidzie w ustawieniach VPN włącz **Always-on VPN** dla Tailscale, a w ustawieniach
baterii aplikacji Tailscale wybierz **Unrestricted**. Nazwy i położenie opcji zależą od
producenta telefonu. Na iOS skonfiguruj [VPN On Demand w Tailscale](https://tailscale.com/docs/features/client/ios-vpn-on-demand)
tak, by VPN łączył się automatycznie przez Wi-Fi i sieć komórkową poza siecią domową.

W **Details** każda trasa ma własny wynik. **DNS failed** dla `<host>.ts.net` oraz
**Timed out** dla `100.x.y.z` sugerują wyłączony Tailscale na telefonie — włącz go.
Jeśli Tailscale jest włączony, ale wszystkie trasy mają **Timed out**, wyłącz go i włącz
ponownie w aplikacji Tailscale. Timeout LAN poza domową siecią jest spodziewany.
Ten wzorzec nie dowodzi, że komputer działa; jeśli restart VPN nie pomaga, sprawdź także
dostępność komputera i jego Network access.

Canopy pokazuje wskazówkę w opisie arkusza połączenia wyłącznie wtedy, gdy ostatni
zakończony wyścig nie znalazł żadnej działającej trasy, a wszystkie trasy Tailscale
zakończyły się błędem DNS lub timeoutem. Niezgodny pin i odmowa połączenia na trasie
Tailscale wykluczają wskazówkę. Tytuł pozostaje „Gateway unavailable”, a baner z tą wskazówką
czeka na tę samą decyzję o niedostępności. **Copy details** nadal kopiuje wyniki wszystkich tras.
Na Androidzie **Open Tailscale** otwiera aplikację przez jej URL nawigacji; jeśli system
nie obsłuży linku, Canopy prosi o ręczne otwarcie. Na iOS otwórz Tailscale ręcznie.

`expo-network` 58.0.4 na Androidzie sprawdza transport Wi-Fi i komórkowy przed VPN, więc
brak typu `VPN` nie potwierdza wyłączonego tunelu. iOS nie udostępnia osobnego stanu VPN.
Dlatego komunikat mówi o możliwym wyłączeniu lub zawieszeniu Tailscale. Klucz zmiany sieci
obejmuje typ, łączność i `isInternetReachable`; na iOS ostatnie pole powtarza łączność.
Gdy przełączenie VPN nie zmienia tych pól, aktywne subskrypcje ponawiają wyścig tras
według wspólnego backoffu, także podczas wskazówki Tailscale. Same próby nadal mają
dotychczasowe limity czasu. Nowe próby nie startują w tle; powrót do aplikacji resetuje
transport i wznawia strumienie. Ponawianie obejmuje subskrypcje i handshake, nigdy RPC,
które mogło dotrzeć do komputera. Zmiana pozostaje w JS/TS i nie wymaga nowego buildu.

Token urządzenia autoryzuje GatewayService jako **obecnego pojedynczego właściciela**.
Token urządzenia nie ma terminu ważności — działa do odwołania. Termin ważności dotyczy
jednorazowego kodu parowania, nie tokenu.
To pełny dostęp właściciela, nie osobna rola read-only. Interceptor zapisuje identity
urządzenia w context i porównuje właściciela w DB z użytkownikiem core. Zarządzanie
urządzeniami, workerami, siecią, komputerami i aktualizacjami jest dostępne również
telefonowi przez te same owner-scoped RPC co BFF. Telefon jest zdalnym interfejsem
właściciela, bez własnej bazy i bez osobnej roli administracyjnej.
`UnpairMobileDevice` odnosi się wyłącznie do identity wywołującego urządzenia.
Rodzaj `desktop` ustala gateway podczas tworzenia zaproszenia; kod telefonu nie
działa w wymianie desktopowej. Lokalny kanał sterowania aplikacją desktopową
nadal wymaga własnego uwierzytelnienia i nie należy do mobilnego klienta.
Przyszłe logowanie/multi-user musi zastąpić to mapowanie, nie rozszerzyć współdzielony token.

Web pokazuje metadane i pozwala odwołać kod lub token. Revoke kończy otwarte streamy
w tym procesie i odrzuca kolejne RPC; pozostałe urządzenia zachowują dostęp.
Last seen sprawdzamy przy RPC, zapisując najwyżej raz/minutę; nie jest to heartbeat
stale otwartego połączenia. Zdarzenia overview 760–761 zawierają tylko metadane.
`WatchOverviewRequest.include_snapshot` (762) i `OverviewUpdate.mobile_snapshot` (763)
dają pełny stan po każdym reconnect. Zwykły BFF nie żąda tego snapshotu.
`MobileOverviewSnapshot.settings` (3) niesie ustawienia odczytane już po rozpoczęciu
subskrypcji, więc reconnect nie potrzebuje osobnego GetSettings; starszy gateway go nie
wysyła i telefon czyta wtedy GetSettings raz po snapshocie. Wersje ustawień tylko rosną:
starsza odpowiedź nie zastępuje nowszego zdarzenia.

Unpair w aplikacji najpierw odwołuje dostęp na gatewayu, potem usuwa SecureStore.
Gdy gateway jest niedostępny, **Forget pairing locally** wymaga potwierdzenia i wyraźnie
informuje o konieczności revoke w web. iOS Keychain może przetrwać reinstalację aplikacji;
usunięcie aplikacji nie zastępuje odwołania urządzenia na serwerze.

## Parowanie bez konfiguracji serwera

Otwórz **Settings → Devices → Pair a phone**. Jeśli dostęp sieciowy jest wyłączony,
przycisk włącza go i generuje QR jednym kliknięciem. Port zostaje zapisany; wykryte adresy
LAN i VPN odświeżają się automatycznie. Nazwy DNS i porty przekierowane dodaje się w
**Settings → Network access → Add hostname**. W kontenerze opublikuj port TCP według
[deploy.md](deploy.md#dostęp-sieciowy-telefony-i-połączone-komputery).
Na telefonie i komputerze musi istnieć przynajmniej jedna wspólna trasa sieciowa.

Overview i listy połączonych komputerów korzystają z lokalnej projekcji gatewaya,
tak samo jak web/desktop. Reconnect nie usuwa ostatnich workerów, projektów, workspace'ów
ani wątków niedostępnego domu (`domain/linked-snapshot.ts`). Wątki pozostają przygaszone
i Read-only, otwierają się z lustra; wysyłanie i steering są wyłączone z powodem.
Pickery zachowują opcje offline: akcje wymagające partnera są wyłączone, a filtr projektu
nadal pozwala czytać jego wątki. Jawny snapshot domu, usunięcie i unlink uzgadniają
usunięcia. Okno historii `WatchThread.page_size` także wysyła lokalny seed od razu,
zanim liveness rozpozna nieodpowiadające łącze. Katalogi modeli, botów i harmonogramów
odświeżają zainteresowane ustawienia po `linked_read_completed`. Katalog modeli workera jest
czytany raz na parowanie (albo pochodzi z preloadu listy), potem zastępują go `OverviewUpdate.models`
ze strumienia; ponowny wybór workera ani nowy kompozytor nic nie czytają. Po przerwie w strumieniu
katalogi w użyciu czytają się raz ponownie.

Odczyty ekranów Settings (`useSettingsResource`) są współdzielone w parowaniu: klucz to nazwa
RPC i zakres (`GetComputers`, `ListModels:<worker>`), ekrany z tym samym kluczem dzielą wartość
i żądanie. Zdarzenia overview unieważniają je po nazwie (`@canopy/domain/shared-query-events`);
ekran otwarty później użyje wartości młodszej niż 30 s. Edytory kopiują dane do szkicu przy
otwarciu, więc odświeżenie z innego urządzenia nie niszczy niezapisanych zmian.

## Android emulator: lokalny development build

1. Zainstaluj Android Studio, JDK 17 oraz Android SDK Platform 37 i Build Tools 37
   wymagane przez Expo 58; obraz emulatora może mieć niższe API (sprawdzany AVD: 36.1).
   Włącz wirtualizację/KVM. W SDK Manager zainstaluj też Command-line Tools (latest),
   Platform-Tools i Android Emulator; ustaw `ANDROID_HOME` i dodaj `platform-tools`
   oraz `emulator` do PATH zgodnie z dokumentacją Expo. Uruchom AVD z Device Manager.
2. W root repo wykonaj `bun install`, następnie:

   ```bash
   cd apps/mobile
   CANOPY_DEV_HTTP=1 bunx expo run:android
   ```

   Polecenie generuje projekt natywny, buduje debug/development client i instaluje go
   w emulatorze. Późniejsze zmiany JS: `bunx expo start --dev-client --clear`, potem `a`.
3. Dla gatewaya w tailnecie użyj HTTPS URL Serve. Emulator musi mieć do niego trasę
   (Tailscale w emulatorze albo poprawnie działająca sieć hosta); nie zakładaj, że każdy
   AVD automatycznie dziedziczy DNS/VPN hosta. Ręcznie wklej URL i kod, bo skan kamery
   emulatora nie jest potrzebny.
4. Dla throwaway gatewaya uruchomionego **na tym samym hoście co AVD** można użyć
   adresu `http://10.0.2.2:7444`. To alias hostowego loopback Android Emulator,
   nie adres zdalnego serwera. Bazowy manifest blokuje cleartext, ale standardowy
   manifest **debug** Expo nadpisuje go dla połączeń z Metro. Zwykły `run:android`
   wystarcza dla emulatora; jawny lokalny wariant bazowej konfiguracji można wygenerować tak:

   ```bash
   CANOPY_DEV_HTTP=1 bunx expo prebuild --clean --no-install --platform android
   CANOPY_DEV_HTTP=1 bunx expo run:android
   ```

   W Pair wpisz `http://10.0.2.2:7444` i kod z web. Kod można wygenerować z URL Serve
   w QR, a sam adres zmienić ręcznie. Klient dopuszcza HTTP tylko w JS development,
   wyłącznie `localhost`, `127.0.0.1`, `[::1]` i `10.0.2.2`, niezależnie od manifestu debug.
   Nie używaj tej flagi dla
   buildów dystrybucyjnych ani danych live. Przy powrocie do HTTPS wygeneruj CNG ponownie
   bez flagi. Zwykłe `localhost` wewnątrz emulatora oznacza emulator.
5. W web wybierz **Pair a phone**, a w aplikacji potwierdź dane. Lista wątków powinna
   pojawić się po snapshot overview; otwarcie wątku rozpoczyna WatchThread.

## Android telefon fizyczny

Zainstaluj i włącz Tailscale na telefonie. Na komputerze z Android SDK podłącz telefon
przez USB, włącz USB debugging i użyj `bunx expo run:android --device` z `apps/mobile`.
Alternatywnie zbuduj APK w EAS profilem development (poniżej), pobierz i zainstaluj APK.
W Pair użyj adresu HTTPS Serve, nie `10.0.2.2`.

Development client potrzebuje też dostępu do Metro. Dla telefonu w tej samej sieci
`bunx expo start --dev-client --lan`; przy zdalnym hoście można wpisać w launcherze
`http://TAILSCALE_IP_KOMPUTERA:8081` i udostępnić port Metro **tylko w tailnecie**.
Adres Metro i adres gatewaya to dwa różne połączenia. Nie używaj publicznego tunelu/Funnel.

## iPhone i iOS simulator

1. Dla lokalnego builda potrzebny jest Mac z Xcode, Command Line Tools i CocoaPods.
   Z root wykonaj `bun install`, a z `apps/mobile`:

   ```bash
   bunx expo run:ios --device
   ```

   Wybierz podłączony iPhone i skonfiguruj signing, jeśli Xcode o to poprosi.
   Dla simulatora na Macu użyj `bunx expo run:ios`. Przy lokalnym gatewayu HTTP:
   `CANOPY_DEV_HTTP=1 bunx expo run:ios`, adres `http://127.0.0.1:7444`.
   Na iOS flaga nie zmienia ATS (`NSAllowsArbitraryLoads: true`, patrz wyżej); HTTP dopuszcza kod klienta.
   SDK 58 generuje deployment target iOS 16.4.
2. Bez lokalnego Maca można zbudować klienta w EAS. Potrzebne są konto Expo i
   Apple Developer do wewnętrznej dystrybucji na fizyczny iPhone. Z `apps/mobile`:

   ```bash
   bunx eas-cli login
   bunx eas-cli init
   bunx eas-cli device:create
   bunx eas-cli build --profile development --platform ios
   ```

   Zarejestruj UDID iPhone'a przez link z `device:create`, potem zainstaluj build
   z linku EAS na tym urządzeniu. Jeśli CLI nie potrafi zapisać projectId w dynamicznym
   configu, wpisz identyfikator podany przez `eas init` w `app.json` jako
   `expo.extra.eas.projectId`; `app.config.ts` zachowuje tę konfigurację.
3. Projekt EAS to `@itsol/canopy-mobile` (`owner` i `extra.eas.projectId` w `app.json`); build
   wymaga konta w organizacji itsol albo jej tokenu `EXPO_TOKEN`, który trzymamy poza repo.
   Samodzielny APK do testów z nightly (bez Metro, połączenie HTTPS z przypiętym
   certyfikatem): najpierw z katalogu repozytorium uruchom
   `bash scripts/mobile-version.sh v0.2.0-nightly.105` (podaj tag budowanego wydania),
   potem z `apps/mobile` uruchom `bunx eas-cli build --profile preview --platform android`. Profil
   `preview` buduje na Androidzie APK, a EAS trzyma klucz podpisu, więc kolejne APK
   instalują się jako aktualizacja.
   Dla development buildu APK użyj `bunx eas-cli build --profile development --platform android`.
   Profile `development` ma `developmentClient: true` i `distribution: internal` dla
   obu platform. Dla builda EAS do iOS Simulator użyj `development-simulator` i zainstaluj
   wynik na Macu; nie instaluje się go na iPhonie.
   Profile development ustawiają `CANOPY_DEV_HTTP=1` dla lokalnych testów. Preview/production
   nie ustawiają tej flagi i wymagają HTTPS. Kod klienta dodatkowo dopuszcza HTTP tylko
   w JS development i tylko dla adresów lokalnych wymienionych wyżej.
4. Włącz Developer Mode na iPhonie, jeśli system o to poprosi. Uruchom Metro:
   `bunx expo start --dev-client --lan` w tej samej sieci co telefon lub wpisz
   `http://TAILSCALE_IP_KOMPUTERA:8081` w development launcherze. Włącz Tailscale
   na iPhonie i użyj w Canopy **HTTPS** Serve z poprawnym certyfikatem.
5. W web otwórz **Settings → Devices → Pair a phone**. W Canopy zeskanuj QR
   (zgoda na kamerę jest potrzebna tylko przy skanowaniu) lub wklej kod i adres.
   Potwierdź nazwę i adres, a następnie **Pair this phone**.

Nie utrzymujemy ręcznie `android/` i `ios/`. CNG generuje je z konfiguracji i pluginów,
katalogi są w `.gitignore`; po zmianie natywnego modułu/configu potrzebny jest nowy build.
Samo przejście Metro/OTA nie doda modułu natywnego do istniejącej aplikacji.

Przy buildzie iOS ustaw locale UTF-8 (`LANG=en_US.UTF-8`, `LC_ALL=en_US.UTF-8`)
i używaj zgodnych wersji CocoaPods, Ruby i `ffi`. Błąd `avdmanager ENOENT`
oznacza brak Command-line Tools pod `$ANDROID_HOME/cmdline-tools/latest/bin`,
nawet jeżeli sam obraz AVD jest już zainstalowany.

## Wydania mobilne: TestFlight i OTA

Workflow `Mobile release` (`.github/workflows/mobile-testflight.yml`) działa po rzeczywistej
publikacji przez `Release`: `dev` → `nightly`, `next` → `beta`, `main` i stabilne tagi → `stable`.
Sprawdza sukces joba `release` przez API (`actions: read`) i tag dokładnie na źródłowym SHA.
Przed checkoutem pobiera SHA z artefaktu `release-revision` tego konkretnego przebiegu.
Uwzględnia to ręczny `expected_sha` Release, który może różnić się od `workflow_run.head_sha`.
Cykl Release bez nowej publikacji pomija EAS oraz instalację zależności. Ręczny dispatch wymaga
wydanego HEAD na gałęzi wydania lub tagu; `force` omija tylko sprawdzenie zmienionych ścieżek,
nie zgodność runtime, kanał ani deduplikację. Nie wysyła nieotagowanych commitów.

Planner `scripts/mobile-release.sh` porównuje commit z ostatnim ukończonym buildem iOS lub
nowszym kompletnym OTA dla jego runtime. Brak zmian w `apps/mobile`, pakietach
`contracts`, `domain`, `ui`, root `package.json`, `bun.lock`, workflow i skryptach wydania
pomija wydanie mobilne. Brak znanego punktu odniesienia wymusza ocenę runtime.

`expo-updates` ma `runtimeVersion: { policy: "fingerprint" }`. SDK 58 używa presetu `balanced`
(`fingerprint.config.js`): wersja marketingowa i numer buildu nie zmieniają runtime, ale SDK,
zależności natywne, konfiguracja natywna i źródła lokalnych modułów Swift/Kotlin już tak.
JS, teksty i zgodne assety mogą trafić przez OTA.

1. Planner wywołuje `scripts/mobile-version.sh <tag>`, który wpisuje wersję marketingową
   do roboczego `app.json`, a pełną wersję wydania do `canopy-version.json`. Następnie oblicza osobny
   fingerprint iOS/Android przez `eas fingerprint:generate --build-profile …`. Build i publikacja
   korzystają z tego samego środowiska EAS `production`, niezależnie od kanału.
2. Wyszukuje ukończone buildy po kanale i `runtimeVersion`. Zgodny iOS store build oznacza OTA
   zamiast nowego buildu. Brak zgodnego iOS oznacza pełny build i wysyłkę do TestFlight przez
   profil submit `production`. Aktywny build tego runtime blokuje kolejne zlecenie.
3. Jeśli choć jedna platforma ma zgodny build, osobny publisher wysyła niepodpisane OTA przez
   `eas update --channel … --platform all --environment production`. Android nie wymusza buildu
   iOS. Gdy zmieniło się wyłącznie native iOS, zgodny Android nadal może otrzymać OTA.
4. **APK nigdy nie powstaje automatycznie.** Po zmianie runtime Androida maintainer buduje go
   ręcznie. OTA dla nowego runtime nie zaktualizuje APK ze starym runtime.
5. Globalna kolejka nie anuluje publikacji. Planner pomija wydane SHA i ich starszych przodków,
   aktywne buildy oraz OTA o dokładnie tej samej wiadomości `Canopy <tag> (<pełny SHA>)` dla obu
   runtime na właściwej gałęzi, z pominięciem rollbacków. Podpis nie jest warunkiem deduplikacji.
   Błędy zapytań EAS zatrzymują planowanie. Nieudany/anulowany build można ponowić;
   niepełna publikacja OTA jest ponawiana jako kompletna grupa obu platform.

**Pierwsze wydanie po dodaniu `expo-updates` wymaga pełnego buildu natywnego.** Dotychczasowe
instalacje nie mają modułu. OTA zaczyna działać od kolejnej zmiany wyłącznie JS,
po instalacji nowego IPA lub ręcznie zbudowanego APK.

Usunięcie konfiguracji podpisu również zmienia fingerprint i wymaga pełnego buildu natywnego.
Build iOS wysłany do TestFlight z `nightly.104` zawiera certyfikat z PR #357 i przyjmuje tylko
podpisane OTA. Nie otrzyma niepodpisanych aktualizacji; trzeba zastąpić go nowym IPA.

### Kanały i uruchamianie aktualizacji

| Kanał | Gałąź | Profil iOS/TestFlight | Ręczny profil APK |
|---|---|---|---|
| `nightly` | `dev` | `production` | `preview` |
| `beta` | `next` | `production-beta` | `preview-beta` |
| `stable` | `main` | `production-stable` | `preview-stable` |

Kanał jest wpisany do binarki; nie ma przełącznika kanału w aplikacji. Każdy kanał EAS musi
wskazywać wyłącznie własną gałąź aktualizacji o tej samej nazwie. Planner odrzuca aliasy,
wstrzymane kanały i rollouty; nie przepina ich automatycznie. **Nie mapuj `beta`/`stable` do
`nightly`**, nawet przy tym samym fingerprint. Development client służy do pracy z Metro,
nie jest instalacją przypisaną do kanału wydania.

`updates.checkAutomatically: ON_LOAD` sprawdza aktualizacje na zimnym starcie.
`fallbackToCacheTimeout: 0` uruchamia od razu ostatni lokalny bundle (także offline);
pobieranie trwa w tle, a pobrany bundle działa od następnego zimnego startu.
Settings → General → About oraz centrum aktualizacji współdzielą stan telefonu:
sprawdzenie (`checkForUpdateAsync`), pobranie (`fetchUpdateAsync`) i jawne zastosowanie
(`reloadAsync`). „Apply next launch” odkłada restart; aplikacja nigdy nie restartuje się
automatycznie w trakcie pracy. Próba zastosowania przy niewysłanym tekście, plikach
(także w trakcie uploadu), niewysłanym cytacie, edycji kolejki lub wpisywaniu sekretu odkłada aktualizację
do następnego uruchomienia. Rejestr przechowuje wyłącznie funkcje sprawdzające zajętość,
bez treści szkiców; uwzględnia też kompozytory pozostawione pod Settings.

Centrum aktualizacji i Settings → Workers pokazują również aplikację komputera,
z którym telefon jest sparowany. Akcja Update pyta o restart tego komputera,
pokazuje znane aktywne tury jego workera i wyjaśnia automatyczne odzyskanie połączenia.
Ten sam rejestr niewysłanej pracy blokuje żądanie przed potwierdzeniem oraz przed
wysłaniem. Komputer używa istniejącego journalu `RemoteAppUpdate`, czeka na idle,
ogłasza przerwę gatewaya i raportuje wynik po restarcie. Starsza aplikacja lub
gateway bez capability pokazuje instrukcję jednorazowej aktualizacji w oknie komputera.
`Update all` nie restartuje domu telefonu. To zmiana JS/TS bez nowych modułów,
uprawnień ani konfiguracji natywnej; fingerprinty pozostają granicą zgodności OTA.

Wiersz pokazuje kanał, skrócone ID działającego OTA, datę oraz wersję docelowego JS
z `manifest.extra.expoClient.extra.canopyVersion`. Wbudowany bundle ma status `Bundled`,
klient developerski `Development build` bez akcji aktualizacji. „Read release notes”
odczytuje treść dokładnego tagu ze statycznego indeksu GitHub Pages, tego samego źródła
co changelog desktopu. Cache, ETag i fallback z backoffem opisuje
[updates.md](updates.md#release-i-mirror). Limit sprawdzeń aplikacji komputerów ma
neutralny stan „Checks paused” z czasem wznowienia.
Nie zastępuje jej nowszym wydaniem kanału, które może nie być zgodne z runtime telefonu.
Przy rollbacku lub braku metadanych pokazuje brak notatek i link do wydań;
błąd sieci pozwala ponowić odczyt.

### Wersja działającego bundle

`apps/mobile/canopy-version.json` jest źródłem mobilnej stałej `CANOPY_VERSION`
(`src/version.ts`). Metro umieszcza wartość bezpośrednio w JS zarówno dla iOS, jak i Androida.
Nie korzystamy tu z `process.env.CANOPY_VERSION`: Metro nie wstrzykuje tej zmiennej,
a zdalny build EAS nie dziedziczy lokalnego środowiska workflow. EAS kopiuje zmodyfikowane
pliki drzewa roboczego, więc build natywny oraz `eas update` dostają tę samą pełną wersję,
np. `0.2.0-nightly.105`, `0.2.0-beta.3` lub `0.2.0`. `app.config.ts` pokazuje ją także
w `expo.extra.canopyVersion`; `bunx expo config --type public` pozwala sprawdzić przygotowanie.

Settings pokazuje wersję działającego JS, również po OTA; nie odczytuje wersji natywnej
zainstalowanego IPA/APK. Wiersz About → Updates nadal pokazuje kanał i tożsamość aktualizacji.
Mobilny klient nie wykonuje sprawdzeń `WORKER_LINK_PROTOCOL`; wersje gatewaya i workerów
w ich ustawieniach pochodzą z odpowiedzi gatewaya, nie z wersji telefonu.

Ręczny APK korzysta z tego samego przygotowania (polecenia z katalogu repozytorium):

```bash
bash scripts/mobile-version.sh v0.2.0-nightly.105
cd apps/mobile
bunx eas-cli build --profile preview --platform android
```

Na checkoutcie tagu podaj dokładnie ten tag, a na `dev` tag wydania, które świadomie budujesz.
Dla beta/stable wybierz odpowiednio `preview-beta`/`preview-stable`. Lokalny build developerski
ma `0.0.0-dev` z commitowanego pliku; po przygotowaniu wydania przywróć go poleceniem
`bash scripts/mobile-version.sh dev` lub odtwórz oba pliki przez
`git restore -- apps/mobile/app.json apps/mobile/canopy-version.json`. Skrypt tylko zapisuje
pliki, nie publikuje, nie taguje i nie commitowuje zmian.

Numer wydania nie jest wejściem natywnego fingerprintu: plik JSON jest źródłem JS,
a preset `balanced` SDK 58 pomija wersję marketingową i numer buildu. Hook w
`fingerprint.config.js` usuwa wyłącznie `extra.canopyVersion` z hashowanej konfiguracji;
pozostałe pola `extra` nadal wpływają na runtime.
Po zmianach konfiguracji sprawdź lokalnie `bunx expo-updates fingerprint:generate --platform ios`
oraz `--platform android` przed i po dwóch różnych tagach; hashe dla każdej platformy muszą
pozostać identyczne. Zmiana wersji JS nie wymusza nowej binarki i nie blokuje OTA.

### Niepodpisane OTA i własny serwer

Na planie EAS Starter publikujemy OTA **bez podpisu kodu**. Podpisywanie w hostowanym EAS Update
wymaga planu Production lub Enterprise. Pierwsza publikacja po PR #357/#360 (przebieg
`42501709806`, `nightly.104`) została odrzucona z komunikatem:

> EAS Update code signing requires a subscription to the EAS Production or Enterprise plan.
> This account (itsol) currently has a subscription to the Starter plan.

Decyzją maintainera usunięto certyfikat, `codeSigningCertificate` i `codeSigningMetadata`
z konfiguracji aplikacji. Publisher nie wymaga klucza prywatnego ani `--private-key-path`.
Sekret GitHub Actions **`EXPO_UPDATES_PRIVATE_KEY` pozostaje w repozytorium jako nieużywany**,
na przyszły powrót podpisywania; workflow go nie odczytuje ani nie przekazuje.

**Zaufanie do aktualizacji opiera się teraz na EAS i HTTPS.** Klient nie weryfikuje niezależnego
podpisu Canopy, więc przejęcie konta EAS lub usługi dystrybucji może pozwolić na podmianę kodu
JS. HTTPS chroni transport, ale nie zastępuje podpisu wydawcy. Podpisywanie wróci wraz
z firmowym serwerem Expo Updates: certyfikat i metadane podpisu wrócą do konfiguracji,
certyfikat do wejść fingerprintu, a nowe binarki będą weryfikować podpisy Canopy.

Granice przyszłej migracji na własny serwer protokołu Expo Updates są dwie: **jedna wartość
`updates.url` w `apps/mobile/app.json`** oraz **jeden skrypt publikacji
`scripts/mobile-publish-update.sh`**. Zastąp URL i implementację publikacji manifestów/assetów
oraz operacje `latest`/`status` tego skryptu, zachowując kanały, runtime i metadane wydania.
Powrót podpisywania wymaga dodatkowo opisanej wyżej konfiguracji certyfikatu i nowych binarek.
Odczyty historii OTA i walidacja kanałów są w tym samym adapterze;
planner nadal używa EAS do inwentarza buildów. Buildy mogą pozostać w EAS. Zmiana URL wymaga
nowej binarki; stare instalacje nadal pytają stary URL, więc utrzymuj go do końca migracji.

W razie wadliwego JS zatrzymaj dalsze publikacje i opublikuj ponownie ostatnią dobrą grupę
na tym samym kanale/runtime przez `eas update:republish --channel <kanał> --group <grupa>`.
Na EAS Starter nie podawaj klucza podpisu. Zmiana natywna wymaga nowego buildu. Wersję
działającego OTA ustala wiersz Updates; manifesty i historię grup pokazuje EAS.

- **Aplikacja:** w App Store Connect nazywa się „Canopy Remote”. Ma bundle id
  `tech.itsol.canopy-remote`, ASC app id `6768351426` i zespół `5XWLF3YKWM`.
  Android używa `tech.itsol.canopy_remote`, bo nie dopuszcza myślnika. Zmiana z dawnego
  `app.canopy.mobile` tworzy nową aplikację: stary APK trzeba odinstalować i sparować telefon ponownie.
- **Wersja:** App Store przyjmuje trzy liczby, więc `0.2.0-nightly.84` trafia jako `0.2.0`.
  Workflow wpisuje ją do `app.json` tylko w kopii roboczej. EAS kopiuje drzewo robocze, więc nic nie
  jest commitowane. Numer buildu prowadzi EAS (`cli.appVersionSource: remote`, `autoIncrement`).
  Przy OTA wersja natywna pozostaje wersją zainstalowanego buildu; pełna wersja JS pochodzi
  z `canopy-version.json`, a tag i SHA są także wiadomością OTA.
- **Konto:** sekret repozytorium `EXPO_TOKEN` daje dostęp do organizacji `itsol`.
- **Poświadczenia:** certyfikat dystrybucyjny i profil provisioningowy trzyma EAS. Pierwszy raz
  tworzy je interaktywnie ktoś z dostępem do zespołu Apple:
  `bunx eas-cli credentials -p ios` w `apps/mobile`, profil `production`. Wysyłkę do App Store
  Connect obsługuje klucz API podpięty do aplikacji w Expo. Gdy certyfikat albo profil wygaśnie,
  build w CI kończy się błędem `Credentials are not set up`. Wtedy trzeba je odnowić tą samą
  komendą.

## Interfejs zgodny z web

Settings → GitHub ma tę samą obsługę kont co web/desktop: wybór domu, device flow
z kopiowaniem kodu i otwarciem zweryfikowanego adresu, stany oczekiwania/sukcesu/
wygaśnięcia/odmowy/anulowania, katalog instalacji i repozytoriów, Install Canopy,
Manage repositories, jawny wybór PAT z Connectors oraz Disconnect z potwierdzeniem.
`features/github/ConnectGitHub` jest osadzone także przy operacjach PR;
sukces logowania niczego nie publikuje. SecureStore zachowuje wyłącznie identyfikatory
próby/żądania przypisane do parowania i domu, bez kodu urządzenia ani tokenów GitHub.
AppState wstrzymuje odpytywanie w tle; powrót odświeża stan i katalog.
Zmiana używa już obecnych Clipboard, Linking, Crypto i SecureStore; nie zmienia
konfiguracji natywnej ani zależności. [Projekt i kontrakty](github.md).

Summary, Timeline, Code, review, lifecycle i metadane PR używają tych samych kontraktów co web.
Picker reviewerów oblicza różnicę zaznaczonych requestów; re-request jest osobną ikoną.
Checki, jobs i nagłówek logu mają ikonowe akcje re-run failed/all/job i cancel run.
Arkusz pokazuje run/attempt/SHA, skutki dla zależnych jobów i deploymentów oraz potwierdzenie cancel.
Accepted oznacza przyjęcie zlecenia; watch/polling dostarcza stan queued/in-progress.
Wyłączona akcja wyjaśnia brak praw lub zewnętrznego dostawcę CI. Utrata połączenia nie kolejkuje zapisu.

Panel bota pozwala wstrzymać/włączyć i usunąć rutynę oraz anulować przypomnienie.
Usunięcie rutyny wymaga potwierdzenia. Akcje są dostępne wyłącznie przy aktywnym
odczycie rozmowy i dostępnym domu. Menu bota (przycisk lub długie przytrzymanie
wiersza) obsługuje przypinanie, edycję, archiwizację, usuwanie i przenoszenie.
Sekcja **Archived bots** udostępnia archiwum i przywracanie rozmów.

Kreator otwiera wybór pierwszego modelu. Walidacja nazwy (w tym duplikatów)
i normalizacja koloru `#RGB`/`#RRGGBB` są wspólne z kreatorem web w `domain/bot-draft`.
Gateway nadal waliduje zapis. Oczekująca karta zgody oferuje **Change approval policy**
przez istniejący `UpdateBot`; zmiana polityki nie stanowi odpowiedzi na kartę.

Telefon pokazuje szczegóły każdego importu (`GetImportRun`), błędy pozycji i akcję
**Open thread**. Nowe pozycje biblioteki sugerowane przez gateway są zaznaczone;
konflikty i kopiowanie sekretów wymagają osobnego wyboru. **Import CLI threads**
w szczegółach lokalnego workera i pustej liście wątków otwiera import tego komputera.

**Move to a computer** w akcjach lokalnego wątku i ustawieniach bota otwiera
podgląd przeniesienia pojedynczej rzeczy. Telefon wybiera bezpośrednio połączony,
dostępny komputer i docelowy workspace projektu, śledzi trwały przebieg i otwiera
nowy identyfikator. Gateway sprawdza dom, placement i dostępność ponownie przy starcie.

Ustawienia providera oferują **Move to a proxy** dla połączenia zapisanego
w zmiennych środowiska. Telefon przekazuje nazwę i rewizję; zapisany sekret
przenosi wyłącznie gateway.

Przegląd środowiska pokazuje podsumowanie zmian, skrypty/pliki wykonywalne,
usunięte pliki oraz obie wersje treści. Przy wybraniu wersji skilla telefon
pobiera jej niezmienny artefakt przed zatwierdzeniem; błąd pobrania blokuje zapis.

Prośby o sekret otwierają osobny arkusz „Thread secrets”. Pole jest zawsze zamaskowane,
bez autofill, korekty i sugestii; wysłanie, zamknięcie lub przejście aplikacji w tło
usuwa lokalną wartość. Save securely i Decline korzystają z `AnswerThreadSecret`,
a Revoke z `RevokeThreadSecret`. Szczegóły wątku i arkusz pokazują wyłącznie nazwy
aktywnych grantów i termin wygaśnięcia nadany przez gateway (24 godziny).
Po utracie live lub domu wątku kontrolki są nieaktywne. Gateway weryfikuje właściciela
i ważność urządzenia; bezpośrednie łącze kieruje odpowiedź do domu wątku.
Sekrety nie trafiają do cache draftów, transkryptu ani komunikatów błędów.

Overview uzgadnia projekty, workery i wątki po stabilnym id, także przy powtórzonych
snapshotach partnera i starszych aktualizacjach pojedynczych wierszy. Nowy wątek,
filtr sidebara i domyślne workspace'y używają wspólnego `projectChoices`: jeden
**No project** oraz wspólne projekty według globalnego id lub jednoznacznego origin.
Katalog nadal należy do oryginalnego `workspace.project_id`; scalenie nie zmienia
trasowania ani właściciela. Wybór workera pokazuje jeden wiersz na worker i grupy
komputerów; dla scratch uwzględnia też wyłączone workery bez katalogu scratch.
Osobne projekty o tej samej nazwie mają w szczegółach komputer i workspace.
Settings → Projects scala prezentację, lecz edytuje lokalny rekord i jego ustawienia;
zdalne workspace'y pozostają tylko do odczytu. Nazwy komputerów opisują również
workery w ustawieniach. Sekcje pickerów mają stabilne klucze niezależne od nazw.

Pierwszy odczyt danych pokazuje szkielety z `src/ui/Skeleton.tsx`, zgodne z web:
zaokrąglone pola o niskim kontraście i delikatny puls, wyłączony przez systemowe
ograniczenie ruchu. Znane formularze zachowują zamontowane wiersze i wymiary kontrolek;
listy przed poznaniem ich długości używają szkieletów wierszy. `ResourceState` pokazuje
szkielety tylko bez pierwszego wyniku, a podczas odświeżania zachowuje dane. Błędy
i puste stany pozostają tekstem. Workspace’y i domyślne ustawienia projektu współdzielą
jeden zasób z Projects; nie pobierają ustawień osobno dla każdej karty.

Pair → Threads/Bots → Thread/Chat, plus Settings i New thread. Lista pokazuje projekt,
worker/katalog, ikonę providera, czas i stan jak web; aktualizuje się przez WatchOverview.
Są wyszukiwanie, filtr projektów i Archived. WatchThread składa
snapshot i delty współdzielonym reducerem `thread-snapshot`. Przełączenie wątku od razu
pokazuje kopię z pamięci, a po restarcie odczytuje ją z prywatnego katalogu
`expo-file-system` (`Paths.cache/thread-snapshots-v1`). System może usunąć cache;
wtedy aplikacja pobiera ostatnie 24 pełne tury. Nie używa współdzielonego storage ani nie
dodaje zależności natywnych. LRU mieści 16 wątków / 64 MiB protobuf na dysku,
maksymalnie 16 MiB na wpis, oraz 16 wątków / 24 MiB w pamięci. Wpisy przekraczające
limit nadal działają online, ale nie są utrwalane. Zapis pliku tymczasowego i rename
chronią przed częściowym odczytem; uszkodzony wpis jest usuwany.

Przez cały czas działania widocznej aplikacji overview wybiera do dogrzewania
10 ostatnich korzeni według filtrów paska, wątki pracujące, nieobejrzane wyniki
i przypięcia, łącznie najwyżej 16. Archiwum jest wykluczone.
Ostatnie korzenie wybieramy według `Last activity` (ostatnia odpowiedź, a przy jej
braku data utworzenia), również gdy lista pokazuje `Created` lub `Custom`.
Ręczna kolejność i pozycja przypięcia nie zastępują recency; przypięcia dołączają
osobno w ramach tego samego limitu. Projekt i zapytanie ograniczają wybór korzeni.
Jeden overview niesie heady tego zestawu; nie otwieramy osobnych subskrypcji wątków. Zmiana headu uruchamia
skończony `WatchThread(sequence=true, background=true)` od checkpointu z tego samego
trwałego cache. Daleki lub brakujący checkpoint dostaje tylko ograniczony ogon.
Zapis zachowuje najwyżej 128 itemów / 384 KiB i do 24 ostatnich tur oraz potrzebne
zależności w budżecie 64 KiB tur; starsza historia pozostaje stronicowana.

Najwyżej jedno zadanie pracuje naraz i startuje co najmniej 5 s po poprzednim
(do 12 odczytów/min). Zmiany tego samego headu są scalane, a kolejne wątki mają
rotacyjne pierwszeństwo, żeby ciągły streaming jednego nie blokował pozostałych.
Powrót na foreground zaczyna od widocznych ostatnich wątków. Background, inactive,
offline i niedziałający overview anulują pracę; tapnięcie anuluje odczyt przed
nawigacją i zostawia 500 ms dla ekranu. Jeśli istniejący binary udostępnia moduł
SDK 58 `ExpoBattery`, stan Low Power Mode i jego zdarzenia również zatrzymują tło.
Bez tego opcjonalnego modułu wykrywanie oszczędzania energii jest niedostępne;
nie dodajemy zależności wymagającej przebudowania aplikacji.

Diagnostics mierzy czas od tapnięcia do rAF z aktualnym ogonem po layout, odsetek
otwarć z checkpointem zgodnym z ostatnim headem, liczbę odczytów w tle i bajty
protobuf w pamięci cache. To proxy JS, nie czas prezentacji natywnego kompozytora;
payload nie oznacza heap/RSS. Cache i zadania pozostają w zakresie parowania oraz
pinu certyfikatu, a unpair zamyka istniejącą ścieżkę zapisu.

Kolejne zapisy tej samej niemutowalnej rewizji współdzielą serializację i trwający
zapis, również przy wyjściu z ekranu. Nowa rewizja, odczyt albo inny wątek
unieważniają to uproszczenie. Błąd dysku pozwala ponowić zapis tej samej rewizji;
unpair nadal od razu zamyka ścieżkę zapisu. Nie zwiększa to limitów pamięci.
Przygotowanie osi czasu zachowuje tablice itemów niezmienionych tur, dzięki czemu
`TimelineTurn` nie buduje ponownie drzewa ich pracy przy delcie innej tury.
Grupowanie dzieci subagenta dopisuje do tablic zamiast kopiować rosnącą grupę.
Pomiary JS i ograniczenia profilowania: [client-performance.md](client-performance.md).

`WatchThread` wysyła `sequence=true` i ostatni atomowy `syncCursor`. Gateway odpowiada
partiami rekordów od ostatniego seq albo ograniczonym oknem według reguł w `ui-api.md`.
Klient zatwierdza checkpoint po atomowym zastosowaniu partii współdzielonym reducerem.
Zimny odczyt prosi o 24 pełne tury, czat bota i wymiana o 50 wiadomości.
Przewinięcie do starszego końca odwróconej listy pobiera poprzednią stronę;
„Show earlier messages” pozwala też ponowić odczyt lub rozwinąć krótką listę.
`maintainVisibleContentPosition` utrzymuje widoczny element przy dopisaniu historii.
Pozycja czytania jest lokalna dla telefonu i parowania: istniejący magazyn
`DeviceViewPreferences` zachowuje LRU 100 wątków, z podążaniem za końcem albo
kluczem wiadomości, jej tury i offsetem wewnątrz wiadomości. Pomiar wiadomości
jest niezależny od wysokości pracy nad nią. Powrót i restart odtwarzają wyłącznie
kotwice w załadowanym oknie; fold i grupa zawierające kotwicę otwierają się przed
pozycjonowaniem. Brak wiadomości oznacza koniec,
bez dodatkowych odczytów. Lista pozostaje przezroczysta do ustawienia pozycji.
Próby odnalezienia niezmierzonej komórki są ograniczone; odtworzenie nie animuje
przewijania i pokazuje zwinięty kompozytor z „Jump to latest” przy czytaniu historii.
Nowe wiadomości w tle nie odciągają od zapamiętanej historii, a czytelnik
podążający za końcem wraca do najnowszej wiadomości. Zapis przy końcu gestu,
zmianie widocznych tur, wyjściu z ekranu i przejściu w tło zostaje na urządzeniu.
Wyszukiwanie obejmuje wejścia i odpowiedzi agenta; wpisane zapytanie doczytuje
strony do początku historii. Zwykłe otwarcie ani restart nie uruchamia tego odczytu.
Cache zachowuje całe dotąd załadowane okno z granicą strony i kursorem.
Po dołączeniu strony watch wznawia się od checkpointu sprzed odczytu, żeby odtworzyć
również równoległe edycje starszych wiadomości. Karty zgód pozostają nieaktywne do
potwierdzenia live. Wyjście z ekranu anuluje odczyt.
Starszy gateway ignoruje pola stronicowania i zwraca całość.
Stan połączenia wygląda jak w web: stopka listy pokazuje kropkę i „Connected”, „Reconnecting…”
albo „Gateway unavailable” (stream bez odpowiedzi dłużej niż 12 s, jak `live-source.ts` w web);
tapnięcie otwiera arkusz ze zdaniem o stanie, kodem ostatniego błędu i małym „Reconnect now”.
Pod nagłówkiem ekranu (lista, wątek, czat bota, Settings) pojawia się wąski baner: ostrzeżenie
„The gateway is not responding…” albo „You’re offline…”, a w wątku i czacie bota informacja
„Reconnecting to live updates…”, gdy gateway odpowiada, ale stream tego ekranu się zerwał.
Po utracie połączenia backoff z jitterem rośnie od około 1 do 30 sekund;
powrót z tła lub odzyskanie sieci używa tego samego kursora. Cichy napis `Syncing…`
zajmuje stałe miejsce przy końcu timeline. Wysyłka i stop czekają na stan live;
pozostałe operacje, w tym odpowiedzi na zgody i edycja kolejki, nadal trafiają do
autorytatywnego gatewaya. Brak kopii oznacza skeleton timeline; nagłówek, model i
worker korzystają z overview/listy zamiast tymczasowych nazw.

Otwarcie z listy (także wątku bocznego lub archiwalnego) najpierw odczytuje lokalny
cache, bez oczekiwania na sieć. Dopiero potem rozpoczyna push/replace, więc pierwszy
render korzysta z `peek`, razem z czasami tur. Kolejne tapnięcie lub zmiana parowania
unieważnia oczekującą na dysk nawigację. Bez wpisu pozostaje skeleton historii.
Katalogi modeli są przechowywane w pamięci przez czas życia klienta parowania
i pobierane już przy widocznej liście workerów; kompozytor odczytuje je synchronicznie.
Model, effort i uprawnienia następnej tury odtwarza `Thread.last_user_turn_choices`
według wspólnej z web funkcji `domain/composer-choices`. Jawny wybór w szkicu ma
pierwszeństwo i idzie z wiadomością, bez zmiany domyślnych wątku. Po ponownym
otwarciu aplikacji gateway odtwarza ostatni wysłany wybór, również na innym urządzeniu
i przez połączony komputer; szczegóły: [ui-api.md](ui-api.md#wybory-następnej-tury).
Pigułki modelu, effort i uprawnień dopasowują szerokość do etykiet. Nieznany katalog pokazuje
kompaktowe skeletony modelu i effort (128/72 dp) zamiast surowego identyfikatora modelu;
model bez effort nie rezerwuje pustego miejsca. Toolbar jest wyrównany do prawej, więc
po zimnym odczycie katalogu grupa rośnie w lewo, a przyciski wysyłania pozostają w miejscu.
Stopka zakończonej tury zachowuje wysokość linii,
nawet gdy czasy nie są jeszcze dostępne, tak jak `TurnDetails` w web.

Androidowy build deweloperski wyłącza `expo-build-properties.android.networkInspector`.
Inspektor Expo podgląda do 1 MiB odpowiedzi HTTP/2 przed przekazaniem jej aplikacji;
dla cichego, otwartego strumienia Connect oznacza to blokadę małych delt i overview.
Nie zmienia to transportu, pinowania TLS ani autoryzacji; wyłącza tylko podgląd sieci
w narzędziach deweloperskich.

Cache zawiera wyłącznie `ThreadSnapshot`: metadane `ThreadSecret`, nigdy wartości
sekretów, ciphertext, token urządzenia ani ustawienia providera. Zwykły tekst historii
pozostaje prywatnymi danymi rozmowy. Katalog jest izolowany przez id urządzenia i pin
certyfikatu. Unpair i wykryte `Unauthenticated` po revocation zamykają cache i usuwają
pamięć oraz pliki; fence i serializacja uniemożliwiają przywrócenie ich przez spóźniony
zapis. Bez sieci urządzenie nie może wykryć zdalnego cofnięcia dostępu. Zapis łączy
zmiany w okna 2 s (także przy ciągłym streamingu) i jest wykonywany też przy wyjściu
z ekranu lub przejściu w tło.
Nie ma kolejki wysyłania offline.

Rozmowy botów i wymiany „Message from…” / „N messages with…” mają osobny wspólny
LRU: 16 widoków / 32 MiB na dysku, najwyżej 8 MiB na wpis, oraz 6 widoków / 16 MiB
w pamięci. Używają tego samego adaptera atomowych plików w prywatnym
`Paths.cache/bot-snapshots-v1`, izolowanego przez urządzenie i pin certyfikatu.
System może usunąć te pliki. Nie wymagają nowych modułów natywnych. Cache zapisuje
wyłącznie publiczne `BotConversation` i `ReadBotExchangeResponse`, nigdy tokeny,
poświadczenia connectorów, konfigurację providera ani checkpoint modelu. Zwykła treść
rozmowy pozostaje prywatnymi danymi użytkownika.

Przed połączeniem widoczna jest kopia z pamięci lub dysku i ciche „Syncing…”.
Brak kopii daje współdzielony `ConversationSkeleton`; nazwa i awatar pochodzą z listy
botów lub zapisanej projekcji. `WatchBotConversation` oraz `ReadBotExchange` wysyłają
ostatni atomowy kursor. Wymiany odświeżają przyrost co 5 s na aktywnym ekranie;
rozmowa używa strumienia. Kursor obejmuje również edycje i stan kart, nie tylko `seq`.
Wysyłka, stop i wszystkie odpowiedzi na zgody (także „Always allow…”) czekają na live.
Granica mutacji ponownie sprawdza, czy karta jest nadal pending w potwierdzonym stanie.
Unpair i revocation jednocześnie zamykają oba cache przed usunięciem poświadczeń;
spóźnione zapisy nie mogą ich odtworzyć. Lista usuwa kopie botów zarchiwizowanych,
usuniętych lub przeniesionych oraz wymiany, w których te boty uczestniczyły.

Wysłanie po timeout używa tego samego client_request_id do czasu zmiany treści/trybu,
więc ręczny retry nie dubluje tury.

`packages/ui` współdzieli z web geometrię ikon Tabler outline i osobne logotypy providerów, kształty i kolory mascotów,
nazwy/kolejność Settings i akcentów. `tokens.ts` opisuje skalę typografii, spacing, radii
i statusy według `apps/web/src/app.css` oraz `shared/ui/status.ts`. Paleta RN jest generowana
z dokładnie tej samej wersji Tailwind co web: `bun --cwd packages/ui gen`. Konwersja
OKLCH → sRGB jest konieczna dla natywnego parsera kolorów; `gen:check` wykrywa rozjazd palety
i wersji Tailwind. CSS web nadal używa Tailwind; zmiany jego skali typografii/radii
trzeba przenosić do wspólnych tokenów świadomie.

Kit `src/ui` odpowiada `apps/web/src/lib/shared/ui`: `Button` (primary, secondary, ghost, danger;
`md` 40 dp, `sm` 32 dp, w Settings 44 dp; nagłówki grup i banery dają `sm`), `IconButton`,
`Alert` (info, warning, danger, error, wariant banner), `Notice` (wyciszony tekst, błąd jako `Alert`),
`EmptyState`, `Switch`, `Checkbox`, `SearchField`, `Segmented`, `Field`, `Sheet` i jedno okno
potwierdzenia `confirm()` zamiast natywnego `Alert.alert`. Cel dotyku 44 dp daje `hitSlop`,
wymiary widoczne zostają jak w web.

Typography przechowuje na urządzeniu osobny wybór fontu interfejsu i kodu. Presety
pozostają na początku wyszukiwanego pickera; nazwy mają podgląd we własnym kroju.
Lista JS obejmuje wbudowane rodziny platformy: iOS System/SF, New York (`ui-serif`),
Georgia, Avenir Next, Helvetica Neue, Times New Roman, Menlo i Courier; Android
Roboto i jego odmiany, Noto Serif (`serif`) oraz `monospace`. Picker kodu ogranicza
listę do rodzin monospace. Dowolne fonty doinstalowane przez użytkownika nie są
dostępne: ich enumeracja wymaga natywnych API, których ta zmiana JS nie dodaje.
Nie zmienia konfiguracji natywnej ani zależności; fingerprint EAS pozostaje granicą
zgodności aktualizacji. Brak rodziny używa domyślnego fontu platformy.

RN używa StyleSheet i Inter 400/500/600 (pakiet fontu, bez pobierania z sieci), SVG
z tych samych ścieżek i FlatList. Aplikacja działa edge-to-edge. Klawiaturę obsługuje
`react-native-keyboard-controller` **1.22.7** (wersja dobrana przez `bunx expo install`):
`KeyboardProvider` w root przekazuje natywne klatki do Reanimated, także przy interaktywnym
zamykaniu. Moduł wymaga nowego development buildu; sam bundle JS/OTA nie wystarczy.
`KeyboardWindow` zbiera `onMove`, `onInteractive` i `onEnd` z `useKeyboardHandler` do wspólnych
wartości `useKeyboardFrame`. Nie bierze pozycji z `onStart`, bo na iOS jest to cel animacji.
`FloatingComposer` przesuwa nakładkę na wątku UI według tych klatek, bez własnej krzywej ani
czasu animacji. Feed zachowuje pełny viewport: `TimelineList` używa na Androidzie
`KeyboardChatScrollView` z odwróconą listą, `keyboardLiftBehavior="always"` i dolnym insetem.
Na iOS `IOSChatScrollView` uzgadnia inset i offset w każdej natywnej klatce, zachowując
odległość od końca listy; interaktywny gest i jego końcowe domknięcie zostawiają offset UIKit.
Inset safe area jest oddzielony od pomiaru kompozytora; pod klawiaturą zastępuje go IME.
`useFollowingList` normalizuje ujemny offset insetu iOS; kotwica foldu i „Show latest”
uwzględniają go także przy otwartej klawiaturze. `ChatKeyboard` wiąże region gestu z polem:
iOS używa `interactive`, Android natywnego `KeyboardGestureArea` oraz insetów edge-to-edge.
Zmiany klawiatury nie liczą się jako gest zwijający kompozytor. Formularze New thread,
Pair i Settings korzystają z `KeyboardViewport`, którego padding także śledzi klatki na UI.
Pełne arkusze i pickery mają własny provider w natywnym oknie. Jasny/ciemny motyw
oraz niezależne palety Light/Dark są ustawieniami gatewaya, synchronizowanymi między klientami.
Settings korzysta ze wspólnych tokenów tematów Birch, Fern, Lagoon, Cedar, Heather,
Blossom i Ash. Preferencje urządzenia (typografia, kontrast, diffy i format czasu)
pozostają w SecureStore telefonu i nie zmieniają preferencji przeglądarki.
Rozwinięcie archiwum wątków i botów oraz zwinięcie sidebara również należą do telefonu
(`DevicePreferences`, wspólny `@canopy/domain/device-view`). Filtr projektów,
grupowanie i kolejność grup także należą do tego telefonu. Stan widoku jest zapisany
w `canopy.client-view.v2.<scope>.json` w katalogu dokumentów, osobno dla certyfikatu
gatewaya i identyfikatora parowania. Stary `canopy.settings.view.v1` w SecureStore
jest tylko źródłem migracji geometrii. Wartości przetrwają odmontowanie
listy i restart aplikacji. Otwarcie archiwalnego wątku rozwija tylko lokalne archiwum;
nie zmienia stanu desktopu ani webu. Brakujące wartości są jednorazowo inicjalizowane
ze starych pól konta, bez ich aktualizowania. Przypięcia nadal są ustawieniem konta;
pełna klasyfikacja jest w [settings-map.md](settings-map.md).
Na wąskim oknie sidebar jest natywnym ekranem listy (stos lista → wątek); web na telefonie
otwiera go jako drawer. Od 600 dp szerokości okna (klasa large screen Androida: tablety,
rozłożony foldable, telefon w poziomie) lista zostaje obok otwartego wątku lub czatu, jak
w desktopowym web (`src/state/layout.tsx`). Ma 260–320 dp, zaznacza otwarty wątek i chowa się
przyciskiem listy w nagłówku. Układ zależy od szerokości okna, nie typu urządzenia, więc
składanie, obrót i zmiana rozmiaru przełączają go na żywo; aplikacja nie blokuje orientacji.
Przekroczenie progu szerokości odtwarza kolumnę sidebara od razu w docelowym stanie,
bez oczekiwania na callback zamknięcia. Powrót do pionu nie rezerwuje więc miejsca na
znikający sidebar i nie zwęża przejściowo wątku. Ręczny przycisk nadal animuje panel.
`ui/ScreenFrame.tsx` stosuje insets do kontrolek, bez obcinania tła ani viewportu listy.
Nagłówki i stopka sidebara są półprzezroczystymi nakładkami; ich zmierzona wysokość
powiększa padding końców list, więc pierwszy i ostatni wiersz są dostępne w całości.
Podczas przewijania wiersze przechodzą pod nagłówkiem i paskiem stanu. Ikony paska stanu
zmieniają jasność wraz z motywem, a powierzchnia nagłówka utrzymuje ich kontrast.
`ScreenScroll` stosuje padding treści w New thread, Pair, Settings i arkuszach szczegółów.
Timeline wątku i bota ma odwrócone końce: górny inset jest na najstarszym końcu,
a dolny rezerwuje rzeczywistą wysokość kompozytora wątku lub bota
i oddzielny inset safe area. Tło kompozytora sięga pod
home indicator; pod klawiaturą inset zastępuje jej rzeczywisty overlap.
W podziale na kolumny tylko sidebar dostaje lewy inset, a główny panel prawy; po ukryciu
sidebara główny panel dostaje obie krawędzie. Lewy inset powiększa szerokość kolumny sidebara,
zamiast zabierać miejsce jej treści. Settings stosuje tę samą regułę do własnych kolumn:
nawigacja ma 256 dp użytecznej szerokości, a długie etykiety przy większym rozmiarze tekstu
kończą się wielokropkiem. W szerokim układzie brak wyboru otwiera General; wąski nadal
zaczyna od listy sekcji. Nagłówek wyrównuje tytuły do kolumn i chroni zamknięcie prawym insetem.
Pełne arkusze mierzą safe area we własnym `SafeAreaProvider`; dolne pickery chronią
akcje insetem dolnym i bocznymi, także w poziomie. Zawias: Expo nie udostępnia
`FoldingFeature`; zawias Galaxy Z Fold po rozłożeniu nie zasłania ekranu, więc nie omijamy go.
Urządzenie z zasłaniającym zawiasem wymagałoby modułu natywnego (Jetpack WindowManager). Panele
szczegółów są sheetami. Każdy wybór (model, effort, uprawnienia, projekt, worker, instancja
dostawcy, menu akcji) używa jednego `PickerSheet` (`src/ui/Picker.tsx`): kompaktowy dolny arkusz
z zaokrąglonymi rogami, wierszami ≥ 48 dp, nagłówkami sekcji, wyszukiwaniem przy długich listach
i znacznikiem wyboru; na oknach od 600 dp otwiera się jako karta na środku. Teksty nakładek
biorą stopnie `contextType` z `packages/ui` (docs/ui-scale.md), ruch tokeny `motion`;
przy ograniczeniu ruchu arkusze zmieniają położenie natychmiast (sekcja „Ruch”). Full access wymaga potwierdzenia
przy każdym wyborze, jak w web. Feed wątku i czat bota są odwróconymi listami: otwierają się
na ostatniej wiadomości, podążają za nowymi na dole i trzymają pozycję podczas czytania historii. Nazwy komponentów odpowiadają web, m.in. SidebarThread,
ThreadHeader, MessageComposer/ComposerBox, ThreadPanel, AppearanceSettings,
BotAvatar, ChatBubble i BotDetailsPanel. Brand assety pochodzą z `apps/web/static`.

Kompozytor wątku (także bocznego) i czatu bota jest nakładką nad feedem, z powierzchnią,
obramowaniem i cieniem w jasnym motywie oraz wygaszeniem tła na 32 dp jak w web.
`features/composer/FloatingComposer.tsx` ma osobny pas gradientu o stałej wysokości **32 dp**
nad górną krawędzią pola; gradient nie rozciąga się na pełną wysokość kontenera.
`ComposerCoverage` mierzy cały widoczny stos na wątku UI: pole, toolbar, dolny wiersz,
zawinięte cytaty, załączniki, podsumowania w kompakcie, zasobnik i statusy. Natywny inset
listy udostępnia dokładnie ten obszar do przewinięcia; safe area jest dodawana tylko raz
przez scroll view, razem z bieżącą klawiaturą. Nie ma stałej rezerwy w nagłówku listy.
Przy końcu iOS zatwierdza inset i offset razem, a Android korzysta z `extraContentPadding`
i `whenAtEnd`; historia nie przesuwa się podczas czytania powyżej końca. Pomiar nie
przechodzi przez React na każdej klatce i zatrzymuje się po opuszczeniu ekranu.
Nagłe zmiany naturalnej wysokości (np. dodanie cytatów) animuje zewnętrzny klip na
wątku UI; fold zachowuje własną krzywą. Sugestie pozostają poza klipem i pomiarem.
Oddzielny pomiar pola służy gestom `ChatKeyboard`. Pierwszy szacunek to 186 dp:
pole 64, toolbar 56, dolny wiersz 36, odstęp 8, padding 20 i obramowanie 2.
Bot zachowuje rezerwę zmierzonej wysokości swojego pola. Wiersz kontrolek najpierw odzyskuje
pełną wysokość, potem się rozjaśnia; przy zamykaniu znika przed zwężeniem klipu.
Decyzja o foldzie wymaga gestu czytelnika: próg końca to 8 dp, zwinięcia 192 dp i 96 dp
przebytej drogi w stronę starszych wiadomości. Każda zmiana foldu zużywa gest. Kolejny wymaga
nowego dotknięcia listy; samo zdarzenie momentum go nie tworzy. Zmiana wymiarów listy, insetu
klawiatury lub programowa korekta kotwicy unieważnia trwający gest. „Show latest” otwiera
kompozytor jawnie, bez rozpoznawania programowego scrolla jako gestu.
Lista podpowiedzi jest osobną
nakładką poza mierzonym kompozytorem: otwieranie, filtrowanie, doczytywanie i zamykanie
nie zmieniają rezerwy ani pozycji feedu. Nakładka mieści się między nagłówkiem a kompozytorem,
nad klawiaturą, z uwzględnieniem safe area; ma maksymalnie 240 dp i własne przewijanie bez
chowania klawiatury. Wejście i wyjście używają `pop`, przy ograniczeniu ruchu są natychmiastowe. Kotwica listy
pomija ten nagłówek. „Jump to latest” wątku ma stałą kotwicę nad zwiniętą krawędzią
i znika, gdy kompozytor jest rozwinięty.

Reguły zwijania pochodzą z webowego `ComposerCompaction`: co najmniej 192 dp od końca
i 96 dp ruchu ku starszym wiadomościom, rozwinięcie do 8 dp od końca albo po tapnięciu,
fokusie lub pisaniu. Liczą się tylko gesty czytelnika (od początku przeciągnięcia do końca
jego rozpędu), bez aktualizacji streamu, korekt kotwicy i zmian klawiatury. Synchroniczne
pytanie utrzymuje kompozytor otwarty. Mobile dodatkowo nie zwija niepustego szkicu,
załączników ani otwartej listy wzmianek. Decyzję podejmuje worklet przewijania
(`useAnimatedScrollHandler` w `useFloatingComposer`) na wątku UI i w tej samej klatce
uruchamia animację; React dostaje tylko zmianę stanu (zwinięty/otwarty, na dole/nie).
Pozycja przewijania żyje we wspólnej wartości (`useFollowingList`), więc listy rozmów
to listy Reanimated (`TimelineList`, `Animated.FlatList`). Wszystkie części kompozytora
czytają jedną wartość postępu (`ComposerMotionContext`): `ComposerFold` animuje własną
przyciętą wysokość i przezroczystość, a pole tekstowe i przycisk wysyłania swoje rozmiary
i położenie (tokeny `motion.slow` / `motion.medium`, `smoothOut`); ograniczenie ruchu
przełącza od razu. Androidowe pole tekstowe nie przyjmuje animowanych rozmiarów, więc
animuje się ramka wokół niego.

Podczas pisania (fokus pola) dolny pasek pozostaje widoczny: przycisk załączników, model,
effort oraz wysyłanie/stop. Chowa się tylko dodatkowy wiersz z workerem, celem i trybem
uprawnień (`motion.fast`, przy ograniczeniu ruchu od razu). Pole przejmuje wyłącznie jego
zmierzoną wysokość, więc kompozytor zachowuje wysokość, a tekst ma więcej miejsca.
Dolny pasek zachowuje własną wysokość i miejsce na wysyłanie/stop; podglądy dodanych załączników też zostają.
Wybory i załączniki zostają, bo kontrolki pozostają zamontowane. Po utracie fokusu albo
zamknięciu klawiatury kontrolki wracają (Android po zamknięciu klawiatury zostawia fokus
w polu, więc kompozytor sam je wtedy zdejmuje).
Na iOS i Androidzie każdy modal (w tym model, effort i spinacz) najpierw czeka na
`KeyboardController.dismiss()`, a następnie prezentuje własne okno. Nie ma stałego timeoutu.
Wyszukiwanie w pickerze otwiera nową klawiaturę, śledzoną przez provider jego okna.
Scrim pokrywa pełne okno niezależnie od insetów klawiatury; dolny sheet nie skaluje się
od krawędzi ekranu, więc nie odsłania bocznych ani dolnych szwów. Menu załączników
nadal sprawdza typ schowka bez odczytu obrazu;
„Paste image” czyta obraz dopiero po wybraniu tej akcji. Szkic i wybory pozostają zachowane.
Bot zachowuje jednorzędową pigułkę z rosnącym polem tekstowym. New thread i formularz
tworzenia wątku bocznego pozostają rozwinięte: przewijają formularz, nie historię rozmowy.

`Overlay` i pełny `SheetSurface` korzystają z tego samego przezroczystego okna Modal oraz
`useOverlayTransition`: powierzchnia wjeżdża spod dolnej krawędzi i wyjeżdża samą translacją,
bez zmiany opacity ani skali, także w kartach od 600 dp. `sheetSpring` w `ui/motion.ts`
(masa 1, sztywność 300, tłumienie 34, bez przestrzelenia) daje prawie krytyczne tłumienie
i odczucie około 400–500 ms. Tylko scrim zmienia opacity według postępu położenia.
Uchwyt i nagłówki oznaczone `SheetDragArea` obsługują `PanResponder`; zdarzenia dotyku
przychodzą przez JS, a obliczenia, wartości i style Reanimated oraz sprężyna biegną na UI,
bez renderów React podczas ruchu. Nie gwarantuje to dostarczania dotyku przy zablokowanym JS.
Strefa uchwytu ma 44 dp wysokości i pełną szerokość arkusza. Zwykły dotyk uchwytu lub
nagłówka zgłasza responder w fazie bubbling: zagnieżdżone przyciski zachowują tapnięcia.
Ruch zaczyna przeciąganie dopiero po przekroczeniu 6 dp w pionie i przewadze nad ruchem
poziomym; capture może wtedy przejąć gest rozpoczęty na przycisku nagłówka. Samo
tapnięcie chrome nie porusza arkuszem ani nie zamyka klawiatury.
Gest w dół przesuwa arkusz 1:1. Puszczenie po 28% jego zmierzonej wysokości lub po
co najmniej 8 dp z prędkością ≥ 900 dp/s zamyka go z prędkością gestu; ruch w górę
ma malejący opór ograniczony do 15% wysokości. Odwrócenie prędkości poniżej −300 dp/s
anuluje zamknięcie. Anulowany lub krótki gest wraca do położenia spoczynkowego.
Pierwszy gest z otwartą klawiaturą zamyka wyłącznie klawiaturę; następny przesuwa arkusz.
Przewijana treść zachowuje natywne przewijanie: PanResponder nie zapewnia niezawodnego
przejęcia aktywnego ScrollView na obu platformach bez skoku ani konfliktu responderów.
Zamykanie przez uchwyt (akcja dostępności „Close”), escape, przycisk, tło i Android back
korzysta z tego samego wyjścia. Ustawienie reduced motion usuwa sprężyny, ale zachowuje gest.
Wspólne kontrolki zamknięcia wywołują `onClose` po animacji i usunięciu natywnego okna,
więc rodzic może wtedy odmontować cały komponent. Przy zamykaniu przez `visible=false`
`Overlay` zachowuje ostatnią treść do końca wyjścia. `onDismiss` nadal uruchamia akcje
prezentujące kolejne okno dopiero po natywnym zamknięciu.

Pusty kompozytor obsługujący triggery pokazuje tylko `/ commands · $ skills · @ files · # threads · ! shell`.
Podpowiedź jest zawsze jednym wierszem z wielokropkiem na końcu, poza pomiarem tekstu pola;
nie zmienia treści ani wysokości podczas zwijania i rozwijania. Kompozytory bez triggerów
zachowują własny placeholder. Wszystkie pola korzystają z `ui/TextInput`: na iOS usuwa
odziedziczone `lineHeight`, aby UIKit używał metryk fontu dla tekstu i placeholdera.
Zwykłe `Text` oraz style pól na Androidzie zachowują dotychczasową interlinię.

Markdown renderujemy natywnym Text/View po tokenizacji, bez HTML/WebView i automatycznego
pobierania obrazów. Linki otwierają tylko HTTP(S) po tapnięciu. Narzędzia/praca są domyślnie
zwinięte; bardzo długi output ma jawny limit podglądu 12 tys. znaków.
Obrazy transkryptu, wyniki obrazowe narzędzi i załączniki wiadomości mają miniatury.
Odczyt przez `GetThreadBlob` / `GetAttachment` używa tego samego przypiętego klienta co wątek,
także dla połączonych komputerów. Tapnięcie otwiera pełny ekran z gestami powiększania
i przesuwania; przesunięcie w dół przy skali 1 zamyka widok. Ten sam viewer otwiera
lokalny podgląd załącznika w kompozytorze, również podczas wysyłania. iOS eksportuje
obraz arkuszem Share z usuwanej kopii tymczasowej, Android zapisuje go w katalogu
wybranym przez użytkownika. Nie dodajemy modułu galerii ani uprawnień do biblioteki zdjęć.
Obrazy w pamięci widoku mają limit 20 MiB; SVG i inne formaty plikowe nie są renderowane.
Niezmienne obrazy trafiają do prywatnego `Paths.cache/images-v1`: klucz zawiera pełny
kwalifikowany identyfikator załącznika albo wątku i SHA256 blobu oraz wariant miniatura/pełny.
Katalog parowania i nazwy plików są haszowane; nie zapisujemy ich w bibliotece zdjęć ani logach.
LRU ogranicza pliki do 200 MiB i 2048 wpisów, a pamięciowy indeks URI do budżetu 24 MiB
ważonego rozmiarem zakodowanych obrazów. To nie jest limit natywnie zdekodowanych bitmap.
`Image` dostaje `file://`, bez utrzymywania kopii base64. Żądania tego samego klucza są wspólne;
odejście ostatniego odbiorcy anuluje RPC. Unpair, revocation i zmiana parowania zamykają
cache przed usunięciem plików. System może wyczyścić cache; brakujący plik pobieramy ponownie.
Obrazy osi czasu rozpoczynają odczyt dopiero po przecięciu okna ekranu, również wewnątrz
jednej wysokiej tury; przewijanie odświeża pomiar najwyżej co 100 ms i po zatrzymaniu.
Załączniki w listach i wysłane chipy używają miniatur, viewer pełnego wariantu.
`GetThreadBlob` nie ma wariantu miniatury: dla blobów listy wykorzystują dostępny obraz źródłowy.
Załączniki tekstowe i Markdown otwierają się także z composera po wysłaniu pliku do
gatewaya. `GetAttachment.preview` pobiera do 128 KiB przez istniejące trasowanie do
domu i autoryzację właściciela. Cache podglądów jest ograniczony do 64 wpisów na klienta
sesji, a widok do 2000 wierszy, z jawnym komunikatem o obcięciu. Nieprawidłowy UTF-8
dekoduje się z zastępowaniem; treść binarna nie ma podglądu. „Rendered” / „Source”
używa natywnego renderera Markdown i preferencji urządzenia; tekst można kopiować,
zawijać oraz zapisać/udostępnić w całości. Pełne bajty tekstowego załącznika są
pobierane dopiero po wybraniu eksportu (do 30 MiB), bez nowych modułów natywnych.
„Show full output” / „Show full diff” otwiera pełny tekst w osobnym widoku. Podgląd inline
nadal ma 12 tys. znaków. Bloby są pobierane dopiero po otwarciu przez `GetThreadBlob`,
po autoryzacji właściciela i z routingiem do domu wątku. Gateway i viewer ograniczają
odczyt do 8 MiB; większa treść wyjaśnia limit i prosi o mniejszy fragment.
Lista wirtualizuje fragmenty do 4096 znaków, także pojedyncze bardzo długie linie.
Wynik, diff i bloki kodu mają akcję kopiowania.
Pełny diff korzysta z tych samych preferencji układu, kolorów, białych znaków i zawijania
co podgląd. Przytrzymanie wiadomości człowieka otwiera „Copy message”, a ukończonej
wiadomości agenta „Copy message” i „Quote passage” w arkuszu „Message actions”. Tę samą
akcję udostępnia czytnik ekranu. Wiadomości pośrednie we foldzie nie mają rzędów ikon.
Końcowa odpowiedź ma jeden rząd: „Copy answer”, „Quote passage”, „Fork from here” i czas
tury. Przytrzymanie działa też na niej. Ikony mają etykiety dostępności, kopiowanie zmienia
ikonę na check i ogłasza „Copied”, a cele dotyku mają 48 dp. Cytat ze stopki zachowuje
identyfikator ostatniej wiadomości oraz wątek źródłowy; arkusz akcji zamyka się przed
otwarciem edytora cytatu. Kopiowanie pozostaje dostępne w historii tylko do odczytu,
cytowanie i fork zachowują dotychczasowe warunki dostępności. „Fork from here” używa
`CreateThread`, z identycznymi warunkami dostępności jak web, i otwiera nowy wątek.
Przytrzymanie własnej, rozpoczętej wiadomości udostępnia też „Edit from here”.
Kompaktowy arkusz potwierdza liczbę cofanych wiadomości, anulowanie kolejki i żądań
oraz zatrzymanie aktywnej pracy i zadań w tle. Gdy agent udostępnia checkpointy,
właściciel wybiera „Conversation only” albo „Conversation and files” i może rozwinąć
listę przywracanych plików. W przeciwnym razie arkusz mówi „Files stay as they are”.
Ograniczenia agentów i granic wykonania egzekwuje gateway; szczegóły w [threads.md](threads.md).
Wynik trwałej operacji wraca przez `GetThreadRewind`, także po utracie odpowiedzi.
Tekst, cytaty i powiązania załączników wracają do composera; bieżące ustawienia modelu
i uprawnień zostają zachowane. „Swap saved drafts” pozwala wrócić do wcześniejszych
niewysłanych szkiców w tej sesji ekranu. Cofnięta historia jest domyślnie zwinięta pod
„N messages rewound” z „Show”/„Hide”, „Undo” i odzyskaniem szkicu przez „Edit message”.
Undo jest dostępne przed kolejną turą lub cofnięciem; nie uruchamia pracy ponownie
i nie przywraca stanu plików. Zmiana nie dodaje modułów ani konfiguracji natywnej.
Treść wiadomości z menu nie konkuruje z natywnym zaznaczaniem; pełne przeglądarki
zachowują zaznaczanie tekstu.
Obrazy i bloby odziedziczonych tur są odczytywane przez ich wątek źródłowy.

Plakietka załącznika otwiera wspólną przeglądarkę: obrazy jako miniatury i pełny ekran,
tekst UTF-8 do 128 KiB i 2000 wierszy (Markdown także renderowany), pozostałe pliki do 30 MiB z eksportem
przez Share na iOS albo zapis do wskazanego katalogu na Androidzie. Nie renderujemy PDF
ani plików biurowych wewnątrz aplikacji; web również udostępnia ich pobranie.
Akcja „Quote passage” przy odpowiedzi, rozumowaniu, kodzie, wyniku i diffie otwiera
edytowalny fragment z opcjonalnym komentarzem. Systemowego menu zaznaczenia tekstu
nie rozszerzamy modułem natywnym. Zapis wstawia cytat w ostatnim miejscu kursora
(bez kursora — na końcu), a fokus wraca za token. Cytat używa tego samego tekstowego
modelu plakietek co wzmianki `@` i `$`: krótki fragment w tekście, pełna treść i źródło
po dotknięciu, edycja i usuwanie w arkuszu. Usunięcie części znacznika usuwa cały token;
można wysłać same cytaty bez tekstu. Limity są wspólne z gatewayem: 20 cytatów,
20 tys. znaków fragmentu i 4 tys. znaków komentarza. Długi wynik udostępnia też cytowanie
poszczególnych fragmentów listy. Wysłane cytaty pozostają w tekście w swoich miejscach;
dotknięcie pokazuje pełną treść, komentarz i „Jump to source”:
osobny odczyt strony historii po `target_item_id` odnajduje źródło także poza załadowaną osią.
Edytor, edytor kolejki i Markdown wysłanych wiadomości korzystają ze wspólnego
wyliczania zakresów UTF-16. Cytaty z zakresem nie trafiają do starszych bloków nad tekstem;
cytaty bez zakresu zachowują te bloki, a otwarcie ich w edytorze kolejki zamienia je
na tokeny przez `inlineLegacyQuotes`. Krótkie etykiety nie zawierają komentarza:
pełna notatka pozostaje w przewijanym podglądzie, tak jak w karcie webowej.
W czacie bota odczyt stron rozmowy znajduje pełną wiadomość źródłową, również poza bieżącym oknem.
Panel PR dodaje `Send to agent` do komentarzy, review, nieudanych checków/jobów
i wyświetlanych fragmentów logu. Powrót do wątku wstawia cytat przy zapisanym
kursorze i ustawia fokus za nim. `Cite` w menu elementu otwiera dotychczasowy
edytor fragmentu; natywne zaznaczanie nie wymaga nowego modułu. Plakietka zawiera
znak PR, autora i krótki fragment. Podgląd pokazuje repozytorium/numer, plik/linię,
czas i URL (`Open on GitHub`). Metadane i kontekst diffu są sprawdzane w cache
właściciela na gatewayu bez żądania GitHub przy wysyłaniu. Cała zmiana pozostaje JS.
Komunikaty błędów korzystają ze wspólnego `turnNotices`: poprawnie zakończona
tura zachowuje je jako kompaktowe ostrzeżenia we własnym foldzie pracy, z licznikiem
powtórzeń i „Show details”. Trwały czas oraz sekwencje itemów naprawiają brakujące
powiązanie starszych komunikatów; błędy znanych tur spoza okna nie trafiają pod
ostatnią stopkę. Reguły są wspólne z webem ([timeline-folding.md](timeline-folding.md)).

Oś czasu nadąża za web: grupę pracy otwiera i zwija Settings → Threads → Turn activity
(„While working”, „Tool calls”, „After the turn”, z resetem), według tej samej reguły `workFoldOpen`
z `@canopy/domain/work-fold` co web; tapnięcie decyduje dalej. Grupy narzędzi domyślnie są
zwinięte, także pojedyncza grupa. „Tool calls: Expanded” otwiera je podczas pracy niezależnie
od całej sekcji. Zwinięty nagłówek pokazuje bieżący krok i status. `WorkGroupChoices` zachowuje
ręczny wybór poza wirtualnymi komórkami, tak jak web ([timeline-folding.md](timeline-folding.md)). Preferencje dotyczą tego
telefonu i leżą w `device-preferences.json` w katalogu dokumentów aplikacji
(`src/storage/preferences.ts`), nie w ustawieniach gatewaya. Wiersze pracy mają
stopień `work` (15/13), komendy są monospace. Tura powłoki (`Turn.shell_command`) ma kartę
z kodem wyjścia, 4 wierszami wyniku i „Show output”. Po karcie pokazuje tę samą pracę
i odpowiedź agenta co zwykła tura; odpowiedź pozostaje poza foldem, a zakończona praca
bez wierszy ma nieinteraktywny nagłówek „Worked for …”. `!` na początku kompozytora włącza tryb
powłoki (obramowanie rose, nota w miejscu kontrolek). Wiadomość czekająca w kolejce nie jest
turą na osi czasu (jak w web): pokazuje ją kolejka w zasobniku, a tura pojawia się po `dispatched`
z notą „Starting”; pliki tury są odznakami w dymku.

**Zasobnik nad kompozytorem** (`features/threads/tray`, web: `ComposerTop`) to jeden stos paneli
na powierzchni kompozytora: zaokrąglone tylko górne rogi, wcięcie 16 dp (promień rogu pola),
więc boki dochodzą do prostej górnej krawędzi pola, a jego obramowanie zamyka stos. Kolejność jak
w web: cel, subagenci, kolejka, a najbliżej pola to, co czeka na odpowiedź. Każdy panel ma
nagłówek `TrayHeader` (40 dp, cel dotyku 48 dp, tekst 14, ikona 16, chevron 12, padding poziomy 10 dp) i linię nad sobą;
obramowanie stosu przykrywa pierwszą. Bez paneli zasobnika nie ma; nie ma go też przy historii
importu (bez pola). W układzie zostają tylko nagłówki; dotknięcie subagentów lub kolejki otwiera
osobną nakładkę rosnącą w górę nad historią. Rozwinięcie nie zmienia wysokości zasobnika,
rezerwy feedu ani jego scrolla. Nagłówki działają także przy zwiniętym kompozytorze.
Nad zasobnikiem są wiersze statusu
(„Syncing…”, sekrety, „Sending…”, błąd wysyłki, komputer offline) i chip zadań w tle.
Wiersze statusu i zasobnik leżą na tle kompozytora z własnym wygaszeniem 32 dp, poza pomiarem
pola dla gestów klawiatury. Pomiar całego stosu obejmuje je w każdym stanie: ostatnią
wiadomość można przewinąć ponad nakładkę. Przy końcu przesuwa się razem z nimi,
a podczas czytania historii nic się nie przesuwa.
Zasobnik wchodzi i wychodzi przez `rise`, wiersze kolejki dodatkowo przez `layout`.

Panel subagentów (`SubagentsPanel`, web: `SubagentsPanel`) pokazuje tylko pracujących
i czekających na odpowiedź (`subagentsOf` z `@canopy/domain/subagents`). Nagłówek liczy tylko
aktywnych („2 subagents working · 1 needs you”, ten sam `subagentSummary` co web) i pokazuje ikony
ich dostawców. Rozwinięcie (nakładka `AnchoredOverlay`, chevron `useTween`) pokazuje wiersz na subagenta:
kropka stanu, tytuł, etykieta stanu i pierwsza linia ostatniej wiadomości. Dotknięcie otwiera
wątek z historią i możliwością dalszej wiadomości. Zakończeni znikają z zasobnika; pełna linia
(„N finished”, „Previous subagents”) jest w szczegółach wątku. Otwarcie jest lokalnym stanem
panelu, bez zapisu preferencji urządzenia i bez aktualizacji całego feedu. Kolejka również
zaczyna od samego nagłówka. Chip zadań otwiera ten sam rodzaj nakładki z akcjami i podglądem wyjścia.
Wspólny `TrayChevron` wskazuje w górę przed otwarciem, a w dół po otwarciu. Nakładki kolejki,
subagentów i zadań używają `disclosure-motion`: wysokość, przenikanie i przesunięcie o
`distance.micro`, otwarcie na `slow`, zamknięcie na `medium`, z `smoothOut`. Ograniczenie ruchu
wyłącza te przejścia. Arkusze odpowiedzi zachowują chevron wskazujący przejście do osobnego widoku.

Szczegóły wątku pokazują linię subagentów z webowym grupowaniem z `@canopy/domain/subagents`:
przy „Keep finished subagents in the list” = Off zakończeni, także archiwalni, są pod rozwijanym
„N finished”. Rozwinięcie zapisuje `finishedSubagentsExpanded` (domyślnie Off). On pozostawia
ostatnie 10 minut na głównej liście, a starszych pod „Previous subagents” z liczbą nieudanych.
Wiersz ma ucięty tytuł, stan (w tym „Waiting for an answer”), ikonę dostawcy i model oraz pierwszą
linię ostatniej wiadomości bez znaczników markdown. Zakończeni mają też względny czas aktywności.
Grupy używają `Expand`, chevron `useTween`; ograniczenie ruchu przełącza je natychmiast.
Archiwalny wątek wymaga najpierw „Unarchive”.
Odrzucona przez gateway wiadomość pokazuje jego powód zamiast ogólnej noty o ponowieniu.
Zdarzenia `turnStarted` / `turnFinished` od dostawcy lub wznowienia odtwarzają w reduktorze
mobile turę z czasem początku i końca, zanim nadejdzie jej projekcja. „Working for …” zachowuje
dzięki temu czas także dla tur rozpoczętych przez dostawcę; zapis cache zachowuje te czasy.
Wiersze osi czasu wyglądają jak w web (`src/features/timeline`): każdy rodzaj itemu ma widok jak `components/items` w web (komendy z kodem wyjścia, narzędzia z tytułem z rejestru, zmiany plików z diffem, rozumowanie, wyszukiwanie, plan/to do, obraz, kompakcja, zdarzenie dostawcy, zapis zgody lub pytania, subagent z zagnieżdżoną pracą, zadanie w tle ze Stop i ogonem wyjścia, wywołania magistrali agentów na fioletowo z kartą subagenta i dostarczenia). Wejście tury pokazuje jego pochodzenie (zadanie, wiadomość, raport od agenta z nadawcą i modelem, pytanie wątku bocznego, harmonogram, bot, notatka o zakończonych zadaniach w tle), steery mają notę, komunikaty dostawcy są wierszami, a nieudana tura pokazuje wyjaśnienie błędu ze szczegółami. Fold „Working for …” / „Worked for …” ma czas, liczniki albo bieżącą czynność, „N still running” i grupy narzędzi („Read 1 file and ran 5 commands”). Etykiety, liczniki i opisy narzędzi pochodzą ze wspólnych modułów `@canopy/domain` (`tools`, `work-summary`, `turn-origin`, `status-look`, `humanize`, `format`, `questions`, `failure-presentation`, `first-line`), tak jak w web. Czat bota używa tego samego układu co web (`@canopy/domain/bot-chat`: `botEntries`, `layoutChat`): linie dat, serie dymków z ciaśniejszymi rogami, linie wymian bot ⇄ bot, zdarzenia, błędy odpowiedzi i karty w kolejności czasu oraz wiersz statusu bota. Ręczne przełączanie foldu trzyma nagłówek w miejscu (timeline-folding.md, „Pozycja przy ręcznym przełączaniu”).
Pytania Claude `AskUserQuestion`, Codex `request_user_input` i platformy `ask_user`
obsługuje wiersz „Answer questions” / „Review request” w zasobniku, najbliżej pola, z liczbą
oczekujących i licznikiem „Expires in m:ss” pierwszej prośby; dotknięcie otwiera arkusz.
Bez próśb wiersza nie ma. Wszystkie zestawy
mają wspólne parsowanie i kodowanie odpowiedzi z web (`@canopy/domain/questions`):
jedna/wiele opcji z opisami i rekomendacją, własny tekst, Back, Skip question, Skip all
oraz Dismiss request dla pytań synchronicznych. Rekomendacja nie zaznacza odpowiedzi.
Szkice zostają przy zamykaniu arkusza, przełączaniu zestawów i pisaniu zwykłej wiadomości.
Pytania subagentów są dostępne w rodzicu z etykietą subagenta; ich strumienie czytają
żądania bez dołączania historii do feedu rodzica. `AnswerInteraction` idzie tym samym
przypiętym transportem i tokenem urządzenia co inne RPC. Gateway egzekwuje właściciela,
ważność i kontrakt odpowiedzi. Oś czasu pokazuje odpowiedzi, pominięcia i odrzucenie.
Ten sam arkusz obsługuje zgody: Allow, Deny oraz Allow for this session przez
`AnswerInteraction.allow_for_session`, egzekwowane przez gateway i harness.
Pokazuje pełną komendę, katalog albo proponowaną zmianę z dostępnego itemu.
Formularze MCP obsługują płaski schemat string/number/integer/boolean, wymagane
pola, Submit i Decline. Pytania nie mają osobnego limitu liczby kroków ani listy
dozwolonych nazw narzędzi: używają dokładnie parsera web, także dla prostego promptu.
Karty ze znanym terminem (`Interaction.expires_at`, `BotApproval.expires_at`) pokazują
„Expires in m:ss” (bursztynowe przez ostatnie 25 s), a przy zerze „Expiring…”, dopóki
gateway nie oznaczy prośby jako wygasłej; licznik używa zegara telefonu. Wygasła prośba
wątku znika jak w web. Karta bota widziana w czasie oczekiwania zostaje do końca wizyty
z „Expired. The bot no longer needs an answer.” bez akcji; spóźnioną odpowiedź gateway
odrzuca, a karta pokazuje „This request expired. No answer was sent.”. Picker modeli
pokazuje same nazwy, bez opisów modeli.
Kompozytor oferuje wysyłanie, stop, wybór modelu/effort i permissions. Okrągły przycisk
załączania jest przypięty do lewej krawędzi, poza przewijanym paskiem modelu i effort.
Pigułki mają szerokość treści i wyrównanie do prawej, więc zmiany katalogu rosną w lewo,
bez przesuwania przycisku wysyłania. Długie etykiety są skracane; dopiero nadmiar treści
przewija same pigułki, bez sprężynowania i dodatkowego paddingu w obszarze przewijania.
Tryb shell nadal zastępuje te kontrolki komunikatem. W czacie bota załączanie pozostaje
po lewej stronie pola, bez pigułek modelu. Okrągły przycisk
wysyłania ma kolor `action` jak w web; puste pole podczas tury zamienia go w stop. Gdy tura trwa
i jest wiadomość, przycisk dzieli się jak webowy `SteerSendButton`: główna część „Steer” albo
„Queue” (według Settings → Threads → Messages) wysyła w preferowany sposób, przytrzymanie
w drugi, a chevron otwiera arkusz „How to send” z „Steer into this turn” i „Queue for the next
turn” oraz opisem każdej drogi. Przycisk ma stałą minimalną szerokość, więc zmiana etykiety
nie przesuwa pól; pigułki paska przesuwają się na jego miejsce przez `fast` (przy ograniczeniu
ruchu od razu). Wzmianki działają jak w web:
`/` komendy, `$` skille i pluginy z `ListMentionCatalog` (raz na zakres), `@` pliki
(`SearchFiles`) i `#` wątki (`SearchThreads`) pokazują listę nad kompozytorem, a wybór wstawia
plakietkę w miejsce wpisanego zapytania (`features/composer/useMentionSuggestions.ts`).
Listy sugestii w wątku (także bocznym), New thread i czacie bota oraz rozwinięcia zasobnika
korzystają z `ui/AnchoredOverlay`. `ScreenFrame` ma host portalu w tym samym natywnym oknie;
otwarcie nie przenosi fokusu pola do nowego `Modal` i nie zamyka klawiatury. Pomiar kotwicy
na wątku UI śledzi klawiaturę, przewijanie i obrót. Powierzchnia jest nieprzezroczysta, ma
obramowanie i delikatny cień. Wysokość wynika z treści, z limitem 40% widocznego viewportu,
dostępnego miejsca nad kotwicą i 320 dp (sugestie: 280 dp). Treść przewija się wewnątrz,
z widocznym natywnym wskaźnikiem i stałym prawym gutterem 12 dp, bez zmiany szerokości wierszy.
Dotknięcie poza nakładką jest konsumowane i ją zamyka. Zamykają ją też przycisk Close,
gest w dół (po powrocie listy na początek), accessibility escape i Android Back. Gdy IME
przechwyci Back, zamknięcie klawiatury zamyka również nakładkę. Panele zasobnika izolują
czytnik ekranu i przy zamknięciu przywracają fokus nagłówka; sugestie zachowują dostęp do pola.
Wejście/wyjście skaluje od dolnej krawędzi przez `fast`/`quick`; ograniczenie ruchu pomija animację.
Przy widocznej wysokości poniżej 320 dp po odjęciu nagłówka `ComposerViewport` chwilowo
pokazuje jednoliniowe pole i chowa toolbar, pozostawiając miejsce na listę nad nim. Nie zależy
to od otwarcia nakładki. Formularz tworzenia wątku bocznego pozostaje osobnym arkuszem
bez listy sugestii; po utworzeniu korzysta ze wspólnego ekranu wątku.
Menu akcji wątku ma „New side thread” (ten sam projekt, worker, folder, agent i model; opcjonalnie
historia wątku głównego; full access przechodzi w full auto) oraz „Set a goal…” / „Replace the
goal…” poza Grokiem i wątkami gatewaya. Cel jest pierwszym panelem zasobnika (web: `GoalBar`):
ikona i kolor statusu, treść w jednej linii, kropka ze statusem albo tym, na co czeka
(„Starting…”, „Pausing…”, „Resuming…”), oraz Pause albo Resume obok. Dotknięcie otwiera arkusz
celu z pełną treścią, ostatnim werdyktem, Clear (z potwierdzeniem) i „Replace the goal…”.
Osiągnięty cel można zamknąć (×) do końca wizyty; wyczyszczonego nie ma. Wygląd i akcje statusów
są wspólne z web (`@canopy/domain/goals`: `goalLook`, `goalActions`, `goalPending`, `showsGoal`).
Codex przyjmuje budżet tokenów (`SetGoal`).
Settings → Connectors i panel wątku pokazują status kont jak web; konto z błędem testu
ma jego komunikat i „Show details” z technicznym opisem.

Synchronizacja wątku zastępuje znak projektu w nagłówku ikoną `arrow-path`, bez nowego
wiersza nad kompozytorem ani przesunięcia tytułu lub przycisków. Krótsze niż 500 ms
odświeżenia nie pokazują ikony. Obrót trwa 2 s, a ograniczenie ruchu pozostawia
statyczny glif; wejście i wyjście używają przenikania `quick`. Etykieta dostępności
„Syncing…” jest ogłaszana dopiero po 2 s nieprzerwanego stanu. Pozostałe noty nad
kompozytorem i informacja o niedostępnym komputerze zachowują własne miejsca.

New thread to jeden ekran jak w web: kompozytor z modelem, effort i plikami, pod nim projekt,
worker (offline z notą, która blokuje wysyłkę) i uprawnienia. Wartości startowe biorą domyślne
projektu nad Settings → Threads, potem ostatnio użyte (`features/new-thread/placement.ts`).
Picker workera pokazuje płaską listę jak w web: dostępne workery najpierw, potem pozostałe,
w obu grupach po nazwie. Kropka i opis pokazują stan oraz system, a cichy sufiks komputera
rozróżnia tylko powtarzające się nazwy. Zamknięta kontrolka pokazuje samą nazwę workera.
Wspólny helper `domain/worker-choices` porządkuje wybory bez zmiany kwalifikowanych id;
pickery botów, harmonogramów i ustawień stosują te same reguły, zachowując ograniczenia domu.
Settings → Workers nadal grupuje komputery jako widok zarządzania.
Snapshot telefonu zawiera już ich workery, projekty i wątki
oraz `computers`; zdarzenia `computer`, `computer_removed` i `computer_snapshot` je odświeżają
(`state/overview.tsx`). Worker na komputerze, z którym ten nie ma teraz połączenia, jest
wyszarzony z powodem z web („Studio Mac is unreachable since 6:45 AM.”); reguły obecności są
wspólne w `@canopy/domain/computer-presence`. Gdy worker obsługuje worktree, a katalog jest
repozytorium (`ListGitRefs`), pod pickerami są „Current checkout” / „New worktree” / wcześniejsze
worktree oraz gałąź; dla nowego worktree to wybór ref bazowego (Branches, Remote branches).
Domyślny tryb pochodzi z ustawień worktree, a `CreateThread` dostaje `workspace_mode`,
`base_ref` i `worktree_id` jak z web.
Pliki (zdjęcia z `expo-image-picker`, dokumenty z `expo-document-picker`, odczyt przez
`expo-file-system`) trafiają do `UploadAttachment` od razu po wyborze, z limitami gatewaya
z GetSettings; wiadomość z plikami zachowuje wybór steer/queue. Gdy dom nie obsługuje
sterowania plikami, gateway odkłada wiadomość do kolejki i zwraca wyjaśnienie.
Jak w web, wybrany plik wstawia
plakietkę `[nazwa]` w miejscu kursora (wzmianka ATTACHMENT, `features/composer/message-value.ts`):
TextInput dostaje fragmenty tekstu jako dzieci, więc plakietka jest zabarwionym zakresem.
Edycja dotykająca plakietki usuwa ją w całości razem z plikiem; tekst wpisany w jej środek
trafia za nią. Pole tekstowe nie pokazuje postępu, dlatego pliki wysyłane lub odrzucone mają
nad tekstem chip ze stanem i przyciskiem Remove; zapisany plik ma już tylko plakietkę. Wysłana
wiadomość pokazuje plakietki w tych samych miejscach (`Turn.mentions`), a chipy tylko dla plików
spoza tekstu. Kolejka ma stały nagłówek „N queued” w zasobniku (web: `QueuePanel`),
a po dotknięciu pokazuje nakładkę z wierszem na własną wiadomość użytkownika w kolejności startu (reguły
`@canopy/domain/queue` wspólne z web), tekst w jednej linii z nazwami plakietek, ostrzeżenie,
gdy steer nie wszedł do tury, oraz akcje: Steer (`SteerQueuedTurn`, tylko gdy tura trwa, także
z plikami), Delete (`DeleteQueuedTurn`, toast z „Undo” przez 8 sekund, `RestoreQueuedTurn`)
i „…”. Arkusz „…” ma notę „Runs with …” z nadpisaniami (model, effort, uprawnienia, pliki,
cytaty), Edit message, przesuwanie o jedno miejsce i na początek/koniec (`ReorderQueuedTurns`)
oraz „Turn on/off queueing” (domyślne zachowanie podczas tury). Edit message otwiera edytor
z tymi samymi plakietkami (`EditQueuedTurn` z `mentions_complete`, linia „‹name› leaves the
message when you save.”). Zmiany widać od razu (`useQueue`: lokalna kolejność, ukryte usunięte
i wysterowane); odpowiedź gatewaya trafia do snapshotu, a odmowa przywraca stan i mówi
dlaczego w toaście. Chip „N running in background” (web: `BackgroundTasksChip`) stoi nad
zasobnikiem przy lewej krawędzi, gdy działają zadania w tle wątku; otwiera nakładkę z działającymi
zadaniami (status, „Show full output”, „Stop task”), która zamyka się razem z ostatnim. Settings → Threads edytuje
domyślny workspace, agenta i uprawnienia.
Są tworzenie wątku, rename/archive/unread, wyszukiwanie treści, zwinięta praca/narzędzia,
subagents i panel worker/cwd/model/status/schedules/lineage/connectors.

Nagłówek oraz przytrzymanie wiersza sidebara poza trybem Custom otwierają ten sam arkusz akcji wątku:
pin/unpin, zmiana lub regeneracja tytułu, read/unread, archive/unarchive i delete;
lokalny wątek zachowuje też „Move to a computer”.
Potwierdzenia korzystają z preferencji użytkownika. „Undo” po usunięciu wywołuje
`RestoreThread` i przywraca otwarty wątek, również gdy usunięto go wraz z rodzicem.
Przesunięcie wiersza w lewo archiwizuje wątek, a w archiwum przywraca go tą samą akcją
co arkusz. Gest działa też dla wątków bocznych; krótkie lub anulowane przesunięcie wraca
do początku. Pionowe przewijanie i dotknięcie zachowują swoje działanie.
Potwierdzenia i brak połączenia blokują skrót tak samo jak menu. Toast „Thread archived”
z „Undo” cofa archiwizację przez `SetThreadArchived`, bez wznawiania tur i harmonogramów.
Gest korzysta z istniejących React Native PanResponder i Reanimated, bez zmian zależności
natywnych i fingerprintów EAS. Ograniczenie ruchu wyłącza animację powrotu wiersza.
Panel szczegółów pokazuje sumy tokenów i koszt własnych tur (bez odziedziczonych),
z oznaczeniem „loaded turns” przy niepełnej historii, oraz ostatni zgłoszony limit okna kontekstu.
„Copy” kopiuje osobno katalog roboczy i ścieżkę worktree przez `expo-clipboard`.
Linki do harmonogramów i zarządzania worktree otwierają Settings z zakresem tego wątku
lub worktree. Lista zadań w tle pozostaje dostępna w szczegółach po zakończeniu tury;
pokazuje ikonę stanu, nazwę w jednej linii, czas trwania i wiek zakończenia przy prawej
krawędzi. Działające zadanie ma widoczny przycisk Stop, zakończone wykorzystuje pełną
szerokość wiersza. Etykieta dostępności zawiera pełną nazwę, stan i kod wyjścia;
dotknięcie wiersza otwiera pełny wynik. To zmiana wyłącznie JS.
Snapshot strony zachowuje także itemy zadań w tle spoza okna załadowanych tur.
„Show full output” korzysta ze wspólnego `TextViewer`, także dla wyniku zapisanego jako blob.

Sidebar korzysta z tych samych reguł co web w `@canopy/domain/sidebar-threads`,
`sidebar-entries`, `thread-tree` i `thread-activity`: subagenci nie mają osobnych głównych
wierszy (także przypięci), a pytania kierowane do użytkownika oznaczają ich rodzica.
Wątki boczne użytkownika są zagnieżdżone pod rodzicem; przypięty wątek boczny występuje
tylko raz, jako główny wiersz. Na telefonie można rozwinąć je bez otwierania wątku.
Wyszukiwanie tytułu wątku bocznego pokazuje rodzica. Archived używa wspólnego pagera
`@canopy/domain/archived-threads`, filtrów projektu i wyszukiwania po stronie gatewaya;
archiwalne wątki boczne pozostają w Previous agents pod rodzicem. Powiadomienia o wyniku
subagenta zostają wewnątrz wątku, a pytanie do użytkownika wywołuje jeden alert rodzica.

„Thread options” obok wyszukiwania łączy filtr projektów z trybami „Last activity”,
„Created” i „Custom”. Wybór jest lokalny dla urządzenia, domyślnie Last activity;
znaczniki odpowiedzi i klucze kolejności pochodzą ze wspólnego `thread-order`.
W Custom przytrzymanie przez 350 ms i ruch co najmniej 6 dp rozpoczynają przeciąganie.
Chwyt obejmuje tylko główny wiersz: zagnieżdżony wątek boczny nie podnosi rodzica.
Wiersz ma wtedy osobny przycisk „Thread actions”; arkusz oferuje Move up/down/to top/to
bottom, a akcje dostępności increment/decrement przesuwają w dół/górę.
Przesuwanie pozostaje w sekcji oraz projekcie; wyjątek to Pinned. Górna strefa
pokazuje „Drop here to pin” / „Release to pin”, a wyciągnięcie przypiętego wątku
respektuje Confirm unpin. Anulowanie potwierdzenia niczego nie zapisuje.

Gest używa zainstalowanego gesture-handler 3 (`usePanGesture`) i Reanimated 4.
Geometrię zgłaszają tylko zamontowane komórki FlatList. Kopia wiersza, linia celu
i przewijanie krawędzi działają na wątku UI; JS otrzymuje tylko podniesienie do
nakładki i zakończony ruch. Wspólny detektor pozostaje zamontowany podczas
przewijania, nawet gdy komórka źródłowa opuści okno wirtualizacji. Wiersze zachowują
`memo`, a zapis stosuje jedną odpowiedź ReorderThread bez odświeżania listy.
Animacja rozmieszczenia korzysta z tokenów i systemowego ograniczenia ruchu;
pętla zatrzymuje się w tle. Nie dodajemy modułu haptyki: aplikacja go dotąd nie używa.
Callback klatek rejestruje się dopiero po aktywacji przeciągania i wyłącza po jego
zakończeniu lub anulowaniu. Sam wybrany tryb Custom nie utrzymuje zegara UI;
spóźniony start po zakończeniu gestu ponownie sprawdza aktywny wiersz.

Etykieta „Working 1m” używa tego samego `workingLabel` i `formatAge` z domain co web:
czas pochodzi z `lastActivityAt`, z fallbackiem do `createdAt`. Tytuł i metadane
zachowują zwykły kontrast; sam stan pracy nie dodaje tła. W szerokim układzie tło
zaznaczenia wskazuje tylko otwarty wątek, także podczas pracy. Pierścień pracy
dzieli geometrię i kolory z web (`@canopy/ui/thread-row`); animacja Reanimated
działa na wątku UI i zatrzymuje się w tle oraz przy systemowym ograniczeniu ruchu.
Jeden zegar aplikacji aktualizuje wyłącznie zmieniony tekst statusu, nie listę ani
cały wiersz. Szczegóły pomiarów: [client-performance.md](client-performance.md).
Zachowane ekrany stosu otrzymują zakres widoczności zgodny z fokusem nawigacji;
ukrycie nadrzędnego stosu zatrzymuje również dekoracje i zegary jego dzieci.
Odliczanie próśb, potwierdzeń, parowania i reconnect używa tego samego zegara.
Timery odczytów panelu wątku, PR, importu i diagnostyki są usuwane poza widocznym
ekranem lub foreground. Zawieszenie usuwa je już w zdarzeniu AppState; raportowanie
diagnostyki anuluje także trwającą wysyłkę. Powrót przywraca zwykły rytm bez
odtwarzania pominiętych ticków. Dogrzewanie cache nadal ma własny limit 12 odczytów/min.
Podpis miejsca używa wspólnego `threadPlace`: „scratch folder”, HEAD worktree
(gałąź lub detached commit), potem nazwa katalogu. Inicjały i ton znaku projektu
są wspólne; neutralny znak w ciemnym motywie używa stopnia 300, tak jak web.

Tapnięcie Archived zmienia lokalny stan od razu; zapis ustawienia w gatewayu działa
w tle. Osobny cache `Paths.cache/archived-threads-v1` zachowuje ostatnio odczytane
strony dla najwyżej 8 filtrów, razem z metadanymi projektów i workerów. Używa tego
samego atomowego adaptera i zakresu urządzenie + pin co cache historii; unpair oraz
revocation zamykają go przed usunięciem plików. Nie zajmuje miejsca w LRU transkryptów.
Zapisane strony pokazują się przed odświeżeniem; brak danych daje kompaktowe skeletony.
Przy braku połączenia lub nieaktualnych danych sekcja pokazuje „Showing saved threads”.
Filtry projektu i tytułu działają także na zapisanych wierszach; pełne wyniki wyszukiwania
uzupełnia gateway. Wiersze lokalne i połączonych komputerów trafiają do jednej
wirtualizowanej FlatList, a koniec listy doczytuje kolejną stronę. Nowe archiwa są
wstawiane w kolejności kursora bez ponownego sortowania całości. Jawne zdarzenia
archive/unarchive/delete i unlink aktualizują cache; sama nieobecność komputera nie
usuwa zapisanych wątków. Zmiana podczas pobierania unieważnia starszą odpowiedź,
więc nie przywraca usuniętego lub odarchiwizowanego wiersza.
Obecne API `ListArchivedThreads` zwraca tylko lokalne archiwum. Mobile zachowuje
wiersze partnerów poznane przez zdarzenia overview i nie usuwa ich po lokalnym odczycie;
pełna historia archiwum partnera nadal jest dostępna na jego komputerze.

Settings zajmuje osobną, nieprzezroczystą trasę ponad całym workspace'em. Sidebar i wątek
pod spodem zachowują szerokość przy otwieraniu i zamykaniu. Android przesuwa Settings
od dołu bez przenikania tekstu; iOS używa natywnego przejścia stosu i gestu od lewej
krawędzi. To animacje platformy, bez własnych czasów. Ograniczenie ruchu wyłącza je.
Stos workspace'u na szerokim oknie zamienia wątki i boty od razu, w przyciętym panelu
obok sidebara; nie przesuwa ani nie rozjaśnia starego widoku nad listą.

Sekcje Settings mają własny natywny stos (`/settings` → `/settings/[section]`). Gest iOS
oraz Back Androida cofają sekcję do głównego widoku Settings, a dopiero z niego zamykają
Settings. Gest zewnętrznego stosu jest wyłączony, gdy cofanie należy do stosu sekcji.
Skróty do konkretnej sekcji również zachowują główny widok pod nią. Na szerokim oknie
główny widok pokazuje listę i General; pierwszy Back przywraca ten widok, drugi wraca
do workspace'u. Wybór kolejnej sekcji obok listy zastępuje bieżącą sekcję, bez tworzenia
historii każdego wyboru. Złożenie lub obrót nie kasuje stosu. Krzyżyk zamyka całe Settings
z dowolnego poziomu. Wejście do wątku bocznego ze szczegółów lub panelu subagentów
oraz wejście do rozmowy botów dodaje trasę do stosu workspace'u; Back wraca do
bezpośredniego poprzednika. Wybór z sidebara na szerokim oknie nadal zamienia trasę
bez historii pomiędzy wyborami. Arkusze botów mają własne
`onRequestClose`: ustawienia wracają do szczegółów, szczegóły do czatu. Parowanie jest
dostępne wyłącznie bez sesji; zakończenie lub usunięcie parowania usuwa niepasujące
trasy z historii. Back Androida w skanerze wraca najpierw do wypełnionego formularza.

Settings używa rejestru sekcji web, z General, Keybindings, Diffs, Agent environment,
Proxies, Network access i capability-gated Linked computers. Na telefonie otwiera
listę sekcji i osobny ekran; od 600 dp pokazuje listę obok treści. Zmiany konta zapisuje
bezpośrednio przez owner-scoped GatewayService. Formularze obejmują projekty/workspace'y,
harmonogramy, polityki worktree, instrukcje/skille/pluginy, instancje dostawców, proxy,
konektory, workery, urządzenia i połączone komputery. Zapis używa wersji/revizji gatewaya;
po konflikcie odświeża dane i zachowuje szkic do poprawienia. Sekrety połączeń pozostają
write-only; UI pokazuje obecność i pozwala zastąpić/usunąć wartość. Plugin wymaga osobnego
potwierdzenia dokładnego checksumu. Rozwiązywanie driftu używa obejrzanego checksumu.
Keybindings jest wyszukiwalną referencją dla klawiatur sprzętowych, bez edycji skrótów
przeglądarki. Kontrolki lokalnego procesu Electron i jego updatera są ukryte jak w web
remote; aktualizacje gatewaya/workera pozostają w Workers. Powiadomienia systemowe są
oznaczone jako niedostępne w tym buildzie, bez pozornego przełącznika push.
Settings → Import pokazuje przebiegi importu CLI: postęp, datę, liczniki, bieżący wątek i akcje
Cancel, Resume / Retry failed oraz Remove imported items z potwierdzeniem. Aktywny przebieg
odświeża listę co 3 s, gdy aplikacja jest na pierwszym planie. Nieudane przywrócenie pozwala
ponowić usuwanie pozostałych pozycji. Scan computer uruchamia skan CLI workera tego gatewaya;
arkusz pozwala wybrać wątki ze stronicowaniem, filtry, mapowanie katalogów, tryb kontynuacji
i ustawienia/bibliotekę z decyzjami o konfliktach. Kopiowanie wartości sekretów wymaga
osobnego wyboru; wartości nie trafiają na telefon ([import.md](import.md#wejścia-i-telefon)).
Wątek zaimportowany jako historia zamiast kompozytora pokazuje Continue in a new thread;
gateway tworzy nowy wątek z podsumowaniem tej historii, tak jak w web.
Pierwszy stan projektów, workerów i wątków pobierają także unary GetOverview i ListThreads,
bez oczekiwania na pierwszy pakiet WatchOverview; generacja żądania chroni przed nadpisaniem
nowszych danych starszą odpowiedzią. Sparowany telefon ma **jedną** subskrypcję WatchOverview
(`state/overview-bus.tsx`): overview, ustawienia i współdzielone odczyty słuchają tej samej
szyny, więc gateway otwiera też tylko jedną zdalną subskrypcję na połączony komputer.
Przejście między sekcjami Settings niczego nie pobiera ponownie. Udany zapis formularza
odczytuje ponownie tylko zasób tego formularza; projekty, workery i wątki przychodzą
strumieniem. Postęp przenoszenia to wyłącznie GetMoves co 2 s (bez PreviewMove i overview),
a po zakończeniu podgląd czyta się raz.
Formularz harmonogramu ma własny kalendarz, godzinę i gotowe częstotliwości oraz tryb cron.
Katalog stref IANA w `packages/ui/src/timezones.json` jest wspólny z web, bo Hermes nie
udostępnia `Intl.supportedValuesOf`. Wybór daty sprawdza też nieistniejące godziny przy zmianie czasu.
Zmiana gatewaya/nazwy telefonu wymaga ponownego parowania. Boty mają
listę, czat ze streamem, wysyłanie/stop, karty pytań/zgód z odpowiedziami oraz sheet
szczegółów z włączaniem, pauzowaniem i usuwaniem rutyn oraz anulowaniem przypomnień. „Bot settings”
pozwala edytować nazwę, instrukcje, wygląd, model, effort, worker i politykę zgód;
przycisk Create bot w nagłówku listy Bots otwiera ten sam formularz do tworzenia.
Tworzenie zachowuje `client_request_id` przy ponowieniu niepotwierdzonego zapisu.
Wspólna walidacja szkicu wykrywa powtórzone nazwy na tym samym komputerze i normalizuje
kolor #RGB do #RRGGBB; gateway pozostaje źródłem walidacji. Nowy bot rozpoczyna formularz
od wyboru modelu. Nieudana odpowiedź ma Retry dla ostatniego
błędu oraz Change model or worker, otwierające ustawienia. Akcje wymagają live
i dostępnego domu bota; gateway ponownie sprawdza możliwość ponowienia.
New thread ma skrót Manage projects do istniejącego tworzenia projektów i workspace'ów,
a Thread details → Manage connector access otwiera mobilne Settings → Connectors.
Tak jak w web, konta są przyznawane workerowi, a nie pojedynczemu wątkowi.
Parowanie i revocation wskazują Settings → Devices na dowolnym już sparowanym urządzeniu.
lista „Allowed actions” pokazuje czas i źródło reguły oraz „Remove rule”. „Always allow…”
na karcie przesyła identyfikator opcji wyliczonej w gatewayu. Automatyczna zgoda zostaje
jako „Allowed by rule: …”, z odnośnikiem do ustawień. „Threads started by this bot”
używa tych samych opcji co web; karty narzędzi takich wątków można rozstrzygać również
w czacie bota. Są też połączenia, archiwizacja i usuwanie bota. Pasek boczny, alerty,
ustawienia bota i dostęp konektorów korzystają z jednej listy botów parowania
(`state/bot-list.ts`): jedno żądanie naraz, potem wypychane `bot`/`bot_removed`; po każdym
`feeds` z `bots` lista czyta się raz. Starszy gateway nie wypycha botów: wtedy zapasowy odczyt co 15 s
na pierwszym planie oraz po powrocie na pierwszy plan i zmianie sieci. Alerty biorą za punkt odniesienia pierwszą
listę odczytaną po każdym połączeniu, więc nie odtwarzają historii.
Lista obejmuje przypinanie i sekcję Archived, a karta oczekującej zgody ma skrót do polityki bota.
Brak push i wysyłania offline; cache obejmuje wątki i rozmowy botów, zgodnie z opisem powyżej.

### Wklejanie i upuszczanie

Menu załączników zamyka się przed otwarciem Photos, Files lub odczytem „Paste image”.
`Overlay` kończy animację wyjścia, a potem czeka na natywne zamknięcie modala:
`Modal.onDismiss` na iOS, usunięcie nieanimowanego Dialog w commicie na Androidzie.
`PickerSheet.onDismiss` uruchamia zapamiętaną akcję tylko raz. Samo `onClose` ani
koniec animacji nie wystarczają do prezentacji kolejnego kontrolera UIKit.
Zamykana nakładka nie przyjmuje dotyku; spinacz jest zablokowany do zakończenia
wyboru lub wklejania. Anulowanie odblokowuje go bez komunikatu, błędy pokazują krótki
komunikat z możliwością zamknięcia i ponowienia akcji. Photos and videos używa systemowego
wyboru obrazów i filmów bez wcześniejszego żądania pełnego dostępu do biblioteki; brak takiej
zgody nie blokuje wyboru. Kompozytor nie ma akcji robienia zdjęcia kamerą.

Oba kompozytory utrzymują poziomo przewijany pasek wszystkich plików do wysłania lub usunięcia,
także po zakończeniu uploadu. Obrazy mają lokalne miniatury 56 × 56 dp, filmy kafelek z ikoną
odtwarzania i czasem, jeśli picker go poda. Zainstalowany picker nie zwraca plakatu filmu;
nie dodajemy natywnego generatora miniatur. Rodzaj `video` w szkicu opisuje wybór
pickera; upload nadal przesyła nazwę i bajty, a gateway niezależnie rozpoznaje
kontener i zapisuje `kind = video`. Wysłane filmy mają plakat rastrowy z gatewaya,
ikonę i znany czas. Plakat używa istniejącego przypiętego transportu i cache obrazów;
pełny film nie trafia do cache obrazów. Przeglądarka pokazuje Play on a computer
i Share video (iOS) lub Save video (Android); bajty eksportu pobiera dopiero akcja.
Ta warstwa nie zmienia fingerprintu ani modułów natywnych; player jest osobną zmianą.
Pozostałe pliki pokazują ikonę formatu (PDF, archiwum, kod, tekst, arkusz, audio lub plik),
nazwę i rozmiar. Format wynika z MIME i rozszerzenia. Wysokość wiersza jest stała, nazwy
skracają się z zachowaniem końcówki, a przycisk usuwania ma cel 32 × 56 dp i usuwa też
plakietkę w tekście. Upload nakłada spinner, błąd dodaje obramowanie i powód; `pop` oraz
`layout` korzystają ze wspólnych tokenów i respektują ograniczenie ruchu. Pasek nie zmienia
zasad klawiatury ani gradientu 32 dp. Tapnięcie miniatury obrazu otwiera tę samą
pełnoekranową przeglądarkę co obraz w transkrypcie, także przed zakończeniem uploadu.

URI obrazu z pickera lub data URI ze schowka zostaje w drafcie także po uploadzie.
Kopie obrazów z natywnego wklejania i upuszczania są zwalniane przy usunięciu, wysłaniu
lub zamknięciu draftu, a pozostałe kopie intake po odczycie. Nie zmienia to natywnych
modułów ani konfiguracji runtime; zmiana może trafić przez OTA.

Wklejanie i upuszczanie plików (`features/attachments/FileIntake.tsx`, lokalny moduł Expo
`modules/canopy-file-intake`) idzie tą samą drogą co wybór: `UploadAttachment` z limitami gatewaya.
Menu spinacza pokazuje „Paste image”, gdy schowek ma obraz. `expo-clipboard` `hasImageAsync`
sprawdza tylko typ zawartości, bez odczytu, więc iOS nie pyta o zgodę. Obraz czyta dopiero wybór
„Paste image” (`getImageAsync`, PNG); iOS może wtedy pokazać systemowe pytanie o wklejenie.
Aplikacja nigdy nie czyta schowka bez akcji użytkownika.

`CanopyPasteView` otacza kompozytor i podpina się do pola tekstowego w środku.
- **Android:** `ViewCompat.setOnReceiveContentListener` na `ReactEditText` (`AppCompatEditText`).
  Systemowe Paste (React Native zamienia je na „paste as plain text”), obrazek z klawiatury
  (commitContent, np. pasek schowka Gboard) i upuszczenie na pole dają elementy z URI. Moduł kopiuje
  je do `cacheDir/canopy-intake`, a tekst wkleja się jak dotąd. Uprawnieniem klawiatury do URI
  zarządza system. Moduł utrzymuje silną referencję do odebranej zawartości do końca asynchronicznego
  kopiowania, aby system nie zwolnił dostępu do URI przed odczytem.
- **iOS:** `RCTUITextView`/`RCTUITextField` wklejają tylko tekst, więc moduł podmienia
  `canPerformAction:withSender:` i `paste:` na ich klasach. Zmiana działa tylko dla pól
  zarejestrowanych przez `CanopyPasteView`. Gdy schowek ma pliki lub obrazy (sprawdzane po typach,
  bez odczytu), menu pola pokazuje Paste. Wklejenie bez tekstu czyta `itemProviders` i kopiuje pliki
  do `tmp/canopy-intake`. To systemowe Paste użytkownika, więc iOS nie pyta o zgodę. Wklejenie
  z tekstem (np. tekst z obrazem z Safari) zostaje zwykłym wklejeniem tekstu.

Upuszczanie z innych aplikacji działa na dużych ekranach: iPad, Android w podzielonym ekranie,
składane telefony po rozłożeniu, DeX. Ekran wątku i nowego wątku otacza `CanopyDropView`, a gdy
pliki wiszą nad nim, nakładka jak w web pokazuje przerywaną ramkę i „Drop files to attach”.
Nakładka zajmuje miejsce tylko absolutnie, pojawia się z `rise`, a etykieta z `pop`. Nie ma tu
rozmycia tła, więc kolor płótna przesłania wątek. Przy ograniczonym ruchu zostaje samo przenikanie.
- **iOS:** `UIDropInteraction`. Pliki ładuje `loadFileRepresentation`. Przeciągnięcia zaczęte
  w aplikacji (`localDragSession`) i sam tekst lub link nie są plikami.
- **Android:** `OnDragListener`. Uprawnienie do URI daje `requestDragAndDropPermissions` tylko
  dla upuszczonych elementów i jest zwalniane po skopiowaniu. Upuszczenie na samo pole tekstowe
  obsługuje `CanopyPasteView`: plakietki trafiają w miejsce kursora. Androidowy `ExpoView`
  dziedziczy po `LinearLayout`, dlatego zawartość i nakładka mają jeden niezwijany kontener
  React Native; to on układa nakładkę absolutnie nad treścią.

Wyłączony kompozytor (komputer poza siecią, zablokowany wątek) odrzuca upuszczenie
(`enabled` widoku). Widok zostaje ten sam, więc wyłączenie nie montuje ekranu od nowa.

Plik większy niż `maxFileBytes` z GetSettings nie jest kopiowany: chip mówi, dlaczego nie został
dodany. Kopia jest usuwana po odczycie do wysłania, a folder czyści się przy starcie modułu. Klient
dev zbudowany bez modułu działa dalej, tylko bez natywnego wklejania (`requireOptionalNativeModule`).

## Ruch

Przejścia stanu UI idą przez warstwę `src/ui/motion.ts` (tokeny, presety, `useReducedMotion`,
`useTween`) i `src/ui/MotionViews.tsx` (`Expand`, `Swap`, `Chevron`, `useArrivals`, `GlidingCell`,
`usePressScale`). Czasy, odległości, skale i krzywe pochodzą z `motion` w `@canopy/ui`, tych samych
co tokeny CSS web (`routes/layout.css`): otwarcie `fast` (250 ms), zamknięcie `quick` (150 ms), panele
`slow` / `medium` (400 / 350 ms), arkusze `sheetSpring` opisany wyżej, `smoothOut` dla powierzchni, pozycji i rozmiaru, `inOut`
dla tekstu i odsłonięcia szkieletu. Bez liczb ad hoc w komponentach. React Native nie ma `filter: blur`,
więc przejścia web z rozmyciem są tu bez niego.

Fold pracy i grupy narzędzi korzystają z `features/timeline/TimelineDisclosure`: leniwy
montaż, zachowanie treści po zamknięciu, naturalna wysokość po otwarciu oraz przejście
wysokości na UI przez `fast` / `smoothOut` (250 ms w obie strony). Ograniczenie ruchu
pomija przejście. Kotwica ręcznego przełączenia mierzy nagłówek na UI i na czas ruchu
wyłącza natywne kotwiczenie komórki. Dotyczy to także ostatniej tury; szczegóły i granice
zakresu przewijania opisuje [timeline-folding.md](timeline-folding.md).

Presety (`useMotion()`): `rise` (nowy wiersz, tylko przezroczystość), `pop` (coś dodanego, rośnie
od `scale.medium`), `toast` (komunikat: wjeżdża o `distance.medium`, `slow` / `medium`), `swap`
(zmieniony tekst wchodzi o `distance.micro`), `reveal` (treść w miejscu szkieletu), `layout`
(sąsiednie wiersze przesuwają się na nowe miejsce). Animacje biegną na wątku UI (Reanimated).

Tekst trwającej pracy (`src/ui/LiveText.tsx`: nagłówki pracy, grupy narzędzi, rozumowanie i status
bota) ma ten sam shimmer co web: jaśniejszy pas na przygaszonym tekście, liniowy cykl 2000 ms
z `motion.shimmer`, tło o szerokości 200% i punkty gradientu 40/50/60%. Pas przesuwa się
w prawo i znika poza tekstem przed kolejnym przebiegiem. Przycięte kopie tekstu z różną
przezroczystością zmiękczają krawędzie bez dodatkowego modułu natywnego. Przesunięcia kopii
i okien biegną na wątku UI; tylko tekst bazowy zajmuje miejsce i jest dostępny dla czytnika.
Ograniczenie ruchu usuwa pas i zatrzymuje animację, pozostawiając statyczny tekst.

Ograniczenie ruchu w systemie: nic nie jedzie ani nie skaluje automatycznie. Arkusze zmieniają
położenie natychmiast, a przeciąganie pozostaje dostępne. Wiersze i komunikaty tylko
się rozjaśniają; zmiana tekstu, przesunięcia (pigułka, przełącznik, panel boczny), układ listy
i odsłonięcie szkieletu są natychmiastowe. `useReducedMotion` ma jedną subskrypcję na aplikację
i do pierwszej odpowiedzi systemu bierze wartość, którą Reanimated odczytał przy starcie.

Pierwsze renderowanie ekranu, arkusza i nakładki nie animuje wierszy ani komunikatów
(`LayoutAnimationConfig skipEntering skipExiting` w `screenLayout` Stacka, `Overlay` i `Sheet`);
animują się dopiero późniejsze zmiany. Listy wirtualne (`useArrivals`) animują tylko wiersze, które
naprawdę doszły; wiersz zamontowany ponownie przy przewijaniu pojawia się od razu. Oś czasu wątku
oraz czat bota używają trybu `newestFirst`: animują nowe klucze przed pierwszym
znanym wierszem, a doczytane starsze strony na drugim końcu listy pokazują od razu.
Zastąpienie całego okna bez wspólnych kluczy również nie animuje historii. Oś czasu wątku
nie animuje wysokości (odwrócona lista z kotwicą foldu, `feed-anchor.tsx`): nowe wiersze i otwarta
praca tylko się rozjaśniają, jak `t-rise` w web.

Ruch nie zmienia układu długich treści klatka po klatce. Panel boczny na szerokim oknie wjeżdża
i odjeżdża (`translateX` i przezroczystość), a kolumna bierze szerokość przed wjazdem i oddaje ją
po odjeździe: ekran obok układa się raz, a nie w każdej klatce (długi wątek przelicza wtedy cały tekst).
Przejścia układu (`layout`) mają tylko krótkie listy i wiersze listy wątków; wiersze list wirtualnych
nie mają animacji wyjścia, bo wirtualizacja też je odmontowuje.

## Markdown

Wiadomości agentów, botów i ludzi renderuje `src/ui/markdown/` natywnymi widokami, bez HTML i WebView.
Drzewo tokenów, matematykę (`$…$`, `$$…$$`), bezpieczne linki (`safeHref`: tylko http, https, mailto)
i znaczniki elementów wstawianych w tekst (plakietki wzmianek) dzieli z web `@canopy/domain/markdown`.
Obrazy nie są pobierane (link do nich), surowy HTML jest tekstem, matematyka pokazuje źródło TeX.
Bloki `diff` / `patch` korzystają ze wspólnego widoku diffu. Pozostały kod jest monospace
bez kolorowania składni: mobilny workspace nie ma silnika highlightera używanego przez web.
Tabele nie mają układu tabeli w React Native: szerokości kolumn liczy się z długości tekstu, długie
komórki się zawijają, a szeroka tabela przewija się w poziomie. Nagłówki i treść mają te same
granice szerokości: 72–224 dp plus padding; również długi nagłówek się zawija. Tabela zachowuje
naturalną wysokość, więc ruch pionowy przejmuje odwrócona lista osi czasu, także dla tabel
wyższych niż ekran.

Tabele, niełamany kod, matematyka blokowa i diffy współdzielą `ui/HorizontalScroll`:
`ScrollView` z zainstalowanego Gesture Handler z `nestedScrollEnabled` na Androidzie,
blokadą kierunku na iOS i poziomym wskaźnikiem przewijania. Lokalny `GestureHandlerRootView`
obejmuje też użycie w osobnym oknie modala Androida. Delikatny cień prawej krawędzi wskazuje
ukrytą treść i znika na końcu; offset i przezroczystość aktualizuje Reanimated na UI,
bez callbacków JS w każdej klatce. Pomiary układu zmieniają się tylko przy zmianie rozmiarów.
Stack obszaru głównego jawnie ustawia `fullScreenGestureEnabled: false`: domyślne zachowanie
`react-native-screens` na iOS 26 dopuszcza swipe-back z całego ekranu, który może konkurować
z treścią poziomą. Gest powrotu od lewej krawędzi pozostaje aktywny. Sidebar na szerokim oknie
otwiera przycisk, bez pełnoekranowego gestu; swipe archiwizacji jest tylko na jego wierszach.

Poziomy `ScrollView` w dymku zawsze dostaje `flexGrow: 0`. Domyślne `flexGrow: 1` w kontenerze
dopasowanym do treści (`alignItems: "flex-start"`, jak dymek czatu) daje mu na iOS i Androidzie
niekończącą się wysokość: blok kodu był wysokim pustym prostokątem.

## Sprawdzanie aplikacji

Zakładki plików workspace'u używają natywnej wirtualnej listy linii i ról składni
otrzymanych przez bounded `GetThreadFileHighlight`, bez parsera w runtime telefonu.
Natywne pole edycji pozostaje bez kolorów; jawne `Preview changes` koloruje szkic,
`Keep editing` wraca do pisania. Tło anuluje żądania kolorowania. Tokeny mają osobny
LRU 2 MiB, związany z klientem parowania; treść i szkic pozostają tylko w pamięci.
Szczegóły limitów oraz fallbacków: [UI API](ui-api.md#pliki-wątku).

Przy `INSTALL_FAILED_INSUFFICIENT_STORAGE` na AVD użyj
`bunx expo run:android --active-arch-only` lub zwiększ dysk emulatora.
Na iOS Simulator zachowaj standardowe podpisywanie debug: wyłączenie go przez
`CODE_SIGNING_ALLOWED=NO` może uniemożliwić dostęp do Keychain/SecureStore.
Emulator nie zastępuje kontroli kamery/QR, rzeczywistej klawiatury i odzyskiwania
połączenia po przejściu w tło na fizycznym telefonie.

Polecenia z root:

```bash
bun install
bun run typecheck
bun run gen:check
bun run check:tmp
bun run --filter @canopy/web build
```

Z `apps/mobile`:

```bash
bun run lint
bunx expo-doctor
bunx expo prebuild --clean --no-install
bunx expo export --platform android --output-dir dist/android
bunx expo export --platform ios --output-dir dist/ios
```

`prebuild --no-install` sprawdza generowanie projektów na Linuxie; nie kompiluje
Gradle/Xcode ani nie wykonuje CocoaPods. `export` buduje JS/assets do bytecode Hermes,
nie APK/IPA. `tests/integration/mobile-devices.test.ts` sprawdza jednorazową i współbieżną
wymianę, expiry/revoke/reuse, owner/hash metadata, aktywne streamy po revoke, self-unpair,
administrację właściciela i izolację kont, zachowanie service tokenu, limit prób i natywny moduł klienta
z prawdziwym HTTP/1.1 GetOverview + WatchThread oraz snapshot WatchOverview przez HTTP/2
z weryfikacją przypiętego certyfikatu. Test transportu Node nie potwierdza działania streamów
w natywnym kliencie Android. Wymaga throwaway PostgreSQL w Dockerze.
`tests/integration/mobile-questions.test.ts` używa tego samego przypiętego klienta przez
Network access: trzy źródła pytań, wybory i własny tekst, pominięcia, odrzucenie, expiry,
izolacja właściciela/tokenów, pytanie subagenta oraz odpowiedzi po restarcie gatewaya
z ponownym zgłoszeniem nadal działających tur workera.

`mobile-route-policy.test.ts` sprawdza bez sieci brak wygaśnięcia trasy, przejście po błędzie,
reset używany przez zmianę sieci/powrót z tła/reconnect, odporność na spóźnione odpowiedzi,
zmiany ogłoszeń i filtrowanie starszych adresów `.0`.
`mobile-routes.test.ts` sprawdza współdzielenie wyścigu i wybranej trasy przed nagłówkami RPC,
preferencję IP tailnetu przy błędzie MagicDNS, odmowę i niezgodny pin, anulowanie/reset w trakcie
probe, wspólne okno czarnych dziur oraz brak replay także po błędzie treści odpowiedzi.
Żywy strumień przez przypięty TLS utrzymuje trasę po upływie dawnego okna 30 s, także gdy ogłoszenie
dodaje nieosiągalny adres; kolejne RPC nie uruchamiają probe i nie resetują transportu.
`mobile-route-recovery.test.ts` używa prawdziwego przypiętego TLS i proxy opóźniającego pierwszy
pakiet odpowiedzi o 3,5 s na każdym połączeniu; równolegle jedna nazwa nie rozwiązuje się, a inna
trasa nie odpowiada na TLS. `network-liveness.test.ts` sprawdza wolne pongi, usunięcie martwej
sesji i logi bez pinu. Timingi testów liveness są skrócone; test klienta TS nie zastępuje QA radia
ani natywnego transportu na fizycznych telefonach.

Czat bota używa wspólnego edytora wzmianek: `@` proponuje inne aktywne boty tego samego
komputera oraz połączone konta udostępnione botowi. Katalog kont jest lokalny, zgodnie z web;
gateway ponownie sprawdza wzmianki, granty i zasady zatwierdzania. Przytrzymanie wiadomości
otwiera Reply/Copy. Odpowiedź dodaje cytat do szkicu, z komentarzem i usuwaniem;
można wysłać same cytaty. Ponowienie zachowuje identyfikator dostarczenia tylko dla
niezmienionego tekstu, wzmianek, cytatów i obrazów. Podpowiedzi nie zmieniają wysokości edytora.
Wątki i boty współdzielą tokeny cytatów w edytorze, bez osobnego paska nad polem.
Zakresy są wysyłane i zapisywane razem z tekstem. Konwersja Markdown na tekst cytatu jest wspólna
w `domain/markdown`. Menu Reply/Copy używa `TextActions`, a kopiowanie w menu
i przeglądarkach korzysta z tego samego `useCopyText`, z potwierdzeniem dostępności
i komunikatem ponowienia po błędzie. Długie przytrzymanie treści bota nie konkuruje
z natywnym zaznaczaniem tekstu kodu ani diffu; pełne przeglądarki zachowują zaznaczanie.

Szkic bota jest trwały w bazie gatewaya przez `GetBotDraft` / `SaveBotDraft`,
z kontrolą rewizji. Tekst, strukturalne wzmianki, cytaty i pliki wracają po nawigacji;
trwające uploady zachowuje stan powiązany z klientem i botem. Przyjęcie wiadomości
czyści tylko jej rewizję, błąd zachowuje szkic. **Load saved draft** pozwala rozwiązać
konflikt z innym urządzeniem po skopiowaniu lokalnych zmian. Kompozytor przyjmuje
wszystkie typy plików obsługiwane przez wątki przez istniejące wklejanie,
wybór zdjęć lub plików i upuszczanie.
Korzysta ze wspólnych limitów, miniaturek i przeglądarek załączników; nie zmienia
modułów natywnych, konfiguracji ani zależności aplikacji.

`In-app notifications` obejmuje inne wątki i czaty botów na tym urządzeniu. Alerty botów
korzystają ze wspólnych z web reguł świeżości wiadomości, pytań i zatwierdzeń. Pierwszy odczyt,
wznowienie po uśpieniu i odczyt po błędzie tworzą cichą bazę. Boty zarchiwizowane, przeczytane
wiadomości i aktualnie otwarty czat nie pokazują alertu. To wyłącznie JS w otwartej aplikacji;
nie rejestruje powiadomień systemowych ani obsługi w tle.

Workspace obserwuje widoczny zakres przez `WatchThreadFiles` przez Connect,
współdzieląc stream drzewa i aktywnego pliku. `useAppActive` anuluje stream,
odczyty drzewa i timer ponowienia w tle lub po zakryciu ekranu. Powrót rewaliduje
aktywny plik i rozwinięte katalogi, bez pełnego drzewa i replay zapisów.
Zewnętrzna zmiana zachowuje dirty i udostępnia `Compare changes`, `Copy changes`
oraz potwierdzane `Discard and reload`. Porównanie obu wersji używa tej samej
wirtualnej listy wierszy; edycja nadal jest natywna, bez live highlighting.

## Galerie obrazów agenta

Item `image_gallery` pozostaje widoczny pod odpowiedzią, również po zwinięciu
aktywności tury. Dwie kolumny mieszczą początkowo sześć obrazów; „Show all N”
rozwija pozostałe. Ramki 16:9 i zarezerwowane miejsce podpisu utrzymują układ.
Istniejący viewport włącza miniatury tylko w widocznym obszarze, a prywatny cache
załączników i anulowanie odczytów obowiązują także dla zdalnych identyfikatorów.

Pełny obraz pobieramy dopiero po dotknięciu. Viewer używa istniejącego powiększania,
zamknięcia i eksportu (Save image/Share image); dodaje opis, licznik, poprzedni/następny
oraz Before/After dla pary. Długie opisy przewijają się w ograniczonej części ekranu.
Alt trafia do czytnika, stan pary ma etykietę i wybrane taby, a kontrolki respektują
tokeny ruchu i ustawienie reduced motion. Nie dodajemy modułów ani zmian natywnych;
fingerprint pozostaje granicą zgodności, a eksport JS nie zastępuje odbioru na urządzeniu.

Obrazy Markdown w odpowiedzi agenta otwierają ten sam viewer. Klient używa
manifestu zapisanego przez gateway, nie lokalnej ścieżki workera. Stała ramka
zachowuje wysokość podczas importu i dekodowania. Niezapisany obraz pozostaje
linkiem do pliku, a zdalny obraz linkiem zewnętrznym bez automatycznego pobierania.

## Źródła sprawdzone dla tego wdrożenia

- [Expo SDK 58](https://expo.dev/changelog/sdk-58), [expo/fetch i Encoding APIs](https://docs.expo.dev/versions/v58.0.0/sdk/expo/).
- [Monorepos z Bun i Metro](https://docs.expo.dev/guides/monorepos/), [Connect przez fetch](https://connectrpc.com/docs/web/choosing-a-protocol/).
- [Camera](https://docs.expo.dev/versions/v58.0.0/sdk/camera/), [SecureStore](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/), [Crypto](https://docs.expo.dev/versions/v58.0.0/sdk/crypto/).
- [Development builds](https://docs.expo.dev/develop/development-builds/introduction/), [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/), [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).
- [Oficjalne aliasy TS 6 + TS 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0).

Aktualizacje OTA: [Updates SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/updates/),
[Fingerprint SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/fingerprint/) i
[podpisywanie EAS Update](https://docs.expo.dev/eas-update/code-signing/).
