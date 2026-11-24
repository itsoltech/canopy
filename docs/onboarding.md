# Onboarding Canopy — specyfikacja MVP

Status (2026-12-03): w webie i we wspólnym widoku desktopu działa pełnoekranowe wprowadzenie dla nowych instalacji oraz **Set up Canopy**, pierwszy wątek z przykładem, wyszukiwanie katalogów Git i informacje o prywatności. Plan kolejnych etapów obejmuje bibliotekę Explore Canopy, przykłady projektowe i publiczny Quickstart. Dostępność wydań opisuje [release.md](release.md).

Po otwarciu Canopy użytkownik może uzyskać pierwszy wynik na przykładowych danych albo zacząć od własnego projektu. Gdy brakuje konfiguracji, aplikacja pokazuje następny krok i po jego wykonaniu przywraca wybrane zadanie. Biblioteka **Explore Canopy** pozwala odkrywać kolejne zastosowania w dowolnym momencie.

MVP obejmuje wspólny interfejs web i desktop po uruchomieniu lub sparowaniu z gatewayem, konfigurację pierwszego agenta, trzy przykłady oparte na wątkach oraz publiczny Quickstart. Wymagania przykładów wynikają z włączonych modułów i stanu podłączonej instalacji. Opis dostępności poszczególnych wydań należy do informacji o wydaniach. [Architektura](architecture.md) · [Desktop](desktop.md#ekran-uruchamiania) · [Wydania](release.md)

## 1. Pierwszy wątek

Pod adresem **New thread** aplikacja pokazuje wprowadzenie na całej powierzchni okna, bez paska bocznego i nawigacji wątków. Czeka na potwierdzenie stanu gatewaya i pokazuje wprowadzenie, kiedy moduł Threads jest włączony i użytkownik nie ma jeszcze projektu, historii wątków ani własnego szkicu. Do sprawdzenia historii używa listy wątków i ostatniego wątku właściciela, dostępnego także po archiwizacji. Projekt systemowy **No project** pomija przy sprawdzaniu projektów. Bezpośrednie linki z wybranym projektem lub workspace’em otwierają zwykły kompozytor.

Automatyczne powitanie wymaga zgody gatewaya (`ClientCapabilities.offer_onboarding`). Migracja `0192_gateway_onboarding` oznacza bazę inicjalizowaną od zera. Gateway zapisuje wersję pierwszego uruchomienia i oferuje powitanie na tej wersji. Aktualizacja istniejącej instalacji zachowuje zwykły ekran również wtedy, gdy baza nie zawiera jeszcze wątków albo klient nie ma zapisanych preferencji. Desktop Local korzysta z lokalnej bazy. Desktop Remote odczytuje stan sparowanego gatewaya. **Set up Canopy** w palecie działa również na istniejącej instalacji.

| Element | Tekst UI | Działanie |
| --- | --- | --- |
| Nagłówek | Start your first task | |
| Opis przy brakującej konfiguracji | Connect a worker and set up an agent to start working. | |
| Opis przy gotowej konfiguracji | Try an agent on a sample bug report. | |
| Konfiguracja | Set up Canopy | Otwiera listę kroków. Jest akcją główną, jeśli brakuje workera lub dostępnego modelu. |
| Przykład | Try sample task | Otwiera **Turn a bug report into a test plan**. Jest akcją główną, kiedy worker i model są dostępne. |
| Odnośnik (plan) | Explore Canopy | Otwiera bibliotekę przykładów. |
| Odnośnik | Skip introduction | Otwiera zwykły **New thread** i zapamiętuje wybór. |

Pod akcją główną pozostaje dostępna bieżąca sugestia **Import**, jeśli wykryła historię CLI. Otwarcie importu zachowuje miejsce powrotu. Po zaimportowaniu historii **New thread** działa w zwykłym trybie. Przy włączonym wyłącznie module Bots aplikacja otwiera jego stronę główną, a **Set up Canopy** można otworzyć z palety poleceń. [Nowy wątek](threads.md#no-project--rozmowy-na-maszynie) · [Import](import.md) · [Ustawienia](settings-map.md)

### Konfiguracja krok po kroku

**Set up Canopy** otwiera stronę z opisem `Set up one agent, then choose what to bring into Canopy.` Lista używa bieżącego stanu instalacji, sugeruje najbliższy krok i otwiera istniejące ekrany konfiguracji. Paleta poleceń **Set up Canopy** pozwala wrócić do listy w dowolnym momencie. Zapisany wybór workera przywraca się po powrocie z ustawień lub przeładowaniu strony w tym samym zakresie klienta i gatewaya.

Lista kroków, przykład i informacje o prywatności zajmują całą powierzchnię okna. Ustawienia otwarte w tym przepływie pokazują wybraną sekcję i przycisk **Back**, bez nawigacji ustawień. Kreatory, takie jak dodawanie workera, proxy i projektu, otwierają się nad bieżącym krokiem. **Back** zamyka ustawienia albo wraca z przykładu lub prywatności do poprzedniej strony. **Exit setup** otwiera zwykły widok **New thread** lub **Bots** i pomija automatyczne powitanie w Threads na tym kliencie. Po otwarciu pierwszego szkicu nawigacja aplikacji wraca.

| Krok | Tekst UI | Przebieg |
| --- | --- | --- |
| Worker | **Choose a worker** · `Choose the computer that runs your agent and can reach your files.` | Desktop Local od razu wybiera uruchomionego lokalnego workera. Serwer bez workera pokazuje **Add worker**. Desktop Remote korzysta z workerów sparowanego gatewaya. Nazwa wybranego komputera pojawia się też w następnych krokach. |
| Dostawca | **Set up an agent** · `Use an existing sign-in or connect to a model service.` | Pokazuje Claude Code, Codex, Grok i Antigravity. Dla Antigravity podaje polecenie logowania na workerze. Jeśli jest skonfigurowana instancja z dostępnym modelem, proponuje jej użycie. Przy brakującym CLI otwiera **Agent CLIs** z **Install** lub instrukcją ręczną. Przy konfiguracji natywnej prowadzi do **Device login** i odpowiedniej akcji logowania. |
| Własny endpoint | **Use a proxy** · `Choose a proxy or add a compatible endpoint.` | Opcjonalna ścieżka konfiguracji dostawcy. Otwiera wybór zapisanego **Proxy** lub **Add proxy**, po czym wraca z wybranym połączeniem do tej samej instancji. Użytkownik wybiera workera. Aplikacja czeka na dostępny model na tym workerze. |
| Historia | **Import CLI history** · `Review threads and settings from Claude Code, Codex or Grok.` | Krok opcjonalny dostępny po połączeniu workera niezależnie od logowania do dostawcy. Otwiera obecny **Import** z wybranym workerem. Podgląd pokazuje znalezione wątki, katalogi i proponowane projekty. Użytkownik zatwierdza wybór wraz z trybem **Continue where possible** lub **History only**. Ustawienia i biblioteka mają własny wybór. |
| Projekty | **Add projects** · `Choose the directories you want your agent to work in.` | Krok opcjonalny. Pokazuje projekty lub workspace’y utworzone przez import. **Add project** otwiera istniejący kreator, a **Find Git repositories** pokazuje repozytoria w wybranym katalogu workera. |

Jedna dostępna instancja wystarcza, by przejść do zadania. **Try sample task** otwiera przykład bez projektu, a **Start a thread** otwiera standardowy kompozytor. Użytkownik może wrócić do importu i projektów później. Po zapisaniu projektu lub zakończeniu importu lista odświeża stan i pokazuje wynik operacji. [Dodawanie workera](worker-config.md#dodanie-maszyny-z-ui) · [Instalacja CLI](provider-cli.md) · [Logowanie dostawców](provider-accounts.md#logowanie-i-wylogowanie-z-aplikacji) · [Proxy](proxies.md) · [Import](import.md#przepływ)

**Test connection** przy proxy sprawdza dostęp do katalogu modeli z gatewaya. Gotowość do użycia wybranej instancji wynika z dostępności modelu na docelowym workerze, a pierwsza rzeczywista odpowiedź potwierdza działanie całej ścieżki. Import historii używa bieżącego skanu CLI, jeśli jest dostępny dla wybranego workera. Przeniesienie istniejących danych Canopy prowadzi do instrukcji migracji lub odtworzenia kopii. [Test proxy](proxies.md#test-połączenia) · [Migracja Desktop Local](desktop.md#migracja-gatewaya-local) · [Odtworzenie kopii](deploy.md#ręczny-eksport-i-odtworzenie)

### Wyszukiwanie projektów Git

**Find Git repositories** prowadzi do wyboru katalogu na nazwanym workerze. Tekst `Choose a directory to find the Git repositories inside it.` zapowiada listę bezpośrednich podkatalogów oznaczonych jako Git w istniejącym odczycie katalogu. Lista pokazuje nazwę i ścieżkę, a dla już dodanych pozycji stan **Already added** na podstawie workera i ścieżki. Użytkownik wybiera pozycję i zatwierdza ją standardowym **Add directory**. Z pustej listy `No Git repositories in this directory.` można wrócić akcją **Choose directory** albo dodać wskazany katalog jako zwykły projekt. Także dla repozytorium głębiej w drzewie użytkownik może przejść do jego katalogu nadrzędnego. [Przeglądarka katalogów](ui-api.md) · [Tożsamość projektu](linked-computers.md#tożsamość-projektu-według-git-origin)

## 2. Biblioteka i szczegóły przykładu

Plan kolejnego etapu obejmuje wspólną bibliotekę i jej skrót w pasku bocznym. Pierwszy przykład jest dostępny z **Set up Canopy**.

**Explore Canopy** to strona we wspólnej powłoce, dostępna z paska bocznego i palety poleceń. Strona zawiera trzy wiersze z tytułem i opisem z §4 oraz odnośnik **Open quickstart**. Otwarcie wiersza prowadzi do szczegółów z własnym adresem. **Back** wraca do listy, a zamknięcie Settings wraca do tych samych szczegółów.

| Widok | Tekst UI | Zawartość i interakcja |
| --- | --- | --- |
| Lista | **Explore Canopy** · `Choose a task to see what Canopy can do.` | Trzy przykłady w kolejności z §4. Przykłady można przeglądać przed konfiguracją. |
| Szczegóły | Tytuł i opis przykładu · **What you need** · **Sample result** | Pod tytułem widać wymagania i akcję. Podgląd następuje po akcji, z własnym nagłówkiem **Sample result**. |
| Gotowość do pracy | **Open thread draft** | Otwiera **New thread** z edytowalną wiadomością i wybranym zakresem **Read only**. Przykład wskazuje workera w standardowym pickerze. |
| Własny szkic w celu przykładu | **Replace this draft?** · `This replaces the unsent message, its attachments and draft settings.` · **Keep draft** / **Replace draft** | **Keep draft** otwiera dotychczasowy szkic. **Replace draft** wstawia przykład do tego celu. Fokus w oknie potwierdzenia zaczyna na **Keep draft**. |

Wariant bez projektu wybiera systemowy **No project**. Warianty z projektem używają istniejących pickerów projektu i workera. Jeśli jest kilka pasujących opcji, wybór jest widoczny i można go zmienić przed otwarciem szkicu. Aplikacja używa domyślnego agenta i modelu, jeśli są dostępne w wybranym miejscu, a w innym przypadku oferuje dostępne opcje. Wysłanie wiadomości przebiega przez standardową akcję kompozytora i standardowe egzekwowanie uprawnień. Jeśli wysyłka bieżącego szkicu już trwa, aplikacja otwiera istniejący widok tworzenia wątku dla tego szkicu. [Wątki i workery](threads.md#2-dlaczego-wątek-jest-przypięty-do-workera-i-katalogu) · [Domyślne ustawienia](settings-map.md)

### Widoczność skrótu w pasku bocznym

Skrót **Explore Canopy** jest domyślnie widoczny. Preferencja **This device** dotyczy paska bocznego i jego odpowiednika na wąskim ekranie. Aplikacja zapamiętuje wybór dla klienta i bieżącego gatewaya, osobno od pominięcia wprowadzenia. Ukrycie skrótu z otwartej biblioteki zamyka menu i zwraca fokus na jego przycisk. Biblioteka pozostaje otwarta.

| Miejsce | Tekst UI | Działanie |
| --- | --- | --- |
| Menu `…` na stronie biblioteki | **Hide from sidebar** / **Show in sidebar** | Zmienia widoczność skrótu od razu. Menu pokazuje akcję odpowiednią do zapisanego stanu. |
| Paleta poleceń | **Explore Canopy** | Otwiera bibliotekę także przy ukrytym skrócie. Na wąskim ekranie paletę otwiera **Search and commands**. |
| Settings → General → Sidebar | **Explore Canopy shortcut** · `Show the examples library in the sidebar on this device.` | Przełącznik z domyślną wartością włączoną i resetem do tej wartości. Jest dostępny także przy włączonym wyłącznie module Bots. |

Bezpośrednie linki do biblioteki, przykładów i strony o prywatności otwierają wskazany widok także przy ukrytym skrócie. [Zakres ustawień](settings-map.md#nawigacja)

## 3. Stany konfiguracji

W szczegółach przykładu aplikacja pokazuje jedną główną akcję dla pierwszej przeszkody dotyczącej bieżącego celu. Najpierw sprawdza połączenie, moduł i obecność workera, następnie projekt i workspace, a na końcu CLI, instancję i model dla wybranego workera. W otwartych szczegółach podgląd i wymagania pozostają dostępne podczas konfiguracji lub ponownego łączenia. Gdy aplikacja przy starcie nie może otworzyć powłoki, używa istniejącego ekranu odzyskiwania. Gdy inny worker w wybranym projekcie jest gotowy, można przełączyć się na niego bez zmiany konfiguracji.

| Stan | Tekst UI | Akcja lub przejście |
| --- | --- | --- |
| Trwa pierwszy odczyt lub ponowne łączenie | Checking setup… | Czeka na istniejący odczyt stanu. |
| Gateway nie odpowiada | Canopy could not connect to the gateway. Check the connection, then retry. | **Retry** korzysta z mechanizmu odzyskiwania połączenia aplikacji. |
| Threads wyłączone | Threads is off. Turn it on to try this example. | **Open settings** prowadzi do **Settings → General → Modules**. Zmiana należy do użytkownika. |
| Brak zarejestrowanego workera na serwerze | A worker runs agents on a computer you choose. | **Add worker** otwiera istniejący kreator. |
| Lokalny worker desktopu jeszcze się uruchamia | Waiting for the local worker… | Aplikacja czeka na sygnał gotowości. Jeśli worker jest zgłoszony jako niedostępny, pokazuje stan offline. |
| Wybrany worker jest offline, inny jest online | “{worker}” is offline. Choose another worker. | **Choose worker** otwiera picker dla tego przykładu. |
| Wybrany worker jest offline, brak alternatywy | “{worker}” is offline. Start it to try this example. | **Open worker settings** pokazuje stan tego workera. |
| Brak wybranego projektu dla przykładu, są dostępne projekty | Choose a project to try this example. | **Choose project** otwiera istniejący picker. |
| Przykład wymaga projektu, brak dostępnego projektu | Add the directory you want the agent to read. | **Add project** otwiera istniejący kreator. Po zapisie zaznacza dodany projekt i ponownie sprawdza stan. |
| Wybrany projekt jest bez workspace’u | Add a workspace to give the agent a directory to read. | **Add workspace** otwiera istniejący kreator dla tego projektu. |
| Worker jawnie raportuje brak agent CLI i brak gotowej alternatywy | Install an agent CLI on “{worker}” to use it here. | **Open worker settings** prowadzi do **Agent CLIs** tego workera. Używa dostępnego w nim **Install** lub istniejącej instrukcji ręcznej. |
| Potwierdzony brak logowania natywnego i brak gotowej alternatywy | Sign in to {provider} on “{worker}” to use it here. | **Open provider settings** prowadzi do właściwej instancji i workera. Tam pozostaje **Sign in**. |
| Potwierdzone wygaśnięcie lub odrzucenie logowania natywnego i brak gotowej alternatywy | The {provider} sign-in on “{worker}” expired or was rejected. | **Open provider settings** prowadzi do istniejącego **Sign in again**. |
| Brak dostępnego agenta lub modelu bez potwierdzonej przyczyny | “{worker}” has no available model. Check its provider settings. | **Open provider settings** prowadzi do wybranego workera. Obsługuje także klucze API i własne endpointy. |
| Dostępny model, stan konta nieznany lub nieobsługiwany | | **Open thread draft**. Ewentualny błąd dostępu pokazuje istniejący widok tury. |
| Worker lub workspace zniknął w trakcie | This workspace is no longer available. Choose where to run this task. | **Choose worker** lub **Choose project**, zależnie od tego, który wybór stracił ważność. Aplikacja zachowuje edytowany tekst. |

Na desktopie lokalnym pierwszym wyborem jest worker uruchamiany przez aplikację, jeśli pasuje do przykładu. Desktop w trybie **Remote** i przeglądarka korzystają z workerów widocznych dla podłączonego gatewaya. Aplikacja odświeża stan po zmianie istniejącego odczytu lub po powrocie z Settings. Stan CLI i konta pochodzi z raportu właściwego workera i instancji. Gdy status konta jest nieznany, aplikacja kieruje się dostępnością modelu w zwykłym pickerze. [Dodawanie workera](worker-config.md#dodanie-maszyny-z-ui) · [Agent CLI](provider-cli.md) · [Logowanie](provider-accounts.md#logowanie-i-wylogowanie-z-aplikacji)

## 4. Przykłady i wiadomości

Przykład testowy jest dostępny w **Set up Canopy**. Dwa przykłady projektowe należą do planu biblioteki.

### Turn a bug report into a test plan

**Opis** · `Get a test checklist from a sample bug report.`

**Wymagania** · `An online worker and an available agent.`

Aplikacja wybiera **No project** i umieszcza kompletną wiadomość w szkicu. Rezultat pojawia się w zwykłym wątku.

**Wiadomość**

> Write a test plan for the bug report below. List 3 test cases and 2 questions to ask before fixing it.
>
> On a phone, rotating the screen clears the text in the search field. It happens before and after search results appear. The query should stay in the field.

**Sample result**

> 1. Rotate the phone while typing. The search field should keep the query.
> 2. Rotate after results load. The query and results should stay visible.
> 3. Rotate back. The query should still be in the field.
>
> Which phones are affected? Does it happen in both directions?

Po udostępnieniu biblioteki ukończony przykład pokaże **Explore Canopy** pod odpowiedzią.

### Understand a codebase

**Opis** · `Find the entry points and learn where to make your first change.`

**Wymagania** · `A project on an online worker with an available agent.`

Agent odczytuje wskazany workspace w trybie **Read only**. Wystarczy lokalny katalog dodany do projektu.

**Wiadomość**

> Read the README and the relevant source files in this project. Explain what the project does, where it starts and where its tests live. Cite file paths. Suggest one file to read next.

**Sample result**

> `src/main.ts` starts the app. `src/routes/` defines its HTTP routes. Start with `src/routes/search.ts` and its tests in `test/search.test.ts`.

### Schedule a weekly project summary

**Opis** · `Check a project summary once, then choose when to get it again.`

**Wymagania** · `A project with status notes or a changelog, on an online worker with an available agent.`

Użytkownik może wskazać konkretne pliki w szkicu. Polecenie opiera się na odczycie plików w trybie **Read only**.

**Wiadomość**

> Read the current project status notes or changelog. Summarize changes from the last 7 days, open blockers and likely next steps. Cite the files you used. Say which dates or details are missing.

**Sample result**

> Search now keeps the query when the screen rotates. Mobile tests still need results from Android. Next, verify rotation with results open. See `CHANGELOG.md` and `docs/status.md`.

Po ukończonej turze z odpowiedzią aplikacja pokazuje **Schedule a task** w tym wątku. Akcja otwiera istniejący formularz z wybranym bieżącym wątkiem i treścią faktycznie wysłanej wiadomości. Proponuje **Repeat**, **Every week**, poniedziałek o 09:00 w strefie użytkownika i cztery wykonania. Formularz pokazuje strefę oraz najbliższy termin. Pola można edytować. Kliknięcie **Schedule** zapisuje harmonogram. Po zapisie akcja **View scheduled task** prowadzi do zapisanego zadania w **Scheduled tasks**. [Harmonogramy](agent-bus.md#5-harmonogram)

## 5. Powrót do zadania i ukończenie wprowadzenia

- Aplikacja zapisuje pominięcie i wybór workera w preferencjach klienta dla bieżącego gatewaya. Powrót z ustawień lub przeładowanie odtwarza stronę konfiguracji z bieżącym stanem workera. Treść przykładu przechowuje zwykły szkic wybranego workspace’u. Przy zajętym szkicu użytkownik wybiera, czy go otworzyć, czy zastąpić przykładem.
- Potwierdzenie utworzenia wątku po wysłaniu wiadomości zapisuje ukończenie wprowadzenia dla tego klienta i gatewaya. Po pominięciu wprowadzenia czy po pierwszym wysłaniu **Set up Canopy** nadal otwiera się z palety poleceń. Podczas błędu tury można korzystać ze zwykłego ponowienia w wątku.
- W planowanej bibliotece odnośnik **Resume example** przywróci wybrany przykład. Akcja po wyniku pojawi się po ukończeniu właściwej tury i odczycie odpowiedzi.
- Widoki korzystają z komponentów i skali Canopy. Klawiatura pozwala przejść od listy do szczegółów, do ustawień i z powrotem do tej samej akcji. W wąskim webie wymagania, akcja i wynik układają się w jednej kolumnie. Statusy ładowania mają zarezerwowane miejsce i są dostępne dla czytnika ekranu. [Skala UI](ui-scale.md) · [Przegląd UI](ui-review.md) · [Reguły tekstów](copy.md)

## 6. Prywatność i dostęp agentów

Informacja pojawia się przy decyzji, której dotyczy. Odnośnik **Learn about privacy** na stronie konfiguracji i przy pierwszej wiadomości prowadzi do stałej strony **Privacy and agent access**, dostępnej również po pominięciu wprowadzenia. W planowanej bibliotece **Explore Canopy** prowadzi tam ten sam odnośnik.

| Moment | Tekst UI | Zachowanie |
| --- | --- | --- |
| Podgląd przykładu | This result uses fictional data. | Widoczny pod **Sample result**. Odczyt podglądu wyświetla przygotowaną treść bez uruchamiania agenta. |
| Wybór workera | The agent runs on the computer you choose. | Obok wyboru miejsca wykonania. Nazwa workera pozostaje widoczna w kompozytorze. |
| Pierwsze wysłanie zadania | The agent can send messages, file contents and tool results to the configured model service. | Wskazówka obok kompozytora przed pierwszym wysłaniem, także w zwykłym **New thread** po pominięciu wprowadzenia. Korzysta z istniejących pickerów, które pokazują agenta, workera i tryb uprawnień. |
| Konfiguracja proxy lub własnego endpointu | Your endpoint receives the agent’s model requests. Check how it handles task data. | Informacja w ścieżce konfiguracji odsyła do **Open provider settings**. Przy proxy pokazuje nazwę instancji i zdanie `A proxy can forward your task data to another service.` Pokazuje nazwę usługi docelowej, jeśli wynika z konfiguracji. |
| Wybór uprawnień | Use the least access your task needs. You can review requests in the thread. | Obok istniejącego pickera, który pokazuje opisy trybów i otwiera potwierdzenie przy wyborze **Full access**. |

Wskazówka przed wysłaniem pojawia się do pierwszego potwierdzonego wysłania w zakresie klienta i gatewaya. Ma miejsce w układzie kompozytora i działa jako tekst z linkiem. Nie wymaga dodatkowego potwierdzenia. Po zmianie instancji lub workera kompozytor od razu pokazuje aktualny wybór. Odczyt strony o prywatności nie wysyła wiadomości ani nie zmienia uprawnień.

### Tekst strony Privacy and agent access

| Nagłówek | Tekst UI |
| --- | --- |
| Who provides the agent | `Anthropic, OpenAI and xAI build and maintain the agents. Canopy starts the agent software on the worker you choose. Canopy manages thread history, approvals and access to its tools.` |
| Where task data goes | `Your gateway stores thread history and attachments. The agent can send task data to the configured model service. Check that service’s data policy for your account.` |
| What the agent can do | `The model proposes actions. The agent software carries them out using the access it has. Available actions depend on the permission mode, operating system and granted tools. Review changes and approval requests in the thread.` |
| Read only and data sharing | `Read only limits what the agent can change. The model service can still receive content the agent reads.` |
| How to share a secret | `Use the private secret card when an agent asks for a secret. For provider keys, use Settings → Providers or Settings → Proxies.` |

W rozwijanych szczegółach **How the agents connect** pokazujemy `Canopy uses the Claude Agent SDK to run Claude Code. It connects to Codex app-server and Grok CLI over standard input and output (stdio). Grok uses the Agent Client Protocol (ACP).`

Canopy przekazuje tryb uprawnień do oprogramowania agenta oraz egzekwuje dostęp do własnych narzędzi i konektorów. Polityka przechowywania danych przez usługę modelu zależy od użytego konta i trasy, w tym operatora proxy lub własnego endpointu. Pliki sesji samego agenta mogą też pozostać na workerze. [Architektura](architecture.md) · [Claude](claude-adapter.md) · [Codex](codex-adapter.md) · [Grok](grok-adapter.md) · [Konektory](connectors.md) · [Uprawnienia narzędzi](automation-tools.md#grant-workera-i-uprawnienia-tury) · [Sekrety](secrets.md) · [Proxy](proxies.md)

## 7. Publiczny Quickstart

Plan kolejnego etapu.

Link **Open quickstart** prowadzi do sekcji **Quickstart** w publicznym README. Sekcja zaczyna się od zdania `Choose where you want your agents to work.` i prowadzi do istniejących instrukcji dla wybranego wydania. Każda ścieżka kieruje do **Set up Canopy**, a po przygotowaniu agenta do pierwszego zadania.

| Tytuł ścieżki | Opis po angielsku | Prowadzi do |
| --- | --- | --- |
| Use this computer | Run Canopy and its worker on this computer. | Instalator desktopu, wybór **Local**, agent CLI i dostęp do modelu na tym komputerze. |
| Set up a server | Run Canopy on a server and choose where your agents run. | Wdrożenie serwera, dostęp do webu, dodanie workera na maszynie z potrzebnymi plikami. Docker i SSH są wariantami instrukcji. |
| Connect desktop | Open an existing Canopy server in the desktop app. | Wybór **Remote**, zaproszenie z **Network access** i użycie workerów serwera. |

W instrukcjach dostępu do modelu pokazujemy użycie wykrytego logowania CLI i konfigurację własnego endpointu jako warianty. Instrukcja dla brakującego CLI prowadzi do instalacji na workerze. [Instalacja](../README.md#installation) · [Wdrożenie](deploy.md) · [Dostęp sieciowy](network-access.md) · [Profile dostawców](worker-config.md#8-profile-dostawców)

Ścieżka **Use this computer** wyjaśnia `Local mode runs the worker on this computer. The agent uses your configured model service.` Przed udostępnieniem webu ścieżka **Set up a server** pokazuje `Canopy web has no built-in sign-in. Anyone with access can act as the owner. Use a private network with access controls or a proxy with authentication.` Ścieżka **Connect desktop** kieruje do parowania z zaufanym gatewayem i do instrukcji cofnięcia dostępu urządzenia. [Ochrona webu](deploy.md#dostęp-do-web-reverse-proxy-i-tailscale) · [Parowanie desktopu](desktop-remote-frontend.md#parowanie-i-bezpieczeństwo)

## 8. Kryteria odbioru

1. Na świeżym desktopie **Local** użytkownik dochodzi do pierwszej odpowiedzi zarówno z wykrytym logowaniem, jak i po instalacji CLI lub logowaniu. Po powrocie z ustawień zostaje w tym samym przykładzie.
2. Na świeżym serwerze bez workera **Add worker** prowadzi do istniejącego kreatora. Po połączeniu i skonfigurowaniu modelu ten sam przykład jest gotowy do użycia. Sparowany desktop **Remote** dla tego serwera korzysta z widocznego workera bez drugiej rejestracji.
3. Przy wolnym starcie, workerze offline i nieznanym stanie konta aplikacja pokazuje właściwe stany. Przechodzi do gotowości po zdarzeniu, które potwierdza odpowiedni stan. Po błędzie tury można wrócić do zadania z zachowaną wiadomością.
4. Aktualizacja istniejącej instalacji otwiera zwykły kompozytor także na pustej bazie i w nowym profilu przeglądarki. Taki sam efekt mają pominięcie wprowadzenia, działający projekt, wcześniejsza historia lub obecny szkic. **Set up Canopy** można otworzyć z palety poleceń. Zmiana gatewaya lub wyłączenie Threads aktualizują dostępne akcje.
5. Przykład pokazuje podpisany wynik na fikcyjnych danych i daje użytkownikowi możliwość edycji szkicu przed wysłaniem. W kolejnym etapie przykład cykliczny otworzy harmonogram po pierwszej odpowiedzi.
6. Widoki przechodzą przegląd w przeglądarce i w desktopie z wąskim oknem. Próba obejmuje długie nazwy projektu i workera, nawigację klawiaturą, utratę połączenia oraz powrót z ustawień. Teksty UI przechodzą [audyt językowy](copy.md#8-copy-audit-after-a-feature-checklist).
7. Przed pierwszym wysłaniem użytkownik może wskazać, na którym komputerze działa agent, gdzie może trafić treść zadania i jakie uprawnienia ma wątek. Próba obejmuje logowanie natywne, własny endpoint lub proxy oraz ścieżkę po pominięciu wprowadzenia. **Privacy and agent access** jest dostępne także później.
8. W kolejnym etapie **Hide from sidebar** ukryje skrót w obu wariantach nawigacji także po przeładowaniu. Paleta zachowa dostęp do biblioteki. **Show in sidebar** i przełącznik w Settings przywrócą skrót także przy włączonym wyłącznie module Bots.
9. **Set up Canopy** prowadzi przez wykryte logowanie, brak CLI oraz wariant z proxy. Po powrocie z ustawień wskazuje ten sam worker. Import można przejrzeć przed skonfigurowaniem modelu. Po imporcie kreator pokazuje utworzone projekty.
10. **Find Git repositories** pokazuje repozytoria bezpośrednio w wybranym katalogu na właściwym workerze. Dodanie następuje po zatwierdzeniu wyboru. Już użyte ścieżki są widoczne jako **Already added**. Pusty wynik pozwala wybrać inny katalog lub dodać zwykły projekt.

W pilotażu obserwujemy, czy nowa osoba bez podpowiedzi prowadzącego uzyskuje pierwszą odpowiedź, a następnie samodzielnie znajduje inne zastosowanie w **Explore Canopy**. Pytamy, czy plik przeczytany w trybie **Read only** może trafić do usługi modelu i kto udostępnia używanego agenta. Notujemy czas do pierwszej odpowiedzi i krok, przy którym potrzebna była pomoc.
