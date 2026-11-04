# Worktrees (git)

Status: **projekt + etap 1 zaimplementowany** (2026-11-04). Etap 1: ustawienia (Creation, Branches,
domyślny tryb), operacje git na workerze (refy, tworzenie worktree z bazy, start z remote, nazwy gałęzi
z semantycznym prefiksem), pickery w kompozytorze nowego wątku i wyświetlanie worktree wątku. Sprzątanie
(cleanup) to etap 2, reszta w [planie etapów](#plan-etapów).

Powiązane: [threads.md](threads.md) (miejsce wątku jest niezmienne), [protocol.md](protocol.md),
[thread-titles.md](thread-titles.md) (generowanie tekstu), [agent-bus.md](agent-bus.md),
[bots.md](bots.md), [linked-computers.md](linked-computers.md) (dom wątku, przeniesienia).

## Cel

Wątek agenta kodującego może pracować w **osobnym git worktree** zamiast w bieżącym checkoutcie
projektu, tak jak w T3 Code. Kilka wątków pracuje wtedy równolegle na osobnych gałęziach, nie
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
| `location` | pusty | Folder nowych worktree na workerze (absolutny). Pusty = zarządzany przez Canopy `<data_dir>/worktrees`. Zmiana dotyczy tylko nowych worktree; istniejące zostają tam, gdzie są. |
| `start_from_remote` | `false` | Baza z remote: najnowszy commit gałęzi śledzonej przez gałąź bazową (`base@{upstream}`), inaczej gałąź o tej samej nazwie na `remote`, a gdy nie ma żadnej albo fetch zawiedzie: lokalny ref. |
| `remote` (Advanced) | `origin` | Remote używany, gdy gałąź bazowa niczego nie śledzi. |
| `branch_naming` | `SEMANTIC` | `SEMANTIC` (model wybiera `feat/…`, `fix/…`, `refactor/…` z pierwszej wiadomości), `PREFIX` (`<prefix>/<slug>`), `TITLE` (sam slug tytułu). |
| `branch_prefix` | `canopy` | Prefiks trybu `PREFIX` i tymczasowej nazwy w trybie `SEMANTIC`. |
| `default_mode` | `CHECKOUT` | Domyślny tryb nowego wątku w kompozytorze: bieżący checkout albo nowy worktree. |

Pola sprzątania (etap 2) dochodzą jako kolejne klucze `settings` i pola proto, bez nowej migracji
zakresów.

### Rekord worktree

Tabela `worktrees`: `id`, `owner_user_id`, `project_id`, `workspace_id`, `worker_id`, `repo_root`,
`path`, `branch`, `base_ref`, `base_commit`, `created_at`, `last_used_at`, `removed_at`. Unikalna
ścieżka na workerze wśród nieusuniętych. `threads.worktree_id` (nullable) wskazuje worktree wątku;
`NULL` = bieżący checkout workspace'u.

- Worktree to rzecz współdzielona: wątki boczne, forki i „Previous worktree” wskazują ten sam rekord.
- `cwd` wątku = `worktrees.path`; trigger migracji `0066` sprawdza właściciela, projekt, workspace,
  workera, ścieżkę i dziedziczenie z rodzica. Zarówno `cwd`, jak i `worktree_id` pozostają niezmienne.
- Usunięcie worktree (etap 2) ustawia `removed_at`; gałąź i historia wątku zostają.

### Thread w API

`ui.Thread.worktree` (`ThreadWorktree`: `id`, `branch`, `path`, `base_ref`, `repo_root`), puste dla
bieżącego checkoutu. `ui.Worker.worktrees` = worker ogłosił capability `worktrees`.

## Protokół workera

Capability `worktrees` w `Hello.capabilities` i `Hello.worktrees_root` (`<data_dir>/worktrees`).
Starszy worker jej nie ma: gateway nie wysyła mu komend git, kompozytor nie pokazuje wyboru worktree,
a `CreateThread` z worktree dostaje czytelny błąd. `WORKER_LINK_PROTOCOL` bez zmian (zmiany addytywne).

Nietrwałe komendy (wysyłane bezpośrednio, nigdy z outboxa, worker ich nie zapamiętuje):

| Komenda | Efekt | Wynik |
|---|---|---|
| `ListGitRefs` (210) | `repo_path` → korzeń repo, bieżąca gałąź, domyślna gałąź (`<remote>/HEAD`, inaczej `main`/`master`), lokalne i zdalne gałęzie (`for-each-ref`, od najnowszego commitu, do 500), czy checkout ma zmiany | `CommandResult.git_refs` |
| `CreateWorktree` (211) | `git worktree add --no-track -b <branch> <path> <start>`; start z remote po `git fetch` (limit 20 s) według ustawień | `CommandResult.worktree` (ścieżka, gałąź, baza, commit) |
| `RenameWorktreeBranch` (212) | `git branch -m` gałęzi worktree pod korzeniem, tylko gdy nadal jest wybrana w tym worktree i nie ma upstreamu | `CommandResult.worktree` |

Ścieżka nie przychodzi z gatewaya. Worker liczy ją sam: `<root>/<nazwa repo>/<gałąź z / → ->`, gdzie
`<root>` = `location` z ustawień albo `<data_dir>/worktrees`; zajęta ścieżka albo gałąź dostaje
przyrostek `-2`, `-3`, … Nazwa gałęzi przechodzi `git check-ref-format --branch`. Git działa bez
promptów (`GIT_TERMINAL_PROMPT=0`, puste `GIT_ASKPASS`), z limitem czasu, argumentami (nie powłoką)
i `--` przed ścieżkami.

Etap 2 dodaje `ScanWorktrees` (status: niezatwierdzone zmiany, niewypchnięte commity, czy zawarty
w gałęzi domyślnej, ostatnia aktywność) i `RemoveWorktree` (`git worktree remove` bez `--force`,
ponowne sprawdzenie warunków na workerze tuż przed usunięciem).

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

## Przepływy UI

### Settings → Worktrees (sekcja Code)

Nagłówek: „Applying settings for **[All projects | projekt]** across **[All computers | komputer]**”
(dwa własne pickery z kitu). Grupy:

- **Creation:** Worktree location (pole tekstowe, pusty = zarządzany przez Canopy, opis, że istniejące
  zostają), Start from remote (przełącznik), Advanced (zwijane): Remote.
- **Branches:** Branch naming (Semantic prefix / Prefix / Thread title), Branch prefix.
- **New threads:** Default workspace (Current checkout / New worktree).
- Etap 2: **Cleanup** z raportem dry-run.

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

Nagłówek wątku: chip z gałęzią (tooltip: ścieżka worktree); panel szczegółów: wiersze „Branch”,
„Worktree”, „Based on”; karta hover w sidebarze: gałąź.

## Interakcje

- **Tury w toku:** worktree nigdy nie jest usuwany, gdy którykolwiek wątek go używający ma turę,
  zadanie w tle albo oczekującą interakcję (etap 2, sprawdzane w gatewayu i ponownie na workerze).
- **Szyna agentów (`spawn_thread`) i wątki boczne:** dziedziczą katalog i rekord worktree rodzica
  (trigger `threads_before_insert` wymaga tego samego `cwd`). Osobny worktree dla dziecka to etap 4
  (wymaga zmiany reguły miejsca wątku bocznego); domyślnie dzieci pracują w worktree rodzica.
- **Fork („Fork from here”):** nowy wątek główny w tym samym worktree co źródło.
- **Boty i harmonogramy:** w etapie 1 tworzą wątki w bieżącym checkoutcie (jak dotąd). Etap 4: opcja
  „New worktree” w konfiguracji bota/harmonogramu z efektywnymi ustawieniami.
- **Połączone komputery:** etap 1 odmawia tworzenia i wyboru worktree przez połączenie komputerów
  z czytelnym komunikatem: otwórz Canopy na komputerze, na którym jest workspace. Kompozytor
  oferuje tam bieżący checkout; ustawienia worktree dotyczą lokalnych projektów i workerów.
  Gateway odrzuca zdalne żądanie worktree przed wysłaniem, aby starszy dom nie zignorował nowych pól
  i nie utworzył wątku w checkoutcie. Obsługa zdalna wymaga negocjowania capability gatewaya.
  Docelowo worktree żyje na domu wątku i jest tworzone według **jego** ustawień.
  Przeniesienie wątku (etap 8 linked computers): cel tworzy nowy worktree, jeśli gałąź jest wypchnięta
  (baza = gałąź na remote, ta sama nazwa), inaczej kontynuacja z notatką przekazania w checkoutcie
  projektu na celu (etap 5 tego planu).
- **Archiwizacja i usunięcie wątku:** etap 1 nic nie usuwa. Etap 2: usunięcie wątku może usunąć jego
  worktree (ustawienie), archiwizacja liczy się jako „settled”.

## Sprzątanie (etap 2)

- Silnik działa w **gatewayu** (pętla co 1 h + przy połączeniu workera): wybiera kandydatów z bazy
  (usunięte wątki, nieaktywne > N dni, „settled” N dni), pyta worker `ScanWorktrees` o stan, stosuje
  reguły i wysyła `RemoveWorktree`.
- Bezpieczeństwo: nigdy z turą/zadaniem/interakcją w toku; „Keep worktrees with local changes”
  (niezatwierdzone zmiany, niewypchnięte commity, gałąź nigdy niewypchnięta) chroni zawsze, gdy
  włączone; worker sprawdza warunki jeszcze raz tuż przed `git worktree remove` (bez `--force`);
  usuwa tylko ścieżki pod korzeniem zarządzanym albo skonfigurowanym folderem i zarejestrowane
  w `git worktree list`.
- „Merged”: PR scalony (gdy connector GitHub da się zapytać) albo commity zawarte w gałęzi domyślnej.
- Raport **dry-run** w Settings → Worktrees → Cleanup: lista „would remove / kept because …” przed
  włączeniem reguł i przycisk „Run cleanup now”.
- Gałęzie i historia wątków zostają zawsze. Offline: kandydaci czekają do połączenia workera.

## Bezpieczeństwo

- **Konfinacja ścieżek:** worker sam liczy ścieżkę pod `<data_dir>/worktrees` albo skonfigurowanym
  absolutnym folderem i sprawdza ją po `realpath`; gateway sprawdza ponownie, że zwrócona ścieżka jest pod
  tym korzeniem, zanim zapisze rekord. Zmiana nazwy i (etap 2) usuwanie działają tylko pod korzeniami.
  Folder repozytorium pod korzeniem nie może być dowiązaniem poza korzeń. Sam skonfigurowany korzeń
  może być dowiązaniem; worker sprawdza jego rzeczywistą ścieżkę, a zwraca zapis z ustawień.
- **Bez dowolnych komend:** UI wybiera tylko tryb, ref, istniejący rekord (id) i ustawienia. Ref
  i gałąź przechodzą przez `check-ref-format`/`rev-parse --verify`, git dostaje argumenty, nigdy powłokę.
- **Owner scoping:** ustawienia, rekordy worktree, workspace i worker są filtrowane po właścicielu; id
  worktree innego właściciela albo innego projektu/workspace'u jest odrzucane.
- Sekrety: brak; fetch używa poświadczeń git urządzenia, a błędy są skracane (bez URL-i z tokenami).

## Plan etapów

Każdy etap to osobny PR w stosie (`feat/worktrees-N`), kompletny i działający sam.

1. **Rdzeń** (ten PR): ustawienia Creation/Branches/domyślny tryb z zakresami, `ListGitRefs`,
   `CreateWorktree`, `RenameWorktreeBranch`, nazwy gałęzi (w tym semantyczne), pickery w kompozytorze,
   worktree wątku w nagłówku, panelu i karcie hover; testy integracyjne z prawdziwym repo.
2. **Sprzątanie:** pola Cleanup, `ScanWorktrees`/`RemoveWorktree`, silnik w gatewayu, raport dry-run,
   usuwanie z wątkiem, ochrona tur i zmian.
3. **Status worktree w wątku:** zmiany/ahead/behind w panelu, „Open in …”, ręczne „Remove worktree”.
4. **Szyna i automaty:** opcja własnego worktree dla `spawn_thread`, botów i harmonogramów.
5. **Połączone komputery i przeniesienia:** negocjowanie obsługi worktree na domu wątku, zdalne
   refy i tworzenie/użycie worktree; worktree na celu z wypchniętej gałęzi przy „Move to…”, inaczej notatka
   przekazania.

## Weryfikacja (etap 1)

- `tests/integration/worktrees.test.ts`: gateway + PostgreSQL + prawdziwy `WorkerHost` i repo
  tymczasowe (bare origin + klon): refy, worktree z lokalnej i zdalnej bazy, nazwy gałęzi (w tym
  semantyczny prefiks przez zaślepkę `GenerateText`), konfinacja ścieżek, owner scoping, ustawienia
  w czterech zakresach ze źródłem dziedziczenia i konfliktem wersji, wątki boczne, ponowne użycie,
  wzmianki plików pierwszej wiadomości rozstrzygane względem nowego, użytego ponownie i odziedziczonego worktree,
  odmowa operacji zdalnych i starszy worker bez capability. Start z remote obejmuje inny upstream,
  gałąź origin o tej samej nazwie i fallback po błędzie fetch. Test schematu sprawdza też niezmienność
  i spójność przypięcia worktree.
