import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { bffSession } from "#lib/server/bff-session.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, request }) => {
  const session = bffSession();
  const { thread } = await call(() => session.thread(params.threadId, request.signal));

  if (!thread || thread.id !== params.threadId || thread.archivedAt || thread.status === "archived")
    return json({}, { status: 404 });

  const overview = await call(() => session.overview.overview());
  const worker = overview.workers.find((entry) => entry.id === thread.workerId);
  const computer = overview.computers.find((entry) => entry.nodeId === thread.nodeId);

  return json(
    {
      thread: encode(ui.ThreadSchema, thread),
      ...(worker && { worker: encode(ui.WorkerSchema, worker) }),
      ...(computer && { computer: encode(ui.LinkedComputerSchema, computer) }),
    },
    { headers: { "cache-control": "no-store" } },
  );
};
