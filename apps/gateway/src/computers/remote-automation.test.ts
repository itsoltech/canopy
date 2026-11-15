import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentTool, ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { nodesOf, unqualify } from "./remote-ids.ts";

const home = "0123456789abcdef0123456789abcdef";
const workerId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";
const udid = "33333333-3333-4333-8333-333333333333";

test("linked automation routes by Canopy worker and session, preserving opaque simulator identifiers", () => {
  const request = create(ui.RunAgentToolRequestSchema, {
    workerId: qualifyId(workerId, home),
    operation: {
      tool: AgentTool.DEVICE,
      operation: "screenshot",
      platform: "ios",
      deviceId: udid,
      session: qualifyId(threadId, home),
    },
  });

  expect([...nodesOf(ui.RunAgentToolRequestSchema, request)]).toEqual([home.slice(0, 16)]);
  unqualify(ui.RunAgentToolRequestSchema, request, home);
  expect(request.workerId).toBe(workerId);
  expect(request.operation?.deviceId).toBe(udid);
  expect(request.operation?.session).toBe(threadId);

  request.operation!.session = threadId;
  request.operation!.deviceId = "opaque~fedcba9876543210";
  request.workerId = qualifyId(workerId, home);
  expect([...nodesOf(ui.RunAgentToolRequestSchema, request)]).toEqual([home.slice(0, 16)]);
  unqualify(ui.RunAgentToolRequestSchema, request, home);
  expect(request.operation?.deviceId).toBe("opaque~fedcba9876543210");
  expect(request.operation?.session).toBe(threadId);
});

test("a qualified thread on another computer cannot be used to target a different worker's automation", () => {
  const request = create(ui.RunAgentToolRequestSchema, {
    workerId: qualifyId(workerId, home),
    operation: { tool: AgentTool.BROWSER, operation: "screenshot", session: qualifyId(threadId, "fedcba9876543210") },
  });

  expect(nodesOf(ui.RunAgentToolRequestSchema, request).size).toBe(2);
  expect(() => unqualify(ui.RunAgentToolRequestSchema, request, home)).toThrow("same computer");
});
