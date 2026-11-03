# Rutyny botów — implementacja i weryfikacja

Gałąź `feat/bot-routines`, 2026-11-02. Zmiany lokalne, bez push i PR.

## Rezultat i decyzje

Bot sam zarządza rutynami przez `create_routine`, `update_routine`, `list_routines`
i `delete_routine`. Człowiek w panelu może tylko włączyć, wyłączyć albo usunąć rutynę.
Tworzenie i edycja nie wymagają karty zgody; prompt wymaga zamiaru człowieka i zabrania
uznawania wyników narzędzi lub wiadomości innych botów za upoważnienie.
Warunki powiadamiania pozostają instrukcjami rutyny.

Ukryte wykonanie jest trwałą turą `bot_turns`, z wejściem, checkpointem i historią
narzędzi w bazie. Wejście ani odpowiedź końcowa nie trafiają do czatu. Model otrzymuje
stałe instrukcje bota, 60 ostatnich widocznych wiadomości, kopię instrukcji rutyny,
termin/czas/strefę, numer wykonania i poprzedni wynik. Nie dostaje poprzednich ukrytych
transkryptów. Follow-up od bota, wątku i pobudki zachowuje ukryte pochodzenie.

`message_user` atomowo zapisuje normalną wiadomość i wynik narzędzia. Restart po zapisie
nie powiela wiadomości. Wiadomość zwiększa unread; ukryte wykonanie go nie zmienia.
Widoczna karta rozmowy potwierdza przeczytany snapshot przez `MarkBotRead`.
Zwykła odpowiedź końcowa zwykłej tury nadal jest widoczna. Prawdziwe pytania i zgody
pozostają widoczne z oznaczeniem „From routine ‹title›”.

Rutyny współdzielą istniejącą kolejkę FIFO i lease bota, więc nie przeplatają narzędzi
z turą użytkownika. Claim wystąpienia, enqueue i przesunięcie terminu są jedną
transakcją. Restart/wiele gatewayów nie dubluje wystąpienia. Zaległości łączą się
w jedno wykonanie; aktywna rutyna nie buduje kolejki następnych terminów.

Migracja **0039** dodaje rutyny, pochodzenie tur i trwały znacznik odczytu.
Rutyny są usuwane miękko. Limit: **20** nieusuniętych rutyn na bota, co najmniej
**15 minut**, maksymalnie **8 hops**. Domyślna strefa **UTC**, zgodnie ze schedulerem
wątków; brak ustawienia strefy użytkownika/bota. Narzędzie przyjmuje IANA i prompt
nakazuje ustalić niejednoznaczny czas lokalny. Serwer generuje angielski opis crona.
Pola istniejących komunikatów mieszczą się w **560–599**.

## Panel i pass componentize

Prawa kolumna 336 px od 1024 px; poniżej istniejący Dialog/dolny panel. Desktopowy
stan otwarcia jest zapisany w localStorage per właściciel. Na telefonie panel nie
otwiera się automatycznie. Grupy i wymiany bot–bot nie mają przełącznika panelu.
Duża maskotka, model/dostawca, ustawienia, rutyny i anulowalne przypomnienia są
aktualizowane istniejącym SSE. Jest slot na przyszłe Connections.

Zastosowano `design`, `transitions-dev` i dedykowany pass `componentize` przed końcowym
commitem. Wydzielono `BotDetailsLayout`, `BotDetailsPanel`, `DetailsSection`,
`RoutineRow`, `ReminderRow`; każdy przyjmuje `class`. Kontrolki korzystają ze wspólnego
zestawu UI, w tym Switch, menu i potwierdzenia. Animacje szerokości/pojawiania
respektują reduced motion. `BotConnections.svelte` i `McpServerForm.svelte` nietknięte.
Nie dodano web UI testów ani plików `*.browser.test.ts`.

## Commity

| Commit | Zakres |
|---|---|
| `383f7d1` | Trwałe ukryte rutyny, narzędzia, kontrakt, migracja i integracje |
| `13f0d6c` | Responsywny panel, komponenty i akcje UI |
| `86ada61` | Rzeczywisty unread, owner-scoped odczyt, zatrzymany wynik i testy |
| `e6af963`, `d360945` | Scalenia main; końcowa weryfikacja po `463cd1873a6ef167838b290b6a4b84c32685b0f6` |

Końcowy commit dokumentacyjny zawiera ten raport.

## Weryfikacja automatyczna

`bun install`, `bun run typecheck`, `bun run gen:check` i web build przeszły.
Svelte: 0 błędów i 0 ostrzeżeń. Build zgłasza istniejące ostrzeżenie rozmiaru chunka
ponad 500 kB oraz konflikt NO_COLOR/FORCE_COLOR, kończy się kodem 0.

Zestaw `check:tmp`:

```sh
bun run check:tmp tests/integration/bot-routines.test.ts tests/integration/bots.test.ts tests/integration/bots-settings.test.ts tests/integration/bot-platform-tools.test.ts packages/db/test/schema.test.ts apps/gateway/src/bots/policy.test.ts
```

**82 pass, 0 fail, 679 asercji**, 6 plików, 113,86 s. `check:tmp: nothing left in
the temp dir`. Zakres obejmuje nowe rutyny, istniejące rozmowy/ustawienia/narzędzia
botów, schemat bazy i politykę narzędzi.

Dziewięć integracji rutyn korzysta z rzeczywistego PostgreSQL/gateway i wstrzykniętego
zegara/modelu. Obejmują utworzenie przez tool, termin, ciszę/kontekst/audyt/SSE,
pojedynczą wiadomość po checkpoint restart, unread, disable/delete także po enqueue
i podczas inferencji, konkurencyjne claimy, restart, scalanie zaległości, kolejkę
za człowiekiem, attribution pytania, owner/bot scoping, ukryty follow-up od innego
bota, limity odstępu/liczby/strefy/hops i częściowe edycje. Test migracji wymienia 0039.

Live przez CLIProxyAPI, bez ujawniania hosta/klucza:

```sh
CANOPY_LIVE=1 bun --env-file=/home/nix/.config/open-agents/dev-live.env test tests/integration/bot-routines.live.test.ts
```

**1 pass, 0 fail, 11 asercji**. Prawdziwy `gpt-6.1-sol` utworzył `*/15 * * * *`, UTC,
z instrukcjami warunkowego powiadomienia. Ręcznie wyzwolony termin przy zdrowym
snapshot `Y=false` zakończył się „Nothing to report”, bez wiadomości ani karty.
To sprawdza prawdziwą decyzję modelu dla kontrolowanego snapshotu; nie sprawdza
zewnętrznego monitorowanego systemu ani dostarczenia systemowego push.

## Oględziny Chromium

`/usr/bin/chromium`, Playwright Core z `/tmp/ro-shot/node_modules/playwright-core`,
nagłówek `x-forwarded-proto: http`. Jednorazowy helper poza repo, bez nowego test suite.
Własny PostgreSQL **25439**, gateway **28443**, web **5289**. Nie używano
`/tmp/oa-stack` ani portów 17443/5180/8444. Po oględzinach zatrzymano własne procesy
i kontener, zamknięto własne karty preview. PNG pozostały w `/tmp`.

Oba motywy, szerokości 1440/390 px, panel otwarty/zamknięty i pusty stan: bez błędów
strony i poziomego przepełnienia. Sprawdzono zapis zamknięcia po reload, ustawienia,
mobilne otwarcie/zamknięcie, pauzę przez API/SSE, cofnięcie Switch po HTTP 503 oraz usunięcie
z potwierdzeniem i pusty stan bez reload. Kontrolę powtórzono po unread i merge main.

| Stan | Jasny | Ciemny |
|---|---|---|
| Desktop otwarty | [PNG](/tmp/canopy-bot-routines-evidence/desktop-light-open.png) | [PNG](/tmp/canopy-bot-routines-evidence/desktop-dark-open.png) |
| Desktop zamknięty | [PNG](/tmp/canopy-bot-routines-evidence/desktop-light-closed.png) | [PNG](/tmp/canopy-bot-routines-evidence/desktop-dark-closed.png) |
| Telefon otwarty | [PNG](/tmp/canopy-bot-routines-evidence/mobile-light-open.png) | [PNG](/tmp/canopy-bot-routines-evidence/mobile-dark-open.png) |
| Telefon zamknięty | [PNG](/tmp/canopy-bot-routines-evidence/mobile-light-closed.png) | [PNG](/tmp/canopy-bot-routines-evidence/mobile-dark-closed.png) |

Dodatkowo: [pauza](/tmp/canopy-bot-routines-evidence/desktop-light-paused.png),
[pusty desktop](/tmp/canopy-bot-routines-evidence/desktop-light-empty.png),
[pusty telefon](/tmp/canopy-bot-routines-evidence/mobile-dark-empty.png).
[Log build](/tmp/canopy-bot-routines-evidence/web-build.log).

## Ograniczenia i pytania

Brak blokujących pytań. Wyłączenie anuluje dalsze lokalne efekty i oczekujące karty,
ale nie cofa już wysłanej zdalnej akcji. Preferencje powiadamiania są interpretowane
przez model; nie ma dodatkowej mechanicznej reguły ważności. UTC jest domyślne do czasu
wprowadzenia ustawienia strefy. Powiadomienie to widoczna wiadomość i unread w Canopy;
ta zmiana nie wprowadza powiadomień systemu operacyjnego. Pełnego zestawu repo i web
UI testów nie uruchamiano; użyto zakresu wskazanego w zadaniu i ręcznych oględzin.
