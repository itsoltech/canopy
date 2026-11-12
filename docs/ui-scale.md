# Skala typografii i gęstości UI

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

Skróty klawiszowe (`Kbd`) mają 11 px w każdym kontekście. Pola, w które się pisze, mają na
telefonie zawsze 16 px (iOS powiększa stronę przy fokusie mniejszego pola), także w nakładkach
i sidebarze.

## Kontrolki

| Kontrolka | Standard | Nakładka (domyślnie) |
| --- | --- | --- |
| Przycisk tekstowy `md` (primary, secondary, ghost, danger) | 40 / 36, `px-3`, tekst 16 / 14, odstęp 6 | — |
| Przycisk tekstowy `sm` | 32 / 28, `px-2.5`, tekst 14 / 13, odstęp 4 | 32 / 28, `px-2.5` (z ikoną `pl-2`), tekst 13 / 13 |
| Ikona w przycisku | 16 | 16 / 14 |
| `IconButton` `md` | 40 / 36 (`p-2.5` / `p-2`) | — |
| `IconButton` `sm` | 32 / 28 (`p-2` / `p-1.5`) | 32 / 28 (`p-2` / 7 px), ikona 16 / 14 |
| Checkbox, radio | 20 / 16, odstęp do etykiety 12, wiersz ≥ 48 przy dotyku | 18 / 14, odstęp 8; wysokość wiersza daje wiersz listy (≥ 40) |
| Switch | 44 × 24 / 36 × 20 | 36 × 20 / 28 × 16 |
| Pole wyszukiwania (`SearchField`) | 40 / 36 | 36 / 28, tekst 16 / 13 |
| Pole tekstowe (`Input`) | 40 / 36 | 40 / 28, `px-2.5` |
| Wyszukiwarka pickera (`Combobox inline`) | — | 40 / 32 |
| Wiersz menu, opcja listy, select | — | 40 / 28, 44 przy dotyku |
| Paleta poleceń | — | wiersz 40 / 32, pole 48 / 44 |
| Segmented control | 32 / 24, tekst 14 / 13 | jak standard |

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
- **Wiersze pracy**: aktywność tury pod „Working for …” (narzędzia, komendy, zmiany plików). Tekst
  jest o stopień mniejszy od wiadomości, bo to tło dla odpowiedzi.
- **Chrome kompaktowe**: stała nawigacja i paski wokół treści: sidebar, top bar, paski narzędzi,
  wiersz kontekstu composera. Tekst jest o stopień mniejszy od strony obok.
- **Nakładki**: wszystko, co otwiera się nad stroną i znika po wyborze. Zawsze kompaktowe: mniejszy
  tekst, niższe wiersze, mniejsze odstępy, ikony i kontrolki.
- **Tooltipy i podpisy**: krótkie podpowiedzi i etykiety pomocnicze, zawsze 12 px.

Na telefonie nakładki z `sheet` otwierają się jako dolny arkusz. Zostają przy tekście nakładki
(15 / 13), ale wiersze mają co najmniej 40 px (menu 44 px przy dotyku), a pola 16 px.

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

- Typography zapisuje na urządzeniu osobno font interfejsu i monospace. Presety są na początku
  wyszukiwanego pickera; „Show installed fonts” odczytuje rodziny dopiero po kliknięciu.
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
  W wątkach spacer osi czasu i pozycja „Jump to latest” uwzględniają stałą wysokość
  zwiniętego pola (72 px), odstęp 8 px i dolny inset; rozwijanie pola nie zmienia rezerwy.
  Przycisk wygasa pod rozwiniętym polem, a tło dochodzi do dolnej krawędzi widoku. Rozmowy
  botów i grup utrzymują koniec po zmianie wysokości composera tylko podczas śledzenia
  najnowszych wiadomości, bez przesuwania czytelnika przeglądającego historię.
- Wiersze nakładek mają jedną linię na pole: nazwy użytkownika (projekty, workery, gałęzie, modele)
  kończą się wielokropkiem, a pełna nazwa jest w tooltipie (`TruncatedText`; robią to `PickerRow`,
  `MenuItemText`, opcje `Select` i `Checkbox` w nakładce). Druga linia jest tylko tam, gdzie wiersz ją
  przewiduje (opis, instancja w Favourites).
- Nowa nakładka korzysta z `Popover`, `DropdownMenu`, `SearchPicker`, `Select` lub `HoverCard`
  i dostaje kontekst sama. Własny panel w top layer dostaje klasę `density-overlay`
  i `provideDensity("overlay")`.
- Panel szczegółów wątku korzysta z `density-chrome`, także w arkuszu telefonu.
  Wiersze mają co najmniej 36 / 32 px, odstęp ikon 8 px i pionowy padding sekcji 4 px.
  Kopiowanie katalogu pojawia się przy hoverze lub fokusie (na dotyku zawsze),
  a miejsce na nie i Stop zadania pozostaje zarezerwowane w każdym stanie.
- Sidebar ma lokalny wariant `sidebar-scale`: kontrolki, zakładki i wybór projektów
  używają tekstu 16 / 14, podpisów 14 / 12,5. Pole wyszukiwania zachowuje 16 px
  na telefonie, a miejsce przycisku czyszczenia jest zawsze zarezerwowane.
  Nakładki poza filtrem projektów zachowują własną kompaktową skalę.
- Wiersze wątków i botów używają `sidebar-row`: tytuł 15 / 13 (linia 22 / 20),
  podpis i wiek 13 / 12,5 (linia 20 / 18), pionowy padding 8 px i odstęp linii 2 px.
  Wiersz główny ma 82 / 78 px, bot 60 px, boczny i archiwalny minimum 40 / 36 px
  (48 px przy dotyku); szkielet archiwum ma tę samą wysokość. Znak projektu ma 20 px
  z inicjałami 10 px, znak aktywności slot 20 px i ikonę 18 px (boczny 16 px), avatar bota 44 px.
  Status wątku ma stały slot 96 px, czas bota 64 px, a licznik nieprzeczytanych 28 px;
  zmiany stanu nie przesuwają tekstu. Wartości pozostają w `rem`.
- Sidebar web/desktop używa wspólnego guttera `--sidebar-gutter` (12 px): wyrównuje
  treść wierszy, nagłówki grup, ikonę wyszukiwania i ikony dolnego paska. Tło wiersza
  ma inset `--sidebar-row-inset` (4 px), a padding wiersza to różnica tych tokenów
  (8 px). Wyszukiwarka i dolny pasek korzystają z tego samego insetu. Lista rezerwuje
  scrollbar tylko po prawej, bez dodatkowego pustego guttera po lewej.
  Wspólne klasy `sidebar-swap-resting` / `sidebar-swap-action` zamieniają status/czas
  na „…” oraz znak dostawcy/licznik na Archive. Oba sloty używają tego samego
  przenikania, skali i rozmycia (`--duration-fast`, `--ease-in-out`, `--scale-large`,
  `--blur-small`), bez opóźnienia ruchu w obie strony. Hover, fokus wewnątrz wiersza
  i otwarte menu utrzymują ten sam stan. Ograniczenie ruchu wyłącza przejścia.
- Mobile stosuje lokalnie kolejny stopień: tytuł 16 dp (linia 24), podpis 14 dp
  (linia 20), wiek i licznik bota 13 dp (linia 18), padding 8 dp i odstęp linii 2 dp.
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
  Panel szczegółów wątku używa `scroll-stable-both` (`stable both-edges`) do symetrycznych
  insetów kart. Sidebar i pozostałe duże obszary mają gutter na końcu.
