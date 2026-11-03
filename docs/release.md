# Wydania: wersje, CI, artefakty

Jedna wersja dla wszystkich aplikacji (gateway, worker, web, desktop). Wersję wyznacza
semantic-release z commitów Angular po squash merge. Wdrożenie: [deploy.md](deploy.md).
Zasady commitów i wybór gałęzi: [contributing.md](contributing.md).

Nagłówek sidebara oznacza **uruchomiony build**: Beta (bursztyn), Nightly (fiolet),
lokalny checkout Dev (neutralny). Stable zachowuje zwykły nagłówek bez koloru, wzoru i etykiety.
Delikatne kontury słojów drzewa dla pozostałych kanałów
nawiązują do Canopy; nazwa kanału pozostaje czytelna również bez rozróżniania kolorów.
Oznaczenie wynika z `CANOPY_VERSION`, nie z wybranego kanału przyszłej aktualizacji.
Wersja jest w podpowiedzi nagłówka i Settings; ten sam nagłówek działa w drawerze mobilnym.

## Schemat wersji

| Build | Wersja (`CANOPY_VERSION`) | Kanał | GitHub Release | Tagi obrazów Docker |
| --- | --- | --- | --- | --- |
| `main` | `X.Y.Z` | `stable` | wydanie `vX.Y.Z` | `vX.Y.Z`, `vX.Y`, `vX`, `latest`, `stable` |
| `next` | `X.Y.Z-beta.N` | `beta` | pre-release `vX.Y.Z-beta.N` | `vX.Y.Z-beta.N`, `beta` |
| `dev` | `X.Y.Z-nightly.N` | `nightly` | pre-release `vX.Y.Z-nightly.N` | `vX.Y.Z-nightly.N`, `nightly` |

- Startujemy od **0.1.0**. `feat` zwiększa minor; `fix`/`perf` i rozpoznany revert — patch.
  Pozostałe typy bez `BREAKING CHANGE` nie publikują wydania. W 0.x breaking zwiększa minor, np. 0.1.0 → 0.2.0;
  od 1.0.0 zwiększa major. Wrapper `release-analyzer.mjs` przekazuje odpowiednie `releaseRules`
  do `@semantic-release/commit-analyzer` na podstawie ostatniej wersji. Przejście na 1.0.0
  jest świadomą decyzją maintainera i wymaga osobnej zmiany polityki/wyznaczenia tego wydania.
- `release.config.mjs`: Angular analyzer, Angular release notes i `@semantic-release/github`.
  Nie używamy `@semantic-release/git`, npm publish ani commitowanego CHANGELOG-a. Notatki są
  w GitHub Releases; bot nie dopisuje commitów wersji, więc promocje zachowują wspólną historię.
- **`latest` oznacza teraz najnowsze stable.** Nie powstaje rolling GitHub pre-release `latest`,
  tag `latest` ani obrazy `sha-*`. Tagi wersji pozostają niezmienne. Nie publikujemy poprawek
  starszych linii po nowszym stable bez osobnej polityki obsługi aliasów Docker.
- Updater: `stable` wybiera najwyższe stabilne semver; `beta` najwyższe stable/beta;
  `nightly` najwyższe ze wszystkich wydań. Piny `vX`, `vX.Y`, `vX.Y.Z` wybierają tylko stable.
  Starsze ustawienie `latest` jest zapisywane jako `stable` przy starcie gatewaya.
- Samo utworzenie gałęzi na istniejącym tagu i merge `docs:` nie publikuje nowej wersji.
  `scripts/semantic-release.mjs` blokuje automatyczne pierwsze wydanie przed tagiem bootstrap.

`scripts/version.ts` liczy wszystko lokalnie i w CI:

```sh
bun scripts/version.ts                 # JSON: version, channel, releaseTag, prerelease, commit, shortSha, dockerTags
bun scripts/version.ts --field version # jedno pole
bun scripts/version.ts --github-output # klucze do $GITHUB_OUTPUT
```

W CI wszystkie buildy dostają dokładną wersję wyjściową semantic-release. Lokalnie skrypt czyta
tag na HEAD; bez niego zwraca niepublikowaną wersję `X.Y.Z-dev.<sha7>` i pustą listę tagów Docker.

## Wstrzykiwanie wersji

Stała `CANOPY_VERSION` z `@canopy/domain/release/version` czyta `process.env.CANOPY_VERSION`
(zapis z kropką, aby bundlery mogły go podmienić); uruchomienie ze źródeł pokazuje `0.0.0-dev`.

- binaria: `bun build --compile --define process.env.CANOPY_VERSION="…"` (`scripts/build-binaries.ts`),
- obrazy: `ARG`/`ENV CANOPY_VERSION` + etykiety OCI `org.opencontainers.image.version/revision/source`,
- web: Vite `define` (`apps/web/vite.config.ts`); widoczna w **Settings** (dół nawigacji) i w `GET /api/health`,
- desktop: `CANOPY_VERSION` → `-c.extraMetadata.version` (wersja aplikacji Electron, nazwy plików, `Version` deb)
  i `define` w sidecarach (`apps/desktop/scripts/build.ts`),
- worker zgłasza ją gatewayowi w `Hello.host.worker_version` (kolumna `workers.version`),
- `canopy-gateway --version`, `canopy-worker --version`.

## Artefakty

### Binaria gateway i worker

```sh
bun scripts/build-binaries.ts                       # host → dist/release/canopy-{gateway,worker}-<os>-<arch>
bun scripts/build-binaries.ts --target all          # linux/darwin × x64/arm64 + windows-x64 (cross-compile)
bun scripts/build-binaries.ts --app worker --target linux-arm64 --outdir /tmp/out
```

Nazwy: `canopy-<gateway|worker>-<linux|darwin|windows>-<x64|arm64>`, `.exe` na Windows,
bez kompresji. Zawartość:

- cały JavaScript zbundlowany; migracje SQL to importy tekstowe (`packages/db`), kontrakty proto
  to wygenerowany TS — nic nie jest czytane z dysku w runtime,
- **sharp** (jedyny natywny moduł) osadzony razem z libvips dla danego celu. Przy starcie pliki
  trafiają do `CANOPY_NATIVE_DIR`, domyślnie `~/.cache/canopy/native/<hash>` (macOS
  `~/Library/Caches/…`, Windows `%LOCALAPPDATA%\canopy\native`), z układem katalogów
  zachowującym rpath sharp; przy braku zapisu — unikalny katalog w `TMPDIR`.
  Pakiety sharp innych platform pobierane są z rejestru npm i weryfikowane `dist.integrity`
  (cache w `.tmp/release-native`),
- worker uruchamia CLI agentów (`claude`, `codex`, `grok`) z `PATH` (albo ścieżek z konfiguracji);
  nie są częścią binarki. Claude Agent SDK jest zbundlowany jako JS i dostaje ścieżkę `claude`.

Rozmiary (Bun 1.4.4, 0.0.0-main): linux-x64 124 MiB, linux-arm64 124 MiB,
darwin-arm64 105 MiB, windows-x64 131 MiB (ok. 95 MiB to runtime Bun, 18 MiB libvips).

### Obrazy Docker

Jeden `Dockerfile` (kontekst: root repozytorium), cele `gateway`, `web`, `worker`:

```sh
V=$(bun scripts/version.ts --field version)
docker buildx build --target gateway --build-arg CANOPY_VERSION=$V --build-arg CANOPY_REVISION=$(git rev-parse HEAD) \
  --platform linux/amd64,linux/arm64 -t ghcr.io/itsoltech/canopy-gateway:dev .
```

| Obraz | Baza | Zawartość | Użytkownik | Healthcheck |
| --- | --- | --- | --- | --- |
| `canopy-gateway` | `distroless/cc-debian12:nonroot` | binarka gateway | `nonroot` | `canopy-gateway healthcheck` (TCP na `CANOPY_PORT`) |
| `canopy-web` | `oven/bun:1.4.4-distroless` | `scripts/build-web.ts`: BFF zbundlowany z zależnościami + `client/` | 65532 | `GET /api/health` |
| `canopy-worker` | `debian:bookworm-slim` + git, curl, ssh, tini | binarka worker | `canopy` (10001) | `canopy-worker healthcheck` (link online wg `CANOPY_WORKER_STATUS_FILE`) |


Wszystkie zmienne runtime mają prefiks `CANOPY_`.

Kompilacja zawsze na `BUILDPLATFORM` (cross-compile), więc arm64 nie wymaga emulacji poza
`apt-get` w obrazie workera.

### Desktop

`bun run --cwd apps/desktop package:<linux|mac|windows>` na hoście danego OS/arch
([desktop.md](desktop.md)). Z `CANOPY_VERSION` pliki nazywają się
`Canopy-<wersja>-<linux|darwin|windows>-<x64|arm64>.<AppImage|deb|dmg|zip|exe>`.
Jedna aplikacja `app.canopy.desktop` / Canopy współdzieli userData i `canopy://`.
Kanał wybiera się lokalnie w Settings → App updates; domyślnie odpowiada buildowi.
To niezależna preferencja od polityki aktualizacji gatewaya/workera.
Stare Canopy Beta/Nightly wymagają jednorazowej ręcznej instalacji Canopy — Squirrel
nie aktualizuje między różnymi bundle ID. [Migracja](desktop.md#przejście-ze-starych-canopy-beta--canopy-nightly)
nie usuwa ani nie importuje starych danych.
Desktop publikuje też feedy electron-updater i pliki `.blockmap`. Feedy z runnerów są scalane
przed uploadem i sprawdzane względem SHA-512 assetów. Skrypt merge tworzy aliasy:
stable → latest/beta/nightly, beta → beta/nightly, nightly → nightly, dla każdej platformy.
Wszystkie wskazują na jeden zestaw instalatorów tego release. Stable widzi tylko stable,
Beta także beta, Nightly wszystkie trzy; najwyższy SemVer wygrywa. Brak rollbacku
bez jednorazowej zgody na stabilniejszy kanał. Manifest nadal oznacza instalatory
`app: desktop`; feedy/blockmapy są w checksumach. ZIP i blockmapy macOS pozostają
wymagane; niepodpisane/ad-hoc macOS nie emituje feedu.
macOS: tylko Apple Silicon (arm64);
wersji Intel (darwin-x64) nie budujemy — ani desktopu, ani binarek gatewaya/workera.

### checksums.txt i manifest.json

`bun scripts/release-manifest.ts <katalog>` liczy z assetów w katalogu (odrzuca nieznane nazwy):

Wymaga tagu wydania na HEAD albo jawnych `CANOPY_VERSION` i `CANOPY_RELEASE_TAG`.
Kanał wynika z tagu; sprzeczny `CANOPY_CHANNEL` lub numer wersji zatrzymuje publikację.

- `checksums.txt`: linie `sha256  nazwa` dla wszystkich assetów (bez samych `checksums.txt`/`manifest.json`),
- `manifest.json`:

```json
{
  "schema": 1,
  "version": "1.2.3",
  "channel": "stable",
  "commit": "<sha>",
  "published_at": "<iso>",
  "protocol": { "worker_link": 1, "update": 1 },
  "assets": [
    { "app": "worker", "os": "linux", "arch": "x64", "name": "canopy-worker-linux-x64",
      "url": "https://github.com/itsoltech/canopy/releases/download/v1.2.3/canopy-worker-linux-x64",
      "sha256": "…", "size": 130504984 }
  ]
}
```

`protocol.worker_link` / `protocol.update` to `WORKER_LINK_PROTOCOL` / `UPDATE_PROTOCOL`
z `packages/domain/src/release/protocol.ts`, jeśli plik istnieje; inaczej `1`.
Assety desktop mają `app: "desktop"` (kilka formatów na jedną parę os/arch).
Feedy `latest*.yml`, `beta*.yml`, `nightly*.yml` i blockmapy nie wchodzą do tablicy
`manifest.assets`, bo nie mają pojedynczego os/arch. Obejmuje je `checksums.txt`.
Format manifestu i zamrożony protokół aktualizacji gatewaya/workera pozostają bez zmian.

## Workflowy GitHub Actions

`.github/workflows/ci.yml` (pull requesty; wywoływany też przez Release):
`bun install --frozen-lockfile` → `gen:check` → `typecheck` → `check:tmp` (testy jednostkowe
i integracyjne; PostgreSQL w kontenerach Docker runnera) → build web → binaria linux-x64
z kontrolą `--version`. Testy live są opt-in (`CANOPY_LIVE`, prywatne klucze) i nie mają sekretów w CI.

`.github/workflows/release.yml` (push do `main`/`next`/`dev`, ręczne stabilne tagi `vX.Y.Z`,
oraz dispatch po promocji/back-merge):

| Job | Co robi | Blokuje publikację |
| --- | --- | --- |
| `checks` | `ci.yml` | tak, także przed semantic-release |
| `semantic-release` | pełna historia, GITHUB_TOKEN; wyjścia `published`, `version`, `tag`, `channel` | buildy wyłącznie dla `published=true` |
| `binaries` | cross-compile wszystkich celów | tak |
| `smoke` | `--version` każdej binarki na jej OS/arch (ładuje osadzony sharp) | tak |
| `desktop` | wszystkie kanały: Linux, macOS (Apple Silicon), Windows; linux-arm64/Windows eksperymentalne | linux-x64 i macOS arm64, także kontrola podpisów |
| `images` | buildx amd64+arm64, GHCR, SBOM, cache GHA | wymagany przed manifestem |
| `publish` | sumy, manifest z kanałem stable/beta/nightly, upload do istniejącego release | manifest na końcu |

semantic-release tworzy tag i GitHub Release (beta/nightly jako prerelease), po czym ten sam
przebieg buduje i wgrywa assety. Tag utworzony przez `GITHUB_TOKEN` nie uruchamia nowego workflow.
Resolver pomija release bez `manifest.json`, więc nie wybiera nieukończonego buildu.
Po błędzie buildów użyj **Re-run failed jobs**, zachowując wyjścia joba semantic-release;
ponowienie całego workflow może zakończyć się „no release”, bo tag już istnieje.
Ręczny stabilny tag musi należeć do historii `main`; ścieżka tagowa tworzy release przy uploadzie.

Podpisywanie desktop jest warunkowe: bez certyfikatu macOS otrzymuje podpis ad-hoc,
Windows pozostaje niepodpisany. Konfiguracja certyfikatu macOS włącza obowiązkowy signing,
a kompletny zestaw notaryzacji włącza wbudowane `mac.notarize` i stapling przed zip/dmg.
Kontrola CI sprawdza app przez `codesign --verify --deep --strict`, każdy runtime Mach-O
oddzielnie, Developer ID przez requirement i `spctl -a -vv` dla podpisanych buildów.
Notaryzowany build musi przejść Gatekeeper i `xcrun stapler validate`.
Bez notaryzacji odmowa `spctl` jest oczekiwana i raportowana; sam podpis musi być poprawny.

### Sekrety podpisywania desktop

Sekrety dodaje maintainer do GitHub → Settings → Secrets and variables → Actions
(repository secrets). Nic nie trafia do kodu, gatewaya, workera ani renderera.
Do pobierania publicznych aktualizacji aplikacja nie potrzebuje tokena GitHub.

1. Dołącz do **Apple Developer Program** i zaakceptuj aktualne umowy Apple.
   Na Macu w Keychain Access utwórz Certificate Signing Request, a w Apple Developer
   → Certificates, Identifiers & Profiles utwórz **Developer ID Application**.
   To certyfikat dystrybucji poza App Store; nie wybieraj Developer ID Installer
   ani Apple Distribution. Tworzenie może wymagać roli Account Holder lub uprawnienia
   do certyfikatów Developer ID. Zainstaluj pobrany certyfikat w pęku z kluczem prywatnym.
2. W Keychain Access → My Certificates wyeksportuj certyfikat **razem z kluczem prywatnym**
   jako `.p12`, zabezpiecz hasłem. Zakoduj plik do base64 (jedna linia, np.
   `base64 -i /secure/DeveloperID.p12 | tr -d '\n' > /secure/DeveloperID.p12.base64`).
   Sekrety `MAC_CSC_LINK` i `MAC_CSC_KEY_PASSWORD` przechowują odpowiednio base64 i hasło.
   Workflow mapuje je na `CSC_LINK` / `CSC_KEY_PASSWORD` electron-buildera.
3. Preferowana notaryzacja: App Store Connect → Users and Access → Integrations
   → App Store Connect API → Team Keys. Account Holder może najpierw zatwierdzić dostęp API.
   Utwórz klucz zespołowy z rolą **App Manager**, pobierz `.p8` (tylko raz), zapisz
   Key ID i Issuer ID. `APPLE_API_KEY` przechowuje **base64 zawartości `.p8`**, nie ścieżkę;
   `APPLE_API_KEY_ID` i `APPLE_API_ISSUER` identyfikatory. Na runnerze `.p8` jest dekodowany
   poza repozytorium z uprawnieniami 0600, przekazywany Apple jako ścieżka i usuwany po jobie.
4. Alternatywnie użyj Apple ID z dostępem do zespołu: `APPLE_ID`, app-specific password
   wygenerowane na account.apple.com → Sign-In and Security (`APPLE_APP_SPECIFIC_PASSWORD`)
   oraz Team ID z Apple Developer Membership (`APPLE_TEAM_ID`). Nie używaj zwykłego hasła
   konta. Pełny zestaw API ma pierwszeństwo; Apple ID nie jest wtedy przekazywane do buildera.
5. Opcjonalne podpisywanie Windows pozostaje przy `WIN_CSC_LINK` i `WIN_CSC_KEY_PASSWORD`.
   Bez tych sekretów NSIS jest niepodpisany i może pokazać SmartScreen.

Dokładna lista sekretów (wartości wprowadzaj przez bezpieczny prompt `gh`, nigdy do repo):

```sh
# Obowiązkowe dla Developer ID; gh odczyta base64 z bezpiecznie przechowanego pliku.
gh secret set MAC_CSC_LINK < /secure/DeveloperID.p12.base64
gh secret set MAC_CSC_KEY_PASSWORD

# Preferowany komplet notaryzacji — trzy sekrety.
gh secret set APPLE_API_KEY < /secure/AuthKey.p8.base64
gh secret set APPLE_API_KEY_ID
gh secret set APPLE_API_ISSUER

# Alternatywny komplet notaryzacji — zamiast powyższego.
gh secret set APPLE_ID
gh secret set APPLE_APP_SPECIFIC_PASSWORD
gh secret set APPLE_TEAM_ID

# Opcjonalnie Windows, bez zmiany istniejącego mechanizmu.
gh secret set WIN_CSC_LINK
gh secret set WIN_CSC_KEY_PASSWORD
```

`AuthKey.p8.base64` przygotuj tak samo jak `.p12`, z pliku `.p8`. Do pełnej dystrybucji
macOS potrzeba **2 sekretów certyfikatu + jednego pełnego kompletu 3 sekretów notaryzacji**.
Brak sekretów daje ad-hoc; sam certyfikat daje Developer ID bez notaryzacji.
Niepełny komplet notaryzacji nie uruchamia wysyłki do Apple i jest widoczny w logu joba.
Błąd kompletnych poświadczeń przerywa build zamiast publikować po cichu gorszy wariant.

Gatekeeper dla Developer ID + notarization + staple pokazuje standardowe potwierdzenie
pobrania aplikacji z Internetu. Bez notaryzacji lub przy ad-hoc blokuje uruchomienie
i może wymagać Privacy & Security → Open Anyway albo usunięcia quarantine po weryfikacji
źródła. Stare niepodpisane 0.1.0 na Apple Silicon może zgłaszać „damaged”. Ad-hoc naprawia
brak podpisu maszynowego, ale nie nadaje zaufania Apple i nie gwarantuje konkretnego tekstu
dialogu na każdej wersji macOS. Szczegółowa tabela i lokalne obejście:
[desktop.md](desktop.md#podpisywanie-macos-i-gatekeeper).

### Pierwszy przebieg CI na macOS

1. Na runnerze Apple Silicon sprawdź liczbę runtime Mach-O w logu,
   użycie Developer ID Application, powodzenie notaryzacji/staplingu oraz krok
   `Verify macOS signatures and notarization`. Te joby blokują publikację we wszystkich kanałach.
2. Pobierz dmg i zip z GitHuba na czystego Maca z quarantine. Uruchom app bez `xattr`,
   sprawdź lokalny start PostgreSQL, gatewaya, workera i web oraz zamknięcie procesów.
   Sprawdź `codesign -d --entitlements :-` dla app, helpera i skompilowanego Bun sidecara.
3. Potwierdź jedną `Canopy.app`, `app.canopy.desktop`, wspólne userData i `canopy://`.
   Przełącz stable → beta → nightly i sprawdź wersję/kanał buildu po restarcie.
   Stare Canopy Beta/Nightly, w tym 0.2.0-nightly.2, zastąp ręcznie; zachowaj ich dane.
4. W release sprawdź wymagane aliasy `*-mac.yml`: każdy musi wymieniać ZIP arm64
   (po dodaniu x64 także ZIP tej architektury).
   Feedy i blockmapy są uploadowane przed końcowym `manifest.json`; prerelease muszą
   pozostać oznaczone jako prerelease. Stary klient bez updatera wymaga instalacji ręcznej.
5. Sprawdź pobieranie, postęp, „Restart to update”, czysty shutdown i zachowanie danych.
   Beta powinna przyjąć nowsze stable, Stable nigdy prerelease. Na kopii danych sprawdź
   Cancel i zgodę przy nightly → beta/stable oraz beta → stable; po próbie i ponownym
   starcie brak dalszych downgrade'ów. Zweryfikuj Squirrel i ten sam Developer ID oraz
   designated requirement. Osobno build ad-hoc: „Updates need a signed build”.

Podpisywania, polityki Gatekeepera, ticketów Apple i rzeczywistej instalacji aktualizacji
nie da się potwierdzić na Linuxie; walidacja konfiguracji buildera tego nie zastępuje.

## Promocja i okres stabilizacji („burn-in”)

Nightly powstaje po każdej zmianie `feat`/`fix`/`perf` na `dev` (zmiany bez wpływu na wersję
nie publikują buildu). Beta to wybrany nightly; stable to beta po okresie obserwacji.
Promocja przebudowuje ten sam commit z nowym numerem wersji, nie kopiuje binariów między kanałami.

1. **dev → next:** maintainer wybiera HEAD z opublikowanym tagiem nightly; CI i live smoke
   muszą być zielone, bez otwartych issue `release-blocker`. Uruchamia **Promote**, `dev-next`,
   zaznaczając `live_smoke`. Jeśli `dev` ma już nowsze commity, najpierw wybiera odpowiedni
   moment promocji; workflow celowo wymaga tagu na HEAD i nie przesuwa `dev` wstecz.
2. **next → main:** beta na HEAD musi mieć gotowy manifest od co najmniej `burn_in_days`
   (domyślnie **3 dni**); brak issue `release-blocker`, ostatni przebieg Release na HEAD zielony,
   live smoke i aktualizacja gatewaya/workera z rollbackiem sprawdzone. Maintainer uruchamia
   **Promote**, `next-main`, zaznaczając oba potwierdzenia smoke.
3. Workflow sprawdza, czy target jest przodkiem source; robi zwykły push fast-forward
   `<src-sha>:refs/heads/<target>` bez `--force`. Rozjechana historia lub zmiana targetu zatrzymuje
   promocję. Po pushu jawnie dispatchuje Release na target, bo `GITHUB_TOKEN` nie uruchamia
   workflow od swojego pushu. `expected_sha` chroni przed wydaniem późniejszego commita.
4. Co poniedziałek **Promotion review** tworzy/aktualizuje issue
   „Promote next → main (beta X)” z listą kontrolną i linkiem do Promote, gdy warunki automatyczne
   są spełnione. `BETA_BURN_IN_DAYS` ustala próg przypomnienia (domyślnie 3). Stable zawsze wymaga
   decyzji maintainera. Opcjonalne `AUTO_PROMOTE_DEV_TO_NEXT=true` włącza promocję do beta podczas
   tego przeglądu; wymaga też `NIGHTLY_SMOKE_SHA` równemu HEAD dev, ustawionego po zewnętrznym
   live smoke. Nie kopiuj starego potwierdzenia smoke dla nowego SHA.
5. Po stable **Back-merge** przenosi hotfix `main` → `next` → `dev` commitami merge bota,
   dispatchując CI/Release dla zmienionych gałęzi. Dla promocji bez rozbieżności jest to no-op.
   Przy konflikcie otwiera PR i zatrzymuje dalsze przenoszenie. Po rozwiązaniu konfliktu i squash
   merge PR uruchom Back-merge ponownie: dopisze merge commit przywracający relację przodków.

Nowy commit w `next` zeruje obserwację dopiero po wydaniu kolejnej bety i ukończeniu jej assetów.
Workflow nie uznaje ręcznych potwierdzeń smoke za automatyczne testy; maintainer odpowiada za
ich prawdziwość. Docs-only HEAD bez nowego tagu nie jest kandydatem promocji.

## Retencja nightly

**Nightly hygiene** po publikacji nightly i codziennie zachowuje 10 najnowszych ukończonych
GitHub prereleases nightly. Pozostawia tagi git i notes semantic-release: są potrzebne do
numeracji oraz historii kanałów. Cache gatewaya zachowuje manifest/binarie jego wersji.
Starszy nightly na zimnym cache może wymagać ręcznego przejścia na zachowany release.

Starych tagów obrazów GHCR automatycznie nie usuwamy. API usuwa wersję pakietu/digest,
który może mieć wspólne aliasy (`nightly`) i manifesty wielu architektur; bez osobnej polityki
nie można bezpiecznie usuwać wyłącznie tagu. Administrator może okresowo usuwać stare wersje
złożone wyłącznie z tagów `v*-nightly.*`, po sprawdzeniu, że żaden aktualny alias ani manifest
ich nie wskazuje. Stable i beta nie podlegają retencji nightly.

## Ustawienia repozytorium (stosuje maintainer/rodzic)

- Feature PR: wyłącznie **squash merge**, tytuł PR jest tytułem commita. Wymagane checki:
  `commitlint` (workflow PR title) i CI. Stopka `BREAKING CHANGE` musi zostać w body squasha.
- Promocje są pushami **fast-forward**, back-merge bezpośrednimi commitami merge bota — nie
  korzystają z przycisku merge PR. Reguły ochrony `dev`/`next`/`main` muszą pozwalać GitHub Actions
  botowi na te operacje i zapis tagów/notes. Nie wymagaj linear history dla back-merge.
- Actions: joby żądają `contents: write`, `packages: write`, `actions: write`, `issues: write`
  lub `pull-requests: write` według potrzeby. Włącz „Allow GitHub Actions to create and approve
  pull requests” dla PR konfliktowych. Utwórz etykietę **release-blocker**. Proponowana gałąź
  domyślna: **dev** (również dla workflowów schedule/dispatch).
- Pierwszy push tworzy pakiety GHCR prywatne: w ustawieniach pakietów `canopy-gateway`,
  `canopy-web`, `canopy-worker` ustaw **Public** (albo daj dostęp konkretnym użytkownikom)
  i połącz je z repozytorium (etykieta `org.opencontainers.image.source` robi to automatycznie).
  Runnery `ubuntu-24.04-arm`, `macos-15`, `windows-2025` muszą być dostępne.
- GitHub „immutable releases” pozostaw wyłączone: semantic-release publikuje release przed
  uploadem assetów; upload i retencja wymagają możliwości ich późniejszej zmiany/usunięcia.

## Bootstrap 0.1.0 — wykonuje rodzic

1. Po zielonym PR scal tę zmianę do `main` i pobierz jego HEAD. Przed pierwszym stabilnym tagiem
   push main kończy się „no release” (guard bootstrap), nawet jeśli squash ma typ `feat`.
2. Na HEAD main utwórz `git tag -a v0.1.0 -m 'Canopy 0.1.0'`, potem
   `git push origin main v0.1.0`. Tylko przebieg tagowy publikuje **0.1.0 stable**; przebieg main
   widzi tag na HEAD i brak nowych commitów. CI, wszystkie binaria/smoke, desktop i obrazy muszą
   przejść przed uploadem manifestu. Sprawdź `v0.1.0/manifest.json` i publiczną widoczność GHCR.
3. Utwórz `git branch next v0.1.0` oraz `git branch dev v0.1.0`; wykonaj
   `git push origin next dev`. Obie gałęzie kończą się **no release** aż do nowych commitów
   wpływających na wersję. Nie twórz tagów beta/nightly ręcznie.
4. Ustaw domyślną gałąź `dev`, ustawienia opisane wyżej i ewentualne zmienne promocji.
5. Przykładowy dalszy cykl: `feat` do dev → **0.2.0-nightly.1**; Promote dev-next →
   **0.2.0-beta.1**; po 3 dniach i smoke Promote next-main → **0.2.0**. Hotfix `fix` do main
   po 0.1.0 → **0.1.1** i back-merge; sam `docs` bez breaking → **no release**.

## Weryfikacja kanałów

`bun test scripts/release.test.ts` tworzy lokalny bare origin i jego klon z tagiem `v0.1.0`.
Uruchamia w klonie **`bunx --no-install semantic-release --dry-run --no-ci`**, z rzeczywistą
konfiguracją i wyłączonym wyłącznie pluginem GitHub (brak tokena/publikacji do GitHuba).
Origin używa `file://`, aby generator notatek miał poprawny URL. Sprawdza brak wydania na
main/next/dev, feat → 0.2.0 / 0.2.0-beta.1 / 0.2.0-nightly.1 oraz breaking w 0.x i po 1.0.0.
Osobny test publikuje wyłącznie do tego lokalnego bare origin, sprawdzając pełen cykl promocji
nightly → beta → stable i brak wydania po docs-only. Fixture nie tworzy tagów w repozytorium roboczym.
Testy updatera używają lokalnego fixture HTTP
z prereleases, paginacją i manifestami. Pełna publikacja wymaga uruchomienia workflow na GitHubie.

Weryfikacja implementacji kanałów lokalnie (2026-11-03):

| Sprawdzenie | Wynik |
| --- | --- |
| `bun install` i `bun install --frozen-lockfile` | OK; hook commit-msg zainstalowany |
| `mise exec actionlint@1.7.12 shellcheck@0.11.0 -- actionlint` | bez uwag |
| `bun run typecheck`, `bun run gen:check` | OK; Svelte bez błędów i ostrzeżeń; brak zmian wygenerowanego kodu |
| `bun run check:tmp` | 654 pass, 147 skip, 0 fail; czysty katalog tymczasowy |
| `bun test scripts/release.test.ts` po dodaniu walidacji manifestu | 5 pass, 0 fail; dodatkowy test manifestu po pełnym przebiegu |
| hook `feat(web): …` / `Web: …` | poprawny przyjęty, niepoprawny odrzucony |
| `CANOPY_VERSION=0.2.0-nightly.1 bun scripts/build-web.ts` | OK, także po zmianie stable na neutralny |

Nie uruchamiano publikacji GitHub/GHCR, workflowów promocji na repo zdalnym ani testów live/E2E.
Nie wykonywano pushu do GitHuba ani tagów w repozytorium roboczym. Dodatkowy podgląd nagłówków
był statyczną prezentacją wyglądu, nie testem przeglądarkowym aplikacji.

## Historyczna weryfikacja artefaktów przed kanałami (2026-11-03)

- `bun scripts/build-binaries.ts --target all`: 10 binariów (rozmiary wyżej), `manifest.json` +
  `checksums.txt` z `release-manifest.ts`.
- linux-x64: gateway na czystym PostgreSQL 17 (Docker) — 42 migracje, `healthcheck` = 0;
  worker `enroll` tokenem z `CreateWorkerEnrollment`, połączenie, katalog modeli Claude/Codex
  z CLI na `PATH`, gateway zapisał `version` workera; `healthcheck` = 0. Osadzony sharp:
  resize PNG w skompilowanej binarce, ekstrakcja do cache i fallback do `TMPDIR`.
- linux-arm64: binarka z sharp uruchomiona w kontenerze arm64 (QEMU).
- Obrazy amd64: gateway 231 MB, web 199 MB, worker 456 MB (arm64: 242/211/483 MB);
  wszystkie `healthy`; web → gateway (SSR, `/api/overview`, assety), worker w kontenerze
  zenrollowany i online. `deploy/docker-compose.yml` z tymi obrazami: wszystkie usługi `healthy`.
- Desktop linux-x64 z `CANOPY_VERSION`: `Canopy-0.0.0-main.39d8c55-linux-x64.AppImage` (603 MB)
  i `.deb` (482 MB, `Version: 0.0.0~main.39d8c55`; deb zbudowany w kontenerze `node:24-bookworm`,
  bo fpm electron-buildera potrzebuje `libcrypt.so.1`), sidecary zgłaszają tę wersję.
- `actionlint` 1.7.12 z shellcheck 0.11.0: bez uwag.

Nie zweryfikowano lokalnie: binarek darwin/windows (sprawdza je job `smoke`), desktop poza
linux-x64, samych workflowów na GitHubie, push do GHCR i `gh release`.
