import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Histogram } from "@canopy/domain/diagnostics";
import { gatewayRuntime, ensureDevUser } from "../../apps/gateway/src/runtime.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { loadSecretsKey } from "../../apps/gateway/src/store/secrets.ts";
import { DiagnosticsStore } from "../../apps/gateway/src/diagnostics/store.ts";
import { RPC_METHODS } from "../../apps/gateway/src/diagnostics/registry.ts";

/** Synthetic metrics only; the owning client-stack has just created this disposable database. */
export async function seedDiagnostics(env: Readonly<Record<string, string | undefined>>) {
  const runtime = gatewayRuntime(env);

  try {
    const owner = await ensureDevUser(runtime, "dev@localhost");
    const computers = new ComputerStore(runtime, owner, loadSecretsKey(env));
    const self = await computers.identity();
    await computers.query("UPDATE computer_identity SET name=$1,lan_discovery=false WHERE owner_user_id=$2::uuid", [
      "Development workstation with a deliberately long computer name for diagnostic layout review",
      owner,
    ]);
    const offline = await generateIdentity();
    const older = await generateIdentity();

    for (const [identity, name, capabilities] of [
      [offline, "Offline computer with a long name and a last known snapshot", ["diagnostics_v1"]],
      [older, "Older computer", []],
    ] as const)
      await computers.query(
        `INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint,capabilities,app_version)
      VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb,$7)`,
        [
          owner,
          identity.nodeId,
          name,
          identity.certificate,
          identity.fingerprint,
          JSON.stringify(capabilities),
          "0.1.0",
        ],
      );
    const at = Math.floor(Date.now() / 60_000) * 60_000;
    const methods = RPC_METHODS.filter((method) => !method.stream).slice(0, 80);
    const duration = new Histogram();

    for (let index = 0; index < 200; index++) duration.record(index < 180 ? 10 : 1800);

    const series = methods.map((method) =>
      create(ui.DiagnosticsAggregateSchema, {
        methodId: method.id,
        started: 200n,
        completed: 200n,
        slow: 20n,
        codes: [190n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 10n],
        duration: duration.snapshot(),
      }),
    );

    const state = create(ui.DiagnosticsStateSchema, {
      schemaVersion: 1,
      epoch: crypto.randomUUID(),
      persistedThroughMs: BigInt(at),
      findings: [
        {
          ruleId: "rpc_slow",
          subject: `rpc:${methods[0]!.name}`,
          severity: "warning",
          active: true,
          value: 1800,
          threshold: 1000,
          samples: 3000n,
          observedSeconds: 900,
          entering: 3,
        },
      ],
      peerOverviews: [
        {
          computerId: offline.nodeId,
          name: "Offline computer",
          status: "offline",
          appVersion: "0.1.0",
          sampledAtMs: BigInt(at - 7_200_000),
          receivedAtMs: BigInt(at - 7_200_000),
          observedSeconds: 900,
          windowMinutes: 15,
          links: [
            {
              targetId: "synthetic-worker",
              kind: "worker",
              name: "Worker with a deliberately long name",
              supported: true,
              online: false,
              rttMs: { samples: 100n, p50: 10, p95: 20, p99: 30, max: 35 },
            },
          ],
        },
      ],
    });

    const store = new DiagnosticsStore(runtime, owner, self.nodeId);
    await store.initialize(state);
    await store.write(
      Array.from({ length: 15 }, (_, index) => {
        const minute = at - (15 - index) * 60_000;

        return {
          at: minute,
          processes: [
            create(ui.DiagnosticsProcessSchema, {
              processId: "gateway",
              session: "synthetic-preview",
              sequence: BigInt(index + 1),
              series,
              coverage: [{ startMs: BigInt(minute), endMs: BigInt(minute + 60_000) }],
            }),
          ],
        };
      }),
      state,
    );
  } finally {
    await runtime.dispose();
  }
}
