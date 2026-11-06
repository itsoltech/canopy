# CLI dostawców: wykrywanie, instalacja i aktualizacja

Odczyt statusu konta przez oficjalne CLI, jego ograniczenia oraz zasady
prywatności opisuje [provider-accounts.md](provider-accounts.md).

Canopy **nigdy nie dołącza** CLI dostawców — Claude Code (`claude`), Codexa (`codex`) ani Groka (`grok`) — do
aplikacji desktop, binarek workera ani obrazów Docker. CLI muszą być zainstalowane na maszynie workera. Canopy
potrafi je jednak **zainstalować i aktualizować na żądanie**: dla każdego workera i dostawcy pokazuje zainstalowaną
wersję, sposób instalacji i dostępną aktualizację, a instalacja albo aktualizacja rusza wyłącznie po kliknięciu
właściciela (jeden worker albo „Update all” dla dostawcy). Nic nie instaluje się samo.

Centrum aktualizacji w stopce sidebara obejmuje te same akcje i logi instalatora.
Jego „Update all” aktualizuje już zainstalowane natywne CLI po gatewayu i binarnych workerach.
Pomija instalacje zarządzane przez npm, Bun, Volta, pnpm i pozostałe menedżery;
popover pokazuje „Managed externally” oraz polecenie aktualizacji pod ikoną informacji.
Indywidualne przepisy menedżerów opisane poniżej pozostają dostępne w szczegółach workera;
brakujące CLI mają osobne „Install”. Każdy krok ponownie sprawdza właściciela,
zgodność workera i blokady instalatora. Błąd zatrzymuje dalszą kolejkę. Historia
Claude Code i Codexa pochodzi z publicznych GitHub Releases; Grok nie ma znanego
źródła tych notatek, więc centrum pokazuje tę informację i wynik instalatora.

Kod: `apps/worker/src/cli-tools/*` (wykrywanie, przepisy, instalator), `apps/gateway/src/core/cli-tools.ts`
(najnowsze wersje, decyzje, RPC), UI w `apps/web/src/lib/features/workers/*Cli*`. Testy:
`tests/integration/provider-cli.test.ts` (prawdziwy proces workera, fałszywe CLI, npm, instalator i rejestr) oraz
opcjonalny `provider-cli.live.test.ts` (`CANOPY_LIVE=1`, tylko odczyt najnowszych wersji).

## Kontrakt

Addytywnie w `worker/v1` (blok 800), za capability workera **`cli_install`**:

| Wiadomość | Kierunek | Znaczenie |
|---|---|---|
| `WorkerMessage.cli_tools` (`CliToolsReport`) | worker → gateway | Wszystkie CLI: ścieżka, ścieżka po symlinkach, wersja, `CliInstallMethod`, czy jest przepis (`installable`), polecenie ręczne, ostatnia/trwająca instalacja (`CliInstallStatus`), `os`/`arch`. Zastępuje poprzedni raport. |
| `Command.install_cli` (`InstallCli`) | gateway → worker | Dostawca + wersja (`X.Y.Z[-pre]` albo `latest`) + `install_id`. **Nietrwała**: wysyłana bezpośrednio, nigdy z outboxa, więc stare kliknięcie nie zainstaluje niczego po restarcie. `CommandResult.ok` = przyjęta i rozpoczęta; odmowa: `CLI_TURNS_RUNNING`, `CLI_INSTALL_RUNNING`, `CLI_MANAGED_EXTERNALLY`, `INVALID_VERSION`. |
| `WorkerMessage.cli_install_progress` | worker → gateway | Zredagowane linie wyjścia instalatora, porcjami co 250 ms. |

`WORKER_LINK_PROTOCOL` **nie** rośnie: wszystko jest nowymi polami, a gateway wysyła `InstallCli` tylko workerom z
capability `cli_install`. Starszy worker po prostu nie ma sekcji CLI („Update this worker to install CLIs from
Canopy”), starszy gateway ignoruje nowe wiadomości.

UI (`ui/v1`): `Worker.cli_tools` (`WorkerCliTool`: raport + `latest`, `update_available`, `action` =
`install`/`update`/pusty, `blocked_reason`, `managed_by`, `running_turns`, `log`), `Worker.arch`, RPC
`InstallCli` (`worker_id` albo `all_workers`) i `CheckCliUpdates`. BFF: `POST /api/workers/cli/install|check`.
Raport gateway trzyma w istniejącym JSONB `workers.capabilities.cliTools` (bez migracji), więc wersje offline
workerów pozostają widoczne. Linie postępu są tylko w pamięci gatewaya (ostatnie 200 na workera i dostawcę).
Jeżeli instalacja kończy się podczas wykrywania CLI, worker odrzuca wynik rozpoczęty przed jej końcem
i ponownie odczytuje wersje. Status zakończonej instalacji nie może trafić do raportu ze starą wersją.

## Wykrywanie na workerze

Kod: `apps/worker/src/cli-tools/shell-env.ts` (środowisko powłoki), `locations.ts` (miejsca), `managers.ts`
(menedżer), `discovery.ts` (wybór i sonda wersji). Test: `tests/integration/cli-discovery.test.ts`.

### Środowisko powłoki logowania

Worker uruchomiony z aplikacji desktop (macOS: z GUI, bez PATH z profilu powłoki), launchd albo systemd nie widzi
tego, co dopisuje profil użytkownika: `~/.bun/bin`, `~/.volta/bin`, shimów nvm/fnm/mise/asdf, prefiksu npm. Dlatego
`main.ts` raz na start procesu uruchamia `$SHELL -l -i -c` (przez governor, rodzaj `probe`, limit 8 s, stdin pusty,
`TERM=dumb`). Powłoka uruchamia `/bin/sh`, który wypisuje między dwoma losowymi znacznikami pary `nazwa=wartość`
rozdzielone bajtem NUL. Szum z plików startowych (powitania, prompt, sekwencje ANSI) przed i po znacznikach jest
pomijany, a wartość wieloliniowa nie podszyje się pod inną zmienną. Powłoka nie dostaje zmiennych `CANOPY_*` ani
zmiennych o nazwach jak token/secret/password/api key/auth.

Brana jest tylko lista: `PATH`, `BUN_INSTALL`, `VOLTA_HOME`, `PNPM_HOME`, `NVM_DIR`, `NVM_BIN`, `FNM_DIR`,
`FNM_MULTISHELL_PATH`, `MISE_DATA_DIR`, `ASDF_DIR`, `ASDF_DATA_DIR`, `NPM_CONFIG_PREFIX`, `npm_config_prefix`,
`NPM_CONFIG_USERCONFIG`, `HOMEBREW_PREFIX`, `N_PREFIX`. Pierwszeństwo:

1. `PATH`: najpierw wpisy powłoki logowania, potem wpisy procesu workera, których tam nie było (bez duplikatów).
2. Pozostałe zmienne: wartość procesu workera wygrywa; wartość powłoki uzupełnia tylko brakujące.
3. Gdy w `PATH` nie ma `node`, worker dopisuje **na końcu** pierwszy katalog ze znanych miejsc, w którym `node`
   jest (Volta, nvm, fnm, Homebrew…). Shimy JS (`#!/usr/bin/env node`) z npm, Bun, pnpm i Yarn wtedy działają, a
   własny `node` użytkownika nadal wygrywa.

Wynik trafia do `process.env`, więc te same `PATH` i zmienne widzą wykrywanie, sondy `--version`, instalatory i
procesy harnessów. Ponowne zapytanie powłoki: `ProbeProviders` („Check for updates”), najwyżej raz na minutę.
Bez powłoki (Windows, Docker, brak `$SHELL`, `CANOPY_LOGIN_SHELL_ENV=0`), po błędzie albo po przekroczeniu limitu
worker działa na własnym środowisku i znanych miejscach. Wykrywanie czeka na wynik, zanim sprawdzi CLI.

### Kolejność szukania

`executable_path` z konfiguracji dostawcy wygrywa i jest jedyną kandydatką. Inaczej worker zbiera pliki o nazwie
CLI (do 8, także zepsute symlinki; bez bitu wykonywania są pomijane) w tej kolejności:

1. `PATH` (po scaleniu: powłoka logowania, potem proces workera).
2. `~/.local/bin` (Claude: także `~/.claude/local`; Grok: `~/.grok/bin`).
3. Bun: `$BUN_INSTALL/bin`, `~/.bun/bin`.
4. Volta: `$VOLTA_HOME/bin`, `~/.volta/bin`.
5. pnpm: `$PNPM_HOME`, `~/Library/pnpm` (macOS) albo `${XDG_DATA_HOME:-~/.local/share}/pnpm`.
6. npm: `<prefix>/bin` dla `$NPM_CONFIG_PREFIX`, `$npm_config_prefix` i `prefix=` z `~/.npmrc`
   (albo `$NPM_CONFIG_USERCONFIG`; plik jest czytany, npm nie jest uruchamiany), potem `~/.npm-global/bin`.
7. Yarn: `~/.yarn/bin`, `${XDG_CONFIG_HOME:-~/.config}/yarn/global/node_modules/.bin`.
8. nvm: `$NVM_BIN`, trzy najnowsze `~/.nvm/versions/node/*/bin`; fnm: `$FNM_MULTISHELL_PATH/bin`,
   `aliases/default/bin` w `$FNM_DIR`, `~/.local/share/fnm` i `~/Library/Application Support/fnm`.
9. Shimy mise (`$MISE_DATA_DIR/shims`, `~/.local/share/mise/shims`) i asdf (`$ASDF_DATA_DIR/shims`, `~/.asdf/shims`).
10. Homebrew: `$HOMEBREW_PREFIX/bin`, `/opt/homebrew/bin` (Apple Silicon), `/usr/local/bin` (Intel),
    `/home/linuxbrew/.linuxbrew/bin`, `~/.linuxbrew/bin`.

Windows (bez zmian w zachowaniu, tylko `<cli>.exe`): `PATH`, `%APPDATA%\npm`, `%VOLTA_HOME%\bin`,
`%LOCALAPPDATA%\Volta\bin`, `~/scoop/shims`, Bun, `%PNPM_HOME%`, `~/.local/bin`.

**Wybór:** kandydaci są sprawdzani po kolei przez `<plik> --version` (governor: ≤2 naraz, cache 60 s; ten sam klucz
dla raportu CLI i konfiguracji). Pierwsza kopia, która odpowie, wygrywa, więc działająca kopia z Bun wygrywa ze
starą kopią Homebrew wcześniej w `PATH`; przy kilku działających wygrywa ta, którą wskazuje powłoka. Gdy żadna nie
działa, worker używa pierwszej istniejącej i raportuje błąd. Zwykle wystarcza jedna sonda na CLI; dalszych kopii
worker nie uruchamia. Pozostałe kopie idą w `CliTool.alternatives` (ścieżka, ścieżka po symlinkach, metoda, wersja
lub problem: błąd `--version`, „points to a missing file”); kopie o tej samej ścieżce rzeczywistej są pomijane.
Sam zepsuty symlink to `NOT_INSTALLED` z informacją w `detail`.

**Wersja:** pierwsza linia `--version` (limit 10 s, 64 KiB, `NO_COLOR=1`). Błąd idzie w `CliTool.version_error`:
pierwsza linia stderr (np. `env: node: No such file or directory`), kod wyjścia albo przekroczony limit. UI pokazuje
„Couldn't run codex --version: …”. Przy nieznanej wersji nie ma odznaki „Up to date” ani przycisku aktualizacji.

**Jedno źródło:** raport CLI (`CliToolsReport`), lista Agents (`ConfigApplied.providers`, `prepareSystemProbe`) i
centrum aktualizacji używają tego samego wyboru i tej samej sondy. Harness uruchamia wybraną kopię
(`findCli` zwraca ją, dopóki istnieje). Ścieżki z instancji (`ProviderProfileConfig.executable_path`) nie są osobno
raportowane.

### Sposób instalacji

Decyduje rzeczywista ścieżka (po symlinkach), typ shimu i ścieżka pakietu zapisana w shimie skryptowym, w tej
kolejności. Sam prefiks nie decyduje: `npm i -g` z node z Homebrew instaluje do `/opt/homebrew/lib/node_modules`.

| Metoda | Rozpoznanie | Aktualizacja |
|---|---|---|
| `DOCKER` | worker w kontenerze (`CANOPY_INSTALL_KIND=docker`, `/.dockerenv`, `/run/.containerenv`) | obraz |
| `MISE` / `ASDF` | `…/mise/installs/<narzędzie>/…`, `…/mise/shims/…` (narzędzie z `mise which`), `~/.asdf/installs|shims` | `mise upgrade …` / `asdf install …` |
| `HOMEBREW` | `…/Cellar/<formuła>/…`, `…/Caskroom/<cask>/…` | `brew upgrade [--cask] <nazwa>` |
| `NATIVE` | Claude: `~/.local/share/claude/versions/…`; Grok: `~/.grok/bin|downloads/…` | własny updater / skrypt |
| `VOLTA` | link do `volta-shim`, `…/.volta/tools/image/…`, `$VOLTA_HOME/tools/image/…` | `volta install <pakiet>@<w>` |
| `BUN` | `~/.bun/install/global/…`, `$BUN_INSTALL/install/global/…`, shim z tą ścieżką | `bun add -g <pakiet>@<w>` |
| `PNPM` | `…/pnpm/global/…`, `…/.pnpm/…`, shim skryptowy w `$PNPM_HOME` z `global/5/node_modules/<pakiet>` | `pnpm add -g <pakiet>@<w>` |
| `YARN` | `…/yarn/global/node_modules/…` | ręcznie: `yarn global add <pakiet>@<w>` |
| `NPM` | `<prefix>/lib/node_modules/<pakiet>/…` (Windows: `<prefix>/node_modules/…`), także pod prefiksem Homebrew, nvm i fnm; prefiks jest zapamiętany | `<prefix>/bin/npm install -g --prefix <prefix> …` |
| `HOMEBREW` | reszta pod `/opt/homebrew`, `/home/linuxbrew/.linuxbrew`, `/usr/local/Homebrew` | `brew upgrade <nazwa>` |
| `OTHER` | cokolwiek innego | ręcznie |
| `NOT_INSTALLED` | brak działającego pliku | instalacja |

Starszy gateway nie zna `VOLTA`/`PNPM`/`YARN`: pokazuje „Unknown”, a akcję wylicza z `installable` workera.

Raport idzie po każdym połączeniu, po `ProbeProviders` („Check for updates”), po każdej instalacji
i zgodnie z efektywnym `WorkerConfig.cli_update_check_minutes` (domyślnie 360; 0 wyłącza timer).
Bez ciągłego odpytywania.

## Najnowsze wersje (gateway)

| CLI | Źródło |
|---|---|
| Claude Code | `https://downloads.claude.ai/claude-code-releases/latest` (wskaźnik kanału natywnego instalatora) |
| Codex | `https://registry.npmjs.org/-/package/@openai/codex/dist-tags` → `latest` |
| Grok | `https://x.ai/cli/stable` (kanał stable oficjalnego instalatora) |

Settings → Workers ustawia częstotliwość konta (`UserSettings.cli_updates.interval_minutes`),
a Agent CLIs przy workerze opcjonalne nadpisanie (`SetWorkerCliUpdateSettings`, kontrola wersji konfiguracji).
Wybory: 60, 360 (domyślnie), 1440, 10080 minut lub 0 (Never). Gateway dostarcza efektywną wartość
w konfiguracji workera. Najnowszych wersji szuka gateway: osobny trwały snapshot i ostatni termin
sprawdzenia w `workers.capabilities.cliUpdateChecks` każdego własnego workera. Timer oraz raport workera
sprawdzają termin; samo raportowanie lokalnej wersji nie omija Never. Lookup uruchomiony raportem
pracuje w tle: nawet niedostępny rejestr nie zatrzymuje tur, zgód ani odpowiedzi na komendy workera.
Ręczny `CheckCliUpdates` omija
harmonogram. Zmiana częstotliwości konta nie modyfikuje cudzych workerów ani jawnych nadpisań.
UI pokazuje ostatni/następny termin, przy Never „manual only”. Nic nie instaluje się automatycznie. Tylko
HTTPS, odpowiedź ≤ 256 KiB, poprawny semver. Błąd zostawia poprzednią wersję i pokazuje „Couldn't check for
updates: …”; nic nie blokuje. Adresy można podmienić wyłącznie opcją `GatewayCoreOptions.cliLatest` (testy,
`allowHttpForTests`), nigdy zmienną środowiskową.

## Przepisy

Stałe, per dostawca i metoda (`apps/worker/src/cli-tools/recipes.ts`). Z UI przychodzi tylko dostawca i wersja,
sprawdzana na gatewayu i ponownie na workerze (`X.Y.Z[-pre]` albo `latest`). Bez `sudo`, bez łańcuchów powłoki:
tablica argv albo oficjalny skrypt instalatora pobrany z jego stałego adresu HTTPS do prywatnego katalogu
`<data_dir>/cli-install/<id>/` i uruchomiony `bash install.sh [wersja]`, potem usunięty.

| Metoda | Claude Code | Codex | Grok |
|---|---|---|---|
| `NATIVE` | `claude install <wersja>` (własny updater) | — | `https://x.ai/cli/install.sh [wersja]` (POSIX) |
| `NPM` | `<prefix>/bin/npm install --global --prefix <prefix> @anthropic-ai/claude-code@<w>` | to samo z `@openai/codex` | to samo z `@xai-official/grok` |
| `BUN` | `<bun> add --global <pakiet>@<w>` (`bun` z PATH, `$BUN_INSTALL/bin`, `~/.bun/bin`) | jw. | jw. |
| `VOLTA` | `<volta> install <pakiet>@<w>` (`volta` z PATH, `$VOLTA_HOME/bin`, `~/.volta/bin`) | jw. | jw. |
| `PNPM` | `<pnpm> add --global <pakiet>@<w>` (`pnpm` z PATH, `$PNPM_HOME`) | jw. | jw. |
| `YARN` | brak przycisku: „Managed by Yarn” + `yarn global add <pakiet>@<w>` | | |
| `NOT_INSTALLED` | `https://claude.ai/install.sh [wersja]` (POSIX, do `~/.local`) | `npm install --global --prefix ~/.local @openai/codex@<w>`, bez npm: `bun add -g` | `https://x.ai/cli/install.sh [wersja]` (POSIX, do `~/.grok/bin`) |
| `HOMEBREW` | brak przycisku: „Managed by Homebrew — update it there” + `brew upgrade --cask claude-code` / `brew upgrade <formuła>` | | |
| `MISE` / `ASDF` | brak przycisku: `mise upgrade <narzędzie>` / `asdf install <plugin> latest` | | |
| `DOCKER` | brak przycisku: „Managed by the image” | | |
| `OTHER` | brak przycisku: „Installed outside a known installer … Update it the way you installed it.” | | |

Windows: Claude bez instalacji pokazuje polecenie PowerShell (`irm https://claude.ai/install.ps1 | iex`); skrypty
bash nie działają. Przepisy macOS i Windows nie były sprawdzone na prawdziwych maszynach.

## Zasady bezpieczeństwa

- **Egzekwuje gateway**, nie UI: tylko właściciel workera (`workers.owner_user_id`; cudzy i współdzielony worker =
  `NotFound`), worker online z `cli_install`, metoda z przepisem (Homebrew, mise, asdf, Yarn, Docker i `OTHER` są
  odrzucane niezależnie od tego, co zgłosił worker), brak trwających tur dostawcy, jedna instalacja naraz.
  Każde uruchomienie trafia do `audit_log` (`worker.cli.install`: dostawca, wersja, poprzednia, metoda).
- **Trwające tury: odmowa.** Gateway (tury `running` w bazie) i worker (własne tury i tury właśnie przyjmowane)
  odrzucają instalację z komunikatem „… has N running turns on this worker; try again when they finish”; UI
  pokazuje „Waiting for N running turns to finish” i wyłącza przycisk. Nic nie czeka w tle za kliknięciem.
  W trakcie instalacji nowe tury tego dostawcy na workerze czekają na jej koniec. Proces Codexa (app-server) po
  zmianie wersji restartuje się, gdy nie ma trwających tur.
- **Brak połowicznej instalacji w użyciu.** Po przepisie nowy plik musi odpowiedzieć na `--version` (z żądaną
  wersją, jeśli była dokładna). Inaczej worker przywraca poprzednią: symlink natywnego launchera (atomowy
  `rename`), a dla npm/Bun/Volta/pnpm ponowna instalacja poprzedniej wersji tym samym przepisem. Błąd brzmi np. „the installer
  exited with code 1; 0.160.0 is still in use”. Limit 10 minut (SIGTERM, po 5 s SIGKILL).
- **Sekrety.** Instalator działa bez zmiennych `CANOPY_*` i o nazwach jak token/secret/password/api key/auth;
  linie wyjścia są redagowane (ANSI, dane w URL, `Bearer`, `sk-…`, `ghp_…`, `token=…`, wartości usuniętych
  zmiennych) i przycinane do 400 znaków. Sekrety z `WorkerConfig` i tak są tylko w pamięci workera, nie w env.
- **Logowanie CLI nienaruszone.** Przepisy nigdy nie wywołują `login`/`logout` ani nie dotykają plików logowania.
- Test-only: `CANOPY_CLI_INSTALLER_BASE_URL` podmienia skrypty instalatorów, ale wyłącznie na adres loopback
  (`http://127.0.0.1|localhost`).
- Stan instalacji (`CliInstallStatus`) jest w pamięci procesu workera: restart workera zostawia tylko bieżące
  wersje, bez wyniku ostatniej instalacji.

## Dalsze prace

- Opcjonalna „automatyczna aktualizacja” per worker (wyłączona domyślnie; dziś każda instalacja wymaga kliknięcia).
- Raportowanie plików wykonywalnych ustawionych w instancjach dostawców, przepisy Windows (`install.ps1`) i
  sprawdzenie przepisów na macOS.
- Sprawdzenie na prawdziwym macOS: powłoka logowania z aplikacji desktop (zsh z oh-my-zsh/powerlevel10k, fish),
  shimy Volta i pnpm, `npm i -g` z node z Homebrew; Windows: npm/Volta/scoop.
