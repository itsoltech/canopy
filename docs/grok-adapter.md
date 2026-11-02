# Adapter Grok

Stan badań: 2026-11-02; lokalny CLI `grok 1.0.70 (f50904eaee6c)`.

## Źródła i możliwości

- [Headless i ACP](https://docs.x.ai/build/cli/headless-scripting): `grok agent stdio`, JSON-RPC 2.0, jedna wiadomość JSON na linię, odpowiedź tekstowa przez `session/update`, zakończenie przez odpowiedź na `session/prompt`.
- [ACP v1](https://agentclientprotocol.com/protocol/v1/overview): `initialize`, opcjonalne `authenticate`, `session/new` (`cwd`, `mcpServers`), opcjonalne `session/load`, `session/prompt`, `session/cancel` (notyfikacja), `session/set_mode`. `session/set_model` jest rozszerzeniem używanym przez agentów obsługujących wybór modelu. Capabilities rozstrzygają dostępność obrazów, resume, MCP HTTP, plików i terminala.
- Dokumentacja dołączona do CLI: `~/.grok/docs/user-guide/{02-authentication,05-configuration,11-custom-models,15-agent-mode,22-permissions-and-safety,26-config-reference}.md`. Jest dokładniejsza od skróconej dokumentacji WWW i odpowiada zainstalowanej wersji.

`grok agent --help` potwierdza `--no-leader`, `--model`, `--reasoning-effort`, `--always-approve`, `--xai-api-base-url`, `--cli-chat-proxy-base-url`. Opcje agenta stoją **przed** `stdio`. Główne CLI ma tryby uprawnień `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`. Nie zakładamy, że wszystkie są identyfikatorami trybów ACP: źródłem prawdy jest `session/new.modes`.

Lokalne `grok models` bez loginu pokazuje fallback `grok-4.6` (domyślny), `grok-4.5`. To nie jest pełny katalog konta. CLI zgłosiło „You are not authenticated”; podczas badania brak `~/.grok/auth.json`. Nie odczytujemy ani nie wypisujemy wartości tokenów.

## Endpointy i izolacja

Grok obsługuje backendy `chat_completions` (domyślnie), `responses`, `messages`. Konfiguracja `[model.<id>]` przyjmuje `model`, `base_url` (z `/v1`), `env_key`, `api_backend`. Per-model `env_key` ma pierwszeństwo przed loginem. `GROK_HOME` zmienia katalog konfiguracji, a `GROK_AUTH_PATH` wskazuje plik loginu. `GROK_CONFIG` jest ograniczoną nakładką JSON: **nie** służy do zmiany endpointów ani auth; nie wkładamy tam sekretów.

Instancja CLIProxyAPI używa odizolowanego `GROK_HOME` i konfiguracji modelu z `env_key`, kluczem wyłącznie w env procesu. Nie przekazujemy klucza w argv, logach, repozytorium ani globalnej konfiguracji użytkownika. Tymczasowe pliki mają 0600, katalog 0700; cleanup po zakończeniu procesu. Live potwierdził backend `chat_completions` na `/v1/chat/completions`, katalog `/v1/models`, modele `grok-4.7-build-fast` oraz `grok-composer-2.5-fast`. Własny endpoint ma pierwszeństwo przed loginem urządzenia. Guard auth CLI wymaga dodatkowo `XAI_API_KEY` z tym samym kluczem; samo `env_key` nie wystarcza do utworzenia sesji.

## SDK

`packages/grok-acp` posiada proces CLI i jego grupę procesów, inicjalizację, typowane sesje, wybór modelu/trybu i asynchroniczny strumień promptu. Żądania mają unikalne ID i timeouty; obsługa callbacków nie blokuje odbioru odpowiedzi. Zapis czeka na flush stdin, kolejka zdarzeń i ramki są ograniczone. Crash/EOF/nieprawidłowa ramka kończą oczekujące żądania. Dispose wysyła TERM, następnie KILL i czeka na zebranie procesu; przerwany konsument nie pozostawia działającej tury. Stderr jest ograniczony i redagowany. Możliwości fs i terminal są ogłaszane wyłącznie, gdy klient dostarcza ich implementację.

Testy fake agenta sprawdzają podzielone ramki UTF-8, kolejne tury, wznowienie, permission round-trip, anulowanie, crash, redakcję i timeout. Testy prawdziwego CLI wymagają `OA_LIVE=1`.

## Adapter workera

`GrokThreads` ma operacje create/startTurn/interrupt/unload/listModels analogiczne do rejestrów pozostałych SDK. Jeden proces obsługuje jeden wątek. Worker zapisuje każdy event do trwałego journalu przed publikacją do gatewaya. Model, effort lub tryb zmieniony między turami powoduje restart procesu i `session/load`. Sesje są trwałe w `<data_dir>/grok/<instance>/sessions`; tymczasowy home procesu ma do nich symlink. Po restarcie workera `provider_thread_id` wskazuje sesję do załadowania. Live potwierdził load po usunięciu tymczasowego home i uruchomieniu nowego procesu. Replay historii podczas load nie tworzy duplikatów itemów.

Nie ma sprawdzonego mid-turn steer w bazowym ACP: worker odrzuca go `STEER_REJECTED`, a istniejący gateway przenosi wejście do następnej tury. Cancel przerywa callbacki zgód i wysyła `session/cancel`; brak odpowiedzi przez 5 s kończy proces. Dispose zbiera proces oraz kończy jego grupę (TERM, po 1,5 s KILL). Bezczynne sesje są zwalniane według `idle_unload_seconds`. Gwałtowne SIGKILL całego workera nie daje szansy na wykonanie jego cleanup; nie należy zastępować nim normalnego shutdown.

| ACP | Item / zdarzenie Canopy |
| --- | --- |
| `agent_message_chunk` | `agentMessage`, `itemStarted` + tekstowe `itemDelta`, na końcu `itemCompleted` |
| `agent_thought_chunk` | `reasoning`, ten sam cykl streamingu |
| `tool_call`, `tool_call_update`, `execute` lub `run_terminal_command` | `commandExecution`: command, cwd, output, exit code |
| `content.type=diff` | `fileChange`: ścieżka i stary/nowy tekst jako diff |
| Pozostałe tool calls | `toolCall`: nazwa, input JSON, output, błąd; patche zachowują poprzednie pola |
| `plan` | `plan`, statusy kroków |
| MCP Canopy | `agentBusCall` z wynikiem gatewaya; wrapper `use_tool` zostaje wyłącznie w raw transcript |
| `usage_update` | rozmiar context window i koszt USD, gdy zgłoszone; `used` nie jest licznikiem input/output tokens |
| wynik `session/prompt` | `turnFinished`: completed, failed (refusal/limit), interrupted (cancel) |
| crash/timeout | failed, przerwanie użytkownika → interrupted |

CLI 1.0.70 raportuje `loadSession`, obraz i embedded context, MCP HTTP/SSE oraz rozszerzenia x.ai. `session/new` nie zwrócił listy `modes`; `session/set_mode` z `default` i `session/set_model` z wybranym modelem zakończyły się sukcesem. Nie traktujemy braku listy trybów jako zgody na zgadywanie identyfikatorów ani jako dowodu wymuszania polityki. Metody są dostępne w SDK, a adapter uprawnienia realizuje przez własne callbacki i konfigurację procesu. Narzędzia prawdziwego CLI mogą nie mieć `kind`; w smoke komendy miały `title=run_terminal_command`, a MCP było wykonywane przez `search_tool` / `use_tool`.

Handshake ogłosił metodę auth `grok.com` („Sign in with Grok”), `image=true`, `audio=false`, `embeddedContext=true` i rozszerzenia sesji list/resume/close. SDK udostępnia bazowe `session/load`; nie opiera trwałości na nieprzenośnych rozszerzeniach resume. Klient nie ogłasza obsługi fs/terminal w adapterze workera: CLI wykonuje własne narzędzia, a SDK potrafi przekazać te callbacki aplikacji, która je implementuje. Alternatywny headless tryb CLI (`grok -p`, formaty `plain`, `json`, `streaming-json`, `streaming-messages-json`, flaga `--include-partial-messages`) nie jest transportem adaptera — interaktywne zgody i MCP idą przez ACP.

## Uprawnienia i narzędzia platformy

| Canopy | Grok |
| --- | --- |
| ask | ACP permission → istniejące karty UI Allow/Deny |
| read_only | sandbox `read-only`, jawne deny dla edycji i shella oraz odmowa callbacków; odczyty plików pozostają dostępne |
| accept_edits | automatyczna zgoda dla edit/znanych nazw edytorów, pozostałe zgody przez UI |
| full_auto | sandbox `workspace`, automatyczny wybór `allow_once`; reguły deny i wymagania CLI nadal obowiązują |

Grok automatycznie dopuszcza część bezpiecznych komend (także mkdir/touch) przed callbackiem ACP. Dlatego read_only ma jawne reguły deny, również gdy cwd leży w `/tmp`, które sandbox dopuszcza do zapisu. Nie ma heurystycznego auto-review w Canopy. „Allow for this session” pamięta dokładną parę nazwa+argumenty w pamięci procesu; nie włącza globalnego bypass i nie zapisuje trwałych grantów. `GROK_DEFAULT_SELECTED_PERMISSION=reject` wybiera tylko domyślny wiersz interfejsu CLI — nie jest trybem uprawnień.

`grokBus` udostępnia lokalny Streamable HTTP MCP, na loopback z losowym bearerem per wątek, przekazany przez ACP `mcpServers`. Używa tych samych `agentBusToolSpecs/agentBusToolsFor` co Claude MCP i Codex dynamicTools. Gateway nadal autoryzuje ask_user, request_secret, spawn_thread, harmonogramy i inne narzędzia. `view_image` korzysta z istniejącego workera, normalizacji obrazów i ograniczeń ścieżek cwd/załączników. Uprawnienia i błędy narzędzi wracają do modelu. Serwer jest zamykany razem z CLI.

Ten sam serwer wystawia platformowe connectory z `ThreadSpec.connectorTools`. Wywołanie zawiera identyfikator konta, a item zachowuje nazwę konta i typ connectora; gateway nadal sprawdza grant workera. Zmiana katalogu narzędzi powoduje restart/load sesji z aktualnym MCP. Test `bus.test.ts` pokrywa bearer, zakres dostępnych narzędzi, konto i metadane transkryptu. Wyłączenie zewnętrznych MCP poniżej dotyczy konfiguracji urządzenia, nie connectorów Canopy.

Załączniki obrazowe są wysyłane jako ACP image tylko po zadeklarowaniu capability; pozostałe jako ścieżki. Zewnętrzne MCP z konfiguracji Claude/Cursor i managed MCP są wyłączone w tym procesie. Klucze modelu są wykluczone ze środowiska shella. Natywne subagenty, workflows i goals Groka są wyłączone; delegowanie odbywa się przez platformowe `spawn_thread`.

## Katalog, UI, boty i tytuły

Native pobiera modele/efforts z `_meta.modelState` odpowiedzi initialize, bez płatnej tury. Proxy pobiera `/v1/models`, filtruje modele nieagentowe i uzupełnia efforts tylko dla modeli znanych z metadanych CLI. Dla innych modeli lista efforts jest pusta (nie oznacza to dowodu braku rozumowania). W smoke Grok 4.6 raportował low/medium/high/xhigh, Grok 4.5 low/medium/high. UI, harmonogramy i domyślne ustawienia używają wspólnego katalogu. Hello/config-applied pokazuje wersję Groka na liście Agents.

Instancje mają ten sam mechanizm native/CLIProxyAPI, szyfrowane sekrety i synchronizację na workery co pozostałe harnessy. Enum `PROVIDER_GROK=3`, `WorkerConfig.grok=640`, migracja `0042_grok_provider.sql`. Picker, sidebar, ustawienia providerów i karty subagentów mają markę Groka ([LobeHub icons, MIT i notice](third-party-notices.md#lobehub-icons--znak-xaigrok)).

`spawn_thread` obsługuje `grok/<instance>` w obu kierunkach z Claude/Codex. Botowe `start_thread` przyjmuje `provider: grok`. Boty mogą też działać bez CLI przez endpoint chat completions; live `grok-3-mini-fast` potwierdził function calling i odczyt wyniku narzędzia w następnej turze. Generowanie tytułów przez Groka jest dozwolone wyłącznie dla proxy `grok-3-mini` / `grok-3-mini-fast` (max 120 tokenów, bez tools/workspace); native i drogie modele pozostają wyłączone dla tej funkcji.

## Włączenie na stosie użytkownika

1. Zbuduj/zaktualizuj gateway i worker z tej gałęzi, wykonaj migrację 0042. Na urządzeniu workera zainstaluj `grok`, sprawdź `grok --version`. Nie wykonano wdrożenia w ramach implementacji.
2. W zdalnym WorkerConfig włącz `grok: { enabled: true, executablePath: "/home/nix/.local/bin/grok" }`. Przy natywnym loginie zostaw `deviceLogin` domyślne; dla wyłącznie proxy ustaw `deviceLogin: NONE`. Istniejący worker potrzebuje jawnego włączenia tego harnessu. Nowy `worker add` włącza już wszystkie trzy.
3. Native: wykonaj `grok login` jako użytkownik OS workera; domyślnie czytane jest `~/.grok/auth.json`. Alternatywnie instancja native może mieć sekretny `XAI_API_KEY`. Przy innym koncie ustaw Home path na katalog tego loginu. Logowanie Groka odbywa się w CLI, bez formularza OAuth w Canopy. Nie kopiuj tokenów do repo.
4. Proxy: Settings → Providers → Add → Grok → CLIProxyAPI. Wpisz istniejący prywatny URL i klucz w pola instancji, wybierz worker. URL może być bazowy lub kończyć się `/v1`; wrapper normalizuje go do `/v1`. Model wybierz z katalogu, np. sprawdzony `grok-4.7-build-fast`. Worker sam ustawia prywatny home, custom model, `OPENAGENTS_GROK_API_KEY` i `XAI_API_KEY`; nie wymaga dodatkowych env dla proxy.
5. Zaczekaj na Agents → Grok 1.0.70 oraz dostępność instancji. Utwórz wątek z Grokiem i wybranym modelem. Dla tanich tytułów wybierz osobno mini w Text generation; bot może używać tej samej instancji proxy i mini-fast.

Przy ręcznej rejestracji nowego workera istniejące polecenie `worker add --cliproxy-url <URL> --cliproxy-key-env <NAZWA_ENV>` rejestruje też instancję Groka. Wartości są pobierane z prywatnego środowiska; nie umieszczaj ich w skryptach repo ani logach. Na istniejącym workerze użyj instancji i zdalnego configu; nie rejestruj kolejnego workera tylko po to, aby dodać Groka.

Fragment zdalnego WorkerConfig dla wyłącznie proxy (zachowaj pozostałe pola configu, szczególnie allowedRoots i limits):

```json
{
  "grok": {
    "enabled": true,
    "executablePath": "/home/nix/.local/bin/grok",
    "deviceLogin": "DEVICE_LOGIN_NONE"
  }
}
```

Native: pomiń `deviceLogin` albo użyj `DEVICE_LOGIN_LINK`. Proces workera musi widzieć binarkę i katalog loginu użytkownika OS; dla niestandardowej lokalizacji ustaw Home path instancji lub `GROK_HOME` środowiska workera. Proxy nie wymaga ręcznego ustawiania `XAI_API_KEY`, `OPENAGENTS_GROK_API_KEY` ani `GROK_HOME` workera — wrapper ustawia je tylko w potomnym procesie z zaszyfrowanej konfiguracji instancji.

## Weryfikacja i granice

- SDK: deterministyczny fake ACP, framing Unicode, kolejne tury/load, permission deny, cancel/reuse, crash/redakcja, timeout, nieposłuszne anulowanie i abort callbacka.
- `tests/integration/grok-provider.test.ts`: prawdziwy gateway/PostgreSQL + WorkerHost + fake Grok, native i endpoint instance, MCP, itemy, zgody/odmowy, interrupt, steer→queue, restart/load.
- Opt-in `OA_LIVE=1`: `packages/grok-acp/src/client.live.test.ts`, `apps/worker/src/providers/grok/launch.live.test.ts`, `apps/gateway/src/bots/grok.live.test.ts`. Env testowe: `OA_LIVE_CLIPROXYAPI_URL`, `OA_LIVE_CLIPROXYAPI_KEY`; opcjonalnie `OA_LIVE_GROK_MODEL`, `OA_GROK_EXECUTABLE`. Prywatny plik dev-live.env nie jest częścią repo. Nie ma publicznego hosta ani przykładowego prawdziwego klucza w dokumentacji.
- Odbiór Chromium opisuje [grok-verification.md](grok-verification.md). Nie dodano web UI testów.

Ograniczenia: brak ACP fork i goals (odrzucane w gatewayu, kontrolki ukryte), brak native background-task lifecycle/stopTask i automatycznego settlement z transkryptu Groka po awarii; przerwana tura po restarcie korzysta ze wspólnego fallbacku workera, sesja jest nadal wznawialna. Nie odtwarzamy niezgłoszonych tokenów input/output ani nie zgadujemy usage z context occupancy. Natywny płatny smoke pominięto z powodu braku loginu. Live nie obejmował obrazów, rzeczywistych diffów CLI ani mieszanego spawn Claude/Codex↔Grok; obrazy/diffy mają fake integrację, a wybór spawn test resolvera. ASK ma fake round-trip zgody/odmowy/anulowania; live proxy pracował w FULL_AUTO, bez pełnej macierzy READ_ONLY/ACCEPT_EDITS/FULL_AUTO. Nie należy deklarować pełnego live parytetu.
