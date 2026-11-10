# Konto GitHub i pull requesty

Status: **propozycja do przeglądu**, 2026-11-10. Ten dokument nie zatwierdza implementacji.
Decyzje ustalone: oficjalna GitHub App Canopy organizacji `itsoltech`, device flow,
wygasające tokeny użytkownika i implementacja dopiero po przeglądzie, jako stos PR.

## 1. Wynik i zakres

Użytkownik łączy konto, przypisuje repozytorium i czyta jego PR bez opuszczania Canopy.
Jeden wątek może mieć wiele PR, a jeden PR może należeć do wielu wątków.
Powiązania wykryte z gałęzi i dodane ręcznie mają tę samą prezentację.
**Priorytetem jest brak regresji p95 istniejących operacji.** GitHub nie wchodzi do ścieżki
otwarcia wątku, zapisu zdarzeń, ACK workera ani startu tury.

| Obszar | v1, jednocześnie web/desktop/mobile | Później |
| --- | --- | --- |
| Konto | Wiele kont osobistych i służbowych właściciela, instalacje, wybór konta per repo, istniejący PAT jako fallback | GitHub Enterprise Server, centralny broker poświadczeń |
| Powiązania | Ręczne link/unlink, wykrywanie PR gałęzi, historia powiązań, obsługa forków i stosów | Rozpoznawanie zależności całego stosu niezależnie od gałęzi |
| Czytanie | Summary, pełna stronicowana Timeline, Code, checki i odnośniki do logów | Osadzony odczyt logów, artefakty CI |
| Pisanie | Komentarz ogólny, odpowiedź w istniejącym wątku review | Nowe komentarze inline, resolve/unresolve, approve/request changes, edycja reviewerów i labels |
| Praca agenta | Ask a question, Explain this PR, Fix findings in this thread: przygotowanie szkicu z kontekstem | Merge, auto-merge, re-run CI, revert; żadne z nich nie jest ukrytą akcją v1 |

Nie tworzymy klienta git, nowego systemu zgód, własnego hostingu diffów ani mechanizmu
aktualizacji. Utworzenie PR przez istniejące narzędzia pozostaje możliwe; v1 dodaje jego powiązanie.

### Punkty oparcia w kodzie

| Istniejący mechanizm | Wykorzystanie w projekcie |
| --- | --- |
| `apps/gateway/src/connectors/{accounts,sealing,runtime,oauth}.ts`, `store/secrets.ts` | Owner scoping, AES-256-GCM z `CANOPY_SECRETS_KEY`, rotacja, redakcja błędów, odwołanie dostępu i deduplikacja efektów. Bez drugiego magazynu kluczy |
| `connectors/{catalog,auth-methods,sign-in}.ts`, `api/ui-connectors.ts` | Obecny GitHub MCP: PAT lub aplikacja OAuth użytkownika; discovery i PKCE. Nie jest to gotowy GitHub App device flow |
| `apps/worker/src/git/{heads,origin,refs}.ts`, `apps/gateway/src/worktrees/{heads,thread-branches}.ts` | Bieżący checkout i gałąź, odczyty git przez process governor, negocjacja capabilities; nie skan statusu dla każdego PR |
| `apps/gateway/src/api/{ui-service,routed}.ts`, `computers/{remote,mirror-projection}.ts` | Rozszerzenie GatewayService, tras do domu i istniejących luster; ten sam BFF i mobilny Connect |
| `apps/web/src/lib/features/threads/components/{ThreadPanel,ThreadPlacement,ThreadBranch,Composer,MessageComposer}.svelte` | Miejsce listy PR, panel/arkusz szczegółów, zachowanie szkicu i wysyłanie do wątku |

Pozostałe współdzielone elementy: `apps/web/src/lib/shared/ui/markdown/Markdown.svelte`,
`shared/ui/code/DiffLines.svelte`, `features/threads/components/Diff.svelte`,
`features/attachments/draft.svelte.ts` i `apps/gateway/src/core/core-attachments.ts`.
Mobile ma odpowiedniki w `apps/mobile/src/ui/{Diff,DiffContent}.tsx`, `ui/markdown/`,
`features/attachments/useAttachmentDraft.ts` oraz `features/threads/ThreadPanel.tsx`.
`packages/domain/src/shared-query.ts` i `shared-query-events.ts` obsługują współdzielone odczyty.

## 2. GitHub App i konta

### Instalacja i autoryzacja to dwie zgody

Administrator instaluje aplikację na koncie osobistym lub organizacji i wybiera repozytoria.
Użytkownik osobno autoryzuje działanie w swoim imieniu. Używamy **user-to-server tokenu**:
efekty są przypisane użytkownikowi, a dostęp jest przecięciem jego praw, praw aplikacji
i wybranych repozytoriów instalacji. Nie używamy tokenu instalacyjnego ani klucza prywatnego
aplikacji na gatewayach użytkowników. `GET /user/installations` i
`GET /user/installations/{installation_id}/repositories` ustalają dostępny katalog.
Publiczne repozytorium bez wybranej instalacji może mieć inne zasady API; Canopy v1 celowo
wymaga jawnego wyboru repozytorium i konta również do automatycznego wykrywania.
[Zasady tokenów użytkownika](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

| Uprawnienie repozytorium | v1 | Uzasadnienie |
| --- | --- | --- |
| Metadata | Read, obowiązkowe | Tożsamość repozytorium i dostęp instalacji |
| Pull requests | Read and write | PR, review i odpowiedzi w istniejących dyskusjach review; write nie oznacza udostępnienia merge w Canopy |
| Checks i Commit statuses | Read | Check runs/suites oraz starsze statusy commitów; oba źródła są potrzebne |
| Contents | Read | Commity i dane plików/diffu; bez push, zapisu plików i revert |
| Issues | Bez dodatkowego write | Komentarze ogólne PR przez Issues API dopuszczają również Pull requests: write; nie zarządzamy issues |

Actions pozostaje **bez uprawnień w v1**: odnośnik do checka/logów otwiera GitHub z sesją
użytkownika. Pobieranie prywatnych logów w Canopy wymagałoby Actions: read, a re-run workflow
Actions: write. Checks: write nie daje ogólnego prawa do ponawiania cudzych checków.
Bez uprawnień administracyjnych, organizacyjnych i do adresów e-mail.
[Komentarze i wymagane prawa](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment),
[re-run](https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-workflow),
[logi](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run).

### Device flow

1. **Settings → GitHub account → Connect account** wybiera komputer przechowujący konto.
   Gateway rozpoczyna `POST https://github.com/login/device/code` z publicznym client ID.
2. UI pokazuje kod użytkownika, termin ważności, **Copy code**, **Open GitHub** i **Cancel**.
   Otwiera wyłącznie zweryfikowany adres GitHub. `device_code` pozostaje zaszyfrowany w gatewayu;
   UI dostaje osobny identyfikator próby, `user_code`, URL i stan.
3. Gateway odpytuje `POST https://github.com/login/oauth/access_token`, respektując zwrócone
   `interval`, `authorization_pending` i `slow_down` (zwiększenie odstępu o 5 s).
   Odmowa, expiry i anulowanie kończą próbę; reconnect klienta nie uruchamia nowej wymiany.
4. Po sukcesie gateway ustala niezmienne GitHub user ID, login i instalacje. UI pokazuje
   **Install Canopy** albo **Manage repositories**, jeżeli repozytorium wymaga zgody administratora.
   Powrót do aplikacji odświeża katalog; instalacja nie zastępuje autoryzacji.
5. Inline **Connect GitHub** przy niedostępnym PR uruchamia ten sam przepływ i wraca do
   wybranej operacji. Nie wysyła komentarza ani wiadomości automatycznie po zalogowaniu.

Próba należy do właściciela, domu i uwierzytelnionego klienta; ma TTL z odpowiedzi GitHub,
jednego pollera i atomowe zakończenie. Restart gatewaya wznawia tylko niewygasłą próbę.
Nie ma callbacku, listenera logowania, przekierowania przez statyczną stronę ani nowego deep linku.
Istniejące `connectors/sign-in.ts` i `oauth.ts` pozostają adapterami MCP PKCE. Wydzielamy z nich
wspólne ograniczenia HTTP, redakcję i wzorzec blokowania konta. Nowy adapter device flow działa
w gatewayu; `features/providers/LoginPanel.svelte` jest wzorcem prezentacji kodu,
ale `apps/worker/src/providers/codex/login.ts` loguje do innej usługi na workerze i nie jest transportem GitHub.

### Rotacja i utrata dostępu

Access token wygasa po 8 h, refresh token po 6 miesiącach. Dla tokenów z device flow GitHub
pozwala odświeżać je z client ID, **bez client secret**. Gateway odnawia przy użyciu konta,
z marginesem 5 min, zamiast utrzymywać timer dla nieużywanych kont.
Rotowana para i jej terminy są zapisywane atomowo. Krótka dzierżawa konta z fencing/revision
serializuje odświeżanie między procesami; nie trzymamy połączenia SQL przez oczekiwanie na GitHub.
Po niepewnym wyniku wymiany nie krążymy ze starym refresh tokenem: konto wymaga ponownego logowania.
[Wygasanie i odświeżanie](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).

401 dopuszcza jedną kontrolowaną próbę refresh, następnie `needs_reconnect`.
403/404 rozróżnia brak repo, instalacji, SSO lub uprawnień od wyczerpania limitu;
nie każde 403 oznacza błędny token. Bez webhooków odebranie dostępu wykrywa najbliższe użycie
lub kontrola instalacji. **Disconnect account** natychmiast blokuje nowe operacje, anuluje odczyty,
usuwa lokalne tokeny i unieważnia cache. Pełne revoke użytkownik wykonuje na GitHub w
Settings → Applications → Authorized GitHub Apps → Canopy → Revoke; usuwa to autoryzację
także na innych komputerach. Nie obiecujemy zdalnego revoke endpointem wymagającym client secret.
Usunięcie instalacji i revoke autoryzacji są odrębne. Nowe konta nie mają historii Restore tokenów.
Przy aktywnym użyciu odświeżamy katalog instalacji co 15 min, a po powrocie z Manage repositories
od razu; każde wykonanie nadal sprawdza aktualną rewizję dostępu i odpowiedź GitHub.

Konta identyfikuje `(owner, host, GitHub user ID, dom)`, nie login ani nazwa „Work”.
Ponowne logowanie do tego samego konta aktualizuje tokeny; inne konto jest osobnym rekordem.
Mapowanie `(owner, dom, repository ID) → account ID` jest jawne. Jeden uprawniony kandydat może
być proponowany; kilka wymaga wyboru. Zmiana konta nie ponawia zapisów i usuwa dane starego
kontekstu dostępu. Identyfikatory GitHub przeżywają rename/transfer repozytorium i zmianę loginu.
Nie próbujemy kolejno kont po odmowie zapisu. PAT jest wyłącznie jawnym fallbackiem wskazanym
z istniejącego, własnego konta GitHub w Connectors; bez kopiowania tokenu do nowego rekordu.
Użycie REST/GraphQL wymaga sprawdzenia jego praw i przypisania repo, niezależnie od testu MCP.
Własny endpoint MCP i jego dowolne nagłówki nie są źródłem tokenu do GitHub API.

### Połączone komputery

**Domem konta jest gateway obsługujący wątek.** Konto na A nie udziela samo dostępu B.
UI na A może przeprowadzić device flow na B przez uwierzytelnione łącze; kod urządzenia,
token i refresh pozostają na B. Alternatywnie użytkownik loguje się niezależnie na każdym domu.
Nie budujemy trasowania B → A → GitHub ani synchronizacji rotowanych tokenów.
Serwerowy gateway bez linked computers przechowuje konta swoich właścicieli lokalnie.

`api/routed.ts`, `computers/remote.ts` i negocjowana capability `github_pr_v1` przenoszą wyłącznie
dozwolone RPC i DTO bez sekretów. Id kwalifikowane domem działają jak identyfikatory wątków.
Mirror wątku zawiera małe podsumowanie PR; strony szczegółów pobrane online mogą pozostać
w ograniczonym cache odczytu partnera, z domem i właścicielem w kluczu.
Po utracie B można przeczytać dostępne dane z datą aktualizacji, lecz komentarze, link/unlink,
Viewed i odświeżanie wymagają domu. Nic nie czeka w kolejce do ponownego połączenia.
Unlink komputerów usuwa projekcje i cache partnera.

To świadomie inna własność niż istniejący GitHub MCP: `config-sync/connector-records.ts`
publikuje konta konektorów i szyfruje ich poświadczenia na każdym partnerze.
Nowe `github_accounts` **nie są** rekordami `connector` ani `oauth_app` wspólnej konfiguracji.
PAT fallback zachowuje dotychczasowe zasady swojego konektora; moduł PR korzysta z lokalnej
kopii i nigdy nie dodaje kolejnego kanału kopiowania sekretów.

### Czynności maintenera przed implementacją auth

Rejestracja:

1. Na GitHub otworzyć `itsoltech` → Settings → Developer settings → GitHub Apps → New GitHub App,
   używając konta właściciela organizacji albo uprawnionego app managera.
2. Ustawić nazwę **Canopy** (jeśli zajęta: **Canopy GitHub**), opis i Homepage URL
   `https://github.com/itsoltech/canopy`; zapisać otrzymany slug instalacji.
3. Zaznaczyć **Enable Device Flow** i pozostawić **Expire user authorization tokens**.
   Nie zaznaczać **Request user authorization (OAuth) during installation**; używamy osobnej autoryzacji.
4. Pozostawić Callback URL i Setup URL puste, wyłączyć **Active** w sekcji Webhook.
   Nie wybierać zdarzeń: lokalne gatewaye nie mają publicznego odbiornika.
5. Ustawić dokładnie prawa z tabeli, bez Actions i dodatkowego Issues: write, a instalację dopuścić
   na **Any account**, aby użytkownicy mogli wskazać własne organizacje i repozytoria. Utworzyć aplikację.

Konfiguracja i pilotaż:

1. Zapisać **Client ID**, App ID i slug. Client ID jest publiczny, App ID nie zastępuje go w OAuth.
   Proponowana konfiguracja gatewaya: `CANOPY_GITHUB_APP_CLIENT_ID` i `CANOPY_GITHUB_APP_SLUG`;
   oficjalna dystrybucja dostaje publiczne wartości jako domyślne dopiero w PR implementacyjnym.
2. Nie generować client secret ani private key dla tego przepływu. Ewentualne sekrety administracyjne
   trzymać poza repozytorium i binariami. Nie wpisywać tokenów użytkowników do konfiguracji procesu.
3. Zainstalować aplikację na wybranym repozytorium testowym przez stronę instalacji aplikacji.
   Druga organizacja wymaga akceptacji jej administratora; zanotować ten stan w UX instalacji.
4. Po wdrożeniu warstwy auth zalogować konto testowe device flow i sprawdzić instalacje,
   odświeżenie, Disconnect i revoke. To test opt-in z autoryzacją, bez tokenów w logach.
5. Przy każdej późniejszej zmianie permissions uzyskać zgodę instalacji przed włączeniem akcji.
   Maintener zarządza rejestracją aplikacji; właściciel gatewaya zarządza swoimi kontami.

[Rejestracja GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

## 3. Klient gatewaya, cache i koszt

Nowy moduł domeny `apps/gateway/src/github/` grupuje adapter auth, klienta, store, poller
i projekcje; nie tworzymy osobnego procesu, brokera wiadomości ani usługi poświadczeń.
GraphQL jest pierwszym wyborem dla nagłówka PR, review, timeline i zbiorczych podsumowań
checków (`statusCheckRollup`, osobne stronicowanie contexts). Stałe zapytania z variables;
klient nie przyjmuje query ani endpointu od UI/modelu. Częściowe błędy GraphQL nie wymazują
poprawnych pól; każde źródło ma stan complete/partial/unavailable i czas weryfikacji.

REST uzupełnia instalacje, wykrywanie po head ref, pliki/patch oraz komentarze i odpowiedzi.
Warunkowy GET z ETag/Last-Modified dotyczy tylko endpointów, które go obsługują.
Poprawnie autoryzowane 304 nie zużywa podstawowego limitu REST, ale nadal kosztuje sieć
i może podlegać limitom wtórnym. GraphQL POST nie dostaje fikcyjnego ETag.
[Warunkowe odczyty](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests).

Cache PostgreSQL jest współdzielony przez UI, autodetekcję i procesy tego gatewaya;
mały LRU RAM ogranicza deserializację. Klucz zawiera owner, dom, account, rewizję dostępu,
repository ID, PR, parametry strony i SHA. Nigdy nie współdzielimy prywatnej treści między
właścicielami ani kontami. Single-flight i krótka dzierżawa SQL deduplikują odczyt;
I/O HTTP odbywa się poza transakcją. Po zmianie zapisujemy tylko zmienione projekcje i publikujemy
rewizję przez istniejący Hub/owner feed. `QueryCache` web/mobile odrzuca spóźnione odpowiedzi.

### Limity i ponowienia

REST użytkownika ma typowo **5000 żądań/h**, współdzielone z jego PAT i innymi aplikacjami.
GraphQL ma osobny podstawowy budżet **5000 punktów/h**, również współdzielony dla użytkownika;
jedno zapytanie nie musi kosztować jednego punktu. Nie zakładamy podwyższonych limitów Enterprise.
Odczytujemy `x-ratelimit-*`, resource, `retry-after` oraz GraphQL `rateLimit { cost remaining resetAt }`.
Konta tego samego GitHub user ID korzystają ze wspólnego lokalnego licznika; inne gatewaye
nie znają wzajemnego zużycia, więc nagłówki GitHub są nadrzędne.
[REST](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
[GraphQL](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api).

Jedna kolejka na użytkownika GitHub, maksymalnie jeden request w toku; globalnie dwa.
Interakcje mają pierwszeństwo przed pollingiem. Zapis jest serializowany z odstępem co najmniej 1 s.
Przy remaining < 20% wstrzymujemy tło, < 5% także zwykłe odświeżanie; UI podaje termin resetu.
429/limitowe 403 respektuje retry-after/reset, a limit wtórny bez nagłówka zaczyna od 60 s,
z wykładniczym backoffem i jitterem, do 15 min. Dla odczytu po błędzie sieci/5xx najwyżej
dwa ponowienia (2 s, 8 s); potem stary snapshot i Retry. Nie ponawiamy automatycznie mutacji.
`client_request_id` i zapisany fingerprint/wynik wzorujemy na `connectors/runtime.ts`;
niepewny wynik komentarza wymaga odczytu i decyzji użytkownika, zamiast ryzyka duplikatu.

### Polling bez webhooków

Obserwator oznacza widoczny ekran, nie samo otwarte połączenie. Web używa widoczności strony,
mobile AppState i fokusu ekranu; krótka odnawiana dzierżawa widoku wygasa po 90 s.
Wiele kart/urządzeń współdzieli najszybszy potrzebny harmonogram.

| Widoczność | Harmonogram startowy | Zakres |
| --- | --- | --- |
| Otwarty PR | Checki co 15 s, gdy pending/in progress; inaczej 60 s. Nagłówek i najnowsza strona timeline co 60 s | Tylko widoczny PR; starsze strony na żądanie |
| Widoczny panel wątku | Co 60 s | Zbiorcze nagłówki/checki, bez opisów, timeline i diffów |
| Aktywny wątek w tle | Co 5 min | Repo/znane head ref, maksymalnie 10 PR na zapytanie zbiorcze |
| Brak obserwatorów i aktywności albo archiwum | Brak okresowego pollingu | Wznowienie po otwarciu, zmianie gałęzi/pushu lub ręcznym Refresh |
| Closed/merged bez widocznego widoku | Jeden końcowy odczyt, potem tylko otwarcie/Refresh | Widoczny widok nadal odświeża nowe komentarze według pierwszego wiersza |

Wymagane przez endpoint `x-poll-interval` jest dolną granicą. Terminy mają jitter ±20%.
Aktywność w tle oznacza running/queued lub zmianę checkoutu w ostatnich 15 min, nie samo istnienie wątku.
Grupujemy według `(owner, account, repo)`, do 10 znanych PR/head ref na partię; GraphQL aliases
ograniczają liczbę round-tripów, bez pobierania wszystkich PR repozytorium.
Strony discovery są doczytywane przy pierwszym wykryciu lub na żądanie, nie w każdym ticku.
Po komentarzu unieważniamy tylko dany PR. Zmiana head SHA unieważnia checki i pliki.

Offline zachowujemy ostatni dozwolony snapshot, etykietę **Updated …** i przyczynę z Retry.
Nie przedstawiamy starego wyniku CI jako wyniku nowego SHA. Brak strony w cache daje
**Connect to load this page**. Przy potwierdzonej utracie uprawnień usuwamy treść cache
danego konta/repo i projekcje partnera online; partner offline może nadal mieć wcześniejszą,
oznaczoną jako nieaktualna kopię, jak istniejące lustra wątków. Nie obiecujemy zdalnego wymazania offline.

### Budżet wydajności

Założenie do oszacowania: 1 widoczny PR z trwającym CI, 10 aktywnych repo w tle,
jedna strona nagłówka/timeline, bez przewijania. Checki to 240 odczytów/h, szczegóły 60/h,
tło do 120/h: **do 420 requestów/h**, około **420–2100 punktów GraphQL/h** przy koszcie 1–5.
REST discovery/ETag to dodatkowo do 120 odczytów/h, często 304; uwzględniamy je w kolejce.
Kilka PR jednego repo dzieli partię, różne repo zwiększają koszt liniowo.
Lokalny miękki limit Canopy to 1500 punktów GraphQL i 1000 requestów REST/h/użytkownika;
poller wydłuża odstępy, gdy pomiar kosztu nie mieści się w limicie. To budżet Canopy, nie limit GitHub.

Typowa odpowiedź ma mieć ≤ 64 KiB; przy 540 odpowiedziach/h to około 34 MiB/h.
Założone 1–5 ms CPU na walidację/projekcję daje 0,5–2,7 s CPU/h, czyli < 0,1% jednego rdzenia.
To **szacunki bez pomiaru**, nie gwarancja; strony historii i diffy liczymy osobno.
Limity: 2 MiB na odpowiedź upstream/stronę, 32 MiB LRU RAM na gateway, 128 KiB nagłówka PR,
256 KiB patcha na plik. Parser i renderer nigdy nie otrzymują całego PR w jednym przebiegu.

Cel nowych odczytów z ciepłego cache: p95 ≤ 50 ms w gatewayu; pierwszy obraz danych
w kliencie ≤ 150 ms bez czasu sieci do GitHub. Osobno mierzymy cold fetch i deklarujemy stale.
W istniejących operacjach dopuszczamy **zero dodatkowych wywołań HTTP i procesów git**.
Do overview trafia tylko najnowszy PR + count + rewizja, nie lista ani treść PR.
Skanowanie wyników narzędzi i polling działają poza transakcją ingestu/ACK i poza blokadą wątku.
Przy presji SQL/event loop najpierw ograniczamy polling i prefetch.

Warunek wydania implementacji: porównanie baseline/kandydat przy takim samym obciążeniu
GetOverview/GetThread, dispatch tury, ingest/ACK i renderowania web/mobile, także z niedostępnym
GitHub i partnerem. Powtarzalny wzrost p95 ponad niepewność pomiaru blokuje wydanie.
Korzystamy z metod `docs/database-performance.md` i `docs/client-performance.md`;
obecny PR dokumentacyjny nie uruchamia benchmarków ani nie deklaruje ich wyników.

## 4. Dane i retencja

Nazwy poniżej są projektem nowych tabel, nie opisem istniejącego schematu.
Każda relacja ma `owner_user_id`; klucze obce i unikalności obejmują właściciela.
Sam UUID, GitHub node ID, repo ID lub URL nigdy nie jest uprawnieniem do odczytu.

| Tabela/relacja | Klucz i dane |
| --- | --- |
| `github_accounts` | UUID, owner, host, GitHub user ID/login, nazwa, dom, auth kind, status, access revision; zaszyfrowana para tokenów albo FK do własnego PAT connectora, nigdy oba |
| `github_installations`, `github_installation_repositories` | Owner + account + installation ID; właściciel instalacji, permissions, selected/all, suspended, repo ID i kanoniczna nazwa, czas weryfikacji. Wiersze instalacji powtarzają się per autoryzowany użytkownik |
| `github_repository_accounts` | Owner + repo ID → lokalne account/installation ID, jawny wybór i rewizja; brak globalnego domyślnego konta dla zapisów |
| `github_pull_requests`, `thread_pull_requests` | Kanoniczny PR: owner + host + repository ID + number/node ID. Relacja many-to-many: owner + thread + PR, `source=auto/manual`, evidence=branch/tool_output, branch/repo/SHA w chwili powiązania, created/last_seen, `unlinked_at` |
| `github_pr_cache`, `github_pr_pages`, `github_pr_checks`, `github_pr_viewed` | Cache izolowany account/access revision; nagłówek, ETag, SHA, fetched/verified, completeness, strony timeline/review/files i podsumowania CI. Viewed: owner + GitHub user ID + PR + head SHA + path |

`unlinked_at` jest tombstone'em, a nie DELETE: blokuje ponowne auto-link dla pary wątek–PR
niezależnie od nowej gałęzi i źródła wykrycia. Ręczne Link świadomie go usuwa, po ponownej
weryfikacji repo. Transakcja auto-link sprawdza tombstone ponownie pod blokadą.
Oddzielna historia kontekstu checkoutu zapisuje zmiany repo/head ref/pełnego SHA i czas;
nie zmieniamy niezmiennych `threads.cwd` ani `worktree_id`.

Tokeny szyfrujemy istniejącymi `encryptSecret/decryptSecret` (`store/secrets.ts`), z key ID
i kontrolą owner przed odszyfrowaniem, według `connectors/sealing.ts`. Nie wchodzą do cache DTO.
Do nowej tabeli prób auth trafiają zaszyfrowany device code, owner/client binding, TTL i stan.
Receipty mutacji przechowują request ID, fingerprint, status i identyfikator wyniku, bez tokenu.
Stan pollera ma termin, dzierżawę i rewizję; jeden producent na klucz również po restarcie.

Retencja cache: nieużywane nagłówki 30 dni, strony timeline/checków 7 dni, patche 24 h;
limit 100 MiB treści na owner/dom z LRU według ostatniego odczytu. Nie jest to archiwum GitHub.
Powiązany PR zachowuje małą tożsamość po wygaśnięciu treści. Viewed nieaktywnego SHA wygasa po
30 dniach; aktywny stan zostaje. Próby auth usuwamy najpóźniej 24 h po TTL, sekret od razu po
zakończeniu. Receipty i tombstone'y zostają do fizycznego usunięcia wątku/właściciela,
aby restart i retencja nie powielały zapisów ani nie przywracały odpiętych PR.

Sprzątanie rozszerza `apps/gateway/src/maintenance/{job,prune}.ts`: małe partie, istniejące
timeouty i brak I/O sieciowego w transakcji; nie nowy pełnotabelowy skan.
Unpair czyści cache klienta i partnera. Disconnect/revoke czyści sekrety i dane dostępu;
usunięcie konta nie kasuje tożsamości powiązań ani ich tombstone'ów.
Każda migracja w `packages/db/src/migrations/` dostaje **aktualne maksimum + 1** przy implementacji;
nie rezerwujemy dziś numerów. Po zmianach równoległych renumerujemy nowe pliki, nie ruszamy
zastosowanych migracji i aktualizujemy `packages/db/test/schema.test.ts`.

## 5. Wykrywanie i reguły powiązań

1. Dom pobiera kontekst właściwego checkoutu: `Thread.worktree` lub `checkout_head`, workspace,
   aktualną gałąź, pełny HEAD OID, tracking/push remote i znormalizowane repozytoria remotes.
   `ReadWorkspaceOrigin` daje dziś tylko origin, a `GitHeads` gałąź lub skrócony detached commit.
   Dodajemy capability `git_pr_context_v1` i addytywny, nietrwały odczyt kontekstu,
   współdzielony dla checkoutu. Nie udajemy, że obecne DTO mają komplet danych.
2. Worker odczytuje konfigurację i refy przez istniejący process governor, bez shella, fetch,
   hooków i promptów. Cache 30 s, debounce 1 s po zmianie; limit 2 s, najwyżej 8 remotes.
   Używa `normalizeGitOrigin` z `packages/domain/src/projects.ts`; zwraca tylko tożsamości,
   nigdy surowe URL ani poświadczenia. Zachowuje rozróżnienie fetch URL i push URL.
3. Gateway rozpoznaje wyłącznie `github.com/owner/repo`, po czym ustala trwałe repository ID.
   HTTPS, SSH i scp-like są równoważne; usuwamy `.git`, a porównanie nazwy GitHub ignoruje case.
   Lokalne ścieżki i inne hosty nie uruchamiają API. SSH alias wymaga jawnego wskazania repo;
   nie rozwiązujemy go przez dowolną konfigurację sieciową ani próbne połączenie.
4. Kandydaci head repo: push remote/pushRemote, potem tracking i origin. Kandydaci base repo:
   jawne repo projektu, upstream remote i znany rodzic forka z GitHub. Pytamy każdy jednoznaczny
   base o `pulls?state=all&head=HEAD_OWNER:REF`; weryfikujemy też **head repository ID**,
   head ref i base repository ID odpowiedzi. Sama zgodność loginu i nazwy gałęzi nie wystarcza.
5. Open/draft z pasującym repo/ref wiążemy, jeśli SHA jest zgodny lub worker potwierdza lokalnie
   relację przodka do HEAD (lokalne commity jeszcze niewypchnięte). Dla closed/merged wymagamy
   pełnego zgodnego head SHA albo wcześniej zapisanego dowodu tego samego epizodu gałęzi.
   Nieznany commit, detached HEAD bez takiego dowodu i kilka możliwych repo dają sugestię do
   ręcznego wyboru. Nie zgadujemy po tytule, podobieństwie ani samym skrócie SHA.

Head ref jest nazwą gałęzi zdalnej z konfiguracji tracking/push refspec, nie zawsze lokalną nazwą
gałęzi. Rozbieżne albo złożone refspec bez jednoznacznego celu wymagają ręcznego wskazania repo/ref.

REST paginujemy po Link, maksymalnie 100 wyników na przebieg discovery; kolejne strony są
kontynuacją z kursorem i wspólnym budżetem, z jawnym stanem **More results available**.
Brak dopasowań cache'ujemy 5 min. Dla forków pytamy bazowe repo o head właściciela forka,
nie o gałąź właściciela bazy; niedostępny/usunięty fork nie usuwa istniejących powiązań.

Wyzwalacze: otwarcie wątku/panelu, zmiana `GitHeads`, potwierdzone SwitchThreadBranch,
wynik rozpoznanego push/utworzenia PR, koniec tury i polling aktywnych repo.
Obecnie nie ma niezawodnego zdarzenia push; wynik narzędzia jest wskazówką, a okresowy
odczyt kontekstu aktywnego checkoutu wykrywa zmianę SHA również poza agentem.
Nie parsujemy polecenia powłoki jako dowodu udanego push. Jeden checkout z wieloma wątkami
współdzieli wykrycie, ale każdy link i tombstone należą do konkretnego wątku.

Zmiana gałęzi zachowuje wcześniejsze PR w sekcji historycznej i wykrywa nowe dla bieżącej.
Ponowne użycie nazwy gałęzi nie przyciąga dawnych merged PR bez dowodu SHA/epizodu.
Wiele PR z tego samego head do różnych baz można powiązać równocześnie.
Stos z różnymi head refs wymaga ręcznego linku albo dowodu utworzenia PR w tym wątku;
nie dołączamy wszystkich PR bazowej gałęzi. Fork/side thread nie kopiuje ręcznych linków
ani tombstone'ów, ale może niezależnie wykryć PR wspólnego checkoutu.
Przeniesienie wątku zachowuje tożsamości linków/tombstone'y, wymaga mapowania konta w nowym domu
i nie przenosi tokenu; domy bez capability nie przyjmują migracji zawierającej te dane.

### PR utworzone przez agenta

Preferujemy strukturalny wynik istniejącego wywołania GitHub connectora, potem URL z zakończonego
ToolCall, np. wyniku `gh pr create`. Detektor w gatewayu po commicie ingestu analizuje najwyżej
64 KiB zakończonego wyniku i 8 URL, deduplikuje po event/item ID oraz PR. Nie skanuje delt tokenów.
Trwały watermark pozwala nadrobić po awarii między ACK a wykryciem, bez zmiany semantyki ACK.

URL jest **niezaufaną wskazówką**: tylko dokładny host `github.com`, ścieżka
`/owner/repo/pull/<dodatni numer>`, bez userinfo, query i dowolnych redirectów. Gateway ustala PR
własnym klientem, sprawdza owner i zgodność repo/head z zapisanym kontekstem tury.
Obcy PR pokazuje jako sugestię; wynik narzędzia może cytować cudzy link.
Rejestracja jest `source=auto`, evidence=`tool_output`, i respektuje unlink.
Opcjonalne przyszłe narzędzie jawnego linkowania korzysta z tego samego handlera i zgód.

Canopy nie ustawia `GH_TOKEN`, credential helpera ani loginu `gh` na workerze.
`gh` używa własnej autoryzacji urządzenia, jeśli użytkownik już ją skonfigurował;
bez niej agent korzysta z istniejącego gatewayowego connectora z odpowiednim grantem.
Samo połączenie GitHub App nie nadaje agentom ani botom dostępu do konta.

## 6. Proto i API UI

Rozszerzamy istniejący **`canopy.ui.v1.GatewayService`**, z wiadomościami w nowym
`proto/canopy/ui/v1/github.proto`. To domena w istniejącej usłudze, nie drugi serwer API.
`api/ui-github.ts` składa handlery analogicznie do `ui-connectors.ts`.

| Grupa RPC — proponowane nazwy | Kontrakt |
| --- | --- |
| `ListGitHubAccounts`, `BeginGitHubDeviceAuth`, `GetGitHubDeviceAuth`, `CancelGitHubDeviceAuth`, `DisconnectGitHubAccount` | DTO konta i stanu próby bez tokenów/device code; żądania mają dom, nie dowolny URL |
| `ListGitHubInstallations`, `ListGitHubRepositories`, `SetGitHubRepositoryAccount` | Stronicowany katalog dostępnych repo, jawny wybór konta i expected revision |
| `ListThreadPullRequests`, `LinkThreadPullRequest`, `UnlinkThreadPullRequest`, `RefreshPullRequest` | Thread ID + kanoniczna tożsamość PR; link zweryfikowany w gatewayu; tombstone atomowy |
| `GetPullRequest`, `WatchPullRequest`, `ListPullRequestTimeline`, `ListPullRequestFiles`, `GetPullRequestDiff` | Nagłówek, checki, cursory i rewizje; patch tylko dla wskazanego pliku i SHA |
| `CreatePullRequestComment`, `ReplyPullRequestReviewThread`, `SetPullRequestFileViewed`, `PreparePullRequestContext` | Idempotentne mutacje; reply ID musi należeć do PR; context zwraca zwykłe Attachment DTO, nie wysyła tury |

Wspólne typy: `PullRequestRef`, `PullRequestSummary`, `PullRequestSnapshot`, `PullRequestLink`,
`PullRequestTimelineItem` z oneof zdarzenia, `PullRequestCheck`, `PullRequestFile`, `PageInfo`.
Ref zawiera host, repository ID/nazwę, numer i dom; nie polegamy na samym `#123`.
Każda odpowiedź podaje rewizję, head SHA, fetched/verified i kompletność. Pola i numery są
wyłącznie addytywne. `proto/canopy/update/v1` pozostaje nietknięte; `WORKER_LINK_PROTOCOL = 1`
zostaje przy addytywnej capability kontekstu git. Generujemy `bun run gen` i sprawdzamy `gen:check`.

Fetch zwraca cache od razu i zleca odświeżenie. `WatchPullRequest` wysyła początkowy snapshot,
następnie zmienione podsumowanie/checki oraz invalidacje stron; nie całą historię co tick.
Nie jest to stream GitHub: poller jest jedynym producentem. Po luce klient ponawia fetch
i rewaliduje załadowane strony. Panel wykorzystuje `WatchThread` i małe pole podsumowania
w `ui.Thread`; pełną listę pobiera osobno. Odrębna rewizja PR nie zwiększa historii tokenowych delt wątku.

Timeline pobiera ostatnie 50 zdarzeń (`last/before`), pokazuje je od najnowszych i doczytuje starsze.
Normalizuje otwarcie/zamknięcie/merge/reopen, commity, komentarze, review, zmiany reviewerów,
etykiet i gałęzi oraz pozostałe typy z bezpiecznym opisem i linkiem źródłowym.
Review threads, ich odpowiedzi i check contexts mają własne cursory, także ponad pierwsze 100.
Nieznany typ zdarzenia pozostaje widoczny jako zdarzenie źródła; „pełna” nie oznacza jednej strony.
Filtr autorów/typów i sortowanie komentarzy mają zakres całej kolekcji, nie tylko załadowanego okna.
Jeżeli GitHub nie obsługuje filtra, gateway przegląda strony partiami na żądanie w ramach tego samego
budżetu. Do końca przeglądu UI oznacza wynik jako częściowy i pozwala kontynuować lub anulować.
Sort odwrotny używa drugiego kierunku paginacji. Usunięcia/edycje rewalidujemy po otwarciu strony.
Kursor Canopy wiąże owner, account, PR, filtr i generację; nie przyjmuje cudzych cursorów/URL.

Pliki: strony po 30 (maks. 100), commity stronicowane osobno. Domyślnie **All commits**;
wybór jednego commitu pokazuje jego zmiany względem pierwszego rodzica z jawną etykietą.
Nie oferujemy dowolnych zakresów commitów w v1. Patch pobiera dopiero otwarcie pliku
przez `GetPullRequestDiff`, renderowane jest tylko aktywne okno.
REST `/pulls/{number}/files` dołącza patch już do strony plików: gateway zachowuje go w ograniczonym
cache, ale nie wysyła klientowi razem z listą. **Lazy per file dotyczy API Canopy i renderowania;
GitHub nie oferuje tutaj osobnego endpointu patcha pojedynczego pliku.**
Nie pobieramy pełnego `.diff` PR, aby wyciąć jeden plik.

Maksimum patcha: 256 KiB lub 4000 wierszy; odpowiedź strony 2 MiB.
Brak patcha nie oznacza pustej zmiany: binary, zbyt duży plik, rename, usunięcie i ograniczenie
GitHub mają osobny stan z **Open on GitHub**. Nie pobieramy binariów, LFS ani obrazów automatycznie.
REST ogranicza listę do 3000 plików; większy PR pokazuje granicę i link do źródła.
Cache plików wiążemy z parą base/head SHA oraz filtrem commitu. Kontrola SHA przed i po pobraniu
odrzuca wynik po równoległym push; klient dostaje **Changes updated. Refresh the files.**
[Pliki PR i ograniczenie API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files).

BFF `apps/web/src/routes/api/github/**` używa tych samych protobuf JSON/SSE i reguł origin co
pozostałe API; nie podaje tokenu do przeglądarki. Mobile wywołuje te RPC istniejącym przypiętym
Connect (`apps/mobile/src/api/pinned.ts`). Nowe metody dopisujemy jawnie do allowlist urządzeń
i linked computers; nie otwieramy całego GatewayService. Starszy dom pokazuje **Update this computer**,
bez awaryjnego odpytywania GitHub przez przeglądarkę. Przez pośrednika przekazujemy wyłącznie
przecinające się capability i istniejące zgody udostępniania; nie dodajemy dodatkowego hopa.

## 7. Interfejs web i desktop

Pokazane materiały referencyjne przedstawiają neutralny układ: listę PR pod gałęzią,
osobny widok z nagłówkiem i trzema zakładkami, a także menu akcji przy danym PR.
Przenosimy przepływ, korzystając z istniejących paneli, nawigacji i komponentów Canopy.
Obecny `features/navigation/AppShell.svelte` organizuje widoki trasami, bez ogólnego paska
kart dokumentów. PR dostaje własny adres i zakładki w tym widoku; nie budujemy przy okazji
nowego systemu okien. Powrót do wątku zachowuje jego szkic i pozycję przewijania.

1. **Panel wątku.** Pod `ThreadPlacement`/Branch lista **Pull requests**: tytuł, repo gdy potrzebne,
   `#number`, stan i checki. Domyślnie najnowszy PR bieżącej gałęzi według utworzenia;
   **Show N more** rozwija resztę. Historyczne powiązania są oznaczone osobno, ręczne pozostają
   dostępne po zmianie gałęzi. **Link pull request** przyjmuje URL. Pusty wynik nie jest błędem auth.
2. **Nagłówek PR.** Repo, numer, tytuł, autor, updated time, `base ← head`, liczba plików, +/−,
   stan Open/Merged/Closed/Draft. `gh pr checkout N` jest kopiowalnym tekstem; dopisek określa repo.
   Kopiowanie nie uruchamia komendy ani nie zmienia lokalnej gałęzi. Długi tytuł zawija się;
   po przewinięciu nagłówek jest kompaktowy, ale zachowuje stan i nawigację.
3. **Summary.** Reviewers i labels tylko do odczytu, opis Markdown, lista checków i komentarze.
   Checki pokazują queued/in progress/success/failure/cancelled/skipped/neutral/timed out,
   nazwę wykonawcy, SHA i link. Brak checków/niepełny odczyt nie jest „All checks passed”.
   Wynik zbiorczy dotyczy wykonanych checków, nie gwarantuje spełnienia branch protection.
4. **Timeline.** Zdarzenia, commity, komentarze i reviews od najnowszych. Rozwinięcie review
   doczytuje dyskusje i odpowiedzi; zachowuje identyfikatory, autorów, permalink i oznaczenie
   outdated/resolved. Paginacja nie przesuwa właśnie czytanego zdarzenia.
5. **Code.** Lista/drzewo plików, +/−, Viewed, filtr commitu, Stacked/Side by side, wrap,
   widoczność whitespace i drzewo. Są to rozszerzenia `DiffLines`/`diff-layout.ts` i mobilnego
   `DiffContent`, nie nowy parser. Whitespace jest przełącznikiem prezentacji znaków;
   rzeczywisty patch i liczniki pozostają zgodne z GitHub, bez udawania nowego porównania git.

Viewed zapisujemy **per konto GitHub w obrębie właściciela Canopy**, we wspólnym stanie domu,
nie per urządzenie. Niezależne domy nie scalają Viewed między sobą.
Klucz head SHA + path powoduje reset po push. UI wyjaśnia **Viewed in Canopy**;
v1 nie zmienia flagi Viewed na GitHub. Zmiana konta nie przenosi znacznika.
Układ diffu, wrap, drzewo i filtry prezentacji są preferencjami urządzenia, jak dzisiejszy diff.

Komentarz ogólny i odpowiedź w review wymagają świadomego **Post comment**/**Reply**;
UI pokazuje login i repo. Cytowanie komentarza ogólnego tworzy nowy komentarz z cytatem,
nie fikcyjną odpowiedź review. Szkic pozostaje po błędzie; przy niepewnym wyniku przycisk
ponownego wysłania ustępuje sprawdzeniu publikacji. Nie ma offline send.
Approve/request changes, resolve, merge, revert i re-run są odłożone na wszystkich klientach.
Logi oraz uruchomienie ponowienia można otworzyć na GitHub; v1 nie udaje wykonania w Canopy.

Menu v1: **Unlink from this thread**, **Refresh**, **Ask a question**, **Explain this PR**,
**Fix findings in this thread**, **Open on GitHub**, **Copy link**, **Copy PR number**.
Bez kontekstu wątku pierwsza i trzecia grupa wymaga wybrania docelowego wątku.
Unlink usuwa tylko relację Canopy, z Undo ponownie wykonującym ręczne Link;
nie zamyka PR. Nie pokazujemy nieczynnego **Revert changes** bez możliwości wykonania.

### Kontekst dla agenta

Wszystkie trzy akcje dodają do szkicu usuwalny plik kontekstu PR i ewentualny edytowalny tekst,
zachowując istniejącą wiadomość i załączniki. **Nie wysyłają tury.** Ask a question tylko ustawia
fokus w polu, Explain dodaje prośbę o wyjaśnienie, Fix findings prośbę o ocenę i naprawę
wskazanych uwag. Użytkownik widzi zakres, SHA, czas snapshotu i może otworzyć/odłączyć plik.

`PreparePullRequestContext` tworzy własny załącznik przez istniejący store/prepare attachment;
`AttachmentDraft`, `MentionKind.ATTACHMENT`, `SendMessage.attachment_ids`, notatka platformy
i workerowy FetchBlob pozostają kanałem dostarczenia. Dodajemy przyjęcie gotowego Attachment DTO
do szkicu web/mobile, zamiast osobnego transportu plików PR.

| Akcja | Zawartość zamrożonego pliku |
| --- | --- |
| Ask a question | Kanoniczny URL, repo/number/node ID, tytuł, autor, stan, base/head SHA, opis, liczniki plików i checków |
| Explain this PR | Powyższe + lista plików, wybrane/pierwsze patche do limitu i ostatnie review summaries |
| Fix findings in this thread | Metadane + wybrane lub nierozwiązane uwagi z ID/permalink, ścieżką, linią, SHA i informacją outdated; odpowiednie fragmenty diffu, wyniki nieudanych checków bez logów |

Limit: 1 plik `.md` na PR, 64 KiB metadanych/tekstu i do 256 KiB diffów, razem ≤ 320 KiB;
do 20 uwag i 20 plików, najwyżej 3 PR w jednej wiadomości, dodatkowo zwykłe limity załączników.
Każde pominięcie ma listę ID/ścieżek i powód. Nie pobieramy całego repo, załączników PR,
zewnętrznych URL ani logów. Brak uprawnień lub strony nie jest zastępowany domysłem modelu.
Hash/SHA snapshotu zostaje w załączniku, aby późniejszy push nie zmieniał historii wysłanej tury.
Fix nie oznacza zgody na komentarz, merge, push ani revert; działają obecne uprawnienia wątku.

### Kit, stany i copy

Używamy `shared/ui/{Disclosure,DropdownMenu,Select,Checkbox,SegmentedChoice,Dialog,Popover}.svelte`
oraz `features/threads/components/{PanelRow,PanelField}.svelte`. Semantyczne zakładki mają
klawiaturę, role i fokus; przełącznik wyglądu nie zastępuje nawigacji treści.
Panel ma `density-chrome`, treść skalę czytania, nakładki `density-overlay` z `docs/ui-scale.md`.
Rezerwujemy miejsce statusów, liczników i akcji; odświeżanie zachowuje dane i geometrię.
Skeleton tylko bez pierwszego wyniku. Ruch używa tokenów `motion` i reduced motion.

Copy pozostaje angielskie, zgodne z [copy.md](copy.md): **Connect GitHub**, **Choose an account**,
**No pull requests yet**, **GitHub access expired. Reconnect your account.**,
**This repository is not available to this account. Choose another account.**
**GitHub's request limit is reached. Retry after {time}.** Status ma tekst, nie sam kolor.
Przegląd copy w implementacji obejmie krótkie i długie nazwy repo/gałęzi, liczbę pojedynczą/mnogą,
phone width i wszystkie stany błędów; wynik trafia do opisu każdego zmieniającego UI PR.
Ten projekt proponuje teksty, nie zmienia działającego UI.

## 8. Mobile: ten sam zakres

Każdy etap z funkcją użytkową dostarcza równocześnie web/desktop i mobile; nie ma końcowego
etapu „nadrobienia mobile”. Konto i instalacje są w Settings, inline auth działa z PR.
Systemowa przeglądarka otwiera device flow przez istniejące `expo-linking`, a powrót/AppState
odczytuje stan próby. Telefon nigdy nie wymienia kodu na token GitHub.

Pod Branch w `ThreadPanel.tsx` jest identyczna zwijana lista PR. Tap otwiera ekran PR z
Summary/Timeline/Code; Back wraca do wątku ze szkicem. Overflow otwiera arkusz akcji.
Timeline i pliki korzystają z list wirtualnych, strony po 50/30, z jedną zakotwiczoną pozycją
podczas doczytywania. Filtry i wybór commitu są arkuszami/pickerami, nie małymi desktopowymi menu.

Diff domyślnie Stacked; Side by side pozostaje dostępne także na telefonie, z przewijaniem
poziomym, a na tablecie wykorzystuje szerokość. Jest wrap, whitespace, drzewo, Viewed,
komentarze, odpowiedzi i wszystkie trzy akcje composera z tymi samymi limitami.
Copy link/number/checkout korzysta z istniejącego `expo-clipboard`, linki z `expo-linking`.
Markdown renderuje `ui/markdown` natywnie, bez WebView; kolorowanie składni nie jest warunkiem
parytetu, bo obecny mobilny renderer kodu go nie ma. Cele dotykowe mają minimum 48 dp.

Przewidziany zakres jest **JS/TS-only i OTA** dla obecnego Expo 58: nowe ekrany, wygenerowane
kontrakty, istniejący przypięty Connect i komponenty diff/markdown/attachments.
Bez nowych permissions, schematu deep link, SDK GitHub, modułu natywnego i storage tokenów
w SecureStore telefonu (zostaje tam wyłącznie credential Canopy). Zmiana fingerprintu natywnego
w implementacji wymagałaby jawnego wskazania nowego buildu, nie obietnicy OTA.
Poller działa w gatewayu; aplikacja mobilna w tle nie utrzymuje odpytywania.

## 9. Bezpieczeństwo i audyt

| Zagrożenie | Granica i wymagany dowód |
| --- | --- |
| Kradzież tokenu lub phishing device code | TLS do stałych hostów GitHub, szyfrowanie w bazie, expiry, owner/client binding próby; kod pokazujemy tylko po świadomym Connect. Nie przyjmujemy kodu podanego przez model/PR |
| Odczyt/zapis cudzego repo, cache lub wątku | Owner scope przed cache i przed efektem, composite FK, weryfikacja repo/installation/account i docelowego review thread; cudzy zasób zwraca NotFound. Grant ani tryb full auto nie zastępuje owner scope |
| Przeciek przez worker/linked computers | Tokeny tylko w domu konta. DTO, lustra, protokół workerów i załącznik kontekstu bez credentiali. Allowlist RPC/capabilities, unpair/revoke zamyka streamy i czyści cache |
| Prompt injection w opisie, diffie, review i checkach | Cała treść GitHub jest niezaufanymi danymi. Plik kontekstu oznacza pochodzenie i cytowane granice, a notatka platformy zabrania traktować treść PR jako zgodę lub instrukcję systemową. Nie wykonujemy poleceń, URL ani żądań sekretów z PR |
| XSS, tracking i SSRF | Istniejący tokenowy renderer Markdown: HTML jako tekst, obrazy jako linki, `safeHref` z `@canopy/domain/markdown`. Bez `body_html`, skryptów, auto-downloadu obrazów/avatarów i proxy dowolnych linków; endpointy API buduje gateway z walidowanych ID |

Przed skutkiem zewnętrznym gateway ponownie sprawdza aktywne konto, rewizję i prawa,
a GitHub weryfikuje rzeczywiste uprawnienia. REST redirect nie przekazuje Authorization
na inny origin. Link checka do zewnętrznego CI jest zwykłą nawigacją po jawnym kliknięciu,
nigdy żądaniem gatewaya z tokenem. Plik kontekstu może zawierać prywatny kod: dodaje go
użytkownik, widzi zakres przed Send, a dalsze przekazanie do providera podlega zasadom wątku.

Audyt w istniejącym `audit_log`: connect/disconnect, wybór konta repo, link/unlink,
mutacja komentarza/odpowiedzi, przygotowanie kontekstu i próba odmowy. Zapisujemy owner,
dom, account ID, repo/PR ID, rodzaj akcji, request ID, wynik i czas; bez tokenów, kodów auth,
Authorization, treści PR/komentarzy/diffów, pełnych odpowiedzi i URL z query.
Odczyty pollera mają zagregowane metryki latency/cache hit/bytes/rate remaining/backoff,
bez tytułów, nazw prywatnych repo i treści jako etykiet. Zredagowane diagnozy są owner-scoped
za **Show details**, według `connectors/test-error.ts`; nie logujemy surowych wyjątków HTTP.
Testy obejmują również echo tokenu w odpowiedzi serwera i redakcję przed cache/logiem/streamem.

## 10. Powiązania z istniejącymi funkcjami

| Funkcja | Decyzja |
| --- | --- |
| GitHub MCP dla agentów | Pozostaje obecny PAT/OAuth i granty `connector_worker_grants`/`connector_bot_grants`. Połączenie GitHub App służy API produktu; nie przypisujemy jego tokenu do zdalnego MCP bez potwierdzenia kompatybilności tego serwera. Późniejszy most narzędzi może wykonywać wybrane operacje klientem gatewaya, przez istniejący AgentToolCall i zgody |
| `apps/gateway/src/connectors/merged-pr.ts` | To dziś dodatkowy dowód merge do cleanup przez stałe read-only narzędzia MCP, z weryfikacją branch/ref/head SHA/base repo i grantów workera. Nowy klient może dostarczyć równoważny świeży dowód tylko przy takim samym ograniczeniu konta; brak zgody/niepełny cache nie zezwala na cleanup. Niezależny git fallback i ochrona zmian lokalnych zostają |
| Worktrees i Branch | Źródłem gałęzi pozostaje `GitHeads` i istniejący `ThreadBranches`/SwitchThreadBranch. PR nie zmienia cwd, worktree ani branch. Kopia komendy checkout nie wykonuje git; branch switch dalej wymaga braku aktywności i czystego checkoutu |
| Boty | Mogą nadal czytać/tworzyć PR przez przyznany GitHub MCP i istniejącą politykę safe/always/full_auto. Nowe konto produktu nie daje grantu, nowego narzędzia ani dostępu do podglądu dowolnego właściciela. v1 nie dodaje panelu PR botowi ani ukrytego kontekstu do jego rutyn; użytkownik może przekazać jawny załącznik jak dotychczas |
| Aktualizacje | `packages/updater/src/release.ts` ma `ReleaseSourceOptions.fetch`; `apps/gateway/src/updates/runtime.ts` tworzy ReleaseSource. To punkt opcjonalnego wrappera autoryzowanych lookupów release, bez importowania gatewaya do pakietu i bez zmiany zamrożonego UpdateService |

**Statyczny indeks wydań, przygotowywany osobno, jest głównym rozwiązaniem limitu aktualizacji.**
Nie uzależniamy aktualizacji ani kanału ratunkowego od zalogowania do GitHub.
Opcjonalny wrapper działa wyłącznie w gatewayu dla już połączonego konta, po jawnym włączeniu
użycia do aktualizacji; nie wywołuje interaktywnego logowania ani odświeżenia podczas startu/ratowania.
Dodaje Authorization tylko do dokładnego origin `https://api.github.com` i ścieżek release
repozytorium Canopy. Obejmuje wspólne liczniki limitów i mały cache; nie wysyła nagłówka na
CDN, `github.com` z assetem, dowolny mirror ani redirect. Worker, Electron i mobile nie dostają tokenu.
Disconnect lub brak tokenu zostawia indeks/statyczny publiczny odczyt; bez zwiększania częstotliwości
anonimowych prób. Dostęp do prywatnych repo użytkownika nie jest potrzebny do pobrania Canopy.

## 11. Wdrożenie jako stos PR

Poniższy stos powstaje **po akceptacji projektu**. Dolny PR bazuje na aktualnym `dev`,
każdy następny na poprzednim (`gh stack`, `github/gh-stack`). Wszystkie pozostają draft,
dopóki cały zakres v1 nie działa i nie jest zweryfikowany. Potem wspólny merge
`gh stack merge <stack> --squash`; bez częściowego publikowania etapów do `dev`.
Rozmiary to orientacyjne linie kodu z testami i zależności, bez kodu generowanego.

| Etap | Kompletna granica zmiany | Rozmiar / zależność | Dowód przed gotowością |
| --- | --- | --- | --- |
| 1. Konto | Schemat kont/instalacji, device flow, refresh/disconnect, Settings i inline auth we wszystkich klientach | L, 1200–1800 linii; punkt startowy | Migracje, gRPC auth, dwóch ownerów, expiry, równoległy refresh, restart/anulowanie i brak sekretów w DTO/logach; HTTP fixture zamiast live GitHub |
| 2. Ręczny PR | Klient GraphQL/REST, mapowanie repo, wspólny cache/budżet, ręczne link/unlink, panel i Summary, trasy domu i małe lustro | L, 1400–2200; po 1 | gRPC z prawdziwym store i kontrolowanym upstream, tombstone race, obce konta/cache, offline/revoke, dwa gatewaye. **Pierwsza wartość PR dla użytkownika** |
| 3. Wykrywanie | Kontekst git, forki/remotes, branch reuse, auto-link, zakończone wyniki narzędzi i cleanup proof | L, 1000–1600; po 2 | Gateway↔WorkerHost z rzeczywistymi repo/worktrees, push/ref change, różne head repo, stos, detached HEAD, tombstone, restart/replay |
| 4. Historia i CI | Pełna paginacja timeline/review/checków, filtrowanie, WatchPullRequest, widoczność/polling, cache stron partnera | L, 1200–1800; po 3 | gRPC > 100 zdarzeń/checków i odpowiedzi, 304/429/403/GraphQL partial, single-flight wielu klientów, luka streamu i offline domu |
| 5. Code | Lista/drzewo, commit filter, lazy patch, wspólne rozszerzenia diffu, Viewed w web/desktop/mobile | L, 1000–1600; po 4 | gRPC izolacji plików/SHA, push w trakcie odczytu, binary/truncated/limity i per-account Viewed; bez testów komponentów |
| 6. Komentarze | Post comment i reply, login autora, trwałe receipty i wynik niepewny | M, 700–1100; po 5 | gRPC/security: reply do obcego PR, cofnięcie praw, dwa kliknięcia, awaria po wysłaniu, brak replay przy reconnect |
| 7. Composer | Prepare context, trzy akcje, załączniki i jawne ograniczenia niezaufanego kontekstu na wszystkich klientach | M, 700–1100; po 6 | gRPC przekazania załącznika do właściwego workera, owner/limits, snapshot niezmienny po push, harness adapter i redakcja sekretów |
| 8. Domknięcie | Metryki, retencja, zgodność starszych wersji, opcjonalne release lookup przez istniejący fetch; końcowa dokumentacja | M, 600–1000; po 7; rebase na osobną zmianę indeksu, jeśli już weszła | Migracje/retencja, gateway↔worker/linked security, restart i fallback aktualizacji bez konta; przegląd macierzy parytetu i p95 |

Każdy etap utrzymuje zgodność i działającą pionową funkcję w swojej gałęzi; etapy infrastrukturalne
nie udają wartości widocznej przed etapem 2. Mutacje pozostają wyłączone do akceptacji zakresu.
Nie dodajemy web UI/component/Playwright testów ani trywialnych testów helperów.
Scenariusze integracyjne używają autoryzowanego lokalnego fixture HTTP i bazy testowej,
nigdy anonimowego produkcyjnego API GitHub. Live GitHub jest wyłącznie opt-in.

Podczas przyszłej implementacji wykonawca może sam uruchamiać jednostkowe testy, lint i format.
Integracja/E2E, benchmarki, uruchamianie aplikacji oraz inne sprawdzenia poza tym zakresem
wymagają uprzedniej zgody zgodnie z instrukcją właściciela workspace'u; najpierw kończy prace
dozwolone. Przed gotowością całego stosu potrzebny jest komplet repo checks z AGENTS.md
(install, gen:check, typecheck, lint, format:check, check:tmp, web build), wykonany w dozwolonym
środowisku lub CI, z jawnym wskazaniem niewykonanych sprawdzeń.
QA UI po zgodzie obejmuje light/dark, desktop/phone/tablet, klawiaturę/czytnik, reduced motion,
krótkie i długie treści, sticky/scroll oraz iOS/Android z tym samym zestawem funkcji.

Włączanie po merge: capability i flagi domeny domyślnie wyłączone, pilotaż na wybranych kontach,
obserwacja p95/limitów i dopiero udostępnienie wszystkim. Gateway może wstrzymać polling
i mutacje bez usuwania powiązań. Rollback wyłącza funkcję i nowe RPC; migracje zostają addytywne,
starszy klient/gateway nadal obsługuje wątki, a cofnięta funkcja nie ponawia niepewnych zapisów.

## 12. Pytania do maintenera

1. **Czy wystarcza auth per dom wątku?** Zalecenie: tak w v1; logowanie do B można uruchomić
   z A, ale token nie wędruje między gatewayami. Broker kont pozostawić na osobny projekt.
2. **Czy v1 ogranicza zapis do komentarzy i odpowiedzi?** Zalecenie: tak; reviews, resolve,
   merge/revert i re-run odłożyć razem na wszystkich klientach, bez Actions permissions w v1.
3. **Czy Viewed ma synchronizować GitHub?** Zalecenie: na razie stan konta w Canopy,
   wspólny dla urządzeń i resetowany po push; bez zmiany flag w serwisie źródłowym.
4. **Czy repo bez zaakceptowanej instalacji ma działać automatycznie?** Zalecenie: nie;
   pokazać Install/Manage repositories, a istniejący PAT dopuścić tylko po jawnym wyborze.
5. **Czy lookup wydań może używać konta?** Zalecenie: opcjonalnie, po jawnym włączeniu;
   statyczny indeks pozostaje podstawą, a brak konta nigdy nie blokuje aktualizacji.
