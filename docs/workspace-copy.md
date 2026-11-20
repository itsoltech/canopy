# Kopiowanie workspace'u

Status: zaimplementowane (2026-11-19), w tym wstrzymanie i wznowienie kopii w tle przy zmianie dostępności modułu Threads.

Settings → Projects → Workspaces → **Add workspace** udostępnia źródło
**Copy from …** obok istniejącego katalogu i klonu. Źródłem jest workspace tego
projektu na dostępnym workerze, także połączonego komputera. Cel to worker bez
workspace'u projektu, katalog nadrzędny i nazwa nowego katalogu. Web/desktop
używa dialogu, mobile arkusza z dotykowym, wirtualizowanym drzewem plików.

## Wybór i sekrety

Podgląd odczytuje metadane, bez treści. Repozytorium jest niepodzielne: komplet
`.git`, istniejące śledzone pliki oraz nieśledzone pliki nieobjęte ignorowaniem
z `git ls-files --cached --others --exclude-standard` są zawsze kopiowane.
UI pokazuje je w zwartym bloku: liczba plików i rozmiar, osobno gałąź monospace
(skrócona z dostępem do pełnej nazwy), a pod nią liczba nieopublikowanych
commitów nieosiągalnych z refów remote i zmian z `git status`.
Nie ma drzewa ani checkboxów repozytorium.

Picker obejmuje wyłącznie pliki ignorowane. Domyślnie zaznacza lokalne
konfiguracje i pliki mogące zawierać sekrety do 1 MiB (`.env*`, `*.local`, klucze itd.).
Pozostałe ignorowane pliki zaczynają odznaczone. Wspólna lista `COPY_GENERATED_DIRECTORIES`
w `packages/domain/src/workspace-copy.ts` obejmuje zależności, build i cache
(m.in. node_modules, target, bin/obj, venv, dist, Pods). Śledzenie przez Git
ma pierwszeństwo przed tą listą. Ignorowane zależności i wynik builda są pomijane
podczas skanowania, bez schodzenia do ich wnętrza. Nie trafiają do manifestu ani
pickera; UI podaje pominięte katalogi w rozwijanej notatce. Drzewo plików ignorowanych
pokazuje rozmiary i liczby plików. Pliki mogące zawierać sekrety mają ikonę kłódki
z objaśnieniem, a katalogi — liczbę takich plików; korzeń nie powtarza ostrzeżenia.
Grupy katalogów zaczynają
zwinięte. Powyżej 200 plików picker wyświetla wskazówkę, aby sprawdzić zależności
oraz wynik builda; długą płaską listę też pokazuje jako zwiniętą grupę.
Notatka pominiętych katalogów używa disclosure z kitu i wspólnych tokenów ruchu.
Stopka z główną akcją pozostaje poza przewijaną listą, także przy potwierdzaniu
sekretów i podczas transferu. Zablokowana akcja podaje powód, a transfer pokazuje
stan zajętości i możliwość anulowania.

Preset w `workspace_copy_presets` w domu źródła zawiera tylko SHA-256 ścieżek
zaznaczonych i pominiętych plików ignorowanych, bez nazw i treści. Stare presety
są odczytywane wyłącznie dla nadal dostępnych plików ignorowanych; wykluczenia
plików repozytorium i wpisy zależności są ignorowane. Następny zapis usuwa je z presetu.
Pliki mogące zawierać sekrety
(`.env*`, klucze, credentials, konfiguracje) wymagają każdorazowo osobnego
potwierdzenia z ich listą i nazwą celu. Gateway źródła sprawdza zgodę dla
każdego wybranego sekretu, właściciela workspace'u i przynależność do manifestu.

## Checkout i ścieżki

Kopiujemy stan checkoutu, historię i magazyn obiektów z `.git`: lokalne commity, indeks,
gałąź, refs, reflogi, `info/exclude` i remotes, bez wymagania dostępu do remote z celu.
Klon z remote nie zachowałby indeksu i nieopublikowanych commitów. Hooki, `config.worktree`,
filtry, aliasy, helpery poświadczeń, `include` i inne polityki lokalne **nie** są kopiowane:
worker źródła buduje przenośny `.git/config` (format repozytorium, `core.autocrlf`/`core.eol`,
adresy i refspeci remotes oraz powiązania gałęzi), a cel odbudowuje go jeszcze raz
przed publikacją, więc starsze źródło nie przemyci własnej konfiguracji. Adresy z
hasłem lub nazwą użytkownika w URL są pomijane. Wygenerowany config trafia do wyboru
jako wpis `.git/config` i nadal wymaga potwierdzenia sekretów.
Worker źródła odrzuca niepełne repozytorium i nie udostępnia żadnych porcji przed
autoryzacją całej selekcji. Linked worktree jest spłaszczany
do samodzielnego checkoutu: wspólne obiekty/refy plus jego własny HEAD i indeks.
Przed publikacją cel sprawdza `git fsck --connectivity-only --no-reflogs`.

Zewnętrzne alternates, `core.worktree`, nested checkout/submodule i aktywne
blokady Git wymagają klonowania lub odświeżenia po zakończeniu operacji Git.
To nie jest snapshot: zmiana rozmiaru, mtime lub tożsamości pliku przerywa
kopię i wymaga odświeżenia listy. Zachowane są tryby wykonywalności i względne
symlinki wewnątrz drzewa. Symlinki poza drzewo i w metadanych są niedostępne.
Odczyt nie podąża za podmienionymi symlinkami w ścieżce. Ścieżki muszą być
przenośne: bez traversal, ADS, znaków sterujących i aliasów Windows; kolizje
wielkości liter są odrzucane.

## Transfer i trwałość

Transfer negocjuje capability workera i gatewaya `workspace_copy_batch_v3`
(`WORKSPACE_COPY_CAPABILITY`); workery nadal ogłaszają `workspace_copy_scope_v2`
i `workspace_copy_v1` dla starszych gatewayów, które prowadzą pojedyncze porcje.
`WORKER_LINK_PROTOCOL` i zamrożony `update/v1` pozostają bez zmian. Starszy worker
albo połączony komputer pokazuje **Update this worker to copy files**. Routing źródła i celu jest niezależny,
z istniejącymi aliasami projektów i wymaganiem Share configuration. Dom celu
autoryzuje projekt/worker i publikuje workspace standardowym AddProject.

Nowe żądania `CopyWorkspace.ignored_selection` (10) i
`WorkspaceCopySource.ignored_selection` (8) zawierają tylko ścieżki ignorowane.
Gateway sam dodaje komplet repozytorium. Dawne pola `paths` pozostają oznaczone
jako deprecated; próba pominięcia pliku repozytorium jest odrzucana przez worker.
Addytywna operacja `WorkspaceCopyOperation.authorize` (8) wiąże token podglądu
z pełną listą przed odczytem. Starsze workery i połączone gatewaye wymagają aktualizacji.

Źródło → gateway → opcjonalny połączony gateway → cel używa istniejących łączy.
Gateway prowadzi `COPY_LANES` (6) ramek naraz; ramka ma do `COPY_FRAME_BYTES`
(1 MiB) i do 256 plików. Małe pliki (do ¼ ramki) są pakowane po kilkaset w jedną
ramkę (`WorkspaceCopyOperation.read_batch` / `write_batch`), duże idą ramkami
po kolei w jednym torze. Pamięć jednej kopii ogranicza się do torów × ramka;
backpressure daje to, że tor czyta następną ramkę dopiero po zapisie poprzedniej.
Worker czyta i zapisuje pliki ramki równolegle (8 naraz), ramki tej samej kopii
mogą się przeplatać, a prepare/finish/cancel czekają na nie i działają same.
Nie ma już limitu przepustowości ani fsync przy każdym pliku: cel synchronizuje
wszystkie pliki jednym ograniczonym przebiegiem (32 naraz) przed publikacją.
Dawna pojedyncza porcja (`read`/`write`, 128 KiB) zostaje dla starszych gatewayów.
Kopie prowadzone strumieniem klienta (`CopyWorkspace`) są najwyżej dwie, worker
przyjmuje cztery cele i cztery podglądy. Git przechodzi przez process governor.
Porcje nie trafiają do outboxa, journalu, modeli, logów, audytu ani diagnostyki.

Limity: 20 GiB na wybór, 8 GiB na plik, 100 000 wpisów, 8 MiB manifestu,
10 minut bezczynności. Pliki mają SHA-256 liczone przez źródło; cel liczy je
ze swoich bajtów i odrzuca niezgodny plik, gateway sprawdza rozmiary. Całość ma
SHA-256 ciągu `path\0size\0hash\n` w kolejności manifestu, liczone przez gateway
i cel przed publikacją. UI pokazuje bajty/pliki i bieżącą ścieżkę;
sekretne ścieżki zastępuje etykietą **Local configuration**.

Cel rezerwuje nowy pusty katalog regułami `project-sources.ts`, zapisuje
do sąsiedniego prywatnego `.canopy-copy-*`, weryfikuje sumy i wykonuje rename.
Na Windows pustą rezerwację celu usuwa tuż przed rename, ponieważ system nie
pozwala zastąpić istniejącego katalogu; ukończony checkout nadal publikuje atomowo.
Receipt zapisuje wyłącznie identyfikator transferu, ścieżki i tożsamości
(device/inode) katalogów, stan i czas ostatniego prepare. Anulowanie albo błąd
sumy całości usuwa tylko katalogi o zapisanej tożsamości. Przerwany transfer
w stanie `writing` (restart workera, bezczynność, wyłączenie) zostaje na
`COPY_RESUME_MS` (24 h): `WorkspaceCopyPrepare.resume` z tym samym tokenem
podejmuje go, cel usuwa pliki spoza nowego wyboru, innego typu i rozmiaru,
a resztę haszuje i zwraca w `staged`. Gateway czyta je ze źródła z
`known_sha256`: źródło haszuje plik lokalnie i odpowiada `unchanged` bez danych,
cel przyjmuje go po zgodnym haszu. Częściowe pliki zaczynają się od nowa.
Starsze receipty i przeterminowane transfery są usuwane przy starcie workera
i przed nowym transferem. Po rename cel zachowuje ukończony katalog do
finalizacji/podpięcia jako istniejący katalog; ponowne finalizowanie go nie nadpisuje.

## Kopiowanie w tle

`StartWorkspaceCopy` zakłada trwałe zadanie w gatewayu, z którym rozmawia klient
(`workspace_copy_jobs`, migracja 0147), i odpowiada po autoryzacji wyboru
i przygotowaniu celu, więc błędy wyboru (niepotwierdzony sekret, zajęty katalog)
widać w dialogu, a zadanie znika. Wiersz trzyma właściciela, końce, katalog,
nazwę workera celu, liczniki i stan (`queued`, `copying`, `finishing`, `waiting`,
`completed`, `failed`, `cancelled`). Wybór jest zapisany wyłącznie jako SHA-256
ścieżek wybranych plików ignorowanych i potwierdzonych sekretów, bez nazw;
bieżąca ścieżka nie jest zapisywana.

Zamknięcie dialogu, przeładowanie strony i restart gatewaya nie przerywają
kopii. Runner (`WorkspaceCopyJobs`) prowadzi do trzech kopii naraz, kolejne
czekają jako `queued`. Każda próba czyta świeżą listę plików, wybiera pliki
po haszach ścieżek, wznawia staging celu i wysyła tylko brakujące pliki.
Niedostępny worker albo komputer daje `waiting`; kopia rusza po połączeniu
workera i co 10 s. Trzy próby z rzędu bez postępu kończą się `failed` z
komunikatem; staging zostaje, więc **Retry** wznawia. **Cancel copy** usuwa
staging celu, a offline cel usuwa go sam po wygaśnięciu receiptu. Zakończone
i anulowane zadania są usuwane po 7 dniach, lista pokazuje dzień.

Wyłączenie **Threads** na komputerze prowadzącym kopię wstrzymuje przesyłanie. W bazie pozostają wybór plików i identyfikator transferu. Po ponownym włączeniu kopia wznawia się z dostępnych plików tymczasowych celu. Jeżeli jeden z połączonych komputerów ma wyłączone **Threads**, zadanie czeka na dostępność modułu.

Postęp idzie `OverviewUpdate.workspace_copy_job` najwyżej cztery razy na
sekundę, do bazy co 2 s; `workspace_copy_job_removed` po **Dismiss**. Klienci
czytają `ListWorkspaceCopyJobs` raz po synchronizacji strumienia. Sidebar web
i mobile pokazuje nad stopką wiersz na kopię („Copying web-app → nix-pc · 42%”)
z cienkim paskiem; wiersz otwiera szczegóły z postępem, bieżącym plikiem,
**Cancel copy** albo **Retry** i **Dismiss** po błędzie. Ukończenie kopii,
którą klient widział w trakcie, daje cichy toast; workspace jest już dodany
standardowym AddProject. Dialog kopiowania pokazuje postęp zadania i ma
**Run in background**, które zamyka dialog bez anulowania.

`workspace_copies` i audyt rozpoczęcia/zakończenia/anulowania zapisują kto,
źródło, worker celu, liczbę plików i bajtów. Nie zapisują nazw ani treści
sekretnych plików. Po ukończeniu UI podaje liczbę skopiowanych i pominiętych.
