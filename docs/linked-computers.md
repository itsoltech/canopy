# Połączone komputery (projekt)

Status: **etapy 1–5 zaimplementowane** (2026-11-03). Etap 1: tożsamość, parowanie, przypięty mTLS,
wersjonowanie, obecność i Settings → Linked computers. Etap 2: zsumowany overview i zdalne wątki
(lista, odczyt na żywo, pisanie, steer, kolejka, przerwanie, zgody i tworzenie wątku na workerze
partnera, trasowane do domu). Etap 3: trwałe lustra wątków do odczytu offline, kursor i pełna
resynchronizacja. Etap 4: wspólna konfiguracja (oznaczanie elementów, sekrety, konflikty, znaczki).
Etap 5: zdalne boty z odczytem offline oraz szyna agentów między domami (spawn, wiadomości,
pytania i raporty). Etapy 6–8 poniżej pozostają projektem; cały stos PR-ów pozostaje draftem.

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

## Konkretny protokół etapu 2

Implementacja: `apps/gateway/src/computers/remote.ts` (wywołania na łączu, przepisywanie id),
`apps/gateway/src/api/routed.ts` (trasowanie `GatewayService`), `packages/domain/src/computers.ts`
(format id), UI w `apps/web/src/lib/features/computers`. Bez nowej migracji: capabilities połączenia
są stanem w pamięci, nic z partnera nie trafia do bazy A.

### Capability zamiast nowej wersji protokołu

Gateway ogłasza w `NodeHello.capabilities` funkcję **`remote_threads`**, gdy ma czym obsłużyć wywołania.
Nowe warianty `LinkFrame` (`remote_request` 6, `remote_response` 7, `remote_cancel` 8) są wysyłane
wyłącznie połączeniu z wynegocjowanym dodatnim protokołem **i** tą capability partnera. Gateway etapu 1
zamknąłby strumień na nieznanej ramce, ale nigdy jej nie dostanie, bo jej nie ogłasza. Dlatego
`COMPUTER_LINK_PROTOCOL` zostaje 1: zmiana jest addytywna i negocjowana funkcją, a starszy partner
dalej działa w kanale kontrolnym. Partner połączony bez capability ma w UI stan „Laptop B needs an update
to share its threads” (Settings → Linked computers: znaczek „Needs an update”), a każda akcja na jego
wątkach kończy się tym samym komunikatem (`FAILED_PRECONDITION`).

### Wywołania przez łącze

`RemoteRequest {call_id, method, payload, more}` niesie wywołanie `canopy.ui.v1.GatewayService` (nazwa
metody, binarny protobuf żądania), `RemoteResponse {call_id, payload, more, end, code, message}` kolejne
wiadomości odpowiedzi (unary: jedna, stream: wiele) i koniec z kodem Connect. Ładunki są dzielone na
kawałki 32 KiB (limit ramki łącza 64 KiB zostaje), złożona wiadomość ma limit 48 MiB. `RemoteCancel`
przerywa wywołanie u domu (zamknięty strumień przeglądarki, timeout). Identyfikatory wywołań wybiera
wołający, osobno dla każdego kierunku połączenia. Każda strona może wołać przez dowolne gotowe
połączenie, więc wystarczy, że jedna strona ma listener.

Dom obsługuje tylko listę dozwolonych metod wątków (`SERVED`): overview, lista i odczyt wątków,
`WatchThread`, tworzenie wątku, wiadomości (kolejka i steer), przerwanie, odpowiedzi na zgody i pytania,
zarządzanie kolejką, ustawienia wątku, tytuł, cel, zadania w tle, przeczytanie/archiwizacja/usuwanie,
modele, katalogi workera, wzmianki plików, załączniki i bloby osi czasu. Inne metody (ustawienia,
instancje dostawców, sekrety wątków, connectory, boty, harmonogramy, workery, aktualizacje, komputery,
telefony) zwracają `UNIMPLEMENTED`. Żądanie partnera wykonuje się lokalnymi handlerami, jako właściciel
tego gatewaya, bez dalszego trasowania i bez agregacji (brak przechodniości, etap 7). Żądanie
zawierające id innego komputera jest odrzucane. Błędy przechodzą wyłącznie jako kod i komunikat
domeny; nieznany błąd to „internal error” bez szczegółów.

Wywołanie przed wysłaniem sprawdza, czy partner nadal jest sparowany. Unlink zamyka połączenie,
a wraz z nim przerywa wszystkie wywołania w obu kierunkach. Utrata połączenia kończy otwarte wywołania
błędem `UNAVAILABLE` („Laptop B disconnected”). **Nic nie jest kolejkowane**: brak gotowego połączenia
to natychmiastowy błąd z powodem z obecności etapu 1 — „Laptop B is unreachable since 19:42”,
„is updating since …”, „went to sleep at …”, „shut down at …”, „needs an update”, „must be paired again”
(godzina w strefie użytkownika). Unary ma limit 30 s, zbieranie overview/list z partnerów 3 s;
partner, który nie odpowie, jest pomijany, a nie oczekiwany.

### Id i trasowanie w gatewayu

Id z domu dostaje sufiks `~` + pierwsze 16 znaków hex id węzła domu (`<uuid>~<node16>`), np. id wątku,
tury, interakcji, workera, projektu, workspace'u i załącznika. Przepisywanie jest generyczne (refleksja
protobuf): każde pole tekstowe `id`, `*_id`, `*_ids` z wartością uuid. Wątki, workery i projekty
partnera mają `node_id` z pełnym id węzła domu (800 dla projektu i wątku, 802 dla workera;
800–801 workera zajmują pola CLI). Przeglądarka i telefon nie trasują niczego:
wysyłają id tak, jak je dostały. `routed.ts` po sufiksie wybiera partnera (prefiks musi wskazywać
dokładnie jednego), zdejmuje sufiks, wysyła wywołanie i kwalifikuje odpowiedź. Żądanie mieszające id
dwóch komputerów albo lokalny uuid w wywołaniu do partnera jest odrzucane („Choose a project, worker
and thread on the same computer”). Wyjątek: załączniki wgrane na A do wiadomości dla wątku B gateway A
odczytuje i wgrywa na B (`UploadAttachment`), a w żądaniu podmienia na id z B.

Metody spoza listy z kwalifikowanym id najwyższego poziomu (np. `ListSchedules` dla wątku B) dają
„This isn't available for threads on another computer yet”. Sekrety wątków nie przechodzą przez łącze.
Przypięcia i filtr projektów sidebara mogą zawierać id kwalifikowane (walidacja `isEntityId`).

### Zsumowany widok

- `GetOverview`: lokalne workery i projekty plus te z każdego partnera, który udostępnia wątki teraz,
  oraz `computers` (800): wszyscy partnerzy z obecnością i capabilities.
- `ListThreads` bez projektu i `ListModels` bez workera: lokalne plus partnerzy; z kwalifikowanym
  projektem/workerem — tylko dom.
- `WatchOverview`: lokalny strumień plus, dla każdego udostępniającego partnera, jego `WatchOverview`
  z `include_snapshot` rozpakowanym do zmian `worker`/`project`/`thread`. Zmiana obecności, nazwy
  albo capabilities partnera to `OverviewUpdate.computer` (800), Unlink — `computer_removed` (801).
  Ustawienia, harmonogramy i urządzenia partnera nie są przekazywane. Migawka telefonu
  (`include_snapshot`) obejmuje także partnerów.
- `ListArchivedThreads` pozostaje lokalne (stronicowanie per komputer); archiwum partnera jest u niego.

W etapie 2 wątki partnera są widoczne **tylko gdy jest połączony** i udostępnia wątki. Gdy zniknie,
UI usuwa jego workery, projekty i wątki z list (lustra offline to etap 3). Otwarty wątek zostaje
na ekranie z ostatnim stanem, z bannerem „Read only for now” i powodem, a composer jest zablokowany.

### UI

Znaczek maszyny (`MachineBadge`: ikona łącza i nazwa) przy wątku partnera w sidebarze i nagłówku
wątku, w karcie podglądu wątku, przy projekcie w pickerze projektu (status wiersza i pigułka) oraz
„On Laptop B” przy workerze. Nowy wątek na workerze partnera: wybierasz projekt partnera i jego
workera; B zostaje właścicielem. Ekrany konfiguracji per komputer (projekty, workery, dostawcy,
connectory, domyślne ustawienia wątków, harmonogramy) pokazują wyłącznie własne rzeczy
(`ownWorkers`/`ownProjects`), bo konfiguracja wspólna to etap 4. Harmonogramy wątków partnera są
w tym etapie niedostępne.

### Dowody

`tests/integration/remote-threads.test.ts`: dwa prawdziwe gatewaye z osobnymi bazami PostgreSQL,
skryptowany worker na B, łącze mTLS. Sprawdza zsumowany overview i modele (bez echa A przez B),
utworzenie wątku z A na workerze B (wątek tylko w bazie B) i strumień na żywo, wiadomość, steer,
kolejkę (usunięcie tury po kwalifikowanym id) i przerwanie wykonane na B, zgodę z B odpowiedzianą z A,
załącznik wgrany na A dostarczony na B, overview na żywo (wątek utworzony na B, obecność „updating”),
niedostępnego partnera (błąd „unreachable since HH:MM” w < 1,5 s, brak partnera w overview, po
powrocie brak dostarczonej wiadomości), partnera bez capability („needs an update”), odmowę metod
spoza listy i żądań przez inny komputer oraz brak dostępu po Unlink w obie strony, także surowym
przypiętym strumieniem z `remote_request` (odpowiedź wyłącznie `unlinked`).

Odroczone po etapie 2 (lustra i kursory są już opisane w etapie 3): wspólna konfiguracja, harmonogramy i sekrety (4), boty
i szyna agentów przez granicę (5), archiwum partnera w sidebarze A, wyszukiwanie wątków partnera we
wzmiankach.

## Konkretny protokół etapu 3

Implementacja: `apps/gateway/src/computers/mirror.ts`, runtime łącza i `api/routed.ts`;
migracja **0049_thread_mirrors**. To wyłącznie projekcje do odczytu: żadne API wykonawcze,
planista, bot ani outbox nie korzysta z tabel lustra.

### Dziennik domu i subskrypcja

Capability **`thread_mirror`** rozszerza istniejący protokół 1–1. Nie podbijamy numeru:
wszystkie zmiany proto są addytywne, a nową subskrypcję uruchamiamy tylko przy wspólnym
protokole i capability obu stron. `ThreadMirrorService.WatchThreadMirror(MirrorRequest{cursor})`
działa jako wewnętrzna metoda transportu `RemoteRequest`/`RemoteResponse` po przypiętym mTLS;
nie jest zarejestrowana jako publiczne RPC gatewaya ani listenera parowania. Nadal obowiązują
limity i anulowanie wywołań etapu 2 oraz sprawdzanie aktywnego partnera przed obsługą.
Nie ma routingu do trzeciego komputera.

`computer_thread_clock(owner_user_id,epoch,revision)` nadaje kursor **`<uuid-epoki>:<rewizja>`**.
Trigger aktualizuje licznik wiersza i dopisuje `computer_thread_changes` w transakcji zmiany
wątku, itemu, tury/kolejki, interakcji, celu, steeru, zdarzenia diagnostycznego, dostarczenia busa
lub stanu przeczytania. Zmiana projektu,
workera lub workspace'u unieważnia metadane overview. Licznik wiersza, zamiast sekwencji SQL,
zapewnia kolejność commitów: nie da się zatwierdzić rewizji N+1 przed N i pominąć spóźnionego N.
Triggery są `DEFERRABLE INITIALLY DEFERRED`: dopisują dziennik na końcu transakcji, po blokadach
danych wykonawczych. Wspólny transakcyjny advisory lock porządkuje także zmiany metadanych
wielu właścicieli. Dzięki temu licznik nie odwraca kolejności blokad tury i wątku.
Dziennik zawiera identyfikatory, nigdy wiersze sekretów ani payloady komend.

Subskrypcja odczytuje zmiany co 250 ms i scala wielokrotne unieważnienia tego samego wątku.
Zmiana źródła forka unieważnia też jego potomków, którzy pokazują odziedziczone itemy i tury.
Publikuje jego bieżący `ThreadSnapshot` (wszystkie itemy i tury, kolejka, interakcje, steery,
cel, komunikaty zgodne ze snapshotem UI) i minimalne metadane workerów/projektów.
Zwykły żywy snapshot UI zachowuje do 200 komunikatów diagnostycznych; publisher lustra
uzupełnia je pełną historią z dziennika domu. Nie przycinamy itemów, tur ani komunikatów.
Sekrety wątku i harmonogramy są usuwane z projekcji; konfiguracja
providerów, poświadczenia i wartości sekretów platformy nie są przesyłane ani zapisywane.
Treści zwykłych wiadomości/transkryptu pozostają treścią rozmowy użytkownika.

Oś czasu jest przesyłana jako `snapshot_start`, nagłówek, fragmenty kolekcji i `snapshot_end`.
Limit 48 MiB dotyczy pojedynczej wiadomości transportu (np. pojedynczego itemu), nie całej osi.
Receiver składa pełny snapshot przed zapisaniem; urwany fragment nigdy nie zastępuje historii
częściową listą itemów. Domyślnie przechowujemy **pełne osie czasu**, także wątków archiwalnych;
limit retencji osi to późniejsza opcja. Dziennik unieważnień zachowuje około 10 000 ostatnich
zmian właściciela; nie ogranicza to długości zapisanej historii.

### Kursor, luki i atomowa resynchronizacja

Partner zapisuje `computer_mirror_state(owner_user_id,origin_node_id,cursor,generation,overview)`
i `computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot)`.
Snapshoty są projekcjami protobuf; nie wstawiamy niczego do lokalnych `threads`, `turns`,
`worker_commands` ani tabel uprawnień. Klucze obce do partnera mają `ON DELETE CASCADE`.

Po reconnect/restart subskrypcja wysyła ostatni zapisany kursor. Dom sprawdza epokę, zakres
i ciągłość dostępnych rewizji. Brak kursora, za stary kursor, kursor z przyszłości/innej epoki
lub luka w dzienniku powodują pełny resync wszystkich wątków tego partnera. Skala osobista
uzasadnia resync całego partnera zamiast osobnego protokołu naprawy zakresów. `previous_cursor`
przy przyroście chroni przed pominięciem/niezgodnością partii; błąd uruchamia resync od zera.

Pełny resync przygotowuje osobną generację. Stara pozostaje widoczna aż do końcowego `commit`;
przełączenie generacji, metadanych i kursora jest jedną transakcją. Zamknięcie subskrypcji usuwa
niedokończoną generację, zachowując poprzedni czytelny stan. Po SIGKILL osierocone generacje
pozostają niewidoczne i są usuwane przy kolejnym zatwierdzonym checkpointcie. Przyrosty zastępują pełne projekcje po kluczu
wątku; końcowy checkpoint zapisuje kursor, więc ponowienie po awarii jest idempotentne.
Cursor jest pobierany **przed** projekcjami: zmiany współbieżne zostaną ponownie objęte kolejną
partią. Usunięcie daje tombstone (`removed_thread_id`); pełny resync usuwa brakujące wątki.
Archiwizacja i przywrócenie zmieniają wiersz/status, kolejność itemów pozostaje z domu.
Każdy fragment sprawdza poprzedni kursor, a checkpoint także format, epokę i postęp rewizji.
Blokada wiersza i porównanie kursora oraz generacji odrzucają opóźnioną subskrypcję innej
instancji gatewaya, także gdy resync zachował ten sam kursor.

### Odczyt i dostępność

Online używamy nadal **żywej trasy etapu 2** dla list, odczytu i subskrypcji UI: zmiana w domu
jest widoczna bez czekania na cykl lustra. Lustro synchronizuje się niezależnie od otwartych kart.
Po reconnect overview emituje addytywny `OverviewUpdate.computer_snapshot` (pole 802):
pełną widoczną listę wątków i metadane jednego partnera. UI zastępuje jego wiersze, więc usunięty
offline wątek nie zostaje na liście jako stara aktualizacja. Pojedyncze upserty nadal są emitowane
dla starszych klientów.
Offline `GetOverview`, `ListThreads` (także per projekt), `GetThread` i pierwszy snapshot
`WatchThread` czytają ostatnią zatwierdzoną generację. Po zmianie obecności strumień offline
kończy się; zwykły reconnect UI otwiera ponownie odczyt z domu. Niezsynchronizowany wątek
dostaje jasny błąd zamiast pustej historii.

Wątki pozostają na liście wyszarzone z „Last seen”; banner i karta podglądu wyjaśniają odczyt
zsynchronizowanej osi czasu oraz brak kolejkowania. Composer, zgody, kolejka, kontynuacja tury, fork,
akcje tytułu i zatrzymywanie pracy są zablokowane. Worker partnera nie udaje online.
Zapisy zawsze przechodzą do domu i natychmiast odmawiają, gdy łącze jest niedostępne.

**Pliki:** lustro zawiera metadane załączników i referencje blobów z itemów/tur, ale **nie ich
bajty ani miniatury**. Online pobieramy zawartość z domu istniejącymi RPC; offline UI pokazuje
„Available when Laptop B is connected”, bez aktywnego pobierania. Istniejące widoki dużych
tekstowych blobów nadal mają ograniczenia podglądu opisane w UI. Załączniki przesłane wcześniej
na A nie stają się automatycznie zawartością lustra B.

Capabilities partnera są trwale zapisywane, żeby restart A zachował możliwość odczytu offline.
Partner bez `thread_mirror` zachowuje zachowanie etapu 2: tylko online; Settings → Linked
computers wyjaśnia „Needs an update for offline reading”. Kolejny handshake zastępuje capability,
więc downgrade nie odsłania starego lustra offline. Unlink usuwa partnera, wszystkie generacje,
metadane i kursor na tej stronie; lokalne dane domu pozostają nietknięte.

### Weryfikacja

`tests/integration/thread-mirrors.test.ts`: dwa gatewaye i oddzielne PostgreSQL, prawdziwe mTLS
i skryptowane workery. Obejmuje istniejącą historię, żywe zmiany, kolejkę i metadane plików,
odczyt offline i szybką odmowę zapisów bez kolejki, wznowienie bez zmiany generacji, resync po
przycięciu dziennika i zmianie epoki, usunięcia/archiwizację oraz wymianę listy po reconnect,
błędny poprzednik fragmentu/checkpoint, przerwany i współbieżny resync, rekoncyliację źródła forka,
nowy core i listener A na tej samej bazie, fallback starszego partnera, owner scoping i Unlink.
Test współbieżnych transakcji blokujących turę i wątek chroni przed odwróceniem kolejności
blokad przez dziennik. Test bezpieczeństwa tworzy rzeczywiste metadane sekretu w domu i sprawdza
ich brak w zapisanej binarnej projekcji partnera.
Nie dodaje testów UI. `schema.test.ts` obejmuje migrację 0049.

## Konkretny protokół etapu 4

Implementacja: `apps/gateway/src/computers/shared.ts` (stan, wektory wersji, push/odbiór, konflikty),
runtime łącza, `api/routed.ts` (wspólna tożsamość projektu), migracja **0050_shared_config**,
kontrakty `SharedConfigService` w `canopy.link.v1` i `GetSharedConfig`/`ManageSharedConfig` w
`canopy.ui.v1`. UI: `apps/web/src/lib/features/computers` (`ShareSetting`, `ShareScope`,
`ConflictDialog`, `SharedConfigOverview`) i `providers/SharedInstance.svelte`.

### Elementy i ich pola

Udostępnianie jest **opt-in per element** (przełącznik „Share with linked computers”). Klucze są takie
same na każdym komputerze:

| Klucz | Wspólne pola | Zostaje na komputerze |
|---|---|---|
| `instance:<harness>:<id>` | nazwa, rodzaj, endpoint, kolor, klucz API, zmienne (także sekretne) | ścieżki CLI, katalogi, argumenty, własne logowanie, workery i ich nadpisania, stan instalacji CLI |
| `models:<harness>:<id>` | ulubione, ukryte, pokazane i własne modele instancji | — |
| `settings:appearance` | schemat kolorów, motyw, szerokość czatu | układ paneli i paska bocznego |
| `settings:thread_defaults` | dostawca, instancja, uprawnienia, modele | domyślny workspace |
| `settings:timezone` | strefa IANA | — |
| `settings:text_generation` | instancja, model, wysiłek, instrukcje tytułów | — |
| `project:<uuid>` | tożsamość (to samo id) i nazwa | workspace'y, ustawienia projektu |

Wbudowanego logowania urządzenia (`native`) nie udostępniamy jako definicji; jego listy modeli tak.
Listę modeli innej instancji można udostępnić dopiero razem z instancją. Nigdy nie są synchronizowane:
ścieżki CLI, logowania natywne, workspace'y, adresy, porty, ustawienia desktopu, konta connectorów
i stan instalacji CLI. UI pokazuje to przy connectorach i ustawieniach desktopu znaczkiem „This computer”.

Nowa wspólna instancja jest u odbiorcy włączona na wszystkich jego workerach (`all_workers`), żeby od razu
działała; dalszy wybór workerów jest lokalny. Gdy żaden worker odbiorcy jej nie uruchamia (brak CLI),
szczegóły instancji wyjaśniają to ostrzeżeniem.

### Stan i wersje

`computer_shared_items` przechowuje per element: `shared`, **wektor wersji** (`{node_id: licznik}`),
skrót SHA-256 kanonicznego JSON-a wspólnych pól, komputer i czas ostatniej zmiany, mapę
`secrets.id → token` oraz notatkę o lokalnej kopii. Wartości pozostają w swoich tabelach
(`provider_instances`, `user_settings`, `projects`). Każda strona co heartbeat (oraz od razu po zapisie
przez UI: `SaveProviderInstance`, `DeleteProviderInstance`, `SetInstanceModels`, `UpdateUserSettings`,
`RenameProject`, `ArchiveProject`) porównuje skrót z bieżącą wartością; zmiana podbija jej licznik
w wektorze. UI pokazuje sumę wektora jako wersję i komputer, który zmienił element ostatnio.

`computer_shared_acks(owner, node_id, item_key, digest, shared)` zapamiętuje, co partner potwierdził.
`computer_shared_conflicts` trzyma pytania do czasu odpowiedzi. Obie tabele mają `ON DELETE CASCADE`
do `computer_peers`.

### Protokół

Capability **`shared_config`**; `COMPUTER_LINK_PROTOCOL` zostaje 1 (zmiana addytywna, negocjowana
funkcją, jak w etapach 2–3). `SharedConfigService.PushSharedConfig(SharedConfigPush)` jest wewnętrzną
metodą transportu `RemoteRequest`/`RemoteResponse` po przypiętym mTLS, obsługiwaną tylko przy
capability obu stron i aktywnym partnerze. Każda strona wysyła partnerowi elementy, których
potwierdzony skrót różni się od bieżącego (po każdym handshake — wszystkie), w kolejności instancje,
modele, ustawienia, projekty. `SharedItem` niesie klucz, `shared`, wektor, skrót, kanoniczny JSON
pól bez wartości sekretów, autora i czas, a dla wyłączonych: powód (`deleted`).

Odbiorca dla każdego elementu (pod jedną blokadą stanu, nigdy trzymaną w czasie wywołania partnera):

- ten sam skrót → `same` (scala wektory, usuwa ewentualne pytanie);
- element już wspólny: wektor nadawcy nowszy → zastosowanie przez własne handlery
  (`SaveProviderInstance`, `SetInstanceModels`, `UpdateUserSettings`, `RenameProject`, nowy projekt
  z tym samym id) → `applied`; własny nowszy → `newer` (odeśle swój); **współbieżne → `conflict`**;
- pierwsze udostępnienie: brak elementu lub wartość domyślna → `applied`; inna istniejąca wartość →
  `conflict` (nie nadpisujemy po cichu lokalnej instancji ani wyglądu);
- brak wymaganego sekretu → `secrets` (nadawca kasuje potwierdzenie i wysyła ponownie z sekretami).

Odpowiedź `applied`/`same` zawiera wektor odbiorcy: nadawca go scala i usuwa własne pytanie o ten
element, gdy obie strony mają już tę samą wartość. Bez tego pytanie po stronie, która nie rozstrzygała,
zostałoby na zawsze, a jej następna zmiana wyglądałaby na współbieżną.

### Sekrety

Klucz API i zmienne sekretne przechodzą **tylko dla elementów oznaczonych jako wspólne** i tylko wtedy,
gdy partner nie potwierdził tej wartości. Nadawca odszyfrowuje je swoim `CANOPY_SECRETS_KEY`, łącze mTLS
je szyfruje, odbiorca zapisuje je nowym wierszem `secrets` zaszyfrowanym **własnym** kluczem (inny
ciphertext). Wartość identyfikuje losowy token (nie skrót sekretu), wspólny dla kopii tej samej wartości;
skrót elementu obejmuje tokeny, więc zmiana klucza jest zmianą elementu. Sekrety nie trafiają do UI,
BFF, logów, workerów innych niż własne odbiorcy (te dostają je jak przy każdej instancji) ani do
modeli. W pytaniu konfliktu sekrety drugiej strony są przechowywane zaszyfrowane kluczem odbiorcy,
a UI widzi wyłącznie „Set”, „Not set” albo „A different key”.

### Konflikty

Ta sama wspólna rzecz zmieniona na dwóch komputerach bez połączenia daje po ponownym połączeniu
pytanie na obu („Keep this computer’s” / „Keep Laptop B’s”), z różniącymi się polami obu wersji.
Nie ma last-writer-wins: każdy komputer zachowuje swoją wartość do odpowiedzi. Zmiany różnych
elementów (np. strefa na A, nazwa projektu na B) przechodzą same. Pytania są trwałe (restart ich
nie gubi), widoczne w Settings → Linked computers („Needs your decision”), przy elemencie
(ostrzeżenie z „Choose a version”) i jako znaczek na listach instancji i projektów.

Odpowiedź jest nową wersją, która widziała obie: wektor = scalenie obu + licznik tego komputera.
„Keep this computer’s” wysyła lokalną wartość, „Keep Laptop B’s” stosuje zapisaną wersję B (z jej
sekretami) i wysyła ją jako tę samą wartość. Druga strona przyjmuje ją bez pytania i usuwa swoje.
Gdy obie strony jednocześnie odpowiedzą przeciwnie, wektory znów są współbieżne i pytanie wraca —
świadomie, zamiast zgadywać.

### Wyłączenie, usunięcie, rozłączenie

- **Wyłączenie udostępniania** na jednym komputerze wyłącza je na wszystkich; każdy zachowuje swoją
  bieżącą wartość jako **kopię lokalną** (z kluczem API zaszyfrowanym własnym kluczem). UI: „Laptop A
  stopped sharing it. This computer keeps its own copy.” Wyłączenie wygrywa z równoczesną zmianą bez
  pytania i usuwa pytania o ten element.
- **Usunięcie** (instancja) lub **archiwizacja** (projekt) wspólnego elementu działa jak wyłączenie
  z powodem `deleted`: na innych komputerach nic nie jest kasowane ani archiwizowane (mogą tam być
  wątki), kopia staje się lokalna („Deleted on Laptop A. This computer keeps its own copy.”).
- **Unlink** usuwa potwierdzenia i pytania dotyczące tego komputera (kaskada). Wartości i flagi
  udostępnienia zostają na obu komputerach; ponowne sparowanie zaczyna jak pierwsze udostępnienie.

### Projekty jako wspólna tożsamość

Wspólny projekt ma to samo id na każdym komputerze. Gateway nie kwalifikuje go sufiksem węzła
(`globalize`), dopuszcza je w wywołaniach do partnera (`unqualify` z listą globalnych id) i pokazuje
projekt raz, z workspace'ami wszystkich połączonych komputerów (kwalifikowanymi). Wątki partnera
w tym projekcie są w nim na liście; nowy wątek na workerze B w projekcie wspólnym trafia do B
z tym samym id projektu.

Strefa czasowa jest jak dotąd brana z urządzenia przeglądarki. Gdy jest wspólna, ostatnie urządzenie,
które ją zgłosi, ustawia ją na wszystkich połączonych komputerach; kto chce różnych stref, zostawia ją
lokalną.

### Partner bez capability

Starszy partner zachowuje etapy 1–3; jego konfiguracja zostaje u niego. `SharedConfigSnapshot`
zawiera `needs_update_node_ids`, a przy wspólnym elemencie UI pisze „Laptop B needs an update to share
configuration and keeps its own”. Kolejny handshake z capability rozpoczyna synchronizację.

### Weryfikacja

`tests/integration/shared-config.test.ts`: dwa prawdziwe gatewaye z osobnymi bazami PostgreSQL
i kluczami sekretów, mTLS. Obejmuje instancję z kluczem API (inny ciphertext, odbiorca odszyfrowuje,
klucz A nie; profil z kluczem na workerze B; brak klucza w odpowiedziach BFF i w logach), listy
modeli, wygląd (pierwsze udostępnienie z pytaniem), domyślne ustawienia wątków bez workspace'u,
strefę, projekt z tym samym id (raz na liście, nowy wątek na workerze A z UI B), brak
nieudostępnionej instancji u partnera, konflikty po edycjach offline rozstrzygnięte w obie strony
(także sekret z zapieczętowanej wersji), łączenie zmian bez konfliktu, trwałość pytania po restarcie
obu runtime'ów, wyłączenie i archiwizację, partnera bez capability oraz Unlink.
`schema.test.ts` obejmuje migrację 0050 (kaskada przy usunięciu partnera). Bez testów UI.

Odroczone po etapie 4: harmonogramy i sekrety wątków partnera (nadal per komputer), ustawienia
projektu (domyślne wątku w projekcie), kompozytor i układ sidebara, scalanie pól wewnątrz jednego
elementu (konflikt dotyczy całego elementu), dostępność CLI instancji na innym komputerze widoczna
z tego komputera (UI pokazuje stan własnych workerów).

## Konkretny protokół etapu 5

Implementacja: `computers/agents.ts`, `computers/bot-mirror.ts`, routing API i migracja
**0051_linked_agents**. Rzeczy wykonawcze nadal mają dokładnie jeden dom. Lustra botów i odwołania
szyny nie są drugim runtime'em, lokalnymi botami ani outboxem komend dla partnera.

### Zgodność i dozwolone wywołania

Capabilities **`remote_bots`** i **`agent_bus`** są negocjowane osobno. `COMPUTER_LINK_PROTOCOL`
pozostaje **1**: zmiany proto są addytywne, nowe usługi wewnętrzne używają istniejącego
`RemoteRequest`/`RemoteResponse` i są wywoływane wyłącznie przy capability obu stron.
Starszy partner zachowuje wcześniejsze funkcje; próba nowej operacji daje „needs an update”.

`remote_bots` rozszerza jawną listę `SERVED` o `ListBots`, `GetBot`, `WatchBotConversation`,
`SendBotMessage`, `AnswerBotApproval`, `UpdateBot`, `InterruptBot`, `RetryBot`, `MarkBotRead`,
`ArchiveBot`, `UnarchiveBot`, `DeleteBot`, `ReadBotExchange`, `SetBotRoutineEnabled`,
`DeleteBotRoutine`, `CancelBotReminder`, `GetBotProviderInstances` oraz wewnętrzny `WatchBotMirror`.
Nie udostępnia tworzenia bota na innym komputerze ani administracji connectorów, sekretów czy MCP.
`GetBotProviderInstances` wymaga odczytu bota i zwraca tylko id, nazwy, typy, kolory i wybory modeli
instancji jego domu, bez endpointów, env i kluczy. BFF: `GET /api/bots/:botId/providers`.

Id bota, zgody, rutyny, przypomnienia i wymiany używają sufiksu domu jak w etapie 2;
`Bot.node_id` ma numer **800**. `ListBots` sumuje własne boty i boty bezpośrednich partnerów.
Wywołanie partnera korzysta tylko z lokalnych handlerów domu, bez agregacji i routingu do trzeciej
maszyny. Odpowiedź normalizuje odwołania powrotne do własnych lokalnych id.

### Rozmowa i odczyt offline

Online rozmowa i karty idą na żywo do domu; edycja, rutyny, przypomnienia, granty connectorów,
wnioskowanie i ukryte notatki przekazania wykonują się wyłącznie tam. Nagłówek rozmowy pokazuje
`MachineBadge`, a panel szczegółów wyjaśnia „Runs on Laptop B. Routines and reminders stay there.”.
Ostrzeżenie o odczycie offline jest w przewijanej rozmowie pod nagłówkiem; żaden komunikat nie
poprzedza paska okna macOS. Zarządzanie autoryzacją kont kieruje na komputer domu. UI nie używa katalogu
connectorów A w rozmowie bota z B. Wzmianki w composerze obejmują boty tego samego domu;
bot może adresować inne komputery narzędziem `send_bot_message`.

`LinkedAgentsService.WatchBotMirror(MirrorRequest{cursor})` wykorzystuje transport, fragmentację,
anulowanie i model atomowej podmiany lustra etapu 3. Co sekundę dom czyta pełne `BotConversation`
wszystkich swoich botów (także archiwalnych). Kursor jest SHA-256 uporządkowanych snapshotów.
Równy kursor nie przesyła nic; zmiana przesyła **pełną podmianę**, nie przyrost dziennika.
`BotMirrorUpdate` otwiera partię, wysyła nagłówek każdej rozmowy oraz osobne wiadomości, karty,
rutyny i przypomnienia, zamyka rozmowę i zatwierdza partię. Zerwana partia nie zmienia lustra.
Blokada wiersza partnera serializuje commit z Unlink. Tabele `computer_mirror_bots` i
`computer_bot_mirror_state` mają kaskadę do partnera; restart zachowuje ostatnią pełną kopię.

Offline `ListBots`, `GetBot`, `WatchBotConversation` i podgląd wymian czytają lustro. UI pokazuje
powód z obecności i ostatni kontakt, wyszarza wiersz, blokuje composer, karty, ustawienia i akcje
rutyn/przypomnień. Po powrocie łącza odczyt wraca do domu. Żaden zapis nie trafia do lustra.

### Wywołania szyny i autoryzacja

Wewnętrzne `LinkedAgentsService.CallAgentBus(LinkedAgentCall)` jest dostępne wyłącznie po
przypiętym mTLS, dla aktywnego partnera z `agent_bus`. Niesie uuid wywołania, lokalne id i rodzaj
aktora (`thread`/`bot`), `hops`, operację i JSON argumentów. Nie jest publiczną metodą API.
Operacje: `spawn`, `send`, `get_thread`, `read_thread`, `answer`, `interrupt_thread`, `close_thread`,
`question`, `report`. Nie ma arbitralnego wywoływania handlerów ani routingu dalej.

`list_agents` pokazuje nazwy komputerów, status/błąd, projekty/workspace'y, workery, boty i modele.
Katalogi botów również oznaczają dom nazwą. Model przekazuje kwalifikowane id bez zmian:
`spawn_thread(workspace_id, project_id?, ...)` tworzy dziecko na B, `send_message(thread_id, ...)`
pisze do wątku, a `target_kind: "bot"` adresuje bota. Bot używa swoich `start_thread`,
`send_message`, `send_bot_message` i `answer_interaction`. Odczyty zachowują sufiksy id w wynikach.

Gateway A sprawdza właściciela wątku/worker, głębokość, `hops`, limit dzieci i sufit permissions
rodzica. Zdalne dzieci zarchiwizowane lub usunięte w domu zwalniają miejsce w limicie;
gdy ich dom jest niedostępny, slot pozostaje zajęty do ponownego odczytu. Zdalny fork jest
odrzucany: kontekst należy podać w prompcie. Gateway B sprawdza aktywnego
partnera pod blokadą, argumenty, własność i placement workspace'u, katalog modelu i stan workera;
tworzy wątek i trwałe komendy dopiero u siebie. Dziecko ma lokalny root fragmentu oraz jawne
`remote_parent_ref`/`remote_parent_kind`, zamiast fałszywego lokalnego rodzica; worker i reguły
narzędzi widzą głębokość 1, więc nie może tworzyć wnuków. `computer_agent_calls` trzyma kierunek,
aktora, cel, turę/steer, wynik i stan raportu; uuid wywołania deduplikuje przyjęcie po obu stronach.
Tury przez łącze mają `trigger=linked_agent`, `linked_call_id` i dodatnie `hops`; fallback steera
zachowuje to pochodzenie i aktualizuje obserwowaną turę.

Zdalne narzędzie bota zapisuje znacznik `bot_tool_calls.linked_remote` i stan `running` pod
kontrolą dzierżawy, a następnie zwalnia lokalne blokady przed wywołaniem partnera. Dzięki temu
dwa boty mogą równocześnie pisać do siebie. Wynik zapisuje dom źródłowy. Restart przy nieznanym
wyniku przerywa takie wywołanie, zamiast ponawiać zapis, tak samo jak zdalne MCP.

Partner ma pełny dostęp w opisanym modelu jednego użytkownika; nie przekazujemy poświadczeń
pracownika, dostawcy ani konta connectora. **Polityka narzędzi bota nadal działa na jego domu**:
`always`, operacje wrażliwe i podwyższenie permissions czekają na jego kartę, także dla zdalnego
spawn/odpowiedzi. Karta wskazuje komputer. Dopiero zatwierdzone narzędzie wysyła żądanie do B;
B stosuje własne walidacje i lokalne granty. Odpowiedź użytkownika z UI A na kartę bota B jest
trasowana na B i dopiero B wznawia model lub narzędzie. Sekrety nie wchodzą do tych żądań ani luster.

### Pytania, raporty i rozłączenie

Pytania dziecka (`InteractionRequest` oraz `ask_user`) z trasą `parent` trafiają do rodzica na A
z nazwą maszyny, kwalifikowanym `thread_id` i `request_id`. Odpowiedź jest walidowana i dostarczana
przez dom dziecka. Wątki mogą sterować tylko własnymi zdalnymi dziećmi; odpowiedź narzędzia bota
zachowuje wymaganie jego lokalnej zgody. Człowiek może zawsze odpowiedzieć w UI domu.

Zakończenie wskazanej tury wysyła raport do źródła; bot↔bot ma też `exchange_id` i czytelny podgląd
wymiany. Każdy przeskok zwiększa `hops`; operacja rezerwuje miejsce na raport w limicie 8.
Wynik pochodzący z rutyny wraca do ukrytego wykonania tej samej rutyny na domu bota, o ile nadal
jest włączona. Rutyna nie przenosi się na B.

Brak łącza lub capability to natychmiastowy, czytelny błąd narzędzia; przy zerwaniu otwarte
wywołania są anulowane. Nie ma outboxu wiadomości dla komputera offline. Pytanie/raport próbuje
przejść raz; niedostępność rodzica powoduje porzucenie powiadomienia (pytanie i wynik nadal są
do odczytu w domu dziecka). Raport ukończony przed obecnym połączeniem również jest porzucany,
żeby reconnect nie dostarczał zaległej pracy. Akcja już przyjęta przez dom pozostaje jego pracą;
utrata odpowiedzi nie cofa jej i nie stanowi podstawy do automatycznego powtórzenia zapisu.

Unlink atomowo usuwa lustra botów i oznacza odwołania szyny jako `detached`, raporty jako `dropped`,
a rodzica zdalnego dziecka jako odłączonego. Lokalne wątki, boty i rozmowy zostają; stare
odwołanie nie daje prawa routingu ani sterowania po ponownym parowaniu.

### Weryfikacja

`tests/integration/linked-agents.test.ts`: dwa prawdziwe gatewaye, osobne bazy, przypięte mTLS,
skryptowane workery oraz atrapy wywołań modeli botów. Obejmuje listę/stream/edycję bota z B na A,
odpowiedź na jego kartę, spawn wątku i spawn bota na workerze B (zgoda na A), pytania workera
i `ask_user` z odpowiedziami, raporty, thread→thread, thread→bot, bot↔bot i podgląd wymiany,
równoczesną rozmowę bot↔bot, ukryty powrót do rutyny, bezsekretowy katalog dostawców
i zwolnienie limitu dzieci po zamknięciu zdalnego wątku,
odmowę mieszania domów, podwyższenia permissions i forka, fallback steera, odczyt po restarcie
offline, natychmiastową odmowę bez późniejszego wykonania, porzucenie raportu offline, starszego
partnera i odłączenie relacji przy Unlink. Migracja 0051 jest w oczekiwanej liście schematu.
Brak testów UI; wygląd i blokady sprawdzamy ręcznie na własnych stosach.
