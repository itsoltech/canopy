import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { serverMigration as migration } from "@canopy/contracts";
import { certificateIdentity, generateIdentity } from "../computers/identity.ts";
import { decryptSecret, encryptSecret } from "../store/secrets.ts";
import { signBinding } from "./binding.ts";
import { IDENTITY_CHANGED, migrationClient, pairingClient, pinnedTarget } from "./channel.ts";
import type { MigrationContext } from "./context.ts";
import { CREDENTIAL_DAYS, type TargetRow } from "./store.ts";
import { requirePinnedVersions, requireSameVersions, versionsMessage, versionsOf } from "./versions.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_FOUND = "Migration not found";

function invitation(value: ui.ServerMigrationInvitation | undefined) {
  if (
    !value ||
    !UUID.test(value.sessionId) ||
    !UUID.test(value.sourceId) ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    value.code.length !== 43 ||
    !value.origins.length
  )
    throw new ConnectError("Paste the whole migration invitation from the server.", Code.InvalidArgument);

  return value;
}

/** The desktop side (docs/desktop-server-migration.md §5): this home pins the server before sending its code,
 * creates its own session key, proves its node ID and talks only over mutual TLS afterwards. */
export class MigrationSource {
  constructor(readonly context: MigrationContext) {}

  get store() {
    return this.context.store;
  }

  async pair(request: ui.ServerMigrationInvitation | undefined) {
    this.context.requireRole("desktop");
    const invite = invitation(request);
    const network = this.context.network();

    if (!network) throw new ConnectError("Network access is not initialized", Code.FailedPrecondition);
    const open = await this.store.openSession("source");

    if (open && (open.id !== invite.sessionId || open.state !== "pairing"))
      throw new ConnectError(
        "This computer is already moving to a server. Cancel that move first.",
        Code.FailedPrecondition,
      );
    // The pin is checked before the code or any certificate leaves this computer.
    const pinned = await pinnedTarget(invite.origins, invite.fingerprint);
    const versions = await this.context.versions();
    // A retry of a lost reply reuses the stored key and attempt: the server returns the same result.
    let target = open && (await this.store.target(open.id));

    if (!target) {
      const session = await generateIdentity({ name: "Canopy server migration", validDays: CREDENTIAL_DAYS });

      await this.store.createTarget(
        { id: invite.sessionId, versions },
        {
          session_id: invite.sessionId,
          source_id: invite.sourceId,
          origins: invite.origins,
          target_fingerprint: invite.fingerprint,
          target_node_id: "",
          target_name: "",
          target_owner_id: null,
          target_build: "",
          target_schema: "",
          certificate: session.certificate,
          certificate_pin: session.fingerprint,
          private_key: encryptSecret(network.options.store.key, session.privateKey),
          credential_expires_at: new Date(Date.now() + CREDENTIAL_DAYS * 86_400_000),
          exchanged_at: null,
          confirmed_at: null,
          negotiated_at: null,
          revoked_at: null,
        },
      );
      target = (await this.store.target(invite.sessionId))!;
    }

    const computer = await network.options.store.identity();

    const reply = await pairingClient({ ...pinned, fingerprint: invite.fingerprint }).exchangeMigrationPairing(
      create(migration.ExchangeMigrationPairingRequestSchema, {
        sessionId: invite.sessionId,
        sourceId: invite.sourceId,
        code: invite.code,
        sessionCertificate: target.certificate,
        computerCertificate: computer.certificate,
        bindingSignature: signBinding(computer.privateKey, {
          sessionId: invite.sessionId,
          sourceId: invite.sourceId,
          sessionPin: target.certificate_pin,
          targetPin: invite.fingerprint,
        }),
        sourceName: computer.name,
        sourceOwnerId: this.store.owner,
        versions: versionsMessage(versions),
      }),
    );

    if (
      reply.sessionId !== invite.sessionId ||
      reply.sourceId !== invite.sourceId ||
      reply.targetNodeId !== certificateIdentity(pinned.certificate).nodeId
    )
      throw new ConnectError(IDENTITY_CHANGED, Code.PermissionDenied);
    requireSameVersions(versions, versionsOf(reply.versions));
    await this.store.pairedTarget(invite.sessionId, {
      target_node_id: reply.targetNodeId,
      target_name: reply.targetName.slice(0, 100),
      target_owner_id: UUID.test(reply.targetOwnerId) ? reply.targetOwnerId : null,
    });
    await this.store.audit("pair", invite.sessionId, {
      phase: "exchanged",
      target_node: reply.targetNodeId,
      target_pin: invite.fingerprint,
    });
  }

  /** The owner compared the server's pin shown here with the one the server shows. */
  async confirm(sessionId: string, fingerprint: string) {
    this.context.requireRole("desktop");
    const target = await this.#target(sessionId);

    if (!target.exchanged_at) throw new ConnectError("Pair with the server first.", Code.FailedPrecondition);

    if (target.target_fingerprint !== fingerprint.trim().toLowerCase())
      throw new ConnectError(IDENTITY_CHANGED, Code.PermissionDenied);
    await this.store.markTarget(sessionId, "confirmed_at");
    await this.store.audit("pair", sessionId, { phase: "confirmed" });
  }

  /** Dry-run negotiation: versions and the server's empty-target check. It moves no data and starts nothing. */
  async negotiate(sessionId: string) {
    this.context.requireRole("desktop");
    const target = await this.#target(sessionId);
    const session = (await this.store.session(sessionId))!;

    if (!target.exchanged_at || !target.confirmed_at)
      throw new ConnectError("Confirm the server's pin on this computer first.", Code.FailedPrecondition);
    const local = await this.context.versions();
    requirePinnedVersions(session, local);
    const pinned = await pinnedTarget(target.origins, target.target_fingerprint);
    const network = this.context.network();

    if (!network) throw new ConnectError("Network access is not initialized", Code.FailedPrecondition);

    const client = migrationClient(
      { ...pinned, fingerprint: target.target_fingerprint },
      { certificate: target.certificate, privateKey: decryptSecret(network.options.store.key, target.private_key) },
    );

    let reply;

    try {
      reply = await client.negotiate({
        sessionId,
        sourceId: target.source_id,
        generation: session.generation,
        versions: versionsMessage(local),
      });
      requireSameVersions(local, versionsOf(reply.versions));
    } catch (error) {
      const code = ConnectError.from(error).code;
      await this.store.audit("negotiate", sessionId, { result: "refused", reason: Code[code] ?? "unknown" });
      throw error;
    }

    await this.store.markTarget(sessionId, "negotiated_at", versionsOf(reply.versions));
    await this.store.audit("negotiate", sessionId, { result: "accepted", generation: reply.generation });
  }

  /** Cancels this home's move before any decision. The server's own session is revoked there. */
  async revoke(sessionId: string) {
    this.context.requireRole("desktop");
    await this.#target(sessionId);
    await this.store.close(sessionId, "owner");
    await this.store.audit("abort", sessionId, { scope: "session" });
  }

  async #target(sessionId: string): Promise<TargetRow> {
    const target =
      UUID.test(sessionId) && (await this.store.session(sessionId)) && (await this.store.target(sessionId));

    if (!target || target.revoked_at) throw new ConnectError(NOT_FOUND, Code.NotFound);

    return target;
  }
}
