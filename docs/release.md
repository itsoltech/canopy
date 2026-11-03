# Wydania: wersje, CI, artefakty

Jedna wersja dla wszystkich aplikacji (gateway, worker, web, desktop). Źródłem jest git:
tag `vX.Y.Z` dla wydań, commit na `main` dla buildów ciągłych. Wdrożenie: [deploy.md](deploy.md).

## Schemat wersji

| Build | Wersja (`CANOPY_VERSION`) | Kanał | GitHub Release | Tagi obrazów Docker |
| --- | --- | --- | --- | --- |
| push do `main` | `X.Y.Z-main.<sha7>` | `latest` | pre-release `latest` (tag przesuwany, assety podmieniane) | `latest`, `sha-<sha7>` |
| tag `vX.Y.Z` | `X.Y.Z` | `vX.Y.Z` | wydanie `vX.Y.Z` | `vX.Y.Z`, `vX.Y`, `vX` |
| tag `vX.Y.Z-rc.N` | `X.Y.Z-rc.N` | `vX.Y.Z-rc.N` | pre-release `vX.Y.Z-rc.N` | tylko `vX.Y.Z-rc.N` |

- `X.Y.Z` buildu z `main` to ostatni tag `vX.Y.Z` osiągalny z commita (`git describe`, bez
  sufiksu pre-release), a bez tagów `0.0.0`. To pre-release semver: `1.2.0-main.abc1234` jest
  starszy od `1.2.0` (to build *po* `1.2.0` — porównuj kanałem, nie samym semverem).
- `latest` śledzi `main`. Tagi wydań nigdy nie przesuwają `latest` (ani w Dockerze, ani na GitHubie).
- Kto wdraża, wybiera, czego słucha: `latest` (każdy push do main), `v1` (najnowsze 1.x.y),
  `v1.2` (najnowsze 1.2.x) albo dokładne `v1.2.3`.
- Updatery rozwiązują kanał tak: `latest` → wydanie z tagiem `latest`; `vX` / `vX.Y` →
  najwyższe wydanie semver z tym prefiksem; `vX.Y.Z` → to wydanie. Tag Docker `vX`/`vX.Y`
  przesuwa `docker/metadata-action` przy każdym tagu — wydanie poprawki dla starszej linii
  (np. `v1.0.5` po `v1.1.0`) przesunęłoby `v1` wstecz; takich wydań nie publikujemy bez
  ręcznego przestawienia tagu obrazu.
- Znane ograniczenie kontraktu: `<sha7>` złożony z samych cyfr z wiodącym zerem (ok. 0,4%
  commitów) nie jest poprawnym identyfikatorem semver; updatery porównują wtedy kanał/commit.

`scripts/version.ts` liczy wszystko lokalnie i w CI:

```sh
bun scripts/version.ts                 # JSON: version, channel, releaseTag, prerelease, commit, shortSha, dockerTags
bun scripts/version.ts --field version # jedno pole
bun scripts/version.ts --github-output # klucze do $GITHUB_OUTPUT
```

W CI tag pochodzi z `GITHUB_REF_TYPE`/`GITHUB_REF_NAME`, lokalnie z `git tag --points-at HEAD`.

## Wstrzykiwanie wersji

Stała `CANOPY_VERSION` z `@open-agents/domain/release/version` czyta `process.env.CANOPY_VERSION`
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

Rozmiary (Bun 1.4.4, 0.0.0-main): linux-x64 124 MiB, linux-arm64 124 MiB, darwin-x64 115 MiB,
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
| `canopy-gateway` | `distroless/cc-debian12:nonroot` | binarka gateway | `nonroot` | `canopy-gateway healthcheck` (TCP na `OA_PORT`) |
| `canopy-web` | `oven/bun:1.4.4-distroless` | `scripts/build-web.ts`: BFF zbundlowany z zależnościami + `client/` | 65532 | `GET /api/health` |
| `canopy-worker` | `debian:bookworm-slim` + git, curl, ssh, tini | binarka worker | `canopy` (10001) | `canopy-worker healthcheck` (link online wg `OA_WORKER_STATUS_FILE`) |

Kompilacja zawsze na `BUILDPLATFORM` (cross-compile), więc arm64 nie wymaga emulacji poza
`apt-get` w obrazie workera.

### Desktop

`bun run --cwd apps/desktop package:<linux|mac|windows>` na hoście danego OS/arch
([desktop.md](desktop.md)). Z `CANOPY_VERSION` pliki nazywają się
`Canopy-<wersja>-<linux|darwin|windows>-<x64|arm64>.<AppImage|deb|dmg|zip|exe>`.

### checksums.txt i manifest.json

`bun scripts/release-manifest.ts <katalog>` liczy z assetów w katalogu (odrzuca nieznane nazwy):

- `checksums.txt`: linie `sha256  nazwa` dla wszystkich assetów (bez samych `checksums.txt`/`manifest.json`),
- `manifest.json`:

```json
{
  "schema": 1,
  "version": "1.2.3",
  "channel": "v1.2.3",
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

## Workflowy GitHub Actions

`.github/workflows/ci.yml` (pull requesty; wywoływany też przez Release):
`bun install --frozen-lockfile` → `gen:check` → `typecheck` → `check:tmp` (testy jednostkowe
i integracyjne; PostgreSQL w kontenerach Docker runnera) → build web → binaria linux-x64
z kontrolą `--version`. Testy live są opt-in (`OA_LIVE`, prywatne klucze) i nie mają sekretów w CI.

`.github/workflows/release.yml` (push do `main`, tagi `vX.Y.Z[-…]`):

| Job | Co robi | Blokuje publikację |
| --- | --- | --- |
| `checks` | `ci.yml` (to jest „CI na push do main”) | tak: obrazy i Release czekają |
| `version` | `scripts/version.ts` | — |
| `binaries` | cross-compile wszystkich celów | tak |
| `smoke` | `--version` każdej binarki na jej OS/arch (ładuje osadzony sharp) | tak |
| `desktop` | macierz: linux-x64 (wymagany), linux-arm64, darwin-x64, darwin-arm64, windows-x64 (eksperymentalne: `continue-on-error`) | tylko linux-x64 |
| `images` | buildx amd64+arm64, push do `ghcr.io/itsoltech/canopy-{gateway,web,worker}`, SBOM, cache GHA | po `checks` |
| `publish` | `release-manifest.ts`, `gh release` | — |

Release `vX.Y.Z`: `gh release create --verify-tag --generate-notes` (pre-release dla `-rc`).
Ponowne uruchomienie wgrywa assety z `--clobber`. Rolling `latest`: tag `latest` przesuwany
`git push --force` na commit, assety podmieniane (najpierw pliki, `manifest.json` na końcu,
więc updater nie zobaczy manifestu wskazującego niewgrane pliki; stary manifest z nowym plikiem
nie przejdzie weryfikacji sha256), potem usuwane assety starszych buildów.
Push tagu tokenem `GITHUB_TOKEN` nie uruchamia kolejnych workflowów.

Podpisywanie desktop jest warunkowe: bez sekretów buildy są niepodpisane. macOS:
`MAC_CSC_LINK` (base64 .p12 Developer ID Application), `MAC_CSC_KEY_PASSWORD`, opcjonalnie
notaryzacja `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Windows: `WIN_CSC_LINK`,
`WIN_CSC_KEY_PASSWORD`. Workflow przekazuje je electron-builderowi tylko, gdy istnieją.

### Ustawienia repozytorium

- Settings → Actions → General: „Workflow permissions” może zostać „Read” — joby same żądają
  `contents: write` (publish) i `packages: write` (images).
- Pierwszy push tworzy pakiety GHCR prywatne: w ustawieniach pakietów `canopy-gateway`,
  `canopy-web`, `canopy-worker` ustaw **Public** (albo daj dostęp konkretnym użytkownikom)
  i połącz je z repozytorium (etykieta `org.opencontainers.image.source` robi to automatycznie).
- Jeśli włączone są reguły tagów lub „immutable releases”, wyłącz je dla tagu `latest`
  (jest przesuwany, a jego assety podmieniane).
- Runnery `ubuntu-24.04-arm`, `macos-15-intel`, `macos-15`, `windows-2025` muszą być dostępne
  dla repozytorium (publiczne repo: standardowe runnery GitHub).

### Pierwsze uruchomienie — lista kontrolna

1. PR: job „Typecheck, tests, builds” przechodzi (Docker Postgres na runnerze, czas `check:tmp`).
2. Merge do main: `smoke` zielony na 5 runnerach (macOS: binarka podpisana ad hoc przez Bun;
   Windows: sharp/libvips DLL z katalogu cache).
3. `desktop`: sprawdź, które eksperymentalne cele przeszły; po zielonych przebiegach można
   zdjąć `experimental`.
4. GHCR: trzy obrazy z tagami `latest`, `sha-<sha7>`, manifest list z `linux/amd64` i `linux/arm64`;
   ustaw widoczność.
5. Release `latest`: pre-release z binariami, instalatorami, `checksums.txt`, `manifest.json`;
   tag `latest` na commicie z main. Drugi push do main podmienia assety.
6. `git tag v0.1.0 && git push origin v0.1.0`: wydanie `v0.1.0`, obrazy `v0.1.0`, `v0.1`, `v0`;
   `latest` bez zmian.
7. `curl -sL https://github.com/itsoltech/canopy/releases/download/latest/manifest.json` zgadza się
   z `checksums.txt`.

## Weryfikacja lokalna (2026-11-03)

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
