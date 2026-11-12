import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { github } from "@canopy/contracts";
import { Code, type ConnectError } from "@connectrpc/connect";

export function pickerFailure(response: github.RepositoryPullRequestsResponse, error: ConnectError, retryAt: number) {
  response.items = [];
  response.nextCursor = "";
  response.state = "unavailable";
  response.detail = error.rawMessage;

  if (retryAt) {
    response.state = "rate_limited";
    response.detail = "GitHub’s request limit was reached. Retry after the reset time.";
    response.retryAt = timestampFromDate(new Date(retryAt));
  } else {
    if (error.code === Code.PermissionDenied) response.state = "installation_required";

    if (error.code === Code.FailedPrecondition && error.rawMessage.includes("Reconnect"))
      response.state = "account_required";
  }

  return response;
}
