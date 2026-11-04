# CLI dostawców: wykrywanie, instalacja i aktualizacja

Odczyt statusu konta przez oficjalne CLI, jego ograniczenia oraz zasady
prywatności opisuje [provider-accounts.md](provider-accounts.md).

Canopy **nigdy nie dołącza** CLI dostawców — Claude Code (`claude`), Codexa (`codex`) ani Groka (`grok`) — do
aplikacji desktop, binarek workera ani obrazów Docker. CLI muszą być zainstalowane na maszynie workera. Canopy
potrafi je jednak **zainstalować i aktualizować na żądanie**: dla każdego workera i dostawcy pokazuje zainstalowaną
wersję, sposób instalacji i dostępną aktualizację, a instalacja albo aktualizacja rusza wyłącznie po kliknięciu
właściciela (jeden worker albo „Update all” dla dostawcy). Nic nie instaluje się samo.

Centrum aktualizacji w stopce sidebara obejmuje te same akcje i logi instalatora.
Jego „Update all” aktualizuje już zainstalowane CLI po gatewayu i binarnych workerach;
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

## Wykrywanie na workerze

- Plik wykonywalny: `executable_path` z konfiguracji dostawcy, inaczej `PATH`, inaczej znane miejsca w katalogu
  domowym (`~/.local/bin`, `~/.bun/bin`, `~/.claude/local`, `~/.grok/bin`). Te same miejsca uzupełniają teraz
  `which` przy uruchamianiu dostawców — usługa systemd/launchd często nie ma `~/.local/bin` w `PATH`.
  Ścieżki z instancji (`ProviderProfileConfig.executable_path`) nie są osobno raportowane.
- Wersja: pierwsza linia `--version` (asynchronicznie, limit 10 s).
- Sposób instalacji wg rzeczywistej ścieżki (po symlinkach), w tej kolejności:

| Metoda | Rozpoznanie |
|---|---|
| `DOCKER` | worker w kontenerze (`CANOPY_INSTALL_KIND=docker`, `/.dockerenv`, `/run/.containerenv`) |
| `MISE` / `ASDF` | `…/mise/installs/<narzędzie>/…`, `…/mise/shims/…` (narzędzie z `mise which`), `~/.asdf/installs|shims` |
| `HOMEBREW` | `…/Cellar/<formuła>/…`, `…/Caskroom/<cask>/…`, `/opt/homebrew`, `/home/linuxbrew/.linuxbrew` |
| `NATIVE` | Claude: `~/.local/share/claude/versions/…`; Grok: `~/.grok/bin|downloads/…` |
| `BUN` | `~/.bun/install/global/…` |
| `NPM` | `<prefix>/lib/node_modules/<pakiet>/…` (Windows: `<prefix>/node_modules/…`); prefiks jest zapamiętany |
| `OTHER` | cokolwiek innego |
| `NOT_INSTALLED` | brak pliku |

Raport idzie po każdym połączeniu, po `ProbeProviders` („Check for updates”), po każdej instalacji i co 6 godzin.
Bez ciągłego odpytywania.

## Najnowsze wersje (gateway)

| CLI | Źródło |
|---|---|
| Claude Code | `https://downloads.claude.ai/claude-code-releases/latest` (wskaźnik kanału natywnego instalatora) |
| Codex | `https://registry.npmjs.org/-/package/@openai/codex/dist-tags` → `latest` |
| Grok | `https://x.ai/cli/stable` (kanał stable oficjalnego instalatora) |

Cache 6 godzin (`startSweep` uruchamia sprawdzanie i timer), odświeżenie na żądanie w `CheckCliUpdates`. Tylko
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
| `BUN` | `bun add --global <pakiet>@<w>` | jw. | jw. |
| `NOT_INSTALLED` | `https://claude.ai/install.sh [wersja]` (POSIX, do `~/.local`) | `npm install --global --prefix ~/.local @openai/codex@<w>`, bez npm: `bun add -g` | `https://x.ai/cli/install.sh [wersja]` (POSIX, do `~/.grok/bin`) |
| `HOMEBREW` | brak przycisku: „Managed by Homebrew — update it there” + `brew upgrade --cask claude-code` / `brew upgrade <formuła>` | | |
| `MISE` / `ASDF` | brak przycisku: `mise upgrade <narzędzie>` / `asdf install <plugin> latest` | | |
| `DOCKER` | brak przycisku: „Managed by the image” | | |
| `OTHER` | brak przycisku: „Installed outside a known installer … Update it the way you installed it.” | | |

Windows: Claude bez instalacji pokazuje polecenie PowerShell (`irm https://claude.ai/install.ps1 | iex`); skrypty
bash nie działają. Przepisy macOS i Windows nie były sprawdzone na prawdziwych maszynach.

## Zasady bezpieczeństwa

- **Egzekwuje gateway**, nie UI: tylko właściciel workera (`workers.owner_user_id`; cudzy i współdzielony worker =
  `NotFound`), worker online z `cli_install`, metoda z przepisem (Homebrew, mise, asdf, Docker i `OTHER` są
  odrzucane niezależnie od tego, co zgłosił worker), brak trwających tur dostawcy, jedna instalacja naraz.
  Każde uruchomienie trafia do `audit_log` (`worker.cli.install`: dostawca, wersja, poprzednia, metoda).
- **Trwające tury: odmowa.** Gateway (tury `running` w bazie) i worker (własne tury i tury właśnie przyjmowane)
  odrzucają instalację z komunikatem „… has N running turns on this worker; try again when they finish”; UI
  pokazuje „Waiting for N running turns to finish” i wyłącza przycisk. Nic nie czeka w tle za kliknięciem.
  W trakcie instalacji nowe tury tego dostawcy na workerze czekają na jej koniec. Proces Codexa (app-server) po
  zmianie wersji restartuje się, gdy nie ma trwających tur.
- **Brak połowicznej instalacji w użyciu.** Po przepisie nowy plik musi odpowiedzieć na `--version` (z żądaną
  wersją, jeśli była dokładna). Inaczej worker przywraca poprzednią: symlink natywnego launchera (atomowy
  `rename`), a dla npm/Bun ponowna instalacja poprzedniej wersji tym samym przepisem. Błąd brzmi np. „the installer
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
