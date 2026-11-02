# Weryfikacja ask_user — 2026-11-02

Gałąź: `feat/ask-user`. Lokalny `main` scalony do `c03347a` (łącznie z subagentami dowolnego dostawcy, generowaniem tytułów, poprawką fixture sweep i powiadomieniami zadań w tle). Migracja: `0025_ask_user`; nowe pola istniejących kontraktów: 250. Bez push i PR. Migracja zachowuje narzędzia `list_background_tasks`, `get_background_task`, `stop_background_task` z 0024; nie zmienia widoku `turn_sources` ani triggerów, więc zachowuje `background_item_ids` i `background_task`.

## Rezultat i decyzja o oczekiwaniu

Wspólne `ask_user` i `get_answers`, trwałe pytania w istniejącym modelu interakcji, odpowiedzi strukturalne, routing rodzic/człowiek, steer async z fallbackiem do tury i wspólny panel przy composerze. Szczegóły kontraktu i decyzji: [agent-bus.md](agent-bus.md#pytania-platformy-ask_user-i-get_answers), [execution.md §6](execution.md#6-interakcje-z-użytkownikiem), [ui-api.md](ui-api.md#pytania-nad-kompozytorem).

Sync odnawia oczekiwanie co 120 s; nie wygasza pytania. Po `pending` dalsza praca zależy od przestrzegania przez model instrukcji ponowienia `get_answers`. Nie blokujemy technicznie innych narzędzi po zwróceniu `pending`. Natywne pytania pozostają włączone i korzystają z tego samego UI. Po awarii tury może nastąpić powtórne dostarczenie wcześniej odebranej odpowiedzi; transport wyniku narzędzia nie ma osobnego potwierdzenia odbioru.

Dowody:

1. Claude Agent SDK 0.3.316 dokumentuje twardy timeout MCP; live `tool-timeout.live.test.ts` potwierdził błąd timeout dla 1000 ms przy handlerze 2500 ms (4 asercje).
2. Codex 0.164.0, `request_dynamic_tool`, czeka do odpowiedzi lub anulowania bez lokalnego timera; nie zakładamy bezterminowości całego transportu.
3. Live Codex z `OA_ASK_LONG_WAIT=1`: odpowiedź API po 123 s, wykonane `get_answers`, jedna interakcja, wynik `RESULT: Green` (7 asercji; test trwał około 136 s).

## Testy

`bun run typecheck`, `bun run gen:check`, pełne `bun run check:tmp` i `bun run --filter @open-agents/web build` są wymaganymi kontrolami tej gałęzi. Testy live są osobnym przebiegiem z `OA_LIVE=1`, plikiem środowiska spoza repozytorium i `useLiveProxy`; żadnych wartości poświadczeń w repozytorium ani raporcie.

Po ostatnim scaleniu wszystkie wymagane kontrole przeszły: typecheck (Svelte: 0 błędów i 0 ostrzeżeń), gen:check, web build oraz pełne check:tmp — **748 pass, 96 skip, 0 fail**, 844 testy w 126 plikach, 2876 asercji. Testy opt-in live/browser są pomijane w pełnej suite i uruchamiane osobno. Kontrolowany katalog tymczasowy pozostał pusty; narzędzie odnotowało równoległe katalogi w `/tmp`, w tym własny działający fixture, który następnie zakończono i posprzątano. Build zgłasza ostrzeżenie o rozmiarze chunka.

- Kontrakt domeny i adaptery UI: granice schematu, duplikaty, rekomendacja, tekst zamiast opcji, wiele opcji, skip, dismiss, kolejność odpowiedzi i czytelny tekst dostarczenia.
- Gateway + skryptowany worker (`ask-user.test.ts`, 9 testów): sync oczekuje i wznawia się po odpowiedzi, idempotencja, async w tej samej turze, nowa tura po jej końcu, odmowa/upuszczenie steera, skip/dismiss, izolacja wątków, parent routing z możliwością odpowiedzi człowieka, restart workera i awaria podczas przekazywania wyniku. Sprawdzane są też hops, autor i rekord osi czasu.
- Live przez CLIProxyAPI (`ask-user.live.test.ts`, 4 testy): sync i async dla Codexa i Claude. Sync używa odpowiedzi API w wyniku; async dostaje odpowiedź jako dostarczony steer w tej samej turze (`hops = 1`). Końcowy przebieg po scaleniu main wraz z testem timeoutu Claude: **5 pass, 0 fail**, 26 asercji, 48,65 s.
- Browser fixture: osobny PostgreSQL/gateway ze skryptowanym workerem, Vite 5293. Wszystkie przebiegi fixture zakończone poprawnie; serwer zatrzymany przez uchwyt procesu, tymczasowe katalogi usunięte przez `@open-agents/testing`, karta przeglądarki zamknięta. Końcowy podgląd potwierdził czytelny tekst dostarczenia po Skip all. Poprawiono też sprzątanie: oczekujący handler sync kończy się przed zwolnieniem runtime'u; osobny rerun fixture i typecheck testów integracyjnych przeszły.

## UI i componentize

Użyte skille: `design`, `componentize`, `transitions-dev`. Dedykowany przegląd componentize objął wszystkie zmienione komponenty: `Composer` koordynuje tryb, `MessageComposer` zachowuje zwykły szkic, `ComposerTop` zapewnia wspólną powierzchnię paneli, `QuestionSession` przechowuje kroki i szkice, `QuestionOption` używa współdzielonego `Input`. Kolejka i panel subagentów mają wariant `embedded`. Skontrolowane także `ComposerBox`, `InteractionCard`, rekord osi czasu i strona wątku.

Sprawdzone w przeglądarce: light/dark, 1440×1000 i 390×844, brak poziomego przepełnienia, wspólny stos z kolejką i subagentami, klawisze 1–9/strzałki/Enter, single/multiple choice, cofanie bez utraty wyboru, tekst z composera, Skip, Skip all, Dismiss, zwijanie i przełączanie async. Zwykła wiadomość została wysłana jako steer przy nadal otwartym pytaniu async. Odpowiedzi pozostały na osi czasu z autorem i pełną treścią po rozwinięciu. Znaleziony runtime'owy błąd `bind:value` na checkboxie naprawiono w wspólnym `Input` i ponownie sprawdzono przejście do multiple choice.

Semantyka: natywne radio/checkbox, fieldset/legend, kontrolki z etykietami, `aria-expanded`/`aria-controls`/`inert`, fokus na legendzie przy zmianie kroku. Reduced motion zweryfikowane w kodzie istniejących receptur `.t-acc-panel`/`.t-acc-chevron` i tokenów; nie wykonano osobnej emulacji systemowego ustawienia reduced motion ani testu z rzeczywistym czytnikiem ekranu.

Zrzuty (poza repozytorium):

| Widok | Ścieżka |
|---|---|
| 1440, light, sync + kolejka + subagent | `/home/nix/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mvz4sxwy-d96484ed.png` |
| 1440, dark, async po wysłaniu zwykłej wiadomości | `/home/nix/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mvz4tm5r-6a1fd711.png` |
| 390, light, async | `/home/nix/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mvz4tmbd-fa2cb1a4.png` |
| 390, dark, async | `/home/nix/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mvz4tm8r-55e2517c.png` |
| Odpowiedzi w rozwiniętym rekordzie osi czasu | `/home/nix/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mvz4rie7-563e5a57.png` |
| Czytelne dostarczenie odpowiedzi po Skip all, po ostatnim merge | `/home/nix/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mvz5531k-017e72f0.png` |

## Commity implementacji

- `176a568` — domena, DB, gateway, trwałość, routing i testy.
- `c1530f8` — panel pytań i adaptery UI.
- `4a49545`, `684059d`, `d28ce2a` — scalenia main, wspólny stos z panelem subagentów, aktualizacja kontraktów i zachowanie narzędzi zadań w tle.
- `9bab3f3` — ochrona przed awarią przy dostarczeniu wyniku, poprawki kontrolek, fokus, szkice i fixture przeglądarki.
- `5bf5a1d` — czytelne formatowanie odpowiedzi, dokumentacja decyzji i gwarancji oraz sprzątanie testu restartu.

Końcowy commit aktualizuje ten raport i sprzątanie fixture przeglądarki; jego SHA jest podane w raporcie końcowym rozmowy. Dedykowany przegląd componentize oraz końcowy przegląd trwałości, walidacji, routingu i zgodności migracji z main nie wykazały dalszych blokad. Ograniczenia sync i zakres weryfikacji dostępności opisano powyżej.
