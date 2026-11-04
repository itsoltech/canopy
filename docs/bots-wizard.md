# Tworzenie bota i edycja wyglądu

Komponenty w `apps/web/src/lib/features/bots/wizard` są prezentacyjne. Integracja z backendem należy do wywołującego; wizard nie tworzy bota przez własne API i nie wymaga workera. Pickery modelu i effortu pochodzą z `features/models` i korzystają z kontekstu standardowej powłoki aplikacji (m.in. ulubione modele).

Produkcyjna sekcja `/bots` podłącza `CreateBotWizard` do `CreateBot` przez BFF.
Adapter instancji i modeli jest w `features/bots/live.ts`; szczegóły runtime'u i API:
[bots.md](bots.md). Gateway wymaga konkretnego ID modelu API, więc adapter nie oferuje pustej
opcji domyślnego modelu harnessu, a alias z katalogu (`default`, `opus`…) pokazuje jako model,
na który się rozwiązuje (`resolved_model`). Aliasy bez rozwiązania są pomijane.

## API

```svelte
<script lang="ts">
  import CreateBotWizard, {
    type BotProviderInstance,
    type CreateBotDraft,
  } from "#lib/features/bots/wizard/CreateBotWizard.svelte";

  let open = $state(false);
  // Z adaptera backendu: instancje z własnymi ModelOption[] i opcjonalnym powodem blokady.
  let instances: readonly BotProviderInstance[] = [];
  let existingNames: readonly string[] = [];

  async function create(draft: CreateBotDraft): Promise<void> {
    // Zapisz przez API botów. Odrzuć Promise z Error, aby pokazać błąd w dialogu.
  }
</script>

<CreateBotWizard bind:open {instances} {existingNames} oncreate={create} />
```

`BotProviderInstance` ma pola `{ id, name, provider, models, disabledReason?, settingsHref? }`.
`provider` to `ProviderKey` (`CODEX | CLAUDE | GROK`), a `models` to istniejące
`readonly ModelOption[]`. `id` jest identyfikatorem instancji zwracanym w szkicu;
nie wynika z etykiety ani modelu. Adapter odpowiada za spójność modeli z instancją.
Device login ma `disabledReason` i link `settingsHref` do zmiany połączenia tej instancji.
Wbudowane id `native` nie oznacza Device login: po przełączeniu na Proxy jest wybieralne.
Instancja bez modeli jest widoczna, ale nie pozwala utworzyć bota.

Opcjonalne `loading`, `loadError` i `onreload` obsługują ładowanie oraz ponowienie pobrania.
Podczas ładowania i błędu pobrania wybór providerów jest zastąpiony odpowiednim stanem,
a zapis zablokowany również przy Enter. Strona pobiera definicje i katalog modeli przy
otwarciu oraz po zdarzeniu `provider_instances_changed`, zmianie wersji konfiguracji
workera i resynchronizacji strumienia. Dopiero zakończone pobranie może pokazać pustą listę.

`CreateBotDraft`:

```ts
{
  name: string;                  // trim + Unicode NFC
  shape: MascotShapeId;           // stabilny id z mascotShapes
  color: string;                 // nieprzezroczysty #rrggbb
  providerInstanceId: string;
  model: string;                 // ModelOption.model, także "" = domyślny model
  effort: string | undefined;    // undefined = domyślny effort modelu
}
```

`open` jest bindable; dodatkowy opcjonalny prop `class` trafia do istniejącego `Dialog`. Każde ponowne otwarcie zaczyna nowy szkic. Zapis zamyka dialog dopiero po rozwiązaniu Promise; błąd zachowuje wybory. W trakcie zapisu kontrolki, zamykanie przez Escape, backdrop, uchwyt i przyciski są zablokowane. Wywołujący nadal może jawnie zmienić `open`.

```svelte
<EditBotAppearance
  bind:open={editOpen}
  value={{ name: bot.name, shape: bot.shape, color: bot.color }}
  {existingNames}
  onsave={saveAppearance}
/>
```

`EditBotAppearance.svelte` eksportuje `BotAppearanceDraft` (`{ name, shape, color }`). `onsave` zwraca `Promise<void>` z tym samym zachowaniem busy/błędu. `existingNames` może zawierać bieżącą nazwę tego bota raz; walidacja pomija dokładnie jeden taki wpis. Porównanie nazw ignoruje wielkość liter, brzegowe białe znaki i różnice reprezentacji Unicode. Backend powinien ponownie sprawdzić unikalność przy zapisie.

## Wygląd i interakcje

Jeden przewijany formularz zachowuje wspólny kontekst: podgląd 160 px, nazwa, 14 kształtów, 11 kolorów i własny picker HSV/HEX, instancja oraz model/effort. Stopka z akcjami pozostaje przy dolnej krawędzi. Telefon używa istniejącego bottom sheet `Dialog`; własne wrappery kontrolują odstępy bez nadpisywania pozycjonowania/paddingu pickerów.

`AppearanceFields`, `ChoiceGrid`, `CustomColorPicker` i `MascotPreview` są współdzielone przez tworzenie i edycję. `MascotFace` renderuje te same ścieżki SVG w podglądzie i `BotAvatar` (opcjonalny prop `appearance`). Stary hash oraz siedem dotychczasowych kształtów pozostają niezmienione, więc istniejące generowane awatary zachowują tożsamość.

Podgląd używa crossfade ze skalą według przepisu icon swap z `transitions-dev` i istniejących tokenów ruchu. Kolor przechodzi płynnie; wpisanie nazwy powoduje małe podbicie; oczy mrugają co 5,5 s. `prefers-reduced-motion` wyłącza te animacje. Oczy wybierają biały lub ciemny kolor według kontrastu luminancji sRGB, niezależnie od motywu.

Każda siatka radiowa ma jeden tab stop. Lewo/prawo przechodzi po opcjach, góra/dół odpowiada liczbie widocznych kolumn, Home/End przechodzi do krańców. Enter w nazwie, HEX lub siatce zatwierdza formularz; wewnątrz pickerów zachowuje ich własną obsługę. Suwaki HSV obsługują strzałki, Shift+strzałka, PageUp/PageDown, Home/End oraz przeciąganie. Nie ma natywnych `select`, `color`, `range` ani `radio`.

## Weryfikacja i galeria

`/dev/bots` zawiera tworzenie, edycję, scenariusz błędu zapisu, instancję bez modeli i pustą listę providerów. Mocki zapisują dane tylko w pamięci galerii. Trasa jest nadal dostępna wyłącznie w development.

Testy UI nie są utrzymywane w repozytorium (zasada: testy tylko dla integracji gateway↔worker i krytycznej logiki); widok sprawdza się w przeglądarce podczas pracy nad nim.
