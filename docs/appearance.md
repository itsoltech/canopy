# Wygląd i pełne palety

Status (2026-11-23): web, desktop i mobile używają zróżnicowanej palety
oznaczeń nowych i zapisanych projektów. Appearance jest lokalne dla profilu
przeglądarki, instalacji desktopowej i instalacji mobilnej, również po ponownym uruchomieniu.
Aktualizacja (2026-11-24): Desktop ma sekcję Accessibility z lokalnym wyborem obrysu fokusu.
Aktualizacja (2026-11-25): w panelu bocznym webu i desktopu warstwa śniegu ma
jeden ciągły brzeg na całej koronie drzewa.
Domyślny font interfejsu web i desktop ma etykietę Inter.
Oba pickery typografii współdzielą automatycznie wczytywaną listę rodzin, gdy klient ma do niej dostęp.
W web i desktopie Thread width obejmuje także widok PR i podgląd `Rendered` plików Markdown.
Aktualizacja (2026-11-28): w web i desktopie Themes pozwala tworzyć nazwane motywy
własne i edytować je w edytorze motywu zamiast osobnej zakładki Theme builder.
Corner radius i Spacing są w zakładce Interface. Propozycje bota otwierają się
jako nowy motyw własny.
**Preview in app** pokazuje edytowany motyw na ekranie, z którego otwarto
Settings. **Draft** i **Current** przełączają motyw w podglądzie.
Aktualizacja (2026-11-28): zakładka Motion w web i desktopie ma ustawienia animacji, ich tempa
i ograniczenia ruchu. Desktop udostępnia tę samą preferencję ograniczenia ruchu w Accessibility.

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

## Motywy własne

Web i desktop. Wbudowane motywy mają stałe palety; wybór jednego z nich usuwa
akcent i nadpisania kolorów w danym wariancie. Własne kolory należą do nazwanych
motywów własnych. Picker **Settings → Appearance → Themes** pokazuje je po wbudowanych,
w obu kolumnach. Motyw własny, tak jak wbudowany, ma wariant Light i Dark, a Light
i Dark można wybrać z różnych motywów. Paleta poleceń wymienia je jako
`Change theme › <nazwa> · Light` i `… · Dark`.

Karta motywu własnego ma w rogu wiersza nazwy okrągły przycisk z ołówkiem
(**Edit theme**). Przycisk leży obok radia, a nie w nim, więc strzałki nadal
przechodzą tylko między motywami, a Tab trafia też na ołówek. Przy kursorze
myszy jest półprzezroczysty i powiększa się po najechaniu na kartę. Po najechaniu
na sam przycisk albo fokusie z klawiatury wypełnia się kolorem akcji, a ołówek się
przechyla. Na ekranach dotykowych jest zawsze w pełni widoczny. Przy ograniczonym
ruchu przejścia są wyłączone. Nazwa ma zarezerwowane miejsce, więc długa nazwa
zawija się przed przyciskiem.

Ostatnia karta w każdej kolumnie, **New theme** z przerywaną ramką, otwiera edytor
z kopią kolorów używanych teraz w obu wariantach i nazwą `Custom theme` (kolejne:
`Custom theme 2` itd.). Edytor zaczyna od wariantu kolumny, z której go otwarto.
Motyw trafia do biblioteki dopiero po **Create theme**, które wybiera go dla Light
i Dark. Ołówek otwiera ten sam edytor dla istniejącego motywu; **Save theme**
zapisuje go i od razu aktualizuje każdy wariant, który go używa. **Cancel**
i **Themes** wracają do pickera bez zapisu, a fokus wraca na ołówek lub **New theme**.
**Delete theme** w edytorze po potwierdzeniu usuwa motyw; wariant, który go używał,
przechodzi na jego paletę bazową.

### Edytor motywu

Edytor zastępuje widok Themes w tej samej zakładce. Zawiera nazwę motywu oraz,
dla wariantu wybranego przełącznikiem Light / Dark, paletę bazową i gotowy akcent.
Aktywnym wariantem aplikacji nadal steruje Color scheme.

Każdy ze 102 kolorów w wariancie ma własny próbnik i pole hex. Podstawowa
lista pokazuje role interfejsu, a **Advanced shades** zawiera odcienie neutralne,
odcienie akcentu i odcienie statusów. Kolor można przywrócić osobno lub wyczyścić
nadpisania wariantu przyciskiem **Reset colors**. **Randomize both palettes**
losuje wspólny odcień bazowy i jedną z trzech harmonii na kole OKLCH
(analogiczną, dopełniającą rozdzieloną lub triadę). Jasności dla obu wariantów
dobierane są oddzielnie, a kolory statusów zachowują swoje znaczenie.
Podgląd sygnalizuje niski kontrast tekstu, akcentu i przycisków.

**Preview in app** odsłania bieżący ekran Canopy i tymczasowo zmienia jego
paletę. Pasek podglądu pozwala przełączyć Light lub Dark oraz porównać **Draft**
z **Current**, czyli wyglądem używanym teraz. **Back to editor** lub Escape przywraca
wygląd okna i zachowuje szkic w edytorze. Podgląd dotyczy bieżącego okna.

### Kształt interfejsu

**Settings → Appearance → Interface → Corner radius** skaluje wspólne promienie
narożników kontrolek i powierzchni. **Spacing** zmienia padding dymków wiadomości,
odstępy w Settings oraz padding kart wątków w sidebarze przy precyzyjnym wskaźniku.
Oba ustawienia działają od razu i dotyczą każdego motywu, więc różne motywy Light
i Dark mają te same narożniki i odstępy. Minimalne cele dotykowe korzystają ze skali
interfejsu. **Reset appearance** przywraca wartości domyślne wyglądu, w tym Birch /
Birch; biblioteka motywów własnych zostaje.

### Propozycje bota

W prywatnej rozmowie właściciel może poprosić bota o zmianę motywu. Akcja
**Review theme** w rozmowie otwiera edytor nowego motywu `Proposed theme`, z kolorami
używanymi teraz i zmianami z propozycji. Jeśli propozycja zmienia też zaokrąglenie
lub odstępy, edytor o tym informuje, a podgląd je uwzględnia. **Create theme**
zapisuje motyw, wybiera go dla obu wariantów i stosuje te ustawienia kształtu. [Boty](bots.md).

### Zapis motywów własnych

Biblioteka motywów własnych jest w localStorage profilu przeglądarki dla hosta Canopy
albo profilu Electron desktopu, tak jak inne lokalne preferencje Appearance. Cookie
wyglądu przechowuje identyfikator wybranego motywu oraz jego rozwiązane kolory,
akcent i paletę bazową dla każdego wariantu, więc pierwszy render, cache startowy
desktopu i natywny chrom okna nie potrzebują biblioteki. Zapis lub usunięcie motywu
odświeża inne karty tego samego profilu.

Kolory, akcent lub nadpisania zastosowane bez motywu w bibliotece (zapisane przed
motywami własnymi albo po wyczyszczeniu localStorage) przy starcie stają się motywem
`Custom theme`, który wybrany jest w tych samych wariantach. Dzięki temu picker
zawsze pokazuje i pozwala edytować to, czego używa aplikacja.

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

## Sezonowe akcenty w web i desktopie

**Settings → Appearance → Interface → Seasonal accents** steruje dekoracją drzewa
w panelu bocznym. Ustawienie jest domyślnie włączone i zapisuje się w
profilu klienta. **Reset appearance** przywraca wartość domyślną.

Śnieg na koronie drzewa pojawia się co roku od 1 grudnia o 00:00 do 7 stycznia
o 00:00 (koniec wyłączny), według czasu lokalnego urządzenia. Widoczny panel
sprawdza datę o północy oraz po odzyskaniu fokusu okna. Poza okresem i po
wyłączeniu preferencji korona wygląda jak zwykle. Statyczna dekoracja korzysta
z bieżącej palety. Technologie asystujące ją pomijają, a systemowe wymuszone
kolory ukrywają ilustrację.

Wąski web pokazuje ją w otwartym menu nawigacji. Desktop w trybie lokalnym i
zdalnym używa tego samego renderera. Zakres obejmuje ilustrację w panelu
bocznym tych klientów. Akcenty są częścią kodu aplikacji. Dodanie okazji
polega na podaniu identyfikatora i granic w lokalnym kalendarzu oraz dodaniu
dekoracji dla tego identyfikatora. Przy nakładających się okresach obowiązuje
pierwszy pasujący wpis.

## Ruch w web i desktopie

W **Settings → Appearance → Motion** przełącznik **Animations** jest domyślnie włączony.
**Animation speed** ustala czas trwania przejść. Standard (domyślnie) zachowuje ich
podstawowy czas, Fast skraca go do 70%, a Slow wydłuża do 150%.
**Reduce motion** domyślnie korzysta z ustawienia systemu (**System**). **Always**
ogranicza ruch także wtedy, gdy system zezwala na animacje. Przy ograniczonym ruchu
wybrane tempo dotyczy także zachowanych przejść przez przenikanie. Wyłączenie
**Animations** pomija animacje i zachowuje tempo do ponownego włączenia.

Przy włączonym module Bots zakładka Motion zawiera także **Animated mascots**.
Maskotki respektują ustawienia ruchu nawet przy włączonej animacji oczu i mimiki.
Wybory są lokalne dla profilu przeglądarki lub instalacji desktopowej. Reset
przy wierszu przywraca domyślną wartość tego ustawienia. **Reset appearance**
przywraca wszystkie domyślne ustawienia ruchu. Osobne okno Activity Notch na desktopie
respektuje systemową preferencję ograniczenia ruchu.

## Dostępność w Desktopie

**Settings → Accessibility → Focus indicators** określa, kiedy Canopy rysuje obrys
aktywnej kontrolki. Domyślne **Keyboard only** pokazuje go podczas nawigacji
klawiaturą. W szerokim oknie kliknięcie zębatki otwiera ustawienia z fokusem w wyszukiwarce,
więc można od razu pisać bez obrysu wokół pola. **Always** pokazuje obrys również
po kliknięciu, a **Off** go ukrywa. Przy systemowych wymuszonych kolorach
obrys pozostaje widoczny w każdym trybie.

W tej samej sekcji są **Reduce motion**, **Contrast**, **Interface size**, **Diff colors**
przy włączonym module Threads i **Animated mascots** przy włączonym module Bots.
Korzystają z tych samych wartości co w Appearance i Diffs.

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
