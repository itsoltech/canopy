import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { Code, ConnectError } from "@connectrpc/connect";

/** A configuration grant still has to be live when HTTP/2 pulls the frame out of the link queue. */
export class LinkOutput extends AsyncChannel<link.LinkFrame> {
  readonly #grants = new WeakMap<link.LinkFrame, AbortSignal>();
  readonly #ended = new WeakSet<AbortSignal>();

  #frame(frame: MessageInitShape<typeof link.LinkFrameSchema>, grant?: AbortSignal) {
    const message = create(link.LinkFrameSchema, frame);

    if (grant) this.#grants.set(message, grant);

    return message;
  }

  pushFrame(frame: MessageInitShape<typeof link.LinkFrameSchema>, grant?: AbortSignal) {
    return this.push(this.#frame(frame, grant));
  }

  async writeFrame(frame: MessageInitShape<typeof link.LinkFrameSchema>, signal: AbortSignal, grant?: AbortSignal) {
    if (!(await this.write(this.#frame(frame, grant), signal)))
      throw new ConnectError("Computer link closed while sending", Code.Unavailable);
  }

  async *frames() {
    for await (const frame of this) {
      const grant = this.#grants.get(frame);

      if (!grant?.aborted) yield frame;
      else if (!this.#ended.has(grant) && frame.body.case === "remoteResponse") {
        this.#ended.add(grant);
        yield create(link.LinkFrameSchema, {
          body: {
            case: "remoteResponse",
            value: {
              callId: frame.body.value.callId,
              end: true,
              code: Code.FailedPrecondition,
              message: "Configuration sharing is off",
            },
          },
        });
      }
    }
  }
}
