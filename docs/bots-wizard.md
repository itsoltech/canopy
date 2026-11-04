# Tworzenie bota i edycja wyglądu

Komponenty w `apps/web/src/lib/features/bots/wizard` są prezentacyjne. Integracja z backendem należy do wywołującego; wizard nie tworzy bota przez własne API i nie wymaga workera. Pickery modelu i effortu pochodzą z `features/models` i korzystają z kontekstu standardowej powłoki aplikacji (m.in. ulubione modele).

Produkcyjna sekcja `/bots` podłącza `CreateBotWizard` do `CreateBot` przez BFF.
Adapter instancji i modeli jest w `features/bots/live.ts`; szczegóły runtime'u i API:
[bots.md](bots.md). Adapter zachowuje ID modeli i aliasy harnessu (`default`, `opus`…),
oferuje native i proxy dla Claude, Codex i Groka. Wykonanie tury wymaga workera
z włączoną instancją; bez przypięcia pierwsza tura stosuje regułę domyślnego wyboru.

## API

```svelte
<script lang="ts">
  import CreateBotWizard, {
    type BotProviderInstance,
    type CreateBotDraft,
  } from "#lib/features/bots/wizard/CreateBotWizard.svelte";

  let open = $state(false);
  // Z adaptera backendu: instancje z własnymi ModelOption[] i katalogami workerów.
  let instances: readonly BotProviderInstance[] = [];
  let existingNames: readonly string[] = [];

  async function create(draft: CreateBotDraft): Promise<void> {
    // Zapisz przez API botów. Odrzuć Promise z Error, aby pokazać błąd w dialogu.
  }
</script>

<CreateBotWizard bind:open {instances} {existingNames} oncreate={create} />
```

`BotProviderInstance` ma pola `{ id, name, provider, models, modelsByWorker? }`.
`provider` to `ProviderKey` (`CODEX | CLAUDE | GROK`), a `models` to istniejące
`readonly ModelOption[]`. `id` jest identyfikatorem instancji zwracanym w szkicu;
nie wynika z etykiety ani modelu. Adapter odpowiada za spójność modeli z instancją.
Device login i proxy są równoprawne. `modelsByWorker` zawęża modele po wyborze Runs on.
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
  workerId: string;              // "" = automatyczny wybór przy pierwszej turze
  model: string;                 // ModelOption.model, także "" = domyślny model
  effort: string | undefined;    // undefined = domyślny effort modelu
}
```

`open` jest bindable; dodatkowy opcjonalny prop `class` trafia do istniejącego `Dialog`. Każde ponowne otwarcie zaczyna nowy szkic. Linki konfiguracji otwierają istniejący overlay ustawień nad nadal zamontowanym kreatorem: zamknięcie ustawień lub Back przywraca nazwę, wygląd, model i effort. To szkic w pamięci bieżącego widoku, nie zapis po przeładowaniu strony. Zapis zamyka dialog dopiero po rozwiązaniu Promise; błąd zachowuje wybory. W trakcie zapisu kontrolki, zamykanie przez Escape, backdrop, uchwyt i przyciski są zablokowane. Wywołujący nadal może jawnie zmienić `open`.

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

Tworzenie zaczyna się od gotowości modelu i wyboru instancji oraz modelu/effortu. Brak dostępnego modelu pokazuje od razu jeden komunikat i link do Settings → Providers; stopka wyjaśnia blokadę tworzenia. Instancje z modelami są pierwsze. Wybór „Runs on” zawęża listę do instancji dostępnych na wybranym workerze; kontrakt wyglądu się nie zmienia.

Podgląd 64 px sąsiaduje z nazwą. Tworzenie ukrywa 14 kształtów, 11 kolorów i picker HSV/HEX za „Customise appearance”; edycja samego wyglądu pokazuje je od razu, bez pól modelu. Niepoprawny kolor przy zatwierdzeniu rozwija sekcję i kieruje fokus do pola HEX. Siatka kształtów ma pięć kolumn na telefonie i siedem od `sm`. Stopka z akcjami pozostaje przy dolnej krawędzi. Telefon używa istniejącego bottom sheet `Dialog`; własne wrappery kontrolują odstępy bez nadpisywania pozycjonowania/paddingu pickerów.

`AppearanceFields`, `ChoiceGrid`, `CustomColorPicker` i `MascotPreview` są współdzielone przez tworzenie i edycję. Sekcje korzystają z kitowego `Disclosure`, jego tokenów ruchu i obsługi reduced motion. `MascotFace` renderuje te same ścieżki SVG w podglądzie i `BotAvatar` (opcjonalny prop `appearance`). Stary hash oraz siedem dotychczasowych kształtów pozostają niezmienione, więc istniejące generowane awatary zachowują tożsamość.

Podgląd używa crossfade ze skalą według przepisu icon swap z `transitions-dev` i istniejących tokenów ruchu. Kolor przechodzi płynnie; wpisanie nazwy powoduje małe podbicie; oczy mrugają co 5,5 s. `prefers-reduced-motion` wyłącza te animacje. Oczy wybierają biały lub ciemny kolor według kontrastu luminancji sRGB, niezależnie od motywu.

Każda siatka radiowa ma jeden tab stop. Lewo/prawo przechodzi po opcjach, góra/dół odpowiada liczbie widocznych kolumn, Home/End przechodzi do krańców. Enter w nazwie, HEX lub siatce zatwierdza formularz; wewnątrz pickerów zachowuje ich własną obsługę. Suwaki HSV obsługują strzałki, Shift+strzałka, PageUp/PageDown, Home/End oraz przeciąganie. Nie ma natywnych `select`, `color`, `range` ani `radio`.

## Weryfikacja i galeria

`/dev/bots` zawiera tworzenie, edycję, scenariusz błędu zapisu, instancję bez modeli i pustą listę providerów. Mocki zapisują dane tylko w pamięci galerii. Trasa jest nadal dostępna wyłącznie w development.

Testy UI nie są utrzymywane w repozytorium (zasada: testy tylko dla integracji gateway↔worker i krytycznej logiki); widok sprawdza się w przeglądarce podczas pracy nad nim.
