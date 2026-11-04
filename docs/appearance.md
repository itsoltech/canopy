# Wygląd i pełne palety

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
muted, border, accent, action, action-hover, on-accent. Kolory statusów zachowują
znaczenie (zielony sukces, różowy błąd itd.), z domieszką palety i mocniejszym
odcieniem dla tekstu. `themes.css` nakłada tokeny na istniejące klasy Tailwind
zinc, white/black, brand i statusy, łącznie z modyfikatorami przezroczystości.
Wspólna powłoka, dialogi, popovery, pola i przyciski używają też nazw semantycznych.
Zmiana motywu obejmuje istniejące ekrany bez warunków zależnych od nazwy motywu.

| Motyw | Charakter | Canvas Light | Canvas Dark |
| --- | --- | --- | --- |
| Birch | kreda, niebieski atrament | `#fffefa` | `#171914` |
| Fern | liście, leśny cień | `#fbfef9` | `#112010` |
| Lagoon | szkło morskie, głęboki morski | `#f9feff` | `#0d1c26` |
| Cedar | piasek, drewno sekwoi | `#fffcf7` | `#20150f` |
| Heather | liliowa mgła, fiolet zmierzchu | `#fefbff` | `#1b1223` |
| Blossom | płatki, morwa | `#fffbfd` | `#23121f` |

Poniższe liczby to minimalne współczynniki kontrastu WCAG obliczone z luminancji
sRGB na canvas, surface, panel i hover. „Pomocniczy” oznacza istniejący tekst
zinc-500 w Light i zinc-400 w Dark; semantyczny muted w Dark jest mocniejszy.
Wartości w parach oznaczają Light / Dark. Etykieta akcji to biały tekst na action;
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

Te pary tekstu przekraczają AA 4,5:1 (również próg AA dla dużego tekstu 3:1),
a fokus przekracza 3:1. Pomiar dotyczy tokenów; nie jest audytem każdego
indywidualnego napisu, przezroczystości, obrazu ani treści dostarczonej przez agenta.

## Zapis i pierwszy render

Addytywne pola proto `AppearanceSettings.light_theme` (5) i `dark_theme` (6)
używają nowego enumu `ColorTheme`. Gateway zapisuje je w istniejącej sekcji
appearance w `user_settings`, w zakresie właściciela. Nie jest potrzebna migracja
schematu bazy. Obowiązują istniejące wersjonowanie, konflikt 409 oraz dystrybucja
ustawień przez Overview. Test integracyjny sprawdza zapis, odczyt i zachowanie
obu wariantów przy zmianie innej sekcji z drugiego urządzenia.
Udostępnianie wyglądu między połączonymi komputerami przenosi także oba warianty;
osobny test synchronizacji sprawdza je wraz z zachowaniem lokalnej szerokości sidebara.

Gdy wariant jest UNSPECIFIED, dziedziczy dotychczasowy zapisany akcent:
Default → Birch, Grove → Fern, Ocean → Lagoon, Ember → Cedar, Iris → Heather,
Rose → Blossom. Stare pole i numery enumów pozostają w kontrakcie; nowe UI
zapisuje osobne warianty. Nowy właściciel zaczyna od Birch / Birch i System.

Powłoka SSR wstawia oba zestawy bezpiecznych, stałych wartości CSS oraz atrybuty
wyboru do HTML. Skrypt w head ustala System przed pierwszym renderem; szkielet
ładowania korzysta z tych samych kolorów. Zatwierdzony zapis przez BFF aktualizuje
też trzysekundowy cache powłoki, więc szybkie przeładowanie nie przywraca starej
palety. Odpowiedź starszego odczytu nie może nadpisać potwierdzonego zapisu.
Cache BFF zachowuje istniejące założenie pojedynczego użytkownika deweloperskiego;
autorytatywny zapis pozostaje w gateway i bazie, nie w localStorage.

Desktop przechowuje wyłącznie `{ scheme, light, dark }` w opcjonalnym
`appearance-cache.json` w userData. Walidowane IPC wymaga zaufanego nadawcy;
preload udostępnia odczyt startowy, a tylko lokalny ekran `/desktop` nakłada ten
cache przed renderem. Po połączeniu obowiązują ustawienia gatewaya. Main ustawia
tło okna i nativeTheme, a na Linux/Windows także tło i kolor symboli natywnej
nakładki paska tytułu. Zmiana preferencji systemowej aktualizuje chrom okna.
Błąd zapisu opcjonalnego cache nie blokuje zmiany aktywnego wyglądu.

## Weryfikacja wizualna

Ręcznie sprawdzono wszystkie sześć motywów w obu trybach na desktopie i telefonie,
mieszankę Fern Light / Heather Dark z System, nawigację klawiaturą, zapis i świeży
HTML. Obejrzano sidebar, widok wątku, kompozytor, ustawienia, popovery i wspólny
dialog formularza. Przy szerokości 390 px nie stwierdzono poziomego overflow.
Nie dodano testów UI. Materiały sesji są w `~/.cache/canopy-themes/`:
`desktop-<theme>-<mode>.png`, `phone-<theme>-<mode>.png`, arkusze
`desktop-palettes.png`, `phone-palettes.png`, `ideas-comparison.png` oraz zrzuty
widoków wątku, popoverów i dialogów. Nie uruchamiano natywnego okna Electron;
wizualne zachowanie nakładki Linux/Windows i paska macOS wymaga potwierdzenia
w aplikacji desktopowej.
