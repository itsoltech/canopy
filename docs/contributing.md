# Współpraca przy Canopy

Status (2026-11-19): obowiązujący proces pracy i weryfikacji, w tym izolacja zasobów
testowych, sprzątanie kontenerów PostgreSQL po przerwaniu testów, synchronizacja testów
asynchronicznych i diagnoza niestabilnych testów z historii prób CI.

## Gałęzie i scalanie

1. Funkcje i zwykłe poprawki kieruj do **dev**. PR scalaj przez **squash merge**.
   Tytuł PR staje się jednym commitem Angular, więc kilkadziesiąt commitów roboczych nie
   tworzy kilkudziesięciu wpisów w notatkach wydania.
2. Pilny hotfix kieruj do **main**. Po stable workflow przenosi go do next i dev commitami merge;
   przy konflikcie maintainer dostaje PR. Nie pomijaj tego kroku przed kolejną promocją.
3. Nie kieruj feature PR do next/main. **Automatic promotion** przesuwa dev → next → main pushami
   fast-forward. To wyjątek od scalania feature PR przez squash, opisany w [release.md](release.md).

## Commit i tytuł PR — Angular

Format: `typ(opcjonalny-scope): krótki opis`. Używaj małych liter w typie/scope,
opisu bez końcowej kropki i nagłówka do 72 znaków. Scope wskazuje obszar, np.
`updater`, `web`, `gateway`, `worker`, `release`.

| Typ | Zastosowanie | Wpływ na wersję |
| --- | --- | --- |
| `feat` | nowa funkcja | minor |
| `fix`, `perf` | poprawka błędu, wydajności | patch |
| `revert` | cofnięcie zmiany | rozpoznany revert może dać patch |
| `docs`, `style`, `refactor`, `test` | dokumentacja, format, porządki, testy | bez wydania, chyba że breaking |
| `build`, `ci`, `chore` | zależności/build, automatyzacja, utrzymanie | bez wydania, chyba że breaking |

Przykłady:

```text
feat(web): add nightly update channel
fix(updater): retain the current beta manifest
ci: publish releases from dev and next
docs: describe beta burn-in
chore(deps): update build tooling
```

Zmianę niezgodną opisuj stopką **BREAKING CHANGE** po pustej linii:

```text
feat(gateway): require the new worker handshake

BREAKING CHANGE: workers must support the new handshake before reconnecting.
```

Nie używaj skrótu `feat!:` — konfiguracja używa parsera Angular i wymaga powyższej stopki.
Stopkę zachowaj w body końcowego squash commita w dialogu merge PR. Sam tytuł nie przenosi
opisu niezgodności. W **0.x breaking zwiększa minor**; od 1.0.0 zwiększa major.
Notatki wydania trafiają do GitHub Releases, nie do commitowanego CHANGELOG-a.

### Jawne powiązanie poprawki z wcześniejszą zmianą

Jeżeli `fix`, `perf` lub revert naprawia zachowanie wprowadzone przez zmianę już scaloną
wcześniej, dodaj w body PR lub commita osobną linię ze wskazaniem **oryginalnego PR** albo SHA
squash commita. Zachowaj ją w body końcowego squasha.

Automatyczna promocja wstrzymuje wskazaną zmianę **i wszystko, co weszło po niej**, aż poprawka
odstoi 24 h. Dlatego:

- wskazuj tylko PR, który wprowadził naprawiany błąd, a nie PR, który jedynie dotykał tego
  samego kodu albo daje kontekst;
- nie dodawaj powiązań w commitach `test`, `ci`, `docs`, `refactor` i `chore` ani przy
  poprawkach zachowania, którego żadna niedawna zmiana nie wprowadziła;
- wzmiankę tylko dla kontekstu zapisz jako `Related: #68` — parser jej nie rozpoznaje, więc
  niczego nie wstrzymuje.

Preferowane formy:

```text
fix(worker): handle reconnect after suspend

Fixes: #68
```

```text
perf(worker): avoid repeated reconnect work

Refs: abc1234567890
```

Revert zachowuje standardową linię `This reverts commit abc1234567890.`. Parser akceptuje
SHA o długości 7–40 znaków hex (pełne SHA jest preferowane), `Refs: #68`, `Refs #68`,
`follow-up to #68` oraz słowa zamykające GitHuba: `fix`, `fixes`, `fixed`, `close`, `closes`,
`closed`, `resolve`, `resolves`, `resolved` z opcjonalnym dwukropkiem, np. `Fixes #68`.
Szablon PR zawiera opcjonalną linię `Fixes an earlier change: #68`, również rozpoznawaną.
Każde odwołanie zajmuje osobną linię; zwykła wzmianka w zdaniu nie jest powiązaniem.
Używaj numeru PR z tego repozytorium, nie numeru zgłoszenia błędu.

Promocja wstrzymuje oryginalną zmianę i cały późniejszy fragment historii, dopóki jej
poprawka nie przejdzie okresu stabilizacji. Jawne linki działają niezależnie od plików
i wieku oryginału. Awaryjna heurystyka używa `git blame` dla zmienionych/usuniętych linii
sprzed poprawki, tylko do 7 dni po oryginale. Ignoruje zmiany samego whitespace i śledzi
przeniesione linie. Dla samych dopisków sprawdza linie bezpośrednio nad/pod miejscem
wstawienia: przypisuje zmianę tylko przy zgodnym pochodzeniu; niejednoznaczny kontekst
nie tworzy powiązania. Pomija pliki współdzielone/generowane i commity już wydane. Pełna lista
wyjątków i okresy kanałów: [release.md](release.md#promocja-i-okres-stabilizacji-burn-in).
Nie polegaj wyłącznie na heurystyce linii. Commitlint dopuszcza powyższe stopki.

## Lokalna kontrola

Pełna bramka weryfikacji działa w GitHub CI: instalacja z zamrożonym lockfile,
`gen:check`, typy całego repo, lint, formatowanie, testy przez `check:tmp` i buildy
wybrane przez workflow. Wymagane checki muszą przejść dla rewizji scalanej do gałęzi
docelowej. Agent sprawdza błędy CI i poprawia te wynikające ze swojej zmiany.

Lokalnie dobieraj najmniejszą kontrolę, która pomaga zweryfikować konkretne zachowanie:
wybrane pliki testowe, typy zmienionego pakietu lub lint edytowanych plików. Nie ma
obowiązkowej listy lokalnych kontroli przed oddaniem pracy lub otwarciem PR.
Pełne `bun run check`, testy, `check:tmp`, wszystkie shardy, kontrole całego repo
i buildy zostaw CI. Szerszy przebieg lokalny uzasadnia konkretny błąd, którego nie da się
wyjaśnić węższą kontrolą, albo jawna prośba użytkownika; sam rozmiar zmiany nie wystarcza.

`check:tmp` uruchamia testy i kontroluje sprzątanie zasobów. Przy potrzebie lokalnej
weryfikacji wybranych testów uruchom z root repo np.:

```sh
bun run check:tmp ./scripts/release.test.ts
```

Nie uruchamiaj tych samych testów dodatkowo przez `bun test` bez powodu diagnostycznego.
Nie powtarzaj zaliczonych kontroli, dopóki ich dane wejściowe się nie zmieniły.
Formatowanie ogranicz do edytowanych plików obsługiwanych przez oxfmt:
`bun run format -- <pliki>`. Przy zmianach źródeł generowanego kodu wygeneruj i dodaj
wyniki do zmiany; pełną kontrolę ich aktualności wykona CI.

Dla samych zmian dokumentacji wystarcza przegląd diffu, treści i odnośników,
bez instalacji zależności, kontroli kodu, testów i buildów. Markdown jest ignorowany
przez oxfmt. W opisie PR i przy oddaniu pracy podaj faktycznie wykonane kontrole
oraz zakres pozostawiony CI; oczekujący CI nie jest zaliczonym sprawdzeniem.
Zasady dla agentów i testów UI opisuje [AGENTS.md](../AGENTS.md#testing-policy).

### Stabilność testów asynchronicznych

Test czeka na obserwowalny warunek: snapshot subskrypcji, `ConfigApplied`, koniec
tury, gotowość procesu potomnego albo stan sesji PostgreSQL. Stałe `sleep` przed
asercją nie potwierdza, że praca się zakończyła. Polling ma termin, a przekroczenie
terminu zgłasza brakujący warunek. Testy cache z granicą wieku danych i scalaniem
zdarzeń używają osobnego, sterowanego zegara dla każdej instancji; nie zmieniają
globalnego czasu ani timerów innych testów.

Zwykłe testy harnessów korzystają z lokalnych fixture, także dla cennika modeli.
Nie zależą od publicznych endpointów. Test przerywający proces najpierw czeka na
potwierdzenie, że testowany proces i jego potomkowie osiągnęli właściwy stan.
Teardown czeka na zakończenie własnych handlerów i procesów. Kolejka połączeń
testowego gatewaya przekazuje każde połączenie dokładnie jednemu odbiorcy.
Testy z celowo zatrzymanym HTTP lub SQL zwalniają bariery i czekają na wszystkie
rozpoczęte operacje również po nieudanej asercji. Oczekiwanie na gotowość ściga
się z wynikiem operacji, żeby jej błąd nie pozostawił nierozwiązywalnej bariery.
Odczyt blokad SQL identyfikuje własną bazę i PID blokującej sesji. Osobne warianty
scenariusza mają osobne przypadki testowe, a budżet wieloetapowej integracji
obejmuje jej setup i oczekiwania na zdarzenia.

`check:tmp` tworzy prywatny katalog przed uruchomieniem PostgreSQL i usuwa własny
kontener oraz katalog także przy błędzie zapisu deskryptora lub startu testów.
Zarówno przy wspólnym serwerze, jak i przy samodzielnym uruchomieniu fixture
kontener tworzy osobny proces. Zamknięcie prywatnego kanału IPC po zakończeniu
lub zabiciu procesu testowego powoduje usunięcie kontenera i jego wolumenu
według pełnego ID. Wiek i nazwa kontenera nie służą do ustalania własności.
Awaria hosta, demona Docker lub samego procesu sprzątającego może wymagać
ręcznego sprzątania.

Przegląd awarii CI na PR-ach obejmuje także zielone przebiegi po ponowieniu.
Ostatnie nieudane lub ponawiane przebiegi można znaleźć poleceniem:

```sh
gh run list --workflow ci.yml --event pull_request --limit 100 \
  --json databaseId,attempt,conclusion,headBranch \
  --jq '.[] | select(.conclusion == "failure" or .attempt > 1)'
```

Log konkretnej próby pokazuje `gh run view RUN_ID --attempt NUMER --log-failed`.
Przy liczeniu awarii uwzględnij pierwszy błąd w pliku, także wyjątek między testami.
Bun powtarza nazwy nieudanych testów w podsumowaniu. Ponowienie na tym samym SHA
pozwala sprawdzić, czy objaw ustąpił bez zmiany kodu. Przed poprawką porównaj
miejsce błędu z aktualnym `dev`.

Przy diagnozie konkretnego flaky można powtórzyć tylko dotknięte pliki, np.:

```sh
bun run check:tmp ./packages/domain/src/shared-query.test.ts --rerun-each=20
```

Zmianę kolejności (`--randomize --seed=123`) stosuj do testów niezależnych od
kolejności; seed zachowaj w opisie reprodukcji. Powtórzenia służą diagnozie, a CI
nadal wymaga zaliczenia testów bez automatycznych retry maskujących porażkę.

`bun install` wykonuj tylko przy brakujących zależnościach albo zmianie manifestów
lub lockfile. Instaluje też `commit-msg` przez simple-git-hooks. Hook akceptuje
`feat(web): add a channel` i odrzuca `Web: add a channel`. Workflow **PR title** sprawdza
tytuł po jego edycji i każdym pushu do PR skierowanego do dev/next/main. Commity merge bota
mają typ `chore(release)`; nie dopisujemy commitów z numerem wersji.
Narzędzia commitlint/semantic-release uruchamiają się na Node; używaj **Node 24.10+**
obok Bun 1.4.4 (CI instaluje Node 24 jawnie).

Publikację, okres stabilizacji beta i bootstrap **0.1.0** opisuje [release.md](release.md).
