# Wdrożenie

Canopy to PostgreSQL + gateway + web (BFF i SPA) oraz workery na maszynach, które uruchamiają
agentów. Wersje i kanały: [release.md](release.md). Wszystko pochodzi z
`ghcr.io/itsoltech/canopy-*` albo z GitHub Releases `itsoltech/canopy`.

## Wybór kanału

| Kanał | Obraz | Binaria | Dla kogo |
| --- | --- | --- | --- |
| `latest` | `canopy-gateway:latest` | release `latest` | testy na żywo, każdy push do main |
| `v1` | `canopy-gateway:v1` | najwyższe `v1.*.*` | produkcja z automatycznymi poprawkami i nowymi funkcjami 1.x |
| `v1.2` | `canopy-gateway:v1.2` | najwyższe `v1.2.*` | tylko poprawki |
| `v1.2.3` | `canopy-gateway:v1.2.3` | `v1.2.3` | zamrożona wersja |

Gateway, web i workery powinny być w tej samej wersji (jedna wersja dla wszystkich aplikacji).
Wersję widać w Settings (dół nawigacji), w `GET /api/health`, w `--version` binarek i w logu startu.

## Docker Compose (jeden host)

```sh
mkdir canopy && cd canopy
curl -LO https://raw.githubusercontent.com/itsoltech/canopy/main/deploy/docker-compose.yml
curl -L -o .env https://raw.githubusercontent.com/itsoltech/canopy/main/deploy/.env.example
# uzupełnij .env: POSTGRES_PASSWORD, OA_UI_SERVICE_TOKEN, OA_SECRETS_KEY, OA_PUBLIC_GATEWAY_URL, CANOPY_TAG
docker compose up -d
docker compose ps        # postgres, gateway, web: healthy
```

Wszystkie zmienne opisuje [`deploy/.env.example`](../deploy/.env.example). `OA_SECRETS_KEY`
szyfruje klucze providerów i tokeny konektorów w bazie — zachowaj kopię; jego utrata oznacza
ponowne wpisanie sekretów. Gateway przy starcie wykonuje migracje (`OA_MIGRATE=0` wyłącza).

Domyślnie porty są wystawione tylko na `127.0.0.1`:

- **web** (`WEB_PORT`, 3000): postaw przed nim reverse proxy z TLS. BFF sprawdza origin formularzy
  i bez nagłówka przyjmuje `https`, dlatego compose ustawia `PROTOCOL_HEADER=x-forwarded-proto`
  i `HOST_HEADER=x-forwarded-host`. Uploady: `BODY_SIZE_LIMIT` ≥ limitu pliku gatewaya.
  Przykład Caddy: `canopy.example.com { reverse_proxy 127.0.0.1:3000 }` (Caddy ustawia `X-Forwarded-*`).
- **gateway** (`GATEWAY_PORT`, 7443): gRPC po HTTP/2 dla workerów. Workery spoza hosta: wystaw port
  w prywatnej sieci (`GATEWAY_BIND`, np. adres Tailscale) albo za proxy TLS obsługującym HTTP/2 do
  upstreamu (h2c), i ustaw `OA_PUBLIC_GATEWAY_URL` na adres widoczny dla workerów. Gateway sam
  obsługuje też TLS (`OA_TLS_CERT`, `OA_TLS_KEY` — pliki zamontowane do kontenera).

Worker w kontenerze (opcjonalnie, profil `worker`) — token z Settings → Workers → Add worker:

```sh
docker compose --profile worker run --rm worker enroll --gateway http://gateway:7443 --token <TOKEN>
docker compose --profile worker up -d
```

Obraz workera **nie zawiera CLI agentów** (`claude`, `codex`, `grok`): ich instalacja, wersje
i logowanie należą do użytkownika. Rozszerz obraz, np.:

```dockerfile
FROM ghcr.io/itsoltech/canopy-worker:v1
# Obraz działa jako użytkownik canopy; instalator Claude Code kładzie CLI w ~/.local/bin.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH=/home/canopy/.local/bin:$PATH
```

Loginy CLI (`~/.claude`, `~/.codex`), `worker.json` i dziennik leżą w wolumenie `/home/canopy`.
Projekty, na których pracują agenci, montuj jako dodatkowe wolumeny.

## Binaria (systemd)

Assety release: `canopy-gateway-<os>-<arch>`, `canopy-worker-<os>-<arch>` (`linux|darwin|windows`,
`x64|arm64`), `checksums.txt`, `manifest.json`.

```sh
TAG=latest   # albo v1.2.3
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

Użytkownik systemowy: `useradd --system --home /var/lib/canopy canopy`. `/etc/canopy/gateway.env` (0600, właściciel `canopy`):

```sh
OA_DATABASE_URL=postgres://canopy:…@127.0.0.1:5432/canopy
OA_UI_SERVICE_TOKEN=…        # openssl rand -hex 32, ten sam w web
OA_SECRETS_KEY=…             # openssl rand -base64 32
OA_HOST=0.0.0.0
OA_PORT=7443
OA_PUBLIC_GATEWAY_URL=https://gateway.example.com:7443
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
ExecStart=/usr/local/bin/canopy-gateway
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`systemctl daemon-reload && systemctl enable --now canopy-gateway`; kontrola: `canopy-gateway healthcheck`
(z tymi samymi `OA_HOST`/`OA_PORT`). Web jako usługa: obraz `canopy-web` albo `bun index.js`
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
ExecStart="/home/me/.local/bin/canopy-worker" --config "/home/me/.config/open-agents/worker.json"
Environment="PATH=/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin"
Restart=on-failure
RestartPreventExitStatus=78
RestartSec=5

[Install]
WantedBy=default.target
```

`systemctl --user daemon-reload && systemctl --user enable --now canopy-worker`; żeby działał
bez zalogowanej sesji: `loginctl enable-linger $USER`. `PATH` musi obejmować CLI agentów.
Kod wyjścia 78 = zła konfiguracja (bez restartu w pętli).

## Aktualizacja

- **Docker**: tag kanału (`v1`, `latest`) wskazuje nowy obraz po wydaniu:
  `docker compose pull && docker compose up -d`. Gateway migruje bazę przy starcie;
  migracje są tylko w przód — przed aktualizacją wersji `X.Y` zrób kopię bazy (`pg_dump`).
  Powrót do starszej wersji po migracji wymaga przywrócenia kopii.
- **Binaria**: podmień plik (sprawdź `checksums.txt`) i zrestartuj usługę. Kolejność: gateway,
  potem web, potem workery. Automatyczna aktualizacja workerów/gatewaya korzysta z `manifest.json`
  danego kanału (osobna funkcja self-update).
- **Desktop**: instalator nowej wersji z tego samego release (`Canopy-<wersja>-<os>-<arch>.*`).
- Obrazy i release'y dla konkretnego commita: tag Docker `sha-<sha7>`; binaria `latest` są
  nadpisywane — do przypięcia używaj wydań `vX.Y.Z`.
