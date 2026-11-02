# Sekrety wątków

## Badanie T3 Code (2026-11-02)

Źródło: publiczne repozytorium [pingdotgg/t3code](https://github.com/pingdotgg/t3code),
commit `ac8dce0cc3abd8a337f2d806b5082a6834b9b81a`. Kod odczytany z tymczasowego
klonu, bez uruchamiania aplikacji i bez modyfikowania źródeł.

- `packages/contracts/src/orchestratorMcp.ts`: `request_secret` przyjmuje `label`,
  `reason`, opcjonalne `placeholder`, `delivery` (`secretRef` domyślnie lub `file`),
  `timeoutMs` (domyślnie 10 minut, maksymalnie godzina), `clientRequestId`.
  Zwraca status i jednorazowe `secretRef` albo ścieżkę `file`; nigdy wartość.
- `apps/web/src/components/chat/SecretRequestCard.tsx`: karta w osi czasu, tytuł,
  opis, maskowane pole, przyciski „Save securely” i „Decline”. Pole to stylowany
  input tekstowy z `-webkit-text-security: disc`, `autocomplete=off` i flagami
  ignorowania przez menedżery haseł. Stan komponentu jest czyszczony po zapisie.
  Błędy transportu są zastępowane ogólnym komunikatem, bez logowania requestu.
- `packages/client-runtime/src/secretRequest.ts`: dla pliku komunikat
  „Kept out of chat, in a private file this agent's commands can read for 24 hours”.
  Odmowa zapisuje wyłącznie status `declined`. Fork pokazuje oczekiwanie w wątku
  źródłowym; nie pozwala odpowiedzieć na odziedziczoną kartę.
- `apps/server/src/secrets/SecretRequests.ts`: status karty jest oddzielony od
  wartości. Referencja powstaje z HMAC identyfikatora wątku i karty. Osobny magazyn
  zapisuje wartość, projekt i czas zapisu; konsumpcja `secretRef` jest jednorazowa
  i sprawdza projekt. Dostarczenie pliku przenosi wartość do prywatnego katalogu
  `files`, używa pliku tymczasowego `wx`, `0600`, katalogu `0700` i rename.
  Powtórzenie z tym samym kluczem zwraca ten sam plik.
- `apps/server/src/auth/ServerSecretStore.ts`: ten magazyn używa plików `.bin`
  chronionych prawami systemowymi (`0700`/`0600`); w badanej implementacji nie
  znaleziono szyfrowania zawartości tego magazynu. Nie należy opisywać go jako
  szyfrowanego tylko na podstawie tekstu „Stored securely”.
- TTL referencji wynosi 24 godziny od zapisu. Pliki są sprzątane według mtime;
  sweep na starcie i co godzinę oznacza, że fizyczne usunięcie może być późniejsze
  niż 24 godziny. Zakończenie przebiegu, błąd lub timeout zamyka oczekującą kartę.
  Nie znaleziono mechanizmu maskowania outputu powiązanego z konkretną wartością
  sekretu ani akcji cofnięcia dostępu na tej karcie. Wynik narzędzia i projekcja
  przechowują wyłącznie referencję/status; komenda, która wypisze plik, pozostaje
  istotnym ryzykiem.

## Projekt Canopy

`request_secret` jest narzędziem platformy dla obu harnessów. Przyjmuje `label`,
`description`, opcjonalny `placeholder`, `name` (podpowiedź nazwy zmiennej,
bez automatycznego eksportowania środowiska) i `request_id` do odnawiania
oczekiwania. Trwały request należy wyłącznie do wywołującego wątku.
Ograniczone oczekiwanie można ponawiać; restart nie usuwa pytania.

Karta znajduje się nad composerem, w istniejącym stosie paneli. Użytkownik widzi
oczekujące działanie bez szukania w przewijanej osi czasu. Wartość istnieje tylko
w pamięci kontrolki i żądania HTTPS BFF → gateway. Nie zapisujemy jej w draftach,
localStorage, wiadomościach, interakcjach `ask_user`, notatkach, wynikach narzędzi
ani zdarzeniach. Po zapisie karta pokazuje termin dostępności i cofnięcie dostępu.
Stan kontrolki jest czyszczony po wysłaniu i przy opuszczeniu karty.

Gateway szyfruje wartość AES-256-GCM istniejącym `OA_SECRETS_KEY`. Do workera
przechodzi osobnym komunikatem istniejącego połączenia gRPC, poza trwałym outboxem
komend i dziennikiem zdarzeń. Worker zapisuje plik `0600` w katalogu `0700` poza
workspace. Model otrzymuje tylko ścieżkę, termin i instrukcję użycia wewnątrz
komendy, np. `TOKEN="$(cat '<path>')" program`, bez drukowania wartości.
Nie dodajemy sekretu do env procesu harnessu (wspólnego dla wielu wątków).

Domyślny TTL to 24 godziny. Cofnięcie/wygaśnięcie usuwa szyfrogram z gateway
i plik workera; odłączony worker nie może otrzymać cofnięcia natychmiast, dlatego
lokalnie egzekwuje również termin. Ponowne połączenie synchronizuje stan.
Po restarcie worker usuwa stare materializacje i odtwarza wyłącznie nadal ważne.
Nie da się cofnąć kopii wykonanej już przez uruchomioną komendę ani wyczyścić
wartości z pamięci obcego procesu.

Wątki boczne i forki nie dziedziczą przydziałów ani automatycznego dostarczenia.
Agent w nowym wątku prosi ponownie. Prawa POSIX izolują od innych użytkowników
systemu, nie od procesów tego samego użytkownika: dedykowany użytkownik workera
pozostaje granicą zaufania. Znajomość ścieżki nie jest silną izolacją między
wrogimi agentami mającymi pełny shell na tym samym koncie.

Migracja: `0036_thread_secrets` (main kończył się na `0032`; numery `0033–0035`
są pozostawione dla równoległych prac). Nowe pola istniejących wiadomości proto
korzystają z zakresu `500–519`.

Szczegóły faktycznej weryfikacji, sandboxów i ograniczeń redakcji zostaną
uzupełnione po implementacji.
