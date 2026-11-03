# Edycja harmonogramów — weryfikacja

Data: 2026-11-02. Gałąź: `feat/schedule-edit`. Ostatni scalony `main`: `4b36e34`.

## Zakres i decyzje

`UpdateSchedule` zastępuje pełną konfigurację z walidacją wspólną z tworzeniem i kontrolą
`expected_version`. Edycja przelicza następne wykonanie, zachowuje pauzę, historię, licznik
i pierwotnego autora, a zapisuje użytkownika i czas ostatniej edycji. Dotyczy też zadań agenta.
Pierwszy claim utrwala tożsamość wystąpienia; edycja unieważnia lease, zachowując klucz historii.
Stary snapshot nie może uruchomić poprzedniej konfiguracji.

Dozwolona jest zmiana rodzaju celu `thread ↔ new_thread`, także z istniejącą historią.
Bezpośrednia zmiana jednego istniejącego wątku na drugi jest odrzucana. `max_runs` to limit
łączny, większy od liczby wykonanych tur. Zakończone i anulowane zadania nie mają akcji.
Opcjonalnego „Run now” nie dodano. Migracja `0029_schedule_edit` następuje po
`0028_archive_cascade` z main. Nowe pola istniejącej wiadomości `Schedule` mają numery 330–333.

Settings i panel wątku korzystają z tego samego edytora oraz menu „…”. Status to kropka
z etykietą przy tytule lub w metadanych. Anulowanie wymaga potwierdzenia w dialogu.
Osobny przebieg `componentize` wydzielił `ScheduleCompactRow`, `ScheduleStatus` i
`SchedulePreview`, wykorzystując istniejące elementy zestawu UI. Ruch korzysta z istniejących
tokenów i obsługi reduced motion w `routes/layout.css` oraz `lib/shared/ui/motion.css`.

## Wyniki

| Sprawdzenie | Wynik |
| --- | --- |
| `bun install` | Sukces, bez zmian zależności |
| `bun run typecheck` | Sukces wszystkich workspace; Svelte: 0 błędów i 0 ostrzeżeń |
| `bun run gen:check` | Sukces, wygenerowany kontrakt zgodny |
| `bun run check:tmp` | 809 pass, 130 skip, 0 fail; 3190 asercji, 144 pliki; katalog tymczasowy pusty |
| `bun run --filter @canopy/web build` | Sukces; ostrzeżenie Vite o dużym chunku |
| `CANOPY_SCHEDULE_EDIT_BROWSER=1 bun test tests/integration/schedules-edit.browser.test.ts` | 3 pass, 0 fail; 91 asercji |

Testy jednostkowe obejmują walidację, przeliczanie następnego terminu, akcje zależne od statusu
i zachowanie nowszego stanu ze strumienia. Dziewięć testów integracji edycji z workerem
skryptowym sprawdza oba cele, ustawienia dostawcy, zmianę rodzaju celu po wykonaniu,
lease i brak duplikatu, przesunięcie przejętego wystąpienia, pauzę, autorstwo, obcego
właściciela i konflikty równoległych edytorów.

Chromium `/usr/bin/chromium` sprawdził edycję z Settings i panelu wątku, menu aktywnego
i wstrzymanego zadania, oba wyjścia z potwierdzenia anulowania, brak akcji zakończonych
zadań, konflikt zachowujący szkic i prefill modelu Claude bez effort. Oba motywy i szerokości
1440 oraz 390 px; bez błędów JavaScript i poziomego overflow w sprawdzonych widokach.
Stos miał własny tymczasowy Postgres, gateway i workery skryptowe oraz web na porcie 5298;
test zamknął swoje procesy i konteksty. Testy live wymagające rzeczywistych dostawców
pozostają pominięte; nie używano sekretów CLIProxyAPI.

## Dowody lokalne

Screenshoty są ignorowanymi artefaktami w `artifacts/schedules-edit/`:

- `{desktop,mobile}-{light,dark}-{list,menu,edit,cancel,thread-panel}.png`
- `desktop-conflict.png`
- `desktop-claude-pool-edit.png`

Logi końcowych przebiegów: `/tmp/schedule-edit-check-tmp-final.log`,
`/tmp/schedule-edit-browser-final.log`, `/tmp/schedule-edit-web-build.log`.

Commity implementacji: `6de8619`, `9574033`, `e708d3f`.
Scalenia main: `6828bac`, `53321d8`. Bez pushowania i PR.
