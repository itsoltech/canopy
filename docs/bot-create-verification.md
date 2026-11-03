# Tworzenie botów — decyzje i weryfikacja

Gałąź `feat/bot-create-bot`. Implementacja tworzenia bota przez wbudowane narzędzie
Canopy, bez push i PR. Scalono `main` do `8b8e3ad0ee2280ed9ae153244869fdef03461b73`,
w tym rutyny i poprawkę pozycjonowania kontrolek czatu.

## Decyzje

`create_bot` wymaga tylko nazwy. Provider, instancja, model, effort i polityka
dziedziczą ustawienia twórcy; wygląd losowany jest z zestawu wizarda. Instrukcje
nowego bota są osobną personą, bez kopiowania instrukcji twórcy. Prompt wymaga
intencji człowieka i sprawdzenia modeli przez `list_models`.

Każde tworzenie wymaga zgody. Karta pokazuje maskotkę, nazwę, model, effort,
instancję, politykę, instrukcje i informację o kosztach. Człowiek może zatwierdzić
także politykę łagodniejszą od polityki twórcy. Snapshot konfiguracji jest trwały;
restart nie zmienia propozycji ani losowego wyglądu. Zapis bota, pochodzenia i wyniku
narzędzia jest atomowy. Odmowa nie tworzy bota, replay nie tworzy duplikatu.

RPC i narzędzie współdzielą walidację oraz zapis. Nowy bot wymaga modelu z katalogu
API instancji albo jawnego custom model. Limit właściciela: 50 nieusuniętych botów,
łącznie z archiwum. Blokada właściciela serializuje limit i nazwy porównywane po
NFC/lowercase jak w wizardzie. Retry już wykonanego request ID działa także przy
limicie. Obowiązuje dotychczasowy limit hops.

Migracja **0040** dodaje snapshot propozycji i pochodzenie; kontrakt używa pól
**600–601**. Nowy bot ma pustą rozmowę, pojawia się przez istniejący stream listy
i jest dostępny dla `send_bot_message`. Ustawienia pokazują „Created by ‹bot›”.

## UI i pass componentize

Zastosowano skille `design`, `transitions-dev` oraz osobny pass `componentize`
przed końcowym commitem. `CreateBotPreview.svelte` izoluje podgląd od wspólnej karty,
przyjmuje `class`, używa istniejącego `BotAvatar` i listy metadanych. Kontrolki i
animacje pochodzą ze wspólnego zestawu UI; respektowany jest reduced motion.
Instrukcje mają przewijany obszar z fokusem klawiatury (maks. 192 px).
Nie dodano web UI testów ani plików `*.browser.test.ts`.

## Commity

| Commit | Zakres |
|---|---|
| `04c1419` | Trwałe tworzenie, zgody, defaults, walidacja, limit, migracja i integracje |
| `f4e48d4` | Podgląd karty z maskotką, personą i metadanymi; pochodzenie w ustawieniach |
| `a026309`, `a367dcb` | Scalenia main; zachowanie rutyn i ich panelu |
| `eee8c23` | Oczekiwanie na katalog API w fixture routines/live i doprecyzowanie dokumentacji |

Końcowy commit dokumentacyjny zawiera ten raport.

## Weryfikacja

`bun install`, `bun run typecheck`, `bun run gen:check` i
`bun run --filter @canopy/web build` zakończyły się powodzeniem. Po ostatnim
merge powtórzono typecheck i build: Svelte 0 błędów, 0 ostrzeżeń; build ma istniejące
ostrzeżenia rozmiaru chunka i NO_COLOR/FORCE_COLOR.

Końcowy zakres integracji uruchomiono przez:

```sh
bun run check:tmp tests/integration/bots-create.test.ts tests/integration/bot-platform-tools.test.ts tests/integration/bots-settings.test.ts tests/integration/bots.test.ts tests/integration/bot-routines.test.ts packages/db/test/schema.test.ts
```

**82 pass, 0 fail, 696 asercji**, 6 plików, 153,42 s;
`check:tmp: nothing left in the temp dir`.
[Log końcowy](/tmp/canopy-create-verification-final.log).
Pięć integracji tworzenia obejmuje requested config, owner scope, pustą rozmowę,
restart przed zgodą, replay po action commit, rollback przed zapisem wyniku,
defaults i snapshot, odmowę, guard zgody, czytelne błędy modeli/effort/nazw Unicode,
kontakt z nowym botem, hops, wyścig RPC/tool przy limicie i idempotentny retry.
Pozostałe pliki sprawdzają zgodność istniejących narzędzi, ustawień, rozmów, rutyn
i schematu bazy. Fixture routines czeka na asynchroniczny katalog API przed CreateBot.

Live CLIProxyAPI (sekrety wyłącznie z lokalnego env):

```sh
OA_LIVE=1 bun --env-file=/home/nix/.config/open-agents/dev-live.env test tests/integration/bots-create.live.test.ts
```

**1 pass, 0 fail, 7 asercji**. Prawdziwy `gpt-6.1-sol` sprawdził modele, zaproponował
bota odpowiadającego haiku, po zgodzie utworzył go z pustą rozmową, a dziecko na
pytanie odpowiedziało trzema wersami. [Log live](/tmp/canopy-create-final-live.log).
Test sprawdza rzeczywistą inferencję Codex/CLIProxyAPI; nie sprawdza dostawcy Claude.

## Oględziny Chromium

`/usr/bin/chromium`, Playwright Core z `/tmp/ro-shot/node_modules/playwright-core`,
nagłówek `x-forwarded-proto: http`. Własny tymczasowy gateway/PostgreSQL i web na
**5286**, z deterministycznym modelem do UI; osobno powyższy live z prawdziwym modelem.
Nie używano `/tmp/oa-stack` ani portów 17443/5180/8444. Helpery i zrzuty są poza repo.

Zgoda kliknięta w przeglądarce utworzyła bota widocznego w sidebarze bez refresh.
Sprawdzono pustą rozmowę i pochodzenie w ustawieniach. Jasny/ciemny motyw przy
1440/390 px: brak poziomego przepełnienia i błędów JavaScript. Instrukcje przewijają
się w polu 192 px (pełna treść 480 px desktop / 648 px telefon).

| Stan | Jasny | Ciemny |
|---|---|---|
| Karta 1440 px | [PNG](/tmp/canopy-create-screenshots/approval-light-1440.png) | [PNG](/tmp/canopy-create-screenshots/approval-dark-1440.png) |
| Karta 390 px | [PNG](/tmp/canopy-create-screenshots/approval-light-390.png) | [PNG](/tmp/canopy-create-screenshots/approval-dark-390.png) |
| Sidebar po utworzeniu | [PNG](/tmp/canopy-create-screenshots/created-sidebar-light-1440.png) | [PNG](/tmp/canopy-create-screenshots/created-sidebar-dark-1440.png) |
| Pusta rozmowa 390 px | [PNG](/tmp/canopy-create-screenshots/child-empty-light-390.png) | [PNG](/tmp/canopy-create-screenshots/child-empty-dark-390.png) |

[Pochodzenie w ustawieniach](/tmp/canopy-create-screenshots/child-provenance-dark-1440.png).
[Pomiary](/tmp/canopy-create-screenshots/observations.json).
Pliki w `/tmp` są lokalnym, nietrwałym dowodem i nie są częścią repozytorium.
Po weryfikacji zatrzymano własny stos i zamknięto własną kartę preview.

## Ograniczenia

`update_bot` pozostaje osobnym follow-up: wymaga kontroli twórcy i nowego podglądu
zgody dla edycji. Samo pochodzenie nie nadaje uprawnienia do modyfikacji innych botów.
Nie uruchamiano pełnego zestawu testów repo ani web UI suite. Brak blokujących pytań.
