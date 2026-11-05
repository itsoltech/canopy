# Jakość kodu: lint, formatter, limity rozmiaru

`bun run lint` (oxlint + anti-slop + limity rozmiaru) i `bun run format:check`
(oxfmt) są wymagane przez CI oraz root `check`. Reguły dla nowego kodu opisuje
także [AGENTS.md](../AGENTS.md).

## Narzędzia i polecenia

| Narzędzie | Pin | Rola |
| --- | --- | --- |
| `oxlint` / `@oxlint/plugins` | 1.91.0 / 1.91.0 | linter i API pluginów JS |
| [anti-slop](https://github.com/dmmulroy/anti-slop) | `13909c9e07590f5a85d93c62712259fe14a883f7` (v0.1.2) | vendorowane reguły w `tools/oxlint/anti-slop/` |
| `oxfmt` | 0.76.0 | formatter TS, TSX, Svelte, JSON, CSS, YAML |

Pochodzenie, licencje MIT i odstępstwa opisują `tools/oxlint/anti-slop/UPSTREAM.md`
oraz `vendor/eslint-stylistic/{LICENSE,UPSTREAM.md}` wewnątrz pluginu.
Aktualizacje porównujemy trójstronnie z przypiętym upstreamem. Politykę zmieniamy
w konfiguracji lub regule, zachowując lokalne poprawki.

- `bun run lint` sprawdza cały kod.
- `bun run lint:spacing` poprawia wyłącznie `require-readable-spacing` przez
  `oxlint.spacing.config.ts`. Nie uruchamiaj globalnego `oxlint --fix`.
- `bun run format` zapisuje formatowanie, a `bun run format:check` je sprawdza.
- `bun run typecheck` obejmuje także `tools/tsconfig.json` z pluginem i konfiguracją.

Osobny config spacing współdzieli `ignorePatterns` z głównym i wyłącza domyślną
kategorię `correctness`. Samo `-A all` nie wyłącza jawnie skonfigurowanych reguł
pluginów JS; do poprawiania odstępów używaj dedykowanej komendy.

`.oxfmtrc.json` ustawia `printWidth: 120`, `svelte: true`, `sortPackageJson: false`.
Sortowanie klas Tailwind korzysta z `apps/web/src/routes/layout.css` (v4 i własne
utility); kolejność klas w atrybucie nie zmienia ich priorytetu w CSS. Nie dodajemy
`max-len`: długie stringi, komentarze i atrybuty mogą pozostać w jednej linii.
Kod generowany, vendorowany, katalogi agentów i wyjścia buildów są ignorowane.
Formatter pomija też `packages/ui/src/palette.json` oraz dokumentację Markdown.

## Reguły i typy

- `anti-slop/no-shape-in-symbol-names` jest wyłączone: typy protobuf-es i kształt
  maskotki mają rzeczywiste znaczenie domenowe.
- `require-safety-comment-for-type-assertion` obowiązuje w źródłach, bez testów.
  Najpierw używamy dekodera, `satisfies` lub konkretnego typu; konieczne asercje
  wymagają komentarza `SAFETY:` opisującego invariant.
- `no-runtime-typeof` dopuszcza nazwane type guardy. Zewnętrzny JSON dekodujemy
  na granicy I/O. `JsonObject` / `JsonValue` z `@canopy/domain` służą rzeczywistemu
  JSON, a nie zastępowaniu dowolnego kontraktu danych wejściowych.
- Reguły `anti-slop-effect/*` obowiązują w pakietach z bezpośrednią zależnością
  `effect`; `prefer-effect-match` jest wyłączone w Svelte. Mobile zachowuje ESLint Expo/React.

`no-array-filter-map` poprawiamy przez `flatMap`. Iterator helpers nie są dostępne
przy `lib: ["ES2024"]`, a mobile używa Hermesa. W `.catch` zachowujemy jawny typ
i nazwę `cause`; usunięcie adnotacji nie może wprowadzać `any`.
Przy warunkowych spreadach uwzględniamy `exactOptionalPropertyTypes`.
Celowe sanitizery wymagają lokalnego uzasadnienia wyłączenia `no-control-regex`.
Nie wyłączamy reguł zbiorczo, aby ukryć naruszenia.

## Rozmiar i bezpieczne podziały

Limit pliku to 400 linii kodu bez pustych linii i komentarzy; funkcji 120,
również dla IIFE. Testy mają limit 800 linii pliku bez limitu funkcji.
Ręczne tabele SVG `packages/ui/src/icons.ts` i `mascot.ts` są wyłączone z limitów.
Oxlint mierzy w Svelte tylko bloki `<script>`, bez szablonu i stylów.
Zagnieżdżony generator Effect i jego fabryka mogą powodować osobne zgłoszenia.

Dzielimy pliki według odpowiedzialności i stabilnych kontraktów. Przy wydzielaniu
serwisów zachowujemy owner scoping, kolejność blokad, idempotencję, kursory,
transakcje i sprzątanie zasobów. Nie zastępujemy dużego komponentu sztucznymi
helperami JSX ani nie wyłączamy limitów rozmiaru.

Autofix `unicorn/no-useless-spread` może zmienić `[...string.slice(...)]` w string,
który nie ma `.join()`. `Array.from(string.slice(...))` zachowuje tablicę code pointów.
Svelte typecheck i web build wykonuj kolejno: oba zapisują `.svelte-kit`.
Tworzenie/usuwanie kontenerów może zmieniać interfejsy hosta i przerywać pobieranie
modułów przeglądarki (`ERR_NETWORK_CHANGED`); oddziel takie sprawdzenia od oględzin UI.

Historia mechanicznego formatowania jest w `.git-blame-ignore-revs`. Lokalnie
można ustawić `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
