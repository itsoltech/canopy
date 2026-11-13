# Zakładki wątku i moduł plików

Status: **projekt v2 po decyzji o układzie; bez implementacji**. Zakładki w jednym
rzędzie nagłówka, pasek ikon z jednym panelem oraz podsumowanie zależne od zajęcia
panelu wynikają z decyzji użytkownika. Pozostałe pytania są w §11. Dokument nie
zmienia działającego API, ustawień ani wyglądu klientów i nie zatwierdza implementacji.

Cel: czytać i edytować pliki obok kontekstu wątku bez wielokrotnego otwierania modala.
Priorytet: otwarcie wątku, pisanie i streaming nie płacą za nieotwarte moduły.
Zakładki dotyczą **jednego wątku**, nie całej aplikacji ani wielu wątków naraz.
Nie zmieniamy znaczenia workspace'u: nadal jest katalogiem projektu na workerze.

Punkty oparcia: [architektura](architecture.md), [UI API](ui-api.md#pliki-wątku),
[protokół plików](protocol.md#folder-i-pliki-wątku), [pull requests](github.md),
[połączone komputery](linked-computers.md), [mobile](mobile.md),
[skala UI](ui-scale.md), [copy](copy.md) i [pomiary](client-performance.md).

## 1. Stan obecny i granice projektu

`features/files/FileViewer.svelte` otwiera jeden plik w modalu. Czyta przez
`ReadThreadFile`, edytuje przez `WriteThreadFile`, usuwa przez `DeleteThreadFile`
i otwiera lokalną aplikację przez `OpenThreadFile`. Podświetlanie składni i leniwie
ładowany edytor już istnieją. Odczyt ma limit 2 MiB, a UI pozwala edytować do 400 KiB.
Gateway dopuszcza większy zapis, ale webowy limit body 512 KiB wymaga sprawdzania
również rozmiaru **zakodowanego JSON**, nie tylko bajtów tekstu. Zapis i usunięcie
używają SHA-256 odczytu. Rozstrzyganie gołych nazw, obrazy, wybór niejednoznacznej
ścieżki i routing do domu wątku są już wspólne z mobile.

`ThreadPanel` łączy położenie, connectory, PR, zadania w tle, harmonogramy, metadane
sekretów i drzewo wątków. Na szerokim ekranie dzieli prawą kolumnę z panelem PR;
poniżej `xl` szczegóły i PR otwierają arkusze. Mobile ma szczegóły i osobny ekran PR.
`GetThreadPanel` dostarcza bezpieczne metadane i granty, nie poświadczenia.

Wspólny parser `packages/domain/src/file-references.ts` rozpoznaje `:31` i `:31:4`,
ale usuwa pozycję przed otwarciem; fragment linku także nie dociera do viewera.
Obsługa zakresów i skok do linii są więc nową funkcją. Obecny webowy highlighter
ładuje gramatyki leniwie, ale tokenizuje na głównym wątku; przeniesienie pracy
do osobnego wykonawcy również wymaga zmiany. Mobile obecnie pokazuje kod bez kolorów.

Poza zakresem: terminal, language server, uruchamianie kodu, automatyczny zapis,
tworzenie i przenoszenie plików, pełny edytor projektu, synchronizacja szkiców,
replikacja zawartości dysku i przeglądanie całego komputera. Kontrakt rejestracji
modułów jest wewnętrzny, bez ładowania zewnętrznych rozszerzeń.

## 2. Ustalony układ v2

Jedna samodzielna makieta poza repozytorium zastępuje porównanie wariantów.
Pokazuje jasną i ciemną paletę Birch oraz desktop, wąskie okno i telefon, w każdym
przypadku: brak modułu, Files z zamkniętym podsumowaniem i Files z otwartym
podsumowaniem. Na małych szerokościach podsumowanie jest arkuszem. Dane są
przykładowe; materiał nie jest dowodem działania funkcji.

### Jeden rząd nagłówka i przepełnienie

Kolejność: **sygnet/avatar projektu → tytuł wątku → zakładki → `+` → przełącznik
zakładek → kontrolki podsumowania i panelu**. Nie pokazujemy nazwy projektu ani
osobnego rzędu zakładek. Sygnet ma dostępną nazwę projektu i tooltip, tytuł pełną
nazwę w tooltipie oraz dostępną akcję zmiany tytułu. Nagłówek ma wysokość istniejącego
headera (3 rem przy standardowym rozmiarze); obszary przeciągania okna i kontrolki
systemowe desktopu mają odrębne, zarezerwowane miejsce. Zakładki nie są drag region.

Tytuł ma `min-width: 0`, ellipsis i maks. `min(14rem, 22%)` szerokości głównego
obszaru; podczas braku miejsca kurczy się przed zakładką aktywną. Zakładki mają
etykiety do 14 rem, stały slot dirty/close i pełną ścieżkę w tooltipie/menu.
`Thread` pozostaje pierwszą przypiętą kartą modelu, nie musi stale zajmować miejsca
na ekranie, gdy aktywny jest plik. Niezmienny przycisk `Switch tab` z liczbą kart
obejmuje wszystkie karty, ich kolejność i dirty, także te ukryte.

Pas zakładek nie zawija się ani nie poszerza aplikacji. W pierwszej kolejności
pokazuje aktywną kartę i najbliższe karty mieszczące się w reszcie miejsca; pozostałe
są w przełączniku. Aktywna nigdy nie trafia wyłącznie do overflow: zmiana karty,
resize i zamknięcie przeliczają widoczny wycinek bez zmiany kolejności modelu.
Menu i roving tabindex obejmują widoczne nagłówki, a wybór z przełącznika przenosi
fokus do nowego aktywnego nagłówka. Przy zbyt małej przestrzeni cały pas zastępuje
jeden przycisk aktywnej karty z licznikiem i chevronem, w tym samym rzędzie.
Na telefonie tytuł pozostaje skrócony, a nazwa aktywnej karty także ma ellipsis;
pełne obie nazwy są w arkuszach. `+`, summary i moduły zachowują zarezerwowane cele
dotykowe. Przy dużej skali tekstu tytuł może skurczyć się wizualnie do sygnetu,
zachowując dostępną nazwę. Nie dokładamy drugiego rzędu ani poziomego scrolla strony.

`+` w głównym nagłówku otwiera `Open module` **w pełnej zakładce**, np. wybrany PR.
Nie jest akcją tworzenia wątku ani pliku. Wybór pliku z drzewa otwiera kartę obok
`Thread`; aktywacja modułu w panelu nie zmienia aktywnej karty.

### Architektura informacji

Lewy sidebar nadal służy projektom, wątkom i botom. Zakładki w nagłówku wybierają
**główną treść**. Prawy pasek ikon wybiera **pomocniczy moduł**, jeden naraz.
Gdy żadnego nie wybrano, prawa kolumna pokazuje **podsumowanie wątku**.

| Dzisiaj | Docelowe miejsce | Tryb minimalny → pełna zakładka |
| --- | --- | --- |
| Wiadomości i composer | Pierwsza zakładka `Thread` | Bez kopii w sidebarze; szkic, kolejka i oczekujące interakcje pozostają przy rozmowie |
| Komputer, Open in, Directory/Worktree, Branch, PR, Changes, fork, lineage i subagenci | `Thread details`: dokowane lub pływające według stanu panelu | Krótki kontekst, kopiowanie, istniejące akcje otwierania i picker gałęzi; bez osobnej pełnej zakładki |
| Lista PR pod Branch i pełny panel PR | Moduł `Pull requests` | Lista powiązań, stan i checki → jeden PR z Summary/Timeline/Code i wszystkimi obecnymi akcjami |
| Nowe drzewo katalogu | Moduł `Files` | Drzewo i wyszukiwanie → pełny eksplorator; wybrany plik otwiera osobną zakładkę |
| Connectory | Moduł `Connectors` | Dostępne konta i granty workera → szczegóły dostępu; administracja kontem nadal w Settings |
| Zadania w tle i harmonogramy | Moduł `Tasks` z oddzielnymi grupami | Aktywne zadania i najbliższe terminy → wynik wskazanego zadania lub lista harmonogramów |
| Cel, kolejka, prośby o zgodę i sekret | Obecny zasobnik rozmowy; lineage/subagenci również w podsumowaniu | Nie chowamy oczekujących odpowiedzi w module; metadane zapisanych sekretów przez istniejący arkusz |

Zmiana grantu connectora nadal dotyczy **workera i wszystkich jego wątków**;
przeniesienie kontrolki nie zawęża tego skutku. `Tasks` nie utożsamia zadania
w tle z harmonogramem. Zatrzymanie, anulowanie i zarządzanie worktree zachowują
istniejące potwierdzenia i autoryzację. Szczegóły nie powtarzają modelu,
uprawnień, kosztu ani statusu już obecnego przy composerze i w nagłówku.

Krótki wiersz PR/Changes w podsumowaniu jest linkiem do pełnego zasobu, nie drugą
listą modułu. Lineage i subagenci pokazują stan i przejście do rozmowy; oczekujące
interakcje nadal mają sygnalizację w `Thread`. Jedno query dostarcza wspólne metadane.

### Podsumowanie zależne od panelu

| Stan szerokiego okna | Prawa kolumna | Podsumowanie |
| --- | --- | --- |
| Żaden moduł nie zajmuje panelu | Dokowane `Thread details`, widoczne domyślnie | Zajmuje normalną kolumnę; niczego nie przykrywa |
| Files/PR/inny moduł zajmuje panel | Minimalny widok modułu + pasek ikon | Karta pływająca domyślnie zamknięta, przełączana ikoną podsumowania w głównym nagłówku |
| Ponowne kliknięcie aktywnej ikony albo `Close module` | Moduł oddaje panel; wraca dokowane `Thread details` | Otwarta karta pływająca znika; podsumowanie widoczne w doku |
| Panel ręcznie zwinięty | Pozostaje pasek ikon; wybrany moduł zachowuje tożsamość | Podsumowanie dostępne pod ikoną, bez automatycznego otwarcia karty |

Zajęcie panelu dotyczy minimalnego modułu, nie kart głównych: otwarty plik lub PR
w zakładce sam nie usuwa podsumowania z doku. Zmiana modułu zamyka kartę pływającą.
Otwieranie jej jest przejściowe i nie zapisuje się w preferencjach. `activeModuleId`
i zwinięcie panelu zapisujemy lokalnie; przy pierwszym wejściu brak modułu i otwarty
dok. Wyłączenie modułu resetuje zwinięcie i pokazuje dok; świadome zwinięcie samego
doku może go schować do ponownego użycia kontrolki panelu. Ikona podsumowania przy
braku modułu przywraca/fokusuje dok, a gdy zajmuje go moduł — przełącza kartę.

Karta jest niemodalna, zakotwiczona w **prawym górnym rogu głównej treści**, po
lewej od panelu i poniżej nagłówka, z insetem 8 px. Nie jest swobodnie przeciągana
ani przypinana nad treścią. Ma szerokość do 20 rem, wysokość do dostępnej przestrzeni
i wewnętrzny scroll. Escape, `Close thread details` i kliknięcie poza zamykają kartę;
Escape/close przywraca fokus ikonie, kliknięcie poza zachowuje fokus klikniętego celu.
Otwarty picker wewnątrz ma pierwszeństwo Escape. Zdarzenie agenta nie otwiera karty.
Powrót z arkusza po resize nigdy nie otwiera jej automatycznie.

### Nagłówek prawego panelu

Ten sam rząd ma aktywny **chip przypominający zakładkę**, przyległe `+`,
`Open in tab` (ikona maksymalizacji) i `Collapse panel`. Chip zawiera ikonę i
etykietę `Files`/`Pull requests`/`Tasks`/`Connectors`, ellipsis oraz menu zmiany
modułu i `Close module`. To jeden aktywny moduł, bez kolejnego trwałego zestawu kart.
`+` tutaj otwiera `Open sidebar module` i **zastępuje minimalny moduł**; nie tworzy
karty głównej. Różnica obu `+` wynika z miejsca, etykiety dostępnej i tooltipu.

Maksymalizacja otwiera/aktywuje pełną kartę tego zasobu, zachowując minimalny panel
i współdzieląc dane. Nie zmienia szerokości kolumny na cały ekran. `Collapse panel`
chowa powierzchnię bez wyłączenia modułu; przycisk w głównym nagłówku `Show panel`
przywraca ją. Aktywna ikona modułu wyłącza moduł i dokuje podsumowanie nawet po
zwinięciu. Przy braku modułu chip nazywa się `Thread details`, maksymalizacji nie
ma (slot jest zarezerwowany), a `+` nadal wybiera moduł. Kontrolki mają stałe sloty,
więc długa nazwa i zmiana stanu nie przesuwają przycisków. Na małej szerokości ten
sam nagłówek występuje w arkuszu modułu; zamiast collapse ma zamknięcie arkusza.

## 3. Model zakładek i stan urządzenia

### Tożsamość, otwieranie i zamykanie

Pierwsza zakładka ma angielską etykietę `Thread`: jest stale przypięta na pozycji 1,
bez zamknięcia i przestawiania. W dokumentacji „rozmowa” opisuje jej zawartość;
w UI używamy słowa `thread` zgodnie ze słownikiem. `+` otwiera kompaktowy picker
`Open module`. Moduł może mieć kilka zasobów, np. różne PR lub pliki.

Klucz zakładki pliku zawiera zakres klienta, kwalifikowane id wątku, tożsamość
korzenia i kanoniczną ścieżkę zwróconą przez worker. Goła nazwa jest najpierw
tymczasowym żądaniem rozstrzygnięcia. Dwa linki do tego samego pliku nie tworzą
duplikatów; po rozstrzygnięciu łączymy je, zachowując szkic i nowy cel linii.
Nie normalizujemy wielkości liter ścieżek na kliencie. Moduły używają własnego
stabilnego klucza zasobu; sam numer PR lub nazwa pliku nie wystarcza.

Jedno kliknięcie pliku w drzewie lub linku wiadomości otwiera **jedną zakładkę
podglądu na wątek**. Jej etykieta jest pochylona, a dostępna nazwa zawiera `Preview`.
Następny wybór zastępuje wyłącznie czysty podgląd; stary odczyt jest anulowany.
Dwuklik, `Keep tab`, świadome przesunięcie zakładki lub wejście w `Edit` utrwala ją.
Na dotyku `Keep tab` jest widoczną akcją w menu, bez zależności od dwukliku.
PR i inne pełne moduły otwierane przez `+` są od razu utrwalone.

Utrwalenie chroni przed zastąpieniem podglądem, nie przed ręcznym zamknięciem.
Zakładki poza pierwszą można zamknąć i przestawić przeciąganiem lub `Move left` /
`Move right`. Zamknięcie aktywnej wybiera ostatnią aktywną spośród pozostałych,
a bez niej `Thread`. Menu oferuje `Close tab`, `Close other tabs` i `Close saved tabs`;
ostatnia akcja pomija zakładki ze szkicami. Zamknięcie karty PR nie usuwa powiązania.

### Dirty, konflikt i przerwanie pracy

Pierwsza edycja utrwala zakładkę. Stały slot po prawej mieści kropkę dirty albo
zamknięcie; zmiana stanu nie przesuwa etykiet. Dostępna nazwa zawiera
`Unsaved changes`; znaczenie nie zależy od koloru. Brak autosave.
`Save` zapisuje jawnie z hashem odczytu, a `Reload` nigdy nie usuwa szkicu bez zgody.

Przełączenie zakładki ani wątku nie porzuca szkicu. Zamknięcie dirty, zbiorcze
zamknięcie lub wyjście z połączenia pokazuje listę dotkniętych plików i
`Save changes` / `Discard changes` / `Keep editing`. Nieudany zapis pozostawia
dialog i treść. Usunięty plik pozostawia otwartą zakładkę ze szkicem i komunikatem;
nie odtwarzamy go automatycznie. Zewnętrzna zmiana oznacza `Changed on disk`;
porównanie i kopiowanie szkicu są dostępne bez nadpisania dysku.

Szkice plików w v1 pozostają wyłącznie w pamięci urządzenia, oddzielnie od
transkryptu. Nie zapisujemy kodu do localStorage, dyskowego cache historii ani
telemetrii. Web używa natywnego ostrzeżenia przed zamknięciem dokumentu, desktop
własnego close guardu. System może zakończyć mobile bez możliwości potwierdzenia:
restart procesu traci niezapisany szkic. To jawne ograniczenie v1; trwałe odzyskiwanie
wymaga osobnego projektu ochrony lokalnych danych. Tło aplikacji nie oznacza discard.

### Limity i zwalnianie pamięci

| Zasób | Proponowany limit i zachowanie |
| --- | --- |
| Zakładki na wątek | 12 łącznie z `Thread` i pojedynczym podglądem, tak samo na telefonie; przy limicie picker wskazuje kartę do zamknięcia, bez cichego usuwania utrwalonych kart |
| Zapamiętane układy | LRU 30 wątków na zakres urządzenia, do 256 KiB metadanych; przechowuje etykiety/id, kolejność, aktywną kartę, rozwinięcia i kotwice, bez treści |
| Czyste treści | Dodatkowy LRU do 16 MiB web/desktop, 8 MiB mobile; najwyżej 4/2 rozgrzane widoki, pozostałe to metadane do ponownego odczytu |
| Edytory i szkice | Jeden aktywny edytor; do 4 MiB baz i szkiców na klienta, liczonych łącznie we wszystkich odwiedzonych wątkach; po limicie trzeba zapisać lub porzucić wskazany szkic |
| Drzewo i tokeny | Osobne LRU: drzewo 2 MiB web / 1 MiB mobile; tokeny 4 MiB / 2 MiB; przekroczenie usuwa nieobserwowane czyste wpisy, nigdy szkic |

Limity treści mierzymy w bajtach UTF-8 baz i szkiców; nie udają limitu całego heapu.
Nie dublujemy stringów bazowych pomiędzy zakładką, edytorem i cache. Nieaktywny
edytor zachowuje model dokumentu/undo w ramach budżetu, ale oddaje DOM i obserwatory.
Odtworzenie z samych metadanych nie obiecuje historii undo. Stan dirty jest zawsze
przypięty w pamięci i nie podlega LRU. Limit 12 kart nie oznacza 12 działających edytorów.

Rozmowa bieżącego wątku zachowuje zamontowany composer i stan kotwicy, ale ukryty
feed jest `inert`, bez timerów, animacji i pracy layoutu. Istnieje jeden `WatchThread`
dla bieżącego wątku, nie jeden na zakładkę. W trakcie oglądania pliku pracę agenta
sygnalizuje stały slot zakładki `Thread`. Oczekujące pytanie lub zgoda dodają licznik
i akcję `Open thread`; nie przełączają samoczynnie i nie kradną fokusu edytora.

### Lokalność i adresy

**Stan widoku jest per urządzenie, nie synchronizuje się.** Nie dodajemy pól
zakładek do `UserSettings`, snapshotów ani wspólnej konfiguracji linked computers.
Web/desktop rozszerzają istniejące `DevicePreferences` / `domain/device-view`,
w zakresie `clientPreferencesScope` i właściciela. Mobile używa istniejącego pliku
preferencji w zakresie parowania i pinu. Dwa urządzenia zaczynają z własnym układem.
Po utracie storage pozostaje działająca sesja i informacja o braku zapisu preferencji.

Wiele okien na jednym urządzeniu nie przejmuje sobie aktywnej zakładki: zapisane
metadane są bazą przy nowym otwarciu, a bieżąca sesja nie stosuje cudzych zdarzeń
storage do fokusu. Odtwarzamy najwyżej aktywny moduł; nie uruchamiamy wszystkich
odczytów po starcie. Zmiana konta/połączenia czyści wykonawców i cache treści.
Unpair, unlink i odmowa uprawnień usuwają metadane i treści danego zakresu.

Istniejący adres `?pr=…` otwiera kartę PR i jest ważniejszy niż zapisany aktywny widok.
Jawna akcja `Copy file link` może kodować id wątku, ścieżkę względną i zakres linii;
nie publikuje układu kart ani absolutnej ścieżki komputera. Adres nie przyznaje praw.
Nie zmieniamy URL przy każdym kliknięciu karty; historia Wstecz zachowuje nawigację
do wątku i świadomie otwartych linków, bez dziesiątek wpisów po przeglądaniu drzewa.

### Klawiatura i dostępność

Nowe komendy trafiają do wspólnego `@canopy/ui/keybindings` i istniejącej palety.
Dodajemy konteksty workspace/file oraz wykrywanie kolizji; obecne `Mod+K`, `Mod+B`,
`Mod+Shift+O`, skróty modeli i cytowania zachowują znaczenie. Nie przechwytujemy
`Mod+W`, `Mod+T`, `Mod+1…9` ani `Ctrl+Tab` przeglądarki.

| Akcja | Proponowany skrót / dostępna alternatywa |
| --- | --- |
| Wybór zakładki | Left/Right, Home/End w `tablist`; Enter/Space aktywuje, bez uruchamiania odczytu samym fokusem |
| Następna/poprzednia karta | `Alt+PageDown` / `Alt+PageUp` poza polem tekstowym; picker `Switch tab` jako alternatywa systemowa |
| Zamknięcie | Delete przy fokusie nagłówka karty; menu i paleta dla reszty, dirty guard zawsze działa |
| Zapis i linia | `Mod+S` tylko w edycji; `Mod+G` tylko przy fokusie viewera/edytora, otwiera `Go to line` |
| Moduły i szczegóły | `+`, `Open module`, `Toggle thread details` w palecie; Escape zamyka najwyższą nakładkę i wraca do wyzwalacza |

Przestawianie kart ma akcje menu bez gestu; drzewo ma semantykę tree/treeitem,
strzałki, Home/End i ogłaszanie rozwinięcia. Wirtualizacja utrzymuje fokusowany
wiersz w oknie. Zakładki mają `aria-controls`, `aria-selected` i roving tabindex;
przy zamknięciu fokus przechodzi na wybraną kartę. Numery linii nie wchodzą do
kopiowanego kodu. Cel linku ogłaszamy raz, np. `Lines 31–40`, bez ogłaszania każdej linii.

## 4. Rejestracja i cykl życia modułów

Jedna typowana, statyczna mapa definicji współdzieli id, etykietę, ikonę,
obsługiwane tryby, capability i regułę tożsamości zasobu. Web oraz mobile mają
własne fabryki widoków, ale tę samą semantykę komend i serializowanych metadanych.
Definicja nie zawiera frameworkowych komponentów w pakiecie domeny.

| Część definicji | Kontrakt |
| --- | --- |
| Identyfikacja | `id`, etykieta, `IconName`, parser typu zasobu i `resourceKey`; rozróżnienie modułu jednego na wątek od kart poszczególnych zasobów |
| Dostępność | `supports(context)` na capability gatewaya, domu i workera; przy braku funkcji znany powód zamiast pustego panelu |
| Tryby | Leniwe `loadCompact` i `loadFull`; jawne `Open in tab` z minimalnego widoku; Files ma także osobny rodzaj karty pliku |
| Stan i dane | Wersjonowane metadane widoku, shared query po owner/home/thread/resource, obsługa dirty i close guard; treść poza zapisanym stanem widoku |
| Żywotność | `activate`, `deactivate`, `dispose`, AbortSignal; ukrycie zwalnia subskrypcje i timer, dispose usuwa zasoby; wyjątek stanowi jeden wspólny watch bieżącego wątku |

Rejestr niczego nie pobiera przy imporcie. Pasek ikon i picker czytają wyłącznie
lekkie definicje. Minimalny panel i pełna karta współdzielą query i wynik w toku;
nie montują dwóch pollerów PR ani dwóch `GetThreadPanel`. Pełny panel PR zachowuje
wewnętrzne Summary/Timeline/Code; nie stają się osobnymi zakładkami workspace'u.
Równocześnie widoczny kompakt i pełna karta używają jednej dzierżawy odczytu.

Proponowane granice web: `ThreadWorkspace`, `WorkspaceTabs`, `ModuleRail`,
`ModuleHost`, `ThreadDetailsContent` w `ThreadDetailsDock`/`ThreadDetailsPopover`
lub arkuszu; w Files: `DirectoryTree`, `FileTab`,
`FileToolbar`, `FileViewport`, adapter edytora. Reużywamy `PanelRow`, `PanelField`,
`Popover`, `Dialog`, `DropdownMenu`, `ResizeHandle`, wirtualizatora i tokenów kodu.
Mobile ma analogiczne hosty z `Sheet`, `FlatList`, natywnym edytorem i istniejącym
transportem Connect. Nie kopiujemy całego `ThreadPanel` do każdego modułu.

## 5. Moduł Files

### Korzeń, drzewo i stan Git

Domyślny korzeń to **rzeczywisty `threads.cwd`**. W osobnym worktree pokazujemy
worktree, nie główny checkout. Nazwa komputera i względny breadcrumb są dostępne
w Files; pełną ścieżkę można skopiować. Moduł komputera nie daje dostępu do całego
dysku. Inny workspace lub worktree wymaga istniejącego wątku z właściwym zakresem,
a przyszły eksplorator komputera osobnej decyzji i autoryzacji.

Pierwsze otwarcie czyta tylko bezpośrednie dzieci korzenia. Rozwinięcie katalogu
czyta jedną stronę jego dzieci; brak rekurencyjnego prefetch. Spłaszczone rozwinięte
wiersze są wirtualizowane: widoczne plus najwyżej po 10 z każdej strony, łącznie
do 120 web / 80 mobile. Długi katalog ma `Load more`, nie tysiące ukrytych węzłów.
Zwinięcie anuluje niezakończony odczyt nieużywany przez innego odbiorcę.

Sortujemy katalogi przed plikami, po nazwie, **w obrębie wczytanych wpisów**.
Nie obiecujemy globalnego sortowania jeszcze nieodczytanego katalogu. Kolejne
strony zachowują kotwicę po ścieżce. Worker używa ograniczonego iteratora katalogu,
nie pełnego `readdir`/rekurencyjnego manifestu dla uzyskania sortowania. Kursor
wygasa, gdy enumeracja traci spójność; wtedy odnawiamy tylko widoczne strony.

`SearchFiles` pozostaje szybkim fuzzy pickerem ścieżek, nie substytutem drzewa
i nie wyszukiwaniem treści. Pokazujemy jego obecne limity i niepełność. Ukryte
i ignorowane katalogi są domyślnie zwinięte/pominięte; jawny przełącznik `Show ignored files`
dotyczy tylko listowania na żądanie. Symlink ma osobny typ; nie rozwijamy go rekurencyjnie.

Git status: M/A/D/R/U/? z dostępną etykietą, kolor jedynie pomocniczy. Czyste pliki
mają zwykły tekst; ignorowane są stonowane. Obie strony rename mają ścieżkę,
a usunięty plik jest wirtualnym, nieotwieralnym wpisem statusu do najbliższej
rewalidacji. Status katalogu jest agregatem z ograniczonego zapytania Git;
brak pełnych danych to `Status unavailable`, nie „clean”. Nie wykonujemy
`git status` osobno dla każdego pliku. Bez repo drzewo nadal działa.

### Odczyt, edycja i koszty podświetlania

Zachowujemy limit odczytu **2 MiB**, edycji **400 KiB** i wyłączony zapis/usunięcie
przy `truncated` albo pustym hashu. Sprawdzamy również limit nowej treści oraz
rozmiar body protobuf JSON przed wysłaniem; rozmiar po base64/escapowaniu może być
większy. Brak podnoszenia limitów BFF w ramach nowego layoutu.

Viewer tekstowy wirtualizuje linie z małym overscanem. Najpierw pokazuje zwykły
tekst, potem tokeny w tych samych wymiarach. Plik powyżej 200 KiB, 10 000 linii
lub z linią ponad 2 000 znaków domyślnie używa zwykłego tekstu; nie uruchamiamy
nieograniczonej tokenizacji. `Enable highlighting` dotyczy tylko dostępnego okna,
z limitem pracy; nie zwiększa limitu odczytu. Nieznany język pozostaje czytelny.

Web/desktop: jeden leniwy Web Worker z obecnym silnikiem JavaScript, gramatyki według
rozszerzenia i tokeny `--code-*`. Nie przenosimy runtime'u highlightera do początkowego
bundla wątku. Zadania zawierają rewizję dokumentu i id żądania; stare wyniki są
odrzucane. Tokenizacja zachowuje stan gramatyki między ograniczonymi fragmentami,
bo linia wewnątrz komentarza wieloliniowego wymaga wcześniejszego kontekstu.
Bez checkpointu najpierw zwykły tekst; nie skanujemy synchronicznie całego prefiksu.
Zadanie przekraczające 100 ms jest anulowane, a worker może zostać odtworzony.

Edytor pozostaje leniwy. Adapter edytora stosuje dekoracje tokenów z tego
samego wykonawcy, bez drugiego pełnego parsera synchronicznego na głównym wątku.
Wpisanie znaku natychmiast aktualizuje tekst/undo; dekoracje dochodzą po krótkim
debounce, ze sprawdzeniem rewizji. Nie przesyłamy całej treści na każdy znak.
Wirtualizację, IME, selekcję, Tab i undo trzeba zweryfikować przed uznaniem
tego adaptera za gotowy; istniejąca konfiguracja edytora tego jeszcze nie zapewnia.

Mobile: natywny viewer renderuje okna tokenów semantycznych, bez osadzania HTML.
Proponowane ograniczone RPC tokenizacji opisuje §6: pracę wykonuje osobny wykonawca
workera komputera, a telefon mapuje role na paletę. Nie wysyła kodu do dostawcy LLM.
Przed kolorami i przy niedostępnej tokenizacji tekst pozostaje widoczny.
W v1 edycja pozostaje natywnym `TextInput` z kolorowanym **podglądem** wybieranym
przez `Preview changes`; bez kolorowania podczas samego pisania. To świadoma
różnica prezentacji względem desktopu, **do zatwierdzenia przez użytkownika**.
Otwieranie, edycja, zapis, konflikt, linie, zakresy i drzewo mają pełny parytet.
Jeśli wymagane są kolory podczas pisania także na telefonie, osobny edytor mobilny
i jego pomiary stają się warunkiem realizacji, a szacunek z §10 wymaga zmiany.

### Binaria, obrazy i duże pliki

Rastrowe PNG/JPEG/WebP/GIF/AVIF tylko po sniffingu typu i sprawdzeniu rozmiaru,
z wymiarami i rozmiarem w stopce. Limit dekodowania: 16 megapikseli i jedna aktywna
bitmapa; nie animujemy GIF w tle. Przekroczenie daje metadane i instrukcję
otwarcia na komputerze wątku, bez próby dekodowania. Zwalniamy object URL i bitmapę
przy dezaktywacji. Dla SVG i HTML pokazujemy źródło, nigdy aktywny dokument.
Archiwa, PDF i inne binaria mają stan metadanych, bez Edit i bez automatycznego
pobierania zasobów. Nie rozszerzamy podglądu do przeglądarki dokumentów.

Tekst ponad 2 MiB ma jawny napis `Showing the first 2 MB` i pozostaje read-only.
Cel linii poza odczytanym prefiksem nie udaje sukcesu: `This line is outside the preview.`
z akcją `Go to line` w dostępnym zakresie. Odczyt dowolnego okna wielkiego pliku,
pełne pobieranie i nowy indeks linii pozostają poza v1, zamiast skanować gigabajty
dla jednego linku. Lokalne `Open in default app` działa tylko przy istniejącym
`onThisComputer`; nigdy nie otwiera aplikacji na odległym komputerze.

### Linie, zakresy i ponowne otwarcie

Wspólny parser zwraca `{ path, startLine?, endLine?, column? }`. Akceptuje
`path:31`, `path:31:4`, `path:31-40`, `path#L31`, `path#L31-L40` i `path#L31-40`
w inline code i lokalnym linku Markdown. Nie zmienia obsługi URL HTTP(S).
Litera dysku w ścieżce nie jest numerem linii. Procentowe kodowanie dekodujemy raz;
NUL, próby wyjścia poza korzeń i nieprawidłowe URI są odrzucane na granicy API.
Nieprawidłowa/odwrócona pozycja otwiera plik z informacją i `Go to line`, bez
odejmowania 1 od niezweryfikowanej wartości. Numeracja jest od 1, zakres jest domknięty.

Po otwarciu przewijamy pierwszy wskazany wiersz pod toolbar, z kontekstem kilku
linii. Zakres ma stonowane tło i znak w gutterze; zostaje do nowego celu lub
`Clear line highlight`, bez pulsowania i bez zmiany szerokości tekstu. Ponowne
otwarcie tej samej karty zmienia tylko cel; zachowuje edycję, undo i dirty.
W dirty pliku pokazujemy `Line numbers refer to the saved file` i najbliższy
zmapowany wiersz; nie twierdzimy, że zmieniony kod nadal odpowiada źródłowemu linkowi.

`Go to line` przyjmuje `31`, `31:4` lub `31-40`, ma walidację zakresu dostępnego
tekstu i pole 16 px na telefonie. Poza EOF informuje o liczbie linii i proponuje
ostatnią, zamiast po cichu podmieniać cel. W Markdown link do linii wybiera Source,
bo Rendered nie ma stabilnych numerów źródła. Zawijanie nie zmienia numeracji.

### Konflikty i niedostępność

`expected_sha256` z ostatniego pełnego odczytu pozostaje warunkiem zapisu/usunięcia.
Zdarzenie zmiany pliku oznacza bazę jako nieaktualną, ale jej nie zastępuje podczas
edycji. Konflikt zachowuje tekst, oferuje `Compare changes`, `Copy changes` oraz
`Discard and reload` z potwierdzeniem. Nie ma automatycznego force overwrite.
Konflikt ma typowany kod domenowy, nie rozpoznawanie po angielskiej treści błędu.

Obecny worker porównuje hash przed zapisem; nie jest to atomowy filesystem CAS
wobec dowolnego zewnętrznego procesu. Implementacja serializuje własne mutacje
per ścieżka i ponawia kontrolę przy zapisie. Nie obiecujemy pełnej ochrony przed
równoczesnym zapisem obcego programu. Niepewny wynik sieciowy wymaga odczytu
i porównania; automatyczny replay zapisu/usunięcia jest wykluczony.

Kwalifikowane id trafia istniejącą trasą do domu, tam do właściwego workera.
Offline pozostawia widoczne wcześniej odczytane treści w pamięci, oznaczone jako
ostatni odczyt; nie udaje dostępu do dysku. Nowy plik pokazuje
`Available when {computer} is connected`. Można zachować lokalny szkic, lecz Save,
Delete i zmiana gałęzi są wyłączone. Reconnect rewaliduje tylko aktywny plik
i widoczne katalogi; nie zapisuje automatycznie. Usunięty/przeniesiony worktree
ma osobny stan, nie błąd „file not found”. Zmiana korzenia lub domu unieważnia
klucze kart; szkic starej lokalizacji pozostaje do skopiowania i nigdy nie zapisuje
się do nowego korzenia samoczynnie. Przełączenie gałęzi wymaga najpierw rozstrzygnięcia
szkiców tego checkoutu i ponownej kontroli aktywności w gatewayu.

## 6. Kontrakty: reużycie i addytywne rozszerzenia

Poniższe nazwy nowych RPC/pól są propozycją. Numery należy przydzielić z wolnego
zakresu dopiero w implementacji. Nie renumerujemy istniejących pól, nie zmieniamy
ich znaczenia, nie dotykamy `proto/canopy/update/v1`. Capability zachowują
`WORKER_LINK_PROTOCOL = 1`, jeśli implementacja potwierdzi zgodność addytywną.
Każdy PR proto generuje kontrakty i zapewnia czyste `gen:check`.

### Istniejące ścieżki

| Potrzeba | Reużycie |
| --- | --- |
| Plik i rozstrzygnięcie ścieżki | `ReadThreadFile(ThreadFileRequest)` → `ReadFile(FileRequest)`; zachować `item_id`, `resolution`, `matches`, `search_incomplete`, hash i binaria |
| Edycja/usunięcie/aplikacja | `WriteThreadFile`, `DeleteThreadFile`, `OpenThreadFile`; żadnych nowych równoległych CRUD RPC |
| Szybkie otwarcie | `SearchFiles` z istniejącym scope wątku; linia jest stanem widoku, nie nowym RPC odczytu |
| PR, connectory i zadania | Obecne metody PR, `GetThreadPanel`, `SetThreadConnectorGrant`, harmonogramy i `WatchThread`; bez nowego ogólnego snapshotu workspace'u |
| Wybór workspace'u | Obecne `ListDirectory` nadal służy kreatorowi; nie reużywamy jego szerokiego zakresu absolutnych ścieżek jako drzewa wątku |

### `ListThreadDirectory`: ograniczone, nierekurencyjne strony

Żądanie: `thread_id`, względny `directory` (puste = cwd), `page_size` (domyślnie
100, maks. 200), nieprzezroczysty `page_token`, `include_ignored` i opcjonalna znana
rewizja. Brak `worker_id`, `roots`, dowolnego cwd i parametru rekursji od klienta.
Gateway wyprowadza je z wątku i właściciela, a worker ponownie sprawdza realpath.

Odpowiedź: `root_identity`, ścieżka względna, `directory_revision`, wpisy
`name/path/kind/size?/modified?/git_status`, następny kursor, kompletność i powód
ograniczenia statusu Git. Do **64 KiB zakodowanego protobuf wraz z kopertą** i
200 wpisów; mniejszy z limitów wygrywa. Długa nazwa nie uprawnia do przekroczenia
budżetu. Brak pełnych bajtów plików, diffów, absolutnych celów symlinków i manifestu.

Nowa nietrwała komenda workera `ListThreadDirectory` i osobny wynik, capability
`thread_directory_v1`. Iterator ma maks. 2 s pracy na żądanie; następny token może
kontynuować niedokończony odczyt. Najwyżej 8 iteratorów / 2 MiB metadanych na worker,
TTL 30 s i jawny `CURSOR_EXPIRED` bez automatycznego restartu całego drzewa.
Kursor jest związany z owner/thread/root/directory/filtrami i epoką workera;
obcy lub zmieniony zakres jest błędem. Przy zmianie katalogu worker unieważnia
sesję; klient odświeża tylko używane strony i zachowuje kotwicę po ścieżce.

Status Git jest jednym współdzielonym ograniczonym odczytem na checkout przez
process governor: timeout 2 s, najwyżej 1 MiB wyjścia, cache 2 s podczas aktywnego
modułu. Przekroczenie nie blokuje listowania: `git_status_complete=false`.
Nie uruchamiamy skanu całego repo przy wejściu do `Thread` ani dla zamkniętego Files.

### Zmiany bez pełnego snapshotu

Proponowane `WatchThreadFiles` jest osobnym, nietrwałym streamem, capability
`thread_files_watch_v1`. Przyjmuje bounded zbiór obserwowanych katalogów/otwartych
plików (maks. 32 ścieżki), korzeń i ostatni kursor. Emituje wyłącznie
`directory_invalidated`, `file_changed`, `file_removed`, `root_changed` oraz checkpoint;
bez tekstów, drzew i powtórki transkryptu. Jedna współdzielona obserwacja na checkout,
bez rekursywnego watchera wszystkich plików. Git watch obejmuje również zmiany indeksu/HEAD.

Partia ma najwyżej 64 rekordy / 64 KiB. Kursor jest niezależny od trwałego seq
transkryptu i nie udaje gwarancji journala dysku. Ograniczony bufor 256 invalidacji
lub 256 KiB na obserwowany checkout służy krótkiej powtórce; przepełnienie lub
reconnect workera daje `revalidate_required` dla wskazanych obserwacji.
Klient ponawia tylko strony rozwiniętych katalogów i aktywny plik. Nigdy nie żąda
pełnego drzewa ani pełnej historii do naprawy. Anulowanie/ukrycie ostatniego
obserwatora zwalnia watcher, kolejkę i timer. Nie przenosimy invalidacji do bazy lustra.

Przed etapem watch działa jawne `Reload`, odświeżenie po własnej mutacji, końcu
tury i odzyskaniu fokusu, wyłącznie widocznego zakresu. To kompletna wcześniejsza
funkcja; nie obiecuje obserwacji zapisu zewnętrznego w czasie rzeczywistym.

### Kolory na telefonie bez pracy parsera na wątku UI

Proponowane `GetThreadFileHighlight` żąda jednej strony tokenów: `thread_id`,
rozstrzygnięta ścieżka, `expected_sha256`, start i liczba linii (maks. 200).
Opcjonalny bounded tekst szkicu (do 400 KiB, z uwzględnieniem limitu JSON) służy
wyłącznie jawnemu `Preview changes`, z lokalnym `draft_revision`.
Gateway nie zapisuje szkicu ani nie przekazuje go modelowi; worker traktuje go
jako dane. Wynik: hash/rewizja, zakres, role tokenów i offsety, `complete` oraz
`next_line`, do 64 KiB z kopertą. Nie zwracamy HTML, CSS, dowolnych nazw klas ani URL.

Capability `thread_file_highlight_v1`; osobny wykonawca CPU workera, jedna praca
naraz z timeoutem 100 ms i kolejką najwyżej 4 zadań per worker. Limity prefiksu,
stanu gramatyki i tokenów odpowiadają webowi; niepełny wynik pozostawia plain text.
Szybkie przewinięcie anuluje stary zakres. Checkpointy/cache tokenizacji: LRU do
8 MiB na worker, tylko dla obserwowanych plików, usuwane po zamknięciu ostatniego
odbiorcy lub 30 s bezczynności. To koszt odczytu na żądanie, nie synchronizacja plików.

### Gateway, BFF i połączone komputery

Nowe metody wymagają rejestracji w `GatewayService`, autoryzacji urządzeń,
routerze `routed.ts`, allowliście serwowanych metod domu i capabilities linked.
Proponowane capability domu odpowiadają trzem nowym funkcjom; ogłaszamy je tylko,
gdy metoda i routing działają. Przez relay wyłącznie jawnie dopuszczone odczyty
bez szkicu; żądanie z tekstem szkicu tylko trasą bezpośrednią do domu, jak zapis.
Nie stosujemy niejawnego rozszerzenia istniejącej allowlisty.

Web używa `GET /api/threads/:id/directory`, osobnego SSE `/files/events` oraz POST
`/files/highlight` dla bounded podglądu; mobile wywołuje te same RPC przez Connect.
Odczyty dyskowe i szkice mają `no-store`. Abort dociera do gatewaya, przez łącze
do workera i wykonawcy. Istniejące 32 KiB fragmenty transportu pozostają, ale nie
zastępują limitu całej odpowiedzi. Interaktywne RPC plików nie zajmują slotów
lokalnego streamu transkryptu; obowiązują istniejące oddzielne pule BFF.

Starszy gateway bez nowych metod: zakładki plików z obecnego read/write i brak
drzewa z jasnym powodem aktualizacji. Starszy worker: SearchFiles i dotychczasowy
viewer w zakładce, bez wysyłania nieznanych komend. Bez watch działa Reload;
bez tokenizacji mobile pokazuje plain text z informacją. Nie cofamy nowego
`WatchThread.sequence` ani synchronizacji zakresów do pełnych snapshotów.
Zmiana zakładki nigdy nie otwiera drugiego watcha historii.

## 7. Bezpieczeństwo i owner scope

Gateway sprawdza właściciela i bieżący dostęp do wątku **przed cache**, ustala
worker, cwd i korzeń, a dom powtarza kontrolę przy wywołaniu z linked computer.
Klient nie może poszerzyć scope parametrem. Worker sprawdza każdy segment,
realpath i granicę korzenia także przy kontynuacji strony i przed mutacją.
Symlink/junction poza korzeń, pętle, urządzenia, sockety i FIFO nie są odczytywane.
Wyścigi symlinków wymagają bezpiecznego otwarcia i kontroli uchwytu odpowiedniej
dla systemu; samo sprawdzenie tekstowego prefiksu nie spełnia kryterium.

Odwołanie urządzenia, unlink, usunięcie wątku lub utrata grantu zamykają aktywne
odczyty i usuwają cache zakresu. Po reconnect prawa są sprawdzane ponownie;
zapamiętana zakładka nie jest grantem. Ścieżka z wiadomości agenta nie upoważnia
do uruchomienia aplikacji, odczytu spoza katalogu ani wykonywania treści.

Treści traktujemy jako tekst/dane, bez wykonywania HTML/JS/SVG, z istniejącą
polityką bezpiecznych linków Markdown. Brak poświadczeń w DTO modułów, workerowych
tokenach składni i metrykach. Telemetria zawiera tylko kategorie, czasy, rozmiary
i liczniki; bez nazw plików, komputerów, prywatnych ścieżek, kodu i szkiców.

## 8. Wydajność: budżety i dowody

To **cele do zweryfikowania podczas implementacji**, nie wyniki tej propozycji.
Mierzymy osobno zimny i ciepły start, lokalny worker oraz zdalny dom przy kontrolowanym
RTT 100 ms i 10 Mbit/s. Bazą jest aktualny `dev` z tym samym fixture, buildem,
rozmiarem interfejsu i urządzeniem. Nowy shell nie może opóźnić istniejących operacji.

| Miara | Budżet początkowy |
| --- | --- |
| Początkowy JS wątku web | Przyrost ≤ 15 KiB gzip; 0 bajtów edytora/gramatyk do pierwszego użycia Files |
| Gotowość rozmowy i SSE | p95 nawigacji, dekodowania/reducera delt i pisania: brak regresji > 5% lub > 5 ms, zależnie od większej tolerancji; osobno raport wartości bezwzględnych |
| Przełączenie ciepłej karty | p95 do stabilnej treści/fokusu ≤ 50 ms web/desktop, ≤ 100 ms mobile; bez RPC, gdy wpis jest świeży |
| Pierwsze drzewo / plik 100 KiB | Lokalnie p95 ≤ 200 / 250 ms, zdalnie ≤ 600 / 800 ms do plain text; skeleton/loading dostępny w pierwszych 50 ms |
| Główny wątek podczas streamingu | p95 obsługi wejścia ≤ 50 ms, brak nowego zadania > 50 ms od parsowania składni; raport busy %, layout ms/s i lost frames, cel < 1% utraconych klatek przy 60 Hz |

Osobne granice zasobów: maks. 2 równoległe odczyty Files na klienta, jeden aktywny
edytor i wykonawca web, ograniczenia DOM z §5, pamięć/cache z §3. Po 20 cyklach
otwarcia/zamknięcia, po rozgrzewce i GC, retained heap nie rośnie o więcej niż
5 MiB web / 3 MiB natywnego runtime'u JS. RSS, heap JS i pamięć bitmap raportujemy oddzielnie;
limity cache nie dowodzą braku wycieku. Telefon w tle ma 0 timerów/pollerów Files.

### Plan pomiarów

1. Rozszerzyć istniejące deterministyczne fixture z `client-performance.md` poza
   realnymi danymi: 1000 tur, streaming 25 delt/s, 500 wątków, repo 100 000 ścieżek,
   katalog 10 000 dzieci, pliki 0/100/400 KiB i 2/20 MiB, linia 100 000 znaków,
   nieznany język, binaria i obraz ponad limit. Nie dodawać suite testów UI.
2. Zmierzyć markery od kliknięcia do shell/plain text/tokenów, Resource Timing,
   `PerformanceObserver` long tasks i trace profilera na web/desktop; sumy RPC/bajtów
   przez istniejące `CANOPY_SYNC_METRICS`. Udowodnić brak żądań dla zamkniętych
   modułów i brak pełnego drzewa/historii podczas reconnect.
3. Porównać przynajmniej trzy naprzemienne pary przed/po po 2 min, bez równoległych
   buildów i przy kontroli obciążenia. Osobno 30 min przełączania, undo, utraty
   połączenia i powrotu; heap snapshots po zamknięciu i odpięciu zakresu.
4. Na dwóch wspieranych platformach mobilnych, w tym słabszym telefonie, użyć
   profilera natywnego runtime'u JS i narzędzi platformy:
   opóźnienie pisania, liczba renderów, płynność przewijania, bitmapy, klawiatura,
   tło i pamięć procesu. Harness serwerowy nie jest dowodem wydajności urządzenia.
5. Do opisu implementacyjnego PR wpisać liczby przed/po, warunki, p50/p95,
   największe partie i niewykonane pomiary. Profile/logi/obrazy pozostawić poza
   repo. Niespełniony budżet blokuje rozszerzanie zakresu i wymaga naprawy.

Benchmarki, buildy i E2E nie są uruchamiane w etapie projektowym. Dalsze wykonanie
musi respektować aktualne granice zgody; E2E wymaga wcześniejszej zgody użytkownika.

## 9. Mobile, wąskie okna i ruch

### Te same pojęcia, inne powierzchnie

Na desktopie układ ma pasek modułów 2.75 rem i domyślnie widoczny panel 18 rem,
zmieniany w zakresie 16–24 rem. Panel pokazujemy wyłącznie, jeśli po odjęciu lewego
sidebara pozostaje co najmniej 38 rem głównej treści. Decyduje szerokość kontenera
i Interface size, nie sam viewport. Wybór PR przez `+` głównego nagłówka otwiera
pełną kartę; wybór ikony PR w railu zastępuje moduł prawego panelu.
Resizer zachowuje istniejącą klawiaturę; zapis szerokości następuje po puszczeniu.

Przy wąskim web/desktop lewa nawigacja nadal staje się drawerem według obecnych
reguł. **Nie ma dokowanego prawego panelu ani podsumowania**, także przy braku
modułu. Moduły i podsumowanie otwierają osobne arkusze wyłącznie po akcji.
Arkusz podsumowania zastępuje arkusz modułu, nie układa się na nim; zamknięcie
wraca do treści. Wybrany moduł pozostaje wybrany po zamknięciu arkusza, lecz ponowne
kliknięcie jego ikony/`Close module` wyłącza go. Wyłączenie modułu na telefonie
nie otwiera podsumowania. Rozszerzenie okna dokuje podsumowanie tylko przy braku
modułu; z modułem karta pływająca pozostaje zamknięta. Zmiana progu zamyka nakładki
i zachowuje ich dane, nie ich otwartość.

Zakładki pozostają w jednym rzędzie z sygnetem i skróconym tytułem. Reguły overflow
z §2 utrzymują aktywną kartę; poniżej 40 rem lub wcześniej, gdy brakuje miejsca,
zastępuje je przycisk aktywnej karty z licznikiem. Przy 320 px i powiększeniu 200%
nie powstaje poziomy scroll aplikacji; przewija się tylko kod bez wrap. Nawigacja,
`+`, summary i moduły nie znikają w overflow plików.

W `apps/mobile` przycisk nazwy aktywnej karty otwiera **tab switcher sheet**:
`Thread`, otwarte pliki/PR, dirty, zamknięcie, `Keep tab` i `Open module`.
Zmiana kolejności ma akcje `Move up` / `Move down`, nie wymaga drag.
**Modules sheet** wybiera Files, Pull requests, Tasks lub Connectors i pokazuje
ich minimalny widok. Pełny zasób staje się aktywną kartą/ekranem bieżącego wątku,
bez nowego wątku w nawigacji aplikacji. `Thread details` otwiera osobny arkusz.

Back najpierw zamyka najwyższy arkusz, potem wraca z pliku/modułu do `Thread`,
następnie opuszcza wątek. Nie zamyka przy tym zakładki ani szkicu; zamknięcie
karty jest osobną akcją. Nawigacja do innego wątku ma własny zestaw kart.
Zmiana orientacji przenosi ten sam stan do nowej powierzchni, bez podwójnego
montażu/odczytu. Rozmowa zachowuje kotwicę, szkic i kontekst IME.

Cele dotykowe mają minimum 48 dp; tekst i kontrolki korzystają z lokalnej skali,
pola mają co najmniej 16 px/dp. Arkusze uwzględniają safe area, klawiaturę,
czytniki ekranu i duże fonty. Drzewo jest wirtualną listą natywną, viewer listą
oryginalnych linii. Wrap, kopiowanie, Go to line, wybór zakresu i porównanie konfliktu
nie zależą od hover, prawego przycisku ani precyzyjnego przeciągania.

### Ruch i stabilność

Reużywamy `motion.ts` / `motion.css` i wspólnego `@canopy/ui`:
otwarcie nakładki `fast` 250 ms, zamknięcie `quick` 150 ms; panel `slow` / `medium`
400 / 350 ms; `smoothOut`. Mobile używa istniejącego `sheetSpring` na wątku UI.
Nie dodajemy biblioteki animacji ani osobnej skali czasów.

**Dock → float:** wybranie modułu ustala zawartość istniejącej kolumny bez zmiany
jej szerokości. Podsumowanie wychodzi przez opacity według `quick` 150 ms, moduł
wchodzi przez transform/opacity według `fast` 250 ms i `smoothOut`. Nie animujemy
lotu karty przez kod: karta pływająca pozostaje zamknięta. Dopiero kliknięcie ikony
otwiera ją z kotwicy przez `fast`, a close/outside/Escape zamyka przez `quick`.
**Float → dock:** wyłączenie modułu zamyka ewentualną kartę przez `quick` i zastępuje
moduł podsumowaniem przez `fast`; docelowy dock jest widoczny. Nie ma dwóch aktywnych
kopii treści ani dwóch subskrypcji. Fokus z usuwanego panelu wraca do aktywnej ikony,
z karty do przycisku summary; inne miejsce fokusu pozostaje bez zmian.
Zmiana zajęcia nie animuje szerokości; dopiero jawne collapse/restore powierzchni
używa `medium`/`slow`, z pojedynczą zmianą layoutu i animacją samej powierzchni.
Przy reduced motion wszystkie te przejścia są natychmiastowe, bez transform,
przenikania i utrzymywania wychodzącego DOM. Resize nie uruchamia sekwencji przejść.

Przełączenie karty jest natychmiastowe, bez animowania całego dokumentu, blur kodu
ani płynnego scrolla do linii. Krótko zmienia się tylko wskaźnik wybranej zakładki.
Otwarcie panelu ustala końcową szerokość raz i animuje transform/opacity powierzchni,
bez ponownego zawijania rozmowy w każdej klatce. Podczas resize brak animacji.
Rozwijanie wirtualnego drzewa nie animuje wysokości tysięcy wierszy; strzałka może
zmienić pozycję według `fast`, a nowe widoczne wiersze przeniknąć przez `rise`.

`prefers-reduced-motion` i ustawienie systemowe mobile wyłączają przesuwanie,
skalę, blur i pętle. Tab/scroll są natychmiastowe. Ukryte moduły i dokumenty nie
utrzymują animacji, observerów geometrii ani `will-change` całego panelu.
Toolbar i przyklejone nagłówki malują nieprzezroczyste tło do krawędzi scrolla.
Sprawdzamy szczeliny, gutter, długie ścieżki i rezerwę dirty/close w obu motywach.

## 10. Migracja i stos implementacyjny

Układ v2 jest ustalony; pozostały odpowiedzi z §11. Draft dokumentacji nie stanowi zgody na
implementację. Po akceptacji poniższe **7 PR** tworzy jeden stos przez `gh stack`:
pierwszy bazuje na `dev`, każdy następny na poprzednim. Każda warstwa działa po
checkout i ma kompletny widoczny rezultat oraz fallback starszych komponentów.
Wszystkie pozostają draftami do ukończenia i weryfikacji całości; scalanie naraz
przez `gh stack merge <stack> --squash`, zgodnie z polityką repozytorium.

| Warstwa | Kompletny rezultat (web/desktop i mobile w tej samej warstwie) | Szacunek |
| --- | --- | --- |
| 1. Zakładki plików | Jeden rząd sygnet/tytuł/karty z overflow i aktywną zawsze widoczną, `Thread`, preview/keep/close/reorder, lokalne metadane i dirty guard. Obecny viewer/edytor w karcie przez istniejące RPC; parser pozycji i skok/zakres; telefon ma switcher. Linki poza wątkiem zachowują swój viewer | 4–6 dni inżynierskich |
| 2. Moduły i szczegóły | Rejestr, rail i panel/sheet z chipem/+/maksymalizacją, zakładki PR, Tasks i Connectors; podsumowanie dock ↔ float zależnie od zajęcia panelu. Wszystkie obecne akcje dostępne, jedna subskrypcja/query na zasób, zgodność `?pr=` | 4–6 dni |
| 3. Drzewo | `ListThreadDirectory`, status Git i capability, routing domu, BFF/Connect, leniwe strony i wirtualizacja; pełny eksplorator i otwieranie plików. Reload i odświeżanie po własnych mutacjach wystarczają bez watch | 5–8 dni |
| 4. Viewer i podświetlanie | Wirtualne linie, wykonawca podświetlania, tokeny mobilne z bounded RPC, limity dużych plików/obrazów, kolory w podglądzie szkicu; edytor web z dekoracjami poza głównym wątkiem, mobile natywny | 5–8 dni |
| 5. Zmiany dysku | Ograniczony `WatchThreadFiles`, cache/invalidacje zakresów, rewalidacja aktywnego dokumentu, zachowanie szkicu i porównanie konfliktu. Offline/reconnect bez replay i pełnego drzewa | 4–6 dni |
| 6. Zasoby i odzyskiwanie | Egzekwowane limity cache/edytorów/iteratorów, anulowanie po zmianie widoku, cleanup po revoke/unpair, utrata worktree i zmiana korzenia; finalne przypadki IME/klawiatury i dostępności | 3–5 dni |
| 7. Domknięcie migracji | Usunięcie starego modala plików wątku i konkurujących paneli, przy zachowaniu viewerów załączników/blobów/botów. Aktualizacja dokumentacji obszarów, pomiary porównawcze i usunięcie przełącznika migracji | 3–5 dni |

Łącznie **28–44 dni inżynierskich**, około 6–9 tygodni jednej osoby przy 5 dniach
pracy tygodniowo. Zakres obejmuje oba klienty, kontrakty i poprawki z pomiarów;
nie obejmuje czasu decyzji użytkownika, review, nowego edytora natywnego ani nowych
buildów natywnych. Rozpoznanie wykonalności dekoracji edytora poza wątkiem UI i mobilnego
viewera należy do warstwy 4; nie rezerwujemy osobnego PR wyłącznie na eksperyment.
Jeżeli pomiary lub wymagane moduły natywne zmienią koszt, aktualizujemy plan przed
rozszerzeniem. Każda warstwa musi już respektować budżety, bezpieczeństwo i dirty;
warstwy 6–7 domykają przypadki przekrojowe, nie odkładają podstaw poprawności.

Przejściowy, lokalny przełącznik shellu pozwala wrócić do istniejących powierzchni
bez zmiany protokołu i DB. Nie pokazujemy równocześnie dwóch implementacji tego
samego panelu. `Open files in → Default app` zachowuje obecne lokalne znaczenie;
`Canopy` przechodzi z modala do karty. Viewer załączników i obrazów transkryptu
pozostaje osobnym przepływem. Wycofanie nowego klienta nie zmienia plików ani
starych wiadomości; nowe pola proto mogą zostać zignorowane. Najpierw należy
rozstrzygnąć dirty szkice, bo rollback procesu ich nie odzyska.

### Kryteria odbioru implementacji

1. Plik z wiadomości i drzewa otwiera jedną kartę właściwego wątku/komputera;
   `:31`, `:31-40` i `#L31` prowadzą do właściwego celu, z jawnymi ograniczeniami
   plików uciętych i dirty. Powrót do Thread zachowuje szkic, scroll i interakcje.
2. Zapis konfliktowy, utrata odpowiedzi, delete, symlink escape i obcy owner
   nie nadpisują ani nie odsłaniają niedozwolonych danych. Testy kontraktów,
   bezpieczeństwa i trwałości obejmują routing do dwóch prawdziwych gatewayów,
   stare capability, anulowanie i reconnect; bez testów web UI.
3. Każda warstwa ma parytet funkcji na telefonie, z jedyną jawnie zatwierdzoną
   różnicą kolorowania podczas edycji. Weryfikacja ręczna obejmuje jasny/ciemny,
   desktop/wąski/telefon, krótkie i długie nazwy, klawiaturę i reduced motion;
   jeden rząd nagłówka z aktywną kartą przy 12 kartach, oba `+`, collapse/restore,
   wyłączenie modułu i wszystkie stany dock/float/sheet bez kradzieży fokusu.
4. Wykazane liczbowo budżety z §8, ograniczone partie i brak wzrostu kosztu
   ukrytych modułów. Przejście kart nie reconnectuje historii i nie skanuje drzewa.
5. Wykonane dozwolone kontrole repo i copy audit w opisach PR. Weryfikację
   wymagającą dodatkowej zgody planujemy osobno; nie nazywamy niewykonanego
   pomiaru, E2E ani runtime'u mobilnego wynikiem pozytywnym.

## 11. Ustalenia i pozostałe decyzje

Ustalono: jeden rząd sygnet projektu/tytuł/zakładki bez nazwy projektu, aktywna karta
zawsze widoczna z overflow, pasek ikon i jeden panel, dokowane podsumowanie przy
braku modułu, zamknięta domyślnie karta pływająca przy zajętym panelu oraz arkusze
na wąskich szerokościach. Tych decyzji nie otwieramy ponownie.

| Pytanie | Rekomendacja | Konsekwencja |
| --- | --- | --- |
| Czy pojedynczy klik zastępuje podgląd? | **Tak**, jeden czysty preview; Edit/dwuklik/Keep tab utrwala | Drzewo nie tworzy dziesiątek kart; dirty nigdy nie znika |
| Jaki zakres eksploracji w pierwszej wersji? | **Tylko cwd/worktree bieżącego wątku** | Pełny zakres obecnych RPC; przeglądarka całego komputera wymaga osobnego projektu |
| Czy mobile ma kolorować tekst podczas pisania? | **Kolory w viewerze i Preview changes, natywna edycja bez kolorów w v1** | Zachowuje IME i obecny runtime; wymóg kolorowania na żywo zmienia estymatę i wymaga decyzji o edytorze |

Pozostałe limity i skróty są proponowanymi wartościami startowymi do pomiarów,
nie dodatkowymi pytaniami blokującymi. Draft czeka na rozstrzygnięcie powyższych
decyzji i zgodę na implementację; nie ma jeszcze pomiarów ani dowodów działania funkcji.
