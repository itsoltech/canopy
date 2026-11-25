import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AgentTool, RunAgentToolSchema } from "@canopy/contracts";
import sharp from "sharp";
import { AgentTools } from "./index.ts";
import { agentToolInfo, discoverAgentTool, discoverAgentTools } from "./probe.ts";
import { managedPrefix } from "./paths.ts";
import { agentToolSpec } from "./specs.ts";
import { runAgentToolOperation } from "./operations.ts";
import { executable, fixture } from "./fixtures.test-support.ts";
import { agentToolSession } from "./scope.ts";

const request = (tool: AgentTool, operation: string, target = "", value = "", platform = "") =>
  create(RunAgentToolSchema, { tool, operation, target, value, platform });

const desktop = AgentTool.DESKTOP;
const browser = AgentTool.BROWSER;
const device = AgentTool.DEVICE;

test("installed CLIs are ready from runtime checks without a marker, using the supplied environment", async () => {
  const f = fixture();
  const found = await discoverAgentTools({ which: f.which, env: f.env, platform: "linux" });

  expect(found.map((tool) => tool.ready)).toEqual([true, true, true]);
  expect(found.map((tool) => agentToolInfo(tool).stream)).toEqual([true, false, false]);
  expect(f.calls().every((call) => !call.privateEnv && call.setting === "preserved")).toBe(true);
  expect(f.calls().every((call) => call.displayAuthority === f.env.XAUTHORITY)).toBe(true);
  expect(
    f.calls().some((call) => call.tool === "agent-browser" && call.args.join(" ") === "doctor --offline --json"),
  ).toBe(true);
  expect(f.calls().some((call) => call.tool === "agent-desktop" && call.args.join(" ") === "status")).toBe(true);
});

test("AgentTools inherits the worker environment when no custom environment is supplied", async () => {
  const f = fixture();
  const previous = process.env["AGENT_TEST_SETTING"];
  process.env["AGENT_TEST_SETTING"] = "inherited-setting";

  try {
    const manager = new AgentTools({
      dataDir: f.dir,
      probe: { which: f.which, platform: "linux" },
      send: () => {},
      progress: () => {},
    });

    expect((await manager.probe()).tools?.every((tool) => tool.ready)).toBe(true);
    expect(f.calls().every((call) => !call.privateEnv && call.setting === "inherited-setting")).toBe(true);
  } finally {
    if (previous === undefined) delete process.env["AGENT_TEST_SETTING"];
    else process.env["AGENT_TEST_SETTING"] = previous;
  }
});

test("runtime loss, missing permissions and absent devices defeat version and old runtime markers", async () => {
  const f = fixture();
  mkdirSync(join(f.dir, "agent-tools"));
  writeFileSync(join(f.dir, "agent-tools", "agent-browser-runtime"), agentToolSpec(browser).version);
  f.state(browser, { ready: false });
  f.state(desktop, { denied: true });
  f.state(device, { ready: false });

  const manager = new AgentTools({
    dataDir: f.dir,
    probe: { which: f.which, platform: "linux" },
    env: f.env,
    send: () => {},
    progress: () => {},
  });

  expect((await manager.probe()).tools?.map((tool) => tool.ready)).toEqual([false, false, false]);
  expect(manager.localMcpServers([browser, desktop])).toEqual([]);
  const servers = manager.localMcpServers([device], "thread");
  expect(servers).toHaveLength(1);
  expect(servers[0]?.managed?.tools.map((tool) => tool.name)).toEqual(["acquire_device", "release_device"]);
  await expect(manager.run(request(device, "snapshot"))).rejects.toThrow();
  await expect(manager.run(request(browser, "snapshot"))).rejects.toThrow("Runtime is missing");
  f.state(desktop, { emptySurfaces: true });
  expect((await discoverAgentTool(agentToolSpec(desktop), { which: f.which, env: f.env })).ready).toBe(false);
});

test("desktop readiness ignores macOS screen recording state on Linux", async () => {
  const f = fixture();
  f.state(desktop, { screenRecording: "unknown" });

  const found = await discoverAgentTool(agentToolSpec(desktop), {
    which: f.which,
    env: f.env,
    platform: "linux",
  });

  expect(found.ready).toBe(true);
});

test("desktop readiness still requires screen recording on macOS", async () => {
  const f = fixture();
  f.state(desktop, { platform: "macos", screenRecording: "unknown" });

  const found = await discoverAgentTool(agentToolSpec(desktop), {
    which: f.which,
    env: f.env,
    platform: "darwin",
  });

  expect(found.ready).toBe(false);
  expect(found.detail).toContain("Allow Screen Recording in System Settings");
});

test("unsupported versions, platforms and malformed runtime responses never report ready", async () => {
  const f = fixture();
  f.state(browser, { version: "0.1.0" });
  f.state(desktop, { invalidJson: true });
  const found = await discoverAgentTools({ which: f.which, env: f.env });

  expect(found[0]?.ready).toBe(false);
  expect(found[0]?.detail).toContain("0.43.0");
  expect(found[1]?.ready).toBe(false);

  const unsupported = await discoverAgentTool(agentToolSpec(device), {
    which: f.which,
    env: f.env,
    platform: "freebsd",
  });

  expect(unsupported.ready).toBe(false);
  expect(unsupported.installable).toBe(false);
});

test("managed installs are discovered ahead of PATH and broken PATH copies do not mask working copies", async () => {
  const f = fixture();
  const spec = agentToolSpec(browser);
  const managed = executable(join(managedPrefix(f.dir, spec), "bin", spec.executable), f.script(browser));
  const found = await discoverAgentTool(spec, { dataDir: f.dir, which: f.which, env: f.env });

  expect(found.path).toBe(managed);
  expect(found.ready).toBe(true);
  const homeBin = executable(join(f.dir, ".local", "bin", "agent-browser"), f.script(browser));
  const badBin = join(f.dir, "bad-bin");
  executable(join(badBin, "agent-browser"), 'console.log("bad version"); process.exit(1);');
  const fallback = await discoverAgentTool(spec, { env: { ...f.env, PATH: badBin }, platform: "linux" });

  expect(fallback.path).toBe(homeBin);
  expect(fallback.ready).toBe(true);
});

test("CLI-specific operations preserve text literally and use correct desktop/device grammar", async () => {
  const f = fixture();
  const literal = "--session=attacker --config /tmp/payload $(touch never)\nsecond line";

  const cases = [
    {
      command: request(browser, "open", "https://example.test"),
      args: ["--json", "--headed", "false", "open", "https://example.test"],
    },
    { command: request(browser, "fill", "@e2", literal), args: ["--json", "fill", "@e2", "--", literal] },
    { command: request(browser, "type", "#field", literal), args: ["--json", "type", "#field", "--", literal] },
    { command: request(desktop, "type", "@s123:e2", literal), args: ["type", "--", "@s123:e2", literal] },
    { command: request(desktop, "fill", "@s123:e2", literal), args: ["set-value", "--", "@s123:e2", literal] },
    { command: request(desktop, "press", "Text Editor", "cmd+a"), args: ["press", "--app=Text Editor", "--", "cmd+a"] },
    {
      command: request(device, "type", "", literal, "android"),
      args: ["--json", "--platform", "android", "type", "--", literal],
    },
    {
      command: request(device, "fill", "@e3", literal, "ios"),
      args: ["--json", "--platform", "ios", "fill", "--", "@e3", literal],
    },
    {
      command: request(device, "press", "@e3", "", "android"),
      args: ["--json", "--platform", "android", "press", "--", "@e3"],
    },
  ];

  for (const { command, args } of cases) {
    const output = await runAgentToolOperation(command, f.path(command.tool), f.env);

    expect(JSON.parse(output.text).data).toEqual(args);
  }
});

test("option injection and unsupported target forms fail before spawning", async () => {
  const f = fixture();

  const cases = [
    request(browser, "open", "--cdp=attacker"),
    request(browser, "click", "--config=/tmp/config"),
    request(browser, "fill", "--session=other", "text"),
    request(desktop, "click", "--headed"),
    request(desktop, "type", "@e1", "text"),
    request(device, "open", "app", "", "--config=attacker"),
    request(device, "type", "@e2", "text"),
    request(browser, "eval", "process.exit()"),
    request(browser, "fill", "@e1", "bad\0text"),
  ];

  for (const command of cases)
    await expect(async () => runAgentToolOperation(command, f.path(command.tool), f.env)).toThrow();
  expect(f.calls()).toHaveLength(0);
});

test("identical operations are serialized and executed twice instead of coalesced", async () => {
  const f = fixture();
  f.state(browser, { delay: 35 });
  const command = request(browser, "click", "@e1");
  await Promise.all([
    runAgentToolOperation(command, f.path(browser), f.env),
    runAgentToolOperation(command, f.path(browser), f.env),
  ]);

  expect(f.calls().map((call) => call.event)).toEqual(["start", "end", "start", "end"]);
});

test("JSON errors with exit zero are failures and large single-line JSON remains usable", async () => {
  const f = fixture();
  f.state(device, { failOperation: true });
  await expect(runAgentToolOperation(request(device, "snapshot"), f.path(device), f.env)).rejects.toThrow("ref failed");
  f.state(device, { text: "x".repeat(5000) });
  const result = await runAgentToolOperation(request(device, "snapshot"), f.path(device), f.env);

  expect(JSON.parse(result.text).data).toHaveLength(5000);
  expect(result.truncated).toBe(false);
});

test("screenshots are size-checked, decoded and normalized as PNG before returning", async () => {
  const f = fixture();

  const png = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "blue" } })
    .png()
    .toBuffer();

  f.state(browser, { screenshot: png.toString("base64") });
  const output = await runAgentToolOperation(request(browser, "screenshot"), f.path(browser), f.env);
  const info = await sharp(output.data).metadata();

  expect(output.mimeType).toBe("image/png");
  expect(info.format).toBe("png");
  expect(info.width).toBe(2000);
  expect(info.height).toBe(1000);
  f.state(browser, { oversize: true });
  await expect(runAgentToolOperation(request(browser, "screenshot"), f.path(browser), f.env)).rejects.toThrow(
    "larger than 4 MiB",
  );
  f.state(browser, { screenshot: Buffer.from("not an image").toString("base64") });
  await expect(runAgentToolOperation(request(browser, "screenshot"), f.path(browser), f.env)).rejects.toThrow(
    "not a PNG",
  );
  f.state(browser, { screenshot: png.subarray(0, 48).toString("base64") });
  await expect(runAgentToolOperation(request(browser, "screenshot"), f.path(browser), f.env)).rejects.toThrow();
  const privateFile = join(f.dir, "private.png");
  writeFileSync(privateFile, png);
  f.state(browser, { symlink: privateFile });
  await expect(runAgentToolOperation(request(browser, "screenshot"), f.path(browser), f.env)).rejects.toThrow();
});

test("MCP descriptors bind all automation tools to deterministic per-thread sessions", async () => {
  const f = fixture();

  const manager = new AgentTools({
    dataDir: f.dir,
    probe: { which: f.which, platform: "linux" },
    env: f.env,
    send: () => {},
    progress: () => {},
  });

  await manager.probe();
  const servers = manager.localMcpServers([browser, desktop, device]);

  expect(servers.map((server) => server.args)).toEqual([["mcp"], ["mcp"], ["mcp"]]);
  const first = manager.localMcpServers([browser, browser], "thread/one --config=other");
  const again = manager.localMcpServers([browser], "thread/one --config=other");
  const other = manager.localMcpServers([browser], "thread/two");

  expect(first).toEqual(again);
  expect(first).toHaveLength(1);
  expect(first[0]?.args).toEqual(["--session", expect.stringMatching(/^canopy-[a-f0-9]{32}$/), "mcp"]);
  expect(first[0]?.args).not.toEqual(other[0]?.args);
  const deviceServer = manager.localMcpServers([device], "thread/one --config=other")[0];

  expect(deviceServer?.args).toEqual(["mcp"]);
  expect(deviceServer?.env?.AGENT_DEVICE_SESSION).toBe(first[0]?.args[1]);
  expect(Object.keys(deviceServer?.env ?? {})).toEqual(["AGENT_DEVICE_SESSION"]);
  expect(first[0]?.env?.AGENT_BROWSER_SESSION).toBe(first[0]?.args[1]);
  expect(Object.keys(first[0]?.env ?? {})).toEqual(["AGENT_BROWSER_SESSION"]);
  expect(manager.localMcpServers([desktop], "thread/one")[0]?.env).toBeUndefined();

  for (const tool of [browser, desktop, device]) {
    expect(manager.localMcpServers([tool], "thread/one --config=other")[0]?.scope).toEqual({
      tool,
      session: agentToolSession("thread/one --config=other"),
    });
    expect(manager.localMcpServers([tool], "thread/two")[0]?.scope?.session).not.toBe(first[0]?.args[1]);
  }
});

test("explicit sessions and selectors map to supported CLI arguments and UI/MCP use the same session", async () => {
  const f = fixture();

  const manager = new AgentTools({
    dataDir: f.dir,
    probe: { which: f.which, platform: "linux" },
    env: f.env,
    send: () => {},
    progress: () => {},
  });

  await manager.probe();
  const session = "01a1dfd5-16dc-7754-863a-37ab6f183c82";
  const readBrowser = create(RunAgentToolSchema, { tool: browser, operation: "snapshot", session });
  const result = await manager.run(readBrowser);

  expect(JSON.parse(result.text).data).toEqual(["--json", "--session", session, "snapshot"]);
  expect(manager.localMcpServers([browser], session)[0]?.args).toEqual(["--session", session, "mcp"]);

  const cases = [
    {
      command: { tool: desktop, operation: "snapshot", app: "Text Editor", windowId: "123", session },
      args: ["--session", session, "snapshot", "--app=Text Editor", "--window-id=123", "-i"],
    },
    {
      command: { tool: desktop, operation: "press", value: "cmd+a", app: "Text Editor", windowId: "123" },
      args: ["press", "--app=Text Editor", "--window-id=123", "--", "cmd+a"],
    },
    { command: { tool: desktop, operation: "open", app: "Text Editor" }, args: ["launch", "--", "Text Editor"] },
    { command: { tool: desktop, operation: "close", app: "Text Editor" }, args: ["close-app", "--", "Text Editor"] },
    {
      command: {
        tool: device,
        operation: "open",
        app: "com.example.app",
        deviceId: "emulator-5554",
        platform: "android",
        session,
      },
      args: [
        "--json",
        "--session",
        session,
        "--platform",
        "android",
        "--serial",
        "emulator-5554",
        "open",
        "--",
        "com.example.app",
      ],
    },
    {
      command: { tool: device, operation: "snapshot", deviceId: "test-udid", platform: "ios" },
      args: ["--json", "--platform", "ios", "--udid", "test-udid", "snapshot", "-i"],
    },
  ];

  for (const { command, args } of cases) {
    const result = await runAgentToolOperation(create(RunAgentToolSchema, command), f.path(command.tool), f.env);

    expect(JSON.parse(result.text).data).toEqual(args);
  }
});

test("irrelevant selectors and selector controls are refused before spawning", async () => {
  const f = fixture();

  const cases = [
    { tool: browser, operation: "snapshot", app: "Finder" },
    { tool: browser, operation: "snapshot", session: "bad\nlabel" },
    { tool: desktop, operation: "snapshot", windowId: "--headed" },
    { tool: desktop, operation: "open", app: "Editor", windowId: "123" },
    { tool: desktop, operation: "click", target: "@s12:e1", app: "Editor" },
    { tool: desktop, operation: "click", target: "@s12:e1", windowId: "123" },
    { tool: desktop, operation: "snapshot", deviceId: "device" },
    { tool: device, operation: "snapshot", windowId: "123" },
    { tool: device, operation: "snapshot", app: "app" },
    { tool: device, operation: "snapshot", deviceId: "emulator-5554" },
    { tool: device, operation: "snapshot", deviceId: "web", platform: "web" },
    { tool: device, operation: "snapshot", deviceId: "--config", platform: "android" },
  ];

  for (const value of cases) {
    const command = create(RunAgentToolSchema, value);
    await expect(async () => runAgentToolOperation(command, f.path(command.tool), f.env)).toThrow();
  }

  expect(f.calls()).toHaveLength(0);
});

test("polling reuses readiness, failures invalidate it and explicit refresh forces a new check", async () => {
  const f = fixture();

  const manager = new AgentTools({
    dataDir: f.dir,
    probe: { which: f.which, platform: "linux" },
    env: f.env,
    send: () => {},
    progress: () => {},
  });

  await manager.probe();

  const doctors = () =>
    f.calls().filter((call) => call.tool === "agent-browser" && call.event === "start" && call.args[0] === "doctor")
      .length;

  const initial = doctors();
  await manager.run(request(browser, "snapshot"));
  await manager.run(request(browser, "snapshot"));

  expect(doctors()).toBe(initial);
  f.state(browser, { failOperation: true });
  await expect(manager.run(request(browser, "snapshot"))).rejects.toThrow("ref failed");
  f.state(browser, { ready: false });
  await expect(manager.run(request(browser, "snapshot"))).rejects.toThrow("Runtime is missing");
  expect(doctors()).toBe(initial + 1);
  f.state(browser, {});
  await manager.probe();
  expect(doctors()).toBe(initial + 2);
  await manager.run(request(browser, "snapshot"));
});

test("wire text truncation counts UTF-8 bytes including the marker", async () => {
  const f = fixture();
  f.state(device, { text: "€".repeat(180_000) });
  const result = await runAgentToolOperation(request(device, "snapshot"), f.path(device), f.env);

  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(512 * 1024);
  expect(result.text.endsWith("\n[output truncated]")).toBe(true);
  expect(result.text.includes("\ufffd")).toBe(false);
});

test("an operation that expires waiting for the shared CLI is never executed later", async () => {
  const f = fixture();
  f.state(browser, { delay: 2700 });
  const command = request(browser, "click", "@e1");
  const first = runAgentToolOperation(command, f.path(browser), f.env);
  const second = runAgentToolOperation(command, f.path(browser), f.env);
  await expect(second).rejects.toThrow("busy");
  await first;

  expect(f.calls().map((call) => call.event)).toEqual(["start", "end"]);
});
