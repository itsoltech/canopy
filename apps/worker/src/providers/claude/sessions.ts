import { query, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode, ThreadSpec } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { claudeNativeToolOptions } from "../native-tools.ts";
import { CLAUDE_VIEW_IMAGE_TOOL, claudeBusServer, claudeBusToolNames } from "./bus.ts";
import { BUS_SERVER, ClaudeEventMapper } from "./mapping.ts";
import { claudePermissions } from "./permissions.ts";
import { transcriptPath } from "./transcript.ts";

import type { ClaudeThreadContext, Session } from "./thread-types.ts";
import type { claudeRuntime } from "./session-runtime.ts";
import { sessionPermissions } from "./session-permissions.ts";
import { callKey, fileSize } from "./session-io.ts";
import { managedClaudeInstructions } from "./instructions.ts";

export function claudeSessions(
  ctx: ClaudeThreadContext,
  runtime: ReturnType<typeof claudeRuntime>,
  consume: (session: Session) => Promise<void>,
) {
  const { options, sessions } = ctx;
  const { runtimeOf, queryRuntime, sessionExists } = runtime;
  const canUseTool = sessionPermissions(options);

  const open = async (
    spec: ThreadSpec,
    model: string,
    effort: Options["effort"],
    mode: PermissionMode,
  ): Promise<Session> => {
    const profile = options.profile(spec.providerProfileId);

    if (!profile) throw new Error(`provider profile "${spec.providerProfileId || "native"}" is not available`);
    const sessionId = spec.providerThreadId || spec.threadId;
    const runtime = runtimeOf(profile);
    const resume = await sessionExists(sessionId, spec.cwd, runtime.home);
    const permissions = claudePermissions(mode);
    const input = new AsyncChannel<SDKUserMessage>();
    const abort = new AbortController();
    const busCalls = new Map<string, string[]>();
    let session: Session | undefined;
    const turnId = () => session?.turn?.turnId ?? "";

    const busTools = [
      ...(spec.enableAgentBus ? claudeBusToolNames(spec.depth) : []),
      ...(options.viewImage ? [CLAUDE_VIEW_IMAGE_TOOL] : []),
      ...spec.connectorTools.map((tool) => `mcp__${BUS_SERVER}__${tool.name}`),
    ];

    const attachments = options.attachmentsDir?.(spec.threadId);
    const secrets = options.secretsDir?.(spec.threadId);
    const instructions = [managedClaudeInstructions(runtime.home), spec.instructions].filter(Boolean).join("\n\n");

    const queryOptions: Options = {
      cwd: spec.cwd,
      // The thread's attachments live outside the workspace (docs/protocol.md, "Załączniki").
      ...((attachments || secrets) && {
        additionalDirectories: [attachments, secrets].filter((p): p is string => !!p),
      }),
      ...(model && { model }),
      ...(effort && { effort }),
      ...queryRuntime(profile, runtime),
      ...(resume ? { resume: sessionId } : { sessionId }),
      includePartialMessages: true,
      ...permissions.options,
      canUseTool: canUseTool(spec, turnId, () => session?.autoAllow ?? false),
      // dontAsk denies whatever is not pre-approved. Gateway enforces connector grants and permission modes.
      allowedTools: busTools,
      ...claudeNativeToolOptions(options.nativeTools),
      // The platform stops background tasks one by one (StopTask): an interrupt spares them.
      perTaskStopAffordance: true,
      // Only the platform's MCP servers: the device owner's would leak their tools and accounts.
      strictMcpConfig: true,
      mcpServers:
        spec.enableAgentBus || spec.connectorTools.length || options.viewImage
          ? {
              [BUS_SERVER]: claudeBusServer({
                threadId: spec.threadId,
                depth: spec.depth,
                agentBus: spec.enableAgentBus,
                connectorTools: spec.connectorTools,
                turnId,
                toolUseId: (tool, args) => busCalls.get(callKey(tool, args))?.shift(),
                callTool: options.callTool,
                ...(options.viewImage && {
                  viewImage: (path: string) => options.viewImage!(spec.threadId, spec.cwd, path),
                }),
              }),
            }
          : {},
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(instructions && { append: instructions }),
      },
      abortController: abort,
    };

    const q = query({ prompt: input, options: queryOptions });
    const transcript = transcriptPath(runtime.home, sessionId);
    session = {
      threadId: spec.threadId,
      sessionId,
      cwd: spec.cwd,
      query: q,
      input,
      mapper: new ClaudeEventMapper(),
      abort,
      busCalls,
      turn: undefined,
      model,
      mode,
      autoAllow: permissions.autoAllow,
      outputs: new Map(),
      home: runtime.home,
      // Verdicts of earlier turns are already recorded: read only what this process adds.
      transcript: { path: transcript, offset: transcript ? fileSize(transcript) : 0, tail: "" },
      io: Promise.resolve(),
      hadTasks: false,
      closing: false,
      closeTimer: undefined,
      done: Promise.resolve(),
    };
    session.done = consume(session);
    sessions.set(spec.threadId, session);

    return session;
  };

  /**
   * A live process (kept by background tasks) takes the next turn's mode before the turn starts: Claude Code's
   * permission mode, the sandbox (the flag settings layer, where Options.sandbox lives) and auto-allow in
   * canUseTool. Nothing of the previous turn waits for a decision any more (no turn runs).
   */
  const switchMode = async (session: Session, mode: PermissionMode) => {
    const current = claudePermissions(session.mode);
    const next = claudePermissions(mode);

    // Leaving FULL_AUTO: stop auto-allowing first; entering it: only once the sandbox is on.
    if (!next.autoAllow) session.autoAllow = false;

    if (Boolean(next.options.sandbox) !== Boolean(current.options.sandbox)) {
      // Options.sandbox is the settings' sandbox; live, only an explicit `enabled: false` turns it off
      // (`sandbox: null` leaves the one from the start in place and sandboxed Bash stays auto-allowed).
      type FlagSandbox = NonNullable<Parameters<Query["applyFlagSettings"]>[0]["sandbox"]>;

      // SAFETY: claudePermissions constructs sandbox settings with defined properties only;
      // applyFlagSettings uses the same settings contract with stricter optional-property declarations.
      const sandbox = (next.options.sandbox ?? { enabled: false }) as FlagSandbox;
      await session.query.applyFlagSettings({ sandbox });
    }

    await session.query.setPermissionMode(next.options.permissionMode ?? "default");
    session.mode = mode;
    session.autoAllow = next.autoAllow;
  };

  return { open, switchMode };
}
