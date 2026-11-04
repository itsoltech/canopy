# Środowisko agentów

Projekt: 2026-11-04. Settings → **Agent environment** zarządza oczekiwanym stanem
instrukcji, umiejętności i pluginów na komputerach właściciela. Ustawienia należą
do bazy gatewaya; użytkownik nie konfiguruje zmiennych środowiskowych ani plików
usług. Etapy 1–4 obejmują instrukcje Claude/Codex, tagi, upload i synchronizację
skilli Claude/Codex/Grok, źródła Git/skills.sh oraz marketplace i pluginy
Claude/Codex z przypiętymi wersjami. Współdzielenie biblioteki między gatewayami
pozostaje osobnym, późniejszym zakresem; nie należy do zleconego etapu 4.

## Dodawanie i edycja w interfejsie

Biblioteki pokazują dwuwierszowe pozycje: nazwa, mały status i ikonowe akcje
w pierwszej linii; harnessy, wersja, liczba plików, skrócone źródło i polityka
aktualizacji w drugiej. Nazwy i metadane są przycinane z tooltipem pełnej treści.
Przypisanie ma jeden skrót: „All computers” albo liczba komputerów; tooltip
zawiera pełną listę i tagi. Usuwanie wymaga wyboru akcji z menu wiersza.
Marketplace i jego pluginy używają tego samego układu.
Dodawanie oraz edycja otwierają wspólny panel krokowy
oparty o kitowy `Dialog`: na telefonie pełnoekranowy, na większym ekranie modalny.
Nagłówek pokazuje postęp, a stała stopka udostępnia Back/Next i końcowe potwierdzenie.
Puste biblioteki mają przycisk pierwszego dodania; formularze nie pojawiają się
w treści strony. Puste katalogi nie tworzą disclosures.

Instrukcje przechodzą przez zapis fragmentów, przypisanie i istniejący podgląd
wyniku dla komputera. Skill zaczyna się od wyboru źródła: folder/ZIP albo Git
i wklejona komenda `npx skills add`. Dalej są przegląd plików oraz przypisanie.
Źródła zachowują wybór połączonego konta, a edycja skilla — wersje, pin,
auto-update i nadpisania maszyn. Podgląd ZIP informuje, że gateway rozpakowuje
i waliduje archiwum przy zapisie; przegląd poszczególnych plików przed zapisem
wymaga folderu. Przy rollbacku UI oznacza, że wyświetla pliki obecnie przypisanej
wersji, a zapis przywróci wybraną wersję z biblioteki.

Marketplace ma wybór źródła i zamrożony podgląd katalogu. Plugin ma przegląd
kodu/diff, przypisanie oraz osobne, domyślnie niezaznaczone potwierdzenie checksumu.
Check upstream także otwiera panel. Dotychczasowe porównania i rozwiązywanie driftu
pozostają przy statusie komputera. Błędy walidacji i zapisu są widoczne w panelu.

Po udanym zapisie panel zamyka się, lista przewija do elementu, przenosi fokus
i krótko wyróżnia jego wiersz. Dodanie fragmentu również przewija i ustawia fokus.
Przejścia korzystają z tokenów ruchu; reduced motion wyłącza ruch przewijania
i animowane wyróżnienie.

## Badanie źródeł i wersji

Odczyt publicznej dokumentacji oraz lokalnych `--help`/`--version`, bez instalacji,
logowania, uruchamiania sesji ani zmian w prawdziwych domach CLI:

| Harness | Wykrywanie i źródła | Potwierdzenie na tej maszynie |
| --- | --- | --- |
| Claude Code | Globalne `~/.claude/CLAUDE.md`; projektowe `CLAUDE.md`, `.claude/CLAUDE.md`, lokalne `CLAUDE.local.md`; katalogi nadrzędne i reguły projektu. Skille: `~/.claude/skills/<name>/SKILL.md`, `.claude/skills`, pluginowe `skills/`. [Instrukcje](https://code.claude.com/docs/en/memory.md), [skille](https://code.claude.com/docs/en/skills.md). | CLI **2.1.308**; SDK repo **0.3.316**, nie utożsamiamy wersji biblioteki i urządzenia. `--plugin-dir`, `plugin install/update/uninstall`, `plugin marketplace add/list/update/remove`. |
| Claude plugins | Manifest `.claude-plugin/plugin.json`, katalog `.claude-plugin/marketplace.json`, cache pod `~/.claude/plugins`; plugin może zawierać skille, agentów, hooks, MCP, LSP i wykonywalne skrypty. [Manifest](https://code.claude.com/docs/en/plugins-reference.md), [hosting](https://code.claude.com/docs/en/plugins/host-marketplace.md). | `claude plugin install <plugin>@<marketplace> --scope user`; nowsze źródła command/headersHelper wymagają osobnej akceptacji komendy. Canopy nie będzie ich automatycznie akceptować. |
| Codex | `$CODEX_HOME/AGENTS.override.md` ma pierwszeństwo przed `AGENTS.md`; domyślnie `~/.codex`. Projekt: od korzenia do cwd, jeden plik per katalog; budżet domyślnie 32 KiB. Aktualne user skills: `~/.agents/skills`, repo `.agents/skills`, admin `/etc/codex/skills`; CLI obsługuje także `$CODEX_HOME/skills`. [Instrukcje](https://developers.openai.com/codex/agent-configuration/agents-md), [skille](https://developers.openai.com/codex/skills/). | CLI i generowany protokół **0.164.0**. W repo istnieją `skills/list`, `plugin/list`, `app/list`. Sama zmiana `CODEX_HOME` nie izoluje `~/.agents/skills`; etap 2 rozdziela te cele i opisuje współdzielone wykrywanie user skills. |
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

Własne tagi workera ustawia się w **Settings → Workers**: w pierwszym kroku
**Add worker** oraz w szczegółach każdej maszyny (**Manual tags**). Ten sam
współdzielony picker podpowiada ręczne tagi użyte przez workery właściciela.
Automatyczne tagi są tylko do odczytu. Agent environment pokazuje oba rodzaje
tagów tylko do odczytu z odnośnikiem **Edit in Workers**; nadal pozwala wybierać
tagi w selektorach przypisań. Zmiana tagów używa dotychczasowego
`SetEnvironmentTags`, kontroli rewizji i audytu `environment.tags.save`,
po czym przelicza instrukcje, skille i pluginy, także dla workera offline.
Zmiana tagów w innej sesji zachowuje lokalny szkic i wymaga przeładowania przed
zapisem. Workery połączonego komputera konfiguruje się w jego macierzystym
Workers; lokalne RPC nie modyfikuje zdalnych ani cudzych workerów.

Tagi z kreatora są walidowane i zapisane po stronie gatewaya w owner-scoped
`worker_enrollments.tags` (migracja `0064_worker_enrollment_tags`). Nie trafiają
do tokenu, komendy instalacji ani hosta SSH. Każda ścieżka instalacji przekazuje
je przy tworzeniu zaproszenia; wymiana tokenu atomowo zapisuje je do
`worker_environments.manual_tags` wraz z workerem i audytem. Pierwszy Hello
uzupełnia automatyczne fakty, zachowuje ręczne tagi i od razu uzgadnia przypisania.

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

Przypisania instrukcji i skilli używają wspólnego tag pickera: wielokrotny wybór
w comboboxie kitu, usuwalne chipy, automatyczne/ręczne tagi z liczbą komputerów
i tworzenie nowego ręcznego tagu inline. Utworzenie tagu w selektorze nie przypisuje
go automatycznie komputerom. Żywe „Applies to N computers: …” używa tej samej
funkcji selektora co gateway, uwzględnia wyłączenia maszyn oraz przecięcie fragmentu
z przypisaniem dokumentu. Licznik obejmuje również komputery offline.

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

## Umiejętności — konkretny protokół etapu 2

`SaveLibrarySkill` przyjmuje `LibrarySkill`, bieżącą `expected_revision` oraz
alternatywnie listę `SkillFile` z uploadu folderu lub bajty ZIP. `SKILL.md` musi
leżeć w korzeniu skilla i mieć poprawny YAML z `name` oraz `description`.
ZIP może zawierać jeden wspólny katalog nadrzędny. Gateway sprawdza nagłówki,
CRC, rozmiary i metadane ZIP przed zapisem; nie uruchamia kodu ani instalatora.
Odrzuca linki, specjalne typy plików, traversal, ścieżki absolutne, nazwy Windows,
kolizje wielkości liter (także katalogów), konflikty plik/katalog i zip bombs.

Migracja `0058_agent_skills` dodaje owner-scoped definicje i niezmienne artefakty
wersji. `SkillArtifact` zawiera nazwę folderu, opis, SHA-256 manifestu oraz pliki
z SHA-256 i flagą executable. Upload tworzy kolejny numer wersji; wybór wcześniejszej
wersji wykonuje rollback bez mutowania historii. Selektory są takie jak dla
instrukcji. `SkillMachineOverride` wyłącza element lub przypina wersję; `version=0`
dziedziczy wybraną wersję biblioteki. Gateway odrzuca kolizje celów i ponad 25 MiB
artefaktów przypisanych jednej maszynie. Limit biblioteki: 100 skilli/właściciela.

Capability `agent_skills_v1` rozszerza istniejący `AgentEnvironmentDesired`:
`skills=4` przenosi pełne wybrane artefakty, `skill_resolutions=5` jednorazowe
decyzje. `AgentEnvironmentReport.skills=3` zawiera status każdego elementu/celu:
ID, harness, ścieżkę, zakres, wersję, applied/drift/kept/error/removed, checksum
oczekiwany i checksum całego katalogu jako token CAS. `managed_files` zawiera
wyłącznie zaobserwowane pliki z manifestu Canopy; `desired_files` dokładną
przypiętą wersję do porównania; `owned` odróżnia obcy katalog. Prywatne dodatki
nie opuszczają workera. Starszy worker z samym `agent_environment_v1` nadal
otrzymuje instrukcje, lecz nigdy skille ani ich resolutions. UI pokazuje osobno
`skills_supported`. Numer `WORKER_LINK_PROTOCOL` pozostaje bez zmian.

Duże konflikty w wielu domach współdzielą budżet 96 MiB zakodowanego raportu
porównań (gateway przyjmuje do 128 MiB). Kolejne cele zachowują pliki i pokazują
widoczny komunikat oczekiwania. Rozwiązanie wcześniejszych konfliktów zwalnia
budżet i udostępnia ich diff przy następnym reconcile; status nie znika przez
odrzucenie całego raportu.

Rzeczywiste cele (również każdy jawny shadow home / own-login instancji):

| Harness | CLI urządzenia | Sesje Canopy |
| --- | --- | --- |
| Claude | `<device CLAUDE_CONFIG_DIR>/skills/<name>` | `<actual isolated home>/canopy-environment/skills/<name>`; SDK ładuje ten lokalny plugin jawnie, nazwa `canopy-environment:<name>`, nadal `settingSources: ["project", "local"]` |
| Codex | `~/.agents/skills/<name>`, niezależnie od `CODEX_HOME` | `<actual CODEX_HOME>/skills/<name>` |
| Grok | `<device GROK_HOME>/skills/<name>` (domyślnie `~/.grok`) | `<actual durable home>/skills/<name>`; disposable process home ma link/junction do trwałego katalogu |

`CODEX_HOME` nie izoluje user skills w `~/.agents/skills`. Włączenie „Device CLI too”
może udostępnić te skille także innym zgodnym harnessom urządzenia. Canopy nie
kopiuje prywatnego katalogu user skills do platformy i nie modyfikuje cudzych skilli.
Zmiany dostępności dotyczą nowych sesji; testy nie uruchamiają płatnych modeli.
Adapter Claude odrzuca symlinki oraz dodatkowe komponenty obok `skills/` w korzeniu
lokalnego pluginu Canopy: nie aktywuje przypadkowych hooks, MCP ani manifestu,
których właściciel nie dodał przez bibliotekę skilli. Pozostawia te pliki na dysku
i blokuje start sesji z czytelnym błędem.

Worker utrzymuje trwały `data_dir/agent-environment/skills.json`: własność celu,
ścieżki, checksumy i bity executable, bez treści. Całe drzewo odczytuje z limitami
i kontrolą symlinków. Przy instalacji tworzy staging na tym samym filesystemie,
fsyncuje pliki, ponownie porównuje cały katalog i publikuje katalog przez rename.
Przenosi dawny katalog do backupu, sprawdza go ponownie i dopiero zapisuje manifest.
Błąd zapisu manifestu wycofuje niezmieniony zapis; journal pozwala odtworzyć stan
po przerwanym swapie. Zmienione staging/backup zostają do przeglądu i dają błąd.
Portable swap obejmuje dwa rename i krótkie okno braku ścieżki; nie jest transakcją
wielu celów. Awaria podczas stagingu przed zapisem journalu zachowuje staging
do ręcznego przeglądu zamiast ryzykować skasowanie lokalnych bajtów.

Aktualizacja/usunięcie dotyczy wyłącznie plików manifestu. Dodatki i puste katalogi
użytkownika pozostają; nowa wersja kolidująca z nimi daje widoczny błąd.
Canopy nigdy nie przejmuje istniejącego obcego folderu, nawet przez Overwrite.
`DeleteLibrarySkill` usuwa definicję, pozostawia niezmienne wersje i uzgadnia
usunięcie własnych plików. Edycja lokalna blokuje również usunięcie; decyzja jest
dostępna mimo usunięcia definicji. Offline worker dostaje najnowszy pełny stan.

`ResolveSkillDrift` przyjmuje worker/target ID, expected revision, obejrzany checksum
i keep/overwrite/import. Keep wiąże zachowanie plików z obserwowanym i oczekiwanym
stanem. Overwrite wymaga aktualnego CAS oraz własności Canopy. Import waliduje
zarządzane pliki, tworzy nową wersję i przypina ją **tylko tej maszynie**;
pozostałe zachowują wersje. Import nie obejmuje prywatnych dodatków. Rozstrzygnięcia
są jednorazowe; ponowna identyczna lokalna edycja wymaga nowej decyzji.

BFF: `/api/agent-environment/skills` (POST/DELETE), `/skills/resolve` (POST).
Foldery są kodowane base64 w JSON: produkcyjny web wymaga `BODY_SIZE_LIMIT=50M`
(domyślne 512K ani 25M nie wystarczy dla folderu 25 MiB); proxy także musi przepuścić
ten rozmiar. Upload ZIP pozostaje ograniczony do 10 MiB, pliki do 1 MiB,
1000 plików i 25 MiB po rozpakowaniu.

## Źródła — badanie etapu 3

Resolver oparto na odczycie kodu **skills 1.7.6**, commit
`9197d919034d19010ae303cf96bf19ad087dd4be`, bez uruchamiania `npx` ani kodu
repozytoriów. Źródła: [parser referencji](https://github.com/vercel-labs/skills/blob/9197d919034d19010ae303cf96bf19ad087dd4be/src/source-parser.ts),
[discovery](https://github.com/vercel-labs/skills/blob/9197d919034d19010ae303cf96bf19ad087dd4be/src/skills.ts),
[add i flagi](https://github.com/vercel-labs/skills/blob/9197d919034d19010ae303cf96bf19ad087dd4be/src/add.ts),
[skills.sh.json](https://github.com/vercel-labs/skills/blob/9197d919034d19010ae303cf96bf19ad087dd4be/src/skills-sh-config.ts),
[wyszukiwanie katalogu](https://github.com/vercel-labs/skills/blob/9197d919034d19010ae303cf96bf19ad087dd4be/src/find.ts).

CLI rozróżnia repo, subpath, GitHub tree ref, fragment `#ref@skill` i skrót
`owner/repo@skill`. Jedno repo może dostarczać wiele skilli. Root `SKILL.md` ma
pierwszeństwo; `--full-depth` rozszerza discovery. Typowe katalogi to `skills/`,
`.curated`, `.experimental`, `.system` i katalogi skills harnessów. Dodatkowe
kontenery deklaruje `skills.sh.json` przez `paths: ["./…"]`; istnieje ograniczony
fallback rekurencyjny. `metadata.internal: true` wymaga jawnej nazwy. Nazwa YAML,
a nie nazwa folderu, jest tożsamością skilla. [skills.sh](https://skills.sh) jest
katalogiem, nie paczką npm skilla; link owner/repo/skill weryfikujemy przez
`https://skills.sh/api/search?q=<name>`, a pliki zawsze pochodzą z Git.

Canopy obsługuje zgodny podzbiór referencji i flag, nie emuluje całego CLI.
Akceptuje `npx [-y] skills[@version] add …` (także a/install/i), `bunx`, `pnpx`,
`skills add`, bezpośredni URL HTTPS Git, GitHub shorthand/path/tree i skills.sh.
`--skill/-s` i `--agent/-a` przyjmują listę; harnessy: claude-code/claude, codex,
grok lub `*`. `--global/-g` sugeruje również Device CLI; `--copy`, `--yes/-y`,
`--all`, `--list/-l` dają informację i nigdy nie omijają potwierdzenia Canopy.
`--full-depth` rozszerza discovery. Wersja `skills@…` nie pobiera pakietu npm.
Nieznane flagi, shell, podstawienia, operatory, env, SSH, file, plain HTTP oraz
URL z poświadczeniami/query są odrzucane. Ref podajemy jako `#branch`, `#tag`
lub `#commit`, również przez GitHub `/tree/<ref>/path`. Ref z ukośnikiem można
podać po `#`; parser tree nie zgaduje granicy gałęzi zawierającej ukośnik.

## Źródła — konkretny protokół etapu 3

Pobieranie działa **w gateway**, który ma sieć, Git i zaszyfrowany magazyn
konektorów. Worker dostaje wyłącznie istniejący `SkillArtifact`, bez URL dostępu,
tokena i komendy instalacji. Git działa ze stałym argv, prywatnym tymczasowym
HOME/config, bez checkoutu, hooks, submodułów i credential helpers. Nie potrzeba
Node/npm ani `skills`. Publiczny DNS IPv4 jest sprawdzany i przypinany do
połączenia curl; adresy prywatne/link-local/metadata są odrzucane, proxy oraz
redirecty wyłączone. Git URL musi używać HTTPS. Fixture transport i registry
endpoint są wyłącznie opcjami startowymi testu, bez pól w RPC.

**Source access** wybiera istniejące połączone konto właściciela. Własny konektor
musi mieć ten sam origin co repo; oficjalny konektor GitHub z dokładnym endpointem
`https://api.githubcopilot.com/mcp/` może autoryzować wyłącznie `https://github.com`.
Gateway odszyfrowuje tylko Authorization/access token; Bearer GitHub zamienia na
Basic `x-access-token`. Nagłówek dostaje wyłącznie proces fetch przez środowiskową,
URL-scoped konfigurację Git; nie trafia do argv, pliku config, registry, logów,
artefaktu ani workera. Preview przechowuje ID konta, nie sekret. Add/apply ponownie
sprawdza właściciela, połączenie i host, więc odłączenie konta unieważnia zgodę
starego preview. Błędy Git są zastępowane stałymi komunikatami bez stderr.

Migracja `0059_agent_skill_sources` dodaje commit do niezmiennych wersji i trwałe,
owner-scoped preview. Addytywne UI RPC i BFF POST
`/api/agent-environment/skills/source/{preview,add,check,apply}`:

1. `PreviewSkillSource(command, credential_account_id)` parsuje referencję,
   rozwiązuje ref do SHA i zamraża pliki. Zwraca `SkillSourcePreview`: ID,
   repo/ref/commit, ścieżki i pełne artefakty skilli, licencję repo, notices,
   sugerowane harnessy/Device CLI, expiry. Nie zmienia biblioteki ani workerów.
   Panel **Add skill → Git repository or npx skills add command** pokazuje pliki i treść, wyróżnia scripts/hooks,
   executable, shebang oraz pliki interpretowane; właściciel wybiera skille
   i zwykłe przypisania przed **Add and sync**. Cache: 30 minut, do 5 preview/owner.
2. `AddSkillSource(preview_id, paths, assignment, expected_revision)` potwierdza
   dokładne zamrożone artefakty, nawet gdy upstream już się przesunął. Atomowo
   tworzy wybrane definicje i wersję 1; source policy zaczyna z manual update.
   Zwykła walidacja przypisań i reconcile pozostają jedyną ścieżką do workerów.
3. `CheckSkillSource(id)` ponownie pobiera zapisany ref i ścieżkę, porównuje
   tożsamość skilla, zapisuje czas/błąd, candidate SHA i ID preview. Zwraca też
   bazowy checksum; zapis metadanych zwiększa rewizję. UI odczytuje świeżą
   rewizję, pokazuje **Update available**, pliki added/modified/removed,
   script/executable oraz porównanie treści bieżącej i kandydata. Nowy commit
   bez zmiany plików jest widoczny jako zmiana samego upstream commit.
4. `ApplySkillSource(id, preview_id, expected_revision)` wymaga tego samego
   źródła/ref/ścieżki/konta, nazwy i bazowego checksum. Tworzy kolejny niezmienny
   numer wersji z SHA kandydata, usuwa wykorzystany preview i uzgadnia stan.
   Upload własnego folderu odłącza źródło. `SaveLibrarySkill` nie pozwala
   podmienić provenance: przyjmuje tylko auto-update/pin. Wybór wcześniejszej
   Library version zachowuje jej commit i automatycznie przypina element.

Gateway przy starcie i co minutę wybiera elementy wymagające sprawdzenia po
godzinie. Pin pauzuje okresowe sprawdzanie; Check upstream pozostaje dostępne.
Manual jest domyślny. Osobny opt-in **Automatic updates** per skill dopuszcza
zmiany dokumentacji/zasobów, ale zmiany skryptów lub bitów executable zawsze
pozostawia do ręcznego review. To heurystyka plików, nie analiza bezpieczeństwa
instrukcji; także SKILL.md może zmienić zachowanie agenta. Błąd upstream nie
zmienia zainstalowanego artefaktu. Definicje, wybrane SHA, błędy i kandydaci
przeżywają restart; po wygaśnięciu preview potrzebny jest kolejny check.
Rewizja oraz checksum blokują zapis na podstawie nieaktualnego przeglądu.

Limity repo: 5000 plików, 16 MiB/plik, 50 MiB zadeklarowanych blobów. Limity
wybranego preview: 100 skilli i łącznie 25 MiB, nadal 1 MiB/plik oraz walidacja
artefaktu etapu 2. Całe drzewo odrzuca symlinki, gitlink/submoduły, specjalne
wpisy i nieprzenośne ścieżki; nie wykonuje się filtrów repo. Fetch jest shallow,
stdout/stderr ograniczone, pojedynczy proces ma 60 s, całe resolution 120 s
(także oczekiwanie na DNS można anulować). Shallow fetch wymaga smart HTTP;
dumb HTTP jest odrzucany przed odczytem alternatywnych adresów obiektów.
Bundle URI, packfile URI i rekurencja submodułów są wyłączone.
Co 50 ms sprawdzany jest limit katalogu 64 MiB; próbkowanie może chwilowo go
przekroczyć, nie jest twardą quota filesystemu. Gateway rozwiązuje jedno źródło
naraz; kolejne żądanie dostaje błąd zajętości. Shutdown anuluje własną grupę
procesów Git i czeka na sprzątnięcie repo przed zamknięciem runtime bazy.
Nie uruchamiamy skryptów, instalatorów, hooks ani testów upstream.

Docker gateway zawiera Git; samodzielna binarka wymaga Git w PATH i CA na hoście.
Desktopowy BFF oraz Docker/compose/`.env.example` ustawiają `BODY_SIZE_LIMIT=50M`.
To tylko bootstrap serwera, a nie konfiguracja użytkownika. Proxy musi dopuścić
ten sam rozmiar; folder 25 MiB staje się około 34 MiB po base64 w JSON.
Marketplace `plugin@marketplace` opisano poniżej. Pobieranie paczek npm
i linked library pozostają poza zakresem implementacji.

## Marketplace i pluginy — badanie etapu 4

Badanie z 2026-11-04: Claude Code **2.1.308**, Codex **0.164.0**, SDK Claude
repo **0.3.316**. Nie instalowano upstream CLI ani nie uruchamiano modeli.
Przeczytano oficjalne [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference),
[marketplace](https://code.claude.com/docs/en/plugin-marketplaces),
[marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md)
i [settings](https://code.claude.com/docs/en/settings.md): katalog
`.claude-plugin/marketplace.json`, `/plugin marketplace add …`,
`/plugin install name@marketplace`, `extraKnownMarketplaces`, `enabledPlugins`,
`plugins/installed_plugins.json` v2 i cache pod rzeczywistym domem Claude.
Źródło `directory` pozwala deklarować lokalny katalog bez komendy interaktywnej;
`autoUpdate: false` utrzymuje zatwierdzony snapshot.

Codex ma natywne pluginy — nie zastępujemy ich luźnymi MCP/prompts.
[Oficjalna dokumentacja](https://developers.openai.com/codex/plugins/)
przekierowuje obecnie do `learn.chatgpt.com/docs/plugins`. Format ustalono też
z przypiętego źródła **rust-v0.164.0**:
[schema config](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/config.schema.json),
[installed](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core-plugin-common/src/installed.rs),
[store](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core-plugins/src/store.rs),
[loader](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core-plugins/src/loader.rs)
i [marketplace](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core-plugins/src/marketplace.rs).
CLI oferuje `plugin add/list/remove` i `plugin marketplace add/list/upgrade/remove`.
Obsługuje `.agents/plugins/marketplace.json`, format Claude oraz lokalne źródła
string i `{source: "local", path: "./…"}`. Aktywacja to
`[plugins."name@marketplace"] enabled = true`; lokalny marketplace deklaruje
`[marketplaces.name] source_type = "local", source = "<path>"`.
Cache to `plugins/cache/<marketplace>/<plugin>/<version>`; wariant `local`
ma pierwszeństwo przy wyborze zainstalowanej wersji.

## Marketplace i pluginy — protokół etapu 4

Gateway rozwiązuje skrót GitHub lub repo HTTPS z opcjonalnym `#ref` przez ten sam
transport i magazyn poświadczeń co etap 3. Przyjmuje wyłącznie zamknięte przepisy
`/plugin marketplace add …`, `/plugin install name@marketplace` oraz ich odpowiedniki
`claude plugin …` / `codex plugin …`; nigdy nie uruchamia wklejonego tekstu w shellu.
Preview zamraża commit i pliki na 30 minut, nie zapisuje przypisania. Zapis katalogu
i zatwierdzenie pluginu są osobnymi operacjami. **Check upstream** czyta śledzony ref;
**Save updated catalog** nie zmienia uruchamianego kodu. Edytor pluginu porównuje
zatwierdzoną wersję z kandydatem przez wspólny diff etapu 3.

Biblioteka obsługuje kompletne, repozytoryjne katalogi `./plugins/name`, z manifestem
`.claude-plugin/plugin.json` lub `.codex-plugin/plugin.json`. Dwa manifesty muszą
mieć tę samą nazwę. Plugin Claude jest zgodny również z Codex; sam manifest Codex
nie deklaruje zgodności z Claude. Zewnętrzne Git/npm/URL entries są widoczne
z przyczyną niedostępności. Root `./`, nested marketplaces i automatyczne zależności
pluginów nie są instalowane. Bundle rezerwuje jeden plik i 1 KiB na lokalny katalog
(maksymalnie 999 plików źródłowych, 1 MiB/plik, 25 MiB minus 1 KiB na bundle).
Nie uruchamiamy instalatorów ani dependency managera;
potrzebne programy muszą już istnieć w środowisku harnessu.

Każda aktywacja/zmiana przypisania wymaga jawnego, domyślnie niezaznaczonego
potwierdzenia dokładnego checksumu. UI udostępnia wszystkie pliki, manifesty,
hooks, MCP i skrypty; oznaczenia komponentów są pomocnicze, nie stanowią analizy
bezpieczeństwa kodu. Gateway sprawdza zgodę niezależnie od UI i zapisuje ją atomowo
z przypisaniem w audycie (`checksum`, commit, wersja). Nowy kod wymaga nowej zgody;
pluginy nie mają auto-update. Nieusunięta zatwierdzona wersja pozostaje dostępna
do edycji/usunięcia także po zniknięciu pluginu z katalogu upstream.

Selektory/tagi są wspólne z instrukcjami i skillami. Domyślny cel UI to sesje Canopy;
**Device CLI too** jest osobnym opt-in. Capability `agent_plugins_v1` rozszerza
`AgentEnvironmentDesired.plugins=6`, `plugin_resolutions=7`, raport `plugins=4`.
Starszy worker nie dostaje pluginów; UI pokazuje potrzebę aktualizacji. Artefakt
wykorzystuje istniejącą kopertę plików i SHA-256, bez źródłowych poświadczeń.
Limity: 30 marketplace, 100 pluginów, do czterech trwałych preview/właściciela,
25 MiB artefaktów pluginów/worker, 384 docelowe katalogi i łącznie 512 statusów
bundle/aktywacji. Porównania skilli
i pluginów współdzielą budżet raportu 96 MiB (gateway 128 MiB).

Worker instaluje do każdego faktycznego domu platformy, także jawnego shadow home,
oraz opcjonalnego domu CLI: `plugins/cache/canopy-<uuid>-<harness>/<name>/local`.
Sufiks harnessu zapobiega kolizji, gdy dwa harnessy dzielą jeden shadow home.
Dodaje deterministyczny lokalny katalog `.claude-plugin/marketplace.json` wskazujący
wyłącznie zatwierdzony bundle; raport plików obejmuje też ten wygenerowany plik.
Digest zgody w gateway pozostaje digestem oryginalnego artefaktu.

Claude: własne namespace w `settings.json` (`enabledPlugins`,
`extraKnownMarketplaces`) i `plugins/installed_plugins.json` v2; SDK ładuje gotowe
lokalne pluginy jawnie, zachowuje `settingSources: ["project", "local"]`.
Codex: własny blok `# canopy:plugins:begin/end` w `config.toml`, natywne tabele
pluginów i lokalnych marketplace. Pozostałe ustawienia zostają lokalne i nie są
raportowane. Nie kopiujemy prywatnych user settings do platformy.

Własność: `data_dir/agent-environment/plugins.json`, konfiguracja aktywacji:
`plugin-config.json`; transakcja katalogu i journal jak dla skilli. Lokalne zmiany
lub nowe pliki zatrzymują aktywację. Keep/Overwrite korzystają z jednorazowego CAS;
import plugin driftu nie istnieje, bo omijałby przegląd kodu. Usunięcie zachowuje
obce pliki i puste katalogi, a przy drifcie czeka na decyzję. Pusty znacznik Claude
`.in_use` pozostaje na dysku; dziennik zachowuje własność resztek cache, dzięki czemu
ponowne przypisanie nie przejmuje obcego katalogu. Prywatne dodatki nie trafiają
do porównań i blokują ponowne włączenie do czasu ich przeniesienia.

Receipt `canopy-<harness>-plugins.json` opisuje gotowe bundle i digest zarządzanych
części konfiguracji. Start nowej sesji platformy sprawdza receipt, pliki i aktywację;
zmiana lub niekompletny reconcile daje błąd. Reconcile nie wykonuje pluginów.
Stan applied potwierdza zapis plików; nie dowodzi dostępności binariów wymaganych
przez MCP/hook ani ich poprawnego działania. Test zgodności używa natywnych
`claude plugin list --json` i `codex plugin list --json --marketplace …`.
To formaty sprawdzone na podanych wersjach, bez obietnicy obsługi starszych CLI.
Aktywne sesje/procesy mogą zachować cache; dla Codexa może być potrzebny nowy
app-server (restart workera z UI po zakończeniu tur). Nie mutujemy uruchomionych modeli.

Migracje całego nieopublikowanego stosu przenumerowano w etapie 4 na
`0057_agent_environment`, `0058_agent_skills`, `0059_agent_skill_sources`,
`0060_agent_plugins`: `origin/dev` zajął wcześniej 0055–0056. Nie zmieniono treści
migracji etapów 1–3 ani migracji wdrożonych na dev. Wcześniejsze raporty weryfikacji
zachowują historyczne numery; do wdrożenia należy użyć końcowego stosu.

## Bezpieczeństwo, Docker i połączone komputery

Każde CRUD, preview, tag i resolution filtruje po właścicielu w gateway.
Współdzielony worker nie dostaje prywatnego globalnego środowiska żadnego z
użytkowników: globalny plik OS nie daje izolacji per wątek. Skill to kod wykonywalny;
właściciel zatwierdza źródło i aktualizacje. Brak sekretów w instrukcjach/paczkach,
auth i connector grants nigdy nie należą do synchronizowanej biblioteki.

Limity projektu: 100 dokumentów/właściciela, 64 fragmenty/dokument, 24 KiB
wynikowej instrukcji/harness/worker, 256 KiB czytanego pliku. Budżet Codexa
obejmuje też projektowe instrukcje, więc UI pokazuje wielkość podglądu. Upload
skilli: 10 MiB archiwum, 25 MiB po rozpakowaniu, 1000 plików, 1 MiB/plik;
odrzucamy symlinki, urządzenia, ścieżki absolutne, `..`, case-collisions i zip bombs.
Źródła upstream wymagają HTTPS, wyłączają redirecty i odrzucają
metadata/link-local oraz poświadczenia w URL.

Docker worker synchronizuje do **własnego wolumenu**, nie domu hosta. Read-only
volume daje widoczny błąd. Kod pluginu/skilla nie instaluje zależności OS; zmiana
obrazu to jawna czynność właściciela. Na Windows stosujemy copy/rename bez wymogu
uprawnień do symlinków, a ochronę dostępu zapewnia ACL użytkownika workera.

[Shared config etap 4](linked-computers.md#konkretny-protokół-etapu-4) będzie
rozszerzony opt-in o `environment:<uuid>`: wspólna definicja + niezmienne wersje
artefaktów, istniejące wektory i konflikty, capability po obu stronach. Przypisania
do workerów, tagi, ścieżki, drift i zgody instalacyjne zostają lokalne. Otrzymanie
wspólnego elementu nie jest zgodą na wykonanie kodu na maszynach odbiorcy.
Etapy 1–4 nie udostępniają biblioteki między gatewayami; ten dawniej planowany
element etapu 4 odroczono poza zakres zleconych marketplace/pluginów.

## Plan stosu

1. **Instrukcje i maszyny** (`feat/agent-environment-1`, zaimplementowany): dokumenty/fragmenty,
   selektory, tagi, per-machine overrides, preview, managed blocks, drift/resolution,
   status i temp-HOME integration. Pełna samodzielna funkcja bez instalacji kodu.
2. **Umiejętności** (`feat/agent-environment-2`, zaimplementowany): bezpieczny upload folder/zip, wersje i manifesty własności,
   synchronizacja do rzeczywistych domów, usuwanie i rollback; również Grok adapter.
3. **Źródła i utrzymanie** (`feat/agent-environment-3`, zaimplementowany): git/skills.sh refs, parser komendy, update tracking,
   ręczne/opt-in automatyczne aktualizacje z diff i zamrożonymi artefaktami.
4. **Marketplace i pluginy** (`feat/agent-environment-4`, zaimplementowany):
   Claude/Codex, zamrożone katalogi i wersje, własna konfiguracja harnessów,
   audytowana zgoda, przypisania, reconcile, drift i przegląd kodu/diff.

Zlecony czteroetapowy zakres implementacji jest kompletny. Linked-computer library
pozostaje osobnym projektem, bez deklaracji ukończenia. Wyniki sprawdzeń i granice
dowodów każdego etapu: [agent-environment-verification.md](agent-environment-verification.md).

Każdy etap jest osobną gałęzią opartą o poprzednią. Przy publikacji przez
maintainera: stacked draft PR, dolny do `dev`; gotowy i zweryfikowany cały stos
scala się razem squash. To zlecenie nie obejmuje push ani otwierania PR.

## Kontrakt realizacji

`workflow_mode: autonomous-planned`, `mode_source: explicit-user-task-instruction`,
`decision_authority: delegated`, `scope: current-task`,
`artifact_state: ready-for-execution`, `execution_mode: inline`.
Zlecono projekt i implementację etapów 1–4 jako subagent, z samodzielnym doborem
odwracalnych szczegółów. Protected constraints: bez push/PR, produkcji, prawdziwych
domów CLI w testach, portów stosu maintainera, zmian Tailscale i instalacji kodu
upstream. Kryterium: instrukcje i skille end to end, owner scoping, zgodność ze starszym workerem,
testy meaningful integration, wymagane sprawdzenia oraz kontrola UI light/dark
desktop/phone. Dowody trafiają do `agent-environment-verification.md`.
