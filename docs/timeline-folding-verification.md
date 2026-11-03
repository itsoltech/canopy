# Timeline folding — wynik implementacji i weryfikacji

Status: completed. Gałąź: `feat/timeline-folding`. Weryfikacja: 2026-11-02. Zmiany lokalne, bez push i PR.

## Zachowanie i decyzje

1. Wszystkie widoki pracy startują zamknięte, również błędy, komendy w toku, MCP, agent-bus, checklisty, obrazy, podagenci i zadania w tle. Nagłówki zachowują status, kod wyjścia i dostępne liczby +/−. Szczegóły oraz zagnieżdżona praca montują się po rozwinięciu; pamięć itemów przeżywa odmontowanie przez wirtualizację.
2. „Working for …” istnieje od startu bez itemów. Czas tyka co sekundę, hint wybiera najnowszą aktywną pracę (równoczesne odczyty agreguje), pozostaje shimmer. Rozwinięcie pokazuje zamknięte grupy kolejnych narzędzi przeplatane wiadomościami postępu. Grupy mają stabilny klucz pierwszego itemu.
3. Najnowsza wiadomość strumieniuje w stałym `answer:<turnId>` poza foldem. Po wznowieniu narzędzi dotychczasowe miejsce wiadomości zwija się wysokością na tokenie `fast`; przy reduced motion natychmiast. Przy końcu tury fold i odpowiedź zachowują swoje klucze. Decyzja użytkownika o rozwinięciu foldu lub grupy pozostaje zachowana.
4. Po zakończeniu długa odpowiedź trafia 8 px poniżej góry feedu tylko dla czytelnika śledzącego dół. Krótkie odpowiedzi i czytelnik przewinięty wyżej pozostają na miejscu. „Jump to latest” ponownie przypina dół. Gest czytelnika może przerwać przewijanie programowe. Padding kompozytora pozostaje w dotychczasowym mechanizmie.
5. Cytat otwiera także właściwą grupę przed pokazaniem źródła. Model, grupy i odpowiedź działają również w historii forka. Puste/encrypted-only itemy nie generują pustej pracy.

Opis komponentów i procedura ponowienia: [timeline-folding.md](timeline-folding.md).

## Skille i przegląd

Zastosowano `design`, `transitions-dev` oraz `componentize`. Pass `componentize` wykonany przed końcowym commitem: osobne `AnswerSlot` i `WorkGroup`, wspólny `DiffCounts`, współdzielony parser edycji dla nagłówków i body. Istniejące `ItemFrame`, `Disclosure`, `UiMemory`, ikony i tokeny ruchu pozostały podstawą UI. Pozycjonowanie foldu/grupy jest w wrapperach; brak nadpisywania pozycjonowania komponentów kitu przez konfliktujące klasy.

Self-review objął stabilność kluczy, pamięć otwarcia, puste itemy, statusy po końcu tury, zadania w tle, źródła cytatów, przerywanie automatycznego scrolla i granicę zmian w `VirtualFeed`. Zmiany tego komponentu obejmują `scrollRowToTop` i rozróżnienie ruchu programowego od gestu czytelnika. Nie zmieniono jego paddingów ani rezerwacji miejsca kompozytora.

`main` scalono czterokrotnie: `3876ac1` (harmonogramy), `1512313` (mobilne sugestie kompozytora), `621ff8c` (custom form controls), `834fb5a` (drobna poprawka przewijania popoverów). Drugi merge wymagał zachowania obu nowych wpisów `.gitignore`. Końcowy sprawdzony `main`: `1f00d56`.

## Kontrole

| Polecenie | Wynik |
| --- | --- |
| `bun install` | OK, lockfile bez zmian |
| `bun run typecheck` | OK we wszystkich workspace'ach; Svelte: 0 błędów, 0 ostrzeżeń |
| `bun run --filter @canopy/web build` | OK; pozostaje ostrzeżenie bundlera o dużych chunkach |
| `bun run check:tmp` | 834 pass, 153 skip, 0 fail; 3305 asercji; brak pozostawionych plików tymczasowych |
| `bun run check:tmp apps/web` po ostatnim merge | 291 pass, 0 fail; 1058 asercji; brak pozostawionych plików tymczasowych |
| `OA_TIMELINE_BROWSER=1 bun test tests/integration/timeline-folding.browser.test.ts` | 6 pass, 0 fail; 132 asercje; brak wyjątków przeglądarki |

Pełny `check:tmp` wykonano po scaleniu kontrolek formularzy (`main` `1edcd5e`). Po ostatniej zmianie pięciu linii w `Popover` i `ModelPicker` (`main` `1f00d56`) powtórzono install, pełny typecheck, build, `bun run check:tmp apps/web` oraz całą macierz Chromium. Po końcowej zmianie diagnostyki testu dodatkowo przeszedł typecheck workspace'u integracyjnego i `git diff --check`.

Pierwszy pełny zestaw wykrył nieaktualne oczekiwanie osobnego „Working…” w teście steerów; poprawiono je na live fold i answer slot. Scenariusz browser poprawiono tak, aby wracał rzeczywistym przewinięciem do odmontowanego nagłówka. Przebieg browser równoległy do pełnego zestawu zgłosił błędy pobrania modułów JS i timeouty. Końcowy przebieg wykonano osobno: wszystkie scenariusze przeszły, bez tych błędów. Zestawy należy uruchamiać kolejno przy odtwarzaniu dowodów.

## Pomiary Chromium

Własny PostgreSQL/gateway/scripted worker, web na porcie 5398, Chromium `/usr/bin/chromium`. Po testach proces web oraz gateway zostały zamknięte. Nie używano `/tmp/oa-stack` ani portów 17443, 5180, 8444.

| Wariant | Początek odpowiedzi od góry feedu | Dryf przy wcześniejszym przewinięciu | Największy krok płynnego przewijania na klatkę |
| --- | ---: | ---: | ---: |
| 1440×1000 light | 8 px | 0 px | 193 px |
| 1440×1000 dark | 8 px | 0 px | 193 px |
| 390×844 light | 8 px | 0 px | 295 px |
| 390×844 dark | 8 px | 0 px | 295 px |

Zmiana pozycji odpowiedzi w dokumencie przy zakończeniu jest sprawdzana z tolerancją <2 px; ruch w tabeli to celowe płynne przewijanie do jej początku. Dodatkowo sprawdzono stopniowe zmniejszanie wysokości wiadomości przenoszonej do foldu, krótką odpowiedź bez scrolla, natychmiastowe ustawienie długiej odpowiedzi przy reduced motion i brak poziomego overflow. Liczba zamontowanych wirtualnych wierszy długiej tury pozostaje poniżej 80. Zakres browser: Chromium i scripted worker.

## Zrzuty

Ścieżki względem repozytorium; obrazy pozostają lokalnymi artefaktami ignorowanymi przez git.

| Wariant | Live collapsed | Live expanded | Ended |
| --- | --- | --- | --- |
| 1440 light | `artifacts/timeline-folding/1440-light-live-collapsed.png` | `artifacts/timeline-folding/1440-light-live-expanded.png` | `artifacts/timeline-folding/1440-light-ended.png` |
| 1440 dark | `artifacts/timeline-folding/1440-dark-live-collapsed.png` | `artifacts/timeline-folding/1440-dark-live-expanded.png` | `artifacts/timeline-folding/1440-dark-ended.png` |
| 390 light | `artifacts/timeline-folding/390-light-live-collapsed.png` | `artifacts/timeline-folding/390-light-live-expanded.png` | `artifacts/timeline-folding/390-light-ended.png` |
| 390 dark | `artifacts/timeline-folding/390-dark-live-collapsed.png` | `artifacts/timeline-folding/390-dark-live-expanded.png` | `artifacts/timeline-folding/390-dark-ended.png` |

## Commity implementacji

- `39a3ee8` — domyślnie zamknięte itemy i wspólne liczniki diffów.
- `654c551` — live fold, grupowanie, stała odpowiedź i API scrolla.
- `54ed157` — nawigacja do źródeł, kontrola scrolla, testy i dokumentacja zachowania.
- `4788007` — nawigacja testu rzeczywistym gestem czytelnika i diagnostyka nieudanych żądań.

Osobny końcowy commit zapisuje ten raport. Drzewo robocze powinno być czyste po jego zapisaniu; brak wymaganych prac pozostałych w zakresie zadania.
