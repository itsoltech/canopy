# Canopy na iOS i Android

Pierwsza wersja to **development build** Expo, nie Expo Go ani Expo web.
Identyfikator obu aplikacji: `app.canopy.mobile`, scheme: `canopy`.
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

Sprawdzone 2026-11-02: npm `expo@latest` = **58.0.22**, React Native **0.88.1**,
React **19.3.0**, Expo Router **58.0.29**, create-expo-app **5.0.0**. Punktem wyjścia
był default template; jego kod demonstracyjny zastąpiono ekranami Canopy.
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
Bez żadnej znanej działającej trasy potrzebny jest wspólny VPN lub nowy QR — sama aplikacja
nie zapewnia relaya ani przejścia przez NAT.

Token urządzenia autoryzuje GatewayService jako **obecnego pojedynczego właściciela**.
To pełny dostęp właściciela, nie osobna rola read-only. Interceptor zapisuje identity
urządzenia w context i porównuje właściciela w DB z użytkownikiem core. Zarządzanie
urządzeniami i zaproszeniami (`GetMobileDevices`, create/revoke) jest dostępne BFF
z service tokenem i sparowanemu desktopowi, a niedostępne telefonowi;
telefon ma osobne `UnpairMobileDevice`, odnoszące się do jego własnej identity.
Telefon nie tworzy enrollmentu ani nie rotuje poświadczeń workera: taki credential
mógłby posłużyć do migracji desktopu do pełnego zakresu UI. Rodzaj `desktop` ustala
gateway podczas tworzenia zaproszenia; kod telefonu nie działa w wymianie desktopowej.
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
3. Dla Android APK użyj `bunx eas-cli build --profile development --platform android`.
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

Przy zdalnym buildzie na Macu ustaw locale UTF-8 (`LANG=en_US.UTF-8`, `LC_ALL=en_US.UTF-8`)
i upewnij się, że CocoaPods działa z wybraną wersją Ruby. Na hoście testowym stara
instalacja Homebrew CocoaPods 1.16.2 miała konflikt `ffi` z Ruby 4; osobna instalacja
CocoaPods 1.17.0 w katalogu zadania rozwiązała problem. Błąd `avdmanager ENOENT` w T3
oznacza brak Command-line Tools pod `$ANDROID_HOME/cmdline-tools/latest/bin`,
nawet jeżeli sam obraz AVD jest już zainstalowany.

## Interfejs zgodny z web

Pair → Threads/Bots → Thread/Chat, plus Settings i New thread. Lista pokazuje projekt,
worker/katalog, ikonę providera, czas i stan jak web; aktualizuje się przez WatchOverview.
Są wyszukiwanie, filtr projektów i Archived. WatchThread składa
snapshot i delty współdzielonym reducerem itemów. Po utracie połączenia backoff
z jitterem rośnie od około 1 do 30 sekund; powrót z tła lub odzyskanie sieci uruchamia
świeży snapshot. Stan pozostaje tylko w pamięci, bez obietnicy offline wysyłania.
Wysłanie po timeout używa tego samego client_request_id do czasu zmiany treści/trybu,
więc ręczny retry nie dubluje tury.

`packages/ui` współdzieli z web dane ikon Lucide/providerów, kształty i kolory mascotów,
nazwy/kolejność Settings i akcentów. `tokens.ts` opisuje skalę typografii, spacing, radii
i statusy według `apps/web/src/app.css` oraz `shared/ui/status.ts`. Paleta RN jest generowana
z dokładnie tej samej wersji Tailwind co web: `bun --cwd packages/ui gen`. Konwersja
OKLCH → sRGB jest konieczna dla natywnego parsera kolorów; `gen:check` wykrywa rozjazd palety
i wersji Tailwind. CSS web nadal używa Tailwind; zmiany jego skali typografii/radii
trzeba przenosić do wspólnych tokenów świadomie.

RN używa StyleSheet i Inter 400/500/600 (pakiet fontu, bez pobierania z sieci), SVG
z tych samych ścieżek, SafeAreaView, KeyboardAvoidingView i FlatList. Jasny/ciemny motyw
oraz sześć akcentów są ustawieniami gatewaya, synchronizowanymi między klientami.
Sidebar jest natywnym ekranem listy; web na telefonie otwiera go jako drawer. Panele
szczegółów/menu są sheetami. Nazwy komponentów odpowiadają web, m.in. SidebarThread,
ThreadHeader, MessageComposer/ComposerBox, ThreadPanel, AppearanceSettings,
BotAvatar, ChatBubble i BotDetailsPanel. Brand assety pochodzą z `apps/web/static`.

Markdown renderujemy natywnym Text/View po tokenizacji, bez HTML/WebView i automatycznego
pobierania obrazów. Linki otwierają tylko HTTP(S) po tapnięciu. Narzędzia/praca są domyślnie
zwinięte; bardzo długi output ma jawny limit podglądu 12 tys. znaków i odsyłacz opisowy do web.
Pytania/zgody w wątkach są widoczne **read-only** i odpowiada się na nie w web.
Kompozytor oferuje Queue, Send now/steer, stop, wybór modelu/effort i permissions;
respektuje ustawienie zachowania podczas trwającej tury. Goal jest read-only.
Są tworzenie wątku, rename/archive/unread, wyszukiwanie treści, zwinięta praca/narzędzia,
subagents i panel worker/cwd/model/status/schedules/lineage/connectors.

Settings ma kolejność web: Appearance, Threads, Text generation, Scheduled tasks,
Projects, Providers, Connectors, Workers, Devices. Edytowalne są Appearance,
running delivery i instrukcje tytułów; pozostałe sekcje prezentują dane i odsyłają do web
po zarządzanie. Zmiana gatewaya/nazwy telefonu wymaga ponownego parowania. Boty mają
listę, czat ze streamem, wysyłanie/stop, karty pytań/zgód z odpowiedziami oraz sheet
szczegółów/routines/reminders (zarządzanie w web). Lista botów odświeża się co 10 sekund.
Brak załączników, push i trwałego offline cache. To pierwsza iteracja zgodności z web,
nie pełna równoważność wszystkich jego funkcji.

## Weryfikacja

W checkoutcie 2026-11-02 przeszły: instalacja Bun, typecheck wszystkich workspace'ów,
generowanie kontraktów, lint mobile, Expo Doctor **20/20**, CNG obu platform,
eksport bundle Android/iOS i build web BFF. Pełny `check:tmp`: **627 pass, 144 skip,
0 fail**, bez pozostawionych katalogów testowych. Testy live modeli były pominięte.
Zbudowano i uruchomiono development client na MacStudio: iPhone 17 Pro / iOS 26.3
Simulator i Medium Phone / Android 16 (API 36.1) Emulator. Na obu ręcznie sprawdzono
parowanie kodem, snapshot/listę, aktualizacje live, otwarcie wątku, wysłanie i odpowiedź
strumieniowaną, chat bota, zachowanie parowania po relaunch oraz unpair z potwierdzonym
revoke w gatewayu. Zmiana akcentu iOS → Android synchronizuje się; działa systemowy
light/dark. Panel wątku i zwijanie pracy również otwarto. Bez automatycznych testów UI.

Zestawienia rzeczywistego web (390 × 844) i obu aplikacji: [raport i screenshoty](mobile-verification.md).
Model testowy i worker były skryptowane, bez prawdziwego LLM ani sekretów live.
Połączenie szło przez prywatny SSH reverse forward na loopback, nie przez Tailscale Serve.
Kamera/QR na fizycznym telefonie, prawdziwy LLM, HTTPS Serve, utrata sieci i powrót z tła
pozostają nieweryfikowane ręcznie; retry/reconnect jest zaimplementowany.

Na testowym AVD uniwersalny APK nie mieścił się w wolnej przestrzeni
(`INSTALL_FAILED_INSUFFICIENT_STORAGE`). Build `arm64-v8a` (~96 MB) zainstalował się poprawnie.
Na małym AVD użyj `bunx expo run:android --active-arch-only` lub zwiększ jego dysk.
Na iOS simulator zachowaj standardowe podpisywanie debug: build z
`CODE_SIGNING_ALLOWED=NO` powodował błąd dostępu do Keychain/SecureStore.

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
ograniczenia administracji, zachowanie service tokenu, limit prób i natywny moduł klienta
z prawdziwym HTTP/1.1 GetOverview + WatchThread. Wymaga throwaway PostgreSQL w Dockerze.

## Źródła sprawdzone dla tego wdrożenia

- [Expo SDK 58](https://expo.dev/changelog/sdk-58), [expo/fetch i Encoding APIs](https://docs.expo.dev/versions/v58.0.0/sdk/expo/).
- [Monorepos z Bun i Metro](https://docs.expo.dev/guides/monorepos/), [Connect przez fetch](https://connectrpc.com/docs/web/choosing-a-protocol/).
- [Camera](https://docs.expo.dev/versions/v58.0.0/sdk/camera/), [SecureStore](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/), [Crypto](https://docs.expo.dev/versions/v58.0.0/sdk/crypto/).
- [Development builds](https://docs.expo.dev/develop/development-builds/introduction/), [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/), [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).
- [Oficjalne aliasy TS 6 + TS 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0).
