# Pomiar wydajności klientów

Narzędzia służą do porównywania zmian renderera web/desktop i kodu JS aplikacji
mobilnej. Nie są zestawem testów UI. Używają deterministycznych danych syntetycznych;
nie wymagają kont dostawców ani dostępu do istniejących rozmów. Wyniki liczbowe
trafiają do opisu PR, nigdy do plików w repozytorium.

## Środowisko

Ustaw `TMPDIR` na prywatny katalog na dysku, poza `/tmp` (tmpfs). Zainstaluj
zależności przez `bun install`. Zapisz commit, wersje Bun/przeglądarki, CPU,
rozmiar viewportu i liczbę tur; przed i po zmianie używaj tych samych parametrów.
Nie uruchamiaj równolegle kilku przeglądarek ani kilku eksportów Metro.

`bun scripts/bench/client-stack.ts` uruchamia osobny PostgreSQL w Dockerze,
gateway i developerski BFF. Porty można wskazać przez `CANOPY_BENCH_WEB_PORT`,
`CANOPY_BENCH_GATEWAY_PORT`, `CANOPY_BENCH_PG_PORT`. Skrypt odrzuca porty
zarezerwowane dla innych stosów. Zatrzymaj **proces skryptu** przez SIGINT/SIGTERM:
sprząta wyłącznie uruchomione przez siebie procesy i kontener. Usuń swój katalog
tymczasowy po zakończeniu pomiarów. Syntetyczny worker nie uruchamia CLI ani
inferencji: na wiadomość odpowiada 200 deltami po 25/s przez prawdziwe łącze.
W nowej, prywatnej bazie tworzy 500 wątków projektu i 1000 tur z 7099 itemami
w jednym z nich; wypisuje adres tego wątku. Zwykła strona wątku pobiera początkowo
ostatnią stronę historii, a nie wszystkie 1000 tur. Otwieranie tej strony mierzy
rzeczywisty snapshot gateway → BFF → SSE; fixture poniżej mierzy cały załadowany feed.
Tworzy też jednego bota do sprawdzenia otwierania ustawień, bez wysyłania mu wiadomości.
`CANOPY_BENCH_SEED=0` wyłącza zasiew i syntetycznego workera na potrzeby pomiaru
samego renderera bez ruchu i animacji paska bocznego; użyj tej samej opcji przed i po.
Po buildzie web ustaw `CANOPY_BENCH_PRODUCTION=1`, aby zamiast Vite uruchomić
produkcyjny serwer BFF. Ta opcja służy do cold FCP na zwykłej stronie wątku;
trasy i importy developerskich sond wymagają Vite.

Ostatnia odpowiedź zasianego wątku powtarza Markdown 64 razy. Fixture przyjmuje
analogiczny parametr `answerRepeat=64` (1–100), aby sprawdzić pojedynczą bardzo
długą odpowiedź poza standardowym pomiarem wielu tur.

Na developerskim BFF zaimportuj w konsoli moduł
`/src/lib/features/threads/dev/navigation.ts`. `probeThreadSnapshot(id, 20)`
otwiera i zamyka prawdziwe EventSource i mierzy `JSON.parse` + dekoder protobuf +
`ThreadState.apply` pierwszego snapshotu. `probeThreadNavigation('/threads/' + id)`
mierzy nawigację SPA do drugiej klatki po zamontowaniu artykułów i gotowość fokusu
kompozytora. Zacznij z innej strony, np. `/settings/general`. To proxy gotowości
konkretnych kontrolek, nie browser TTI ani cold FCP. Aby powtórzyć cold FCP,
przeładuj stronę i odczytaj `performance.getEntriesByType('paint')`; zapisz,
czy build był developerski czy produkcyjny i czy cache przeglądarki był ciepły.

Moduł `/src/lib/features/threads/dev/network.ts` udostępnia `probeThreadStream(id)`.
**Wysyła wiadomość**: używaj wyłącznie wydrukowanego id syntetycznego wątku.
Mierzy synchroniczny handler rzeczywistych delt SSE w oddzielnym `ThreadState`,
bez renderowania; liczba wiadomości może być mniejsza niż 200 przez koalescencję BFF.
Podczas pomiaru można pozostawić zwykłą stronę wątku, by oglądać ten sam streaming.

## Web i renderer desktopu

Przy pracy w tle główny wątek ma pozostawać wolny dla wejścia użytkownika:

- Ciągłe animacje używają wyłącznie `transform`/`opacity`. Shimmer to nieruchomy
  raster tekstu i przesuwana miękka maska z przeciwruchem kopii, bez animowania
  `background-position`. Nie promuj całych paneli przez `will-change`.
- Jedna współdzielona kolejka zegara obsługuje czas pracy i etykiety względne.
  Sekundy aktualizują mały komponent tekstu, nigdy fold, panel ani listę tur.
  Zakończona praca nie subskrybuje sekund; etykiety względne zachowują wolniejszy rytm.
- Jeden `IntersectionObserver` zatrzymuje zegary i dekoracje poza widokiem,
  również w overscanie i zwiniętych panelach. Ukryta karta nie utrzymuje timerów;
  powrót odczytuje bieżący czas. `prefers-reduced-motion` wyłącza pętle ruchu.
- Odczyty geometrii i dopasowania tekstu grupuj przed zapisami. Zmiana delty nie
  może wymuszać kolejnych pomiarów tej samej osi w jednym przebiegu aktualizacji.
  Tokeny ruchu buforuj do zmiany stylu korzenia, nie tylko do kolejnej klatki.
  Niezależny, zakończony prefiks feedu zachowuj między deltami. Zmiana historii,
  wyników, foldów lub zależność przez granicę prefiksu wymaga ponownego obliczenia.
  Indeksy i animacje wejścia aktualizuj dopiero po zmianie kluczy lub grup wierszy.
  Wzrost treści obsługuje `ResizeObserver`; delta o stałej wysokości nie wymaga
  odczytu `scrollHeight`. Izoluj layout wierszy i przewijanych bloków kodu.
- W mobile pętle działają na UI/native thread, korzystają ze wspólnej kolejki
  widoczności listy, zatrzymują się w tle, a dekoracyjne
  `Animated.loop` mają `isInteraction: false`, aby nie blokować batchy listy.

Porównanie animacji wymaga przynajmniej dwóch minut tych samych danych: 1000 tur,
2–4 pracujących subagentów, otwartego foldu ze strumieniem i kilku aktywnych wątków
w sidebarze. Zapisz ślady CDP oraz inwentarz `document.getAnimations()` (w tym
właściwości keyframes) i `will-change`. Podaj busy % głównego wątku, long tasks/min,
odsetek utraconych klatek, odstęp klatek, style/layout ms/s i próbki heap.
Znaczniki trace mają częstotliwość ekranu (np. 120 Hz); rAF nie jest pomiarem
prezentacji kompozytora. Liczby aktywnych elementów i `will-change` nie dają się
wiarygodnie odtworzyć z samej liczby zdarzeń `Animation` w cudzym śladzie.

Otwórz `/dev/long-thread?turns=1000&inherited=0` w jednej przeglądarce na swoim
BFF. Trasa używa produkcyjnych komponentów osi czasu, ale dane dostarcza fixture,
bez pobierania historii z gatewaya. Nie mierzy więc czasu bazy ani sieci.

1. Poczekaj na `window.__benchReady`, następnie wykonaj
   `await window.__benchRun()` w konsoli lub przez CDP/Playwright jako narzędzie.
2. Odczytaj `JSON.stringify(window.__bench)`. `mountMs` obejmuje ponowny montaż
   gotowej osi czasu do drugiej klatki (proxy paint, nie cold navigation/TTI).
   `delta*` mierzy reducer, aktualizację Svelte i wymuszony layout. Scroll obejmuje
   80 kroków po 90% viewportu. `nodes` liczy elementy wewnątrz scrollera.
3. Uruchom `window.__benchSession.run(30, 1000)` i zachowaj wynik poza repo.
   To rzeczywiste 30 minut: otwieranie różnych syntetycznych historii, 200 delt
   tekstowych po 25/s, zakończenie tury i przewijanie. `status()` pokazuje postęp,
   `stop()` kończy po bieżącym kroku. Nie przeładowuj strony podczas sesji.
4. Porównaj próbki heap i DOM w kolejnych cyklach oraz long tasks. Brak
   `performance.memory` oznacza brak pomiaru heap. To licznik Chromium, nie
   retained heap po GC; do potwierdzenia wycieku użyj snapshotów Memory w DevTools.
5. Sprawdź jasny/ciemny schemat, desktop/telefon, streaming, rozwijanie foldu,
   stabilność pozycji przy czytaniu historii i `prefers-reduced-motion`.

Koszt handlera sesji obejmuje dekodowanie JSON protobuf i `ThreadState.apply`.
Nie obejmuje transportu EventSource ani renderowania (które mierzy `delta*`).
Cold navigation, pierwszy paint i interaktywność wymagają osobnego nagrania
Performance/Navigation Timing na produkcyjnym buildzie z zasianymi danymi;
nie należy nazywać pomiaru remountu czasem otwarcia pełnego wątku.

Po `bun run --filter @canopy/web build` uruchom
`bun scripts/bench/bundle-sizes.ts`. Wynik dla każdego węzła SvelteKit obejmuje
statyczną sumę importów strony, powłoki i jej layoutów, z deduplikacją plików.
Podaje nazwę trasy oraz surowe i gzip JS/CSS. Trasy i węzły czyta z manifestu SvelteKit.
Dynamiczne importy, gramatyki highlightera i żądania sieciowe nie należą do tej sumy.

## Mobile: pomiary bez natywnego runtime

`bun scripts/bench/client-js.ts` raportuje medianę i p95 po rozgrzewce:
dekodowanie i reducer 200 delt, przygotowanie web feedu, mobilne `visibleTurns`,
`turnBody` dla zwykłej tury i 5000 zagnieżdżonych itemów, tokenizację długiego
Markdown oraz zapis tej samej i nowej rewizji cache i zimny odczyt z dekodowaniem.
Dane mają domyślnie 1000 tur;
`CANOPY_BENCH_TURNS` zmienia rozmiar. Cache używa adaptera bez dysku: wynik nie
obejmuje kosztu `expo-file-system`. Bun/JSC nie przewiduje czasów Hermes ani UI.

Przed i po PR zmieniającym aplikację uruchom z `apps/mobile`, osobno dla `ios`
i `android`:

```bash
bunx eas-cli@27.4.1 fingerprint:generate --platform ios --build-profile production --json --non-interactive
bunx eas-cli@27.4.1 fingerprint:generate --platform android --build-profile production --json --non-interactive
```

Hash musi pozostać identyczny. Eksportuj obie platformy przez
`bunx expo export --platform ios --output-dir "$TMPDIR/export-ios"` i analogicznie
Android. Zapisz rozmiar `.hbc` i assetów. Eksport to bundle JS, bez APK/IPA i bez
publikacji OTA. Nie uruchamiaj buildów EAS ani generowania projektów natywnych.

## Profilowanie na urządzeniu

`TMPDIR` na dysku, następnie `bun scripts/bench/image-cache.ts`, mierzy liczbę żądań
i bajty odpowiedzi HTTP dla 20 miniatur po 16 KiB: dwa przejścia i ponowne otwarcie,
a osobno restart cache w tym samym parowaniu. Porównuje poprzedni odczyt przy każdym
montowaniu z rzeczywistym stanem cache i filesystemem Node. Nie mierzy RPC ani renderera:
widoczność jest symulowana. Na urządzeniu powtórz scenariusz, rejestrując `GetAttachment`
i `GetThreadBlob` w profilerze sieci, bez zapisywania treści lub identyfikatorów użytkownika.
Sprawdź także anulowanie przy szybkim scrollu, pełny viewer, restart, unpair i revocation;
po unpair katalog obrazów ma być pusty. Pamięć bitmap sprawdź narzędziami platformy.

W prywatnym stosie web wyślij 20 deterministycznych PNG (np. canvas 256 × 256 z szumem),
po 10 załączników na wiadomość. Worker pomiarowy zgłasza katalog załączników,
ale nie odczytuje plików i nie uruchamia modelu. W przeglądarce wyczyść Resource Timing
przed pierwszym przejściem. Przewijaj ostatnie dwie tury w krokach 400 px, czekając
na render, następnie powtórz i ponownie otwórz wątek. Dla `/api/attachments/` zsumuj
`encodedBodySize` tylko przy `transferSize > 0`, osobno policz żądania sieciowe i cache hits.
Przy walidacji nagłówków użyj osobnej próby, aby wymuszony `If-None-Match` lub pełny
wariant obrazu nie zmienił wyniku. Nie wyłączaj cache w DevTools. Istniejące private/immutable
już oszczędzało ponowne transfery web; ETag nie jest dodatkowym spadkiem bajtów przy świeżym cache.

Na zgodnym kliencie z modułami natywnymi otwórz te same dane: 1000 tur, jedną turę
z 5000 itemów i odpowiedź zawierającą kod, tabelę oraz diff. Użyj React Native
DevTools Profiler do nagrania 200 delt po 25/s: policz commity i renderowane
zakończone tury, osobno koszt JS oraz layout/native. Sprawdź powrót do początku,
otwieranie foldu, klawiaturę i anchor po dopisaniu historii.

FlatList wirtualizuje **tury**, więc jedna bardzo długa odpowiedź nadal tworzy
cały widok natywny. Nie podawaj fikcyjnego `getItemLayout`: wysokości Markdown
i rozwijanych foldów są zmienne. Dobieranie `windowSize`, batch size i clippingu
wymaga pomiarów na słabszym Androidzie i iPhonie; agresywne zmniejszenie okna może
powodować puste obszary przy szybkim scrollu. Zapisz konfigurację i liczbę
zamontowanych tur w nagraniu.

W narzędziach pamięci platformy nagraj 30 minut przełączania wątków, przechodzenia
w tło i otwierania/zamykania dużych obrazów. Porównaj heap Hermes, pamięć bitmap
i pamięć procesu po zamknięciu viewerów. Osobno zmierz odczyt/zapis cache na
prawdziwym filesystemie. Wnioski o pamięci obrazów, płynności UI i energii wymagają
tych pomiarów; harness Bun ich nie zastępuje.

## Pasek boczny i indeks wątków na żywo

Każde zdarzenie overview zastępuje indeks wątków (`OverviewState.threads`), więc wszystko,
co czyta cały indeks, przelicza się przy każdym zdarzeniu. Koszt ma rosnąć z liczbą
zmienionych wierszy, nie z liczbą wątków:

- Wiersz długiej listy nie czyta indeksu, mapy wpisów ani wspólnych tablic. Lista trzyma
  stabilną tablicę kluczy (zmienia się tylko przy zmianie kolejności), a każdy wiersz czyta
  własny slot `Keyed` (`#lib/shared/keyed.svelte.ts`), synchronizowany w `$effect.pre` przed
  listą. Slot dostaje nową wartość tylko wtedy, gdy zmieniło się to, co wiersz pokazuje
  (`sidebarRows` + `sameSidebarRow`: wątek, dzieci, projekt, worker, otwarte drzewo).
  Puste listy dzieci to jedna stała, nie nowa tablica przy każdym przeliczeniu.
- `{#each}` z `animate:` mierzy wszystkie elementy przy każdej zmianie tablicy. `reorder`
  nie animuje wierszy, które przed i po przestawieniu są poza ekranem.
- Wiersze poza ekranem mają `content-visibility: auto` z `contain-intrinsic-size: auto`
  równym wysokości wiersza dla danego breakpointu i `overflow-clip-margin` na pierścień
  fokusu. Chromium obserwuje każdy taki element wewnętrznym IntersectionObserverem
  przy każdej klatce: 500 wierszy kosztowało ok. 0,5–0,8 ms na klatkę, ale pre-paint,
  paint i layerize całego paska spadły bardziej (także przy streamingu w innym widoku).
  Stosuj to tylko na długich listach i mierz oba składniki
  (`IntersectionObserverController::computeIntersections` i etapy paint).
  Nie zastępuj tego wirtualizacją: lista zostaje w DOM dla wyszukiwania w stronie,
  kolejności Tab i drzewa dostępności.
- Dane pochodne strony wątku (drzewo, subagenci w trayu) zachowują poprzednią wartość,
  gdy przebudowa daje te same elementy (`retain` z `@canopy/domain/same-items`). Szukanie
  wątku po id używa mapy indeksu, nie `find` po liście projektu.
- Odświeżenia wyzwalane zdarzeniami filtruj tym, czego naprawdę dotyczą: status
  i aktywność aktywnego wątku nie pobierają stron archiwum (`changesArchived`,
  `indexChangesArchived` dla klientów trzymających całą listę).
- `Intl.DateTimeFormat` twórz raz na zestaw opcji; listy formatują daty w każdym wierszu.
- Komponent powtarzany w wierszach nie rejestruje nasłuchów na `document`, jeśli nie są
  potrzebne (tooltip nasłuchuje stuknięć poza sobą tylko dla `touch: "tap"`).
- Mobile: wiersze FlatList są w `memo` z komparatorem obejmującym wszystko, co wiersz
  pokazuje, łącznie z etykietą wieku w czasie renderu listy, żeby wynik był taki sam
  jak bez `memo`. Listy pochodne overview (`workers`, `projectChoices`) są w `useMemo`.

Scenariusz pomiaru paska: 500 zasianych wątków, otwarty inny, bezczynny wątek, 10 wątków
pracuje. Co 50 ms jeden z nich zmienia status, tytuł, liczbę zadań w tle lub ostatnią
wiadomość, przez tę samą ścieżkę co handler SSE (JSON → protobuf → `OverviewState.apply`).
Jak w gatewayu, `lastActivityAt` (a więc miejsce na liście) zmienia się tylko przy starcie
lub końcu tury. Aktualizacje wstrzykuje się przez tymczasowe wystawienie `OverviewState`
na `window` w lokalnej kopii, nigdy w repozytorium. Zgodność zachowania sprawdza
deterministyczna sekwencja zdarzeń: kolejność wierszy, `data-calm`, `data-result`,
`data-unread`, `aria-current` i tekst wszystkich wierszy muszą być identyczne przed i po
zmianie. Pętla rAF harnessu wymusza klatkę główną przy każdym odświeżeniu ekranu; podaj
też przebieg bez aktualizacji jako tło.
