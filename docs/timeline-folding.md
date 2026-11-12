# Zwijanie pracy na osi wątku

Każda tura od startu ma fold „Working for …”: czas aktualizowany co sekundę i krótki opis aktywnego narzędzia z dotychczasowym shimmerem. Settings → Threads → Turn activity zawiera dwie preferencje urządzenia, każdą z osobnym resetem:

- „While working”: Expanded (domyślnie) lub Collapsed. Rozwinięta praca pokazuje narzędzia, podsumowania rozumowania i wiadomości postępu. Kolejne grupy narzędzi otwierają się podczas pracy, chyba że czytelnik sam je zamknął; szczegóły pojedynczych itemów pozostają zwinięte.
- „After the turn”: Collapse (domyślnie) lub Keep open. Collapse zamyka pracę już przy pierwszym niepustym tekście odpowiedzi oznaczonej `final_answer`, także przed zakończeniem tury. Keep open pokazuje ją nadal, również po końcu tury; przy Collapsed otwiera ją przy odpowiedzi lub zakończeniu.

Po zakończeniu ten sam nagłówek zmienia się w „Worked for …”, z czasem i licznikami pracy. Ręczne rozwinięcie lub zwinięcie ma pierwszeństwo przez cały pobyt na stronie wątku, także po zmianie preferencji i po końcu tury. Zmiana preferencji obejmuje wyłącznie nietknięte foldy, w tym odziedziczoną historię forka. Preferencje dotyczą wspólnej osi wątków głównych, bocznych i forków; nie zmieniają rozmów botów.

Wewnątrz foldu kolejne narzędzia tworzą grupy, np. „Read 1 file and ran 5 commands”. Wiadomości postępu, rozumowanie, steery i komunikaty rozdzielają grupy. Rozwinięcie grupy pokazuje nagłówki itemów. Każdy item startuje zamknięty: również działające i nieudane komendy, MCP, agent-bus, obrazy, podagenci, zadania w tle i checklisty. Błąd, kod wyjścia i dostępne liczby +/− pozostają w nagłówku; wynik, diff i karty szczegółów pojawiają się po rozwinięciu. Stan itemów zachowuje istniejące `UiMemory`; stan foldów i grup trzyma `WorkFolds` na stronie wątku.

Poza foldem widać tylko ostatnią wiadomość agenta tury (albo segmentu, niżej), w stałym wierszu `answer:<turnId>`, i to dopiero wtedy, gdy wiadomo, że jest końcowa. Regułę liczy wspólne `answerIndex` (`packages/domain/src/work-fold.ts`) dla webu i mobile:

| Dostawca | Sygnał | Kiedy odpowiedź wychodzi z foldu |
| --- | --- | --- |
| Codex | faza wiadomości od pierwszej delty: `commentary`, `partial_answer` lub `final_answer` | `final_answer` strumieniuje poza foldem od początku |
| Claude | `stream_event` `message_delta` z `stop_reason: "end_turn"` (wiadomość bez `tool_use`; `assistant` ma tu `stop_reason: null`) | po zakończeniu wiadomości: worker ponownie wysyła `itemCompleted` jej ostatniego tekstu z fazą `final_answer`, zwykle tuż przed `result` |
| Grok (ACP) i dostawcy bez sygnału | brak | po końcu tury |

Wiadomości `commentary` i `partial_answer` zawsze zostają w pracy podczas tury. Wiadomość bez fazy (Claude przed `end_turn`, Grok, starszy worker) przy zwiniętym foldzie strumieniuje w nim: nagłówek pokazuje wtedy „Writing…”, a treść nie pojawia się pod foldem, więc nie znika z powrotem przy kolejnym narzędziu. Przy otwartym foldzie (While working: Expanded albo ręczne rozwinięcie) najnowsza niepusta wiadomość bez fazy strumieniuje tymczasowo w slocie odpowiedzi, a kolejne narzędzie przenosi ją do pracy; kolejność i tak jest widoczna. Samo zajęcie slotu nie dowodzi, że odpowiedź jest końcowa: bez fazy automatyczne zwinięcie czeka na koniec tury. `AnswerSlot` zwija dotychczasowe miejsce wiadomości przez przejście wysokości `expand` i token `--duration-fast`. Zakończona tura zachowuje ostatnią wiadomość; tura przerwana lub nieudana tylko wtedy, gdy po wiadomości nie przyszła dalsza praca. Puste/encrypted-only itemy nie tworzą widocznej treści. Przy reduced motion przeniesienie wiadomości jest natychmiastowe.

Stopka końca (także „Could not finish this turn”) jest częścią tej samej grupy
co praca tury. Późne itemy starej tury i koniec jej zadań nie przenoszą stopki
pod nowszy fold „Working for …”. Surowa kolejność zdarzeń nadal wynika z `seq`,
nie z czasu zakończenia. Mobile już grupuje całą turę w jednym wierszu.
Komunikat dostawcy z JSON `type = error` pokazuje czytelny tekst i status HTTP;
pełny JSON i dodatkowe dane są zredagowane i zwinięte pod „Show details” na obu klientach.

„Retry” po nieudanej turze wysyła wyłącznie „Continue”, bez kopii poprzedniego promptu.
Po rozpoczęciu nowszej tury starszy błąd zostaje jako tytuł i „Show details”;
opis, wskazówki i wszystkie akcje naprawcze znikają. Wiadomość czekająca w kolejce
nie ukrywa jeszcze akcji. Web i mobile zwijają wpis natychmiast, bez animowania
wysokości podczas streamingu; pozycję czytelnika utrzymuje kotwiczenie osi.

## Segmenty tury po pokazanej odpowiedzi

Ta sama tura może pracować dalej po wiadomości `final_answer`: steer dostarczony do działającej tury, kontynuacja celu albo agent, który po prostu kontynuuje. Taka odpowiedź zostaje na swoim miejscu, a dalsza praca tworzy kolejny segment, ułożony jak nowa tura. Podział liczy wspólne `workSegments` (`packages/domain/src/work-fold.ts`): wiadomość `final_answer`, po której przyszedł jakikolwiek niepusty wiersz tury, kończy swój segment i jest jego odpowiedzią.

- Każdy segment ma własny fold „Working for …”/„Worked for …” z licznikami swojej pracy, własny slot odpowiedzi i własny stan otwarcia. Segment ostatni w działającej turze jest „live”; poprzednie zachowują się jak zakończone (After the turn). Ręczny wybór i czytelnik w pracy działają per fold.
- Slot nowego segmentu znów pokazuje tylko odpowiedź potwierdzoną dla tego segmentu, według reguł `answerIndex` (tabela wyżej). Tura przerwana lub nieudana stosuje je do ostatniego segmentu; wcześniejsze zawsze zachowują swoje odpowiedzi.
- Steery na początku segmentu (zaraz po odpowiedzi) stoją nad jego foldem jako wiadomości użytkownika. Steer w środku pracy zostaje w foldzie, jak dotąd.
- Czas segmentu biegnie od końca poprzedniej odpowiedzi (pierwszy segment: od startu tury) do końca jego odpowiedzi (ostatni: do końca tury). Suma segmentów daje czas tury.
- Stopka tury (Copy answer, Fork from here, czas) i rail odnoszą się do ostatniej wiadomości, czyli odpowiedzi ostatniego segmentu; czas w stopce to cała tura. Po końcu tury `scrollRowToTop` dotyczy slotu ostatniego segmentu.
- Klucze: pierwszy segment zachowuje `work:<turnId>` i `answer:<turnId>`, kolejne dostają `work:<turnId>/<n>` i `answer:<turnId>/<n>` (`foldId`). Segmenty tylko przybywają (faza nie znika), więc istniejące wiersze nie zmieniają kluczy ani nie przeskakują; nowy fold wchodzi istniejącym przejściem `reveal`.

Ponownie otwarty wątek wygląda tak samo jak na żywo. Faza wiadomości jest zapisana w itemie, więc podział wychodzi identyczny. Czas granicy daje `TimelineItem.completed_at`: gateway dołącza do zakończonej wiadomości agenta `occurred_at` jej ostatniego zdarzenia (`last_seq`), a strumień na żywo bierze czas ostatniego `itemCompleted` tej wiadomości. Snapshot starszego gatewaya nie ma tego pola: segmenty dzielą się tak samo, ale ich foldy pokazują „Work” bez czasu. Mobile stosuje te same reguły w `TimelineTurn`.

Przed automatycznym zamknięciem `WorkFolds` sprawdza `VirtualFeed.reading()`. Jeśli czytelnik przewinął w górę lub ma fokus w pracy, fold pozostaje otwarty w pamięci strony, a `hold(key)` zachowuje położenie czytanego wiersza. Ręczne zamknięcie nadal ma pierwszeństwo. Czytelnik śledzący dół otrzymuje zwiniętą pracę i odpowiedź pod nią; istniejące `ScrollIntent`, kotwiczenie, animacje wierszy i obsługa reduced motion pozostają wspólne.

`VirtualFeed.scrollRowToTop(key)` po zakończeniu tury przewija długą odpowiedź do początku, 8 px poniżej góry feedu. Działa tylko, jeśli czytelnik nadal śledzi dół i odpowiedź jest wyższa niż dostępny obszar nad kompozytorem. Krótka odpowiedź ani czytelnik, który przewinął w górę, nie są przesuwani. Zwykły ruch jest płynny, reduced motion natychmiastowy; „Jump to latest” przywraca śledzenie końca. API nie zmienia fokusu ani reguł paddingu kompozytora.

W web grupy i itemy są osobnymi wirtualnymi wierszami; zamknięte grupy nie montują dzieci. `ResizeObserver` mierzy zmiany wysokości `AnswerSlot`, a obecne kotwiczenie utrzymuje czytany wiersz. Klucze foldu, grupy (pierwszy item) i odpowiedzi pozostają stabilne między deltami. „Pokaż źródło” cytatu otwiera historię, fold oraz właściwą grupę przed przewinięciem do itemu; rozpoznaje też stały wiersz odpowiedzi.

## Hierarchia treści pracy

Web/desktop i mobile pokazują tekst agenta zwykłą typografią wiadomości, także wewnątrz
foldu. Odpowiedź pozostaje w osobnym slocie pod pracą. Narzędzia i ich grupy mają mniejszy
tekst kontekstu pracy, ikonę Tabler, neutralne tło oraz cienką lewą krawędź. Jednorodne
grupy zachowują ikonę rodzaju pracy, mieszane używają listy kroków. Szczegóły narzędzi
zachowują kompaktowy układ. W rozwiniętym wierszu tło i lewa krawędź obejmują
nagłówek oraz szczegóły; kod i wynik mają wspólny wewnętrzny inset 8 px (web od `sm`: 12 px).
Grupa kontynuuje tę samą powierzchnię przez osobne wirtualne wiersze, z dolnymi
rogami tylko na ostatnim dziecku. Narzędzia wewnątrz grupy mają wcięcie zamiast
kolejnych ramek i teł. Metadane fragmentu grupy są prymitywne, więc nie naruszają
ponownego użycia niezmienionych wierszy podczas streamingu.

Rozumowanie ma ikonę żarówki, stałe miejsce na „Thinking” / „Thought” oraz kursywę
w jednoliniowym podglądzie. Ma własną, słabszą powierzchnię i ciągłą krawędź, także
po rozwinięciu. Tło i krawędź aktywności pozostają
neutralne także po błędzie, odrzuceniu i przerwaniu. Kolor ma tylko ikona lub status.
Zwarta etykieta grupy podaje liczbę elementów ze statusem o najwyższym priorytecie
(błąd, odrzucenie, przerwanie, działanie); pozostałe stany widać po rozwinięciu.
Na telefonie widoczna jest ikona i liczba, pełna etykieta pozostaje dostępna dla czytnika.
Wcięcia i krawędzie nie zależą od stanu. Reguły grupowania,
klucze wierszy, pamięć rozwinięcia i kotwiczenie pozostają wspólne. Szczegóły web
rozwijają tor grid `0fr` → `1fr` bez pomiaru wysokości, na tokenach `fast` / `smoothOut`;
zamknięte szczegóły są odmontowane. Rogi nagłówka zmieniają się na tych samych tokenach.
Przy ograniczonym ruchu obie zmiany są natychmiastowe. Wirtualne dzieci grup zachowują
docelową wysokość i istniejące wejście, aby nie zmieniać kotwiczenia. Mobile używa
`TimelineDisclosure`: fold i grupa montują treść przy pierwszym otwarciu, a następnie
zachowują ją do usunięcia wirtualnej komórki tury. Wysokość zmienia się na wątku UI
przez Reanimated (`fast` / `smoothOut`, 250 ms), tak jak obrót chevrona. Pierwszy layout
mierzy treść raz; kolejne przełączenia odczytują jej bieżący rozmiar synchronicznie na UI.
Po otwarciu wysokość jest naturalna, więc strumień i zagnieżdżone rozwinięcia nie
wymagają pomiarów JS w każdej klatce. Zamknięta treść nie przyjmuje dotyku ani fokusu
czytnika i wstrzymuje zegary oraz dekoracje. Ograniczony ruch zmienia wysokość i chevron
natychmiast. Stan ręcznego przełączenia grupy jest lokalny; nie przebudowuje innych grup.

## Pozycja przy ręcznym przełączaniu

Strona historii kończy się wyłącznie między turami. Wejście, segmenty
„Worked for…”, odpowiedzi i stopka jednej tury przychodzą razem; dotyczy to
również tur odziedziczonych przez fork. Dołożenie starszych tur zachowuje
klucze istniejących wierszy i kotwicę czytelnika. Protokół opisuje
[ui-api.md](ui-api.md#strony-historii-i-trwałe-kursory).
Kotwicą web jest treść wiadomości, z pominięciem wierszy początku i końca tury:
dołożenie wcześniejszej tury z tego samego dnia przenosi etykietę daty i nie może
przesunąć czytanego tekstu. Wyszukiwanie oraz cytat mogą doładować starsze strony;
po ich odczycie nadal obowiązują te same klucze foldów i segmentów.

Rozwinięcie albo zwinięcie foldu, grupy narzędzi czy itemu ręcznie trzyma kliknięty nagłówek w tym samym miejscu ekranu: rośnie i maleje to, co jest pod nim, a treść nad nim się nie przesuwa. Dotyczy to także ostatniej tury przy czytelniku na końcu. Granicą jest dostępny zakres przewijania, np. zwinięcie całej treści poniżej wysokości viewportu. „Jump to latest” ponownie włącza śledzenie końca.

- Web: `FeedRowView` podaje klucz wiersza nagłówka, strona wątku woła `VirtualFeed.keep(key)` przed `WorkFolds.toggle`, także dla ostatniego foldu. Ten sam kontrakt ma fixture długiego wątku. Automatyczne zmiany (odpowiedź wychodzi z foldu, nowy segment, koniec tury) trzymają dotychczasową kotwicę `VirtualFeed` i `hold(key)`.
- Mobile: oś jest odwróconą `FlatList`, w której wiersz tury rośnie w stronę starszej treści. `ui/feed-anchor.tsx` zapisuje pozycję nagłówka przed zmianą i koryguje ją przez `measure` / `scrollTo` na wątku UI podczas przejścia. `maintainVisibleContentPosition` jest wtedy wyłączone, aby kotwica natywnej komórki nie konkurowała z nagłówkiem. Po ustaleniu layoutu wraca obsługa zmian automatycznych. Tylko przełączany nagłówek uruchamia callback klatki; gest przewijania, nowsze przełączenie i odmontowanie kończą poprzednią sesję. Nie ma opóźnionych callbacków JS mierzących komórkę, która mogła już opuścić okno listy. Kontener listy subskrybuje sam stan sesji; klucze, tablica tur i propsy pozostałych komórek zachowują tożsamość.
