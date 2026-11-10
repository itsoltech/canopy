import type { Notice } from "@canopy/contracts";
import { Option, Schema } from "effect";
import { safeFailureDetail } from "./failures.ts";
import { humanizeEnum } from "./humanize.ts";
import { parseJson } from "./json.ts";

const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("error"),
      status: Schema.optionalKey(Schema.Number),
      error: Schema.Struct({ message: Schema.String }),
    }),
  ),
);

/** Provider notices are diagnostic events, not turn outcomes. Also handles notices saved by older workers. */
export function noticePresentation(notice: Pick<Notice, "message" | "code" | "dataJson">) {
  const wrapped = Option.getOrUndefined(decodeError(notice.message));

  const message = wrapped
    ? `Provider error${wrapped.status === undefined ? "" : ` ${wrapped.status}`}: ${wrapped.error.message}`
    : notice.message || humanizeEnum(notice.code);

  const details =
    wrapped || notice.dataJson
      ? [
          notice.code && `Code: ${notice.code}`,
          wrapped && JSON.stringify(parseJson(notice.message), null, 2),
          notice.dataJson && JSON.stringify(parseJson(notice.dataJson) ?? notice.dataJson, null, 2),
        ]
          .filter(Boolean)
          .join("\n")
      : "";

  return { message: safeFailureDetail(message), details: safeFailureDetail(details) };
}
