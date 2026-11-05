# Mapa ustawień Canopy

## Nawigacja

General: **General → Appearance → Keybindings → Threads → Text generation → Scheduled tasks**.
Code: **Projects → Worktrees → Diffs → Agent environment**.
Connections: **Providers → Connectors → Proxies → Workers → Network access → Devices → Linked computers → Desktop → App updates**.
Ostatnie dwie strony tylko w desktopie, Linked computers według capability gatewaya.

„Account” oznacza ustawienia właściciela w DB aktualnego gatewaya, wspólne dla jego
klientów web/desktop. Nie oznacza automatycznej synchronizacji niezależnych gatewayów.
„This device” oznacza profil przeglądarki/origin lub lokalną powłokę Electron.
Każda nowa preferencja ma opis zakresu i działania oraz reset po zmianie.
Istniejące domyślne wartości wątków i generowania tekstu otrzymują również reset
pojedynczych pól; reset agenta zeruje jego zależny profil, zachowując modele innych agentów.
Reset strony przywraca wyłącznie jej preferencje urządzenia, bez cofania zgód systemowych.
Ustawienie, którego funkcja jeszcze nie istnieje, nie udaje działania: `SettingsRow soon`
pokazuje znacznik „Soon”, blokuje kontrolkę i ukrywa reset, więc zapisana wartość zostaje
bez zmian. Opcja wyboru bez działania jest wyłączona z opisem „Soon”.

## Preferencje i przeniesienia

| Strona / sekcja | Ustawienie | Zakres | Domyślnie | Skutek |
| --- | --- | --- | --- | --- |
| Keybindings | Skróty komend, kompozytora, cytowania i modeli | urządzenie | przypisania rejestru | Wyszukiwanie, edycja, nagrywanie i dodatkowe przypisania z kontrolą konfliktów kontekstu |
| General / Notifications | Thread notifications | urządzenie | Off | Alert systemowy przy ukończeniu, błędzie lub pytaniu/zgodzie wątku, tylko gdy otwarte jest okno Canopy (na macOS zamknięte okno nie wysyła alertów); opcjonalny dźwięk; web wymaga zgody Notification API i pokazuje odmowę lub zamknięty monit, desktop używa natywnego `Notification` przez IPC |
| General / Notifications | In-app notifications | urządzenie | On | Toast o innym wątku przy fokusie aplikacji |
| General / Sidebar | Group by project | konto | Off | Nagłówki projektów w aktywnym sidebarze, z zachowaniem przypięć i priorytetu pytań |
| General / Sidebar | Project order | konto | Latest activity | Kolejność grup według aktywności, nazwy lub utworzenia projektu; bez obietnicy ostatniej wiadomości użytkownika, której indeks nie udostępnia |
| General / Sidebar | Working section | konto | Off | Osobna zwijana sekcja pracujących wątków/drzew; pytania i nowe wyniki wracają do głównej listy |
| General / Confirmations | Confirm unpin / archive / delete | konto | Off / Off / On | Dialog przed odpowiednią akcją wątku we wszystkich menu i komendach |
| General / Display | Time format | urządzenie | System | Godziny w znacznikach czasu web/desktop: system, 12h lub 24h |
| General / Display | Time zone | konto, odczyt z urządzenia | IANA urządzenia, fallback UTC | Istniejąca synchronizacja dla botów i harmonogramów; przeniesiona z Appearance, bez zmiany semantyki |
| Threads / Thread details | Show finished subagents | urządzenie | Off | Zakończeni tylko w liczniku; On pokazuje ostatnie 10 minut i starszych pod Previous subagents. Reset przywraca Off; sidebar zawsze ukrywa subagentów |
| Appearance / Colors | Color scheme; Light theme; Dark theme | konto | System; Birch; Birch | Pełne palety, w tym Ash, niezależne dla obu trybów |
| Appearance / Interface | Contrast | urządzenie | Standard | Wzmocnienie kontrastu tekstu pomocniczego i obrysów w obu schematach |
| Appearance / Interface | Thread width | konto | Comfortable | Szerokość wątku i kompozytora |
| Appearance / Interface | Effort display | urządzenie | Name | Nazwa lub paski w kontrolkach wysiłku modelu, z dostępną nazwą |
| Appearance / Interface | Render math | urządzenie | On | LaTeX w wiadomościach; wyłączenie pokazuje źródło |
| Appearance / Interface | Animated mascots | urządzenie | On | Istniejąca animacja botów, respektuje reduced motion |
| Appearance / Typography | Interface font; Interface size | urządzenie | Canopy (Inter); 14 px | Rodzina i skala typografii interfejsu web/desktop |
| Appearance / Typography | Monospace font; Monospace size | urządzenie | System mono; 13 px | Kod, diffy, wyjście terminala; podgląd wiadomości, diffu i terminala |
| Appearance / Typography | Wrap code blocks; Wrap diffs | urządzenie | Off; Off | Zawijanie długich linii na odpowiednich powierzchniach |
| Diffs / Viewer | Layout | urządzenie | Stacked | Stacked albo side by side; zmiana również na pasku diffu |
| Diffs / Viewer | Hide whitespace changes | urządzenie | Off | Ukrycie wyłącznie zmian różniących się białymi znakami |
| Diffs / Viewer | Default file state | urządzenie | Expanded | Początkowy stan pliku; ręczny wybór obowiązuje w zamontowanym widoku |
| Diffs / Viewer | Diff colors | urządzenie | Red & green | Także Blue & orange; znaki +/− pozostają |
| General / Desktop app | Quit shortcut | urządzenie, store Electron | Press twice | Tylko desktop: sposób reagowania na skrót zamykania (dwukrotne naciśnięcie, przytrzymanie, natychmiast); reset pojedynczy i całej strony General |
| App updates / App updates | Update check frequency | urządzenie/store Electron | Every 6 hours | Rzeczywisty timer procesu main; Hourly / 6h / Daily / Weekly / Never. Never wyłącza automatyczne sprawdzanie i pobieranie, ręczne sprawdzanie działa; ostatni/następny termin i trwałość po restarcie |
| Workers / Agent CLI updates | Agent CLI update check frequency | konto/DB | Every 6 hours | Pobieranie najnowszych wersji Claude Code, Codex i Grok przez gateway; te same interwały i Never; nigdy nie instaluje CLI |
| Workers / Agent CLIs | CLI update checks on this worker | konto, nadpisanie workera | Use account | Efektywna częstotliwość w WorkerConfig, raporty workera i oddzielny trwały stan dostępności aktualizacji; Last checked / Next check; ręczny Check for updates działa również przy Never |

## Istniejące ustawienia zachowane kontekstowo

Poniższe zasoby administracyjne nie są preferencjami urządzenia. Reset nie usuwa
projektów, poświadczeń, zaproszeń ani zasobów. Domyślne „brak” oznacza brak konfiguracji.

| Strona / sekcja | Istniejące pola | Zakres i domyślne | Co zmieniają |
| --- | --- | --- | --- |
| Threads / New threads | Project and worker; Agent; Profile; Model per provider; Permissions | konto: last used, any available, first available, provider default, ask | Wartości początkowe nowych wątków; projekt może nadpisać |
| Threads / Composer | Running delivery (w menu kolejki kompozytora) | konto: Steer | Główna akcja kompozytora podczas pracy; domyślnie Enter, druga akcja Mod+Enter |
| Text generation | Provider instance; Model; Effort; Thread title instructions | konto: automatic, provider default, provider default, puste | Generowanie tytułów i semantycznych nazw gałęzi |
| Scheduled tasks | Target; prompt; run time / recurrence; pause/resume; edit/cancel | konto/zasób: brak zadań | Harmonogram rzeczywistych tur, nie preferencja UI |
| Projects | Workspaces (worker/root path); thread defaults | konto/projekt: brak, dziedziczenie | Miejsce uruchomienia i nadpisania nowych wątków w kompozytorze web; nazwa powstaje przy tworzeniu projektu (bez zmiany nazwy w UI) |
| Worktrees / Scope | Project; computer | konto: wszystkie × wszystkie | Zakres dziedziczenia ustawień worktree |
| Worktrees / Creation | Location; Start from remote; Remote | konto/zakres: managed, Off, origin | Tworzenie katalogu i wybór podstawy gałęzi |
| Worktrees / Branches | Branch naming; Branch prefix; default workspace mode | konto/zakres: semantic, canopy, current checkout | Nowe gałęzie i początkowy tryb kompozytora. Opcja Thread title jest „Soon”: nowe wątki nie wysyłają tytułu, a gałąź nie zmienia nazwy po wygenerowaniu tytułu |
| Worktrees / Cleanup | Deleted threads; Merged branches; Settled threads; Unchanged worktrees | konto/zakres: wszystkie Off | Reguły usuwania worktree bez aktywnych wątków; pojedynczy reset przywraca dziedziczenie |
| Worktrees / Cleanup | Inactive for days; Keep worktrees with local changes; Delete safe local branches | konto/zakres: 0 (Off); On; Off | Retencja i ochrona lokalnej pracy; destrukcyjne wyjątki wymagają potwierdzeń. Keep worktrees with local changes jest „Soon”: sprzątanie zawsze zachowuje lokalną pracę, a przełącznik zmieniał tylko etykietę |
| Agent environment | Instruction fragments; files; skills; sources; plugins; tags; machine targeting; synchronization | konto/zasoby: brak | Konfiguracja środowiska agentów na wybranych workerach |
| Providers | Instances; display name; proxy/native; models; favorites; environment; worker enablement; CLI login/install/updates | konto/zasoby: native, wykryty katalog | Dostępność modeli i konfiguracja harnessów; poświadczenia w gateway |
| Connectors | Accounts; OAuth apps; grants; access targets; test/disconnect | konto/zasoby: brak | Uprawnienia zewnętrznych MCP |
| Proxies | Name; endpoint; API key; provider transport options | konto/zasoby: brak | Współdzielone połączenia dostawców |
| Workers | Enrollments; public gateway URL; SSH install; name/tags; CLI updates | konto/worker: automatic URL, konfiguracja workera | Rejestracja i zdalna konfiguracja workerów. Profile workera ustawia Providers; limity `WorkerConfig.limits` nie mają UI, a worker egzekwuje z nich tylko `idleUnloadSeconds` |
| Network access | Enabled; port; hostnames; routes; TLS fingerprint | komputer gatewaya: Off, automatyczny port | Osiągalność gatewaya i przypięty TLS; adres nasłuchu ustawia wyłącznie konfiguracja gatewaya |
| Network access / Attachments | Per file; per message; file count | konto: 20 MiB, 50 MiB, 10 | Limity uploadu egzekwowane przez gateway |
| Devices | Pairing code / QR; device list; revoke | konto/zasoby: brak | Dostęp telefonów i klientów desktopowych |
| Linked computers | Identity; link/pair; rename; onward sharing; unlink; per-item sharing/conflicts | komputer gatewaya: brak linków, lokalne | Wzajemny dostęp i jawne udostępnianie konfiguracji |
| Desktop | Local/remote mode; worker status; detected CLIs; change mode | urządzenie/store: wybór przy konfiguracji | Wyłącznie topologia uruchomienia i status lokalnych usług; bez ogólnych preferencji zachowania |
| App updates | Installed version; channel; check frequency; check now; download/restart status; release notes | urządzenie/store: kanał builda, 6 h | Wyłącznie aktualizacje powłoki i runtime |

Geometria sidebara/panelu i przypięcia/filtry pozostają w istniejącym kontrakcie
właściciela; nie są usuwane przy resetowaniu nowych preferencji. Udostępnianie między
połączonymi komputerami pozostaje osobną, istniejącą funkcją.

Quit shortcut przenosimy z App updates do General → Desktop app, obok potwierdzeń,
z etykietą „This device” i tylko w Electron. To polityka zachowania przy zamykaniu,
nie zmiana przypisania klawiszy.
Audyt Desktop: tryb local/remote, status workera i wykryte CLI opisują miejsce
uruchomienia usług i pozostają na tej stronie; ogólnych preferencji tam nie dodajemy.
App updates nie zawiera skrótów ani innych ustawień niezwiązanych z aktualizacjami.
Częstotliwość wykrywania aktualizacji CLI pozostaje obok narzędzi Workers;
centrum aktualizacji służy wykonywaniu aktualizacji.

## Pominięcia

- Canopy ma wykrywanie GitHub PR/merge do sprzątania worktree, ale nie ma własnego widoku ani procesu przeglądu PR. Nie dodajemy fikcyjnych preferencji PR.
- „Last user message” nie jest dostępne w indeksie projektów/wątków; używamy istniejącej, prawdziwej aktywności drzewa.
- Brak push/background service worker: alerty działają wyłącznie przy otwartej aplikacji, bez serwerowej dystrybucji dźwięków lub treści.
- Fonty są lokalnymi stosami systemowymi, bez pobierania fontów od stron trzecich.
