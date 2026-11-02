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
aplikacji OAuth i PKCE są zaszyfrowane AES-256-GCM kluczem `OA_SECRETS_KEY`.
Żaden katalog narzędzi ani wynik API nie zawiera tych wartości. Wyniki zdalnych
narzędzi przechodzą redakcję znanych sekretów przed utrwaleniem i wysłaniem.
Błędy zewnętrznych serwerów są zastępowane komunikatem bez przyczyny/requestu.
Połączenia MCP nie podążają za redirectami; SSE nie może zmienić origin.
HTTP jest dozwolone tylko dla loopback do lokalnego developmentu; inne endpointy
wymagają HTTPS. Custom MCP jest jawną konfiguracją sieciową właściciela, także
do jego usług prywatnych; nie uruchamia procesów ani transportu stdio.

## OAuth

BFF rozpoczyna autoryzację i przekazuje callback do gateway przez uwierzytelnione
gRPC. Publiczny callback to `/api/connectors/oauth/callback` na origin Canopy.
Gateway używa MCP SDK **1.32.2**: protected resource metadata (RFC 9728),
metadata authorization servera (RFC 8414), DCR i Authorization Code + PKCE S256.
Losowy, jednorazowy state ma TTL 10 minut, wiąże konto i właściciela oraz osobny
sekret sesji przeglądarki w cookie HttpOnly/SameSite=Lax. Callback zużywa state
atomowo przed wymianą kodu. Nie ufa origin ani adresowi powrotu z parametrów URL.
Sekrety aplikacji wprowadza się raz na typ konektora w ustawieniach właściciela.
Każde konto zachowuje własną rejestrację/tokeny; odświeżanie jest serializowane
blokadą konta w PostgreSQL, również przy wielu gatewayach. Brak możliwości
odświeżenia oznacza `needs_reconnect`. Disconnect najpierw odbiera dostęp,
następnie próbuje revoke i usuwa lokalne tokeny niezależnie od wyniku dostawcy.
Delete (`DeleteConnectorAccount`) robi najpierw Disconnect (jeśli konto nie jest już
odłączone), potem usuwa konto, granty, stany OAuth i rekordy deduplikacji; wpisy audytu
zostają bez powiązania z kontem. Elementy timeline zachowują zapisaną nazwę konta.

## Harnessy i zgody

Worker otrzymuje wyłącznie deskryptory: ID konta, nazwę, schemat i opis narzędzia.
Claude Agent SDK **2.1.316**: narzędzia w istniejącym serwerze MCP w procesie
workera (`mcp__openagents__…`). Codex **0.164.0**: istniejące `dynamicTools`.
Nazwy są stabilne i rozdzielone per konto (`github_work_<id>__create_issue`),
także gdy nazwy dwóch kont są identyczne po normalizacji. Opisy podają typ i konto.
Rename unieważnia cache opisów; techniczna nazwa narzędzia pozostaje stabilna.
Wywołanie `AgentToolCall` wraca istniejącym linkiem gRPC do gateway. Gateway
sprawdza worker, właściciela wątku, bieżącą turę, grant i bieżący katalog konta.
Zmiana grantów odbiera możliwość wykonania natychmiast; katalog harnessu może
wymagać nowej sesji (Codex utrwala dynamic tools przy `thread/start`).

Boty dostają katalog kont ze swoich grantów i wykonują MCP w gateway. Istniejąca
polityka `safe` przepuszcza tylko `readOnlyHint=true`, bez `destructiveHint=true`;
pozostałe wywołania mają kartę zgody. `always` pyta także o odczyty,
`full_auto` przepuszcza narzędzia bez kart; pytania do użytkownika pozostają.
Zmiana adnotacji zdalnego narzędzia na zapis nadal wymaga zgody w `safe`,
natomiast jawne `full_auto` pozwala na zapis. Żaden tryb nie zastępuje grantu.
Rutyny w tle używają grantów i polityki tego samego bota; uruchomienie rutyny
nie nadaje dodatkowych uprawnień do kont.
Wątki: `READ_ONLY` odmawia zapisów, `ASK` i `ACCEPT_EDITS` wymagają istniejącej
interakcji permission dla narzędzi innych niż tylko odczyt, `FULL_AUTO` przepuszcza.
Zgoda nie zastępuje grantu; grant jest ponownie sprawdzany tuż przed wykonaniem.
Ponowienie call ID po reconnect nie wykonuje ponownie operacji. Nieznany wynik
po awarii nie powoduje automatycznego powtórzenia zapisu.

## Katalog dostawców — badanie 2026-11-02

„Metadata” oznacza publiczny odczyt dokumentacji/odpowiedzi endpointu, bez konta.
Żaden preset dostawcy nie jest na tej podstawie oznaczany jako live verified.

| Typ | Oficjalny endpoint MCP | Auth / DCR / PKCE | Co podaje użytkownik | Dowód i ograniczenie |
|---|---|---|---|---|
| GitHub | `https://api.githubcopilot.com/mcp/` | PAT Bearer lub OAuth, S256, refresh; protected resource metadata; AS nie ogłasza DCR | PAT albo zarejestrowana aplikacja GitHub z client ID/secret | [Oficjalny serwer](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md), HTTP 401 z `resource_metadata`; [metadata AS](https://github.com/.well-known/oauth-authorization-server/login/oauth) odczytane, issuer `https://github.com/login/oauth`; bez live |
| Notion | `https://mcp.notion.com/mcp` | OAuth 2.1, DCR, S256, refresh; także MCP token na Business/Enterprise | Zgoda konta; token MCP opcjonalnie | [Dokumentacja](https://developers.notion.com/guides/mcp/get-started-with-mcp), metadata AS odczytane; zwykły integration token nie jest tokenem MCP |
| Linear | `https://mcp.linear.app/mcp` | OAuth 2.1, DCR, S256, refresh; API key/Bearer | Zgoda albo API key | [Dokumentacja](https://linear.app/docs/mcp), metadata AS odczytane; bez live |
| Atlassian | `https://mcp.atlassian.com/v1/mcp` | OAuth, DCR, S256, refresh | Zgoda i dostęp do Jira/Confluence; ograniczenia administratora | [Dokumentacja](https://support.atlassian.com/atlassian-rovo-mcp-server/), metadata AS odczytane; endpoint i polityka tenantów wymagają live |
| Slack | `https://mcp.slack.com/mcp` | Confidential OAuth, S256, refresh; brak DCR w metadata | Zarejestrowana aplikacja Slack, client ID/secret, scopes i instalacja | [Dokumentacja](https://docs.slack.dev/ai/slack-mcp-server/), metadata wskazują user OAuth `slack.com/oauth/v2_user/authorize` i `oauth.v2.user.access`; bez live |
| Microsoft 365 / Outlook | Do ustalenia dla tenantu (Work IQ MCP / Tools registry) | Entra ID, wymagania tenantu; brak założenia o publicznym DCR | Endpoint, aplikacja Entra, zgody administratora | [Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview); preset wymaga URL tenantu, alternatywnie Custom MCP; bez zgadywanego globalnego URL |
| Google Workspace | Brak potwierdzonego ogólnego oficjalnego zdalnego MCP dla Gmail/Calendar | Zależnie od wybranego serwera | Własny zdalny MCP i jego OAuth app/token | Preset wymaga URL; nie utożsamiamy Google Cloud MCP z Workspace |
| Custom MCP server | URL właściciela, HTTP/SSE | OAuth discovery/DCR albo Bearer/własne nagłówki | URL i wymagane dane | Pełna ścieżka testowana lokalnym MCP i fake OAuth, bez zależności od kont dostawców |

## UI i audyt

Settings → Connectors pokazuje katalog, nazwane konta, stan, ostatnie użycie,
test z listą narzędzi, rename, reconnect, disconnect oraz dostęp workerów/botów.
Kontrolki korzystają z istniejącego kitu; wybór wielokrotny jest listą custom.
Sekcja Connections bota pokazuje konta z grantów; `@` ma grupę Connectors i chip
„GitHub · work”. Gateway waliduje wzmiankę względem grantu i dodaje wskazanie
konta wyłącznie do wejścia modelu. Panel wątku pokazuje dostępne konta, a oś
narzędzi — logo, typ i nazwę konta.

Audyt zapisuje konto, właściciela, worker/wątek albo bot, narzędzie, czas i wynik.
Nie zapisuje tokenów, nagłówków ani argumentów. Wynik potrzebny do deduplikacji
wykonania jest osobny od audytu i redagowany tak jak wynik na osi czasu.

## Kontrakt realizacji

`workflow_mode: autonomous-planned`, `mode_source: explicit-user-task-instruction`,
`decision_authority: delegated`, `scope: current-task`,
`artifact_state: ready-for-execution`, `execution_mode: inline`.
Użytkownik zlecił samodzielny dobór szczegółów i wdrożenie jako subagent.
Ograniczenia: bez push/PR, bez publikacji produkcyjnej, bez cudzych sekretów,
bez /tmp/oa-stack i portów 17443/5180/8444, bez trwałych testów UI.
Kryteria zakończenia: migracja, API, granty, OAuth, bridge obu harnessów, boty,
UI i dokumentacja, meaningful integration/live, kontrola light/dark 1440/390,
wymagane komendy i logiczne commity. Wyniki i zrzuty ekranu:
[raport weryfikacji](connectors-verification.md).
