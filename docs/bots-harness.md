# Boty przez oficjalne harnessy

Boty nie korzystają już z bezpośredniego API modelu (dawny wariant B). Canopy
nie wysyła żadnych żądań inferencji HTTP. Claude działa przez Agent SDK i oficjalny
`claude`, Codex przez oficjalny `codex app-server`, Grok przez CLI i adapter ACP.
CLIProxyAPI jest dopuszczalne wyłącznie jako połączenie skonfigurowanej instancji
harnessu. Nie kopiujemy tokenów subskrypcji do gatewaya.

## Miejsce wykonania i instancje

Bot ma ustawienie **Runs on**: jeden worker dostępny właścicielowi. Domyślnie
wybieramy własny worker desktopu, jeżeli obsługuje instancję; w pozostałych
przypadkach pierwszy online z włączoną instancją. Po wyborze przypięcie jest trwałe.
Wyłączona instancja daje czytelny błąd; worker offline nie unieważnia przypięcia
i nie powoduje fallbacku do API. UI pokazuje **Waiting for ‹worker›**.

Przy tworzeniu picker obejmuje również workery wszystkich połączonych komputerów. Wybrany komputer
staje się domem bota: gateway trasuje utworzenie do niego, a rozmowa i wykonanie pozostają tam.
Share configuration nie jest wymagane. Niedostępny dom daje od razu błąd, bez kolejki utworzeń.
Późniejsza edycja, archiwizacja i usuwanie z innego komputera wracają do domu. Zmiana Runs on
istniejącego bota wybiera worker w jego domu; zmianę domu obsługuje przenoszenie bota.

Nie robimy automatycznego failoveru. Ta sama globalna instancja na dwóch workerach
może używać innych kont, wersji CLI i proxy. Ręczna zmiana Runs on dotyczy następnej
tury, odtwarza kontekst z gatewaya i nie przenosi plików ani danych logowania.
Rozpoczęta tura pozostaje przypięta do swojego workera.

Device login i Proxy są równorzędne. Model oraz effort pochodzą z katalogu
wybranego workera i instancji, łącznie z modelami własnymi. Alias Claude jest
poprawnym wyborem harnessu; nie stosujemy do niego ograniczeń API. Zmiana wyglądu
nie wymaga dostępnego workera ani zmiany modelu.

## Sesja i kontekst

Rozmowa bota ma ukrytą sesję harnessu, bez sztucznego projektu lub wątku w UI.
Worker trzyma prywatny home i pusty scratch pod swoim data dir, oddzielnie dla
bota oraz pary harness/instancja. Udostępnia tylko login wskazanej instancji,
bez ustawień, pluginów, skilli i instrukcji katalogu użytkownika. Nie przyjmuje
ścieżki projektu z komendy bota.

Procesy botów Codexa i Groka dostają także prywatne `HOME`, `USERPROFILE` i katalogi
XDG oraz prywatne `CODEX_HOME` i `CLAUDE_CONFIG_DIR`, również dla zgodności między CLI.
Samo `CODEX_HOME` nie izoluje `~/.agents/skills`. Codex ma dodatkowo
`skills.include_instructions=false`, `skills.bundled.enabled=false` i
`features.skip_host_skill_discovery=true`; flaga katalogu modelu
`include_skills_usage_instructions` nie zastępuje tych ustawień.
Zmiana izolacji unieważnia cache sesji, żeby odbudowa usunęła wcześniejszy
kontekst skilli z transkryptu harnessu. Wątki zachowują swoje skille i instrukcje.

Claude zachowuje `HOME`, `USERPROFILE` i XDG procesu workera; izoluje wyłącznie
`CLAUDE_CONFIG_DIR`. `settingSources: []`, puste pluginy i własny system prompt
usuwają instrukcje i skille użytkownika także bez zmiany HOME, co sprawdza
przechwycenie żądania CLI z zasianym katalogiem użytkownika. Nie zmieniamy HOME,
żeby nie wpływać na odkrywanie loginu i macOS Keychain; nie jest to deklaracja
sprawdzenia rzeczywistego logowania na macOS.

Codex także na macOS odczytuje plik `auth.json` spod `CODEX_HOME`. Bot jawnie
ustawia `cli_auth_credentials_store="file"` i dowiązuje tylko ten plik z katalogu
logowania wybranej instancji; zmiana HOME nie zmienia źródła ani dowiązania.
Konfiguracja instancji nie jest kopiowana. Magazyny `keyring` i `auto` są osobnymi
trybami CLI: bezpośredni wpis keyringu jest identyfikowany hashem kanonicznego
`CODEX_HOME`. Samo zachowanie HOME nie przeniosłoby takiego wpisu do prywatnego
`CODEX_HOME` bota. Obecna integracja wymaga loginu dostępnego jako `auth.json`
albo proxy; nie eksportuje wpisów Keychain/keyringu. Login istniejący wyłącznie
w keyringu był już ograniczeniem izolowanego `CODEX_HOME`, przed tą poprawką.

Grok przechowuje login w `auth.json`; `GROK_AUTH_PATH` jest jawną, bezwzględną
ścieżką do tego pliku w katalogu logowania wybranej instancji, również na macOS.
Worker wybiera źródło przed uruchomieniem CLI. Prywatne `GROK_HOME` służy
konfiguracji procesu i sesjom, a prywatne HOME nie zmienia `GROK_AUTH_PATH`.
Nie kopiujemy pozostałych plików katalogu użytkownika. Proxy przekazuje klucz
w środowisku zamiast używać loginu plikowego.

Claude zapisuje sesję i wznawia ją przez `resume`, Codex przez `thread/resume`,
Grok przez `session/load`. Identyfikator sesji jest cache'em. Transkrypt
gatewaya pozostaje źródłem prawdy, także dla rutyn i handoffów. Nowa sesja dostaje
historię jako jawnie oznaczone dane oraz bieżące instrukcje, czas i tożsamość modelu.
Zaginiona lub przeniesiona sesja jest odbudowywana bez powtarzania narzędzi z historii.
Wznowienie dostaje nowe wejście i aktualny kontekst. Zmiana zestawu narzędzi wymaga
nowej sesji, żeby odebrany grant nie pozostał w katalogu harnessu.

Nie dodajemy osobnego wywołania modelu do streszczania. Długą rozmowę kompaktuje
harness, tak jak w wątkach: Claude Agent SDK automatycznie, Codex według
`auto_compact_token_limit` z katalogu modelu bota, Grok według własnego limitu CLI.

Przy odbudowie obowiązują istniejące granice historii bota (ostatnie 60 wiadomości
dla rutyn, notatka handoffu) oraz budżet historii. Harness nie skompaktuje pierwszego
wejścia, które już się nie mieści. Dlatego gateway daje historii około połowy okna
kontekstu, liczonego ostrożnie: 3 znaki na token. Katalog workera nie podaje okna
modelu, więc gateway przyjmuje 128k tokenów, mniej niż każdy obsługiwany model.
Gdy historia jest dłuższa, idą najnowsze wiadomości, które się mieszczą, a przed nimi
wpis `canopy_note` z liczbą pominiętych wiadomości. Bieżące wejście nigdy nie jest
pomijane ani obcinane. Transkrypt gatewaya pozostaje pełny.

Codex: `model_catalog_json` zastępuje metadane modelu, a Codex wylicza z nich próg
kompakcji. Worker czyta prawdziwy wpis modelu przez `codex debug models` z tym samym
plikiem wykonywalnym, środowiskiem i `CODEX_HOME` co app-server bota (`model/list` nie
podaje okna). Katalog bota zachowuje okno, limit kompakcji i `truncation_policy` tego
wpisu; bez limitu ustawia jawnie 90% okna, jak Codex. Bez wpisu (model tylko z proxy,
błąd CLI) używa 128k okna i 100k limitu. Instrukcje bazowe są neutralne; prompt
systemowy bota idzie w `baseInstructions` wątku. Generowanie tytułów ma osobny,
minimalny katalog (`codexTextCatalog`).

## Narzędzia i granica bezpieczeństwa

Bot nie dostaje Bash, shella, odczytu/zapisu plików, obrazu lokalnego, web fetch,
wyszukiwania, natywnych subagentów, celów ani harmonogramu harnessu. Read-only
sandbox jest drugą warstwą, nie dowodem usunięcia narzędzi.

Claude: `tools: []`, `settingSources: []`, `strictMcpConfig`, wyłączone hooki,
puste pluginy, własny system prompt i allowlista konkretnych `mcp__canopy__*`.
Serwer ma `alwaysLoad: true`, bez odroczonego wyszukiwania narzędzi.
Zgody na akcje MCP egzekwuje gateway. Codex: katalog bota nadpisuje we wpisie modelu
wszystko, co dodaje narzędzia: `shell_type: disabled`, bez patcha, eksperymentalnych
narzędzi, `tool_mode` innego niż `direct`, multi-agenta, wyszukiwania narzędzi,
node REPL, `model_messages` i responses-lite (schematy zostają w polu `tools`).
Do tego wyłączenia wspólne z `codexTextOverrides`, read-only, sieć sandboxa wyłączona, approvals `never`,
brak dokumentów projektu. Konfiguracja MCP zawiera wyłącznie serwer Canopy.
Codex zachowuje funkcje transportu MCP `list_mcp_resources`,
`list_mcp_resource_templates` i `read_mcp_resource`; serwer bota nie udostępnia
zasobów. Nie dają one dostępu do lokalnych plików. Dowodem izolacji obu CLI
jest przechwycona lista schematów w `apps/worker/src/bots/isolation.test.ts`.
Boty używają executable, środowiska i logowania instancji, ale pomijają jej
launch args: dowolne flagi mogłyby dołączyć lokalne narzędzia lub obcy MCP.
Grok używa curated profilu z `tools: search_tool, use_tool` i takiej samej allowlisty
`--tools`, bez launch args i skilli instancji. Pozostaje tylko transport Canopy MCP;
callbacki ACP odmawiają każdego lokalnego uprawnienia. Przechwycenie schematów
prawdziwego CLI jest częścią `isolation.test.ts`, obok Claude i Codexa.

Serwer MCP Canopy na workerze jest transportem schematów i wywołań, a nie
wykonawcą akcji. Schematy istniejących `bots/tools/*` i przyznanych connectorów
przychodzą bez poświadczeń. Wywołanie MCP staje się `AgentToolCall` z odrębnym
identyfikatorem bota i tury. Gateway sprawdza przypięcie workera, właściciela,
aktywną turę i lease, a następnie wywołuje istniejący `runToolCall`.
Worker nie może podać innego bota przez zwykłe `thread_id`.

Zachowujemy `BotStore.action`, zatwierdzenia, pytania, limit hops, audyt,
deduplikację i kontrolę grantów connectorów. Model nie dostaje credentiali.
Historyczny wynik narzędzia nigdy nie jest upoważnieniem do nowej akcji.

## Trwałość i prezentacja

`bot_turns` nadal serializuje rozmowę. Komenda wykonania jest zapisana w istniejącym
`worker_commands` przed wysyłką i ma trwały identyfikator. Jej payload nie zawiera
sekretów ani ścieżek projektów. Odpowiedzi komend deduplikuje journal Workera.
Zdarzenia bota używają lokalnego journala i ACK po commicie gatewaya, oddzielnie
od tabel wątków. Zapisane `event_id` eliminują podwójny tekst po reconnect.

Przy przerwie sieci proces harnessu może kontynuować; oczekujące wywołanie szyny
jest ponawiane z tym samym call id. Zgoda/pytanie pozostają w Postgresie. Odpowiedź
udzielona offline jest odczytana po powrocie łącza. Restart gatewaya przejmuje lease
i dołącza do tej samej komendy; nie rozpoczyna drugiej generacji. Restart workera
odczytuje zapisany transkrypt harnessu, jak dla tur wątków. Zapisany koniec wygrywa;
bez niego tura kończy się jako przerwana przez system. Nie odtwarzamy automatycznie
niepewnych efektów MCP. Przerwanie/anulowanie unieważnia możliwość nowych efektów.

Istniejący snapshot rozmowy dostaje tekst bieżącej odpowiedzi i status, bez
technicznych itemów narzędzi. Rutyny i handoffy zachowują niewidoczność. Końcowa
odpowiedź ma jeden wpis czatu. Błąd używa `TurnOutcome`, `TurnEndSource` i
`error_code`, tak jak wątki. Boty korzystają z `classifyFailure` i wspólnego
wiersza błędu wątków. `TurnFinished.error_class` zachowuje klasę przed usunięciem
prozy providera. Kody końca Claude i `codexErrorCode` pozostają w journalu
i gatewayu; UI dostaje klasę i bezpieczny komunikat, bez endpointów i stderr.
Oczekiwanie na zgodę lub offline nie ma limitu czasu generacji.
Takie tury utrzymują lease, ale nie zajmują limitu czterech aktywnych inferencji
gatewaya; pozostałe boty mogą odpowiadać podczas oczekiwania.

Claude mapuje tekst tym samym mapperem bloków co wątki: ukończony blok zastępuje
swój strumień, także gdy poprzedzało go rozumowanie lub narzędzie. Indeks bloku
w częściowej wiadomości `assistant` nie jest indeksem bloku strumienia.

## Migracja i zgodność

Migracje `0070_bot_harness.sql` i `0071_bot_harness_errors.sql` zachowują historię
botów, identyfikatory, rutyny, wakeupy i handoffy. Pierwsza następna tura
wybiera/pamięta worker i tworzy sesję z historią. Przenoszenie sesji API nie jest
potrzebne, bo wcześniej nie istniały.

Proto rozszerzamy addytywnie. `bot_harness_v1` negocjuje nową funkcję; starszy
worker nie dostanie komendy. `WORKER_LINK_PROTOCOL` i zamrożone
`canopy.update.v1` pozostają bez zmian.

## Audyt inferencji

Przeszukanie produkcyjnego kodu po endpointach `messages`, `responses`,
`chat/completions`, klientach Anthropic/OpenAI i metodach inferencji wykazało:

| Miejsce | Obecne zachowanie | Docelowe działanie |
| --- | --- | --- |
| Gateway botów | Wyłącznie worker/harness; `model.ts` usunięty | Brak bezpośrednich wywołań |
| `apps/worker/src/providers/grok/generate-text.ts` | Krótkotrwały Grok CLI/ACP dla tytułów | Brak bezpośrednich wywołań |
| `apps/worker/src/providers/generate-text.ts` | Izolowane oficjalne Claude SDK/Codex | Wzorzec izolacji do ponownego użycia |
| Testy przechwytujące HTTP | Kontrolowany endpoint modelu | To fixtures harnessów, nie runtime inferencji Canopy |

`Test connection` proxy wykonuje tylko `GET /v1/models`, a katalogi mogą również
czytać `/v1beta/models`. To nie są wywołania LLM i pozostają dozwolone.
`tools/direct-inference.test.ts` skanuje źródła aplikacji i pakietów poza testami,
fixtures i wygenerowanym kodem. Endpointy inferencji oraz klienci HTTP SDK powodują
błąd CI; generowanie tytułów nie ma wyjątku.

## Testy

`bots-harness-errors.test.ts` sprawdza przez WorkerLink i kontrolowane CLI każdą
klasę awarii Claude/Codex/Grok, brak pliku wykonywalnego i skuteczne ponowienie,
wyłączenie instancji przypiętego workera oraz brak sekretów w zapisie i snapshotach.
`bots-harness-regressions.test.ts` obejmuje rutyny, wakeupy, ukryte handoffy bez
narzędzi, granty i zgody MCP przez gateway, tworzenie Groka oraz wiele wzmianek
i wiadomości bot–bot. `bots-harness-defaults.test.ts` sprawdza wybór desktop/server
i trwałość przypięcia. `bots-harness-context.test.ts` sprawdza limity w katalogu
Codexa bota oraz odbudowę długiej rozmowy w budżecie: najnowsze wiadomości, notatkę
o pominięciu, całe bieżące wejście i pełny transkrypt. `codex-catalog.test.ts`
sprawdza z prawdziwym CLI, że Codex odczytuje okno i limit z katalogu bota. Dotychczasowy `bots-harness.test.ts` nadal obejmuje offline,
reconnect, restarty, owner scoping i izolację.
`linked-agent-messages.test.ts` łączy dwa gatewaye i kontrolowany harness bota:
sprawdza autora oraz treść wiadomości i steerów, czytelny event zakończenia,
wznowienie bota i pojedynczy tekst po strumieniu z blokiem rozumowania.

Poprawione regresje: `create_bot` odrzucał jawny wybór Groka mimo poprawnego schematu;
awaria startu instancji Codexa mogła przerwać obsługę konfiguracji WorkerLink.
Błąd SDK Claude w wiadomości assistant jest błędem tury, a nie tekstem odpowiedzi.

Desktop ładuje wspólny web UI, a aplikacja mobilna używa tego samego UI API
i snapshotów rozmowy; zmiana runtime'u nie wymaga nowego transportu klienta.
Repozytorium nie implementuje kanałów Telegram/Discord/WhatsApp dla botów.
Opt-in testy live (`CANOPY_LIVE=1`) nie mają wpisanych hostów ani kluczy.
