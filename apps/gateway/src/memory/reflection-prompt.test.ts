import { expect, test } from "bun:test";
import { reflectionBatch, reflectionProposals, reflectionText } from "./reflection-prompt.ts";
import type { ReflectionSource } from "./reflection-source.ts";

function source(message: string, index: number): ReflectionSource {
  const id = String(index);

  return {
    project_id: "p",
    thread_id: id,
    turn_id: id,
    steer_id: null,
    message_id: id,
    family_id: id,
    created_at: new Date(0),
    message,
  };
}

test("reflection keeps a direct request outside pasted evidence and rejects credentials or logs", () => {
  expect(
    reflectionText(
      "Po zmianach UI pokaż zrzut przez `show_images`.\n\n> Log excerpt\nlazy continuation\n\n```sh\ncat config\n```",
    ),
  ).toBe("Po zmianach UI pokaż zrzut przez show_images.");

  expect(reflectionText("Show me this:\n```\nnot a user request\n")).toBe("Show me this:");

  for (const text of [
    "WARNING: example error\nShow the screenshot",
    "Use the screenshot with password=example.",
    "Use the screenshot with ghp_example.",
    "Show /tmp/capture.png",
    "[canopy] Task from another thread",
    '"Show the screenshot"',
  ])
    expect(reflectionText(text)).toBe("");
});

test("bounded UTF-8 input and typed references prevent oversized or invented proposals", () => {
  const rows = Array.from({ length: 40 }, (_, n) => source("Pokaż zrzut. " + "Żółć ".repeat(60), n));
  const { sources, prompt } = reflectionBatch(rows);
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8192);
  expect(sources.size).toBeGreaterThan(1);
  expect(sources.size).toBeLessThan(rows.length);
  const item = { condition: "ui_changes", action: "show_screenshot", signal: "reminder", sources: ["m1", "m1", "m2"] };
  const valid = JSON.stringify({ proposals: [item] });
  expect(reflectionProposals(valid, sources)?.[0]?.evidence).toHaveLength(2);

  for (const invalid of [
    valid.replace("m2", "m1000"),
    valid.replace("show_screenshot", "run_shell_command"),
    valid.repeat(120),
    JSON.stringify({ proposals: [item, item] }),
  ])
    expect(reflectionProposals(invalid, sources)).toBeUndefined();
});
