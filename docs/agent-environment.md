# Środowisko agentów

Projekt: 2026-11-04. Settings → **Agent environment** zarządza oczekiwanym stanem
instrukcji, umiejętności i pluginów na komputerach właściciela. Ustawienia należą
do bazy gatewaya; użytkownik nie konfiguruje zmiennych środowiskowych ani plików
usług. Etap 1 obejmuje instrukcje Claude/Codex i tagi. Pozostałe etapy poniżej są
projektem, nie deklaracją działającej funkcji.

## Badanie źródeł i wersji

Odczyt publicznej dokumentacji oraz lokalnych `--help`/`--version`, bez instalacji,
logowania, uruchamiania sesji ani zmian w prawdziwych domach CLI:

| Harness | Wykrywanie i źródła | Potwierdzenie na tej maszynie |
| --- | --- | --- |
| Claude Code | Globalne `~/.claude/CLAUDE.md`; projektowe `CLAUDE.md`, `.claude/CLAUDE.md`, lokalne `CLAUDE.local.md`; katalogi nadrzędne i reguły projektu. Skille: `~/.claude/skills/<name>/SKILL.md`, `.claude/skills`, pluginowe `skills/`. [Instrukcje](https://code.claude.com/docs/en/memory.md), [skille](https://code.claude.com/docs/en/skills.md). | CLI **2.1.308**; SDK repo **0.3.316**, nie utożsamiamy wersji biblioteki i urządzenia. `--plugin-dir`, `plugin install/update/uninstall`, `plugin marketplace add/list/update/remove`. |
| Claude plugins | Manifest `.claude-plugin/plugin.json`, katalog `.claude-plugin/marketplace.json`, cache pod `~/.claude/plugins`; plugin może zawierać skille, agentów, hooks, MCP, LSP i wykonywalne skrypty. [Manifest](https://code.claude.com/docs/en/plugins-reference.md), [hosting](https://code.claude.com/docs/en/plugins/host-marketplace.md). | `claude plugin install <plugin>@<marketplace> --scope user`; nowsze źródła command/headersHelper wymagają osobnej akceptacji komendy. Canopy nie będzie ich automatycznie akceptować. |
| Codex | `$CODEX_HOME/AGENTS.override.md` ma pierwszeństwo przed `AGENTS.md`; domyślnie `~/.codex`. Projekt: od korzenia do cwd, jeden plik per katalog; budżet domyślnie 32 KiB. Aktualne user skills: `~/.agents/skills`, repo `.agents/skills`, admin `/etc/codex/skills`; starsze instalacje mogą używać `$CODEX_HOME/skills`. [Instrukcje](https://developers.openai.com/codex/agent-configuration/agents-md), [skille](https://developers.openai.com/codex/skills/). | CLI i generowany protokół **0.164.0**. W repo istnieją `skills/list`, `plugin/list`, `app/list`. Sama zmiana `CODEX_HOME` nie izoluje `~/.agents/skills`; późniejszy etap musi jawnie sterować źródłami skilli. |
| Codex plugins | Są wspierane: [oficjalny opis](https://developers.openai.com/codex/plugins/). Traktujemy manifest/cache jako format konkretnej wersji, nie kopiujemy konfiguracji Claude w ciemno. | `codex plugin add PLUGIN@MARKETPLACE --json`, `remove`, `list`; `plugin marketplace add/list/upgrade/remove`. Aktualizacja snapshotu marketplace i wybór wersji pluginu to osobne kroki. |
| Otwarty skills CLI | `npx skills add owner/repo`, URL repo/tree, ścieżka repo; domyślnie instalacja projektowa, `-g` globalna, `--skill`, `--agent`, `--copy`. Codex → `~/.agents/skills`, Claude → `~/.claude/skills`, Grok → `~/.grok/skills`. `check`, `update`, `remove`, lockfile i kopia kanoniczna. [README](https://github.com/vercel-labs/skills), [komendy](https://github.com/vercel-labs/skills/blob/main/docs/commands.md), [cele](https://github.com/vercel-labs/skills/blob/main/docs/agents.md), [katalog](https://skills.sh), [specyfikacja](https://agentskills.io/specification). | Nie uruchamiano `npx`: nawet pomoc mogłaby pobrać kod. Źródła przeczytano przez HTTPS. CLI wymaga dziś Node ≥22.20; przepis musi przypinać również wersję narzędzia. |
| Grok Build | `~/.grok/skills`, projekt `.grok/skills`, pluginowe `skills/`, dodatkowe ścieżki konfiguracji; pluginy `~/.grok/plugins`, marketplace pod `plugins/marketplaces`. Kompatybilność z Claude i `~/.agents/skills`. [Dokumentacja producenta](https://docs.x.ai/build/features/skills-plugins-marketplaces.md), [reguły projektu](https://docs.x.ai/build/features/project-rules). | **1.0.70**. `grok plugin install/update/enable/disable`, `marketplace`, `--rules`; brak założenia o identyczności formatu konfiguracji z Claude. Obsługa instrukcji Grok jest późniejszym adapterem. |

Grok używa globalnego `~/.grok/AGENTS.md` (obsługuje także warianty `Agents.md`,
`AGENT.md`, `CLAUDE.md`, `Claude.md`, `CLAUDE.local.md` i katalogi reguł
`.grok/rules`, `.claude/rules`, `.cursor/rules`). [Discovery](https://docs.x.ai/build/features/project-rules.md)
zaczyna od `~/.grok`, następnie przechodzi od repo root do cwd. `--rules` dopisuje
reguły sesji; `grok inspect` pokazuje wykryte pliki. Późniejszy adapter Canopy wybiera
jednoznaczny `AGENTS.md` w rzeczywistym domu Groka i zachowuje taki sam limit Canopy,
mimo że Grok deklaruje brak własnego limitu wielkości pliku.

Dokumentacja online opisuje stan aktualny, więc nie dowodzi obsługi każdej nowej
opcji w przypiętym CLI. Każdy adapter negocjuje capability i wersję. Pomoc CLI
potwierdza powierzchnię komend, a nie poprawność instalacji na każdym OS.

### Domy platformy

Canopy już używa `<data_dir>/claude-home`, `<data_dir>/codex-home` oraz
`<data_dir>/homes/<harness>-<instance>` lub jawnego `shadow_home_path`.
`home_path` jest źródłem logowania, niekoniecznie miejscem działania wątku.
Patrz [worker-config.md](worker-config.md#94-na-workerze).

Instrukcja platformy trafia do **każdego faktycznego domu instancji**. Użytkownik
może osobno włączyć ten sam dokument dla CLI urządzenia. UI pokazuje pełne
ścieżki oraz status każdego celu. Nie kopiujemy auth, settings, hooks ani MCP
użytkownika. Claude zachowuje `settingSources: ["project", "local"]`; zarządzane
instrukcje platformy są jawnie dopisywane do system promptu, bez włączania user
settings. Codex czyta `AGENTS.md` z własnego `CODEX_HOME`; obecność
`AGENTS.override.md` powoduje widoczny stan blokady zamiast pozornego sukcesu.
Zmiana dotyczy nowych sesji harnessu; już rozpoczęta sesja może mieć wcześniejszy
prompt. UI nie obiecuje zmiany pamięci już działającego modelu.

## Biblioteka i przypisania

Gateway przechowuje bibliotekę **owner-scoped**, identyfikatory UUID, rosnące
rewizje, niezmienne wersje i audyt bez treści. Element ma nazwę, rodzaj, harnessy,
źródło, przypiętą wersję, digest i politykę aktualizacji. Rodzaje:

1. **Instruction document**: uporządkowane fragmenty i osobne przypisanie dokumentu.
2. **Skill**: katalog `SKILL.md` + pliki; upload folderu/zip, repo + ścieżka + commit,
   kompatybilne referencje `owner/repo[/path]`, albo skill pochodzący z pluginu.
3. **Plugin**: manifest i komplet plików z Claude/Codex marketplace, później Grok.

Automatyczne tagi mają prefiksy `os:`, `arch:`, `hostname:`, `kind:` i `cli:`.
OS pochodzi z raportu workera (`win32` normalizowany do `windows`, `darwin` do
`macos`), CLI z faktycznej dostępności. `kind:desktop` oznacza proces uruchomiony
przez desktop Canopy, `kind:server` pozostałe; nie zgadujemy po obecności GUI.
Ręczne tagi nie mogą podszywać się pod prefiksy automatyczne. Limity: 32 ręczne
tagi, 64 znaki/tag, małe litery i cyfry z `._-`.

Selektor: wszyscy **lub** konkretne workery **lub** tagi (dowolny/każdy);
wykluczone tagi mają zawsze pierwszeństwo. Brak selektora fragmentu oznacza
dziedziczenie z dokumentu; pusty jawny selektor nie pasuje do nikogo.
Fragment z `os:windows` nie trafia na `os:linux`. Kolejność jest jawna:
dokumenty według czasu utworzenia i ID, w dokumencie fragmenty w kolejności
listy, na końcu jego dodatek maszyny. Nadpisanie maszyny może wyłączyć cały
dokument albo dodać tekst. Żaden selector nie rozszerza zakresu właściciela.

## Kompozycja i doświadczenie użytkownika

Settings → Agent environment: **Library** z edytorem dokumentów/fragmentów,
**Computers** z tagami i stanem synchronizacji. Wybór maszyny pokazuje żywy
podgląd per `CLAUDE.md` / `AGENTS.md`, fragmenty źródłowe i aktualne cele plików.
Podgląd niezapisanego dokumentu liczy ten sam kompozytor gatewaya; nie zapisuje
ani nie wysyła go workerowi. Zapis dokumentu jest jawnym zleceniem synchronizacji
na przypisane maszyny, także obecnie offline.

Wybieramy blok:

```markdown
<!-- canopy:agent-environment:begin -->
…złożona treść…
<!-- canopy:agent-environment:end -->
```

Cały plik nie może być własnością Canopy: istniejący globalny dokument może
zawierać prywatne instrukcje. Bajty przed/za blokiem zostają bez zmian i nie
są raportowane gatewayowi. Edycja poza blokiem nie powoduje konfliktu. Duplikaty,
niekompletne znaczniki i obcy istniejący blok oznaczają drift, nie przyzwolenie
na przejęcie pliku. Treść biblioteki nie może zawierać znaczników Canopy.

Drift pokazuje tekst ostatnio zaobserwowanego **bloku** obok oczekiwanego i wybór:

- **Keep mine**: zachowaj lokalny blok; stan „Kept locally”, bez automatycznego
  nadpisania. Zmiana oczekiwanej treści lub pliku ponownie wymaga decyzji.
- **Overwrite**: zastosuj aktualny stan biblioteki tylko jeśli pełny checksum
  pliku wciąż odpowiada temu, który właściciel oglądał.
- **Import into library**: nowy dokument z lokalnego bloku, przypisany tylko
  tej maszynie; zastępuje jej efektywną kompozycję dla tego harnessu, nie
  rozsyła lokalnych instrukcji na inne OS. Następnie synchronizacja.

Przy usuniętych/uszkodzonych znacznikach import jest niedostępny: nie umiemy
oddzielić prywatnej treści od zarządzanej. Overwrite nie kasuje tekstu poza
poprawnie rozpoznanym blokiem. Użytkownik dostaje konflikt, jeśli plik zmienił
się od podglądu; stare kliknięcie nigdy nie zatwierdza nowej zawartości.

## Synchronizacja oczekiwanego stanu

Capability `agent_environment_v1`; nowe pola protokołu są addytywne, bez zmiany
`WORKER_LINK_PROTOCOL`. Starszy worker pokazuje „Update this worker”, nie dostaje
instrukcji ani rozstrzygnięć. Gateway wysyła pełny aktualny stan po połączeniu,
zmianie biblioteki/tagów i zmianie konfiguracji instancji. Offline worker dostaje
najnowszy stan przy reconnect, bez odtwarzania starych komend.

Worker serializuje reconcile, porównuje SHA-256 i utrzymuje prywatny dziennik
własności pod `data_dir`. Zapis: nowy plik w tym samym katalogu, fsync, ponowne
sprawdzenie poprzednich bajtów i rename; błędy przed rename zostawiają stary plik.
Reconcile jest idempotentny. Stan każdego celu: applied / drift / kept / error;
raport zawiera ścieżkę, harness, checksum oczekiwany/zaobserwowany i rewizję.
Niepoprawny cel nie blokuje pozostałych. Usunięcie czyści tylko nienaruszony blok
Canopy, zachowuje plik i resztę treści. Drift nigdy nie jest automatycznie usuwany.
Zmiana katalogu instancji sprząta dotychczasowy zarządzany cel tymi samymi regułami.
Worker skanuje zarządzane pliki co 15 s oraz po otrzymaniu stanu; „Refresh status”
odczytuje ostatni raport z gatewaya. Status ostatniego raportu
jest trwały w DB. Błąd lub brak raportu nie jest pokazywany jako sukces.

Rollback obejmuje błąd zapisu dziennika po zmianie pliku i nie nadpisuje późniejszej
lokalnej edycji. Nagłe przerwanie procesu między rename a zapisem dziennika może
pozostawić nieznany blok: po restarcie wymaga decyzji drift, zamiast automatycznego
przejęcia. Nie obiecujemy transakcji wieloplikowej. Przekroczenie limitu kompozycji
po wykryciu nowych tagów zatrzymuje wysyłkę dla tej maszyny z widocznym błędem;
ostatnie pliki pozostają bez zmian, połączenie workera działa dalej.

Dla umiejętności/pluginów analogiczny manifest własności obejmuje ścieżki i
checksum każdego pliku. Rozpakowanie do prywatnego stagingu, kontrola manifestu,
atomowa zamiana wersjonowanego katalogu i wskaźnika, poprzednia wersja do rollbacku.
Nie usuwamy plików odkrytych poza manifestem ani lokalnych zmian.

## Źródła, pole komendy i aktualizacje (późniejsze etapy)

Pole **Add from command or source** rozpoznaje zamkniętą gramatykę:
`npx skills add owner/repo [--skill name]`, referencję repo/ścieżki oraz
`plugin@marketplace` z jawnym wyborem harnessu. Nie uruchamia wklejonego shella,
podstawień, potoków, separatorów, flag env ani dowolnych argumentów. Pokazuje
rozpoznane repo, wybrane skille, commit, pliki, licencję i przypisania. Dopiero
**Add and sync** upoważnia do instalacji przypiętej wersji. Pobranie katalogu
źródła nie uruchamia jego kodu.

Preferowany skill resolver pobiera niezmienny artefakt w gateway, zgodny z
formatami `skills`, zamiast `npx` na każdym workerze. Gdy potrzebny jest CLI,
stosuje przypięte stałe argv i prywatny HOME/staging, jak
[przepisy provider-cli](provider-cli.md). CLI nie dostaje auth Canopy ani
sekretów connectorów. Marketplace command sources i instalatory z hooks nie
wchodzą do automatycznego przepisu; wymagają osobnego jawnego działania.

Gateway sprawdza upstream git ref/npm/marketplace w cache, pokazuje **Update
available**, commit/wersję, source i diff. Domyślnie aktualizacja ręczna;
auto-update jest osobną zgodą **per element**, dla zatwierdzonego źródła i zakresu
wersji. Zmiana źródła, uprawnień, hooks lub nowy wykonywalny komponent wymaga
ponownego działania właściciela. Niedostępny upstream zostawia bieżącą wersję.

## Bezpieczeństwo, Docker i połączone komputery

Każde CRUD, preview, tag i resolution filtruje po właścicielu w gateway.
Współdzielony worker nie dostaje prywatnego globalnego środowiska żadnego z
użytkowników: globalny plik OS nie daje izolacji per wątek. Skill to kod wykonywalny;
właściciel zatwierdza źródło i aktualizacje. Brak sekretów w instrukcjach/paczkach,
auth i connector grants nigdy nie należą do synchronizowanej biblioteki.

Limity projektu: 100 dokumentów/właściciela, 64 fragmenty/dokument, 24 KiB
wynikowej instrukcji/harness/worker, 256 KiB czytanego pliku. Budżet Codexa
obejmuje też projektowe instrukcje, więc UI pokazuje wielkość podglądu. Upload
później: 10 MiB archiwum, 25 MiB po rozpakowaniu, 1000 plików, 1 MiB/plik;
odrzucamy symlinki, urządzenia, ścieżki absolutne, `..`, case-collisions i zip bombs.
HTTPS, limity redirectów, zakaz metadata/link-local i poświadczeń w URL.

Docker worker synchronizuje do **własnego wolumenu**, nie domu hosta. Read-only
volume daje widoczny błąd. Kod pluginu/skilla nie instaluje zależności OS; zmiana
obrazu to jawna czynność właściciela. Na Windows stosujemy copy/rename bez wymogu
uprawnień do symlinków, a ochronę dostępu zapewnia ACL użytkownika workera.

[Shared config etap 4](linked-computers.md#konkretny-protokół-etapu-4) będzie
rozszerzony opt-in o `environment:<uuid>`: wspólna definicja + niezmienne wersje
artefaktów, istniejące wektory i konflikty, capability po obu stronach. Przypisania
do workerów, tagi, ścieżki, drift i zgody instalacyjne zostają lokalne. Otrzymanie
wspólnego elementu nie jest zgodą na wykonanie kodu na maszynach odbiorcy.
Etap 1 nie udostępnia biblioteki między gatewayami.

## Plan stosu

1. **Instrukcje i maszyny** (`feat/agent-environment-1`): dokumenty/fragmenty,
   selektory, tagi, per-machine overrides, preview, managed blocks, drift/resolution,
   status i temp-HOME integration. Pełna samodzielna funkcja bez instalacji kodu.
2. **Umiejętności**: bezpieczny upload folder/zip, wersje i manifesty własności,
   synchronizacja do rzeczywistych domów, usuwanie i rollback; również Grok adapter.
3. **Źródła i utrzymanie**: git/skills.sh refs, parser komendy, update tracking,
   ręczne/opt-in automatyczne aktualizacje z diff i zamrożonymi artefaktami.
4. **Marketplace i współdzielenie**: Claude/Codex plugins, capability/version-aware
   recipes, przegląd komponentów wykonywalnych, opt-in linked-computer library.

Każdy etap jest osobną gałęzią opartą o poprzednią. Przy publikacji przez
maintainera: stacked draft PR, dolny do `dev`; gotowy i zweryfikowany cały stos
scala się razem squash. To zlecenie nie obejmuje push ani otwierania PR.

## Kontrakt realizacji

`workflow_mode: autonomous-planned`, `mode_source: explicit-user-task-instruction`,
`decision_authority: delegated`, `scope: current-task`,
`artifact_state: ready-for-execution`, `execution_mode: inline`.
Zlecono projekt i implementację etapu 1 jako subagent, z samodzielnym doborem
odwracalnych szczegółów. Protected constraints: bez push/PR, produkcji, prawdziwych
domów CLI w testach, portów stosu maintainera, zmian Tailscale i instalacji kodu
upstream. Kryterium: etap 1 end to end, owner scoping, zgodność ze starszym workerem,
testy meaningful integration, wymagane sprawdzenia oraz kontrola UI light/dark
desktop/phone. Dowody trafiają do `agent-environment-verification.md`.
