import { createHash, randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { serverMigration as migration, ui } from "@canopy/contracts";
import { certificateIdentity } from "../computers/identity.ts";
import { verifyBinding } from "./binding.ts";
import type { MigrationPeer } from "./channel.ts";
import type { MigrationContext } from "./context.ts";
import { MigrationStore, type SourceRow } from "./store.ts";
import {
  requirePinnedVersions,
  requireSameVersions,
  versionsMessage,
  versionsOf,
  VersionSkewError,
} from "./versions.ts";

const INVALID_CODE = "Migration code is invalid, expired, revoked or already used. Create a new one on the server.";
const NOT_FOUND = "Migration not found";

const codeHash = (code: string) => createHash("sha256").update(code).digest("hex");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uuid(value: string) {
  if (!UUID.test(value)) throw new ConnectError(INVALID_CODE, Code.PermissionDenied);

  return value;
}

/** Malformed certificates and signatures get the same answer as a wrong code. */
function parsed<A>(read: () => A): A {
  try {
    return read();
  } catch {
    throw new ConnectError(INVALID_CODE, Code.PermissionDenied);
  }
}

/** The server side (docs/desktop-server-migration.md §5): an owner reserves the empty server and invites each
 * home with its own one-time code; a home pairs over the pinned listener and then talks only over mutual TLS. */
export class MigrationTarget {
  constructor(readonly context: MigrationContext) {}

  get store() {
    return this.context.store;
  }

  async invite(): Promise<ui.ServerMigrationInvitation> {
    this.context.requireRole("server");
    const network = this.context.network();
    const origins = network?.origins() ?? [];

    if (!network?.listening || !origins.length)
      throw new ConnectError("Turn on Network access on this server first.", Code.FailedPrecondition);
    await this.store.closeUnpairedTarget();
    let session = await this.store.openSession("target");

    if (session && session.state !== "invited" && session.state !== "paired")
      throw new ConnectError(
        "This server is already copying. Add every computer before copying starts.",
        Code.FailedPrecondition,
      );
    await this.context.requireEmptyTarget();

    if (!session) {
      const versions = await this.context.versions();

      try {
        await this.store.createSession("target", crypto.randomUUID(), "invited", versions);
      } catch {
        // Another invitation opened the session at the same time; both use it.
      }

      session = await this.store.openSession("target");
    }

    if (!session) throw new ConnectError(NOT_FOUND, Code.Aborted);
    const code = randomBytes(32).toString("base64url");
    const source = await this.store.addSource(session.id, codeHash(code));
    const identity = await network.options.store.identity();
    await this.store.audit("pair", session.id, {
      phase: "invited",
      source_id: source.id,
      generation: session.generation,
    });

    return create(ui.ServerMigrationInvitationSchema, {
      sessionId: session.id,
      sourceId: source.id,
      code,
      fingerprint: network.fingerprint,
      origins,
      expiresAt: timestampFromDate(source.invitation_expires_at),
      targetName: identity.name,
    });
  }

  /** Public and unauthenticated until the code matches: the same refusal for every wrong input. */
  async exchange(request: migration.ExchangeMigrationPairingRequest) {
    this.context.requireRole("server");
    const network = this.context.network();

    if (!network || request.code.length !== 43) throw new ConnectError(INVALID_CODE, Code.PermissionDenied);
    const identity = await network.options.store.identity();
    const session = parsed(() => certificateIdentity(request.sessionCertificate));
    const sessionPin = session.fingerprint;

    const home = parsed(() =>
      verifyBinding(request.computerCertificate, request.bindingSignature, {
        sessionId: uuid(request.sessionId),
        sourceId: uuid(request.sourceId),
        sessionPin,
        targetPin: identity.fingerprint,
      }),
    );

    if (home.nodeId === identity.nodeId)
      throw new ConnectError("A server can't import from itself.", Code.InvalidArgument);
    const local = await this.context.versions();
    const remote = versionsOf(request.versions);
    // Refused before the code is used: after an update the same invitation still works.
    requireSameVersions(local, remote);
    await this.context.requireEmptyTarget();
    let paired;

    try {
      paired = await this.store.exchange({
        sessionId: request.sessionId,
        sourceId: request.sourceId,
        codeHash: codeHash(request.code),
        nodeId: home.nodeId,
        name: request.sourceName.trim().slice(0, 100) || "Desktop",
        ownerId: uuid(request.sourceOwnerId),
        versions: remote,
        certificate: session.certificate,
        pin: sessionPin,
      });
    } catch {
      throw new ConnectError("This computer is already paired with this server.", Code.AlreadyExists);
    }

    if (!paired) throw new ConnectError(INVALID_CODE, Code.PermissionDenied);
    const owner = new MigrationStore(this.store.runtime, paired.row.owner_user_id);

    if (!paired.replay)
      await owner.audit("pair", paired.row.session_id, {
        phase: "exchanged",
        source_id: paired.row.id,
        source_node: home.nodeId,
        source_pin: sessionPin,
      });

    return create(migration.ExchangeMigrationPairingResponseSchema, {
      sessionId: paired.row.session_id,
      sourceId: paired.row.id,
      targetNodeId: identity.nodeId,
      targetName: identity.name,
      targetOwnerId: paired.row.owner_user_id,
      credentialExpiresAt: timestampFromDate(paired.row.credential_expires_at!),
      versions: versionsMessage(local),
    });
  }

  /** The owner compared the home's pin shown here with the one its desktop shows. */
  async confirm(sessionId: string, sourceId: string, fingerprint: string) {
    this.context.requireRole("server");
    const source = await this.#source(sessionId, sourceId);

    if (!source.certificate_pin) throw new ConnectError("This computer hasn't paired yet.", Code.FailedPrecondition);

    if (source.certificate_pin !== fingerprint.trim().toLowerCase())
      throw new ConnectError("The pin doesn't match this computer. Pair it again.", Code.PermissionDenied);
    await this.store.markSource(sessionId, sourceId, "confirmed_at");
    await this.store.audit("pair", sessionId, { phase: "confirmed", source_id: sourceId });
  }

  /** Mutual TLS only. The owner and session come from the certificate, never from the request. */
  async negotiate(peer: MigrationPeer, request: migration.NegotiateMigrationRequest) {
    if (request.sessionId !== peer.sessionId || request.sourceId !== peer.sourceId)
      throw new ConnectError(NOT_FOUND, Code.NotFound);

    if (request.generation !== peer.generation)
      throw new ConnectError("The move restarted. Pair this computer again.", Code.FailedPrecondition);
    const store = new MigrationStore(this.store.runtime, peer.owner);
    const session = await store.session(peer.sessionId);
    const source = await store.source(peer.sessionId, peer.sourceId);

    if (!session || !source || source.revoked_at) throw new ConnectError(NOT_FOUND, Code.NotFound);

    if (!source.confirmed_at)
      throw new ConnectError("Confirm this computer on the server first.", Code.FailedPrecondition);
    const local = await this.context.versions();
    const audit = { source_id: source.id, generation: session.generation };

    try {
      requirePinnedVersions(session, local);
      requireSameVersions(local, versionsOf(request.versions));
      await this.context.requireEmptyTarget();
    } catch (error) {
      const reason = error instanceof VersionSkewError ? `version_${error.reason}` : "target_not_empty";
      await store.audit("negotiate", session.id, { ...audit, result: "refused", reason });
      throw error;
    }

    await store.markSource(session.id, source.id, "negotiated_at");
    await store.audit("negotiate", session.id, { ...audit, result: "accepted" });

    return create(migration.NegotiateMigrationResponseSchema, {
      protocol: local.protocol,
      generation: session.generation,
      state: session.state,
      versions: versionsMessage(local),
    });
  }

  /** One home, or the whole session (which also lifts the reservation). Neither undoes a decision. */
  async revoke(sessionId: string, sourceId: string) {
    this.context.requireRole("server");

    if (sourceId) {
      await this.#source(sessionId, sourceId);
      await this.store.markSource(sessionId, sourceId, "revoked_at");
      await this.store.audit("abort", sessionId, { scope: "source", source_id: sourceId });

      return;
    }

    if (!(await this.store.session(sessionId))) throw new ConnectError(NOT_FOUND, Code.NotFound);
    await this.store.close(sessionId, "owner");
    await this.store.audit("abort", sessionId, { scope: "session" });
  }

  /** The active credential for a pin, as the session it may drive. */
  async authorize(pin: string): Promise<MigrationPeer | undefined> {
    if (this.context.role !== "server") return undefined;
    const row = await this.store.credential(pin);

    return (
      row && {
        owner: row.owner_user_id,
        sessionId: row.session_id,
        sourceId: row.id,
        generation: row.generation,
        state: row.state,
      }
    );
  }

  async #source(sessionId: string, sourceId: string): Promise<SourceRow> {
    const source = UUID.test(sessionId) && UUID.test(sourceId) && (await this.store.source(sessionId, sourceId));

    if (!source || !(await this.store.session(sessionId))) throw new ConnectError(NOT_FOUND, Code.NotFound);

    return source;
  }
}
