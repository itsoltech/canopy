# Antigravity CLI przez ACP

Status (2026-11-24). Worker obsługuje wątki Google Antigravity przez ACP v1.
Wymaga `agy` z linii 1.x od wersji 1.5.16, która udostępnia używane przez
Canopy ustawienia izolacji i zgód. Dostępność w kanałach wynika z [promocji wydań](release.md).

## Uruchomienie na workerze

1. Zainstaluj Antigravity CLI na komputerze workera. Sprawdź `agy --version` i `agy acp --help`. Worker wyszukuje `agy` w PATH i obsługuje ścieżkę wskazaną dla instancji. Do ręcznej aktualizacji służy `agy update`. [Pobieranie CLI](https://antigravity.google/download#antigravity-cli)
2. Zaloguj się na tym komputerze przez `agy acp --login` jako użytkownik systemowy, który uruchamia worker. Możesz też ustawić sekretną zmienną `GEMINI_API_KEY` natywnej instancji. Przy wyłączonym logowaniu urządzenia wymagany jest klucz. [Logowanie do ACP](https://antigravity.google/docs/ide/extensions/acp/#authentication)
3. Wybierz Antigravity i model przy tworzeniu wątku. Wbudowaną instancję `antigravity/native` można włączyć dla wybranego workera w Settings → Providers. Worker odczytuje modele i poziomy rozumowania z opcji sesji ACP bez wysyłania promptu.

## Sesje i narzędzia

Worker uruchamia osobny proces `agy acp --process-per-session` dla wątku.
`@canopy/acp` obsługuje JSON-RPC po stdio, strumień odpowiedzi, prośby o zgodę,
anulowanie i zakończenie procesu. Do sesji przekazuje `cwd` wątku
oraz przyznane serwery MCP przez HTTP na loopbacku. Narzędzia Canopy,
konektory i automatyzacja podlegają dotychczasowym grantom w gatewayu.
Tryb `--process-per-session` jest wymagany przez CLI do przyjęcia tych
serwerów. Wybór modelu i poziomu rozumowania wykorzystuje
`session/set_config_option`. [Protokół Antigravity](https://antigravity.google/docs/ide/extensions/acp/)

Własne dane rozmowy i artefakty CLI znajdują się w
`<data_dir>/antigravity/<instance>/sessions/<thread_id>`. Worker wznawia rozmowę
na podstawie zapisanego identyfikatora ACP po restarcie lub wyładowaniu procesu.
Odświeżenie konfiguracji narzędzi następuje na granicy tur.
Potwierdzone trwałe usunięcie wątku obejmuje jego prywatny katalog.
Worker raportuje zużycie tokenów zwrócone przez CLI. Katalog kosztów API Canopy
nie zawiera stawek Google.

## Konfiguracja i skille

Każdy proces dostaje prywatny katalog przez `--gemini-dir`. Polecenia w wątku
zachowują systemowy HOME, dzięki czemu korzystają z konfiguracji Git i narzędzi
użytkownika. Natywne logowanie korzysta z magazynu poświadczeń systemu lub pliku
`antigravity-oauth-token` urządzenia. Przy logowaniu kluczem Gemini worker
uwierzytelnia żądania modelu przez prywatny serwer na loopbacku. CLI i jego
polecenia dostają jedynie klucz ważny dla tego procesu. Własny endpoint zgodny
z API Gemini można wskazać przez `GOOGLE_GEMINI_BASE_URL` razem z jego
`GEMINI_API_KEY` w tej samej instancji. Obsługiwane ustawienia instancji
obejmują też ścieżkę do binarki i osobny katalog skilli platformy. Połączenia
CLIProxyAPI, osobne logowanie instancji i własne argumenty startowe są niedostępne.

W Settings → Agent environment przypisanie skilla do sesji Canopy z Antigravity
instaluje go pod `<data_dir>/antigravity-home/skills` oraz w `skills/` każdej
instancji z własnym shadow home. Worker dołącza katalog skilli wybranej
instancji do prywatnej konfiguracji procesu. Osobny wybór
instalacji dla CLI urządzenia zapisuje skille w `~/.gemini/antigravity-cli/skills`.
Po wznowieniu sesji agent może odczytać zaktualizowaną treść przypisanego skilla
także w trybie Read only. Worker sprawdza rzeczywistą ścieżkę pliku w katalogu
skilli instancji przed udzieleniem zgody na jego odczyt.
Przypisania dla kilku harnessów zachowują swoje pozostałe cele na starszych
workerach. [Synchronizacja skilli](agent-environment.md)

Projekt może przekazać agentowi instrukcje z `AGENTS.md`, `GEMINI.md` i katalogów
reguł. Worker wyłącza dziedziczenie projektowych hooków i serwerów MCP.
Dla wątku **No project** katalog scratch musi leżeć poza nadrzędnym repozytorium
Git lub sam być korzeniem repozytorium. `agy` czyta skille z nadrzędnego repozytorium
mimo wyłączenia dziedziczenia. W takim położeniu worker odmawia startu przed
otwarciem sesji.

## Dostępne tryby

| Tryb w Canopy | Działanie |
| --- | --- |
| Ask first | Zgody na polecenia i edycje trafiają do wątku przez ACP. |
| Accept edits | Worker może zaakceptować zapis lub edycję w obrębie rzeczywistej ścieżki workspace’u. Pozostałe operacje wymagające zgody trafiają do użytkownika. |
| Read only | Adapter blokuje edycje i polecenia w sesji. |
| Full access | Jawny wybór włącza pracę bez pytań i sandboxa, jeśli zezwala na to konfiguracja workera. |

Natywne `manage_task` może sterować zadaniami bez pytania o zgodę przez ACP.
Worker dopuszcza to narzędzie wyłącznie w trybie Full access.

Tryb Sandbox (`FULL_AUTO`) i własne profile sandboxa wymagają gwarancji
izolacji terminala, których ten adapter nie zgłasza. Nowe wejście podczas
aktywnej tury trafia do kolejki Canopy. Dostępne są zwykłe wątki boczne
z delegowaniem przez platformę. Fork historii, Edit from here, cele i zmiana
worktree aktywnego wątku są niedostępne. Worker odrzuca prośby o zapisane
sekrety projektu, ponieważ adapter nie potwierdza filtrowania wyników natywnych
narzędzi przed przekazaniem ich do modelu. [Sekrety wątków](secrets.md)

Boty i automatyczne generowanie tekstu wymagają sesji z wyłączonymi
narzędziami lokalnymi. W sprawdzonym CLI na liście narzędzi wysyłanej do
modelu pozostaje `manage_task` nawet przy pustej liście narzędzi agenta.
Canopy ogranicza wybór Antigravity do wątków.
