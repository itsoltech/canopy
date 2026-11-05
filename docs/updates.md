# Aktualizacje Canopy

## Wskaźnik w pasku bocznym

Trzecia ikona stopki (za Settings i licznikiem workerów) pokazuje aktualizacje
własnej aplikacji desktopowej: stan spokojny, sprawdzanie, pobieranie z procentem
oraz gotowość do restartu. Hover i klik otwierają ten sam przewijany popover;
na telefonie jest to dolny panel. Animacja respektuje ograniczenie ruchu.
Przeglądarka serwerowa nie pokazuje sekcji własnej aplikacji.

Popover ma 352 px szerokości i wysokość zależną od zawartości (maksymalnie
70% okna / 512 px); przewija się lista między nagłówkiem a odnośnikami.
Nagłówek zawiera Check now i Update all. Każda pozycja ma zwarty wiersz
z wersjami, stanem i akcją; postęp to cienki kolorowy pasek, a nie pełne
wypełnienie udające 100%. Aktualne pozycje zwija „Up to date · N”. Instrukcje
instalacji i kolejność aktualizacji są pod ikonami informacji. Długie nazwy
i wersje mają skrót z pełną treścią w podpowiedzi; błędy można rozwinąć.
Popover nie pokazuje notatek wydań; są w Settings → Workers / App updates razem
z pełnymi ustawieniami, wymuszeniem restartu i szczegółami instalatorów.

Settings → Workers → Updates używa tych samych zwartych wierszy. Nagłówek
pokazuje stan i czas sprawdzenia; Update all pojawia się tylko przy dostępnych
aktualizacjach. Aktualne workery nie mają przycisku aktualizacji. Kanał zapisuje
się po wyborze; przejście na starszy kanał lub starszą przypiętą wersję wymaga
potwierdzenia. Wyniki przebiegu można rozwinąć tylko, gdy istnieją kroki.
Brak notatek wydania (także pusty wynik lub niedostępne źródło) ukrywa
„What’s new”; interfejs nie pokazuje pustych akordeonów ani objaśnień tego braku.

Proces main pobiera publiczne GitHub Releases bez tokena, z paginacją i cache
60 sekund. Notatki obejmują `(wersja zainstalowana, wersja pobierana]`, zgodnie
z wybranym kanałem, w malejącej kolejności SemVer. Istniejący renderer Markdown
nie wstrzykuje HTML, ogranicza schematy linków i nie ładuje obrazów. Retencja
nightly może usunąć starsze notatki; panel jawnie wskazuje to ograniczenie.

Release bez feedu platformy lub manifestu nie jest aktualizacją desktopu.
Jeśli nowsza wersja jest już w GitHub Releases, ale nie ma paczki platformy,
updater wyjaśnia, że publikacja może jeszcze trwać lub wymagać ponowienia;
nie twierdzi, że aplikacja jest aktualna.

Ten sam popover zawiera centrum gatewaya, workerów binarnych, CLI i sparowanych
zdalnych desktopów. Wersja serwerowa UI pokazuje centrum bez własnej aplikacji.
Odnośniki prowadzą do Settings → Workers oraz App updates. Gateway/workery i
zdalne aplikacje pokazują notatki Canopy dla swojego kanału; Claude Code i Codex
korzystają z publicznych Releases dostawców. Grok nie wskazuje takiego źródła,
więc panel pokazuje to ograniczenie oraz istniejące wyjście instalatora.

**Update all** zapisuje kolejkę w prywatnym `user_settings.settings.updateRun`.
Nie zmienia zamrożonego UpdateService ani nie wymaga migracji. Kolejność:
gateway → workery binarne na wersję uruchomionego gatewaya → zainstalowane CLI
→ zdalne aplikacje z nowszą dostępną wersją. Brakujące CLI instaluje się osobnym
przyciskiem Install. Własną aplikację desktopową restartuje się niezależnie;
jej dołączony gateway aktualizuje bundle, nie samodzielna wymiana binarki.

Gateway odpytywany co 2 sekundy wznawia zapisaną kolejkę po restarcie. Potwierdzenie
przyjęcia komendy nie kończy kroku: wymagany jest raport wyniku, nowa wersja i
zgodny protokół workera. Każda akcja ponownie sprawdza dotychczasowe uprawnienia.
Błąd lub utrata zgodności zatrzymuje kolejne kroki z przyczyną; Retry update all
tworzy aktualny plan. Timeout kroku to 35 minut. Nie odtwarzamy w ciemno przerwanej
instalacji CLI; bez raportu po 60 sekundach należy sprawdzić worker i ponowić akcję.
Kolejka nie przyznaje force ani downgrade. Gateway Docker/source zatrzymuje ją
na instrukcji ręcznej aktualizacji; po podmianie obrazu należy ponowić Update all.

Publiczne notatki serwerowego centrum pobiera BFF z ustalonej listy repozytoriów,
bez tokenów, z cache 60 sekund. Błąd pobierania ma przycisk Retry i nie blokuje
samej aktualizacji. Rozpoczęty krok zachowuje wersję początkową i docelową,
żeby zmiana najnowszego wydania nie zmieniła historii wybranej aktualizacji.

Workers → Updates oferuje **Update Canopy app** dla `installKind=desktop`.
Aktualizuje całą aplikację: Electron, dołączony runtime i worker. Desktop w trybie
zdalnym musi być sparowany z gatewayem i obsługiwać kanał sterowania z
[etapu 2 lokalnego frontendu](desktop-remote-frontend.md#wynik-etapu-2).
Workery binarne zachowują niezależny mechanizm opisany poniżej.

## Zdalna aktualizacja aplikacji desktopowej

Właściciel gatewaya wysyła żądanie przez Workers; nie wymaga ono administracyjnej
roli potrzebnej do aktualizacji samego gatewaya. Gateway przekazuje wyłącznie id
żądania i ewentualne force. `DesktopControlService` korzysta z tego samego pinned
TLS Network access i odwoływalnego poświadczenia desktopu co jego UI.
Osobne `DesktopWorkerService.Confirm` dowodzi posiadania credentialu własnego
workera tego samego właściciela. Samo `worker_id` ani `installKind` nie wystarcza.

Controller przekazuje żądanie przez prywatne IPC do Electron main. Tylko main
wywołuje `DesktopUpdates`; desktop sam pobiera wydanie swoim normalnym updaterem,
z własnego kanału. Gateway nie dostarcza binariów desktopu, adresów feedu ani zgody
na downgrade. Lokalna próba przełączenia kanału musi się zakończyć przed zdalną
aktualizacją. Docelowy SemVer musi być ściśle nowszy, także gdy lokalnie pobrano
starszą paczkę. Zasady Developer ID/codesign i walidacja Squirrel na macOS pozostają
obowiązujące; brak podpisanego buildu wyłącza funkcję.

Desktop pokazuje powiadomienie o żądaniu. Po pobraniu ustawia barierę przyjmowania
pracy przez własnego workera i czeka na zakończenie tur, generacji i zadań w tle.
Workers pokazuje „Will restart after the current turns”; **Restart now…** otwiera
potwierdzenie przerwania pracy. Force wymaga id tego samego oczekującego żądania.
Restart instaluje cały bundle, uruchamia aplikację i odtwarza połączenie.
Poświadczenie workera pozostaje osobne; worker nigdy nie wymienia sidecarów.

Overview przekazuje wersję dostępną, procent pobierania, waiting/restarting oraz
failed z przyczyną. Offline, brak parowania, starsza aplikacja bez funkcji lub
wyłączony updater blokują akcję z widocznym powodem. Nowych żądań nie kolejkujemy
dla offline; zaakceptowane wcześniej mają trwałe id i są deduplikowane przy reconnect.
Gateway zapisuje stan i komendę w `desktop_updates` (migracja `0058`) oraz audyt
żądania, force i wyniku: aktor, wersja, id i przyczyna. Lokalny journal jest osobny
dla poświadczenia desktopu; przerwana próba po restarcie kończy się błędem,
a start docelowej wersji po restarting — sukcesem. Nieczytelna historia blokuje
zdalne odtwarzanie, zachowując plik i możliwość uruchomienia aplikacji.

Tryb lokalny nie otwiera tego strumienia. Aktualizowanie lokalnego desktopu przez
relację połączonych komputerów pozostaje możliwym późniejszym krokiem.
`canopy.update.v1` nie zmienia się. Integracja gateway ↔ desktop zastępuje updater
na jego granicy; rzeczywisty podpis, instalację i restart trzeba sprawdzić na macOS.

Gateway i worker używają jednej wersji aplikacji z `CANOPY_VERSION` (wstrzykiwanej
podczas kompilacji; bez niej `0.0.0-dev`). `--version` wypisuje tę wersję bez
uruchamiania usług. Wersja aplikacji nie jest numerem protokołu.

## Niezależny kanał ratunkowy

`proto/canopy/update/v1/update.proto` definiuje zamrożony
`canopy.update.v1.UpdateService`. Gateway wystawia go na tym samym porcie
HTTP/2 co WorkerLink, pod osobną ścieżką usługi. Zdalne workery korzystają ze wspólnego
listenera Network access i pinu zapisanego przy enrollment. Osobny port nie
zwiększyłby odporności na niezgodne kontrakty, a wymagałby dodatkowych reguł proxy
i firewalla. Worker inicjuje oba niezależne połączenia, również za NAT-em.

| RPC / endpoint | Dostęp i odpowiedź |
|---|---|
| `Check` bez Authorization | Tylko zdrowie gatewaya, jego wersja i zakresy protokołów. Nie ujawnia workerów, poleceń ani assetów. |
| `Check` z credentialem | Dodatkowo werdykt zgodności dla podanego workera. |
| `Watch` | Credential workera w `Authorization: Bearer …`; natychmiastowy werdykt, następnie polecenia i heartbeat. Rozwiązanie release nie blokuje pierwszego werdyktu. |
| `Report` | Uwierzytelniony postęp/wynik przypisany do identyfikatora polecenia. Stary raport nie nadpisze nowego polecenia. |
| `FetchArtifact` | Uwierzytelniony strumień zweryfikowanej binarki workera wyłącznie dla wersji działającego gatewaya i wskazanej platformy. |
| `GET /healthz` | Anonimowe `{healthy, version}`, HTTP 200/503, bez cache. Przy h2c wymaga HTTP/2; listener TLS obsługuje także HTTP/1.1. |

`worker_id` musi odpowiadać credentialowi. Unieważnienie/rotacja credentialu lub
archiwizacja workera zamyka kanał; heartbeat ponownie sprawdza uprawnienia.
Poświadczenia nie trafiają do manifestów, adresów pobierania ani plików usługi.

`WORKER_LINK_PROTOCOL`, `MIN_WORKER_LINK_PROTOCOL` i `UPDATE_PROTOCOL` są w
`packages/domain/src/release/protocol.ts`. Obecnie wszystkie wynoszą 1. Worker
wysyła zakres `[min_worker_link_protocol, worker_link_protocol]` także w
WorkerLink `Hello` (nowe pola 760 i 761). Gateway dopuszcza połączenie, gdy oba
dodatnie zakresy mają wspólny numer. Brak negocjacji (0) jest niezgodny;
WorkerLink zwraca `FailedPrecondition` z zakresem i wskazaniem UpdateService.
Aktualizator działa niezależnie od tego handshake i konfiguracji dostawców.

Reguły utrzymania v1: wyłącznie nowe opcjonalne pola i RPC, bez zmiany znaczeń,
typów ani numerów istniejących pól. Nie usuwać v1 przy kolejnej wersji WorkerLink.
Nie importować do niego wiadomości WorkerLink ani UI. `UPDATE_PROTOCOL` pozostaje
1; zmiana łamiąca WorkerLink zwiększa jego własny numer. Nowe stany postępu są
tekstowe; stary serwer je przyjmuje, stary klient pokazuje bezpieczny stan
zastępczy. Nieznana zgodność nie może otworzyć WorkerLink. Nieznany rodzaj
instalacji jest zarządzany zewnętrznie.

Worker sprzed wprowadzenia UpdateService wymaga **jednej ręcznej aktualizacji**.
Nie ma możliwości zdalnego dodania kanału do procesu, który go jeszcze nie zna.

## Release i mirror

Źródło domyślne: `https://api.github.com/repos/itsoltech/canopy/releases…`.
Kanały: `stable` wybiera najwyższe stabilne semver, `beta` najwyższe ze stable/beta,
`nightly` najwyższe ze wszystkich wydań (z paginacją i porównaniem semver, nie datą publikacji).
`vX` / `vX.Y` wybierają najwyższe stable z prefiksem, `vX.Y.Z` wskazuje dokładny stabilny tag
(mirror może zachować również tagi `X.Y.Z`). Drafty i release bez `manifest.json` są pomijane.
Pipeline publikuje `manifest.json` najpierw z binariami gatewaya/workera, a po buildach desktop
wymienia go na wersję z instalatorami; wpisy binariów pozostają takie same ([release.md](release.md)).
Gateway pobiera manifest swojej konkretnej wersji również dla prerelease; nie zastępuje go
manifestem nowszego nightly. Protokół UpdateService pozostaje bez zmian.

**`latest` oznacza teraz stable**, a stare zapisane `updateChannel: "latest"` gateway przy
starcie zapisuje jako `stable`. Zmienna środowiskowa `latest` i żądania starszych klientów
także są normalizowane do stable. Nie publikujemy już rolling GitHub release/tagu `latest`
ani buildów `X.Y.Z-main.<sha7>`. Settings → Workers → Updates pozwala wybrać trzy kanały
lub wpisać stabilny pin. Nightly z dev, beta z next i stable z main opisuje [release.md](release.md).

Resolver pobiera asset `manifest.json`, schemat 1:

```json
{
  "schema": 1, "version": "2.1.0", "channel": "stable",
  "commit": "abcdef0", "published_at": "2026-11-03T00:00:00Z",
  "protocol": { "worker_link": 1, "update": 1 },
  "assets": [{
    "app": "worker", "os": "linux", "arch": "x64",
    "name": "canopy-worker-linux-x64",
    "url": "https://github.com/itsoltech/canopy/releases/download/v2.1.0/canopy-worker-linux-x64",
    "sha256": "<64 znaki hex>", "size": 123456
  }]
}
```

Nazwy niekompresowanych binarek: `canopy-{gateway|worker}-{os}-{arch}`
(`linux|darwin|windows`, `x64|arm64`, `.exe` na Windows). Pipeline publikuje także
`checksums.txt`; runtime weryfikuje rozmiar i SHA-256 bezpośrednio z manifestu.
Manifest może zawierać także instalatory desktop z własnymi nazwami; aktualizator
gatewaya/workera nie wybiera tych assetów.
Desktop ma osobną politykę: Settings → App updates zapisuje kanał w lokalnym
`userData/app-updates.json` Electrona, bez wywołania gatewaya i bez zmiany kanału
gatewaya ani workera. Jedna aplikacja Canopy ma wspólne dane dla wszystkich kanałów.
Stable dopuszcza stable, Beta stable/beta, Nightly wszystkie trzy; resolver wybiera
najwyższy SemVer. Powrót do stabilniejszego kanału wymaga zgody na pojedynczą próbę
downgrade'u z ryzykiem niezgodnych danych. Nie jest to rollback bazy ani mechanizm
UpdateService opisany poniżej. W lokalnym desktopie nowy instalator zawiera też nowy
runtime gatewaya/workera — ich jawne polityki aktualizacji pozostają niezależne.
Semantyka feedów i migracja starych instalacji: [desktop.md](desktop.md#automatyczne-aktualizacje-desktopu).

Wszystkie adresy upstream i przekierowania muszą używać HTTPS. Jawny wyjątek HTTP
jest dostępny tylko w opcjach testowych, nie przez zmienną środowiskową.

Gateway przechowuje manifest własnej wersji oraz binarki workerów w cache
adresowanym SHA-256. Równoległe żądania współdzielą pobieranie; każde ponowne
użycie pliku sprawdza jego hash. Przed własną aktualizacją zapisuje wybrany
manifest oraz pobiera assety platform znanych workerów binarnych, aby przesunięcie
retencja starszych nightly nie odebrała im aktualizacji. Cache zachowaj między restartami.
Workery preferują `FetchArtifact`, więc nie potrzebują dostępu do internetu.
Przy zimnym cache gateway musi mieć dostęp do release; awaria mirrora kończy
próbę czytelnym błędem i pozostawia bieżącą binarkę.

## Wymiana, restart i rollback

1. Administrator aktualizuje gateway w **Settings → Workers → Updates**.
   Gateway sprawdza kanał co 15 minut; akcje zarządzania wymagają roli `admin`.
   Kanał zapisuje się w istniejącym `user_settings.settings.updateChannel`.
2. Gateway blokuje nowe tury, czeka na zakończenie tur workerów i botów, pobiera
   release i weryfikuje go. Wybrany gateway jest wymieniany przed wysłaniem
   workerom poleceń przejścia na tę wersję.
3. Po restarcie worker otwiera Watch. Gateway zapisuje trwałe polecenie przejścia
   na **swoją uruchomioną wersję**; zastępuje polecenie do poprzedniej wersji.
   Offline worker odbierze je przy następnym połączeniu. Ręczne **Update worker**
   i **Update all** pozwalają ponowić próbę. Nie ponawia automatycznie błędu lub
   rollbacku i nie wykonuje automatycznego downgrade.
4. Worker zamyka przyjmowanie nowej pracy i zgłasza `waiting_idle`; czeka również
   na generacje i zadania w tle. Limit domyślny to 30 minut. Przekroczenie limitu
   odracza aktualizację, odblokowuje pracę i wymaga ponowienia. Tylko jawne `force`
   w administracyjnym `ManageUpdates` może przerwać aktywną pracę. Po błędzie
   worker odtwarza niepotwierdzone polecenia przez ponowne połączenie WorkerLink.
5. Zweryfikowane bajty trafiają do pliku `.next` obok executable (ten sam system
   plików), są synchronizowane, otrzymują prawa wykonania, poprzedni plik zostaje
   jako `.bak`, a atomowy rename podmienia executable. Manifest, rozmiar i SHA
   muszą być poprawne **przed** dopuszczeniem wykonania. Downgrade wymaga jawnego
   `allow_downgrade` administratora. Stan i identyfikator polecenia zapisuje
   prywatny plik `.update.json` obok binarki.

Binarka uruchamia proces nadzorujący i właściwy proces usługi. Kod wyjścia **75**
żąda ponownego uruchomienia executable. Ten sam mechanizm działa na pierwszym
planie i pod systemd/launchd. Stary supervisor pozostaje w pamięci do potwierdzenia
nowej wersji, dzięki czemu potrafi przywrócić `.bak`, nawet gdy nowa binarka w ogóle
się nie uruchamia.
Zwykłe zakończenie nie wywołuje restartu supervisora; politykę awarii ustala
menedżer usług. Drukowane unit/plist mają `Restart=always` / `KeepAlive=true`.
Gateway `service` drukuje unit z `EnvironmentFile=%h/.config/canopy/gateway.env`;
przygotuj ten prywatny plik samodzielnie z istniejącą konfiguracją gatewaya.

Nowy gateway potwierdza start po uruchomieniu DB, listenerów i aktualizatora;
worker po otrzymaniu WorkerLink Welcome. Jeśli proces wcześniej wyjdzie albo
nie potwierdzi startu w **90 sekund**, supervisor przywraca `.bak` i uruchamia
poprzednią wersję. Potwierdzenie trafia też przez lokalne IPC do supervisora;
raportowanie i usunięcie `.update.json` nie mogą zgubić tego sygnału.

Jeżeli wersja potwierdzonego dziecka różni się od wersji supervisora, supervisor
prosi je przez IPC o przekazanie nadzoru. Dziecko używa tej samej blokady aktualizacji
i bariery przyjmowania pracy: worker czeka na tury, generacje i zadania w tle,
gateway na tury workerów i botów. Nie wymusza przerwania pracy. Po opróżnieniu
wykonuje zwykłe zamknięcie zasobów i wychodzi z wewnętrznym kodem **76**.
Dopiero wtedy supervisor wykonuje `process.execve` na potwierdzonej binarce:
zachowuje PID, argumenty i środowisko usługi oraz standardowe strumienie,
a nowy supervisor uruchamia właściwy proces usługi. Zdrowe dziecko uruchamia się
zatem drugi raz; żadne aktywne zadanie nie jest z tego powodu przerywane.
Kod 76 jest obsługiwany wewnętrznie, nie wymaga restartu przez menedżera usług.

Obsługa `process.execve` jest zweryfikowana na przypiętym Bun **1.4.4** przez testy
skompilowanych binariów. Mechanizm działa również na pierwszym planie bez
systemd/launchd. Brak API lub błąd `execve` pozostawia dotychczasowy supervisor
aktywny (po błędzie uruchamia on ponownie potwierdzone dziecko), wyłącza dalsze
próby przekazania w tym procesie i zapisuje komunikat o potrzebie restartu usługi.
Nie uruchamia niepotwierdzonego executable przez `execve`; kolejna aktualizacja
zachowuje własny watchdog i rollback. Sprawdza też, czy plik nie został ponownie
podmieniony od startu potwierdzonego dziecka.

Potwierdzenie startupu jest wysyłane także wtedy, gdy wynik aktualizacji został już
zgłoszony albo binarka na dysku była potwierdzona przed startem dziecka. Starszy
supervisor z tym mechanizmem przechodzi wówczas na wersję dziecka jeden raz;
zgodne wersje nie wywołują kolejnego przekazania. **Supervisor sprzed dodania tego
mechanizmu wymaga jednego ręcznego restartu usługi**, żeby załadować jego obsługę.
Nie da się zmienić kodu procesu, który nie zna protokołu przekazania.

Worker raportuje utrwalony sukces/błąd przed następnym Watch.
Jeśli raport sukcesu zaginie, zgodny handshake WorkerLink na dokładnej wersji
zapisanego polecenia i celu kończy utrwalone `restarting` jako `succeeded`.
Sam reconnect UpdateService nie dowodzi zdrowego startu; inna wersja,
niezgodny protokół i zapisany błąd/rollback nie są w ten sposób kasowane.
Metadane UI i polecenia pozostają w istniejącym JSONB `workers.capabilities`
(`update`, `updateCommand`); migracja schematu nie jest potrzebna.

## Instalacja i konfiguracja

Ten sam mirror zasila nową instalację: uwierzytelniony BFF wywołuje dodany
`GatewayService.FetchWorkerInstall`, a publiczne `/install/worker/<os>/<arch>` przekazuje
strumień binarki. `?sha256=1` zwraca hash z manifestu dokładnej wersji gatewaya. Nie zmienia
to zamrożonego `UpdateService` ani nie wymaga credentialu jeszcze nieutworzonego workera.
Dozwolone platformy instalatora: Linux x64/arm64 i macOS arm64. Brak wydania/mirrora
kończy pobieranie błędem HTTP; kreator rozwiązuje wtedy kanał do konkretnego GitHub Release
i wyświetla jawny fallback. Skrypt zawsze weryfikuje checksum przed wykonaniem binarki.

| Ustawienie | Znaczenie |
|---|---|
| `CANOPY_VERSION` | Wspólna wersja, wstrzykiwana przez pipeline. |
| `CANOPY_UPDATE_CHANNEL` | Kanał początkowy, domyślnie `stable`; `beta`, `nightly` lub stabilny pin. Zapisany wybór administratora ma pierwszeństwo. |
| `CANOPY_RELEASE_BASE_URL` | Alternatywny HTTPS endpoint o układzie API GitHub (mirror/testy). |
| `CANOPY_UPDATE_CACHE_DIR` | Katalog cache gatewaya; ma pierwszeństwo przed `$XDG_CACHE_HOME/canopy/releases` i `~/.cache/canopy/releases`. Brak zapisu powoduje jedno ostrzeżenie i przejście na prywatny, nietrwały katalog pod `os.tmpdir()`. Jeśli on też jest niedostępny, UI dostaje konkretny błąd zamiast informacji o braku połączenia. |
| `CANOPY_INSTALL_KIND=docker` | Jawnie oznacza kontener; runtime rozpoznaje też `/.dockerenv` i `/run/.containerenv`, a poza kontenerem standalone Bun albo checkout źródeł. |

Samoczynna wymiana obsługuje binarki **Linux/macOS** z zapisywalnym katalogiem
instalacji i zwykłym executable (bez symlinków). Kontener pokazuje „Pull the new
image tag and recreate this container”; source — aktualizację checkoutu,
`bun install` i restart. Nie podmieniają plików uruchomieniowych.
**Windows wymaga na razie zewnętrznego instalatora/usługi** ze względu na blokadę
uruchomionego `.exe`; worker zgłasza `managed_externally`.

## CLI dostawców

Aktualizacje Canopy nie obejmują CLI dostawców (`claude`, `codex`, `grok`) — nie są dołączane. Ich osobne
instalacje i aktualizacje na kliknięcie, źródła najnowszych wersji i przepisy opisuje [provider-cli.md](provider-cli.md).

## Granice i dalsze prace

- SHA-256 zabezpiecza integralność względem manifestu dostarczonego z zaufanego
  HTTPS/gatewaya. Weryfikacja podpisów manifestu (minisign/cosign) pozostaje do dodania.
- Samoczynna wymiana Windows wymaga osobnego instalatora, który przeżywa zatrzymanie
  procesu i potrafi uruchomić usługę oraz rollback.
- Rollback obejmuje executable, nie migracje bazy. Release wymagający nieodwracalnej
  migracji musi mieć osobny plan wdrożenia; migracje muszą tolerować powrót binarki.
- Testy obejmują lokalny fixture release, realny gRPC i PostgreSQL oraz skompilowane
  binaria: A → B → C z niezmiennym PID supervisora, oczekiwanie na pracę w toku,
  rollback przed potwierdzeniem, start ze starszym supervisorem i brak pętli
  restartów. Rzeczywiste publikacje GHCR/GitHub Releases należą do pipeline.
