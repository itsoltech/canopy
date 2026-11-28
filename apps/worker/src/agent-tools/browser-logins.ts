import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentPreviewLogin } from "@canopy/contracts";
import { oneTimeCode, parseOneTimeCodeSetup } from "@canopy/domain/one-time-codes";
import { loginAllowsOrigin, type ProjectLoginValue } from "@canopy/domain/project-logins";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { browserFillLogin, fillCodeRequest, fillLoginRequest } from "../agent-tools-mcp/browser-policy.ts";
import type { AutomationCall, AutomationContext } from "../agent-tools-mcp/session-policy.ts";
import { encodedVariants, loginSecretValues, parseLoginValue } from "../runtime/project-login-values.ts";
import type { BrowserCdp } from "./browser-cdp.ts";
import { browserText } from "./browser-dialogs.ts";
import { focusedField, pageOrigin, pressEnter, writeField, type FocusedField } from "./browser-focus.ts";
import { BrowserLeakGuard, type GuardedLogin } from "./browser-leak-guard.ts";
import { browserEndpoint, type BrowserCommand } from "./browser-session.ts";

type Next = (params: AutomationCall, signal: AbortSignal) => Promise<CallToolResult | undefined>;

export type PageProvider = (signal: AbortSignal) => Promise<BrowserCdp | undefined>;

/** Worker-side access to the thread's leased logins; values never leave this process except into Chrome. */
export interface BrowserLoginAccess {
  read(turnId: string, requestId: string): string | undefined;
  remember(values: readonly string[]): void;
  /** The browser session ended; its values stop being masked once output drains. */
  forget(): void;
}

// A code that expires sooner may be rejected by the time the form is sent.
const CODE_MARGIN_MS = 3_000;

// A code entered this close to its expiry may expire before the form is sent.
const CODE_WRITE_MARGIN_MS = 1_000;

// A code is guarded a while after it expires: a slow form can still send it.
const CODE_GUARD_MS = 60_000;

function failure(text: string): CallToolResult {
  return browserText(text, true);
}

export type LeasedLogin = { ok: true; login: ProjectLoginValue } | { ok: false; message: string };

type Endpoint = (signal: AbortSignal) => Promise<string | undefined>;

interface Field {
  selector: string;
  what: string;
  text: string;
  guard: GuardedLogin;
  /** A one-time code's expiry: checked again right before it is written. */
  expiresAt?: number;
}

// A browser outlives the bridge that filled it, so later bridges of the session keep masking and guarding.
const sessions = new Map<string, BrowserLogins>();

// A browser can also outlive the worker. A marker per session (no values) lets a restarted worker close a
// browser that may hold values it can no longer mask.
let markers: string | undefined;

export function configureLoginMarkers(directory: string): void {
  markers = directory;
}

function markerOf(session: string): string | undefined {
  return markers && join(markers, createHash("sha256").update(session).digest("hex"));
}

function markSession(session: string): void {
  const marker = markerOf(session);

  if (!marker || existsSync(marker)) return;
  mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
  // The session name is a thread ID, so shutdown and crash recovery can close its browser.
  writeFileSync(marker, session, { mode: 0o600 });
}

const SESSION = /^[A-Za-z0-9_-]{1,64}$/;

/** Sessions whose browser may hold login values. */
export function markedSessions(): string[] {
  const directory = markers;

  if (!directory || !existsSync(directory)) return [];

  return readdirSync(directory).flatMap((name) => {
    const session = readFileSync(join(directory, name), "utf8");

    return SESSION.test(session) && markerOf(session) === join(directory, name) ? [session] : [];
  });
}

/** Whether the session's browser may hold login values (it has a marker). */
export function sessionMarked(session: string): boolean {
  const marker = markerOf(session);

  return Boolean(marker && existsSync(marker));
}

/** Whether this process holds the session's masking state (it filled or guarded something there). */
export function hasSessionState(session: string): boolean {
  return sessions.has(session);
}

/**
 * Close a browser that held login values before this worker started, before anything reads it. The marker
 * stays, and this throws, until the session has no browser running.
 */
export async function retireOrphanedSession(
  session: string,
  command: BrowserCommand,
  signal: AbortSignal,
): Promise<void> {
  const marker = markerOf(session);

  if (sessions.has(session) || !marker || !existsSync(marker)) return;
  await command(["close"], signal).catch(() => undefined);

  if ((await browserEndpoint(command, signal)) !== undefined)
    throw new Error("Canopy could not close a browser that may still hold a login. Try again.");
  rmSync(marker, { force: true });
}

// Redaction for a thread's browser values, for a session Browser Preview opens before the agent's bridge.
let accessFor: ((session: string) => BrowserLoginAccess | undefined) | undefined;

export function configureLoginAccess(access: (session: string) => BrowserLoginAccess | undefined): void {
  accessFor = access;
}

/** The session's login protection. A later agent bridge rebinds it; Browser Preview uses it as it is. */
export function sessionLogins(session: string, endpoint: Endpoint, access?: BrowserLoginAccess): BrowserLogins {
  const known = sessions.get(session);

  if (known) {
    if (access) known.rebind(endpoint, access);

    return known;
  }

  const created = new BrowserLogins(session, endpoint, access ?? accessFor?.(session));
  sessions.set(session, created);

  return created;
}

/** The browser session ended: Chrome no longer holds anything entered. */
export function forgetSessionLogins(session: string): void {
  sessions.get(session)?.forget();
  sessions.delete(session);
  const marker = markerOf(session);

  if (marker) rmSync(marker, { force: true });
}

export class BrowserLogins {
  readonly guard: BrowserLeakGuard;
  /** Values entered in this session, masked in every result while the browser may still hold them. */
  readonly #entered = new Set<string>();
  #access: BrowserLoginAccess | undefined;
  #endpoint: Endpoint;

  constructor(
    private readonly session: string,
    endpoint: Endpoint,
    access?: BrowserLoginAccess,
  ) {
    this.#access = access;
    this.#endpoint = endpoint;
    this.guard = new BrowserLeakGuard((signal) => this.#endpoint(signal));
  }

  forget(): void {
    this.guard.close();
    this.#access?.forget();
  }

  rebind(endpoint: Endpoint, access: BrowserLoginAccess): void {
    this.#endpoint = endpoint;
    this.#access = access;
    // Values entered from Browser Preview before the agent's bridge existed stay masked in its output too.
    access.remember([...this.#entered]);
  }

  get entered(): readonly string[] {
    return [...this.#entered];
  }

  /** Lease the login for the page's website in this turn and read it from worker memory. */
  async lease(
    name: string,
    origin: string,
    context: AutomationContext | undefined,
    signal: AbortSignal,
  ): Promise<LeasedLogin> {
    if (!context?.leaseLogin || !this.#access)
      return { ok: false, message: "Project logins need a running turn on this computer." };
    const lease = await context.leaseLogin(name, origin, signal);

    if (!lease.ok) return lease;
    const raw = this.#access.read(lease.turnId, lease.requestId);
    const login = raw && parseLoginValue(raw);

    if (!login)
      return { ok: false, message: `Login ${name} is no longer available in this turn. Call this tool again.` };

    if (!loginAllowsOrigin(login.websites, origin))
      return { ok: false, message: `Login ${name} is not for ${origin}.` };

    return { ok: true, login };
  }

  /**
   * Mask values wherever output goes and block requests that would send them elsewhere. False if Chrome's
   * interception does not cover `targets`: the values must not be entered then.
   */
  async protect(login: GuardedLogin, targets: readonly string[], signal: AbortSignal): Promise<boolean> {
    markSession(this.session);

    if (!login.expiresAt) {
      for (const value of login.values) this.#entered.add(value);
      this.#access?.remember(login.values);
    }

    return this.guard.protect(login, targets, signal);
  }

  async fill(
    call: AutomationCall,
    signal: AbortSignal,
    next: Next,
    page: PageProvider,
    context?: AutomationContext,
  ): Promise<CallToolResult> {
    const login = call.name === browserFillLogin ? fillLoginRequest(call.arguments) : undefined;
    const code = login ? undefined : fillCodeRequest(call.arguments);
    const name = login?.login ?? code?.login;

    if (!name) return failure("Provide a project login name and the fields from a snapshot.");
    const cdp = await page(signal).catch(() => undefined);

    if (!cdp) return failure("Open the sign-in page in this thread's browser first.");

    try {
      const origin = await pageOrigin(cdp).catch(() => undefined);

      if (!origin) return failure("Open an http or https sign-in page first.");
      const leased = await this.lease(name, origin, context, signal);

      if (!leased.ok) return failure(leased.message);
      const value = leased.login;
      const fields = login ? loginFields(value, login) : await codeFields(value, code?.field ?? "");

      if (!fields) return failure(`Login ${name} has no one-time code. Add a setup key in project settings.`);

      for (const field of fields) {
        const entered = await this.#enter(cdp, value, field, signal, next);

        if (entered) return entered;
      }

      if (login?.submit || code?.submit) await pressEnter(cdp);
      const what = fields.map((field) => field.what).join(" and ");

      return browserText(
        `Entered the ${what} of login ${name} on ${origin}.${login?.submit || code?.submit ? " Pressed Enter." : ""}`,
      );
    } finally {
      cdp.close();
    }
  }

  async #enter(
    cdp: BrowserCdp,
    login: ProjectLoginValue,
    field: Field,
    signal: AbortSignal,
    next: Next,
  ): Promise<CallToolResult | undefined> {
    const clicked = await next(
      {
        name: "agent_browser_click",
        arguments: { session: this.session, selector: field.selector, extraArgs: ["--headed", "false"] },
      },
      signal,
    );

    if (!clicked || clicked.isError) return clicked ?? failure(`Could not click the ${field.what} field.`);
    const focused = await focusedField(cdp).catch(() => undefined);

    if (!focused?.editable) return failure(`The ${field.what} element is not an editable field. Take a new snapshot.`);

    if (!loginAllowsOrigin(login.websites, focused.origin))
      return failure(
        `The ${field.what} field is on ${focused.origin}, which is not one of login ${login.name}'s websites.`,
      );

    return this.#write(cdp, focused, field, signal);
  }

  async #write(cdp: BrowserCdp, focused: FocusedField, field: Field, signal: AbortSignal) {
    const targets = [cdp.targetId, focused.frameTarget].filter((target): target is string => Boolean(target));

    if (field.guard.values.length && !(await this.protect(field.guard, targets, signal)))
      return failure(
        "Canopy could not start protecting the login in this browser, so it entered nothing. Call this tool again.",
      );

    // Locating the field and starting the guard take time; a code that expired meanwhile is not entered.
    if (field.expiresAt !== undefined && Date.now() >= field.expiresAt - CODE_WRITE_MARGIN_MS)
      return failure("The one-time code expired before Canopy could enter it. Try again for a new code.");

    if (!(await writeField(cdp, focused, field.text)))
      return failure(`The ${field.what} field changed before Canopy could enter it. Take a new snapshot.`);

    return undefined;
  }

  /** The owner's fill in Browser Preview: the focused field, on one of the login's websites. */
  async previewFill(page: PageProvider, login: AgentPreviewLogin, signal: AbortSignal): Promise<void> {
    const cdp = await page(signal);

    if (!cdp) throw new Error("Open the sign-in page in this thread's browser first.");

    try {
      const focused = await focusedField(cdp).catch(() => undefined);

      if (!focused?.editable) throw new Error("Click the field to fill in Browser Preview first.");

      if (!loginAllowsOrigin(login.websites, focused.origin))
        throw new Error(`Login ${login.name} is not for this page. Open one of its websites first.`);

      const code = login.field === "one_time_code";

      // A visible username needs no protection; a one-time code until it expires and a grace period.
      const guard: GuardedLogin = {
        name: login.name,
        values: login.masked || code ? encodedVariants(login.text) : [],
        websites: login.websites,
        ...(code && { expiresAt: Number(login.expiresAtMs) + CODE_GUARD_MS }),
      };

      const field: Field = {
        selector: "",
        what: "login",
        text: login.text,
        guard,
        ...(code && { expiresAt: Number(login.expiresAtMs) }),
      };

      // A code can also wait in the session's queue: one that expired meanwhile is refused right before writing.
      const failed = await this.#write(cdp, focused, field, signal);
      const reason = failed?.content.find((block) => block.type === "text");

      if (failed)
        throw new Error(
          reason?.type === "text" ? reason.text : "Canopy could not enter the login. Click the field and try again.",
        );
    } finally {
      cdp.close();
    }
  }
}

function loginFields(
  login: ProjectLoginValue,
  request: { username?: string | undefined; password?: string | undefined },
): Field[] {
  const secret = loginSecretValues(login);
  const guard = { name: login.name, values: secret, websites: login.websites };

  return [
    ...(request.username
      ? [
          {
            selector: request.username,
            what: "username",
            text: login.username,
            guard: login.hide_username ? guard : { ...guard, values: [] },
          },
        ]
      : []),
    ...(request.password ? [{ selector: request.password, what: "password", text: login.password, guard }] : []),
  ];
}

/** The code is generated before the field is located, so nothing waits between checking and writing. */
async function codeFields(login: ProjectLoginValue, selector: string): Promise<Field[] | undefined> {
  const setup = login.one_time_code_setup && parseOneTimeCodeSetup(login.one_time_code_setup);

  if (!setup) return undefined;
  let current = await oneTimeCode(setup);

  if (current.expiresAt - Date.now() < CODE_MARGIN_MS) {
    await Bun.sleep(current.expiresAt - Date.now() + 50);
    current = await oneTimeCode(setup);
  }

  const guard = {
    name: login.name,
    values: [current.code],
    websites: login.websites,
    expiresAt: current.expiresAt + CODE_GUARD_MS,
  };

  return [{ selector, what: "one-time code", text: current.code, guard, expiresAt: current.expiresAt }];
}
