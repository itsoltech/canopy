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

Migracja **0031_bots** (po scaleniu `0030_bus_notify_delivery` z main) jest addytywna. Wybrano osobny schemat tabel. Obecne `threads`
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
   Wynik zatwierdzony w transakcji ma pierwszeństwo przed późniejszym błędem dispatchu
   lub publikacji; taki błąd nie nadpisuje sukcesu i nie zachęca modelu do powtórzenia akcji.
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
W trakcie aktywnego narzędzia status pochodzi z zaufanego deskryptora. Nazwy projektów,
wątków i botów są odczytywane ścieżkami właściciela, np. `Starting a thread in CRM`.
Karta zgody pokazuje cel i proponowaną treść lub ustawienia jako opisane pola, bez JSON;
długie wartości są jawnie oznaczone jako skrócony podgląd. Przerwanie anuluje żądanie modelu/MCP i unieważnia lease; kolejne wiadomości
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

## 6. API

Metody są częścią uwierzytelnionego `GatewayService` (ten sam interceptor usługi i BFF):

- `CreateBot`, `UpdateBot`, `DeleteBot`, `ListBots`, `GetBot`, `SendBotMessage`.
- `WatchBotConversation`: od razu snapshot, następnie nowy snapshot po zmianie rewizji,
  włącznie ze statusem i kartami. Odczyt PostgreSQL co 250 ms umożliwia odbiór zmian
  także z innej instancji gateway; po reconnect pełny snapshot uzupełnia przerwę.
- `ReadBotExchange` (BFF `GET /api/bot-exchanges/{id}`), `AnswerBotApproval`, `InterruptBot`.
- `RetryBot` (BFF `POST /api/bots/{id}/retry`): ponawia **ostatnią** turę, jeśli zakończyła
  się błędem. Usuwa notatkę o błędzie i wznawia tę samą wiadomość od checkpointu; nie tworzy
  drugiej wiadomości użytkownika. Inna sytuacja to `INVALID_ARGUMENT`.
- `SaveBotMcpServer`, `ListBotMcpServers`, `DeleteBotMcpServer`, `TestBotMcpServer`;
  test inicjalizuje zdalne połączenie i pobiera katalog narzędzi.

Pola kontraktu dodane po fazie 1 (bez migracji, wyliczane przy odczycie):
`BotMessage.failed` (pole 10) — tura zakończona błędem; `text` zawiera wtedy szczegół
techniczny, nie treść rozmowy. `BotApproval.options` (pole 9) — propozycje odpowiedzi
pytania `ask_user` (do 6), odczytywane z argumentów wywołania (id zgody = id wywołania).

### Model API, nie alias harnessu

Bot wywołuje API dostawcy bezpośrednio, więc alias Claude Code (`default`, `opus`, `sonnet`,
`haiku`, `best`, `opusplan`, także z `[1m]`) kończył każdą odpowiedź HTTP 400. Teraz:

- `CreateBot`/`UpdateBot` zapisują model, na który alias rozwiązuje się w katalogu workera
  dla tej instancji (`ModelInfo.resolved_model`, np. `default` → `claude-opus-5-5`).
  Alias bez rozwiązania jest odrzucany z czytelnym błędem; model spoza **kompletnego**
  katalogu również. Własne modele instancji i brak katalogu przechodzą (endpoint decyduje).
- Runtime rozwiązuje model przed każdym wywołaniem, więc boty zapisane wcześniej z aliasem
  (np. „Kropek” na stosie) działają bez migracji danych; przy następnym `UpdateBot` model
  zostaje zapisany już jako konkretny.
- Wizard (`botWizardInstances`) oferuje alias jako model, na który się rozwiązuje, a aliasów
  bez rozwiązania nie pokazuje wcale.

### Zgody, pytania i edycja

Karta zgody: „Needs approval ⌄” (menu polityki bota `safe`/`always`, zapis przez `UpdateBot`),
cel akcji, pola z etykietami i najdłuższe pole jako podgląd. **Approve** wykonuje akcję,
**Discard** odrzuca, **Edit** pozwala przepisać podgląd i wysłać własną wersję: to
`AnswerBotApproval{approve:false, answer:<tekst>}`; nic nie jest wykonywane, a model dostaje
wynik `changes_requested` z treścią użytkownika (niezaufaną) i proponuje akcję ponownie.
`ask_user` przyjmuje opcjonalne `options`; karta pytania pokazuje je jako A, B, C…, pozwala
odpowiedzieć własnymi słowami albo pominąć (Skip = odrzucenie).

## 7. UI czatu

Kod: `apps/web/src/lib/features/bots`, trasy `routes/bots/[botId]` i
`routes/bots/[botId]/exchanges/[exchangeId]`. Rozmowa wygląda jak komunikator, bez narzędzi,
JSON i składanych logów pracy.

- **Dymki** (`ChatBubble`, `MessageRow`): Twoje wiadomości w ciemnym neutralnym kolorze
  (zinc‑900; w trybie ciemnym jasne zinc‑100), bota na miękkiej szarości (zinc‑100 / zinc‑800).
  Kolejne wiadomości jednego nadawcy w odstępie < 5 min tworzą serię: mniejsze odstępy,
  ciaśniejsze narożniki od strony sąsiadów, awatar tylko przy ostatniej. Maks. szerokość
  36rem. Markdown bota dopasowany do dymka; inne boty wymienione z nazwy w tekście są
  chipami z awatarem w ich kolorze (`BotChip`, `mentions.ts`).
- **Separatory czasu** tylko na początku, po zmianie dnia i po godzinie ciszy
  („Today 11:46 AM”).
- **Status na żywo** (`BotStatusRow`): pod ostatnią wiadomością awatar bota i linia z efektem
  shimmer („Typing…”, „Searching Notion”); zmiana frazy to text swap. Gdy czeka na Ciebie,
  linia jest spokojna. Nagłówek pokazuje tylko awatar, nazwę i model. Żywe maskotki dostają
  stan z rozmowy (`stateForStatus`, błąd, nowa wiadomość jako `event`).
- **Akcje wiadomości**: Reply (cytat do composera) i Copy pojawiają się obok dymka po
  najechaniu lub fokusie; na dotyku długie przytrzymanie otwiera menu. Reakcje pominięto —
  nie ma ich w API.
- **Bot ⇄ bot**: kolejne wiadomości wymian w czacie zwijają się do linii „Messaged ‹A› and
  ‹B›”, „Message from ‹A›”, „N messages with ‹A›”. Chip prowadzi do widoku wymiany
  „A ⇄ B”: wiadomości z nazwami i awatarami po lewej, separatory czasu, „Close chat” (i Esc)
  wraca do czatu bota. Odpowiedź bota dla Ciebie pozostaje zwykłym dymkiem.
- **Błędy** (`ChatErrorLine`, `errors.ts`): zamiast „Model endpoint returned HTTP 400” linia
  „Kropek couldn't reply — the model isn't available.”, szczegół w tooltipie ikony i dla
  czytników ekranu. Przy ostatniej turze: **Retry** (`RetryBot`) i — gdy przyczyną jest
  model — **Change model** (`ChangeModelDialog`, `UpdateBot`). Lista boczna pokazuje
  „Couldn't reply”.
- **Composer** (`BotComposer`): jedna zaokrąglona „pigułka”: „+” (załączniki — na razie
  niedostępne z podpowiedzią), pole „Message ‹Bot›” rosnące do kilku linii, przycisk wysyłki
  pojawiający się z tekstem (icon swap). Enter wysyła, Shift+Enter nowa linia; na klawiaturze
  dotykowej Enter to nowa linia. Mikrofon pominięto (nic nie robi). Twoja wiadomość jest
  widoczna od razu („Sending…”), błąd wysyłki daje „Send again” z tym samym `client_request_id`.
- **Przewijanie**: czat podąża za nową treścią (wiadomości, karty, status) tylko gdy jesteś
  na dole (ResizeObserver); przewinięty w górę pokazuje przycisk „Jump to the latest message”.
  Etykiety `sr-only` są pozycjonowane względem przewijanego logu — wcześniej wydłużały
  dokument i przewijała się cała strona.
- **Ruch**: nowe wpisy wchodzą przez `rise` (tylko te, które przyszły po otwarciu czatu),
  status przez `rise`/`swap`, przycisk wysyłki przez `iconSwap`, akcje przez opacity z
  opóźnieniem intencji — tokeny z `layout.css`/`motion.ts`. `prefers-reduced-motion`
  wyłącza przesunięcia, blur i shimmer.
- **Dostępność**: `role=log` rozmowy (polite), `role=status` dla stanu bota, karty jako
  regiony nazwane pytaniem/akcją, litery opcji jako skróty, cele dotykowe 48 px
  (`TouchTarget`) na urządzeniach dotykowych.
- **Tworzenie**: „Create bot” otwiera `CreateBotWizard`; `oncreate` zapisuje `CreateBot` i otwiera
  rozmowę. Adapter `botWizardInstances` (`features/bots/live.ts`) przekazuje tylko instancje
  endpointowe z modelami API (klucz `CLAUDE:id` / `CODEX:id`); własne modele z Settings →
  Providers działają bez workera. API komponentów: [bots-wizard.md](bots-wizard.md).
- **Sidebar**: przypięte boty jako duże awatary z gwiazdką i nazwą, potem rozmowy (awatar,
  nazwa, czas, podgląd przez `MarkdownSnippet`). Jedna wspólna lista (`bot-list.svelte.ts`,
  odświeżanie co 5 s i po `bots-changed`) dla sidebara i czatu. Pusty stan ma akcję
  „Create your first bot” (`/bots?create=1` otwiera wizard).

Wirtualizacji nie dodano: rozmowa z botem to zwykle dziesiątki wpisów, a `VirtualFeed` jest
zbudowany pod oś wątków (składanie tur, kotwice). Gdy historie urosną, rozmowa dostanie
stronicowanie po stronie API i wirtualizację.

## 8. Weryfikacja i dalsza faza

- Jednostkowe: `apps/gateway/src/bots/{policy,model}.test.ts`; decyzje zgód,
  przeskoki, opis statusu, protokoły, odrzucenie lokalnych możliwości oraz rozwiązywanie
  aliasów (`apiModel`).
- Integracyjne: `tests/integration/bots.test.ts`, prawdziwy PostgreSQL, skryptowany
  model i worker, lokalny serwer HTTP MCP wyłącznie w teście. Tworzenie i deduplikacja,
  wznowienie generacji, przerwane MCP bez powtórzenia, zgody/odrzucenie/pytania z opcjami,
  edycja zgody (`changes_requested`, nic nie wykonane), wymiana botów, powiadomienia workera
  po restarcie, przerwanie i usunięcie, aliasy przy zapisie i w runtime, `failed` i `RetryBot`.
- Live: `tests/integration/bots.live.test.ts` przez `useLiveProxy`: **Claude i Codex**
  odpowiadają na czacie, odmawiają lokalnego `ls`, tworzą wątek na prawdziwym workerze
  stosu testowego i dostają jego wynik jako nową turę. `bots-alias.live.test.ts`: prawdziwy
  katalog Claude przez CLIProxyAPI, wizard oferuje model rozwiązany z `default`, bot
  utworzony z `default` odpowiada, a bot z aliasem zapisanym w bazie również. Izolowane porty
  i katalogi przez `@open-agents/testing`; istniejący `/tmp/oa-stack` i jego porty nie są używane.
- Dowody izolacji harnessów: test przechwycenia requestu i live opisane w sekcji 1.
  Sekrety live pochodzą wyłącznie z pliku środowiska poza repozytorium; brak wartości
  w kodzie, commitach, wynikach testów i dokumentacji.
- UI: zgodnie z polityką testów brak testów jednostkowych i przeglądarkowych UI w repo.
  Weryfikacja ręczna w Chromium na jednorazowym stosie (gateway + PostgreSQL, skryptowany
  model, MCP „Notion”), 1440 i 390 px, jasny i ciemny motyw: brak przewijania dokumentu,
  wysyłka Enterem, karty, Edit, Retry, status, podążanie, widok wymiany, sidebar.

Dalej: edycja persony i polityk w osobnym panelu, zarządzanie MCP z rotacją nagłówków,
reakcje i odpowiedzi w API, liczniki nieprzeczytanych, załączniki, harmonogramy cykliczne
botów, kompakcja kontekstu, stronicowanie i wirtualizacja długich rozmów.
