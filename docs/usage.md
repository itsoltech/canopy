# Statystyki zużycia tokenów i kosztów

Status (2026-11-18): zaimplementowane agregaty zużycia w gatewayu, raporty
harnessów, niezależne szacunki ekwiwalentu API OpenAI, wybór kosztu per licznik,
API `GetUsageStats`, synchronizacja źródeł połączonych komputerów i podział
modalu Usage według rodzaju aktywności oraz poszczególnych botów.
Dostępność nightly/beta/stable według [release.md](release.md).

## Co mierzymy

Statystyki opisują zaobserwowane zużycie inferencji: wątki, ukryte tury botów
oraz pomocnicze generowanie tytułów i nazw gałęzi. Nie są limitem konta
providera ani rozmiarem kontekstu. Liczniki konta pozostają osobnym mechanizmem
`ProviderUsageReport` / `provider_usage`; `ContextUsage` opisuje wyłącznie
bieżący kontekst sesji.

Tury botów obejmują rozmowy prywatne i zewnętrzne oraz uruchomienia rutyn.
Praca zlecona przez bota zwykłemu wątkowi jest zużyciem wątku. **Other generation**
obejmuje komendy pomocnicze `GenerateText`, a **Unattributed** zachowuje
zaobserwowane zużycie bez wiarygodnego przypisania.

`Usage.scope = TURN` oznacza narastający licznik jednego modelu w jednej turze
platformy. Adapter odejmuje odziedziczoną historię sesji przed publikacją.
Raport bez jawnego zakresu nie trafia do agregatów. Ten sam licznik może pojawić
się w wielu `usageUpdated` i `turnFinished`: gateway dodaje wyłącznie przyrosty,
zachowując watermark osobno dla każdej pary tura/model. Spóźniona korekta starszej
tury pozostaje ważna także po rozpoczęciu następnej. Przerwanie albo błąd nie
usuwa zużycia już zgłoszonego przez harness.

- `input_tokens` zawiera odczyt i zapis cache; `cached_input_tokens` oraz
  `cache_write_input_tokens` są jego podzbiorami.
- `output_tokens` zawiera `reasoning_output_tokens`; reasoning nie jest dodatkowym
  zużyciem ponad output.
- `reported_cost_usd` jest opcjonalną kwotą USD rzeczywiście zgłoszoną przez
  providera. Jawne zero jest znanym kosztem; brak pola oznacza nieznany koszt.
  Starsze nieopcjonalne `cost_usd` nie dowodzi znajomości ceny i nie zasila agregatów.
- `estimated_cost_usd` jest osobnym, opcjonalnym szacunkiem ekwiwalentu API OpenAI.
  Nie jest rachunkiem za subskrypcję ani dowodem opłaty providera. Worker wycenia
  odpowiedź Codexa według zamrożonej próbki cennika models.dev wyłącznie dla OpenAI;
  brak dowodu modelu, tokenów lub odpowiedniej ceny oznacza nieznany szacunek.
  Jawne zero jest znane. `pricing_version` zachowuje zwarty opis pochodzenia cen
  użytych w liczniku (źródło, data, hash i tier), bez osobnego rekordu SQL odpowiedzi.
- Model pochodzi z raportu harnessu; jeśli raport go nie podaje, gateway zachowuje
  wybrany model tury. Pusty model pozostaje nieznany. Osobne raporty różnych modeli
  nie zastępują siebie.

Claude rozdziela liczniki per model i uwzględnia jawne raporty wywołań pomocniczych.
Stan sesji i jej odziedziczone koszty nie są nowym zużyciem. Codex rozlicza
raporty odpowiedzi z deduplikacją identyfikatora i bezpieczne różnice liczników.
Codex `usageMetadata.amount` jest kwotą USD jednej odpowiedzi; adapter sumuje
ją per tura/model z deduplikacją ID odpowiedzi. Jawne zero jest znaną ceną,
a brak lub niepoprawna kwota pozostają nieznane. Wycena jest kompletna dopiero,
gdy obejmuje wszystkie zaobserwowane tokeny i odpowiedzi danego licznika.
Grok rozlicza jawne metadane zakończenia promptu; rozmiar kontekstu z ACP nie
stanowi dowodu przepływu tokenów. Szczegóły źródeł i granic opisują adaptery.

Rekoncyliacja po awarii odtwarza dostępne pomiary per model niezależnie od tego,
czy harness zdążył zapisać koniec tury. Claude odtwarza raporty wiadomości
asystenta z deduplikacją ID. Codex nie przypisuje bezmodelowych `token_count`
do wybranego modelu: po reroutingu mogłoby to ponownie rozliczyć zużycie
już zapisane pod rzeczywistym modelem. Bez dowodu modelu obsługującego wywołanie
takie zużycie pozostaje poza agregatami. Brak raportu nie oznacza zera.

Worker utrzymuje trwały lokalny cache cennika OpenAI z models.dev i współdzieli
odświeżenia w toku; nie wykonuje HTTP dla każdej inferencji. Nieznany model może
wywołać odświeżenie z cooldownem. Nowy cennik służy kolejnym obserwacjom:
wcześniejsze odpowiedzi zachowują swoje ceny i nie są przeliczane wstecz.
Gateway nie pobiera cenników i przechowuje wynik obliczenia workera. Koszt zgłoszony
i szacunek mają niezależne pokrycie; późniejszy raport jednego nie usuwa drugiego.

## Żądana szybkość wykonania

`Usage.requested_service_tier` opisuje **żądany tryb wykonania**, nie dowód
rzeczywistego tieru naliczonego przez providera. `default` oznacza Standard,
`fast` — Fast, `ultrafast` — Ultrafast; inne natywne identyfikatory, w tym
`priority`, pozostają osobnymi kluczami. Puste pole oznacza brak informacji.
Nie utożsamiamy `priority` z Fast ani brakującego pola ze Standard.

Nowy worker podaje skutecznie przyjęty wybór wykonania. Gdy go brakuje,
gateway może wykorzystać wyłącznie trwałe `turns.service_tier` albo
`RunBotTurn.service_tier` zapisanej komendy. Bieżące ustawienia wątku/bota
nie opisują wcześniejszej pracy i nie stanowią fallbacku. Pomocnicze generowanie
ma Standard tylko wtedy, gdy nowy raport jawnie podaje `default`.

Pierwsza znana wartość zamraża przypisanie całej tury, również innych jej modeli.
Zmiana ustawień ani sprzeczna późniejsza próbka nie przepisuje wcześniejszego
kosztu. Korekta braku informacji do znanego trybu atomowo przenosi istniejące
sumy i watermarki: zachowuje godzinę, liczbę raportów i całkowite zużycie.
Wyzerowany koszyk poprzedniego trybu pozostaje z nową rewizją, aby zastąpić
jego wcześniejszą kopię u partnera. Tryb nie wchodzi do klucza deduplikacji
watermarku tura/model. Zmiana szybkości w trakcie sterowania kolejkuje nową turę.

## Trwałość i rozmiar danych

Migracja `0164_usage_accounting` tworzy:

| Tabela | Zawartość |
|---|---|
| `usage_state` | Tożsamość źródła, początek pokrycia, czas zapisu i rewizja właściciela. |
| `usage_buckets` | Sumy na godzinę UTC, providera, model, żądaną szybkość i aktywność. Kluczem aktywności bota jest jego trwały identyfikator. |
| `usage_counters` | Mały watermark tury/modelu lub komendy generowania z `pricing_version`; bez tekstów i zdarzeń. |
| `remote_usage_buckets` | Ostatnie zastępowalne agregaty otrzymane bezpośrednio z domu źródłowego. |
| `remote_usage_state` | Kursor, pokrycie, czas synchronizacji i informacja o niepobranych stronach. |

Migracja `0165_usage_estimated_cost` dodaje osobne kwoty i liczniki pokrycia
szacunków oraz kosztu wybranego per licznik. Istniejące zgłoszone USD pozostają
bez zmian. Dla starych koszyków z częściową ceną koszt wybrany obejmuje tylko
kompletne zachowane watermarki; po usunięciu watermarków nie można rozdzielić
historycznych częściowych kwot, więc pozostały wkład jest nieznany. Koszyk ze
wszystkimi zgłoszonymi cenami kompletnymi zachowuje całą kwotę jako wybraną.
Migracja nadaje koszykom nowe rewizje dla odbiorców już zsynchronizowanych.
Nie odtwarza historycznych szacunków z obecnego cennika.

Migracja `0172_usage_activity` rozdziela już rozliczone zużycie według zachowanych
watermarków. Reszta wcześniejszych agregatów pozostaje jako **Unattributed**.
Etykieta bota korzysta z bieżącej nazwy na źródłowym komputerze lub ostatniej
zapisanej nazwy po usunięciu rekordu. Zmiana nazwy ani usunięcie bota nie zmienia
identyfikatora lub sum. Przy przeniesieniu bota pomiędzy komputerami wcześniejsze
agregaty nadal pochodzą z domu rozliczenia, a widok łączy je według identyfikatora bota.

Cała tura/model należy do godziny **pierwszej zaobserwowanej próbki**, również
po spóźnionej korekcie cache, tokenów albo kosztu. Długa tura przekraczająca północ
nie jest arbitralnie dzielona na dni. Dzięki temu cache i reasoning pozostają
podzbiorami w tym samym koszyku także wtedy, gdy harness dostarcza pola w różnym
czasie. Widok dzienny sumuje te koszyki; nie jest rozkładem czasu pracy modelu.

Zapis przyrostu, watermarku, transkryptu i kursora dziennika odbywa się w tej samej
transakcji. ACK wychodzi po commicie. Powtórzenie zdarzenia lub końcowego raportu
nie zwiększa sum. Usunięty wątek nadal może dostarczyć raport istniejącej tury:
gateway zapisuje zużycie i ACK, bez przywracania historii. Oczyszczenie tur usuwa
watermarki przez FK; agregaty pozostają. Archiwizacja, usunięcie rozmowy,
import historii, lustro i przeniesienie jej rekordów same nie tworzą zużycia.

Rewizje koszyków są przydzielane pod transakcyjną blokadą `usage_state`
właściciela. Ich kolejność odpowiada kolejności commitów; eksport po kursorze nie
omija transakcji z wcześniejszą, jeszcze niezatwierdzoną rewizją. Samodzielna
sekwencja PostgreSQL nie dawałaby tej gwarancji. Nie przechowujemy osobnego
zdarzenia księgowego dla każdej próbki ani kopii promptów/transkryptów.

Pomocnicze `GenerateText` pozostaje komendą z nietrwałym oczekiwaniem na wynik.
`CommandResult.consumed_usages` niesie osobne narastające próbki modeli
(zgodnościowe `consumed_usage` służy jako fallback). Gateway deduplikuje otrzymany
wynik po identyfikatorze komendy i modelu, także przy `ok=false`. Jeżeli wynik lub
raport providera nie dotrze przed awarią, nie da się odtworzyć tej inferencji
z samej platformy. Statystyki obejmują wyłącznie zaobserwowane kwoty i tokeny.

## Koszt i pokrycie

`reports` liczy odrębne liczniki tura/model, a nie liczbę aktualizacji live.
`unknown_cost_reports` liczy te, których całe zaobserwowane zużycie nie ma znanego
kosztu. Późniejsza pełna cena zmniejsza licznik niewiadomych. Nowy większy raport
bez ceny może ponownie oznaczyć licznik jako nieznany, zachowując wcześniej
zaobserwowane USD. Mniejsza spóźniona próbka z ceną nie oznacza większego zużycia
jako w pełni wycenione. Kwota jest więc sumą **zgłoszonych kosztów**, a przy
nieznanych raportach stanowi częściową obserwację. Nie jest rachunkiem providera.

`estimated_cost_usd` i `unknown_estimated_cost_reports` działają niezależnie,
na tych samych zasadach kompletności. Niepoprawne kwoty (NaN, infinity, wartości
ujemne) są nieznane, a nie zerowe. Wzrost tokenów bez kompletnej ceny zachowuje
wcześniejsze kwoty jako częściowe; mniejsza spóźniona próbka nie naprawia pokrycia
większego licznika. Tokeny pozostają monotoniczne. Późniejsza poprawna pełna cena
może uzupełnić pokrycie bez dodatkowych tokenów.

`effective_cost_usd` wybiera **przed agregacją**, osobno dla każdego licznika:
kompletny koszt zgłoszony, następnie kompletny szacunek, w przeciwnym razie brak
kwoty. `effective_reported_cost_reports`, `effective_estimated_cost_reports`
i `unknown_effective_cost_reports` razem dają `reports`. Kwota wybrana może
zmaleć, np. gdy zgłoszone zero zastąpi szacunek albo wzrost bez ceny unieważni
kompletność. Niezależne sumy kosztów nie są dodawane do siebie: wyceniają to samo
zużycie. Wybór po zsumowaniu providerów lub modeli prowadziłby do nakładania kwot.

Początek pokrycia jest czasem uruchomienia nowego księgowania dla właściciela,
nie datą najstarszej rozmowy. **Nie odtwarzamy zużycia z dawnych transkryptów**:
dawne JSON-y nie rozróżniały bezpiecznie kosztu zero od braku ceny ani zakresu
sesji od tury. Brak danych sprzed aktywacji nie oznacza zerowego zużycia.
Nieobserwowane wywołania, awaria przed raportem i nieobsługiwany harness także
nie dają podstaw do oszacowania zużycia.

## API i połączone komputery

`GetUsageStats(days, provider, computer_id, requested_service_tier, activity_kind, bot_id)` obsługuje 1, 7, 30 lub 90 dni
kalendarzowych UTC, łącznie z dzisiejszym; zero wybiera 30. Zwraca sumę, dni
(z zerami wewnątrz wybranego okna), podział provider/model oraz źródła i ich
pokrycie. Każdy dzień zawiera również `providers`: sumy tego samego zestawu
koszyków osobno dla providera, do wykresu ze stałymi kolorami źródeł inferencji.
W modalu Usage podsumowanie dnia i legenda rezerwują miejsce na informacje
o źródłach kosztu. Zmiana dnia kursorem lub klawiaturą zachowuje pozycję wykresu
i przewinięcie modalu.
Opcjonalny filtr `requested_service_tier` bez pola wybiera wszystkie tryby,
a jawne `""` wybiera wyłącznie nieznany tryb. `speeds` zwraca ten sam zestaw
sum pogrupowany według żądanej szybkości. Filtr działa przed sumowaniem:
obejmuje sumy, dni i ich providerów, modele oraz źródła lokalne i zdalne.
Dom serwerowy działa bez usług łączenia komputerów.

`activity_kind` wybiera `thread`, `bot`, `generation` lub `unattributed`;
pusta wartość wybiera wszystkie. `bot_id` zawęża całą odpowiedź do jednego bota.
Odpowiedź zwraca `activities` i `bots` z tego samego zbioru po filtrach oraz
flagę `has_unattributed_usage` przed zawężeniem do aktywności lub bota. Dzięki
temu modal zachowuje informację o nieprzypisanej części także podczas filtrowania.

Odczyt korzysta wyłącznie z lokalnej bazy: nie czeka na połączenie partnera.
Prywatny `canopy.link.v1.UsageService.GetUsageBuckets` eksportuje ograniczone
strony zastępowalnych koszyków z rewizją, obiema niezależnymi wycenami i kosztami
wybranymi per licznik; nigdy nie zbiera źródeł partnerów. Starszy snapshot bez
nowych pól nie dowodzi zerowego szacunku: odbiorca oznacza szacunki jako nieznane,
a koszt wybrany odtwarza z całej zgłoszonej kwoty tylko przy kompletnym pokryciu.
Przy częściowym pokryciu starego agregatu wybrany koszt pozostaje nieznany.
Odbiorca wiąże źródło z uwierzytelnionym komputerem i atomowo zapisuje stronę
razem z kursorem oraz `has_more`. Brak łącza zachowuje ostatni zatwierdzony stan.
Usunięcie relacji usuwa jej cache przez FK, bez zmiany lokalnych sum źródła.

Źródło ma status `ready`, `syncing`, `unsupported`, `relay`, `stale` lub `offline`.
Relayed home wymaga bezpośredniego połączenia do synchronizacji statystyk;
starszy partner wymaga obsługi `usage_stats_v1`. `partial` sygnalizuje nieznany
koszt wybrany (brak kompletnego raportu i szacunku), brak pokrycia całego okna
albo niegotowe źródło, także po przerwaniu początkowego pobierania stron.
Wynik jest też częściowy, gdy filtr aktywności lub bota pomija nieprzypisane
zużycie. Zsumowane źródła nie zawierają duplikatów
pochodzących z luster ani pośredników.
