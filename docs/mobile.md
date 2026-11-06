# Canopy na iOS i Android

Pierwsza wersja to **development build** Expo, nie Expo Go ani Expo web.
Identyfikatory: iOS `tech.itsol.canopy-remote`, Android `tech.itsol.canopy_remote` (Android nie dopuszcza myślnika w identyfikatorze); scheme: `canopy`.
Konfiguracja: `apps/mobile/app.json`, `app.config.ts`, `eas.json`.

## Transport: czy React Native obsługuje gRPC?

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

Hermes obsługuje BigInt wymagany przez protobuf-es (`uint64`, m.in. seq).
SDK 58 / RN 0.88 udostępnia TextEncoder i TextDecoder; Expo inicjalizuje
`structuredClone` oraz ReadableStream przed wejściem Routera. Nie dodajemy konkurencyjnych
polyfilli. Idempotency key kompozytora pochodzi z natywnego `expo-crypto.randomUUID()`;
aplikacja i Connect nie wymagają globalnego `crypto.getRandomValues`.

## Parowanie i granica uprawnień

1. W web otwórz **Settings → Devices → Pair a phone**. BFF wywołuje
   `CreateMobilePairing` swoim dotychczasowym service tokenem. Telefon go nie otrzymuje.
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
je wyłącznie przy zgodnym pinie. Próbuje trasy według ostatniego sukcesu, sprawdzając TLS
bez HTTP przed wybraniem trasy. Nie ponawia RPC po wysłaniu, aby nie dublować komend.
Po zmianie portu zapisuje nowe trasy również z odpowiedzi `UpdateNetworkAccess`, nawet
bez strumienia overview. Usuwa nieaktualną ostatnią trasę; restart telefonu korzysta
z nowych adresów, zachowując ten sam pin i token urządzenia.
Bez żadnej znanej działającej trasy potrzebny jest wspólny VPN lub nowy QR — sama aplikacja
nie zapewnia relaya ani przejścia przez NAT.

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
   Flaga włącza `NSAllowsLocalNetworking`; `NSAllowsArbitraryLoads` pozostaje false.
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
   certyfikatem): `bunx eas-cli build --profile preview --platform android`. Profil
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

## Nightly w TestFlight

Workflow `Mobile TestFlight` (`.github/workflows/mobile-testflight.yml`) uruchamia się po udanym
przebiegu `Release` na `dev`. Buduje iOS w EAS profilem `production` i wysyła build do TestFlight
(`--auto-submit`). Robi to tylko wtedy, gdy:

- commit dostał tag nightly (`v…-nightly.N`); przebieg bez wydania niczego nie buduje,
- od ostatniego buildu iOS, który nie zakończył się błędem ani anulowaniem, zmieniło się coś,
  z czego składa się aplikacja: `apps/mobile`, pakiety `contracts`, `domain` i `ui`,
  `package.json`, `bun.lock` albo sam workflow.

Ręczne uruchomienie (`workflow_dispatch`) z `force` buduje bez sprawdzania zmian.

- **Aplikacja:** w App Store Connect nazywa się „Canopy Remote”. Ma bundle id
  `tech.itsol.canopy-remote`, ASC app id `6768351426` i zespół `5XWLF3YKWM`.
  Android używa `tech.itsol.canopy_remote`, bo nie dopuszcza myślnika. Zmiana z dawnego
  `app.canopy.mobile` tworzy nową aplikację: stary APK trzeba odinstalować i sparować telefon ponownie.
- **Wersja:** App Store przyjmuje trzy liczby, więc `0.2.0-nightly.84` trafia jako `0.2.0`.
  Workflow wpisuje ją do `app.json` tylko w kopii roboczej. EAS kopiuje drzewo robocze, więc nic nie
  jest commitowane. Numer buildu prowadzi EAS (`cli.appVersionSource: remote`, `autoIncrement`).
- **Konto:** sekret repozytorium `EXPO_TOKEN` daje dostęp do organizacji `itsol`.
- **Poświadczenia:** certyfikat dystrybucyjny i profil provisioningowy trzyma EAS. Pierwszy raz
  tworzy je interaktywnie ktoś z dostępem do zespołu Apple:
  `bunx eas-cli credentials -p ios` w `apps/mobile`, profil `production`. Wysyłkę do App Store
  Connect obsługuje klucz API podpięty do aplikacji w Expo. Gdy certyfikat albo profil wygaśnie,
  build w CI kończy się błędem `Credentials are not set up`. Wtedy trzeba je odnowić tą samą
  komendą.

## Interfejs zgodny z web

Pair → Threads/Bots → Thread/Chat, plus Settings i New thread. Lista pokazuje projekt,
worker/katalog, ikonę providera, czas i stan jak web; aktualizuje się przez WatchOverview.
Są wyszukiwanie, filtr projektów i Archived. WatchThread składa
snapshot i delty współdzielonym reducerem itemów. Po utracie połączenia backoff
z jitterem rośnie od około 1 do 30 sekund; powrót z tła lub odzyskanie sieci uruchamia
świeży snapshot. Stan pozostaje tylko w pamięci, bez obietnicy offline wysyłania.
Wysłanie po timeout używa tego samego client_request_id do czasu zmiany treści/trybu,
więc ręczny retry nie dubluje tury.

`packages/ui` współdzieli z web geometrię ikon Tabler outline i osobne logotypy providerów, kształty i kolory mascotów,
nazwy/kolejność Settings i akcentów. `tokens.ts` opisuje skalę typografii, spacing, radii
i statusy według `apps/web/src/app.css` oraz `shared/ui/status.ts`. Paleta RN jest generowana
z dokładnie tej samej wersji Tailwind co web: `bun --cwd packages/ui gen`. Konwersja
OKLCH → sRGB jest konieczna dla natywnego parsera kolorów; `gen:check` wykrywa rozjazd palety
i wersji Tailwind. CSS web nadal używa Tailwind; zmiany jego skali typografii/radii
trzeba przenosić do wspólnych tokenów świadomie.

RN używa StyleSheet i Inter 400/500/600 (pakiet fontu, bez pobierania z sieci), SVG
z tych samych ścieżek, SafeAreaView i FlatList. Aplikacja działa edge-to-edge, więc okno nie
zmienia rozmiaru przy klawiaturze. Ekrany z kompozytorem lub formularzem (wątek, czat bota,
New thread, Pair) i `Overlay` nie używają `KeyboardAvoidingView`: `ui/KeyboardArea.tsx` liczy,
ile klawiatura zasłania od dołu okna (wysokość okna minus jej `screenY`; na Androidzie `height`
pomija pasek nawigacji pod nią). Przy otwartej klawiaturze dół kompozytora leży na niej, przy
zamkniętej zostaje dolny inset safe area; SafeAreaView tych ekranów pomija dolną krawędź. Jasny/ciemny motyw
oraz niezależne palety Light/Dark są ustawieniami gatewaya, synchronizowanymi między klientami.
Settings korzysta ze wspólnych tokenów tematów Birch, Fern, Lagoon, Cedar, Heather,
Blossom i Ash. Preferencje urządzenia (typografia, kontrast, diffy i format czasu)
pozostają w SecureStore telefonu i nie zmieniają preferencji przeglądarki.
Na wąskim oknie sidebar jest natywnym ekranem listy (stos lista → wątek); web na telefonie
otwiera go jako drawer. Od 600 dp szerokości okna (klasa large screen Androida: tablety,
rozłożony foldable, telefon w poziomie) lista zostaje obok otwartego wątku lub czatu, jak
w desktopowym web (`src/state/layout.tsx`). Ma 260–320 dp, zaznacza otwarty wątek i chowa się
przyciskiem listy w nagłówku. Układ zależy od szerokości okna, nie typu urządzenia, więc
składanie, obrót i zmiana rozmiaru przełączają go na żywo; aplikacja nie blokuje orientacji.
Safe area każdej kolumny liczy natywny `SafeAreaView`. Zawias: Expo nie udostępnia
`FoldingFeature`; zawias Galaxy Z Fold po rozłożeniu nie zasłania ekranu, więc nie omijamy go.
Urządzenie z zasłaniającym zawiasem wymagałoby modułu natywnego (Jetpack WindowManager). Panele
szczegółów są sheetami. Każdy wybór (model, effort, uprawnienia, projekt, worker, instancja
dostawcy, menu akcji) używa jednego `PickerSheet` (`src/ui/Picker.tsx`): kompaktowy dolny arkusz
z zaokrąglonymi rogami, wierszami ≥ 48 dp, nagłówkami sekcji, wyszukiwaniem przy długich listach
i znacznikiem wyboru; na oknach od 600 dp otwiera się jako karta na środku. Teksty nakładek
biorą stopnie `contextType` z `packages/ui` (docs/ui-scale.md), ruch tokeny `motion`;
przy ograniczeniu ruchu nakładki tylko się rozjaśniają. Full access wymaga potwierdzenia
przy każdym wyborze, jak w web. Feed wątku i czat bota są odwróconymi listami: otwierają się
na ostatniej wiadomości, podążają za nowymi na dole i trzymają pozycję podczas czytania historii. Nazwy komponentów odpowiadają web, m.in. SidebarThread,
ThreadHeader, MessageComposer/ComposerBox, ThreadPanel, AppearanceSettings,
BotAvatar, ChatBubble i BotDetailsPanel. Brand assety pochodzą z `apps/web/static`.

Markdown renderujemy natywnym Text/View po tokenizacji, bez HTML/WebView i automatycznego
pobierania obrazów. Linki otwierają tylko HTTP(S) po tapnięciu. Narzędzia/praca są domyślnie
zwinięte; bardzo długi output ma jawny limit podglądu 12 tys. znaków i odsyłacz opisowy do web.
Oś czasu nadąża za web: grupę pracy otwiera i zwija Settings → Threads → Turn activity
(„While working”, „After the turn”, z resetem), według tej samej reguły `workFoldOpen`
z `@canopy/domain/work-fold` co web; tapnięcie decyduje dalej. Preferencje dotyczą tego
telefonu i leżą w `device-preferences.json` w katalogu dokumentów aplikacji
(`src/storage/preferences.ts`), nie w ustawieniach gatewaya. Wiersze pracy mają
stopień `work` (15/13), komendy są monospace. Tura powłoki (`Turn.shell_command`) ma kartę
z kodem wyjścia, 4 wierszami wyniku i „Show output”; `!` na początku kompozytora włącza tryb
powłoki (obramowanie rose, nota w miejscu kontrolek). Tura w kolejce pokazuje „Queued”,
a po `dispatched` „Starting”; pliki tury są odznakami w dymku. Nad kompozytorem są tylko
subagenty w toku, zakończone zwija liczba otwierająca panel z lineage. Odrzucona przez
gateway wiadomość pokazuje jego powód zamiast ogólnej noty o ponowieniu.
Pytania/zgody w wątkach są widoczne **read-only** i odpowiada się na nie w web. Karty
ze znanym terminem (`Interaction.expires_at`, `BotApproval.expires_at`) pokazują
„Expires in m:ss” (bursztynowe przez ostatnie 25 s), a przy zerze „Expiring…”, dopóki
gateway nie oznaczy prośby jako wygasłej; licznik używa zegara telefonu. Wygasła prośba
wątku znika jak w web. Karta bota widziana w czasie oczekiwania zostaje do końca wizyty
z „Expired. The bot no longer needs an answer.” bez akcji; spóźnioną odpowiedź gateway
odrzuca, a karta pokazuje „This request expired. No answer was sent.”. Picker modeli
pokazuje same nazwy, bez opisów modeli.
Kompozytor oferuje Queue, Send now/steer, stop, wybór modelu/effort i permissions;
respektuje ustawienie zachowania podczas trwającej tury. Wzmianki działają jak w web:
`/` komendy, `$` skille i pluginy z `ListMentionCatalog` (raz na zakres), `@` pliki
(`SearchFiles`) i `#` wątki (`SearchThreads`) pokazują listę nad kompozytorem, a wybór wstawia
plakietkę w miejsce wpisanego zapytania (`features/composer/useMentionSuggestions.ts`).
Menu akcji wątku ma „New side thread” (ten sam projekt, worker, folder, agent i model; opcjonalnie
historia wątku głównego; full access przechodzi w full auto) oraz „Set a goal…” / „Replace the
goal…” poza Grokiem i wątkami gatewaya. Pigułka Goal otwiera cel z Pause, Resume i Clear
(z potwierdzeniem) jak pasek celu w web; Codex przyjmuje budżet tokenów (`SetGoal`).
Settings → Connectors i panel wątku pokazują status kont jak web; konto z błędem testu
ma jego komunikat i „Show details” z technicznym opisem.
New thread to jeden ekran jak w web: kompozytor z modelem, effort i plikami, pod nim projekt,
worker (offline z notą, która blokuje wysyłkę) i uprawnienia. Wartości startowe biorą domyślne
projektu nad Settings → Threads, potem ostatnio użyte (`features/new-thread/placement.ts`).
Picker workera grupuje workspace'y według komputera jak w web: najpierw „This computer”, potem
połączone komputery po nazwie. Snapshot telefonu zawiera już ich workery, projekty i wątki
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
z GetSettings; wiadomość z plikami zawsze idzie do kolejki. Jak w web, wybrany plik wstawia
plakietkę `[nazwa]` w miejscu kursora (wzmianka ATTACHMENT, `features/composer/message-value.ts`):
TextInput dostaje fragmenty tekstu jako dzieci, więc plakietka jest zabarwionym zakresem.
Edycja dotykająca plakietki usuwa ją w całości razem z plikiem; tekst wpisany w jej środek
trafia za nią. Pole tekstowe nie pokazuje postępu, dlatego pliki wysyłane lub odrzucone mają
nad tekstem chip ze stanem i przyciskiem Remove; zapisany plik ma już tylko plakietkę. Wysłana
wiadomość pokazuje plakietki w tych samych miejscach (`Turn.mentions`), a chipy tylko dla plików
spoza tekstu. Własna wiadomość w kolejce ma „…” obok „Queued”: Edit message otwiera edytor
z tymi samymi plakietkami (`EditQueuedTurn` z `mentions_complete`, linia „‹name› leaves the
message when you save.”), Delete usuwa ją (`DeleteQueuedTurn`). Settings → Threads edytuje
domyślny workspace, agenta i uprawnienia.
Są tworzenie wątku, rename/archive/unread, wyszukiwanie treści, zwinięta praca/narzędzia,
subagents i panel worker/cwd/model/status/schedules/lineage/connectors.

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
Pierwszy stan projektów, workerów i wątków pobierają także unary GetOverview i ListThreads,
bez oczekiwania na pierwszy pakiet WatchOverview. Udany zapis formularza odświeża te dane;
generacja żądania chroni przed nadpisaniem nowszych danych starszą odpowiedzią.
Formularz harmonogramu ma własny kalendarz, godzinę i gotowe częstotliwości oraz tryb cron.
Katalog stref IANA w `packages/ui/src/timezones.json` jest wspólny z web, bo Hermes nie
udostępnia `Intl.supportedValuesOf`. Wybór daty sprawdza też nieistniejące godziny przy zmianie czasu.
Zmiana gatewaya/nazwy telefonu wymaga ponownego parowania. Boty mają
listę, czat ze streamem, wysyłanie/stop, karty pytań/zgód z odpowiedziami oraz sheet
szczegółów/routines/reminders (zarządzanie w web). Lista botów odświeża się co 10 sekund.
Brak push i trwałego offline cache. To pierwsza iteracja zgodności z web,
nie pełna równoważność wszystkich jego funkcji.

## Sprawdzanie aplikacji

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

## Źródła sprawdzone dla tego wdrożenia

- [Expo SDK 58](https://expo.dev/changelog/sdk-58), [expo/fetch i Encoding APIs](https://docs.expo.dev/versions/v58.0.0/sdk/expo/).
- [Monorepos z Bun i Metro](https://docs.expo.dev/guides/monorepos/), [Connect przez fetch](https://connectrpc.com/docs/web/choosing-a-protocol/).
- [Camera](https://docs.expo.dev/versions/v58.0.0/sdk/camera/), [SecureStore](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/), [Crypto](https://docs.expo.dev/versions/v58.0.0/sdk/crypto/).
- [Development builds](https://docs.expo.dev/develop/development-builds/introduction/), [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/), [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).
- [Oficjalne aliasy TS 6 + TS 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0).
