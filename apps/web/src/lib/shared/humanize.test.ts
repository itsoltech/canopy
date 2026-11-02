import { describe, expect, test } from "bun:test";
import { humanizeEnum, humanizeKey, humanizeSeconds, humanizeToolName, isEnumToken, isIdKey, isIsoDateTime, isOpaqueId, words } from "./humanize.ts";

describe("words", () => {
  test("splits every naming style", () => {
    expect(words("file_path")).toEqual(["file", "path"]);
    expect(words("afterSeq")).toEqual(["after", "Seq"]);
    expect(words("WebFetch")).toEqual(["Web", "Fetch"]);
    expect(words("PERMISSION_MODE_FULL_AUTO")).toEqual(["PERMISSION", "MODE", "FULL", "AUTO"]);
    expect(words("chrome-devtools")).toEqual(["chrome", "devtools"]);
    expect(words("HTMLParser")).toEqual(["HTML", "Parser"]);
  });
});

describe("humanizeKey", () => {
  test("sentence case with known spellings", () => {
    expect(humanizeKey("thread_ids")).toBe("Thread IDs");
    expect(humanizeKey("afterSeq")).toBe("After seq");
    expect(humanizeKey("url")).toBe("URL");
    expect(humanizeKey("timeout_seconds")).toBe("Timeout");
  });

  test("named keys read as their meaning", () => {
    expect(humanizeKey("file_path")).toBe("File");
    expect(humanizeKey("filePath")).toBe("File");
    expect(humanizeKey("cwd")).toBe("Working directory");
    expect(humanizeKey("permission_mode")).toBe("Permissions");
  });
});

describe("humanizeEnum", () => {
  test("proto keys lose their prefix", () => {
    expect(humanizeEnum("PERMISSION_MODE_FULL_AUTO")).toBe("Full auto");
    expect(humanizeEnum("ITEM_STATUS_IN_PROGRESS")).toBe("In progress");
    expect(humanizeEnum("INTERACTION_KIND_PERMISSION")).toBe("Permission");
    expect(humanizeEnum("PROVIDER_CLAUDE")).toBe("Claude");
  });

  test("unspecified says nothing", () => {
    expect(humanizeEnum("PERMISSION_MODE_UNSPECIFIED")).toBe("");
    expect(humanizeEnum("")).toBe("");
  });

  test("bare keys and snake case", () => {
    expect(humanizeEnum("FULL_AUTO")).toBe("Full auto");
    expect(humanizeEnum("full_auto")).toBe("Full auto");
    expect(humanizeEnum("user_message")).toBe("User message");
    expect(humanizeEnum("waiting_input")).toBe("Waiting input");
  });
});

describe("humanizeToolName", () => {
  test("snake, camel and MCP names", () => {
    expect(humanizeToolName("read_thread")).toBe("Read thread");
    expect(humanizeToolName("WebFetch")).toBe("Web fetch");
    expect(humanizeToolName("mcp__github__get_issue")).toBe("GitHub · Get issue");
    expect(humanizeToolName("exec_command")).toBe("Exec command");
  });
});

describe("value kinds", () => {
  test("opaque ids", () => {
    expect(isOpaqueId("01a198ce-fe6b-757d-a524-4dd87fb54c63")).toBe(true);
    expect(isOpaqueId("toolu_01FoEfXKGNKxkUhjKeTgi13K")).toBe(true);
    expect(isOpaqueId("call_fe3a463048834b49aa43b549fc9a6e33")).toBe(true);
    expect(isOpaqueId("exec-e09efa64-5b29-4d9f-9098-78ca992bb960")).toBe(true);
    expect(isOpaqueId("3f2a9c0d4e5b6a7f8091")).toBe(true);
    expect(isOpaqueId("Hello world")).toBe(false);
    expect(isOpaqueId("src/lib/format.ts")).toBe(false);
    expect(isOpaqueId("README")).toBe(false);
    expect(isOpaqueId("internationalization")).toBe(false);
  });

  test("id keys", () => {
    expect(isIdKey("id")).toBe(true);
    expect(isIdKey("thread_id")).toBe(true);
    expect(isIdKey("thread_ids")).toBe(true);
    expect(isIdKey("requestId")).toBe(true);
    expect(isIdKey("paid")).toBe(false);
    expect(isIdKey("valid")).toBe(false);
  });

  test("dates and enum tokens", () => {
    expect(isIsoDateTime("2026-11-01T18:21:00.781Z")).toBe(true);
    expect(isIsoDateTime("2026-11-01")).toBe(false);
    expect(isEnumToken("full_auto")).toBe(true);
    expect(isEnumToken("ITEM_STATUS_COMPLETED")).toBe(true);
    expect(isEnumToken("hello")).toBe(false);
    expect(isEnumToken("file_path.ts")).toBe(false);
  });
});

describe("humanizeSeconds", () => {
  test("two largest units", () => {
    expect(humanizeSeconds(60)).toBe("1 minute");
    expect(humanizeSeconds(5400)).toBe("1 hour 30 minutes");
    expect(humanizeSeconds(45)).toBe("45 seconds");
    expect(humanizeSeconds(90061)).toBe("1 day 1 hour");
    expect(humanizeSeconds(0)).toBe("");
  });
});
