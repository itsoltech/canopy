# Narzędzia automatyzacji agentów

Status (2026-11-16): **narzędzia, interaktywny Preview i automatyczny mini Preview
wątku zaimplementowane**. Browser MCP pozostaje w sesji wątku i działa headless;
watch zachowuje się po aktualizacji statusu tego samego workera, a nowy odbiorca
aktywnej grupy dostaje ostatnią klatkę.
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

## Wykrywanie, instalacja i gotowość

Worker najpierw wyszukuje istniejącą binarkę w swoim środowisku oraz w swoim
zarządzanym katalogu danych. **Każda używana binarka musi zgłaszać dokładnie
przypiętą wersję**; wywołania modelu i `RunAgentTool` wymagają również gotowości.
Nieprawidłowa wersja znaleziona w PATH nie jest używana ani modyfikowana;
właściciel może zainstalować właściwą wersję w zarządzanym prefiksie workera.
Ponowna instalacja w tym prefiksie może zastąpić jego wcześniejszą, błędną wersję.

Jeśli narzędzia brakuje albo wymaga przygotowania, właściciel może opcjonalnie
uruchomić instalację per worker w **Settings → Workers → Automation tools**.
Instalator używa `npm` z prywatnym prefiksem workera i działa jako użytkownik
usługi workera; nie instaluje pakietu systemowo. Dla `agent-browser` przycisk
instalacji może również wykonać instalację Chrome for Testing. Instalacja kończy
się dopiero po sprawdzeniu wersji i gotowości runtime'u.
Instalator dopuszcza skrypt instalacyjny wyłącznie wybranego pakietu przez
`--allow-scripts=<package>`; obsługuje też politykę skryptów npm 11.

Gotowość jest raportowana przez `agent-tools` na podstawie rzeczywistego stanu
runtime'u:

- `agent-browser doctor --offline --json` musi potwierdzić udane uruchomienie
  przeglądarki;
- `agent-desktop status` musi potwierdzić właściwy system, sesję graficzną,
  Accessibility oraz Screen Recording (albo stan `not_required`);
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

Każde narzędzie ma osobny, jawny przełącznik **Allow agent access** w Settings →
Workers. Domyślnie jest wyłączony. Sama obecność lub gotowość binarki nie daje
agentowi dostępu. Grant jest zapisany dla konkretnego workera i właściciela;
wyłączenie go usuwa narzędzie z kolejnych `ThreadSpec`.

Gateway dołącza do wątku wyłącznie gotowe i przyznane identyfikatory narzędzi.
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

## Wspólny bridge MCP na workerze

Claude, Codex i Grok korzystają z tego samego mechanizmu workera:

1. Gateway przekazuje do `ThreadSpec` wyłącznie nazwy gotowych narzędzi.
2. Worker rozwiązuje przypiętą binarkę i uruchamia jej serwer MCP przez stdio.
3. Worker wystawia prywatny endpoint Streamable HTTP na loopbackie, z losowym
   bearerem osobno dla każdego serwera.
4. Harness dostaje endpoint i wywołuje go w swojej sesji. Bridge każdorazowo
   kieruje autoryzację do gatewaya, a dopiero potem przekazuje call przez stdio.

Sesja MCP jest wyprowadzana z `threadId` i pozostaje prywatna dla tego wątku.
Zamyka się razem z sesją harnessu albo przy zmianie katalogu narzędzi. Dla
`agent-browser` i `agent-desktop` worker przekazuje sesję jako `--session`.
Browser MCP nie przekazuje jednak tej wartości swoim kolejnym child calls, więc
worker dodaje także opcjonalne `AGENT_BROWSER_SESSION` w descriptor env.
Desktop przekazuje startupowe `--session` przez `forwarded_globals` i nie wymaga
dodatkowego env. `agent-device mcp` otrzymuje argument `mcp` i nie dostaje
`--session`; worker przekazuje mu identyfikator wyłącznie w descriptor env jako
`AGENT_DEVICE_SESSION`. Bridge obsługuje dokładnie te dwa opcjonalne klucze,
usuwa ich ambient/base wartości i kopiuje tylko wartości z descriptora. Zmienne
sesji dotyczą wyłącznie odpowiedniego procesu. UUID-y wątku pozostają bez zmian.
Inna bezpieczna wartość długości do 64 znaków także pozostaje bez zmian;
niebezpieczna albo dłuższa wartość staje się `canopy-` oraz pierwszymi 32
znakami hex SHA-256 oryginału. Ta sama funkcja normalizacji obowiązuje w panelu
i MCP.

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
Katalog MCP i błędy wywołań wyjaśniają agentowi, że jest to stałe ograniczenie,
którego nie należy obchodzić przez shell/CLI, CDP, inną przeglądarkę ani kolejne
próby nadpisania. Karty współdzielą stan logowania; jeśli zadanie wymaga sesji
różnych użytkowników, agent ma wyjaśnić ograniczenie użytkownikowi.

Sąsiedni MCP na loopbackie nie jest publicznym listenerem workera. Endpoint,
bearer, liczba żądań, czas oczekiwania, katalog narzędzi i rozmiary odpowiedzi
mają limity; narzędzie nie może zmienić komendy ani środowiska procesu.

Żądanie i odpowiedź HTTP MCP mają limit 6 MiB, deadline HTTP wynosi 300 sekund,
a każde połączenie i wywołanie procesu stdio ma deadline 60 sekund. Bridge
przekazuje upstreamowe bloki odpowiedzi wraz z ich MIME, zamiast zamieniać je na
lokalny format obrazu. Jeden endpoint przyjmuje najwyżej 32 oczekujące RPC,
a bridge najwyżej 64 aktywne ciała żądań łącznie. Timer deadline i listenery
anulowania są usuwane po zakończeniu żądania.

## Instalacja i dostęp w Settings → Workers

Panel **Automation tools** pokazuje wykrycie, wersję, gotowość, ścieżkę,
redagowany log instalacji i przełącznik dostępu dla każdego narzędzia. **Check
tools** ponawia badanie na wybranym workerze.

Sterowanie należy do wątku, którego worker i sesja wyznaczają zakres podglądu.

## Interaktywny Preview wątku

W web/desktop prawy panel łączy **Files** i **Preview**. Preview wybiera
**Browser**, **Desktop** albo **Device** i pokazuje kompaktowy wybór celu;
Browser ma adres oraz `Back`/`Forward`/`Reload page`. Użytkownik działa bezpośrednio
na obrazie myszą, klawiaturą i gestami. Kliknięcie przejmuje fokus klawiatury,
tekst obsługuje IME i wklejanie, a Escape zwalnia sterowanie i przenosi fokus
na obraz. Zmiana rozmiaru, dopasowanie i pełny ekran nie tworzą kolejnej sesji;
na wąskim ekranie panel otwiera arkusz na cały ekran. Zakładka podglądu pliku
nadal działa niezależnie
([workspace.md](workspace.md#panel-filespreview)).

| Widok | Obraz i wybór celu | Sterowanie i ograniczenia |
|---|---|---|
| Browser | Natywny WebSocket `agent-browser` dla sesji Chrome wątku; automatycznie śledzi aktywną kartę. | Pointer, przyciski, kółko, klawisze i tekst przez natywny strumień; nawigacja przez CLI. Resize ustawia viewport przeglądarki. Zamknięcie Preview zwalnia jego WebSocket i utworzony przez niego stream, zachowując sesję agenta. |
| Desktop | Współdzielona, anulowalna pętla zrzutów; lista okien z domyślnym aktywnym oknem i stabilnym wyborem celu. | Kliknięcie i przeciągnięcie są atomowymi operacjami po puszczeniu przycisku; drag obsługuje tylko przycisk główny. Backend nie utrzymuje wciśniętej myszy ani klawisza. Klawisze używają `press`, tekst — świeżego refa aktywnego pola accessibility i `type`, bez schowka systemowego. |
| Device | Współdzielona, anulowalna pętla zrzutów; domyślnie urządzenie sesji wątku albo jedyne zgodne z platformą. | Tap i swipe głównym wskaźnikiem po puszczeniu, kierunkowy scroll oraz `type`. Enter/Back/Home działają według możliwości backendu; edycję klawiaturą Android opisano niżej. Skróty z modyfikatorami zwracają jawny błąd. |

Samo otwarcie Browser Preview nie uruchamia przeglądarki ani nie nawiguje.
Bez działającej przeglądarki sesji podgląd czeka na agenta; użytkownik może ją
uruchomić jawną nawigacją przez pole adresu interaktywnego panelu. Ta nawigacja
oraz jednorazowe `RunAgentTool.open` także uruchamiają Browser headless.

Sterowanie wskaźnikiem Desktop wymaga globalnych współrzędnych wybranego okna.
Backend zgłasza brak geometrii zamiast wykonywać kliknięcie w innym miejscu.

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

## Automatyczny mini Preview

Rzeczywiste wywołanie lokalnego MCP `agent-browser`, `agent-device` albo
`agent-desktop` przez wspólny bridge po przejściu istniejącej autoryzacji powoduje
publikację typowanej `ThreadUpdate.change = automationActivity` do żywych
obserwatorów bieżącego wątku. Zdarzenie identyfikuje aktywność, turę, narzędzie, workera i
bezpieczny cel; nie niesie surowych argumentów, URL-i, tekstu wejściowego,
ścieżek ani sesji wybranej przez klienta.
Wszyscy dostawcy korzystają z tej samej ścieżki. Aktywność jest przejściowa:
nie trafia do transkryptu, snapshotu, journala, lustra ani replayu i nie jest
odtwarzana przy nowej stronie, przeładowaniu ani catch-upie historii.

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
Nowy odbiorca aktywnej grupy Preview od razu dostaje jej ostatnią klatkę, bez
czekania na zmianę obrazu. Grupa trzyma tylko jedną ograniczoną klatkę w pamięci;
zmiana celu, utrata celu Desktop/Device i zamknięcie grupy ją usuwają.
Minimizacja jest stanem bieżącego wątku na zamontowanej stronie:
kolejne aktywności nie otwierają ponownie mini Preview; zmiana wątku resetuje wybór
i minimizację. Sam sygnał nigdy nie przejmuje fokusu.

`Open in sidebar` przekazuje ten sam wątek, narzędzie, bezpieczny cel i sesję wątku
do większego, interaktywnego Preview, przenosi fokus na jego pasek narzędzi i
zatrzymuje mini Preview na czas jego widoczności.
Zamknięcie sidebara przywraca mini Preview, chyba że użytkownik je zminimalizował.
Ukrycie strony lub mini Preview, przejście offline, odebranie grantu, archiwizacja
wątku albo utrata właściwego połączenia zatrzymują watch i usuwają jego przejściową
klatkę.

## Obrazy i trwałość

Klatki Preview są przejściowe: nie tworzą itemu, outboxa, journala, lustra
ani trwałej galerii. Pliki tymczasowe zrzutów są sprzątane przy zamknięciu backendu;
zamknięcie podglądu usuwa jego obraz z klienta.

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
