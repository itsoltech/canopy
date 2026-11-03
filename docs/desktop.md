# Canopy Desktop

Implementacja: `apps/desktop`. Zweryfikowany cel: **Linux x64**. Pozostałe cele mają
konfigurację i układ zasobów, ale nie zostały tutaj zbudowane ani uruchomione.
Nazwa produktu: **Canopy**.

## Decyzje

1. **Runtime:** Electron main (Node) uruchamia kontroler Bun przez prywatne stdin/stdout
   z typowanymi komunikatami JSON. Kontroler nadzoruje PostgreSQL → gateway → enrollment
   → worker → adapter-node SvelteKit. Wszystkie usługi to procesy potomne, z osobnymi
   grupami procesów, ograniczonym restartem z backoff i zamknięciem w odwrotnej kolejności.
   Zamknięcie stdin po śmierci Electron uruchamia sprzątanie kontrolera. Renderer ładuje
   zwykły origin HTTP i dokładnie ten sam build web, bez kopii komponentów.
2. **Baza:** pełny PostgreSQL 18.6 z binariów `@embedded-postgres`, pakowanych razem
   z aplikacją. Nie wymaga instalacji ani działającego serwera PostgreSQL na komputerze.
   Decyzja użytkownika wyklucza PGlite i SQLite: ten sam silnik co na serwerze zachowuje
   transakcje, blokady, LISTEN/NOTIFY, typy i istniejące migracje bez zmian. Nie dodajemy
   drugiego drivera Effect SQL ani wariantów zapytań. Aktualny checkout zawiera już
   migrację mobile `0046`; desktop nie dodaje żadnej. Pakiet dystrybucyjny ma
   oznaczenie beta; sam serwer PostgreSQL to wydanie 18.6. Zmiana głównej wersji wymaga
   osobnej procedury eksportu/upgrade, nie automatycznego usuwania katalogu.
3. **Dane i sekrety:** wszystko pod `app.getPath('userData')`. Klucz szyfrowania gatewaya,
   token BFF i hasło bazy powstają raz. Plik 0600 zawiera wyłącznie ciphertext
   asynchronicznego `safeStorage` (Keychain na macOS, DPAPI na Windows,
   Secret Service/KWallet na Linuxie). Backend
   `basic_text` jest odrzucany; aplikacja wymaga działającego magazynu kluczy.
   `worker.json` zachowuje istniejący format enrollment i uprawnienia 0600.
4. **Porty:** losowe wolne porty; Postgres, web i domyślnie gRPC na `127.0.0.1`.
   Opcja „Allow other machines to connect” dotyczy wyłącznie dodatkowego listenera
   worker link/enrollment gRPC; pełne UI/API pozostaje na loopback.
   wymaga świadomego wybrania interfejsu. Nie wystawia BFF ani bazy. HTTP bez TLS
   nadaje się wyłącznie do zaufanej sieci prywatnej; publiczne udostępnienie wymaga TLS.
5. **Pakowanie:** electron-builder, AppImage + deb na Linuxie, dmg na macOS, NSIS
   na Windows x64.
   Osobny build zasobów dla każdej pary OS/arch; Bun i natywne zależności nie mogą
   pochodzić z innej architektury. Aktualizacje automatyczne są poza zakresem.

## Granice i zgodność

Tryb lokalny korzysta ze zwykłego `CreateWorkerEnrollment` i `enrollWorker`, zamiast
tworzyć poświadczenia bezpośrednio w bazie. Tryb zdalny wymaga dwóch adresów:
gRPC gatewaya i web Canopy. Uruchamia tylko worker (oraz lokalny ekran konfiguracji);
okno aplikacji ładuje podany zdalny web. Token usługi BFF nigdy nie jest potrzebny
do enrollment zdalnego workera ani przekazywany rendererowi. Token jednorazowy
nie trafia do `desktop.json`; reconnect używa istniejącego `worker.json`.
Każdy zdalny origin gatewaya ma własny katalog tożsamości workera. Niedostępny
gateway powoduje ponawianie połączenia przez workera. Niedostępny web przy starcie
otwiera lokalny ekran ustawień. Zmiana trybu zatrzymuje lokalnie wykonywane zadania.

Preload udostępnia tylko status, konfigurację trybu w zaufanym lokalnym ekranie,
otwarcie ustawień i subskrypcję statusu. Brak dostępu do plików, shella i dowolnego IPC.
Każde wywołanie jest sprawdzane względem nadawcy i originu; obcy web nie może
zmienić lokalnej konfiguracji ani przesłać tokenu enrollment. Renderer ma sandbox,
contextIsolation i wyłączoną integrację Node. Linki zewnętrzne otwierają systemową
przeglądarkę. `canopy://enroll` jedynie wypełnia formularz — nie zużywa tokenu bez akcji użytkownika.
Format: `canopy://enroll?gateway=<encoded-origin>&web=<encoded-origin>&token=<encoded-token>`.
Formularz potwierdza gotowość przez IPC przed dostarczeniem sekretu z linku.
Remote web ma dostęp do statusu i otwarcia ustawień; konfigurację oraz odbiór tokenu
może wykonać wyłącznie lokalna strona `/desktop`.

Polityka CSP dopuszcza skrypty z wybranego originu i hashe skryptów startowych
SvelteKit, bez `unsafe-eval` i `unsafe-inline` dla skryptów. Przy przeładowaniu dokumentu
main ponownie pobiera HTML, aby policzyć hashe. Zdalny web musi być osiągalnym originem
HTTP(S), bez prefiksu ścieżki i bez zewnętrznego przekierowania logowania.

Bez migracji DB ani zmian proto. `packages/ui/desktop` jest nowym, opcjonalnym
kontraktem typów. Mobile i przeglądarka nie muszą go implementować. Root workspaces
już obejmuje `apps/*`, więc nowa aplikacja nie wymaga zmiany konfiguracji workspaces.

Zmiany wspólnego kodu są addytywne:

- `packages/ui/desktop`: opcjonalne typy bridge, bez zmian protokołu gatewaya.
- Gateway: opcjonalne `OA_WORKER_HOST` + `OA_WORKER_PORT`; istniejący listener
  i listener mobile działają jak wcześniej, gdy tych zmiennych nie ma.
- Worker: opcjonalny `OA_WORKER_STATUS_FILE`, raportujący stan linku bez sekretów.
- Web: dotychczasowy shell wyodrębniony do `AppShell.svelte`, ekran `/desktop`
  i feature-detectowana sekcja Settings → Desktop. Normalna przeglądarka zachowuje UI.

Mobile nie musi zmieniać kontraktów ani konfiguracji. Root zmieniono tylko w `bun.lock`.

## Cykl życia i katalogi

`initdb` tworzy `userData/postgres/data` przy pierwszym uruchomieniu, z UTF-8,
locale C, użytkownikiem `canopy` i uwierzytelnianiem SCRAM na TCP. Katalog danych
i hasło nie są odnawiane przy kolejnym starcie. PostgreSQL działa jako proces
pierwszoplanowy na losowym porcie `127.0.0.1`, bez unix socketów, z limitem
40 połączeń (pula gatewaya oraz zapas dla inicjalizacji i kontroli zdrowia).
Dotyczy to również Windows; nie używamy named pipes ani poleceń powłoki do ścieżek.

Postgres sam sprawdza `postmaster.pid` po awarii i odtwarza WAL. Aplikacja nigdy
nie kasuje pliku PID w ciemno; konflikt z żywym serwerem kończy się błędem.
Niepełne `initdb` również zgłasza błąd zamiast usuwać istniejące dane.

Procesy uruchamiają się w kolejności: baza → migracje/start gatewaya → enrollment
→ worker. Lokalny BFF służy także jako ekran konfiguracji przed uruchomieniem bazy.
Gotowość sprawdzana jest przez SQL, gRPC i HTTP; potem co 5 sekund przez gRPC/HTTP.
Trzy błędy kontroli zdrowia restartują odpowiedni proces. Restart po wyjściu ma
backoff 1–30 sekund i budżet 8 prób; kod 78 workera nie jest ponawiany.

Zamykanie: worker → gateway → PostgreSQL → BFF. POSIX używa własnych grup procesów
(Postgres dostaje SIGINT, czyli fast shutdown); Windows zamyka stdin sidecarów
i wykonuje `pg_ctl stop -m fast`. Po 10 sekundach dla danej usługi następuje
wymuszone sprzątanie grupy lub `taskkill /PID <owned-pid> /T /F`. Nie ma wyszukiwania
procesów po nazwie. Kontroler otrzymuje EOF po śmierci Electron i ma 30-sekundowy
limit całego sprzątania, również podczas trwającego startu. SIGKILL całego drzewa
procesów lub awaria OS nie daje możliwości wykonania shutdown; trwałość zapewnia WAL.

Jedna baza naraz: Electron trzyma blokadę jednej instancji, a PostgreSQL odmawia startu
na katalogu danych zajętym przez żywy postmaster. Gdy kontroler zginie bez sprzątania
(`kill -9`, OOM), sidecary Bun kończą się same po EOF na stdin, ale postmaster nie obserwuje
rodzica i zostaje osierocony. Następny start (`stopOrphan` w `runtime/database.ts`) czyta PID
z `postmaster.pid` i — tylko gdy to postgres obsługujący dokładnie ten katalog (Linux
`/proc/<pid>/cmdline`, macOS `ps`, Windows `pg_ctl status`) — zatrzymuje go `pg_ctl stop -m fast`,
w razie potrzeby `-m immediate`, i dopiero wtedy uruchamia własny. Wcześniej taki start wisiał.
Pokrywa to test integracyjny „a postmaster orphaned by a killed guardian…”.

Pliki pod `userData`:

```text
secrets.enc                 # ciphertext OS keychain; 0600 na POSIX
desktop.json                # tryb/adresy; bez tokenu enrollment
postgres/data/              # pełny klaster PostgreSQL
local-worker/worker.json    # credential; 0600 na POSIX
remote-workers/<hash>/      # osobna tożsamość dla każdego gatewaya
logs/                       # redakcja sekretów; 5 MiB + 3 rotacje na usługę
```

Menu aplikacji otwiera ustawienia i katalog logów; tray pokazuje stan workera
i znalezione CLI. macOS używa hidden-inset z miejscem na traffic lights w sidebarze;
Linux i Windows zachowują natywną ramkę. Jedna instancja przypada na katalog danych.

Kopię zapasową katalogu danych wykonuj po zamknięciu aplikacji. `secrets.enc` jest
związany z magazynem kluczy użytkownika/OS; samo skopiowanie go na inny komputer
nie zapewnia możliwości odszyfrowania bazy sekretów gatewaya. Przed zmianą głównej
wersji PostgreSQL potrzebny jest eksport i jawna procedura migracji.

## Build i uruchomienie

Wymagania środowiska budującego: Bun **1.4.4**, Node **24 lub nowszy**, natywny host
zgodny z docelowym OS/arch. Aplikacja użytkownika zawiera własny Bun i PostgreSQL.
Linux potrzebuje zwykłych bibliotek Electron i odblokowanego Secret Service/KWallet;
nie stosujemy fallbacku plaintext ani `--no-sandbox`.
Narzędzie fpm do deb potrzebuje `libcrypt.so.1` (na Arch: `libxcrypt-compat`).
Do pakowania zapewnij kilka GiB wolnego miejsca w `TMPDIR`; na tej maszynie
użyto katalogu roboczego na dysku zamiast ograniczonego tmpfs `/tmp`.

Z katalogu repozytorium:

```sh
bun install
bun run --cwd apps/desktop build
bun run --cwd apps/desktop dev
```

Instalatory (wybierz polecenie na odpowiednim hoście):

```sh
bun run --cwd apps/desktop package:linux
bun run --cwd apps/desktop package:mac
bun run --cwd apps/desktop package:windows
```

`CANOPY_TARGET` opcjonalnie deklaruje cel i musi zgadzać się z hostem. Build odrzuca
cross-host, zamiast dołączyć niezgodne biblioteki sharp/SDK/Postgres. Do ponownego
pakowania już zbudowanego runtime: `bun run --cwd apps/desktop scripts/package.ts`.
Wynik jest w `apps/desktop/release/`; katalog jest ignorowany przez git.

| Cel | Host / przykład runnera GitHub Actions | Pakiet PG | Instalator | Weryfikacja tutaj |
| --- | --- | --- | --- | --- |
| Linux x64 | `ubuntu-24.04` | `linux-x64` | AppImage, deb | build + run AppImage |
| Linux arm64 | `ubuntu-24.04-arm` lub natywny self-hosted ARM64 | `linux-arm64` | AppImage, deb | niewykonana |
| macOS x64 | `macos-15-intel` lub self-hosted Intel | `darwin-x64` | dmg | niewykonana |
| macOS arm64 | `macos-15` lub self-hosted Apple Silicon | `darwin-arm64` | dmg | niewykonana |
| Windows x64 | `windows-2025` | `windows-x64` | NSIS | niewykonana |

Każdy job CI: checkout tego samego commita → instalacja Node/Bun → `bun install`
→ `package:linux`, `package:mac` albo `package:windows` → zachowanie plików z
`apps/desktop/release`. Przed budową sprawdź `process.platform/process.arch`;
host musi odpowiadać wierszowi tabeli. Brak Windows arm64 jest celowy.
Runner nie potrzebuje sekretów gatewaya ani kluczy providerów. Publikowanie
wyłączono (`--publish never`). Metadata `homepage` używa identyfikatora `canopy://desktop`;
repozytorium nie deklaruje publicznej strony produktu.

Układ zasobów jest taki sam dla każdego celu (`.exe` wyłącznie na Windows):

```text
resources/runtime/
  canopy-controller[.exe]
  canopy-gateway[.exe]
  canopy-worker[.exe]
  canopy-web[.exe]
  bun[.exe]
  postgres/{bin,lib,share}/
  web/                      # assets identycznego adapter-node build
  node_modules/             # natywne moduły i assets SDK
  licenses/
  THIRD_PARTY_NOTICES.md
  target.json
```

Źródło relokowalnych binariów: `@embedded-postgres/<platform-arch>`
**18.6.0-beta.19**, bazujące na dystrybucji Zonky. Wersja i integralność npm są
przypięte w `bun.lock`; podczas build wersja jest dodatkowo sprawdzana. Licencje
PostgreSQL, MIT opakowania, Apache-2.0 dystrybucji oraz odnośniki do bibliotek
zależnych zapisano w `apps/desktop/THIRD_PARTY_NOTICES.md` i dołączono do paczki.

macOS: do dystrybucji ustaw `CSC_LINK` / `CSC_KEY_PASSWORD` dla Developer ID
Application oraz `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
według electron-builder. Alternatywnie użyj poświadczeń API App Store Connect.
Hardened runtime jest włączony; signing musi objąć również Bun, sidecary,
binaria/biblioteki PostgreSQL i `.node` w Resources (osx-sign skanuje zawartość app).
Przed publikacją zweryfikuj `codesign --verify --deep --strict`, notarization
i stapling oraz start na czystym Intel/Apple Silicon. Windows wymaga podpisania
instalatora własnym certyfikatem. Podpisywanie i notaryzacja nie były wykonywane.

Auto-update jest poza zakresem. Miejsce podłączenia klienta aktualizacji oznaczono
w `src/main.ts` po rejestracji protokołu. Wymaga podpisanego feedu, obsługi wersji
danych PostgreSQL i osobnego sprawdzenia shutdown przed instalacją aktualizacji.

## Weryfikacja

```sh
bun test apps/desktop/test/runtime.integration.test.ts
bun run typecheck
bun run gen:check
bun run check:tmp
```

Integracja używa skompilowanych sidecarów i dołączonych binariów PostgreSQL, temp
data dirów oraz losowych portów. Obejmuje lokalny enrollment i online przez gRPC,
zdalny enrollment do testowego gatewaya, trwałość projektu/tożsamości po restarcie,
SIGKILL serwera i WAL recovery, redakcję sekretów, brak pozostałych grup procesów
oraz zamknięcie kontrolera po utracie stdin rodzica. Nie dodano testów UI.
Przed integracją wykonaj desktop build; przy braku sidecarów testy są pomijane,
aby zwykły checkout monorepo nie wymagał instalowania toolchainu Electron do testów backendu.

Smoke okna jest wykonywany lokalnie przez Playwright/CDP na Xvfb z aktywnym
sandboxem i prawdziwym OS keychain. Zrzuty w `artifacts/desktop/` przedstawiają
wspólny web shell w jasnym/ciemnym motywie oraz ekran pierwszego uruchomienia.
Skrypt browserowy jest roboczą weryfikacją i nie jest częścią repozytorium.
Wyniki końcowych kontroli i smoke są zapisane razem ze zrzutami.
Wykonany smoke AppImage potwierdził także zakończenie procesu Electron i czyste
zamknięcie PostgreSQL. Pełny `check:tmp`: **629 pass, 144 skip, 0 fail**, bez
pozostałych katalogów testowych. Szczegóły: [dowody weryfikacji](../artifacts/desktop/verification.md).

Nie zweryfikowano tutaj innych OS/arch, podpisywania, interfejsu sieciowego
udostępnionego innym komputerom ani rzeczywistych tur płatnych providerów. Znalezienie
CLI i obecność workera online nie potwierdzają autoryzacji konkretnego providera.

Źródła sprawdzone podczas implementacji: dokumentacja Electron
[security](https://www.electronjs.org/docs/latest/tutorial/security),
[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage),
[electron-builder](https://www.electron.build/configuration.html), rejestr npm
(Electron 45.2.1, electron-builder 26.18.0, binaria PostgreSQL 18.6.0-beta.19).

## Uprawnienia wykonania

Zakres: implementacja i lokalne commity według jawnego zlecenia, bez push/PR.
`workflow_mode: direct`, `mode_source: explicit-user-task-instruction`,
`decision_authority: delegated`, `scope: current-task`, `artifact_state: not-required`,
`execution_mode: inline`. Ograniczenia chronione: brak zmian produkcji, Tailscale,
portów 17443/17444/5180/8444 i `/tmp/oa-stack`; brak odczytu sekretów dev-live.
