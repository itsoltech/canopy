import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ProfileModelsSchema, Provider } from "@open-agents/contracts";
import { sanitizeTitle, titleContext, titleModel, titlePrompt } from "./thread-titles.ts";

test("title prompts describe the task, carry bounded context and append custom instructions", () => {
  const context = titleContext({ text: "/goal napisać siema\ndruga linia", mentions: [{ label: "notes.md" }], attachments: [{ name: "screen.png" }], quotes: [{ text: "quoted task" }] });
  expect(context).toStartWith("napisać siema");
  expect(context).not.toContain("/goal");
  expect(context).toContain("screen.png");
  const prompt = titlePrompt(context, "Use Polish");
  expect(prompt).toContain("language of the user's message");
  expect(prompt).toContain(JSON.stringify(context));
  expect(prompt).toEndWith("Additional title instructions:\nUse Polish");
  expect(titleContext({ text: "x".repeat(100_000) }).length).toBe(8_000);
});

test("titles are one plain bounded Unicode line without wrapping punctuation or markdown", () => {
  for (const raw of ['"Naprawa logowania."', "**Naprawa logowania**", "# Naprawa logowania", "Title: ‘Naprawa logowania’\nexplanation", "```text\nNaprawa logowania\n```", "[Naprawa logowania](https://example.com)"]) {
    expect(sanitizeTitle(raw)).toBe("Naprawa logowania");
  }
  expect(sanitizeTitle(" --- ")).toBe("");
  expect(Array.from(sanitizeTitle("🧑".repeat(100)))).toHaveLength(60);
  expect(sanitizeTitle("Popraw\u0000 logowanie\u202e.")).toBe("Popraw logowanie");
});

test("default model prefers visible small tiers, newest at a tier, low only when supported", () => {
  const claude = create(ProfileModelsSchema, { provider: Provider.CLAUDE, models: [
    { id: "opus", isDefault: true }, { id: "haiku", resolvedModel: "claude-haiku-5-5", efforts: [] },
    { id: "claude-haiku-5-4", efforts: ["low", "high"] }, { id: "claude-haiku-9", hidden: true },
  ] });
  expect(titleModel(claude, "opus")).toEqual({ model: "haiku", effort: "" });
  const codex = create(ProfileModelsSchema, { provider: Provider.CODEX, models: [
    { id: "gpt-6.1-sol", isDefault: true }, { id: "gpt-5-mini", efforts: ["medium", "low"] },
    { id: "gpt-6-mini", efforts: ["low", "high"] }, { id: "gpt-4-nano", efforts: [] },
  ] });
  expect(titleModel(codex, "gpt-6.1-sol")).toEqual({ model: "gpt-4-nano", effort: "" });
  codex.models.pop();
  expect(titleModel(codex, "gpt-6.1-sol")).toEqual({ model: "gpt-6-mini", effort: "low" });
  codex.models.splice(1);
  expect(titleModel(codex, "gpt-6.1-sol")).toEqual({ model: "gpt-6.1-sol", effort: "" });
  expect(titleModel(undefined, "own-model")).toEqual({ model: "own-model", effort: "low" });
});
