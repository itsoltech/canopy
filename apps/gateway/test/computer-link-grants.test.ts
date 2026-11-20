import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import { Code } from "@connectrpc/connect";
import { LinkOutput } from "../src/computers/link-output.ts";
import { RemoteCalls } from "../src/computers/remote.ts";

test("answering and revoking a thread secret reach the direct home and write no frames on an indirect route", async () => {
  const requests: string[] = [];

  const remote: RemoteCalls = new RemoteCalls({
    allowed: async () => true,
    name: () => "Home",
    send: () => {},
    write: async (frame) => {
      const body = create(link.LinkFrameSchema, frame).body;

      if (body.case !== "remoteRequest") throw new Error("Expected a request");
      requests.push(body.value.method);
      const callId = body.value.callId;
      remote.receive({ case: "remoteResponse", value: create(link.RemoteResponseSchema, { callId }) });
      remote.receive({ case: "remoteResponse", value: create(link.RemoteResponseSchema, { callId, end: true }) });
    },
  });

  const signal = new AbortController().signal;
  const requestId = crypto.randomUUID();
  const route = { targetNodeId: "b".repeat(64), originNodeId: "", relayHops: 0 };
  const methods = ui.GatewayService.method;

  const operations = [
    [methods.answerThreadSecret, create(ui.AnswerThreadSecretRequestSchema, { requestId, decline: true })],
    [methods.revokeThreadSecret, create(ui.RevokeThreadSecretRequestSchema, { requestId })],
  ] as const;

  try {
    for (const [method, request] of operations) {
      await expect(remote.call(method, request, signal, route).next()).rejects.toMatchObject({
        code: Code.PermissionDenied,
      });
      const replies = [];

      for await (const reply of remote.call(method, request, signal)) replies.push(reply);
      expect(replies).toEqual([create(ui.ThreadSecretResponseSchema)]);
    }

    expect(requests).toEqual(["AnswerThreadSecret", "RevokeThreadSecret"]);
  } finally {
    remote.close();
  }
});

test("revoking configuration discards buffered fragments of that call before the next transport pull", async () => {
  const output = new LinkOutput();
  const stream = output.frames();
  const grant = new AbortController();
  const linkSignal = new AbortController().signal;

  const fragment = (callId: bigint, byte: number, access?: AbortSignal) =>
    output.writeFrame(
      {
        body: { case: "remoteResponse", value: { callId, payload: Uint8Array.of(byte) } },
      },
      linkSignal,
      access,
    );

  try {
    await fragment(1n, 1, grant.signal);
    await fragment(1n, 2, grant.signal);
    await fragment(1n, 3, grant.signal);
    output.pushFrame({ body: { case: "remoteResponse", value: { callId: 1n, end: true } } }, grant.signal);
    await fragment(2n, 4);
    expect(await stream.next()).toMatchObject({
      value: { body: { value: { callId: 1n, payload: Uint8Array.of(1) } } },
    });
    grant.abort();
    const renewed = new AbortController();
    await fragment(3n, 5, renewed.signal);
    output.close();

    const rest = [];

    for await (const frame of stream) {
      if (frame.body.case !== "remoteResponse") throw new Error("Expected a response");
      const { callId, payload, end, code } = frame.body.value;
      rest.push({ callId, bytes: [...payload], end, code });
    }

    expect(rest).toEqual([
      { callId: 1n, bytes: [], end: true, code: Code.FailedPrecondition },
      { callId: 2n, bytes: [4], end: false, code: 0 },
      { callId: 3n, bytes: [5], end: false, code: 0 },
    ]);
  } finally {
    output.close();
    await stream.return();
  }
});
