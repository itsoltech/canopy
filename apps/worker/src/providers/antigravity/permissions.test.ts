import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { InteractionResponseSchema, PermissionMode, ThreadSpecSchema } from "@canopy/contracts";
import type { PermissionRequest } from "@canopy/acp";
import { tempDir } from "@canopy/testing";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { antigravityPermission } from "./permissions.ts";

const options: PermissionRequest["options"] = [
  { kind: "allow_once", optionId: "once", name: "Allow" },
  { kind: "reject_once", optionId: "no", name: "Deny" },
];

test("Accept edits checks agy's native operation and every workspace path, including symlink targets", async () => {
  const root = tempDir("canopy-antigravity-acl-");
  const cwd = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(cwd);
  mkdirSync(outside);
  symlinkSync(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
  const spec = create(ThreadSpecSchema, { cwd, threadId: "thread" });

  const entry = {
    turnId: "turn",
    mode: PermissionMode.ACCEPT_EDITS,
    approvals: new Set<string>(),
    mcpTools: new Map<string, Set<string>>(),
  };

  const signal = new AbortController().signal;
  const reviewed: string[] = [];

  const decide = (name: string, path: string, location: string) => {
    const toolCall = {
      name,
      toolCallId: "edit",
      kind: "edit" as const,
      title: "File change",
      rawInput: { Path: path, Content: "text" },
      locations: [{ path: location }],
    };

    return antigravityPermission(spec, entry, { sessionId: "native", toolCall, options }, signal, async (request) => {
      reviewed.push(request.requestJson);

      return create(InteractionResponseSchema, { allow: false });
    });
  };

  const inside = join(cwd, "new");
  const linked = join(cwd, "link", "new");
  const another = join(outside, "new");
  expect(await decide("write_file", inside, inside)).toMatchObject({ outcome: { optionId: "once" } });
  expect(await decide("edit_file", linked, linked)).toMatchObject({ outcome: { optionId: "no" } });
  expect(await decide("edit_file", inside, another)).toMatchObject({ outcome: { optionId: "no" } });
  expect(await decide("other_tool", inside, inside)).toMatchObject({ outcome: { optionId: "no" } });
  expect(reviewed).toHaveLength(3);
});

test("a one-time decision never chooses the agent's persistent approval option", async () => {
  const spec = create(ThreadSpecSchema, { threadId: "thread" });

  const entry = {
    turnId: "turn",
    mode: PermissionMode.ASK,
    approvals: new Set<string>(),
    mcpTools: new Map<string, Set<string>>(),
  };

  const request: PermissionRequest = {
    sessionId: "native",
    toolCall: { toolCallId: "command", title: "Command", rawInput: { CommandLine: "pwd" } },
    options: [{ kind: "allow_always", optionId: "permanent", name: "Always allow" }, ...options.slice(1)],
  };

  const reply = await antigravityPermission(spec, entry, request, new AbortController().signal, async () =>
    create(InteractionResponseSchema, { allow: true }),
  );

  expect(reply).toEqual({ outcome: { outcome: "cancelled" } });
});

test("Read only delegates only exact tool identities advertised by this session's worker bridges", async () => {
  const entry = {
    mode: PermissionMode.READ_ONLY,
    turnId: "turn",
    approvals: new Set<string>(),
    mcpTools: new Map([
      ["canopy", new Set(["list_threads"])],
      ["agent_browser", new Set(["open"])],
    ]),
  };

  const decide = (name: string) => {
    const toolCall = {
      name,
      title: "Run mcp_canopy_list_threads",
      kind: "other" as const,
      toolCallId: "call",
      rawInput: {},
    };

    return antigravityPermission(
      create(ThreadSpecSchema),
      entry,
      { sessionId: "s", toolCall, options },
      new AbortController().signal,
      async () => {
        throw new Error("Unexpected interactive prompt");
      },
    );
  };

  for (const name of ["mcp_canopy_list_threads", "mcp_agent_browser_open"])
    expect(await decide(name)).toMatchObject({ outcome: { optionId: "once" } });

  for (const name of [
    "mcp_canopy_other",
    "mcp_canopy_unregistered_list_threads",
    "mcp_agent_device_open",
    "run_command",
  ])
    expect(await decide(name)).toMatchObject({ outcome: { optionId: "no" } });
});
