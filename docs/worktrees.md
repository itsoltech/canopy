# Worktrees (git)

Status: **etapy 1–3 zaimplementowane** (2026-11-04). Etap 1: ustawienia (Creation, Branches,
domyślny tryb), operacje git na workerze (refy, tworzenie worktree z bazy, start z remote, nazwy gałęzi
z semantycznym prefiksem), pickery w kompozytorze nowego wątku i wyświetlanie worktree wątku. Etap 2:
sprzątanie według polityk, podgląd skutków, status i akcje pojedynczego worktree (pierwotny etap 3),
lista w Settings i poprawiony układ pickerów. Etap 3: automatyzacja przez szynę, boty i harmonogramy
oraz wykrywanie squash/rebase merge. Reszta w [planie etapów](#plan-etapów).

Migracje stosu następują po `0064_worker_enrollment_tags` (#75) i `0065_instance_connections` (#85):
etap 1 używa `0066_worktrees`, etap 2 `0067_worktree_lifecycle`, a etap 3 `0068_worktree_automation`.
Każdy etap ma docelowy numer w pliku SQL, loaderze i oczekiwanej liście testu schematu.

Powiązane: [threads.md](threads.md) (miejsce wątku jest niezmienne), [protocol.md](protocol.md),
[thread-titles.md](thread-titles.md) (generowanie tekstu), [agent-bus.md](agent-bus.md),
[bots.md](bots.md), [linked-computers.md](linked-computers.md) (dom wątku, przeniesienia).

## Cel

Wątek agenta kodującego może pracować w **osobnym git worktree** zamiast w bieżącym checkoutcie
projektu. Kilka wątków pracuje wtedy równolegle na osobnych gałęziach, nie
przełączając sobie nawzajem plików, a checkout użytkownika zostaje nietknięty.

Zasady podziału odpowiedzialności:

- **Worker** wykonuje każdą operację git (ma repozytorium). Dostaje tylko parametry (repo, ref bazowy,
  nazwa gałęzi, folder), nigdy gotowej komendy powłoki.
- **Gateway** trzyma ustawienia (baza, per właściciel, z nadpisaniami per projekt i per komputer) oraz
  rekordy worktree wątków. Rozstrzyga ustawienia i wysyła je w parametrach komend, więc worker offline
  dostaje aktualne ustawienia przy następnej komendzie po połączeniu (nic nie jest kopiowane na worker).
- **Przeglądarka** nigdy nie uruchamia gita; widzi wyniki przez BFF.

## Model danych

### Ustawienia i zakresy

Tabela `worktree_settings` (migracja `0066_worktrees`): jeden wiersz na zakres
`(owner_user_id, project_id | NULL, worker_id | NULL)`, `settings jsonb` z **tylko nadpisanymi polami**
i `version` (optymistyczna współbieżność). `NULL` = „All projects” / „All computers”.

Efektywna wartość pola (od najmniej do najbardziej szczegółowego, ostatni wygrywa):

1. wbudowane domyślne,
2. All projects × All computers,
3. All projects × komputer,
4. projekt × All computers,
5. projekt × komputer.

Projekt wygrywa z komputerem, bo zwykle to repozytorium decyduje o konwencji gałęzi.

| Pole | Domyślnie | Znaczenie |
|---|---|---|
| `location` | pusty | Folder nowych worktree na workerze (absolutny). Pusty = zarządzany korzeń workera (`~/canopy/worktrees`, zob. [Położenie](#położenie)). Zmiana dotyczy tylko nowych worktree; istniejące zostają tam, gdzie są. |
| `start_from_remote` | `false` | Baza z remote: najnowszy commit gałęzi śledzonej przez gałąź bazową (`base@{upstream}`), inaczej gałąź o tej samej nazwie na `remote`, a gdy nie ma żadnej albo fetch zawiedzie: lokalny ref. |
| `remote` (Advanced) | `origin` | Remote używany, gdy gałąź bazowa niczego nie śledzi. |
| `branch_naming` | `SEMANTIC` | `SEMANTIC` (model wybiera `feat/…`, `fix/…`, `refactor/…` z pierwszej wiadomości), `PREFIX` (`<prefix>/<slug>`), `TITLE` (sam slug tytułu). |
| `branch_prefix` | `canopy` | Prefiks trybu `PREFIX` i tymczasowej nazwy w trybie `SEMANTIC`. |
| `default_mode` | `CHECKOUT` | Domyślny tryb nowego wątku w kompozytorze: bieżący checkout albo nowy worktree. |

Pola Cleanup korzystają z tych samych zakresów, dziedziczenia i wersji:

| Pole | Domyślnie | Znaczenie |
|---|---|---|
| `cleanup_deleted_threads` | `false` | Wszystkie wątki współdzielące worktree zostały usunięte. |
| `cleanup_merged` | `false` | HEAD worktree zawarty w domyślnej lub bazowej gałęzi po fetch. |
| `cleanup_inactive_days` | `0` | Liczba dni bez aktywności wątków i lokalnego katalogu; 0 wyłącza, maksimum 3650. |
| `cleanup_settled` | `false` | Wszystkie żywe wątki zarchiwizowane albo idle z ostatnią turą completed. |
| `cleanup_unchanged` | `false` | HEAD równy commitowi utworzenia i brak zmian plików. |
| `keep_local_changes` | `true` | Zmiany lokalne są chronione; wyłączenie wskazuje wymóg ręcznego potwierdzenia, nigdy nie zezwala na automatyczną utratę danych. |
| `delete_local_branch` | `false` | Po usunięciu checkoutu spróbuj usunąć tylko bezpieczną gałąź. |

### Rekord worktree

Tabela `worktrees`: `id`, `owner_user_id`, `project_id`, `workspace_id`, `worker_id`, `repo_root`,
`path`, `branch`, `base_ref`, `base_commit`, `created_at`, `last_used_at`, `removed_at`. Unikalna
ścieżka na workerze wśród nieusuniętych. `threads.worktree_id` (nullable) wskazuje worktree wątku;
`NULL` = bieżący checkout workspace'u.

- Worktree to rzecz współdzielona: wątki boczne, forki i „Previous worktree” wskazują ten sam rekord.
- `cwd` wątku = `worktrees.path`; trigger migracji `0066` sprawdza właściciela, projekt, workspace,
  workera, ścieżkę i dziedziczenie z rodzica. Zarówno `cwd`, jak i `worktree_id` pozostają niezmienne.
- Migracja `0067_worktree_lifecycle` zapisuje pierwotny `location`, rezerwację usunięcia
  (`removal_token`, `removal_started_at`, binarna `removal_command`) i triggery dostępności worktree.
  Zmiana konfiguracji folderu nie blokuje obsługi wcześniej utworzonych worktree.
- Usunięcie ustawia `removed_at`; historia wątku zostaje. Nowy wątek, tura lub cel w usuniętym albo
  zarezerwowanym worktree dostają błąd `worktree_available`, zamiast odtworzenia katalogu.

### Thread w API

`ui.Thread.worktree` (`ThreadWorktree`: `id`, `branch`, `path`, `base_ref`, `repo_root`, `removed_at`,
`detached_commit`), puste dla bieżącego checkoutu; wtedy `ui.Thread.checkout_head` (`GitHead`) niesie bieżącą
gałąź checkoutu workspace'u. `ui.Worker.worktrees` = worker ogłosił capability `worktrees`.

### Bieżąca gałąź

Gałąź wątku to gałąź, na której checkout **jest teraz**, a nie ta z chwili utworzenia. Agent albo użytkownik
może w worktree utworzyć i wybrać inną gałąź (`git switch -c …`); nagłówek, panel, karta hover i aplikacja
mobilna pokazują ją na żywo. „Started from ‹ref›” (`base_ref`) się nie zmienia.

- **Worker** (capability `git_heads`, `apps/worker/src/git/heads.ts`) śledzi każdy katalog git wątków, które
  zna (CreateThread, StartTurn): jedna obserwacja pliku `HEAD` w katalogu git checkoutu
  (`rev-parse --absolute-git-dir`, dla worktree `.git/worktrees/<nazwa>`), odczyt na końcu każdej tury
  (obserwacja niedostępna albo pominięta) i pełny stan po każdym połączeniu z gatewayem. Wysyła tylko zmiany:
  `WorkerMessage.git_heads` (`GitHeads`: wątki checkoutu, gałąź albo skrócony commit odłączonego HEAD).
  Nieudany odczyt (git zajęty) jest ponawiany kilka razy. UnloadThread i zamknięcie zwalniają obserwacje.
- **Gateway** (`apps/gateway/src/worktrees/heads.ts`) przyjmuje zgłoszenie tylko dla wątków tego workera
  i odrzuca nazwę ze znakami sterującymi albo dłuższą niż 255 znaków. Worktree: `worktrees.branch`
  (gałąź) i `worktrees.detached_commit` (migracja `0086_git_heads`; przy odłączonym HEAD `branch` zostaje
  ostatnią gałęzią). Checkout workspace'u: tabela `checkout_heads`, tylko z wątków pracujących w katalogu
  głównym workspace'u (podkatalog może być innym repozytorium). Zmiana rozsyła wszystkie wątki tego worktree
  albo checkoutu przez zwykłe strumienie wątku i overview, więc dociera też do połączonych komputerów (lustro
  i trasy wątków niosą cały `ui.Thread`).
- Status, sprzątanie, Reveal i Remove używają bieżącej gałęzi; przy odłączonym HEAD worker oczekuje
  worktree bez wybranej gałęzi. Starszy worker niczego nie zgłasza: wątek pokazuje gałąź z utworzenia.
  `WORKER_LINK_PROTOCOL` bez zmian (pole addytywne; starszy gateway ignoruje nieznaną wiadomość).

## Protokół workera

Capability `worktrees` w `Hello.capabilities` i `Hello.worktrees_root` (zarządzany korzeń nowych worktree,
zob. [Położenie](#położenie)). Gateway zapisuje go w `capabilities` workera i oddaje w `ui.Worker.worktrees_root`.
Starszy worker jej nie ma: gateway nie wysyła mu komend git, kompozytor nie pokazuje wyboru worktree,
a `CreateThread` z worktree dostaje czytelny błąd. `WORKER_LINK_PROTOCOL` bez zmian (zmiany addytywne).

Nietrwałe komendy (wysyłane bezpośrednio, nigdy z outboxa, worker ich nie zapamiętuje):

| Komenda | Efekt | Wynik |
|---|---|---|
| `ListGitRefs` (210) | `repo_path` → korzeń repo, bieżąca gałąź, domyślna gałąź (`<remote>/HEAD`, inaczej `main`/`master`), lokalne i zdalne gałęzie (`for-each-ref`, od najnowszego commitu, do 500), czy checkout ma zmiany | `CommandResult.git_refs` |
| `CreateWorktree` (211) | `git worktree add --no-track -b <branch> <path> <start>`; start z remote po `git fetch` (limit 20 s) według ustawień | `CommandResult.worktree` (ścieżka, gałąź, baza, commit) |
| `RenameWorktreeBranch` (212) | `git branch -m` gałęzi worktree pod korzeniem, tylko gdy nadal jest wybrana w tym worktree i nie ma upstreamu | `CommandResult.worktree` |

Ścieżka nie przychodzi z gatewaya. Worker liczy ją sam: `<root>/<nazwa repo>/<losowa nazwa>`, gdzie
`<root>` = `location` z ustawień albo zarządzany korzeń, a losowa nazwa to 6 znaków z małych liter i cyfr
bez `i`, `l`, `o`, `u` (np. `~/canopy/worktrees/wrk-ai/k3f9x2`, około 10⁹ wartości). Nazwa nie zależy od
gałęzi ani od wiadomości: jest krótka, nie zdradza treści zadania i zostaje taka sama po zmianie gałęzi.
Worker losuje ponownie (do 50 razy), gdy nazwa jest zajęta na dysku, jest zarejestrowanym worktree (także
takim, którego folder zniknął bez `git worktree prune`) albo nazwą rekordu w `.git/worktrees`; ścieżka nie
jest więc ponownie użyta, dopóki git albo dysk ją pamięta. Zajęta gałąź dostaje przyrostek `-2`, `-3`, …
Nazwa gałęzi przechodzi `git check-ref-format --branch`.

Worktree utworzone wcześniej zachowują swoje ścieżki z nazwą gałęzi (`wt-fix-the-login-bug`); nic nie jest
przenoszone, a rekordy, status, sprzątanie i usuwanie działają po zapisanej ścieżce. Ustawienie `location`
i zarządzany korzeń działają bez zmian. Git działa bez
promptów (`GIT_TERMINAL_PROMPT=0`, puste `GIT_ASKPASS`), z limitem czasu, argumentami (nie powłoką)
i `--` przed ścieżkami.

Capability `worktree_lifecycle` dodaje nietrwałe `ScanWorktrees` (213) i `RevealWorktree` (215)
oraz trwałe `RemoveWorktree` (214). Starszy worker z samym `worktrees` nadal tworzy worktree,
ale do ich zarządzania UI prosi o aktualizację. Skan zwraca gałąź, ahead/behind (upstream albo baza),
liczbę zmienionych plików (również untracked/ignored), niewypchnięte commity, stan merged/unchanged,
HEAD i czas lokalnej aktywności. Błąd skanu blokuje usunięcie.

### Położenie

Worker ustala zarządzany korzeń raz przy starcie (`resolveWorktreeRoots` w
`apps/worker/src/git/worktree-roots.ts`), w tej kolejności:

1. `CANOPY_WORKTREES_ROOT`: absolutny folder ze środowiska workera, dla workerów w kontenerach i na
   serwerach, gdzie katalog domowy nie jest trwały albo nie jest właściwym miejscem. Względna ścieżka albo
   folder, którego nie da się utworzyć lub zapisać, kończy start kodem 78 (`EX_CONFIG`). Obraz Docker workera
   ustawia `/home/canopy/.local/share/canopy/worktrees`, czyli dotychczasowy folder w wolumenie danych.
2. `~/canopy/worktrees` w katalogu domowym użytkownika workera: macOS `/Users/<user>/canopy/worktrees`,
   Linux `/home/<user>/canopy/worktrees`, Windows `C:\Users\<user>\canopy\worktrees`. Katalog domowy pochodzi
   z `HOME` (Windows: `USERPROFILE`), a bez nich z `os.homedir()`.
3. `<data_dir>/worktrees`, gdy katalogu domowego nie ma albo nie da się w nim utworzyć i zapisać folderu.
   Worker zapisuje wtedy jedno ostrzeżenie w logu (bez sekretów).

Korzeń powstaje z trybem `0700` (tam, gdzie system go obsługuje) i jest brany jako rzeczywista ścieżka.
Ustawienie `location` wygrywa z każdym z nich dla nowych worktree. Każdy worker (lokalny, zdalny, komputer
połączony) ustala swój katalog domowy sam; gateway zna tylko zgłoszony `Hello.worktrees_root`.

**Dotychczasowy korzeń.** Do 2026-11 nowe worktree trafiały do `<data_dir>/worktrees` (na desktopie
`~/Library/Application Support/Canopy/local-worker/data/worktrees`). Nic nie jest przenoszone automatycznie:
istniejące worktree zostają w starym folderze. Gdy `<data_dir>/worktrees` istnieje, worker traktuje go jako
drugi zarządzany korzeń. Skan statusu, lista w Settings, polityki sprzątania, Remove, Reveal i zmiana nazwy
gałęzi akceptują worktree bez `location` pod dowolnym z zarządzanych korzeni, więc żaden stary worktree nie
staje się niezarządzany ani nieusuwalny. Worktree ze skonfigurowanym `location` nadal sprawdza tylko ten folder.

`RemoveWorktree` ponownie sprawdza status, oczekiwany HEAD, warunki polityki i aktywność wątków.
`--force` występuje wyłącznie przy ręcznie potwierdzonym odrzuceniu zmian. Worker zapisuje dokładny
zamiar usunięcia przed operacją git, a wynik w journalu komend; ponowienie po zerwanym połączeniu
lub awarii między usunięciem a zapisem wyniku nie usuwa innej ścieżki ani nie powiela audytu.
Reveal otwiera folder menedżerem plików na komputerze workera (`open -R`, `explorer.exe`, `xdg-open`);
bez menedżera zwraca komunikat z zaleceniem skopiowania ścieżki.

## Nazwy gałęzi

- `PREFIX`: `<prefix>/<slug pierwszej linii wiadomości>` (slug: małe litery ASCII, cyfry i `-`, do 48
  znaków); bez wiadomości `<prefix>/<8 znaków id wątku>`.
- `TITLE`: slug tytułu przy utworzeniu (jawny tytuł albo tymczasowy z pierwszej linii).
- `SEMANTIC`: worktree powstaje od razu z nazwą `PREFIX`, a gateway asynchronicznie prosi model
  (`GenerateText`, ten sam wybór instancji i modelu co tytuły, [thread-titles.md](thread-titles.md))
  o `<typ>/<slug>` z typem z listy `feat|fix|refactor|perf|docs|test|chore|build|ci|style`. Wynik spoza
  formatu, błąd albo timeout zostawia nazwę tymczasową. Zmiana nazwy (`RenameWorktreeBranch`) nie
  następuje, gdy gałąź ma już upstream (agent zdążył ją wypchnąć) albo nie jest już wybrana w worktree.
  Tworzenie wątku nie czeka na model.

  Generowanie semantycznej nazwy przechodzi wyłącznie przez oficjalny harness workera, także
  dla Groka native i proxy (izolowana sesja CLI przez ACP, bez narzędzi i kontekstu repozytorium).
  CLIProxyAPI może być konfiguracją harnessu; gateway ani worker nie wywołuje bezpośrednio API modelu.

## Przepływy UI

### Settings → Worktrees (sekcja Code)

Nagłówek: „Applying settings for **[All projects | projekt]** across **[All computers | komputer]**”
(dwa własne pickery z kitu). Grupy:

- **Creation:** Worktree location (pole tekstowe, pusty = zarządzany przez Canopy, opis, że istniejące
  zostają; w zakresie komputera placeholder i podpowiedź dziedziczenia pokazują zgłoszony
  `worktrees_root` tego workera, w szerszych zakresach „Managed by Canopy”), Start from remote (przełącznik), Advanced (zwijane): Remote.
- **Branches:** Branch naming (Semantic prefix / Prefix / Thread title), Branch prefix.
- **New threads:** Default workspace (Current checkout / New worktree).
- **Cleanup:** powyższe polityki i ochrona zmian lokalnych.
- **Worktrees:** lista bieżących worktree w wybranym zakresie, status, „Open in…” (Copy path / Reveal
  on computer), Remove, Refresh, „Preview cleanup” i „Run cleanup”. Preview pokazuje
  „Will remove N worktrees” oraz przyczynę pozostawienia pozostałych.

Każde pole pokazuje wartość efektywną; nadpisane w bieżącym zakresie ma „Reset” (wraca do wartości
odziedziczonej, opisanej skąd pochodzi). Zapis od razu, z wersją; konflikt przeładowuje.

### Kompozytor nowego wątku

Pod polem wiadomości, obok pickera maszyny: **workspace picker** (pill z ikoną gałęzi):

- grupa **Workspace:** Current checkout, New worktree,
- grupa **Previous worktrees:** ostatnie worktree tego projektu na tej maszynie (gałąź, wiek).

Obok **ref picker** („Search refs…”): gałąź domyślna oznaczona „default”, bieżąca „current”.

- **New worktree:** ref to baza nowej gałęzi (domyślnie gałąź domyślna).
- **Current checkout:** tylko podgląd bieżącej gałęzi, bez przełączania. Przełączanie gałęzi checkoutu
  z kompozytora jest celowo niedostępne: inne wątki mogą pracować w tym katalogu, a `git switch`
  zmieniłby im pliki w trakcie tury.
- **Previous worktree:** gałąź worktree, tylko podgląd.

Picker pokazuje się tylko dla workera online z capability `worktrees` i workspace'u w repo git. Domyślny
tryb pochodzi z efektywnych ustawień (projekt × komputer).

### Wątek

Nagłówek wątku: chip z bieżącą gałęzią albo „Detached at ‹commit›” (tooltip: ścieżka worktree); chip i akcja w panelu szczegółów
otwierają wspólny dialog statusu i zarządzania. Karta pokazuje ahead/behind, zmienione pliki,
niewypchnięte commity, ostatnią aktywność i akcje jak w Settings. Po usunięciu pozostaje informacja
o usuniętym worktree i historia wątku. Offline akcje workera są wyłączone z przyczyną;
ścieżkę nadal można skopiować. Karta hover w sidebarze pokazuje gałąź. Wątek w bieżącym checkoutcie ma
w panelu wiersz z gałęzią checkoutu i dopiskiem „Current checkout”. W aplikacji mobilnej szczegóły wątku
pokazują wiersz „Branch · Worktree from ‹ref›” albo „Branch · Current checkout”.

## Interakcje

- **Tury w toku:** worktree nigdy nie jest usuwany, gdy którykolwiek wątek go używający ma turę,
  zadanie w tle albo oczekującą interakcję (sprawdzane w gatewayu i ponownie na workerze).
  Gateway chroni też tworzenie wątku, aktywny cel i oczekujące komendy startowe.
- **Szyna agentów (`spawn_thread`) i wątki boczne:** domyślnie dziedziczą katalog i rekord worktree
  rodzica, niezależnie od domyślnego trybu zakresu. `workspace_mode = inherit_parent` robi to jawnie;
  `checkout` wybiera checkout workspace'u, `new_worktree` tworzy izolowaną gałąź (`base_ref` opcjonalny),
  `default` rozstrzyga domyślny tryb projektu × workera. Migracja `0068` pozwala dziecku wybrać
  inne miejsce tylko w tym samym projekcie, workspace i na tym samym workerze. Właściciel, drzewo,
  limity, routing interakcji i uprawnienia nadal są dziedziczone i egzekwowane w gatewayu/bazie.
- **Fork („Fork from here”):** nowy wątek główny w tym samym worktree co źródło.
- **Boty i harmonogramy:** `start_thread.workspace_mode` i `NewThreadSchedule.workspace_mode`
  obsługują domyślny tryb zakresu, checkout, nowy worktree oraz dziedziczenie. Bot/harmonogram
  nie ma własnego katalogu: `inherit_parent` wymaga `parent_thread_id` istniejącego wątku tego samego
  właściciela, projektu i workspace'u; harmonogram wymaga też placement `specific`. Powstaje wątek
  główny dziedziczący tylko miejsce, bez historii dostawcy. `base_ref` wybiera bazę nowego worktree.
  Ustawienia rozstrzygają się przy wykonaniu zadania. Nowy worktree wymaga workera online; offline
  harmonogram zachowuje termin i ponawia po powrocie workera, bez zwiększania liczby wykonań.
  Wakeup istniejącego wątku zachowuje jego niezmienne miejsce. Opcje są dostępne w narzędziach i API;
  ten etap nie dodaje kontrolek w interfejsie harmonogramów ani testów UI.
- **Połączone komputery:** etap 1 odmawia tworzenia i wyboru worktree przez połączenie komputerów
  z czytelnym komunikatem: otwórz Canopy na komputerze, na którym jest workspace. Kompozytor
  oferuje tam bieżący checkout; ustawienia worktree dotyczą lokalnych projektów i workerów.
  Gateway odrzuca zdalne żądanie worktree przed wysłaniem, aby starszy dom nie zignorował nowych pól
  i nie utworzył wątku w checkoutcie. Obsługa zdalna wymaga negocjowania capability gatewaya.
  Docelowo worktree żyje na domu wątku i jest tworzone według **jego** ustawień.
  Przeniesienie wątku (etap 8 linked computers): cel tworzy nowy worktree, jeśli gałąź jest wypchnięta
  (baza = gałąź na remote, ta sama nazwa), inaczej kontynuacja z notatką przekazania w checkoutcie
  projektu na celu (etap 5 tego planu).
- **Archiwizacja i usunięcie wątku:** usunięcie wątku może usunąć jego
  worktree (ustawienie), archiwizacja liczy się jako „settled”.

## Sprzątanie (etap 2)

- Silnik działa w **gatewayu** przy starcie, co 1 h i przy połączeniu workera. Rozstrzyga ustawienia
  właściciela × projektu × komputera, pyta właściciela katalogu przez `ScanWorktrees` po fetch,
  stosuje alternatywne reguły i wysyła `RemoveWorktree`. Inaktywność uwzględnia aktywność wszystkich
  współdzielących wątków, plików, indeksu i refloga worktree.
- Nigdy automatycznie nie usuwa niezatwierdzonych plików ani niewypchniętych commitów, także po
  wyłączeniu „Keep worktrees with local changes”. Ręczne Remove pokazuje ostrzeżenie i wymaga
  jawnego potwierdzenia odrzucenia plików. Gałąź z lokalnymi zmianami lub niewypchniętymi commitami
  zawsze zostaje. Czysty worktree bez własnych commitów może być usunięty, choć nie miał upstreamu.
- „Merged”: po udanym fetch do gałęzi domyślnej lub bazowej: przodek (`merge-base --is-ancestor`),
  wszystkie commity patch-equivalent (`git cherry`, bez pomijania własnych merge commitów) albo cały
  diff merge-base → HEAD zawarty w bazie. Ostatni wariant sprawdza odwrócenie patcha w osobnym indeksie,
  bez zmiany checkoutu i indeksu użytkownika; obsługuje wielocommitowy squash. Częściowo scalona gałąź
  zostaje. GitHub: gateway odczytuje zamknięte PR-y przez konto właściciela z grantem workera i uznaje
  tylko PR z `merged = true`, tym samym repo, gałęzią i dokładnym HEAD. Worker dostaje wyłącznie
  owner/repo i potwierdzony SHA, ponownie sprawdza je przed usunięciem; żadnych poświadczeń.
  Błąd konektora zostawia niezależny wynik gita; błąd fetch blokuje usunięcie. Commity potwierdzone
  jako scalone nie są traktowane jako niewypchnięta praca. `branch -d` nadal może zachować gałąź po squashu.
- Raport **dry-run** w Settings → Worktrees → Cleanup: lista „would remove / kept because …” przed
  włączeniem reguł i przycisk „Run cleanup now”.
- Gateway rezerwuje rekord w transakcji z blokadami wątków i worktree, a triggery blokują wyścig
  z nową turą/wątkiem/celem. Worker niezależnie sprawdza własny journal i blokuje nowe starty pod usuwaną
  ścieżką. Główny checkout, ścieżka poza pierwotnym korzeniem, dowiązanie poza korzeń, inna gałąź,
  brak rejestracji git albo zablokowane worktree są odrzucane.
- Historia zostaje zawsze. Opcjonalne usunięcie gałęzi wymaga czystego drzewa, braku niewypchniętych
  commitów i merged/unchanged; dodatkowo git `branch -d` sprawdza bezpieczeństwo. Błąd usunięcia
  gałęzi zachowuje ją i nie unieważnia usunięcia checkoutu.
- Offline: kandydaci czekają do połączenia workera. Rozpoczęte usunięcie zachowuje ten sam identyfikator
  komendy w bazie i wraca po reconnect/restarcie. `removed_at` i audit `worktree.removed` zapisują się
  atomowo i tylko raz. Jawny błąd workera zwalnia rezerwację; timeout/rozłączenie zostawia ją do ponowienia.

## Bezpieczeństwo

- **Konfinacja ścieżek:** worker sam liczy ścieżkę pod zarządzanym korzeniem albo skonfigurowanym
  absolutnym folderem i sprawdza ją po `realpath`; gateway sprawdza ponownie, że zwrócona ścieżka jest pod
  tym korzeniem, zanim zapisze rekord. Zmiana nazwy i usuwanie działają tylko pod korzeniami.
  Folder repozytorium pod korzeniem nie może być dowiązaniem poza korzeń. Sam skonfigurowany korzeń
  może być dowiązaniem; worker sprawdza jego rzeczywistą ścieżkę, a zwraca zapis z ustawień.
- **Bez dowolnych komend:** UI wybiera tylko tryb, ref, istniejący rekord (id) i ustawienia. Ref
  i gałąź przechodzą przez `check-ref-format`/`rev-parse --verify`, git dostaje argumenty, nigdy powłokę.
- **Owner scoping:** ustawienia, rekordy worktree, workspace i worker są filtrowane po właścicielu; id
  worktree innego właściciela albo innego projektu/workspace'u jest odrzucane.
- Sekrety: brak; fetch używa poświadczeń git urządzenia, a błędy są skracane (bez URL-i z tokenami).

## Plan etapów

Każdy etap to osobny PR w stosie (`feat/worktrees-N`), kompletny i działający sam.

1. **Rdzeń — gotowy, draft PR #74 (`feat/worktrees-1`):** ustawienia Creation/Branches/domyślny tryb z zakresami, `ListGitRefs`,
   `CreateWorktree`, `RenameWorktreeBranch`, nazwy gałęzi (w tym semantyczne), pickery w kompozytorze,
   worktree wątku w nagłówku, panelu i karcie hover; testy integracyjne z prawdziwym repo.
2. **Sprzątanie i zarządzanie — gotowe, draft PR #82 (`feat/worktrees-2`, baza `feat/worktrees-1`):** pola Cleanup,
   `ScanWorktrees`/`RemoveWorktree`/reveal, silnik w gatewayu, raport dry-run, audyt i trwałe ponawianie,
   ochrona tur i zmian, lista w Settings, status i akcje wątku, poprawiony układ kompozytora.
3. **Szyna i automaty — gotowe (`feat/worktrees-3`, baza `feat/worktrees-2`):** własny worktree,
   checkout albo dziedziczenie dla `spawn_thread`, botów i harmonogramów; domyślne ustawienia zakresu,
   wykrywanie squash/rebase merge i potwierdzenie PR przez konektor GitHub. Oryginalny etap 3
   (status wątku) wszedł do etapu 2, a oryginalny etap 4 jest dostarczany tutaj jako etap implementacji 3.
5. **Połączone komputery i przeniesienia:** negocjowanie obsługi worktree na domu wątku, zdalne
   refy i tworzenie/użycie worktree; worktree na celu z wypchniętej gałęzi przy „Move to…”, inaczej notatka
   przekazania.

Stos etapów 1–2: draft PR-y #74 i #82, stack #83. Numer 5 zachowuje oznaczenie z pierwotnego planu.
Kontrolki opcji automatyzacji w UI mogą zostać dodane osobno; edytor harmonogramu zachowuje pola ustawione przez API.

## Weryfikacja (etap 1)

- `tests/integration/worktrees.test.ts`: gateway + PostgreSQL + prawdziwy `WorkerHost` i repo
  tymczasowe (bare origin + klon): refy, worktree z lokalnej i zdalnej bazy, nazwy gałęzi (w tym
  semantyczny prefiks przez zaślepkę `GenerateText`), konfinacja ścieżek, owner scoping, ustawienia
  w czterech zakresach ze źródłem dziedziczenia i konfliktem wersji, wątki boczne, ponowne użycie,
  wzmianki plików pierwszej wiadomości rozstrzygane względem nowego, użytego ponownie i odziedziczonego worktree,
  odmowa operacji zdalnych i starszy worker bez capability. Start z remote obejmuje inny upstream,
  gałąź origin o tej samej nazwie i fallback po błędzie fetch. Test schematu sprawdza też niezmienność
  i spójność przypięcia worktree.

## Weryfikacja (etap 2)

- `tests/integration/worktree-lifecycle.test.ts`: prawdziwy gateway ↔ worker przez gRPC, PostgreSQL
  i repo git; każda polityka, współdzielenie worktree, preview/execute, jawne potwierdzenie zmian
  i niewypchniętych commitów, zachowanie/usuwanie gałęzi, offline/reconnect, utracone potwierdzenie,
  pojedynczy audyt, aktywne tury/interakcje/zadania, rezerwacja kontra nowa tura, pierwotny folder,
  błąd fetch, owner scoping i konfinacja ścieżek. Lista migracji zawiera `0067`.

## Weryfikacja (bieżąca gałąź)

- `tests/integration/git-heads.test.ts`: gRPC gateway ↔ prawdziwy WorkerHost i git; gałąź utworzona przez
  agenta w worktree na żywo w strumieniu wątku, baza bez zmian, status po zmianie gałęzi, odłączony HEAD,
  gałąź checkoutu workspace'u, nadrobienie zmiany po ponownym połączeniu oraz odrzucenie zgłoszeń dla wątków
  innego workera i niepoprawnych nazw.

## Weryfikacja (nazwy folderów)

- `apps/worker/src/git/worktrees.test.ts`: prawdziwy git; losowe nazwy, pominięcie zajętego pliku,
  zarejestrowanego worktree bez folderu i nazwy rekordu git oraz błąd `PATH_EXISTS`, gdy wszystko zajęte.
- `tests/integration/worktrees.test.ts`: nowe worktree pod korzeniem i skonfigurowanym `location` mają losowe,
  różne foldery przy tej samej gałęzi.

## Weryfikacja (etap 3)

- `worktree-automation.test.ts`: gRPC gateway ↔ rzeczywisty WorkerHost, PostgreSQL i git; dziedziczenie
  dziecka, jawny checkout/nowy worktree/domniemanie zakresu, replay wywołania, boty, harmonogramy,
  zmiana ustawień przed wykonaniem, offline/reconnect, sprzątanie i odrzucenie cudzego projektu.
- `worktree-merged.test.ts`: wielocommitowy squash, rebase/cherry-pick i częściowe scalenie;
  status i bezpieczne sprzątanie po fetch.
- `worktree-github.test.ts`: prawdziwy transport MCP do zaślepki GitHub, grant workera i właściciel,
  closed bez merged, nieaktualny SHA i usunięcie po potwierdzeniu PR bez sekretów na workerze.
- Migracja `0068` aktualizuje triggery miejsca wątku; test schematu sprawdza listę i idempotencję migracji.
