# Wygląd i pełne palety

Status (2026-11-23): web, desktop i mobile używają zróżnicowanej palety
oznaczeń nowych i zapisanych projektów. Appearance jest lokalne dla profilu
przeglądarki, instalacji desktopowej i instalacji mobilnej, również po ponownym uruchomieniu.
Aktualizacja (2026-11-24): Desktop ma sekcję Accessibility z lokalnym wyborem obrysu fokusu.
Domyślny font interfejsu web i desktop ma etykietę Inter.
Oba pickery typografii współdzielą automatycznie wczytywaną listę rodzin, gdy klient ma do niej dostęp.
W web i desktopie Thread width obejmuje także widok PR i podgląd `Rendered` plików Markdown.

Settings → Appearance pozwala wybrać osobno motyw Light i Dark. Color scheme
(System / Light / Dark) określa, który wariant jest aktywny. Przykład: Fern dla
Light i Heather dla Dark; System przełącza je zgodnie z preferencją urządzenia.
Zmiana jednego wariantu zachowuje drugi. Paleta poleceń udostępnia te same wybory
jako `Change theme › Fern · Light` i `Change theme › Heather · Dark`.

## Picker

Porównano w przeglądarce trzy warianty przez ui.sh: miniatury powłoki aplikacji,
paski próbek oraz etykiety z liściem. Wybrano miniatury: pokazują jednocześnie
sidebar, tło rozmowy, tekst i kompozytor, więc prezentują pełną paletę. Dwie grupy
Light / Dark mają niezależne znaczniki i nazwy bieżącego wyboru. Na telefonie każda grupa ma jedną
kolumnę, w szerszym kontenerze dwie.
Każda grupa zawiera siedem motywów. Wspólna miniatura ma wysokość 48 px
(wcześniej 64–72 px), a karty mają mniejszy padding i odstępy. Dzięki temu dodanie
siódmego wyboru nie zwiększa wysokości listy na telefonie; na desktopie dochodzi
jeden krótszy rząd. Nazwy mogą się zawijać bez rozszerzania kolumn.
Sekcja Color scheme korzysta ze wspólnego wiersza SettingsRow (opis po lewej,
kontrolki po prawej), a obie sekcje z SettingsGroup i tokenów gęstości ustawień.

Wspólny `OptionTile` to przycisk z `role="radio"` i `aria-checked` wewnątrz
opisanej grupy `radiogroup`. Tab przechodzi do zaznaczonej opcji, strzałki wybierają
poprzednią/następną, Home/End pierwszą/ostatnią. Spacja i Enter korzystają z
natywnej obsługi przycisku. Widoczny znacznik i komunikat statusu opisują oba
wybory. Nie ma natywnych radio ani animacji wymagających osobnych wyjątków dla
ograniczonego ruchu; pozostałe przejścia używają tokenów zestawu UI.

## Palety i tokeny

Źródłem jest `packages/ui/src/themes.ts`. Każdy motyw ma osobną skalę neutralną
Light / Dark, akcent i semantyczne tokeny: canvas, surface, panel, hover, ink,
muted, border, accent, action, action-hover, on-accent, on-control. Kolory statusów zachowują
znaczenie (zielony sukces, różowy błąd itd.), z domieszką palety i mocniejszym
odcieniem dla tekstu. `themes.css` nakłada tokeny na istniejące klasy Tailwind
zinc, white/black, brand i statusy, łącznie z modyfikatorami przezroczystości.
Wspólna powłoka, dialogi, popovery, pola i przyciski używają też nazw semantycznych.
Zmiana motywu obejmuje istniejące ekrany bez warunków zależnych od nazwy motywu.

Kolor oznaczenia projektu wynika z hasza jego nazwy i wspólnej palety ośmiu
odcieni. Ta sama nazwa daje ten sam odcień na każdym kliencie, a zmiana nazwy
może zmienić odcień. Klient wylicza kolor przy wyświetlaniu także dla zapisanych
projektów. Aplikacja nie zapisuje koloru projektu ani nie oferuje jego wyboru.

| Motyw | Charakter | Canvas Light | Canvas Dark |
| --- | --- | --- | --- |
| Birch | kreda, niebieski atrament | `#fffefa` | `#171914` |
| Fern | liście, leśny cień | `#fbfef9` | `#112010` |
| Lagoon | szkło morskie, głęboki morski | `#f9feff` | `#0d1c26` |
| Cedar | piasek, drewno sekwoi | `#fffcf7` | `#20150f` |
| Heather | liliowa mgła, fiolet zmierzchu | `#fefbff` | `#1b1223` |
| Blossom | płatki, morwa | `#fffbfd` | `#23121f` |
| Ash | czysta biel, prawdziwa czerń | `#ffffff` | `#000000` |

Ash ma neutralne, nietonowane szarości. Canvas, surface i panel są identyczne:
`#ffffff` w Light i `#000000` w Dark, także dla tła okna i nakładki paska tytułu
desktopu. Hover to `#f5f5f5` / `#171717`, border `#d9d9d9` / `#383838`,
ink `#111111` / `#ffffff`, a muted `#666666` / `#bfbfbf`. Akcent to
`#111111` / `#d4d4d4`; akcje używają `#111111` / `#ffffff`, hover i naciśnięcie
akcji `#303030` / `#d4d4d4`, a etykiety `on-accent` to `#ffffff` / `#000000`.
Neutralna skala brand jest osobna dla każdego trybu: zaznaczone kontrolki używają
`#262626` / `#e5e5e5`, a ich fokus `#404040` / `#e5e5e5`. Znaczniki checkboxów,
radia i kciuk zaznaczonego Switch korzystają z `on-control`: w Ash to biel / czerń,
co zachowuje widoczność na jasnym torze w Dark. Pozostałe motywy zachowują swoje
palety oraz dotychczasowy, tonowany kolor znaczników (`zinc-0`). Niezaznaczony
Switch nadal ma jasny kciuk; disabled zachowuje neutralne tła lub opacity 50%.
Kolory statusów, diffów i składni nadal
zachowują swoje znaczenie. Ash można mieszać z dowolnym innym motywem.

Poniższe liczby to minimalne współczynniki kontrastu WCAG obliczone z luminancji
sRGB na canvas, surface, panel i hover. „Pomocniczy” oznacza istniejący tekst
zinc-500 w Light i zinc-400 w Dark; semantyczny muted w Dark jest mocniejszy.
Wartości w parach oznaczają Light / Dark. Etykieta akcji to on-accent na action;
fokus to accent względem tych samych powierzchni. Status to minimum sześciu
kolorów tekstu statusów (600 w Light, 400 w Dark).

| Motyw | Tekst główny | Tekst pomocniczy | Etykieta akcji | Fokus | Status |
| --- | --- | --- | --- | --- | --- |
| Birch | 15,03 / 10,99 | 4,91 / 4,79 | 6,83 | 5,82 / 4,55 | 5,35 / 5,62 |
| Fern | 14,00 / 10,71 | 4,72 / 4,76 | 5,36 | 4,45 / 6,02 | 5,21 / 5,48 |
| Lagoon | 14,17 / 10,61 | 4,77 / 4,96 | 5,86 | 4,88 / 5,29 | 5,22 / 5,42 |
| Cedar | 14,21 / 11,39 | 4,56 / 4,93 | 5,22 | 4,18 / 5,36 | 5,02 / 5,96 |
| Heather | 14,04 / 11,34 | 4,96 / 4,79 | 7,30 | 5,81 / 4,51 | 4,99 / 6,03 |
| Blossom | 14,17 / 11,25 | 5,00 / 4,77 | 5,91 | 4,70 / 4,58 | 5,03 / 5,91 |
| Ash | 17,32 / 17,93 | 5,27 / 7,11 | 18,88 / 21,00 | 17,32 / 12,09 | 5,67 / 7,91 |

Ash zmierzono w przeglądarce na rzeczywistych wartościach CSS (statusy po
rozwiązaniu `color-mix` przez Canvas 2D do sRGB). Dodatkowe pomiary Ash:

| Para | Light | Dark |
| --- | --- | --- |
| Etykieta akcji na hover i przy naciśnięciu | 13,20:1 | 14,17:1 |
| Fokus kontrolek względem powierzchni (minimum) | 9,51:1 | 14,23:1 |
| Zaznaczony tor względem powierzchni (minimum) | 13,88:1 | 14,23:1 |
| Kciuk / znacznik względem zaznaczonego tła | 15,13:1 | 16,67:1 |

Minima obejmują canvas, surface, panel i hover. Pomiary aktywnych stanów
nie obejmują celowo osłabionych kontrolek disabled.

Te pary tekstu przekraczają AA 4,5:1 (również próg AA dla dużego tekstu 3:1),
a fokus przekracza 3:1. Pomiar dotyczy tokenów; nie jest audytem każdego
indywidualnego napisu, przezroczystości, obrazu ani treści dostarczonej przez agenta.

## Zapis i pierwszy render

Schemat kolorów, obie palety i szerokość wątku są zapisywane na kliencie,
tak jak pozostałe ustawienia Appearance. Web zapisuje je w cookie profilu
przeglądarki dla hosta Canopy, desktop w odrębnym profilu Electron, a mobile
w pamięci aplikacji. Można mieć inny wygląd na każdym urządzeniu, także przy
połączeniu z tym samym gatewayem. Zmiany z Settings i palety poleceń stosują te
same preferencje. Restore device defaults przywraca System, Birch / Birch,
Comfortable i domyślne pozostałe ustawienia Appearance.

Przy pierwszym odczycie ustawień konta klient bez zapisanego wyglądu kopiuje
poprzednie wartości. Późniejsze odczyty konta nie nadpisują lokalnego wyboru.
Jawna zmiana lub reset przed pierwszym odczytem od razu zapisuje lokalne wartości.
Dla starego wariantu UNSPECIFIED kopiowanie tłumaczy także dawny akcent
(Default → Birch, Grove → Fern, Ocean → Lagoon, Ember → Cedar, Iris → Heather,
Rose → Blossom). Istniejące pola proto i zapis gatewaya obsługują starsze klienty
oraz dostarczają wartości początkowe przy migracji.

Powłoka HTML wstawia obie palety i atrybuty z walidowanego cookie bez odczytu
wyglądu przez gRPC. Skrypt w head rozstrzyga System przed pierwszym renderem.
Karty tego samego webu reagują na zmianę zapisaną w ich wspólnym profilu.
Desktop zapisuje schemat i obie palety także w `appearance-cache.json` w userData.
Preload przekazuje je przez walidowane IPC do powłoki startowej, gdy nie ma
cookie. Main stosuje te kolory podczas tworzenia okna i aktualizuje jego tło
i nativeTheme po zmianie preferencji. W System chrom reaguje na systemowy
schemat. Błąd zapisu opcjonalnego cache nie blokuje zmiany aktywnego wyglądu.

## Szerokość w web i desktopie

Settings → Appearance → Interface → Thread width ustawia szerokość rozmowy
i jej kompozytora, widoku PR oraz podglądu `Rendered` plików Markdown.
Comfortable ogranicza kolumnę do 48 rem, Wide do 60 rem, a Full width wypełnia
dostępny obszar. Pasek pliku i widok `Source`, w tym edytor, zajmują całą
dostępną szerokość karty.

## Typografia w web i desktopie

Inter jest domyślnym fontem interfejsu. Po otwarciu pickera Desktop oraz
przeglądarki z udzieloną zgodą wczytują rodziny zainstalowane na urządzeniu.
Przeglądarka, która potrzebuje zgody, wyświetla akcję **Show installed fonts**.
Gdy odczyt listy jest niedostępny, nadal można wpisać nazwę rodziny i obejrzeć próbkę.

## Dostępność w Desktopie

**Settings → Accessibility → Focus indicators** określa, kiedy Canopy rysuje obrys
aktywnej kontrolki. Domyślne **Keyboard only** pokazuje go podczas nawigacji
klawiaturą. W szerokim oknie kliknięcie zębatki otwiera ustawienia z fokusem w wyszukiwarce,
więc można od razu pisać bez obrysu wokół pola. **Always** pokazuje obrys również
po kliknięciu, a **Off** go ukrywa. Przy systemowych wymuszonych kolorach
obrys pozostaje widoczny w każdym trybie.

W tej samej sekcji są **Contrast**, **Interface size**, **Diff colors** przy włączonym
module Threads i **Animated mascots** przy włączonym module Bots. Korzystają z tych
samych wartości co w Appearance i Diffs. Animacje maskotek respektują także systemową
preferencję ograniczonego ruchu.

Wybory zapisuje profil Electron w localStorage pod stałym adresem lokalnego interfejsu.
Zmiana obowiązuje od razu, także w innych oknach tej instalacji. Oba tryby Desktop
korzystają z tego zapisu również po restarcie i zmianie połączonego gatewaya.
Każdy zmieniony wiersz umożliwia przywrócenie wartości domyślnej.

## Kontrola wyglądu

Po zbudowaniu webu regresję startu i przeładowania bez gatewaya można sprawdzić
w rzeczywistym Electronie poleceniem
`CANOPY_LIVE=1 bun run check:tmp ./apps/desktop/test/startup-appearance.integration.test.ts`.
Test obejmuje Light i Dark przy przeciwnej preferencji systemu oraz oba warianty System.

Zmiany palety sprawdzaj w obu trybach, także z różnymi wariantami light/dark
i ustawieniem System. Uwzględnij picker, sidebar, kompozytor z długą ścieżką
i Unicode, dialog, popover oraz kod/diff przy szerokości desktopu i telefonu.
Natywne tło okna i symbole paska tytułu wymagają osobnej kontroli w Electron.
