# Generowanie tytułów wątków

Wszystkie wywołania modeli do generowania tekstu przechodzą przez oficjalne harnessy na workerze: Claude Agent SDK, Codex app-server albo Grok CLI przez ACP. Canopy nie wysyła bezpośrednich żądań inferencji HTTP. Grok obsługuje zarówno natywny login, jak i instancję proxy; CLIProxyAPI jest wyłącznie konfiguracją procesu CLI. [Adapter Grok](grok-adapter.md).

Tytuł powstaje asynchronicznie po pierwszej wiadomości użytkownika albo pierwszym celu nowego wątku. Gateway wysyła nietrwałą komendę `GenerateText` do połączonego workera z wybraną instancją dostawcy; preferuje worker wątku. Zwykła tura nie czeka na odpowiedź modelu. Wynik aktualizuje istniejące strumienie wątku i overview.

## Ustawienia i model domyślny

Settings → **Text generation** zapisuje w `user_settings.settings.textGeneration` instancję, model, effort oraz instrukcje tytułów. Ustawienia są globalne dla użytkownika, wersjonowane i rozsyłane jak pozostałe ustawienia. Reset modelu przywraca dobór automatyczny i pozostawia własne instrukcje. Advanced dopisuje instrukcje na końcu promptu dla nowych i regenerowanych tytułów.

Katalog nie zawiera cen ani opóźnień. Domyślnie używana jest jawna heurystyka małego/szybkiego modelu z widocznego katalogu instancji wątku:

1. Claude: rodzina Haiku.
2. Codex: kolejno nano, mini/luna, spark/flash/lite.
3. Grok: kolejno mini, fast/flash/lite; bez sztywnej listy wersji ani ograniczenia do proxy.
4. Bez rozpoznanej rodziny używany jest model wątku (przy pustym modelu — domyślny model katalogu workera).
5. Effort: `low`, jeśli wspierany; inaczej `none`, `minimal`, wspierany domyślny effort lub brak effort. Model bez poziomów nie otrzymuje effort.

W tej samej rodzinie wygrywa najnowsza wersja według numerycznego sortowania identyfikatora modelu. Nie jest to obietnica najniższej ceny. Heurystyka jest w `apps/gateway/src/core/thread-titles.ts`. Jawny wybór w ustawieniach ma pierwszeństwo.

## Źródło i wyścigi

Migracja `0022_thread_titles` dodaje `title_source`, `title_revision`, `title_requested` i `title_context`.

| Źródło | Reguła |
|---|---|
| `provisional` | Tytuł zastępczy z pierwszej linii wiadomości. Jedna automatyczna próba generacji. |
| `generated` | Oczyszczony wynik modelu; kolejne wiadomości nie uruchamiają generacji. |
| `user` | Jawny tytuł przy tworzeniu, fork „Fork of …” albo rename; automatyczna generacja go nie zastępuje. |

Stare niepuste tytuły migracja zachowuje jako `user`, ponieważ ich pochodzenia nie da się bezpiecznie ustalić. Wyłącznie puste tytuły i `New thread` stają się `provisional`.

**W toku.** `Thread.title_generating` jest prawdą od przyjęcia żądania do końca generacji (sukces, błąd albo timeout). Gateway wysyła wątek na starcie i na końcu zadania; nowy tytuł przychodzi razem z końcem stanu „w toku”. Stan żyje w pamięci gatewaya (jeden gateway), po jego restarcie znika razem z przerwaną generacją. UI pokazuje go na samym tytule (shimmer w sidebarze, nagłówku i panelu, spinner na przycisku), więc sukces nie potrzebuje toastu; toast dostaje tylko błąd żądania.

Atomowy claim w bazie chroni automatyczną próbę przed duplikatami. Zapis wyniku wymaga zgodnej rewizji: rename podczas generacji zawsze wygrywa. Jawne `RegenerateTitle` może zastąpić również tytuł użytkownika; zachowuje dotychczasowy tytuł do sukcesu. Panel wątku umożliwia rename i regenerację, a Cmd+K zawiera regenerację. `features/threads/title-actions.ts` jest wspólnym hookiem dla przyszłego menu sidebara.

Brak workera, błąd lub timeout pozostawia dotychczasowy tytuł i zapisuje ogólną diagnostykę. Nie ma outboxa, automatycznych ponowień ani generacji po kolejnych wiadomościach. Ręczna regeneracja pozwala spróbować ponownie.

Regeneracja odtwarza kontekst również ze starszych wątków: pierwszego zadania użytkownika/agenta w widocznej historii (z odziedziczonym prefiksem forka) albo celu, gdy nie było jeszcze wiadomości.

## Izolacja SDK

Worker ogłasza capability `generate_text`. Komenda przyjmuje prompt i konfigurację instancji, zwraca tekst. Nie tworzy platformowego wątku, tury, zadania w tle ani wpisu w dzienniku komend. Worker dopuszcza cztery generacje równocześnie, przerywa je po 30 sekundach i anuluje oraz sprząta je przy zamknięciu.

Claude używa Agent SDK `query`, jednej tury, pustej listy narzędzi/MCP/pluginów, wyłączonych hooków, `settingSources: []`, własnego system promptu i `persistSession: false`. Nie ładuje ustawień projektu/użytkownika ani CLAUDE.md i nie zostawia transkryptu sesji.

Codex używa osobnego app-servera, ephemeral thread, read-only sandboxa, approvals `never` i pustej listy narzędzi dynamicznych. Minimalny katalog modelu i jawne wyłączenia narzędzi/feature flags usuwają także narzędzia wbudowane (w tym goals). Tymczasowy CODEX_HOME udostępnia tylko login wybranej instancji; jej env, profil API i executable są takie jak dla zwykłych tur. Scratch jest usuwany po sukcesie, błędzie i anulowaniu. Test przechwytujący request modelu sprawdza pustą tablicę `tools`.

Grok uruchamia osobny `grok agent --no-leader … stdio` i nową sesję ACP dla każdego żądania. Tymczasowy home nie współdzieli sesji ani skills instancji; cwd jest pustym katalogiem scratch, bez workspace'u. Jedynym współdzielonym plikiem jest wskazany login instancji. Proxy i klucz trafiają wyłącznie do konfiguracji/env CLI. Pełny profil ACP wyłącza domyślne narzędzia, skills i jawnie blokuje narzędzia rdzenia (samo `tools: []` przywraca domyślny zestaw CLI). Brak MCP oraz callbacków plików/terminala; każda prośba o zgodę otrzymuje odmowę albo anulowanie, gdy CLI nie oferuje odmowy. Reguły CLI dodatkowo zabraniają wszystkich klas narzędzi. Własne argumenty startowe instancji są pomijane dla generacji tekstu, aby nie włączyły pluginów ani automatycznych zgód. Limit 30 s obejmuje także handshake; limit 16 KiB obejmuje tekst odpowiedzi i rozumowania. Zwracany jest wyłącznie tekst odpowiedzi po `end_turn`. Błąd, narzędzie, timeout lub przekroczenie limitu odrzuca częściowy wynik. Cleanup zbiera proces i jego grupę oraz usuwa scratch.

Prompt zawiera ograniczony tekst użytkownika, nazwy załączników, references i cytaty jako dane; nie rozszerzony prompt harnessu. Początkowe komendy platformy, np. `/goal`, są usuwane. Model ma opisać zadanie w języku wiadomości. Sanitizer usuwa markdown, otaczającą interpunkcję i znaki kontrolne, zostawia jedną linię do 60 punktów kodowych Unicode.

## Weryfikacja

- `apps/worker/src/providers/generate-text.test.ts`: zgodność konfiguracji Codexa i request bez narzędzi.
- `apps/worker/src/providers/grok/generate-text.test.ts`: fake ACP, izolacja native/proxy, odmowy, limity, timeout handshake/promptu, anulowanie i sprzątanie procesów; lokalny endpoint przechwytuje request rzeczywistego Grok CLI i sprawdza pustą listę narzędzi, bez płatnej inferencji.
- `tests/integration/thread-titles.test.ts`: scripted worker, asynchroniczna generacja, strumienie, rename, explicit title, regeneracja, ustawienia i błędy.
- `tests/integration/grok-text-generation.test.ts`: gateway ↔ rzeczywisty worker ↔ fake ACP, tytuł i semantyczna nazwa gałęzi, automatyczny mały model oraz jawny wybór native poza dawną listą mini.
- `tests/integration/text-generation.live.test.ts`: trzy harnessy przez CLIProxyAPI, wynik i brak platformowej persystencji/transkryptów. Opt-in `CANOPY_LIVE=1`, używa `useLiveProxy`; sekrety pozostają poza repo.
