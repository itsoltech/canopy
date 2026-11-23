# Pamięć agentów i botów

Status (2026-11-23): zaimplementowana pamięć gatewaya dla wątków i botów oraz
Settings → Memory w webie, desktopie i aplikacji mobilnej. Web i desktop mają
wyszukiwanie, filtry projektu i workera oraz daty utworzenia notatek. Dostępność
zależy od [promocji wydania](release.md).

Okresową analizę wiadomości opisuje [Refleksja](#refleksja).

## Zakres

Gateway przechowuje pojedyncze notatki w PostgreSQL. Identyfikatory zakresu
wyprowadza z aktywnej tury i danych właściciela.

| Zakres | Dostęp |
| --- | --- |
| Project | Wątki jednego projektu Canopy na jego workerach i w worktree. |
| Worker | Wątki projektu na przypisanym workerze. Notatka jest przechowywana w tej samej bazie gatewaya. |
| Bot | Prywatna rozmowa właściciela z botem i uprawnione rutyny. Pamięć jest przypisana do bota i dostępna po zmianie modelu, dostawcy lub workera. |
| Conversation | Jedna rozmowa zewnętrzna danego bota, identyfikowana przez jej UUID. |

Wątki **No project** mają niezależne katalogi scratch. Wspólne systemowe ID
projektu nie daje im dostępu do pamięci. Na połączonych komputerach pamięć
pozostaje przy gatewayu przechowującym projekt. Scalenie projektów w pickerze
po git origin dotyczy widoku ([linked-computers.md](linked-computers.md#tożsamość-projektu-według-git-origin)).

## Użycie przez agenta

Claude, Codex i Grok mogą wywołać `memory_search` z maksymalnie trzema krótkimi
zapytaniami. Wynik zawiera pełną notatkę, zakres, ID i rewizję. Wagi tytułu
i aliasów są większe od wagi treści. Warto użyć dokładnego symbolu, nazwy
narzędzia lub błędu i dodać osobny wariant w drugim języku, gdy jest potrzebny.

`memory_save` dodaje wpis w najwęższym pasującym zakresie. Agent przekazuje
ID i oczekiwaną rewizję przy poprawianiu istniejącego wpisu. Instrukcja wątku
zaleca zapisywać sprawdzone ustalenia, zachować warunki zastosowania i zmieniać
wpis po korekcie użytkownika. Treść pamięci podlega aktualnym uprawnieniom
oraz instrukcjom użytkownika. Tryb Read only pozwala odczytywać notatki.

Bot dostaje ograniczony blok przypiętych oraz trafnych notatek jako dane
wejściowe bieżącej tury. Ten blok odświeża się przy kolejnej turze w tej samej
sesji. Handoff zachowuje osobną funkcję przekazania stanu pracy przy zmianie
modelu. Uprawnienia zapisu zależą także od pochodzenia wejścia. Bezpośrednia
rozmowa właściciela i zaufany start rutyny mogą zapisywać pamięć bota,
a zewnętrzne wiadomości mogą aktualizować pamięć własnej rozmowy. Przychodzące
wymiany bot–bot używają odrębnego kontekstu wykonania. Jeżeli taka wymiana
zaczyna się w turze z ograniczonym dostępem i przekracza granicę gatewaya,
dom odbiorcy musi obsługiwać izolowane przyjęcie wiadomości.

Delegowane wątki używają zakresu odbiorców ustalonego przez gateway. Węższa
delegacja dziedziczy ten zakres w kolejnych wątkach i korzysta z odpowiednio
ograniczonej historii. Wersje gatewayów obsługujących połączone komputery
muszą umieć przekazać i egzekwować uprawnienia delegowanej pracy. Bardzo stare
gatewaye używały zwykłych tras UI właściciela do części automatycznych odczytów.
Pełne rozróżnienie tych odczytów wymaga aktualizacji gatewaya źródłowego.

## Przeglądanie, edycja i usuwanie

W **Settings → Memory** można filtrować według zakresu, otworzyć pełną treść,
zmienić tytuł, treść, aliasy i przypięcie oraz trwale usunąć notatkę po
potwierdzeniu. Operacje sprawdzają rewizję otwartej wersji. Konflikt wymaga
odczytania aktualnego wpisu przed ponownym zapisem.

Web i desktop wyszukują fragmenty tytułów, treści i aliasów bez rozróżniania
wielkości liter. Wyszukiwanie i filtry działają razem na wszystkich notatkach
właściciela. Filtr projektu obejmuje jego notatki wspólne oraz przypisane do
workerów. Filtr workera wybiera notatki z jego zakresu. Lista pokazuje podgląd
treści i datę utworzenia, po 20 wpisów na stronę, w grupach według dnia
ostatniej zmiany. W szczegółach edytowanej notatki widać obie daty, jeśli
data utworzenia jest dostępna. Data historycznych wpisów pochodzi z czasu
zapisu pierwszej rewizji lub znacznika czasu w identyfikatorze UUIDv7.

Nowe odczyty uwzględniają edycję i usunięcie. Treść zacytowana wcześniej
w odpowiedzi jest częścią historii rozmowy. Pliki pamięci CLI dostawców mają
własny cykl zapisu i odczytu.

## Trwałość i indeks

PostgreSQL przechowuje notatki, rewizje dostępnych zakresów i potwierdzenia
mutacji narzędzia. Ponowienie wywołania nie tworzy drugiego wpisu. Trwałe
usunięcie usuwa treść wpisu. Klucz już wykonanej operacji pozwala rozpoznać
późniejsze ponowienie także po usunięciu wpisu.

MiniSearch działa w procesie gatewaya. Zbiór wejściowy jest ograniczony do
zakresów właściciela uprawnionych w danej turze. Gateway sprawdza rewizję
w bazie i odbudowuje indeks po zmianie. Krótkie zapytania narzędzia mogą
korzystać z dopasowania prefiksów i literówek. Automatyczny odczyt bota ma
ostrzejsze kryteria i może zwrócić pusty wynik.

Przy zmianie domowego gatewaya notatki są dostępne w domu pierwotnym. Pełna
[konsolidacja gatewayów](linked-computers.md#konsolidacja-dodatkowego-komputera)
przenosi notatki, ich zakresy oraz potwierdzenia operacji.

## Refleksja

Status (2026-11-23): Habits w Settings → Memory, okresowa analiza wiadomości,
przegląd sugestii i dostarczanie zatwierdzonych nawyków do Claude, Codexa i Groka
są zaimplementowane. Dostępność zależy od [promocji wydania](release.md).
Ustawienia Habits w webie, desktopie i aplikacji mobilnej pozwalają wybrać
model z profilu dostawcy oraz poziom rozumowania. Gateway dobiera workera
przy każdym przebiegu analizy.
Konsolidacja przenosi zatwierdzone reguły jako notatki. Ustawienia analizy,
sugestie, dowody i stan dostarczania pozostają w źródłowym gatewayu.

**Habits** to krótkie reguły projektu. Refleksja wykrywa powtarzane prośby,
przypomnienia i korekty właściciela dotyczące formy odpowiedzi lub prezentacji
wyniku. Właściciel sprawdza przykłady i zatwierdza, zmienia albo odrzuca
sugestię. Zatwierdzony nawyk jest zwykłą notatką projektu. Szablony używają
prostego języka inspirowanego ASD-STE100. Przykład:

> After UI changes, capture a screenshot. Show it with `show_images`.

### Ustawienia i źródła

- Refleksja jest domyślnie wyłączona. Właściciel wybiera projekty, których
  wiadomości chce analizować, oraz częstotliwość. Dostępne interwały to
  6, 12 i 24 godziny oraz 3 i 7 dni. Domyślne są 24 godziny.
- W webie i desktopie opcja All projects zaznacza wszystkie dostępne projekty
  niezależnie od wyszukiwania. Ponowne kliknięcie przy pełnym wyborze czyści
  zaznaczenie. Zapis obejmuje bieżący wybór. Aby uwzględnić nowo dodane
  projekty, zaktualizuj wybór i zapisz go ponownie.
- Wybór modelu obejmuje profile dostawców na workerach właściciela.
  Ten sam model z tego samego profilu pojawia się raz, nawet gdy działa
  na kilku komputerach. Można wybrać konkretny model i obsługiwany poziom
  rozumowania albo Auto dla danego profilu. Ustawienia modelu Habits są
  niezależne od ustawień generowania tytułów i nazw gałęzi.
- Pierwszy przebieg może objąć ostatnie 30 dni. Wątek kwalifikuje się po
  archiwizacji albo po 7 dniach bez wiadomości właściciela, po zakończeniu
  tur i zadań w tle. Gateway czyta oryginalną treść dostarczonych tur i
  steeringu oznaczoną przy przyjęciu bezpośredniej wypowiedzi właściciela.
  Starsze wiadomości bez tego oznaczenia są pomijane.
- Zakres obejmuje prywatne wątki wybranych projektów na domowym gatewayu.
  Gateway pomija odziedziczony prefiks forka, importy, wątki o węższym
  audytorium, wejścia automatyczne, odpowiedzi sugerowane przez agenta i
  komendy powłoki. Ekstraktor pomija cytaty, załączniki, bloki kodu, logi
  oraz fragmenty z rozpoznanymi sekretami.

### Przebieg i dowody

Gateway rezerwuje partię wiadomości jednego projektu w PostgreSQL. Partia
mieści do 8 KiB wraz z poleceniem. Przy braku kwalifikujących się wiadomości
gateway pomija wywołanie modelu. Inferencję wykonuje izolowany
[GenerateText](thread-titles.md#izolacja-sdk). Gateway wybiera połączony worker
właściciela z dostępnym profilem, modelem i poziomem rozumowania. Worker dostaje
wybrane fragmenty wiadomości w prompcie i może wykonać analizę bez katalogu
roboczego projektu. Wcześniej zapisane ustawienia zachowują wybór profilu
i modelu. Model Auto wybiera
Haiku dla Claude, Luna lub Mini dla Codexa i Mini dla Groka oraz niski
obsługiwany effort. Brak małego modelu odkłada analizę. Jawny wybór modelu
i effort ma pierwszeństwo.

Model zwraca do trzech wyników ze słownika warunków, czynności i rodzajów
sygnału. Odsyła do wiadomości przez tymczasowe identyfikatory. Gateway
sprawdza wynik i liczy niezależne przypadki. Do przeglądu potrzeba dowodów
z trzech różnych wątków należących do co najmniej dwóch rodzin w ciągu
60 dni. Wątki boczne i forki liczą się w rodzinie swojego źródła.
„Znowu brakuje zrzutu” jest sygnałem pominięcia. Sama prośba o zrzut jest
dowodem prośby.

Źródła przechowuje się jako identyfikatory bez kopii wypowiedzi. Cofnięcie,
ukrycie albo purge źródła aktualizuje podstawę oczekującej sugestii.
Właściciel widzi przykłady z nadal dostępnych rozmów. Rozstrzygnięcie
sprawdza rewizje.
Ponowna analiza dowodów nie odtwarza odrzuconej lub usuniętej reguły.
Nowsza sprzeczna korekta może wstrzymać automatyczne podawanie nawyku do
decyzji właściciela.

Gateway zwalnia transakcję przed inferencją. Zapis wyniku sprawdza
dzierżawę, rewizję ustawień i dostępność źródeł. Wyłączenie analizy
unieważnia spóźniony wynik i anuluje zadanie na zgodnym workerze.
Utrata odpowiedzi po wysłaniu może oznaczać naliczenie kosztu. Taka
próba zachowuje rezerwację na interwał i dowody wysyłki, więc restart
jej nie ponowi. Brak workera przed wysłaniem pozwala odroczyć próbę.
Settings → Memory pokazuje poprzedni i następny przebieg oraz próby,
zgłoszone tokeny i dostępny koszt z ostatnich 30 dni. Raporty dostawcy
liczą się również w kategorii Other generation w [Usage](usage.md).

### Kontekst agenta

Gateway wybiera reguły lokalnie według tematu zadania i przypięcia
w projekcie. Na przykład „Popraw ten przycisk” może dobrać regułę o
zrzucie. Pierwszeństwo mają bieżące polecenie właściciela i uprawnienia
tury. Nawyki pozostają w zakresie projektu. Zakres obejmujący wiele
projektów jest osobnym rozszerzeniem.

Automatyczny blok zawiera do 8 reguł. Całość z nagłówkiem ma limit
500 szacowanych tokenów i 1500 bajtów UTF-8. Przy braku dopasowania
gateway pomija blok. Pozostałe notatki są dostępne przez `memory_search`.

Worker z capability `memory_habits_v1` dostaje opcjonalny blok
`StartTurn.habit_context`. Oś czasu Canopy pokazuje oryginalną wiadomość
właściciela. Gateway zapisuje rezerwację raz na wątek przed dostarczeniem.
Kolejna tura, ponowienie komendy i zimne wznowienie nie dopisują kopii.
Przerwanie po zapisie rezerwacji może pominąć blok. Fork tej samej rodziny
może odziedziczyć wcześniej wysłaną wiadomość. Gateway pomija nowe
automatyczne bloki w forkach, delegacjach, scratch i rozmowach botów.

Edycja lub usunięcie zmienia wybór dla kolejnych wątków. Reguła wysłana
wcześniej może pozostać w historii dostawcy i dalej zajmować miejsce w
kontekście. Następna tura właściciela w oznaczonym wątku dostaje jedno
krótkie odwołanie, jeśli blok utracił ważność. W odziedziczonej historii
forka obowiązuje cykl życia jego transkryptu.
[Kontrakt workera](protocol.md#szyna-agentów)
