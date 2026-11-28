# Sekrety projektów i wątków

Aktualizacja (2026-11-28): projekt może przechowywać **loginy** (konta testowe), którymi
agent loguje się w Agent Browser bez poznania hasła. Login ma listę stron, nazwę
użytkownika, hasło, opcjonalny kod jednorazowy (TOTP) i tryb zgody.
[Loginy projektu](#loginy-projektu)

Status (2026-11-28): właściciel może zapisać sekret w projekcie i przydzielać
go na żądanie poszczególnych wątków. Każdy przydział wygasa wraz z turą lub
po 15 minutach. Loginy projektu dla Agent Browser są zaimplementowane. Dostępność
w wydaniach opisują [zasady promocji](release.md).

## Sekret zapisany w projekcie

W ustawieniach projektu właściciel podaje nazwę i wartość. Gateway szyfruje
wartość kluczem `CANOPY_SECRETS_KEY` i zapisuje szyfrogram w PostgreSQL.
Odczyt ustawień zwraca nazwę oraz czas aktualizacji. Po zapisie można
wprowadzić nową wartość albo usunąć sekret. Obie operacje cofają dotychczasowe
przydziały tej nazwy. Wątek może też utracić swój przydział bez usuwania
sekretu z projektu. Potwierdzenie cofnięcia oznacza zapis decyzji w gatewayu.
Usunięcie wcześniej dostarczonego pliku jest asynchroniczne. Odłączony worker
sprząta go przy końcu tury, po upływie lokalnego terminu lub po ponownym połączeniu.

Agent wywołuje `list_project_secrets`, aby poznać dostępne nazwy, a następnie
np. `request_secret({ project_secret: "STAGING_TOKEN" })`. Gateway ustala
projekt i właściciela na podstawie bieżącego wątku. Uruchomienie wątku
na innym workerze tego samego gatewaya daje mu możliwość złożenia własnej
prośby. Żaden worker nie dostaje wartości przy starcie wątku ani przy
wyświetlaniu listy. Wątek poza projektem nie ma dostępu do sekretów projektu.

Zapis w projekcie upoważnia jego wątki do składania takich próśb bez
ponownego wpisywania wartości przez człowieka. Prywatna dostawa jest związana
z workerem, wątkiem i turą. Worker potwierdza ją po przygotowaniu pliku;
brak aktywnej tury lub gotowego filtra wyników powoduje odmowę. Wynik
narzędzia zawiera ścieżkę pliku i termin dostępności. Program uruchamiany
przez agenta może odczytać dane z pliku w zwykły sposób.

Grok otrzymuje `request_secret` przez platformowy MCP z tym samym zakresem dostępu co pozostałe harnessy. Klucz instancji CLIProxyAPI jest osobnym sekretem konfiguracji, trafia wyłącznie do env procesu Groka; plik custom-model odwołuje się do nazwy env, bez klucza. [Izolacja adaptera](grok-adapter.md#endpointy-i-izolacja).

Poświadczenia zewnętrznych aplikacji opisuje [Connectors](connectors.md).
Konta używają tego samego klucza AES-256-GCM gateway, ale ich tokeny/nagłówki
nie korzystają z dostarczania plików sekretów na worker. Worker i model dostają
wyłącznie katalog oraz zredagowane wyniki proxy. Migracja dawnych bot MCP
zachowuje istniejące odwołania do zaszyfrowanych sekretów nagłówków.

## Loginy projektu

Login projektu ma własną tabelę `project_logins` (migracja `0226_project_logins`). Gateway
sprzed loginów czyta tylko `project_secrets`, więc nie może loginu wypisać, przydzielić,
dostarczyć ani nadpisać. Loginy i sekrety mają wspólną przestrzeń nazw w projekcie. Pilnują
jej wyzwalacze `BEFORE INSERT/UPDATE OF name` na obu tabelach, z blokadą doradczą na nazwę,
także wobec starszego gatewaya. Kolumna `login` (jsonb) przechowuje dane, które agent
może poznać: strony (`websites`), nazwę użytkownika, flagę `show_username`, notatkę, tryb
`ask_each_time`, zgodę `outside_browser` i informację, czy login ma kod jednorazowy. Hasło
i klucz konfiguracji TOTP są w szyfrogramie (AES-256-GCM, `CANOPY_SECRETS_KEY`) jako JSON.
Zapis przez `PutProjectLogin` bez hasła albo klucza zachowuje zapisane wartości; pusty
klucz usuwa kod jednorazowy. API nigdy nie zwraca hasła ani klucza. Każda zmiana loginu
cofa jego przydziały i zgody w trwających turach.

Strona to origin (schemat, host, port, najwyżej 300 znaków). Wklejony adres strony zostaje
skrócony do originu. `https://*.example.com` pasuje do subdomen, ale nie do samej domeny.
Wspólne reguły są w `@canopy/domain/project-logins`; kody TOTP (RFC 6238, SHA-1/256/512,
6–8 cyfr, okres 10–300 s) liczy `@canopy/domain/one-time-codes` przez Web Crypto.

### Użycie przez agenta

`list_project_secrets` zwraca nazwy zwykłych sekretów oraz listę `logins` z danymi
z kolumny `login`. Ukryta nazwa użytkownika ma wartość `hidden`. Agent loguje się
narzędziami Agent Browser:

- `agent_browser_fill_login({login, username?, password?, submit?})`: pola to refy
  ze snapshotu albo selektory CSS;
- `agent_browser_fill_one_time_code({login, field, submit?})`: wpisuje bieżący kod,
  a gdy do końca okresu zostały mniej niż 3 sekundy, najpierw czeka na następny;
- `agent_browser_open_with_basic_auth({url, login})`: Basic Auth z loginu zamiast
  ręcznego sekretu.

Narzędzia nie przyjmują ani nie zwracają wartości. Bridge na workerze sam prosi gateway
o przydział wewnętrznym wywołaniem `lease_project_login` (poza katalogiem narzędzi
harnessu). Wywołanie podaje identyfikator autoryzacji bieżącego wywołania narzędzia
(`authorize_local_automation`). Gateway przyjmuje je tylko wtedy, gdy ta autoryzacja
jest żywa na tym samym połączeniu workera, należy do tego wątku i tury i dotyczy jednego
z trzech narzędzi powyżej z argumentem `login` o tej samej nazwie. Zakończenie wywołania
narzędzia ją unieważnia. Gateway sprawdza też właściciela, projekt wątku, aktywną turę
i origin strony, a potem tworzy przydział `memory_only`. Wartość trafia do workera prywatnym
`ThreadSecretDelivery` z `memory_only` i zostaje w jego pamięci: worker nie tworzy pliku,
więc shell agenta nie ma czego przeczytać. Przydział trwa najwyżej do końca tury
(i 15 minut); kolejne wywołanie w turze otwiera nowy, więc agent niczego nie odnawia.
Przydział w pamięci nie czeka na filtr wyników harnessu, bo wartość nie trafia do jego
plików ani środowiska. Wymaga tylko aktywnej, nieodgrodzonej tury. Jeśli wywołanie
narzędzia skończy się, zanim właściciel odpowie, gateway nie otwiera przydziału
(wynik `expired`); zgoda zostaje dla następnego wywołania w tej turze. Przydział pamięta
też swoją autoryzację (`project_secret_leases.admission`). Gateway sprawdza ją jeszcze raz,
gdy wyjmuje wartość z kolejki dostaw, a jeśli wywołanie już się skończyło, cofa przydział
bez wysyłania wartości.

Bez zgody `outside_browser` `request_secret` odmawia loginu. Ze zgodą zwraca plik JSON
z `username`, `password`, `websites`, `hide_username` i opcjonalnym `one_time_code_setup`.
Dostawa takiego pliku ma flagę `login`, więc worker przed potwierdzeniem rejestruje
w filtrach także hasło, jego postacie po kodowaniu, ukrytą nazwę użytkownika i klucz TOTP,
a nie tylko cały JSON. Worker bez `project_logins_v1` nie dostanie pliku loginu.

Przed wpisaniem bridge liczy wartość (kod TOTP najpierw), klika pole przez agent-browser,
a potem przez CDP znajduje aktywny element. Ramki śledzi worker, nie skrypt strony: ramkę
w tym samym procesie przez `DOM.describeNode` (`contentDocument`) i `DOM.resolveNode`,
ramkę z innego procesu przez `Target.attachToTarget` z jej `frameId`. Origin pola to
`securityOrigin` jego ramki z `Page.getFrameTree`, czyli wartość z przeglądarki, której
strona nie zmieni. Pole musi być edytowalne, a origin musi należeć do stron loginu.
Wartość trafia wtedy do tego konkretnego elementu przez `Runtime.callFunctionOn` (natywny
setter `value` oraz zdarzenia `input` i `change`; dla `contenteditable` `insertText`).
Nie zależy od tego, gdzie jest fokus w chwili zapisu. Jeśli element opuścił dokument albo
ramka przeszła na inną stronę, zapis się nie udaje i agent dostaje prośbę o nowy snapshot.
Wartość nie przechodzi przez argumenty MCP, linię poleceń ani proces agent-browser.

### Zgoda właściciela

Gateway zapisuje decyzję w `project_login_decisions`: jedna na turę, login i rodzaj dostępu
(`browser` albo `file`, unikalne `(turn_id, name, access)`), więc równoległe prośby dzielą
jedno pytanie. Login bez trybu **Ask each time** dostaje od razu `allowed`, a z trybem
czeka jako `pending`. Wątek pokazuje kartę „Use login …?” albo, dla pliku, „Give login …
to the agent’s commands?” z przyciskami **Allow for this turn** i **Decline** (web i mobile;
`AnswerThreadSecret` z `decline`; `ThreadSecret.access`). Zgoda na plik nie obejmuje
przeglądarki i odwrotnie. Przydziały powstają dopiero po zgodzie, więc nic nie trafia do
workera wcześniej. Decyzja trwa do końca tury, niezależnie od 15-minutowych przydziałów
i ponownych połączeń workera. Koniec tury, zmiana loginu, archiwizacja wątku albo projektu
ją wygaszają. Panel wątku pokazuje decyzję jako login „this turn”; cofnięcie
(`revoke`) cofa też przydziały tej tury.

Przy przeglądarce gateway czeka na odpowiedź do 45 sekund, krócej niż limit wywołania
narzędzia MCP w harnessach. Przy pliku czeka w ramach 8-sekundowego limitu
`request_secret`. Potem narzędzie odpowiada agentowi, że czeka na właściciela, a ponowne
wywołanie dołącza do tej samej decyzji. Odmowa zostaje do końca tury.

### Maskowanie i strażnik sieci

Po wpisaniu wartość zostaje w DOM strony, więc agent może ją odczytać przez `eval`,
snapshot albo tekst strony. Canopy nie blokuje tych narzędzi. Maskuje wartości we
wszystkich tekstowych wynikach Agent Browser tej sesji, w dzienniku i w filtrach harnessów
(`[REDACTED]`). Maskowane są: hasło, jego postacie po kodowaniu URL i base64, base64 pary
`username:password`, klucz TOTP i ukryta nazwa użytkownika. Maskowanie wpisanych wartości
trwa po zakończeniu przydziału, bo strona może je nadal przechowywać. Wartości z przeglądarki
worker trzyma osobno dla wątku (nie w globalnej liście ręcznych sekretów), więc maskowanie
i wstrzymywanie strumienia nie dotyka innych wątków. Zamknięcie sesji przeglądarki albo
wątku przenosi je do osobnego zbioru, który znika po 30 sekundach, gdy dojdą już wyniki
w drodze. Nowa sesja tego wątku ma własny zbiór i tego terminu nie przesuwa.

Wynik strukturalny maskuje także liczbę JSON, której zapis zawiera wartość (hasło z samych
cyfr).

Przed zrzutem ekranu lub PDF (`agent_browser_screenshot`, `agent_browser_pdf`) bridge
ukrywa (`-webkit-text-security: disc`) pola zawierające wpisaną wartość. Robi to we
wszystkich kartach sesji (zrzut obejmuje aktywną, która może się zmienić), w każdej
ramce, w jej izolowanym świecie, także w ramkach z innego procesu (przez ich własne
cele, `Target.setAutoAttach`). Treści pól czyta partiami, a porównuje worker, więc wartości
nie trafiają do strony. Strona z ponad 20 000 pól albo błąd w którejkolwiek ramce sprawia,
że zrzut nie powstaje, a agent dostaje prośbę o ponowienie. Przed ukryciem bridge zapisuje
dokumenty ramek karty (`frameId:loaderId`). Jeśli po zrzucie są inne (nawigacja, przeładowanie,
nowa ramka), odrzuca wynik i prosi o nowy zrzut. Pole, które strona doda w trakcie (np. ponownie
zamontowany formularz bez nawigacji, także w otwartym shadow root komponentu), obserwator
mutacji w izolowanym świecie ukrywa przed najbliższym odświeżeniem obrazu. Pole
`contenteditable` jest ukrywane razem z elementami w środku, bo to one rysują tekst i mogą
mieć własny styl. Sprawdzenie po zrzucie ma limit 10 s; zrzut, którego nie da się sprawdzić,
jest odrzucany. Po zrzucie bridge sprawdza każde pole ramki i każde dodane:
pole z wpisaną wartością bez kropek odrzuca zrzut. Plik zrzutu powstaje najpierw w prywatnym katalogu tymczasowym (`path` narzędzia
wskazuje tam), a do ścieżki wybranej przez agenta, `screenshotDir` albo domyślnego katalogu
trafia dopiero po tych sprawdzeniach. Odrzucony zrzut jest usuwany. Każda ramka rejestruje przywrócenie,
zanim zmieni pola, a po przekroczeniu 10 s ukrywanie się zatrzymuje. Styl wraca po zrzucie,
także gdy wywołanie zostało przerwane. Wpisanie i nawigacja z Preview (adres, wstecz, dalej,
przeładowanie, karta) czekają w tej samej kolejce sesji co narzędzia agenta
(`browserSessionQueue`), a stan sesji Preview odczytuje dopiero w tej kolejce. Tekst poza polami nie jest
ukrywany.

Strażnik sieci (`BrowserLeakGuard`) łączy się z Chrome sesji wątku i automatycznie dołącza
do każdej strony, ramki i workera. Na każdym z nich włącza `Fetch`. Wpisanie czeka, aż
przechwytywanie działa na karcie i na ramce pola. Jeśli nie działa, nic nie zostaje
wpisane, a agent dostaje prośbę o ponowienie. Basic Auth z loginu najpierw uruchamia
Chrome, potem czeka na strażnika, a dopiero potem przekazuje dane. Strażnik wstrzymuje
żądania (`Fetch.requestPaused`) i sprawdza URL, nagłówki oraz treść. Żądanie zawierające
wartość loginu do originu spoza jego stron jest odrzucane (`BlockedByClient`). Kolejny wynik
narzędzia informuje o tym agenta, z zamaskowanym adresem. Pozostałe żądania przechodzą bez
zmian. Strażnik pamięta każdą wpisaną wartość do końca sesji przeglądarki, także po zmianie
hasła albo kolejnym wpisaniu. Kody jednorazowe pilnuje do minuty po ich wygaśnięciu.
Treść JSON do 1 MiB dekoduje i sprawdza każdy ciąg, więc wartość nie ukryje się za
żadnym sposobem escapowania; dodatkowo zna postacie ciągu JSON z `\/` i `\uXXXX`. Zerwanie połączenia wznawia wstrzymane żądania, a strażnik ponawia
połączenie z rosnącą przerwą (do 10 s), dopóki Chrome sesji działa. Adres Chrome bierze
z poleceń agent-browser tej sesji, niezależnych od podglądu czy bridge'a. Zamknięcie sesji
(`agent_browser_close`, zamknięcie wątku) czyści stan strażnika i maskowania sesji. Przy
zamknięciu wątku sesja ze znacznikiem musi mieć potwierdzone zamknięcie przeglądarki
(`closeBrowserSession`); inaczej stan i znacznik zostają. Bridge
i Preview za każdym razem odczytują bieżący stan sesji, więc po zamknięciu i ponownym
otwarciu przeglądarki dzielą ten sam stan.

Chrome sesji może przeżyć restart workera, a stan maskowania nie. Dlatego przy pierwszym
zabezpieczeniu wartości worker zapisuje znacznik sesji (skrót nazwy, bez wartości)
w `browser-logins/` w katalogu danych. Gdy po restarcie bridge albo Preview pierwszy raz
sięga po sesję ze znacznikiem, a worker nie ma jej stanu, najpierw zamyka jej przeglądarkę.
Znacznik znika dopiero wtedy, gdy agent-browser potwierdzi, że sesja nie ma przeglądarki;
inaczej wywołanie kończy się błędem. Znacznik zawiera nazwę sesji (identyfikator wątku),
więc przy zwykłym zamknięciu worker zamyka wszystkie takie przeglądarki, póki strażnik
jeszcze działa, a przy starcie po awarii zamyka te, których stanu nie ma. Każdą sesję zamyka
osobno, w kolejce tej sesji, tej samej co wywołania agenta i Preview (`closeBrowserSession`): agent-browser musi potwierdzić `closed: true`, a lista sesji
nie może jej już zawierać. Bez dostępnego agent-browser albo bez potwierdzenia znacznik
zostaje do następnej próby, a pozostałe sesje i tak są zamykane. Preview, które otwiera sesję przed bridge'em, dostaje
maskowanie wątku od razu (sesja nosi identyfikator wątku). Strażnik nie widzi ruchu WebSocket ani dużych treści żądań, których
Chrome nie przekazuje w zdarzeniu. Nie rozpozna też wartości zaszyfrowanej albo przesłanej
w częściach przez skrypt strony. Program, który odczyta wartość ze strony, może zachować
własną kopię.

### Wpisanie przez właściciela w Preview

Browser Preview ma menu **Fill login** z loginami, które pasują do originu otwartej strony.
Klient wysyła wejście `login` (nazwa i pole: `username`, `password`, `one_time_code`),
najwyżej jedno w partii. Gateway sprawdza, czy login należy do projektu wątku, i zastępuje
je wejściem `login-text` z polem `AgentPreviewInput.login` (`AgentPreviewLogin`: nazwa,
wartość, strony, `masked`, pole i czas wygaśnięcia kodu). Wartość idzie tylko po linku
workera, bez dziennika. Worker ogranicza ją limitami loginu (`LOGIN_PREVIEW_TEXT_MAX_BYTES`, 20 stron po 300 znaków),
a nie limitem tekstu klawiatury. Wpisuje ją tak samo jak agent: do pola z fokusem, gdy
`securityOrigin` jego ramki należy do stron loginu, przez CDP i z działającym strażnikiem.
Ukrytą wartość rejestruje w maskowaniu i strażniku sesji, widocznej nazwy użytkownika nie
rejestruje, a kod jednorazowy pilnuje do jego wygaśnięcia i minutę dłużej. Kod, który wygasł
(albo wygasa w ciągu sekundy), zanim wpisanie doczekało się w kolejce, nie jest wpisywany:
właściciel dostaje prośbę o ponowny wybór z menu.
Tryb zgody nie dotyczy tej akcji, bo wykonuje ją właściciel. Projekt połączonego komputera
nie ma tego menu.

### Weryfikacja loginów

- `tests/integration/project-logins.test.ts`: zapis tylko do odczytu i zachowanie hasła
  przy edycji, szyfrogram w `project_logins`, konflikt nazw (także zapis z pominięciem
  gatewaya), lista dla agenta bez wartości, przydział tylko dla stron loginu i tylko
  z żywą autoryzacją narzędzia nazywającego ten login, dostawa `memory_only`, odmowa
  `request_secret`, jedno pytanie dla równoległych prób, zgoda i odmowa na całą turę oraz
  osobna zgoda na plik loginu z `ask_each_time` i `outside_browser`, a także zgoda, która
  przyszła po zakończeniu wywołania narzędzia.
- `tests/integration/project-login-preview.test.ts`: wpisanie w Preview zastępuje nazwę
  wartością tylko dla loginu z projektu wątku, najdłuższe hasło przechodzi walidator
  workera, dwa loginy w jednej partii są odrzucane.
- `apps/worker/src/runtime/project-login-memory.test.ts`: przydział bez pliku i bez filtra
  harnessu, odczyt tylko w swojej turze, maskowanie wariantów i po zakończeniu tury,
  maskowanie części pliku loginu.
- `browser-logins.live.test.ts` (`CANOPY_LIVE=1`, `CANOPY_LIVE_BROWSER`): prawdziwy
  agent-browser wpisuje login i kod, maskuje wynik `eval`, blokuje wysłanie hasła do obcego
  serwera (w adresie i w treści JSON) i przepuszcza żądanie do własnej strony. Odrzuca login
  na obcej stronie i w ramce innej witryny (osobny proces), także przy wpisaniu w Preview,
  ukrywa wpisane wartości przed zrzutem w stronie i w tej ramce, zamyka po „restarcie”
  przeglądarkę sesji ze znacznikiem i wykonuje Basic Auth z loginu. Hasło zawiera cudzysłów,
  ukośniki i znak spoza ASCII, a żądanie JSON z escapowaniem `\/` i `\uXXXX` nie dociera
  do obcego serwera.

## Jednorazowa prośba do użytkownika

W trybie prośby do użytkownika `request_secret` przyjmuje `label`,
`description`, opcjonalny `placeholder`, `name` (podpowiedź nazwy zmiennej,
bez automatycznego eksportowania środowiska) i `request_id` do odnawiania
oczekiwania. Trwały request należy wyłącznie do wywołującego wątku.
Ograniczone oczekiwanie można ponawiać; restart nie usuwa pytania.

Karta znajduje się nad composerem, w istniejącym stosie paneli. Użytkownik widzi
oczekujące działanie bez szukania w przewijanej osi czasu. Wartość istnieje tylko
w pamięci kontrolki i żądania HTTPS BFF → gateway. Nie zapisujemy jej w draftach,
localStorage, wiadomościach, interakcjach `ask_user`, notatkach, wynikach narzędzi
ani zdarzeniach. Po zapisie karta pokazuje termin dostępności i cofnięcie dostępu.
Stan kontrolki jest czyszczony po wysłaniu i przy opuszczeniu karty.

Gateway szyfruje wartość AES-256-GCM istniejącym `CANOPY_SECRETS_KEY`. Do workera
przechodzi osobnym komunikatem istniejącego połączenia gRPC, poza trwałym outboxem
komend i dziennikiem zdarzeń. Worker zapisuje plik `0600` w katalogu `0700` poza
workspace. Model otrzymuje tylko ścieżkę, termin i instrukcję użycia wewnątrz
komendy, np. `TOKEN="$(cat '<path>')" program`, bez drukowania wartości.
Nie dodajemy sekretu do env procesu harnessu (wspólnego dla wielu wątków).

Domyślny TTL ręcznie dostarczonego sekretu to 24 godziny. Cofnięcie/wygaśnięcie usuwa szyfrogram z gateway
i plik workera; odłączony worker nie może otrzymać cofnięcia natychmiast, dlatego
lokalnie egzekwuje również termin. Ponowne połączenie synchronizuje stan.
Po restarcie worker usuwa stare materializacje i odtwarza wyłącznie nadal ważne.
Nie da się cofnąć kopii wykonanej już przez uruchomioną komendę ani wyczyścić
wartości z pamięci obcego procesu.

Wątki boczne i forki nie dziedziczą przydziałów ani automatycznego dostarczenia.
Agent w nowym wątku prosi ponownie. Prawa POSIX izolują od innych użytkowników
systemu, nie od procesów tego samego użytkownika: dedykowany użytkownik workera
pozostaje granicą zaufania. Znajomość ścieżki nie jest silną izolacją między
wrogimi agentami mającymi pełny shell na tym samym koncie.
Fork dziedziczący transkrypt providera może poznać samą ścieżkę z wcześniejszego
wyniku narzędzia. Gateway nie daje mu przydziału, ale wspólny UID nie uniemożliwia
samodzielnego odczytu znanej ścieżki przez shell. Silna izolacja wymagałaby osobnych
użytkowników lub przestrzeni plików dla wątków; obecna architektura tego nie zapewnia.

Migracja: `0036_thread_secrets`. Pola istniejących wiadomości proto korzystają
z zakresu `500–519`.

## Kontrakt i trwałość

`request_secret` jest dostępne jako dynamiczne narzędzie Codex oraz
`mcp__canopy__request_secret` serwera MCP Claude. Wywołanie czeka do 120 sekund.
Jeżeli człowiek lub worker nadal nie odpowiedział, zwraca `status: pending`
i `request_id`. Agent odnawia oczekiwanie tym identyfikatorem. Ponowiona prośba
o tę samą etykietę w tym samym wątku dołącza do istniejącego oczekiwania.
Żądanie, decyzja i zaszyfrowana wartość są w PostgreSQL; wynik `saved` pojawia się
dopiero po potwierdzeniu zapisu pliku przez właściwego workera.

Przykładowy wynik: `{status: "saved", request_id, file, expires_at, name?, instructions}`.
Inne stany: `pending`, `declined`, `revoked`, `expired`. Odmowa nie tworzy pliku.
Odpowiedź API jest zapisem jednokierunkowym: nie istnieje endpoint odczytu wartości.
Ponowiony zapis nie nadpisuje zaakceptowanego sekretu. Gateway sprawdza właściciela
wątku; agent nie może odnowić requestu innego wątku. Rozmiar wartości to 1–32768
bajtów UTF-8, bez NUL. Nazwa jest wyłącznie podpowiedzią zgodną z nazwą env.

Gateway co sekundę usuwa wygasłe szyfrogramy właściciela w partiach do 256,
także przy archiwizacji lub usunięciu wątku. Duża zaległość wymaga kilku przebiegów;
odczyt wyniku już po TTL zwraca `expired`. Lokalny timer workera egzekwuje expiry
również po utracie połączenia.
Jeżeli sam proces workera nie działa, sprzątanie plików następuje przy jego
ponownym uruchomieniu; nie ma osobnego demona usuwającego je w czasie awarii.
Revoke zeruje szyfrogram od razu i wysyła usunięcie; odłączony worker wykona je po
ponownym połączeniu albo wcześniej po TTL. Rewizje i potwierdzenia chronią przed
ponownym zastosowaniem starego przydziału po revoke. Restart gateway odczytuje stan
z bazy; restart workera usuwa pozostałe materializacje przed synchronizacją.
Odczyt dostaw rezerwuje do 64 rekordów przez `FOR UPDATE SKIP LOCKED`.
Trwały kursor `worker_secret_delivery_cursors` przesuwa niepotwierdzone dostawy za następne,
aby brak potwierdzenia jednego pliku nie blokował późniejszych grantów.
Partia zapisuje jeden kursor zamiast aktualizować każdy grant. Po dojściu do końca
identyfikatorów kolejka zawija; blokady pominięte przez SKIP LOCKED są ponawiane później.
Reset po ponownym połączeniu zeruje potwierdzenia w partiach do 256;
`worker_secret_replays` przechowuje kursor także po restarcie gatewaya.
Do zakończenia resetu wynik nie uznaje starej ścieżki pliku za potwierdzoną.
Potwierdzenia nadal wymagają zgodności workera, wątku, requestu i rewizji.
Zaszyfrowane kopie w backupach/WAL podlegają polityce retencji bazy; zwykłe DELETE
lub UPDATE nie jest kryptograficznym wymazaniem historycznych backupów.

TTL 24 h ręcznego przydziału jest stałą domyślną serwisu; krótszy można wstrzyknąć w fixture.
Nie dodano jeszcze publicznego ustawienia TTL. Klucz pozostaje w `CANOPY_SECRETS_KEY`
i korzysta z istniejącego identyfikatora klucza `env-v1`. Prywatne komunikaty gRPC
nie są logowane ani wpisywane do worker_commands. Zdalne połączenie wymaga istniejącej
ochrony transportu TLS lub zaufanego tunelu, tak samo jak sekrety provider instances.

## Pliki i tryby uprawnień

Plik to `<worker-dataDir>/thread-secrets/<thread-id>/<request-id>`. Katalogi mają
`0700`, plik `0600`, zapis używa `O_EXCL`, `O_NOFOLLOW` i atomowego rename. Worker
odrzuca materializację, jeżeli katalog sekretów znajduje się wewnątrz workspace.
Nie wymaga umieszczania plików w repozytorium ani zmiany sandboxu na pełny dostęp.

Codex `read-only` i `workspace-write` pozwalają czytać takie pliki poza cwd; żaden
nowy writable root nie jest dodawany. Claude otrzymuje własny katalog wątku jako
`additionalDirectories`. To uprawnienie katalogowe Claude nie jest mechanizmem
read-only: agent z odpowiednimi uprawnieniami może również zmodyfikować swój plik.
`FULL_AUTO` zachowuje dotychczasowy sandbox i `failIfUnavailable`, bez
`bypassPermissions`. Tryb `ASK` zachowuje zwykłe zgody poleceń; `READ_ONLY` Claude
może odmówić polecenia wymagającego zgody — sekret nie obchodzi tej polityki.
Live testy potwierdzają odczyt w `ASK` i sandboxowanym `FULL_AUTO` obu harnessów.

## Maskowanie i granice bezpieczeństwa

Filtr adaptera ma zamaskować znaną wartość, gdy narzędzie przypadkowo wypisze
ją w tekście przeznaczonym dla modelu. Worker sprawdza gotowość w sesji,
która prosi o przydział. W Claude i Groku wynik może podmienić synchroniczny
hook. W obsługiwanych profilach Codexa worker dodatkowo filtruje żądania
Responses, ponieważ częściowe wyjście polecenia może poprzedzać hook końcowy.
Zakres obsługi zależy od wersji CLI, transportu i uprawnień wątku.
[Claude](claude-adapter.md#maskowanie-sekretów-w-wynikach-narzędzi),
[Grok](grok-adapter.md), [Codex](codex-adapter.md).

Natywny transkrypt Groka na workerze może zawierać oryginalny tekst po
zamaskowaniu wyniku dla modelu. Uprawnienia systemowe workera, jego
dysk i kopie zapasowe pozostają granicą zaufania. Cofnięcie dostępu
usuwa plik utworzony przez Canopy. Program, który już odczytał sekret,
może zachować własną kopię w pamięci lub na dysku.

Redaktor działa w workerze **przed** `Journal.append`: maskuje dokładną wartość
i jej wariant z escapingiem JSON na `[REDACTED]` w zdarzeniach i usuwa `rawJson`.
Gdy sekret jest aktywny, delty tekstu są wstrzymywane do zakończenia itemu,
aby wartość rozbita na kilka chunków nie wyciekła do UI. Finalny item odtwarza
brakujący output z bufora i maskuje go; bufor przechowuje wzorce do końca itemu,
również po cofnięciu sekretu. Dla dużych pól ogranicza bufor do około 4 MiB.
Oznacza to opóźnienie streamingu do ukończenia itemu podczas używania sekretów.

Redakcja dziennika chroni historię Canopy i jej projekcje w UI. Dla dawnej
prośby ręcznej plik może zostać wydany także sesji bez aktywnego filtra
kontekstu. W tej konfiguracji output shellu może trafić do modelu przed
redakcją zdarzenia w dzienniku. W obu trybach program powinien używać pliku
wewnątrz polecenia. Zakodowane, przekształcone lub częściowe wartości mogą
nie pasować do wzorca. Polecenia uruchamiane na workerze podlegają zwykłej
polityce dostępu do sieci.

Karta wyłącza autocomplete, spellcheck i sugeruje menedżerom haseł ignorowanie
kontrolki. Przeglądarka i rozszerzenia nadal należą do granicy zaufania. Schowek
jest odczytywany wyłącznie po kliknięciu Paste; aplikacja go nie zapisuje i nie
czyści globalnego schowka. Pole czyści się przed fetch oraz po unmount.

## Weryfikacja

- `project-secrets.test.ts` sprawdza zakres właściciela i projektu, zaszyfrowany
  zapis, poszczególne przydziały, podmianę wartości, odmowę starszego workera
  i wygaśnięcie podczas trwającej tury.
- `project-secret-provider.live.test.ts` używa rzeczywistego CLI Claude, workera
  i gatewaya oraz lokalnej atrapy endpointu modelu. Pierwsze wywołanie prosi o
  zapisany sekret, kolejne odczytuje plik przez Bash. Test sprawdza treść
  żądania po odczycie oraz usunięcie pliku po turze.

- `thread-secrets.test.ts`: rzeczywisty gateway i PostgreSQL, skryptowany worker
  z produkcyjnym magazynem plików; zapis, szyfrowanie, `0600`/`0700`, wynik bez
  wartości, maskowanie wartości podzielonej na chunki, revoke, odmowa, kontrola
  wątku, expiry offline oraz nowe instancje gateway i workera. SQL przeszukuje
  turns, steers, items, events, agent_bus_calls, worker_commands, interactions
  i audit_log w poszukiwaniu plaintextu.
- `secret-queue-batches.test.ts`: wznowienie resetu 600 grantów po restarcie,
  brak zagłodzenia bez potwierdzeń oraz ograniczone wygaszanie tylko własnych grantów.
- `thread-secrets.live.test.ts`: Codex i Claude przez `useLiveProxy`/CLIProxyAPI,
  każdy w `ASK` oraz `FULL_AUTO`; API odpowiada na prośbę, agent porównuje SHA-256
  pliku. Wartość nie występuje w zapisach bazy, wynikach, logach workera ani jego
  transkryptach `.jsonl`. Host i klucz proxy pozostają poza repozytorium i logami.
