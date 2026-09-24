/** Thrown by `report()` / `submitFromWidget()` when `beforeCapture` or `beforeSend` returns null. */
export class SpotterDroppedError extends Error {
  readonly stage: "beforeCapture" | "beforeSend";
  constructor(stage: "beforeCapture" | "beforeSend") {
    super(`Spotter: the report was dropped by ${stage}.`);
    this.name = "SpotterDroppedError";
    this.stage = stage;
  }
}
