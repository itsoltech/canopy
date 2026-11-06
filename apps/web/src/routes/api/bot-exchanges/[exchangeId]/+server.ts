import { json } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, url }) =>
  json(
    encode(
      bots.ReadBotExchangeResponseSchema,
      await call((api) =>
        api.readBotExchange({
          exchangeId: params.exchangeId,
          pageSize: 50,
          beforeSeq: BigInt(
            /^\d{1,18}$/.test(url.searchParams.get("before") ?? "") ? url.searchParams.get("before")! : "0",
          ),
          incremental: url.searchParams.get("incremental") === "1",
          cursor: url.searchParams.get("cursor") ?? "",
        }),
      ),
    ),
  );
