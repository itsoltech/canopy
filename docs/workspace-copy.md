# Kopiowanie workspace'u

Settings → Projects → Workspaces → **Add workspace** udostępnia źródło
**Copy from …** obok istniejącego katalogu i klonu. Źródłem jest workspace tego
projektu na dostępnym workerze, także połączonego komputera. Cel to worker bez
workspace'u projektu, katalog nadrzędny i nazwa nowego katalogu. Web/desktop
używa dialogu, mobile arkusza z dotykowym, wirtualizowanym drzewem plików.

## Wybór i sekrety

Podgląd odczytuje metadane, bez treści. Repozytorium jest niepodzielne: komplet
`.git`, istniejące śledzone pliki oraz nieśledzone pliki nieobjęte ignorowaniem
z `git ls-files --cached --others --exclude-standard` są zawsze kopiowane.
UI pokazuje je w jednym podsumowaniu z rozmiarem, gałęzią, liczbą nieopublikowanych
commitów nieosiągalnych z refów remote i zmianami z `git status`.
Nie ma drzewa ani checkboxów repozytorium.

Picker obejmuje wyłącznie pliki ignorowane. Domyślnie zaznacza lokalne
konfiguracje i pliki mogące zawierać sekrety do 1 MiB (`.env*`, `*.local`, klucze itd.).
Pozostałe ignorowane pliki zaczynają odznaczone. Wspólna lista `COPY_GENERATED_DIRECTORIES`
w `packages/domain/src/workspace-copy.ts` obejmuje zależności, build i cache
(m.in. node_modules, target, bin/obj, venv, dist, Pods). Śledzenie przez Git
ma pierwszeństwo przed tą listą. Ignorowane zależności i wynik builda są pomijane
podczas skanowania, bez schodzenia do ich wnętrza. Nie trafiają do manifestu ani
pickera; UI podaje pominięte katalogi w rozwijanej notatce. Drzewo plików ignorowanych
pokazuje rozmiary, liczby plików i oznaczenia sekretów. Grupy katalogów zaczynają
zwinięte. Powyżej 200 plików picker wyświetla wskazówkę, aby sprawdzić zależności
oraz wynik builda; długą płaską listę też pokazuje jako zwiniętą grupę.

Preset w `workspace_copy_presets` w domu źródła zawiera tylko SHA-256 ścieżek
zaznaczonych i pominiętych plików ignorowanych, bez nazw i treści. Stare presety
są odczytywane wyłącznie dla nadal dostępnych plików ignorowanych; wykluczenia
plików repozytorium i wpisy zależności są ignorowane. Następny zapis usuwa je z presetu.
Pliki mogące zawierać sekrety
(`.env*`, klucze, credentials, konfiguracje) wymagają każdorazowo osobnego
potwierdzenia z ich listą i nazwą celu. Gateway źródła sprawdza zgodę dla
każdego wybranego sekretu, właściciela workspace'u i przynależność do manifestu.

## Checkout i ścieżki

Kopiujemy komplet `.git`: zachowuje lokalne commity, indeks, gałąź i remotes,
bez wymagania dostępu do remote z celu. Klon z remote nie zachowałby indeksu
i nieopublikowanych commitów. `.git/config` wymaga potwierdzenia sekretów.
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

Nowy zakres negocjuje capability workera i gatewaya `workspace_copy_scope_v2`,
obok dotychczasowego `workspace_copy_v1`. `WORKER_LINK_PROTOCOL`
i zamrożony `update/v1` pozostają bez zmian. Starszy worker pokazuje
**Update this worker to copy files**. Routing źródła i celu jest niezależny,
z istniejącymi aliasami projektów i wymaganiem Share configuration. Dom celu
autoryzuje projekt/worker i publikuje workspace standardowym AddProject.

Nowe żądania `CopyWorkspace.ignored_selection` (10) i
`WorkspaceCopySource.ignored_selection` (8) zawierają tylko ścieżki ignorowane.
Gateway sam dodaje komplet repozytorium. Dawne pola `paths` pozostają oznaczone
jako deprecated; próba pominięcia pliku repozytorium jest odrzucana przez worker.
Addytywna operacja `WorkspaceCopyOperation.authorize` (8) wiąże token podglądu
z pełną listą przed odczytem. Starsze workery i połączone gatewaye wymagają aktualizacji.

Źródło → gateway → opcjonalny połączony gateway → cel używa istniejących łączy.
Jedna porcja 128 KiB czeka na zapis przed następnym odczytem, do 8 MiB/s.
Gateway dopuszcza dwie kopie, worker dwa cele i cztery podglądy. I/O jest
asynchroniczne, Git przechodzi przez process governor. Porcje nie trafiają
do outboxa, journalu, modeli, logów, audytu ani diagnostyki.

Limity: 20 GiB na wybór, 8 GiB na plik, 100 000 wpisów, 8 MiB manifestu,
10 minut bezczynności. Pliki mają SHA-256; całość ma SHA-256 uporządkowanego
ciągu `path\0size\0hash\n`. UI pokazuje bajty/pliki i bieżącą ścieżkę;
sekretne ścieżki zastępuje etykietą **Local configuration**.

Cel rezerwuje nowy pusty katalog regułami `project-sources.ts`, zapisuje
do sąsiedniego prywatnego `.canopy-copy-*`, weryfikuje sumy i wykonuje rename.
Na Windows pustą rezerwację celu usuwa tuż przed rename, ponieważ system nie
pozwala zastąpić istniejącego katalogu; ukończony checkout nadal publikuje atomowo.
Receipt zapisuje wyłącznie identyfikator transferu, ścieżki i tożsamości
(device/inode) katalogów oraz stan. Po błędzie, anulowaniu lub restarcie
cleanup usuwa tylko katalogi o zapisanej tożsamości. Po rename zachowuje
ukończony katalog do finalizacji/podpięcia jako istniejący katalog.
Ponowne finalizowanie nie nadpisuje go; przerwane porcje ponawia się od nowego
podglądu, bez wznawiania części pliku.

`workspace_copies` i audyt rozpoczęcia/zakończenia/anulowania zapisują kto,
źródło, worker celu, liczbę plików i bajtów. Nie zapisują nazw ani treści
sekretnych plików. Po ukończeniu UI podaje liczbę skopiowanych i pominiętych.
