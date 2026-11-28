# Współdzielone połączenia proxy

Aktualizacja (2026-11-28): datowane odczyty okien Codexa dla kont OAuth
CLIProxyAPI z potwierdzoną tożsamością mogą zasilać alerty o odnowieniu limitu.

Status: opis zaimplementowanego zachowania (2026-11-25), w tym konta i limity proxy
w szczegółach wybranej instancji Providers w web/desktop, wznowienie tury
Claude po niedostępnym katalogu modeli proxy podczas startu, aktywny odczyt limitów
Claude, wybór odczytów kont i modeli CLIProxyAPI, wyrównanie tożsamości kont
oraz odświeżanie powiązań proxy po zmianie lub usunięciu instancji w web/desktop.
Codex ponawia krok przerwany przez zerwanie strumienia proxy w bieżącej turze.
Aktualizacja (2026-11-24): web/desktop grupuje konta CLIProxyAPI w zakładce **Upstream accounts**.
Okna limitu Claude niosą czas obserwacji upstream wykorzystywany przez
[powiadomienia o odnowieniu](notifications.md#kiedy-powiadamiamy).
Dostępność nightly/beta/stable wynika
z promocji wydań ([release.md](release.md)).

Settings → **Proxies** przechowuje połączenie raz: nazwę, rodzaj, URL, zaszyfrowany
sekret i opcje transportu Codexa. W Settings → Providers połączenie instancji to
**Device login** albo **Proxy** z pickerem zapisanych połączeń i przyciskiem **Add proxy**.
Nadpisanie workera może wskazać inne proxy albo odziedziczyć wybór instancji.

## Presety i mapowanie

URL może kończyć się `/v1` albo nie. Gateway usuwa końcowe `/v1` i slash; zachowuje
prefiks ścieżki reverse proxy. URL nie może zawierać loginu, hasła, query ani fragmentu.

| Rodzaj | Claude | Codex | Grok |
| --- | --- | --- | --- |
| CLIProxyAPI lub fork | Anthropic Messages | OpenAI Responses | OpenAI Chat Completions |
| Anthropic-compatible | Anthropic Messages | Niedostępny w tym presecie | Niedostępny w tym presecie |
| OpenAI-compatible | Niedostępny | OpenAI Responses | OpenAI Chat Completions |

- Claude otrzymuje root w `ANTHROPIC_BASE_URL`, sekret w `ANTHROPIC_AUTH_TOKEN`
  i pusty `ANTHROPIC_API_KEY`; OAuth urządzenia jest usuwany z env procesu.
- Codex zachowuje izolowany `CODEX_HOME` platformy. Parametry `-c` tworzą
  `model_providers.canopy_<id>`: `base_url=<root>/v1`, `wire_api=responses`,
  `env_key=CANOPY_<ID>_API_KEY`, `requires_openai_auth=false`. Wątek wybiera ten
  provider przez `thread/start.modelProvider`. To równoważne polom `config.toml`
  z poradnika CLIProxyAPI, bez modyfikacji konfiguracji urządzenia i bez klucza w pliku
  lub argv. Nowe połączenia domyślnie używają HTTP/SSE. Zaawansowane ustawienia
  pozwalają jawnie włączyć WebSockets i dodać publiczne nagłówki routingu. Bieżący Codex obsługuje wyłącznie
  `responses`; inna wartość `wire_api` jest odrzucana. Nagłówki auth, cookies i kluczy
  są odrzucane; sekret ma osobne pole.
- Grok 1.0.70 (`f50904eaee6c`) obsługuje własne endpointy:
  `grok agent --help` pokazuje `--xai-api-base-url`; dołączone do CLI
  `user-guide/11-custom-models.md` opisuje `[model.<id>]`, `base_url`, `env_key`
  oraz backendy. Adapter używa prywatnego `GROK_HOME`, `<root>/v1`,
  `api_backend=chat_completions`, `env_key=CANOPY_GROK_API_KEY`. Ten sam sekret
  trafia do `XAI_API_KEY`, wymaganego przez guard logowania CLI. Sekret nie trafia
  do configu, argv ani stderr; konfiguracja modelu jest usuwana po procesie.
  Anthropic-compatible jest predefiniowanym połączeniem Claude; nie rozszerzamy
  tutaj adaptera Groka o backend `messages`.

Źródła: [adapter Groka](grok-adapter.md), [oficjalne ACP/headless](https://docs.x.ai/build/cli/headless-scripting),
[routing CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/server_routes.go).

### Ponawianie kroku Codexa

Po zamknięciu strumienia przed `response.completed` Codex wysyła kolejne żądanie
Responses z historią bieżącej tury, w tym z wynikami wykonanych narzędzi.
Obejmuje to wątki, subagentów i boty. Ponowienie zachowuje turę i jej wejście.

- Przy domyślnym HTTP/SSE krok ma **10 prób łącznie**. Pierwsza przerwa trwa
  około 200 ms, kolejne są dwukrotnie dłuższe. Codex dodaje losowe odchylenie
  i uwzględnia podany przez serwer termin ponowienia.
- Przy włączonym **Supports WebSockets** Codex ma do pięciu prób przez WebSocket.
  Po wyczerpaniu tego limitu przechodzi na HTTP z budżetem pięciu prób. Jeżeli
  połączenie już korzysta z transportu zapasowego, obowiązuje limit pięciu prób HTTP.
- Worker ustawia dla proxy `stream_max_retries` na 9 (HTTP) lub 4 (WebSocket),
  `request_max_retries=0` i `features.unbounded_connection_retries=false`.
  Jedna pętla w CLI rozlicza ponowienia kroku. Stop przerywa także oczekiwanie.
  Device login korzysta z domyślnych ustawień wbudowanego providera `openai`.

Zdarzenia ponawianego połączenia zostają w surowym transkrypcie. Ostateczny błąd
trafia do wyniku tury. Mechanizm CLI opisują [obsługa strumienia](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/responses_retry.rs)
i [obliczanie czasu oczekiwania](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/async-utils/src/backoff.rs).

### Codex: przerwanie odpowiedzi przez proxy

Canopy wysyła do app-servera `turn/steer` (nowe wejście do działającej tury)
albo `turn/interrupt` (Stop). Steer nie jest implementowany jako Stop + nowa tura.
Sam Codex 0.164.0 wysyła przez transport Responses WebSocket ramkę
`response.interrupt` z id odpowiedzi i `mode = discard_partial_items`.
Dotyczy to także wyprzedzającego dostarczenia steera (`instant_interrupt`, domyślnie włączone).
Platformowe notatki o zakończeniu zadań w tle również dostarcza `turn/steer`;
mogą więc uruchomić ten mechanizm Codexa bez naciśnięcia Stop. Cele Codexa używają
`thread/goal/set` lub `thread/goal/clear`, a ich kontynuacje nie wysyłają Stop.
Źródło: [transport Codexa](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/responses_websocket.rs).

CLIProxyAPI v8.0.22 ma wyścig na granicy zakończenia odpowiedzi: gdy upstream
już zakończył pracę, ale klient nadal czeka na jej koniec, kontrolna ramka może
dostać 400 `no active upstream websocket for response.interrupt`. Ten błąd może
zostać w kolejce po starej odpowiedzi i zepsuć następną. Nie dowodzi awarii
klucza lub modelu ani braku obsługi WebSockets w ogóle. Rozpoznany upstream:
[zgłoszenie #6483](https://github.com/router-for-me/CLIProxyAPI/issues/6483),
[kontrola aktywnego połączenia](https://github.com/router-for-me/CLIProxyAPI/blob/6746588/internal/runtime/executor/codex_websockets_executor.go),
[obsługa ramki](https://github.com/router-for-me/CLIProxyAPI/blob/6746588/sdk/api/handlers/openai/openai_responses_websocket_input.go).
Bez wersji proxy i zdarzeń konkretnego wątku nie można potwierdzić, że właśnie
ten wyścig wywołał pojedynczy incydent.
Liczba kart na telefonie nie dowodzi liczby wywołań interrupt: dawny nieturowy
ogon osi pokazywał ostatnie trzy komunikaty. Przy ustalaniu przyczyny trzeba
porównać surowe zdarzenia i dostarczenia steerów, bez danych profilu ani kluczy.

HTTP/SSE omija te ramki, zachowując `turn/steer` i Stop. Zapisany jawny wybór
WebSockets pozostaje respektowany; w istniejącym proxy z tym błędem wyłącz
**Supports WebSockets** w Settings → Proxies. Zmiana działa po drain instancji.
**Test connection** sprawdza katalog modeli, nie potwierdza zgodności ramek
kontrolnych. Nie ignorujemy rzeczywistego `turn/completed.status = failed`.

## Test połączenia

**Test connection** wykonuje z gateway `GET <root>/v1/models`: Bearer dla
CLIProxyAPI/OpenAI albo `x-api-key` i `anthropic-version` dla Anthropic.
Pokazuje liczbę modeli, status HTTP albo zredagowany błąd sieci. Nie wykonuje tury LLM.
To liczba modeli pośrednika, nie lista wyboru każdego harnessu. Worker osobno buduje
katalog instancji, filtrując rodzinę i protokół: Claude → Anthropic Messages,
Codex → OpenAI/Responses (również zgodne modele xAI), Grok → xAI Chat Completions.
Własne modele instancji pozostają dostępne. Źródła metadanych i zachowanie przy ich
braku: [protocol.md](protocol.md#modele-effort-i-steer).
Przekierowania są odrzucane, aby klucz nie trafił do innego hosta. Rozpoznanie
CLIProxyAPI wymaga dodatniego markera nagłówka lub publicznego root JSON
`message = "CLI Proxy API Server"`; dodatkowe zapytanie root nie wysyła sekretu.
Brak markera nie oznacza braku kompatybilności. Surowe body błędu nigdy nie wraca do UI.

Worker Claude oznacza listę modeli jako niepełną, gdy odczyt `GET /v1/models`
się nie uda albo katalog Claude nie zawiera wszystkich zgodnych modeli z proxy.
Druga sytuacja może wystąpić, gdy sieć wróci między odczytem Claude a odczytem
workera. Po powrocie sieci **Retry** może wznowić turę z zapisanym modelem na
skonfigurowanym proxy, nawet jeśli modelu zabrakło w tym raporcie. Odświeżenie
listy modeli ponawia jej odczyt. **Refresh** w sekcji **Accounts** aktualizuje
osobny stan kont z Management API.

## Dane, migracja i bezpieczeństwo

Migracja `0061_proxies` dodaje `proxies` z `owner_user_id`, `secret_id` (FK do
`secrets`), metadanymi i rewizją oraz FK `proxy_id` w definicjach i nadpisaniach
instancji. Sekret jest szyfrowany istniejącym AES-256-GCM i kluczem gateway.
Odczyty, edycja, test i usunięcie filtrują właściciela; zapis profilu sprawdza
właściciela wskazanego proxy i zgodność z harnessem. Profile proxy właściciela
nie trafiają do workerów innego właściciela. UI otrzymuje tylko `secret_set`;
**Replace** wysyła nową wartość, pominięcie sekretu zachowuje obecną.

Przy starcie i synchronizacji gateway transakcyjnie konwertuje dotychczasowe
instancje `CLIPROXYAPI` oraz endpointowe nadpisania workerów. Deduplikacja porównuje
HMAC znormalizowanego URL i odszyfrowanego klucza, z osobnym zakresem właściciela.
Różne zaszyfrowane kopie identycznego klucza dają jedno proxy. Sekrety nie opuszczają
gateway podczas konwersji. Identyfikatory instancji i wątków pozostają bez zmian.
Pola kompatybilności `base_url`/`api_key` instancji są projekcją proxy dla botów
i istniejącego protokołu udostępniania konfiguracji między komputerami. Nie stanowią
osobnego źródła ustawień. Ponowna synchronizacja niczego nie duplikuje.

Zmiana proxy generuje nowe wersje konfiguracji jego workerów. Istniejący protokół
dostarcza odszyfrowany klucz wyłącznie w `WorkerConfig`, przez uwierzytelnione łącze,
do pamięci workera i env procesu harnessu. Raporty, logi, pliki konfiguracji i odpowiedzi
UI nie zawierają wartości. Sekrety proxy nie są poświadczeniami connectorów; tamte
nadal pozostają wyłącznie w gateway.

Tworzenie, edycja, wymiana sekretu, migracja, przeniesienie env i usunięcie zapisują
audyt `proxy.*` bez URL, klucza i body żądania. Usunięcie proxy używanego przez
instancje lub nadpisania jest blokowane z listą referencji; najpierw wybierz inne
połączenie w tych profilach. FK zamyka wyścig z równoczesnym przypięciem.

Sygnatura strumienia proxy uwzględnia referencje instancji i nadpisań workerów
oraz nazwy workerów. Dodanie, przepięcie lub usunięcie powiązania wywołuje
`proxies_changed`, które odświeża współdzielony odczyt `ListProxies` w BFF
i klientach. Po usunięciu ostatniej instancji lista **Used by** jest pusta,
a **Delete** staje się dostępne bez przeładowania aplikacji. Obejmuje to również
kaskadowo usuwane nadpisania workerów i zmiany zapisane przez inny proces gatewaya.

## Wbudowany login i ręczne zmienne

Każda instancja, także wbudowane `native` i instancja z wątkami, pozwala przełączać
**Device login** ↔ **Proxy** w miejscu. Proxy wybiera się z zapisanej listy; **Add proxy**
otwiera formularz bez opuszczania instancji. Id i katalog sesji zostają te same.
Trwające tury i zadania kończą się na poprzedniej konfiguracji; nowa praca czeka na
drain i uruchamia się z nowym połączeniem ([worker-config.md](worker-config.md#6-zmiana-na-żywo)).

**Move to a proxy** wykrywa `ANTHROPIC_BASE_URL` z `ANTHROPIC_AUTH_TOKEN`/
`ANTHROPIC_API_KEY`, a dla Codexa `OPENAI_BASE_URL`/`CODEX_BASE_URL` z
`OPENAI_API_KEY`/`CLIPROXY_API_KEY`. Gateway odczytuje zapisane zmienne, tworzy proxy,
usuwa zmienne połączenia i aktualizuje tę samą instancję w jednej transakcji. Pozostałe
zmienne nie zmieniają się. Błąd walidacji cofa całość. Znane zmienne kluczy są
automatycznie szyfrowane również wtedy, gdy starszy klient zapisał je jako zwykły tekst.

## API i weryfikacja

Addytywne RPC: `ListProxies`, `SaveProxy`, `DeleteProxy`, `TestProxy`, `RefreshProxyAccounts`,
`SetProxyAccountPlan`, `MoveInstanceToProxy`; `ProviderInstance`, `SaveProviderInstanceRequest` i
`InstanceOverrides[Input]` mają `proxy_id`. `WorkerConfig.profiles.proxy_codex`
przekazuje wyłącznie publiczne opcje transportu. BFF: `GET /api/proxies`,
`POST /api/proxies/{save,delete,test}`, `POST /api/providers/move`.

`tests/integration/proxies.test.ts` sprawdza transport gateway–worker, mapowanie
trzech harnessów, izolowany Codex home, szyfrowanie, redakcję, owner scoping,
rotację, audyt, migrację i przenoszenie env. Nie dodajemy testów UI.

## Konta upstream (Management API CLIProxyAPI)

Proxy CLIProxyAPI może mieć opcjonalny **management key**. Sekret inferencji nie daje
uprawnień administracyjnych, więc to osobne pole w Settings → Proxies. Klucz jest
szyfrowany jak sekret proxy (`proxies.management_secret_id`, migracja 0145), nigdy nie
wraca do klienta (`Proxy.management_key_set`), nie trafia do workerów, modeli, logów
ani synchronizacji połączonych komputerów. Pominięty w `SaveProxyRequest` zostaje,
pusty jest usuwany. Inne rodzaje proxy nie mają Management API i nie przechowują klucza.
Audyt: `proxy.management_key_replaced` / `proxy.management_key_removed`, bez wartości.

Gateway (właściciel proxy) czyta `GET <root>/v0/management/auth-files` (CLIProxyAPI
v8.0.x) z `Authorization: Bearer`. Przekierowania są odrzucane, a czas odpowiedzi
ograniczony do 10 s. Body ponad 4 MiB jest odrzucane, a lista ograniczona do 200 kont.
Odpowiedź to niezaufane dane: dekodowanie schematem przy granicy, pomijanie wpisów
o złych typach, tekst bez znaków sterujących, tagów i `<>`, zredagowane poświadczenia,
limity długości. Przed obcięciem z każdego pola tekstowego usuwamy dokładne wartości
znanych sekretów (management key i sekret proxy) oraz ich formy URL-encoded, base64
i base64url: proxy, które odbija klucz w emailu, etykiecie lub komunikacie, nie przekaże
go klientom. Każde body, także błędu 403, czytamy ograniczonym czytnikiem; reszta jest
anulowana bez buforowania. UI nie renderuje z niej HTML. Każde konto (`ProxyAccount`) zawiera:
providera, email/etykietę, status (`active`, `cooling_down`, `disabled`, `sign_in`,
`error`), krótki komunikat, koniec cooldownu i liczniki sukcesów/błędów. Okna limitów
pochodzą z pasywnych nagłówków odpowiedzi upstream w `quota` i `model_quotas`: Codex
`x-codex-{primary,secondary}-*`, Claude `anthropic-ratelimit-unified-{5h,7d}-*`.
Każde okno wybiera najnowszy poprawny odczyt według własnego `observed_at`;
zbiorcze `quota` konta może być starsze od odczytu modelu. Procent, status i reset
pochodzą z tego samego odczytu, a brak innego okna w nowszej odpowiedzi nie usuwa
jego wcześniejszego raportu. Przy równych lub brakujących datach wybieramy większe
zużycie. Nowszy odczyt może obniżyć zużycie po resecie; nie bierzemy historycznego
maksimum. Niepoprawny wpis modelu jest pomijany bez odrzucania konta. Czas pobrania
listy i `checked_at` nie zastępują czasu obserwacji upstream.
W odczytach Claude i Codexa `ProviderUsageWindow.observed_at` przenosi czas wybranego
pasywnego raportu lub początku aktywnego odczytu Anthropic. W starszych odczytach i
przy braku daty pasywnego raportu pole pozostaje puste.
Do alertów Codexa wymagamy konta OAuth z emailem i `id_token.chatgpt_account_id`
z listy kont. Gateway tworzy taki sam skrót konta jak dla bezpośredniego logowania.
Odczyt do alertu musi zawierać bezwzględne `reset-at`. Wyliczenie z
`reset-after-seconds` służy do wyświetlania terminu, ponieważ może przesunąć
identyfikator tego samego odnowienia względem bezpośredniego odczytu.
Zmiana limitu pojawia się dopiero, gdy CLIProxyAPI otrzyma i udostępni datowaną
odpowiedź upstream z wartościami dla tego okna. Grok przez CLIProxyAPI oraz
pozostałe rodzaje proxy nie zapewniają odczytu spełniającego te warunki.

Dla kont Claude OAuth z `auth_index` gateway dodatkowo wywołuje
`POST <root>/v0/management/api-call`: stałe `GET https://api.anthropic.com/api/oauth/usage`,
`Authorization: Bearer $TOKEN$` i `anthropic-beta: oauth-2025-04-20`. CLIProxyAPI
podstawia token konta u siebie; Canopy nie pobiera plików auth ani tokenów.
Poprawna odpowiedź dostawcy zastępuje pasywne okna: jej `utilization` jest
procentem 0–100, a nie ułamkiem jak w nagłówkach. Dzięki temu odczyt uwzględnia
pracę poza proxy i nie zależy od kolejności kończenia streamów inferencji.
Odczyt obejmuje 5h, tydzień oraz raportowane okna Opus/Sonnet. Nie wysyła promptu
ani nie zużywa tokenów inferencji. Wyczerpanie okna Opus/Sonnet zeruje tylko jego
pojemność; wspólne okna konta zachowują własny odczyt, a ich wyczerpanie nadal
blokuje wszystkie modele. Pomijamy konta wyłączone, wymagające logowania
i konta API-key. Brak obsługi `api-call`, wygasły token, 429 lub niepoprawna odpowiedź
pozostawiają pasywny raport; nie zmieniają stanu klucza Management API.
Maksymalnie cztery odczyty biegną równocześnie w jednym budżecie 10 s wspólnym
z pobraniem listy. Każda odpowiedź aktywna ma limit 512 KiB i przechodzi walidację;
do UI trafiają wyłącznie znane okna z procentem i datą resetu, bez surowego body
lub nagłówków. Dotychczasowe limity częstotliwości i dzierżawa obejmują cały odczyt.
Nie używamy `usage-queue`, bo zdejmuje rekordy z kolejki innych odbiorców.

Stan (`ProxyAccounts.state`): `ok`, `no_key`, `unauthorized`, `remote_disabled`
(403 „remote management disabled”: włącz `remote-management.allow-remote`),
`unavailable`, `unreachable`, `invalid_response`. Proxy działa dalej niezależnie od
tego stanu.

Ostatni oczyszczony odczyt jest zapisany przy proxy (`management_status`) razem z
tożsamością klucza i URL, z którymi go wykonano (`management_identity` =
`<id sekretu klucza>|<URL>`; każda wymiana klucza tworzy nowy sekret). Dzięki temu
widzą go restarty i wszystkie procesy gatewaya, a wynik starego klucza nigdy nie
opisuje nowego. Odczyty są rzadkie:
- `RefreshProxyAccounts` przy otwarciu widoku zwraca odczyt młodszy niż 45 s;
  przycisk Refresh (`force`) czyta najwyżej co 5 s;
- co minutę sprawdzane są proxy z kluczem używane przez profil; po błędach
  backoff od 5 min do 1 h; pierwsze sprawdzenie ~15 s po starcie. Próg 45 s jest
  krótszy od minuty, bo odczyt dostaje czas na końcu i kolejny cykl widziałby go
  jako świeży;
- zmiana klucza lub URL czyta od nowa;
- dzierżawa w tym samym wierszu (`management_read_at`, `management_read_identity`)
  sprawia, że odczyt tej samej tożsamości zaczyna najwyżej jeden proces na 45 s
  (5 s dla Refresh).

W jednym procesie równoczesne odczyty tego samego proxy współdzielą obietnicę
już podczas zdobywania dzierżawy.
Ręczny Refresh nie zwraca pustego stanu tylko dlatego, że zapis klucza rozpoczął
już odczyt w tle. Po odmowie dzierżawy ponownie pobiera zapisany wynik: zwycięski
odczyt mógł zakończyć się podczas wcześniejszego pobierania celu.

CLIProxyAPI blokuje adres na 30 min po pięciu złych kluczach. Dlatego zapisane
`unauthorized`, `remote_disabled` i `no_key` czekają na nowy klucz albo Refresh; żaden
proces gatewaya, także po restarcie, nie ponawia ich sam. Zmieniona lista trafia do
klientów jako `OverviewUpdate.proxy_accounts` dla jednego proxy; web i mobile podmieniają
ją we współdzielonym `ListProxies` bez ponownego odczytu listy. Odczyt innego procesu
zmienia skrót `proxies_changed`. BFF: `POST /api/proxies/accounts`.

W web/desktop **Settings → Proxies → Upstream accounts** grupuje konta według proxy CLIProxyAPI.
Na mobile **Accounts** jest w karcie proxy. Każdy wiersz pokazuje znak
providera, konto, odznakę statusu, limity (te same mierniki co limity planu), koniec
cooldownu i komunikat. Listę odświeża akcja **Refresh**. Bez klucza albo przy błędzie zostaje jedna
krótka podpowiedź. W Settings → Providers instancja z proxy pokazuje „Through <proxy>”
z podsumowaniem kont tego harnessu (np. „2 Codex accounts · 1 cooling down”) i linkiem
do karty proxy. Mobile pokazuje te same informacje, stany
i akcje (karta proxy, management key, Test connection, Refresh, picker proxy w instancji
i nadpisaniu workera).
Wspólne etykiety i podsumowanie: `@canopy/domain/proxy-accounts`.

W web/desktop **Status and access → Proxy connection** pokazuje w wybranej
instancji konta jej harnessu z przypisanego proxy CLIProxyAPI. Na przykład
instancja Claude połączona przez proxy pokazuje konta Claude z tego proxy wraz
z aktualnymi limitami i znanymi terminami resetu. Logowanie urządzenia korzysta
z raportu konta workera. Jeśli włączone workery korzystają z różnych proxy,
**All workers** pokazuje każde z tych proxy raz. Po wybraniu workera widok
uwzględnia jego nadpisanie połączenia. Dane pochodzą ze wspólnego `ListProxies`.
Na mobile **Proxy limits** nad listą instancji grupuje aktualne odczyty limitów
według używanego proxy CLIProxyAPI.

W Accounts na web/desktop każde raportowane okno, także 5-hour, zachowuje własny
pasek pozostałego limitu i czas resetu. Przy znanej długości, dacie resetu i zużyciu
`usagePace` z `@canopy/domain/provider-usage` wylicza pozostały limit przy równym
zużyciu do resetu: `(reset − teraz) / długość okna`. Pionowy znacznik pokazuje ten
poziom, a podpis porównuje ostatni raport z nim w punktach procentowych (pp):
**Ahead of pace**, **Spare capacity** albo **On pace** (różnica zaokrąglona do 0 pp).
Przekroczenie tempa jest bursztynowe; osiągnięty limit pozostaje czerwony.
To porównanie do równomiernego zużycia, nie prognoza na podstawie historii.
Nieznana długość, brak resetu i daty poza bieżącym oknem nie dostają tempa;
wygasłe odczyty są pomijane. Brak raportu 5h nie tworzy pustego ani zerowego limitu.
Podpis tempa ma stałe miejsce dla wszystkich jego stanów. Kompaktowy widok kont
i mierniki instancji Providers pozostają bez szczegółów tempa.

Web ukrywa tożsamości kont oraz komunikaty kont mogące zawierać login wspólnym
komponentem `Sensitive`, tak samo jak adresy w Providers. Kliknięcie lub aktywacja
klawiaturą odsłania wartość na 30 s; Escape ukrywa ją od razu. Rozmycie nie zmienia
szerokości tekstu, a ukryta wartość nie trafia do tytułu ani etykiety dostępności.
Tożsamość konta jest wyśrodkowana w pionie względem znaku providera; ukrycie
i odsłonięcie wartości zachowuje to samo wyrównanie, także po skróceniu długiej nazwy.
W panelu **Provider limits** okres, reset i zbiorczy procent pojawiają się nad paskiem.
Podział odzwierciedla proporcje planów i zachowuje pozycję kont we wszystkich oknach.
Wypełnienie segmentu i procent pod nim dotyczą jednego konta. Szczegóły segmentu
zawierają nazwę konta; tożsamość proxy odsłania się kontrolką Sensitive. Brak limitu
5 h w planie ma kreskowany segment, a brak odczytu osobny przerywany obrys.
[Okna i sposób liczenia pojemności](provider-accounts.md#limity-planu-i-dodatkowe-użycie).
Niska pojemność to kolor liczby i paska oraz jedno słowo „Low” w nagłówku wiersza. Wskaźnik
w stopce sidebara ma po jednym pasku na providera, wypełnionym jak pasek głównego okna
w popoverze (np. Weekly); ograniczające krótsze okno zmienia tylko jego kolor, tak jak słowo
„Low”. Popover nie pokazuje list kont, jednostek,
liczby raportujących kont ani nieznanych planów; szczegóły zostają w Settings → Proxies
i Providers. Proxy w użyciu, którego kont nie da się odczytać, dostaje jedno krótkie zdanie
z linkiem do jego karty. Korzysta wyłącznie ze wspólnego `ListProxies` aktualizowanego przez
overview; otwarcie nie odpytuje proxy ani nie zakłada nowego timera.

Mobile (`apps/mobile/src/ui/Sensitive.tsx`) nie renderuje ukrytej wartości wcale: zamiast
rozmycia pokazuje kropkę za każdy znak (spacje zostają), więc zrzut ekranu, udostępnianie
ekranu ani drzewo dostępności nie widzą tekstu; etykieta mówi „… hidden”. Dotknięcie odsłania
na 30 s, drugie ukrywa; wyjście aplikacji z pierwszego planu, nowa wartość i odmontowanie
ukrywają od razu. Host w URL proxy jest zamaskowany, schemat i ścieżka zostają. Arkusz
**Provider limits** w stopce szuflady pokazuje te same wiersze co popover web, bez natywnych
modułów.

Okna Codexa są nazywane według `window-minutes`, nigdy według pozycji primary/secondary:
300 → 5-hour, 1440 → Daily, 10080 → Weekly, 43200 → Monthly; inne dodatnie okresy
dostają etykietę z długością. Samo 0% bez okresu i resetu nie tworzy miernika.
Nieznany okres z rzeczywistym odczytem ma nazwę Primary limit / Secondary limit,
zamiast sugerować ogólne Usage. Claude pomija puste zerowe watermarki bez resetu
i statusu; zachowuje rzeczywiste 0% i jawne odrzucenie limitu.
Codex `reset-at` i Claude `…-reset` to epoki w sekundach; Codex
`reset-after-seconds` to czas względem `observed_at`. Reset odległy o ponad 400 dni
jest nieznany: gateway odrzuca datę, a wspólny formatter ukrywa również starsze
wartości cache przekraczające tę granicę. Sam odczyt wykorzystania pozostaje widoczny.

Typ planu w `ProxyAccount.plan` to zamknięty enum: Free, Plus, Pro, Team, Business,
Enterprise, Max, Max 5x, Max 20x, Ultra, Pro 100/200/500, Premium, Super i Other.
Brak danych lub niepotwierdzona waga otrzymuje oznaczenie Unknown plan.
Wykryty plan pochodzi wyłącznie z identyfikatorów samych providerów; własnych mnożników ani pól
pojemności proxy nie czytamy. CLIProxyAPI udostępnia dla Codexa obiekt `id_token.plan_type`
oraz nagłówek `X-Codex-Plan-Type` (identyfikatory OpenAI); parser nie dekoduje JWT ani nie
pobiera plików auth. Dla Codexa nagłówek ma pierwszeństwo, bo opisuje ostatnią odpowiedź,
a zapisany claim może pochodzić sprzed zmiany planu. Identyfikatory Codexa: `plus` → Plus,
`prolite` → Pro 100, `pro` → Pro 200 (pierwotny Pro za 200 USD), `promax` → Pro 500.
Jawne pola `plan_type`, `chatgpt_plan_type`, `subscription_type`, `rate_limit_tier`, `tier`
obsługują odpowiedzi, które je udostępniają.

Claude: upstream CLIProxyAPI (sprawdzone 2026-11-15) nie ma w `auth-files` żadnego
identyfikatora planu ani profilu. Sygnały Claude to tylko `Anthropic-Ratelimit-Unified-*`
i `Retry-After` (także w `model_quotas`), `account_type` to `oauth` lub `api_key`, a
`id_token` dotyczy tylko Codexa. Automatyczny plan Claude jest więc nieznany i liczy się jako ×1;
nie zgadujemy go z nazwy konta. To samo dotyczy Grok i Antigravity.
Do UI nie trafiają pozostałe claims ani dowolne teksty planów. Dla poświadczeń
`account_type: api_key` CLIProxyAPI wpisuje sam klucz w `account`, więc to pole nigdy
nie staje się etykietą konta.

### Ręczny plan konta

Każdy wiersz w Accounts (web i mobile) ma kompaktowy picker planu. **Automatic**
zachowuje wykrywanie; ręczny wybór ma podpis **Set manually** i wygrywa także po
późniejszej zmianie wykrytego planu. Powrót do Automatic od razu przywraca aktualnie
wykryty plan. Picker pokazuje plany o znanej wadze z tabeli; Grok ma obecnie tylko
Automatic, ponieważ nie ma potwierdzonych wag. Brak trwałego ID blokuje zapis.
Emaile pozostają chronione przez Sensitive.

Migracja `0149_proxy_account_plans` dodaje mapę `proxies.account_plans`. Wiersz proxy
zapewnia owner scoping i usunięcie ustawień razem z proxy. Klucz to SHA-256 providera
i upstream `id` (fallback: `auth_index`), bez emaila, tokena i etykiety. Upstream
[Auth.ID / EnsureIndex](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/cliproxy/auth/types.go)
(sprawdzone 2026-11-15) opisuje ID jako trwałe między restartami, a indeks jako
pochodną nazwy pliku/tożsamości credentialu. Odświeżenie tokena nie zmienia ID pliku;
zmiana nazwy pliku tworzy nową tożsamość ustawienia. Nie czytamy pól specyficznych dla forków.
Wpisy nieobecnych kont są ignorowane; zapis wymaga jednoznacznego konta w bieżącym odczycie.

`SetProxyAccountPlan` waliduje plan dla providera pod blokadą wiersza proxy;
`UNSPECIFIED` usuwa wybór. Snapshot detekcji pozostaje osobny od ustawień, więc Refresh
nie nadpisuje ręcznego planu. `ProxyAccount.plan` jest planem efektywnym,
`detected_plan` zachowuje detekcję, a `manual_plan` wskazuje ręczny wybór.
Odpowiedź, ListProxies i overview używają tej samej projekcji, także po restarcie gatewaya.
BFF: `POST /api/proxies/plan`. Waga zasila wspólne podsumowanie użycia web i mobile.

Pojemność liczy `@canopy/domain/proxy-capacity`, osobno dla każdego okna: suma wag
kont daje jednostki, a suma `waga × (1 − wykorzystanie)` daje dostępne jednostki.
Jedna tabela wag wraz z datą i źródłami znajduje się w tym module. Nie wyliczamy
mnożników z cen ani z podobnych nazw planów. Wagi według deklaracji providerów
(sprawdzone 2026-11-15):

| Provider | Plan | Tydzień | 5 godzin |
|---|---|---|---|
| Claude | Pro | 1 | 1 |
| Claude | Max (Max 5x) | 5 | 5 |
| Claude | Team (równoważność podana przez użytkownika, 2026-11-15) | 5 | 5 |
| Claude | Ultra (dawne Max 20x) | 10 | brak limitu |
| Codex | Plus | 1 | 1 |
| Codex | Pro 100 (`prolite`) | 10 | brak limitu |
| Codex | Pro 200 (`pro`) | 20 | brak limitu |
| Codex | Pro 500 (`promax`) | 50 | brak limitu |

Źródła: strony pomocy Claude o planach Max i Ultra, strona pomocy OpenAI o planach Pro
oraz ogłoszenie OpenAI o limitach Codexa z 2026-11-08 (Pro 100/200/500 = 10/20/50 × Plus,
bez limitu 5-godzinnego). Niepotwierdzona kombinacja planu, providera i okna liczy się
jako ×1 i jest oznaczona w danych; popover tego nie pokazuje. Dotyczy to limitów API Groka:
abonamentowy pool Groka nie jest limitem API. Dawne Max 20x Claude jest obecnie pokazywane
jako Ultra, a Max 5x jako Max; waga tygodniowa odpowiada aktualnemu planowi.

Brak pomiaru, brak procentu bez sygnału reached lub miniony reset wyklucza konto
z mianownika danego okna. Wyłączone konta,
wymagające logowania oraz ze statusem błędu lub nieznanym są wykluczone. Cooling
down i osiągnięcie aktualnego limitu wspólnego zerują dostępną pojemność konta,
zachowując jego jednostki w oknach, dla których istnieje odczyt. Limit Opus/Sonnet
zeruje tylko odpowiadające mu okno. Nie tworzymy
brakujących okien ani nie zakładamy, że reset sam potwierdził powrót dostępności.
Ikona paska bocznego pokazuje dla każdego providera najbardziej ograniczające okno
z wiersza popovera, więc zgadza się z tym, co popover pokazuje. Przy limicie bez procentu samo reached oznacza zerową dostępność.
Okna o nieznanym okresie (Primary limit / Secondary limit) zostają przy koncie,
ale nie są sumowane. Standardowe klucze okien łączą również starsze odczyty cache
bez pola długości; niestandardowe okresy wymagają identycznej liczby minut.

Listy kont w Settings → Proxies, podsumowania oraz agregacja
obsługują wyłącznie Claude, Codex i Grok. Pozostałe konta nie ujawniają tożsamości
ani abonamentów; zostaje jedynie liczba kont nieobsługiwanego providera.

Źródła sprawdzone 2026-11-14 (plany Claude w upstream: 2026-11-15):
- [CLIProxyAPI: lista i oczyszczone claims](https://github.com/router-for-me/CLIProxyAPI/blob/e96d4c4818851cf0e96d27b2bc8b67379e449d9e/internal/api/handlers/management/auth_files.go),
- [CLIProxyAPI: odczyt przez `api-call` i podstawienie tokenu (sprawdzone 2026-11-15)](https://github.com/router-for-me/CLIProxyAPI/blob/67465884ca179a8f9098328d03a361b50003fdd7/internal/api/handlers/management/api_tools.go),
- [CLIProxyAPI: mapowanie okien i nullable secondary](https://github.com/router-for-me/CLIProxyAPI/blob/e96d4c4818851cf0e96d27b2bc8b67379e449d9e/internal/runtime/executor/helps/codex_quota.go),
- [Codex: pomijanie pustych okien](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs).

`tests/integration/proxy-account-usage.test.ts` sprawdza aktywny odczyt Claude przez
gRPC i Management API: pierwszeństwo bieżącego zużycia, zero po resecie, limity
modeli bez zerowania wspólnego salda, cache, redakcję oraz fallback przy błędach
dostawcy, braku endpointu, niepoprawnym lub zbyt dużym body i przekierowaniu.

`tests/integration/proxy-accounts.test.ts` używa fałszywego serwera Management API:
parsowanie i sanityzacja kont, zły klucz bez ponowień, wyłączony zdalny dostęp,
za duże i nie-JSON body, nieosiągalny host, brak klucza, owner scoping, okresowe
sprawdzanie tylko używanych proxy, brak klucza w odpowiedziach RPC, bazie i audycie,
odbite sekrety (surowe i kodowane), niekończące się body 403 oraz odrzucony klucz
po restarcie i w dwóch procesach.
