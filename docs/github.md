# Konto GitHub i pull requesty

Status: **v1 zaimplementowane w draftowym stosie PR; dostępne po scaleniu całego stosu**, 2026-11-10. Etapy 1–3 w stosie implementują konta,
powiązania ręczne i automatyczne oraz Summary. Etap 4 dodaje pełny odczyt:
Timeline, review threads, checki/jobs/logi i Code, polling, kontekst composera
oraz fallback aktualizacji. Etap 5 dodaje jawne komentarze (post/reply/edit/delete)
i Viewed synchronizowane z GitHub, ze wspólnym preflightem, receiptami i audytem.
Etap 6 dodaje inline comments i zakresy LEFT/RIGHT, pending review ze wszystkimi
trzema werdyktami oraz resolve/unresolve. Etap 7 dodaje tworzenie PR z gałęzi wątku,
ready/draft, merge trzema metodami, kolejkę scalania, auto-merge, update branch i close/reopen.
Etap 8 dodaje edycję tytułu/opisu, reviewerów (osoby i zespoły), assignees i istniejących labels.
Etap 9 dodaje sterowanie CI oraz ujednolica wybór reviewerów. Cały stos pozostaje draftem do zakończenia weryfikacji i wspólnego scalenia przez maintenera.
Decyzje ustalone po przeglądzie: oficjalna GitHub App Canopy organizacji `itsoltech`, device flow,
wygasające tokeny użytkownika w domu wątku, pełny zakres zapisów opisany poniżej i Viewed
synchronizowane z GitHub. Implementacja jako jeden stos PR według §11.

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

### Cytaty do wątku

`Send to agent` przy komentarzu, komentarzu inline, podsumowaniu review,
nieudanym checku/jobie i otwartym fragmencie logu dodaje token do composera
wątku przy zapisanym kursorze. Akcja jest dostępna przy hoverze lub fokusie
oraz w menu elementu; na dotyku pozostaje widoczna. Zaznaczenie tekstu
komentarza w web pokazuje `Cite` tak samo jak na osi rozmowy. Podgląd tokenu
pokazuje treść, autora, repozytorium i numer PR, URL, czas oraz plik i linię
komentarza inline. Użytkownik może dopisać własny tekst wokół cytatu i dopiero
potem wysłać wiadomość. Akcja nie wysyła tury samodzielnie.

Źródło jest rozwiązywane wyłącznie w cache gatewaya, po owner/thread/account/
access revision i bieżącym powiązaniu PR. Wysyłanie nie odświeża dostępu ani
danych przez GitHub. Komentarze review zapisują do 8000 znaków diff hunk przy
odczycie panelu. Kontekst trafia do modelu razem z etykietą pochodzenia w miejscu
tokenu. Logi korzystają z istniejącego, zredagowanego cache; brak poświadczeń
i dowolnych URL w tej ścieżce. Mobile używa dotychczasowego tekstowego badge
i edytora fragmentu (`Cite` w menu), bez rozszerzania natywnego menu zaznaczenia.

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

Oficjalna aplikacja **Canopy by IT SOL** jest zarejestrowana i zainstalowana w `itsoltech`:
App ID **`5696311`**, slug **`canopy-by-it-sol`**,
[strona aplikacji](https://github.com/apps/canopy-by-it-sol),
publiczny Client ID **`Iv23liqSybfDzvusCyjP`**. Webhook jest nieaktywny, bez zdarzeń.
Nie istnieje client secret ani private key i ten przepływ nigdy ich nie używa.

| Uprawnienie repozytorium | Przyznane | Uzasadnienie i etap użycia |
| --- | --- | --- |
| Metadata | Read, obowiązkowe | Tożsamość repozytorium i dostęp instalacji |
| Pull requests | Read and write | Create, ready/draft, close/reopen, tytuł/opis, reviews/inline/resolve, request/re-request użytkowników i zespołów, Viewed oraz auto-merge |
| Contents | Read and write | Odczyt commitów/plików oraz merge i update branch przez API GitHub; update wymaga write także do head repo, również forka |
| Issues | Read and write | Labels i assignees PR przez Issues API oraz komentarze ogólne; bez zarządzania osobnymi issues |
| Actions | Read and write | Odczyt runs/jobs/logów, ponowienie joba, nieudanych jobów lub całego run oraz cancel run |
| Checks | Read | Check runs/suites, output i adnotacje, także od zewnętrznych dostawców |
| Commit statuses | Read | Starsze statusy commitów, uzupełniające check runs |
| Merge queues (`merge_queues`) | Read and write | Etap 7: scalanie w repozytoriach wymagających kolejki; bez omijania queue lub branch protection |
| Deployments (`deployments`) | Read | Statusy wdrożeń i preview links przy checkach. Przyznane dla przyszłych funkcji; nieużywane do czasu implementacji |
| Environments (`environments`) | Read | Nazwy i powiązania środowisk dla statusów wdrożeń i preview links. Przyznane dla przyszłych funkcji; nieużywane do czasu implementacji |
| Code scanning alerts (`security_events`) | Read | Findings code scanning jako dodatkowe źródło dla Fix findings. Przyznane dla przyszłych funkcji; nieużywane do czasu implementacji |
| Dependabot alerts (`vulnerability_alerts`) | Read | Findings Dependabot jako dodatkowe źródło dla Fix findings. Przyznane dla przyszłych funkcji; nieużywane do czasu implementacji |
| Discussions (`discussions`) | Read and write | Przyszła obsługa dyskusji repozytorium. Przyznane dla przyszłych funkcji; nieużywane do czasu implementacji |

| Uprawnienie organizacji | Przyznane | Uzasadnienie i etap użycia |
| --- | --- | --- |
| Members (`members`) | Read | Etap 8: pickery osób i zespołów dla reviewerów; później podpowiedzi wzmianek. Bez zmiany członkostwa lub zespołów |
| Projects (`organization_projects`) | Read and write | Przyszła obsługa tablic Projects. Przyznane dla przyszłych funkcji; nieużywane do czasu implementacji |

Account permissions: **brak**. Przyznane prawa nie rozszerzają allowlisty operacji Canopy.
Etap 1 korzysta tylko z tożsamości użytkownika i katalogu instalacji/repozytoriów;
nie odczytuje członków, wdrożeń, środowisk, alertów, dyskusji ani Projects i niczego nimi nie zapisuje.

**Contents: write zwiększa ryzyko kradzieży tokenu:** technicznie pozwala modyfikować kod
w wybranych repozytoriach. Canopy nie wykonuje nim git push ani zapisu plików/refów przez API;
allowlista dopuszcza tylko serwerowe merge i update branch. Te akcje zmieniają historię na GitHub,
nie lokalny checkout. Nie pobieramy Workflows: write, Administration ani uprawnień do e-mail.
Checks: write nie jest potrzebne i nie daje prawa do ponawiania dowolnego zewnętrznego CI.
Members: read pozwoli etapowi 8 uzupełnić pickery reviewerów o osoby i zespoły organizacji.
Bez tego prawa, również dla PAT, pozostają bieżące przypisania i podpowiedzi dostępnych
współpracowników repozytorium oraz osób, które już wykonały review. Nie ma dowolnego wpisywania
loginów ani tworzenia zespołów; GitHub ponownie sprawdza dostęp wybranych osób i zespołów.
Zakres v1 nie obejmuje osobnych funkcji Discussions, Projects ani dodatkowych źródeł alertów
i wdrożeń; ich nadane uprawnienia pozostają niewykorzystane do osobnej implementacji.
Faktycznie dostępne akcje nadal wynikają z praw użytkownika,
instalacji i repo. Dla GitHub App brak Actions: write wyłącza sterowanie CI z wyjaśnieniem.
PAT nie udostępnia pełnej introspekcji fine-grained permissions: odczyt roli repozytorium nie
potwierdza Actions: write. Ostateczna odmowa GitHub pozostaje błędem receiptu z wyjaśnieniem,
bez próby innym kontem ani ponowienia zapisu.
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
Mapowanie `(owner, dom, repository ID) → account ID` jest zapamiętywane per repozytorium.
Otwarcie pickera przy linkowaniu zachowuje ten wybór, a przy jego braku dobiera uprawnione
konto App; kilka dopasowań udostępnia przełącznik u góry pickera (§3).
Zmiana konta nie ponawia zapisów i usuwa dane starego
kontekstu dostępu. Identyfikatory GitHub przeżywają rename/transfer repozytorium i zmianę loginu.
Nie próbujemy kolejno kont po odmowie zapisu. PAT jest wyłącznie jawnym fallbackiem wskazanym
z istniejącego, własnego konta GitHub w Connectors; bez kopiowania tokenu do nowego rekordu.
Użycie REST/GraphQL wymaga sprawdzenia jego praw i przypisania repo, niezależnie od testu MCP.
Własny endpoint MCP i jego dowolne nagłówki nie są źródłem tokenu do GitHub API.

### Połączone komputery

Moduł kont negocjuje osobne `github_accounts_v1`; odczyty i zapisy PR mają własne
capabilities opisane w §6. Dziesięć RPC kont z `github.proto`
przechodzi przez bezpośrednie łącze: lista, start/status/cancel device flow,
disconnect, wybór PAT, katalog instalacji/repozytoriów oraz odczyt i wybór konta aktualizacji.
Konto i próba otrzymują
kwalifikowany identyfikator domu. Lista i start przed utworzeniem konta używają
kwalifikowanego znacznika `GITHUB_HOME`; znacznik służy tylko do routingu.
Próba z partnera wiąże skrót uwierzytelnionego klienta także z tożsamością partnera.
RPC kont nie przechodzą przez relay i nie trafiają do wspólnej konfiguracji.
Odczyty PR mogą przechodzić przez uprawniony relay z `github_pr_v1`;
capabilities zapisu nie są przekazywane przez pośrednika.

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

### Konfiguracja zarejestrowanej aplikacji i pilotaż maintenera

Stan rejestracji potwierdzony przez maintenera: **Canopy by IT SOL**, App ID `5696311`,
slug `canopy-by-it-sol`, instalacja w `itsoltech`, uprawnienia z tabel powyżej.
Webhook pozostaje nieaktywny, bez zdarzeń; Account permissions pozostają puste.

Kontrola ustawień w GitHub → Settings → Developer settings → GitHub Apps → Canopy by IT SOL:

1. Potwierdzić **Enable Device Flow** i **Expire user authorization tokens**.
   Nie zaznaczać **Request user authorization (OAuth) during installation**; używamy osobnej autoryzacji.
2. Pozostawić Callback URL i Setup URL puste oraz **Active** w sekcji Webhook wyłączone.
   Nie wybierać zdarzeń: lokalne gatewaye nie mają publicznego odbiornika.
3. Porównać Repository i Organization permissions z tabelami powyżej. Instalacja **Any account**
   pozwala użytkownikom wskazać własne organizacje i repozytoria; każda organizacja zatwierdza własną instalację.

Konfiguracja i pilotaż:

1. Oficjalna dystrybucja ma wbudowane publiczne Client ID `Iv23liqSybfDzvusCyjP` i slug
   `canopy-by-it-sol`. `CANOPY_GITHUB_APP_CLIENT_ID` i `CANOPY_GITHUB_APP_SLUG` nadpisują je
   dla forków; jawnie puste wartości dają stan braku konfiguracji. App ID nie zastępuje Client ID w OAuth.
2. Nie generować client secret ani private key: nie istnieją dla tego przepływu.
   Nie wpisywać tokenów użytkowników do konfiguracji procesu.
3. Potwierdzić dostęp do wybranego repozytorium testowego w istniejącej instalacji `itsoltech` przez stronę aplikacji.
   Druga organizacja wymaga akceptacji jej administratora; zanotować ten stan w UX instalacji.
4. Po wdrożeniu warstwy auth zalogować konto testowe device flow i sprawdzić instalacje,
   odświeżenie, Disconnect i revoke. Test opt-in uruchamia maintener z root:
   `CANOPY_LIVE=1 bun test tests/integration/github-accounts.live.test.ts`.
   Wypisuje wyłącznie URL weryfikacji i publiczny kod użytkownika, po czym czeka na jego ręczne wpisanie
   w przeglądarce, do zakończenia lub expiry (około 15 min). Wymaga lokalnego PostgreSQL testowego;
   nie pokazuje tokenów i odłącza konto testowe po odczycie katalogu. Pełne revoke wykonuje maintener na GitHub.
5. Przy każdej późniejszej zmianie permissions uzyskać zgodę instalacji przed włączeniem akcji.
   Maintener zarządza rejestracją aplikacji; właściciel gatewaya zarządza swoimi kontami.

[Rejestracja GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

## 3. Klient gatewaya, cache i koszt

Etap 2 udostępnia ręczne link/unlink i read-only Summary na web/desktop oraz mobile.
Katalog instalacji i odczyty PR używają jednego klienta REST/GraphQL, dzierżaw SQL i budżetu.
Summary zawiera najwyżej pierwsze 100 elementów każdego źródła; `partial` jawnie wskazuje
niepełny wynik i odsyła na GitHub. Etap 4 dodaje pełną paginację szczegółów,
watch/polling i rozbudowane metryki. PostgreSQL weryfikuje każdy odczyt, a LRU RAM do 32 MiB
ogranicza ponowne parsowanie tej samej generacji JSON. Retencja 30 dni i limit 100 MiB
dotyczą już trwałego cache etapu 2.
Etap 3 dodaje autodetekcję i wyróżnia PR bieżącej gałęzi przed historią; w każdej grupie
obowiązuje data utworzenia PR, nie data linku. Web/desktop i mobile pokazują źródło Auto/Manual
oraz Current branch/History. Unlink zachowuje trwały tombstone.

Test live odczytu Summary jest opt-in: z katalogu głównego uruchom
`CANOPY_LIVE=1 bun test tests/integration/github-pull-requests.live.test.ts`.
Wypisany publiczny kod device flow trzeba zatwierdzić kontem mającym dostęp do
`itsoltech/canopy` w instalacji Canopy. `CANOPY_LIVE_GITHUB_PR` wybiera numer PR (domyślnie 485).
Test tworzy lokalny wątek i link, czyta istniejący PR, a na końcu odłącza lokalne konto;
nie wykonuje zapisów do GitHub. Zwykłe testy używają wyłącznie kontrolowanego HTTP na loopback.

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

### Obrazy w treści PR

Opis PR, komentarze, review i wątki review na web/desktop oraz mobile jawnie włączają
obrazy w rendererze markdown. Markdown wątków agentów zachowuje obrazy jako linki.
HTML jest parsowany jako dane: obsługujemy `img` (`src`, `alt`, szerokość i wysokość
do 4096 px) oraz `br`; pozostałe tagi zostawiają tylko tekst. Style i event handlery
nie trafiają do DOM ani widoków natywnych.

`GetPullRequestImage` sprawdza owner PR i konto wybrane dla repozytorium, a następnie
przynależność węzła GitHub do tego PR. Gateway pobiera `bodyHTML` tego węzła przez
GraphQL i rozwiązuje oryginalne źródło obrazu do bieżącego podpisanego URL. Dzięki
temu prywatne załączniki działają bez przesyłania poświadczeń ani podpisanych adresów
do przeglądarki, telefonu czy modelu. BFF `POST /api/github/image` zwraca wyłącznie
ograniczone dane rastrowe. Rozwiązanie URL ma TTL 60 s, bajty obrazu 5 min; oba
odczyty korzystają ze wspólnego cache i single-flight z rewizją konta. Przed zwrotem
gateway ponownie weryfikuje mapowanie konta.

Dozwolone źródła HTTPS to `github.com/user-attachments/assets/<id>` oraz dokładne
hosty `private-user-images.githubusercontent.com`, `user-images.githubusercontent.com`,
`raw.githubusercontent.com` i `camo.githubusercontent.com`. Każdy z maksymalnie czterech
redirectów przechodzi tę samą kontrolę; nagłówek Authorization trafia wyłącznie do
endpointu załączników na `github.com`, nigdy do storage. Limit wynosi 2 MiB po
dekodowaniu transportu i 15 s na pobranie. Gateway sprawdza MIME oraz sygnaturę PNG,
JPEG, GIF lub WebP; SVG jest odrzucane. Niedozwolone i uszkodzone źródło zostaje
tekstem alternatywnym lub linkiem. Małe obrazy z wymiarami do 64 px mieszczą się
w linii; większe zachowują stałą ramkę (proporcje z wymiarów albo 16:9), dopasowanie
contain i szerokość najwyżej kontenera. Web pobiera większe obrazy dopiero blisko
viewportu, mobile przy montowaniu widocznego okna listy.

### Automatyczne konto repozytorium

Wspólny resolver gatewaya wybiera konto według dostępu do repozytorium dla linkowania,
Create PR, panelu PR, wykrywania gałęzi i odczytów wydań. Indeks owner + nazwa repo → konta
i instalacje powstaje z katalogu GitHub App, także dla instalacji organizacji. Jedno
dopasowanie działa bez kontrolki konta. Kilka zachowuje ostatni wybór dla repo, a bez niego
wybiera konto typu User przed Bot/App, potem według loginu i ID. Gateway zapamiętuje wybór;
klient pokazuje mały, opcjonalny przełącznik tylko przy kilku kontach z dostępem.
Brak dostępu pokazuje repozytorium i **Manage access** albo **Connect GitHub** wewnątrz
pickera/formularza. Nie wymaga wcześniejszego ręcznego mapowania konta.

Katalog jest ważny 15 minut. Istniejący poller co minutę odświeża wygasłe katalogi,
a ręczne odświeżenie instalacji wymusza ponowny odczyt. Połączenie/odłączenie konta również
aktualizuje indeks. Atomowa wymiana katalogu porównuje fingerprint instalacji, repo,
zawieszenia i uprawnień: zmiana podnosi rewizję dostępu, usuwa prywatny cache konta
i odświeża projekcje. Niezmieniony katalog zachowuje rewizję i ETagi. Odczyt z ciepłego
indeksu nie odpytuje GitHub. Zapamiętanie lokalnej preferencji nie wykonuje mutacji GitHub.
PAT pozostaje wyłącznie jawnym wyborem; resolver nie przeszukuje tokenów Connectors.
Odczyty wydań używają tylko świeżego indeksu i ważnego tokenu, bez czekania na odświeżenie.

### Picker repozytorium przy linkowaniu

`ListRepositoryPullRequests` rozwiązuje repozytorium z `git_origin` workspace’u należącego
do wątku. Weryfikuje właściciela przed odczytem konta/cache i ponownie sprawdza rewizję
dostępu przed odpowiedzią. Klient nie podaje konta, instalacji ani endpointu GitHub.
Konto rozwiązuje wspólny resolver opisany powyżej. Kilka dopasowań pokazuje kompaktowy
przełącznik konta u góry. Token użytkownika GitHub App zostaje w gatewayu.

Picker pokazuje domyślnie otwarte PR według ostatniej aktualizacji: najpierw pasujące
head refs (również z forków), potem PR wybranego użytkownika, następnie pozostałe.
Pierwsze dwie grupy mają stałe zapytania GraphQL, pozostałe używają REST `pulls` z ETagiem.
Wspólny cache ma TTL 30 s, obsługuje 304 i single-flight. Strony źródłowe i odpowiedzi
mają najwyżej 30 elementów; jedno RPC czyta najwyżej 3 strony. Podpisany kursor wiąże
owner/wątek/konto/rewizje/repo/gałąź/filtry i pozycję wewnątrz strony, wygasa po 15 min.
Wyszukiwanie po numerze, tytule, gałęziach i autorze filtruje te same cache’owane strony,
bez osobnego żądania GitHub przy każdej zmianie tekstu. Rzadkie dopasowania mogą wymagać
doczytania kolejnych stron przez **Load more**; nie uruchamiamy nieograniczonego skanu.

Web/desktop używa `Popover` i `Combobox`, mobile wspólnego arkusza i wirtualnej listy.
Otwarcie od razu pokazuje skeleton, bez odczytu GitHub przy otwieraniu całego wątku.
**Open / All** obejmuje także closed/merged; wybór linkuje istniejącą akcją i pozostawia
picker otwarty do kolejnego linku. Nagłówek mieści repozytorium, opcjonalne konto i filtr
w jednej linii. Wiersz ma najwyżej dwie linie: stan, numer i tytuł oraz gałęzie, autora
i krótki wiek. Aktualną gałąź, własny PR i powiązanie oznaczają ikony z dostępnymi etykietami;
miejsce na statusy jest stałe, a powiązane wiersze są wyłączone. Lista przewija się wewnątrz panelu.
Pole **Search or paste a link** przyjmuje numer PR lub URL, także innego repozytorium.
Pierwszy wynik **Link #123** albo **Link {url}** linkuje bez osobnego przycisku URL.
Nieudane linkowanie URL udostępnia dotychczasowy formularz kontroli dostępu.
Brak GitHub remote zachowuje wyszukiwanie z wklejeniem URL; brak konta, instalacji i limit API
mają odrębne stany, akcję połączenia/zarządzania repo lub czas resetu. Nie dodajemy natywnych
zależności, uprawnień ani konfiguracji mobile.
Panel wątku nie pokazuje podpowiedzi o wyborze konta ani ręcznym dopasowaniu gałęzi:
pusty stan to **No pull requests yet** i akcje linkowania/tworzenia. Brak konta lub dostępu
jest wyjaśniany dopiero w pickerze, wraz z właściwą akcją.

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
Timeout lub restart po wysłaniu oznacza **Couldn't confirm. Check on GitHub**.
Read-only reconcile porównuje GitHub ID/status i stan docelowy; sama równa treść nie dowodzi
wykonania konkretnego żądania. Gdy brak dowodu, użytkownik rozstrzyga po odświeżeniu.
`clientMutationId` GraphQL nie jest gwarancją idempotencji GitHub. Nie ma replay przy reconnect,
refresh tokenu ani zmianie konta. Szkice i niepewne wyniki komentarzy pozostają w pamięci
klienta (do 100 edytorów, izolacja account/PR/target), także po zmianie zakładki i odświeżeniu
Timeline. Zamknięcie procesu usuwa lokalny szkic; trwały receipt pozostaje w gatewayu.
Po sprawdzeniu źródła użytkownik może jawnie rozpocząć pusty komentarz/odpowiedź
albo ponownie otworzyć edycję; ta akcja nie wysyła poprzedniego szkicu.
W etapie 5 receipt jest związany także z uwierzytelnionym urządzeniem lub przeglądarką;
linked-home kwalifikuje potwierdzenie i odsyła odczyt receiptu do domu PR.
Potwierdzenie usunięcia wygasa po 60 s. Nierozstrzygnięty intent po wygaśnięciu
dzierżawy staje się uncertain, także po restarcie; nie uruchamia drugiego HTTP.
Odczyt Viewed po odświeżeniu rozstrzyga bieżący checkbox, lecz nie przypisuje sukcesu
konkretnej niepotwierdzonej operacji. Identyczna treść komentarza również tego nie dowodzi.
Migracja `0117_github_mutations.sql` dodaje receipty oraz wspólne tempo zapisów.
Numer jest kolejnym po bazie stosu; jeżeli diagnostyka wprowadzi swoją migrację
wcześniej, niezaaplikowane migracje stosu wymagają ponownej numeracji przed merge.
Migracja `0118_github_reviews.sql` rozszerza ten sam receipt i audyt o parametry
kotwicy, werdyktu oraz rewizji review; nie zapisuje treści komentarza w audycie.
Jej numer również wymaga sprawdzenia na podstawie stosu przed merge.

### Polling bez webhooków

Obserwator oznacza widoczny ekran, nie samo otwarte połączenie. Web używa widoczności strony,
mobile AppState i fokusu ekranu; krótka odnawiana dzierżawa widoku wygasa po 90 s.
Wiele kart/urządzeń współdzieli najszybszy potrzebny harmonogram.

| Widoczność | Harmonogram startowy | Zakres |
| --- | --- | --- |
| Otwarty PR, zakończone checki | Metadata PR na każdym ticku co 60 s oraz jedna rotacyjna strona check-runs/legacy statuses | Edycje komentarzy wykrywane po około 60–66 s; najwyżej 10 warunkowych żądań w 5 min po inicjalizacji |
| Otwarty PR, trwające checki | Zasoby checków z pending/in progress co 15 s; metadata i jedna pozostała strona CI co 60 s | Bez okresowego GraphQL, timeline ani diffów |
| Widoczny panel wątku | Ten sam współdzielony harmonogram warunkowy | Bez osobnego pollera nagłówków |
| Closed/merged, także widoczny | Brak okresowego pollingu | Zmiany po ręcznym Refresh lub własnej mutacji |
| Aktywny wątek w tle | Bez okresowego odświeżania danych PR | Rozpoznanie po zmianie checkoutu/pushu pozostaje osobnym zdarzeniem |
| Brak obserwatorów i aktywności albo archiwum | Brak okresowego pollingu | Wznowienie po otwarciu, zmianie gałęzi/pushu lub ręcznym Refresh |

Wymagane przez endpoint `x-poll-interval` jest dolną granicą. Terminy watcha mają jitter +0–10%,
aby nie wyprzedzać TTL cache. Bez widocznego panelu nie odświeżamy okresowo danych PR.
Metadata, check-runs i legacy statuses mają rzeczywiste ETagi REST; odpowiedź 304 zachowuje
projekcję. Pierwsze otwarcie może zainicjować walidatory odpowiedziami 200. GraphQL POST
nie udaje żądania warunkowego: pełne podsumowanie pobieramy dopiero po zmianie
`updated_at`, head/base SHA lub stanu, a stronę checków po zmianie sygnału checków.
Timeline i reviews unieważniamy po zmianie metadata, pliki/commity dopiero po zmianie SHA
lub ręcznym odświeżeniu. Bez zmiany nie pobieramy tych stron w tle.
Metadata nie bierze udziału w rotacji stron CI: każda wolna iteracja pyta o `updated_at`,
które GitHub zmienia także po edycji komentarza. Bez zmian dodatkowy probe kończy się
304 i nie zużywa podstawowego limitu REST; nadal obowiązują budżety, backoff,
`x-poll-interval`, jitter i wspólny single-flight. Dla jednego PR to najwyżej około
60 prób metadata/h oraz 60 rotacyjnych prób CI/h przy zakończonych checkach.
Termin wolnego ticku uwzględnia wygaśnięcie cache metadata po odpowiedzi, żeby czas
żądania nie powodował pominięcia kolejnej walidacji. Dłuższy interwał serwera nadal ma pierwszeństwo.
Nie powstaje nowy poller. Po zmianie metadata klient odświeża timeline/reviews z
`refresh=true`: gateway pomija nawet niewygasły cache strony i pobiera bieżące `body`
przez GraphQL. Sam upływ ticku bez zmiany nie odczytuje timeline.
Sweep utrzymaniowy i odnawiane streamy dzielą terminy oraz single-flight. Przez 5 min
po zamknięciu zachowujemy harmonogram bez wykonywania pracy; odnowienie dzierżawy
nie uruchamia ponownie odczytów. Ostatni ukryty obserwator anuluje trwający probe.
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

Założenie do oszacowania: 1 widoczny PR z trwającym CI,
jedna strona nagłówka/timeline, bez przewijania. Checki to najwyżej 240 odczytów/h,
nagłówek i timeline po 60/h: **do 360 requestów/h**, około **360–1800 punktów GraphQL/h**
przy koszcie 1–5. Zbiorcza weryfikacja nagłówków ma osobny TTL 5 min i obejmuje tylko
widoczne PR; brak widoku oznacza zero okresowych odczytów. Discovery działa na zdarzenie/żądanie.
Kilka PR jednego repo dzieli partię, różne repo zwiększają koszt liniowo.
Lokalny miękki limit Canopy to 1500 punktów GraphQL i 1000 requestów REST/h/użytkownika;
poller wydłuża odstępy, gdy pomiar kosztu nie mieści się w limicie. To budżet Canopy, nie limit GitHub.

Typowa odpowiedź ma mieć ≤ 64 KiB; przy 360 odpowiedziach/h to około 23 MiB/h.
Założone 1–5 ms CPU na walidację/projekcję daje 0,36–1,8 s CPU/h, czyli < 0,1% jednego rdzenia.
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
| `github_repository_accounts` | Owner + repo ID → zapamiętane konto i rewizja; automatyczny wybór według indeksu instalacji, opcjonalna zmiana przy kilku dopasowaniach |
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
Weryfikujemy najwyżej 10 kandydatów na partię i zachowujemy również pozycję wewnątrz strony;
zmiana pełnego HEAD rozpoczyna nowy przebieg, bez ponownego użycia cache pustego wyniku dla starego SHA.
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
W etapie 3 dowodem jest ostatni zapisany snapshot checkoutu sprzed zakończenia narzędzia
(czas ograniczamy również czasem zapisu eventu w gatewayu). Brak takiego snapshotu daje
komunikat z propozycją ręcznego Link, zamiast użycia kontekstu odczytanego dopiero po wyniku.
Analizę ograniczamy do 64 KiB już w projekcji SQL; watermark i dzierżawa przetrwają restart.

Canopy nie ustawia `GH_TOKEN`, credential helpera ani loginu `gh` na workerze.
`gh` używa własnej autoryzacji urządzenia, jeśli użytkownik już ją skonfigurował;
bez niej agent korzysta z istniejącego gatewayowego connectora z odpowiednim grantem.
Samo połączenie GitHub App nie nadaje agentom ani botom dostępu do konta.

Dowód merge dla cleanup z nowego klienta jest dostępny wyłącznie dla jawnie wybranego PAT
z aktualnym grantem konektora dla workera. Wymaga świeżej listy i szczegółu PR, zgodnego
pełnego SHA/ref oraz obu repository ID; po odczycie ponownie sprawdzamy konto, mapowanie i grant.
Konta device flow nie mają obecnie takiego grantu i samo zalogowanie nie upoważnia do cleanup.
Dotychczasowy dowód MCP, niezależne sprawdzenia git i ochrona lokalnych zmian pozostają aktywne.

### Create PR z gałęzi wątku

Jawne **Create pull request** odczytuje ten sam kontekst git i automatycznie rozwiązuje konta
head oraz base według dostępu. Nagłówek zaczyna się od owner/repo, następnie pokazuje
head → base bez pustego separatora konta. Base pochodzi z zapisanego base wątku, jeśli nadal
istnieje, albo z domyślnej gałęzi repo; kompaktowy picker pozwala go zmienić. Przełącznik
konta pojawia się tylko przy kilku kontach z dostępem. **Draft with agent** i **Review pull request**
działają po uzyskaniu wymaganych pól oraz opublikowanego head SHA.
Canopy nie wykonuje push ani tworzenia forka w tle. Osobne komunikaty rozróżniają brak
opublikowanej gałęzi i lokalne niewypchnięte commity. Istniejące API nie ma akcji push;
formularz wskazuje git lub agenta oraz odświeżenie po wypchnięciu.
**Draft with agent** po jawnym kliknięciu uruchamia jedną zwykłą turę wątku z ograniczonym
załącznikiem repo/ref/SHA, listą commitów i wybranymi diffami (limity §7). Formularz pokazuje
stan ładowania i wypełnia pola tytułu oraz opisu wyłącznie zweryfikowaną odpowiedzią tej tury.
Wynik modelu jest propozycją tekstu, nie żądaniem API. Utrata odpowiedzi nie ponawia wysłania;
użytkownik sprawdza wynik w wątku. Opis ma wspólny z komentarzami edytor Markdown i podgląd.
Użytkownik ogląda i edytuje całą treść oraz cel, potem osobno klika **Create pull request**.
Zmiana repo/ref/SHA unieważnia wcześniejsze sprawdzenie formularza; model nie ustala konta ani praw.
Formularz ogranicza tytuł do 256 znaków, opis do 64 KiB i respektuje dodatkowe limity GitHub;
przekroczenie limitu nie obcina treści publikowanej bez wiedzy użytkownika.

Po potwierdzeniu utworzenia gateway transakcyjnie zapisuje receipt i `source=auto`,
evidence=`product_create` dla źródłowego wątku. Awaria lokalnego linku po utworzeniu PR
uruchamia read-only reconcile po upstream ID, bez ponownego create. Konflikt „PR already exists”
proponuje link do zweryfikowanego PR i respektuje tombstone; nie tworzy duplikatu ani nie odpina
innych PR. Utrata odpowiedzi create pozostaje uncertain do rozstrzygnięcia, także po restarcie.

Implementacja lifecycle negocjuje `github_pr_lifecycle_v1`. Migracja `0119_github_lifecycle`
rozszerza wspólny receipt o wątek, repozytorium i potwierdzony upstream ID nowego PR oraz stan
`accepted`. Numer należy zweryfikować przed scaleniem stosu, jeżeli równolegle dochodzą migracje.
Po trwałym zapisaniu upstream ID ponowne otwarcie formularza sprawdza tylko receipt i odczytuje PR;
lokalny link jest transakcyjny i zachowuje tombstone. Brak odpowiedzi bez takiego dowodu nigdy
nie wywołuje drugiego create. Wszystkie akcje lifecycle wymagają potwierdzenia ważnego 60 s,
związanego z klientem, kontem, pełnym head/base SHA i parametrami. Enqueue, update branch
i enable auto-merge pokazują przyjęcie zlecenia, a ich wynik odświeża zwykły odczyt GitHub.

## 6. Proto i API UI

Metadane negocjują `github_pr_metadata_v1`. `GetPullRequestMetadata` zwraca świeżą rewizję
tytułu/opisu oraz pełnych zbiorów przypisań i stronicowany katalog wyboru. Request/re-request/remove
używa osobnych ID użytkowników i zespołów; gateway sprawdza repozytorium etykiety, organizację
i dostęp zespołu do repo oraz przynależność osoby. Autor PR jest wykluczony z reviewerów.
Brak Members: read ogranicza katalog do współpracowników repo i pokazuje przyczynę w pickerze.
Assignees i labels wymagają Issues: write. Nie ma tworzenia etykiet ani zapisów workera/bota.

Wszystkie edytory web/desktop/mobile mają jawne **Apply**, lokalny szkic, optymistyczną prezentację
i rollback. Preflight porównuje rewizję z bieżącym odczytem; konflikt zachowuje szkic i pokazuje
zmieniony fragment obok wersji GitHub, z jawnym **Refresh fields**. Zapis REST jest pojedynczy,
bez retry, a odczyt po zapisie sprawdza wynik. GitHub nie udostępnia atomowego compare-and-swap
dla tych pól; preflight ogranicza okno wyścigu, ale go nie usuwa. Rozbieżność po zapisie lub utrata
odpowiedzi pozostaje `uncertain`, bez automatycznego ponowienia. Receipty i audyt wykorzystują
istniejący store; parametr strukturalny zawiera rewizję/ID/tryb review, bez tytułu/opisu i sekretów.
Etapy 8–9 nie dodają migracji. Picker reviewerów wstępnie zaznacza bieżące requesty;
**Apply** oblicza usunięcia i nowe prośby. Usunięcia i dodania mają osobne receipty,
z odczytem i sprawdzeniem rewizji pomiędzy nimi. Częściowy lub niepewny wynik zatrzymuje diff
bez automatycznego wznowienia. **Re-request review** jest osobną akcją ikonową przy osobie,
która już wykonała review, w Summary i w pickerze. Zespoły oznacza ikona zespołu.

CI negocjuje końcową capability `github_pr_write_v1`; wcześniejsze, węższe capabilities
comments/review/lifecycle/metadata pozostają obsługiwane. Prepare dla CI oraz oba RPC zapisu
wymagają nowej capability na obu końcach bezpośredniego łącza. Run/job ID pozostają upstream ID;
account/PR/confirmation ID są kwalifikowane domem. Receipty są związane z uwierzytelnionym
klientem i partnerem, a zapis odbywa się wyłącznie w domu konta. Brak domu nie kolejkuje zapisu.

Rozszerzamy istniejący **`canopy.ui.v1.GatewayService`**, z wiadomościami w nowym
`proto/canopy/ui/v1/github.proto`. To domena w istniejącej usłudze, nie drugi serwer API.
`api/ui-github.ts` składa handlery analogicznie do `ui-connectors.ts`.

| Grupa RPC | Kontrakt |
| --- | --- |
| `ListGitHubAccounts`, `BeginGitHubDeviceAuth`, `GetGitHubDeviceAuth`, `CancelGitHubDeviceAuth`, `DisconnectGitHubAccount` | DTO konta i stanu próby bez tokenów/device code; żądania mają dom, nie dowolny URL |
| `ListGitHubInstallations`, `ListGitHubRepositories`, `SetGitHubRepositoryAccount` | Stronicowany katalog dostępnych repo, opcjonalna zmiana automatycznie rozwiązanego konta i expected revision |
| `ListThreadPullRequests`, `LinkThreadPullRequest`, `UnlinkThreadPullRequest`, `RefreshPullRequest` | Thread ID + kanoniczna tożsamość PR; link zweryfikowany w gatewayu; tombstone atomowy |
| `GetPullRequest`, `WatchPullRequest`, `ListPullRequestTimeline`, `ListPullRequestReviewThreads`, `ListPullRequestFiles`, `GetPullRequestDiff` | Nagłówek, checki, cursory i rewizje; patch tylko dla wskazanego pliku i SHA; prywatne pending review per konto |
| `CreatePullRequestComment`, `ReplyPullRequestReviewThread`, `UpdatePullRequestComment`, `DeletePullRequestComment`, `SetPullRequestReviewThreadResolved` | Typ komentarza i upstream ID związane z PR; edycja/usunięcie tylko własnego komentarza; resolve/unresolve według aktualnych praw |
| `AddPullRequestReviewComment`, `SubmitPullRequestReview`, `DiscardPullRequestReview`, `SetPullRequestFileViewed` | Inline z path/startSide/startLine/endSide/endLine/commit OID, pending review ID oraz event Comment/Approve/Request changes; Viewed wywołuje GitHub |
| `CreatePullRequest`, `SetPullRequestDraft`, `MergePullRequest`, `SetPullRequestAutoMerge`, `UpdatePullRequestBranch`, `SetPullRequestOpen` | Jawna akcja użytkownika, oczekiwany head/base i dozwolona metoda; create z thread ID; receipt również dla accepted/uncertain |
| `UpdatePullRequestDetails`, `RequestPullRequestReviewers`, `SetPullRequestAssignees`, `SetPullRequestLabels` | Tytuł/opis z rewizją, walidowane request/re_request/remove z rozróżnieniem user/team, zmiana przypisań w obrębie jednego repo |
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
następnie zmienione podsumowanie/checki oraz invalidacje zmienionych zasobów; nie całą historię co tick.
Zmiana checków nie pobiera ponownie diffów ani commitów. Jawny Refresh i własna mutacja
wymuszają ponowny odczyt. SQL zachowuje projekcje i ETag po restarcie, a dzierżawy
oraz single-flight łączą współbieżne żądania. REST 304 ponownie używa projekcji bez kosztu primary rate limit.
Obietnicę wspólnego odczytu rejestrujemy przed asynchronicznym lookupem cache, osobno dla
zwykłego odczytu i wymuszonego Refresh. Po przejęciu dzierżawy ponownie sprawdzamy świeżość
cache: inny serwis mógł go uzupełnić przed odczytem generacji. Dotyczy to także obrazów;
obietnica i kontroler znikają zarówno po sukcesie, jak i po błędzie.
Pojedyncze współdzielone pobranie ma limit 55 sekund. Timeout
anuluje transport, usuwa wpis in-flight i zwalnia dzierżawę cache także wtedy, gdy
transport nie reaguje na anulowanie. Współbieżny odbiorca może rozpocząć jeden nowy
odczyt; kolejny timeout kończy się błędem zamiast nieskończonych ponowień.
Web i mobile przechowują strony per PR/account/access revision/SHA w LRU sesji.
Odwiedzone zakładki pozostają zamontowane, a rewalidacja aktualizuje kluczowane wiersze
bez czyszczenia treści, pozycji przewijania i rozwinięć. Szkielety są tylko na pierwszym
odczycie; błąd odświeżenia zachowuje dane i udostępnia Retry. Dwa źródła Timeline
nie wyświetlają osobnych etykiet Loading. Refresh ma stałe miejsce w nagłówku.

Awatary aktorów pochodzą z `avatarUrl`/`avatar_url` w payloadzie; typ Bot zachowuje
sufiks `[bot]`. `GetPullRequestAvatar` sprawdza właściciela przed cache i zwraca
ograniczony raster jako data URL. Gateway akceptuje tylko HTTPS CDN GitHub `/u/{id}`
lub `/in/{id}`, bez redirectów i credentiali; limit wynosi 128 KiB, TTL 24 h.
Przeglądarka/telefon nie pobierają awatarów z GitHub. Inicjały i nieaktywne checkboxy
zadań Markdown zachowują normalny kontrast.
Akcje checka mają jedno menu „…” o stałej szerokości: Cancel tylko dla aktywnego run,
Re-run dla zakończonego, Re-run failed jobs dla wyniku z nieudanymi jobami.
Nie jest to stream GitHub: poller jest jedynym producentem. Po luce klient ponawia fetch
i rewaliduje załadowane strony. Panel wykorzystuje `WatchThread` i małe pole podsumowania
w `ui.Thread`; pełną listę pobiera osobno. Odrębna rewizja PR nie zwiększa historii tokenowych delt wątku.
Pending review i jego liczniki są prywatnym odczytem konta, bez publikacji w lustrze wątku
ani owner feed dostępnym przy innym kontekście konta. Capability zapisu jest ogłaszana dopiero
po dostarczeniu całej grupy v1; starszy dom z samym odczytem nie przyjmuje nowych mutacji.
Etap 5 ogłasza węższą capability `github_pr_comments_v1` dla siedmiu RPC
preflight/receipt/comment/Viewed. Nie ogłasza jeszcze `github_pr_write_v1`, która
oznacza kompletny zakres zapisów. Allowlista linked computers wymaga tej węższej
capability; workery i boty nie mają dostępu do mutacji przez GatewayService.
Etap 6 dodaje osobne `github_pr_review_v1`: prywatny pending review i pięć RPC
inline/submit/discard/resolve. Nadal nie ogłasza kompletnego `github_pr_write_v1`.
Gateway odczytuje własny pending review konta, stronicuje komentarze po 50 i przed
submit/discard ponownie weryfikuje wszystkie strony, ich digest, liczbę i aktualny head.
Zmiana review na innym urządzeniu wymaga odświeżenia; push wymaga ponownego
przeglądu i jawnego potwierdzenia outdated anchors. Dzierżawa kolejki jest odnawiana
podczas paginacji. Własny PR dopuszcza tylko Comment; uprawnienia i właściciel
docelowego review/thread/comment są sprawdzane w gatewayu przed zapisem do GitHub.

Timeline pobiera ostatnie 50 zdarzeń (`last/before`), pokazuje je od najnowszych i doczytuje starsze.
Normalizuje otwarcie/zamknięcie/merge/reopen, commity, komentarze, review, zmiany reviewerów,
etykiet i gałęzi oraz pozostałe typy z bezpiecznym opisem i linkiem źródłowym.
Review threads, ich odpowiedzi i check contexts mają własne cursory, także ponad pierwsze 100.
Gateway i wspólny widok aktywności pomijają `MentionedEvent`, `SubscribedEvent` i `UnsubscribedEvent`,
także gdy mają autora i datę. Ten sam filtr ukrywa te wpisy z istniejącego cache web/desktop i mobile
oraz nieobsługiwane typy zawierające tylko `__typename`, bez daty i treści. Autor i czas pochodzą
z pól payloadu (`actor`/`author`, `createdAt`). Obsługiwane zdarzenia mają widoczny opis;
brak daty pomija czas zamiast pokazywać samo „ago”.
Paginacja nadal obejmuje wszystkie strony źródła; „pełna” nie oznacza jednej strony.
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

Trwające checki, jobs i podsumowania CI w web i mobile używają tego samego pierścienia,
koloru pracy i cyklu obrotu co aktywny wątek w sidebarze. Etykieta dostępności to
**Running**; kolejka zachowuje nieruchomy zegar. Zmiana stanu zachowuje rozmiar ikony
i używa animacji zamiany, z uwzględnieniem ograniczenia ruchu. Web wstrzymuje obrót
poza widocznym obszarem i w ukrytej karcie; mobile zatrzymuje go w tle aplikacji.

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

Re-run failed/all/job i cancel mają wspólny preflight z komentarzami oraz świeży odczyt
run/joba wewnątrz kolejki zapisów. Gateway sprawdza owner/account/revision/repo/PR/head SHA,
numer attemptu, prawa użytkownika i Actions: write instalacji. Cancel wymaga niewygasłego,
powiązanego z klientem potwierdzenia całego run; dialog obejmuje także wpływ na pozostałe PR
współdzielące run. Re-run joba ponawia również zależne joby według semantyki GitHub;
dialog wyjaśnia możliwe ponowne deploymenty. API jobs nie udostępnia grafu `needs`, więc
Canopy nie wymyśla zależności na podstawie kolejności ani nazw jobów.

Odpowiedź 201/202 daje receipt **accepted**, nie **succeeded**. Checki i jobs pokazują
queued/in-progress dopiero po odczycie GitHub przez watch/polling z etapu 4. Akcja **Check current state**
jest odczytem i jawnym odblokowaniem kolejnej decyzji, nigdy ponowieniem poprzedniego POST.
Utrata odpowiedzi lub restart z opuszczonym in-flight daje **uncertain**, bez replay.
Stałe endpointy Actions i puste body nie dopuszczają workflow_dispatch, debug logging ani force-cancel.
[Logi jobs](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run),
[ponowienie i anulowanie runs](https://docs.github.com/en/rest/actions/workflow-runs).

BFF `apps/web/src/routes/api/github/**` używa tych samych protobuf JSON/SSE i reguł origin co
pozostałe API; nie podaje tokenu do przeglądarki. Mobile wywołuje te RPC istniejącym przypiętym
Connect (`apps/mobile/src/api/pinned.ts`). Urządzenia mają istniejący, odwoływalny zakres UI
właściciela, a każda usługa egzekwuje owner scoping; obecna architektura nie ma osobnej
allowlisty metod urządzeń. Nowe metody dopisujemy jawnie do allowlisty linked computers.
Nie poszerzamy uwierzytelnienia ani zakresu urządzeń. Starszy dom pokazuje **Update this computer**,
bez awaryjnego odpytywania GitHub przez przeglądarkę. Przez pośrednika przekazujemy wyłącznie
przecinające się capability i istniejące zgody udostępniania; nie dodajemy dodatkowego hopa.

## 7. Interfejs web i desktop

Pokazane materiały referencyjne przedstawiają neutralny układ: listę PR pod gałęzią,
osobny widok z nagłówkiem i trzema zakładkami, a także menu akcji przy danym PR.
Przenosimy przepływ, korzystając z istniejących paneli, nawigacji i komponentów Canopy.
Obecny `features/navigation/AppShell.svelte` organizuje widoki trasami, bez ogólnego paska
kart dokumentów. PR otwiera się w istniejącej prawej kolumnie wątku na desktopie,
a na wąskim ekranie w arkuszu; parametr `pr` adresu wątku pozwala wrócić do tego panelu.
Rozmowa, szkic i pozycja przewijania pozostają zamontowane. Mobile używa pushed screen.
Panel zawiera zakładki Summary, Timeline i Code w tym samym pasku.

Web i desktop przewijają cały panel jednym pionowym obszarem: nagłówek, zakładki
i treść. Pełny nagłówek zachowuje wysokość w układzie; po przewinięciu go zostaje
przyklejony pasek 48 px ze stanem, repo i numerem, jednoliniowym tytułem
(pełny w tooltipie), checkami, główną akcją, menu i zamknięciem. Zakładki przylegają
pod nim; filtr Timeline i paski Code uwzględniają ich wspólną wysokość. Przyklejone
wiersze malują nieprzezroczyste tło do krawędzi panelu, także w ciemnym motywie.
`IntersectionObserver` przełącza stan z histerezą 16 px, a `ResizeObserver` mierzy
nagłówek i zakładki tylko przy zmianie rozmiaru. Przełączenie nie zmienia wysokości
treści ani pozycji przewijania; krótki ruch używa tokenów i znika przy reduced motion.
Każda zakładka zachowuje własną pozycję w cache sesji. Patche zachowują poziome
przewijanie wewnątrz pliku, bez osobnego pionowego viewportu.

Zmiana rewizji PR w overview wątku i wznowienie overview po przerwie oznaczają
odświeżenie współdzielonego odczytu, bez usuwania ostatniego snapshotu. Web/desktop
(panel oraz osobna strona PR) i mobile zachowują zamontowane sekcje, rozwinięcia
i scroll podczas rewalidacji tego samego PR. Skeleton jest stanem pierwszego
odczytu bez cache; błąd odświeżenia zachowuje treść i udostępnia Retry. Zmiana
konta/rewizji dostępu nadal rozdziela cache sekcji, a autorytatywny snapshot domu,
usunięcie komputera i zmiana parowania zachowują czyszczenie prywatnych danych.

Prawy panel PR korzysta ze wspólnego `ResizeHandle`, tak jak lewy sidebar. Uchwyt na lewej
krawędzi obsługuje przeciąganie, strzałki (Shift przyspiesza), Home/End oraz reset dwuklikiem
lub Enter. Domyślna szerokość to 576 px, zakres 320–1200 px; maksimum zostawia 384 px dla
wątku i przy małym oknie może ograniczyć panel poniżej minimum. Poniżej `xl` pozostaje arkusz.
Szerokość jest lokalną preferencją urządzenia (`pullRequestWidth` w tym samym magazynie co
`sidebarWidth`), bez synchronizacji ustawień konta. Podczas przeciągania aktualizuje się
wyłącznie zmienna CSS w `requestAnimationFrame`; stan i zapis zmieniają się po puszczeniu
uchwytu. Animacja kolumny jest w tym czasie wyłączona.

1. **Panel wątku.** Pod `ThreadPlacement`/Branch lista **Pull requests**: tytuł, repo gdy potrzebne,
   `#number`, stan i checki. Domyślnie najnowszy PR bieżącej gałęzi według utworzenia;
   **Show N more** rozwija resztę. Historyczne powiązania są oznaczone osobno, ręczne pozostają
   dostępne po zmianie gałęzi. **Link pull request** otwiera kompaktowy picker repozytorium workspace’u
   (arkusz na telefonie), a **Create pull request** otwiera
   formularz dla gałęzi wątku (§5). Pusty wynik nie jest błędem auth.
2. **Nagłówek PR.** Repo, numer, tytuł, autor, updated time, `base ← head`, liczba plików, +/−,
   stan Open/Merged/Closed/Draft. `gh pr checkout N` jest kopiowalnym tekstem; dopisek określa repo.
   Kopiowanie nie uruchamia komendy ani nie zmienia lokalnej gałęzi. Długi tytuł ma dwie linie;
   po przewinięciu nagłówek jest kompaktowy, ale zachowuje stan i nawigację.
3. **Summary.** Reviewers, assignees i labels z edycją według praw, opis Markdown, checki i komentarze.
   Checki pokazują queued/in progress/success/failure/cancelled/skipped/neutral/timed out,
   nazwę wykonawcy, SHA i link. Brak checków/niepełny odczyt nie jest „All checks passed”.
   Wynik zbiorczy dotyczy wykonanych checków, nie gwarantuje spełnienia branch protection.
   Wiersz checka rozwija jobs i logi; ikonowe akcje checka/run/joba mają tooltipy.
4. **Timeline.** Zdarzenia, commity, komentarze i reviews od najnowszych. Rozwinięcie review
   doczytuje dyskusje i odpowiedzi; zachowuje identyfikatory, autorów, permalink i oznaczenie
   outdated/resolved. Paginacja nie przesuwa właśnie czytanego zdarzenia.
   Filtr typu i ikona kolejności mieszczą się w jednym wierszu. Oś pokazuje autora, ikonę
   zdarzenia i czas względny (pełna data w tooltipie). Kolejne commity tego samego autora
   tworzą grupę z krótkimi SHA. Dyskusje są wplecione w oś z kontekstem plik:linia,
   wciętymi odpowiedziami i stopniowym doczytywaniem; komentarze używają kart Markdown.
5. **Code.** Lista/drzewo plików, +/−, Viewed, filtr commitu, Stacked/Side by side, wrap,
   widoczność whitespace i drzewo. Są to rozszerzenia `DiffLines`/`diff-layout.ts` i mobilnego
   `DiffContent`, nie nowy parser. Whitespace jest przełącznikiem prezentacji znaków;
   rzeczywisty patch i liczniki pozostają zgodne z GitHub, bez udawania nowego porównania git.
   Jeden górny pasek zawiera kompaktowy filtr commitu, liczbę plików i ikony układu,
   wrap, whitespace i drzewa. Wiersz pliku ma chevron, ikonę zmiany, środkowo skróconą
   ścieżkę (przy rename starą → nową) i +/−. Patch rozwija się bezpośrednio pod wierszem,
   którego nagłówek pozostaje przyklejony podczas przewijania. Link do GitHub jest ikoną
   w nagłówku; binarne/duże pliki mają krótki komunikat i akcję. Foldery drzewa są zwijane.
   Etap 5 dodaje Viewed do wiersza i licznik X/N viewed do paska Code. Stan całego PR ma ikonę i tekst w nagłówku;
   pojedyncze statusy wierszy pozostają ikonami z etykietami dostępnymi i tooltipami.
   Checki używają jednego „Show more”, które przezroczyście doczytuje kolejne strony.
   Filtr commitów ma ograniczoną szerokość 28 rem (nie więcej niż viewport minus 1 rem),
   krótkie SHA i skrócone tematy z pełnym tekstem w tooltipie. Na wąskim panelu licznik
   zachowuje X/N, pomijając słowo „viewed”. Whitespace `pre` obejmuje sam kod, bez odstępów
   szablonu między wierszami. Bez wrap każdy plik przewija się poziomo; wrap zawija kod
   wewnątrz dostępnej szerokości, również w układzie split.

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
Code odczytuje Viewed po otwarciu/fokusie, zmianie SHA, własnym zapisie i ręcznym Refresh;
nie uruchamia dodatkowego timera pobierającego pliki przy każdym ticku CI.

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
| CI i logi | Jedno menu w wierszach checków/jobs Summary i podglądzie logu | **View logs**, **Re-run**, **Re-run failed**, **Cancel run**; kontekst wiersza i dialog rozróżniają cały run od jednego joba. Pokazujemy run/attempt/SHA, zależne joby jako skutek ponowienia i możliwy deploy. Cancel potwierdza cały run i wpływ na pozostałe PR z tym run. Zewnętrzne CI i brak praw wyłączają akcje z przyczyną |

Komentarze, podsumowania review, checki, joby i logi używają jednego menu akcji
w web i mobile. Grupa **Canopy** zawiera **Send to agent** (oraz **Cite** w mobile),
a po separatorze grupa **GitHub** zawiera akcje zdalne i **Open on GitHub**,
gdy dany element ma bezpieczny URL. Puste grupy są pomijane. Nie ma osobnego
skrótu z ikoną wysyłania; stały przycisk menu zostawia miejsce na długie nazwy
i nie przesuwa **View logs** przy najechaniu lub fokusie. Puste kontrolki
stronicowania i pusta odpowiedź jobs nie zostawiają odstępu przed linkiem do providera.

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
Natywny diff montuje najwyżej 100 oryginalnie numerowanych wierszy na stronę;
wybór zakresu zachowuje kotwicę przy przejściu między stronami.

| Funkcja v1 | Telefon i tablet |
| --- | --- |
| Inline i review | Tap numeru linii w gutter wybiera stronę; **Select range** pozwala wskazać początek i koniec bez gestu drag. Arkusz pokazuje path, LEFT/RIGHT, SHA i zakres w unified oraz split; edytor ma **Add single comment**/**Add to review**. Pending badge otwiera listę wszystkich uwag i **Comment / Approve / Request changes** z **Submit review**; resolve/unresolve i reply przy rozmowie, edit/delete własnego komentarza w jego menu, discard z potwierdzeniem |
| Viewed | Checkbox przy pliku zapisuje na GitHub; optymistyczny stan/rollback, `DISMISSED` i blokada offline identyczne jak §7; zmiana AppState/fokusu rewaliduje stronę |
| Create i lifecycle | **Create pull request** pod Branch; pełnoekranowy formularz base/head/konto/draft z **Draft with agent**, edycją propozycji i osobnym Create. Nagłówek i arkusz overflow mają ready/draft, update branch, close/reopen, merge/squash/rebase i auto-merge on/off; dialog merge pokazuje metodę/SHA i blokady, close/update/enable auto-merge wymagają takich samych potwierdzeń jak web |
| Metadane | **Edit title and description** otwiera edytor z preview; reviewers (users/teams), request/re-request, assignees i labels mają arkusze wyszukiwania z Apply. Podpowiedzi/slug zespołu i ostrzeżenie o powiadomieniu działają bez desktopowego hover |
| CI | Check rozwija stronicowane jobs; **View logs** otwiera wirtualną listę tekstu z następnymi stronami i stanem truncated/unavailable. Ikonowe akcje run/joba oraz nagłówka logu: re-run failed/all/job i cancel; run/attempt/SHA, informacja o skutkach i potwierdzenie cancel pozostają w arkuszu. Długie przytrzymanie podaje etykietę; dotknięcie wyłączonej akcji podaje powód |

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
| XSS, tracking i SSRF | Istniejący tokenowy renderer Markdown: HTML jako tekst, obrazy jako linki, `safeHref` z `@canopy/domain/markdown`. Bez `body_html`, skryptów i proxy dowolnych linków; awatary przechodzą przez ograniczony cache gatewaya, bez credentiali i redirectów (§6). Endpointy API buduje gateway z walidowanych ID |
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
Konto jest rozwiązywane według dostępu do `itsoltech/canopy`, z tą samą zapamiętaną
preferencją co inne odczyty repo. Na gatewayu z wieloma ownerami globalny updater używa wyłącznie
konta administratora zarządzającego aktualizacjami i jego ustawienia; nie przeszukuje
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

Etap 1 ma publiczne wartości domyślne oficjalnej aplikacji Canopy by IT SOL.
Konfiguracja `CANOPY_GITHUB_APP_CLIENT_ID` i `CANOPY_GITHUB_APP_SLUG` opcjonalnie je nadpisuje.
Jawnie pusta lub nieprawidłowa wartość jednej z nich daje
`configured=false` i spokojny stan Settings → GitHub; jawny fallback PAT pozostaje dostępny.
Web/desktop wiąże próbę z sesją HttpOnly BFF lub tożsamością sparowanego klienta;
mobile z tożsamością sparowanego urządzenia. Klienci zapamiętują tylko identyfikatory
próby/żądania, a gateway przechowuje zaszyfrowany `device_code`. Wygasłe próby tracą kod,
historia prób jest usuwana 24 h po terminie ważności. Niepewna wymiana po utracie dzierżawy
kończy próbę i wymaga nowego kodu, zamiast ponawiać wymianę.

PAT wskazuje lokalny oficjalny konektor GitHub z metodą `headers` i jego rewizję;
zmiana lub odłączenie konektora wymaga ponownego jawnego wyboru. Tożsamość jest sprawdzana
przez `/user`, bez kopiowania poświadczenia. Jedno konto `(owner, host, GitHub user ID, dom)`
może zmienić wybraną metodę dostępu; ponowny wybór nie tworzy drugiego konta tej samej osoby.
Przypisanie repozytorium, sprawdzanie praw PAT per repo oraz wspólny klient/cache/budżet
z §3 są zakresem etapu 2. Katalog etapu 1 ma atomowy snapshot, stronicowanie,
odświeżanie single-flight, TTL 15 min i cooldown po niepowodzeniu.

Settings → GitHub pokazuje konta w jednej zwartej liście: avatar z inicjałami jako fallback,
login, metodę i stan dostępu oraz liczbę instalacji i repozytoriów. Liczniki obejmują cały
katalog właściciela danego konta, niezależnie od stronicowania. Akcje konta są w menu
(na mobile w arkuszu akcji); odłączenie wymaga potwierdzenia. Instalacje rozwijają się
wewnątrz konta ze wspólnym ruchem accordion. **Manage repositories** i **Install on another
account** są w menu wiersza. Repozytoria pokazują domyślnie 5 pozycji, **Show all N** rozwija
przewijaną listę, a powyżej 10 dostępne jest wyszukiwanie po całym katalogu instalacji.
Pełna nazwa jest dostępna mimo skrócenia środka; Private/Public pozostaje dyskretną etykietą.
Po połączeniu konta akcja **Connect another account** jest drugorzędna; stan pusty zachowuje
główne **Connect GitHub**. Web/desktop i mobile mają tę samą strukturę i akcje.

**Ustalono jeden stos obejmujący etapy 1–9.** Podstawą stosu jest dokumentacyjny
PR [#485](https://github.com/itsoltech/canopy/pull/485): gałąź `docs/github-integration` celująca w `dev`.
Etap 1 bazuje na `docs/github-integration`, każdy następny na poprzednim (`gh stack`, `github/gh-stack`).
Dokument i wszystkie etapy pozostają draft do zakończenia i weryfikacji
**całego v1**, potem wspólny `gh stack merge <stack> --squash`, bez merge etap po etapie.
PR #485 scala się razem z całym stosem, nie osobno przed implementacją.
Każdy etap ma działający kontrakt gatewaya i parytet web/desktop/mobile, własne testy oraz
przegląd bezpieczeństwa; brakującej funkcji nie zastępuje nieczynny przycisk.
Rozmiary to orientacyjne linie kodu z testami, bez generowanych kontraktów; zależności są logiczne,
a w pojedynczym stosie gałęzie pozostają liniowe. Mutacje PR w GitHub dochodzą po etapach odczytu.

| Etap | Kompletna granica zmiany | Rozmiar / zależność | Dowód przed gotowością |
| --- | --- | --- | --- |
| 1. Konto | Schemat kont/instalacji, device flow, refresh/disconnect, Settings i inline auth we wszystkich klientach | L, 1400–2000 linii; na `docs/github-integration` (PR #485) | Migracje, gRPC auth, dwóch ownerów, expiry, równoległy refresh, restart/anulowanie, tokeny poza DTO/logami i partnerami; HTTP fixture |
| 2. Ręczny PR | Klient GraphQL/REST, wybór konta repo, cache/budżet, link/unlink, panel, Summary read-only, dom i lustro | L, 1600–2400; po 1 | gRPC z prawdziwym store, tombstone race, owner/account/cache, offline/revoke i dwa gatewaye. **Pierwsza wartość PR dla użytkownika**, jeszcze w draft gałęzi |
| 3. Wykrywanie | Kontekst git, forki/remotes, branch reuse, auto-link, wyniki narzędzi i cleanup proof | L, 1200–1800; po 2 | Gateway↔WorkerHost z rzeczywistymi repo/worktrees, push/ref change, head repo, stos, detached HEAD, tombstone i restart/replay |
| 4. Pełny odczyt | Stronicowana Timeline/reviews/checki/jobs/logi, Code/commit filter/lazy patch, watch/polling, kontekst trzech akcji composera, retencja/metryki i release fallback po #486 | XL, 3500–5000; po 3 | gRPC paginacji > 100 elementów, 304/429/403/partial, cache/stream gap, binary/truncated/SHA races; SSRF/redakcja/limity logów, attachment/harness, brak tokenu na CDN/redirect; migracje/retencja, restart, p95 i mobile transport |
| 5. Komentarze i Viewed | Wspólny preflight, trwałe receipty/audyt/uncertain; post/reply/edit/delete własnych komentarzy i synchronizacja Viewed z GitHub | L, 1800–2600; po 4 | gRPC/security: obcy PR/comment, cofnięcie praw, dwa kliknięcia, awaria po HTTP i brak replay; GitHub VIEWED/UNVIEWED/DISMISSED, rollback, offline i dwa urządzenia/konta; migracja receiptów |
| 6. Pełne review | Inline i zakresy unified/split, pending review/submit Comment/Approve/Request changes, resolve/unresolve i własne edycje/usunięcia | XL, 2500–3500; po 5 | gRPC/security kotwic LEFT/RIGHT/range/SHA i obcych review/thread ID, pending z innego urządzenia, paginacja, push przed submit, autor PR, restart/uncertain oraz deny worker/bot |
| 7. Lifecycle | Create z gałęzi i szkicem agenta, auto-link, ready/draft, merge/squash/rebase, auto-merge on/off, update branch, close/reopen | XL, 3500–5000; po 5–6 | gRPC create/link crash i duplikat/tombstone; confirmation binding/expiry, push/zmiana konta po preflight, protection/queue/metody, fork head permissions, accepted/uncertain/restart; model nie wywołuje mutacji |
| 8. Metadane | Tytuł/opis, request/re-request user/team, assignees i istniejące labels, jawne Apply we wszystkich klientach | L, 1200–1800; po 5–7 | gRPC owner/repo/user/team ID, pickery Members i fallback bez tego scope, powiadomienia, obca etykieta, konflikt edycji, revoke, receipty i niepewny wynik |
| 9. Sterowanie CI | Re-run failed/all/job i cancel run na bazie logów z etapu 4; końcowe domknięcie zapisów, dokumentacji i parytetu | L, 1800–2800; po 4–8 | gRPC/security obcego run/job/attempt/SHA, confirmation cancel, job dependencies, accepted ≠ done, brak dispatch/debug/force-cancel, restart/uncertain; pełne migracje/security/linked, p95 i macierz wszystkich akcji mobile |

Każdy etap utrzymuje zgodność i pionową funkcję w swojej gałęzi. Infrastruktura etapu 1
nie udaje wartości PR przed etapem 2; wartość na gałęzi nie jest zgodą na wcześniejszy merge.
Nie dodajemy web UI/component/Playwright testów ani trywialnych testów helperów.
Scenariusze integracyjne używają lokalnego fixture HTTP i bazy testowej.
Testy z rzeczywistym GitHub są wyłącznie opt-in (`CANOPY_LIVE=1`).

Przed gotowością całego stosu pełna lista sprawdzeń z AGENTS.md musi przejść:
install, gen:check, typecheck, lint, format:check, check:tmp (pełne testy, w tym integracyjne)
i web build.
QA UI obejmuje light/dark, desktop/phone/tablet, klawiaturę/czytnik, reduced motion,
krótkie i długie treści, sticky/scroll oraz iOS/Android z tym samym zestawem funkcji.

Włączanie po merge: capability i flagi domeny domyślnie wyłączone, pilotaż na wybranych kontach,
obserwacja p95/limitów i dopiero udostępnienie wszystkim. Gateway może wstrzymać polling
i mutacje bez usuwania powiązań. Rollback wyłącza funkcję i nowe RPC; migracje zostają addytywne,
starszy klient/gateway nadal obsługuje wątki, a cofnięta funkcja nie ponawia niepewnych zapisów.

## 12. Decyzje po przeglądzie

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

**Jeden stos 1–9 — zaakceptowane.** Dokumentacyjny PR #485 jest podstawą stosu;
etap 1 bazuje na `docs/github-integration`. Dokument i wszystkie etapy scala się razem
dopiero po weryfikacji pełnego v1, zgodnie z §11 i AGENTS.md.
