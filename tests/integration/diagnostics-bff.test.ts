import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, ConnectError } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui } from "@canopy/contracts";
import { toJsonString } from "@bufbuild/protobuf";
import { clientMetric } from "@canopy/domain/diagnostics";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { gatewayDeadlines } from "../../apps/web/src/lib/server/gateway-deadlines.ts";
import { bffMeasurements } from "../../apps/web/src/lib/server/diagnostics.ts";
import { sseResponse } from "../../apps/web/src/lib/server/sse.ts";
import { SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bounded BFF delivery observations over real gRPC", () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startTestGateway();
  }, 60_000);
  afterAll(async () => {
    await gateway?.close();
    bffMeasurements.clear();
  });

  test("local and remote unary completions remain separate, and submission never measures itself", async () => {
    bffMeasurements.clear();

    const api = createClient(
      ui.GatewayService,
      gatewayDeadlines(
        createGrpcTransport({
          baseUrl: gateway.grpcUrl,
          interceptors: [
            (next) => (request) => {
              request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

              return next(request);
            },
          ],
        }),
      ),
    );

    await api.getOverview({});
    await api
      .getThread({ threadId: qualifyId(crypto.randomUUID(), "a".repeat(64)) })
      .catch((error) => ConnectError.from(error).code);
    await api.submitDiagnostics({}).catch((error) => ConnectError.from(error).code);
    const batch = bffMeasurements.take();
    expect(batch.measures.find((row) => row.metricId === clientMetric("bff", 6))?.events).toBe(1n);
    expect(batch.measures.find((row) => row.metricId === clientMetric("bff", 7))?.events).toBe(1n);
    expect(batch.measures).toHaveLength(2);
  });

  test("SSE records first message once, existing encoded bytes and lifetime at cancellation", async () => {
    bffMeasurements.clear();
    const abort = new AbortController();

    const response = sseResponse(
      new Request("http://localhost/events", { signal: abort.signal }),
      (signal) => gateway.api.watchOverview({}, { signal }),
      () => ({ kind: "redacted fixture" }),
    );

    const reader = response.body!.getReader();
    let bytes = 0;

    for (let count = 0; count < 2; count++) bytes += (await reader.read()).value!.byteLength;
    abort.abort();
    await reader.cancel();
    // The generator finalizer, rather than a per-frame timer, publishes the scalar totals.
    await Bun.sleep(10);
    const batch = bffMeasurements.take();
    expect(batch.measures.find((row) => row.metricId === clientMetric("bff", 8))?.events).toBe(1n);
    expect(batch.measures.find((row) => row.metricId === clientMetric("bff", 9))?.events).toBe(1n);
    expect(batch.measures.find((row) => row.metricId === clientMetric("bff", 10))?.events).toBe(1n);
    expect(batch.measures.find((row) => row.metricId === clientMetric("bff", 11))?.events).toBe(BigInt(bytes));
    expect(toJsonString(ui.SubmitDiagnosticsRequestSchema, batch)).not.toContain("redacted fixture");
  });
});
