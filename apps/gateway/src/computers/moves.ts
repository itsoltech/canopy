import type { ComputerStore } from "./store.ts";

import { ComputerMovesState, movesState, type MoveHost } from "./moves-context.ts";
import { movesPreviewMethods, type MovesPreviewMethods } from "./moves-preview.ts";
import { movesRecoveryMethods, type MovesRecoveryMethods } from "./moves-recovery.ts";
import { movesSourceMethods, type MovesSourceMethods } from "./moves-source.ts";
import { movesTargetMethods, type MovesTargetMethods } from "./moves-target.ts";

export { handoffNote, MoveCrash, type MoveHost, type MovePhase } from "./moves-context.ts";

export class ComputerMoves {
  declare preview: MovesPreviewMethods["preview"];
  declare start: MovesSourceMethods["start"];
  declare list: MovesSourceMethods["list"];
  declare serve: MovesTargetMethods["serve"];
  declare load: MovesRecoveryMethods["load"];
  declare close: MovesRecoveryMethods["close"];
  declare tick: MovesRecoveryMethods["tick"];
  declare unlinked: MovesRecoveryMethods["unlinked"];
  declare frozen: MovesRecoveryMethods["frozen"];

  readonly [movesState] = new ComputerMovesState();

  constructor(store: ComputerStore, host: MoveHost) {
    this[movesState].store = store;
    this[movesState].host = host;
  }
}

for (const methods of [movesPreviewMethods, movesSourceMethods, movesTargetMethods, movesRecoveryMethods]) {
  const descriptors = Object.getOwnPropertyDescriptors(methods);

  for (const descriptor of Object.values(descriptors)) descriptor.enumerable = false;
  Object.defineProperties(ComputerMoves.prototype, descriptors);
}
