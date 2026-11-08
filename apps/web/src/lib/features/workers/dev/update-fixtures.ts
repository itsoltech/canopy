import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { CliInstallMethod, Provider, ui } from "@canopy/contracts";

/** Fixture data for the updates center gallery (development only). */
const node = (seed: string) => seed.repeat(64).slice(0, 64);
const q = (id: string, nodeId: string) => `${id}~${nodeId.slice(0, 16)}`;

function cli(provider: Provider, version: string, latest: string) {
  return create(ui.WorkerCliToolSchema, {
    tool: { provider, version, method: CliInstallMethod.NATIVE, installable: true },
    latest: { version: latest },
    updateAvailable: version !== latest,
    action: version !== latest ? "update" : "",
  });
}

function worker(id: string, name: string, version: string, state = "succeeded") {
  return create(ui.WorkerUpdateSchema, {
    workerId: id,
    name,
    version,
    installKind: "binary",
    compatibility: "compatible",
    state,
    connected: true,
  });
}

function home(gatewayVersion: string, workers: ui.WorkerUpdate[], clis: [string, string, ui.WorkerCliTool[]][]) {
  return create(ui.UpdatesSnapshotSchema, {
    gatewayVersion,
    availableVersion: gatewayVersion,
    channel: "nightly",
    gatewayInstallKind: "desktop",
    gatewayBundled: true,
    admin: true,
    workers,
    cliWorkers: clis.map(([id, name, cliTools]) => create(ui.WorkerSchema, { id, name, online: true, cliTools })),
  });
}

export function computer(
  name: string,
  seed: string,
  app: MessageInitShape<typeof ui.DesktopUpdateStateSchema> | undefined,
  extra: MessageInitShape<typeof ui.ComputerUpdateSchema> = {},
) {
  return create(ui.ComputerUpdateSchema, {
    nodeId: node(seed),
    name,
    version: app?.version || "0.40.0-nightly.3",
    presence: "connected",
    remoteUpdate: true,
    ...(app && {
      updates: create(ui.UpdatesSnapshotSchema, {
        ...home("0.42.0", [], []),
        app: create(ui.DesktopUpdateStateSchema, {
          connected: true,
          channel: "nightly",
          phase: "idle",
          lastCheckedAtMs: Date.now() - 60_000,
          ...app,
        }),
      }),
    }),
    ...extra,
  });
}

/** This computer, two linked computers (one updatable, one too old), three workers on two computers, several CLIs. */
export function fixtureSnapshot(): ui.UpdatesSnapshot {
  const studio = node("a");
  const local = "11111111-1111-4111-8111-111111111111";

  const snapshot = home(
    "0.42.0-nightly.7",
    [
      create(ui.WorkerUpdateSchema, { workerId: local, name: "Canopy · MacBook", bundled: true }),
      worker("22222222-2222-4222-8222-222222222222", "Build server in the rack room · linux-x64 · 64 GB", "0.41.0", ""),
      worker("33333333-3333-4333-8333-333333333333", "CI runner", "0.42.0-nightly.7"),
    ],
    [
      [local, "MacBook", [cli(Provider.CLAUDE, "2.1.4", "2.1.6"), cli(Provider.CODEX, "0.98.0", "0.98.0")]],
      [
        "22222222-2222-4222-8222-222222222222",
        "Build server in the rack room · linux-x64 · 64 GB",
        [cli(Provider.GROK, "0.3.1", "0.3.1")],
      ],
    ],
  );

  const studioHome = home(
    "0.42.0-nightly.5",
    [worker(q("44444444-4444-4444-8444-444444444444", studio), "Render worker", "0.42.0-nightly.5")],
    [[q("44444444-4444-4444-8444-444444444444", studio), "Render worker", [cli(Provider.CLAUDE, "2.1.6", "2.1.6")]]],
  );

  studioHome.app = create(ui.DesktopUpdateStateSchema, {
    lastCheckedAtMs: Date.now() - 60_000,
    connected: true,
    version: "0.42.0-nightly.5",
    availableVersion: "0.42.0-nightly.7",
    channel: "nightly",
    phase: "idle",
  });
  snapshot.computers = [
    create(ui.ComputerUpdateSchema, {
      nodeId: studio,
      name: "Studio Mac",
      version: "0.42.0-nightly.5",
      presence: "connected",
      remoteUpdate: true,
      updates: studioHome,
    }),
    computer("Old MacBook Air from the office downstairs", "b", undefined, {
      version: "0.38.2",
      remoteUpdate: false,
      reason: "Update Old MacBook Air from the office downstairs on that computer.",
    }),
  ];

  snapshot.app = create(ui.DesktopUpdateStateSchema, {
    connected: true,
    version: snapshot.gatewayVersion,
    updaterPhase: "idle",
    lastCheckedAtMs: Date.now() - 3600_000,
  });

  return snapshot;
}

/** One linked computer per state of its app. */
export const computerStates = () => [
  computer("Up to date", "1", { version: "0.42.0", availableVersion: "0.42.0" }),
  computer("Available", "2", { version: "0.41.0", availableVersion: "0.42.0" }),
  computer("Downloading", "3", { version: "0.41.0", availableVersion: "0.42.0", phase: "downloading", progress: 42 }),
  computer("Ready", "4", { version: "0.41.0", availableVersion: "0.42.0", ready: true }),
  computer("Waiting for idle", "5", {
    version: "0.41.0",
    availableVersion: "0.42.0",
    targetVersion: "0.42.0",
    phase: "waiting_idle",
    ready: true,
  }),
  computer("Unreachable", "6", undefined, { presence: "unreachable", presenceSinceMs: BigInt(Date.now() - 60_000) }),
  computer("Updating", "7", undefined, { presence: "updating" }),
  computer("Restarting", "f1", undefined, { presence: "restarting" }),
  computer("Offline", "f2", undefined, { presence: "shutting_down", presenceSinceMs: BigInt(Date.now() - 60_000) }),
  computer("Sleeping computer with a rather long name", "f3", undefined, {
    presence: "sleeping",
    presenceSinceMs: BigInt(Date.now() - 24 * 60 * 60_000),
  }),
  computer("Failed", "8", {
    version: "0.41.0",
    availableVersion: "0.42.0",
    phase: "failed",
    reason: "Remote updates need a strictly newer signed release.",
  }),
  computer("Too old", "9", undefined, { remoteUpdate: false, reason: "Update Too old on that computer." }),
  computer(
    "Returned on the previous version",
    "f4",
    { version: "0.41.0", availableVersion: "0.42.0" },
    {
      updates: create(ui.UpdatesSnapshotSchema, {
        app: { connected: true, phase: "idle", version: "0.41.0", availableVersion: "0.42.0" },
        departure: {
          id: "rollback",
          state: "rolled_back",
          version: "0.41.0",
          targetVersion: "0.42.0",
          reason: "The new version did not start. Check again to retry.",
        },
      }),
    },
  ),
  // Its own updater, apart from any requested update; the last finished request still names the version it installed.
  computer("Downloading by itself", "a", {
    version: "0.41.0",
    availableVersion: "0.42.0",
    updaterPhase: "downloading",
    updaterVersion: "0.42.0",
    updaterProgress: 63,
  }),
  computer("Downloaded by itself", "b", {
    version: "0.41.0",
    targetVersion: "0.41.0",
    phase: "succeeded",
    availableVersion: "0.42.0",
    updaterPhase: "downloaded",
    updaterVersion: "0.42.0",
    ready: true,
  }),
  computer("Checking by itself", "c", { version: "0.41.0", updaterPhase: "checking" }),
  computer("Check failed", "d", {
    version: "0.41.0",
    updaterPhase: "error",
    updaterError: "Update failed. Check again to retry.",
  }),
  computer("Mac-Studio-in-the-render-room-on-the-third-floor.local", "e", {
    version: "0.42.0-nightly.20261106.1234+build.0123456789abcdef",
    availableVersion: "0.42.0-nightly.20261107.5678+build.fedcba9876543210",
    updaterPhase: "downloading",
    updaterVersion: "0.42.0-nightly.20261107.5678+build.fedcba9876543210",
    updaterProgress: 7,
  }),
];
