import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { activityNotchEdges, defaultActivityNotchPlacement, type ActivityNotchPlacement } from "@canopy/ui/desktop";

const fraction = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1));
const display = Schema.optionalKey(Schema.Number.check(Schema.isInt()));

const placement = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("notch") }),
  Schema.Struct({ mode: Schema.Literal("edge"), edge: Schema.Literals(activityNotchEdges), offset: fraction, display }),
  Schema.Struct({ mode: Schema.Literal("floating"), x: fraction, y: fraction, display }),
]);

/** Accepts only the declared shapes, so a placement from a renderer or an old file cannot carry anything else. */
export const decodeActivityNotchPlacement = Schema.decodeUnknownSync(placement, { onExcessProperty: "error" });

export interface ActivityNotchPlacementStore {
  read(): ActivityNotchPlacement;
  write(placement: ActivityNotchPlacement): void;
}

/** A setting of this computer: it follows its displays, not the Canopy profile or the gateway. */
export function activityNotchPlacementFile(directory: string): ActivityNotchPlacementStore {
  const path = join(directory, "activity-notch.json");
  const fallback = defaultActivityNotchPlacement(process.platform);

  return {
    read() {
      // A missing, unreadable or outdated file only costs the place; the overlay still shows.
      try {
        return decodeActivityNotchPlacement(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return fallback;
      }
    },
    write(next) {
      writeFileSync(`${path}.tmp`, JSON.stringify(next) + "\n", { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    },
  };
}

export function activityNotchPlacementMemory(initial: ActivityNotchPlacement): ActivityNotchPlacementStore {
  let current = initial;

  return {
    read: () => current,
    write: (next) => (current = next),
  };
}
