import { readFileSync } from "node:fs";
import { request } from "node:https";
import { Option, Schema } from "effect";

export const EXPO_TOKEN = /^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]{1,128}\]$/;
export const PUSH_KEY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const PUSH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type RelayTransport = { origin: string; ca?: string };

export type PushRelayOptions = RelayTransport & { bearer: string };

export type PushDevicePayload = { token: string; platform: "ios" | "android"; receiptId: string; preview: string };

type RelayPayload = PushDevicePayload | { ticketId: string };

export function normalizedRelayOrigin(origin: string) {
  const url = URL.parse(origin);

  if (
    !url ||
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    return;

  return url.origin;
}

export function pushRelayOptions(env: Readonly<Record<string, string | undefined>>): PushRelayOptions | undefined {
  const origin = env["CANOPY_PUSH_RELAY_ORIGIN"];
  const bearer = env["CANOPY_PUSH_RELAY_BEARER"];
  const caFile = env["CANOPY_PUSH_RELAY_CA_FILE"];

  if (!origin && !bearer && !caFile) return undefined;
  const normalized = normalizedRelayOrigin(origin ?? "");

  if (!normalized) throw new Error("CANOPY_PUSH_RELAY_ORIGIN must be an HTTPS origin");

  if (!bearer || !PUSH_KEY.test(bearer))
    throw new Error("CANOPY_PUSH_RELAY_BEARER must be 32 random bytes encoded as unpadded base64url");

  return { origin: normalized, bearer, ...(caFile && { ca: readFileSync(caFile, "utf8") }) };
}

type RelayResult =
  | { outcome: "accepted"; ticketId: string }
  | { outcome: "done" | "unregistered" | "retry" }
  | { outcome: "unauthorized" };

const readTicket = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ ticketId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)) })),
);

export function postPushRelay(
  options: RelayTransport,
  path: string,
  body: string,
  signal: AbortSignal,
  { bearer, timeoutMs = 5_000 }: { bearer?: string; timeoutMs?: number } = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      new URL(path, options.origin),
      {
        method: "POST",
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
        ...(options.ca && { ca: options.ca }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headers: {
          ...(bearer && { authorization: `Bearer ${bearer}` }),
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;

        response.on("data", (chunk: Buffer) => {
          size += chunk.length;

          if (size > 512) req.destroy(new Error("Push relay response too large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const reply = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
            resolve({ status: response.statusCode ?? 0, body: reply });
          } catch {
            reject(new Error("Invalid push relay response"));
          }
        });
      },
    );

    req.on("error", reject);
    req.end(body);
  });
}

export async function relayPush(
  options: PushRelayOptions,
  payload: RelayPayload,
  signal: AbortSignal,
): Promise<RelayResult> {
  const checking = "ticketId" in payload;

  try {
    const result = await postPushRelay(
      options,
      checking ? "/v1/receipt" : "/v1/push",
      JSON.stringify(payload),
      signal,
      { bearer: options.bearer },
    );

    if (result.status === 401) return { outcome: "unauthorized" };

    if (result.status === 410) return { outcome: "unregistered" };

    if (result.status === 422 || (checking && result.status === 204)) return { outcome: "done" };

    if (!checking && result.status === 202) {
      const ticket = Option.getOrUndefined(readTicket(result.body));

      if (ticket) return { outcome: "accepted", ticketId: ticket.ticketId };
    }
  } catch {
    // Transport errors can contain the request. Keep credentials and push data outside diagnostics.
  }

  return { outcome: "retry" };
}
