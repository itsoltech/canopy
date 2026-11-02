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

Instancja CLIProxyAPI powinna używać odizolowanego `GROK_HOME` i konfiguracji modelu z `env_key`, kluczem wyłącznie w env procesu. Nie wolno przekazywać klucza w argv, logach, repozytorium ani globalnej konfiguracji użytkownika. Tymczasowe pliki mają 0600, katalog 0700; cleanup po zakończeniu procesu. Endpoint i nazwy modeli wymagają sprawdzenia na żywo przed deklaracją kompatybilności.

## SDK

`packages/grok-acp` posiada proces CLI i jego grupę procesów, inicjalizację, typowane sesje, wybór modelu/trybu i asynchroniczny strumień promptu. Żądania mają unikalne ID i timeouty; obsługa callbacków nie blokuje odbioru odpowiedzi. Zapis czeka na flush stdin, kolejka zdarzeń i ramki są ograniczone. Crash/EOF/nieprawidłowa ramka kończą oczekujące żądania. Dispose wysyła TERM, następnie KILL i czeka na zebranie procesu; przerwany konsument nie pozostawia działającej tury. Stderr jest ograniczony i redagowany. Możliwości fs i terminal są ogłaszane wyłącznie, gdy klient dostarcza ich implementację.

Testy fake agenta sprawdzają podzielone ramki UTF-8, kolejne tury, wznowienie, permission round-trip, anulowanie, crash, redakcję i timeout. Testy prawdziwego CLI wymagają `OA_LIVE=1`.
