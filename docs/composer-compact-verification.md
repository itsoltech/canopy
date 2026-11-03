Kompozytor podczas czytania historii zachowuje widoczne podsumowania subagentów, kolejki i pytań asynchronicznych. Zwija edytor po 96 px celowego ruchu w górę i co najmniej 192 px od końca, również z fokusem. Pisanie, kliknięcie pola, nowy fokus, pliki, kontrolki lub powrót na dół (8 px) rozwijają go. Pytania synchroniczne wymagają pełnego widoku. Ten sam edytor zachowuje szkic, wzmianki i undo.

Przyczyny regresji i naprawa:

1. `ComposerFold > *` miał `overflow: hidden`, a `ComposerTop` rysował ring poza swoim prostokątem. To przycinało górną krawędź. Stos paneli pozostaje teraz poza foldem; przycinane są wyłącznie treści paneli. Dodatkowy 1 px miejsca chroni ring u góry. Test sprawdza piksele górnej obwódki z kolejką, subagentami i pytaniem w obu motywach.
2. Kompakt chował cały stos za plakietką. Teraz te same nagłówki zostają nad edytorem, mają 28 px wysokości i tekst 13 px. Body każdego panelu zwija się bez utraty stanu; ukryte kontrolki są `inert`. `TouchTarget size="sm"` pozostawia co najmniej 40 px obszaru dotyku. Kliknięcie podsumowania otwiera panel również wtedy, gdy poprzedzający click fokus już rozwinął kompozytor.
3. `ComposerCompaction.scroll()` ignorował ruch przy `focused`. Blokadę usunięto. Oddzielny `ScrollIntent` filtruje własne zapisy `scrollTop`, smooth scroll i ruch bez gestu; gesty obejmują wheel, touch, pasek i klawiaturę oraz krótką inercję. Pisanie kasuje tę dzierżawę. Nie rozmywamy edytora także na telefonach: nakładka nie wywołuje już przewijania feedu do normalnej pozycji kursora. Nie ma potrzeby chować klawiatury i odbierać możliwości natychmiastowego pisania.
4. Sticky footer należał do przepływu scrollerа, a `reservedFooter - footerHeight` dostawał wysokość z opóźnieniem jednej klatki. Przy siedmiu pozycjach kolejki i 20-liniowym szkicu test odtworzył **59 px** skoku: zmniejszenie `scrollHeight` ograniczało `scrollTop` przed uzupełnieniem rezerwy. Stopka jest teraz nakładką poza scrollerem, a rezerwa podczas czytania może tylko rosnąć. Nie trzeba kompensować animowanej wysokości w kolejnych klatkach. Kotwiczenie wirtualnych wierszy i wyłączone natywne `overflow-anchor` zostają.
5. Po „Jump to latest” zostawała stara kotwica. Streaming mógł wywołać `settle()` po wheel, zanim nadszedł scroll, i odtworzyć poprzednie miejsce czytania — test pokazał dodatkowe **205 px**. Przed odpięciem dołu wheel zapisuje teraz aktualną kotwicę. Powtórne powiadomienie o niezmienionym `scrollTop` nie jest nową intencją czytelnika.

Scalenie zmian timeline z `main` ujawniło też narastający dryf **1,84375 px light / 2,140625 px dark** przy streamingu na telefonie: nowa obsługa `scrollend` zapisywała kotwicę ponownie po każdej własnej korekcie całkowitoliczbowego `scrollTop`. Zaokrąglenie ~0,14 px odkładało się przy kolejnych fragmentach tekstu. Po `scrollend` kotwica jest teraz odświeżana wyłącznie po zakończeniu programowej nawigacji smooth; korekty zachowują oryginalny ułamkowy offset. Zapis regresji: `artifacts/composer-compact/rounding-regression-frames.json` i `rounding-regression.log`.

Pass `componentize`: wspólne `ComposerPanelHeader` i nowe `ComposerPanelBody` obsługują subagentów, kolejkę i pytania. Body centralizuje grid accordion, `inert` i zachowanie zamontowanej treści. Ring należy do `ComposerTop`, a nie do przycinanego body. Wewnątrz ringu stos ma osobny obszar przewijania do 40dvh, aby długa kolejka z pytaniem nie zakrywała całego telefonu. Kitowe komponenty pozostają w wrapperach; gęstość nie zależy od wygrywania sprzecznych klas Tailwind v4. `design` zachowuje istniejące tokeny i oba motywy; `transitions-dev` korzysta z tokenów w `routes/layout.css` i `shared/ui/motion.css`, bez nowych czasów wpisanych na sztywno. Reduced motion nie ma przejścia.

API integracji: `Composer.top`, `ThreadComposerSlot.children`, sloty `ComposerBox` i kotwica `MentionEditor` pozostają stabilne. `compact` paneli jest opcjonalnym, dodatkowym propem. Z aktualizacją `main` scalono `fix/mobile-composer-suggestions` (`07d7f19`), które umieszcza sugestie w tym samym stosie. Test 390 px w obu motywach otwiera teraz `/`, sprawdza pozycję panelu nad polem i zachowanie fokusu. Scalenie do `f452699` objęło także `feat/schedule-edit`, `feat/custom-form-controls`, poprawkę przepełnienia popoverów, ikony dostawców w Lineage/sidebarze, nowe zwijanie timeline (`28aef2b`), kreator botów, naprawę dostarczania powiadomień agent-bus (raporty platformowe poza kolejką użytkownika) i TurnRail. Konflikty `VirtualFeed` rozstrzygnięto z zachowaniem przerwania smooth scroll przez gest, kotwicy i filtra `ScrollIntent`. Rezerwa wyrównania ostatniej tury uwzględnia wysokość nakładki: `max(reservedFooter, footerHeight + alignmentSpace)`. Rzeczywista klawiatura iOS nadal wymaga weryfikacji na urządzeniu.

Panel subagentów pokazuje tylko pracujących (`creating` / `running`) i oczekujących na odpowiedź lub zgodę (`waiting_input` lub aktywne interakcje). Stan zamknięty/przerwany/nieudany wygrywa ze starym licznikiem interakcji. Bezczynni bez pytań, zakończeni, nieudani, przerwani i zamknięci nie trafiają do listy ani podsumowania. Bez aktywnych znika cały panel — również w kompakcie. Karty wywołań na osi czasu, Lineage i sidebar zachowują dostęp do zakończonych wątków. Wejście `t-rise` używa `--duration-fast` (także przy pierwszym montowaniu stosu), wyjście wiersza i ostatniego panelu współdzieli accordion z `--duration-quick`. Reduced motion jest natychmiastowe.

Testy korzystają z prywatnego PostgreSQL/gateway/scripted worker i produkcyjnego web na **5297**, z `/usr/bin/chromium` i `playwright-core`. Nie używają prywatnego stacka live ani portów 17443, 5180, 8444. Procesy są zamykane wyłącznie przez własne uchwyty. Historia zawiera 10 zakończonych tur ze zwiniętymi grupami pracy, markdown, bloki kodu oraz 50 kolejnych wiadomości i bieżący stream.

Tak jak w zestawie TurnRail, fixture podaje rzeczywiste pliki `build/client/_app/immutable` przez Playwright. Równoległe stosy Docker zmieniają interfejsy hosta, co potrafi anulować pobieranie modułów w Chromium (`ERR_NETWORK_CHANGED`). HTML, API i SSE nadal przechodzą przez prywatny stos; kod, CSS, fonty i gramatyki pochodzą z produkcyjnego buildu. Diagnostyka zbiera wyjątki strony i nieudane żądania.

Pomiar klatkowy zapisuje tożsamość i offset pierwszego widocznego wiersza po geście, a potem próbkuje ten sam wiersz przez `requestAnimationFrame` przez 650 ms. Przy zdarzeniach agentów mierzy od chwili przed wysłaniem zdarzenia do 650 ms po potwierdzeniu stanu przez UI, aby opóźnienie gatewaya nie kończyło pomiaru przed animacją. Dla desktopu używa natywnego wheel, dla telefonu natywnego dotyku CDP (jeden ruch trzymany nieruchomo przez przejście, bez mieszania zamierzonej inercji z dryfem). Sprawdza oba kierunki animacji, bez nowych delt i z deltami co 45 ms, 1440×1000 i 390×844, light/dark. Każda próbka musi mieć dryf **≤ 1 px**; test sprawdza też rzeczywistą zmianę wysokości, pośrednią przezroczystość przy wejściu agentów i zachowanie fokusu. Pełne próbki są w `artifacts/composer-compact/*-frames.json`.

Zestaw sprawdza też szybkie zmiany kierunku wokół progu bez przełączania stanu, podsumowania wszystkich paneli, ich otwieranie, synchroniczne pytanie, pliki przez drop/paste, wieloliniowy szkic, reduced motion, „Jump to latest”, Ctrl+End, brak przepełnienia poziomego i błędów przeglądarki. Cykl aktywnego subagenta obejmuje wejście, oczekiwanie na zgodę, odpowiedź, zakończenie, błąd, przerwanie i zamknięcie. Próbkuje wejście/wyjście panelu i wiersza w obu rozmiarach i motywach oraz natychmiastowe usunięcie z reduced motion. Test jednostkowy obejmuje też nieaktualne liczniki i ponowne wejście po wznowieniu pracy.

Pomiary po scaleniu `main` do `f452699`, maksymalny dryf we wszystkich klatkach (px):

| Widok | Bez nowych delt, oba kierunki | Streaming, zwijanie | Streaming, rozwijanie |
| --- | ---: | ---: | ---: |
| 1440 px, light | 0 | 0 | 0 |
| 1440 px, dark | 0 | 0 | 0 |
| 390 px touch, light | 0 | 0,4375 | 0,71875 |
| 390 px touch, dark | 0 | 0,4375 | 0,703125 |

Dodatkowe przejścia przy zamontowanych zwiniętych grupach pracy: 0 px w obu kierunkach we wszystkich czterech wariantach. Szybkie nawroty wokół 192 px: brak przełączeń. Próg akceptacji 1 px jest spełniony dla każdej próbki, a nie tylko dla końcowego obrazu.

Wejście panelu aktywnych agentów, wyjście wiersza, usunięcie ostatniego panelu, zamknięcie wątku i reduced motion: **0 px** w każdym rozmiarze/motywie. Łącznie 44 pomiary RAF. Pełny zestaw przeglądarkowy: **12 pass, 0 fail, 387 asercji**. Po konflikcie scalenia wykonano też kontrolę timeline na prywatnym porcie 5398: **3 pass, 0 fail, 36 asercji** (grupy pracy, zakończenie długiej odpowiedzi, brak ruchu czytelnika poza dołem, reduced motion). Artefakty i pełne logi są lokalne, ignorowane przez Git.

Po scaleniu TurnRail pełny zestaw jego browser checks na prywatnym porcie 5299 ma **6 pass, 0 fail, 81 asercji** (skoki do wirtualnych tur, podgląd, klawiatura, telefon, reduced motion). Dodatkowy `check:tmp apps/web/test/turn-rail.test.ts`: **7 pass, 0 fail, 1457 asercji**, bez pozostawionych plików. Pełny `check:tmp`: **868 pass, 170 skip, 0 fail, 3540 asercji**, pusty prywatny katalog tymczasowy. `bun install` bez zmian zależności; pełny `bun run typecheck` i web build mają kod 0, Svelte-check: **0 errors / 0 warnings**.

Polecenia:

```sh
bun install
bun run typecheck
bun run check:tmp
bun run --cwd apps/web build
CANOPY_COMPOSER_BROWSER=1 bun test tests/integration/composer-compact.browser.test.ts
```

Screenshoty (lokalne artefakty ignorowane przez Git):

| Widok | Kompakt z podsumowaniem agentów | Rozwinięty z obwódką i pytaniem |
| --- | --- | --- |
| Desktop, jasny | [compact](../artifacts/composer-compact/1440-light-idle-compact.png) | [expanded](../artifacts/composer-compact/1440-light-panels-after.png) |
| Desktop, ciemny | [compact](../artifacts/composer-compact/1440-dark-idle-compact.png) | [expanded](../artifacts/composer-compact/1440-dark-panels-after.png) |
| Telefon, jasny | [compact](../artifacts/composer-compact/390-light-idle-compact.png) | [expanded](../artifacts/composer-compact/390-light-panels-after.png) |
| Telefon, ciemny | [compact](../artifacts/composer-compact/390-dark-idle-compact.png) | [expanded](../artifacts/composer-compact/390-dark-panels-after.png) |

Cykl aktywnych agentów na telefonie: [panel podczas pracy](../artifacts/composer-compact/390-light-active-compact.png) i [brak panelu po zakończeniu](../artifacts/composer-compact/390-light-active-none.png).

Chromium z emulacją dotyku nie potwierdza zachowania rzeczywistej klawiatury iOS/Safari. Build może zgłaszać istniejące ostrzeżenia optymalizatora o `::highlight` i dużych chunkach. Svelte-check ma pozostać bez błędów i ostrzeżeń.
