# Konektory Canopy

Projekt i wdrożenie: 2026-11-02. Zakres: konta zdalnych serwerów MCP,
OAuth w gateway, dostęp wybranych workerów i botów oraz jeden kanał wykonania.

## Decyzje

Typ konektora opisuje usługę, konto opisuje nazwaną autoryzację (np. „personal”,
„work”), a grant określa dostęp. Konto należy do użytkownika. Domyślnie nie ma
grantów. „All” obejmuje również przyszłe workery/boty **tego użytkownika**;
współdzielony worker nadal widzi wyłącznie konta właściciela konkretnego wątku.
Wybrane workery i boty są niezależnymi zbiorami. Konta nie dziedziczą uprawnień
innych kont tego samego typu.

Migracja **0041_connectors** przenosi stare `bot_mcp_servers` do kont typu
`custom`, zachowując ID, nazwy, transport i odwołania do zaszyfrowanych nagłówków.
`bot_mcp_connections` stają się grantami wybranych botów. Nie powstają granty
workerów. Stare RPC pozostają adapterem zgodności; nowa konfiguracja korzysta
z Connectors. Stare tabele pozostają wyłącznie jako źródło migracji.

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
Następne pobranie narzędzi dla uprawnionego workera lub bota ponawia listing,
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
UI opisuje je jako „This computer”, a samo konto nie ma znaczka wspólności. `all_workers` i `all_bots`
są wspólne. Konkretne granty workerów zostają w domu workera (rekordy i edycja zdalna: etap 6),
a granty botów w domu bota. Przeniesienie bota nadal wymaga nadania mu dostępu w nowym domu.
Nieudany Test nie publikuje tych lokalnych pól ani nie zwiększa rewizji wspólnej konfiguracji.
Udany Test publikuje tylko rzeczywistą zmianę katalogu narzędzi; sam powrót do `connected`
nie zwiększa rewizji. Zmiana nazwy, grantów lub katalogu na innym komputerze zachowuje
lokalną diagnozę. Dopiero faktyczna zmiana wspólnych poświadczeń usuwa nieaktualny błąd
i ponownie wyznacza lokalny stan połączenia.

Rekordy `connector` i `oauth_app` inicjalizuje gateway przy starcie; migracja **0077_config_connectors**
dodaje czas zapisu aplikacji. Zapis najpierw blokuje `config_clock`, a potem konto, i zapisuje rekord
w tej samej transakcji. Definicja obejmuje typ, nazwę, URL, transport, metodę logowania, dostęp All
i narzędzia; poświadczenia wraz z nagłówkami są jednym sekretnym polem `credentials` w `config_secrets`.
Klient OAuth (także client ID i zapamiętany redirect) jest osobnym zaszyfrowanym rekordem per typ.
`GetConfigBlob` nadal obsługuje wyłącznie treść biblioteki, nigdy sekrety connectorów.

Przy scalaniu liczą się typ, URL i tożsamość konta z metadanych odpowiedzi tokenowej (np. workspace
i użytkownik). Gateway zachowuje tylko hash tych identyfikatorów; klient OAuth nie jest tożsamością konta.
Bez metadanych używa dokładnej nazwy po NFC i przycięciu spacji, tylko przy jednym kandydacie.
Konta nagłówkowe wymagają też tych samych nagłówków; różne klucze pozostają osobnymi kontami.
Mniejsze id zostaje kanoniczne, alias prowadzi do lokalnego wiersza bez przepisywania grantów.
Odwołania kont w źródłach skilli/marketplace'ów są globalne w rekordzie i lokalne po materializacji.
Gdy konto jeszcze nie dotarło, sprawdzenie źródła prosi o odczekanie i ponowienie.

## OAuth

BFF rozpoczyna autoryzację i przekazuje callback do gateway przez uwierzytelnione
gRPC. Publiczny callback to `/api/connectors/oauth/callback` na origin Canopy.
Gateway używa MCP SDK **1.32.2**: protected resource metadata (RFC 9728),
metadata authorization servera (RFC 8414), DCR i Authorization Code + PKCE S256.
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
configuration. Workers and bots lose access. A linked computer can restore it for 90 days.”
Pola notek używają etykiet „Connector”, „Name”, „Endpoint”, „Transport”, „Sign-in method”,
„All workers”, „All bots”, „Tools”, „Account”, „Credentials” i „Deleted”.

Odświeżenie tokenów jest zmianą sekretnego pola z nowym HLC. Przyjęcie nowszych poświadczeń usuwa lokalne
`needs_reconnect`; spóźniony starszy token przegrywa i pozostaje tylko w zaszyfrowanej historii.
Równoległe odświeżanie między komputerami może chwilowo skończyć się `needs_reconnect` na przegranym,
aż dotrze nowszy token. Sesje state/PKCE i ich weryfikatory zostają lokalne; stały redirect, `canopy://`
i paste-code działają jak wcześniej. Disconnect revokuje tokeny na zewnątrz, Delete nie.

## Harnessy i zgody

Worker otrzymuje wyłącznie deskryptory: ID konta, nazwę, schemat i opis narzędzia.
Claude Agent SDK **2.1.316**: narzędzia w istniejącym serwerze MCP w procesie
workera (`mcp__canopy__…`). Codex **0.164.0**: istniejące `dynamicTools`.
Nazwy są stabilne i rozdzielone per konto (`github_work_<id>__create_issue`),
także gdy nazwy dwóch kont są identyczne po normalizacji. Opisy podają typ i konto.
Rename unieważnia cache opisów; techniczna nazwa narzędzia pozostaje stabilna.
Wywołanie `AgentToolCall` wraca istniejącym linkiem gRPC do gateway. Gateway
sprawdza worker, właściciela wątku, bieżącą turę, grant i bieżący katalog konta.
Zmiana grantów odbiera możliwość wykonania natychmiast; katalog harnessu może
wymagać nowej sesji (Codex utrwala dynamic tools przy `thread/start`). Zwykłe wątki
nie zmieniają automatycznie sesji po zmianie kont lub grantów: nie mają gwarancji
pełnej odbudowy historii w nowej sesji. Istniejący wątek zachowuje kontekst, ale
nowe narzędzia Codexa wymagają nowego wątku. Odebrany grant blokuje wykonanie
również wtedy, gdy stary katalog nadal pokazuje narzędzie.

Boty dostają katalog kont ze swoich grantów i wykonują MCP w gateway. Istniejąca
polityka `safe` przepuszcza tylko `readOnlyHint=true`, bez `destructiveHint=true`;
pozostałe wywołania mają kartę zgody. `always` pyta także o odczyty,
`full_auto` przepuszcza narzędzia bez kart; pytania do użytkownika pozostają.
Zmiana adnotacji zdalnego narzędzia na zapis nadal wymaga zgody w `safe`,
natomiast jawne `full_auto` pozwala na zapis. Żaden tryb nie zastępuje grantu.
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
Ponowienie call ID po reconnect nie wykonuje ponownie operacji. Nieznany wynik
po awarii nie powoduje automatycznego powtórzenia zapisu.

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

Settings → Connectors pokazuje katalog, nazwane konta, stan, ostatnie użycie,
test z listą narzędzi, rename, reconnect, disconnect oraz dostęp workerów/botów.
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

**Aplikacja Slack jednym kliknięciem.** Slack nie ma DCR, więc każdy workspace potrzebuje
własnej aplikacji. Gateway buduje jej manifest (`apps/gateway/src/connectors/slack-app.ts`,
pola `app_manifest` i `app_create_url`): nazwa „Canopy”, opis, kolor z palety, stały
redirect URL, user scopes narzędzi Slack MCP i `settings.is_mcp_enabled: true`, bez socket mode, org deploy, token rotation
i publicznej dystrybucji. Manifest nie zawiera sekretów. „Create the Slack app” otwiera
`https://api.slack.com/apps?new_app=1&manifest_json=…` z wypełnionym manifestem;
użytkownik wybiera workspace, klika Create i Install to Workspace, a z Basic Information
kopiuje client ID i secret. „Copy manifest” to wariant ręczny. Slack pozwala używać MCP
tylko aplikacjom wewnętrznym (albo z Marketplace) — aplikacja niepubliczna (unlisted) jest
blokowana, więc instaluje się ją wyłącznie we własnym workspace. Token rotation jest
wyłączone, bo Slack nie pozwala go potem wyłączyć, a tokeny bez rotacji nie wygasają.
„Use an existing Slack app” służy współpracownikom z tego samego workspace: wklejają
client ID i secret od właściciela aplikacji, bez dopisywania redirectów. W istniejącej
aplikacji trzeba włączyć dostęp MCP w ustawieniach Slack albo ustawić
`settings.is_mcp_enabled: true` w jej manifeście. Pole scopes jest
wstępnie wypełnione tymi samymi scopes (`default_scope`). Redirect URL jest widoczny tylko
jako szczegół dla ręcznej konfiguracji.
Wskazówki są wyłącznie tekstem: nie zawierają poświadczeń i niczego nie weryfikują.

### Slack: wymagania i diagnoza

[Slack MCP](https://docs.slack.dev/ai/slack-mcp-server/) używa wyłącznie Streamable
HTTP, bez SSE i DCR. SDK wysyła `Authorization: Bearer`, Accept dla JSON/SSE oraz
wynegocjowany `MCP-Protocol-Version` w żądaniach po initialize.
[User OAuth](https://docs.slack.dev/reference/methods/oauth.v2.user.access/) zwraca
`access_token` na najwyższym poziomie, `token_type: user` i obiekt `authed_user`
z identyfikatorem i scopes. To token użytkownika (`xoxp-…`), nie token bota.
SDK przechowuje go w zaszyfrowanych poświadczeniach; nie interpretuje `user` jako
schematu nagłówka. Zwykłe `oauth.v2.access` może zwracać token użytkownika w
`authed_user.access_token`, ale jest innym endpointem i nie obsługuje naszego flow.

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

Zwykłe wątki zachowują sesję i jej historię. Codex utrwala dynamic tools przy
`thread/start`; dodanie konta lub grantu wymaga nowego wątku, aby dostać nowy katalog.
Nie uruchamiamy pustej sesji w istniejącym wątku. Odebranie grantu jest skuteczne
natychmiast w gateway, niezależnie od starego katalogu harnessu.
Claude otrzymuje nazwy narzędzi MCP w `allowedTools`, ponieważ `dontAsk` odmawia
narzędzi spoza listy przed callbackiem. Każde wykonanie nadal przechodzi przez
grant i permission mode gateway; READ_ONLY odmawia zapisów.
