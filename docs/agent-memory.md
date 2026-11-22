# Pamięć agentów i botów

Status (2026-11-22): zaimplementowana pamięć gatewaya dla wątków i botów oraz
Settings → Memory w webie, desktopie i aplikacji mobilnej. Dostępność zależy od
[promocji wydania](release.md).

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
wymiany bot–bot używają odrębnego kontekstu wykonania.

Delegowane wątki używają zakresu odbiorców ustalonego przez gateway. Węższa
delegacja dziedziczy ten zakres w kolejnych wątkach i korzysta z odpowiednio
ograniczonej historii. Wersje gatewayów obsługujących połączone komputery
muszą umieć przekazać i egzekwować uprawnienia delegowanej pracy. Bardzo stare
gatewaye używały zwykłych tras UI właściciela do części automatycznych odczytów.
Pełne rozróżnienie tych odczytów wymaga aktualizacji gatewaya źródłowego.

## Edycja i usuwanie

W **Settings → Memory** można filtrować listę według zakresu, otworzyć pełną
treść, zmienić tytuł, treść, aliasy i przypięcie oraz trwale usunąć notatkę
po potwierdzeniu. Operacje sprawdzają rewizję otwartej wersji. Konflikt
wymaga odczytania aktualnego wpisu przed ponownym zapisem.

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
