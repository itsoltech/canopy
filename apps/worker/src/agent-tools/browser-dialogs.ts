import type { JsonValue } from "@canopy/domain";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { browserDialogAccept, browserDialogDismiss, browserDialogStatus } from "../agent-tools-mcp/browser-policy.ts";
import { abortable } from "../agent-tools-mcp/protocol.ts";
import type { AutomationCall } from "../agent-tools-mcp/session-policy.ts";
import type { BrowserCdp } from "./browser-cdp.ts";

const dialogOpening = z.object({
  type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
  message: z.string().transform((value) => value.slice(0, 4096)),
  defaultPrompt: z
    .string()
    .default("")
    .transform((value) => value.slice(0, 4096)),
});

type Dialog = z.infer<typeof dialogOpening>;

export const isBrowserDialogTool = (tool: string): boolean =>
  tool === browserDialogStatus || tool === browserDialogAccept || tool === browserDialogDismiss;

export function browserText(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

function dialogResult(data: Record<string, JsonValue>): CallToolResult {
  const response = { success: true, data, error: null };

  return { ...browserText(JSON.stringify(response)), structuredContent: { exitCode: 0, response } };
}

export class BrowserDialogs {
  #dialog: Dialog | undefined;
  #opening: Timer | undefined;
  #blocked = Promise.withResolvers<Dialog>();
  #response: Promise<JsonValue> | undefined;

  constructor(private readonly cdp: BrowserCdp) {}

  get pending(): Dialog | undefined {
    return this.#dialog;
  }

  whenBlocked(): Promise<Dialog> {
    return this.#blocked.promise;
  }

  async waitForResponse(): Promise<void> {
    await this.#response?.catch(() => undefined);
  }

  event(method: string, params: JsonValue): void {
    if (method === "Page.javascriptDialogClosed") this.clear();

    if (method !== "Page.javascriptDialogOpening") return;
    const dialog = dialogOpening.safeParse(params);

    if (!dialog.success) return;

    const publish = () => {
      this.#dialog = dialog.data;
      this.#blocked.resolve(dialog.data);
    };

    // The native daemon normally handles alerts and beforeunload immediately.
    if (dialog.data.type === "alert" || dialog.data.type === "beforeunload") this.#opening = setTimeout(publish, 75);
    else publish();
  }

  clear(): void {
    clearTimeout(this.#opening);

    if (this.#dialog) this.#blocked = Promise.withResolvers<Dialog>();
    this.#dialog = undefined;
  }

  async resolve(call: AutomationCall): Promise<CallToolResult> {
    const dialog = this.#dialog;

    if (call.name === browserDialogStatus) return dialogResult({ hasDialog: !!dialog, ...dialog });

    if (!dialog) return browserText("No browser dialog is open.", true);
    const accept = call.name === browserDialogAccept;
    const promptText = z.string().optional().parse(call.arguments["text"]);

    const response = abortable(
      this.cdp.send("Page.handleJavaScriptDialog", {
        accept,
        ...(accept && promptText !== undefined && { promptText }),
      }),
      AbortSignal.timeout(3_000),
    );

    this.#response = response;
    await response;

    // Chromium may already have opened a second dialog in the same script.
    if (this.#dialog === dialog) this.clear();

    return dialogResult({ handled: true, accepted: accept });
  }
}

export function dialogBlocked(dialog: Dialog, interrupted: boolean): CallToolResult {
  const text = interrupted
    ? "This browser action opened a dialog and is waiting."
    : "A browser dialog is blocking this tab.";

  return {
    ...browserText(
      `${text} Resolve it with ${browserDialogAccept} or ${browserDialogDismiss}. Use ${browserDialogStatus} to inspect it. After resolving it, check the page before repeating the action.`,
      !interrupted,
    ),
    structuredContent: { dialog },
  };
}
