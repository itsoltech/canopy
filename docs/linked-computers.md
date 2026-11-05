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
Opt-in etapu 4 zastępuje [wspólna konfiguracja](#konkretny-protokół-wspólna-konfiguracja)
(stos `feat/linked-shared-config-N`, w realizacji).

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
| Konto connectora | wspólna konfiguracja konta | poświadczenia replikowane i szyfrowane kluczem każdego komputera; dostęp workerów per worker |
| Projekt | rekord na każdym komputerze; wspólna tożsamość git origin w pickerach, docelowo globalne id konfiguracji | workspace'y zachowują projekt i komputer domu; aliasy konfiguracji opisano niżej |

Tworzenie wątku na workerze komputera B z UI komputera A jest wywołaniem do B; B zostaje właścicielem.
Szyna agentów przekracza granicę tak samo: `spawn_thread` na workerze B tworzy wątek na B z rodzicem
na A, a raporty i pytania wracają przez łącze.

### Tożsamość projektu według git origin

Picker nowego wątku scala projekty z różnych komputerów po znormalizowanym `remote.origin.url`
ich workspace'ów. Formy HTTPS, SSH i `git@host:owner/repo.git` wskazują tę samą tożsamość:
host ma małe litery, końcowy ukośnik i `.git` znikają. Ścieżka zachowuje wielkość liter;
niestandardowy port odróżnia repozytoria. Poświadczenia URL nie wchodzą do tożsamości.
Lokalne ścieżki, `file:`, URL z query/fragmentem i brak origin nie stanowią wspólnej tożsamości.

Scalenie wymaga jednego znanego origin we wszystkich workspace'ach każdego projektu.
Różne origin, brak metadanych choćby jednego workspace'u lub różne projekty z tym samym origin
na jednym gatewayu pozostają osobnymi wyborami. W ostatnim przypadku cała grupa tego origin
pozostaje rozdzielona: nie zgadujemy, do którego lokalnego projektu należy dołączyć partnera.
Istniejące jawne współdzielenie tego samego globalnego id działa jak dotychczas.

To scalenie **widoku**, bez zmiany id, ustawień, właściciela ani danych projektu w bazie.
Nazwa lokalnego projektu ma pierwszeństwo; bez lokalnego rekordu wybór jest deterministyczny po id.
Inne nazwy są aliasami widocznymi w szczegółach wiersza i przeszukiwanymi w pickerze.
Filtr i grupy projektów w sidebarze oraz paleta poleceń korzystają z tej samej tożsamości.
Ekrany ustawień, listy wątków pojedynczego projektu, harmonogramy i przenoszenie pozostają przy
oryginalnych rekordach. Tożsamość origin nie zmienia kontraktu etapów 4 ani 8.

Worker z capability **`workspace_origin`** obsługuje nietrwałe `Command.read_workspace_origin` (**216**)
i `CommandResult.workspace_origin` (**216**). Odczytuje lokalne `remote.origin.url` katalogu workspace'u
przez process governor: bez shella, fetch i promptów, z limitem 2 s oraz cache 30 s.
Zwraca wyłącznie znormalizowaną tożsamość, nigdy surowy URL z credentialami.
Gateway pyta wyłącznie o workspace'y właściciela, cache'uje odpowiedź 30 s i zachowuje ją
w `project_workspaces.git_origin` (migracja **0072_workspace_origin**).
Zmiana ścieżki czyści poprzednią tożsamość; błąd odczytu zachowuje ostatnią znaną.
Odczyt overview oraz aktualizacje projektów i workerów odświeżają metadane po wygaśnięciu cache.
`Workspace.git_origin` (**216**) przechodzi przez istniejący overview, aktualizacje i lustra offline.
Starszy worker nie dostaje nowej komendy. Obie wersje protokołu (`WORKER_LINK_PROTOCOL`
i `COMPUTER_LINK_PROTOCOL`) pozostają 1: pola są addytywne, a komenda jest negocjowana capability.

Testy: `packages/domain/src/projects.test.ts` (normalizacja i reguły scalania) oraz
`tests/integration/linked-projects.test.ts` (dwa gatewaye, rzeczywiste odczyty git przez WorkerHost,
tworzenie na domu wybranego workera, owner scoping, zmiana ścieżki, offline i odmowa bez kolejki
po utracie domu). Nie ma testów UI.

### Dodawanie projektu na dowolnym komputerze

Z komputera A można dodać projekt na workerze komputera B. Dialog „Add project” (polecenie palety
i przycisk w Settings → Projects) prowadzi przez worker (wszystkie komputery, ten komputer pierwszy,
offline wyłączone z powodem), źródło i katalog. Źródła: **New project** (nowy katalog z `git init`),
**Existing directory**, **Git URL** i **GitHub repository** (`owner/repo` →
`https://github.com/owner/repo.git`). Przeglądarka katalogów ma pole ścieżki (`~/GIT/pin`): część do
ostatniego separatora to katalog, reszta filtruje wpisy; `/` wchodzi głębiej, `..` cofa, strzałki
wybierają, Enter otwiera wybrany wpis, a bez wybranego wpisu (oraz zawsze z Mod+Enter) wykonuje akcję.
Klon i nowy projekt wybierają w tej samej przeglądarce katalog nadrzędny, a ostatni segment to nazwa.

`GatewayService.AddProject` jest na liście `SERVED`: kwalifikowany `worker_id` trasuje wywołanie
do domu workera (etap 2), a dom wykonuje je własnym handlerem jako właściciel. Limit trasowanego
wywołania to 6 min (zamiast 30 s), bo klon czeka na git. Nic nie jest kolejkowane: offline worker
albo niedostępny partner daje natychmiastowy błąd. Dom:

1. sprawdza, że worker należy do właściciela i jest online;
2. dla istniejącego katalogu potwierdza go przez `ListDirectory`, dla nowego wysyła worker
   `Command.init_repository` (**217**) albo `Command.clone_repository` (**218**); wynik w istniejącym
   `CommandResult.directory_path` (6);
3. czyta origin przez `read_workspace_origin` (216);
4. katalog, który już jest workspace'em na tym workerze, daje błąd „This directory is already in …”;
5. dołącza workspace do **jedynego** projektu domu, którego wszystkie workspace'y mają ten origin
   (ta sama reguła co scalanie pickerów); przy braku albo niejednoznaczności tworzy projekt o nazwie katalogu.

Projekt partnera o tym samym origin nie jest dołączany po stronie domu: workspace musi należeć do
rekordu na swoim komputerze. Widok i tak scala oba rekordy po origin. Zgodnie z modelem etapu 4
nowy rekord jest zwykłym lokalnym projektem; jawne współdzielenie i wspólne id pozostają osobną
decyzją, a późniejsza synchronizacja projektów jako wspólnych elementów nie zmienia tego wywołania.

Worker ogłasza capability **`project_sources`**; gateway zapisuje ją jako `Worker.project_sources` (**805**),
a UI wyłącza źródła tworzące katalog dla starszego workera („Update Canopy on … to use this”).
Komendy są nietrwałe (bez outboxa i journala, `NOT_REMEMBERED`). Nowy katalog jest zawsze jednym
segmentem (bez `/`, `\`, `.`, `..`) w istniejącym, bezwzględnym katalogu nadrzędnym po `realpath`.
Worker tworzy go sam (`mkdir` zawodzi, jeśli istnieje, także jako symlink), więc sprzątanie po
nieudanym git usuwa wyłącznie jego własny katalog. Git biegnie przez process governor (rodzaj `git`):
`git init` z limitem 15 s, `git clone -- <url> <nazwa>` z limitem 5 min, bez shella i promptów,
z `GIT_ALLOW_PROTOCOL=https:http:ssh:git:file` (bez `ext::` i `fd::`). Istniejący katalog podlega tym
samym regułom co `ListDirectory` (ścieżka bezwzględna, istniejący katalog, uprawnienia użytkownika OS
workera); przeglądarka startuje w katalogu domowym workera.

Poświadczenia: URL z danymi logowania (`https://user:token@…`) jest odrzucany, zanim trafi do git,
`.git/config` albo logów; błędy git zastępują URL-e znacznikiem `[remote URL]`. Klon używa własnego
logowania git komputera workera (credential helper, klucze SSH). Konto GitHub z Settings → Connectors
**nie** jest używane do klonowania: poświadczenia zostają w gatewayu i nie trafiają na workery.
Prywatne repozytorium wymaga więc dostępu git na komputerze workera; UI mówi to przy polu URL.

Testy: `tests/integration/add-project.test.ts` (dwa gatewaye, rzeczywisty WorkerHost na B: listowanie,
istniejący katalog, klon z lokalnego bare repo przez `file://`, `git init`, dołączenie po origin,
odmowa ścieżek względnych, `..`, symlinku i istniejącej nazwy, URL z poświadczeniami, cudzy worker
i worker offline bez kolejki). Bez testów UI.

## Dostępność: bez kolejkowania

Gdy komputer jest niedostępny, **nie da się do niego nic wysłać** — nie wiemy, czy śpi, stracił sieć,
działa dalej, czy właśnie aktualizuje aplikację. Wiadomości nie czekają w kolejce wychodzącej.

- Stan partnera: **Connected**, stan ogłoszony przed zniknięciem (**Updating…**, **Going to sleep**,
  **Shutting down**, z czasem ogłoszenia) albo **Unreachable since 19:42** — bez zgadywania przyczyny.
- Wątki i boty niedostępnego komputera zostają na liście ze stonowanym oznaczeniem komputera. Wiersze
  wątków zachowują zwykły czas aktywności, bez powtarzania „Last seen”. Da się w nie
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

Połączone komputery działają jak jedno konto z wieloma workerami. Każdy komputer zachowuje własny
gateway, bazę i klucz sekretów, ale **konfiguracja konta jest wspólna**: każdy gateway trzyma tę samą
replikowaną wersję i każdy może ją zmienić. Nie ma przełącznika „Share with linked computers”.
Wspólne jest wszystko, co nie opisuje konkretnej maszyny. Szczegóły:
[konkretny protokół](#konkretny-protokół-wspólna-konfiguracja).

| Zakres | Co obejmuje | Kto zapisuje |
|---|---|---|
| **Wspólne** (domyślnie) | ustawienia konta (wygląd, ogólne, kompozytor, domyślne ustawienia wątków bez workspace'u, generowanie tekstu, strefa, sidebar, domyślna częstotliwość sprawdzania CLI), instancje providerów (nazwa, rodzaj, endpoint, proxy, klucz, zmienne, kolor, modele), proxy, projekty jako tożsamość i ich ustawienia, polityka worktree, biblioteka środowiska agentów (instrukcje, skille, pluginy, marketplace'y), connectory, ich konta i aplikacje OAuth | każdy komputer; wersja per pole |
| **Komputer** | ścieżki CLI i katalogi domowe instancji, lokalizacja worktree, adresy, porty i dostęp sieciowy, łącza komputerów, sparowane telefony i klienty desktopu, enrollment workerów i klucze SSH, kanał aktualizacji, ustawienia powłoki desktopu, układ paneli i szerokość sidebara | tylko ten komputer |
| **Worker** | nazwa, tagi, włączenie i nadpisania instancji na workerze, logowania natywne, workspace'y, worktree, nadpisanie częstotliwości sprawdzania CLI, ustawienia worktree workera, dostęp connectorów | tylko dom workera; inne komputery widzą kopię i edytują przez wywołanie do domu |
| **Urządzenie** | preferencje „This device” w przeglądarce lub aplikacji (localStorage) | ta przeglądarka; nigdy w bazie |

Rzeczy wykonawcze (wątki, boty z konfiguracją i rutynami, harmonogramy, sekrety wątków) nadal mają
jeden dom ([model](#model-każda-rzecz-ma-dom)). Każdy komputer je widzi i edytuje zdalnie,
ale nie są replikowane jako druga edytowalna kopia: kopia offline byłaby ukrytą kolejką pracy.

- **Edycja wszędzie, bez pytań.** Wersje są per pole z hybrydowym zegarem logicznym; wygrywa
  późniejsza zmiana. Współbieżnie nadpisana wartość trafia do historii, a UI pokazuje to przy
  elemencie z akcją „Restore”. Nic nie znika po cichu i nic nie czeka na decyzję.
- **Per łącze** można wyłączyć Share configuration (np. dla komputera służbowego). Konfiguracja przechodzi
  tylko łączami z włączonym udostępnianiem, także pośrednio; po wyłączeniu obie strony zachowują swoją kopię.
- **Ustawienia workera** zapisuje wyłącznie gateway jego domu. Edycja z innego komputera to
  wywołanie do domu, jak przy zdalnych wątkach. Gdy dom jest niedostępny, zmiana jest odrzucana
  od razu z powodem z obecności; ostatnia znana wartość pozostaje do odczytu.
- **Sekrety** (klucze instancji i proxy, zmienne sekretne, tokeny connectorów, aplikacje OAuth)
  przechodzą wyłącznie przypiętym łączem mTLS. Odbiorca szyfruje je własnym kluczem. Nie trafiają
  do przeglądarek, modeli, logów ani workerów innych niż te, które ich używają na swoim komputerze.
- **UI jest ciche.** Wspólne ustawienia nie mają znaczka. Znaczek „This computer” mają tylko
  ustawienia komputera, a ustawienia workera pokazują nazwę workera i jego komputera.

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
- Sidebar, lista botów, nagłówek wątku: znaczek maszyny; stonowana ikona dla niedostępnych.
- Status niedostępnego komputera w pasku nad composerem, obok celu i subagentów; bez bannera u góry.
  Krótki stan, „read only” i czas zmiany obecności; szczegóły pod ikoną informacji, dostępne także dotknięciem.
  „Last seen” zostaje przy samym komputerze w ustawieniach; stan „needs an update”.
- Ustawienia wspólne bez znaczka; znaczek „This computer” tylko przy ustawieniach komputera,
  a nazwa workera z komputerem przy ustawieniach workera ([UI](#ui-wspólnej-konfiguracji)).
- Kompozytor: jeden wiersz projektu na wspólny origin i jeden **No project**. Bez znaczków komputerów
  i podpisów per komputer przy projektach. Picker workera grupuje workery wszystkich komputerów;
  jego przycisk pokazuje worker i komputer. Dla projektu pokazuje tylko workery z workspace'em tego
  projektu, a dla No project wszystkie workery (brak katalogu scratch oznacza wybór wyłączony).
  Offline pozostaje Offline; nieosiągalny dom pokazuje ogłoszony stan (np. Going to sleep) lub Unreachable,
  z rzeczywistym powodem obecności w szczegółach.
  Wysyłanie wymaga osiągalnego domu i workera online. Wybór workspace'u workera przekazuje oryginalne
  `workspace.project_id` i id workspace'u do istniejącej ścieżki zdalnego tworzenia wątku.

## Etapy

1. Tożsamość węzła, parowanie, łącze (mTLS, wersjonowanie), stan obecności, Settings → Linked computers.
2. Zsumowany overview i zdalne wątki: lista, odczyt na żywo, pisanie/steer/zgody trasowane do domu,
   tworzenie wątku na workerze partnera.
3. Lustra osi czasu: odczyt offline, wznowienie od kursora, pełna resynchronizacja.
4. Wspólna konfiguracja: oznaczanie elementów, sekrety, konflikty, znaczki wspólne/lokalne w UI
   (zastąpione przez [wspólną konfigurację](#konkretny-protokół-wspólna-konfiguracja)).
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
modele, katalogi workera, dodawanie projektu (`AddProject`), wzmianki plików, załączniki i bloby osi czasu. Inne metody (ustawienia,
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
na ekranie z ostatnim stanem i krótkim statusem nad composerem, który pozostaje zablokowany.

### UI

Znaczek maszyny (`MachineBadge`: ikona łącza i nazwa) przy wątku partnera w sidebarze i nagłówku
wątku oraz w karcie podglądu wątku. Kompozytor scala projekty według origin (reguły powyżej),
a komputer wybiera się przez worker. Nowy wątek na workerze B używa rekordu projektu z B;
B zostaje właścicielem. Ekrany konfiguracji per komputer (workery, dostawcy, connectory,
domyślne ustawienia wątków, harmonogramy) pokazują wyłącznie własne rzeczy (`ownWorkers`/`ownProjects`),
bo konfiguracja wspólna to etap 4. Wyjątek: lista Settings → Projects pokazuje sumę projektów wszystkich
komputerów z komputerami ich workspace'ów, a stronę ustawień ma tylko projekt z rekordem na tym komputerze. Harmonogramy wątków partnera są
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

Wątki pozostają na liście ze stonowaną ikoną komputera i zwykłym czasem aktywności. Pasek nad
composerem i karta podglądu pokazują krótki stan komputera, „read only” i czas zmiany obecności.
Panel pod ikoną informacji wyjaśnia brak kolejkowania i dostępność plików po połączeniu; działa myszą,
klawiaturą i dotknięciem. Composer, zgody, kolejka, kontynuacja tury, fork,
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

> **Zastąpione** przez [wspólną konfigurację](#konkretny-protokół-wspólna-konfiguracja).
> Opt-in per element, wektory wersji, pytania o konflikt, kopie lokalne po wyłączeniu udostępniania
> i capability `shared_config` znikają. Opis zostaje, bo opisuje dane migrowane z **0050_shared_config**
> ([migracja](#migracja-z-0050)). Sekrety ponownie szyfrowane kluczem odbiorcy i zapis przez własne
> handlery odbiorcy przechodzą do nowego projektu.

Implementacja: `apps/gateway/src/computers/shared.ts` (stan, wektory wersji, push/odbiór, konflikty),
runtime łącza, `api/routed.ts` (wspólna tożsamość projektu), migracja **0050_shared_config**,
kontrakty `SharedConfigService` w `canopy.link.v1` i `GetSharedConfig`/`ManageSharedConfig` w
`canopy.ui.v1`. UI: `apps/web/src/lib/features/computers` (`ShareSetting`, `ShareScope`,
`ConflictDialog`, `SharedConfigOverview`) i `providers/SharedInstance.svelte`.

### Elementy i ich pola

*(Zastąpione: wspólne jest wszystko, co nie dotyczy maszyny.)* Udostępnianie jest **opt-in per element**
(przełącznik „Share with linked computers”). Klucze są takie
same na każdym komputerze:

| Klucz | Wspólne pola | Zostaje na komputerze |
|---|---|---|
| `instance:<harness>:<id>` | nazwa, rodzaj, endpoint, kolor, klucz API, zmienne (także sekretne) | ścieżki CLI, katalogi, argumenty, własne logowanie, workery i ich nadpisania, stan instalacji CLI |
| `models:<harness>:<id>` | ulubione, ukryte, pokazane i własne modele instancji | — |
| `settings:appearance` | schemat kolorów, osobne pełne palety Light / Dark, szerokość czatu | układ paneli i paska bocznego |
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

*(Zastąpione: wersje per pole i historia z „Restore”, bez pytań.)* Ta sama wspólna rzecz zmieniona na dwóch komputerach bez połączenia daje po ponownym połączeniu
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

*(Zastąpione: nie ma wyłączenia udostępniania, usunięcie jest wspólne, a Unlink zachowuje wartości
na obu komputerach.)*

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

*(Zastąpione: [projekty](#projekty-jako-tożsamość) mają globalne id z mapowaniem lokalnych rekordów.)*
Scalanie pickerów po git origin pozostaje niezależne od konfiguracji: samo zgodne origin nie włącza
udostępniania. Migrację konfiguracji projektów wprowadza etap 3 wspólnej konfiguracji.

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

`LinkedAgentCall.sender` przenosi snapshot nadawcy (`AgentSender`): tytuł wątku albo nazwę,
kształt i kolor bota oraz dostawcę/model. Dom odbiorcy kwalifikuje id nadawcy według
uwierzytelnionego partnera i zapisuje snapshot w `input.sender`, obok `note` i `message`.
Metadane służą wyłącznie prezentacji; nie zastępują kontroli właściciela ani relacji szyny.
UI pokazuje autora z odnośnikiem i cichą nazwą komputera, a w dymku samą wiadomość.
Pełna koperta z ostrzeżeniem o niezaufanych danych pozostaje wejściem modelu.

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
Raport niesie też tytuł i status wątku. Rozmowa bota zapisuje krótki event
`“‹title›” on ‹computer› finished`, tak jak lokalne powiadomienie o zakończeniu,
bez id ani koperty platformy. `bot_turns.input` zachowuje pełny raport i wynik dla
bieżącej inferencji oraz odbudowy historii harnessu.
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
pinem. `schema.test.ts` obejmuje 0052. Sieć na fizycznych urządzeniach wymaga osobnej
kontroli, w tym zgody na sieć lokalną i współistnienia z mDNSResponder na macOS.

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

Wspólna konfiguracja również nie przechodzi przez relay. Obejmuje spójną grupę komputerów połączonych
bezpośrednio z włączonym Share configuration; każdy gateway publikuje jej członkom swój scalony stan
([per łącze](#udostępnianie-per-łącze)). **Konfiguracja etapu 4 nie jest przesyłana przez relay.** `shared_config` nie występuje w katalogu,
`PushSharedConfig` jest odrzucany w obu nogach, a jego pętla korzysta tylko z bezpośrednich pinów.
Samo „Share onward” nie włącza udostępniania żadnego elementu konfiguracji ani sekretu P2 do W.
Pozostaje niezależna, dotychczasowa semantyka etapu 4: element przyjęty i oznaczony jako wspólny
na P1 może być wysłany przez P1 jego **bezpośrednim** partnerom. „Share onward” nie rozszerza,
nie odwołuje ani nie zastępuje tego osobnego opt-in. Wspólne projekty zachowują istniejące reguły id.

UI: `ShareOnwardDialog` i `ShareOnwardChoice` (osobny przebieg `componentize`) używają istniejących
`Dialog`, `SettingsRow` i `Switch`. Wpisy pośrednie pokazują **via P1**, bez tras, fingerprintu,
Rename, Unlink ani dalszego udostępniania. Wpis informacyjny opisuje kierunek dostępu. Znaczek
maszyny przy rzeczy również podaje pośrednika; pasek blokady wątku korzysta z tego samego powodu co API.

### Weryfikacja i odroczenia

`tests/integration/computer-relay.test.ts`: trzy prawdziwe gatewaye, osobne bazy PostgreSQL,
przypięte mTLS, skryptowane workery i model bota. Brak dostępu domyślnie (także surowym żądaniem),
listing via P1 i przejrzystość na P2, wzajemne jawne zgody bez pętli, odczyt/zapis/steer/zgoda,
załącznik, bot i spawn z raportem do prawdziwego źródła, granice callbacków, odmowa konfiguracji,
origin spoofing, limity hop i pętle, odwołanie trwającego wywołania i purge obu luster oraz listingu
żywego strumienia overview (spóźniona odpowiedź nie odtwarza usuniętego komputera), stary
katalog, P1 offline i restart W/P1 z czytelnym powodem i bez kolejki, capability fallback oraz Unlink.
`schema.test.ts`: migracja 0053, izolacja ownera, brak certyfikatu wpisu pośredniego i kaskady.
Bezpośrednie W↔P2 po „przedstawieniu” przez P1, discovery relayed computers
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
(triggery, jeden aktywny ruch, reguły ról).

Odroczone: przenoszenie przez pośrednika, przeniesienie z powrotem na komputer ze starą kopią,
przenoszenie samych sekretów wątku, wątki bez workera, przeniesienie zainicjowane z UI innego
komputera niż dom, strumieniowanie ładunku ponad 40 MiB plików i fork z tury sprzed przeniesienia.

## Konkretny protokół: wspólna konfiguracja

Zastępuje opt-in etapu 4. Połączone komputery mają **jedną wspólną wersję konfiguracji konta**,
a każdy gateway nadal działa samodzielnie na własnej bazie. Implementacja:
`apps/gateway/src/config-sync/` (rekordy, zegar, scalanie, materializacja w tabelach domeny),
runtime łącza, `api/routed.ts` (tłumaczenie id i edycja ustawień workerów), wewnętrzna usługa
`ConfigSyncService` w `canopy.link.v1`, capability **`config_sync`**.
Stos PR-ów: `feat/linked-shared-config-N` ([etapy](#etapy-wspólnej-konfiguracji)).

### Zakres i decyzje

- **Domyślnie wspólne.** Wspólna jest każda konfiguracja konta. Lokalne zostaje tylko to, co opisuje
  komputer albo workera (inny system, inne ścieżki, inne logowania) albo przeglądarkę.
- **Dwie klasy rekordów w jednym strumieniu.** Rekord **wspólny** zapisuje każdy komputer.
  Rekord **workera** zapisuje wyłącznie dom workera; partnerzy trzymają jego kopię tylko do odczytu.
- **Wartości zostają w tabelach domeny** (`provider_instances`, `user_settings`, `proxies`, …).
  Rekord niesie wersje pól, a każdy zapis UI i każde przyjęcie zmiany partnera aktualizuje oba
  miejsca w jednej transakcji. Odbiorca stosuje zmianę przez własne walidatory i handlery,
  z wersją nadawcy. Nigdy nie wybija nowej wersji dla cudzej zmiany.
- **Bez kolejkowania.** Wspólny rekord zmienia się lokalnie zawsze, także offline; partnerzy
  nadrabiają po połączeniu. To stan, nie praca do wykonania. Ustawienia workera i rzeczy
  wykonawcze wymagają osiągalnego domu.
- **Zbieżność w grupie.** Konfiguracja obejmuje każdy komputer osiągalny łańcuchem bezpośrednich
  łącz z włączonym Share configuration ([per łącze](#udostępnianie-per-łącze)). Nie przechodzi przez
  relay etapu 7. „Share onward” nadal dotyczy tylko wątków, botów i luster.
- **Usuwanie jest wspólne**, z przywracaniem z historii przez 90 dni ([usuwanie](#usuwanie)).
- **Boty i harmonogramy mają jeden dom** i są edytowane zdalnie, bez replikowanej kopii.
- **Preferencje przeglądarki** („This device”, skróty klawiszowe) zostają na urządzeniu.
- **Wyścig odświeżania OAuth** jest akceptowany: przegrany komputer chwilowo pokazuje „needs reconnect”,
  aż dostanie nowsze poświadczenia od partnera ([sekrety](#sekrety)).

### Inwentarz

| Dane | Źródło | Zakres | Powód |
|---|---|---|---|
| wygląd: schemat, akcent, palety Light/Dark, szerokość czatu | `user_settings.appearance` | wspólne | wybór użytkownika, nie ekranu |
| szerokość i zwinięcie sidebara, zwinięty panel wątku | `user_settings.appearance` | komputer | zależy od ekranu |
| ogólne (potwierdzenia), kompozytor (Enter w trakcie tury) | `user_settings.general`, `.composer` | wspólne | nawyki użytkownika |
| domyślne ustawienia wątku | `user_settings.thread_defaults` | wspólne bez `workspace_id` | workspace jest katalogiem jednej maszyny |
| generowanie tekstu, strefa czasowa | `user_settings.text_generation`, `.timezone` | wspólne | jedno konto, jedna osoba |
| sidebar: przypięte wątki i boty, filtr i kolejność projektów | `user_settings.sidebar` | wspólne | id jako globalne odwołania |
| domyślna częstotliwość sprawdzania CLI | `user_settings.cli_updates` | wspólne | wartość domyślna konta |
| nadpisanie częstotliwości CLI na workerze | `worker_configs.config` | worker | ustawienie maszyny |
| limity załączników, adres gatewaya dla workerów | `user_settings` | komputer | konfiguracja tego gatewaya |
| instancja: nazwa, rodzaj, endpoint, proxy, kolor, argumenty, własne logowanie (wybór), `all_workers` | `provider_instances` | wspólne | definicja dostępu |
| instancja: klucz API, zmienne sekretne | `provider_instances` → `secrets` | wspólne, sekret | ponownie szyfrowane u odbiorcy |
| instancja: modele (ulubione, ukryte, pokazane, własne) | `provider_instances` | wspólne | wybór użytkownika |
| instancja: ścieżka CLI, katalog domowy i izolowany | `provider_instances.runtime` | komputer | inny system plików |
| instancja na workerze: włączenie, nadpisania (także klucz) | `provider_instance_workers` | worker | ustawienie maszyny; klucz workera nie opuszcza domu |
| proxy: nazwa, rodzaj, adres, opcje Codexa, sekret | `proxies` → `secrets` | wspólne, sekret | wskazywane przez instancje |
| projekt: nazwa, rodzaj, archiwizacja, tożsamość origin | `projects`, `project_workspaces.git_origin` | wspólne | jeden projekt na wszystkich komputerach |
| ustawienia projektu | `project_settings` | wspólne bez `workspace_id` | jak domyślne ustawienia wątku |
| workspace, worktree, katalogi | `project_workspaces`, `worktrees` | worker | katalog na jednej maszynie |
| polityka worktree konta i projektu | `worktree_settings` bez workera | wspólne bez `location` | lokalizacja jest ścieżką komputera |
| ustawienia worktree workera | `worktree_settings` z workerem | worker | ustawienie maszyny |
| instrukcje, skille, pluginy, marketplace'y i ich wersje | `instruction_documents*`, `agent_skills*`, `agent_plugins*`, `agent_marketplaces` | wspólne | biblioteka konta; selektory wskazują workery po uuid |
| tagi workera | `worker_environments.manual_tags` | worker | opis maszyny |
| raport środowiska, tagi automatyczne, podglądy | `worker_environments`, `*_previews` | worker / lokalne | stan wykonania |
| konto connectora: typ, nazwa, adres, transport, `all_workers`, `all_bots`, katalog narzędzi | `connector_accounts` | wspólne | jedno konto zewnętrzne |
| poświadczenia connectora, nagłówki, aplikacje OAuth | `connector_accounts.credentials`, `connector_oauth_apps` | wspólne, sekret | ponownie szyfrowane u odbiorcy |
| stan konta connectora, ostatnie użycie, przestrzeń nazw | `connector_accounts` | komputer | wynik użycia na tym komputerze |
| dostęp connectora dla workera | `connector_worker_grants` | worker | uprawnienie maszyny |
| dostęp connectora dla bota, granty | `connector_bot_grants` | dom bota | część bota |
| stan OAuth, wykonania, audyt connectorów | `connector_oauth_states`, `connector_executions`, `connector_audit` | lokalne | stan wykonania |
| boty, rutyny, przypomnienia | `bots`, `bot_routines`, `bot_wakeups` | dom | rzeczy wykonawcze |
| harmonogramy i ich uruchomienia | `schedules`, `schedule_runs` | dom | rzeczy wykonawcze |
| sekrety wątków | `thread_secrets` | dom wątku | nigdy nie opuszczają domu |
| worker: nazwa, połączenie, konfiguracja wysyłana do workera | `workers`, `worker_connections`, `worker_configs` | worker | składane przez dom |
| enrollment, klucze i hosty SSH, dostęp sieciowy | `worker_enrollments`, `worker_ssh_*`, `network_access` | komputer | sieć i zaufanie tej maszyny |
| łącza, trasy, lustra, ruchy | `computer_*` | komputer | stan łącza |
| telefony, klienty desktopu, aktualizacje desktopu | `mobile_*`, `desktop_*` | komputer | parowanie z tym gatewayem |
| właściciel | `users` | komputer | lokalny uuid; rekordy go nie zawierają |
| preferencje „This device”, skróty klawiszowe | localStorage | urządzenie | wybór urządzenia |
| ustawienia powłoki desktopu | pliki Electron | komputer | aplikacja na tej maszynie |

Przed tą zmianą 0050 udostępniał tylko oznaczone elementy: definicję instancji (bez proxy i `all_workers`),
listy modeli, wygląd, domyślne ustawienia wątku, strefę, generowanie tekstu oraz tożsamość i nazwę projektu.
Nie obejmował proxy, ustawień ogólnych, kompozytora, sidebara, CLI, ustawień projektu, polityki worktree,
środowiska agentów ani connectorów. Zmiana nazwy nieoznaczonej instancji zostawała więc lokalna.

### Rekord, klucze i id

`config_items(owner_user_id, kind, global_id, local_id, home_node_id, identity, fields, deleted, revision)`
opisuje jeden element. `kind` to rodzaj (`settings`, `instance`, `proxy`, `project`, `project_settings`,
`worktree_policy`, `instruction`, `skill`, `plugin`, `marketplace`, `connector`, `oauth_app`, `worker`).
`home_node_id` jest puste dla rekordu wspólnego, a dla rekordu workera wskazuje jego dom.
`fields` to mapa pole → `{value, hlc, prev}`. Wartość sekretu zastępuje losowy token.
`identity` to znormalizowany klucz scalania ([bootstrap](#bootstrap-i-scalanie-tożsamości)).

**Id są ujednolicone, a mapowane tylko po scaleniu.** Element utworzony po połączeniu ma to samo id
wszędzie: uuid albo, dla instancji, `harness:slug`. Odbiorca tworzy wiersz z tym id. Gdy scalenie łączy dwa
istniejące elementy, oba lokalne wiersze zostają. Kanoniczne id to mniejsze z dwóch, a drugie trafia do
`config_aliases(owner_user_id, kind, alias_id, global_id)`. Nie przepisujemy więc wątków, botów ani
harmonogramów, które wskazują lokalny wiersz.

Ładunek nigdy nie zawiera lokalnych id. Odwołania do innych elementów (proxy instancji, instancja w domyślnych
ustawieniach, konto credentiali źródła skilla, przypięte wątki) są globalnymi kluczami. Odwołanie do rzeczy
z domem ma postać `uuid@node`. Odbiorca rozwiązuje je przez aliasy do swoich id. Kolizja sluga instancji
(inny element z tym samym `harness:slug`) dostaje lokalny slug `slug-2` i alias.

`api/routed.ts` tłumaczy pola konfiguracji w wywołaniach do partnera (`provider_profile_id`, `proxy_id`,
`project_id`, id kont connectorów i skilli) przez aliasy, jak dziś kwalifikuje id wątków.
Bez aliasu tłumaczenie jest tożsamościowe.

### Wersje: HLC per pole

Każda zmiana pola dostaje **hybrydowy zegar logiczny** `wall_ms.counter.node`: maksimum czasu ściany
i ostatnio widzianego HLC, licznik dla równych milisekund, id węzła jako ostateczny remis. Porządek jest
całkowity i ten sam na każdym komputerze. Pola mają granulację wartości, którą użytkownik zmienia jednym
ruchem: liść ustawień, nazwa instancji, cała lista ulubionych, zmienna po nazwie, nadpisanie selektora
po uuid workera. Zmiana dwóch różnych pól jednego elementu nigdy nie jest konfliktem.

`prev` to HLC wartości, którą autor widział przed zmianą. Odbiorca porównuje go z lokalnym HLC pola:

- `prev ≥` lokalny HLC: zmiana następcza; stosuje ją bez śladu;
- przychodzący HLC wyższy, ale `prev` niższy: zmiana współbieżna; stosuje ją, a lokalną wartość
  zapisuje w historii;
- przychodzący HLC niższy: wygrywa lokalna; przychodząca wartość trafia do historii.

Druga strona dochodzi do tego samego wyniku, gdy dostanie naszą wartość. Zegar partnera wyprzedzający nasz
o ponad 5 min nie blokuje scalania. Settings → Linked computers pokazuje wtedy „Clock is 12 min ahead”.

### Propagacja i nadrabianie

`config_clock(owner_user_id, epoch, revision)` nadaje lokalną rewizję przy każdej zmianie rekordu:
własnej, przyjętej od partnera i scaleniu. Licznik wiersza porządkuje commity jak `computer_thread_clock`.
Kursor partnera ma postać `<epoka>:<rewizja>`. `config_peer_cursors` ma kaskadę do `computer_peers`.

`ConfigSyncService.WatchConfig(ConfigCursor)` jest wewnętrzną metodą transportu `RemoteRequest`/`RemoteResponse`
po przypiętym mTLS, tylko przy capability obu stron i aktywnym partnerze. Każda strona subskrybuje
partnera od swojego kursora. Dom wysyła rekordy z rewizją powyżej kursora w partiach z `checkpoint`.
Potem utrzymuje strumień i wysyła zmiany na żywo (powiadomienie po commicie, najpóźniej co 250 ms).
Brak kursora, inna epoka albo kursor z przyszłości oznaczają pełne wysłanie wszystkich rekordów.

Scalanie jest idempotentne, przemienne i łączne (mapa LWW per pole), więc nie potrzebujemy dziennika zmian
ani naprawy luk: wystarczy stan rekordów. Ponowienie partii po awarii niczego nie psuje, a kursor zapisujemy
po zastosowaniu partii. Odbiorca przyjmujący zmianę nadaje rekordowi własną rewizję i publikuje go dalej.
Echo do nadawcy niczego nie zmienia i nie podbija rewizji, więc grupa komputerów dochodzi do jednego stanu.

### Udostępnianie per łącze

Każde łącze ma ustawienie **Share configuration** (domyślnie włączone, także dla łącz istniejących przed
migracją). Okno „Link computer” pokazuje je przed parowaniem, więc komputer służbowy można połączyć
od razu bez wspólnej konfiguracji. Łącze przenosi konfigurację tylko wtedy, gdy obie strony mają je
włączone: każda strona może je wyłączyć, a włączyć z powrotem może tylko ta, która wyłączyła.
Wartość jest w `computer_peers.share_config` (lokalny wybór) i `computer_peers.peer_share_config`
(ostatni wybór partnera). Strona przekazuje ją ramką `ConfigSharing` po każdym handshake i od razu
po zmianie. Do czasu tej wymiany żadna strona nie otwiera `WatchConfig`.
Ramka zawiera też rosnącą rewizję lokalnego wyboru, zachowywaną w bazie. Odbiorca odrzuca starszą
rewizję, aby opóźniona ramka z równoległego połączenia nie przywróciła wyłączonej zgody.

**Grupa konfiguracji** to spójna składowa grafu łącz z włączonym udostępnianiem. Każdy komputer należy
do dokładnie jednej grupy, a w grupie jest jedna wersja konfiguracji. Gateway publikuje rekordy
wyłącznie partnerom, z którymi łącze przenosi konfigurację, i tylko od nich je przyjmuje. `WatchConfig`
od innego partnera kończy się `FAILED_PRECONDITION`, zanim cokolwiek wyśle. Dlatego nic nie przechodzi
przez łącze z wyłączonym udostępnianiem, także pośrednio: W–P1 wyłączone i P1–P2 włączone daje grupy
{W} i {P1, P2}, a rekordy W nie docierają ani do P1, ani do P2. Gdy W ma też włączone łącze z P2,
wszystkie trzy komputery tworzą jedną grupę, bo istnieje ścieżka udostępniania. UI pokazuje to wprost.

Każdy komputer publikuje w grupie rekord `computer` (dom = on sam): nazwę i listę partnerów, z którymi
łącze przenosi konfigurację. Z tych rekordów każdy gateway liczy skład grupy. Rekordy `computer`
i `worker` komputera spoza grupy są usuwane jako kopie; ich dom ma oryginały.
Kursor partnera spoza grupy jest wtedy usuwany, aby ponowne połączenie grup wysłało też niezmienione
rekordy komputerów i workerów, których kopie zostały wcześniej usunięte.

**Bez osobnego „Share secrets”.** Wspólna instancja, proxy albo connector bez klucza nie działa, więc
podział dawałby połowiczną konfigurację. Sekret bez wartości po jednej stronie łamie też wersje per pole:
nowszy token z drugiej strony nadpisałby działający klucz wartością, której ten komputer nie dostał.
Potrzebna byłaby druga grupa i sekrety per komputer. Ochronę komputera służbowego daje wyłączenie
całego łącza, a sekrety i tak nie opuszczają gatewayów.

**Wyłączenie później nie usuwa danych.** Obie strony zachowują wszystkie rekordy, wartości, sekrety,
aliasy, tombstony i historię jako zwykłą konfigurację swojej nowej grupy. Od tej chwili zmiany idą osobno.
Usunięcie byłoby utratą danych, a sekrety, które już dotarły, i tak zostały wysłane. Rekordy zachowują
globalne id, więc ponowne włączenie to zwykły bootstrap: te same id scalają się per pole bez duplikatów,
a różnice z czasu rozdzielenia dają notki z Restore.

- Wyłączenie otwiera potwierdzenie „Stop sharing configuration with “Laptop B”?” z opisem „Both computers
  keep their current configuration. Later changes stay on each computer.” Gdy grupa się nie rozpada:
  „Laptop B still gets it through “Laptop C”.” Przycisk: „Stop sharing”.
- Partner pokazuje przy łączu „Laptop A stopped sharing configuration. This computer keeps its copy.”
  Przełącznik jest tam wyłączony z tym samym wyjaśnieniem.
- Settings → Linked computers pokazuje skład grupy: „Shares configuration with Laptop B and Laptop C”.

**Relay (etap 7).** Konfiguracja nigdy nie przechodzi przez pośrednika. Komputer widoczny przez
„Share onward” nie należy do grupy pośrednika i nie ma przełącznika Share configuration. „Share onward”
i Share configuration są niezależne: pierwsze dotyczy wątków, botów i luster, drugie konfiguracji.

**Aliasy i id.** Scalanie tożsamości używa wyłącznie rekordów grupy. Aliasy są lokalne i zostają po
rozdzieleniu. Po ponownym włączeniu reguła „mniejsze id” daje ten sam wynik w obu grupach, więc wcześniejsze
scalenia pozostają zgodne. Wątki, boty i workery komputera spoza grupy nadal działają przez trasę etapu 2.
Pickery pokazują dla jego workera instancje i projekty jego domu (`GetBotProviderInstances` i overview
partnera), a `routed.ts` nie tłumaczy id konfiguracji przez takie łącze. Wybór instancji spoza domu kończy
się komunikatem „This instance isn't on “Laptop B”. Choose one of its instances.” Edycja ustawień workera
(rekordy `worker`) wymaga łącza przenoszącego konfigurację.

### Konflikty i historia

Pytania o wersję znikają. Edycja wszędzie pozostaje prosta, a dane nie giną po cichu:

- `config_history(owner_user_id, kind, global_id, field, value, hlc, node_id, secret, superseded_at, state)`
  przechowuje każdą wartość przegraną współbieżnie. Wartość sekretu jest zaszyfrowana kluczem tego komputera.
- Przy elemencie UI pokazuje notkę: „Laptop B also changed this at 14:02.” z akcjami **Restore** i **Dismiss**.
  Restore zapisuje starą wartość jako nową zmianę, więc dochodzi do wszystkich komputerów.
- Settings → Linked computers zbiera notki w grupie „Changed on two computers”. Dismiss na jednym komputerze
  nie ukrywa notki na innych; historia jest lokalna i wygasa po 90 dniach.
- Sekret w notce widać wyłącznie jako „A different key”.

### Usuwanie

Usunięcie zapisuje **tombstone**: pole `deleted` z własnym HLC. Rekord bez ładunku pól zostaje na stałe,
bo w skali osobistej to kilka bajtów, a stary partner po powrocie nie przywróci usuniętego elementu.
Odbiorca usuwa element lokalnie tak samo jak przy usunięciu z UI. Wątki i boty, które go wskazują,
zachowują historię jak dziś.

Zmiana pola z HLC wyższym niż tombstone przywraca element. UI pokazuje wtedy notkę „Laptop B changed it after
it was deleted here.” z akcją usunięcia. Usunięcie wygrywa ze zmianami starszymi od niego, a każda nadpisana
wartość trafia do historii. Archiwizacja projektu jest polem, nie usunięciem: każdy komputer archiwizuje
swoje wątki projektu, jak przy lokalnej archiwizacji.

### Sekrety

Pole sekretu w rekordzie to token. `ConfigField.secret` niesie wartość tylko w strumieniu łącza i tylko
dla zmienionego pola albo przy pełnym wysłaniu. Nadawca odszyfrowuje ją swoim `CANOPY_SECRETS_KEY`.
Odbiorca zapisuje nowy wiersz `secrets` zaszyfrowany **własnym** kluczem, w tej samej transakcji co rekord.
Wartość nie trafia do historii partnera, logów, audytu, BFF, przeglądarki, modeli ani payloadów błędów.
Na workery trafia wyłącznie w `WorkerConfig` workerów, które jej używają na danym komputerze.
Klucz nadpisania instancji na workerze należy do rekordu workera i nie opuszcza domu.

Tokeny connectorów OAuth odświeża komputer, który ich potrzebuje. Nowe tokeny są zwykłą zmianą pola,
więc szybko dochodzą do partnerów. Gdy dostawca unieważni stary refresh token po równoległym odświeżeniu,
przegrany komputer oznacza konto „needs reconnect”. Nowsza wersja poświadczeń od partnera zdejmuje ten stan.

### Bootstrap i scalanie tożsamości

Pierwsza synchronizacja z partnerem to zwykłe pełne wysłanie. Elementy o tym samym globalnym id scalają się
per pole. Singletony (ustawienia konta, wbudowane instancje `native`, projekt scratch) mają stałe klucze,
więc też scalają się per pole. Istniejące dane dostają przy migracji HLC z `updated_at` swojego wiersza,
a w razie jego braku z `created_at`. Bootstrap wybiera więc najnowszą zmianę, a starszą wartość zapisuje
w historii z notką „Merged with Laptop B”.

Elementy o różnych id, ale tej samej **tożsamości**, stają się jednym elementem. Scalenie jest deterministyczne:
kanoniczne id to mniejsze, drugie jest aliasem, a pola scalają się per pole. Każdy komputer liczy ten sam
wynik niezależnie, także później, gdy taki element powstanie offline na dwóch komputerach.

| Rodzaj | Tożsamość |
|---|---|
| instancja endpoint | harness, znormalizowany endpoint albo tożsamość proxy, ten sam klucz (porównuje odbiorca po odszyfrowaniu) |
| instancja native z własnym logowaniem | harness i nazwa bez rozróżniania wielkości liter |
| proxy | rodzaj, znormalizowany adres i ten sam sekret (porównuje odbiorca) |
| projekt | jeden znany git origin wszystkich workspace'ów ([projekty](#projekty-jako-tożsamość)) |
| instrukcja | harness i nazwa |
| skill | źródło (adres, ref, ścieżka), a bez źródła nazwa |
| marketplace | znormalizowane repozytorium |
| plugin | marketplace i nazwa pluginu |
| konto connectora | typ, adres i nazwa |
| aplikacja OAuth | typ connectora |

Inny klucz przy tym samym endpoincie oznacza dwa konta, więc elementy pozostają osobne. Różna treść skilla,
instrukcji albo pluginu o tej samej tożsamości nie ginie: przegrana treść staje się kolejną wersją elementu.

### Projekty jako tożsamość

Projekt jest rekordem wspólnym: nazwa, rodzaj, archiwizacja, ustawienia projektu (bez workspace'u) i pole
`origin`. Workspace'y są rekordami workera i należą do jego domu. Partner bez workspace'u projektu
widzi go z workspace'ami innych komputerów. Picker workera wybiera wtedy komputer.

`origin` liczy dom z `project_workspaces.git_origin` (migracja **0072_workspace_origin**,
`normalizeGitOrigin` w `@canopy/domain/projects`). Wartość jest niepusta tylko wtedy, gdy wszystkie lokalne
workspace'y projektu mają ten sam znany origin. Scalanie stosuje reguły pickera projektów według git origin: formy HTTPS, SSH i scp to ta sama tożsamość,
a lokalne ścieżki, `file:` i brak origin nie są tożsamością. Dwa różne projekty z tym samym origin
na jednym gatewayu blokują scalanie całej grupy, bo nie zgadujemy, do którego dołączyć. Projekt bez origin
nigdy nie scala się automatycznie. Projekty scratch mają jeden stały klucz.

Po scaleniu `projectChoices` grupuje najpierw po globalnym id (alias wskazuje kanoniczny projekt), a potem,
jak dotąd, po origin. Lokalne rekordy, wątki i workspace'y zachowują swoje id. Nowy wątek na workerze B
z projektu kanonicznego dostaje id projektu z B przez alias. Zmiana nazwy na dowolnym komputerze zmienia
ją wszędzie.

### Rekordy workerów i edycja zdalna

Dom publikuje rekord `worker` każdego swojego workera: nazwę, system, tagi, instancje na workerze
(włączenie, nadpisania bez wartości sekretów), nadpisanie częstotliwości CLI, ustawienia worktree workera
i dostęp connectorów. Partnerzy zapisują go jako kopię tylko do odczytu. Rekord z cudzym `home_node_id`
zmieniony przez kogokolwiek poza domem jest odrzucany.

Edycja ustawień workera z innego komputera to wywołanie do domu przez trasę etapu 2. `SERVED` obejmuje
`RenameWorker`, `SetInstanceWorker`, `SetInstanceWorkers`, `SetWorkerCliUpdateSettings`,
`SetEnvironmentTags`, `UpdateWorktreeSettings` z workerem, `SetConnectorAccess` (część workerów domu),
`RefreshProviders`, `InstallCli`, `CheckCliUpdates`, `StartProviderLogin` i `ListDirectory`.
Dom wykonuje je własnymi handlerami jako właściciel tego gatewaya. Każde id workera i workspace'u musi
należeć do domu. Żądanie mieszające komputery jest odrzucane. `SetConnectorAccess` z workerami kilku
komputerów rozdziela gateway wywołujący: część wspólną zapisuje lokalnie, a części workerów wysyła do domów.
Obie strony zapisują `audit_log` `computer.config.worker.sent` / `.received`.

Telefony i przeglądarki nie trasują niczego. Metody zarządzania wymagają tokenu serwisowego BFF jak dziś.
Partner nigdy nie zmienia rekordu wspólnego przez `RemoteRequest`, tylko przez `WatchConfig`. Model nie ma
dostępu do żadnej z tych metod. Niedostępny dom daje od razu powód z obecności („Laptop B is unreachable
since 19:42”), a UI zostawia ostatnią znaną wartość tylko do odczytu.

### Rozłączenie

Unlink usuwa kursor partnera i kopie rekordów jego workerów (kaskada do `computer_peers`).
Wspólne rekordy, wartości, sekrety, aliasy i tombstony zostają na obu komputerach, które dalej działają
samodzielnie. Ponowne połączenie to bootstrap. Te same globalne id scalają się per pole bez duplikatów,
a usunięcia z czasu rozłączenia stosują się według HLC, z notką i Restore.

### Zgodność wersji

`COMPUTER_LINK_PROTOCOL` zostaje 1. Capability `config_sync` jest negocjowana jak w etapach 2–8,
a proto zmienia się wyłącznie addytywnie. Pierwsza wiadomość strumienia (`ConfigHello`) podaje obsługiwane
rodzaje i wersję schematu każdego z nich. Odbiorca zapisuje rodzaje i pola, których nie zna, w `config_items`
bez materializacji. Publikuje je dalej i nie gubi ich przy własnej zmianie elementu. Wartość, której nie da
się zastosować lokalnie (np. nieznany rodzaj proxy), zostaje w rekordzie ze stanem „Not supported on this computer”
i powodem.

Partner bez `config_sync` nie dostaje ani nie wysyła konfiguracji. Settings → Linked computers pokazuje
„Needs an update to share configuration”. Nowe gatewaye nie ogłaszają `shared_config` z 0050.

### Migracja z 0050

Migracja każdego etapu nadaje rekordy wszystkim istniejącym elementom swoich rodzajów, z HLC z `updated_at`.
Elementy oznaczone w `computer_shared_items` jako wspólne mają już te same klucze u partnerów i scalają się
bez aliasów. Nieoznaczone stają się wspólne i przechodzą bootstrap. Otwarte pytania z
`computer_shared_conflicts` stają się wpisami historii z notką: wygrywa nowsza wartość, druga zostaje
do przywrócenia. Kopie lokalne po wyłączeniu udostępniania są zwykłymi elementami i scalają się według
tożsamości. Ostatni etap migruje projekty i usuwa tabele `computer_shared_*`, pętlę `shared_config`,
`ShareSetting`, `ShareScope`, `ConflictDialog`, `ConflictHint` i `SharedConfigOverview`.
`GetSharedConfig`/`ManageSharedConfig` i `SharedConfigService` zostają w proto jako przestarzałe.

### UI wspólnej konfiguracji

- **Wspólne bez znaczka.** Ustawienia konta wyglądają tak samo jak bez połączonych komputerów.
- **Komputer:** grupy ustawień komputera (Network access, Desktop, aktualizacje, ścieżki CLI instancji,
  lokalizacja worktree) mają w opisie „This computer”. Preferencje przeglądarki dalej mówią „This device”.
- **Worker:** listy workerów w Settings → Workers, Providers (instancja na workerach), Agent environment,
  Worktrees i Connectors (dostęp) obejmują workery wszystkich komputerów, pogrupowane po komputerze:
  najpierw „This computer”, potem partnerzy po nazwie. Wiersz pokazuje nazwę workera i komputera.
  Worker niedostępnego komputera jest wyszarzony, z „Unreachable since 19:42”, a kontrolki są wyłączone
  z tym samym powodem co API.
- **Picker workera wybiera komputer** w kompozytorze, przy tworzeniu bota i harmonogramu nowego wątku.
  Nie ma osobnego wyboru komputera. Picker grupuje workery po komputerze i pokazuje Offline albo
  Unreachable z powodem z obecności.
- **Notki:** „Laptop B also changed this at 14:02.” przy elemencie, z Restore i Dismiss, oraz grupa
  „Changed on two computers” w Settings → Linked computers.
- **Stan synchronizacji** przy partnerze: „Configuration up to date”, „Syncing configuration…”, „Needs
  an update to share configuration”, „Clock is 12 min ahead”. Przełącznik Share configuration i skład
  grupy: [per łącze](#udostępnianie-per-łącze).
- Tekst według [copy.md](copy.md). Każdy etap z UI ma audyt §8 w opisie PR.

### Etapy wspólnej konfiguracji

Stos `feat/linked-shared-config-N`. Każdy etap to zamknięty fragment, który przechodzi CI. Bazą etapu 1 jest
`dev`. Numery migracji zakładają, że `feat/linked-projects-by-origin` (0072) wejdzie pierwszy. Przy rebase
nadajemy kolejne numery od najwyższego. Testy: dwa (w etapie 1 także trzy) prawdziwe gatewaye z osobnymi
bazami PostgreSQL i kluczami sekretów, przypięte mTLS, skryptowane workery. Bez testów UI.

1. **Silnik i ustawienia konta.** `config_items`, `config_clock`, `config_history`, `config_aliases`,
   `config_peer_cursors` (**0073_config_sync**), HLC, `ConfigSyncService.WatchConfig` i `ConfigHello`,
   capability `config_sync`, materializacja `user_settings` (wszystkie sekcje konta) i migracja sekcji
   z 0050, notki i stan synchronizacji w Settings → Linked computers. Share configuration per łącze
   (`computer_peers.share_config`, `peer_share_config`, ramka `ConfigSharing`), rekordy `computer`,
   skład grupy i przełącznik w oknie parowania oraz przy partnerze.
   Testy: zmiana na A widoczna na B na żywo; zmiany offline obu stron w różnych polach scalone; współbieżne
   to samo pole: ten sam zwycięzca na obu, przegrana w historii, Restore dochodzi do obu; restart w trakcie
   partii i ponowienie; kursor z inną epoką; zbieżność A–B–C bez łącza A–C; pola komputera nie wychodzą;
   rekord innego właściciela nie wychodzi; partner bez capability. Per łącze (trzy gatewaye): W–P1
   wyłączone i P1–P2 włączone, więc zmiany W nie docierają do P1 ani P2 i odwrotnie, także po restarcie
   i reconnect; `WatchConfig` przez wyłączone łącze odrzucone przed wysłaniem rekordu; wyłączenie w trakcie
   strumienia go zamyka; po wyłączeniu obie strony zachowują wartości, a dalsze zmiany idą osobno; kopie
   rekordów workerów spoza grupy znikają; ponowne włączenie scala bez duplikatów, z notkami; tylko strona,
   która wyłączyła, może włączyć.

   Implementacja etapu 1 używa migracji **0073_config_sync**, po **0072_workspace_origin**.
   `config_sync` nie ogłasza starego `shared_config`; obsługa 0050 dla instancji, modeli i projektów
   pozostaje do migracji ich rodzajów w następnych etapach. Nieznane rodzaje, pola i wartości zostają
   w rekordach i przechodzą dalej; nieznana wersja schematu nie jest materializowana. Usunięcie zachowuje
   sam zegar tombstone oraz nowsze liście przywracające element; przegrane wartości są w lokalnej historii.
2. **Instancje, modele i proxy.** Materializacja `provider_instances` (bez ścieżek) i `proxies`, sekrety
   z ponownym szyfrowaniem, tożsamość endpointu i proxy, aliasy, kolizja sluga, tłumaczenie
   `provider_profile_id`/`proxy_id` w `routed.ts`, migracja instancji i modeli z 0050 (**0074_config_providers**).
   Testy: zmiana nazwy instancji na A widoczna na B (zgłoszony błąd); klucz z innym ciphertextem, B go
   odszyfrowuje, brak w BFF, logach i na workerze innego komputera; ta sama instancja na obu przed połączeniem
   scalona w jedną; inny klucz pod tym samym endpointem daje dwie; usunięcie i przywrócenie; wątek z A na
   workerze B używa instancji z aliasem; przez łącze bez Share configuration klucz nie przechodzi, a wątek
   na workerze B używa instancji B.
3. **Projekty i polityka worktree.** Rekord projektu z `origin`, ustawienia projektu, `worktree_settings` konta
   i projektu, scalanie po origin zgodne z `projectChoices`, migracja projektów z 0050, usunięcie tabel
   i UI 0050 (**0075_config_projects**). Testy: projekty z tym samym origin na A i B scalone bez zmiany lokalnych id;
   niejednoznaczny origin bez scalenia; nowy wątek na workerze B w projekcie kanonicznym; archiwizacja
   na wszystkich; `location` zostaje lokalne.
4. **Środowisko agentów.** Instrukcje, skille, pluginy i marketplace'y z wersjami, selektory i nadpisania po
   uuid workera (każdy gateway stosuje tylko swoje workery) (**0076_config_agent_environment**).
   Testy: skill zapisany na A instalowany na workerze B; ta sama nazwa i inna treść daje dwie wersje;
   nadpisanie dla workera B nie zmienia workera A.
5. **Connectory.** Konta, poświadczenia i aplikacje OAuth jako sekrety, stan per komputer, odświeżanie
   tokenów (**0077_config_connectors**). Testy: konto połączone na A działa w bocie na B; ciphertext inny
   na B; równoległe odświeżenie z rotacją refresh tokenu kończy się jednym ważnym tokenem na obu;
   tokeny nie trafiają do logów ani BFF.
6. **Rekordy workerów i edycja zdalna.** Rekord `worker`, rozszerzony `SERVED`, rozdzielanie `SetConnectorAccess`,
   audyt, listy workerów wszystkich komputerów w ustawieniach (**0078_config_workers**). Testy: zmiana
   nadpisania instancji workera B z A zapisana tylko w bazie B; częstotliwość CLI workera B; niedostępny B
   daje natychmiastowy błąd i nic nie zostaje zastosowane po powrocie; partner nie może zapisać rekordu
   cudzego workera ani mieszać id; kopia rekordu czytelna offline; edycja ustawień workera przez łącze
   bez Share configuration odrzucona.
7. **Rzeczy z domem tworzone z dowolnego komputera.** `CreateBot` i `CreateSchedule` trasowane według workera
   z pickera; edycja harmonogramów partnera. Bez migracji. Testy: bot utworzony z A na workerze B mieszka
   w bazie B; harmonogram wątku B edytowany z A; odmowa przy niedostępnym domu.

### Weryfikacja wspólnej konfiguracji

Każdy etap dodaje testy integracyjne `tests/integration/config-sync-*.test.ts` opisane w etapach
oraz oczekiwane migracje w `packages/db/test/schema.test.ts` (kaskady do `computer_peers`, unikalność
aliasów, brak `computer_shared_*` po etapie 3). Testy bezpieczeństwa sprawdzają owner scoping, brak wartości
sekretów poza łączem i odrzucanie zapisów rekordów workera spoza domu.
