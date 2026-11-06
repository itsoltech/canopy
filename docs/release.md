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
| `canopy-gateway` | `debian:bookworm-slim` + git, ca-certificates, libstdc++6 | binarka gateway; Git do źródeł skilli | `canopy` (65532), HOME `/home/canopy` | `canopy-gateway healthcheck` (TCP na `CANOPY_PORT`) |
| `canopy-web` | `oven/bun:1.4.4-distroless` | `scripts/build-web.ts`: BFF zbundlowany z zależnościami + `client/` | 65532, HOME `/home/canopy` | `GET /api/health` |
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
Release dostaje oba pliki dwukrotnie: najpierw z samymi binariami (`publish-server`), potem
przeliczone z assetami desktop (`publish-desktop`); wpisy serwerowe w obu wersjach są identyczne.

## Workflowy GitHub Actions

`.github/workflows/ci.yml` (pull requesty; wywoływany też przez Release) uruchamia równolegle:

- `static`: `gen:check`, `typecheck`, lint, format i kontrolę podziału plików testowych;
- cztery joby `tests`: każdy uruchamia własne `check:tmp`, JUnit i pomiar czasu plików;
- `builds`: build web i binaria linux-x64 z kontrolą `--version`.

Końcowy job **Typecheck, tests, builds** wymaga powodzenia wszystkich wybranych części.
Pobiera też raporty shardów i sprawdza, czy każdy plik testowy wystąpił dokładnie raz.
PR zmieniający wyłącznie Markdown lub obrazy dokumentacji w `docs/` (PNG/JPEG/WebP/GIF/SVG)
pomija testy i buildy; statyczne checki nadal działają.

`.github/workflows/pages.yml` (push do `dev` zmieniający `site/`, `scripts/build-site.ts` albo
`packages/domain/src/oauth-return.ts`; ręczny dispatch) buduje `site/` skryptem
`scripts/build-site.ts` do `dist/site` i publikuje go `actions/deploy-pages`. Strona
przekierowania OAuth trafia pod `https://itsoltech.github.io/canopy/oauth/callback`
([konektory](connectors.md#stały-redirect-zarejestrowanych-aplikacji)).
Zmiany `.github/**` zawsze wymagają całości, również przy rozszerzeniu `.md`.
Porównanie obejmuje oba końce rename; błąd odczytu zmian nie daje zielonego wyniku.
Release z zaplanowanym nightly oraz przebiegi `main`/`next`/tagowe uruchamiają cały zestaw.
Nightly bez wydania pomija CI. Testy live są opt-in (`CANOPY_LIVE`, prywatne klucze)
i nie mają sekretów w CI. Nowy push do PR anuluje cały stary CI, łącznie z shardami;
wywołania z Release mają osobne grupy (`run_id`). Bun, cache pakietów i zamrożona instalacja
są we wspólnej akcji `.github/actions/setup-bun`.

`scripts/test-shards.ts` przypisuje najdłuższe pliki do najmniej obciążonego sharda,
z deterministycznym rozstrzyganiem remisów i jawną listą ścieżek dla Bun.
`scripts/test-timings.json` zawiera zmierzone czasy całych plików w milisekundach,
łącznie z hookami; nowy plik dostaje domyślnie 1000 ms i automatycznie trafia do podziału.
Lokalnie ten sam zestaw uruchamia się przez `bun scripts/test-shards.ts 1` (analogicznie 2–4).
`--check` kontroluje podział, a `--verify-reports <katalog>` sprawdza cztery raporty
`timings-1.json` … `timings-4.json`. Raporty JUnit i natywne pomiary Bun są artefaktami CI
`test-profile-<numer>` (7 dni). Do odświeżenia wag scal mapy `files` z czterech raportów;
nie używaj raportu jednego sharda jako całej mapy.

`check:tmp` zarządza jednym PostgreSQL 17 na przebieg/shard i usuwa kontener po zakończeniu
procesu testowego. Każdy fixture dostaje osobną bazę. Gatewaye klonują niemodyfikowalny,
zmigrowany szablon; testy migracji nadal zaczynają od pustej bazy i wykonują prawdziwe migracje.
Bezpośrednie `bun test <plik>` nadal działa z własnym kontenerem fixture'a.

`.github/workflows/release.yml` uruchamia nightly z `dev` **co godzinę, o minucie 40 UTC**
(`40 * * * *`). Najpierw `plan` wykonuje dry run semantic-release: brak nowych commitów lub
wyłącznie commity bez wpływu na wersję (`docs`, `ci`, `chore`, `test`, `refactor`, `style`, `build`
bez `BREAKING CHANGE`) daje `published=false`. Wtedy nie startują ani CI (w tym shardy testów),
ani buildy, publikacja czy retencja po wydaniu; nie powstaje tag. Pozostaje koszt checkoutu,
instalacji zależności i dry runu. To ten sam analyzer i historia kanałów co przy publikacji,
bez osobnego przybliżania reguł commitów lub porównywania wyłącznie plików.

| Zdarzenie / ref | Zachowanie |
| --- | --- |
| push do `dev` | bez Release i dodatkowego CI; CI każdego PR pozostaje bez zmian |
| schedule na domyślnej gałęzi `dev` | plan; CI i buildy tylko dla nowego nightly |
| dispatch na `dev` | wydanie od razu, przez tę samą bramkę; wymagany `expected_sha` = HEAD |
| push / dispatch na `next` lub `main` | beta / stable jak wcześniej; dispatch zachowuje `expected_sha` |
| push stabilnego tagu `vX.Y.Z` | ręczne stable z historii `main`, z CI i publikacją jak wcześniej |

Nie dodajemy CI po każdym pushu do `dev`: duplikowałoby pełne shardy CI z PR i późniejszego
wydania. Oznacza to brak natychmiastowego sygnału o błędzie wynikającym z połączenia zmian;
pełne CI uruchomi się przed publikacją releasowalnego nightly. Sam PR nadal wymaga CI.
Dispatch po Promote/back-merge zachowuje walidację `expected_sha`, także na `dev`.

Wszystkie przebiegi `dev` (schedule i dispatch) mają wspólną grupę całego workflow
z `cancel-in-progress: false`: aktywny przebieg kończy się bez anulowania, a spośród oczekujących
pozostaje tylko najnowszy. Kolejny cykl czeka lub zostaje zastąpiony nowszym oczekującym,
nigdy nie publikuje równolegle. Ceną jest oczekiwanie także na desktop/notaryzację aktywnego nightly.
Nie wolno włączyć `cancel-in-progress: true`: aktywny przebieg może już publikować.
Beta, stable i tagi mają odrębne grupy przebiegów i zachowują równoległe buildy.
Joby ustalające i publikujące wersję zachowują dotychczasowe blokady per gałąź.
GitHub uruchamia schedule wyłącznie z domyślnej gałęzi; musi nią pozostać `dev`.
Guard nie pozwala schedule wydać beta/stable po zmianie gałęzi domyślnej.
Cron może się opóźnić lub zostać pominięty; następny cykl zbiera wszystkie niewydane zmiany.
Godzina nie jest gwarancją czasu dostępności aktualizacji. Pilne wydanie uruchamia maintainer
przez dispatch na `dev` z aktualnym SHA (również czeka na aktywny nightly).
Desktop przywraca cache Electron/electron-builder przed instalacją zależności;
cache pakietów Bun pozostaje rozdzielony według OS, architektury i lockfile.

```text
plan ─┬─ checks ────────────────────────────────────┐
      ├─ binaries ── smoke ─────────────────────────┤
      ├─ images-build ─────────────┐                 │
      ├─ desktop (macierz) ────────┼─────────────────┼──────────────┐
      └─ release (po checks) ──────┴─ images ─ publish-server ─ publish-desktop
                └─ stop-builds (checki czerwone / przebieg wyprzedzony)   ├─ nightly-hygiene / backmerge
```

| Job | Co robi | Kiedy startuje | Publikuje |
| --- | --- | --- | --- |
| `checks` | `ci.yml` | po `plan`; na `dev` tylko gdy `published=true` | — |
| `plan` | semantic-release **`--dry-run`**: `version`, `tag`, `channel`, macierz desktop | od razu; grupa `release-version-<ref>` | nic (sprawdza tylko prawo pushu) |
| `binaries`, `smoke` | cross-compile wszystkich celów; `--version` każdej binarki na jej OS/arch | po `plan`, równolegle z checkami | — (artefakt Actions) |
| `images-build` | buildx amd64+arm64 do cache GHA (`mode=max`), bez pushu i atestacji | po `plan` | — |
| `desktop` | Linux, macOS (Apple Silicon), Windows; podpisy i notaryzacja | po `plan` | — (artefakt Actions) |
| `release` | prawdziwy semantic-release: tag i GitHub Release z notatkami | po **zielonych `checks`**; grupa `release-version-<ref>` | tag + pusty release |
| `images` | ten sam build z cache, push wyłącznie niezmiennego `vX.Y.Z` (SBOM) | po `release` i `images-build` | obraz `vX.Y.Z` |
| `publish-server` | binaria, `checksums.txt`, `manifest.json` (ostatni), potem aliasy obrazów | po `checks`, `release`, `binaries`, `smoke`, `images`; grupa `release-publish-<ref>` | etap 1 |
| `publish-desktop` | instalatory, blockmapy, scalone feedy, nowe `checksums.txt`/`manifest.json` | po `publish-server` i końcu macierzy desktop | etap 2 |
| `stop-builds` | `gh run cancel` własnego przebiegu | checki czerwone albo `release` bez wydania/anulowany | — |
| `nightly-hygiene`, `backmerge` | jak wcześniej | po `publish-server`; brak wydania pomija oba | — |

**Nic nie jest publikowane przed zielonymi testami.** Równolegle z `checks` powstają wyłącznie artefakty
Actions i cache buildx (prywatne dla repozytorium). Tag, GitHub Release, obraz w GHCR, assety
release i aliasy obrazów zależą od `release`, a ten od `checks`. Dry run nie tworzy tagu ani notes;
wymaga tylko `contents: write`, bo semantic-release sprawdza prawo pushu (`git push --dry-run`).

**Wersja z planu.** Buildy dostają wersję z `plan`. `release` uruchamia semantic-release
z `EXPECTED_VERSION`; plugin `scripts/release-expected-version.mjs` (krok `verifyRelease`, przed
utworzeniem tagu) odrzuca inną wersję, a krok po nim porównuje wynik jeszcze raz. Rozjazd kończy
przebieg błędem bez tagu: użyj **Re-run all jobs** (nowy plan i buildy). `plan` i `release`
dzielą grupę `release-version-<ref>`, więc plan nie liczy wersji w trakcie tagowania innego przebiegu.

**Wyprzedzony przebieg.** semantic-release nie wydaje, gdy gałąź przesunęła się w trakcie
przebiegu („local branch … is behind the remote one”). Wtedy `stop-builds` anuluje własny przebieg
(m.in. budowę i notaryzację macOS). Na `dev` commity zbiera następny cykl godzinowy lub dispatch,
nie sam push. Ciągłe zmiany gałęzi podczas checków mogą odsuwać nightly do spokojniejszego cyklu.
GitHub w grupie `concurrency` trzyma jeden job oczekujący: nowszy anuluje starszy oczekujący — to też
oznacza wyprzedzony przebieg. Przy czerwonych checkach `stop-builds` także zatrzymuje buildy;
nic nie zostało otagowane, więc ponowienie (**Re-run all jobs**) jest bezpieczne.

**Publikacja w dwóch etapach** (`scripts/release-upload.ts`, oba etapy można powtarzać):

1. Tag musi wskazywać `GITHUB_SHA` przebiegu, release nie może być draftem, a flaga prerelease
   musi zgadzać się z kanałem. Ścieżka tagowa tworzy release przy pierwszym uploadzie.
2. Kolejność: binaria/instalatory/blockmapy (`--clobber`) → feedy `*.yml` → `checksums.txt`
   → `manifest.json`. Te dwa ostatnie są wymieniane przez upload `<nazwa>.next` i zmianę nazwy,
   więc opublikowany release traci je najwyżej na czas jednego wywołania API.
3. `publish-server` publikuje manifest tylko z binariami gatewaya/workera. Od tej chwili działają
   aktualizacje gatewaya/workera, instalator workera i obrazy kanału.
4. `publish-desktop` pobiera ponownie artefakt `binaries` i wszystkie gotowe `desktop-*`, scala feedy,
   liczy `checksums.txt`/`manifest.json` od nowa (wpisy serwerowe są identyczne, dochodzą `app: desktop`),
   wgrywa tylko pliki desktop, feedy i oba pliki zbiorcze. Updater desktopu wybiera release dopiero,
   gdy ma feed jego platformy **i** `manifest.json`, więc release z samymi binariami pomija;
   feed trafia na release po instalatorach i blockmapach, które opisuje.
5. Aliasy obrazów (`nightly`, `beta`, `stable`, `latest`, `vX`, `vX.Y`) przesuwa
   `scripts/image-aliases.ts` (`docker buildx imagetools create`) **tylko do przodu**: alias wskazujący
   nowszą wersję (adnotacja `org.opencontainers.image.version` indeksu) zostaje. `publish-server`
   jest serializowany per gałąź, więc dwa przebiegi nie cofną aliasu. Poprawka starszej linii stable
   przesuwa `vX.Y`, ale nie `latest`/`stable`.

Błąd desktopu nie dotyka już opublikowanego etapu 1. `publish-desktop` publikuje cele, które się
zbudowały; brakujący cel jest widoczny jako czerwony job i ewentualne ostrzeżenie w podsumowaniu.
`promote.ts` wymaga zielonego przebiegu Release na wybranym commicie C, więc niepełny desktop blokuje promocję tego commita
aż do skutecznego ponowienia. Ponowny upload manifestu przesuwa jego `updated_at`, od którego liczy się
burn-in bety — to zamierzone: liczy się od kompletu assetów.

**Nightly bez celów eksperymentalnych.** Kanał nightly buduje desktop tylko dla linux-x64 i darwin-arm64
(podpisany nightly dla maintainera). linux-arm64 i windows-x64 (eksperymentalne, `continue-on-error`)
buduje beta i stable, a nightly tylko przy ręcznym dispatchu z `desktop_all_targets: true`
(dispatch wymaga `expected_sha` = HEAD gałęzi i wydaje tylko, gdy są niewydane commity).

**Cache.** Pakiety Bun (`~/.bun/install/cache`, klucz z `bun.lock`) we wszystkich jobach z instalacją;
pobrania Electron/electron-builder w jobach desktop; warstwy obrazów w cache GHA per aplikacja.
Bundla web nie współdzielimy między jobami desktop: osobny job buildu opóźniłby start macOS
(ścieżka krytyczna desktopu) bardziej, niż oszczędza (~1 min na runner).

### Oczekiwane czasy

| Etap | Od startu aktywnego Release (bez oczekiwania na cron/kolejkę) |
| --- | --- |
| `plan` gotowy, start buildów | ~1 min |
| `checks` zielone | ~4,5–5 min |
| `release` (tag), start `images` | ~5,5–6 min |
| obrazy `vX.Y.Z` w GHCR (build z cache) | ~7–8 min |
| **etap 1: binaria, `manifest.json`, aliasy obrazów** | **~9–11 min** |
| desktop Linux w release | ~12–14 min |
| desktop macOS (podpis + notaryzacja) w release | ~30–35 min |

Czasy są orientacyjne; CI startujące po planie wymaga potwierdzenia na GitHubie.
Merge do `dev` czeka na najbliższy cykl godzinowy, a nowy przebieg dodatkowo na zakończenie
całego aktywnego nightly. Ręczny dispatch omija oczekiwanie na cron, ale nie blokadę przebiegów.

### Ponowienia i błąd notaryzacji

- Po błędzie buildów albo publikacji użyj **Re-run failed jobs**: zachowuje wyjścia `plan`/`release`
  i powtarza nieudane joby z zależnymi. Ponowienie całego workflow po utworzeniu tagu kończy się
  „no release”, bo tag już istnieje. Artefakty Actions żyją 7 dni.
- **Notaryzacja macOS zawiodła** (timeout Apple, odrzucenie, wygasła umowa/klucz): etap 1 i pozostałe
  cele desktop są już opublikowane, release nie ma assetów mac ani `*-mac.yml`, więc desktop macOS
  zostaje na poprzedniej wersji. Sprawdź log `desktop (darwin-arm64)` (status zgłoszenia `notarytool`,
  ważność sekretów i umów Apple), napraw przyczynę i użyj **Re-run failed jobs** — przebuduje macOS
  i powtórzy `publish-desktop`, który dopisze assety mac oraz przeliczy feedy, sumy i manifest.
  Ponowienie działa także po tym, jak nowszy przebieg wydał już kolejny nightly.
- Ręczny stabilny tag musi należeć do historii `main`; ścieżka tagowa tworzy release przy uploadzie.

### Do potwierdzenia na pierwszych przebiegach

GitHub Actions nie da się uruchomić lokalnie. Na pierwszych przebiegach `dev` sprawdź:
`plan` (dry run z `contents: write`) podaje wersję i nie tworzy tagu; `release` publikuje tę samą wersję;
`images` korzysta z cache `images-build` (krótki build); `imagetools inspect` czyta adnotację wersji
aliasu (log `stays at`/`→`), a `imagetools create` zachowuje obie platformy i SBOM; `release-upload.ts`
podmienia `manifest.json`/`checksums.txt` przez `.next` (brak pozostałych plików `.next`);
`publish-desktop` widzi artefakty z poprzedniej próby po **Re-run failed jobs**; `stop-builds`
anuluje wyprzedzony przebieg. Dwa merge'e przed cyklem dają jeden nightly z obu commitów;
kolejny cykl na tym samym SHA albo po samych `docs` pomija `checks` i buildy.
Sprawdź też wspólną kolejkę schedule/dispatch i wywołanie TestFlight tylko po rzeczywistej publikacji.

Podpisywanie desktop jest warunkowe: bez certyfikatu macOS otrzymuje podpis ad-hoc,
Windows pozostaje niepodpisany. Konfiguracja certyfikatu macOS włącza obowiązkowy signing,
a kompletny zestaw notaryzacji włącza wbudowane `mac.notarize` i stapling przed zip/dmg.
Kontrola CI sprawdza app przez `codesign --verify --deep --strict`, każdy runtime Mach-O
oddzielnie, Developer ID przez requirement i `spctl -a -vv` dla podpisanych buildów.
Notaryzowany build musi przejść Gatekeeper i `xcrun stapler validate`.
Patch Bun do `@electron/notarize@2.5.0` ponawia samo `staple` z walidacją do pięciu
razy (15/30/60/60 s), przed utworzeniem zip/dmg. Nie ponawia zgłoszenia ani nie
pomija notaryzacji; trwały błąd nadal zatrzymuje job. Szczegóły: [desktop.md](desktop.md#podpisywanie-macos-i-gatekeeper).
Scalanie feedów przyjmuje zarówno katalogi per cel, jak i płaski wynik
`download-artifact@v5`, gdy tylko jeden cel desktopu zakończył się powodzeniem.
Bez notaryzacji odmowa `spctl` jest oczekiwana i raportowana; sam podpis musi być poprawny.

### Sekrety podpisywania desktop

Sekrety dodaje maintainer do GitHub → Settings → Secrets and variables → Actions
(repository secrets). Nic nie trafia do kodu, gatewaya, workera ani renderera.
Do pobierania publicznych aktualizacji aplikacja nie potrzebuje tokena GitHub.

Centrum aktualizacji pobiera również publiczne notatki GitHub Releases, z krótkim
cache, dla przedziału (wersja zainstalowana, wersja docelowa], od najnowszej.
Filtrowanie zachowuje hierarchię kanałów stable → beta → nightly. Wydanie serwera
może istnieć przed publikacją desktopu: brak feedu danej platformy oznacza, że
desktop nadal nie jest dostępny, a publikacja może trwać albo wymagać ponowienia.
Nie jest to potwierdzenie, że zadanie CI nadal działa.

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
   `Verify macOS signatures and notarization`. Ich błąd blokuje publikację desktopu macOS
   (etap 2) i promocję, nie binaria ani obrazy (etap 1).
2. Pobierz dmg i zip z GitHuba na czystego Maca z quarantine. Uruchom app bez `xattr`,
   sprawdź lokalny start PostgreSQL, gatewaya, workera i web oraz zamknięcie procesów.
   Sprawdź `codesign -d --entitlements :-` dla app, helpera i jednego `runtime/bun`.
   Usługi są plikami JS; w app nie może być PostgreSQL ani CLI agentów.
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

Po zmianie układu runtime i pobieraniu PostgreSQL sprawdź dodatkowo:

1. `package-sizes-darwin-arm64.json`, brak `app.asar.unpacked` i node_modules w asar,
   jeden Bun, brak PG/CLI w app, same arm64 Mach-O. Framework Electron zostaje.
   CI ma przejść `Verify packaged runtime and downloaded PostgreSQL`: lokalny rejestr
   HTTP podaje prawdziwy pakiet PG, który jest weryfikowany, odchudzany, podpisywany
   ad-hoc i używany do rzeczywistego enrollment/startu/stopu i recovery bazy.
2. Na czystym Apple Silicon **bez Xcode/CLT** pobierz notarized dmg/zip w przeglądarce
   z quarantine i uruchom normalnie z Findera. Pierwszy local ma pokazać postęp,
   pobrać przypięty npm PG i uruchomić usługi bez obchodzenia Gatekeepera. Nie używaj
   `xattr -d`, wyłączania zabezpieczeń ani ręcznych podpisów. Zapisz ewentualny błąd
   polityki; test pod Bun w terminalu CI nie rozstrzyga śledzenia pochodzenia plików.
3. W cache PG potwierdź względne symlinki ICU zamiast trzech kopii, jeden slice arm64,
   `codesign --verify --strict` wszystkich Mach-O oraz `postgres --version`.
   Zmierz osobno rozmiar app, instalatora i cache PG; oszacowania z Linuxa nie są
   pomiarem macOS. Wyłącz sieć: ponowny lokalny start ma działać z cache.
4. Na świeżym katalogu danych remote nie może utworzyć cache ani pobierać PG.
   Brak zainstalowanego `claude` ma pokazać jasny status; własna ścieżka/PATH i login
   mają działać bez pobierania CLI. Osobno sprawdź Codex i Grok oraz zwykłe tury.
5. Przerwij pobieranie i zamknij app: ponowienie ma wznowić instalację, bez użycia
   częściowych plików i bez procesów sierot. Na kopii danych testuj major mismatch:
   odmowa startu, brak pobrania/usuwania danych i starych binariów. Po aktualizacji
   tej samej głównej wersji stare cache mają zniknąć dopiero po poprawnym starcie.

## Promocja i okres stabilizacji („burn-in”)

Nightly zbiera niewydane zmiany `feat`/`fix`/`perf` na `dev` w cyklu godzinowym lub po dispatchu
(zmiany bez wpływu na wersję nie publikują buildu). Beta to wybrany nightly; stable to beta po okresie obserwacji.
Promocja przebudowuje ten sam commit z nowym numerem wersji, nie kopiuje binariów między kanałami.
Soak `dev → next` nadal wynosi **24 h od daty commitera każdego commita**, nie od publikacji nightly.
Nie zmieniają się `landedAt` (`git show --format=%ct`) ani polityka w `promotion-policy.ts`.
Godzinowe grupowanie oznacza mniej commitów z własnym zielonym Release; promocja może wybrać
starszy ukończony nightly lub poczekać, aż cały nowszy prefiks dojrzeje i przejdzie Release.
Pominięty plan bez CI/smoke sam nie potwierdza gotowości nieotagowanego commita.

**Automatic promotion** (`promotion-review.yml`) działa co **3 h**, o `0 */3 * * *` UTC.
Najpierw wykonuje **next → main**, potem **dev → next**, w jednej grupie
`release-branch-mutations`, wspólnej z ręcznym Promote i Back-merge. Nie wymaga decyzji
maintainera w zwykłym cyklu. Opóźnienia harmonogramu GitHub mogą wydłużyć oczekiwanie.
Oba workflowy instalują zamrożone zależności, aby prognoza używała tego samego analyzera
Angular co Release; nie uruchamiają `semantic-release --dry-run`, który sprawdzałby prawo pushu.

1. **Cutoff C0.** Dla dev wybieramy najnowszy ciągły prefiks historii first-parent, którego
   każdy commit ma datę commitera squasha starszą o co najmniej **24 h**. Dla next kandydatami
   są wyłącznie commity z opublikowanym tagiem beta; wybieramy najnowszy z gotowym manifestem
   od co najmniej **72 h** (`BETA_BURN_IN_DAYS`, domyślnie 3). Początek obserwacji to późniejszy
   z `release.published_at` i `manifest.json.updated_at`. Dopisanie desktopu do manifestu
   zaczyna obserwację tej bety ponownie. Nowsza beta nie zeruje obserwacji starszej.
2. **Poprawki i hold.** Każdy `fix`/`perf`/revert po cutoffie może zatrzymać powiązaną zmianę
   w `(target, C]`. Cofamy cutoff przed najwcześniejszą taką zmianę, potem powtarzamy sprawdzenie
   do punktu stałego. Etykieta `promotion-hold` na scalonym PR zatrzymuje jego squash i cały suffix.
   Ponownie sprawdzamy również poprawki wykluczone przez hold lub wybór starszego zielonego CI,
   nawet jeżeli są już starsze niż soak: cofnięcie nie może oddzielić funkcji od jej poprawki.
   Stable sprawdza dodatkowo poprawki na dev, których nie ma jeszcze w next: znana naprawa
   bety zatrzymuje stable, dopóki nie wejdzie do bety i nie przejdzie jej burn-in. Rozbieżność
   next/dev zatrzymuje tę ścieżkę do Back-merge; commity dev są tu tylko sygnałami, nigdy kandydatami stable.
   Jeżeli funkcja i poprawka są już po soak i obie mieszczą się w cutoffie, idą razem.
3. **Gotowość C.** Najnowszy przebieg Release **dokładnie dla C** na gałęzi źródłowej musi być
   zakończony sukcesem. Późniejszy zielony commit nie dowodzi poprawności wcześniejszego drzewa.
   Preferujemy najnowszy taki commit z ukończonym release i tagiem nightly; dopiero przy braku
   takiego tagu szukamy zielonego commita bez tagu w dozwolonym prefiksie dev, wymagając także
   sukcesu wszystkich czterech jobów `smoke` (pominięty smoke nie wystarcza). Stable zawsze
   wymaga ukończonej bety. Otwarte issue `release-blocker` blokuje obie ścieżki. Zmienna repo
   **`AUTO_PROMOTION=off`** wstrzymuje promocje (brak/inna wartość włącza automat).
4. **Push i raport.** Target musi być przodkiem C. Kandydat C leży na historii first-parent
   źródła; po back-merge hotfixu target może być jego przodkiem przez drugi rodzic merge'a.
   Nie wybieramy wtedy cutoffu sprzed merge'a, który włączył hotfix.
   Tuż przed zapisem ponownie sprawdzamy referencje, PR-y, blokery i CI. Zwykły push
   `<C>:refs/heads/<target>` bez force nigdy nie cofa gałęzi; rozbieżność wymaga Back-merge.
   Dispatch Release podaje `expected_sha=C`, ponieważ push `GITHUB_TOKEN` nie uruchamia workflow.
   `C == target`, brak bootstrapu stable lub zakres bez zmiany wersji oznacza no-op; docs-only
   nie tworzy bety. Każdy przebieg zapisuje C0, C, wersję oczekiwaną, listę włączoną i wykluczoną
   oraz przyczyny hold w job summary. Wersja jest prognozą z tego samego analyzera Angular;
   Release wyznacza ją ponownie. Issue `Promotion history: <path>` przechowuje historię planów
   przed pushem (nie stanowi dowodu udanej publikacji; dowodem jest przebieg Release).
5. **Brak postępu.** Jeśli powiązana poprawka lub hold zatrzymuje zmianę przez co najmniej
   **7 dni od jej kwalifikacji czasowej**, tworzymy/aktualizujemy `Promotion stalled: <path>`
   z SHA i powodem (konkretna poprawka oraz PR/SHA/pliki). Nie obchodzimy blokady automatycznie.

**Konwencja linkowania.** Poprawiając wcześniejszą scaloną zmianę, autor `fix`/`perf`/revert
podaje oryginalny PR lub SHA squasha w osobnej linii body PR/commita i zachowuje ją w squashu:

```text
fix(worker): handle reconnect after suspend

Fixes: #68
```

Alternatywy: `Refs: abc1234567890`, `Refs: #68`, `Refs #68`, `follow-up to #68`.
Szablon PR udostępnia `Fixes an earlier change: #68`. Revert zachowuje
`This reverts commit abc1234567890.`. Akceptujemy SHA hex 7–40 znaków (preferowane pełne)
i słowa GitHuba `fix`/`fixes`/`fixed`, `close`/`closes`/`closed`,
`resolve`/`resolves`/`resolved`, z opcjonalnym dwukropkiem, np. `Fixes #68`.
Link musi zajmować osobną linię; przypadkowe numery PR i hashe w zdaniu nie wiążą zmian.
Numery odnoszą się do PR-ów tego repozytorium. Jawny link działa bez ograniczenia wieku i plików.

**Heurystyka awaryjna (SZZ).** Przy braku jawnego linku przypisujemy zmienione/usunięte
linie do commitów, które je wprowadziły. `git diff -w --ignore-blank-lines -U0 F^ F`
wyznacza zakresy pre-image; `git blame --porcelain -w -M -C -L start,end F^ -- <file>`
sprawdza tylko te zakresy, ignorując whitespace i śledząc przeniesienia/kopie linii.
Blame pomija też rewizje wymienione w wersji `.git-blame-ignore-revs` z `F^`, żeby
repozytoryjne formatowanie z przełamaniem linii nie przejmowało autorstwa naprawianego kodu.
Zmiana samego whitespace nie tworzy powiązania. Dla hunków będących wyłącznie dopiskiem
sprawdzamy bezpośrednią linię przed i po wstawieniu: obie muszą wskazywać ten sam commit.
Na początku/końcu pliku wystarcza jedyny istniejący sąsiad. Przy różnych właścicielach,
nowym lub pustym pliku nie przypisujemy dopisku do nikogo. Powiązanie zatrzymuje promocję
tylko dla oryginału w `(target, C]`, gdy poprawka trafiła na gałąź 0–7 dni po nim;
blame wskazujący już wydany commit lub commit poza prefiksem nie zatrzymuje prefiksu.
Raport pokazuje SHA właściciela, plik i numery linii sprzed poprawki. Pomijamy:

- `packages/contracts/src/gen/**`, `packages/codex-protocol/src/gen/**`;
- `packages/db/src/migrations/index.ts`, `packages/db/test/schema.test.ts`;
- `docs/**`;
- pliki o nazwach `bun.lock`, `bun.lockb`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`,
  `pnpm-lock.yaml`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `uv.lock` w dowolnym katalogu;
- nazwy `CHANGELOG`, `CHANGES`, `HISTORY`, `RELEASE-NOTES` (bez względu na wielkość liter),
  również z sufiksem po kropce/myślniku. Migracje SQL i źródłowe proto nadal wiążą zmiany.

Dotknięcie tego samego pliku nie wystarcza do powiązania. Blame jest przybliżeniem przyczyny
błędu: naprawa może dotyczyć logiki w innym miejscu albo mieć niejednoznaczny kontekst dopisku.
Jawne stopki pozostają podstawową konwencją i mają pierwszeństwo przed atrybucją linii.

**Smoke zamiast checkboxów.** Automat niczego nie zaznacza w imieniu człowieka.
Zielony Release obejmuje CI, testy updatera w CI, start binariów gateway/worker z kontrolą
wersji na linux-x64/linux-arm64/darwin-arm64/windows-x64 oraz publikację serwera;
stable dodatkowo wymaga tej samej automatycznej weryfikacji na becie i jej burn-in.
Nie jest to ludzkie potwierdzenie live smoke dostawców ani pełny scenariusz self-update/rollback
w realnej instalacji. Te ręczne potwierdzenia przestają być warunkiem promocji. Nie dodajemy
nowego testu E2E aktualizacji; zachowujemy istniejące testy updatera i smoke Release.

**Ręczny Promote.** Nadal wybiera `dev-next`/`next-main` tym samym algorytmem.
`dry_run` (domyślnie true) wypisuje plan bez pushu, dispatchu i zapisu issue. Opcjonalne
przewidywanie następnego terminu w dry-runie zmienia wyłącznie czas na tym samym snapshotcie
historii/CI/etykiet: podaje próg soak, najbliższy cykl 3 h i SHA. Nie zakłada przyszłego
powodzenia CI ani nie gwarantuje publikacji, jeśli stan repozytorium się zmieni. Parametr
`override=true` pozwala maintainerowi pominąć soak, pauzę i `promotion-hold`; nie pomija
powiązanych wykluczonych poprawek, zielonego CI, ukończonej bety dla stable, blockerów ani FF.
Stare wejścia `live_smoke`/`update_smoke` zachowano dla kompatybilności dispatchu, ale nie są
już bramkami. Zmienne `AUTO_PROMOTE_DEV_TO_NEXT` i `NIGHTLY_SMOKE_SHA` nie są używane.
Odczyt lokalny: `GITHUB_REPOSITORY=itsoltech/canopy bun scripts/promote.ts --automatic --dry-run`.
Polecenie fetchuje referencje/tagi i tylko czyta GitHub (autoryzacja `gh`), bez publikacji.
Gdy dispatch po pushu zawiedzie, issue historii zachowuje plan i SHA; następny cykl ponawia
dispatch dokładnie tego SHA, zanim dopuści kolejną promocję. Pauza i release-blocker wstrzymują
także ponowienie. Historia rozróżnia plan przed pushem i skuteczny dispatch; stan publikacji
pozostaje w Release. Przy błędzie końcowego zapisu issue dispatch może zostać ponowiony,
ale serializacja i planowanie Release nadal zapobiegają podwójnemu tagowaniu.
Przed ponowieniem sprawdzamy cały pierwotny zakres od starego targetu: nowa poprawka
lub hold może zatrzymać jeszcze nieopublikowaną promocję mimo udanego pushu.

Po stable **Back-merge** (bez zmian) przenosi hotfix `main` → `next` → `dev` commitami merge bota,
   dispatchując CI/Release dla zmienionych gałęzi. Dla promocji bez rozbieżności jest to no-op.
   Przy konflikcie otwiera PR i zatrzymuje dalsze przenoszenie. Po rozwiązaniu konfliktu i squash
   merge PR uruchom Back-merge ponownie: dopisze merge commit przywracający relację przodków.

## Retencja nightly

**Nightly hygiene** (`scripts/prune-nightly.ts`, workflow `nightly-hygiene.yml`) działa po publikacji
nightly i codziennie o 04:30 UTC; grupa `nightly-hygiene` nie dopuszcza dwóch przebiegów naraz. Nic, co
powstało lub zmieniło się w ciągu ostatnich **6 h**, nie jest usuwane (publikacja w toku albo do
„Re-run failed jobs”).
Harmonogram publikacji nie zmienia tej polityki: przebieg bez wydania pomija wywołanie retencji,
a codzienny cron sprząta także wtedy, gdy nie powstają nowe nightly. Limit 10 ukończonych wydań
oznacza liczbę wersji, nie gwarantowane 10 godzin historii.

1. **GitHub Releases.** Zachowuje 10 najnowszych ukończonych (z `manifest.json`) prereleases nightly
   i usuwa starsze. Nieukończony nightly (bez `manifest.json`: publikacja nieudana/anulowana, niewidoczny
   dla updaterów) usuwa, gdy istnieje nowszy ukończony nightly i minęło 6 h; inaczej zostaje do
   ponowienia. Pozostawia tagi git i notes semantic-release: są potrzebne do numeracji oraz historii
   kanałów. Cache gatewaya zachowuje manifest/binarie jego wersji. Starszy nightly na zimnym cache może
   wymagać ręcznego przejścia na zachowany release.
2. **GHCR** (`canopy-gateway`, `canopy-web`, `canopy-worker`, REST
   `/orgs/{org}/packages/container/{name}/versions`). Usuwa wersję pakietu (digest) tylko gdy:
   - wszystkie jej tagi to wersje `vX.Y.Z-nightly.N`, których nightly nie jest już zachowany
     (także sprzed lat, bez release'u) i które są starsze od najnowszego ukończonego nightly;
   - nie ma żadnego innego tagu (`nightly`, `beta`, `latest`, `stable`, `vX`, `vX.Y`, wersja
     beta/stable, `buildcache`…), więc beta i stable nigdy nie podlegają retencji;
   - nie jest celem aliasu `nightly`/`beta`/`latest`/`stable` — po digeście (wspólna wersja) i po
     adnotacji `org.opencontainers.image.version` indeksu aliasu;
   - jej `updated_at` jest starsze niż 6 h (przesunięcie aliasu też liczy się jako zmiana).

   Nieotagowane wersje (manifesty platform, manifesty atestacji SBOM/provenance) skrypt czyta z indeksu
   OCI przez API rejestru (`/v2/.../manifests/<digest>`, token pull z `ghcr.io/token`). Usuwa je tylko,
   gdy wskazuje je usuwany indeks, a żaden pozostający indeks (otagowany lub nie, np. stary indeks aliasu)
   — przed samym indeksem, więc przerwany przebieg dokończy następny. Nieotagowanych wersji bez
   usuwanego rodzica (pochodzenie nieustalone) nie rusza; takie sieroty, np. po ręcznym usunięciu
   indeksu, usuwa administrator. Błąd odczytu rejestru pomija cały pakiet.

Najpierw releases, potem GHCR: brak dostępu do pakietu kończy job błędem z opisem dopiero po
przycięciu releases. Wydanie to nie dotyka — `nightly-hygiene` startuje po `publish-server` i nic od
niego nie zależy (przebieg release jest wtedy czerwony tylko na tym jobie). Ręcznie: workflow dispatch
`Nightly hygiene` z `dry_run: true` albo lokalnie `GH_TOKEN=… GITHUB_REPOSITORY=itsoltech/canopy bun
scripts/prune-nightly.ts --dry-run` — wypisuje tylko plan (nazwy, tagi, id). Harmonogram i wywołanie
z release działają naprawdę.

**Uprawnienia GHCR.** Job ma `packages: write`, ale `GITHUB_TOKEN` może listować i usuwać wersje
pakietu organizacji tylko, gdy repozytorium ma do niego rolę **Admin**: w ustawieniach każdego
pakietu (`canopy-gateway`, `canopy-web`, `canopy-worker`) → *Manage Actions access* → dodaj
`itsoltech/canopy` z rolą **Admin** (domyślna rola połączonego repozytorium to Write, która wystarcza
do pushu, nie do usuwania). Bez tego job zgłasza `GHCR canopy-…: no access to package versions`.

## Ustawienia repozytorium (stosuje maintainer/rodzic)

- Feature PR: wyłącznie **squash merge**, tytuł PR jest tytułem commita. Wymagane checki:
  `commitlint` (workflow PR title) i CI. Stopka `BREAKING CHANGE` musi zostać w body squasha.
- Promocje są pushami **fast-forward**, back-merge bezpośrednimi commitami merge bota — nie
  korzystają z przycisku merge PR. Reguły ochrony `dev`/`next`/`main` muszą pozwalać GitHub Actions
  botowi na te operacje i zapis tagów/notes. Nie wymagaj linear history dla back-merge.
- Actions: joby żądają `contents: write`, `packages: write`, `actions: write`, `issues: write`
  lub `pull-requests: write` według potrzeby. Włącz „Allow GitHub Actions to create and approve
  pull requests” dla PR konfliktowych. Utwórz etykiety **release-blocker** i **promotion-hold**. Proponowana gałąź
  domyślna: **dev** (również dla workflowów schedule/dispatch).
- Pierwszy push tworzy pakiety GHCR prywatne: w ustawieniach pakietów `canopy-gateway`,
  `canopy-web`, `canopy-worker` ustaw **Public** (albo daj dostęp konkretnym użytkownikom)
  i połącz je z repozytorium (etykieta `org.opencontainers.image.source` robi to automatycznie).
  W *Manage Actions access* nadaj repozytorium rolę **Admin** (retencja nightly usuwa wersje,
  [Retencja nightly](#retencja-nightly)).
  Runnery `ubuntu-24.04-arm`, `macos-15`, `windows-2025` muszą być dostępne.
- Pages: w *Settings → Pages* ustaw źródło **GitHub Actions** (workflow `pages.yml`).
- GitHub „immutable releases” pozostaw wyłączone: semantic-release publikuje release przed
  uploadem assetów; upload i retencja wymagają możliwości ich późniejszej zmiany/usunięcia.

## Bootstrap 0.1.0 — wykonuje rodzic

1. Po zielonym PR scal tę zmianę do `main` i pobierz jego HEAD. Przed pierwszym stabilnym tagiem
   push main kończy się „no release” (guard bootstrap), nawet jeśli squash ma typ `feat`.
2. Na HEAD main utwórz `git tag -a v0.1.0 -m 'Canopy 0.1.0'`, potem
   `git push origin main v0.1.0`. Tylko przebieg tagowy publikuje **0.1.0 stable**; przebieg main
   widzi tag na HEAD i brak nowych commitów. CI, wszystkie binaria/smoke i obrazy muszą przejść
   przed pierwszym manifestem; desktop dopisuje się w drugim etapie. Sprawdź `v0.1.0/manifest.json` i publiczną widoczność GHCR.
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
Kolejny test odtwarza dwa merge'e w krótkim odstępie: oba plany dają tę samą wersję, wyprzedzony
przebieg nic nie taguje, inna niż zaplanowana wersja jest odrzucana przed tagiem, a planowana wydana.
Test etapów publikacji liczy sumy i manifest z samymi binariami, potem z jednym celem desktop, potem
po „ponowieniu” z brakującym celem: każdy asset manifestu istnieje i ma zgodny SHA-256, `checksums.txt`
obejmuje wszystkie pliki, wpisy serwerowe się nie zmieniają, a powtórka daje ten sam wynik.
Testy updatera używają lokalnego fixture HTTP
z prereleases, paginacją i manifestami. Pełna publikacja wymaga uruchomienia workflow na GitHubie.
