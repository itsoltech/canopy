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
tymczasowy po zakończeniu pomiarów. Nie uruchamia workera ani inferencji.

## Web i renderer desktopu

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
statyczną sumę importów strony, powłoki i głównego layoutu, z deduplikacją plików.
Podaje surowe i gzip JS/CSS. Numery węzłów mapuje wygenerowany manifest SvelteKit.
Dynamiczne importy, gramatyki highlightera i żądania sieciowe nie należą do tej sumy.

## Mobile: pomiary bez natywnego runtime

`bun scripts/bench/client-js.ts` raportuje medianę i p95 po rozgrzewce:
dekodowanie i reducer 200 delt, przygotowanie web feedu, mobilne `visibleTurns`,
`turnBody` dla zwykłej tury i 5000 zagnieżdżonych itemów, tokenizację długiego
Markdown i serializację cache z kolejką. Dane mają domyślnie 1000 tur;
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
