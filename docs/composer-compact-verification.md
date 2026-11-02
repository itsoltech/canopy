Kompozytor wątku zwija się podczas czytania historii i rozwija po powrocie na dół, fokusie, pisaniu, drop/paste, otwarciu kontrolek albo „Jump to latest”. Ten sam edytor pozostaje zamontowany: szkic, wzmianki i cofanie są zachowane. Próg zwijania to 192 px od końca oraz 96 px ruchu w górę; powrót używa progu feedu 8 px. Małe ruchy, streaming i zmiana wysokości stopki nie przełączają stanu.

1. Wąski widok pozostawia pierwszą linię i send/stop; wspólna plakietka otwiera zachowane panele kolejki i subagentów. Oczekujące pytania utrzymują pełny widok, również synchroniczne „agent is waiting”.
2. Feed zachowuje zwolnioną przestrzeń pod wiadomościami i kotwiczy czytany wiersz. Chroni też przed natywnym przewijaniem lepkiego contenteditable podczas wpisywania tekstu. Gradient i przycisk powrotu korzystają z aktualnej wysokości stopki.
3. Ruch korzysta wyłącznie z tokenów: otwieranie `--duration-slow`, zamykanie `--duration-medium`, reduced motion bez przejścia. Fokus edytora używa `preventScroll`, synchronicznie w geście dotykowym.
4. Panele także w pełnym widoku mają mniejszą typografię (tytuły 14/13 px, tekst pomocniczy 13/12 px), nagłówki 36/32 px i wiersze kolejki/subagentów 36/40 px. Dostawcy mają ikony 14 px, chevrony 12 px, a cele dotykowe co najmniej 40 px.
5. Osobny pass `componentize` wydzielił `ComposerFold`, `ComposerPanelBadge`, wspólny kontrakt przewijania oraz `ComposerPanelHeader`. Rozmiary kitowych ikon i `TouchTarget` są propsami; nie polegają na wygrywaniu sprzecznych klas Tailwinda.

Weryfikacja działa na prywatnym PostgreSQL/gateway/scripted worker i produkcyjnym buildzie web na porcie 5297, z `/usr/bin/chromium` i `playwright-core`. Test nie używa współdzielonego stosu ani portów 17443, 5180 i 8444. Każdy uruchomiony proces jest zamykany przez własny uchwyt.

Polecenia: `bun install`, `bun run typecheck`, `bun run check:tmp`, `bun run --cwd apps/web build`, `OA_COMPOSER_BROWSER=1 bun test tests/integration/composer-compact.browser.test.ts`. Testy jednostkowe maszyny stanów obejmują progi, histerezę, fokus, pisanie, drop/paste, menu, dół feedu i pytanie synchroniczne. Test przeglądarkowy mierzy ten sam wiersz przed/po zwinięciu, streamingu i pisaniu; sprawdza też przewinięcie na dół, Ctrl+End, panele, pliki, reduced motion, rozmiary nagłówków/ikon i cele dotykowe.

Screenshoty kompozytora (1440×1000 oraz 390×844 z emulacją dotyku):

| Widok | Kompaktowy | Rozwinięty |
| --- | --- | --- |
| Desktop, jasny | [compact](../artifacts/composer-compact/1440-light-compact.png) | [expanded](../artifacts/composer-compact/1440-light-expanded.png) |
| Desktop, ciemny | [compact](../artifacts/composer-compact/1440-dark-compact.png) | [expanded](../artifacts/composer-compact/1440-dark-expanded.png) |
| Telefon, jasny | [compact](../artifacts/composer-compact/390-light-compact.png) | [expanded](../artifacts/composer-compact/390-light-expanded.png) |
| Telefon, ciemny | [compact](../artifacts/composer-compact/390-dark-compact.png) | [expanded](../artifacts/composer-compact/390-dark-expanded.png) |

Porównanie paneli w normalnym, rozwiniętym widoku. Baseline zapisano przed zmianą ich gęstości, z identyczną kolejką, rozwiniętym subagentem i pytaniem:

| Widok | Przed | Po |
| --- | --- | --- |
| Desktop, jasny | [przed](../artifacts/composer-compact/1440-light-panels-before.png) | [po](../artifacts/composer-compact/1440-light-panels-after.png) |
| Desktop, ciemny | [przed](../artifacts/composer-compact/1440-dark-panels-before.png) | [po](../artifacts/composer-compact/1440-dark-panels-after.png) |
| Telefon, jasny | [przed](../artifacts/composer-compact/390-light-panels-before.png) | [po](../artifacts/composer-compact/390-light-panels-after.png) |
| Telefon, ciemny | [przed](../artifacts/composer-compact/390-dark-panels-before.png) | [po](../artifacts/composer-compact/390-dark-panels-after.png) |

Screenshoty są lokalnymi artefaktami ignorowanymi przez Git. Opcjonalny przełącznik ustawienia nie został dodany, ponieważ wymagałby rozszerzenia trwałego kontraktu ustawień. Chromium z emulacją dotyku nie potwierdza zachowania prawdziwej klawiatury iOS/Safari. Build może zgłaszać istniejące ostrzeżenia optymalizatora o `::highlight` i dużych chunkach; `svelte-check` musi pozostać bez błędów i ostrzeżeń.
