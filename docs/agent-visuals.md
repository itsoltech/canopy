# Obrazy w odpowiedziach i interaktywne visuals

Status (2026-11-19): **obrazy, `render_visual` i `render_html` zaimplementowane** w web/desktop/mobile.
Na Windows w trybie lokalnym `show_images` obsługuje też katalog Temp profilu użytkownika.
Claude ma 15-minutowy limit wywołania `show_images`. Worker zwraca błąd od razu
po wykryciu utraty połączenia podczas oczekiwania na wynik.
Własny HTML na desktopie ma interaktywny podgląd w rozmowie z odizolowanego procesu.
Interaktywny podgląd lokalnej automatyzacji w wątku web/desktop również jest
zaimplementowany. Galerie `show_images` pojawiają się po zakończeniu ich tury.
To stan kodu, nie deklaracja wdrożenia; dostępność kanałów
według [release.md](release.md).
Dokument opisuje bieżący kontrakt publikacji, odczytu i izolacji. Limity struktur
są sprawdzane przez kod; budżety CPU, pamięci klientów i płynności pozostają celami
wymagającymi pomiarów. Własny HTML ma odrębny model wykonania i ryzyka (§9).

## 1. Rekomendacja i zakres

Agent pokazuje wynik pracy przez trwałą publikację w wątku.
Obrazy publikujemy jako trwałe załączniki, a interaktywne materiały nazywamy
**visuals** (w UI pojedynczy „Visual”). Każdy wynik należy do wątku i jego domu.

| Obszar | Bieżący kontrakt |
| --- | --- |
| Publikacja obrazów | `show_images` jako główna droga; lokalne obrazy Markdown przechodzą ten sam import; zwykłe ścieżki pozostają linkami/chipami. |
| Trwałość | Kopia w storage załączników gatewaya. Odczyt nie zależy od istnienia pliku ani dostępności workera po publikacji. |
| Format visuals v1 | Wersjonowane drzewo komponentów JSON, kompilowane do samowystarczalnego HTML z zaufanym kitem Canopy. |
| Interakcje | Lokalny stan komponentów, bez wywołań agenta lub API. `ask_user` pozostaje osobną interakcją poza visualem. |
| Klienci | Galerie oraz komponentowe visuals w web/desktop/mobile; własny HTML w przeglądarkowym iframe, podglądzie desktopu w rozmowie lub mobilnym WebView (§9). |

Kryterium użytkowe: po prośbie o wygląd zmian użytkownik widzi wybrane zrzuty
w odpowiedzi agenta, otwiera pełny obraz i pobiera go również z telefonu.
Po prośbie o diagram lub wariant przycisku zmienia kroki, zakładki i warianty
bez wychodzenia z wątku. Ponowne otwarcie odtwarza opublikowany materiał.

Komponentowe v1 nie przyjmuje dowolnego HTML/JS, kodu projektu, URL-i ani zależności
z CDN. Własny HTML i inline JS obsługuje osobne, wdrożone `render_html` (§9),
z inną granicą ryzyka. Współdzielony stan kontrolek i bridge wykonujący akcje
Canopy z wnętrza visuala pozostają poza zakresem obu formatów.

### Współdzielone elementy

Źródła: [architektura](architecture.md), [narzędzia szyny §3 i §9](agent-bus.md),
[pliki botów](bots.md#pobieranie-i-wysyłanie-plików),
[załączniki UI](ui-api.md#załączniki), [protokół](protocol.md#załączniki),
[mobile](mobile.md), [połączone komputery](linked-computers.md#podglądy-załączników),
[copy](copy.md), [skala UI](ui-scale.md), [pomiary](client-performance.md).

`view_image` służy do **oglądania przez model**: wykonuje je worker,
wynik obrazu trafia do harnessu, a na osi czasu pozostaje „Viewed image”.
Podgląd może być pomniejszony do 2000 px i około 3,75 MB. Nie zmieniamy znaczenia
tego narzędzia ani nie przedstawiamy jego miniatury jako pełnego wyniku QA.
Natywne odczyty i obrazy wygenerowane przez harness nadal mają swoje itemy.

Botowe `send_attachment` ma już bezpieczny eksport scratch → gateway,
kontrolę aktywnej tury, atomowe związanie pliku i deduplikację wywołania.
`download_file` zapisuje do scratch, lecz samo nie wysyła pliku. Ponownie używamy
tych granic i storage, nie udostępniamy wątkom całego scratch botów ani
botom plików projektów. Istniejące `Attachment`, miniatury WebP 512 px,
`MessageAttachments`, `Lightbox`, `ZoomableImage` i mobilny viewer stanowią bazę.

## 2. Obrazy: trzy sposoby publikacji

| Sposób | Zalety | Koszt / ryzyko | Wybór |
| --- | --- | --- | --- |
| Jawne `show_images` | Intencja publikacji, podpisy, kolejność, pary, kontrolowany limit i wynik narzędzia. Działa jednakowo u providerów. | Agent musi znać narzędzie; potrzebny eksport worker → gateway. | Główna droga. |
| `![opis](relative/path.png)` | Naturalna odpowiedź, zachowuje pozycję obrazu w tekście i tekst alternatywny. | Potrzebny trwały manifest importu; plik może zniknąć przed zakończeniem wiadomości. | Wsparcie w workspace bieżącego wątku, przez ten sam importer. |
| Goła ścieżka w prozie lub kodzie | Nie wymaga nowego zachowania modelu. | Nie odróżnia przykładu, logu, wejścia ani wyniku; 59 ścieżek mogłoby uruchomić 59 odczytów. | Link/chip otwierany na żądanie, bez automatycznego importu i ładowania. |

Przy 59 zrzutach agent wybiera np. 6 reprezentatywnych obrazów, grupuje je
w pary przed/po i opisuje resztę. Pełny zestaw publikuje partiami wyłącznie
gdy użytkownik go potrzebuje; narzędzie nie rozwija globów ani katalogów.
Nie tworzymy galerii automatycznie z wyników `ls`, bloków kodu lub logów.

### Kontrakt `show_images`

```ts
show_images({
  images: [
    { path: "tmp/qa/header-before.png", alt: "Header before the spacing change", pair: "header", side: "before" },
    { path: "tmp/qa/header-after.png", alt: "Header with the updated spacing", pair: "header", side: "after" },
  ],
  caption: "Header spacing on desktop.",
})
// → { item_id, images: [{ attachment_id, name, width, height }], delivered: true }
```

`images` ma 1–10 jawnych ścieżek. `alt` jest wymagane, 1–300 znaków;
opcjonalny podpis pojedynczego obrazu ma do 500 znaków, `caption` do 1000.
`pair` (do 64 znaków) i `side` występują razem; para ma dokładnie dwa obrazy
`before`/`after`. Brak par oznacza zwykłą galerię. Nadmiarowe pola są błędem.
Gateway wyprowadza ownera, wątek, turę i workera z wywołania, nigdy z argumentów.
Wynik dla modelu zawiera referencje i metadane, bez bajtów obrazów.

W adapterze Claude `show_images` ma limit 15 min zamiast 330 s. Wspólny limit
serwera MCP i termin przekazywany do gatewaya obejmują te 15 min; pozostałe
wywołania do gatewaya zachowują 330 s. Limity samego transferu opisane poniżej
obowiązują niezależnie.

Wywołanie tworzy samodzielny item odpowiedzi `image_gallery`, widoczny w strumieniu
odpowiedzi agenta także po zwinięciu pracy. Nie jest schowane wewnątrz tool calla.
Tekst narzędzia może prowadzić do tego samego itemu, lecz nie dubluje galerii.
Wiadomość końcowa może go zacytować przez zwrócone `item_id`. Brak końcowej
wiadomości lub przerwanie następnego kroku nie usuwa już zatwierdzonego wyniku.

### Zrzuty narzędzi automatyzacji

Trzy ścieżki obrazu mają różną trwałość:

1. **Preview wątku** przesyła nietrwałe klatki do 2 MiB przez WorkerLink,
   gateway i BFF, z ACK i dzierżawą. Browser korzysta z natywnego strumienia
   `agent-browser`, a Desktop/Device ze współdzielonych, anulowalnych pętli
   zrzutów, bez transmisji wideo. Zamknięcie podglądu usuwa klatki; nie ma
   itemu, outboxa, journala, lustra ani trwałej galerii. Settings służy
   instalacji, statusowi i grantom.
2. **MCP używany przez model** zwraca upstreamowe bloki z limitem mostka 6 MiB i
   zachowuje ich MIME. Wynik trafia do transcriptu providera i journala, a
   obrazy są kopiowane do workerowego `PreviewStore` przed zapisaniem zdarzenia.
   Dotyczy to Claude, Codexa i Groka. Ekstrakcja Grok rozpoznaje opakowane bloki
   ACP oraz `rawOutput` jako obiekt, envelope albo JSON string, wiąże je z
   `toolCallId`, deduplikuje wspólną treść i scala wcześniejsze patche obrazu przy
   końcowym itemie, także gdy końcowa aktualizacja status-only nie zawiera
   `content` ani `rawOutput`. Oryginalne aktualizacje ACP pozostają byte-for-byte
   w `rawJson`; gdy trzeba odziedziczyć obrazy, mapper zachowuje patch raw-only i
   dodaje syntetyczne `itemCompleted` dla `PreviewStore`, wyłącznie gdy scalony
   stan ma więcej obrazów inline niż oryginalne zakończenie. Taki obraz jest
   trwałym preview itemu narzędzia, ale nie jest automatycznie galerią
   `image_gallery`.
3. **`show_images`** publikuje końcową trwałą galerię owner-scoped. Jawny import
   obrazu Markdown korzysta z tego samego pipeline'u załączników. `view_image`
   pozostaje narzędziem oglądania obrazu przez model.

Podgląd panelu i publikacja modelu nie powinny być utożsamiane
([automation-tools.md](automation-tools.md)).

### Import, przechowywanie i awarie

1. Gateway rezerwuje limity oraz receipt po `(thread_id, turn_id, call_id)`
   i autoryzuje aktywną turę, przypisanie workera oraz politykę publikacji.
2. Worker bezpiecznie otwiera wskazane pliki i tworzy ograniczony snapshot
   eksportu. Czyta ze sprawdzonego uchwytu do ograniczonego bufora, z licznikiem
   bajtów, hashem i kontrolą zmiany pliku. Transfer korzysta z tego snapshotu;
   zmiana podczas odczytu daje odmowę i wymaga ponowienia przez agenta.
3. Gateway odbiera porcje z backpressure, sprawdza hash i długość, rozpoznaje
   typ z bajtów i przepuszcza pliki przez istniejący pipeline załączników.
4. Jedna transakcja wiąże wszystkie załączniki, manifest galerii, zdarzenie,
   audyt i wynik wywołania. Dopiero commit daje `delivered: true`.
5. UI pobiera miniatury przez owner-scoped `GetAttachment`, pełny obraz dopiero
   po otwarciu. Eksport oraz osierocone uploady są sprzątane po błędzie/retry.

Eksport używa addytywnej komendy `ExportThreadImage` (231) i wyniku
`thread_image_export` (231), dostępnych wyłącznie dla przypisanego workera. Nie wysyłamy dużych
obrazów jako JSON/base64 w `AgentToolCall` lub `WatchThread`. Porcje eksportu
mają najwyżej 256 KiB, najwyżej dwa importy na worker i jeden na wątek;
timeout operacji 60 s, bezczynności 10 s. Rezerwacja obejmuje dane wejściowe
i wynik po przetworzeniu. Limity obowiązują przed alokacją i podczas strumienia.
Rozłączenie zamyka snapshot eksportu. Oczekujące `show_images` kończy się
lokalnym błędem z informacją, że publikacja mogła już zostać zapisana.
Agent powinien sprawdzić wątek przed ponowieniem. Worker nie odsyła tego
wywołania po reconnect. Zapisany receipt przeżywa restart gatewaya i przy
powtórzeniu tego samego ID zwraca tę samą galerię. Brak jednego pliku odrzuca
całą partię z indeksem błędu; nie ma cichej częściowej publikacji.

Galeria i kopie żyją zgodnie z retencją wątku, niezależnie od usunięcia źródła
lub worktree. Usunięcie wątku odbiera dostęp od razu; blob GC zachowuje pliki
referencjonowane przez fork/cytat zgodnie z polityką transkryptu. Nie robimy
globalnej deduplikacji ujawniającej istnienie pliku innego właściciela.

### Granice plików i treści

| Granica | Reguła |
| --- | --- |
| Korzenie | Rzeczywisty katalog bieżącego wątku (`cwd`, także worktree/scratch, jeśli wątek tam działa) oraz jego własny katalog załączników pod `attachmentsRoot/thread_id`. Jawne `show_images` na wbudowanym workerze Windows w trybie lokalnym obejmuje też `%LOCALAPPDATA%\Temp`. Import Markdown dopuszcza tylko katalog roboczy zapisany przy wiadomości. |
| Otwieranie | Ścieżki względne od `cwd`; do pliku w Temp potrzebna jest pełna ścieżka absolutna. Odrzucenie traversal, NUL, dowiązań w komponentach ścieżki, plików specjalnych i junction/reparse escape na Windows. Otwarcie względem zaufanego katalogu z kontrolą uchwytu; sam `realpath` przed późniejszym `readFile` nie chroni przed wyścigiem. Brak bezpiecznego prymitywu na danej platformie = odmowa. |
| Rozmiary | Minimum z limitów właściciela i sufitu narzędzia: 10 obrazów, 20 MiB/pliki wejściowe i wynikowe, 50 MiB/partię, 100 Mpx/obraz. Limit dekodera i współbieżności chroni także przed bombami dekompresji. Do 100 obrazów i 200 MiB na turę; brak automatycznego obejścia kolejnym wywołaniem. |
| Typy | Sniffing przed dekodowaniem, obrót EXIF, usunięcie EXIF/GPS/XMP i miniatura. V1 publikuje PNG/JPEG/WebP; inne obsługiwane rastry konwertuje, animacje spłaszcza do pierwszej klatki. GIF nie korzysta tu z istniejącej ścieżki zachowującej oryginał. SVG jest plikiem do pobrania, nigdy aktywnym DOM, `object` ani iframe; nie wchodzi do galerii. |
| Uprawnienia | Dom gatewaya sprawdza ownera przy publikacji i każdym odczycie, obcy plik = `NotFound`. Odrzuca cudzy worker, turę, scratch i podrobioną referencję. Poświadczenia connectorów i kanałów zostają w gatewayu; żaden token nie trafia do modelu, HTML ani payloadu obrazu. |

Worker wyznacza Temp z własnego `LOCALAPPDATA` w obrębie profilu użytkownika.
Weryfikuje wszystkie składowe ścieżki korzenia i odrzuca przekierowanie przez
junction lub inny punkt ponownej analizy. Zakres obejmuje standardowy katalog
`Temp` także przy nadpisanych zmiennych `TEMP` lub `TMP`. Agent przekazuje pełną
ścieżkę do istniejącego pliku, np. zwróconą przez zewnętrzne narzędzie do zrzutów.

Download zwraca pełną rozdzielczość **oczyszczonej kopii**, nie oryginał z EXIF.
Screenshot może zawierać sekret w samych pikselach; stripping metadanych go nie
usuwa. Agent wybiera materiał odpowiedni do publikacji w wątku właściciela.
Odczyt i publikacja nie podnoszą uprawnień harnessu i respektują istniejące zgody.

### Markdown i zwykłe ścieżki

Importer działa na kompletnym, zakończonym itemie wiadomości, na tokenach obrazu
Markdown poza kodem. Worker zgłasza żądanie importu przez ten sam autoryzowany
dispatcher; receipt ma stabilny klucz item + indeks tokenu + hash źródła.
Oryginalny Markdown zostaje bez zmian, a gateway zapisuje manifest
`token → attachment_id` w tym samym strumieniu przyrostowych aktualizacji itemu.
Renderer nigdy nie czyta dysku podczas wyświetlania starej wiadomości.

Ta ścieżka przyjmuje wyłącznie jawny lokalny plik w workspace/worktree wątku,
bez wyszukiwania po samej nazwie. Podpis to alt Markdown; obowiązują wspólne
limity publikacji, deduplikacja w obrębie tury i kontrola ścieżki. W trakcie importu
jest stały placeholder. Błąd pozostawia chip z powodem i linkiem do podglądu,
a nie niedziałający obraz. Utrata workera przed importem nie daje obietnicy
trwałej kopii; dlatego model ma preferować `show_images` przed usunięciem plików.

Zewnętrzne HTTP(S), `data:`, `file:`, adresy sieciowe i schematy niestandardowe
nie są automatycznie importowane ani ładowane przez `<img>`. HTTP(S) pozostaje
linkiem otwieranym po decyzji użytkownika, bez proxy-fetch i wycieku IP/referrera
przy czytaniu wątku. Jawne pobranie z internetu to oddzielne narzędzie z kontrolą
SSRF, jak `download_file`, a następnie publikacja lokalnej kopii.

Gołe ścieżki korzystają z istniejących `file-references` i `ReadThreadFile`.
To jawny, żywy podgląd do 2 MiB: wymaga osiągalnego workera, może zobaczyć nową
treść i przestaje działać po usunięciu pliku. Nie jest podstawą trwałej galerii.

### Galeria, telefon i połączone komputery

Galerie `show_images` w web/desktop/mobile pojawiają się pod odpowiedzią dopiero
po zakończeniu swojej tury (`completed`, `interrupted`, `failed`, `cancelled`),
również przy zwiniętej sekcji pracy. W aktywnej turze nie zajmują miejsca na osi
czasu i nie pobierają miniatur. Publikacja nadal od razu zapisuje trwałą kopię;
odłożony jest tylko widok. Przeładowanie wątku stosuje tę samą regułę, a obrazy
z poprzednich tur pozostają widoczne podczas kolejnej. Interaktywne visuals
pozostają dostępne w trakcie pracy; obrazy Markdown zachowują pozycję w tekście.

Galeria pokazuje maksymalnie 6 miniatur w 3 kolumnach desktopu i 2 telefonu;
„Show all 10” rozwija resztę bez pobierania pełnych obrazów. `width`/`height`
oraz ramka o stałych proporcjach rezerwują miejsce przed dekodowaniem.
Cały zrzut mieści się przez `object-fit: contain`, bez obcinania istotnego UI.
Podpis, nazwa i stan mają zarezerwowane miejsce; długie podpisy zawijają się.

Kliknięcie otwiera istniejący lightbox z licznikiem, podpisem, powiększaniem,
poprzednim/następnym i „Download image”. Para ma „Before” / „After” oraz
„Compare images”; na telefonie porównanie jest przełącznikiem lub stosem,
bez wymagania precyzyjnego suwaka. Gest nie jest jedyną drogą nawigacji.
Focus trap, Escape/Android back, powrót do miniatury, etykiety i alt są wymagane.
Ładowanie oraz błąd nie zmieniają rozmiaru komórki; „Couldn't load this image.”
ma akcję „Retry”. Użytkownik zachowuje kotwicę scrolla po otwarciu i zamknięciu.

Web/desktop używa BFF z `private, immutable`, ETag i `nosniff`. Mobile korzysta
z przypiętego Connect oraz istniejącego prywatnego cache obrazów, anulowania
odczytów, Share na iOS i zapisu do wskazanego katalogu na Androidzie. Bez nowych
uprawnień do biblioteki zdjęć i bez base64 trzymanego w stanie listy.

Dom wątku przechowuje kopie; kwalifikowane ID (`uuid~node`) kieruje odczyt
do niego z dowolnego klienta. Metadata należy do lustra, bajty nie. Wyłączenie
workera po publikacji nie przeszkadza, wyłączenie domu pozwala obejrzeć tylko
wcześniej pobrany cache. Pozostałe pliki pokazują „Available when <computer>
is connected.” i „Retry”. Serwerowa rola gatewaya nie zyskuje linkowania;
używa swojego zwykłego połączenia z workerem i telefonu z Connect.

## 3. Visuals: format i gotowe komponenty

### Kompozycja i galeria deweloperska

Kit korzysta z tokenów motywu Canopy i skali `ui-scale.md`. Makietę aplikacji
buduj z `device_frame`, krótkich nagłówków, `stat` i list danych zamiast akapitów.
`list.items` zachowuje obsługę tekstów v1; opcjonalnie przyjmuje obiekty
`{ label, detail?, value?, tone? }`. Wartość jest wyrównana do prawej i używa cyfr
tabelarycznych. Kwoty formatuje agent, łącznie ze znakiem i walutą; kolor jest
dodatkowym sygnałem, nie zastępuje znaku. Nie dodajemy HTML ani dowolnych stylów.

Galeria: `PORT=5397 bun packages/domain/scripts/visual-gallery.ts`.
Osobny serwer deweloperski wiąże tylko loopback i nie trafia do aplikacji.
Pokazuje wszystkie typy komponentów, makietę bankową z sekwencją logowania,
jasny i ciemny motyw oraz szerokości 360/960 px. Artboardy obejmują telefon,
tablet, desktop i przeglądarkę; kontrolki pozwalają sprawdzić warianty i stany.
Każda ramka używa produkcyjnego kompilatora i sandboxa, bez sieci ani kodu modelu.
Po zmianie kitu wygeneruj `packages/domain/src/visuals/gen/kit.ts` przez `bun run gen`.
Galeria zawiera także niezmieniony format list tekstowych v1. Sekwencja z
`step_from` wyznacza zakres dla przycisków `next`/`previous` z liczby wiadomości,
bez konieczności dodawania osobnego steppera. Jawne wartości starszych specyfikacji
pozostają dozwolone.

| Format | Co daje | Co utrudnia |
| --- | --- | --- |
| Samowystarczalny HTML + CSS/JS kit | Duża swoboda układu; łatwy eksport; znajomy model generowania. | Agent może ominąć kit, dodać nieograniczoną pętlę JS, DOM lub zasoby. CSP izoluje dane i sieć, lecz nie daje twardego limitu CPU/pamięci iframe. Same klasy nie zapewniają spójności i dostępności. |
| Drzewo komponentów JSON | Ścisła walidacja, konsekwentny wygląd, ograniczona liczba węzłów i przejść. Zaufany runtime renderuje HTML i interakcje, wspólny dla klientów. | Węższy katalog; nowy typ wymaga wersji kitu. Nie zastąpi dowolnej aplikacji ani fragmentu Svelte. |

**Komponentowe v1 używa drzewa JSON.** Użytkownik otrzymuje interaktywny HTML,
ale nie wykonujemy kodu wygenerowanego przez agenta. Przyciski mają lokalne
przejścia stanu realizowane przez skrypty kitu wewnątrz sandboxa. Diagram
przepływu, wybór artboardu i playground przycisków mieszczą się w tym zakresie.
Własny HTML ma osobne narzędzie `render_html` i kontrakt z §9; spec komponentów
nie ma ukrytych pól `html`, `script`, `style` ani `onClick`.

### Kontrakt `render_visual`

```ts
render_visual({
  title: "Button variants",
  description: "Compare button emphasis in light and dark themes.",
  height: 360,
  spec: {
    schema_version: 1,
    state: { variant: "primary" },
    root: {
      type: "stack",
      children: [
        { type: "segmented", label: "Variant", state_key: "variant",
          options: ["primary", "secondary", "ghost"] },
        { type: "button_preview", label: "Add worker", variant_from: "variant" },
      ],
    },
  },
})
// → { visual_id, item_id, version: 1, citation_ref, delivered: true }
```

`title` 1–100 znaków, opis alternatywny 1–1000, `height` opcjonalnie 160–720 px,
domyślnie 360. Jest wskazówką rezerwacji miejsca, nie rozmiarem całego dokumentu.
UTF-8 JSON do 128 KiB, drzewo do 300 węzłów i 12 poziomów, tekst do 32 KiB.
Schemat per komponent odrzuca nieznane pola, nieznany token i niedozwolony typ.
Maksymalnie 10 visuals i 1 MiB specyfikacji na turę, do 2 MiB skompilowanego
HTML z przypiętym kitem na eksport. Przekroczenie to błąd z limitem, bez ucięcia.

| Rodzina kitu v1 | Przykładowe elementy i ograniczenia |
| --- | --- |
| Układ i treść | `stack`, responsywny `grid` 1–4 kolumny, `card`, `text`, `badge`, `callout`, tabela do 100 × 12 komórek. Tekst escapowany, bez HTML i dowolnego CSS. |
| Sterowanie | Przyciski, tabs, segmented controls, toggles, stepper i jawny reset; nazwana pula stanu do 32 kluczy, wyłącznie enum/boolean/liczba z ograniczonym zakresem. |
| Porównania | `before_after`, wybór artboardu, `device_frame`, `button_preview` z dozwolonymi wariantami, rozmiarem i stanem disabled/loading. |
| Diagramy | `flow` i `sequence` z podpisami i listą kroków, najwyżej 40 węzłów i 80 krawędzi. Układ z kitu, bez parsowania wykonywalnego DSL. |
| Dane | Wykres słupkowy/liniowy do 200 punktów łącznie i 6 serii, legenda oraz dostępna tabela danych. Bez bibliotek pobieranych z sieci i kodu formattera. |

Spec używa tokenów zamiast arbitralnych rozmiarów i klas. Akcje lokalne to
`set`, ograniczony `next`/`previous`, `toggle`, `reset` i pokazanie panelu po wartości
stanu. Brak wyrażeń JS, rekurencji, pętli, dynamicznego kodu oraz timerów
definiowanych przez model. Referencje do kluczy i opcji są sprawdzane przed
zapisem; przycisk ma najwyżej 8 akcji, bez łańcuchów efektów. Zaufane
komponenty mogą animować zmianę według tokenów ruchu.

V1 nie przyjmuje URL-i, lokalnych ścieżek ani obrazów `data:` w spec. Obrazy
pozostają osobnymi galeriami obok visuala. Późniejsze osadzanie wymaga
owner-scoped referencji do już opublikowanych załączników i jawnego budżetu;
nie może umożliwiać fetch z wnętrza iframe.

### Wygląd i dostępność

Kit czerpie wartości z `packages/ui/src/themes.ts`, `tokens.ts`, webowych
`scale.css` i `motion.css`: semantyczne `canvas`, `surface`, `panel`, `ink`,
`muted`, `border`, `accent`, `action`, font oraz Interface size. Nie kopiuje
prywatnych klas aplikacji do treści agenta. Wersja kitu jest niezmienna;
host przekazuje wyłącznie zwalidowaną mapę tokenów, a nie dowolny arkusz CSS.

Tekst treści ma 16/14 px (telefon/desktop), podpisy i chrome odpowiadają
[skali](ui-scale.md). Cele dotykowe minimum 48 px, segmenty mają powiększony
obszar dotyku; kolumny przechodzą w stos przy wąskim kontenerze. Nazwy własne
i podpisy zawijają się, menu skraca z możliwością odczytu pełnej wartości.
Fonty systemowe lub lokalne, bez Google Fonts/CDN i bez skanowania fontów.
Eksport używa fallbacków systemowych, nie dołącza prywatnych plików fontu.

HTML jest semantyczny: nagłówki, etykiety, kolejność Tab, focus ring, strzałki
w tabs/segmented, widoczny stan wybrania i `aria-live` dla wyniku kroku.
Diagram ma opis i listę połączeń, wykres tabelę. Kolor nie jest jedynym nośnikiem.
`prefers-reduced-motion` i ustawienie Canopy wyłączają pętle i przesunięcia.
Zmiana kontrolki nie przesuwa jej ani sąsiednich akcji.

## 4. Sandbox i klienci

Poniższa granica dotyczy komponentowego `render_visual`; własny HTML ma dodatkowe
ograniczenia i odizolowany renderer desktopu opisane w §9. Web/desktop montuje dokument
wygenerowany przez zaufany kompilator w
`<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">` przez `srcdoc`.
Bez `allow-same-origin`, formularzy, popupów, nawigacji top i downloads.
To osobny, opaque origin: brak DOM Canopy, cookies, localStorage aplikacji,
tokenów i API. Zwykły załącznik `.html` nadal jest plikiem/tekstem, nie visualem.

Shell hosta i CSP powstają poza danymi modelu; polityka dokumentu komponentowego:

```text
default-src 'none'; script-src 'nonce-<per-mount>'; script-src-attr 'none';
style-src 'nonce-<per-mount>'; img-src 'none'; font-src 'none';
connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none';
child-src 'none'; worker-src 'none'; manifest-src 'none';
base-uri 'none'; form-action 'none'
```

Nonce ma tylko przypięty runtime kitu, style oraz style tokenów. Dane spec
są bezpiecznie serializowane (w tym `</script>`), a tekst trafia przez textContent.
Bez `unsafe-eval`, event handlerów z argumentów i importów. Renderer nie tworzy
linków nawigacyjnych, form, meta refresh ani elementów osadzających. CSP oraz
sandbox są dodatkową granicą także przy błędzie walidacji. Sam CSP nie jest
gwarancją limitu pamięci i nie zastępuje ograniczeń drzewa komponentów.

### Minimalny kanał sterowania host ↔ visual

Po montażu host tworzy MessageChannel i przekazuje port wyłącznie danemu
`contentWindow`. Pierwszy handshake sprawdza `event.source`, identyfikator
instancji, wersję protokołu i losowy nonce montażu. Opaque origin ma `"null"`;
nie wolno ufać samej wartości origin ani globalnie przyjmować wiadomości.
Początkowe `postMessage` może wymagać `"*"`, ale kierujemy je do konkretnego okna,
bez sekretów. Dalszy ruch korzysta tylko z przypiętego portu.

Dozwolone komunikaty v1: host → `theme`, `visibility`, `reduced_motion`, `reset`;
visual → `ready`, `height`, `local_state`, `render_error`, `escape`, `hover`
(`escape` to wyłącznie klawisz Escape, aby host mógł zamknąć pełny ekran; `hover`
to sam boolean „wskaźnik nad ramką”, bez współrzędnych; żadne inne wejście
nie jest przekazywane). Ścisły schemat,
do 8 KiB/komunikat, najwyżej 10/s; `height` i `hover` najwyżej 4/s. Host odrzuca NaN,
wartości ujemne, starą wersję/nonce oraz wiadomości innej ramki. ResizeObserver
w kicie zgłasza naturalną wysokość, host ją ogranicza do 160–720 px i stosuje
jedną zmianę na klatkę. Bez `vh` lub `height:100%` na korzeniu i bez pętli
rozmiar → iframe → observer. Po przekroczeniu wysokości treść przewija się
wewnątrz; „Open full screen” otwiera hostowy modal z tym samym sandboxem.

Przewijanie wątku nad ramką: dokument kitu przewija się tylko wtedy, gdy host
przyciął ramkę poniżej treści (inaczej `overflow: hidden`, bo dokument zdolny
przewinąć się choć o piksel przejmuje kółko na cały gest). Kółko i dotyk nad
ramką przewijają feed przez scroll chaining, ale same zdarzenia zostają w ramce,
więc feed nie widzi gestu czytelnika i cofałby taki scroll jako zmianę układu.
Dlatego kit zgłasza `hover`, a feed traktuje scroll pod wskazaną ramką jak
gest czytelnika; własny ruch wskaźnika w dokumencie hosta zeruje ten stan.

`local_state` zawiera wyłącznie 32 dozwolone wartości do 4 KiB. Host waliduje
je względem spec, buforuje na urządzeniu i może odtworzyć po ponownym montażu.
To niewrażliwy cache UI, bez synchronizacji, nowej tury i zapisu do gatewaya;
awaria lub czyszczenie cache wraca do stanu początkowego. Zmiana wersji visuala
resetuje ten stan. Referencje i cytaty zawsze wskazują wersję, nie stan kliknięć.

### Electron i mobilny WebView

Electron zachowuje `nodeIntegration: false`, `contextIsolation: true`,
`sandbox: true`, `webSecurity: true` i `webviewTag: false`. Visual jest iframe
wewnątrz renderera, nie `<webview>`. Preload ani IPC nie mogą być dostępne
subframe'om; eksport i pełny ekran obsługuje wyłącznie host po jego kliknięciu.
Istniejące blokady `window.open`, nawigacji i uprawnień pozostają aktywne.

Mobile renderuje Markdown natywnie; WebView służy wyłącznie visualom.
Visual używa izolowanego modułu `react-native-webview` (14.0.1 dla SDK 58), już
połączonego w runtime visuals. `render_html` nie dodaje modułów natywnych ani
zmian natywnych. Nie migrujemy całej osi czasu do WebView.

WebView zawiera zaufany shell oraz wewnętrzny iframe z tym samym sandboxem.
Token mostu React Native jest wyłącznie w shellu; subframe nie może przekazać
zaakceptowanego komunikatu bez tego tokenu. Weryfikacja zmian tej granicy wymaga
osobnego przeglądu na iOS i Androidzie. Wyłączone: dostęp file/universal-file,
shared cookies, mixed content, okna, formularze i nawigacje.
Native przechwytuje nawigację, ale nie wszystkie żądania zasobów. CSP oraz brak adresów w schemacie komponentów nie zależą od samego callbacka
`onShouldStartLoadWithRequest` (jego pokrycie różni się między platformami).
WebView nie otrzymuje tokenu Connect, JS gatewaya, storage ani URL-i załączników.

Trusted shell przekazuje do native tylko ograniczony protokół montażu;
renderer komponentów jest taki sam jak web. AppState background zatrzymuje
i odmontowuje visuals; proces WebView po awarii pokazuje „Couldn't open this
visual.” i „Retry”. Pamięć WebView oraz dostępność VoiceOver/TalkBack wymagają
pomiarów natywnych. Starszy klient pokazuje tytuł, opis, wersję i „Download HTML”
lub informację o wymaganej aktualizacji, bez wykonania treści jako Markdown.

### Wiele visuals i koszt renderowania

Treść spec/kitu jest pobierana dopiero przy intencji/widoczności; lista sync
przenosi sam manifest. Jeden wspólny obserwator widoczności obsługuje galerie
i ramki. Desktop ma najwyżej 2 aktywne iframe, telefon 1 aktywny WebView;
reszta zachowuje placeholder o ostatniej wysokości z „Open visual”.
Wyjście z viewportu zatrzymuje animacje natychmiast, po 5 s usuwa ramkę
i porty; ukrycie aplikacji/karty usuwa je od razu. Fokus ma pierwszeństwo
i nie może zostać odebrany bez zmiany widoku przez użytkownika.

Cache spec ma LRU 16 wpisów / 2 MiB, stan UI 64 wpisy / 256 KiB. Zasoby,
timery, obserwatory, object URL i nasłuchy znikają przy odmontowaniu.
Brak bibliotek wykresów w początkowym bundlu wątku; kit ładowany raz leniwie.
Stałe granice danych i zaufany runtime umożliwiają zatrzymanie aktywności;
nie deklarujemy twardej kwoty pamięci procesu iframe ani gwarancji braku awarii
silnika przeglądarki. Watchdog jest diagnostyką, nie granicą bezpieczeństwa.

## 5. Trwały zapis, wersje, cytowanie i harnessy

Gateway zapisuje immutable źródło po walidacji w `thread_visuals` oraz mały
manifest itemu `visual`: `visual_id`, `version`, `schema_version`, `kit_version`,
`html_document`, tytuł, opis, wysokość, SHA-256 i rozmiar spec. Powiązanie z wątkiem,
turą i itemem przechowuje baza, a kolejność zapewnia seq zdarzenia. Treść nie jest zwykłym
załącznikiem HTML. Kompilator używa przypiętej wersji kitu; aktualizacja
klienta nie zmienia po cichu semantyki historycznego materiału.
Luka bezpieczeństwa może unieważnić kit: pozostają opis, spec i pobranie,
wykonanie jest zablokowane do bezpiecznej migracji lub zgodnego renderera.

Nowe `render_visual` lub `render_html` domyślnie tworzy nowy item. Aktualizacja podaje opcjonalne
`visual_id` i `expected_version`; może dotyczyć tylko visuala tego wątku.
Gateway atomowo dopisuje wersję i upsertuje manifest itemu w tym samym miejscu.
Stara wersja pozostaje cytowalna; rozbieżna wersja daje konflikt, nie last-write-wins.
Retry po call ID zwraca ten sam wynik. Użytkownik widzi „Version 2”
i może otworzyć historię; nowa wersja nie resetuje scrolla i nie przeładowuje
ramki z aktywnym fokusem bez informacji „A new version is available.” oraz „Reload”.

`GetVisual(thread_id, visual_id, version)` (0 = najnowsza) sprawdza ownera, wątek
i referencję do wersji; publiczny hash nie uprawnia do odczytu. Watch przesyła wyłącznie
mały manifest/upsert lub tombstone i przesuwa seq atomowo po zastosowaniu.
Reconnect nadrabia zakresy; brak kursora/nowa epoka daje ograniczone okno,
nigdy pełny snapshot całej historii. Duża treść jest pobierana osobno.
Synchronizacja korzysta z wdrożonych [okien i wznowienia po seq](ui-api.md#docelowe-okna-i-wznowienie-po-seq).
Galerie używają tej samej zasady.

Połączone komputery replikują manifesty, seq i referencje wersji, a bajty
pobierają z domu z kontrolą właściciela; nowe odczyty wymagają capability
`thread_visuals_v1`. Przeniesienie domu/fork przenosi powiązania oraz wymagane
bloby istniejącym mechanizmem, bez ponownego czytania workspace.
Brak domu oznacza ostatni cache z informacją o niedostępności, bez live tool call.
Usunięcie i revocation unieważniają dostęp oraz cache tak jak inne dane wątku.

„Cite visual” dodaje cytat z tytułem, wersją, opisem oraz
`visual:<visual_id>@<version>`, związany z itemem i wątkiem. Nie tworzy publicznego linku.
Cytat do agenta zawiera tytuł, wersję i opis; odczyt spec wymaga tego samego
owner-scoped dostępu, bez screenshotu dokładanego do każdego promptu.
Dla komponentowego visuala „Download HTML” kompiluje samowystarczalny plik z kitem, spec i CSP;
działa offline, bez bridge'a i sekretów, w początkowym stanie. „Copy spec”
kopiuje JSON. Eksport komponentowego `.html` otwarty poza Canopy ma inną granicę zaufania,
dlatego pozostaje bez adresów, dowolnego kodu modelu i dostępu sieciowego.
Eksport własnego HTML wykonuje kod agenta zgodnie z ograniczeniami §9.
Przycisk pobrania jest w chrome hosta, nie w sandboxie.

### Wszystkie trzy harnessy

Wspólne ścisłe schematy znajdują się w `packages/domain/src/agent-bus`.
`show_images`, `render_visual` i `render_html` są dostępne na obu poziomach drzewa,
także w wątkach bocznych; wynik publikują w **swoim** wątku. Rodzic dostaje
referencję/cytat, nie nową kopię plików. Gateway wykonuje autoryzację i zapis;
worker lokalnie wykonuje tylko zlecony bezpieczny eksport.

| Harness | Ekspozycja i zgodność |
| --- | --- |
| Claude Agent SDK | `mcp__canopy__show_images`, `mcp__canopy__render_visual` i `mcp__canopy__render_html` w istniejącym `createSdkMcpServer`; dopuszczenie narzędzi zachowuje egzekucję polityki w gatewayu. |
| Codex app-server | `dynamicTools` w przestrzeni `canopy`, z tych samych schematów; adapter przekazuje `AgentToolCall/AgentToolResult`. `thread/resume`/`fork` nie dodają narzędzi do starego katalogu. Stary wątek zachowuje linki do plików; UI wyjaśnia potrzebę nowego wątku, bez obietnicy narzędzia po samym reconnect. |
| Grok ACP | Ten sam lokalny HTTP MCP w `session/new`/`session/load`, wspólny dispatcher gatewaya i wynik strukturalny. Brak zależności od natywnego generowania obrazów lub HTML przez CLI. |

Capabilities `thread_image_replies_v1` (eksport i import Markdown),
`thread_visuals_v1` i `thread_html_v1` chronią odpowiednie operacje workera.
`Welcome.thread_visuals_v1 = 7` i `thread_html_v1 = 8` pozwalają workerowi
odmówić wywołania na starszym gatewayu. Odczyt wersji przez linked computers
wymaga `thread_visuals_v1`, a format manifestu i wersja kitu chronią klienta.
Protokół pozostaje addytywny, `WORKER_LINK_PROTOCOL = 1`; UpdateService jest zamrożony.
Zapis galerii/Markdown wprowadzają migracje `0137_thread_image_publications`
i `0138_image_reply_imports`, a wersje visuals — `0139_thread_visuals`.

Instrukcja obrazów i opisy narzędzi rozróżniają oglądanie przez model od publikacji:
`view_image` ogląda, `show_images` publikuje trwałą kopię, a Markdown czeka do
zakończenia wiadomości. `render_visual` opisuje katalog komponentów i lokalny stan;
`render_html` opisuje inline CSS/skrypty i własne limity. Decyzje użytkownika
należą do `ask_user`, nie do przycisku wewnątrz visuala.

Tool description podaje zakres ścieżek, limity i `delivered`; `render_visual`
podaje wersję schematu, katalog oraz przykłady flow/stepper/button preview.
Nie trzeba wkładać całej implementacji kitu do promptu. Nieudana publikacja
wraca jako błąd narzędzia; agent nie może twierdzić, że użytkownik widzi pliki.

### Bridge do agenta i samokontrola

**Bridge do agenta poza v1.** „Choose this layout” wymagałoby osobnej trwałej
interakcji: gateway tworzy dozwolone opcje i wiąże ID z visualem oraz wersją,
host pokazuje potwierdzany wybór, a gateway ponownie sprawdza ownera, stan,
replay i routing `ask_user`. Nigdy dowolny prompt/komenda z iframe i nigdy
zgoda na działanie narzędzia. V1 pokazuje osobne `ask_user` pod visualem;
przełączanie wariantu nie wysyła wiadomości ani nie udziela zgody.

**Automatyczny screenshot kontrolny poza pierwszym wydaniem.** Walidator
spec v1 wykrywa nieznane komponenty, klucze i limity. Późniejsze
`preview_visual(visual_id, version, theme, viewport)` może uruchamiać na workerze
osobny proces headless z tym samym kitem, bez sieci/sekretów/profilu przeglądarki,
z limitem 5 s i 256 MiB, jeden job naraz. Preview wraca jako obraz dla modelu
przez mechanikę `view_image`, nie publikuje kolejnego screenshotu automatycznie.
Wymaga zgody na osobną zależność i koszt runtime; nie jest warunkiem galerii.

## 6. Dostarczenie i kryteria odbioru

Obrazy, komponentowe visuals i własny HTML są częściami działającej aplikacji.
Dawne stosy i szacunki realizacji zastępują granice utrzymania: atomowa publikacja,
owner scoping, zgodność wersji, ograniczone odczyty oraz izolacja każdego formatu.
Rozszerzenia katalogu, kompilatora, eksportu lub WebView wymagają ponownej
weryfikacji dotkniętej granicy. Bridge do agenta i automatyczny headless preview
pozostają poza zakresem (§5).

### Weryfikacja zmian

| Obszar | Weryfikacja bez testów UI |
| --- | --- |
| Import obrazów | Integracja prawdziwego gatewaya i workera z atrapami CLI: traversal, symlink/junction i podmiana ścieżki, pliki specjalne, cudzy scratch/owner/worker, usunięcie źródła, sniffing i SVG, EXIF/GPS, piksele, limity bajtów i liczby, równoległa rezerwacja, przerwany transfer. |
| Trwałość i dostawcy | Restart przed/po commicie, replay call ID, brak podwójnego itemu, anulowanie tury, fork/GC, Markdown poza kodem i zdalne URL bez fetch. Adaptery wszystkich trzech harnessów, stary katalog Codexa i brak capability. |
| Visuals i sync | Walidacja struktury i przejść, XSS w tekście/serializacji, limity, konflikt wersji, obcy visual, dedup, incremental catch-up/gap/epoka/tombstone, kwalifikowane ID, dom offline, eksport bez sekretów i brak blobu w watchu. |
| Granica wykonania | Ręcznie w web/Electron/iOS/Android: próby fetch/WebSocket, form, popup/top/self-navigation, iframe, file URL, parent DOM, cookies, preload/IPC, podrobiony postMessage i flood resize. Wynik oceniamy według formatu: komponenty z §4, własny HTML i zaakceptowane ryzyka sieci/zasobów z §9. Audyt shellu/kompilatora nie dowodzi pełnego firewalla web/mobile. |
| UI i dostępność | Ręcznie jasny/ciemny, desktop/wąski/telefon, 1/6/10 obrazów, długie nazwy i +40% tekstu, pusty/błąd/offline, klawiatura/czytnik, zoom, reduced motion, kontrolki playgroundu, powrót kotwicy i brak szwów overlay. Bez testów komponentów i E2E UI. |

Testy integracyjne dotyczą kontraktu, trwałości, owner scoping i adapterów;
UI oraz granice natywne sprawdzamy ręcznie. Wymagane checki wykonuje GitHub CI,
a lokalny zakres określa [AGENTS.md](../AGENTS.md#testing-policy). Dla korekty
samej dokumentacji wystarcza przegląd diffu, treści i odnośników.

### Budżety wydajności i sposób pomiaru

Poniższe wartości to **cele wydajności**, nie zmierzone wyniki obecnej wersji. Porównanie
przed/po korzysta z [procedur klienta](client-performance.md), tego samego
produkcyjnego buildu, sprzętu, viewportu, cache i deterministycznego fixture.
Do PR trafiają liczby i ograniczenia; ślady oraz screenshoty zostają poza repo.

| Budżet | Dowód |
| --- | --- |
| 0 pełnych obrazów przed otwarciem; 0 żądań dla galerii poza ekranem | Resource Timing/BFF i Connect dla 59 obrazów w sześciu partiach, pierwsze/ponowne przejście, cache i anulowanie szybkiego scrolla. Thumbnail-first; warm cache nie powtarza transferu. |
| 0 aktywnych timerów/animacji visuals w tle, maks. 2/1 aktywne ramki | 100 visuals w 1000 turach, obserwatory, `document.getAnimations()`, CPU i AppState; zliczanie po odmontowaniu, bez pollingów per visual. |
| p95 lokalnej interakcji <100 ms, brak zadań >50 ms przypisanych kitowi | Performance/Long Tasks desktopu i nagrania natywne na słabszym Androidzie/iPhonie; 300 węzłów, 200 punktów, zmiany kroków i przewijanie podczas streamingu 25 delt/s. |
| Brak skoku kotwicy >2 px; brak przesunięcia kontrolek podczas zmiany stanu | Nagranie i geometria przed/po dekodowaniu miniatur, resize visuala, nowej wersji i zamknięciu lightboxa, osobno przy końcu i w historii. |
| Brak narastania pamięci po 30 min; narzut p95 obsługi delty ≤10% wobec bazy | Co najmniej 3 naprzemienne pary prób, heap po GC/retained heap, DOM, RSS procesów WebView i bitmapy. Cele narzutu: ≤32 MiB web dla 2 ramek i ≤64 MiB mobile dla 1 WebView; przekroczenie wymaga zmniejszenia okna/limitu, nie ukrycia wyniku. |

Sync mierzymy oddzielnie z `CANOPY_SYNC_METRICS=1`: nowa wersja wysyła jeden
mały manifest, bez całej spec lub historii; odbiór bloba nie zajmuje kolejki
tekstowych delt. Mierzymy payloady, RPC/min, main-thread busy, layout/paint ms/s,
heap i pamięć bitmap. Eksport mobilny JS ani fixture Bun nie dowodzą CPU,
FPS lub zużycia energii natywnego WebView. Zmiana modułu natywnego wymaga
nowego buildu i fingerprintów; parytetu nie zatwierdzamy samym sprawdzeniem webu.

## 7. Zatwierdzone decyzje i zakres wykonania

| Decyzja | Utrzymywana granica |
| --- | --- |
| Format komponentów | JSON + zaufany kit; dowolny HTML/JS wyłącznie przez osobne `render_html` (§9). |
| Odpowiedź do agenta | Bez bridge'a: lokalny stan visuala i osobne `ask_user`. |
| Publikacja obrazów | Trwałe kopie po potwierdzeniu narzędzia; lokalny Markdown dopiero po zakończeniu wiadomości. |
| Limity i budżety | Walidowane limity danych z niższymi limitami właściciela; wydajność wymaga osobnych pomiarów. |
| Samokontrola screenshotem | Automatyczny preview poza v1; walidator i ręczny przegląd kitu nie zastępują pomiaru natywnego klienta. |

Copy widoków podlega [copy.md](copy.md): krótkie akcje „Download image”,
„Open full screen”, „Cite visual”, błędy z „Retry” oraz opisowe teksty alternatywne.
Zmiana UI wymaga przeglądu klienta i audytu copy; obecność kontraktu nie jest
dowodem przejścia pomiarów produkcyjnych.

## 8. Implementacja visuals

### Spec, walidacja i kit (`@canopy/domain`)

- `src/visuals/types.ts`, `schema.ts`: spec v1 jako Effect Schema. Dekodowanie
  z `onExcessProperty: "error"`; nieznany komponent, pole lub token jest błędem
  ze ścieżką (`root.children[2].tone`). Katalog: `stack`, `grid`, `card`,
  `divider`, `heading`, `text`, `code`, `list`, `badge`, `stat`, `callout`,
  `table`, `button`, `reset`, `tabs`, `segmented`, `toggle`, `stepper`, `when`,
  `before_after`, `artboards`, `device_frame`, `button_preview`, `flow`,
  `sequence`, `chart`.
- `spec.ts`: kolejność od najtańszego sprawdzenia: rozmiar serializacji
  (128 KiB), głębokość surowego JSON (bez rekursji), struktura, potem
  `semantics.ts`: 300 węzłów, 12 poziomów, 32 KiB tekstu (bez tokenów
  i referencji), referencje stanu, diagramów i wykresów.
- Stan: `state` deklaruje wartość początkową; typ wynika z niej (tekst = opcje,
  boolean, liczba całkowita). Dziedzina opcji to wartości kontrolek związanych
  z kluczem (`segmented`, `tabs`, `artboards`), liczby to indeksy `stepper`.
  Akcje `set`, `next`/`previous` (opcje i kroki), `toggle` (boolean) i `reset`,
  najwyżej 8 na przycisk, bez łańcuchów. `validVisualState` sprawdza stan
  z cache urządzenia i z ramki.
- `visual-kit/`: zaufany runtime (DOM, tylko `textContent`), CSS kitu i obsługa
  kanału. `bun run gen` (`scripts/visual-kit.ts`) buduje go Bunem przypiętym
  w `mise.toml` do `src/visuals/gen/kit.ts`; `gen:check` wykrywa nieaktualny kit.
  `VISUAL_KIT_VERSION` oznacza zachowanie kitu zapisane z visualem;
  `REVOKED_VISUAL_KITS` blokuje wykonanie wycofanej wersji.
- `compile.ts` (`@canopy/domain/visual-compiler`, ładowany leniwie): jeden
  dokument HTML z CSP z §4, nonce per montaż, escapowanym tytułem i spec jako
  bezczynnym JSON (`<`, `>`, `&`, U+2028/2029 jako escape). Tryb `frame` czeka
  na port hosta, `export` działa samodzielnie z domyślnymi tokenami jasnymi
  i ciemnymi (`prefers-color-scheme`). Limit 2 MiB.
- `protocol.ts`: handshake `connect` (instancja + nonce, tylko z okna rodzica),
  parsery komunikatów obu stron, `RateWindow` i ograniczenie wysokości.
  `theme-tokens.ts` przyjmuje tylko kolory hex lub `color-mix` z hex i skalę
  0,75–1,5; host buduje je przez `visualTheme(name, mode, scale)`.
- Kit dzieli układ według szerokości ramki: `grid` przechodzi w 2 i 1 kolumnę,
  `before_after` w przełącznik, poziomy `flow` w pionowy, gdy warstwy się nie
  mieszczą. Diagramy i wykresy mają listę połączeń lub tabelę danych.
  `data-paused` zatrzymuje animacje poza ekranem, `data-reduced-motion`
  i `prefers-reduced-motion` je wyłączają.

### Gateway i zapis

- `render_visual` i `render_html` (`packages/domain/src/agent-bus/visuals.ts`) są w `AGENT_BUS_TOOLS`,
  więc trafiają do wszystkich trzech harnessów. Opis `render_visual` zawiera katalog,
  zasady stanu, przykład i limity; `render_html` opisuje kontrakt dokumentu HTML.
  Dekoder szyny odrzuca argumenty większe niż
  limit źródła przed parsowaniem, potem waliduje spec przez `decodeVisualSpec`
  albo HTML przez `validateHtmlDocument`.
- Gateway (`core/visual-publication.ts`, `store/visuals.ts`) wymaga uruchomionej
  tury, przypiętego workera z `thread_visuals_v1` (komponenty) lub `thread_html_v1`
  (HTML) i niearchiwizowanego wątku.
  Nowy visual dostaje UUIDv7 i wersję 1; aktualizacja wymaga `visual_id`
  i `expected_version` tego samego wątku. Rozbieżność daje konflikt z numerem
  aktualnej wersji, nigdy last-write-wins. Retry po call ID zwraca ten sam wynik.
- Wynik: `{ delivered, visual_id, item_id, version, citation_ref }`, gdzie
  `citation_ref` ma postać `visual:<visual_id>@<version>` i nie uprawnia do odczytu.
- Zapisane argumenty wywołania nie zawierają spec (tylko tytuł, opis i hash).

### Worker i harnessy

- Worker ogłasza `thread_visuals_v1` i `thread_html_v1`. Nie kompiluje visuals lokalnie: Claude
  (`mcp__canopy__render_visual`), Codex (dynamic tool w przestrzeni `canopy`)
  i Grok (lokalny HTTP MCP) budują listę z tych samych `AGENT_BUS_TOOLS`
  i przekazują `AgentToolCall` do gateway. Wątki Codexa utworzone wcześniej
  nie dostają narzędzia po wznowieniu (patrz [agent-bus.md](agent-bus.md#9-udostępnienie-narzędzi-dostawcom)).
- Instrukcję dla modelu niesie opis narzędzia (katalog, stan, przykład, limity,
  „controls never contact you”, `ask_user` dla decyzji); bez osobnego promptu systemowego.
- Testy: `tests/integration/visuals.test.ts` (zapis, replay, wersje, konflikt,
  obcy visual, owner scoping, limity, stary worker, wstrzyknięty item) i
  `visual-harnesses.test.ts` (adaptery Codex, Claude i Grok przez gRPC do PostgreSQL).

### Mobile

- `@canopy/domain/visual-shell`: `mountVisualShell` parsuje spec ponownie, odmawia
  wycofanego lub nowszego kitu, kompiluje dokument `frame` i owija go w shell
  (`compileVisualShell`) ze świeżym nonce, instancją i tokenem. Shell ma własny CSP;
  iframe srcdoc dziedziczy go obok swojego, dlatego nonce jest wspólny.
- `host.ts` (`@canopy/domain/visuals`): `VisualFrameInbox` (limity, parser, walidacja
  stanu) używają web i mobile; `shellEnvelope`/`openShellEnvelope` to koperta z tokenem
  montażu między shellem a natywnym hostem.
- `compileVisualExport` buduje plik „Download HTML” dla BFF i dla „Save/Share HTML”.
- Aplikacja: `apps/mobile/src/features/visuals` (opis w [mobile.md](mobile.md#visuals-agenta)).
- Testy: `host.test.ts` (koperta, inbox, brak tokenu w ramce, inertny tekst, odmowa
  kitu). Zmiany granicy WebView na iOS/Androidzie wymagają przeglądu na urządzeniach.
- Cache spec i zapisany stan kontrolek (`visual-state.json`) są czyszczone przy
  rozparowaniu, wygaśnięciu parowania i nowym parowaniu (`clearVisualCaches`).
- Zaakceptowane ryzyka resztkowe (przegląd bezpieczeństwa #695):
  - kod w ramce może zalewać most wiadomościami: most jest widoczny w każdej ramce,
    a natywnej strony nie da się ograniczyć z JS. Host odrzuca wiadomości bez tokenu
    i ponad limity, ale koszt ich dostarczenia ponosi proces aplikacji;
  - Android nie sprawdza nawigacji http(s) ramek potomnych
    (`shouldOverrideUrlLoading` ich nie widzi), więc granicą pozostają sandbox
    iframe i CSP dokumentu.

## 9. Własny HTML: `render_html`

`render_visual` pozostaje domyślnym wyborem dla wykresów, kart i tabel.
`render_html` przyjmuje `html` zamiast `spec`: pełny dokument lub body, inline CSS
i klasyczne skrypty. Pozostałe argumenty i wynik są takie same. Gateway sprawdza
512 KiB UTF-8 dokumentu oraz 512 KiB + 8 KiB serializowanych argumentów przed
JSON.parse, licząc bajty bez tworzenia zakodowanej kopii. Obowiązuje wspólny
budżet 10 publikacji / 1 MiB zapisanych źródeł na turę. Kompilator ogranicza
liczbę skryptów do 64 i zagnieżdżenie do 100 poziomów; gateway stosuje te same
limity przed zapisem i zwraca błąd narzędzia zamiast zapisywać niewykonalną wersję.

Źródło `{html}` pozostaje w `thread_visuals`, z `html_document=true`,
`kit_version=2`. Starszy klient odmawia uruchomienia nieznanego kitu. Odczyt
`GetVisual` jest owner-scoped; manifest jest trwałym itemem `visual`.
`expected_version`, historia, cytowanie, eksport HTML i mobilne save/share
korzystają z tej samej ścieżki. Aktualizacja nie może zmieniać formatu visuala.
Capability workera to `thread_html_v1`; `Welcome.thread_html_v1` chroni stare
gatewaye. Narzędzie trafia przez wspólny katalog do wszystkich trzech harnessów.

### Granica zaufania i phishing

HTML jest całkowicie niezaufany: może pochodzić od modelu po prompt injection.
Kod działa wyłącznie w `iframe sandbox="allow-scripts"`, bez
`allow-same-origin`, `allow-top-navigation*`, `allow-popups*`, `allow-forms`,
`allow-modals` i `allow-downloads`. Opaque origin odcina DOM, cookies, storage,
credentiale i most Canopy. Ramka nigdy nie dostaje sekretów. Własny CSS nie
może wyjść poza jej prostokąt i przykryć chrome aplikacji.

Karta nie pokazuje osobnego ostrzeżenia nad treścią. Treść może naśladować UI
i wyłudzać dane; ochroną jest sandbox, a nie komunikat. Pobranie odbywa się w Canopy ze
zapisanej wersji, bez `allow-downloads`. Linki i formularze są nieaktywne.
Eksport zawiera CSP i lockdown, ale otwarcie pliku `file://` wykonuje kod agenta
poza sandboxem Canopy. CSP pozostaje aktywna; nie zastępuje opaque origin ani
firewalla dedykowanej sesji. Pobrany dokument nadal jest niezaufanym programem.

### CSP, hashe i lockdown

Canopy parsuje i odtwarza dokument, próbując usunąć `meta`, `base`, `link`, `iframe`,
`frame`, `frameset`, `object`, `embed`, inline handlery i atrybuty nawigacyjne.
To filtr best-effort, nie granica bezpieczeństwa: różnice parserów i ponowne
parsowanie mogą odtworzyć usunięty markup (mXSS). Usuwamy też całe `style`
w MathML/SVG, aby ograniczyć znaną klasę takich mutacji. Ochronę przed wykonaniem
odtworzonych handlerów zapewnia `script-src-attr 'none'`, a przed ładowaniem,
osadzaniem i zmianą bazy — właściwe dyrektywy CSP. Nie obiecujemy kompletnej sanitacji DOM.
Skrypty z `src` oraz moduły są pomijane. Każdy klasyczny skrypt dostaje prefiks
lockdown, a hash SHA-256 obejmuje **cały** wynik. Bootstrap Canopy również
zaczyna się lockdownem. Skrypt zaufanego shella również zaczyna się wspólnym
lockdownem sieciowym, więc jego hash dziedziczony przez srcdoc nie pozwala
uruchomić kopii bez blokad w świeżym realmie. Shell zachowuje tylko własny
most komunikatów mobilnych; opaque ramka go nie ma, a lockdown agenta dodatkowo
usuwa `ReactNativeWebView`. Używa się wyłącznie dopasowanych hashy:

```text
default-src 'none'; script-src 'sha256-…'; script-src-attr 'none';
style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none';
frame-src 'none'; child-src 'none'; object-src 'none'; worker-src 'none';
manifest-src 'none'
```

Brak `unsafe-inline` w script-src, `unsafe-eval` i `unsafe-hashes`: agent musi
używać `addEventListener`, bez `onclick`, URL-i `javascript:`, eval, Function,
stringowych timerów ani dynamicznych importów. Wszystkie biblioteki muszą być
inline i mieścić się w limicie. Pierwsza meta CSP jest wstrzykiwana przed
treścią agenta jako pierwszy węzeł `head`. Zarówno meta, jak i skrypty są węzłami
drzewa parse5; tekst `<head>`/`</body>` w komentarzach i atrybutach nie wpływa na
miejsce wstawienia. Polityki CSP składają się przez przecięcie uprawnień: późniejsza
meta nie może osłabić wcześniejszej, a usunięcie meta nie cofa aktywnej polityki.
Dokument `srcdoc` dziedziczy również politykę zaufanego shella.

Lockdown używa niekonfigurowalnych, niezapisywalnych właściwości o wartości
`undefined` dla `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`,
`RTCRtpSender`, `RTCRtpReceiver`, `RTCIceCandidate`, `WebTransport`, `WebSocket`,
`EventSource`, `fetch`, `XMLHttpRequest`, `navigator.mediaDevices` i
`navigator.sendBeacon`, także na prototypach nawigatora. Usuwa widoczny global
`ReactNativeWebView` z niezaufanej ramki. Każda dokładna kopia dozwolonego
skryptu zaczyna się tym samym lockdownem także w nowym realmie.

Samo `frame-src 'none'` **nie** zatrzymuje wszystkich ramek `srcdoc`/about:blank.
Takie ramki mogą istnieć; CSP nadal wymaga dozwolonego hasha skryptu,
a opaque origin ogranicza dostęp do ich realmów. Kopia dozwolonego skryptu
zaczyna się lockdownem. Usuwanie elementów
osadzających przy kompilacji jest dodatkową warstwą, a nie dowodem, że JS nie
utworzy ich ponownie. Worker/blob/import, object/embed i zewnętrzne obrazy są
objęte osobnymi dyrektywami.

### Zaakceptowane ryzyko sieci na web i mobile

**Nie gwarantujemy braku sieci w zwykłej przeglądarce ani mobilnym WebView.**
Agent ma już sieć przez własne narzędzia. Dodatkowym zagrożeniem ramki są dane
wpisane przez użytkownika, IP i obecność urządzenia oglądającego.

CSP nie blokuje transportu WebRTC/STUN jak fetch. Lockdown usuwa znane API,
lecz nie jest kompletnym firewallem silnika. Ponadto hash w `script-src`
autoryzuje także zewnętrzny skrypt z pasującym `integrity`. Utworzenie takiego
`script.src` może wysłać GET mimo aktywnego CSP i lockdownu; odrzucenie odpowiedzi
nie cofa wycieku wpisanych danych lub IP. To zaakceptowane ryzyko web/mobile;
nie opisujemy tych platform jako offline.
Opaque origin nadal chroni dane Canopy przed odczytem przez ramkę.

Wskazówki sieciowe `dns-prefetch` i `preconnect` tworzone w runtime mogą omijać
zwykłe ładowanie zasobów i kontrolę CSP. Nazwa DNS może zawierać wpisane dane;
usunięcie statycznych `link` przy kompilacji nie zatrzymuje ponownego utworzenia
ich przez JS. To dodatkowe zaakceptowane ryzyko web/mobile.

Kliknięcie w niezaufaną treść może też aktywować funkcje przeglądarki, w tym
próbę podmiany schowka (pastejacking). Obie ramki jawnie odmawiają uprawnień
`clipboard-read`, `clipboard-write`, `picture-in-picture`, capture, fullscreen,
urządzeń i pozostałych funkcji w `VISUAL_PERMISSIONS`. Różnice implementacji
Permissions Policy pozostają ryzykiem; nie należy wklejać ani wpisywać sekretów.

### Desktop: osobna sesja

Iframe nie może dostać osobnej sesji Electron. Dlatego po Run aplikacja
uruchamia istniejący renderer w osobnym procesie Electron w trybie offscreen,
z zaufanym shellem i opaque iframe. Karta w rozmowie pokazuje jego klatki PNG
na canvasie i przekazuje ograniczone wejście myszy, scrolla oraz klawiatury.
Główne okno nigdy nie wykonuje HTML agenta; jego CSP pozostaje bez zmian,
bez dopisywania hashy agenta ani rozszerzania `frame-src`.
Przekazanie źródła przez preload wymaga autoryzowanego głównego frame'u appki,
limitu wejścia i ponownej kompilacji. Viewer ma własną nietrwałą partycję,
bez cookies/storage aplikacji, `nodeIntegration=false`, `sandbox=true`,
`contextIsolation=true`, `webSecurity=true`, bez webview i ogólnego mostu IPC.

Sesja ma proxy odmawiające połączeń, bez obejścia loopback, `onBeforeRequest`
anulujący wszystko poza dokładnym URL-em dokumentu viewer’a oraz `about:`, `data:`, `blob:`, odmowę wszystkich uprawnień
i urządzeń. WebContents ustawia `disable_non_proxied_udp`, blokuje nowe okna,
nawigacje, przekierowania i pobrania. Jeden viewer ogranicza liczbę procesów;
uruchomienie kolejnego podglądu zatrzymuje poprzedni i przywraca jego Run.
Kontrolki wersji/cytowania/pobierania pozostają w głównej karcie.

Podgląd ma najwyżej 1600 × 1000 px, 15 klatek/s i 4 MiB PNG na klatkę.
Producent czeka na ACK po odczycie klatki; nie kolejkuje obrazów, gdy host jest
wolniejszy. Niewidoczna karta zatrzymuje malowanie, a odmontowanie, zmiana
wersji, nawigacja głównego okna lub jego zamknięcie kończą proces podglądu.
Komendy i zdarzenia są związane z losowym ID montażu i autoryzowanym
`webContents` właściciela. Zakończenie starego montażu nie zamyka nowego.
Wejście jest walidowane w main oraz w procesie podglądu; nie ma ogólnego IPC
ani wykonania skryptu z argumentów wejścia. Escape oddaje klawiaturę rozmowie.

Canvas nie przenosi drzewa dostępności ani natywnego zaznaczania tekstu.
Akcja Open in window pozostaje dostępną alternatywą do pełnego dokumentu,
czytnika ekranu i natywnej edycji. Otwiera jedną kopię zamiast podglądu,
w tym samym modelu odizolowanego procesu; nie uruchamia obu równocześnie.
Viewer używa prywatnego handlera protokołu `canopy-agent-html` w tej sesji;
dokument nie jest wielomegabajtowym URL-em `data:`. Handler odpowiada tylko dla
losowego bieżącego URL-a, bez dostępu do plików/sieci. Tytuł okna pozostaje
„Custom HTML from the agent — Canopy”, niezależnie od `document.title`.
Kompilacja odbywa się w osobnym workerze Node z limitem heap 128 MiB i 10 s.

Viewer działa w osobnym procesie przeglądarki Electron. Router startowy wybiera
go przed inicjalizacją vaulta, usług i sesji appki. Dostaje tylko dokument,
tytuł i paletę przez prywatny kanał procesu oraz ograniczone zmienne OS/display;
ma osobny tymczasowy profil, sprzątany po zakończeniu. Proces appki autoryzuje
IPC i pozwala na jeden viewer; zakończenie appki kończy także viewer.

Proces viewer’a ustawia przed startem Chromium `host-resolver-rules=MAP * ~NOTFOUND`.
Ochronę tworzą te reguły resolvera, proxy odmawiające połączeń i `webRequest`.
Nie polegamy na nieudokumentowanym przełączniku `disable-network-prediction`.
Reguły resolvera obejmują także spekulacyjny DNS w ramkach,
którego proxy i `webRequest` nie widzą. Nie używamy samego `additionalArguments`
rendererów: nie zapewniają ustawienia resolvera całego procesu przeglądarki.
Nagłówek `X-DNS-Prefetch-Control: off` jest tylko dodatkową wskazówką.
Nie zmieniamy globalnych flag ani sesji głównego procesu aplikacji. Preconnect
nadal podlega dedykowanej sesji, resolverowi i proxy. JS agenta pozostaje
w przeglądarkowym iframe; nie dodajemy osobnego interpretera JS.

### Mobile: bez zmiany natywnej

Obowiązuje ten sam model ryzyka co w przeglądarce: hash CSP, lockdown,
`allow-scripts` i zaufany shell z losową kopertą tokenową z #695.
`VisualFrameInbox` waliduje i ogranicza częstotliwość komunikatów; HTML nie
może zapisywać `local_state`. Dozwolone są wysokość/ready, Escape i błąd renderu.
Token nie trafia do niezaufanego dokumentu. Zachowane ustawienia WebView:
file/content/universal access off, incognito, brak współdzielonych cookies,
DOM storage i okien, blokada nawigacji, media capture deny.

`react-native-webview` 14.0.1 nie udostępnia Androidowego `shouldInterceptRequest`
do blokowania wszystkich subresources ani iOS `WKContentRuleList`.
Androidowy `onShouldStartLoadWithRequest` nie obejmuje nawigacji child frame.
`mediaCapturePermissionGrantType="deny"` dotyczy iOS; Androidowy kod biblioteki
może przyznać już przyznane systemowo camera/microphone permissions.
Lockdown `mediaDevices` oraz opaque iframe bez grantu permissions policy
blokują zwykłą drogę WebRTC/media, lecz nie zastępują natywnej odmowy uprawnień.
Nie dodajemy natywnego modułu, patcha ani pluginu. Twardy firewall i pełna
odmowa w natywnym permission handlerze mogą powstać w późniejszym native buildzie.

### Zasoby i wygląd

Dotychczasowe sloty (2 web / 1 mobile), cache 16 wpisów / 2 MiB i leniwe
montowanie nadal obowiązują. Desktop ma jeden proces własnego HTML;
pozostałe sloty komponentowych visuals działają niezależnie. HTML na web,
desktop i mobile zaczyna od nieaktywnej karty „Run”. Na mobile jawny wybór Run
pozostaje w pamięci sesji dla konkretnego visuala i wersji, również po przewinięciu, ponownym montowaniu i otwarciu pełnego
ekranu. Nowa wersja lub nowa sesja wymaga Run; unpair czyści zgody. Błąd procesu
WebView lub watchdog cofa zgodę, więc powrót do wątku nie uruchamia ponownie
wadliwego HTML. Na web ponowne montowanie nadal zaczyna od Run.
Po błędzie/watchdogu nie ma automatycznego retry.
Bootstrap zgłasza wysokość co sekundę. Po 10 s
ciszy host usuwa ramkę/WebView i pokazuje „This visual stopped responding.”.
Proces viewer’a Electron kończy wszystkie renderery z PID-ów jego własnego
drzewa ramek (także OOPIF). W podglądzie inline main kończy też proces i karta
pokazuje błąd z Retry; w osobnym oknie niszczy stare okno i pokazuje komunikat
w nowym, bez kodu agenta. Zakończenie samego głównego renderera nie wystarczało przy
pętli w OOPIF. Główny proces aplikacji nie należy do tego drzewa. Chromium desktop izoluje
opaque sandbox frames procesowo od wersji 127 (Site Isolation), Android WebView
nie ma OOPIF. Safari, Firefox, Chrome Android i Android WebView mogą wykonywać
ramkę w tym samym procesie/wątku co host. Pętla lub bomba pamięci może zablokować
także watchdog; przycisk „Run” oznacza świadome uruchomienie tego ryzyka i
zapobiega pętli blokowania aplikacji przy każdym powrocie do wątku.
Mobilny watchdog działa po stronie React Native, poza JS WebView, lecz nie daje
gwarancji przy wspólnej awarii procesu ani presji pamięci.
Nie ma dostępnej z JS twardej kwoty pamięci iframe/WebView: limity źródła,
slotów i cache ograniczają wejście, a awarię procesu obsługuje host. To pozostaje
ograniczeniem, wymagającym prób na urządzeniach i niezależnego przeglądu.

Agent dostaje zmienne `--canopy-canvas`, `--canopy-surface`, `--canopy-panel`,
`--canopy-ink`, `--canopy-muted`, `--canopy-border`, `--canopy-accent`,
`--canopy-action`, `--canopy-on-accent` z palety hosta. Kolory są walidowane
przed wstrzyknięciem; dokument nie dostaje prywatnych klas ani zasobów Canopy.

