# Ograniczanie procesów

## Audyt procesów

Audyt obejmuje produkcyjny kod worker/gateway i importowanych adapterów/updatera;
testy i skrypty developerskie nie są runtime platformy. Wszystkie lokalne spawn
sites przechodzą przez współdzielony pakiet `@canopy/process-governor`.

| Miejsce | Wyzwalacz i możliwa multiplikacja | Ochrona |
| --- | --- | --- |
| worker `workspace-copy` | Lista plików, podsumowanie Git i końcowe `git fsck`; porcje plików nie uruchamiają procesów. | Git przez wspólny governor; najwyżej cztery podglądy i dwa cele. Skan pomija ignorowane katalogi zależności/builda przed odczytem ich zawartości. Gateway: dwie kopie, jedna potwierdzana porcja 128 KiB i 8 MiB/s na kopię. Asynchroniczne I/O nie blokuje pętli streamingu wątków. |
| worker `git/git.ts` | Ref picker, tworzenie/rename, status i cleanup. `scanWorktree` wykonuje kilkanaście odczytów plus detekcję merged: do kilkudziesięciu git/worktree. 50 worktree oznacza setki–tysiące procesów na pełny skan, nawet jeśli pojedyncza pętla jest sekwencyjna. Niezależne żądania UI i cleanup mogą się nakładać. | git ≤4, wspólna kolejka, single-flight odczytów, TTL 1 s. Usuwanie działa w `freshGit`: bez cache i bez łączenia z wcześniejszym skanem. Mutacje unieważniają cache przed i po zakończeniu. |
| worker `git/clone.ts` | Jawny klon projektu/workspace'u; stderr strumieniowane przez `runProcess.onStderr`, bez narastającego capture. | Ten sam budżet git ≤4; brak cache/dedupe, unieważnienie przed i po. Parser trzyma 30 linii po 500 znaków i do 8192 znaków niezamkniętej linii. Aktualizacje co ≥250 ms, 2 min bez zmiany liczników lub fazy, 60 min łącznie. Abort zabija własne drzewo procesów i sprząta częściowy katalog. |
| worker `runtime/git-commands.ts` | Reveal folderu na kliknięcie; status per target. | utility ≤2 / 5 s; skany harmonogramu mają priorytet background przenoszony w addytywnym polu proto. |
| gateway `worktrees/cleanup-schedule.ts` | Start, reconnect, co godzinę. Obecny single-flight per worker/global zapobiega części nakładania; różne workery nadal pracują równolegle. | Priorytet background, odrzucanie przeterminowanych oczekujących procesów; brak cache dla końcowej walidacji usunięcia. |
| gateway `agent-environment/source-git.ts` | Preview/refresh źródeł skilli i pluginów: ls-remote, init/fetch, ls-tree/cat-file. Kilka źródeł × wiele plików; nie jest to polling UI. | git ≤4, dotychczasowe limity czasu, pamięci i transferu; abort w kolejce sprawdzany przed spawn. Brak współdzielenia operacji z sekretami/katalogami tymczasowymi. |
| gateway `store/bus-threads.ts` | `spawn` jest operacją SQL tworzącą wątek; nie uruchamia procesu OS. | Limity runtime harnessu obowiązują później na workerze. |
| worker `config/remote.ts` | Zastosowanie konfiguracji, ProbeProviders, koniec logowania. Wcześniej synchroniczny `--version` per dostawca/instancja: N × 10 s blokady event loop. | Asynchroniczne przygotowanie wersji, probe ≤2, dedupe i TTL 60 s. Walidacja z wstrzykniętym DeviceProbe pozostaje synchroniczna. |
| worker `cli-tools/discovery.ts` | Hello/reconnect, ręczne odświeżenie, po instalacji, co 6 h; trzy CLI plus mise shim. Kandydaci sprawdzani po kolei do pierwszego działającego (zwykle 1 sonda na CLI, maks. 8). Raport CLI i konfiguracja dzielą klucz. | probe ≤2, TTL 60 s, pełny kontekst w kluczu. |
| worker `cli-tools/shell-env.ts` | `$SHELL -l -i -c` raz na start procesu; ponownie przy `ProbeProviders`, najwyżej raz na minutę. | probe ≤2, limit 8 s, 1 MiB, single-flight. |
| worker `cli-tools/installer.ts` | Wyłącznie jawna instalacja/rollback. | install ≤4; wspólne zasoby menedżera szereguje `CliTools`, niezależne CLI działają równolegle. Maks. 10 min / rollback 5 min, kill drzewa; cache wersji unieważniany. |
| worker `files/search.ts` | Każdy znak w wyszukiwaniu plików; istnieje cache listingu, ale zimne równoległe żądania mogły dublować ls-files. | git ≤4, single-flight i TTL 1 s, limit wyniku/czasu; istniejący cache i fallback spaceru pozostają. |
| worker Codex app-server, Grok ACP, Claude SDK (sessions/catalog/generate-text) | Długo działające sesje per instancja/wątek, katalogi i krótkie generowanie; reconnect/config może tworzyć runtime. | Osobny budżet harness ≤24, synchroniczne API odmawiają po wyczerpaniu zamiast tworzyć proces bez limitu. Brak dedupe sesji i limitu długości sesji. |
| updater `binary.ts` | Jeden nadzorowany child, sekwencyjny restart/rollback. `execve` zastępuje proces. | supervisor ≤2, istniejący startup deadline/forwarding/rollback pozostają. |
| gateway SSH install | `ssh2.Client.exec` uruchamia ustalony instalator na zdalnej maszynie, nie lokalny spawn. | Istniejący owner-scoped limit i timeout instalacji; lokalnego procesu OS nie tworzy. |

Nie ma okresowego pollingu git na każdy render. Pełne odświeżenie worktree jest
wywoływane przez UI lub harmonogram. Liczby wyżej są analizą statyczną fan-out,
nie pomiarem produkcyjnym. Governor ogranicza jednoczesność, nie łączną liczbę
różnych komend potrzebnych do skanu.

## Budżety, kolejka i bezpieczeństwo

Jeden scheduler na proces worker/gateway: maks. **34** bezpośrednich dzieci,
w tym maks. **8** krótkich komend. Git 4, probe 2, install 4, utility 2,
harness 24, supervisor 2. Długo działające sesje nie zajmują budżetu krótkich
komend. To nie jest limit hosta między wieloma niezależnymi usługami ani limit
procesów uruchamianych wewnętrznie przez sam harness/narzędzia modelu.

Kolejka mieści 256 zadań. FIFO w priorytecie; user wybierany przed background.
Background czeka maks. 5 s, user 30 s. Kliknięcie może wyprzeć oczekujące
background przy pełnej kolejce. Długotrwały napływ kliknięć może odroczyć
background, który jest wtedy odrzucany i wraca w kolejnym cyklu harmonogramu.
Single-flight obejmuje identyczne aktywne i oczekujące odczyty. Klucz SHA-256
uwzględnia argv, cwd, env, stdin i limity, nigdy nie jest logowany. Cache do
512 pozycji; nie utrwala nic na dysku. `snapshot()` pokazuje liczniki aktywnych,
queued, started, joined, cacheHits i dropped. Saturacja emituje najwyżej jedną
linię na 30 s, tylko liczniki, bez komend, ścieżek, env i outputu.

Krótkie komendy mają deadline i limit 8 MiB capture (sondy wersji 64 KiB).
POSIX: osobna grupa procesu i SIGKILL całej grupy. Windows: `taskkill.exe /T /F`
wyłącznie na PID własnego child; to awaryjny wyjątek od kolejki, żeby saturacja
nie uniemożliwiała sprzątania. Źródła git zachowują własny limit capture i dysku.
Instalator streamuje zredagowane linie. Sesje harnessu zachowują swój lifecycle,
bez krótkiego deadline przeznaczonego dla git/probe.

Śledzenie gałęzi rozstrzyga gitdir raz, potem odczytuje `HEAD` bez procesu po zdarzeniu fs (debounce
150 ms) i zakończeniu tury. Picker gałęzi pobiera refy dopiero po otwarciu, bez discovery worktree.
Przełączenie omija cache odczytów; jeden sygnał anulowania obejmuje walidację, kolejkę i mutację,
z deadline 90 s krótszym od timeoutu gatewaya. Przeterminowana komenda nie uruchamia git.

## Ocena bibliotek git

Źródła sprawdzono 2026-11-04 przez publiczne registry npm i repozytoria upstream.
Bun repo: 1.4.4. Nie instalowano żadnej z ocenianych bibliotek do aplikacji.

| Kandydat | Funkcje i dystrybucja | Decyzja |
| --- | --- | --- |
| [es-git](https://github.com/toss/es-git), npm 0.7.0 | MIT, git2-rs/libgit2 przez N-API. Aktualny manifest ma prebuildy linux x64/arm64 gnu **i musl**, darwin arm64, windows x64 (także inne). API zawiera worktrees/open linked worktree, status, graph ahead/behind, refs, clone/fetch z callbacks. Część operacji jest synchroniczna; `statuses()` nie daje tych samych opcji co obecny status z ignored/untracked. Prune libgit2 nie jest automatycznie bezpiecznym odpowiednikiem `git worktree remove`. Squash detection wymaga zachowania patch-equivalence, nie tylko merge-base. | Najlepszy kandydat na dalszy spike. Samo N-API i obecność prebuildów nie dowodzą działania dynamicznego loadera `.node` w `bun build --compile` na każdym celu i w obrazach. Nie mamy zweryfikowanej macierzy ani zgodności semantyki statusu wymaganej przy cleanup. Nie wprowadzamy częściowego backendu tylko na Linux. |
| [nodegit](https://github.com/nodegit/nodegit), npm stable 0.27.0 | MIT, libgit2, API status/refs/network/worktrees zależne od wersji. Stable używa NAN/V8 i node-pre-gyp, a nie przenośnego kontraktu N-API; stary manifest nie zapewnia wymaganej macierzy Bun/arm64. Development upstream nie stanowi potwierdzenia zgodności stable. | Brak wykazanej zgodności z Bun i targetami, duży koszt pakowania natywnych zależności i narzędzi kompilacji w Docker. Odrzucony. |
| [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git), linia 1.x | MIT, aktywna biblioteka JS, bez binarek natywnych; statusMatrix, branches, log/walk/merge-base, clone/fetch HTTPS z callback auth. Nie jest pełnym zamiennikiem git; publiczne API nie oferuje całego worktree add/list/remove/prune wraz z admin metadata linked worktrees. Własna implementacja odczytu gitdir/commondir nie daje jeszcze równoważności statusu i ahead/behind. SSH/credential helpers oraz patch-id/cherry/reverse apply nie są identyczne z CLI. | Łatwe pakowanie, ale niedostateczna zgodność operacji i linked worktrees dla naszych gorących ścieżek. Nie dokładamy drugiego modelu indeksu/statusu bez pełnej walidacji. |

Źródła: [manifest es-git](https://registry.npmjs.org/es-git/latest),
[typy es-git](https://github.com/toss/es-git/blob/main/index.d.ts),
[manifest nodegit](https://registry.npmjs.org/nodegit/latest),
[statusMatrix](https://isomorphic-git.org/docs/en/statusMatrix),
[API isomorphic-git](https://isomorphic-git.org/docs/en/alphabetic).

**Decyzja:** żadna biblioteka nie spełnia dziś udowodnionej zgodności we
wszystkich wymaganych artefaktach Canopy. Pozostaje CLI z governorem i cache.
Nie oznacza to, że es-git nie działa z Bun: brakuje potwierdzenia macierzy,
dlatego nie uznajemy go za bezpieczny backend sprzątania. Nie zmieniamy
licencji ani SBOM/dependency graph aplikacji o natywne biblioteki.

## Świeżość i testy

Settings → Diagnostics pokazuje lokalne przyjęcia, czas oczekiwania i wykonania,
odrzucenia oraz aktywne i oczekujące zadania governora. Obserwator przyjmuje
wyłącznie stałe rodzaje, priorytety i kody zdarzeń; klucze deduplikacji,
argumenty procesów i błędy nie przekraczają tej granicy. Maksymalnie 16
obserwatorów nie zmienia decyzji schedulera, a wyjątek obserwatora nie blokuje
przyjęcia ani zwolnienia miejsca. Serie korzystają ze wspólnego budżetu
diagnostyki gatewaya; metryki governora workera należą do etapu 3.

Tworzenie i rename również omijają cache: agent może równolegle zmienić gałąź
lub upstream poza Canopy.

`tests/integration/process-governor.test.ts` sprawdza 100 statusów na 30
prawdziwych linked worktree: szczyt ≤4 procesy, 30 procesów zamiast 100,
single-flight i cache, ominięcie cache przy końcowej walidacji, priorytet
działań użytkownika przed backlogiem, odrzucenie przeterminowanego zadania
oraz timeout zabijający proces potomny. Zabijanie drzewa procesów na Windows
(`taskkill`) i macOS nie ma jeszcze testów na tych platformach.
