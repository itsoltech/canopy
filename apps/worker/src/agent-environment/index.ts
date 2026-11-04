import { create, toJson } from "@bufbuild/protobuf";
import {
  AgentEnvironmentReportSchema,
  type AgentEnvironmentDesired,
  type AgentEnvironmentReport,
} from "@canopy/contracts";
import { ENVIRONMENT_CONTENT_BYTES, environmentDigest } from "@canopy/domain/agent-environment";
import { InstructionLedger } from "./ledger.ts";
import { instructionTargets, type EnvironmentHomes } from "./targets.ts";
import { reconcileInstruction } from "./reconcile.ts";

/** No upstream code is installed here. Only owner-authored instruction text is reconciled. */
export class WorkerAgentEnvironment {
  readonly ledger: InstructionLedger;
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
      // Resolutions authorize one attempt against the previewed bytes, never future local edits.
      desired.resolutions = [];
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
