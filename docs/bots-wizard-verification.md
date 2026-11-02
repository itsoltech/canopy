# Create Bot wizard — weryfikacja

Status: completed. Gałąź `feat/bots-wizard`, 2026-11-02. API i zasady integracji: [bots-wizard.md](bots-wizard.md).

## Zakres i przegląd

Gotowe: `CreateBotWizard` i `EditBotAppearance`, 14 kształtów, 11 presetów, własny picker HSV/HEX, walidacja nazwy, istniejące pickery instancji/modelu/effortu, asynchroniczny zapis ze stanem busy i obsługą błędu. Demo jest pod `/dev/bots`. Kod gateway i proto nie był zmieniany w ramach tej implementacji.

Przegląd `componentize` wykonano przed końcowym commitem: oba publiczne komponenty delegują do `BotFormDialog`; wygląd składają `AppearanceFields`, `MascotPreview`, `CustomColorPicker` i `ColorChannel`; jedna `ChoiceGrid` obsługuje kształty, kolory i instancje. `MascotFace` jest wspólnym rendererem podglądu i jawnie wybranego awatara. Przyciski, pola, błędy, dialog oraz model/effort wykorzystują istniejący kit. Odstępy i układ pickerów kontrolują wrappery. Nie stwierdzono pozostałych istotnych duplikatów ani problemów blokujących odbiór.

Zastosowano skille `design`, `transitions-dev` i `componentize`. Animacje odwołują się do istniejących tokenów; crossfade ze skalą bazuje na icon swap. Reduced motion wyłącza przejścia podglądu, mruganie i podbicie przy wpisywaniu nazwy.

## Wyniki

| Kontrola | Wynik |
| --- | --- |
| `bun install` | OK; lockfile bez zmian |
| `bun run typecheck` | wszystkie workspace’y OK; Svelte: 0 błędów, 0 ostrzeżeń |
| `bun run --cwd apps/web build` | OK; adapter-node zakończył build; standardowe ostrzeżenie Vite o chunkach >500 kB |
| pełne `bun run check:tmp` | 839 pass, 154 skip, 0 fail; 993 testy, 153 pliki; brak własnych pozostałości w TMPDIR |
| `bun run check:tmp apps/web/src/lib/features/bots apps/web/test/worked-for.test.ts apps/web/test/steer-goals.test.ts` | 46 pass, 0 fail; brak pozostałości |
| `OA_BOTS_WIZARD_BROWSER=1 bun test tests/integration/bots-wizard.browser.test.ts` | 7 pass, 0 fail; 180 asercji; końcowy przebieg 35,18 s |

Włączono przesuwający się `main`, w tym custom form controls, poprawkę przewijania popoverów, ikony providerów w bocznych wątkach i timeline folding (`28aef2b`). Po ostatnim scaleniu ponowiono instalację, pełny typecheck, build, testy jednostkowe botów i testy zmienione na main oraz cały przebieg przeglądarkowy. Pełny `check:tmp` zakończył się przed ostatnim scaleniem timeline folding; wiersz z 46 testami jest ponowną weryfikacją po tym scaleniu.

Przeglądarka: `/usr/bin/chromium`, `playwright-core`, własny Vite na 5197. Nie używano `/tmp/oa-stack` ani portów 17443, 5180, 8444. Proces Vite i Chromium są zamykane przez fixture, bez wyszukiwania/zabijania procesów po wzorcu.

Pełne testy Docker uruchamiane na tej maszynie powodowały reset interfejsów i `ERR_NETWORK_CHANGED` w Chromium. Fixture przekazuje rzeczywiste odpowiedzi Vite i fontów przez klienta HTTP Playwright oraz lokalnie obsługuje handshake HMR. API powłoki i SSE są mockowane. Nie zastępuje to kodu komponentów ani ich CSS. Końcowy przebieg nie zawierał błędów strony ani konsoli; błędy aplikacji i interakcji nie są ignorowane. Komunikat procesu Vite o kodzie 143 wynika z jego celowego zamknięcia po testach.

## Pokrycie przeglądarkowe

1. 1440×1100 i 390×844, light i dark: podgląd, kształt, preset, HSV/HEX, poprawny szkic callbacku i ponowne otwarcie z pustym formularzem; bez poziomego overflow i natywnych select/color/range/radio.
2. Wyłącznie klawiatura: otwarcie, autofocus, zawijanie Tab/Shift+Tab, nazwa wymagana i duplikat, strzałki/Home/End w siatkach, HEX, instancja, model, effort, Enter zatwierdzający formularz.
3. Busy i błędy: blokada zamknięcia przez Escape i przycisków, zachowanie szkicu po odmowie, niepoprawny HEX, instancja bez modeli, brak providerów, model bez effortu.
4. Edycja: zachowanie własnej nazwy, zmiana kształtu i zapis przez `onsave`, aktualizacja awatara w galerii.
5. Ruch i SVG: crossfade, podbicie podczas pisania, mruganie, statyczny reduced motion; geometria wszystkich 14 ścieżek mieści się w 40×40.

## Zrzuty

Pliki lokalne w `artifacts/bots-wizard/` są ignorowane przez Git i zostały obejrzane podczas odbioru.

| Rozmiar i motyw | Preset | Własny kolor `#a3e635` |
| --- | --- | --- |
| Desktop, light | `1440-light.png` | `1440-light-custom.png` |
| Desktop, dark | `1440-dark.png` | `1440-dark-custom.png` |
| Telefon, light | `390-light.png` | `390-light-custom.png` |
| Telefon, dark | `390-dark.png` | `390-dark-custom.png` |

## Granice weryfikacji

To odbiór warstwy UI. Zapis backendowy, mapowanie kontraktu botów i atomowa unikalność nazw należą do wywołującego callback. Pickery modelu/effortu działają w standardowym kontekście powłoki aplikacji; ich ulubione modele zachowują istniejącą integrację z ustawieniami. Trasa galerii pozostaje wyłącznie developerska. Nie wykonano push ani PR.
