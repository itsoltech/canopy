# Weryfikacja filtra i menu wątków

Gałąź: `feat/sidebar-filter-menu`. Zawiera lokalny `main` do `74b3438`.

## Zakres i decyzje

- Filtr wielu projektów, przypięcia oraz widok archiwum korzystają z wersjonowanej sekcji ustawień
  użytkownika w gateway; zmiany docierają na inne urządzenia przez overview.
- Jedno menu obsługuje wątki główne i boczne; te same deskryptory udostępniają odpowiednie akcje
  bieżącego wątku w palecie. Dotknięcie przechodzi do wątku, przytrzymanie otwiera arkusz.
- Usunięcie jest miękkie, obejmuje dzieci i używa trwałego outboxu przerwań. Undo przywraca tylko
  daną partię, zachowuje wcześniejsze archiwum i przypięcia; nie wznawia kolejki, harmonogramów,
  oczekujących odpowiedzi `ask_user` ani notatek zadań w tle. Migracja: `0026_sidebar_threads`.
- Archiwum zastępuje kompozytor informacją o czasie i autorze oraz akcjami przywrócenia i przejścia
  do rodzica. Aktywni subagenci pozostają na liście; archiwalni są w „Previous agents”.
- Osobny przegląd `componentize`: wspólne menu/dialogi, `PreviousAgents`, `ThreadComposerSlot`
  i `ArchivedThreadState`; wiersz projektu wydzielony do `SidebarProjectChoice`, usunięty drugi
  formularz rename. Ruch wykorzystuje istniejące `reorder` (FLIP), `expand` i `stepSwap` oraz
  obsługę ograniczenia ruchu.

## Sprawdzenia

Wyniki końcowe (2026-11-02):

| Sprawdzenie | Wynik |
|---|---|
| `bun run typecheck` | OK; Svelte: 0 błędów i 0 ostrzeżeń |
| `bun run gen:check` | OK |
| `bun run check:tmp` | 764 pass, 102 skip, 0 fail; 866 testów w 129 plikach, 2966 asercji; brak pozostałości testów |
| Build web | OK |
| Browser desktop i touch 390 px | 2 pass, 0 fail |

`sidebar-threads.test.ts` obejmuje filtr, wyszukiwanie, kolejność przypięć, archiwum, grupowanie
subagentów i dostępność pozycji menu. `sidebar-lifecycle.test.ts` używa PostgreSQL i scripted workera:
ustawienia i konflikty wersji, przeczytanie, autor archiwizacji, przerwania, anulowanie pracy,
ukrycie w listach/wyszukiwaniu/wzmiankach/agent-bus oraz przywrócenie właściwej partii.

Browser: `/usr/bin/chromium`, `playwright-core` z `/tmp/ro-shot/node_modules/playwright-core`.
Własny throwaway PostgreSQL/gateway/scripted worker, losowy port gateway, web `5298`;
profile przeglądarki tworzy `@canopy/testing`. Test zamyka własne procesy i profile.
Nie używa wspólnego stosu ani sekretów dostawców.

```bash
bun run typecheck
bun run gen:check
bun run check:tmp
bun run --filter @canopy/web build
CANOPY_BROWSER_TESTS=1 CANOPY_PLAYWRIGHT_MODULE=/tmp/ro-shot/node_modules/playwright-core bun test tests/integration/sidebar-browser.test.ts
```

Scenariusze browser: prawy przycisk, Shift+F10, strzałki, Escape i powrót fokusu, filtr wielu projektów
i pusty wynik, przypięcie, rename, Cmd+K i jawne unread, archiwizacja/przywrócenie z widoku archiwum,
usunięcie/Undo, oba „Previous agents”, strona archiwalnego subagenta z autorem i rodzicem,
brak kompozytora w archiwum i równa wysokość jego obszaru na desktopie. Osobno ekran dotykowy 390 px:
przytrzymanie otwiera dolny arkusz, dotknięcie przechodzi do wątku, „Previous agents” rozwija się i zwija.
Sprawdzono jasny i ciemny motyw oraz brak błędów strony.

Testy live dostawców wymagające zewnętrznych poświadczeń pozostają domyślnie pominięte.

## Zrzuty

Katalog artefaktów jest lokalny i ignorowany przez Git:
`artifacts/sidebar-filter-menu/` w worktree gałęzi.

| Plik | Widok |
|---|---|
| `desktop-light-menu.png` | Menu w jasnym motywie |
| `desktop-light-filter.png` | Aktywny filtr projektu |
| `desktop-light-archived.png` | Archiwum zamiast kompozytora |
| `desktop-dark-menu.png` | Menu w ciemnym motywie |
| `mobile-dark-sheet.png` | Dolny arkusz na telefonie |
| `mobile-dark-archived.png` | Archiwalny subagent z nazwą rodzica |
