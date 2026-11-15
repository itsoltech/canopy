# Narzędzia automatyzacji agentów

Status (2026-11-15): **zaimplementowane; gotowe do udostępnienia w następnym
nightly**. Ten opis dotyczy stanu kodu i nie oznacza, że funkcja jest już w
wydanym buildzie. Po nightly obowiązuje zwykła promocja do beta i stable
([release.md](release.md)).

Narzędzia pozwalają agentowi wykonywać ograniczony zestaw operacji w lokalnej
przeglądarce, aplikacji desktopowej albo urządzeniu/symulatorze workera. Gateway
autoryzuje dostęp, a program zawsze uruchamia worker na swojej maszynie. Gateway
nie wykonuje binarki ani inferencji.

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
zarządzanym katalogu danych. **Każda binarka musi zgłaszać dokładnie przypiętą
wersję** i przejść sprawdzenie gotowości. Nieprawidłowa wersja znaleziona w PATH
nie jest używana ani modyfikowana; właściciel może zainstalować właściwą wersję
w zarządzanym prefiksie workera. Ponowna instalacja w tym prefiksie może zastąpić
jego wcześniejszą, błędną wersję.

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

Sąsiedni MCP na loopbackie nie jest publicznym listenerem workera. Endpoint,
bearer, liczba żądań, czas oczekiwania, katalog narzędzi i rozmiary odpowiedzi
mają limity; narzędzie nie może zmienić komendy ani środowiska procesu.

Żądanie i odpowiedź HTTP MCP mają limit 6 MiB, deadline HTTP wynosi 300 sekund,
a każde połączenie i wywołanie procesu stdio ma deadline 60 sekund. Bridge
przekazuje upstreamowe bloki odpowiedzi wraz z ich MIME, zamiast zamieniać je na
lokalny format obrazu. Jeden endpoint przyjmuje najwyżej 32 oczekujące RPC,
a bridge najwyżej 64 aktywne ciała żądań łącznie. Timer deadline i listenery
anulowania są usuwane po zakończeniu żądania.

## Sterowanie w Settings → Workers

Panel **Automation tools** pokazuje wykrycie, wersję, gotowość, ścieżkę,
redagowany log instalacji i przełącznik dostępu dla każdego narzędzia. **Check
tools** ponawia badanie na wybranym workerze.

Po przygotowaniu narzędzia panel **Manual controls** pozwala:

- wpisać pustą sesję domyślną albo `threadId` sesji agenta;
- otworzyć stronę lub aplikację, odczytać `snapshot` i wykonać `screenshot`;
- wybrać akcję oraz ref elementu lub tekst (`click`, `fill`, `type`, `close`);
- dla przeglądarki i desktopu podać klawisz lub skrót dla `press`; dla device
  `press` jest akcją na ref, a `type` pisze do bieżącego pola;
- dla desktopu wskazać aplikację i `window_id`;
- dla urządzenia wskazać `device_id` oraz platformę, na przykład iOS,
  Android albo Web.

Desktopowe akcje na ref (`click`, `fill`, `type`) wymagają kwalifikowanego refa
ze snapshotu i nie przyjmują `app` ani `window_id`, ponieważ ref przypina
właściwe okno. Odczyt, zrzut oraz skrót klawiszowy przyjmują aplikację lub okno;
otwieranie i zamykanie wymagają aplikacji bez selektora okna.

Podgląd pokazuje ostatni zrzut i ma opcjonalny auto-refresh co trzy sekundy.
Odświeżanie działa tylko wtedy, gdy panel i karta aplikacji są widoczne,
połączenie jest online i worker jest dostępny; po ukryciu panelu pauzuje.
To podgląd z kolejnych screenshotów, nie transmisja wideo. Możliwym późniejszym
kierunkiem jest upstreamowy WebSocket streaming `agent-browser`; natywne live
streaming wskaźnika/pointera pozostaje poza tym zakresem i wymaga osobnej decyzji.

## Obrazy i trwałość

Ręczny **RunAgentTool** w Settings → Workers zwraca pojedynczy PNG inline,
ograniczony do 4 MiB; tekst wyjścia ma limit 512 KiB. Wynik panelu jest
przejściowy: nie tworzy itemu, outboxa, journala ani trwałej galerii, a plik
tymczasowy jest usuwany po odczycie.

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
Kwalifikowany identyfikator wątku wpisany jako sesja jest tłumaczony na lokalny
identyfikator w domu. Identyfikatory okien i urządzeń pozostają literalne,
także gdy UDID symulatora ma postać UUID.

Powiązane kontrakty i implementacje:

- [architecture.md](architecture.md) — role gatewaya, workera i linked computers;
- [protocol.md](protocol.md) — capability `agent_tools_v1`, raport gotowości i komendy;
- [worker-config.md](worker-config.md) — ustawienia workera i środowisko;
- [ui-api.md](ui-api.md) — RPC oraz endpointy BFF;
- [claude-adapter.md](claude-adapter.md), [codex-adapter.md](codex-adapter.md),
  [grok-adapter.md](grok-adapter.md) — podpięcie wspólnego bridge'a do harnessów.
