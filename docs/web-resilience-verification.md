# SPA i odporność web na restarty — weryfikacja

Weryfikacja lokalna 2026-11-02: Bun 1.4.4, SvelteKit 3.1.1, Svelte 5.57.3, adapter-node 6.0.1, Chromium 155.0.8059.84. Gałąź `feat/web-resilient-updates`; bez pushowania i PR.

## Sprawdzenia kodu

- `bun run typecheck` z katalogu głównego: wszystkie workspace'y poprawne; svelte-check: 0 błędów i 0 ostrzeżeń.
- Pełne `bun test`: **588 pass, 68 skip, 0 fail**, 2171 asercji, 97 plików, około 151 s. Testy live wymagające modeli pozostają opt-in. Jeden wcześniejszy przebieg trafił na timeout 5 s w sprzątaniu `models-steer.test.ts`; osobne ponowienie (9 pass) i kolejny pełny przebieg przeszły.
- `cd apps/web && bun run build`: poprawny build domyślnego `build/` we własnym worktree. Istnieje ostrzeżenie Vite o chunku gramatyk większym niż 500 kB.
- `bun run release`: poprawne wydania w nowych katalogach; trzy katalogi po retencji, atomowy `current`, manifesty własnych assetów. Staged diff sprawdzono przed każdym commitem pod kątem zabronionego identyfikatora hosta; nie zapisano tokenu usługi ani danych dostawców.

Nowe testy jednostkowe obejmują backoff i jitter, reset po sukcesie, ukrytą kartę, focus/online, usuwanie subskrypcji i timerów, odrzucanie starych callbacków, nieudany resync, watchdog, jednokrotne zgłoszenie nowej wersji, rozpoznawanie błędów modułów i retencję plików (w tym migrację ze starego `build/`).

## Chromium i własne serwery

Użyto `playwright-core` z `/tmp/ro-shot/node_modules/playwright-core` i `/usr/bin/chromium`. Własne weby działały na portach 15181–15185, z gateway `http://127.0.0.1:17443` albo portem bez gateway. Token został odczytany wyłącznie do środowiska procesu testowego. Nie uruchamiano, nie zatrzymywano ani nie edytowano stacka w `/tmp/oa-stack`.

1. **Wydania A → B z otwartą kartą.** A obsługiwało ruch w czasie budowania B; odpowiedź wersji A nie zmieniła się podczas builda. B miało inne chunki. Po przełączeniu procesu stary chunk odpowiadał **200** i miał `Cache-Control: immutable`. Focus wywołał wykrycie nowej wersji; banner nie przeładował dokumentu i zachował tekst szkicu. Kliknięcie New thread spowodowało pełną nawigację i nowy dokument. Resync SSE przywrócił Connected.
2. **Błędy importów.** Zdarzenie `vite:preloadError`, rzeczywisty dynamiczny import brakującego pliku JS (404) oraz przechwycony brak gramatyki Shiki Rust (404) pokazały banner. Kompozytor zachował szkic. Reload działał po jawnym kliknięciu; nie było automatycznej pętli odświeżeń. Przy błędzie gramatyki kod pozostał czytelny bez kolorowania.
3. **Awaria gateway.** Własny web przełączono na martwy port na 10 s. Oba endpointy SSE zwróciły **503**, stopka przeszła w Reconnecting… / Gateway unavailable, a po przywróceniu gateway samodzielnie wróciła do Connected. Wejście na wątek w czasie awarii zwróciło powłokę **200** (16 ms), pokazało „Can't reach the gateway” i Try again; po powrocie gateway oś czasu wróciła bez ręcznego odświeżania.
4. **Gateway przyjmuje TCP, ale milczy.** Osobny lokalny serwer przyjmował połączenia i nie odpowiadał. Powłoka: **200 / 775 ms**; `/api/overview`: **502 / 3009 ms**; `/api/overview/events`: **502 / 3012 ms**. Po próbie zamknięto także przyjęte sockety.
5. **Przepływy UI przy 1440 i 390 px.** Nowy wątek, rzeczywisty wątek o największym `lastSeq`, ustawienia otwierane wprost i jako nakładka nad szkicem, zamknięcie Escape, Bots, paleta Mod+K, lista dostawców i Add, mobilne menu. Na desktopie szerokość sidebara wzrosła 328 → 344 px, zwinięcie dało 0 px i rozwinięcie przywróciło panel. Zapisy wyglądu w tej próbie przechwycono w przeglądarce, aby nie zmieniać preferencji użytkownika w gateway. Oś wątku w obu rozmiarach kończyła dokładnie na dole (`scrollHeight - scrollTop - clientHeight = 0`). Końcowy przebieg nie zgłosił błędów aplikacji w przeglądarce.

## CLS przed i po

Pomiar: `PerformanceObserver` dla `layout-shift`, suma zdarzeń bez `hadRecentInput`, 2,5–3 s po wejściu na trasę, wysokość okna 1000 px. Najpierw zmierzono wyjściowy build SSR, następnie SPA z tym samym gateway i wątkiem. Są to pomiary laboratoryjne pojedynczych wejść, nie percentyle z ruchu użytkowników.

| Szerokość | Trasa | SSR przed | SPA po |
|---|---|---:|---:|
| 1440 px | `/` | 0 | 0,000055 |
| 1440 px | `/threads/[id]` | 0,013982 | 0,000055 |
| 1440 px | `/settings/appearance` | 0 | 0,000055 |
| 390 px | `/` | 0 | 0 |
| 390 px | `/threads/[id]` | 0,036608 | 0 |
| 390 px | `/settings/appearance` | 0 | 0 |

Główne źródło początkowego CLS wątku: zmiana wysokości absolutnego gradientu nad kompozytorem po pomiarze. Gradient montuje się teraz po uzyskaniu wysokości. Panel szczegółów czeka ze swoją treścią na snapshot, a pełne formularze na początkowe dane, zachowując miejsce i wygląd z powłoki. Pozostały śladowy desktopowy CLS dotyczył zmiany szerokości statusu stopki po odebraniu liczby workerów.

## Zakres i ograniczenia

Nie wykonywano płatnych tur modeli, rzeczywistych zmian konfiguracji dostawców ani produkcyjnego wdrożenia. Nie testowano Safari/Firefox, rzeczywistego restartu Tailscale ani zmian skryptu stacka. Backoff/widoczność mają deterministyczne testy jednostkowe; awarie i odzyskiwanie połączenia oraz focus przy wersjonowaniu sprawdzono w Chromium.

Cache wyglądu jest procesowy, ograniczony do 3 s i obecnego jednego użytkownika deweloperskiego. Przy zimnym procesie i niedostępnym gateway powłoka stosuje domyślny wygląd; po odzyskaniu danych przyjmuje zapisane preferencje. Starsze chunki są dostępne w oknie retencji trzech wydań; po jego przekroczeniu banner umożliwia jawny reload.

Instrukcja zmiany restartu stacka i layout wydań: [ui-api.md — wydania web](ui-api.md#wydania-web-bez-przebudowy-działającego-katalogu). Własne wydania, profile i pomocnicze skrypty E2E są usuwane po weryfikacji; testy jednostkowe pozostają w repozytorium.
