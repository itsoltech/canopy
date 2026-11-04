# Współdzielone połączenia proxy

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
  lub argv. Zaawansowane ustawienia pozwalają wyłączyć WebSockets (preset CLIProxyAPI
  włącza je) i dodać publiczne nagłówki routingu. Bieżący Codex obsługuje wyłącznie
  `responses`; inna wartość `wire_api` jest odrzucana. Nagłówki auth, cookies i kluczy
  są odrzucane; sekret ma osobne pole.
- Grok 1.0.70 (`f50904eaee6c`, sprawdzone 2026-11-04) obsługuje własne endpointy:
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

## Test połączenia

**Test connection** wykonuje z gateway `GET <root>/v1/models`: Bearer dla
CLIProxyAPI/OpenAI albo `x-api-key` i `anthropic-version` dla Anthropic.
Pokazuje liczbę modeli, status HTTP albo zredagowany błąd sieci. Nie wykonuje tury LLM.
Przekierowania są odrzucane, aby klucz nie trafił do innego hosta. Rozpoznanie
CLIProxyAPI wymaga dodatniego markera nagłówka lub publicznego root JSON
`message = "CLI Proxy API Server"`; dodatkowe zapytanie root nie wysyła sekretu.
Brak markera nie oznacza braku kompatybilności. Surowe body błędu nigdy nie wraca do UI.

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

## Wbudowany login i ręczne zmienne

Wbudowane **Device login** ma widocznie wyłączone karty połączenia oraz wyjaśnienie
**To use a proxy, add an instance**. Przycisk otwiera dodawanie instancji z wybranym
harnessem i rodzajem Proxy.

**Move to a proxy** wykrywa `ANTHROPIC_BASE_URL` z `ANTHROPIC_AUTH_TOKEN`/
`ANTHROPIC_API_KEY`, a dla Codexa `OPENAI_BASE_URL`/`CODEX_BASE_URL` z
`OPENAI_API_KEY`/`CLIPROXY_API_KEY`. Gateway odczytuje zapisane zmienne, tworzy proxy,
usuwa zmienne połączenia i aktualizuje instancję w jednej transakcji. Dla wbudowanego
loginu tworzy oddzielną instancję; oryginał zachowuje logowanie urządzenia. Pozostałe
zmienne nie zmieniają się. Błąd walidacji cofa całość. Znane zmienne kluczy są
automatycznie szyfrowane również wtedy, gdy starszy klient zapisał je jako zwykły tekst.

## API i weryfikacja

Addytywne RPC: `ListProxies`, `SaveProxy`, `DeleteProxy`, `TestProxy`,
`MoveInstanceToProxy`; `ProviderInstance`, `SaveProviderInstanceRequest` i
`InstanceOverrides[Input]` mają `proxy_id`. `WorkerConfig.profiles.proxy_codex`
przekazuje wyłącznie publiczne opcje transportu. BFF: `GET /api/proxies`,
`POST /api/proxies/{save,delete,test}`, `POST /api/providers/move`.

`tests/integration/proxies.test.ts` sprawdza transport gateway–worker, mapowanie
trzech harnessów, izolowany Codex home, szyfrowanie, redakcję, owner scoping,
rotację, audyt, migrację i przenoszenie env. Nie dodajemy testów UI.

Możliwy dalszy etap, poza tą zmianą: wyświetlanie limitów użycia CLIProxyAPI przez
Management API. Wymaga osobnej decyzji o poświadczeniu zarządzania i dostępie;
sekret inferencji nie daje automatycznie uprawnień administracyjnych.
