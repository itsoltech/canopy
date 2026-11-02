# Zwijanie pracy na osi wątku

Każda tura od startu ma zamknięty fold „Working for …”: czas aktualizowany co sekundę i krótki opis aktywnego narzędzia z dotychczasowym shimmerem. Po zakończeniu ten sam nagłówek zmienia się w „Worked for …”, z czasem i licznikami pracy. Rozwinięcie przez użytkownika pozostaje rozwinięciem także po końcu tury.

Wewnątrz foldu kolejne narzędzia tworzą zamknięte grupy, np. „Read 1 file and ran 5 commands”. Wiadomości postępu, rozumowanie, steery i komunikaty rozdzielają grupy. Rozwinięcie grupy pokazuje nagłówki itemów. Każdy item startuje zamknięty: również działające i nieudane komendy, MCP, agent-bus, obrazy, podagenci, zadania w tle i checklisty. Błąd, kod wyjścia i dostępne liczby +/− pozostają w nagłówku; wynik, diff i karty szczegółów pojawiają się po rozwinięciu. Stan itemów zachowuje istniejące `UiMemory`; stan foldów i grup trzyma `WorkFolds` na stronie wątku.

Najnowsza niepusta wiadomość agenta strumieniuje poza foldem w stałym wierszu `answer:<turnId>`. Kiedy po niej przyjdzie kolejne narzędzie, trafia do pracy, a `AnswerSlot` zwija jej dotychczasowe miejsce przez przejście wysokości `expand` i token `--duration-fast`. Zakończona tura zachowuje ostatnią wiadomość; tura przerwana lub nieudana tylko wtedy, gdy po wiadomości nie przyszła dalsza praca. Puste/encrypted-only itemy nie tworzą widocznej treści. Przy reduced motion przeniesienie wiadomości jest natychmiastowe.

`VirtualFeed.scrollRowToTop(key)` po zakończeniu tury przewija długą odpowiedź do początku, 8 px poniżej góry feedu. Działa tylko, jeśli czytelnik nadal śledzi dół i odpowiedź jest wyższa niż dostępny obszar nad kompozytorem. Krótka odpowiedź ani czytelnik, który przewinął w górę, nie są przesuwani. Zwykły ruch jest płynny, reduced motion natychmiastowy; „Jump to latest” przywraca śledzenie końca. API nie zmienia fokusu ani reguł paddingu kompozytora.

Grupy i itemy są osobnymi wirtualnymi wierszami; zamknięte grupy nie montują dzieci. `ResizeObserver` mierzy zmiany wysokości `AnswerSlot`, a obecne kotwiczenie utrzymuje czytany wiersz. Klucze foldu, grupy (pierwszy item) i odpowiedzi pozostają stabilne między deltami. „Pokaż źródło” cytatu otwiera historię, fold oraz właściwą grupę przed przewinięciem do itemu; rozpoznaje też stały wiersz odpowiedzi.

## Weryfikacja

Testy jednostkowe: `bun test apps/web/test/worked-for.test.ts` — start bez itemów, live → ended, wiadomość pozostająca poza foldem, grupy i ich etykiety, aktywny hint, puste rozumowanie, tury przerwane/nieudane, zadania w tle i historia forka.

Test przeglądarkowy: `OA_TIMELINE_BROWSER=1 bun test tests/integration/timeline-folding.browser.test.ts` (wymaga builda web i `/usr/bin/chromium`). Używa osobnego PostgreSQL/gateway/scripted worker, web na 5398; nie dotyka współdzielonego stosu. Scenariusz obejmuje 32 grupy, 192 komendy i odczyty, pośrednie wiadomości, MCP/agent-bus/diff, błąd i działającą komendę, pamięć rozwinięcia, przejście wiadomości do foldu, długą strumieniowaną odpowiedź, kotwiczenie i „Jump to latest”. Macierz: 1440×1000 i 390×844, light i dark; osobno krótka odpowiedź i reduced motion.

Zrzuty: `artifacts/timeline-folding/<width>-<theme>-live-collapsed.png`, `*-live-expanded.png`, `*-ended.png`. Są lokalnymi artefaktami, pomijanymi przez git.
