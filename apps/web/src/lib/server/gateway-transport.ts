import { create, ScalarType, type DescMessage, type Message } from "@bufbuild/protobuf";
import { reflect } from "@bufbuild/protobuf/reflect";
import { splitId } from "@canopy/domain/computers";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";

/** Routing ids only; request contents never enter diagnostics. Separate pools prevent peer actions or subscriptions consuming local unary slots. */
export function targetsLinkedComputer(desc: DescMessage, message: Message): boolean {
  const record = reflect(desc, message);

  for (const field of desc.fields) {
    const id = field.name === "id" || field.name.endsWith("_id") || field.name.endsWith("_ids");

    if (id && field.fieldKind === "scalar" && field.scalar === ScalarType.STRING) {
      const value = record.get(field);

      if (value && (field.name === "node_id" || splitId(value).node)) return true;
    } else if (id && field.fieldKind === "list" && field.listKind === "scalar" && field.scalar === ScalarType.STRING) {
      for (const value of record.get(field)) if (splitId(String(value)).node) return true;
    } else if (
      field.fieldKind === "message" &&
      record.isSet(field) &&
      targetsLinkedComputer(field.message, record.get(field).message)
    )
      return true;
  }

  return false;
}

export function isolatedGatewayTransport(factory: () => Transport): Transport {
  const local = factory();
  const linked = factory();
  const subscriptions = factory();
  const linkedSubscriptions = factory();

  const unary: Transport["unary"] = (...args) =>
    (targetsLinkedComputer(args[0].input, create(args[0].input, args[4])) ? linked : local).unary(...args);

  const stream: Transport["stream"] = async (...args) => {
    // GatewayService server streams have one request. Inspect it before choosing an HTTP/2 pool.
    const input = args[4][Symbol.asyncIterator]();
    const first = await input.next();

    if (first.done) throw new ConnectError("Missing stream request", Code.InvalidArgument);

    const pool = targetsLinkedComputer(args[0].input, create(args[0].input, first.value))
      ? linkedSubscriptions
      : subscriptions;

    async function* messages() {
      try {
        yield first.value;

        for (;;) {
          const next = await input.next();

          if (next.done) return;
          yield next.value;
        }
      } finally {
        await input.return?.();
      }
    }

    try {
      return await pool.stream(args[0], args[1], args[2], args[3], messages(), args[5]);
    } catch (error) {
      await input.return?.();
      throw error;
    }
  };

  return { unary, stream };
}
