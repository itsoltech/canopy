# Weryfikacja ask_user — 2026-11-02

Gałąź: `feat/ask-user`. Lokalny `main` scalony do `939a418` (łącznie z subagentami dowolnego dostawcy, generowaniem tytułów i poprawką fixture sweep). Migracja: `0025_ask_user`; nowe pola istniejących kontraktów: 250. Bez push i PR.

## Rezultat i decyzja o oczekiwaniu

Wspólne `ask_user` i `get_answers`, trwałe pytania w istniejącym modelu interakcji, odpowiedzi strukturalne, routing rodzic/człowiek, steer async z fallbackiem do tury i wspólny panel przy composerze. Szczegóły kontraktu i decyzji: [agent-bus.md](agent-bus.md#pytania-platformy-ask_user-i-get_answers), [execution.md §6](execution.md#6-interakcje-z-użytkownikiem), [ui-api.md](ui-api.md#pytania-nad-kompozytorem).

Sync odnawia oczekiwanie co 120 s; nie wygasza pytania. Po `pending` dalsza praca zależy od przestrzegania przez model instrukcji ponowienia `get_answers`. Nie blokujemy technicznie innych narzędzi po zwróceniu `pending`. Natywne pytania pozostają włączone i korzystają z tego samego UI. Po awarii tury może nastąpić powtórne dostarczenie wcześniej odebranej odpowiedzi; transport wyniku narzędzia nie ma osobnego potwierdzenia odbioru.

Dowody:

1. Claude Agent SDK 0.3.316 dokumentuje twardy timeout MCP; live `tool-timeout.live.test.ts` potwierdził błąd timeout dla 1000 ms przy handlerze 2500 ms (4 asercje).
2. Codex 0.164.0, `request_dynamic_tool`, czeka do odpowiedzi lub anulowania bez lokalnego timera; nie zakładamy bezterminowości całego transportu.
3. Live Codex z `OA_ASK_LONG_WAIT=1`: odpowiedź API po 123 s, wykonane `get_answers`, jedna interakcja, wynik `RESULT: Green` (7 asercji; test trwał około 136 s).

## Testy

`bun run typecheck`, `bun run gen:check`, pełne `bun run check:tmp` i `bun run --filter @open-agents/web build` są wymaganymi kontrolami tej gałęzi. Testy live są osobnym przebiegiem z `OA_LIVE=1`, plikiem środowiska spoza repozytorium i `useLiveProxy`; żadnych wartości poświadczeń w repozytorium ani raporcie.

- Kontrakt domeny i adaptery UI: granice schematu, duplikaty, rekomendacja, tekst zamiast opcji, wiele opcji, skip, dismiss, kolejność odpowiedzi i czytelny tekst dostarczenia.
- Gateway + skryptowany worker (`ask-user.test.ts`, 9 testów): sync oczekuje i wznawia się po odpowiedzi, idempotencja, async w tej samej turze, nowa tura po jej końcu, odmowa/upuszczenie steera, skip/dismiss, izolacja wątków, parent routing z możliwością odpowiedzi człowieka, restart workera i awaria podczas przekazywania wyniku. Sprawdzane są też hops, autor i rekord osi czasu.
- Live przez CLIProxyAPI (`ask-user.live.test.ts`, 4 testy): sync i async dla Codexa i Claude. Sync używa odpowiedzi API w wyniku; async dostaje odpowiedź jako dostarczony steer w tej samej turze (`hops = 1`). Wszystkie cztery przeszły także po scaleniu main i zmianie formatowania dostarczenia.
- Browser fixture: osobny PostgreSQL/gateway ze skryptowanym workerem, Vite 5293. Oba przebiegi fixture zakończone poprawnie; serwer zatrzymany przez uchwyt procesu, tymczasowe katalogi usunięte przez `@open-agents/testing`, karta przeglądarki zamknięta.

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

## Commity implementacji

- `176a568` — domena, DB, gateway, trwałość, routing i testy.
- `c1530f8` — panel pytań i adaptery UI.
- `4a49545`, `684059d` — scalenia main, wspólny stos z panelem subagentów i aktualizacja kontraktów.
- `9bab3f3` — ochrona przed awarią przy dostarczeniu wyniku, poprawki kontrolek, fokus, szkice i fixture przeglądarki.

Końcowy commit zawiera czytelne formatowanie odpowiedzi oraz dokumentację z tym raportem; jego SHA jest podane w raporcie końcowym rozmowy.
