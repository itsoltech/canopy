# Połączone komputery

**Wyłącznie aplikacje Canopy Desktop w trybie lokalnym.** Łącze łączy dwa lub więcej
lokalnych gatewayów desktopu. Gateway serwerowy (Docker lub samodzielna binarka)
nie oferuje parowania komputerów, łącza, wykrywania LAN/mDNS, luster, wspólnej
konfiguracji, przenoszenia ani relay. Łączenie wielu gatewayów serwerowych nie jest wspierane.

Rolę gatewaya ustala sposób uruchomienia: domyślnie `server`, a kontroler desktopu
oznacza własny lokalny sidecar jako `desktop` wewnętrznym znacznikiem startowym.
Nie jest to ustawienie użytkownika. `GetClientCapabilities` zwraca `gateway_role`
i `linked_computers`; brak capability oznacza brak funkcji. Web i lokalny frontend
desktopu w trybie remote ukrywają wszystkie wejścia linkowania, gdy serwer jej nie oferuje.
RPC linkowania zwracają wtedy `FailedPrecondition` z komunikatem
„Linked computers are available only in the Canopy desktop app”. Network access
nadal obsługuje telefony, sparowane klienty desktopowe i workery, ale odrzuca łącza komputerów.

Istniejące na serwerze rekordy partnerów otrzymują przy starcie stan `inactive`.
Nie są usuwane: piny, trasy, lustra, konfiguracja i niedokończone przeniesienia zostają
w bazie, lecz nie są łączone, synchronizowane, udostępniane ani wznawiane przez usługi linków.
Lokalne dane domu pozostają dostępne. Start tej samej bazy przez lokalny desktop
ponownie uruchamia zwykły protokół linkowania; stan `inactive` nie odwołuje zaufania.
W dalszym opisie „gateway” oznacza lokalny gateway aplikacji desktopowej.

Status: **wszystkie etapy (1–8) zaimplementowane** (2026-11-03). Etap 1: tożsamość, parowanie, przypięty mTLS,
wersjonowanie, obecność i Settings → Linked computers. Etap 2: zsumowany overview i zdalne wątki
(lista, odczyt na żywo, pisanie, steer, kolejka, przerwanie, zgody i tworzenie wątku na workerze
partnera, trasowane do domu). Etap 3: trwałe lustra wątków do odczytu offline, kursor i pełna
resynchronizacja. Etap 4: wspólna konfiguracja (oznaczanie elementów, sekrety, konflikty, znaczki).
Etap 5: zdalne boty z odczytem offline oraz szyna agentów między domami (spawn, wiadomości,
pytania i raporty). Etap 6: trasy (źródło, ostatni sukces, opóźnienie) i wykrywanie już połączonych
komputerów w sieci lokalnej. Etap 7: jawne „Share onward”, jeden pośrednik, obecność pośrednia,
lustra i odwołanie dostępu. Etap 8: dwufazowe przeniesienie wątków i botów („Move to…”, „Move
everything here”) z przekierowaniami starych id. Cały stos PR-ów pozostaje draftem do scalenia naraz.

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
  - Szczegóły i decyzje: [konkretny protokół etapu 8](#konkretny-protokół-etapu-8).

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

Każdy etap z testami integracyjnymi gateway↔gateway (etapy 1–6: dwa gatewaye i bazy;
etapy 7–8: trzy niezależne gatewaye i bazy); bez testów UI.

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

Listener łącza jest częścią [dostępu sieciowego](network-access.md): jeden przełącznik w Settings →
Network access („Let phones and other computers connect”) otwiera port TLS na wszystkich interfejsach,
a połączenia z certyfikatem klienta trafiają do `ComputerLinkService`. Port jest wybierany raz i
zapisany w bazie (`network_access`), adresy są wykrywane i odświeżane, dodatkowe nazwy hostów dodaje się
w UI; serwer w kontenerze może ustalić port przez `CANOPY_NETWORK_PORT`. Dawne `CANOPY_LINK_HOST`,
`CANOPY_LINK_PORT`, `CANOPY_LINK_ADDRESSES`, desktopowe `computer-link.json` i wybór interfejsu
zniknęły. BFF, główny gRPC i Postgres pozostają na swoich portach loopback. Wyłączenie dostępu nie
odwołuje partnerów ani nie zamyka niezależnych połączeń wychodzących. Zmiana adresu komputera jest
ogłaszana partnerom łączem; przy zmianie wszystkich tras obu stron jednocześnie potrzebna jest trasa
ręczna albo wykrywanie LAN (etap 6).

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
lokalny gateway ogłasza graceful shutdown lub restart aktualizatora. Awaria/SIGKILL/wyłączenie
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
blokad przez dziennik. Test kolejności handshake wstrzymuje zapis statusu połączenia i równocześnie
wywołuje `ListThreads`: pierwszą odpowiedzią musi być `welcome`, zanim łącze udostępni zdalne
wywołania lub subskrypcje luster. Test bezpieczeństwa tworzy rzeczywiste metadane sekretu w domu
i sprawdza ich brak w zapisanej binarnej projekcji partnera.
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

## Konkretny protokół etapu 6

Implementacja: `apps/gateway/src/computers/routes.ts` (trasy), `lan.ts` (identyfikatory i mDNS),
`lan-transport.ts` (gniazdo multicast i wykrywanie środowiska), runtime łącza; migracja
**0052_computer_routes**; ramka `LinkFrame.routes` (9) i capability **`lan_routes`**; UI:
`RouteList`, `RouteRow`, `AddRouteDialog`, `LanDiscoveryRow` w `apps/web/src/lib/features/computers`.
`COMPUTER_LINK_PROTOCOL` zostaje 1: zmiany proto są addytywne. Nie ma przechodniości ani przenoszenia.

### Trasy

`computer_routes(owner, node_id, address, source, added_at, last_success, last_failure, latency_ms)`
zastępuje listę `computer_peers.addresses` z etapu 1 (migracja przenosi ją z zachowaniem kolejności jako
`announced`, a kolumnę usuwa). Klucz obcy z `ON DELETE CASCADE`: Unlink usuwa trasy razem z partnerem.
Źródła:

| Źródło | Skąd | UI |
|---|---|---|
| `manual` | adres wpisany przy parowaniu albo „Add route” | „Added by you” |
| `lan` | wykryty w podsieci i potwierdzony przypiętym handshake'iem | „Local network” |
| `announced` | `NodeHello.addresses` albo ramka `routes` partnera | „Announced” |

Ten sam adres ma jedno źródło; wpis ręczny zawsze staje się `manual`. Limity na źródło: 16 ręcznych,
16 ogłoszonych, 8 wykrytych (najmniej użyteczne odpadają). Łączenie próbuje tras w kolejności
**ostatniego sukcesu**; trasa, która zawiodła po swoim ostatnim sukcesie, idzie za działające, więc
martwa najlepsza trasa kosztuje jedną próbę. Sukces zapisuje czas i opóźnienie (czas przypiętego
handshake'u TLS), porażka — czas. Niezgodny pin na trasie `lan` usuwa ją (adres ma teraz inne
urządzenie); na trasie `manual` zachowuje znaczenie z etapu 1 („must be paired again”); na `announced`
to tylko porażka. Settings → Linked computers pokazuje trasy partnera w tej kolejności z „Worked 3 minutes
ago · 4 ms” / „Failed … · last worked …” / „Not tried yet”, pozwala dodać trasę ręczną (HTTPS origin)
i usunąć dowolną (`ManageComputer` akcje `add_route`/`remove_route`, pole `address` 5).

### Ogłaszanie adresów przez łącze

Komputer ogłasza adresy dostępu sieciowego: wykryte adresy swoich interfejsów (LAN, Tailscale, VPN,
publiczne) i dodane nazwy hostów ([network-access.md](network-access.md#adresy)).
Zmiana listy (nowe IP, listener wł./wył.) jest wysyłana od razu ramką `RouteAnnouncement {addresses}`
każdemu połączeniu z wynegocjowanym protokołem i capability `lan_routes`. Odbiorca waliduje je jak
`NodeHello` (najwyżej 16 originów HTTPS) i dopisuje jako `announced`. Ogłoszony adres nie daje
zaufania: używa się go wyłącznie przez przypięty mTLS.

### Klucz i identyfikatory

Każda para komputerów wylicza **klucz wykrywania** bez nowej wymiany i bez zapisu: statyczny ECDH
P-256 własnego klucza węzła z kluczem publicznym z przypiętego certyfikatu partnera, a potem
HKDF-SHA256 (sól: posortowane id obu węzłów, info `canopy computer link: lan discovery v1`). Klucz
nie trafia do bazy, logów ani łącza; ponowne parowanie z nowym kluczem daje nowy. Klucz węzła służy
też do podpisu TLS; separację zapewnia HKDF z osobną etykietą, a wynik jest wyłącznie kluczem HMAC
nieprzezroczystych nazw (nie szyfruje danych). Alternatywą był losowy sekret wymieniany łączem —
wymagałby przechowywania i synchronizacji, a nie działałby dla partnerów jeszcze niepołączonych
po aktualizacji.

Czas jest dzielony na okna 10 minut. Komputer X ogłasza się partnerowi Y w oknie `w` nazwami z
`HMAC-SHA256(klucz, "announce|<id X>|<w>")`: typ usługi `_<15 znaków>._tcp.local` (litera na początku,
base32, RFC 6335) i instancja `<26 znaków base32>.<typ>`, cel SRV `<instancja>.local`. Kierunek jest
częścią wejścia, więc X i Y mają różne nazwy. Każda strona liczy oczekiwane nazwy partnerów dla okien
`w-1`, `w`, `w+1` (tolerancja różnicy zegarów) i odpowiada na pytania o własne nazwy z tych okien.
Nazwy z innego okna, cudze nazwy i rekordy nieodpowiadające oczekiwanej instancji są ignorowane.

### Rekordy i prywatność

Rekordy: PTR (typ → instancja), SRV (port listenera łącza, cel `<instancja>.local`), pusty TXT, A
(adres interfejsu, przez który idzie odpowiedź). **Nie ma** nazwy aplikacji, hosta, id węzła, nazwy
komputera, wersji ani stałego typu usługi. Rozważony stały typ (np. `_canopy._tcp`) albo stały,
„ogólny” typ pozwalałby każdemu, kto zna kod, rozpoznać aplikację w sieci; ogólny typ istniejących
usług (np. `_http._tcp`) zaśmiecałby przeglądarki usług i tak samo byłby rozpoznawalny po wzorcu.
Typ i instancja zmieniają się co okno, więc obcy (kawiarnia) widzi losowo wyglądające usługi bez
możliwości śledzenia komputera między oknami. Ujawnia się tylko to, co widać i tak (adres IP/MAC),
liczba partnerów (jedno PTR na partnera) oraz to, że jakaś aplikacja używa losowych typów.

Ogłoszenie bez pytania idzie przy starcie, zmianie okna, partnerów lub sieci; pytania (PTR o
oczekiwane typy) co 60 s na każdym interfejsie LAN. Odpowiedź na to samo imię najwyżej raz na sekundę
(RFC 6762) i tylko na interfejsie w podsieci pytającego; komputer z listenerem tylko na loopbacku nie
ogłasza się (UI: „only looks for its linked computers”), ale szuka partnerów. IPv4 (224.0.0.251:5353,
`SO_REUSEADDR` obok systemowego respondera); IPv6 i adresy link-local są odroczone.

### Test połączenia i limity

Znaleziony adres musi być w podsieci któregoś z interfejsów tego komputera; inaczej jest ignorowany
(nie ma ścieżki do dowolnego hosta w internecie). Kandydat to tylko droga: gateway wykonuje **zwykły
przypięty handshake mTLS** (`discoverCertificate` z pinem partnera, TLS 1.3, certyfikat klienta) i
zapisuje trasę `lan` z czasem i opóźnieniem dopiero po zgodności pełnego odcisku certyfikatu. Nic nie
jest automatycznie zaufane; powtórzone (podsłuchane) ogłoszenie wskazujące inny adres kończy się
nieudanym handshake'iem i niczego nie zapisuje. Limity: jeden test na adres i 60 s, najwyżej 20 testów
na minutę, a trasa z sukcesem w ostatnich 10 minutach nie jest testowana ponownie. Po nowej trasie
niepołączony partner jest wybierany od razu (bez czekania na backoff). Logi nie zawierają kluczy ani
nazw.

### Ustawienie i środowisko

`computer_identity.lan_discovery` (domyślnie włączone) — przełącznik „Find linked computers on this
network” w Settings → Linked computers (`ManageComputer` `lan_discovery`). Wyłączenie zamyka gniazdo:
brak ogłoszeń, pytań i odpowiedzi, lokalne adresy LAN znikają z ogłaszanych, a trasy `lan` są usuwane.
`ComputersSnapshot` ma `lan_discovery_enabled`, `lan_discovery_state` (`active`, `off`, `unavailable`)
i `lan_discovery_note`. „Unavailable”: zajęte/niedostępne gniazdo UDP 5353 lub diagnostyczne
wyłączenie wykrywania runtime desktopu. Gateway serwerowy nigdy nie uruchamia wykrywania.
Interfejsy wirtualne
(loopback, Tailscale, WireGuard, utun, mostki Dockera/VM) nie biorą udziału w wykrywaniu. Desktop na
macOS deklaruje `NSLocalNetworkUsageDescription` ([desktop.md](desktop.md)).

### Weryfikacja

`tests/integration/lan-routes.test.ts`: dwa prawdziwe gatewaye z osobnymi bazami PostgreSQL i
przypiętym mTLS; transport multicast zastąpiony siecią w pamięci na granicy (prawdziwe kodowanie mDNS,
adresy loopback jako „LAN”). Obejmuje trasy po parowaniu (ręczna z sukcesem, ogłoszone), wykrycie
partnera bez znanego adresu i zapis trasy `lan` z opóźnieniem po przypiętym handshake'u oraz
połączenie przez nią, brak nazwy aplikacji/hosta/id w pakietach i rotację nazw między oknami
i kierunkami, akceptację okna sąsiedniego, ignorowanie okien ±2, obcych identyfikatorów i adresów
spoza podsieci, limit jednej próby dla serii powtórzonych ogłoszeń oraz brak zapisu fałszywego
punktu końcowego, ogłoszenie nowego adresu przez łącze, kolejność i przejęcie przez następną trasę
po śmierci najlepszej, ręczne dodanie/usunięcie, wyłączone wykrywanie (cisza, usunięte trasy `lan`,
trwałe ustawienie) i Unlink. `linked-computers.test.ts` sprawdza dalej fałszywą trasę z niezgodnym
pinem. `schema.test.ts` obejmuje 0052. Ręcznie: dwa gatewaye w osobnych procesach na tym samym
hoście Linux znalazły się przez prawdziwy multicast na interfejsie LAN (trasa `lan`, 6 ms), UI
obejrzane w jasnym i ciemnym motywie, na desktopie i telefonie. Wymaga jeszcze sprawdzenia na dwóch
fizycznych maszynach w jednej sieci, na macOS (pytanie o sieć lokalną, współistnienie z
mDNSResponder) i Windows.

## Konkretny protokół etapu 7

Implementacja: `computers/relay.ts`, runtime łącza, transport `remote.ts`, routing istniejących
handlerów i szyny agentów; migracja **0053_computer_relay**. Gatewaye W, P1 i P2 zachowują osobne
bazy, klucze i runtime'y. Żaden wątek ani bot nie zmienia domu. Protokół pozostaje **1**, nowe
pola są addytywne, a wszystkie trzy komputery muszą ogłaszać capability **`relay`**.

### Kierunkowe zgody i katalog

Na P1 operacja `ManageComputer {action: "share_onward", node_id: W,
share_onward_node_ids: [P2]}` zastępuje cały wybór innych bezpośrednich partnerów udostępnianych W.
Domyślnie zbiór jest pusty. Tabela `computer_relay_grants(owner, recipient, home)` jest kierunkowa;
W→P2 nie daje P2 dostępu do rzeczy W. Wybrać można tylko innych bezpośrednich partnerów P1,
z `relay`; siebie, odbiorcę, wpis pośredni i nieznany węzeł odrzucamy. Maksymalnie 32 zgody
na gateway. Wyłączenie zgody pozostaje możliwe także po downgrade partnera.

P1 wysyła pełny `RelayCatalog {revision, computers}` osobno każdemu bezpośredniemu partnerowi.
W otrzymuje P2 z rolą `home`; P2 otrzymuje W z rolą `origin` (przejrzystość: **W via P1**,
tylko do odczytu). Przy dwóch jawnych przeciwnych zgodach rola `both` zachowuje oba uprawnienia.
Katalog zawiera prawdziwe id/nazwę, wersję, stan z czasem, last seen i capabilities etapów 2–5.
Nie zawiera tras, certyfikatów, konfiguracji, kluczy ani możliwości dalszego pośrednictwa.
`revision` jest trwałym licznikiem P1. Odbiorca atomowo zastępuje wpisy pośrednika tylko nowszym
katalogiem; stara ramka z drugiego równoczesnego połączenia nie odtwarza odwołanej zgody.

Wpisy pośrednie w `computer_peers` mają `via_node_id`, `relay_role` oraz **pusty certyfikat i pin**
(wymuszone CHECK). `ComputerStore.peer/peers` zwracają wyłącznie bezpośrednich partnerów:
listener mTLS, parowanie, LAN, trasy i konfiguracja nigdy nie uznają katalogu za nowe zaufanie.
Kaskada po `via_node_id` usuwa wpisy i ich lustra przy Unlink pośrednika. Bezpośredni pin wygrywa
z wpisem pośrednim; przy kilku ofertach domu wybierany jest leksykograficznie pierwszy pośrednik
z dostępem do domu. Wpis informacyjny nie zastępuje dostępu do domu przez innego pośrednika.
Po usunięciu wybranego inna aktualna oferta może zostać przyjęta w następnym katalogu.

### Koperta, id i limit jednego pośrednika

Id rzeczy pozostaje **`<uuid>~<node16 rzeczywistego domu>`**: wątek P2 na W nie otrzymuje id P1
ani drugiego sufiksu. To rozszerzenie trasowania dotychczasowego schematu, bez zmiany jego składni.
`resolve` rozpoznaje jednoznaczny dom, a katalog wybiera P1. UI i telefon nadal odsyłają id bez
zmian. `node_id` wątku, workera, projektu i bota jest pełnym id P2. Gateway kwalifikuje odpowiedź
dopiero na W; P1 przekazuje binarny protobuf bez przepisywania id. Mieszanie domów nadal odrzucamy.

`RemoteRequest` ma nowe pola `target_node_id`, `origin_node_id`, `relay_hops`:

1. W→P1: target=P2, origin pusty, hops=0. P1 sprawdza aktywny pin W, kierunkową zgodę W→P2,
   bezpośredni pin P2, capabilities metody wszystkich uczestników i gotowe łącza.
2. P1→P2: target=P2, origin=W, hops=1. P2 przyjmuje origin tylko od przypiętego P1,
   po świeżym katalogu, który wykazał prawo W do dostępu przez P1. Handler działa lokalnie,
   w zakresie właściciela P2, z oryginalnym W jako `peerNodeId` (także dla szyny agentów).
3. Koperta hops=1 może wykonać się wyłącznie na swoim celu. Inny cel, hops>1, podrobiony origin
   na pierwszej nodze, cel równy nadawcy/pośrednikowi albo pośredni cel są odrzucane.

Metoda i cała koperta muszą być identyczne we wszystkich fragmentach jednego wywołania.
`RELAY_METHODS` to jawna lista etapów 2–5 bez `PushSharedConfig`; administracja, poświadczenia,
sekrety wątków, zarządzanie komputerami, discovery i dowolne RPC nie mają ścieżki relay.
Każda noga zachowuje limity, błędy i anulowanie etapu 2. Przerwanie wywołania na W odwołuje je
na P1 i P2. Odwołanie zgody przerywa również już otwarte subskrypcje i oczekujące odpowiedzi.

### Szyna, lustra i obecność

Spawn i wiadomości na P2 zapisują W jako źródło, z rodzicem `uuid~W16`; P1 nie tworzy aktora
ani własnego wątku. Dziecko i polityka bota pozostają w domu. P2 może zwrócić przez tę samą zgodę
**wyłącznie** `CallAgentBus` z operacją `question`/`report`; W weryfikuje istniejący call id,
aktora i cel regułami etapu 5. Wpis `origin` nie bierze udziału w agregacji rzeczy ani
rozwiązywaniu id dla zwykłych akcji. Limit 8 przeskoków agentów i limit jednego pośrednika
to odrębne ograniczenia. P2 nie może przez informacyjny wpis W listować ani sterować jego rzeczami.

Subskrypcje `WatchThreadMirror` i `WatchBotMirror` przechodzą do P2 przez P1. W zapisuje je pod
prawdziwym `origin_node_id=P2`, z dotychczasowymi kursorami i atomowym zatwierdzaniem generacji.
P1 nie odsyła W swoich kopii P2. Odczyt online korzysta z domu; offline z ostatniej generacji na W.
Obecność P2 to stan P2 widziany przez P1 **oraz** osiągalność P1 z W. Po utracie P1 UI i API
wyjaśniają „Available through P1, which is unreachable since …” w strefie właściciela. Na czas
reconnect pokazują powód ponownego łączenia. Po restarcie nie ma dostępu przez stary katalog,
dopóki nowe przypięte połączenie z P1 nie dostarczy aktualnego katalogu. Historia pozostaje czytelna.
Brak połączenia to natychmiastowa odmowa zapisów; nie powstaje kolejka na później.

### Odwołanie i zakres konfiguracji

Wyłączenie „Share onward” najpierw zatwierdza usunięcie zgody i anuluje wywołania na P1,
następnie wysyła nowsze katalogi. Online W usuwa P2, kursor, wszystkie generacje luster wątków
i botów oraz listingi; P2 usuwa informacyjny W i odłącza odwołania szyny. Jeśli pozostaje
przeciwna zgoda, wpis zostaje z węższą rolą, ale odebrane lustra i odwołania są usuwane.
Unlink P1↔P2 usuwa także zgody i aktualizuje katalog W. Lokalne dane P2 zostają nietknięte.
Już przyjętej przez dom akcji nie cofamy; nie ponawiamy automatycznie zapisu po utracie odpowiedzi.
Offline W poznaje odwołanie przy następnym połączeniu, przed odnowieniem dostępu do domu;
nie można natychmiast skasować bajtów na nieosiągalnym komputerze.

**Konfiguracja etapu 4 nie jest przesyłana przez relay.** `shared_config` nie występuje w katalogu,
`PushSharedConfig` jest odrzucany w obu nogach, a jego pętla korzysta tylko z bezpośrednich pinów.
Samo „Share onward” nie włącza udostępniania żadnego elementu konfiguracji ani sekretu P2 do W.
Pozostaje niezależna, dotychczasowa semantyka etapu 4: element przyjęty i oznaczony jako wspólny
na P1 może być wysłany przez P1 jego **bezpośrednim** partnerom. „Share onward” nie rozszerza,
nie odwołuje ani nie zastępuje tego osobnego opt-in. Wspólne projekty zachowują istniejące reguły id.

UI: `ShareOnwardDialog` i `ShareOnwardChoice` (osobny przebieg `componentize`) używają istniejących
`Dialog`, `SettingsRow` i `Switch`. Wpisy pośrednie pokazują **via P1**, bez tras, fingerprintu,
Rename, Unlink ani dalszego udostępniania. Wpis informacyjny opisuje kierunek dostępu. Znaczek
maszyny przy rzeczy również podaje pośrednika; banner blokady korzysta z tego samego powodu co API.

### Weryfikacja i odroczenia

`tests/integration/computer-relay.test.ts`: trzy prawdziwe gatewaye, osobne bazy PostgreSQL,
przypięte mTLS, skryptowane workery i model bota. Brak dostępu domyślnie (także surowym żądaniem),
listing via P1 i przejrzystość na P2, wzajemne jawne zgody bez pętli, odczyt/zapis/steer/zgoda,
załącznik, bot i spawn z raportem do prawdziwego źródła, granice callbacków, odmowa konfiguracji,
origin spoofing, limity hop i pętle, odwołanie trwającego wywołania i purge obu luster oraz listingu
żywego strumienia overview (spóźniona odpowiedź nie odtwarza usuniętego komputera), stary
katalog, P1 offline i restart W/P1 z czytelnym powodem i bez kolejki, capability fallback oraz Unlink.
`schema.test.ts`: migracja 0053, izolacja ownera, brak certyfikatu wpisu pośredniego i kaskady.
Ręcznie na trzech gatewayach z osobnymi bazami i BFF: picker „Share onward” w jasnym i ciemnym
motywie, desktop 1440×1000 i telefon 390×844, bez poziomego przewijania. W widzi P2 via P1,
P2 pokazuje W via P1 jako wpis tylko do odczytu; wyłączenie przełącznika na P1 usuwa P2 i jego
wątek z W. Zastosowano `design` oraz osobny przebieg `componentize`. Fixture przeglądarkowy nie
uruchamiał konfiguracji etapu 4 (jego endpoint zwracał 409); obejmował widoki i przełączniki relay.
Zrzuty są poza repozytorium w katalogu tymczasowym przekazanym w raporcie.
Bez testów UI. Bezpośrednie W↔P2 po „przedstawieniu” przez P1, discovery relayed computers
i przechodnia konfiguracja przez relay są odroczone. Przenoszenie rzeczy opisuje etap 8.

## Konkretny protokół etapu 8

Implementacja: `computers/moves.ts` (koordynacja, odzyskiwanie, podgląd), `computers/move-state.ts`
(transakcje zamrożenia, eksportu, decyzji i importu), `computers/redirects.ts` (przekierowania),
`api/routed.ts` (trasowanie starych id i odmowa zapisów w trakcie), szyna agentów (`agents.ts`);
migracja **0054_computer_moves**; wewnętrzna usługa `ComputerMoveService` (`PrepareMove`,
`DecideMove`, `MoveOutcome`, `InspectMove`), ramka `LinkFrame.moved` (11), pole
`RemoteResponse.moved` (7) i capability **`move_items`**. `COMPUTER_LINK_PROTOCOL` zostaje 1 (zmiany
addytywne). UI: `PreviewMove`/`StartMove`/`GetMoves` w `canopy.ui.v1` (tylko token serwisowy BFF,
nie telefony), BFF `/api/computers/moves`, komponenty `MoveDialog`, `MovePreview`, `MoveProgress`
i pochodne w `apps/web/src/lib/features/computers`.

### Zakres i decyzje

- **Tylko bezpośrednio połączone komputery.** Ruch przenoszenia nie przechodzi przez relay
  (`ComputerMoveService` nie jest w `RELAY_METHODS`, wpisy pośrednie nie są celem). Przenieść można
  tylko rzecz, której domem jest ten komputer; UI otwiera „Move to…” na komputerze domu (dla rzeczy
  partnera: „Open it on its own computer to move it”). Koordynuje zawsze **źródło** (obecny dom).
- **Wątek** przenosi się z całą lokalną rodziną: wątek główny i jego wątki poboczne (`side`); wątku
  pobocznego nie przenosi się osobno. Tylko wątki na workerze (`runtime = worker`).
- **Trwająca praca: odmowa, nie czekanie.** Przeniesienie jest odrzucane, gdy w rodzinie jest tura
  `queued`/`running`, pytanie lub zgoda czekająca na odpowiedź, niedostarczony steer, zadanie w tle,
  niezakończona praca szyny agentów lub raport, na który czeka inny komputer. Komunikat mówi, co
  zrobić („Wait for it to finish or stop it, then move”). Bot: tura w toku, karta czekająca na odpowiedź
  lub obserwowany wątek. Czekanie w kolejce byłoby ukrytą kolejką pracy, której projekt unika.
- **Ta sama tożsamość.** Rzecz zachowuje swój uuid. Stary id (`<uuid>` na dawnym domu,
  `<uuid>~<stary dom>` gdzie indziej) rozwiązuje się przez zamianę domu.
- **Powrót na komputer, który ma jeszcze starą kopię, nie jest obsługiwany** (cel odpowiada
  „It is already on this computer”). Wymiana laptopa jest ruchem w jedną stronę.

### Dwie fazy

Oba komputery prowadzą trwały rekord `computer_moves` (rola `source`/`target`, stan, błąd, rzeczy
do ponownego zrobienia). Jeden niezakończony ruch na rzecz (indeks częściowy).

1. **Zamrożenie (źródło, jedna transakcja).** `SELECT … FOR UPDATE` rodziny wątku lub bota, sprawdzenie
   blokad, `moved_to = <cel>`, wstrzymanie aktywnych harmonogramów wątku (z zapisaniem ich stanu
   i najbliższego terminu w `frozen`) i rekord `preparing`. Od tej chwili nic nowego nie startuje:
   triggery `BEFORE INSERT` na `turns`, `turn_steers` i `bot_turns` odrzucają nową turę zamrożonej
   rzeczy (blokada `KEY SHARE` czeka na trwające zamrożenie), planista rutyn, przypomnień i obserwacji
   bota pomija boty z `moved_to`, a API odpowiada na zapis „Moving to Laptop C. Try again in a moment.”
   Odczyty działają dalej.
2. **Przygotowanie (cel).** Źródło eksportuje pełny stan i wysyła `PrepareMove`. Cel sprawdza workspace,
   instancje dostawców, brak tej rzeczy u siebie i zapisuje ładunek w rekordzie `prepared` — nic jeszcze
   nie jest widoczne ani wykonywane. Powtórzony `PrepareMove` z tym samym id odpowiada z rekordu.
3. **Decyzja (źródło, jedna transakcja) — punkt przełączenia.** Kopia źródła dostaje `deleted_at`
   (zostaje w bazie jako kopia zapasowa, `moved_to` zabrania przywrócenia), harmonogramy są anulowane,
   relacje szyny między komputerami odłączone (jak przy Unlink), zapisany redirect i stan `committed`.
   Od tego momentu domem jest cel.
4. **Zastosowanie (cel).** `DecideMove(commit)` zapisuje decyzję (`committed`), cel odpowiada i stosuje
   ładunek: bot w jednej transakcji; wątek przez rdzeń (to samo id) i idempotentne kroki. Na końcu
   redirect do siebie i stan `done`. Źródło po potwierdzeniu decyzji przechodzi do `done`.

**Odporność na przerwanie.** Przed decyzją każda porażka (brak łącza, odmowa, przekroczony czas,
restart) cofa: źródło odmraża rzecz (przywraca harmonogramy) i zostaje w `aborting`, dopóki cel nie
potwierdzi `DecideMove(abort)`; restart źródła w `preparing` zawsze cofa. Po decyzji ruch tylko idzie
do przodu: źródło ponawia `DecideMove(commit)` co heartbeat i po każdym handshake, aż cel potwierdzi.
Cel z rekordem `prepared` pyta źródło (`MoveOutcome`) — `commit`, `abort` albo `preparing` (czekaj);
nieznany ruch oznacza `abort`. Cel z rekordem `committed` (np. po restarcie w trakcie stosowania)
stosuje go ponownie; każdy krok jest idempotentny (wątek o tym id już istnieje → tylko brakujące kroki).
Dlatego nigdy nie ma dwóch domów: przed decyzją cel nic nie pokazuje ani nie wykonuje, po decyzji
źródło jest przekierowaniem. Między decyzją a zastosowaniem dom jest przesądzony (cel), a cel kończy
zastosowanie przy pierwszej okazji.

**Unlink w trakcie.** Nierozstrzygnięty ruch jest cofany. Decyzja, której cel nie potwierdził, zostaje
cofnięta na źródle (rzecz wraca, redirect znika); cel odrzuca nierozstrzygnięty ładunek, a już
rozstrzygnięty stosuje. W rzadkim przypadku, gdy cel zastosował ruch, ale potwierdzenie zginęło,
oba komputery mają kopię — po Unlink nic już ich nie łączy.

### Co przechodzi

- **Wątek:** ostatni snapshot osi czasu każdego wątku rodziny (itemy, tury, komunikaty, steery,
  dostarczenia szyny; bez sekretów, harmonogramów i oczekujących interakcji), wiersz z ustawieniami
  (dostawca, instancja, model, effort, uprawnienia, instrukcje, tytuł, data utworzenia, archiwizacja),
  aktywne/wstrzymane harmonogramy wątku, załączniki z bajtami i miniaturami oraz bloby transkryptu.
  Limit 40 MiB plików na ruch (pod limitem wiadomości łącza 48 MiB); większy wątek jest odrzucany
  z komunikatem. Cel zapisuje historię w `computer_moved_threads`; snapshot UI (i lustra innych
  komputerów) pokazuje ją przed nowymi turami. Id rzeczy dawnego domu w historii dostają jego sufiks
  (prowadzą tam albo dalej przez redirect), id przeniesionych wątków, ich tur i plików są lokalne.
  Anulowana tura-zastępczy rezerwuje numery historii, więc nowe tury idą dalej; `last_seq` kontynuuje
  numerację, a komunikat osi czasu „Moved from Laptop A to Laptop C” oznacza miejsce przeniesienia.
- **Kontynuacja:** sesja CLI i pliki zostają na starej maszynie. Cel tworzy wątek w wybranym przez
  użytkownika workspace (domyślnie workspace tego samego, wspólnego projektu), a nowa sesja workera
  dostaje w instrukcjach **notatkę przekazania**: skąd i dokąd, stara i nowa ścieżka, pierwotne zadanie
  i wyciąg z ostatnich 30 wiadomości (oznaczony jako niepełny, do 16 000 znaków). Notatka jest
  deterministyczna (bez wywołania modelu), jak fallback handoffu botów. Model, którego nie ma na celu,
  zastępuje domyślny model instancji.
- **Bot:** wiersze bota, tur, wiadomości (z nowymi numerami `seq` w tej samej kolejności i przesuniętym
  znacznikiem przeczytania), wywołań narzędzi, kart, notatek handoff, rutyn i przypomnień.
- **Nie przechodzi (lista „To do again” w podglądzie):** konta connectorów i serwery MCP (są per komputer;
  bot na celu pokazuje „Moved from Laptop A — connect these again: …”, dopóki ich nie podłączysz),
  sekrety wątku (wpisuje się je ponownie, gdy agent poprosi), otwarty cel (`/goal` ustawia się ponownie),
  powiązanie z rodzicem na innym komputerze.
- **Sekrety:** ruch nie przenosi żadnej wartości sekretu. Klucze instancji dostawców przechodzą tylko
  przez wspólną konfigurację etapu 4 (ponownie szyfrowane kluczem odbiorcy). Instancja dostawcy
  wymagana przez wątek lub bota musi istnieć na celu („Share its provider instance … first”).

### Harmonogramy i rutyny przy przełączeniu

Rutyna lub przypomnienie wykonuje się dokładnie w jednym domu: przed zamrożeniem źródło je uruchamia
(zapisując `next_run_at`/`delivered`), od zamrożenia nie uruchamia nic (zapytania planisty pomijają
`moved_to`, trigger odrzuca turę), a eksport zabiera stan z chwili zamrożenia. Termin, który minął w
trakcie ruchu, wykonuje cel raz po zastosowaniu (jak po przestoju). Harmonogramy wątku: zamrożenie
wstrzymuje je, eksport zabiera pierwotny status i termin, decyzja anuluje je na źródle, cel tworzy je
u siebie (polityka zaległych uruchomień jak zwykle); cofnięcie przywraca pierwotny stan.

### Przekierowania

`computer_redirects(owner, item_id, kind, home_node_id, home_name, from_node_id, moved_at)` mówi, gdzie
rzecz jest teraz (także „tutaj” po stronie celu). Wypełniają ją obie strony ruchu, ramka `moved` (po
decyzji i zastosowaniu do wszystkich bezpośrednich partnerów z `move_items`, a po każdym handshake
najnowsze 2000 wpisów) oraz leniwe odpowiedzi: dom, który rzecz oddał, odpowiada na wywołanie partnera
błędem z `RemoteResponse.moved`, który przechodzi także przez pośrednika etapu 7. Odbiorca przyjmuje
wpis tylko od starego albo nowego domu i nigdy nie „przenosi” rzeczy, która żyje u niego.

- **UI i telefon:** `routed.ts` przepisuje stare id w żądaniu przed trasowaniem; odpowiedź „moved”
  zapisuje redirect i ponawia raz u nowego domu. Wątek otwarty starym linkiem przełącza się na nowe id
  z komunikatem „Moved to Laptop C”. Dom niepołączony z tym komputerem: „Moved to Laptop C, which isn't
  linked to this computer”.
- **Lustra:** dawny dom publikuje tombstone (wątek usunięty), nowy dom — wątek z pełną historią, więc
  trzeci komputer pokazuje go raz, z nowym właścicielem.
- **Szyna agentów:** argumenty `thread_id`/`bot_id`/`thread_ids` narzędzi wątków i botów są przepisywane;
  wywołanie, na które dawny dom odpowie „moved”, jest ponawiane u nowego domu, a odwołania
  `computer_agent_calls` dostają nowego partnera. Kontrola rodzic–dziecko między komputerami kończy się
  przy przeniesieniu (jak przy Unlink); wiadomości i odczyty działają dalej.

### Bezpieczeństwo, audyt, UI

Wyłącznie właściciel: zapytania są ograniczone do jego `owner_user_id` (cudzy bot: „Bot not found”),
metody UI wymagają tokenu serwisowego BFF, a strona łącza przyjmuje ruch tylko od przypiętego,
bezpośredniego partnera; decyzję o ruchu może podjąć wyłącznie komputer, który go przygotował. Obie
strony zapisują `audit_log` (`computer.move.<kind>.sent` / `.received` / `.restored`).

UI: „Move to…” w menu wątku (sidebar i nagłówek, tylko własne wątki główne) i bota (lista i rozmowa),
„Move everything here” przy partnerze w Settings → Linked computers. Okno: wybór komputera (opcje bez
`move_items` lub niedostępne są wyłączone z powodem), workspace na celu dla każdego projektu, podgląd
(co przechodzi, co zrobić ponownie, dlaczego coś nie może przejść; przy „everything” także elementy
wspólne i lokalne), postęp i wynik („Open on Laptop C”). Ruchy działają w tle; zamknięcie okna ich nie
przerywa. Kontrolki wyłącznie z zestawu (`Dialog`, `Field`, `Select`, `Badge`, `Alert`, `Button`).

### Weryfikacja

`tests/integration/computer-moves.test.ts`: trzy prawdziwe gatewaye (A — stary laptop, C — nowy, B —
trzeci komputer z lustrami obu), osobne bazy PostgreSQL, przypięte mTLS, skryptowane workery i model
botów. Obejmuje: przeniesienie wątku z historią, załącznikiem i harmonogramem (redirect na A, zapis
przez stary id trafia do C, lustro i lista B pokazują nowego właściciela, kontynuację na workerze C w
nowym katalogu z notatką przekazania i numeracją tur po historii, audyt po obu stronach), wiadomość
szyny agentów z B na stary id (także leniwie, bez wcześniejszego redirectu); przeniesienie bota
z rozmową, rutyną i przypomnieniem zaległymi w trakcie (dokładnie jedno wykonanie, na C; A nic nie
uruchamia ani w trakcie, ani po), flagę ponownego podłączenia konta, stare id bota z A i B oraz
wiadomość szyny do bota; odmowę przy trwającej turze; przerwania przed decyzją (zniknięcie celu po
zamrożeniu, restart źródła po przygotowaniu, restart celu w trakcie przygotowania) i po niej (restart
źródła po decyzji, restart celu przed zastosowaniem przy zerwanym łączu) — zawsze dokładnie jeden dom;
idempotentne powtórzenia `PrepareMove`/`DecideMove`; odmowę cudzej rzeczy, nieznanego komputera
i rzeczy innego komputera; „Move everything” z listą elementów lokalnych. `schema.test.ts` obejmuje 0054
(triggery, jeden aktywny ruch, reguły ról). Bez testów UI; widoki obejrzane ręcznie na własnym stosie
(jasny i ciemny motyw, desktop i telefon).

Odroczone: przenoszenie przez pośrednika, przeniesienie z powrotem na komputer ze starą kopią,
przenoszenie samych sekretów wątku, wątki bez workera, przeniesienie zainicjowane z UI innego
komputera niż dom, strumieniowanie ładunku ponad 40 MiB plików i fork z tury sprzed przeniesienia.
