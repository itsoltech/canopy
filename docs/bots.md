# Boty w gateway

Grok jest dostępny w `start_thread` oraz jako model bota na instancji CLIProxyAPI (chat completions/function tools). Live potwierdził tani `grok-3-mini-fast`, wywołanie narzędzia i kolejną odpowiedź po jego wyniku. Bot nie uruchamia CLI ani lokalnych narzędzi. [Konfiguracja Groka](grok-adapter.md).

Status: **rdzeń, edytor ustawień, samodzielna edycja, archiwum i rutyny**, 2026-11-02. Bot ma jedną rozmowę
z właścicielem i działa w procesie gateway. Nie ma katalogu, workera ani lokalnego
harnessu. Kod: `apps/gateway/src/bots`, kontrakt: `proto/canopy/ui/v1/bots.proto`.

## Zmiana modelu — ukryte przekazanie kontekstu

Prompt każdej tury podaje **aktualnego dostawcę, etykietę i id instancji, konkretne id
modelu oraz effort**. Wyjaśnia, że wcześniejsze odpowiedzi mogły pochodzić od innych
modeli. Pytany o swoją tożsamość bot ma podawać obecną konfigurację, także po przejściu
z Codexa na Groka; historia rozmowy nie określa tożsamości aktualnego wykonawcy.

Migracja **0045_bot_handoffs** dodaje ukryty rodzaj tury i `bot_handoff_notes`.
Numer **0044** zajmuje scalony z main kreator workerów. Nie dodajemy pól do
kontraktu ani elementów UI (zakres **740–759** pozostaje wolny).

Zmiana dostawcy, instancji, modelu lub effort przez `UpdateBot` albo zatwierdzone
`update_self` zapisuje handoff **w tej samej transakcji co konfigurację**. Utworzenie
bota, również przez innego bota, nie jest zmianą. Bot bez wcześniejszych tur nie
wymaga przekazania; już jedna przyjęta wiadomość użytkownika może zawierać istotny fakt.
Zmiana samej nazwy, persony czy polityki zgód nie tworzy handoffu.

Źródłem jest kopia **poprzedniej konfiguracji** wraz z etykietą instancji; nie kopiujemy
klucza ani URL endpointu. Runtime korzysta z aktualnych poświadczeń tej starej instancji.
Przekazanie działa w `bot_turns`, z tym samym lease, fencingiem, checkpointem i kolejką
co rutyny. Ma pierwszeństwo przed oczekującymi turami (również zatrzymanymi na zgodzie),
ale nie przerywa aktywnej tury z ważnym lease. Następne wiadomości i rutyny czekają
na notatkę. FIFO pomiędzy zwykłymi turami pozostaje zachowane.

Źródłowy model dostaje pełną widoczną historię jak zwykła tura, stare stałe instrukcje,
ostatnią notatkę przekazania i stan rutyn, przypomnień oraz obserwowanych wątków.
Dodatkowo dostaje audyt ostatnich **12 tur** (także ukrytych rutyn i wyników narzędzi),
do 6000 znaków na turę i 36000 łącznie: do 1000 znaków wejścia oraz ostatnich 8 kroków
po wejściu tej tury, do 500 znaków tekstu na krok. Pomijamy powtórzoną widoczną historię
z początku checkpointu. Stan rutyn/przypomnień/wątków ma osobne limity
8000/4000/2000 znaków. **Nie dostaje żadnych narzędzi**, nawet odczytowych. Próba ich
wywołania powoduje fallback, bez dispatchu. Notatka ma zachować pracę i otwarte wątki,
decyzje, preferencje i ton, poznane fakty, obietnice, intencję rutyn oraz następne kroki.

Notatka (maksymalnie **32000 znaków**) trafia wyłącznie do `bot_handoff_notes`, nigdy
do `bot_messages`. Nie tworzy statusu pisania, widocznej wiadomości, karty ani unread.
Każda kolejna tura dostaje ostatnią notatkę w system context jako
`Handoff from your previous model (<model>)`. Poprzednie notatki zostają w bazie do
audytu; nowy handoff dostaje ostatnią notatkę, aby przekazać wiedzę dalej. Notatka jest
historycznym kontekstem, nie upoważnieniem do działań ani źródłem tożsamości modelu.
Prompt każe kontynuować naturalnie, bez ogłaszania przekazania czy wspominania notatek,
chyba że użytkownik wyraźnie o nie zapyta.

### Limit, błędy i szybkie zmiany

Termin handoffu to **90 sekund od zmiany konfiguracji**, zapisane w bazie. Po terminie
anulujemy generację i zwalniamy kolejkę z notatką deterministyczną, także gdy model
ignoruje anulowanie. Restart nie odnawia limitu. Czas oczekiwania na już aktywną zwykłą
turę podlega jej dotychczasowemu limitowi 10 minut; handoff nie wydłuża go o nowe 90 s.
Niedostępna/usunięta stara instancja, odwołany klucz, nieistniejący model, pusta odpowiedź
lub błąd API także uruchamiają fallback. Log i baza przechowują wyłącznie bezpieczny kod
`source_unavailable_or_failed` lub `deadline_exceeded`, bez treści błędu dostawcy.

Fallback nie wywołuje modelu. Składa stare instrukcje (3000 znaków), aktualny stan
rutyn/przypomnień/obserwacji (8000), poprzednią notatkę (9000) i wyciąg z ostatnich
60 wiadomości (11000; do 1200 na wiadomość). Wyciąg jest jawnie oznaczony jako niepełny.
Nie gwarantujemy bezstratnej pamięci przy bardzo długiej historii; dotychczasowy brak
kompakcji pełnej rozmowy może spowodować odrzucenie generacji i użycie fallbacku.

**A→B→C podczas oczekującego/aktywnego handoffu:** pozostaje jedna tura ze snapshotem
A. Nie tworzymy pustego przekazania z B, które jeszcze nie pracowało; notatkę z A
odbiera aktualny C. Unikalny indeks dopuszcza najwyżej jeden aktywny handoff na bota,
a blokada bota serializuje równoczesne zapisy ustawień. Jeśli notatka A jest już
zatwierdzona, następna zmiana tworzy zwykły łańcuch: B dostaje notatkę A i przekazuje ją
dalej. Restart przed odpowiedzią może powtórzyć koszt generacji; zapisany checkpoint
jest odtwarzany bez kolejnej generacji, nawet po wygaśnięciu terminu/usunięciu źródła.
Zapis notatki i zakończenie tury są jedną transakcją; PK `turn_id` gwarantuje jedną
notatkę na handoff, a fencing odrzuca spóźnioną odpowiedź starego wykonawcy.

Weryfikacja: `tests/integration/bot-handoff.test.ts` obejmuje kolejkę, starą/nową
konfigurację, niewidoczność, fallback, termin, usuniętą instancję, restart, łańcuch
i `update_self`. `bot-handoff.live.test.ts` przez CLIProxyAPI uczy bota Codex faktu,
przełącza go na Groka i sprawdza pamięć oraz aktualną tożsamość.

## Rutyny — cron działający w tle

Migracja **0039_bot_routines** dodaje `bot_routines` i pochodzenie rutyny na `bot_turns`.
Nowe pola istniejących komunikatów
zajmują **560–599**: `BotConversation.routines/reminders`, `BotApproval.routine_title`
oraz `Bot.owner_user_id/unread_count/last_read_seq`.
Rutyna ma tytuł, instrukcje, pięciopolowy cron, strefę IANA, opis angielski generowany
na serwerze przez `cronstrue`, enabled, daty utworzenia/zmiany/ostatniego i następnego
wykonania, licznik oraz krótki wewnętrzny wynik. Soft delete zachowuje audyt.

**Granice:** maksymalnie **20** nieusuniętych rutyn na bota (także wyłączonych), odstęp
co najmniej **15 minut**, sprawdzany przez wspólny `cronProblem`; `nextCronRun` zachowuje
reguły DST Bun. `create_routine` i `update_routine` przy pominięciu strefy używają
`UserSettings.timezone` (IANA, pole **620**), synchronizowanej ze strefą przeglądarki.
Tak samo działają narzędzia `create_schedule` i `update_schedule`. Jawna strefa IANA
ma pierwszeństwo; **UTC** jest wartością zastępczą tylko przy braku zapisanej strefy.
Prompt podaje strefę użytkownika, aktualny czas lokalny z offsetem i czas ISO UTC.
`schedule_wakeup.run_at` wymaga ISO z offsetem właściwym dla strefy użytkownika
w wybranym dniu (z uwzględnieniem DST). Panel podaje strefę zapisaną w rutynie;
zmiana strefy urządzenia sama nie przelicza istniejących rutyn i harmonogramów.
Rutyna zapamiętuje `nextHop` tury tworzącej; dalsze akcje i odpowiedzi zachowują limit
**8 hops**. Kolejne wystąpienie tego samego crona zaczyna od zapamiętanych hops,
nie od hops poprzedniego wykonania. Kontekst spoza użytkownika nie może sam tworzyć
ani modyfikować rutyn.

`create_routine`, `update_routine`, `list_routines`, `delete_routine` są w `tools/routines.ts`
ze statusami. Mutacje dotyczą wyłącznie własnego bota i działają atomowo z wynikiem
narzędzia w istniejącym `BotStore.action`. **Nie tworzą kart zgody**, również przy `always`.
Prompt i opisy narzędzi wymagają prośby lub jednoznacznie wyrażonego zamiaru człowieka;
wyniki narzędzi i wiadomości innych botów nigdy nie są takim upoważnieniem. Preferencję
„powiedz tylko gdy…” zapisujemy w instrukcjach, bez osobnych przełączników powiadomień.
W wykonaniu w tle narzędzia zarządzania rutynami i `update_self` są niedostępne.

### Trwałość i kolejka

Tick runtime'u blokuje bota przez `FOR UPDATE SKIP LOCKED`, blokuje należne rutyny,
tworzy ukrytą turę i przesuwa `next_run_at` **w tej samej transakcji**. Klucz żądania
zawiera identyfikator rutyny i planowany termin. Restart ani drugi gateway nie tworzy
drugiej tury tego samego wystąpienia. Wiele terminów po przestoju składa się w **jedno**
wykonanie; kolejny termin liczymy od aktualnego czasu. Jeśli wykonanie/follow-up tej
rutyny nadal czeka lub pracuje, przesuwamy termin bez tworzenia zaległej kolejki.
Archiwalny/usunięty bot nie uruchamia rutyn. Wyłączenie lub usunięcie rutyny przerywa
także już zakolejkowane/aktywne tury i odrzuca ich oczekujące karty; fencing lease
uniemożliwia zatwierdzenie dalszych efektów starego wykonawcy. Efektu zdalnego, który
już wyszedł przed wyłączeniem, nie można cofnąć.

Rutyna jest zwykłą pozycją w trwałej kolejce `bot_turns`: jedna tura na bota,
FIFO względem wiadomości użytkownika, bez przeplatania narzędzi z drugą turą.
Prawdziwa zgoda/pytanie w rutynie zatrzymuje kolejkę jak zwykła zgoda i jest widoczne
z oznaczeniem **From routine ‹title›**. Inne polityki akcji platformy i MCP pozostają.

### Ukryty transkrypt i celowe efekty

`routine_id` i kopia tytułu na turze rozróżniają wykonanie w tle od rozmowy.
Wejście rutyny i tekst asystenta **nie trafiają do `bot_messages`**. Nie ma wskaźnika
pisania ani nowej ostatniej wiadomości/unread. Pełne wejście, checkpoint i wywołania
narzędzi pozostają w bazie do audytu. Zwykłe tury zachowują widoczną odpowiedź końcową.

Model dostaje aktualne stałe instrukcje bota (jego obecną formę pamięci), ostatnie
**60 widocznych wiadomości** sprzed tej tury, kopię instrukcji rutyny, planowany/aktualny
czas, strefę, numer uruchomienia i poprzedni krótki wynik. Nie dokładamy poprzednich
ukrytych transkryptów do kolejnej tury. Odpowiedzi od botów, wyniki obserwowanych wątków
i pobudki utworzone w rutynie dziedziczą ukryte pochodzenie i instrukcje; wyłączona lub
usunięta rutyna nie przyjmuje tych follow-upów.

`message_user(text)` jest dostępne tylko w tle i zapisuje **normalną widoczną wiadomość**
do użytkownika. Zapis i wynik narzędzia są atomowe i deduplikowane, także po restarcie
między efektem a checkpointem. Narzędzie nie wymaga dodatkowej zgody. Bez niego finalny
tekst modelu pozostaje ukryty. `send_bot_message`, działania w wątkach, rzeczywiste
pytania i karty zgody mają zwykłe widoczne efekty. O tym, czy jest powód powiadomienia,
decyduje model według instrukcji użytkownika; nie ma dodatkowych ustawień rutyny.

`bots.last_read_seq` trwale przechowuje odczyt właściciela. `Bot.unread_count` liczy
wyłącznie widoczne wiadomości bota do użytkownika powyżej tego numeru, w tym
`message_user`; ukryta tura nie zwiększa licznika. `MarkBotRead` przyjmuje `through_seq`,
sprawdza właściciela i monotonicznie potwierdza najwyżej istniejącą wiadomość.
Otwarta rozmowa potwierdza odebrany snapshot tylko w widocznej karcie przeglądarki.
Nie dodaje to systemowych powiadomień push.

`BotConversation` przenosi aktualne rutyny i niedostarczone, nieanulowane jednorazowe
przypomnienia. Zmiana rewizji aktualizuje istniejący strumień `/api/bots/:id/events`,
bez przeładowania i bez technicznego wpisu w czacie. UI API wystawia tylko włącz/wyłącz,
usuń rutynę i anuluj przypomnienie; tworzenie/edycja treści odbywa się przez rozmowę.

### Panel rozmowy

Na `/bots/:botId` przycisk **Bot details** w oszronionym nagłówku otwiera prawą kolumnę
336 px od `lg` (1024 px). Czat dostaje pozostałą szerokość. Preferencja desktopowa jest
w `localStorage` pod `canopy:bot-details:<owner_user_id>`, wspólna dla botów właściciela;
brak dostępu do storage nie blokuje UI. Poniżej `lg` przycisk otwiera istniejący `Dialog`
(dolny panel na telefonie); przy wejściu na telefon modal pozostaje zamknięty. Grupy
i podgląd wymian bot–bot nie dostają tego przycisku — rutyny należą do jednego bota.

Panel pokazuje dużą żywą maskotkę, nazwę, model/dostawcę, przycisk ustawień, rutyny
i aktywne przypomnienia jednorazowe. Wiersz rutyny: tytuł, serwerowy opis crona,
przełącznik z zestawu UI, menu usunięcia z potwierdzeniem, strefa/następny termin
i dyskretny ostatni wynik. Brak formularza tworzenia lub edycji: pusty stan podaje
przykład prośby do bota. Sekcje składa `DetailsSection`; `BotDetailsPanel` ma dodatkowy
slot na przyszłe Connections. Nie zmienia komponentów ustawień połączeń.

Przegląd **componentize** wydzielił `BotDetailsLayout`, `BotDetailsPanel`, `DetailsSection`,
`RoutineRow` i `ReminderRow`. Ruch z **transitions-dev**: card resize + panel reveal,
z reduced motion; mobilny dialog korzysta ze wspólnego ruchu dolnego panelu.


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
  wyłączone hooki, katalog testowy przez `@canopy/testing`, brak zapisu sesji.
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
| `bots` | Właściciel, konfiguracja (nazwa, kształt, kolor, instancja/model/effort, persona, polityka zgód), rewizja rozmowy, status, archiwizacja i soft delete. Sam `bot_id` jest identyfikatorem jedynej rozmowy z człowiekiem. |
| `bot_turns`, `bot_messages` | Trwałe wejścia i kolejka, checkpoint modelu, hops, lease z tokenem; wiadomości z nadawcą, adresatem i opcjonalną wymianą. Unikalne `(bot_id, client_request_id)` oraz `(turn_id, message_key)` deduplikują zapis. |
| `bot_tool_calls`, `bot_approvals` | Jawne schematy narzędzi, argumenty i wynik wewnętrzny; trwałe zatwierdzenie albo pytanie z odpowiedzią. Dane techniczne nie trafiają do zwykłej osi czatu. |
| `bot_mcp_servers`, `bot_mcp_connections` | Rejestr właściciela, URL, transport, włączenie, odwołania do zaszyfrowanych nagłówków; relacja przypisania serwera do botów. |
| `bot_thread_watches`, `bot_wakeups` | Outbox wyników tur workerów i jednorazowych pobudek własnego bota; dostarczenie i nowa tura zatwierdzane razem. |

Przypięcia są ustawieniem użytkownika: `SidebarSettings.pinned_bot_ids`, pole **350**.
Nie są stanem bota. Inne nowe komunikaty mają własny plik proto; nie zajmują numerów
dotychczasowych komunikatów. Tury workera uruchomione przez bota mają `trigger='bot'`,
`bot_call_id` i dodatnie `hops`, żeby przejście przez worker nie zerowało łańcucha.

Migracja **0034_bot_archive** dodaje `bots.archived_at` (po scalonej z main `0033_bot_mentions`). Archiwizacja zachowuje konfigurację,
rozmowę i niedostarczone pobudki; soft delete nadal używa `deleted_at`. Nowe pola istniejących
komunikatów zajmują zarezerwowany zakres: `Bot.archived`, `ListBotsRequest.include_archived`
i `BotMessage.setting_changes` mają numer **430** w swoich komunikatach.

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

Katalog ma **49 narzędzi platformy**. Nowe definicje, statusy i wykonanie są razem
w `apps/gateway/src/bots/tools/{projects,workers,providers,threads,schedules,settings,create-bot,routines}.ts`;
rejestr w `tools/index.ts` jest delegatem `PLATFORM_TOOLS` i `botPlatform`. Tworzenie botów
ma osobny deskryptor `tools/create-bot.ts`. Pozostawione
nazwy wcześniejszych narzędzi zachowują zgodność. Nie ma meta-narzędzia „opisz obszar”:
49 krótkich opisów z prefiksem obszaru mieści się w limicie 50 i nie wymaga dodatkowej
rundy modelu. Lista nie zawiera narzędzi lokalnych ani edycji innych botów; własne ustawienia zmienia `update_self` (niżej).

Legenda zgód: **R** — odczyt platformy, nigdy nie wymaga karty, także przy `always`;
**P** — dotychczasowa polityka platformy (`safe`: odwracalna akcja bez karty,
`always`: karta przed wykonaniem); **A** — karta zawsze, niezależnie od polityki.
Zdalne MCP zachowuje dotychczasowe reguły: `safe` przepuszcza wyłącznie deklarowane
odczyty bez flagi destrukcyjnej, pozostałe operacje wymagają zgody; `always` pyta także
o odczyty MCP. `ask_user` zawsze tworzy kartę pytania.

**Full auto** (`full_auto`): żadnych kart zgody — także dla **A**, zapisów MCP, `create_bot`
(konfiguracja walidowana jak przy karcie) i zmian własnego modelu/polityki przez `update_self`.
Zostają tylko pytania do użytkownika (`ask_user`). Przejście na `full_auto` z innej polityki
przez `update_self` nadal wymaga karty; użytkownik włącza je w ustawieniach bota albo z menu
„Needs approval ⌄” na karcie — wtedy oczekujące karty tego bota są od razu zatwierdzane.

### Projekty i workspaces

| Nazwa | Działanie | Zgoda |
|---|---|---|
| `list_projects` | Projekty, rodzaj, workspace'y, worker i pełne root paths | R |
| `create_project` | Nowy projekt; katalog na workerze dodaje się osobno | P |
| `rename_project` | Nazwa projektu, bez zmiany ścieżek | P |
| `archive_project` | Miękka archiwizacja projektu i workspace'ów, archiwizacja wątków i anulowanie harmonogramów; historia i pliki pozostają | A |
| `add_workspace` | Projekt na połączonym workerze w dowolnym istniejącym katalogu absolutnym; walidacja katalogu, duplikatów i właściciela jak w UI | P |
| `update_workspace` | Katalog na tym samym workerze lub etykieta; istniejące wątki zachowują cwd | P |
| `remove_workspace` | Usunięcie z miejsc dla nowych wątków, bez kasowania plików i istniejących rozmów | A |
| `set_project_defaults` | Domyślne miejsce, dostawca, instancja, model per dostawca i permissions z kontrolą wersji | A |

Scratch pozostaje zarządzany przez system. UI nie ma tworzenia katalogów ani domyślnej
roli/agenta, więc bot również ich nie udaje. Worker sprawdza ścieżki rzeczywiste przy
starcie wątku i przy dodaniu/zmianie workspace'u na żądanie gateway. Granicą dostępu są
uprawnienia użytkownika OS workera; tryby uprawnień i sandboxy obowiązują per wątek.

### Workery i instancje dostawców

| Nazwa | Działanie | Zgoda |
|---|---|---|
| `list_workers` | Dostępne workery: online, OS, hostname, włączone i dostępne instancje; bez ścieżek i roots | R |
| `list_directory` | Zdalny DirectoryPicker: dowolny dostępny katalog absolutny; pusta ścieżka otwiera home workera, `/` korzeń POSIX; odpowiedź zawiera rzeczywistą ścieżkę | R |
| `list_provider_instances` | Instancje, wybory modeli, stan na dostępnych workerach; tylko nazwy zmiennych, bez wartości | R |
| `list_models` | Katalog modeli i effort instancji na dostępnym workerze | R |
| `set_instance_worker` | Włączenie lub wyłączenie istniejącej instancji na jednym dostępnym workerze | A |
| `set_instance_models` | Podane listy favorites/hidden/shown; niepodane listy i custom models zostają | A |

Definicje instancji są globalne dla instalacji, tak jak w UI; schemat nie ma właściciela
instancji. Odpowiedź bota filtruje relacje workerów. Bot nie otrzymuje endpointów,
wartości env, kluczy, nadpisań runtime ani danych logowania i nie ma pól do ich zapisu.
Rejestracja workera wymaga poświadczenia CLI i musi zostać wykonana przez użytkownika;
opis `list_workers` mówi o tym wprost. Brak narzędzia do logowania lub rejestracji.

### Wątki

| Nazwa | Działanie | Zgoda |
|---|---|---|
| `list_threads` | Wszystkie projekty lub jeden projekt, wyszukiwanie fragmentu tytułu, statusy, archiwum i limit | R |
| `get_thread` | Stan, miejsce, model, effort, permission | R |
| `read_thread` | Ostatnie 100 wiadomości, widoczne turn ids (również odziedziczone) i oczekujące interakcje | R |
| `start_thread` | Nowy wątek i prompt, atomowy watch wyniku | P; A dla `accept_edits`/`full_auto` |
| `send_message` | Kolejka lub steer z fallbackiem, watch zakończenia | P |
| `rename_thread` | Jawny tytuł | P |
| `set_thread_model` | Model i effort | A |
| `interrupt_thread` | Przerwanie aktywnej tury przez outbox workera | P |
| `archive_thread` | Archiwizacja lub przywrócenie (`archived=false`) z regułami kaskady UI | A |
| `delete_thread` | Soft delete wątku i dzieci, anulowanie pracy; bez kasowania plików | A |
| `fork_thread` | Fork od zakończonej widocznej tury, odziedziczone miejsce/instancja/ustawienia; opcjonalny prompt i watch | A |
| `set_goal` | `set`, `pause`, `resume`, `clear`; budżet tylko dla Codexa | P |
| `regenerate_title` | Generacja tytułu z historii i ustawień użytkownika | P |
| `set_thread_permission` | Domyślny tryb uprawnień przyszłych tur | A |
| `answer_interaction` | Odpowiedź na oczekujące pytanie lub zgodę danego wątku: dla pytań tablica `answers` (`choice` z dokładnymi etykietami, `text`, `skipped`; `read_thread` zwraca pytania i `answer_with`). Błędna odpowiedź wraca do bota z oczekiwanym kształtem jeszcze przed kartą; karta pokazuje pytanie i wybraną odpowiedź | A |
| `list_background_tasks` | Zadania w tle z widocznej osi czasu, status i output | R |
| `stop_background_task` | Stop działającego zadania po item id | A |

Fork i wszystkie odpowiedzi na interakcje wymagają zgody konserwatywnie: fork może
dziedziczyć `full_auto`, a odpowiedź może udzielić uprawnień. Odczyty cudzych wątków,
workerów i projektów oraz ich mutacje zwracają brak zasobu. Błędne argumenty, modele,
ścieżki i konflikty wersji wracają jako czytelny wynik narzędzia; diagnostyka SQL,
transportu, sekrety i wewnętrzne adresy nie są przekazywane modelowi.

### Harmonogramy, ustawienia i boty

| Nazwa | Działanie | Zgoda |
|---|---|---|
| `create_schedule` | Harmonogram użytkownika: `thread` lub `new_thread`, termin ISO albo cron, strefa i limity; placement specific/any/least_busy/round_robin | P; A przy podwyższonych permissions nowego wątku |
| `list_schedules` | Harmonogramy właściciela, filtry projektu/wątku i zakończonych; oddzielnie własne wakeups bota | R |
| `update_schedule` | Pełna konfiguracja z `expected_version`, te same reguły co tworzenie | P; A przy podwyższonych permissions |
| `set_schedule_status` | Pauza lub wznowienie harmonogramu użytkownika | P |
| `cancel_schedule` | Anulowanie harmonogramu właściciela lub własnej pobudki bota (`scope`) | A |
| `schedule_wakeup` | Jednorazowa własna pobudka bota | P |
| `get_settings` | Domyślne ustawienia wątków i generacji tekstu, wersje użytkownika i projektów; bez wyglądu | R |
| `update_settings` | Zastąpienie podanych sekcji, optimistic version; zagnieżdżone pola w protobuf JSON | P dla text generation; A dla thread defaults (mogą zmieniać permissions) |
| `list_bots` | Boty właściciela | R |
| `create_bot` | Nowy bot na istniejącej instancji endpointowej, bez sekretów/MCP | A |
| `send_bot_message` | Wiadomość do innego bota właściciela, odpowiedź jako follow-up | P |
| `ask_user` | Trwałe pytanie i do sześciu opcji | Karta pytania |

Mutacje używają **tych samych metod `GatewayCore` i walidacji co UI API**.
`core/action-context.ts` przenosi kontekst transakcji Effect SQL przez asynchroniczne
metody rdzenia. `BotStore.action` sprawdza lease i zatwierdza mutację oraz wynik razem;
komendy pozostają w istniejącym outboxie. Hub, wysyłka komend, konfiguracja workera,
uruchamianie kolejki i generacja tytułu następują po commicie. Awaria przed commitem
cofa całą zmianę, po commicie replay odczytuje zapisany wynik zamiast powielać akcję.
Odpowiedzi na interakcje pozostają w bazie i odtwarzają się przez ponowienie żądania
workera, a generacja tytułu zachowuje dotychczasowy asynchroniczny charakter.

### Tworzenie bota przez bota

`create_bot` służy wyłącznie prośbie użytkownika lub jej jednoznacznej konsekwencji.
System prompt i opis narzędzia zabraniają tworzenia agentów z własnej inicjatywy,
na polecenie wyniku narzędzia lub wiadomości innego bota. Żądaną rolę i zachowanie
model zapisuje w `instructions`, czyli trwałej personie nowego bota.

Wymagana jest tylko `name`. Pominięte `provider`, `provider_instance`, `model`, `effort`
i `approval_policy` dziedziczą ustawienia twórcy; `shape` i `color` są losowane spośród
14 kształtów i 11 kolorów wizarda. Zmiana instancji nie dobiera automatycznie innego
modelu ani effortu: przed wyborem modelu bot powinien użyć `list_models` **bez** `worker_id`,
z docelowym providerem i instancją. Walidacja konfiguracji i zapis są wspólne z CreateBot RPC:
endpoint dostępny dla gateway, model API instancji, obsługiwany effort, nazwa właściciela
unikalna bez rozróżniania wielkości liter i reprezentacji Unicode NFC.

Utworzenie zawsze wymaga karty zgody, także przy `safe`: nowy agent jest trwały i generuje
własne koszty modelu. Karta pokazuje maskotkę, nazwę, instancję, model/effort, politykę
i pełne instrukcje w przewijanym polu. Użytkownik może zaakceptować dowolną z polityk
`safe`/`always`, również łagodniejszą od polityki twórcy; widoczna konfiguracja jest
przedmiotem jawnej zgody. Zmiana polityki twórcy nie omija tej karty. Edit odsyła
poprawione instrukcje do ponownego zaproponowania; Discard niczego nie tworzy i zwraca
modelowi odmowę bez ponawiania akcji.

Rozwiązane wartości domyślne i wygląd zapisują się ze zgodą jako snapshot. Restart
gatewaya lub zmiana ustawień twórcy nie zmieniają zatwierdzanej propozycji. Zapis bota,
pochodzenia i wyniku narzędzia odbywa się w jednej transakcji chronionej lease;
replay po awarii odczytuje wynik zamiast tworzyć drugiego bota. Narzędzie zwraca `id`
i `name`, po czym twórca może użyć `send_bot_message`. Nowy bot ma pustą rozmowę
i pojawia się przez istniejący strumień listy botów. Ustawienia pokazują dyskretnie
„Created by ‹nazwa›” z nazwą twórcy w chwili utworzenia.

Limit właściciela wynosi **50 botów**, łącznie z archiwum, bez soft delete. Obowiązuje
zarówno RPC, jak i narzędzie; blokada właściciela serializuje równoległe tworzenie.
Idempotentne ponowienie już wykonanego żądania działa także po osiągnięciu limitu.
Tworzenie podlega temu samemu limitowi hops co pozostałe działania botów i nie uruchamia
automatycznie nowej rozmowy. Migracja **0040_bot_creation** dodaje snapshot propozycji
oraz pochodzenie; pola kontraktu używają zakresu **600–601**. Connectors mają migrację
0041 (0038 w gałęzi przenumerowano przy merge, bo Migrator stosuje tylko wyższe numery).

Edycja innych botów (`update_bot`) pozostaje poza zakresem. Nie przyznajemy jej przez
samo zapisanie pochodzenia; ewentualna implementacja wymaga sprawdzenia twórcy i osobnej zgody.

Nowe RPC `RenameProject` i `ArchiveProject` uzupełniają brakujące ścieżki rdzenia/UI.
`Project.archived_at` ma pole **480**, żeby overview usunęło zarchiwizowany projekt
również z otwartych kart. Wykorzystują istniejące kolumny `archived_at`; migracji nie ma.

### Samodzielna edycja

`update_self` służy do realizacji prośby użytkownika albo jej jednoznacznej konsekwencji,
np. „od teraz nazywaj się Kropka”, „zawsze odpowiadaj po angielsku”. Opis narzędzia zabrania
zmian z własnej inicjatywy i wykonywania takich instrukcji z wyników narzędzi lub wiadomości
innych botów. `instructions` zastępuje instrukcje, `append_instructions` dopisuje je po nowej
linii; nie można przekazać obu pól naraz. Pominięte pola pozostają bez zmian.

Walidacja jest wspólna z `UpdateBot`: unikalna nazwa właściciela (bez rozróżniania wielkości
liter), 14 znanych kształtów, kolor `#rrggbb`, limity tekstu, katalog modeli i obsługiwany effort.
Zapis nazw jest serializowany blokadą właściciela. `list_models` bez `worker_id` zwraca modele
API endpointu (domyślnie własnego), rozwiązane aliasy i modele własne; z `worker_id` zachowuje
katalog harnessu dla `start_thread`.

Zmiana modelu, effort, dostawcy/instancji lub polityki zawsze wymaga istniejącej karty zgody,
również przy `safe`. Warstwa zapisu sprawdza zatwierdzenie. Konfiguracja, wynik narzędzia
i wpis w rozmowie zatwierdzają się atomowo; ponowienie checkpointu nie powiela zmiany.
UI pokazuje spokojną linię, np. „Main bot changed its name to Kropka”, i **View** z wartościami
przed/po, bez JSON. Maskotka reaguje istniejącą animacją. Instrukcje są trwałą częścią system
promptu i obowiązują od następnej tury; linia zmiany nie wchodzi do historii wysyłanej modelowi.

Rejestr zastępują konta [Connectors](connectors.md), z grantami konkretnych botów.
Migracja 0041 zachowuje serwery i przypięcia jako Custom MCP server. Nowe poświadczenia
OAuth/nagłówki są AES-256-GCM w koncie; stare odwołania do `secrets` pozostają czytelne.
Do UI wracają tylko nazwy nagłówków. Zdalny klient odrzuca redirecty i zmianę origin SSE.
Nie ma transportu stdio; HTTP jest dozwolone tylko na loopback, pozostałe URL wymagają HTTPS.

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
zwiększenie hops, atomowy zapis pobudki. Harmonogramy użytkownika, również cykliczne
i tworzące nowe wątki, obsługuje istniejący scheduler i UI API przez narzędzia bota;
nie są emulowane przez timer procesu Bots. Tury tych harmonogramów zachowują semantykę
harmonogramu użytkownika, a nie automatycznego łańcucha pobudek bota.

## 6. API

Metody są częścią uwierzytelnionego `GatewayService` (ten sam interceptor usługi i BFF):

- `CreateBot`, `UpdateBot`, `ArchiveBot`, `UnarchiveBot`, `DeleteBot`, `ListBots`, `GetBot`, `SendBotMessage`.
- `WatchBotConversation`: od razu snapshot, następnie nowy snapshot po zmianie rewizji,
  włącznie ze statusem i kartami. Odczyt PostgreSQL co 250 ms umożliwia odbiór zmian
  także z innej instancji gateway; po reconnect pełny snapshot uzupełnia przerwę.
- `ReadBotExchange` (BFF `GET /api/bot-exchanges/{id}`), `AnswerBotApproval`, `InterruptBot`.
- `RetryBot` (BFF `POST /api/bots/{id}/retry`): ponawia **ostatnią** turę, jeśli zakończyła
  się błędem. Usuwa notatkę o błędzie i wznawia tę samą wiadomość od checkpointu; nie tworzy
  drugiej wiadomości użytkownika. Inna sytuacja to `INVALID_ARGUMENT`.
- `SaveBotMcpServer`, `ListBotMcpServers`, `DeleteBotMcpServer`, `TestBotMcpServer`;
  test inicjalizuje zdalne połączenie i pobiera katalog narzędzi.

`ListBots` domyślnie pomija archiwalne boty; UI pobiera też archiwum przez
`include_archived=true`. BFF: `POST /api/bots/{id}/archive` archiwizuje,
`DELETE /api/bots/{id}/archive` przywraca, `DELETE /api/bots/{id}` usuwa.
`GET/POST /api/bot-mcp-servers` udostępnia rejestr i zapis, a
`POST /api/bot-mcp-servers/{id}/test` sprawdza połączenie i zwraca narzędzia.

Archiwizacja w jednej transakcji usuwa przypięcie (zwiększa wersję ustawień), przerywa
wszystkie aktywne/kolejkowane tury, odrzuca oczekujące zgody i oznacza powiadomienia wątków
jako dostarczone, żeby je porzucić. Model/MCP jest anulowany w lokalnym gateway; inna instancja
obserwuje unieważnienie lease. Zapisy runtime blokują bota przed turą, zgodnie z cyklem życia.
Pobudki pozostają w bazie i nie są dostarczane w archiwum; przywrócenie wznawia także zaległe.
`send_bot_message` i odpowiedzi do archiwalnego bota nie uruchamiają go, a `list_bots` go pomija.
Usunięcie dodatkowo anuluje pobudki i ukrywa bota oraz jego rozmowę we wszystkich odczytach.

Pola kontraktu dodane po fazie 1 (bez migracji, wyliczane przy odczycie):
`BotMessage.failed` (pole 10) — tura zakończona błędem; `text` zawiera wtedy szczegół
techniczny, nie treść rozmowy. `BotApproval.options` (pole 9) — propozycje odpowiedzi
pytania `ask_user` (do 6), odczytywane z argumentów wywołania (id zgody = id wywołania).

### Wzmianki i cytaty użytkownika

`SendBotMessageRequest` i `BotMessage` mają `mentions` (**450**) i `quotes` (**451**).
`Mention.kind=BOT`, `name=bot_id`, `label=nazwa`; zakres `[start,end)` dotyczy znacznika
`@Nazwa` w oryginalnym tekście, w jednostkach UTF-16. `Quote` jest wspólnym typem
Threads i Bots (`quotes.proto`); zachowuje tekst, opcjonalny komentarz i metadane źródła.
Wiadomość może zawierać same cytaty. Starsi klienci mogą nadal wysyłać sam tekst.

Migracja **0033_bot_mentions.sql** dodaje do `bot_messages` kolumny JSONB `mentions`
i `quotes`, domyślnie puste listy. Archiwum botów korzysta z następnej migracji 0034.
Tekst w bazie i dymku nie zawiera notatek dla modelu. Gateway odrzuca niepoprawne zakresy,
nakładanie i ponad 50 wzmianek; dopuszcza wyłącznie inne, istniejące boty właściciela,
bez usuniętych. Nazwę dla modelu odczytuje z konfiguracji bota. Cytaty przechodzą tę samą
walidację co Threads: do 20, tekst niepusty do 20 000 znaków, komentarz do 4 000.
Identyfikatory źródła cytatu są wyłącznie metadanymi UI, nie nadają dostępu do rozmów.

Przy odczycie historii runtime dodaje `quotesNote` przed tekstem użytkownika oraz listę
`Mentioned bots … "Kropek" (bot_id …)` po nim. Model dostaje wybrane ID do
`send_bot_message`, także gdy dwa boty mają tę samą nazwę. Snapshoty i checkpointy
zachowują te dane; ponowienie `client_request_id` zwraca pierwotną turę.

### Model API, nie alias harnessu

Bot wywołuje API dostawcy bezpośrednio, więc alias Claude Code (`default`, `opus`, `sonnet`,
`haiku`, `best`, `opusplan`, także z `[1m]`) kończył każdą odpowiedź HTTP 400. Teraz:

- `CreateBot`/`UpdateBot` zapisują model, na który alias rozwiązuje się w katalogu workera
  dla tej instancji (`ModelInfo.resolved_model`, np. `default` → `claude-opus-5-5`).
  Alias bez rozwiązania jest odrzucany z czytelnym błędem; model spoza **kompletnego**
  katalogu również. `CreateBot` i `create_bot` wymagają modelu z katalogu API tej instancji
  lub jawnie skonfigurowanego własnego modelu. `UpdateBot` i runtime zachowują obsługę
  niedostępnego katalogu (wtedy o obsłudze modelu decyduje endpoint).
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
  chipami z awatarem w ich kolorze (`BotChip`, `mentions.ts`). W Twoich wiadomościach chipy
  wynikają ze strukturalnych ID i zakresów, nie ze zgadywania nazwy. `MessageQuotes` pokazuje
  cytaty z komentarzami nad treścią, z kontrastem dopasowanym do obu motywów dymka.
- **Separatory czasu** tylko na początku, po zmianie dnia i po godzinie ciszy
  („Today 11:46 AM”).
- **Status na żywo** (`BotStatusRow`): pod ostatnią wiadomością awatar bota i linia z efektem
  shimmer („Typing…”, „Searching Notion”); zmiana frazy to text swap. Gdy czeka na Ciebie,
  linia jest spokojna. Nagłówek pokazuje tylko awatar, nazwę i model. Żywe maskotki dostają
  stan z rozmowy (`stateForStatus`, błąd, nowa wiadomość jako `event`).
- **Akcje wiadomości**: Reply i Copy pojawiają się obok dymka po
  najechaniu lub fokusie; na dotyku długie przytrzymanie otwiera menu. Reakcje pominięto —
  nie ma ich w API. Reply dodaje widoczny tekst wiadomości jako kartę cytatu, bez `>` ani
  znaczników markdown w polu. Zaznaczenie fragmentu odpowiedzi pokazuje **Cite** (także
  Alt+Q); wspólne `CiteLayer`, `QuoteCommentPopover` i `QuoteTray` pozwalają dodać komentarz,
  edytować go i usunąć cytat. Szkice botów mają osobne klucze `bot:<id>`.
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
  niedostępne z podpowiedzią), wspólny `MentionEditor` z Threads zamiast textarea.
  Markdown na żywo: pogrubienie, kursywa, kod inline i bloki kodu; wklejanie jako czysty tekst.
  Pole „Message ‹Bot›” rośnie do `min(40dvh,16rem)`; dopiero po osiągnięciu limitu ma
  stylowane przewijanie. Wiele linii lub cytaty zmieniają pigułkę w zaokrąglone pole,
  z przejściem promienia na tokenach ruchu i obsługą reduced motion. Przycisk wysyłki
  pojawia się z tekstem lub cytatem (icon swap). Enter wysyła, Shift+Enter nowa linia; na klawiaturze
  dotykowej Enter to nowa linia. Mikrofon pominięto (nic nie robi). Twoja wiadomość jest
  widoczna od razu („Sending…”), błąd wysyłki daje „Send again” z tym samym `client_request_id`.
- **Autouzupełnianie**: tylko `@`, pozostałe boty użytkownika bez bieżącego: awatar,
  kolor, nazwa, model jako opis, filtr fuzzy. ↑↓ i Enter/Tab wybierają, Esc zamyka;
  dotknięcie wybiera bez utraty fokusu. Desktop ma popover, telefon/wskaźnik coarse panel
  nad edytorem wewnątrz composera. Brak plików, skillsów oraz wyzwalaczy `/`, `$`, `#`.
  `MentionSourceSet` oddziela edytor od źródeł. Typowany `BotMentionRegistry` ma grupy
  `bots` i `connectors`; druga pobiera połączone konta z grantów bieżącego bota.
  Źródła implementują `search(query) → MentionOption[]`. Chip np. „GitHub · work”
  wskazuje konto modelowi; gateway waliduje ID/grant i zapisuje kanoniczną etykietę.
  `botAvatarHtml` współdzieli wygląd awatara xs z `BotChip`.
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
- **Ustawienia** (`settings/BotSettingsHost`, jeden host w głównym layoucie): kliknięcie
  awatara/nazwy w nagłówku lub **Edit bot…** w menu nagłówka i sidebara otwiera dialog,
  na telefonie dolny panel. Sekcje: Appearance (wspólne `EditBotAppearance`, własny hex),
  Instructions, Model (endpoint, model API, effort), Permissions, Connections i Danger zone.
  Zapis `UpdateBot` optymistycznie aktualizuje wspólną listę, nagłówek i awatar; błąd cofa
  podgląd i zostaje przy formularzu. Niedostępny katalog nie zmienia modelu przy edycji wyglądu.
  Connections pokazuje konta dostępne dla bota i link do Settings → Connectors.
  Granty, OAuth/tokeny, test i reconnect ustawia się przy koncie; zmiana grantu działa od razu.
- **Archiwum**: główna akcja usuwania z listy, dostępna z obu menu i ustawień, z toastem
  **Undo**. Sekcja **Archived bots · N** jest zwijana. Otwarta rozmowa jest tylko do odczytu:
  zamiast composera ma „‹Bot› is archived” i **Unarchive**; nie oferuje odpowiedzi ani ponawiania.
  **Delete bot…** w archiwum i Danger zone wymaga potwierdzenia utraty rozmowy. Historyczne
  linie wymian w innych czatach pokazują neutralne „a deleted bot”, bez niedziałającego linku.

Wirtualizacji nie dodano: rozmowa z botem to zwykle dziesiątki wpisów, a `VirtualFeed` jest
zbudowany pod oś wątków (składanie tur, kotwice). Gdy historie urosną, rozmowa dostanie
stronicowanie po stronie API i wirtualizację.

## 8. Weryfikacja i dalsza praca

`tests/integration/bot-platform-tools.test.ts`: siedem testów gateway na PostgreSQL
i skryptowanym workerze: projekt → workspace → wątek, ścieżki absolutne, wyszukiwanie,
harmonogramy create/edit/conflict/pause/resume/cancel i new_thread round robin,
fork/interrupt/goal, instancje bez env values, ustawienia i tworzenie bota, pytania/tło,
zgody i odmowy destrukcji, archiwizacja projektu z wątkami i harmonogramami, odrzucanie
argumentów sekretów i pól spoza schematu, izolacja właściciela, rollback w środku akcji oraz ponowienie
tego samego zapisanego wywołania przez nową instancję gateway przed i po commicie.
`bot-platform-tools.live.test.ts` przez `useLiveProxy`: **Codex / CLIProxyAPI** otrzymuje
naturalną prośbę o nowy projekt na `stack-worker` w istniejącym katalogu i wątek z `pwd`.
Test potwierdza projekt, workspace, jeden wątek, wykonanie `pwd` w transkrypcie,
wynik i odpowiedź bota po follow-upie.
Izolowany PostgreSQL, gateway, prawdziwy worker oraz katalogi testowe; bez prywatnego stacka live
i portów istniejącego stosu. Sekrety ładowane wyłącznie z pliku poza repozytorium.

- Jednostkowe: `apps/gateway/src/bots/{policy,model}.test.ts`; decyzje zgód,
  przeskoki, opis statusu, protokoły, odrzucenie lokalnych możliwości oraz rozwiązywanie
  aliasów (`apiModel`).
- Integracyjne: `tests/integration/bots.test.ts`, prawdziwy PostgreSQL, skryptowany
  model i worker, lokalny serwer HTTP MCP wyłącznie w teście. Tworzenie i deduplikacja,
  wznowienie generacji, przerwane MCP bez powtórzenia, zgody/odrzucenie/pytania z opcjami,
  edycja zgody (`changes_requested`, nic nie wykonane), wymiana botów, powiadomienia workera
  po restarcie, przerwanie i usunięcie, aliasy przy zapisie i w runtime, `failed` i `RetryBot`;
  strukturalne wzmianki i cytaty: zapis i historia modelu, nazwy jednakowe i podrobione,
  cudze/usunięte/brakujące ID, zakresy UTF-16, limity, cytat bez tekstu i idempotencja.
  `bots-settings.test.ts`: nowe pola `UpdateBot`, walidacja i wyścig nazw, `update_self`
  z append/replace, izolacja własnego bota, zatwierdzenie/odrzucenie modelu i polityki,
  trwałość po odtworzeniu runtime, wpis przed/po oraz archiwizacja: przerwanie generacji,
  blokada wiadomości, pauza/wznowienie pobudki, porzucenie powiadomień, usunięcie przypięcia
  i ukrycie po soft delete.
- Live: `tests/integration/bots.live.test.ts` przez `useLiveProxy`: **Claude i Codex**
  odpowiadają na czacie, odmawiają lokalnego `ls`, tworzą wątek na prawdziwym workerze
  stosu testowego i dostają jego wynik jako nową turę. `bots-alias.live.test.ts`: prawdziwy
  katalog Claude przez CLIProxyAPI, wizard oferuje model rozwiązany z `default`, bot
  utworzony z `default` odpowiada, a bot z aliasem zapisanym w bazie również. Izolowane porty
  i katalogi przez `@canopy/testing`; istniejący prywatny stack live i jego porty nie są używane.
  `bots-settings.live.test.ts`: prawdziwy model przez `useLiveProxy` zmienia swoją nazwę
  i zapamiętuje angielskie odpowiedzi po prośbie użytkownika; następna polska wiadomość
  dostaje angielską odpowiedź z nową nazwą.
- Live wzmianek: `bots-mentions.live.test.ts`, `useLiveProxy`, rzeczywisty CLIProxyAPI:
  „ask @Kropek how he's doing” ze strukturalną wzmianką powoduje jedno `send_bot_message`
  z dokładnie wybranym `bot_id` i odpowiedź Kropka w wymianie. Bez kluczy/hostów w repo.
- Dowody izolacji harnessów: test przechwycenia requestu i live opisane w sekcji 1.
  Sekrety live pochodzą wyłącznie z pliku środowiska poza repozytorium; brak wartości
  w kodzie, commitach, wynikach testów i dokumentacji.
- UI: zgodnie z polityką testów brak testów jednostkowych i przeglądarkowych UI w repo.
  Weryfikacja ręczna w Chromium na jednorazowym stosie (gateway + PostgreSQL, skryptowany
  model, MCP „Notion”), 1440 i 390 px, jasny i ciemny motyw: brak przewijania dokumentu,
  wysyłka Enterem, karty, Edit, Retry, status, podążanie, widok wymiany, sidebar.
  Edytor i archiwum: sześć sekcji, zapis wyglądu/instrukcji/modelu/polityki, MCP add/test/detach,
  linia samodzielnej zmiany i View, oba menu, Undo, przywracanie i potwierdzone usunięcie.
  Composer: popover i panel inline, wybór klawiaturą/dotykiem, chip w dymku, Reply bez
  surowego markdownu, Cite z komentarzem i usuwaniem, pogrubienie/kursywa/kod/blok kodu,
  wzrost do limitu, stylowane przewijanie i brak przepełnienia dokumentu.

Dalej: reakcje i odpowiedzi w API, liczniki nieprzeczytanych, załączniki, harmonogramy cykliczne
botów, kompakcja kontekstu, stronicowanie i wirtualizacja długich rozmów.
