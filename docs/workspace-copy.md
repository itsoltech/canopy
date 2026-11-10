# Kopiowanie workspace'u

Settings → Projects → Workspaces → **Add workspace** udostępnia źródło
**Copy from …** obok istniejącego katalogu i klonu. Źródłem jest workspace tego
projektu na dostępnym workerze, także połączonego komputera. Cel to worker bez
workspace'u projektu, katalog nadrzędny i nazwa nowego katalogu. Web/desktop
używa dialogu, mobile arkusza z dotykowym, wirtualizowanym drzewem plików.

## Wybór i sekrety

Podgląd odczytuje metadane, bez treści. Domyślnie zaznacza istniejące pliki
z `git ls-files --cached --others --exclude-standard` oraz ignorowane lokalne
konfiguracje do 1 MiB (`.env*`, `*.local`, `.npmrc` itd.). Pozostałe ignorowane
pliki są osobną, wyłączoną grupą. Wspólna lista `COPY_GENERATED_DIRECTORIES`
w `packages/domain/src/workspace-copy.ts` obejmuje zależności, build i cache
(m.in. node_modules, target, bin/obj, venv, dist, Pods). Śledzenie przez Git
ma pierwszeństwo przed tą listą. Drzewo umożliwia wybór folderów i plików,
filtruje ścieżki i pokazuje rozmiary oraz liczby plików.

Preset w `workspace_copy_presets` w domu źródła zawiera tylko SHA-256 ścieżek
zaznaczonych i pominiętych, bez nazw i treści. Pliki mogące zawierać sekrety
(`.env*`, klucze, credentials, konfiguracje) wymagają każdorazowo osobnego
potwierdzenia z ich listą i nazwą celu. Gateway źródła sprawdza zgodę dla
każdego wybranego sekretu, właściciela workspace'u i przynależność do manifestu.

## Checkout i ścieżki

Kopiujemy komplet `.git`: zachowuje lokalne commity, indeks, gałąź i remotes,
bez wymagania dostępu do remote z celu. Klon z remote nie zachowałby indeksu
i nieopublikowanych commitów. `.git/config` wymaga potwierdzenia sekretów.
Wszystkie metadane muszą pozostać wybrane. Linked worktree jest spłaszczany
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

Capability workera i gatewaya to `workspace_copy_v1`; `WORKER_LINK_PROTOCOL`
i zamrożony `update/v1` pozostają bez zmian. Starszy worker pokazuje
**Update this worker to copy files**. Routing źródła i celu jest niezależny,
z istniejącymi aliasami projektów i wymaganiem Share configuration. Dom celu
autoryzuje projekt/worker i publikuje workspace standardowym AddProject.

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
