import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, type Mention } from "@open-agents/contracts";
import type { v2 } from "@open-agents/codex-protocol";
import { tempDirs } from "@open-agents/testing";
import { claudeCatalogEntries, claudeCatalogStamp, claudeSkillsOnDisk } from "../providers/claude/catalog.ts";
import { codexAppEntries, codexPluginEntries, codexSkillEntries } from "../providers/codex/catalog.ts";
import { codexUserInput } from "../providers/codex/input.ts";
import { withUserMentions } from "../providers/codex/threads.ts";
import { DEFAULT_NATIVE_TOOL_POLICY } from "../providers/native-tools.ts";
import { CatalogCache } from "./catalog.ts";
import { catalogIcon, MAX_ICON_BYTES } from "./icons.ts";

const tempDir = tempDirs();

const mention = (text: string, placeholder: string, init: { kind: MentionKind; name: string; path: string }): Mention => {
  const start = text.indexOf(placeholder);
  return create(MentionSchema, { ...init, start, end: start + placeholder.length });
};

describe("Codex input", () => {
  test("text elements in UTF-8 bytes, native skill, mention and image items", () => {
    const text = "Zażółć $imagegen z $apple-music, plik @a/ż.png i @docs/x.md";
    const mentions = [
      mention(text, "$imagegen", { kind: MentionKind.SKILL, name: "imagegen", path: "/h/skills/.system/imagegen/SKILL.md" }),
      mention(text, "$apple-music", { kind: MentionKind.PLUGIN, name: "apple-music", path: "app://asdk_app_1" }),
      mention(text, "@a/ż.png", { kind: MentionKind.FILE, name: "a/ż.png", path: "/w/a/ż.png" }),
      mention(text, "@docs/x.md", { kind: MentionKind.FILE, name: "docs/x.md", path: "/w/docs/x.md" }),
    ];
    const items = codexUserInput({ text, mentions });
    const first = items[0] as Extract<v2.UserInput, { type: "text" }>;
    const bytes = new TextEncoder().encode(text);
    const decoded = first.text_elements.map((e) => new TextDecoder().decode(bytes.slice(e.byteRange.start, e.byteRange.end)));
    expect(decoded).toEqual(["$imagegen", "$apple-music", "@a/ż.png", "@docs/x.md"]);
    expect(first.text_elements.map((e) => e.placeholder)).toEqual(decoded);
    expect(items.slice(1)).toEqual([
      { type: "skill", name: "imagegen", path: "/h/skills/.system/imagegen/SKILL.md" },
      { type: "mention", name: "apple-music", path: "app://asdk_app_1" },
      { type: "localImage", path: "/w/a/ż.png" },
    ]);
  });

  test("without mentions: one text item as before", () => {
    expect(codexUserInput({ text: "hi", mentions: [] })).toEqual([{ type: "text", text: "hi", text_elements: [] }]);
  });

  test("the userMessage echo keeps the mentions of its input", () => {
    const m = [create(MentionSchema, { kind: MentionKind.SKILL, name: "s", start: 0, end: 2 })];
    const echo = { turnId: "t", body: { case: "itemCompleted" as const, value: { item: { itemId: "i", content: { case: "userMessage" as const, value: { text: "$s", clientId: "t" } } } } } };
    const out = withUserMentions(echo, new Map([["t", m]]));
    expect(out.body?.case === "itemCompleted" && out.body.value?.item?.content?.case === "userMessage" && out.body.value.item.content.value?.mentions).toEqual(m);
    expect(withUserMentions(echo, new Map())).toBe(echo);
  });
});

describe("Claude catalog", () => {
  const folder = tempDir("oa-claude-catalog-");
  const home = tempDir("oa-claude-home-");
  mkdirSync(join(folder, ".claude", "skills", "hello-skill"), { recursive: true });
  writeFileSync(join(folder, ".claude", "skills", "hello-skill", "SKILL.md"), "---\nname: hello-skill\n---\n");
  mkdirSync(join(home, "skills", "home-skill"), { recursive: true });
  writeFileSync(join(home, "skills", "home-skill", "SKILL.md"), "x");

  test("skills on disk are skills, the rest commands; platform-owned and disabled built-ins are left out", () => {
    const skills = claudeSkillsOnDisk(join(folder), home);
    expect([...skills.keys()].sort()).toEqual(["hello-skill", "home-skill"]);
    const entries = claudeCatalogEntries(
      [
        { name: "hello-skill", description: "Says hello (project)", argumentHint: "" },
        { name: "marker", description: "Prints a marker (project)", argumentHint: "<word>" },
        { name: "compact", description: "Free up context", argumentHint: "<instructions>", builtin: true },
        { name: "model", description: "Set the model", argumentHint: "", builtin: true },
        { name: "goal", description: "Set a goal", argumentHint: "", builtin: true },
        { name: "loop", description: "Repeat", argumentHint: "", builtin: true },
        { name: "batch", description: "Parallel agents", argumentHint: "", builtin: true },
        { name: "__remote-workflow", description: "internal", argumentHint: "", builtin: true },
        { name: "usage", description: "Usage", argumentHint: "", aliases: ["cost"], builtin: true },
      ],
      skills,
      DEFAULT_NATIVE_TOOL_POLICY,
    );
    expect(entries.map((e) => [e.name, e.kind, e.source, e.description])).toEqual([
      ["hello-skill", MentionKind.SKILL, "project", "Says hello"],
      ["marker", MentionKind.COMMAND, "project", "Prints a marker"],
      ["compact", MentionKind.COMMAND, "built-in", "Free up context"],
      ["usage", MentionKind.COMMAND, "built-in", "Usage"],
    ]);
    expect(entries[0]?.path).toBe(join(folder, ".claude", "skills", "hello-skill", "SKILL.md"));
    expect(entries[3]?.aliases).toEqual(["cost"]);
    const withNative = claudeCatalogEntries([{ name: "loop", description: "", argumentHint: "", builtin: true }], skills, { ...DEFAULT_NATIVE_TOOL_POLICY, nativeScheduling: true });
    expect(withNative.map((e) => e.name)).toEqual(["loop"]);
  });

  test("the stamp changes when a skill folder changes", async () => {
    const before = claudeCatalogStamp(folder, home);
    await Bun.sleep(5);
    mkdirSync(join(folder, ".claude", "skills", "another"));
    expect(claudeCatalogStamp(folder, home)).not.toBe(before);
  });
});

describe("Codex catalog", () => {
  test("enabled skills with display names and icons; installed plugins; accessible apps", () => {
    const dir = tempDir("oa-icons-");
    writeFileSync(join(dir, "small.svg"), "<svg/>");
    writeFileSync(join(dir, "big.png"), new Uint8Array(MAX_ICON_BYTES + 1));
    const skills = codexSkillEntries({
      data: [
        {
          cwd: "/w",
          skills: [
            { name: "imagegen", description: "long", path: "/h/imagegen/SKILL.md", scope: "system", enabled: true, pluginId: null, interface: { displayName: "Image Gen", shortDescription: "Generate images", iconSmall: join(dir, "small.svg"), iconSmallUrl: null, iconLargeUrl: null } },
            { name: "repo-skill", description: "Repo", path: "/w/.agents/skills/repo-skill/SKILL.md", scope: "repo", enabled: true, pluginId: null },
            { name: "off", description: "", path: "/x", scope: "user", enabled: false, pluginId: null },
          ],
          errors: [{ path: "/w/.agents/skills/bad/SKILL.md", message: "missing name" }],
        },
      ],
    } as v2.SkillsListResponse);
    expect(skills.entries.map((e) => [e.name, e.label, e.source, e.description])).toEqual([
      ["imagegen", "Image Gen", "system", "Generate images"],
      ["repo-skill", "", "project", "Repo"],
    ]);
    expect(skills.entries[0]?.icon).toBe(`data:image/svg+xml;base64,${btoa("<svg/>")}`);
    expect(skills.notes).toEqual(["skill /w/.agents/skills/bad/SKILL.md: missing name"]);
    expect(catalogIcon(join(dir, "big.png"))).toBe("");
    expect(catalogIcon("http://insecure/x.png")).toBe("");

    const plugins = codexPluginEntries({
      marketplaces: [{ name: "m", path: null, interface: null, plugins: [
        { id: "music@m", name: "music", installed: true, enabled: true, interface: { displayName: "Apple Music", shortDescription: "Play", composerIconUrl: "https://cdn/x.png" } },
        { id: "other@m", name: "other", installed: false, enabled: false, interface: null },
      ] }],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    } as unknown as v2.PluginListResponse);
    expect(plugins).toEqual([expect.objectContaining({ name: "music", label: "Apple Music", path: "plugin://music@m", icon: "https://cdn/x.png" })]);

    const apps = codexAppEntries({ data: [{ id: "c1", name: "Google Drive", description: "Files", logoUrl: null, isAccessible: true, isEnabled: true }, { id: "c2", name: "Off", isAccessible: false, isEnabled: true }], nextCursor: null } as unknown as v2.AppsListResponse);
    expect(apps).toEqual([expect.objectContaining({ name: "google-drive", label: "Google Drive", path: "app://c1" })]);
  });
});

describe("catalog cache", () => {
  test("reused while the stamp holds and young; a refresh or a new stamp lists again; failures are not kept", async () => {
    const cache = new CatalogCache();
    let loads = 0;
    const load = async () => ({ entries: [], notes: [String(++loads)] });
    await cache.get("k", "s1", load, false, 0);
    await cache.get("k", "s1", load, false, 1000);
    expect(loads).toBe(1);
    await cache.get("k", "s2", load, false, 2000);
    await cache.get("k", "s2", load, true, 3000);
    await cache.get("k", "s2", load, false, 3000 + 6 * 60_000);
    expect(loads).toBe(4);
    await cache.get("f", "s", () => Promise.reject(new Error("x")), false, 0).catch(() => undefined);
    await Bun.sleep(0);
    await cache.get("f", "s", load, false, 1);
    expect(loads).toBe(5);
  });
});
