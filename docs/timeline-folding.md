# Zwijanie pracy na osi wątku

Każda tura od startu ma fold „Working for …”: czas aktualizowany co sekundę i krótki opis aktywnego narzędzia z dotychczasowym shimmerem. Settings → Threads → Turn activity zawiera dwie preferencje urządzenia, każdą z osobnym resetem:

- „While working”: Expanded (domyślnie) lub Collapsed. Rozwinięta praca pokazuje narzędzia, podsumowania rozumowania i wiadomości postępu. Kolejne grupy narzędzi otwierają się podczas pracy, chyba że czytelnik sam je zamknął; szczegóły pojedynczych itemów pozostają zwinięte.
- „After the turn”: Collapse (domyślnie) lub Keep open. Collapse zamyka pracę już przy pierwszym niepustym tekście odpowiedzi oznaczonej `final_answer`, także przed zakończeniem tury. Keep open pokazuje ją nadal, również po końcu tury; przy Collapsed otwiera ją przy odpowiedzi lub zakończeniu.

Po zakończeniu ten sam nagłówek zmienia się w „Worked for …”, z czasem i licznikami pracy. Ręczne rozwinięcie lub zwinięcie ma pierwszeństwo przez cały pobyt na stronie wątku, także po zmianie preferencji i po końcu tury. Zmiana preferencji obejmuje wyłącznie nietknięte foldy, w tym odziedziczoną historię forka. Preferencje dotyczą wspólnej osi wątków głównych, bocznych i forków; nie zmieniają rozmów botów.

Wewnątrz foldu kolejne narzędzia tworzą grupy, np. „Read 1 file and ran 5 commands”. Wiadomości postępu, rozumowanie, steery i komunikaty rozdzielają grupy. Rozwinięcie grupy pokazuje nagłówki itemów. Każdy item startuje zamknięty: również działające i nieudane komendy, MCP, agent-bus, obrazy, podagenci, zadania w tle i checklisty. Błąd, kod wyjścia i dostępne liczby +/− pozostają w nagłówku; wynik, diff i karty szczegółów pojawiają się po rozwinięciu. Stan itemów zachowuje istniejące `UiMemory`; stan foldów i grup trzyma `WorkFolds` na stronie wątku.

Poza foldem widać tylko ostatnią wiadomość agenta tury, w stałym wierszu `answer:<turnId>`, i to dopiero wtedy, gdy wiadomo, że jest końcowa. Regułę liczy wspólne `answerIndex` (`packages/domain/src/work-fold.ts`) dla webu i mobile:

| Dostawca | Sygnał | Kiedy odpowiedź wychodzi z foldu |
| --- | --- | --- |
| Codex | faza wiadomości od pierwszej delty: `commentary`, `partial_answer` lub `final_answer` | `final_answer` strumieniuje poza foldem od początku |
| Claude | `stream_event` `message_delta` z `stop_reason: "end_turn"` (wiadomość bez `tool_use`; `assistant` ma tu `stop_reason: null`) | po zakończeniu wiadomości: worker ponownie wysyła `itemCompleted` jej ostatniego tekstu z fazą `final_answer`, zwykle tuż przed `result` |
| Grok (ACP) i dostawcy bez sygnału | brak | po końcu tury |

Wiadomości `commentary` i `partial_answer` zawsze zostają w pracy podczas tury. Wiadomość bez fazy (Claude przed `end_turn`, Grok, starszy worker) przy zwiniętym foldzie strumieniuje w nim: nagłówek pokazuje wtedy „Writing…”, a treść nie pojawia się pod foldem, więc nie znika z powrotem przy kolejnym narzędziu. Przy otwartym foldzie (While working: Expanded albo ręczne rozwinięcie) najnowsza niepusta wiadomość bez fazy strumieniuje tymczasowo w slocie odpowiedzi, a kolejne narzędzie przenosi ją do pracy; kolejność i tak jest widoczna. Samo zajęcie slotu nie dowodzi, że odpowiedź jest końcowa: bez fazy automatyczne zwinięcie czeka na koniec tury. Wiadomość oznaczona jako końcowa, po której tura jednak pracuje dalej (np. steer albo kontynuacja celu w Claude), wraca do pracy jak dotąd. `AnswerSlot` zwija dotychczasowe miejsce wiadomości przez przejście wysokości `expand` i token `--duration-fast`. Zakończona tura zachowuje ostatnią wiadomość; tura przerwana lub nieudana tylko wtedy, gdy po wiadomości nie przyszła dalsza praca. Puste/encrypted-only itemy nie tworzą widocznej treści. Przy reduced motion przeniesienie wiadomości jest natychmiastowe.

Przed automatycznym zamknięciem `WorkFolds` sprawdza `VirtualFeed.reading()`. Jeśli czytelnik przewinął w górę lub ma fokus w pracy, fold pozostaje otwarty w pamięci strony, a `hold(key)` zachowuje położenie czytanego wiersza. Ręczne zamknięcie nadal ma pierwszeństwo. Czytelnik śledzący dół otrzymuje zwiniętą pracę i odpowiedź pod nią; istniejące `ScrollIntent`, kotwiczenie, animacje wierszy i obsługa reduced motion pozostają wspólne.

`VirtualFeed.scrollRowToTop(key)` po zakończeniu tury przewija długą odpowiedź do początku, 8 px poniżej góry feedu. Działa tylko, jeśli czytelnik nadal śledzi dół i odpowiedź jest wyższa niż dostępny obszar nad kompozytorem. Krótka odpowiedź ani czytelnik, który przewinął w górę, nie są przesuwani. Zwykły ruch jest płynny, reduced motion natychmiastowy; „Jump to latest” przywraca śledzenie końca. API nie zmienia fokusu ani reguł paddingu kompozytora.

Grupy i itemy są osobnymi wirtualnymi wierszami; zamknięte grupy nie montują dzieci. `ResizeObserver` mierzy zmiany wysokości `AnswerSlot`, a obecne kotwiczenie utrzymuje czytany wiersz. Klucze foldu, grupy (pierwszy item) i odpowiedzi pozostają stabilne między deltami. „Pokaż źródło” cytatu otwiera historię, fold oraz właściwą grupę przed przewinięciem do itemu; rozpoznaje też stały wiersz odpowiedzi.
