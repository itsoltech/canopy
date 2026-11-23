# Konektory Canopy

Projekt i wdrożenie: 2026-11-02. Zakres: konta zdalnych serwerów MCP,
OAuth w gateway, dostęp wybranych projektów i botów oraz jeden kanał wykonania.
Status (2026-11-22): dostęp wątków do kont wynika z grantów projektów.
Na `dev` (2026-11-23) eksport diagnostyczny gatewaya pokazuje etap nieudanego startu OAuth.
Settings → Connectors rozróżnia **Slack User** (narzędzia MCP działające jako
użytkownik) i **Slack Bot** (wiadomości przez Socket Mode). Bot settings → Messengers
wybiera konto Slack Bot i jego trasy. Dotychczasowe połączenia i trasy zachowują
identyfikatory, a gateway nadal odnawia rotowane tokeny współdzielonych aplikacji.
Pole Projects w karcie konta obejmuje wszystkie wątki w wybranych projektach,
na każdym workerze projektu. Wątki nadal stosują swój tryb uprawnień. Dostęp botów ustawia się w Bots.
Zgoda na zapis MCP obejmuje konkretną operację. Synchronizacja rozpoznaje podmiot OAuth,
a połączenia z adresami podanymi przez discovery przechodzą kontrolę DNS.
Usunięcie bota odłącza jego przypisania i trasy od współdzielonych kont.
Połączenie Slack Bot korzystające z aplikacji Slack User udostępnia też
sformatowaną wysyłkę jako Canopy przez Slack Web API.
Bot i jego rutyny mogą korzystać ze stałej zgody właściciela na wysyłkę do wybranej rozmowy Slack.
Boty i wątki mogą pobierać udostępnione pliki Slack, a wiadomości Socket Mode mogą zawierać załączniki.
Log gatewaya pokazuje odbiór zdarzeń Socket Mode, przyczyny pominięcia,
wynik zapisu do kolejki i rozłączenia.
Panel web/desktop jest odświeżany reaktywnie w pamięci BFF
i dostarczany przez SSE; autoryzacja uwzględnia zmiany uprawnień bieżącej tury Claude.
Panel natywnego mobile rozróżnia dostęp projektu i katalog bieżącej tury:
Available, Available next turn, Access removed, Unavailable oraz Error.
Zachowuje podłączone konto po odebraniu grantu do czasu aktualizacji katalogu;
szczegóły błędu sesji rozwija się przez Show details.
Aktualizacja (2026-11-23): wątki Claude przyjmują warunkowe schematy narzędzi MCP.
Web i desktop objaśniają wykluczenie No project w ustawieniach konektorów i panelu wątku.
Dostępność kanałów według [release.md](release.md).

## Decyzje

Typ konektora opisuje usługę, konto opisuje nazwaną autoryzację (np. „personal”,
„work”), a grant określa dostęp. Konto należy do użytkownika. Domyślnie nie ma
grantów. All projects i All bots obejmują także przyszłe projekty i boty
**tego użytkownika**. Wątki w No project nie korzystają z kont konektorów.
Wybrane projekty i boty są niezależnymi zbiorami. Każde konto ma własne granty.

Migracja **0041_connectors** przenosi stare `bot_mcp_servers` do kont typu
`custom`, zachowując ID, nazwy, transport i odwołania do zaszyfrowanych nagłówków.
`bot_mcp_connections` stają się grantami wybranych botów. Nie powstają granty
workerów. Stare RPC pozostają adapterem zgodności; nowa konfiguracja korzysta
z Connectors. Stare tabele pozostają wyłącznie jako źródło migracji.

Migracja **0197_connector_project_access** przenosi All workers na All projects.
Indywidualny grant przechodzi na aktywny projekt, jeśli wszystkie znane miejsca
pracy i istniejące wątki projektu były objęte grantem. Instalacje współdzielące
konfigurację mogą mieć dodatkowe miejsca pracy u partnerów, dlatego indywidualne
granty wymagają ponownego wyboru projektów. Granty botów są zachowywane.

Gateway jest jedynym klientem zewnętrznego MCP. Tokeny, refresh tokeny, sekrety
aplikacji OAuth i PKCE są zaszyfrowane AES-256-GCM kluczem `CANOPY_SECRETS_KEY`.
Żaden katalog narzędzi ani wynik API nie zawiera tych wartości. Wyniki zdalnych
narzędzi przechodzą redakcję znanych sekretów przed utrwaleniem i wysłaniem.
Test konta klasyfikuje błędy HTTP, OAuth, MCP/JSON-RPC, sieci/TLS i timeout.
Zapisuje zredagowaną diagnozę z fazą (`initialize` / `tools/list`), statusem HTTP
i kodem/komunikatem serwera w `connector_accounts.error` (migracja `0079_connector_errors`).
Gateway zapisuje jedną linię ostrzeżenia, bez surowej przyczyny, nagłówków i URL.
Znane sekrety redaguje `redactConnector`; adresy i typowe formaty poświadczeń
usuwa dodatkowy filtr. Odczyt obejmuje najwyżej 16 KiB odpowiedzi i tylko pola
błędu JSON; HTML i inne pola są pomijane. UI pokazuje przyczynę i działanie,
a diagnozę za „Show details” z kopiowaniem. Widok jest owner-scoped.
Negatywny wynik Test wraca jako konto ze stanem `error` i pustą listą narzędzi;
błędy samego żądania lub zapisu nadal są błędami RPC.
Udany test, ponowne połączenie lub Disconnect usuwa poprzednią diagnozę.
Stan `error` wstrzymuje narzędzia; UI pokazuje „Connection error · Tools unavailable”.
Następne pobranie narzędzi dla uprawnionego projektu lub bota ponawia listing,
także gdy konto ma zapisany katalog. Sukces przywraca `connected` i usuwa diagnozę.
Niepowodzenie nadal wyklucza narzędzia z tej tury; `disconnected` i `needs_reconnect`
nie są automatycznie ponawiane i wymagają ponownego połączenia.
Połączenia MCP nie podążają za redirectami; SSE nie może zmienić origin.
HTTP jest dozwolone tylko dla loopback do lokalnego developmentu; inne endpointy
wymagają HTTPS. Custom MCP jest jawną konfiguracją sieciową właściciela, także
do jego usług prywatnych; nie uruchamia procesów ani transportu stdio.

Konta i aplikacje OAuth są **wspólną konfiguracją** połączonych komputerów. Każdy gateway szyfruje
poświadczenia własnym kluczem; nie wysyła ich do workerów, modeli ani UI. Łącze z wyłączonym Share
configuration nie przenosi definicji ani sekretów. Stan połączenia, diagnoza `error`, ostatnie użycie i namespace są lokalne;
UI opisuje je jako „This computer”. Zakres Projects, w tym All projects,
synchronizuje się z kontem jako jedno pole `projectAccess` z kanonicznymi ID projektów.
All bots jest wspólne, a indywidualne granty botów są zapisywane w domu bota. Przeniesienie bota nadal wymaga nadania mu dostępu w nowym domu.
Nieudany Test nie publikuje tych lokalnych pól ani nie zwiększa rewizji wspólnej konfiguracji.
Udany Test publikuje tylko rzeczywistą zmianę katalogu narzędzi; sam powrót do `connected`
nie zwiększa rewizji. Zmiana nazwy, grantów lub katalogu na innym komputerze zachowuje
lokalną diagnozę. Dopiero faktyczna zmiana wspólnych poświadczeń usuwa nieaktualny błąd
i ponownie wyznacza lokalny stan połączenia.

Rekordy `connector` i `oauth_app` inicjalizuje gateway przy starcie; migracja **0077_config_connectors**
dodaje czas zapisu aplikacji. Zapis najpierw blokuje `config_clock`, a potem konto, i zapisuje rekord
w tej samej transakcji. Definicja obejmuje typ, nazwę, URL, transport, metodę logowania, dostęp projektów, All bots
i narzędzia; poświadczenia wraz z nagłówkami są jednym sekretnym polem `credentials` w `config_secrets`.
Klient OAuth (także client ID i zapamiętany redirect) jest osobnym zaszyfrowanym rekordem per typ.
`GetConfigBlob` nadal obsługuje wyłącznie treść biblioteki, nigdy sekrety connectorów.

Przy pierwszym scalaniu dwóch niezależnych kont OAuth gateway porównuje typ, URL i skrót
wystawcy oraz podmiotu z odpowiedzi endpointu tokenowego. W Slacku podmiot obejmuje
`team.id` i `authed_user.id`. Taki sam workspace, nazwa konta, klient OAuth lub starszy
skrót bez potwierdzonego podmiotu nie wystarczają do scalenia. W takim przypadku każde
konto zachowuje własne poświadczenia i granty. Istniejące powiązania po globalnym ID
lub zapisanym aliasie nadal obsługują aktualizacje i odnowienia. W kontach nagłówkowych
gateway porównuje dokładną nazwę po NFC i przycięciu spacji oraz nagłówki, przy jednym kandydacie.
Mniejsze id zostaje kanoniczne, alias prowadzi do lokalnego wiersza bez przepisywania grantów.
Odwołania kont w źródłach skilli/marketplace'ów są globalne w rekordzie i lokalne po materializacji.
Gdy konto jeszcze nie dotarło, sprawdzenie źródła prosi o odczekanie i ponowienie.

## OAuth

BFF rozpoczyna autoryzację i przekazuje callback do gateway przez uwierzytelnione
gRPC. Publiczny callback to `/api/connectors/oauth/callback` na origin Canopy.
Gateway używa MCP SDK **1.32.2**: protected resource metadata (RFC 9728),
metadata authorization servera (RFC 8414), DCR i Authorization Code + PKCE S256.
Gateway rozwiązuje nazwy docelowe przed połączeniem i łączy się z wybranym adresem IP,
zachowując nazwę hosta dla TLS. Dla celu wskazanego w metadanych wszystkie odpowiedzi DNS
muszą być publiczne. Prywatny adres jest dopuszczony dla dokładnego origin wpisanego przez
właściciela serwera MCP lub zarejestrowanego wystawcy. Inny port jest osobnym origin.
Discovery i rejestracja współdzielą wybór adresu. Origin rozpoznany jako publiczny pozostaje
publiczny przy wymianie kodu, odświeżaniu i odwołaniu tokenu. Gateway odrzuca przekierowania.
Przy błędzie startu przed wyświetleniem zgody gateway zapisuje etap: discovery,
rejestracja klienta, przygotowanie autoryzacji albo zapis stanu. Przy discovery
i rejestracji zapisuje też status HTTP, jeśli otrzymał odpowiedź. Eksport nie zawiera URL-i,
odpowiedzi dostawcy ani danych sesji.
Losowy, jednorazowy state ma TTL 10 minut, wiąże konto i właściciela oraz osobny
sekret sesji przeglądarki w cookie HttpOnly/SameSite=Lax. Desktop otwiera
autoryzację w przeglądarce systemowej, oddzielnej od sesji Electrona; zamiast
cookie używa losowego powiązania przechowywanego wyłącznie w procesie lokalnego
BFF. Restart BFF unieważnia rozpoczęte logowanie desktopu. Callback zużywa state
atomowo przed wymianą kodu. Nie ufa origin ani adresowi powrotu z parametrów URL.
Sekrety aplikacji wprowadza się raz na typ konektora w ustawieniach właściciela.
Wynik to mała strona z ustalonym komunikatem; parametry dostawcy nie trafiają do
HTML ani logów, a skrypt usuwa je z bieżącego adresu. W desktopie strona próbuje
otworzyć `canopy://connectors` i ma przycisk „Open Canopy”, gdy przeglądarka
wymaga kliknięcia. Link pokazuje ustawienia konektorów; powrót fokusu także
odświeża stan kont. W Electronie wynik wraca bezpośrednio do ustawień.
Zakończony OAuth, zmiana kont i grantów oraz błąd odświeżenia tokenu docierają do każdego
otwartego klienta jako `OverviewUpdate.connectors_changed` (bez stałego odpytywania strony;
[ui-api.md](ui-api.md#współdzielone-odczyty)). Granty sprawdza zawsze gateway przy wykonaniu.
### Stały redirect OAuth

Nowe rejestracje DCR oraz aplikacje bez DCR (`oauth_app_required`: Slack, GitHub OAuth app)
korzystają z **jednego stałego redirect URL dla wszystkich instalacji**: statycznej strony
`https://itsoltech.github.io/canopy/oauth/callback` (GitHub Pages tego repozytorium,
źródło `site/oauth/`, workflow `pages.yml`). Dzięki temu manifest aplikacji Slack jest
identyczny wszędzie, współpracownicy mogą dzielić jedną aplikację bez dopisywania
własnych redirectów, a dostawca widzi wyłącznie adres HTTPS — także gdy Canopy działa
na `http://` w sieci lokalnej.

Warunkiem użycia tej strony jest jawne ogłoszenie `S256` w
`code_challenge_methods_supported` metadanych serwera autoryzacji. Gateway wybiera adres
po discovery, przed DCR. Przy DCR wysyła `redirect_uris = [stały adres]`. Dotyczy to
Notion, Linear, Atlassian i własnych serwerów MCP, a także endpointów Microsoft 365
i Google Workspace skonfigurowanych przez właściciela. Decydują metadane konkretnego
serwera, nie nazwa konektora. Bez ogłoszonego S256 DCR zachowuje callback instalacji;
SDK nadal wysyła challenge S256 i odrzuca metadane jawnie wykluczające tę metodę.
Zapisana aplikacja ze stałym redirectem bez ogłoszonego S256 nie rozpoczyna logowania.
Uwierzytelnianie tokenem lub nagłówkami nie używa redirectów.

Gateway używa tego adresu jako `redirect_uri` w autoryzacji i w wymianie kodu (PKCE S256
pozostaje obowiązkowe), a drogę powrotu zapisuje w `state`
(`packages/domain/src/oauth-return.ts`): `<nonce>.w.<base64url callbacku instalacji>`
albo `<nonce>.d` dla desktopu. Strona przekierowania przekazuje query bez zmian, ale tylko
na `http:`/`https:` ze ścieżką dokładnie `/api/connectors/oauth/callback`, bez danych
logowania, query i fragmentu; inaczej pokazuje błąd (brak open redirect). Ma
`referrer: no-referrer`, CSP `default-src 'none'` ze skryptem i stylem dopuszczonymi
hashem, nie ładuje skryptów zewnętrznych ani analityki i usuwa query z historii.

Dlaczego to bezpieczne: przez przeglądarkę przechodzi tylko jednorazowy, krótko ważny
kod, bezużyteczny bez weryfikatora PKCE, który ma wyłącznie gateway
(oraz client secret, jeśli aplikacja go ma). Dotyczy to również publicznych klientów DCR.
Gateway przechowuje tylko hash całego `state`, więc zmieniony adres powrotu, obcy albo
powtórzony state nie pasuje: callback nadal sprawdza state jednorazowo, z właścicielem,
powiązaniem przeglądarki i TTL 10 minut. Strona niczego nie dodaje do tego, czemu gateway
ufa. Logi GitHub Pages mogą zobaczyć kod w URL; z powyższych powodów nie da się go użyć.

Trzy drogi powrotu:

1. **Serwer/web** — przekierowanie (`location.replace`) na callback instalacji.
2. **Desktop** — strona otwiera `canopy://oauth/callback?…` (ten sam schemat i parser
   `desktopLink()` co `canopy://enroll` i `canopy://connectors`). Proces główny przyjmuje
   tylko `oauth/callback`, wyłącznie klucze `code`, `state`, `error`, `error_description`,
   `iss` (każdy raz) i state desktopu; zachowuje wynik, pokazuje okno i ładuje
   Settings → Connectors, które odbiera kod mostem desktopu (`takeConnectorOAuth`) i kończy
   logowanie przez `POST /api/connectors/oauth/code`. Przeglądarka nie łączy się z
   `http://127.0.0.1`.
3. **Ręcznie, zawsze dostępne** — po 3 s strona pokazuje „Copy code”: `state` i `code` jako
   jeden nieprzezroczysty ciąg. Dialog Connect ma pole „Sign-in code” (w desktopie pojawia
   się po 5 s oczekiwania albo na żądanie). Gateway (`pasted_code`) sprawdza state tak samo
   jak callback i wymienia kod tak samo. Powrót przez deep link zamyka otwarty dialog
   tego konta i odświeża listę. Ponowne wklejenie po udanym powrocie potwierdza
   „Already connected”; nie wymienia kodu ponownie. Migracja `0081_connector_oauth_completion`
   zapisuje potwierdzenie dopiero razem z tokenami, więc wcześniejsze połączenie konta
   nie zamienia nieudanej wymiany w sukces. Potwierdzenie podlega temu samemu właścicielowi,
   powiązaniu i TTL. Błędy rozróżniają zużycie, wygaśnięcie, inne okno i niepoprawny format;
   odrzucenie przez dostawcę zachowuje zredagowany powód w „Show details”.

`CANOPY_OAUTH_REDIRECT_URL` zmienia stały adres (HTTPS albo loopback). Instalacja może
wskazać własny callback i ominąć stronę; wtedy musi go zarejestrować u dostawcy. Zapisana
aplikacja pamięta redirect, z którym ją zapisano, więc późniejsza zmiana zmiennej nie psuje
istniejących aplikacji. Ręczne aplikacje zapisane bez redirectu nadal używają callbacku
instalacji; formularz Advanced pokazuje dla nich ten adres. Nie można automatycznie
zmienić redirectu aplikacji zarejestrowanej ręcznie u dostawcy.

Klient DCR pamięta dokładny redirect w zaszyfrowanych poświadczeniach konta
(`Credentials.redirectUri`). Zmiana konfiguracji nie zmienia rozpoczętej wymiany kodu
ani odświeżania istniejących tokenów. Stare rejestracje nadal działają. Dopiero jawne
Reconnect wykonuje discovery ponownie i wybiera aktualny adres: stały dla S256,
callback instalacji bez ogłoszonego S256 albo override. Gdy adres i issuer są takie
same, używa istniejącego klienta; gdy się zmienią, rejestruje nowego. Zmiana endpointu
lub sposobu uwierzytelniania usuwa poprzednią rejestrację. W obu krokach jednej sesji
(autoryzacja i wymiana kodu) gateway wysyła identyczny `redirect_uri`.

Każde konto zachowuje własną rejestrację/tokeny; odświeżanie jest serializowane
blokadą konta w PostgreSQL, również przy wielu gatewayach. Brak możliwości
odświeżenia oznacza `needs_reconnect`. Disconnect najpierw odbiera dostęp,
następnie próbuje revoke i usuwa lokalne tokeny niezależnie od wyniku dostawcy.
Delete (`DeleteConnectorAccount`) usuwa konto, granty, stany OAuth i rekordy deduplikacji na komputerach
grupy; wpisy audytu zostają bez powiązania z kontem. Nie wykonuje revoke: to pozwala przywrócić konto
z zaszyfrowanej historii przez 90 dni. Partner pokazuje jedną notkę z Restore. Restore przywraca definicję
i poświadczenia, ale nie odtwarza konkretnych grantów; historię timeline zachowuje zapisana nazwa konta.
Jawne Disconnect nadal wykonuje revoke i replikuje brak poświadczeń. Konflikt zmian ma notkę z Restore;
sekrety są w niej wyłącznie jako „A different key”, a hash tożsamości jako „A different account”.
Potwierdzenie Disconnect mówi „Computers sharing configuration lose access to this account. You can
reconnect it later.” Potwierdzenie Delete mówi „This removes the account from computers sharing
configuration. Threads and bots lose access. A linked computer can restore it for 90 days.”
Pola notek używają etykiet „Connector”, „Name”, „Endpoint”, „Transport”, „Sign-in method”,
„Project access”, „All bots”, „Tools”, „Account”, „Credentials” i „Deleted”.

Odświeżenie tokenów jest zmianą sekretnego pola z nowym HLC. Przyjęcie nowszych poświadczeń usuwa lokalne
`needs_reconnect`; spóźniony starszy token przegrywa i pozostaje tylko w zaszyfrowanej historii.
Równoległe odświeżanie między komputerami może chwilowo skończyć się `needs_reconnect` na przegranym,
aż dotrze nowszy token. Sesje state/PKCE i ich weryfikatory zostają lokalne; stały redirect, `canopy://`
i paste-code działają jak wcześniej. Disconnect revokuje tokeny na zewnątrz, Delete nie.

## Harnessy i zgody

Worker otrzymuje wyłącznie deskryptory: ID konta, nazwę, schemat i opis narzędzia.
Claude Agent SDK **0.3.316** / Claude Code **2.1.316**: narzędzia w serwerze MCP
w procesie workera (`mcp__canopy__…`). Katalog zachowuje oryginalny JSON Schema
konektora, łącznie z regułami `if`/`then`/`else`. Adapter przekazuje pełne argumenty
do gatewaya. Za walidację schematu odpowiada serwer narzędzia.
Codex **0.164.0**: prywatny lokalny HTTP MCP
`canopy_connectors`. Grok: lokalny HTTP MCP przekazany przez ACP.
Nazwy są stabilne i rozdzielone per konto (`github_work_<id>__create_issue`),
także gdy nazwy dwóch kont są identyczne po normalizacji. Opisy podają typ i konto.
Rename unieważnia cache opisów; techniczna nazwa narzędzia pozostaje stabilna.
Wywołanie `AgentToolCall` wraca istniejącym linkiem gRPC do gateway. Gateway
sprawdza workera, właściciela wątku, bieżącą turę, grant projektu i bieżący katalog konta.
Zmiana grantów odbiera możliwość wykonania natychmiast. Katalog istniejącego wątku
aktualizuje się przed następną turą, z zachowaniem historii i bez przerywania pracy
([mechanizmy adapterów](#ograniczenia-sesji-harnessów)). Odebrany grant blokuje
wykonanie również wtedy, gdy stary katalog nadal pokazuje narzędzie.

Boty dostają katalog kont ze swoich grantów i wykonują MCP w gateway. Istniejąca
polityka `safe` przepuszcza tylko `readOnlyHint=true`, bez `destructiveHint=true`;
pozostałe wywołania mają kartę zgody. `always` pyta także o odczyty,
`full_auto` przepuszcza narzędzia bez kart; pytania do użytkownika pozostają.
Zmiana adnotacji zdalnego narzędzia na zapis nadal wymaga zgody w `safe`,
natomiast jawne `full_auto` pozwala na zapis. Żaden tryb nie zastępuje grantu.
Usunięcie bota usuwa jego indywidualne granty. Konto i pozostałe granty nadal działają.
Stała reguła bota może pozwalać na konkretne konto albo pojedyncze narzędzie tego konta.
Gateway zapisuje ją wyłącznie po wyborze „Always allow…” przez właściciela, sprawdza
przy każdym kolejnym żądaniu i zachowuje kopię w historii zgód. Cofnięcie działa od
następnego żądania. W lokalnych wątkach uruchomionych przez bota zweryfikowana ścieżka
connectora czyta bieżące ustawienie wątków bota przy każdym żądaniu. Tylko aktualne
**Inherit default** (`user_default`, także dawne `same_bot`) pozwala użyć tej reguły;
wybór nie jest zamrożony przy starcie wątku. Stały tryb nie dziedziczy reguł kont bota.
Reguły bota archiwalnego lub przeniesionego nie obowiązują. Payload permission workera
nie może sam zadeklarować konta lub użytej reguły. `READ_ONLY` nadal odmawia zapisów.
Rutyny w tle używają grantów i polityki tego samego bota; uruchomienie rutyny
nie nadaje dodatkowych uprawnień do kont.
Wątki: `READ_ONLY` odmawia zapisów, `ASK` i `ACCEPT_EDITS` wymagają istniejącej
interakcji permission dla narzędzi innych niż tylko odczyt, `FULL_AUTO` i `FULL_ACCESS` przepuszczają.
Zgoda nie zastępuje grantu; grant jest ponownie sprawdzany tuż przed wykonaniem.
Przed pokazaniem karty gateway wiąże jej identyfikator z właścicielem, wątkiem, turą,
kontem, nazwą narzędzia MCP i pełnymi argumentami. Rezerwacja pierwszego wykonania
w bazie wymaga pasującej, zaakceptowanej karty. Po restarcie klient może wznowić
to samo wywołanie. Migracja `0181_connector_approval_binding` zachowuje decyzje
i oczekujące karty, gdy zapisane dane pozwalają potwierdzić całą operację.
Jeśli starsza karta zawiera wyłącznie zredagowaną treść, potrzebne jest nowe wywołanie ze zgodą.
Zmiana uprawnień bieżącej tury Claude wstrzymuje autoryzację do utrwalenia
zastosowanego trybu. Oczekująca zgoda nie omija późniejszego `READ_ONLY` ani końca
tury; gateway ponownie sprawdza bieżącą turę i tryb przed wykonaniem.
Szczegóły: [protocol.md](protocol.md#modele-effort-i-steer).
Ponowienie call ID po reconnect nie wykonuje ponownie operacji. Nieznany wynik
po awarii nie powoduje automatycznego powtórzenia zapisu.

### Pobieranie plików ze Slacka

Grant konta Slack OAuth udostępnia botowi z włączonym **Files** oraz wątkowi
narzędzie odczytu `download_slack_file`. Argumentem jest identyfikator `F…` ze
Slacka. Gateway ponownie sprawdza grant i aktywną turę, pobiera metadane przez
`files.info` i używa tokenu użytkownika z zakresem `files:read` do ograniczonego
pobrania z `https://files.slack.com`. Pobieranie i przekierowania pozostają na
hoście plików Slack. Metadane połączenia, adres pliku Slack i jego token zostają
w gatewayu. Obowiązują limity oraz walidacja formatu załączników Canopy.

Bot w rozmowie zewnętrznej może pobrać wyłącznie plik udostępniony
w tej rozmowie przez dopuszczonego autora, przez konto connectora powiązane
z trasą. Pobrany plik otrzymuje referencję do przekazania przez `attachment_ids`.
Wątek otrzymuje lokalną ścieżkę w katalogu załączników workera po zweryfikowaniu
pobranych bajtów. Odczyt z konektora wymaga capability `agent_tool_attachments_v1`.

### Bezpośrednia wysyłka w Slacku

Po autoryzacji Slack Bot korzystającego z aplikacji Slack User gateway
udostępnia narzędzie `canopy_post_slack` botom i wątkom w projektach z grantem tego konta.
Aplikacja musi mieć dostęp do rozmowy w Slacku. Używa istniejącego bot scope
`chat:write`. Trasa nasłuchiwania nie jest potrzebna do wysyłki.
Gateway wywołuje `chat.postMessage` jako aplikacja Canopy z użyciem tokenu bota.
Narzędzie przyjmuje tekst w Markdownie do 4000 znaków. Identyfikator rozmowy wskazuje
miejsce wysyłki, a opcjonalne `reply_to` pozwala odpowiedzieć w istniejącym wątku.
Gateway zamienia pogrubienia, kursywę, linki, listy i kod na elementy Slack rich text.
Jawne `<@USER_ID>` w treści tworzy wzmiankę o konkretnej osobie. W kodzie, cytatach
i etykietach linków pozostaje tekstem. Wzmianki grupowe i ogólnokanałowe pozostają
tekstem, a automatyczne podglądy linków są wyłączone.
Link do wysłanej wiadomości pojawia się po potwierdzeniu przez Slacka.
Narzędzia Slack MCP do szkiców i wysyłki jako użytkownik zachowują własny proces
przeglądu treści.

W prywatnej rozmowie i w rutynach bota właściciel może zatwierdzić jedną wiadomość
lub wybrać **Always allow** dla danego konta i rozmowy Slack. Reguła obejmuje
kolejne posty i odpowiedzi tego bota w tej rozmowie Slack, również z rutyn i po
zakończeniu pracy zleconej agentowi. Gdy brakuje pasującej zgody, gateway pokazuje
kartę także w trybie Full auto. Regułę można usunąć w **Allowed actions**.
Narzędzie nie jest dostępne w turach z komunikatorów ani w wymianach między botami.
Zwykłe wątki agentów stosują swój tryb uprawnień do zapisu w connectorze.
Odebranie grantu albo odłączenie wiadomości blokuje nowe wysyłki.

## Katalog dostawców

„Metadata” oznacza publiczny odczyt dokumentacji/odpowiedzi endpointu, bez konta.
Żaden preset dostawcy nie jest na tej podstawie oznaczany jako live verified.

| Typ | Oficjalny endpoint MCP | Auth / DCR / PKCE | Co podaje użytkownik | Dowód i ograniczenie |
|---|---|---|---|---|
| GitHub | `https://api.githubcopilot.com/mcp/` | PAT Bearer lub OAuth, S256, refresh; protected resource metadata; AS nie ogłasza DCR | PAT albo zarejestrowana aplikacja GitHub z client ID/secret | [Oficjalny serwer](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md), HTTP 401 z `resource_metadata`; [metadata AS](https://github.com/.well-known/oauth-authorization-server/login/oauth) odczytane, issuer `https://github.com/login/oauth`; bez live |
| Notion | `https://mcp.notion.com/mcp` | OAuth 2.1, DCR, S256, refresh; także MCP token na Business/Enterprise | Zgoda konta; token MCP opcjonalnie | [Dokumentacja](https://developers.notion.com/guides/mcp/get-started-with-mcp), metadata AS odczytane; zwykły integration token nie jest tokenem MCP |
| Linear | `https://mcp.linear.app/mcp` | OAuth 2.1, DCR, S256, refresh; API key/Bearer | Zgoda albo API key | [Dokumentacja](https://linear.app/docs/mcp), metadata AS odczytane; bez live |
| Atlassian | `https://mcp.atlassian.com/v1/mcp` | OAuth, DCR, S256, refresh | Zgoda i dostęp do Jira/Confluence; ograniczenia administratora | [Dokumentacja](https://support.atlassian.com/atlassian-rovo-mcp-server/), metadata AS odczytane; endpoint i polityka tenantów wymagają live |
| Slack | `https://mcp.slack.com/mcp` | Confidential OAuth, S256, refresh; brak DCR w metadata | Aplikacja Slack z manifestu Canopy (wewnętrzna, we własnym workspace), client ID/secret | [Dokumentacja](https://docs.slack.dev/ai/slack-mcp-server/), metadata wskazują user OAuth `slack.com/oauth/v2_user/authorize` i `oauth.v2.user.access`; bez live |
| Microsoft 365 / Outlook | Do ustalenia dla tenantu (Work IQ MCP / Tools registry) | Entra ID, wymagania tenantu; brak założenia o publicznym DCR | Endpoint, aplikacja Entra, zgody administratora | [Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview); preset wymaga URL tenantu, alternatywnie Custom MCP; bez zgadywanego globalnego URL |
| Google Workspace | Brak potwierdzonego ogólnego oficjalnego zdalnego MCP dla Gmail/Calendar | Zależnie od wybranego serwera | Własny zdalny MCP i jego OAuth app/token | Preset wymaga URL; nie utożsamiamy Google Cloud MCP z Workspace |
| Custom MCP server | URL właściciela, HTTP/SSE | OAuth discovery/DCR albo Bearer/własne nagłówki | URL i wymagane dane | Pełna ścieżka testowana lokalnym MCP i fake OAuth, bez zależności od kont dostawców |

## UI i audyt

Panel wątku lokalnego i połączonego komputera korzysta z `GetThreadPanel`.
Web/desktop współdzieli wczytane panele w pamięci BFF. Zmiany konfiguracji, grantów
i raporty sesji unieważniają odczyt; gotowy panel wraca przez SSE `read-model`,
bez cyklicznych odczytów HTTP renderera.
Jego DTO zawiera wyłącznie nazwy, statusy i metadane grantów; nie zawiera URL-i,
nazw nagłówków, błędów konta ani poświadczeń. „Manage connector access” zmienia
przez `SetThreadConnectorGrant` dostęp projektu w domu wątku, z kontrolą właściciela
i rewizji. Zmiana obejmuje wszystkie wątki projektu. All projects i pełną listę
grantów edytuje się w Settings → Connectors. Cache zdalnego panelu jest tylko do odczytu
i nigdy nie udziela grantu. Szczegóły: [połączone komputery](linked-computers.md#panel-wątku-i-archiwum).

Settings → Connectors pokazuje katalog, nazwane konta, stan, ostatnie użycie,
test z listą narzędzi, rename, reconnect, disconnect oraz dostęp projektów i botów.
Konta są zwartymi wierszami jednej listy z separatorami. Menu wiersza zawiera Test,
Reconnect, Rename…, Edit access, Disconnect i Delete…. Kliknięcie wiersza rozwija
edytor dostępu; zmiana nazwy otwiera osobny dialog. Wynik testu pozostaje pod
wierszem, a lista narzędzi i szczegóły błędu są rozwijane na żądanie. Ostatnie
użycie jest względne, z pełną angielską datą w tooltipie i wybranym zegarem 12/24 h.
Na telefonie natywnym wiersz otwiera arkusz dostępu, menu — arkusz akcji; zmiana
nazwy i pełna data pozostają w arkuszu. Katalog dodawania kont zawija kompaktowe
przyciski do dostępnej szerokości. Zmiana układu nie zmienia autoryzacji ani grantów.
Hover i aktywny stan obejmują całą szerokość wiersza, razem z menu. Na wąskim
ekranie nazwa zajmuje osobną linię, druga łączy stan z dostawcą, a trzecia — czas
użycia i dostęp. Bieżący komputer nie jest powtarzany w każdym wierszu telefonu.
Web i aplikacja natywna współdzielą zaokrąglanie czasu: 59,5 minuty przechodzi
w godzinę, a 23,5 godziny — w dzień, także w skróconym zapisie.
Kontrolki korzystają z istniejącego kitu; wybór wielokrotny jest listą custom.
Edytor Projects w web/desktop wyjaśnia, że All projects wyklucza No project.
Pusty panel Connectors w wątku No project i jego okno zarządzania podają powód
niedostępności.
Sekcja Connections bota pokazuje konta z grantów; `@` ma grupę Connectors i chip
„GitHub · work”. Gateway waliduje wzmiankę względem grantu i dodaje wskazanie
konta wyłącznie do wejścia modelu. Panel wątku pokazuje dostępne konta, a oś
narzędzi — logo, typ i nazwę konta.

Dialog Connect prowadzi przez konfigurację: `ConnectorType.auth_methods`
(`apps/gateway/src/connectors/auth-methods.ts`) opisuje każdą metodę po swojemu
(np. „Personal access token” i „GitHub OAuth app”), krótkie kroki, link do strony,
na której powstaje poświadczenie, oraz `documentation_url` typu. Pole tokenu nosi
nazwę poświadczenia i jest wymagane, gdy usługa go potrzebuje (`token_required`).
Usługa bez DCR (`oauth_app_required`: GitHub, Slack) pokazuje formularz aplikacji
ze stałym redirect URL (`redirect_url`), dopóki aplikacja nie zostanie zapisana; w innych
typach scopes i zarejestrowana aplikacja oraz własne nagłówki są opcjami Advanced.

**Slack User.** Slack nie ma DCR, więc właściciel zapisuje client ID i secret
swojej aplikacji w Settings → Connectors i loguje się na konto użytkownika.
Gateway buduje wspólny manifest (`apps/gateway/src/connectors/slack-app.ts`, pola `app_manifest`
i `app_create_url`): nazwa „Canopy”, stały redirect URL, user scopes narzędzi MCP,
bot scopes wiadomości, bot user, App Home, subskrypcje zdarzeń,
`settings.is_mcp_enabled: true`, `settings.socket_mode_enabled: true`, PKCE S256
i rotacja tokenów. Manifest nie zawiera sekretów. „Create the Slack app” otwiera
`https://api.slack.com/apps?new_app=1&manifest_json=…` z wypełnionym manifestem;
„Copy manifest” daje wariant ręczny. Aplikacja pozostaje wewnętrzna, bez publicznej
dystrybucji: Slack MCP odrzuca aplikacje unlisted, a Marketplace jest alternatywą
dla instalacji we własnym workspace.

Dotychczasową aplikację można zachować. Do jej manifestu należy dodać bot user,
App Home, bot scopes i zdarzenia ze wspólnego manifestu, włączyć Socket Mode oraz
`oauth_config.pkce_enabled`, zachowując user scopes, redirect URL i dostęp MCP.
Następnie trzeba ponownie zainstalować aplikację. Włączonej rotacji tokenów Slack
nie pozwala wyłączyć; Canopy obsługuje ją także dla tokenu bota. „Use an existing
Slack app” korzysta z tego samego client ID i secret, bez tworzenia drugiej aplikacji.

Slack User przyznaje dostęp użytkownika do MCP. Przy konfiguracji Slack Bot
właściciel może wybrać tę samą aplikację i udzielić osobnej zgody OAuth na
dostęp bota. Slack Bot obsługuje też niezależną aplikację. Konfigurację odbioru
opisuje [sekcja komunikatora](#slack-jako-komunikator-bota).

### Slack: wymagania i diagnoza

[Slack MCP](https://docs.slack.dev/ai/slack-mcp-server/) używa wyłącznie Streamable
HTTP, bez SSE i DCR. SDK wysyła `Authorization: Bearer`, Accept dla JSON/SSE oraz
wynegocjowany `MCP-Protocol-Version` w żądaniach po initialize.
[User OAuth](https://docs.slack.dev/reference/methods/oauth.v2.user.access/) zwraca
`access_token` na najwyższym poziomie, `token_type: user` i obiekt `authed_user`
z identyfikatorem i scopes. To token użytkownika (`xoxp-…`), nie token bota.
SDK przechowuje go w zaszyfrowanych poświadczeniach; nie interpretuje `user` jako
schematu nagłówka. Zwykłe `oauth.v2.access` może zwracać token użytkownika w
`authed_user.access_token`, ale jest innym endpointem: Canopy używa go dla zgody na wiadomości bota,
nie dla autoryzacji MCP.

Dokumentacja manifestu Slack (sprawdzona 2026-11-05,
[Settings](https://docs.slack.dev/reference/app-manifest/#settings)) opisuje
`settings.is_mcp_enabled`: dostęp MCP musi być włączony dla aplikacji.
Konto po OAuth oznacza otrzymanie tokenu; dopiero Test sprawdza MCP.
HTTP 400 z JSON-RPC `-32600` i komunikatem „App is not enabled for Slack MCP server access”
oznacza wyłączony dostęp MCP. Włącz go w ustawieniach aplikacji lub manifeście i ponów Test;
UI pokazuje tę wskazówkę, a prywatny URL ustawień pozostaje zredagowany w szczegółach.
Przy 403 sprawdź instalację i zgodę administratora we własnym workspace,
wewnętrzną dystrybucję aplikacji oraz jej listę dozwolonych adresów IP.
Aplikacje unlisted nie mają dostępu do MCP; publikacja w Marketplace jest
alternatywą dla aplikacji wewnętrznej, nie wymogiem dla własnego workspace.

Weryfikacja na koncie Slack: utwórz i zainstaluj aplikację z manifestu, zakończ
OAuth przez stały redirect i uruchom Test. Potwierdź listę narzędzi i odczyt
zgodny z przyznanymi user scopes. W razie odmowy odczytaj status, kod i fazę
za „Show details”; nie kopiuj tokenu ani nagłówków. Atrapy testują odpowiedź
user OAuth i transport, ale nie dowodzą akceptacji konkretnej aplikacji przez Slack.

Audyt zapisuje konto, właściciela, worker/wątek albo bot, narzędzie, czas i wynik.
Nie zapisuje tokenów, nagłówków ani argumentów. Wynik potrzebny do deduplikacji
wykonania jest osobny od audytu i redagowany tak jak wynik na osi czasu.

## Ograniczenia sesji harnessów

Bot pobiera bieżący zestaw przyznanych narzędzi przed każdą turą. Dodanie konta,
nadanie/odebranie grantu, usunięcie konta lub zmiana dostępności narzędzi zmienia
fingerprint, jeżeli zmienia katalog tego bota. Następna wiadomość rozpoczyna nową
sesję Claude/Codex/Grok w **tej samej rozmowie**. Gateway pobiera całą wcześniejszą
historię użytkownika i bota dla zwykłej tury; limit 60 wiadomości dotyczy tylko rutyn.
Przed przekazaniem do harnessu stosuje budżet kontekstu z [bots-harness.md](bots-harness.md#sesja-i-kontekst):
nadmiar starszych wiadomości zastępuje jawną notatką, a transkrypt pozostaje pełny.
Worker przekazuje historię nowemu harnessowi jako dane, bez ponawiania narzędzi.
Sam grant, który nie zmienia katalogu, nie wymusza nowej sesji.

Zwykłe wątki otrzymują bieżący katalog w każdym `StartTurn`. Zmiana konta, grantu
lub narzędzi działa od następnej tury; nie przerywa bieżącej. Gateway nadal odbiera
dostęp natychmiast, także gdy harness pamięta wcześniejsze nazwy narzędzi.

- Codex 0.164.0 utrwala `dynamicTools` przy `thread/start`; `thread/resume` nie
  przyjmuje nowej listy. Konektory mają osobny lokalny serwer MCP
  `canopy_connectors`, bez poświadczeń zewnętrznych. Sam `config/mcpServer/reload`
  zachowuje katalog niezmienionego połączenia. Worker przy zmianie katalogu wykonuje
  `thread/unsubscribe`, a następnie `thread/resume` z konfiguracją MCP: bezczynna,
  nieobserwowana sesja jest odbudowywana z trwałej historii pod tym samym ID.
  Pusta sesja bez zapisanego rollout może dostać nowe ID; nie ma jeszcze historii.
  Worker sprawdza `mcpServerStatus/list` dla tego wątku przed potwierdzeniem katalogu.
- Claude dostaje `mcpServers` przy query/resume. Query utrzymywane przez zadania
  w tle usuwa i ponownie rejestruje serwer przez `setMcpServers` pomiędzy turami,
  bez kończenia query. SDK 0.3.316 ignoruje podmianę instancji o tej samej nazwie,
  dlatego potrzebne są osobne usunięcie i dodanie. `mcpServerStatus` potwierdza narzędzia.
- Grok przy zmianie katalogu zamyka bezczynny proces ACP i ładuje tę samą sesję
  przez `session/load` z aktualnym `mcpServers`; historia pozostaje w katalogu sesji.

Journal workera zachowuje ostatni zastosowany katalog po ACK i restarcie. Tylko
zmiana zestawu dodaje do wejścia następnej tury krótką notatkę `[canopy]` o dodaniu,
zmianie lub usunięciu konektora. Zdarzenia `connectors_applied` i `connectors_failed`
pozwalają panelowi wątku odróżnić dostępny katalog, zmianę oczekującą na turę i błąd
dołączenia. Raporty zawierają identyfikatory i nazwy kont oraz skróty deskryptorów,
bez endpointów i nagłówków.
Nieudane dołączenie nie jest potwierdzeniem dostępności; kolejna wiadomość ponawia próbę.
Starszy worker bez raportów nie potwierdza dostępności.

Claude dopuszcza `mcp__canopy__*` w `allowedTools`, ponieważ `dontAsk` odmawia
narzędzi spoza listy przed callbackiem. Każde wykonanie nadal przechodzi przez grant
i permission mode gateway; READ_ONLY odmawia zapisów. Starsze sesje Codexa mogą
pamiętać nazwy dawnych dynamic tools; wywołanie odebranego narzędzia jest odrzucane
przez worker/gateway, a nowe narzędzia udostępnia aktualny serwer MCP.

Regresje: `connector-sessions.test.ts` sprawdza trzy adaptery przez gateway i worker,
dodanie/usunięcie podczas pracy, brak przerwania, identyfikator sesji, panel i notatki
po restarcie. Codex `connector-refresh.test.ts` używa prawdziwego app-servera i sztucznego
modelu, sprawdzając natywny katalog oraz pełną historię. Claude `connector-refresh.test.ts`
sprawdza dodanie i usunięcie w tym samym query prawdziwego SDK/CLI, wraz z oczekiwaniem
na gotowość katalogu. Opt-in
`connector-refresh.live.test.ts` (`CANOPY_LIVE=1`) odkrywa i wywołuje nowo dodane
narzędzie w rzeczywistym modelu Codexa.

## Slack jako komunikator bota

W Settings → Connectors → Slack Bot właściciel może utworzyć aplikację z manifestu
dla bota i zainstalować ją w workspace. Przy wyłączonej rotacji zapisuje app-level
token `xapp-…` z `connections:write` oraz Bot User OAuth Token `xoxb-…` z tej samej
aplikacji. Połączenie działa bez konta Slack User.

Jeżeli właściciel wybierze aplikację zarejestrowaną w Slack User, podaje tylko
app-level token i autoryzuje Slack Bot w Slacku. Gateway odbiera bot token i refresh
token przez OAuth ze stałym callbackiem, stanem jednorazowym, powiązaniem z
właścicielem i przeglądarką oraz PKCE S256. Zgoda bota zachowuje tokeny MCP.

Aplikację należy zaprosić do wybranych kanałów; po zmianie scopes lub manifestu
trzeba ją ponownie zainstalować. Dla automatycznego odbioru udostępnionych plików
aplikacja potrzebuje zakresu bota `files:read` i ponownej zgody na wiadomości
w istniejących instalacjach. Odbiór używa wychodzącego Socket Mode, bez
publicznego webhooka. Jedno konto obsługuje wiele botów. Bot settings → Messengers
wybiera konto i zapisuje trasy niezależnie od Save changes bota; nie zakłada
kolejnej aplikacji Slack. Dla bota z połączonego komputera UI kieruje do zarządzania
na jego komputerze; poświadczenia nie przechodzą do innego domu.

Gateway sprawdza token aplikacji, bot token oraz tożsamość aplikacji i workspace
przed uruchomieniem odbioru. Odnawia wygasający token bota z wyprzedzeniem;
przed wysłaniem refresh zapisuje trwały znacznik próby. Nieznany wynik po awarii
wymaga ponownej autoryzacji zamiast ponowienia zużytego refresh tokenu.
Odnawianie tokenu użytkownika MCP również zapisuje trwałą próbę przed siecią;
nieznanego wyniku nie ponawia po restarcie. Zmiana workspace w zgodzie MCP, także
przez synchronizację z innym komputerem, wymaga ponownej zgody na wiadomości.
Tokeny i client secret są szyfrowane, nie trafiają do modeli ani workerów;
odczyty UI zawierają tylko publiczne metadane. Dotychczasowe konta pojawiają się
w sekcji Slack Bot. Powiązanie tej samej instalacji z aplikacją Slack User
zachowuje konto i jego trasy.

Wstrzymanie Slack Bot odcina odbiór, nowe działania tur zewnętrznych i wysyłkę.
Dla aplikacji współdzielonej ten sam skutek ma odłączenie powiązanego konta Slack
User lub zmiana client ID aplikacji. Ponowna autoryzacja
przywraca dostęp dopiero po sprawdzeniu tożsamości; usunięcie konta wiadomości
usuwa jego trasy. Przy pobieraniu z kolejki i osobno przed rozpoczęciem każdego
żądania do Slacka gateway sprawdza dzierżawę konta, aktywność bota i trasy, kanał,
wątek rozmowy oraz tryb `reply`. Usunięcie trasy, odebranie kanału lub przełączenie
na `notify` powstrzymuje także kolejną wysyłkę z już pobranej partii.

Wyszukiwanie kanałów przez bota korzysta z `conversations.list` i wymaga bot scopes
`channels:read` oraz `groups:read` zawartych w manifeście. Starszą instalację należy
ponownie zainstalować po dodaniu tych uprawnień. Lista zawiera tylko niearchiwalne
kanały, do których aplikacja została zaproszona; bot otrzymuje nazwy i identyfikatory,
a token pozostaje w gatewayu. To nie nadaje narzędzi connectora ani nie łączy kanałów
z konkretnymi narzędziami bota.
Odczyt członków kanału (`conversations.members`) i katalogu nazw (`users.list`,
scope `users:read` już obecny w manifeście) pozwala botowi rozpoznać osoby wskazane
przez właściciela. Wynik katalogu pomija e-maile i pozostałe pola profilu;
niejednoznaczne dopasowanie wymaga wyjaśnienia z właścicielem, bez rozszerzania
listy dozwolonych autorów na wszystkich członków kanału.

Trasa wybiera konto, dozwolone identyfikatory użytkowników i kanałów, wiadomości
prywatne, wzmianki oraz opcjonalne monitorowanie kanałów. Lista użytkowników
jest obowiązkowa: osoby spoza niej nie uruchamiają bota. Pasujące wiadomości są grupowane bez inferencji,
a gotowe partie uruchamiają lub uzupełniają turę zużywającą tokeny modelu;
instrukcje trasy nie są bezkosztowym filtrem semantycznym. Odpowiedź trafia do Slack (Reply in Slack)
albo jako powiadomienie do właściciela w Canopy (Notify me in Canopy).
Odpowiedzi wysyłane do Slacka mają to samo formatowanie co bezpośrednia wysyłka.
Zewnętrzna rozmowa nie otrzymuje automatycznie prywatnej historii właściciela.
Bot wybiera działania zgodnie z instrukcjami, korzystając ze swoich zwykłych
przyznanych narzędzi i obowiązujących zasad zatwierdzania. Kanał nie otrzymuje
osobnego przypisania narzędzi. Zarządzanie kontami i nasłuchiwaniem wymaga
prywatnej wiadomości właściciela.

### Diagnoza brakującej odpowiedzi na Slacku

W logu gatewaya wyszukaj prefiks `messengers: slack`. Wpisy zawierają
identyfikator konta Messages w Canopy oraz, jeśli przejdą walidację,
identyfikator zdarzenia i kanału, typ zdarzenia oraz znaczniki czasu wiadomości
(`message_ts`) i wiadomości nadrzędnej (`thread_ts`). Log nie zawiera treści
wiadomości, autorów, tokenów, adresów załączników ani pełnych błędów dostawcy.

- `stage=received` oznacza odebraną i zdekodowaną ramkę. Wpis `stage=ignored`
  albo `stage=rejected` podaje powód pominięcia przed zapisem.
- `stage=ingest outcome=buffered` potwierdza zapis w buforze po zatwierdzeniu
  transakcji. `no_matching_route` oznacza brak aktywnej trasy pasującej do
  kanału i autora, a `route_not_triggered` oznacza dopasowaną trasę bez
  spełnionego warunku uruchomienia.
- `duplicate_event` oznacza ponowne dostarczenie tego samego zdarzenia.
  `duplicate_message` oznacza osobne zdarzenie opisujące już zapisaną wiadomość.
  `outcome=failed` oznacza błąd zapisu, po którym Canopy nie potwierdza ramki.
- Wpisy `connection=connected` i `connection=disconnected` pokazują zakres
  połączenia oraz przyczynę rozłączenia, np. błąd dekodowania ramki.

W prywatnym kanale testowym wyślij dwie odpowiedzi do tego samego wątku
obsługiwanego przez trasę, jedną ze wzmianką o aplikacji i drugą bez wzmianki.
Porównaj ich znaczniki czasu w Slacku z wpisami odbioru i wynikiem zapisu.
Brak odebranej ramki nie wskazuje sam w sobie, dlaczego Slack jej nie dostarczył.

Opis dotyczy implementacji; dostępność wydań wskazuje [release.md](release.md).
Testy z atrapą transportu nie potwierdzają poprawnej instalacji na żywym Slacku.
