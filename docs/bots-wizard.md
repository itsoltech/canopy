# Tworzenie bota i edycja wyglądu

Komponenty w `apps/web/src/lib/features/bots/wizard` są prezentacyjne. Integracja z backendem należy do wywołującego; wizard nie tworzy bota przez własne API i nie wymaga workera. Pickery modelu i effortu pochodzą z `features/models` i korzystają z kontekstu standardowej powłoki aplikacji (m.in. ulubione modele).

## API

```svelte
<script lang="ts">
  import CreateBotWizard, {
    type BotProviderInstance,
    type CreateBotDraft,
  } from "#lib/features/bots/wizard/CreateBotWizard.svelte";

  let open = $state(false);
  // Z adaptera backendu: tylko dostępne instancje, każda z własnymi ModelOption[].
  let instances: readonly BotProviderInstance[] = [];
  let existingNames: readonly string[] = [];

  async function create(draft: CreateBotDraft): Promise<void> {
    // Zapisz przez API botów. Odrzuć Promise z Error, aby pokazać błąd w dialogu.
  }
</script>

<CreateBotWizard bind:open {instances} {existingNames} oncreate={create} />
```

`BotProviderInstance` ma pola `{ id, name, provider, models }`. `provider` to obecny `ProviderKey` (`CODEX | CLAUDE`), a `models` to istniejące `readonly ModelOption[]`. `id` jest identyfikatorem instancji, który wraca w szkicu; nie jest wyliczany z etykiety, modelu ani `profileId`. Adapter wywołującego odpowiada za spójność modeli z instancją. Instancja bez modeli jest widoczna, ale nie pozwala utworzyć bota. Brak instancji pokazuje pusty stan.

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

```sh
bun test apps/web/src/lib/features/bots/mascot.test.ts apps/web/src/lib/features/bots/wizard/draft.test.ts
OA_BOTS_WIZARD_BROWSER=1 bun test tests/integration/bots-wizard.browser.test.ts
```

Test przeglądarkowy uruchamia własny `vite dev` na **5197**, używa `/usr/bin/chromium` oraz mockuje API powłoki i SSE. Nie uruchamia gateway, workera ani bazy. Sprawdza wyłącznie warstwę UI; zapis backendowy i wyścig unikalności należą do integracji botów. Zrzuty trafiają do ignorowanego `artifacts/bots-wizard/`: 1440 i 390 px, light/dark, każdy również z własnym kolorem `#a3e635`.
