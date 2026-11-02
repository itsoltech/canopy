# Weryfikacja notatek o zadaniach w tle po restarcie

Data: 2026-11-02. Claude Agent SDK 0.3.316, Claude przez CLIProxyAPI (`claude-haiku-5-5`).

## Przyczyny i dowody

Wątek `01a19be4-fc0c-7241-b255-23ef07311787` istniejącego stosu sprawdzono wyłącznie przez odczyt PostgreSQL i logów. Stosu nie zatrzymywano ani nie zmieniano jego danych.

1. **Błędny powód końca.** Zdarzenie 192 to `task_notification`, `status = stopped`, z chwili zatrzymania workera. Mapper Claude kończył nim zadanie jako `interrupted`, `stopped` i usuwał je z rejestru otwartych zadań. Późniejsze `endTasks` i przegląd osieroconych zadań nie mogły już nadać mu `worker_shutdown`; ingest zachowywał pierwszy koniec. Kolejność raportu harnessu i sprzątania tłumaczy zależność od przebiegu, również przy wyjściu procesu Codexa. Test workera wymusza raport końcowy podczas `close`, przed przeglądem otwartych zadań, dla `SHELL` i `PROCESS`.
2. **Rozdzielona odpowiedź.** Tura 2 (`background_task`) trwała od 10:56:49.404 do 10:56:49.917 UTC. Zdarzenia 195–197 to powiadomienie o zadaniu poprzedniej sesji, `init`, a następnie udany `result` z `origin.kind = task-notification`, `num_turns = 0`, zerowym zużyciem wejścia i wyjścia oraz pustym `result`. Ten wynik zakończył turę notatki. Następne `init` uruchomiło turę 3 (`provider`, 10:56:49.939), a rzeczywisty wynik odpowiedzi miał `num_turns = 1` (zdarzenie 236). Nie była to decyzja gateway po upływie 15 s: podział nastąpił w około 0,5 s.

Stary test live jedynie wypisywał odpowiedź tury notatki, bez asercji jej treści. Sprawdzał dopiero odpowiedź na późniejsze pytanie użytkownika. Mógł więc przejść pomimo pustej tury notatki. W tej sesji zaostrzony test live **przed poprawką** odtworzył pustą odpowiedź, choć powód zatrzymania akurat był poprawny. Nie ma nagrania wcześniejszego zgłoszonego przebiegu „1 z 4”; nie da się przypisać mu dokładnego miejsca awarii. Obie potwierdzone ścieżki mają teraz niezależne testy regresyjne.

## Poprawki

- `WorkerHost.shutdown` wywołuje `Journal.beginShutdown` przed zamykaniem dostawców. Dziennik normalizuje każdy końcowy raport zadania w tej fazie do `interrupted`, `worker_shutdown`, uzupełniając `ended_at`, zanim zdarzenie zostanie zapisane i opublikowane. Obejmuje to oba harnessy. Pierwszy koniec w gateway nadal wygrywa; nie trzeba poprawiać już wysłanej notatki drugim zdarzeniem.
- Adapter i mapper Claude rozpoznają udane, zerowe potwierdzenie powiadomienia po jego pochodzeniu. Zachowują je jako surowe zdarzenie bez tury. Oczekujące wejście i ewentualny odroczony wynik steer pozostają związane z tą samą turą. Błędy, zwykłe komendy z zerową liczbą wywołań modelu oraz rzeczywiste odpowiedzi na powiadomienia nadal kończą turę.
- `init` zachowuje rolę początku natywnej pobudki: rezerwuje turę przed pierwszym outputem modelu, zatrzymuje zamknięcie procesu po 3 s i informuje gateway w oknie 15 s. Reguła dostarczania notatek gateway nie wymaga zmiany.

## Testy regresyjne

Najpierw zaobserwowano RED: dwa testy kolejności shutdownu, dwa testy mapowania oraz integracyjny test odpowiedzi notatki. Test integracyjny używa skryptowanego workera, rzeczywistego mappera i odtworzonej, zanonimizowanej kolejności wiadomości wznowionej sesji (`background-resume-ack.jsonl`).

Test live po restarcie wymaga `worker_shutdown`, czasu końca, odpowiedzi o restarcie w turze `background_task` oraz dokładnie tur `user, background_task` po dodatkowych 4 s obserwacji. Osobny scenariusz naturalnego końca czeka na odpowiedź Claude w turze `provider`, obserwuje jeszcze 17 s i wymaga dokładnie tur `user, provider`, bez notatki platformy. Oba scenariusze uruchamiają własny gateway, PostgreSQL i worker; konfigurację pośrednika dostarcza `useLiveProxy`.

Sekrety ładowano z pliku poza repozytorium; żaden host ani klucz pośrednika nie jest częścią fixture lub raportu. Katalogi tymczasowe testów pochodzą z `@open-agents/testing`.

## Wyniki live

Po poprawkach: **13/13 scenariuszy**, bez błędów:

- Claude, restart i odpowiedź w turze notatki: **6/6**.
- Claude, naturalny koniec i pojedyncza pobudka: **6/6**.
- Codex, restart i odpowiedź w turze notatki: **1/1**.

Obejmuje to jeden wstępny przebieg obu scenariuszy Claude, cztery powtórzenia pliku (`OA_LIVE=1 bun test tests/integration/background-task-notes.live.test.ts -t 'Claude:' --rerun-each 4`: 8/8) i końcowy przebieg całego pliku po scaleniu `main` oraz zachowaniu rezerwacji tury na `init` (`OA_LIVE=1 bun run check:tmp tests/integration/background-task-notes.live.test.ts`: 3/3, 28 asercji, 79,91 s). Końcowy przebieg potwierdził brak pozostawionych katalogów testów. Katalogi robocze narzędzi dostawców, np. cache kompilacji i katalogi sandboxa, są raportowane osobno przez istniejący `check:tmp` i usuwane z jego prywatnym katalogiem nadrzędnym.

Scalono `main` z `e097e72` (merge `0bc549e`). `bun run typecheck` i `bun run gen:check` po scaleniu zakończyły się powodzeniem; Svelte nie zgłosił błędów ani ostrzeżeń.

Końcowy pełny `bun run check:tmp --dots`: **754 pass, 97 skip, 0 fail**, 2894 asercje, 126 plików, 148,63 s; brak pozostawionych katalogów testów. Pominięcia obejmują pozostałe testy live i opt-in test przeglądarkowy. Bezpośrednia weryfikacja przed pełnym zestawem objęła także testy dziennika, workera, mapowania Claude i notatek gateway. Istniejących błędnych zapisów historycznego stosu nie poprawiano — zakres obejmuje kolejne wykonania po aktualizacji kodu.
