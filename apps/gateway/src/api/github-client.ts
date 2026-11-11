import { createHash } from "node:crypto";
import { reflect } from "@bufbuild/protobuf/reflect";
import type { DescMethod, Message } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { mobileIdentity } from "../core/mobile-devices.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Clients cannot nominate another device or browser. The BFF supplies its HttpOnly session binding. */
export function githubClient(context: HandlerContext, forwarded = "") {
  if (context.protocolName === "canopy.link") {
    const peer = context.requestHeader.get("canopy-linked-peer");

    if (!peer || !/^[a-f0-9]{64}$/.test(forwarded))
      throw new ConnectError("GitHub sign-in client is unavailable", Code.Unauthenticated);

    return digest(`peer:${peer}:${forwarded}`);
  }

  const device = context.values.get(mobileIdentity);

  if (device) return digest(`device:${device.deviceId}`);
  const session = context.requestHeader.get("canopy-github-client") ?? "";

  if (!/^[A-Za-z0-9_-]{43}$/.test(session))
    throw new ConnectError("Start GitHub sign-in from Settings → GitHub.", Code.Unauthenticated);

  return digest(`browser:${session}`);
}

/** Replace public payload bindings before routing. A linked home binds them to the authenticated peer too. */
export function bindGitHubRequest(method: DescMethod, request: Message, context: HandlerContext) {
  if (
    ![
      "BeginGitHubDeviceAuth",
      "GetGitHubDeviceAuth",
      "CancelGitHubDeviceAuth",
      "PreparePullRequestMutation",
      "GetPullRequestMutation",
      "CreatePullRequestComment",
      "ReplyPullRequestReviewThread",
      "UpdatePullRequestComment",
      "DeletePullRequestComment",
      "SetPullRequestFileViewed",
      "AddPullRequestReviewComment",
      "SubmitPullRequestReview",
      "DiscardPullRequestReview",
      "SetPullRequestReviewThreadResolved",
    ].includes(method.name)
  )
    return;
  // SAFETY: every allowlisted proto request declares clientBinding; no other descriptor reaches this access.
  reflect(method.input, request).set(method.input.field["clientBinding"]!, githubClient(context));
}
