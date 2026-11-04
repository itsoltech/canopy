# Połączone komputery (projekt)

Status: **etap 1 zaimplementowany** (2026-11-03): tożsamość, parowanie, przypięty mTLS,
wersjonowanie, obecność i Settings → Linked computers. Etapy 2–8 poniżej pozostają projektem.

## Cel

Każdy komputer działa samodzielnie w trybie lokalnym (własny gateway, baza, worker; [desktop.md](desktop.md)).
Połączenie komputerów to **dodatek do trybu lokalnego, nie trzeci tryb**: instalujesz Canopy na kolejnym
komputerze, wybierasz tryb lokalny, a później łączysz gatewaye, żeby o sobie wiedziały i wymieniały
wątki, boty, wiadomości i konfigurację. Tryb zdalny (desktop jako worker zewnętrznego gatewaya) zostaje
bez zmian.

Założenia:

- **Jeden użytkownik.** Wszystkie połączone komputery należą do tej samej osoby. Multi-user może przyjść
  w wersji chmurowej; tutaj nie ma kont, ról ani uprawnień per użytkownik.
- **Pełny dostęp.** Połączony komputer może wszystko, co ty na nim: czytać, pisać, uruchamiać agentów
  na jego workerach. Poziomy dostępu (np. tylko podgląd) są możliwe później, nie teraz.
- **Dowolna sieć.** LAN, internet, firmowy VPN, Tailscale — co użytkownik ma. Bezpieczeństwo nie zależy
  od sieci.

## Model: każda rzecz ma dom

Rzeczy, które coś wykonują lub mają trwały stan wykonania, należą do **jednego** gatewaya (domu).
Pozostałe komputery widzą je i działają na nich zdalnie, ale nigdy nie trzymają drugiej, edytowalnej
kopii. Dzięki temu nie ma scalania historii, a nic nie wykonuje się dwa razy.

| Rzecz | Dom | Z innego komputera |
|---|---|---|
| Wątek | gateway, na którego workerze działa | lista, odczyt, pisanie, steer, zgody, przerwanie — trasowane do domu |
| Bot (rozmowa, rutyny, przypomnienia, notatki handoff) | gateway, na którym go utworzono | rozmowa i edycja zdalnie; wykonuje się tylko u siebie |
| Harmonogramy | dom wątku albo bota | widoczne i edytowalne zdalnie |
| Worker, workspace (katalog projektu na maszynie) | swoja maszyna | można uruchomić wątek na workerze innego komputera — wątek mieszka wtedy tam |
| Konto connectora | każdy komputer osobno | autoryzacja per komputer; UI podpowiada „Not connected on Laptop B — Connect” |
| Projekt | wspólna tożsamość (globalne id) | workspace'y projektu należą do poszczególnych maszyn |

Tworzenie wątku na workerze komputera B z UI komputera A jest wywołaniem do B; B zostaje właścicielem.
Szyna agentów przekracza granicę tak samo: `spawn_thread` na workerze B tworzy wątek na B z rodzicem
na A, a raporty i pytania wracają przez łącze.

## Dostępność: bez kolejkowania

Gdy komputer jest niedostępny, **nie da się do niego nic wysłać** — nie wiemy, czy śpi, stracił sieć,
działa dalej, czy właśnie aktualizuje aplikację. Wiadomości nie czekają w kolejce wychodzącej.

- Stan partnera: **Connected**, stan ogłoszony przed zniknięciem (**Updating…**, **Going to sleep**,
  **Shutting down**, z czasem ogłoszenia) albo **Unreachable since 19:42** — bez zgadywania przyczyny.
- Wątki i boty niedostępnego komputera zostają na liście, **wyszarzone, z „last seen”**. Da się w nie
  wejść i czytać wszystko, co było zsynchronizowane do chwili rozłączenia. Composer, zgody i akcje są
  zablokowane z wyjaśnieniem.
- Agent, który próbuje sięgnąć do niedostępnego komputera (np. `send_message` do jego wątku), dostaje
  czytelny błąd, nie zawieszenie.
- Po ponownym połączeniu wszystko synchronizuje się od miejsca przerwania.

## Synchronizacja (lustra tylko do odczytu)

Dom publikuje dziennik zmian swoich rzeczy (wątki, itemy osi czasu, tury, kolejki, boty i ich
wiadomości, statusy). Partnerzy trzymają **lustro**: osobne tabele z `origin_node_id`, tylko do odczytu,
aktualizowane subskrypcją od kursora. Po rozłączeniu wznowienie od zapamiętanego kursora; gdy kursor jest
za stary — pełna resynchronizacja tej rzeczy. Skala jest osobista, więc domyślnie lustro obejmuje
pełne osie czasu (limit retencji jako późniejsza opcja).

Pisanie nigdy nie dotyka lustra: każda akcja na cudzej rzeczy to wywołanie do domu, a efekt wraca
dziennikiem zmian, tak jak dziś strumień do przeglądarki.

## Konfiguracja

Gateway pozostaje centrum konfiguracji dla swoich workerów. Część konfiguracji jest wspólna dla
połączonych komputerów:

1. **Wspólna** (opcja „Share with linked computers” przy elemencie): instancje providerów, ulubione
   modele, ustawienia użytkownika (wygląd, domyślne ustawienia wątków, strefa, generowanie tekstu),
   projekty jako tożsamość. Każdy element ma wersję i komputer, który go ostatnio zmienił.
2. **Lokalna dla maszyny**, nigdy nie synchronizowana: ścieżki CLI, logowanie natywne, workspace'y,
   adresy, porty, ustawienia desktopowe, konta connectorów.
3. **Sekrety** (klucze API instancji): przesyłane tylko dla elementów oznaczonych jako wspólne,
   szyfrowanym łączem; odbiorca szyfruje je własnym kluczem (`CANOPY_SECRETS_KEY` / keychain).

**Konflikty:** ta sama wspólna rzecz zmieniona na dwóch komputerach bez połączenia → przy ponownym
połączeniu **pytanie** z obiema wersjami („Keep this computer's / Keep Laptop B's”). Zmiany bez konfliktu
przechodzą same.

**UI musi zawsze pokazywać, co jest wspólne, a co lokalne**: znaczek „All linked computers” albo
„This computer” przy ustawieniach, maszyna przy wątkach, botach i workerach, oraz wyjaśnienie, gdy coś
działa inaczej, niż użytkownik mógłby oczekiwać (np. connector połączony tylko na jednym komputerze).

## Tożsamość, parowanie, bezpieczeństwo

- Każdy gateway przy pierwszym starcie tworzy parę kluczy węzła (ECDSA P-256 dla zgodności TLS) przechowywaną jak inne sekrety.
  Id węzła = odcisk klucza; nazwa wyświetlana edytowalna.
- **Parowanie:** na A „Link computer” → jednorazowy kod (krótko ważny) plus adresy A; na B wpisujesz adres
  i kod. Strony wymieniają klucze publiczne i je przypinają. Kod działa raz, z limitem prób.
- **Łącze:** gRPC po HTTP/2 z wzajemnym TLS na certyfikatach powiązanych z przypiętymi kluczami węzłów —
  szyfrowane i uwierzytelnione także w sieci publicznej. Rozłączenie = odwołanie klucza partnera.
- **Protokół wersjonowany** (konieczne): w handshake wersja i lista funkcji. Drobne różnice działają dalej
  (funkcje negocjowane), niezgodność daje jasny stan „Laptop B needs an update” zamiast cichych błędów.
  Migracje baz są niezależne per komputer.

## Trasy (adresy) i wykrywanie w sieci lokalnej

Partner ma listę tras: adres, źródło (ręczna, wykryta w LAN, ogłoszona przez partnera), ostatni sukces,
opóźnienie. Łączenie próbuje tras w kolejności ostatniego sukcesu.

Wykrywanie w LAN **dotyczy tylko już połączonych komputerów**: gdy oba znajdą się w tej samej podsieci,
wykrywają się, wykonują test połączenia i zapisują nową trasę automatycznie. To tylko nowa droga między
komputerami, które już sobie ufają. Ogłoszenie w sieci (mDNS) zawiera wyłącznie nieprzezroczysty,
rotowany identyfikator wyliczany z sekretu łącza, więc obcy w sieci (kawiarnia) nie rozpoznają ani
aplikacji, ani komputera. Wykrywanie jest konfigurowalne (domyślnie włączone).

## Udostępnianie dalej (przechodniość)

Połączenia nie są automatycznie przechodnie. Przykład: komputer służbowy **W** ↔ prywatny **P1** ↔ prywatny
**P2**. Na P1 przy każdym partnerze ustawiasz, których innych partnerów mu udostępnia („Share onward”):
np. W widzi P2 albo nie. Pierwsza wersja trasuje ruch W↔P2 **przez P1** (P1 ufa obu i jest twój);
bezpośrednie połączenie W↔P2 po „przedstawieniu” przez P1 to późniejsza optymalizacja. Odznaczenie
na P1 natychmiast odbiera W dostęp do P2. Gdy P1 jest offline, udostępnione przez niego komputery są dla W
niedostępne (z czytelnym powodem).

## Rozłączenie i przeniesienie

- **Rozłączenie komputera:** na pozostałych znika wszystko, co go dotyczyło (lustra wątków i botów, trasy,
  klucz). Na samym komputerze dane zostają nietknięte. Powiązania przez granicę (np. wątek-dziecko na
  innym komputerze) stają się odłączonymi odwołaniami.
- **Przeniesienie („Move to…”)** bota, wątku, wybranych rzeczy albo wszystkiego — np. przy wymianie
  laptopa na nowy, już połączony. Docelowy komputer importuje pełny stan i staje się domem; źródło
  zostawia przekierowanie, a lustra aktualizują właściciela. Operacja dwufazowa, odporna na zerwanie.
  - Bot: rozmowa, rutyny, przypomnienia, notatki handoff; konta connectorów trzeba autoryzować na nowym
    komputerze (UI to pokazuje).
  - Wątek: historia przechodzi, ale sesja CLI i pliki są lokalne dla maszyny — kontynuacja na workerze
    celu z notatką przekazania (jak [handoff botów](bots.md)) w workspace tego projektu na nowej maszynie.

## Aplikacja mobilna i przeglądarka

Telefon i przeglądarka łączą się z jednym gatewayem i widzą przez niego wszystkie połączone komputery
(zsumowany widok), bez osobnego parowania z każdym.

## UI (szkic)

- Settings → **Linked computers**: lista z nazwą, stanem, trasami i wersją; „Link computer”; przy partnerze
  „Share onward”, „Move to…”, „Unlink”.
- Sidebar, lista botów, nagłówek wątku: znaczek maszyny; wyszarzenie i „last seen” dla niedostępnych.
- Banner w wątku niedostępnego komputera; okno konfliktu konfiguracji; stan „needs an update”.
- Znaczki „This computer” / „All linked computers” w ustawieniach.

## Etapy

1. Tożsamość węzła, parowanie, łącze (mTLS, wersjonowanie), stan obecności, Settings → Linked computers.
2. Zsumowany overview i zdalne wątki: lista, odczyt na żywo, pisanie/steer/zgody trasowane do domu,
   tworzenie wątku na workerze partnera.
3. Lustra osi czasu: odczyt offline, wznowienie od kursora, pełna resynchronizacja.
4. Wspólna konfiguracja: oznaczanie elementów, sekrety, konflikty, znaczki wspólne/lokalne w UI.
5. Boty i szyna agentów przez granicę (rozmowa, bot↔bot, `spawn_thread`, raporty).
6. Wykrywanie tras w LAN.
7. Udostępnianie dalej z trasowaniem przez pośrednika.
8. Przeniesienie rzeczy między komputerami.

Każdy etap z testami integracyjnymi gateway↔gateway (dwa gatewaye i bazy w teście); bez testów UI.

## Konkretny protokół etapu 1

Implementacja: `apps/gateway/src/computers/{identity,store,transport,runtime}.ts`, migracja
**0048_linked_computers**, kontrakty `proto/canopy/link/v1/link.proto` i
`proto/canopy/ui/v1/computers.proto`. Każdy gateway zachowuje własną bazę i klucz sekretów.
To nadal dodatek do lokalnego trybu desktopu. Nie dodaje agregacji, luster, zdalnych akcji ani kolejek.

### Tożsamość i certyfikaty

Gateway tworzy ECDSA P-256 przez WebCrypto i samopodpisany X.509 przez przypięty pakiet
`@peculiar/x509`. Id węzła to SHA-256 DER SPKI klucza publicznego; fingerprint w UI i kodzie
to SHA-256 całego DER certyfikatu. Domyślna nazwa pochodzi z `hostname()`. Prywatny PKCS#8
jest zapisany wyłącznie jako envelope AES-256-GCM istniejącego `CANOPY_SECRETS_KEY`.
Nie trafia do proto, BFF, workera, przeglądarki, argv ani logów.

Certyfikat jest ważny 20 lat, z minutą tolerancji przy utworzeniu. Nie ma automatycznej
rotacji zaufania ani cichego odnowienia certyfikatu: zmiana certyfikatu wymaga ponownego
parowania. Zmiana klucza zmienia też id węzła. Po reinstalacji/rotacji usuń starą relację
przez Unlink i sparuj nową tożsamość. Ponowne parowanie tego samego węzła jawnie zastępuje
pin i zamyka stare strumienie. Mismatch certyfikatu podczas reconnect pokazuje komunikat
o potrzebie ponownego parowania; nigdy nie nadpisuje pinu automatycznie.

### Listener i sieć

| Zmienna | Znaczenie |
|---|---|
| `CANOPY_LINK_HOST` | Jawny bind osobnego listenera TLS. Brak = listener wyłączony; wychodzące parowanie nadal działa. |
| `CANOPY_LINK_PORT` | Port listenera. Brak/0 = wolny port przy starcie; serwer powinien ustawić stały port. |
| `CANOPY_LINK_ADDRESSES` | Lista originów HTTPS rozdzielona przecinkami, bez ścieżek/credentials. Dla konkretnego bindu domyślnie jego adres; wildcard wymaga jawnej listy. |

Nie ma nowego stałego portu produktu. Desktop wybiera wolny port na wybranym interfejsie,
zapisuje go w `userData/computer-link.json` i używa ponownie po restarcie. BFF, główny gRPC
i Postgres pozostają na swoich portach loopback. Przełącznik Settings → Linked computers
zapisuje stan listenera w bazie; możliwość wystawienia go jest dodatkowo ograniczona przez
desktopowe „Allow other machines to connect”. Wyłączenie listenera nie odwołuje partnerów
ani nie zamyka niezależnych połączeń wychodzących. Zmiana adresu interfejsu wymaga co najmniej
jednej działającej trasy; przy zmianie wszystkich tras obu stron jednocześnie potrzebne jest
ponowne parowanie po podaniu nowego adresu. Wykrywanie LAN jest etapem 6.

TLS co najmniej 1.3, HTTP/2 gRPC. Ruch nie przechodzi przez TLS-terminujący proxy: proxy musi
przekazywać TCP/TLS bez zakończenia sesji. VPN/Tailscale są wyłącznie trasą, nie źródłem zaufania.
Klient zastępuje systemowe CA dokładnym certyfikatem partnera i sprawdza jego pełny fingerprint
zamiast nazwy DNS. Odrzuca także certyfikat potomny podpisany przypiętym kluczem: pin dotyczy
dokładnego certyfikatu, nie dowolnego łańcucha. Serwer żąda certyfikatu klienta; TLS sprawdza
posiadanie klucza, a aplikacja sprawdza samopodpis, ważność i pin przed dopuszczeniem `Connect`.
Listener nie wystawia UI, WorkerLink, enrollment ani UpdateService.

### Parowanie bez niezaufanego pierwszego żądania

1. BFF z service tokenem wywołuje `CreateComputerPairing`. Nowy kod odwołuje poprzedni.
   Kod to fingerprint A (64 hex) + 128 losowych bitów (32 hex), pogrupowane po osiem znaków.
   Jest przeznaczony do kopiowania. Dzięki zawartemu pinowi krótki PIN ani zaufanie do sieci
   nie są potrzebne. Ważność wynosi 10 minut; baza przechowuje tylko SHA-256 części losowej.
2. B wpisuje adres A i kod. Wstępny handshake TLS pobiera publiczny certyfikat i porównuje go
   z fingerprintem z kodu. **Nie wysyła żądania HTTP ani sekretu**. Zły certyfikat kończy próbę.
3. B otwiera osobne, już przypięte połączenie mTLS i wywołuje `ComputerLinkService.Pair`:
   `PairRequest {secret, hello}`. A wiąże `hello.node_id` z rzeczywistym certyfikatem klienta.
   Nie przyjmuje certyfikatu ani klucza od klienta w treści wiadomości.
4. Transakcja A atomowo zużywa zaproszenie i zapisuje partnera. `PairResponse {hello}` opisuje A;
   B zapisuje A z certyfikatu już zweryfikowanej sesji. UI obu stron pozwala porównać fingerprinty.
   Utrata odpowiedzi/awaria między zapisami wymaga nowego kodu, jak enrollment workera.
5. Wszystkie próby wymiany zużywają trwały globalny budżet 30/min i budżet 10 prób aktywnego kodu,
   także po restarcie procesu. Nie zależą od IP ani nagłówków proxy. Expiry, revoke i replay są
   sprawdzane w transakcji według czasu DB po uzyskaniu blokad. Zamknięcie okna odwołuje kod;
   po odświeżeniu przeglądarki sekret nie jest ponownie dostępny i wygasa sam.

Tylko `Pair` przyjmuje nowy samopodpisany certyfikat. `Connect` wymaga dokładnego pinu;
poprawny certyfikat systemowego CA lub innego Canopy nie wystarcza. Zarządzanie jest owner-scoped
i dostępne wyłącznie BFF z service tokenem, bez tokenów telefonów i bez dostępu dla modeli.

### Strumień i zgodność

`canopy.link.v1.ComputerLinkService.Connect` to dwukierunkowy strumień `LinkFrame` z typowanym
`oneof`: `hello`, `welcome`, `heartbeat`, `presence`, `unlinked`. Pierwsze żądanie musi być `hello`.
`NodeHello` zawiera id/nazwę, adresy, wersję aplikacji, dodatni zakres `min_protocol..max_protocol`
i listę capabilities (`presence`, `unlink`). `LinkWelcome` zwraca własne hello, wybrany wspólny
numer albo 0 oraz `update_node_id`. Obecnie zakres to 1–1; stałe
`COMPUTER_LINK_PROTOCOL` / `MIN_COMPUTER_LINK_PROTOCOL` są niezależne od WorkerLink i UpdateService.

Brak przecięcia zakresów utrzymuje wyłącznie kanał kontrolny i stan `needs_update` na obu stronach.
Oba gatewaye wyliczają tę samą tożsamość wymagającą aktualizacji; UI pokazuje nazwę partnera albo
„This computer needs an update”. Wersja aplikacji nie decyduje o zgodności. Etap 2 może dodać
nowe warianty `LinkFrame` i capabilities, ale musi wymagać wynegocjowanego dodatniego protokołu
i obsługiwanej funkcji. Istniejące pola/numery/znaczenia pozostają addytywne. Zamrożony
`canopy.update.v1` i WorkerLink nie są zmienione.

Każda strona może inicjować połączenie, więc wystarczy jedna osiągalna strona. Możliwe są dwa
równoczesne strumienie; utrata jednego nie oznacza niedostępności, jeżeli drugi nadal działa.
Heartbeat co 5 s, brak odbioru przez 20 s zamyka strumień; transport dodatkowo używa HTTP/2 PING.
Reconnect próbuje znanych tras kolejno, z backoff 1–30 s i jitterem; po handshake zachowuje adresy
ogłoszone przez partnera. Nie ma outboxu pracy ani zdalnych akcji w etapie 1.

### Obecność i odwołanie

Obecność zapisuje stan, czas lokalnego zaobserwowania zmiany i last seen. Tylko udany handshake
przywraca `connected`; niezgodność daje `needs_update`. Zanik bez ogłoszenia daje `unreachable`.
Peer może wcześniej wysłać `Presence {state, announced_at_ms}`: `updating`, `sleeping`,
`shutting_down`, a po wznowieniu `connected`. UI zachowuje ogłoszony stan i jego czas po utracie
łącza; nie zgaduje bieżącej przyczyny. Heartbeat nie zamienia ogłoszenia w Connected.
Restart lokalnego procesu resetuje stare stany aktywnego połączenia, ale zachowuje ogłoszenia
partnera. Desktop korzysta z `powerMonitor` suspend/resume, quit i restartu aktualizacji;
gateway serwerowy ogłasza graceful shutdown lub restart aktualizatora. Awaria/SIGKILL/wyłączenie
systemu bez czasu na wysłanie ramki nie dają gwarancji ogłoszenia.

Unlink usuwa aktywny rekord partnera, trasy i certyfikat, a następnie zamyka jego strumienie.
Online peer otrzymuje `Unlinked` i usuwa swój rekord. Gdy był offline, baza zachowuje wyłącznie
id odwołanego węzła (bez adresów i certyfikatu). Przy jego przyszłym połączeniu, po weryfikacji
posiadania tego klucza, serwer odpowiada wyłącznie `Unlinked`; nie przywraca dostępu. Druga strona
uwierzytelnia tę odpowiedź nadal przypiętym certyfikatem. Ponowne jawne parowanie usuwa znacznik
odwołania. To trwałe odwołanie zaufania, nie kolejka komend użytkownika.

### Dowody

`tests/integration/linked-computers.test.ts` uruchamia dwa prawdziwe core/API gatewaya,
dwa listenery mTLS i dwie oddzielne bazy PostgreSQL w Dockerze. Sprawdza piny, szyfrowanie klucza,
replay/wrong/expiry/revoke/limity, obcy poprawny certyfikat, inny klucz pod tym samym adresem,
niezgodność obu stron, obecność, reconnect po restarcie serwisu, nazwy i unlink online/offline.
Kontrola UI przechodzi przez dwa produkcyjne gatewaye/BFF za pomocą jednorazowej automatyzacji
Chromium poza repo; screenshoty obejrzano. Nie dodaje testów komponentów/E2E do repo.
Wyniki i screenshoty: [raport etapu 1](../artifacts/linked-computers/verification.md).
