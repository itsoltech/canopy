import { describe, expect, test } from "bun:test";
import { approvalPrompt, needsApproval, nextHop, PLATFORM_TOOLS, statusPhrase } from "./policy.ts";
import { remoteUrl } from "./store.ts";

describe("bot capability policy", () => {
  test("only remote read-only MCP tools bypass approval; unknown tools are never local capabilities", () => {
    const remote = { name: "search", description: "", parameters: {}, source: "mcp" as const };
    expect(needsApproval(remote, "safe")).toBe(true);
    expect(needsApproval({ ...remote, readOnly: true }, "safe")).toBe(false);
    expect(needsApproval({ ...remote, readOnly: true, dangerous: true }, "safe")).toBe(true);
    expect(needsApproval({ ...remote, readOnly: true }, "always")).toBe(true);
    expect(PLATFORM_TOOLS.some((t) => /shell|exec|file|browser|patch/.test(t.name))).toBe(false);
    expect(
      needsApproval(
        PLATFORM_TOOLS.find((t) => t.name === "archive_thread")!,
        "safe",
      ),
    ).toBe(true);
    expect(
      needsApproval(
        PLATFORM_TOOLS.find((t) => t.name === "ask_user")!,
        "safe",
      ),
    ).toBe(true);
    // Full auto keeps the protected platform actions and questions behind owner approval.
    expect(needsApproval({ ...remote, dangerous: true }, "full_auto")).toBe(false);
    expect(
      needsApproval(
        PLATFORM_TOOLS.find((t) => t.name === "archive_thread")!,
        "full_auto",
      ),
    ).toBe(true);
    expect(
      needsApproval(
        PLATFORM_TOOLS.find((t) => t.name === "ask_user")!,
        "full_auto",
      ),
    ).toBe(true);
    // Escalating to full auto from another policy still asks.
    expect(
      needsApproval(
        PLATFORM_TOOLS.find((t) => t.name === "update_self")!,
        "safe",
        { approval_policy: "full_auto" },
      ),
    ).toBe(true);
  });
  test("human-readable status never exposes raw MCP or function names", () => {
    expect(
      statusPhrase({
        name: "mcp_abcd",
        source: "mcp",
        description: "",
        parameters: {},
        remoteName: "notion_search",
        serverName: "Notion",
      }),
    ).toBe("Searching Notion");
    expect(
      statusPhrase({
        name: "mcp_abcd",
        source: "mcp",
        description: "",
        parameters: {},
        remoteName: "fetch_page",
        serverName: "Notion",
      }),
    ).toBe("Checking Notion");
    expect(
      statusPhrase(
        PLATFORM_TOOLS.find((t) => t.name === "start_thread")!,
        { project_name: "CRM" },
      ),
    ).toBe("Starting a thread in CRM");
  });
  test("the agent-bus hop budget cannot reset through bots", () => {
    expect(nextHop(0)).toBe(1);
    expect(nextHop(7)).toBe(8);

    for (const hops of [8, 9, -1, NaN, 0.5]) expect(() => nextHop(hops)).toThrow();
  });
  test("approval cards identify the destination and proposed change without raw JSON or credentials", () => {
    const prompt = approvalPrompt(
      PLATFORM_TOOLS.find((t) => t.name === "set_thread_model")!,
      { thread_id: "destination", model: "chosen-model", effort: "high", token: "do-not-show" },
      "Updating settings for CRM",
    );

    expect(prompt).toContain("CRM");
    expect(prompt).toContain("Thread id: destination");
    expect(prompt).toContain("Model: chosen-model");
    expect(prompt).not.toContain("do-not-show");
    expect(prompt).not.toContain('{"');
  });
  test("MCP registry cannot launch local transports or put secrets in URLs", () => {
    expect(remoteUrl("https://example.com/mcp")).toBe("https://example.com/mcp");

    for (const url of [
      "stdio:node",
      "file:///etc/passwd",
      "https://user:secret@example.com",
      "https://example.com?token=secret",
    ])
      expect(() => remoteUrl(url)).toThrow();
  });
});
