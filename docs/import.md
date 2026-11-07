# Import z CLI agentów

Settings → Code → **Import** przenosi do Canopy wątki, które użytkownik prowadził wcześniej w Claude Code,
Codexie i Groku, tak żeby mógł je czytać i kontynuować. Strona działa w webie i desktopie; telefon
dostanie widok importów później (etap C).

Stos A (wątki) ma pięć etapów:

1. wykrywanie i podgląd,
2. silnik importu i historia Claude,
3. kontynuacja wątków Claude,
4. Codex,
5. Grok (ten dokument opisuje stan po etapie 5, czyli cały stos A).

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

Wiersz wątku pokazuje stan: *Imported*, *Has new turns* (zaimportowany, bez tur w Canopy, a CLI dopisało
nowe tury), *Already in Canopy* (wątek Canopy o tym samym id u dostawcy),
*History only* z powodem i *Secrets masked*. Zaznaczać można nowe wątki i te z nowymi turami; licznik i
szacunek rozmiaru dotyczą tylko ich.

6. **Import.** Tryb *Continue where possible* albo *History only* i przycisk **Import N threads**.
   Katalog z propozycją „New project” dostaje projekt o nazwie katalogu i workspace w nim (worker sprawdza
   katalog). Przebieg pojawia się w sekcji **Imports**.

## Przebieg

`StartImport` zamienia zaznaczenie skanu w przebieg (`import_runs`) z pozycjami (`import_items`), po jednej
na wątek CLI. Wybrane, ale wcześniej zaimportowane wątki nie dostają pozycji (`already_imported`). Na workerze
działa naraz jeden przebieg (`import_runs_active`).

Runner gatewaya (`apps/gateway/src/imports/runner.ts`) importuje wątki po kolei, a każdy stronami
(`ReadImportPage`, domyślnie do 4 MB, zawsze co najmniej cała tura). Strona to jedna transakcja: tury,
zdarzenia, `threads.last_seq` i kursor pozycji. Stany:

- **paused**: worker zniknął; runner wraca przy jego połączeniu (hook w `coreServe`), co 10 s
  i po **Resume**. Kontynuuje od zapisanego kursora. Automatyczne wznowienie to warunkowy `UPDATE` tylko
  ze stanu `paused` (`resumePaused`), a **Resume** to transakcja, która najpierw blokuje przebieg i ponownie
  sprawdza dozwolony stan (`resumeRun`): decyzja podjęta na nieaktualnym odczycie nie wskrzesi przebiegu
  anulowanego albo cofniętego w międzyczasie.
- **failed** pozycji: źródło nieczytelne albo zmienione (np. „the source changed since the scan; scan again”).
  Pozostałe wątki idą dalej. Wątek bez żadnej tury zostaje usunięty, a **Retry failed** tworzy nowy.
- **cancelled**: zatrzymanie po bieżącej stronie; wątek w trakcie jest usuwany, czekające pozycje dostają
  `cancelled`.
- **undone**: **Remove imported threads** najpierw w jednej transakcji oznacza przebieg i pozycje jako `undone`
  (`undoRun`, nic go już nie wznowi), potem usuwa wątki przebiegu (zwykłe miękkie usunięcie); źródła są wolne.
  Usunięcie zaimportowanego wątku ręcznie też zwalnia jego źródło przy następnym imporcie.

Przebieg kończy się jako `completed`, gdy coś się zaimportowało albo żadna pozycja nie zawiodła, inaczej `failed`.

## Kontynuacja

Tryb pozycji (`target.mode`, potem `thread_imports.mode`) wybiera plan: `native`, gdy proszono o kontynuację,
katalog istnieje, wątek zostaje w swoim katalogu, format jest sprawdzony
i nie jest to subagent; inaczej `history`.

- **Native.** Po ostatniej stronie runner wysyła `AdoptImportedSession`. Worker kopiuje prefiks ze skanu
  (do ostatniej pełnej linii) do prywatnego domu instancji: `<claude-home>/projects/<ta sama nazwa katalogu
  co u CLI>/<sesja>.jsonl`, razem z katalogiem `<sesja>/` (subagenci, wyniki narzędzi; tylko pliki i katalogi
  w domu CLI, bez dowiązań). Dom instancji wybiera dostawca i id profilu razem (to samo id może mieć instancja
  innego dostawcy).
  - **Maskowanie kopii.** Kopia przechodzi przez to samo maskowanie co oś czasu: każda linia JSONL i każdy plik
    JSON wartość po wartości (linia bez sekretu zostaje bajt w bajt), inne pliki tekstowe jako tekst, binarne
    i większe niż 64 MiB zostają pominięte. Model po wznowieniu nie widzi sekretu zamaskowanego w historii.
    Sesji, której nie da się zamaskować rekord po rekordzie (linia, która nie jest JSON-em), nie kontynuujemy
    natywnie: wątek zostaje historią z ostrzeżeniem „Continues in a new thread: …” i przyciskiem
    **Continue in a new thread**.
  - **Zapis bez dowiązań, z tożsamością.** Dom prywatny musi być katalogiem (nie dowiązaniem). Kopia najpierw
    powstaje w całości w osobnym katalogu roboczym w domu (nowe pliki `O_CREAT | O_EXCL | O_NOFOLLOW`, `fsync`),
    więc sesja, której nie da się zamaskować, kończy się błędem, zanim cokolwiek trafi na miejsce. Potem powstają
    potrzebne katalogi (każdy katalog od domu w dół musi być prawdziwym katalogiem), zapisuje się manifest, a na
    końcu pliki są przemianowywane na miejsce (rename zachowuje i-węzeł). Błąd w tej fazie cofa to, co ta kopia
    przeniosła. Istniejący plik, którego nie zapisała wcześniejsza kopia tej sesji (inna tożsamość), nie jest
    nadpisywany („Canopy already has a different copy”); własny jest nadpisywany przy ponownej próbie.
  - **Manifest.** `<data_dir>/import/copies/<cli>-<profil>-<sesja>.json` zapisuje tożsamość (urządzenie
    i i-węzeł) domu, każdego utworzonego katalogu i każdego pliku oraz snapshot. Przed pierwszym przemianowaniem manifest
    zapisuje też publikację w toku (`pending`: tożsamości nowych plików), a po ostatnim staje się końcowy. Worker
    zatrzymany w połowie zostawia oba zestawy, więc ponowna próba nadpisuje własne pliki, a Remove je usuwa.
    Końcowy manifest zachowuje każdy plik wcześniejszych zestawów, który jest nadal na miejscu z zapisaną
    tożsamością. Ścieżka w manifeście to same zwykłe nazwy (żadnego `.`, `..` ani pustego członu w środku)
    i musi rozwiązywać się wewnątrz domu. Kopia z tego samego snapshotu,
    której pliki są nadal na miejscu, zostaje bez zapisu.
  - **Bramka.** Wątek nie przyjmuje tur, dopóki jego pozycja jest `pending`/`importing`: `SendMessage` odpowiada
    „This thread is still being imported. Try again when it's done.”, a trigger `turns_import_gate` w bazie
    odrzuca turę z każdej innej ścieżki (harmonogram, agent), tak samo jak dla wątku-historii. Po udanej kopii
    gateway w jednej transakcji sprawdza, że import nadal trwa, ustawia `provider_thread_id` = id sesji tylko
    wtedy, gdy wątek nie ma innej sesji, i kończy pozycję. Pierwsza tura w Canopy uruchamia Claude Code
    z `resume` w prywatnym domu, a pliki użytkownika zostają nietknięte. „Fork from here” działa na
    zaimportowanych turach (`provider_turn_ref` = uuid ostatniego wpisu).
- **Continue in a new thread** (`ContinueImportedThread`, przycisk w miejscu kompozytora wątku-historii):
  nowy wątek główny w tym samym projekcie, workspace i katalogu (w „No project” nowy katalog scratch),
  z tytułem „… (continued)”. `settings.handoff` z notatką trafia do instrukcji nowej sesji, jak przy
  przeniesionym wątku: najnowsze tury (prompt i ostatnia odpowiedź, do 2000 znaków każda, razem do 24 000),
  liczba pominiętych i zmienione pliki. Bez wywołania modelu.
- **Has new turns.** Gdy plik CLI urósł, a zaimportowany wątek nie ma tur z Canopy, nowy przebieg kontynuuje
  ten sam wątek od kursora (stara pozycja dostaje `superseded`, nowa przejmuje wątek, kursor i cel). Kopia
  natywna jest zastępowana dłuższą (`replace`, tylko pliki z manifestu). Wątek z turami z Canopy rozszedł się
  z plikiem CLI: zostaje *Imported*; zapis przebiegu sprawdza to ponownie przy zablokowanym wątku. Wzrost
  porównuje rozmiar pliku historii ze skanu (snapshot) z `bytes_done`, nie łączny rozmiar sesji.
- **Remove.** Undo usuwa kopie wątków bez tur z Canopy (`RemoveImportedCopy`, najlepsza próba: worker offline
  zachowuje je w prywatnym domu). Punktem wyjścia jest dom prywatny, którego worker oczekuje teraz (nigdy ścieżka
  z manifestu): musi to być ten sam katalog co przy kopii (tożsamość), a usuwane są tylko pliki i puste katalogi
  osiągalne przez prawdziwe katalogi, z zapisaną tożsamością; tuż przed `unlink` plik jest otwierany bez
  podążania za dowiązaniem i sprawdzany ponownie. Podmieniony dom, dowiązanie po drodze albo cudzy plik zostają.
  Node nie ma `unlinkat`, więc między sprawdzeniem a usunięciem zostaje okno kilku wywołań systemowych w domu,
  do którego pisze tylko Canopy. Wątek, który pracował w Canopy, zachowuje kopię, żeby przywrócony wątek mógł dalej
  wznawiać.
- **Blokady.** Utworzenie dopisania, Cancel, Undo, strona, koniec pozycji i nieudane przejęcie sesji to każde
  jedna transakcja `importTransaction` (zob. „Blokady” niżej): pozycja zastępowana i nowa, ich przebiegi i wątek
  są zablokowane razem, zanim cokolwiek się zmieni. Dopisanie przejmuje wątek tylko od pozycji, która nadal jest
  `done`.
- **Anulowanie i Undo dopisania.** Pozycja, która dopisuje tury do wątku wcześniejszego importu, zapisuje
  `base`: ostatnie zdarzenie wątku i koniec jego ostatniej tury. Cancel albo Undo takiego dopisania usuwa tylko to,
  co dopisało (zdarzenia, nowe tury, stany itemów odbudowane reduktorem ze zdarzeń sprzed niego), przywraca koniec
  ostatniej tury i oddaje wątek wcześniejszej pozycji; historia sprzed dopisania zostaje. Undo cofa tak samo
  dopisania zakończone i nieudane. Wątek jest przy tym zablokowany, a sekwencja nigdy nie cofa się za coś, czego
  import nie zapisał: gdy po dopisaniu wątek poszedł dalej (tura z Canopy, inne zdarzenie), Undo odmawia
  („Can't undo: the thread continued after this import.”) i niczego nie usuwa; tak samo, gdy późniejszy import
  kontynuował jeden z wątków przebiegu (jego pozycja jest `superseded`). Wątek natywny, którego kopia
  zdążyła wchłonąć dopisane tury, przechodzi na kontynuację w nowym wątku.
- **Nieudany import natywny.** Wątek natywny bez przejętej sesji nie przyjmuje tur (trigger: brak
  `provider_thread_id`); nieudana pozycja przełącza go na tryb historii, a udana ponowna próba z powrotem na
  natywny.

### Codex natywnie

Kopia rolloutu (prefiks do ostatniej pełnej linii, zamaskowana linia po linii jak kopia Claude) trafia do
`CODEX_HOME` instancji
(`<data_dir>/codex-home` albo dom cienia) pod `sessions/RRRR/MM/DD/<ta sama nazwa pliku>`; data pochodzi
z nazwy, więc zarchiwizowane rollouty też trafiają do `sessions`. `provider_thread_id` = id wątku Codexa,
a pierwsza tura w Canopy wznawia go przez `thread/resume` (app-server znajduje rollout po id w swoim
`CODEX_HOME`). Zapis i Undo działają jak dla Claude: losowa nazwa tymczasowa, bez dowiązań, manifest;
Undo usuwa tylko pliki z manifestu.

## Strony i zapis

Worker (`apps/worker/src/import/pages.ts`) przy każdej stronie: rozwiązuje `source_key`, sprawdza, że plik
jest co najmniej tak długi jak przy skanie i że sha256 jego pierwszych bajtów (do 64 KiB, długość ze skanu)
się zgadza, i czyta tylko prefiks ze skanu. Kursor to przesunięcie w bajtach początku następnej tury.
Linia bez końca (CLI jeszcze ją pisze) nie wchodzi do importu: `bytes_read` kończy się na ostatnim pełnym
rekordzie. Na końcu źródła kursor wskazuje początek ostatniej tury, więc import tur dopisanych później czyta
ją ponownie; gateway dopisuje do zapisanej tury tylko zdarzenia, których nie miała (krok, który się skończył,
dostaje nowe zdarzenie, bo skrót zakodowanej treści itemu wchodzi do id), i ustawia jej koniec: wynik,
błąd i `provider_turn_ref`, także gdy żaden krok się nie zmienił.

Każda tura (`ImportedTurn`) ma `turn_started`, itemy jako `item_completed` z pełnym stanem i `turn_finished`.
Id tury i zdarzeń to UUIDv5 z id wątku Canopy i id źródła: powtórzona strona daje te same id, gateway pomija
zapisane tury, a ten sam wątek CLI zaimportowany do innego wątku (np. po Remove) dostaje inne id. Tekst
jest maskowany jak w skanie, ale na zdekodowanych wartościach: każde pole tekstowe osobno, a JSON w polu
(argumenty i wyniki narzędzi, także JSON zakodowany jako napis w JSON-ie, do 8 poziomów) wartość po wartości,
więc sekret z `\` albo `"` nie ucieka przez escape. Limity liczone na kodowaniu protobuf, które niesie łącze,
razem z kopertami zdarzeń. Kolejność jest stała: tekst jest najpierw maskowany w całości (JSON zdekodowany
w całości), a dopiero potem skracany, w jednej funkcji (`maskedText`); czytniki nie skracają niczego same.
Co więcej, każdy rekord źródła jest maskowany jako zdekodowane wartości zaraz po odczycie (`maskedRecord`), zanim
czytnik zrobi z niego cokolwiek (diff z treści `Write`, podgląd komendy, patch Codexa, diff i wynik
terminala Groka): dotyczy to czytników Claude, Codexa i Groka.
Pole do 1 MB z dopiskiem „[… N KB shortened on import]”; metadane tury (model, `provider_turn_ref`) do 1 KiB,
błąd do 4000 znaków; zdarzenie itemu do 1,5 MiB
(pola maleją do 16 KiB, potem 1 KiB, a krok nadal za duży, np. z bardzo długą listą zmian, zostaje na swoim
miejscu z notatką „This step is too large to import”); tura do 8 MiB z zapasem na start, koniec i notatkę
(dalsze kroki zastępuje „N more steps of this turn not imported”). Strona to najwyżej 4 MiB plus jedna tura;
tura jest sprawdzana w całości przed dodaniem do strony (za duża zostaje zastąpiona notatką „This turn is too
large to import”), a worker odmawia wysłania strony większej niż 4 MiB + 8 MiB + 64 KiB, więc zawsze mieści się w 32 MiB łącza workera;
`raw_json` zostaje pusty.

Gateway (`apps/gateway/src/imports/ingest.ts`) tworzy wątek raz na pozycję, w jednej transakcji z
`thread_imports` i powiązaniem pozycji (pozycja zablokowana i sprawdzona ponownie): główny, z miejscem z planu,
`settings.permissionMode = ASK`, statusem `idle` i tytułem z CLI (`title_source = user`, bez tytułu
pierwsza wiadomość). Tury mają `trigger = import`, czasy źródła i `provider_turn_ref`. `created_at` wątku
to start pierwszej tury, więc sidebar sortuje go w przeszłość, a `thread_reads` oznacza historię jako
przeczytaną. UI pokazuje turę `import` jak wiadomość użytkownika.

Każda strona i zakończenie pozycji sprawdzają w tej samej transakcji, że import nadal trwa (blokady przebiegu
i pozycji, zob. „Blokady”). Cancel to jedyna ścieżka sprzątania (runner tylko widzi stan końcowy i staje; jego własne przejścia, czyli
pauza, błąd pozycji i koniec przebiegu, zachodzą tylko przy przebiegu `running`, więc stan końcowy zostaje), działa bez aktywnego runnera,
w jednej transakcji: pozycje czekające i importowana
zostają `cancelled`, jej wątek (tylko to, co zapisał import) jest usuwany, a źródło znów wolne; strona,
która była w drodze, nie zapisuje już nic.

### Blokady

Każda transakcja importu idzie przez `importTransaction` (`apps/gateway/src/imports/locks.ts`) i żadnej
innej drogi nie ma (`locks.test.ts` sprawdza, że `FOR UPDATE` i `withTransaction` nie występują w innych plikach
`apps/gateway/src/imports`). Helper:

1. wylicza pełny zbiór wierszy, które transakcja może zmienić: podane przebiegi i przebiegi podanych pozycji,
   wszystkie pozycje tych przebiegów i wszystkie pozycje dotkniętych wątków (także `superseded`), wątki tych pozycji;
2. blokuje je przed jakimkolwiek zapisem, jednym zapytaniem na tabelę, w stałej kolejności: `import_runs`, potem
   `import_items`, potem `threads`, każde `SELECT … WHERE id = ANY($1) ORDER BY id FOR UPDATE`;
3. pod blokadami liczy zbiór ponownie; gdy urósł (np. w międzyczasie powstało dopisanie do wątku), zaczyna
   transakcję od nowa (do 5 razy).

Treść transakcji zmienia tylko zablokowane wiersze i to, co należy do zablokowanego wątku (tury, zdarzenia,
`thread_imports`). Wieloetapowe zmiany stanu (wznowienie, błąd pozycji z usunięciem pustego wątku, cofnięcie)
to jedna transakcja, bez zapisów w trybie autocommit pomiędzy.

Tryb `history` (`thread_imports.mode`): gateway odrzuca `SendMessage`, a miejsce kompozytora zajmuje
„Imported from … as history” z **Continue in a new thread** i odnośnikiem do importów.

## Claude

`apps/worker/src/import/claude-index.ts` i `claude-history.ts`:

- **Gałęzie.** Plik sesji jest drzewem: wpis wskazuje rodzica (`parentUuid`, po kompaktowaniu
  `logicalParentUuid`); węzłami są wszystkie wpisy z `uuid`, także `attachment`. Aktywna gałąź prowadzi od
  liścia z ostatniego `last-prompt.leafUuid` (inaczej najnowszego wpisu) w dół do najnowszego potomka i w górę
  do korzenia. Odgałęzienia bez promptu (równoległe wyniki narzędzi, postęp) należą do rozmowy; odgałęzienie
  z promptem to porzucona edycja lub cofnięcie: nie jest importowane, strona dostaje ostrzeżenie
  „N earlier branches not imported”. Przejścia są iteracyjne, ze zbiorem odwiedzonych: wpis, który jest
  własnym przodkiem (pętla `parentUuid`), kończy import tej sesji błędem „… point to each other in a loop”,
  zamiast zablokować workera; pętla w porzuconym odgałęzieniu po prostu się kończy.
- **Tury.** Turę zaczyna prompt użytkownika albo komenda (`<command-name>` → `/nazwa argumenty`). Nie są
  promptami: wyniki narzędzi, `isMeta`, `isCompactSummary`, `<local-command-*>`, `<task-notification>`,
  „[Request interrupted by user…”.
- **Itemy.** Bloki `text` i `thinking` (id `<message id>:<index>`), `tool_use` przez mapowanie adaptera
  (`content-mapping.ts`), wynik z `tool_result`. `Task`/`Agent` to item `subagent` z wynikiem; jego kroki
  z `<sesja>/subagents/agent-*.jsonl` (`meta.json.toolUseId`, do 32 MB) mają `parent_item_id` = wywołanie.
  Subagenci zapisani w pliku sesji (starszy format) nie są importowani: ostrzeżenie.
- **Kompaktowanie.** `compact_boundary` daje `context_compaction` z podsumowaniem z następnego wpisu
  `isCompactSummary`; ręczne `/compact` jest osobną turą, automatyczne zostaje w bieżącej.
- **Koniec tury.** „[Request interrupted by user…” → `interrupted`, `isApiErrorMessage` → `failed` z tekstem
  błędu, inaczej `completed`; niedokończone narzędzia → item `interrupted`.
- **Pomijane wpisy:** `api-request*`, `atis-latch`, `queue-operation`, `cost-state`, `file-history-snapshot`,
  `last-prompt`, `mode`, `pr-link`, tytuły. Niepoprawne linie są liczone („N lines could not be read”).

Sprawdzone na prawdziwych sesjach Claude (bez zapisu i bez wypisywania treści): ten komputer 357 sesji, 2537 tur,
85 888 itemów, 0 błędów, 1 sesja z porzuconą gałęzią; Mac Studio 116 sesji, 297 tur, 20 187 itemów, 0 błędów.

## Protokół

Capability `cli_import_v1`; `WORKER_LINK_PROTOCOL` się nie zmienia. Komendy importu są nietrwałe: nigdy
z outboxa ani journala ([protocol.md](protocol.md#komendy-gateway--worker)).

| Komenda | Wynik | Etap |
|---|---|---|
| `ScanImportSources { agent_clis }` | `CommandResult.import_scan`: `ImportRoot[]`, `ImportThreadSummary[]`, `truncated`, `skipped` | 1 |
| `ReadImportPage { source_key, snapshot, cursor, thread_id, max_bytes }` | `CommandResult.import_page`: `ImportedTurn[]`, `next_cursor`, `done`, `warnings`, `skipped_lines`, `bytes_read`, `title` | 2 |
| `AdoptImportedSession { source_key, snapshot, profile_id, replace }` | `CommandResult.imported_session_id` | 3 |
| `RemoveImportedCopy { agent_cli, profile_id, session_id }` | — | 3 |

UI API (`proto/canopy/ui/v1/cli_import.proto`): `ScanImport`, `ListImportCandidates`, `StartImport`,
`ListImportRuns`, `GetImportRun`, `CancelImportRun`, `ResumeImportRun`, `UndoImportRun`, `ContinueImportedThread`. `ui.Thread.import`
(`agent_cli`, `mode`, `imported_at`) oznacza zaimportowany wątek. Metody nie są trasowane do połączonych
komputerów.

## Codex

`apps/worker/src/import/codex-history.ts` prowadzi rollout przez mapper adaptera Codexa
(`CodexEventMapper`, ten sam co dla wątków na żywo, oraz `threadItem` i `decodeResponseItem`):

- **Tury:** `task_started` … `task_complete` (z `error` → `failed`) albo `turn_aborted` → `interrupted`;
  `provider_turn_ref` = id tury Codexa, `model` z `turn_context`. Rekordy przed pierwszą turą
  (`session_meta`) nie tworzą tury; pusta tura jest pomijana.
- **Nowsze rollouty:** `event_msg item_completed` przez mapper (wiadomości, rozumowanie jako
  `reasoning.summary`, komendy z wynikiem, zmiany plików, MCP, wyszukiwanie, subagenci); `UserMessage` daje
  prompt tury, nie item. Surowe `response_item` dają wywołania powłoki bez itemu i komórki trybu kodu, na końcu
  tury jak na żywo.
- **Starsze rollouty** (bez `item_completed`): prompt z `event_msg user_message` (bez `task_started` otwiera
  turę), odpowiedzi z `response_item message` asystenta, rozumowanie z podsumowań `response_item reasoning`,
  komendy z `function_call` i wyniku przez mapper. `compacted` daje `context_compaction` tylko w rolloutach
  bez itemów (nowsze zapisują kompaktowanie także jako item).
- Wstrzyknięty kontekst Codexa (`<environment_context>`, `<user_instructions>`, `# AGENTS.md` …) nie jest
  promptem.

Odstępstwo od projektu: zamiast pomocniczego app-servera na kopii rolloutu starsze formaty czyta własne
mapowanie z testem na syntetycznym rolloucie; wynik jest deterministyczny i nie uruchamia CLI.

Sprawdzone na prawdziwych rolloutach (bez zapisu i bez wypisywania treści): ten komputer 366 wątków, 1093 tury,
165 632 itemy, 317 kompaktowań, 0 błędów; Mac Studio 30 wątków, 295 tur, 18 916 itemów, 0 błędów.

## Grok

`apps/worker/src/import/grok-history.ts`:

- **Źródło.** `updates.jsonl` (log ACP sesji) przez mapper adaptera Groka (`GrokEventMapper`, ten sam co na
  żywo), z pełnymi aktualizacjami narzędzi (wejście, wynik, diff, stan). Bez tego logu: `chat_history.jsonl`
  (prompty z `prompt_index`, odpowiedzi, wywołania narzędzi z wynikiem z `tool_result`; zaszyfrowane
  rozumowanie pomijane). Snapshot skanu dotyczy tego samego pliku.
- **Tury.** `user_message_chunk` otwiera turę (prompt z kolejnych fragmentów, model z `_meta.modelId`);
  `_x.ai/session/update turn_completed` kończy ją: `end_turn` → `completed`, `cancelled` → `interrupted`,
  inne → `failed`. Sesje interaktywne nie logują promptów w `updates.jsonl`: treść przed promptem tworzy
  turę bez promptu, a koniec wyznacza `turn_completed`. `provider_turn_ref` = id sesji (ACP Groka nie forkuje).
- **Puste sesje.** Mała sesja bez żadnej treści rozmowy jest w skanie `empty`; import, który nie dał żadnej
  tury, nie zostawia pustego wątku (ostrzeżenie „Nothing to import”).
- **Natywnie.** Kopia trafia do trwałego katalogu sesji instancji
  `<data_dir>/grok/<instancja>/sessions/<zakodowany cwd>/<id>/`, który każdy proces Groka podpina jako
  `GROK_HOME/sessions`. Kopia to sesja dokładnie w chwili skanu: skan zapisuje snapshot logu ACP i osobno
  snapshot `chat_history.jsonl` (rozmiar i sha256 pierwszych 64 KiB); kopia obu plików kończy się na tych
  rozmiarach (pełne rekordy), więc ani prompt, ani dłuższa odpowiedź dopisana po skanie do niej nie trafia. Manifest
  zapisuje oba snapshoty: kopia z innego skanu (choćby tylko dłuższa historia czatu) jest tworzona od nowa. Do
  tego `summary.json`, `prompt_context.json`, `system_prompt.txt`, `tool_definitions.json`; wszystko zamaskowane
  jak u Claude, zapis i manifest też. Pozostałe pliki (zdarzenia, punkty cofania, logi terminala, `*.lock`) zostają. Sesja
  bez `chat_history.jsonl` albo bez jego snapshotu (skan starszego workera) kontynuuje w nowym wątku.
  `provider_thread_id` = id sesji; pierwsza tura w Canopy
  robi `session/load`. Każdy plik sesji czyta się w domu Groka bez dowiązań (także `chat_history.jsonl`).
- **Has new turns** porównuje rozmiar pliku historii ze snapshotu, a nie sumę plików sesji.

Odstępstwo od projektu: historia pochodzi z odczytu `updates.jsonl` przez mapper adaptera, a nie z odtworzenia
`session/load` w pomocniczym procesie; wynik jest ten sam, bez uruchamiania CLI na danych użytkownika.

Sprawdzone na prawdziwych sesjach (bez zapisu i bez wypisywania treści): Mac Studio 22 sesje, 6 tur,
391 itemów, 0 błędów (pozostałe sesje bez treści rozmowy); na tym komputerze jedna sesja bez historii.

## Model danych

Migracja `0093_cli_imports`:

- `turns.trigger` dopuszcza `import` (`hops = 0`).
- `import_runs`: właściciel, worker, `status` (`running | paused | completed | failed | cancelled | undone`),
  `mode`, `already_imported`, błąd i czasy. Indeks `import_runs_active`: jeden przebieg na workerze.
- `import_items`: pozycja w przebiegu, CLI, `root_id` i `native_id` (stała tożsamość źródła), `source_key`,
  tytuł, katalog, snapshot, cel (`projectId`, `workspaceId`, `cwd`, `mode`), stan, kursor, wątek, liczby tur
  i bajtów, ostrzeżenia; `superseded`, gdy późniejszy przebieg kontynuuje ten sam wątek. Indeks `import_items_source`: jedno żywe źródło
  (`pending | importing | done | failed`) na właściciela i workera.
- `thread_imports`: wątek, pozycja, CLI, `native_id`, `mode` (`native | history`), wersja CLI źródła.

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
  - całe wiadomości, nie kawałki: CLI zapisuje jedną wiadomość w częściach (Grok strumieniuje prompt, odpowiedź
    i rozumowanie w kawałkach, Claude Code zapisuje każdy blok wiadomości jako osobny wpis, a części treści
    są łączone w jeden tekst). Maskowanie każdej części osobno rozcina klucz (nagłówek w jednej, treść w następnej)
    i zostawia treść klucza. Dlatego:
    - w obrębie rekordu napisy i klucze są dodatkowo sprawdzane złączone liniami w kolejności dokumentu; sekret,
      który przechodzi przez granicę dwóch napisów, ukrywa każdy z nich w całości;
    - kawałki strumienia (Grok) i bloki tekstu i rozumowania (Claude) trafiają do itemów w postaci z CLI,
      a `finish()` maskuje całą turę: najpierw prompt i pola itemów złączone w kolejności (sekret przez granicę
      pól ukrywa te pola), potem każde pole osobno. Podgląd skanu Groka łączy kawałki pierwszego promptu przed
      maskowaniem;
    - rekordy, z których czytnik robi coś więcej (diff, komendę, wynik narzędzia), są maskowane przed tym
      przekształceniem jak dotąd. Codex zapisuje każdą wiadomość, rozumowanie i wywołanie w jednym rekordzie.

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
- **Klucz w częściach** (`apps/worker/src/import/split-secrets.test.ts`): wygenerowany klucz RSA podzielony
  na nagłówek, treść pociętą w przypadkowych miejscach i stopkę, w kawałkach promptu, odpowiedzi i rozumowania
  Groka, w częściach treści historii Groka, w częściach promptu i w osobnych wpisach jednej wiadomości Claude
  (tekst i rozumowanie), w częściach wiadomości i rozumowania Codexa oraz w rekordzie kopii natywnej; nigdzie
  w skanie ani w stronach nie ma 16 kolejnych znaków treści klucza. Także dane logowania jako klucz obiektu
  i sekret za escape'em obok zamaskowanego pola.
- **Środowisko testów integracyjnych** (`tests/integration/support/imports.ts`): fixture ma własny syntetyczny
  login każdego CLI (Claude `.credentials.json`, Codex i Grok `auth.json`) i nie zależy od loginu ani kluczy API
  maszyny. Po każdym teście `restore()` przywraca worker online i zwykły rozmiar strony, także gdy test padł.
  Testy pauzy i anulowania odłączają worker deterministycznie przed wskazaną stroną (`offlineAtPage`, hak
  `beforePage` runnera), zamiast ścigać się z runnerem.
- **Integracja** (`tests/integration/import-scan.test.ts`): skan przez łącze workera, filtry, grupy
  i propozycje projektów, kanarek sekretu nieobecny w odpowiedziach, odmowy (obcy worker, brak capability,
  nieznany skan, worker offline).
- **Adapter Claude** (`apps/worker/src/import/claude-history.test.ts`): wszystkie tury fixture i te same id
  przy podziale na strony, aktywna gałąź, przerwanie, błąd API, niepoprawna linia, równoległe wyniki narzędzi,
  zmienione źródło.
- **Integracja Claude** (`tests/integration/import-claude.test.ts`): pełna oś czasu jako historia (narzędzie,
  rozumowanie, subagent z krokami, kompaktowanie), czasy źródła, odmowa wiadomości, nienaruszone pliki;
  ponowny import i ponowne strony bez duplikatów; pauza po odłączeniu workera i dokończenie od kursora;
  Remove; maskowanie kanarka w zdarzeniach, itemach, turach i pozycjach; zmienione źródło psuje tylko swoją
  pozycję; cudzy przebieg niewidoczny; klucz spoza skanu niczego nie wybiera.
- **Wznowienie z prawdziwym Claude Code** (`apps/worker/src/import/claude-resume.test.ts`, bez loginu):
  kopia fixture w prywatnym domu, tura przez `ClaudeThreads` z atrapą modelu; żądanie zawiera historię tak,
  jak Claude ją odtwarza (podsumowanie kompaktowania i tury po nim), pliki CLI są nietknięte, tura trafia
  do kopii.
- **Integracja kontynuacji** (`tests/integration/import-claude-continue.test.ts`, atrapa Claude Code
  `fixtures/instance-claude.ts`): import natywny, tura w Canopy uruchamia `--resume` importowanej sesji
  w `<data_dir>/claude-home`; Continue in a new thread niesie notatkę w instrukcjach; nowe tury CLI trafiają
  do tego samego wątku i kopii; Undo usuwa kopie nieużyte i zostawia kopię wątku z turą z Canopy.
- **Blokady** (`tests/integration/import-locks.test.ts`, PostgreSQL): 40 rund, w każdej naraz i w losowej
  kolejności utworzenie dopisania, Undo, Cancel, Resume, zapis strony, błąd i koniec pozycji oraz zwolnienie usuniętych
  wątków na tych samych wątkach; żadnego `40P01`, każdy wątek ma dokładnie jedną żywą pozycję, a `last_seq`
  zgadza się ze zdarzeniami. Undo przebiegu, którego wątek kontynuował późniejszy import, jest odrzucane bez zmian.
  `apps/gateway/src/imports/locks.test.ts` pilnuje, że blokady i transakcje biorą się tylko z `importTransaction`.
- **Adapter Codex** (`apps/worker/src/import/codex-history.test.ts`): tury, komenda z wynikiem i te same id
  przy podziale na strony; syntetyczny starszy rollout (bez `item_completed`): wiadomości, rozumowanie,
  wywołanie powłoki, kompaktowanie, przerwana i nieudana tura, niepoprawna linia.
- **Wznowienie z prawdziwym Codexem** (`apps/worker/src/import/codex-resume.test.ts`, bez loginu): kopia
  w prywatnym `CODEX_HOME`, `thread/resume` po id w prawdziwym app-serverze z atrapą modelu; żądanie zawiera
  oba wcześniejsze prompty i wynik narzędzia.
- **Integracja Codex** (`tests/integration/import-codex.test.ts`, atrapa app-servera
  `fixtures/instance-codex.ts`, która wznawia też prawdziwy układ rolloutów): historia bez echa promptu,
  komenda z wynikiem, rozumowanie, nietknięte rollouty; import natywny z kopią i `thread/resume` przy turze
  w Canopy.
- **Live** (`apps/worker/src/import/resume.live.test.ts`, `CANOPY_LIVE=1` z CLIProxyAPI): sesja zrobiona
  prawdziwym CLI poza Canopy zapamiętuje słowo, import kopiuje ją do prywatnego domu, wznowiona tura
  z prawdziwym modelem je podaje; pliki użytkownika nietknięte. Claude Code, Codex i Grok.
- **Adapter Grok** (`apps/worker/src/import/grok-history.test.ts`): tury, polecenie terminala z wynikiem,
  rozumowanie i te same id przy podziale; sesja interaktywna bez promptów (koniec po `turn_completed`,
  anulowana tura, niepoprawna linia); sesja tylko z `chat_history.jsonl`.
- **Wznowienie z prawdziwym Grokiem** (`apps/worker/src/import/grok-resume.test.ts`, bez loginu): kopia
  w katalogu sesji instancji, `session/load` przez ACP z atrapą modelu; żądanie zawiera oba wcześniejsze
  prompty i odpowiedź.
- **Integracja Grok** (`tests/integration/import-grok.test.ts`, atrapa ACP `fixtures/instance-grok.ts`, która
  ładuje też prawdziwy układ katalogów sesji): historia z poleceniem i wynikiem, nietknięte sesje; import
  natywny z kopią i `session/load` przy turze w Canopy.
- **Wydajność** (`apps/worker/src/import/performance.test.ts`): wygenerowana sesja Claude
  (`CANOPY_IMPORT_PERF_MB`, domyślnie 160 MB, głównie cache żądań): skan poniżej 2 s, kilka stron, przyrost
  pamięci poniżej 400 MB. Lokalnie: 160 MB w 2,5 s, +68 MB (maskowanie z widokami zdekodowanymi i sprawdzaniem złączonych pól).
