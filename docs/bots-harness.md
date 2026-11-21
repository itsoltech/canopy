# Boty przez oficjalne harnessy

Status (2026-11-19): zaimplementowane w kodzie, także zwykłe przyznane narzędzia, izolacja rozmów zewnętrznych
i nietrwałe wejścia do aktywnej tury rozmowy zewnętrznej lub prywatnego czatu.
Wznowienie wywołania narzędzia po restarcie sprawdza jego utrwaloną treść i zakres zgody.
Czat właściciela pokazuje bieżącą czynność bota także podczas tur ze Slacka i rutyn.
Odbiór wiadomości Slack obsługuje pliki, a konektor Slack przekazuje je
do harnessu przez wynik narzędzia. Katalog bota Codex zachowuje obsługę obrazów
dla modeli, które ją deklarują. Pobieranie publicznych plików wysyła stały
`User-Agent: Canopy-Bot`. Prywatne rozmowy i rutyny z Web access mogą czytać
changelogi Canopy według PR-a. Bot Codex po zerwaniu strumienia przez proxy
ponawia krok w tej samej turze z wynikami wykonanych narzędzi. [Limity prób i backoff](proxies.md#ponawianie-kroku-codexa)
Dostępność nightly/beta/stable wynika z promocji wydań ([release.md](release.md)).

Status (2026-11-21): prywatny czat bota ma narzędzie odczytu
`find_canopy_settings` także bez Web access i przy wyłączonym module Threads.
Katalog nawigacji jest osobnym źródłem od wartości zwracanych przez
`get_settings`. [Weryfikacja ścieżek](settings-map.md#odpowiedzi-czatu-o-ustawieniach).
Bot Grok na Linuksie może otwierać i wznawiać sesje zapisane poza katalogiem
tymczasowym workera. [Zakres zapisu sandboxa](grok-adapter.md#boty-izolacja-zapisu-sesji).
Duże wyniki tekstowe narzędzi Canopy bot Claude odczytuje porcjami przez
`read_tool_result` w bieżącej turze.

Status prędkości (2026-11-17): zaimplementowana w kodzie; dostępność
nightly/beta/stable wynika z promocji wydań. Ustawienie **Speed** korzysta z
katalogu modelu, instancji i workera bota. `BotConfiguration.service_tier`
przechowuje wybór, a `RunBotTurn.service_tier` przekazuje go do harnessu.
`default` jawnie wybiera standardową prędkość; pusta wartość pozostawia domyślny
tryb dostawcy. Codex udostępnia tryby konta przez `model/list`, Claude przez
metadane SDK i dostępność Fast. Samo „fast” w nazwie modelu Groka nie oznacza
oddzielnego ustawienia prędkości. Zmiana wyboru obejmuje kolejną turę.

Jawny wybór szybkości, również `default`, wymaga capability `service_tiers_v1`.
Automatyczny wybór **Runs on** pomija workery bez niej; jeśli żaden pasujący
worker nie jest online, bot czeka na worker. Przypięty starszy worker daje
czytelny błąd konfiguracji. Gateway ponownie sprawdza capability przy każdym
dostarczeniu trwałej komendy, także po restarcie lub downgrade workera:
`SERVICE_TIERS_UNSUPPORTED` zapobiega cichemu pominięciu ustawienia. Bot bez
jawnego wyboru szybkości nadal może korzystać ze starszego workera.

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

## Obrazy użytkownika

Pozostałe typy plików wymagają `bot_files_v1` i korzystają z tego samego transferu.
PDF trafia do Claude jako natywny blok dokumentu; Codex i Grok dostają wyciąg
tekstu (bez OCR, do 50 stron). Pliki UTF-8 są tekstem wejścia, do 64 000 znaków
na plik i 128 000 na turę, z notatkami o przycięciu. Pozostałe pliki mają
metadane i referencje do przekazania. Pełna tabela i zasady przekazywania:
[bots.md](bots.md#szkice-i-załączniki-w-rozmowie).

Gateway wiąże obraz z turą bota atomowo z zapisem wiadomości, po sprawdzeniu
właściciela, typu, limitów i braku wcześniejszego powiązania. `RunBotTurn`
przenosi pliki bieżącej wiadomości w `attachments` (12). Pole
`history_attachments` (13) pozostaje w kontrakcie dla zgodności, ale gateway
wysyła je puste, a worker ignoruje jego zawartość od starszego gatewaya. Komenda
z obrazami wymaga capability workera `bot_images_v1`; starszy worker zwraca powód aktualizacji,
zamiast uruchomić turę bez obrazów. Wersja WorkerLink pozostaje 1.

Worker pobiera bajty przez `FetchBlob.bot_id` / `bot_turn_id` (4/5). Dostęp wymaga
aktywnej, trwałej komendy harnessu przypisanej temu workerowi i temu botowi;
plik musi należeć do właściciela bota i do tej samej rozmowy. Zakończona tura
nie uprawnia do pobierania.
Wspólny `AttachmentFiles` sprawdza ścieżkę, rozmiar i SHA-256 przed zapisem.
Ścieżki są wyliczane dla aktualnego workera, również po zmianie Runs on.

Notatka platformy wymienia referencje, nazwy, typy i rozmiary plików. Adapter normalizuje obraz
jak w wątkach i dostarcza bajty natywnie: Claude SDK jako bloki `image` base64,
Codex app-server jako wejścia `image` z data URL, Grok ACP jako bloki `image`.
Grok wymaga `promptCapabilities.image`. Bot nadal nie ma `view_image`, shella
ani czytania dowolnych plików. Po wznowieniu i odbudowie sesji wysyłamy wyłącznie
pliki bieżącej wiadomości. Historia zawiera jedynie referencje dawnych plików
przy ich wiadomościach, z identyfikatorem i czasem UTC oraz jawną etykietą
„references only; not attached to the current input”. Bieżąca wiadomość trafia
osobno do `Current input`, bez powtórzenia w `history_json`.
`list_attachments` pozwala przekazać wcześniejszy plik do wątku. Ponowny
odczyt wymaga nowego załączenia albo pobrania pliku przez konektor Slack.
Przy pobraniu przez konektor worker przekazuje obraz jako wynik MCP,
obsługiwany tekst lub PDF w granicach budżetu albo metadane pliku wraz
z referencją do przekazania. Pobranie używa tego samego FetchBlob.
Poprzednio odbudowa spłaszczała dawne obrazy, dokumenty i tekst plików do jednego
nowego wejścia harnessu, co sugerowało ponowne wysłanie ich przez użytkownika.
Wersja kontekstu załączników w kluczu sesji wymusza jednorazową odbudowę po
aktualizacji workera, usuwając ten mylący kontekst z cache harnessu.
Sekrety połączeń i dane logowania nigdy nie są częścią promptu.

## Sesja i kontekst

`bot_conversations_v1` dodaje `RunBotTurn.conversation_id` (16): UUID rozmowy
zewnętrznej. Puste pole zachowuje dotychczasową prywatną sesję i jej pliki.
Niepuste pole wybiera osobny home harnessu i workspace dla pary bot–rozmowa;
zmiana dostawcy współdzieli pliki tylko wewnątrz tej rozmowy. Retencja obejmuje
również te workspace'y i pomija aktywne rozmowy oraz dowiązania. Gateway musi
odmówić wykonania na workerze bez tej capability i dostarczyć historię oraz
handoff należące wyłącznie do wskazanej rozmowy. Worker nie rozpoznaje pochodzenia
tekstu `history_json`. Journal, pobieranie blobów i autoryzacja MCP nadal używają
rzeczywistego `bot_id` oraz `turn_id`; UUID rozmowy nie zastępuje tożsamości bota.

Zewnętrzna tura dostaje przyznane botowi narzędzia connectorów oraz katalog
narzędzi pracy, w tym odczyty projektów/wątków i `start_thread`/`send_message`.
Web access i Files pochodzą z konfiguracji bota; pliki i referencje załączników
są ograniczone do tej rozmowy. `send_attachment` pozostaje prywatnym dostarczaniem
plików do Canopy i nie występuje w katalogu zewnętrznym. Zmiany konfiguracji
właściciela, bota, rutyn, subskrypcji i grantów oraz odpowiadanie za właściciela
na zgody są niedostępne. Katalog komendy workera, runtime modelu i dyspozytor MCP
korzystają z tej samej polityki gatewaya. Dyspozytor ponownie sprawdza aktualny
grant connectora, aktywność źródła i lease; wyłączenie źródła blokuje nowe narzędzia.
Nie istnieje osobne mapowanie uprawnień kanałów na narzędzia.

System prompt podaje identyfikatory konta, kanału, wątku i rozmowy oraz zapisane
przez właściciela instrukcje subskrypcji. Wiadomości autorów są niezaufanymi danymi
zadania, nie instrukcjami właściciela ani zgodą na zmianę uprawnień.
Prywatna historia i handoff nie trafiają automatycznie do tego promptu.
Polityka zgód i Allowed actions działają jak w zwykłej turze. Karty zgód i pytania
`ask_user` są celowo widoczne w Canopy właściciela z etykietą źródła zewnętrznego;
surowe wiadomości i streaming zewnętrzny nadal są odfiltrowane. Karta pytania
uprzedza, że odpowiedź trafi do modelu wykonującego to zadanie. Slack otrzymuje
wyłącznie końcowy wynik; nie serializujemy tam kart, pytań, odpowiedzi właściciela
ani reguł/grantów. Prompt zabrania ich ujawniania w odpowiedzi modelu.

Rozmowa bota ma ukrytą sesję harnessu, bez sztucznego projektu lub wątku w UI.
Worker trzyma prywatny home pod swoim data dir, oddzielnie dla
rozmowy bota oraz pary harness/instancja. Scratch jest osobny dla rozmowy bota,
wspólny przy zmianie dostawcy, bez dostępu do home harnessu. **Files** (domyślnie
włączone) udostępnia platformowe `list_files`, `read_file`, `write_file` i
`delete_file`, zawsze przez gateway i aktywną turę workera. Nazwy są płaskie,
bez katalogów, traversal i dowiązań; odczyt tekstu ma limit 100 000 bajtów.
Budżet to 200 MiB, 256 plików, 50 MiB na plik; miejsce na zapis atomowy liczy się
przed utworzeniem pliku tymczasowego. Retencja po 7 dniach bezczynności pomija
aktywne sesje, a restart usuwa porzucone zapisy. Natywne narzędzia plikowe
pozostają wyłączone we wszystkich trzech harnessach: ich sandbox workspace
nie gwarantuje ograniczenia odczytu hosta. Worker udostępnia tylko login wskazanej instancji,
bez ustawień, pluginów, skilli i instrukcji katalogu użytkownika. Nie przyjmuje
ścieżki projektu z komendy bota.

Worker przekazuje botowi Claude tekst wyniku MCP większy niż 16 000 bajtów
przez pierwszą porcję i identyfikator wyniku. `read_tool_result` przyjmuje ten
identyfikator oraz `next_offset` z poprzedniej porcji. Tekst pozostaje
w pamięci serwera MCP bieżącej tury, z budżetem 8 MiB na turę i usuwaniem
najstarszych wyników po przekroczeniu budżetu. Pojedynczy wynik ponad 8 MiB
zwraca informację o limicie. Odczyt porcji nie wykonuje ponownie narzędzia
i nie przyjmuje ścieżek plików. Obejmuje tekst odpowiedzi z gatewaya,
np. z `read_thread` i `list_schedules`.

Procesy botów Codexa i Groka dostają także prywatne `HOME`, `USERPROFILE` i katalogi
XDG oraz prywatne `CODEX_HOME` i `CLAUDE_CONFIG_DIR`, również dla zgodności między CLI.
Samo `CODEX_HOME` nie izoluje `~/.agents/skills`. Codex ma dodatkowo
`skills.include_instructions=false`, `skills.bundled.enabled=false` i
`features.skip_host_skill_discovery=true`; flaga katalogu modelu
`include_skills_usage_instructions` nie zastępuje tych ustawień.
Zmiana izolacji unieważnia cache sesji, żeby odbudowa usunęła wcześniejszy
kontekst skilli z transkryptu harnessu. Wątki zachowują swoje skille i instrukcje.

Menedżery wersji zachowują katalogi urządzenia (`MISE_DATA_DIR`, `MISE_CONFIG_DIR`,
`MISE_STATE_DIR`, `MISE_GLOBAL_CONFIG_ROOT`, `ASDF_DATA_DIR`, `VOLTA_HOME`; poza Windows).
Discovery często wybiera shim (np. `~/.local/share/mise/shims/codex`), a launcher CLI może
wołać `node` z PATH. Shim szuka instalacji, ustawień i zaufanych konfiguracji pod HOME/XDG,
więc przy prywatnym HOME kończyłby się od razu, zanim CLI wystartuje. Te katalogi
zawierają wersje narzędzi, nie konfigurację providera.

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
nowej sesji, żeby odebrany grant nie pozostał w katalogu harnessu. Gateway pobiera
narzędzia konektorów z aktualnych grantów przed każdą turą; worker porównuje
fingerprint modelu i pełnych deskryptorów narzędzi. Dodanie konta (także z „All bots”),
nadanie lub odebranie grantu i usunięcie konta wymuszają nową sesję na następnej
wiadomości, jeżeli zmieniają dostępne narzędzia. Rozmowa i identyfikator bota
pozostają te same; zmienia się wyłącznie ukryta sesja harnessu.

### Edycja instrukcji i ustawień

`UpdateBot` zapisuje `BotConfiguration.instructions` w `bots.configuration` w Postgresie.
Runtime odczytuje konfigurację przed rozpoczęciem każdej nowej tury; `RunBotTurn`
przenosi aktualny prompt i historię do workera. Nie jest to cache ustawień UI ani
konfiguracji workera. Wcześniej trwały `session.json` porównywał tylko model,
narzędzia i wersję izolacji. Edycja nazwy lub persony nie zmieniała klucza, więc
restart UI, gatewaya albo workera nadal wybierał tę samą sesję i jej dawny kontekst.

| Harness | Przekazanie instrukcji | Zachowanie po edycji |
| --- | --- | --- |
| Claude | `query.options.systemPrompt`; kontynuacja przez `resume` | Nowy `sessionId`, aktualny system prompt i historia gatewaya |
| Codex | `baseInstructions` w `thread/start` i `thread/resume` | Nowy `thread/start`; nie polegamy na przepisaniu wcześniejszego kontekstu przez override resume |
| Grok | Treść curated profilu `--agent-profile` oraz bieżącego promptu; `session/load` odtwarza sesję | Nowe `session/new` z aktualnym profilem i historią |

Gateway przesyła stabilny SHA-256 nazwy, standing instructions i polityki zgód
w addytywnym `RunBotTurn.configuration_key` (11). Worker włącza go oraz effort
do trwałego fingerprintu obok modelu i pełnych deskryptorów narzędzi. Dla rozmów
zewnętrznych klucz obejmuje także instrukcje i tryb dostarczania trasy komunikatora.
Zmiana tych wartości unieważnia wyłącznie identyfikator ukrytej sesji; następna tura
odbudowuje ją z historii właściwej rozmowy. Sam czas, hops,
treść wiadomości, kolor, kształt i ponowny zapis tych samych ustawień jej nie rotują.
Dostawca/instancja mają osobną przestrzeń sesji; Runs on wybiera workera.
Skille i pluginy urządzenia/biblioteki nadal są wyłączone dla botów.

Nowa sesja korzysta z istniejącej odbudowy: bieżące instrukcje, ostatnia trwała
notatka handoff i historia rozmowy w dotychczasowym budżecie. Nie kasujemy
transkryptów, notatek, rutyn, przypomnień ani watchów i nie wykonujemy narzędzi
z historii. Nie tworzymy drugiego czatu ani dodatkowego wywołania streszczającego.
Odbudowane wejście wskazuje pierwszeństwo bieżących standing instructions przed
sprzecznymi dawnymi instrukcjami lub preferencjami w historii.
Nie przenosimy prywatnego rozumowania harnessu; duża historia nadal podlega
opisanemu niżej budżetowi. Edycja podczas aktywnej tury obowiązuje od następnej
nowo rozpoczynanej tury. Zapisana już komenda zachowuje swój snapshot także po
reconnect i restarcie gatewaya; nie powtarzamy rozpoczętej inferencji.

Pole jest addytywne, więc `WORKER_LINK_PROTOCOL` pozostaje 1, bez migracji bazy.
Starszy worker ignoruje pole i zachowuje dotychczasowe działanie; dla gwarancji
odświeżania trzeba zaktualizować worker. Nowy worker przy komendzie starszego
gatewaya używa pełnego promptu jako klucza awaryjnego: może częściej odbudować
sesję z powodu czasu/kontekstu, ale nie zachowa nieaktualnych instrukcji.
Pierwsza tura po aktualizacji workera odbudowuje też sesje ze starszym formatem
fingerprintu. Nie zmieniamy zamrożonego UpdateService.

Nie dodajemy osobnego wywołania modelu do streszczania. Długą rozmowę kompaktuje
harness, tak jak w wątkach: Claude Agent SDK automatycznie, Codex według
`auto_compact_token_limit` z katalogu modelu bota, Grok według własnego limitu CLI.

Przy odbudowie zwykła tura pobiera całą historię z `store-conversation.ts`, bez limitu
60 wiadomości; ten limit dotyczy tylko rutyn. Handoff zachowuje osobną notatkę.
Następnie obowiązuje budżet historii. Harness nie skompaktuje pierwszego
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
wpisu; bez limitu ustawia jawnie 90% okna, jak Codex. Zachowuje obsługę obrazu
z metadanych modelu, żeby Codex przekazał modelowi obrazy z wiadomości i wyników
MCP. Bez metadanych modalności przyjmuje tekst i obraz, zgodnie z domyślnym
zachowaniem Codexa. Bez wpisu (model tylko z proxy, błąd CLI) używa 128k okna
i 100k limitu. Instrukcje bazowe są neutralne; prompt
systemowy bota idzie w `baseInstructions` wątku. Generowanie tytułów ma osobny,
minimalny katalog (`codexTextCatalog`).

## Narzędzia i granica bezpieczeństwa

Bot nie dostaje Bash, shella, natywnego odczytu/zapisu plików hosta, obrazu lokalnego,
natywnych subagentów, celów ani harmonogramu harnessu. **Web access** jest
domyślnie włączone: Claude dostaje `WebSearch`/`WebFetch`, Codex `web_search=live`,
Grok `web_search`/`web_fetch` w curated profilu i allowliście. Wyłączenie usuwa
te narzędzia i zmienia fingerprint sesji. Handoff zawsze wyłącza dostęp do sieci
i pozostałe narzędzia. Gateway wymaga capability `bot_web_v1`; ustawienie jest
właścicielskie, przechowywane w konfiguracji JSON bez migracji bazy. Read-only
sandbox jest drugą warstwą, nie dowodem usunięcia narzędzi.

Claude: `tools: [WebSearch, WebFetch]` lub `[]`, `settingSources: []`, `strictMcpConfig`, wyłączone hooki,
puste pluginy, własny system prompt i allowlista konkretnych `mcp__canopy__*`.
Serwer ma `alwaysLoad: true`, bez odroczonego wyszukiwania narzędzi.
Zgody na akcje MCP egzekwuje gateway. Codex: katalog bota nadpisuje we wpisie modelu
wszystko, co dodaje narzędzia: `shell_type: disabled`, bez patcha, eksperymentalnych
narzędzi, `tool_mode` innego niż `direct`, multi-agenta, wyszukiwania narzędzi,
node REPL, `model_messages` i responses-lite (schematy zostają w polu `tools`).
Do tego wyłączenia wspólne z `codexTextOverrides`, read-only, sieć sandboxa wyłączona, approvals `never`,
brak dokumentów projektu. Konfiguracja MCP zawiera wyłącznie serwer Canopy.
Ten serwer ma `default_tools_approval_mode="approve"`: wywołanie przechodzi do
gatewaya przy każdej polityce bota, także `safe` i `always`. Bez tego ustawienia
Codex traktuje narzędzia bez adnotacji jako wymagające własnej zgody i przy
`approvalPolicy="never"` odmawia przed wywołaniem MCP. Nie oznaczamy mutacji
jako odczytów. `never` chroni izolację narzędzi natywnych; nie jest polityką bota
ani opcją w jego ustawieniach. Ustawienie trafia również do `thread/resume`.
Codex zachowuje funkcje transportu MCP `list_mcp_resources`,
`list_mcp_resource_templates` i `read_mcp_resource`; serwer bota nie udostępnia
zasobów. Nie dają one dostępu do lokalnych plików. Dowodem izolacji obu CLI
jest przechwycona lista schematów w `apps/worker/src/bots/isolation.test.ts`.
Boty używają executable, środowiska i logowania instancji, ale pomijają jej
launch args: dowolne flagi mogłyby dołączyć lokalne narzędzia lub obcy MCP.
Grok używa curated profilu z `tools: search_tool, use_tool` oraz opcjonalnie
`web_search, web_fetch` i takiej samej allowlisty
`--tools`, bez launch args i skilli instancji. Pozostaje tylko transport Canopy MCP;
callbacki ACP odmawiają każdego lokalnego uprawnienia. Przechwycenie schematów
prawdziwego CLI jest częścią `isolation.test.ts`, obok Claude i Codexa.
Grok ma jawną regułę `allow = ["MCPTool(canopy__*)"]`, także dla zwykłych wątków;
tylko ten serwer deleguje zgody do gatewaya. Pozostałe MCP i narzędzia lokalne
zachowują dotychczasowe reguły. Generowanie tekstu bez narzędzi nie dostaje wyjątku.
Allowlista Claude `mcp__canopy__*` ma ten sam cel. Komunikat
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` dla tych narzędzi oznacza, że allowlista
rozstrzyga zgodę SDK przed callbackiem; zgoda platformy nadal następuje w gatewayu.

Prompt bota używa etykiet **Ask for approval** z ustawień i odróżnia je od
**Threads started by this bot**. Puste ustawienie jest normalizowane do `safe`;
gateway przyjmuje tylko `safe`, `always` i `full_auto`, nigdy `never`.
Karta tworzenia bota również pokazuje etykietę ustawienia zamiast kodu polityki.
Odmowa MCP przez Codexa lub `permission_denials` Claude dla Canopy kończy turę
kodem `tool_approval`, nawet jeżeli harness raportuje sukces generacji. Czat
podaje aktualizację workera i ponowienie zamiast sugerować nieistniejącą opcję.
Surowa treść odmowy nie trafia do rozmowy ani journala bota.

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

Capability `bot_steer_v1` negocjuje nietrwałe `SteerBotTurn` (833), wyłącznie
tekstowe wejście z UUID `input_id` do dokładnej pary bot–aktywna tura. Komenda
nie trafia do outboxa ani cache wyników komend. `CommandResult.data_json` (833)
zwraca `{status:"queued"|"delivered"|"unsupported"}`. `queued` oznacza jedynie
przyjęcie przez worker; potwierdzenie RPC dostawcy nie dowodzi konsumpcji.
`delivered` jest możliwe po trwałym zapisie dowodu konsumpcji (np. odpowiedź
na zduplikowane wejście tej samej aktywnej tury), nigdy po samym zapisie na stdin.

Codex wysyła natywne `turn/steer` z `expectedTurnId` i `clientUserMessageId`.
Dopiero `item/started` lub `item/completed` z pasującym `clientId`, natywnym
wątkiem i turą potwierdza wejście. Claude utrzymuje kolejkę wejścia stream SDK;
dowodem jest `command_lifecycle.started` albo oznaczenie konsumowanego UUID
w odpowiedzi harnessu. Echo `replay-user-messages` potwierdza tylko przyjęcie
do kolejki stdin, więc nie daje `applied`. Oczekujące wejście może ruszyć po poprzednim `result`;
worker czeka do 60 sekund na tę zmianę, bez limitowania trwającej generacji.
Grok zwraca `unsupported`; gateway zachowuje wiadomość dla następnej tury.

Dowód trafia do journala jako notice `bot_steer_applied` z
`data_json={"input_id":"…"}`. Wejścia bez dowodu przy zamykaniu harnessu dają
`bot_steer_dropped` z takim samym polem, przed `turnFinished`. `dropped` znaczy
brak potwierdzenia; nie gwarantuje, że dostawca nie odczytał bajtów. Gateway musi
zapisać wejście przed wysłaniem komendy i obsłużyć notice także przed jej wynikiem.
Po zerwaniu łącza lub restarcie nie wolno ponawiać nieznanego zapisu natywnego.
Przed wysłaniem worker zapisuje znacznik niepewnego wejścia w cache sesji;
usuwa go dopiero po trwałym `applied`. Pozostały znacznik lub `dropped` wymusza
odbudowę następnej sesji z historii gatewaya, żeby nie wznowić niepewnego kontekstu.
Twarda awaria może uniemożliwić zapis notice: rekoncyliacja kończy turę według
dotychczasowych zasad, a gateway rozstrzyga zachowane wejście jako niepotwierdzone.
Nie odtwarzamy nieznanych efektów ani dowodów konsumpcji z samego faktu istnienia
wiadomości w transkrypcie providera.

Prywatny czat właściciela i rozmowy Slacka korzystają z tego samego kontraktu.
Gateway dopasowuje potwierdzenie do źródła i dokładnej tury zapisanej w bazie.
Dla czatu prywatnego identyfikator wejścia jest identyfikatorem zapisu
w kolejce, a potwierdzenie przenosi istniejącą wiadomość do historii aktywnej tury.
Szczegóły zachowania czatu opisuje [bots.md](bots.md#kolejne-wiadomości-w-prywatnym-czacie).

`download_file` pobiera do scratch przez ograniczony transport HTTP(S) workera:
50 MiB, 60 s łącznie, 10 s bezczynności i 5 przekierowań. Każdy URL oraz
przekierowanie rozwiązuje DNS; jakikolwiek adres niepubliczny odrzuca całe żądanie.
Połączenie używa wybranego literalnego IP, bez drugiego lookup; HTTPS zachowuje
SNI i walidację certyfikatu dla oryginalnego hosta. Prywatne, metadata, mapowane
IPv4, link-local, multicast i zarezerwowane zakresy są blokowane. Transport nie
dziedziczy proxy, ciasteczek ani nagłówków z kont. Wysyła stały `User-Agent: Canopy-Bot`
także przy przekierowaniach. MIME pochodzi z odpowiedzi i jest zapisany w wyniku
narzędzia; gateway rozpoznaje typ ponownie z bajtów.

`send_attachment` odczytuje pojedynczy zwykły plik z prywatnego workspace przez
ograniczone fragmenty 1 MiB. Worker utrzymuje jedną niemodyfikowalną kopię
do 50 MiB na aktywną rozmowę, z limitem 60 s; bramka sprawdza rozmiar i SHA-256.
Gateway stosuje istniejące limity i walidację typu załączników właściciela.
Storage blobu, referencja, wiadomość bota, audyt `bot.send_attachment` i wynik
narzędzia zatwierdzają się w jednej fenced transakcji z deduplikacją call id.
Bajty i ścieżki hosta nie trafiają do wyniku narzędzia modelu. Wymagane jest
capability `bot_outgoing_files_v1`. Wyłączenie Files jest sprawdzane także przy
wykonaniu po zgodzie. Pobieranie nie utrzymuje blokady wiersza podczas I/O,
żeby heartbeat lease i Stop mogły działać. Odczyt i wysyłka po Stop są odmawiane.

Załączniki wychodzące używają tego samego `BotMessage.attachments` i API pobrania
co pliki użytkownika, więc web/desktop/mobile korzystają z obecnych podglądów.
W tym runtime nie ma automatycznych kanałów wiadomości Telegram/Slack; konto
MCP daje przyznane narzędzia, nie adres do doręczeń. Wysłanie do zewnętrznego
kanału wymaga jego istniejącego narzędzia oraz grantu i polityki zgód gatewaya.

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

Zatrzymywanie gatewaya nie odsyła błędu przerwania do oczekującego narzędzia bota.
Obsługa wywołania kończy się bez odpowiedzi na łączu; worker ponawia ten sam identyfikator
po reconnect, a nowy gateway odczytuje zachowaną zgodę. Dotyczy to także wywołania,
które czekało na przejęcie lease albo kończyło odczyt podczas shutdownu.
Gateway porównuje nazwę i źródło narzędzia, konto, zdalną nazwę MCP i argumenty
z zapisanym wywołaniem danej tury. Ponowienie ze zmienioną treścią zostaje odrzucone.
Przy zgodności narzędzie otrzymuje argumenty zapisane przy pierwszym żądaniu.
Istniejąca karta zachowuje ważność również po zmianie polityki bota.

Istniejący snapshot rozmowy dostaje tekst bieżącej odpowiedzi i status, bez
technicznych itemów narzędzi. Dla tur ze Slacka i rutyn pokazuje status pracy,
a tekst generacji pozostaje w zakresie danej tury. Przekazanie kontekstu przy zmianie modelu
odbywa się w tle. Końcowa odpowiedź w prywatnej rozmowie ma jeden wpis czatu. Błąd używa `TurnOutcome`, `TurnEndSource` i
`error_code`, tak jak wątki. Boty korzystają z `classifyFailure` i wspólnego
wiersza błędu wątków. `TurnFinished.error_class` zachowuje klasę przed usunięciem
prozy providera. Kody końca Claude i `codexErrorCode` pozostają w journalu
i gatewayu; UI dostaje klasę i bezpieczny komunikat, bez endpointów i stderr.
Oczekiwanie na zgodę lub offline nie ma limitu czasu generacji.
To nie wyłącza limitów klienta MCP dostawcy. Bot Claude używa HTTP MCP bez jawnego
`timeout`; przypięty SDK opisuje domyślny limit jako praktycznie nieograniczony,
z możliwością nadpisania przez `MCP_TOOL_TIMEOUT`. To osobna konfiguracja od
[limitów serwera in-process używanego przez wątki](claude-adapter.md#szyna-agentów).
Canopy nie zmienia tych wartości dla botów.
HTTP MCP obsługuje `notifications/cancelled` i przerwanie żądania. Worker przekazuje
`AgentToolCall.cancelled` i zachowuje je do potwierdzenia, także przez reconnect.
Gateway zapisuje tombstone wywołania i wygasza jego oczekującą kartę; późniejszy
efekt nie rusza. Koniec tury w journalu wygasza pozostałe karty przed dalszym
wykonaniem, również gdy nie dotarła osobna informacja o anulowaniu narzędzia.
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

`bots-harness-approvals.test.ts` sprawdza przez prawdziwy WorkerLink i kontrolowane
CLI każdą politykę wszystkich trzech harnessów: kartę `create_bot`, brak efektu
przed zgodą, wykonanie po zgodzie oraz `start_thread` bez karty przy full auto.
Obejmuje także odmowę MCP Codexa i odmowę allowlistowanego narzędzia Claude.
Fixture Codexa uwzględnia domyślną odmowę MCP bez jawnego `approve`, a fixture
Groka sprawdza regułę serwera. `codex-tools.test.ts` uruchamia prawdziwy app-server
z kontrolowanym endpointem modelu i wykonuje MCP Canopy bez zgody natywnej.
`providers/codex/platform-tools.test.ts` potwierdza, że zwykły wątek full auto
przekazuje `ask_user`, `spawn_thread` i `send_message` przez `dynamicTools`;
nie podlega on polityce zgód MCP. Testy nie potrzebują zewnętrznej inferencji.

`bots-harness-errors.test.ts` sprawdza przez WorkerLink i kontrolowane CLI każdą
klasę awarii Claude/Codex/Grok, brak pliku wykonywalnego i skuteczne ponowienie,
wyłączenie instancji przypiętego workera oraz brak sekretów w zapisie i snapshotach.
`bots-harness-regressions.test.ts` obejmuje rutyny, wakeupy, ukryte handoffy bez
narzędzi, granty i zgody MCP przez gateway, tworzenie Groka oraz wiele wzmianek
i wiadomości bot–bot. `bots-harness-defaults.test.ts` sprawdza wybór desktop/server
i trwałość przypięcia. `bots-harness-context.test.ts` sprawdza limity w katalogu
Codexa bota oraz odbudowę długiej rozmowy w budżecie: najnowsze wiadomości, notatkę
o pominięciu, całe bieżące wejście i pełny transkrypt. `codex-catalog.test.ts`
sprawdza z prawdziwym CLI, że Codex odczytuje okno i limit z katalogu bota.
`bots-connector-refresh.test.ts` sprawdza dla Claude/Codex/Grok
nową sesję po dodaniu konta, nadaniu/odebraniu grantu i usunięciu konta. Kontrolowane
CLI potwierdzają rzeczywisty katalog MCP oraz odbudowaną historię tej samej rozmowy,
w tym ponad 60 wcześniejszych wiadomości i najstarszą parę użytkownik–bot.
Zwykłe wątki nie rotują automatycznie sesji po zmianie konektorów, ponieważ nie
gwarantują pełnej odbudowy historii; ograniczenie opisuje [connectors.md](connectors.md).
Dotychczasowy `bots-harness.test.ts` nadal obejmuje offline,
reconnect, restarty, owner scoping i izolację.
`bots-instructions-refresh.test.ts` sprawdza przez prawdziwy WorkerLink i kontrolowane
CLI wszystkich trzech dostawców: edycję i wyczyszczenie instrukcji po wznowieniu,
restart workera/gatewaya, zmianę w trakcie tury, nazwę, effort, model i politykę,
brak rotacji po zmianie wyglądu lub zapisie bez zmian, historię tego samego czatu
i zachowanie zapisanej notatki handoff. Fixture odczytuje system prompt z inicjalizacji
SDK Claude, `baseInstructions` Codexa i pliku profilu Groka; odpowiedź kontrolna
pochodzi z tych instrukcji, nie z treści wiadomości użytkownika. Testy te dowodzą
kontraktu adapterów, nie zachowania płatnych modeli ani ignorowania override przez
konkretną wersję CLI. Nie wymagają logowania ani zewnętrznej inferencji.
`linked-agent-messages.test.ts` łączy dwa gatewaye i kontrolowany harness bota:
sprawdza autora oraz treść wiadomości i steerów, czytelny event zakończenia,
wznowienie bota i pojedynczy tekst po strumieniu z blokiem rozumowania.

`apps/worker/src/bots/steering.test.ts` sprawdza przez prawdziwy SDK Claude
i protokół app-server Codexa z kontrolowanymi procesami: UUID konsumpcji,
odrzucanie innego bota/tury, deduplikację wejścia, wyścig z końcem i awarię bez
ponowienia zapisu. Grok zachowuje aktywną turę i zwraca `unsupported`.
`claude-steering.test.ts` sprawdza rzeczywisty CLI z lokalnym endpointem modelu:
wejście nie jest potwierdzane podczas zablokowanego wcześniejszego żądania,
a po jego zakończeniu trafia do następnego żądania tej samej sesji.
`conversation-isolation.test.ts` obejmuje prywatną rozmowę, dwie zewnętrzne,
zmianę dostawcy, odmowę traversal/dowiązań, retencję i odtworzenie journala
ze znacznikiem niepewnego wejścia po restarcie. Nie jest to test płatnych modeli.

Poprawione regresje: `create_bot` odrzucał jawny wybór Groka mimo poprawnego schematu;
awaria startu instancji Codexa mogła przerwać obsługę konfiguracji WorkerLink.
Błąd SDK Claude w wiadomości assistant jest błędem tury, a nie tekstem odpowiedzi.

Desktop ładuje wspólny web UI, a aplikacja mobilna używa tego samego UI API
i snapshotów rozmowy; zmiana runtime'u nie wymaga nowego transportu klienta.
`bot-composer.test.ts` obejmuje dwa obrazy, kolejne wiadomości bez załączników,
wznowienie i odbudowę wszystkich trzech harnessów oraz opóźniony odczyt szkicu
przez wspólny synchronizator klientów. Sprawdza zarówno trwałe komendy gatewaya,
jak i natywne części wejścia kontrolowanych CLI. `bot-files.test.ts` chroni tę
samą granicę dla tekstu i PDF, a `bots/images.test.ts` sprawdza ignorowanie
historycznych plików przesłanych przez starszy gateway, bez ich pobierania.
Worker nie konfiguruje kanałów komunikatorów; przypisania i przyjmowanie zdarzeń
należą do gatewaya.
Opt-in testy live (`CANOPY_LIVE=1`) nie mają wpisanych hostów ani kluczy.
