import { expect, test } from "bun:test";
import { create, toJsonString } from "@bufbuild/protobuf";
import { AgentEnvironmentReportSchema, SkillFileSchema } from "@canopy/contracts";
import { eventually, startTestGateway } from "./support/gateway.ts";
import { librarySkill, skillFiles } from "./support/agent-skills.ts";

for (const diagnostics of [false, true]) {
  test(`large skill artifacts and worker reports remain readable (database diagnostics: ${diagnostics})`, async () => {
    const gateway = await startTestGateway({
      diagnostics,
      worker: { hello: { capabilities: ["agent_environment_v1", "agent_skills_v1"] } },
    });

    try {
      // Valid files stay below the 1 MiB/file and 25 MiB/skill limits, but their
      // base64 JSON exceeds the PostgreSQL driver's default 16 MiB row limit.
      const files = [
        ...skillFiles("large-skill"),
        ...Array.from({ length: 13 }, (_, index) =>
          create(SkillFileSchema, {
            path: `references/part-${index}.txt`,
            content: new Uint8Array(1024 * 1024).fill(97 + index),
          }),
        ),
      ];

      const saved = await gateway.api.saveLibrarySkill({
        skill: librarySkill(),
        files,
        expectedRevision: (await gateway.api.getAgentEnvironment({})).revision,
      });

      const skill = saved.skills[0]!;
      expect(skill.artifact?.files).toHaveLength(files.length);
      expect(skill.artifact?.files.at(-1)?.content).toEqual(files.at(-1)!.content);

      const report = create(AgentEnvironmentReportSchema, {
        revision: saved.revision,
        skills: [{ targetId: "large-comparison", skillId: skill.id, status: "drift", managedFiles: files }],
      });

      expect(Buffer.byteLength(toJsonString(AgentEnvironmentReportSchema, report))).toBeGreaterThan(16 * 1024 * 1024);
      gateway.worker.link.send({ case: "agentEnvironment", value: report });

      const snapshot = await eventually(
        () => gateway.api.getAgentEnvironment({}),
        (state) => state.workers.find((worker) => worker.workerId === gateway.workerId)?.report?.skills.length === 1,
      );

      const worker = snapshot.workers.find((entry) => entry.workerId === gateway.workerId)!;
      expect(worker.report?.skills[0]?.managedFiles.at(-1)?.content).toEqual(files.at(-1)!.content);
      expect(worker.online).toBe(true);
      await gateway.core.environment.sync(gateway.workerId);
      expect((await gateway.api.getAgentEnvironment({})).skills[0]?.artifact?.checksum).toBe(skill.artifact?.checksum);
    } finally {
      await gateway.close();
    }
  }, 30_000);
}
