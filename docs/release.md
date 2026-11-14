# Wydania: wersje, CI, artefakty

Jedna wersja dla wszystkich aplikacji (gateway, worker, web, desktop, mobile). Wersję wyznacza
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
- mobile: `scripts/mobile-version.sh <tag>` zapisuje pełną wersję w roboczym
  `apps/mobile/canopy-version.json`; mobilne `src/version.ts` eksportuje ją jako `CANOPY_VERSION`.
  Metro bundluje plik dla zdalnych buildów EAS oraz OTA; `expo.extra.canopyVersion` pokazuje
  tę samą wartość w publicznym configu. Lokalnie domyślna wersja to `0.0.0-dev`.
  Nie wymaga zmiennej środowiskowej na zdalnym builderze i nie zmienia fingerprintu runtime,
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
Nazwy widoczne to `Canopy`, `Canopy (Beta)` i `Canopy (Nightly)` z ikoną danego
kanału. `productName`, wewnętrzna nazwa Electrona, nazwy plików i identyfikatory
instalacji pozostają stałe, aby aktualizacje i zmiana kanału zastępowały tę samą aplikację.
Pola poszczególnych OS opisuje [desktop.md](desktop.md#jedna-instalacja-i-kanały).
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

### Ikony kanałów

Źródłem stable pozostaje `apps/web/static/icon-512.png`. Polecenie
`bun scripts/icons/channel-icons.ts --previews <katalog>` odtwarza zasoby w
`apps/web/static/channels/{stable,beta,nightly}` oraz podglądy poza repozytorium:
512/128/64/32/16 px, planszę porównawczą i jasny/ciemny Dock (także w 16/32 px).
Podglądy mobilne obejmują maskę iOS w 1024/180/120/87/60 px, maski Androida
(koło, squircle i zaokrąglony kwadrat), rząd ikon iPhone’a oraz duże ikony TestFlight.
PNG, wielorozdzielcze ICO i ICNS, ikony Expo i osobne warstwy adaptive Androida
są commitowane; release tylko wybiera właściwe pliki i nie wymaga generatora.
Generator wycina drzewo kluczem nasycenia/jasności, czyści i wygładza maskę oraz
usuwa kolor tła z krawędzi. Cienie, półtony i światła otrzymują osobne stopnie
koloru; światło z prawej pozostaje wewnątrz maski. Warianty zachowują oryginalny
kształt, fazowanie, połysk i cieniowanie tła wyłącznie dla desktopu i web.
Mobilne zasoby składają samo drzewo na pełnym tle, bez wewnętrznej ramki;
szczegóły stref bezpieczeństwa i warstwy monochromatycznej opisuje [mobile.md](mobile.md).

Web rozpoznaje kanał wersji działającego gatewaya przez `GetClientCapabilities`
(cache 5 s, timeout 750 ms); przy niedostępności zachowuje ostatnią tożsamość.
Początkowa rezerwa to `CANOPY_CHANNEL` procesu BFF albo kanał wersji jego buildu
(development → stable). Powłoka podaje nazwę i ścieżki favicon/apple-touch-icon
przed uruchomieniem SPA. Tytuły stron korzystają z tej samej nazwy; dynamiczny
`manifest.webmanifest` ma ten sam kanał, stałe `id` i `start_url` oraz `no-store`.
Zasoby kanałów mają oddzielne URL, więc zmiana kanału nie zostawia favicony stable
w cache. Preferencja kanału aktualizacji gatewaya nie zmienia jego bieżącej tożsamości.
Natywne nazwy i ikony mobile wymagają nowego IPA/APK, a nie OTA
([mobile.md](mobile.md)).

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
Ukryty draft dostaje oba pliki dwukrotnie: najpierw z samymi binariami (`publish-server`), potem
przeliczone z assetami desktop (`publish-desktop`); wpisy serwerowe w obu wersjach są identyczne.
Publiczny release od początku zawiera komplet assetów i feedów wszystkich wymaganych platform.

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

Job `builds` kompiluje też workera na darwin-arm64 i windows-x64, a `native` uruchamia
`canopy-worker self-check` na macOS i Windows. Eksport obrazów woła natywne API każdego
systemu przez `bun:ffi` (otwarcie, metadane, odczyt, ścieżka, zamknięcie), więc tylko binarka
na danym systemie to sprawdza; testy na Linuksie tego nie wykryją.

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

`.github/workflows/release.yml` uruchamia nightly z `dev` **co godzinę, całą dobę**, o :40 każdej godziny UTC
(`40 * * * *`). Większość zmian trafia na telefony jako aktualizacja OTA, więc wychodzą wkrótce po scaleniu.
Nietypowa minuta :40 omija zatłoczone pełne godziny i połówki na GitHubie. Najpierw `plan` wykonuje dry run semantic-release: brak nowych commitów lub
wyłącznie commity bez wpływu na wersję (`docs`, `ci`, `chore`, `test`, `refactor`, `style`, `build`
bez `BREAKING CHANGE`) daje `published=false`. Wtedy nie startują ani CI (w tym shardy testów),
ani buildy, publikacja czy retencja po wydaniu; nie powstaje tag. Pozostaje koszt checkoutu,
instalacji zależności i dry runu. To ten sam analyzer i historia kanałów co przy publikacji,
bez osobnego przybliżania reguł commitów lub porównywania wyłącznie plików.

| Zdarzenie / ref | Zachowanie |
| --- | --- |
| push do `dev` | bez Release i dodatkowego CI; CI każdego PR pozostaje bez zmian |
| schedule na domyślnej gałęzi `dev` | plan; CI i buildy tylko dla nowego nightly |
| dispatch na `dev` | wydanie od razu, przez tę samą bramkę; wymagany `expected_sha` z historii gałęzi |
| push na `next` lub `main` | beta / stable dla SHA zdarzenia push, także po promocji i hotfix PR |
| dispatch na `next` lub `main` | ręczne wydanie z wymaganym `expected_sha` z historii gałęzi |
| push stabilnego tagu `vX.Y.Z` | ręczne stable z historii `main`, z CI i publikacją jak wcześniej |

Nie dodajemy CI po każdym pushu do `dev`: duplikowałoby pełne shardy CI z PR i późniejszego
wydania. Oznacza to brak natychmiastowego sygnału o błędzie wynikającym z połączenia zmian;
pełne CI uruchomi się przed publikacją releasowalnego nightly. Sam PR nadal wymaga CI.
Push przez deploy key uruchamia Release, dlatego Promote i Back-merge do `next` nie wykonują
dodatkowego dispatchu. Back-merge do `dev` nadal dispatchuje Release z `expected_sha` commita merge.
Wszystkie checkouty, wywołane CI, buildy, metadane obrazów, manifesty i back-merge używają
`EXPECTED_SHA` z wejścia dispatchu albo `github.sha`. `plan` i `release` sprawdzają zgodność
checkoutu oraz `git merge-base --is-ancestor <sha> origin/<branch>` po świeżym fetchu.
Nowe commity na gałęzi nie przerywają wydania: trafiają do następnego przebiegu. Usunięcie
przypiętego SHA z historii (force push) zatrzymuje przebieg, także tuż przed pushem tagu.

`scripts/semantic-release.mjs` przygotowuje prywatne bare lustro z gałęziami, wszystkimi tagami
i notes. Wyłącznie ref wydawanej gałęzi w lustrze wskazuje `EXPECTED_SHA`. semantic-release
25.0.9 dostaje to lustro jako `repositoryUrl`, więc jego kontrola pushu nie odrzuca starszego
SHA ani nie podciąga nowszych commitów. Analyzer, numeracja kanałów, `EXPECTED_VERSION`
i format tagu pozostają z `release.config.mjs`. Generator notatek dostaje prawdziwy URL
repozytorium, aby zachować linki porównań i commitów. Plugin GitHub jest wyłączony w tym
wywołaniu: z lokalnego URL nie odczytałby owner/repo i sprawdzałby dostęp także w dry runie.

Przypięte semantic-release 25.0.9 ma poprawkę Bun w `patches/semantic-release@25.0.9.patch`:
czyta metadane każdego tagu z jego własnego refa `refs/notes/semantic-release-<tag>`;
wspólny stary ref `refs/notes/semantic-release` służy tylko jako fallback. Bez poprawki
`getTagsNotes` parsuje `git log --format=%d%x09%N --notes=refs/notes/semantic-release*`:
dla kilku tagów na jednym commicie przypisuje pierwszą notatkę wszystkim tagom,
a kolejne notatki pomija. Po promocji nightly → beta może więc przypisać nightly kanał beta;
`getLastRelease` odrzuci wtedy najnowsze nightly i wyliczy ponownie jego zajęty numer.
`git tag --merged`, fetch notes, przypięte lustro i analyzer nie gubią tagu.
Poprawka zachowuje osobne kanały przy promocjach, wspólnych tagach stable/beta/nightly
i back-merge; nie zmienia wersji, tagów ani notes. Plan i release nakładają tę samą poprawkę
z rewizji workflow także po instalacji zależności starszego przypiętego źródła;
niezgodna zależność zatrzymuje przebieg. Kopiują też aktualny analyzer i guard wersji.

Po checkach semantic-release tworzy tag i notes w lustrze; wrapper atomowo wysyła do origin
wyłącznie tag wydania i notes, bez force i bez pushu gałęzi. Następnie API GitHuba tworzy
ukryty draft z tym samym tytułem, notatkami i flagą prerelease, wskazujący przypięty SHA.
Artefakt Actions `release-revision` przekazuje ten SHA i gałąź kanału do promocji oraz osobnego workflow Mobile release;
`workflow_run.head_sha` może być inne przy dispatchu starszego commita. Mobile pobiera artefakt
wyłącznie z zakończonego przebiegu z zielonym jobem `release`, przed swoim checkoutem.
Promocja rozpoznaje również recovery dispatch uruchomiony z nowszym toolingiem na `dev`
dla starszego SHA na `next`: czyta `release-sha` i `release-branch` z artefaktu tego konkretnego
przebiegu, zamiast przypisywać mu `head_sha`/`head_branch` refa dispatchu. Nie wymaga odczytu inputs API.
Wymaga pełnego SHA, zgodnej gałęzi, publicznego wydania z manifestem na tym SHA oraz sukcesu
CI, wszystkich czterech smoke i `publish-desktop` w zakończonym zielonym przebiegu.
Sam zarezerwowany tag, artefakt albo zielony przebieg z pominiętą publikacją nie wystarcza.
Artefakt rewizji zachowujemy 90 dni; starsze artefakty z retencją 7 dni działają do wygaśnięcia.
Brak, niepełna rewizja (starszy artefakt bez gałęzi) lub wygaśnięcie artefaktu nie daje dispatchowi
dowodu gotowości. Zwykłe push/schedule nadal używają SHA zdarzenia.
Podsumowanie promocji podaje wybrany recovery run i wynik jego bramki dla kandydata C0,
także gdy niezależny hold zatrzymuje samą promocję.
Lustro jest usuwane również po błędzie. Konflikt istniejącego tagu lub notes zatrzymuje push.
Awaria API po pushu może zostawić tag i notes bez GitHub Release; ponowienie odzyskuje
tę rezerwację według procedury poniżej.

### Limit notatek i odzyskiwanie po awarii draftu

Notatki zawierają wyłącznie nagłówki commitów, bez opisów PR i treści `BREAKING CHANGE`.
Sekcje pozostają zgodne z parserem What's new: Features, Bug Fixes i Performance Improvements,
w tej kolejności. Wersję nadal wyznacza analyzer na pełnych commitach, łącznie z breaking changes.
Wspólny limit `scripts/release-body.mjs` wynosi 124 000 jednostek UTF-16, poniżej limitu
GitHuba 125 000 znaków. Zbyt długi wynik zachowuje całe wpisy, zaczynając od funkcji i poprawek,
oraz dopisuje „… and N more changes” i link porównania. Limit obejmuje tworzenie draftu,
zastępcze generowanie notatek przy uploadzie, końcowy PATCH publikacji i snapshot release-index
(także po późniejszej ręcznej edycji body). Błąd API pokazuje komunikat oraz pola walidacji
z odpowiedzi JSON; nie wypisuje żądania, środowiska procesu ani wartości credentiali.

Przed semantic-release wrapper szuka tagu bieżącego kanału **dokładnie na `EXPECTED_SHA`**.
Jeśli GitHub Release nie istnieje, wymaga zgodnych notes `semantic-release-<tag>` i odtwarza
notatki od poprzedniego tagu stable lub tego samego kanału. Dry run zwraca tę samą wersję,
tag i kanał z `published=true`, bez zapisów; właściwy job tworzy brakujący draft.
Nie wywołuje wtedy semantic-release, nie tworzy kolejnego numeru, nie przesuwa tagu ani notes.
Istniejący draft wznawia publikację bez ponownego POST; wydanie publiczne kończy plan bez
nowego wydania. Niezgodny `EXPECTED_VERSION`, brak metadanych kanału, wiele pasujących tagów
lub przepisana historia kończą przebieg błędem. Błąd odczytu API nie oznacza braku wydania.

`workflow_dispatch.release_branch` wybiera `dev`, `next` lub `main`; domyślne `current`
zachowuje wybór z ref workflowu. Wspólne blokady używają **gałęzi wydania**, także gdy kod
workflowu pochodzi z `dev`. Joby plan/release oraz upload używają narzędzi z `github.workflow_sha`,
ale źródła aplikacji, checki i wszystkie artefakty nadal pochodzą z `EXPECTED_SHA`.
Artefakt `release-revision` przekazuje Mobile release także gałąź kanału, żeby recovery z `dev`
nie wybierało nightly zamiast beta/stable. Starsze artefakty nadal korzystają z ref przebiegu.
Pozwala to naprawić publikację starego SHA bez zmieniania jego tagu ani gałęzi kanału.

Dla osieroconego `v0.2.0-beta.1` na `31c7f87825b9756d8b1adf677f506519f248f770`,
po merge poprawki do `dev`, maintainer uruchamia **nowy dispatch z `dev`**:

```sh
gh workflow run release.yml --repo itsoltech/canopy --ref dev \
  -f release_branch=next \
  -f expected_sha=31c7f87825b9756d8b1adf677f506519f248f770
```

Zwykłe Re-run starego przebiegu ani dispatch z niezmienionego `next` nie wczytają poprawki.
Nie trzeba tworzyć/usuwać tagu, zmieniać notes ani ponownie wykonywać Promote.
Plan poda `0.2.0-beta.1`; checki i buildy wystartują ponownie, a `release` utworzy draft
na istniejącym tagu. Dalej obowiązuje zwykła kolejność images → publish-server → publish-desktop
→ release-index. `backmerge` działa tylko dla stable, a nightly-hygiene tylko dla nightly,
więc beta pomija oba zgodnie z dotychczasowymi warunkami. Wymagane podpisy i kompletny zestaw
artefaktów nadal blokują publikację; udane wcześniejsze checki nie omijają tych bramek.

Wszystkie przebiegi danej gałęzi (push, schedule i dispatch) mają wspólną grupę całego workflow
z `cancel-in-progress: false`: aktywny przebieg kończy się bez anulowania, a spośród oczekujących
pozostaje tylko najnowszy. Kolejny cykl czeka lub zostaje zastąpiony nowszym oczekującym,
nigdy nie publikuje równolegle. Ceną jest oczekiwanie także na desktop/notaryzację aktywnego nightly.
Nie wolno włączyć `cancel-in-progress: true`: aktywny przebieg może już publikować.
`dev`, `next`, `main` i poszczególne tagi mają odrębne grupy `release-<ref>`, więc różne kanały
zachowują równoległe buildy. Push i ręczny dispatch tej samej gałęzi nie publikują równolegle.
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
                └─ stop-builds (checki czerwone / błąd wydania)          ├─ nightly-hygiene / backmerge
```

| Job | Co robi | Kiedy startuje | Publikuje |
| --- | --- | --- | --- |
| `checks` | `ci.yml` | po `plan`; na `dev` tylko gdy `published=true` | — |
| `plan` | semantic-release **`--dry-run`** na przypiętym lustrze: `version`, `tag`, `channel`, macierz desktop | od razu; grupa `release-version-<ref>` | nic (próba pushu tylko do lustra) |
| `binaries`, `smoke` | cross-compile wszystkich celów; `--version` każdej binarki na jej OS/arch | po `plan`, równolegle z checkami | — (artefakt Actions) |
| `images-build` | buildx amd64+arm64 do cache GHA (`mode=max`), bez pushu i atestacji | po `plan` | — |
| `desktop` | Linux, macOS (Apple Silicon), Windows; podpisy i notaryzacja | po `plan` | — (artefakt Actions) |
| `release` | semantic-release na lustrze, atomowy push tagu/notes i draft przez API GitHuba | po **zielonych `checks`**; grupa `release-version-<ref>` | tag + ukryty draft |
| `images` | ten sam build z cache, push wyłącznie niezmiennego `vX.Y.Z` (SBOM) | po `release` i `images-build` | obraz `vX.Y.Z` |
| `publish-server` | binaria, `checksums.txt`, `manifest.json` na drafcie | po `checks`, `release`, `binaries`, `smoke`, `images`; grupa `release-publish-<ref>` | nic publicznego |
| `publish-desktop` | instalatory, blockmapy, scalone feedy, nowe `checksums.txt`/`manifest.json`; weryfikacja, publikacja, aliasy obrazów | po `publish-server` i sukcesie wymaganych celów desktop; ta sama grupa publikacji | kompletny release |
| `release-index` | współdzielony workflow Pages: aktualna strona i indeks wszystkich publicznych wydań | po sukcesie `publish-desktop` | atomowy snapshot CDN |
| `stop-builds` | `gh run cancel` własnego przebiegu | checki czerwone albo `release` bez wydania/anulowany | — |
| `nightly-hygiene`, `backmerge` | jak wcześniej | po `publish-desktop`; brak wydania pomija oba | — |

**Nic nie jest publikowane przed zielonymi testami.** Równolegle z `checks` powstają wyłącznie artefakty
Actions i cache buildx (prywatne dla repozytorium). Tag, GitHub Release, obraz w GHCR, assety
release i aliasy obrazów zależą od `release`, a ten od `checks`. Dry run nie tworzy tagu ani notes;
wystarcza `contents: read`, bo próba pushu semantic-release dotyczy lokalnego lustra.

**Wersja z planu.** Buildy dostają wersję z `plan`. `release` uruchamia semantic-release
z `EXPECTED_VERSION`; plugin `scripts/release-expected-version.mjs` (krok `verifyRelease`, przed
utworzeniem tagu) odrzuca inną wersję, a krok po nim porównuje wynik jeszcze raz. Rozjazd kończy
przebieg błędem bez tagu: użyj **Re-run all jobs** (nowy plan i buildy). `plan` i `release`
dzielą grupę `release-version-<ref>`. Blokada całego workflow `release-<ref>` obejmuje również
czas między planem a tagowaniem: drugi przebieg tej gałęzi zaczyna plan dopiero po zakończeniu
pierwszego i pobiera jego tagi/notes. Nie ma okna na dwa plany tej samej wersji w jednej gałęzi.

Ten sam hook `verifyRelease` sprawdza dokładny ref `refs/tags/<nextRelease.gitTag>`,
także w dry runie i bez `EXPECTED_VERSION`. Istniejący tag zatrzymuje plan przed generowaniem
notatek, prepare i tagowaniem, z komunikatem o zajętym numerze i sprawdzeniu metadanych kanału.
Nie pomijamy automatycznie numerów: konflikt może oznaczać niewłaściwy zakres commitów,
inną historię albo uszkodzone metadane, więc sam wolny kolejny numer nie dowodzi poprawności.
Nieudany odczyt refa również blokuje wydanie. Wyścig po sprawdzeniu nadal zabezpiecza
atomowy push bez force. Odzyskiwanie istniejącego tagu na dokładnym SHA pozostaje osobną
ścieżką: wznawia tę samą rezerwację, bez próby ponownego tagowania.

Po scaleniu poprawki odczytu kanałów do `dev` nie trzeba wykonywać żadnego polecenia
odzyskiwania, przesuwać tagów ani ponawiać Promote. Najbliższy harmonogram o :40 UTC
zobaczy istniejące `v0.2.0-nightly.147` i dla kolejnych releasowalnych commitów zaplanuje
`0.2.0-nightly.148`, o ile wcześniejszy przebieg nie zarezerwował już tego numeru.

**Przesunięta gałąź.** Nowy commit przed `plan` albo podczas checków nie anuluje aktywnego
wydania. Tag nadal wskazuje SHA startowe. `stop-builds` zatrzymuje buildy i notaryzację przy
czerwonych checkach, przepisanej historii lub innym błędzie rezerwacji wersji. GitHub nadal
zastępuje starszy oczekujący przebieg nowszym; aktywnego nie anuluje. Na `dev` późniejsze
commity zbiera następny cykl godzinowy lub dispatch, nie sam push.

**Atomowa publikacja dla updaterów** (`scripts/release-upload.ts`, oba etapy można powtarzać):

1. Tag musi wskazywać `EXPECTED_SHA` (przekazane jako `GITHUB_SHA` do skryptów publikacji),
   a wersja, kanał i flaga prerelease muszą się zgadzać.
   Wrapper tworzy **draft**, zachowując semantykę `draftRelease: true`; ścieżka tagowa tworzy draft przy
   pierwszym uploadzie. Hook `addChannel` jest wyłączony: plugin GitHub może w nim utworzyć
   publiczny release mimo `draftRelease`. Promocje beta/stable budują własną wersję przez ten
   sam workflow, bez publikowania pustych kopii ani przełączania istniejących wydań.
2. `publish-server` wgrywa binaria i pliki zbiorcze wyłącznie na draft. Nie udostępnia jeszcze
   aktualizacji gatewaya/workera, instalatora workera ani nowych aliasów obrazów.
3. Kolejność uploadu: binaria/instalatory/blockmapy → feedy `*.yml` → `checksums.txt` → `manifest.json`.
   `--clobber` wolno używać wyłącznie na drafcie. Pasujące assety są pomijane przy ponowieniu.
4. `publish-desktop` pobiera ponownie artefakt `binaries` i wszystkie gotowe `desktop-*`, scala feedy,
   liczy `checksums.txt`/`manifest.json` od nowa (wpisy serwerowe są identyczne, dochodzą `app: desktop`),
   wgrywa brakujące lub zmienione pliki. `--publish` wymaga wszystkich binariów, instalatorów,
   blockmap macOS/Windows oraz feedów dla Windows (`<kanał>.yml`), macOS (`<kanał>-mac.yml`)
   i Linux (`<kanał>-linux.yml`). Stable wymaga aliasów latest/beta/nightly, beta beta/nightly,
   nightly nightly. Obecny eksperymentalny linux-arm64 musi mieć też swój instalator i feedy.
   Po uploadzie skrypt sprawdza przez paginowane API **stan `uploaded`, rozmiar i SHA-256 każdego
   pliku**, łącznie z feedami i plikami zbiorczymi. Dopiero potem jednym PATCH ustawia `draft=false`;
   prerelease nigdy nie staje się `latest`, stable korzysta z wyboru GitHuba według wersji.
5. Aliasy obrazów (`nightly`, `beta`, `stable`, `latest`, `vX`, `vX.Y`) przesuwa
   `scripts/image-aliases.ts` (`docker buildx imagetools create`) **tylko do przodu**: alias wskazujący
   nowszą wersję (adnotacja `org.opencontainers.image.version` indeksu) zostaje. `publish-desktop`
   jest serializowany per gałąź, więc dwa przebiegi nie cofną aliasu. Poprawka starszej linii stable
   przesuwa `vX.Y`, ale nie `latest`/`stable`. Aliasy zmieniają się dopiero po publikacji release.

Po sukcesie `publish-desktop` job `release-index` wywołuje `.github/workflows/pages.yml`.
Skrypt `scripts/release-index.ts` pobiera wszystkie strony Releases przez uwierzytelnione
`gh` z `GITHUB_TOKEN` joba. Zapisuje `dist/site/releases/v1.json` (`schema: 1`): tagi,
prerelease, daty publikacji, notatki i nazwy/URL-e assetów. Pomija drafty, wydania bez
manifestu/sum oraz pliki w stanie innym niż `uploaded`; wymaga obecności właśnie
opublikowanego tagu. Waliduje wynik tym samym dekoderem co klient przed uploadem Pages.
Weryfikacja rozmiarów i hashy oraz kompletności platform nadal odbywa się w
`release-upload.ts` **przed** upublicznieniem release; indeks jest tylko listą.

Ten sam krok zapisuje `dist/site/releases/notes-v1.json` (`schema: 1`). Generator
`scripts/release-notes.ts` parsuje sekcje Features, Performance Improvements i Bug Fixes
z tych samych publicznych GitHub Releases. Zapisuje wersję, datę i wpisy: typ
`feat`/`perf`/`fix`, scope, tekst bez prefiksu Angular oraz numer i URL PR-a (lub null).
Usuwa odnośniki do commitów, zachowuje tekst etykiet Markdown i kapitalizuje początek.
Generator scala bieżące wydania z poprzednim indeksem notatek Pages, więc retencja
GitHub Releases nie usuwa już opublikowanej historii. Bieżący body zastępuje starszy
wpis tej samej wersji. Tylko HTTP 404 oznacza pierwsze wdrożenie; inny błąd odczytu
przerywa publikację, zamiast skasować archiwum. Każdy kanał zachowuje najwyżej 200
najnowszych wersji; `truncated` wymienia kanały ze starszą, pominiętą historią.
Pierwszy indeks obejmuje dostępne wówczas wydania; nie odtwarza usuniętych bodies.
Notatki nie zastępują pełnego indeksu pobrań ani
GitHub Releases. Generator i parser są testowane lokalnie na fixture bodies,
bez publikacji tagów lub wykonywania workflowu wydania.

Pages wdraża stronę i indeks jednym artefaktem, serializowanym wspólną grupą `pages`
dla wszystkich kanałów i zwykłych zmian strony. Strona/skrypty pochodzą z bieżącego `dev`,
żeby wydanie starszej linii stable nie cofnęło strony OAuth. Zwykłe wdrożenie Pages
również odtwarza indeks z publicznych wydań, więc go nie usuwa. Awaria generowania
lub wdrożenia zachowuje poprzedni snapshot. Repo musi mieć Pages w trybie GitHub Actions;
workflow nie zmienia ustawień repozytorium. Klienci nie dostają tokena.

Klient sprawdzający kanał w dowolnej chwili widzi poprzedni release albo nowy z kompletem plików.
Dotyczy to również resolvera gatewaya/workera, instalacji workera i pobrań dokładnego tagu;
tag git może istnieć wcześniej, ale draft nie jest publicznym źródłem pobrań. Awaria wymaganego
desktopu lub weryfikacji pozostawia cały release ukryty. Ponowienie kontynuuje ten sam draft.
Po udanym PATCH, także gdy odpowiedź zaginęła lub zawiódł późniejszy krok aliasów, skrypt rozpoznaje
publiczny release i nie zmienia już jego assetów. Przejściowe błędy odczytu GitHuba nadal korzystają
z retry z #320; wyczerpanie retry przerywa publikację, zamiast udawać brak release.
Zapisów nie ponawiamy automatycznie — ich skutek sprawdza ponowiony job.
`promote.ts` nadal wymaga zielonego Release i liczy burn-in od późniejszego z `published_at`
oraz `manifest.json.updated_at`. Mobile uruchamia osobny pipeline EAS/TestFlight/OTA dopiero po
zielonym Release; nie pobiera instalatorów ani feedów desktopu z GitHuba. Opcjonalny krótszy retry
desktopu pominięto: nowy przepływ usuwa stan „publiczny release bez feedu”, a zmiana trwałego
harmonogramu sprawdzeń wymagałaby osobnej polityki.

**Cele desktopu.** linux-x64, darwin-arm64 i windows-x64 są pełnymi, wymaganymi celami
nightly, beta i stable. Tylko linux-arm64 pozostaje eksperymentalny (`continue-on-error`):
buduje go beta i stable, a nightly tylko przy ręcznym dispatchu z `desktop_all_targets: true`
(dispatch wymaga `expected_sha` z historii gałęzi i wydaje tylko, gdy są niewydane commity).

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
| binaria i `manifest.json` na ukrytym drafcie | ~9–11 min |
| artefakt desktop Linux gotowy do uploadu | ~12–14 min |
| **kompletny publiczny release i aliasy obrazów** (po macOS i Windows) | **~30–35 min**, zależnie od podpisów/notaryzacji |

Czasy są orientacyjne; CI startujące po planie wymaga potwierdzenia na GitHubie.
Merge do `dev` czeka na najbliższy cykl godzinowy, a nowy przebieg dodatkowo na zakończenie
całego aktywnego nightly. Ręczny dispatch omija oczekiwanie na cron, ale nie blokadę przebiegów.

### Ponowienia i błąd notaryzacji

- Po błędzie buildów albo publikacji użyj **Re-run failed jobs**: zachowuje wyjścia `plan`/`release`
  i powtarza nieudane joby z zależnymi. Ponowienie całego workflow po utworzeniu tagu kończy się
  „no release”, bo tag już istnieje. Artefakty buildów Actions żyją 7 dni, a artefakt rewizji 90 dni.
  Ponowiony job `release` może też zwrócić „no release”, gdy inne recovery opublikowało już tag.
  Wtedy `stop-builds` nadal anuluje cały przebieg, aby zatrzymać kosztowne buildy i notaryzację;
  API Actions nie pozwala anulować samych pojedynczych jobów. Nie zamieniamy tego w zielony
  dowód nowej publikacji. Promocja wybiera nowszy recovery po numerze przebiegu, a dopiero
  przy tym samym numerze porównuje próbę: późniejsze ponowienie starszego pushu nie zastępuje recovery.
- **Notaryzacja macOS zawiodła** (timeout Apple, odrzucenie, wygasła umowa/klucz): release pozostaje
  draftem, wszystkie updatery i aliasy obrazów zostają na poprzedniej wersji.
  Sprawdź log `desktop (darwin-arm64)` (status zgłoszenia `notarytool`,
  ważność sekretów i umów Apple), napraw przyczynę i użyj **Re-run failed jobs** — przebuduje macOS
  i powtórzy `publish-desktop`, który dopisze assety mac, przeliczy feedy, sumy i manifest,
  zweryfikuje cały zestaw i opublikuje draft.
  Ponowienie działa także po tym, jak nowszy przebieg wydał już kolejny nightly.
- Ręczny stabilny tag musi należeć do historii `main`; ścieżka tagowa tworzy release przy uploadzie.

### Do potwierdzenia na pierwszych przebiegach

GitHub Actions nie da się uruchomić lokalnie. Na pierwszych przebiegach `dev` sprawdź:
`plan` (dry run z `contents: read`) podaje wersję i nie tworzy tagu; `release` rezerwuje tę samą wersję;
`images` korzysta z cache `images-build` (krótki build); `imagetools inspect` czyta adnotację wersji
aliasu (log `stays at`/`→`), a `imagetools create` zachowuje obie platformy i SBOM; `release-upload.ts`
podmienia `manifest.json`/`checksums.txt` przez `.next` (brak pozostałych plików `.next`);
`publish-desktop` widzi artefakty z poprzedniej próby po **Re-run failed jobs**; `stop-builds`
anuluje przebieg z błędem checków lub wydania. Gdy podczas aktywnego nightly trafi zwykły merge,
sprawdź, że tag, manifest i rewizja obrazu nadal wskazują SHA startowe, draft pozostaje ukryty
do pełnej weryfikacji, a kolejny naturalny cykl obejmuje późniejszy commit z kolejnym numerem
nightly. Nie wymaga to force pushu ani ręcznego dispatchu. Dwa merge'e przed cyklem dają jeden nightly z obu commitów;
kolejny cykl na tym samym SHA albo po samych `docs` pomija `checks` i buildy.
Sprawdź też wspólną kolejkę schedule/dispatch i wywołanie Mobile release tylko po rzeczywistej publikacji.

Bez certyfikatu macOS otrzymuje podpis ad-hoc. Windows beta/stable wymagają Azure
Trusted Signing; nightly podpisuje przy komplecie trzech sekretów Azure, a bez
niego buduje unsigned z notice. Podjęta próba podpisania zawsze wymaga poprawnego
wyniku. Instalator i wszystkie `.exe` paczki (w tym aplikacja i Bun sidecarów)
muszą przejść `Get-AuthenticodeSignature` ze statusem `Valid` i wydawcą ITSOL;
błąd blokuje upload Windows. Szczegóły: [desktop.md](desktop.md#podpisywanie-windows).
PR-y nie budują Windows. Ręcznie uruchamiany `desktop-windows.yml` (`workflow_dispatch`) buduje
na `windows-2025`, podpisuje i weryfikuje podpisy.
Instaluje NSIS, sprawdza `--version` zainstalowanych gatewaya/workera i zachowuje
artefakt przez 3 dni, bez publikacji wydania. Nie potwierdza zachowania SmartScreen.
Konfiguracja certyfikatu macOS włącza obowiązkowy signing,
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
Filtrowanie zachowuje hierarchię kanałów stable → beta → nightly. Starsze wydania mogą
nie mieć feedu danej platformy; klient nadal je pomija. Nowe wydania są publiczne dopiero
po przygotowaniu desktopu, więc brak feedu nie jest już zwykłym etapem publikacji.

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
5. Windows: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` należą do
   service principal Azure konta Trusted Signing **ITSOL**, z rolą **Trusted Signing
   Certificate Profile Signer** na profilu `canopy`. Wszystkie trzy są obowiązkowe
   dla beta/stable; nightly bez pełnego kompletu jest unsigned. Jawne pola
   `publisherName`, `endpoint`, `certificateProfileName` i `codeSigningAccountName`
   są w `build.win.azureSignOptions`; [wartości i kontrola podpisu](desktop.md#podpisywanie-windows).

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

# Windows Azure Trusted Signing: obowiązkowe dla beta/stable, opcjonalne dla nightly.
gh secret set AZURE_TENANT_ID
gh secret set AZURE_CLIENT_ID
gh secret set AZURE_CLIENT_SECRET
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
   `Verify macOS signatures and notarization`. Ich błąd blokuje publikację całego release,
   przesunięcie aliasów obrazów i promocję; binaria pozostają na drafcie.
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
Podstawą tego czasu pozostaje `landedAt` (`git show --format=%ct`).
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
   nawet jeżeli są już starsze niż soak, z uwzględnieniem limitu automatycznych holdów.
   Stable sprawdza dodatkowo poprawki na dev, których nie ma jeszcze w next: znana naprawa
   bety zatrzymuje stable, dopóki nie wejdzie do bety i nie przejdzie jej burn-in, z limitem opisanym poniżej.
   Rozbieżność next/dev zatrzymuje tę ścieżkę do Back-merge; commity dev są tu tylko sygnałami, nigdy kandydatami stable.
   Jeżeli funkcja i poprawka są już po soak i obie mieszczą się w cutoffie, idą razem.
   Automatyczny hold z powiązania (jawny link, revert lub blame) wygasa po **więcej niż 2 dniach
   dla dev → next** albo **3 dniach dla next → main**, liczonych od istniejącego `since`:
   kwalifikacji czasowej wstrzymanej zmiany na danej ścieżce (dev: data commitera + 24 h;
   stable: najwcześniejsza gotowa beta zawierająca zmianę + burn-in). Kolejne poprawki i ich
   łańcuchy nie przesuwają tego początku. Po wygaśnięciu zmiana może wejść bez oczekującej
   naprawy; naprawa wejdzie w późniejszej promocji. Limity skryptu można nadpisać przez env
   `DEV_NEXT_HOLD_CAP_DAYS` i `NEXT_MAIN_HOLD_CAP_DAYS` (całkowite 0–365 dni).
   Nigdy nie wygasają: etykieta `promotion-hold`, otwarte `release-blocker`, pauza
   `AUTO_PROMOTION=off`, wymaganie udanego Release dokładnie dla C, sam burn-in bety ani
   wymóg wspólnej promocji oryginału i jego revertu, gdy oba są w czasowym cutoffie C0.
   Ręczny Promote i override zachowują dotychczasowe zasady.
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
   Push przez deploy key uruchamia dokładnie jeden Release z `EXPECTED_SHA=C` ze zdarzenia push;
   skrypt nie wykonuje dispatchu. Hotfix PR scalony do `next`/`main` uruchamia tę samą ścieżkę.
   `C == target`, brak bootstrapu stable lub zakres bez zmiany wersji oznacza no-op; docs-only
   nie tworzy bety. Każdy przebieg zapisuje C0, C, wersję oczekiwaną, listę włączoną i wykluczoną
   oraz przyczyny hold w job summary, w tym pominięte blokady jako `hold expired after 3 d: <reason>`
   (dla bety: `2 d`). Wersja jest prognozą z tego samego analyzera Angular;
   Release wyznacza ją ponownie. Issue `Promotion history: <path>` przechowuje historię planów
   przed pushem (nie stanowi dowodu udanej publikacji; dowodem jest przebieg Release).
5. **Brak postępu.** Jeśli nadal aktywny hold lub `release-blocker` zatrzymuje zmianę przez co najmniej
   **7 dni od jej kwalifikacji czasowej**, tworzymy/aktualizujemy `Promotion stalled: <path>`
   z SHA i powodem (konkretna poprawka oraz PR/SHA/pliki albo etykieta/bloker). Wygasłe holdy
   nie wywołują tego alertu; etykiet i blokerów nie obchodzimy automatycznie.

**Koszt odczytu.** Skrypt stronicuje listę przebiegów `release.yml` i zamkniętych PR-ów
do `dev`/gałęzi źródłowej, a następnie wiąże je lokalnie przez dokładny SHA. Listę przebiegów
filtruje lokalnie, aby nie obciąć historii na limicie 1000 wyników filtrowanego wyszukiwania
Actions. Artefakt rewizji pobiera tylko dla dispatchów z zaufanych gałęzi wydania.
Joby pobiera dopiero dla rozważanego kandydata: smoke bez opublikowanego tagu albo pełne
dowody CI/smoke/publikacji recovery;
preferencja tagów, najnowszego przebiegu i jego próby pozostaje bez zmian.
Recheck ponownie odczytuje publikacje, PR-y, CI i blokery. Wykorzystuje wyłącznie niezmienne
dane git z pierwszego odczytu; zmianę jawnych linków w body PR uwzględnia także w atrybucji.
Pusty zakres nie pobiera publikacji, PR-ów ani przebiegów. Limit workflow pozostaje 10 minut.

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
Numery odnoszą się do PR-ów tego repozytorium. Jawny link ustala powiązanie bez ograniczenia wieku
i plików; automatyczny hold nadal podlega opisanemu wyżej limitowi.

**Heurystyka awaryjna (SZZ).** Przy braku jawnego linku przypisujemy zmienione/usunięte
linie do commitów, które je wprowadziły. `git diff -w --ignore-blank-lines -U0 F^ F`
wyznacza zakresy pre-image; `git blame --porcelain -w -M -C -L start,end F^ -- <file>`
sprawdza tylko te zakresy, ignorując whitespace i śledząc przeniesienia/kopie linii.
Blame pomija też rewizje wymienione w wersji `.git-blame-ignore-revs` z `F^`, żeby
repozytoryjne formatowanie z przełamaniem linii nie przejmowało autorstwa naprawianego kodu.
Brakujące rewizje sprzed squasha pomija po cichym sprawdzeniu ich istnienia; pełny checkout
(`fetch-depth: 0` w obu workflowach) nie przywraca obiektów, które nigdy nie trafiły do historii.
Zmiana samego whitespace nie tworzy powiązania. Dla hunków będących wyłącznie dopiskiem
sprawdzamy bezpośrednią linię przed i po wstawieniu: obie muszą wskazywać ten sam commit.
Na początku/końcu pliku wystarcza jedyny istniejący sąsiad. Przy różnych właścicielach,
nowym lub pustym pliku nie przypisujemy dopisku do nikogo. Powiązanie zatrzymuje promocję
tylko dla oryginału w `(target, C]`, gdy poprawka trafiła na gałąź 0–7 dni po nim;
blame wskazujący już wydany commit lub commit poza prefiksem nie zatrzymuje prefiksu.
Blame nie wskazuje commitów `docs`, `test`, `ci`, `chore` ani `style`: nie zmieniają one
działania wydania, więc nie mogą być zmianą, którą poprawka naprawia (jawny link nadal działa).
Raport pokazuje SHA właściciela, plik i numery linii sprzed poprawki. Pomijamy:

- `packages/contracts/src/gen/**`, `packages/codex-protocol/src/gen/**`;
- `packages/db/src/migrations/index.ts`, `packages/db/test/schema.test.ts`;
- `docs/**` oraz `AGENTS.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md` w katalogu głównym;
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
Gdy zapis historii po udanym pushu zawiedzie, następny cykl naprawia wyłącznie issue z planem
i SHA. Nie ponawia pushu ani nie dispatchuje Release, również dla istniejących znaczników
`canopy-promotion-pending`. Historia odróżnia zamiar przed pushem od jego potwierdzenia;
wynik publikacji pozostaje w Release. Nowa poprawka lub hold po pushu wpływa na kolejną
promocję, nie zatrzymuje już uruchomionego wydania. Nieudany Release ponawiaj przez
**Re-run all jobs**; brakujący przebieg uruchom ręcznie z aktualnym `expected_sha`.

Po stable **Back-merge** przenosi hotfix `main` → `next` → `dev` commitami merge bota.
Push do `next` uruchamia Release; po pushu do `dev` skrypt wykonuje jeden dispatch z SHA merge'a,
bo `dev` nie ma triggera push Release. Dla promocji bez rozbieżności jest to no-op.
Przy konflikcie otwiera PR i zatrzymuje dalsze przenoszenie. Po rozwiązaniu konfliktu i squash
merge PR uruchom Back-merge ponownie: dopisze merge commit przywracający relację przodków.
PR utworzony przez `GITHUB_TOKEN` nie uruchamia workflowów PR. Jeśli brakuje wymaganych
checków, maintainer zamyka i ponownie otwiera PR, aby uruchomić CI oraz commitlint przed scaleniem.

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
   Drafty są pomijane przez retencję, także gdy mają już serwerowy `manifest.json`;
   pozostają do ponowienia albo ręcznego porządkowania przez maintainera.
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
przycięciu releases. Wydanie to nie dotyka — `nightly-hygiene` startuje po `publish-desktop` i nic od
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
  `Typecheck, tests, builds` i `commitlint` (workflow PR title), oba z integracji GitHub Actions
  **15368**. Stopka `BREAKING CHANGE` musi zostać w body squasha.
- Promocje są pushami **fast-forward**, back-merge bezpośrednimi commitami merge bota — nie
  korzystają z przycisku merge PR. Nie wymagaj linear history dla back-merge. Rulesety gałęzi
  nie obejmują tagów ani notes semantic-release.
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
- GitHub „immutable releases” pozostaw wyłączone ze względu na retencję nightly, która usuwa
  stare wydania i zachowuje tagi. Upload kończy się przed publikacją; ponowienia nie zmieniają
  publicznych assetów. Zmiana ustawienia nie jest częścią tej procedury.

### Rulesety i deploy key

Maintainer konfiguruje rulesety poza repozytorium. Aktywny ruleset
**Release branches: no deletion or force-push** chroni `dev`, `next`, `main` przed usunięciem
i force-pushem. Po scaleniu obsługi deploy key włącz dodatkowo:

- `dev`: `pull_request`, squash, **0 approvals**, wymagane oba checki wymienione wyżej;
  bypass **DeployKey / always** dla klucza automatyzacji wydań.
- `next` i `main`: ograniczenie aktualizacji (**update restricted**), bypass tego samego
  **DeployKey / always** oraz roli **repository admin / pull_request**.

Przed włączeniem nowych ograniczeń aktualizacji doprowadź promocjami commit zawierający
obsługę klucza na `next` i `main`. Release wywołuje lokalny workflow Back-merge z commita
wydania; starsza kopia nadal używa `GITHUB_TOKEN` i zostałaby zablokowana. Sama zmiana `ci`
nie tworzy wydania — musi wejść w promowany prefiks z kolejną zmianą wpływającą na wersję.

GitHub nie przyjmuje GitHub Actions (`GITHUB_TOKEN`) jako aktora bypass rulesetu. Zapis gałęzi
wykonują przez SSH joby `promote`, `review` i `backmerge` z write deploy key
**Release automation (promote, back-merge)**. Prywatna część klucza jest sekretem Actions
**`RELEASE_DEPLOY_KEY`**; nigdy nie trafia do logów ani repozytorium. Checkout utrzymuje
poświadczenia SSH do końca joba i usuwa je w kroku post-cleanup. Brak sekretu zatrzymuje job
z jawnym komunikatem błędu. Dry run Promote/Automatic promotion nie pobiera klucza i działa
bez niego. Wywołanie Back-merge z Release przekazuje tylko ten sekret jawnie.

`GITHUB_TOKEN` nadal obsługuje API (issue, PR, dispatch `dev`). Pozostałe joby Release używają
go do tagów, notes i GitHub Releases; konfiguracja semantic-release nie zawiera pluginu git
ani CHANGELOG-a i nie tworzy commitów na gałęziach. Nie dostają deploy key.
Nightly hygiene usuwa wyłącznie wydania nightly i wersje GHCR, pozostawiając tagi/notes;
Mobile release ustawia wersje jedynie w roboczych `app.json` i `canopy-version.json`, a build number prowadzi EAS;
Pages publikuje przez API Pages, bez pushu gałęzi. Te workflowy nie wymagają bypassu.

Maintainer nadal promuje ręcznie przez **Promote** (w razie potrzeby `override=true`,
z zachowaniem obowiązkowych bramek). Pilny hotfix trafia PR-em do `next` lub `main`;
repo admin scala go przez bypass w trybie `pull_request`, bez bezpośredniego pushu.
Scalenie uruchamia Release dla SHA hotfixu; po stable Back-merge przenosi go dalej.

### Wydania aplikacji mobilnej

Po publikacji `Release` workflow `Mobile release` (`mobile-testflight.yml`) obsługuje wszystkie
kanały: `dev` → `nightly`, `next` → `beta`, `main`/stabilny tag → `stable`. Wymaga sukcesu
joba `release` i właściwego tagu na SHA; kolejne przebiegi bez publikacji niczego nie wysyłają.
Zachowuje filtr zmian ścieżek mobile oraz zależnych workspace'ów. Wersja marketingowa pochodzi
z tagu bez prerelease (`v0.2.0-beta.1` → `0.2.0`), a numer natywny zwiększa EAS.
Wspólny krok `scripts/mobile-version.sh <tag>` zapisuje równocześnie pełną wersję Canopy
do modułu JSON bundlowanego z JS (`0.2.0-beta.1`). Settings pokazuje wersję działającego
bundle, więc także OTA aktualizuje ten numer. Plik JS nie jest wejściem natywnego fingerprintu,
a hook usuwa z niego wyłącznie `extra.canopyVersion`, zachowując pozostałą konfigurację.
Zmiana samego numeru nie wymusza nowego IPA/APK. Ręczne buildy Androida muszą
wywołać ten sam krok przed `eas build`; instrukcja i reset do `0.0.0-dev` są w
[mobile.md](mobile.md#wersja-działającego-bundle).

Fingerprint natywnego runtime jest liczony osobno dla iOS i Androida. Jeśli na kanale istnieje
ukończony store build iOS o tym runtime, wydanie JS trafia jako niepodpisane OTA zamiast nowego IPA.
Inaczej EAS buduje iOS i wysyła do TestFlight. Android jest zawsze budowany ręcznie; zgodny
zainstalowany APK otrzymuje OTA razem z iOS (`--platform all`). Kanały nie współdzielą gałęzi OTA.
Ponowienia korzystają z historii EAS i pełnego SHA w wiadomości; aktywne buildy są deduplikowane.
Pierwsze wydanie z `expo-updates` musi zbudować nową binarkę, OTA rusza od następnej zmiany JS.

EAS Starter nie obsługuje podpisywania OTA (wymaga Production lub Enterprise), co zablokowało
publikację `nightly.104` po PR #357/#360. Decyzją maintainera publikujemy bez podpisu kodu;
zaufanie opiera się na EAS i HTTPS, bez niezależnej weryfikacji podpisu Canopy. Przejęcie konta
lub usługi EAS może pozwolić na podmianę JS. `EXPO_TOKEN` nadal autoryzuje EAS. Sekret Actions
`EXPO_UPDATES_PRIVATE_KEY` pozostaje nieużywany na przyszły powrót podpisywania; workflow go
nie odczytuje. Usunięcie certyfikatu i metadanych podpisu zmienia fingerprint, więc następne
wydanie wymaga pełnego buildu iOS. IPA z `nightly.104` przyjmuje tylko podpisane aktualizacje
i nie otrzyma nowych OTA do czasu zastąpienia go nową binarką.

URL aktualizacji jest w `apps/mobile/app.json`, a wszystkie operacje OTA w
`scripts/mobile-publish-update.sh`; te dwie granice przygotowują migrację na firmowy serwer
protokołu Expo Updates. Wraz z nim wróci podpisywanie: konfiguracja certyfikatu, jego wejście
fingerprintu i nowe binarki weryfikujące podpisy. Szczegóły kanałów, ponowień i rollbacku:
[mobile.md](mobile.md#wydania-mobilne-testflight-i-ota).

## Bootstrap 0.1.0 — wykonuje rodzic

1. Po zielonym PR scal tę zmianę do `main` i pobierz jego HEAD. Przed pierwszym stabilnym tagiem
   push main kończy się „no release” (guard bootstrap), nawet jeśli squash ma typ `feat`.
2. Na HEAD main utwórz `git tag -a v0.1.0 -m 'Canopy 0.1.0'`, potem
   `git push origin main v0.1.0`. Tylko przebieg tagowy publikuje **0.1.0 stable**; przebieg main
   widzi tag na HEAD i brak nowych commitów. CI, wszystkie binaria/smoke i obrazy muszą przejść
   przed publicznym release; desktop, wszystkie feedy i manifest muszą być kompletne przed
   publikacją draftu. Sprawdź `v0.1.0/manifest.json` i publiczną widoczność GHCR.
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
Regresja z nightly.146 oraz nightly.147/beta.1 na jednym commicie wymaga nightly.148;
obejmuje lekki i adnotowany tag promocji. Kolejne publikacje sprawdzają ponowne promocje
oraz rozbieżne gałęzie z back-merge hotfixa stable. Zajęty tag spoza historii gałęzi blokuje
dry run i publikację, zarówno bezpośrednio przez konfigurację, jak i przez przypięte lustro,
bez zmiany refów lub utworzenia draftu.
Testy wrappera przesuwają gałąź przed planem i podczas checków dla nightly, beta oraz stable.
Pierwszy tag wskazuje przypięty SHA, notatki pomijają późniejsze commity, a drugi przebieg
wydaje późniejszy SHA z kolejnym numerem bez luk ani duplikatów. Draft zapisuje lokalny adapter
zamiast GitHuba. Inna niż zaplanowana wersja i SHA usunięty przez force push są odrzucane bez tagu.
Test etapów publikacji liczy sumy i manifest z samymi binariami, potem z jednym celem desktop, potem
po „ponowieniu” z brakującym celem: każdy asset manifestu istnieje i ma zgodny SHA-256, `checksums.txt`
obejmuje wszystkie pliki, wpisy serwerowe się nie zmieniają, a powtórka daje ten sam wynik.
`bun test scripts/release-upload.test.ts` sprawdza widoczność poprzedniej wersji aż do
końcowej publikacji dla wszystkich kanałów, brakujące platformy/aliasy/blockmapy,
przerwane uploady, utraconą odpowiedź publikacji, niezmienność publicznych assetów oraz
odmowę publikacji przy błędnym stanie, rozmiarze lub SHA-256 w API.
Testy updatera używają lokalnego fixture HTTP
z prereleases, paginacją i manifestami. Pełna publikacja wymaga uruchomienia workflow na GitHubie.
