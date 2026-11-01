# Spike: gRPC bidi stream po HTTP/2 w Bun

Data: 2026-11-01. Bun 1.4.4, `@connectrpc/connect` 2.3.0, `@connectrpc/connect-node` 2.3.0, `@bufbuild/protobuf` 2.16.0, Node 26.8.2, `@grpc/grpc-js` 1.14.7.

## Pytanie

Czy `node:http2` w Bun wystarczy do długożyjącego strumienia dwukierunkowego gRPC między gateway a workerem, po h2c i TLS? (Decyzja 1 w [architecture.md](../architecture.md#11-decyzje-do-podjęcia).)

## Wynik

**Tak.** ConnectRPC na `node:http2` działa w Bun jako serwer i klient. Plan B (WebSocket) nie jest potrzebny.

Testy: `tests/integration/worker-link.test.ts`, `tests/integration/interop.test.ts`. Wszystkie przechodzą stabilnie (5 przebiegów z rzędu).

| Scenariusz | Wynik |
|---|---|
| Handshake Hello → Welcome, rejestracja połączenia | OK |
| Auth: brak / zły token → `Unauthenticated`, cudzy `worker_id` → `PermissionDenied` | OK |
| Komenda wypchnięta przez gateway do bezczynnego workera + korelacja `CommandResult` | OK |
| Timeout komendy bez odpowiedzi → `DeadlineExceeded` | OK |
| 5000 zdarzeń transkryptu w kolejności + zbiorcze ACK | OK, ok. 95 ms lokalnie |
| Jedna wiadomość 4 MiB | OK |
| Prośba o uprawnienie i decyzja | OK |
| Reconnect tego samego workera zastępuje stare połączenie | OK |
| Abort po stronie workera → gateway widzi koniec strumienia | OK |
| 20 workerów równolegle, osobne połączenia | OK |
| Łagodne i twarde zamknięcie gateway | OK |
| TLS z własnym CA, odrzucenie niezaufanego certyfikatu, HTTP/2 PING | OK |
| **Interop:** `@grpc/grpc-js` na Node jako worker → gateway w Bun (h2c, TLS) | OK |
| **Interop:** worker w Bun → `@grpc/grpc-js` na Node jako gateway (h2c, TLS) | OK |

## Ustalenia do zapamiętania

1. **Łagodne zamykanie serwera.** `session.destroy()` od razu po `server.close()` urywa strumienie, zanim klient dostanie trailery (`grpc-status`). Klient widzi `Internal: missing status`. Rozwiązanie w `startGrpcServer().close(graceMs)`: GOAWAY (`session.close()`), okres karencji, dopiero potem `destroy()`. Gateway przed zamknięciem serwera woła `WorkerLink.shutdown()`.
2. **Connect wymaga pełnego protokołu generatora** dla strumienia wejściowego (`throw`) i może wołać `[Symbol.asyncIterator]()` wielokrotnie. `AsyncChannel` zwraca zawsze ten sam async generator.
3. **Błąd weryfikacji TLS** connect-node mapuje na `Code.Internal`, nie `Unavailable` (tak samo na Node). Przyczyna jest w `error.cause.code`, np. `DEPTH_ZERO_SELF_SIGNED_CERT`. Pętla reconnect workera powinna traktować to jako błąd konfiguracji, nie przejściowy.
4. **grpc-js na Node 26 nie akceptuje adresu IP jako TLS servername.** Klienci grpc-js łączący się po IP potrzebują `grpc.ssl_target_name_override`. Nie dotyczy klienta Connect w Bun.
5. **Node 26 nie uruchamia wygenerowanych plików TS** (`enum` wymaga transformacji, a `--experimental-transform-types` usunięto). Peer Node w testach jest bundlowany przez `Bun.build({ target: "node" })`.

## Poza zakresem (do sprawdzenia przy wdrożeniu)

- Reverse proxy przed gateway (Caddy / Traefik / nginx): HTTP/2 do backendu, brak timeoutu bezczynności dla długich strumieni.
- `bun build --compile` workera z SDK uruchamiającymi własne procesy (decyzja 2).
- Zachowanie przy utracie sieci bez FIN (laptop usypia): PING jest ustawiany, ale nie testowano zerwania na poziomie sieci.
