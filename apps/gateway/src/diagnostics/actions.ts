import { create, toBinary } from "@bufbuild/protobuf";
import { ui, computerLink } from "@canopy/contracts";
import { linkedMessage } from "../computers/remote.ts";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GatewayCore } from "../core/core.ts";
import { coreState } from "../core/core-context.ts";
import { diagnosticReport, REPORT_BYTES } from "./report.ts";
import { investigate } from "./investigate.ts";
import { queryFamily } from "./query-context.ts";
import { isEntityId } from "@canopy/domain/computers";

export class DiagnosticsActions {
  readonly #key = randomBytes(32);
  #busy = 0;
  constructor(readonly core: GatewayCore) {}

  async report(request: ui.DiagnosticsReportRequest) {
    if (
      !request.computerIds.length ||
      request.computerIds.length > 16 ||
      new Set(request.computerIds).size !== request.computerIds.length ||
      !["json", "markdown"].includes(request.format)
    )
      throw new ConnectError("Choose up to 16 computers and a report format", Code.InvalidArgument);

    if (this.#busy >= 2) throw new ConnectError("A diagnostics action is already running", Code.ResourceExhausted);
    this.#busy++;

    try {
      const computers = [];

      for (const computerId of request.computerIds)
        computers.push(
          await this.core.diagnostics.computer(
            create(ui.ComputerDiagnosticsRequestSchema, {
              computerId,
              windowMinutes: request.windowMinutes,
              limit: 32,
            }),
          ),
        );
      const report = diagnosticReport(computers, request.format);
      report.expiresAtMs = BigInt(Date.now() + 600_000);
      report.proof = this.#proof(report);

      return report;
    } finally {
      this.#busy--;
    }
  }

  async investigation(request: ui.InvestigateDiagnosticsRequest) {
    const report = request.report;

    if (!report || Buffer.byteLength(report.text) > REPORT_BYTES || report.omittedSections.length > 64)
      throw new ConnectError("Preview a fresh diagnostics report first", Code.InvalidArgument);

    const digest = createHash("sha256")
      .update(
        toBinary(
          ui.InvestigateDiagnosticsRequestSchema,
          create(ui.InvestigateDiagnosticsRequestSchema, {
            ...request,
            report: { ...report, proof: "", expiresAtMs: 0n },
          }),
        ),
      )
      .digest("hex");

    if (this.#busy >= 2) throw new ConnectError("A diagnostics action is already running", Code.ResourceExhausted);
    this.#busy++;

    try {
      return await investigate(this.core, request, digest, () => {
        if (
          !/^[a-f0-9]{64}$/.test(report.proof) ||
          !timingSafeEqual(Buffer.from(report.proof, "hex"), Buffer.from(this.#proof(report), "hex"))
        )
          throw new ConnectError("Preview a fresh diagnostics report first", Code.InvalidArgument);
      });
    } finally {
      this.#busy--;
    }
  }

  async reset(request: ui.ResetDiagnosticsRequest) {
    const diagnostics = this.core.diagnostics;
    const own = this.core.computers?.hello().nodeId ?? "local";

    if (request.computerId !== own) {
      const host = this.core.computers;
      const peer = await host?.store.peer(request.computerId);

      if (
        !host ||
        !peer ||
        peer.via_node_id ||
        !host.canCall(peer.node_id) ||
        !host.capabilities(peer.node_id).includes("diagnostics_v1")
      )
        throw new ConnectError("Reset counters on a connected direct computer", Code.FailedPrecondition);

      const stream = host.remote(
        peer.node_id,
        computerLink.DiagnosticsService.method.resetDiagnosticsCounters,
        request,
        AbortSignal.timeout(10_000),
      );

      for await (const value of stream) {
        this.core.diagnostics.peers.remove(peer.node_id);

        return linkedMessage(ui.DiagnosticsReceiptSchema, value);
      }

      throw new ConnectError("Computer did not confirm reset", Code.Unavailable);
    }

    const worker = request.processId.startsWith("worker:") ? diagnostics.links.get(request.processId) : undefined;

    if (request.processId !== "gateway" && (!worker || !this.core.link.connections.has(worker.target)))
      throw new ConnectError("Choose a connected process on this computer", Code.InvalidArgument);

    if (!isEntityId(request.actionId) || request.epoch !== diagnostics.persistence?.epoch)
      throw new ConnectError("Refresh diagnostics before resetting counters", Code.FailedPrecondition);

    if (!diagnostics.persistence?.ready) throw new ConnectError("Diagnostics are still restoring", Code.Unavailable);

    if (!diagnostics.persistence.baselines.has(request.processId) && diagnostics.persistence.baselines.size >= 17)
      throw new ConnectError("Diagnostics process baseline limit reached", Code.ResourceExhausted);

    if (this.#busy) throw new ConnectError("A diagnostics action is already running", Code.ResourceExhausted);
    this.#busy++;

    try {
      await diagnostics.persistence.reset(request.actionId, request.processId, () =>
        worker ? worker.reset() : diagnostics.collector.reset(),
      );
      await diagnostics.history?.invalidate();
      diagnostics.findings.reset(request.processId);

      return create(ui.DiagnosticsReceiptSchema, {
        epoch: diagnostics.persistence.epoch,
        epochStartedAtMs: BigInt(diagnostics.persistence.epochStartedAt),
        accepted: true,
      });
    } finally {
      this.#busy--;
    }
  }

  #proof(report: ui.DiagnosticsReport) {
    return createHmac("sha256", this.#key)
      .update(JSON.stringify([report.text, report.format, report.omittedSections, report.expiresAtMs.toString()]))
      .digest("hex");
  }
}

export function actionQuery<A extends object>(
  core: GatewayCore,
  text: string,
  parameters: readonly (string | Uint8Array)[],
) {
  return core[coreState].actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.unsafe<A>(text, parameters).pipe(queryFamily("diagnostics.write"));
    }),
  );
}
