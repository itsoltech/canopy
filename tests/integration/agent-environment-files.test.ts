/** Filesystem durability and harness isolation, using temp homes rather than the machine's CLI configuration. */
import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentEnvironmentDesiredSchema,
  EnvironmentInstructionSchema,
  Provider,
  ProviderProfileKind,
  WorkerConfigSchema,
  type AgentEnvironmentReport,
} from "@canopy/contracts";
import { environmentBlock, environmentDigest, readEnvironmentBlock } from "@canopy/domain/agent-environment";
import { tempDirs } from "@canopy/testing";
import { applyWorkerConfig } from "@canopy/worker/config";
import { WorkerAgentEnvironment } from "../../apps/worker/src/agent-environment/index.ts";
import { readInstructionFile, replaceInstructionFile } from "../../apps/worker/src/agent-environment/files.ts";
import { InstructionLedger } from "../../apps/worker/src/agent-environment/ledger.ts";
import { reconcileInstruction } from "../../apps/worker/src/agent-environment/reconcile.ts";
import { managedClaudeInstructions } from "../../apps/worker/src/providers/claude/instructions.ts";

const scratch = tempDirs();

function fixture() {
  const root = scratch("canopy-environment-files-");
  const path = join(root, "home", "CLAUDE.md");
  const dataDir = join(root, "data");
  const ledger = new InstructionLedger(dataDir);

  const target = {
    targetId: environmentDigest(path),
    path,
    harness: "claude",
    scope: "platform",
    content: "Base instructions.",
  } as const;

  return { root, path, dataDir, ledger, target };
}

describe("managed global instruction files", () => {
  test("ownership survives restarts; idempotent reconcile preserves inode and surrounding bytes", () => {
    const f = fixture();
    mkdirSync(join(f.root, "home"), { recursive: true });
    writeFileSync(f.path, "Local preface\r\n");
    expect(reconcileInstruction(f.target, f.ledger, undefined).status).toBe("applied");
    const text = readFileSync(f.path, "utf8");
    const inode = lstatSync(f.path).ino;
    const restarted = new InstructionLedger(f.dataDir);
    expect(reconcileInstruction(f.target, restarted, undefined).status).toBe("applied");
    expect(lstatSync(f.path).ino).toBe(inode);
    writeFileSync(f.path, `${text}Local epilogue\r\n`);
    expect(reconcileInstruction({ ...f.target, content: "Updated." }, restarted, undefined).status).toBe("applied");
    const updated = readFileSync(f.path, "utf8");
    expect(updated).toStartWith("Local preface\r\n");
    expect(updated).toEndWith("Local epilogue\r\n");
    expect(readEnvironmentBlock(updated)?.content).toBe("Updated.");
    expect(readdirSync(join(f.root, "home"))).toEqual(["CLAUDE.md"]);
  });

  test("a failed journal write rolls the instruction bytes back and reports error", () => {
    const f = fixture();
    expect(reconcileInstruction(f.target, f.ledger, undefined).status).toBe("applied");
    const previous = readFileSync(f.path, "utf8");
    rmSync(f.ledger.path);
    mkdirSync(f.ledger.path);
    const report = reconcileInstruction({ ...f.target, content: "Must roll back." }, f.ledger, undefined);
    expect(report.status).toBe("error");
    expect(readFileSync(f.path, "utf8")).toBe(previous);
    expect(f.ledger.entries.get(f.target.targetId)?.checksum).toBe(environmentDigest(f.target.content));
    expect(readdirSync(join(f.root, "home"))).toEqual(["CLAUDE.md"]);
  });

  test("compare-and-swap rejects intervening writes and symlinks never reach another home", () => {
    const f = fixture();
    reconcileInstruction(f.target, f.ledger, undefined);
    const observed = readInstructionFile(f.path);
    writeFileSync(f.path, "Edited after preview.");
    expect(() => replaceInstructionFile(f.path, observed, "Replacement")).toThrow("changed after the preview");
    expect(readFileSync(f.path, "utf8")).toBe("Edited after preview.");
    rmSync(f.path);
    const privateFile = join(f.root, "private.md");
    writeFileSync(privateFile, "Private notes.");
    symlinkSync(privateFile, f.path);
    expect(reconcileInstruction(f.target, f.ledger, undefined).status).toBe("error");
    expect(readFileSync(privateFile, "utf8")).toBe("Private notes.");
    const linkedHome = join(f.root, "linked-home");
    symlinkSync(join(f.root, "home"), linkedHome);
    const linkedPath = join(linkedHome, "AGENTS.md");
    expect(
      reconcileInstruction(
        { ...f.target, path: linkedPath, targetId: environmentDigest(linkedPath) },
        f.ledger,
        undefined,
      ).status,
    ).toBe("error");
  });

  test("unknown blocks and broken markers drift; CRLF conversions are readable and content is private", () => {
    const f = fixture();
    mkdirSync(join(f.root, "home"), { recursive: true });
    writeFileSync(f.path, `Private preface.\n${environmentBlock("Locally managed.")}\n`);
    const unknown = reconcileInstruction(f.target, f.ledger, undefined);
    expect(unknown.status).toBe("drift");
    expect(unknown.managedContent).toBe("Locally managed.");
    expect(unknown.managedContent).not.toContain("Private preface.");
    writeFileSync(f.path, environmentBlock("Windows\nnewlines.").replaceAll("\n", "\r\n") + "\r\n");
    expect(readEnvironmentBlock(readFileSync(f.path, "utf8"))?.content).toBe("Windows\nnewlines.");
    writeFileSync(f.path, "<!-- canopy:agent-environment:begin -->\nBroken");
    const broken = reconcileInstruction(f.target, f.ledger, undefined);
    expect(broken.status).toBe("drift");
    expect(broken.importable).toBe(false);
    expect(broken.detail).toContain("markers");
  });

  test("a stale resolution never overwrites newer bytes and removing a dirty block preserves it", () => {
    const f = fixture();
    reconcileInstruction(f.target, f.ledger, undefined);
    writeFileSync(f.path, environmentBlock("First local edit."));
    const drift = reconcileInstruction(f.target, f.ledger, undefined);
    writeFileSync(f.path, environmentBlock("Second local edit."));

    const stale = create(AgentEnvironmentDesiredSchema, {
      resolutions: [
        {
          targetId: f.target.targetId,
          action: "overwrite",
          observedChecksum: drift.observedChecksum,
          desiredChecksum: drift.desiredChecksum,
        },
      ],
    }).resolutions[0];

    expect(reconcileInstruction(f.target, f.ledger, stale).status).toBe("drift");
    expect(reconcileInstruction({ ...f.target, content: "" }, f.ledger, undefined).status).toBe("drift");
    expect(readEnvironmentBlock(readFileSync(f.path, "utf8"))?.content).toBe("Second local edit.");
  });

  test("an invalid ownership journal fails closed and Codex override precedence is visible", () => {
    const f = fixture();
    reconcileInstruction(f.target, f.ledger, undefined);
    const original = readFileSync(f.path, "utf8");
    writeFileSync(f.ledger.path, "not json");
    const restarted = new InstructionLedger(f.dataDir);
    expect(reconcileInstruction({ ...f.target, content: "New" }, restarted, undefined).status).toBe("error");
    expect(readFileSync(f.path, "utf8")).toBe(original);
    const path = join(f.root, "home", "AGENTS.md");
    writeFileSync(join(f.root, "home", "AGENTS.override.md"), "Override.");

    const report = reconcileInstruction(
      { ...f.target, harness: "codex", path, targetId: environmentDigest(path) },
      f.ledger,
      undefined,
    );

    expect(report.status).toBe("error");
    expect(report.detail).toContain("AGENTS.override.md");
  });
});

test("platform instructions reach default, own-login and explicit shadow homes; Claude loads only the managed block", () => {
  const root = scratch("canopy-environment-adapter-");
  const dataDir = join(root, "data");
  const shadow = join(root, "custom-shadow");
  const deviceHomes = { claude: join(root, "device-claude"), codex: join(root, "device-codex") };

  const applied = applyWorkerConfig(
    create(WorkerConfigSchema, {
      version: 1n,
      claude: { enabled: false },
      codex: { enabled: false },
      grok: { enabled: false },
      profiles: [
        { id: "custom", kind: ProviderProfileKind.NATIVE, providers: [Provider.CLAUDE], shadowHomePath: shadow },
        { id: "own", kind: ProviderProfileKind.NATIVE, providers: [Provider.CODEX], ownLogin: true },
      ],
    }),
    { which: () => null, version: () => undefined, realDirectory: (p) => p },
  );

  if (!applied.applied) throw new Error("The disabled-provider fixture must accept its configuration.");
  const reports: AgentEnvironmentReport[] = [];

  const worker = new WorkerAgentEnvironment({
    homes: () => ({ dataDir, deviceHomes, config: applied.config }),
    send: (r) => reports.push(r),
  });

  const instructions = ["claude", "codex"].map((harness) =>
    create(EnvironmentInstructionSchema, {
      harness,
      content: "Shared rules.",
      checksum: environmentDigest("Shared rules."),
      platformHome: true,
    }),
  );

  try {
    worker.apply(create(AgentEnvironmentDesiredSchema, { revision: 1n, instructions }));
    expect(reports.at(-1)?.files.every((f) => f.status === "applied")).toBe(true);
    expect(reports.at(-1)?.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        join(dataDir, "claude-home", "CLAUDE.md"),
        join(dataDir, "codex-home", "AGENTS.md"),
        join(shadow, "CLAUDE.md"),
        join(dataDir, "homes", "codex-own", "AGENTS.md"),
      ]),
    );
    writeFileSync(
      join(shadow, "CLAUDE.md"),
      `Not part of the platform prompt.\n${environmentBlock("Shared rules.")}\n`,
    );
    expect(managedClaudeInstructions(shadow)).toBe("Shared rules.");
    worker.apply(create(AgentEnvironmentDesiredSchema, { revision: 0n, instructions: [] }));
    expect(readFileSync(join(shadow, "CLAUDE.md"), "utf8")).toContain("Shared rules.");
    worker.apply(create(AgentEnvironmentDesiredSchema, { revision: 2n, instructions: [] }));
    expect(readFileSync(join(shadow, "CLAUDE.md"), "utf8")).toContain("Not part of the platform prompt.");
    expect(readEnvironmentBlock(readFileSync(join(shadow, "CLAUDE.md"), "utf8"))).toBeUndefined();
  } finally {
    worker.stop();
  }
});
