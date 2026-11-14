# Dostęp sieciowy (Network access)

Jeden przełącznik na komputer: **Settings → Network access → „Let phones and other computers connect”**.
Włączony otwiera jeden listener TLS na wszystkich interfejsach; z niego korzystają połączone komputery
i telefony. Nie ma wyboru interfejsu, nie ma zmiennych środowiskowych do ustawienia
na desktopie i nie trzeba nic zmieniać po przejściu do innej sieci. Granicą bezpieczeństwa jest
przypięty certyfikat tego komputera i parowanie, nie sieć.

**Połączone komputery są funkcją wyłącznie lokalnego trybu Canopy Desktop.** Kontroler
desktopu ustala wewnętrzną rolę `desktop` dla własnego gatewaya; zwykły start gatewaya
ma rolę `server`. Na serwerze przełącznik nosi nazwę „Let devices and workers connect”
i obsługuje telefony, sparowane klienty desktopowe oraz workery. Nie uruchamia usług
linkowania, discovery/mDNS, luster, wspólnej konfiguracji, przenoszenia ani relay.
Połączenia komputerów z certyfikatem klienta są odrzucane. Zapisane dawne relacje
pozostają w bazie jako `inactive`, bez połączeń i synchronizacji.
`GetClientCapabilities.linked_computers` steruje widocznością linkowania w webie
i desktopie remote; brak capability ukrywa tę funkcję, także przy starym gatewayu.

Implementacja: `apps/gateway/src/network/` (`network.ts` — stan i ustawienia, `listener.ts` — serwer TLS,
`addresses.ts` — wykrywanie adresów i nazwy hostów, `local-network.ts` — podpowiedź macOS), migracja
**0055_network_access**, kontrakt `proto/canopy/ui/v1/network.proto` (`GetNetworkAccess`,
`UpdateNetworkAccess`), UI `apps/web/src/lib/features/network` i `/settings/network`.

## Ustawienia i ich źródło

Ustawienia leżą w bazie gatewaya (`network_access`, jeden wiersz na gateway, owner-scoped jak
`computer_identity`) i są edytowane w aplikacji:

| Pole | Znaczenie | Domyślnie |
|---|---|---|
| `enabled` | przełącznik „Let phones and other computers connect” | wyłączony (bezpieczny desktop) |
| `port` | port listenera | wybierany przy pierwszym włączeniu i zapisywany |
| `hostnames` | dodatkowe nazwy (`host` albo `host:port`), maks. 8 | brak |

Migracja włącza dostęp tylko komputerom, które miały już połączonych partnerów (ich listener działał),
a starą kolumnę `computer_identity.listener_enabled` usuwa. Akcja `ManageComputer` `listener` zniknęła;
jej rolę pełni `UpdateNetworkAccess` `set_enabled`.

**Pierwszeństwo:** baza/UI jest źródłem prawdy. Jedynym wyjątkiem jest `CANOPY_NETWORK_PORT` —
opcjonalny port ustalony przez wdrożenie serwerowe (opublikowany port kontenera). Gdy jest ustawiony,
wygrywa z portem z bazy, UI pokazuje go tylko do odczytu („Set by this server's configuration”),
a zapisany w bazie wybór zostaje na start bez tej zmiennej. Niepoprawna wartość zatrzymuje start gatewaya.

## Listener

Jeden port, HTTP/2 i HTTP/1.1 (ALPN), TLS z certyfikatem tożsamości komputera z
[etapu 1 połączonych komputerów](linked-computers.md#tożsamość-i-certyfikaty). Gateway słucha na `::`
(IPv6 z mapowaniem IPv4), a bez IPv6 w systemie na `0.0.0.0`. Telefon uśpiony w tle albo za NAT-em,
który zapomniał mapowanie, nie zamyka połączenia; jego strumienie (i subskrypcje overview) zostawałyby
otwarte na zawsze. Dlatego listener wysyła każdej sesji HTTP/2 PING co 20 s i niszczy sesję bez
odpowiedzi w 60 s (najpóźniej 80 s od utraty ścieżki); połączenia HTTP/1.1 mają systemowy keepalive TCP.
Handshake TLS ma limit 15 s, żeby krótka przerwa tunelu VPN nie zamykała nowego połączenia.
Serwer prosi o certyfikat klienta,
ale go nie wymaga:

- połączenie **z certyfikatem** w roli `desktop` trafia wyłącznie do `ComputerLinkService` i dodatkowo musi być TLS 1.3
  (dotychczasowe zasady pinu, samopodpisu i `Pair`/`Connect` bez zmian);
- rola `server` odrzuca połączenie z certyfikatem klienta, bez montowania usługi łącza;
- połączenie **bez certyfikatu** trafia do usług urządzeń (telefony, etap 2); bez nich dostaje 403.

Tożsamość i lista partnerów są gotowe przed otwarciem listenera. Gdy usługa komputerów
jest jeszcze uruchamiana albo już zatrzymywana, `Pair` i `Connect` zwracają `Unavailable`,
bez oceny zaufania. Restart nie odtwarza certyfikatu: listener używa zapisanego certyfikatu
i zaszyfrowanego klucza z `computer_identity`.

Listener nie wystawia BFF ani bazy. Sparowane desktopowe BFF korzystają z UI gRPC
na tym samym listenerze, z osobnym odwoływalnym tokenem i przypiętym certyfikatem
([desktop-remote-frontend.md](desktop-remote-frontend.md)); telefony mają ten sam
zakres UI właściciela. DesktopMigrationService emituje poświadczenie wyłącznie tutaj,
po uwierzytelnieniu własnego workera desktopowego; stary endpoint udostępnia jedynie
uwierzytelnione trasy migracji. Workery bez certyfikatu klienta korzystają z WorkerLink,
enrollmentu i niezależnego UpdateService (etap 3), które same weryfikują tokeny i właściciela.
`DesktopControlService` i `DesktopWorkerService` są dostępne wyłącznie tutaj:
poświadczenie desktopu otwiera sterowanie aktualizacją aplikacji, a osobny credential
workera potwierdza bieżącą sesję i powiązanie właściciela. To osobny strumień od
WorkerLink i zamrożonego UpdateService; nie przekazuje binariów ani adresów feedu.
Żądania z nagłówkiem Origin są odrzucane. Minimalna wersja TLS serwera to 1.2
(starsze telefony); komputery same wymagają 1.3.

Log gatewaya (również sidecar desktopu) zapisuje otwarcie TLS, protokół, identyfikator sesji,
zamknięcie z przyczyną i czasem trwania oraz przekroczenie terminu PING. Nie zapisuje adresów,
certyfikatów, tokenów, nagłówków ani payloadów. `pin_check=client_side` oznacza miejsce weryfikacji:
serwer nie może potwierdzić, czy klient porównał jego pin. Wynik „OK” probe w arkuszu telefonu
potwierdza zgodny pin po stronie klienta. Błąd handshake'u ma osobny wpis `tls_handshake_failed`.

### Port

Pierwsze włączenie losuje wolny port z zakresu 20000–31999 (poniżej zakresów efemerycznych Linuksa,
macOS i Windows) i zapisuje go; kolejne starty i ponowne włączenia używają tego samego portu, więc
zapisane trasy partnerów i telefonów pozostają ważne. „Change” ustawia własny port (np. otwarty
w firewallu serwera) albo „Pick a free port”. Zmiana otwiera nowy port **przed** zamknięciem starego:
nowe trasy są zapisywane i ogłaszane przez istniejące połączenia, a stary listener przestaje
przyjmować nowe połączenia. Przez maksymalnie 5 s pozwala dokończyć odpowiedź RPC i przesłać
ogłoszenia otwartymi strumieniami (HTTP/2 używa GOAWAY), potem zamyka pozostałe sockety.
Telefon zapisuje trasy także z odpowiedzi `UpdateNetworkAccess`, więc zmiana portu działa
bez aktywnego overview. Certyfikat i token urządzenia pozostają te same.
Zajęty port niczego nie psuje, a dialog pokazuje „Port N is already used by another app. Choose another
port.”. Zapisany port zajęty przy starcie daje stan `error` z tym samym komunikatem i przyciskiem
„Pick a free port”; gateway startuje normalnie. `EACCES`/`EPERM` → „This computer doesn't allow Canopy
to use port N. Choose a port above 1024.”.

### Adresy

Gateway sam wykrywa adresy IPv4 interfejsów i odświeża je co 10 s (nowe Wi-Fi, włączony VPN).
Rodzaje: `lan` (adresy prywatne), `tailscale` (100.64.0.0/10 na interfejsie Tailscale/utun),
`vpn` (wg, tun, zt…), `public`; pomijane są loopback, link-local, multicast, adresy zarezerwowane oraz
mosty kontenerów i maszyn wirtualnych (docker, br-, bridge/bridge100, veth, virbr, vboxnet, vmnet,
OrbStack, vEthernet, opisowe nazwy adapterów VMware/VirtualBox/Hyper-V). `utun` zostaje tylko dla
adresu Tailscale; pozostałe tunele `utun` i interfejsy pomocnicze macOS (awdl, llw, anpi) są pomijane.
Adres sieci i broadcast są odrzucane według rzeczywistej maski, również poza /24. /31 (łącza punkt-punkt)
i /32 (trasy hosta, m.in. Tailscale) zachowują oba końce. Filtrowanie jest czystą funkcją
`advertisedAddresses`; API systemowe Node nie podaje typu adaptera, więc interfejsy wirtualne rozpoznaje
po nazwie. Sama nazwa nie dowodzi osiągalności; klient nadal weryfikuje przypięty TLS.
Bez Tailscale kolejność to LAN, pozostałe VPN, publiczne IPv4.
Dodane nazwy i adresy publiczne (`hostname`) idą na końcu, na
porcie listenera albo na własnym porcie (`canopy.example.com:8443`, gdy router przekierowuje inny port).
Zmiana listy jest ogłaszana od razu partnerom (ramka `routes`, [etap 6](linked-computers.md#ogłaszanie-adresów-przez-łącze)).
Nowe QR oraz odpowiedzi `UpdateNetworkAccess` i ogłoszenia `mobile_routes` korzystają z tej samej
przefiltrowanej listy. Telefon zastępuje nią wcześniej zapisane adresy, bez ponownego parowania.

Lista adresów **nie jest zaufaniem**: każde połączenie i tak sprawdza przypięty certyfikat.

Gdy Tailscale jest połączony, pierwszym adresem jest nazwa MagicDNS, a za nią adres tailnetu
([tailscale.md](tailscale.md#automatyczne-użycie-tailnetu)).

### Podpowiedzi zamiast instrukcji

Pole `note` pojawia się tylko, gdy coś wymaga działania:

- kontener na domyślnej sieci bridge (sam `eth*` i `/.dockerenv`) nie widzi adresów hosta → „Add the
  server's hostname or IP address”;
- macOS odmówił dostępu do sieci lokalnej: połączenie z adresem w podsieci własnego interfejsu kończy
  się `EHOSTUNREACH`/`ENETUNREACH` → komunikat z drogą do System Settings → Privacy & Security → Local
  Network (także zamiast ogólnego „unreachable” przy parowaniu);
- włączony dostęp bez żadnego adresu → „This computer isn't connected to a network right now.”

## UI

- **Settings → Network access**: przełącznik, „Reachable at” (adres, rodzaj, interfejs, kopiowanie,
  usuwanie dodanych nazw, „Add hostname”), „Advanced” (port i „Change”, odcisk certyfikatu).
- **Settings → Network access → Tailscale**: stan Tailscale, nazwa MagicDNS i adresy tailnetu z kopiowaniem,
  „Check again” oraz „HTTPS over Tailscale” (przełącznik, adres z kodem QR, port) — [tailscale.md](tailscale.md).
- **Settings → Linked computers**: karta stanu („Network access is on · Reachable at 192.168.1.20,
  100.x.y.z (Tailscale)…” albo „off” z przyciskiem „Turn on”) i link „Manage”. „Link a computer” przy
  wyłączonym dostępie oferuje jednym kliknięciem „Turn on network access and generate a code”; wpisanie
  kodu z drugiego komputera działa bez włączania.

## Inwentaryzacja zmiennych środowiskowych

(a) — bootstrap wdrożenia, zostaje w env; desktop ustawia je sam, UI nigdy nie każe ich ustawiać.
(b) — konfiguracja produktu: baza + UI; env najwyżej jako opcjonalne nadpisanie serwera.

| Zmienna | Klasa | Stan |
|---|---|---|
| `CANOPY_DATABASE_URL`, `CANOPY_SECRETS_KEY`, `CANOPY_UI_SERVICE_TOKEN` | a | bez zmian |
| `CANOPY_HOST`, `CANOPY_PORT`, `CANOPY_TLS_CERT`, `CANOPY_TLS_KEY` | a | port procesu (BFF/worker) w kontenerze; desktop: loopback |
| `CANOPY_MIGRATE`, `CANOPY_DEV_USER_EMAIL`, `CANOPY_RELEASE_BASE_URL`, `CANOPY_UPDATE_CACHE_DIR`, `CANOPY_UPDATE_CHANNEL`, `CANOPY_SUPERVISED`, `CANOPY_INSTALL_KIND` | a | bez zmian (wdrożenie/updater) |
| `CANOPY_NETWORK_PORT` | a | nowe, opcjonalne: port opublikowany przez kontener |
| `CANOPY_WEB_ORIGIN` (gateway) | a | opcjonalny origin web BFF dla HTTPS over Tailscale; desktop ustawia sam, binarka z wbudowanym web wylicza go z `CANOPY_WEB_PORT` ([tailscale.md](tailscale.md)) |
| `CANOPY_WEB`, `CANOPY_WEB_HOST`, `CANOPY_WEB_PORT`, `CANOPY_WEB_DIR` | a | wbudowany web binarnego gatewaya i obrazu `canopy-gateway`: `off` = headless, loopback `127.0.0.1:3000` (w obrazie `0.0.0.0`), katalog wersji; `CANOPY_WEB_ALLOWED_HOSTS` — dozwolone nazwy `Host` ([deploy.md](deploy.md#gateway-z-wbudowanym-web-jedna-binarka)) |
| `CANOPY_LINK_HOST`, `CANOPY_LINK_PORT`, `CANOPY_LINK_ADDRESSES` | b | **usunięte** → Network access (etap 1) |
| `CANOPY_LINK_DISCOVERY` | b | diagnostyka wykrywania desktopu; serwer nigdy nie uruchamia discovery niezależnie od wartości |
| `CANOPY_MOBILE_PORT`, `CANOPY_MOBILE_GATEWAY_URL` | b | **usunięte** → telefony przez Network access (etap 2) |
| `CANOPY_WORKER_HOST`, `CANOPY_WORKER_PORT`, `CANOPY_PUBLIC_GATEWAY_URL` | b | **usunięte** → workery przez Network access; adres w Settings → Workers (etap 3) |
| `CANOPY_ATTACHMENT_MAX_FILE_MB`, `…_MAX_MESSAGE_MB`, `…_MAX_FILES` | b | **usunięte** → Attachments w Network access, zapis w ustawieniach właściciela (etap 3) |

Workery: kreator wybiera adres Network access, a wszystkie polecenia instalacyjne zawierają pełny pin.
Enrollment sprawdza certyfikat przed wysłaniem tokenu i zapisuje go do `worker.json`; WorkerLink
i UpdateService zachowują walidację CA i porównują pełny SHA-256 zamiast nazwy hosta.
Zmiana adresu w Settings → Workers dotyczy nowych instalacji. Istniejące workery pozostają na
dotychczasowym porcie procesu (`CANOPY_PORT`) i nie wymagają zmiany adresu ani ponownego enrollmentu.
Po włączeniu Network access nowy worker ogłasza capability `network_route_migration`, a gateway
przesyła adresy i pełny SHA-256 przez już uwierzytelniony WorkerLink. Worker sprawdza certyfikat
przed wysłaniem credentiala, następnie wykonuje uwierzytelniony `ProbeNetworkRoute` bez zastępowania
działającego strumienia. Dopiero po sukcesie zapisuje atomowo `worker.json` (0600), zachowuje oryginał
w `worker.json.bak` (0600), a pierwotny endpoint jako `gateway_fallback`. WorkerLink i niezależny
UpdateService przechodzą na zweryfikowany adres z pinem. Restart używa zapisanego adresu i certyfikatu.

Nieosiągalne adresy, błędny pin lub błąd zapisu pozostawiają działające połączenie i plik bez zmian;
Settings → Workers pokazuje „Connected over the server port · secure route unavailable: …”.
Ponowienie następuje po zmianie tras lub po 60 s. Po utracie wcześniej zapisanej trasy worker
wraca do pierwotnego endpointu także po restarcie; nie usuwa utrwalonego pinu.
Wyłączony dostęp (domyślnie na desktopie) lub nieopublikowany port w Dockerze nie blokuje pracy
ani aktualizacji. Starsze binarki nie dostają nowych ramek i dalej używają swojego adresu.
Rozszerzenie jest addytywne: `WORKER_LINK_PROTOCOL` bez zmiany, `canopy.update.v1` bez zmian.

Tryb lokalny desktopu utrzymuje BFF i lokalny worker na loopback i pomija migrację;
dawny wybór interfejsu nie otwiera już dodatkowego listenera HTTP.

## Docker i serwer

Dotychczasowy port procesu gatewaya (`CANOPY_PORT`, domyślnie 7443) nadal obsługuje WorkerLink,
Enrollment oraz zamrożony UpdateService — zachowaj istniejące publikowanie/przekazywanie tego portu.
Dotychczasowe wdrożenie jest poprawne również bez dostępu sieciowego. Opcjonalnie opublikuj
dodatkowo port dostępu sieciowego i ustaw go jako `CANOPY_NETWORK_PORT` (szczegóły:
[deploy.md](deploy.md#dostęp-sieciowy-telefony-klienty-desktopowe-i-workery)). Port nie może przechodzić przez
proxy kończące TLS — przekazuj TCP. W kontenerze bez sieci hosta dodaj w Settings → Network access
nazwę albo adres serwera.

## Weryfikacja

`tests/integration/network-access.test.ts`: domyślnie wyłączony; pierwsze włączenie wybiera i zapisuje
port, restart go przywraca; wyłączenie zamyka port; zajęty port przy zmianie (komunikat, stary listener
działa) i przy starcie (stan `error`, „Pick a free port” naprawia); port z `CANOPY_NETWORK_PORT` wygrywa
z bazą i nie da się go zmienić w aplikacji; nazwy hostów (normalizacja, walidacja, limit, powiadomienie
o zmianie); API web; parowanie komputerów przez drugi adres z zaproszenia, ogłoszenie nowej nazwy
partnerowi jako trasy `announced`; klient TLS bez certyfikatu nie dociera do usługi łącza. Klasyfikacja
adresów, podpowiedź macOS i parsowanie `CANOPY_NETWORK_PORT` mają szybkie testy bez Dockera. Pozostałe
zestawy połączonych komputerów działają na tym samym listenerze (`tests/integration/support/computers.ts`).
`tests/integration/network-addresses.test.ts` sprawdza czysty filtr na listach interfejsów macOS,
Linux i Windows, deduplikację, kolejność oraz granice podsieci /23, /24, /25, /31 i /32.
