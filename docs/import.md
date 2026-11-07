# Import z CLI agentów

Settings → Code → **Import** przenosi do Canopy wątki, które użytkownik prowadził wcześniej w Claude Code,
Codexie i Groku, tak żeby mógł je czytać i kontynuować. Strona działa w webie i desktopie; telefon
dostanie widok importów później (etap C).

Stos A (wątki) ma pięć etapów:

1. wykrywanie i podgląd (ten dokument opisuje stan po etapie 1),
2. silnik importu i historia Claude,
3. kontynuacja wątków Claude,
4. Codex,
5. Grok.

Ustawienia, biblioteki (skille, pluginy, marketplace), instrukcje i serwery MCP to stos B; onboarding
i aplikacja mobilna to stos C.

## Domy CLI i izolacja

Wątki Canopy zachowują prawdziwe `HOME`, `USERPROFILE` i XDG, ale każde CLI działa z prywatnym katalogiem
konfiguracji: `CLAUDE_CONFIG_DIR=<data_dir>/claude-home`, `CODEX_HOME=<data_dir>/codex-home`, `GROK_HOME`
procesu z `sessions/` w `<data_dir>/grok/<instancja>/sessions` ([claude-adapter.md](claude-adapter.md#izolacja),
[codex-adapter.md](codex-adapter.md#izolacja-od-konfiguracji-właściciela-urządzenia), [grok-adapter.md](grok-adapter.md#endpointy-i-izolacja)).
Boty podmieniają także `HOME`. Dlatego CLI uruchomione przez Canopy nie widzi sesji z `~/.claude`, `~/.codex`
i `~/.grok`.

Decyzja: Canopy **zostaje przy prywatnych domach**. Import czyta katalogi użytkownika wyłącznie do odczytu
i kopiuje to, co potrzebne do wznowienia, do prywatnego domu instancji (etapy 3–5). Ani Canopy, ani CLI nie
dopisują wtedy do tego samego pliku, ustawienia, hooki i MCP użytkownika nie trafiają do wątków platformy,
a boty zostają odizolowane. Kopia może się rozjechać z CLI: lista pokazuje wtedy *Has new turns* albo
pozwala zaimportować wątek ponownie jako nowy.

## Formaty

Sprawdzone na plikach: Claude Code 2.1.291–2.1.319, Codex 0.162–0.166, Grok 1.0.70–1.0.77. Fixtures
generują przypięte wersje (sekcja „Testy”).

| CLI | Gdzie | Co czyta skan |
|---|---|---|
| Claude Code | `<home>/projects/<cwd z myślnikami>/<sesja>.jsonl`, obok `<sesja>/subagents/agent-*.jsonl` i `tool-results/` | początek i koniec pliku: `cwd`, `version`, `entrypoint`, `gitBranch`, czasy, `custom-title` / `ai-title` / `summary`, pierwsza wiadomość użytkownika |
| Codex | `<home>/sessions/RRRR/MM/DD/rollout-*.jsonl`, `archived_sessions/` | `session_meta` (`id`, `cwd`, `cli_version`, `originator`, `source`, `git`), pierwsze polecenie (`item_completed` z `UserMessage`, starsze `event_msg user_message`), nazwy z `session_index.jsonl` |
| Grok | `<home>/sessions/<zakodowany cwd>/<sesja>/` | `summary.json` (tytuł, czasy, `chat_format_version`), `prompt_context.json` (`working_directory`), pierwszy `user` z `prompt_index` w `chat_history.jsonl` albo `user_message_chunk` w `updates.jsonl` |

Nazwa katalogu Claude jest stratna (każdy znak spoza `[A-Za-z0-9]` to `-`), więc `cwd` pochodzi z wpisów.
Pliki do 8 MB skan czyta w całości (dokładna liczba tur), większe tylko w 64 KiB początku i 256 KiB końca.
Plików SQLite CLI (`state_5.sqlite`, `thread_history_1.sqlite`, `session_search.sqlite`) Canopy nie otwiera:
pierwszy to indeks rolloutów, ostatni zawiera pełny tekst rozmów.

Pochodzenie wątku (`origin`): `cli` (terminal), `exec` (skrypt, `claude -p`, `codex exec`), `sdk` (aplikacja
na Agent SDK), `ide`, `app` (inny originator Codexa), `unknown`. Subagenci Codexa (`source.subagent`) są
ukryci domyślnie; subagenci Claude należą do swojej sesji.

Wersja formatu: Claude i Codex według `major.minor` CLI, Grok według `chat_format_version`. Nowszy niż
sprawdzony (`newer`) albo nieznany format importuje się najpierw jako historia.

## Przepływ

1. **Komputer.** Lista zawiera tylko workery tego komputera; połączony komputer importuje u siebie.
   Worker offline albo bez capability `cli_import_v1` daje komunikat do działania.
2. **Skan.** Gateway wysyła `ScanImportSources`; worker zwraca katalogi CLI i metadane wątków. Wynik żyje w pamięci
   gatewaya 30 minut (`scan_id`).
3. **Przegląd.** Na CLI: liczba wątków, rozmiar na dysku, katalogi, zakres dat, ścieżka i wersja CLI.
4. **Wątki.** Filtry: CLI, ostatnia aktywność (7 / 30 / 90 dni, cały czas), szukanie w tytułach, subagenci.
   Lista jest pogrupowana według katalogu. Domyślnie zaznaczone są wszystkie wątki z ostatnich 30 dni;
   zaznaczenie to „wszystko, co pasuje, poza wyłączonymi” albo jawny zbiór. Pasek pokazuje szacowany rozmiar
   w bazie Canopy (bez wpisów technicznych CLI: cache żądań, liczniki tokenów).
5. **Projekty.** Każdy katalog ma propozycję: workspace istniejącego projektu, który go zawiera (najgłębszy
   korzeń), nowy projekt, gdy katalog istnieje, albo „Directory no longer exists” (tylko historia).

Wiersz wątku pokazuje stan: *Imported*, *Has new turns*, *Already in Canopy* (wątek Canopy o tym samym id
u dostawcy), *History only* z powodem i *Secrets masked*.

## Protokół

Capability `cli_import_v1`; `WORKER_LINK_PROTOCOL` się nie zmienia. Komendy importu są nietrwałe: nigdy
z outboxa ani journala ([protocol.md](protocol.md#komendy-gateway--worker)).

| Komenda | Wynik | Etap |
|---|---|---|
| `ScanImportSources { agent_clis }` | `CommandResult.import_scan`: `ImportRoot[]`, `ImportThreadSummary[]`, `truncated`, `skipped` | 1 |

UI API: `ScanImport(worker_id)` i `ListImportCandidates(scan_id, filtr, offset, limit)`
(`proto/canopy/ui/v1/cli_import.proto`). Metody nie są trasowane do połączonych komputerów.

## Bezpieczeństwo

- **Właściciel.** Skan i lista tylko dla workera, którego `owner_user_id` to bieżący użytkownik; współdzielony
  worker (bez właściciela) jest odrzucany.
- **Ścieżki.** Gateway nie wysyła ścieżek. Korzenie wyznacza worker: domy CLI urządzenia
  (`CLAUDE_CONFIG_DIR` / `~/.claude`, `CODEX_HOME` / `~/.codex`, `GROK_HOME` / `~/.grok`) i `home_path` instancji,
  po realpath i bez duplikatów. Wątek wskazuje `source_key`: id korzenia, ścieżka względna i HMAC kluczem
  `<data_dir>/import/key` (0600), który nie opuszcza workera. Przy każdym odczycie worker sprawdza podpis,
  korzeń, brak `..` i dowiązań symbolicznych na drodze oraz rodzaj wpisu (plik albo katalog).
- **Każdy odczyt w korzeniu.** Dotyczy też plików pomocniczych (katalogi projektów i sesji, `summary.json`,
  indeksy): żaden katalog pod korzeniem ani sam plik nie może być dowiązaniem, a plik musi być zwykłym plikiem
  (FIFO czy urządzenie pod znaną nazwą jest odrzucane przed otwarciem); plik otwiera się z `O_NOFOLLOW | O_NONBLOCK`,
  a po otwarciu worker sprawdza, że ścieżka nadal wskazuje ten sam i-węzeł bez dowiązań, a deskryptor
  (`/proc/self/fd` na Linuksie) leży w korzeniu. Dowiązanie podłożone albo podmienione w trakcie nie czyta nic.
- **Tylko odczyt.** Deskryptor otwierany do odczytu, bez blokad CLI (`*.lock`) i bez uruchamiania CLI na
  katalogach użytkownika. Test porównuje treść i czasy modyfikacji drzewa przed i po skanie.
- **Maskowanie** (`masking.ts`, `secret-matcher.ts`). Przed wysłaniem czegokolwiek z workera:
  - dokładne wartości, które worker widzi w plikach logowania (`.credentials.json`, `auth.json`: wszystkie
    wartości) oraz wartości pod kluczami typu `env`, `token`, `key`, `header`, `auth`, `secret` w ustawieniach
    i konfiguracji CLI (`settings.json`, `settings.local.json`, `config.toml`, `settings.json` Groka, MCP
    z `~/.claude.json`), plus zmienne instancji; od 12 znaków, najwyżej 10 000 wartości (więcej: komenda kończy
    się błędem `IMPORT_TOO_MANY_SECRETS` bez żadnej wartości w treści, nic nie jest maskowane częściowo);
    każda wartość także w postaci z tekstu JSON (raz i dwa razy z escape). Szuka ich jeden automat
    Aho–Corasick w jednym liniowym przejściu;
  - formaty tokenów z charakterystycznym prefiksem (klucze `sk-ant-`, `sk-`, `xai-`, tokeny GitHub, AWS, Slack,
    Google, GitLab, npm, JWT) skanem liniowym po ciągach znaków tokenu, klucze prywatne PEM parowaniem znaczników
    `BEGIN`/`END`; `BEGIN` bez `END` maskuje resztę pola, `END` bez `BEGIN` wszystko przed nim;
  - widoki zdekodowane: każde pole jest też sprawdzane po zdjęciu escape'ów JSON (`\"`, `\\`, `\/`, `\n` itd.,
    `\uXXXX` z parami surogatów) do 3 razy. Sekret znaleziony tylko tam nie ma pewnego miejsca w oryginale,
    więc całe pole zastępuje `[hidden: contained a credential]` (fail closed);
  - jedno wejście: `maskText`, `maskJson`, `maskedRecord`. Czytniki maskują cały sparsowany rekord, zanim
    wezmą z niego prompt, tytuł czy podgląd; przycinanie, łączenie białych znaków i cięcie są dopiero potem
    (`previewOf` w skanie przyjmuje rekord, nie tekst). Klucze obiektów są maskowane jak wartości, a gałąź JSON
    w `maskText` zawsze kończy się sprawdzeniem całego pola (także widoków zdekodowanych);

  Słowa typu `token = …` zostają: są częste w kodzie. Skan nie wysyła odpowiedzi agenta, wyników narzędzi ani
  rozumowania.
- **Limity.** Skan: 20 000 wątków i 20 s na CLI (potem `truncated`), pliki do 4 MB dla JSON-ów pomocniczych;
  długi skan oddaje pętlę zdarzeń co 50 wątków, żeby łącze z gatewayem żyło.

## Testy

- **Fixtures** (`apps/worker/src/import/fixtures/homes/<cli>/<wersja>`): generuje je
  `bun apps/worker/src/import/fixtures/generate.ts` z zainstalowanych CLI i atrapy modelu
  (`fake-model.ts`: Anthropic Messages, OpenAI Responses, Chat Completions ze strumieniowaniem). Scenariusze:
  Claude — narzędzie Bash, rozumowanie, subagent, `/compact`, tura po kompaktowaniu, druga sesja w innym
  katalogu; Codex — `exec_command`, wznowienie z rozumowaniem, drugi wątek; Grok — `run_terminal_command`
  i wznowienie z rozumowaniem. Tymczasowy HOME nie może leżeć w repozytorium Git (Claude czytałby jego
  instrukcje); ścieżki zastępuje `/home/user`, adres atrapy `http://127.0.0.1:9`. `install.ts` instaluje je
  w HOME testu.
- **Adapter** (`apps/worker/src/import/scan.test.ts`): liczby i metadane trzech CLI, nienaruszone drzewo,
  brak treści rozmowy w wyniku, maskowanie (sekret z `auth.json` innego CLI i format `sk-ant-`), przypadki
  syntetyczne (urwane i niepoprawne linie, pusty plik, nowsza wersja, brak katalogu, dowiązanie do pliku
  spoza korzenia, katalog Groka z samym `summary.json`), podrabiane i obce `source_key`.
- **Maskowanie** (`apps/worker/src/import/masking.test.ts`): sekret w każdym kodowaniu JSON (raz, dwa razy,
  `\uXXXX`, pary surogatów, `\/`) w komendach i diffach, całe pole ukryte, gdy sekret jest tylko w widoku
  zdekodowanym, PEM bez końca, limit wartości, tytuły i podglądy trzech CLI maskowane przed łączeniem białych
  znaków, koszt liniowy (1 MiB znaczników bez końca i prefiksów tokenów przy 10 000 wartości).
- **Integracja** (`tests/integration/import-scan.test.ts`): skan przez łącze workera, filtry, grupy
  i propozycje projektów, kanarek sekretu nieobecny w odpowiedziach, odmowy (obcy worker, brak capability,
  nieznany skan, worker offline).
