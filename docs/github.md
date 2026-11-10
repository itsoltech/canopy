# Konto GitHub i pull requesty

Status: **propozycja do przeglądu**, 2026-11-10. Ten dokument nie zatwierdza implementacji.
Decyzje ustalone po przeglądzie: oficjalna GitHub App Canopy organizacji `itsoltech`, device flow,
wygasające tokeny użytkownika w domu wątku, pełny zakres zapisów opisany poniżej i Viewed
synchronizowane z GitHub. Implementacja dopiero po akceptacji zaktualizowanego projektu, jako stos PR.

## 1. Wynik i zakres

Użytkownik łączy konto, przypisuje repozytorium, czyta i obsługuje jego PR bez opuszczania Canopy.
Jeden wątek może mieć wiele PR, a jeden PR może należeć do wielu wątków.
Powiązania wykryte z gałęzi i dodane ręcznie mają tę samą prezentację.
**Priorytetem jest brak regresji p95 istniejących operacji.** GitHub nie wchodzi do ścieżki
otwarcia wątku, zapisu zdarzeń, ACK workera ani startu tury.

| Obszar | v1, jednocześnie web/desktop/mobile | Później |
| --- | --- | --- |
| Konto | Wiele kont osobistych i służbowych właściciela, instalacje, wybór konta per repo, istniejący PAT jako fallback | GitHub Enterprise Server, centralny broker poświadczeń |
| Powiązania | Ręczne link/unlink, wykrywanie PR gałęzi, historia powiązań, obsługa forków i stosów | Rozpoznawanie zależności całego stosu niezależnie od gałęzi |
| Czytanie | Summary, pełna stronicowana Timeline, Code, checki i osadzone logi CI z limitami | Artefakty CI, dowolne zakresy commitów |
| Review | Komentarze ogólne i odpowiedzi, inline i zakresy linii w unified/split, pending review, Comment/Approve/Request changes, resolve/unresolve, edycja/usuwanie własnych komentarzy, Viewed z GitHub | Dismiss cudzych reviews, automatyczne publikowanie uwag agenta |
| Cykl PR | Create z gałęzi wątku i szkicem agenta do zatwierdzenia, ready/draft, merge/squash/rebase, auto-merge on/off, update branch, close/reopen | Revert, automatyczne usuwanie gałęzi, zarządzanie całym stosem PR jedną akcją |
| Metadane i CI | Tytuł/opis, request/re-request reviewerów i zespołów, assignees, labels; re-run failed/jobs/run, cancel run, logi checków/jobs | Edycja workflow, sekretów i ustawień repo, uruchamianie dowolnego workflow |
| Praca agenta | Ask a question, Explain this PR, Fix findings in this thread oraz szkic tytułu/opisu Create PR; użytkownik zatwierdza treść i osobno publikuje | Wywoływanie mutacji nowej integracji przez agentów/boty; wymaga osobnego projektu jawnych zgód |

Nie tworzymy klienta git, nowego systemu zgód, własnego hostingu diffów ani mechanizmu
aktualizacji. Każda mutacja jest jawną akcją użytkownika, bez ukrytych zapisów przy auth,
odświeżaniu, otwarciu pliku ani odpowiedzi modelu. Włączenie auto-merge jest jawnym zleceniem
przyszłego scalenia przez GitHub. Istniejące narzędzia agentów zachowują osobne granty (§10).

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
Publiczne repozytorium bez wybranej instalacji może mieć inne zasady API; Canopy v1 wymaga
zaakceptowanej instalacji oraz jawnego wyboru repozytorium i konta do automatycznego wykrywania.
Brak instalacji pokazuje **Install Canopy**/**Manage repositories**, bez automatycznego fallbacku;
PAT działa dopiero po jawnym wyborze właściciela.
[Zasady tokenów użytkownika](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

| Uprawnienie repozytorium | v1 | Uzasadnienie |
| --- | --- | --- |
| Metadata | Read, obowiązkowe | Tożsamość repozytorium i dostęp instalacji |
| Pull requests | Read and write | Create, ready/draft, close/reopen, tytuł/opis, reviews/inline/resolve, request/re-request użytkowników i zespołów, Viewed oraz auto-merge |
| Contents | Read and write | Odczyt commitów/plików oraz merge i update branch przez API GitHub; update wymaga write także do head repo, również forka |
| Issues | Read and write | Labels i assignees PR przez Issues API oraz komentarze ogólne; bez zarządzania osobnymi issues |
| Actions | Read and write | Odczyt runs/jobs/logów, ponowienie joba, nieudanych jobów lub całego run oraz cancel run |
| Checks | Read | Check runs/suites, output i adnotacje, także od zewnętrznych dostawców |
| Commit statuses | Read | Starsze statusy commitów, uzupełniające check runs |

**Contents: write zwiększa ryzyko kradzieży tokenu:** technicznie pozwala modyfikować kod
w wybranych repozytoriach. Canopy nie wykonuje nim git push ani zapisu plików/refów przez API;
allowlista dopuszcza tylko serwerowe merge i update branch. Te akcje zmieniają historię na GitHub,
nie lokalny checkout. Nie pobieramy Workflows: write, Administration ani uprawnień do e-mail.
Checks: write nie jest potrzebne i nie daje prawa do ponawiania dowolnego zewnętrznego CI.
Bez uprawnień organizacyjnych: reviewerów proponujemy z PR/historii oraz jawnego loginu lub
`org/team-slug`; REST request reviewers przyjmuje slug, a GitHub sprawdza dostęp zespołu.
Nie budujemy katalogu wszystkich członków i zespołów wymagającego Members: read.
Minimalne prawa dotyczą całego v1; faktycznie dostępne akcje nadal wynikają z praw użytkownika,
instalacji i repo. Brak Actions lub Contents w PAT wyłącza odpowiednie akcje z wyjaśnieniem.
[Komentarze i wymagane prawa](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment),
[merge i update branch](https://docs.github.com/en/rest/pulls/pulls),
[reviewerzy](https://docs.github.com/en/rest/pulls/review-requests),
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

`api/routed.ts`, `computers/remote.ts` i negocjowane capabilities `github_pr_v1` (odczyt) oraz
`github_pr_write_v1` (pełen zapis) przenoszą wyłącznie dozwolone RPC i DTO bez sekretów.
Id kwalifikowane domem działają jak identyfikatory wątków.
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
5. W Repository permissions ustawić **Pull requests, Contents, Issues, Actions: Read and write**,
   **Checks, Commit statuses: Read-only**, **Metadata: Read-only** (obowiązkowe); pozostałe prawa,
   w tym Organization permissions, pozostawić wyłączone. Instalacja: **Any account**, aby użytkownicy
   mogli wskazać własne organizacje i repozytoria. Utworzyć aplikację.

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

REST uzupełnia instalacje, wykrywanie po head ref, pliki/patch, komentarze, metadane i Actions.
GraphQL obsługuje review, Viewed i lifecycle tam, gdzie daje potrzebne warunki wykonania;
merge/update branch używają endpointów z kontrolą oczekiwanego head SHA.
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
`client_request_id` i zapisany fingerprint/wynik wzorujemy na `connectors/runtime.ts`.
Każdy zapis, również Viewed, ma trwały receipt: prepared → in_flight → succeeded/failed/uncertain,
a operacja asynchroniczna także accepted do potwierdzenia wyniku. Request ID wiąże owner,
klienta, konto, akcję, docelowe ID, parametry i oczekiwane SHA/rewizje; inny fingerprint jest błędem.
Intent zapisujemy przed HTTP. Powtórzenie tego ID odczytuje receipt, nie wykonuje drugiego POST.
Timeout lub restart po wysłaniu oznacza **Outcome unknown. Check the current state.**
Read-only reconcile porównuje GitHub ID/status i stan docelowy; sama równa treść nie dowodzi
wykonania konkretnego żądania. Gdy brak dowodu, użytkownik rozstrzyga po odświeżeniu.
`clientMutationId` GraphQL nie jest gwarancją idempotencji GitHub. Nie ma replay przy reconnect,
refresh tokenu ani zmianie konta; szkic użytkownika pozostaje dostępny.

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
Po mutacji unieważniamy tylko odpowiedni PR/review/run i doczytujemy wynik;
nie odświeżamy całego repo. Zmiana head SHA unieważnia checki i pliki, także cache Viewed;
stan Viewed odczytujemy ponownie z GitHub, nie resetujemy samodzielnie wszystkich plików.

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
To **szacunki bez pomiaru**, nie gwarancja; strony historii, diffy i logi liczymy osobno.
Limity: 2 MiB na odpowiedź upstream/stronę, 32 MiB LRU RAM na gateway, 128 KiB nagłówka PR,
256 KiB patcha na plik. Parser i renderer nigdy nie otrzymują całego PR w jednym przebiegu.
Otwarta lista jobs to najwyżej jeden REST GET/15 s tylko podczas aktywnego run (do 240/h,
zamiast dublowania pollingu tych samych checków). Logi wyłącznie na żądanie, bez tailingu w tle:
jedno pobranie joba ≤ 8 MiB i strony Canopy ≤ 64 KiB/1000 linii (§6), bez archiwum całego run.
Przy założeniu 5–20 ms CPU/MiB dekodowanie limitu kosztuje 40–160 ms na żądanie, porcjami
poza ścieżką ACK; pomiar musi potwierdzić brak blokowania event loop. Wspólne limity i priorytety
obejmują logi oraz mutacje; przeciążenie blokuje prefetch, nie dispatch tur.

Cel nowych odczytów z ciepłego cache: p95 ≤ 50 ms w gatewayu; pierwszy obraz danych
w kliencie ≤ 150 ms bez czasu sieci do GitHub. Osobno mierzymy cold fetch i deklarujemy stale.
W istniejących operacjach dopuszczamy **zero dodatkowych wywołań HTTP i procesów git**.
Do overview trafia tylko najnowszy PR + count + rewizja, nie lista ani treść PR.
Skanowanie wyników narzędzi i polling działają poza transakcją ingestu/ACK i poza blokadą wątku.
Przy presji SQL/event loop najpierw ograniczamy polling i prefetch.

Warunek wydania implementacji: porównanie baseline/kandydat przy takim samym obciążeniu
GetOverview/GetThread, dispatch tury, ingest/ACK i renderowania web/mobile, także z niedostępnym
GitHub i partnerem. Powtarzalny wzrost p95 ponad niepewność pomiaru blokuje wydanie.
Korzystamy z metod `docs/database-performance.md` i `docs/client-performance.md`.

## 4. Dane i retencja

Nazwy poniżej są projektem nowych tabel, nie opisem istniejącego schematu.
Każda relacja ma `owner_user_id`; klucze obce i unikalności obejmują właściciela.
Sam UUID, GitHub node ID, repo ID lub URL nigdy nie jest uprawnieniem do odczytu.

| Tabela/relacja | Klucz i dane |
| --- | --- |
| `github_accounts` | UUID, owner, host, GitHub user ID/login, nazwa, dom, auth kind, status, access revision; zaszyfrowana para tokenów albo FK do własnego PAT connectora, nigdy oba |
| `github_installations`, `github_installation_repositories` | Owner + account + installation ID; właściciel instalacji, permissions, selected/all, suspended, repo ID i kanoniczna nazwa, czas weryfikacji. Wiersze instalacji powtarzają się per autoryzowany użytkownik |
| `github_repository_accounts` | Owner + repo ID → lokalne account/installation ID, jawny wybór i rewizja; brak globalnego domyślnego konta dla zapisów |
| `github_pull_requests`, `thread_pull_requests` | Kanoniczny PR: owner + host + repository ID + number/node ID. Relacja many-to-many: owner + thread + PR, `source=auto/manual`, evidence=branch/tool_output/product_create, branch/repo/SHA w chwili powiązania, created/last_seen, `unlinked_at` |
| `github_pr_cache`, `github_pr_pages`, `github_pr_checks` | Cache izolowany account/access revision; nagłówek, ETag, SHA, fetched/verified, completeness, strony timeline/review/files i podsumowania CI. `viewerViewedState` jest polem cache strony GraphQL plików, nie osobną tabelą stanu Canopy |
| `github_mutation_receipts` | Owner/dom/account + request ID, akcja, fingerprint, oczekiwane SHA/rewizje, potwierdzenie użytkownika, stan, upstream ID/wynik i czasy. Dotyczy wszystkich mutacji; bez tokenów i surowego body |

`unlinked_at` jest tombstone'em, a nie DELETE: blokuje ponowne auto-link dla pary wątek–PR
niezależnie od nowej gałęzi i źródła wykrycia. Ręczne Link świadomie go usuwa, po ponownej
weryfikacji repo. Transakcja auto-link sprawdza tombstone ponownie pod blokadą.
Oddzielna historia kontekstu checkoutu zapisuje zmiany repo/head ref/pełnego SHA i czas;
nie zmieniamy niezmiennych `threads.cwd` ani `worktree_id`.

Tokeny szyfrujemy istniejącymi `encryptSecret/decryptSecret` (`store/secrets.ts`), z key ID
i kontrolą owner przed odszyfrowaniem, według `connectors/sealing.ts`. Nie wchodzą do cache DTO.
Do nowej tabeli prób auth trafiają zaszyfrowany device code, owner/client binding, TTL i stan.
Pending review i komentarze są zasobami GitHub per użytkownik; ich cache jest dodatkowo
izolowany kontem. Nieudostępnione szkice edytorów pozostają szkicami klienta, nie projekcją
lustra ani źródłem automatycznego wysłania. Nie tworzymy lokalnej tabeli Viewed.
Stan pollera ma termin, dzierżawę i rewizję; jeden producent na klucz również po restarcie.

Retencja cache: nieużywane nagłówki 30 dni, strony timeline/checków 7 dni, patche 24 h,
logi najwyżej 1 h i 16 MiB na owner/dom w ramach wspólnego limitu;
limit 100 MiB treści na owner/dom z LRU według ostatniego odczytu. Nie jest to archiwum GitHub.
Powiązany PR zachowuje małą tożsamość po wygaśnięciu treści. Cache Viewed wygasa ze stroną;
źródłem prawdy pozostaje GitHub. Próby auth usuwamy najpóźniej 24 h po TTL, sekret od razu po
zakończeniu. Receipty zostają do usunięcia właściciela/konta, tombstone'y do usunięcia wątku/właściciela,
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

### Create PR z gałęzi wątku

Jawne **Create pull request** odczytuje ten sam kontekst git i wymaga opublikowanej head branch.
Użytkownik wybiera base repo/branch, head repo/ref, konto i draft/ready; Canopy nie wykonuje
push ani tworzenia forka w tle. Brak opublikowanego SHA kieruje do zwykłego przepływu pracy z git.
**Draft with agent** przygotowuje edytowalną prośbę w composerze i ograniczony załącznik
z repo/ref/SHA, listą commitów i wybranymi diffami (limity §7); dopiero Send uruchamia turę.
Wynik modelu jest propozycją tytułu i Markdown opisu, importowaną do formularza, nie żądaniem API.
Użytkownik ogląda i edytuje całą treść oraz cel, potem osobno klika **Create pull request**.
Zmiana repo/ref/SHA unieważnia wcześniejsze sprawdzenie formularza; model nie ustala konta ani praw.
Formularz ogranicza tytuł do 256 znaków, opis do 64 KiB i respektuje dodatkowe limity GitHub;
przekroczenie limitu nie obcina treści publikowanej bez wiedzy użytkownika.

Po potwierdzeniu utworzenia gateway transakcyjnie zapisuje receipt i `source=auto`,
evidence=`product_create` dla źródłowego wątku. Awaria lokalnego linku po utworzeniu PR
uruchamia read-only reconcile po upstream ID, bez ponownego create. Konflikt „PR already exists”
proponuje link do zweryfikowanego PR i respektuje tombstone; nie tworzy duplikatu ani nie odpina
innych PR. Utrata odpowiedzi create pozostaje uncertain do rozstrzygnięcia, także po restarcie.

## 6. Proto i API UI

Rozszerzamy istniejący **`canopy.ui.v1.GatewayService`**, z wiadomościami w nowym
`proto/canopy/ui/v1/github.proto`. To domena w istniejącej usłudze, nie drugi serwer API.
`api/ui-github.ts` składa handlery analogicznie do `ui-connectors.ts`.

| Grupa RPC — proponowane nazwy | Kontrakt |
| --- | --- |
| `ListGitHubAccounts`, `BeginGitHubDeviceAuth`, `GetGitHubDeviceAuth`, `CancelGitHubDeviceAuth`, `DisconnectGitHubAccount` | DTO konta i stanu próby bez tokenów/device code; żądania mają dom, nie dowolny URL |
| `ListGitHubInstallations`, `ListGitHubRepositories`, `SetGitHubRepositoryAccount` | Stronicowany katalog dostępnych repo, jawny wybór konta i expected revision |
| `ListThreadPullRequests`, `LinkThreadPullRequest`, `UnlinkThreadPullRequest`, `RefreshPullRequest` | Thread ID + kanoniczna tożsamość PR; link zweryfikowany w gatewayu; tombstone atomowy |
| `GetPullRequest`, `WatchPullRequest`, `ListPullRequestTimeline`, `ListPullRequestReviewThreads`, `ListPullRequestFiles`, `GetPullRequestDiff` | Nagłówek, checki, cursory i rewizje; patch tylko dla wskazanego pliku i SHA; prywatne pending review per konto |
| `CreatePullRequestComment`, `ReplyPullRequestReviewThread`, `UpdatePullRequestComment`, `DeletePullRequestComment`, `SetPullRequestReviewThreadResolved` | Typ komentarza i upstream ID związane z PR; edycja/usunięcie tylko własnego komentarza; resolve/unresolve według aktualnych praw |
| `AddPullRequestReviewComment`, `SubmitPullRequestReview`, `DiscardPullRequestReview`, `SetPullRequestFileViewed` | Inline z path/startSide/startLine/endSide/endLine/commit OID, pending review ID oraz event Comment/Approve/Request changes; Viewed wywołuje GitHub |
| `CreatePullRequest`, `SetPullRequestDraft`, `MergePullRequest`, `SetPullRequestAutoMerge`, `UpdatePullRequestBranch`, `SetPullRequestOpen` | Jawna akcja użytkownika, oczekiwany head/base i dozwolona metoda; create z thread ID; receipt również dla accepted/uncertain |
| `UpdatePullRequestDetails`, `RequestPullRequestReviewers`, `SetPullRequestAssignees`, `SetPullRequestLabels` | Tytuł/opis z rewizją, enum request/re-request/remove z rozróżnieniem user/team, zmiana przypisań w obrębie jednego repo |
| `ListPullRequestCheckJobs`, `GetPullRequestJobLog`, `RerunPullRequestChecks`, `CancelPullRequestCheckRun` | Run/job/attempt przypisane przez gateway do repo i SHA PR; stronicowane jobs/logi, enum failed_jobs/all_jobs/single_job, bez dowolnego URL/workflow dispatch |
| `PreparePullRequestMutation`, `GetPullRequestMutation`, `PreparePullRequestContext`, `PreparePullRequestDraftContext` | Preflight/receipt i potwierdzenie związane z akcją; context zwraca zwykłe Attachment DTO, nie wysyła tury. DraftContext przyjmuje thread ID i oczekiwany kontekst gałęzi, bez wymogu istniejącego PR |

Wspólne typy: `PullRequestRef`, `PullRequestSummary`, `PullRequestSnapshot`, `PullRequestLink`,
`PullRequestTimelineItem` z oneof zdarzenia, `PullRequestCheck`, `PullRequestFile`, `PageInfo`,
`PullRequestReviewThread`, `PullRequestReviewDraft`, `PullRequestMutationReceipt`, `PullRequestJobLogPage`.
Snapshot zawiera dostępne akcje, dozwolone metody merge, stan auto-merge i powody blokad;
UI nie wylicza autoryzacji z samej roli lub zielonych checków. Gateway sprawdza ją ponownie.
Ref zawiera host, repository ID/nazwę, numer i dom; nie polegamy na samym `#123`.
Każda odpowiedź podaje rewizję, head SHA, fetched/verified i kompletność. Pola i numery są
wyłącznie addytywne. `proto/canopy/update/v1` pozostaje nietknięte; `WORKER_LINK_PROTOCOL = 1`
zostaje przy addytywnej capability kontekstu git. Generujemy `bun run gen` i sprawdzamy `gen:check`.

Fetch zwraca cache od razu i zleca odświeżenie. `WatchPullRequest` wysyła początkowy snapshot,
następnie zmienione podsumowanie/checki oraz invalidacje stron; nie całą historię co tick.
Nie jest to stream GitHub: poller jest jedynym producentem. Po luce klient ponawia fetch
i rewaliduje załadowane strony. Panel wykorzystuje `WatchThread` i małe pole podsumowania
w `ui.Thread`; pełną listę pobiera osobno. Odrębna rewizja PR nie zwiększa historii tokenowych delt wątku.
Pending review i jego liczniki są prywatnym odczytem konta, bez publikacji w lustrze wątku
ani owner feed dostępnym przy innym kontekście konta. Capability zapisu jest ogłaszana dopiero
po dostarczeniu całej grupy v1; starszy dom z samym odczytem nie przyjmuje nowych mutacji.

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

Stan Viewed doczytujemy przez GraphQL `files { nodes { path viewerViewedState } }`, łącząc
strony z REST po path i zweryfikowanej parze SHA, nigdy po indeksie strony. Inline przenosi
oryginalne numery linii/stronę LEFT/RIGHT, nie pozycję w wyrenderowanej lub zawiniętej liście.
Zakres musi mieścić się w jednym pliku, poprawnej stronie diffu i aktualnym commit OID.
Serwer weryfikuje pochodzenie comment/review/thread ID; po push nie przelicza po cichu kotwicy.

### Jobs i logi CI

Check run kojarzymy z GitHub Actions job/run/attempt po zweryfikowanych danych GitHub i repo/SHA,
nie po parsowaniu dowolnego `details_url`. Jobs: strony po 30 (maks. 100); logi dopiero po
**View logs** przy checku/jobie. GitHub zwraca plik logu joba przez krótkotrwały redirect,
nie strony tekstu. Gateway pobiera go strumieniowo do ograniczonego cache, a API Canopy
wydaje strony do 64 KiB lub 1000 linii z kursorem związanym z owner/account/job/attempt/snapshot.
Limit pobrania i rozkodowanego tekstu: 8 MiB lub 50 000 linii/job, czas 20 s; przekroczenie
daje **Log truncated. Open on GitHub for the full log.** Bez pobierania ZIP całego run.
Ściągamy log ukończonego joba; dla niedostępnego/trwającego/expired logu podajemy stan i Retry,
bez obietnicy live tail. Nowy attempt nie dopisuje się do starego snapshotu.

Signed URL pozostaje w gatewayu, jest traktowany jak sekret i nie trafia do DTO, logów ani modeli.
Do GitHub API idzie token, do zweryfikowanego HTTPS storage wskazanego przez GitHub — żadne
Authorization/cookie; ograniczamy hosty storage, redirecty, rozmiar i adresy docelowe (bez sieci
prywatnych). Tekst renderujemy bez HTML i wykonywania ANSI/OSC; usuwamy sekwencje sterujące,
redagujemy znane sekrety. Log może zawierać prywatne dane mimo maskowania przez CI.
Zewnętrzny check bez API logów GitHub pokazuje dostępne output/adnotacje w Canopy i jawny
link dostawcy; nie pobieramy arbitralnych URL. Re-run/cancel są dostępne dla GitHub Actions,
nie udają uniwersalnego sterowania każdym dostawcą Checks API.
[Logi jobs](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run),
[ponowienie i anulowanie runs](https://docs.github.com/en/rest/actions/workflow-runs).

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
   dostępne po zmianie gałęzi. **Link pull request** przyjmuje URL, **Create pull request** otwiera
   formularz dla gałęzi wątku (§5). Pusty wynik nie jest błędem auth.
2. **Nagłówek PR.** Repo, numer, tytuł, autor, updated time, `base ← head`, liczba plików, +/−,
   stan Open/Merged/Closed/Draft. `gh pr checkout N` jest kopiowalnym tekstem; dopisek określa repo.
   Kopiowanie nie uruchamia komendy ani nie zmienia lokalnej gałęzi. Długi tytuł zawija się;
   po przewinięciu nagłówek jest kompaktowy, ale zachowuje stan i nawigację.
3. **Summary.** Reviewers, assignees i labels z edycją według praw, opis Markdown, checki i komentarze.
   Checki pokazują queued/in progress/success/failure/cancelled/skipped/neutral/timed out,
   nazwę wykonawcy, SHA i link. Brak checków/niepełny odczyt nie jest „All checks passed”.
   Wynik zbiorczy dotyczy wykonanych checków, nie gwarantuje spełnienia branch protection.
   Wiersz checka rozwija jobs i logi; menu run/joba zawiera dostępne akcje CI.
4. **Timeline.** Zdarzenia, commity, komentarze i reviews od najnowszych. Rozwinięcie review
   doczytuje dyskusje i odpowiedzi; zachowuje identyfikatory, autorów, permalink i oznaczenie
   outdated/resolved. Paginacja nie przesuwa właśnie czytanego zdarzenia.
5. **Code.** Lista/drzewo plików, +/−, Viewed, filtr commitu, Stacked/Side by side, wrap,
   widoczność whitespace i drzewo. Są to rozszerzenia `DiffLines`/`diff-layout.ts` i mobilnego
   `DiffContent`, nie nowy parser. Whitespace jest przełącznikiem prezentacji znaków;
   rzeczywisty patch i liczniki pozostają zgodne z GitHub, bez udawania nowego porównania git.

Gutter Code ma **Add comment** oraz wybór początku/końca zakresu; unified i split zachowują
te same kotwice. Dostępne są drag/Shift i równoważne sterowanie klawiaturą, także przy wrap/whitespace.

### Viewed: stan GitHub

Źródłem prawdy jest per-user `viewerViewedState` GitHub: `VIEWED`, `UNVIEWED`, `DISMISSED`.
Checkbox **Viewed** wywołuje GraphQL `markFileAsViewed`/`unmarkFileAsViewed`; stan zgadza się
z github.com i automatycznie łączy urządzenia oraz domy zalogowane na tego samego użytkownika.
Nie ma tabeli ani niezależnej flagi Canopy. Cache i dostęp nadal izolujemy owner/account/dom.
Kliknięcie jest optymistyczne z oznaczeniem zapisu; pewna odmowa cofa checkbox i pokazuje błąd.
Wynik uncertain oznacza niesynchronizowany stan do odczytu GitHub, nie pozorny sukces.
Offline checkbox jest nieaktywny; **nie kolejkujemy** kliknięć ani nie odtwarzamy ich po reconnect.
Po reconnect/otwarciu/fokusie odświeżamy stan. Przy równoległych kliknięciach obowiązuje stan
z GitHub; nie próbujemy scalać lokalnych intencji z innych urządzeń.
Na widocznym Code rewalidujemy aktywną stronę Viewed co 60 s, współdzieląc odczyt klientów;
to do 60 dodatkowych zapytań GraphQL/h, z pomiarem punktów i w ramach budżetu §3.

Po nowym push GitHub może zmienić wcześniejsze Viewed na `DISMISSED` dla zmienionych plików.
UI pokazuje odznaczony checkbox i **Changed since you viewed this file**, odróżniając to od
`UNVIEWED`; nie resetuje bezwarunkowo plików, których GitHub nadal uważa za przejrzane.
Zmiana SHA w trakcie zapisu zatrzymuje optymistyczną prezentację i wymaga odświeżenia pliku.
Viewed dotyczy całego pliku bieżącego PR, również przy filtrze commitu, z jawnym opisem zakresu.
Układ diffu, wrap, drzewo i filtry prezentacji są preferencjami urządzenia, jak dzisiejszy diff.
[Schema Viewed i mutacje](https://docs.github.com/en/graphql/reference/pulls).

### Zapis i rozmieszczenie akcji

Wszystkie poniższe akcje są w v1 web/desktop/mobile. Uwierzytelniony użytkownik klika akcję;
agent/bot nie może wywołać jej przez nową integrację. UI pokazuje login, repo/PR i stan wykonania.
Trwałe receipty, blokada podwójnego wysłania i uncertain z §3 obejmują każdą z nich.
Nie ma offline send ani zapisu po samym logowaniu. Szkic pozostaje po błędzie.

| Grupa | Miejsce web/desktop | Zachowanie |
| --- | --- | --- |
| Komentarze | Summary/Timeline i menu własnego komentarza | **Post comment**, **Reply**, **Edit**, **Delete comment** (potwierdzenie); tylko własne edycje/usunięcia, także inline. Cytat komentarza ogólnego tworzy nowy komentarz, nie fikcyjny review reply |
| Review inline | Gutter Code, edytor przy linii/zakresie, menu wątku | **Add single comment** publikuje jawnie, **Add to review** zapisuje prywatny pending comment. Reply, **Resolve conversation**/**Unresolve conversation**, edycja/usunięcie własnych pending i opublikowanych uwag |
| Submit review | Przycisk **Review changes** nad Code z licznikiem pending; dialog podsumowania | Przegląd pending, treść i **Comment / Approve / Request changes**; osobny **Submit review** publikuje całość. **Discard pending review** wymaga potwierdzenia. Odmowa zatwierdzenia własnego PR jest wyjaśniona, nie obchodzona |
| Create i ready/draft | Create w panelu wątku; stan i akcja nagłówka PR, alternatywnie overflow | Formularz create z **Draft with agent** i kontrolą użytkownika (§5); **Ready for review**/**Convert to draft** z widocznym skutkiem dla reviewerów/CI |
| Merge i auto-merge | Nagłówek PR: przycisk i picker metody, blokady pod nim; overflow: wyłączenie auto-merge | Tylko metody repo: **Merge commit / Squash and merge / Rebase and merge**. Dialog potwierdza repo, base/head, SHA, metodę i komunikat commitu. **Enable auto-merge** potwierdza przyszły merge, **Disable auto-merge** wyłącza zlecenie |
| Branch i stan PR | Overflow nagłówka: **Update branch**, **Close pull request**/**Reopen pull request** | Update potwierdza merge base do head na GitHub i możliwy nowy CI; bez lokalnego push. Close wymaga potwierdzenia; reopen jest osobną jawną akcją, nie Undo uruchamianym automatycznie |
| Tytuł i opis | **Edit title and description** przy nagłówku/opisie i w overflow | Edytowalny Markdown z preview, **Save changes**, konflikt przy zewnętrznej edycji nie nadpisuje jej po cichu |
| Reviewers, assignees, labels | Pola Summary z pickerami i jawnym **Apply** | Request/re-request user lub team, usunięcie requestu, dodanie/usunięcie istniejących labels i assignees; bez tworzenia globalnych etykiet lub zmiany zespołu. Picker informuje o powiadomieniu zespołu |
| CI i logi | Wiersze checków/jobs Summary i podgląd logu; menu run/joba | **View logs**, **Re-run failed jobs**, **Re-run all jobs**, **Re-run job**, **Cancel run**; pokazujemy run/attempt/SHA i ostrzegamy, że ponowienie może wykonać deploy. Cancel potwierdza konkretny run i wpływ na pozostałe PR z tym run |

Review pending należy do GitHub user ID: po otwarciu doczytujemy istniejący draft z GitHub,
również utworzony na innym urządzeniu. Rozróżniamy tekst w edytorze (jeszcze lokalny),
**Pending review** (zapisany w GitHub) i opublikowany review. Zmiana konta nie przenosi pending.
Adapter wykorzystuje `addPullRequestReview`/`addPullRequestReviewThread`,
`submitPullRequestReview` oraz `resolveReviewThread`/`unresolveReviewThread`; IDs i kotwice
wiąże gateway. **Add single comment** nie może opublikować przy okazji innych pending uwag;
jeśli API wymaga wspólnego submit, UI kieruje do jawnego przeglądu całego pending review.
Przed Submit pokazujemy wszystkie pending uwagi, także spoza załadowanej strony, i aktualny head;
nowy push wymaga ponownego obejrzenia kotwic. Outdated wątki pozostają czytelne z oryginalnym SHA.
Nowy inline z historycznego filtra commitu wymaga potwierdzonego mapowania do bieżącego diffu;
gdy go brak, UI proponuje przejście do aktualnej wersji, nie zgaduje numeru linii.

Mergeability odczytujemy z GitHub z prawami użytkownika: draft, conflicts, brak reviews/statusów,
rulesets, wymagane rozmowy lub merge queue są widocznymi blokadami. Nie zmieniamy branch protection,
nie dodajemy bypass ani force merge; unknown/pending wymaga odświeżenia. Metoda i head są ponownie
sprawdzane tuż przed API (`sha`/`expectedHeadOid`, update: `expected_head_sha`). Dla wymaganej kolejki
stosujemy wyłącznie wspierane API GitHub respektujące kolejkę, nigdy bezpośredni bypass;
accepted/enqueued to stan oczekiwania, nie **Merged**. Akcja nie może scalać innych PR stosu
bez osobnego, pokazanego zakresu; zbiorcze zarządzanie stosem jest poza v1.
Auto-merge pokazuje metodę, autora i oczekiwanie na warunki GitHub; GitHub może je cofnąć po push
lub zmianie praw. Update branch przy forku wymaga uprawnień do head repo i zgody autora;
konflikt lub brak dostępu daje powód oraz link do GitHub, bez lokalnego obejścia.

Overflow zawiera powyższe akcje lifecycle/metadanych oraz **Unlink from this thread**,
**Refresh**, **Ask a question**, **Explain this PR**,
**Fix findings in this thread**, **Open on GitHub**, **Copy link**, **Copy PR number**.
Bez kontekstu wątku Unlink i trzy akcje composera wymagają wybrania docelowego wątku.
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

| Funkcja v1 | Telefon i tablet |
| --- | --- |
| Inline i review | Tap numeru linii w gutter wybiera stronę; **Select range** pozwala wskazać początek i koniec bez gestu drag. Arkusz pokazuje path, LEFT/RIGHT, SHA i zakres w unified oraz split; edytor ma **Add single comment**/**Add to review**. Pending badge otwiera listę wszystkich uwag i **Comment / Approve / Request changes** z **Submit review**; resolve/unresolve i reply przy rozmowie, edit/delete własnego komentarza w jego menu, discard z potwierdzeniem |
| Viewed | Checkbox przy pliku zapisuje na GitHub; optymistyczny stan/rollback, `DISMISSED` i blokada offline identyczne jak §7; zmiana AppState/fokusu rewaliduje stronę |
| Create i lifecycle | **Create pull request** pod Branch; pełnoekranowy formularz base/head/konto/draft z **Draft with agent**, edycją propozycji i osobnym Create. Nagłówek i arkusz overflow mają ready/draft, update branch, close/reopen, merge/squash/rebase i auto-merge on/off; dialog merge pokazuje metodę/SHA i blokady, close/update/enable auto-merge wymagają takich samych potwierdzeń jak web |
| Metadane | **Edit title and description** otwiera edytor z preview; reviewers (users/teams), request/re-request, assignees i labels mają arkusze wyszukiwania z Apply. Podpowiedzi/slug zespołu i ostrzeżenie o powiadomieniu działają bez desktopowego hover |
| CI | Check rozwija stronicowane jobs; **View logs** otwiera wirtualną listę tekstu z następnymi stronami i stanem truncated/unavailable. Menu run/joba: re-run failed/all/job i cancel; run/attempt/SHA, informacja o skutkach i potwierdzenie cancel są widoczne także przy klawiaturze ekranowej |

Żadna mutacja nie jest przypisana wyłącznie do hover, prawego przycisku ani przeciągania.
Bottom sheet respektuje safe area i klawiaturę; potwierdzenie destrukcyjnej akcji jest osobnym
krokiem z nazwą celu, nie gestem swipe. Zamknięcie aplikacji nie kasuje pending review GitHub;
po powrocie odczytujemy receipt bez replay. Offline można edytować szkic, ale nie wysyłać mutacji.
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
| Odczyt/zapis cudzego repo, cache lub wątku | Owner scope przed cache i przed efektem, composite FK, weryfikacja repo/installation/account i docelowych comment/review/thread/run/job ID. Własność komentarza porównujemy z GitHub user ID konta, nie loginem ani rolą admin; cudzy zasób zwraca NotFound. Grant ani full auto nie zastępuje owner scope |
| Przeciek przez worker/linked computers | Tokeny tylko w domu konta. DTO, lustra, protokół workerów i załącznik kontekstu bez credentiali. Allowlist RPC/capabilities, unpair/revoke zamyka streamy i czyści cache |
| Prompt injection w opisie, diffie, review, logach i szkicu Create PR | Cała treść GitHub oraz wynik modelu są niezaufanymi danymi. Plik kontekstu oznacza pochodzenie i cytowane granice; notatka platformy zabrania traktować PR jako zgodę lub instrukcję systemową. Wynik agenta zasila tylko pola tekstowe formularza; nie ustala konta, repo/base, metody merge ani akcji. Użytkownik ogląda i zatwierdza tekst przed publikacją; linków/poleceń/żądań sekretów nie wykonujemy |
| XSS, tracking i SSRF | Istniejący tokenowy renderer Markdown: HTML jako tekst, obrazy jako linki, `safeHref` z `@canopy/domain/markdown`. Bez `body_html`, skryptów, auto-downloadu obrazów/avatarów i proxy dowolnych linków; endpointy API buduje gateway z walidowanych ID |
| Merge/close niewłaściwego PR albo nowego SHA | Preflight na świeżym stanie, jawne potwierdzenie repo/PR/base/head/metody, związane z request ID i SHA; zmiana celu lub expiry wymaga nowego potwierdzenia. GitHub egzekwuje protection/rulesets; brak bypass, kasowania gałęzi i merge innych PR w tle |
| Cancel/re-run niewłaściwego CI, przerwanie deploy lub powtórzenie skutku | Gateway ustala repo/run/job/attempt/SHA i związek z PR; potwierdzenie cancel dotyczy całego wskazanego run. Re-run jawnie ostrzega o ponownym wykonaniu joba i jego zależności, również deploy. Nie ma force-cancel, debug logging ani workflow dispatch w v1 |
| Kradzież tokenu z Contents/Actions: write albo logów | Repo instalacji ogranicza zasięg; token szyfrowany tylko w domu, stała allowlista operacji i brak worker/model API do mutacji. Logi i signed URL mają oddzielne limity/redakcję (§6); żadnego wysyłania logów do modelu z samego View logs |

Przed skutkiem zewnętrznym gateway ponownie sprawdza aktywne konto, rewizję i prawa,
a GitHub weryfikuje rzeczywiste uprawnienia. REST redirect nie przekazuje Authorization
na inny origin. Link checka do zewnętrznego CI jest zwykłą nawigacją po jawnym kliknięciu,
nigdy żądaniem gatewaya z tokenem. Plik kontekstu może zawierać prywatny kod: dodaje go
użytkownik, widzi zakres przed Send, a dalsze przekazanie do providera podlega zasadom wątku.

Mutacje nowej integracji przyjmują wyłącznie uwierzytelnione żądania UI użytkownika przez
obecny BFF/Connect/routing domu; credential workera, AgentToolCall i bot nie są uprawnionymi
aktorami tych RPC. Pole `actor=user` w body nie jest dowodem. v1 **nie** wprowadza zgody,
która pozwalałaby agentowi wykonać te mutacje; taki most wymaga osobnego przyszłego projektu.
Dotyczy to również szkicu Create PR, trybu full auto i kontekstu Fix findings.

`PreparePullRequestMutation` zapisuje krótko ważne (60 s), jednorazowe potwierdzenie dla
merge, close, cancel run, enable auto-merge, update branch i usunięcia komentarza/pending review.
Wiąże owner/uwierzytelnionego klienta, dom/account/access revision, cel, SHA/run attempt i parametry.
Dialog nazywa skutek; samo otwarcie dialogu niczego nie zatwierdza. Wykonanie wymaga jawnego
submit, sprawdza binding i świeże prawa, po czym zapisuje receipt. Brak potwierdzenia lub
inna metoda/gałąź/konto jest odmową w gatewayu, nie tylko wyłączonym przyciskiem.
Niepewny wynik nie zużywa nowej zgody do automatycznego powtórzenia; accepted/cancel requested
pozostaje oczekiwaniem do weryfikacji. Edycje metadanych porównują rewizję odczytu przed zapisem;
API bez atomowego warunku może nadal ścigać się z edycją na GitHub, więc po zapisie rewalidujemy
i pokazujemy rozbieżność, zamiast obiecywać blokadę edycji między różnymi klientami GitHub.

Audyt w istniejącym `audit_log`: connect/disconnect, wybór konta repo, link/unlink,
każda próba mutacji review/lifecycle/metadanych/CI/Viewed, odczyt logu, przygotowanie kontekstu
i odmowa. Zapisujemy owner/aktora i klienta, dom, account ID, repo/PR/review/comment/run/job ID,
rodzaj akcji, request ID, parametry strukturalne (SHA, metoda, attempt), ID/czas potwierdzenia,
wynik/upstream ID i czas. Reconcile zapisuje zmianę uncertain → rozstrzygnięty, bez drugiej mutacji.
Bez tokenów, kodów auth, Authorization, treści PR/komentarzy/diffów/logów, tekstu szkicu modelu,
pełnych odpowiedzi i signed URL/query. Receipt i audyt są owner-scoped, również na partnerze.
Odczyty pollera mają zagregowane metryki latency/cache hit/bytes/rate remaining/backoff,
bez tytułów, nazw prywatnych repo i treści jako etykiet. Zredagowane diagnozy są owner-scoped
za **Show details**, według `connectors/test-error.ts`; nie logujemy surowych wyjątków HTTP.
Testy obejmują również echo tokenu w odpowiedzi serwera i redakcję przed cache/logiem/streamem.

## 10. Powiązania z istniejącymi funkcjami

| Funkcja | Decyzja |
| --- | --- |
| GitHub MCP dla agentów | Pozostaje obecny PAT/OAuth i granty `connector_worker_grants`/`connector_bot_grants`. Połączenie GitHub App służy API produktu; nie przypisujemy jego tokenu do MCP ani nie dodajemy narzędzi mutacji agentowi. Most AgentToolCall do nowych mutacji jest poza v1 i wymaga osobnego projektu jawnych zgód; dotychczasowe uprawnienia konektora nie są zgodą na nowe konto |
| `apps/gateway/src/connectors/merged-pr.ts` | To dziś dodatkowy dowód merge do cleanup przez stałe read-only narzędzia MCP, z weryfikacją branch/ref/head SHA/base repo i grantów workera. Nowy klient może dostarczyć równoważny świeży dowód tylko przy takim samym ograniczeniu konta; brak zgody/niepełny cache nie zezwala na cleanup. Niezależny git fallback i ochrona zmian lokalnych zostają |
| Worktrees i Branch | Źródłem gałęzi pozostaje `GitHeads` i istniejący `ThreadBranches`/SwitchThreadBranch. Widok/create PR nie zmienia cwd, worktree ani branch. Merge/update branch zmieniają refy na GitHub, bez git push/fetch/reset lokalnego checkoutu; UI wskazuje rozbieżność po zwykłym odczycie git. Kopia checkout nie wykonuje git; branch switch dalej wymaga braku aktywności i czystego checkoutu |
| Boty | Mogą nadal czytać/tworzyć PR przez przyznany GitHub MCP i istniejącą politykę safe/always/full_auto. Nowe konto produktu nie daje grantu, nowego narzędzia ani dostępu do podglądu dowolnego właściciela. v1 nie dodaje panelu PR botowi ani ukrytego kontekstu do jego rutyn; użytkownik może przekazać jawny załącznik jak dotychczas |
| Aktualizacje | Po scalonym [#486](https://github.com/itsoltech/canopy/pull/486) `packages/domain/src/release/{catalog,http}.ts` współdzielą statyczny katalog, ETag, single-flight, cache i cooldown, a `packages/updater/src/release.ts` składa `ReleaseCatalog`/`ReleaseHttp` przez `ReleaseSourceOptions.fetch`. `apps/gateway/src/updates/runtime.ts` tworzy ReleaseSource: punkt wrappera auth, bez drugiego katalogu i bez zmiany zamrożonego UpdateService |

**Statyczny indeks CDN, scalony w [#486](https://github.com/itsoltech/canopy/pull/486),
pozostaje głównym rozwiązaniem limitu aktualizacji.**
Nie uzależniamy aktualizacji ani kanału ratunkowego od zalogowania do GitHub.
Kolejność: istniejący katalog/cache CDN → API releases z tokenem dostępnego konta → istniejąca
ścieżka publiczna/cache z backoff, jeśli brak konta lub auth zawiedzie. Nie omijamy poprawnego
indeksu dodatkowym lookupem API i nie obchodzimy jego wyniku „brak wydania”.

Zalecenie: **on by default**, bez dodatkowego opt-in; **Settings → GitHub account → Use this
account for update checks** pozwala wyłączyć i wybrać inne własne konto. To ograniczony odczyt
publicznych metadanych Canopy, który wykorzystuje już udzieloną autoryzację i zmniejsza koszt
wspólnego limitu IP przy awarii CDN. Osobny opt-in nie zmienia zakresu już udzielonego dostępu,
a pozostawiałby połączone konta przy słabszym anonimowym fallbacku.
Pierwsze połączone konto danego właściciela jest domyślnym kandydatem, wybór kolejnego nie
zastępuje go po cichu. Na gatewayu z wieloma ownerami globalny updater używa wyłącznie własnego
konta administratora zarządzającego aktualizacjami i tego jawnego ustawienia; nie przeszukuje
tokenów pozostałych ownerów po odmowie/limicie. Bez skonfigurowanego ownera działa publicznie.
Desktop korzystający z domu może otrzymać publiczne metadane przez istniejący kanał aktualizacji;
samodzielny Electron/worker/mobile nadal korzysta z publicznego katalogu, bez kopiowania tokenu.

Wrapper jest tylko w gatewayu; nie wywołuje interaktywnego logowania podczas startu/ratowania.
Używa ważnego tokenu z cache; odświeżenie konta może działać osobno, lecz nie wstrzymuje update
ani pierwszego werdyktu UpdateService. Przekroczenie krótkiego budżetu auth (≤ 2 s) daje publiczny
fallback według jego istniejącego cooldown, nie serię anonimowych prób. Disconnect/off usuwa wybór
auth i jego cache. ReleaseHttp dla tego kontekstu jest izolowany owner/account/access revision,
zachowuje istniejące ETag/single-flight i dzieli liczniki z klientem GitHub; anonimowy cooldown
nie jest cooldownem tokenu innego użytkownika.

Authorization trafia tylko do początkowego żądania na dokładny origin `https://api.github.com`
i stałe ścieżki `/repos/itsoltech/canopy/releases` oraz
`/repos/itsoltech/canopy/releases/tags/{tag}`; parametry listy i tag są walidowane.
Nie trafia na CDN, assety, mirror ani redirect; publiczny `releaseHttp` pozostaje bez poświadczeń.
Publiczny lookup Canopy nie wymaga instalacji w repo użytkownika; zasada wymaganej instalacji
z §2 nadal dotyczy funkcji PR. Nie rozszerzamy uprawnień ani nie zmieniamy weryfikacji manifestów,
hashy/podpisów, mirrora i zamrożonego `update/v1`.

## 11. Wdrożenie jako stos PR

Implementacja powstaje **po akceptacji zaktualizowanego projektu**. Wariant zachowujący jeden
stos obejmuje wszystkie 9 etapów poniżej: dolny PR bazuje na aktualnym `dev`, każdy następny
na poprzednim (`gh stack`, `github/gh-stack`). Wszystkie pozostają draft do zakończenia i weryfikacji
**całego v1**, potem wspólny `gh stack merge <stack> --squash`, bez merge etap po etapie.
Każdy etap ma działający kontrakt gatewaya i parytet web/desktop/mobile, własne testy oraz
przegląd bezpieczeństwa; brakującej funkcji nie zastępuje nieczynny przycisk.
Rozmiary to orientacyjne linie kodu z testami, bez generowanych kontraktów; zależności są logiczne,
a w pojedynczym stosie gałęzie pozostają liniowe. Mutacje PR w GitHub dochodzą po etapach odczytu.

| Etap | Kompletna granica zmiany | Rozmiar / zależność | Dowód przed gotowością |
| --- | --- | --- | --- |
| 1. Konto | Schemat kont/instalacji, device flow, refresh/disconnect, Settings i inline auth we wszystkich klientach | L, 1400–2000 linii; punkt startowy | Migracje, gRPC auth, dwóch ownerów, expiry, równoległy refresh, restart/anulowanie, tokeny poza DTO/logami i partnerami; HTTP fixture |
| 2. Ręczny PR | Klient GraphQL/REST, wybór konta repo, cache/budżet, link/unlink, panel, Summary read-only, dom i lustro | L, 1600–2400; po 1 | gRPC z prawdziwym store, tombstone race, owner/account/cache, offline/revoke i dwa gatewaye. **Pierwsza wartość PR dla użytkownika**, jeszcze w draft gałęzi |
| 3. Wykrywanie | Kontekst git, forki/remotes, branch reuse, auto-link, wyniki narzędzi i cleanup proof | L, 1200–1800; po 2 | Gateway↔WorkerHost z rzeczywistymi repo/worktrees, push/ref change, head repo, stos, detached HEAD, tombstone i restart/replay |
| 4. Pełny odczyt | Stronicowana Timeline/reviews/checki/jobs/logi, Code/commit filter/lazy patch, watch/polling, kontekst trzech akcji composera, retencja/metryki i release fallback po #486 | XL, 3500–5000; po 3 | gRPC paginacji > 100 elementów, 304/429/403/partial, cache/stream gap, binary/truncated/SHA races; SSRF/redakcja/limity logów, attachment/harness, brak tokenu na CDN/redirect; migracje/retencja, restart, p95 i mobile transport |
| 5. Komentarze i Viewed | Wspólny preflight, trwałe receipty/audyt/uncertain; post/reply/edit/delete własnych komentarzy i synchronizacja Viewed z GitHub | L, 1800–2600; po 4 | gRPC/security: obcy PR/comment, cofnięcie praw, dwa kliknięcia, awaria po HTTP i brak replay; GitHub VIEWED/UNVIEWED/DISMISSED, rollback, offline i dwa urządzenia/konta; migracja receiptów |
| 6. Pełne review | Inline i zakresy unified/split, pending review/submit Comment/Approve/Request changes, resolve/unresolve i własne edycje/usunięcia | XL, 2500–3500; po 5 | gRPC/security kotwic LEFT/RIGHT/range/SHA i obcych review/thread ID, pending z innego urządzenia, paginacja, push przed submit, autor PR, restart/uncertain oraz deny worker/bot |
| 7. Lifecycle | Create z gałęzi i szkicem agenta, auto-link, ready/draft, merge/squash/rebase, auto-merge on/off, update branch, close/reopen | XL, 3500–5000; po 5–6 | gRPC create/link crash i duplikat/tombstone; confirmation binding/expiry, push/zmiana konta po preflight, protection/queue/metody, fork head permissions, accepted/uncertain/restart; model nie wywołuje mutacji |
| 8. Metadane | Tytuł/opis, request/re-request user/team, assignees i istniejące labels, jawne Apply we wszystkich klientach | L, 1200–1800; po 5–7 | gRPC owner/repo/user/team ID, brak Members scope, powiadomienia, obca etykieta, konflikt edycji, revoke, receipty i niepewny wynik |
| 9. Sterowanie CI | Re-run failed/all/job i cancel run na bazie logów z etapu 4; końcowe domknięcie zapisów, dokumentacji i parytetu | L, 1800–2800; po 4–8 | gRPC/security obcego run/job/attempt/SHA, confirmation cancel, job dependencies, accepted ≠ done, brak dispatch/debug/force-cancel, restart/uncertain; pełne migracje/security/linked, p95 i macierz wszystkich akcji mobile |

### Zalecany podział na dwa kompletne stosy

Jeden stos to około 19–27 tys. linii plus kod generowany. Zalecamy **dwa stosy**, aby recenzja
i weryfikacja odczytu nie czekały na cały zakres mutacji. To propozycja zmiany granicy dostawy,
**wymaga akceptacji maintenera**; bez niej obowiązuje jeden stos 1–9 i wspólny merge całego v1.

| Stos | Kompletna funkcja i granica merge |
| --- | --- |
| A, etapy 1–4 (~8–11 tys. linii) | Konto i pełny podgląd PR: powiązania, autodetekcja, Summary/Timeline/Code, checki/logi, kontekst composera i bezpieczny fallback aktualizacji. Odczyt bez mutacji PR w GitHub, bez aktywnego Viewed i edytorów zapisów. Wszyscy klienci działają samodzielnie, również offline/stale; merge całego A po jego pełnej weryfikacji jako kompletnej funkcji podglądu |
| B, etapy 5–9 (~11–16 tys. linii) | Pełna obsługa PR: Viewed, komentarze/review, lifecycle, metadane i CI. Bazuje na scalonym A i aktualnym dev; wszystkie PR B draft do zweryfikowania całego zakresu zapisów, potem wspólny merge B. Dopiero A+B stanowi pełne v1 z §1 |

Podział nie oznacza zgody na publikację części A lub B etapami. Dolny PR każdego zatwierdzonego
stosu celuje w `dev`, wyższe w poprzednią gałąź; merge całego stosu przez `gh stack merge`.
Rejestracja App zachowuje finalne prawa §2; sam stos A nie wystawia RPC zapisów GitHub.
Każdy etap utrzymuje zgodność i pionową funkcję w swojej gałęzi. Infrastruktura etapu 1
nie udaje wartości PR przed etapem 2; wartość na gałęzi nie jest zgodą na wcześniejszy merge.
Nie dodajemy web UI/component/Playwright testów ani trywialnych testów helperów.
Scenariusze integracyjne używają lokalnego fixture HTTP i bazy testowej.
Testy z rzeczywistym GitHub są wyłącznie opt-in (`CANOPY_LIVE=1`).

Przed gotowością całego stosu pełna lista sprawdzeń z AGENTS.md musi przejść:
install, gen:check, typecheck, lint, format:check, check:tmp (pełne testy, w tym integracyjne)
i web build; przy zaakceptowanym podziale dotyczy to osobno całego A i całego B.
QA UI obejmuje light/dark, desktop/phone/tablet, klawiaturę/czytnik, reduced motion,
krótkie i długie treści, sticky/scroll oraz iOS/Android z tym samym zestawem funkcji.

Włączanie po merge: capability i flagi domeny domyślnie wyłączone, pilotaż na wybranych kontach,
obserwacja p95/limitów i dopiero udostępnienie wszystkim. Gateway może wstrzymać polling
i mutacje bez usuwania powiązań. Rollback wyłącza funkcję i nowe RPC; migracje zostają addytywne,
starszy klient/gateway nadal obsługuje wątki, a cofnięta funkcja nie ponawia niepewnych zapisów.

## 12. Decyzje po przeglądzie i pozostałe pytania

1. **Auth per dom wątku — zaakceptowane.** Sign-in można rozpocząć z innego komputera;
   tokeny nigdy nie przechodzą między gatewayami. Broker kont jest poza v1.
2. **Pełny zapis v1 — zaakceptowane.** Komentarze i pełne code review, lifecycle z create/merge/
   auto-merge/update/close, metadane i sterowanie CI z osadzonymi logami (§1, §7).
   Każda mutacja jest jawną akcją użytkownika z receipt/uncertain, destrukcyjne wymagają
   potwierdzenia. Wywoływanie nowych mutacji przez agentów/boty pozostaje poza v1.
3. **Viewed z GitHub — zaakceptowane.** `viewerViewedState`, mark/unmark, optymistyczny zapis
   z rollback i odczyt `DISMISSED` po push; brak lokalnej tabeli i offline replay.
4. **Instalacja repo — zaakceptowane.** Bez zaakceptowanej instalacji nie ma automatycznego
   dostępu PR: Install/Manage repositories, PAT wyłącznie po jawnym wyborze.
5. **Auth release fallback — zaakceptowane.** Po indeksie CDN scalonym w #486 można użyć
   konta gatewaya; bez konta aktualizacje nadal działają. Zalecenie ustawienia: domyślnie on,
   z widocznym wyłączeniem i wyborem własnego konta (§10), bez dodatkowego opt-in.

**Do decyzji: jeden stos czy dwa?** Zalecenie: zaakceptować kompletne stosy A (podgląd i auth)
oraz B (pełna obsługa zapisów) z §11. Każdy scala się w całości po weryfikacji; granica A jest
użyteczną funkcją, a pełny zakres v1 pozostaje wymagany po B. Do tej decyzji zachowujemy jeden stos.
