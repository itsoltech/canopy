# Własne kontrolki formularzy — weryfikacja

Gałąź `feat/custom-form-controls`, implementacja lokalna, bez push i PR. Zakres obejmuje wspólny kit i użycia formularzy; brak zmian kontraktów API lub bazy. Wykonanie inline, zgodnie z przekazanym zleceniem implementacji. Użyte skille: `design`, `componentize`, `transitions-dev`, router ITSOL i końcowy self-review.

## Komponenty i audyt

1. `Select`: przycisk combobox + listbox w istniejącym `Popover`. Typowane opcje, ikony, opisy, nazwane grupy, separatory, disabled, ptaszek wyboru. Strzałki/Home/End/typeahead, Enter/Space/Tab, anulowanie Escape, fokus i `aria-activedescendant`. Ukryte pole dla FormData, reset formularza i walidacja required, integracja etykiety/opisu/błędu z `Field`. Arkusz na telefonie, panel z ringiem/cieniem jak pozostałe menu, szerszy przy opisach.
2. `Input`: wewnętrzne `DateTimeControl` + `Calendar` i `NumberControl`, bez zmiany API wywołań. Kalendarz ma znacznik dzisiaj, min/max, strzałki, Home/End, PageUp/PageDown i Shift dla roku. Czas ma tekst HH:MM i własne stepery; wartości są formatowane w locale przeglądarki, datetime w jej strefie. Quick picks, Apply/Cancel i Clear dla opcjonalnego pola. Liczby mają własne −/+, krok od min/zera, strzałki, parsowanie, ograniczanie i obsługę pustej wartości.
3. `ChoiceControl`: wspólna grafika checkboxów/radio dla `Input choice` (QuestionForm), `Checkbox`, `Radio`, markdown task-list. `ChoiceCard`, `Switch`, `MenuCheckItem`, AccentPicker i segmenty harmonogramów zachowują własną grafikę; poprawiono fokus lub obszary dotyku. `SettingsRow` układa opis nad kontrolką na telefonie. Wszystkie wyszukiwarki mają globalnie wyłączone systemowe dekoracje/cancel.
4. Zmigrowane Select: `ThreadSettingsFields`, `ThreadDefaultsFields`, `ScheduleDialog`, `NewThreadScheduleFields`, `ScopeBar`, `settings/appearance`. Daty/czas/liczby w `ScheduleDialog` i liczba w `GoalDialog` korzystają z nowych rendererów przez istniejący `Input`. `CiteLayer` przejrzany: nie ma kontrolki select, tylko typ `SelectedQuote`.
5. W aplikacji nie pozostał żaden `<select>`. Natywne inputy tekstowe i semantyczne checkbox/radio pozostają elementami HTML ze stylami kitu; nie pokazują systemowego wyglądu. Wyjątek: `forced-colors:appearance-auto` dla checkbox/radio zapewnia kontrast systemowy w trybie dostępności. Plikowy input composera nadal jest `sr-only`, `aria-hidden`, bez Tab; systemowy wybór plików otwiera się dopiero po jawnej akcji dołączenia pliku. Brak widocznego natywnego pola plikowego, color lub range.

## Componentize i ruch

Dedykowany pass componentize przed końcowym commitem wydzielił `PickerTrigger`, używany przez Select i datę/czas. Sprawdzono także granice `Calendar`, `StepperButtons` oraz `ChoiceControl`; publiczne API zwykłych pól pozostaje w `Input`. Rozmiar/położenie wywołujący ustawia na wrapperze; padding/pozycjonowanie przycisku należą do `PickerTrigger`. Usunięto konflikt `block`/`flex` we wspólnych klasach kontrolki.

Nowe popovery używają istniejącego `Popover`, `floating.ts`, arkuszy i receptur `t-dropdown`/`motion.css`. Nie dodano biblioteki animacji ani własnych czasów. Reduced motion korzysta z tokenów i istniejących osłon; przeglądarka sprawdza skalę 1 przy reduced motion. TouchTarget zachowuje 48 px w nowych kontrolkach; gęste formularze i menu mają co najmniej 48 px wysokości na coarse pointers, aby obszary nie nachodziły na kolejne wiersze.

## Testy i ograniczenia

Testy jednostkowe: `listbox.test.ts`, `date-time.test.ts`, `number.test.ts` — 12 testów, 76 asercji. Obejmują typeahead, pomijanie disabled i zmianę wartości, min/max/step, precyzję dziesiętną, puste i błędne dane, kalendarz, locale oraz strefy Europe/Warsaw, America/New_York, Asia/Kathmandu i Pacific/Auckland. Dla Warszawy: luka 2026-03-29, podwójna godzina 2026-10-25, sąsiednie minuty i wybór wcześniejszego momentu.

Końcowe sprawdzenia po scaleniu `main` (`07d7f19`): `bun install` bez zmian; `bun run typecheck` — 0 błędów i ostrzeżeń; `bun run check:tmp` — 830 pass, 145 skip, 0 fail, 3290 asercji, pusty katalog testowy; web build — exit 0. Typecheck i build wykonywano sekwencyjnie, ponieważ oba korzystają z generowanego `.svelte-kit`. Po końcowej poprawce resetu typeahead ponowiono typecheck, build i testy przeglądarkowe.

| Sprawdzenie Chromium | Wynik końcowy |
| --- | --- |
| `custom-form-controls.browser.test.ts` | 4 pass, 0 fail, 130 asercji |
| `schedules-edit.browser.test.ts` | 3 pass, 0 fail, 91 asercji |
| `schedules.browser.test.ts` | 1 pass, 0 fail, 18 asercji |

Testy przeglądarkowe są opt-in i używają `/usr/bin/chromium` oraz `playwright-core`. Prywatny Postgres na losowym porcie i prywatny gateway ze skryptowanym workerem, web na 5317; test zapisu harmonogramu na 5321, edycji na 5298. Nie użyto `/tmp/oa-stack` ani portów 17443, 5180, 8444. Procesy kończone przez własne uchwyty, katalogi tymczasowe przez istniejący harness. Karta wspólnego podglądu została zamknięta.

Macierz `custom-form-controls.browser.test.ts`: 1440×1000 i 390×844, light/dark, hasTouch/isMobile dla 390, locale en-GB, Europe/Warsaw. Formularze: domyślne ustawienia wątków, appearance, scope providers i kreator providera (ChoiceCard/AccentPicker), schedule (calendar/time/number/nowy wątek), side thread, permissions, goal, markdown tasks i pytania. Sprawdzane są klawiatura kontrolek, Escape/powrót fokusu, wiązania i hidden/FormData, walidacja czasu, clamp/step, arkusze, brak poziomego overflow oraz brak natywnych select/date/time/number w DOM. Oddzielny `schedules.browser.test.ts` weryfikuje też zapis konfiguracji nowego wątku i pochodzenie uruchomienia.

Po scaleniu gałęzi edycji zmigrowano też selektory w `schedules-edit.browser.test.ts`: wartości pochodzą z hidden input, a zmiana placement używa combobox/listbox. Test pokrywa edycję w obu motywach i szerokościach, zapis, zachowanie historii/statusu, konflikt wersji i modele bez effort.

Przegląd zrzutów wykrył za niski domyślny limit wysokości panelu daty na desktopie. `Popover.maxHeight` pozwala pickerowi zmieścić kalendarz, czas i stopkę, zachowując limit dostępnego miejsca i mobilnego arkusza; test sprawdza brak przycięcia zawartości. Walidacyjne pola techniczne są `aria-hidden`, aby czytnik otrzymywał jedno pole formularza. Tab zamyka także listę z samymi wyłączonymi opcjami. Zamknięcie listy resetuje bufor typeahead; regresja sprawdza nowe wyszukiwanie po Escape przed upływem 700 ms.

Nie wykonywano ręcznego testu z rzeczywistym czytnikiem ekranu ani Safari/Firefox. Rozstrzygnięcie jesiennej podwójnej godziny zachowuje poprzednią semantykę: kontrolka nie oferuje wyboru drugiego wystąpienia tej samej godziny. Build zachowuje ostrzeżenie o rozmiarze istniejącego chunka.

We wcześniejszych równoległych przebiegach Chromium przerywał pobieranie chunków z `net::ERR_NETWORK_CHANGED`. Diagnostyka `requestfailed` i `vite:preloadError` pokazała następnie `Failed to fetch dynamically imported module`, a wtórnie `Cannot read properties of undefined (reading 'component')` w bootstrapie SvelteKit, przed montażem formularzy. Końcowe testy przeglądarkowe uruchomiono po zakończeniu `check:tmp`, który tworzy i usuwa kontenery, aby oddzielić ładowanie aplikacji od zmian sieci środowiska. Nie dodano automatycznych ponowień ani zmian aplikacji maskujących błędy importu. Diagnostyka pozostała w testach; błędy nowych kontrolek są przypisane do właściwego wariantu testu.

## Zrzuty i odtwarzanie

Zrzuty są poza śledzonym kodem, w `artifacts/custom-form-controls/`. Dla każdego prefiksu `1440-light`, `1440-dark`, `390-light`, `390-dark`: `-select.png`, `-appearance.png`, `-provider.png`, `-calendar.png`, `-schedule.png`, `-side-thread.png`, `-permissions.png`, `-goal.png`, `-question.png`. Zrzuty `*-failure.png` pochodzą z wcześniejszych prób diagnostycznych i nie są dowodem końcowego wyniku.

```sh
bun install
bun run typecheck
bun run check:tmp
bun run --filter @canopy/web build
CANOPY_FORM_BROWSER=1 bun test tests/integration/custom-form-controls.browser.test.ts
CANOPY_SCHEDULE_BROWSER=1 CANOPY_SCHEDULE_BROWSER_PORT=5321 bun test tests/integration/schedules.browser.test.ts
CANOPY_SCHEDULE_EDIT_BROWSER=1 bun test tests/integration/schedules-edit.browser.test.ts
```

Commity implementacji: `f27a2f3` (Select i migracja), `6aabcd3` (date/time/number/choice), `5f06a60` (componentize, dostępność i testy Chromium), `1044ede` (widoczna stopka pickera, semantyka dostępności i integracja testów edycji), `6b9122a` (reset typeahead). Końcowy commit dokumentacji jest podany w raporcie rozmowy. Scalenia: `93072c0` (composer), `93d9df9` (markdown previews, main do `4b36e34`), `535e829` (edycja harmonogramów, main do `2fadf83`), `dc49421` (mobilne sugestie composera, main do `07d7f19`).
