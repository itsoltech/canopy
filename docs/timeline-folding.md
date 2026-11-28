# Zwijanie pracy na osi wątku

Status (2026-11-28). Wiersz kompaktowania wyświetla dostępne liczby tokenów przed
i po operacji. Zmiana modelu lub poziomu rozumowania pojawia się przy wejściu
tury, np. „Astra High → Sol Medium”. Oba wpisy są widoczne przy zwiniętej pracy.

Status: opis zaimplementowanego kodu web/desktop/mobile (2026-11-24), w tym
doczytywania brakującej pracy podczas przewijania lub na żądanie w web/desktop,
stosowania „After the turn” do pracy poprzedzającej steer, kompaktowania kontekstu
jako widocznej granicy segmentów pracy, odstępów wokół wiadomości postępu
w web/desktop, ograniczonej długości podglądów aktywności i etykiet narzędzi Canopy
w nagłówkach pracy. Po ukończonej turze wiadomości o postępie pozostają w sekcji
pracy, także gdy dostawca kończy turę pustą odpowiedzią. Dostępność w wydaniach
zależy od kanału.

Aktualizacja (2026-11-25): nowe karty visuals w web/desktop/mobile pojawiają się
po zakończeniu swojej tury, tak samo jak galerie zdjęć i nagrania.

Aktualizacja (2026-11-26): na iOS ręczne przełączenie utrzymuje pozycję nagłówka
w transakcji, która zatwierdza zmianę rozmiaru foldu.

Aktualizacja (2026-11-27): w web/desktop zwijana grupa narzędzi nie przesuwa swoich
wierszy w dół: nagłówek ma jeden odstęp w obu stanach.

Aktualizacja (2026-11-28). W aplikacji mobilnej nagłówek grupy narzędzi, np.
„Made 1 tool call”, ma tekst 13 dp z linią 20 dp. Napis, ikony i licznik statusu
są wyśrodkowane w pionie. Przy domyślnej skali zwinięta karta ma 40 dp wysokości,
a dotyk działa na całej wysokości 44 dp.

Wejście tury zawsze poprzedza jej pracę. Gateway zapisuje tekst i wiąże załączniki
przy przyjęciu wiadomości, przed wysłaniem `StartTurn`. Echo `user_message` od
dostawcy zastępuje placeholder w tym samym miejscu, tuż po początku tury, nawet
gdy ma późniejszy `seq` niż komunikat `connectors_applied` lub inne itemy pracy.
Web/desktop i mobile zachowują tę kolejność na żywo, po ponownym odczycie historii
i przy doczytywaniu stron. `seq` logu nadal opisuje kolejność zapisu zdarzeń;
steery zachowują swoje miejsce między segmentami, bo dołączają do trwającej tury.

Każda tura od startu ma fold „Working for …”: czas aktualizowany co sekundę i krótki opis aktywnego narzędzia z dotychczasowym shimmerem.

Nagłówki pracy i grup narzędzi opisują bieżącą czynność, np. „Starting a subagent…”
lub „Searching the web…”. Podczas oczekiwania na jeden wątek boczny pokazują jego
tytuł, jeśli klient go zna. Przy kilku wątkach podają ich liczbę.

Grupa **Turn activity** zawiera trzy preferencje urządzenia, każdą z osobnym resetem. W web/desktop jest w zakładce **Conversation** sekcji Threads, a na mobile bezpośrednio w **Settings → Threads**.

- „While working”: Expanded (domyślnie) lub Collapsed. Decyduje o całej sekcji pracy, zawierającej grupy narzędzi, podsumowania rozumowania i wiadomości postępu.
- „Tool calls”: Collapsed (domyślnie) lub Expanded. Decyduje osobno o grupach narzędzi podczas pracy. Zwinięty nagłówek nadal pokazuje spinner, liczbę działających itemów oraz bieżącą komendę lub krok. Expanded automatycznie otwiera grupy; szczegóły pojedynczych itemów pozostają zwinięte.
- „After the turn”: Collapse (domyślnie) lub Keep open. Collapse zamyka wcześniejszą pracę przy steerze oraz już przy pierwszym niepustym tekście odpowiedzi oznaczonej `final_answer`, także przed zakończeniem tury. Keep open pokazuje ją nadal, również po końcu tury; przy Collapsed otwiera ją przy steerze, odpowiedzi lub zakończeniu.

Po zakończeniu ten sam nagłówek zmienia się w „Worked for …”, z czasem i licznikami pracy. Ręczny wybór ma pierwszeństwo do kolejnej granicy: steera, oznaczonej odpowiedzi albo końca segmentu/tury. Rozwinięcie podczas pracy nie blokuje „Collapse” na końcu; rozwinięcie po końcu pozostaje otwarte, także po późnych itemach. Wybór zapisuje stan segmentu i `first_seq` oznaczonej odpowiedzi, więc pominięcie aktualizacji podczas reconnectu nie przedłuża go. Zmiana preferencji obejmuje foldy bez ważnego ręcznego wyboru, w tym odziedziczoną historię forka. Preferencje dotyczą wspólnej osi wątków głównych, bocznych i forków; nie zmieniają rozmów botów. Web i mobile trzymają wybory w pamięci osi, poza wirtualnymi wierszami; ponowne otwarcie strony ani reload nie zapisują rozwinięcia pracy na dysku.

Wewnątrz foldu kolejne narzędzia tworzą grupy, np. „Read 1 file and ran 5 commands”. Wiadomości postępu, rozumowanie i komunikaty rozdzielają grupy; steery oraz itemy `context_compaction` rozdzielają całe segmenty pracy. Kompaktowanie jest trwałą granicą: jego wiersz zostaje w chronologicznym miejscu poza poprzednim foldem, a dalsza praca dostaje nowy fold, nawet gdy tura nadal działa. Wielokrotne granice bez pracy pomiędzy stoją razem przed kolejnym foldem. Także pojedyncza grupa od początku ma własny nagłówek i stosuje „Tool calls”: nie jest spłaszczana. Dodanie drugiej grupy zachowuje nagłówek, klucz i stan pierwszej, bez przenoszenia jej itemów. Ręczne rozwinięcie lub zwinięcie ma pierwszeństwo przed preferencją i przetrwa późniejsze itemy, koniec tury, zamknięcie całej sekcji oraz wirtualizację. Po końcu grupa bez ręcznego wyboru zachowuje ostatni stan z pracy; historia niewidziana na żywo startuje zwinięta. Zmiana „Tool calls” obejmuje grupy trwających tur bez ręcznego wyboru. Pamięć grup jest lokalna dla osi wątku, bez zapisu na dysk; web i mobile współdzielą regułę `WorkGroupChoices`.

W web/desktop wiadomości postępu wewnątrz rozwiniętej pracy mają dodatkowe
8 px (`py-2`, skalowane z interfejsem) nad i pod tekstem, także w odziedziczonej
historii forka. Oddziela to prozę od zwiniętych i rozwiniętych grup narzędzi.
Wiersze narzędzi wewnątrz grup zachowują kompaktowe odstępy, a pionowa linia
pracy pozostaje ciągła.

Rozwinięcie grupy pokazuje nagłówki itemów. Każdy item startuje zamknięty: również działające i nieudane komendy, MCP, agent-bus, obrazy, podagenci, zadania w tle i checklisty. Błąd, kod wyjścia i dostępne liczby +/− pozostają w nagłówku; wynik, diff i karty szczegółów pojawiają się po rozwinięciu. Stan itemów zachowuje istniejące `UiMemory`; stan foldów i grup trzyma `WorkFolds` na stronie wątku.

Podglądy poleceń, argumentów narzędzi i bieżącej pracy pokazują pierwszą linię,
do 120 znaków treści. Wielokropek wskazuje skrót. Pełne polecenie, skrypt
i wynik można przeczytać po rozwinięciu itemu. W web/desktop nagłówki sekcji,
grup i poleceń nie powielają podglądu w `title`. Wiersz narzędzia może pokazać
w podpowiedzi krótką, jednoliniową ścieżkę lub adres URL, gdy uzupełnia skróconą
etykietę.

Ostatnia wiadomość agenta tury (albo segmentu, niżej) trafia poza fold w stałym wierszu `answer:<turnId>`, gdy wiadomo, że jest końcowa. Galerie zdjęć, nagrania i nowe karty visuals pojawiają się pod odpowiedzią po zakończeniu tury. Regułę wyboru wiadomości liczy wspólne `answerIndex` (`packages/domain/src/work-fold.ts`) dla webu i mobile:

| Dostawca | Sygnał | Kiedy odpowiedź wychodzi z foldu |
| --- | --- | --- |
| Codex | faza wiadomości od pierwszej delty: `commentary`, `partial_answer` lub `final_answer` | `final_answer` strumieniuje poza foldem od początku |
| Claude | `stream_event` `message_delta` z `stop_reason: "end_turn"` (wiadomość bez `tool_use`; `assistant` ma tu `stop_reason: null`) | po zakończeniu wiadomości: worker ponownie wysyła `itemCompleted` jej ostatniego tekstu z fazą `final_answer`, zwykle tuż przed `result` |
| Grok (ACP) i dostawcy bez sygnału | brak | po końcu tury |

Wiadomości `commentary` i `partial_answer` zostają w pracy podczas tury i po jej
ukończeniu. Gdy ukończone sprawdzenie z harmonogramu zawiera tylko postęp,
komendę i pustą odpowiedź, pod zwiniętą pracą nie ma odpowiedzi. Tekst postępu
i wynik komendy można odczytać po rozwinięciu sekcji pracy.

Wiadomość bez fazy (Claude przed `end_turn`, Grok, starszy worker) przy zwiniętym foldzie strumieniuje w nim: nagłówek pokazuje wtedy „Writing…”, a treść nie pojawia się pod foldem, więc nie znika z powrotem przy kolejnym narzędziu. Przy otwartym foldzie (While working: Expanded albo ręczne rozwinięcie) najnowsza niepusta wiadomość bez fazy strumieniuje tymczasowo w slocie odpowiedzi, a kolejne narzędzie przenosi ją do pracy; kolejność i tak jest widoczna. Samo zajęcie slotu nie dowodzi, że odpowiedź jest końcowa: bez fazy automatyczne zwinięcie czeka na koniec tury. `AnswerSlot` zwija dotychczasowe miejsce wiadomości przez przejście wysokości `expand` i token `--duration-fast`. Ukończona tura pokazuje ostatnią wiadomość końcową lub bez fazy. Tura przerwana lub nieudana pokazuje ostatnią wiadomość tylko wtedy, gdy po niej nie przyszła dalsza praca. Puste/encrypted-only itemy nie tworzą widocznej treści. Przy reduced motion przeniesienie wiadomości jest natychmiastowe.

Stopka końca (także „Could not finish this turn”) jest częścią tej samej grupy
co praca tury. Późne itemy starej tury i koniec jej zadań nie przenoszą stopki
pod nowszy fold „Working for …”. Surowa kolejność zdarzeń nadal wynika z `seq`,
nie z czasu zakończenia. Mobile już grupuje całą turę w jednym wierszu.
Komunikat dostawcy z JSON `type = error` pokazuje czytelny tekst i status HTTP;
pełny JSON i dodatkowe dane są zredagowane i zwinięte pod „Show details” na obu klientach.

Komunikaty liczy wspólne `domain/turn-notices.ts`. Jawne `turn_id` ma pierwszeństwo,
również gdy tura nie należy do odczytanego okna historii. Starszy komunikat bez
powiązania trafia do jedynej tury obejmującej jego zapisany czas; bez czasu musi
leżeć między itemami tej samej tury według `first_seq`. Niejednoznaczne wpisy nie
dostają zgadywanego powiązania. Klienci nie doklejają komunikatów znanych starszych
tur jako czerwonych kart na końcu bieżącego okna.

Po `status = completed` błędy i ostrzeżenia tej tury są kompaktowymi ostrzeżeniami
w pracy, we własnym miejscu `seq`, zwijanymi razem z foldem. Identyczne wpisy
w jednym segmencie pozostają w miejscu pierwszego wystąpienia z licznikiem `×3`.
Różny kod, poziom lub szczegóły oraz granica steera/odpowiedzi zachowują osobne
wpisy. Surowa treść pozostaje w „Show details”. Nieudana lub przerwana tura nie
otrzymuje takiego obniżenia poziomu; karta końca tury zachowuje błąd i akcje.
Wyliczenie korzysta wyłącznie z itemów, tur i komunikatów snapshotu; reload,
przyrostowy sync i późne zdarzenie starej tury stosują te same reguły.

„Retry” po nieudanej turze wysyła wyłącznie „Continue”, bez kopii poprzedniego promptu.
Po rozpoczęciu nowszej tury starszy błąd zostaje jako tytuł i „Show details”;
opis, wskazówki i wszystkie akcje naprawcze znikają. Wiadomość czekająca w kolejce
nie ukrywa jeszcze akcji. Web i mobile zwijają wpis natychmiast, bez animowania
wysokości podczas streamingu; pozycję czytelnika utrzymuje kotwiczenie osi.

## Segmenty tury przy steerach i po pokazanej odpowiedzi

Ta sama tura może dostać steer podczas pracy, wykonać `context_compaction` albo pracować dalej po wiadomości `final_answer`. Podział liczy wspólne `workSegments` (`packages/domain/src/work-fold.ts`): każdy steer i każdy item `context_compaction` zaczyna segment przed dalszą pracą; wiadomość `final_answer`, po której przyszedł jakikolwiek niepusty wiersz tury, kończy swój segment i jest jego odpowiedzią. Potwierdzona odpowiedź zostaje na swoim miejscu.

- Każdy segment ma własny fold z licznikami swojej pracy, własny slot odpowiedzi i własny stan otwarcia. Tylko ostatni nagłówek pokazuje trwającą pracę. Steer kończy poprzednią pracę: wcześniejsze segmenty stosują „After the turn” i unieważniają ręczny wybór wykonany podczas ich pracy. Collapse zamyka je od razu, nawet bez dalszych itemów agenta; Keep open pozostawia je otwarte. Nowy segment stosuje „While working”. Wybór wykonany po steerze w zakończonym segmencie pozostaje ważny przy kolejnych steerach, odpowiedzi i końcu tury oraz późnych itemach.
- Wiersz `context_compaction` działa jak widoczna granica segmentu, ale nie jak wejście użytkownika: nie trafia do ukrywanej pracy ani do licznika foldu. Samo kompaktowanie nie kończy wcześniejszej pracy ani nie unieważnia ręcznego wyboru; późniejszy steer, odpowiedź albo koniec tury stosuje „After the turn” również do segmentów sprzed kompaktowania. Nowy fold zaczyna się po wierszu kompaktowania, więc miejsce rzeczywistego skrócenia kontekstu pozostaje widoczne także podczas aktywnej tury.
- Slot nowego segmentu znów pokazuje tylko odpowiedź potwierdzoną dla tego segmentu, według reguł `answerIndex` (tabela wyżej). Tura przerwana lub nieudana stosuje je do ostatniego segmentu; wcześniejsze zawsze zachowują swoje odpowiedzi.
- Każdy steer stoi nad foldem jako samodzielny wiersz, także na początku, w środku i na końcu tury oraz po dostarczeniu wiadomości z kolejki przez „Steer now”. Kolejne steery bez pracy między nimi stoją razem przed jednym foldem. Żaden z nich nie należy do ukrywanej treści ani do kotwic znikającej pracy.
- Platformowy steer z `backgroundItemIds` zachowuje `BackgroundNoteRow`, zamiast dymka użytkownika. Jego wiersz także pozostaje widoczny poza foldem, w miejscu wynikającym z `first_seq`.
- Czas segmentu biegnie od startu tury lub końca poprzedniej odpowiedzi do końca własnej odpowiedzi albo tury. Granica steer nie ma trwałego znacznika czasu w itemie: segmenty przylegające do niej pokazują „Work” z licznikami, a dalsza aktywna praca „Working”, bez zgadywania czasu. Dane ze strumienia nie zastępują tej brakującej granicy, więc reload nie zmienia etykiety. Czas stopki nadal obejmuje całą turę.
- Stopka tury (Copy answer, Fork from here, czas) i rail odnoszą się do ostatniej wiadomości, czyli odpowiedzi ostatniego segmentu; czas w stopce to cała tura. Po końcu tury `scrollRowToTop` dotyczy slotu ostatniego segmentu.
- Klucze: pierwszy segment zachowuje `work:<turnId>` i `answer:<turnId>`, kolejne dostają `work:<turnId>/<n>` i `answer:<turnId>/<n>` (`foldId`). Segmenty tylko przybywają (faza nie znika), więc istniejące wiersze nie zmieniają kluczy ani nie przeskakują; nowy fold wchodzi istniejącym przejściem `reveal`.

Ponownie otwarty wątek wygląda tak samo jak na żywo. Faza wiadomości oraz `userMessage.clientId` wskazujący steer są zapisane w itemach; podział według `first_seq` nie zależy od chwilowej listy oczekujących steerów, obiektów `Steer` ani zamontowanych wierszy. Identyczny podział obowiązuje przy przyrostowym catch-up i w odziedziczonej historii forka. Czas granicy odpowiedzi daje `TimelineItem.completed_at`: gateway dołącza do zakończonej wiadomości agenta `occurred_at` jej ostatniego zdarzenia (`last_seq`), a strumień na żywo bierze czas ostatniego `itemCompleted` tej wiadomości. Snapshot starszego gatewaya nie ma tego pola: segmenty dzielą się tak samo, ale ich foldy pokazują „Work” bez czasu. Mobile stosuje te same reguły w `TimelineTurn`.

Przed automatycznym zamknięciem `WorkFolds` sprawdza `VirtualFeed.reading()`. Jeśli czytelnik jest w znikającej pracy, `hold(key)` kotwiczy ocalały nagłówek foldu zamiast blokować zwinięcie; nagłówek powyżej widoku trafia na jego górną krawędź. Czytanie innych wierszy zachowuje ich zwykłą kotwicę. Znikające wiersze pracy i grup zwijają wysokość na istniejącym `expand` (`fast` / `smoothOut`); zwykłe wirtualne odmontowanie jest natychmiastowe. Reduced motion wyłącza zwijanie wysokości. Czytelnik śledzący dół otrzymuje zwiniętą pracę i odpowiedź pod nią; istniejące `ScrollIntent` i kotwiczenie pozostają wspólne. Mobile używa tego samego wyliczenia stanu oraz istniejącego `TimelineDisclosure`.

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
ponownego użycia niezmienionych wierszy podczas streamingu. W web nagłówek grupy ma ten
sam odstęp dolny otwarty i zamknięty (jak zamknięty: na końcu foldu lub wewnątrz niego),
a pierwsze dziecko (`lead`) jest podciągnięte w ten odstęp. Przełączenie nie zmienia więc
wysokości nagłówka: zwijane dzieci nie przeskakują w dół i nie odrywają się od niego.
Znikający wiersz feedu przycina przy zwijaniu tylko dolną krawędź, aby podciągnięta część
pozostała widoczna do końca przejścia.

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

## Niepełne okno pracy

Watch `sequence` ma niezależne okna tur i itemów. Rekord zakończonej tury bez
jej itemów nie oznacza pustej pracy. Web/desktop pokazuje w tym miejscu zwarty
wiersz „Show earlier work”. Pierwsza tura z okna itemów również może być niepełna.
Zachowuje już odczytane segmenty, steery oraz odpowiedź, z tym samym wierszem nad
pracą. Przewijanie w górę przy widocznej luce pobiera stronę. Przycisk doczytuje
wybraną turę nawet wtedy, gdy jej praca zajmuje kilka stron. Podczas odczytu
pokazuje „Loading earlier work…”, a po błędzie udostępnia Retry. Stan ten
wynika z granicy itemów, także po odczycie starego cache, a nie z preferencji
foldów. Niezgodność liczby źródłowych wierszy z podsumowaniami segmentów pokazuje
całą treść bez zwijania i rejestruje odzyskiwanie w Diagnostics.

## Pozycja przy ręcznym przełączaniu

Starszy protokół stron historii kończy stronę między turami. Watch `sequence`
stronicuje itemy niezależnie od tur i może przeciąć segment. Dołożenie starszych
steerów zmienia numery segmentów, więc kotwica web zapamiętuje tożsamość
wiadomości i odnajduje jej aktualny slot odpowiedzi zamiast starego numeru.
Dotyczy to również tur odziedziczonych przez fork. Protokół opisuje
[ui-api.md](ui-api.md#strony-historii-i-trwałe-kursory).
Kotwicą web jest treść wiadomości, z pominięciem wierszy początku i końca tury:
dołożenie wcześniejszej tury z tego samego dnia przenosi etykietę daty i nie może
przesunąć czytanego tekstu. Wyszukiwanie oraz cytat mogą doładować starsze strony;
po ich odczycie kotwica nadal wskazuje tę samą wiadomość.

Rozwinięcie albo zwinięcie foldu, grupy narzędzi czy itemu ręcznie trzyma kliknięty nagłówek w tym samym miejscu ekranu: rośnie i maleje to, co jest pod nim, a treść nad nim się nie przesuwa. Dotyczy to także ostatniej tury przy czytelniku na końcu. Granicą jest dostępny zakres przewijania, np. zwinięcie całej treści poniżej wysokości viewportu. „Jump to latest” ponownie włącza śledzenie końca.

- Web: `FeedRowView` podaje klucz wiersza nagłówka, strona wątku woła `VirtualFeed.keep(key)` przed `WorkFolds.toggle`, także dla ostatniego foldu. Ten sam kontrakt ma fixture długiego wątku. Automatyczne zmiany (odpowiedź wychodzi z foldu, nowy segment, koniec tury) trzymają dotychczasową kotwicę `VirtualFeed` i `hold(key)`.
- Mobile: oś jest odwróconą `FlatList`, w której wiersz tury rośnie w stronę starszej
  treści. `ui/feed-anchor.tsx` przed zmianą zapisuje położenie dotkniętego nagłówka.
  Tylko ten nagłówek uruchamia callback klatki. Gest przewijania, dotknięcie innego
  nagłówka i odmontowanie kończą sesję. Szybkie odwrócenie tej samej animacji zachowuje
  początkową kotwicę.
  - iOS: scroll view mierzy nagłówek bezpośrednio względem treści i koryguje offset po
    zamontowaniu zmian w tej samej transakcji Fabric. W trakcie sesji dotknięty nagłówek
    zastępuje wybór pierwszej widocznej komórki. Poprawka jest częścią natywnej kompilacji
    React Native i wymaga nowej kompilacji aplikacji.
  - Android: pozycja wynika z layoutu komórki i różnicy jej pomiaru ekranowego oraz
    pomiaru nagłówka. Bezwzględny cel nie zależy od opóźnionego checkpointu przewijania.
    `maintainVisibleContentPosition` pozostaje skonfigurowane bez autoscrollu przy
    ręcznym przełączeniu. `TimelineList` zachowuje własny `CellRendererComponent`
    przez `createAnimatedComponent(FlatList)`.
