# Aktualizacje Canopy

## Zapowiedziana przerwa gatewaya

`WatchOverview` wysyła `gateway_departure` przed aktualizacją i restartem, także
telefonowi, który sam nie zlecił operacji. Sygnał zawiera id próby, `updating` lub
`restarting`, wersję początkową i docelową (jeżeli jest znana), czas rozpoczęcia
oraz pięciominutowe okno. Połączone komputery dostają ten sam rekord w `Presence`;
stan `restarting` zachowuje fallback `updating` dla starszych partnerów.

Checkpoint w prywatnym `user_settings.settings.gatewayDeparture` nie zmienia
wersji edytowalnych ustawień. Po starcie gateway potwierdza uruchomioną wersję,
odczytuje istniejący journal updatera i zapisuje `succeeded`, `failed` albo
`rolled_back` z przyczyną. `GetUpdates.departure` i pierwsza wiadomość kolejnego
overview odtwarzają wynik; raport lokalnej aplikacji desktopowej korzysta z tego
samego checkpointu. Stan partnera jest kwalifikowany jego `node_id`.

Lokalny kontroler desktopu przekazuje docelową wersję również przy zwykłym
„Restart to update”. Restart zdrowia ogłasza `restarting`, o ile gateway nadal
obsługuje RPC. Gateway całkowicie nieodpowiadający nie może rozesłać sygnału;
klienci stosują wtedy zwykłe odzyskiwanie połączenia. Nie zmieniamy
`canopy.update.v1` ani `WORKER_LINK_PROTOCOL`.

Telefon zapisuje ogłoszenie w istniejącym SecureStore parowania. Przez ogłoszone
okno (maksymalnie pięć minut) próbuje ostatniej działającej trasy z zachowaniem
pinu, bez równoległego wyboru innych adresów. Strumienie na pierwszym planie
ponawiają subskrypcję co 2,5 s zamiast narastającego backoffu; tło i brak sieci
nadal zatrzymują próby. Po wygaśnięciu wracają zwykła selekcja tras i komunikaty
o niedostępności. Ogłoszenie partnera nie zmienia trasy telefonu. Raz wysłane RPC
nie jest automatycznie odtwarzane. Po powrocie telefon pokazuje krótki wynik,
wersję oraz szczegóły błędu; starszy gateway bez sygnału działa jak wcześniej.

## Wskaźnik w pasku bocznym

Trzecia ikona stopki (za Settings i licznikiem workerów) pokazuje aktualizacje
własnej aplikacji desktopowej: stan spokojny, sprawdzanie, pobieranie z procentem
oraz gotowość do restartu. Hover i klik otwierają ten sam przewijany popover;
na telefonie jest to dolny panel. Animacja respektuje ograniczenie ruchu.
Przeglądarka serwerowa nie pokazuje sekcji własnej aplikacji.

Popover ma 352 px szerokości i wysokość zależną od zawartości (maksymalnie
70% okna / 512 px); przewija się lista między nagłówkiem a odnośnikami.
Nagłówek zawiera Check now i Update all. Każda pozycja ma zwarty wiersz
z wersjami, stanem i akcją; postęp to cienki kolorowy pasek, a nie pełne
wypełnienie udające 100%. Kolejność: najpierw komputery („This Canopy app”, w trybie
serwerowym gateway, potem każdy połączony komputer), potem workery pogrupowane według
komputera (nagłówek z nazwą, gdy workery są na więcej niż jednym), na końcu zwinięta
sekcja „Agent CLIs · N” z CLI wszystkich komputerów. Jej podsumowanie ma jedną odznakę:
„Failed”, „Installing” albo „N available”, wyrównaną z odznakami wierszy. Komputery
i workery pokazujemy zawsze, także aktualne; dawną grupę „Up to date · N” zastąpiła
zwinięta sekcja CLI. Wiersz połączonego komputera ma stan Up to date, Available,
procent pobierania, Ready, Waiting for idle, Restarting, Offline, Failed albo
Manual update (aplikacja za stara na zdalne aktualizacje lub komputer pośredni), z
przyczyną pod ikoną informacji. Galeria `/dev/updates` (tylko tryb deweloperski)
pokazuje centrum i wszystkie stany na danych testowych, a `?view=settings` obie sekcje
ustawień. Instrukcje
instalacji i kolejność aktualizacji są pod ikonami informacji. Długie nazwy
i wersje mają skrót z pełną treścią w podpowiedzi; błędy można rozwinąć.
Popover nie pokazuje notatek wydań; są w Settings → Workers / App updates razem
z pełnymi ustawieniami, wymuszeniem restartu i szczegółami instalatorów.

Settings → Workers → Updates pokazuje te same wiersze co popover (wspólny komponent
`UpdateRows`): ten komputer, połączone komputery z akcją Update, workery i Agent CLIs
pogrupowane według komputera. Gateway serwerowy ma pod swoim wierszem pole kanału.
Settings → App updates zachowuje ustawienia tej aplikacji i dodaje grupę „Linked
computers”: wiersz na komputer z nazwą, wersją → docelową, kanałem i stanem, przyciskami
Check now (akcja `computer_check`, sprawdzenie feedu tamtej aplikacji) i Update albo tekstem
„Update on that computer” dla aplikacji za starej. Oba przyciski są zawsze widoczne i tylko
się wyłączają, więc zmiana stanu niczego nie przesuwa. Kanał i częstotliwość sprawdzania
partnera są tu tylko do odczytu: każdy komputer zmienia je u siebie. Nagłówek
pokazuje stan i czas sprawdzenia; Update all pojawia się tylko przy dostępnych
aktualizacjach. Aktualne workery nie mają przycisku aktualizacji. Kanał zapisuje
się po wyborze; przejście na starszy kanał lub starszą przypiętą wersję wymaga
potwierdzenia. Wyniki przebiegu można rozwinąć tylko, gdy istnieją kroki.
Brak notatek wydania (także pusty wynik lub niedostępne źródło) ukrywa
„What’s new”; interfejs nie pokazuje pustych akordeonów ani objaśnień tego braku.

Proces main pobiera publiczne GitHub Releases bez tokena, z paginacją i cache
60 sekund. Notatki obejmują `(wersja zainstalowana, wersja pobierana]`, zgodnie
z wybranym kanałem, w malejącej kolejności SemVer. Istniejący renderer Markdown
nie wstrzykuje HTML, ogranicza schematy linków i nie ładuje obrazów. Retencja
nightly może usunąć starsze notatki; panel jawnie wskazuje to ograniczenie.

Release bez feedu platformy lub manifestu nie jest aktualizacją desktopu.
Jeśli nowsza wersja jest już w GitHub Releases, ale nie ma paczki platformy,
updater wyjaśnia, że publikacja może jeszcze trwać lub wymagać ponowienia;
nie twierdzi, że aplikacja jest aktualna.

Gotowa paczka własnej aplikacji nie zatrzymuje sprawdzania: **Check now** w popoverze,
**Check for updates** w Settings → App updates oraz timer nadal szukają nowszych wydań.
Timer zachowuje wybraną częstotliwość; Never wyłącza tylko automatyczne sprawdzanie
i pobieranie. Ten sam lub starszy cel z feedu nie zastępuje gotowej paczki.
Podczas pobierania nowszego buildu wiersz pokazuje jego wersję i procent zamiast Ready;
kolumna akcji pozostaje na miejscu. Restart pozostaje dostępny i czeka na wynik pobierania.
Po sukcesie Ready wskazuje dokładnie nową paczkę, a po błędzie wraca poprzednia wersja
z krótkim „Update failed. Check again to retry.”. Restart instaluje wtedy zachowaną paczkę.
Szczegóły cache i przekazania ZIP do Squirrel: [desktop.md](desktop.md#automatyczne-aktualizacje-desktopu).

Ten sam popover zawiera centrum gatewaya, workerów binarnych, CLI i sparowanych
zdalnych desktopów. Wersja serwerowa UI pokazuje centrum bez własnej aplikacji.
Odnośniki prowadzą do Settings → Workers oraz App updates. Gateway/workery i
zdalne aplikacje pokazują notatki Canopy dla swojego kanału; Claude Code i Codex
korzystają z publicznych Releases dostawców. Grok nie wskazuje takiego źródła,
więc panel pokazuje to ograniczenie oraz istniejące wyjście instalatora.

**Update all** zapisuje kolejkę w prywatnym `user_settings.settings.updateRun`.
Nie zmienia zamrożonego UpdateService ani nie wymaga migracji. Kolejność:
gateway → workery binarne na wersję uruchomionego gatewaya → zainstalowane CLI
→ zdalne aplikacje z nowszą dostępną wersją → aplikacje połączonych komputerów
(tryb lokalny, [niżej](#połączone-komputery)). Brakujące CLI instaluje się osobnym
przyciskiem Install. Własną aplikację desktopową restartuje się niezależnie;
jej dołączony gateway aktualizuje bundle, nie samodzielna wymiana binarki.

Gateway odpytywany co 2 sekundy wznawia zapisaną kolejkę po restarcie. Potwierdzenie
przyjęcia komendy nie kończy kroku: wymagany jest raport wyniku, nowa wersja i
zgodny protokół workera. Każda akcja ponownie sprawdza dotychczasowe uprawnienia.
Błąd lub utrata zgodności zatrzymuje kolejne kroki z przyczyną; Retry update all
tworzy aktualny plan. Timeout kroku to 35 minut. Nie odtwarzamy w ciemno przerwanej
instalacji CLI; bez raportu po 60 sekundach należy sprawdzić worker i ponowić akcję.
Kolejka nie przyznaje force ani downgrade. Obejmuje tylko gateway binarny,
workery binarne, natywne CLI i obsługiwane aplikacje Canopy. Gateway Docker/source,
zewnętrzne workery oraz CLI instalowane przez menedżery pakietów (także npm, Bun,
Volta i pnpm) są pomijane. Worker przechodzi na wersję działającego gatewaya,
nawet gdy dla zewnętrznego gatewaya istnieje nowsze wydanie.
Pusty plan jest odrzucany bez zapisu przebiegu. UI ukrywa wtedy Update all;
zewnętrzne aktualizacje zachowują wersje i instrukcję pod ikoną informacji,
ze stanem „Managed externally” i podsumowaniem „Updates available outside Canopy”.
Stary błąd spowodowany wyłącznie zewnętrznym gatewayem nie jest pokazywany,
gdy bieżący snapshot nie zawiera aktualizacji obsługiwanych przez Canopy.

Publiczne notatki serwerowego centrum pobiera BFF z ustalonej listy repozytoriów,
bez tokenów, z cache 60 sekund. Błąd pobierania ma przycisk Retry i nie blokuje
samej aktualizacji. Rozpoczęty krok zachowuje wersję początkową i docelową,
żeby zmiana najnowszego wydania nie zmieniła historii wybranej aktualizacji.

Workers → Updates oferuje **Update Canopy app** dla `installKind=desktop`.
Aktualizuje całą aplikację: Electron, dołączony runtime i worker. Desktop w trybie
zdalnym musi być sparowany z gatewayem i obsługiwać kanał sterowania z
[etapu 2 lokalnego frontendu](desktop-remote-frontend.md#wynik-etapu-2).
Workery binarne zachowują niezależny mechanizm opisany poniżej.

## Dołączony gateway i worker

W trybie lokalnym aplikacja desktopowa zawiera własny gateway (`CANOPY_GATEWAY_ROLE=desktop`)
i własny worker. Oba aktualizuje bundle aplikacji, więc nie są osobnymi pozycjami. Snapshot
oznacza je addytywnymi polami `UpdatesSnapshot.gateway_bundled` i `WorkerUpdate.bundled`.
O tym decyduje gateway: rola `desktop` oraz capability `desktop_bundled` z WorkerLink Hello
(zapisana w `workers.capabilities`). UI nie zgaduje po nazwie ani `installKind`.

Popover, licznik „Up to date · N”, podsumowanie w nagłówku i Settings → Workers → Updates
pomijają oba elementy. Pozycja „This Canopy app” je reprezentuje; jej podpowiedź mówi
„Includes this computer’s gateway and worker.”. Settings → Workers → Updates pokazuje zamiast
gatewaya i kanału jedno zdanie z odnośnikiem do App updates. CLI agentów tego workera nadal mają
własne wiersze i kroki Update all. Update all pomija dołączony gateway i worker; zewnętrzne workery
podłączone do gatewaya desktopu pokazują się i aktualizują jak dotąd.

Dołączony gateway nie ma własnego kanału: zgłasza kanał swojego buildu (`releaseChannel`
wersji, np. nightly), ignoruje zapisany `updateChannel` i odrzuca akcję `channel`. Wcześniej
bez `CANOPY_UPDATE_CHANNEL` zgłaszał domyślne `stable`, choć aplikacja była na nightly.
Dołączony worker nie otwiera strumienia sterowania desktopu, więc nie dostaje zastępczego
stanu „Pair this desktop app…”, który dawał etykietę „Unavailable”.

Tryb zdalny i gateway serwerowy się nie zmieniają: rola `server` nie oznacza niczego jako
dołączonego, nawet gdy worker zgłasza `desktop_bundled`.

Wiersze (`UpdateItem`) mają stałą kolumnę akcji, także bez akcji, więc odznaki tworzą jedną
kolumnę, a pojawiająca się akcja ich nie przesuwa. Ikona, odznaka i akcja są wyrównane do linii
nazwy; długa nazwa skraca się przed odznaką. Ton odznaki wynika ze stanu (`updateTone`): błąd
rose, praca w toku amber, „Up to date” emerald jak inne ustalone statusy, reszta neutralna.

## Zdalna aktualizacja aplikacji desktopowej

Właściciel gatewaya wysyła żądanie przez Workers; nie wymaga ono administracyjnej
roli potrzebnej do aktualizacji samego gatewaya. Gateway przekazuje wyłącznie id
żądania i ewentualne force. `DesktopControlService` korzysta z tego samego pinned
TLS Network access i odwoływalnego poświadczenia desktopu co jego UI.
Osobne `DesktopWorkerService.Confirm` dowodzi posiadania credentialu własnego
workera tego samego właściciela. Samo `worker_id` ani `installKind` nie wystarcza.

Controller przekazuje żądanie przez prywatne IPC do Electron main. Tylko main
wywołuje `DesktopUpdates`; desktop sam pobiera wydanie swoim normalnym updaterem,
z własnego kanału. Gateway nie dostarcza binariów desktopu, adresów feedu ani zgody
na downgrade. Lokalna próba przełączenia kanału musi się zakończyć przed zdalną
aktualizacją. Docelowy SemVer musi być ściśle nowszy, także gdy lokalnie pobrano
starszą paczkę. Zasady Developer ID/codesign i walidacja Squirrel na macOS pozostają
obowiązujące; brak podpisanego buildu wyłącza funkcję.

Desktop pokazuje powiadomienie o żądaniu. Po pobraniu ustawia barierę przyjmowania
pracy przez własnego workera i czeka na zakończenie tur, generacji i zadań w tle.
Workers pokazuje „Will restart after the current turns”; **Restart now…** otwiera
potwierdzenie przerwania pracy. Force wymaga id tego samego oczekującego żądania.
Restart instaluje cały bundle, uruchamia aplikację i odtwarza połączenie.
Jeżeli podczas oczekiwania na idle pobrano nowszą paczkę, desktop przed restartem
kończy bieżące sprawdzanie/pobieranie, blokuje następne i raportuje faktyczny cel instalacji.
Poświadczenie workera pozostaje osobne; worker nigdy nie wymienia sidecarów.

Overview przekazuje wersję dostępną, procent pobierania, waiting/restarting oraz
failed z przyczyną. Offline, brak parowania, starsza aplikacja bez funkcji lub
wyłączony updater blokują akcję z widocznym powodem. Nowych żądań nie kolejkujemy
dla offline; zaakceptowane wcześniej mają trwałe id i są deduplikowane przy reconnect.
Gateway zapisuje stan i komendę w `desktop_updates` (migracja `0058`) oraz audyt
żądania, force i wyniku: aktor, wersja, id i przyczyna. Lokalny journal jest osobny
dla poświadczenia desktopu; przerwana próba po restarcie kończy się błędem,
a start docelowej wersji po restarting — sukcesem. Nieczytelna historia blokuje
zdalne odtwarzanie, zachowując plik i możliwość uruchomienia aplikacji.

Tryb lokalny nie otwiera tego strumienia; połączone komputery używają osobnego kanału
aplikacji z dołączonym gatewayem ([niżej](#połączone-komputery)).
`canopy.update.v1` nie zmienia się. Integracja gateway ↔ desktop zastępuje updater
na jego granicy; rzeczywisty podpis, instalację i restart trzeba sprawdzić na macOS.

Gateway i worker używają jednej wersji aplikacji z `CANOPY_VERSION` (wstrzykiwanej
podczas kompilacji; bez niej `0.0.0-dev`). `--version` wypisuje tę wersję bez
uruchamiania usług. Wersja aplikacji nie jest numerem protokołu.

## Połączone komputery

Lokalny status nigdy nie czeka na partnera. Jego ostatni snapshot pozostaje widoczny,
a zwykłe odświeżenie w tle ma limit 10 s. Loading/Waiting i „Waiting for {name}.
Local updates are ready.” nie oznaczają awarii łącza. Dopiero utrata liveness daje
Unavailable i „{name} is unavailable. Trying again automatically.”. Check now
sprawdza lokalnie i osobno planuje idempotentne sprawdzenia partnerów (120 s),
bez czekania na nie. Jawna instalacja u partnera ma limit 15 min; nie jest ponawiana
automatycznie. Czasy, limity współbieżności i circuit breaker opisuje
[zsumowany widok](linked-computers.md#zsumowany-widok).

Dotyczy wyłącznie aplikacji desktopowych w trybie lokalnym połączonych jako
[połączone komputery](linked-computers.md). Gatewaye serwerowe (Docker, binarka)
nie mają łącza, więc ta funkcja ich nie dotyczy, a Update all nadal nie działa na gatewayu Docker.

**Kanał aplikacji.** Proces kontrolera desktopu w trybie lokalnym otwiera
`GatewayService.WatchAppControl` do własnego dołączonego gatewaya (loopback, token serwisowy)
i raportuje stan przez `ReportAppControl`. Gateway odrzuca te RPC dla ról innych niż `desktop`
oraz dla każdego tokenu urządzenia (telefon, sparowany desktop). Ten sam `RemoteAppUpdate` co
w trybie zdalnym wykonuje żądanie: własny updater, własny kanał i ustawienia, ściśle nowszy
podpisany SemVer, bariera workera, czekanie na koniec tur, generacji i zadań w tle, potem restart.
Nie ma force ani downgrade'u z zewnątrz; **Restart now…** istnieje tylko lokalnie. Gateway trzyma
ostatni raport w pamięci (restartuje się razem z aplikacją); źródłem prawdy jest lokalny journal
aplikacji, który po restarcie zgłasza `succeeded` albo `failed` dla tego samego id żądania.
`DesktopUpdateState.ready` mówi, że aplikacja pobrała aktualizację i zainstaluje ją przy restarcie.
Pola `updater_phase`, `updater_version`, `updater_progress` i `updater_error` niosą stan własnego
updatera aplikacji (sprawdzanie, pobieranie z postępem, pobrana wersja, błąd) niezależnie od żądania,
więc wiersz połączonego komputera pokazuje to samo co „This Canopy app”. Journal ich nie zapisuje,
a sam postęp aplikacja raportuje najwyżej raz na sekundę (ostatnią wartość zawsze). Gateway w trybie
zdalnym zeruje je przed zapisem do `desktop_updates`. Starsza aplikacja ich nie wysyła: wiersz wygląda
wtedy jak wcześniej (wersja docelowa z `available_version`). `target_version` zakończonego żądania nie
jest już celem wiersza; liczy się tylko wersja nowsza od bieżącej. Centrum aktualizacji odświeża się co
5 s, a co 2 s, gdy któryś połączony komputer pobiera aktualizację.
Nowe pola `DesktopUpdateCommand`: `requested_by` (nazwa komputera w powiadomieniu „MacBook
requested an app update…”) i `check` (samo sprawdzenie feedu, bez instalacji).

**Łącze.** Gateway z kanałem aplikacji ogłasza capability **`remote_app_update`** w `NodeHello`.
`canopy.link.v1.ComputerUpdateService` ma dwie metody przenoszone istniejącym
`remote_request`: `GetComputerUpdates` (snapshot domu: jego aplikacja w `UpdatesSnapshot.app`,
workery i CLI, bez jego partnerów i bez przebiegu Update all) oraz `RequestComputerUpdate`
(`app`, `check`, `worker`). `ManageUpdates` wywołuje je akcjami `computer` i `computer_check`
z `node_id` albo `worker` z kwalifikowanym id workera. Dom obsługuje je tylko na bezpośrednim łączu, gdy obie strony
ogłosiły capability; relay ich nie przenosi (`RELAY_METHODS`). `COMPUTER_LINK_PROTOCOL` zostaje 1.

**Weryfikacja u domu.** Wołający musi być bezpośrednio sparowanym komputerem tego właściciela
(`store.peer`); inaczej `PermissionDenied`. Dom nie ufa wersjom z widoku wołającego: aplikacja
sama sprawdza feed swojego kanału, a wyłączony updater, brak kanału aplikacji albo trwający
Update all na domu odrzucają żądanie z czytelnym powodem. `worker` dotyczy wyłącznie binarnego,
niedołączonego workera domu i przechodzi przez zwykłe, administracyjne `ManageUpdates`. Łączem
nie przechodzą adresy feedów, binaria, sekrety ani zgody na downgrade.

**Audyt.** A zapisuje `computer.update.sent` (węzeł, akcja, worker). B zapisuje
`computer.update.received`, a dla aplikacji także `desktop.update.request` (węzeł wołającego,
id żądania) i jednokrotnie `desktop.update.outcome` (wynik po restarcie).

**Widok na A.** `UpdatesSnapshot.computers` (`ComputerUpdate`) zawiera każdy połączony komputer:
nazwę, wersję aplikacji z ostatniego handshake'u, obecność łącza i powód, gdy nie da się go
aktualizować stąd („Update Laptop on that computer.” dla partnera bez capability albo
pośredniego). Dla bezpośrednich partnerów z capability A dołącza ich snapshot (limit 3 s; partner,
który nie odpowie, jest pokazywany bez niego). Id workerów są kwalifikowane węzłem domu, więc
akcje na workerach i CLI B trasują się jak inne wywołania. CLI partnera aktualizuje istniejące
trasowane `InstallCli` (wymaga wspólnej konfiguracji). Check now na A prosi aplikacje partnerów
o sprawdzenie ich feedów. Podczas restartu B jego obecność to `updating` (ogłoszona przed
zamknięciem), więc UI pokazuje „Restarting”, a nie błąd; po powrocie snapshot ma nową wersję.

**Update all.** Plan dodaje krok `computer` dla każdego połączonego, bezpośredniego partnera
z capability, który jest online, ma aktywny kanał aplikacji i nowszą dostępną wersję. Te kroki
idą **na końcu**, po wszystkich elementach tego komputera, i po jednym. Dołączony gateway A nigdy
nie restartuje się w Update all (aktualizuje go tylko jego własna aplikacja), więc łącze A
przetrwa restart B i A widzi powrót B. Krok zapisuje id żądania u B; kończy się, gdy B wróci
na łącze z wersją co najmniej planowaną albo zgłosi `succeeded` dla tego id. Offline lub
`updating` B to oczekiwanie, nie błąd; `failed` B zatrzymuje przebieg z przyczyną. Limit kroku
to jak dla innych 35 minut, więc długie czekanie na koniec tur u B może skończyć się Retry.
Workery i CLI partnera nie wchodzą do Update all A: aktualizuje się je pojedynczo albo Update all
na tamtym komputerze.

**Jednorazowo.** Oba komputery muszą mieć wersję z tą funkcją, zanim zdalna aktualizacja zadziała;
starszy partner jest pokazywany z wersją i „Update on that computer”, bez akcji.

## Niezależny kanał ratunkowy

`proto/canopy/update/v1/update.proto` definiuje zamrożony
`canopy.update.v1.UpdateService`. Gateway wystawia go na tym samym porcie
HTTP/2 co WorkerLink, pod osobną ścieżką usługi. Zdalne workery korzystają ze wspólnego
listenera Network access i pinu zapisanego przy enrollment. Osobny port nie
zwiększyłby odporności na niezgodne kontrakty, a wymagałby dodatkowych reguł proxy
i firewalla. Worker inicjuje oba niezależne połączenia, również za NAT-em.

| RPC / endpoint | Dostęp i odpowiedź |
|---|---|
| `Check` bez Authorization | Tylko zdrowie gatewaya, jego wersja i zakresy protokołów. Nie ujawnia workerów, poleceń ani assetów. |
| `Check` z credentialem | Dodatkowo werdykt zgodności dla podanego workera. |
| `Watch` | Credential workera w `Authorization: Bearer …`; natychmiastowy werdykt, następnie polecenia i heartbeat. Rozwiązanie release nie blokuje pierwszego werdyktu. |
| `Report` | Uwierzytelniony postęp/wynik przypisany do identyfikatora polecenia. Stary raport nie nadpisze nowego polecenia. |
| `FetchArtifact` | Uwierzytelniony strumień zweryfikowanej binarki workera wyłącznie dla wersji działającego gatewaya i wskazanej platformy. |
| `GET /healthz` | Anonimowe `{healthy, version}`, HTTP 200/503, bez cache. Przy h2c wymaga HTTP/2; listener TLS obsługuje także HTTP/1.1. |

`worker_id` musi odpowiadać credentialowi. Unieważnienie/rotacja credentialu lub
archiwizacja workera zamyka kanał; heartbeat ponownie sprawdza uprawnienia.
Poświadczenia nie trafiają do manifestów, adresów pobierania ani plików usługi.

`WORKER_LINK_PROTOCOL`, `MIN_WORKER_LINK_PROTOCOL` i `UPDATE_PROTOCOL` są w
`packages/domain/src/release/protocol.ts`. Obecnie wszystkie wynoszą 1. Worker
wysyła zakres `[min_worker_link_protocol, worker_link_protocol]` także w
WorkerLink `Hello` (nowe pola 760 i 761). Gateway dopuszcza połączenie, gdy oba
dodatnie zakresy mają wspólny numer. Brak negocjacji (0) jest niezgodny;
WorkerLink zwraca `FailedPrecondition` z zakresem i wskazaniem UpdateService.
Aktualizator działa niezależnie od tego handshake i konfiguracji dostawców.

Reguły utrzymania v1: wyłącznie nowe opcjonalne pola i RPC, bez zmiany znaczeń,
typów ani numerów istniejących pól. Nie usuwać v1 przy kolejnej wersji WorkerLink.
Nie importować do niego wiadomości WorkerLink ani UI. `UPDATE_PROTOCOL` pozostaje
1; zmiana łamiąca WorkerLink zwiększa jego własny numer. Nowe stany postępu są
tekstowe; stary serwer je przyjmuje, stary klient pokazuje bezpieczny stan
zastępczy. Nieznana zgodność nie może otworzyć WorkerLink. Nieznany rodzaj
instalacji jest zarządzany zewnętrznie.

Worker sprzed wprowadzenia UpdateService wymaga **jednej ręcznej aktualizacji**.
Nie ma możliwości zdalnego dodania kanału do procesu, który go jeszcze nie zna.

## Release i mirror

Źródło domyślne: `https://api.github.com/repos/itsoltech/canopy/releases…`.
Kanały: `stable` wybiera najwyższe stabilne semver, `beta` najwyższe ze stable/beta,
`nightly` najwyższe ze wszystkich wydań (z paginacją i porównaniem semver, nie datą publikacji).
`vX` / `vX.Y` wybierają najwyższe stable z prefiksem, `vX.Y.Z` wskazuje dokładny stabilny tag
(mirror może zachować również tagi `X.Y.Z`). Drafty i release bez `manifest.json` są pomijane.
Pipeline publikuje `manifest.json` najpierw z binariami gatewaya/workera, a po buildach desktop
wymienia go na wersję z instalatorami; wpisy binariów pozostają takie same ([release.md](release.md)).
Gateway pobiera manifest swojej konkretnej wersji również dla prerelease; nie zastępuje go
manifestem nowszego nightly. Protokół UpdateService pozostaje bez zmian.

**`latest` oznacza teraz stable**, a stare zapisane `updateChannel: "latest"` gateway przy
starcie zapisuje jako `stable`. Zmienna środowiskowa `latest` i żądania starszych klientów
także są normalizowane do stable. Nie publikujemy już rolling GitHub release/tagu `latest`
ani buildów `X.Y.Z-main.<sha7>`. Settings → Workers → Updates pozwala wybrać trzy kanały
lub wpisać stabilny pin. Nightly z dev, beta z next i stable z main opisuje [release.md](release.md).
Nightly powstaje w cyklu godzinowym, o minucie 17 UTC, tylko dla zmian releasowalnych
(lub po ręcznym dispatchu). Push do `dev` nie publikuje aktualizacji; cron, kolejka i buildy mogą
opóźnić jej dostępność. Wybór kanału, porównanie SemVer, feedy desktopu i wymóg manifestu
pozostają takie same.

Resolver pobiera asset `manifest.json`, schemat 1:

```json
{
  "schema": 1, "version": "2.1.0", "channel": "stable",
  "commit": "abcdef0", "published_at": "2026-11-03T00:00:00Z",
  "protocol": { "worker_link": 1, "update": 1 },
  "assets": [{
    "app": "worker", "os": "linux", "arch": "x64",
    "name": "canopy-worker-linux-x64",
    "url": "https://github.com/itsoltech/canopy/releases/download/v2.1.0/canopy-worker-linux-x64",
    "sha256": "<64 znaki hex>", "size": 123456
  }]
}
```

Nazwy niekompresowanych binarek: `canopy-{gateway|worker}-{os}-{arch}`
(`linux|darwin|windows`, `x64|arm64`, `.exe` na Windows). Pipeline publikuje także
`checksums.txt`; runtime weryfikuje rozmiar i SHA-256 bezpośrednio z manifestu.
Manifest może zawierać także instalatory desktop z własnymi nazwami; aktualizator
gatewaya/workera nie wybiera tych assetów.
Desktop ma osobną politykę: Settings → App updates zapisuje kanał w lokalnym
`userData/app-updates.json` Electrona, bez wywołania gatewaya i bez zmiany kanału
gatewaya ani workera. Jedna aplikacja Canopy ma wspólne dane dla wszystkich kanałów.
Stable dopuszcza stable, Beta stable/beta, Nightly wszystkie trzy; resolver wybiera
najwyższy SemVer. Powrót do stabilniejszego kanału wymaga zgody na pojedynczą próbę
downgrade'u z ryzykiem niezgodnych danych. Nie jest to rollback bazy ani mechanizm
UpdateService opisany poniżej. W lokalnym desktopie nowy instalator zawiera też nowy
runtime gatewaya/workera — ich jawne polityki aktualizacji pozostają niezależne.
Semantyka feedów i migracja starych instalacji: [desktop.md](desktop.md#automatyczne-aktualizacje-desktopu).

Wszystkie adresy upstream i przekierowania muszą używać HTTPS. Jawny wyjątek HTTP
jest dostępny tylko w opcjach testowych, nie przez zmienną środowiskową.

Gateway przechowuje manifest własnej wersji oraz binarki workerów w cache
adresowanym SHA-256. Równoległe żądania współdzielą pobieranie; każde ponowne
użycie pliku sprawdza jego hash. Przed własną aktualizacją zapisuje wybrany
manifest oraz pobiera assety platform znanych workerów binarnych, aby przesunięcie
retencja starszych nightly nie odebrała im aktualizacji. Cache zachowaj między restartami.
Workery preferują `FetchArtifact`, więc nie potrzebują dostępu do internetu.
Przy zimnym cache gateway musi mieć dostęp do release; awaria mirrora kończy
próbę czytelnym błędem i pozostawia bieżącą binarkę.

## Wymiana, restart i rollback

1. Administrator aktualizuje gateway w **Settings → Workers → Updates**.
   Gateway sprawdza kanał co 15 minut; akcje zarządzania wymagają roli `admin`.
   Kanał zapisuje się w istniejącym `user_settings.settings.updateChannel`.
2. Gateway blokuje nowe tury, czeka na zakończenie tur workerów i botów, pobiera
   release i weryfikuje go. Wybrany gateway jest wymieniany przed wysłaniem
   workerom poleceń przejścia na tę wersję.
3. Po restarcie worker otwiera Watch. Gateway zapisuje trwałe polecenie przejścia
   na **swoją uruchomioną wersję**; zastępuje polecenie do poprzedniej wersji.
   Offline worker odbierze je przy następnym połączeniu. Ręczne **Update worker**
   i **Update all** pozwalają ponowić próbę. Nie ponawia automatycznie błędu lub
   rollbacku i nie wykonuje automatycznego downgrade.
4. Worker zamyka przyjmowanie nowej pracy i zgłasza `waiting_idle`; czeka również
   na generacje i zadania w tle. Limit domyślny to 30 minut. Przekroczenie limitu
   odracza aktualizację, odblokowuje pracę i wymaga ponowienia. Tylko jawne `force`
   w administracyjnym `ManageUpdates` może przerwać aktywną pracę. Po błędzie
   worker odtwarza niepotwierdzone polecenia przez ponowne połączenie WorkerLink.
5. Zweryfikowane bajty trafiają do pliku `.next` obok executable (ten sam system
   plików), są synchronizowane, otrzymują prawa wykonania, poprzedni plik zostaje
   jako `.bak`, a atomowy rename podmienia executable. Manifest, rozmiar i SHA
   muszą być poprawne **przed** dopuszczeniem wykonania. Downgrade wymaga jawnego
   `allow_downgrade` administratora. Stan i identyfikator polecenia zapisuje
   prywatny plik `.update.json` obok binarki.

Binarka uruchamia proces nadzorujący i właściwy proces usługi. Kod wyjścia **75**
żąda ponownego uruchomienia executable. Ten sam mechanizm działa na pierwszym
planie i pod systemd/launchd. Stary supervisor pozostaje w pamięci do potwierdzenia
nowej wersji, dzięki czemu potrafi przywrócić `.bak`, nawet gdy nowa binarka w ogóle
się nie uruchamia.
Zwykłe zakończenie nie wywołuje restartu supervisora; politykę awarii ustala
menedżer usług. Drukowane unit/plist mają `Restart=always` / `KeepAlive=true`.
Gateway `service` drukuje unit z `EnvironmentFile=%h/.config/canopy/gateway.env`;
przygotuj ten prywatny plik samodzielnie z istniejącą konfiguracją gatewaya.

Nowy gateway potwierdza start po uruchomieniu DB, listenerów i aktualizatora;
worker po otrzymaniu WorkerLink Welcome. Jeśli proces wcześniej wyjdzie albo
nie potwierdzi startu w **90 sekund**, supervisor przywraca `.bak` i uruchamia
poprzednią wersję. Potwierdzenie trafia też przez lokalne IPC do supervisora;
raportowanie i usunięcie `.update.json` nie mogą zgubić tego sygnału.

Jeżeli wersja potwierdzonego dziecka różni się od wersji supervisora, supervisor
prosi je przez IPC o przekazanie nadzoru. Dziecko używa tej samej blokady aktualizacji
i bariery przyjmowania pracy: worker czeka na tury, generacje i zadania w tle,
gateway na tury workerów i botów. Nie wymusza przerwania pracy. Po opróżnieniu
wykonuje zwykłe zamknięcie zasobów i wychodzi z wewnętrznym kodem **76**.
Dopiero wtedy supervisor wykonuje `process.execve` na potwierdzonej binarce:
zachowuje PID, argumenty i środowisko usługi oraz standardowe strumienie,
a nowy supervisor uruchamia właściwy proces usługi. Zdrowe dziecko uruchamia się
zatem drugi raz; żadne aktywne zadanie nie jest z tego powodu przerywane.
Kod 76 jest obsługiwany wewnętrznie, nie wymaga restartu przez menedżera usług.

Obsługa `process.execve` jest zweryfikowana na przypiętym Bun **1.4.4** przez testy
skompilowanych binariów. Mechanizm działa również na pierwszym planie bez
systemd/launchd. Brak API lub błąd `execve` pozostawia dotychczasowy supervisor
aktywny (po błędzie uruchamia on ponownie potwierdzone dziecko), wyłącza dalsze
próby przekazania w tym procesie i zapisuje komunikat o potrzebie restartu usługi.
Nie uruchamia niepotwierdzonego executable przez `execve`; kolejna aktualizacja
zachowuje własny watchdog i rollback. Sprawdza też, czy plik nie został ponownie
podmieniony od startu potwierdzonego dziecka.

Potwierdzenie startupu jest wysyłane także wtedy, gdy wynik aktualizacji został już
zgłoszony albo binarka na dysku była potwierdzona przed startem dziecka. Starszy
supervisor z tym mechanizmem przechodzi wówczas na wersję dziecka jeden raz;
zgodne wersje nie wywołują kolejnego przekazania. **Supervisor sprzed dodania tego
mechanizmu wymaga jednego ręcznego restartu usługi**, żeby załadować jego obsługę.
Nie da się zmienić kodu procesu, który nie zna protokołu przekazania.

Worker raportuje utrwalony sukces/błąd przed następnym Watch.
Jeśli raport sukcesu zaginie, zgodny handshake WorkerLink na dokładnej wersji
zapisanego polecenia i celu kończy utrwalone `restarting` jako `succeeded`.
Sam reconnect UpdateService nie dowodzi zdrowego startu; inna wersja,
niezgodny protokół i zapisany błąd/rollback nie są w ten sposób kasowane.
Metadane UI i polecenia pozostają w istniejącym JSONB `workers.capabilities`
(`update`, `updateCommand`); migracja schematu nie jest potrzebna.

## Instalacja i konfiguracja

Ten sam mirror zasila nową instalację: uwierzytelniony BFF wywołuje dodany
`GatewayService.FetchWorkerInstall`, a publiczne `/install/worker/<os>/<arch>` przekazuje
strumień binarki. `?sha256=1` zwraca hash z manifestu dokładnej wersji gatewaya. Nie zmienia
to zamrożonego `UpdateService` ani nie wymaga credentialu jeszcze nieutworzonego workera.
Dozwolone platformy instalatora: Linux x64/arm64 i macOS arm64. Brak wydania/mirrora
kończy pobieranie błędem HTTP; kreator i SSH preferują manifest dokładnej wersji gatewaya,
także prerelease `vX.Y.Z-nightly.N` i `vX.Y.Z-beta.N`. Brak publikacji uruchamia wybór
najnowszego wydania kanału zgodnego z WorkerLink i UpdateService oraz z binarką docelowej platformy.
Kreator i output SSH podają wersję zastępczą. SSH przesyła adres HTTPS GitHub i SHA-256
przez uwierzytelnione stdin, bez zdalnego dostępu do lokalnego BFF desktopu.
Skrypt zawsze weryfikuje checksum przed wykonaniem binarki; przekierowania GitHub wymagają HTTPS.

| Ustawienie | Znaczenie |
|---|---|
| `CANOPY_VERSION` | Wspólna wersja, wstrzykiwana przez pipeline. |
| `CANOPY_UPDATE_CHANNEL` | Kanał początkowy, domyślnie `stable`; `beta`, `nightly` lub stabilny pin. Zapisany wybór administratora ma pierwszeństwo. |
| `CANOPY_RELEASE_BASE_URL` | Alternatywny HTTPS endpoint o układzie API GitHub (mirror/testy). |
| `CANOPY_UPDATE_CACHE_DIR` | Katalog cache gatewaya; ma pierwszeństwo przed `$XDG_CACHE_HOME/canopy/releases` i `~/.cache/canopy/releases`. Brak zapisu powoduje jedno ostrzeżenie i przejście na prywatny, nietrwały katalog pod `os.tmpdir()`. Jeśli on też jest niedostępny, UI dostaje konkretny błąd zamiast informacji o braku połączenia. |
| `CANOPY_INSTALL_KIND=docker` | Jawnie oznacza kontener; runtime rozpoznaje też `/.dockerenv` i `/run/.containerenv`, a poza kontenerem standalone Bun albo checkout źródeł. |

Samoczynna wymiana obsługuje binarki **Linux/macOS** z zapisywalnym katalogiem
instalacji i zwykłym executable (bez symlinków). Kontener pokazuje „Pull the new
image tag and recreate this container”; source — aktualizację checkoutu,
`bun install` i restart. Nie podmieniają plików uruchomieniowych.
**Windows wymaga na razie zewnętrznego instalatora/usługi** ze względu na blokadę
uruchomionego `.exe`; worker zgłasza `managed_externally`.

## CLI dostawców

Aktualizacje Canopy nie obejmują CLI dostawców (`claude`, `codex`, `grok`) — nie są dołączane. Ich osobne
instalacje i aktualizacje na kliknięcie, źródła najnowszych wersji i przepisy opisuje [provider-cli.md](provider-cli.md).

## Granice i dalsze prace

- SHA-256 zabezpiecza integralność względem manifestu dostarczonego z zaufanego
  HTTPS/gatewaya. Weryfikacja podpisów manifestu (minisign/cosign) pozostaje do dodania.
- Samoczynna wymiana Windows wymaga osobnego instalatora, który przeżywa zatrzymanie
  procesu i potrafi uruchomić usługę oraz rollback.
- Rollback obejmuje executable, nie migracje bazy. Release wymagający nieodwracalnej
  migracji musi mieć osobny plan wdrożenia; migracje muszą tolerować powrót binarki.
- Testy obejmują lokalny fixture release, realny gRPC i PostgreSQL oraz skompilowane
  binaria: A → B → C z niezmiennym PID supervisora, oczekiwanie na pracę w toku,
  rollback przed potwierdzeniem, start ze starszym supervisorem i brak pętli
  restartów. Rzeczywiste publikacje GHCR/GitHub Releases należą do pipeline.
