# Narzędzia automatyzacji agentów

Aktualizacja (2026-11-25). Instalacja i naprawa Agent Desktop na macOS otwierają
kreator brakujących uprawnień na komputerze workera.

Status (2026-11-23): **Settings → Agent tools na iOS i Androidzie obsługuje dostęp, instalacje i ustawienia nowych sesji**.

Status (2026-11-22): **narzędzia, interaktywny Preview z podglądem zmiany viewportu,
automatyczny mini Preview wątku, pełna karta i osobne okno Preview w web/desktop, ikony obu stanów skali
oraz rezerwacje urządzeń z oczekiwaniem, uruchamianiem skonfigurowanych emulatorów
i zbiorczym sprawdzaniem sesji archiwalnych wątków po połączeniu zaimplementowane**.
Przed włączeniem narzędzia z Preview web/desktop pokazuje zakres zgody: narzędzie staje się dostępne agentom na wybranym workerze.
Gdy komputer jest niedostępny, Preview pokazuje przyczynę z jego statusu, również podczas aktualizacji.
Zaległe sprzątanie rezerwacji nie blokuje restartu ani raportu aktualizacji workera.
Katalog Device Preview jest ograniczony do urządzenia sesji lub wolnych,
uruchomionych celów przed rezerwacją; przejściowe pliki klatek używają prywatnego
katalogu cache workera zamiast współdzielonego katalogu tymczasowego.
Desktop Preview zachowuje katalog okien, gdy narzędzie zgłosi nieprawidłową geometrię okna.
Web/desktop potwierdza klatki po narysowaniu obrazu; odświeżanie metadanych celu
i naprawa kursora historii zachowują działający podgląd.
Osobne okno ponawia pojedynczy nieudany odczyt stanu wątku bez przerywania podglądu.
Aktualizacja (2026-11-24): w web/desktop **Settings → Agent tools → Worker access** grupuje dostęp
i instalacje według narzędzia. Włączenie na połączonym workerze uruchamia potrzebną instalację.
Zakładka **Session defaults** zawiera ustawienia początkowe sesji wspólne dla workerów użytkownika.
Natywny mobile ma ręczny pełnoekranowy Preview Browser/Desktop/Device z wyborem celu,
dotykiem, nawigacją i wpisywaniem tekstu przez Connect z przypiętym TLS. Wszystkie
trzy narzędzia mają stałą belkę zamknięcia i możliwość ukrycia kontrolek.
Browser MCP pozostaje w sesji wątku i działa headless;
Browser, Desktop i Device mają wspólną kontrolę sesji wątku przed autoryzacją,
obejmującą także sesje w krokach batch. Desktop nie udostępnia tworzenia obcej
sesji, globalnego GC sesji ani wykonania na gościu sandbox poza zakresem Preview.
Domyślny cel podglądu podąża za oknem aktywnym lub urządzeniem sesji, a jawny
wybór użytkownika pozostaje przypięty. Subskrypcja zachowuje się po aktualizacji
statusu tego samego workera, a nowy odbiorca
aktywnej grupy dostaje ostatnią klatkę. Zmiana uprawnień bieżącej tury Claude
aktualizuje także autoryzację automatyzacji.
Automatyczny mini Preview zachowuje wybór celu i minimizację per wątek w sesji
klienta, także po nawigacji i ponownym zamontowaniu strony.
Zwijanie i rozwijanie mini Preview używa tego samego przycisku ikonowego z chevronem,
tooltipem i dostępną nazwą; nagłówek zachowuje układ w obu stanach.
Interaktywny Preview dopasowuje cały obraz do szerokości i wysokości panelu.
Pola wymiarów viewportu nie mają przycisków +/−; pasek zawija kontrolki w wąskim panelu.
Uchwyty viewportu leżą poza obrazem; przeciąganie pokazuje lokalną ramkę,
a zmianę rozmiaru wysyła dopiero puszczenie wskaźnika.
Gotowość Desktop wymaga uprawnienia Screen Recording tylko na macOS;
linuksowy stan `unknown` nie blokuje zainstalowanego narzędzia.
Na Windows worker uruchamia bezrozszerzeniowy skrypt Node pakietu Desktop przez Node.js
i zapisuje przyczynę nieudanego sprawdzenia wersji w logu instalacji.
Ten opis dotyczy stanu kodu i nie oznacza, że funkcja jest już w wydanym buildzie.
Dostępność nightly/beta/stable wynika ze zwykłej promocji wydań
([release.md](release.md)).

Narzędzia pozwalają agentowi wykonywać ograniczony zestaw operacji w lokalnej
przeglądarce, aplikacji desktopowej albo urządzeniu/symulatorze workera. Gateway
autoryzuje dostęp, a program zawsze uruchamia worker na swojej maszynie. Gateway
nie wykonuje binarki ani inferencji. Użytkownik obserwuje i bezpośrednio steruje
tą sesją przez Preview wątku; zatwierdzone wywołania mogą dodatkowo uruchomić
automatyczny mini Preview tylko do odczytu pod podsumowaniem.

## Przypięte narzędzia

| Narzędzie | Wersja | Zakres |
|---|---:|---|
| `agent-browser` | `0.43.0` | strony i elementy przeglądarki |
| `agent-desktop` | `1.3.1` | aplikacje, okna i elementy pulpitu |
| `agent-device` | `0.21.37` | urządzenia, emulatory i symulatory |

Worker obsługuje `open`, `snapshot`, `screenshot`, `click`, `fill`, `type`,
`press` i `close`. Adapter sprawdza gramatykę każdego narzędzia osobno; wartości
użytkownika są argumentami procesu, nie fragmentami komendy shell.

Oryginalne materiały opisują pełny zakres i lokalne wymagania narzędzi:

| Narzędzie | Możliwości i przygotowanie po stronie użytkownika |
|---|---|
| [`agent-browser`](https://github.com/vercel-labs/agent-browser) | Nawigacja, accessibility snapshot, refs i akcje przeglądarki; [instalacja](https://agent-browser.dev/installation) pobiera Chrome for Testing, a [streaming](https://agent-browser.dev/streaming) opisuje upstreamowy WebSocket. |
| [`agent-desktop`](https://github.com/vercel-labs/agent-desktop) | Accessibility tree aplikacji i refs okien; [instalacja](https://agent-browser.dev/desktop/installation) oraz [strony platform](https://agent-browser.dev/desktop/platforms/macos) opisują macOS, Windows i Linux. Użytkownik musi zapewnić sesję GUI oraz OS Accessibility i Screen Recording tam, gdzie wymaga ich platforma. |
| [`agent-device`](https://github.com/callstack/agent-device) | Accessibility snapshot i sterowanie iOS, Android, web oraz innymi obsługiwanymi celami; [installation](https://agent-device.dev/docs/installation), [capabilities](https://agent-device.dev/docs/capabilities) i [agent setup](https://agent-device.dev/docs/agent-setup) opisują wymagane SDK. Zależnie od celu użytkownik przygotowuje Xcode/`simctl`/`devicectl`, Android SDK/ADB, emulator lub symulator oraz odpowiednie konto, signing i uprawnienia. |

Te wymagania są lokalne dla komputera użytkownika. Canopy ich nie instaluje
poza opcjonalnym Chrome for Testing i nie może nadać workerowi uprawnień OS.

## Domyślne ustawienia sesji

Settings → Agent tools → Session defaults zapisuje ustawienia użytkownika,
wspólne dla jego workerów. Każda karta ma własne Save defaults i Reset defaults;
reset przygotowuje wartości fabryczne, a Save defaults je zapisuje. Formularz
zachowuje szkic po nieudanym zapisie. Ustawienia nie nadają dostępu do narzędzia
ani nie rozpoczynają instalacji.

- **Browser:** początkowy viewport (gotowe rozmiary albo własna para szerokość/wysokość
  320–8192 px) i preferencja kolorów stron: domyślna, jasna, ciemna lub brak preferencji.
  Worker sprawdza natywną sesję i stosuje wartości tylko przed pierwszym aktywnym,
  autoryzowanym użyciem przeglądarki. Odczyt katalogu MCP i bierne Preview nie otwierają
  przeglądarki. Istniejąca sesja zachowuje wymiary i wygląd, także po odtworzeniu bridge’a
  lub restarcie workera; ręczna zmiana w Preview i późniejsze wybory agenta pozostają.
- **Desktop:** domyślna aplikacja dla wywołań, które obsługują argument `app`
  i nie wskazują jawnie aplikacji, okna ani referencji elementu. Preview używa jej
  jako początkowego filtra celu, zachowując jawny wybór okna. Rozmiar pochodzi
  z rzeczywistego okna lub ekranu; ustawienie nie zmienia rozdzielczości monitora.
- **Device:** preferowana platforma (dowolna, iOS, Android lub Apple), zgoda na
  uruchamianie skonfigurowanych emulatorów/symulatorów (domyślnie tak) i oczekiwanie
  na urządzenie 1–240 s (domyślnie 60 s). Jawny cel agenta ma pierwszeństwo,
  a istniejąca rezerwacja zachowuje urządzenie. Bierne Preview nie uruchamia emulatora
  i nie oczekuje na jego dostępność. Rozmiar obrazu wynika z wybranego urządzenia.

Gateway waliduje i wersjonuje sekcję `UserSettings.agent_tool_defaults` w istniejącym
magazynie ustawień. Synchronizacja konfiguracji połączonych komputerów obejmuje
również reset pól opcjonalnych. Gateway przekazuje wartości użytkownika w addytywnych
polach `ThreadSpec.agent_tool_defaults` i `StartAgentPreview.agent_tool_defaults`;
worker nie otrzymuje ich od modelu i nie odczytuje z ustawień obcego właściciela.
Brak ustawień zachowuje dotychczasowe zachowanie. Starszy worker pomija nowe pola.

## Wykrywanie, instalacja i gotowość

Worker najpierw wyszukuje istniejącą binarkę w swoim środowisku oraz w swoim
zarządzanym katalogu danych. **Każda używana binarka musi zgłaszać dokładnie
przypiętą wersję**; wywołania modelu i `RunAgentTool` wymagają również gotowości.
Nieprawidłowa wersja znaleziona w PATH nie jest używana ani modyfikowana;
właściciel może zainstalować właściwą wersję w zarządzanym prefiksie workera.
Ponowna instalacja w tym prefiksie może zastąpić jego wcześniejszą, błędną wersję.

Jeśli narzędzia brakuje albo wymaga przygotowania, właściciel może
uruchomić instalację per worker w **Settings → Agent tools**.
Zakładka zawiera niezależnie rozwijane karty **Agent Browser**, **Agent Desktop**
i **Agent Device**. Każda pokazuje workery, wersje, gotowość, instalację lub
aktualizację i log na żądanie. Przełącznik w nagłówku zbiorczo zmienia dostęp
na dostępnych workerach; stan pośredni (kreska na środku) oznacza mieszane granty.
Licznik obejmuje wszystkie widoczne workery, także offline i tylko do odczytu;
niedostępne cele pozostają widoczne i nie są pomijane w podsumowaniu stanu.

Włączenie dostępu na połączonym workerze rozpoczyna instalację brakującej
lub niezgodnej binarki; Browser przygotowuje także swój runtime, gdy nie jest gotowy.
Grant zapisuje się po potwierdzeniu startu przez worker, bez czekania na koniec
instalacji. Trwająca instalacja nie jest uruchamiana ponownie. Brak instalatora
lub raportu i odmowa startu pozostawiają poprzedni grant; błąd jest przy workerze.
Gotowa binarka nie jest reinstalowana. Właściciel może włączyć dostęp do zgodnej
wersji Desktop lub Device przed zakończeniem konfiguracji uprawnień lub SDK.
Nie ma kolejki instalacji po ponownym połączeniu: włączanie wymaga dostępnego
workera i jego komputera. Lokalny grant można wyłączyć również offline.
Operacja zbiorcza zachowuje wyniki i błędy osobno dla każdego workera.

Instalator używa `npm` z prywatnym prefiksem workera i działa jako użytkownik
usługi workera; nie instaluje pakietu systemowo. Dla `agent-browser` przycisk
instalacji może również wykonać instalację Chrome for Testing. Na Windows worker
odczytuje wpis `bin` z manifestu pakietu zamiast wykonywać shim npm `.cmd`.
Rozpoznaje też bezrozszerzeniowy skrypt Node po nagłówku `#!/usr/bin/env node`
i używa tego samego sposobu uruchamiania podczas weryfikacji i pracy narzędzia. Instalacja kończy
się dopiero po sprawdzeniu wersji i gotowości runtime'u.
Instalator dopuszcza skrypt instalacyjny wyłącznie wybranego pakietu przez
`--allow-scripts=<package>`; obsługuje też politykę skryptów npm 11.

Jeśli na macOS brakuje Accessibility lub Screen Recording, worker uruchamia
`agent-desktop permissions --guide`. Kreator otwiera odpowiedni panel Ustawień
systemowych w sesji graficznej workera i wskazuje użytkownikowi aplikację, której
trzeba udzielić dostępu. W Canopy zainstalowane narzędzie ma stan **Needs setup**.
**Repair tool** lub **Retry install** po wcześniejszej nieudanej instalacji
ponawia uruchomienie kreatora na zgodnej, zainstalowanej wersji.
Użytkownik może też nadać uprawnienia w Ustawieniach systemowych na tym Macu.
Po nadaniu uprawnień **Check tools** potwierdza gotowość.

Gotowość jest raportowana przez `agent-tools` na podstawie rzeczywistego stanu
runtime'u:

- `agent-browser doctor --offline --json` musi potwierdzić udane uruchomienie
  przeglądarki;
- `agent-desktop status` musi potwierdzić właściwy system, sesję graficzną
  i Accessibility. Na macOS musi także potwierdzić Screen Recording (albo stan
  `not_required`); na Linuksie i Windows pole może mieć stan `unknown`, ponieważ
  te systemy nie mają tego uprawnienia TCC;
- `agent-device doctor --json` musi potwierdzić urządzenie dla wybranej
  platformy. Sprawdzane są także zależności zgłaszane przez doctor, na przykład
  Xcode, ADB, emulator albo symulator, gdy dana platforma ich wymaga.

Sam plik binarki, numer wersji ani znacznik instalacji nie wystarczają do stanu
Ready. Szczegół błędu pochodzi z badania workera i jest redagowany przed
wysłaniem do gatewaya. Obsługiwane są Linux, macOS i Windows na `x64` oraz
`arm64`; pozostałe platformy pozostają niedostępne.

Worker przechowuje wynik gotowości przez 30 sekund, a wynik negatywny przez
5 sekund. Klucz cache obejmuje narzędzie, sesję, platformę, identyfikator
urządzenia oraz tożsamość pliku wykonywalnego; zastąpienie lub usunięcie pliku
unieważnia wpis. **Check tools** wymusza nowe probe. Worker bada wszystkie trzy
narzędzia równolegle z ograniczonym dopuszczaniem pracy, a gateway odświeża
wiele workerów w partiach najwyżej po cztery.

## Grant workera i uprawnienia tury

Każde narzędzie ma osobny, jawny przełącznik dostępu przy workerze w Settings →
Agent tools. Domyślnie jest wyłączony. Sama obecność lub gotowość binarki nie daje
agentowi dostępu. Grant jest zapisany dla konkretnego workera i właściciela;
wyłączenie go usuwa narzędzie z kolejnych `ThreadSpec`.

Gateway dołącza do wątku gotowe i przyznane identyfikatory narzędzi. Device jest
wyjątkiem od gotowości celu: przyznana, zainstalowana binarka w przypiętej wersji,
poza trwającą instalacją, udostępnia MCP także bez uruchomionego urządzenia.
Pozwala to odkryć cele i zaczekać na rezerwację albo uruchomić emulator.
Zwykłe `RunAgentTool` nadal wymaga gotowości; samo MCP przy wykonywaniu operacji
sprawdza rezerwację i rzeczywiste urządzenie.
Przy każdym wywołaniu MCP worker wysyła do gatewaya wewnętrzne żądanie
autoryzacji. Gateway sprawdza właściciela, workera przypiętego do wątku, bieżącą
turę i jej `turn_id`, stan archiwizacji/cofania, aktualny grant oraz wygaśnięcie
żądania. Grant nie jest trwałą zgodą do odtworzenia i nie trafia do dziennika.

| Tryb uprawnień tury | Wywołanie automatyzacji |
|---|---|
| `READ_ONLY` | zawsze odrzucone |
| `ASK` | karta zgody w UI dla każdego wywołania |
| `ACCEPT_EDITS` | karta zgody dla automatyzacji; tryb nie daje jej automatycznego wyjątku |
| `FULL_AUTO` | dozwolone po przejściu grantu workera i kontroli bieżącej tury |
| `FULL_ACCESS` | dozwolone po przejściu grantu workera i kontroli bieżącej tury |

Odpowiedź odmowna wraca do modelu jako błąd i nie jest ponawiana automatycznie.
`FULL_AUTO` i `FULL_ACCESS` nie omijają przełącznika workera ani kontroli
właściciela, tury i wygaśnięcia.

Podczas `UpdateTurnPermissions` bieżącej tury Claude autoryzacja czeka na
potwierdzenie i trwały zapis zastosowanego trybu. Przejście na `FULL_ACCESS`
rozstrzyga oczekujące zgody automatyzacji tej tury, nadal sprawdzając aktualny
grant, właściciela i żywe łącze. `FULL_AUTO` również zwalnia taką zgodę przez
bridge po ponownym sprawdzeniu trybu i grantu. Nie rozstrzyga pytań ani formularzy.
Szczegóły i ograniczenia pozostałych harnessów: [protocol.md](protocol.md#modele-effort-i-steer).

## Wspólny bridge MCP na workerze

Worker udostępnia narzędzia automatyzacji wątkom Claude, Codexa, Groka i Antigravity.

1. Gateway przekazuje do `ThreadSpec` wyłącznie nazwy gotowych narzędzi.
2. Worker rozwiązuje przypiętą binarkę i uruchamia jej serwer MCP przez stdio.
3. Worker wystawia prywatny endpoint Streamable HTTP na loopbackie, z losowym
   bearerem osobno dla każdego serwera.
4. Harness dostaje endpoint i wywołuje go w swojej sesji. Bridge każdorazowo
   kieruje autoryzację do gatewaya, a dopiero potem przekazuje call przez stdio.

Sesja MCP jest wyprowadzana z `threadId` i pozostaje prywatna dla tego wątku.
Wszystkie trzy descriptory niosą ten sam workerowy zakres `scope` (narzędzie
i znormalizowana sesja wątku), niezależny od env procesu. Wspólna polityka
bridge'a sprawdza `session` przed autoryzacją każdego wywołania, odrzuca obcą
sesję i podaje agentowi jednakową instrukcję, by pominął ten argument. Katalog
ogranicza pole `session` do sesji wątku tylko tam, gdzie upstream je obsługuje.
Zamknięcie sesji harnessu lub zmiana katalogu narzędzi zamyka bridge. Dla
`agent-browser` i `agent-desktop` worker przekazuje sesję jako `--session`.
Browser MCP nie przekazuje jednak tej wartości swoim kolejnym child calls, więc
worker dodaje także opcjonalne `AGENT_BROWSER_SESSION` w descriptor env.
Desktop przekazuje startupowe `--session` przez `forwarded_globals` i nie wymaga
dodatkowego env. Jego MCP nie obsługuje pola `session` w zwykłych wywołaniach,
więc bridge nie dodaje go do argumentów upstream. Przypina jednak `session`
każdego wpisu w `desktop_batch.commands_json` i `id` operacji `session end`,
także w batch. Nie udostępnia `session start`, które zawsze tworzy nowe ID,
globalnego `session gc` ani `sandbox exec`, które pomija startupowe flagi
i działa na gościu niewidocznym w Preview hosta. Bezpośrednie wywołania tych
operacji i ich odpowiedniki batch są odrzucane przed autoryzacją.
`agent-device mcp` otrzymuje argument `mcp` i nie dostaje
`--session`; worker przekazuje mu identyfikator w descriptor env jako
`AGENT_DEVICE_SESSION`. Bridge dodatkowo przypina `session` w argumentach każdego
wywołania Browser/Device MCP, w tym w `input` kroków Device `batch`.
Sam domyślny env nie wystarcza: jawna nazwa sesji mogłaby odłączyć automatyzację
od Preview, które zawsze używa sesji wątku.
Device nie udostępnia `test`, także w batch: runner suite tworzy osobne sesje
każdej próby, niezależnie od przypiętego `session`. Zarządzane MCP nie udostępnia
też `replay`: skrypt może wewnętrznie zmienić cel lub uruchomić albo wyłączyć
urządzenie z pominięciem rezerwacji. Kroki skryptu należy wykonywać osobnymi
wywołaniami narzędzi albo przez `batch`; zmiany cyklu życia urządzenia, `close`
i zagnieżdżone batch są w batch odrzucane.
Bridge obsługuje dokładnie te dwa opcjonalne klucze env,
usuwa ich ambient/base wartości i kopiuje tylko wartości z descriptora. Zmienne
sesji dotyczą wyłącznie odpowiedniego procesu. UUID-y wątku pozostają bez zmian.
Inna bezpieczna wartość długości do 64 znaków także pozostaje bez zmian;
niebezpieczna albo dłuższa wartość staje się `canopy-` oraz pierwszymi 32
znakami hex SHA-256 oryginału. Ta sama funkcja normalizacji obowiązuje w panelu
i MCP.

Archiwizacja zamyka bridge MCP i podglądy przed zwolnieniem sesji narzędzi.
Worker blokuje nowe wywołania, czeka na operacje w toku i wykonuje sprzątanie
wyłącznie dla deterministycznej sesji wątku: Browser zamyka przeglądarkę,
Desktop wyłącza jej cursor overlay, a Device zamyka sesję i należące do niej
helpery oraz zarządzaną przeglądarkę. Desktop nie dostaje trwałego `session end`,
więc ten sam wątek może ponownie korzystać z automatyzacji po przywróceniu.
Rezerwacja Device jest zwalniana po zamknięciu jego sesji; emulator lub symulator
uruchomiony przez pulę workera jest wtedy wyłączany. Wspólny daemon Device oraz
aplikacje i sesje innych wątków pozostają dostępne.
Po połączeniu worker sprawdza sesje narzędzi dla grupy zamkniętych wątków
i zwalnia zasoby pasujących sesji. Przy kolejnym połączeniu ten sam proces ponawia
sprzątanie wątków, dla których poprzednia próba się nie powiodła.
Historia i artefakty na dysku są zachowane. Sprawdzenia istniejących sesji nie
uruchamiają nieużywanego daemona; brak obsługiwanej binarki albo błąd zamykania
ograniczają możliwość zwolnienia zasobów natywnych. Błąd wykonanej operacji
sprzątania pozostawia trwałe polecenie do ponowienia.

Przywrócenie wątku odblokowuje wywołania, ale nie uruchamia żadnej binarki,
podglądu ani zatrzymanego zadania. Kolejne rzeczywiste wywołanie tworzy potrzebne
zasoby od nowa; sesja przeglądarki nie odtwarza automatycznie zamkniętych kart.

Środowisko procesu narzędzia jest czyszczone przez `toolEnvironment`, a Node
jest dodawany do `PATH`: `CANOPY_*` oraz rozpoznane zmienne sekretów są usuwane,
więc klucze modelu i klucze proxy nie są przekazywane do `agent-browser`,
`agent-desktop` ani `agent-device`. Stderr procesu nie jest przekazywany do
modelu.

Browser MCP jest przypięty do sesji wyprowadzonej z id wątku. Bridge odrzuca
nadpisanie `session`, `namespace` lub headed przez agenta, a do każdego
wywołania, które może uruchomić przeglądarkę, dodaje jawne `--headed false`;
`open` i `doctor` używają odpowiednio `headed: false`. Dzięki temu lokalna
konfiguracja `agent-browser` nie otwiera zwykłego okna na pulpicie użytkownika,
a aktywność agenta pozostaje widoczna w Preview tego samego wątku.
`close` zamyka wyłącznie sesję bieżącego wątku; `all: true` i `--all` w
`extraArgs` są odrzucane, aby nie zamknąć przeglądarek innych wątków.
Katalog MCP i błędy wywołań wyjaśniają agentowi, że jest to stałe ograniczenie,
którego nie należy obchodzić przez shell/CLI, CDP, inną przeglądarkę ani kolejne
próby nadpisania. Karty współdzielą stan logowania; jeśli zadanie wymaga sesji
różnych użytkowników, agent ma wyjaśnić ograniczenie użytkownikowi.

Sąsiedni MCP na loopbackie nie jest publicznym listenerem workera. Endpoint,
bearer, liczba żądań, czas oczekiwania, katalog narzędzi i rozmiary odpowiedzi
mają limity; narzędzie nie może zmienić komendy ani środowiska procesu.

Żądanie i odpowiedź HTTP MCP mają limit 6 MiB, deadline HTTP wynosi 300 sekund,
połączenie i zwykłe wywołanie procesu stdio mają deadline 60 sekund,
a wywołanie Device — 90 sekund. Zarządzane oczekiwanie na rezerwację używa
własnego limitu do 240 sekund w ramach deadline HTTP. Anulowanie rezerwacji
zwraca wynik od razu; już wysłany start urządzenia ma osobny, skończony deadline,
a worker czeka na jego wynik i sprząta urządzenie po potwierdzeniu tożsamości. Bridge
przekazuje upstreamowe bloki odpowiedzi wraz z ich MIME, zamiast zamieniać je na
lokalny format obrazu. Jeden endpoint przyjmuje najwyżej 32 oczekujące RPC,
a bridge najwyżej 64 aktywne ciała żądań łącznie. Timer deadline i listenery
anulowania są usuwane po zakończeniu żądania.

## Rezerwacje urządzeń i emulatory

Wszystkie harnessy wątków, `RunAgentTool` i Preview korzystają ze wspólnej puli rezerwacji workera. Urządzenie należy wyłącznie do jednego wątku;
różne wątki nie mogą wysyłać na nie równoległych gestów ani przejmować jego celu.
Pula korzysta z lokalnego daemona przez socket i natywnych identyfikatorów AVD
lub symulatora. Odrzuca zdalne adresy daemona oraz identyfikatory dostawców
chmurowych. Niestandardowe pluginy dostawców nie są obsługiwane: format inventory
nie pozwala odróżnić ich urządzeń, jeśli podszywają się pod natywny identyfikator.

- `acquire_device` czeka na wolny cel: domyślnie 60 sekund, maksymalnie
  240 sekund (`timeoutMs`). Można podać `platform` i nazwę lub ID w `device`.
  Anulowanie wywołania, zamknięcie bridge'a albo archiwizacja przerywa oczekiwanie.
- Domyślne `boot: true` pozwala uruchomić kolejny już skonfigurowany Android AVD
  albo symulator iOS, gdy pasujące uruchomione urządzenia są zajęte. Worker
  uruchamia najwyżej dwa własne urządzenia wirtualne równocześnie. Nie tworzy
  obrazów, nie instaluje SDK i nie klonuje urządzeń. `boot: false` tylko rezerwuje
  już uruchomiony cel. Brak konfiguracji lub wymaganych SDK jest błędem.
- Kolejne operacje używają rezerwacji bez konieczności powtarzania selektora.
  Jawny inny cel jest błędem; trzeba najpierw zwolnić bieżący.
  `batch` przypina wszystkie kroki do tego samego urządzenia. Preview i zwykłe
  operacje mogą zarezerwować wolny, uruchomiony cel bez oczekiwania w kolejce;
  zajęty cel zgłasza błąd zamiast przejąć urządzenie innego wątku.
- `release_device` zamyka sesję Device i zwalnia rezerwację po zakończeniu
  operacji w toku. `shutdown` w MCP ma tę samą semantykę i dotyczy wyłącznie
  rezerwacji bieżącego wątku. Emulator uruchomiony wcześniej przez użytkownika
  oraz urządzenie fizyczne nie są wyłączane przez pulę.
- Pięć minut bez wywołań lub aktywnego Preview zwalnia rezerwację i wyłącza
  własną instancję. Operacja w toku wstrzymuje ten licznik. Archiwizacja
  zwalnia ją od razu po anulowaniu oczekujących wywołań i opróżnieniu operacji;
  zatrzymanie workera również sprząta jego instancje.

Worker zapisuje rezerwacje i własność uruchamianych instancji atomowo w swoim katalogu danych,
przed startem i ponownie po uzyskaniu identyfikatora działającego urządzenia.
Po restarcie zamyka zapisane sesje rezerwacji, także na urządzeniach fizycznych
i instancjach uruchomionych wcześniej przez użytkownika, a wyłącza tylko własne
urządzenia wirtualne. Robi to przed nowymi rezerwacjami. Nieudane sprzątanie zachowuje wpis do ponowienia; nie zwalnia
w ciemno urządzenia trzymanego przez inną sesję. Wąskie okno awarii podczas
startu Android AVD może pozostawić tylko nazwę konfiguracji, bez serialu
uruchomionej instancji. Worker zachowuje wtedy błąd i zapis własności zamiast
zgadywać, który proces wyłączyć. Nawet chwilowy brak działającego AVD nie
potwierdza zakończenia opóźnionego startu w daemonie; taki niejednoznaczny wpis
wymaga wyjaśnienia przed zwolnieniem rezerwacji.
Worker może w tym czasie uruchomić się ponownie i obsługiwać zwykłe tury.
Nie jest to gwarancja sprzątania przy niedostępnych SDK lub uszkodzonej binarce.

## Instalacja i dostęp w Settings → Agent tools

Zakładka **Agent tools** grupuje narzędzia, a wewnątrz ich kart pokazuje workery.
Udostępnia wersję, gotowość, ścieżkę, redagowany log instalacji i przełączniki
dostępu per worker oraz zbiorczo. **Check tools** ponawia badanie na wszystkich
dostępnych workerach, także na połączonych komputerach. Web i desktop przez BFF,
a telefon przez sparowane połączenie Connect wysyłają identyfikator każdego
workera, aby gateway kierował żądanie do jego komputera.

Sterowanie należy do wątku, którego worker i sesja wyznaczają zakres podglądu.

## Interaktywny Preview wątku

W web/desktop prawy panel łączy **Files** i **Preview**. Preview wybiera
**Browser**, **Desktop** albo **Device** i pokazuje kompaktowy wybór celu;
Browser ma adres oraz `Back`/`Forward`/`Reload page`. Użytkownik działa bezpośrednio
na obrazie myszą, klawiaturą i gestami. Kliknięcie przejmuje fokus klawiatury,
tekst obsługuje IME i wklejanie, a Escape zwalnia sterowanie i przenosi fokus
na obraz. Zmiana rozmiaru, dopasowanie i pełny ekran nie tworzą kolejnej sesji;
na wąskim ekranie panel otwiera arkusz na cały ekran. `Open in tab` przenosi Preview
do głównego obszaru wątku, a `Open in sidebar` przywraca panel. Oba widoki dzielą
narzędzie, cel i tryb skali. `Open in new window` otwiera samodzielny podgląd
tego samego wątku z bieżącymi ustawieniami podglądu. Desktop otwiera natywne
okno, a web prosi przeglądarkę o okno popup. Widoczne podglądy korzystają
z tego samego BFF oraz z dotychczasowych reguł dostępu i limitów strumieni.
Osobne okno pobiera metadane bieżącego wątku krótkimi odczytami, aby potwierdzenia
klatek i wejście nie czekały na połączenie zajęte przez drugi strumień SSE.
Powiększenie podglądu w osobnym oknie wypełnia jego wnętrze i pozostawia dostępną
zmianę rozmiaru okna.
Zakładka podglądu pliku nadal działa niezależnie
([workspace.md](workspace.md#panel-filespreview)).

Tryb `Fit to panel` zachowuje proporcje obrazu i dopasowuje go do obu wymiarów
dostępnego obszaru, bez powiększania ponad rozmiar klatki. Zmiana szerokości
sidebara, wysokości okna lub wejście na pełny ekran przelicza skalę tak, aby
cały viewport pozostawał widoczny, z miejscem na uchwyty zmiany rozmiaru.
`Show actual size` pokazuje klatkę w skali 1:1 i pozwala przewijać ją od każdej
krawędzi. Ikona skali zmienia się ze strzałek na zewnątrz na strzałki do środka,
a przycisk pełnego ekranu pokazuje inną ikonę po rozwinięciu. Skalowanie obrazu nie
zmienia viewportu przeglądarki; współrzędne sterowania i uchwyty odnoszą się do widocznego obrazu po przeskalowaniu.

Uchwyty zmiany viewportu to cienkie kreski poza obrazem, z większym przezroczystym
obszarem chwytania. Podczas przeciągania dowolnej krawędzi obraz zachowuje rozmiar,
a lokalna ramka pokazuje docelowy prostokąt i wymiary w stałej skali z początku gestu.
Dotyczy to zarówno zmniejszania, jak i powiększania. Dopiero puszczenie wskaźnika
wysyła jedno `Resize`, jeśli rozmiar się zmienił. Escape, utrata fokusu okna,
anulowanie gestu lub utrata przechwycenia wskaźnika odrzucają podgląd bez wysyłania
zmiany. Strzałki na uchwycie nadal zmieniają rozmiar od razu (16 px, z Shift 64 px).

Pola `Viewport width` i `Viewport height` pozwalają wpisać wymiary bez przycisków
+/−. Klawiaturowe strzałki nadal zmieniają wartość o jeden. `Apply` zachowuje
jawną zmianę viewportu i dotychczasowy zakres 1–8192 px. Przy mniejszej szerokości
komunikat o sterowaniu i kontrolki przechodzą do kolejnego wiersza zamiast znikać
poza krawędzią panelu; oba pola i `Apply` pozostają dostępne.

| Widok | Obraz i wybór celu | Sterowanie i ograniczenia |
|---|---|---|
| Browser | Natywny WebSocket `agent-browser` dla sesji Chrome wątku; przekazuje listę kart i pozwala wybrać aktywną kartę w pasku Preview. | Pointer, przyciski, kółko, klawisze i tekst przez natywny strumień; nawigacja oraz przełączanie kart przez CLI. Preview nie zmienia viewportu przy zmianie szerokości panelu; pola `Width` i `Height` oraz uchwyty krawędzi wysyłają jawne `Resize`, a ich wartości są niezależne od rozmiaru panelu. Zamknięcie Preview zwalnia jego WebSocket i utworzony przez niego stream, zachowując sesję agenta. |
| Desktop | Współdzielona, anulowalna pętla zrzutów; domyślny cel podąża za aktywnym oknem. Jawny wybór okna pozostaje przypięty; filtr aplikacji może wybrać jej jedyne dostępne okno także bez fokusu. | Kliknięcie i przeciągnięcie są atomowymi operacjami po puszczeniu przycisku; drag obsługuje tylko przycisk główny. Backend nie utrzymuje wciśniętej myszy ani klawisza. Klawisze używają `press`, tekst — świeżego refa aktywnego pola accessibility i `type`, bez schowka systemowego. |
| Device | Współdzielona, anulowalna pętla zrzutów; domyślny cel podąża za urządzeniem sesji wątku albo jedynym dostępnym, zgodnym z platformą. Jawny wybór urządzenia pozostaje przypięty w granicach sesji; alias `apple` dopasowuje iOS i macOS. | Tap i swipe głównym wskaźnikiem po puszczeniu, kierunkowy scroll oraz `type`. Enter/Back/Home działają według możliwości backendu; edycję klawiaturą Android opisano niżej. Skróty z modyfikatorami zwracają jawny błąd. |

Katalog Device Preview pokazuje wyłącznie urządzenie bieżącej sesji lub rezerwacji
wątku. Przed rezerwacją udostępnia wolne cele zgodne z wybraną platformą; pomija
wyłączone emulatory i symulatory, urządzenia zajęte przez inne sesje daemona oraz
obce rezerwacje puli workera. Rezerwacje są sprawdzane przy każdym odświeżeniu,
także zanim daemon zgłosi sesję i podczas jej zwalniania. Jawny selektor nie
przywraca obcego urządzenia do katalogu. Odczyt katalogu nie rezerwuje ani nie
uruchamia urządzenia; rzeczywiste przechwycenie i wejście nadal wymagają
wyłącznej rezerwacji w puli, więc zmiana dostępności po odczycie katalogu nie
pozwala przejąć cudzego celu.

Samo otwarcie Browser Preview nie uruchamia przeglądarki ani nie nawiguje.
Bez działającej przeglądarki sesji podgląd czeka na agenta; użytkownik może ją
uruchomić jawną nawigacją przez pole adresu interaktywnego panelu. Ta nawigacja
oraz jednorazowe `RunAgentTool.open` także uruchamiają Browser headless.

Desktop Preview traktuje nieprawidłową geometrię z `list-windows`, w tym zerową
szerokość lub wysokość, jako brak współrzędnych danego okna. Zrzuty nadal są
pobierane dla wybranego okna według jego identyfikatora, a wymiary obrazu logicznego
mogą pochodzić z metadanych zrzutu. Sterowanie wskaźnikiem wymaga prawidłowych
globalnych współrzędnych okna. Jeśli ich brakuje, backend zwraca błąd operacji.

Android obsługuje także niemodyfikowane Backspace, Delete (usuwanie do przodu),
Tab, strzałki, End i PageUp/PageDown przez stałą listę kodów już zainstalowanego ADB,
po sprawdzeniu dokładnie wybranego urządzenia/serialu. Home pozostaje
przyciskiem systemowym urządzenia. Klawisze edycji z tej listy są niedostępne
na iOS/Apple; tekst nadal korzysta z `type`. Pozostałe nieobsługiwane klawisze
dają jawny błąd zamiast pozornego powodzenia. Błąd pojedynczej operacji zwalnia
wejście tylko tego odbiorcy i pozwala dalej korzystać z podglądu.

Desktop i Device przesyłają kolejne obrazy, nie wideo. Worker pobiera obraz
lokalnie. Klatki i wejście przechodzą przez istniejący
WorkerLink → gateway → BFF; BFF wysyła SSE do klienta. Przeglądarka użytkownika
nie dostaje bezpośredniego URL ani portu strumienia zdalnego workera.
Web/desktop żąda `client_ack`: po dekodowaniu i narysowaniu obrazu na canvasie
potwierdza `frame_id` przez `AckAgentPreview`. Dopiero to potwierdzenie zwalnia
następną klatkę workera. Wolny klient nie zbiera kolejki starych obrazów w BFF
ani w transporcie; worker zachowuje tylko najnowszą oczekującą klatkę.
Canvas zachowuje poprzedni obraz do narysowania następnego. Natywny mobile
i starsi klienci bez `client_ack` zachowują potwierdzenie przy odbiorze gRPC.
Utrata lub zmiana celu Desktop/Device odrzuca i potwierdza nieaktualną klatkę
także przed jej narysowaniem, aby zwolnić transmisję obrazu nowego celu.

Gateway wyprowadza sesję z właściciela i wątku, wymaga aktualnego grantu
narzędzia i capability `agent_preview_v1`. Browser i Desktop wymagają Ready.
Device może otworzyć katalog przed Ready, gdy `agent-device` jest zainstalowany
w dokładnej wersji `0.21.37`, ma grant i nie trwa jego instalacja. Doctor może
nie wskazać gotowości przy kilku urządzeniach lub braku aktywnej sesji, dlatego
użytkownik wybiera cel w katalogu. Worker sprawdza wybrany backend przy
odczycie katalogu i rzeczywistych komendach. Ten wyjątek dotyczy wyłącznie
interaktywnego podglądu; model/MCP i jednorazowy `RunAgentTool` nadal wymagają Ready.

Sterowanie użytkownika nie wymaga aktywnej tury modelu; grant oraz stan wątku
są sprawdzane przy wejściu i w trakcie transmisji. Ukrycie/zamknięcie Preview,
zmiana wątku, tło klienta, utrata dostępu, odebranie grantu albo zerwanie łącza
anulują pracę i zwalniają wejście. Sesja jest przypięta do konkretnego
WorkerLink i nie jest odtwarzana po jego wymianie. Limity klatek, ACK,
dzierżawy i partii wejścia: [protocol.md](protocol.md#interaktywny-podgląd-wątku).

Natywny mobile otwiera ręcznie pełnoekranowy `Preview` z nagłówka wątku. Odbiera maks.
5 klatek/s bez trwałego zapisu, wybiera cel i wysyła tap/drag, scroll, tekst oraz
nawigację przez ten sam gateway. Zmiana zakresu, zamknięcie i tło aplikacji
anulują subskrypcję oraz zwalniają wejście. Kontrolki dostosowują się do małej
wysokości i klawiatury. Mobile nie ma automatycznego mini Preview ani zmiany
wymiarów viewportu; szczegóły: [mobile.md](mobile.md#podgląd-automatyzacji-i-limity-kont).

## Automatyczny mini Preview

Rzeczywiste wywołanie lokalnego MCP `agent-browser`, `agent-device` albo
`agent-desktop` przez wspólny bridge po przejściu istniejącej autoryzacji powoduje
publikację typowanej `ThreadUpdate.change = automationActivity` do żywych
obserwatorów bieżącego wątku. Zdarzenie identyfikuje aktywność, turę, narzędzie, workera i
bezpieczny cel; nie niesie surowych argumentów, URL-i, tekstu wejściowego,
ścieżek ani sesji wybranej przez klienta.
Wszyscy dostawcy korzystają z tej samej ścieżki. Aktywność jest przejściowa:
nie trafia do transkryptu, snapshotu, journala, lustra ani replayu i nie jest
odtwarzana z historii przy nowej stronie, przeładowaniu ani catch-upie.

Browser zawsze pokazuje aktywną kartę wspólnej sesji wątku. Dla Device bridge
rozpoznaje jawną platformę i UDID/serial, a dla Desktop — jawne, znane selektory
aplikacji lub `window_id` z operacji odczytu i przechwytywania. Prywatnego okna
ukrytego za kwalifikowanym refem nie można wywnioskować; puste selektory używają
bieżącego lub domyślnego celu sesji. Jawna obca sesja albo nieobsługiwane
nadpisanie sesji w wywołaniu MCP powodują pominięcie sygnału.

Strona, która aktualnie obserwuje wątek, podąża za ostatnią zatwierdzoną aktywnością.
Pod podsumowaniem wątku pokazuje mini Preview tylko do odczytu, z limitem 4 klatek
na sekundę, bez sterowania myszką lub klawiaturą i bez zmiany viewportu. Mini czeka na przeglądarkę
agenta, bez jej uruchamiania ani automatycznej nawigacji. Używa istniejących
limitów i autoryzacji Preview, a po kolejnych wywołaniach zmienia narzędzie i
bezpieczny cel na najnowsze wartości. Aktywności dla tego samego zakresu zachowują
działający stream; aktualizacja statusu tego samego workera także go zachowuje.
Zakres subskrypcji jest porównywany po wartościach identyfikujących cel, bez
tożsamości obiektu, etykiety i pozostałych metadanych. Reset kursora podczas
naprawy historii usuwa jej cache, ale zachowuje wybór mini Preview i jego
działającą subskrypcję. Usunięcie prywatnej kopii wątku nadal czyści oba stany.
Nowy odbiorca aktywnej grupy Preview od razu dostaje jej ostatnią klatkę, bez
czekania na zmianę obrazu. Grupa trzyma tylko jedną ograniczoną klatkę w pamięci;
zmiana celu, utrata celu Desktop/Device i zamknięcie grupy ją usuwają.
Klient pamięta ostatni wybór wynikający z zaobserwowanej, zatwierdzonej aktywności
i minimizację osobno dla maksymalnie 32 ostatnio odwiedzanych wątków. Powrót do
wątku przywraca te metadane także po ponownym zamontowaniu strony lub wymianie
obiektu stanu transkryptu; kolejne aktywności nie cofają minimizacji. Aktywność
obecna przy pierwszej obserwacji jest nadal sygnałem odebranym na żywo, nie
odtworzeniem historii. Cache nie przechowuje klatek ani nie trafia do storage;
przeładowanie klienta, usunięcie jego kopii wątku lub zmiana zakresu dostępu
usuwa odpowiednie wpisy. Zmiana przypisanego workera, archiwizacja i usunięcie
wątku również odrzucają wybór. Przywrócenie celu nie omija bieżącego grantu,
gotowości narzędzia ani autoryzacji gatewaya; watch wznawia się z nową klatką.
Sam sygnał nigdy nie przejmuje fokusu.

Nagłówek mini Preview ma stałe miejsca na zwijanie/rozwijanie oraz `Open in sidebar`.
Ten sam przycisk pokazuje chevron w dół przy rozwiniętym podglądzie i w górę przy
zwiniętym. Tooltip i dostępna nazwa to odpowiednio `Minimize preview` i `Restore preview`;
`aria-expanded` odzwierciedla stan obrazu. Przełączenie zachowuje fokus na przycisku.

`Open in sidebar` przekazuje ten sam wątek, narzędzie, bezpieczny cel i sesję wątku
do większego, interaktywnego Preview, przenosi fokus na jego pasek narzędzi i
zatrzymuje mini Preview na czas jego widoczności.
Zamknięcie sidebara przywraca mini Preview, chyba że użytkownik je zminimalizował.
Ukrycie strony lub mini Preview, przejście offline, odebranie grantu, archiwizacja
wątku albo utrata właściwego połączenia zatrzymują watch i usuwają jego przejściową
klatkę.

## Obrazy i trwałość

Klatki Preview są przejściowe: nie tworzą itemu, outboxa, journala, lustra
ani trwałej galerii. Desktop/Device tworzą prywatny katalog przechwytywania
dopiero przy pierwszym zrzucie, w systemowym cache użytkownika workera
(Linux respektuje bezwzględny `XDG_CACHE_HOME`). Nie używają współdzielonego
katalogu tymczasowego, którego limit użytkownika może blokować zapis mimo
wolnego miejsca pokazywanego przez system plików (`EDQUOT`, errno 122 na Linuksie).
Plik PNG jest usuwany bezpośrednio po odczycie, także po błędzie polecenia lub
odczytu; zamknięcie backendu usuwa jego prywatny katalog. Sam katalog celów
nie tworzy plików klatek. Zamknięcie podglądu usuwa jego obraz z klienta.

Modelowy MCP ma inną ścieżkę. Wynik native MCP trafia do transcriptu providera
i jest zapisywany w journalu. Jeśli wynik zawiera obraz, worker zapisuje blob w
`PreviewStore` przed zapisaniem zdarzenia; obraz jest dostępny jako preview
itemu narzędzia z zachowanym MIME. Obejmuje to ekstrakcję obrazów z Claude,
Codexa i Groka. Grok rozpoznaje opakowane bloki ACP oraz `rawOutput` jako obiekt,
envelope albo JSON string, wiąże je z `toolCallId`, deduplikuje wspólną treść i
scala wcześniejsze patche obrazu przy końcowym itemie, także gdy końcowa
aktualizacja status-only nie zawiera `content` ani `rawOutput`. Limit mostka
wynosi tu 6 MiB; bridge nie zmienia upstreamowych bloków na ręczny format PNG.
Oryginalne aktualizacje ACP pozostają byte-for-byte w `rawJson`. Gdy zakończenie
dziedziczy brakujące obrazy z wcześniejszych patchy, mapper zachowuje oryginalny
patch jako zdarzenie raw-only i dodaje syntetyczne `itemCompleted` dla
`PreviewStore`; robi to tylko wtedy, gdy scalony stan ma więcej obrazów inline
niż oryginalne zakończenie. To trwały preview transcriptu,
lecz nie tworzy automatycznie itemu `image_gallery`.

Końcową, trwałą galerię model publikuje przez `show_images`; import jawnego
obrazu Markdown używa tego samego pipeline'u załączników. `view_image` służy do
oglądania obrazu przez model. Szczegółowe granice trwałości i storage opisuje
[agent-visuals.md](agent-visuals.md).

## Połączone komputery

Worker, granty i binarki należą do gatewaya domu właściciela. Dla workera na
połączonym komputerze żądanie jest trasowane do tego domu i jego workera;
gateway komputera wywołującego nie uruchamia lokalnej binarki ani nie zastępuje
grantu domu. Niedostępny dom wyłącza wykonanie, a nie usuwa zapisanej konfiguracji
i historii. Szczegóły routingu: [linked-computers.md](linked-computers.md).
`WatchAgentPreview` i wejście są trasowane według kwalifikowanego id wątku;
dom sam wyprowadza lokalną sesję. Identyfikatory podglądu, okien i urządzeń
pozostają literalne, także gdy UDID symulatora ma postać UUID. Klatki nie
wchodzą do lustra i nie są dostępne offline.

Powiązane kontrakty i implementacje:

- [architecture.md](architecture.md) — role gatewaya, workera i linked computers;
- [protocol.md](protocol.md) — capability `agent_tools_v1`/`agent_preview_v1`, raporty i transport;
- [worker-config.md](worker-config.md) — ustawienia workera i środowisko;
- [ui-api.md](ui-api.md) — RPC oraz endpointy BFF;
- [claude-adapter.md](claude-adapter.md), [codex-adapter.md](codex-adapter.md),
  [grok-adapter.md](grok-adapter.md) — podpięcie wspólnego bridge'a do harnessów.
