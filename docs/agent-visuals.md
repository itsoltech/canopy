# Obrazy w odpowiedziach i interaktywne visuals

Status: **projekt zatwierdzony przez użytkownika (2026-11-13)**. Obrazy: stos #651–#663.
Visuals: implementacja w toku (§8 opisuje to, co już istnieje); pozostałe nazwy
narzędzi, capability i pól są propozycjami do czasu ich wdrożenia.

## 1. Rekomendacja i zakres

Agent ma umieć pokazać wynik pracy bez odsyłania użytkownika do dysku workera.
Obrazy publikujemy jako trwałe załączniki, a interaktywne materiały nazywamy
**visuals** (w UI pojedynczy „Visual”). Każdy wynik należy do wątku i jego domu.

| Decyzja | Rekomendacja |
| --- | --- |
| Publikacja obrazów | `show_images` jako główna droga; lokalne obrazy Markdown przechodzą ten sam import; zwykłe ścieżki pozostają linkami/chipami. |
| Trwałość | Kopia w storage załączników gatewaya. Odczyt nie zależy od istnienia pliku ani dostępności workera po publikacji. |
| Format visuals v1 | Wersjonowane drzewo komponentów JSON, kompilowane do samowystarczalnego HTML z zaufanym kitem Canopy. |
| Interakcje | Lokalny stan komponentów, bez wywołań agenta lub API. `ask_user` pozostaje osobną interakcją poza visualem. |
| Dostarczenie | Najpierw kompletny stos obrazów; później osobny kompletny stos visuals z parytetem mobile. |

Kryterium użytkowe: po prośbie o wygląd zmian użytkownik widzi wybrane zrzuty
w odpowiedzi agenta, otwiera pełny obraz i pobiera go również z telefonu.
Po prośbie o diagram lub wariant przycisku zmienia kroki, zakładki i warianty
bez wychodzenia z wątku. Ponowne otwarcie odtwarza opublikowany materiał.

Poza v1: edytor dokumentów, dowolne aplikacje HTML/JS, zależności z CDN,
połączenia sieciowe visuala, uruchamianie kodu projektu, współdzielony stan
przełączników oraz wykonywanie akcji przez przycisk w visualu.

### Istniejące elementy do wykorzystania

Źródła: [architektura](architecture.md), [narzędzia szyny §3 i §9](agent-bus.md),
[pliki botów](bots.md#pobieranie-i-wysyłanie-plików),
[załączniki UI](ui-api.md#załączniki), [protokół](protocol.md#załączniki),
[mobile](mobile.md), [połączone komputery](linked-computers.md#podglądy-załączników),
[copy](copy.md), [skala UI](ui-scale.md), [pomiary](client-performance.md).

`view_image` służy dziś do **oglądania przez model**: wykonuje je worker,
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

### Proponowany kontrakt `show_images`

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

Wywołanie tworzy samodzielny item odpowiedzi `image_gallery`, widoczny w strumieniu
odpowiedzi agenta także po zwinięciu pracy. Nie jest schowane wewnątrz tool calla.
Tekst narzędzia może prowadzić do tego samego itemu, lecz nie dubluje galerii.
Wiadomość końcowa może go zacytować przez zwrócone `item_id`. Brak końcowej
wiadomości lub przerwanie następnego kroku nie usuwa już zatwierdzonego wyniku.

### Import, przechowywanie i awarie

1. Gateway rezerwuje limity oraz receipt po `(thread_id, turn_id, call_id)`
   i autoryzuje aktywną turę, przypisanie workera oraz politykę publikacji.
2. Worker bezpiecznie otwiera wskazane pliki i tworzy ograniczony snapshot
   eksportu. Czyta te same uchwyty przez cały transfer, z licznikiem bajtów,
   hashem i wykrywaniem zmian. Zmiana pliku daje odmowę i ponowienie przez agenta.
3. Gateway odbiera porcje z backpressure, sprawdza hash i długość, rozpoznaje
   typ z bajtów i przepuszcza pliki przez istniejący pipeline załączników.
4. Jedna transakcja wiąże wszystkie załączniki, manifest galerii, zdarzenie,
   audyt i wynik wywołania. Dopiero commit daje `delivered: true`.
5. UI pobiera miniatury przez owner-scoped `GetAttachment`, pełny obraz dopiero
   po otwarciu. Eksport oraz osierocone uploady są sprzątane po błędzie/retry.

Używamy istniejącego wzorca eksportu botów, ale nowa komenda wątku musi być
addytywna i dostępna wyłącznie dla przypisanego workera. Nie wysyłamy dużych
obrazów jako JSON/base64 w `AgentToolCall` lub `WatchThread`. Porcje eksportu
mają najwyżej 256 KiB, najwyżej dwa importy na worker i jeden na wątek;
timeout operacji 60 s, bezczynności 10 s. Rezerwacja obejmuje dane wejściowe
i wynik po przetworzeniu. Limity obowiązują przed alokacją i podczas strumienia.
Snapshot eksportu przeżywa reconnect do końca operacji; receipt przeżywa restart
gatewaya. Replay zwraca te same ID, bez drugiej galerii. Brak jednego pliku
odrzuca całą partię z indeksem błędu; nie ma cichej częściowej publikacji.

Galeria i kopie żyją zgodnie z retencją wątku, niezależnie od usunięcia źródła
lub worktree. Usunięcie wątku odbiera dostęp od razu; blob GC zachowuje pliki
referencjonowane przez fork/cytat zgodnie z polityką transkryptu. Nie robimy
globalnej deduplikacji ujawniającej istnienie pliku innego właściciela.

### Granice plików i treści

| Granica | Reguła projektu |
| --- | --- |
| Korzenie | Rzeczywiste `cwd`/workspace bieżącego wątku, jego przypięte worktree i jawnie przydzielony mu scratch/załączniki. Osobne worktree nie daje dostępu do nadrzędnego checkoutu ani scratch innego wątku. Nie dopuszczamy całego systemowego katalogu tymczasowego. |
| Otwieranie | Ścieżki względne od `cwd`; absolutne tylko wewnątrz tych samych korzeni. Odrzucenie traversal, NUL, dowiązań w komponentach ścieżki, plików specjalnych i junction/reparse escape na Windows. Otwarcie względem zaufanego katalogu z kontrolą uchwytu; sam `realpath` przed późniejszym `readFile` nie chroni przed wyścigiem. Brak bezpiecznego prymitywu na danej platformie = odmowa. |
| Rozmiary | Minimum z limitów właściciela i sufitu narzędzia: 10 obrazów, 20 MiB/pliki wejściowe i wynikowe, 50 MiB/partię, 100 Mpx/obraz. Limit dekodera i współbieżności chroni także przed bombami dekompresji. Do 100 obrazów i 200 MiB na turę; brak automatycznego obejścia kolejnym wywołaniem. |
| Typy | Sniffing przed dekodowaniem, obrót EXIF, usunięcie EXIF/GPS/XMP i miniatura. V1 publikuje PNG/JPEG/WebP; inne obsługiwane rastry konwertuje, animacje spłaszcza do pierwszej klatki. GIF nie korzysta tu z istniejącej ścieżki zachowującej oryginał. SVG jest plikiem do pobrania, nigdy aktywnym DOM, `object` ani iframe; nie wchodzi do galerii. |
| Uprawnienia | Dom gatewaya sprawdza ownera przy publikacji i każdym odczycie, obcy plik = `NotFound`. Odrzuca cudzy worker, turę, scratch i podrobioną referencję. Poświadczenia connectorów i kanałów zostają w gatewayu; żaden token nie trafia do modelu, HTML ani payloadu obrazu. |

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

| Format | Co daje | Co utrudnia |
| --- | --- | --- |
| Samowystarczalny HTML + CSS/JS kit | Duża swoboda układu; łatwy eksport; znajomy model generowania. | Agent może ominąć kit, dodać nieograniczoną pętlę JS, DOM lub zasoby. CSP izoluje dane i sieć, lecz nie daje twardego limitu CPU/pamięci iframe. Same klasy nie zapewniają spójności i dostępności. |
| Drzewo komponentów JSON | Ścisła walidacja, konsekwentny wygląd, ograniczona liczba węzłów i przejść. Zaufany runtime renderuje HTML i interakcje, wspólny dla klientów. | Węższy katalog; nowy typ wymaga wersji kitu. Nie zastąpi dowolnej aplikacji ani fragmentu Svelte. |

**Rekomendacja: drzewo JSON w v1.** Użytkownik otrzymuje interaktywny HTML,
ale nie wykonujemy kodu wygenerowanego przez agenta. Przyciski mają lokalne
przejścia stanu realizowane przez skrypty kitu wewnątrz sandboxa. Diagram
przepływu, wybór artboardu i playground przycisków mieszczą się w tym zakresie.
Wolny HTML może wrócić jako osobna decyzja po potwierdzeniu izolacji zasobów;
nie dodajemy ukrytego pola `html`, `script`, `style` ani `onClick` do v1.

### Proponowany kontrakt `render_visual`

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
`set`, ograniczony `next`/`previous`, `reset` i pokazanie panelu po wartości
stanu. Brak wyrażeń JS, rekurencji, pętli, dynamicznego kodu oraz timerów
definiowanych przez model. Referencje do kluczy i opcji są sprawdzane przed
zapisem; jedna akcja ma najwyżej 8 zmian, bez łańcuchów efektów. Zaufane
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

Web/desktop montuje dokument wygenerowany przez zaufany kompilator w
`<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">` przez `srcdoc`.
Bez `allow-same-origin`, formularzy, popupów, nawigacji top i downloads.
To osobny, opaque origin: brak DOM Canopy, cookies, localStorage aplikacji,
tokenów i API. Zwykły załącznik `.html` nadal jest plikiem/tekstem, nie visualem.

Shell hosta i CSP powstają poza danymi modelu; przykład polityki dokumentu:

```text
default-src 'none'; script-src 'nonce-<per-mount>'; script-src-attr 'none';
style-src 'nonce-<per-mount>'; img-src 'none'; font-src 'none';
connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none';
worker-src 'none'; base-uri 'none'; form-action 'none'
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
Visual używa izolowanego modułu `react-native-webview` (14.0.1 dla SDK 58) i wymaga
nowych development/store buildów z innym fingerprintem; nie obiecujemy wdrożenia OTA
do starszego runtime. Nie migrujemy całej osi czasu do WebView.

WebView zawiera zaufany shell oraz wewnętrzny iframe z tym samym sandboxem.
Most React Native jest wyłącznie w shellu; subframe nie może go wywołać ani
przekazać komunikatu o dowolnym typie. iOS/Android wymagają osobnego dowodu
tej granicy przed udostępnieniem funkcji. Wyłączone: dostęp file/universal-file,
shared cookies, mixed content, okna, formularze, nawigacje i wszelkie żądania
zasobów poza początkowym lokalnym shellem. Native przechwytuje nawigację
i requesty, ale CSP oraz brak adresów w schemacie nie zależą od samego callbacka
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

Gateway zapisuje immutable spec po walidacji oraz manifest itemu `visual`:
`visual_id`, `version`, `schema_version`, `kit_version`, tytuł, opis, wysokość,
hash, rozmiar, `content_ref`, autor/tura i seq. Treść nie jest zwykłym
załącznikiem HTML. Kompilator używa przypiętej wersji kitu; aktualizacja
klienta nie zmienia po cichu semantyki historycznego materiału.
Luka bezpieczeństwa może unieważnić kit: pozostają opis, spec i pobranie,
wykonanie jest zablokowane do bezpiecznej migracji lub zgodnego renderera.

Nowe `render_visual` domyślnie tworzy nowy item. Aktualizacja podaje opcjonalne
`visual_id` i `expected_version`; może dotyczyć tylko visuala tego wątku.
Gateway atomowo dopisuje wersję i upsertuje manifest itemu w tym samym miejscu.
Stara wersja pozostaje cytowalna; rozbieżna wersja daje konflikt, nie last-write-wins.
Retry po call ID zwraca ten sam wynik. Użytkownik widzi „Version 2”
i może otworzyć historię; nowa wersja nie resetuje scrolla i nie przeładowuje
ramki z aktywnym fokusem bez informacji „A new version is available.” oraz „Reload”.

`GetVisual(visual_id, version)` (proponowane) sprawdza ownera, wątek i referencję
do wersji; publiczny hash nie uprawnia do odczytu. Watch przesyła wyłącznie
mały manifest/upsert lub tombstone i przesuwa seq atomowo po zastosowaniu.
Reconnect nadrabia zakresy; brak kursora/nowa epoka daje ograniczone okno,
nigdy pełny snapshot całej historii. Duża treść jest pobierana osobno.
To zależy od docelowego protokołu okien opisanego w [UI API](ui-api.md#docelowe-okna-i-wznowienie-po-seq),
a nie od starszego fallbacku pełnych snapshotów. Galerie używają tej samej zasady.

Połączone komputery replikują manifesty, seq i referencje wersji, a bajty
pobierają z domu z kontrolą właściciela; nowe odczyty wymagają capability
`thread_visuals_v1`. Przeniesienie domu/fork przenosi powiązania oraz wymagane
bloby istniejącym mechanizmem, bez ponownego czytania workspace.
Brak domu oznacza ostatni cache z informacją o niedostępności, bez live tool call.
Usunięcie i revocation unieważniają dostęp oraz cache tak jak inne dane wątku.

„Copy visual link” i „Cite visual” wskazują kwalifikowane ID wątku, item i wersję,
np. opis „Button variants · Version 2”. Nie tworzą publicznego linku.
Cytat do agenta zawiera tytuł, wersję i opis; odczyt spec wymaga tego samego
owner-scoped dostępu, bez screenshotu dokładanego do każdego promptu.
„Download HTML” kompiluje samowystarczalny plik z kitem, spec i CSP;
działa offline, bez bridge'a i sekretów, w początkowym stanie. „Copy spec”
kopiuje JSON. Eksport `.html` otwarty poza Canopy ma inną granicę zaufania,
dlatego pozostaje bez adresów, dowolnego kodu modelu i dostępu sieciowego.
Przycisk pobrania jest w chrome hosta, nie w sandboxie.

### Wszystkie trzy harnessy

Wspólne ścisłe schematy trafiają do `packages/domain/src/agent-bus`.
`show_images` i `render_visual` są dostępne na obu poziomach drzewa,
także w wątkach bocznych; wynik publikują w **swoim** wątku. Rodzic dostaje
referencję/cytat, nie nową kopię plików. Gateway wykonuje autoryzację i zapis;
worker lokalnie wykonuje tylko zlecony bezpieczny eksport.

| Harness | Ekspozycja i zgodność |
| --- | --- |
| Claude Agent SDK | `mcp__canopy__show_images` i `mcp__canopy__render_visual` w istniejącym `createSdkMcpServer`; dopuszczenie narzędzi zachowuje egzekucję polityki w gatewayu. |
| Codex app-server | `dynamicTools` w przestrzeni `canopy`, z tych samych schematów; adapter przekazuje `AgentToolCall/AgentToolResult`. `thread/resume`/`fork` nie dodają narzędzi do starego katalogu. Stary wątek zachowuje linki do plików; UI wyjaśnia potrzebę nowego wątku, bez obietnicy narzędzia po samym reconnect. |
| Grok ACP | Ten sam lokalny HTTP MCP w `session/new`/`session/load`, wspólny dispatcher gatewaya i wynik strukturalny. Brak zależności od natywnego generowania obrazów lub HTML przez CLI. |

Proponowane capability `thread_image_replies_v1` (eksport i import Markdown)
oraz `thread_visuals_v1` są negocjowane end-to-end: worker, gateway domu,
łącze i klient. Narzędzia ogłaszamy tylko gdy runtime umie wykonać kontrakt;
odmowa starszej strony jest jawna. Nowe pola proto i enumy wyłącznie addytywnie,
z `bun run gen`, bez zmian zamrożonego UpdateService. Numer migracji ustalamy
z aktualnego `dev` przy implementacji, nie rezerwujemy go w projekcie.

Opisy narzędzi mają rozróżniać oglądanie od publikacji. Proponowana instrukcja
systemowa (English, krótka, wraz z opisami i przykładami kitu):

> Use view_image to inspect an image yourself. Use show_images to show images
> to the user. Pick representative screenshots and describe what changed.
> Local Markdown images are copied only after the message finishes.
> Use render_visual for an interactive explanation or comparison with Canopy
> components. Its controls change the visual locally; they do not contact you.
> Use ask_user when you need a decision. Never use a visual as an approval.

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

Etap projektu to osobny draft PR dokumentacji. Mockup jest materiałem poza
repozytorium, nie implementacją ani raportem testowym. Późniejsze prace tworzą
dwa kompletne stosy; każdy kolejny PR opiera się na poprzednim, dolny na `dev`.
Wszystkie warstwy stosu pozostają draft do ukończenia całości, potem squash merge
całego stosu. Obrazy można dostarczyć przed rozpoczęciem niezależnego stosu visuals.

| Stos / PR | Zakres i kryterium końca | Szacunek |
| --- | --- | --- |
| Obrazy 1 | Kontrakty/capability, bezpieczny eksport, atomowy import i receipt, testy gateway↔worker. | 3–4 dni robocze |
| Obrazy 2 | Trwały manifest Markdown, galeria/lightbox/pary, mobile i linked computers, dostępność, copy. | 3–4 dni robocze |
| Visuals 1 | Wersjonowany schemat i kit, zapis/odczyt, cytaty, przyrostowy sync, owner scoping. | 4–6 dni roboczych |
| Visuals 2 | Web/Electron sandbox, port/resize, eksport/full screen, limity widoczności i pomiary. | 3–5 dni roboczych |
| Visuals 3 | Mobile WebView, nowe buildy, sandbox/bridge na obu platformach, dostępność, parytet i pomiary. | 4–6 dni roboczych |

Łącznie obrazy 6–8, visuals 11–17 dni roboczych jednej osoby, plus czas
review i dystrybucji natywnych buildów. Zakładamy istniejący eksport botów
i dostępny przyrostowy protokół okien. Jeśli ten protokół nie jest jeszcze
wdrożony, staje się osobną zależnością stosu; nie cofamy się do pełnych snapshotów.
Szacunek nie obejmuje raw HTML, bridge'a do agenta ani headless preview.

### Dowody wymagane przy implementacji

| Obszar | Weryfikacja bez testów UI |
| --- | --- |
| Import obrazów | Integracja prawdziwego gatewaya i workera z atrapami CLI: traversal, symlink/junction i podmiana ścieżki, pliki specjalne, cudzy scratch/owner/worker, usunięcie źródła, sniffing i SVG, EXIF/GPS, piksele, limity bajtów i liczby, równoległa rezerwacja, przerwany transfer. |
| Trwałość i dostawcy | Restart przed/po commicie, replay call ID, brak podwójnego itemu, anulowanie tury, fork/GC, Markdown poza kodem i zdalne URL bez fetch. Adaptery wszystkich trzech harnessów, stary katalog Codexa i brak capability. |
| Visuals i sync | Walidacja struktury i przejść, XSS w tekście/serializacji, limity, konflikt wersji, obcy visual, dedup, incremental catch-up/gap/epoka/tombstone, kwalifikowane ID, dom offline, eksport bez sekretów i brak blobu w watchu. |
| Granica wykonania | Ręcznie w web/Electron/iOS/Android: próby fetch/WebSocket, form, popup/top/self-navigation, iframe, file URL, parent DOM, cookies, preload/IPC, podrobiony postMessage, flood resize; brak dostępu i sieci. Audyt kodu shellu/kompilatora to warunek publikacji. |
| UI i dostępność | Ręcznie jasny/ciemny, desktop/wąski/telefon, 1/6/10 obrazów, długie nazwy i +40% tekstu, pusty/błąd/offline, klawiatura/czytnik, zoom, reduced motion, kontrolki playgroundu, powrót kotwicy i brak szwów overlay. Bez testów komponentów i E2E UI. |

Przyszłe testy integracyjne i pomiary wykonujemy w uprawnionym etapie
implementacji; ten PR ich nie uruchamia. Standardowe kontrole implementacji
obejmą gen/check, typecheck, lint, format, testy i build według polityki repo.
Projekt dokumentacji wymaga `bun run format:check`. Nie zmienia kodu ani proto.

### Budżety wydajności i sposób pomiaru

Poniższe wartości to **cele odbioru**, nie wyniki tego projektu. Porównanie
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
FPS lub zużycia energii natywnego WebView. Dodanie modułu wymaga jawnie
nowych fingerprintów; parytetu nie zatwierdzamy samym sprawdzeniem webu.

## 7. Zatwierdzone decyzje i zakres wykonania

Użytkownik zaakceptował mockup i wszystkie pięć rekomendacji:

| Decyzja | Przyjęty zakres |
| --- | --- |
| Format visuals v1 | JSON + zaufany kit gotowych komponentów; dowolne HTML/JS poza v1. |
| Odpowiedź do agenta | Bez bridge'a w v1; lokalny stan visuala i osobne `ask_user`. |
| Kolejność | Najpierw kompletny stos obrazów, następnie osobny stos visuals. |
| Limity i budżety | Proponowane wartości przyjęte; pomiary przed merge potwierdzają ich spełnienie, z zachowaniem niższych limitów właściciela. |
| Samokontrola screenshotem | Poza v1; walidator i ręczny odbiór kitu pozostają w zakresie. |

Użytkownik zatwierdził realizację stosu obrazów i późniejszego stosu visuals.
PR-y implementacyjne pozostają draft do ukończenia i weryfikacji całego stosu;
stos scala użytkownik jednocześnie. Nazwę „Visual” należy dodać do glosariusza copy
w PR implementacyjnym. Audyt tekstów projektu: krótkie akcje („Download image”,
„Open full screen”, „Cite visual”), błędy z „Retry”, brak żargonu sandbox/API
w chrome użytkownika i brak tekstów humorystycznych. Dokładny audyt widoków
i pomiary produkcyjne pozostają kryteriami przyszłych PR-ów.

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

- `render_visual` (`packages/domain/src/agent-bus/visuals.ts`) jest w `AGENT_BUS_TOOLS`,
  więc trafia do wszystkich trzech harnessów. Opis narzędzia zawiera katalog,
  zasady stanu, przykład i limity. Dekoder szyny odrzuca argumenty większe niż
  limit spec przed parsowaniem, potem waliduje spec jak `decodeVisualSpec`.
- Gateway (`core/visual-publication.ts`, `store/visuals.ts`) wymaga uruchomionej
  tury, przypiętego workera z `thread_visuals_v1` i niearchiwizowanego wątku.
  Nowy visual dostaje UUIDv7 i wersję 1; aktualizacja wymaga `visual_id`
  i `expected_version` tego samego wątku. Rozbieżność daje konflikt z numerem
  aktualnej wersji, nigdy last-write-wins. Retry po call ID zwraca ten sam wynik.
- Wynik: `{ delivered, visual_id, item_id, version, citation_ref }`, gdzie
  `citation_ref` ma postać `visual:<visual_id>@<version>` i nie uprawnia do odczytu.
- Zapisane argumenty wywołania nie zawierają spec (tylko tytuł, opis i hash).

### Worker i harnessy

- Worker ogłasza `thread_visuals_v1`. Nie wykonuje niczego lokalnie: Claude
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
  kitu). Granica WebView na iOS/Androidzie wymaga dowodu na urządzeniach.
- Cache spec i zapisany stan kontrolek (`visual-state.json`) są czyszczone przy
  rozparowaniu, wygaśnięciu parowania i nowym parowaniu (`clearVisualCaches`).
- Zaakceptowane ryzyka resztkowe (przegląd bezpieczeństwa #695):
  - kod w ramce może zalewać most wiadomościami: most jest widoczny w każdej ramce,
    a natywnej strony nie da się ograniczyć z JS. Host odrzuca wiadomości bez tokenu
    i ponad limity, ale koszt ich dostarczenia ponosi proces aplikacji;
  - Android nie sprawdza nawigacji http(s) ramek potomnych
    (`shouldOverrideUrlLoading` ich nie widzi), więc granicą pozostają sandbox
    iframe i CSP dokumentu.

