import { expect, test } from "bun:test";
import { clone, create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { skillFingerprint } from "./library-apply-skills.ts";

test("Undo's fingerprint protects the full source, including update policy and credential association", () => {
  const skill = create(ui.LibrarySkillSchema, {
    name: "fixture",
    version: 1n,
    source: {
      url: "https://github.com/fixture/skills.git",
      ref: "main",
      path: "skills/fixture",
      commit: "a".repeat(40),
      credentialAccountId: "initial-account",
      autoUpdate: false,
      pinned: false,
    },
  });

  const fingerprint = skillFingerprint(skill);

  const changes = [
    { autoUpdate: true },
    { credentialAccountId: "other-account" },
    { pinned: true },
    { url: "https://github.com/fixture/other.git" },
    { ref: "next" },
    { path: "skills/other" },
    { commit: "b".repeat(40) },
    { checkedAt: "2026-11-07" },
    { availableCommit: "c".repeat(40) },
    { updatePreviewId: "preview" },
    { error: "Changed" },
  ];

  for (const source of changes) {
    const changed = clone(ui.LibrarySkillSchema, skill);
    changed.source = create(ui.SkillSourceSchema, { ...skill.source!, ...source });
    expect(skillFingerprint(changed) === fingerprint).toBe(false);
  }
});
