import { expect } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { AgentTool, AgentToolInfoSchema, type AgentToolInfo } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { eventually, type CommandHandler, type TestGateway } from "./gateway.ts";

const tools = [AgentTool.BROWSER, AgentTool.DESKTOP, AgentTool.DEVICE];

const version = (tool: AgentTool) =>
  tool === AgentTool.BROWSER ? "0.43.0" : tool === AgentTool.DESKTOP ? "1.3.1" : "0.21.37";

/** Real RPC/WorkerLink coverage of access changes that prepare managed installations. */
export async function expectAgentToolEnablement(gateway: TestGateway): Promise<void> {
  const { api, worker, workerId } = gateway;
  const view = async () => (await api.getOverview({})).workers.find((item) => item.id === workerId);
  const grant = (tool: AgentTool, enabled: boolean) => api.setAgentToolEnabled({ workerId, tool, enabled });
  const installs = () => worker.commands.filter((command) => command.case === "installAgentTool");

  const info = (tool: AgentTool, values: MessageInitShape<typeof AgentToolInfoSchema> = {}) =>
    create(AgentToolInfoSchema, { tool, installable: true, ...values });

  const publish = async (value: AgentToolInfo) => {
    value.detail ||= crypto.randomUUID();
    worker.link.send({ case: "agentToolsReport", value: { tools: [value] } });
    const current = await eventually(view, (item) => item?.agentTools[0]?.tool?.detail === value.detail);
    expect(current?.agentTools[0]?.tool?.detail).toBe(value.detail);
  };

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => 0,
      (cause: unknown) => ConnectError.from(cause).code,
    );

  for (const tool of tools) {
    await grant(tool, false);
    await publish(info(tool));
    worker.commands.length = 0;
    await grant(tool, true);
    expect(installs()).toHaveLength(1);
    expect(installs()[0]?.value).toMatchObject({ tool, version: "", installRuntime: tool === AgentTool.BROWSER });
    expect(installs()[0]?.value.installId).toBeTruthy();
    expect((await view())?.agentTools[0]?.enabled).toBe(true);
    expect(await gateway.core.agentTools.readyTools(workerId)).toEqual([]);

    await grant(tool, false);
    await publish(info(tool, { installed: true, ready: true, version: "0.0.1" }));
    expect((await view())?.agentTools[0]?.action).toBe("update");
    worker.commands.length = 0;
    await grant(tool, true);
    expect(installs()).toHaveLength(1);

    await publish(info(tool, { installed: true, ready: true, version: version(tool), installable: false }));
    worker.commands.length = 0;
    await grant(tool, true);
    expect(installs()).toEqual([]);

    await grant(tool, false);
    await publish(info(tool, { installable: false, install: { state: "running", installId: "already-running" } }));
    worker.commands.length = 0;
    await grant(tool, true);
    expect(installs()).toEqual([]);
    expect((await view())?.agentTools[0]?.enabled).toBe(true);
    await grant(tool, false);
  }

  for (const tool of tools) {
    await publish(info(tool, { installed: true, version: version(tool), ready: false }));
    worker.commands.length = 0;
    await grant(tool, true);
    expect(installs()).toHaveLength(tool === AgentTool.BROWSER ? 1 : 0);
    expect((await view())?.agentTools[0]?.enabled).toBe(true);
    await grant(tool, false);
  }

  await publish(info(AgentTool.BROWSER, { installable: false, detail: "npm is unavailable" }));
  worker.commands.length = 0;
  expect(await failure(grant(AgentTool.BROWSER, true))).toBe(Code.FailedPrecondition);
  expect((await view())?.agentTools[0]?.enabled).toBe(false);
  expect(installs()).toEqual([]);

  // Access is stored only after the worker accepts installation; a refusal keeps the old grant.
  await publish(info(AgentTool.BROWSER));
  const pending = Promise.withResolvers<Parameters<CommandHandler>[1]>();
  worker.handlers.set("installAgentTool", (_command, reply) => pending.resolve(reply));
  const enabling = failure(grant(AgentTool.BROWSER, true));
  const reply = await pending.promise;
  expect((await view())?.agentTools[0]?.enabled).toBe(false);
  reply(false, { errorCode: "NPM_NOT_FOUND", errorMessage: "npm is required" });
  expect(await enabling).toBe(Code.FailedPrecondition);
  expect((await view())?.agentTools[0]?.enabled).toBe(false);

  const accepted = Promise.withResolvers<Parameters<CommandHandler>[1]>();
  worker.handlers.set("installAgentTool", (_command, answer) => accepted.resolve(answer));
  const installing = grant(AgentTool.BROWSER, true);
  const accept = await accepted.promise;
  await grant(AgentTool.BROWSER, false);
  accept(true);
  await installing;
  expect((await view())?.agentTools[0]?.enabled).toBe(false);

  // A concurrent install may start before its report reaches the gateway.
  worker.handlers.set("installAgentTool", (_command, answer) =>
    answer(false, { errorCode: "AGENT_TOOL_INSTALL_RUNNING" }),
  );
  await grant(AgentTool.BROWSER, true);
  expect((await view())?.agentTools[0]?.enabled).toBe(true);
  worker.handlers.delete("installAgentTool");

  await publish(
    info(AgentTool.BROWSER, { install: { state: "failed", installId: "failed-install", error: "runtime failed" } }),
  );
  expect((await view())?.agentTools[0]?.enabled).toBe(true);
  expect(await gateway.core.agentTools.readyTools(workerId)).toEqual([]);
  worker.commands.length = 0;
  await grant(AgentTool.BROWSER, true);
  expect(installs()).toHaveLength(1);
  await grant(AgentTool.BROWSER, false);

  worker.link.send({ case: "agentToolsReport", value: { tools: [] } });
  const empty = await eventually(view, (item) => item?.agentTools.length === 0);
  expect(empty?.agentTools).toEqual([]);
  worker.commands.length = 0;
  expect(await failure(grant(AgentTool.BROWSER, true))).toBe(Code.FailedPrecondition);
  expect(installs()).toEqual([]);
}
