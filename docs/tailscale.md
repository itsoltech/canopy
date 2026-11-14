# Tailscale

Canopy sam wykrywa Tailscale na komputerze gatewaya i korzysta z niego bez dodatkowej konfiguracji:
nazwa MagicDNS staje się pierwszym adresem Network access, a opcjonalny przełącznik **HTTPS over
Tailscale** udostępnia web UI pod `https://<nazwa-magicdns>` z ważnym certyfikatem. Canopy nigdy nie
loguje do Tailscale, nie zmienia ACL, kluczy, exit node ani preferencji i **nigdy nie włącza Funnel**.

Powiązane: [network-access.md](network-access.md) (listener, adresy), [linked-computers.md](linked-computers.md)
(trasy), [worker-config.md](worker-config.md) (adres gatewaya dla workerów, instalacja przez SSH),
[desktop.md](desktop.md) (origin web desktopu), [deploy.md](deploy.md).

Implementacja: `apps/gateway/src/network/tailscale/` (`cli.ts` — wyszukiwanie CLI/LocalAPI i uruchamianie,
`status.ts` — parsowanie stanu, `tailscale.ts` — odczyt z cache, `serve.ts` — wpisy Serve, `front.ts` —
lokalne proxy web, `https.ts` — przełącznik), pole `NetworkAccess.tailscale` w
`proto/canopy/ui/v1/network.proto`, UI `apps/web/src/lib/features/network/tailscale/`.

## Wykrywanie (tylko odczyt)

Każdy gateway, który widzi Tailscale, sprawdza go sam:

1. `tailscale` na `PATH` gatewaya;
2. na macOS CLI z aplikacji: `/Applications/Tailscale.app/Contents/MacOS/Tailscale`;
3. bez CLI — gniazdo LocalAPI (`/var/run/tailscale/tailscaled.sock`, `/run/tailscale/tailscaled.sock`),
   wyłącznie `GET /localapi/v0/status`.

Odczyt: `tailscale status --json` (lub LocalAPI) ze stałą tablicą argumentów, bez powłoki, z limitem 5 s.
Canopy bierze tylko: `BackendState`, `Self.DNSName` (bez końcowej kropki), adresy tailnetu IPv4/IPv6,
nazwę tailnetu, `MagicDNSEnabled`, `CertDomains` oraz login właściciela węzła (`Self.UserID` → `User`)
albo informację, że węzeł ma tagi. Reszta JSON (peery, klucze, ruch) nie jest zapisywana ani logowana.
Logi mówią tylko o zmianie stanu (`tailscale: connected`), bez nazw i adresów.

Stany: `not_installed` (brak CLI i gniazda — typowo Docker i serwery), `not_running` (tailscaled nie
odpowiada), `stopped` (`tailscale down`), `logged_out` (`NeedsLogin`, `NeedsMachineAuth`), `starting`,
`connected`. Nazwa i adresy są znane tylko w stanie `connected`. Brak Tailscale nigdy nie zatrzymuje
gatewaya; Canopy nie instaluje ani nie uruchamia Tailscale.

Odczyt jest cache'owany 5 s (Settings odświeża co 5 s), odświeżany co 30 s w tle i na żądanie
(„Check again”, akcja `refresh_tailscale`). Zmiana stanu odświeża adresy Network access od razu.

## Automatyczne użycie tailnetu

Bez żadnych ustawień. Gdy Tailscale jest `connected`, lista adresów Network access zaczyna się od
nazwy MagicDNS (`https://<nazwa>:<port listenera>`, rodzaj `tailscale`, interfejs „MagicDNS”), potem
adres IPv4 tailnetu, a dalej jak dotąd: LAN, VPN, publiczne, dodane nazwy. Bez MagicDNS pierwszy jest
adres IPv4 tailnetu. Nazwa dodana ręcznie, równa nazwie MagicDNS, nie jest powielana. Ta kolejność trafia
wszędzie, gdzie gateway używa `NetworkAccess.addresses()`/`origins()`:

- ogłoszenia tras dla połączonych komputerów (`NodeHello.addresses`, ramka `routes`); adresy LAN zostają,
  za nazwą MagicDNS;
- domyślny „Gateway address for workers” (pusty wpis = pierwszy adres) i instalator SSH;
- trasy w kodach QR i linkach parowania telefonów i klientów desktopowych;
- karta Network access i podsumowanie w Linked computers.

Telefon porządkuje kandydatów lokalnie: IP Tailscale wyprzedza nazwę MagicDNS, więc niedziałający
resolver telefonu nie opóźnia działającego IP. Kolejność ogłaszana pozostałym klientom nie zmienia się.
Szczegóły timeoutów i diagnostyki tras: [mobile.md](mobile.md#parowanie-i-granica-uprawnień).

**Certyfikaty bez zmian.** Każdy klient (łącze komputerów, worker, enrollment, UpdateService, telefony
iOS/Android) sprawdza pełny SHA-256 przypiętego certyfikatu i pomija weryfikację nazwy hosta
(`checkServerIdentity` porównuje pin). Nazwa MagicDNS działa więc jak każdy adres: nie trzeba jej dodawać
do SAN ani wyłączać weryfikacji. Odbiorca ogłoszeń waliduje ją jak inne originy HTTPS (`linkAddress`).

Instalacja workera przez SSH nadal odrzuca loopback dla innego komputera. Gdy Tailscale jest połączony,
komunikat błędu podaje adres MagicDNS do użycia. Ręcznie zapisany adres dla workerów zawsze wygrywa.

## HTTPS over Tailscale

Opcjonalny przełącznik (domyślnie wyłączony) w Settings → Network access → Tailscale, na desktopie
i natywnych gatewayach. Daje przeglądarkom i telefonom w tailnecie ważny certyfikat dla web UI, bez
przypinania: `https://<nazwa-magicdns>` (port 443) albo `https://<nazwa-magicdns>:<port>`.

### Mechanizm

```
przeglądarka ──HTTPS (cert Tailscale)──▶ tailscaled (Serve)
  ──HTTP──▶ 127.0.0.1:<port front> (gateway, „front”) ──HTTP──▶ web BFF (CANOPY_WEB_ORIGIN)
```

- Gateway uruchamia na loopbacku małe proxy („front”) i dodaje jeden wpis Serve:
  `tailscale serve --bg --yes --https=<port> http://127.0.0.1:<port front>`.
  Wyłączenie: `tailscale serve --https=<port> off`. Argumenty to stałe tablice; test sprawdza, że
  żadne polecenie nie zawiera `funnel`.
- Port HTTPS: 443, jeśli jest wolny w konfiguracji Serve, inaczej 8447. Użytkownik może wybrać własny
  („Change”); 0 przywraca wybór automatyczny.
- Przed zmianą Canopy czyta `tailscale serve status --json`. Port zajęty przez wpis, którego Canopy nie
  dodał (także TCP forward), jest odrzucany: „Port 443 is already used by another Tailscale Serve
  entry. Choose another port.”. Dodany wpis (port, nazwa, cel) jest zapisywany w bazie; wyłączenie,
  zmiana portu albo nazwy usuwa wyłącznie ten wpis i tylko wtedy, gdy nadal wskazuje front Canopy.
  Wpis zmieniony przez kogoś innego zostaje nietknięty i zapomniany.
- Wpis jest trwały (`--bg`), a port frontu zapisany, więc restart gatewaya go nie zmienia. Gdy gateway
  nie działa, Tailscale odpowiada błędem bramy.

### Front: kto może otworzyć

Front przyjmuje tylko żądania, które przyszły przez wpis Serve Canopy:

- `Host` musi być nazwą MagicDNS (z portem, gdy nie 443);
- żądania Funnel (`Tailscale-Funnel-Request`) są zawsze odrzucane;
- `Tailscale-User-Login` (nagłówek tożsamości, który tailscaled ustawia i którego klient nie może
  podrobić przez Serve) musi być loginem właściciela tego komputera w Tailscale. Inni użytkownicy
  tailnetu i urządzenia z tagami dostają 403. Węzeł z tagami nie ma właściciela: na desktopie
  przełącznik jest wtedy niedostępny; na serwerze front przyjmuje każde żądanie z tailnetu
  (jak dotychczasowy port web serwera);
- `Origin` (gdy jest) musi być originem HTTPS tego wpisu, a `Sec-Fetch-Site` nie może być `cross-site`.

Dopiero wtedy front przepisuje `Host`, `Origin` i `X-Forwarded-*` na origin web BFF i przekazuje
strumieniowo (także SSE). Nagłówki `Tailscale-*` nie trafiają do BFF. Przekierowania na origin BFF
wracają z originem tailnetu. Dzięki temu BFF desktopu zostaje na loopbacku z dokładnym originem
`CANOPY_WEB_ORIGIN`, a kontrola CSRF SvelteKit i `trustedDesktopRequest` działają bez zmian:
sprawdzenie originu przeglądarki robi front, zanim go przepisze.

gRPC workerów **nie** idzie przez Serve: Serve kończy TLS certyfikatem Tailscale, więc worker straciłby
przypięty certyfikat gatewaya, a HTTP/2 do backendu wymagałby `h2c`. Workery i telefony dalej używają
listenera Network access z pinem, pod nazwą MagicDNS.

### Wymagania i stany

`TailscaleHttps.state`: `off`, `on`, `error`, `unavailable`. Pole `unavailable` podaje jedną przyczynę:

| Sytuacja | Komunikat |
|---|---|
| Tailscale nie jest połączony | „Connect this computer to Tailscale first.” |
| brak CLI (tylko LocalAPI) | „Install the Tailscale command-line tool to turn this on.” |
| gateway nie zna originu web (`CANOPY_WEB_ORIGIN`) | „This gateway doesn't know where its web app runs.” |
| desktop z tagami | „This computer is tagged in Tailscale, so Canopy can't check who opens it.” |
| `CertDomains` puste | „Turn on HTTPS certificates in the Tailscale admin console.” + link do DNS |

Błąd uprawnień (`Access denied`, brak operatora) → „Tailscale didn't let Canopy change Serve. Run
`sudo tailscale set --operator=$USER` once, then try again.”. Ustawienie zostaje włączone, a stan
`error` jest ponawiany przy zmianie Tailscale.

### Ustawienia

Kolumny `network_access` (migracja **0083_tailscale_https**): `tailscale_https` (przełącznik),
`tailscale_https_port` (wybrany port albo NULL = automatyczny), `tailscale_front_port` (port frontu)
oraz `tailscale_serve` (JSONB: dokładnie dodany wpis `{port, host, target}`). Owner-scoped jak reszta
wiersza. Akcje `UpdateNetworkAccess`: `refresh_tailscale`, `set_tailscale_https` (`enabled`),
`set_tailscale_https_port` (`port`, 0 = automatyczny). Telefony nie mają dostępu do tych RPC (lista
odmów w `api/auth.ts`); klienty desktopowe i BFF mają zakres właściciela.

`CANOPY_WEB_ORIGIN` na gatewayu (klasa a): origin web BFF na loopbacku. Desktop ustawia go sam;
binarka z wbudowanym web domyślnie używa `http://127.0.0.1:$CANOPY_WEB_PORT`
([deploy.md](deploy.md#gateway-z-wbudowanym-web-jedna-binarka)). Natywny serwer z osobnym web
może go ustawić (np. `http://127.0.0.1:3000`, web z `PROTOCOL_HEADER=x-forwarded-proto`).
Bez niego przełącznik jest niedostępny. Docker zwykle nie widzi Tailscale: stan `not_installed`.

## Połączone komputery

Każdy gateway wykrywa Tailscale u siebie i ogłasza własną nazwę MagicDNS jako pierwszą trasę.
Odbiorca dopisuje ją jako `announced` i łączy się przez przypięty mTLS; trasy ręczne, LAN, wycofane
i relay działają jak dotąd.

## Jednorazowo w konsoli Tailscale

- **MagicDNS** (DNS → MagicDNS) — bez niego pierwszym adresem jest IP tailnetu.
- **HTTPS Certificates** (DNS → HTTPS Certificates) — tylko dla HTTPS over Tailscale.
- ACL muszą pozwalać na TCP do portu Network access (workery, telefony, komputery) i do portu HTTPS.
- Na Linuxie gateway działający jako zwykły użytkownik potrzebuje `sudo tailscale set --operator=$USER`
  do zmiany Serve (odczyt działa bez tego).

## Weryfikacja

Testy używają atrapy CLI (`tests/integration/fixtures/tailscale/tailscale`, skrypt Bun z własnym stanem
i dziennikiem wywołań) i nigdy nie uruchamiają prawdziwego `tailscale`; testy przekazują pusty zestaw
gniazd LocalAPI. `tailscale-detection.test.ts`: parsowanie każdego stanu, brak tailscaled i brak
Tailscale, tagi, brak `CertDomains`, ścieżka aplikacji macOS, LocalAPI przez gniazdo, cache i zmiany.
`tailscale-network.test.ts`: kolejność adresów, wybór adresu dla workerów i SSH, RPC z zakresem
właściciela, ogłoszenie i walidacja nazwy MagicDNS między dwoma gatewayami. `tailscale-https.test.ts`:
dokładne argumenty włączania i wyłączania, odmowa zajętego portu, usuwanie tylko własnego wpisu, brak
`funnel`, brak certyfikatów, odmowa uprawnień oraz front (tożsamość, Funnel, origin, SSE).
