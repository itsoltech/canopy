# Linked computers — weryfikacja etapu 2

Data: 2026-11-03. Gałąź: `feat/linked-computers-2` na `origin/feat/linked-computers-1`
(`f85e23b`). Zakres: etap 2 [projektu](../../../docs/linked-computers.md) — zsumowany overview
i zdalne wątki. Bez pushowania, PR-ów i wdrożenia.

## Wynik

- `canopy.link.v1`: addytywne ramki `remote_request`/`remote_response`/`remote_cancel` (6–8),
  capability `remote_threads`; `COMPUTER_LINK_PROTOCOL` bez zmian (1). Uzasadnienie w
  „Konkretny protokół etapu 2”.
- `canopy.ui.v1`: `node_id` (800) w `Thread`/`Worker`/`Project`, `GetOverviewResponse.computers` (800),
  `OverviewUpdate.computer`/`computer_removed` (800/801), `LinkedComputer.capabilities` (14).
- Trasowanie w gatewayu (`api/routed.ts`), id `<uuid>~<node16>`, lista dozwolonych metod u domu,
  szybki błąd z powodem obecności, brak kolejkowania. Bez migracji.
- UI: znaczek maszyny (sidebar, nagłówek wątku, karta podglądu, pickery), banner „Read only for now”
  z zablokowanym composerem i kartami zgód, strona błędu z powodem dla bezpośrednio otwartego
  wątku niedostępnego partnera, stan „Needs an update” w Settings → Linked computers.

## Testy

`tests/integration/remote-threads.test.ts` (dwa gatewaye, dwie bazy PostgreSQL, mTLS): **10 pass**.
Regresje `linked-computers`, `gateway-ui`, `attachments`, `quotes`: **46 pass**.
Wynik pełnego `bun run check:tmp` w raporcie przekazania.

## Kontrola w przeglądarce

Dwa własne gatewaye (harness poza repo, skryptowane workery, prawdziwe łącze mTLS na 18631/18632)
i dwa produkcyjne BFF (`apps/web` build) za proxy `x-forwarded-proto` na 18621/18622; Chromium przez
`playwright-core` poza repo. Light i dark, 1440 × 900 i 390 × 844: bez `pageerror` i bez poziomego
overflow. Obejrzane: wątek B na A z zgodą na żywo, picker projektu z projektami B, Settings B,
banner po wyłączeniu łącza B, odświeżenie wątku przy niedostępnym B, „Needs an update” na A.

| Widok | Plik |
|---|---|
| Wątek B na A, desktop jasny | [online-thread-desktop-light.png](online-thread-desktop-light.png) |
| Wątek B na A, telefon ciemny | [online-thread-phone-dark.png](online-thread-phone-dark.png) |
| Nowy wątek: picker projektu, desktop ciemny | [online-home-desktop-dark.png](online-home-desktop-dark.png) |
| Nowy wątek, telefon jasny | [online-home-phone-light.png](online-home-phone-light.png) |
| B odszedł przy otwartym wątku, desktop jasny | [away-open-desktop-light.png](away-open-desktop-light.png) |
| B odszedł przy otwartym wątku, telefon ciemny | [away-open-phone-dark.png](away-open-phone-dark.png) |
| Wątek B otwarty przy niedostępnym B | [away-fresh-desktop-light.png](away-fresh-desktop-light.png), [away-fresh-phone-dark.png](away-fresh-phone-dark.png) |
| Partner bez `remote_threads` | [needs-update-settings-A-desktop-dark.png](needs-update-settings-A-desktop-dark.png), [needs-update-settings-A-phone-light.png](needs-update-settings-A-phone-light.png) |

Własne procesy i kontenery testowe zatrzymano; porty maintainera, `/tmp/oa-stack` i `~/canopy`
nietknięte.

## Granice dowodów

- Harness używa skryptowanych workerów; nie uruchamiano prawdziwych CLI dostawców na B.
- Loopback Linux; bez NAT/VPN i bez pakowanego desktopu.
- Odroczone celowo: lustra offline (3), wspólna konfiguracja, harmonogramy, sekrety i connectory
  partnera (4), boty/szyna agentów (5), archiwum i wyszukiwanie wątków partnera na A.
