import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  basicAuthRequest,
  browserBasicAuth,
  browserFillLogin,
  browserFillOneTimeCode,
} from "../agent-tools-mcp/browser-policy.ts";
import { abortable } from "../agent-tools-mcp/protocol.ts";
import type { AutomationCall, AutomationContext } from "../agent-tools-mcp/session-policy.ts";
import type { LocalAutomationServer } from "../agent-tools-mcp/stdio.ts";
import { BrowserAuth } from "./browser-auth.ts";
import { basicAuthTool, fillLoginTool, fillOneTimeCodeTool } from "./browser-login-tools.ts";
import {
  forgetSessionLogins,
  retireOrphanedSession,
  sessionLogins,
  type BrowserLogins,
  type BrowserLoginAccess,
} from "./browser-logins.ts";
import { maskBrowserResult } from "./browser-output.ts";
import { captureHidingValues } from "./browser-capture.ts";
import { stageCapture } from "./browser-capture-files.ts";
import type { BrowserCdp } from "./browser-cdp.ts";
import {
  attachActiveTab,
  attachAllTabs,
  browserCommand,
  browserEndpoint,
  browserSessionQueue,
  type BrowserCommand,
} from "./browser-session.ts";
import { loginSecretValues } from "../runtime/project-login-values.ts";
import { BrowserDialogs, browserText, dialogBlocked, isBrowserDialogTool } from "./browser-dialogs.ts";
import type { ToolEnv } from "./paths.ts";
import { serializeAgentTool } from "./queue.ts";

type Managed = NonNullable<LocalAutomationServer["managed"]>;

type CallNext = Parameters<Managed["call"]>[2];

type Result = CallToolResult | undefined;

const openTool = "agent_browser_open";
const closeTool = "agent_browser_close";
const captureTools = new Set(["agent_browser_screenshot", "agent_browser_pdf"]);

// Collecting field contents for a capture can return a long text field.
const CAPTURE_MESSAGE_BYTES = 64 * 1024 * 1024;

const watched = new Set([
  openTool,
  "agent_browser_eval",
  "agent_browser_reload",
  "agent_browser_back",
  "agent_browser_forward",
]);

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
    `The page requires HTTP authentication. For Basic Auth, use ${browserBasicAuth} with a project login or a private secret from request_secret.`,
    true,
  );
}

export class BrowserMcp implements Managed {
  readonly tools;
  #active: Watch | undefined;
  readonly #access: BrowserLoginAccess | undefined;
  readonly #command: BrowserCommand;

  constructor(
    cli: string,
    env: ToolEnv,
    private readonly session: string,
    private readonly readSecret?: (requestId: string) => string | undefined,
    logins?: BrowserLoginAccess,
  ) {
    this.#access = logins;
    this.#command = browserCommand(cli, env, session);
    this.tools = [
      ...(readSecret || logins ? [basicAuthTool] : []),
      ...(logins ? [fillLoginTool, fillOneTimeCodeTool] : []),
    ];
  }

  call(call: AutomationCall, signal: AbortSignal, next: CallNext, context?: AutomationContext): Promise<Result> {
    return serializeAgentTool(browserSessionQueue(this.session), async () => {
      // A browser that outlived a worker restart may hold values nothing masks any more.
      await retireOrphanedSession(this.session, this.#command, signal);
      const values = this.#logins()?.entered ?? [];

      const result =
        captureTools.has(call.name) && values.length
          ? await this.#capture(call, values, signal, next, context)
          : await this.#call(call, signal, next, context);

      if (call.name === closeTool && result && !result.isError) forgetSessionLogins(this.session);
      // Close and reopen start a new session state: always mask with the current one.
      const logins = this.#logins();

      return logins ? maskBrowserResult(result, logins.entered, logins.guard.takeBlocked()) : result;
    });
  }

  /** A capture with entered values hidden, published to its path only once the checks pass. */
  async #capture(
    call: AutomationCall,
    values: readonly string[],
    signal: AbortSignal,
    next: CallNext,
    context?: AutomationContext,
  ): Promise<Result> {
    const staged = stageCapture(call);
    let captured = false;

    try {
      const result = await captureHidingValues(
        values,
        (captureSignal) => attachAllTabs(this.#command, captureSignal, CAPTURE_MESSAGE_BYTES),
        async () => {
          const shot = await this.#call(staged.call, signal, next, context);
          captured = !shot?.isError;

          return shot;
        },
        signal,
      );

      // A refused or discarded capture returns Canopy's own error, never the staged file.
      return captured && !result?.isError ? staged.publish(result) : result;
    } finally {
      staged.discard();
    }
  }

  /** The browser session's login state; Browser Preview and later bridges share it. */
  #logins(): BrowserLogins | undefined {
    return (
      this.#access && sessionLogins(this.session, (signal) => browserEndpoint(this.#command, signal), this.#access)
    );
  }

  async #call(call: AutomationCall, signal: AbortSignal, next: CallNext, context?: AutomationContext): Promise<Result> {
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

    if (call.name === browserBasicAuth) return this.#authenticate(call, signal, next, context);

    const logins = this.#logins();

    if ((call.name === browserFillLogin || call.name === browserFillOneTimeCode) && logins)
      return logins.fill(call, signal, next, (pageSignal) => this.#attach(call, pageSignal, next), context);

    if (!watched.has(call.name) || (call.name === openTool && !call.arguments["url"]))
      return explainAuthFailure(await next(call, signal));

    const cdp = await this.#attach(call, signal, next).catch(() => undefined);
    signal.throwIfAborted();

    return cdp ? this.#watch(cdp, call, signal, next) : explainAuthFailure(await next(call, signal));
  }

  async #basicAuthSecret(
    request: NonNullable<ReturnType<typeof basicAuthRequest>>,
    cdp: BrowserCdp,
    signal: AbortSignal,
    context?: AutomationContext,
  ): Promise<{ secret: string } | { failure: Result }> {
    const logins = this.#logins();

    if (request.login) {
      if (!logins) return { failure: browserText("Project logins are unavailable on this computer.", true) };
      const leased = await logins.lease(request.login, request.url.origin, context, signal);

      if (!leased.ok) return { failure: browserText(leased.message, true) };
      const { login } = leased;

      // Chrome is running now: interception must cover the tab before the credentials go anywhere.
      const guarded = await logins.protect(
        { name: login.name, values: loginSecretValues(login), websites: login.websites },
        cdp.targetId ? [cdp.targetId] : [],
        signal,
      );

      if (!guarded)
        return {
          failure: browserText(
            "Canopy could not start protecting the login in this browser, so it sent nothing. Call this tool again.",
            true,
          ),
        };

      return { secret: JSON.stringify({ username: login.username, password: login.password }) };
    }

    const secret = request.requestId ? this.readSecret?.(request.requestId) : undefined;

    if (secret) return { secret };

    return {
      failure: browserText("That private secret is unavailable in this thread. Request a new Basic Auth secret.", true),
    };
  }

  async #authenticate(
    call: AutomationCall,
    signal: AbortSignal,
    next: CallNext,
    context?: AutomationContext,
  ): Promise<Result> {
    const request = basicAuthRequest(call.arguments);

    if (!request)
      return browserText("Provide an HTTP or HTTPS URL and a project login or a private secret requestId.", true);

    const navigation = {
      name: openTool,
      arguments: { session: this.session, headed: false, url: request.url.href },
    };

    // Launch Chrome first, so a login is protected in the browser that receives it.
    const cdp = await this.#attach(navigation, signal, next).catch(() => undefined);
    signal.throwIfAborted();

    if (!cdp) return browserText("Basic Auth requires the local Chrome session.", true);

    try {
      const resolved = await this.#basicAuthSecret(request, cdp, signal, context);

      if ("failure" in resolved) {
        cdp.close();

        return resolved.failure;
      }

      return await this.#watch(
        cdp,
        navigation,
        signal,
        next,
        new BrowserAuth(cdp, request.url.origin, resolved.secret),
      );
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
    if (call.name === openTool && (await browserEndpoint(this.#command, signal)) === undefined) {
      const { url: _url, ...args } = call.arguments;
      const blank = await next({ name: openTool, arguments: args }, signal);

      if (!blank || blank.isError) return;
    }

    return attachActiveTab(this.#command, signal);
  }
}
