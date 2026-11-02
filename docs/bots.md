# Boty w gateway — faza 1

Status: **zaimplementowany rdzeń i minimalny UI**, 2026-11-02. Bot ma jedną rozmowę
z właścicielem i działa w procesie gateway. Nie ma katalogu, workera ani lokalnego
harnessu. Kod: `apps/gateway/src/bots`, kontrakt: `proto/openagents/ui/v1/bots.proto`.

## 1. Decyzja o wykonaniu

Wybrany wariant **B: bezpośrednie API modelu i własna pętla narzędzi**. Claude korzysta
z Anthropic Messages, Codex z OpenAI Responses. Oba połączenia mogą przechodzić przez
CLIProxyAPI. Gateway czyta globalną instancję `provider_instances` i odszyfrowuje jej
klucz wyłącznie na czas żądania. Nie używa nadpisań workera ani nie kopiuje jego logowania.

| Wariant | Korzyść | Koszt i decyzja |
|---|---|---|
| A: Claude Agent SDK / Codex app-server na hoście gateway | Logowania subskrypcyjne harnessu, gotowy kontekst i sesje | Można usunąć narzędzia, ale proces dostawcy nadal działa na hoście. Wznowienie wymaga plików sesji i pogodzenia historii harnessu z zatwierdzeniami w PostgreSQL. Aktualizacja katalogu lub CLI może zmienić zestaw narzędzi. Nie jest runtime'em Bots w fazie 1. |
| B: API i jawne funkcje | Brak lokalnego wykonawcy; pełny checkpoint pętli w bazie, ta sama polityka obu dostawców | Wymaga endpointu dostępnego z gateway i jego klucza; własne limity kontekstu i formatowanie historii. Wybrane. |

**Ograniczenie logowania:** tworzenie bota na `native` jest odrzucane. Login Claude/Codex
na workerze nie stanowi poświadczenia gateway. Dla subskrypcji należy skonfigurować
instancję endpointową przez CLIProxyAPI. Pola `runtime` i dowolne zmienne środowiskowe
instancji są opcjami procesu harnessu, więc runtime API Bots ich nie wykonuje ani nie
wczytuje do procesu gateway. Wykorzystuje `base_url`, `api_key`, dostawcę, model i effort.
Nie ma automatycznego przełączenia na wariant A.

### Dowód usunięcia narzędzi w wariancie A

Repozytorium już używa izolowanych SDK do generowania tytułów
([thread-titles.md](thread-titles.md)). Sprawdzone wersje: Claude Agent SDK **0.3.316**,
Codex CLI **0.164.0**. Testy używają przypiętego SDK i rzeczywistego pliku wykonywalnego
Codexa z tej maszyny, bez aktualizacji zależności.

- Claude: `tools: []`, `allowedTools: []`, odmowa w `canUseTool`, `settingSources: []`,
  własny system prompt, `mcpServers: {}`, `strictMcpConfig: true`, brak pluginów,
  wyłączone hooki, katalog testowy przez `@open-agents/testing`, brak zapisu sesji.
  To lista narzędzi bazowych jest pusta; samo `allowedTools` nie byłoby takim dowodem.
- Codex: `model_catalog_json` z `shell_type: "disabled"`,
  `apply_patch_tool_type: null`, `experimental_supported_tools: []`,
  `tool_mode: "direct"`, `multi_agent_version: null`; ponadto `web_search="disabled"`,
  `agents.enabled=false`, `tools.update_plan.enabled=false`,
  `tools.experimental_request_user_input.enabled=false`,
  `features.shell_tool=false`, `features.apply_patch_freeform=false`,
  `features.view_image=false`, `features.multi_agent*=false`, `features.apps=false`,
  `features.js_repl=false`, `features.code_mode*=false`, `features.tool_search=false`,
  `features.plugins=false`, `features.goals=false` oraz pozostałe wyłączenia
  z `codexTextOverrides`. Wątek: `dynamicTools: []`, `environments: []`,
  `project_doc_max_bytes: 0`, `mcp_servers: {}`, ephemeral, osobny `CODEX_HOME`.
  Sandbox `read-only`, zatwierdzenia `never`, sieć sandboxa wyłączona — to dodatkowa
  ochrona, **sam read-only sandbox nadal pozwalałby czytać pliki przez shell**.
- `apps/worker/src/providers/generate-text.test.ts`: prawdziwy CLI każdego dostawcy
  dostaje polecenie uruchomienia `ls`; kontrolowany endpoint przechwytuje żądanie
  modelu i potwierdza pustą listę `tools`. Test Codexa sprawdza również przyjęcie
  konfiguracji przez `--print-startup-config`. Samo przyjęcie kluczy nie dowodzi
  usunięcia narzędzi; dowodem jest żądanie do modelu.
- `tests/integration/text-generation.live.test.ts`: oba SDK przez CLIProxyAPI
  odpowiadają `NO_LOCAL_TOOLS` na prośbę o lokalne `ls`; brak trwałych wątków,
  transkryptów i dziennika komend generacji.

W wariancie B brak lokalnych możliwości wynika dodatkowo z konstrukcji: gateway nie
uruchamia procesu dostawcy, a wysyłane schematy są wyłącznie funkcjami z jawnej listy.
Nie wysyła narzędzi hostowanych dostawcy (shell, wyszukiwanie, code interpreter).
Wywołanie nieznanej funkcji zwraca błąd, nie uruchamia dynamicznego dispatchera.

## 2. Dane i jedna rozmowa

Migracja **0030_bots** jest addytywna. Wybrano osobny schemat tabel. Obecne `threads`
wymagają projektu, mają reguły główny/boczny, placement, fork i szynę z relacją rodzica.
Sztuczny projekt i ukryty wątek gateway naruszałyby semantykę niezależnej sekcji Bots.
`runtime='gateway'` pozostaje w schemacie Threads dla przyszłych agentów projektowych.

| Tabela | Rola |
|---|---|
| `bots` | Właściciel, konfiguracja (nazwa, kształt, kolor, instancja/model/effort, persona, polityka zgód), rewizja rozmowy, status, soft delete. Sam `bot_id` jest identyfikatorem jedynej rozmowy z człowiekiem. |
| `bot_turns`, `bot_messages` | Trwałe wejścia i kolejka, checkpoint modelu, hops, lease z tokenem; wiadomości z nadawcą, adresatem i opcjonalną wymianą. Unikalne `(bot_id, client_request_id)` oraz `(turn_id, message_key)` deduplikują zapis. |
| `bot_tool_calls`, `bot_approvals` | Jawne schematy narzędzi, argumenty i wynik wewnętrzny; trwałe zatwierdzenie albo pytanie z odpowiedzią. Dane techniczne nie trafiają do zwykłej osi czatu. |
| `bot_mcp_servers`, `bot_mcp_connections` | Rejestr właściciela, URL, transport, włączenie, odwołania do zaszyfrowanych nagłówków; relacja przypisania serwera do botów. |
| `bot_thread_watches`, `bot_wakeups` | Outbox wyników tur workerów i jednorazowych pobudek własnego bota; dostarczenie i nowa tura zatwierdzane razem. |

Przypięcia są ustawieniem użytkownika: `SidebarSettings.pinned_bot_ids`, pole **350**.
Nie są stanem bota. Inne nowe komunikaty mają własny plik proto; nie zajmują numerów
dotychczasowych komunikatów. Tury workera uruchomione przez bota mają `trigger='bot'`,
`bot_call_id` i dodatnie `hops`, żeby przejście przez worker nie zerowało łańcucha.

## 3. Wykonanie i odtwarzanie

1. Przyjęcie wiadomości zapisuje wejście, turę i wiadomość czatu w transakcji; ACK
   następuje po commicie. Powtórzenie tego samego `client_request_id` zwraca tę samą turę.
2. Gateway przejmuje najstarszą niezakończoną turę bota przez `FOR UPDATE SKIP LOCKED`.
   Jedna rozmowa ma najwyżej jednego wykonawcę. Lease trwa 30 s i odnawia się co 5 s.
   Token lease i jego ważność są sprawdzane przy każdym zapisie checkpointu lub wyniku.
3. Odpowiedź modelu, wraz z całą listą funkcji, jest zapisywana **przed** wykonaniem
   narzędzi. Każda funkcja ma kanoniczny identyfikator zachowany w checkpointcie.
   Zatwierdzone wyniki narzędzi są ponownie odczytywane zamiast wykonywane.
4. Utworzenie wątku, pierwszej tury, komendy workera, subskrypcji wyniku i zapis wyniku
   funkcji platformy są jedną transakcją. Kolejkowanie kolejnej wiadomości do wątku
   również zatwierdza turę i subskrypcję razem. `steer` obserwuje dostarczenie do aktywnej
   tury lub istniejący fallback do kolejki, zachowując autora bota i hops. Outbox workerów zachowuje własną
   idempotencję komend. Archiwizacja używa istniejącego, idempotentnego cyklu życia.
5. Przed zdalnym MCP zapisujemy `running`. Gdy lease zostaje przejęty po awarii,
   takie wywołanie staje się `interrupted`, z opisem nieznanego wyniku. Model dostaje
   ten wynik, a nie ponowione żądanie MCP. Dokładnie jednokrotnego wykonania obcego
   serwera HTTP nie można obiecać bez jego własnego klucza idempotencji.

Checkpoint i końcowa wiadomość są trwałe. Awaria podczas samej generacji może wymagać
ponownego wywołania modelu (i ponownego kosztu), ale nie tworzy drugiej wiadomości ani
drugiego zatwierdzonego działania. Stary wykonawca nie może zatwierdzić wyniku po utracie
lease. Łagodne zatrzymanie anuluje zapytania i oddaje lease; twarda awaria wymaga jego
wygaśnięcia. Oczekiwanie na zgodę nie trzyma procesu ani połączenia z modelem.

Limit wykonawczy fazy 1: cztery tury na instancję gateway, 32 rundy narzędzi na turę,
32 funkcje w odpowiedzi, 10 min na aktywną próbę. Długie konteksty i kompakcja wymagają
dalszej pracy; obecnie dostawca może odrzucić zbyt długą historię. UI otrzymuje całe
wiadomości po zapisaniu; status jest aktualizowany podczas generacji i narzędzi.

## 4. Narzędzia, uprawnienia i status

Bot działa w imieniu właściciela. Listy i odczyty filtrują właściciela; tworzenie wątku
wykorzystuje walidację projektu/workspace'u, dostępności instancji i katalogu modeli
z UI API. Rozmowy i wyniki innych agentów są niezaufanymi danymi, nie instrukcją
poszerzenia uprawnień. Model nigdy nie dostaje kluczy endpointu ani nagłówków MCP.

| Zestaw | Funkcje |
|---|---|
| Odczyty platformy | `list_projects`, `list_workers`, `list_provider_instances`, `list_threads`, `get_thread`, `read_thread`, `list_bots` |
| Praca i komunikacja | `start_thread` (projekt, workspace, dostawca, instancja, model, effort, permission, prompt), `send_message` (`queue`/`steer` z fallbackiem), `send_bot_message`, `rename_thread` |
| Harmonogram i człowiek | `schedule_wakeup`, `list_schedules`, `cancel_schedule`, `ask_user` |
| Działanie wymagające zgody | `archive_thread`, `set_thread_model`, `cancel_schedule`; także podwyższone permission przy `start_thread` |
| Zdalne MCP | Tylko narzędzia włączonych i podłączonych serwerów HTTP/SSE; brak stdio. Nazwa serwera i narzędzia są zapamiętywane wewnętrznie. |

Domyślne `approval_policy='safe'`: odczyty platformy i MCP oznaczone `readOnlyHint=true`
bez `destructiveHint=true` nie pytają o zgodę. Każdy inny MCP wymaga karty przed wykonaniem,
w tym wysyłka do systemu zewnętrznego. `always` wymaga kart dla każdego narzędzia.
`ask_user` zawsze tworzy kartę tekstową. Zmiana instancji dostawców, sekretów i trwałe
usuwanie nie są udostępnionymi narzędziami modelu. Politykę można zapisać przez API;
pełny edytor jest zakresem kolejnej fazy.

Rejestr odrzuca protokoły lokalne, dane logowania i tokeny w URL, niepoprawne nagłówki
oraz nagłówki transportowe. Nagłówki są AES-256-GCM w istniejącym `secrets`, z odwołaniami
w rejestrze; do UI wracają tylko nazwy. Klient MCP odrzuca przekierowania i zmianę origin
przez endpoint SSE, żeby nie przekazać nagłówków do innego hosta. Rejestr jest jawną
konfiguracją użytkownika; może wskazywać dostępne mu prywatne usługi sieciowe.

Statusy nie pokazują nazw funkcji ani ich JSON: `Typing…`, `Searching Notion`,
`Checking Notion`, `Checking threads`, `Starting a thread in a project`, `Waiting for you`.
W trakcie aktywnego narzędzia status pochodzi z zaufanego deskryptora i parametrów
etykiety. Przerwanie anuluje żądanie modelu/MCP i unieważnia lease; kolejne wiadomości
mogą zacząć nową turę.

## 5. Bot ↔ bot i powiadomienia

`send_bot_message` zapisuje adresata, wymianę i nową turę docelowego bota. Jego odpowiedź
pozostaje w jego jednej rozmowie i jest też follow-upem nadawcy. W czacie nadawcy
pojawiają się linie `Messaged ‹Bot›` i `Message from ‹Bot›`. `exchange_id` łączy wpisy;
`ReadBotExchange` umożliwia ich odczyt właścicielowi. Nie powstaje druga rozmowa
użytkownika z tym samym botem.

`hops` korzysta z limitu szyny agentów: **8**, wejście człowieka zaczyna od 0,
wiadomość automatyczna zwiększa licznik. Operacja wymagająca odpowiedzi rezerwuje też
przeskok na powrót. Przekroczenie budżetu nie uruchamia docelowego bota ani wątku.
Zakończenie wskazanej tury workera tworzy follow-up bota przez trwały watch; działa
także wtedy, gdy zakończenie nastąpiło podczas przerwy gateway.

Jednorazowe przypomnienia własnego bota są w `bot_wakeups`: create/list/cancel,
zwiększenie hops, atomowy zapis pobudki. Cykliczne zadania workerów nadal obsługuje
istniejący scheduler i UI API; nie są emulowane przez timer procesu Bots.

## 6. API i minimalny UI

Metody są częścią uwierzytelnionego `GatewayService` (ten sam interceptor usługi i BFF):

- `CreateBot`, `UpdateBot`, `DeleteBot`, `ListBots`, `GetBot`, `SendBotMessage`.
- `WatchBotConversation`: od razu snapshot, następnie nowy snapshot po zmianie rewizji,
  włącznie ze statusem i kartami. Odczyt PostgreSQL co 250 ms umożliwia odbiór zmian
  także z innej instancji gateway; po reconnect pełny snapshot uzupełnia przerwę.
- `ReadBotExchange`, `AnswerBotApproval`, `InterruptBot`.
- `SaveBotMcpServer`, `ListBotMcpServers`, `DeleteBotMcpServer`, `TestBotMcpServer`;
  test inicjalizuje zdalne połączenie i pobiera katalog narzędzi.

Minimalny frontend używa istniejących `BotsNav`, `ChatView`, `ChatTimeline`, `BotAvatar`
i `QuestionCard`, bez importowania galerii lub danych fikcyjnych. Lista jest pobierana
z API, czat przez SSE BFF; można wysłać wiadomość, odpowiedzieć, zatwierdzić, odrzucić,
przerwać i przypiąć bota. Awaria wysyłki zachowuje identyfikator żądania przy „Retry message”.
Kształt i własny kolor są renderowane przez awatar.

Gałąź `feat/bots-wizard` nie była scalona podczas implementacji. Formularz na `/bots`
ma hook `oncreate(BotWizardResult)` w `features/bots/live.ts` z danymi
`{name, shape, color, providerInstance, model, effort}`. Obecnie `providerInstance`
jest obiektem z `id` i `harness`; integracja przyszłego komponentu powinna mapować
jego payload w tym jednym miejscu. Model i effort można wpisać/wybrać w formularzu.

## 7. Weryfikacja i dalsza faza

- Jednostkowe: `apps/gateway/src/bots/{policy,model}.test.ts`; decyzje zgód,
  przeskoki, opis statusu, protokoły i odrzucenie lokalnych możliwości.
- Integracyjne: `tests/integration/bots.test.ts`, prawdziwy PostgreSQL, skryptowany
  model i worker, lokalny serwer HTTP MCP wyłącznie w teście. Tworzenie i deduplikacja,
  wznowienie generacji, przerwane MCP bez powtórzenia, zgody/odrzucenie/pytania,
  wymiana botów, powiadomienia workera po restarcie, przerwanie i usunięcie.
- Live: `tests/integration/bots.live.test.ts` przez `useLiveProxy`: **Claude i Codex**
  odpowiadają na czacie, odmawiają lokalnego `ls`, tworzą wątek na prawdziwym workerze
  stosu testowego i dostają jego wynik jako nową turę. Izolowane porty i katalogi
  przez `@open-agents/testing`; istniejący `/tmp/oa-stack` i jego porty nie są używane.
- Dowody izolacji harnessów: test przechwycenia requestu i live opisane w sekcji 1.
  Sekrety live pochodzą wyłącznie z pliku środowiska poza repozytorium; brak wartości
  w kodzie, commitach, wynikach testów i dokumentacji.

Faza 2: pełny wizard z katalogami modeli, ustawienia persony i polityk, zarządzanie MCP
z połączeniem testowym i rotacją nagłówków, otwieranie i grupowanie wymian bot↔bot,
podgląd uczestników, liczniki nieprzeczytanych, animacje i dopracowanie dostępności,
harmonogramy cykliczne botów, kompakcja kontekstu i wydajniejsze strony/zdarzenia czatu.
