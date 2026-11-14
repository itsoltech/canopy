# Status kont dostawców

Settings → Providers pokazuje status osobno dla instancji i workera. Workers
pokazuje te same metadane w rozwiniętej karcie maszyny. Raport dostępności
CLI pozostaje osobny: obecność loginu nie oznacza poprawnego działania
każdego modelu ani dostępności endpointu.

## Źródła i ograniczenia

| Harness | Odczyt | Dostępne metadane |
| --- | --- | --- |
| Claude | `claude auth status --json` | `loggedIn`, metoda, email, nazwa organizacji, subskrypcja, opcjonalny termin wygaśnięcia. Nieznane pola są odrzucane. |
| Codex | `codex login status` | Status w stderr i kod wyjścia; rozpoznawane ChatGPT/API key/managed credentials. Opcjonalnie działający app-server tej samej instancji: `account/read {refreshToken:false}` daje email i plan. Nie uruchamiamy kolejnego app-servera ani nie czytamy `auth.json`. |
| Grok Build 1.0.70 | brak (nic nie jest uruchamiane) | CLI ma login/logout, ale nie ma read-only auth status/whoami. Raport `unknown` bez komunikatu; przy kluczu w env pokazujemy jedynie „API key configured”. UI nie pokazuje nic poza dostępnością CLI. |
| Proxy | konfiguracja instancji | „Proxy: nazwa”, bez uruchamiania auth status i bez tożsamości konta upstream. Nie jest to test poprawności klucza ani połączenia. |

Polecenia i schematy sprawdzono w pomocy zainstalowanych CLI oraz oficjalnym
[kodzie Codex](https://github.com/openai/codex/blob/main/codex-rs/cli/src/login.rs)
i przypiętym protokole app-server w repozytorium. Nie odpytano prawdziwych
kont użytkownika w ramach badań. Wersje CLI mogą nie zwracać wszystkich
opcjonalnych danych; brak emaila, planu lub daty nie jest błędem logowania.

## Uruchomienie, cache i transport

Worker przygotowuje ten sam shadow/isolated home, źródło device login,
zmienne profilu, proxy i executable co runtime instancji. Zapytania przechodzą
przez governor (probe ≤2), mają 8 s na proces, limit 64 KiB stdout+stderr
i zabicie grupy procesów po timeout. Odpowiedź CLI nigdy nie trafia do logu.

Cache w pamięci workera: 15 min, błędy 60 s, single-flight także dla
jednoczesnych wymuszonych odświeżeń. Klucz obejmuje instancję, harness,
wykonywalny plik, argumenty, środowisko, katalog i wersję konfiguracji.
Zakończony login i pełny Refresh unieważniają cache także bez zmiany wersji
konfiguracji; nowa konfiguracja ma nowy klucz.
Zmianę loginu/logout wykonaną poza aplikacją wykrywa Refresh lub odczyt
co 15 min na aktywnym połączeniu. Timer jest usuwany po rozłączeniu;
odczyty tła mają niższy priorytet i mogą zostać odrzucone jako nieaktualne.
Brak pollingu kont na render.

Addytywna capability `provider_account_status` i nietrwała komenda
`GetProviderAccounts` nie zmieniają `WORKER_LINK_PROTOCOL`. Starsze workery
nie dostają nieznanej komendy. Gateway odpytuje po ConfigApplied oraz ręcznym
Refresh, współdzieli loty i zachowuje wyłącznie oczyszczony raport w pamięci.
Wymuszony Refresh nie współdzieli wcześniejszego odczytu z cache: czeka na jego
zakończenie, po czym wysyła nowe wymuszone zapytanie. Zbieżne wymuszone
odświeżenia tego samego zakresu nadal współdzielą jedno zapytanie.
Zmiana wersji/połączenia odrzuca stare wyniki. Lista i overview nie uruchamiają
CLI. Raport nie jest zapisywany do bazy, outboxa ani journala workera.

Każde ręczne odświeżenie weryfikuje właściciela workera i instancji w gateway.
Ten sam owner scope obowiązuje listę instancji i overview. Tokeny, klucze,
identyfikatory organizacji, surowe komunikaty błędów oraz nieznane pola nie
są częścią kontraktu; metadane są ponownie filtrowane w gateway. Znane
sekrety profilu i wartości przypominające sekrety są odrzucane z pól tekstowych.

## Login odrzucony w turze

`codex login status` czyta tylko `auth.json`: wygasły refresh token nadal daje
„Logged in using ChatGPT”, a `account/read` bez odświeżenia tokenu też tego
nie wykryje. Claude i Grok mają tę samą lukę. Prawdę zna dopiero tura, więc:

- tura zakończona błędem klasy `auth_required` (np. Codex `unauthorized`,
  „refresh token has expired”) każe gatewayowi wymusić odczyt konta tej
  instancji na tym workerze i zapamiętać w pamięci znacznik
  `worker/provider/instancja` z `login_revision` z tego odczytu;
- `login_revision` to skrót (inode, rozmiar, mtime) pliku logowania w
  `login_dir` (`auth.json`, `.credentials.json`), nigdy jego treści; worker
  liczy go przy każdym raporcie, poza cache;
- dopóki znacznik pasuje, gateway zwraca stan `expired` ze szczegółem „The
  provider rejected this login during a turn. Sign in again.”; UI pokazuje
  „Sign-in expired”, a Retry pod błędem tury jest wyłączony;
- znacznik znika, gdy zmieni się `login_revision` (nowy login z aplikacji
  albo z terminala, odświeżenie tokenu), gdy tura tej instancji na tym
  workerze się powiedzie, albo — dla loginu bez pliku (pęk kluczy macOS) — po
  ręcznym Refresh;
- proxy i klucze API nie dostają znacznika: to problem ustawień, nie logowania.

Wyniki tur jednego workera trafiają do kolejki w kolejności zdarzeń: odrzucenie, które
jeszcze czeka na wymuszony odczyt konta, wykonuje się przed późniejszym sukcesem, więc
sukces je czyści, zamiast zostać przez nie nadpisany.

Znacznik żyje w pamięci gatewaya, jak cały raport kont; po restarcie gatewaya
wraca przy następnej odrzuconej turze. `login_revision` nie trafia do klientów.

## Wiersz statusu w UI

Jedna linia: stan · metoda · plan · organizacja · email (rozmyty) · wygaśnięcie
(„expires in 3 days” przy < 7 dniach) · „checked 8 min ago”, potem ikona
Refresh. Czas sprawdzenia występuje tylko tu; blok Status instancji nie
powtarza wiersza „Checked”, gdy wiersz konta jest widoczny. „Sign in” otwiera
popover z poleceniem logowania i przyciskiem kopiowania; przy zalogowanym koncie
ten sam popover jest dostępny jako „Sign in again”, bo CLI może uznawać
odrzucony login za poprawny. Katalog konfiguracji
worker wysyła tylko dla własnego shadow home (domyślny katalog w danych workera
nie jest pokazywany); wtedy jest drugą, rozmytą linią. Brak danych z
zewnętrznego CLI (Grok, brak CLI, starszy worker) nie generuje żadnego tekstu:
wiersz jest pomijany. Szczegół pokazujemy tylko dla prawdziwych błędów
(timeout, nieobsługiwany format, nieudany odczyt).

## Prywatność podczas udostępniania ekranu

Kit `Sensitive.svelte` chroni wybrane, znane pola: email konta oraz katalog
konfiguracji (ścieżka może zawierać nazwę użytkownika). Wartość jest domyślnie
rozmyta CSS, niedostępna do zaznaczenia/kopiowania i ukryta przed czytnikiem
ekranu; przycisk ogłasza „hidden, activate to reveal”. Click/tap/Enter/Space
przełącza widoczność. Drugie użycie, 30 s, nawigacja, ukrycie karty albo
pagehide ponownie ukrywają wartość. Brak animacji respektuje reduced motion.
To osłona przed przypadkowym pokazaniem ekranu, nie szyfrowanie danych w DOM.

Pokryte miejsca:

- Providers → wybrany worker → Status instancji;
- Providers → All workers → status na każdym workerze;
- Workers → rozwinięta karta → Provider accounts;
- wspólny frontend web używany przez desktop (te same komponenty).

Audyt istniejących źródeł web/mobile/desktop nie znalazł renderowanych pól
email ani org ID: ustawienia użytkownika przechowują preferencje, konta
konektorów pokazują nazwę nadaną przez użytkownika, a urządzenia/pairing oraz
listy workerów/klientów desktop pokazują etykiety i dane maszyny. Mobile ma
własny frontend i nie pokazuje tych pól. Nie dodano skanera tekstu ani
rozmywania dowolnych nazw. Nazwa organizacji pozostaje jawna; org ID nie
jest przesyłane.

## Limity planu i dodatkowe użycie

Limity mają osobny, trwały kontrakt `ProviderUsageReport`, niezależny od statusu
logowania. Jedynym źródłem są oficjalne harnessy; Canopy nie odpytuje endpointów
rozliczeniowych ani nie czyta tokenów logowania.

- Codex: protokół app-server **0.164.0**, `account/rateLimits/read` przy starcie
  procesu i odczycie konta oraz `account/rateLimits/updated` podczas pracy.
  Czytamy okna `primary`/`secondary`, procent, reset i dostępność kredytów.
  Odczyt używa `excludeResetCreditDetails:true`; nie ustawiamy
  `supportsLunaReserve` ani nie wywołujemy komendy zużycia reset-credit.
- Claude: SDK **0.3.316**, `rate_limit_event` i oficjalne prefiksy
  `USAGE_LIMIT_ERROR_PREFIXES`, `USAGE_WARNING_PREFIXES`, `USAGE_TRANSITION_PREFIXES`.
  Pojedyncze okna zdarzeń są scalane w obrębie runtime'u. `utilization`
  zdarzenia jest ułamkiem, odczytu `/usage` procentem. Opcjonalny odczyt SDK
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` działa najwyżej raz
  na 15 min, przy inicjalizacji sesji lub odczycie konta z istniejącą sesją.
  Nie uruchamiamy modelu tylko do odczytu limitów. Nowsze zdarzenie wygrywa
  z wcześniejszym odczytem w locie; brak obsługi metody nie blokuje tury.
- Grok ACP raportuje użycie kontekstu i koszt sesji, ale nie limity konta.
  Nie zamieniamy tych danych na limity planu; UI niczego nie dopisuje.

Addytywne `WorkerMessage.provider_usage` nie zmienia `WORKER_LINK_PROTOCOL`.
Klucz obejmuje provider, profil i skrót tożsamości runtime'u wraz z CLI home.
Stary runtime podczas drain nie może przepisać danych nowego home. Snapshot
jest ponawiany po połączeniu. Niezmieniony runtime ponownie wiąże go z nową
wersją konfiguracji; zmienione konto/home wymaga nowego raportu harnessu.

Gateway zapisuje oczyszczony snapshot w `provider_usage` (migracja 0141),
osobno dla workera/providera/profilu, z kluczem konta, wersją konfiguracji i czasem
obserwacji. Zapis i odczyt filtrują właściciela workera i instancji. Starsze
raporty i inne wersje konfiguracji są odrzucane. UI dostaje zmianę konkretnego
workera w `WatchOverview`, bez ponownego pobierania wszystkich instancji.
Restart gatewaya i offline workera nie usuwają ostatniego snapshotu.
Izolowane harnessy botów i generowania tekstu przekazują zgłoszone zdarzenia
do tego samego obserwatora konta źródłowego. Nie dodają odczytów okresowych.

Settings → Providers pokazuje mierniki i czas do resetu. Composer web/desktop/mobile
ostrzega przy ≥90%, ostrzeżeniu harnessu lub wyczerpaniu okna. Po minionym
resecie stary procent nie oznacza aktualnego wyczerpania. Błąd tury zachowuje
rodzaj okna i reset w kodzie `usage_limit:<window>:<unix-seconds>`; późniejszy
raport konta nie zmienia historycznej karty. Szczegóły są w „Show details”.

### Ograniczenia informacji o kredytach

Codex `credits.hasCredits` i `unlimited` oznaczają dostępność, **nie potwierdzenie
obciążenia tury**. Po wyczerpaniu planu pokazujemy „Plan limit reached. Further
turns may use credits.”. Saldo nie opuszcza adaptera i nie jest zapisywane.
Koszt/tokeny również nie dowodzą płatnego fallbacku. Claude może potwierdzić
go przez `isUsingOverage`/`overageInUse` lub oficjalny komunikat przejścia.
Wtedy composer i ustawienia mówią „Extra usage credits are active.”, a trwały
notice tury: „This turn uses extra usage credits.”.
Sukces tury nie ukrywa notice'u rozliczeniowego jako odzyskanego błędu.
W osi wątku web/mobile pozostaje on poza zwiniętą sekcją pracy.

Sprawdzone kontrakty nie udostępniają wspieranego przełącznika zabraniającego
użycia kredytów przy rozpoczęciu tury. Nie dodajemy ustawienia „Stop when the
plan limit is reached”. Canopy nie może zagwarantować ostrzeżenia przed
obciążeniem, jeśli harness dopiero po rozpoczęciu pracy ujawnia limit/przejście.
Nie przedstawiamy dostępnego salda jako dowodu rozliczenia.

## Testy limitów

`provider-usage.test.ts` i `provider-usage-bots.test.ts` używają prawdziwego WorkerHost, gRPC, PostgreSQL oraz
fake Codex app-server / Claude CLI czytanego przez prawdziwy Agent SDK. Obejmuje
odczyt początkowy, zdarzenia, incremental overview, persystencję/restart,
owner scope, odrzucenie starej konfiguracji, mapowanie błędu i trwały notice
dodatkowego użycia. Nie wymaga prawdziwych kont ani testów live.

## Testy statusu konta

Testy adapterów używają fake CLI, bez prawdziwych kont. Obejmują odpowiedzi
Claude/Codex, brak loginu, niepoprawny format, timeout,
single-flight/cache/refresh, filtrowanie sekretów oraz to, że Grok nie
uruchamia żadnego procesu i nie zwraca komunikatu. Test gRPC używa prawdziwego
WorkerHost oraz PostgreSQL: odczyty bez spawn, zbieżne odświeżenia,
wymuszony odczyt przy wstrzymanej wcześniejszej odpowiedzi z cache, zmiana
home instancji (katalog widoczny tylko dla własnego shadow home), brak
trwałego journala, proxy bez klucza i odmowa odczytu obcego workera.
`provider-sign-in-expired.test.ts` uruchamia fake Codex app-server, którego
tura kończy się `unauthorized`: konto przechodzi w `expired` w
`ListProviderInstances` i overview, Refresh tego nie ukrywa, a logowanie z
aplikacji (device code do domu CLI urządzenia) albo udana tura je czyści.
Ten sam test sprawdza: odrzucenie czekające na odczyt konta nie nadpisuje późniejszej
udanej tury, równoczesne starty logowania dają jedno `login_id` z wynikiem w raporcie konta,
a worker platformowy odmawia logowania. `config-sync-workers.test.ts` sprawdza, że połączony
komputer nie uruchomi logowania na workerze innego komputera.
