import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode, ThreadSpec } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { claudeNativeToolOptions, DEFAULT_NATIVE_TOOL_POLICY } from "../native-tools.ts";
import { ClaudeEventMapper } from "./mapping.ts";
import { claudePermissions } from "./permissions.ts";
import { switchSessionMode } from "./mode-switch.ts";
import { transcriptPath } from "./transcript.ts";

import type { ClaudeInstanceRuntime, ClaudeThreadContext, Session } from "./thread-types.ts";
import type { claudeRuntime } from "./session-runtime.ts";
import { sessionPermissions } from "./session-permissions.ts";
import { fileSize } from "./session-io.ts";
import { claudeQueryConfiguration } from "./query-configuration.ts";
import { TurnAdmissionCancelled } from "../turn-input.ts";
import { threadInstructions } from "../thread-instructions.ts";
import { claudeSessionMcp } from "./session-mcp.ts";
import { invalidateSessionPermissions } from "./live-permissions.ts";
import { checkClaudeSandboxStartup, claudeSandboxProfile, preflightClaudeSandbox } from "./sandbox-profile.ts";

export function claudeSessions(
  ctx: ClaudeThreadContext,
  runtime: ReturnType<typeof claudeRuntime>,
  consume: (session: Session) => Promise<void>,
) {
  const { options, sessions } = ctx;
  const { sessionRuntime, homes, queryRuntime, sessionExists, inHome } = runtime;
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
    const sandboxProfile = claudeSandboxProfile(spec.sandboxProfile, mode);
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
      { ...queryRuntime(profile, runtime), ...permissions.options },
      serviceTier,
      { allowedDomains: sandboxProfile?.profile.allowedDomains },
    );

    const tools = claudeNativeToolOptions(sandboxProfile ? DEFAULT_NATIVE_TOOL_POLICY : options.nativeTools);

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
      canUseTool: canUseTool(spec, turnId, () => session?.autoAllow ?? "none"),
      // dontAsk denies whatever is not pre-approved. Gateway enforces connector grants and permission modes.
      allowedTools: mcp.allowedTools,
      disallowedTools: [...tools.disallowedTools, ...(sandboxProfile ? ["PowerShell"] : [])],
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

    const q = await openQuery(
      input,
      queryOptions,
      close,
      canSubmit,
      sandboxProfile && { runtime, allowedDomains: sandboxProfile.profile.allowedDomains, inHome },
    );

    const transcript = transcriptPath(runtime.home, sessionId);
    session = {
      refreshConnectors: mcp.refreshFor(q),
      threadId: spec.threadId,
      sessionId,
      cwd: spec.cwd,
      query: q,
      input,
      mapper: new ClaudeEventMapper(undefined, resume),
      abort,
      busCalls,
      turn: undefined,
      admitting: true,
      model,
      serviceTier,
      mode,
      sandboxProfileDigest: sandboxProfile?.digest,
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

async function openQuery(
  input: AsyncChannel<SDKUserMessage>,
  options: Options,
  close: () => Promise<void>,
  canSubmit: () => boolean,
  sandbox?: {
    runtime: ClaudeInstanceRuntime;
    allowedDomains: readonly string[];
    inHome: ReturnType<typeof claudeRuntime>["inHome"];
  },
) {
  let q: ReturnType<typeof query> | undefined;

  try {
    const version = sandbox
      ? await preflightClaudeSandbox(options, sandbox.runtime, sandbox.allowedDomains, sandbox.inHome)
      : undefined;

    if (!canSubmit()) throw new TurnAdmissionCancelled();
    q = query({ prompt: input, options });

    if (version) await checkClaudeSandboxStartup(q, version, options.abortController);

    return q;
  } catch (cause) {
    options.abortController?.abort();
    input.close();
    q?.close();
    await close();
    throw cause;
  }
}
