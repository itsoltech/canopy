# Aktualizacje Canopy

Aktualizacja (2026-11-24): instalator workera obsługuje macOS Intel. Feed Desktop dla macOS obejmuje ZIP-y x64 i arm64.

Status: opis zaimplementowanego kodu (2026-11-25), w tym kolejkowania tur od przyjęcia aktualizacji
gatewaya, przekazania nadzoru gatewaya przed obsługą klientów i workerów oraz diagnostyki przerwanych aktualizacji
desktopu, kompaktowego powiadomienia po aktualizacji, raportowania startu i zamykania gatewaya oraz etapów przygotowania,
pobierania i ponownego łączenia workera,
przekazania nadzoru workera
przed obsługą wątków po aktualizacji, zbiorczego sprawdzania sesji zamkniętych wątków
po powrocie workera, ograniczenia kanału Nightly
do wydań nightly, sprawdzania historii commitów aktualizacji desktopu i zmiany kanału binarek,
osobnych aktualizacji Canopy i CLI dostawców, wspólnego planu dla licznika i przycisku
Update all na telefonie, wygaszania mobilnego komunikatu o restarcie po potwierdzeniu
wersji docelowej lub gotowości binarnego gatewaya po zapowiedzi bez wersji docelowej,
statusu aplikacji desktopowej w mobilnym wierszu jej workera,
pomijania komputerów offline w Update all,
wspólnej obsługi paneli Usage, Workers, Updates i Provider usage w stopce, równoległej aktualizacji
zdalnych desktopów i workerów binarnych, ponawiania raportu o błędzie workera,
aktualizacji CLI przez mise, restartu workera mimo błędu sprzątania urządzeń,
pomijania cache metadanych przy ręcznym sprawdzaniu aktualizacji, wykrywania
pojedynczego procesu przez instalator Windows, retencji dyskowego mirrora workerów
gatewaya, automatycznego pobierania OTA przez działającą aplikację mobilną
oraz powiązania adresu manifestu z oficjalnym repozytorium i tagiem wydania.
Dostępność zmian w nightly, beta i stable wynika z promocji
opisanych w [release.md](release.md), a konkretne wersje podają GitHub Releases.

Nazwa widoczna i ikona desktopu oznaczają kanał **zainstalowanego buildu**:
`Canopy (Nightly)`, `Canopy (Beta)` albo `Canopy`. Wybór kanału aktualizacji sam
ich nie zmienia; nowa tożsamość pojawia się po instalacji i restarcie. Wszystkie
kanały zachowują tę samą instalację, `app.canopy.desktop`, `canopy://`, userData,
wewnętrzną nazwę magazynu kluczy i cache updatera. Szczegóły pól OS:
[desktop.md](desktop.md#jedna-instalacja-i-kanały). Web oznacza wersję aktualnie
podłączonego gatewaya. Na telefonie nazwa i ikona wymagają nowego IPA/APK;
aktualizacja OTA ich nie zastępuje ([mobile.md](mobile.md)).

Aktualizacja lub restart obu połączonych komputerów zachowuje zapisane piny, certyfikaty
i klucze. Reinstalacja zachowująca katalog danych też nie wymaga parowania. Przejściowa
odmowa autoryzacji jest ponawiana jak niedostępność; nie dowodzi zmiany tożsamości.
Potwierdzony inny certyfikat wymaga jawnego parowania, a powrót starej przypiętej
tożsamości sam usuwa nieaktualne ostrzeżenie. Szczegóły: [tożsamość i certyfikaty](linked-computers.md#tożsamość-i-certyfikaty).

## Zapowiedziana przerwa gatewaya

`WatchOverview` wysyła `gateway_departure` przed aktualizacją i restartem, także
telefonowi, który sam nie zlecił operacji. Sygnał zawiera id próby, `updating` lub
`restarting`, wersję początkową i docelową (jeżeli jest znana), czas rozpoczęcia
oraz pięciominutowe okno. Połączone komputery dostają ten sam rekord w `Presence`;
stan `restarting` zachowuje fallback `updating` dla starszych partnerów.

Checkpoint w prywatnym `user_settings.settings.gatewayDeparture` nie zmienia
wersji edytowalnych ustawień. Po starcie gateway potwierdza uruchomioną wersję,
odczytuje istniejący journal updatera i zapisuje `succeeded`, `failed` albo
`rolled_back` z przyczyną. `GetUpdates.departure` i pierwsza wiadomość kolejnego
overview odtwarzają wynik; raport lokalnej aplikacji desktopowej korzysta z tego
samego checkpointu. Stan partnera jest kwalifikowany jego `node_id`.
Po zapowiedzi restartu bez wersji docelowej telefon może usunąć ją również na podstawie
bieżącego stanu `idle` lub `succeeded` samodzielnego binarnego gatewaya. Zapowiedź
pozostaje aktywna podczas startu i zamykania, dopóki gateway nie zgłosi wyniku.

Lokalny kontroler desktopu przekazuje docelową wersję również przy zwykłym
„Restart to update”. Restart zdrowia ogłasza `restarting`, o ile gateway nadal
obsługuje RPC. Gateway całkowicie nieodpowiadający nie może rozesłać sygnału;
klienci stosują wtedy zwykłe odzyskiwanie połączenia. Nie zmieniamy
`canopy.update.v1` ani `WORKER_LINK_PROTOCOL`.

Telefon zapisuje ogłoszenie w istniejącym SecureStore parowania. Przez ogłoszone
okno (maksymalnie pięć minut) próbuje ostatniej działającej trasy z zachowaniem
pinu, bez równoległego wyboru innych adresów. Strumienie na pierwszym planie
ponawiają subskrypcję co 2,5 s zamiast narastającego backoffu; tło i brak sieci
nadal zatrzymują próby. Po wygaśnięciu wracają zwykła selekcja tras i komunikaty
o niedostępności. Ogłoszenie partnera nie zmienia trasy telefonu. Raz wysłane RPC
nie jest automatycznie odtwarzane. Jeśli `GetUpdates` potwierdzi uruchomienie
docelowej wersji przed rozliczeniem checkpointu, telefon zamyka próbę na podstawie
wersji. Po powrocie telefon pokazuje wynik przez 15 s od jego odebrania, wraz
z wersją i dostępem do szczegółów. Odczyt ani zmiana ekranu nie wznawiają tego
czasu. Starszy gateway bez sygnału działa jak wcześniej.

### Gotowość aktualizatora gatewaya

Odczyt `GetUpdates` może działać wcześniej niż sterowanie aktualizacjami. Pole
`gateway_state` podaje wtedy `starting` aż do zakończenia kontroli po uruchomieniu
i odzyskania stanu aktualizatora. Od rozpoczęcia zamykania, także podczas restartu,
podaje `shutting_down` do zamknięcia połączeń. Te stany mają pierwszeństwo przed wynikiem
zapisanego przebiegu. Centrum odświeża odczyt automatycznie i w tym czasie wstrzymuje akcje
aktualizacji. Żądanie odrzucone w chwili zmiany stanu powoduje odświeżenie bez ponowienia
instalacji. Poza tym oknem wiersz pokazuje rzeczywisty etap wybranej aktualizacji.
`gateway_target_version` to wybrany cel instalacji, a `available_version` to wynik
sprawdzenia wydań. W spoczynku strzałka wersji wymaga nowszego dostępnego wydania.

## Wskaźnik w pasku bocznym

Aplikacja iOS/Android ma ten sam punkt wejścia: trzecią ikonę stopki paska bocznego.
Kropka oznacza dostępne aktualizacje lub trwającą operację. Dolny panel pokazuje
gateway albo aplikację komputera, połączone komputery, przypisane do nich workery
oraz stan OTA telefonu. `Update all` aktualizuje Canopy na dostępnych komputerach.
Instalację i aktualizację CLI użytkownik zleca osobno w ustawieniach. Indywidualne akcje korzystają
z istniejących API sprawdzających właściciela. Gateway ogłasza zmiany centrum przez
`OverviewUpdate.updates_changed` (829): stan i sprawdzenia aktualizatora oraz raporty aktualizacji
workerów, zebrane w paczki po 250 ms; zmiana połączonego komputera odświeża od razu jego
snapshot tutaj, a zakończony odczyt (`linked_read_completed` GetComputerUpdates) informuje klientów.
Klient czyta GetUpdates po takim zdarzeniu, `desktop_update`, `gateway_departure`, zmianie obecności
komputera lub wersji/CLI workera; co 2–2,5 s tylko w trakcie aktualizacji. Gateway bez `updates`
w `feeds` (starszy) dostaje jeden odczyt na minutę na pierwszym planie; ukryta karta nic nie czyta.
Ostatni wynik pozostaje widoczny w czasie restartu. Błędy mają szczegóły z kopiowaniem.
Niepowodzenie zdalnego żądania przestaje być bieżącym błędem, gdy aplikacja zgłosi
wersję SemVer co najmniej równą celowi albo zakończone sprawdzenie „Up to date”.
Nie dotyczy to początkowego `idle`, trwającego sprawdzenia, wstrzymania z powodu
limitu ani nieukończonej publikacji. Taki wynik aktualizuje journal aplikacji,
rekord `desktop_updates`, checkpoint przerwy i zapisany `updateRun`; nie pozostawia
czerwonego nagłówka ani odznaki. Restart do wersji docelowej lub nowszej jest
sukcesem również wtedy, gdy ostatni zapis poprzedzał fazę `restarting`.
Powrót na starszej wersji zachowuje błąd; brak powrotu nadal podlega limitowi kroku.

Aktualny błąd ma akcje ponowienia i **Dismiss**, a pozostałe pozycje pozostają
dostępne. Odrzucenie wymaga id bieżącego żądania albo przebiegu i jest ograniczone
do właściciela. Klienci przekazują id otrzymane w snapshotach bez zmian. Dla aplikacji
bezpośrednio połączonego komputera gateway przyjmuje także UUID bez sufiksu:
wiąże go z jawnie wybranym komputerem tego właściciela. Id z sufiksem innego
komputera jest odrzucane; cel nadal wymaga zgodności z bieżącym błędem.
Dla własnej aplikacji potwierdzenie jest zapisane w prywatnym
`user_settings.settings.appUpdateDismissal` przed przekazaniem do journala;
dla sparowanego zdalnego desktopu przechowuje je `desktop_updates.command`.
Zatrzymany przebieg ponownie porównuje cele ze snapshotem, także po restarcie
gatewaya. Po usunięciu nieaktualnego błędu ma `succeeded`, jeśli wszystkie kroki
są wykonane, albo `superseded`, jeśli późniejsze kroki nadal czekają. Odrzucony
przebieg ma `dismissed`; jego akcja odrzuca także błąd tego samego żądania aplikacji,
jeśli nadal jest bieżący. Żadna z tych zmian nie uruchamia kolejnych instalacji.
Klienci ignorują odczyt rozpoczęty przed nowszą akcją, aby stary cache nie
przywracał odrzuconego błędu.
Zmiana telefonu dotyczy wyłącznie JS/TS i nie wymaga nowego runtime ani builda EAS.

Ikona Updates w stopce pokazuje aktualizacje
własnej aplikacji desktopowej: stan spokojny, sprawdzanie, pobieranie z procentem
oraz gotowość do restartu. Hover i klik otwierają ten sam przewijany popover;
na telefonie jest to dolny panel. Updates dzieli miejsce w stopce z panelami Usage, Workers i Provider usage.
Przejście kursorem na sąsiedni wyzwalacz od razu zastępuje panel otwarty najechaniem.
Po wyjściu kursora poza wyzwalacz i panel zamknięcie ma 250 ms zwłoki, aby dało się
przejść do treści przez odstęp. Aktywacja przycisku przypina jego panel i ma
pierwszeństwo przed najechaniem. Animacja respektuje ograniczenie ruchu.
Klient podłączony do gatewaya desktopowego pokazuje aplikację z jej raportu;
gateway serwerowy nadal ma wyłącznie wiersz gatewaya.

Telefon, web i zdalny tryb Electron pokazują nazwę podłączonego komputera oraz te same
akcje i stany aplikacji co dla partnerów. `UpdatesSnapshot.app_update_supported`
potwierdza obsługę żądań przez gateway i capability `DesktopHello.remote_update`
ostatnio podłączonego desktopu; brak pola ze starszego gatewaya wyłącza akcję. Starszy desktop
pokazuje „Update this computer from its own window once to enable remote updates.”.
Stan własnego updatera, powody odmowy i wynik journalu pozostają w `app`.

Akcja `ManageUpdates.app` wymaga `confirm_restart=true`, roli `desktop` i istniejącego,
aktywnego kanału aplikacji. Uwierzytelniony właściciel telefonu albo BFF zleca ją
przez ten sam `LocalAppControl` i `RemoteAppUpdate` co połączony komputer; nie uzyskuje
dostępu do `WatchAppControl` ani `ReportAppControl`. Gateway odrzuca force, downgrade
i wybór innego celu. Audyt zachowuje id żądania oraz id urządzenia, jeśli ono zleca akcję.
Oba interfejsy pytają przed instalacją: komputer restartuje się po zakończeniu pracy,
a klient automatycznie odzyskuje połączenie. Potwierdzenie pokazuje znane aktywne tury
workera desktopu. Niewysłany tekst, pliki, cytaty, edycja kolejki lub sekret w tym kliencie
blokują żądanie; sprawdzenie powtarza się bezpośrednio przed wysłaniem.
Raporty, otwarcie i zamknięcie kanału aplikacji ogłaszają `updates_changed`.
`Update all` obejmuje własną aplikację, jeśli ma aktualizację. Przed zapisaniem
przebiegu wymaga `confirm_restart=true` i tego samego potwierdzenia oraz ochrony
szkiców co pojedyncza akcja. Po restarcie domu gateway wznawia zapisany przebieg
i potwierdza wynik aktualizacji. Dołączony gateway i worker aktualizują się razem z aplikacją.
Serwerowy gateway zachowuje własny updater.
Na telefonie potwierdzenie otwiera się nad arkuszem Updates, który zostaje otwarty;
do odpowiedzi gatewaya arkusz pokazuje „Starting update…”, a potem postęp, wynik albo błąd.

### Popover aktualizacji

Popover ma 352 px szerokości i wysokość zależną od zawartości (maksymalnie
70% okna / 512 px); przewija się lista między nagłówkiem a stopką.

**Jedno podsumowanie.** Nagłówek ma tytuł, jedną linię stanu i Check now. Linia mówi,
co użytkownik właśnie uruchomił („Starting update…”), a w trakcie przebiegu podaje
jeden licznik „Updating · N of M done” (M obejmuje wszystkie zaplanowane kroki, także
oczekujące; „· K failed” tylko przy błędach). Po przebiegu: „K update(s) failed ·
N updated” albo przez godzinę „All N updates finished”; w spoczynku „N updates
available” lub „Up to date · Checked 5:39 PM”. Dolna linia nagłówka jest paskiem
postępu przebiegu (2 px), więc nie zajmuje miejsca. Popover nie ma osobnego bloku
postępu, listy aktywnych kroków ani „Update results”; historia kroków z powodami jest
w Settings → Workers → Updates. Licznik i słownictwo pochodzą z
`@canopy/domain/release/update-status`, wspólnego dla web i telefonu.

**Wiersze.** Każdy wiersz ma zawsze dwie linie: nazwę z odznaką oraz wersje albo
zdanie, które mówi więcej (np. „Restarting to update…”). Odznaka ma slot o minimalnej
szerokości, w którym mieści się każde wspólne słowo (rzadkie długie słowo brzegowe go
poszerza zamiast nachodzić na nazwę), pasek
postępu leży w dolnym paddingu, a akcja ma stałą kolumnę, więc zmiana stanu tylko
podmienia tekst (`t-swap`). Rozwija się wyłącznie błąd, na kliknięcie; tam jest też
Dismiss. Słownictwo: Up to date (cichy tekst, bez pigułki), Available, Downloaded
(dawne „Ready”: pobrane, czeka na restart), Queued, Starting, Updating, Waiting
(„Restarts after its current turns end.”), Restarting, Updated i Failed. Zieleń jest
tylko dla Updated (przez godzinę po kroku; `UpdateStep.finished_at`). Bieżący etap
ma pierwszeństwo nad wynikiem wcześniejszego kroku. Stany brzegowe
zachowują własne słowa w neutralnej odznace: Offline, Manual update, Checks paused,
Managed externally, Unavailable. Sprawdzanie feedu nie zmienia odznak wierszy; widać je
w nagłówku.

Desktop w trybie zdalnym pokazuje własną aplikację i jej worker jako jeden wiersz
z nazwą komputera, również w Settings → Workers → Updates. Dopasowanie korzysta
wyłącznie z id zapisanego podczas rejestracji workera, przekazanego przez lokalny
bridge `DesktopStatus.workerId`; nazwa ani wersja nie identyfikują komputera.
Wiersz zachowuje lokalny postęp pobierania i restart pobranej aplikacji oraz stan
kroku `desktop` z gatewaya, ponowienie, odrzucenie błędu i wymuszony restart.
Gateway i pozostałe workery mają własne wiersze. Starszy bridge bez identyfikatora
workera pokazuje osobno aplikację i worker.

**Ikony.** Jedna ikona ma jedno znaczenie: ⟳ (`arrow-path`) to tylko Check now;
`arrow-down-tray` to Update, `power` to Restart to update, `repeat` to Retry,
a `information-circle` pokazuje szczegóły. Każda ma podpowiedź i
`aria-label` z dokładną akcją („Update Studio”, „Restart to update”,
„Retry”). Wiersz ma najwyżej jedną akcję; bez akcji kolumna zostaje pusta. Podczas aktualizacji workera lub
restartu jego komputera akcja instalacji CLI w ustawieniach jest niedostępna.

**Stopka.** Odnośnik Settings, „What's new” tylko przy nieobejrzanych notatkach
i po prawej jedna nazwana akcja główna: Update all, Restart to update (sama pobrana
aplikacja bez przebiegu), Retry failed albo wyłączone
„Starting…” / „Updating…” ze spinnerem.

**Natychmiastowa odpowiedź.** Klient pokazuje stan od razu, zanim gateway odpowie:
Update all oznacza wszystkie kroki planu jako Queued (`plannedUpdateRun`, ten sam plan
co gatewaya), akcja wiersza pokazuje Starting, a Retry failed oznacza ponawiane kroki.
Odpowiedź gatewaya zastępuje ten stan, a błąd go cofa. W trakcie przebiegu wiersz
pokazuje dalszy z dwóch stanów: kroku przebiegu i własnego raportu celu, więc późny
odczyt nie cofa go z Updating do Queued. Odczyty nie zatrzymują się podczas akcji;
odrzucany jest tylko odczyt rozpoczęty przed odpowiedzią.

**Zapowiedziany restart.** Komputer, który ogłosił restart dla własnej aktualizacji,
ma odznakę Restarting i linię „Restarting to update…”. Gateway nie dodaje wtedy
„…is unavailable. Trying again automatically.”. Dopiero po 3 minutach linia zmienia
się na „Still restarting after N min. Check that computer.”.

Wiersze komputerów poprzedzają workery pogrupowane według komputera.
Galeria `/dev/updates` pokazuje centrum i stany na danych testowych,
a `?view=settings` obie sekcje ustawień. Parametr `?run=failed` dodaje zatrzymany
przebieg z akcjami ponowienia i odrzucenia. Długie nazwy i wersje mają skrót z pełną
treścią w podpowiedzi. Popover nie pokazuje notatek wydań; są w Settings → Workers /
App updates razem z pełnymi ustawieniami, wymuszeniem restartu i szczegółami instalatorów.

Ikona w pasku bocznym pokazuje `arrow-down-tray`: wyciszoną w spoczynku, z kropką,
gdy coś czeka (aktualizacja albo pobrana aplikacja), z pierścieniem postępu w trakcie
oraz `exclamation-circle` po błędzie. Nigdy nie pokazuje zielonego znacznika ani
obracającej się ⟳.

Arkusz Updates na telefonie ma te same elementy: nagłówek z linią stanu i paskiem,
dwuliniowe wiersze z ikoną akcji, stopkę z Settings, warunkowym What's new i akcją
główną. Telefon nie ma podpowiedzi, więc powód stanu brzegowego trafia do drugiej linii.
Wiersz workera instalowanego z aplikacją desktopową pokazuje wersję, dostępność
i połączenie jej kanału sterowania. Pobrana aktualizacja aplikacji pozostaje
dostępna także po sprawdzeniu, które pominęło wersję docelową.

Aktualizacja binarnego workera przechodzi przez Queued, Preparing (sprawdzenie
wydania), opcjonalnie Waiting (kończenie aktywnych tur i pracy w tle), Downloading
(pobieranie i weryfikacja), Restarting i Reconnecting. Restarting jest widoczne
również w trakcie przerwy w połączeniu. Reconnecting oznacza, że worker zgłosił
wersję docelową, a gateway czeka jeszcze na potwierdzenie gotowości workera.
Poza oczekiwanym restartem rozłączenie kanału aktualizacji pokazuje Offline.
Cel workera pochodzi z aktualnego polecenia, także gdy zmieniła się wersja gatewaya.
`canopy.update.v1` nadal przesyła stan w istniejącym polu tekstowym.

Settings → Workers → Updates pokazuje stan komputerów i workerów oraz osobne
akcje instalacji i aktualizacji Agent CLIs. Gateway serwerowy ma pod swoim wierszem pole kanału.
Settings → App updates zachowuje ustawienia tej aplikacji i dodaje grupę „Linked
computers”: wiersz na komputer z nazwą, wersją → docelową, kanałem i stanem, przyciskami
Check now (akcja `computer_check`, sprawdzenie feedu tamtej aplikacji) i Update albo tekstem
„Update on that computer” dla aplikacji za starej. Oba przyciski są zawsze widoczne i tylko
się wyłączają, więc zmiana stanu niczego nie przesuwa. Kanał i częstotliwość sprawdzania
partnera są tu tylko do odczytu: każdy komputer zmienia je u siebie. Nagłówek
pokazuje stan i czas sprawdzenia; Update all pojawia się tylko przy dostępnych
aktualizacjach. Aktualne workery nie mają przycisku aktualizacji. Kanał zapisuje
się po wyborze; przejście na starszy kanał lub starszą przypiętą wersję wymaga
potwierdzenia. Wyniki przebiegu można rozwinąć tylko, gdy istnieją kroki.
Brak notatek wydania (także pusty wynik lub niedostępne źródło) ukrywa
„What’s new”; interfejs nie pokazuje pustych akordeonów ani objaśnień tego braku.

Proces main, gateway i web BFF czytają statyczny indeks wydań z CDN GitHub Pages,
bez tokena i bez limitu REST API. Każdy proces współdzieli cache 15 min oraz trwające
żądania między oknami, kartami i sprawdzeniami z połączonych komputerów.
Ręczne **Check now** w popoverze i ustawieniach oraz **Check for updates**
w Settings → App updates pomijają ten cache i odświeżają metadane w sieci;
dotyczy to także sprawdzeń aplikacji zleconych z innego komputera i zmiany kanału.
Timery nadal korzystają z cache, a trwające żądania i pobierania pozostają współdzielone.
Notatki obejmują `(wersja zainstalowana, wersja pobierana]`, zgodnie
z wybranym kanałem, w malejącej kolejności SemVer. Istniejący renderer Markdown
nie wstrzykuje HTML, ogranicza schematy linków i nie ładuje obrazów. Retencja
nightly może usunąć starsze notatki; panel jawnie wskazuje to ograniczenie.

Release bez feedu platformy lub manifestu nie jest aktualizacją desktopu.
Jeśli nowsza wersja jest już w GitHub Releases, ale nie ma paczki platformy,
updater wyjaśnia, że publikacja może jeszcze trwać lub wymagać ponowienia;
nie twierdzi, że aplikacja jest aktualna.

Gotowa paczka własnej aplikacji nie zatrzymuje sprawdzania: **Check now** w popoverze,
**Check for updates** w Settings → App updates oraz timer nadal szukają nowszych wydań.
Timer zachowuje wybraną częstotliwość; Never wyłącza tylko automatyczne sprawdzanie
i pobieranie. Ten sam lub starszy cel z feedu nie zastępuje gotowej paczki.
Podczas pobierania nowszego buildu wiersz pokazuje jego wersję i procent zamiast Ready;
kolumna akcji pozostaje na miejscu. Restart pozostaje dostępny i czeka na wynik pobierania.
Po sukcesie Ready wskazuje dokładnie nową paczkę, a po błędzie wraca poprzednia wersja
z krótkim „Update failed. Check again to retry.”. Restart instaluje wtedy zachowaną paczkę.
Szczegóły cache i przekazania ZIP do Squirrel: [desktop.md](desktop.md#automatyczne-aktualizacje-desktopu).

Ręczne i zdalne sprawdzenia dołączają do bieżącego sprawdzania lub pobierania:
czekają na tę samą próbę, a raport aplikacji nadal pokazuje jej faktyczny etap
i postęp. Zajętość updatera nie jest błędem aktualizacji. Zmiany kanału czekają
na bieżącą próbę i wykonują się kolejno. Zmiana preferencji czeka na wydanie zawierające
kod zainstalowanego buildu.
Przygotowanie feedu i sprawdzenie metadanych mają po 60 s limitu. Pobieranie ma
limit 30 min oraz 90 s bez przyrostu liczby pobranych bajtów. Timeout anuluje
żądanie, zwalnia blokadę i pokazuje powód z możliwością ponowienia.
Przerwany updater jest zastępowany nowym, z osobnym katalogiem pobierania:
spóźnione odpowiedzi, zdarzenia i sprzątanie plików nie zmieniają kolejnej próby.
Poprzednia gotowa paczka zachowuje własny updater do instalacji.
Na macOS zatwierdzanie feedu Squirrel jest szeregowane między próbami. Zwykły restart
od razu wywołuje instalator; ponownie ustawia feed gotowej paczki tylko wtedy, gdy
późniejsza próba mogła go zastąpić. To lokalne przygotowanie ZIP nie ma deadline'u
kontrolera; błędy Squirrel i dysku trafiają do obsługi błędu instalacji.
Stary zapis błędu wynikającego wyłącznie
z zajętości pozostaje w journalu, ale raport partnera pokazuje bieżący stan updatera;
rzeczywiste błędy instalacji nadal są raportowane jako Failed.

`suspend` zatrzymuje timer automatycznych sprawdzeń. `resume` i `unlock-screen`
scalają odzyskiwanie w jedno wywołanie po 5 s; kolejny sen je anuluje.
Próba bez postępu dłużej niż jej limit jest anulowana i ponawiana w ramach
tej samej obietnicy, więc zdalny instalator czeka na rzeczywisty wynik.
Jeśli timeout zdążył zakończyć próbę przed obsługą wznowienia, automatyczne
sprawdzanie ponawia ją raz. Never wyłącza to ponowienie. Zdrowa próba nie jest
przerywana; po obsłudze wznowienia wraca zwykły harmonogram.

Wersja serwerowa UI pokazuje centrum bez własnej aplikacji. Odnośniki prowadzą
do Settings → Workers oraz App updates. Notatki wydań Canopy są dostępne w ustawieniach.

**Update all** zapisuje przebieg w prywatnym `user_settings.settings.updateRun`.
Orchestrator gatewaya utrzymuje maksymalnie **4 aktywne pozycje**, łącznie dla
lokalnych i połączonych komputerów. Każdy krok jest zapisany przed wysłaniem komendy;
wolne potwierdzenie nie zatrzymuje planowania ani odczytu postępu. Slot pozostaje
zajęty podczas oczekiwania na wynik dostępnego celu. Pominięcie celu offline zwalnia
slot dla kolejnych aktualizacji.

Workery binarne i sparowane desktopy czekają na aktualizację swojego serwerowego gatewaya.
Niezależne workery i zdalne aplikacje mogą aktualizować się równolegle.
Aplikacja na komputerze koordynującym restartuje się po pozostałych aktualizacjach Canopy.
Gateway sprawdza kanał sterowania aplikacją dla desktopu i kanał aktualizacji dla binarki
workera. Gdy cel jest offline, gateway pomija krok i zapisuje powód.
Kolejny Update all po powrocie komputera uwzględnia nadal dostępne aktualizacje.
Jeśli kanał rozłączył się podczas aktualizacji Canopy, gateway daje mu minutę na powrót,
a przy zapowiedzianym restarcie do pięciu minut. Po potwierdzeniu wersji pozostałe
kanały mają do minuty na powrót. Zgłoszone uśpienie lub wyłączenie komputera pomija
jego kroki od razu.

Popover i arkusz mobilny pokazują jeden wspólny licznik „Updating · N of M done”
(`updateRunSummary`); postęp obejmuje sukcesy oraz zakończone błędy/blokady, pomija
kroki `skipped`. `begin()` planuje, zapisuje i uruchamia pierwsze kroki przed odpowiedzią,
więc pierwsza odpowiedź na Update all ma już kroki `running`; odpowiedź wykorzystuje
snapshot, z którego powstał plan, zamiast czytać wszystkie komputery drugi raz.
**Retry failed** (z id bieżącego przebiegu) ponawia jednym trwałym zapisem
dostępne kroki `failed` i `blocked`, pomija cele offline i zachowuje dotychczasowe
sukcesy. Ponowienie aktualizacji własnej aplikacji wymaga `confirm_restart`.
Zmiana mobilna pozostaje w JS/TS i korzysta z istniejącej ścieżki OTA.

Dołączony gateway i worker aktualizują się razem z aplikacją desktopową.
Plan uwzględnia gotową paczkę aplikacji także bez `available_version`. Wtedy
celem jest nowsze `updater_version`, a `ready` pozwala zlecić instalację aplikacji.

Gateway odpytywany co 2 sekundy wznawia zapisany przebieg po restarcie. Potwierdzenie
przyjęcia komendy nie kończy kroku: wymagany jest raport wyniku, nowa wersja i
zgodny protokół workera. Każda akcja ponownie sprawdza dotychczasowe uprawnienia.
Po błędzie gateway kontynuuje niezależne aktualizacje Canopy.
Każdy błąd i blokada mają powód oraz `Retry update`; ponowienie jednego kroku wymaga id bieżącego
przebiegu i indeksu kroku, zachowuje sukcesy i ponawia także zablokowane zależności.
`Update all` po zakończeniu tworzy aktualny plan; podczas pracy zwraca istniejący
przebieg bez drugiej kolejki. Odczyt postępu nie czeka na odpowiedź instalatora.
Automatyczna aktualizacja po Hello workera i równoległe Update all współdzielą
jedno trwałe polecenie; jego wynik nie ginie przez zastąpienie identyfikatora.
Zmiany przebiegu ogłaszają `updates_changed`; panel i popover współdzielą wyniki,
bieżącą pozycję, postęp, pominięcia i zakończenie. Dla dostępnego celu limit
oczekiwania na potwierdzenie wyniku wynosi 35 minut.
Web i telefon wysyłają akcje `canopy_update_all`, `canopy_retry_failed` i `canopy_retry_step`.
Starszy gateway odrzuca te akcje. Pojedynczą aktualizację Canopy można nadal zlecić osobno.
Na nowym gatewayu także żądania zbiorcze ze starszych klientów obejmują wyłącznie Canopy.
Po odczycie starszego przebiegu gateway pomija kroki CLI. Zmiana identyfikatora przebiegu
chroni przed ponowieniem innej pozycji pod starym indeksem.

Kolejka obejmuje gateway binarny, workery binarne i obsługiwane aplikacje Canopy.
Gateway Docker/source i zewnętrzne workery mają krok `skipped` z powodem i wskazaniem instalatora.
Zajętość i odmowa uprawnień pozostają błędami lub blokadami z ponowieniem.
Worker przechodzi na wersję działającego gatewaya,
nawet gdy dla zewnętrznego gatewaya istnieje nowsze wydanie.
Pusty plan jest odrzucany bez zapisu przebiegu. UI ukrywa wtedy Update all;
zewnętrzne aktualizacje zachowują wersje i instrukcję pod ikoną informacji,
ze stanem „Managed externally” i podsumowaniem „Updates available outside Canopy”.
Na telefonie nowsza wersja wymagająca osobnej instalacji ma stan „Manual update”.
Na telefonie odrzucenie pustego planu uruchamia ponowny odczyt.
Jeśli odczyt potwierdza pusty plan, arkusz pokazuje aktualny stan bez błędu połączenia.
Stary błąd spowodowany wyłącznie zewnętrznym gatewayem nie jest pokazywany,
gdy bieżący snapshot nie zawiera aktualizacji obsługiwanych przez Canopy.

Publiczne notatki serwerowego centrum pobiera BFF z ustalonej listy repozytoriów,
bez tokenów, z cache 60 sekund. Błąd pobierania ma przycisk Retry i nie blokuje
samej aktualizacji. Rozpoczęty krok zachowuje wersję początkową i docelową,
żeby zmiana najnowszego wydania nie zmieniła historii wybranej aktualizacji.

Workers → Updates oferuje **Update Canopy app** dla `installKind=desktop`.
Aktualizuje całą aplikację: Electron, dołączony runtime i worker. Desktop w trybie
zdalnym musi być sparowany z gatewayem i obsługiwać kanał sterowania z
[etapu 2 lokalnego frontendu](desktop-remote-frontend.md#wynik-etapu-2).
Workery binarne zachowują niezależny mechanizm opisany poniżej.

## Dołączony gateway i worker

W trybie lokalnym aplikacja desktopowa zawiera własny gateway (`CANOPY_GATEWAY_ROLE=desktop`)
i własny worker. Oba aktualizuje bundle aplikacji, więc nie są osobnymi pozycjami. Snapshot
oznacza je addytywnymi polami `UpdatesSnapshot.gateway_bundled` i `WorkerUpdate.bundled`.
O tym decyduje gateway: rola `desktop` oraz capability `desktop_bundled` z WorkerLink Hello
(zapisana w `workers.capabilities`). UI nie zgaduje po nazwie ani `installKind`.

Popover, licznik „Up to date · N”, podsumowanie w nagłówku i Settings → Workers → Updates
pomijają oba elementy. Pozycja „This Canopy app” je reprezentuje; jej podpowiedź mówi
„Includes this computer’s gateway and worker.”. Settings → Workers → Updates pokazuje zamiast
gatewaya i kanału jedno zdanie z odnośnikiem do App updates. CLI agentów tego workera mają osobne akcje
w ustawieniach. Update all obejmuje również zewnętrzne workery podłączone do gatewaya desktopu.

Dołączony gateway nie ma własnego kanału: zgłasza kanał swojego buildu (`releaseChannel`
wersji, np. nightly), ignoruje zapisany `updateChannel` i odrzuca akcję `channel`. Wcześniej
bez `CANOPY_UPDATE_CHANNEL` zgłaszał domyślne `stable`, choć aplikacja była na nightly.
Dołączony worker nie otwiera strumienia sterowania desktopu, więc nie dostaje zastępczego
stanu „Pair this desktop app…”, który dawał etykietę „Unavailable”.

Tryb zdalny i gateway serwerowy się nie zmieniają: rola `server` nie oznacza niczego jako
dołączonego, nawet gdy worker zgłasza `desktop_bundled`.

Wiersze (`UpdateItem`) mają stałą kolumnę akcji, także bez akcji, więc odznaki tworzą jedną
kolumnę, a pojawiająca się akcja ich nie przesuwa. Ikona, odznaka i akcja są wyrównane do linii
nazwy; długa nazwa skraca się przed odznaką. Ton odznaki wynika ze stanu (`updateTone`): błąd
rose, praca w toku amber, „Up to date” emerald jak inne ustalone statusy, reszta neutralna.

## Zdalna aktualizacja aplikacji desktopowej

Właściciel gatewaya wysyła żądanie przez Workers; nie wymaga ono administracyjnej
roli potrzebnej do aktualizacji samego gatewaya. Gateway przekazuje wyłącznie id
żądania i ewentualne force. `DesktopControlService` korzysta z tego samego pinned
TLS Network access i odwoływalnego poświadczenia desktopu co jego UI.
Osobne `DesktopWorkerService.Confirm` dowodzi posiadania credentialu własnego
workera tego samego właściciela. Samo `worker_id` ani `installKind` nie wystarcza.

Controller przekazuje żądanie przez prywatne IPC do Electron main. Tylko main
wywołuje `DesktopUpdates`; desktop sam pobiera wydanie swoim normalnym updaterem,
z własnego kanału. Gateway nie dostarcza binariów desktopu ani adresów feedu.
Lokalna próba przełączenia kanału musi się zakończyć przed zdalną
aktualizacją. Docelowy SemVer musi być ściśle nowszy, także gdy lokalnie pobrano
starszą paczkę. Zasady Developer ID/codesign i walidacja Squirrel na macOS pozostają
obowiązujące; brak podpisanego buildu wyłącza funkcję.

Desktop pokazuje powiadomienie o żądaniu. Po pobraniu ustawia barierę przyjmowania
pracy przez własnego workera i czeka na zakończenie tur, generacji i zadań w tle.
Workers pokazuje „Will restart after the current turns”; **Restart now…** otwiera
potwierdzenie przerwania pracy. Force wymaga id tego samego oczekującego żądania.
Restart instaluje cały bundle, uruchamia aplikację i odtwarza połączenie.
Na Windows aktualizacja lokalna oraz zlecona przez gateway lub połączony komputer
korzystają z tego samego cichego instalatora NSIS: bez kreatora i kliknięć użytkownika,
z automatycznym ponownym uruchomieniem Canopy oraz usług. Instalacja dla bieżącego
użytkownika zachowuje wybrany wcześniej katalog i nie wymaga UAC. Pierwsza instalacja
nadal używa kreatora z wyborem katalogu.
Nowe instalatory mają poprawione zliczanie procesów w Windows PowerShell 5.1:
wykrywają również dokładnie jeden proces pozostały w katalogu aplikacji. To usuwa
błąd sprawdzania, który mógł prowadzić do nieudanej wymiany starych plików z kodem 2;
sam kod nie potwierdza przyczyny konkretnej awarii. Szczegóły patcha i Windows smoke:
[desktop.md](desktop.md#automatyczne-aktualizacje-desktopu).

Instalacje dla wszystkich użytkowników (np. w Program Files) mogą wymagać zgody
administratora nawet przy `/S`. Przed zatrzymaniem usług desktop odrzuca aktualizację,
jeśli wykryje maszynowy wpis NSIS, `isAdminRightsRequired` pobranej paczki lub brak
zapisu w katalogu aplikacji. Lokalnie pokazuje komunikat, a zdalnie raportuje `failed`
z przyczyną i zaleceniem instalacji dla bieżącego użytkownika. Nie uruchamia instalatora
czekającego na UAC. Taką instalację trzeba zaktualizować ręcznie z uprawnieniami
administratora albo zastąpić instalacją dla bieżącego użytkownika. Nieudany odczyt
uprawnień także blokuje restart; działające usługi pozostają dostępne.

Jeżeli podczas oczekiwania na idle pobrano nowszą paczkę, desktop przed restartem
kończy bieżące sprawdzanie/pobieranie, blokuje następne i raportuje faktyczny cel instalacji.
Poświadczenie workera pozostaje osobne; worker nigdy nie wymienia sidecarów.

Overview przekazuje wersję dostępną, procent pobierania, waiting/restarting oraz
failed z przyczyną. Offline, brak parowania, starsza aplikacja bez funkcji lub
wyłączony updater blokują akcję z widocznym powodem. Nowych żądań nie kolejkujemy
dla offline; zaakceptowane wcześniej mają trwałe id i są deduplikowane przy reconnect.
Gateway zapisuje stan i komendę w `desktop_updates` (migracja `0058`) oraz audyt
żądania, force i wyniku: aktor, wersja, id i przyczyna. Lokalny journal jest osobny
dla poświadczenia desktopu; przerwana próba po restarcie kończy się błędem,
a start docelowej wersji po restarting — sukcesem. Nieczytelna historia blokuje
zdalne odtwarzanie, zachowując plik i możliwość uruchomienia aplikacji.

Po przerwaniu żądania i powrocie na starszej wersji komunikat podaje ostatni
zapisany etap (sprawdzanie, pobieranie, oczekiwanie na koniec pracy lub restart).
Jeśli aplikacja zdążyła zapisać końcowy błąd, po restarcie zachowuje jego powód.
Ustalenie, co wywołało zamknięcie aplikacji, wymaga
dodatkowych zdarzeń z [lokalnego logu desktopu](desktop.md#automatyczne-aktualizacje-desktopu).

**Check now** na gatewayu wysyła też `DesktopUpdateCommand.check` do każdej sparowanej,
podłączonej aplikacji (bez trwającego żądania, z włączonym updaterem; najwyżej raz na 10 s
na aplikację) i nie czeka na wynik: raporty przychodzą jako `desktop_update`. Wcześniej
sprawdzał tylko feed gatewaya, więc pozostałe aplikacje pokazywały „Up to date” do
własnego timera.

**Wspólne wykrycie wydania.** Gdy gateway albo jedna aplikacja zgłosi nowszą wersję
(`available_version`/`updater_version` powyżej uruchomionej), gateway prosi pozostałe
aplikacje na tym samym kanale, które jej jeszcze nie znają, o sprawdzenie własnego feedu,
raz na wydanie i aplikację; samodzielny gateway na tym samym kanale sprawdza się raz.
Te sprawdzenia pomijają cache metadanych. Gateway przekazuje wyłącznie sygnał,
nie listę wydań ani wersję: każda aplikacja nadal sama weryfikuje podpisany feed swojej
platformy, a paczka platformy może pojawić się później niż release. Po tym jednym
sprawdzeniu Update all obejmuje wszystkie aplikacje naraz.

Wiersz aplikacji wśród workerów (web, telefon, Settings) pokazuje jako cel tylko wersję
nowszą od uruchomionej (`appRowTarget`). `target_version` zakończonego żądania to historia:
po aktualizacji tej aplikacji inną drogą wyglądałby jak downgrade.

Tryb lokalny nie otwiera tego strumienia; połączone komputery używają osobnego kanału
aplikacji z dołączonym gatewayem ([niżej](#połączone-komputery)).

W popoverze i Settings → Workers → Updates zdalny desktop pokazuje akcję
„Update Canopy app”, gdy własny updater zgłosi nowszą wersję. Dostępność zależy
od potwierdzonego kanału desktopu, nie od osobnego strumienia UpdateService workera
ani wersji gatewaya. Aktualny worker ma krótką informację, że aktualizuje się z aplikacją
i następne wydanie można zainstalować stąd. Brak połączenia pokazuje widoczne zalecenie
otwarcia aplikacji i ponownego połączenia; brak powiązania wskazuje parowanie lub
jednorazową aktualizację w App updates. Update all pomija niedostępny desktop z powodem,
a po przyjęciu żądania czeka na raport wyniku po restarcie.
`canopy.update.v1` nie zmienia się. Integracja gateway ↔ desktop zastępuje updater
na jego granicy; rzeczywisty podpis, instalację i restart trzeba sprawdzić na macOS
oraz Windows. Po ponownym uruchomieniu Windows ten sam journal zgłasza nową wersję
i `succeeded`, jeżeli odpowiada zapisanemu celowi.

Gateway i worker używają jednej wersji aplikacji z `CANOPY_VERSION` (wstrzykiwanej
podczas kompilacji; bez niej `0.0.0-dev`). `--version` wypisuje tę wersję bez
uruchamiania usług. Wersja aplikacji nie jest numerem protokołu.

## Połączone komputery

Lokalny status nigdy nie czeka na partnera. Jego ostatni snapshot pozostaje widoczny,
a zwykłe odświeżenie w tle ma limit 10 s. Loading/Waiting i „Waiting for {name}.
Local updates are ready.” nie oznaczają awarii łącza. Dopiero utrata liveness daje
Unavailable i „{name} is unavailable. Trying again automatically.”. Check now
sprawdza lokalnie i osobno planuje idempotentne sprawdzenia partnerów (120 s),
bez czekania na nie. Jawna instalacja u partnera ma limit 15 min; nie jest ponawiana
automatycznie. Czasy, limity współbieżności i circuit breaker opisuje
[zsumowany widok](linked-computers.md#zsumowany-widok).

Check now z telefonu i przeglądarki wysyła również `DesktopUpdateCommand.check`
do aplikacji tego komputera przez istniejący kanał `WatchAppControl`. Nie instaluje
ani nie restartuje aplikacji. Gateway scala równoległe żądania i wysyła najwyżej
jedno na 10 s; aktywne sprawdzanie, pobieranie lub żądanie aktualizacji ma pierwszeństwo.
Nowy desktop ogłasza `DesktopHello.update_checks` i raportuje `last_checked_at_ms`
z własnego harmonogramu, także przy sprawdzeniu ręcznym. Odpowiedź czeka do 30 s
na zakończony raport z nowszym czasem. Timeout lub starsza aplikacja zachowuje
ostatni wynik; sprawdzenia nie są odtwarzane po reconnect. Żądania partnerów
trafiają tą samą drogą do ich domów, z dotychczasowym sprawdzeniem właściciela.
Każdy wiersz Canopy pokazuje „Checked {time}”; brak czasu ze starszej aplikacji
oznacza „Check time unavailable”. Czas odświeżenia gatewaya nie zastępuje czasu aplikacji.
Telefon pokazuje czas sprawdzenia OTA od ostatniego uruchomienia aplikacji.
Podczas używania aplikacji i po powrocie do niej telefon sprawdza OTA co 15 minut,
pobiera zgodną aktualizację i ładuje ją przy następnym zimnym starcie
([mobile.md](mobile.md#wydania-mobilne-testflight-i-ota)).

Dotyczy wyłącznie aplikacji desktopowych w trybie lokalnym połączonych jako
[połączone komputery](linked-computers.md). Gatewaye serwerowe (Docker, binarka)
nie mają łącza, więc ta funkcja ich nie dotyczy. Update all na gatewayu Docker
aktualizuje obsługiwane workery, pomijając sam kontener.

**Kanał aplikacji.** Proces kontrolera desktopu w trybie lokalnym otwiera
`GatewayService.WatchAppControl` do własnego dołączonego gatewaya (loopback, token serwisowy)
i raportuje stan przez `ReportAppControl`. Gateway odrzuca te RPC dla ról innych niż `desktop`
oraz dla każdego tokenu urządzenia (telefon, sparowany desktop). Ten sam `RemoteAppUpdate` co
w trybie zdalnym wykonuje żądanie: własny updater, własny kanał i ustawienia, ściśle nowszy
podpisany SemVer, bariera workera, czekanie na koniec tur, generacji i zadań w tle, potem restart.
Nie ma force ani downgrade'u z zewnątrz; **Restart now…** istnieje tylko lokalnie. Gateway trzyma
ostatni raport w pamięci (restartuje się razem z aplikacją); źródłem prawdy jest lokalny journal
aplikacji, który po restarcie zgłasza `succeeded` albo `failed` dla tego samego id żądania.
`DesktopUpdateState.ready` mówi, że aplikacja pobrała aktualizację i zainstaluje ją przy restarcie.
Pola `updater_phase`, `updater_version`, `updater_progress` i `updater_error` niosą stan własnego
updatera aplikacji (sprawdzanie, pobieranie z postępem, pobrana wersja, błąd) niezależnie od żądania,
więc wiersz połączonego komputera pokazuje to samo co „This Canopy app”. Journal ich nie zapisuje,
a sam postęp aplikacja raportuje najwyżej raz na sekundę (ostatnią wartość zawsze). Gateway w trybie
zdalnym zeruje je przed zapisem do `desktop_updates`. Starsza aplikacja ich nie wysyła: wiersz wygląda
wtedy jak wcześniej (wersja docelowa z `available_version`). `target_version` zakończonego żądania nie
jest już celem wiersza; liczy się tylko wersja nowsza od bieżącej. Centrum aktualizacji web to jeden
współdzielony stan na kartę (wskaźnik w pasku bocznym, Workers i App updates); czyta co 2 s tylko,
gdy któryś komputer pobiera aktualizację, poza tym po zdarzeniach opisanych wyżej.
Nowe pola `DesktopUpdateCommand`: `requested_by` (nazwa komputera w powiadomieniu „MacBook
requested an app update…”) i `check` (samo sprawdzenie feedu, bez instalacji).

**Łącze.** Gateway z kanałem aplikacji ogłasza capability **`remote_app_update`** w `NodeHello`.
`canopy.link.v1.ComputerUpdateService` ma dwie metody przenoszone istniejącym
`remote_request`: `GetComputerUpdates` (snapshot domu: jego aplikacja w `UpdatesSnapshot.app`,
workery i CLI, bez jego partnerów i bez przebiegu Update all) oraz `RequestComputerUpdate`
(`app`, `check`, `worker`). `ManageUpdates` wywołuje je akcjami `computer` i `computer_check`
z `node_id` albo `worker` z kwalifikowanym id workera. Dom obsługuje je tylko na bezpośrednim łączu, gdy obie strony
ogłosiły capability; relay ich nie przenosi (`RELAY_METHODS`). `COMPUTER_LINK_PROTOCOL` zostaje 1.

**Weryfikacja u domu.** Wołający musi być bezpośrednio sparowanym komputerem tego właściciela
(`store.peer`); inaczej `PermissionDenied`. Dom nie ufa wersjom z widoku wołającego: aplikacja
sama sprawdza feed swojego kanału, a wyłączony updater, brak kanału aplikacji albo trwający
Update all na domu odrzucają żądanie z czytelnym powodem. `worker` dotyczy wyłącznie binarnego,
niedołączonego workera domu i przechodzi przez zwykłe, administracyjne `ManageUpdates`. Łączem
nie przechodzą adresy feedów, binaria, sekrety ani zgody na downgrade.

**Audyt.** A zapisuje `computer.update.sent` (węzeł, akcja, worker). B zapisuje
`computer.update.received`, a dla aplikacji także `desktop.update.request` (węzeł wołającego,
id żądania) i jednokrotnie `desktop.update.outcome` (wynik po restarcie).

**Widok na A.** `UpdatesSnapshot.computers` (`ComputerUpdate`) zawiera każdy połączony komputer:
nazwę, wersję aplikacji z ostatniego handshake'u, obecność łącza i powód, gdy nie da się go
aktualizować stąd („Update Laptop on that computer.” dla partnera bez capability albo
pośredniego). Dla bezpośrednich partnerów z capability A dołącza ich snapshot (limit 3 s; partner,
który nie odpowie, jest pokazywany bez niego). Id workerów są kwalifikowane węzłem domu, więc
akcje na workerach i CLI B trasują się jak inne wywołania. CLI partnera aktualizuje istniejące
trasowane `InstallCli` (wymaga wspólnej konfiguracji). Check now na A prosi aplikacje partnerów
o sprawdzenie ich feedów. Podczas restartu B jego obecność to `updating` (ogłoszona przed
zamknięciem), więc UI pokazuje „Restarting”, a nie błąd; po powrocie snapshot ma nową wersję.

**Update all.** Plan dodaje krok `computer` dla każdego połączonego, bezpośredniego partnera
z capability, który jest online, ma aktywny kanał aplikacji i nowszą dostępną wersję. Te kroki
mogą działać równolegle, po zakończeniu aktualizacji workerów danego partnera.
Własna aplikacja A restartuje się dopiero po tych krokach, więc łącze A
przetrwa restart B i A widzi powrót B. Krok zapisuje id żądania u B; kończy się, gdy B wróci
na łącze z wersją co najmniej planowaną albo zgłosi `succeeded` dla tego id.
Przy błędzie B gateway zapisuje powód i kontynuuje niezależne aktualizacje Canopy.
Jeśli B pozostaje online i czeka na zakończenie tur przez 35 minut, krok kończy się błędem
z możliwością ponowienia.
Workery partnera wchodzą do Update all A z kwalifikowanymi id domu przez `RequestComputerUpdate.worker`.
Po restarcie A wznawia zapisany krok aplikacji i sprawdza wersję.

**Jednorazowo.** Oba komputery muszą mieć wersję z tą funkcją, zanim zdalna aktualizacja zadziała;
starszy partner jest pokazywany z wersją i „Update on that computer”, bez akcji.

## Niezależny kanał ratunkowy

`proto/canopy/update/v1/update.proto` definiuje zamrożony
`canopy.update.v1.UpdateService`. Gateway wystawia go na tym samym porcie
HTTP/2 co WorkerLink, pod osobną ścieżką usługi. Zdalne workery korzystają ze wspólnego
listenera Network access i pinu zapisanego przy enrollment. Osobny port nie
zwiększyłby odporności na niezgodne kontrakty, a wymagałby dodatkowych reguł proxy
i firewalla. Worker inicjuje oba niezależne połączenia, również za NAT-em.

| RPC / endpoint | Dostęp i odpowiedź |
|---|---|
| `Check` bez Authorization | Tylko zdrowie gatewaya, jego wersja i zakresy protokołów. Nie ujawnia workerów, poleceń ani assetów. |
| `Check` z credentialem | Dodatkowo werdykt zgodności dla podanego workera. |
| `Watch` | Credential workera w `Authorization: Bearer …`; natychmiastowy werdykt, następnie polecenia i heartbeat. Rozwiązanie release nie blokuje pierwszego werdyktu. |
| `Report` | Uwierzytelniony postęp/wynik przypisany do identyfikatora polecenia. Stary raport nie nadpisze nowego polecenia. |
| `FetchArtifact` | Uwierzytelniony strumień zweryfikowanej binarki workera wyłącznie dla wersji działającego gatewaya i wskazanej platformy. |
| `GET /healthz` | Anonimowe `{healthy, version}`, HTTP 200/503, bez cache. Przy h2c wymaga HTTP/2; listener TLS obsługuje także HTTP/1.1. |

`worker_id` musi odpowiadać credentialowi. Unieważnienie/rotacja credentialu lub
archiwizacja workera zamyka kanał; heartbeat ponownie sprawdza uprawnienia.
Poświadczenia nie trafiają do manifestów, adresów pobierania ani plików usługi.

`WORKER_LINK_PROTOCOL`, `MIN_WORKER_LINK_PROTOCOL` i `UPDATE_PROTOCOL` są w
`packages/domain/src/release/protocol.ts`. Obecnie wszystkie wynoszą 1. Worker
wysyła zakres `[min_worker_link_protocol, worker_link_protocol]` także w
WorkerLink `Hello` (nowe pola 760 i 761). Gateway dopuszcza połączenie, gdy oba
dodatnie zakresy mają wspólny numer. Brak negocjacji (0) jest niezgodny;
WorkerLink zwraca `FailedPrecondition` z zakresem i wskazaniem UpdateService.
Aktualizator działa niezależnie od tego handshake i konfiguracji dostawców.

Reguły utrzymania v1: wyłącznie nowe opcjonalne pola i RPC, bez zmiany znaczeń,
typów ani numerów istniejących pól. Nie usuwać v1 przy kolejnej wersji WorkerLink.
Nie importować do niego wiadomości WorkerLink ani UI. `UPDATE_PROTOCOL` pozostaje
1; zmiana łamiąca WorkerLink zwiększa jego własny numer. Nowe stany postępu są
tekstowe; stary serwer je przyjmuje, stary klient pokazuje bezpieczny stan
zastępczy. Nieznana zgodność nie może otworzyć WorkerLink. Nieznany rodzaj
instalacji jest zarządzany zewnętrznie.

Worker sprzed wprowadzenia UpdateService wymaga **jednej ręcznej aktualizacji**.
Nie ma możliwości zdalnego dodania kanału do procesu, który go jeszcze nie zna.

## Release i mirror

### What's new po aktualizacji

Przy starcie klient zapamiętuje wersję uruchomionej aplikacji i ostatni zakres
aktualizacji. Po przejściu na wyższą wersję SemVer w dolnym rogu pojawia się
„Updated to …” z numerem wersji, akcją „View changes” i przyciskiem zamknięcia.
Na wąskim ekranie aplikacja rezerwuje pod treścią miejsce na powiadomienie,
żeby przyciski kompozytora pozostały dostępne.
„View changes” otwiera notatki. Ostatni zakres From … to … pozostaje dostępny
po zamknięciu powiadomienia i po restarcie.
Pierwsza instalacja, nieznana poprzednia wersja i downgrade tylko ustawiają
nową bazę, bez pokazywania historii. Buildy development nie zmieniają bazy.

Zapis korzysta z `DeviceViewPreferences` z #583 w oddzielnym zakresie
aktualizacji, bez synchronizacji konta: web ma localStorage per gateway,
desktop `app-update-history.json` we własnym profilu Electron, telefon plik
preferencji per instalacja, niezależny od parowania. Desktop używa wersji
z `app.getVersion()`, web wersji swojego buildu, mobile wersji bundla JS
(`CANOPY_VERSION`), więc OTA i aktualizacja sklepowa trafiają w ten sam przepływ.
Aktualizacja połączonego komputera nie wywołuje własnego powiadomienia.

Settings → App updates i stopka Updates dają „What's new” także później.
Widok zawiera zgrupowany ostatni zakres albo bieżące i 9 wcześniejszych wydań
tego samego kanału; nie podaje wersji nowszych niż uruchomiony build.
Wpisy mają scope i link PR-a. Puste dane, brak bieżącego wydania, ucięta
historia oraz błąd sieci mają jawne komunikaty, Retry i odnośnik do GitHub Releases.
Awaria notatek nie blokuje aplikacji ani aktualizacji.

### Strukturalne notatki wydań

`https://itsoltech.github.io/canopy/releases/notes-v1.json` zawiera do 200 wersji
na kanał z datami i wpisami New (`feat`), Improved (`perf`) oraz Fixed (`fix`).
Klient notatek czyta wyłącznie Pages, z istniejącym cache 15 min i ETag;
awaria nie uruchamia fallbacku do API GitHuba. Dekoder sprawdza schemat,
daty, wersje, limity, duplikaty i URL-e PR-ów w repozytorium Canopy.
Pełne treści nadal żyją w GitHub Releases, bez commitowanego CHANGELOG-a.

Web pobiera publiczny, stały zasób przez `GET /api/updates/whats-new` w BFF,
bez parametrów ani odczytu poświadczeń gatewaya. Desktop używa typowanego
IPC `canopy:release-notes` z kontrolą nadawcy i originu, telefon czyta Pages
bezpośrednio. Nie rozszerzamy CSP renderera. Starsze wersje bridge'a mogą
korzystać z BFF; własny numer desktopu nadal pochodzi z jego statusu.

Zakres aktualizacji to `(poprzednia wersja, bieżąca wersja]` na kanale
uruchomionego buildu. Agregacja porządkuje grupy New, Improved, Fixed,
a wewnątrz nich najnowsze zmiany. Deduplikuje po numerze PR-a lub scope
i podsumowaniu, gdy brak numeru. Promocje powtarzają skumulowane notatki;
wpisy znane z poprzedniego kanału są odejmowane. Notatki innych kanałów
nie zapowiadają zmian nieobecnych w uruchomionym buildzie. Ucięta historia
oraz brak bieżącego wydania w snapshotcie mają jawny stan niekompletności.

### Indeks pobrań

Źródło domyślne: `https://itsoltech.github.io/canopy/releases/v1.json`.
Wersjonowany indeks (`schema: 1`, `releases`) zawiera tag, flagę prerelease,
czas publikacji, notatki i nazwy oraz URL-e assetów, w tym `manifest.json`.
Feed `nightly` widnieje w indeksie wyłącznie przy wydaniach nightly.
Nie zastępuje manifestu, hashy ani weryfikacji podpisów instalatora i przypiętego TLS.
Klient odrzuca drafty, duplikaty tagów, nieznany schemat, błędne daty i niebezpieczne URL-e.
Manifest musi wystąpić dokładnie raz w metadanych każdego wydania w indeksie.
Dla domyślnego źródła jedynym dozwolonym adresem manifestu jest
`https://github.com/itsoltech/canopy/releases/download/<tag>/manifest.json`.
Ta sama reguła obowiązuje resolver binarek po fallbacku do REST API. Resolver
sprawdza zgodność wersji manifestu z tagiem; mirror i klienci weryfikują SHA-256 binarki.

Tylko niedostępny lub błędny indeks uruchamia fallback do publicznego REST API.
Brak kanału lub dokładnego tagu w poprawnym indeksie nie wywołuje API.
Jawny mirror `baseUrl` zachowuje układ API; może wskazać własne `indexUrl` i lokalizację
manifestu. Konfiguracja mirrora jest decyzją o zaufaniu do jego metadanych.
Cache metadanych trwa 15 min; po jego wygaśnięciu klient wysyła `If-None-Match`,
a `304` zachowuje poprzednią treść. Równoległe żądania tego samego URL-a są scalane.
Ręczne sprawdzenia i sygnał wykrycia nowego wydania omijają TTL udanych odpowiedzi,
cache błędów oraz przerwę po awarii indeksu. Wysyłają `Cache-Control: no-cache`,
zachowując `If-None-Match`: serwer może potwierdzić aktualność odpowiedzi przez `304`.
Jeśli indeks nadal nie działa, odświeżane są wszystkie odczytywane strony API.
Udana próba aktualizuje wspólny cache dla kolejnych automatycznych sprawdzeń.
Manifest konkretnego, niezmiennego wydania ma cache w resolverze; błędy nie zostają w nim.

`403` z `x-ratelimit-remaining: 0` lub `retry-after`, a także `429`, zatrzymuje
żądania całego hosta API do późniejszego z resetu i Retry-After (minimum 60 s).
UI pokazuje neutralne „Checks paused” oraz „GitHub is limiting update checks from this network.
Next check at ….” z czasem i strefą. Ręczne/zdalne ponowienia nie omijają blokady;
automatyczne sprawdzanie wraca po resecie. Never nadal wyłącza automatyczne próby desktopu.
Gotowy instalator pozostaje dostępny. Raport partnera przekazuje komunikat istniejącym
`updater_error` bez zmiany faz ani protokołów; nowy klient mapuje go na stan neutralny.
Cache i backoff są procesowe, restart procesu je zeruje. Stare klienty nadal używają API.
Notatki Claude/Codex nadal pochodzą z API dostawcy, ale współdzielą ten sam cache,
ETag i backoff hosta w BFF. Telefon czyta notatki konkretnej wersji z indeksu.

Kanały: `stable` wybiera najwyższe stable, `beta` najwyższe ze stable/beta,
`nightly` najwyższe nightly. Resolver porównuje SemVer i uwzględnia kolejne strony katalogu.
`vX` / `vX.Y` wybierają najwyższe stable z prefiksem, `vX.Y.Z` wskazuje dokładny stabilny tag
(mirror może zachować również tagi `X.Y.Z`). Drafty i release bez `manifest.json` są pomijane.
Pipeline przygotowuje `manifest.json` na ukrytym drafcie, najpierw z binariami gatewaya/workera,
potem z instalatorami desktopu. Release staje się publiczny dopiero po wgraniu i weryfikacji
wszystkich wymaganych assetów oraz feedów kanału dla macOS, Linux i Windows
([release.md](release.md)). Wpisy binariów pozostają takie same.
Gateway pobiera manifest swojej konkretnej wersji również dla prerelease; nie zastępuje go
manifestem nowszego nightly. Protokół UpdateService pozostaje bez zmian.

Numer SemVer wyznacza kolejność binarek w obrębie jednego kanału. Przy przejściu między
stable, beta i nightly kandydat musi zawierać commit uruchomionej wersji lub wskazywać
ten sam commit. Dotyczy to również stabilnego wydania wybranego z kanału `beta`.
Gateway pomija taki cel, gdy porównanie go odrzuci, i stosuje tę samą regułę dla poleceń
automatycznych, zapisanych i ręcznych. Worker sprawdza polecenie samodzielnie, również
od starszego gatewaya. Aktualizator weryfikuje regułę ponownie przed wymianą binarki.
`force` i `allow_downgrade` nie pozwalają zainstalować starszego lub rozbieżnego kodu.
Jawna zgoda na niższy SemVer przy zmianie kanału nadal obowiązuje, nawet gdy commit
docelowy przechodzi porównanie. Supervisor nadal może przywrócić `.bak` po nieudanym starcie.

Porównanie używa endpointu `/compare` tego samego źródła wydań i współdzieli z nim
cache oraz limity REST API. Bieżącą wersję identyfikuje niezmienny tag `v<wersja>`.
Kandydat jest identyfikowany pełnym SHA z manifestu, jeśli jest dostępny, albo swoim
tagiem. Brak potwierdzenia historii wstrzymuje zmianę kanału także wtedy, gdy gateway
ma binarkę w cache. W obrębie kanału worker nadal może pobrać aktualizację wyłącznie
z mirrora gatewaya, bez dostępu do REST API. Przy `CANOPY_RELEASE_BASE_URL` sprawdzenie
zmiany kanału wymaga obsługi `/compare` przez mirror; ustaw adres osobno na workerze,
jeżeli ma korzystać z tego samego źródła zamiast domyślnego API GitHuba.

**`latest` oznacza teraz stable**, a stare zapisane `updateChannel: "latest"` gateway przy
starcie zapisuje jako `stable`. Zmienna środowiskowa `latest` i żądania starszych klientów
także są normalizowane do stable. Nie publikujemy już rolling GitHub release/tagu `latest`
ani buildów `X.Y.Z-main.<sha7>`. Settings → Workers → Updates pozwala wybrać trzy kanały
lub wpisać stabilny pin. Nightly z dev, beta z next i stable z main opisuje [release.md](release.md).
Nightly powstaje w cyklu godzinowym, o minucie 40 UTC, tylko dla zmian releasowalnych
(lub po ręcznym dispatchu). Push do `dev` nie publikuje aktualizacji; cron, kolejka i buildy mogą
opóźnić jej dostępność. Nightly, beta i stable wydają SHA zapisane na początku przebiegu
(lub `expected_sha` dispatchu), także gdy gałąź otrzyma kolejne commity podczas checków.
Tag, buildy i manifest wskazują ten sam commit; późniejsze zmiany zbiera kolejny przebieg.
SHA usunięty z historii gałęzi przez force push jest odrzucany przed wydaniem.

Resolver pobiera asset `manifest.json`, schemat 1:

```json
{
  "schema": 1, "version": "2.1.0", "channel": "stable",
  "commit": "abcdef0", "published_at": "2026-11-03T00:00:00Z",
  "protocol": { "worker_link": 1, "update": 1 },
  "assets": [{
    "app": "worker", "os": "linux", "arch": "x64",
    "name": "canopy-worker-linux-x64",
    "url": "https://github.com/itsoltech/canopy/releases/download/v2.1.0/canopy-worker-linux-x64",
    "sha256": "<64 znaki hex>", "size": 123456
  }]
}
```

Nazwy niekompresowanych binarek: `canopy-{gateway|worker}-{os}-{arch}`
(`linux|darwin|windows`, `x64|arm64`, `.exe` na Windows). Pipeline publikuje także
`checksums.txt`; runtime weryfikuje rozmiar i SHA-256 bezpośrednio z manifestu.
Manifest może zawierać także instalatory desktop z własnymi nazwami; aktualizator
gatewaya/workera nie wybiera tych assetów.
Desktop ma osobną politykę: Settings → App updates zapisuje kanał w lokalnym
`userData/app-updates.json` Electrona, bez wywołania gatewaya i bez zmiany kanału
gatewaya ani workera. Jedna aplikacja Canopy ma wspólne dane dla wszystkich kanałów.
Stable dopuszcza stable, Beta dopuszcza stable i beta, a Nightly wyłącznie nightly.
Resolver porównuje SemVer oraz historię commitów. Wydanie musi zawierać kod z uruchomionego
buildu. Nightly może przejść do bety o niższym SemVer po potwierdzeniu tego samego lub nowszego kodu.
W lokalnym desktopie nowy instalator zawiera też nowy
runtime gatewaya/workera — ich jawne polityki aktualizacji pozostają niezależne.
Semantyka feedów i migracja starych instalacji: [desktop.md](desktop.md#automatyczne-aktualizacje-desktopu).

Wszystkie adresy upstream i przekierowania muszą używać HTTPS. Jawny wyjątek HTTP
jest dostępny tylko w opcjach testowych, nie przez zmienną środowiskową.

Gateway przechowuje manifest własnej wersji oraz binarki workerów w cache
adresowanym SHA-256. Równoległe żądania współdzielą pobieranie; każde ponowne
użycie pliku sprawdza jego hash. Przed własną aktualizacją zapisuje wybrany
manifest oraz pobiera assety platform znanych workerów binarnych, aby przesunięcie
retencji starszych nightly nie odebrało im aktualizacji. Cache zachowaj między restartami.
Workery preferują `FetchArtifact`, więc nie potrzebują dostępu do internetu.
Przy zimnym cache gateway musi mieć dostęp do release; awaria mirrora kończy
próbę czytelnym błędem i pozostawia bieżącą binarkę.

Gateway sprząta ten cache przy starcie i po operacjach mirrora. Zachowuje do trzech
wydań według czasu zapisu manifestu, zawsze chroniąc uruchomioną wersję oraz obie
wersje z trwałego rekordu `.update.json` (poprzednią do rollbacku i cel aktualizacji).
Wybrany cel jest dodatkowo chroniony od rozpoczęcia próby aktualizacji; po udanej
wymianie binarki ochrona trwa do zamknięcia procesu. Nieudana próba zwalnia tę
ochronę dopiero po wykluczeniu oczekującej wymiany w trwałym rekordzie; nieczytelny
rekord zachowuje ochronę. Chronione wydania mogą przekroczyć limit trzech.

Usuwane są wyłącznie stare, kompletne `manifest-<wersja>.json` i zwykłe pliki
SHA-256 nieużywane przez manifesty zachowanych workerów. Współdzielone hashe zostają.
Sprzątanie i operacje mirrora wzajemnie się wykluczają, więc nie kasuje plików
w trakcie pobierania lub weryfikacji. Strumienie `FetchArtifact` i instalatora
czytają chronioną wersję uruchomionego gatewaya, także po zakończeniu operacji mirrora.
Pliki częściowe `.part`, tymczasowe, symlinki, katalogi i inne nazwy pozostają nietknięte.

Brak pliku manifestu oznacza brak kompletnego wpisu danej wersji w cache, więc
nie blokuje sprzątania pozostałych wydań i nie zajmuje miejsca w limicie. Dotyczy
to także nieopublikowanych buildów development i wersji rollbacku nigdy wcześniej
niezapisanych w tym mirrorze. Mirror zapisuje manifest przed artefaktami; brak wpisu
nie zapewniał obsługi tej wersji offline. Sprzątanie nie pobiera brakujących manifestów
z sieci. Istniejący, lecz błędny manifest cache wstrzymuje sprzątanie przed usuwaniem;
błąd odczytu/usunięcia daje ostrzeżenie, bez przerwania aktualizacji. Limit dotyczy
liczby wydań, nie bajtów; liczba platform i chronione wydania mogą zwiększyć zajętość.
Nie obejmuje pozostałości częściowych pobrań po awarii. Koordynacja działa w jednym
procesie gatewaya: osobne procesy muszą mieć osobne katalogi cache. Nie sprząta
executable ani jego `.bak`, `.next` lub rekordu aktualizacji obok binarki.

## Wymiana, restart i rollback

1. Administrator aktualizuje gateway w **Settings → Workers → Updates**.
   Gateway sprawdza kanał co 15 minut; akcje zarządzania wymagają roli `admin`.
   Kanał zapisuje się w istniejącym `user_settings.settings.updateChannel`.
2. Od przyjęcia aktualizacji gateway zapisuje nowe tury i polecenia rozpoczęcia
   pracy w trwałych kolejkach. Czeka na bieżące tury workerów i botów, pobiera
   wydanie i weryfikuje je. Kolejki ruszają po restarcie albo po niepowodzeniu
   aktualizacji. Gateway wymienia własną binarkę przed wysłaniem workerom
   poleceń przejścia na tę wersję. Etapy zamykania dłuższe niż 5 sekund podają
   nazwę operacji i czas w logach gatewaya.
3. Po restarcie worker otwiera Watch. Gateway zapisuje trwałe polecenie przejścia
   na **swoją uruchomioną wersję**; zastępuje polecenie do poprzedniej wersji.
   Offline worker odbierze je przy następnym połączeniu. Ręczne **Update worker**
   i **Update all** pozwalają ponowić próbę. Nie ponawia automatycznie błędu lub
   rollbacku i nie wykonuje automatycznego downgrade.
4. Worker zamyka przyjmowanie nowej pracy i zgłasza `waiting_idle`; czeka również
   na generacje i zadania w tle. Limit domyślny to 30 minut. Przekroczenie limitu
   odracza aktualizację, odblokowuje pracę i wymaga ponowienia. Tylko jawne `force`
   w administracyjnym `ManageUpdates` może przerwać aktywną pracę. Po błędzie
   worker odtwarza niepotwierdzone polecenia przez ponowne połączenie WorkerLink.
   Jeśli gateway był niedostępny podczas wysyłania raportu o błędzie aktualizacji,
   worker ponawia sam raport na kanale aktualizacji, z identyfikatorem tej samej próby.
   Użytkownik może potem ponowić aktualizację z centrum aktualizacji.
5. Zweryfikowane bajty trafiają do pliku `.next` obok executable (ten sam system
   plików), są synchronizowane, otrzymują prawa wykonania, poprzedni plik zostaje
   jako `.bak`, a atomowy rename podmienia executable. Manifest, rozmiar i SHA
   muszą być poprawne **przed** dopuszczeniem wykonania. Niższy SemVer wymaga jawnego
   `allow_downgrade` administratora oraz dozwolonego przejścia między wydaniami opisanego
   powyżej. Stan i identyfikator polecenia zapisuje
   prywatny plik `.update.json` obok binarki.

Zapis rekordu używa osobnego pliku tymczasowego z prawami `0600`, `fsync`
i atomowego `rename` w tym samym katalogu. Czytelnik widzi poprzedni albo cały
nowy rekord, także podczas potwierdzania startupu. Fixture'y testowe muszą używać
tego samego zapisu; bezpośrednie przekierowanie do `.update.json` odsłania pusty
lub częściowy JSON przed zakończeniem zapisu. Brak pliku oznacza brak rekordu,
ale uszkodzony JSON pozostaje błędem odczytu, a nie potwierdzeniem aktualizacji.

Binarka uruchamia proces nadzorujący i właściwy proces usługi. Kod wyjścia **75**
żąda ponownego uruchomienia executable. Ten sam mechanizm działa na pierwszym
planie i pod systemd/launchd. Stary supervisor pozostaje w pamięci do potwierdzenia
nowej wersji, dzięki czemu potrafi przywrócić `.bak`, nawet gdy nowa binarka w ogóle
się nie uruchamia.
Zwykłe zakończenie nie wywołuje restartu supervisora; politykę awarii ustala
menedżer usług. Drukowane unit/plist mają `Restart=always` / `KeepAlive=true`.
Gateway `service` drukuje unit z `EnvironmentFile=%h/.config/canopy/gateway.env`;
przygotuj ten prywatny plik samodzielnie z istniejącą konfiguracją gatewaya.

Jeśli sprzątanie urządzeń workera się nie powiedzie, worker zapisuje ostrzeżenie,
próbuje dosłać dziennik i przekazuje sterowanie supervisorowi. Dotyczy to również
przekazania nadzoru po potwierdzeniu nowej wersji. Trwałe rezerwacje czekają na
ponowienie sprzątania po starcie. Zasady własności opisuje sekcja
[Rezerwacje urządzeń i emulatory](automation-tools.md#rezerwacje-urządzeń-i-emulatory).

Nowy gateway potwierdza start po uruchomieniu DB, listenerów i aktualizatora,
a binarka z wbudowanym web także po odpowiedzi web (w tym samym procesie, przez jego listener)
na `/api/health` tą samą wersją; web jest częścią tej samej binarki, więc
jedna wymiana i jeden rollback obejmują oba. Kandydat, którego web nie wstaje, sam przywraca `.bak`
z powodem web (np. zajęty port) w `.update.json` i kończy się kodem 75, więc supervisor uruchamia
poprzednią wersję ([deploy.md](deploy.md#gateway-z-wbudowanym-web-jedna-binarka));
worker po otrzymaniu WorkerLink Welcome. Jeśli proces wcześniej wyjdzie albo
nie potwierdzi startu w **90 sekund**, supervisor przywraca `.bak` i uruchamia
poprzednią wersję. Potwierdzenie trafia też przez lokalne IPC do supervisora;
raportowanie i usunięcie `.update.json` nie mogą zgubić tego sygnału.

Jeżeli wersja potwierdzonego dziecka różni się od wersji supervisora, supervisor
prosi je przez IPC o przekazanie nadzoru. Pierwszy proces zaktualizowanego gatewaya
otwiera listenery na potrzeby potwierdzenia zdrowia. Do rozstrzygnięcia przekazania
odracza RPC klientów i workerów oraz start kolejek. Jeśli supervisor odpowie
w ciągu sekundy, proces zamyka zasoby i wychodzi z wewnętrznym kodem **76**.
Kolejki uruchamia dopiero proces pod właściwym supervisorem. Jeżeli żądanie nie
nadejdzie w tym czasie, gateway zaczyna obsługę. Późniejsze żądanie korzysta ze
zwykłej blokady aktualizacji i czeka na bieżące tury workerów i botów.
Dopiero wtedy supervisor wykonuje `process.execve` na potwierdzonej binarce:
zachowuje PID, argumenty i środowisko usługi oraz standardowe strumienie,
a nowy supervisor uruchamia właściwy proces usługi. Zdrowe dziecko uruchamia się
zatem drugi raz.
Kod 76 jest obsługiwany wewnętrznie, nie wymaga restartu przez menedżera usług.

Pierwszy proces docelowej wersji workera potwierdza zgodność łącza po `Welcome`
i daje supervisorowi do sekundy na wysłanie żądania przekazania. Dotyczy to też
starszego supervisora, gdy rekord aktualizacji wskazuje zmianę wersji. Jeśli
żądanie dotrze podczas startu, worker kończy pracę przed odtworzeniem journala
na łączu i obsługą `Welcome.thread_lifecycle`. Po przekazaniu nowy proces
odbiera konfigurację i zaczyna obsługiwać wiadomości z gatewaya. Podczas obsługi
listy archiwalnych wątków współdzieli sprawdzenie ich natywnych sesji narzędzi.
Ponowne połączenie tego samego procesu ponawia niedokończone sprzątanie
([narzędzia automatyzacji](automation-tools.md)).
Lokalny rekord potwierdza start binarki dla watchdoga. Do UpdateService
`succeeded` raportuje proces, który zaczyna obsługiwać łącze. Gdy supervisor
nie obsługuje przekazania lub nie zażąda go w tym czasie, pierwszy proces
przejmuje tę rolę. Błędy i rollback nadal można raportować niezależnie od WorkerLink.

Obsługę `process.execve` obejmują testy skompilowanych binariów uruchamiane
z Bun przypiętym w `mise.toml`. Mechanizm działa również na pierwszym planie bez
systemd/launchd. Brak API lub błąd `execve` pozostawia dotychczasowy supervisor
aktywny (po błędzie uruchamia on ponownie potwierdzone dziecko), wyłącza dalsze
próby przekazania w tym procesie i zapisuje komunikat o potrzebie restartu usługi.
Nie uruchamia niepotwierdzonego executable przez `execve`; kolejna aktualizacja
zachowuje własny watchdog i rollback. Sprawdza też, czy plik nie został ponownie
podmieniony od startu potwierdzonego dziecka.

Potwierdzenie startupu jest wysyłane także wtedy, gdy wynik aktualizacji został już
zgłoszony albo binarka na dysku była potwierdzona przed startem dziecka. Starszy
supervisor z tym mechanizmem przechodzi wówczas na wersję dziecka jeden raz;
zgodne wersje nie wywołują kolejnego przekazania. **Supervisor sprzed dodania tego
mechanizmu wymaga jednego ręcznego restartu usługi**, żeby załadować jego obsługę.
Nie da się zmienić kodu procesu, który nie zna protokołu przekazania.

Worker raportuje utrwalony sukces/błąd przed następnym Watch.
Jeśli raport sukcesu zaginie, zgodny handshake WorkerLink na dokładnej wersji
zapisanego polecenia i celu kończy utrwalone `restarting` jako `succeeded`.
Sam reconnect UpdateService nie dowodzi zdrowego startu; inna wersja,
niezgodny protokół i zapisany błąd/rollback nie są w ten sposób kasowane.
Metadane UI i polecenia pozostają w istniejącym JSONB `workers.capabilities`
(`update`, `updateCommand`); migracja schematu nie jest potrzebna.

## Instalacja i konfiguracja

Ten sam mirror zasila nową instalację: uwierzytelniony BFF wywołuje dodany
`GatewayService.FetchWorkerInstall`, a publiczne `/install/worker/<os>/<arch>` przekazuje
strumień binarki. `?sha256=1` zwraca hash z manifestu dokładnej wersji gatewaya. Nie zmienia
to zamrożonego `UpdateService` ani nie wymaga credentialu jeszcze nieutworzonego workera.
Dozwolone platformy instalatora: Linux x64/arm64 i macOS x64/arm64. Brak wydania/mirrora
kończy pobieranie błędem HTTP; kreator i SSH preferują manifest dokładnej wersji gatewaya,
także prerelease `vX.Y.Z-nightly.N` i `vX.Y.Z-beta.N`. Brak publikacji uruchamia wybór
najnowszego wydania kanału zgodnego z WorkerLink i UpdateService oraz z binarką docelowej platformy.
Kreator i output SSH podają wersję zastępczą. SSH przesyła adres HTTPS GitHub i SHA-256
przez uwierzytelnione stdin, bez zdalnego dostępu do lokalnego BFF desktopu.
Skrypt zawsze weryfikuje checksum przed wykonaniem binarki; przekierowania GitHub wymagają HTTPS.

| Ustawienie | Znaczenie |
|---|---|
| `CANOPY_VERSION` | Wspólna wersja, wstrzykiwana przez pipeline. |
| `CANOPY_UPDATE_CHANNEL` | Kanał początkowy, domyślnie `stable`; `beta`, `nightly` lub stabilny pin. Zapisany wybór administratora ma pierwszeństwo. |
| `CANOPY_RELEASE_BASE_URL` | Alternatywny HTTPS endpoint o układzie API GitHub (mirror/testy). Worker używa go do porównania historii wydań przy zmianie kanału. |
| `CANOPY_UPDATE_CACHE_DIR` | Katalog cache gatewaya; ma pierwszeństwo przed `$XDG_CACHE_HOME/canopy/releases` i `~/.cache/canopy/releases`. Brak zapisu powoduje jedno ostrzeżenie i przejście na prywatny, nietrwały katalog pod `os.tmpdir()`. Jeśli on też jest niedostępny, UI dostaje konkretny błąd zamiast informacji o braku połączenia. |
| `CANOPY_INSTALL_KIND=docker` | Jawnie oznacza kontener; runtime rozpoznaje też `/.dockerenv` i `/run/.containerenv`, a poza kontenerem standalone Bun albo checkout źródeł. |

Samoczynna wymiana obsługuje binarki **Linux/macOS** z zapisywalnym katalogiem
instalacji i zwykłym executable (bez symlinków). Kontener pokazuje „Pull the new
image tag and recreate this container”; source — aktualizację checkoutu,
`bun install` i restart. Nie podmieniają plików uruchomieniowych.
**Windows wymaga na razie zewnętrznego instalatora/usługi** ze względu na blokadę
uruchomionego `.exe`; worker zgłasza `managed_externally`.

## CLI dostawców

Wydania Canopy nie zawierają CLI dostawców (`claude`, `codex`, `grok`). Ich osobne
instalacje i aktualizacje na kliknięcie, źródła najnowszych wersji i przepisy opisuje [provider-cli.md](provider-cli.md).

## Granice i dalsze prace

- SHA-256 zabezpiecza integralność względem manifestu dostarczonego z zaufanego
  HTTPS/gatewaya. Niezależny podpis manifestu wymaga zaufanego klucza wydawcy
  i wdrożenia w kolejnych wydaniach; obecny pipeline nie publikuje takiego podpisu.
- Samoczynna wymiana Windows wymaga osobnego instalatora, który przeżywa zatrzymanie
  procesu i potrafi uruchomić usługę oraz rollback.
- Rollback obejmuje executable, nie migracje bazy. Release wymagający nieodwracalnej
  migracji musi mieć osobny plan wdrożenia; migracje muszą tolerować powrót binarki.
- Testy obejmują lokalny fixture release, realny gRPC i PostgreSQL oraz skompilowane
  binaria: A → B → C z niezmiennym PID supervisora, oczekiwanie na pracę w toku,
  rollback przed potwierdzeniem, start ze starszym supervisorem i brak pętli
  restartów. Rzeczywiste publikacje GHCR/GitHub Releases należą do pipeline.
