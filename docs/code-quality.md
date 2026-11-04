# Jakość kodu: lint, formatter, limity rozmiaru

Status: **wszystkie fazy zakończone** (2026-11-04). Cały kod przechodzi `bun run lint` (oxlint + anti-slop + limity
rozmiaru) i `bun run format:check` (oxfmt); CI (`.github/workflows/ci.yml`) i root `check` wymuszają oba, a AGENTS.md
opisuje zasady dla nowego kodu.

- Faza 1 (#29): narzędzia, przyjęta polityka reguł i mechaniczne formatowanie całego repo (`acd67d2`, w `.git-blame-ignore-revs`).
- Faza 2 (#39–#43, #46): poprawki reguł w sześciu rozłącznych obszarach, bez wyłączeń poza uzasadnionymi przypadkami.
- Faza 3 (#47–#52): podział plików ponad 400 linii kodu i funkcji ponad 120 linii, wyłącznie przeniesienia kodu.
- Faza 4: kroki Lint i Formatting w CI, `lint` i `format:check` w root `check`, sekcja „Code quality” w AGENTS.md.

Sekcje poniżej opisują przebieg i pomiary z czasu refaktoru (stan historyczny), w tym zasady reguł, które dalej obowiązują.
Lokalnie: `git config blame.ignoreRevsFile .git-blame-ignore-revs`.

## Narzędzia i polecenia

| Narzędzie | Dokładny pin | Rola |
| --- | --- | --- |
| `oxlint` / `@oxlint/plugins` | 1.91.0 / 1.91.0 | linter i API pluginów JS |
| [anti-slop](https://github.com/dmmulroy/anti-slop) | `13909c9e07590f5a85d93c62712259fe14a883f7` (v0.1.2) | vendorowane reguły w `tools/oxlint/anti-slop/` |
| `oxfmt` | 0.76.0 | formatter TS, TSX, Svelte, JSON, CSS, YAML |

Pochodzenie, licencje MIT i odstępstwa: `tools/oxlint/anti-slop/UPSTREAM.md` oraz
`vendor/eslint-stylistic/{LICENSE,UPSTREAM.md}` wewnątrz pluginu. Aktualizację pluginu należy porównywać trójstronnie
z powyższym commitem upstreamu. Vendorowany kod jest nasz; politykę zmieniamy w konfiguracji lub regule.

- `bun run lint` — pełny oxlint (obecnie 1218 plików).
- `bun run lint:fix` — wszystkie bezpieczne autofixy oxlint; nie jest krokiem przebiegu mechanicznego.
- `bun run lint:spacing` — wyłącznie `require-readable-spacing`, przez `oxlint.spacing.config.ts`.
- `bun run format` / `bun run format:check` — zapis / sprawdzenie oxfmt.
- `bun run typecheck` — obejmuje także `tools/tsconfig.json` (plugin i konfiguracje oxlint).

Osobny config spacing współdzieli `ignorePatterns` z głównym i wyłącza domyślną kategorię `correctness`.
Poprzednie `oxlint -A all -D anti-slop/require-readable-spacing --fix` nie wyłączało jawnie skonfigurowanych reguł
pluginów JS: spacing był poprawiany, lecz komenda kończyła się błędem innych reguł. Dedykowany config usuwa ten problem.

`.oxfmtrc.json`: `printWidth: 120`, `svelte: true`, `sortPackageJson: false`, pozostałe ustawienia domyślne.
W pomiarze przygotowawczym dawało to mniejszy diff niż pojedyncze cudzysłowy, brak średników albo węższe linie.
oxfmt ma wbudowany formatter Svelte i sortowanie klas Tailwind. `sortTailwindcss` korzysta z
`apps/web/src/routes/layout.css` (v4, wraz z własnymi utility). Sortowanie klas nie zmienia ich priorytetu w CSS.
Nie wprowadzamy `max-len`: formatter zostawia długie stringi, komentarze i atrybuty, których sztuczne łamanie szkodzi.

Oba konfiguratory pomijają katalogi agentów, vendorowany plugin, `**/gen/**`, wyjścia buildów, `.svelte-kit`, `.expo`
i artefakty. Formatter pomija także `packages/ui/src/palette.json` (generowany) i `**/*.md` (polska dokumentacja
nie potrzebuje mechanicznego przełamywania prozy). `gen:check` potwierdza brak zmian kontraktów i palety;
osobno sprawdzono brak diffu w `packages/codex-protocol/src/gen`.

## Przyjęta konfiguracja i zasady fazy 2

Maintainer zaakceptował te decyzje; są już w `oxlint.config.ts`:

- `anti-slop/no-shape-in-symbol-names`: **off**. `MessageInitShape`/`MessageShape` pochodzą z protobuf-es,
  a kształt maskotki jest rzeczywistym pojęciem domenowym.
- `anti-slop/require-safety-comment-for-type-assertion`: **off w testach**, error w kodzie źródłowym.
  Testy to `*.test.ts(x)`, `**/test/**`, `tests/**`. W źródłach najpierw usuwamy zbędne asercje przez dekoder,
  `satisfies` lub konkretny typ; komentarz `SAFETY:` opisuje sprawdzony invariant.
- `anti-slop/no-runtime-typeof`: error z **`allowInTypeGuards: true`**. Zewnętrzny JSON dekodujemy na granicy I/O;
  proste nazwane type guardy są dozwolone. Nie przenosimy ślepo wszystkich sprawdzeń do wspólnego worka helperów.
- `anti-slop-effect/prefer-effect-match`: **off w `.svelte`**, error w pozostałym kodzie pakietów Effect.
- `JsonObject` / `JsonValue`: typy tylko, już eksportowane z `@canopy/domain` (`src/json.ts`), bez migracji użyć.
  `JsonValue` obejmuje prymitywy JSON, readonly tablice i `JsonObject`; obiekt ma readonly indeks wartości JSON.

Pozostałe reguły anti-slop oraz `oxc/no-accumulating-spread` pozostają error. Reguły `anti-slop-effect/*` obowiązują
wyłącznie w pakietach z bezpośrednią zależnością `effect`: gateway, worker, web, domain, db i testy integracyjne.
Domyślna kategoria oxlint `correctness` jest włączona. Mobile zachowuje także własny ESLint Expo/React.

W fazie 2:

- `no-array-filter-map` poprawiamy przez **`flatMap`**. Podpowiedź `.values().filter().map().toArray()` nie przejdzie
  typechecku przy `lib: ["ES2024"]`; mobile używa Hermesa. Nie podnosimy `lib` dla tego refaktoru.
- `no-unsafe-dictionary-type`: konkretny typ właściciela/dekoder, a `JsonObject` tylko dla rzeczywistego JSON-a.
  Zastąpienie dowolnego `Record<string, unknown>` typem JSON nie dowodzi poprawności danych wejściowych.
- `no-unknown-parameters`: w `.catch` zachowujemy jawny typ i konwencję `cause`; inne granice dostają kontrakt
  lub dekoder. Nie usuwamy adnotacji, gdy stworzyłoby to `any`.
- `no-conditional-empty-object-spread`: preferowany istniejący idiom `...(x && { x })`; uwzględnić
  `exactOptionalPropertyTypes`. Celowe sanitizery dla `no-control-regex` wymagają lokalnego uzasadnienia
  `// oxlint-disable-next-line no-control-regex -- <powód>`.
- Pozostałe reguły z zerem trafień zostają strażnikami. Nie wyłączamy reguł ani nie dodajemy zbiorczych suppressions
  w celu wyzerowania baseline'u. Zmiana zachowania wymaga osobnego, świadomego zakresu.

### Limity i ograniczenia pomiaru

`max-lines`: **400 linii kodu**, bez pustych i komentarzy. `max-lines-per-function`: **120**, `IIFEs: true`.
Testy: 800 linii pliku, bez limitu funkcji. Ręczne tabele SVG `packages/ui/src/icons.ts` i `mascot.ts` bez limitów.
Kod generowany jest ignorowany.

oxlint lintuje tylko bloki `<script>` komponentów Svelte (instancji i `module`), nie szablony ani style.
Rozmiar `.svelte` w tabelach dotyczy skryptu. Zgłoszenia warstwy Effect i zagnieżdżonego generatora liczą się osobno:
55 zgłoszeń funkcji nie oznacza 55 niezależnych zadań. Podział jednego serwisu często usuwa oba zgłoszenia.

## Przebieg mechaniczny

1. Przed formatowaniem poprawiono `safeFileName` w `packages/domain/src/attachments/files.ts`:
   `Array.from(clean.slice(...))` zachowuje podział stringa na code pointy. Autofix `unicorn/no-useless-spread`
   dla poprzedniego `[...string.slice(...)]` tworzył string z `.join()`, co psuło typecheck.
2. Uruchomiono dokładnie `bun run format && bun run lint:spacing && bun run format` na całym repo.
3. Powtórzono te same trzy polecenia i porównano pełne patche: **zero dodatkowych zmian**.

Commit: **`28347c5fd09396d5aef4ed408f1f0ea22cca0b2f`**, `style(repo): apply oxfmt and readable spacing`.
**1155 plików, +72 950 / −18 258 linii**. Pierwszy krok oxfmt: 1058 plików, +59 101 / −18 217.
Nie uruchamiano pełnego `lint:fix`, nie naprawiano ręcznych reguł ani nie dzielono plików w tym commicie.
Zmiany YAML w workflowach są wyłącznie formatowaniem; nie dodano kroków CI.

Commit znajduje się w `.git-blame-ignore-revs`. Lokalna konfiguracja:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## Aktualny baseline

Polecenie pomiaru: `bun run lint --format json` (exit 1 jest oczekiwany).
Przy tej samej przyjętej konfiguracji przed przebiegiem: **13 238 naruszeń w 936 plikach**,
w tym **11 476 spacing**. Po przebiegu: **1798 w 376 plikach**, **0 spacing**.
Różnica nie jest samym odjęciem spacing: formatter zmienia także liczbę zgłoszeń limitów rozmiaru.

| Reguła | Naruszenia |
| --- | ---: |
| `anti-slop/require-safety-comment-for-type-assertion` | 640 |
| `anti-slop/no-runtime-typeof` | 276 |
| `anti-slop/no-unsafe-dictionary-type` | 208 |
| `anti-slop/no-known-value-widening` | 178 |
| `anti-slop/no-unknown-parameters` | 173 |
| `max-lines-per-function` | 55 |
| `anti-slop-effect/prefer-effect-match` | 52 |
| `anti-slop/no-chained-type-assertions` | 41 |
| `anti-slop/no-unknown-returns` | 35 |
| `anti-slop/no-array-filter-map` | 32 |
| `max-lines` | 30 |
| `no-unused-vars` | 24 |
| `no-control-regex` | 12 |
| `anti-slop/no-object-parameters` | 10 |
| `anti-slop/no-conditional-empty-object-spread` | 9 |
| `oxc/no-accumulating-spread` | 4 |
| `unicorn/no-useless-spread` | 4 |
| `no-unused-expressions` | 3 |
| `anti-slop-effect/no-manual-tag-comparison` | 2 |
| `no-unsafe-optional-chaining` | 2 |
| `require-yield` | 2 |
| `typescript/triple-slash-reference` | 2 |
| `no-useless-escape` | 1 |
| `typescript/no-non-null-asserted-optional-chain` | 1 |
| `unicorn/no-new-array` | 1 |
| `unicorn/prefer-string-starts-ends-with` | 1 |

| Obszar | Naruszenia |
| --- | ---: |
| `apps/gateway` | 619 |
| `apps/web` | 454 |
| `apps/worker` | 367 |
| `tests/integration` | 95 |
| `apps/desktop` | 73 |
| `packages/domain` | 62 |
| `apps/mobile` | 36 |
| `scripts` | 32 |
| `packages/grok-acp` | 25 |
| `packages/updater` | 19 |
| `packages/db` | 9 |
| `packages/transport` | 5 |
| `packages/testing` | 1 |
| `packages/ui` | 1 |

W JSON: `afterMechanicalPass.byRule`, `byArea`, `filesPerRule`, `byRuleAndArea` i `byRuleAndKind` (źródła/testy).
Wyłączone reguły i obszary bez zgłoszeń nie występują w tych mapach; ich liczba to zero.

## Faza 2: sześć rozłącznych obszarów

Każdy właściciel dostaje katalogi wraz z testami w nich. A obejmuje resztę gatewaya poza trzema katalogami B,
w tym **całe `computers/**`**, `api/**`, `core/**`, `updates/**`, `worker-link/**`, `attachments/**`, root gatewaya
i `apps/gateway/test/**`. Nie ma plików współdzielonych przez A i B. F ma wszystkie `packages/**` i `tests/**`.
Konfiguracje root, CI, dokumentacja baseline i lockfile pozostają u integratora; żaden agent nie zmienia ich sam.

| Właściciel | Wyłączny zakres | Wszystkie | Faza 2 (bez limitów) | Faza 3 (limity) |
| --- | --- | ---: | ---: | ---: |
| A | `apps/gateway/**` poza katalogami B | 343 | 321 | 22 |
| B | `apps/gateway/src/{store,bots,connectors}/**` | 276 | 253 | 23 |
| C | `apps/worker/**` | 367 | 352 | 15 |
| D | `apps/web/**` | 454 | 445 | 9 |
| E | `apps/desktop/**`, `apps/mobile/**`, `scripts/**` | 141 | 129 | 12 |
| F | `packages/**`, `tests/**` | 217 | 213 | 4 |
| **Razem** | | **1798** | **1713** | **85** |

Wszystkie obszary mają `require-safety-comment-for-type-assertion`, `no-runtime-typeof`,
`no-unsafe-dictionary-type`, `no-unknown-parameters`, `no-known-value-widening`, `no-unknown-returns`,
`no-chained-type-assertions` oraz `no-unused-vars`. Dodatkowe reguły (prefiks `anti-slop/`, o ile nie podano innego):

| Właściciel | Pozostałe reguły fazy 2 |
| --- | --- |
| A | `no-array-filter-map`, `no-conditional-empty-object-spread`, `anti-slop-effect/prefer-effect-match`, `no-control-regex`, `oxc/no-accumulating-spread`, `typescript/triple-slash-reference` |
| B | `no-array-filter-map`, `anti-slop-effect/prefer-effect-match`, `no-control-regex`, `oxc/no-accumulating-spread` |
| C | `no-array-filter-map`, `no-conditional-empty-object-spread`, `no-object-parameters`, `anti-slop-effect/{prefer-effect-match,no-manual-tag-comparison}`, `no-control-regex`, `no-unsafe-optional-chaining`, `unicorn/no-useless-spread`, `unicorn/prefer-string-starts-ends-with` |
| D | `no-array-filter-map`, `no-object-parameters`, `anti-slop-effect/prefer-effect-match`, `no-control-regex`, `no-unused-expressions`, `oxc/no-accumulating-spread`, `unicorn/no-new-array` |
| E | `no-conditional-empty-object-spread`, `no-unused-expressions` |
| F | `no-array-filter-map`, `no-conditional-empty-object-spread`, `no-object-parameters`, `anti-slop-effect/prefer-effect-match`, `no-control-regex`, `no-useless-escape`, `require-yield`, `typescript/no-non-null-asserted-optional-chain`, `typescript/triple-slash-reference`, `unicorn/no-useless-spread` |

Dokładne liczby każdej reguły dla A–F: `phase2WorkSplit[].byRule` w JSON. `max-lines` i
`max-lines-per-function` są tam również, ale pozostają zadaniami fazy 3, nie podstawą do tłumienia lintów w fazie 2.

Kolejność pracy:

1. F najpierw uzgadnia potrzebne wspólne kontrakty JSON/dekodery/type guardy w `packages/domain` i udostępnia commit.
   Typy `JsonObject`/`JsonValue` są już gotowe. Nie dodawać współdzielonych helperów bez rzeczywistych konsumentów.
2. A–E importują te kontrakty i pracują równolegle wyłącznie w swoich katalogach; F kontynuuje pakiety i integrację.
   Nowa potrzeba zmiany wspólnego kontraktu wraca do F. W tej fazie nie przenosimy plików między obszarami.
3. Każdy uruchamia lint wyłącznie swoich ścieżek i typecheck dotkniętych pakietów; A filtruje trzy katalogi B
   przez `--ignore-pattern`. Pozostałe zgłoszenia limitów zapisuje jako zadania fazy 3.
4. Integrator scala poprawki i ponownie mierzy cały lint. Kryterium końca fazy 2: zero zgłoszeń poza dwiema
   regułami rozmiaru; istniejące testy bezpieczeństwa, adapterów i trwałości pozostają zielone.

## Faza 3: podziały po formatowaniu

**28 plików źródłowych i 2 testy** ponad limit. Liczby oznaczają linie kodu oxlint, nie fizyczne linie pliku.
Pełne 30 wpisów z propozycjami: `maxLinesAfterMechanicalPass`; pełne 55 zgłoszeń funkcji z linią i propozycją:
`maxLinesPerFunctionAfterMechanicalPass`. Propozycja jest dołączona do każdego wpisu, także funkcji w mniejszym pliku.

| Plik (skróty katalogów poniżej) | Kod | Proponowany podział |
| --- | ---: | --- |
| gateway `core/core.ts` | 2659 | fasada/okablowanie, work-loop, commands/queue, projects, threads/bot-threads, attachments, providers, interactions, settings, schedules/goals |
| gateway `store/store.ts` | 1388 | WorkerStore, ProjectStore, ThreadStore, TurnStore, InteractionStore, mapery UI; kompozycja Context.Service |
| gateway `computers/runtime.ts` | 1240 | pairing/presence, connection/retry, frame handlers, LAN/routes, mirror subscriptions, remote/relay serving |
| worker `runtime/host.ts` | 1227 | command handlers, runtime'y Claude/Codex, katalog/login, pliki; host jako fasada |
| gateway `store/agent-bus.ts` | 1192 | wywołania/wątki, harmonogramy, deliveries/interakcje, mapery |
| gateway `bots/store.ts` | 1137 | boty, rozmowy, exchanges/calls, approvals, handoffs, MCP, wakeups |
| gateway `computers/agents.ts` | 1084 | bot-tools, bus-tools, receive/dispatch, deliveries/tick, katalog/overview |
| `packages/db/test/schema.test.ts` | 1007 | fixture migracji i asercje per domena, w tym komputery; bez zmiany migracji |
| worker `providers/claude/threads.ts` | 917 | sessions, turns/consume/steer, permissions, output/goal |
| gateway `computers/shared.ts` | 916 | zegary/konflikty, read/write per rodzaj, referencje sekretów, push/receive, snapshot/diff |
| `tests/integration/bots.test.ts` | 836 | CRUD, rozmowy, approvals, routines; wspólny setup/cleanup |
| gateway `computers/moves.ts` | 834 | preview/inspect, source driver, target handlers, tick/recovery |
| gateway `computers/move-state.ts` | 773 | blockers/freeze/export, source commit/rollback, target stage/decision, bot/thread import, redirects/audit |
| worker `providers/codex/threads.ts` | 722 | sesje, turns/steer, dynamic tools |
| gateway `api/routed.ts` | 652 | lokalny/zdalny routing, overview, frozen/moved guards, stream/relay |
| worker `providers/codex/mapping.ts` | 648 | mapper, items, background, status/usage/errors |
| worker `providers/claude/mapping.ts` | 645 | mapper, background tasks, content/tools, goal verdicts |
| gateway `store/instances.ts` | 612 | CRUD/models, validation, sync/registerEndpoint |
| desktop `main.ts` | 586 | startup/lifecycle, IPC/authorization, windows/chrome, enrollment |
| web `lib/features/providers/instances.ts` | 475 | status, env/argument parsing, form, API |
| gateway `connectors/runtime.ts` | 468 | konfiguracja/OAuth i call/permission/execute |
| gateway `core/agent-bus.ts` | 463 | bus-tools per narzędzie i walidacja/serializacja |
| gateway `api/ui-service.ts` | 459 | uiHandlers per obszar i wspólne errors/guards |
| gateway `bots/runtime.ts` | 456 | lifecycle/tick, bot-turn, fasada API |
| web `routes/threads/[threadId]/+page.svelte` | 452 | stan/komendy strony i ThreadDialogs, także move dialogs |
| web `lib/shared/ui/virtual/VirtualFeed.svelte` | 447 | feed-anchor, feed-range, istniejący size-index; widok w komponencie |
| web `lib/features/threads/dev/tool-fixtures.ts` | 436 | galerie per rodzina narzędzi: shell, edit, MCP, bus |
| gateway `store/ingest.ts` | 435 | handlery turn/item/notice/steer/background, jedna transakcja |
| gateway `computers/remote.ts` | 414 | method policy, mapowanie id, wire errors, transport/cancellation |
| gateway `core/cli-tools.ts` | 402 | latest sources/cache i parser HTTP oddzielnie od administracji CLI |

Skróty: gateway = `apps/gateway/src/`, worker = `apps/worker/src/`, desktop = `apps/desktop/src/`,
web = `apps/web/src/`.

Najdłuższe funkcje: `bots/store.ts makeStore` **995**, `store/store.ts layer` **921** (generator 917),
`store/agent-bus.ts` generator **867**, `claude/threads.ts` fabryka **690** (generator 689),
`codex/threads.ts` **536** (generator 535), `store/instances.ts layer` **508** (generator 504),
`api/ui-service.ts uiHandlers` **351**, `tool-fixtures.ts toolGallery` **350**, `store/ingest.ts` **321**,
`connectors/store.ts connectorStore` **316**. To te same zadania co podziały serwisów/plików.

Nowe funkcje linked computers: `agents.ts botTool` 220, `tool` 149, `receive` 199 (wewnętrzna funkcja 130),
`shared.ts write` 144, `mirror.ts consume` 121 i `publish` 133. Rozdzielić handlery przy zachowaniu routingu domu,
idempotencji, owner scoping, kursorów i kontroli sekretów.

Pozostałe funkcje w plikach mieszczących się w limicie: `connectors/store`, `bots/platform/routines`,
`store/{background-tasks,queue,settings,thread-lifecycle,thread-secrets}`, `core/worker-ssh`, `worker/journal`,
`grok/bus`, desktop runtime i smoke-quit, komendy/animacje web, siedem komponentów mobile, `domain/agent-bus/policy`,
`updater/binary`, `scripts/prune-nightly`. Konkretne odpowiedzialności do wydzielenia i rozmiary każdego zgłoszenia
są w JSON. Komponenty mobile dzielimy na podkomponenty i hooki, nie na sztuczne helpery JSX.

Kolejność podziałów (jeden moduł na commit, bez zmiany logiki):

1. Pakiety/testy oraz mniejsze niezależne moduły: db schema, bots integration, domain policy, updater,
   desktop, mobile, web i mapery workerów. To ustala wzorce bez poruszania fasady gatewaya.
2. Gateway persistence: `store/store`, `store/instances`, `store/agent-bus`, `store/ingest`, pozostałe warstwy,
   `bots/store`, `connectors/store`. Najpierw ustabilizować kontrakty serwisów; nie importować ich konstruktorów.
3. Linked computers: `remote` i `move-state` jako niższe moduły, potem `shared`/`mirror`, następnie
   `moves`/`agents`, na końcu `runtime`. Pilnować dwufazowych przenosin, restartów, odwołania relay i mTLS.
4. Gateway orchestration: bots/connectors runtime, core helpers i agent bus, następnie `core/core`,
   na końcu `api/{routed,ui-service}`. Nie zmieniać jednocześnie eksportów store i importujących je fasad.
   Worker host dzielić po ustabilizowaniu mapperów i sesji dostawców.
5. Po każdym podziale lint/typecheck dotkniętego pakietu i istniejące testy danego zachowania; pełna weryfikacja
   po integracji. Dopiero przy zerowym lint dodać `lint` + `format:check` do CI/root `check` i zaktualizować AGENTS.md.

## Weryfikacja fazy 1

Obie bramki przeszły: po commicie mechanicznym i po aktualizacji dokumentacji/baseline'u.
W każdej zielone: `bun install`, `bun run gen:check`, `bun run typecheck`, `bun run check:tmp`,
`bun run --filter @canopy/web build`, `bun run --filter @canopy/desktop build:shell`, `bun run format:check`.
Każdy pełny przebieg testów: **823 pass, 150 skip, 0 fail**, 973 testy w 156 plikach; czas 615,30 s i 666,68 s.
`check:tmp` w obu przypadkach potwierdził brak pozostałości testów. Przypadki live pozostały opt-in i były pominięte.
Nowy config spacing dołączono do `tools/tsconfig.json`; dodatkowy typecheck tego projektu także przeszedł.
`bun run lint` pozostaje czerwony wyłącznie z powyższymi ręcznymi zgłoszeniami; nie jest jeszcze bramką CI.

Scratch i `TMPDIR` testów są w `~/.cache/canopy-anti-slop`, poza małym `/tmp`; po pracy są usuwane.
Nie uruchamiano serwerów na zastrzeżonych portach, publikacji ani testów E2E. Ocena UI w prawdziwej przeglądarce
(jasny/ciemny, desktop/telefon) pozostaje osobną niewykonaną weryfikacją; typecheck/build nie zastępują jej.
