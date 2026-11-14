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
„Update all” pomija gateway i workery zarządzane przez obraz. Ich dostępne wersje
pozostają widoczne ze stanem „Managed externally” i instrukcją ręcznej aktualizacji.

SSH inicjuje **gateway**, nie przeglądarka. Ogranicz jego ruch wychodzący do hostów,
którymi użytkownik może zarządzać. Klucz prywatny Ed25519 per właściciel jest szyfrowany
`CANOPY_SECRETS_KEY`; backup DB musi zachować również ten klucz. Publiczny klucz dodaj do
`authorized_keys` docelowego użytkownika. Pierwszy fingerprint wymaga niezależnego
sprawdzenia i potwierdzenia; mismatch blokuje dalsze połączenia. Gateway nie przyjmuje
dowolnego polecenia SSH, tylko ustalony installer. Sesja systemd użytkownika/linger lub
zalogowana sesja GUI macOS muszą istnieć przed automatycznym startem usługi.
Cel SSH pobiera worker z GitHub Releases przez HTTPS; gateway dostarcza SHA-256 przez
szyfrowane stdin. Nie trzeba wystawiać web BFF desktopu. Włącz Network access albo ustaw
osiągalny „Gateway address for workers” przed instalacją; enrollment zachowuje pin TLS.
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

Logowanie kont GitHub w Settings → GitHub domyślnie używa oficjalnej aplikacji
**Canopy by IT SOL**. Opcjonalne, publiczne `CANOPY_GITHUB_APP_CLIENT_ID`
i `CANOPY_GITHUB_APP_SLUG` w środowisku gatewaya nadpisują te wartości dla forków.
Compose przekazuje je z `.env`; jawnie puste wartości wyłączają device flow i dają spokojny
stan braku konfiguracji. Nie istnieje client secret ani private key. Tokeny użytkowników i próby device flow
są szyfrowane tym samym `CANOPY_SECRETS_KEY`, wyłącznie w gatewayu konta.
Rejestrację aplikacji i zakres device flow opisuje [github.md](github.md#2-github-app-i-konta).

`CANOPY_DATABASE_INDEX_MODE=concurrent` włącza budowanie zarejestrowanych indeksów
wydajnościowych po migracji schematu przez `CREATE INDEX CONCURRENTLY`. Domyślne
`blocking` zachowuje szybsze zwykłe budowanie dla desktopu i małych baz. Tryb online
dotyczy indeksów od `0103`, jawnie zarejestrowanych jako zadania; nie zmienia starych
migracji ani tworzenia ograniczeń. Migracja kończy się dopiero po sprawdzeniu
`pg_index.indisvalid` i definicji indeksu. Nie uruchamiaj aplikacji, jeśli ten krok
zawiedzie, nawet gdy tabela `schema_migrations` zawiera już numer migracji.

Po przerwaniu budowy uruchom ponownie tę samą migrację. Zadania mają blokadę sesyjną
i działają poza transakcją, na zarezerwowanym połączeniu. Prawidłowy indeks jest
pomijany; niepoprawny indeks o oczekiwanej definicji zostaje usunięty i odtworzony.
Inna definicja pod tą samą nazwą zatrzymuje wykonanie i wymaga sprawdzenia przez
administratora. Zastąpiony indeks jest usuwany dopiero po poprawnym zbudowaniu
następcy. Pozostaw zapas miejsca na oba indeksy podczas przebudowy i obserwuj
`pg_stat_progress_create_index`; długie transakcje mogą opóźniać zakończenie.

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

Obraz gatewaya działa bez roota jako UID/GID 65532 (`canopy`), z zapisywalnym
`HOME=/home/canopy`. Git może tam zapisywać konfigurację, a domyślny cache wydań
znajduje się w `/home/canopy/.cache/canopy/releases`. Web ma ten sam zapisywalny
HOME; worker używa istniejącego użytkownika `canopy` (10001) i wolumenu `/home/canopy`.
Opcjonalne `CANOPY_UPDATE_CACHE_DIR` pozwala ustawić inny katalog cache serwera
(w Compose: `services.gateway.environment`); zamontowany katalog musi być zapisywalny
dla UID 65532. Bez tej zmiennej gateway respektuje `$XDG_CACHE_HOME/canopy/releases`,
a następnie `~/.cache/canopy/releases`. Gdy wybrany katalog nie jest zapisywalny,
używa prywatnego katalogu w systemowym katalogu tymczasowym i zapisuje jedno ostrzeżenie.
Ten awaryjny cache nie jest trwały; zachowanie cache między restartami wymaga wolumenu.

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
Projekty, na których pracują agenci, montuj jako dodatkowe wolumeny. Obraz ustawia
`CANOPY_WORKTREES_ROOT=/home/canopy/.local/share/canopy/worktrees`, więc nowe worktree zostają w wolumenie
danych, jak dotąd. Inny trwały folder ustaw w `services.worker.environment`. Worker binarny na serwerze bez
tej zmiennej tworzy worktree w `~/canopy/worktrees` użytkownika usługi ([worktrees.md](worktrees.md#położenie)).

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

Assety release: `canopy-gateway-<os>-<arch>` (z wbudowanym web), `canopy-worker-<os>-<arch>`
(`linux|darwin|windows`, `x64|arm64`), `checksums.txt`, `manifest.json`.

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

### Gateway z wbudowanym web (jedna binarka)

Binarka `canopy-gateway-<os>-<arch>` zawiera też web (BFF i SPA) w tej samej wersji. Jedna usługa
systemd uruchamia supervisor, gateway i web, bez Dockera. Przycisk Update w Settings → App updates
podmienia całość; logowanie na serwer nie jest potrzebne. PostgreSQL działa jako osobna usługa.

```text
systemd ─ canopy-gateway            supervisor: rollback, execve po aktualizacji
            └─ gateway              gRPC :7443 (BFF, workery), migracje, boty
                 └─ canopy-gateway web   BFF + SPA na 127.0.0.1:3000
```

Web jest procesem-dzieckiem gatewaya uruchomionym z tej samej binarki (`canopy-gateway web`).
Przy pierwszym starcie danej wersji binarka rozpakowuje swój build web (ok. 30 MB, kilkaset ms)
do `CANOPY_WEB_DIR` i zostawia tam trzy ostatnie wersje: otwarte karty starszej wersji dalej
pobierają swoje chunki po aktualizacji, a rollback używa zachowanego katalogu. Gateway potwierdza
start dopiero, gdy web odpowiada na `/api/health` tą samą wersją; web, który nie wstaje (np. zajęty
port), zatrzymuje start usługi z błędem w logu. Awaria samego web restartuje go
z backoffem (1–30 s), bez restartu gatewaya. Web nie dostaje `CANOPY_DATABASE_URL` ani
`CANOPY_SECRETS_KEY`; z gatewayem rozmawia wyłącznie tokenem serwisowym.

**PostgreSQL.** Pakiet dystrybucji (`postgresql`) albo, opcjonalnie, sama baza w Dockerze:

```sh
docker run -d --name canopy-postgres --restart unless-stopped \
  -e POSTGRES_USER=canopy -e POSTGRES_PASSWORD='…' -e POSTGRES_DB=canopy \
  -v canopy-postgres:/var/lib/postgresql/data -p 127.0.0.1:5432:5432 postgres:17
```

**Instalacja.** Self-update zapisuje obok binarki nowy plik, `.bak` i `.update.json`, więc katalog
binarki musi być zapisywalny dla użytkownika usługi (bez symlinku do pliku):

```sh
sudo useradd --system --home /var/lib/canopy --shell /usr/sbin/nologin canopy
TAG=v0.3.0-nightly.1   # dokładne wydanie; kanał wybierasz później w aplikacji
curl -fLO https://github.com/itsoltech/canopy/releases/download/$TAG/canopy-gateway-linux-x64
curl -fLO https://github.com/itsoltech/canopy/releases/download/$TAG/checksums.txt
sha256sum -c --ignore-missing checksums.txt
sudo install -d -o canopy -g canopy /opt/canopy/bin
sudo install -o canopy -g canopy -m 0755 canopy-gateway-linux-x64 /opt/canopy/bin/canopy-gateway
sudo install -d -m 0700 /etc/canopy
```

`/etc/canopy/gateway.env` (`root:root`, `0600`; systemd czyta go przed zmianą użytkownika):

```sh
CANOPY_DATABASE_URL=postgres://canopy:…@127.0.0.1:5432/canopy
CANOPY_UI_SERVICE_TOKEN=…        # openssl rand -hex 32; web dostaje go automatycznie
CANOPY_SECRETS_KEY=…             # openssl rand -base64 32; kopia razem z backupem bazy
CANOPY_HOST=0.0.0.0              # port gRPC dla workerów (i BFF)
CANOPY_PORT=7443
CANOPY_UPDATE_CHANNEL=nightly    # kanał początkowy; potem zmieniasz go w aplikacji
# Web (wartości domyślne):
# CANOPY_WEB=on
# CANOPY_WEB_HOST=127.0.0.1
# CANOPY_WEB_PORT=3000
# CANOPY_OAUTH_REDIRECT_URL=…    # opcjonalnie: własny callback zamiast stałej strony przekierowania OAuth
```

| Zmienna | Domyślnie | Znaczenie |
| --- | --- | --- |
| `CANOPY_WEB` | `on` | `off` = gateway bez web (headless). Inne wartości to błąd konfiguracji. |
| `CANOPY_WEB_HOST` | `127.0.0.1` | Adres nasłuchu web. Adres spoza loopbacku daje w logu ostrzeżenie z tym adresem i przypomnieniem o TLS albo Tailscale Serve. |
| `CANOPY_WEB_PORT` | `3000` | Port web. |
| `CANOPY_WEB_DIR` | `$XDG_CACHE_HOME/canopy/web` (`~/.cache/canopy/web`) | Rozpakowane wersje web. Bez prawa zapisu: katalog tymczasowy i ostrzeżenie (bez starych chunków po restarcie). |
| `GATEWAY_URL` | `http://127.0.0.1:$CANOPY_PORT` | Adres gatewaya dla web; `https` i zaufany `CANOPY_TLS_CERT`, gdy gateway ma TLS. Ustaw ręcznie tylko wtedy, gdy certyfikat nie obejmuje `127.0.0.1`. |
| `PROTOCOL_HEADER` | `x-forwarded-proto` | Nagłówek protokołu od proxy. Żądanie bez niego to zwykłe HTTP. |
| `HOST_HEADER` | `x-forwarded-host` | Nagłówek hosta od proxy; bez niego liczy się `Host`. |
| `BODY_SIZE_LIMIT` | `50M` | Limit uploadu BFF (biblioteka skilli wymaga 50M); proxy musi dopuścić ten sam rozmiar. |
| `ORIGIN` | brak | Stały origin, np. `https://canopy.example.com`, dla proxy, które nie wysyła nagłówków `X-Forwarded-*`. |
| `CANOPY_WEB_ORIGIN` | origin wbudowanego web | Cel HTTPS over Tailscale. Bez tej zmiennej gateway używa `http://127.0.0.1:$CANOPY_WEB_PORT`; nie trafia do web. |

`HOST`, `PORT` i `GATEWAY_SERVICE_TOKEN` web wylicza sam z `CANOPY_WEB_*` i `CANOPY_UI_SERVICE_TOKEN`.

`/etc/systemd/system/canopy-gateway.service`:

```ini
[Unit]
Description=Canopy gateway and web
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=canopy
Group=canopy
EnvironmentFile=/etc/canopy/gateway.env
Environment=CANOPY_NATIVE_DIR=/var/cache/canopy/native
Environment=CANOPY_WEB_DIR=/var/cache/canopy/web
Environment=CANOPY_UPDATE_CACHE_DIR=/var/cache/canopy/releases
CacheDirectory=canopy
StateDirectory=canopy
ExecStart=/opt/canopy/bin/canopy-gateway
Restart=always
RestartPreventExitStatus=78
RestartSec=5
# Self-update: nowa binarka, .bak, .update.json i blokada obok pliku.
ReadWritePaths=/opt/canopy/bin
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`systemctl daemon-reload && systemctl enable --now canopy-gateway`. Kontrola:
`curl -s http://127.0.0.1:3000/api/health` (wersja web) i `canopy-gateway healthcheck`
(z tymi samymi `CANOPY_HOST`/`CANOPY_PORT`); log: `journalctl -u canopy-gateway`.
`StateDirectory` daje zapisywalny HOME (`/var/lib/canopy`) dla Git i logów; domyślny
`KillMode=control-group` zatrzymuje także web.

**HTTPS przez Tailscale Serve.** Web zostaje na loopbacku. Najprościej włączyć Settings → Network
access → Tailscale → „HTTPS over Tailscale”: gateway zna origin wbudowanego web, a jego front
wpuszcza tylko właściciela komputera w Tailscale ([tailscale.md](tailscale.md)). Użytkownik usługi
potrzebuje raz `sudo tailscale set --operator=canopy`. Ręczny wpis też działa bez dodatkowej
konfiguracji, bo Serve wysyła `X-Forwarded-Proto: https` i `X-Forwarded-Host`:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
```

Ręczny wpis wpuszcza każdego, kto w tailnecie ma dostęp do tego hosta, a Canopy nie ma jeszcze
logowania użytkowników: ogranicz dostęp przez ACL Tailscale. Nigdy nie włączaj Funnel.

**Reverse proxy z TLS.** Proxy na tym samym hoście kieruje do `127.0.0.1:3000` i ustawia
`X-Forwarded-Proto` oraz `X-Forwarded-Host` (Caddy robi to sam:
`canopy.example.com { reverse_proxy 127.0.0.1:3000 }`). nginx: `proxy_set_header
X-Forwarded-Proto $scheme`, `proxy_set_header X-Forwarded-Host $host`,
`client_max_body_size 50m` i `proxy_buffering off` (SSE). Proxy bez tych nagłówków wymaga
`ORIGIN=https://canopy.example.com`. Proxy na innym hoście wymaga `CANOPY_WEB_HOST`
z adresem prywatnej sieci; wtedy log pokazuje ostrzeżenie, np.
`web: listening on 10.0.0.5:3000, reachable from other computers. Put a TLS reverse proxy or Tailscale Serve in front of it.`

**Headless.** Web w osobnym miejscu (obraz `canopy-web`, Compose) albo brak UI na tym hoście:

```sh
# /etc/canopy/gateway.env
CANOPY_WEB=off
```

Gateway działa wtedy jak wcześniej, a osobny web dostaje `GATEWAY_URL`, `GATEWAY_SERVICE_TOKEN`
(= `CANOPY_UI_SERVICE_TOKEN`), `PORT`, `PROTOCOL_HEADER` i `BODY_SIZE_LIMIT`. Obrazy Docker
(`canopy-gateway`, `canopy-web`) nie zmieniają się: gateway w kontenerze nigdy nie uruchamia
wbudowanego web. Desktop ma własny web i też go nie używa.

Network access, HTTPS over Tailscale i Git działają tak samo jak w Dockerze. HTTPS over Tailscale
na natywnym gatewayu z osobnym web (headless) wymaga `CANOPY_WEB_ORIGIN` (origin tego web
na loopbacku, np. `http://127.0.0.1:3000`) oraz web z `PROTOCOL_HEADER=x-forwarded-proto`.

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
ExecStart="%h/.local/bin/canopy-worker" --config "%h/.config/canopy/worker.json"
Environment="PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
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
- **Binaria**: przycisk Update w Settings → App updates (albo Update all). Gateway pobiera
  binarkę z `manifest.json` kanału, sprawdza SHA-256, zostawia `.bak` i atomowo podmienia plik,
  czeka na koniec aktywnych tur i restartuje się. Ta sama binarka niesie web, więc jedna
  aktualizacja podmienia oba; nowy gateway uruchamia web nowej wersji, a otwarte karty pokazują
  „A new version is available” i do czasu przeładowania pobierają swoje chunki z zachowanych
  wersji. Jeśli nowy gateway albo jego web nie staną się zdrowe w 90 s, supervisor przywraca
  `.bak` i wraca poprzednia wersja obu. Potem supervisor przechodzi na nowy kod przez `execve`,
  bez zmiany PID-u usługi. Ręcznie: podmień plik (sprawdź `checksums.txt`) i
  `systemctl restart canopy-gateway`. Kolejność: gateway (z web), potem workery. Gateway z
  `CANOPY_WEB=off` i osobny web aktualizuje się jak wcześniej: gateway, potem web.
- **Desktop**: instalator nowej wersji z tego samego release (`Canopy-<wersja>-<os>-<arch>.*`).
- Do przypięcia używaj pełnej wersji (`vX.Y.Z`, `vX.Y.Z-beta.N`, `vX.Y.Z-nightly.N`).
  Nie ma rolling binariów `latest` ani obrazów `sha-*`. Starsze nightly podlegają retencji.
