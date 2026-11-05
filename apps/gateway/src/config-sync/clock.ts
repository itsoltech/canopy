import { Code, ConnectError } from "@connectrpc/connect";

const CLOCK = /^(\d{1,16})\.(\d{1,10})\.([a-f0-9]{64})$/;

export function clockParts(value: string) {
  if (!value) return { wall: 0, counter: 0, node: "" };
  const parts = CLOCK.exec(value);

  if (!parts) throw new ConnectError("Invalid configuration clock", Code.InvalidArgument);
  const wall = Number(parts[1]);
  const counter = Number(parts[2]);

  if (!Number.isSafeInteger(wall) || !Number.isSafeInteger(counter))
    throw new ConnectError("Invalid configuration clock", Code.InvalidArgument);

  return { wall, counter, node: parts[3]! };
}

export function compareClock(a: string, b: string): number {
  const x = clockParts(a);
  const y = clockParts(b);

  return x.wall - y.wall || x.counter - y.counter || (x.node === y.node ? 0 : x.node < y.node ? -1 : 1);
}

export function nextClock(last: string, node: string, now = Date.now()): string {
  const previous = clockParts(last);
  const wall = Math.max(now, previous.wall);

  return `${wall}.${wall === previous.wall ? previous.counter + 1 : 0}.${node}`;
}
