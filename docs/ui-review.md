# Przegląd czytelności interfejsu Canopy

Reguły dotyczą interfejsu web, desktop i mobile. Przy przeglądzie zacznij od zadania użytkownika. Co pozwala mu znaleźć właściwą sekcję, odróżnić dwa podobne obiekty, rozpoznać stan lub przewidzieć skutek akcji? Zachowaj element, który w tym pomaga. Powtórzenie tekstu, ten sam glif w kilku miejscach i trafienie licznika to wskazówki do obejrzenia konkretnego widoku.

### Ikony w ustawieniach

W szerokim bocznym menu ustawień **zachowujemy ikonę obok nazwy każdej sekcji**. Użytkownik skanuje listę wzrokiem i rozpoznaje znajomy kształt. Tekst identyfikuje cel i nadaje linkowi nazwę dostępną dla czytnika ekranu. Glif może mieć `aria-hidden="true"` i nadal spełniać ważną funkcję wizualną. Po usunięciu ikon użytkownik zgłosił ich brak. Przywrócono je w [PR #1033](https://github.com/itsoltech/canopy/pull/1033).

Wąski widok ma własne menu z nazwą aktywnej sekcji i oznaczeniem wyboru. Oceniaj każdy układ w jego kontekście. Gdy dwie sekcje trudno odróżnić przez wspólny piktogram, rozważ zmianę tego jednego piktogramu. Przykładem zbędnej dekoracji może być identyczny kafelek z iskrą nad każdą kartą, jeśli nie pomaga odróżnić rodzaju, stanu ani akcji.

### Jak stosować U1–U20

Domyślny zakres obejmuje U1–U16. U17–U20 dotyczą wyglądu i ruchu, gdy zadanie je obejmuje (np. `--surface`). Teksty produktu stosują [glosariusz i reguły copy](copy.md), a wymiary i gęstość — [skalę interfejsu](ui-scale.md). Znaczenie stanu lub liczby sprawdź w dokumencie danej funkcji.

| Reguła | Decyzja w Canopy |
| --- | --- |
| U1 · Nadtytuły | Usuń podpis powtarzający tytuł. Zachowaj nagłówki grup, które dzielą długie menu ustawień lub oddzielają akcje wykonywane na różnych komputerach. |
| U2 · Numeracja | Zachowaj kolejność kroków instalacji i parowania, numer próby oraz skrót klawiaturowy wybierający odpowiedź. Ozdobne numerowanie równorzędnych kart można pominąć. |
| U3 · Podtytuły | Sprawdź, czy podpis rozróżnia podobne opcje. Informacja, czy ustawienie dotyczy workera, projektu czy całego konta, wpływa na wybór. |
| U4 · Instrukcje | Skróć instrukcję, którą w całości przekazuje przycisk. Zachowaj przyczynę błędu, możliwy następny krok oraz skutki udzielenia zgody, restartu czy usunięcia danych. |
| U5 · Szczegóły działania | Zachowaj informację o nieaktualnych danych, zakresie dostępu lub konieczności ponownego połączenia. Informacja potrzebna do podjęcia decyzji ma być dostępna także na dotyku, bez najeżdżania kursorem. |
| U6 · Ciągi metadanych | W głównym wierszu pokaż dane potrzebne do rozpoznania celu i wyniku. Repozytorium, gałąź i komputer mogą być potrzebne jednocześnie przy potwierdzaniu operacji. Pozostałe szczegóły można rozwinąć. |
| U7 · Powtórzone etykiety i akcje | Zachowaj etykietę powiązaną z polem, nazwę dostępną i przykład wymaganego formatu. W pustej bibliotece dwa sąsiednie przyciski „Add document” otwierające ten sam edytor można zastąpić jednym w stałym miejscu. |
| U8 · Slogany | Usuń wypełniacz z roboczego formularza. Przy pierwszym uruchomieniu i pustych stanach uwzględnij przykłady zaakceptowane w `copy.md` oraz akcję, którą użytkownik może wykonać. |
| U9 · Odznaki | Zachowaj oznaczenia wynikające z danych, np. kanał wydania lub oczekującą aktualizację. Stan może być stały na danym ekranie, bo odfiltrował go już komponent nadrzędny. |
| U10 · Kropki stanu | Zachowaj sygnał wiadomości nieprzeczytanej, połączenia lub trwającej pracy wraz z dostępnym opisem. Sprawdź, czy stan można rozpoznać także bez rozróżniania kolorów. |
| U11 · Ikony | Zachowaj punkty orientacyjne w nawigacji, ikony czynności i znaki rozróżniające typy obiektów. Oceń ich rolę wśród sąsiednich elementów i w wariancie zwiniętym. Sama obecność etykiety tekstowej nie uzasadnia usunięcia ikony. |
| U12 · Tytuł wykresu | Nazwij mierzoną wielkość i zakres. Na wykresie z bieżącymi danymi użyj tytułu, który będzie prawdziwy również po odświeżeniu. |
| U13 · Jak czytać wykres | Zachowaj jednostkę, okres i strefę czasu. W Usage wskazówka po uzyskaniu fokusu wyjaśnia, że strzałkami można zmienić dzień. |
| U14 · Liczba i wykres | Zachowaj postęp graficzny do szybkiej oceny i dokładną wartość, gdy służy do odczytu lub porównania. Podsumowanie CI pokazuje liczbę ukończonych elementów, mianownik i procent zgodnie z [kontraktem GitHub](github.md). |
| U15 · Osie i siatka | Osłab linie konkurujące z danymi. Zachowaj punkt odniesienia, czytelny kontrast w obu motywach oraz próg, którego przekroczenie zmienia decyzję. |
| U16 · Legenda | Podpis przy serii sprawdza się, gdy mieści się także na wąskim ekranie. Zachowaj legendę lub klucz ze znakami, gdy umożliwiają porównanie serii albo rozpoznanie ich bez koloru. |
| U17 · Gradient i cień | Zachowaj np. zanikanie treści przy przewijanej krawędzi, gdy wskazuje dalszy ciąg, oraz widoczny fokus. Do dekoracji stosuj tokeny projektu. |
| U18 · Odstępy | Porównuj elementy w tej samej gęstości. Zachowaj obszary dotyku, bezpieczne marginesy systemowe i miejsce zarezerwowane na akcje pojawiające się przy zmianie stanu. |
| U19 · Grubość tekstu | Użyj hierarchii z komponentów Canopy. Sprawdź, czy po zmianie nadal widać aktywną pozycję, nagłówki grup i wartości wymagające uwagi. |
| U20 · Ruch | Zachowaj informację o postępie, rozwinięciu czy zmianie stanu również przy ograniczonym ruchu. Do korekt animacji użyj tokenów ruchu Canopy. |

### Wynik przeglądu

Przy ustaleniu wskaż widok, stan i konkretny skutek dla użytkownika. Obejrzyj zmieniony układ z typową i długą nazwą na szerokościach, przy których zmienia się nawigacja lub sposób obsługi. Dla kontrolek sprawdź nazwę dostępną i odpowiednią metodę obsługi, np. przejście klawiaturą do podmenu lub otwarcie szczegółów dotykiem. Jeśli nie możesz wykazać korzyści z usunięcia elementu, zachowaj go i krótko opisz wątpliwość. Sam audyt kończy się ustaleniami. Poprawki wprowadzaj w zakresie zleconego zadania.
