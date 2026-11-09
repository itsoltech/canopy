import { create, type DescMethod } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { ATTACHMENT_PREVIEW_BYTES } from "@canopy/domain/attachment-preview";
import { Code, ConnectError } from "@connectrpc/connect";
import type { LinkedComputers } from "../computers/runtime.ts";
import { single } from "./routed-context.ts";

/** Older homes ignore preview, returning the whole file; keep the public read bounded on this side too. */
export async function* remoteAttachment(
  computers: LinkedComputers,
  node: string,
  method: DescMethod,
  request: ui.GetAttachmentRequest,
  signal: AbortSignal,
) {
  const read = (input: ui.GetAttachmentRequest) =>
    single<ui.GetAttachmentResponse>(computers.remote(node, method, input, signal));

  let response: ui.GetAttachmentResponse;

  try {
    response = await read(request);
  } catch (cause) {
    // A stale thumbnail flag is safe to fall back from. Ownership, policy and availability errors must survive.
    if (
      !request.thumbnail ||
      !(cause instanceof ConnectError) ||
      ![Code.InvalidArgument, Code.FailedPrecondition].includes(cause.code) ||
      cause.rawMessage !== "this attachment has no thumbnail"
    )
      throw cause;
    response = await read(create(ui.GetAttachmentRequestSchema, { ...request, thumbnail: false, preview: false }));
  }

  if (request.preview && !request.thumbnail) {
    const data = response.data.subarray(0, ATTACHMENT_PREVIEW_BYTES);
    response.truncated ||= data.length < response.data.length;
    response.data = data;
  }

  yield response;
}
