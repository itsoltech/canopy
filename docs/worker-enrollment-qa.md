# Enrollment workerów — weryfikacja

Data: 2026-11-02. Branch: `feat/add-worker-wizard`. Bez push i PR.

## Implementacja

Token enrollment ma 256 bitów entropii, 30 minut ważności i pojedyncze użycie.
Gateway przechowuje SHA-256, właściciela, nazwę i metadane użycia; worker nie wybiera
właściciela. Istniejący kontrakt `WorkerEnrollmentService.Enroll` działa anonimowo
na porcie gRPC, z limitem 60 prób/minutę/proces. Blokada wiersza oraz jedna transakcja
obejmują utworzenie workera, konfigurację, instancje i zużycie tokenu. Błędy nie
zwracają sekretu ani szczegółów SQL. Rotacja i revoke zamykają link i unieważniają
rozpoczęte handshaki. Operacje mają audyt bez sekretów.

Kreator korzysta z overview SSE, dotychczasowych przypisań instancji i istniejącego
kitu Svelte. Osobny pass **componentize** wyodrębnił instalację, status połączenia,
wybór instancji, opis instancji, blok komendy, wiersz i menu workera. Wspólne kontrolki
oraz style segmentów pochodzą z kitu. Ruch: `Dialog`/`t-modal`, `pageIn` dla etapów,
`Disclosure`/`expand`; istniejąca obsługa reduced motion.

## Weryfikacja automatyczna

- `bun install` — sukces.
- `bun run typecheck` — sukces, Svelte: 0 błędów i 0 ostrzeżeń.
- `bun run gen:check` — sukces, wygenerowane kontrakty zgodne.
- `bun run --filter @canopy/web build` — sukces; istniejące ostrzeżenie o dużym chunku.
- `bun run check:tmp --parallel=2` — sukces: **612 pass, 141 skip, 0 fail**, 3290 asercji,
  125 plików, 231,91 s; brak pozostałości testów w prywatnym katalogu tymczasowym.

`tests/integration/worker-enrollment.test.ts` sprawdza CLI → gRPC → PostgreSQL:
0600 i odmowę nadpisania przed zużyciem tokenu, `--force`, połączenie z zapisanym
configiem, wyścig dwóch wymian, zużyty/wygasły/odwołany token, obcego właściciela,
hashe zamiast plaintextu, brak sekretów w metadanych i błędach, limit prób,
rotację, odrzucenie starego credentialu, revoke, archiwizację workspace'u,
zachowanie historii i audyt. `worker-link.test.ts` dodatkowo wymusza zmianę dostępu
w trakcie uwierzytelnionego, niedokończonego handshake'u. Test schematu uwzględnia 0044.

Pierwszy pełny `check:tmp` został przerwany SIGTERM (143), bez błędu asercji;
kontrola sprzątania nie wykazała pozostawionych plików. Cały zestaw ponowiono
z dwoma izolowanymi procesami plików testowych. Nie dodano testów web UI ani
drobnych testów odzwierciedlających implementację.
Pominięto testy live wymagające zewnętrznych usług/poświadczeń. Wrapper zgłosił
jedynie katalog runtime narzędzia `claude-1000`, wyłączony z kontroli zgodnie
z istniejącą polityką `check:tmp`; prywatny katalog został usunięty.

## Chromium i prawdziwy drugi worker

Własny stack: PostgreSQL `38544`, gateway `18544`, web `5281`. Nie korzystano
z prywatnego stacka live, portów `17443`/`5180`/`8444` ani `dev-live.env`.
Chromium: `/usr/bin/chromium`, Playwright Core z `/tmp/ro-shot`,
`extraHTTPHeaders: {"x-forwarded-proto":"http"}`.

| Przepływ | Wynik |
|---|---|
| Add worker → kopiowanie komendy → wykonanie jej w osobnym data dir → Connected | sukces; rzeczywisty drugi lokalny proces, Claude 2.1.308 i Codex 0.164.0 |
| Instancje → przełączenie Codexa off/on → Finish | sukces |
| macOS/clone → regeneracja tokenu → zamknięcie → Revoke zaproszenia | sukces |
| Rename → Rotate credential → aktualizacja prywatnego configu → ponowne połączenie | sukces |
| Revoke → stan Revoked → Archive → usunięcie wiersza | sukces |

Jasny/ciemny motyw przy 1440 i 390 px: brak błędów JS i poziomego overflow.
Rozwinięte szczegóły pokazują m.in. `Claude · Native`, `Codex · Native`,
`Grok · Native — not signed in`. Wygenerowany unit przeszedł
`systemd-analyze --user verify`. Usługa nie była instalowana w profilu użytkownika.

Artefakty lokalne (na maszynie wykonującej zadanie):

```text
/tmp/canopy-enrollment-qa-5ef7/
  check-tmp.log                # przerwany pierwszy przebieg
  check-tmp-parallel.log       # pełny ponowny przebieg
  typecheck.log, web-build.log
  screenshots/01-name-light-1440.png
  screenshots/02-install-light-1440.png
  screenshots/03-waiting-light-1440.png
  screenshots/04-connected-light-1440.png
  screenshots/05-providers-light-1440.png
  screenshots/06-providers-dark-1440.png
  screenshots/07-workers-dark-1440.png
  screenshots/08-workers-dark-390.png
  screenshots/09-workers-light-390.png
  screenshots/10-macos-light-390.png
  screenshots/11-macos-dark-390.png
  screenshots/12-details-light-390.png
  screenshots/13-details-dark-390.png
  screenshots/14-rotation-dark-1440.png
  screenshots/15-revoked-dark-1440.png
  screenshots/16-provider-chips-light-390.png
  screenshots/17-provider-chips-dark-390.png
```

Tokeny i credential są ukryte na zrzutach. Skrypty diagnostyczne i zrzuty nie są
częścią testów repozytorium. macOS sprawdzono jako wariant kreatora/komendy;
nie uruchamiano workera ani launchd na fizycznym Macu. Nie wykonywano zadań LLM
przez produkcyjny CLIProxyAPI. Worker jest dystrybuowany z repo, bez gotowej binarki.

## Następna maszyna i wdrożenie

Pełna procedura dla Maca/Tailscale oraz usługi: [worker-config.md](worker-config.md#dodanie-maszyny-z-ui).
Po merge zachowaj dotychczasowe klucze gateway i token usługi BFF, wykonaj migrację
0044 (standardowy start gateway z `CANOPY_MIGRATE=1` robi to automatycznie), zbuduj web
i zrestartuj gateway/web z tej samej wersji. Istniejące configi workerów pozostają zgodne.

Włącz Settings → Network access i użyj jego adresu w Settings → Workers.
Sprawdź, że polecenie enrollment zawiera `--fingerprint` z pełnym SHA-256.
ACL/firewall muszą przepuszczać wybrany port TCP z nowej maszyny. To wspólny port TLS,
nie port web ani port procesu BFF. Dawne instrukcje env poniżej zastępuje [network-access.md](network-access.md).
