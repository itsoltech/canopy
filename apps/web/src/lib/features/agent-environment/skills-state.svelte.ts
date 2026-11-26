import { HARNESSES } from "@canopy/domain/harnesses";
import { clone, create } from "@bufbuild/protobuf";
import { ui, type SkillFile } from "@canopy/contracts";
import { encode } from "#lib/shared/wire.ts";
import type { EnvironmentState } from "./environment-state.svelte.ts";
import { revealEnvironmentItem } from "./environment-feedback.ts";

export class SkillsState {
  draft = $state<ui.LibrarySkill>();
  files = $state.raw<SkillFile[]>([]);
  zip = $state.raw<Uint8Array>(new Uint8Array());
  #revision = 0n;
  constructor(readonly environment: EnvironmentState) {}
  edit(skill?: ui.LibrarySkill): ui.LibrarySkill {
    this.#revision = this.environment.snapshot.revision;
    this.files = [];
    this.zip = new Uint8Array();
    this.draft = skill
      ? clone(ui.LibrarySkillSchema, skill)
      : create(ui.LibrarySkillSchema, {
          harnesses: [...HARNESSES],
          selector: { everyone: true },
          platformHome: true,
        });

    return this.draft;
  }
  async save(onsaved?: () => void, expectedRevision = this.#revision): Promise<void> {
    if (!this.draft) return;
    const previousIds = new Set(this.environment.snapshot.skills.map((s) => s.id));
    const id = this.draft.id;

    const request = create(ui.SaveLibrarySkillRequestSchema, {
      skill: create(ui.LibrarySkillSchema, { ...this.draft, artifact: undefined }),
      files: this.files,
      zip: this.zip,
      expectedRevision,
    });

    const saved = await this.environment.mutate("POST", "/skills", encode(ui.SaveLibrarySkillRequestSchema, request));

    if (saved) {
      this.draft = undefined;
      this.environment.notice =
        "Skill saved. Assigned computers will sync when connected. New harness sessions use the saved version.";
      onsaved?.();
      void revealEnvironmentItem(id || saved.skills.find((s) => !previousIds.has(s.id))?.id || "");
    }
  }
  async remove(skill: ui.LibrarySkill, revision = this.environment.snapshot.revision) {
    return this.environment.mutate(
      "DELETE",
      "/skills",
      encode(
        ui.DeleteLibrarySkillRequestSchema,
        create(ui.DeleteLibrarySkillRequestSchema, {
          id: skill.id,
          expectedRevision: revision,
        }),
      ),
    );
  }
}
