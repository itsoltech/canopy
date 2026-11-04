# Wdrożenie

Canopy to PostgreSQL + gateway + web (BFF i SPA) oraz workery na maszynach, które uruchamiają
agentów. Wersje i kanały: [release.md](release.md). Wszystko pochodzi z
`ghcr.io/itsoltech/canopy-*` albo z GitHub Releases `itsoltech/canopy`.

Gateway uruchomiony jako serwer (Docker lub samodzielna binarka) ma rolę `server`.
**Linked computers jest dostępne wyłącznie między aplikacjami Canopy Desktop w trybie
lokalnym**; łączenie serwerów nie jest wspierane. Serwer nie uruchamia linkowania,
discovery/mDNS, luster, wspólnej konfiguracji, przenoszenia ani relay. Web i desktop
remote połączone z serwerem nie pokazują tych funkcji. Istniejące rekordy partnerów
pozostają w bazie ze stanem `inactive`, bez połączeń i synchronizacji; nic nie jest usuwane.
Telefony, sparowane klienty desktopowe i workery korzystają dalej z Network access.

Każdy komputer wykonujący zadania agentów musi mieć osobno zainstalowane
**Claude Code (`claude`), Codex (`codex`) lub Grok (`grok`)** dla używanego providera.
Desktop, binarki workera i obrazy Docker nie zawierają ani nie pobierają tych CLI.
Zapewnij PATH procesu usługi albo własną ścieżkę w konfiguracji instancji, oraz
login/klucz właściwego konta. Claude SDK zawsze dostaje jawny plik wykonywalny;
brak instalacji raportuje jako „Claude Code is not installed on this computer”.
W kontenerze CLI musi być dostępne wewnątrz kontenera, nie tylko na hoście.

Desktop w trybie lokalnym pobiera PostgreSQL o wersji i SHA-512 przypiętych podczas
budowania; po instalacji działa z cache offline. Tryb remote nic nie pobiera.
Nie dotyczy to wdrożenia serwerowego: Compose nadal uruchamia osobny PostgreSQL.
Szczegóły cache i blokady zmiany major: [desktop.md](desktop.md#postgresql-pobierany-dla-trybu-lokalnego).

## Wybór kanału

| Kanał | Obraz | Binaria | Dla kogo |
| --- | --- | --- | --- |
| `stable` (`latest`) | `canopy-gateway:stable` | najwyższe stable | stabilne wydania main |
| `beta` | `canopy-gateway:beta` | najwyższe stable/beta | testowanie wybranego nightly, branch next |
| `nightly` | `canopy-gateway:nightly` | najwyższe semver ze wszystkich wydań | nowe funkcje z dev |
| `v1` | `canopy-gateway:v1` | najwyższe `v1.*.*` | produkcja z automatycznymi poprawkami i nowymi funkcjami 1.x |
| `v1.2` | `canopy-gateway:v1.2` | najwyższe `v1.2.*` | tylko poprawki |
| `v1.2.3` | `canopy-gateway:v1.2.3` | `v1.2.3` | zamrożona wersja |

Gateway, web i workery powinny być w tej samej wersji (jedna wersja dla wszystkich aplikacji).
Wersję widać w Settings (dół nawigacji), w `GET /api/health`, w `--version` binarek i w logu startu.
`latest` jest aliasem stable, nie buildu main HEAD. Piny wybierają wyłącznie stable.
Updater beta/nightly wybiera także nowsze stable według semver; obrazy Docker beta/nightly
są aliasami ostatniego wydania własnego kanału. Aby przejść kontenerem na stable, zmień CANOPY_TAG.

## Docker Compose (jeden host)

Instalację workerów z kreatora (skrypt, Docker, ręcznie i SSH) opisuje
[worker-config.md](worker-config.md#dodanie-maszyny-z-ui). Skrypt pod
`/install/worker.sh` jest publiczny; routes `/install/worker/<os>/<arch>` i `?sha256=1`
streamują wyłącznie zweryfikowany worker uruchomionej wersji gatewaya. Reverse proxy musi
udostępniać `/install/*` z BFF i tolerować pobieranie dużych plików. Nie cache'uj odpowiedzi
pomiędzy wersjami gatewaya. Skrypt wymaga curl i sha256sum/shasum, instaluje binarkę
w `~/.local/share/canopy/bin`, config `0600` w `~/.config/canopy/worker.json`.
`--no-service` pozwala uruchomić go bez systemd/launchd; istniejący config zostaje zachowany
przy reinstalacji, a jego zastąpienie wymaga `--force` i nowego tokenu. Kontenery nadal
aktualizuje się przez zmianę obrazu i odtworzenie.

SSH inicjuje **gateway**, nie przeglądarka. Ogranicz jego ruch wychodzący do hostów,
którymi użytkownik może zarządzać. Klucz prywatny Ed25519 per właściciel jest szyfrowany
`CANOPY_SECRETS_KEY`; backup DB musi zachować również ten klucz. Publiczny klucz dodaj do
`authorized_keys` docelowego użytkownika. Pierwszy fingerprint wymaga niezależnego
sprawdzenia i potwierdzenia; mismatch blokuje dalsze połączenia. Gateway nie przyjmuje
dowolnego polecenia SSH, tylko ustalony installer. Sesja systemd użytkownika/linger lub
zalogowana sesja GUI macOS muszą istnieć przed automatycznym startem usługi.
Przy HTTP używaj wyłącznie zaufanej szyfrowanej sieci (np. Tailscale); w publicznej sieci TLS.

Weryfikacja instalatora na Linux x64 (izolowany PostgreSQL i sshd, wolne porty;
komendy z głównego katalogu repozytorium):

```sh
shellcheck scripts/install-worker.sh
bun scripts/build-binaries.ts --target linux-x64 --app worker
docker build -t canopy-worker-install-sshd:test tests/integration/fixtures/worker-install-sshd
mkdir -p .tmp/worker-install-tests
TMPDIR="$PWD/.tmp/worker-install-tests" CANOPY_INSTALL_BINARY_TEST=1 CANOPY_SSH_CONTAINER_TEST=1 \
  bun test tests/integration/worker-install.test.ts tests/integration/worker-ssh.test.ts
```

Test używa prawdziwej binarki, gRPC i OpenSSH; sprawdza hash, prywatny config,
ponowną instalację, błąd autoryzacji, potwierdzenie i mismatch klucza hosta oraz
połączenie workera. W kontenerze nie działa systemd użytkownika: jawny shim
`fixtures/worker-install-sshd/systemctl` zapisuje wywołania i startuje prawdziwy worker,
a test sprawdza unit (`Restart=always`, PATH) i aktywację. To dry-run menedżera usługi,
nie test prawdziwego systemd/launchd; te wymagają sesji właściwego systemu.

```sh
mkdir canopy && cd canopy
curl -LO https://raw.githubusercontent.com/itsoltech/canopy/main/deploy/docker-compose.yml
curl -L -o .env https://raw.githubusercontent.com/itsoltech/canopy/main/deploy/.env.example
# uzupełnij .env: POSTGRES_PASSWORD, CANOPY_UI_SERVICE_TOKEN, CANOPY_SECRETS_KEY, CANOPY_TAG
docker compose up -d
docker compose ps        # postgres, gateway, web: healthy
```

Wszystkie zmienne opisuje [`deploy/.env.example`](../deploy/.env.example). `CANOPY_SECRETS_KEY`
szyfruje klucze providerów i tokeny konektorów w bazie — zachowaj kopię; jego utrata oznacza
ponowne wpisanie sekretów. Gateway przy starcie wykonuje migracje (`CANOPY_MIGRATE=0` wyłącza).

Domyślnie web i port procesu gatewaya są wystawione tylko na `127.0.0.1`:

- **web** (`WEB_PORT`, 3000): postaw przed nim reverse proxy z TLS. BFF sprawdza origin formularzy
  i bez nagłówka przyjmuje `https`, dlatego compose ustawia `PROTOCOL_HEADER=x-forwarded-proto`
  i `HOST_HEADER=x-forwarded-host`. Uploady: `BODY_SIZE_LIMIT` ≥ limitu pliku gatewaya;
  biblioteka skilli wymaga `BODY_SIZE_LIMIT=50M` (folder 25 MiB kodowany base64 w JSON).
  Dockerfile, compose, `.env.example` i runtime desktopowy ustawiają już 50M.
  To parametr startowy serwera BFF, nie ustawienie użytkownika; proxy musi dopuścić ten sam rozmiar.
  Przykład Caddy: `canopy.example.com { reverse_proxy 127.0.0.1:3000 }` (Caddy ustawia `X-Forwarded-*`).
- **gateway** (`GATEWAY_PORT`, 7443; wewnątrz procesu `CANOPY_PORT`): port dla BFF i istniejących
  lokalnych oraz zdalnych workerów. Nadal obsługuje WorkerLink, Enrollment i zamrożony UpdateService.
  Zachowaj dotychczasowe publikowanie i przekazywanie TCP (również przez tailnet); aktualizacja
  gatewaya ani workera nie wymaga zmiany konfiguracji lub ponownego enrollmentu.
- **Network access** (`CANOPY_NETWORK_PORT`, domyślnie 24443 w compose): surowy TCP dla telefonów,
  sparowanych klientów desktopowych i zdalnych workerów. Włącz go w Settings → Network access i dodaj nazwę/IP hosta.
  Nie kończ TLS na proxy; klient przypina certyfikat gatewaya. Adresy workerów i limity uploadów
  zmieniaj w aplikacji. `CANOPY_TLS_CERT` i `CANOPY_TLS_KEY` dotyczą tylko portu procesu.

Źródła skilli pobiera gateway: jego host potrzebuje Git w `PATH`, certyfikatów CA
i wychodzącego HTTPS do źródła oraz `skills.sh` przy linkach katalogu. Obraz gatewaya
zawiera Git na `debian:bookworm-slim`, nadal działa jako UID 65532. Instalacja
binarki poza Dockerem wymaga dostarczenia Git przez administratora. Nie trzeba
instalować `skills`, Node ani npm; wklejone komendy nie są uruchamiane. Dane dostępu
pochodzą wyłącznie z zaszyfrowanego magazynu konektorów gatewaya.

Worker w kontenerze (opcjonalnie, profil `worker`) — token z Settings → Workers → Add worker:

```sh
docker compose --profile worker run --rm worker enroll --gateway http://gateway:7443 --token <TOKEN>
docker compose --profile worker up -d
```

Obraz workera **nie zawiera CLI agentów** (`claude`, `codex`, `grok`): ich instalacja, wersje
i logowanie należą do użytkownika. Worker w kontenerze zgłasza CLI z metodą `docker`: Settings → Workers
pokazuje wersje i dostępne aktualizacje, ale bez przycisku („Managed by the image”) — gateway odrzuca też
instalację przez API. Nowszą wersję CLI daje przebudowany obraz ([provider-cli.md](provider-cli.md)). Rozszerz obraz, np.:

```dockerfile
FROM ghcr.io/itsoltech/canopy-worker:v1
# Obraz działa jako użytkownik canopy; instalator Claude Code kładzie CLI w ~/.local/bin.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH=/home/canopy/.local/bin:$PATH
```

Loginy CLI (`~/.claude`, `~/.codex`), `worker.json` i dziennik leżą w wolumenie `/home/canopy`.
Projekty, na których pracują agenci, montuj jako dodatkowe wolumeny.

### Sieć kontenera gatewaya

Boty działają w gatewayu, więc **kontener gatewaya musi sam dosięgnąć endpointów modeli** instancji
providerów (np. CLIProxyAPI). Endpoint dostępny tylko w prywatnej sieci hosta — typowo adres Tailscale
(`*.ts.net`, `100.x`) — bywa nieosiągalny z bridge'a Dockera (firewall hosta/Tailscale): bot kończy wtedy
turę komunikatem „couldn't reach the model provider”, a log gatewaya `bots: turn failed (Model endpoint
unreachable)`. Workery na hoście działają normalnie. Rozwiązanie: gateway i web w sieci hosta, nasłuchujące
tylko na loopbacku (`docker-compose.override.yml` obok `docker-compose.yml`):

```yaml
services:
  postgres:
    ports: !override
      - "127.0.0.1:7432:5432"
  gateway:
    network_mode: host
    ports: !reset []
    environment:
      CANOPY_DATABASE_URL: postgres://canopy:${POSTGRES_PASSWORD}@127.0.0.1:7432/canopy
      CANOPY_HOST: 127.0.0.1
      CANOPY_PORT: "7443"
  web:
    network_mode: host
    ports: !reset []
    environment:
      GATEWAY_URL: http://127.0.0.1:7443
      HOST: 127.0.0.1
      PORT: "3000"
```

Sprawdzenie z sieci Dockera: `docker run --rm --network canopy_default curlimages/curl -sS -o /dev/null -w '%{http_code}\n' <endpoint>/v1/models`.

### Dostęp sieciowy: telefony, klienty desktopowe i workery

Telefony, sparowane klienty desktopowe i workery łączą się z jednym portem TLS gatewaya, włączanym w Settings → Network
access ([network-access.md](network-access.md)). W kontenerze ustal port i opublikuj go jako TCP, bez
proxy kończącego TLS:

```yaml
services:
  gateway:
    environment:
      CANOPY_NETWORK_PORT: "24443"
    ports:
      - "24443:24443"
```

Następnie włącz dostęp w aplikacji i w „Reachable at” dodaj nazwę lub adres serwera (kontener na sieci
bridge nie widzi adresów hosta; z `network_mode: host` wykrywa je sam). Firewall hosta musi przepuszczać
TCP na tym porcie. Na serwerze bez kontenera `CANOPY_NETWORK_PORT` nie jest potrzebne: port wybrany
w aplikacji zostaje zapisany w bazie i można go zmienić w Settings.

Ten port jest dodatkiem do istniejącego portu gatewaya, nie jego zamiennikiem. Nowe workery
automatycznie sprawdzają przypiętą trasę ogłoszoną uwierzytelnionym łączem, zapisują konfigurację
z kopią i przechodzą na nią, gdy działa. Bez publikacji portu, przy zablokowanym firewallu lub
wyłączonym Network access dalej pracują i aktualizują się na dotychczasowym porcie. Starsze binarki
również pozostają w pełni obsługiwane. Nie trzeba zmieniać istniejącego Compose ani konfiguracji
systemd. Po udanej migracji późniejsza utrata trasy przywraca pierwotne połączenie także po restarcie.

Serwer nie wykrywa ani nie ogłasza połączonych komputerów w LAN, także z siecią hosta
i włączonym Network access. Nie otwieraj UDP 5353 dla linkowania serwerów.
Wykrywanie dotyczy wyłącznie lokalnych aplikacji desktopowych
([linked-computers.md](linked-computers.md#konkretny-protokół-etapu-6)).

## Binaria (systemd)

Assety release: `canopy-gateway-<os>-<arch>`, `canopy-worker-<os>-<arch>` (`linux|darwin|windows`,
`x64|arm64`), `checksums.txt`, `manifest.json`.

```sh
TAG=v0.1.0   # dokładne wydanie; stable/beta/nightly rozwiązuj przez API/UI
curl -fLO https://github.com/itsoltech/canopy/releases/download/$TAG/canopy-worker-linux-x64
curl -fLO https://github.com/itsoltech/canopy/releases/download/$TAG/checksums.txt
sha256sum -c --ignore-missing checksums.txt
install -m 0755 canopy-worker-linux-x64 ~/.local/bin/canopy-worker
canopy-worker --version
```

Kanał `v1`/`v1.2`: weź najwyższe wydanie z tym prefiksem (`gh release list -R itsoltech/canopy`).
macOS: plik pobrany przeglądarką ma kwarantannę — `xattr -d com.apple.quarantine canopy-worker-darwin-arm64`.
Przy pierwszym starcie binarka rozpakowuje bibliotekę sharp/libvips do `~/.cache/canopy/native`
(zmiana: `CANOPY_NATIVE_DIR`).

### Gateway

Użytkownik systemowy: `useradd --system --home /var/lib/canopy canopy`. Binarkę umieść w katalogu, do którego
usługa może pisać — self-update podmienia plik obok (`.bak`, atomowy rename): `install -d -o canopy /opt/canopy/bin`
i `install -o canopy -m 0755 canopy-gateway-linux-x64 /opt/canopy/bin/canopy-gateway`.
`/etc/canopy/gateway.env` (0600, właściciel `canopy`):

```sh
CANOPY_DATABASE_URL=postgres://canopy:…@127.0.0.1:5432/canopy
CANOPY_UI_SERVICE_TOKEN=…        # openssl rand -hex 32, ten sam w web
CANOPY_SECRETS_KEY=…             # openssl rand -base64 32
CANOPY_HOST=0.0.0.0
CANOPY_PORT=7443
CANOPY_NETWORK_PORT=24443
```

`/etc/systemd/system/canopy-gateway.service`:

```ini
[Unit]
Description=Canopy gateway
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=canopy
EnvironmentFile=/etc/canopy/gateway.env
Environment=CANOPY_NATIVE_DIR=/var/cache/canopy/native
CacheDirectory=canopy
ExecStart=/opt/canopy/bin/canopy-gateway
Restart=always
RestartPreventExitStatus=78
RestartSec=5
ReadWritePaths=/opt/canopy/bin
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`systemctl daemon-reload && systemctl enable --now canopy-gateway`; kontrola: `canopy-gateway healthcheck`
(z tymi samymi `CANOPY_HOST`/`CANOPY_PORT`). Web jako usługa: obraz `canopy-web` albo `bun index.js`
z wyniku `bun scripts/build-web.ts` (zmienne `GATEWAY_URL`, `GATEWAY_SERVICE_TOKEN`, `PORT`,
`PROTOCOL_HEADER`, `BODY_SIZE_LIMIT`).

### Worker

Worker działa jako zwykły użytkownik (jego CLI i loginy są w jego katalogu domowym):

```sh
canopy-worker enroll --gateway https://gateway.example.com:7443 --token <TOKEN>
canopy-worker service     # drukuje unit systemd --user (macOS: plist launchd) z tą binarką
```

Wynik `service` zapisz jako `~/.config/systemd/user/canopy-worker.service`:

```ini
[Unit]
Description=Canopy worker
After=network-online.target

[Service]
ExecStart="/home/me/.local/bin/canopy-worker" --config "/home/me/.config/canopy/worker.json"
Environment="PATH=/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin"
Restart=always
RestartPreventExitStatus=78
RestartSec=5

[Install]
WantedBy=default.target
```

`systemctl --user daemon-reload && systemctl --user enable --now canopy-worker`; żeby działał
bez zalogowanej sesji: `loginctl enable-linger $USER`. `PATH` musi obejmować CLI agentów.
Kod wyjścia 78 = zła konfiguracja (bez restartu w pętli).

Binarny gateway i worker po potwierdzonej samoczynnej aktualizacji odświeżają też
kod supervisora. Najpierw blokują nową pracę i czekają na zakończenie aktywnej,
następnie zamykają dziecko i wykonują `process.execve` na zaktualizowanej binarce.
PID głównego procesu widziany przez systemd/launchd pozostaje ten sam; nie jest
potrzebna nowa polityka restartu ani zmiana unitu. `Restart=always` / launchd
`KeepAlive=true` nadal obsługują zwykłe awarie, a wewnętrzny kod 76 nie trafia
do menedżera. Mechanizm działa również bez usługi, na pierwszym planie.
Gdy `execve` jest niedostępne lub zawiedzie, supervisor kontynuuje nadzór i zapisuje
komunikat; wtedy zrestartuj usługę ręcznie w dogodnym momencie.
Po pierwszym wdrożeniu tej poprawki supervisor uruchomiony ze starszego wydania,
które jeszcze nie zna przekazania, wymaga jednego restartu usługi.

Obrazy Docker (`CANOPY_INSTALL_KIND=docker`), instalacje ze źródeł i runtime
desktopu nie używają tego przekazania. W Compose pozostaje `restart: unless-stopped`
do zwykłych awarii; nowy kod kontenera wchodzi przez `docker compose pull` i
odtworzenie kontenera, także pod tini. Przekazanie binarki nie zależy od `restart:`
i nie służy do aktualizacji obrazu.

## Aktualizacja

- **Docker**: tag kanału (`stable`/`latest`, `beta`, `nightly`, `v1`) wskazuje nowy obraz po wydaniu:
  `docker compose pull && docker compose up -d`. Gateway migruje bazę przy starcie;
  migracje są tylko w przód — przed aktualizacją wersji `X.Y` zrób kopię bazy (`pg_dump`).
  Powrót do starszej wersji po migracji wymaga przywrócenia kopii.
- **Binaria**: podmień plik (sprawdź `checksums.txt`) i zrestartuj usługę. Kolejność: gateway,
  potem web, potem workery. Automatyczna aktualizacja workerów/gatewaya korzysta z `manifest.json`
  danego kanału (osobna funkcja self-update).
- **Desktop**: instalator nowej wersji z tego samego release (`Canopy-<wersja>-<os>-<arch>.*`).
- Do przypięcia używaj pełnej wersji (`vX.Y.Z`, `vX.Y.Z-beta.N`, `vX.Y.Z-nightly.N`).
  Nie ma rolling binariów `latest` ani obrazów `sha-*`. Starsze nightly podlegają retencji.
