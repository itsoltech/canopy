# Sekrety wątków

## Badanie T3 Code (2026-11-02)

Źródło: publiczne repozytorium [pingdotgg/t3code](https://github.com/pingdotgg/t3code),
commit `ac8dce0cc3abd8a337f2d806b5082a6834b9b81a`. Kod odczytany z tymczasowego
klonu, bez uruchamiania aplikacji i bez modyfikowania źródeł.

- `packages/contracts/src/orchestratorMcp.ts`: `request_secret` przyjmuje `label`,
  `reason`, opcjonalne `placeholder`, `delivery` (`secretRef` domyślnie lub `file`),
  `timeoutMs` (domyślnie 10 minut, maksymalnie godzina), `clientRequestId`.
  Zwraca status i jednorazowe `secretRef` albo ścieżkę `file`; nigdy wartość.
- `apps/web/src/components/chat/SecretRequestCard.tsx`: karta w osi czasu, tytuł,
  opis, maskowane pole, przyciski „Save securely” i „Decline”. Pole to stylowany
  input tekstowy z `-webkit-text-security: disc`, `autocomplete=off` i flagami
  ignorowania przez menedżery haseł. Stan komponentu jest czyszczony po zapisie.
  Błędy transportu są zastępowane ogólnym komunikatem, bez logowania requestu.
- `packages/client-runtime/src/secretRequest.ts`: dla pliku komunikat
  „Kept out of chat, in a private file this agent's commands can read for 24 hours”.
  Odmowa zapisuje wyłącznie status `declined`. Fork pokazuje oczekiwanie w wątku
  źródłowym; nie pozwala odpowiedzieć na odziedziczoną kartę.
- `apps/server/src/secrets/SecretRequests.ts`: status karty jest oddzielony od
  wartości. Referencja powstaje z HMAC identyfikatora wątku i karty. Osobny magazyn
  zapisuje wartość, projekt i czas zapisu; konsumpcja `secretRef` jest jednorazowa
  i sprawdza projekt. Dostarczenie pliku przenosi wartość do prywatnego katalogu
  `files`, używa pliku tymczasowego `wx`, `0600`, katalogu `0700` i rename.
  Powtórzenie z tym samym kluczem zwraca ten sam plik.
- `apps/server/src/auth/ServerSecretStore.ts`: ten magazyn używa plików `.bin`
  chronionych prawami systemowymi (`0700`/`0600`); w badanej implementacji nie
  znaleziono szyfrowania zawartości tego magazynu. Nie należy opisywać go jako
  szyfrowanego tylko na podstawie tekstu „Stored securely”.
- TTL referencji wynosi 24 godziny od zapisu. Pliki są sprzątane według mtime;
  sweep na starcie i co godzinę oznacza, że fizyczne usunięcie może być późniejsze
  niż 24 godziny. Zakończenie przebiegu, błąd lub timeout zamyka oczekującą kartę.
  Nie znaleziono mechanizmu maskowania outputu powiązanego z konkretną wartością
  sekretu ani akcji cofnięcia dostępu na tej karcie. Wynik narzędzia i projekcja
  przechowują wyłącznie referencję/status; komenda, która wypisze plik, pozostaje
  istotnym ryzykiem.

## Projekt Canopy

`request_secret` jest narzędziem platformy dla obu harnessów. Przyjmuje `label`,
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

Gateway szyfruje wartość AES-256-GCM istniejącym `OA_SECRETS_KEY`. Do workera
przechodzi osobnym komunikatem istniejącego połączenia gRPC, poza trwałym outboxem
komend i dziennikiem zdarzeń. Worker zapisuje plik `0600` w katalogu `0700` poza
workspace. Model otrzymuje tylko ścieżkę, termin i instrukcję użycia wewnątrz
komendy, np. `TOKEN="$(cat '<path>')" program`, bez drukowania wartości.
Nie dodajemy sekretu do env procesu harnessu (wspólnego dla wielu wątków).

Domyślny TTL to 24 godziny. Cofnięcie/wygaśnięcie usuwa szyfrogram z gateway
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

Migracja: `0036_thread_secrets`; scalony main ma `0033_bot_mentions` i
`0034_bot_archive`, a `0035` pozostawiono dla równoległych prac. Lista oczekiwanych
migracji w `packages/db/test/schema.test.ts` uwzględnia `36_thread_secrets`.
Nowe pola istniejących wiadomości proto
korzystają z zakresu `500–519`.

## Kontrakt i trwałość

`request_secret` jest dostępne jako dynamiczne narzędzie Codex oraz
`mcp__openagents__request_secret` serwera MCP Claude. Wywołanie czeka do 120 sekund.
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

Gateway co sekundę usuwa wygasłe szyfrogramy, także przy archiwizacji lub usunięciu
wątku. Lokalny timer workera egzekwuje expiry również po utracie połączenia.
Jeżeli sam proces workera nie działa, sprzątanie plików następuje przy jego
ponownym uruchomieniu; nie ma osobnego demona usuwającego je w czasie awarii.
Revoke zeruje szyfrogram od razu i wysyła usunięcie; odłączony worker wykona je po
ponownym połączeniu albo wcześniej po TTL. Rewizje i potwierdzenia chronią przed
ponownym zastosowaniem starego przydziału po revoke. Restart gateway odczytuje stan
z bazy; restart workera usuwa pozostałe materializacje przed synchronizacją.
Zaszyfrowane kopie w backupach/WAL podlegają polityce retencji bazy; zwykłe DELETE
lub UPDATE nie jest kryptograficznym wymazaniem historycznych backupów.

TTL 24 h jest obecnie stałą domyślną serwisu; krótszy można wstrzyknąć w fixture.
Nie dodano jeszcze publicznego ustawienia TTL. Klucz pozostaje w `OA_SECRETS_KEY`
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

Redaktor działa w workerze **przed** `Journal.append`: maskuje dokładną wartość
i jej wariant z escapingiem JSON na `[REDACTED]` w zdarzeniach i usuwa `rawJson`.
Gdy sekret jest aktywny, delty tekstu są wstrzymywane do zakończenia itemu,
aby wartość rozbita na kilka chunków nie wyciekła do UI. Finalny item odtwarza
brakujący output z bufora i maskuje go; bufor przechowuje wzorce do końca itemu,
również po cofnięciu sekretu. Dla dużych pól ogranicza bufor do około 4 MiB.
Oznacza to opóźnienie streamingu do ukończenia itemu podczas używania sekretów.

To dodatkowa osłona UI i trwałego dziennika Canopy, a nie gwarancja przed
celowym ujawnieniem: zakodowane, przekształcone lub częściowe wartości mogą ominąć
maskowanie. Output shellu może wcześniej trafić do kontekstu i surowego transkryptu
samego harnessu. Canopy nie przechwytuje wewnętrznej komunikacji harness–model.
Dlatego narzędzie wyraźnie instruuje, aby używać pliku wewnątrz poleceń i nigdy
nie wypisywać zawartości ani używać narzędzia Read do jego odczytu. Redakcja nie
zastępuje tej zasady. Zwykły przepływ wartości nie przekazuje do providera.

Karta wyłącza autocomplete, spellcheck i sugeruje menedżerom haseł ignorowanie
kontrolki. Przeglądarka i rozszerzenia nadal należą do granicy zaufania. Schowek
jest odczytywany wyłącznie po kliknięciu Paste; aplikacja go nie zapisuje i nie
czyści globalnego schowka. Pole czyści się przed fetch oraz po unmount.

## Weryfikacja

- `thread-secrets.test.ts`: rzeczywisty gateway i PostgreSQL, skryptowany worker
  z produkcyjnym magazynem plików; zapis, szyfrowanie, `0600`/`0700`, wynik bez
  wartości, maskowanie wartości podzielonej na chunki, revoke, odmowa, kontrola
  wątku, expiry offline oraz nowe instancje gateway i workera. SQL przeszukuje
  turns, steers, items, events, agent_bus_calls, worker_commands, interactions
  i audit_log w poszukiwaniu plaintextu.
- `thread-secrets.live.test.ts`: Codex i Claude przez `useLiveProxy`/CLIProxyAPI,
  każdy w `ASK` oraz `FULL_AUTO`; API odpowiada na prośbę, agent porównuje SHA-256
  pliku. Wartość nie występuje w zapisach bazy, wynikach, logach workera ani jego
  transkryptach `.jsonl`. Host i klucz proxy pozostają poza repozytorium i logami.
- Kontrola UI: Chromium 155 (`/usr/bin/chromium`, Playwright poza repo), produkcyjny
  build na jednorazowym stosie, port 5396 i losowy port gRPC. Jasny/ciemny motyw,
  szerokości 1440 i 390 px; paste, reveal/hide, save, reload, decline, revoke,
  ogólny błąd z pustym polem, brak overflow i wartości w browser storage.
  Brak błędów JavaScript. Nie dodano trwałych testów web UI.
- Przegląd `design`, `componentize`, `transitions-dev`: karta i panel mają osobne
  odpowiedzialności i `class`, wspólne Input/Button/IconButton, odstępy na miejscu
  użycia. Istniejące `GrowIn`/`rise`/`swap` czytają wspólne motion tokens i respektują
  reduced motion; kontrolki kit są opakowane zamiast nadpisywania ich pozycjonowania.

Zrzuty z kontroli przechowywane są poza repozytorium:
`/home/nix/.t3/userdata/browser-artifacts/thread-secrets/` (`pending-1440-light.png`,
`pending-1440-dark.png`, `pending-390-light.png`, `pending-390-dark.png`,
`saved-390-dark.png`, `revoked-390-dark.png`, `declined-390-dark.png`,
`save-error-390-dark.png`).

Końcowe wyniki (2026-11-02, main `52be59c`): `bun install`, pełny
`bun run typecheck`, `bun run gen:check` oraz build web zakończone powodzeniem.
`bun run check:tmp`: 574 pass, 127 skip, 0 fail (701 testów, 110 plików),
bez pozostawionych katalogów testowych. Opt-in live uruchomione osobno:
4 pass, 0 fail, 58 asercji. Zestaw sekretów i schematu bazy: 44 pass, 0 fail.
Po scaleniu main poprawiono fixture obcego właściciela workera oraz unikalne
nazwy botów w testach platformy; nie osłabiono walidacji produkcyjnej.
