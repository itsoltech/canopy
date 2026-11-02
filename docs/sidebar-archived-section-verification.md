# Weryfikacja sekcji Archived

Gałąź: `feat/sidebar-archived-section`. Zmiany zapisane lokalnie; bez pushowania i bez PR.
Przed zakończeniem scalono bieżący `main`, w tym harmonogramy z migracją `0027`, ikony Lucide
i jaśniejszy stan spoczynkowy przycisków ikon. Archiwum korzysta z migracji `0028_archive_cascade`.

## Rezultat i decyzje

Sekcja Archived znajduje się za aktywnymi wątkami. Nagłówek ma licznik, chevron i przycisk z
`aria-expanded` / `aria-controls`; licznik ogłasza zmiany przez `aria-live=polite`. Rozwinięcie
zapisuje się w ustawieniach użytkownika gatewaya. Filtr projektów nie ma już przełącznika archiwum.

Gateway stronicuje główne wiersze po 20 i zwraca ich dzieci osobno, wyłącznie dla załadowanej strony.
Licznik obejmuje główne wiersze. Filtr i wyszukiwanie działają po stronie gatewaya; tytuł dziecka
może dopasować jego rodzica. Kursor używa czasu archiwizacji z dokładnością do mikrosekund i id,
jest związany z użytkownikiem oraz filtrem. Zwinięta sekcja pobiera tylko licznik. Bieżący archiwalny
wątek ładuje się osobno i pozostaje przypięty przy dolnej krawędzi podczas przewijania.

Archiwizacja głównego obejmuje jego aktywne dzieci (`archived_by=cascade`) i zapisuje przerwania
przed ukryciem. Przywrócenie odtwarza wyłącznie tę kaskadę. Wcześniejsze niezależne archiwizacje
użytkownika i agenta pozostają zachowane. W Archived dzieci są pod rodzicem w Previous agents;
boczne pod aktywnym rodzicem pozostają tylko przy nim.

Pass **componentize** wydzielił `SidebarThreadChildren`, współdzielony przez listę aktywną i archiwum.
`SidebarArchivedThreads` odpowiada za sekcję, `SidebarArchivedThread` za kompaktowy wiersz,
a `SidebarThreadLink` nadal obsługuje wspólne menu. Odstępy zewnętrzne pochodzą z miejsc użycia.
Animacje korzystają z istniejących `expand`, `rise`, `reorder` i `.t-acc-chevron`, opartych na tokenach
`layout.css` / `motion.css`. Wiersz ma stałą wysokość 36 px na desktopie i 40 px na telefonie.
Przejście między przypiętym wierszem a listą używa nakładających się komórek siatki, bez sumowania
ich wysokości; element wychodzący staje się nieinteraktywny. Zewnętrzny wrapper pozycjonuje menu,
bez konfliktu `absolute` z własnym `relative` komponentu IconButton.

## Sprawdzenia

| Polecenie | Wynik |
| --- | --- |
| `bun install` | zależności zainstalowane; kolejne wywołanie bez zmian lockfile |
| `bun run typecheck` | wszystkie pakiety poprawne; svelte-check: 0 błędów i 0 ostrzeżeń |
| `bun run gen:check` | kontrakty zgodne z wygenerowanym kodem |
| `bun run check:tmp` | 786 zaliczonych, 115 pominiętych, 0 błędów; prywatny katalog testowy pusty |
| `bun run --filter @open-agents/web build` | poprawny build adapter-node; istniejące ostrzeżenie o chunku ponad 500 kB |
| `OA_ARCHIVE_BROWSER=1 OA_BROWSER_TESTS=1 bun test tests/integration/archived-sidebar.browser.test.ts tests/integration/sidebar-browser.test.ts` | 4 scenariusze Chromium zaliczone |

Testy jednostkowe sprawdzają grupowanie, sortowanie, filtr, ukrywanie dzieci archiwalnego rodzica
także w trakcie kaskady live, wyjątek bieżącego wątku po zwinięciu, kolejne strony, odrzucenie
spóźnionych odpowiedzi, retry i zachowanie liczby załadowanych stron przy odświeżeniu.

Testy gatewaya sprawdzają granice 20/20/15, powtarzalne znaczniki czasu z mikrosekundami, limit,
licznik bez wierszy, projekty, wyszukiwanie, niepoprawne i obce filtrom kursory, Previous agents,
kaskadę, przerwanie działającego dziecka, anulowanie kolejki i harmonogramu, przywracanie wyłącznie
kaskady oraz zachowanie wcześniejszych niezależnych archiwizacji. Testy schematu sprawdzają migracje.

## Chromium i zrzuty

`/usr/bin/chromium`, Playwright Core. Osobny PostgreSQL w kontenerze na losowym porcie,
gateway na losowym porcie i web `127.0.0.1:5396`; wcześniejsze testy sidebaru używają własnego
web `5298`. Nie używano `/tmp/oa-stack` ani portów `17443`, `5180`, `8444`.
Stosy, przeglądarki i katalogi profili są zamykane po testach.

Zestaw danych zawiera 55 głównych wątków archiwalnych, 35 aktywnych oraz osobne drzewo do testu
kaskady z aktywnym i wcześniej zamkniętym dzieckiem. Sprawdzono 1440×1000 i 390×844, oba motywy,
strony 20/40/55, brak duplikatów po zakończeniu animacji, stan po przeładowaniu, przypięcie przy
przewijaniu, archiwizację i przywrócenie przez menu, grupowanie dzieci, filtr, wyszukiwanie,
reduced motion oraz niezmienną wysokość wiersza przy najechaniu. Dodatkowe asercje pilnują,
żeby długi tytuł miał wielokropek i żeby czas mieścił się w obrębie wiersza, także na telefonie.

| Widok | Zrzuty w `artifacts/sidebar-archived-section/` |
| --- | --- |
| Desktop, jasny | `desktop-light-collapsed-current.png`, `desktop-light-expanded.png` |
| Desktop, ciemny | `desktop-dark-collapsed-current.png`, `desktop-dark-expanded.png` |
| Telefon, jasny | `mobile-light-collapsed-current.png`, `mobile-light-expanded.png` |
| Telefon, ciemny | `mobile-dark-collapsed-current.png`, `mobile-dark-expanded.png` |
| Kaskada z dziećmi | `desktop-dark-cascade-group.png` |

Zrzuty są lokalnymi artefaktami, wyłączonymi z Git. Pominięte testy live wymagają prawdziwych
dostawców; sprawdzenia gatewaya i przeglądarki używają programowanego workera bez ich danych logowania.
Podczas przeładowania strony BFF raz zalogował anulowanie subskrypcji (`ConnectError: canceled`);
testy zakończyły się bez błędów, a lista błędów JavaScript strony pozostała pusta.
