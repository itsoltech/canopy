import { fromBinary, type DescMessage } from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ComputerStore } from "./store.ts";

/** Transitional reads of an already-persisted legacy protobuf. The reader holds
 * one SQL chunk and one entity, never a ThreadSnapshot or its full byte array.
 */
export class StoredThreadFields {
  #start = -1;
  #chunk: Uint8Array = new Uint8Array();
  constructor(
    readonly store: Pick<ComputerStore, "query">,
    readonly thread: string,
    readonly size: number,
  ) {}

  async bytes(offset: number, length: number): Promise<Uint8Array> {
    if (length > 24 * 1024) throw new ConnectError("Legacy entity preview exceeds its bound", Code.ResourceExhausted);

    if (offset < this.#start || offset + length > this.#start + this.#chunk.length) {
      const row = (
        await this.store.query<{ data: Uint8Array }>(
          "SELECT substring(history FROM $2::integer FOR 4194304) AS data FROM computer_moved_threads WHERE thread_id=$1::uuid",
          [this.thread, offset + 1],
        )
      )[0];

      if (!row?.data.length) throw new ConnectError("Stored thread history is incomplete", Code.DataLoss);
      this.#start = offset;
      this.#chunk = row.data;
    }

    const value = this.#chunk.subarray(offset - this.#start, offset - this.#start + length);

    if (value.length !== length) throw new ConnectError("Stored thread field is incomplete", Code.DataLoss);

    return value;
  }

  async field(offset: number, end: number) {
    const reader = new BinaryReader(await this.bytes(offset, Math.min(20, end - offset)));
    const [number, wire] = reader.tag();

    if (wire === WireType.LengthDelimited) {
      const length = reader.uint32();
      const start = offset + reader.pos;

      if (start + length > end) throw new ConnectError("Stored thread field length is invalid", Code.DataLoss);

      return { number, wire, start, length, end: start + length };
    }

    reader.skip(wire, number);

    return { number, wire, start: offset, length: reader.pos, end: offset + reader.pos };
  }

  async preview(desc: DescMessage, offset: number, end: number, depth = 0): Promise<Uint8Array> {
    if (depth > 16) return new Uint8Array();

    if (end - offset <= 24 * 1024) return this.bytes(offset, end - offset);
    const writer = new BinaryWriter();
    const counts = new Map<number, number>();
    let size = 0;

    while (offset < end && size < 16 * 1024) {
      const field = await this.field(offset, end);
      const descriptor = desc.fields.find((entry) => entry.number === field.number);
      const count = (counts.get(field.number) ?? 0) + 1;
      counts.set(field.number, count);

      if (count <= 16 && descriptor) {
        if (field.wire === WireType.LengthDelimited) {
          const child =
            descriptor.fieldKind === "message" || (descriptor.fieldKind === "list" && descriptor.listKind === "message")
              ? await this.preview(descriptor.message, field.start, field.end, depth + 1)
              : await this.bytes(field.start, Math.min(field.length, 2048));

          writer.tag(field.number, field.wire).bytes(child);
          size += child.length + 12;
        } else {
          writer.raw(await this.bytes(offset, field.end - offset));
          size += field.end - offset;
        }
      }

      offset = field.end;
    }

    return writer.finish();
  }

  async *entities() {
    let offset = 0;

    while (offset < this.size) {
      const field = await this.field(offset, this.size);
      const descriptor = ui.ThreadSnapshotSchema.fields.find((entry) => entry.number === field.number);

      if (
        field.wire === WireType.LengthDelimited &&
        descriptor &&
        (descriptor.fieldKind === "message" ||
          (descriptor.fieldKind === "list" && descriptor.listKind === "message")) &&
        [2, 3, 4, 6, 40, 60, 210].includes(field.number)
      ) {
        const bytes = await this.preview(descriptor.message, field.start, field.end);
        const value = decodeEntity(field.number, bytes);

        if (value) yield { ...field, ...value, typeName: descriptor.message.typeName };
      }

      offset = field.end;
    }
  }
}

function decodeEntity(
  number: number,
  data: Uint8Array,
): { id: string; value: ui.ThreadSyncRecord["value"]; position: bigint } | undefined {
  switch (number) {
    case 2: {
      const value = fromBinary(ui.TurnSchema, data);

      return { id: value.id, value: { case: "turn", value }, position: BigInt(value.ordinal) };
    }

    case 3: {
      const value = fromBinary(ui.TimelineItemSchema, data);

      return { id: value.item?.itemId ?? "", value: { case: "item", value }, position: value.firstSeq };
    }

    case 4: {
      const value = fromBinary(ui.InteractionSchema, data);

      return { id: value.requestId, value: { case: "interaction", value }, position: 0n };
    }

    case 6: {
      const value = fromBinary(ui.ThreadNoticeSchema, data);

      return { id: value.seq.toString(), value: { case: "notice", value }, position: value.seq };
    }

    case 40: {
      const value = fromBinary(ui.SteerSchema, data);

      return { id: value.id, value: { case: "steer", value }, position: 0n };
    }

    case 60: {
      const value = fromBinary(ui.GoalSchema, data);

      return { id: value.id, value: { case: "goal", value }, position: 0n };
    }

    case 210: {
      const value = fromBinary(ui.BusDeliverySchema, data);

      return { id: value.callId, value: { case: "busDelivery", value }, position: 0n };
    }
  }

  return undefined;
}
