import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { create } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, SkillFileSchema, ui } from "@canopy/contracts";
import { GatewayStore } from "@canopy/gateway/store";
import { openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import type { TestGateway } from "./gateway.ts";

export function skillFiles(name = "code-review", content = "Review the patch carefully.") {
  return [
    create(SkillFileSchema, {
      path: "SKILL.md",
      content: Buffer.from(`---\nname: ${name}\ndescription: Review code when requested.\n---\n${content}\n`),
    }),
    create(SkillFileSchema, {
      path: "scripts/check.sh",
      content: Buffer.from("#!/bin/sh\nprintf 'review'\n"),
      executable: true,
    }),
  ];
}

export const librarySkill = () =>
  create(ui.LibrarySkillSchema, {
    name: "Code review",
    harnesses: ["claude", "codex", "grok"],
    selector: { everyone: true },
    deviceHome: true,
    platformHome: true,
  });

/** The fixture never reads or writes a real CLI home and never launches a harness. */
export async function skillMachine(gateway: TestGateway, root: string, name: string, os = "linux", capable = true) {
  const registration = await gateway.addWorker(name);
  const home = join(root, name, "home");
  const dataDir = join(root, name, "data");

  const deviceHomes = {
    claude: join(home, ".claude"),
    codex: join(home, ".codex"),
    grok: join(home, ".grok"),
    agents: join(home, ".agents/skills"),
  };

  mkdirSync(home, { recursive: true });
  const shadow = join(root, name, "custom-shadow");
  await gateway.runtime.runPromise(
    GatewayStore.use((s) =>
      s.setWorkerConfig(
        registration.workerId,
        {
          claude: { enabled: false },
          codex: { enabled: false },
          grok: { enabled: false },
          profiles: [
            {
              id: "isolated",
              kind: ProviderProfileKind.NATIVE,
              providers: [Provider.CLAUDE, Provider.CODEX, Provider.GROK],
              shadowHomePath: shadow,
            },
          ],
        },
        gateway.userId,
      ),
    ),
  );
  const runtime = ManagedRuntime.make(Journal.layer(join(dataDir, "journal.db")));

  const host = new WorkerHost({
    runtime,
    dataDir,
    deviceHomes,
    clientVersion: "skill-test",
    probe: { which: () => null, version: () => undefined, realDirectory: (path) => path },
    cliProbe: {
      platform: "linux",
      home,
      docker: false,
      which: () => null,
      realpath: () => undefined,
      version: async () => undefined,
    },
  });

  const connect = async () => {
    const link = await openGatewayLink({
      baseUrl: gateway.grpcUrl,
      credential: registration.credential,
      hello: {
        workerId: registration.workerId,
        host: { os, arch: "x64", hostname: name },
        environmentKind: "desktop",
        capabilities: ["agent_environment_v1", ...(capable ? ["agent_skills_v1"] : [])],
      },
    });

    const serving = serveLink(link, host, runtime);

    return { link, serving };
  };

  return { ...registration, ...(await connect()), connect, host, runtime, home, dataDir, deviceHomes, shadow };
}

/** Small in-memory ZIP builder for boundary/security integration cases, including Unix entry types. */
export function zipSkill(entries: readonly { path: string; content: Uint8Array; mode?: number }[]) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of entries) {
    const name = Buffer.from(file.path);
    const packed = deflateRawSync(file.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(file.content), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc32(file.content), 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(file.content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + packed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

export function writeUserSkill(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), "Private user skill. Never report or remove it.");
}
