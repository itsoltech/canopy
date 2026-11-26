import type { JsonValue } from "@canopy/domain";
import { runProcess } from "@canopy/process-governor";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { basicAuthRequest, browserBasicAuth } from "../agent-tools-mcp/browser-policy.ts";
import { abortable } from "../agent-tools-mcp/protocol.ts";
import type { AutomationCall } from "../agent-tools-mcp/session-policy.ts";
import type { LocalAutomationServer } from "../agent-tools-mcp/stdio.ts";
import { BrowserAuth, browserAuthTool } from "./browser-auth.ts";
import { BrowserCdp } from "./browser-cdp.ts";
import { BrowserDialogs, browserText, dialogBlocked, isBrowserDialogTool } from "./browser-dialogs.ts";
import { toolArgv, type ToolEnv } from "./paths.ts";
import { serializeAgentTool } from "./queue.ts";

type Managed = NonNullable<LocalAutomationServer["managed"]>;

type CallNext = Parameters<Managed["call"]>[2];

type Result = CallToolResult | undefined;

const openTool = "agent_browser_open";

const watched = new Set([
  openTool,
  "agent_browser_eval",
  "agent_browser_reload",
  "agent_browser_back",
  "agent_browser_forward",
]);

const endpoint = z.object({ success: z.literal(true), data: z.object({ cdpUrl: z.string() }) });
const inactive = z.object({ success: z.literal(false), error: z.literal("Browser not launched") });

const tabList = z.object({
  success: z.literal(true),
  data: z.object({ tabs: z.array(z.object({ targetId: z.string(), active: z.boolean() })) }),
});

const nativeFailure = z.object({
  response: z.object({ error: z.string() }),
});

interface Watch {
  dialogs: BrowserDialogs;
  finished: Promise<Result>;
}

function explainAuthFailure(result: Result): Result {
  const native = nativeFailure.safeParse(result?.structuredContent);

  if (!native.success || !native.data.response.error.includes("net::ERR_INVALID_AUTH_CREDENTIALS")) return result;

  return browserText(
    `The page requires HTTP authentication. For Basic Auth, use ${browserBasicAuth} with a private secret from request_secret.`,
    true,
  );
}

export class BrowserMcp implements Managed {
  readonly tools;
  #active: Watch | undefined;

  constructor(
    private readonly cli: string,
    private readonly env: ToolEnv,
    private readonly session: string,
    private readonly readSecret?: (requestId: string) => string | undefined,
  ) {
    this.tools = readSecret ? [browserAuthTool] : [];
  }

  call(call: AutomationCall, signal: AbortSignal, next: CallNext): Promise<Result> {
    return serializeAgentTool(`browser-mcp:${this.session}`, () => this.#call(call, signal, next));
  }

  async #call(call: AutomationCall, signal: AbortSignal, next: CallNext): Promise<Result> {
    signal.throwIfAborted();
    const previous = this.#active;

    if (previous) {
      if (previous.dialogs.pending && isBrowserDialogTool(call.name)) return previous.dialogs.resolve(call);

      const dialog =
        previous.dialogs.pending ??
        (await abortable(
          Promise.race([
            previous.finished.then(
              () => undefined,
              () => undefined,
            ),
            previous.dialogs.whenBlocked(),
          ]),
          signal,
        ));

      if (dialog && isBrowserDialogTool(call.name)) return previous.dialogs.resolve(call);

      if (dialog) return dialogBlocked(dialog, false);
    }

    if (call.name === browserBasicAuth) return this.#authenticate(call, signal, next);

    if (!watched.has(call.name) || (call.name === openTool && !call.arguments["url"]))
      return explainAuthFailure(await next(call, signal));

    const cdp = await this.#attach(call, signal, next).catch(() => undefined);
    signal.throwIfAborted();

    return cdp ? this.#watch(cdp, call, signal, next) : explainAuthFailure(await next(call, signal));
  }

  async #authenticate(call: AutomationCall, signal: AbortSignal, next: CallNext): Promise<Result> {
    if (!this.readSecret) return undefined;
    const request = basicAuthRequest(call.arguments);

    if (!request) return browserText("Provide an HTTP or HTTPS URL and a private secret requestId.", true);
    const secret = this.readSecret(request.requestId);

    if (!secret)
      return browserText("That private secret is unavailable in this thread. Request a new Basic Auth secret.", true);

    const navigation = {
      name: openTool,
      arguments: { session: this.session, headed: false, url: request.url.href },
    };

    const cdp = await this.#attach(navigation, signal, next).catch(() => undefined);
    signal.throwIfAborted();

    if (!cdp) return browserText("Basic Auth requires the local Chrome session.", true);

    try {
      return await this.#watch(cdp, navigation, signal, next, new BrowserAuth(cdp, request.url.origin, secret));
    } catch (error) {
      cdp.close();
      signal.throwIfAborted();

      return browserText(error instanceof Error ? error.message : "Could not initialize Basic Auth.", true);
    }
  }

  async #watch(
    cdp: BrowserCdp,
    call: AutomationCall,
    signal: AbortSignal,
    next: CallNext,
    auth?: BrowserAuth,
  ): Promise<Result> {
    const dialogs = new BrowserDialogs(cdp);
    const abort = () => cdp.close();
    signal.addEventListener("abort", abort, { once: true });
    const prepare = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);

    const close = () => {
      signal.removeEventListener("abort", abort);
      dialogs.clear();
      cdp.close();
    };

    cdp.onEvent((method, params) => {
      dialogs.event(method, params);
      void auth?.event(method, params).catch(abort);
    });

    const ready = await abortable(
      cdp.send("Page.enable").then(() => auth?.enable()),
      prepare,
    ).then(
      () => true,
      () => false,
    );

    if (!ready) {
      close();
      signal.throwIfAborted();

      return auth
        ? browserText("Could not initialize Basic Auth in Chrome.", true)
        : explainAuthFailure(await next(call, signal));
    }

    const finished = next(call, signal)
      .then((result) => {
        if (auth?.rejected) return browserText("The server rejected the Basic Auth credentials.", true);

        return explainAuthFailure(result);
      })
      .finally(async () => {
        // Canceling beforeunload can finish the navigation before Chrome replies to the dialog command.
        await dialogs.waitForResponse();
        this.#active = undefined;
        close();
      });

    this.#active = { dialogs, finished };

    return Promise.race([finished, dialogs.whenBlocked().then((dialog) => dialogBlocked(dialog, true))]);
  }

  async #attach(call: AutomationCall, signal: AbortSignal, next: CallNext): Promise<BrowserCdp | undefined> {
    const currentAddress = await this.#command(["get", "cdp-url"], signal);
    let address = endpoint.safeParse(currentAddress);

    if (call.name === openTool && inactive.safeParse(currentAddress).success) {
      const { url: _url, ...args } = call.arguments;
      const blank = await next({ name: openTool, arguments: args }, signal);

      if (!blank || blank.isError) return;
      address = endpoint.safeParse(await this.#command(["get", "cdp-url"], signal));
    }

    if (!address.success) return;
    const tabs = tabList.parse(await this.#command(["tab", "list"], signal));
    const current = tabs.data.tabs.find((tab) => tab.active);

    return current ? BrowserCdp.attach(address.data.data.cdpUrl, current.targetId, signal) : undefined;
  }

  async #command(args: string[], signal: AbortSignal): Promise<JsonValue> {
    const result = await runProcess(
      {
        argv: toolArgv(this.cli, ["--session", this.session, "--headed", "false", "--json", ...args], this.env),
        env: this.env,
        signal,
        timeoutMs: 3_000,
        maxBytes: 256 * 1024,
      },
      { kind: "utility", maxQueueMs: 2_500, signal },
    );

    return z.json().parse(JSON.parse(result.stdout));
  }
}
