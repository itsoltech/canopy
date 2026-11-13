import { randomBytes } from "node:crypto";
import { error, json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request, cookies, url }) => {
  // Bound the stream before JSON parsing; no unbounded body allocation for untrusted metrics.
  const maximum = params.operation === "submit" ? 32 * 1024 : 2 * 1024 * 1024;
  const reader = request.body?.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;

  if (reader) {
    try {
      for (;;) {
        const next = await reader.read();

        if (next.done) break;
        size += next.value.length;

        if (size > maximum) {
          await reader.cancel();
          error(413, "Diagnostics request is too large");
        }

        chunks.push(new Uint8Array(next.value));
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bounded = new Request(request.url, { method: "POST", headers: request.headers, body: new Blob(chunks) });
  let binding = cookies.get("canopy-diagnostics-client");

  if (!binding || !/^[A-Za-z0-9_-]{43}$/.test(binding)) {
    binding = randomBytes(32).toString("base64url");
    cookies.set("canopy-diagnostics-client", binding, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      maxAge: 31_536_000,
    });
  }

  return call(async (api) => {
    switch (params.operation) {
      case "trace":
        return json(
          encode(
            ui.DiagnosticsTraceStateSchema,
            await api.controlDiagnosticsTrace(await readMessage(bounded, ui.DiagnosticsTraceRequestSchema)),
          ),
          { headers: { "cache-control": "no-store" } },
        );
      case "trace-export":
        return json(
          encode(
            ui.DiagnosticsTraceExportSchema,
            await api.exportDiagnosticsTrace(await readMessage(bounded, ui.DiagnosticsTraceRequestSchema)),
          ),
          { headers: { "cache-control": "no-store" } },
        );
      case "submit": {
        const batch = await readMessage(bounded, ui.SubmitDiagnosticsRequestSchema);

        if (!["web", "desktop"].includes(batch.source)) error(400, "Choose this client's diagnostic source");

        return json(
          encode(
            ui.DiagnosticsReceiptSchema,
            await api.submitDiagnostics(batch, {
              headers: { "canopy-diagnostics-client": binding },
            }),
          ),
          { headers: { "cache-control": "no-store" } },
        );
      }

      case "report":
        return json(
          encode(
            ui.DiagnosticsReportSchema,
            await api.prepareDiagnosticsReport(await readMessage(bounded, ui.DiagnosticsReportRequestSchema)),
          ),
          { headers: { "cache-control": "no-store" } },
        );
      case "reset":
        return json(
          encode(
            ui.DiagnosticsReceiptSchema,
            await api.resetDiagnostics(await readMessage(bounded, ui.ResetDiagnosticsRequestSchema)),
          ),
          { headers: { "cache-control": "no-store" } },
        );
      case "investigate":
        return json(
          encode(
            ui.DiagnosticsInvestigationSchema,
            await api.investigateDiagnostics(await readMessage(bounded, ui.InvestigateDiagnosticsRequestSchema)),
          ),
          { headers: { "cache-control": "no-store" } },
        );
      default:
        error(404, "Diagnostics action not found");
    }
  });
};
