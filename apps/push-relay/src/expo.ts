import { jsonArray, jsonObject, readJson, type JsonObject, type JsonValue } from "./json.ts";
import { isTicketId, type Push } from "./protocol.ts";

const sendUrl = "https://exp.host/--/api/v2/push/send";
const receiptUrl = "https://exp.host/--/api/v2/push/getReceipts";
const providerTimeoutMs = 4_000;
const providerResponseLimit = 16 * 1024;

type Retry = 429 | 502 | 503;

type SendResult = { status: 202; ticketId: string } | { status: 410 | 422 | Retry };

type ReceiptResult = 204 | 404 | 410 | Retry;

type ExpoResult = { data: JsonValue } | { status: Retry };

export type ExpoFetch = (url: string, init: BunFetchRequestInit) => Promise<Response>;

export class Expo {
  constructor(
    private readonly accessToken: string,
    private readonly fetcher: ExpoFetch,
  ) {}

  async send(push: Push): Promise<SendResult> {
    const data = { receiptId: push.receiptId, ...(push.preview !== undefined && { preview: push.preview }) };
    const common = { to: push.token, ttl: 600, data };

    const message =
      push.platform === "ios"
        ? { ...common, title: "Canopy", body: "You have a new update.", sound: "default", mutableContent: true }
        : { ...common, priority: "high" };

    const result = await this.#post(sendUrl, message);

    if ("status" in result) return result;

    // Expo returns a single object for a single message, or an array of tickets.
    const ticket = jsonArray(result.data) && result.data.length === 1 ? result.data[0] : result.data;

    if (!jsonObject(ticket)) return { status: 502 };

    if (ticket["status"] === "ok" && isTicketId(ticket["id"])) return { status: 202, ticketId: ticket["id"] };

    if (ticket["status"] === "error") {
      switch (deviceError(ticket)) {
        case "DeviceNotRegistered":
          return { status: 410 };
        case "MessageTooBig":
          return { status: 422 };
        case "MessageRateExceeded":
          return { status: 429 };
      }
    }

    return { status: 502 };
  }

  async receipt(ticketId: string): Promise<ReceiptResult> {
    const result = await this.#post(receiptUrl, { ids: [ticketId] });

    if ("status" in result) return result.status;

    if (!jsonObject(result.data)) return 502;

    if (!Object.hasOwn(result.data, ticketId)) return 404;

    const receipt = result.data[ticketId];

    if (!jsonObject(receipt)) return 502;

    if (receipt["status"] === "ok") return 204;

    if (receipt["status"] === "error") return deviceError(receipt) === "DeviceNotRegistered" ? 410 : 204;

    return 502;
  }

  async #post(url: typeof sendUrl | typeof receiptUrl, message: JsonObject): Promise<ExpoResult> {
    const signal = AbortSignal.timeout(providerTimeoutMs);

    try {
      const response = await this.fetcher(url, {
        method: "POST",
        redirect: "error",
        proxy: false,
        verbose: false,
        tls: { rejectUnauthorized: true },
        signal,
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          "content-type": "application/json",
          authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);

        return { status: response.status === 429 || response.status === 503 ? response.status : 502 };
      }

      const parsed = await readJson(response, providerResponseLimit, signal);

      if ("status" in parsed || !jsonObject(parsed.value)) return { status: 502 };

      const errors = parsed.value["errors"];

      if (jsonArray(errors) && errors.length > 0) {
        const throttled = errors.some((error) => jsonObject(error) && error["code"] === "TOO_MANY_REQUESTS");

        return { status: throttled ? 429 : 502 };
      }

      const data = parsed.value["data"];

      return data === undefined ? { status: 502 } : { data };
    } catch {
      return { status: 502 };
    }
  }
}

function deviceError(result: JsonObject) {
  const details = result["details"];

  return jsonObject(details) ? details["error"] : undefined;
}
