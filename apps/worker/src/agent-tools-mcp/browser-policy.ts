import { PROJECT_SECRET_NAME_PATTERN } from "@canopy/domain";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolCall } from "./protocol.ts";

const browserArguments = z.object({
  namespace: z.string().optional(),
  headed: z.boolean().optional(),
  all: z.boolean().optional(),
  extraArgs: z.array(z.string()).optional(),
});

export const browserDialogStatus = "agent_browser_dialog_status";
export const browserDialogAccept = "agent_browser_dialog_accept";
export const browserDialogDismiss = "agent_browser_dialog_dismiss";
export const browserBasicAuth = "agent_browser_open_with_basic_auth";
export const browserFillLogin = "agent_browser_fill_login";
export const browserFillOneTimeCode = "agent_browser_fill_one_time_code";

const loginName = z.string().regex(PROJECT_SECRET_NAME_PATTERN);
const element = z.string().min(1).max(4096);

const basicAuthArguments = z
  .strictObject({
    url: z.string().max(8192),
    requestId: z.uuid().optional(),
    login: loginName.optional(),
    session: z.string(),
  })
  .refine((args) => Boolean(args.requestId) !== Boolean(args.login));

export function basicAuthRequest(args: z.infer<typeof ToolCall>["arguments"]) {
  const parsed = basicAuthArguments.safeParse(args);

  if (!parsed.success) return;
  const url = URL.parse(parsed.data.url);

  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) return;

  return parsed.data.login
    ? { url, login: parsed.data.login }
    : parsed.data.requestId
      ? { url, requestId: parsed.data.requestId }
      : undefined;
}

const fillLoginArguments = z
  .strictObject({
    login: loginName,
    username: element.optional(),
    password: element.optional(),
    submit: z.boolean().optional(),
    session: z.string(),
  })
  .refine((args) => Boolean(args.username || args.password));

const fillCodeArguments = z.strictObject({
  login: loginName,
  field: element,
  submit: z.boolean().optional(),
  session: z.string(),
});

export function fillLoginRequest(args: z.infer<typeof ToolCall>["arguments"]) {
  const parsed = fillLoginArguments.safeParse(args);

  return parsed.success ? parsed.data : undefined;
}

export function fillCodeRequest(args: z.infer<typeof ToolCall>["arguments"]) {
  const parsed = fillCodeArguments.safeParse(args);

  return parsed.success ? parsed.data : undefined;
}

const headedTools = new Set(["agent_browser_open", "agent_browser_doctor"]);
const pinnedFlags = new Set(["--session", "--namespace", "--headed", "--all"]);

const POLICY_INSTRUCTIONS =
  "This is a hard Canopy boundary: this thread's browser session is fixed and headless. Do not bypass it through shell or CLI commands, CDP, another browser, or repeated override attempts. Tabs share this session's login state. If the task needs separate browser sessions for different users, explain this limitation to the user; separate Canopy threads are required.";

/** The browser and its preview must stay in the same thread session without opening an OS window. */
export function bindBrowserCall(params: z.infer<typeof ToolCall>): z.infer<typeof ToolCall> {
  if (params.name === browserBasicAuth) {
    if (!basicAuthRequest(params.arguments))
      throw new Error(
        "Provide an HTTP or HTTPS URL without credentials and either a project login or a private secret requestId.",
      );

    return params;
  }

  if (params.name === browserFillLogin) {
    if (!fillLoginRequest(params.arguments))
      throw new Error("Provide a project login name and the username or password field from a snapshot.");

    return params;
  }

  if (params.name === browserFillOneTimeCode) {
    if (!fillCodeRequest(params.arguments))
      throw new Error("Provide a project login name and the one-time code field from a snapshot.");

    return params;
  }

  const parsed = browserArguments.safeParse(params.arguments);

  if (!parsed.success) throw new Error("Invalid browser session or launch arguments");
  const args = parsed.data;

  if (args.namespace) throw new Error(`${POLICY_INSTRUCTIONS} Omit namespace and continue in this thread.`);

  if (args.headed) throw new Error(`${POLICY_INSTRUCTIONS} Omit headed and continue headless.`);

  if (args.all) throw new Error(`${POLICY_INSTRUCTIONS} Close only this thread's session; omit all.`);

  if (params.name === browserDialogAccept) {
    const text = z.string().optional().parse(params.arguments["text"]);

    // Upstream 0.43 passes this operand before the CLI's end-of-options marker.
    if (text?.startsWith("-")) throw new Error("Prompt text cannot start with a dash in this browser version.");
  }

  for (const argument of args.extraArgs ?? []) {
    if (pinnedFlags.has(argument.split("=", 1)[0] ?? ""))
      throw new Error(`${POLICY_INSTRUCTIONS} Remove session, namespace, headed and all flags from extraArgs.`);
  }

  const { headed: _headed, ...argumentsWithoutHeaded } = params.arguments;
  const bound = argumentsWithoutHeaded;

  // In 0.43 all tools accept shared extraArgs, but only open and doctor accept headed.
  // An environment false cannot override a headed:true CLI config; an explicit flag can.
  return {
    ...params,
    arguments: headedTools.has(params.name)
      ? { ...bound, headed: false }
      : { ...bound, extraArgs: [...(args.extraArgs ?? []), "--headed", "false"] },
  };
}

export function browserCatalog(tools: Tool[]): Tool[] {
  return tools.flatMap((tool) => {
    if (tool.name === "agent_browser_window_new") return [];
    const properties = { ...tool.inputSchema.properties };

    if (Object.hasOwn(properties, "headed"))
      properties["headed"] = {
        type: "boolean",
        enum: [false],
        default: false,
        description: "Browser Preview runs headless. Keep false or omit.",
      };

    if (Object.hasOwn(properties, "all"))
      properties["all"] = {
        type: "boolean",
        enum: [false],
        default: false,
        description: "Close only this thread's session. Keep false or omit.",
      };

    const dialogHint = [
      "agent_browser_open",
      "agent_browser_click",
      "agent_browser_press",
      "agent_browser_eval",
    ].includes(tool.name)
      ? ` If a dialog opens, use ${browserDialogStatus}, ${browserDialogAccept}, or ${browserDialogDismiss} before continuing.`
      : "";

    return [
      {
        ...tool,
        description: `${tool.description ?? ""}${dialogHint}\n${POLICY_INSTRUCTIONS} Omit session, namespace and headed launch flags.`,
        inputSchema: { ...tool.inputSchema, properties },
      },
    ];
  });
}
