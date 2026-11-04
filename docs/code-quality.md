# Jakość kodu: lint, formatter, limity rozmiaru

Status: **przygotowanie**. Narzędzia, konfiguracja i pomiar są w repo, ale kod aplikacji nie był jeszcze ani
formatowany, ani poprawiany. Refaktor i formatowanie ruszą dopiero po zmergowaniu wszystkich otwartych PR-ów/gałęzi
(inaczej każdy z nich miałby konflikty w prawie każdym pliku). Do tego czasu `bun run lint` i `bun run format:check`
**nie przechodzą** i nie są częścią `check` ani CI.

Liczby poniżej: `origin/dev` @ `f39f5b6` (2026-11-03). Pełne zestawienie maszynowe: `docs/code-quality-baseline.json`.

## Narzędzia

| Narzędzie                                          | Wersja (dokładny pin)                        | Rola                                                        |
| -------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| `oxlint`                                           | 1.91.0                                       | linter (reguły wbudowane + pluginy JS)                      |
| `@oxlint/plugins`                                  | 1.91.0 (zawsze ta sama co `oxlint`)          | API, którego używa vendorowany plugin                       |
| [anti-slop](https://github.com/dmmulroy/anti-slop) | commit `13909c9` (v0.1.2), vendorowany, MIT  | reguły przeciw „slopowi” agentów, `tools/oxlint/anti-slop/` |
| `oxfmt`                                            | 0.76.0                                       | formatter (TS, TSX, Svelte, JSON, CSS, YAML)                |

Skrypty (root `package.json`):

- `bun run lint`: `oxlint` na całym repo (~1,4 s, 1116 plików).
- `bun run lint:fix`: `oxlint --fix`, wszystkie bezpieczne autofixy. Uwaga na `unicorn/no-useless-spread` niżej.
- `bun run lint:spacing`: tylko autofix `anti-slop/require-readable-spacing` (same białe znaki); do przebiegu
  mechanicznego. Osobny `oxlint.spacing.config.ts` współdzieli ignore'y i wyłącza pozostałe reguły: samo `-A all`
  nie wyłącza jawnie skonfigurowanych reguł pluginów JS, więc poprzednia komenda kończyła się błędem.
- `bun run format` / `bun run format:check`: `oxfmt` (~3 s na całym repo).
- `bun run typecheck` sprawdza też `tools/tsconfig.json` (vendorowany plugin + `oxlint.config.ts`).

### anti-slop

Vendorowany procedurą skilla `install-anti-slop` (kopia `assets/anti-slop/` = upstream `src/` bez testów). Pochodzenie,
licencje i odstępstwa: `tools/oxlint/anti-slop/UPSTREAM.md` oraz `vendor/eslint-stylistic/{LICENSE,UPSTREAM.md}`. Kod jest
nasz: politykę zmienia się w regułach albo w `oxlint.config.ts`, nie przez `oxlint-disable` w kodzie aplikacji.
Aktualizacja: `skills/install-anti-slop/references/update.md` z upstreamu (merge trójstronny względem `13909c9`).

Wszystkie 24 zestawy testów RuleTester z upstreamu przechodzą na `oxlint` 1.91.0 (upstream testował 1.78.0).

### Dlaczego oxfmt, a nie Prettier + prettier-plugin-svelte

Zmierzone na kopii repo, ta sama konfiguracja (`printWidth: 120`, reszta domyślna):

- **Wynik praktycznie identyczny.** Prettier 3.9.10 + prettier-plugin-svelte 4.1.1 zmienia 958 plików, oxfmt 961;
  wyniki różnią się tylko w 15 plikach. 7 z nich to `package.json` (oxfmt domyślnie sortuje klucze, wyłączone:
  `sortPackageJson: false`). Pozostałe 8 to głównie inne łamanie długich unii typów (np. po `as`). oxfmt ma wbudowany port
  prettier-plugin-svelte (wymaga pakietu `svelte`, który jest w root `node_modules` przez `apps/web`).
- **Szybkość:** 2,6 s vs 13,2 s na całym repo.
- **Jeden zestaw narzędzi** z oxlint (Oxc), bez pluginów. Sortowanie klas Tailwind jest wbudowane (port
  prettier-plugin-tailwindcss).

Ustawienia dobrane pomiarem: liczyłem, ile linii zmieni każdy wariant. Domyślne (spacje ×2, cudzysłowy podwójne,
średniki, `trailingComma: all`, `arrowParens: always`) dają najmniejszy diff. `semi: false` i `singleQuote` podwajają
diff, a `trailingComma: none/es5` i `arrowParens: avoid` go zwiększają. `printWidth`: 80 → 93k wstawionych linii,
100 → 66k, **120 → 48k**, 160 → 27k. 120 to kompromis między czytelnością a churnem. Dziś 7895 linii TS/Svelte ma > 120
znaków, a 2602 > 160.

**Tailwind:** `sortTailwindcss` z `apps/web/src/routes/layout.css` (v4, rozumie własne utility jak `focus-ring`). Klasy
są już prawie posortowane: włączenie sortowania dokłada tylko 72 pliki z drobnymi przestawieniami. Kolejność klas w
atrybucie nie zmienia kaskady Tailwinda v4, więc nie koliduje z regułą z AGENTS.md o klasach komponentów kitu (tam
problemem jest konflikt utility, nie kolejność). Repo nie używa helperów `clsx`/`cn`, więc `functions` jest puste.

**Markdown nie jest formatowany** (`**/*.md` w `ignorePatterns`). oxfmt zmieniłby 50 dokumentów (~1150 linii: tabele,
listy, łamanie), czyli głównie polską prozę w `docs/`, bez zysku dla czytelności kodu. YAML (2 pliki, kosmetyka), JSON i
CSS są formatowane.

**Długie linie:** reguły `max-len` celowo nie ma. Po formatowaniu zostaje 1504 linii > 120 znaków: 1035 to stringi i
template literale, 128 to atrybuty `class`, 104 to komentarze, 237 inne. Formatter ich nie łamie, a ręczne łamanie
stringów pogarsza czytelność.

## Konfiguracja

`oxlint.config.ts` (TS config jest wspierany w 1.91.0):

- domyślna kategoria `correctness` oxlint (wbudowane reguły) zostaje włączona;
- wszystkie generyczne reguły anti-slop + `oxc/no-accumulating-spread` jako `error`;
- grupa Effect (`anti-slop-effect/*`) jako `error`, ale **tylko w pakietach z bezpośrednią zależnością `effect`**:
  `apps/gateway`, `apps/web`, `apps/worker`, `packages/db`, `packages/domain`, `tests/integration`. W
  `apps/desktop`, `apps/mobile`, `scripts/` i pozostałych `packages/*` nie ma `Match`, więc te reguły nie mają sensu
  (zgodnie ze skillem: Effect tylko przy bezpośredniej zależności);
- `ignorePatterns`: katalogi agentów (`.agents/`, `.claude/`, `.codex/`, …), vendorowany plugin, kod generowany
  (`**/gen/**`: `packages/contracts/src/gen`, `packages/codex-protocol/src/gen`), wyjścia buildów (`build`, `dist`,
  `.svelte-kit`, `.expo`, `apps/web/releases`), `artifacts/`. `node_modules` i `.gitignore` są pomijane i tak.

`.oxfmtrc.json`: `printWidth: 120`, `svelte: true`, `sortPackageJson: false`, `sortTailwindcss`, te same ignore'y plus
`packages/ui/src/palette.json` (generowany przez `packages/ui/scripts/palette.ts`, sprawdzany przez `gen:check`) i
`**/*.md`.

`apps/mobile` ma też własny `eslint.config.js` (`expo lint`). Zostaje: reguły Expo/React są uzupełnieniem, a oxlint
obejmuje `.tsx` mobile tak jak resztę.

### Pliki `.svelte`

oxlint 1.91 lintuje bloki `<script>` (instancji i `module`), łącznie z pluginami JS. Sprawdzone: diagnostyki są w 256
plikach `.svelte` z poprawnymi numerami linii. Ograniczenia:

- **nie** są lintowane wyrażenia w szablonie (`{…}`, handlery `onclick={…}`, `{#if}`), ani `<style>`;
- `max-lines` liczy tylko linie skryptu (np. `VirtualFeed.svelte`: 599 linii pliku, 527 w `<script>`);
- runy (`$state`, `$derived`, `$props`) nie przeszkadzają regułom.

### Limity rozmiaru

- `max-lines`: **400 linii kodu** (`skipBlankLines`, `skipComments`), więc komentarze nigdy nie „wypychają” pliku. 400
  linii kodu to po formatowaniu typowo 550–650 linii pliku.
- `max-lines-per-function`: **120 linii kodu** (`IIFEs: true`).
- Testy (`*.test.ts(x)`, `**/test/**`, `tests/**`): `max-lines` 800, bez limitu na funkcję. Test czyta się jako
  scenariusz z góry na dół, a `describe`/`test` to jedna funkcja.
- `packages/ui/src/icons.ts`, `packages/ui/src/mascot.ts`: bez limitów. To ręcznie utrzymywane tabele danych (ścieżki
  SVG); dzielenie ich po rozmiarze tylko rozprasza wyszukiwanie.
- Kod generowany: ignorowany w całości.

Uwaga dla serwisów Effect: `Layer.effect(…, Effect.gen(function* () { …; return { metody } }))` to dla
`max-lines-per-function` jedna funkcja. Cały store jest więc jedną funkcją (np. `bots/store.ts` → `makeStore`, 988
linii). Zagnieżdżenie bywa liczone podwójnie (`static layer` + generator w środku). Rozwiązuje to ten sam podział, co
`max-lines`.

## Pomiar

### Dziś (bez zmian w kodzie)

**11 543 naruszeń w 869 plikach.** Z tego `require-readable-spacing`: **9570** (854 pliki), w całości autofix.
Formatter zmieniłby 961 plików (+47 873 / −15 172 linii).

### Po przebiegu mechanicznym (format + spacing), symulacja na kopii

Kolejność `format → lint:spacing → format` osiąga punkt stały w jednej rundzie (kolejna runda: zero zmian).
Sprawdziłem na kopii: `bun run typecheck` czysty i build web (`vite build`) przechodzi. Testy: patrz „Weryfikacja” niżej.
Linie TS/TSX/Svelte rosną z 93 069 do 137 188 (+47%).

Zostaje **1992 naruszeń w 411 plikach**, wszystkie do poprawy ręcznej:

| Reguła                                                  | src | testy | Rekomendacja                                         |
| ------------------------------------------------------- | --: | ----: | ---------------------------------------------------- |
| `anti-slop/require-safety-comment-for-type-assertion`   | 496 |   194 | zostaw w src, **wyłącz w testach**                   |
| `anti-slop/no-shape-in-symbol-names`                    | 241 |    59 | **wyłącz**                                           |
| `anti-slop/no-runtime-typeof`                           | 229 |    17 | zostaw + `allowInTypeGuards: true`                   |
| `anti-slop/no-unsafe-dictionary-type`                   | 138 |    36 | zostaw, wprowadzić `JsonObject`                      |
| `anti-slop/no-unknown-parameters`                       | 130 |    22 | zostaw                                               |
| `anti-slop/no-known-value-widening`                     | 127 |    16 | zostaw                                               |
| `anti-slop-effect/prefer-effect-match`                  |  63 |     3 | zostaw, **wyłącz w `.svelte`**                       |
| `max-lines-per-function`                                |  46 |     — | zostaw (120)                                         |
| `anti-slop/no-unknown-returns`                          |  31 |     0 | zostaw                                               |
| `anti-slop/no-chained-type-assertions`                  |  22 |     8 | zostaw                                               |
| `max-lines`                                             |  20 |     2 | zostaw (400 / 800)                                   |
| `anti-slop/no-array-filter-map`                         |  12 |    17 | zostaw, uwaga na `lib`                               |
| `no-unused-vars`                                        |   8 |    10 | zostaw                                               |
| `no-control-regex`                                      |   9 |     0 | zostaw, wyjątki z uzasadnieniem                      |
| `anti-slop/no-conditional-empty-object-spread`          |   8 |     1 | zostaw                                               |
| `anti-slop/no-object-parameters`                        |   4 |     6 | zostaw                                               |
| inne wbudowane (`no-useless-spread`, `no-accumulating-spread`, `no-unused-expressions`, `no-unsafe-optional-chaining`, `triple-slash-reference`, `no-new-array`, `no-non-null-asserted-optional-chain`) | 9 | 5 | zostaw |
| `anti-slop-effect/no-manual-tag-comparison`             |   2 |     0 | zostaw                                               |

Pozostałe reguły anti-slop (`no-module-mocking`, `no-reflect-*`, `no-widen-then-assert`, `no-unknown-type-aliases`,
`no-reduce-accumulator-copy`, reszta Effect) mają dziś 0 trafień. Zostają jako strażnicy.

Po obszarach (po przebiegu mechanicznym): `apps/web` 584, `apps/worker` 458, `apps/gateway` 417,
`tests/integration` 261, `packages/domain` 65, `apps/desktop` 54, `apps/mobile` 40, `scripts` 33,
`packages/grok-acp` 25, `packages/ui` 24, `packages/db` 13, `packages/updater` 12, `packages/transport` 5,
`packages/testing` 1. Rozbicie reguła × obszar: `afterMechanicalPass.byRuleAndArea` w JSON.

### Autofix: co jest bezpieczne

- `require-readable-spacing`: tylko wstawia białe znaki (np. rozbija `a(); return;` w jednej linii; formatter potem to
  porządkuje). Sprawdzone porównaniem plików bez białych znaków: zero zmian tokenów.
- Formatter: zmiany składniowo neutralne. Typecheck i build przechodzą (wyżej).
- **`lint:fix` (pełne `oxlint --fix`) nie jest bezpieczny jako krok mechaniczny.** Poza spacingiem robi 4 zmiany
  tokenów. 3 są poprawne (`startsWith`, zbędny escape w regexie, `[...arr.map()].sort()`). Czwarta to **błąd
  autofixa `unicorn/no-useless-spread`**: w `packages/domain/src/attachments/files.ts:36`
  `[...clean.slice(…)].slice(…).join("")` (spread **stringa** na code pointy) zamienia na `clean.slice(…).slice(…)…`,
  co psuje typecheck (`join` na stringu). Dlatego przebieg mechaniczny używa `lint:spacing`. Tę linię trzeba poprawić
  ręcznie (np. `Array.from(clean.slice(…))`), wtedy reguła przestaje ją zgłaszać.

## Reguły słabo dopasowane: przyjęte decyzje

Maintainer zatwierdził poniższe dostosowania. Konfiguracja wyłącza `no-shape-in-symbol-names`, komentarze
`SAFETY:` w testach i `prefer-effect-match` w `.svelte`; `no-runtime-typeof` ma `allowInTypeGuards: true`.
Wspólne typy `JsonObject` i `JsonValue` są eksportowane z `@canopy/domain` (`src/json.ts`), bez migracji użyć.

- **`no-shape-in-symbol-names`: wyłączyć** (300). 153 to typy biblioteki protobuf-es (`MessageInitShape` 133,
  `MessageShape` 20). Nazwy tej nie da się zmienić bez sztucznych aliasów, a plugin zgłasza import dwukrotnie (61
  duplikatów). Pozostałe 147 to `shape` maskotki bota (`MascotShape`, `mascotShapes`, `shape`), czyli prawdziwe pojęcie
  domenowe (kształt ciała maskotki), a nie „kształt danych”, przed którym reguła chroni.
- **`require-safety-comment-for-type-assertion`: w src zostawić, w testach wyłączyć** (496 + 194). W testach
  asercje dotyczą fixtur (`c.value as SetGoal`, `request.json() as {…}`), a komentarz `SAFETY:` przy każdej to szum. W
  src naprawa to najczęściej **usunięcie** asercji (dekoder Schema, `satisfies`, typowany helper JSON), a nie
  dopisanie komentarza. Np. `n["project_id"] as string` w `apps/gateway/src/bots/tools/schedules.ts:21` → dekoder
  argumentów narzędzia.
- **`no-runtime-typeof`: zostawić, `allowInTypeGuards: true`** (246). Opcja sama zdejmuje tylko 6. ~118 trafień jest
  na granicach zewnętrznego JSON-a (mapowanie zdarzeń Codex/Claude/Grok, argumenty narzędzi od modelu, parse w UI).
  Właściwa naprawa to przeniesienie sprawdzeń do nazwanych type guardów albo dekoderów `Schema` (Effect Schema jest
  już używany w `packages/domain` i `apps/web`) w modułach granicznych (`mapping.ts`, `parse.ts`). Przykład:
  `apps/worker/src/providers/codex/mapping.ts:244` `typeof turnId === "string" ? …`.
- **`no-unknown-parameters`: zostawić** (152). 53 to `.catch((error: unknown) => …)`: reguła akceptuje konwencję
  `cause`, więc to zmiana nazwy. Usunięcie adnotacji nie wchodzi w grę: w `.catch` dałoby `any`. Reszta to granice JSON
  (`requestJson(…, body?: unknown)` w `apps/web/src/lib/shared/http.ts:15`), które powinny przyjmować `JsonValue` albo
  typ generyczny.
- **`no-unsafe-dictionary-type`: zostawić** (174). Prawie wszystko to `Record<string, unknown>` dla argumentów narzędzi
  i JSON Schema. Rozwiązanie: jeden typ `JsonObject = { readonly [key: string]: JsonValue }` w `packages/domain` (nie
  jest `unknown`, więc reguła go akceptuje) albo dekoder Schema.
- **`prefer-effect-match`: zostawić w kodzie Effect, wyłączyć w `.svelte`** (66, w tym 20 w komponentach Svelte).
  `Match.value(…).pipe(…)` w `$derived` albo w handlerze UI jest cięższy niż trójstopniowy ternary. W `.ts` web, w
  gateway i w workerze reguła pasuje do stylu.
- **`no-array-filter-map`: zostawić** (29). Podpowiedź reguły (`.values().filter().map().toArray()`) **nie
  przejdzie typechecku**: `tsconfig.base.json` ma `lib: ["ES2024"]` bez iterator helpers, a mobile działa na Hermesie.
  Naprawa w fazie 2: `flatMap`. Nie stosować iterator helpers ani nie podnosić `lib` w ramach tego refaktoru.
- **`no-module-mocking`: zostawić** (0). Obejmuje tylko `vi`/`jest`. Repo używa `bun:test` i nie ma `mock.module`, co
  zgadza się z polityką testów. Można rozszerzyć regułę o `mock.module` z `bun:test`.
- **`no-conditional-empty-object-spread`: zostawić** (9). Przy `exactOptionalPropertyTypes` pomijanie pola jest
  wymagane, a dominujący idiom repo `...(x && { x })` reguła akceptuje. 9 miejsc z `: {}` trzeba przepisać na ten idiom.
- **`no-control-regex`: zostawić** (9). To celowe sanitizery znaków sterujących (np. nazwy plików). Każde miejsce
  dostaje `// oxlint-disable-next-line no-control-regex -- <powód>`.

## Pliki ponad limit

20 plików źródłowych i 2 testy po przebiegu mechanicznym (dziś przed formatowaniem: 11). Liczby to linie kodu bez
pustych i komentarzy. Podział po odpowiedzialności:

| Plik                                                  | Kod  | Proponowany podział                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/gateway/src/core/core.ts`                       | 2564 | Wg istniejących sekcji, na wzór `core/agent-bus.ts` (moduł + wąski interfejs `…Host`): `core.ts` (fasada `GatewayCore`, konstruktor, okablowanie), `work-loop.ts` (serve/ingest/redeliver), `commands.ts` (dispatch/deliver/settle/sweep/pump/startTurn), `queue.ts`, `projects.ts` (projekty, workspace'y, katalogi), `threads.ts` (create/send/update, tytuły), `bot-threads.ts`, `attachments.ts` (upload, bloby, podglądy), `mentions.ts`, `models.ts` + steery, `provider-instances.ts`, `interactions.ts`, `settings.ts`, `schedules.ts`, `goals.ts` (goale, zadania w tle), `errors.ts` (`describeError`, `UnavailableError`, `InvalidError`). |
| `apps/gateway/src/store/store.ts`                     | 1382 | Osobne `Context.Service` na obszar (jak istniejące `QueueStore`, `GoalStore`, `SteerStore`): `WorkerStore` (ensureUser, authenticate/add/connected/seen, journalCursors, config i sekrety workera), `ProjectStore` (projekty, workspace'y), `ThreadStore` (create/list/archive/settings/tytuły), `TurnStore` (enqueue/next/running/fail/endLost/turnsOf), interakcje; mapery `toUi*`/`permissionMode*` do `store/ui-mappers.ts`. Nie `makeX` importowane względnie: `no-service-constructor-imports`. |
| `apps/gateway/src/store/agent-bus.ts`                 | 1183 | `AgentBusStore` (wywołania: storedCall/recordCall/spawn/send/summary/listThreads/readThread), `BusScheduleStore` (create/list/cancel/claimDue/fire, schedule'y użytkownika), `BusDeliveryStore` (notifications, deliveries, forwardInteraction); mapery `toUiSchedule`/`toUiDelivery` osobno. |
| `apps/worker/src/runtime/host.ts`                     | 1161 | `host.ts` (attach/detach, routing komend, shutdown/flush/recover), `commands.ts` (`#execute`, 260 linii: handler na komendę), `codex-runtimes.ts` (grupy, reconcile, start/stop, sieroty), `claude-runtimes.ts`, `catalog.ts` (probe, login, listModels, publishCatalog), `files.ts` (checkCwd, listDirectory). |
| `apps/gateway/src/bots/store.ts`                      | 1124 | Wg agregatów z `makeStore` (988 linii): boty (list/archive/updateSelf/createFromBot/remove), rozmowy i wiadomości (conversation/history/messageUser/markRead), wymiany (exchange/claim/heartbeat/status/checkpoint/planCall/call/action/remote*), zatwierdzenia (approval/wait/answer/interrupt/retry/release), handoff, serwery MCP, wakeupy i przypomnienia. |
| `apps/worker/src/providers/claude/threads.ts`         |  917 | `make` (~690 linii) → `sessions.ts` (open/switchMode/closeWhenIdle/sessionExists), `turns.ts` (beginTurn, consume, steery), `permissions.ts` (`canUseTool`), `output.ts` (readOutput, goal verdicts, fileSize/readFrom). |
| `packages/db/test/schema.test.ts`                     |  885 | Test (limit 800): oczekiwana lista migracji i asercje schematu do osobnych plików na obszar (`schema.threads.test.ts`, …). |
| `tests/integration/bots.test.ts`                      |  836 | Test (limit 800): podzielić wg scenariuszy (CRUD, rozmowa, zatwierdzenia, routines). |
| `apps/worker/src/providers/codex/threads.ts`          |  722 | Jak Claude: sesje/wątki, tury i steery, narzędzia dynamiczne (`codexViewImageTool`, `codexAgentBusTools`, `dynamicTools`) do `tools.ts`. |
| `apps/worker/src/providers/codex/mapping.ts`          |  648 | `CodexEventMapper` (stan tury, `map`) / `items.ts` (`mapItem`, `shellCommandItem`, `providerToolCall`, `outputText`) / `background.ts` (`#toBackground`, `#backgroundEnded`) / `status.ts` (turnOutcome, threadStatus, usage, codexErrorCode). |
| `apps/worker/src/providers/claude/mapping.ts`         |  645 | `ClaudeEventMapper` / `background-tasks.ts` (taskStarted/backgrounded/endTask, outputFile) / `content.ts` (text/tool content, editDiff, resultText) / `goal.ts` (goalVerdict, goalAnswer). |
| `apps/gateway/src/store/instances.ts`                 |  612 | `InstanceStore` (CRUD, workers, models) / `instance-validation.ts` (checkPath/checkArgs/checkBaseUrl, limity) / sync i `registerEndpoint` osobno. |
| `apps/desktop/src/main.ts`                            |  531 | `ipc.ts` (handlery `ipcMain` + `authorize`), `windows.ts` (createWindow, showMain, openSettings, chrome), `enrollment.ts`, `main.ts` (start, lifecycle aplikacji). |
| `apps/web/src/lib/features/providers/instances.ts`    |  470 | Wg istniejących sekcji: `instance-status.ts`, `env-vars.ts` (drafty, problemy, splitArgs/joinArgs), `instance-form.ts`, klient API. |
| `apps/gateway/src/connectors/runtime.ts`              |  468 | `ConnectorsRuntime` (lista, zapis, OAuth begin/complete) / `connector-calls.ts` (call/#execute/#permission/handle). |
| `apps/gateway/src/bots/runtime.ts`                    |  454 | `BotsRuntime` (cykl życia, tick) / `bot-turn.ts` (`#execute`, 194 linie: kroki tury) / fasada API (create…testServer) zostaje. |
| `apps/gateway/src/core/agent-bus.ts`                  |  440 | `#execute` (177 linii, switch po narzędziach) → `bus-tools/*.ts` (handler na narzędzie); helpers (`targetsOf`, `ok`/`failure`, `safeJson`) osobno. |
| `apps/web/src/lib/features/threads/dev/tool-fixtures.ts` | 436 | Fixtury galerii dev (`toolGallery`, 350 linii w jednej funkcji): plik na rodzinę narzędzi (shell, edycja, MCP, agent bus). Albo wyjątek w configu jak dla `icons.ts`, jeśli to czyste dane. |
| `apps/gateway/src/store/ingest.ts`                    |  435 | Generator `Ingest` (321 linii) → osobne handlery na rodzaj zdarzenia (tura, item, notice/steer, background task). |
| `apps/web/src/lib/shared/ui/virtual/VirtualFeed.svelte` | 434 | Logika poza komponent: `size-index` (już jest) + `feed-anchor.svelte.ts` (kotwiczenie/scroll), `feed-range.svelte.ts` (zakres widoczny, padding), komponent tylko z widokiem. |
| `apps/web/src/routes/threads/[threadId]/+page.svelte` | 427 | Stan strony do `thread-page.svelte.ts` (goal, schedule, background tasks, komendy), dialogi (goal/schedule/background) do osobnego komponentu `ThreadDialogs.svelte`. |
| `apps/gateway/src/api/ui-service.ts`                  |  425 | `uiRoutes` (337 linii) → trasy per obszar (`routes/threads.ts`, `projects.ts`, `bots.ts`, `settings.ts`, …), `guard`/`toConnectError` do `api/errors.ts`. |

Najdłuższe funkcje (`max-lines-per-function`, pełna lista 46 w JSON): `bots/store.ts makeStore` 988,
`store/store.ts layer` 918, `store/agent-bus.ts` generator 858, `claude/threads.ts make` 691, `codex/threads.ts make`
536, `store/instances.ts layer` 508, `tool-fixtures.ts toolGallery` 350, `ui-service.ts uiRoutes` 339,
`ingest.ts` 321, `connectors/store.ts` 316, komponenty mobile (`settings.tsx` 290, `index.tsx` 249,
`thread/[id].tsx` 237), `host.ts #execute` 260. Większość znika razem z podziałem plików. Komponenty React mobile
dzielimy na podkomponenty.

## Plan refaktoru (po zamknięciu otwartych PR-ów)

1. **Commit mechaniczny** (jeden, sam, łatwy do review przez `git diff -w` / pominięcia w blame):
   `bun run format && bun run lint:spacing && bun run format`, potem drugi raz te same trzy kroki: musi być zero
   zmian. Najpierw ręcznie poprawić `files.ts:36` (wyżej). Tytuł np. `style: format with oxfmt and readable spacing`.
   Commit dodać do `.git-blame-ignore-revs`. Sprawdzenie: `bun run typecheck`, `bun run check:tmp`, build web, rzut oka
   na UI (Svelte: zmiany białych znaków w szablonach).
2. **Decyzje o konfiguracji** z sekcji wyżej (wyłączenia/opcje) w osobnym commicie `chore(lint): …`, zanim ktokolwiek
   zacznie poprawiać reguły.
3. **Poprawki reguł per obszar**, osobne commity/PR-y. Najpierw rzeczy przekrojowe w `packages/domain`
   (`JsonObject`, dekodery JSON, wspólne type guardy), bo inne obszary z nich korzystają. Potem równolegle.
4. **Podziały plików** na końcu, po jednym pliku/module na commit. Same przenosiny (`refactor(gateway): split core
   into modules`), bez zmian logiki. Zmiany zachowania osobno.

**Równoległość (subagenci):** podział po katalogach, które się nie przecinają. Każdy agent dostaje wyłączną listę
plików i uruchamia `bun run lint -- <katalog>` (oxlint przyjmuje ścieżki) oraz typecheck pakietu:

- A: `apps/gateway/src/core/**` + `api/**` (core.ts najpierw: największy i najwięcej zależności),
- B: `apps/gateway/src/store/**` + `bots/**` + `connectors/**`,
- C: `apps/worker/**`,
- D: `apps/web/src/lib/**` + `routes/**`,
- E: `apps/desktop/**` + `apps/mobile/**` + `scripts/**`,
- F: `packages/*` (domain najpierw, jako krok 3) + `tests/integration/**`.

Wspólne typy (`packages/domain`, `packages/contracts`) zmienia tylko F. Pozostali najpierw czekają na F, a potem tylko
importują. Podziały core/store (A, B) szły sekwencyjnie, bo `core.ts` importuje store'y.

**CI na końcu** (w `.github/workflows/ci.yml`, job `check`, zaraz po „Bun and dependencies”):

```yaml
- name: Lint and formatting
  run: bun run lint && bun run format:check
```

oraz `lint` i `format:check` dopisane do root `check`:
`"check": "bun run gen:check && bun run typecheck && bun run lint && bun run format:check && bun run check:tmp"`.

**AGENTS.md** (dopiero razem z włączeniem CI), w „Before handing over” dodać do listy:

```markdown
- `bun run lint` and `bun run format:check` (run `bun run format` and `bun run lint:fix` first; never silence a rule
  with `oxlint-disable` without a `-- reason`, and change policy in `oxlint.config.ts`, not per file)
```

oraz w „Project” jedną linię: „Lint: oxlint + vendored anti-slop (`tools/oxlint/anti-slop`), formatter: oxfmt
(`printWidth` 120). Files ≤ 400 code lines, functions ≤ 120 (docs/code-quality.md).”

## Weryfikacja przygotowania

W tej gałęzi kod aplikacji jest nietknięty: diff to tylko `oxlint.config.ts`, `.oxfmtrc.json`, `tools/`,
`package.json`, `bun.lock`, ten dokument i `docs/code-quality-baseline.json`. `bun install`, `bun run gen:check`,
`bun run typecheck` i `bun run check:tmp` przechodzą jak przed zmianą.
