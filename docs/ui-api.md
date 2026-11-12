# API dla UI i architektura frontendu

Panel wątku ma własny odczyt `GetThreadPanel(GetThreadRequest)` w zakresie
właściciela. Zwraca `ThreadPanel`: bezpieczne metadane connectorów i grantów
workera oraz harmonogramy domu. `SetThreadConnectorGrant` zmienia pojedynczy
grant workera z kontrolą rewizji i zwraca odświeżony panel. BFF udostępnia je
jako `GET/PUT /api/threads/:id/panel`; mobile używa tych samych RPC bezpośrednio.
Połączone gatewaye negocjują `remote_thread_panel_v1`; cache odpowiedzi po utracie
domu oznaczamy `stale`, a brak ostatniej odpowiedzi także `unavailable`.
Żadne poświadczenia ani endpointy connectorów nie wchodzą do tego DTO.
`ListArchivedThreads` łączy lokalne strony z zatwierdzonymi metadanymi luster,
więc lista i licznik obejmują te same widoczne domy.

Desktop w obu trybach używa dołączonego lokalnego BFF. W remote uwierzytelnia się
owner-scoped poświadczeniem desktopu przez przypięty TLS Network access, bez
tokenu usługi zdalnego webu. `GetClientCapabilities` negocjuje protokół oraz metody;
brakujące funkcje są ukryte lub pokazują stan aktualizacji. SPA negocjuje przy starcie, przy każdej
zmianie połączenia overview (restart, aktualizacja, odwołanie), po powrocie karty ukrytej ponad minutę
i co 5 min jako rezerwa. BFF trybu remote używa udanej negocjacji przez 60 s i negocjuje od razu po
wywołaniu zakończonym Unavailable, Unimplemented lub Unauthenticated; każde RPC pozostaje
uwierzytelnione. Gateway podaje nazwę z tożsamości, bez pełnego snapshotu komputerów. Różnica numerów buildów
przy zgodnym protokole nie jest błędem. [Projekt i migracja](desktop-remote-frontend.md).

## Ikony

Favicon, apple-touch-icon, nazwa manifestu i sufiks tytułów stron odzwierciedlają
kanał wersji działającego gatewaya (`Canopy`, `Canopy (Beta)`, `Canopy (Nightly)`),
nie preferencję aktualizacji. BFF rozpoznaje go przez `GetClientCapabilities`
i podaje w HTML przed startem SPA. Manifest jest dynamiczny, z `no-store`;
grafiki kanałów mają osobne URL. Rezerwy przy niedostępności gatewaya i generator
zasobów: [release.md](release.md#ikony-kanałów).

`@canopy/ui/icons` eksportuje mapę `icons`: stabilna nazwa semantyczna → tablica ścieżek `d`.
Wszystkie 87 nazw `IconName` używa Tabler outline (MIT), z `@iconify-json/tabler` 1.2.43.
Wspólny `iconStyle` definiuje viewBox 24×24 i stroke 2.25 (1.5 px przy rozmiarze 16 px).
Webowy `Icon`, mobilny `Icon` i wzmianki renderują jeden obrys bez wypełnienia.
Geometria w `packages/ui/src/icons.ts` zawiera wyłącznie zweryfikowane dane ścieżek;
komentarze wskazują nazwy źródłowych glifów. Licencja i źródło:
`packages/ui/THIRD_PARTY_NOTICES.md`. Logotypy dostawców i konektorów pozostają osobne.

Webowy `Icon` domyślnie używa `--icon-muted`: zinc-500 w jasnym i zinc-400 w ciemnym schemacie.
Hover, aktywacja, fokus klawiatury i wybrany/rozwinięty stan kontrolki ustawiają
`--icon-emphasis` (odpowiednio zinc-700 / zinc-300), również w nagłówkach i nawigacji.
`tone="inherit"` zachowuje kolor semantycznego statusu lub kontrast głównej akcji;
jawne klasy koloru nadal mają pierwszeństwo. Przełącznik Thread details używa `panel-right`:
`layout-sidebar-right`, czyli obrysu okna z prawym panelem. `view-columns` używa tego
samego glifu w komendach i aplikacji mobilnej; `sidebar` używa `layout-sidebar`.

## Synchronizacja wątku

`GetThreadSyncDiagnostics` ma addytywny tryb `summary_only`: zwraca `computers`
z pełnymi licznikami dla każdego domu oraz osiągalnością z runtime łącza.
Nie pobiera ani nie dekoduje historii wątków. `computer_node_id` ogranicza
stronicowane `entries` do wybranego komputera, a `attention_only` pomija gotowe
wątki. Tytuły pochodzą z `thread_metadata` bieżącej generacji lustra;
brak metadanych pokazuje „Untitled thread”. Wszystkie złączenia filtrują właściciela,
także przy identycznych id domu i wątku u innych właścicieli. Domyślny odczyt
zachowuje dotychczasowe stronicowanie i znaczenie liczników dla starszych klientów.
Wspólne `domain/thread-sync-display.ts` łączy strony z podsumowaniami komputerów
i określa statusy, liczniki oraz teksty dla web/desktop i mobile.

Nagłówek wątku pokazuje synchronizację ikoną `arrow-path` w istniejącym miejscu znaku
projektu; nazwa projektu, tytuł i przyciski nie przesuwają się. Ikona zastępuje znak
po 500 ms nieprzerwanej synchronizacji i przenika z powrotem po przejściu do `live`.
Obrót trwa 2 s według tokenów ruchu; przy ograniczonym ruchu ikona pozostaje nieruchoma.
Etykieta dostępności to „Syncing…”, a region statusu ogłasza ją dopiero po 2 s.
Stan komputera poza siecią ma osobną notę, bez ikony synchronizacji.

Breadcrumb wątku i formularza wątku bocznego oraz nagłówek rozmowy bota nie powtarzają
plakietki połączonego komputera. Komputer wątku pozostaje w szczegółach i kontekście composera;
`BotHome` pokazuje lokalizację w szczegółach i ustawieniach bota, gdzie objaśnia miejsce działania.
Nagłówki zachowują dostępny opis „Read-only. {reason}” podczas niedostępności domu,
bez zmiany szerokości breadcrumbu. Widoczne noty i istniejące blokady akcji pozostają bez zmian.

## Ruch formularzy

Otwarcie `Dialog` / arkusza / `Popover` animuje wyłącznie kontener według tokenów
z `routes/layout.css` i `shared/ui/motion.css`. Pola, wiersze ustawień i kroki kreatorów
pojawiają się bez osobnego wejścia, przesunięcia, rozmycia ani opóźnienia.
Nowe wiersze list mogą przenikać lub spokojnie rozwijać wysokość (`rise`, `expand`,
`t-rise`, `t-unfold`), bez podskoków i ruchu poziomego. Przełącznik zachowuje ruch
suwaka po zmianie wartości; przy `prefers-reduced-motion` zmienia stan od razu.

`shake(error)` wymaga jawnego, prawdziwego błędu walidacji i działa jednorazowo
na kontrolce odrzucającej wartość. Brak błędu (`undefined`, pusty tekst, `false`)
nie uruchamia animacji. Sprzątanie usuwa klasę po zakończeniu lub odpięciu attachmentu.
Przy ograniczonym ruchu pozostają kolor, komunikat i `aria-invalid`, bez potrząśnięcia.
`Alert` i awatar bota nie potrząsają się; błędy usług sygnalizuje ich tekst i semantyka.
Dekoracyjne potwierdzenia nie używają krzywych z przeregulowaniem.

## Canopy mobile

`GetThreadBlob` odczytuje obrazy, wyniki komend/narzędzi/zadań i diffy wskazane przez
itemy drzewa wątku. Rejestr `thread_blobs` powstaje przy ingestii, a odczyt filtruje po
właścicielu i aktywnym wątku. Limit wynosi 8 MiB i jest sprawdzany przed pobraniem
bajtów z bazy. Zdalny identyfikator kieruje odczyt do domu połączonego komputera.
Worker może przesyłać oprócz obrazów `text/plain`, `text/x-diff` i `application/json`;
każdy upload nadal wymaga zgodnego hasha i mieści się w tym samym limicie.

Arkusz sekretów mobile korzysta z istniejących `AnswerThreadSecret` i `RevokeThreadSecret`.
Wartość jest wyłącznie wejściem zapisu; odpowiedzi i snapshoty zawierają metadane.
Kwalifikowane `request_id` kieruje obie metody bezpośrednim łączem do domu wątku,
który sprawdza właściciela. Metody nie należą do allowlisty relay, a lustra nie
replikują sekretów. Gateway pośredniczący nie zapisuje wartości ani payloadu RPC.

### Przyrostowy odczyt wątku

#### Docelowe okna i wznowienie po seq

Poniższy kontrakt jest wdrażany osobnym stosem zmian; dalszy opis kursora rewizji
dotyczy istniejącej ścieżki zgodności. Nowa ścieżka web/desktop/mobile nigdy nie
przesyła pełnej historii w jednej odpowiedzi ani nie używa jej do naprawy błędu.

Pierwsze otwarcie zwraca ograniczone ostatnie okno: domyślnie 24 tury, z limitem
liczby rekordów i zakodowanych bajtów każdej wiadomości. `history_before_turn_id`
i wersja historii służą wyłącznie do stronicowania starszych tur. Nie poszerzają
automatycznie okna reconnect do całej wcześniej otwartej historii. Starsze strony
są pobierane na żądanie, a zmiana historii forka unieważnia ich wersję.

Okno zawiera epokę i trwały seq replikacji wątku, opisany w
[protokole zakresów](linked-computers.md#synchronizacja-zakresami-sekwencji--kontrakt-migracji).
Ten seq obejmuje także metadane; istniejące `last_seq` nadal oznacza seq transkryptu.
Po zastosowaniu partii reducer wspólny dla wszystkich klientów przesuwa seq
atomowo z lokalnym stanem. Reconnect przekazuje ostatni zastosowany seq i epokę;
gateway odtwarza brakujący zakres, a potem kontynuuje live tym samym strumieniem.
Luka wywołuje żądanie brakującego zakresu, nigdy pełnego snapshotu.

Jeżeli klient utracił lokalną bazę albo zmieniła się epoka, pobiera nowe ograniczone
okno. Pozostawia widoczną ostatnią poprawną kopię do czasu otrzymania spójnej bazy.
„Load from scratch” usuwa tylko cache i kursor bieżącego wątku i również pobiera
ograniczone okno. Nie usuwa danych z gatewaya ani nie żąda pełnej historii.

Duże wyniki narzędzi i inne duże itemy mają ograniczony podgląd oraz odnośnik do
treści. Rozwinięcie konkretnego wywołania pobiera ją automatycznie przez owner-scoped
odczyt bloba/itemu. Zwinięte wywołania i grupy nie pokazują akcji pobierania; samo
przewijanie nie uruchamia odczytu. Rozwinięte body zachowuje podgląd i pokazuje mały
stan ładowania lub błąd z „Retry” w skali meta wierszy pracy. Zwinięcie przerywa odczyt,
a pełna treść pozostaje w pamięci sesji klienta, poza reducerem osi czasu. Widoczny
podgląd wiadomości kończy się akcją „Show full message” z rozmiarem treści; zastępuje
podgląd w miejscu. Te same reguły obowiązują web/desktop i mobile.
Skrócony wynik zadania w tle kończy się akcją „Show full output” z rozmiarem gotowej
treści; rozwija ona cały wynik w miejscu. Podczas streamingu rozmiar pozostaje nieznany.
Limit partii wynosi 64 rekordy i 64 KiB protobuf łącznie z kopertą; sam limit tur
nie wystarcza, ponieważ pojedyncza tura może zawierać wielki wynik narzędzia.
Nieznane pola/case nie przerywają watcha. Nierozpoznany item zachowuje stabilne
id i kolejność oraz wyświetla placeholder z możliwością odczytu szczegółów.

Stan wątku rozdziela odczytany cache, catch-up (`applied_seq`, `head_seq`,
`remaining`), live, niedostępny dom i błąd tego watcha. Osiągalny gateway z
nieudanym watchem nie staje się globalnie niedostępny. Niedostępny dom pozostawia
cache i odtwarza watch po powrocie linku. Błąd deterministyczny nie wywołuje
nieskończonego reconnect: klient próbuje nowej ograniczonej bazy, następnie
mniejszego okna, a potem pokazuje przyczynę i akcje ponowienia dla tego wątku.
Diagnostyka zawiera postęp, klasę błędu i rozmiary, bez treści, hostów ani tokenów.

#### Istniejący kursor rewizji

Łącze między komputerami może dodatkowo scalać tekst w oknie 40 ms i sprawdzać rewizje
konkretnego wątku. Klient UI zachowuje ten sam atomowy kursor snapshotu; addytywne
`ThreadEventUpdate.first_seq` opisuje początek scalonego zakresu i może być ignorowane
przez starszy reduktor. BFF zachowuje własne okno koalescencji 200 ms, a po przepełnieniu
kolejki SSE przerywa upstream i pozwala klientowi wznowić od checkpointu. Pełne zasady:
[linked-computers.md](linked-computers.md#ograniczenia-buforów-synchronizacji).

`WatchThreadRequest.incremental` (802) włącza checkpointy UI. Pierwsze otwarcie bez
`cursor` otrzymuje pełny `ThreadSnapshot` z `cursor` (800): `<uuid-epoki>:<rewizja>`
istniejącego dziennika właściciela. Odczyt kursora i historii odbywa się w tej samej
transakcji repeatable-read. Kolejne otwarcie lub reconnect przekazuje ten kursor w
`WatchThreadRequest.cursor` (801). Gateway sprawdza właściciela przed emisją danych,
a następnie wysyła `ThreadUpdate.delta` (801) z bazowym kursorem, nowym checkpointem,
upsertami itemów/tur, tombstone'ami i zastępowanymi metadanymi (w tym interakcjami,
kolejką, steerami i celem). Klienci współdzielą reducer `applyThreadUpdate`.

Zdarzenia na żywo aktualizują kopię, lecz nie przesuwają jej atomowego checkpointu.
Przy ponownym otwarciu projekcje od ostatniego checkpointu są stosowane idempotentnie.
Brak ciągłości, nieznany/za stary/przyszły kursor, inna epoka, zmiana historii forka
lub przeniesiona historia wymuszają pełny snapshot. Zachowane są też konserwatywne
fallbacki dziennika dla tur ze zmiennymi joinami źródłowymi.

Starszy klient nie ustawia `incremental` i otrzymuje dotychczasowe snapshoty.

Nowe web/desktop/mobile ustawiają `WatchThreadRequest.sequence` (811). Pierwszy
odczyt to ograniczone okno: 24 ostatnie tury i do 128 itemów, maksymalnie 512 KiB
publicznych rekordów (384 KiB itemów, po 64 KiB tur i metadanych). Naprawa po
błędzie może zmniejszyć okno do 8 tur i 48 itemów. Starszą historię pobiera się
osobno przez `before_turn_id` oraz `before_item_id` (813); niezależny kursor itemów
pozwala stronicować również jedną ogromną turę i wpisy bez tury. Odpowiedź niesie
`history_items_has_more` i najstarszy identyfikator obu okien. Rozwijanie cytatu
przechodzi przez ograniczone strony, zachowując ciągłe załadowane okno.
Pusta strona jednego okna zachowuje jego ostatnią granicę, dopóki drugie okno
ma starsze dane. Tury dołączone jako kontekst itemów pozostają w cache również
po następnej partii live. Offline odczyt lustra zachowuje te same granice i seq;
router nie stronicuje ponownie już ograniczonej odpowiedzi.

Gateway współdzieli ostatnie okna przez LRU o limicie 8 wpisów w całym procesie
(do 4 MiB publicznych rekordów, dodatkowo obiekty i kopie aktywnych odbiorców).
Unieważnienie albo zamknięcie ostatniego watcha usuwa wpis. Jeden wątek ma najwyżej
jeden współdzielony odczyt okna i 8 odczytów różnych zakresów w toku; zakończone
partie nie są cache'owane. Pozostałe odczyty czekają na zwolnienie slotu. Kolejka
metadanych odbiorcy mieści 128 wpisów i 64 KiB protobuf; jej przepełnienie naprawia
autorytatywne odświeżenie kontrolek. Nie są to limity całego heapu ani RSS:
aktywne subskrypcje mają własne ograniczone wyniki i stan transportu.

`ThreadSnapshot.sync_cursor` (811) identyfikuje wątek, epokę i zatwierdzony seq.
Reconnect przekazuje go jako `WatchThreadRequest.sync_cursor` (812); gateway
wysyła `ThreadUpdate.batch` (811), po najwyżej 64 rekordy / 64 KiB protobuf.
Reducer publikuje treść i seq atomowo. Odczyt strony nie przesuwa kursora live;
po scaleniu klient wznawia checkpoint sprzed odczytu strony, żeby odtworzyć
równoległe zmiany. Nieznana epoka lub przyszły seq daje nowe ograniczone okno.
Duże itemy mają podgląd i `content_ref`; pełna treść jest pobierana wyłącznie na
żądanie przez `GetThreadSyncContent`, w kawałkach do 48 KiB. Uprawnienia i sekrety
nie wchodzą do dziennika lustra: aktualizuje je osobny `ThreadUpdate.controls`.

Awaria samego watcha jest lokalna dla wątku. Cache pozostaje widoczny; błędy
deterministyczne powodują jedną próbę bez kursora, jedną z mniejszym oknem, potem
zatrzymanie z „Retry” / „Load from scratch”. Niedostępny dom emituje
`sync_status.reason=computer_unreachable`; zmiana obecności kończy oczekiwanie,
a klient automatycznie wznawia seq. Awaria watcha przy sprawnym łączu nie zmienia
obecności komputera ani globalnego stanu gatewaya.

Nagłówek rezerwuje stałe miejsce na ikonę i kompaktowy licznik pozostałych rekordów
(np. `1.2K`). Dostępna nazwa zawiera dokładną liczbę, a ikona potwierdzenia z zerem
oznacza „Up to date”. Settings → Diagnostics pokazuje trwałe `applied_seq`, `head_seq`,
`remaining` oraz stan catch-up każdego lustra. `GetThreadSyncDiagnostics` jest
odczytem lokalnego gatewaya ograniczonym do właściciela: domyślnie 50, najwyżej
100 wpisów na stronę, kursor `after` i sumy dla całego właściciela. Widoczna strona
odświeża dane co 5 s; tło nie odpytuje gatewaya. Powody awarii są kodami z listy
dozwolonej, obok kodu RPC i rozmiaru błędnej ramki. Odpowiedź nie czyta transkryptu,
tras, hostów, tokenów ani tekstu wyjątków. Duży licznik nie poszerza nagłówka.

Starszy gateway ignoruje nowe pola; pusty kursor w odpowiedzi wyłącza wznowienie.
UI ze zdalną kopią przekazuje kursor bezpośrednio do domu online. Zimny klient
sekwencyjny pobiera ograniczone okno z domu; offline czyta ograniczone lokalne
lustro. Starszy watch nadal może rozpocząć od lustra, a następnie stanu domu. Szczegóły:
[odczyt połączonych komputerów](linked-computers.md#odczyt-i-dostępność).

Każdy `WatchThread` i `WatchOverview` ma własny kanał subskrypcji, także gdy desktop
i sparowany telefon oglądają ten sam lokalny wątek. Zamknięcie jest idempotentne:
abort i późniejsze sprzątanie generatora usuwają wyłącznie własną subskrypcję,
nigdy zestaw utworzony już przez reconnect. Handler abort jest odpinany przy końcu
generatora. Heartbeat SSE potwierdza transport BFF, nie kompletność transkryptu.

Regresje `tests/integration/thread-multiclient.test.ts` obejmują obie kolejności
abort/sprzątanie, gRPC z koalescencją BFF obok telefonu Connect przez przypięty TLS,
steer, pytanie dziecka do rodzica, anulowanie i wznowienie z dyskowej kopii desktopu.
Po przerwaniu dostarczania live ponowne otwarcie wątku odtwarza zmiany od zapisanego
checkpointu; czyszczenie prywatnej kopii historii nie jest potrzebne.

Web przechowuje ostatnie kopie w pamięci jednej sesji SPA: LRU do 12 wątków i 64 MiB
zakodowanych snapshotów (bieżący otwarty ekran jest liczony osobno). Nie używa IndexedDB
ani localStorage. Powrót do wątku od razu odtwarza nagłówek, composer i oś z tej kopii,
pokazuje ciche „Syncing…” i otwiera SSE z kursorem. BFF przekazuje go do gatewaya;
nie przechowuje kopii użytkowników na serwerze. Reconnect wylicza URL z ostatniego
checkpointu. Cache znika po opuszczeniu dokumentu albo zniszczeniu powłoki aplikacji,
w tym przejściu do wyboru połączenia desktopu. Akcje nadal idą do autorytatywnego
gatewaya, który sprawdza ich aktualny stan. Zimny odczyt pokazuje istniejący skeleton
osi czasu bez komunikatu „Connecting…”.

Mobile utrwala protobuf snapshotu w prywatnym katalogu cache aplikacji, osobno dla
każdego parowania: LRU 16 wątków / 64 MiB, do 16 MiB na wpis, z dodatkowym LRU
6 wątków / 24 MiB w pamięci. Odczytuje bazę przed otwarciem watch, aby kursor zawsze
odpowiadał nakładanej kopii. Unpair i wykrycie revocation usuwają obie warstwy oraz
blokują spóźnione zapisy. Szczegóły trwałości i zakresu danych: [mobile.md](mobile.md#interfejs-zgodny-z-web).

Natywny klient `apps/mobile` korzysta z tego samego `GatewayService` przez Connect
z binarnym protobuf i natywnym streamingiem HTTPS przypiętym do certyfikatu komputera.
Wspólny listener Network access obsługuje telefony i połączone komputery;
przeglądarka nadal komunikuje się wyłącznie z BFF. Telefon nigdy nie otrzymuje
`CANOPY_UI_SERVICE_TOKEN`.

Settings → Devices tworzy 10-minutowy kod/QR, listuje urządzenia i odwołuje
zaproszenia/tokeny przez BFF `/api/mobile-devices` i `/api/mobile-devices/:id`.
RPC administracyjne to `GetMobileDevices`, `CreateMobilePairing`, `RevokeMobilePairing`
i `RevokeMobileDevice`; są dostępne z service tokenem lub odwoływalnym poświadczeniem
sparowanego telefonu albo desktopu. Publiczne
`MobilePairingService.ExchangeMobilePairing` jednorazowo wymienia kod na revocable
token urządzenia, przechowywany jako hash w DB i w SecureStore na telefonie.
`UnpairMobileDevice` odwołuje wyłącznie bieżące urządzenie z context auth.

Token telefonu daje ten sam dostęp właściciela do RPC GatewayService co BFF,
w tym administrację workerami, siecią, urządzeniami i aktualizacjami.
Handler każdej operacji nadal sprawdza właściciela. Lokalny kanał sterowania
aplikacją desktopową pozostaje dostępny tylko jej własnemu service tokenowi.
`WatchOverviewRequest.include_snapshot` (762) żąda początkowego
`OverviewUpdate.mobile_snapshot` (763: overview i wątki), aby odtworzyć stan po
reconnect. `mobile_device` (760) i `mobile_pairing` (761) zawierają tylko metadane,
bez sekretów. `mobile_routes` (764) przekazuje aktualne adresy i ten sam pin.
Revoke kończy otwarte streamy w procesie gatewaya. Starsze parowania wymagają ponownego QR.
[Transport, model uprawnień, development builds i dokładne komendy](mobile.md).

## Konto GitHub

Settings → GitHub na web/desktop i mobile korzysta z ośmiu RPC opisanych w
`proto/canopy/ui/v1/github.proto`: konta, start/status/cancel device flow,
disconnect, jawny wybór istniejącego PAT i stronicowane instalacje/repozytoria.
Web używa POST `/api/github/{accounts,begin,status,cancel,disconnect,pat,installations,repositories}`.
Odpowiedzi mają `Cache-Control: no-store`; sesję próby wiąże cookie HttpOnly BFF,
które nie jest poświadczeniem GitHub. Mobile używa swojego odwoływalnego tokenu urządzenia.

`configured=false` oznacza brak publicznej konfiguracji GitHub App, bez błędu całego widoku.
Kod użytkownika jest kopiowalny, a link otwiera tylko `https://github.com/login/device`.
`device_code`, access/refresh tokeny i zaszyfrowane rekordy nie są DTO. Anulowanie nie zależy
od widoczności UI; restart gatewaya wznawia bezpiecznie niewygasłe próby. Wybrany dom konta
otrzymuje żądania przez bezpośrednie łącze `github_accounts_v1`, bez synchronizacji sekretów.
Inline `ConnectGitHub` zgłasza sukces tylko do odświeżenia odczytu, bez wykonania mutacji.
Disconnect usuwa lokalne poświadczenia; pełne revoke użytkownik wykonuje na GitHub.
Edycja metadanych PR korzysta z `GetPullRequestMetadata`, `UpdatePullRequestDetails`,
`RequestPullRequestReviewers`, `SetPullRequestAssignees` i `SetPullRequestLabels` oraz capability
`github_pr_metadata_v1`. Klient wysyła rewizję i ID, nigdy endpoint ani poświadczenie.
Każda zmiana wymaga Apply; konflikt pokazuje porównanie i odświeżenie, a wynik uncertain
nie jest odtwarzany po utracie połączenia. Odczyt i zapis podlegają owner-scoping domu PR.
Picker reviewerów pokazuje bieżące requesty jako zaznaczone. Apply wysyła tylko różnicę;
Re-request review jest osobną akcją przy wykonanym review.
`RerunPullRequestChecks` przyjmuje run/attempt, enum failed/all/job i opcjonalny job ID;
`CancelPullRequestCheckRun` wymaga potwierdzenia z Prepare. Linked computers negocjują
`github_pr_write_v1` dla CI. BFF udostępnia POST `/api/github/rerun-checks` i `/api/github/cancel-run`.
Receipt accepted potwierdza zlecenie, a watch/polling odczytuje późniejsze queued/in-progress.
Nie ma dispatch/debug/force-cancel ani automatycznego replay po uncertain.
Szczegóły i kontrakty: [GitHub](github.md).

## Connectors

Strona odczytuje `/api/connectors` (lokalne rekordy) oraz `/api/bots` (lista z domów).
Odczyty nie czekają na partnera: zwracają lokalne konta i ostatnią listę botów, a peer
odświeża się w tle. `ListBotsResponse.unavailable_computers` oraz `refreshing_computers`
pozwalają odróżnić utracone łącze od powolnego odczytu bez błędu całej strony.
Odświeżanie jest single-flight, z cooldownem/backoffem po stronie gatewaya.

Arkusz „Thread details” ma stały nagłówek; tytuł wątku i menu zmiany nazwy są
pokazane raz, we wspólnym `ThreadPanel` używanym też na desktopie. Pełny tytuł
jest dostępny w tooltipie (na telefonie po przytrzymaniu) i w dialogu zmiany nazwy.
Pusta lista konektorów zajmuje jeden wiersz „Connectors · None” z linkiem „Manage”.
Panel web/desktop i mobile nie powtarza modelu, uprawnień, statusu ani zużycia tokenów i kosztu.
Model i uprawnienia pozostają w kompozytorze, a status w nagłówku wątku i sidebarze.
Sekcja położenia ma osobne wiersze komputera, pełnej zawijanej ścieżki „Worktree”/„Directory”
(monospace, `~`, wyróżniona nazwa folderu, kopiowanie) oraz gałęzi. „Branch” jest pickerem z wyszukiwaniem
lokalnych i znanych zdalnych gałęzi; nazwa nie jest skracana, baza „from …” zajmuje osobną linię.
Odłączony HEAD ma tekst „Detached at ‹commit›”. Podczas pracy oraz dla starszego/offline workera
wybór jest wyłączony z powodem. Te same zasady obowiązują w mobile.

`GET /api/threads/[threadId]/branches` → `ListThreadBranches`; `POST` z `{ branch, remote }` →
`SwitchThreadBranch`. Mobile wywołuje RPC bez BFF. Gateway sprawdza właściciela i aktywność całego
checkoutu; worker wymaga czystego statusu, bez auto-stash. Połączone wątki wykonują operację na domu,
z negocjacją capabilities. Komunikat trafia do osi czasu, a notatka do następnej tury agenta.
Szczegóły: [worktrees.md](worktrees.md#przełączanie-gałęzi-z-podsumowania).

`connectors.proto` i osiem RPC `GatewayService` obsługują katalog, nazwane konta,
granty, test, disconnect, aplikacje OAuth oraz begin/complete autoryzacji.
Publiczne DTO nie zwracają poświadczeń. BFF `/api/connectors/**` wiąże sesję OAuth
prywatnym cookie w webie, a w desktopie sekretem procesu BFF, i przekazuje callback
do gateway. Wynik callbacku jest jawny
(`account` albo bezpieczny `error`) i kończy się małą stroną wyniku, również po
odmowie/wygaśnięciu. Strona nie wyświetla treści błędów dostawcy. Desktop pozwala
na cross-site wyłącznie dla `GET /api/connectors/oauth/callback` z nawigacją
dokumentu (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, jeżeli obecne);
Host nadal musi odpowiadać `CANOPY_WEB_ORIGIN`. To wspólna ścieżka dla wszystkich
konektorów OAuth, także aplikacji GitHub i własnych MCP. Parowanie urządzeń nie
korzysta z przekierowań do BFF i nie ma wyjątku od kontroli origin.

Settings → Connectors korzysta z istniejących Dialog/Select/Checkbox/Disclosure.
`features/connectors` dzieli konto, access picker, formularz aplikacji OAuth,
formularz połączenia i katalog narzędzi. Wspólne `useConnectorAccounts` ładuje
katalog dla bota/composera/wątku i odrzuca spóźnione odpowiedzi po zmianie widoku.
`ToolCall.connector_account_id/type/name` (520–522) zapewniają logo i etykietę konta
na osi czasu; gateway kanonizuje je z własnego katalogu. [Projekt i ograniczenia](connectors.md).

## Połączone komputery: zdalne wątki

Wiadomości szyny z innego komputera korzystają z tego samego `Turn.sender` i
`Steer.sender` co lokalni agenci. `AgentSender.bot_id`, `bot_shape` i `bot_color`
opisują bota, `computer_name` daje cichy podpis komputera. Snapshot autora działa
także bez wpisu w lokalnym katalogu. UI renderuje `message_text` zamiast koperty
z `input_text`; `platform_note` pozostaje kontekstem modelu. Linki autora używają
kwalifikowanych id jego domu.
Podpis autora zachowuje stałe frazy w jednym wierszu. Przy braku miejsca najpierw
obcina chip tytułu (pełny tytuł w tooltipie), potem nazwę modelu; na telefonie
grupa metadanych może przejść w całości do drugiego wiersza.

Wątki, workery i projekty połączonych komputerów przychodzą tym samym `GatewayService` co własne,
z id kwalifikowanym węzłem domu (`<uuid>~<node16>`) i polem `node_id` (800 dla projektu i wątku,
802 dla workera; 800–801 workera zajmują CLI). Przeglądarka i telefon
odsyłają id bez zmian; trasowanie do domu robi gateway (`apps/gateway/src/api/routed.ts`). `GetOverview`
ma `computers` (800), `OverviewUpdate` zmiany `computer` (800) i `computer_removed` (801). BFF przyjmuje
kwalifikowane id tam, gdzie wcześniej wymagał uuid (`EntityId`: kolejka, fork, przypięcia sidebara).
Szczegóły, lista metod i błędy niedostępności: [linked-computers.md](linked-computers.md),
„Konkretny protokół etapu 2”.

Partner z capability `thread_mirror` pozostaje na liście po utracie łącza. `GetThread`,
`WatchThread`, `ListThreads` i metadane overview korzystają wtedy z trwałego lustra; online
odczyt pozostaje trasowany do domu. UI pokazuje krótki status „read only” z czasem zmiany obecności
we wspólnym pasku nad composerem (z celem i subagentami), bez bannera u góry wątku. Szczegóły
braku kolejkowania i dostępności plików są pod ikoną informacji. Wiersze zachowują zwykły czas aktywności
i stonowaną ikonę komputera; „Last seen” jest przy samym komputerze w ustawieniach.
Composer, zgody i akcje są zablokowane. Żaden zapis nie trafia do lustra ani kolejki na później.
Metadane plików są czytelne offline, zawartość/miniatury są pobierane z domu tylko online
(„Available when Laptop B is connected”). Bez `thread_mirror` pozostaje zachowanie etapu 2,
z informacją o aktualizacji dla odczytu offline. Szczegóły kursora, resync i zakresu projekcji:
[etap 3](linked-computers.md#konkretny-protokół-etapu-3).

Po reconnect `OverviewUpdate.computer_snapshot` (802) zastępuje widoczne wątki, projekty i workery
jednego `node_id`. Pozwala usunąć z otwartego UI wiersze znikające podczas rozłączenia bez
naruszania stanu innych komputerów. Następne pojedyncze aktualizacje działają jak wcześniej.

Mapowanie identyfikatorów dla partnera działa na osobnej kopii wiadomości strumienia. Wiadomości
Huba są współdzielone: lokalny overview i watch wątku muszą zachować lokalne `project_id`,
także podczas pracy w worktree, a partner otrzymuje identyfikator globalny. Rekord wątku nadal
zawiera pełne metadane projektu i worktree; aktualizacja statusu nie jest częściowym rekordem.

`Workspace.git_origin` (216) niesie znormalizowaną tożsamość z workera, zachowaną także w lustrze.
Web wylicza z surowych rekordów wspólne wybory projektów (`@canopy/domain/projects`): zgodny origin
łączy różne komputery, nazwa lokalna wygrywa, pozostałe są aliasami. No project występuje raz.
Picker workera pokazuje jedną płaską listę ze wszystkich komputerów: najpierw dostępne workery,
potem pozostałe, w obu grupach alfabetycznie po nazwie. Nie ma nagłówków komputerów.
Wiersz zawiera kropkę stanu, nazwę i cichy status z systemem; nazwa komputera jest sufiksem
tylko dla powtarzających się nazw workerów. Zamknięty picker pokazuje samą nazwę workera,
a tooltip także komputer i stan. Wyszukiwanie nadal uwzględnia komputer. Niedostępne workery
pozostają na liście, przygaszone i z powodem; pickery uruchomienia blokują ich wybór.
Wybór zachowuje oryginalne id workspace'u i `workspace.project_id`, więc CreateThread nadal
trasuje do jednego domu. Ten sam porządek i prezentację stosują pickery botów, harmonogramów,
dodawania projektu i ustawień. Dotychczasowe ograniczenia domu oraz zakresu konfiguracji
pozostają; domyślny worker i filtry ustawień mogą wskazywać offline worker.
Settings → Workers zachowuje grupowanie komputerów jako widok zarządzania.
Sidebar (filtr, grupy) i paleta poleceń korzystają z tych samych wyborów; ustawienia pozostają lokalne.
Settings → Projects pokazuje sumę projektów wszystkich połączonych komputerów (te same wybory) i przy
każdym cicho komputery z jego workspace'ami. Stronę ustawień otwiera tylko projekt z rekordem na tym
komputerze; projekt wyłącznie partnera nie jest linkiem.
Reguły niejednoznaczności i zgodność: [linked-computers.md](linked-computers.md#tożsamość-projektu-według-git-origin).

`AddProject` (BFF: `POST /api/projects`, body = `AddProjectRequest` w protobuf JSON, limit 61 min)
dodaje katalog workera jako workspace: `directory_path` (istniejący katalog), `init`
(`parent_path` + `name`: nowy katalog i `git init`) albo `clone` (`parent_path`, `name`, `url`).
Odpowiedź: `project`, `workspace` i `attached` (katalog dołączył do projektu o tym samym git origin).
Opcjonalne `project_id` (5) dołącza katalog do jawnie wybranego projektu właściciela; projekt i worker
są sprawdzane przed klonem, a drugi workspace tego projektu na tym samym workerze jest odrzucany.
`CloneProject(AddProjectRequest)` (BFF: `POST /api/projects/clone`, NDJSON, limit 61 min)
wykonuje to samo owner-scoped dodanie projektu/workspace'u i strumieniuje `CloneProjectUpdate`:
`progress` z fazą, opcjonalnym procentem/licznikami/transferem i ostatnimi oczyszczonymi liniami Git,
potem `result` z `AddProjectResponse`. Web/desktop i mobile używają go dla `Worker.clone_progress`;
starszy worker zachowuje `AddProject` i stan nieoznaczony. Przerwanie strumienia anuluje git na workerze,
także przez linked computers; błąd w UI zachowuje log i Retry. Bufor gatewaya mieści 8 snapshotów,
wolny odbiorca kończy wyłącznie swoją operację. Log pozostaje nietrwały.

`GetWorkspaceCloneSource(workspace_id)` (BFF: `GET /api/workspaces/{id}/clone-source`) zwraca edytowalny,
pozbawiony poświadczeń URL origin, odczytany na workerze źródłowym. Brak/niebezpieczny origin daje pusty URL.
Odczyt jest tylko na żądanie, bez przechowywania URL w overview lub lustrze.
Kwalifikowany `worker_id` trasuje wywołanie do domu workera. `Worker.project_sources` (**805**) mówi,
czy worker tworzy katalogi i klony. Reguły, ścieżki i poświadczenia:
[linked-computers.md](linked-computers.md#dodawanie-projektu-na-dowolnym-komputerze).

`ListDirectory` rozwiązuje każdy segment ścieżki na workerze: dokładna nazwa ma pierwszeństwo,
a bez niej dopuszczalne jest jedno dopasowanie bez uwzględniania wielkości liter. Odpowiedź `path`
zawiera rzeczywistą ścieżkę; picker aktualizuje jej pisownię przed dodaniem katalogu. Kilka dopasowań
zwraca błąd z nazwami kandydatów i prośbą o dokładną nazwę. Brak katalogu kończy ładowanie błędem
z instrukcją sprawdzenia ścieżki. Te same zasady obowiązują na połączonym komputerze.

## Połączone komputery: udostępnianie przez pośrednika

Etap 7 dodaje do `LinkedComputer` pola `via_node_id`, `via_name`, `relay_origin`,
`share_onward_node_ids` i `unavailable_reason`. `PUT /api/computers` z akcją `share_onward`
zastępuje wybór innych bezpośrednich partnerów udostępnianych danemu `node_id`.
Wpis pośredni nie ma tras ani pinu, a `relay_origin` jest informacją o dostępie do nas,
bez dostępu w drugą stronę. Id rzeczy nadal wskazuje rzeczywisty dom (`uuid~home16`).
UI pokazuje „via …” i blokadę z powodem niedostępności pośrednika. Administracja wymaga
istniejącego service tokenu; ustawienia i sekrety nie są przesyłane przez relay.
[Protokół, odwołanie i zakres konfiguracji](linked-computers.md#konkretny-protokół-etapu-7).

## Połączone komputery: wspólna konfiguracja

Ustawienia konta synchronizuje capability `config_sync`, bez opt-in per sekcja.
`GetComputers` zwraca `config_group`, `config_notices` oraz obie zgody i stan synchronizacji
przy bezpośrednim partnerze. `CreateComputerPairing` i `LinkComputer` przyjmują `share_config`;
`ManageComputer` z akcją `share_config` zmienia lokalny wybór. Konfiguracja przechodzi dopiero
po zgodzie obu stron. `ManageConfigNotice` (`restore`, `dismiss`), przez
`PUT /api/computers/notices`, wymaga tokenu serwisowego BFF jak zarządzanie komputerami.
Restore tworzy nową wspólną zmianę, Dismiss ukrywa zwykłą notkę wyłącznie lokalnie.
Powód `choice` oznacza nierozstrzygnięte wartości: Restore wybiera wersję partnera, a Dismiss
zapisuje bieżącą jako nową wspólną zmianę (UI: Use the other’s / Keep this computer’s).
Od etapu 2 to samo dotyczy instancji providerów, list modeli i proxy: zwykłe zapisy
(`SaveProviderInstance`, `SetInstanceModels`, `SetInstanceWorkers`, `SaveProxy`, `DeleteProxy`, …) są wspólne,
a ścieżki CLI i ustawienia workerów zostają na komputerze. `ConfigNotice.local_id` to id elementu na tym
komputerze (puste, gdy go już nie ma), a `item_name` jego nazwa. Usunięcie na innym komputerze to jedna
notka z `field` = `deleted`. Wartość sekretu w notce to zawsze „A different key”.
[Protokół i etapy](linked-computers.md#konkretny-protokół-wspólna-konfiguracja).

Od etapu 3 nazwa, rodzaj i archiwizacja projektu, ustawienia projektu bez workspace'u oraz polityka
worktree konta i projektu bez `location` są wspólne. `Project.global_id` (801) identyfikuje projekt
po scaleniu origin; `id` nadal wskazuje lokalny wiersz. Gateway tłumaczy `project_id` przez aliasy
w wywołaniach trasowanych i zbiera workspace'y partnerów w jednym projekcie. Id workspace'ów i workerów
zachowują kwalifikator komputera. Ustawienia worktree z workerem zapisuje jego dom; edycja jest trasowana.
Settings → Projects i strona projektu używają `ConfigNotice` oraz Restore; sekcja „Workspaces” pokazuje
nazwę workera i komputera w zwartych wierszach, kopiowanie ścieżki i menu edycji/usunięcia także dla partnera.
„Add workspace” otwiera wybór workera, istniejącego katalogu, klonu lub kopii
workspace'u; mobile używa arkusza. `GetWorkspaceCopyManifest` zwraca metadane
bez treści, z listą pominiętych zależności i podsumowaniem Git. UI pokazuje repozytorium
jako stałe podsumowanie, a picker wyłącznie dla plików ignorowanych.
`CopyWorkspace.ignored_selection` wybiera tylko te pliki; całe repozytorium jest
dodawane automatycznie. `CopyWorkspace` strumieniuje postęp. BFF udostępnia
`GET /api/workspaces/{id}/copy-manifest` i `POST /api/workspaces/copy` (NDJSON).
Wewnętrzne `WorkspaceCopySource` i `WorkspaceCopyTarget` sprawdzają właściciela
we właściwym domu. Szczegóły: [workspace-copy.md](workspace-copy.md).
`UpdateWorkspace` i `RemoveWorkspace` trasują kwalifikowane id do domu workspace'u.
Opis: „A new thread runs in one of these directories on the project's workers.”.
API i UI 0050 zostały usunięte. Dawne deklaracje protobuf zostają zarezerwowane; `GetSharedConfig`
i `ManageSharedConfig` zwracają Unimplemented, a `PushSharedConfig` nie jest obsługiwane na łączu.

Od etapu 6 workery mają rekordy, które zapisuje wyłącznie ich dom. `ListWorkerRecords`
(`GET /api/workers/records`) zwraca kopie rekordów workerów innych komputerów grupy konfiguracji:
kwalifikowane `worker_id`, nazwę komputera, tagi, nadpisanie częstotliwości CLI, stan instancji
(`key_set` bez wartości), dostęp connectorów, workspace'y i ustawienia worktree, z lokalnymi id
elementów wspólnych. `read_only_reason` jest pusty, gdy edycja dociera do domu; inaczej zawiera powód
z obecności. `OverviewUpdate.worker_records_changed` (822) oznacza nową kopię. `RenameWorker`,
`SetInstanceWorker`, `SetWorkerCliUpdateSettings`, `SetEnvironmentTags`, `Get`/`UpdateWorktreeSettings`,
`SetConnectorAccess`, `RefreshProviders`, `InstallCli`, `CheckCliUpdates` i `StartProviderLogin`
z kwalifikowanym workerem trafiają do domu. `SetInstanceWorkers` i `SetConnectorAccess` z workerami
kilku komputerów gateway rozdziela, a `ListConnectors` pokazuje granty workerów innych komputerów
z ich rekordów. [Rekordy workerów i edycja zdalna](linked-computers.md#rekordy-workerów-i-edycja-zdalna).

Etap 7 uzupełnia te listy w Providers, Agent environment, Worktrees i Connectors, z grupami komputerów
i blokadą zmian dla `read_only_reason`. `GetInstanceWorker` (POST `/api/workers/:id/instance`) zwraca
stan i nadpisania jednej instancji bez sekretów oraz runtime odziedziczony w domu. `proxy_id` wspólnego
proxy przechodzi przez aliasy; id proxy `worker_scoped` nie wraca do wywołującego.
`CreateBot` trafia do komputera wybranego workera. `CreateSchedule` trafia do domu wskazanego wątku
albo konkretnego workspace'u nowego wątku. Edycja i status harmonogramu są trasowane według jego id;
`ListSchedules` zbiera wyniki z osiągalnych domów. Zdalne utworzenia nie wymagają Share configuration
i nie trafiają do kolejki, gdy dom jest niedostępny.

## Workery: kreator i zarządzanie

Kreator instalacji używa dodatkowych, addytywnych RPC `FetchWorkerInstall` (stream bajtów
lub metadane mirrora własnej wersji gatewaya; jawny fallback kanału zwraca URL wydania)
oraz `WorkerSsh` (stream operacji `key`, `rotate`, `probe`, `install`). Oba RPC są
dostępne tylko z tokenem usługi BFF, nie z tokenem urządzenia mobilnego.
`GetWorkerSetup` zawiera również `gateway_version` i `channel`.

Publiczne GET `/install/worker.sh`, `/install/worker/<os>/<arch>` i `?sha256=1`
nie wymagają enrollment tokenu ani credentialu. BFF przekazuje stream bez buforowania
całej binarki; sprawdza błąd mirrora przed nagłówkami HTTP. GET `/api/workers/install`
rozwiązuje metadane platformy dla kreatora. POST `/api/workers/ssh` przekazuje NDJSON
`{event: WorkerSshEvent}` albo `{error: string}`, z wyłączonym cache i buforowaniem proxy.
Origin web ustala BFF z własnego requestu. Klucz prywatny i świeży token enrollment
SSH nigdy nie trafiają do strumienia przeglądarki; stream zawiera klucz publiczny,
fingerprint, zredagowany output i metadane enrollment. Anulowanie requestu zamyka SSH.

`GetWorkerSetup` zwraca publiczny `gateway_url` (`UserSettings.worker_gateway_url`,
pole **700**, domyślnie pierwszy adres Network access), pełny `gateway_fingerprint` oraz metadane ostatnich
enrollmentów właściciela, bez tokenów. `UpdateUserSettings.worker_gateway_url` (optional,
**700**) podlega `expected_version`; pusty string przywraca wybór automatyczny. Adres musi być
originem HTTP(S), z portem gRPC, bez userinfo, ścieżki, query ani fragmentu.

| RPC | BFF | Efekt |
|---|---|---|
| `GetWorkerSetup` | `GET /api/workers/setup` | adres i metadane zaproszeń |
| `CreateWorkerEnrollment`, `RevokeWorkerEnrollment` | `POST /api/workers/manage/enroll`, `revoke-enrollment` | nazwa + ręczne tagi (zapisane przy zaproszeniu, stosowane atomowo przy rejestracji) → token zwracany raz; odwołanie tylko nieużytego zaproszenia właściciela |
| `RenameWorker`, `RotateWorkerCredential` | `POST /api/workers/manage/rename`, `rotate` | zmiana nazwy; rotacja zwraca credential raz i zamyka link |
| `RevokeWorker`, `ArchiveWorker` | `POST /api/workers/manage/revoke`, `archive` | odłączenie i blokada reconnect; archive dodatkowo archiwizuje worker i workspace'y |

Mutacje sprawdzają właściciela w zapytaniach DB. `Worker.revoked_at` ma pole **700**;
revoked worker zostaje na liście z `online = false`. `OverviewUpdate.worker_removed`
(**700**) usuwa archiwalnego workera, a `enrollment` (**701**) dostarcza metadane
zaproszenia (w tym `worker_id` po wymianie); żaden stream nie zawiera sekretu.
Zmiany projektu po archiwizacji workspace'ów również idą przez overview.
Kreator obserwuje istniejący `Worker` stream, wykryte CLI i używa `SetInstanceWorker`
w ostatnim kroku. BFF ustawia `Cache-Control: no-store` na odpowiedziach zarządzania.
Pełne zasady tokenu, usług i zachowania historii: [worker-config.md](worker-config.md#dodanie-maszyny-z-ui).

### CLI dostawców

`Worker.cli_tools` (**800**) i `Worker.arch` (**801**) pokazują CLI workera z najnowszą wersją, akcją i powodem
blokady. `InstallCli` (jeden worker albo `all_workers` dla dostawcy) i `CheckCliUpdates` są właścicielskie i
egzekwowane w gatewayu; BFF: `POST /api/workers/cli/install`, `POST /api/workers/cli/check`. UI: sekcja „Agent CLIs”
w rozwiniętym workerze, „Agent CLI updates” z „Update all” i kropka przy Settings → Workers. Zasady:
[provider-cli.md](provider-cli.md).

## No project i katalogi scratch

`GetOverview.projects` zawiera projekt systemowy właściciela o `Project.kind = "scratch"`
(nowe pole **410**); zwykłe projekty mają `kind = "project"`. Jest pierwszy w odpowiedzi.
Klient ukrywa go w zarządzaniu projektami, ale pokazuje w pickerze nowego wątku, filtrze
sidebaru, domyślnym wyborze workspace'u i harmonogramach. Workspace'y scratch są provisionowane
automatycznie na dostępnych dla właściciela workerach zgłaszających `Hello.scratch_root`. Baza to
`<data_dir>/scratch/<user-id>`. Zmiany workerów publikują
również aktualny projekt scratch przez `WatchOverview.project`.

`CreateThread` zachowuje istniejący kontrakt: `project_id` i `workspace_id` wskazują systemowe
zasoby wybrane z overview. Dla nowego głównego wątku scratch `cwd` musi być pusty: gateway nadaje
`<workspace.root_path>/<thread.id>`. Wymuszenie własnego cwd daje `InvalidArgument`.
Fork i wątek boczny dziedziczą katalog źródła. Komenda workera ma `ThreadSpec.scratch = true`
(pole **410**): worker tworzy katalog przed uruchomieniem harnessu, sprawdza jego składniki i odrzuca symlinki.
Błąd utworzenia/walidacji to `SCRATCH_NOT_ALLOWED`; zwykłe wątki nie tworzą brakujących katalogów.

`Thread.cwd` pokazuje pełną ścieżkę. `ListThreads`, wyszukiwanie, wzmianki, archiwum i szyna
zachowują dotychczasowe reguły właściciela oraz drzewa. `sidebar.project_ids` może wskazywać
systemowy projekt, a `ThreadDefaults.workspace_id` — jego workspace. `NewThreadSchedule`
używa jego `project_id` i wybranego `workspace_id` z `placement = "specific"`; każdy run ma nowy cwd.
Botowy `list_projects` zwraca także `kind = "scratch"`; `start_thread` z identyfikatorem
projektu systemowego i workspace'em wybranego workera korzysta z tego samego nadawania cwd.
`CreateWorkspace`, `UpdateWorkspace`, `RemoveWorkspace`
i `UpdateProjectSettings` nie pozwalają ręcznie modyfikować zasobów systemowych.

Scratch powstaje dopiero przy `CreateThread`. `SearchFiles` w scope nowego wątku scratch
zwraca pustą listę; `ListMentionCatalog` pobiera komendy i umiejętności z katalogu domowego workera.
Scope istniejącego wątku używa jego cwd. Pliki są zachowywane bez automatycznego cleanupu,
także po archiwizacji lub soft delete; panel szczegółów opisuje ręczne sprzątanie.

## Bots

Boty bezpośrednich partnerów mają kwalifikowane id i `Bot.node_id` (800). `ListBots` sumuje
domy, pozostałe dozwolone akcje trasują do domu; `WatchBotConversation` zachowuje strumień
kart i odpowiedzi. `GetBotProviderInstances(GetBotRequest)` / `GET /api/bots/:botId/providers`
dostarcza bezsekretowy katalog providerów domu do edytora i zmiany modelu. Online `ReadBotExchange`
pobiera rozmowę między botami z domu odbiorcy, offline z pełnego lustra. `remote_bots` obejmuje
trwałe lustra rozmów z kartami i metadanymi rutyn/przypomnień. Po utracie łącza lista i odczyt
zostają, UI pokazuje maszynę i przyczynę, blokuje composer, karty, edycję i akcje. Connectory
autoryzuje się w domu bota; lokalne konta nie są jego katalogiem. Szczegóły capability,
allowlisty i błędów: [etap 5](linked-computers.md#konkretny-protokół-etapu-5).

Rutyny bota są częścią `BotConversation.routines` (pole 560), jednorazowe pobudki
`reminders` (561). Ten sam strumień SSE aktualizuje panel bez wpisów technicznych
w rozmowie. `SetBotRoutineEnabled` / `DeleteBotRoutine` i `CancelBotReminder` sprawdzają
właściciela i bota. BFF: `PUT|DELETE /api/bots/:botId/routines/:routineId` oraz
`DELETE /api/bots/:botId/reminders/:reminderId`. Tworzenie/edycja instrukcji i crona
odbywa się wyłącznie przez narzędzia bota. `Bot.owner_user_id` (560) pozwala zapisać
lokalną preferencję panelu osobno dla właściciela. `BotApproval.routine_title` (560)
opisuje pochodzenie widocznej karty. Szczegóły ukrytych tur: [bots.md](bots.md).

`Bot.unread_count` (561) i `last_read_seq` (562) obejmują widoczne wiadomości bota
do użytkownika, w tym jawne `message_user`; ukryte wykonania nie zwiększają licznika.
`MarkBotRead` / `POST /api/bots/:botId/read` potwierdza `through_seq` monotonicznie,
z kontrolą właściciela i ograniczeniem do istniejących wiadomości. UI potwierdza
snapshot tylko w widocznej karcie. Odpowiedź zachowuje podgląd ostatniej wiadomości.

`RenameProject` zmienia nazwę zwykłego projektu właściciela. `ArchiveProject` atomowo
archiwizuje projekt, workspace'y i wątki przez istniejący lifecycle oraz anuluje
harmonogramy projektu, zachowując historię i pliki workerów. Scratch jest wykluczony.
`OverviewUpdate.project` z `Project.archived_at` (pole **480**) usuwa projekt z indeksu.
Obie operacje są dostępne również botom z tą samą walidacją; archiwizacja wymaga zgody.

Sekcja Bots korzysta z tego samego `GatewayService` i uwierzytelnienia BFF. Osobny
kontrakt `bots.proto` opisuje CRUD botów, rozmowy i ich stream, zgody oraz zdalne MCP.
`ListBotApprovalRules` i `DeleteBotApprovalRule` są owner-scoped i trasowane do domowego
gatewaya bota. BFF: `GET /api/bots/:botId/rules` oraz
`DELETE /api/bots/:botId/rules/:ruleId`. Reguły powstają wyłącznie z utrwalonej opcji karty:
`AnswerBotApproval.rule_option_id` (1001) zapisuje dokładnie wybrany zakres i zatwierdza
bieżącą akcję w jednej transakcji. `BotApproval.rule_options`, `allowed_by_rule`, `thread_id`
i `request_id` (1001–1004) przenoszą opcje, kopię użytej reguły lub widok oryginalnej zgody
narzędzia w wątku. Odpowiedź na taki widok jest kierowana do tego samego żądania lokalnie
lub przez istniejącą trasę połączonego komputera; nie tworzy drugiej decyzji.
`BotConfiguration.thread_permission` (1001) wybiera domyślne uprawnienia nowych wątków bota.
Pole jest opcjonalne: brak przy aktualizacji zachowuje zapisany wybór, przy tworzeniu
oznacza `user_default` (**Inherit default**), czyli domyślny tryb właściciela z Settings → Threads.
Stałe nadpisania: `ask`, `read_only`, `accept_edits`, `full_auto`, `full_access`.
Migracja zamienia brak wyboru i `same_bot` na `user_default`, zachowując jawne wybory.
`ThreadDefaults.subagent_permission_mode` (7) jest ustawieniem użytkownika w DB:
`UNSPECIFIED` = **Same as parent**, pozostałe wartości ograniczają tryb nowych subagentów
do wyboru właściciela i sufitu rodzica. Ustawienia projektu nie przyjmują tego pola.
`Thread.permission_mode_note` (1040) opisuje ograniczenie przy tworzeniu; panel szczegółów
web i mobile pokazuje je obok zapisanego trybu. Jawna późniejsza zmiana trybu czyści tę notatkę.
`ListThreadApprovals` pobiera tylko oczekujące zgody narzędzi aktywnych tur właściciela,
bez snapshotów wątków. `thread_id` jest kotwicą trasowania; `other_thread_ids` uzupełnia
partię do 512 wątków tego samego domu. Zdalne karty używają kwalifikowanego id oryginalnego
żądania, więc odpowiedź nie wyszukuje karty na innych komputerach. Szczegóły i zestaw
chronionych akcji: [bots.md](bots.md).
`SidebarSettings.pinned_bot_ids` ma numer 350. Pełny zakres: [bots.md](bots.md).

## Git worktrees

`GetWorktreeSettings` / `UpdateWorktreeSettings` (zakres: projekt lub wszystkie × komputer lub wszystkie, nadpisania z wersją; konflikt = 409 w BFF) oraz `ListGitRefs(workspace_id)` dla kompozytora (refy, poprzednie worktree, efektywne ustawienia; `supported = false` dla starszego workera). `CreateThreadRequest.workspace_mode`, `base_ref`, `worktree_id`; `Thread.worktree`. BFF: `/api/worktrees/settings` (POST odczyt, PUT zapis), `/api/worktrees/refs`. UI: Settings → Worktrees, pickery workspace i refu pod kompozytorem nowego wątku, gałąź w nagłówku, panelu i karcie wątku. Szczegóły: [worktrees.md](worktrees.md).

`ListWorktrees` zwraca bieżące rekordy w zakresie projektu/komputera albo pojedynczy rekord po id
(również usunięty), status i przyczynę niedostępności. `CleanupWorktrees` przyjmuje `dry_run`,
zwraca listę „would remove / kept” albo wyniki usunięć. `RemoveWorktree` wymaga id i oczekiwanego HEAD;
`confirm_local_changes` oznacza jawne potwierdzenie utraty lokalnych plików. `RevealWorktree` otwiera
folder na workerze. BFF: `/api/worktrees` (POST lista, DELETE usunięcie),
`/api/worktrees/cleanup` i `/api/worktrees/reveal` (POST). Wszystkie operacje są owner-scoped,
zdalne przez linked computers wymagają capability `remote_worktrees`. `Thread.worktree.removed_at` zachowuje historię
i wyłącza akcje usuniętego katalogu. Pola Cleanup dziedziczą zakresy ustawień Creation/Branches.

`ThreadWorktree.external`, `locked`, `prunable`, `missing`, `unavailable_reason` opisują pochodzenie
i dostępność. Lista łączy git z rejestrem; wybór odkrytego id rejestruje wpis jako zewnętrzny
dopiero przy tworzeniu wątku. Wpisy zewnętrzne są tylko do odczytu w ustawieniach.
Discovery, weryfikacja wyboru i zgodność starszych workerów: [worktrees.md](worktrees.md#worktree-utworzone-poza-canopy).

## Pasek boczny i cykl życia wątku

Przełączanie Threads ↔ Bots nie zmienia położenia treści po jej pierwszym renderze.
Ekrany startowe i nowy wątek boczny używają `CenteredContent`: automatyczne marginesy centrują treść,
a w krótkim oknie nadmiar rośnie w dół i przewija się bez obcinania nagłówka.
Autofocus edytora nie przewija kontenerów. Statusy ładowania, braku providerów i błędu
na ekranie Bots zajmują wspólną zarezerwowaną komórkę. `ModelControls` ma stałe
sloty modelu i wysiłku; model może się skracać na wąskim ekranie. Nazwy korzystają
synchronicznie z katalogu w pamięci powłoki, a aktualizacja katalogu nie przesuwa
sąsiednich kontrolek, również w composerze istniejącego wątku. `ComposerBox` rezerwuje
od pierwszego renderu rozmiar przycisku Send właściwy dla breakpointu; pomiar
niestandardowych przycisków nie zmienia odstępu po zamontowaniu zwykłego Send.
Nowy wątek na workerze z obsługą worktrees rezerwuje także wiersz workspace/ref
przed odczytem Git, aby późne dane nie zmieniały wysokości wycentrowanej treści.

`UserSettings.sidebar` przechowuje filtr projektów (`project_ids`, puste = wszystkie), przypięcia
(`pinned_thread_ids`) i rozwinięcie sekcji Archived (`archived_expanded`, pole 310). Dawne `archived`
pozostaje w kontrakcie jako przestarzałe i nie steruje listą. `UpdateUserSettings.sidebar` zastępuje sekcję
z kontrolą `expected_version`; `WatchOverview.user_settings` dostarcza zmiany innym urządzeniom.
Wyszukiwanie i przypięcia respektują filtr. Przypięte wątki boczne użytkownika są samodzielnie dostępne w „Pinned”.
Subagenci (`Thread.spawned_by_agent`, mapowane z `threads.origin = agent`) nie mają wierszy w sidebarze,
także w „Working”, „Pinned” i archiwum. Nadal należą do indeksu: pytanie lub zgoda skierowana do
człowieka wyróżnia rodzica, pokazuje „Subagent needs input” i wyłącza drzewo z „Working”.
Pytania pozostają w istniejącym panelu nad kompozytorem; wyszukiwanie wątków i bezpośrednie linki
nadal prowadzą do subagentów. Wątki boczne utworzone przez użytkownika zachowują dotychczasowe zachowanie.

Lineage w panelu szczegółów pozostawia wątki boczne użytkownika widoczne. Subagenci mają jeden
domyślnie zwinięty nagłówek „Subagents” z licznikami pracujących, oczekujących na odpowiedź
i zakończonych. Rozwinięcie zapamiętuje profil urządzenia (`canopy:preferences:subagentsExpanded`).
Settings → Threads → Thread details zawiera „Keep finished subagents in the list” (urządzenie,
domyślnie Off, reset pojedynczej preferencji). Off przenosi zakończone wiersze do osobnego nagłówka
„N finished”, domyślnie zwiniętego. Rozwinięcie zapamiętuje urządzenie
(`canopy:preferences:finishedSubagentsExpanded`). Grupa pozostaje dostępna także bez aktywnych
subagentów; wiersze pokazują dostawcę, tytuł, wynik ostatniej tury i względny czas aktywności.
Kliknięcie otwiera pełną historię i kompozytor subagenta. Zakończenie tury nie blokuje wiadomości
właściciela; archiwizacja wymaga najpierw „Unarchive”, jak w innych wątkach.
On pokazuje aktywnych oraz zakończonych w ciągu ostatnich 10 minut według `last_activity_at`
(fallback `created_at`, bez odmładzania przez archiwizację). Starsze zakończone trafiają do jednego
zwijanego wiersza „Previous subagents · N” z liczbą nieudanych; rozwinięta lista przewija się w miejscu.
Pracujący i oczekujący nie wygasają po 10 minutach. Usunięte wątki nie wchodzą do list ani liczników.

`ListThreads.sidebar_only` (310) zwraca aktywne wątki oraz archiwalnych bocznych pod aktywnym rodzicem
do „Previous agents”. Wyklucza boczne pod zarchiwizowanym rodzicem, także w danych sprzed kaskady.
BFF `GET /api/threads` używa tego indeksu. `include_archived` (270) zachowuje znaczenie dla starszych
klientów; nie jest używane do pobierania całego archiwum przez sidebar.

`ListArchivedThreads` przyjmuje `project_ids` (puste = wszystkie), `query` (fragment tytułu głównego,
bocznego albo nazwy projektu, bez rozróżniania wielkości liter), `page_size` (domyślnie 20, maks. 100),
`page_token` i `count_only`. Zwraca `threads`, `side_threads` tylko rodziców na tej stronie,
`next_page_token` i `total_count` głównych wierszy. Boczne nie są osobnymi pozycjami ani nie zwiększają
licznika. Porządek: `archived_at DESC, id DESC`. Kursor zachowuje mikrosekundy PostgreSQL i jest
związany z właścicielem i filtrami; zmiana filtra wymaga pierwszej strony. `%` i `_` są zwykłym tekstem.
BFF `GET /api/threads/archived?q=…&projectId=…&pageToken=…&countOnly=true` ustala strony po 20.
Zwinięta sekcja pobiera wyłącznie licznik, a bieżący wątek przez istniejące `GetThread`.
Zmiana live lub reconnect odświeża licznik i już załadowane strony z nowymi kursorami.

| Metoda | Działanie |
|---|---|
| `SetThreadArchived` | `{thread_id, archived}`: główny wątek archiwizuje też aktywne boczne w tej samej transakcji (`archived_by=cascade`, `archived_by_thread_id=rodzic`). Przywraca tylko te boczne; wcześniejsze `user` / `agent` pozostają archiwalne. Boczne można niezależnie archiwizować; przywrócenie wymaga aktywnego rodzica. Każdy objęty wątek przerywa turę, anuluje kolejkę i harmonogramy oraz otrzymuje aktualizację live. Przywrócenie nie wznawia pracy. `Thread.archived_at`, `archived_by`, `archived_by_thread_id`, `archived_by_thread_title` opisują czas i autora. `close_thread` zapisuje wątek zamykającego agenta. |
| `SetThreadRead` | `{thread_id, unread}`: jawny stan `Thread.marked_unread`; znacznik zdarzeń z migracji 0019 pozostaje monotoniczny. `MarkThreadSeen` usuwa też jawne nieprzeczytanie. |
| `DeleteThread` | `{thread_id}` → `thread_ids`: soft delete wątku i nieusuniętych wcześniej dzieci. Trwały outbox zapisuje przerwania przed ukryciem; kolejka i harmonogramy są anulowane, interakcje wygaszane. `deleted_at` ukrywa wątki w API, listach, wyszukiwaniu, wzmiankach i szynie. Zmiana live z `Thread.deleted_at` usuwa wpis z indeksu klienta. |
| `RestoreThread` | `{thread_id}` → przywrócone `threads`: cofa tylko tę partię usunięcia i zachowuje wcześniejsze archiwum. Dzieci usunięte wcześniej pozostają usunięte. Najpierw trzeba przywrócić rodzica. Anulowana praca nie wraca do kolejki. |

Pola cyklu życia zajmują numery 270–289, a nowe pola indeksu i ustawień archiwum 310–329.
Migracja `0026_sidebar_threads` dodaje metadane cyklu życia i znacznik nieprzeczytania;
`0028_archive_cascade` rozszerza autora o `cascade` i dodaje indeks archiwum. Filtr, przypięcia
i rozwinięcie sekcji korzystają z JSON ustawień, bez osobnej tabeli.
BFF: `POST /api/threads/:id/lifecycle`, `action`: `archive`, `unarchive`, `delete`, `restore`, `read`,
`unread`. UI potwierdza usunięcie i oferuje toast „Undo” przez sześć sekund.

`UpdateThread.title` umożliwia rename (`title_source=user`), a `RegenerateTitle` zleca asynchroniczną generację. Globalne ustawienia `textGeneration`, źródła tytułu i aktualizacje live opisuje [thread-titles.md](thread-titles.md).

Status: **zaimplementowane**:
- kontrakt: `proto/canopy/ui/v1/gateway.proto`,
- rdzeń: `apps/gateway/src/core`,
- dane: `apps/gateway/src/store`,
- serwis: `apps/gateway/src/api`,
- frontend: `apps/web` (SvelteKit 3, Svelte 5, Tailwind 4, `adapter-node`).

## 1. Architektura

```mermaid
flowchart LR
    B["Przeglądarka"]
    K["SvelteKit / adapter-node<br/>powłoka SPA, assety, akcje, JSON, SSE"]
    G["Gateway<br/>stan globalny (PostgreSQL)"]
    W["Workery"]
    B -- "HTTP/1.1: strony, akcje, JSON" --> K
    K -- "SSE: zmiany na żywo" --> B
    K -- "gRPC (HTTP/2): GatewayService<br/>token usługi" --> G
    W -- "gRPC (HTTP/2): WorkerLinkService" --> G
```

- **Gateway jest jedynym stanem globalnym.** Przechowuje projekty, wątki, tury, transkrypty, interakcje i komendy. Orkiestruje workery.
- **SvelteKit jest BFF.** Przeglądarka rozmawia tylko z nim, po HTTP/1.1. Serwer SvelteKit woła gateway po gRPC z prywatnym tokenem usługi, a zmiany na żywo przekazuje przeglądarce przez **SSE**. Prywatny adres BFF i token usługi zostają na serwerze. UI pokazuje publiczny adres gRPC dla workerów, token enrollment i nowy credential rotacji (sekrety jednorazowo), bez klienta gRPC.
- **Frontend jest SPA (`ssr = false` w głównym `+layout.ts`).** adapter-node podaje powłokę i pliki statyczne, przekazuje `/api/*` do gateway i obsługuje istniejące akcje formularzy. Dane tras pobierają klientowe `+page.ts` przez `/api/*`; overview, ustawienia i katalog modeli pobierają stany funkcji. Akcje tworzenia wątku i workspace pozostają po stronie BFF: `enhance` zachowuje walidację, błędy pól i przekierowania bez SSR. Projekt dodaje dialog Add project przez `POST /api/projects`.
- Gateway podaje `GatewayService` na tym samym serwerze HTTP/2 co `WorkerLinkService`, a opcjonalnie także na mobilnym HTTP/1.1 listenerze. Interceptor (`serviceTokenAuth`) przyjmuje token usługi BFF (`CANOPY_UI_SERVICE_TOKEN`, porównanie odporne na pomiar czasu) lub aktywny token urządzenia, mapowany na obecnego pojedynczego właściciela. Administracja parowaniem wymaga tokenu usługi. Workery uwierzytelniają się osobno, w handlerze `WorkerLinkService`.
- BFF zapisuje błędy unary RPC o statusie HTTP 5xx jako `gateway call failed`: nazwa metody (`method`), czas wywołania (`durationMs`), status i oczyszczony komunikat. Log nie zawiera payloadu, metadanych uwierzytelnienia ani przyczyny transportowej.

## 2. `GatewayService`

| Metoda | Co robi |
|---|---|
| `GetOverview` | workery (online, OS, wykryte CLI, profile, wersja konfiguracji i raport) oraz projekty z workspace'ami; historyczne `allowed_roots` jest puste |
| `WatchOverview` | strumień zmian workerów, projektów i wątków |
| `ListDirectory` | przeglądanie dowolnego dostępnego katalogu absolutnego na workerze; pusty `path` otwiera home; odpowiedź zawiera `entries` i rzeczywisty `path` |
| `CreateProject`, `CreateWorkspace` | projekt; workspace = katalog na workerze |
| `AddProject` | katalog na workerze (istniejący, nowy z `git init` albo klon) jako workspace: dołącza do jedynego projektu z tym samym git origin albo tworzy projekt o nazwie katalogu; trasowane do domu workera ([linked-computers.md](linked-computers.md#dodawanie-projektu-na-dowolnym-komputerze)) |
| `UpdateWorkspace`, `RemoveWorkspace` | projekt żyje na workerach, na których ma workspace. `UpdateWorkspace` zmienia katalog na tym samym workerze (`optional root_path`, `label`; jak `CreateWorkspace`: dowolna ścieżka bezwzględna, istniejący katalog potwierdzony przez połączonego workera, bez duplikatu w projekcie na tym workerze). Istniejące wątki zachowują cwd. `RemoveWorkspace` archiwizuje workspace: znika z `Project.workspaces` i nowych wątków głównych; istniejące wątki, ich boczne i forki działają dalej. Obie zmiany idą w `OverviewUpdate.project`; nieznany albo usunięty workspace = `NotFound` |
| `ListThreads`, `GetThread`, `CreateThread` | wątki projektu (pusty projekt = wszystkie wątki użytkownika); jeden wątek; nowy wątek (główny albo boczny, opcjonalnie fork) z opcjonalną pierwszą wiadomością. Gateway sprawdza według ostatniego raportu workera, że dostawca jest dostępny, a profil istnieje, jest dostępny i obsługuje tego dostawcę; fork zachowuje dostawcę rodzica. Fork od tury („Fork from here”, [threads.md](threads.md#fork-od-tury-fork-from-here)): `fork_at_turn_id` (zakończona tura z widocznej historii wątku `fork_thread_id`, także odziedziczona) bez `parent_thread_id` tworzy nowy wątek główny z miejscem i ustawieniami tamtego wątku (pola miejsca, dostawcy i modelu z żądania są pomijane; pusty tytuł = „Fork of ‹tytuł›”); tura w toku, spoza historii albo bez punktu u dostawcy = `InvalidArgument`. `Thread.fork_after_turn_id` i `fork_after_turn_ordinal` mówią, od której tury (numer w wątku źródłowym). `model` i `effort` to domyślne wątku (`Thread.model`, `Thread.effort`), sprawdzane z katalogiem profilu, gdy worker go zgłosił i jest kompletny (model po `id` albo `resolved_model`; wysiłek z `efforts` modelu, a bez modelu z modelu `is_default`). Model z katalogu bez `efforts` nie ma wysiłku: `Thread.effort` zostaje pusty ([reguła wysiłku](protocol.md#modele-effort-i-steer)) |
| `SendMessage` | wiadomość; idempotentne po `client_request_id` (także między kolejką a steerem). `model` i `effort` nadpisują domyślne wątku tylko dla tej tury. Z katalogiem sprawdzany jest model i wysiłek podany w wiadomości; domyślny wysiłek wątku nie blokuje wyboru modelu: przy starcie tury model bez `efforts` nie dostaje wysiłku, a wysiłek, którego model nie oferuje, zamienia się na `default_effort` modelu albo pusty (`Turn.effort` = to, z czym tura ruszyła; [reguła wysiłku](protocol.md#modele-effort-i-steer)). `delivery`: `QUEUE` (domyślnie, następna tura → `response.turn`) albo `STEER` (do tury w toku → `response.steer`; bez tury w toku działa jak `QUEUE`). Steer ma statusy `pending` → `accepted` → `delivered` albo `queued` (nie wszedł: tura skończyła się wcześniej albo dostawca odmówił; jest następną turą `queued_turn_id`, powód w `reason`); model i wysiłek z wiadomości obowiązują dopiero w tej turze. `permission_mode` nadpisuje tryb uprawnień wątku tylko dla tej tury (`UNSPECIFIED` = domyślny wątku); steer zostaje przy trybie tury, do której wchodzi, a nadpisanie obowiązuje, gdy wraca do kolejki ([tryb uprawnień tury](protocol.md#modele-effort-i-steer)); nieznana wartość = błąd. W transkrypcie steer to item `user_message` z `client_id = steer.id` w turze, do której wszedł, w miejscu, w którym wszedł. Zmiany na żywo: `ThreadUpdate.steer`, snapshot ma `steers` |
| `UpdateThread` | domyślny model, wysiłek i tryb uprawnień wątku (`permission_mode`: nieustawiony albo `UNSPECIFIED` = bez zmian; zmienia go tylko właściciel, agenci nie mają do tego narzędzia; `FULL_ACCESS` tylko na workerze z capability `full_access`, inaczej czytelna odmowa, [protocol.md](protocol.md#modele-effort-i-steer)) (`optional`: nieustawione = bez zmian, pusty = domyślny profilu); dotyczy tur bez nadpisania. Podany wysiłek jest sprawdzany z katalogiem; przy samej zmianie modelu dotychczasowy wysiłek idzie za modelem według tej samej reguły (model bez `efforts`: pusty, wysiłek spoza listy: `default_effort` albo pusty). Zmiana idzie w `ThreadUpdate.thread` |
| `ListModels` | katalog modeli workerów (`WorkerModels`: worker → `ProfileModels` per dostawca i profil → `ModelInfo`: `id`, `resolved_model`, `display_name`, `description`, `hidden`, `is_default`, `efforts`, `default_effort`; `detail` = lista niepełna). Bez `refresh` ostatni raport workera (wysyłany po każdej zmianie konfiguracji), z `refresh` lista od nowa z workera (musi być online). Zmiany na żywo: `OverviewUpdate.models`. Puste `efforts` = model bez wyboru wysiłku albo spoza katalogu dostawcy (np. inne modele pośrednika); taki model jest w pełni używalny. Katalog ma tylko modele, które poprowadzą turę agenta (bez obrazów, wideo, TTS, embeddingów itd.; worker je usuwa). `default_effort` = domyślny wysiłek ustawiony przez użytkownika w harnessie na urządzeniu, jeśli model go oferuje, inaczej domyślny modelu, inaczej pusty; tura bez wysiłku działa właśnie z nim ([protocol.md](protocol.md#modele-effort-i-steer)) |
| `InterruptThread` | przerwanie tury w toku |
| `AnswerInteraction` | odpowiedź na zgodę albo pytanie |
| `WatchThread` | najpierw snapshot (wątek, tury ze zużyciem tokenów, itemy, oczekujące interakcje, ostatnie komunikaty, `last_seq`), potem zmiany na żywo: zdarzenia (`seq` + `ThreadEvent`), wątek, tura, interakcja. Snapshot forka zawiera odziedziczoną historię: tury i itemy wątku źródłowego do punktu forka z `inherited = true` i `from_thread_id`. Tura ma `model` i `effort`: nadpisanie z wiadomości, a od startu wartości faktycznie wysłane do workera (puste = domyślne profilu); tak samo `permission_mode` (od startu zawsze ustawiony). Tura ma swoje źródło (`source_kind`: task, message, report, question, schedule; `source_thread_id`, `schedule_id`, `interaction_request_id`; dla raportu `source_status`, dla pytania `question_kind` i `question_tool`), odczytane z relacji w bazie (widok `turn_sources`), nie z treści. `input_text` to dokładnie to, co dostał model; `platform_note` i `message_text` to ta sama treść rozdzielona na notatkę platformy i właściwą wiadomość. Tura od agenta (task, message, report) i steer agenta mają `sender` (`AgentSender`: wątek nadawcy, tytuł, dostawca, instancja, model, projekt, worker), także spoza drzewa. Snapshot ma `bus_deliveries`, a zmiany przychodzą jako `bus_delivery`: dokąd dotarły wywołania `spawn_thread` / `send_message` tego wątku i status tur docelowych ([agent-bus.md](agent-bus.md#wiadomości-między-dowolnymi-wątkami)) |
| `ListSchedules`, `CreateSchedule`, `UpdateSchedule`, `PreviewSchedule`, `SetScheduleStatus` | harmonogram platformy: lista z autorem i ostatnim edytującym, tworzenie, edycja z kontrolą wersji, podgląd terminów cronu, wstrzymanie, wznowienie i anulowanie. Użytkownik może edytować także zadania agenta. Zakończonego ani anulowanego zadania nie da się edytować ani wznowić. Zmiany na żywo w `ThreadUpdate.schedule` i `OverviewUpdate.schedule`, a snapshot wątku zawiera jego aktywne i wstrzymane harmonogramy |
| `SetGoal` | cel harnessu w wątku ([goals.md](goals.md)): `action` = `set` (nowy cel z `objective`, opcjonalnie `token_budget` tylko dla Codexa; zastępuje otwarty), `pause`, `resume`, `clear`. Zwraca `Goal`; decyzja jest zapisana od razu, harness potwierdza ją raportem (`Goal.native_status`). Codex: komenda `SetGoal` do workera; Claude: tura `/goal …` w kolejce (`trigger = goal`; pauza i usunięcie najpierw przerywają turę). Błędy: brak otwartego celu do pauzy/wznowienia/usunięcia, budżet dla Claude, `objective` > 4000 znaków |
| `StopBackgroundTask` | zatrzymanie zadania w tle (`thread_id`, `item_id` itemu `background_task`, musi być `in_progress`) → komenda `StopTask`; item kończy się `interrupted` (`stop_reason = stopped_by_user`), gdy worker to zgłosi ([execution.md](execution.md#4-zadania-w-tle)) |
| `ListProviderInstances`, `SaveProviderInstance`, `DeleteProviderInstance`, `SetInstanceWorkers`, `SetInstanceWorker`, `SetInstanceModels`, `RefreshProviders`, `StartProviderLogin` | globalne instancje dostawców ([worker-config.md](worker-config.md#9-globalne-instancje-dostawców)): lista z definicją (bez wartości sekretów: `api_key_set`, zmienna-sekret z pustą wartością), wyborem modeli, liczbą wątków i stanem na każdym workerze (`InstanceOnWorker`: włączona, wybór jawny czy z `all_workers`, nadpisania, ostatni raport: `available`, `detail`, `version`, `auth`, `authenticated`, `checked_at`, `synced`); nowa (`create`, id: małe litery, cyfry, `-`, `_`; unikalne w obrębie dostawcy; od razu `all_workers` albo `worker_ids`) albo zmieniona definicja (`expected_revision`; inna = `FailedPrecondition`); usunięcie nieużywanej (używana: `FailedPrecondition`); gdzie działa (wszystkie workery albo wybrane); włączenie i nadpisania na jednym workerze (sekret bez wartości = bez zmian, `api_key` pusty = klucz definicji); modele (`favorites_only` = sama gwiazdka z pickera); ponowne sprawdzenie na workerach online (`ProbeProviders`, `skipped` = pominięte z powodem); logowanie ChatGPT kodem urządzenia (Codex z `own_login`). Każda zmiana definicji albo przypisania zapisuje nowe wersje konfiguracji tylko workerom, których efektywne instancje się zmieniły, i wysyła je tym online; zmiany na żywo w `OverviewUpdate.worker` (`Worker.provider_instances`: id, dostawca, nazwa, kolor, włączona, dostępna, ulubione) |
| `GetSettings`, `UpdateUserSettings`, `UpdateProjectSettings` | ustawienia użytkownika (wygląd: schemat kolorów, osobne pełne palety Light / Dark, szerokość czatu, panel wątku; domyślne wartości nowych wątków, w tym model osobno dla każdego dostawcy; ulubione modele `model_favorites`: dostawca, profil (pusty = dowolny), model) i projektu (domyślne wartości wątków, nadpisują użytkownika). Przechowuje je gateway (`user_settings`, `project_settings`); przeglądarka jest tylko klientem. Zapis zastępuje podane sekcje i podaje wersję, od której zaczął: konflikt z innym urządzeniem = `FailedPrecondition` (BFF: 409), klient pobiera ustawienia od nowa. Zmiany na żywo w `OverviewUpdate.user_settings` / `project_settings` |

UI składa itemy na żywo tym samym reducerem co gateway (`reduceItem` z `@canopy/domain`).

### Harmonogramy tworzące nowe wątki

`CreateScheduleRequest.target` to `thread` (także pusty, zgodność wsteczna) albo `new_thread`.
Istniejący cel wymaga `thread_id`. Nowy cel wymaga `new_thread: NewThreadSchedule` i pustego `thread_id`:
`project_id`, `placement` (`any`, `least_busy`, `round_robin`, `specific`), `workspace_id` tylko dla
`specific`, `provider`, `provider_profile_id` (pusty = `native`), `model`, `effort` (pusty dozwolony,
modele bez wysiłku działają), `permission_mode` (domyślnie `ASK`), opcjonalny `title`.
Wiadomość pozostaje w `prompt`; opcjonalne `name` nazywa harmonogram (bez niego pierwsze 60 znaków wiadomości).
`concurrency` to `skip_if_running` (domyślne) albo `allow`. Obowiązują dotychczasowe `run_at`/`cron`,
strefy czasowe, minimalny odstęp 5 minut, `until`, `max_runs` i `missed_policy`.

`Schedule` zwraca te ustawienia oraz `recent_runs` — pięć ostatnich wystąpień z `scheduled_for`,
numerem udanego uruchomienia, `thread_id`, `turn_id`, `worker_id`, `workspace_id`, `outcome`, `created_at`.
Pominięcie ma numer 0 i puste odnośniki do wątku/tury. `Thread.schedule_id`, `schedule_name`,
`schedule_run` opisują pochodzenie wątku; UI pokazuje „Started by schedule ‹name› · run N” i ikonę zegara.
Nowe pola istniejących wiadomości zajmują numery 290–309. Nowe harmonogramy są tylko dla użytkownika;
narzędzia agentów nadal planują wyłącznie tury istniejących wątków.

Settings → Scheduled tasks pozwala wybrać cel również bez istniejących wątków. Formularz nowego wątku
używa wspólnych pickerów modelu/instancji, wysiłku i uprawnień, ogranicza wybór workera do workspace projektu
i podaje aktualnie kwalifikujące się workery. Z panelu wątku domyślnie wybiera „In this thread”.
Lista pokazuje projekt, politykę, model i historię z linkiem do wątku i nazwą workera. Zmiany harmonogramów
nowych wątków przychodzą w `OverviewUpdate.schedule`; istniejących również w `ThreadUpdate.schedule`.
Przy braku workera puli ponawianie trwa co 5 s; po 2 minutach `skip` pomija, `run_once` zachowuje
jedno zaległe wykonanie (do `until`, jeśli ustawione). `specific` może utworzyć wątek na offline workerze,
korzystając z jego ostatniej dostępności instancji. Szczegóły: [agent-bus.md, sekcja 5](agent-bus.md#5-harmonogram).

### Edycja harmonogramów

`UpdateScheduleRequest` zawiera `schedule_id`, wymagane `expected_version` i `configuration`
(`CreateScheduleRequest`, pełna konfiguracja). Walidacja jest wspólna z tworzeniem, a odpowiedź
`UpdateScheduleResponse.schedule` zawiera nowy stan. Konflikt z innym zapisem, zmianą statusu albo
zatwierdzonym wykonaniem zwraca `FailedPrecondition` (BFF: 409); formularz zachowuje wpisane wartości
i wskazuje konieczność ponownego otwarcia. Odnowienie lease nie zmienia wersji.

Nowe pola `Schedule` mają numery 330–333: `version`, `last_edited_by_user_id`, `last_edited_at`,
`configured_name`. Ostatnie pole zachowuje jawną nazwę, również pustą; dotychczasowe `name` nadal
zwraca etykietę z pierwszych 60 znaków wiadomości, gdy nazwy nie podano. Edycja nie zmienia autora
utworzenia, historii, licznika `runs`, ostatniej tury ani pauzy. Najbliższy termin jest liczony od nowa;
limit `max_runs` jest łączny, a nie od chwili edycji. `thread` można zamienić na `new_thread` i odwrotnie,
ale przy pozostaniu w trybie `thread` nie można wybrać innego istniejącego wątku.
Przejęte, jeszcze niezatwierdzone wystąpienie zachowuje swój klucz historii i użyje nowej konfiguracji
o nowym terminie. Już uruchomiona praca pozostaje bez zmian.

Settings i panel wątku używają wspólnego menu „…”: `Edit…`, `Pause` lub `Resume`,
`Cancel schedule…` (nieodwracalne anulowanie wymaga dialogu potwierdzenia). Stan jest kropką z etykietą
przy tytule lub w metadanych. Zakończone i anulowane zadania nie mają akcji. `Edit scheduled task`
otwiera ten sam `ScheduleDialog` co tworzenie, wypełniony zapisaną konfiguracją; `Save changes`
zapisuje wersję z chwili otwarcia. `PreviewSchedule` działa również w edytorze, pokazując trzy
najbliższe terminy po zmianie cronu lub strefy. Menu i dialog używają istniejących tokenów ruchu
z `layout.css` i `motion.css`, również przy ograniczonym ruchu.

BFF: `PUT api/schedules/[id]` przyjmuje `UpdateScheduleRequest` (identyfikator z URL jest wiążący),
a `POST api/schedules/preview` przyjmuje `PreviewScheduleRequest`. Zapis zwraca pełny harmonogram,
podgląd — terminy `next_runs`; błędy walidacji mają HTTP 400, konflikt wersji HTTP 409.

Cele i praca w tle w modelu UI (pola od 60, osobno od innych zmian kontraktu):
- `Thread.goal_status` (status otwartego celu albo pusty) i `Thread.background_tasks` (zadania w tle w toku) — także w `WatchOverview`, np. na plakietki w pasku bocznym,
- `Goal`: `objective`, `status` (`active | paused | blocked | budget_limited | usage_limited | achieved | cancelled`), `created_by` (`user | provider`), `token_budget`, `tokens_used`, `time_used_seconds`, `iterations` (Codex: tury kontynuacji, Claude: oceny ewaluatora), `last_reason` (werdykt ewaluatora), `native_status`, czasy,
- `ThreadSnapshot.goal` (otwarty cel albo ostatni zakończony), na żywo `ThreadUpdate.goal`; `Turn.goal_id` (tury celu),
- zadania w tle to itemy `background_task` na osi czasu (`kind`, `command`, `output`, `started_in_turn_id`, `source_item_id`, `stop_reason`); po turze przychodzą jako zdarzenia bez `turn_id`.

Restart workera i błędy komend (pola od 70):
- `Thread.runtime`: `gateway` (agent czatowy w gateway: bez celów i pracy w tle) albo `worker`; UI ukrywa przy wątkach gateway pigułkę „Goal” i „Set a goal…”,
- `Thread.last_turn_status`: jak skończyła się ostatnia zakończona tura (`completed` | `failed` | `interrupted`), do stanu subagentów w panelu nad kompozytorem,
- `Thread.last_message`: w wątkach bocznych początek ostatniej wiadomości agenta (wynik subagenta, do 600 znaków), w głównych pusty; karta subagenta na osi czasu rodzica ([agent-bus.md](agent-bus.md#subagenci-platformy-zamiast-natywnych)),
- `Turn.interrupt_reason`: dlaczego tura jest `interrupted`, np. `worker restarted` (worker już jej nie prowadzi), `the turn was no longer running on the worker` (przerwanie tury, której worker nie zna), `superseded: …`,
- `Turn.error_source` (72): przy `failed` skąd błąd — `platform` (nasza strona) albo `harness` (Codex/Claude zgłosił błąd); treść w `error`, krótki kod w `Turn.error_code` (74), np. `http_connection_failed:401`, `process_exit`,
- `Turn.interrupt_source` (73): przy `interrupted` kto przerwał — `user` albo `system` (np. `worker restarted mid-turn`). Stopka tury w UI pokazuje „Harness error: …” / „Platform error: …”, „by you”, „by the system: …” i dla przerwania przez system akcję „Continue” (wiadomość wznawiająca sesję). Stany i macierz: [durability.md](durability.md#47-stany-tury-i-wątku). Wątek po każdym końcu tury jest `idle`; `failed` tylko dla wątku, który nie powstał,
- `Goal.error`, `Goal.error_at`: ostatnia komenda celu nie powiodła się na workerze; status wraca wtedy do ostatniego stanu harnessu ([goals.md](goals.md#3-statusy)). `goalPending` w UI nie pokazuje wtedy „Starting… / Pausing…”, a `GoalBar` pokazuje błąd.

### Komendy powłoki w kompozytorze

Pierwszy znak `!` włącza tryb powłoki w kompozytorze nowego, istniejącego i bocznego wątku.
Obramowanie zmienia kolor na rose w obu motywach bez zmiany rozmiaru. Zarezerwowany wiersz
pokazuje „Runs as a shell command when delivered.”. Usunięcie `!` przywraca zwykłą wiadomość;
Escape zachowuje dotychczasowe działanie. Spacja przed `!` nie włącza trybu. Sam `!` oraz
komenda z załącznikami, cytatami lub wzmiankami wymagają poprawienia przed wysłaniem.

`SendMessage` zachowuje kolejkę i steer: komenda uruchamia się dopiero przy dostarczeniu wejścia
na workerze. W kolejce nie wykonuje żadnych efektów. Steer używa istniejącej ścieżki harnessu;
Grok nadal wraca do kolejki. Jeśli tura skończy się podczas wykonania steera, kolejna tura
otrzymuje ten sam zapisany wynik, bez ponownego uruchomienia komendy.

`Turn.shell_command` / `shell_result` i analogiczne pola `Steer` pokazują komendę monospace,
kod wyjścia, pierwsze 4 wiersze wyniku oraz „Show output”, bez osobnego podglądu wejścia
harnessu. Zapisane wejście agenta pozostaje bez zmian. Wyniki niezerowego
kodu też trafiają do agenta; timeout, Stop i błąd uruchomienia kończą wejście bez startu agenta.
Nieudany shell steer pozostaje widoczny. Szczegóły wykonania i trwałości: [protocol.md](protocol.md#komendy-powłoki-właściciela).

### Kompaktowy kompozytor podczas czytania historii

Kompozytor wątku zwija się po celowym przewinięciu w górę o co najmniej 96 px, gdy od końca dzieli co najmniej 192 px. Histereza utrzymuje wąski widok aż do powrotu na dół (wspólny próg feedu: 8 px) albo interakcji z kompozytorem. Nowy fokus, kliknięcie edytora, pisanie, upuszczenie/wklejenie pliku, otwarcie kontrolek i „Jump to latest” rozwijają pole. Celowe przewijanie ma pierwszeństwo przed istniejącym fokusem; edytor pozostaje zamontowany i zachowuje fokus również na telefonie.

Wąski widok pozostawia pierwszą linię tego samego edytora i przycisk wysyłania/zatrzymania; narzędzia i metadane są zwinięte i `inert`. Nad nim pozostają gęstsze nagłówki subagentów, kolejki i pytań asynchronicznych. Ich treść jest zwinięta i zachowuje stan, a kliknięcie nagłówka rozwija kompozytor i wybrany panel. Synchroniczne `ask_user` utrzymuje pełny widok. Szkic, wzmianki i historia cofania nie są odtwarzane z kopii.

`ComposerCompaction` obsługuje stan niezależnie od DOM. `ScrollIntent` rozróżnia gesty z inercją, własne korekty `scrollTop` i przewijanie programowe; `VirtualFeed.onreaderscroll` przekazuje wyłącznie ruch czytelnika. Stopka jest nakładką poza scrollerem. Jej rezerwa miejsca pod historią podczas czytania może tylko rosnąć, więc żadna klatka animacji nie ogranicza `scrollTop`. Przy opuszczaniu dołu odświeżana jest kotwica bieżącego wiersza, zanim streaming może uruchomić `ResizeObserver`. Natywne `overflow-anchor` pozostaje wyłączone. Gradient i „Jump to latest” są związane z rzeczywistą geometrią nakładki. `ComposerFold` współdzieli przejścia narzędzi na tokenach `--duration-slow` przy otwieraniu i `--duration-medium` przy zamykaniu; `ComposerPanelBody` współdzieli accordion paneli na `--duration-fast`. Reduced motion przełącza natychmiast. Ustawienia i protokół pozostają bez nowego przełącznika.

`ComposerPanelHeader` współdzieli nagłówki subagentów, kolejki i pytań (32 px desktop / 36 px telefon; 28 px w kompakcie). `ComposerPanelBody` utrzymuje ich treść zamontowaną i `inert` po zwinięciu. Ring `ComposerTop` jest poza przycinanym body; nie przechodzi przez `ComposerFold`. Kolejka ma wiersze 36 px, a subagent z podglądem ostatniej wiadomości 40 px. Tytuły mają 14/13 px, tekst pomocniczy 13/12 px, ikony dostawców 14 px, chevrony 12 px. `Icon`/`ProviderIcon` mają jawny `size`, a `TouchTarget size="sm"` zachowuje co najmniej 40 px obszaru dotyku.

Panel subagentów filtruje wyłącznie pracujących i oczekujących na odpowiedź/zgodę (`subagentsOf`). Podsumowanie liczy tylko aktywnych; przy pustej liście znika cały panel, także w kompakcie. Zakończony wiersz wychodzi przez `--duration-quick`; wejście panelu używa `t-rise` / `--duration-fast`, również przy pierwszym montowaniu stosu. Reduced motion wyłącza oba przejścia. Ustawienie „Keep finished subagents in the list” zmienia wyłącznie Lineage, bez wpływu na ten panel i karty na osi czasu.

Przy nawigacji TurnRail rezerwa do wyrównania ostatniego wiersza jest liczona razem z wysokością nakładki (`footerHeight + alignmentSpace`). `scrollend` odświeża kotwicę tylko po nawigacji smooth; własne korekty całkowitoliczbowego `scrollTop` zachowują pierwotny offset ułamkowy, aby streaming nie kumulował błędu zaokrągleń.

„Jump to latest” animuje pozostałą odległość do aktualnego końca na każdej klatce (`EndScroll`, `--duration-slow`, `smoothOut`). Pomiar wierszy i rozwijanie kompozytora mogą zmieniać cel podczas ruchu. Zakończenie animacji uruchamia zwykłe przypinanie dołu bez oczekiwania na natywne `scrollend` ani okno czasowe blokujące korekty. Każda zmiana rzeczywistej rezerwy stopki, także po opóźnionym zatwierdzeniu `footerHeight`, ponownie wyrównuje pozycję po aktualizacji DOM. Gest czytelnika, nawigacja do wiersza i otwarcie foldu przerywają animację; reduced motion i dalekie skoki używają ścieżki natychmiastowej.

### Pytania nad kompozytorem

`Interaction.asynchronous` i `InteractionPrompt.asynchronous` (pole **250** w odpowiednich wiadomościach) oznaczają pytanie, przy którym agent pracuje dalej. Domyślne `false` zachowuje zachowanie natywnych interakcji. Async pozostaje w `snapshot.interactions` i strumieniu interakcji, lecz nie zwiększa `Thread.pending_interactions` ani komunikatu czytnika ekranu „waiting for you”.

Nieodpowiedziana interakcja blokująca wygasa po zakończeniu pytającej tury;
`ask_user(wait: true)` także po limicie 120 s. Stan `expired` jest zapisany na osi
czasu i publikowany w strumieniu. `AnswerInteraction` odrzuca spóźnioną odpowiedź
`FailedPrecondition: This request expired.`, także przed sweepem porządkującym turę.

Znany termin odpowiedzi jest trwałym `expires_at` w `Interaction`, osi czasu
(`InteractionPrompt`) i `BotApproval`. Synchroniczne `ask_user` zapisuje termin 120 s
przy utworzeniu; ponowienie nie zaczyna odliczania od nowa. Wcześniejszy termin
transportu wygrywa. In-process MCP Claude przekazuje i egzekwuje 330 s z tej samej
stałej, która konfiguruje SDK. Natywne interakcje bez znanego limitu, asynchroniczne
pytania i HTTP MCP botów bez limitu Canopy nie dostają terminu.

Web i mobile pokazują `Expires in 1:45` przy tytule karty, bursztynowo w ostatnich 25 s.
Na wąskiej karcie licznik przechodzi pod tytuł, z wyrównaniem do prawej. Znany termin
zachowuje swoje miejsce po rozstrzygnięciu prośby; brak terminu nie dodaje pustego wiersza.
Wartość aktualizuje się
co sekundę lokalnie w karcie, bez animacji i bez przesuwania zawartości. Przy zerze
pokazuje `Expiring…`; dopiero zdarzenie gatewaya rozstrzyga o wygaśnięciu. Aplikacja
nie ma offsetu zegara serwera, więc odliczanie używa zegara klienta (jego rozbieżność
może zmienić wskazanie, nigdy stan prośby).
Pytania asynchroniczne zachowują możliwość odpowiedzi w kolejnej turze.

`ComposerTop` to wspólna powierzchnia/slot nad polem wiadomości: panel subagentów, kolejka i pytania tworzą jeden stos z jednym nachodzeniem na composer. Warianty `embedded` paneli nie dodają własnych obwódek ani przesunięć. `Composer` wybiera najstarszy zestaw blokujący przed async, przechowuje szkice per id zestawu i używa osobnego `MessageComposer` do zwykłych wiadomości.

`QuestionForm`, `QuestionOption` i `QuestionSession` obsługują kroki, Back, Skip, Skip all, Dismiss (sync), zwijanie i przełączanie async na wiadomości. Pole odpowiedzi używa placeholdera „Type your own answer, or leave this blank to use the selected option” i przycisku „Submit”; wpisany tekst ma pierwszeństwo przed zaznaczeniami. Rekomendacja jest oznaczeniem, bez automatycznego wyboru. Zwykły szkic wiadomości zostaje zamontowany przy przełączaniu. Natywne pytania poufne zachowują pole hasła i ukryte odpowiedzi w rekordzie osi czasu.

Opcje to semantyczne inputy radio/checkbox ze wspólnego `Input`, z własną grafiką `ChoiceControl`; grupa ma `fieldset`/`legend`. Przy fokusie w grupie 1–9 wybiera opcję, ↑/↓ przenosi fokus, Enter zatwierdza; cyfry w composerze pozostają tekstem. Przejście kroku przenosi fokus na legendę, jeśli użytkownik operował w panelu. Zwijanie ma `aria-expanded`, `aria-controls` i `inert`; ruch korzysta z istniejących `.t-acc-panel`/`.t-acc-chevron` i tokenów `layout.css`, z wyłączeniem przejść dla reduced motion.

Odpowiedź nadal idzie przez `AnswerInteraction` / `POST api/interactions/[id]`. Dla `ask_user`: `{answerJson: JSON.stringify({answers: [{id, kind: "choice", labels: [...]}, {id, kind: "text", text: "..."}, {id, kind: "skipped"}]})}`; kompletna lista odpowiada zestawowi pytań. Dismiss: `{cancelled: true}`. Adaptery zachowują natywne formaty Claude i Codexa. `interaction_prompt` zostaje na osi czasu jako skrót tematu i odpowiedzi z autorem; rozwinięcie pokazuje cały zestaw i jawnie pominięte pytania.

### Potwierdzenie wiadomości

`SendMessage` z nieznanym wynikiem transportowym pozostaje oczekujący. BFF zwraca
HTTP 202 `{pending: true}`; web/desktop i mobile ponawiają niezmienione żądanie z
tym samym `client_request_id` co 2 s. Kompozytor blokuje szkic i pokazuje „Sending…”
lub „Still waiting for ‹computer›…”. Potwierdzenie domu obejmuje także `/goal`;
odczyt wyniku nie tworzy drugiej wiadomości po końcu tury. Szczegóły limitów,
trwałych potwierdzeń i lokalnego revision probe: [linked-computers.md](linked-computers.md).

BFF dobiera budżet domyślny RPC: odczyty lokalne 10 s, odczyty kwalifikowane
komputerem 15 s, pozostałe zapisy 35 s. Jawny limit danej operacji ma pierwszeństwo;
`SendMessage` zachowuje 10 s i potwierdzanie wyniku. Zwykły fetch JSON ma budżet 40 s.
`MarkThreadSeen` jest best effort: HTTP potwierdza przyjęcie od razu, BFF utrzymuje
jedno RPC na wątek oraz najwyższy oczekujący numer, z limitem 256 aktywnych wątków.
Niepowodzenie markera nie trafia do UI ani do logu błędów operacji użytkownika.

### Szkice i załączniki botów

`GetBotDraft({bot_id})` zwraca `BotComposerDraft`: tekst, wzmianki, cytaty, metadane
załączników, rewizję i klucz idempotencji wysyłki. `SaveBotDraft({bot_id, draft,
expected_revision})` zapisuje pełny szkic w DB domu bota; konflikt rewizji daje
`FailedPrecondition`. Oba RPC sprawdzają właściciela. Web udostępnia je przez
`GET/PUT /api/bots/:id/draft`; mobile wywołuje te same RPC. Szkic nie jest częścią
publicznego cache rozmowy i nie jest przechowywany w localStorage.

`UploadAttachment.bot_id` (3) kieruje upload do domu bota i akceptuje te same typy
plików co wątki. `SendBotMessage.attachment_ids` (452) wiąże pliki z wiadomością,
`BotMessage.attachments` (452) udostępnia wspólne miniatury i viewer. Opcjonalne
`SendBotMessage.draft_revision` (453) czyści tylko wysłaną rewizję szkicu, w tej
samej transakcji co zapis wiadomości. Retry z tym samym `client_request_id`
zwraca tę samą turę, również po związaniu plików. Nieudana wysyłka zostawia szkic.
Limity są wspólne z wątkami i ponownie sprawdzane przy wysłaniu. Nowe operacje
przez połączone komputery wymagają `remote_bot_composer_v1` na całej trasie.

### Załączniki

Niezmienne bajty załączników i blobów wątku mają `Cache-Control: private,
max-age=31536000, immutable` oraz ETag SHA256 faktycznie wysłanego wariantu.
Query `?thumbnail` i `?preview` tworzą odrębne klucze URL; walidacja ETag następuje
po sprawdzeniu dostępu przez gateway. `Vary: Cookie, Authorization` rozdziela sesje.
Odpowiedzi błędów API, w tym 404 i 409, mają `no-store`, bez ETag.
Obrazy osi czasu korzystają z `loading="lazy"`.

Pliki dołączone do wiadomości (obrazy, zrzuty ekranu, tekst, kod, PDF, archiwa). Platforma nie zgaduje limitów modeli: agent dostaje pliki na dysku workera i sam decyduje, co z nimi zrobić (obrazy może obejrzeć przez `view_image`, [agent-bus.md](agent-bus.md#view_image)).

| Metoda | Co robi |
|---|---|
| `UploadAttachment` | `{name, data}` → `Attachment` (`id`, `name`, `mime_type`, `kind`, `size_bytes`, `width`, `height`, `sha256`, `has_thumbnail`). Typ z treści (`sniff`, `packages/domain`), nie z nazwy ani typu przeglądarki. Odrzuca (`InvalidArgument` z powodem): pusty plik, ponad limit, program (ELF, PE, Mach-O, rozszerzenia `.exe`/`.dll`/...). PNG, JPEG, WebP: zapisane obrócone według EXIF i bez metadanych (EXIF, GPS, XMP), JPEG/WebP ponownie kodowane (jakość 92), PNG bezstratnie; GIF bez zmian; HEIC/HEIF, AVIF, TIFF → JPEG/PNG, jeśli libvips je dekoduje (HEIC zwykle nie: zostaje plikiem `image/heic`); obrazy dostają miniaturę WebP (512 px). Limit pikseli 100 Mpx. SVG i HTML to zawsze `kind = file` |
| `GetAttachment` | `{attachment_id, thumbnail}` → bajty i typ; tylko właściciel (cudzy = `NotFound`) |
| `GetThreadBlob` | `{thread_id, sha256}` → obraz, wynik komendy/narzędzia/zadania albo diff z transkryptu; tylko właściciel, tylko blob wskazany przez wątek z tego samego drzewa (`thread_blobs`), do 8 MiB |
| `MarkThreadSeen` | `{thread_id, up_to_seq}` → użytkownik widział wątek do zdarzenia (strona wątku: ostatnia wiadomość na ekranie przez chwilę, karta widoczna); znacznik `thread_reads.seen_seq` tylko rośnie (najwyżej do `Thread.last_seq`). `Thread.unseen_result` = wynik ostatniej zakończonej tury za znacznikiem (`completed` / `failed` / `interrupted`, pusty = widziane); zmiana idzie do wszystkich urządzeń przez `OverviewUpdate.thread` |
| `SendMessage.attachment_ids`, `CreateThread.initial_attachment_ids` (110) | załączniki wiadomości. Każdy tylko raz, tylko własne; zapis wiadomości i powiązanie plików są atomowe. Wiadomość może nie mieć tekstu; `delivery = STEER` dostarcza pliki przed wejściem do trwającej tury. Starszy worker lub odmowa harnessu oznacza kolejkę z powodem |
| `Steer.attachments` (243), `SendMessageResponse.delivery_note` (244) | pliki steera do pokazania w UI; opcjonalna informacja o kolejce przy wysłaniu do starszego domu połączonego komputera |
| `Turn.attachments` (110) | pliki wiadomości (bez ścieżek); UI pokazuje je zamiast notatki |
| `GetSettingsResponse.attachment_limits` (110) | `max_file_bytes`, `max_message_bytes`, `max_files` |

Limity: Settings → Network access → Attachments; domyślnie 20 MiB na plik, 50 MiB na wiadomość i 10 plików.
`UserSettings.attachment_limits` i `UpdateUserSettingsRequest.attachment_limits` (**701**) zapisują je
w JSON ustawień właściciela, z istniejącą kontrolą wersji. Zakres: 1 bajt–30 MiB na plik,
do 1 GiB na wiadomość (nie mniej niż limit pliku), 1–100 plików; UI podaje MiB.
Kompozytor reaguje na aktualizacje ustawień; gateway odczytuje bazę przy nowych uploadach i wiadomościach.

**Notatka platformy.** Gateway składa wejście tury przy przyjęciu wiadomości: `input_text` = notatka + pusta linia + wiadomość (sama notatka, gdy tekstu nie ma), `platform_note` = notatka, `message_text` = wiadomość. UI bierze notatkę i wiadomość osobno (`platform_note`, `message_text`); z cytatami notatka ma też ich blok (niżej, „Cytaty”):

```text
[canopy] The user attached 2 files to this message, saved on this machine. Read them as needed; view_image shows you an image:
- <worker-data-dir>/attachments/<thread>/<attachment>/image.png (image/png, 245.3 KB, 1920×1080 px)
- <worker-data-dir>/attachments/<thread>/<attachment>/notes.txt (text/plain, 2.0 KB)

Co jest na zrzucie?
```

Ścieżki liczy gateway z `Hello.attachments_root` workera wątku; worker zapisuje plik dokładnie tam przed turą ([protocol.md](protocol.md#załączniki)).

**Worker offline.** Wiadomość z załącznikami do istniejącego wątku idzie do kolejki jak każda (bajty czekają w gateway, worker pobiera je przy starcie tury). Nowego wątku na workerze offline kompozytor nie wysyła (jak dotąd). Worker, który nigdy nie zgłosił `attachments_root` (starsza wersja), nie przyjmie załączników: `SendMessage` zwraca powód.

Podgląd obrazu pobiera odpowiedź BFF przed utworzeniem adresu Blob dla `<img>`.
Odmowa HTTP pokazuje komunikat JSON i Retry zamiast uszkodzonego obrazu; tekst
korzysta z tej samej obsługi błędu. BFF loguje kod RPC, wariant i oczyszczony
powód, bez zawartości pliku. Błędy nie są cache'owane. Po powrocie połączenia
lub domu pliku otwarty podgląd ponawia odczyt. Szczegóły zgodności starszych
domów: [linked-computers.md](linked-computers.md#podglądy-załączników).

#### Załączniki w tekście

**Podgląd plików.** Plakietki wiadomości wysłanych, kolejki i kompozytora otwierają
obrazy w `Lightbox` (powiększanie, nazwa, rozmiar, pobieranie), a pliki tekstowe w
dialogu z numerami wierszy na szerokim ekranie, zawijaniem, kopiowaniem i pobieraniem.
Markdown korzysta z tego samego `Markdown` co oś czasu; wybór „Rendered” / „Source”
zapisuje się w preferencjach urządzenia. Surowy HTML pozostaje tekstem. SVG wyświetla
się wyłącznie w `<img>`; BFF udostępnia jego typ przez `?image`, nadal z CSP sandbox
i `nosniff`. Pozostałe pliki zachowują pobieranie lub kartę composera.

Mysz i fokus klawiatury pokazują kompaktowy `Popover` po 300 ms intencji. Panel
pozostaje otwarty po przejściu wskaźnika do niego; blur i Escape zamykają go.
Dotyk otwiera modal bez hovera. Miniatura zachowuje proporcje, tekst pokazuje kilka
pierwszych wierszy, Markdown krótki wyrenderowany fragment; nazwa i metadane są zawsze
dostępne. Podgląd nie zmienia wymiarów plakietki ani wiadomości.

Treść ładuje się dopiero po intencji lub otwarciu. `GetAttachmentRequest.preview`
(800), również przez BFF `?preview`, ogranicza odczyt bloba w SQL do 128 KiB;
`GetAttachmentResponse.truncated` (800) sygnalizuje niepełny wynik. UI ogranicza też
tekst do 2000 wierszy i jasno wskazuje limit z akcją pobrania całości. Dekoder UTF-8
zastępuje nieprawidłowe sekwencje; NUL i nadmiar bajtów sterujących wyłączają podgląd.
Cache sesji mieści 64 podglądy, współdzieli trwający odczyt i pozwala ponowić błędy.
Odczyt pozostaje owner-scoped; kwalifikowane id kieruje go do domu połączonego
komputera tą samą drogą co obrazy. Pobieranie całości nie korzysta z limitu podglądu.

Plik może stać w tekście wiadomości w miejscu, które wybrał użytkownik: wzmianka `MentionKind.ATTACHMENT` (8) w `SendMessage.mentions` / `CreateThread.initial_mentions` / `EditQueuedTurn.mentions`, `name` = id załącznika z `attachment_ids` tej wiadomości, znacznik `[nazwa]` (`[` jako wyzwalacz w `checkMentions`). Gateway sprawdza, że każdy umieszczony plik należy do tej wiadomości (więc do tego samego właściciela) i stoi w tekście raz, a `label` ustawia na zapisaną nazwę pliku, `source` na jego rodzaj (`image` | `file`, ikona plakietki). Do 100 takich wzmianek ponad limit 50 pozostałych.

- **Dla agenta:** pliki w kolejności w tekście, potem pozostałe; notatka: „Each [Attachment N: name] in the message marks where the user put that file.” i linie `- Attachment N: <ścieżka> (…)`; w dostarczonym tekście `[nazwa]` zmienia się w `[Attachment N: nazwa]` (`numberAttachmentMarkers`, `packages/domain/src/mentions/attachments.ts`). Obrazy trafiają do harnessu za swoim znacznikiem ([protocol.md](protocol.md#załączniki-w-tekście)).
- **Dla UI:** `Turn.message_text` i `Turn.mentions` zostają takie, jak napisał użytkownik; `Turn.attachments` ma kolejność notatki. Fork, historia, wątki boczne i „Full text the agent received” korzystają z tych samych pól.
- **Edycja w kolejce:** edytor kolejki to pole kompozytora (`MentionEditor`): pliki są plakietkami, wzmianki chipami, a zapis wysyła ich pozycje jak `SendMessage` z `mentions_complete = true` (cała lista z edytora). Umieszczony plik żyje razem ze swoją plakietką: bez niej opuszcza wiadomość (nadal związany z turą, ale nie idzie do agenta); pliki nigdy nieumieszczone zostają, nowe nie dochodzą. Starszy klient edytuje sam tekst i nie wysyła wzmianek ani flagi: gateway odnajduje wtedy dotychczasowe wzmianki w nowym tekście po ich znacznikach (`relocateMentions`, `packages/domain`).
- **Bez pozycji:** wiadomość (np. ze starszego klienta) ma notatkę bez numerów, jak dotąd.

### Kolejka

`Thread.turn_starting` (162) przenosi ten sam stan startu do overview i aktualizacji wątku. Pozwala pokazać „Starting” także przed zdarzeniem `running`, zamiast poprzedniego wyniku tury.

`Turn.dispatched` (162) pochodzi z obecności komendy workera w stanie `pending`, `delivered` albo `completed` — z tego samego warunku, którym gateway chroni wystartowane tury przed zmianami kolejki. Tura `queued` z `dispatched = true` już startuje: jest na osi czasu, poza panelem i licznikami kolejki oraz bez jej akcji. `running` nadal potwierdza worker. Gateway zapisuje wiadomość do gotowego, bezczynnego wątku i jej `StartTurn` w jednej transakcji, więc pierwszy snapshot, zdarzenie i odpowiedź nie pokazują jej jako oczekującej. Przy starcie głowy istniejącej kolejki publikuje zmianę tury przed dostarczeniem komendy. Steer z `status = queued` pozostaje w kolejce do wystartowania jego tury. Web nie dodaje lokalnego wiersza tury przed odpowiedzią gatewaya.

Panel nad kompozytorem pokazuje wyłącznie wiadomości użytkownika (`trigger = user`, puste `source_kind` i `source_thread_id`). Raporty szyny agentów, fallbacki steerów platformy, notatki zadań w tle i inne wyzwalacze platformowe są z niego wykluczone, także przy lokalnym przestawianiu kolejności. Nie wyglądają jak wiadomości użytkownika oczekujące na wysłanie. Reguły dostarczenia i wygaszania raportów: [agent-bus.md](agent-bus.md#asynchroniczność). API kolejki zachowuje możliwość przestawiania tur platformy przez innych klientów.

Steer przyjęty przez RPC (`accepted`) nadal czeka na potwierdzenie wejścia przez
`user_message.client_id`. Dopiero ten item dostaje „Steered into this turn”. Jeśli
tura skończy się bez niego, gateway publikuje `status = queued`, `queued_turn_id`
i `reason`, nawet bez osobnej odmowy workera. Istniejący panel kolejki pokazuje
powód, a po starcie wiadomość jest wejściem własnej tury. Nie pozostaje wiersz
„Accepted, joins at the agent's next step” przy zakończonej turze.

Wiadomości czekające za turą w toku (tury `queued`) użytkownik układa. Kolejność kolejki to `Turn.ordinal` (gateway startuje najniższą). Operacje działają tylko na turach `queued`, których gateway jeszcze nie wystartował (jego `StartTurn` nie jest w outboxie); taka tura, albo tura, która już wyszła z kolejki, daje `FailedPrecondition` z powodem („this message already started running”, „this message is no longer in the queue”). Każda zmiana idzie do wszystkich klientów jako `ThreadUpdate.turn`.

| Metoda | Co robi |
|---|---|
| `ReorderQueuedTurns` | `{thread_id, turn_ids}` → podane tury dostają, w tej kolejności, miejsca (`ordinal`), które zajmują razem; tury, których klient nie zna (przyszły w międzyczasie), zostają na swoich. Kolejność zmienia się wśród tur kolejki, więc wystartowane tury nie zmieniają miejsca na osi czasu. Także tury agentów i harmonogramów |
| `EditQueuedTurn` | `{turn_id, text, expected_revision, mentions, mentions_complete}` → nowy tekst wiadomości użytkownika, złożony jak w `SendMessage`: wzmianki sprawdzone i rozwiązane ([Wzmianki](#wzmianki)), notatka załączników przed tekstem; nadpisania (model, wysiłek, tryb) i załączniki zostają; `/goal` nie czeka w kolejce (`InvalidArgument`). Inna `Turn.revision` (161) niż oczekiwana = `FailedPrecondition` (zmieniona gdzie indziej) |
| `DeleteQueuedTurn` | wiadomość użytkownika wychodzi z kolejki: `status = cancelled`, `Turn.withdrawn` (160) = `deleted`; oś czasu jej nie pokazuje |
| `RestoreQueuedTurn` | cofnięcie usunięcia: tura wraca do kolejki na swoje miejsce (idempotentne) |
| `SteerQueuedTurn` | wiadomość użytkownika (także z plikami, cytatami i wzmiankami; wejście takie, jakie dostałaby tura) idzie teraz do tury w toku: w jednej transakcji powstają steer (`Steer.from_turn_id` (160) = ta tura) i jego outbox, a tura wychodzi z kolejki (`withdrawn = steered`). Pliki trafiają do workera przed wywołaniem harnessu. Dalej jak steer z `SendMessage` (`pending` → `accepted` → `delivered`); gdy nie wejdzie, wraca ta sama tura na swoje miejsce w kolejce (`Steer.queued_turn_id = from_turn_id`), nie nowa na końcu. Bez tury w toku = `FailedPrecondition`, wiadomość zostaje w kolejce |
| `UserSettings.composer` (160) | `ComposerSettings.running_delivery`: co robi Enter, gdy trwa tura — `STEER` (domyślnie; Mod+Enter = kolejka) albo `QUEUE` (Enter = kolejka, Mod+Enter = steer) |

Settings → Threads → Messages udostępnia „When the agent is working, send messages as”
z wyborem Steer / Queue. Web, desktop i mobile zapisują istniejące
`UserSettings.composer.running_delivery` w JSONB ustawień właściciela; nie potrzeba
nowego pola protokołu ani migracji. Brak wartości nadal oznacza Steer. Menu kolejki
zmienia tę samą preferencję. Dotyczy ona wiadomości użytkownika, bez wpływu na
raporty subagentów i szynę agentów.

Web używa jej dla głównego przycisku i skrótu wysyłania (domyślnie Enter), a skrót
alternatywny (domyślnie Ctrl+Enter / ⌘+Enter) oraz menu przycisku pozwalają wybrać
drugi tryb dla jednej wiadomości. Mobile pokazuje drugi tryb obok głównego przycisku
i udostępnia go także po przytrzymaniu głównego przycisku. Wiadomości z plikami
zawsze trafiają do kolejki. Gdy agent nie pracuje, wiadomość rozpoczyna nową turę.

Klient wybiera tryb z ustawień oglądającego użytkownika i wysyła jawne
`SendMessage.delivery`, również do kwalifikowanego id zdalnego wątku. Dom wątku nie
wybiera trybu z własnych ustawień, więc preferencja działa także z wcześniejszą
wersją gatewaya obsługującą steer/kolejkę. Starsze klienty zachowują swój dotychczasowy
sposób wyboru trybu; gateway nie zmienia semantyki ich wiadomości.

**Wyścig z głową kolejki.** Zmiany kolejki i start jej głowy blokują najpierw wiersz wątku, więc idą jedna po drugiej. Scheduler (`pump`) zapisuje `StartTurn` tylko wtedy, gdy tura nadal jest głową kolejki z rewizją, którą przeczytał (`QueueStore.whileHead`); inaczej czyta kolejkę od nowa. Wystartowana tura ma więc zawsze tekst i miejsce, które użytkownik widział jako ostatnie przyjęte, a zmiana tury, którą scheduler wziął pierwszy, kończy się czytelnym błędem.
### Wzmianki

Komendy, skille, pluginy, pliki i inne wątki są wstawiane w tekst wiadomości jako chipy. Wyzwalacze w kompozytorze: `/` komendy, `$` skille i pluginy (`$Skill`, aplikacje `$app`), `@` pliki folderu wątku, `#` wątki; te same pozycje są w menu „+” obok „Attach files”.

Katalog zakresu (wątek albo workspace, dostawca, profil i folder) jest współdzielony przez kompozytory
karty lub parowania przez minutę, a `agentEnvironmentChanged` unieważnia go wcześniej; pusty katalog też
jest wczytany, a nieudany nie zastępuje wartości i czyta się ponownie przy następnym kompozytorze.
Gateway łączy równoczesne zapytania o ten sam niezbuforowany zakres w jedno zapytanie workera.
Wyszukiwania `@` i `#` z tym samym tekstem są ponownie używane przez 8 s (otwarcie listy jeszcze raz);
pliki i wątki zmieniają się poza Canopy, więc dłuższego cache nie ma.

Podczas kompozycji IME edytor odczytuje model i wykrywa wyzwalacze przy każdym
`input`, lecz nie przeformatowuje DOM aż do końca kompozycji. `compositionend`
odczytuje tekst także bez kolejnego `input`; Enter w czasie kompozycji nie wysyła.
Na ekranach poniżej `40rem` lub z coarse pointer lista sugestii jest w przepływie
kompozytora, z limitem 40% wysokości `visualViewport`. Wybór przez `pointerup`
zachowuje fokus, a `pointercancel` i próg ruchu odróżniają przewijanie od wyboru.
Po `execCommand("insertHTML")` trzeba przywrócić chipowi `contenteditable="false"`,
ponieważ WebKit może usunąć ten atrybut i umożliwić edycję samej etykiety.

Boty używają tego samego edytora z osobnym źródłem: `@` dla botów właściciela i przyznanych konektorów.
`Mention.kind=BOT`, `name=bot_id`, znacznik `@label`; `SendBotMessage.mentions` i
`BotMessage.mentions` mają numer 450. Wątki workera odrzucają ten rodzaj. Composer botów
przyjmuje też obrazy jako `ATTACHMENT`; nie udostępnia skillsów ani katalogu plików workera. Szczegóły:
[bots.md](bots.md#wzmianki-i-cytaty-użytkownika).

Na ekranach poniżej `40rem` lub ze wskaźnikiem `coarse` sugestie są częścią powierzchni kompozytora, nad edytorem, z własnym przewijaniem i limitem wysokości 40% `visualViewport` (aktualizowanym przy zmianie klawiatury/viewportu). Desktop zachowuje popover nad kompozytorem. Każdy `input`, także `insertCompositionText` i `insertReplacementText`, aktualizuje model i sugestie; formatowanie DOM czeka na zatwierdzenie kompozycji. `compositionend` sam ponawia odczyt, a zwykły input i utrata fokusu zerują stan kompozycji. Lista zapobiega utracie fokusu przy `pointerdown`; wybór przez `pointerup` działa także w WebKit, który może pominąć późniejszy `click`. `pointercancel` lub ruch palca większy niż 8 px wyklucza wybór podczas przewijania.

**Kontrakt.** Wiadomość niesie tekst i listę `Mention` (`worker/v1`): `kind` (`COMMAND | SKILL | PLUGIN | FILE | THREAD`), `name` (nazwa w harnessie; plik: ścieżka względem folderu wątku z `/`; wątek: id), `label` (to, co pokazuje chip), `[start, end)` w jednostkach UTF-16 tekstu (znacznik wzmianki: `/review`, `$transitions-dev`, `@docs/notatka.md`, `#Tytuł wątku`), `path` (skill: SKILL.md; plugin: `app://…` / `plugin://…`; plik: ścieżka absolutna na workerze, ustawia gateway), `source` (`built-in | user | project | plugin | system | admin | app | mcp | platform`), `is_dir`. Tekst bez wzmianek nadal czyta się jak zwykła wiadomość (np. dla starszych klientów).

| Pole / metoda (od 140) | Co robi |
|---|---|
| `SendMessage.mentions`, `CreateThread.initial_mentions` | wzmianki w tekście. Gateway sprawdza je (`checkMentions`, `packages/domain`: zakres w tekście, bez nakładania, znacznik zaczyna się wyzwalaczem, najwyżej jedna komenda i 50 wzmianek, plik bez `..` i ścieżek absolutnych, wątek: uuid **własnego** wątku, nie bieżącego), uzupełnia (`path` pliku, tytuł wątku jako `label`) i składa wejście tury dla dostawcy (niżej) |
| `Turn.mentions`, `Steer.mentions` | wzmianki w `message_text` / `text`: UI rysuje chipy w dymku. Item `user_message` w transkrypcie ma `UserMessage.mentions` (zakresy w jego tekście, razem z notatką platformy) |
| `SendMessageResponse.goal` | wiadomość z komendą platformy `/goal`: reszta tekstu to cel (`SetGoal set`); Codex bez tury, Claude z turą celu |
| `ListMentionCatalog` | `{scope, refresh}` → `MentionCatalog` (`entries`: kind, name, label, description, argument_hint, source, path, icon, aliases, plugin, color; `notes`: czego brakuje i dlaczego). Najpierw komendy platformy (`/goal`), potem katalog harnessu z workera. Pamięć: gateway 30 s, worker (Claude) 5 min albo do zmiany katalogów skilli/komend; `refresh` omija obie |
| `SearchFiles` | `{scope, query, limit}` → `FileSearchResult` (`matches`: path, is_dir, indices; `truncated`; `source`: git / walk). Wyszukiwanie na workerze, tylko w folderze wątku |
| `SearchThreads` | `{query, exclude_thread_id, limit}` → wątki użytkownika po tytule (fuzzy), przy równym dopasowaniu najnowsza aktywność; bez workera |

`MentionScope`: istniejący wątek (`thread_id`) albo nowy (`workspace_id`, dostawca, profil, opcjonalnie `cwd`). Worker offline: `Unavailable` z nazwą workera, popup to pokazuje.

**Dostarczenie per dostawca** (`composeMessage`, `packages/domain/src/mentions`; zakresy przesunięte o notatkę):

| | Claude | Codex |
|---|---|---|
| komenda | Claude Code wykonuje `/nazwa` tylko na początku wejścia: chip z środka tekstu idzie na początek (`/review please …`), reszta się zamyka | brak komend z tekstu (komendy Codexa to funkcje jego TUI); tylko komendy platformy |
| skill | skill na początku wiadomości → `/nazwa` (Claude Code ładuje go jak komendę); pozostałe → notatka „use it with the Skill tool: …” | item `skill {name, path}` (Codex wstrzykuje SKILL.md) |
| plugin / aplikacja | notatka (Claude w wątkach platformy nie ładuje pluginów) | item `mention {name, path}` (`app://<id>`, `plugin://<nazwa>@<marketplace>`) |
| plik | `@ścieżka` zostaje w tekście (Claude Code sam dołącza treść) + notatka ze ścieżką absolutną | `@ścieżka` w tekście (jak wstawia ją kompozytor Codexa); obraz dodatkowo jako `localImage` |
| wątek | notatka z tytułem i `thread_id` | jak Claude |

Każda wzmianka ma też `text_element` w wejściu Codexa (zakres bajtów UTF-8 i znacznik). Notatka (bez pustych linii, za notatką załączników):

```text
[canopy] The user mentioned another thread; read it with get_thread / read_thread when you need it:
- "Plan sprintu" (thread_id: 0193…)

Zobacz #Plan sprintu
```

Wątek wspomniany przez użytkownika agent może czytać (`get_thread`, `read_thread`) także spoza swojego drzewa ([agent-bus.md](agent-bus.md#6-reguły-dostępu-i-limity)).

**Co oferuje każdy harness** (Codex 0.164.0, Claude Code przez SDK 0.3.316):

- Codex: `skills/list` dla folderu wątku: `repo` (`.agents/skills` repozytorium, w UI `project`), `user` (`$CODEX_HOME/skills` oraz `~/.agents/skills` właściciela urządzenia: Codex czyta je mimo izolowanego `CODEX_HOME`), `system` (wbudowane, z ikonami i nazwami wyświetlanymi); `plugin/list` (zainstalowane i włączone; w izolowanym domu brak), `app/list` (konektory konta, tylko gdy worker je włączył, `NativeToolsConfig.connectors`). Komend brak.
- Claude: `Query.supportedCommands()` procesu uruchomionego jak tura (folder wątku, faktyczny izolowany `CLAUDE_CONFIG_DIR`, `settingSources` project + local), bez promptu. Skillem jest wiersz odpowiadający folderowi `.claude/skills/<nazwa>/SKILL.md` projektu lub `skills/` katalogu konfiguracji, a także `canopy-environment:<nazwa>` z jawnie ładowanego lokalnego pluginu Canopy; reszta to komendy (wbudowane, `.claude/commands` projektu, MCP). Wbudowane komendy terminala, sesji i ustawień, które trzyma platforma (`model`, `effort`, `clear`, `config`, …), subagentów i harmonogramu (gdy wyłączone) oraz natywny `/goal` (zastępuje go `/goal` platformy) są pominięte. Pluginy urządzenia i prywatne `~/.claude/skills` pozostają poza izolowanym domem; skille projektu i zarządzane przez Canopy są widoczne.

### Cytaty

`Quote` ma wspólny kontrakt w `quotes.proto` (dotychczasowe `ui.Quote` i numery pól
bez zmian). Boty przesyłają go przez `SendBotMessage.quotes` / `BotMessage.quotes`
(451), zapisują osobno od tekstu i używają tych samych komponentów Reply/Cite oraz
notatki `quotesNote`. `source_thread_id` cytatu z bota wskazuje jego rozmowę (id bota).

Użytkownik cytuje fragment tego, co agent wytworzył w wątku (odpowiedź, wcześniejsze wiadomości, rozumowanie, wejście i wynik narzędzia, wynik polecenia, blok kodu, diff) i odsyła go z wiadomością, z opcjonalnym komentarzem do każdego cytatu.

| Pole | Co robi |
|---|---|
| `Quote` | `text` (dokładnie zaznaczony tekst, tak jak widać: bez znaczników markdown, z podziałami linii), `comment` (opcjonalny), `source_item_id`, `source_thread_id` (item i jego wątek, także odziedziczona historia forka), `source_kind` (`agent_message` \| `reasoning` \| `command_output` \| `tool_call` \| `code` \| `diff`, pusty = tekst), `language` (blok kodu z językiem) |
| `SendMessage.quotes` (150) | cytaty wiadomości, do 20; tekst cytatu niepusty i do 20 000 znaków, komentarz do 4 000 (`QUOTE_LIMITS`, `packages/domain`). Wiadomość może mieć same cytaty. Działa z `delivery = STEER` (cytaty są w tekście, więc steer ich nie kolejkuje) |
| `Turn.quotes`, `Steer.quotes` (150) | cytaty wiadomości dla bańki użytkownika; `message_text` / `Steer.text` to sama treść użytkownika. Steer, który nie wszedł do tury, staje się turą z tymi samymi cytatami |

`CreateThread` nie ma cytatów: cytuje się w wątku, w którym jest źródło.

Ze wzmiankami notatka cytatów idzie do `composeMessage` razem z notatką załączników, więc zakresy wzmianek w dostarczonym tekście przesuwają się także o nią.

**Format dla agenta.** Cytaty to notatka platformy przed treścią (`quotesNote`, `packages/domain/src/quotes`): po notatce załączników (jeśli są), oddzielone pustą linią, potem pusta linia i wiadomość. Proza jako blockquote (każda linia z `> `), wynik polecenia, wywołanie narzędzia, kod i diff jako blok kodu z płotkiem dłuższym niż najdłuższy ciąg backticków w tekście (język bloku kodu, `diff`, inaczej `text`). Komentarz po cytacie jako `Comment: …`:

````text
[canopy] The user quoted 2 passages of this conversation. Each quote is the exact text they selected, followed by their comment on it when they wrote one; their message comes after the quotes.

Quote 1, from your message:
> Dostępność i ruch: pełna obsługa.

Comment: Skróć to.

Quote 2, from command output:
```text
FAIL src/a.test.ts
```

Popraw oba miejsca.
````

Źródła cytatu (`your message`, `your reasoning`, `command output`, `a tool call`, `a code block`, `a diff`, `this conversation`) mówią agentowi, skąd fragment pochodzi; identyfikatory itemów zostają tylko dla UI (przejście do źródła).

## 3. Rdzeń gateway (`GatewayCore`)

- **Workery:**
  - przy połączeniu zapisuje stan i ponownie dostarcza outbox,
  - zdarzenia przechodzą przez `Ingest` (jedna transakcja na wątek), a potwierdzenie (`EventAck`) idzie po commicie,
  - zapisuje raport konfiguracji,
  - interakcje zapisuje i rozsyła, a ponownie wysłane i już rozstrzygnięte dostają zapisaną odpowiedź,
  - raporty celów (`goal_state`) aktualizuje w transakcji ingestu (`store/goals.ts`), a zmiany celu i itemów tła odświeżają `Thread` (status celu, liczba zadań w tle).
- **Outbox komend:** każda komenda najpierw trafia do `worker_commands`, potem do workera, jeśli jest online. Po ponownym połączeniu jest dostarczana jeszcze raz, a worker deduplikuje ją po `command_id`.
- **Planista tur:** startuje najstarszą tura `queued`, jeśli wątek jest gotowy (`provider_thread_id`), nic w nim nie biegnie i dla tej tury nie ma jeszcze komendy w outboxie. Uruchamia się po wiadomości, po `thread_ready` i po zakończeniu tury.
- **Wyniki komend:**
  - odrzucone utworzenie wątku → wątek `failed` z powodem (`status_detail`),
  - odrzucony start tury → tura `failed`.
- **Zmiany na żywo:** przez `Hub` (proces gateway). Przy wielu instancjach będzie to `LISTEN/NOTIFY` (docs/durability.md, 4.3).

## 4. Frontend (`apps/web`)

### Współdzielone odczyty

Projekty, workery, modele, ustawienia i podobne katalogi zmieniają się tylko po znanych
zdarzeniach albo akcjach użytkownika. Klient czyta je raz, trzyma w pamięci sesji i
aktualizuje po zdarzeniu strumienia lub odpowiedzi własnej mutacji. `QueryCache`
(`@canopy/domain/shared-query`, web i mobile) opisuje te reguły:

- klucz nazywa jedno żądanie (np. `ListBots:archived`); konsumenci tego samego klucza dzielą
  wartość i żądanie w toku, a pusty wynik też jest wczytany;
- zdarzenie lub mutacja unieważnia klucz albo ustawia jego wartość; obserwowany klucz czyta
  ponownie raz na serię zdarzeń (40 ms), a zdarzenie w trakcie odczytu daje jeden odczyt końcowy;
- odczyt rozpoczęty przed ustawioną wartością jest starszy i zostaje odrzucony; po `forget`
  (unlink, usunięcie) i `dispose` (unpair, nowe parowanie) nic nie wraca do cache;
- nieudany odczyt zachowuje poprzednią wartość i błąd; nieobserwowane wpisy trzyma ograniczony LRU;
- snapshot po ponownej subskrypcji (przerwa w strumieniu) unieważnia wszystkie wpisy raz.

`OverviewInvalidation` (`@canopy/domain/shared-query-events`) mapuje zdarzenia na klucze:
`workerRecordsChanged`, `computer` i `computer_removed` → `ListWorkerRecords`;
`agentEnvironmentChanged` → `GetAgentEnvironment`; `models` → `ListModels`; nazwany
`linked_read_completed` → jego RPC. `worker` unieważnia bibliotekę środowiska tylko, gdy zmienia się
obecność, wersja lub stosowana konfiguracja; broadcast powtarzający niezmienione workery nic nie czyta.
Web trzyma jeden `QueryCache` na kartę (`lib/shared/queries.svelte.ts`): rekordy workerów
i środowisko agentów są współdzielone przez strony i pickery, a load trasy korzysta z bieżącej
wartości (`loadShared`). `OverviewState.resyncs` rośnie tylko przy pierwszej synchronizacji
i przerwie w strumieniu; zakończony odczyt partnera odświeża overview, ale nie ustawienia ani modele.

**Wypychane domeny.** Gateway sam wykrywa zmiany botów, konektorów i proxy (`core/owner-feeds.ts`),
dopóki ktoś obserwuje overview: co 2 s czyta zegar dziennika botów właściciela (`bot_view_clock`,
migracja 0091, O(1) w spoczynku), sygnaturę oczekujących kart oraz skróty kont konektorów i proxy.
Zmiany z harmonogramu, agentów, OAuth, synchronizacji konfiguracji i innych instancji gatewaya są więc
widoczne; zapis przez to API szturcha porównanie od razu (~100 ms). Wysyła `OverviewUpdate.bot` (824,
podsumowanie jak w ListBots, tylko zmienione boty), `bot_removed` (825), `connectors_changed` (826)
i `proxies_changed` (827). Po każdym otwarciu strumienia przychodzi `feeds` (828) z listą domen
wypychanych w całości; `bots` jest na niej tylko, gdy każdy osiągalny połączony komputer też je wypycha
(jego zmiany botów przychodzą z kwalifikowanymi id). Klient bez danej domeny w `feeds` (starszy gateway,
przerwany strumień) zachowuje zapasowe odpytywanie: lista botów co 15 s, Connectors co 30 s.
Uwagi konfiguracji (`ConfigNotices`) i strona Computers dzielą jeden odczyt `GetComputers`,
odświeżany przez `computer`, `computer_removed` i `shared_config`, z jednym sprawdzeniem na minutę
na widocznej stronie; zaproszenie do parowania sprawdza się co 2 s, dopóki jest ważne. Network access
czyta się co 30 s na widocznej stronie, a lista urządzeń raz na minutę (parowanie i odwołanie
przychodzą zdarzeniami).

Uprawnienia i stan wykonania sprawdza zawsze gateway; cache służy tylko do wyświetlania.

**Oczekujące decyzje.** Pytanie ma jeden przewijany obszar z treścią, opcjami i polem
odpowiedzi; nagłówek oraz akcje pozostają widoczne. Przycisk pod treścią wskazuje,
że niżej są dalsze opcje lub szczegóły, i przewija ten obszar. Przy pojedynczym pytaniu
nie ma Back ani Skip all. Skip pomija odpowiedź, a Dismiss anuluje całe żądanie;
opis przy akcjach wyjaśnia różnicę. Zgoda utrzymuje Allow, Deny i Allow for this session
pod szczegółami, a kompozytor na czas oczekiwania pokazuje przycisk Steer instead
otwierający zwarte pole wiadomości. Szkice, payloady odpowiedzi i semantyka grantów
sesyjnych pozostają bez zmian.
Gdy czeka kilka zgód lub formularzy, widoczny jest licznik i jedno żądanie;
Previous i Next request pozwalają przejrzeć pozostałe bez rozstrzygania bieżącego.

**Kontekst kompozytora.** `ComposerContextRow` oddziela miejsce uruchomienia od uprawnień:
projekt i komputer zajmują pierwszą parę pól, workspace i gałąź drugą. Przy szerokości
kompozytora od 44 rem pary mieszczą się w jednym wierszu, z naturalną szerokością
kontrolek ograniczoną przez ich maksima i stałym małym odstępem; poniżej zajmują dwa wiersze siatki,
niezależnie od długości nazw. Uprawnienia pozostają po prawej, przy górnym wierszu.
Poniżej 34 rem etykieta workspace jest skrócona, a uprawnienia pokazują ikonę.
Pełne nazwy są dostępne w dymkach i menu; gałąź zachowuje końcówkę przy skracaniu.
Przełączenie workspace korzysta z tokenów `swap`/`pop`; zawinięte pary zachowują stałe pola.
Wskazówki i ostrzeżenia są ikonami obok odpowiednich kontrolek (projekt, worker,
workspace, załączniki), z pełnym opisem po najechaniu, fokusie lub tapnięciu.
Ostrzeżenia mają `role=status`, a dymki `aria-describedby`. Zablokowany Send ma
fokusowalny wrapper z konkretnym powodem blokady; Enter respektuje tę samą blokadę.
Lista refów zachowuje kolejność workera wewnątrz dwóch grup: lokalnej i zdalnej.
Nagłówki list zestawu mają nieprzezroczyste tło i przyklejają się do krawędzi obszaru
przewijania bez pionowego paddingu między wyszukiwaniem a nagłówkiem.

**Gęstość Settings.** `features/settings/density.css` definiuje na stopniach skali
([ui-scale.md](ui-scale.md)) tokeny ograniczone do `SettingsDialog`: tekst i etykiety 13 px na desktopie, 15 px na telefonie, opisy 13 px,
nagłówki sekcji 14 px i stron 18 px. Odstęp sekcji wynosi 20/24 px (desktop/telefon),
pionowy padding wiersza 8/10 px, kontrolki i cele kliknięcia co najmniej 32/44 px.
Pola tekstowe na telefonie zachowują 16 px, aby nie uruchamiać automatycznego zoomu.
Treść ma maksymalnie 1024 px, nawigacja 216 px. `SettingsRow` układa tytuł i opis po
lewej, kontrolkę po prawej; na telefonie przechodzi na jedną kolumnę. `Field layout="row"`
zachowuje powiązania etykiety, opisu i błędu z kontrolką; w `settings-form` przechodzi
na dwie kolumny od szerokości 448 px. Wspólne `Fieldset`, `ChoiceCard` i kontrolki
zestawu dziedziczą skalę wyłącznie wewnątrz ustawień. Providers ma zakres nad zwartym
nagłówkiem, listę z wersją, pojedynczym statusem i przełącznikiem oraz definicję
w wierszach. Przełącznik w All workers włącza instancję na wszystkich workerach lub
usuwa wszystkie przypisania; zakres pojedynczego workera zmienia tylko jego przypisanie.

**Background tasks w panelu wątku.** `BackgroundTasksSection` pokazuje własne itemy `background_task`, także bez `turn_id`: najpierw działające, potem trzy ostatnio utworzone zakończone, w każdej grupie od najnowszych (`first_seq`). „Show N more” odsłania resztę. Każde zadanie zajmuje jeden wiersz: kropka statusu, skrócony tytuł, czas trwania i wiek zakończenia po prawej. Błąd i zatrzymanie mają też widoczną etykietę; pełny status jest w tooltipie i nazwie dostępnej. Kod wyjścia pojawia się tylko, gdy jest znany i niezerowy albo zadanie zawiodło. Ikona Stop ma stałe miejsce również po zakończeniu zadania. Wiersz, chip nad kompozytorem i „Open output” w itemie otwierają wspólny `BackgroundTaskDialog` (880 px na desktopie, pełny ekran telefonu). Współdzielony `ui/Terminal` jest ciemny w obu motywach: pasek okna zawiera krótki tytuł (opis harnessu albo program i argument po zdjęciu wrapperów powłoki), skrócone cwd, status z czasem i akcje Stop, Copy command, Copy output. Prompt z kolorowaniem Shiki zawija komendę do trzech wierszy; „Show full command” rozwija resztę we własnym obszarze. Przy kilku działających zadaniach chip najpierw pokazuje menu wyboru. Widoki używają tego samego stanu SSE co oś czasu; bez dodatkowego pollingu. Stop czeka na potwierdzenie workera, błąd pozwala ponowić.

Po zakończeniu zadania lista zachowuje liczbę już widocznych wierszy, żeby następne
sekcje nie przesuwały się w górę. Miejsce na wiek zakończenia jest zarezerwowane także
podczas pracy; zmiana wątku przywraca początkowy limit listy.

`ui/TerminalOutput` używa `LineReveal` i wirtualizacji wierszy o wysokości 20 px (widok + po 8 wierszy zapasu). Nowy output trzyma dół, przewinięcie w górę zwalnia pin; „Jump to latest”, End w obszarze wyjścia albo ręczny powrót na dół przypina ponownie. Esc zamyka natywny Dialog. Parser ANSI renderuje kolory SGR (16/256/truecolour) i podstawowe atrybuty tekstu; pozostałe sekwencje sterujące są usuwane. Copy output kopiuje cały dostępny strumień jako czysty tekst. Log przewija się poziomo wyłącznie we własnym obszarze, dialog nie przewija się poziomo. Oczekiwanie jest przygaszonym wierszem terminala; po zakończeniu pojawia się wiersz statusu wyjścia. Animacje korzystają z tokenów zestawu (`t-modal`, `t-pulse`, reduced motion).

`BackgroundTask` zawiera czasy startu i końca oraz opcjonalny kod wyjścia. Gdy ich brakuje, UI korzysta z czasów zdarzeń zachowanych przez `ThreadState` i kodu powiązanego `commandExecution`. Brakujący czas pozostaje opisany w szczegółach zadania, bez dodatkowego tekstu w kompaktowym wierszu. Cwd pochodzi z komendy albo wątku. `output_blob` nie ma obecnie API do odczytu outputu zadania: modal jawnie wskazuje, że wyświetla i kopiuje dostępny strumień.

**Kontrolki formularzy.** `Select` przyjmuje `options: readonly SelectOption[]` (`value`, `label`, opcjonalnie `description`, `icon`, `group`, `separator`, `disabled`), `bind:value` albo `value` + `onchange(value)`. Renderuje przycisk combobox z listboxem w `Popover`; `name` wysyła wartość przez ukryte pole. Strzałki, Home/End i typeahead zmieniają aktywną opcję; Enter/Space/Tab zatwierdzają, Escape anuluje. Fokus pozostaje na przycisku, a aktywna opcja jest wskazywana przez `aria-activedescendant`. Grupy mają nazwy dostępne, wybrana opcja ptaszek, opisy osobne `aria-describedby`. Na telefonach lista jest arkuszem. Dzieci `<option>` nie są już obsługiwane; wszystkie użycia zostały zmigrowane.

`Popover.maxHeight` nadpisuje limit wysokości zakotwiczonego panelu przez styl komponentu (bez konfliktu klas Tailwind). Picker daty używa większego limitu zależnego od dostępnego miejsca; mobilny arkusz zachowuje własny limit wysokości ekranu.

`FieldValidationPopover` pokazuje błąd obok pola, korzystając z `Popover` i jego
pozycjonowania oraz tokenów ruchu (również reduced motion). Snippet `field(props)`
przekazuje kotwicę, `aria-describedby` oraz obsługę fokusu i wskaźnika do kontrolki.
Komunikat jest ogłaszany przez stały `role="alert"`, także po zamknięciu panelu.
Panel otwiera się po zmianie błędu, fokusie, najechaniu lub dotknięciu pola; nie
przejmuje fokusu. Escape i kliknięcie poza zamykają go. Edytor Environment w Providers
waliduje nazwy podczas pisania; komunikat wskazuje Runtime, Connection lub inny
prefiks zamiast wyświetlać listę wszystkich zastrzeżonych nazw. `FieldError` zachowuje
dotychczasowe działanie w pozostałych formularzach.

`Input` pozostaje wspólnym publicznym API pól. Dla `number` używa wewnętrznego `NumberControl`: tekstowe pole `spinbutton`, własne −/+, min/max/step, strzałki i ograniczenie wartości przy zatwierdzeniu. Puste pole wiąże `null`, nieprawidłowy tekst `NaN`, aby walidacja wywołującego nie uznała go za pustą wartość. Dla `date`, `time`, `datetime-local` używa `DateTimeControl`: sformatowany lokalnie przycisk, `Calendar` z jednym przystankiem Tab i nawigacją po dniach/tygodniach/miesiącach, tekstowy czas HH:MM ze steperami, szybkie wybory i jawne Apply/Cancel. Dane zachowują format `YYYY-MM-DD`, `HH:MM`, `YYYY-MM-DDTHH:MM` bez `Z`. Nieistniejące godziny w luce DST są odrzucane; podwójna godzina jesienią oznacza wcześniejszy moment, zgodnie z dotychczasowym `Date`. `PickerTrigger` współdzieli wygląd i integrację `Field`, `StepperButtons` przyciski zmiany wartości, `ChoiceControl` rysowanie checkboxów/radio w `Input`, `Checkbox`, `Radio` i markdown. Wysoki kontrast (`forced-colors`) świadomie przywraca systemowy wygląd checkboxów/radio; zwykłe motywy używają własnej grafiki.

Kod wg funkcji (`#lib/features/*`), kod tylko serwerowy w katalogach `server/` (SvelteKit nie pozwala go zaimportować w przeglądarce).

| Ścieżka | Rola |
|---|---|
| `src/env.ts` | `GATEWAY_URL`, `GATEWAY_SERVICE_TOKEN` (`defineEnvVars`, odczyt przy starcie, nie przy buildzie) |
| `src/hooks.server.ts`, `lib/server/shell-appearance.ts` | `init`: wymaga tokenu usługi; `handle`: wpisuje wygląd w `<html>` przez `transformPageChunk` (schemat, dwie palety inline, szerokość czatu, szerokość i zwinięcie sidebara, zwinięcie panelu wątku). Cache wyglądu w procesie: 3 s, wspólne trwające pobranie, deadline 750 ms; podczas awarii ostatni znany wygląd albo domyślny. Zatwierdzony zapis przez BFF odświeża cache i chroni go przed spóźnionym odczytem. SPA odczytuje atrybuty przed pierwszym renderem; „system” rozstrzyga skrypt w `<head>`. Ustawienia pozostają w gateway; cache dotyczy obecnego pojedynczego użytkownika deweloperskiego |
| `lib/server/gateway.ts` | klient gRPC z tokenem; `call` używa wspólnego `gateway-errors.ts`: `InvalidArgument` → 400, `FailedPrecondition` → 409, `Internal` → 500 z oczyszczonym komunikatem gatewaya, transportowe `Unavailable` → 502 „Could not reach the gateway. Check that it is running, then retry.”, domenowe `Unavailable` → 503 z powodem, deadline → 504; pozostałe nieoczekiwane błędy → 500. Komunikaty nie ujawniają adresów URL, tokenów ani lokalnych przyczyn transportu. `attempt` dla akcji formularzy zamienia 4xx w `fail` (komunikat przy formularzu) |
| `lib/server/sse.ts`, `body.ts` | strumień gRPC → SSE: po krótkim sprawdzeniu gateway ramka `ready`, heartbeat co 10 s, przy błędzie ramka `failure`; zwykłe wywołania gRPC mają deadline 3 s, strumienie bez limitu całkowitego czasu. Ścisłe dekodowanie JSON (nadmiarowe pola → 400): `readBody` (Effect Schema) i `readMessage` (wiadomość kontraktu w JSON protobuf) |
| `lib/shared/wire.ts`, `http.ts` | JSON protobuf (`toJson` / `fromJson`) między serwerem a przeglądarką: te same schematy po obu stronach; `requestJson` (wywołania BFF z przeglądarki, `HttpError` ze statusem, np. 409) |
| `lib/shared/ui` | prymitywy UI: `Button`, `ButtonLink`, `IconButton`, `Field` + `Input` / `Select` / `Textarea` / `Checkbox` (opcjonalny `aside` obok etykiety, np. znaczniki) / `Radio`, `Fieldset` (grupa kontrolek pod jedną etykietą, z opisem i błędem), `FieldError`, `SearchField` (pole wyszukiwania z lupą), `Badge`, `StatusBadge`, `StatusDot`, `ProjectAvatar`, `Alert`, `EmptyState`, `Dialog` (`size="lg"`: szerszy od `sm`), `Drawer`, `Disclosure` (`remember`: stan w pamięci UI wiersza), `CodeBlock`, `Skeleton`, `SettingsGroup` + `SettingsRow`; wygląd przełącznika segmentowego (`segmented.ts`); `virtual/VirtualFeed` (przewijany czat, opis niżej; `reveal(key)` przewija do wiersza i daje mu fokus) z `SizeIndex` (wysokości wierszy: zmierzone po kluczu, reszta ze średniej grupy, sumy prefiksowe) i `memory.ts` (stan UI wierszy, które lista odmontowała, np. rozwinięte szczegóły); ikony Tabler outline (`@canopy/ui/icons`, wspólna mapa nazw i geometria 24×24 dla web i mobile; stroke 2.25 daje 1.5 px przy rozmiarze 16 px; nazwy `IconName` pozostają stabilne, logotypy dostawców i konektorów są osobne; licencja i źródło: `packages/ui/THIRD_PARTY_NOTICES.md`); warstwa pływająca bez zależności (Popover API, `popover="manual"`, pozycjonowanie z flip/shift w `floating.ts`): `Popover` (zakotwiczony, Escape / klik poza / wyjście fokusu zamyka, fokus wraca do wyzwalacza, na telefonie opcjonalnie arkusz), `DropdownMenu` + `MenuItem` / `MenuCheckItem` / `MenuGroup` / `MenuSeparator` / `MenuSub` (wzorzec menu button: strzałki, Home/End, typeahead, submenu), `Combobox` (WAI-ARIA combobox: autouzupełnianie albo lista inline w pickerach, gotowy na wyszukiwanie po stronie serwera), `SearchPicker` (pigułka otwierająca listę z wyszukiwarką: `Popover` z `Combobox` inline, na telefonie arkusz, opcjonalny link w stopce) + `PickerRow` (opcja listy: znak, nazwa, linia pod nią, status, ptaszek), `TextLink` (link w tekście), `DialogActions` (przyciski dialogu), `ActionForm` (formularz akcji strony z `enhance`: `busy`, `submitted` — błąd strony należy do formularza, który wysłał — i `onsuccess`), `tooltip` (attachment: opóźnienie, od razu przy fokusie z klawiatury, długie przytrzymanie na ekranach dotykowych), `HoverCard` (hover / fokus, stuknięcie na dotyku), `Slider` (dyskretne, podpisane stopnie), `Kbd` + `hotkeys.ts` (`Mod` = ⌘ albo Ctrl), `PillButton` / `PillText` (pigułki kompozytora), `Toaster` + `toast()` (krótkie potwierdzenia, np. „Copied”, z rysowanym ptaszkiem), `GrowIn` (treść, która wrasta i znika wysokością), `ResizeSlot` (miejsce w rzędzie kontrolek płynnie zmieniające szerokość), `ResizeHandle` (uchwyt zmiany szerokości panelu, WAI-ARIA window splitter: przeciąganie myszą / piórem / palcem z pointer capture, jedna aktualizacja na klatkę; strzałki co 16 px, z Shift co 64 px, Home / End, Enter i dwuklik = szerokość domyślna, Escape anuluje; opcjonalnie zwinięcie przy przeciągnięciu poniżej połowy minimum; logika w `resize-handle.ts`), `SheetHandle` (uchwyt arkusza na telefonie: przeciągnięcie w dół zamyka), `Rule` (linia wypełniająca resztę rzędu za etykietą granicy); ruch: tokeny w `routes/layout.css` (wspólna skala: `--duration-*`, `--ease-*`, `--distance-*`, `--scale-*`, `--blur-*`; przy `prefers-reduced-motion` odległości, skale i rozmycie są zerowane, zostaje przezroczystość), przepisy w `motion.css` (klasy `t-*`: menu i popovery rosną od wyzwalacza, dialogi skalują się, arkusze i szuflada wjeżdżają, podpowiedzi, przesuwana pigułka przełącznika segmentowego, akordeon, toast, potrząśnięcie błędu, wejścia `t-swap` / `t-rise` / `t-reveal` / `t-stream`, puls szkieletów; wejście i wyjście warstwy górnej czystym CSS przez `@starting-style`), ich odpowiedniki dla Svelte w `motion.ts` (`expand`, `rise`, `swap`, `iconSwap`, `reorder`, `stagger`, `shake`, `resizeToContent`); otwieranie wolniejsze niż zamykanie, zawartość zamykanego `Popover` / `Dialog` zostaje (inert) do końca wyjścia; `markdown/` renderuje markdown agentów z tokenów `marked` komponentami Svelte (bez `{@html}`, linki tylko http(s)/mailto, obrazy jako linki); `CopyButton` (kopiuje tekst, ikona na chwilę zmienia się w ptaszek); `code/`: podświetlanie składni (`CodeFence` — blok kodu markdown z językiem i kopiowaniem, `CodeFrame` — wspólna rama bloku kodu z nagłówkiem, `LanguagePicker` — pigułka wyboru języka, `CodeLines`, `DiffLines`, `CodeTokens`; opis niżej) |
| `lib/shared/format.ts`, `clock.svelte.ts` | liczby, czasy, JSON; zegar etykiet względnych (tyka co 30 s) |
| `features/navigation` | powłoka aplikacji: sekcje „Threads” i „Bots” (`SectionSwitch`, `sections.svelte.ts`: aktywna sekcja z trasy, Settings zachowuje ostatnią, powrót do ostatniej strony sekcji w pamięci karty); skrzynka `SidebarThreads` (projekt, status, tytuł, worker; najpierw czekające na użytkownika, potem `last_activity_at` drzewa; boczne wątki użytkownika pod otwartym drzewem, forki oznaczone; bez wierszy subagentów); wyszukiwarka, stopka ze stanem połączenia, `TopBar`, menu mobilne. Desktop: `SidebarColumn` / `SidebarLayout`, szerokość 220–560 px, najwyżej 45% okna, Mod+B i `SidebarToggle`; kolumna animuje szerokość, panel zachowuje szerokość tekstu. `AppearanceSettings.sidebar_width` / `sidebar_collapsed` zapisują się w gateway po 400 ms; powłoka podaje atrybuty, z których SPA odtwarza geometrię przed pierwszym renderem |
| `features/commands` | paleta poleceń (Mod+K): `registry.ts` (`Command`, `CommandRegistry`: źródła poleceń dodawane przez funkcje i strony, warunki `when`, podmenu `children`), `contributeCommands` (`commands.svelte.ts`: polecenia strony na czas jej życia), `app-commands.ts` (polecenia całej aplikacji), `palette.ts` (co lista pokazuje dla zapytania, podmenu, ruch klawiszami), `fuzzy.ts` (dopasowanie rozmyte z podświetleniem), `CommandPalette` / `CommandRow`; wspólny wygląd dialogów w stylu palety: `palette-style.ts`, `PaletteOption` (opcja, która nie jest poleceniem), `PaletteFooter` (legenda klawiszy) |
| `features/overview` | stan workerów, projektów i wszystkich wątków (kontekst, SSE `api/overview/events`; start i każde ponowne połączenie: `GetOverview` + jedno `ListThreads` z pustym projektem, bo strumień niesie tylko zmiany; `subscribe` przekazuje pozostałe zmiany strumienia — ustawienia, harmonogramy — a `resyncs` mówi, że po przerwie trzeba je pobrać od nowa), karta workera w ustawieniach |
| `features/projects` | Add project (`add/`: dialog w stylu palety otwierany poleceniem „Add project” i przyciskiem w Settings → Projects; kroki worker → źródło → URL → przeglądarka katalogów; `browse-path.ts`: wpisana ścieżka `~/GIT/pin` = katalog i filtr, `..` zwija się od razu; `directory-listing.svelte.ts`: katalogi workera przez trasowane `ListDirectory`, ostatnie żądanie wygrywa); gdzie biegnie nowy wątek: `placement.ts` (`defaultProject`: `?project=`, projekt twojego domyślnego workspace'u, projekt, w którym ostatnio zacząłeś wątek, pierwszy projekt na jakimś workerze, pierwszy projekt; `defaultWorkspace`: domyślny workspace — projektu nad twoim — jeśli należy do projektu, ostatnio użyty w projekcie, pierwszy na workerze online, pierwszy; „ostatnio użyty” wynika z twoich wątków głównych, nic nie jest zapisywane w przeglądarce), `ProjectPicker` (jeden wybór na wspólny origin między komputerami, jedno No project, alternatywne nazwy w szczegółach i wyszukiwaniu, link „Manage projects”), `WorkerPicker` (workery projektu ze wszystkich komputerów, dla No project wszystkie workery; grupy komputerów i rzeczywisty stan obecności; brak scratch workspace'u wyłącza wybór z wyjaśnieniem; link „Manage workers”). Workspace zachowuje oryginalny projekt domu; reguły tożsamości: [linked-computers.md](linked-computers.md#tożsamość-projektu-według-git-origin). |
| `features/threads` | `ThreadState` (snapshot + zdarzenia, `reduceItem`; komunikaty ze snapshotu, zużycie i czas tur z `ui.Turn`, odziedziczona historia forka osobno od własnych tur, tury startowane przez workera, aktywne i wstrzymane harmonogramy wątku), `timeline.ts` (granice tur, zagnieżdżenie po `parent_item_id`; niezmienione itemy zachowują swoje węzły), `feed.ts` (wiersze strony wątku: nagłówek zwiniętej historii forka, jej części i wiersze, linia „Forked from ‹źródło› · Turn N”, własna oś czasu, fold pracy na żywo, steery w drodze — tury w kolejce nie są wierszami osi czasu, pokazuje je panel kolejki; niezmienione wiersze zachowują tożsamość, więc delta przerysowuje jeden wiersz), `work-groups.ts` (domyślnie rozwinięte „Working for …” od startu, „Worked for …” po końcu; preferencje urządzenia w Settings → Threads → Turn activity; grupy narzędzi przeplatane postępem; wiadomości commentary w pracy, final_answer poza foldem; bez fazy wiadomość tymczasowo w slocie odpowiedzi, automatyczne zwinięcie dopiero na końcu), `WorkFold`, `WorkGroup`, `AnswerSlot` (stały wiersz odpowiedzi z przejściem wysokości), `WorkFolds` (preferencje i ręczny stan tury oraz grup w pamięci strony; ręczny wybór i aktywny czytelnik mają pierwszeństwo; przetrwa wirtualizację i zakończenie tury; szczegóły: [timeline-folding.md](timeline-folding.md)), `@canopy/domain/turn-origin` (wspólne z mobile; skąd przyszło wejście tury: użytkownik, zadanie albo wiadomość od agenta, raport, pytanie wątku bocznego, harmonogram twój albo agenta; z `source_kind`, `source_thread_id`, `schedule_id`, `interaction_request_id`, nie z treści; notatka platformy `[canopy] …` do pierwszej pustej linii jest oddzielona od dostarczonej wiadomości, pełny tekst pod „Full text the agent received”), `TurnInput` (wejście tury z pochodzeniem i `hops`), `FeedRowView` (wiersz osi czasu; odziedziczona historia jako zwinięta „History from …” nad turami forka; przy łańcuchu forków części podpisane wątkiem z `from_thread_id`), widoki itemów (`components/items`), karty interakcji (zgoda, pytania, formularz MCP; przy `routed_to = parent` kto odpowiada), `ComposerBox` (pole wiadomości: okrągły przycisk wysyłania / zatrzymania, „pigułki” ustawień; `canSend = false` zostawia pole edytowalne, a wstrzymuje wysłanie — powód podaje `ComposerNotice` pod polem), kompozytor wątku z wyborem modelu i wysiłku na dostawcy i profilu wątku (wybór modelu, wysiłku i uprawnień na następną turę odtwarza `Thread.last_user_turn_choices`; jawny wybór szkicu ma pierwszeństwo i idzie z wiadomością jako nadpisanie jej tury; szczegóły poniżej), steer i kolejka: w trakcie tury Enter (przycisk „Steer”) wysyła wiadomość do tury w toku (`delivery = steer`), Mod+Enter albo menu przycisku (`SteerSendButton`) dodaje ją do kolejki — z włączonym queueing (`UserSettings.composer.running_delivery = QUEUE`) odwrotnie; steer w drodze (`pending`, `accepted`) jest wierszem na końcu osi czasu, dostarczony to item `user_message` z `client_id` = id steera w turze („Steered into this turn”, `isSteerMessage`), a ten, który nie wszedł, to tura w kolejce z powodem (znacznik w panelu kolejki); gdy tura skończyła się przed wysłaniem, kompozytor mówi, że wiadomość pójdzie jako następna tura. Zadania w tle: `BackgroundTaskView` (koniec wyjścia na żywo z rozwinięciem, Stop ze stanem oczekiwania), `BackgroundTasksChip` („N running in background” nad kompozytorem, podgląd wyjścia zadania), `ThreadWorkBadges` (cel i zadania w tle w pasku bocznym); zdarzenia zadania po turze (bez `turn_id`) zostawiają item w turze, w której powstał. Tury celu mają znacznik „Goal” (`Turn.goal_id`). `TurnEnd` (stopka tury: status, czas, model i wysiłek tury z `ui.Turn.model` / `effort` nazwami z katalogu, pełne id w podpowiedzi, tryb uprawnień tury z `ui.Turn.permission_mode` — „Full auto” bursztynowo z tarczą ostrzegawczą, tury sprzed zapisu trybu bez niego — zużycie), `PermissionPicker` (pigułka trybu uprawnień pod polem, po prawej: w nowym wątku i wątku bocznym wybór szkicu — `permission-drafts.svelte.ts`, w pamięci karty, przetrwa przejście na inną stronę i powrót, znika po utworzeniu wątku; bez wyboru domyślne z Settings → Threads albo tryb wątku głównego; w kompozytorze istniejącego wątku tryb następnej tury z ostatniego wyboru użytkownika, wysyłany w `SendMessage.permission_mode`; tura w toku i steer do niej zostają przy trybie tury; „Full auto” bursztynowo z odznaką „No prompts”), `ThreadPermissionsDialog` („Permissions…” w menu akcji wątku: domyślny tryb wątku przez `UpdateThread`, od następnej tury; ostrzeżenie przy wyborze „Full auto”), `PermissionModeTitle`, `permissionLook` w `labels.ts` (ikona i kolory trybu, wspólne dla pigułki, panelu i stopki), worker pod polem z podglądem (`WorkerHoverCard`), menu akcji wątku (wątek boczny, harmonogram, „Model and effort…” — domyślne wątku przez `UpdateThread`, wysyłane tylko zmienione pola, w `ThreadModelDialog` — kopiowanie linku / katalogu / ID), `providers.ts` (dostawcy i profile dostępne na workerze), fork od tury (`fork.svelte.ts`, `fork-point.ts`, `ForkButton`: „Fork from here” w stopce zakończonej tury obok „Copy answer” — te same zasady pokazywania co Copy, na dotyku zawsze widoczny; spinner w przycisku do otwarcia nowego wątku, błąd jako toast; „Fork thread” w menu akcji i palecie od ostatniej zakończonej tury; BFF `POST /api/threads/[id]/fork { turnId }`), panel kontekstu wątku (komputer, pełna ścieżka, picker bieżącej gałęzi, kto odpowiada na zgody, harmonogramy wątku z wstrzymaniem, wznowieniem, anulowaniem i „Schedule a task”, źródło forka z numerem tury („Forked from … Turn N”), linia wątków; otwarty albo zwinięty według ustawień użytkownika), tworzenie wątków (`server/create-thread.ts`, wspólna akcja; dostawcę i profil sprawdza gateway; wątek boczny bierze projekt, workspace i dostawcę z rodzica przez `GetThread`) |
| `features/models` | `model-catalog.svelte.ts` (`ModelCatalogState`: katalog `ListModels` per worker; ziarno z loadu layoutu — brak katalogu nie psuje strony — potem `OverviewUpdate.models` ze strumienia, po przerwie `GET api/models`; `refresh(workerId)` = `POST api/models`, czeka do 100 s, błąd, np. worker offline, w stopce pickera). `catalog.ts`: `ModelOption` (dostawca, profil, id modelu, nazwa i opis z katalogu, `resolved_model`, `is_default`, obsługiwane wysiłki, domyślny wysiłek, `detail` niepełnej listy) — interfejs, którym karmione są pickery; modele profilu z katalogu workera bez `hidden`; puste `efforts` = model bez wyboru wysiłku (pigułka wysiłku znika, nic nie jest zgadywane); pusty `default_effort` = „Default” (decyduje dostawca). Tylko profil bez zgłoszonego katalogu (worker, który go nigdy nie wysłał, np. offline albo starszy) dostaje listę zastępczą: domyślny profilu, model z domyślnych, aliasy CLI, modele z wątków i zastępcze wysiłki per dostawca. `findOption` (id albo `resolved_model`, pusty = `is_default`), `threadModelOptions` (modele dostawcy i profilu wątku + jego bieżący model, także spoza listy), `modelOption` (model spoza listy: co katalog o nim wie, także ukryty, inaczej własny bez wysiłków), `turnOverride` (co wiadomość wysyła dla swojej tury); `useThreadModels` w `model-catalog.svelte.ts` (opcje wątku na żywo, dla kompozytora i dialogu). `ModelPicker` + `ModelRow` (na telefonie arkusz: szyna Ulubione, potem jedna karta na instancję dostawcy (`ModelPickerRail`; instancje jednego dostawcy mają jego znak, kropkę koloru instancji i nazwę instancji w podpowiedzi, szyna przewija się przy wielu instancjach, Góra/Dół i Home/End przełączają karty); karta instancji pokazuje tylko jej modele i jej grupę „Legacy models”; przy otwarciu aktywna jest karta instancji wybranego modelu; wyszukiwarka po nazwie, id, opisie i profilu grupuje wyniki według instancji; w Ulubionych wiersz pokazuje kropkę i nazwę instancji (`InstanceTag`), gdy dostawca ma kilka instancji; pigułka dopisuje wtedy nazwę instancji, np. `Claude Opus 5.5 · Proxy`; gwiazdka, ⌘1…⌘9 dla pierwszych ulubionych, Alt+Góra/Dół w polu wyszukiwania przełączają karty, Mod+Shift+F gwiazdkuje podświetlony, własny id modelu (instancji z bieżącej karty); stopka: niepełna lista z powodem, odświeżenie listy workera), `EffortPicker` (nazwa wysiłku, model otwierający picker, reset do domyślnego, suwak; bez wyboru pigułka pokazuje domyślny — wątku, jeśli model go przyjmuje, inaczej modelu, albo „Default”, a suwak pusty kciuk), `ModelControls` (obie pigułki razem, odświeżanie katalogu workera; także w nowym wątku bocznym), `ModelIdField` (id modelu z podpowiedziami z katalogów workerów, aliasów i wątków w ustawieniach), `favorites.ts` (ulubione w `UserSettings.model_favorites` przez `SettingsState`: od razu widoczne, błąd zapisu przywraca stan gateway; natywny profil zapisany jako `native`, bo pusty profil znaczy „dowolny”) |
| `features/goals` | cel harnessu w wątku: `goals.ts` (wygląd statusów, dozwolone akcje jak w gateway: pauza tylko aktywnego, wznowienie innego otwartego, budżet tokenów tylko Codex, iteracje jako tury Codexa albo oceny Claude, `goalPending`: „Starting… / Pausing… / Resuming…”, dopóki harness nie potwierdzi decyzji w `native_status`, `showsGoal`: pasek dla otwartego celu, osiągniętego do zamknięcia w tej karcie, nigdy dla usuniętego), `GoalBar` (nad kompozytorem: treść, status, zużycie; rozwija się w pełną treść, ostatni werdykt i `GoalStats`; pauza, wznowienie, usunięcie z potwierdzeniem), `GoalDialog` (ustawienie albo zastąpienie celu; pole budżetu tylko dla Codexa), `SetGoalPill` (pigułka „Goal” w kompozytorze, gdy nie ma otwartego celu; także „Set a goal…” w menu wątku) |
| `features/schedules` | harmonogramy: opisy terminów (typowe crony słowami), statusy, `ScheduleRow` (wiadomość, kiedy, następne uruchomienie, liczba uruchomień, wątek, kto ustawił: ty albo agent z linkiem do jego wątku), `ScheduleActions` (wstrzymaj, wznów, anuluj z potwierdzeniem), `ScheduleDialog` (jednorazowo albo cyklicznie: godzinowo, dziennie, w dni robocze, tygodniowo albo własny cron; strefa czasowa, koniec: nigdy, data albo liczba uruchomień; zachowanie po przestoju) |
| `features/bots` | boty (agenci żyjący w gateway, nie na workerach) — na razie bez backendu, tylko komponenty prezentacyjne z lokalnym modelem widoku (`@canopy/domain/bot-chat`, wspólne z mobile: `BotView`, `ParticipantView`, `ConversationView` z `pinned` i `pinOrder`, `ChatMessageView`, `ChatEventView`, `QuestionView`, `LinkView`; bez typów proto, żeby przyszły kontrakt mapował się w jednym miejscu). Awatary-maskotki wyliczane z id bota (`mascot.ts`: kształt, kolor, oczy), `AvatarStack`, przypięte czaty jako duże awatary z gwiazdką na górze sekcji (`PinnedConversations`), wiersze `BotListItem` / `GroupListItem` (przypnij/odepnij, oznacz jako przeczytane: przycisk „…”, prawy klik, Shift+F10, długie przytrzymanie), `ConversationHeader` (bot, grupa, bot ⇄ bot), oś czatu (`layoutChat` z `@canopy/domain/bot-chat`, etykiety dat w `chat-timeline.ts`: linie dat, „New” przed pierwszą nieprzeczytaną, serie wiadomości z awatarem przy ostatniej i nazwą nadawcy w grupach), `ChatBubble` (markdown botów przez bezpieczny renderer), `ChatEventLine` (rutyny, wiadomości przekazane od innych botów), `QuestionCard` (opcje A/B…, wybór klawiszem litery), `LinkChip`, `MessageActions`, `BotComposer` (załączniki i mikrofon jako „coming soon”), `WatchBar` (czytanie rozmowy dwóch botów, „Close chat”). Menu akcji to `DropdownMenu` z zestawu (`ActionItems`: akcje jako dane; menu kontekstowe kotwiczy się przez `anchorOnly` z `Popover`, więc link zachowuje swoje kliknięcie), podpowiedzi to attachment `tooltip`. Przypięcia będą ustawieniem użytkownika w gateway (nie `localStorage`). W produkcji sekcja Bots pokazuje tylko uczciwy pusty stan (`BotsSectionEmpty`) |
| `features/profiles` | profile dostawców workera (Settings → Workers → worker): `profiles.ts` (stan formularza `ProfileDraft` → `SaveProviderProfileRequest`: sekret bez zmian nie wysyła wartości, klucz „keep / replace / clear”; podpowiedzi przy polach według wspólnych reguł zmiennych z `@canopy/domain`; `withReport`: dostępność na żywo z raportu workera w overview; `initialShown` / `newSince` dla wyboru modeli; wywołania BFF), `ProfileRow` (połączenie, endpoint, zmienne, wątki, status Ready / Pending / Unavailable / Off, menu: edycja, modele per dostawca, wyłącz, usuń), `ProfileDialog` (nazwa, połączenie jako karty `KindChoice`, agenci, endpoint i klucz, `EnvVarEditor` ze zmiennymi i przełącznikiem „Secret”, „Use this profile”; pierwszy błędny element dostaje fokus), `SecretValue` (sekret zapisany: „Set” + Replace / Clear; wpisywanie: pole hasła i „Keep current”), `DeleteProfileDialog` (używany profil: wyjaśnienie i „Turn off”), `ModelSelection` (pełny katalog z wyszukiwarką, All / None dla wyników wyszukiwania, licznik, znaczniki Default / New / Hidden by Codex, „Show new models”, zapis albo „Use the default list”) |
| `features/attachments` | `draft.svelte.ts` (`AttachmentDraft`: natychmiastowy upload przez XHR, limity, postęp i blokada wysłania), `DraftTray` (miniatury i chipy z postępem, błędami i usuwaniem), `MessageAttachments`, `AttachmentChip`, `FileChip` i `AttachmentChipList` (wspólne podglądy w wiadomościach i kolejce), `AttachmentPreview` (opóźniony popover oraz modal obrazu lub tekstu), `AttachmentContent` (Markdown albo numerowane źródło), `EditorAttachmentPreview` (obsługa chipów kompozytora i edytora kolejki), `AttachmentChipCard` (metadane pozostałych plików i nieudanych uploadów), `ZoomableImage` i `Lightbox` (obraz, powiększanie, podpis, pobieranie), `SeenImage` (obraz widziany przez agenta). `ComposerBox` obsługuje upuszczanie, wklejanie i wybór plików w menu „+”. |
| `features/mentions` | wzmianki w kompozytorze: `MentionEditor` (pole tekstowe na `contenteditable`: model = tekst + zakresy wzmianek, każda zmiana przez przeglądarkę — `insertText`, `insertHTML`, `insertLineBreak` — więc cofanie, IME, sprawdzanie pisowni i klawiatury telefonów działają natywnie; wklejanie zawsze jako czysty tekst, pliki do załączników; Backspace usuwa chip w całości; wyzwalacz na początku linii albo po spacji), `editor.ts` (DOM ↔ model, wykrywanie wyzwalacza, przycinanie z przesunięciem zakresów), `caret.ts` (zaznaczenie i kursor), `kinds.ts` (wygląd chipów: ikona rodzaju albo pluginu, kolor akcentu; rejestr elementów w linii `INLINE_RENDERERS`), `MentionList` (lista popupu: grupy, ikony, opisy, dopasowane litery), `sources.svelte.ts` (`MentionSources`: katalog raz na zakres i filtr fuzzy lokalnie, pliki i wątki szukane z opóźnieniem 120 ms, spóźnione odpowiedzi odrzucane), `ComposerPlusMenu` („+”: Attach files i wyzwalacze), `MentionChip` (chip w wysłanej wiadomości). Popup to `Popover` zakotwiczony na całym polu (nad nim, jego szerokość, `t-dropdown`), fokus zostaje w tekście (`aria-activedescendant`). Dlaczego nie biblioteka edytora: jedyną bogatą treścią są chipy, a ProseMirror/Lexical to 60–150 kB. Elementy blokowe szkicu (załączniki, później cytaty) są nad tekstem w `ComposerBox` (`elements`), a nowy rodzaj w linii to nowy element unii `InlineElement` z rendererem w `INLINE_RENDERERS`. Markdown na żywo (opis niżej): `markdown.ts` (reguły: kod inline, płoty), `inline-code.ts` (DOM kodu inline, wyciszone backticki), `code-blocks.ts` + `CodeBlockField` (blok kodu w polu) |
| `features/settings`, `features/workspaces` | ustawienia jako panel modalny nad aplikacją (nawigacja z wyszukiwarką; breadcrumb strony pod sekcją: projekt albo worker; `SettingsHeading`: tytuł strony pod sekcją z opisem i akcjami), podgląd schematów kolorów; wybór katalogu na workerze (`api/workers/[id]/directory`); `ProjectWorkers` + `ProjectWorkerRow` (sekcja „Workers” ustawień projektu: każdy worker ze statusem i katalogiem projektu albo „Add”; zmiana katalogu i usunięcie z workera), `WorkspaceDirectoryDialog` (dodanie projektu do workera albo zmiana katalogu: `DirectoryPicker`, wymaga workera online), `RemoveWorkspaceDialog` (usunięcie z workera z wyjaśnieniem, że istniejące wątki działają dalej) |
| `features/settings/SettingsOverlay`, `SettingsDialog`, `SettingsBreadcrumb`, `settings-overlay.svelte.ts`, `settings-route.ts` | ustawienia nad bieżącą stroną przez `beforeNavigate`, `preloadData` (klientowe loady) i `goto(url, { shallow: true, persistState: true })`; własny `+page.svelte` z `import.meta.glob`, URL/parametry/wynik akcji z `useSettingsRoute()`, odświeżenie przez `route.refresh("app:…")`. Strona pod spodem pozostaje zamontowana (szkic, scroll, SSE), jest `inert`; fokus wraca do wyzwalacza. Jedna pozycja historii: Wstecz, Escape, X lub tło zamyka dialog; Dalej go odtwarza. Akcje `enhance` odświeżają też dane nakładki. Przy wejściu wprost SPA pokazuje dialog, po czym odtwarza stronę spod niego (`page.state.settingsOver` albo `/`). Błąd danych 5xx ma ręczne i automatyczne ponawianie co 3 s. Po wykryciu nowej wersji pierwszeństwo ma pełna nawigacja. Zagnieżdżone layouty ustawień nie są obsługiwane w nakładce |
| `features/settings/settings-state.svelte.ts` | `SettingsState`: ustawienia z gateway (przeglądarka nic nie zapisuje lokalnie). Wygląd początkowy z atrybutów powłoki, pełny stan z `GET api/settings` po pierwszym połączeniu i każdej przerwie; zmiany z innych urządzeń przez `OverviewUpdate.user_settings` / `project_settings` (nowsza wersja zastępuje). Zapis zastępuje jedną sekcję i podaje `expected_version`; zapisy idą po kolei, zmianę widać od razu i jest nakładana na stan gateway w chwili wysłania. 409: pobranie ustawień, ponowne nałożenie zmiany (raz) i komunikat, jeśli ta sekcja zmieniła się gdzie indziej; inny błąd: komunikat i stan z gateway |
| `features/settings/appearance.ts`, `thread-defaults.ts`, `ThreadDefaultsFields` | enumy wyglądu ↔ atrybuty `<html>` i tokeny pełnych palet Light / Dark ([appearance.md](appearance.md)); domyślne wartości nowego wątku: projekt nad użytkownikiem (agent — dostawca, profil, model — jako całość, workspace i uprawnienia osobno); wspólne pola dla Settings → Threads i ustawień projektu („Use my default”) |

Trasy:
- `/`: „What should we work on?”; projekt i workspace z `placement.ts`, domyślne projektu nad użytkownikiem, ręczny wybór wygrywa, `?project=` wstępnie wybiera projekt. `ProjectPicker` / `WorkerPicker` pokazują tylko właściwe powiązania. Model, profil dostawcy i wysiłek pochodzą z katalogu wybranego workera (ulubione pierwsze); niewybrany model pozostawia `CreateThread.model` puste. Projekt bez workera, worker offline lub brak agenta blokują wysłanie i wyjaśniają powód; pole pozostaje edytowalne. Bez projektów jest link do ustawień.
- `/threads/[id]`: klientowy `+page.ts` pobiera `GetThread` przez BFF (404 dla nieznanego); SSE daje snapshot i dalsze zmiany. Panel kontekstu pokazuje drzewo, cele i zadania. „New side thread” prowadzi do `/threads/[id]/new-side-thread`: kompozytor z modelem, wysiłkiem, uprawnieniami i domyślnie włączonym dziedziczeniem historii; kontekst miejsca jest tylko do odczytu. Akcja `?/createSideThread` na tej stronie pobiera rodzica przez `GetThread`, bierze z niego projekt, workspace, dostawcę i instancję oraz wywołuje wspólne `CreateThread`. [Szczegóły przepływu](threads.md#nowy-wątek-boczny-w-webie). `/settings/appearance` i `/settings/threads` edytują wygląd i domyślne nowych wątków; `/settings/schedules` pokazuje wszystkie harmonogramy, także zakończone, i pozwala je tworzyć, wstrzymywać, wznawiać i anulować.
- `/settings/projects` i `/settings/projects/[id]`: projekty, powiązania z workerami i katalogami (`?/createWorkspace`, `?/updateWorkspace`, `?/removeWorkspace`), domyślne wątków projektu i lista wątków. Stare `/projects/[id]` przekierowuje tutaj. `/settings/workers` i `/settings/workers/[id]` pokazują maszyny i linki do ich dostawców.
- `/settings/providers`: klientowy `+page.ts` pobiera instancje i pełne katalogi modeli; strona działa też w nakładce. Zakres All workers / worker, status i wersja CLI instancji, definicja (id, kolor, połączenie, runtime i zmienne), nadpisania workera, modele (filtry, ukrywanie, ulubione, własne id i tagi), logowanie, usuwanie. „Add” prowadzi przez Provider → Identity → Config (`pageSlide`). Na telefonie lista i szczegóły są osobnymi panelami.
- `/settings/proxies`: połączenia owner-scoped, szyfrowany sekret (Set / Replace), mapowania harnessów i Test connection. Instancje wybierają `proxy_id`; Move to a proxy przenosi zapisane zmienne bez ujawniania sekretu. RPC i endpointy BFF: [proxies.md](proxies.md#api-i-weryfikacja).
- `/bots` pokazuje zapowiedź bez sztucznych danych; `/bots/[id]` daje 404. `/dev/bots` to galeria komponentów, a `/dev/long-thread` to syntetyczna długa historia; obie trasy działają wyłącznie w development, chronione `import.meta.env.DEV`.

`ModelPicker` pokazuje konkretną nazwę modelu bez opisu i etykiety połączenia; instancję nazywa tylko tam, gdzie dostawca ma ich kilka (`ModelOption.sharedProvider`). Pole `legacy` katalogu przenosi starsze modele do zwijanej grupy „Legacy models” z licznikiem per instancja; wyszukiwanie i ulubione pokazują je bez zwijania. `Combobox` obsługuje takie grupy przez `groupExpanded` (brak wartości = zwykły nagłówek) i `ontogglegroup`; zwinięte opcje nie uczestniczą w nawigacji strzałkami. `ComboboxGroup` używa wspólnego `expand` i respektuje ograniczenie ruchu. Lista modeli w Settings → Providers pokazuje nazwę i id.

`features/bots/wizard` dostarcza prezentacyjne `CreateBotWizard` i `EditBotAppearance`: współdzielony podgląd maskotki, 14 kształtów, kolory i własny picker HSV/HEX, walidację nazwy oraz istniejące pickery modelu/effortu. Instancje i modele przychodzą przez props, zapis przez asynchroniczny callback. API, adapter i weryfikacja: [bots-wizard.md](bots-wizard.md).
- API (JSON): `GET api/overview`, `GET api/threads` (wszystkie wątki użytkownika), `POST api/threads/[id]/messages` (`{text, clientRequestId, model?, effort?, permissionMode?, delivery?}`; `permissionMode` = klucz enuma, tylko ta tura: model i wysiłek tylko tej tury; `delivery` = `queue` (domyślnie) albo `steer`), `POST api/threads/[id]/goal` (`{action: set | pause | resume | clear, objective?, tokenBudget?}` → `SetGoal`), `POST api/threads/[id]/background-tasks/stop` (`{itemId}` → `StopBackgroundTask`), `POST api/threads/[id]/seen` (`{upToSeq}` dziesiętnie → `MarkThreadSeen`), `POST api/threads/[id]/settings` (`{model?, effort?, permissionMode?}` → `UpdateThread`: brak = bez zmian, pusty = domyślny profilu), `GET api/models?workerId=` (ostatnie katalogi), `POST api/models` (`{workerId}`: lista od nowa z workera, 503 gdy offline), `POST .../interrupt`, `POST api/interactions/[id]` (`{allow}` albo odpowiedzi), `GET api/workers/[id]/directory?path=`, `GET api/settings`, `PUT api/settings/user` (`UpdateUserSettingsRequest`), `PUT api/settings/projects/[id]` (`UpdateProjectSettingsRequest`; konflikt wersji → 409), `GET api/schedules?threadId=&projectId=&includeFinished=true`, `POST api/schedules` (`CreateScheduleRequest`), `POST api/schedules/[id]/status` (`{status: active | paused | cancelled}`), `GET api/providers` (`ListProviderInstances`), `POST api/providers/{save,delete,workers,worker,models,refresh,login}` (odpowiednio `SaveProviderInstanceRequest`, `DeleteProviderInstanceRequest`, `SetInstanceWorkersRequest`, `SetInstanceWorkerRequest`, `SetInstanceModelsRequest`, `RefreshProvidersRequest`, `StartProviderLoginRequest`; nieaktualna wersja albo instancja w użyciu: 409), `GET api/models?unfiltered=1` (katalogi bez wyborów instancji),
- Wzmianki: `POST api/mentions/catalog`, `api/mentions/files`, `api/mentions/threads` (ciało: `ListMentionCatalogRequest`, `SearchFilesRequest`, `SearchThreadsRequest` w JSON protobuf; odczyty, POST tylko dlatego, że ciałem jest wiadomość kontraktu); `POST api/threads/[id]/messages` przyjmuje `mentions` (JSON protobuf `Mention`, najwyżej 50), formularz nowego wątku ukryte pole `mentions` (to samo jako JSON) obok `message`.
- Kolejka: `POST api/threads/[id]/queue` (`{turnIds}`, nowa kolejność), `POST api/threads/[id]/queue/[turnId]` (`{action: "edit", text, expectedRevision, mentions?}` | `{action: "delete" | "restore" | "steer"}`); wiadomość, która już ruszyła = 409 z powodem.
- Załączniki: `POST api/attachments` (surowe bajty w ciele, nazwa w `x-file-name` zakodowana URI, wymagany nagłówek `x-requested-with: canopy`, a `Origin`, jeśli jest, musi wskazywać ten host → `Attachment`), `GET api/attachments/[id]` (`?thumbnail`, `?download`, `?preview`, `?image`), `GET api/threads/[id]/blobs/[sha256]` (podgląd z transkryptu). Odpowiedzi z bajtami: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, immutable`; inline PNG, JPEG, GIF i WebP oraz SVG wyłącznie przez `?image` do elementu `<img>`. Pozostałe pliki mają `Content-Disposition: attachment` (SVG domyślnie jako `application/octet-stream`, tekst i HTML jako `text/plain`). `?preview` zwraca ograniczony prefiks do odczytu jako tekst. `POST api/threads/[id]/messages` przyjmuje `attachmentIds` (tekst może być pusty), formularz nowego wątku pola `attachmentId`.
- SSE: `api/overview/events`, `api/threads/[id]/events`. Overview po zerwaniu zaczyna od świeżego snapshotu. Watch wątku otwiera nowy `EventSource` z ostatnim atomowym kursorem kopii klienta; gateway zwraca deltę albo pełny snapshot według reguł opisanych wyżej. W `api/threads/[id]/events` BFF łączy kolejne `item_delta` tego samego itemu i pola w jedno zdarzenie (`lib/server/coalesce.ts`): wychodzi, gdy fragment niesie koniec linii, po 200 ms, przed każdą inną zmianą i na końcu strumienia; kolejność i wynik reduktora są te same co dla pojedynczych delt, scalone zdarzenie ma `seq` ostatniej delty i puste `raw_json`.

Strumieniowany tekst (wiadomość agenta, rozumowanie, wyjście komendy, narzędzia i zadania w tle) pojawia się linia po linii (`lib/shared/ui/streaming`: `LineReveal`, reguły w `line-buffer.ts`): stan trzyma pełny tekst, a widok pokazuje go do ostatniego końca linii; niepełna linia dochodzi po 300 ms od ostatniego odsłonięcia (do ostatniego pełnego słowa), a całość od razu, gdy item się kończy albo kończy się jego tura (`ThreadDirectory.turnEnded`). Nagłówek tabeli czeka na wiersz separatora, niepełny płot kodu i wiersz tabeli nie są pokazywane jako surowy markdown, otwarty płot renderuje się jako kod. Markdown jest parsowany tylko przy zmianie widocznego tekstu; `StreamingTokens` zachowuje niezależny prefiks i ponownie parsuje ostatni blok. Edycje, zmiana opcji, normalizacja CR i składnia referencji używają pełnego parsera. Niezmienione tokeny niezależnych bloków, punktów list i wierszy tabel zachowują tożsamość (`shareTokens`); późna definicja referencji wymaga odświeżenia także wcześniejszych bloków. Każdy nowy blok, punkt listy, wiersz tabeli i linia kodu (`code/CodeLines`) wchodzi raz przez `t-stream` (wyostrzenie z przenikaniem, `--duration-medium`); przy `prefers-reduced-motion` od razu. `CodeBlock` dzieli zwykłe wyjście na niezmienne grupy 32 linii, zachowując pełny tekst, zaznaczenie i przewijanie bez dodatkowego opóźnienia. Zasady i pomiary: [client-performance.md](client-performance.md#strumieniowanie-osi-czasu).

Markdown na żywo w kompozytorze (`features/mentions`): pole formatuje markdown podczas pisania, a tekst zostaje dokładnie ten sam (`value` trzyma backticki i płoty). **Kod inline**: fragment w pojedynczych backtickach w jednej linii (`markdown.ts` `codeSpans`) staje się `<code>` w chwili wpisania zamykającego backticka; backticki zostają tekstem obok, wyciszone przez CSS Custom Highlight API (bez znaczników, więc kursor i pisanie są nietknięte). Po każdej edycji linie, w których DOM nie zgadza się z tekstem (dopisany lub usunięty backtick, `<font>` / `<span style>` zostawione przez przeglądarkę), są pisane od nowa przez `insertHTML` — jeden krok cofania: Ctrl+Z najpierw zdejmuje formatowanie; samo cofanie i ponawianie nie jest formatowane. Chip, `<br>` i blok kończą fragment, więc wzmianki obok kodu działają, a wewnątrz kodu wyzwalacze się nie otwierają. **Blok kodu**: linia samego płotu (`` ``` `` albo `` ```ts ``) i Enter zamienia ją w blok (jedna edycja przeglądarki); wklejony albo przywrócony kompletny płot też jest blokiem. Blok to nieedytowalny element z kodem i językiem w atrybutach `data-*` (z nich czyta serializacja), w który montuje się `CodeBlockField`: pigułka języka (`LanguagePicker`: wyszukiwanie po nazwie i aliasach, wybór zapisuje krótki tag, np. `ts`, „Plain text” — żaden), przycisk usuwania i `<textarea>` z przezroczystym tekstem nad podświetloną kopią (`CodeLines`, leniwie i przyrostowo), więc pisanie, IME, wklejanie (dosłowne), cofanie i klawiatury telefonów są natywne. Klawisze w bloku: Enter / Shift+Enter nowa linia z wcięciem poprzedniej (nigdy nie wysyła; Mod+Enter wysyła), Tab / Shift+Tab wcięcie / cofnięcie wcięcia linii albo zaznaczonych linii (2 spacje), ArrowDown w ostatniej linii, ArrowRight na końcu, Enter w pustej ostatniej linii albo wpisany płot zamykający wychodzą pod blok, ArrowUp w pierwszej linii i ArrowLeft na początku nad blok, Backspace w pustym bloku go usuwa. W tekście: Backspace na początku linii za blokiem i ArrowUp z niej wchodzą na koniec bloku, Delete na końcu linii przed blokiem i ArrowDown z niej — na początek (przeglądarka usunęłaby go w całości albo przeskoczyła). Blok na początku pola albo zaraz za innym blokiem ma przed sobą niewidoczną linię (spacja zerowej szerokości, serializacja ją pomija): bez niej przeglądarka nie usunie elementu nieedytowalnego ani nie postawi kursora nad nim. Serializacja: blok to dokładnie ```` ```lang\nkod\n``` ```` (pusty kod: ```` ```lang\n``` ````); kod z własną linią backticków dostaje dłuższy płot. Tylko płoty, które blok zapisze z powrotem tak samo, stają się blokami (niezamknięte, `~~~`, info ze spacjami zostają tekstem), więc tekst zawsze wraca bez zmian. Kopiowanie i wycinanie z pola dają tekst wiadomości (płoty, znaczniki wzmianek). **Pogrubienie i kursywa** są formatowane na żywo w tym samym edytorze Threads i Bots (`inlineSpans`, lexer używany też przez renderer wiadomości); znaczniki pozostają edytowalnym tekstem. Listy pozostają zwykłym tekstem.

Podświetlanie składni (`lib/shared/ui/code`): Shiki (gramatyki TextMate) na silniku wyrażeń regularnych JavaScript (bez WASM), z `@shikijs/primitive` (bez hast/HTML). Język z tagu płotu albo ścieżki pliku (`languages.ts`: aliasy jak `ts`, `py`, `sh`, `yml`, `Dockerfile`); nieznany albo brak → zwykły tekst, kod inline zawsze zwykły. Highlighter (`highlighter.ts`) i każda gramatyka to osobne chunki ładowane przy pierwszym bloku, który ich potrzebuje. Motyw (`theme.ts`) mapuje zakresy gramatyk na role `--code-*` (wartości dla jasnego i ciemnego schematu w `syntax.css`), więc zmiana schematu nie tokenizuje ponownie; bez pogrubień i kursyw, by kolorowanie nie zmieniało szerokości. `Highlight` (`highlight.svelte.ts`) tokenizuje w kawałkach po ~6 ms między klatkami; linia bez kolorów renderuje się jako zwykły tekst w tym samym miejscu. `IncrementalHighlight` trzyma stan gramatyki po każdej linii: rosnący (strumieniowany) blok kontynuuje od ostatniej niezmienionej linii, a niezmienione linie zachowują obiekty i DOM. Diff (`DiffLines`, `diff.ts`) podświetla kod w języku pliku, osobno stronę nową (kontekst + dodane) i starą (kontekst + usunięte); płot ```` ```diff ```` renderuje się jako diff. Wyjście komend i narzędzi zostaje zwykłe.

**Panel kolejki** (`features/threads/queue`, [Kolejka](#kolejka)). Wiadomości czekające za turą w toku są panelem przyczepionym nad kompozytorem (ta sama powierzchnia, zaokrąglone tylko górne rogi, dolna krawędź chowa się pod kompozytorem): wiersz na wiadomość z ikoną kolejki, tekstem w jednej linii, podpowiedzią nadpisań („GPT-5.5 · High effort · Read only · 2 files”; na telefonie w menu) i akcjami — „↳ Steer” (do tury w toku teraz; tylko gdy tura trwa, nieaktywny dla wiadomości z plikami), kosz (usuwa od razu, toast z „Undo” przywraca na miejsce) i „…” (Edit message, Move to top / bottom, Turn on / off queueing; na telefonie arkusz). Kolejność: przeciąganie za uchwyt (ikona kolejki zamienia się w uchwyt po najechaniu albo fokusie, na dotyku zawsze; palcem też, `touch-action: none` tylko na uchwycie) albo Alt+↑/↓ w wierszu (↑/↓ na uchwycie), z komunikatem dla czytników ekranu; wiersze płyną na nowe miejsca (FLIP, `reorder` na `--duration-fast`), wchodzą i wychodzą `expand`, przeciągany wiersz unosi się i idzie za wskaźnikiem. Edycja jest w wierszu (Enter zapisuje, Shift+Enter nowa linia, Escape anuluje), a nie przez kompozytor: wiadomość zostaje na swoim miejscu z nadpisaniami i załącznikami (te są już związane z turą i nie dałoby się ich wysłać drugi raz). Zmiany widać od razu (`QueueState`: lokalna kolejność, ukryte usunięte i wysterowane); gateway je potwierdza, odmowa (wiadomość właśnie ruszyła) przywraca stan z gateway i mówi dlaczego w toaście. Tury wyjęte z kolejki (`Turn.withdrawn`) nie są na osi czasu, a numer „Turn N” je pomija. Usunięcie wiadomości agenta, harmonogramu albo celu nie jest możliwe (tylko kolejność).

**Cytaty na osi czasu (Cite).** Zaznaczenie tekstu wytworzonego przez agenta (odpowiedź, wcześniejsze wiadomości, rozumowanie, wejście i wynik narzędzia, wynik polecenia, blok kodu, diff) pokazuje mały przycisk „Cite” przy końcu zaznaczenia: z myszą po puszczeniu przycisku (nie w trakcie przeciągania), z klawiatury po ustaleniu się zaznaczenia, na ekranach dotykowych pod uchwytami zaznaczenia (systemowe menu zostaje nad nim). Przycisk jest w top layer (`features/quotes/CiteLayer.svelte`), więc transkrypt się nie przesuwa; `Alt+Q` cytuje bieżące zaznaczenie z klawiatury (Ctrl+Shift+C otwiera narzędzia deweloperskie przeglądarki). Cite otwiera popover „Add an optional comment…” (Enter zapisuje, Shift+Enter nowa linia, Esc anuluje, Tab krąży w środku; ten sam popover posłuży do edycji z chipa). Zapisany cytat trafia do szkicu cytatów wątku (`useQuoteDrafts()`, `quote-drafts.svelte.ts`: `list/add/edit/remove/clear/wire`, w pamięci karty) i pojawia się w kompozytorze jako chip nad tekstem, obok zasobnika załączników (`QuoteTray` w slocie `elements` `ComposerBox`): ikona cytatu, początek fragmentu, ołówek (ponownie otwiera popover komentarza; z komentarzem w kolorze marki) i usunięcie (×, także Delete/Backspace na przycisku chipa; fokus przechodzi na sąsiada). Chipy wskakują i znikają jak chipy plików (`pop`, `reorder`). Wiadomość idzie z cytatami w `SendMessage.quotes` (także steer), może składać się z samych cytatów (`elementCount` w `ComposerBox` odblokowuje wysyłanie); po udanym wysłaniu znikają tylko wysłane cytaty. Przycisk Cite trzyma się między górą feedu a górą jego lepkiej stopki (kompozytor, karty), więc przy zaznaczeniu tuż nad kompozytorem staje nad zaznaczeniem. Reguły zaznaczenia (`selection.ts`): cytat to tekst, jaki widać (wyrenderowany markdown bez `**`, kod i diff z podziałami linii i wcięciami, bez przycisków, etykiet języka i kontrolek), jedno zaznaczenie = jeden cytat i tylko wewnątrz jednego obszaru jednego itemu (`data-quote-item` na `ItemNodeView`, `data-quote-kind` na obszarach widoków); zaznaczenie przez kilka itemów, we własnych wiadomościach albo w interfejsie dookoła nie pokazuje Cite. Bańka wiadomości pokazuje cytaty (początek fragmentu na linii z lewej i komentarz pod nim); kliknięcie przewija do źródła (otwiera zwinięte „Worked for …” albo odziedziczoną historię) i na chwilę je podświetla (`data-flash`), a gdy źródła już nie ma, mówi o tym.

**Załączniki w kompozytorze i na osi czasu.** Oba kompozytory (nowy wątek i wątek) przyjmują pliki spinaczem (na telefonie systemowy wybór z aparatem, galerią i plikami), upuszczeniem na okno wątku (nakładka „Drop files to attach”, na samym polu obwódka w kolorze marki) i wklejeniem (zrzut ekranu, skopiowany obraz albo pliki z menedżera plików, także poza polem: [Wklejanie i upuszczanie plików](#wklejanie-i-upuszczanie-plików)). Każdy plik staje się plakietką w tekście ([Załączniki w tekście](#załączniki-w-tekście)): w miejscu kursora, bez kursora na końcu (menu „+” wraca do miejsca, w którym kursor był przed utratą fokusu; upuszczenie wstawia w punkcie upuszczenia), kilka plików naraz jako kilka plakietek oddzielonych spacjami. Plakietka to ten sam chip co wzmianki (`attachments/inline-chip.ts`): ikona rodzaju (obraz albo plik), nazwa ucięta do 16rem, pełna nazwa i rozmiar w podglądzie. Plik wysyła się od razu: w trakcie spinner i cienki pasek postępu w plakietce, po błędzie czerwona plakietka z ikoną alertu, a wysłanie czeka (podpowiedź przy „+”). Stan siedzi w atrybutach `data-status` / `--progress` ustawianych poza historią cofania, a ikony dzielą jedno miejsce, więc zmiana stanu nie przesuwa tekstu ani nie zmienia wysokości kompozytora. Dotknięcie plakietki obrazu otwiera Lightbox, tekstu lub Markdown modal podglądu, a pozostałego pliku albo nieudanego wysłania kartę z metadanymi i „Remove”.

Plik żyje razem z plakietką (`AttachmentDraft.place`): Backspace i Delete przy plakietce usuwają ją w całości, a z nią plik z wiadomości; „Remove” w karcie usuwa plakietkę tak samo (cofalne). Cofnij i Ponów przywracają plakietkę razem z plikiem: plik bez plakietki zostaje w szkicu, ale nie idzie z wiadomością i nie liczy się do limitów. Kopiowanie i wycinanie w kompozytorze zapisują poza tekstem także typ `application/x-canopy-chips` (tekst z chipami); wklejenie w kompozytorze przywraca chipy, a plakietkę tylko pliku z tego szkicu, który nie ma już plakietki (kopia drugi raz wkleja się jako tekst `[nazwa]`). Tacę plików nad tekstem usunięto: wszystko, czego potrzebowała (postęp, błąd, usunięcie), ma teraz plakietka. Przy wysyłaniu plakietki dostają id wgranych plików (`AttachmentDraft.wire`). Edycja wiadomości w kolejce korzysta z tego samego pola: plakietki i chipy wiadomości, Backspace i Delete usuwają plakietkę w całości, Cofnij ją przywraca, a linia pod polem mówi, które pliki opuszczą wiadomość przy zapisie („plik.txt leaves the message when you save.”). Dodawanie plików do wiadomości w kolejce nie istnieje.

#### Wklejanie i upuszczanie plików

Wklejenie przyjmuje to, co daje przeglądarka (`attachments/clipboard.ts`, `pastedFiles`): zrzuty ekranu i obrazy skopiowane z aplikacji lub przeglądarki (`image/png`), obrazy wstawione w HTML jako `data:` (gdy schowek nie ma ani pliku, ani tekstu), kilka plików naraz oraz pliki skopiowane w menedżerze plików. Chromium (więc i Electron desktopu) zamienia listę plików ze schowka systemu na pliki zdarzenia `paste` na każdym systemie: macOS `public.file-url` (ikonę Findera pomija), Windows `CF_HDROP`/`FileNameW`, Linux `text/uri-list` z URI `file://`. Renderer dostaje dostęp tylko do tych plików, które użytkownik skopiował, więc desktop nie ma własnego IPC do czytania plików ani nowej ścieżki zaufania; pliki idą zwykłym `POST api/attachments` z limitami. Menedżer plików kładzie obok plików ich nazwy lub ścieżki jako tekst: gdy każda linia tekstu to nazwa wklejanego pliku, wkleja się tylko plik. Tekst z plikami (kopia z arkusza albo dokumentu) wkleja się dalej razem z plakietkami. Przeglądarka, która zamiast plików daje tylko ich URI `file://` (np. Firefox na Linuksie), nie wkleja adresów; podpowiedź przy „+” mówi „This browser can't paste copied files. Drag them in or choose Attach files.”.

Wklejenie w dowolnym miejscu okna wątku i nowego wątku (oś czasu, nagłówek, brak fokusu) trafia do kompozytora (`attachments/file-intake.svelte.ts`, `FileIntake`): strona udostępnia go kontekstem i podpina `zone` na swoim obszarze bez sidebaru, a `ComposerBox` z `draft` rejestruje się, gdy nie jest wyłączony. Pliki bierze ostatni zarejestrowany kompozytor, który jest widoczny i nie leży w `inert` (kompozytor schowany za zgodą albo pytaniem nie bierze nic, więc wklejenie nie trafia do niewidocznego szkicu). Wklejenie w inne pole tekstowe zostaje w nim, a wklejenie bez plików nic nie robi. Czat bota korzysta z tego samego mechanizmu przez `BotImageIntake`, przyjmując wszystkie typy plików obsługiwane przez wątki. Nakładka mówi „Drop files to attach”.

Upuszczanie działa na tym samym obszarze (`FileIntake.zone`): oś czasu, nagłówek i kompozytor, bez sidebaru i panelu szczegółów. Gdy pliki spoza strony wiszą nad obszarem, `FileDropOverlay` przykrywa go przerywaną ramką w kolorze marki z etykietą „Drop files to attach”. Nakładka leży absolutnie w obszarze (`relative`), nie zajmuje miejsca i przepuszcza zdarzenia wskaźnika, więc upuszczenie na kompozytor nadal wstawia plakietki w punkcie upuszczenia; upuszczenie gdzie indziej wstawia je w miejscu kursora. Pojawia się na `--duration-fast`, znika na `--duration-quick`, a etykieta dochodzi ze skali modala (`t-drop` w `motion.css`; przy ograniczonym ruchu zostaje samo przenikanie). Nakładkę trzyma `dragover` (przychodzi co najmniej co ~350 ms), a `dragleave` chowa ją dopiero po 120 ms, więc przejścia między elementami nie migają; bez `dragleave` znika 600 ms po ostatnim `dragover`. Przeciągnięcia zaczęte na stronie (zaznaczony tekst, obrazy z osi czasu) nie pokazują nakładki; kolejka zmienia kolejność wskaźnikiem, nie przez drag and drop. Bez widocznego kompozytora nakładka się nie pojawia. Root layout (`holdFileDrops`) blokuje upuszczenie pliku poza celem na każdej stronie: przeglądarka nie otworzy pliku w miejscu aplikacji, a okno desktopu i tak nie nawiguje do `file://` (`will-navigate`).

Pliki nie zmieniają wybranego trybu wysyłania ani domyślnej preferencji: wiadomość może wejść do trwającej tury przez kompozytor albo „Steer now” w kolejce, także na mobile. Starszy worker lub dom oraz odmowa harnessu oznaczają kolejkę z rzeczywistym powodem; koniec tury oznacza następną turę. Grok ACP korzysta z kolejki, bo nie obsługuje wejścia w trakcie tury. Wiadomość użytkownika na osi czasu (także steer) pokazuje umieszczone pliki jako te same plakietki w tych samych miejscach (`AttachmentChip`: obrazy i pliki tekstowe otwierają podgląd z pobieraniem, pozostałe pliki się pobierają), a pozostałe pliki (wiadomości bez pozycji) jako miniatury i chipy pod tekstem jak dotąd; pełny tekst z notatką platformy jest zwinięty pod „Full text the agent received”. Item `image` pokazuje podgląd tego, co zobaczył model („Viewed image” dla `view_image`, „Image” dla natywnego odczytu, „Generated image”), z wymiarami oryginału, gdy obraz był zmniejszony; nieudany `view_image` pokazuje powód. Item narzędzia z obrazami w wyniku (np. `Read` Claude) pokazuje je pod wejściem.

Strona wątku przewija historię w jednym kontenerze (`VirtualFeed`): wirtualizowana oś `role="feed"` (artykuły z `aria-posinset` / `aria-setsize`). Nakładka kompozytora, gradient i „Jump to latest” są poza nim. `ResizeObserver` mierzy zamontowane wiersze, viewport i stopkę. Do pierwszego snapshotu SSE w miejscu wiadomości stoi `TimelineSkeleton`; snapshot montuje ostatnie wiersze i przypina dół przed malowaniem. Nie ma serwerowego pobrania końca wątku ani skryptu przed hydratacją. Gradient ma geometrię nakładki bez opóźnienia pomiaru. Nowe wiersze animują transform/przezroczystość; wiersze spoza widoku i dołożone na początku nie animują, a wstawione pośrodku tylko według `inserted` (`t-unfold`). Dół pozostaje przypięty podczas strumieniowania, zmiany wysokości kompozytora i otwarcia klawiatury; czytanie wyżej kotwiczy pierwszy widoczny wiersz. Klawiatura: Page Up/Down, Home/End w obszarze przewijania, Page Up/Down między artykułami, Ctrl+End do kompozytora. `/dev/long-thread` (tylko development) dostarcza syntetyczną historię i pomiary.

**Paleta poleceń i skróty klawiszowe** (`features/commands`). Mod+K (⌘K na Macu, Ctrl+K gdzie indziej) albo przycisk lupy w górnym pasku (wąskie i dotykowe ekrany) otwiera panel nad przyciemnioną stroną: wyszukiwarka „Search commands, projects, and threads…”, lista w grupach Actions, Recent threads, Projects, Settings (puste zapytanie: akcje i 8 ostatnich wątków głównych; projekty tylko w wynikach wyszukiwania), stopka z podpowiedziami klawiszy. Pisanie filtruje dopasowaniem rozmytym (znaki zapytania po kolei, premie za początek słowa i ciągłość, odrzucane dopasowania rozsiane po środku słów; każde słowo zapytania musi pasować do tytułu albo słów kluczowych — wątek znajdzie się też po projekcie, workerze i katalogu); grupy zachowują kolejność, w grupie decyduje wynik, dopasowane znaki tytułu są podświetlone, limity: 30 wątków i 10 projektów. Szukanie znajduje też wpisy podmenu oznaczonych `searchChildren` (np. „Change theme › Lagoon · Light”), ale tylko po ich własnej nazwie. Podmenu (›) otwiera się w miejscu z okruszkiem; Backspace przy pustym zapytaniu, ← albo przycisk wstecz wraca i przywraca poprzednie zapytanie. Klawisze: ↑↓ (zawijają), Home/End, PageUp/PageDown, Enter, → (wejście do podmenu), Escape zamyka; najechanie myszą podświetla, kliknięcie / dotknięcie wybiera. Wzorzec WAI-ARIA combobox + listbox (fokus zostaje w polu, `aria-activedescendant`, grupy `role="group"`, licznik wyników w `role="status"`); modalny `<dialog>` trzyma fokus, po zamknięciu wraca on do elementu, który był aktywny przed otwarciem (chyba że polecenie otworzyło inny dialog). Polecenia z `href` są prawdziwymi linkami (`<a role="option">`), więc nawigacja idzie zwykłą drogą linków (router, nowa karta z modyfikatorem). Ruch: otwarcie i zamknięcie jak dialogi zestawu (`t-modal`), zmiana poziomu podmenu wjeżdża z boku (`pageIn`, „page side-by-side”), filtrowanie bez animacji wierszy; przy `prefers-reduced-motion` tylko przenikanie.

Nowe polecenie dodaje funkcja albo strona: `contributeCommands(() => [{ id, title, group: "actions", icon, keywords, hotkey, when: () => …, run | href | children }])` — źródło czytane przy każdym listowaniu, więc może zależeć od stanu komponentu; usuwane razem z komponentem. Strona wątku dodaje w ten sposób swoje akcje.

Skróty (paleta wiąże globalnie skróty, które pokazuje; skróty z modyfikatorem działają też podczas pisania w polu, gołe klawisze tylko poza polami tekstowymi; żaden, gdy otwarty jest inny modalny dialog — poza Mod+K):

| Skrót | Działanie |
|---|---|
| Mod+K | paleta poleceń (otwiera / zamyka) |
| Mod+Shift+O | nowy wątek w bieżącym projekcie (projekt wątku, wybrany na stronie nowego wątku, inaczej domyślny); Mod+N / Mod+Shift+N należą do przeglądarki (nowe okno, okno prywatne) i strona ich nie dostaje |
| Mod+B | zwiń / rozwiń pasek boczny (poniżej `lg` otwiera szufladę nawigacji) |
| Enter / Mod+Enter (kompozytor) | wyślij lub wpleć w trwającą turę / dodaj do kolejki |

Polecenia palety: New thread in ‹bieżący projekt›, New thread in… (podmenu projektów), Toggle sidebar, Change theme (osobne palety Light / Dark, np. Lagoon · Light), Change appearance (System / Light / Dark), Chat width, Open settings, Add project (otwiera dialog Add project); na stronie wątku dodatkowo Interrupt (gdy pracuje), Side thread…, Schedule a task…, Model and effort…, Permissions…, Set / Replace the goal… (wątki workera; wyszarzone, gdy cel nie może być teraz ustawiony), Toggle thread details, Copy thread link, Copy thread id, Copy working directory (tylko w wynikach); Recent threads; projekty (podmenu: nowy wątek, ustawienia projektu, jego wątki); sekcje ustawień (Appearance, Thread defaults, Scheduled tasks, Projects, Workers).

Stany: brak gateway (powłoka renderuje się dalej, baner i ponawianie), ponowne łączenie SSE, worker offline (wątek i wiadomości czekają), wątek w tworzeniu lub nieudany, ładowanie (szkielety), puste listy. Układ od telefonu (skrzynka wątków w szufladzie, panel kontekstu jako arkusz) do desktopu (pasek boczny, czat pośrodku, panel z prawej).

Bezpieczeństwo:
- przeglądarka nie zna prywatnego adresu BFF ani tokenu usługi; enrollment/rotacja pokazują właścicielowi nowy sekret tylko raz,
- formularze chroni kontrola `Origin` SvelteKit (CSRF), a endpointy JSON wymagają `content-type: application/json` (formularz z innej strony go nie ustawi),
- workspace może wskazywać dowolny istniejący katalog absolutny dostępny dla użytkownika OS workera: połączony worker sprawdza go przy dodaniu/zmianie i ponownie przy starcie wątku. Tryby uprawnień i sandboxy nadal obowiązują per wątek ([threads.md](threads.md#projekt-na-wielu-workerach-i-systemach)).

Projekt może żyć na wielu workerach (workspace na każdym): ustawienia projektu pokazują każdy worker (system, online) z katalogiem projektu, lista wątków i nagłówek wątku pokazują workera, a wybór katalogu buduje ścieżki separatorem systemu workera. Nowego wątku nie da się wysłać na worker offline (kompozytor mówi dlaczego); istniejące wątki i ich wiadomości na workerze offline czekają na jego połączenie.

DirectoryPicker przy dodawaniu workspace'u otwiera katalog domowy workera, a przy edycji —
obecny katalog workspace'u. Pole „Directory path” przyjmuje wpisaną lub wklejoną ścieżkę;
„Go” albo Enter sprawdza ją na workerze. „Home”, „Up one level” oraz skróty do maksymalnie
czterech katalogów używanych przez projekty na tym workerze ułatwiają nawigację. Pełna ścieżka
skrótu pozostaje w tooltipie. Zapis jest dostępny dopiero po poprawnym odczytaniu katalogu;
picker nie tworzy folderów. Kontrolki korzystają ze wspólnego kitu UI.

Listy workerów nie pokazują ścieżek: kompozytor pokazuje nazwę, status i OS; ustawienia
wątków grupują opcje według projektu i podpisują je nazwą workera (także „No project”).
Harmonogramy i ustawienia botów korzystają z wyborów bez ścieżek. Szczegóły workera nie mają
edytora roots. Katalog nadal jest widoczny i edytowalny w ustawieniach projektu oraz dostępny
w pełnym, zawijanym wierszu katalogu roboczego panelu wątku, tooltipach i kopiowaniu.

Wiersz kontekstu pod polem wiadomości (`ComposerContextRow`) ma tekst 12 px, ikony
12 px i znaki projektów 16 px. Przyciski mają co najmniej 32 px wysokości, a na
telefonie i przy obsłudze dotykowej 40 px. Menu, pola tekstowe oraz wybór modelu
i wysiłku zachowują standardowe rozmiary aplikacji.

Online zdalny wątek z kopią w lustrze pokazuje ją jako pierwszy snapshot SSE z `syncing=true`.
Pasek zachowuje miejsce na ciche „Syncing…”. Dom potwierdza aktualny stan, a gateway lokalny
scala przyrost z lustrem lub odbiera pełny snapshot, jeśli kursor nie jest poprawny.
Klient dostaje następnie zwykły snapshot z `syncing=false`; identyczne itemy i tury zachowują
tożsamość, żeby wirtualizowany feed nie zmieniał kotwicy. Akcje podczas synchronizacji nadal
wykonuje dom ze sprawdzeniem właściciela i bieżącego stanu. Brak lustra zachowuje dotychczasowe
otwarcie z domu. Szczegóły: [linked-computers.md](linked-computers.md#przyrostowe-otwarcie-i-publikacja).

### Koszt aktualizacji renderera

`FeedBuilder` porównuje własne pola wierszy bez tworzenia tablic `Object.entries`
i map przy każdej delcie. Zachowuje tożsamość niezmienionych wierszy i dotychczasowe
reguły porównania danych zagnieżdżonych. Wirtualizacja nadal mierzy rzeczywistą
wysokość Markdown, kodu i diffów; nie zakłada stałej wysokości odpowiedzi.

`BotSettingsHost` pobiera edytor ustawień bota przez dynamiczny import dopiero
przy pierwszym otwarciu, równolegle z listą instancji dostawców. W czasie pobierania
działa istniejący dialog ładowania/błędu. Raz załadowany komponent zostaje dostępny
także podczas animacji zamknięcia. Zmiana bota lub zniszczenie hosta unieważnia
spóźnioną odpowiedź. Procedura pomiarowa: [client-performance.md](client-performance.md).

### Strefa czasowa użytkownika

`UserSettings.timezone` (pole **620**) to nazwa strefy IANA; brak zapisanej wartości
oznacza UTC dla botów. `UpdateUserSettingsRequest.timezone` (optional, **620**)
zmienia wyłącznie strefę i podlega `expected_version`; brak pola zachowuje wartość.
Gateway odrzuca puste, nieznane nazwy i same offsety. Strefa jest częścią JSON
w `user_settings`, więc nie wymaga migracji. Zmiany rozsyła `OverviewUpdate.user_settings`.

Web po pierwszym pełnym pobraniu ustawień porównuje je z `userTimeZone()` i przy
różnicy zapisuje strefę urządzenia istniejącą kolejką zapisów. W danym załadowaniu
aplikacji synchronizuje tylko raz; po 409 pobiera aktualną wersję i ponawia raz,
bez komunikatów konfliktu. Nie uruchamia synchronizacji ponownie po SSE ani reconnect.
Settings → General → Display pokazuje strefę tylko do odczytu jako
„Time zone: Europe/Warsaw (from this device)”. Harmonogramy wątków tworzone w web
nadal wysyłają strefę przeglądarki bez zmian.

## 5. Uruchomienie (development)

```bash
docker run -d --name canopy-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=canopy -p 127.0.0.1::5432 postgres:17
export CANOPY_DATABASE_URL=postgres://postgres:dev@127.0.0.1:<port>/canopy
export CANOPY_SECRETS_KEY=$(openssl rand -base64 32)   # trzymać stały: szyfruje sekrety w bazie
export CANOPY_UI_SERVICE_TOKEN=$(openssl rand -hex 32) # ten sam dla SvelteKit

# rejestracja workera (wypisuje worker.json; zapisać z chmod 600)
CANOPY_CLIPROXYAPI_API_KEY=... bun apps/gateway/src/cli.ts worker add --name laptop \
  --gateway-url http://127.0.0.1:7443 [--cliproxy-url https://proxy:8443]

bun apps/gateway/src/main.ts          # migracje (CANOPY_MIGRATE=1, domyślnie), serwer gRPC na :7443
CANOPY_WORKER_CONFIG=./worker.json bun apps/worker/src/main.ts
CANOPY_UI_SERVICE_TOKEN=... bun tests/integration/smoke/bff-client.ts "Reply OK"   # klient BFF do testów

# frontend
cd apps/web
GATEWAY_SERVICE_TOKEN=$CANOPY_UI_SERVICE_TOKEN bun run dev                     # http://localhost:5173
bun run build && GATEWAY_SERVICE_TOKEN=... PORT=3000 node build/index.js    # produkcyjnie
```

Załączniki idą przez BFF: `adapter-node` ma domyślnie `BODY_SIZE_LIMIT=512K`, więc w produkcji ustawiamy `BODY_SIZE_LIMIT=50M`, również dla folderu skilla 25 MiB kodowanego base64. Desktop i Docker mają już ten limit; reverse proxy musi go dopuścić.

`adapter-node` przyjmuje `https`, jeśli nie zna protokołu. Za reverse proxy ustawić `PROTOCOL_HEADER=x-forwarded-proto` (i `HOST_HEADER`, jeśli proxy zmienia host). Inaczej kontrola `Origin` odrzuci formularze. Build nie potrzebuje sekretów.

### Wydania web bez przebudowy działającego katalogu

`bun run build` zachowuje domyślne `build/`; `BUILD_DIR` zmienia katalog adapter-node. Do restartowanego stacka używać `bun run release` z `apps/web`:

```text
apps/web/releases/
  <commit>-<czas-builda>/
    index.js, adapter-node.js, server/, client/, immutable-files.json
  current -> <commit>-<czas-builda>
```

Skrypt buduje w nowym katalogu, zachowuje hashowane `_app/immutable` z poprzednich wydań, po powodzeniu atomowo zmienia symlink `current` i zostawia trzy wydania (`WEB_RELEASE_KEEP`, minimum 2). `WEB_RELEASES_DIR` zmienia katalog wydań. Każdy manifest zapisuje tylko własne assety, więc retencja nie kumuluje ich bez końca. Stary katalog `build/client/_app/immutable` też jest uwzględniany przy pierwszych wydaniach migracji.

Kopiowanie odbywa się w hooku adaptera **przed** wygenerowaniem tabeli plików statycznych adapter-node 6; późniejsze skopiowanie plików do gotowego `client/` nie wystarcza. Nie kopiujemy starych dokumentów HTML, `version.json` ani modułów serwera. Nieudany build pozostawia poprzednie `current`. Blokada `.build-lock` zapobiega równoległym wywołaniom skryptu w tym samym katalogu wydań. Nie uruchamiać jednocześnie ręcznego builda ani wydania z innym `WEB_RELEASES_DIR`: współdzielą `.svelte-kit/output`. Po przerwaniu procesu można usunąć blokadę dopiero po upewnieniu się, że żaden build już nie działa.

Zmiana dla skryptu restartu stacka:

1. Uruchomić `bun install` w repozytorium i `(cd apps/web && bun run release)`, gdy poprzednie procesy nadal działają. Przy błędzie zakończyć restart bez zatrzymywania działającego stacka.
2. Zapamiętać rzeczywistą ścieżkę nowego wydania: `web_release=$(readlink -f apps/web/releases/current)`.
3. Zatrzymać dotychczasowy web, gateway i worker po ich zapisanych PID-ach; uruchomić gateway i worker dotychczasowymi komendami i poczekać na gotowość gateway.
4. Uruchomić web z zapamiętanego katalogu, zachowując dotychczasowe zmienne proxy, origin, limity uploadu i logowanie PID-a:

   ```bash
   GATEWAY_SERVICE_TOKEN="$CANOPY_UI_SERVICE_TOKEN" \
   GATEWAY_URL=http://127.0.0.1:7443 HOST=127.0.0.1 PORT=3000 \
   BODY_SIZE_LIMIT=50M PROTOCOL_HEADER=x-forwarded-proto \
   bun "$web_release/index.js"
   ```

Symlink wybiera wydanie dla **następnego procesu**; działający serwer nadal używa własnego katalogu. Rozwiązanie symlinka raz przy uruchomieniu gwarantuje to także dla modułów ładowanych leniwie. Nie usuwać katalogu używanego przez proces i nie pozostawiać starego procesu przez więcej cykli niż okno retencji. Sam restart nadal może dać krótkie 502 na proxy; frontend odzyskuje połączenie automatycznie. Rollback: atomowo ustawić `current` na zachowane wydanie i ponownie uruchomić web z jego rzeczywistej ścieżki.

### Nowa wersja, błędy chunków i przerwy w połączeniu

`version.name` to commit + czas builda, identyczny we wszystkich fazach jednego builda. SvelteKit sprawdza `updated` co 60 s, po powrocie fokusu/widoczności i przez nagłówki odpowiedzi danych. Banner „A new version is available — Reload” oraz toast pojawiają się bez odświeżania bieżącego kompozytora. Następna nawigacja klientowa przechodzi przez pełne `location.href`; kliknięcie Reload jawnie przeładowuje stronę. Zmiana wersji ma pierwszeństwo przed nakładką ustawień.

`vite:preloadError`, odrzucone importy dynamiczne, klientowy `handleError` i błędy importu highlightera uruchamiają ten sam banner. Nie ma automatycznego reloadu przy takim błędzie, więc nie ma pętli odświeżeń ani nieoczekiwanej utraty szkicu. Starsze chunki są dostępne w oknie retencji.

`live-source.ts` sam zamyka uszkodzony EventSource i otwiera nowy z opóźnieniami 1/2/4/8/16/30 s oraz jitterem 80–100%. Reguły backoffu i zatrzaskiwania stanu są wspólne z mobile (`domain/connection-recovery`, [stany i przejścia](mobile.md#stany-połączenia-i-ponawianie)). Udane otwarcie z resynchronizacją zeruje backoff. Retry czeka w ukrytej/offline karcie; focus, widoczność, online i „Reconnect now” wznawiają je od razu z zerowym backoffem. Zdrowy strumień może działać w tle. Heartbeat ma watchdog 30 s; HTTP 200 bez ramki `ready` nie oznacza połączenia. Overview pobiera świeży stan po przerwie i buforuje równoczesne aktualizacje; wątek dostaje nowy snapshot. Status stopki otwiera popover z aktywnością w stałym wierszu i ręcznym ponowieniem. Popover pozostaje otwarty podczas retry i powrotu połączenia; baner jest nakładką bez przesuwania treści.

Pierwsza porażka, również jawne SSE `failure` i nieudana resynchronizacja, pokazuje
Reconnecting… do 3 nieudanych prób lub 12 sekund bez sukcesu. Potem status przechodzi
w Gateway unavailable i pozostaje w nim do udanej resynchronizacji; kolejna próba,
focus ani ręczne ponowienie nie cofają go do Reconnecting…. Widok błędu trasy
stosuje początkowe okno 12 s. Otwarcie SSE overview sprawdza lekkie capabilities,
zamiast powtarzać agregację; pełny overview i lista wątków mają deadline 10 sekund,
ale czytają wyłącznie lokalne rekordy, zatwierdzone lustra i cache. Żaden lokalny
odczyt nie czeka na I/O partnera. Pule HTTP/2 lokalnych i zdalnych unary oraz lokalnych i zdalnych streamów
są oddzielone. BFF loguje nazwę nieudanego RPC i czas, bez danych żądania.
Błąd RPC z `canopy-error-scope: computer` (oraz starsze `UNAVAILABLE` z końcówką
„… disconnected”) daje HTTP 409 z zakresem komputera albo SSE `away`, bez globalnej
awarii. UI zachowuje ostatnie dane, a powód pokazuje przy komputerze zgodnie z tabelą
w [linked-computers.md](linked-computers.md#obecność-i-odwołanie).

Powłoka odpowiada 200 także bez gateway; początkowy HTML zawiera szkielet z właściwym schematem i geometrią. BFF zwraca szybko 502/503 dla niedostępnego gateway, a widoki błędów tras i nakładki ponawiają dane co 3 s w widocznej karcie oraz mają Try again. Przy istniejących danych aplikacja zachowuje ostatni stan i szkic podczas ponawiania SSE. Wywołania celowo czekające na worker, np. odświeżanie modeli i logowanie dostawcy, mają osobne dłuższe deadline'y.

Ustawienia Network access, Linked computers i Devices oddzielają wynik ostatniego
żądania od stanu usługi. Początkowy błąd kończy etykiety ładowania, wskazuje
niedostępne dane i udostępnia Retry; ponawianie blokuje przycisk do zakończenia
żądania. Nieudane odświeżenie zachowuje poprzedni snapshot z ostrzeżeniem, że może
być nieaktualny. Udana odpowiedź usuwa błąd. Wspólne podsumowanie Network access
przekazuje ten sam stan również na liście workerów i w kreatorze dodawania workera.
Instrukcja włączenia sieci wymaga potwierdzonego stanu off; nie zastępuje błędu
odczytu ani błędu uruchomienia usługi. Odczyty jednego zasobu nie nakładają się,
a spóźniony odczyt nie nadpisuje wyniku udanej zmiany ustawień.
Przerwa w połączeniu zachowuje również ostatnio potwierdzone capabilities gatewaya,
aby widoku błędu odczytu nie zastępować nieuzasadnionym żądaniem aktualizacji.

### Agent environment

`GetAgentEnvironment` przyjmuje opcjonalną parę `preview_skill_id` i
`preview_skill_version`. Zwraca wskazany artefakt w `preview_skill_artifact`,
bez zmiany przypisania ani rewizji. Odczyt jest lokalny (biblioteka współdzielonej
konfiguracji), filtrowany właścicielem i ograniczony do nadal istniejącego skilla.
Brak wersji lub obcy/usunięty skill kończy się odmową; telefon nie zatwierdza
przywrócenia bez poprawnego podglądu.

Settings → Agent environment korzysta z `GetAgentEnvironment`,
`SaveInstructionDocument`, `DeleteInstructionDocument`, `SetEnvironmentTags`,
`PreviewAgentEnvironment`, `ResolveEnvironmentDrift`, `SaveLibrarySkill`,
`DeleteLibrarySkill`, `ResolveSkillDrift`, `PreviewSkillSource`, `AddSkillSource`,
`CheckSkillSource` i `ApplySkillSource`. BFF udostępnia
`/api/agent-environment` (GET/POST/DELETE), `/tags`, `/preview`, `/resolve` (POST).
Skille: `/api/agent-environment/skills` (POST/DELETE), `/skills/resolve` (POST).
Źródła: `/api/agent-environment/skills/source/{preview,add,check,apply}` (POST).
Workery innych komputerów grupy: GET `/api/workers/:id/environment` (`GetWorkerEnvironment`)
zwraca podgląd, raport, wyjątki maszyn, rewizję domu oraz wybór elementów zapisanej biblioteki.
PUT tego samego adresu (`SetWorkerEnvironmentOverride`) zmienia lub usuwa jeden wyjątek.
`WorkerEnvironmentOverride.item` jest globalnym kluczem biblioteki; `version_hash` skilla wskazuje
treść niezależnie od lokalnych numerów wersji. Plugin nie obsługuje przypinania wersji per worker.
Żądanie wymaga rewizji odczytanej z domu, a gateway po obu stronach sprawdza łącze i właściciela workera.
Preview/check mają deadline 125 s (resolver 120 s), nie zwykłe 3 s klienta BFF.
Preview zamraża commit i pliki przez 30 minut; add/apply wymagają jawnego
zatwierdzenia i bieżącej rewizji. Check zapisuje metadane kandydata i zmienia
rewizję; klient pobiera ją przed apply także przy równoczesnym odświeżeniu SSE.
Upload folderu używa base64 w JSON, więc produkcyjny web oraz proxy wymagają
`BODY_SIZE_LIMIT=50M` dla limitu 25 MiB plików. ZIP ma osobny limit 10 MiB.
Każda mutacja wymaga bieżącej `expected_revision`; konflikt daje HTTP 409 i nie
nadpisuje równoczesnej edycji. Draft preview nie zapisuje ani nie synchronizuje
treści. `OverviewUpdate.agent_environment_changed` (820) odświeża widok statusu
bez zamykania edytora. Wszystkie zasoby są filtrowane po właścicielu w gateway;
współdzielone workery pozostają poza zakresem plików globalnych. Szczegóły i limity:
[agent-environment.md](agent-environment.md).

## 6. Ograniczenia na teraz

### Przyrostowy odczyt historii botów

`WatchBotConversationRequest` i `ReadBotExchangeRequest` przyjmują opcjonalne
`incremental` (1100) oraz nieprzezroczysty `cursor` (1101). Bez opt-in odpowiedź
pozostaje pełna. Nowy klient starego gatewaya otrzymuje pełną odpowiedź bez kursora.
Kursor obejmuje właściciela (przez osobną epokę), rodzaj i identyfikator widoku oraz
rewizję trwałego dziennika kluczy `bot_view_changes`. Sam `seq` nie wystarcza:
wiadomość może zostać poprawiona, usunięta albo zmienić prezentację po błędzie tury.

Gateway czyta historię i zegar w jednej transakcji repeatable read. Delta zawiera
upserty `messages`, `removed_message_ids`, `base_cursor` i nowy `cursor`; klient
sprawdza zgodność bazy przed atomowym zastosowaniem. Usunięcia wykonuje przed
upsertami. Brak ciągłości (retencja 10 000 zmian, luka), obca epoka, inny widok lub
przeniesienie bota dają pełny stan. Autoryzacja właściciela jest sprawdzana przed
wyborem delty; kursor nigdy nie stanowi uprawnienia.

Stan sterowania rozmowy (bot i jego konfiguracja, read/unread, karty, rutyny,
przypomnienia, tekst bieżący i status) ma digest SHA-256 w kursorze. Przy zgodności
`controls_unchanged` potwierdza zachowanie tych pól; przy zmianie zastępuje je pełny
aktualny zestaw. Dotyczy to również kart z wątków lokalnych i z połączonych domów,
które mają własne źródła prawdy. Żadna karta z cache nie jest aktywna przed
potwierdzeniem bieżącej subskrypcji. Dziennik przechowuje wyłącznie identyfikatory;
nie kopiuje checkpointów modelu, konfiguracji dostawców ani sekretów connectorów.
Wymiany analogicznie potwierdzają digest konfiguracji `participants`; pole
`controls_unchanged` (1105) zachowuje ten zestaw bez ponownego przesyłania.

Zdalne boty i wymiany przekazują kursor do domu przez istniejącą trasę stage 2.
Nie zmienia to wersji łącza. Starszy dom ignoruje nowe pola i wysyła pełną historię;
offline odczyt nadal korzysta z lustra, bez prawa do wykonywania akcji.

Web utrzymuje rozmowy i wymiany w pamięci SPA, bez IndexedDB. Mobile zapisuje
`BotCachedView` (projekcję oraz kursor) w prywatnych atomowych plikach protobuf.
Oba używają wspólnego reducera, który odrzuca deltę bez dokładnej bazy; po błędzie
klient ponawia odczyt bez kursora. Osobny budżet botów wynosi 16 widoków / 32 MiB,
8 MiB na wpis; mobile ma dodatkowo 6 widoków / 16 MiB w pamięci. Odpowiedzi na
zgody wymagają live oraz pending karty w bieżącej projekcji, również w granicy
wywołania mutacji. Unpair/revocation czyści oba cache; lista botów usuwa chat i
wymiany botów niedostępnych, zarchiwizowanych albo przeniesionych.

### Preferencje General i aktualizacje

Rozwinięcie archiwum wątków/botów, szerokość i zwinięcie sidebara oraz zwinięcie
panelu szczegółów wątku należą do urządzenia (`DevicePreferences`,
`canopy:preferences:view` w profilu web/desktop). Otwarcie archiwalnego wątku rozwija
archiwum wyłącznie w tym profilu. Pierwszy odczyt inicjalizuje brakujące wartości ze
starych pól konta, kolejne zmiany konta ich nie nadpisują. Stare pola proto pozostają
dla zgodności ze starszymi klientami; nowe klienty nie zapisują do nich zmian widoku.
Synchronizacja połączonych komputerów pomija te pola, także gdy zostały w starszym
rekordzie konfiguracji. Pozostała klasyfikacja ustawień: [settings-map.md](settings-map.md).

`UserSettings.general` (900), `sidebar` (nowe pola 900–902) i `cli_updates`
(901) są zapisywane w istniejącym JSON właściciela, przez `expected_version`.
Gateway waliduje kolejność projektów oraz częstotliwości CLI (0, 60, 360, 1440,
10080 minut). `SetWorkerCliUpdateSettings` wymaga właściciela workera i aktualnej
wersji konfiguracji; brak interwału usuwa nadpisanie i przywraca domyślne konta.
Efektywna wartość trafia do `WorkerConfig.cli_update_check_minutes` (900).
Metadane workera zawierają ostatni i następny termin sprawdzenia wersji CLI.

Appearance i Diffs zapisują dodatkowe preferencje urządzenia w walidowanym
`canopy:preferences:*`. Czcionka interfejsu skaluje rem od bazowych 14 px, a rozmiar
monospace jest niezależny; terminal zachowuje wysokość wiersza zgodną z wirtualizacją.
Podglądy używają Markdown, Diff i Terminal z wątków. LaTeX renderuje KaTeX z
`trust: false`, ścisłą walidacją oraz limitami rozwinięć/rozmiaru; nie wykonuje HTML
wiadomości. Wyłączenie przywraca źródło. Preferencje diffów obejmują rzeczywiste
FileDiffEntry i bloki diff; układ na toolbarze zapisuje tę samą wartość co Diffs.
Ukrywanie whitespace pomija wyłącznie całe równoważne ciągi zastąpień; zachowuje
zmiany mieszające whitespace z treścią. Kopiowanie nadal używa oryginalnego źródła.

General przechowuje powiadomienia i format czasu w localStorage tego profilu.
Powiadomienia powstają wyłącznie z przejść na żywo istniejących wątków w strumieniu
właściciela; snapshot/reconnect nie alarmuje. Treść alertu systemowego jest stała
(bez nazwy wątku i wiadomości). Web wymaga zgody Notification API po akcji
użytkownika; desktop używa walidowanego IPC z zaufanej ramki. Częstotliwość
aktualizacji desktopu pozostaje w store main Electron, poza ustawieniami konta.

Keybindings przechowuje nadpisania w walidowanym `canopy:keybindings:v1`, per profil
przeglądarki/origin. Rejestr dekoruje komendy rzeczywistymi skrótami, zachowując
domyślne przypisania do resetowania. Zagnieżdżone komendy mają identyfikator z drogą
rodzica; osobny katalog opisuje także kompozytor, cytowanie i picker modeli.
Edytor normalizuje Mod zgodnie z platformą, wykrywa konflikty nakładających się
kontekstów i blokuje zastrzeżone skróty przeglądarki. Nagrywanie nie wykonuje komend.
Kompozytor respektuje wybrane skróty po obsłudze nawigacji edytora; bloki kodu
zachowują zwykły Enter jako nową linię.

- **Jeden użytkownik deweloperski** (`CANOPY_DEV_USER_EMAIL`). Logowanie powstanie w SvelteKit (sesja w cookie `HttpOnly`), a tożsamość użytkownika trafi do gateway w metadanych wywołania z tokenem usługi.
- **Jedna instancja gateway** (`Hub` w procesie).
- Workery dodaje kreator Settings → Workers; administracyjny `worker add` pozostaje w CLI. Instancje dostawców (globalne, włączane per worker), ich zmienne i modele są w UI.

## Wybory następnej tury

`Thread.last_user_turn_choices` zawiera model, wysiłek, tryb uprawnień i id ostatniej
własnej tury użytkownika. Gateway odczytuje je z `turns`, także poza aktualną stroną
historii. Pomija tury agentów i dostawcy, polecenia shell, odziedziczone tury forka
oraz wycofane wejścia. Dla niewysłanej jeszcze tury w kolejce rozwiązuje brakujące
nadpisania z ustawień wątku; po rozpoczęciu używa wartości zapisanych przy starcie.
Pole jest obliczane osobnym zapytaniem dla jednego wątku w snapshotach i zmianach
`WatchThread`, również przez lustro połączonego komputera. Zwykłe odczyty metadanych,
listy, overview i wyszukiwanie go nie obliczają. Obowiązuje zakres właściciela wątku.
Lustro zachowuje wybory w pełnym snapshocie, a pomija je w projekcji metadanych
używanej przez listy i nagłówki.

Kompozytory web i mobile stosują tę samą kolejność: jawny wybór w szkicu, ostatnia
tura użytkownika, ustawienia wątku, dotychczasowe domyślne. Wybór idzie z wiadomością
w `SendMessage.model`, `effort` i `permission_mode`; nie zmienia ustawień wątku.
Po restarcie lub na innym urządzeniu odtwarzany jest ostatni wysłany wybór.
Niewysłany szkic pozostaje w pamięci klienta. Brak ostatniej tury zachowuje
dotychczasowe domyślne; kompozytor nowego wątku nie zmienia zachowania.

Model usunięty lub ukryty w aktualnym katalogu ustępuje dostępnemu modelowi
z ustawień wątku, a następnie domyślnemu modelowi jego instancji. Dostawca
i instancja pozostają przypięte do wątku. Nieobsługiwany wysiłek ustępuje
domyślnemu wysiłkowi modelu albo pustemu; pigułki pokazują zastosowane wartości.
Preferencja steer/kolejka pozostaje osobnym ustawieniem użytkownika.

## Strony historii i trwałe kursory

Poniższy kontrakt wątków dotyczy starszego watcha bez `sequence`. Nowe klienty
używają niezależnych okien tur i itemów oraz `sync_cursor`, opisanych przy
`WatchThread` powyżej.

Nowy klient ustawia `page_size` w `WatchThread`, `WatchBotConversation` i
`ReadBotExchange`. Zero zachowuje pełną historię dla starszych klientów;
starszy gateway ignoruje nowe pola i nadal zwraca pełny stan. Gateway ogranicza
stronę do 100 tur lub wiadomości. Aktualne karty, kolejka, cel i konfiguracja
nagłówka pozostają kompletne, niezależnie od strony historii.

Wątki zwracają całe tury, łącznie z odziedziczonymi itemami, segmentami pracy
i stopkami. `history_before_turn_id` jest stabilną granicą następnej strony,
`history_has_more` informuje o starszej treści. Kolejne otwarcie watcha z
`before_turn_id` pobiera poprzednią stronę; klient odbiera pierwszą odpowiedź
i zamyka ten pomocniczy watch. `target_item_id` pobiera okno od tury wskazanego
itemu do końca. `history_version` identyfikuje łańcuch forków i przeniesioną
historię; niezgodna wersja lub brak granicznej tury daje świeży ogon
z `history_reset`, zamiast doklejenia obcej historii.

Przy wznowieniu głównego watcha klient przekazuje `from_turn_id` (najstarszą
załadowaną turę, włącznie) oraz `history_version`. Jeśli gateway musi zastąpić
cache pełnym snapshotem, odczytuje całe to okno do najnowszej tury, zamiast
ucinać wcześniej doładowane strony do domyślnego ogona. Nieistniejąca wskazana tura lub
zmiana wersji zwraca świeży ogon z `history_reset`.

Boty i wymiany używają `before_seq` z `history_before_seq`. Numery wiadomości
nie przesuwają się po nowej wiadomości ani edycji. Strona czyta jeden snapshot
MVCC razem z checkpointem. Przy prośbie o starszą stronę klient przekazuje
także swój kursor; luka dziennika, inna epoka lub reset historii zwracają
świeży ogon z `history_reset`. Aprobaty nie są stronicowane ani aktywowane
przez odczyt pomocniczej strony: wymagają potwierdzonego głównego watcha.

Cache utrzymuje ciągłe załadowane okno i atomowy kursor. Dołożenie starszej
strony nie przesuwa kursora głównego watcha i nie zastępuje już otrzymanych
nowszych wierszy. Delty poza załadowanym oknem są pomijane; starszą treść
klient odczyta z gatewaya, gdy do niej dojdzie. Reconnect używa dotychczasowego
kursora dziennika, a niemożliwa resynchronizacja zastępuje okno nowym ogonem.
Po zakończeniu odczytu strony klient cofa checkpoint do kursora sprzed jej
rozpoczęcia i wznawia główny watch. Dzięki temu edycja starszego wiersza, która
przyszła live podczas odczytu, zostaje powtórzona już w powiększonym oknie.
Wszystkie odczyty, granice i itemy pozostają w zakresie właściciela w gatewayu.

Web i mobile proszą domyślnie o 24 pełne tury lub 50 wiadomości. W web pomocnicze
`GET /api/threads/:id/history?before=…&version=…` i `/api/bots/:id/history?before=…&cursor=…`
zamykają watch po pierwszym stanie; wymiany używają `GET /api/bot-exchanges/:id?before=…&incremental=1&cursor=…`.
VirtualFeed kotwiczy istniejące klucze przy dołączaniu starszych wierszy; czat bota
kompensuje wzrost wysokości scrolla. Cytat do niezaładowanego itemu pobiera okno przez
`target_item_id` przed rozwinięciem folda i przewinięciem do celu.
Wyszukiwanie w wątku po wpisaniu zapytania doczytuje wcześniejsze strony aż do
początku; obejmuje wejścia użytkownika i tekst odpowiedzi agenta, także dziedziczony.
Wynik w web otwiera właściwy fold i przewija do tury lub itemu.

Zwykła przeglądarka trzyma historię tylko w pamięci SPA. Electron ma prywatny
cache na dysku przez preload ([desktop.md](desktop.md)); BFF nigdy nie
współdzieli snapshotów między sesjami właścicieli.

Kolejność tur wynika z gatewayowego `ordinal`, a elementów transkryptu z `first_seq`;
czas utworzenia ani kolejność dotarcia aktualizacji nie zmieniają pozycji.
Web wstawia turę bez itemów przed następną turą z wyższym `ordinal`, zamiast
dopisywać ją za nowszymi odpowiedziami. Zdarzenia pracy w tle zachowują kolejność
`seq`. Mobile, scalanie stron i reducer live współdzielą porządek tur; historia
przodków forka pozostaje przed własnymi turami, nawet gdy ich numery się pokrywają.
Spóźniona aktualizacja starej tury poza załadowanym oknem nie tworzy drugiego ogona.
Zużyte wejścia szyny mają `withdrawn = consumed` i nie tworzą pustego „Work — Cancelled”.

## Pliki wątku

Ścieżka pliku w wiadomości agenta jest przyciskiem: inline code, który wygląda na plik
(`out/report.md`, `C:\work\query.sql`, `~/notes.txt`, `src/app.ts:12`), oraz link Markdown do pliku
(`[raport](out/report.md)`, `file:///…`). Rozpoznawanie (`shared/ui/markdown/file-paths.ts`) wymaga
rozszerzenia; sama nazwa bez folderu musi mieć znane rozszerzenie (także obrazu). Wspólny parser
`@canopy/domain/file-references` obsługuje web i mobile. Kontekst
ustawia `provideThreadDirectory`, więc działa tylko w wątku; poza nim ścieżki zostają zwykłym kodem.

Ustawienie urządzenia **Open files in** (Settings → Interface, `fileLinks`): **Canopy** otwiera
przeglądarkę (`features/files/FileViewer.svelte`, jedna naraz, host w głównym layoucie), **Default app**
otwiera jawną ścieżkę od razu w domyślnej aplikacji, ale tylko gdy plik leży na tym komputerze (`onThisComputer`: własny gateway desktopu, wątek bez `nodeId`, worker `desktop_bundled`). Goła nazwa najpierw otwiera podgląd, aby umożliwić wybór przy wielu dopasowaniach. Plik innej maszyny zawsze otwiera się w przeglądarce, a przycisk **Open in default app** jest wtedy ukryty.

Przeglądarka czyta plik przez `GET /api/threads/:id/files?path=&itemId=` (`ReadThreadFile`, do 2 MiB).
`itemId` wskazuje turn źródłowej wiadomości dla podpowiedzi ścieżki. Goła nazwa rozstrzyga się na
domowym workerze w katalogu wątku/worktree; pojedyncze dopasowanie otwiera plik, wiele daje wybór
ścieżki. Brak dopasowania pokazuje „Couldn't find … in this workspace.” i rozwijane przeszukane ścieżki;
„moved or deleted” pojawia się dopiero przy braku ścieżki z hashem poprzedniego odczytu. Błędy transportu
pozostają błędami połączenia. Tytuł zawiera nazwę, opis ścieżkę względną i komputer; plik w korzeniu ma `./`.
Obrazy rastrowe pokazują wymiary i rozmiar z ograniczonych bajtów (bez pobierania zasobów zewnętrznych).
Nieobsługiwane binaria i błędy mają własny stan zamiast pustego pola treści. Markdown
ma widok Rendered/Source (wspólny z podglądem załączników), reszta jest podświetlona Shiki według
rozszerzenia. **Edit** ładuje CodeMirror 6 (leniwie, `features/files/code-editor.ts`): język z nazwy pliku
(`@codemirror/language-data`), kolory z tokenów `--code-*` i palety, więc edytor podąża za motywem.
Edycja pokazuje znacznik „Unsaved changes” w zarezerwowanym miejscu, `Mod+S` zapisuje
(`PUT …/files` z SHA-256 odczytu), zamknięcie z niezapisanymi zmianami pyta o porzucenie. Zmiana na dysku
od odczytu daje konflikt z akcją „Discard and reload”. **Delete file** potwierdza i usuwa z tym samym
sprawdzeniem hasha; **Open in default app** woła `POST …/files/open`. Edycja jest wyłączona dla plików
obciętych i większych niż 400 KB (limit body BFF 512 KB); dla binarnych przycisk jest ukryty.
Zapis, ponowny odczyt i usunięcie korzystają już z rozstrzygniętej ścieżki. Granice dostępu: [protocol.md](protocol.md#folder-i-pliki-wątku).
