# Mapa ustawień Canopy

Status (2026-11-25): web, desktop i mobile grupują sekcje według zadań.
Preferencje listy wątków są w **Threads**, alerty użytkownika w **Notifications**,
a aktualizacje Canopy w **App updates**. Zmiana nawigacji zachowuje zapisane
wartości i ich dotychczasowe zakresy. Dostępność wydań opisuje [release.md](release.md).

Status (2026-11-21): mapa zaimplementowanych ustawień. Lokalny Desktop zawiera
ustawienia relaya mobilnych powiadomień z automatyczną aktywacją relaya Canopy.
Panel webowy serwera również pozwala konfigurować własny relay.
Mapa obejmuje również Full access dla
nowych wątków harmonogramu, usuwanie scalonych lokalnych gałęzi po archiwizacji,
kolejność zakładek i wstrzymywanie pracy modułów,
zgody reguł Archived/Deleted
threads na sprzątanie lokalnych plików worktree oraz wspólnego wyboru
grupowania sidebara w web/desktop i mobile, opcjonalnej retencji archiwum wątków
oraz wspólnego dopasowania słów w wyszukiwaniu ustawień i opcjonalnego wskaźnika kontekstu w composerze web/desktop;
dostępność kanałów według [release.md](release.md).

Status (2026-11-22): sprawdzanie nazw sekcji ustawień przez czat wdrożono w kodzie
wątków i prywatnych rozmów bota. Odpowiedzi o Network access korzystają z opisu
zakresu tej sekcji również przy nieznanym kliencie. Prywatny czat właściciela ma
wyszukiwanie, odczyt i zatwierdzany zapis dawnych domyślnych wartości wyglądu.
Appearance w bieżących klientach jest zapisywane na urządzeniu.
Dostępność wydań według [release.md](release.md).

Status (2026-11-23): natywne Settings zawiera sekcję Agent tools i sprawdza obsługę sekcji przez sparowany gateway.

Status (2026-11-24): ścieżki w tabelach uwzględniają zakładki wewnątrz sekcji web/desktop. Natywne Settings zachowuje własny układ.
Powiadomienia w web/desktop obejmują odnowienie limitu Claude.
Domyślny font interfejsu web i desktop jest widoczny jako Inter.
W trybach lokalnym i zdalnym Desktop ma sekcję **Accessibility** z ustawieniami
fokusu, kontrastu, rozmiaru interfejsu, kolorów diffów i animacji maskotek.

## Nawigacja

Grupy porządkują nawigację, a wybór nazwy sekcji otwiera jej ustawienia.

| Grupa | Sekcje w kolejności widocznej w menu |
| --- | --- |
| Preferences | General, Appearance, Accessibility, Notifications, Keybindings |
| Workspace | Threads, Projects, Worktrees, Diffs, Scheduled tasks, Import |
| Agents | Providers, Agent environment, Agent tools, Memory, Text generation |
| Connections | Connectors, GitHub, Proxies, Network access, Devices, Linked computers |
| System | App updates, Desktop, Workers, Diagnostics, Open-source licenses |

Accessibility i Desktop są widoczne tylko w powłoce desktopowej. Klient pokazuje
sekcje dostępne dla aktywnych modułów i możliwości gatewaya.
W **Threads → Thread list** można ustawić kolejność i grupowanie listy oraz potwierdzenia
jej akcji. W aplikacji mobilnej przy włączonym wyłącznie module Bots potwierdzenia
odpinania i archiwizacji botów są dostępne w General. Alerty dla użytkownika należą do **Notifications**. Osobna opcja
„Notify agent about pull requests” w **Threads** wybiera, czy agent otrzymuje
zdarzenia z GitHuba w powiązanym wątku.

**App updates** skupia sprawdzanie wersji, instalację i postęp aktualizacji Canopy,
w tym gatewaya, workerów i połączonych komputerów. W web/desktop służy do tego
zakładka **Status**. **Releases** pokazuje notatki o wydaniach, a **Update preferences**
pojawia się, gdy klient ma ustawienia aplikacji lub kanału gatewaya. Wskaźnik aktualizacji
w pasku bocznym telefonu prowadzi do tej sekcji, a popover web/desktop ma do niej
odnośnik **Settings** obok szybkich akcji aktualizacji. **Workers → Agent CLIs** służy do sprawdzania
i aktualizowania narzędzi dostawców na workerach.

Wyszukiwarka sekcji w web/desktop i mobile dopasowuje każde słowo zapytania
do nazwy lub słów kluczowych, niezależnie od kolejności, wielkości liter,
interpunkcji i nadmiarowych spacji. Indeks obejmuje nazwy opcji Threads i Worktrees
oraz synonimy sprzątania: `cleanup` i `clean up` wskazują obie strony,
`auto delete` retencję w Threads i automatyczne usuwanie worktree,
a `merged branches` sprzątanie w Worktrees.
Te same słowa kluczowe są dostępne w palecie poleceń web/desktop;
paleta zachowuje własny algorytm dopasowania rozmytego.
W Desktop słowa `focus indicators`, `contrast` i `interface size` wskazują
Accessibility. `animated mascots` wskazuje tę sekcję przy włączonych botach,
a `diff colors` i `blue orange` przy włączonych wątkach.

**System → Diagnostics**: karty wszystkich komputerów, metryki RPC i RTT, findings
oraz osobne granty odczytu przez relay; [diagnostics.md](diagnostics.md).
W web/desktop **Overview** pokazuje stan komputerów, **Performance** metryki wybranego
komputera, **Calls and tracing** wywołania RPC i tracing, a **Reports and logs** udostępnia raporty i zbieranie logów.

„Account” oznacza ustawienia właściciela w DB aktualnego gatewaya, wspólne dla jego
klientów web/desktop. Nie oznacza automatycznej synchronizacji niezależnych gatewayów.
„This device” oznacza profil przeglądarki/origin lub lokalną powłokę Electron.
Stan widoku dodatkowo rozdziela gatewaye: web używa niejawnego identyfikatora BFF,
desktop remote przypiętego certyfikatu, mobile certyfikatu i identyfikatora parowania.
Aplikacja mobilna trzyma Turn activity dla samego telefonu (docs/mobile.md).
Każda nowa preferencja ma opis zakresu i działania oraz reset po zmianie.
Istniejące domyślne wartości wątków i generowania tekstu otrzymują również reset
pojedynczych pól; reset agenta zeruje jego zależny profil, zachowując modele innych agentów.
Reset strony przywraca wyłącznie jej preferencje urządzenia, bez cofania zgód systemowych.
Ustawienie, którego funkcja jeszcze nie istnieje, nie udaje działania: `SettingsRow soon`
pokazuje znacznik „Soon”, blokuje kontrolkę i ukrywa reset, więc zapisana wartość zostaje
bez zmian. Opcja wyboru bez działania jest wyłączona z opisem „Soon”.

## Odpowiedzi czatu o ustawieniach

`find_canopy_settings` czyta katalog sekcji współdzielony z nawigacją aplikacji.
Potwierdza dokładną nazwę sekcji dla web, desktop, iOS lub Android i wersji
klienta odpowiadającej katalogowi bieżącego gatewaya. Wersja workera, wybrany
kanał aktualizacji i wersja samego gatewaya nie identyfikują klienta. Wątek
nie otrzymuje rodzaju klienta ani wersji aplikacji wraz z wiadomością. Sam
system Windows nie rozstrzyga, czy autor używa aplikacji Desktop czy web.
Przy nieznanej, rozbieżnej albo deweloperskiej wersji takiej jak `0.0.0-dev`
narzędzie zwraca brak potwierdzenia. Dla sekcji zależnej od modułu lub funkcji
gatewaya wynik jest warunkowy. Czat przekazuje warunki razem ze ścieżką.

Dopasowanie słowa kluczowego służy wyłącznie jako sugestia wyszukiwania.
Potwierdzenie sekcji dotyczy jej nazwy. Przed podaniem ścieżki czat sprawdza też,
czy zakres sekcji pasuje do pytania. Brakujące informacje nazywa wprost i wtedy
pozostawia ścieżkę niepotwierdzoną. Dla zapytania o Network access narzędzie
opisuje połączenia przychodzące do Canopy także przy braku danych klienta.
Sekcja nie steruje połączeniami wychodzącymi procesu agenta, w tym z GitHubem.
[Zakres ustawień sieciowych](network-access.md).

Katalog przydaje się też w prywatnej rozmowie
bota bez dostępu do repozytorium czy internetu. W starszej sesji Codexa
utrwalony katalog narzędzi może wymagać nowego wątku; reguła niezgadywania
obowiązuje też przy wznowieniu bez narzędzia.

### Preferencje dostępne dla bota

W prywatnym czacie właściciela `search_canopy_preferences` zwraca krótką listę
dopasowań, do pięciu pozycji. `get_canopy_preference` odczytuje bieżącą wartość
jednej pozycji, możliwe wybory, zakres i wersję ustawień konta. Wartość dotyczy
starszych klientów i jednorazowego importu w nowych klientach. Dostępne są
**Color scheme** (`appearance.color_scheme`) i **Thread width**
(`appearance.thread_width`). Web, desktop i mobile korzystają z tych samych
etykiet i opcji co narzędzia. Ścieżka kontrolki wymaga zgodnej, opublikowanej
wersji klienta. Thread width jest widoczne przy włączonym module Threads.

`set_canopy_preference` przyjmuje identyfikator, jedną z podanych wartości
i wersję z odczytu. Karta pokazuje nazwę ustawienia, proponowaną wartość i zakres.
Zapis dawnej wartości domyślnej następuje po zgodzie właściciela. Zapisany już
wygląd klienta edytuje się bezpośrednio w jego Settings → Appearance. Odpowiedź
zawiera zapisaną wartość i nową wersję albo przyczynę odmowy. Lokalna konfiguracja
urządzenia, poświadczenia, integracje, sieć, zasady bezpieczeństwa i uprawnienia
są poza katalogiem. [Zgody i zakres](bots.md#harmonogramy-ustawienia-i-boty).

## Preferencje i przeniesienia

| Strona / sekcja | Ustawienie | Zakres | Domyślnie | Skutek |
| --- | --- | --- | --- | --- |
| General / Modules | First tab; Threads; Bots | konto | Threads, następnie Bots | Pierwszy moduł otwiera się przy starcie. Wyłączenie modułu zatrzymuje jego pracę, ukrywa widoki i rozłącza boty z wątkami. Ponowne włączenie przywraca historię i obsługę wcześniej aktywnych automatyzacji. |
| Keybindings | Skróty komend, kompozytora, cytowania i modeli | urządzenie | przypisania rejestru | Wyszukiwanie, edycja, nagrywanie i dodatkowe przypisania z kontrolą konfliktów kontekstu |
| Notifications | Thread notifications | urządzenie | Off | Alert systemowy, gdy wątek kończy turę, ma błąd, zatrzymuje go system albo czeka na zgodę/odpowiedź; tytuł wątku, projekt/komputer i krótki podgląd; tylko gdy otwarte jest okno Canopy (na macOS zamknięte okno nie wysyła alertów); z dźwiękiem oglądany wątek gra tylko dźwięk; web wymaga zgody Notification API i pokazuje odmowę lub zamknięty monit, desktop używa natywnego `Notification` przez IPC ([notifications.md](notifications.md)) |
| Notifications | Bot notifications | urządzenie | Off | Alert systemowy o wiadomości bota do użytkownika, karcie zgody lub pytaniu; nazwa bota i krótki podgląd; te same zasady zgody, fokusu, dźwięku i duplikatów co dla wątków |
| Notifications | Claude usage limit resets | urządzenie | Off | Cichy alert o potwierdzonym odnowieniu wyczerpanego limitu bezpośredniego konta Claude lub konta z CLIProxyAPI, gdy okno Canopy jest otwarte |
| Notifications | In-app notifications | urządzenie | On | Toast o innym wątku lub rozmowie bota albo resecie limitu Claude przy fokusie aplikacji |
| Sidebar | Project filter | urządzenie/gateway | All projects | Filtr listy aktywnej i archiwum, niezależny od pozostałych urządzeń |
| Threads / Thread list / Sidebar | Group by | urządzenie/gateway | None | None / Project / Project & worktree; zwijane nagłówki z ikonami projektów i liczbą wątków w web/desktop oraz mobile. Zachowuje przypięcia i priorytet pytań; reset wyłącza oba poziomy |
| Threads / Thread list / Sidebar | Project order | urządzenie/gateway | Latest activity | Kolejność grup według aktywności, nazwy lub utworzenia projektu; bez obietnicy ostatniej wiadomości użytkownika, której indeks nie udostępnia |
| Threads / Thread list / Sidebar | Working section | urządzenie/gateway | Off | Osobna zwijana sekcja pracujących wątków/drzew; pytania i nowe wyniki wracają do głównej listy |
| Threads / Thread list / Confirmations | Confirm unpin / archive / delete | konto | Off / Off / On | Dialog przed odpowiednią akcją wątku we wszystkich menu i komendach |
| General / Device / Time | Time format | urządzenie | System | Godziny w znacznikach czasu web/desktop: system, 12h lub 24h |
| General / Device / Time | Time zone | konto, odczyt z urządzenia | IANA urządzenia, fallback UTC | Istniejąca synchronizacja dla botów i harmonogramów; przeniesiona z Appearance, bez zmiany semantyki |
| Threads / Conversation / Thread details | Keep finished subagents in the list | urządzenie | Off | Off grupuje zakończonych pod rozwijanym N finished; On pokazuje ostatnie 10 minut i starszych pod Previous subagents. Reset przywraca Off; sidebar zawsze ukrywa subagentów |
| Threads / Archiving / Archived threads | Auto-delete archived threads; czas w dniach | konto/DB | Off | Trwałe usuwanie historii po 1–36500 dniach od archiwizacji, również istniejącego archiwum; jawny Save, wyłączenie zatrzymuje nowe usunięcia; pliki projektu pozostają, źródła potrzebne zachowanym forkom czekają |
| Threads / Conversation / Turn activity | While working | urządzenie | Expanded | Rozwinięta lub zwinięta praca podczas tury; Expanded pokazuje postęp, podsumowania rozumowania i narzędzia. Ręczny wybór foldu ma pierwszeństwo; osobny reset |
| Threads / Conversation / Turn activity | After the turn | urządzenie | Collapse | Collapse zamyka pracę przy niepustej odpowiedzi oznaczonej final_answer, a bez wiarygodnej fazy przy końcu tury; Keep open zostawia ją rozwiniętą. Czytana praca i ręczny wybór pozostają zachowane; osobny reset |
| Appearance / Themes | Color scheme; Light theme; Dark theme | urządzenie | System; Birch; Birch | Pełne palety, w tym Ash, niezależne dla obu trybów |
| Appearance / Interface | Contrast | urządzenie | Standard | Wzmocnienie kontrastu tekstu pomocniczego i obrysów w obu schematach |
| Appearance / Interface | Thread width | urządzenie | Comfortable | Szerokość wątku i kompozytora |
| Appearance / Interface | Effort display | urządzenie | Name | Nazwa lub paski w kontrolkach wysiłku modelu, z dostępną nazwą |
| Appearance / Interface | Context display | urządzenie | Off | Off / Circle / Text / Bar we wszystkich wątkach web/desktop; ostatni raport zajętości i limitu kontekstu, szczegóły po hoverze, fokusie klawiatury lub dotknięciu. Nie uwzględnia szkicu; brak pomiaru ukrywa wskaźnik, zachowując miejsce. Reset pola i całej strony przywraca Off |
| Appearance / Interface | Render math | urządzenie | On | LaTeX w wiadomościach; wyłączenie pokazuje źródło |
| Appearance / Interface | Animated mascots | urządzenie | On | Istniejąca animacja botów, respektuje reduced motion |
| Appearance / Typography | Interface font; Interface size | urządzenie | Inter; 14 px | Rodzina i skala typografii interfejsu web/desktop |
| Appearance / Typography | Monospace font; Monospace size | urządzenie | System mono; 13 px | Kod, diffy, wyjście terminala; podgląd wiadomości, diffu i terminala |
| Appearance / Typography | Wrap code blocks; Wrap diffs | urządzenie | Off; Off | Zawijanie długich linii na odpowiednich powierzchniach |
| Accessibility (Desktop) | Focus indicators | urządzenie | Keyboard only | Obrys aktywnej kontrolki podczas nawigacji klawiaturą. Always pokazuje go także po kliknięciu. W trybie Off obrys pozostaje widoczny wyłącznie przy systemowych wymuszonych kolorach. |
| Accessibility (Desktop) | Contrast, Interface size, Diff colors, Animated mascots | urządzenie | Standard, 14 px, Red & green, On | Te same preferencje co w Appearance i Diffs. Diff colors wymaga włączonego modułu Threads, a Animated mascots modułu Bots. |
| Diffs / Viewer | Layout | urządzenie | Stacked | Stacked albo side by side; zmiana również na pasku diffu |
| Diffs / Viewer | Hide whitespace changes | urządzenie | Off | Ukrycie wyłącznie zmian różniących się białymi znakami |
| Diffs / Viewer | Default file state | urządzenie | Expanded | Początkowy stan pliku; ręczny wybór obowiązuje w zamontowanym widoku |
| Diffs / Viewer | Diff colors | urządzenie | Red & green | Także Blue & orange; znaki +/− pozostają |
| General / Device / Desktop app | Quit shortcut | urządzenie, store Electron | Press twice | Tylko desktop: sposób reagowania na skrót zamykania (dwukrotne naciśnięcie, przytrzymanie, natychmiast); reset pojedynczy i całej strony General |
| App updates / Update preferences | Update check frequency | urządzenie/store Electron | Every 6 hours | Rzeczywisty timer procesu main; Hourly / 6h / Daily / Weekly / Never. Never wyłącza automatyczne sprawdzanie i pobieranie, ręczne sprawdzanie działa; ostatni/następny termin i trwałość po restarcie |
| Workers / Agent CLIs / CLI update schedule | Agent CLI update check frequency | konto/DB | Every 6 hours | Pobieranie najnowszych wersji Claude Code, Codex i Grok przez gateway; te same interwały i Never; nigdy nie instaluje CLI |
| Workers / wybrany worker / Agent CLIs | Update checks | konto, nadpisanie workera | Use account | Efektywna częstotliwość w WorkerConfig, raporty workera i oddzielny trwały stan dostępności aktualizacji; Last checked / Next check; ręczny Check for updates działa również przy Never |

## Istniejące ustawienia zachowane kontekstowo

Poniższe zasoby administracyjne nie są preferencjami urządzenia. Reset nie usuwa
projektów, poświadczeń, zaproszeń ani zasobów. Domyślne „brak” oznacza brak konfiguracji.

| Strona / sekcja | Istniejące pola | Zakres i domyślne | Co zmieniają |
| --- | --- | --- | --- |
| Threads / New threads | Project and worker; Agent; Profile; Model per provider; Permissions | konto: last used, any available, first available, provider default, ask | Wartości początkowe nowych wątków; projekt może nadpisać. Permissions: Ask first, Accept edits, Read only, Full auto, Full access (bez sandboxa; wybór wymaga potwierdzenia, także w edytorze harmonogramu) |
| Threads / Conversation / Messages | Running delivery (również w menu kolejki kompozytora) | konto: Steer | Główna akcja kompozytora podczas pracy; domyślnie Enter, druga akcja Mod+Enter |
| Text generation | Provider instance; Model; Effort; Thread title instructions | konto: automatic, provider default, provider default, puste | Generowanie tytułów i semantycznych nazw gałęzi |
| Scheduled tasks | Target; prompt; run time / recurrence; pause/resume; edit/duplicate/cancel | konto/zasób: brak zadań | Harmonogram rzeczywistych tur, nie preferencja UI |
| Projects | Workspaces (worker/root path); thread defaults | konto/projekt: brak, dziedziczenie | Miejsce uruchomienia i nadpisania nowych wątków w kompozytorze web; nazwa powstaje przy tworzeniu projektu (bez zmiany nazwy w UI) |
| Projects / wybrany projekt / Workspaces / Worktrees | Default workspace | projekt × wszystkie komputery: dziedziczenie | Skrót do zakresu projektu z Settings → Worktrees (ta sama wartość); link „Worktree settings” otwiera stronę Worktrees z tym projektem (`?project=`) |
| Worktrees / Scope | Project; computer | konto: wszystkie × wszystkie | Zakres dziedziczenia ustawień worktree |
| Worktrees / New worktrees / Creation | Location; Start from remote; Remote | konto/zakres: managed (`~/canopy/worktrees` workera; w zakresie komputera UI pokazuje zgłoszoną ścieżkę), Off, origin | Tworzenie katalogu i wybór podstawy gałęzi |
| Worktrees / New worktrees | Branch naming; Branch prefix; default workspace mode | konto/zakres: semantic, canopy, current checkout | Nowe gałęzie i początkowy tryb kompozytora. Opcja Thread title jest „Soon”: nowe wątki nie wysyłają tytułu, a gałąź nie zmienia nazwy po wygenerowaniu tytułu |
| Worktrees / Cleanup rules | Deleted threads; Merged branches; Archived threads; Unchanged worktrees | konto/zakres: wszystkie Off | Reguły usuwania worktree bez aktywnych wątków; pojedynczy reset przywraca dziedziczenie |
| Worktrees / Cleanup rules | Inactive for days; Keep worktrees with local changes; Delete safe local branches | konto/zakres: 0 (Off); On; Off | Reguły Archived/Deleted threads zezwalają odrzucić lokalne pliki po zamknięciu wszystkich współdzielących wątków; opcjonalne sprzątanie lokalnej gałęzi wymaga potwierdzonego merge oraz archiwizacji wątków zgodnie z [regułami worktree](worktrees.md#sprzątanie-etap-2). Pozostałe reguły chronią zwykłe lokalne zmiany; pliki ignorowane przez Git nie blokują sprzątania. Keep worktrees with local changes pozostaje „Soon” i zmienia tylko etykietę dla pozostałych reguł |
| Agent tools | Agent Browser, Agent Desktop, Agent Device; Session defaults | dostęp per worker; wartości początkowe na koncie | Włączanie dostępu, instalacja, gotowość i ustawienia nowych sesji na web, desktop i mobile |
| Agent environment | Instruction fragments; files; skills; sources; plugins; tags; machine targeting; synchronization | konto/zasoby: brak | Konfiguracja środowiska agentów na wybranych workerach |
| Providers | Instances; display name; proxy/native; models; favorites; environment; worker enablement; CLI login | konto/zasoby: native, wykryty katalog | Dostępność modeli i konfiguracja harnessów; poświadczenia w gateway. W web/desktop odnośnik Manage agent CLIs otwiera ustawienia CLI dla wybranego zakresu workerów. |
| Connectors | Accounts; OAuth apps; grants; access targets; test/disconnect | konto/zasoby: brak | Uprawnienia zewnętrznych MCP |
| Proxies | Name; endpoint; API key; provider transport options | konto/zasoby: brak | Współdzielone połączenia dostawców |
| Workers | Enrollments; public gateway URL; SSH install; name/tags; Agent CLIs | konto/worker: automatic URL, konfiguracja workera | Rejestracja i zdalna konfiguracja workerów. Profile workera ustawia Providers; limity `WorkerConfig.limits` nie mają UI, a worker egzekwuje z nich tylko `idleUnloadSeconds` |
| Network access | Enabled; port; hostnames; routes; TLS fingerprint | komputer gatewaya: Off, automatyczny port | Osiągalność gatewaya i przypięty TLS; adres nasłuchu ustawia wyłącznie konfiguracja gatewaya |
| Network access / Attachments | Per file; per message; file count | konto: 20 MiB, 50 MiB, 10 | Limity uploadu egzekwowane przez gateway |
| Network access / Push relay | Canopy relay; Relay address; Relay token; prywatne CA | web serwerowy: konfiguracja wdrożenia. Lokalny Desktop: relay Canopy | Relay Canopy aktywuje się po włączeniu push na sparowanym telefonie i weryfikacji aplikacji. Wybór zapisany w panelu ma pierwszeństwo i działa bez restartu. |
| Devices | Pairing code / QR; device list; revoke | konto/zasoby: brak | Dostęp telefonów i klientów desktopowych |
| Linked computers | Identity; link/pair; rename; onward sharing; unlink; per-item sharing/conflicts | komputer gatewaya: brak linków, lokalne | Wzajemny dostęp i jawne udostępnianie konfiguracji |
| Desktop | Local/remote mode; worker status; detected CLIs; change mode | urządzenie/store: wybór przy konfiguracji | Wyłącznie topologia uruchomienia i status lokalnych usług; bez ogólnych preferencji zachowania |
| App updates | Status; Update preferences; Releases | aplikacja: kanał buildu, sprawdzanie co 6 h na desktopie; gateway: ustawienia administratora | Sprawdzanie, instalacja i postęp aktualizacji dostępnych dla tego klienta. Kanał i częstotliwość sprawdzania aplikacji połączonego komputera ustawia się na tym komputerze. |

Stan widoku jest lokalny dla urządzenia i gatewaya: filtr projektów, grupowanie,
zwinięcie projektów i worktree,
kolejność grup, sekcja Working, rozwinięcie archiwum wątków i botów,
zwinięcie sidebara i panelu szczegółów wątku oraz szerokość sidebara i panelu PR.
Wspólny `@canopy/domain/device-view` definiuje typowane pola, wartości domyślne,
klucze `canopy.client-view.v2.<scope>` i migrację. Web/desktop zapisuje localStorage,
mobile plik JSON w katalogu dokumentów przez istniejący `expo-file-system` (bez zmian natywnych).
Stare lokalne klucze `canopy:preferences:view` i `canopy.settings.view.v1` służą tylko
do przeniesienia wcześniejszej geometrii i rozwinięć. Otwarcie archiwalnego wątku
rozwija archiwum tylko na tym urządzeniu. Jawne zwinięcie pozostaje możliwe.
Przy pierwszym odczycie brakujące wartości są jednorazowo kopiowane ze starych
ustawień konta; zapisane `false` i szerokość `0` również blokują kolejne kopiowanie.
Pola proto pozostają dla starych klientów. Nowe klienty nie zmieniają ich przy
obsłudze widoku; synchronizacja konfiguracji nie eksportuje ani nie stosuje tych pól.
Reset stron General/Appearance nie zmienia zapamiętanego stanu widoku.

Schemat i palety kolorów oraz szerokość czatu są częścią lokalnego Appearance.
Przy pierwszym odczycie ustawień klient importuje stary wygląd, jeśli nie ma
jeszcze zapisanego wyboru. [Zapis i pierwszy render](appearance.md#zapis-i-pierwszy-render).
Potwierdzenia, domyślne nowego wątku i tryb Steer/Queue nadal opisują zachowanie.
Przypięcia wątków/botów organizują zasoby i także pozostają na koncie. Nowe klienty
zmieniają w sekcji `sidebar` wyłącznie przypięcia, zachowując stare pola dla migracji.
Gateway nadal przyjmuje zapisy starych klientów; nie usuwa pól proto ani danych DB.
Pamięć ostatniej sekcji Settings, tras, przewijania oraz ręczne
foldy już żyją w pamięci klienta lub preferencjach urządzenia. Gęstość, typografia
i domyślne rozwinięcie aktywności tur także pozostają lokalne. Filtr mobile używa
tego samego modelu co web; wyszukiwanie jest przejściowym stanem listy. Obecny
kontrakt nie ma osobnego filtra komputerów ani statusu; kolejność wątków wynika z aktywności.
Istniejące zakresy powiadomień i keybindings pozostają bez zmian.
Udostępnianie między połączonymi komputerami pozostaje osobną funkcją.

Quit shortcut jest dostępny w Electron w General → Device → Desktop app
z etykietą „This device”. To polityka zachowania przy zamykaniu,
nie zmiana przypisania klawiszy.
Audyt Desktop: tryb local/remote, status workera i wykryte CLI opisują miejsce
uruchomienia usług i pozostają na tej stronie; ogólnych preferencji tam nie dodajemy.
App updates nie zawiera skrótów ani innych ustawień niezwiązanych z aktualizacjami.
W Workers → Agent CLIs sekcja CLI update schedule określa częstotliwość sprawdzania wersji CLI.

## Pominięcia

- Panel GitHub PR ma lokalną szerokość; jego zmiana nie jest ustawieniem konta.
- „Last user message” nie jest dostępne w indeksie projektów/wątków; używamy istniejącej, prawdziwej aktywności drzewa.
- Brak push/background service worker: alerty działają wyłącznie przy otwartej aplikacji, bez serwerowej dystrybucji dźwięków lub treści.
- Fonty są lokalnymi stosami systemowymi, bez pobierania fontów od stron trzecich.
