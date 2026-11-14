import { NoticeLevel, type Notice } from "@canopy/contracts";
import type { NoticeState } from "./turn-notices.ts";
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
export function noticePresentation(notice: Pick<Notice, "message" | "code" | "dataJson">, state: NoticeState = {}) {
  const recovered = state.recovered && notice.code !== "extra_usage";
  const wrapped = Option.getOrUndefined(decodeError(notice.message));

  const message = wrapped
    ? `Provider error${wrapped.status === undefined ? "" : ` ${wrapped.status}`}: ${wrapped.error.message}`
    : notice.message || humanizeEnum(notice.code);

  const details =
    wrapped || notice.dataJson || recovered
      ? [
          notice.code && `Code: ${notice.code}`,
          wrapped && JSON.stringify(parseJson(notice.message), null, 2),
          !wrapped && recovered && notice.message,
          notice.dataJson && JSON.stringify(parseJson(notice.dataJson) ?? notice.dataJson, null, 2),
        ]
          .filter(Boolean)
          .join("\n")
      : "";

  return {
    message: recovered ? "Turn completed with a warning. No action needed." : safeFailureDetail(message),
    details: safeFailureDetail(details),
    level: state.recovered ? NoticeLevel.WARNING : undefined,
    count: state.count ?? 1,
  };
}
