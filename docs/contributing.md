# Współpraca przy Canopy

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

Jeżeli `fix`, `perf` lub revert naprawia zmianę już scaloną wcześniej, dodaj w body PR lub
commita osobną linię ze wskazaniem **oryginalnego PR** albo SHA squash commita. Zachowaj ją
w body końcowego squasha. Preferowane formy:

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

`bun install` instaluje `commit-msg` przez simple-git-hooks. Hook akceptuje
`feat(web): add a channel` i odrzuca `Web: add a channel`. Workflow **PR title** sprawdza
tytuł po jego edycji i każdym pushu do PR skierowanego do dev/next/main. Commity merge bota
mają typ `chore(release)`; nie dopisujemy commitów z numerem wersji.
Narzędzia commitlint/semantic-release uruchamiają się na Node; używaj **Node 24.10+**
obok Bun 1.4.4 (CI instaluje Node 24 jawnie).

```sh
bun install
printf '%s\n' 'feat(web): add a channel' | bun run commitlint
bun run typecheck
bun test packages/updater scripts/release.test.ts scripts/promote.test.ts
```

Publikację, okres stabilizacji beta i bootstrap **0.1.0** opisuje [release.md](release.md).
