import { create, toJson } from "@bufbuild/protobuf";
import {
  AgentEnvironmentReportSchema,
  EnvironmentSkillStatusSchema,
  type AgentEnvironmentDesired,
  type AgentEnvironmentReport,
} from "@canopy/contracts";
import { ENVIRONMENT_CONTENT_BYTES, environmentDigest } from "@canopy/domain/agent-environment";
import { InstructionLedger } from "./ledger.ts";
import { instructionTargets, type EnvironmentHomes } from "./targets.ts";
import { reconcileInstruction } from "./reconcile.ts";
import { SkillLedger } from "./skill-ledger.ts";
import { skillTargets } from "./skill-targets.ts";
import { reconcileSkill } from "./skill-reconcile.ts";
import { validateSkillFiles, SKILL_TOTAL_BYTES } from "@canopy/domain/skill-artifact";

/** Reconcile only owner-approved immutable artifacts; never execute their scripts or install dependencies. */
export class WorkerAgentEnvironment {
  readonly ledger: InstructionLedger;
  readonly skills: SkillLedger;
  #desired: AgentEnvironmentDesired | undefined;
  #last = "";
  #timer: ReturnType<typeof setInterval>;

  constructor(
    readonly options: {
      homes: () => EnvironmentHomes;
      send: (report: AgentEnvironmentReport) => void;
    },
  ) {
    this.ledger = new InstructionLedger(options.homes().dataDir);
    this.skills = new SkillLedger(options.homes().dataDir);
    this.#timer = setInterval(() => this.refresh(), 15_000);
    this.#timer.unref();
  }

  apply(desired: AgentEnvironmentDesired): void {
    if (this.#desired && desired.revision < this.#desired.revision) return;

    if (
      desired.instructions.length > 4 ||
      desired.resolutions.length > 128 ||
      desired.instructions.some(
        (i) =>
          !["claude", "codex"].includes(i.harness) ||
          Buffer.byteLength(i.content) > ENVIRONMENT_CONTENT_BYTES ||
          environmentDigest(i.content) !== i.checksum,
      )
    )
      return;

    try {
      if (desired.skills.length > 100 || desired.skillResolutions.length > 512) return;
      let total = 0;

      for (const skill of desired.skills) {
        if (
          !skill.artifact ||
          !skill.id ||
          !skill.version ||
          !skill.harnesses.length ||
          skill.harnesses.some((h) => !["claude", "codex", "grok"].includes(h))
        )
          return;
        const validated = validateSkillFiles(skill.artifact.files);

        if (validated.checksum !== skill.artifact.checksum || validated.name !== skill.artifact.name) return;
        total += skill.artifact.files.reduce((sum, file) => sum + file.content.length, 0);

        if (total > SKILL_TOTAL_BYTES) return;
        // Use verified per-file checksums, never those supplied by a remote caller.
        skill.artifact = validated;
      }
    } catch {
      return;
    }

    this.#desired = desired;
    this.refresh(true);
  }

  refresh(force = false): void {
    if (!this.#desired) return;
    const desired = this.#desired;
    const report = create(AgentEnvironmentReportSchema, { revision: desired.revision });

    try {
      report.files = instructionTargets(desired, this.options.homes(), this.ledger).map((target) =>
        reconcileInstruction(
          target,
          this.ledger,
          desired.resolutions.find((r) => r.targetId === target.targetId),
        ),
      );
    } catch (error) {
      report.files.push(
        create(AgentEnvironmentReportSchema, {
          files: [
            {
              status: "error",
              detail: error instanceof Error ? error.message : "Couldn't resolve the instruction destinations.",
            },
          ],
        }).files[0]!,
      );
    }

    try {
      let comparisonBytes = 0;

      for (const target of skillTargets(desired, this.options.homes(), this.skills)) {
        const status = reconcileSkill(
          target,
          this.skills,
          desired.skillResolutions.find((r) => r.targetId === target.targetId),
        );

        const size = Buffer.byteLength(JSON.stringify(toJson(EnvironmentSkillStatusSchema, status)));

        // A skill can appear in many homes. Keep the complete report below the gateway's 128 MiB bound.
        if ((status.managedFiles.length || status.desiredFiles.length) && comparisonBytes + size > 96 * 1024 * 1024) {
          status.managedFiles = [];
          status.desiredFiles = [];
          status.importable = false;
          status.status = "error";
          status.detail =
            "Other skill comparisons fill this report. Resolve those conflicts first to compare this skill. Its files were preserved.";
        } else comparisonBytes += size;
        report.skills.push(status);
      }
    } catch (error) {
      report.skills.push(
        create(AgentEnvironmentReportSchema, {
          skills: [
            {
              status: "error",
              detail: error instanceof Error ? error.message : "Couldn't resolve skill destinations.",
            },
          ],
        }).skills[0]!,
      );
    }

    // Resolutions authorize one attempt against previewed bytes, never future local edits.
    desired.resolutions = [];
    desired.skillResolutions = [];

    const checksum = environmentDigest(JSON.stringify(toJson(AgentEnvironmentReportSchema, report)));

    if (force || checksum !== this.#last) {
      this.#last = checksum;
      this.options.send(report);
    }
  }

  stop(): void {
    clearInterval(this.#timer);
  }
}
