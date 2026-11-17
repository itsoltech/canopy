import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode, ThreadSpec } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { claudeNativeToolOptions } from "../native-tools.ts";
import { ClaudeEventMapper } from "./mapping.ts";
import { claudePermissions } from "./permissions.ts";
import { switchSessionMode } from "./mode-switch.ts";
import { transcriptPath } from "./transcript.ts";

import type { ClaudeThreadContext, Session } from "./thread-types.ts";
import type { claudeRuntime } from "./session-runtime.ts";
import { sessionPermissions } from "./session-permissions.ts";
import { fileSize } from "./session-io.ts";
import { claudeQueryConfiguration } from "./query-configuration.ts";
import { claudeConnectorRefresh } from "./connector-mcp.ts";
import { TurnAdmissionCancelled } from "../turn-input.ts";
import { threadInstructions } from "../thread-instructions.ts";
import { claudeSessionMcp } from "./session-mcp.ts";
import { invalidateSessionPermissions } from "./live-permissions.ts";

export function claudeSessions(
  ctx: ClaudeThreadContext,
  runtime: ReturnType<typeof claudeRuntime>,
  consume: (session: Session) => Promise<void>,
) {
  const { options, sessions } = ctx;
  const { sessionRuntime, homes, queryRuntime, sessionExists } = runtime;
  const canUseTool = sessionPermissions(options);

  const open = async (
    spec: ThreadSpec,
    model: string,
    effort: Options["effort"],
    mode: PermissionMode,
    recoveryContext = "",
    canSubmit: () => boolean = () => true,
    serviceTier = "default",
  ): Promise<Session> => {
    const profile = options.profile(spec.providerProfileId);

    if (!profile) throw new Error(`provider profile "${spec.providerProfileId || "native"}" is not available`);
    const sessionId = spec.providerThreadId || spec.threadId;
    const runtime = await sessionRuntime(profile, spec);
    const resume = await homes.resume(spec, runtime.home, sessionExists);
    const permissions = claudePermissions(mode);
    const input = new AsyncChannel<SDKUserMessage>();
    const abort = new AbortController();
    const busCalls = new Map<string, string[]>();
    let session: Session | undefined;
    const turnId = () => session?.turn?.turnId ?? "";

    const attachments = options.attachmentsDir?.(spec.threadId);
    const secrets = options.secretsDir?.(spec.threadId);

    const configuration = await claudeQueryConfiguration(
      runtime,
      spec.cwd,
      spec.scratch,
      options.baseEnv,
      queryRuntime(profile, runtime),
      serviceTier,
    );

    const instructions = [configuration.instructions, threadInstructions(spec.instructions), !resume && recoveryContext]
      .filter(Boolean)
      .join("\n\n");

    const mcp = claudeSessionMcp(options, spec, turnId, busCalls);

    const close = async () => {
      try {
        await mcp.close();
      } finally {
        await configuration.close();
      }
    };

    const queryOptions: Options = {
      cwd: spec.cwd,
      // The thread's attachments live outside the workspace (docs/protocol.md, "Załączniki").
      ...((attachments || secrets) && {
        additionalDirectories: [attachments, secrets].filter((p): p is string => !!p),
      }),
      ...(model && { model }),
      ...(effort && { effort }),
      ...configuration.options,
      ...(resume ? { resume: sessionId } : { sessionId }),
      includePartialMessages: true,
      enableFileCheckpointing: true,
      ...permissions.options,
      canUseTool: canUseTool(spec, turnId, () => session?.autoAllow ?? "none"),
      // dontAsk denies whatever is not pre-approved. Gateway enforces connector grants and permission modes.
      allowedTools: mcp.allowedTools,
      ...claudeNativeToolOptions(options.nativeTools),
      // The platform stops background tasks one by one (StopTask): an interrupt spares them.
      perTaskStopAffordance: true,
      // Only the platform's MCP servers: the device owner's would leak their tools and accounts.
      strictMcpConfig: true,
      mcpServers: mcp.servers(spec.connectorTools),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        // A recorded prompt otherwise ignores a changed append on resume, including platform instructions.
        snapshot: false,
        ...(instructions && { append: instructions }),
      },
      abortController: abort,
    };

    if (!canSubmit()) {
      await close();
      throw new TurnAdmissionCancelled();
    }

    const q = await openQuery(input, queryOptions, close);
    const refreshConnectors = claudeConnectorRefresh(q, spec.connectorTools, mcp.servers, mcp.key);
    const transcript = transcriptPath(runtime.home, sessionId);
    session = {
      refreshConnectors: async (current) => {
        await mcp.refresh(current);
        await refreshConnectors(current.connectorTools, mcp.key);
      },
      threadId: spec.threadId,
      sessionId,
      cwd: spec.cwd,
      query: q,
      input,
      mapper: new ClaudeEventMapper(),
      abort,
      busCalls,
      turn: undefined,
      admitting: true,
      model,
      serviceTier,
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
    session.done = consume(session).finally(close);
    sessions.set(spec.threadId, session);

    return session;
  };

  const switchMode = (session: Session, mode: PermissionMode) =>
    switchSessionMode(session, mode, { invalidate: () => invalidateSessionPermissions(session) });

  return { open, switchMode };
}

async function openQuery(input: AsyncChannel<SDKUserMessage>, options: Options, close: () => Promise<void>) {
  try {
    return query({ prompt: input, options });
  } catch (cause) {
    await close();
    throw cause;
  }
}
