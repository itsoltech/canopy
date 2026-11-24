# Powiadomienia wątków i botów

Aktualizacja (2026-11-24): nowe sugestie Habits mają powiadomienie w aplikacji
i licznik oczekujących sugestii w ustawieniach.

Status (2026-11-23): kod iOS/Android obsługuje push z podglądem szyfrowanym od
gatewaya do telefonu. Funkcja wymaga nowego buildu natywnego i konfiguracji relaya.
Lokalny Desktop domyślnie używa relaya Canopy. W webie serwerowym i w obu
trybach Desktopu można wybrać relay Canopy albo skonfigurować własny w Network access.
Relay Canopy obsługuje też automatyczną ponowną atestację i odwołanie poświadczeń.
Alerty w aplikacji pomijają uśpione wątki w web/desktop i mobile. Na iOS i Androidzie
baner powiadomienia można zamknąć przesunięciem w górę.
Web/desktop wysyła powiadomienia tylko z włączonych modułów. Na macOS wybór alertów
systemowych w ustawieniach Canopy wywołuje natywne pytanie o zgodę.
Powiadomienia wątków obejmują
tylko wątki główne i wątki boczne użytkownika. Toasty web/desktop są kartami w prawym dolnym
rogu, z osobnym nagłówkiem zdarzenia, nazwą i akcją pod treścią oraz większą ikoną
statusu, bez wyłączania przeciągania okna desktopu. Opis dotyczy kodu; dostępność
nightly/beta/stable określają [wydania](release.md).

Web i desktop pokazują alerty systemowe o wątkach i botach, gdy otwarte jest okno
Canopy. Na telefonie push działa także poza otwartą aplikacją.
Kod: `apps/web/src/lib/features/notifications`, `apps/desktop/src/notifications.ts`,
`apps/gateway/src/store/thread-notice.ts`, `packages/domain/src/notice-preview.ts`.

## Zdarzenia i teksty

| Źródło | Zdarzenie | Tytuł | Treść | Toast w aplikacji |
|---|---|---|---|---|
| Wątek | koniec tury | tytuł wątku (`Untitled thread`) | `Finished · ‹projekt›` + podgląd odpowiedzi | `Thread completed` |
| Wątek | błąd tury | jw. | `Failed · ‹projekt›` + podgląd błędu | `Thread failed` |
| Wątek | tura zatrzymana przez system | jw. | `Stopped · ‹projekt›` + podgląd | `Thread stopped` |
| Wątek | zgoda | jw. | `Needs your approval · ‹projekt›` + powód, opis albo komenda | `Thread needs your approval` |
| Wątek | pytanie lub formularz | jw. | `Needs your answer · ‹projekt›` + pierwsze pytanie | `Thread needs your answer` |
| Bot | wiadomość do użytkownika | nazwa bota | podgląd wiadomości | `New bot message` |
| Bot | karta zgody | nazwa bota | `Needs your approval` (+ `· From routine “‹rutyna›”`) + akcja z karty | `Bot needs your approval` |
| Bot | pytanie `ask_user` | nazwa bota | `Needs your answer` (+ rutyna) + pytanie | `Bot needs your answer` |

Miejsce wątku to nazwa projektu (bez systemowego No project), a dla wątku połączonego
komputera `‹projekt› on ‹komputer›`. Toast ma akcję `Open thread` albo `Open chat`.
Pod nagłówkiem toastu widnieje tytuł wątku albo nazwa bota, bez cudzysłowu.
Wiadomość bota obejmuje odpowiedź, `message_user` rutyny, przypomnienie i odpowiedź
z wymiany bot–bot skierowaną do użytkownika. Wiadomości między botami i błędy odpowiedzi
nie powiadamiają. Tury zatrzymanej przez użytkownika (`Thread.interrupted_by_user`) też nie.

Kliknięcie otwiera `/threads/<id>` albo `/bots/<id>`. Wątek otwiera się na końcu osi
czasu z odpowiedzią, a oczekujące zgody i pytania są zadokowane nad kompozytorem.
Rozmowa bota otwiera się przy pierwszej nieprzeczytanej wiadomości, a karty są na końcu.

## Podglądy i prywatność

`noticePreview` robi z tekstu jedną linię, najwyżej **140 znaków**, ucinaną na słowie.
Usuwa bloki kodu, HTML i znaczniki markdown. Link zostawia tekst, a goły URL tylko host.
Kończy linie kropką i maskuje dane logowania tak jak szczegóły błędów
(`redactCredentials`: Bearer, `key=value` dla kluczy/tokenów/haseł, `sk-…`, `xai-…`).
Błąd tury przechodzi najpierw przez `safeFailureDetail`. Karta zgody bota daje tylko
pierwszą linię (akcję), bez argumentów. Aplikacja nie ma opcji ukrywania treści, a systemy
same ukrywają podgląd zgodnie z ustawieniem ekranu blokady (np. macOS „Show previews”).

Gateway liczy podgląd wątku w `threadSelect` (pola `Thread` 1000–1002) tylko dla wątku
z czymś do pokazania: najnowsze żądanie do człowieka albo nieobejrzana tura. Po
`MarkThreadSeen` podgląd znika, więc overview nie rośnie o stare odpowiedzi. Wątek
z połączonego komputera dostaje pola z gatewaya domu. Starszy dom daje pusty podgląd
i ogólny tekst zdarzenia. `ListBots` niesie `Bot.pending_approval`: najnowszą
oczekującą kartę bez pól i propozycji, tylko właściciela. Offline lustro bierze ją
z zapisanej rozmowy.

## Kiedy powiadamiamy

- **Wątki** idą na żywo z `WatchOverview`. Snapshot, reconnect i `computer_snapshot`
  ustalają stan bazowy. Alarmuje tylko przejście już widocznego wątku: nowe żądanie
  do człowieka (także drugie z kolei) albo nowy wynik tury.
  Powiadamiają wątki główne oraz wątki boczne utworzone przez użytkownika.
  Subagenci (`Thread.spawned_by_agent = true`) nie generują toastów, alertów
  systemowych ani dźwięku — także przy błędzie, zatrzymaniu lub pytaniu skierowanym
  do człowieka. Ich wyniki i oczekujące interakcje pozostają widoczne w wątku rodzica.
  Uśpiony wątek i jego wątki boczne nie pokazują alertów ani toastów i nie odtwarzają
  dźwięku. Wybudzenie nie odtwarza zdarzeń z okresu uśpienia. Zachowany stan odczytu
  i oczekujące interakcje są widoczne po otwarciu wątku. [Usypianie](threads.md#usypianie)
- **Boty** idą ze wspólnej listy botów (odświeżanej co 5 s i po `bots-changed`).
  Pierwsza lista jest bazą. Alarmuje nowa karta (późniejsza niż znana) albo wiadomość
  o wyższym `seq` od bota do użytkownika. Zdarzenia starsze niż 10 min to historia,
  np. po nadrobieniu lustra lub wybudzeniu komputera. Odpowiedź `GetBot` bez ostatniej
  wiadomości nie cofa znanego stanu.
- Wiadomość bota już przeczytana na innym urządzeniu (`unread_count = 0`) nie
  pokazuje alertu. Okno, które ją wyświetla, nadal gra dźwięk.

## Toasty w aplikacji

W webie i na desktopie `shared/ui/Toaster.svelte` pokazuje krótkie potwierdzenia i powiadomienia
w prawym dolnym rogu okna, 16 px od krawędzi lub poza systemowym safe area.
Na telefonie karta mieści się między bocznymi wcięciami; na desktopie ma 24 rem
szerokości. Nagłówek zdarzenia i zamknięcie zajmują pierwszy wiersz, a opcjonalny
opis zawija się pod nim. Akcja ma własny wiersz pod treścią, wyrównany do prawej,
więc nie zwęża tekstu. Krótkie potwierdzenia bez opisu zachowują pojedynczy wiersz.
Karta ma padding 12 px w obu osiach przy domyślnej skali i ikony statusu 20 px.
Koniec tury pokazuje zielone kółko z haczykiem, błąd — czerwony wykrzyknik,
a pozostałe zdarzenia — niebieską ikonę informacji. Nagłówek zawsze nazywa zdarzenie.
Jasny i ciemny motyw mają własne tło, obrys i kolory ikon.

Toast ma opcjonalną akcję (`Undo`, `Open thread`, `Open chat`) i przycisk
`Dismiss notification`. Nowy zastępuje poprzedni w tym samym miejscu, bez
przesuwania zawartości strony. Potwierdzenie znika po 2 s, z akcją po 6 s;
wybranie akcji albo zamknięcia rozpoczyna wcześniejsze znikanie.
Animacja korzysta ze wspólnych tokenów i respektuje `prefers-reduced-motion`.

Kontener przepuszcza kliknięcia poza kartą. Toast nie ma `data-window-no-drag`,
bo leży poza paskami tytułu i nie powinien zawieszać przeciągania całego okna.

### Sugestie Habits

Gdy podczas pracy w Canopy pojawi się nowa sugestia gotowa do przeglądu,
web, desktop i mobile pokazują powiadomienie z akcją `Review habits`.
Akcja otwiera Settings → Memory. Powiadomienie respektuje `In-app notifications`
i jest pomijane, gdy użytkownik już ogląda Memory. Przy pierwszym odczycie
i po ponownym połączeniu aplikacja odtwarza licznik bieżących sugestii.
Rozstrzygnięcie lub utrata podstawy sugestii zmniejsza licznik.
Zdarzenie pozostaje w aplikacji. [Refleksja](agent-memory.md#refleksja)

## Fokus i dźwięk

Użytkownik „patrzy” na wątek lub rozmowę, gdy okno ma fokus, jest widoczne i pokazuje
tę ścieżkę. Dotyczy to tej karty albo innej karty lub okna tego originu: okno
z fokusem zapisuje swoją ścieżkę w `localStorage` (`canopy:notifications:viewing`,
odświeżane co 5 s, ważne 15 s). Wtedy nie ma alertu ani toastu, ale przy wyborze
**Notifications with sound** gra jeden dźwięk. Opiekun często trzyma wątek otwarty
i patrzy w telefon, więc słyszy koniec tury lub prośbę o zgodę. Osobna opcja nie
jest potrzebna: dźwięk wynika z tego samego wyboru dla wątków albo botów.

Okno z fokusem na innym widoku dostaje toast (gdy **In-app notifications** = On) i alert
systemowy. Dźwięk w przeglądarce wymaga gestu po każdym przeładowaniu (kliknięcie
lub klawisz). Desktop gra dźwięk alertu przez system, a dźwięk bez alertu przez
Web Audio okna.

## Bez duplikatów

Każde zdarzenie ma klucz wspólny dla kart, okien i komputerów, z identyfikatorem bez
kwalifikatora komputera (`~node`): `thread:<id>:<zdarzenie>:<last_seq>:<pending>`,
`bot:<id>:message:<seq>`, `bot:<id>:<approval|answer>:<id karty>`.

- Pierwsza karta bierze Web Lock `canopy:notice:<klucz>` z `ifAvailable` i trzyma
  go 15 s. To pokrywa niezsynchronizowane odpytywanie botów w innych kartach. Blokady
  koordynuje przeglądarka; `localStorage` synchronizuje się między procesami z opóźnieniem.
- Klucz trafia też do `canopy:notifications:sent` na 30 min, dla kart, które dostaną
  to samo zdarzenie później (przeładowanie, reconnect).
- Toast pokazuje tylko okno z fokusem. Dźwięk przy oglądaniu też bierze klucz, więc
  gra raz.
- Web `Notification` ma `tag` z kluczem, więc system zastępuje powtórkę zamiast dodać drugą.
- Desktop: proces main pamięta klucze 30 min, więc okna o różnych originach i
  przeładowane okno nie pokażą zdarzenia drugi raz.

Ten sam wątek widziany na dwóch komputerach (dom i połączony) może dać alert na każdym
z nich. To osobne urządzenia; na jednym komputerze zdarzenie pokazuje się raz.

## Desktop

Renderer wywołuje `canopyDesktop.showNotification({ key, title, body, path, sound })`
(IPC `canopy:notification`) wyłącznie z autoryzowanej ramki aplikacji. Main sprawdza
schemat: klucz, tytuł do 200 i treść do 600 znaków. Przyjmuje tylko ścieżkę
`/threads/<id>` albo `/bots/<id>`. Pokazuje natywny `Notification` z nazwą aplikacji
(`app.setName`), na Linuksie z ikoną aplikacji, a na macOS z ikoną paczki. Kliknięcie
przywraca i fokusuje okno nadawcy, potem wysyła ścieżkę (`canopy:notification-click`),
a renderer nawiguje. Uprawnienie `notifications` w `window-permissions.ts` zostaje
rezerwą dla Notification API strony.

Na macOS proces main odczytuje zgodę i prosi o nią przez `UNUserNotificationCenter`
z paczki bieżącego kanału. Alerty o wątkach, botach i aktualizacjach wymagają zgody,
więc zdarzenie w tle nie wywołuje okna systemowego.

## Ustawienia

Settings → General → Notifications ([settings-map.md](settings-map.md)), osobno na
urządzeniu (`localStorage`): **Thread notifications** i **Bot notifications** (Off,
Notifications, Notifications with sound) oraz **In-app notifications**. Włączenie
alertów o wątkach lub botach prosi o zgodę przeglądarki w webie albo systemu na macOS.
Canopy zapisuje nowy wybór po uzyskaniu zgody. Gdy wybór został zapisany wcześniej,
a macOS nadal czeka na decyzję, przycisk `Enable notifications` pod pierwszym
włączonym wierszem wywołuje pytanie. Po odmowie Canopy wskazuje panel Notifications
w ustawieniach systemu i sprawdza zgodę ponownie po powrocie do okna.
Każdy wybór obejmuje wszystkie zdarzenia danego modułu. Preferencje „powiedz mi
tylko gdy…” bot trzyma w instrukcjach
([bots.md](bots.md)).

## Push na iOS i Androidzie

**Settings → General → Notifications → System notifications** jest ustawieniem
sparowanego telefonu, domyślnie wyłączonym. Włączenie prosi o zgodę systemu.
Powiadomienie pokazuje tytuł wątku lub nazwę bota i krótką, oczyszczoną treść.
System decyduje o widoczności podglądu na ekranie blokady. Podczas pracy w Canopy
pozostają alerty w aplikacji. Dotknięcie powiadomienia otwiera rozmowę przez
sparowany gateway, jeśli telefon ma do niego trasę.

Relay Canopy wydaje poświadczenie automatycznie po weryfikacji aplikacji przez
Apple App Attest lub Google Play Integrity. Użytkownik włącza powiadomienia
na sparowanym telefonie i zatwierdza zgodę systemu. Weryfikacja używa jednorazowego
wyzwania powiązanego z platformą i tokenem Expo uzyskanym przez ten telefon.
Wydane poświadczenie może wysyłać powiadomienia tylko do zweryfikowanego celu.
Gateway zapisuje je zaszyfrowane i odnawia przed wygaśnięciem. Poświadczenie
można odnawiać na okresy do 35 dni przez maksymalnie 90 dni od ostatniej atestacji.
Przed końcem tego okresu aplikacja ponawia atestację automatycznie przy zwykłym
otwarciu Canopy. Dotychczasowe poświadczenie działa do wygaśnięcia także wtedy,
gdy dostawca atestacji jest chwilowo niedostępny. Aplikacja zachowuje wybór
użytkownika i zgody systemu. Przy własnym relayu gateway używa poświadczenia
skonfigurowanego przez operatora.

Push powstaje na sparowanym gatewayu po zakończeniu, błędzie lub systemowym
przerwaniu tury, prośbie o zgodę lub pytaniu z wątku oraz po wiadomości, prośbie
o zgodę lub pytaniu bota. Lokalna transakcja zapisuje identyfikatory zdarzenia
i urządzeń w kolejce. Filtry uwzględniają włączone moduły, archiwum,
subagentów, odczytane wyniki i rozstrzygnięte interakcje. Kolejka przeżywa restart.
Wyciszenie wątku wstrzymuje wysyłkę oczekujących alertów z tego wątku i jego
ręcznych wątków bocznych. Zdarzenia z okresu wyciszenia nie trafiają do kolejki.
Lustra połączonych komputerów nie tworzą nowych powiadomień. Próby wysłania
trwają do 5 min, a dostawca może dostarczyć push przez kolejne 10 min.
Identyfikator można odczytać przez dobę i tylko z tego samego parowania.
Przy utracie odpowiedzi dostawcy ponowienie może spowodować powtórne doręczenie.

### Prywatność transportu i podglądu

Telefon tworzy 256-bitowy klucz podglądu dla bieżącego parowania i przekazuje go
gatewayowi po przypiętym TLS wraz z tokenem Expo. Gateway szyfruje oba w bazie
kluczem `CANOPY_SECRETS_KEY`. Podgląd powstaje dopiero przy wysyłce.
Gateway szyfruje go przez AES-256-GCM z losowym nonce i uwierzytelnia razem
z losowym identyfikatorem powiadomienia. Żądanie do relaya używa TLS 1.3
z weryfikacją certyfikatu i osobnego poświadczenia instalacji.
Relay przekazuje zaszyfrowany podgląd do Expo Push Service, który dostarcza go
przez APNs albo FCM. Usługi pośredniczące obsługują dane dostawy, np. token urządzenia,
rozmiar i czas wysyłki. Tytuł i treść są dostępne gatewayowi oraz sparowanemu
telefonowi. Identyfikator rozmowy pozostaje na gatewayu.

Odszyfrowanie wykonuje rozszerzenie iOS albo natywna usługa Androida. Jeśli
odszyfrowanie jest niemożliwe, odebrany alert pokazuje „You have a new update.”.
Android po restarcie może wstrzymać doręczenia do pierwszego odblokowania.
Wyłączenie push usuwa klucz podglądu z telefonu i zapisuje wyrejestrowanie do
ponowienia, jeśli gateway jest niedostępny. Wyrejestrowanie i odwołanie parowania
unieważniają rejestrację na gatewayu. Gateway zapisuje również odwołanie
poświadczenia na relayu Canopy i ponawia je po odzyskaniu połączenia, również po
restarcie gatewaya. Wiadomości przyjęte już przez dostawcę mogą jeszcze dotrzeć.
Aplikacja odnawia 30-dniową ważność rejestracji, gdy użytkownik do niej wraca.

[Budowanie aplikacji](mobile.md#powiadomienia-push) · [Uruchomienie relaya](deploy.md#relay-powiadomień-push)

## Weryfikacja

- `tests/integration/thread-reads.test.ts`: podgląd pytania, oczyszczona i zamaskowana
  odpowiedź, `interrupted_by_user`, czyszczenie po `MarkThreadSeen`.
- `tests/integration/bots.test.ts`: `pending_approval` w `ListBots`, pusta lista innego
  właściciela, brak karty po odpowiedzi.
- `tests/integration/mobile-push.test.ts`: trwałe zdarzenie wątku, zaszyfrowany podgląd
  przez HTTPS, weryfikacja powiązania podglądu z identyfikatorem, izolacja urządzeń
  i aktywacja relaya z testowym weryfikatorem atestacji.
- `apps/push-relay/src`: testy relaya przez TLS, walidacja przykładów App Attest
  i weryfikacja werdyktów Play Integrity z symulowaną odpowiedzią Google.
- Ręcznie w Chromium: dwie karty, ta sama origin, alerty wątku i bota, oglądanie,
  przeładowanie. Linux: natywny alert przez D-Bus z nazwą i ikoną, kliknięcie.
  Koniec tury wątku głównego i bocznego użytkownika powiadamia; koniec tury,
  błąd, zatrzymanie i pytanie subagenta nie dają toastu, alertu systemowego ani dźwięku.
