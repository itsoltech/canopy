# Przeniesienie desktopu na serwer

Status: **projekt zatwierdzony; implementacja w stosie PR (§12)**. Podstawa: `dev`, commit
`64ba4300f251735cb10b1c51fabe32a8e458ec39`, schemat do
`0146_github_pr_last_known`. Nazwy nowych usług, tabel, capabilities i plików
w tym dokumencie są propozycjami. Istniejący `DesktopMigrationService` migruje
poświadczenie klienta UI, a nie bazę desktopu.

Zakres etapu 0: tylko projekt i draft PR; bez kodu, odczytu prawdziwych
sekretów, operacji na produkcji ani migracji danych.
Projekt zatwierdzony 2026-11-15 (decyzje w §13); implementacja idzie stosem z §12.

## 1. Rezultat i granice

Lokalne gatewaye Canopy Desktop oddają wszystkie dane jednemu serwerowi.
Serwer to binarka z web/BFF w procesie gatewaya, uruchamiana przez systemd,
z PostgreSQL, również w Dockerze ([deploy.md](deploy.md)). Każdy Mac zachowuje
swój worker i dołączony lokalny frontend/BFF, połączony z serwerem w istniejącym
trybie remote. Po przełączeniu nie uruchamia lokalnego gatewaya ani PostgreSQL.
Serwer ma rolę `server`; nigdy nie staje się połączonym komputerem.

**1:1 oznacza zachowanie danych domenowych i ich znaczenia**, w tym historii
ukrytej przez rewind, archiwów, soft delete, szkiców, pochodzenia i potwierdzeń
idempotencji. Zmieniają się właściciel, adres domu i poświadczenia transportu.
Przejściowe lease, połączenia i cache nie są aktywowane ze starego gatewaya.
Pliki repozytoriów, worktree, logowania CLI i transkrypty harnessów zostają
na tych samych maszynach. Zapisany w PostgreSQL transkrypt Canopy przechodzi
w całości; nie zastępujemy go podsumowaniem.

Decyzja v1 (§13): **pusty cel, jedna osoba, jedna sesja migracji obejmująca
wszystkie wskazane domy**. Nie obsługujemy scalania z istniejącym kontem
produkcyjnym ani pomijania niedostępnego domu. Nie przenosimy samego katalogu
PostgreSQL między macOS i Linuksem ani między głównymi wersjami PostgreSQL.
Nie przesyłamy dumpa z kluczem źródła. To logiczny, typowany transfer przez
gatewaye, niezależny od sposobu instalacji bazy.

Punkty oparcia i ograniczenia istniejących mechanizmów:

| Mechanizm | Co już istnieje | Zastosowanie w migracji |
| --- | --- | --- |
| Desktop remote | `apps/desktop/src/runtime/{runtime,web,worker-runtime,config}.ts`, `client-vault.ts`, `client-migration.ts` | Lokalny BFF, osobny token desktopu w `safeStorage`, worker niezależny od UI; nowe będzie skoordynowane przełączenie całej instalacji |
| Network access | `apps/gateway/src/network/{network,listener}.ts`, `packages/transport/src/routed-pinned.ts`; pełny pin SHA-256 | Wybór trasy przed RPC, pin przed kodem parowania; nowe będzie osobne uprawnienie migracji |
| Linked computers | `apps/gateway/src/computers/{moves,move-state,redirects}.ts`, `canopy.link.v1` | Wzorzec trwałej decyzji i rozpoznawania domu; nie używamy `ComputerMoveService` jako eksportu 1:1 |
| Config sync | `apps/gateway/src/config-sync/{merge,identity,clock,secrets,receive}.ts` | Istniejące reguły tożsamości, HLC, intencji i aliasów; jednorazowy konsolidator bez uruchamiania linkowania na serwerze |
| Trwałość | `worker_commands`, kursory journalu i `apps/worker/src/journal` | Zachowane idempotencja i sesje; nowe bariery przekazania workera |

`ComputerMoveService` przenosi snapshot, ma limit 40 MiB plików, pomija m.in.
sekrety wątku i otwarte cele, a kontynuację buduje na nowej sesji i notatce.
Nie spełnia wymagań tej migracji. Import CLI ([import.md](import.md)) czyta
Claude/Codex/Grok na workerze i adoptuje sesje; nie jest eksportem gatewaya.
Nie uruchamiamy ponownego importu CLI, aby odtworzyć istniejące wątki Canopy.

## 2. Inwentarz schematu i nośników

Źródłem inwentarza są pliki SQL w `packages/db/src/migrations`, ich późniejsze
`ALTER TABLE` oraz loader `packages/db/src/migrations/index.ts`. Dokumenty
czasem zachowują opis wcześniejszego etapu; rozstrzyga aktualny SQL i kod.
Każda tabela utworzona w tych migracjach jest wymieniona poniżej, również
tabele później usunięte. `schema_migrations` tworzy migrator Effect poza SQL.
Indeksy, funkcje, triggery, widoki i sekwencje odtwarza instalacja schematu celu,
nie eksport DDL źródła.

Klasy: **P** — przenieś wartości i ID bez zmian, poza mapowaniem właściciela;
**T** — przekształć według jawnej mapy; **S** — odszyfruj w źródle i zaszyfruj
w celu; **R** — odtwórz stan runtime; **D** — pomiń na celu, zachowaj w backupie;
**W** — pliki zostają na workerze. Kilka klas w wierszu rozdziela pola tabeli.
Nie wolno uznać nieznanej tabeli za D: nowy schemat bez adaptera blokuje preflight.

### 2.1. Tożsamość, konfiguracja i maszyny

| Tabele / migracja wprowadzająca | Klasa | Reguła |
| --- | --- | --- |
| `users` (0001) | T | Nie kopiuj konta ani emaila nad kontem serwera. Jawna mapa lokalnych użytkowników na istniejącego właściciela serwera; zachowaj pochodzenie autorów w manifeście |
| `workers` (0001) | T/R | Zachowaj UUID, nazwę, własność po remapie, archiwizację i odwołania. Nowy `credential_hash`, nowa generacja połączenia; capabilities, wersja i obecność potwierdzane przez Hello |
| `worker_connections` (0001) | R | Bez starego `instance_id`/epoch/lease; nowy WorkerLink ustanawia nowy fencing |
| `enrollment_tokens` (0001), `worker_enrollments` (0044, tagi 0064) | D/R | Nie przenoś tokenów/hashów zdolnych do enrollmentu; historię liczbową i decyzję zachowaj w audycie migracji. Nowe zaproszenia tylko dla zmapowanego workera |
| `user_settings`, `project_settings` (0005) | P/T | Całe ustawienia i wersje; odwołania do workerów/workspace pozostają. Parametry adresu gatewaya zastępuje cel; preferencje urządzenia nie stają się kontem serwera |
| `projects`, `project_workspaces` (0001; scratch 0032, origin 0072) | P/T + W | Rekordy, UUID, ścieżki i origin przechodzą; pliki zostają na workerze. Alias projektu może zmienić FK; nie scalaj katalogów na podstawie podobnej nazwy |
| `agents` (0001) | P/T | Szablony, rewizje i snapshoty; prywatne tylko wybranego ownera. Globalne wymagają wykazania zależności i praw źródłowego administratora; brak takiego dowodu blokuje |
| `provider_instances`, `provider_instance_workers` (0018; połączenia 0065) | P/T | Modele, favorites/hidden/shown/custom, env z `secretRef`, all_workers i nadpisania. Kolizje `(harness,id)` rozwiązuje mapa, nigdy cicha zamiana `native` lub loginu |
| `secrets` (0002) | S/T | Zachowaj ID i referencje, remap owner/created_by, nowy ciphertext/key_id. Sekrety platformowe NULL tylko z dowodem zależności i uprawnień, bez poszerzenia dostępu |
| `worker_configs`, `worker_config_secrets`, `worker_config_history` (0002) | P/T/R | Zachowaj historię i wersje, przepisz typowane referencje; po konsolidacji efektywna konfiguracja ma wersję większą od wszystkich źródłowych. Wyzeruj raport applied, odtwórz indeks referencji |
| `worker_model_catalogs` (0009), `provider_usage` (0141, filtr 0143) | P/R | Zachowaj ostatni raport jako nieaktualny, z czasem i tożsamością. Nowy Hello/ConfigApplied/raport potwierdza zgodność; nie pokazuj starego użycia jako nowego pomiaru |
| `proxies` (0061, worker_scoped 0078, management 0145) | P/T/R | Zachowaj definicję, `secret_id`, `management_secret_id`, Codex options i worker scope. Przelicz fingerprint nowym kluczem; usuń lease/cache Management API, sprawdź osiągalność z serwera |
| `worker_ssh_keys`, `worker_ssh_hosts` (0047) | S/P | Prywatny klucz gatewaya ponownie zaszyfruj, zachowaj publiczny klucz i przypięte hosty właściciela; nie akceptuj nowego host key automatycznie |
| `worktree_settings`, `worktrees` (0066–0068, external 0092) | P/T + W | Przenieś wszystkie zakresy polityk, placement, provenance, branch/base, removed/external; katalogów nie ruszaj. Trwające tworzenie/usuwanie musi skończyć się przed freeze |
| `checkout_heads` (0086) | P/R | Ostatni HEAD oznacz jako nieaktualny, odśwież od właściwego workera; nie wykonuj git na serwerze |
| `workspace_copy_presets`, `workspace_copies` (0112) | P/T + W | Presety i zakończone receipty, ID i ścieżki; częściowy transfer zakończ lub anuluj przed freeze. Treści katalogów nie ma w DB |

### 2.2. Wątki, historia, pliki i szkice

| Tabele / migracja wprowadzająca | Klasa | Reguła |
| --- | --- | --- |
| `threads` (0001, późniejsze rozszerzenia do 0146) | P/T | Pełne wiersze: lineage, settings, placement, session IDs, seq, tytuły, kolejność, archiwum/delete, creation request, metadane PR. Nie generuj nowych sesji |
| `turns`, `thread_events`, `thread_items` (0001), `turn_steers` (0009) | P/T | Zachowaj ID, ordinale, seq, raw/payload/content, usage, granice sesji, wycofane i cofnięte tury. Tylko typowane referencje zmieniają dom/owner; lease runtime zeruj |
| `thread_reads` (0019), `goals` (0001, cleanup 0011) | P/T | Odczyt/znacznik i ostatni stan celu harnessu; nie uruchamiaj ponownie `/goal` przy imporcie. Ograniczenia wznowienia celu pozostają jak w durability |
| `interaction_requests` (0001), `agent_bus_calls` (0001), `background_task_notes` (0024) | P/T | Historia decyzji i wyników oraz deduplikacja. Aktywne natywne oczekiwania rozstrzygnij przed odłączeniem; trwałe dostarczenia zachowaj bez ponawiania efektów |
| `schedules` (0001), `schedule_runs` (0027) | P/T/R | Zachowaj statusy, licznik, next_run_at, missed_policy i powiązania run/turn. Lease odtwórz dopiero po aktywacji celu |
| `worker_commands` (0001) | P/T/R | Terminalne komendy to historia. Oczekujące sklasyfikuj: nowe tury pozostają zablokowane, mutacje w toku muszą mieć wynik, nietrwałe odczyty regeneruj. Zachowaj command_id i deduplikację; nigdy nie kopiuj starego lease |
| `worker_journal_cursors` (0001), `bot_harness_cursors` (0104) | P | `(worker_id,journal_id,thread_id)` i acked_seq oraz kursory botów zachowaj; ACK celu nie może wyprzedzić zweryfikowanej kopii danych |
| `worker_event_quarantine` (0111, outcomes 0132) | P/T | Surowe bajty i przyczyna bez odtwarzania odrzuconych efektów; zakres przez właściciela workera i wątku/bota |
| `blobs`, `attachments`, `thread_blobs` (0001, 0016; bot 0102, video 0135) | P/T | Bajty, SHA-256, metadane, miniatury, video duration, przypisania do tur/botów i nieprzypięte uploady. Pełny transfer storage opisany niżej |
| `thread_message_receipts` (0099), `thread_image_publications` (0137–0138) | P/T | Potwierdzenia chronią przed replay SendMessage/show_images. Publikacje reserved muszą dojść do committed lub jawnego wygaśnięcia przed finalną kopią; nie odtwarzaj starego lease |
| `thread_rewinds`, `thread_rewind_turns` (0136) | P/T | Także sesja źródłowa i zastępcza, completed_seq/restored_seq, cofnięty suffix. Pending rewind/Undo musi się rozstrzygnąć przed freeze |
| `thread_visuals` (0139, HTML 0144) | P | Wszystkie wersje, spec, sha256, html_document, schema/kit version i referencje. Nie renderuj HTML ani nie uruchamiaj kodu przy migracji |
| `composer_drafts`, `composer_draft_attachments`, `composer_draft_moves` (0140, 0142) | P/T | Binarny protobuf, ID, urządzenie, rewizja, mutation/claim/send/delivery receipty, terminy i referencje; typowany adapter celu i powiązań; żadnego wysyłania szkicu |
| `composer_draft_clock` (0140) | T/R | Nowa przestrzeń watcha celu, rewizja ponad maksimum źródeł. Rewizje pojedynczych szkiców pozostają; klienci robią bootstrap |
| `import_runs`, `import_items`, `thread_imports`, `import_library_items` (0093–0094) | P/T + W | Zachowaj historię importu CLI, kursory, snapshot/base/target, source_key i native_id. Aktywny import doprowadź do bezpiecznej strony i pause; one-time confirmation wygaś. Podpisujący klucz importu zostaje na workerze |

### 2.3. Boty, konektory i środowisko agentów

| Tabele / migracja wprowadzająca | Klasa | Reguła |
| --- | --- | --- |
| `bots`, `bot_turns`, `bot_messages`, `bot_tool_calls` (0031) | P/T | Cała rozmowa, checkpoints i ukryte tury; przypięty worker, sesja, narzędzia i wyniki. Globalne seq wiadomości wymagają mapy przy wielu źródłach |
| `bot_approvals`, `bot_thread_watches`, `bot_wakeups` (0031) | P/T | Zachowaj pytania, zgody i trwałe obserwacje, delivered/cancelled. Nie ponawiaj zatwierdzonego efektu; niepewny wynik MCP wymaga decyzji |
| `bot_routines` (0039), `bot_handoff_notes` (0045) | P/T | Pełna konfiguracja, run_count/terminy, ukryte przekazania i notatki; jeden wykonawca dopiero po cutover |
| `bot_harness_turns`, `bot_harness_events` (0070–0071) | P/T | Trwały transkrypt Canopy i referencje komend; pliki natywnej sesji pozostają na workerze. Nie mylić z W |
| `bot_approval_rules`, `bot_started_threads` (0089) | P/T | Polityka i powiązania skutków narzędzi; nie rozszerzaj zakresu zgód |
| `bot_composer_drafts` (0102) | P/T | Cały payload, owner i revision, bez automatycznej wysyłki |
| `bot_view_clock`, `bot_view_changes` (0091) | R | Nowa epoka widoku i bootstrap; to ograniczony dziennik invalidacji, nie historia rozmowy |
| `connector_accounts`, `connector_oauth_apps` (0041, 0077–0081) | P/T/S | Definicje, narzędzia, namespace, metadane i zaszyfrowane credentials/klienci OAuth; reset diagnozy dopiero po sprawdzeniu. Zachowaj zapisany redirect, nie zmieniaj rejestracji dostawcy w ciemno |
| `connector_worker_grants`, `connector_bot_grants` (0041) | P/T | Przenieś dokładne zbiory grantów po mapie kont i workerów/botów; `all_*` nadal dotyczy wyłącznie ownera |
| `connector_oauth_states` (0041) | D | State, PKCE, binding przeglądarki i completion receipt tracą ważność. Dokończ logowanie przed freeze albo rozpocznij ponownie po migracji |
| `connector_executions`, `connector_audit` (0041) | P/T | Wyniki i fingerprinty deduplikacji, bez ponawiania running o nieznanym wyniku. Serial audytu remapuj przy kolizji; zachowaj źródłowy numer w provenance |
| `bot_mcp_servers`, `bot_mcp_connections` (0031) | D | Nadal istnieją jako źródło migracji 0041, nie jako druga aktywna konfiguracja. Preflight potwierdza przeniesienie do connectorów; nieskonwertowany rekord blokuje |
| `agent_environments`, `instruction_documents`, `instruction_document_versions` (0057) | P/T | Rewizje, dokumenty, fragmenty, selectors i tombstone wersji; remap UUID workera i referencji środowiska |
| `worker_environments` (0057–0058) | P/T/R | Zachowaj `manual_tags` i JSON `resolutions`. Nadpisania definicji i zakresy maszyn pozostają w dokumentach instrukcji/skilli/pluginów. `report`, `automatic_tags` i flagi supported są ostatnio znane, wymagają reconcile z tego samego data_dir |
| `agent_skills`, `agent_skill_versions` (0058–0059), `agent_marketplaces`, `agent_plugins`, `agent_plugin_versions` (0060), `agent_marketplace_catalogs` (0076) | P/T | Wszystkie definicje i treści wersji, pin, selektory, źródła, checksum zgody. Hash jest tożsamością treści, lokalny numer wersji mapujemy, jeśli się różni |
| `agent_skill_source_previews` (0059), `agent_marketplace_previews` (0060) | D/R | Krótkotrwałe podglądy upstream wygasają; można sprawdzić ponownie, bez instalacji czy wykonania podczas importu |

### 2.4. Konfiguracja wspólna, łącza i klienci

| Tabele / migracja wprowadzająca | Klasa | Reguła |
| --- | --- | --- |
| `config_items`, `config_aliases`, `config_history` (0073, ancestry 0110) | P/T/S | Zachowaj global_id, lokalne aliasy, tombstone, pola HLC/prev/seen/edited, historię i ancestry. Ciphertext historii re-encrypt. Jednorazowe scalanie opisuje §6 |
| `config_secrets` (0074) | S/T | Każda zachowana wersja sekretu i secret_id po mapie; brak wartości wymaganej przez aktywne pole jest blokadą, nie pustym kluczem |
| `config_clock` (0073) | T/R | Nie sumuj obcych revision. Nowa epoka, lokalna rewizja celu i HLC ponad maksimum wszystkich źródeł; stare kursory w manifeście |
| `config_peer_cursors` (0073) | D | Serwer nie subskrybuje partnerów; źródłowe checkpointy służą wyłącznie dowodowi konsolidacji |
| `computer_identity`, `network_access` (0048, 0055, Tailscale 0083) | R | Zachowaj tożsamość, certyfikat, klucz i ustawienia już utworzonego serwera. Nie kopiuj kluczy TLS, portów, tras, wpisów Serve ani nazwy Maca |
| `computer_peers`, `computer_routes`, `computer_revocations`, `computer_relay_grants` (0048, 0052–0053) | T/D | Topologię i dotychczasowe revocations zachowaj jako provenance migracji; nie twórz aktywnych peerów/grantów na serwerze. Każdy dom staje się workerem/klientem |
| `computer_pairings`, `computer_pairing_budget` (0048) | D/R | Kody i uprawnienia linkowania wygasają; własny limiter celu pozostaje |
| `computer_thread_clock`, `computer_thread_changes`, `computer_mirror_state`, `computer_mirror_threads` (0049) | D | Lustro nie jest oryginałem; importuj z domu. Dawne kopie zostają wyłącznie w backupach |
| `computer_bot_mirror_state`, `computer_mirror_bots` (0051), `computer_mirror_generations` (0104), `computer_thread_panels` (0128) | D | Kopie i cache odbuduje odczyt serwera, bez łącza komputerów |
| `computer_agent_calls`, `computer_agent_events` (0051) | T | Zachowaj call/event IDs, wyniki, report_status i remote lineage jako dane historyczne; aktywne relacje zamień na lokalne powiązania szyny, bez podwójnej dostawy |
| `computer_moves`, `computer_redirects`, `computer_moved_threads` (0054) | P/T | Zakończone ruchy i historyczne snapshoty są częścią historii, nie cache. Przekształć domy w nową mapę referencji. Ruch nierozstrzygnięty blokuje freeze |
| `thread_replication_sources`, `thread_replication_clock`, `thread_replication_seed_entities`, `thread_replication_journal`, `thread_replication_content` (0120, 0124) | D/R | Publiczna projekcja zakresów nie obejmuje całej DB. Zregeneruj dla nowych klientów, z nową epoką; nie utożsamiaj z thread_events.seq |
| `thread_range_state`, `thread_range_entities`, `thread_range_failures` (0120), `thread_publication_failures` (0121), `thread_mirror_recent_ranges` (0134) | D | Stan odbiorcy i diagnostyka łącza; dane domu muszą być kompletne niezależnie od nich |
| `mobile_devices`, `mobile_pairings` (0046, rodzaj desktop 0062) | D/R | Nie kopiuj hashy tokenów ani kodów. Nowe poświadczenie każdego telefonu i desktopu przypięte do serwera; etykiety dawnych urządzeń w raporcie |
| `desktop_worker_migrations` (0062), `desktop_updates` (0063) | R | Nie odtwarzaj dawnej emisji credentialu ani komendy aktualizacji. Nowe parowanie i potwierdzenie worker↔desktop przez dwa kanały; osobny nonce sesji |
| `worker_secret_delivery_cursors`, `worker_secret_replays` (0108) | R | Nowa synchronizacja ważnych thread_secrets; żadnych starych potwierdzeń ścieżki pliku |
| `thread_secrets` (0036) | S/T | Tylko nadal ważna wartość; zachowaj ID/status/TTL/revision, wyzeruj applied_revision i file_path. Wygasłe/revoked zachowaj bez ciphertext; nie przedłużaj TTL |

### 2.5. GitHub, audyt i utrzymanie

| Tabele / migracja wprowadzająca | Klasa | Reguła |
| --- | --- | --- |
| `github_accounts` (0113) | P/T/S | Token access/refresh, expiry, GitHub user ID, PAT reference i access revision. Zjednoczenie tego samego konta z kilku domów wymaga mapy i wybrania ważnej autoryzacji; bez downgrade uprawnień lub cichego refresh starej pary |
| `github_device_auth` (0113) | D | Trwające device flow anuluj; device_code i client_binding nie migrują. Ukończone konto przechodzi przez github_accounts |
| `github_installations`, `github_installation_repositories` (0113) | P/T/R | Zachowaj katalog jako ostatnio zweryfikowany; serwer sprawdza dostęp przed pierwszą operacją |
| `github_repository_accounts` (0114), `github_update_accounts` (0116) | P/T | Zachowaj wybór konta repozytorium i konta aktualizacji; sprzeczne wybory wymagają rozstrzygnięcia w dry run |
| `github_pull_requests`, `thread_pull_requests` (0114, last-known 0146) | P/T | PR URL/number/node ID, relacje i evidence, odpięcia oraz ostatnie summary z kontem i datą. Przy tym samym PR z kilku domów deduplikacja po owner/host/repo/number z mapą UUID |
| `github_pr_cache` (0114) | P/T/R | Zapisane strony, cytaty/logi i kontekst używany przez szkice przenieś z account/access scope, bez lease. Oznacz jako nieaktualne; ponownie potwierdź dostęp przed zdalną operacją |
| `github_api_budgets`, `github_api_slots` (0114) | T/R | Zachowaj konserwatywny retry/reset/zużycie per GitHub identity, aby nie ominąć backoff. Lease slotów odtwórz; dwa niezależne liczniki nie są nowym limitem API |
| `github_detection_jobs`, `github_git_contexts` (0115) | P/T/R | Zapisane cursors/event_seq i kontekst checkoutu zachowaj; lease i obserwatorów UI odtwórz; ścieżki odnoszą się do workerów |
| `github_mutation_receipts` (0117–0119) | P/T | Zachowaj request_id/fingerprint, wynik i uncertain/accepted. Prepared confirmation wygasa; in_flight trzeba rozstrzygnąć albo zachować uncertain bez automatycznego replay. Nowy klient nie dziedziczy binding zgody |
| `audit_log` (0001), `diagnostics_investigations` (0130) | P/T | Zachowaj historię i powiązanie z załączonym raportem/wątkiem; actor mapuj z provenance źródłowego ownera. Nie loguj payloadu migracji |
| `diagnostics_state`, `diagnostics_rollups` (0129) | P/T/R | Historyczne pomiary zachowaj pod pochodzeniem komputera; nowe próbki workera/serwera odrębne. Nie udawaj, że Mac i serwer to ta sama maszyna |
| `diagnostics_grants`, `diagnostics_peer_cache`, `diagnostics_log_grants` (0129–0131) | D | Zgody relay/odczytu logów nie stają się grantami serwera |
| `database_maintenance` (0104) | R | Nowy harmonogram utrzymania; retencja nie może usuwać danych uczestniczących w migracji |
| `schema_migrations` (loader) | R | Cel wykonuje własne SQL w kolejności, nie kopiuje dziennika źródła |
| `provider_model_selections` (0015, usunięta 0018), `computer_shared_items`, `computer_shared_acks`, `computer_shared_conflicts` (0050, usunięte 0075) | D | Nie istnieją w aktualnym schemacie. Starsze źródło najpierw aktualizuje własną bazę; nie wskrzeszaj dawnych kontraktów |

### 2.6. Poza PostgreSQL

**W:** SQLite journal i rejestr sesji, processed_commands/started_turns, transcript
harnessu, platformowe i własne CLI homes, macOS Keychain, pliki auth CLI,
`data_dir/import/key`, katalogi botów, scratch, repozytoria i worktree,
manifesty własności środowiska oraz lokalne rozstrzygnięcia driftu. Zachowujemy
ten sam `data_dir`, konto systemowe i ścieżki. `worker.json` zmienia wyłącznie
połączenie, pin i credential; zapis jest atomowy, 0600, z kopią do rollbacku.

Powłoka Electron zachowuje preferencje urządzenia i origin lokalnego BFF.
`desktop-client.enc` dostaje nowe poświadczenie przez `safeStorage`, nigdy
`basic_text`. `history-v1` jest ograniczoną kopią projekcji, nie źródłem migracji;
obecna zmiana trybu ją czyści. Przed przełączeniem nowy mostek musi opróżnić
lokalne szkice do źródłowego gatewaya i zapisać receipt ich migracji.
Niesynchronizowane szkice offline innych urządzeń wymagają ich podłączenia
lub jawnego eksportu/przejęcia przed cutover; nie obiecujemy ich odzyskania
z samej bazy. Lokalne karty workspace i skróty pozostają preferencją urządzenia.

`blobs.data` to `bytea`; schema dopuszcza też `storage_url` zamiast bajtów.
Nie kopiujemy URL jako dowodu przeniesienia pliku. Obecny
`apps/gateway/src/store/attachments.ts` nie obsługuje odczytu obiektów
`storage_url`; v1 blokuje taki rekord w preflight. Jego obsługa wymaga **nowego**,
ograniczonego adaptera eksportu po stronie źródła: odczyt obiektu, weryfikacja
rozmiaru/SHA-256 i przesłanie bajtów do celu (v1: `blobs.data`). Już istniejący
brak wykazujemy osobno jako wymagający decyzji; nie pobieramy dowolnego URL
z importu. Miniatury są osobnymi blobami. Transfer deduplikuje SHA-256 tylko
wewnątrz dozwolonego zbioru referencji ownera: `attachments`,
`composer_draft_attachments`, `thread_blobs`, botów, odziedziczonej/moved historii
i zapisanych stron GitHub. Sam hash nie daje prawa odczytu.

`thread_blobs` celowo nie ma FK do `blobs`: znany brak sprzed migracji zostaje
jawną pozycją raportu. Nowy brak lub inny hash zawsze blokuje weryfikację.
Wersje skilli/pluginów/katalogów są JSONB w ich tabelach, nie w `blobs`;
zachowujemy też bajty tekstu używane przez `config_content_hash`, checksum
artefaktu i referencje do zatwierdzonej wersji.

## 3. Tożsamość, owner i zachowanie referencji

Źródła i cel mają lokalne UUID użytkownika; ten sam email lub nazwa nie dowodzi
tożsamości. Gateway obecnie obsługuje właściciela przez BFF service token oraz
odwoływalne urządzenia (`apps/gateway/src/api/auth.ts`); pełne logowanie
multi-user pozostaje poza zakresem. Migracja nie dodaje logowania ani prawa
administratora do cudzych prywatnych danych.

Manifest sesji wiąże `(source_node_id, source_owner_id) → target_owner_id`.
Właściciel zatwierdza kierunek na obu zaufanych UI. Cel sam ustala swój owner
z uwierzytelnienia; nie przyjmuje go z payloadu. Adapter jawnie mapuje wszystkie
FK do `users`, także `user_id`, `created_by`, `updated_by`, `actor_user_id`,
`author_user_id`, `answered_by` i `created_by_user_id`. Nie zmieniamy UUID
wewnątrz dowolnego tekstu, raw JSON, instrukcji lub transkryptu.

Pusty cel może zawierać bootstrap ownera, własne `computer_identity`,
Network access, bootstrap `native`/scratch/default settings, urządzenie operatora
i samą sesję migracji. Dry run zapisuje hash dokładnie tej listy wyjątków.
Dowolny wątek, bot, własny projekt, konto, sekret lub worker spoza sesji oznacza
`Target has existing data`. Nie kasujemy go automatycznie. Wyjątki bootstrapu
nie mogą nadpisać skonfigurowanych danych źródła. Rezerwacja celu blokuje
zwykłe mutacje od startu sesji do zakończenia/abort, również z innych BFF.
Obcy owner lub współdzielony zasób bez dowodu praw blokuje v1.

Zwykłe UUID wątków, tur, eventów, item IDs, załączników, workspace i workerów
zachowujemy. Pełna rodzina forka przechodzi z `fork_source_thread_id`,
`fork_after_turn_id`, granicami seq i sesji. Rewind zachowuje także obie sesje
oraz suffix historii. `threads.last_seq`, `thread_events.seq`,
`turns.ordinal`, first/last_seq, journal_seq i event_id nie są renumerowane.
Następny zapis musi użyć numeru większego od maksimum. Identyczny event_id
z innymi bajtami to `DataLoss`, nie idempotentne ponowienie.

Kilka źródeł może mieć te same lokalne slugi, ID instancji, singletony i numery
serial. Nowa `server_migration_id_map` zawiera rodzinę, źródło, stary i nowy
klucz oraz przyczynę. Domy mają disjoint wątki/boty; ich rzeczywista kolizja UUID
blokuje migrację, chyba że to udowodniona identyczna replika tego samego domu.
Nie naprawiamy jej przez losowy UUID. Konfigurację scala §6. Dla tabel globalnie
numerowanych (`bot_messages.seq`, `connector_audit.id`, `github_git_contexts.id`)
jedno źródło zachowuje liczby; przy wielu źródłach nadajemy nowe w stabilnej
kolejności źródło + stary numer i zachowujemy mapę. Przeliczamy `last_read_seq`
i wszystkie typowane kursory/receipty wskazujące te numery. Ustawiamy sekwencje
celu ponad max, a clients dostają nowe epoki watcha.

Odwołania `<uuid>~<prefix domu>` w UI i `uuid@node` konfiguracji stają się lokalne
na serwerze. Mapa zachowuje pełny node ID i sprawdza niejednoznaczność prefiksu.
Nowy resolver starych referencji działa także na serwerze z wyłączonym linking,
bez połączeń do starego domu. Obejmuje deep links w aplikacji, lineage,
remote_parent_ref, piny, granty, narzędzia szyny, szkice i linki PR.
Adres starego BFF w zewnętrznej zakładce nie może dalej działać po jego wyłączeniu;
UI umożliwia otwarcie tej samej referencji na serwerze.

Protobuf szkiców, inputów i receiptów przechodzi przez typowane adaptery.
Nie przepisujemy literalnych URL/ID wewnątrz wiadomości ani nie zmieniamy raw
historii; resolver obsłuży rozpoznane referencje przy użyciu. Każda transformacja
ma test domknięcia grafu FK i mapowania, w tym cykle turns↔calls↔schedules.
Importer materializuje dane w kontrolowanej kolejności i transakcjach rodzin;
nowe importowe mechanizmy odroczenia konkretnych ograniczeń muszą zachować ich
walidację na końcu. Nie wyłączamy globalnie triggerów ani owner checks.

## 4. Sekrety i granica transportu

Istniejący `apps/gateway/src/store/secrets.ts` używa AES-256-GCM,
`CANOPY_SECRETS_KEY` (32 bajty base64), losowego IV i `key_id=env-v1`.
Identyczny key_id na dwóch gatewayach **nie oznacza identycznego klucza**.
Klucz główny desktopu pozostaje w jego magazynie OS; klucz serwera i
`CANOPY_UI_SERVICE_TOKEN` pozostają w konfiguracji systemd.
Nie kopiujemy ich ani hasła PostgreSQL źródła.

Każdy przenoszony sekret odszyfrowuje **gateway źródła**; plaintext jedzie
wyłącznie uwierzytelnionym, wzajemnie przypiętym kanałem gateway↔gateway.
Gateway celu szyfruje go swoim kluczem **przed** zapisem stagingu/WAL.
Również wznowienie nie zapisuje plaintext do temp, outboxa ani payloadu
trwałych chunków. BFF, renderer, worker, model i audyt nie dostają tych wartości.
Bufor jest ograniczony do jednej porcji i zwalniany po zapisie; nie obiecujemy
doskonałego wyzerowania kopii stringów JS. Nie używamy CLI do decryption.

| Rodzina sekretu | Decyzja |
| --- | --- |
| `secrets`, `config_secrets`, `config_history.ciphertext` | Re-encrypt wszystkich zachowanych wersji, także Restore i worker-scoped overrides; zachowaj referencje. Fingerprint zależny od klucza celu przelicz, nie traktuj zmiany ciphertext jako zmiany wartości |
| Konektory OAuth, nagłówki i aplikacje | Re-encrypt `connector_accounts.credentials`, `connector_oauth_apps.credentials` i legacy secretRef. Access/refresh/expiry oraz zapisany client/redirect zachowaj; sesje state/PKCE wygasają |
| `github_accounts.credentials` | Re-encrypt ukończonej pary device-flow tokenów. PAT pozostaje odwołaniem do własnego connectora. Nie kopiuj device_code rozpoczętej autoryzacji |
| Klucze proxy i CLIProxyAPI Management API | `proxies.secret_id` i `management_secret_id` → re-encrypt w `secrets`. Management key służy tylko gatewayowi, nigdy WorkerConfig. Nie przenosimy kont OAuth działających wewnątrz zewnętrznego CLIProxyAPI |
| SSH i `thread_secrets` | Prywatny klucz SSH re-encrypt; aktywny sekret wątku zachowuje TTL. Normalna późniejsza dostawa pliku sekretu lub klucza profilu do uprawnionego workera pozostaje istniejącą funkcją, oddzielną od migracji |

Nowe są: migracyjne uprawnienie i certyfikat sesji. **Ponownie wydawane** są
credentials workerów, klientów desktopu i telefonów, kody parowania/enrollmentu,
nonce powiązania desktop↔worker oraz własne TLS identity celu. Hash bearer tokenu
nie daje możliwości odzyskania tokenu; kopiowanie hasha rozszerzyłoby stare
zaufanie na inny gateway. Nie kopiujemy source service token ani pairing keys.
Logowania CLI w Keychain/auth.json/.credentials.json/GROK_AUTH_PATH zostają W.

GitHub App używa obecnie publicznych `CANOPY_GITHUB_APP_CLIENT_ID` i
`CANOPY_GITHUB_APP_SLUG` (`github/http.ts`); moduł PR nie przechowuje klucza
prywatnego GitHub App ani installation tokenu. Nie projektujemy ich jako
istniejących danych do eksportu. Cel musi mieć ten sam App client ID dla
przenoszonego device-flow loginu; inna aplikacja wymaga nowego logowania.
Własne OAuth app secrets connectorów są rzeczywistymi danymi gatewaya.

Przed finalnym delta źródła wstrzymują nowe refresh/logowania. Trwający refresh
musi atomowo zakończyć się i wejść do delty; niepewny wynik rotacji wymaga
`needs_reconnect`, bez próby ze starym refresh tokenem. Serwer nie odświeża tokenów
ani nie testuje MCP do aktywacji. Po niej tylko on je używa; backup źródła nie
może uruchomić pollera. Zmiana własnego redirect URL lub loopback endpointu
connectora wymaga jawnej korekty; nie udajemy, że localhost Maca to localhost serwera.

## 5. Parowanie i nowy protokół migracji

### Autoryzacja

Nowe Settings → Move to a server na źródle i Settings → Import from desktop
na celu korzystają z administracyjnych RPC ownera przez BFF. Desktop token
może autoryzować UI swojego ownera, lecz nie staje się poświadczeniem kanału
eksportu. Telefon, worker i model nie mogą przygotować ani zatwierdzić migracji.

1. Właściciel na serwerze rezerwuje pusty cel i generuje krótkotrwałe zaproszenie
   migracyjne: adresy Network access, pełny SHA-256 certyfikatu celu, session ID
   i jednorazowy sekret 256-bitowy (10 minut, hash w DB). To **nowy rodzaj**
   zaproszenia, nie kod desktop/mobile/linking. Każdy dodatkowy dom ma osobny kod.
2. Main/controller przekazuje zaproszenie lokalnemu gatewayowi przez zaufane IPC
   i BFF bez umieszczania w URL/logu. Źródło weryfikuje pin przed jakimkolwiek HTTP
   z sekretem, bez TOFU, redirectów i wyjątku TLS. Tailscale dostarcza trasę,
   nie zastępuje autoryzacji i pinu. Operator porównuje pin przez zaufany UI celu.
3. Nowy `MigrationPairingService.Exchange` na Network access bez certyfikatu
   zużywa kod atomowo, wiąże źródłowy certyfikat/node ID i obu ownerów. Nowy
   klucz sesji powstaje na źródle; prywatny klucz nie opuszcza jego gatewaya.
   Serwer pokazuje nazwę źródła, pin i zakres, źródło nazwę/pin celu; oba zapisują
   potwierdzenie. Samej nazwy serwera nie uznajemy za dowód tożsamości.
4. Dalsze RPC idą HTTP/2 TLS 1.3 z mTLS i pinem obu certyfikatów. Nowa gałąź
   dispatchera `network/network.ts` rozpoznaje wyłącznie zatwierdzony certyfikat
   migracji i kieruje go do `MigrationService`; bez dostępu do UI/WorkerLink/linka.
   Obecnie rola server odrzuca certyfikaty komputerów — tę regułę zachowujemy.
   Wyjątek migracyjny nie montuje `ComputerLinkService`, discovery ani config sync.
5. Certyfikat jest związany z session/source/owner i może wznowić tę sesję przez
   30 dni, z możliwością revoke. Wygaśnięcie przed decyzją wymaga ponownego
   potwierdzenia obu stron; po decyzji nowe uprawnienie pozwala tylko odzyskać
   ten sam wynik. Nigdy nie cofa trwałego fence ani decyzji commit.

Utrata odpowiedzi `Exchange` nie pozwala ponownie zużyć zaproszenia. Źródło
zapisuje klucz i identyfikator próby przed wywołaniem; ponowienie z tym samym
kluczem otrzymuje ten sam publiczny wynik. Inny klucz wymaga nowego zaproszenia
i unieważnienia poprzedniej próby przez ownera. Odpowiedź nie zawiera klucza
prywatnego ani sekretów danych.

### Kontrakt — nowy, addytywny

Proponowany plik `proto/canopy/migration/v1/migration.proto`, namespace
`canopy.migration.v1`. Proponowane implementacje:
`apps/gateway/src/server-migration/` (pairing, manifest, source, target, verify,
decision), `apps/desktop/src/server-migration/` (lokalny checkpoint i cutover).
UI metadata/RPC są addytywnym rozszerzeniem `canopy.ui.v1`.

| RPC nowej usługi | Odpowiedzialność |
| --- | --- |
| `Negotiate`, `Preflight` | Wersje i capabilities, tożsamość sesji, manifest rodzin, plan mapowania, liczniki i konflikty; bez wartości sekretów w odpowiedzi UI |
| `Transfer` (bidi streaming) | Źródło inicjuje; start od trwałych kursorów celu, porcje rekordów i blobów, ACK po commit, backpressure |
| `GetProgress`, `WatchProgress` | Faza, źródło/rodzina, copied/verified/remaining records i bytes, finalne watermarks, błędy sklasyfikowane bez payloadu |
| `PrepareCutover`, `RecordDecision`, `GetDecision` | Bariery wszystkich źródeł, hash finalnego manifestu, niezmienna decyzja commit/abort i jej odczyt po reconnect |
| `Abort`, `Resume` | Abort wyłącznie przed decyzją; resume tej samej sesji z trwałego stanu, nigdy nowy import do niepustego celu |

Koperta: protocol/schema version, session ID, source node, generation, rodzina,
klucz encji lub blob hash, revision/seq, offset, rozmiar, hash porcji, operation
upsert/delete i idempotency key. Limit startowy: **1 MiB danych na ramkę**,
maks. 4 MiB zakodowanego protobuf, do 8 MiB w locie na źródło; wartości większe
niż porcja mają osobne offsety. Rekord jest widoczny w stagingu dopiero po pełnym
odbiorze i weryfikacji; manifest określa limit całkowitego rekordu/obiektu.
Nie dziedziczymy limitu 40 MiB ComputerMoveService ani 50M BFF uploadu.

ACK oznacza transakcję: fragment/encja, checksum, checkpoint i licznik zapisane
razem. Ten sam klucz i hash zwraca poprzedni ACK; inny hash przy tym samym kluczu
jest `DataLoss`. Dla sekretów trwały receipt zawiera tylko nieodwracalny token
wersji i potwierdzenie re-encryption, nie publiczny hash plaintextu podatny
na zgadywanie. Porównanie wartości odbywa się w pamięci gatewayów przez
sesyjny HMAC challenge, bez utrwalania materiału weryfikacyjnego w logach.
Przerwanie w połowie blobu wznawia od ostatniego potwierdzonego offsetu;
uszkodzoną porcję można pobrać ponownie, bez duplikacji encji.

Nowe trwałe staging/manifesty/kursory mają owner/session/source w kluczu.
Cel nie wykonuje SQL z nazwami tabel/pól podanymi przez nadawcę: każda rodzina
ma jawny schemat i importer. Nowa tabela/kolumna/pole potrzebuje klasyfikacji;
nieznany wymagany element zatrzymuje migrację. Nie gubimy go przez ignorowanie
nieznanych pól protobuf.

### Kopia na żywo i przyrosty

`thread_events.seq` i worker journal_seq nadają się do przyrostowego kopiowania
historii. `config_clock.revision`, `composer_draft_clock` i bot view mają inne
przestrzenie; publiczny `thread_replication_journal` pomija prywatne dane,
ma retencję i nie zastępuje pełnego eksportu. `updated_at` ani sam BIGSERIAL
nie gwarantują kolejności commitów. Tury/itemy są mutowalne także poniżej
ostatniego seq; usunięcia muszą być przenoszone jawnie.

Nowy dziennik `server_migration_changes` przechwytuje **wszystkie** mutacje
rodzin P/T/S, również DELETE i referencje blobów. Trigger transakcyjny zapisuje
klucz i operację, nie plaintext sekretu. Odroczony zapis z blokadą zegara sesji
porządkuje commity jak bot_view; zwykłe nextval bez bariery byłoby błędne.
W czasie aktywnego eksportu GC/retencja nie usuwa potrzebnych treści, wersji,
receiptów ani blobów. Ochrona jest trwała, ma limit dysku i zatrzymuje migrację
przy braku miejsca; nie wygasa samoczynnie na źródle po commit.

Bootstrap czyta strony po stabilnym PK pod snapshotem REPEATABLE READ z watermark
dziennika. Długie snapshoty są limitowane; po utracie procesu robimy ponowny
bootstrap nieukończonej rodziny w nowej generacji stagingu, zamiast udawać, że
stary snapshot nadal istnieje. Zatwierdzone bloby nie jadą ponownie. Następnie
dziennik wskazuje zmienione encje do upsert/delete. Powtórzenia i starsze rewizje
nie nadpisują nowszych. Jeśli źródło zmieni się podczas odczytu klucza, jego nowy
commit znów trafi do delty. Finalny freeze i manifest rozstrzygają kompletny stan.
Zerwanie cursor retention wymaga nowego bootstrapu, nigdy pominięcia luki.

Nie potrzebujemy jednego długiego snapshotu wszystkich Maców. Każdy ma własne
checkpointy; finalna weryfikacja odnosi się do zatrzymanego wektora źródeł.
Serwer materializuje dane partiami za owner-wide blokadą importu; restart może
powtórzyć krok, lecz UI i runtimes nie widzą częściowej produkcji. Aktywacja jest
jedną krótką transakcją zmiany stanu po kompletnym raporcie, nie transakcją 1 GB.

### Zgodność wersji

V1 dopuszcza tylko źródła i cel z nową capability `server_migration_v1`, zgodnym
manifest schema i pełnym zestawem adapterów. Na pierwsze wydanie wymagamy (§13)
**dokładnie ten sam build migracyjny** na wszystkich gatewayach i desktopach;
worker może być starszy tylko przy zgodnym WORKER_LINK_PROTOCOL i obsłudze nowej
bariery/rebind. Zwykłe oznaczenie `v0.3.0-nightly` nie wystarcza i nie oznacza,
że migracja już istnieje. Cel i Maki trzeba najpierw zaktualizować do wydania
z tą funkcją. Dry run pokazuje dokładny build i schemat każdej strony. Te wersje
to deklaracje strony przeciwnej, nie atestacja buildu: chronią przed przypadkową
niezgodnością, a nie przed zmodyfikowanym gatewayem (etap 1 w §12).

Późniejszy zakres source N → target N+1 wymaga jawnego adaptera i testu macierzy;
downgrade danych target < source jest odrzucony. Brak negocjacji/nieznana rodzina
to update required przed kopiowaniem. Sesja pinninguje wersję protokołu,
manifest hash i adapter version; aktualizacja w trakcie wstrzymuje i ponawia
preflight, bez downgrade. W fazie freeze/commit updater ma trwałą blokadę
migracyjną, nie tylko stan w pamięci. Nie zmieniamy `proto/canopy/update/v1`;
dotychczasowe `WORKER_LINK_PROTOCOL` i `DESKTOP_CLIENT_PROTOCOL` pozostają 1,
o ile zmiany są addytywnymi capabilities.

## 6. Kilka połączonych desktopów

Najpierw wykrywamy i zatwierdzamy pełny zbiór domów: także pośrednie komputery,
komputery z Share configuration off oraz domy wskazane przez historyczne ruchy.
Topologia nie udziela prawa eksportu: **każdy dom paruje bezpośrednio z serwerem**
i potwierdza owner map. Nie używamy relay do przenoszenia sekretów. Niedostępny
dom lub oryginał istniejący tylko jako mirror blokuje deklarację „everything”.
Rezygnacja z takiego domu to zmiana zakresu wymagająca jawnej decyzji użytkownika.

1. Wybrany desktop koordynuje UX, a serwer prowadzi trwały wspólny plan.
   Lista źródeł i zależności zostaje zamknięta przed kopiowaniem. Zakończ
   wcześniejsze ComputerMove, rewind, tworzenie worktree i workspace copy.
2. Zbierz konfigurację wszystkich źródeł i wszystkie lokalne aliasy/wersje.
   Źródła o Share configuration on najpierw nadrabiają znane zmiany; nie zakładaj,
   że ich repliki są identyczne. Osobne grupy nie dostają automatycznie prawa
   udostępniania: użytkownik zatwierdza konsolidację w raporcie.
3. Jednorazowo scal wspólne rekordy przez istniejące reguły `config-sync`.
   HLC ma porządek wall_ms/counter/node, ale `edited` wygrywa z nietkniętym
   defaultem, a współbieżne jawne wartości settings/instance/proxy bez ancestry
   tworzą `choice`. **Nie wybieraj arbitralnie ostatniego Maca.** Konflikty,
   sprzeczne aliasy i różne sekrety przy tym samym HLC blokują gotowość.
4. Skopiuj konfigurację workerów i dane domów w stabilnej kolejności node ID,
   równolegle tylko niezależne rodziny. Wątki i boty importuj wyłącznie z domu.
   Finalny delta może ponownie otworzyć konflikt konfiguracji; wróć wtedy do
   raportu i wyboru przed wspólnym commit.
5. Zamroź i przygotuj **wszystkie** domy; jeden commit aktywuje serwer dla całej
   grupy. Następnie przełącz każdy desktop i zewnętrzny worker. Nie kończ na
   pierwszym Macu; raport zawiera listę potwierdzonych i oczekujących urządzeń.

W stagingu zachowujemy każdy źródłowy `config_items.local_id` i domenowe wiersze
potrzebne istniejącym FK. Manifest buduje mapę `(source,kind,local_id)` do celu
oraz kanonicznego global_id. Jeśli ta sama instancja ma na różnych Macach inne
runtime paths/homePath/shadowHomePath, przenieś je do nadpisań właściwego workera,
zanim pojedyncza definicja zostanie zmaterializowana. Nie dziedziczą ich nowe
workery serwera. Wbudowane `native` nadal ma stałe ID. Proxy worker_scoped
pozostaje przypisane wyłącznie do wskazanego workera.

Biblioteka łączy wersje według content hash, zachowując wszystkie wybrane
i historyczne treści oraz mapę lokalnych version numbers. `config_history`
zbiera również historię lokalną wszystkich źródeł (z re-encryption), a nie tylko
to, co zwykle jest przesyłane przez WatchConfig. Tombstone i ancestry nie giną.
Rekordy `worker`/`computer` oraz home_node_id nie uruchamiają na serwerze
materializatora linków: zostają provenance; efektywne workery są lokalnymi
rekordami serwera. Nowe edycje konfiguracji zapisuje już tylko on, z nową epoką
i HLC większym od maksimum. Istniejące HLC autorów pozostają historycznie bez zmian.

Szyna między domami wymaga nowego adaptera: remote parent/child i call IDs
stają się relacjami wewnątrz tego samego ownera. Zachowujemy powiązania i historię,
nie odłączamy rodzica jak zwykłe Unlink. Jeżeli dawna relacja nie mieści się
w obecnych ograniczeniach lokalnych threads (np. placement/depth), przechowujemy
ją jako jawną lineage w mapie migracyjnej i resolverze, bez fałszowania FK
parent_thread_id. Operacje i dostarczenia lokalnej szyny muszą obsługiwać ten
przypadek przed uznaniem etapu za gotowy.

Po cutover każdy komputer jest workerem oraz osobno sparowanym remote klientem
tego samego gatewaya. Gateway server nigdy nie startuje linking/discovery/mDNS,
ConfigSyncService, mirrorów ani relay. Nie wystarczy wstawić peerów jako inactive:
import nie przekazuje im zdolności odtworzenia dawnego zaufania. Stary desktop
ma trwały znacznik przejścia i nie startuje usług lokalnych po restarcie.

## 7. Fazy, weryfikacja i punkt bez powrotu

Stan nowej sesji jest trwały po obu stronach: `paired → preflight → copying →
freezing → verified → prepared → committed → activating → done`. Przed `paired`
cel ma `invited` (zaproszenie bez wymiany), a źródło `pairing` (klucz sesji
zapisany przed wywołaniem `Exchange`, aby ponowienie użyło tego samego klucza). Przed commit
dostępne są `paused`, `blocked`, `aborting → aborted`; błąd po commit oznacza
`recovering`, nigdy automatyczny abort. Stan każdego źródła i każdego workera
jest osobny. Przycisk Cancel nie może zmienić committed w aborted.

### Preflight i dry run

Raport per źródło/rodzina podaje rekordy, rozmiary DB i blobów, liczbę deduplikowanych
obiektów, źródłowe cursors, konflikty, nieobsługiwane pola, braki i aktywną pracę.
Sprawdza pusty cel, miejsce na staging+docelowe dane+WAL+backup, limit dysku Maca,
klucze dostępne w gatewayach, wersje i wszystkie zależności właściciela.
Odczyt wybranych zaszyfrowanych rekordów sprawdza możliwość odszyfrowania bez
ujawnienia wartości. Pełny przebieg weryfikuje każdą wartość, nie tylko próbkę.

Lista lokalnych endpointów proxy/MCP, plików wykonywalnych, CLI homes i ścieżek
wyraźnie odróżnia dane W od rzeczy wymagających osiągalności z serwera. `127.0.0.1`
zewnętrznego CLIProxyAPI na Macu nie będzie osiągalny z gatewaya serwera;
worker może nadal używać swojego loopback proxy, ale management key używa gateway.
Korekta adresu jest osobną zatwierdzoną zmianą konfiguracji w raporcie.

Szacunek czasu = pozostałe bajty / zmierzona przepustowość + zmierzony koszt
importu/indeksów + weryfikacja; pokaż zakres w minutach i osobno przewidywany freeze.
Nie deklaruj stałego czasu dla 1 GB przez Tailscale. Dry run nie uruchamia narzędzi,
modeli, GitHub mutacji, OAuth refresh ani aktywacji harmonogramów.
Raport jest związany z hashem manifestu; istotna zmiana unieważnia potwierdzenie.

### Kopia live, freeze i finalny delta

Podczas copying źródło nadal obsługuje zwykłą pracę. Cel pokazuje tylko owner-scoped
postęp i dane importowane za barierą; nie wolno na nim pisać ani uruchamiać botów.
Przed freeze sprawdzamy tempo zmian: jeśli delta nie maleje, UX proponuje dłuższy
freeze i aktualny szacunek, bez automatycznego zatrzymania pracy.

Freeze najpierw trwale blokuje **nowe przyjęcia pracy** wszystkich producentów:
UI, telefony, szynę, boty, harmonogramy, import CLI, auto-continue/recovery workera
i narzędzia działające w tle. Istniejące tury mogą dostarczyć zdarzenia i wynik.
Poziom DB admission oraz runtime fencing musi przetrwać restart i objąć wszystkie
instancje gatewaya; sam baner lub zatrzymanie jednego planisty nie wystarczy.

Nowa bariera workera czeka na faktyczne idle i potwierdzenie wysłania journalu,
nie wykorzystuje obecnego shutdown jako dowodu łagodnego drain. Trwające zgody
natywnej tury trzeba rozstrzygnąć albo jawnie przerwać turę. Domyślnie czekamy
do 10 minut, potem pokazujemy Wait / Stop current turns / Cancel migration.
Nie przerywamy automatycznie na timeout. Stop jest audytowane; efekty shella
pozostają na dysku, a wynik jest rozliczany jak w [durability.md](durability.md).
Zadania w tle, steery, rewind, przeniesienia i zdalne efekty muszą mieć ustalony
wynik lub jawne `uncertain`; nic nie jest odtwarzane po cichu.

Gdy wszystkie źródła i workery potwierdzą barierę, źródła wstrzymują także edycję
konfiguracji/szkiców, token refresh i maintenance; opróżniają ingest i zapisują
wektor finalnych watermarks oraz brak pracy w locie. Dopuszczalne wyłącznie
RPC sterowania migracją i odczyt. Kopiujemy finalny delta i tombstony. Cel nie
zwraca ACK workerowi za dane, których nie ma trwale w zweryfikowanym imporcie.

### Weryfikacja

Dla każdej rodziny sprawdzamy count, sumę bajtów i kanoniczny SHA-256 posortowanych
rekordów, z podziałem na źródło i zakres kluczy. Transformacje mają dwa manifesty:
hash oryginału i oczekiwaną projekcję po mapowaniu owner/ID; nowy ciphertext,
lease, serial i wygasłe stany nie są błędami równości bajtowej. Raport wymienia
każdą taką różnicę, bez sekretów. Dla sekretów dowód równej wartości i poprawnego
decryption nowym kluczem odbywa się prywatnie między gatewayami, nie hashem w UI.

Weryfikacja obejmuje pełny zbiór blobów, checksum wersji środowiska, domknięcie
FK, aliasy i brak cykli redirect, unikalności idempotencji, max seq/ordinal,
liczniki odczytu, rewind/Undo i lineage. Spot checks czytają przez docelowy store
kilka wątków każdego harnessu: archiwalny, fork, rewind, import CLI, duży załącznik,
szkic z cytatem PR, bot z rutyną. Odczyt nie rozpoczyna tury ani mutacji zewnętrznej.
Stan źródłowo uszkodzony jest blokadą do świadomego rozstrzygnięcia; „verified”
nie może oznaczać „zgodnie pominęliśmy to, czego nie umiemy skopiować”.

### Przygotowanie i trwała decyzja

Serwer jest koordynatorem decyzji. Po weryfikacji i potwierdzeniu użytkownika
każde źródło zapisuje trwałe `prepared`, target pin/session/manifest hash oraz
**fence zabraniający wznowienia lokalnej pracy bez odczytu decyzji celu**.
Cel zapisuje listę prepared receipts wszystkich domów. Nie ma automatycznego
odmrażania przygotowanego źródła po timeout, utracie sieci, Unlink ani restarcie.

**Punkt bez powrotu to commit decyzji `committed` w bazie celu**, po trwałym
przygotowaniu wszystkich źródeł, a przed pierwszą mutacją produkcyjną celu.
Decyzja jest CAS z generation i hashem manifestu; abort oraz commit wykluczają
się transakcyjnie. Serwer nie aktywuje danych przed tą decyzją i zakończoną
materializacją. Nieznany wynik odpowiedzi oznacza GetDecision, nigdy nowy commit.
Backup/restore koordynatora musi zachować dziennik decyzji; przy utracie dowodu
źródła pozostają zamrożone do ręcznego recovery. Nie uznajemy braku rekordu
po restore za uprawnienie do abort.

Przed commit cel może trwale zdecydować abort, usunąć staging tej sesji i wydać
potwierdzenie odmrożenia. Źródła wracają do dawnych endpointów i planistów;
nie revokują tokenów u dostawców, które nadal mają być używane. Po commit
rollback **nie oznacza** włączenia starych gatewayów. Naprawiamy serwer i
dokończamy przełączenie. Ewentualny powrót to osobna migracja najnowszych danych
po zatrzymaniu serwera, z ponowną rotacją credentials i rozliczeniem efektów.
Kopia sprzed cutover nie zawiera nowych tur ani zewnętrznych skutków.

### Aktywacja

Serwer zdejmuje blokadę właściciela dopiero po finalnym imporcie, walidacji
ograniczeń i zapisaniu map workerów. Od tej chwili tylko on wykonuje harmonogramy,
boty i GitHub polling. Źródła pozostają nieodwracalnie fenced dla tej sesji.
Opóźniona odpowiedź/ponowienie commit nie uruchomi drugiego planisty.

`schedules` zachowują run numbers i `missed_policy`; para schedule/run i receipt
chronią przed podwójną turą. Rutyny botów zachowują planowany termin i klucz
żądania; po przestoju działają zgodnie z istniejącym scaleniem zaległych terminów
do jednej tury. `bot_wakeups.delivered`, watchers i raporty zachowują deduplikację.
Nie obiecujemy dokładnie jednokrotnych efektów zewnętrznego HTTP; `uncertain`
pozostaje widoczne i wymaga decyzji.

Moduł PR GitHub obecnie używa **pollingu bez webhooków** (`github/background.ts`,
`watch.ts`, [github.md](github.md#polling-bez-webhooków)). Nie ma rejestru webhooków
do skopiowania ani endpointu do przełączenia. Freeze zatrzymuje polling i refresh
źródeł, cel wznawia je po aktywacji przy zachowaniu backoff i walidacji dostępu.
Webhook skonfigurowany poza Canopy jest pozycją ręcznej checklisty dry run:
zmiana URL/sekretu dopiero w cutover, z testem dostarczenia i deduplikacją dostaw,
bez udawania istniejącej integracji Canopy. Nie poszerzamy tego projektu o webhooky.

Każdy controller zapisuje lokalny checkpoint committed/remote target, nowe
poświadczenie klienta oraz rebind workera. Po potwierdzeniu od celu zatrzymuje
**wyłącznie własny** worker/gateway/PostgreSQL w normalnej kolejności runtime,
przełącza BFF i ponownie uruchamia własny worker z tym samym data_dir.
Restart aplikacji odczytuje checkpoint i nigdy nie wraca sam do local.
UI może działać, gdy worker jeszcze czeka na enrollment; postęp urządzeń jest
widoczny na serwerze. Remote app updates pozostają istniejącym mechanizmem,
nie zastępują migracji ani nie zmieniają kanału.

### Kopia lokalna

Okres to **co najmniej 30 dni od zakończonego cutover** (§13). Lokalny klaster,
klucz źródła w safeStorage i manifest pozostają jako niedziałający backup
z uprawnieniami profilu OS; nie startujemy PostgreSQL tylko dla przeglądania.
Odczyt awaryjny wymaga izolowanej procedury bez workerów, planistów i egress
do dostawców. Starych tokenów nie używamy ani nie revoke u dostawcy, gdy ta sama
autoryzacja jest już na serwerze.

Po 30 dniach aplikacja proponuje Remove local backup, ale usuwa go **wyłącznie
na żądanie**, po potwierdzeniu serwera i wskazaniu dokładnego zakresu. Nie usuwa
journala, sesji, workspace, worktree ani logowań workera. Nie obiecuje wymazania
kopii Time Machine, APFS snapshots, WAL i zewnętrznych backupów.

## 8. Workery, kontynuacja i urządzenia mobilne

Zachowanie worker UUID jest warunkiem v1. Zwykły enrollment tworzący nowego
workera nie wystarcza. Nowe, jednorazowe `migration rebind` wiąże w celu
istniejący UUID z sesją i nowym hashem credentialu. Źródłowy gateway autoryzuje
przekazanie przez dotychczasowy WorkerLink i potwierdza, że to ten worker;
cel sprawdza manifest. Worker dowodzi posiadania nowego challenge przez własny
nowy kanał. Nie można przejąć UUID podając go w formularzu. Starszy worker bez
capability rebind/drain wymaga aktualizacji przed freeze.

Nowy credential dostaje wyłącznie worker, a token UI wyłącznie main/BFF desktopu.
Nie używamy worker credentialu do automatycznej emisji dostępu UI w tej migracji.
Każdy desktop paruje klienta osobno; po przełączeniu `DesktopWorkerService.Confirm`
i `DesktopControlService` odtwarzają istniejące bezpieczne powiązanie obu kanałów.
Przenoszona desktop_worker_migrations nie może przywrócić raz odwołanego dostępu.

`threads.worker_id`, `provider_thread_id`, `provider_profile_id`, `cwd`, workspace,
worktree, `turns.provider_session_id`, `provider_turn_ref` oraz obie sesje rewindu
zostają spójne z lokalnym SQLite i plikami. Konflikty ID instancji rozwiązuje mapa
konfiguracji i **nowy adapter cache workera** bez zmiany katalogu sesji. Wersja
efektywnej konfiguracji rośnie; jawne runtime overrides zachowują stare ścieżki.
Nie tworzymy nowego CODEX_HOME ani własnego loginu jako skutku migracji.

`Resume` i `Edit from here` działają na tym samym komputerze, gdy odpowiednia
sesja/checkpoint nadal istnieje i harness wspiera operację. Grok nie otrzymuje
rewindu, którego dziś nie obsługuje. Zaginiony transkrypt nie jest odtwarzany
z UI jako pełna sesja. Offline worker może zachować odczyt historii, ale nie
przechodzi preflight jako gotowy do bezstratnej kontynuacji, dopóki nie potwierdzi
barier i lokalnych zasobów. Bota nadal wykonuje przypięty worker; always-on gateway
nie czyni uśpionego Maca always-on miejscem inferencji.

Tury queued przechodzą z tymi samymi ID i ruszają dopiero na celu. Running muszą
się skończyć lub zostać świadomie przerwane; nie migrujemy żywego procesu harnessu.
Bot waiting na trwałą zgodę może przejść z checkpointem i kartą, jeśli nie ma
zdalnego efektu w locie; natywna zgoda procesu workera wymaga rozstrzygnięcia.
Paused harmonogram/import zachowuje stan. Wycofane tury, wyniki wykonanych komend
i niepewne MCP nie są startowane ponownie. Journal i started_turns deduplikują
ewentualne replay po rebind.

Telefon wymaga tylko nowego połączenia do serwera, bez logiki migracji bazy.
Dotychczasowy pin i token dotyczą źródła i nie migrują. Ekran Done oraz server
Settings → Devices pokazują nowe zaproszenie/QR dla telefonu; wymiana tworzy
nowy token w SecureStore. Lista starych parowań jest checklistą, nie aktywnymi
credentials. Mobile usuwa cache zakresu starego owner/gateway i bootstrapuje
serwer. Lokalny szkic telefonu wymaga wcześniejszego zapisu do źródła albo jawnego
przejęcia po ponownym parowaniu; zmiana zakresu nie może go po cichu nadpisać.
Automatyczny bezpieczny transfer parowań jest poza v1.

## 9. UX i copy

Wejście w lokalnym desktopie: **Settings → Move to a server**. Jest ukryte
w zwykłym web/mobile i desktop remote. Serwer pokazuje **Import from desktop**
tylko dla właściciela i pustego celu. Istniejące ustawienia Network access,
Devices, Providers i desktop mode pozostają źródłem odpowiednich ustawień;
nowy flow je koordynuje, nie dodaje drugiej konfiguracji tych samych rzeczy.

| Ekran | Treść i akcja (proponowane English UI) |
| --- | --- |
| Wybór i parowanie | `Move to a server`; opis `Your conversations and settings move to the server. This computer keeps running your agents.`; `Pair server`, nazwa/adres/pin w szczegółach i potwierdzenie właściciela na celu |
| Dry run | `Review the move`; źródła, liczby, rozmiary, przedział czasu, co zostaje na komputerach, konflikty i lista reconnect; `Start copying` dopiero po rozwiązaniu blokad |
| Kopiowanie | `Copying to {server}`; `Threads: {done} of {total} · {remaining} remaining`, osobno events/files/bytes i każdy dom; `Pause` i `Resume` dotyczą transferu, nie pracy agentów |
| Freeze | `Ready to switch`; `New work will pause while current turns finish.`; `Pause work and verify`, potem rzeczywiste aktywne tury i czasy; `Stop current turns` wymaga osobnego potwierdzenia |
| Weryfikacja | `Checking the copy`; rodziny verified/remaining; blokada przy różnicy; `Switch to server` z potwierdzeniem `This makes {server} your only gateway. Local backups stay for 30 days.` |

Done: `Connected to {server}` z liczbami zweryfikowanych danych, listą komputerów
`Connected` / `Waiting for this computer`, akcjami `Open conversations`,
`Reconnect phone` i późniejszym `Remove local backup`. Nie nazywaj migracji
ukończoną, gdy jeden dom jest nieskopiowany; po commit dane mogą być gotowe,
a konkretne klienty jeszcze wymagać reconnect. Nie pokazuj 100% dla nieznanej
liczby pozostałych rekordów ani ETA podczas pauzy.

Cel przed aktywacją: trwały baner `Importing from desktop · Changes are paused`.
Pozwala czytać postęp, ale nie częściowy zbiór prywatnych danych jako gotowe konto.
Po materializacji dostęp do podglądu weryfikacyjnego ma tylko właściciel.
Blokada zapisów i uruchomień jest w gateway/DB; direct RPC nie omija banera.

Błędy są wznowieniami tej samej sesji: `Connection lost. Copying will resume
when the server is reachable.`; `The server's identity changed. Pair it again
before continuing.`; `The copy did not match. Retry verification.`; `Target has
existing data. Choose an empty server.` Po commit: `The move is committed.
Reconnect to finish switching this computer.` Bez przycisku przywracającego local.
Szczegóły pokazują kod i rodzinę za `Show details`, bez payloadu/credentiali.

Copy audit według [copy.md](copy.md#8-copy-audit-after-a-feature-checklist):
proponujemy `Move to a server`, zamiast technicznego „database export/import”;
`Pause work and verify` nazywa rzeczywisty skutek; komunikaty błędów podają
działanie, bez humoru i gwarancji czasu. Status nie opiera się na kolorze.
W etapie 0 nie zmieniamy UI i nie deklarujemy przeglądu wizualnego. Implementacja
wymaga ręcznej kontroli light/dark, szerokości desktop/phone, krótkich i długich
nazw, focus/keyboard/reduced motion, bez testów web UI.

## 10. Bezpieczeństwo i audyt

| Zagrożenie | Ochrona i granica |
| --- | --- |
| Podszyty lub wrogi serwer | Pin z zaufanego UI przed kodem/sekretem, jawny wybór celu i zakresu na obu stronach. Pin chroni tożsamość, nie uczciwość operatora: zatwierdzony serwer otrzymuje dane i sekrety, więc należy do granicy zaufania |
| MITM, przejęta trasa | TLS 1.3, wzajemny pin, bez TOFU/redirect/TLS exceptions; MagicDNS/Tailscale tylko jako transport. Błąd pinu nigdy nie uruchamia fallbacku bez tego samego pinu |
| Częściowa kopia, crash, split brain | Trwałe ACK/checkpoint, staging, pełna weryfikacja, prepared fence na wszystkich źródłach i jedna niezmienna decyzja celu; brak automatycznego odmrożenia przy nieznanej decyzji |
| Replay, downgrade, podmiana źródła | Session/source/generation/owner/manifest w każdym RPC, hash klucza idempotencji, jednorazowe parowanie, expiry/revoke, pin wersji adaptera. Stara komenda workera nie omija rebind/fence. Wersje są deklaracjami peera, nie atestacją: zmodyfikowany peer przechodzi kontrolę wersji, ale nie piny, certyfikat sesji ani potwierdzenia ownerów |
| Logi, temp, nieograniczony import | Re-encryption przed persistence, brak payload logs/traces/error echo, typowane limity rozmiaru i backpressure, izolacja ownera, deny unknown family, brak arbitralnego storage_url/SQL/ścieżki |

Dowód owner scope opiera się na następujących niezmiennikach, sprawdzanych
w integracji przy dwóch ownerach i znanych cudzych UUID:

1. Uprawnienie sesji powstaje po uwierzytelnieniu obu gatewayów i wiąże dokładną
   parę ownerów. Request nie wybiera target_owner ani nie zmienia listy źródeł.
2. Eksporter filtruje każdą tabelę ownerem lub przejściem przez własny zasób:
   event→thread, tool→turn→bot, cursor→worker, blob→dozwolona referencja.
   NULL/global nie jest wildcardem; niezależne zasoby innej osoby nie przechodzą.
3. Staging, mapy, postęp, resume, audit i importer używają owner/session/source
   w zapytaniach. Przy każdym FK sprawdzają zgodnego ownera; UUID ani hash
   nie autoryzuje. Nieistniejący i cudzy zasób mają tę samą odpowiedź bez tytułu.
4. Cel wyznacza owner z sesji, ignoruje deklaracje payloadu i nie podnosi roli.
   Granty connectorów oraz powiązania kont GitHub po mapowaniu nadal wskazują
   wyłącznie zasoby tego ownera. Poświadczenie migracji nie autoryzuje zwykłego UI.
5. Freeze i activation fence są sprawdzane przez każdy producent zapisu/efektu,
   również tło i WorkerLink; odebranie credentialu zamyka streamy. Po commit
   źródło nie ma ścieżki wykonawczej, nawet po restarcie bez sieci.

Obie strony dopisują `audit_log` z nowymi akcjami `server_migration.pair`,
`.negotiate`, `.preflight`, `.start`, `.pause`, `.resume`, `.freeze`, `.verify`, `.prepare`,
`.commit`, `.activate`, `.abort`, `.worker_rebind`, `.client_switch`, `.cleanup`.
Audit zawiera actor, source/target node, session/generation, fazę, liczniki,
hash manifestu, decyzję i sklasyfikowany powód. Bez nazw prywatnych repo,
treści rozmów, adresów prywatnych, kodów, tokenów, ciphertext ani hashy sekretów.
Historyczny audyt zachowuje źródłową proweniencję, a nowe wpisy są lokalnym
dowodem odbioru/commit. Wycofanie dostępu migracji odcina transfer, lecz nie
usuwa decyzji ani nie daje prawa do rollbacku po commit.

## 11. Plan testów i kryteria akceptacji

Testy implementacji są meaningful integration/durability/security/migrations,
bez component tests i Playwright. Projekt nie jest dowodem wykonania tych testów.
Uruchomienie integracji z DB, testu dużych danych lub ręcznej kontroli runtime
wymaga odrębnego zakresu weryfikacji zgodnego z obowiązującymi instrukcjami;
nie uruchamiamy ich w etapie dokumentacyjnym.

| Zestaw | Warunki i dowód zakończenia |
| --- | --- |
| Dwa prawdziwe gatewaye i PostgreSQL | Nowe `tests/integration/server-migration*.test.ts`: różne secrets keys, pinned TLS, rzeczywiste stores; pełen fixture każdej rodziny, seq i wszystkich referencji; cel rolą server z nieaktywnym linking; porównanie manifestu po cutover |
| Crash/resume i fencing | Zabicie każdego gatewaya przed/po ACK porcji, w final delta, po prepared, między commit i odpowiedzią, podczas materializacji/rebind/client switch. Po restarcie jedna decyzja i jeden wykonawca; brak utraty zdarzeń i dubla tury/efektu; split sieci i nieosiągalny koordynator pozostawiają źródło fenced |
| SQL migrations i graph | `packages/db/test/schema.test.ts` z nowymi numerami; upgrade aktualnej bazy, brak zmian zastosowanych migracji, cykle FK, immutable placement, serial collision, alias instance/native, zachowanie rewind/Undo, bot read seq i draft receipts |
| Security/owner/version | Drugi owner i cudze UUID/hash, podmiana owner/source, replay kodu/chunka/commit, zły pin, certyfikat linka na server, worker/mobile token w migracji, revoke stream, downgrade, nieznane pole/tabela, temp/log/plaintext scan ze sztucznym sekretem; po decryption na celu wartości zgodne, ciphertext różny |
| Wiele Maców i dane duże | Trzy domy, różne grupy config, konflikt jawnych settings/secrets i HLC ancestry, repliki nieidentyczne, boty/wątki każdego domu; osobno 500 wątków, **100 000 zdarzeń łącznie**, 1 GiB unikalnych załączników plus miniatury, pojedynczy plik >40 MiB, przerwanie w połowie blobu |

Duży test mierzy wall time każdej fazy, czas freeze, przepustowość, max RSS,
przyrost WAL/staging, liczbę retry i bajty po wznowieniu. Raport pomiaru trafia
do opisu PR poza repo; nie wpisujemy wymyślonego wyniku. Warunek: zgodne count,
checksums i graf, brak dubli oraz pamięć ograniczona porcjami, nie rozmiarem
historii/bloba. Weryfikujemy, że po wznowieniu nie jedzie ponownie cały 1 GiB.
Budżet czasu freeze ustalimy po pomiarach na LAN i ograniczonym łączu; UX pokazuje
zmierzony zakres. Opcjonalny osobny soak może użyć 100 000 zdarzeń **na wątek**,
bez niejawnego pomnożenia bazowego fixture do 50 mln zdarzeń.

Osobne testy harness adapterów używają istniejących fake CLI, rzeczywistego
WorkerHost i journalu: ta sama sesja Claude/Codex/Grok po rebind, nowe tury,
fork/rewind według rzeczywistych capabilities, lokalny login i ścieżki bez zmian.
Natywny macOS wymaga ręcznego sprawdzenia Keychain/safeStorage, podpisanego
desktopu, restartu i braku PostgreSQL/gatewaya w remote. Live modele wyłącznie
opt-in, z `CANOPY_LIVE=1`, bez eksportowania prawdziwych sekretów w fixture.
E2E i realną migrację wykonuje się dopiero po uzyskaniu osobnej zgody.

Dla przyszłego stosu obowiązują również repo checks: `bun install`,
`bun run gen:check`, typecheck, lint, format:check, check:tmp i web build,
w zakresie dozwolonym na etapie implementacji. Stage 0 sprawdza wyłącznie
formatowanie oraz istniejący doc lint, jeśli jest skonfigurowany.

## 12. Dostarczenie jako stos PR

Etap 0: `docs(migration): design desktop to server migration` — ten dokument,
draft do `dev`, bez SQL, kodu, Fixes ani zmiany produkcji. Kryterium: kompletny
inwentarz i konkretne decyzje do zatwierdzenia, udokumentowane ograniczenia,
formatowanie i przegląd zgodności ze źródłami.

Poniższe numery zakładają najwyższy numer 0146 na `dev`
(sprawdzone 2026-11-15; żaden otwarty PR nie zajmuje 0147–0152).
Nie są rezerwacją numerów. Przed każdym PR sprawdź aktualne dev; w razie zajęcia
przenumeruj nowy SQL, import w loaderze i expected list w schema.test.ts.
Nie zmieniaj zastosowanych migracji. Każdy etap jest osobną gałęzią/PR opartą
na poprzedniej; najniższy do `dev`. Cały stos pozostaje draft do ukończenia
i weryfikacji całości, potem wspólny `gh stack merge <stack> --squash`.
Funkcja nie jest publikowana częściowo.

| Etap i Angular title | Zakres i SQL | Testy i done |
| --- | --- | --- |
| 1. `feat(migration): add secure server migration sessions` | Nowe proto/pairing/capabilities i gate pustego celu; `0147_server_migration_sessions.sql`: sesje, źródła, powiązane uprawnienia i owner fence. Zmiana dispatchera tylko dla migracyjnego mTLS | Dwa gatewaye, schema, pin/replay/revoke/owner, odmowa zwykłego certyfikatu linka na server. Done: autoryzowana sesja i dry-run negotiation, zero danych/efektów bez niej |
| 2. `feat(migration): stream resumable gateway snapshots` | Eksport wszystkich rodzin, manifests, bounded chunks, sekrety i storage; `0148_server_migration_transfer.sql`: staging records/fragments, manifests, checkpoints, ID maps; `0149_server_migration_changes.sql`: pełny dziennik live i ochrona retencji | Snapshot każdej tabeli, dwa klucze, duży blob, ACK/crash, zmiany/usunięcia podczas copy. Done: odtwarzalna kompletna kopia live bez plaintext persistence i dziur delt |
| 3. `feat(migration): consolidate desktop homes and references` | Konsolidator config HLC, lokalnych runtime overrides, bot seq, PR/account aliases, typed draft i lineage resolver; `0150_server_migration_references.sql`: trwałe mapy dawnych domów/referencji i lineage niemieszczącej się w FK | Trzy domy, conflict choice/ancestry, kolizje slug/serial, fork/rewind, drafts/citations, connector grants. Done: wynik zależy od wersji/wyboru, nie kolejności transferu; każda referencja się rozwiązuje |
| 4. `feat(migration): fence sources and commit server cutover` | Preflight/freeze/drain/verify, decyzja i activation, bramki wszystkich producentów; `0151_server_migration_cutover.sql`: prepared receipts, niezmienna decyzja i trwałe fencing. Harmonogramy/boty/GitHub polling | Crash matrix, kilka instancji gatewaya, race commit/abort, niepewne MCP, stop/timeout, scheduler dedup. Done: zero mutacji częściowego celu i dokładnie jeden aktywny dom po decyzji |
| 5. `feat(migration): rebind workers and switch desktop clients` | Addytywny WorkerLink barrier/rebind, bez zmiany frozen update; `0152_server_migration_workers.sql`: stan przekazania UUID i jednorazowych credentiali, bez plaintext. Atomowe checkpointy main/controller, remote BFF, zachowany data_dir, parowania telefonów | WorkerHost/journal/harness adapter integration, restart na każdym kroku, dwa kanały desktop/worker, stare credentials odrzucone, natywna kontrola macOS po zgodzie. Done: te same sesje i rewind, remote bez lokalnej DB/gatewaya na każdym komputerze |
| 6. `feat(migration): guide desktop moves to a server` | Kompletny UX, reports/errors/resume, read-only banner i cleanup na żądanie; bez nowej migracji SQL. Uzupełnienie docs dla nowej działającej procedury | Bez UI suites; testy gateway scope/progress, pełny crash i large-data test, ręczny copy/accessibility/light-dark/width review. Done: wszystkie kryteria §11, jawny wynik każdego domu/workera, raport czasu i checklist reconnect; stos gotowy do wspólnego review |

### Etap 1: doprecyzowania z implementacji

Etap 1 (`apps/gateway/src/server-migration/`, `proto/canopy/migration/v1`,
`0147_server_migration_sessions.sql`) ustala następujące szczegóły, których
projekt wcześniej nie rozstrzygał:

- **Dowód node ID.** `ExchangeMigrationPairing` niesie certyfikat komputera źródła
  i podpis jego kluczem nad sesją, zaproszeniem, pinem certyfikatu sesji i pinem
  celu. Sam deklarowany node ID nie wystarcza, a podpis nie działa dla innego
  serwera ani innego certyfikatu sesji.
- **Kod.** 256 bitów, w bazie tylko SHA-256; 5 błędnych prób unieważnia
  zaproszenie. Niezgodna wersja i niepusty cel są odrzucane przed zużyciem kodu,
  więc po aktualizacji to samo zaproszenie nadal działa. `ExchangeMigrationPairing`
  przyjmuje wyłącznie HTTP/2 po TLS 1.3; pozostałe trasy urządzeń nadal
  dopuszczają TLS 1.2 dla starszych telefonów.
- **Próba parowania na źródle.** Klucz sesji, `source_id` zaproszenia i szyfrowane
  adresy celu są zapisywane w jednej transakcji przed `Exchange`. To samo
  zaproszenie ponownie (utracona odpowiedź) używa tego samego klucza. Inne
  zaproszenie, gdy nic nie zostało wymienione, atomowo zastępuje próbę nowym
  kluczem i nowym `source_id`; zmieniony pin przy tym samym `source_id` jest
  odmową. Dopóki sesja jest w `pairing`, każda próba przypina wersje bieżącego
  buildu (aktualizacja między próbami nie jest downgrade'em, bo nic nie sparowano);
  od wymiany wersje są przypięte, a zmiana wymaga nowej sesji.
- **Adresy celu.** Origins Network access serwera są adresami prywatnymi:
  na źródle leżą wyłącznie jako koperta AES-GCM kluczem sekretów gatewaya
  i są odszyfrowywane tylko do połączenia. Uszkodzona lub obca koperta to odmowa
  „pair again”, bez ujawniania wartości.
- **Kanał mTLS.** Na roli `server` każde połączenie z certyfikatem klienta trafia
  do gałęzi migracji, która przepuszcza wyłącznie aktywny certyfikat sesji
  (nieodwołany, nieprzeterminowany, otwarta sesja) i tylko `MigrationService`
  po HTTP/2 TLS 1.3; wszystko inne dostaje 403, jak dotąd każdy certyfikat na
  serwerze. Owner i sesja pochodzą z certyfikatu, nie z żądania.
- **Pusty cel.** `server_migration_occupied(owner)` (SQL, 0147) jest deny-by-default:
  każda tabela z wierszem blokuje, poza tabelami runtime
  (`server_migration_runtime_tables()`: tożsamość i Network access serwera,
  zegary i limitery, diagnostyka, urządzenia operatora, audit, tabele migracji)
  i dokładnymi wierszami bootstrapu (`server_migration_default_row`): projekt
  scratch, nietknięte wbudowane `native` w `provider_instances` i ich nietknięte
  rekordy `config_items`. Zmieniony wiersz `native` (np. favorites), edytowany
  scratch, `user_settings` czy drugi użytkownik to dane.
- **Rezerwacja.** Jeden wiersz `server_migration_reservation` na bazę. Każdy
  chroniony zapis trzyma do commit współdzieloną blokadę transakcyjną (advisory,
  tylko w pamięci, bez zapisu wiersza). Rezerwacja, wymiana kodu i abort biorą ją
  wyłącznie i dopiero potem, w nowej instrukcji, sprawdzają pusty cel: czekają
  na zapisy w toku i widzą to, co zatwierdziły. Zapis rozpoczęty później czeka
  i widzi rezerwację. Zapis poza READ COMMITTED dodatkowo blokuje wiersz
  `FOR SHARE`, więc starszy snapshot kończy się błędem serializacji zamiast
  przejść. Wybraliśmy to zamiast SERIALIZABLE, bo nie zmienia izolacji reszty
  gatewaya, a koszt to blokada w pamięci przy insertach do tabel-korzeni.
- **Zakres ochrony.** `server_migration_fence_plan()` liczy pokrycie z katalogu:
  tabele bootstrapu mają trigger na INSERT, UPDATE i DELETE (wiersz domyślny
  i niezmieniony UPDATE przechodzą, więc restart serwera działa), pozostałe
  tabele-korzenie trigger na INSERT. Tabela z nieodraczalnym kluczem obcym
  NOT NULL do tabeli chronionej nie może dostać wiersza, więc gorące tabele
  (zdarzenia, itemy, komendy) nie mają triggera; UPDATE/DELETE w pustych
  tabelach nic nie zmienia. Migracja dodająca tabelę wywołuje
  `SELECT server_migration_install_fences();`;
  `packages/db/test/server-migration-fence.test.ts` nie przejdzie dla tabeli
  ani runtime, ani chronionej, ani pokrytej.
- **Wygaśnięcie.** Odstępstwo od §3: sesja, w której żaden dom jeszcze nie
  sparował, przestaje rezerwować serwer po wygaśnięciu ostatniego zaproszenia;
  inaczej zapomniane zaproszenie zablokowałoby serwer bez końca. Wymiana kodu
  po wygaśnięciu albo nad nowymi danymi jest odrzucona. Od pierwszej wymiany
  rezerwacja trwa do abort lub zakończenia. Etap 2 dodaje jawny wyjątek dla
  importera.
- **Wersje to deklaracje, nie atestacja.** Protokół, capability, build i schemat
  w `Exchange`/`Negotiate` deklaruje strona przeciwna; zmodyfikowany gateway może
  skłamać. Sprawdzenie chroni przed przypadkową niezgodnością, a bezpieczeństwo
  opiera się na pinach, certyfikacie sesji, potwierdzeniu obu ownerów i kontroli
  ownera w celu. Build bez wersji wydania (`0.0.0-dev`, brak `CANOPY_VERSION`)
  nie mówi nic o kodzie: taka strona jest odrzucana, chyba że gateway jawnie
  dopuszcza buildy deweloperskie (`CANOPY_SERVER_MIGRATION_DEV_BUILDS=1`,
  lokalne stacki i testy).
- **Potwierdzenie pinów.** Cel odrzuca `Negotiate`, dopóki właściciel na serwerze
  nie potwierdzi pinu certyfikatu sesji domu; źródło nie wywołuje `Negotiate` bez
  potwierdzenia pinu celu. Negocjacja jest dry run: wersje i pusty cel, bez danych.
- **Uprawnienia UI.** RPC migracji są w `GatewayService`; telefon dostaje
  `PermissionDenied`, desktop client ownera jest dozwolony. Strona celu działa
  tylko na roli `server`, strona źródła tylko na roli `desktop`.

Nowe SQL mogą zostać podzielone inaczej po szczegółowym review, ale numery muszą
pozostać monotoniczne. Etapy 1–5 same nie dają prawa do przeniesienia danych
produkcyjnych. Próba na kopii oraz rzeczywisty cutover mają osobne potwierdzenie
raportu i skutków w produkcie, niezależne od scalenia kodu.

## 13. Decyzje użytkownika (2026-11-15)

Użytkownik przyjął wszystkie rekomendacje projektu. Poniższe decyzje są
wiążące dla etapów 1–6; zmiana którejkolwiek wymaga aktualizacji tego dokumentu.

### Zakres i dane

1. **Cel musi być pusty w v1**, z ograniczonym bootstrapem opisanym w §3.
   Scalanie z używanym serwerem wymaga osobnego projektu konfliktów.
2. **Wszystkie połączone Maki migrują razem, jednym cutover**, po jawnym
   zatwierdzeniu pełnej listy domów. Offline dom blokuje przełączenie.
   Share configuration off nie jest zgodą na automatyczne scalenie tej grupy.
3. **Lokalny backup zostaje co najmniej 30 dni**, bez automatycznego usunięcia;
   po tym terminie usuwamy go wyłącznie na żądanie użytkownika.
4. **Brakujące lub uszkodzone bloby i sesje naprawiamy albo jawnie akceptujemy
   konkretny brak w raporcie.** Do tego czasu obietnica 1:1 jest zablokowana.
   Nie zastępujemy sesji podsumowaniem ani nową rozmową.

### Przełączenie i dostępność

5. **Aktywne tury przy freeze: po 10 minutach pytamy człowieka**
   (Wait / Stop current turns / Cancel migration); domyślnie dalsze czekanie,
   nigdy automatyczny Stop. Długość freeze potwierdzimy po pomiarze dużych danych.
6. **Telefony i inne klienty remote parują ponownie** z nowymi credentials
   i pinem celu, bez kopiowania hashy i starego zaufania.
7. **Boty przy uśpionych Makach:** gateway na serwerze działa stale, ale inferencja
   zostaje na dotychczasowych workerach. Bot działający 24/7 wymaga osobnego
   always-on workera i świadomego wyboru loginu/środowiska; migracja tego
   nie tworzy automatycznie.
8. **Lokalne proxy i serwery MCP: jawna konfiguracja osiągalności** — przypięte,
   uwierzytelnione endpointy przez istniejącą sieć, po wykazaniu potrzeby.
   Bez automatycznego wystawiania portów i zmian Tailscale ACL/Serve w tle.
   Niedostępny wymagany connector/Management API wykazujemy przed zatwierdzeniem.

### Zgodność i konta

9. **Ten sam build migracyjny na każdej stronie:** wszystkie źródła i cel
   aktualizujemy do identycznego wydania z `server_migration_v1`; sam napis
   wersji kanału nie potwierdza obsługi funkcji.
10. **GitHub i OAuth: zachowujemy zgodne rejestracje** (ta sama GitHub App,
    zarejestrowane redirecty). Różnice wykazujemy jako wymagające reconnect,
    zamiast przenosić niezgodną autoryzację. Współbieżne tokeny tego samego
    konta wybieramy w dry run, bez losowej rotacji.
11. **Szkice offline: przed freeze podłączamy urządzenia i potwierdzamy zapis
    szkiców** w gatewayach. Lokalny szkic zostaje do receipt migracji,
    bez czyszczenia przy zmianie zakresu.
12. **Zewnętrzne webhooki: osobna checklista.** Canopy dziś używa pollingu,
    więc przenosimy wyłącznie polling. Webhook skonfigurowany poza Canopy jest
    pozycją ręcznej checklisty zmiany endpointu w cutover; nie dodajemy
    nowego subsystemu webhooków.

## Źródła i ścieżki do dalszego review

Granice systemu: [architecture.md](architecture.md), [data-model.md](data-model.md),
[secrets.md](secrets.md), [desktop.md](desktop.md),
[desktop-remote-frontend.md](desktop-remote-frontend.md).
Transport i instalacja: [linked-computers.md](linked-computers.md),
[network-access.md](network-access.md), [tailscale.md](tailscale.md),
[deploy.md](deploy.md), [updates.md](updates.md), [release.md](release.md).
Wykonanie i historia: [worker-config.md](worker-config.md), [threads.md](threads.md),
[durability.md](durability.md), [transcript.md](transcript.md), [import.md](import.md).
Konfiguracja: [provider-accounts.md](provider-accounts.md), [proxies.md](proxies.md),
[connectors.md](connectors.md), [bots.md](bots.md),
[agent-environment.md](agent-environment.md), [worktrees.md](worktrees.md),
[github.md](github.md), [copy.md](copy.md).

Review implementacji powinien zacząć się od pokrycia tabel i wszystkich producentów
zapisu/efektów, następnie dowodu fencing/commit po crash, mapowania workerów
i re-encryption. Dopiero te dowody pozwalają przyjąć migrację produkcyjną 1:1.
