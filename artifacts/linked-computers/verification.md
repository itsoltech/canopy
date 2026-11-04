# Linked computers — weryfikacja etapu 1

Data: 2026-11-03. Gałąź: `feat/linked-computers-1`, utworzona z `origin/dev`
(`3ebd7c58821e4d2ddb0f647e00d14c49ee25bd4f`). Zakres: wyłącznie etap 1
[uzgodnionego projektu](../../docs/linked-computers.md). Wykonanie inline w roli
delegowanego implementera; bez podagentów, pushowania, publikacji i wdrożenia.

## Wynik i decyzje

- Każdy gateway ma trwałe id SHA-256 publicznego SPKI, edytowalną nazwę i samopodpisany
  certyfikat ECDSA P-256. Prywatny PKCS#8 jest szyfrowany istniejącym AES-256-GCM
  klucza sekretów gatewaya. UI pokazuje SHA-256 całego certyfikatu.
- Kod jednorazowy zawiera pin A oraz losowy 128-bitowy sekret. Ważność: 10 minut.
  Przechowywany jest hash sekretu; zużycie jest atomowe. Revoke, limit 10 prób kodu
  i trwały globalny limit 30 prób/min chronią parowanie. Pin jest sprawdzany przed
  wysłaniem sekretu. Obie strony przypinają dokładne certyfikaty.
- Osobny listener TLS 1.3/gRPC używa `CANOPY_LINK_HOST`, `CANOPY_LINK_PORT`
  i `CANOPY_LINK_ADDRESSES`. Nie ma nowego stałego portu. Desktop wybiera wolny port
  raz i zapisuje go w `userData/computer-link.json`; nadrzędne allowNetwork ogranicza
  możliwość uruchomienia listenera. Settings przechowuje osobny przełącznik w bazie.
- Addytywny `canopy.link.v1` ma `Pair` i uwierzytelniony dwukierunkowy `Connect`.
  Zakres protokołu 1–1 i capabilities są niezależne od WorkerLink i zamrożonego
  UpdateService. Niezgodność pokazuje obu stronom tożsamość wymagającą aktualizacji.
- Presence, heartbeat, reconnect z backoff i kolejnymi trasami, nazwy oraz unlink
  online/offline działają bez kolejki pracy. Migracja: `0048_linked_computers`.

## Testy i kontrole

Wszystkie wymagane komendy zakończyły się kodem 0:

- `bun install`, `bun run gen:check`, `bun run typecheck` i
  `bun run --cwd apps/web build`. Svelte: 0 błędów i 0 ostrzeżeń diagnostycznych.
- `bun run check:tmp`: **676 pass, 149 skip, 0 fail, 3696 assertions**, 825 testów
  w 141 plikach, 418,32 s. Zawiera wszystkie 11 nowych testów. Kontrola nie znalazła
  pozostałości `canopy-*` we własnym TMPDIR; wypisała jedynie katalog narzędzia
  `claude-1000` poza tym kryterium oraz informację o równoległych plikach w `/tmp`.
- `bun test tests/integration/linked-computers.test.ts`: **11 pass, 0 fail,
  46 assertions** po końcowej poprawce zamykania i kolejności tras.
- Chromium: dwa własne produkcyjne gatewaye i BFF, osobne PostgreSQL w Dockerze;
  parowanie przez oba formularze, unlink/re-pair, nazwy, fingerprinty, Connected
  po obu stronach i przełącznik listenera. Pełny proces gatewaya B zrestartowano;
  wrócił Connected z tą samą tożsamością.

Build weba wypisał ostrzeżenie Vite o chunku większym niż 500 kB oraz konflikt
zmiennych kolorów `NO_COLOR`/`FORCE_COLOR`; nie zgłosił błędów. Pominięte testy
obejmują m.in. opt-in live oraz integracje wymagające bundla desktopowego.

Integracja tworzy dwa rzeczywiste core/API gatewaya, dwa listenery mTLS i dwie
niezależne bazy. Sprawdza happy path, szyfrowany klucz i hash kodu, błędny/zużyty/
wygasły/odwołany kod, równoczesne zużycie, limity prób, obcy poprawny certyfikat,
inny klucz pod tym samym adresem, fallback po mismatch, niezgodność protokołu na
obu stronach, announced presence, unannounced unreachable, restart serwisu łącza,
trwałą tożsamość, nazwy i unlink online/offline.

Przy przeglądzie poprawiono wyścig reconnect podczas zamykania, oczekiwanie na
czytniki przychodzących strumieni, obsługę błędów zadań reconnect oraz zachowanie
ostatniej skutecznej trasy na początku listy po odebraniu handshake.

## Screenshoty

Chromium `/usr/bin/chromium`, jednorazowa automatyzacja przez `playwright-core`
poza repo, nagłówek `x-forwarded-proto: http`. Bez nowej testowej suity web UI.
Brak błędów `pageerror` i poziomego overflow w sprawdzonych szerokościach.

| Widok | Jasny | Ciemny |
|---|---|---|
| Desktop 1440 × 1200 | [screenshot](desktop-light.png) | [screenshot](desktop-dark.png) |
| Telefon 390 × 844, tożsamość | [screenshot](phone-light.png) | [screenshot](phone-dark.png) |
| Telefon 390 × 844, partner | [screenshot](phone-light-peer.png) | [screenshot](phone-dark-peer.png) |

Nazwy i adresy na obrazach należą do własnych testowych stacków na loopback.
Nie utrwalono kodu parowania ani sekretów. Obejrzano wyrenderowany desktop dark
oraz telefon light z partnerem; pozostałe warianty zapisano w tym samym przejściu.
Własne procesy, kontenery i karty preview zamknięto, pliki kluczy testowych usunięto.
Porty i katalogi maintainera pozostawiono bez zmian.

## Granice dowodów

- Kontrola uruchomieniowa dotyczy Linuxa i loopback. Nie sprawdzano ręcznie
  rzeczywistego sleep/quit/update pakowanego Electrona ani macOS/Windows.
  Hooki są zaimplementowane; brak czasu systemu na wysłanie ogłoszenia daje
  uczciwe Unreachable zamiast gwarancji ogłoszonego stanu.
- Rotacja certyfikatu wymaga jawnego unlink/re-pair; nie ma automatycznej rotacji.
  Utrata odpowiedzi parowania pomiędzy zapisami wymaga nowego kodu.
- Przy jednoczesnej zmianie wszystkich adresów obu komputerów potrzebne jest
  ponowne parowanie. NAT/firewall i sieć internet/VPN nie były częścią kontroli.
- Etapy 2–8 pozostają poza zakresem. Etap 2 może rozszerzyć typowane `LinkFrame`
  i capabilities o overview oraz akcje do domu rzeczy; musi wymagać dodatniego
  wynegocjowanego protokołu i aktualnego połączenia, bez kolejkowania offline.

Do review rodzica: przede wszystkim granica bootstrap `Pair`/przypięty `Connect`,
revocation offline i integracja lifecycle Electrona.
