# Powiadomienia wątków i botów

Web i desktop pokazują alerty systemowe o wątkach i botach, tylko gdy otwarte jest
okno Canopy. Push na telefon jest poza tym zakresem ([mobile.md](mobile.md)).
Kod: `apps/web/src/lib/features/notifications`, `apps/desktop/src/notifications.ts`,
`apps/gateway/src/store/thread-notice.ts`, `packages/domain/src/notice-preview.ts`.

## Zdarzenia i teksty

| Źródło | Zdarzenie | Tytuł | Treść | Toast w aplikacji |
|---|---|---|---|---|
| Wątek | koniec tury | tytuł wątku (`Untitled thread`) | `Finished · ‹projekt›` + podgląd odpowiedzi | `“‹tytuł›” finished.` |
| Wątek | błąd tury | jw. | `Failed · ‹projekt›` + podgląd błędu | `“‹tytuł›” failed.` |
| Wątek | tura zatrzymana przez system | jw. | `Stopped · ‹projekt›` + podgląd | `“‹tytuł›” stopped.` |
| Wątek | zgoda | jw. | `Needs your approval · ‹projekt›` + powód, opis albo komenda | `“‹tytuł›” needs your approval.` |
| Wątek | pytanie lub formularz | jw. | `Needs your answer · ‹projekt›` + pierwsze pytanie | `“‹tytuł›” needs your answer.` |
| Bot | wiadomość do użytkownika | nazwa bota | podgląd wiadomości | `“‹nazwa›” sent a message.` |
| Bot | karta zgody | nazwa bota | `Needs your approval` (+ `· From routine “‹rutyna›”`) + akcja z karty | `“‹nazwa›” needs your approval.` |
| Bot | pytanie `ask_user` | nazwa bota | `Needs your answer` (+ rutyna) + pytanie | `“‹nazwa›” needs your answer.` |

Miejsce wątku to nazwa projektu (bez systemowego No project), a dla wątku połączonego
komputera `‹projekt› on ‹komputer›`. Toast ma akcję `Open thread` albo `Open chat`.
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
- **Boty** idą ze wspólnej listy botów (odświeżanej co 5 s i po `bots-changed`).
  Pierwsza lista jest bazą. Alarmuje nowa karta (późniejsza niż znana) albo wiadomość
  o wyższym `seq` od bota do użytkownika. Zdarzenia starsze niż 10 min to historia,
  np. po nadrobieniu lustra lub wybudzeniu komputera. Odpowiedź `GetBot` bez ostatniej
  wiadomości nie cofa znanego stanu.
- Wiadomość bota już przeczytana na innym urządzeniu (`unread_count = 0`) nie
  pokazuje alertu. Okno, które ją wyświetla, nadal gra dźwięk.

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

## Ustawienia

Settings → General → Notifications ([settings-map.md](settings-map.md)), osobno na
urządzeniu (`localStorage`): **Thread notifications** i **Bot notifications** (Off,
Notifications, Notifications with sound) oraz **In-app notifications**. Oba wybory
proszą o zgodę przeglądarki. Ostrzeżenie o zgodzie i przycisk `Enable notifications`
są pod pierwszym włączonym wierszem. Wątki nie mają wyboru rodzajów zdarzeń, więc
boty też go nie mają. Preferencje „powiedz mi tylko gdy…” bot trzyma w instrukcjach
([bots.md](bots.md)).

## Weryfikacja

- `tests/integration/thread-reads.test.ts`: podgląd pytania, oczyszczona i zamaskowana
  odpowiedź, `interrupted_by_user`, czyszczenie po `MarkThreadSeen`.
- `tests/integration/bots.test.ts`: `pending_approval` w `ListBots`, pusta lista innego
  właściciela, brak karty po odpowiedzi.
- Ręcznie w Chromium: dwie karty, ta sama origin, alerty wątku i bota, oglądanie,
  przeładowanie. Linux: natywny alert przez D-Bus z nazwą i ikoną, kliknięcie.
