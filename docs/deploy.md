# Wdrożenie

Canopy to PostgreSQL + gateway + web (BFF i SPA) oraz workery na maszynach,
które uruchamiają agentów. W nightly web jest wbudowany w gateway; obecne stable i beta
uruchamiają osobną usługę web. Ten dokument opisuje kod na `dev`; poniższe instrukcje
pobierania domyślnie wybierają stable. Wersje i kanały: [release.md](release.md). Wszystko pochodzi z
`ghcr.io/itsoltech/canopy-*` albo z GitHub Releases `itsoltech/canopy`.

Status (2026-11-22): relay mobilnych powiadomień może wydawać poświadczenia
po App Attest lub Play Integrity. Obsługuje ich odwołanie i ogranicza odnawianie
do 90 dni od ostatniej atestacji. Gateway zachowuje obsługę własnych relayów.
Od 2026-11-23 relay Canopy lub własny relay można wybrać w panelu webowym serwera
lub ze sparowanego Desktopu.
Workflow Release publikuje osobny obraz relaya w GHCR.
Operacyjne CLI `migration` obsługuje przeniesienie bazy gatewaya oraz podgląd
Linked Computers.
Gateway i worker są budowane na Bun 1.4.5. Compose izoluje
sieć workera od panelu właściciela, a samodzielny web domyślnie słucha na loopbacku
i sprawdza nagłówek Host. Kod zawiera operacyjne CLI `storage inspect` i jawny
reclaim offline przez `VACUUM FULL`. Dostępność w nightly/beta/stable wynika
z wersji binarki. Polecenia `storage` działają poza migracją i usługami aplikacji.
Compose i Desktop Local wykonują `canopy-gateway migrate` przed uruchomieniem gatewaya na oddzielnym koncie SQL.
Migracja `0184` automatycznie zachowuje podglądy obrazów w historii każdego użytkownika, również przy odłączonych workerach.
Od 2026-11-19 w kodzie jednorazowy token enrollmentu jest podawany przez stdin.
Binarny updater na kanale `nightly` wybiera wyłącznie wydania nightly.
Binaria i obrazy Docker mają wykazy [licencji zależności](release.md#licencje-zależności).

Gateway uruchomiony jako serwer (Docker lub samodzielna binarka) ma rolę `server`.
**Linked computers jest dostępne wyłącznie między aplikacjami Canopy Desktop w trybie
lokalnym**; łączenie serwerów nie jest wspierane. Serwer nie uruchamia linkowania,
discovery/mDNS, luster, wspólnej konfiguracji, przenoszenia ani relay. Web i desktop
remote połączone z serwerem nie pokazują tych funkcji. Istniejące rekordy partnerów
pozostają w bazie ze stanem `inactive`, bez połączeń i synchronizacji; nic nie jest usuwane.
Telefony, sparowane klienty desktopowe i workery korzystają dalej z Network access.
Relay powiadomień to oddzielna usługa, dostępna niezależnie od roli gatewaya.

Każdy komputer wykonujący zadania agentów musi mieć osobno zainstalowane
**Claude Code (`claude`), Codex (`codex`) lub Grok (`grok`)** dla używanego providera.
Desktop, binarki workera i obrazy Docker nie zawierają ani nie pobierają tych CLI.
Zapewnij PATH procesu usługi albo własną ścieżkę w konfiguracji instancji, oraz
login/klucz właściwego konta. Claude SDK zawsze dostaje jawny plik wykonywalny;
brak instalacji raportuje jako „Claude Code is not installed on this computer”.
W kontenerze CLI musi być dostępne wewnątrz kontenera, nie tylko na hoście.

Desktop w trybie lokalnym pobiera PostgreSQL o wersji i SHA-512 przypiętych podczas
budowania; po instalacji działa z cache offline. Tryb remote nic nie pobiera.
Compose uruchamia osobny PostgreSQL. Tag `postgres:17` obejmuje poprawki z 17.12
i kolejne wydania w linii 17. W istniejącym wdrożeniu `docker compose pull postgres`
pobiera aktualny obraz, a `docker compose up -d --no-deps postgres` odtwarza
kontener z zachowaniem wolumenu danych.
Szczegóły cache i blokady zmiany major: [desktop.md](desktop.md#postgresql-pobierany-dla-trybu-lokalnego).

## Wybór kanału

| Kanał | Obraz | Binaria | Dla kogo |
| --- | --- | --- | --- |
| `stable` (`latest`) | `canopy-gateway:stable` | najwyższe stable | stabilne wydania main |
| `beta` | `canopy-gateway:beta` | najwyższe stable/beta | testowanie wybranego nightly, branch next |
| `nightly` | `canopy-gateway:nightly` | najwyższe nightly | nowe funkcje z dev |
| `v1` | `canopy-gateway:v1` | najwyższe `v1.*.*` | produkcja z automatycznymi poprawkami i nowymi funkcjami 1.x |
| `v1.2` | `canopy-gateway:v1.2` | najwyższe `v1.2.*` | tylko poprawki |
| `v1.2.3` | `canopy-gateway:v1.2.3` | `v1.2.3` | zamrożona wersja |

Gateway, web i workery powinny być w tej samej wersji (jedna wersja dla wszystkich aplikacji).
Wersję widać w Settings (dół nawigacji), w `GET /api/health`, w `--version` binarek i w logu startu.
`latest` jest aliasem stable, nie buildu main HEAD. Piny wybierają wyłącznie stable.
Binarny updater beta dopuszcza też stable według SemVer. Obrazy Docker beta i nightly
są aliasami ostatniego wydania własnego kanału. Aby przejść kontenerem na stable, zmień CANOPY_TAG.

Pliki wdrożenia muszą pochodzić z tej samej gałęzi co wybrany kanał obrazów:

| Kanał | Compose i `.env.example` | `CANOPY_TAG` | Web |
| --- | --- | --- | --- |
| stable | [`main/deploy`](https://github.com/itsoltech/canopy/tree/main/deploy) | `latest` lub `stable` | obecnie osobna usługa `canopy-web` |
| beta | [`next/deploy`](https://github.com/itsoltech/canopy/tree/next/deploy) | `beta` | obecnie osobna usługa `canopy-web` |
| nightly | [`dev/deploy`](https://github.com/itsoltech/canopy/tree/dev/deploy) | `nightly` | wbudowany w `canopy-gateway` |
| konkretne wydanie | ten sam tag wydania | ten sam tag | zgodnie z plikami tego wydania |

Wbudowany web trafi do beta i stable przez promocję. Samo ustawienie `CANOPY_TAG=nightly`
w starym Compose nie zastępuje migracji pliku. Tak samo Compose z `dev` nie pasuje
do starszego obrazu `latest`, który nie zawiera web.

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
Worker akceptuje zdalny HTTP tylko wtedy, gdy operator zabezpieczył trasę i wskazał jej dokładny origin
w `CANOPY_WORKER_TRUSTED_HTTP_ORIGIN` przy rejestracji albo w `trusted_http_origin` istniejącego workera.
Przy instalacji przez SSH najprościej użyć przypiętego adresu HTTPS z Network access.

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
połączenie workera. W kontenerze fixture `curl` dostarcza lokalną binarkę dla
jednego testowego URL-a wydania i sprawdza flagi HTTPS. Instalator nadal liczy
SHA-256 pobranych bajtów przed uruchomieniem. Zamiast systemd użytkownika
`fixtures/worker-install-sshd/systemctl` zapisuje wywołania i startuje prawdziwy worker,
a test sprawdza unit (`Restart=always`, PATH) i aktywację. To dry-run menedżera usługi,
nie test prawdziwego systemd/launchd; te wymagają sesji właściwego systemu.

```sh
mkdir canopy && cd canopy
CANOPY_REF=main        # next dla beta, dev dla nightly, albo dokładny tag wydania
curl -fLO "https://raw.githubusercontent.com/itsoltech/canopy/$CANOPY_REF/deploy/docker-compose.yml"
curl -fL -o .env "https://raw.githubusercontent.com/itsoltech/canopy/$CANOPY_REF/deploy/.env.example"
# uzupełnij .env: POSTGRES_PASSWORD, CANOPY_UI_SERVICE_TOKEN, CANOPY_SECRETS_KEY, CANOPY_TAG
# CANOPY_TAG musi odpowiadać CANOPY_REF: latest/stable, beta, nightly albo dokładny tag
docker compose up -d
docker compose ps        # sprawdź usługi z Compose wybranego wydania
```

Web pod `127.0.0.1:3000` działa jako właściciel, bez logowania użytkowników.
Udostępniaj go w prywatnej sieci z ograniczonym dostępem (np. ACL Tailscale) albo
przez proxy z uwierzytelnianiem. TLS szyfruje połączenie; nie ogranicza dostępu.
Dotyczy to osobnego i wbudowanego web.

**Przejście z osobnego obrazu `canopy-web` na wydanie z wbudowanym web (obecnie nightly).**
W tym wariancie obraz `canopy-gateway` serwuje web i nie używa osobnego obrazu `canopy-web`.
Stable/beta nadal korzystają ze swojego osobnego obrazu web; poniższe kroki dotyczą
dopiero przejścia na wydanie z wbudowanym web. W istniejącym `docker-compose.yml`:

1. Usuń usługę `web`.
2. Przenieś jej port do usługi `gateway`: `- "${WEB_BIND:-127.0.0.1}:${WEB_PORT:-3000}:3000"`.
3. Przenieś do `gateway.environment` zmienne, które ustawiałeś dla web: `BODY_SIZE_LIMIT`, a także
   `PROTOCOL_HEADER`/`HOST_HEADER`, jeśli miały inne wartości niż `x-forwarded-proto`/`x-forwarded-host`
   (domyślne w gatewayu), oraz `ORIGIN`. `GATEWAY_URL` i `GATEWAY_SERVICE_TOKEN` nie są potrzebne.
4. Dodaj `CANOPY_WEB_ALLOWED_HOSTS` z publiczną nazwą reverse proxy (adresy IP i `localhost` działają bez tego).
5. Opcjonalnie wolumen `gateway-cache:/home/canopy/.cache/canopy` (stare chunki dla otwartych kart).
6. Przenieś z pliku wydania definicje sieci, przypisania usług i przekaźnik `worker-link` z profilu workera.
   Zachowaj dotychczasowe nazwy i zawartość wolumenów. Samo pobranie nowego obrazu nie zmienia sieci.
7. `docker compose pull && docker compose up -d --remove-orphans`. Przy włączonym profilu workera
   wykonaj te polecenia z `docker compose --profile worker`, aby odtworzyć również jego podłączenie do sieci.

Najprościej pobrać Compose i `.env.example` z gałęzi lub tagu wybranego wydania
z wbudowanym web (tabela powyżej), zachować własne sekrety i dopisać w `.env`
`CANOPY_WEB_ALLOWED_HOSTS`. Bez kroku 1–2 stary kontener `canopy-web` zostaje na ostatniej wydanej
wersji i rozjeżdża się z gatewayem. Gateway to zauważa: każdy web BFF wysyła swoją wersję
(nagłówek `canopy-web-version`; starsze nie wysyłają żadnej), więc przy web innej wersji gateway
loguje ostrzeżenie (najwyżej raz na godzinę na wersję), a przy gatewayu w Settings → App updates
pojawia się „A web app older than the gateway (…) is connected. Remove the separate web service: the
gateway serves the web now.” z odnośnikiem do tej sekcji — ten tekst pokazuje także stary web.
Web od tej wersji sam porównuje swoją wersję z gatewayem i pokazuje nieblokujący baner „This web app
is older than the gateway…” (albo „…newer…”), z „How to fix” i „Dismiss”. Desktop i web uruchomiony
ze źródeł (`0.0.0-dev`) go nie pokazują.

Wszystkie zmienne opisuje [`deploy/.env.example`](../deploy/.env.example). `CANOPY_SECRETS_KEY`
szyfruje klucze providerów i tokeny konektorów w bazie — zachowaj kopię; jego utrata oznacza
ponowne wpisanie sekretów.

Logowanie kont GitHub w Settings → GitHub domyślnie używa oficjalnej aplikacji
**Canopy by IT SOL**. Opcjonalne, publiczne `CANOPY_GITHUB_APP_CLIENT_ID`
i `CANOPY_GITHUB_APP_SLUG` w środowisku gatewaya nadpisują te wartości dla forków.
Compose przekazuje je z `.env`; jawnie puste wartości wyłączają device flow i dają spokojny
stan braku konfiguracji. Nie istnieje client secret ani private key. Tokeny użytkowników i próby device flow
są szyfrowane tym samym `CANOPY_SECRETS_KEY`, wyłącznie w gatewayu konta.
Rejestrację aplikacji i zakres device flow opisuje [github.md](github.md#2-github-app-i-konta).

### PostgreSQL i role gatewaya

Na dedykowanej bazie Canopy jednorazowa usługa `migrate` w sieci `control`
używa konta bootstrapu z dotychczasowym `POSTGRES_PASSWORD`. Stosuje oczekujące
migracje również do istniejącego wolumenu PostgreSQL 17. Następnie przygotowuje
konto `canopy_runtime` z dostępem do danych aplikacji, sekwencji i funkcji schematu
`public`. Tabela `schema_migrations` pozostaje w gestii migratora. Rola runtime
nie jest właścicielem bazy ani tabel i nie ma praw administracyjnych PostgreSQL.
Gateway uruchamia się po udanej migracji, z `CANOPY_MIGRATE=0`. Hasło runtime jest
losowe i trwałe w prywatnym wolumenie `database-runtime`, montowanym w gatewayu
tylko do odczytu. Aktualizacja zachowuje dotychczasową bazę, klucz szyfrowania,
tożsamości i sparowania. Przerwany krok można ponowić przez `docker compose up -d`.

Przy własnym PostgreSQL polecenie `canopy-gateway migrate` używa samego
`CANOPY_DATABASE_URL` z prawami do migracji. Opcjonalny `CANOPY_DATABASE_RUNTIME_URL`
w tym procesie pozwala przygotować oddzielne konto `canopy_runtime` w tej samej
dedykowanej bazie. Desktop Local przekazuje trwałe hasło runtime ze swojego
magazynu. Alternatywnie administrator sam przyznaje prawa działającej usłudze.
Przy zastosowaniu dwóch kont uruchamiaj migrator z nowej wersji przed każdym
startem zaktualizowanej binarki, a gateway z DSN runtime i `CANOPY_MIGRATE=0`.
Dotychczasowe wdrożenia z samym `CANOPY_DATABASE_URL` domyślnie nadal wykonują
migracje przy starcie. Operator zachowuje osobny dostęp do operacji offline.

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

Domyślnie web i port procesu gatewaya są wystawione tylko na `127.0.0.1`.
W stable/beta port web publikuje osobna usługa `web`, która dostaje `GATEWAY_URL`,
`GATEWAY_SERVICE_TOKEN`, `PROTOCOL_HEADER`, `HOST_HEADER` i `BODY_SIZE_LIMIT`.
`CANOPY_WEB*` z poniższego opisu dotyczy nightly z wbudowanym web:

- **web** (`WEB_PORT`, 3000, w kontenerze gatewaya): obraz `canopy-gateway` uruchamia wbudowany web
  tak jak binarka ([niżej](#gateway-z-wbudowanym-web-jedna-binarka)); `CANOPY_WEB=off` daje gateway
  bez web. W kontenerze web słucha na `0.0.0.0:3000` w zaufanej sieci `control`.
  Compose publikuje panel na `127.0.0.1:3000:3000` (`WEB_BIND`). Postaw przed nim
  reverse proxy z TLS albo Tailscale Serve na hoście. BFF sprawdza origin formularzy na podstawie
  `X-Forwarded-Proto`/`X-Forwarded-Host` (domyślne `PROTOCOL_HEADER`/`HOST_HEADER`); żądanie bez
  nich to zwykłe HTTP. Web sprawdza też surowy `Host`: adresy IP i `localhost` przechodzą zawsze,
  publiczną nazwę proxy (albo nazwę MagicDNS przy `tailscale serve` na hoście — gateway w kontenerze
  nie widzi Tailscale) wpisz w `CANOPY_WEB_ALLOWED_HOSTS` w `.env`; inne dostają 421.
  Uploady: `BODY_SIZE_LIMIT` ≥ limitu pliku gatewaya; biblioteka skilli wymaga `BODY_SIZE_LIMIT=50M`
  (folder 25 MiB kodowany base64 w JSON). Web, compose, `.env.example` i runtime desktopowy ustawiają
  już 50M. To parametr startowy serwera BFF, nie ustawienie użytkownika; proxy musi dopuścić ten sam
  rozmiar. Caddy ustawia `X-Forwarded-*`; publiczny dostęp wymaga też uwierzytelniania
  na proxy (przykład w sekcji [Dostęp do web](#dostęp-do-web-reverse-proxy-i-tailscale)).
  `CANOPY_WEB_ALLOWED_HOSTS=canopy.example.com` sprawdza nazwę hosta, nie tożsamość użytkownika.
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
znajduje się w `/home/canopy/.cache/canopy/releases`. Web działa w tym samym kontenerze i rozpakowuje
swoje wersje do `/home/canopy/.cache/canopy/web`; compose montuje `/home/canopy/.cache/canopy` jako wolumen
`gateway-cache`, więc po `docker compose pull` otwarte karty dalej pobierają chunki poprzedniej wersji, a cache
aktualizacji przetrwa odtworzenie kontenera. Worker używa istniejącego użytkownika `canopy` (10001) i wolumenu
`/home/canopy`.
Opcjonalne `CANOPY_UPDATE_CACHE_DIR` pozwala ustawić inny katalog cache serwera
(w Compose: `services.gateway.environment`); zamontowany katalog musi być zapisywalny
dla UID 65532. Bez tej zmiennej gateway respektuje `$XDG_CACHE_HOME/canopy/releases`,
a następnie `~/.cache/canopy/releases`. Gdy wybrany katalog nie jest zapisywalny,
używa prywatnego katalogu w systemowym katalogu tymczasowym i zapisuje jedno ostrzeżenie.
Ten awaryjny cache nie jest trwały; zachowanie cache między restartami wymaga wolumenu.

Worker w kontenerze (opcjonalnie, profil `worker`). Wklej token z Settings → Workers →
Add worker w ukrytym prompcie.

```sh
docker compose --profile worker run --rm worker enroll --gateway http://gateway:7443 && \
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

Worker i inne zwykłe usługi Compose korzystają z sieci `default`. Nazwa `gateway:7443` w tej sieci
prowadzi do przekaźnika TCP. Przekaźnik łączy się wyłącznie z portem 7443 gatewaya w sieci `control`.
Dotychczasowy adres w `worker.json` działa również po odtworzeniu kontenerów. Worker otrzymuje
`CANOPY_WORKER_TRUSTED_HTTP_ORIGIN=http://gateway:7443` dla bootstrapu w tej sieci.
Network access z przypiętym TLS pozostaje dostępny pod ogłoszonym adresem hosta i opublikowanym portem.
Do sieci `control` podłączaj tylko zaufane usługi administracyjne. Własny proxy na innym hoście
wymaga prywatnego `WEB_BIND` oraz reguły zapory dopuszczającej do tego portu wyłącznie proxy,
również dla ruchu z sieci kontenerów.

### Sieć kontenera gatewaya

Boty działają w gatewayu, więc **kontener gatewaya musi sam dosięgnąć endpointów modeli** instancji
providerów (np. CLIProxyAPI). Endpoint dostępny tylko w prywatnej sieci hosta — typowo adres Tailscale
(`*.ts.net`, `100.x`) — bywa nieosiągalny z bridge'a Dockera (firewall hosta/Tailscale): bot kończy wtedy
turę komunikatem „couldn't reach the model provider”, a log gatewaya `bots: turn failed (Model endpoint
unreachable)`. Workery na hoście działają normalnie. Rozwiązanie: gateway (z web) w sieci hosta, nasłuchujący
tylko na loopbacku (`docker-compose.override.yml` obok `docker-compose.yml`):

```yaml
services:
  postgres:
    ports: !override
      - "127.0.0.1:7432:5432"
  gateway:
    network_mode: host
    networks: !reset []
    ports: !reset []
    environment:
      CANOPY_DATABASE_URL: postgres://canopy_runtime@127.0.0.1:7432/canopy
      CANOPY_HOST: 127.0.0.1
      CANOPY_PORT: "7443"
      # Bez publikacji portów to adres nasłuchu jest granicą: web tylko na loopbacku hosta.
      CANOPY_WEB_HOST: 127.0.0.1
      CANOPY_WEB_PORT: "3000"
```

Po przeniesieniu gatewaya do sieci hosta lokalny przekaźnik z profilu workera traci adres
`gateway-upstream`. Worker w kontenerze może wtedy korzystać z osiągalnego adresu Network access
z przypiętym TLS. Wbudowany web w tym wariancie pozostaje na loopbacku hosta.

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

## Dostęp do web: reverse proxy i Tailscale

Ta sekcja dotyczy wszystkich kanałów i obu sposobów uruchamiania BFF.
Web działa jako właściciel i nie ma jeszcze logowania użytkowników. Sam TLS
nie ogranicza dostępu: użyj prywatnej sieci z ACL albo uwierzytelniania na proxy.

**Reverse proxy z TLS.** Przykład Caddy na tym samym hoście (hash wygeneruj
przez `caddy hash-password`):

```caddyfile
canopy.example.com {
  basic_auth {
    canopy <PASSWORD_HASH>
  }
  reverse_proxy 127.0.0.1:3000
}
```

Caddy ustawia `X-Forwarded-Proto` i `X-Forwarded-Host`. nginx wymaga
`proxy_set_header X-Forwarded-Proto $scheme`, `proxy_set_header X-Forwarded-Host $host`,
`client_max_body_size 50m` i `proxy_buffering off` dla SSE oraz własnej konfiguracji
uwierzytelniania. Przy wbudowanym i samodzielnym web dopisz publiczną nazwę
do `CANOPY_WEB_ALLOWED_HOSTS`. Web sprawdza surowy `Host` przed odczytem nagłówków proxy.
Dokumenty panelu wysyłają CSP `frame-ancestors 'none'`; zachowaj ten nagłówek na proxy.

Uwierzytelnianie proxy obejmuje też `/install/*`. Instalator workera musi mieć
dostęp do tych tras: pobierz go z uwierzytelnieniem albo wybierz instalację ręczną/SSH.

**Tailscale Serve.** Web może pozostać na loopbacku, a Serve udostępniać go przez
HTTPS wewnątrz tailnetu. Ręczna konfiguracja wpuszcza osoby mające dostęp do hosta;
ogranicz ten dostęp przez ACL Tailscale. Nigdy nie włączaj Funnel. Integrację
w Settings → Network access i różnice konfiguracji origin opisuje [tailscale.md](tailscale.md).

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

**Dostępność: nightly; do beta/stable trafi przez promocję.** Poniższe zmienne
`CANOPY_WEB*` i procedura przejścia dotyczą wydania z wbudowanym web. Binarki
starszych wydań wymagają osobnego BFF.

Binarka `canopy-gateway-<os>-<arch>` zawiera też web (BFF i SPA) w tej samej wersji. Jedna usługa
systemd uruchamia supervisor i jeden proces z gatewayem i web, bez Dockera. Przycisk Update w Settings → App updates
podmienia całość; logowanie na serwer nie jest potrzebne. PostgreSQL działa jako osobna usługa.

```text
systemd ─ canopy-gateway      supervisor (ok. 55 MB): rollback, execve po aktualizacji
            └─ canopy-gateway gateway: gRPC :7443 (BFF, workery), migracje, boty
                              + web: BFF + SPA na 127.0.0.1:3000, w tym samym procesie
```

Web działa w procesie gatewaya: gateway importuje handler adapter-node z buildu web i obsługuje go
własnym listenerem HTTP. Supervisor nie ładuje gatewaya, więc zostaje małym watchdogiem. W obrazie
Docker nie ma supervisora: kontener to jeden proces. Pomiar na linux-x64 (bezczynnie, z web):
ok. 200 MB RSS w 2 procesach zamiast ok. 320 MB w 3 (supervisor, gateway, osobny proces web);
opóźnienia żądań bez zmian, a przepustowość web przy pełnym obciążeniu ok. 10–15% niższa,
bo BFF i gateway dzielą jeden wątek. BFF łączy się z gatewayem przez gRPC na loopbacku jak
dotąd (`GATEWAY_URL`).

Przy pierwszym starcie danej wersji binarka rozpakowuje swój build web (ok. 30 MB, kilkaset ms)
do `CANOPY_WEB_DIR` i zostawia tam trzy ostatnie wersje: otwarte karty starszej wersji dalej
pobierają swoje chunki po aktualizacji, a rollback używa zachowanego katalogu. Gateway potwierdza
start nowej wersji dopiero, gdy jej web odpowiada na `/api/health` (ta sama wersja, ten sam proces).
Web nowej wersji, który nie wstaje, cofa aktualizację, a wynik w Settings → App updates podaje
powód, np. „Port 3000 is in use by another process…”. Poza aktualizacją problem z web (zajęty
port, awaria) nie zatrzymuje gatewaya, workerów ani botów: gateway działa bez UI, loguje konkretny
błąd, pokazuje go przy gatewayu w Settings → App updates (np. z desktopu albo telefonu),
`canopy-gateway healthcheck` zwraca 1, a web ponawia start z backoffem (1–30 s).

Błąd web zostaje przy web: każde żądanie ma własną granicę błędu (500, gdy nic jeszcze nie wysłano,
inaczej zamknięcie połączenia), a nieobsłużony rejection lub wyjątek z kodu web (jego moduły
leżą w `CANOPY_WEB_DIR`, więc widać je w stosie) jest logowany i gateway działa dalej. Każdy inny
taki błąd nadal kończy proces, żeby systemd albo Docker go zrestartował. Web dzieli z gatewayem
środowisko procesu, więc lista dozwolonych zmiennych już go nie oddziela od sekretów gatewaya; to
była tylko dodatkowa warstwa (ten sam użytkownik systemu). BFF czyta wyłącznie zadeklarowane
ustawienia (`apps/web/src/env.ts`: `GATEWAY_URL`, `GATEWAY_SERVICE_TOKEN`), nigdy
`CANOPY_DATABASE_URL`, `CANOPY_SECRETS_KEY` ani klucza TLS; pilnuje tego test
`tests/integration/web-secrets.test.ts`. `canopy-gateway web` uruchomiony osobno (testy smoke)
nadal dostaje tylko listę dozwolonych zmiennych. Na Windows nazwy zmiennych nie rozróżniają wielkości
liter (Git Bash przekazuje `SYSTEMROOT`, nie `SystemRoot`), a lista obejmuje podstawy systemu
(`SystemRoot`, `windir`, `ComSpec` itd.): bez `SystemRoot` Winsock nie ładuje dostawców i każde
nasłuchiwanie kończy się błędem „port in use”. Job `native` w CI uruchamia `canopy-gateway web`
z binarki windows-x64 i sprawdza `/api/health`.

**Aktualizacja instalacji z osobnym web.** Binarka sprzed tej zmiany nie miała web, więc web
działał osobno (`bun index.js` z `build-web.ts`, zwykle na porcie 3000). Przed kliknięciem Update
wybierz jedno: (a) zatrzymaj i wyłącz osobną usługę web — wbudowany web zajmie ten sam port
z tymi samymi `PROTOCOL_HEADER`/`BODY_SIZE_LIMIT`; dopisz do `gateway.env` nazwy hostów,
pod którymi otwierasz UI (`CANOPY_WEB_ALLOWED_HOSTS`, niżej); albo (b) zostaw osobny web
i ustaw `CANOPY_WEB=off`. Bez tego nowa wersja zastanie zajęty port 3000 i aktualizacja
zostanie cofnięta z tym powodem; `CANOPY_WEB_PORT` z wolnym portem też wystarczy.

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
# CANOPY_WEB_ALLOWED_HOSTS=canopy.example.com   # nazwy z reverse proxy (adresy IP, localhost i MagicDNS zawsze)
# CANOPY_OAUTH_REDIRECT_URL=…    # opcjonalnie: własny callback zamiast stałej strony przekierowania OAuth
```

| Zmienna | Domyślnie | Znaczenie |
| --- | --- | --- |
| `CANOPY_WEB` | `on` | `off` = gateway bez web (headless). Inne wartości to błąd konfiguracji. |
| `CANOPY_WEB_HOST` | `127.0.0.1` | Adres nasłuchu web. Adres spoza loopbacku daje w logu ostrzeżenie z tym adresem i przypomnieniem o TLS albo Tailscale Serve. |
| `CANOPY_WEB_PORT` | `3000` | Port web. |
| `CANOPY_WEB_DIR` | `$XDG_CACHE_HOME/canopy/web` (`~/.cache/canopy/web`) | Rozpakowane wersje web; może być wspólny dla kilku instancji (gotowa wersja nie jest nadpisywana, a używana w ostatnich 30 min nie jest usuwana). Bez prawa zapisu: stały katalog `canopy-web-<uid>` w katalogu tymczasowym i ostrzeżenie. |
| `GATEWAY_URL` | `http://127.0.0.1:$CANOPY_PORT` | Adres gatewaya dla web; `https`, gdy gateway ma TLS (`CANOPY_TLS_CERT`). Własny certyfikat musi być wtedy zaufany od startu procesu: ustaw w usłudze `NODE_EXTRA_CA_CERTS` na plik certyfikatu, a `GATEWAY_URL` na nazwę z certyfikatu, jeśli nie obejmuje `127.0.0.1`. |
| `PROTOCOL_HEADER` | `x-forwarded-proto` | Nagłówek protokołu od proxy. Żądanie bez niego to zwykłe HTTP. |
| `HOST_HEADER` | `x-forwarded-host` | Nagłówek hosta od proxy; bez niego liczy się `Host`. |
| `BODY_SIZE_LIMIT` | `50M` | Limit uploadu BFF (biblioteka skilli wymaga 50M); proxy musi dopuścić ten sam rozmiar. |
| `ORIGIN` | brak | Stały origin, np. `https://canopy.example.com`, dla proxy, które nie wysyła nagłówków `X-Forwarded-*`. Jego host jest też dozwolony. |
| `CANOPY_WEB_ALLOWED_HOSTS` | brak | Nazwy hostów (nagłówek `Host`), pod którymi web odpowiada, rozdzielone przecinkami; `.example.com` obejmuje subdomeny. Zawsze dozwolone: adresy IP, `localhost`, nazwa z `CANOPY_WEB_HOST`, `ORIGIN` i nazwy MagicDNS tego komputera. Inne dostają 421 (ochrona przed DNS rebinding). |
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
konfiguracji: Serve wysyła `X-Forwarded-Proto: https`, a `Host` to nazwa MagicDNS, którą gateway
zna z Tailscale i przekazuje web:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
```

Ręczny wpis wpuszcza każdego, kto w tailnecie ma dostęp do tego hosta, a Canopy nie ma jeszcze
logowania użytkowników: ogranicz dostęp przez ACL Tailscale. Nigdy nie włączaj Funnel.

**Reverse proxy wbudowanego web.** Podstawowa konfiguracja TLS i uwierzytelniania
jest w sekcji [Dostęp do web](#dostęp-do-web-reverse-proxy-i-tailscale).
Publiczną nazwę dopisz do
`CANOPY_WEB_ALLOWED_HOSTS=canopy.example.com`; bez tego web odpowie 421 („This host name isn't
allowed…”). Web sprawdza surowy `Host`, nie `X-Forwarded-Host`: skrypt na stronie atakującej może
ustawić nagłówki `X-Forwarded-*`. Proxy bez tych nagłówków wymaga `ORIGIN=https://canopy.example.com`
(wtedy osobny wpis w `CANOPY_WEB_ALLOWED_HOSTS` nie jest potrzebny). Proxy na innym hoście wymaga `CANOPY_WEB_HOST`
z adresem prywatnej sieci; wtedy log pokazuje ostrzeżenie, np.
`web: listening on 10.0.0.5:3000, reachable from other computers. Put a TLS reverse proxy or Tailscale Serve in front of it.`

**Headless.** Web w osobnym miejscu (np. wynik `bun scripts/build-web.ts` uruchomiony przez `bun index.js`)
albo brak UI na tym hoście:

```sh
# /etc/canopy/gateway.env
CANOPY_WEB=off
```

Gateway działa wtedy jak wcześniej, a osobny web dostaje `GATEWAY_URL`, `GATEWAY_SERVICE_TOKEN`
(= `CANOPY_UI_SERVICE_TOKEN`), `PORT` i `BODY_SIZE_LIMIT`. Domyślny adres samodzielnego
nasłuchu to `127.0.0.1`. Ustaw `HOST` na prywatny adres tylko wtedy, gdy dostęp do portu
jest ograniczony do uprawnionego proxy lub przez ACL. Zasady `CANOPY_WEB_ALLOWED_HOSTS`,
`ORIGIN`, `PROTOCOL_HEADER` i `HOST_HEADER` są wspólne z webem wbudowanym. To samo `CANOPY_WEB=off`
działa w obrazie `canopy-gateway`. Desktop ma własny web i nie używa wbudowanego.

Network access, HTTPS over Tailscale i Git działają tak samo jak w Dockerze. HTTPS over Tailscale
na natywnym gatewayu z osobnym web (headless) wymaga `CANOPY_WEB_ORIGIN` (origin tego web
na loopbacku, np. `http://127.0.0.1:3000`) oraz web z `PROTOCOL_HEADER=x-forwarded-proto`.

### Worker

Worker działa jako zwykły użytkownik (jego CLI i loginy są w jego katalogu domowym).
Wklej token rejestracji, kiedy pojawi się ukryty prompt.

```sh
canopy-worker enroll --gateway https://gateway.example.com:7443
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

## Przeniesienie bazy gatewaya na inny serwer

Status (2026-11-21, kod w repozytorium): `canopy-gateway migration cutover`
obsługuje próbne odtworzenie, opróżnienie źródła i wznawialne przełączenie serwera przez SSH.
Operator przygotowuje usługi oraz trasy klientów. Dostępność w kanałach wynika z [wydań](release.md).

### Przełączenie serwera przez SSH

Użyj tego samego wydania Canopy z obsługą blokady migracji po obu stronach.
Przygotuj na celu oddzielną pustą bazę, jej własne poświadczenia administracyjne
i konto z prawem `CREATEDB` na potrzeby odtworzenia próbnego. PostgreSQL celu
musi być w tej samej lub nowszej wersji głównej. Oba hosty potrzebują `flock`
i pakietu klienta PostgreSQL (`psql`, `pg_dump`, `pg_restore`).
Jeśli PostgreSQL działa na innym hoście, sprawdź tam wolne miejsce na bazę,
indeksy i WAL. Koordynator sprawdza miejsce na pliki transferu lokalnie,
a zgodność PostgreSQL i odtworzenie sprawdza w bazie. Dane i schemat są
przenoszone bez statystyk planisty. PostgreSQL odtworzy statystyki podczas
analizy tabel.

Zarezerwuj osobny katalog stanu na każdym hoście (0700), a konfigurację JSON
i opcjonalny plik dotenv zapisz z uprawnieniami 0600. Uruchamiaj polecenia jako
właściciel tych plików. Plik źródłowy może wyglądać tak:

```json
{
  "stateDirectory": "/var/lib/canopy-migration/source",
  "environmentFile": "/etc/canopy/gateway.env",
  "target": {
    "destination": "operator@new-gateway.example.net",
    "knownHostsFile": "/etc/canopy/migration-known-hosts",
    "identityFile": "/etc/canopy/migration-ssh-key"
  },
  "drainTimeoutSeconds": 300
}
```

Na celu lokalna konfiguracja odbiornika domyślnie leży w
`~/.config/canopy/gateway-migration-target.json`. Ścieżkę może też ustawić
`CANOPY_MIGRATION_TARGET_CONFIG` w środowisku polecenia po stronie SSH.

```json
{
  "stateDirectory": "/var/lib/canopy-migration/target",
  "environmentFile": "/etc/canopy/target-migration.env",
  "secretFile": "/etc/canopy/relocated-secrets.env",
  "service": { "unit": "canopy-gateway.service" }
}
```

Przyjmuj tylko operatora SSH z uprawnieniami do odczytu prywatnego środowiska,
sterowania usługą i odtworzenia bazy. Przed użyciem sprawdź klucz hosta
i dodaj go do wskazanego pliku known_hosts. Odbiornik to stałe polecenie
`canopy-gateway migration cutover-target` w PATH zdalnego konta. Można
przypiąć je jako wymuszone polecenie dedykowanego klucza SSH i wyłączyć
na tym kluczu przekierowania oraz TTY. Sprawdzanie klucza hosta jest
obowiązkowe. Poświadczenia PostgreSQL i token usługi pochodzą z konfiguracji
właściwego hosta. Odbiornik dostaje klucz szyfrowania źródła razem z archiwum
przez stdin zaszyfrowanego połączenia SSH.

W pliku dotenv celu ustaw `CANOPY_DATABASE_URL` operatora i ten sam
`CANOPY_DEV_USER_EMAIL`, którego używa źródło. Przy rozdzielonych rolach ustaw
także lokalne dane do provisioningu runtime celu. Zatrzymaj usługę celu przed
przygotowaniem. W jej unicie dodaj obowiązkowy wpis
`EnvironmentFile=/etc/canopy/relocated-secrets.env` po pozostałych plikach
środowiska i przeładuj konfigurację systemd. Plik jeszcze nie istnieje.
Koordynator zapisze go z uprawnieniami 0600 przed pierwszym startem celu.
Domyślny adapter steruje `canopy-gateway.service` przez systemd. Pole
`service.user` przełącza go na instancję użytkownika. Zarządzane wdrożenie może
zamiast tego podać `service` z polami `stop`, `start`, `stopped` i `ready`
jako tablice argumentów. `stopped` zwraca 0 dla zatrzymanej usługi, 1 dla
działającej, a pozostałe kody oznaczają błąd. `ready` zwraca 0 po sprawdzeniu
gotowości. Adapter ma utrzymać cel wyłączony do aktywacji i zapisać trwałe
środowisko startu w taki sposób, by usługa korzystała z `secretFile`.

```sh
canopy-gateway migration cutover start --config /etc/canopy/cutover.json
canopy-gateway migration cutover status --config /etc/canopy/cutover.json
canopy-gateway migration cutover resume --config /etc/canopy/cutover.json
```

`start` pozostawia działające źródło i raportuje wynik izolowanego odtworzenia
na celu. Raport zawiera czasy etapów, wersję schematu, tożsamość sieciową
i liczniki sprawdzonych rekordów. Próba nie uruchamia gatewaya.
Po zakończeniu próby `resume` wstrzymuje nową pracę, czeka na zakończenie
aktywnej, zatrzymuje źródłową usługę i przesyła końcową kopię. Aktywacja zaczyna
się dopiero, gdy cel potwierdzi transakcyjne odtworzenie, a baza źródła zapisze
trwałą blokadę startu. `status` odczytuje zapisany etap, blokadę źródła i ostatni
stan potwierdzony przez cel. Po przerwaniu operacji użyj tego samego pliku
konfiguracji. `resume` uzgadnia stan przed kolejną próbą i wznawia przerwany etap.

Przed trwałym zatwierdzeniem źródła `cutover abort --config FILE` zwalnia
blokadę źródła i sprząta prywatne pliki transferu. Jeśli działający wcześniej
gateway zdążył rozpocząć zamykanie, koordynator kończy zatrzymanie, uruchamia
go ponownie i czeka na gotowość. Jeśli cel jest niedostępny, operacja zapisuje
oczekujące sprzątanie i ponowi je przy `abort` lub `resume`.
Jeśli końcowa baza celu zdążyła się odtworzyć, pozostaje z blokadą startu.
Do nowej próby przygotuj pustą bazę i nowe katalogi stanu. Po zatwierdzeniu
źródła używaj `status` i `resume`, także po utracie odpowiedzi SSH przy aktywacji.
Przywrócenie starej instancji po zapisach na celu wymaga aktualnej kopii bazy.

Po aktywacji sprawdź dostęp klientów i workerów. Stary adres może dalej
działać przez przekierowanie TCP na cel. Dla Desktopu, który ma przejść
na Remote, podaj w konfiguracji celu `networkOrigins` z adresami HTTPS
Network access oraz ustaw port nasłuchu usługi przez `CANOPY_NETWORK_PORT`.
Docelowy certyfikat jest sprawdzany względem odtworzonej tożsamości, a klient
przed połączeniem sprawdza jego pin.

### Dołączanie Desktopu do wspólnego gatewaya

Po uruchomieniu centralnego gatewaya ten sam odbiornik SSH obsługuje
**Join a shared server** w kreatorze Desktopu. Użyj konfiguracji działającego
gatewaya z jego kluczem, kontem właściciela i adresami `networkOrigins`.
Opcjonalne `CANOPY_MIGRATION_JOIN_CONFIG` wskazuje osobną konfigurację odbioru.
Jeśli oba pliki dotyczą tej samej usługi, użyj w nich tego samego
`stateDirectory`, żeby koordynator serializował przełączenia.
Konto PostgreSQL potrzebuje uprawnień właściciela tabel i `CREATEDB`.

Osoba na każdym Desktopie potwierdza dołączenie lokalnie. Może to zrobić,
gdy komputer wróci do sieci. Odbiornik sprawdza podpis paczki danych domowych
i buduje raport na izolowanej kopii. Właściciel wybiera rozstrzygnięcia konfliktów
i zatwierdza sekrety, które wolno przekazać. Sekrety są szyfrowane kluczem
centralnego gatewaya. Klucz dołączanego gatewaya pozostaje na jego komputerze.

Import tymczasowo opróżnia i zatrzymuje centralny gateway. Transakcja zapisuje
dane wraz z potwierdzeniem przypisanym do operacji i skrótu paczki. Po odzyskaniu
łączności kreator może odczytać potwierdzenie i przejść do przełączenia workera.
Jeżeli raport zmienił się przed zapisem, wybierz **Review again** w kreatorze
i zatwierdź nowy raport. Szczegóły danych i powiązań opisuje
[konsolidacja połączonych komputerów](linked-computers.md#konsolidacja-dodatkowego-komputera).

### Ręczny eksport i odtworzenie

Użyj tego samego wydania Canopy po obu stronach i PostgreSQL na celu w tej samej
lub nowszej głównej wersji. Na hoście uruchamiającym polecenie potrzebne są
`psql`, `pg_dump` i `pg_restore` zgodne z serwerem i archiwum. Standardowy
obraz gatewaya nie zawiera narzędzi PostgreSQL. W instalacji Compose uruchom
polecenie z binarki operatora mającej prywatną trasę do bazy i dostęp do jej konta
bootstrapu. Nigdy nie wystawiaj bazy do internetu dla tej operacji.

**Próba.** W załadowanym prywatnym środowisku źródła ustaw `CANOPY_DATABASE_URL`
z uprawnieniami do odczytu całej bazy, `CANOPY_SECRETS_KEY` i ten sam
`CANOPY_DEV_USER_EMAIL`, którego używa gateway. Polecenie może czytać działające źródło.
Wskaż nieistniejący katalog pod zaufanym katalogiem operatora.

```sh
canopy-gateway migration export --bundle ./canopy-trial
```

Przekaż katalog przez zaufany kanał, np. SSH. Zachowaj dostęp właściciela
do katalogu i plików (odpowiednio 0700 i 0600 na Linuksie). Na Windows ogranicz
ACL katalogu i plików tymczasowych do swojego konta. Archiwum zawiera
dane aplikacji, w tym historie i załączniki. Manifest uwierzytelnia je kluczem
źródłowego gatewaya. Przekaż klucz szyfrowania osobnym prywatnym kanałem.
W środowisku celu załaduj ten klucz i ten sam `CANOPY_DEV_USER_EMAIL`.
`CANOPY_DATABASE_URL` musi wskazywać oddzielną, pustą bazę próbną z kontem
operatora. Zablokuj dostęp działających gatewayów do tej bazy.

```sh
canopy-gateway migration verify --bundle ./canopy-trial
canopy-gateway migration import --bundle ./canopy-trial --offline
```

Import sprawdza podpis manifestu i skrót prywatnej kopii, z której odtwarza
bazę. Katalog tymczasowy (na Linuksie ustawiany przez `TMPDIR`) musi mieć
miejsce na całe archiwum. Transakcja zatwierdza dane po porównaniu wersji
schematu, właściciela, certyfikatu i zaszyfrowanego klucza tożsamości.
Właściciele obiektów i granty są lokalne dla celu. Import odmawia zapisu do
niepustej bazy. Po niejednoznacznym wyniku zachowaj gateway wyłączony i
sprawdź stan docelowej bazy przed powtórzeniem operacji.

Próba obejmuje bazę. Do osobnej próby startu użyj izolowanego środowiska
bez dostępu do rzeczywistych workerów, harmonogramów i integracji.
Jeśli testujesz również provisioning roli `canopy_runtime`, użyj osobnego
klastra PostgreSQL. Rola ma nazwę wspólną dla klastra i jest przypisana
do jednej bazy.

**Przełączenie.** Wstrzymaj nowe tury i pozwól zakończyć się aktywnym zadaniom
na źródle. Zatrzymaj źródłowy gateway i jego automatyczny restart przed końcowym
eksportem do nowego katalogu (`migration export --bundle ./canopy-final --offline`).
Flaga `--offline` sprawdza brak innych sesji i przygotowanych transakcji przed
zrzutem i po nim. Blokadę ponownego połączenia zapewnia operator.
Zaimportuj końcową kopię do oddzielnej pustej bazy
produkcyjnej na celu. Przy rozdzielonych rolach wykonaj `canopy-gateway migrate`
z konfiguracją bootstrapu i hasła runtime celu, aby odtworzyć uprawnienia. Skonfiguruj
nasłuch i reverse proxy dla celu, uruchom nową usługę, sprawdź dostęp użytkownika
i połączenia workerów. Środowisko usługi musi zawierać sprawdzone
`CANOPY_SECRETS_KEY` i `CANOPY_DEV_USER_EMAIL`. Po rozpoczęciu zapisów na celu dalsza praca ze starą bazą
wymaga zsynchronizowania z nią aktualnego stanu.

Klucze sieciowe, tokeny klientów i identyfikatory workerów istniejące w bazie
są zachowywane. Wskaż nowy adres klientom albo utrzymaj stary adres przez
przekierowanie TCP. Logowania CLI i pliki projektów pozostają na workerach.
Konfiguracja usług systemowych, adresy hostów, TLS reverse proxy i poświadczenia
PostgreSQL pochodzą ze środowiska każdego hosta.

Z bazą Desktop Local lub jego odtworzoną kopią polecenie
`canopy-gateway migration inspect-links` raportuje rekordy należące do źródłowego
właściciela, oddzielnie od luster, oraz partnerów i wykrytą pracę w toku.
Odczyt nie przenosi rekordów. Stan pracy może się zmienić po odczycie.

### Lokalne testy migracji

Scenariusze serwerowe i konsolidacja używają osobnych baz PostgreSQL
i procesów gatewaya. Transport serwerowy jest sprawdzany przez prywatny
`sshd` nasłuchujący na loopbackie, z własnym kluczem i wymuszonym poleceniem.
Scenariusz Desktopu wymaga zbudowanego runtime i klienta PostgreSQL 18.
Test rozpoczyna pracę na wbudowanej bazie, uruchamia cel w osobnym klastrze
i odtwarza stan kontrolera po przerwaniu przełączenia.

```sh
bun run --cwd apps/desktop build
CANOPY_LIVE=1 bun run check:tmp \
  ./tests/integration/gateway-relocation.live.test.ts \
  ./tests/integration/gateway-consolidation.live.test.ts \
  ./apps/desktop/test/migration-desktop.live.test.ts
```

## Inspekcja i fizyczne odzyskiwanie miejsca PostgreSQL

Retencja usuwa zbędne dane logiczne. Zwykły autovacuum udostępnia zwolnione strony
do ponownego użycia w PostgreSQL, lecz zazwyczaj nie zmniejsza plików na dysku.
`VACUUM FULL` przepisuje tabelę i jej indeksy, zwraca wolne miejsce systemowi plików
i wymaga blokady wyłącznej. Nie wybiera ani nie usuwa historii użytkownika.
Reguły retencji opisuje [database-retention.md](database-retention.md).

Przy załadowanym przez operatora `CANOPY_DATABASE_URL`:

```sh
canopy-gateway storage inspect
canopy-gateway storage --help
```

`inspect` otwiera pojedyncze połączenie tylko do odczytu. JSON zawiera
`databaseBytes` i relacje schematu `public`, posortowane malejąco według `totalBytes`:
`heapBytes` (główny fork tabeli), `toastBytes` (TOAST z jego indeksami), `indexBytes`
(indeksy tabeli), `totalBytes` oraz szacunki `liveTuplesEstimate`/`deadTuplesEstimate`.
Liczby są ciągami dziesiętnymi, żeby zachować precyzję bigint. Rozmiar całkowity
obejmuje też pomocnicze forki tabeli; rozmiar bazy zawiera katalogi i inne obiekty,
ale nie WAL, backupy ani pliki workerów. Szacunki statystyk nie są pomiarem bloatu
ani gwarancją liczby bajtów do odzyskania. Pole `reclaimable` oznacza obecność tabeli
na stałej liście CLI. Wynik nie zawiera treści rekordów ani adresu połączenia.

Fizyczny reclaim wykonuj dopiero po zakończeniu logicznego sprzątania:

1. Zaplanuj okno niedostępności, sprawdzony backup i wolne miejsce na tymczasową
   kopię przepisywanej relacji, indeksy i przyrost WAL. Zachowaj klucz szyfrowania
   wraz z backupem. `VACUUM FULL` nie zastępuje retencji ani backupu.
2. Zatrzymaj wszystkie gatewaye używające tej bazy, automatyczne restarty,
   migratory i inne klienty. Zablokuj nowe połączenia aplikacji na czas całej
   operacji, pozostawiając dostęp operatorowi. Nie zatrzymuj PostgreSQL.
3. W osobnym procesie gatewaya, z DSN operatora mającego prawo `MAINTAIN`, wskaż wyłącznie
   relacje wymagające przepisania:

   ```sh
   canopy-gateway storage reclaim --offline --table thread_events --table thread_replication_journal
   canopy-gateway storage inspect
   ```

4. Po kontroli wyniku przywróć dostęp i uruchom gateway. W Compose zatrzymaj
   usługę gateway i uruchom polecenie z poświadczeniem operatora, np. przez
   `docker compose run --rm --no-deps migrate storage reclaim --offline --table thread_events`;
   `docker compose exec gateway` nie zadziała po zatrzymaniu tej usługi.

CLI wymaga PostgreSQL 17, jawnego `--offline` i co najmniej jednego `--table`;
`storage --help` drukuje pełną listę dozwolonych tabel. Nie ma trybu „wszystkie”.
Przed pierwszą zmianą sprawdza obecność tabel oraz uprawnienie `MAINTAIN` (właściciel
tabeli też je ma). Odmawia przy każdej innej sesji tej bazy, także bezczynnej;
nikogo nie rozłącza. To kontrola stanu, nie blokada nowych połączeń — wyłączenie
ich dopływu należy do operatora, również za poolerem.

Kontrole i każde `VACUUM (FULL, ANALYZE)` używają tego samego połączenia, poza
transakcją, z `lock_timeout=2s`; inne sesje sprawdzane są ponownie przed każdą
tabelą. Sam rewrite nie ma krótkiego limitu czasu. Każda tabela jest osobną operacją:
awaria kolejnej nie cofa poprzednich, a przerwanie wymaga inspekcji przed ponowieniem.
CLI nie wykonuje automatycznych prób ani reclaimu podczas startu gatewaya.

## Aktualizacja

- **Docker**: tag kanału (`stable`/`latest`, `beta`, `nightly`, `v1`) wskazuje nowy obraz po wydaniu:
  `docker compose pull && docker compose up -d`. Obraz `canopy-gateway` niesie też web, więc to jedna
  aktualizacja; kontener nigdy nie aktualizuje się sam (`CANOPY_INSTALL_KIND=docker`, Settings → App
  updates pokazuje „Pull the new image tag and recreate this container” zamiast przycisku Update). Gateway migruje bazę przy starcie;
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

## Relay powiadomień push

Relay działa jako osobny proces. Obraz `ghcr.io/itsoltech/canopy-push-relay`
dziedziczy tag wersji i aliasy kanałów wydania, np. `nightly`, `beta` i `stable`.
Obraz nasłuchuje na `0.0.0.0:24444` i uruchamia relay jako UID i GID 65532.
Przekaż ustawienia przy uruchamianiu kontenera. Zamontuj pliki TLS i poświadczenie
konta usługi Google tylko do odczytu, z uprawnieniami do odczytu dla procesu.
W trybie z atestacją zamontuj trwały katalog SQLite z prawem zapisu dla UID 65532.
Ścieżki w zmiennych wskazują pliki wewnątrz kontenera.

Ze źródeł można go uruchomić poleceniem `bun run --filter @canopy/push-relay start`.
Włącz uwierzytelnianie żądań
push w projekcie Expo aplikacji i udostępnij relayowi poświadczenie z dostępem
do tego projektu. Relay wysyła przez HTTPS do Expo Push Service. APNs i FCM
konfiguruje właściciel aplikacji w EAS.

| Zmienna relaya | Wartość |
| --- | --- |
| `CANOPY_PUSH_RELAY_TLS_CERT_FILE` | Plik PEM z certyfikatem i łańcuchem dla nazwy hosta relaya |
| `CANOPY_PUSH_RELAY_TLS_KEY_FILE` | Plik PEM z kluczem prywatnym serwera |
| `CANOPY_PUSH_RELAY_BEARER_SHA256` | Opcjonalna lista hashy ręcznie wydanych tokenów, każdy jako SHA-256 w hex, rozdzielonych przecinkiem |
| `EXPO_ACCESS_TOKEN` | Token do wysyłki i odczytu potwierdzeń projektu Expo |
| `CANOPY_PUSH_RELAY_HOST` | Adres nasłuchu. Domyślnie `127.0.0.1` ze źródeł i `0.0.0.0` w obrazie |
| `CANOPY_PUSH_RELAY_PORT` | Port TLS. Domyślnie `24444` |

### Relay Canopy z automatyczną aktywacją

Lokalny Desktop domyślnie używa `https://notifications-relay.canopy.itsol.tech`.
Na gatewayu serwerowym włącz tę usługę przez **Settings → Network access →
Mobile push relay → Use Canopy relay**. Można też wskazać zarządzany relay
z atestacją przez `CANOPY_MANAGED_PUSH_RELAY_ORIGIN`. Zapisany wybór ma
pierwszeństwo przed ustawieniami wdrożenia.

Włącz przynajmniej jedną platformę, skonfiguruj podpisaną aplikację i zachowaj
trwały stan relaya. Na publicznym relayu limity rejestracji używają adresu
połączenia TCP. Kieruj ruch bezpośrednio lub przez warstwę transportową zachowującą
adres. Relay nie ufa przekazanym nagłówkom IP.

| Zmienna | Wartość |
| --- | --- |
| `CANOPY_PUSH_RELAY_ENROLLMENT_DB` | Ścieżka do trwałej, prywatnej bazy SQLite relaya |
| `CANOPY_PUSH_APPLE_TEAM_ID` | Prefiks App ID użyty w podpisie aplikacji |
| `CANOPY_PUSH_APPLE_BUNDLE_ID` | Bundle ID aplikacji z App Attest |
| `CANOPY_PUSH_APPLE_ENVIRONMENT` | `production` domyślnie, również dla TestFlight. `development` wyłącznie w odizolowanym środowisku testowym |
| `CANOPY_PUSH_ANDROID_PACKAGE_NAME` | Pakiet podpisanej aplikacji Android |
| `CANOPY_PUSH_ANDROID_CLOUD_PROJECT_NUMBER` | Dziesiętny numer projektu Google Cloud z Play Integrity API |
| `CANOPY_PUSH_ANDROID_SERVICE_ACCOUNT_FILE` | Prywatny plik JSON konta usługi uprawnionego do weryfikacji Play Integrity |
| `CANOPY_PUSH_ANDROID_SIGNING_CERT_SHA256` | Dozwolone odciski SHA-256 certyfikatów podpisujących build, w hex, rozdzielone przecinkiem |
| `CANOPY_PUSH_ANDROID_ALLOW_UNRECOGNIZED_VERSION` | Opcjonalne `1` pozwala zweryfikować ręcznie instalowany APK przy rozpoznanym podpisie aplikacji i integralnym urządzeniu. Domyślnie wymagany jest `PLAY_RECOGNIZED` |

Wyzwanie wygasa po 5 minutach. Atestacja obejmuje platformę i token Expo telefonu.
Relay zapisuje hashe poświadczenia i celu wysyłki. Poświadczenie jest ograniczone
do jednego tokena Expo i platformy, wygasa po 35 dniach i może zostać odnowione
najdalej do 90 dni od atestacji. Gdy odnowienie osiąga tę granicę, telefon ponawia
atestację po otwarciu aplikacji i korzysta z dotychczasowego poświadczenia do jego
wygaśnięcia lub zastąpienia. Migracja bazy relaya daje istniejącym
poświadczeniom okres przejściowy do 35 dni. Po rozparowaniu lub wyłączeniu push
gateway odwołuje poświadczenie na relayu. Jeśli relay jest niedostępny, odwołanie
czeka w trwałej kolejce gatewaya.
Sprawdź atestację na fizycznym iPhonie z TestFlight i na podpisanym APK przed
włączeniem ruchu produkcyjnego. [App Attest w Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/app-integrity/) ·
[Werdykty Play Integrity](https://developer.android.com/google/play/integrity/verdicts).

### Własny relay z ręcznie wydanym tokenem

Dla każdej instalacji użyj osobnego tokenu z 32 losowych bajtów zakodowanych
jako base64url bez dopełnienia. Oblicz SHA-256 z 43 znaków tokenu bez końca linii.
Po zmianie tokenu usuń jego stary hash z konfiguracji i uruchom relay ponownie.

W **webie serwerowym** lub **Desktopie** otwórz **Settings →
Network access → Mobile push relay → Use custom relay**. Podaj adres HTTPS
i token tej instalacji. Jeśli relay korzysta z prywatnego CA, wklej jego
certyfikat w formacie PEM. Zapis działa bez restartu. Zmiana adresu wymaga
podania tokena dla nowego adresu.

Wdrożenie serwerowe może ustawić wartości początkowe przez `CANOPY_PUSH_RELAY_ORIGIN`
i `CANOPY_PUSH_RELAY_BEARER`. Compose odczytuje obie zmienne z `.env`. Dla
prywatnego CA ustaw `CANOPY_PUSH_RELAY_CA_FILE` na plik PEM z tym CA. W Compose
dodaj zmienną i zamontuj plik tylko do odczytu w override. Gateway korzysta
z tych wartości, dopóki właściciel nie zapisze wyboru w panelu. Po usunięciu
relaya w panelu gateway wstrzymuje wysyłkę. Jeśli wdrożenie domyślnie używa
relaya zarządzanego, panel pozwala wrócić do niego przez **Use Canopy relay**.
Wybór obowiązuje także po restarcie.

Gateway weryfikuje nazwę hosta i łańcuch certyfikatu, wymaga TLS 1.3 i odrzuca
przekierowania. Konfiguracja relaya jest opcjonalna.

Do wysłania alertu relay potrzebuje tokenu Expo i zaszyfrowanego podglądu.
Podgląd odszyfrowuje telefon. [Zakres powiadomień i prywatność](notifications.md#push-na-ios-i-androidzie) ·
[Wymagania buildu mobilnego](mobile.md#powiadomienia-push) ·
[Konfiguracja Expo Push](https://docs.expo.dev/push-notifications/push-notifications-setup/).
