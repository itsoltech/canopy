# Skala typografii i gęstości UI

Status (2026-11-27): opis zaimplementowanej skali web/desktop i zwartego arkusza
szczegółów wątku na natywnym mobile, w tym dwuliniowych
kart sidebara, ich jednoliniowego wariantu w worktree, ikon projektów, wcięć i linii hierarchii
oraz kompaktowego wariantu przełącznika i adaptacyjnych pickerów modelu, wysiłku i prędkości composera,
z jednoliniowym menu prędkości i oznaczeniami poziomu przyspieszenia.
Karta zużycia kontekstu composera używa skali nakładek (15 / 13). Zakotwiczone nakładki otwarte kliknięciem powstają z wyzwalacza (morph).
Przycisk Continue używa skali Steer/Queue i zachowuje etykietę na telefonie.
Aktualizacja (2026-11-24): pickery fontów wczytują zainstalowane rodziny przy otwarciu, jeśli klient ma do nich dostęp.
Aktualizacja (2026-11-25): tekst w wyszukiwarce sidebara zaczyna się w tym samym miejscu w Threads i Bots.
Aktualizacja (2026-11-26): composer w web/desktop ustawia czasy przejść raz na
odcinek ruchu sterowany przewijaniem.
Aktualizacja (2026-11-26): listy sidebara web/desktop mają mniejszy odstęp po prawej
i zachowują szerokość po pojawieniu się paska przewijania.
Aktualizacja (2026-11-28): zakładki tematów ustawień mają na desktopie 28 px zamiast 32 px.
Aktualizacja (2026-11-28): menu zadań w tle nad composerem pokazuje podglądy poleceń w wierszach listy.
Aktualizacja (2026-11-28): wiadomość od agenta dołączona do trwającej tury w web/desktop
pokazuje odnośnik do nadawcy i początek treści w jednym wierszu. Przy szerokości
kolumny poniżej 30 rem podgląd przechodzi pod nazwę. Osobny przycisk rozwija
treść z metadanymi i akcjami, a status oczekującej wiadomości jest widoczny
również po zwinięciu. Panel i strzałka korzystają z ruchu akordeonu, z natychmiastową
zmianą przy ograniczonym ruchu.
Dostępność kanałów: [release.md](release.md).

Jedna skala dla całego web UI. Każdy fragment interfejsu należy do jednego **kontekstu**; kontekst
wyznacza rozmiar tekstu, wysokość wierszy, odstępy, ikony i kontrolki. Nie ustawiamy rozmiarów
pojedynczo na ekranach: komponenty kitu (`apps/web/src/lib/shared/ui`) czytają kontekst same.

Wartości podane są jako **telefon / desktop** (desktop od `sm`, 40rem). Wszystkie są w `rem`, więc
Appearance → Interface size skaluje je razem z korzeniem.

## Konteksty

| Kontekst | Gdzie | Tekst główny | Drugorzędny | Nagłówek sekcji | Wiersz | Ikona |
| --- | --- | --- | --- | --- | --- | --- |
| Treść | wiadomości, treść stron | 16 / 14 (linia 24) | 14 / 12 | `text-lg`–`text-2xl` | — | 16 |
| Kontrolki standardowe | formularze, dialogi | 16 / 14 (linia 24) | 14 / 12 | 14 / 14, medium | pole i przycisk 40 / 36 | 16 |
| ↳ ustawienia | Settings (`settings-density`) | 15 / 13 (linia 20) | 13 / 13 | 14 / 14 | kontrolka 44 / 32 | 16 |
| Chrome kompaktowe | sidebar, paski narzędzi, top bar | 15 / 13 | 13 / 11,5 | 13 / 11,5 | kontrolka 36 / 32 | 16 |
| Wiersze pracy | narzędzia, komendy, zmiany plików w turze (`ItemFrame`) i ich szczegóły | 15 / 13 (linia 24 / 20) | 13 / 12 | — | — | 16 |
| ↳ wiersz kontekstu composera | pickery pod edytorem | 12 / 12 (linia 16) | — | — | 40 / 32, odstęp 4 | 12 |
| Nakładki | popovery, menu, dropdowny, pickery, comboboxy, select, hover cardy, paleta poleceń | 15 / 13 (linia 24 / 20) | 13 / 11,5 (linia 20 / 16) | 13 / 11,5, medium | 40 / 28 (44 przy dotyku), `px-2`, odstęp 8 | 16 / 14 |
| Tooltipy i podpisy | tooltipy, skróty (`Kbd`), kompaktowe badge | 12 / 12 (linia 16) | — | — | — | — |

Karta wątku pod nagłówkiem projektu pomija linię projektu i zachowuje skalę chrome:
tytuł ze statusem oraz metadane. Rezerwa wysokości przy pomijaniu renderowania
niewidocznych kart wynosi 56 px na telefonie i 48 px na desktopie. Nagłówki grup
mają 36 / 32 px, licznik po prawej i ucinanie długich nazw w jednej linii.

W grupowaniu projektów nagłówek zachowuje znak projektu. Każdy poziom hierarchii
(projekt → worktree → wątki) dodaje wcięcie 1,25 rem i pionową linię prowadzącą.
Oczekiwanie i zadania w tle mają oznaczenia przy linii bez przesuwania tytułu;
praca jest opisana statusem po prawej bez spinnera.
Bezczynne wątki nie mają zastępczej ikony. Karty pod worktree z jedynym lokalnym
workerem mają jedną linię (34 / 28 px). Dodatkowe oznaczenia, w tym cel i pull requesty,
stoją po prawej za statusem, obok dostawcy, w tym samym wierszu.
Wewnętrzny padding pionowy kart w grupie projektu wynosi 6 / 4 px.
Dostawca pozostaje po prawej przy statusie (slot 72 px), a menu i archiwizacja mają osobne sloty.

Skróty klawiszowe (`Kbd`) mają 11 px w każdym kontekście. Pola, w które się pisze, mają na
telefonie zawsze 16 px (iOS powiększa stronę przy fokusie mniejszego pola), także w nakładkach
i sidebarze.

## Kontrolki

Grupa pickerów modelu, wysiłku i prędkości w composerze ma własny kontener szerokości
i minimum 5,25 rem. Przy mniej niż 16 rem pomija strzałki i dodatkowe ikony;
poniżej 12 rem wysiłek pokazuje paski, a poniżej 9 rem model zachowuje sam znak
providera. W przedziale 9–16 rem nazwę modelu chroni pominięcie jego znaku.
Pełne nazwy pozostają w aria-label i podpowiedziach. Poza composerem pickery
zachowują dotychczasowy wygląd. Poniżej 24 rem szerokości composera odstęp paska
maleje do 4 px, Steer/Queue pokazuje ikonę i menu, Text składa licznik i limit w dwie
linie, a Bar skraca pasek. Gdy dodatkowe kontrolki nadal nie mieszczą się obok
minimalnej pary, pasek zawija wiersz, zachowując miejsce na akcję wysyłania.

Picker prędkości pojawia się dla modeli z przyspieszonymi trybami w katalogu konta
oraz wtedy, gdy zapisany wybór wymaga możliwości powrotu do Standard.
Poniżej 22 rem kontenera grupy pomija strzałkę, a poniżej 18 rem zachowuje samą
ikonę z pełną nazwą w aria-label. Menu używa skali nakładek i ogranicza szerokość
do viewportu; nie przesuwa przycisku wysyłki. Opcje są jednoliniowe, bez opisów.
Fast ma jeden piorun, Ultrafast pojedynczą ikonę podwójnego pioruna,
a Standard neutralną ikonę zegara. Podwójny piorun jest wspólnym glifem SVG,
zamiast dwóch osobnych ikon ułożonych obok siebie.
Ikona zajmuje stały slot również na zamkniętym przycisku; przy Default odpowiada
odziedziczonej prędkości. Nazwy pozostają widoczne w menu.

| Kontrolka | Standard | Nakładka (domyślnie) |
| --- | --- | --- |
| Przycisk tekstowy `md` (primary, secondary, ghost, danger) | 40 / 36, `px-3`, tekst 16 / 14, odstęp 6 | — |
| Przycisk tekstowy `sm` | 32 / 28, `px-2.5`, tekst 14 / 13, odstęp 4 | 32 / 28, `px-2.5` (z ikoną `pl-2`), tekst 13 / 13 |
| Ikona w przycisku | 16 | 16 / 14 |
| `IconButton` `md` | 40 / 36 (`p-2.5` / `p-2`) | — |
| `IconButton` `sm` | 32 / 28 (`p-2` / `p-1.5`) | 32 / 28 (`p-2` / 7 px), ikona 16 / 14 |
| Checkbox, radio | 20 / 16, odstęp do etykiety 12, wiersz ≥ 48 przy dotyku | 18 / 14, odstęp 8; wysokość wiersza daje wiersz listy (≥ 40) |
| Switch | 44 × 24 / 36 × 20 | 36 × 20 / 28 × 16 |
| Switch `sm` (jawny wariant dla zwartych wierszy) | 32 × 18 / 28 × 16 | jak standard; cel dotykowy nadal 48 px |
| Pole wyszukiwania (`SearchField`) | 40 / 36 | 36 / 28, tekst 16 / 13 |
| Pole tekstowe (`Input`) | 40 / 36 | 40 / 28, `px-2.5` |
| Wyszukiwarka pickera (`Combobox inline`) | — | 40 / 32 |
| Wiersz menu, opcja listy, select | — | 40 / 28, 44 przy dotyku |
| Paleta poleceń | — | wiersz 40 / 32, pole 48 / 44 |
| Segmented control | 32 / 24, tekst 14 / 13 | jak standard |
| Zakładki tematów ustawień (`SettingsTopics`) | 44 / 28, tekst jak segmented control | — |

Primary, secondary, ghost i danger mają te same wymiary; różnią się tylko kolorem. Przyciski `sm`
i `IconButton` dostają na ekranach dotykowych niewidoczny cel 48 px (`TouchTarget`).

Wariant `text` służy do akcji w treści listy, np. „Show all N”. Zachowuje wysokość i cel dotykowy
przycisku, ale nie ma poziomego paddingu, dzięki czemu etykieta wyrównuje się z tekstem listy.

Bez jawnego `size` `Button`, `ButtonLink` i `IconButton` są `md` w kontekście standardowym i `sm`
w nakładce. Jawny `size` zawsze wygrywa: podawaj go tylko wtedy, gdy kontrolka świadomie odstaje od
kontekstu (np. `sm` w nagłówku dialogu).

## Kiedy który kontekst

- **Treść**: wszystko, co się czyta: wiadomości, opisy, puste stany na stronie.
- **Kontrolki standardowe**: miejsca, gdzie się coś wypełnia lub zatwierdza: formularze, dialogi
  (także otwarte z menu), wiersze ustawień. Ustawienia są gęstszym wariantem z własnym rytmem
  (`features/settings/density.css`) na tych samych stopniach.
- **Wiersze pracy**: aktywność tury pod „Working for …” (narzędzia, komendy, zmiany plików)
  i komunikaty w osi czasu, w tym ostrzeżenia o ponownym łączeniu. Tekst jest o stopień
  mniejszy od wiadomości, bo to tło dla odpowiedzi. Szczegóły techniczne komunikatów
  używają stopnia drugorzędnego (13 / 12) z wysokością linii 20.
- **Chrome kompaktowe**: stała nawigacja i paski wokół treści: sidebar, top bar, paski narzędzi,
  wiersz kontekstu composera. Tekst jest o stopień mniejszy od strony obok.
- **Nakładki**: wszystko, co otwiera się nad stroną i znika po wyborze. Zawsze kompaktowe: mniejszy
  tekst, niższe wiersze, mniejsze odstępy, ikony i kontrolki.
- **Tooltipy i podpisy**: krótkie podpowiedzi i etykiety pomocnicze, zawsze 12 px.

Na telefonie nakładki z `sheet` otwierają się jako dolny arkusz. Zostają przy tekście nakładki
(15 / 13), ale wiersze mają co najmniej 40 px (menu 44 px przy dotyku), a pola 16 px.

Zakotwiczony panel `Popover` (menu, pickery, selecty, comboboxy, submenu) otwarty naciśnięciem
(kliknięcie, dotknięcie, klawisz, menu kontekstowe) powstaje z wyzwalacza
(`shared/ui/popover-morph.ts`). Powierzchnią jest `::before` panelu (`position: fixed`, więc
`overflow` panelu go nie przycina, a jako pseudo-element nie zmienia dzieci treści): bierze tło,
ring, cień i rogi panelu i przejeżdża z pudełka wyzwalacza do pudełka panelu w `--duration-fast`
na `--ease-spring`, z lekkim przestrzeleniem, wyostrzając się z rozmycia `--blur-medium`. W tym
czasie panel nie maluje własnej powierzchni, a treść wchodzi z tego samego rozmycia od 30% ruchu.
Zamknięcie prowadzi powierzchnię z powrotem do wyzwalacza w `--duration-quick` na
`--ease-smooth-out`, rozmywając ją; treść gaśnie i rozmywa się pierwsza. Cały stan morpha trzymają
animacje Web Animations, więc ich koniec albo anulowanie przywraca panel. Panel otwarty
najechaniem (popovery stopki sidebara, submenu), hover cardy (`morph={false}`), dolne arkusze
i tryb ograniczonego ruchu zostają przy zanikaniu i skali z `t-dropdown` (`motion.css`), także
przy zamknięciu.
Ten sam morph prowadzi kartę Thread details z pigułki i z powrotem (`ThreadSummary.svelte`),
gdy otwiera ją albo zamyka naciśnięcie; opis w `workspace.md`.

## Zaznaczanie tekstu

Chrome aplikacji domyślnie nie pozwala zaznaczać tekstu (`shared/ui/selection.css`): dotyczy to
nawigacji, etykiet, przycisków, menu, badge i pustych stanów. Treść do czytania (wiadomości,
markdown, rozwinięte szczegóły narzędzi, kod, diffy, cytaty, podglądy plików i terminal) włącza
`select-text` na wspólnej granicy treści. Kontrolki wewnątrz takiego obszaru nadal nie są
zaznaczalne. Pola tekstowe i edytowalne obszary zawsze zachowują natywne zaznaczanie.

Wartości do kopiowania w chrome (ścieżki, gałęzie, identyfikatory, adresy, wersje, błędy i logi)
muszą mieć `select-text` na samej wartości lub przycisk kopiowania; etykieta pozostaje
niezaznaczalna. Nie blokujemy zdarzeń myszy ani przeciągania tekstu: cytowanie zaznaczenia
i upuszczanie tekstu do composera korzystają z natywnej selekcji. W React Native `selectable`
pozostaje wyłącznie na treści i kopiowalnych wartościach, nigdy na chrome.

Cmd+A / Ctrl+A przy fokusie w osi rozmowy (`VirtualFeed`) zaznacza treść zamontowanych
wierszy tej rozmowy, bez sidebara, panelu bocznego i composera. Wirtualizowana historia
nie jest eksportem całego wątku; niezamontowane i zwinięte fragmenty nie są zaznaczane.
W polach i composerze skrót zaznacza tylko ich zawartość; poza osią rozmowy zachowuje
natywne działanie przeglądarki na zaznaczalnych obszarach.

## Implementacja

- `shared/ui/scale.css` definiuje stopnie (`--type-*`), ikony (`--icon-*`) i wysokości
  (`--control-*`) oraz klasy kontekstu. Kit pisze tekst stopniami Tailwinda (`text-base sm:text-sm`
  dla tekstu głównego, `text-sm sm:text-xs` dla drugorzędnego), a klasa kontekstu zmienia znaczenie
  `--text-base`, `--text-sm` i `--text-xs` w swoim poddrzewie:
  - `density-standard`: 16 / 14 / 12 (domyślne kitu; `Dialog` i nagłówek sidebara),
  - `density-chrome`: 15 / 13 / 11,5 (sidebar),
  - `density-overlay`: 15 / 13 / 11,5 (panel `Popover`, paleta poleceń),
  - `density-work`: 15 / 13 / 12 (wiersze pracy tury, `ItemFrame`; ścieżki i komendy zostają czytelne).
- Każda klasa ustawia wartości na własnym elemencie, więc nakładka otwarta z sidebara albo dialog
  otwarty z menu bierze własny kontekst, nie rodzica.
- `shared/ui/density.ts` przekazuje kontekst komponentom (`provideDensity`, `useDensity`). `Popover`
  owija zawartość w `OverlayScope` (wyzwalacz zostaje w kontekście rodzica), `Dialog` ustawia
  `standard`. Według kontekstu wymiary wybierają `Button`, `ButtonLink`, `IconButton`, `Icon`,
  `Checkbox`, `ChoiceControl`, `Switch`, `SearchField` i `Input`. Wiersze menu, list i pickerów
  są zawsze nakładkowe.
- W ustawieniach reguły kontrolek z `density.css` pomijają nakładki (`:not(.density-overlay *)`),
  dlatego select czy menu w Settings ma ten sam rozmiar co wszędzie.

## Zasady

- Akcje wiadomości użytkownika są pod dymkiem, wyrównane do prawej. Wspólny
  `MessageActionRow` utrzymuje tę samą wysokość i widoczność co akcje odpowiedzi:
  hover i fokus zmieniają tylko opacity, a na dotyku akcje pozostają widoczne.
  Czas jest w tym samym wierszu; etykiety celu i początku dnia zostają nad wiadomością.

- Typography zapisuje na urządzeniu osobno font interfejsu i monospace. Presety są na początku
  wyszukiwanego pickera. Zainstalowane rodziny pojawiają się po otwarciu pickera, gdy klient ma
  dostęp do listy. „Show installed fonts” pozwala poprosić o dostęp w przeglądarce.
  Lista jest wirtualizowana: DOM zawiera widoczne wiersze i mały bufor, a podgląd własnym
  fontem pojawia się dopiero w widocznym obszarze. W pickerze monospace rodziny mają oznaczenie
  „Monospace” lub „Proportional”, ustalane porównaniem szerokości znaków.
  Wpisana nazwa ma podgląd i sprawdzenie obecności (`document.fonts.check` oraz pomiar canvas).
  Safari i Firefox korzystają z tej drogi bez dostępu do listy. Brak fontu zachowuje wybór,
  używa dotychczasowego stosu fallbacków i pokazuje stan w Settings. Nazwy są cytowane
  i escapowane przed ustawieniem `--font-sans` lub `--font-mono`. Rozmiary i wysokości
  wierszy pozostają na skali; reset ma stale zarezerwowane miejsce.

- Nie wpisuj rozmiarów w pikselach ani `text-[…]` dla tekstu interfejsu. Użyj stopnia
  (`text-base sm:text-sm`, `text-sm sm:text-xs`) albo tokenu (`--type-*`, `--icon-*`,
  `--control-*`), jeśli komponent ma własny styl.
- Pigułki modelu i wysiłku w composerze mają szerokość treści, odstęp 4 i wyrównanie
  grupy do prawej. Nazwa modelu pochodzi synchronicznie ze wspólnego katalogu;
  maksymalna szerokość ogranicza długą nazwę, bez rezerwowania pustego slotu dla krótkiej.
  Brak obsługi wysiłku usuwa jego pigułkę razem z odstępem.
- Dolny inset composerów web/desktop (wątki, nowe wątki, wątki boczne, boty i grupy)
  używa wspólnego `composer-bottom`: maksimum z 8 px (`--spacing(2)`) i
  `env(safe-area-inset-bottom)`, także od `sm`. Na wyśrodkowanych ekranach to minimalny
  odstęp po przewinięciu, a nie wymuszone wyrównanie do dołu. Status wysyłki zajmuje
  miejsce komputera w wierszu kontekstu, bez dodatkowego pustego wiersza pod nim.
  W wątkach spacer osi czasu to stała rezerwa: pełna wysokość stopki (także cytaty
  zawinięte w kilka rzędów) plus 40 px zapasu na jeszcze jeden pasek (kolejka,
  subagenci, załączniki). Composer zwija się i rozwija wewnątrz tej rezerwy, więc
  treść wątku nigdy nie przesuwa się razem z nim. Rezerwa rośnie od razu dopiero,
  gdy pełna stopka przekroczy zapas (czytelnik na końcu zostaje na końcu w tej samej
  klatce, pozostali zachowują `scrollTop`), a maleje dopiero przy powrocie na koniec.
  Zwijanie jest sprzężone z przewijaniem: 96 px czytania w górę zwija composer
  liniowo, krok po kroku; zwinięty zostaje zwinięty, a w ostatnich 192 px przed końcem
  rozwija się w takt powrotu. Przejścia CSS composera są wstrzymywane raz przy
  rozpoczęciu ruchu sterowanego przewijaniem. Kolejne klatki ustawiają tylko
  pozycję w tych przejściach (bez układu wierszy). Po zatrzymaniu (240 ms)
  kończy się bliższy stan; fokus i pisanie rozwijają composer we własnym tempie.
  Przy `prefers-reduced-motion` stan przełącza się tylko na krańcach, bez animacji. Fade nad stopką tylko imituje cień composera:
  przechodzi od przezroczystości dokładnie do tła wątku (token `surface`, ten sam co
  obszar wątku), bez widocznej krawędzi pasa. Ma 12,5% wysokości stopki (minimum
  12 px, maksimum 32 px). „Jump to latest” jest wyśrodkowany na osi composera (we
  wspólnej `.chat-column`), domyślnie 8 px nad jego widoczną górną krawędzią: treść stopki
  oznacza malowane elementy `data-feed-edge` (powierzchnia composera, karta Drafts,
  panele nad nim), a pusty zarezerwowany pas nad composerem się nie liczy. Gdy
  przycisk wystaje ponad stopkę, fade rośnie tak, by go obejmował. Przycisk ma
  własną nieprzezroczystą powierzchnię; tło stopki dochodzi do dolnej krawędzi widoku. Mobile stosuje fade 16–32 dp zgodnie ze stanem zwinięcia
  i tę samą kotwicę nad zmierzoną stopką. Rozmowy
  botów i grup utrzymują koniec po zmianie wysokości composera tylko podczas śledzenia
  najnowszych wiadomości, bez przesuwania czytelnika przeglądającego historię.
  W kompozytorze wątku cytaty przewijają się po osiągnięciu 20 dvh (maks. 192 px),
  a tekst po 25 dvh (maks. 288 px), aby ich połączenie zostawiało miejsce na wiadomość.
- W wątkach web/desktop badge zadań w tle stoi przy lewej krawędzi composera,
  8 px nad jego widoczną powierzchnią. „Jump to latest” pozostaje wyśrodkowany
  w tym samym rzędzie, gdy oba elementy mieszczą się z odstępem co najmniej 8 px;
  inaczej zajmuje osobny rząd 8 px wyżej. O układzie decydują zmierzone szerokości
  kolumny i kontrolek, także przy zmianie skali i fontu. Status ma minimum 28 px
  wysokości, a ostatnie zajęte szerokości pozostają zarezerwowane po zniknięciu
  kontrolek. Koniec zadań nie przesuwa przycisku. Oba elementy podążają za
  widoczną krawędzią także przy zwijaniu composera i w wąskim oknie.
- Wiersze nakładek mają jedną linię na pole: nazwy użytkownika (projekty, workery, gałęzie, modele)
  kończą się wielokropkiem, a pełna nazwa jest w tooltipie (`TruncatedText`; robią to `PickerRow`,
  `MenuItemText`, opcje `Select` i `Checkbox` w nakładce). Druga linia jest tylko tam, gdzie wiersz ją
  przewiduje (opis, instancja w Favourites). W menu zadań w tle nad composerem opis
  lub komenda zajmuje do trzech linii. Wybór wiersza otwiera pełne polecenie i wynik.
  W panelu szczegółów wątku podpowiedź przy ikonie zadania wyjaśnia jego status.
  Jeśli wskazówka dla widocznej etykiety tekstowej powtarza jej treść, pojawia się
  dopiero po ucięciu tekstu.
- Nowa nakładka korzysta z `Popover`, `DropdownMenu`, `SearchPicker`, `Select` lub `HoverCard`
  i dostaje kontekst sama. Własny panel w top layer dostaje klasę `density-overlay`
  i `provideDensity("overlay")`.
- Panel szczegółów wątku korzysta z `density-chrome`, także w arkuszu telefonu.
  Natywny mobile stosuje te same stopnie chrome, małe akcje sekcji i przełącznik
  `sm` (32 × 18 dp); cel dotykowy pozostaje co najmniej 48 dp. Nagłówek arkusza
  jest kompaktowy, sekcje dzielą delikatne linie, a puste zadania w tle i lineage
  nie są renderowane.
  Wiersze mają co najmniej 36 / 32 px, odstęp ikon 8 px i pionowy padding sekcji 4 px.
  Położenie i gałąź mają po jednym wierszu bez osobnej etykiety: worktree pokazuje swoją
  nazwę, katalog skraca początek ścieżki, gałąź skraca środek; nie łamiemy ścieżek ani nazw.
  Pełna wartość jest w tooltipie, a kopiowanie, otwieranie folderu i `Manage worktree`
  w menu wiersza położenia. Chevron gałęzi i miejsce Stop zadania mają stałe sloty.
  Connectory mają wiersz z samą nazwą; badge pojawia się tylko przy znanym stanie
  (`Available`, `Available next turn`, `Access removed`, `Unavailable`, `Error`),
  a powód błędu zajmuje drugą linię.
- Sidebar ma lokalny wariant `sidebar-scale`: kontrolki, zakładki i wybór projektów
  używają tekstu 16 / 14, podpisów 14 / 12,5. Pole wyszukiwania zachowuje 16 px
  na telefonie, a miejsce przycisku czyszczenia jest zawsze zarezerwowane.
  Nakładki poza filtrem projektów zachowują własną kompaktową skalę.
- Wiersze wątków i botów używają `sidebar-row`: tytuł 15 / 13 (linia 22 / 20),
  podpis i wiek 13 / 12,5 (linia 20 / 18), pionowy padding 8 px i odstęp linii 2 px.
  Wiersz główny ma 82 / 78 px, bot 60 px, boczny i archiwalny minimum 40 / 36 px
  (48 px przy dotyku); szkielet archiwum ma tę samą wysokość. Znak projektu ma 16 px
  z inicjałami 8 px, jak na przycisku pickera projektów w kompozytorze. Jest wyśrodkowany
  w slocie 20 px, który mieści też ikonę aktywności 16 px. W wierszu i nagłówku projektu
  między krawędzią znaku a nazwą jest 6 px. Boczny slot aktywności ma 16 px, a avatar bota 44 px.
  Status wątku ma stały slot 96 px, czas bota 64 px, a licznik nieprzeczytanych 28 px;
  zmiany stanu nie przesuwają tekstu. Wartości pozostają w `rem`.
- Sidebar web/desktop używa wspólnego guttera `--sidebar-gutter` (12 px): wyrównuje
  treść wierszy, nagłówki grup, ikonę wyszukiwania i ikony dolnego paska. Tło wiersza
  ma inset `--sidebar-row-inset` (4 px), a padding wiersza to różnica tych tokenów
  (8 px). Wyszukiwarka i dolny pasek korzystają z tego samego insetu. Odstęp między
  lupą a tekstem wyszukiwania wynosi 0,25 rem (4 px) w Threads i Bots. Listy Threads
  i Bots zachowują 0,25 rem insetu z lewej i mają 0,125 rem z prawej. Pasek przewijania
  rezerwuje stałe miejsce po prawej. W Chromium i Safari jego obszar ma 6 px,
  a widoczny uchwyt zachowuje 4 px szerokości.
  Wspólne klasy `sidebar-swap-resting` / `sidebar-swap-action` zamieniają status/czas
  na „…” oraz znak dostawcy/licznik na Archive. Oba sloty używają tego samego
  przenikania, skali i rozmycia (`--duration-fast`, `--ease-in-out`, `--scale-large`,
  `--blur-small`), bez opóźnienia ruchu w obie strony. Hover, fokus wewnątrz wiersza
  i otwarte menu utrzymują ten sam stan. Ograniczenie ruchu wyłącza przejścia.
- Mobile stosuje lokalnie kolejny stopień: tytuł 16 dp (linia 24), podpis 14 dp
  (linia 20), wiek i licznik bota 13 dp (linia 18), padding 8 dp i odstęp linii 2 dp.
  Zwarte karty pod projektem pomijają jego tożsamość; lokalny wiersz pod worktree
  mieści tytuł, status i oznaczenia po prawej w jednej linii, z minimum 48 dp dla dotyku.
  Nagłówki grup także mają minimum 48 dp, a każdy poziom dodaje wcięcie i linię co 20 dp.
  Typografia uwzględnia font i Interface size urządzenia. Znak projektu ma 20 dp,
  ikony 16 dp, avatar bota 44 dp; cele dotykowe pozostają minimum 48 dp.
  Natywne pole wyszukiwania (16 dp), zakładki i picker projektów (14 dp) już używały
  większej skali, więc nie wymagają zmiany.
- Pierścienie fokusu mieszczą się w wierszu: wiersze menu i list mają obrys wewnętrzny
  (`-outline-offset-2`), a przyciski zewnętrzny 2 px (`focus-ring`) z marginesem panelu `p-1`.
- Listy pickerów mają pionowy inset `py-1` wewnątrz przewijanej treści i `scroll-py-1`
  na kontenerze przewijania. Pierwszy i ostatni wiersz nie dotykają separatorów wyszukiwarki
  ani stopki. Inset przewija się z listą, a lepkie nagłówki pozostają przy `top-0`, bez szczeliny.
- Duże, rosnące obszary przewijania (sidebar, panele, ustawienia, oś czasu) rezerwują
  miejsce na pionowy pasek klasą `scroll-stable`
  (`scrollbar-gutter: stable`, `shared/ui/scroll.css`), również przy krótkiej treści.
  Kompaktowe nakładki (menu kontekstowe, dropdowny, małe popovery i tooltipy) nie rezerwują
  guttera: tła aktywnych wierszy i separatory mają takie same insety z obu stron.
  Listy pickerów domyślnie również nie rezerwują miejsca. Długa, rosnąca lista w nakładce
  może je rezerwować wyłącznie na wewnętrznym kontenerze przewijania, z symetrycznymi
  insetami wierszy; zewnętrzny popover nie dodaje guttera. Tło panelu obejmuje gutter,
  a lepkie nagłówki i stopki pozostają przy krawędzi przewijanego obszaru.
  Paski nakładkowe nie rezerwują miejsca.
  Panele subagentów i kolejki nad composerem przewijają wyłącznie rozwinięte listy
  (każda do 20 dvh). Wspólny `ComposerPanelBody` rezerwuje gutter wewnątrz listy;
  nagłówki accordionów i zewnętrzny kontener nie przewijają się ani nie rezerwują
  miejsca na pasek, więc tło nagłówka dochodzi do prawej krawędzi panelu.
  Panel szczegółów wątku używa `scroll-stable-both` (`stable both-edges`) do symetrycznych
  insetów kart. Sidebar i pozostałe duże obszary mają gutter na końcu.
