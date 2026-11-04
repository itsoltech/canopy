# Boty przez oficjalne harnessy

Status: etapy 1–2 implementują Claude, Codex i Groka. Osobna migracja generowania
tytułów Groka trafiła na dev w #101; etap 2 jest na niej oparty.
Decyzja maintenera zastępuje wariant B z [bots.md](bots.md). Canopy docelowo
nie wysyła żadnych żądań inferencji HTTP. Claude działa przez Agent SDK i oficjalny
`claude`, Codex przez oficjalny `codex app-server`, Grok przez CLI i adapter ACP.
CLIProxyAPI jest dopuszczalne wyłącznie jako połączenie skonfigurowanej instancji
harnessu. Nie kopiujemy tokenów subskrypcji do gatewaya.

## Upoważnienie i rezultat

```yaml
workflow_mode: autonomous-planned
mode_source: explicit-user-task-instruction
decision_authority: delegated
scope: current-task
artifact_state: ready-for-execution
execution_mode: inline
protected_constraints:
  - bez push, PR, wdrożeń i zmian działającego stosu
  - bez sekretów i prywatnych hostów w repo lub wynikach
  - addytywny protokół i nowe migracje
```

Projekt wybiera rozwiązania w zakresie przekazanym przez użytkownika. Nie stanowi
zgody na publikację. Etap 1 jest gotowy dopiero po przejściu ścieżki bot → outbox
→ WorkerHost → harness → szyna → gateway → rozmowa oraz testów opisanych niżej.

## Miejsce wykonania i instancje

Bot ma ustawienie **Runs on**: jeden worker dostępny właścicielowi. Domyślnie
wybieramy własny worker desktopu, jeżeli obsługuje instancję; w pozostałych
przypadkach pierwszy online z włączoną instancją. Po wyborze przypięcie jest trwałe.
Wyłączona instancja daje czytelny błąd; worker offline nie unieważnia przypięcia
i nie powoduje fallbacku do API. UI pokazuje **Waiting for ‹worker›**.

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

Claude zapisuje sesję i wznawia ją przez `resume`, Codex przez `thread/resume`,
Grok przez `session/load`. Identyfikator sesji jest cache'em. Transkrypt
gatewaya pozostaje źródłem prawdy, także dla rutyn i handoffów. Nowa sesja dostaje
historię jako jawnie oznaczone dane oraz bieżące instrukcje, czas i tożsamość modelu.
Zaginiona lub przeniesiona sesja jest odbudowywana bez powtarzania narzędzi z historii.
Wznowienie dostaje nowe wejście i aktualny kontekst. Zmiana zestawu narzędzi wymaga
nowej sesji, żeby odebrany grant nie pozostał w katalogu harnessu.

W etapie 1 nie dodajemy osobnego wywołania modelu do streszczania. Przy odbudowie
obowiązują istniejące granice historii bota (ostatnie 60 wiadomości dla rutyn,
notatka handoffu). Dla nadmiernego kontekstu zwracamy błąd harnessu; nie obcinamy
po cichu bieżącego wejścia. Dalsza kompakcja musi zachować decyzje i wyniki narzędzi.

## Narzędzia i granica bezpieczeństwa

Bot nie dostaje Bash, shella, odczytu/zapisu plików, obrazu lokalnego, web fetch,
wyszukiwania, natywnych subagentów, celów ani harmonogramu harnessu. Read-only
sandbox jest drugą warstwą, nie dowodem usunięcia narzędzi.

Claude: `tools: []`, `settingSources: []`, `strictMcpConfig`, wyłączone hooki,
puste pluginy, własny system prompt i allowlista konkretnych `mcp__canopy__*`.
Serwer ma `alwaysLoad: true`, bez odroczonego wyszukiwania narzędzi.
Zgody na akcje MCP egzekwuje gateway. Codex: minimalny katalog modelu z
`shell_type: disabled`, bez patcha i dodatkowych narzędzi, wyłączenia wspólne
z `codexTextOverrides`, read-only, sieć sandboxa wyłączona, approvals `never`,
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
`error_code`, tak jak wątki. Integracja z równoległą gałęzią
`fix/bots-wizard-and-errors` powinna korzystać z jej klasyfikatora i komunikatów,
bez parsowania surowych endpointów lub ujawniania stderr.
Etap 1 zachowuje kody końca Claude i `codexErrorCode` z adapterów wątków
w journalu i gatewayu; ogólny komunikat czatu zastąpi wspólny klasyfikator.
Oczekiwanie na zgodę lub offline nie ma limitu czasu generacji.
Takie tury utrzymują lease, ale nie zajmują limitu czterech aktywnych inferencji
gatewaya; pozostałe boty mogą odpowiadać podczas oczekiwania.

## Migracja i zgodność

Nowa migracja ma numer po najwyższym istniejącym pliku; przed scaleniem trzeba
sprawdzić numer ponownie. Historia botów, identyfikatory, rutyny, wakeupy i handoffy
pozostają. Pierwsza następna tura wybiera/pamięta worker i tworzy sesję z historią.
Nie potrzebujemy przenoszenia sesji API, bo dotychczas nie istniała.
`0069_bot_errors.sql` jest już na `origin/dev`; migracja tego stosu została
przenumerowana na `0070_bot_harness.sql`. Nie edytujemy migracji zastosowanej.

Proto rozszerzamy addytywnie. `bot_harness_v1` negocjuje nową funkcję; starszy
worker nie dostanie komendy. `WORKER_LINK_PROTOCOL` i zamrożone
`canopy.update.v1` pozostają bez zmian. Etap 1 nie jest przeznaczony do osobnego
scalenia do dev, dopóki pozostały runtime bezpośredni nie zostanie usunięty.

## Audyt inferencji

Wyszukiwanie produkcyjnego kodu po endpointach `messages`, `responses`,
`chat/completions`, klientach Anthropic/OpenAI i metodach inferencji wykazało:

| Miejsce | Obecne zachowanie | Docelowe działanie |
| --- | --- | --- |
| Gateway botów | Wyłącznie worker/harness; `model.ts` usunięty | Gotowe w etapie 2 |
| `apps/worker/src/providers/grok/generate-text.ts` | Krótkotrwały Grok CLI/ACP dla tytułów | Osobne zadanie `fix/grok-text-generation`, scalone w #101 i uwzględnione przez rebase |
| `apps/worker/src/providers/generate-text.ts` | Izolowane oficjalne Claude SDK/Codex | Wzorzec izolacji do ponownego użycia |
| Testy przechwytujące HTTP | Kontrolowany endpoint modelu | To fixtures harnessów, nie runtime inferencji Canopy |

`Test connection` proxy wykonuje tylko `GET /v1/models`, a katalogi mogą również
czytać `/v1beta/models`. To nie są wywołania LLM i pozostają dozwolone.
`tools/direct-inference.test.ts` skanuje źródła aplikacji i pakietów poza testami,
fixtures i wygenerowanym kodem. Endpointy inferencji oraz klienci HTTP SDK powodują
błąd CI; generowanie tytułów nie ma wyjątku.

## Stos etapów

1. `feat/bots-harness-1` → `dev`: pionowa ścieżka Claude/Codex, Runs on,
   sesje, MCP, outbox/journal, istniejący czat, migracja i testy. Bez fallbacku
   Claude/Codex do bezpośredniego API.
2. `feat/bots-harness-2` → etap 1: Grok CLI/ACP dla botów,
   dowód pustych lokalnych narzędzi, usunięcie `directModel` oraz całego
   bezpośredniego runtime'u i aktualizacja pozostałych testów/procedur.
3. `feat/bots-harness-3` → etap 2: wspólna walidacja regresji, konflikty
   równoległego kreatora/klasyfikacji błędów, dokumentacja i dowody całego stosu.

Każdy etap jest kompletnym składnikiem stosu i ma własne testy. PR-y pozostają
draft do pełnej migracji; cały stos scala się razem przez `gh stack merge --squash`.
W tym zadaniu nie tworzymy PR-ów, nie pushujemy i nie scalamy.

## Dowody wymagane dla etapu 1

Testy gateway–worker przez prawdziwy WorkerHost i kontrolowane CLI: round trip
obu harnessów, wznowienie sesji, MCP i karta zgody, brak wbudowanych narzędzi,
kolejka offline, reconnect, restart obu stron, odtwarzanie końca z transkryptu,
owner scoping i brak sekretów. Izolacja rzeczywistych binarek powinna być
sprawdzona przez przechwycenie requestu modelu, jak przy generowaniu tytułów.
Test live jest opt-in (`CANOPY_LIVE=1`), bez wpisanych hostów/kluczy.

Wymagane sprawdzenia: install, gen:check, typecheck, lint, format:check,
check:tmp oraz web build. Bez testów UI. Przegląd w prawdziwej przeglądarce:
Runs on i rozmowa, jasny/ciemny, desktop/telefon; screenshoty poza repo w
`~/.cache/canopy-bots-harness-1/`. Brak wykonania któregoś sprawdzenia musi być
jawnie opisany w przekazaniu, nie zastąpiony deklaracją sukcesu.
