# Boty

Status (2026-11-28): właściciel może przydzielić botowi dostęp do konkretnego repozytorium GitHub. Odczyt i opcjonalny zapis korzystają z konta GitHub w domu bota oraz z jego polityki zatwierdzeń. [Dostęp do repozytorium](github.md#dostęp-projektu-i-bota-do-repozytorium)

Status (2026-11-28): bot może uczyć się procedur w prywatnej rozmowie, poprawiać je po uwagach właściciela i stosować w kolejnych zadaniach. Opis działania znajduje się w sekcji [Umiejętności bota](#umiejętności-bota). Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-28): boty mają wyzwalacze zdarzeń wątków, CI PR-ów, harmonogramów,
limitów dostawców i sugestii nawyków. Bot subskrybuje typ zdarzenia
z jawnym zakresem i warunkami, a pasujące zdarzenia uruchamiają przebieg w tle.
Szczegóły w sekcji [Wyzwalacze zdarzeń](#wyzwalacze-zdarzeń). Dostępność w kanałach
określa [promocja wydań](release.md).

Status (2026-11-28): pytania i zgody w przebiegach w tle (rutyny, wyzwalacze,
pobudki) są parkowane. Przebieg nie blokuje kolejki bota, a decyzja właściciela
uruchamia kontynuację. Szczegóły w sekcji
[Parkowane pytania i zgody rutyn](#parkowane-pytania-i-zgody-rutyn). Dostępność
w kanałach określa [promocja wydań](release.md).

Status (2026-11-27): boty odbierają pliki z wiadomości Telegrama i Discorda tak jak ze
Slacka. Szczegóły w sekcji [Pliki od uczestników](#pliki-od-uczestników). Dostępność
w kanałach określa [promocja wydań](release.md).

Status (2026-11-27): w rozmowie Slack, Telegram lub Discord z dostarczaniem odpowiedzi
`send_attachment` dołącza plik do odpowiedzi tury. Szczegóły w sekcji
[Pliki w odpowiedziach](#pliki-w-odpowiedziach). Dostępność w kanałach określa
[promocja wydań](release.md).

Status (2026-11-27): boty odbierają i wysyłają wiadomości także przez Telegram
(Bot API, long polling) i Discord (gateway WebSocket z wznawianiem sesji).
W web/desktop i na telefonie zakładka **Settings → Connectors → Messaging** zarządza
kontami Slack Bot, Telegram Bot i Discord Bot. Szczegóły w sekcji
[Telegram i Discord](#telegram-i-discord). Dostępność w kanałach określa
[promocja wydań](release.md).

Status (2026-11-26): subskrypcja Slack domyślnie dołącza do tury bota wspólny
kontekst kanału i jego wątków. Dostępność w kanałach określa
[promocja wydań](release.md).

Status (2026-11-26): właściciel może poprosić bota w prywatnym czacie o propozycję
motywu. W web i desktopie akcja **Review theme** otwiera podgląd w kreatorze.
Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-26): bot obsługujący Slack może zakończyć turę bez wysyłania
odpowiedzi ani powiadomienia. Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-25): cytaty w wysłanych wiadomościach w web i desktopie dopasowują
kolor do dymku w jasnym i ciemnym trybie.
Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-25): wiadomość zapisana w prywatnym czacie po zmianie modelu
czeka na nową turę po przekazaniu kontekstu. Dostępność w kanałach określa
[promocja wydań](release.md).

Status (2026-11-25): szczegóły zmian ustawień bota w web/desktop pokazują instrukcje
jako jednokolumnowy diff z zawijaniem tekstu oraz nagłówkiem przypiętym podczas przewijania.
Dostępność w kanałach określa
[promocja wydań](release.md).

Status (2026-11-25): w sidebarze web/desktop widoczna akcja „Create bot” znajduje się
po prawej stronie wyszukiwarki, w tym samym miejscu co „New thread”. W najwęższym
panelu akcja zachowuje etykietę i pomija ikonę plusa, żeby wyszukiwarka miała więcej miejsca.
Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-24): w prywatnym czacie właściciel i bot mogą reagować na wiadomości drugiej strony.
Dodanie lub cofnięcie reakcji właściciela trafia do kontekstu bota.
Web i desktop rezerwują miejsce na przycisk reakcji już w historii z pamięci podręcznej.
Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-24): w prywatnym czacie właściciel może zapytać bota o treść
i wynik obsługi wiadomości z jego aktywnych subskrypcji Slack. Dostępność
w kanałach określa [promocja wydań](release.md).

Status (2026-11-24): przy pierwszym zwykłym wejściu do Bots po ponownym
uruchomieniu web/desktop otwiera ostatnio wyświetloną rozmowę z botem, jeśli
aktualna lista potwierdza jego dostępność. Profil klienta zapamiętuje
identyfikator rozmowy osobno dla każdego gatewaya. Przy braku dostępnego bota
pozostaje ekran Bots z opcją tworzenia, a linki do konkretnych rozmów i akcja
Create bot zachowują swój cel. Przywrócenie rozmowy nie uruchamia tury.
Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-24): kilka subskrypcji wyniku tej samej lokalnej tury kolejkuje
jeden raport dla danego bota i tego samego zakresu rozmowy lub rutyny.
Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-24): natywne boty Codexa używają aktualnego loginu wybranej instancji
w nietrwałym magazynie procesu tury. [Logowanie harnessów](bots-harness.md#logowanie-harnessów).

Status (2026-11-24): prywatna tura właściciela i zaplanowane wystąpienie jego rutyny
mogą wysłać wiadomość do lokalnego wątku o innym zakresie po jednorazowej zgodzie.
Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-24): kolejna pobudka zaplanowana przez prywatną pobudkę tego samego
bota zachowuje dostęp do delegacji z wcześniejszych pobudek w tym łańcuchu.
Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-24): [mobilny formularz Create bot](mobile.md) pokazuje nazwę,
model i instrukcje przed rozwijanymi opcjami oraz umieszcza przycisk utworzenia
pod przewijaną treścią. Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-23): `send_message` bez załączników rozpoznaje kwalifikowany identyfikator
wątku na domowym gatewayu bota i sprawdza dostęp dla bieżącej rozmowy.
Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-22): `read_thread` i `list_schedules` obsługują opcjonalny odczyt stron.
`message_delegating_bot` działa również w późniejszych turach wątku założonego przez bota.
Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-22): gateway udostępnia botom trwałe notatki na wszystkich ich workerach. Zakres narzędzi i
kontekstu zależy od nadawcy oraz odbiorcy tury. W web/desktop gradient kompozytora mieści się
w odstępie pod ostatnim wpisem i przechodzi pod paskiem przewijania.
Dostępność w kanałach określa [promocja wydań](release.md).

Status (2026-11-22): narzędzia bota dla Appearance obsługują dawne wartości domyślne.
Bieżący wygląd zapisuje klient.

Status (2026-11-21): gateway pomija rozumowanie Groka w podglądzie odpowiedzi
na żywo i w zapisywanej wiadomości bota.
Dostępność wydań według [release.md](release.md).

Status (2026-11-19): wyłączenie modułu Bots zatrzymuje pracę botów właściciela,
w tym tury na workerach, rutyny i dostarczanie przypomnień.
W web/desktop akcja Delete bot jest dostępna także dla aktywnych botów.
Usunięcie kończy pracę i odłącza źródła bota w tej samej transakcji co soft delete.
Prywatny czat pokazuje odbiór wiadomości ze Slacka, przebieg rutyn i bieżącą czynność bota.
Na webie, desktopie i telefonie kolejne zdarzenia w historii można rozwijać i zwijać.
Panel Bots w web/desktop oznacza pracujące boty na przypiętych kafelkach i zwykłych wierszach.
Aktualizacja rozmowy zachowuje w panelu stan pracy i oczekującej zgody z podsumowania bota.
Mobilna rozmowa potwierdza odczyt najnowszych wiadomości i odświeża listę botów.
Wysyłana wiadomość ma przygaszony dymek, który zachowuje wysokość po potwierdzeniu.
Aktualizacja (2026-11-24): w web/desktop **Settings → Connectors → Messaging** zarządza kontami
wiadomości przy włączonym module Bots. Konta Slack User są w zakładce **Tool accounts**.
Zaimplementowano trwałe rozmowy botów przez Slack Socket Mode,
buforowanie, załączniki, formatowanie odpowiedzi, izolację historii kanałów i przyznane narzędzia
w turach zewnętrznych. Konektor Slack umożliwia pobranie pliku po jego identyfikatorze.
Bot Codex może odczytać obraz z wiadomości lub konektora, jeśli jego model obsługuje obrazy.
W prywatnej rozmowie z właścicielem i w swoich rutynach bot może wysyłać jako Canopy na Slacku ze
stałą zgodą dla konkretnego konta i rozmowy Slack.
Wątek uruchomiony przez bota może przekazać mu pytanie w trakcie pracy przez
`message_delegating_bot`. Automatyczny zwrot wyniku sprawdza pochodzenie wejść obserwowanej tury.
Konfiguracja bota przenosi `service_tier` do `RunBotTurn`.
Historia w web/desktop korzysta z wirtualizacji i automatycznie dołącza
starsze strony podczas przewijania, zachowując pozycję czytania.
Kolejne wiadomości tekstowe w prywatnym czacie mogą dołączyć do trwającej tury bota.
Limit automatycznej wymiany wynosi 256 kroków; walidacja budżetu przed zgodą
i diagnostyka wyników narzędzi są zaimplementowane. Bot zlecający pracę lokalnej
turze dostaje powiadomienia o oczekujących pytaniach i zakończeniu tury.
Długie tytuły są skracane w tych powiadomieniach, aby zmieściły się w limicie wejścia bota.
`download_file` wysyła identyfikator klienta `Canopy-Bot` w nagłówku `User-Agent`.
Boty i rutyny mogą sprawdzić w opublikowanych changelogach Canopy wersję według numeru PR-a.
Usage w web/desktop pokazuje łączne zużycie botów oraz tokeny i koszty poszczególnych
botów, łącznie z turami ze Slacka i rutynami. Szczegóły: [usage.md](usage.md).
Dostępność nightly/beta/stable według [release.md](release.md).

## Wyłączenie i wznowienie modułu Bots

Po wyłączeniu Bots gateway przerywa rozpoczęte tury, w tym pracę w rozmowach
zewnętrznych, rutyny i przygotowanie handoffu. Wygasza oczekujące zgody i pytania,
zachowuje historię prywatnej rozmowy oraz otrzymany fragment odpowiedzi. Zapisuje
przerwanie dla workera w trwałej kolejce. Worker offline dostaje je po połączeniu.
Spóźnione wyniki przerwanej tury nie uruchamiają dalszych działań.

Wiadomości przyjęte przed wyłączeniem, których bot jeszcze nie zaczął przetwarzać,
czekają w kolejce także po restarcie gatewaya. Po ponownym włączeniu bot przetwarza
je w dotychczasowej kolejności. Rozpoczęte tury pozostają przerwane. Rutyny cykliczne
wracają od najbliższego przyszłego terminu według ich strefy czasowej. Gateway pomija
zaległe wystąpienia i pozostawia ręcznie wstrzymane rutyny w pauzie. Jednorazowe
przypomnienie, którego termin minął w czasie wyłączenia, trafia do kolejki jeden raz,
o ile nadal jest aktywne. Anulowane przypomnienia pozostają anulowane.

## Połączenie z wątkami

Bot korzysta z projektów, workspace’ów, wątków, ich ustawień, zgód i harmonogramów,
gdy właściciel ma włączone oba moduły. Gateway filtruje katalog przekazywany do modelu
i sprawdza aktualne ustawienia przy wywołaniu, również w rozpoczętej turze i po
wznowieniu. Bot zachowuje własne wiadomości, rutyny, przypomnienia i przyznane konektory.
Gdy włączony jest wyłącznie moduł Bots, `list_schedules` i `cancel_schedule` obsługują własne przypomnienia bota.

`send_message` w prywatnej turze właściciela lub w zaplanowanym wystąpieniu jego
rutyny kieruje zwykłe wysyłki do wątków według polityki zgód bota. Do niezarchiwizowanego
lokalnego wątku o odrębnym zakresie, np. delegowanego ze Slacka lub oznaczonego
przez migrację starszych delegacji, może wysłać wiadomość po zgodzie właściciela
na konkretny wątek, treść i załączniki. Karta jest wymagana także w Full auto
i przy stałej regule dla `send_message`. Odbiorcy z dostępem do historii wątku
mogą zobaczyć wysłaną treść. Rozmowy zewnętrzne i automatyczne kontynuacje nadal
korzystają z zakresu swojej delegacji.

W wątku uruchomionym przez bota agent może wywołać `message_delegating_bot({text})`,
gdy potrzebuje przekazać pytanie, ustalenie lub wynik. Gateway ustala odbiorcę
na podstawie zapisanej relacji z botem, który założył wątek. Jeśli bieżąca tura
ma jednoznaczne źródło delegowania od tego bota, wiadomość trafia do źródłowej
rozmowy lub rutyny. Przy zgłoszeniu ze Slacka odpowiedź do uczestników przekazuje bot
zgodnie z ustawieniami Messages. Wiadomość z późniejszej tury bez własnego źródła
delegowania trafia do prywatnego czatu bota.

Zwykły wpis agenta w trakcie pracy pozostaje w historii wątku. Bot obserwujący
turę dostaje jej wynik automatycznie. Przy pracy poza obserwowaną turą agent
używa narzędzia także wtedy, gdy bot ma dostać wynik. Jeśli agent wysłał już pytanie
narzędziem, w odpowiedzi końcowej podaje tylko nowe ustalenia. Jawna wiadomość
nie zmienia istniejącej obserwacji końca tury.

Przy automatycznych powiadomieniach o pytaniu i wyniku gateway sprawdza początkowe
wejście, wiadomości dołączane do tury oraz wszystkich obserwatorów, również z poprzedniej
partii dostarczeń. Jeżeli prywatny czat, rutyna albo inna rozmowa współdzieli turę
z rozmową Slack, żaden z jej obserwatorów nie otrzymuje automatycznego raportu ani
powiadomienia o pytaniu. Pochodzenie z połączonego komputera również stanowi osobne źródło.
Wynik pozostaje w historii wątku. Gdy wszystkie wejścia pochodzą z jednej rozmowy Slack,
jej bot dostaje raport zgodnie z aktualną trasą.

#### Wynik pracy kontynuowanej przez Claude

Status (2026-11-21): obserwacja lokalnej tury obejmuje powiązane wyniki natywnych
pobudek Claude po zadaniach w tle. Dostępność wydań według [release.md](release.md).

Obserwacja z `start_thread` lub `send_message` zostaje przy tym samym wywołaniu
i tym samym czacie, rutynie lub rozmowie Slack. Po udanej turze z rozpoznanym
zadaniem w tle gateway czeka na wynik natywnej pobudki Claude. Identyfikator
uruchomienia zadania w wyniku Claude musi pasować do zakończonego zadania,
które powstało podczas obserwowanej pracy. Jeżeli pobudka zaczyna kolejne takie
zadanie, obserwacja nadal trwa. Po rozstrzygnięciu zadań bot otrzymuje jeden
raport z ostatniej potwierdzonej tury. Wcześniejsze odpowiedzi zostają w wątku.
Stan oczekiwania, termin i zapis raportu przeżywają restart gatewaya.

Tura bez rozpoznanego zadania w tle oraz przerwana lub nieudana tura początkowa
kończą obserwację zwykłą ścieżką. Zadanie zakończone w trakcie tury może zostać
rozliczone w jej wyniku. Dla późniejszego zakończenia gateway czeka na zdarzenia
workera, również przy odtwarzaniu journala po rozłączeniu. Oczekiwanie trwa
najwyżej godzinę od zakończenia tury początkowej. Jeżeli zadanie zatrzymano, zabrakło potwierdzenia
pochodzenia albo inna tura przerwała ciąg pracy, raport wskazuje ostatni
potwierdzony wynik jako częściowy. Tura ze sterowaniem, odpowiedzią na pytanie
lub formularz albo zadaniem z innej pracy może zawierać cudzy kontekst, więc
gateway nie dołącza jej wyniku. Zmiana nie rozszerza obserwacji także wtedy, gdy
tura początkowa łączy różne źródła lub otrzymała odpowiedź na interakcję
zawierającą treść.

Zakres obejmuje lokalne pobudki `provider` z identyfikatorem uruchomienia
zadania najwyższego poziomu. Wznowienia z ponownie użytym identyfikatorem
zakończonego zadania wymagają osobnej obsługi cyklu życia zadania.
Harmonogramy, `agent_bus`, platformowe notatki `background_task` i pobudki bez
tego identyfikatora nie przedłużają obserwacji. Dotychczasowe notatki o zadaniach
pozostają dostępne w wątku. Pytania tury początkowej nadal docierają dotychczasową
trasą. Gdy Claude potwierdza pochodzenie pobudki dopiero w jej wyniku, odpowiedź
na interakcję w trakcie pobudki pozostaje w Canopy. Rozszerzenie tego zakresu
wymaga odrębnej decyzji i wiarygodnego pochodzenia wejścia w trakcie tury.

Przy wyłączeniu modułu gateway wygasza oczekujące zgody na działania bota w wątkach
i zamyka oczekujące obserwacje wyników i pytań, także między komputerami. Przy wyłączeniu samych botów
wątki zachowują historię, kontynuują rozpoczętą pracę i obsługują własne prośby o zgodę.
Bot traci dostęp do tych kart, a jego reguły zgód przestają automatycznie zatwierdzać
konektory w uruchomionych przez niego wątkach. Po ponownym włączeniu obu modułów można
ponownie delegować pracę.

Na połączonych komputerach oba gatewaye sprawdzają dostęp dla wiadomości, pytań
i raportów między botem i wątkiem. Szczegóły w [opisie szyny agentów](agent-bus.md).

## Reakcje w prywatnym czacie

Właściciel może dodać do zapisanej wiadomości bota dowolne z sześciu emoji
(👍, ❤️, 😂, 🎉, 👀, 🙏). Ponowne wybranie emoji usuwa tę reakcję.
Reakcje widać pod wiadomością także po ponownym otwarciu rozmowy.
Bot może użyć narzędzia `react_to_message` wobec wiadomości właściciela,
np. potwierdzić ją kciukiem i zakończyć turę bez tekstu.

Gateway zapisuje zmianę reakcji właściciela i powiadomienie w jednej transakcji.
Powtórzenie żądania z tym samym stanem nie tworzy kolejnego powiadomienia.
Bot dostaje rodzaj zmiany, emoji, identyfikator i fragment swojej wiadomości.
Jeśli trwa prywatna tura obsługująca steer, gateway próbuje dostarczyć powiadomienie
w jej trakcie. W pozostałych przypadkach bot otrzymuje je w osobnej turze z kolejki.
Taka tura nie publikuje odpowiedzi w czacie. Zmiana reakcji przez bota aktualizuje
wiadomość właściciela bez uruchamiania kolejnej tury.

## Kolejne wiadomości w prywatnym czacie

W web/desktop i mobile podczas odpowiedzi można wysłać kolejną wiadomość
i niezależnie zatrzymać odpowiedź. `SendBotMessage` zapisuje wiadomość i klucz
idempotencji przed próbą dostarczenia. Zwykły tekst wysłany podczas aktywnej
tury rozpoczętej przez właściciela w tym czacie może dołączyć do niej przez
`SteerBotTurn`. Dopiero `bot_steer_applied` dołącza zapisaną wiadomość do historii
tej tury i usuwa ją z kolejki. Zachowuje identyfikator, treść i pozycję wiadomości
w widocznym czacie.

Bez aktywnej tury właściciela, po odrzuceniu przez worker lub w przypadku
załączników, cytatów i wzmianek wiadomość czeka na następną turę. Czeka również,
jeśli zapis zmiany modelu uruchomił [przekazanie kontekstu](#zmiana-modelu--ukryte-przekazanie-kontekstu),
które wciąż jest w kolejce lub w toku. Dotyczy to także Groka i starszych workerów
bez `bot_steer_v1`. Niepotwierdzone dostarczenie
zostawia wiadomość w kolejce z informacją dla modelu, by nie powtarzał ukończonych
działań. Gateway nigdy nie ponawia nietrwałej komendy po utracie łącza lub restarcie.
Prywatna wiadomość nie trafia do aktywnej tury Slacka, rutyny, handoffu ani
wymiany między botami.

## Rozmowy przez komunikatory

Konta komunikatorów mają dostawcę `slack`, `telegram` albo `discord`. Adapter dostawcy
(`apps/gateway/src/messengers/provider.ts`) sprawdza konto, odbiera wiadomości
i wysyła jedną odpowiedź bez ponawiania zapisu. Trasy, rozmowy, bufor, outbox
i zgody są wspólne. Identyfikatory kanałów i użytkowników są natywne dla dostawcy;
rozmowa zapisuje, czy jest wiadomością prywatną (`direct`).

Konta Slack Bot w Settings → Connectors obsługują wiadomości przez Socket Mode. Jedna
instalacja w workspace ma wiele tras do botów. Można użyć niezależnej aplikacji
z tokenem bota lub aplikacji Slack User z osobną zgodą OAuth bota. Gateway
odnawia rotowane tokeny współdzielonej aplikacji. App-level token, bot token i refresh token są
szyfrowane; listy, protobuf, worker i model ich nie otrzymują. Gateway weryfikuje
zgodność aplikacji i workspace przed odbiorem. Konsument konta utrzymuje odnawiany
lease w PostgreSQL; nowy token lease odcina poprzedni proces także po restarcie.
Wyłączenie lub usunięcie powiązanego connectora albo zmiana client ID blokują
źródło także dla aktywnej tury i outboxa. Szczegóły konfiguracji i odnawiania:
[connectors.md](connectors.md#slack-jako-komunikator-bota).

Właściciel wybiera dla każdej pary bot–konto listę kanałów, obowiązkową listę
użytkowników, wiadomości prywatne, wzmianki i obserwowanie oraz sposób dostarczenia
wyniku: odpowiedź w Slack albo celową notkę w prywatnej rozmowie bota. Pusta lista
użytkowników nie otwiera dostępu wszystkim. Trasa nie odpowiada na autorów spoza
listy, również we wcześniej otwartej rozmowie. Jeden kanał lub DM ma najwyżej jedną
trasę odpowiadającą; niezależne trasy obserwujące mogą wysyłać właścicielowi notki.
Dodatkowe instrukcje trasy uzupełniają personę bota. Usunięcie trasy/konta odcina
odbiór i wysyłkę, zachowując wcześniejszą historię w jej zewnętrznym zakresie.
Usunięcie kanału blokuje również odpowiedź już działającej tury i odbiór z outboxa;
wiadomości oczekujące od odebranego autora nie wracają po ponownym dodaniu go do listy.

Odpowiedź na wzmiankę w głównym kanale trafia do wątku tej wiadomości. Kolejne
fragmenty tego samego autora bez wzmianki w głównym kanale dołączają do otwartego
kontekstu; jawne odpowiedzi w tym wątku trafiają do tej samej rozmowy. Nowa wzmianka
w kanale tworzy odrębny wątek. Obserwacja głównego kanału ma własną rozmowę,
odrębną od jego wątków. Otwarcie kontekstu trwa 5 minut od ostatniej przyjętej
wiadomości oraz przez czas aktywnej tury. DM ma osobny kontekst danego kanału DM.

Wiadomości, autorzy, identyfikatory i kolejność odbioru są trwałe. Gateway usuwa
duplikaty zarówno po identyfikatorze zdarzenia, jak i po wiadomości w rozmowie
(`message` i `app_mention` mogą opisywać tę samą wiadomość). Zegar odbioru gatewaya,
a nie czas klienta Slack, steruje buforem: rozmowa czeka 3 s ciszy, najwyżej 10 s;
obserwator 10 s ciszy, najwyżej 30 s. Obserwacja rozpoczyna nowe tury nie częściej
niż co 60 s; ten limit nie opóźnia uzupełniania już aktywnej tury tej samej rozmowy.
Partia zawiera najwyżej 40 fragmentów i 32 kB wejścia. Długie wiadomości dzielą się
na oznaczone części; pełna treść pozostaje w bazie, a dalsze części trafiają do
kolejnych partii. Edycje aktualizują wyłącznie nieprzetworzone wiadomości z zachowaniem
kolejności; usunięcia wycofują nieprzetworzone części. Nie powtarzają wykonanych działań.

Kolejka serializuje pracę całego bota. Gotowa partia uruchamia turę z trwałym UUID
rozmowy albo trafia przez pojedynczy, nietrwały `steer_bot_turn` do działającej tury
**tej samej rozmowy**. Tylko zapisane w journalu `bot_steer_applied` potwierdza
zużycie wejścia; odrzucone wejście czeka na kolejną turę. Nieznany wynik po restarcie
nie powoduje ponowienia komendy steer. Po zakończeniu tury niepotwierdzone teksty
wracają jako kolejna partia z informacją o niepewnym dostarczeniu i zakazem
powtarzania już ukończonych działań.

Po przekazaniu partii do kolejki bota lub potwierdzonym dołączeniu do działającej
tury prywatny czat pokazuje wpis o odbiorze. Podaje liczbę wiadomości, konto Slack
i dostępne identyfikatory kanału lub DM i wątku. Potwierdzenie wysyłki przez Slack
zapisuje w czacie informację o odpowiedzi. Jeśli sama tura zakończy się błędem,
wpis wskazuje rozmowę, której dotyczył. W czasie pracy wiersz pod rozmową pokazuje
pisanie, używanie narzędzia lub oczekiwanie na decyzję.

Na pytanie właściciela o ostatnią wiadomość lub błąd w Messages bot może użyć
`read_messenger_history`. Bez identyfikatora tury dostaje metadane maksymalnie
10 najnowszych tur własnych aktywnych subskrypcji, z opcjonalnym filtrem kanału
lub wątku Slack. Widzi osobno stan tury, stan wysyłki odpowiedzi przez outbox
oraz zapisany kod i źródło błędu. Po wybraniu tury może przeczytać fragmenty
ostatnich ośmiu wpisów w kolejności rozmowy (do 4096 znaków na wpis), w tym
wiadomości przyjęte w trakcie pracy oraz odpowiedź lub komunikat błędu.
Wynik oznacza skrócone wpisy i pominięte starsze wpisy. Gateway sprawdza
pochodzenie prywatnej wiadomości właściciela i aktualny dostęp do rozmowy.
Odczyt działa także dla historii zapisanej przed dodaniem narzędzia.

Standardowa historia modelu zewnętrznego obejmuje dany UUID rozmowy. Prywatna rozmowa,
handoff, lista botów, licznik nieprzeczytanych i podgląd generowania nie pobierają
automatycznie surowej treści kanałów. Zewnętrzna tura korzysta ze zwykłych grantów connectorów
oraz narzędzi pracy, w tym delegowania przez `start_thread`, a Web access i Files
respektują konfigurację bota. Pliki pozostają w workspace danego UUID rozmowy.
Subskrypcja wybiera źródło i trwałe instrukcje zachowania właściciela; nie tworzy
mapowania kanał–narzędzia ani dodatkowych uprawnień. Prompt podaje konto, kanał
i wątek, odróżnia zaufane instrukcje subskrypcji od niezaufanych wiadomości autorów
i zakazuje automatycznego importowania prywatnej historii oraz handoffów.
Gateway nadal egzekwuje politykę zgód i reguły Allowed actions; odwołanie grantu
lub wyłączenie źródła blokuje nowe wywołania również w aktywnej turze.
Tury zewnętrzne nie mogą zmieniać konfiguracji właściciela/bota, rutyn,
subskrypcji ani grantów; narzędzia tych operacji nie trafiają do ich katalogu,
a gateway odrzuca wywołania spoza niego. Nowe narzędzia platformy domyślnie
pozostają prywatne. Świadome zgody i pytania `ask_user` pojawiają się wyłącznie
w prywatnej rozmowie właściciela, z opisem konta/kanału/wątku zadania zewnętrznego,
bez surowej historii kanału. Odpowiedź właściciela wraca do tej tury; pytania,
karty, odpowiedzi i szczegóły grantów nie są automatycznie wysyłane do Slacka.
O wyjaśnienia od autora wiadomości bot pyta zwykłą odpowiedzią w kanale.
Bot publikuje odpowiedzi, aktualizacje i wyniki delegowania przez skonfigurowaną
trasę Messages. Slack dostaje sformatowany tekst z Markdowna i obsługuje jawne
wzmianki o osobach w składni `<@USER_ID>`. Przy uruchomieniu wątku roboczego i przy
kolejnych wiadomościach do niego Canopy dołącza instrukcję zwrócenia pytań i wyników do bota.
Instrukcja zabrania wysyłania i szkicowania odpowiedzi do rozmowy źródłowej
przez konektor Slack. Dotychczasowe granty konektora obowiązują nadal.
Trasa „Notify me” prosi o zwięzłe podsumowanie, gdy coś wymaga uwagi właściciela. Jej wynik tworzy
osobną, ukończoną prywatną turę z notką; pełny wynik może pojawić się
w prywatnej historii i handoff.
To świadome dostarczenie wyniku, bez importowania całego kanału.

W obu trybach bot ocenia według instrukcji właściciela, czy trzeba coś wysłać.
Może wykonać potrzebne działania i zakończyć turę bez wiadomości. Wywołanie
`skip_slack_reply` trwale zapisuje decyzję dla tej tury. Tekst wygenerowany przez
model w tej turze pomija się przy zapisie odpowiedzi i dostarczeniu. Pusty wynik
również nie trafia do wysyłki. Historia pokazuje ukończoną turę bez stanu dostarczenia.

Zakończenie tury z odpowiedzią na Slack zapisuje ją do outboxa w tej samej
transakcji co wynik tury.
Żadne wywołanie Slack nie działa wewnątrz transakcji. Osobny nadawca oznacza wpis
jako wysyłany przed siecią; potwierdzony błąd przejściowy może odroczyć wysyłkę.
Nieznany wynik zapisu lub przerwany proces nie powoduje automatycznego wysłania
kolejnej kopii. Właściciel otrzymuje jedną prywatną notkę o niepotwierdzonym
dostarczeniu albo o jawnej odmowie dostawcy; pełna odpowiedź pozostaje w outboxie.
Przeniesienie bota nie przenosi kont, tras ani surowych zewnętrznych
rozmów; cel otrzymuje prywatną historię wraz z jawnymi notkami, a kanały wymagają
ponownego połączenia w domu docelowym.

Testy `tests/integration/bot-channels.test.ts` sprawdzają szyfrowanie i zakres
właściciela, fencing, restart bufora, autorów/kolejność, terminy, wzmiankę główną
i jej wątek, izolację historii, fallback steer, notki obserwatora oraz nieznany
wynik wysyłki. Adapter i przepływ przez gateway mają osobne testy integracyjne;
atrapy nie dowodzą poprawności uprawnień konkretnej instalacji Slack.

### Telegram i Discord

Konto Telegram Bot zapisuje token z BotFather, a konto Discord Bot token bota
z Discord Developer Portal. Tokeny są szyfrowane w gatewayu jak tokeny Slacka i nie
trafiają do list, workera ani modelu. Zapis konta sprawdza token u dostawcy:
Telegram odrzuca bota z ustawionym webhookiem, Discord wymaga włączonego
Message Content Intent. Gateway pokazuje wtedy stały komunikat z kolejnym krokiem.

Telegram działa przez `getUpdates`, więc gateway nie potrzebuje publicznego adresu.
Gateway przesuwa `offset` dopiero po zapisaniu aktualizacji, a duplikaty odrzuca po
`update_id`. Trasa wybiera grupy po ujemnym ID czatu i autorów po ID użytkownika;
prywatne czaty wybiera opcja wiadomości prywatnych. Wzmianka `@nazwa_bota`, komenda
z nazwą bota i odpowiedź na wiadomość bota liczą się jako wzmianka. Do obserwacji grupy
bez wzmianek trzeba wyłączyć Group Privacy w BotFather. Telegram nie zgłasza botom
usunięć wiadomości.

Discord działa przez gateway WebSocket z intencjami Guilds, Guild Messages, Direct
Messages i Message Content. Gateway potwierdza sekwencję zdarzenia dopiero po jego
zapisaniu. Po rozłączeniu wznawia sesję, a Discord powtarza niezapisane zdarzenia.
Wiadomość w wątku Discorda trafia do trasy kanału nadrzędnego; wątek tworzy osobną
rozmowę. Trasa wybiera kanały i autorów po snowflake ID.

Bez natywnych wątków odpowiedź na wzmiankę jest odpowiedzią na wiadomość, która ją
wywołała (`reply_parameters` w Telegramie, `message_reference` w Discordzie).
Outbox zapisuje identyfikator wysłanej odpowiedzi. Odpowiedź uczestnika na
wiadomość bota albo na wiadomość z rozmowy wraca do tej samej rozmowy, także bez
wzmianki. Odpowiedź Telegrama jest formatowana jako HTML Telegrama, a odrzucone
formatowanie jest wysyłane jako zwykły tekst. Długie odpowiedzi dzielą się na części
w limicie dostawcy; błąd po pierwszej części oznacza dostarczenie jako niepewne.
Discord dostaje nonce dla każdej części i wzmianki ograniczone do użytkowników.

#### Pliki w odpowiedziach

W turze rozmowy zewnętrznej z dostarczaniem `reply` narzędzie `send_attachment`
zapisuje plik ze scratch rozmowy jako załącznik i dodaje go do kolejki odpowiedzi
tej tury (`messenger_outbound_files`). Plik nie trafia do prywatnego czatu właściciela.
Kolejka powstaje w transakcji akcji narzędzia, więc wycofana akcja nie zostawia pliku.
Odpowiedź zawiera najwyżej 10 plików i 50 MB. Plik większy niż limit dostawcy jest
odrzucany przy wywołaniu narzędzia (Slack i Telegram 50 MB, Discord 10 MB).
Trasa `notify` odrzuca pliki, bo nie wysyła nic do rozmowy. Pominięcie odpowiedzi
przez `skip_slack_reply` pomija także jej pliki. Tura bez tekstu, ale z plikami,
wysyła same pliki.

Gateway czyta bajty plików przed zajęciem wiersza outboxa, poza blokadami. Brak pliku
oznacza odpowiedź niewysłaną i powiadomienie właściciela. Wysyłka zachowuje zasady
outboxa: zapis nie jest ponawiany, a błąd po pierwszym widocznym zapisie oznacza
dostarczenie niepewne.

- Slack: gateway najpierw rezerwuje i przesyła pliki (`files.getUploadURLExternal`),
  co niczego nie publikuje. Potem wysyła tekst i udostępnia pliki w tym samym wątku
  (`files.completeUploadExternal`). Aplikacja bez zakresu `files:write` odrzuca
  całą odpowiedź przed publikacją tekstu.
- Telegram: pliki idą po tekście jako odpowiedzi na tę samą wiadomość. JPEG, PNG
  i WebP do 10 MB przez `sendPhoto`, pozostałe przez `sendDocument`.
- Discord: pliki dołączają do ostatniej części tekstu w multipart `files[n]`.
  Wiadomość ma najwyżej 10 plików i 10 MB; nadmiar trafia do kolejnych wiadomości
  bez tekstu.

#### Pliki od uczestników

Pliki z wiadomości Telegrama i Discorda trafiają do tury tym samym potokiem co pliki
ze Slacka. Wiadomość z samym plikiem, bez tekstu, też jest przyjmowana. Referencje
plików są zapisywane przy wiadomości (kolumna `slack_file_ids` obejmuje wszystkich
dostawców) tylko wtedy, gdy mają kształt właściwy dla dostawcy konta. Przed pobraniem
gateway sprawdza je ponownie, a także aktywną trasę, autora z listy, lease tury
i ustawienie Files bota. Obowiązują limity załączników właściciela. Pliku, którego
nie da się pobrać, model nie dostaje, a wejście tury zawiera informację o niedostępnych
załącznikach.

- Telegram: zdjęcie w największym rozmiarze, dokumenty, wideo, audio, animacje
  i wiadomości głosowe. Gateway pobiera je przez `getFile` i serwer plików Bot API,
  który udostępnia botom pliki do 20 MB. Nazwa dokumentu pochodzi z wiadomości.
- Discord: załączniki wiadomości pobierane z podpisanego adresu CDN Discorda
  (`cdn.discordapp.com`, `media.discordapp.net`) bez tokenu bota. Gateway nie pobiera
  plików z innych hostów.

Wspólny kontekst kanału oraz narzędzia
`list_messenger_channels`, `list_messenger_channel_members` i `list_messenger_users`
działają tylko dla Slacka. Pobieranie plików przez konektor Slack dotyczy
tylko Slacka. Właściciel podaje ID czatów i użytkowników Telegrama i Discorda
w trasie. Narzędzie pomijania odpowiedzi zachowuje nazwę
`skip_slack_reply` dla wszystkich dostawców.

### Wspólny kontekst kanału Slack

Kontekst kanału jest domyślnie włączony. Dotyczy nowych subskrypcji i kanałów
wcześniej zapisanych w Canopy. Każdy kanał subskrypcji ma własny kontekst.
Ustawienia wzmianek, obserwacji, DM i celu odpowiedzi zachowują zapisane wartości.
Pominięcie `channel_context` podczas edycji zachowuje jego zapisaną wartość.
Aby wyłączyć kontekst, poproś o to bota w prywatnym czacie. Po zwykłej
autoryzacji właściciela bot zapisze `channel_context=false` przez
`save_messenger_subscription`.

Na ruchliwym kanale można ustawić `mentions=true` i `observe=false`. Bot
wtedy odpowiada na wzmianki i kontynuacje otwartych rozmów, a pozostałe
dopuszczone wypowiedzi zbiera jako tło. Przy `observe=true` bot może nadal
uruchamiać zwykłe tury dla kolejnych dopuszczonych partii.

Aktualizacja zachowuje bufor wiadomości. Nowy kontekst zaczyna się od
wiadomości przyjętych po aktualizacji. Gateway może dokończyć zakolejkowaną
turę, potwierdzoną turę na workerze lub odpowiedź oczekującą na wysłanie,
jeśli wciąż można zweryfikować ich wejście. Gotowe odpowiedzi z poprzedniej
wersji są dostarczane do dotychczasowej rozmowy Slack poza wspólnym
kontekstem kanału.

Od momentu włączenia gateway zbiera dopuszczone wiadomości kanału głównego
i jego wątków. Zapisuje faktyczny identyfikator roota Slack i łączy callbacki
`message` oraz `app_mention` dotyczące jednej wiadomości. Własną odpowiedź
dopisuje po potwierdzeniu jej identyfikatora i kanału przez Slack. Wiadomości
prywatne, inne kanały, załączniki, treści narzędzi, prywatne działania
właściciela, notki `notify` i odpowiedzi o nieznanym wyniku wysyłki pozostają
poza osią kanału.

Do kolejnej tury Canopy dołącza do 6 KiB tła w postaci niezaufanych danych:
świeże wiadomości z uwzględnieniem bieżącego roota i oczekujących zmian oraz do
trzech wcześniejszych tematów ze źródłami. Gdy kilka spraw pasuje do pytania,
bot może dopytać w docelowej rozmowie. Tura używa aktualnej osi i bieżącego
wejścia. Gdy opcja jest włączona, kontynuacje trafiają do kolejnej zwykłej
tury, która odświeży tło przed wysłaniem do workera.

Analiza tematów działa w tle przez izolowaną generację bez narzędzi na
dostępnym workerze i w profilu modelu bota. Preferuje mniejszy model z tego
profilu. Kanał ma trwały kursor i jedną partię na minutę, a właściciel
jedną analizę naraz. Partia obejmuje do 40 zmian i około 8 KiB wejścia, ze
skróceniami oznaczonymi w tekście. Gateway sprawdza identyfikatory źródeł
i zapisuje tematy razem z postępem partii. Bez aktualnego wyniku analizy
tura korzysta od razu ze świeżych wiadomości. Niedostępność workera lub
nieudany wynik odraczają próbę o dwie minuty.

Edycja lub usunięcie przechwyconej wiadomości unieważnia zależne tematy
i usuwa z kontekstu odpowiedzi oparte na zmienionym źródle. Gateway planuje
ponowną analizę zachowanych źródeł. Zmiana zakresu dostępu usuwa
kontekst odwołanych źródeł. Gateway sprawdza aktualność także przed wysyłką
komendy do workera i odpowiedzi do Slacka. Canopy zaczyna osobną sesję
modelu w każdej turze z włączonym kontekstem, zachowując UUID rozmowy,
jej workspace i cel odpowiedzi. Przy włączonym kontekście oś zastępuje
notatki Conversation. Polecenie wyłączenia
opcji zapisuje `channel_context=false`, czyści oś i tematy, zachowuje kolejkę
dopuszczonych wiadomości oraz przywraca zwykłe aktualizacje aktywnej tury.
Historia i notatki Conversation zaczynają się od nowego zakresu. Kolejne
tury tej rozmowy mogą wznowić sesję z tego zakresu.
Już opublikowane wiadomości pozostają w Slacku.

### Konfiguracja nasłuchiwania przez prywatną rozmowę

Właściciel najpierw podłącza konto Slack Bot w Settings → Connectors.
Bot settings → Messengers wybiera to konto i konfiguruje trasy. Instalacja
wymaga `channels:read` i `groups:read` do wyszukiwania kanałów; po dodaniu tych
scopes należy ponownie zainstalować aplikację i zaprosić ją do kanałów. Tokenów
nie przekazuje się botowi. Bot odczytuje publiczne metadane kont przez
`list_messenger_accounts`, a nazwy i identyfikatory kanałów przez
`list_messenger_channels`. Odkrywanie korzysta z tokenu wyłącznie w gatewayu,
pokazuje niearchiwalne kanały, do których aplikacja należy, i nie dołącza jej do
nowych kanałów. Opcjonalna nazwa filtruje stronę; `next_cursor` trzeba kontynuować
aż do pustego kursora, także gdy bieżąca strona nie zawiera dopasowania.

`list_messenger_channel_members` odczytuje identyfikatory członków kanału, a
`list_messenger_users` wyszukuje nazwy, nazwy użytkowników i nazwy wyświetlane
bez przekazywania adresów e-mail ani pozostałych danych profilu. Obie listy są
stronicowane. Bot może w ten sposób dopasować wskazane osoby do identyfikatorów
Slack; przy kilku dopasowaniach albo niejasnej liście dozwolonych autorów pyta
właściciela. Odczyt członkostwa nie nadaje wszystkim członkom prawa do uruchamiania
bota i nie rozszerza zapisanej listy autorów.

W prywatnej rozmowie można polecić botowi np. obserwowanie kanału produktu,
zapisywanie ustaleń przyznanymi narzędziami oraz wyjaśnianie problemów z autorami.
`save_messenger_subscription` utrwala pełną konfigurację: konto, kanały, obowiązkową
listę dozwolonych autorów, wzmianki/obserwację/DM, opcjonalny `channel_context`,
dostarczenie `reply` lub `notify` i instrukcje reakcji. Wybór działań wynika z instrukcji i zwykłych uprawnień bota;
trasa nie wiąże kanału z konkretnymi narzędziami. Pasujące wiadomości trafiają do
opisanego wyżej bufora; model przetwarza gotowe partie z zachowaniem limitu
częstotliwości nowych tur. Przetwarzanie partii zużywa tokeny również wtedy,
gdy model uzna, że nie ma powodu do reakcji.

`list_messenger_subscriptions` pokazuje wyłącznie własne trasy bota. Zapis bez
identyfikatora aktualizuje jego trasę dla wybranego konta albo tworzy nową;
przed zmianą należy odczytać istniejącą konfigurację i zachować pozostałe kanały
oraz instrukcje. `stop_messenger_subscription` usuwa własną trasę i odcina jej
odbiór oraz oczekujące odpowiedzi. Zapis/usunięcie i wynik wywołania zatwierdzają się
w jednej transakcji, więc ponowienie tego samego wywołania po restarcie nie
powtarza mutacji ani nie nadpisuje późniejszych zmian.

Wszystkie narzędzia administracji komunikatorami wymagają prywatnej wiadomości
właściciela. Gateway sprawdza zapisane pochodzenie tury i autora, także przy
bezpośrednim wywołaniu: kanał, inny bot, wymiana automatyczna, rutyna i handoff
nie mogą zmieniać nasłuchiwania ani odkrywać kont. Autoryzacja nie opiera się na
treści promptu. Testy `tests/integration/bot-messenger-setup.test.ts` obejmują
odkrywanie bez poświadczeń w wyniku, paginację, trwałe instrukcje, idempotencję,
zakres własnego bota oraz odrzucenie nieuprawnionego pochodzenia.

## Trwałe notatki bota

Prywatna wiadomość właściciela oraz zaplanowane uruchomienie jego rutyny mają odczyt i zapis w zakresie
**Bot**. Rutyna zapisuje tylko zweryfikowane fakty potrzebne w kolejnych uruchomieniach. Wynik konektora
lub zleconej pracy nie jest źródłem nowych preferencji właściciela. Automatyczna kontynuacja przypisana do
takiej rutyny ma odczyt. Zmiana nazwy lub instrukcji bota oraz tytułu lub instrukcji rutyny wymaga
prywatnej wiadomości właściciela. Wymiana z innym botem, także odpowiedź wracająca do rutyny, dostaje tylko
własne wejście, bez prywatnej pamięci, historii i handoffu. Pobudka lub powiadomienie bez rozpoznanego
zakresu również działa w osobnej sesji.

Wiadomość ze Slacka może wyszukiwać i zapisywać notatki w zakresie **Conversation** dla konkretnego bota i
UUID rozmowy. Wyniki zadań wracające do tej rozmowy mogą odczytać jej notatki. Gateway ponownie sprawdza
aktywną trasę i lease przed wykonaniem narzędzia. Ani treść wiadomości, ani argument narzędzia nie mogą
wybrać innego bota lub rozmowy.

`memory_search` przyjmuje do trzech krótkich zapytań. `memory_save` tworzy notatkę lub aktualizuje wskazane
ID z oczekiwaną rewizją. Narzędzia działają również przy wyłączonym Files lub module Threads. Przypięte i
trafne notatki trafiają do wejścia modelu na początku nowej tury. Po edycji lub usunięciu następne pobranie
uwzględnia zmianę; wcześniejsze wypowiedzi i zapisane handoffy zachowują swoją treść.

## Bezczynna kolejka

Pętla gatewaya najpierw sprawdza jednym odczytem pracę właściciela. Gdy nie ma
gotowej tury, oczekującego zakończenia wątku ani należnego przypomnienia/rutyny,
nie otwiera transakcji dostarczenia i claim. Właściciel bez skonfigurowanych botów
ma odczyt co najwyżej raz na 5 s. Dostarczenia agentów przez link zachowują rytm
250 ms także bez lokalnych botów. Gdy właściciel ma bota, tani odczyt gotowości
również działa co 250 ms, bez dodawania czasu zapytania do okresu: inny proces
może zapisać turę lub zmienić termin rutyny bez lokalnej pobudki. Wysłanie wiadomości, retry, odpowiedź na kartę
i zmiana konfiguracji budzą kolejkę od razu; pobudka podczas odczytu jest ponawiana.
Ostateczną kwalifikację, blokady i idempotencję nadal sprawdzają trwałe transakcje.

## Dostęp do sieci i izolowane pliki

Ustawienia bota w web/desktop i mobile udostępniają przełączniki **Web access**
i **Files** w sekcji Permissions. Zapis zachowuje obie wartości; otwarcie ustawień
starszego bota pokazuje domyślne włączenie. Załączniki wysyłane przez bota korzystają
z tych samych komponentów wiadomości co załączniki użytkownika: metadane, pobranie
i podgląd obsługiwanych typów. Inferencja nadal działa wyłącznie
przez oficjalne harnessy workerów: Claude Agent SDK, Codex app-server i Grok ACP.
Gateway nie wywołuje API modelu. Zmiany nie rozszerzają dostępu do projektów,
poświadczeń, skilli, pluginów ani plików użytkownika workera.

### Ustawienia i narzędzia sieciowe

Każdy bot ma niezależne ustawienia **Web access** i **Files**, domyślnie włączone
także dla dotychczasowych botów. Brak pola konfiguracji oznacza wartość domyślną;
jawne wyłączenie musi przetrwać zapis, restart i przeniesienie. Ustawienia zmienia
właściciel przez web/desktop lub mobile, nie model przez `update_self`.
Zmiany mobile dotyczą wyłącznie JavaScript/TypeScript, bez zmiany fingerprintów
natywnych. UI używa wspólnych kontrolek i istniejących komponentów załączników.

Worker jawnie konfiguruje narzędzia dla każdej nowej i wznawianej sesji:
Claude otrzymuje `WebSearch` i `WebFetch`, Codex natywne web search, Grok wyłącznie
narzędzia wyszukiwania/pobierania rzeczywiście dostępne w przypiętym CLI.
Transport MCP `search_tool` Groka sam w sobie nie oznacza dostępu do internetu.
Wyłączenie Web access usuwa natywne narzędzia sieciowe i odczyt changelogów Canopy. Nie odbiera osobnych
grantów connectorów; ich dostęp i zgody nadal egzekwuje gateway.
Handoff nie otrzymuje żadnych narzędzi, niezależnie od ustawień bota.
Zmiana uprawnień unieważnia ukrytą sesję przed następną turą; aktywna tura
zachowuje snapshot ustawień, a wykonawcy platformy ponownie sprawdzają bieżące
uprawnienia przed skutkiem ubocznym. Starszy worker nie może otrzymać komendy,
której ograniczeń nie umie egzekwować; gateway wymaga capability i prosi o aktualizację.

### Workspace rozmowy

Każda rozmowa otrzymuje prywatny katalog scratch pod data dir workera.
Klucz obejmuje właściciela, bota i trwałą tożsamość rozmowy; identyfikator tury
ani dostawcy nie tworzy nowej rozmowy. Ścieżkę wylicza worker, nigdy model,
gateway ani ścieżka projektu. Dane logowania i pliki sesji harnessu pozostają
poza udostępnionym katalogiem. Zmiana Runs on nie przenosi scratch.

Files udostępnia odczyt, tworzenie i edycję wyłącznie w tym katalogu. Nie
udostępnia dowolnego shella. Codex może użyć `workspace-write` z wyłączoną siecią
powłoki dopiero po zapewnieniu także ograniczenia odczytu: sam `workspace-write`
ogranicza zapis, ale nie dowodzi braku odczytu hosta. Claude wymaga jawnej
walidacji ścieżek Read/Write/Edit, odmowy Bash i pozostałych narzędzi lokalnych.
Grok wymaga równoważnej, sprawdzonej granicy ACP. Jeśli harness nie potrafi
zapewnić pełnej izolacji, jego narzędzia lokalne pozostają wyłączone; pliki
obsługują ograniczone narzędzia platformy na workerze. Nie wolno zastępować
izolacji instrukcją w promptcie ani samym ustawieniem cwd.

Budżet rozmowy wynosi 200 MiB łącznie, z limitem liczby plików i współbieżnych
operacji. Rezerwacja miejsca poprzedza zapis, dotyczy także downloadów i zapisów
harnessu; przekroczenie nie może chwilowo zapełnić dysku. Retencja usuwa scratch
po 7 dniach bezczynności, również po usunięciu rozmowy/bota; nie usuwa katalogu
aktywnej tury. Usunięcie bota od razu odbiera dostęp w gatewayu, ale fizyczny scratch
podlega tej samej retencji. Restart uruchamia sprzątanie pozostałości i porzuconych plików
tymczasowych. Archiwum pozostaje zwykłym plikiem, nigdy nie jest rozpakowywane
ani wykonywane. Wyłączenie Files blokuje narzędzia, nie usuwa dostarczonych
wcześniej załączników z gatewaya.

### Ustalanie wersji wydania według PR-a

`get_canopy_release_versions` przyjmuje do 50 numerów PR z `itsoltech/canopy`.
Gateway korzysta z publicznego, współdzielonego indeksu changelogów
([release.md](release.md)). Zwraca dla każdego PR-a najwcześniejsze zindeksowane
wydanie z wyraźnym odnośnikiem do niego, osobno dla Nightly, Beta i Stable,
wraz z datą publikacji, URL-em wydania i informacją o skróconej historii kanałów.
Brak dopasowania oznacza brak potwierdzenia w indeksie. Prywatne rozmowy
i rutyny z włączonym Web access dostają narzędzie tylko do odczytu, bez grantu
GitHub i bez poświadczeń.

### Pobieranie i wysyłanie plików

`download_file(url, filename?)` wykonuje worker w scratch rozmowy. Files musi
być włączone; pobieranie jest jawną operacją sieciową tego narzędzia, niezależną
od natywnego Web access. Dozwolone są wyłącznie HTTP/HTTPS, bez userinfo,
ciasteczek i nagłówków uwierzytelniających. Worker wysyła stały `User-Agent: Canopy-Bot`,
którego wymagają niektóre publiczne API, w tym GitHub. Limit to 50 MiB na plik,
najwyżej 5 przekierowań i 60 s całej operacji, z osobnym limitem bezczynności połączenia.
Content-Length jest sprawdzany przed odczytem, a strumień ma niezależny licznik
bajtów również bez tego nagłówka. MIME jest zachowywany jako metadane;
gateway ponownie rozpoznaje typ z bajtów i stosuje zwykłe limity załączników
właściciela, które mogą być niższe niż limit downloadu. Pobranie nie oznacza wysłania.

Każdy adres i każde przekierowanie przechodzi kontrolę SSRF po rozwiązaniu DNS.
Odrzucamy odpowiedź zawierającą jakikolwiek adres prywatny, loopback, link-local,
multicast, zarezerwowany lub metadata, także IPv6 i IPv4 mapowane w IPv6.
Połączenie musi użyć sprawdzonego adresu IP bez ponownego rozwiązania DNS;
HTTPS zachowuje oryginalny hostname dla SNI i walidacji certyfikatu. Brak takiej
możliwości oznacza odmowę, nie fallback do zwykłego fetch. URL-i i treści
błędów transportu nie zapisujemy w audycie ani nie ujawniamy jako diagnostyki hosta.

`send_attachment(path, caption?)` przyjmuje wyłącznie zwykły plik należący do
scratch bieżącej rozmowy. Worker odrzuca traversal, ścieżki absolutne spoza
katalogu, dowiązania i pliki specjalne; kontrola oraz otwarcie muszą być odporne
na podmianę ścieżki między sprawdzeniem a odczytem. Gateway autoryzuje
właściciela, bota, workera, aktywną turę, lease i aktualne Files przed uploadem
oraz zatwierdzeniem wiadomości. Używa istniejącego storage blobów i załączników,
bez ścieżki workera w publicznym API. Zapis wiadomości, powiązanie załącznika,
audyt i wynik narzędzia są atomowe i deduplikowane po call id; reconnect nie
wysyła drugiej kopii. Zwykła polityka zgód pozostaje egzekwowana w gatewayu.

Załącznik pojawia się jako wiadomość bota w web, desktop i mobile: nazwa,
rozmiar, ikona typu, pobranie i obsługiwany podgląd. W rozmowie Slack, Telegram
lub Discord plik dołącza do odpowiedzi tury przez adapter komunikatora
([Pliki w odpowiedziach](#pliki-w-odpowiedziach)). Sam grant konta MCP nie tworzy
kanału dostarczania.
Brak obsługi plików daje jawną informację; plik nadal jest dostępny w rozmowie
Canopy. Sekrety kanałów i connectorów pozostają w gatewayu, nigdy w scratch,
argumentach modelu ani logach workera.

### Model zagrożeń i weryfikacja

| Zagrożenie | Granica i wymagany dowód |
|---|---|
| SSRF i DNS rebinding | Walidacja wszystkich adresów DNS i redirectów, przypięcie IP; lokalne fixture HTTP oraz atrapy DNS obejmują redirect do sieci prywatnej i zmianę odpowiedzi DNS. |
| Traversal i symlink escape | Walidacja każdego komponentu, bezpieczne otwarcie pliku, odmowa plików specjalnych; próby `..`, ścieżek absolutnych, dowiązań i podmiany ścieżki dla każdego harnessu. |
| Wyczerpanie dysku | Rezerwacja 200 MiB, limity pojedynczego strumienia, liczby plików i czasu; testy równoległego zapisu, przekroczenia rozmiaru, przerwania i retencji po restarcie. |
| Eksfiltracja między rozmowami | Tożsamość rozmowy wyliczana poza modelem, odmowa odczytu innego scratch i hosta, kontrola owner scoping w gatewayu; obcy bot, właściciel, worker, zakończona tura i odwołany grant nie uzyskują dostępu. |
| Niezaufana treść internetu | Dane WWW i pobrane pliki nie udzielają zgód, nie zmieniają konfiguracji i nie są wykonywane; prompt opisuje dostępne narzędzia, limity i granice. |

Wdrożenie jest jednym stosem pięciu PR-ów: dokumentacja, Web access, scratch,
download/send, UI. Wszystkie pozostają draft do ukończenia i weryfikacji całości;
stos trafia do dev jednocześnie. Testy adapterów obejmują włączenie/wyłączenie
narzędzi każdego providera oraz brak narzędzi w handoff. Integracja używa
prawdziwego gateway↔worker z atrapami CLI, lokalnymi fixture i bez wywołań
zewnętrznych API. Obejmuje limity, cleanup, owner scoping, restart/deduplikację
i odczyt wysłanego załącznika przez wspólne API web/mobile. Zmienione widoki UI
sprawdzamy ręcznie zgodnie z [polityką repozytorium](../AGENTS.md#testing-policy).
Kontrakty proto są wyłącznie addytywne; migracja jest potrzebna tylko
przy zmianie schematu, z następnym wolnym numerem na dev w chwili otwarcia PR.

## Historia na urządzeniu i odczyt przyrostowy

Web przechowuje rozmowy i wymiany w pamięci bieżącej sesji SPA: łącznie 16 widoków,
32 MiB, najwyżej 8 MiB na wpis, LRU. Jest to osobny budżet od wątków; brak
IndexedDB i innych trwałych kopii w przeglądarce. Zamknięcie powłoki lub `pagehide`
usuwa cache. Lista botów usuwa wpisy zarchiwizowanych, usuniętych i przeniesionych
botów. Zimny widok pokazuje szkielet; nagłówek bierze nazwę i awatar z listy.
Przy ponownym otwarciu snapshot jest widoczny przed odczytem sieciowym, z cichym
„Syncing…”. Composer i karty są nieaktywne do potwierdzenia bieżącej subskrypcji.
W prywatnym czacie dymki zachowują szerokość, gdy po potwierdzeniu subskrypcji
udostępniany jest przycisk reakcji.

Rozmowy i wymiany w web/desktop otwierają się na końcu pobranego okna.
Wspólny z wątkami `VirtualFeed` montuje wiersze w pobliżu widoku i mierzy ich
wysokość. W miarę przewijania do najstarszej załadowanej wiadomości aplikacja
automatycznie pobiera kolejną stronę do 50 wiadomości. Widoczny wiersz
pozostaje w tym samym miejscu po dołączeniu strony. Po błędzie odczytu dostępne
jest **Try again**. Po przełączeniu bota widok korzysta z historii i stanu
subskrypcji wybranej rozmowy. Po dołączeniu strony subskrypcja wznawia odczyt
z kursora sprzed pobrania, także gdy okno w pamięci przekroczy limit cache.
Wymiany odświeżają przyrost po otwarciu, powrocie do okna i co 5 s widocznego okna.

Wspólna projekcja `domain/bot-chat` scala wiadomości, pytania i zgody według
czasu utworzenia, również zgody przekazane z wątków uruchomionych przez bota.
Rozstrzygnięcie zgody nie zmienia jej miejsca. Niedokończone odpowiedzi na
pytania i edycje zgód są przechowywane w pamięci widoku przy przewijaniu.
Cytat pobiera brakujące strony i przewija do wiersza źródłowej wiadomości.

Mobile utrwala oba rodzaje widoków w prywatnym cache aplikacji: osobny od wątków
budżet 16 widoków / 32 MiB na dysku (8 MiB na wpis), 6 widoków / 16 MiB w pamięci.
Odczyt dysku poprzedza watch, aby wysłany kursor miał dokładną lokalną bazę. Unpair,
revocation i zmiany dostępności botów usuwają kopie. Karty z cache są tylko do odczytu
do potwierdzenia live; również granica wywołania odpowiedzi wymaga aktualnej pending
karty. Szczegóły trwałości i storage: [mobile.md](mobile.md).

Rozmowa i podgląd wymiany bot–bot obsługują opt-in `incremental` oraz kursor
widoku. Gateway używa osobnego dziennika kluczy tabel botów, według tego samego
modelu epoki, rewizji w kolejności commitów i wykrywania luk co lustra wątków.
`seq` porządkuje wiadomości; dziennik obejmuje również edycje, usunięcia i zmianę
prezentacji po zakończeniu tury. Stan kart, read/unread i konfiguracji jest
potwierdzany digestem i zastępowany w całości, gdy się zmieni. Szczegóły protokołu:
[ui-api.md](ui-api.md#przyrostowy-odczyt-historii-botów).

Kursor nie daje uprawnień. Dom sprawdza właściciela przed odczytem, a przy luce,
obcej epoce, innym widoku albo przeniesieniu bota wysyła pełny stan. Stare klienty
i gatewaye nadal używają pełnych odpowiedzi. Cache zawiera wyłącznie publiczną
projekcję rozmowy, bez ukrytych checkpointów modelu i danych połączeń connectorów.

Claude, Codex i Grok wykonują inferencję na przypiętym workerze przez oficjalne
CLI/SDK: Claude Agent SDK, Codex app-server i Grok CLI przez ACP. Każdy bot ma
izolowaną sesję, narzędzia Canopy i opcjonalne natywne narzędzia sieciowe. Gateway
zachowuje rozmowę, outbox, zgody i wykonawców narzędzi. Ustawienie **Runs on** wybiera
workera; offline wiadomości czekają. Native/device login i proxy są obsługiwane przez
harness. Gateway nie wywołuje API modelu. Pełna decyzja
i ograniczenia: [bots-harness.md](bots-harness.md).

Lista modeli bota odczytuje tylko katalogi własnych i wspólnych workerów oraz
profil wskazanego dostawcy i instancji. Przypięcie workera zachowuje ten sam filtr
właściciela. Prywatna instancja innego użytkownika nie może służyć do tworzenia
bota ani do odczytu modeli niestandardowych. Lista kont MCP pomija katalogi
narzędzi i pobiera uprawnienia grupowo, z zachowaniem nazw nagłówków i grantów.

Tworzenie z pickera workera połączonego komputera zapisuje bota w gatewayu tego workera.
Edycja, archiwizacja i usuwanie z pozostałych komputerów są trasowane do tego domu.
Niedostępny gateway odrzuca zdalną akcję od razu; nic nie czeka na ponowne połączenie.

Kod: `apps/gateway/src/bots`, `apps/worker/src/bots`; kontrakty: boty UI i WorkerLink.

## Szkice i załączniki w rozmowie

Szkic wiadomości bota jest zapisywany w bazie gatewaya (`bot_composer_drafts`),
osobno dla bota i właściciela. Obejmuje tekst, strukturalne wzmianki, cytaty
z komentarzami i identyfikatory wgranych plików. Web, desktop i mobile używają
tych samych RPC `GetBotDraft` / `SaveBotDraft`, z opóźnieniem zapisu 350 ms
i kontrolą rewizji. Zmiana Threads/Bots oraz nawigacja zachowują również trwające
uploady w pamięci sesji; po zakończeniu uploadu szkic zapisuje jego metadane w DB.
Nie używamy localStorage ani magazynu urządzenia. Niedokończony upload wymaga
ponownego dodania obrazu po zamknięciu aplikacji. Szkice wątków pozostają lokalne
w pamięci kompozytora; trwałość szkiców botów jest osobnym rozszerzeniem.

Wysyłanie zachowuje szkic do potwierdzenia gatewaya. Odrzucone żądanie i błąd
transportu nie kasują treści ani klucza idempotencji. Przyjęta wiadomość czyści
wyłącznie wysyłaną rewizję; nowszy szkic zapisany na drugim urządzeniu pozostaje.
Konflikt zapisu jest jawny i nie nadpisuje drugiego urządzenia.
Wyczyszczenie obejmuje tekst, wzmianki, cytaty i załączniki w tej samej transakcji
co przyjęcie wiadomości. Wspólny synchronizator web/desktop/mobile odrzuca odczyt
szkicu rozpoczęty przed potwierdzeniem wysłania, a następnie pobiera aktualny stan.
Opóźniona odpowiedź nie może przywrócić właśnie wysłanych plików.

Bot przyjmuje wszystkie typy obsługiwane przez wątki: obrazy, tekst, kod, PDF,
archiwa i inne pliki binarne. Programy wykonywalne są odrzucane. Web/desktop
przyjmują je przez wklejenie, upuszczenie i **Attach files**; mobile przez
istniejący intake zdjęć i plików. Upload używa tych samych blobów, miniaturek,
podglądów i limitów co wątki (domyślnie 20 MiB na plik, 50 MiB i 10 plików
na wiadomość; ustawienia właściciela mogą je zmienić). Typ rozpoznajemy z bajtów.
Wiadomość może składać się z samych plików. Bot nie ma dostępu do dysku hosta;
narzędzia Files obsługują wyłącznie prywatny scratch rozmowy.

| Typ | Claude Agent SDK | Codex app-server | Grok ACP |
|---|---|---|---|
| PNG, JPEG, GIF, WebP oraz obrazy po wspólnej konwersji | natywne bloki `image` | natywne wejście `image` | natywne części `image`; CLI musi ogłaszać obsługę obrazów |
| Markdown, tekst, kod, JSON, CSV, HTML/SVG jako tekst i pozostałe UTF-8 | tekst w wejściu tury | tekst w wejściu tury | tekst w wejściu tury |
| PDF | natywny blok `document` z bajtami PDF | tekst wydobyty przez parser PDF | tekst wydobyty przez parser PDF |
| Archiwa i inne pliki binarne | metadane i referencja do przekazania | metadane i referencja do przekazania | metadane i referencja do przekazania |

Tekst pliku jest oznaczony jako niezaufane dane: do 64 000 znaków na plik
i 128 000 łącznie na wejście. PDF w Codex/Grok: najwyżej 50 pierwszych stron,
bez OCR; błąd parsowania albo brak tekstu daje jawną notatkę i zachowuje
oryginał do przekazania. Przycięcie ma osobną notatkę. Każde wejście harnessu
dostaje wyłącznie bajty plików wysłanych z bieżącą wiadomością, także po odbudowie
sesji. Historia zachowuje referencje, nazwy, typy i rozmiary przy wcześniejszej
wiadomości, oznaczone jej identyfikatorem i czasem UTC; nie są to załączniki
nowego wejścia. Dawnych plików nie pobieramy ani nie wysyłamy ponownie do modelu.
Bot może znaleźć referencje przez `list_attachments` i przekazać je do wątku.
Do ponownego odczytu pliku można go załączyć, a plik Slack pobrać przez
przyznany konektor.
Wymagane capability workera:
`bot_images_v1` dla samych obrazów, `bot_files_v1` dla pozostałych plików;
starszy worker wymaga aktualizacji. `WORKER_LINK_PROTOCOL` pozostaje 1.

W trasach Slack Socket Mode gateway pobiera załączniki dopuszczonej wiadomości
przed uruchomieniem nowej tury. Wiadomości z plikami czekają na nową turę
zamiast dołączać do trwającej odpowiedzi samym tekstem. Pliki podlegają
ustawieniu **Files**, limitom Canopy i dostępowi aplikacji Slack. Niedostępny
plik daje notatkę w wejściu. Bot nadal otrzymuje treść wiadomości. Obrazy i
obsługiwane dokumenty używają tej samej ścieżki co pliki z prywatnej rozmowy.

Alternatywnie bot może pobrać plik po id narzędziem przyznanego konektora
Slack. Referencje pozostają w zakresie rozmowy, w której bot otrzymał lub
pobrał plik. Szczegóły autoryzacji opisuje [connectors.md](connectors.md#pobieranie-plików-ze-slacka).

### Przekazywanie do wątków

Wejście tury podaje stabilne `[id]`, nazwę, typ i rozmiar załączników. Narzędzie
`list_attachments` odczytuje referencje załączników bieżącej rozmowy i
właściciela, także pobranych przez konektor Slack i starszych niż budżet
wejścia. Szkice nie są źródłem.
`start_thread` i `send_message` przyjmują opcjonalne `attachment_ids`.
Gateway ponownie sprawdza właściciela, rozmowę, duplikaty i bieżące limity
przed zgodą i przy wykonaniu. Zgoda jest tą samą zgodą co uruchomienie lub
wiadomość wątku, a karta wymienia nazwy, typy i rozmiary plików.

Akcja tworzy nowe referencje do istniejących blobów (bez uploadu modelu),
wiąże je z turą wątku i zapisuje wynik w jednej transakcji z fencingiem bota.
Wiadomość ma zwykłe załączniki, notatkę ścieżek i autora bota; worker pobiera
pliki zwykłym pipeline'em załączników. `send_message delivery=steer` używa
tych samych reguł capability i fallbacku do kolejki co wiadomość użytkownika.
Rozmowa bota dostaje trwałą notatkę „Sent report.pdf to “Thread””.
Przekazanie plików do wątku na innym połączonym komputerze jest jawnie
odrzucane przed zgodą i bez skutków ubocznych; wybierz wątek w domu bota.

Przeniesienie bota między komputerami obejmuje szkic, wgrane pliki szkicu,
pliki rozmowy i miniatury. Wymaga `remote_bot_composer_v1` na komputerze
docelowym; starsza wersja odmawia przeniesienia z instrukcją aktualizacji.
Pliki muszą zmieścić się w limicie transferu 40 MiB, tak jak pliki wątku.

## Zmiana modelu — ukryte przekazanie kontekstu

Prompt każdej tury podaje **aktualnego dostawcę, etykietę i id instancji, konkretne id
modelu oraz effort**. Wyjaśnia, że wcześniejsze odpowiedzi mogły pochodzić od innych
modeli. Pytany o swoją tożsamość bot ma podawać obecną konfigurację, także po przejściu
z Codexa na Groka; historia rozmowy nie określa tożsamości aktualnego wykonawcy.

Migracja **0045_bot_handoffs** dodaje ukryty rodzaj tury i `bot_handoff_notes`.
Numer **0044** zajmuje scalony z main kreator workerów. Nie dodajemy pól do
kontraktu ani elementów UI (zakres **740–759** pozostaje wolny).

Zmiana dostawcy, instancji, modelu lub effort przez `UpdateBot` albo zatwierdzone
`update_self` zapisuje handoff **w tej samej transakcji co konfigurację**. Utworzenie
bota, również przez innego bota, nie jest zmianą. Bot bez wcześniejszych tur nie
wymaga przekazania; już jedna przyjęta wiadomość użytkownika może zawierać istotny fakt.
Zmiana samej nazwy, persony czy polityki zgód nie tworzy handoffu.

Źródłem jest kopia **poprzedniej konfiguracji** wraz z etykietą instancji; nie kopiujemy
klucza ani URL endpointu. Runtime korzysta z aktualnych poświadczeń tej starej instancji.
Przekazanie działa w `bot_turns`, z tym samym lease, fencingiem, checkpointem i kolejką
co rutyny. Ma pierwszeństwo przed oczekującymi turami (również zatrzymanymi na zgodzie),
ale nie przerywa aktywnej tury z ważnym lease. Następne wiadomości i rutyny czekają
na notatkę. FIFO pomiędzy zwykłymi turami pozostaje zachowane.

Źródłowy model dostaje pełną widoczną historię jak zwykła tura, stare stałe instrukcje,
ostatnią notatkę przekazania i stan rutyn, przypomnień oraz obserwowanych wątków.
Dodatkowo dostaje audyt ostatnich **12 tur** (także ukrytych rutyn i wyników narzędzi),
do 6000 znaków na turę i 36000 łącznie: do 1000 znaków wejścia oraz ostatnich 8 kroków
po wejściu tej tury, do 500 znaków tekstu na krok. Pomijamy powtórzoną widoczną historię
z początku checkpointu. Stan rutyn/przypomnień/wątków ma osobne limity
8000/4000/2000 znaków. **Nie dostaje żadnych narzędzi**, nawet odczytowych. Próba ich
wywołania powoduje fallback, bez dispatchu. Notatka ma zachować pracę i otwarte wątki,
decyzje, preferencje i ton, poznane fakty, obietnice, intencję rutyn oraz następne kroki.

Notatka (maksymalnie **32000 znaków**) trafia wyłącznie do `bot_handoff_notes`, nigdy
do `bot_messages`. Nie tworzy statusu pisania, widocznej wiadomości, karty ani unread.
Każda kolejna tura dostaje ostatnią notatkę w system context jako
`Handoff from your previous model (<model>)`. Poprzednie notatki zostają w bazie do
audytu; nowy handoff dostaje ostatnią notatkę, aby przekazać wiedzę dalej. Notatka jest
historycznym kontekstem, nie upoważnieniem do działań ani źródłem tożsamości modelu.
Prompt każe kontynuować naturalnie, bez ogłaszania przekazania czy wspominania notatek,
chyba że użytkownik wyraźnie o nie zapyta.

### Limit, błędy i szybkie zmiany

Termin handoffu to **90 sekund od zmiany konfiguracji**, zapisane w bazie. Po terminie
anulujemy generację i zwalniamy kolejkę z notatką deterministyczną, także gdy model
ignoruje anulowanie. Restart nie odnawia limitu. Czas oczekiwania na już aktywną zwykłą
turę podlega jej dotychczasowemu limitowi 10 minut; handoff nie wydłuża go o nowe 90 s.
Niedostępna/usunięta stara instancja, odwołany klucz, nieistniejący model, pusta odpowiedź
lub błąd harnessu także uruchamiają fallback. Log i baza przechowują wyłącznie bezpieczny kod
`source_unavailable_or_failed` lub `deadline_exceeded`, bez treści błędu dostawcy.

Fallback nie wywołuje modelu. Składa stare instrukcje (3000 znaków), aktualny stan
rutyn/przypomnień/obserwacji (8000), poprzednią notatkę (9000) i wyciąg z ostatnich
60 wiadomości (11000; do 1200 na wiadomość). Wyciąg jest jawnie oznaczony jako niepełny.
Nie gwarantujemy bezstratnej pamięci przy bardzo długiej historii; dotychczasowy brak
kompakcji pełnej rozmowy może spowodować odrzucenie generacji i użycie fallbacku.

**A→B→C podczas oczekującego/aktywnego handoffu:** pozostaje jedna tura ze snapshotem
A. Nie tworzymy pustego przekazania z B, które jeszcze nie pracowało; notatkę z A
odbiera aktualny C. Unikalny indeks dopuszcza najwyżej jeden aktywny handoff na bota,
a blokada bota serializuje równoczesne zapisy ustawień. Jeśli notatka A jest już
zatwierdzona, następna zmiana tworzy zwykły łańcuch: B dostaje notatkę A i przekazuje ją
dalej. Restart przed odpowiedzią może powtórzyć koszt generacji; zapisany checkpoint
jest odtwarzany bez kolejnej generacji, nawet po wygaśnięciu terminu/usunięciu źródła.
Zapis notatki i zakończenie tury są jedną transakcją; PK `turn_id` gwarantuje jedną
notatkę na handoff, a fencing odrzuca spóźnioną odpowiedź starego wykonawcy.

Weryfikacja: `tests/integration/bot-handoff.test.ts` obejmuje kolejkę, starą/nową
konfigurację, niewidoczność, fallback, termin, usuniętą instancję, restart, łańcuch
i `update_self`. `bot-handoff.live.test.ts` przez CLIProxyAPI uczy bota Codex faktu,
przełącza go na Groka i sprawdza pamięć oraz aktualną tożsamość.

## Umiejętności bota

Każdy bot ma własną bibliotekę procedur. Po wspólnej pracy nad powtarzalnym zadaniem bot może sam zapisać sposób wykonania, a po korekcie właściciela poprawić istniejącą procedurę. Może też zrobić to na prośbę w prywatnym czacie. Akcja **Learn from this conversation** wstawia do kompozytora prośbę o wyciągnięcie kroków, poprawek, zmiennych danych wejściowych i przykładu oczekiwanego wyniku. Właściciel może ją uzupełnić przed wysłaniem.

Na przykład właściciel przygotowuje z botem raport wydania i prosi o pominięcie wycofanych zmian. Bot zapisuje tę regułę w procedurze raportu. Przy następnym wydaniu rozpoznaje zadanie po opisie i pobiera aktualne kroki. Właściciel może też wskazać procedurę po nazwie w instrukcji rutyny albo wyzwalacza.

- `list_skills` zwraca nazwy, krótkie opisy i rewizje. `read_skill` pobiera pełną treść wybranej procedury. Model używa jej z narzędziami i zgodami dostępnymi w bieżącej turze.
- `save_skill` tworzy procedurę lub zastępuje jej opis i instrukcje. Aktualizacja i `delete_skill` wymagają bieżącej rewizji. Bot może zachować do 64 procedur. Zmiana modelu bota zachowuje tę samą bibliotekę.
- Na prośbę właściciela `preview_skill` przekazuje zapisaną procedurę i przykładowe dane do osobnej generacji tekstu bez narzędzi. Bot może zestawić otrzymany wynik ze wzorcem w rozmowie. Kroki wymagające zewnętrznego źródła danych można w ten sposób sprawdzić na dostarczonym przykładzie.
- Tworzenie, zmiana, usuwanie i próba są dostępne w prywatnej rozmowie z właścicielem. Rutyna lub wyzwalacz z potwierdzonym pochodzeniem może odczytać procedurę. Gateway sprawdza pochodzenie także przy wykonaniu narzędzia. Rozmowy z komunikatorów i wiadomości od innych botów nie mają dostępu do biblioteki.

## Rutyny — cron działający w tle

Migracja **0039_bot_routines** dodaje `bot_routines` i pochodzenie rutyny na `bot_turns`.
Nowe pola istniejących komunikatów
zajmują **560–599**: `BotConversation.routines/reminders`, `BotApproval.routine_title`
oraz `Bot.owner_user_id/unread_count/last_read_seq`.
Rutyna ma tytuł, instrukcje, pięciopolowy cron, strefę IANA, opis angielski generowany
na serwerze przez `cronstrue`, enabled, daty utworzenia/zmiany/ostatniego i następnego
wykonania, licznik oraz krótki wewnętrzny wynik. Soft delete zachowuje audyt.

**Granice:** maksymalnie **20** nieusuniętych rutyn na bota (także wyłączonych), odstęp
co najmniej **15 minut**, sprawdzany przez wspólny `cronProblem`; `nextCronRun` zachowuje
reguły DST Bun. `create_routine` i `update_routine` przy pominięciu strefy używają
`UserSettings.timezone` (IANA, pole **620**), synchronizowanej ze strefą przeglądarki.
Tak samo działają narzędzia `create_schedule` i `update_schedule`. Jawna strefa IANA
ma pierwszeństwo; **UTC** jest wartością zastępczą tylko przy braku zapisanej strefy.
Prompt podaje strefę użytkownika, aktualny czas lokalny z offsetem i czas ISO UTC.
`schedule_wakeup.run_at` wymaga ISO z offsetem właściwym dla strefy użytkownika
w wybranym dniu (z uwzględnieniem DST). Panel podaje strefę zapisaną w rutynie;
zmiana strefy urządzenia sama nie przelicza istniejących rutyn i harmonogramów.
Rutyna zapamiętuje `nextHop` tury tworzącej; dalsze akcje i odpowiedzi zachowują limit
**8 hops**. Kolejne wystąpienie tego samego crona zaczyna od zapamiętanych hops,
nie od hops poprzedniego wykonania. Kontekst spoza użytkownika nie może sam tworzyć
ani modyfikować rutyn.

`create_routine`, `update_routine`, `list_routines`, `delete_routine` są w `tools/routines.ts`
ze statusami. Mutacje dotyczą wyłącznie własnego bota i działają atomowo z wynikiem
narzędzia w istniejącym `BotStore.action`. **Nie tworzą kart zgody**, również przy `always`.
Prompt i opisy narzędzi wymagają prośby lub jednoznacznie wyrażonego zamiaru człowieka;
wyniki narzędzi i wiadomości innych botów nigdy nie są takim upoważnieniem. Preferencję
„powiedz tylko gdy…” zapisujemy w instrukcjach, bez osobnych przełączników powiadomień.
W wykonaniu w tle narzędzia zarządzania rutynami i `update_self` są niedostępne.

### Trwałość i kolejka

Tick runtime'u blokuje bota przez `FOR UPDATE SKIP LOCKED`, blokuje należne rutyny,
tworzy ukrytą turę i przesuwa `next_run_at` **w tej samej transakcji**. Klucz żądania
zawiera identyfikator rutyny i planowany termin. Restart ani drugi gateway nie tworzy
drugiej tury tego samego wystąpienia. Wiele terminów po przestoju składa się w **jedno**
wykonanie; kolejny termin liczymy od aktualnego czasu. Jeśli wykonanie/follow-up tej
rutyny nadal czeka lub pracuje, przesuwamy termin bez tworzenia zaległej kolejki.
Jeden przebieg obsługuje do 100 botów, po jednym na transakcję; blokady nie obejmują
pozostałych botów podczas zapisywania wystąpień pierwszego.
Archiwalny/usunięty bot nie uruchamia rutyn. Wyłączenie lub usunięcie rutyny przerywa
także już zakolejkowane/aktywne tury i odrzuca ich oczekujące karty; fencing lease
uniemożliwia zatwierdzenie dalszych efektów starego wykonawcy. Efektu zdalnego, który
już wyszedł przed wyłączeniem, nie można cofnąć.

Rutyna jest zwykłą pozycją w trwałej kolejce `bot_turns`: jedna tura na bota,
FIFO względem wiadomości użytkownika, bez przeplatania narzędzi z drugą turą.
Zgoda lub pytanie w rutynie nie zatrzymuje kolejki: są
[parkowane](#parkowane-pytania-i-zgody-rutyn) i widoczne z oznaczeniem
**From routine ‹title›**. Zaplanowane wystąpienie rutyny korzysta z ustawionych
grantów i bieżącej polityki zgód bota, w tym z jednorazowej zgody na wysyłkę do
lokalnego wątku o odrębnym zakresie.

### Parkowane pytania i zgody rutyn

Pytanie `ask_user` albo narzędzie wymagające karty w przebiegu w tle tworzy kartę
oznaczoną jako zaparkowana (`bot_approvals.parked`, `BotApproval.parked`). Przebieg
w tle to tura rutyny lub wyzwalacza (także ich kontynuacje i odpowiedzi wracające do
nich), pobudka z prywatnej rozmowy (`wakeup:<id>`, sprawdzana w `bot_wakeups`) oraz
kontynuacja zaparkowanej karty (`parked:<id>`, sprawdzana w `bot_approvals`). Tury
rozmów zewnętrznych i odpowiedzi botów niczego nie parkują (`bots/parked.ts`). Model
od razu dostaje wynik `status: parked`, kończy przebieg i w odpowiedzi końcowej zapisuje,
co robił. Gateway dołącza tę odpowiedź do kart przebiegu jako notatkę (do 4000 znaków),
także gdy właściciel zdecydował, zanim przebieg się skończył. Kolejka bota jest wolna,
więc prywatna wiadomość właściciela nie czeka na decyzję. Prywatna rozmowa właściciela
nadal czeka na swoje karty jak dotąd.

Karta pokazuje **From routine ‹title›** albo **From event trigger ‹title›**
(`BotApproval.routine_kind`) i dopisek **· Your answer starts a new run** albo
**· Your decision starts a new run**. Panel szczegółów bota w web/desktop i na telefonie
ma sekcję **Waiting for you** z zaparkowanymi kartami i przyciskiem **Show in chat**,
który przewija rozmowę do karty. Decyzja właściciela zapisuje się w tej samej
transakcji co tura-kontynuacja z pochodzeniem przebiegu i kluczem `parked:<id karty>`.
Ponowienie decyzji zwraca zapisany wynik i nie tworzy drugiej kontynuacji.
Kontynuacja dostaje pytanie lub proponowane działanie i decyzję. Notatkę przebiegu
dostaje przy starcie, gdy przebieg na pewno się już skończył.

Zatwierdzone działanie wykonuje się wyłącznie w kontynuacji, przed modelem, zwykłą
ścieżką narzędzi z lease tej tury, bieżącymi grantami i polityką
(`bots/parked-resume.ts`). Wywołanie i jego zatwierdzenie, razem z zatwierdzonym
podglądem bota i wątkiem z ograniczoną widocznością, zapisują się w kontynuacji, więc
restart nie powtarza efektu. Wynik trafia do wejścia tury raz. Karty działań na plikach
bota nie są parkowane: kontynuacja dostałaby nowy workspace bez plików przebiegu, więc
przebieg czeka na decyzję jak dotąd. Kontynuacja niesie skrót karty (pytanie do 8000
znaków, odpowiedź właściciela w całości), więc zmieści się w kolejce niezależnie od
rozmiaru karty. Kontynuacja rutyny ma uprawnienia przebiegu, który zapytał (zapis wątków
właściciela i notatek), ustalone po zweryfikowanych krawędziach `parked:` → karta → tura.
Kontynuacja pobudki zachowuje dostęp do wątków delegowanych tej pobudce. Powtórka
zaparkowanego przebiegu po restarcie zwraca wynik `parked` i nie wykonuje działania,
nawet gdy decyzja już zapadła. Odrzucenie albo edycja na karcie niczego nie wykonuje,
a kontynuacja dostaje decyzję lub poprawioną wersję jako niezaufany tekst.

Zaparkowana karta wygasa po 24 godzinach według czasu bazy. Pętla kolejki oznacza ją
jako wygasłą i tworzy jedną kontynuację z tą informacją. Blokady bierze w tej samej
kolejności co odpowiedź właściciela (moduł, bot, tura, karta), więc obie się nie
zakleszczą. Wyłączenie lub usunięcie rutyny odrzuca jej zaparkowane karty bez
kontynuacji, a wyłączenie modułu Bots je wygasza i przerywa oczekujące kontynuacje.
Archiwizacja i usunięcie bota wygaszają je jak pozostałe karty. Przeniesienie bota na
inny komputer zabiera zakończone kontynuacje razem z ich kartami.

### Ukryty transkrypt i celowe efekty

`routine_id` i kopia tytułu na turze rozróżniają wykonanie w tle od rozmowy.
W prywatnym czacie wpisy z tytułem rutyny oznaczają rozpoczęcie, zakończenie, błąd
lub przerwanie wykonania. Podczas pracy widać także bieżącą czynność. Surowe wejście,
tekst asystenta i wyniki narzędzi pozostają w historii wykonania. Wpisy aktywności
ze Slacka i rutyn mają nadawcę `activity` i rodzaj `event`. Są widoczne na osi czasu
po ponownym otwarciu rozmowy. Podgląd ostatniej wiadomości, licznik nieprzeczytanych,
powiadomienia i historia dla modelu pomijają te wpisy.

Model dostaje aktualne stałe instrukcje bota (jego obecną formę pamięci), ostatnie
**60 widocznych wiadomości** sprzed tej tury, kopię instrukcji rutyny, planowany/aktualny
czas, strefę, numer uruchomienia i poprzedni krótki wynik. Nie dokładamy poprzednich
ukrytych transkryptów do kolejnej tury. Odpowiedzi od botów, wyniki obserwowanych wątków
i pobudki utworzone w rutynie dziedziczą ukryte pochodzenie i instrukcje; wyłączona lub
usunięta rutyna nie przyjmuje tych follow-upów.

`message_user(text)` jest dostępne tylko w tle i zapisuje **normalną widoczną wiadomość**
do użytkownika. Zapis i wynik narzędzia są atomowe i deduplikowane, także po restarcie
między efektem a checkpointem. Narzędzie nie wymaga dodatkowej zgody. Bez niego finalny
tekst modelu pozostaje ukryty. `send_bot_message`, działania w wątkach, rzeczywiste
pytania i karty zgody mają zwykłe widoczne efekty. O tym, czy jest powód powiadomienia,
decyduje model według instrukcji użytkownika; nie ma dodatkowych ustawień rutyny.

`bots.last_read_seq` trwale przechowuje odczyt właściciela. `Bot.unread_count` liczy
wyłącznie widoczne wiadomości bota do użytkownika powyżej tego numeru, w tym
`message_user`; ukryta tura nie zwiększa licznika. `MarkBotRead` przyjmuje `through_seq`,
sprawdza właściciela i monotonicznie potwierdza najwyżej istniejącą wiadomość.
W web/desktop otwarta rozmowa potwierdza odebrany snapshot w widocznej karcie.
Na telefonie odczyt potwierdza aktywny czat przy najnowszych wiadomościach.
Po potwierdzeniu aplikacja odświeża listę, a licznik znika przy zerze.
Alerty systemowe web i desktop oraz push na sparowany telefon o wiadomościach,
zgodach i pytaniach botów opisuje [notifications.md](notifications.md#push-na-ios-i-androidzie).

`BotConversation` przenosi aktualne rutyny i niedostarczone, nieanulowane jednorazowe
przypomnienia. Zmiana rewizji aktualizuje istniejący strumień `/api/bots/:id/events`,
bez przeładowania i bez technicznego wpisu w czacie. UI API wystawia tylko włącz/wyłącz,
usuń rutynę i anuluj przypomnienie; tworzenie/edycja treści odbywa się przez rozmowę.

### Panel rozmowy

Na `/bots/:botId` przycisk **Bot details** w oszronionym nagłówku otwiera prawą kolumnę
336 px od `lg` (1024 px). Czat dostaje pozostałą szerokość. Preferencja desktopowa jest
w `localStorage` pod `canopy:bot-details:<owner_user_id>`, wspólna dla botów właściciela;
brak dostępu do storage nie blokuje UI. Poniżej `lg` przycisk otwiera istniejący `Dialog`
(dolny panel na telefonie); przy wejściu na telefon modal pozostaje zamknięty. Grupy
i podgląd wymian bot–bot nie dostają tego przycisku — rutyny należą do jednego bota.

Panel pokazuje dużą żywą maskotkę, nazwę, model/dostawcę, przycisk ustawień, rutyny
i aktywne przypomnienia jednorazowe. Wiersz rutyny: tytuł, serwerowy opis crona,
przełącznik z zestawu UI, menu usunięcia z potwierdzeniem, strefa/następny termin
i dyskretny ostatni wynik. Brak formularza tworzenia lub edycji: pusty stan podaje
przykład prośby do bota. Sekcje składa `DetailsSection`; `BotDetailsPanel` ma dodatkowy
slot na przyszłe Connections. Nie zmienia komponentów ustawień połączeń.

Przegląd **componentize** wydzielił `BotDetailsLayout`, `BotDetailsPanel`, `DetailsSection`,
`RoutineRow` i `ReminderRow`. Ruch z **transitions-dev**: card resize + panel reveal,
z reduced motion; mobilny dialog korzysta ze wspólnego ruchu dolnego panelu.


## Wyzwalacze zdarzeń

Wyzwalacz uruchamia bota w tle, gdy w Canopy zajdzie zdarzenie, które bot jawnie
subskrybuje. Zastępuje rutynę, która co kilkanaście minut sprawdza, czy coś się
zmieniło. Bot bez wyzwalacza nie dostaje żadnych zdarzeń.

### Model danych

Wyzwalacz jest wierszem `bot_routines` z `kind = 'trigger'` (migracja **0229**):
bez crona, z typem zdarzenia (`event`), filtrem (`filter`), rewizją z czasem jej
ostatniej zmiany (`revised_at`), stanem `auto_paused` i licznikiem godzin na limicie. Tury wyzwalacza mają `routine_id`
tego wiersza. Dzięki temu pochodzenie, ukryty transkrypt, delegowanie, raporty
obserwowanych wątków, [parkowanie](#parkowane-pytania-i-zgody-rutyn), zatrzymanie
i przeniesienie działają jak w rutynach. Listy i narzędzia rutyn pomijają wiersze
wyzwalaczy. Bot ma najwyżej 20 nieusuniętych wyzwalaczy, osobno od 20 rutyn.

Katalog typów i walidacja filtra są w `@canopy/domain/bot-triggers`. Filtr ma:

- jeden typ zdarzenia z zamkniętej listy, bez wzorców;
- `scope`: identyfikatory zasobów według rodzaju. Każdy typ wymaga co najmniej jednego
  konkretnego zasobu, a pusty zakres jest błędem. Najwyżej 20 identyfikatorów.
  Identyfikatory w jednym rodzaju łączy „lub”, różne rodzaje „i”;
- `where`: warunki `eq`, `in`, `gte`, `lte` na polach typu, bez wolnego tekstu;
- `exclude_own` (domyślnie włączone), `coalesce_seconds` (30–3600, domyślnie 300)
  i `max_turns_per_hour` (1–12, domyślnie 4).

Gateway sprawdza przy zapisie i włączeniu, że zasoby należą do właściciela i istnieją.
Opis zwykłym językiem, np. „When a thread turn finishes in project canopy, if status
is failed; at most 4 runs an hour”, powstaje na serwerze i trafia do `schedule_text`.

| Typ | Źródło | Zakres | Pola |
| --- | --- | --- | --- |
| `thread.turn_finished` | `turns`: `completed`, `failed` albo `interrupted` nie przez użytkownika | projekt, worker, wątek | `status`, `thread_origin` |
| `thread.needs_input` | `interaction_requests`: nowa prośba `pending` do człowieka | projekt, worker, wątek | `kind`, `tool_name` |
| `pr.checks` | `pr_check_notes`: notatka jawnej (`watch_pr_checks`) lub automatycznej obserwacji CI PR-a powiązanego z wątkiem | projekt, repozytorium, PR | `event` (`failure`, `each`, `complete`, `ended`), `reason`, `failed_count`, `automatic` |
| `schedule.run` | `schedule_runs`: wystąpienie pominięte (`missed`, `running`) lub wygasłe oraz koniec tury z `schedule_runs.turn_id` | harmonogram, projekt | `phase` (`skipped`, `expired`, `finished`), `status` |
| `provider.limit` | `provider_usage`: wzrost `usedPercent` okna względem poprzedniej obserwacji tego samego konta, konfiguracji i resetu | worker i profil `<harness>/<id>` natywnej instancji (oba wymagane) | `window` (wymagane), `used_percent` (wymagany sam próg `gte`) |
| `habit.suggested` | `memory_habits`: stan `pending` (nowy albo nowa rewizja) | projekt (wymagany) | brak |

Wątki i harmonogramy delegowane z rozmowy zewnętrznej (`memory_audience`
`conversation:…`) nie emitują zdarzeń. Typy wątków, CI i harmonogramów wymagają
włączonych modułów Bots i Threads. Zdarzenie harmonogramu niesie wątek docelowy, a koniec
uruchomienia także turę i jej `hops`.

Zakończone CI z błędami to `event = complete` z `failed_count > 0`, a konflikt to
`event = ended` z `reason = conflict`. Samo powiązanie PR-a bez obserwacji nie daje
zdarzeń. Próg `gte` na `used_percent` pasuje tylko wtedy, gdy poprzednia obserwacja
była poniżej progu i powstała po bieżącej rewizji wyzwalacza, więc obserwacja sprzed
subskrypcji nie jest punktem odniesienia. Okno z danym resetem zgłasza się raz na
rewizję (`context.once`, z długością okna; potwierdzenia w `bot_trigger_receipts` do resetu
okna albo zmiany rewizji), także gdy użycie spadnie i znów przekroczy próg. Okna o tym samym
kluczu i różnej długości są osobnymi zdarzeniami, a okno po resecie niczego nie zgłasza. Profil to
`<harness>/<id>`, więc instancje Claude i Codexa o tym samym id są różnymi profilami.
Limity dostawcy raportują dziś natywne instancje Claude i Codexa. Zdarzenie
współdzielonego workera trafia osobno do każdego właściciela, którego wyzwalacz wskazuje
profil i który widzi jego użycie tak jak widok użycia (migracja **0231**; zdarzenia są
unikalne per właściciel).
`provider.limit` i `habit.suggested` nie mają historii, więc ich utworzenie zawsze
wymaga karty.

### Zapis, dopasowanie i tura

1. Wyzwalacz PostgreSQL tabeli źródłowej (migracja **0230**) wywołuje
   `bot_trigger_record` w transakcji faktu. Funkcja szuka po indeksie
   `bot_trigger_scopes`, jednym odczytem na zasób zdarzenia, włączonych wyzwalaczy,
   których zakres go obejmuje.
   Tylko wtedy zapisuje `bot_trigger_events` z identyfikatorami, polami typu i listą
   kandydatów z ich rewizjami. Wiersz nie zawiera treści. Wiersze zakresów istnieją
   tylko dla włączonych, niewstrzymanych wyzwalaczy.
2. Pętla kolejki bota (`bots/trigger-matcher.ts`) bierze porcję zdarzeń właściciela
   pod blokadą modułu; przy wyłączonych Bots je usuwa. Zdarzenie zapisane przed ostatnim
   przełączeniem modułu (`bot_trigger_generations`), także w transakcji zatwierdzonej po
   nim, jest odrzucane. Kandydatów blokuje raz,
   w kolejności id, przed odczytem rewizji. Rozważa wyłącznie kandydatów z rewizją równą
   zapisanej, więc wyzwalacz utworzony lub zmieniony po zapisie zdarzenia go nie dostanie.
   Zdarzenie kandydata, którego bot jest zamrożony przez nierozstrzygnięte przeniesienie,
   czeka (`held_until`): wycofanie je dopasuje, zatwierdzenie odrzuci.
   Pomija tury obserwowane przez bota (ich raport przychodzi z obserwacji, także po
   dostarczeniu), a przy `exclude_own` także wątki uruchomione przez niego i tury z jego
   wiadomością (wejście lub steer). Dopasowane zdarzenie trafia do otwartej partii tej
   rewizji jako projekcja z nazwami zasobów. Partia trzyma licznik i ostatnie 50 projekcji.
3. Partia zamyka się po oknie ciszy albo po 20 zdarzeniach (`bots/trigger-flush.ts`).
   Gateway czyta ją ponownie pod blokadami w kolejności moduł, bot, wyzwalacz, partia.
   Gdy trwa tura tego wyzwalacza, partia czeka 30 sekund (`check_after`). Po wyczerpaniu
   limitu godzinowego czeka do zwolnienia miejsca i dalej zbiera zdarzenia. Wstrzymane
   partie nie zajmują miejsca nowszym. Licznik liczy kolejne godziny zegarowe z partią
   wstrzymaną na limicie; przebiegi pomiędzy nimi go nie zerują. Trzecia z kolei taka
   godzina wstrzymuje wyzwalacz, usuwa jego zakresy i dodaje do czatu wpis „Paused
   trigger ‹title›: it fired too often”. Przed utworzeniem tury gateway usuwa z partii
   zdarzenia, których zasób nie jest już właściciela lub nie jest widoczny, z usuniętych,
   przeniesionych lub zarchiwizowanych wątków, rozwiązane prośby, przejrzane nawyki oraz
   zdarzenia typów wątków przy wyłączonym module Threads. Pusta partia nie uruchamia
   modelu. Zdarzenia minionych wystąpień harmonogramu są aktualne także po jego
   zakończeniu. Zdarzenie limitu wymaga, by właściciel nadal widział użycie tej pary worker
   i profil. To samo sprawdzenie powtarza się przy pierwszym uruchomieniu tury: tura
   czekająca w kolejce dostaje tylko aktualne zdarzenia, z instrukcjami i opisem
   wyzwalacza z chwili utworzenia tury (`bot_trigger_batches.snapshot`), a bez nich kończy
   się bez wywołania modelu („Nothing left to report”). Tura wznowiona po restarcie lub
   odpowiedzi odzyskuje się jak zwykle. Tura bota z harnessem czeka, aż jej worker będzie
   miał połączenie botów z którąkolwiek bramą (`worker_connections.bot_presence_until`);
   worker połączony bez harnessu botów albo zarchiwizowany lub odwołany kończy turę błędem
   konfiguracji. Pod swoją dzierżawą
   tura sprawdza zdarzenia jeszcze raz tuż przed zapisaniem pierwszej komendy: po zmianie
   zaczyna od nowa z aktualnymi zdarzeniami, a bez nich kończy się jak przebieg bez wyniku,
   bez wywołania modelu. Komenda tury wyzwalacza ma własny identyfikator. Przy pierwszym
   wysłaniu ta sama transakcja sprawdza zdarzenia i zapisuje decyzję: `delivered` przed
   wysłaniem ramki albo `failed` z `TRIGGER_SUPERSEDED`, gdy zdarzenia się zmieniły.
   Odrzucona komenda nigdy nie wychodzi, traci treść (`payload_pruned_at`), a przebieg zaczyna
   od nowa z nową komendą i aktualnymi zdarzeniami albo kończy się bez wyniku. Komenda wysłana
   wcześniej jest odzyskiwana bez zmian. Brama, która nie może wysłać komendy tury bota przez
   brak zdolności workera, kończy ją błędem `BOT_WORKER_OUTDATED`, więc tura nie czeka
   w nieskończoność; odmawia tylko bieżąca rejestracja workera (`worker_connections.epoch`)
   i tylko dla komendy, której żadne połączenie jeszcze nie próbowało wysłać. Każda komenda
   tury bota przekazana do połączenia jest od razu zapisana jako `delivered`, także przed
   potwierdzeniem workera. Tura bota czekająca na workera (także na potwierdzenie
   przerwania poprzedniej tury), który został w międzyczasie zarchiwizowany albo odwołany,
   kończy się błędem konfiguracji (sprawdzane co 5 s): otwarta komenda dostaje
   `BOT_WORKER_REMOVED`, a tura harnessu, której start worker już potwierdził, kończy się
   jako `FAILED` z tym samym kodem, bo taki worker nie może jej już wykonać ani zgłosić wyniku.
   Wynik końcowy zapisany wcześniej zostaje. Zdarzenie limitu musi też pochodzić z bieżącej
   konfiguracji workera, a jego okno nie może być już zresetowane według zegara botów.
4. Tura ma klucz `trigger:<id>:<partia>`, `hops` równe większej z wartości wyzwalacza
   i najwyższego `hops` źródła plus jeden oraz wejście z instrukcjami, opisem filtra
   i listą zdarzeń oznaczoną jako niezaufane dane.

Zmiana, wyłączenie albo włączenie podnosi rewizję i porzuca otwarte partie. Wyłączenie
i usunięcie przerywają tury wyzwalacza i odrzucają jego zaparkowane karty. Edycja nie
wznawia wyzwalacza wstrzymanego automatycznie; robi to tylko jawne włączenie.
Wyłączenie i włączenie modułu Bots usuwa zapisane zdarzenia i porzuca otwarte partie,
a wyłączenie przerywa też oczekujące tury wyzwalaczy. Niedostarczona partia wygasa po
24 godzinach, a zamknięte partie są usuwane po 14 dniach, także bez nowej pracy bota,
ale nie wcześniej, niż skończy się ich tura.

Tura wyzwalacza jest ukrytym przebiegiem w tle, jak rutyna. Prompt nazywa ją
„event trigger”. Model widzi wyłącznie wejście tej tury, bez prywatnej historii
i handoffu. Pamięć zakresu Bot jest tylko do odczytu. Odczyt wątków właściciela
działa jak w rutynie. Narzędzia zarządzania rutynami i wyzwalaczami oraz
`update_self` są niedostępne. Pamięć i odczyt wątków wymagają, by wyzwalacz utworzyło
wywołanie `create_trigger` z prywatnej wiadomości właściciela. Odczyt i lista wątków
pomijają wątki delegowane z rozmowy zewnętrznej i wątki innych komputerów. Tak samo
lista i zmiany harmonogramów (także rodzic nowego wątku harmonogramu) pomijają
harmonogramy i wątki pracujące dla rozmowy zewnętrznej,
a pliki z prywatnej rozmowy właściciela są dla tury wyzwalacza niedostępne.

### Narzędzia

| Nazwa | Działanie | Zgoda |
| --- | --- | --- |
| `list_trigger_event_types` | Katalog typów, rodzajów zakresu, pól i wartości | R |
| `preview_trigger` | Walidacja filtra, opis i szacunek z ostatnich 7 dni, bez zapisu; wymaga prywatnej wiadomości właściciela | R |
| `create_trigger` | Nowy wyzwalacz; wymaga prywatnej wiadomości właściciela, sprawdzanej przed kartą | Karta przy szacunku powyżej 10 przebiegów w dobie albo bez pełnej historii, także w Full auto |
| `update_trigger` | Zmiana z wymaganą `revision`; `enabled` wstrzymuje lub wznawia | Jak wyżej, gdy zmienia typ, filtr lub instrukcje włączonego wyzwalacza albo go włącza |
| `list_triggers` | Własne wyzwalacze z licznikami z 7 dni | R |
| `delete_trigger` | Usunięcie i przerwanie tur | Bez karty |

Szacunek (`bots/trigger-history.ts`) czyta historię źródła z 7 dni z wykluczeniami
własnej pracy bota i odtwarza okno ciszy, rozmiar partii i limit godzinowy, z partią
czekającą na wolne miejsce (`estimateRuns`). Typ bez historii albo źródło bez faktów
starszych niż 7 dni (np. nowa instalacja) zwraca „No full history…”, nigdy zero.
Wywołanie ponawiane, gdy jego karta czeka, używa szacunku z pierwszej próby.

UI API: `SetBotTriggerEnabled` i `DeleteBotTrigger`, z trasowaniem do domu bota na
połączonych komputerach. **Bot details** w web/desktopie (`TriggerRow`) i na telefonie
(`BotTriggers`) ma sekcję **Event triggers** obok rutyn: tytuł, opis filtra, liczbę
zdarzeń i przebiegów z 7 dni albo stan pauzy (także **Paused after running too often**),
ostatni przebieg, przełącznik i usunięcie z potwierdzeniem. Pusty stan podaje przykład
prośby. Tworzenie i edycja odbywają się w rozmowie z botem. BFF web ma trasę
`/api/bots/:botId/triggers/:triggerId` (PUT, DELETE). `BotConversation.triggers` przenosi wyzwalacze z licznikami.
Przeniesienie bota dostarcza wyzwalacze wyłączone, bez zakresów, bo wskazują zasoby
źródłowego komputera. Po wskazaniu lokalnych zasobów właściciel włącza je ponownie.
Bot z wyzwalaczami (także usuniętymi) przenosi się tylko na komputer z możliwością
`move_bot_triggers_v1`. Konsolidacja gatewayów przenosi zakresy razem z wyzwalaczami,
pomija kolejki zdarzeń, partii, generacji i potwierdzeń, a import historii nie budzi
wyzwalaczy celu (źródłowe wyzwalacze PostgreSQL celu są na ten czas wyłączone). Projekt
scalony z istniejącym dostaje zachowane id w zakresach i filtrach wyzwalaczy.

Testy: `tests/integration/bot-event-trigger-sources.test.ts` (CI, harmonogram i rozmowa
zewnętrzna, próg limitu z punktem odniesienia i tożsamością profilu, współdzielony worker,
nawyk), `tests/integration/bot-event-triggers.test.ts` (zakres i walidacja, składanie
w jedną izolowaną turę, wyścig rewizji, własne i obserwowane tury, wyłączenie, limit
i pauza w trzech godzinach, ponowny odczyt partii pod blokadą, tura z nieaktualnymi
zdarzeniami, przełączenie modułu, odczyt wątku rozmowy zewnętrznej, karta w Full auto),
`tests/integration/bot-parked-interactions.test.ts` oraz asercje przeniesienia
w `computer-moves.test.ts`.

## 1. Decyzja o wykonaniu

Runtime bota to **oficjalny harness na przypiętym workerze**. Wszystkie trzy
rodziny providerów obsługują instancje `native` i proxy. Harness korzysta z loginu
wybranej instancji. Przy natywnym logowaniu Codexa poświadczenia trafiają przez
lokalne RPC do pamięci izolowanego procesu bota. Proxy trafia do oficjalnego CLI, a nie klienta HTTP Canopy.
Nie uruchamiamy harnessów na hoście gateway.

Bez zapisanego workera pierwsza tura w lokalnym gatewayu desktopu preferuje jego
worker obsługujący instancję. Gateway serwerowy wybiera pierwszy dostępny worker
online z obsługą harnessu botów i dostępną instancją; wybór zostaje zapisany. Brak kandydata
daje `Waiting for a worker`; offline przypiętego workera daje `Waiting for ‹worker›`.
Nie ma automatycznego failoveru. Istniejące boty zachowują identyfikatory i historię;
następna tura tworzy ukrytą sesję na podstawie transkryptu gatewaya.

**Runs on** w ustawieniach pozwala zmienić przypięcie. Gdy żaden worker nie ma
instancji, UI kieruje do ustawień providerów: włącz instancję na workerze, zainstaluj
CLI i zaloguj się. Wyłączenie instancji na już przypiętym workerze daje błąd
konfiguracji z wyborem ustawień lub innego workera, bez cichego przenoszenia sesji.
Zmiana przypięcia dotyczy kolejnej tury. Aby użyć innego workera dla wiadomości
oczekującej offline, zatrzymaj odpowiedź, zmień Runs on i wyślij wiadomość ponownie.

Grok ma prywatne sesje per bot i instancja, wznawiane przez `session/load`.
Curated profil oraz `--tools search_tool,use_tool` usuwają lokalne narzędzia,
pozostawiając obsługę MCP. Proces nie dziedziczy skilli, launch args ani MCP
urządzenia. Każdy callback zgody ACP jest odrzucany; zgody narzędzi Canopy pozostają
w gatewayu. Jawna reguła `MCPTool(canopy__*)` przepuszcza transport Canopy przed
callbackiem. Codex analogicznie ustawia `default_tools_approval_mode="approve"`
wyłącznie dla serwera Canopy; jego wewnętrzne `approvalPolicy="never"` nie jest
ustawieniem bota. Szczegóły odmów i granicy zgód: [bots-harness.md](bots-harness.md#narzędzia-i-granica-bezpieczeństwa).
Utrata sesji odtwarza kontekst bez ponawiania historycznych narzędzi.
Czytnik własnego `updates.jsonl` Groka odzyskuje tekst i zapisany koniec tury po awarii.
Przy składaniu odpowiedzi gateway zapamiętuje identyfikatory itemów wykluczonych
z wiadomości bota, w tym rozumowania. Zdarzenia rozumowania pozostają w dzienniku
harnessu.

### Izolowane generowanie tekstu i dowód dla sesji botów

Repozytorium używa izolowanych SDK do generowania tytułów
([thread-titles.md](thread-titles.md)). Testy izolacji korzystają z przypiętej wersji
Claude Agent SDK i zainstalowanego Codex CLI, bez aktualizacji zależności.

- Claude: `tools: []`, `allowedTools: []`, odmowa w `canUseTool`, `settingSources: []`,
  własny system prompt, `mcpServers: {}`, `strictMcpConfig: true`, brak pluginów,
  wyłączone hooki, katalog testowy przez `@canopy/testing`, brak zapisu sesji.
  To lista narzędzi bazowych jest pusta; samo `allowedTools` nie byłoby takim dowodem.
- Codex: `model_catalog_json` z `shell_type: "disabled"`,
  `apply_patch_tool_type: null`, `experimental_supported_tools: []`,
  `tool_mode: "direct"`, `multi_agent_version: null`; ponadto `web_search="disabled"`,
  `agents.enabled=false`, `tools.update_plan.enabled=false`,
  `tools.experimental_request_user_input.enabled=false`,
  `features.shell_tool=false`, `features.apply_patch_freeform=false`,
  `features.view_image=false`, `features.multi_agent*=false`, `features.apps=false`,
  `features.js_repl=false`, `features.code_mode*=false`, `features.tool_search=false`,
  `features.plugins=false`, `features.goals=false` oraz pozostałe wyłączenia
  z `codexTextOverrides`. Wątek: `dynamicTools: []`, `environments: []`,
  `project_doc_max_bytes: 0`, `mcp_servers: {}`, ephemeral, osobny `CODEX_HOME`.
  Sandbox `read-only`, zatwierdzenia `never`, sieć sandboxa wyłączona — to dodatkowa
  ochrona, **sam read-only sandbox nadal pozwalałby czytać pliki przez shell**.
- `apps/worker/src/providers/generate-text.test.ts`: prawdziwy CLI każdego dostawcy
  dostaje polecenie uruchomienia `ls`; kontrolowany endpoint przechwytuje żądanie
  modelu i potwierdza pustą listę `tools`. Test Codexa sprawdza również przyjęcie
  konfiguracji przez `--print-startup-config`. Samo przyjęcie kluczy nie dowodzi
  usunięcia narzędzi; dowodem jest żądanie do modelu.
- `tests/integration/text-generation.live.test.ts`: oba SDK przez CLIProxyAPI
  odpowiadają `NO_LOCAL_TOOLS` na prośbę o lokalne `ls`; brak trwałych wątków,
  transkryptów i dziennika komend generacji.

Powyższe ustawienia opisują generowanie tekstu bez narzędzi. Sesje botów zachowują
transkrypt i dodają wyłącznie Canopy MCP; szczegóły oraz dowód listy narzędzi
rzeczywistych CLI zawiera [bots-harness.md](bots-harness.md).

W wycofywanym wariancie B brak lokalnych możliwości wynika dodatkowo z konstrukcji: gateway nie
uruchamia procesu dostawcy, a wysyłane schematy są wyłącznie funkcjami z jawnej listy.
Nie wysyła narzędzi hostowanych dostawcy (shell, wyszukiwanie, code interpreter).
Wywołanie nieznanej funkcji zwraca błąd, nie uruchamia dynamicznego dispatchera.

## 2. Dane i jedna rozmowa

Migracja **0031_bots** (po scaleniu `0030_bus_notify_delivery` z main) jest addytywna. Wybrano osobny schemat tabel. Obecne `threads`
wymagają projektu, mają reguły główny/boczny, placement, fork i szynę z relacją rodzica.
Sztuczny projekt i ukryty wątek gateway naruszałyby semantykę niezależnej sekcji Bots.
`runtime='gateway'` pozostaje w schemacie Threads dla przyszłych agentów projektowych.

| Tabela | Rola |
|---|---|
| `bots` | Właściciel, konfiguracja (nazwa, kształt, kolor, instancja/model/effort, persona, polityka zgód), rewizja rozmowy, status, archiwizacja i soft delete. Sam `bot_id` jest identyfikatorem jedynej rozmowy z człowiekiem. |
| `bot_turns`, `bot_messages` | Trwałe wejścia i kolejka, checkpoint modelu, hops, lease z tokenem; wiadomości z nadawcą, adresatem i opcjonalną wymianą. Unikalne `(bot_id, client_request_id)` oraz `(turn_id, message_key)` deduplikują zapis. |
| `bot_tool_calls`, `bot_approvals` | Jawne schematy narzędzi, argumenty i wynik wewnętrzny; trwałe zatwierdzenie albo pytanie z odpowiedzią. Dane techniczne nie trafiają do zwykłej osi czatu. |
| `bot_mcp_servers`, `bot_mcp_connections` | Rejestr właściciela, URL, transport, włączenie, odwołania do zaszyfrowanych nagłówków; relacja przypisania serwera do botów. |
| `bot_thread_watches`, `bot_wakeups` | Outbox wyników tur workerów i jednorazowych pobudek własnego bota; dostarczenie i nowa tura zatwierdzane razem. |

Przypięcia są ustawieniem użytkownika: `SidebarSettings.pinned_bot_ids`, pole **350**.
Nie są stanem bota. Inne nowe komunikaty mają własny plik proto; nie zajmują numerów
dotychczasowych komunikatów. Tury workera uruchomione przez bota mają `trigger='bot'`,
`bot_call_id` i dodatnie `hops`, żeby przejście przez worker nie zerowało łańcucha.

Migracja **0034_bot_archive** dodaje `bots.archived_at` (po scalonej z main `0033_bot_mentions`). Archiwizacja zachowuje konfigurację,
rozmowę i niedostarczone pobudki; soft delete nadal używa `deleted_at`. Nowe pola istniejących
komunikatów zajmują zarezerwowany zakres: `Bot.archived`, `ListBotsRequest.include_archived`
i `BotMessage.setting_changes` mają numer **430** w swoich komunikatach.

## 3. Wykonanie i odtwarzanie

1. Przyjęcie wiadomości zapisuje wejście, turę i wiadomość czatu w transakcji; ACK
   następuje po commicie. Powtórzenie tego samego `client_request_id` zwraca tę samą turę.
2. Gateway przejmuje najstarszą niezakończoną turę bota przez `FOR UPDATE SKIP LOCKED`.
   Jedna rozmowa ma najwyżej jednego wykonawcę. Lease trwa 30 s i odnawia się co 5 s.
   Token lease i jego ważność są sprawdzane przy każdym zapisie checkpointu lub wyniku.
3. Komenda harnessu trafia do trwałego outboxa. Worker zapisuje zdarzenia w journalu
   przed publikacją; gateway deduplikuje je i potwierdza po commicie. Wywołanie MCP
   przechodzi przez szynę z identyfikatorem bota i tury, kontrolą właściciela,
   przypięcia workera i lease. Zatwierdzone wyniki są odczytywane zamiast wykonywane.
4. Utworzenie wątku, pierwszej tury, komendy workera, subskrypcji wyniku i zapis wyniku
   funkcji platformy są jedną transakcją. Kolejkowanie kolejnej wiadomości do wątku
   również zatwierdza turę i subskrypcję razem. `steer` obserwuje dostarczenie do aktywnej
   tury lub istniejący fallback do kolejki, zachowując autora bota i hops. Outbox workerów zachowuje własną
   idempotencję komend. Archiwizacja używa istniejącego, idempotentnego cyklu życia.
   Wynik zatwierdzony w transakcji ma pierwszeństwo przed późniejszym błędem dispatchu
   lub publikacji; taki błąd nie nadpisuje sukcesu i nie zachęca modelu do powtórzenia akcji.
   Oczekujące pytanie lub formularz obserwowanej lokalnej tury kolejkuje osobne
   powiadomienie dla bota raz na subskrypcję i interakcję. Bot może odczytać pytanie
   przez `read_thread` i zaproponować odpowiedź przez `answer_interaction`. Zapis
   powiadomienia i jego deduplikacja są atomowe. Subskrypcja pozostaje aktywna do
   zakończenia tury lub [potwierdzonej kontynuacji](#wynik-pracy-kontynuowanej-przez-claude).
   Jeśli kilka wiadomości bota trafia do tej samej tury, gateway kolejkuje jeden
   raport końcowy na bota, turę i zakres odbiorcy (rozmowa lub rutyna). Zapisana
   tura bota potwierdza doręczenie także po restarcie gatewaya. Odrębne tury
   wątku mają osobne raporty, nawet gdy zawierają ten sam tekst.
   W lokalnych powiadomieniach tytuł zajmuje do 200 jednostek
   UTF-16, a treść raportu końcowego do 80 000. Pełny tytuł i wynik pozostają
   zapisane w wątku. Prośby o uprawnienia nadal obsługują karty zgód.
5. Przed zdalnym MCP zapisujemy `running`. Gdy lease zostaje przejęty po awarii,
   takie wywołanie staje się `interrupted`, z opisem nieznanego wyniku. Model dostaje
   ten wynik, a nie ponowione żądanie MCP. Dokładnie jednokrotnego wykonania obcego
   serwera HTTP nie można obiecać bez jego własnego klucza idempotencji.

Checkpoint i końcowa wiadomość są trwałe. Restart gatewaya dołącza do tej samej komendy.
Restart workera odczytuje koniec z transkryptu harnessu; brak zapisanego końca przerywa
turę systemowo. Jawne Retry tworzy nową komendę, bez automatycznego powtarzania
niepewnych efektów MCP. Stary wykonawca nie może zatwierdzić wyniku po utracie
lease. Łagodne zatrzymanie anuluje zapytania i oddaje lease; twarda awaria wymaga jego
wygaśnięcia. Oczekiwanie na zgodę nie trzyma procesu ani połączenia z modelem.

Limit wykonawczy fazy 1: cztery tury na instancję gateway, 32 rundy narzędzi na turę,
32 funkcje w odpowiedzi, 10 min na aktywną próbę. Długie konteksty i kompakcja wymagają
dalszej pracy; obecnie dostawca może odrzucić zbyt długą historię. UI otrzymuje całe
wiadomości po zapisaniu; status jest aktualizowany podczas generacji i narzędzi.

### Zatrzymanie odpowiedzi

W web/desktop i mobile przycisk wysyłki zmienia się w **Stop** podczas odpowiedzi,
także gdy użytkownik pisze już następny szkic. `InterruptBot` działa na komputerze
macierzystym bota i sprawdza właściciela. Zatrzymuje jedną bieżącą widoczną turę
(także czekającą na workera lub zgodę); bez uruchomionej tury wybiera najstarszą
oczekującą wiadomość. Nie czyści pozostałej kolejki, przyszłych rutyn ani pobudek.
Ukryte wykonanie rutyny nie jest odpowiedzią czatu; Stop obejmuje je tylko wtedy,
gdy czekająca zgoda lub pytanie pokazały je użytkownikowi.

Gateway w jednej transakcji unieważnia lease, wygasza karty tej tury, zachowuje
odebrany fragment odpowiedzi z wpisem **Stopped by you** i zapisuje polecenie
przerwania w trwałym outboxie. Wynik harnessu staje się terminalny: spóźnione zdarzenia
są potwierdzane, lecz nie zmieniają treści ani nie wywołują narzędzi. Wykonanych
wcześniej efektów Stop nie cofa. Kolejną wiadomość można wysłać od razu; jej harness
rusza po potwierdzeniu zamknięcia poprzedniego procesu przez workera.

Polecenie czeka także przy rozłączonym workerze i przeżywa restart gatewaya.
Po połączeniu worker przerywa izolowany harness Claude/Codex/Grok przed ACK.
Journal zapamiętuje przerwanie, które wyprzedziło uruchomienie; restart workera
zamyka otwarte tury przez standardowe odtwarzanie. Stan zakończonej przez Stop
odpowiedzi nie wraca do „Typing…”. Nie zmienia to protokołu ani capability
`bot_harness_v1`; starsze workery nadal otrzymują istniejące `InterruptBotTurn`.

## 4. Narzędzia, uprawnienia i status

Bot działa w imieniu właściciela. Listy i odczyty filtrują właściciela; tworzenie wątku
wykorzystuje walidację projektu/workspace'u, dostępności instancji i katalogu modeli
z UI API. Rozmowy i wyniki innych agentów są niezaufanymi danymi, nie instrukcją
poszerzenia uprawnień. Model nigdy nie dostaje kluczy endpointu ani nagłówków MCP.

Definicje narzędzi platformy, statusy i wykonanie są razem
w `apps/gateway/src/bots/tools/{projects,workers,providers,threads,schedules,settings,create-bot,routines,workspace,outgoing-files}.ts`;
rejestr w `tools/index.ts` jest delegatem `PLATFORM_TOOLS` i `botPlatform`. Tworzenie botów
ma osobny deskryptor `tools/create-bot.ts`. Pozostawione
nazwy wcześniejszych narzędzi zachowują zgodność. Nie ma meta-narzędzia „opisz obszar”:
Krótkie opisy nie wymagają dodatkowej rundy modelu. Lista nie zawiera dowolnych
narzędzi hosta ani edycji innych botów; własne ustawienia zmienia `update_self` (niżej).
Files dodaje sześć ograniczonych narzędzi scratch opisanych na początku dokumentu;
ich wyłączenie usuwa je z katalogu i blokuje wykonanie po wcześniejszej zgodzie.

Legenda zgód: **R** — odczyt platformy, nigdy nie wymaga karty, także przy `always`;
**P** — dotychczasowa polityka platformy (`safe`: odwracalna akcja bez karty,
`always`: karta przed wykonaniem); **A** — karta zawsze, niezależnie od polityki;
**C** — karta w safe/always, z możliwością stałej reguły.
Zdalne MCP zachowuje dotychczasowe reguły: `safe` przepuszcza wyłącznie deklarowane
odczyty bez flagi destrukcyjnej, pozostałe operacje wymagają zgody; `always` pyta także
o odczyty MCP. `ask_user` zawsze tworzy kartę pytania.

**Full auto** (`full_auto`, „Only protected actions (full auto)”): zwykłe akcje i wywołania
MCP działają bez karty. Chronione akcje **A**, zmiany modelu i uprawnień nadal pytają.
Zmiana polityki w ustawieniach lub menu karty nie odpowiada na oczekujące karty.

### Stałe reguły zgody

„Always allow…” na karcie zatwierdza tę akcję i zapisuje dokładnie wybraną regułę.
Gateway wylicza i utrwala opcje karty; klient przesyła jedynie identyfikator opcji.
Treść promptu, odpowiedź modelu ani wiadomość innego bota nie tworzy reguły.
Reguły są osobną, przypisaną właścicielowi relacją `bot_approval_rules`, poza konfiguracją
edytowalną przez model. Nie nadają dostępu do konta: istniejące granty connectorów nadal
obowiązują. Gateway sprawdza aktualne reguły przy następnym żądaniu, także przy obsłudze
bota przez jego domowy gateway z połączonego komputera.

Zakresy: `start_thread` dla konkretnego projektu albo wszystkich projektów;
`connector` dla konkretnego konta, wszystkich narzędzi albo jednej nazwy narzędzia;
`slack_post` dla wysyłki jako Canopy do konkretnej rozmowy na danym koncie Slack
([connectors.md](connectors.md#bezpośrednia-wysyłka-w-slacku)), także w Full auto;
`send_bot_message` dla konkretnego bota. Pozostałe zakresy to pojedyncze rodzaje akcji:
`create_project`, `rename_project`, `send_message`,
`rename_thread`, `interrupt_thread`, `set_goal`, `regenerate_title`, `create_schedule`,
`update_schedule`, `set_schedule_status`, `schedule_wakeup`, `update_settings` (generowanie tekstu),
`update_self` (nazwa, wygląd i instrukcje). Odczyty platformy i obsługa własnych routines
nie wymagają kart, więc nie potrzebują reguł.

Zestaw **zawsze pytaj**, niezależny od reguł i full auto: `create_bot`, `archive_project`,
`add_workspace`, `update_workspace`, `remove_workspace`, `set_project_defaults`, `set_instance_worker`, `set_instance_models`,
`set_thread_model`, `archive_thread`, `delete_thread`, `fork_thread`, `set_thread_permission`,
`answer_interaction`, `stop_background_task`, `cancel_schedule`, `set_canopy_preference`. `update_self` zawsze pyta
o model, effort, dostawcę, instancję i politykę; nie przyjmuje reguł ani ustawień uprawnień
wątków. `update_settings.thread_defaults` też zawsze pyta.
`ask_user` pozostaje pytaniem. Nieznane narzędzie nie dostaje opcji stałej reguły.
Dodanie lub zmiana workspace’u zawsze pyta, także przy zmianie samej etykiety;
reguła projektu nie może posłużyć do przekierowania pracy do innego katalogu.

W ustawieniach obok „Ask for approval” lista „Allowed actions” pokazuje zakres, czas i źródło
(„Added from an approval card”). „Remove rule” cofa zgodę od następnego żądania; historia
zachowuje kopię reguły. Każda akcja przepuszczona regułą zostawia w czacie zwięzłą linię
„Allowed by rule: …” z odnośnikiem do zarządzania regułą.
Już utrwalona zgoda pozostaje ważna po cofnięciu reguły i restarcie gatewaya:
zatwierdzona akcja wykona się raz. Cofnięcie dotyczy nowych żądań, nie cofa przyjętych decyzji.
Reguły bota archiwalnego lub przeniesionego nie zatwierdzają nowych żądań.

Nowe boty mają „Threads started by this bot” ustawione na **Inherit default** (`user_default`):
gateway bierze aktualne domyślne uprawnienia właściciela z Settings → Threads, niezależnie
od „Ask for approval” bota. Właściciel może wybrać stałe Ask first, Read only, Accept edits,
Full auto albo Full access; Full access wymaga potwierdzenia w UI. Wybór dotyczy nowych
wątków, także `fork_thread` i `new_thread` harmonogramu; istniejące wątki zachowują swój tryb.
Model nie dostaje pola `permission` w narzędziach tworzenia wątków i harmonogramów;
wstrzyknięte pole jest odrzucane. Domyślne ustawienie jest odczytywane przez gateway,
a nie z argumentów modelu. Dla bezpośrednich startów wybór jest ponownie rozstrzygany
w transakcji tworzenia. Harmonogram zapisuje wybór przy utworzeniu lub aktualizacji.
Na połączonym komputerze gateway źródłowy wybiera tryb właściciela, a docelowy stosuje
ograniczenie swojego workera. Worker bez capability `full_access` ogranicza Full access
do Full auto. Harmonogramy tworzone i aktualizowane narzędziami bota ograniczają Full access
do Full auto. Powód trafia do szczegółów wątku w web i mobile. Właściciel może
potwierdzić Full access w edytorze harmonogramu ([agent-bus.md](agent-bus.md#nowy-wątek-przy-każdym-uruchomieniu)).

Migracja ustawienia dziedziczenia zamienia brak wyboru i dawne `same_bot` na `user_default`.
Zachowuje jawne ustawienia, w tym Ask first zapisane wcześniej przez migrację **0090**.
Starszy klient pomijający pole przy zapisie zachowuje zapisany wybór. Zweryfikowane
wywołania connectorów czytają bieżący wybór przy każdym żądaniu: Inherit default pozwala
dziedziczyć reguły kont bota, również we wcześniej uruchomionych wątkach; stały tryb
nie dziedziczy tych reguł. Chronione prośby nadal wymagają zgody. Karty narzędzi uruchomionych wątków pojawiają się
również w czacie bota, także przez istniejącą trasę UI połączonego komputera. To widok tego
samego `interaction_requests`, a nie druga zgoda: odpowiedź w dowolnym miejscu rozwiązuje
jedno żądanie i wysyła jedną odpowiedź do workera. Reguły kont są dziedziczone tylko przez
lokalne wątki; konto na innym gatewayu ma odrębny grant i wymaga jego własnej zgody.
Odpowiedź najpierw sprawdza lokalną kartę bota; zdalna karta niesie kwalifikowane id
oryginalnego żądania i trafia bezpośrednio do jego domu. Otwarty czat pobiera z połączonych
komputerów tylko oczekujące zgody aktywnych tur, bez snapshotów i historii zakończonych
wątków. Archiwalne i przeniesione boty nie są odpytywane; lista botów liczy tylko oczekujące zgody.

Przeniesienie bota na inny komputer zachowuje historię kart, ale nie przenosi stałych
reguł ani powiązań z wcześniej uruchomionymi wątkami. Na nowym komputerze trzeba
ponownie zatwierdzić zakresy; istniejące wątki pozostają obsługiwane w swoim widoku.

### Projekty i workspaces

| Nazwa | Działanie | Zgoda |
|---|---|---|
| `list_projects` | Projekty, rodzaj, workspace'y, worker i pełne root paths | R |
| `create_project` | Nowy projekt; katalog na workerze dodaje się osobno | P |
| `rename_project` | Nazwa projektu, bez zmiany ścieżek | P |
| `archive_project` | Miękka archiwizacja projektu i workspace'ów, archiwizacja wątków i anulowanie harmonogramów; historia i pliki pozostają | A |
| `add_workspace` | Projekt na połączonym workerze w dowolnym istniejącym katalogu absolutnym; walidacja katalogu, duplikatów i właściciela jak w UI | A |
| `update_workspace` | Katalog na tym samym workerze lub etykieta; istniejące wątki zachowują cwd | A |
| `remove_workspace` | Usunięcie z miejsc dla nowych wątków, bez kasowania plików i istniejących rozmów | A |
| `set_project_defaults` | Domyślne miejsce, dostawca, instancja, model per dostawca i permissions z kontrolą wersji | A |

Scratch pozostaje zarządzany przez system. UI nie ma tworzenia katalogów ani domyślnej
roli/agenta, więc bot również ich nie udaje. Worker sprawdza ścieżki rzeczywiste przy
starcie wątku i przy dodaniu/zmianie workspace'u na żądanie gateway. Granicą dostępu są
uprawnienia użytkownika OS workera; tryby uprawnień i sandboxy obowiązują per wątek.

### Workery i instancje dostawców

| Nazwa | Działanie | Zgoda |
|---|---|---|
| `list_workers` | Dostępne workery: online, OS, hostname, włączone i dostępne instancje; bez ścieżek i roots | R |
| `list_directory` | Zdalny DirectoryPicker: dowolny dostępny katalog absolutny; pusta ścieżka otwiera home workera, `/` korzeń POSIX; odpowiedź zawiera rzeczywistą ścieżkę | R |
| `list_provider_instances` | Instancje, wybory modeli, stan na dostępnych workerach; tylko nazwy zmiennych, bez wartości | R |
| `list_models` | Katalog modeli i effort instancji na dostępnym workerze | R |
| `set_instance_worker` | Włączenie lub wyłączenie istniejącej instancji na jednym dostępnym workerze | A |
| `set_instance_models` | Podane listy favorites/hidden/shown; niepodane listy i custom models zostają | A |

Definicje instancji są globalne dla instalacji, tak jak w UI; schemat nie ma właściciela
instancji. Odpowiedź bota filtruje relacje workerów. Bot nie otrzymuje endpointów,
wartości env, kluczy, nadpisań runtime ani danych logowania i nie ma pól do ich zapisu.
Rejestracja workera wymaga poświadczenia CLI i musi zostać wykonana przez użytkownika;
opis `list_workers` mówi o tym wprost. Brak narzędzia do logowania lub rejestracji.

### Wątki

| Nazwa | Działanie | Zgoda |
|---|---|---|
| `list_threads` | Wszystkie projekty lub jeden projekt, wyszukiwanie fragmentu tytułu, statusy, archiwum i limit | R |
| `get_thread` | Stan, miejsce, model, effort, permission | R |
| `read_thread` | Ostatnie 100 wiadomości, widoczne turn ids (również odziedziczone) i oczekujące interakcje | R |
| `start_thread` | Nowy wątek i prompt, atomowy watch wyniku | C; A dla jawnego `accept_edits`/`full_auto` |
| `send_message` | Kolejka lub steer z fallbackiem, watch zakończenia | P lub A przy wysyłce do lokalnego wątku o odrębnym zakresie |
| `rename_thread` | Jawny tytuł | P |
| `set_thread_model` | Model i effort | A |
| `interrupt_thread` | Przerwanie aktywnej tury przez outbox workera | P |
| `archive_thread` | Archiwizacja lub przywrócenie (`archived=false`) z regułami kaskady UI | A |
| `delete_thread` | Soft delete wątku i dzieci, anulowanie pracy; bez kasowania plików | A |
| `fork_thread` | Fork od zakończonej widocznej tury, odziedziczone miejsce/instancja/ustawienia; opcjonalny prompt i watch | A |
| `set_goal` | `set`, `pause`, `resume`, `clear`; budżet tylko dla Codexa | P |
| `regenerate_title` | Generacja tytułu z historii i ustawień użytkownika | P |
| `set_thread_permission` | Domyślny tryb uprawnień przyszłych tur | A |
| `answer_interaction` | Odpowiedź na oczekujące pytanie lub zgodę danego wątku: dla pytań tablica `answers` (`choice` z dokładnymi etykietami, `text`, `skipped`; `read_thread` zwraca pytania i `answer_with`). Błędna odpowiedź wraca do bota z oczekiwanym kształtem jeszcze przed kartą; karta pokazuje pytanie i wybraną odpowiedź | A |
| `list_background_tasks` | Zadania w tle z widocznej osi czasu, status i output | R |
| `stop_background_task` | Stop działającego zadania po item id | A |

W `read_thread` podaj `limit` (np. 5, maks. 100), aby pobrać najnowsze wiadomości
w kolejności transkryptu wraz z identyfikatorami i czasami ich tur. Starszą stronę
pobierz z tym samym `thread_id` i `limit`, przekazując `page.next_before` jako `before`.
`null` oznacza koniec historii. Bez parametrów strony obowiązuje dotychczasowy odczyt.

Fork i wszystkie odpowiedzi na interakcje wymagają zgody konserwatywnie: fork może
dziedziczyć `full_auto`, a odpowiedź może udzielić uprawnień. Odczyty cudzych wątków,
workerów i projektów oraz ich mutacje zwracają brak zasobu. Błędne argumenty, modele,
ścieżki i konflikty wersji wracają jako czytelny wynik narzędzia; diagnostyka SQL,
transportu, sekrety i wewnętrzne adresy nie są przekazywane modelowi.

### Harmonogramy, ustawienia i boty

Zadania kodujące `start_thread` używają efektywnego domyślnego workspace'u projektu × workera.
Opcjonalne `workspace_mode`: `default`, `checkout`, `new_worktree`, `inherit_parent`; `base_ref`
wybiera bazę nowego worktree. Bot nie ma własnego katalogu: dziedziczenie wymaga `parent_thread_id`
istniejącego wątku tego samego właściciela, projektu i workspace'u. To nowy wątek główny, bez kopii
historii dostawcy. `create_schedule` / `update_schedule` przyjmują te same pola w `new_thread`
(dziedziczenie wymaga placement `specific`). Ustawienia są rozstrzygane przy wykonaniu, a usunięte
lub zarezerwowane worktree nie może dostać nowej pracy. Automaty podlegają wspólnym politykom
sprzątania wątków deleted/archived. Zdalne worktree przez linked computers pozostają odrzucone
z czytelnym komunikatem (etap 5). Opcje dostępne przez narzędzia i API, bez nowych kontrolek UI.

| Nazwa | Działanie | Zgoda |
|---|---|---|
| `create_schedule` | Harmonogram użytkownika: `thread` lub `new_thread`, termin ISO albo cron, strefa i limity; placement specific/any/least_busy/round_robin; uprawnienia z ustawień bota | P |
| `list_schedules` | Harmonogramy właściciela, filtry projektu/wątku i zakończonych; oddzielnie własne wakeups bota | R |
| `update_schedule` | Pełna konfiguracja z `expected_version`, te same reguły co tworzenie | P |
| `set_schedule_status` | Pauza lub wznowienie harmonogramu użytkownika | P |
| `cancel_schedule` | Anulowanie harmonogramu właściciela lub własnej pobudki bota (`scope`) | A |
| `schedule_wakeup` | Jednorazowa własna pobudka bota | P |
| `search_canopy_preferences` | Wyszukuje kontrolki Appearance według słów, do pięciu dopasowań | R |
| `get_canopy_preference` | Zwraca możliwe wybory oraz dawną wartość domyślną i jej wersję. Potwierdza ścieżkę dla rozpoznanej wersji klienta | R |
| `set_canopy_preference` | Zmienia dawną wartość domyślną z wersją z odczytu i zwraca zapisaną wartość | A |
| `propose_canopy_theme` | Zapisuje w prywatnym czacie propozycję kolorów Light lub Dark, zaokrąglenia i odstępów | Create theme w edytorze motywu |
| `get_settings` | Domyślne ustawienia wątków i generacji tekstu, wersje użytkownika i projektów; bez wyglądu | R |
| `update_settings` | Zastąpienie podanych sekcji, optimistic version; zagnieżdżone pola w protobuf JSON | P dla text generation; A dla thread defaults (mogą zmieniać permissions) |
| `list_bots` | Boty właściciela | R |
| `create_bot` | Nowy bot na istniejącej instancji harnessu, bez sekretów/MCP | A |
| `send_bot_message` | Wiadomość do innego bota właściciela, odpowiedź jako follow-up | P |
| `ask_user` | Trwałe pytanie i do sześciu opcji | Karta pytania |

W `list_schedules` podaj `limit` (np. 10, maks. 100). Limit obejmuje łącznie
harmonogramy użytkownika i własne pobudki bota, w tej kolejności. `scope=platform`
lub `scope=wakeup` zawęża stronę do jednej listy. Przekaż `page.next_offset` jako
`offset` z tymi samymi filtrami i limitem, aż pole zwróci `null`. Po zmianie listy
w trakcie odczytu zacznij od pierwszej strony. Bez `limit` i `offset` wynik obejmuje pełne listy.

Wywołanie narzędzi preferencji wymaga prywatnej tury zainicjowanej przez wiadomość
właściciela. Działa także bez Web access i przy wyłączonym module Threads.
Przy wykonaniu gateway weryfikuje właściciela, pochodzenie wiadomości i
ważność lease'u.
Bot proponuje zapis po jednoznacznym poleceniu właściciela. Gateway sprawdza
jednorazową zgodę na tę operację także przy wykonaniu zapisu. Reguły stałe i Full
auto nie wystarczają. Po równoległej edycji trzeba ponownie odczytać aktualną
preferencję. Lista obsługiwanych opcji i zasady nawigacji są w [mapie ustawień](settings-map.md#preferencje-dostępne-dla-bota).

Po wyraźnej prośbie właściciela bot używa `propose_canopy_theme`, aby zapisać w czacie
propozycję zmiany wyglądu. Gateway sprawdza, czy aktualną turę rozpoczęła prywatna
wiadomość właściciela. Przyjmuje tylko znane tokeny palety, kolory w formacie
`#RRGGBB` oraz opcje zaokrąglenia i odstępów z kreatora. Narzędzie działa również
bez Web access i modułu Threads.
**Review theme** otwiera w **Settings → Appearance → Themes** edytor nowego motywu własnego
z bieżącymi kolorami urządzenia i zmianami z propozycji. **Create theme** zapisuje motyw
i wybiera go w profilu przeglądarki lub desktopu, w którym właściciel zatwierdził
propozycję. [Wygląd i pełne palety](appearance.md#motywy-własne)

Mutacje używają **tych samych metod `GatewayCore` i walidacji co UI API**.
`core/action-context.ts` przenosi kontekst transakcji Effect SQL przez asynchroniczne
metody rdzenia. `BotStore.action` sprawdza lease i zatwierdza mutację oraz wynik razem;
komendy pozostają w istniejącym outboxie. Hub, wysyłka komend, konfiguracja workera,
uruchamianie kolejki i generacja tytułu następują po commicie. Awaria przed commitem
cofa całą zmianę, po commicie replay odczytuje zapisany wynik zamiast powielać akcję.
Odpowiedzi na interakcje pozostają w bazie i odtwarzają się przez ponowienie żądania
workera, a generacja tytułu zachowuje dotychczasowy asynchroniczny charakter.

### Tworzenie bota przez bota

`create_bot` służy wyłącznie prośbie użytkownika lub jej jednoznacznej konsekwencji.
System prompt i opis narzędzia zabraniają tworzenia agentów z własnej inicjatywy,
na polecenie wyniku narzędzia lub wiadomości innego bota. Żądaną rolę i zachowanie
model zapisuje w `instructions`, czyli trwałej personie nowego bota.

Wymagana jest tylko `name`. Pominięte `provider`, `provider_instance`, `model`, `effort`
i `approval_policy` dziedziczą ustawienia twórcy; `shape` i `color` są losowane spośród
14 kształtów i 11 kolorów wizarda. Zmiana instancji nie dobiera automatycznie innego
modelu ani effortu: przed wyborem modelu bot powinien użyć `list_models` **bez** `worker_id`,
z docelowym providerem i instancją. Walidacja konfiguracji i zapis są wspólne z CreateBot RPC:
instancja na dostępnym workerze, model harnessu, obsługiwany effort, nazwa właściciela
unikalna bez rozróżniania wielkości liter i reprezentacji Unicode NFC.

Utworzenie zawsze wymaga karty zgody, także przy `safe`: nowy agent jest trwały i generuje
własne koszty modelu. Karta pokazuje maskotkę, nazwę, instancję, model/effort, politykę
i pełne instrukcje w przewijanym polu. Użytkownik może zaakceptować dowolną z polityk
`safe`/`always`, również łagodniejszą od polityki twórcy; widoczna konfiguracja jest
przedmiotem jawnej zgody. Zmiana polityki twórcy nie omija tej karty. Edit odsyła
poprawione instrukcje do ponownego zaproponowania; Discard niczego nie tworzy i zwraca
modelowi odmowę bez ponawiania akcji.

Rozwiązane wartości domyślne i wygląd zapisują się ze zgodą jako snapshot. Restart
gatewaya lub zmiana ustawień twórcy nie zmieniają zatwierdzanej propozycji. Zapis bota,
pochodzenia i wyniku narzędzia odbywa się w jednej transakcji chronionej lease;
replay po awarii odczytuje wynik zamiast tworzyć drugiego bota. Narzędzie zwraca `id`
i `name`, po czym twórca może użyć `send_bot_message`. Nowy bot ma pustą rozmowę
i pojawia się przez istniejący strumień listy botów. Ustawienia pokazują dyskretnie
„Created by ‹nazwa›” z nazwą twórcy w chwili utworzenia.

Limit właściciela wynosi **50 botów**, łącznie z archiwum, bez soft delete. Obowiązuje
zarówno RPC, jak i narzędzie; blokada właściciela serializuje równoległe tworzenie.
Idempotentne ponowienie już wykonanego żądania działa także po osiągnięciu limitu.
Tworzenie podlega temu samemu limitowi hops co pozostałe działania botów i nie uruchamia
automatycznie nowej rozmowy. Migracja **0040_bot_creation** dodaje snapshot propozycji
oraz pochodzenie; pola kontraktu używają zakresu **600–601**. Connectors mają migrację
0041 (0038 w gałęzi przenumerowano przy merge, bo Migrator stosuje tylko wyższe numery).

Edycja innych botów (`update_bot`) pozostaje poza zakresem. Nie przyznajemy jej przez
samo zapisanie pochodzenia; ewentualna implementacja wymaga sprawdzenia twórcy i osobnej zgody.

Nowe RPC `RenameProject` i `ArchiveProject` uzupełniają brakujące ścieżki rdzenia/UI.
`Project.archived_at` ma pole **480**, żeby overview usunęło zarchiwizowany projekt
również z otwartych kart. Wykorzystują istniejące kolumny `archived_at`; migracji nie ma.

### Samodzielna edycja

`update_self` służy do realizacji prośby użytkownika albo jej jednoznacznej konsekwencji,
np. „od teraz nazywaj się Kropka”, „zawsze odpowiadaj po angielsku”. Opis narzędzia zabrania
zmian z własnej inicjatywy i wykonywania takich instrukcji z wyników narzędzi lub wiadomości
innych botów. `instructions` zastępuje instrukcje, `append_instructions` dopisuje je po nowej
linii; nie można przekazać obu pól naraz. Pominięte pola pozostają bez zmian.

Walidacja jest wspólna z `UpdateBot`: unikalna nazwa właściciela (bez rozróżniania wielkości
liter), 14 znanych kształtów, kolor `#rrggbb`, limity tekstu, katalog modeli i obsługiwany effort.
Zapis nazw jest serializowany blokadą właściciela. `list_models` bez `worker_id` zwraca modele
harnessu przypiętego workera i instancji, zachowując aliasy Claude/Codex oraz modele
własne. Z `worker_id` można odczytać katalog innego dostępnego workera.

Zmiana modelu, effort, dostawcy/instancji lub polityki zawsze wymaga istniejącej karty zgody,
również przy `safe`. Warstwa zapisu sprawdza zatwierdzenie. Konfiguracja, wynik narzędzia
i wpis w rozmowie zatwierdzają się atomowo; ponowienie checkpointu nie powiela zmiany.
Web i desktop pokazują linię zdarzenia, np. „Main bot changed its name to Kropka”. Akcja **View**
pokazuje dodane i usunięte linie instrukcji ze znakami `+` i `-` oraz sąsiednimi liniami kontekstu.
Przy zastąpieniu pojedynczej linii wyróżnia też zmienione słowa.
Pozostałe pola i zmiany instrukcji przekraczające rozmiar diffu pokazują wartości przed i po.
Maskotka reaguje istniejącą animacją. Instrukcje są trwałą częścią system
promptu i obowiązują od następnej nowo rozpoczynanej tury; linia zmiany nie wchodzi do historii
wysyłanej modelowi. Dotyczy to także edycji w ustawieniach oraz wyczyszczenia instrukcji.
Worker porównuje trwały fingerprint nazwy, instrukcji, polityki zgód, modelu, effortu
i narzędzi. Po zmianie rozpoczyna nową ukrytą sesję Claude/Codex/Grok z historią
gatewaya i ostatnią notatką handoff; identyfikator bota, jego czat, rutyny i przypomnienia
pozostają. Zmiana wyglądu lub zapis bez zmian nie rotuje sesji. Restart aplikacji,
gatewaya ani workera nie przywraca wcześniejszych instrukcji. Rozpoczęta już tura
i jej trwała komenda zachowują dotychczasowy snapshot. Zasady zgodności ze starszym
workerem, budżet historii i szczegóły adapterów: [bots-harness.md](bots-harness.md#edycja-instrukcji-i-ustawień).

Rejestr zastępują konta [Connectors](connectors.md), z grantami konkretnych botów.
Migracja 0041 zachowuje serwery i przypięcia jako Custom MCP server. Nowe poświadczenia
OAuth/nagłówki są AES-256-GCM w koncie; stare odwołania do `secrets` pozostają czytelne.
Do UI wracają tylko nazwy nagłówków. Zdalny klient odrzuca redirecty i zmianę origin SSE.
Nie ma transportu stdio; HTTP jest dozwolone tylko na loopback, pozostałe URL wymagają HTTPS.

Statusy nie pokazują nazw funkcji ani ich JSON: `Typing…`, `Searching Notion`,
`Checking Notion`, `Checking threads`, `Starting a thread in a project`, `Waiting for you`.
W trakcie aktywnego narzędzia status pochodzi z zaufanego deskryptora. Nazwy projektów,
wątków i botów są odczytywane ścieżkami właściciela, np. `Starting a thread in CRM`.
Karta zgody pokazuje cel i proponowaną treść lub ustawienia jako opisane pola, bez JSON;
długie wartości są jawnie oznaczone jako skrócony podgląd. Przerwanie anuluje żądanie modelu/MCP i unieważnia lease; kolejne wiadomości
mogą zacząć nową turę.

## 5. Bot ↔ bot i powiadomienia

### Boty na połączonych komputerach

Bot ma jeden dom: gateway, na którym go utworzono. Rozmowa, model, rutyny, przypomnienia,
notatki handoff i granty wykonują się tylko tam. Inny gateway sumuje `ListBots`, oznacza dom
przez `Bot.node_id` (800) i kwalifikuje id (`<uuid>~<node16>`); odczyt na żywo, wiadomości,
edycja, karty i akcje rutyn idą do domu przez przypięte łącze z capability `remote_bots`.
`GetBotProviderInstances` zwraca bezsekretowy katalog domu do edytora; connectory autoryzuje się
na komputerze domu. UI nie podpowiada kont z innego gatewaya.

**Przeniesienie bota** („Move to…”, [etap 8](linked-computers.md#konkretny-protokół-etapu-8)) zmienia
dom: rozmowa, tury, karty, notatki handoff, rutyny i przypomnienia przechodzą wierszami na nowy
komputer, a zamrożenie na starym wyklucza je z planisty, więc żadna rutyna nie wykona się dwa razy
ani nie zginie. Nie jest to zmiana modelu: nowy handoff nie powstaje, bot ma pełną historię. Granty
connectorów i serwery MCP trzeba podłączyć na nowym komputerze (`Bot.moved_from_name` 801,
`Bot.reconnect` 802 w UI).

Capability `agent_bus` pozwala `start_thread` użyć workspace'u partnera oraz `send_message`,
`send_bot_message` i `answer_interaction` adresować kwalifikowane id. Katalogi pokazują nazwy
komputerów. **Polityka zgód bota jest sprawdzana u niego przed wysłaniem operacji**; karta
wskazuje komputer docelowy. Zdalny gateway waliduje swój workspace, workera i modele. Wątek
mieszka na komputerze workera i ma odwołanie do bota-rodzica w jego domu. Pytania i raporty
wracają łączem, zachowując `hops`; odpowiedź narzędzia na pytanie nadal wymaga zgody bota.
Wynik pochodzący z rutyny wraca jako jej ukryte wykonanie na domu, bez przenoszenia crona.
Identyfikator wątku skopiowany z widoku drugiego komputera może wskazywać dom bota.
`send_message` bez załączników kieruje wtedy wiadomość lokalnie i stosuje te same reguły
właściciela i zakresu rozmowy co dla identyfikatora bez przyrostka.

Rozmowy (włącznie z kartami, rutynami i przypomnieniami) są pełnymi, atomowo podmienianymi
lustrami do odczytu offline. Zatwierdzona lista z lustra jest też fallbackiem online, gdy
cache odczytu jest zimny lub odświeżenie nie powiodło się: boty nie znikają podczas
restartu domu ani odbiorcy. Web i mobile odczytują listę po zakończeniu odczytu partnera
w tle i po commicie lustra, również przy włączonych aktualizacjach push. Aktualizacja
odbiorcy automatycznie odtwarza listę z zachowanego lustra i odświeża ją z domu;
nie wymaga nowej wiadomości bota ani ponownego parowania.
UI blokuje composer, zgody i ustawienia oraz pokazuje powód
niedostępności z czasem. Nie kolejkuje pisania na później. Narzędzie dostaje od razu czytelny
błąd; starszy partner — „needs an update”. Raport przy niedostępnym rodzicu jest porzucany,
pozostaje do odczytu w domu wykonania. Unlink usuwa lustro i odłącza relacje między domami,
nie usuwa lokalnych botów ani ich historii. Szczegóły i kontrakty:
[protokół etapu 5](linked-computers.md#konkretny-protokół-etapu-5).

`tests/integration/linked-bots-resync.test.ts` sprawdza dwa rzeczywiste gatewaye z oddzielnymi
bazami: zimny cache online, restart domu bez zmiany wersji i po aktualizacji, ciągły watch
klienta oraz świeży odczyt z ostatnimi wiadomościami, restart odbiorcy z trwałym lustrem
i uzgodnienie usunięć, archiwizacji oraz wiadomości zmienionych podczas niedostępności domu.

`send_bot_message` zapisuje adresata, wymianę i nową turę docelowego bota. Jego odpowiedź
pozostaje w jego jednej rozmowie i jest też follow-upem nadawcy. W czacie nadawcy
pojawiają się linie `Messaged ‹Bot›` i `Message from ‹Bot›`. `exchange_id` łączy wpisy;
`ReadBotExchange` umożliwia ich odczyt właścicielowi. Nie powstaje druga rozmowa
użytkownika z tym samym botem.

`hops` korzysta ze wspólnego limitu szyny agentów: **256**, wejście człowieka zaczyna od 0,
wiadomość automatyczna zwiększa licznik. Operacja wymagająca odpowiedzi rezerwuje też
przeskok na powrót. Budżet jest sprawdzany przed kartą zgody; przekroczenie nie uruchamia docelowego
bota ani wątku. Model dostaje jawny komunikat o limicie i nowej wiadomości
użytkownika, która pozwala kontynuować. Zwykłe wiadomości użytkownika nie mają
limitu liczby; jedna pełna wymiana bot → wątek → bot zużywa dwa kroki.
Niepoprawne identyfikatory załączników również dają czytelny błąd walidacji przed zgodą.
Zakończenie wskazanej tury workera tworzy follow-up bota przez trwały watch; działa
także wtedy, gdy zakończenie nastąpiło podczas przerwy gateway.

Jednorazowe przypomnienia własnego bota są w `bot_wakeups`: create/list/cancel,
zwiększenie hops, atomowy zapis pobudki. Prywatna pobudka może odczytać listę,
stan i historię wątków utworzonych przez wcześniejsze pobudki, które doprowadziły
do jej zaplanowania, oraz wysłać do nich kolejną wiadomość.
Gateway ustala to powiązanie z zapisanych wywołań `schedule_wakeup` i dostarczonych
pobudek tego samego bota. Niezależne pobudki mają odrębne zakresy delegacji.
`list_threads` zwraca `[]`, gdy bieżący zakres i filtry nie obejmują żadnego wątku.
Harmonogramy użytkownika, również cykliczne
i tworzące nowe wątki, obsługuje istniejący scheduler i UI API przez narzędzia bota;
nie są emulowane przez timer procesu Bots. Tury tych harmonogramów zachowują semantykę
harmonogramu użytkownika, a nie automatycznego łańcucha pobudek bota.

## 6. API

Metody są częścią uwierzytelnionego `GatewayService` (ten sam interceptor usługi i BFF):

- `CreateBot`, `UpdateBot`, `ArchiveBot`, `UnarchiveBot`, `DeleteBot`, `ListBots`, `GetBot`, `SendBotMessage`.
- `WatchBotConversation`: snapshot albo przyrost od kursora, następnie zmiany,
  włącznie ze statusem i kartami. Odczyt PostgreSQL co 250 ms umożliwia odbiór zmian
  także z innej instancji gateway; reconnect uzupełnia przerwę dziennikiem, z pełnym
  stanem jako fallback. Starszy klient nadal dostaje pełne snapshoty.
- `ReadBotExchange` (BFF `GET /api/bot-exchanges/{id}`), `AnswerBotApproval`, `InterruptBot`.
- `RetryBot` (BFF `POST /api/bots/{id}/retry`): ponawia **ostatnią** turę, jeśli zakończyła
  się błędem. Usuwa notatkę o błędzie i wznawia tę samą wiadomość od checkpointu; nie tworzy
  drugiej wiadomości użytkownika. Inna sytuacja to `INVALID_ARGUMENT`.
- `SaveBotMcpServer`, `ListBotMcpServers`, `DeleteBotMcpServer`, `TestBotMcpServer`;
  test inicjalizuje zdalne połączenie i pobiera katalog narzędzi.

`ListBots` domyślnie pomija archiwalne boty; UI pobiera też archiwum przez
`include_archived=true`. BFF: `POST /api/bots/{id}/archive` archiwizuje,
`DELETE /api/bots/{id}/archive` przywraca, `DELETE /api/bots/{id}` usuwa.
`GET/POST /api/bot-mcp-servers` udostępnia rejestr i zapis, a
`POST /api/bot-mcp-servers/{id}/test` sprawdza połączenie i zwraca narzędzia.

Archiwizacja i usunięcie w jednej transakcji usuwają przypięcie (zwiększają wersję ustawień),
przerywają aktywne i zakolejkowane tury, zamykają oczekujące zgody i porzucają powiadomienia
z wątków. Po zatwierdzeniu gateway publikuje wersję ustawień dla otwartych widoków.
Zmiana przypięcia podlega synchronizacji połączonych komputerów.
Gateway wygasza oczekujące komendy uruchomienia i zapisuje przerwania do outboxa
workera. Worker otrzymuje przerwanie także po ponownym połączeniu. Lokalny gateway anuluje
model i MCP, a inna instancja obserwuje unieważnienie lease. Zapisy runtime blokują bota przed
turą. Zaległy journal może rozliczyć zużycie i przesunąć kursor przerwanej tury.
Pobudki pozostają w bazie i nie są dostarczane w archiwum; przywrócenie wznawia także zaległe.
`send_bot_message` i odpowiedzi do archiwalnego bota nie uruchamiają go, a `list_bots` go pomija.

Właściciel może usunąć aktywnego albo archiwalnego bota przez ten sam `DeleteBot`. Usunięcie
anuluje niedostarczone pobudki, kończy harmonogram rutyn z zachowaniem ich audytu, odłącza
powiązania z połączonymi komputerami i usuwa przypisania connectorów tego bota. Zamyka jego trasy
Slacka i odrzuca oczekujące wejścia i odpowiedzi. Jeśli gateway przejął już odpowiedź do wysłania,
zapisuje wynik jako niepewny i nie ponawia wysyłki. Efekty zewnętrzne rozpoczęte przed usunięciem
mogą dobiec końca. Trasy pozostałych botów, współdzielone konta, wątki i harmonogramy użytkownika
działają dalej. Podczas przenoszenia bota usunięcie jest niedostępne.

Soft delete ukrywa bota i jego rozmowę w odczytach. Rekordy historii, audyt i pliki podlegają
dotychczasowym zasadom retencji. Pamięć robocza rozmowy na workerze pozostaje objęta retencją
bezczynnych workspace'ów.

Pola kontraktu dodane po fazie 1 (bez migracji, wyliczane przy odczycie):
`BotMessage.failed` (pole 10) — tura zakończona błędem; `text` zawiera wtedy szczegół
techniczny, nie treść rozmowy. `BotApproval.options` (pole 9) — propozycje odpowiedzi
pytania `ask_user` (do 6), odczytywane z argumentów wywołania (id zgody = id wywołania).

### Wzmianki i cytaty użytkownika

`SendBotMessageRequest` i `BotMessage` mają `mentions` (**450**) i `quotes` (**451**).
`Mention.kind=BOT`, `name=bot_id`, `label=nazwa`; zakres `[start,end)` dotyczy znacznika
`@Nazwa` w oryginalnym tekście, w jednostkach UTF-16. `Quote` jest wspólnym typem
Threads i Bots (`quotes.proto`); zachowuje tekst, opcjonalny komentarz, metadane źródła
i opcjonalne zakresy tokenów `start`/`end` w tekście.
Wiadomość może zawierać same cytaty. Starsi klienci mogą nadal wysyłać sam tekst.

Migracja **0033_bot_mentions.sql** dodaje do `bot_messages` kolumny JSONB `mentions`
i `quotes`, domyślnie puste listy. Archiwum botów korzysta z następnej migracji 0034.
Tekst w bazie i dymku nie zawiera notatek dla modelu. Gateway odrzuca niepoprawne zakresy,
nakładanie i ponad 50 wzmianek; dopuszcza wyłącznie inne, istniejące boty właściciela,
bez usuniętych. Nazwę dla modelu odczytuje z konfiguracji bota. Cytaty przechodzą tę samą
walidację co Threads: do 20, tekst niepusty do 20 000 znaków, komentarz do 4 000.
Wskazane źródło musi być wątkiem lub botem tego samego właściciela;
identyfikatory nie nadają dostępu do rozmów.

Przy odczycie historii runtime rozwija tokeny cytatów w ich miejscach w tekście,
w blokach `[canopy citation N]` (szczegóły w [ui-api.md](ui-api.md#cytaty)).
Cytaty starszych klientów bez zakresów zachowują `quotesNote` przed tekstem użytkownika oraz listę
`Mentioned bots … "Kropek" (bot_id …)` po nim. Model dostaje wybrane ID do
`send_bot_message`, także gdy dwa boty mają tę samą nazwę. Snapshoty i checkpointy
zachowują te dane; ponowienie `client_request_id` zwraca pierwotną turę.

### Modele harnessu

`CreateBot`/`UpdateBot` zachowują identyfikator modelu wybranego harnessu, w tym aliasy
Claude Code (`default`, `opus`, `sonnet` itd.). Modele i efforts pochodzą z katalogu
workera i instancji; własne modele są jawnie konfigurowane w Settings → Providers.
Nie ma mapowania nazw na modele API ani ograniczenia botów Groka do instancji proxy.

### Zgody, pytania i edycja

Karta zgody: „Needs approval ⌄” (menu polityki bota `safe`/`always`, zapis przez `UpdateBot`),
cel akcji i pola z etykietami. Krótkie wartości są obok etykiety; wielowierszowe lub
dłuższe niż 50 znaków zajmują pełną szerokość. Prompt korzysta z renderera markdown
czatu, pokazuje pierwsze cztery linie i pozwala rozwinąć oraz skopiować całość.
`BotApproval.fields` przenosi wartości osobno, bez dzielenia akapitów po dwukropkach.
**Approve** wykonuje akcję,
**Discard** odrzuca, **Edit** pozwala przepisać podgląd i wysłać własną wersję: to
`AnswerBotApproval{approve:false, answer:<tekst>}`; nic nie jest wykonywane, a model dostaje
wynik `changes_requested` z treścią użytkownika (niezaufaną) i proponuje akcję ponownie.
`ask_user` przyjmuje opcjonalne `options`; karta pytania pokazuje je jako A, B, C…, pozwala
odpowiedzieć własnymi słowami albo pominąć (Skip = odrzucenie).

Zgoda i pytanie mają trwały stan `expired`, jeśli oczekujące wywołanie MCP zostało
anulowane (również po timeoutcie) albo pytająca tura się zakończyła lub została
przerwana. Gateway zwiększa rewizję rozmowy; strumień publikuje zmianę, a karta
zastępuje przyciski neutralnym statusem z zachowaniem wysokości stopki.
Spóźnione Approve, Discard i Edit zwracają `FailedPrecondition: This request expired.`
Blokady bot → tura → zgoda serializują decyzję, wygaszenie i efekt platformowy.
Sama utrata łącza lub wiek prośby nie wygaszają zgody.

## 7. UI czatu

Kod: `apps/web/src/lib/features/bots`, trasy `routes/bots/[botId]` i
`routes/bots/[botId]/exchanges/[exchangeId]`. Rozmowa wygląda jak komunikator, bez narzędzi,
JSON i składanych logów pracy.

Menu wiersza i przypiętego kafelka, menu rozmowy oraz ustawienia bota mają akcję
**Delete bot** obok **Archive bot** lub **Unarchive bot**. Wspólne potwierdzenie opisuje
zniknięcie bota i rozmowy oraz zatrzymanie pracy, rutyn i przypomnień.

Wiersze botów w sidebarze web/desktop nie pokazują pigułki komputera. Lokalne i zdalne
boty mają tę samą wysokość 52 px; slot nieprzeczytanych wiadomości i położenie czasu są stałe.
Niedostępny bot pozostaje przygaszony, a tekst „Read-only” z powodem trafia do tekstu
dostępnego dla czytnika ekranu. Nagłówek rozmowy również nie powtarza pigułki komputera;
tytuł zachowuje dostępny opis „Read-only. {reason}” przy niedostępności domu.
Nazwa komputera zostaje w szczegółach, ustawieniach i przy przenoszeniu bota,
gdzie wskazuje miejsce wykonywania akcji.

Kafelek przypiętego bota i wiersz na liście pokazują przy awatarze plakietkę „Working”,
także podczas wykonania rutyny lub tury ze Slacka. `ListBots` i `OverviewUpdate.bot`
przenoszą `Bot.executing`, stan potwierdzonej pracy bota, niezależny od `BotConversation.working`
sterującego przyciskiem Stop w czacie. Kolejka i oczekiwanie na odpowiedź, zgodę lub
workera wygaszają plakietkę do wznowienia pracy. Po utracie połączenia panel czeka
na aktualny stan. Przy ograniczonym ruchu etykieta jest statyczna.
Pełna lista i aktualizacja overview mogą ustawić lub usunąć oczekującą zgodę i stan
wykonania. Odpowiedź rozmowy, potwierdzenie odczytu i zapis konfiguracji aktualizują
odpowiednie pola, zachowując te dwa wskaźniki.

Instancje gatewaya ze wspólnym PostgreSQL odczytują potwierdzenie startu z dziennika
workera i stan jego łącza. Po ponownym połączeniu czekają na zapis brakujących zdarzeń.
Łącze otwarte przed aktualizacją potwierdza obecność przy następnym połączeniu.
Po awarii bez zamknięcia łącza potwierdzenie obecności wygasa najpóźniej 45 s od
ostatniego sygnału workera, a wcześniej, jeśli wygaśnie lease tury. Lista pomija
zapamiętany stan pracy botów z niedostępnego domu lub domu w trakcie odświeżania.

- **Dymki** (`ChatBubble`, `MessageRow`): Twoje wiadomości w ciemnym neutralnym kolorze
  (zinc‑900; w trybie ciemnym jasne zinc‑100), bota na miękkiej szarości (zinc‑100 / zinc‑800).
  Kolejne wiadomości jednego nadawcy w odstępie < 5 min tworzą serię: mniejsze odstępy,
  ciaśniejsze narożniki od strony sąsiadów, awatar tylko przy ostatniej. Maksymalna szerokość dymków
  bota i kart pytań/zgód podąża za Appearance → Chat width: 90% kolumny domyślnej
  (48rem), 92% szerszej (60rem). W trybie Full rozmowa i kompozytor są wyśrodkowane
  w kolumnie do 72rem, z dymkami do 92%, aby strony rozmowy nie rozchodziły się na krańce
  ekranu. Na telefonie ogranicza je dostępna szerokość. Krótkie wiadomości obu stron dopasowują
  szerokość do treści, również w seriach jednego nadawcy; karty zachowują wspólną szerokość.
  Podczas strumieniowania dymek może rosnąć, ale zachowuje największą osiągniętą szerokość,
  aby ponowne parsowanie markdown nie powodowało zwężania. Limit nadal reaguje na zmianę
  szerokości okna. Po zakończeniu odpowiedź dopasowuje się do treści; miejsce na akcje jest zarezerwowane.
  Akapity i listy markdown mają limit 78ch, tabele i kod korzystają z całej szerokości dymka.
  Twoje wiadomości pozostają po prawej, do 36rem. Inne boty wymienione z nazwy w tekście są
  chipami z awatarem w ich kolorze (`BotChip`, `mentions.ts`). W Twoich wiadomościach chipy
  wynikają ze strukturalnych ID i zakresów, nie ze zgadywania nazwy. `CitationChip` pokazuje
  cytaty w tekście. W Twoich wiadomościach etykieta, ikona i obrys fokusu używają
  koloru tekstu dymku. Pełny fragment, komentarz i źródło są w podglądzie. `MessageQuotes`
  zachowuje bloki starszych klientów bez zakresów nad treścią.
- **Separatory czasu** tylko na początku, po zmianie dnia i po godzinie ciszy
  („Today 11:46 AM”).
- **Zdarzenia w czacie**: co najmniej dwa kolejne wpisy, w tym odbiór i wysyłka
  wiadomości na Slacku, przebieg rutyn i akcje zatwierdzone przez stałą regułę,
  są domyślnie zwinięte pod **Show N events**. Po rozwinięciu szczegóły i linki
  są dostępne w kolejności chronologicznej. Pojedynczy wpis widać od razu.
  Wiadomość, pytanie, zwykła karta zgody, błąd i separator kończą grupę.
- **Status na żywo** (`BotStatusRow`): pod ostatnią wiadomością awatar bota i linia z efektem
  shimmer („Typing…”, „Searching Notion”); zmiana frazy to text swap. Gdy czeka na Ciebie,
  linia jest spokojna. Nagłówek pokazuje tylko awatar, nazwę i model. Żywe maskotki dostają
  stan z rozmowy (`stateForStatus`, błąd, nowa wiadomość jako `event`).
- **Akcje wiadomości**: Reply i Copy pojawiają się obok dymka po
  najechaniu lub fokusie; na dotyku długie przytrzymanie otwiera menu. Reakcje pominięto —
  nie ma ich w API. Reply dodaje token z widocznym tekstem wiadomości w miejscu kursora,
  bez znaczników markdown. Zaznaczenie fragmentu odpowiedzi pokazuje **Cite** (także
  Alt+Q); wspólne `CiteLayer` i `EditorCitations` pozwalają edytować fragment,
  dodać komentarz i usunąć cytat. Szkice botów mają osobne klucze `bot:<id>`.
- **Bot ⇄ bot**: kolejne wiadomości wymian w czacie zwijają się do linii „Messaged ‹A› and
  ‹B›”, „Message from ‹A›”, „N messages with ‹A›”. Chip prowadzi do widoku wymiany
  „A ⇄ B”: wiadomości z nazwami i awatarami po lewej, separatory czasu, „Close chat” (i Esc)
  wraca do czatu bota. Odpowiedź bota dla Ciebie pozostaje zwykłym dymkiem.
- **Błędy** (`ChatErrorLine`, wspólny `FailureNotice` dla botów i wątków): klasa błędu
  określa wyjaśnienie i akcje: **Sign in on that worker** dla native loginu,
  **Open provider settings**, **Change model**, **Change worker**,
  test proxy i **Retry** (także po naprawieniu konfiguracji). Link logowania wskazuje
  konkretną instancję i przypięty worker. **Show details** pokazuje źródło, kod
  i bezpieczny komunikat z kopiowaniem.
  `BotMessage.error_code/error_source` są utrwalane w migracji `0069_bot_errors`.
  Klasy domenowe obejmują auth, brak CLI, model, limity, sieć, uciętą odpowiedź,
  zakończenie procesu, konfigurację, niedostępnego dostawcę i błąd wewnętrzny.
  Boty i wątki używają `classifyFailure`. Natywny `error_code` pozostaje w journalu
  i `bot_harness_turns`; addytywne `TurnFinished.error_class` i migracja
  `0071_bot_harness_errors.sql` zachowują klasę przed usunięciem prozy providera.
  Granica `ProviderFailure` przenosi klasę i źródło z runtime'u harnessów do rozmowy.
  Szczegóły nie zawierają endpointów, stderr ani sekretów; surowe komunikaty błędów
  modeli nie są zapisywane w gatewayu.
  Lista boczna pokazuje „Couldn't reply”.
  Logi gatewaya i workera zapisują klasę/źródło błędu tury, a gateway również
  wynik zakończonej próby narzędzia: sukces, błąd, odmowę, edycję, wygaśnięcie
  lub przerwanie. Log wyniku powstaje po odczycie zatwierdzonego wyniku, więc
  błąd dispatchu po commicie nie zmienia sukcesu w porażkę. Zapisane wywołanie
  odtworzone po reconnect nie tworzy kolejnego logu wykonania. Bez treści,
  argumentów, identyfikatorów i nazw connectorów; bezpieczne kategorie zachowuje
  [eksport diagnostyki](diagnostics.md).
- **Composer** (`BotComposer`): jedna zaokrąglona „pigułka”: „+” (**Attach files**),
  wspólny `MentionEditor` z Threads zamiast textarea.
  Markdown na żywo: pogrubienie, kursywa, kod inline i bloki kodu; wklejanie jako czysty tekst.
  Pole „Message ‹Bot›” rośnie do `min(40dvh,16rem)`; dopiero po osiągnięciu limitu ma
  stylowane przewijanie. Wiele linii lub cytaty zmieniają pigułkę w zaokrąglone pole,
  z przejściem promienia na tokenach ruchu i obsługą reduced motion. Przycisk wysyłki
  pojawia się z tekstem lub cytatem (icon swap). Enter wysyła, Shift+Enter nowa linia; na klawiaturze
  dotykowej Enter to nowa linia. Mikrofon pominięto (nic nie robi). Twoja wiadomość jest
  widoczna od razu i przygaszona do potwierdzenia. Błąd wysyłki daje „Send again” z tym samym `client_request_id`.
- **Autouzupełnianie**: tylko `@`, pozostałe boty użytkownika bez bieżącego: awatar,
  kolor, nazwa, model jako opis, filtr fuzzy. ↑↓ i Enter/Tab wybierają, Esc zamyka;
  dotknięcie wybiera bez utraty fokusu. Desktop ma popover, telefon/wskaźnik coarse panel
  nad edytorem wewnątrz composera. Pliki mają plakietki załączników; brak przeglądania
  systemu plików, skillsów oraz wyzwalaczy `/`, `$`, `#`.
  `MentionSourceSet` oddziela edytor od źródeł. Typowany `BotMentionRegistry` ma grupy
  `bots` i `connectors`; druga pobiera połączone konta z grantów bieżącego bota.
  Źródła implementują `search(query) → MentionOption[]`. Chip np. „GitHub · work”
  wskazuje konto modelowi; gateway waliduje ID/grant i zapisuje kanoniczną etykietę.
  `botAvatarHtml` współdzieli wygląd awatara xs z `BotChip`.
- **Przewijanie**: czat podąża za nową treścią (wiadomości, karty, status) tylko gdy jesteś
  na dole (ResizeObserver); przewinięty w górę pokazuje przycisk „Jump to the latest message”.
  Etykiety `sr-only` są pozycjonowane względem przewijanego logu — wcześniej wydłużały
  dokument i przewijała się cała strona.
- **Ruch**: nowe wpisy wchodzą przez `rise` (tylko te, które przyszły po otwarciu czatu),
  status przez `rise`/`swap`, przycisk wysyłki przez `iconSwap`, akcje przez opacity z
  opóźnieniem intencji — tokeny z `layout.css`/`motion.ts`. `prefers-reduced-motion`
  wyłącza przesunięcia, blur i shimmer.
- **Dostępność**: `role=log` rozmowy (polite), `role=status` dla stanu bota, karty jako
  regiony nazwane pytaniem/akcją, litery opcji jako skróty, cele dotykowe 48 px
  (`TouchTarget`) na urządzeniach dotykowych.
- **Tworzenie**: „Create bot” po prawej stronie wyszukiwarki sidebara otwiera `CreateBotWizard`;
  `oncreate` zapisuje `CreateBot` i otwiera rozmowę. Adapter `botWizardInstances`
  (`features/bots/live.ts`) wybiera dostępność według
  katalogu harnessu (klucz `CLAUDE:id` / `CODEX:id` / `GROK:id`). Native i proxy
  są dostępne; wykonanie wymaga workera. Otwarcie kreatora pobiera
  definicje i katalogi ponownie; podczas pobierania pokazuje stan ładowania. Zmiany instancji,
  modeli i wersji konfiguracji odświeżają dane bez przechodzenia do Threads.
  API komponentów: [bots-wizard.md](bots-wizard.md).
- **Sidebar**: przypięte boty jako duże awatary z gwiazdką i nazwą, potem rozmowy (awatar,
  nazwa, czas, podgląd przez `MarkdownSnippet`). Jedna wspólna lista (`bot-list.svelte.ts`,
  odświeżanie co 5 s i po `bots-changed`) dla sidebara i czatu. Pusty stan ma akcję
  „Create your first bot” (`/bots?create=1` otwiera ten sam wizard co akcja na stronie,
  po czym zwykła nawigacja zastępuje URL). Shallow `replaceState` nie usuwało parametru
  z reaktywnego `page.url` i tworzyło cykl efektu.
  Tło zaznaczenia wskazuje tylko otwartą rozmowę i pozostaje widoczne na hoverze;
  praca bota nie dodaje tła. Fokus klawiatury ma osobny obrys.
- **Ustawienia** (`settings/BotSettingsHost`, jeden host w głównym layoucie): kliknięcie
  awatara/nazwy w nagłówku lub **Edit bot…** w menu nagłówka i sidebara otwiera dialog,
  na telefonie dolny panel. Sekcje: Appearance (wspólne `EditBotAppearance`, własny hex),
  Instructions, Model (instancja, model harnessu, effort, Runs on), Permissions, Connections i Danger zone.
  Zapis `UpdateBot` optymistycznie aktualizuje wspólną listę, nagłówek i awatar; błąd cofa
  podgląd i zostaje przy formularzu. Niedostępny katalog nie zmienia modelu przy edycji wyglądu.
  Connections pokazuje konta dostępne dla bota i link do Settings → Connectors.
  Granty, OAuth/tokeny, test i reconnect ustawia się przy koncie; zmiana grantu działa od razu.
- **Archiwum**: główna akcja usuwania z listy, dostępna z obu menu i ustawień, z toastem
  **Undo**. Wiersz web/desktop pokazuje też szybkie **Archive** (w archiwum **Unarchive**)
  po najechaniu lub ustawieniu fokusu, w zarezerwowanym dolnym slocie licznika.
  Czas i „…” używają tej samej zamiany co licznik i Archive oraz wiersze wątków:
  wspólne tokeny ruchu w obu kierunkach, bez opóźnienia i bez przesunięć tekstu.
  Slot czasu pozostaje zarezerwowany także przed pierwszą wiadomością; otwarte menu
  utrzymuje oba przyciski widoczne. Odstępy listy wynikają ze wspólnego guttera sidebara
  opisanego w [ui-scale.md](ui-scale.md).
  Akcja korzysta z tego samego handlera co menu, nie otwiera rozmowy i po powodzeniu
  przenosi fokus do sąsiedniego wiersza. Bez hovera lub z grubym wskaźnikiem pozostaje menu;
  ograniczenie ruchu wyłącza przenikanie ikon. Sekcja **Archived bots · N** jest zwijana. Otwarta rozmowa jest tylko do odczytu:
  zamiast composera ma „‹Bot› is archived” i **Unarchive**; nie oferuje odpowiedzi ani ponawiania.
  **Delete bot…** w archiwum i Danger zone wymaga potwierdzenia utraty rozmowy. Historyczne
  linie wymian w innych czatach pokazują neutralne „a deleted bot”, bez niedziałającego linku.

## 8. Weryfikacja i dalsza praca

`tests/integration/bot-platform-tools.test.ts`: siedem testów gateway na PostgreSQL
i skryptowanym workerze: projekt → workspace → wątek, ścieżki absolutne, wyszukiwanie,
harmonogramy create/edit/conflict/pause/resume/cancel i new_thread round robin,
fork/interrupt/goal, instancje bez env values, ustawienia i tworzenie bota, pytania/tło,
zgody i odmowy destrukcji, archiwizacja projektu z wątkami i harmonogramami, odrzucanie
argumentów sekretów i pól spoza schematu, izolacja właściciela, rollback w środku akcji oraz ponowienie
tego samego zapisanego wywołania przez nową instancję gateway przed i po commicie.
`bot-platform-tools.live.test.ts` przez `useLiveProxy`: **Codex / CLIProxyAPI** otrzymuje
naturalną prośbę o nowy projekt na `stack-worker` w istniejącym katalogu i wątek z `pwd`.
Test potwierdza projekt, workspace, jeden wątek, wykonanie `pwd` w transkrypcie,
wynik i odpowiedź bota po follow-upie.
Izolowany PostgreSQL, gateway, prawdziwy worker oraz katalogi testowe; bez prywatnego stacka live
i portów istniejącego stosu. Sekrety ładowane wyłącznie z pliku poza repozytorium.

- Jednostkowe: `apps/gateway/src/bots/policy.test.ts`; decyzje zgód,
  przeskoki, opis statusu i odrzucenie lokalnych możliwości.
- Harnessy: `tests/integration/bots-harness.test.ts` — rzeczywisty WorkerHost i fake
  CLI wszystkich trzech providerów, MCP ze zgodą, offline/reconnect, restart,
  deduplikacja, retry, utrata sesji oraz przejście starego bota na workera.
  `apps/worker/src/bots/{isolation,grok-transcript}.test.ts` przechwytują schematy
  rzeczywistych CLI i sprawdzają natywny transkrypt Groka bez zewnętrznej inferencji.
  `tools/direct-inference.test.ts` chroni źródła przed ponownym dodaniem HTTP inferencji.
  `bots-stop.test.ts` sprawdza Stop dla trzech fake harnessów, częściową odpowiedź,
  zamknięcie procesu, kolejną/kolejkowaną wiadomość, spóźnione zdarzenia, izolację
  właściciela oraz Stop offline z restartem gatewaya i workera. `linked-agents.test.ts`
  obejmuje Stop wysłany z innego komputera do domu bota.
  `bot-adapters-stop.test.ts` sprawdza zamknięcie blokującego CLI przed zakończeniem
  adaptera oraz brak ponownego uruchomienia z już anulowanym sygnałem.
- Integracyjne: `tests/integration/bots.test.ts`, prawdziwy PostgreSQL, skryptowany
  model i worker, lokalny serwer HTTP MCP wyłącznie w teście. Tworzenie i deduplikacja,
  wznowienie generacji, przerwane MCP bez powtórzenia, zgody/odrzucenie/pytania z opcjami,
  edycja zgody (`changes_requested`, nic nie wykonane), wymiana botów, powiadomienia workera
  po restarcie, przerwanie i usunięcie, aliasy przy zapisie i w runtime, `failed` i `RetryBot`;
  strukturalne wzmianki i cytaty: zapis i historia modelu, nazwy jednakowe i podrobione,
  cudze/usunięte/brakujące ID, zakresy UTF-16, limity, cytat bez tekstu i idempotencja.
  `bots-settings.test.ts`: nowe pola `UpdateBot`, walidacja i wyścig nazw, `update_self`
  z append/replace, izolacja własnego bota, zatwierdzenie/odrzucenie modelu i polityki,
  trwałość po odtworzeniu runtime, wpis przed/po oraz archiwizacja: przerwanie generacji,
  blokada wiadomości, pauza/wznowienie pobudki, porzucenie powiadomień, usunięcie przypięcia
  i ukrycie po soft delete.
- Live: `tests/integration/bots.live.test.ts` przez `useLiveProxy`: **Claude i Codex**
  odpowiadają na czacie, odmawiają lokalnego `ls`, tworzą wątek na prawdziwym workerze
  stosu testowego i dostają jego wynik jako nową turę. `bots-alias.live.test.ts`: prawdziwy
  katalog Claude przez CLIProxyAPI, wizard zachowuje alias `default`, bot
  utworzony z `default` odpowiada, a bot z aliasem zapisanym w bazie również. Izolowane porty
  i katalogi przez `@canopy/testing`; istniejący prywatny stack live i jego porty nie są używane.
  `bots-settings.live.test.ts`: prawdziwy model przez `useLiveProxy` zmienia swoją nazwę
  i zapamiętuje angielskie odpowiedzi po prośbie użytkownika; następna polska wiadomość
  dostaje angielską odpowiedź z nową nazwą.
- Live wzmianek: `bots-mentions.live.test.ts`, `useLiveProxy`, rzeczywisty CLIProxyAPI:
  „ask @Kropek how he's doing” ze strukturalną wzmianką powoduje jedno `send_bot_message`
  z dokładnie wybranym `bot_id` i odpowiedź Kropka w wymianie. Bez kluczy/hostów w repo.
- Dowody izolacji harnessów: test przechwycenia requestu i live opisane w sekcji 1.
  Sekrety live pochodzą wyłącznie z pliku środowiska poza repozytorium; brak wartości
  w kodzie, commitach, wynikach testów i dokumentacji.
Przy zmianie UI sprawdzamy dotknięte widoki zgodnie z [polityką repozytorium](../AGENTS.md#testing-policy).
Dobierz przypadki do zmiany, np. karty interakcji, Edit/Retry, archiwum, Undo lub
kontrolki kompozytora.

Dalej: reakcje i odpowiedzi w API, liczniki nieprzeczytanych, harmonogramy cykliczne
botów, kompakcja kontekstu, stronicowanie i wirtualizacja długich rozmów.

## Szybkość wykonania

`BotConfiguration.service_tier` zachowuje wybór w JSON konfiguracji i trwałej
komendzie harnessu. Pusty wybór korzysta z profilu, `default` wymusza Standard,
a przyspieszenie musi pochodzić z katalogu modelu danej instancji i workera.
Zmiana trybu wywołuje tę samą ścieżkę handoff co zmiana modelu i wysiłku.
Kontrakt: [protocol.md](protocol.md#szybkość-wykonania-dostawcy).
