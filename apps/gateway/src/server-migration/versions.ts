import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { serverMigration as migration } from "@canopy/contracts";
import { SERVER_MIGRATION_CAPABILITY, SERVER_MIGRATION_PROTOCOL } from "@canopy/domain/release/protocol";

export type Versions = { protocol: number; build: string; schema: string; capabilities: string[] };

/** Why two gateways can't migrate together. Shown in audit records; never contains data. */
export type SkewReason = "protocol" | "capability" | "build" | "schema" | "dev_build";

/** A build without a release version (CANOPY_VERSION unset) says nothing about its code: two such builds
 * would match although they differ. They migrate only when the gateway explicitly allows dev builds. */
export const isDevBuild = (build: string) => !build || build.startsWith("0.0.0-dev");

export const versionsMessage = (versions: Versions) => create(migration.MigrationVersionsSchema, versions);

export function localVersions(build: string, schema: string): Versions {
  return { protocol: SERVER_MIGRATION_PROTOCOL, build, schema, capabilities: [SERVER_MIGRATION_CAPABILITY] };
}

export function versionsOf(message: migration.MigrationVersions | undefined): Versions {
  return {
    protocol: message?.protocol ?? 0,
    build: message?.build ?? "",
    schema: message?.schema ?? "",
    capabilities: [...(message?.capabilities ?? [])],
  };
}

/** V1 (docs/desktop-server-migration.md §5, decision 9): the same migration build on every side. A later
 * source N → target N+1 range needs an explicit adapter and its test matrix; a downgrade is never allowed. */
export function versionSkew(local: Versions, remote: Versions, allowDevBuilds = false): SkewReason | undefined {
  if (remote.protocol !== local.protocol) return "protocol";

  if (!allowDevBuilds && (isDevBuild(local.build) || isDevBuild(remote.build))) return "dev_build";

  if (!remote.capabilities.includes(SERVER_MIGRATION_CAPABILITY)) return "capability";

  if (remote.build !== local.build) return "build";

  if (remote.schema !== local.schema) return "schema";

  return undefined;
}

export class VersionSkewError extends ConnectError {
  constructor(
    readonly reason: SkewReason,
    local: Versions,
    remote: Versions,
  ) {
    super(
      reason === "dev_build"
        ? "Development builds of Canopy can't move data. Install a released version on both computers."
        : reason === "protocol" || reason === "capability"
          ? "Update Canopy on this computer and the server before moving. One of them can't move data yet."
          : `Update Canopy so both computers run the same version. This gateway runs ${local.build} (${local.schema}), the other ${remote.build || "an unknown version"} (${remote.schema || "unknown schema"}).`,
      Code.FailedPrecondition,
    );
  }
}

/** Peer assertions, not attestation: they stop accidental skew. Trust rests on the pins, the session
 * certificate and both owners' confirmations (docs/desktop-server-migration.md §5). */
export function requireSameVersions(local: Versions, remote: Versions, allowDevBuilds: boolean) {
  const reason = versionSkew(local, remote, allowDevBuilds);

  if (reason) throw new VersionSkewError(reason, local, remote);
}

/** A session pins the versions it started with; an update in between needs a new pairing (no downgrade). */
export function requirePinnedVersions(
  pinned: { protocol: number; build_version: string; schema_version: string },
  local: Versions,
) {
  if (
    pinned.protocol !== local.protocol ||
    pinned.build_version !== local.build ||
    pinned.schema_version !== local.schema
  )
    throw new VersionSkewError(
      pinned.protocol !== local.protocol ? "protocol" : pinned.build_version !== local.build ? "build" : "schema",
      local,
      { ...local, build: pinned.build_version, schema: pinned.schema_version },
    );
}
