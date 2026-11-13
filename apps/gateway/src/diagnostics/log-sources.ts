import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { Code, ConnectError } from "@connectrpc/connect";
import { LogPullClient } from "./log-pull.ts";

/** A BFF/controller registration binds closed aliases to an authenticated process, never to file paths. */
export class LogSources {
  readonly sessions = new Map<string, { sources: string[]; client: LogPullClient; close: () => void }>();
  async *watch(request: ui.DiagnosticsLogSourceRegistration, signal: AbortSignal) {
    if (
      !/^[a-zA-Z0-9_-]{43}$/.test(request.session) ||
      !request.sources.length ||
      request.sources.length > 4 ||
      new Set(request.sources).size !== request.sources.length ||
      request.sources.some((source) => !["desktop", "web", "postgres", "initdb"].includes(source))
    )
      throw new ConnectError("Choose registered local log sources", Code.InvalidArgument);

    if (
      this.sessions.size >= 4 ||
      this.sessions.has(request.session) ||
      [...this.sessions.values()].some((entry) => entry.sources.some((source) => request.sources.includes(source)))
    )
      throw new ConnectError("Log source is already registered", Code.ResourceExhausted);

    const channel = new AsyncChannel<ui.DiagnosticsLogSourceCommand>({
      maxItems: 2,
      overflow: () => new ConnectError("Log source stopped reading", Code.ResourceExhausted),
    });

    const client = new LogPullClient(request.session, (command) => {
      if (!channel.push(command)) throw new ConnectError("Log source disconnected", Code.Unavailable);
    });

    const close = () => {
      client.close();
      channel.close();
    };

    this.sessions.set(request.session, { sources: request.sources, client, close });
    signal.addEventListener("abort", close, { once: true });

    try {
      yield* channel;
    } finally {
      signal.removeEventListener("abort", close);
      close();
      this.sessions.delete(request.session);
    }
  }
  reply(request: ui.DiagnosticsLogSourceReply) {
    return create(ui.DiagnosticsReceiptSchema, {
      accepted: this.sessions.get(request.session)?.client.receive(request) ?? false,
    });
  }
  close() {
    for (const entry of this.sessions.values()) entry.close();
  }
}
