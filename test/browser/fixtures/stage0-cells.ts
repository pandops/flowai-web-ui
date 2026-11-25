import type { TestInfo } from "@playwright/test";

// One verdict per Stage 0 matrix cell (implementation-stage0.csv). A failing
// cell is recorded and the remaining cells still run, so one change-wide run
// shows every cell's own result. qa-e2e/scripts/stage0-census.mjs compares
// the recorded cells with every non-discarded CSV row.
export type CellAxes = Readonly<Record<string, string | number>>;
export const cellName = (axes: CellAxes) =>
  Object.entries(axes)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");

export class Stage0Cells {
  readonly failures: Error[] = [];
  constructor(
    private readonly info: TestInfo,
    readonly mechanism: string,
  ) {}

  async run(axes: CellAxes, body: () => Promise<unknown>) {
    const cell = cellName(axes);
    try {
      await body();
      await this.record(cell, true);
    } catch (error) {
      await this.fail(axes, error);
    }
  }

  // Records cells that could not run because a shared prerequisite failed.
  async fail(axes: CellAxes, error: unknown) {
    const cell = cellName(axes);
    const failure = new Error(`${this.mechanism}: ${cell}: ${String(error)}`);
    this.failures.push(failure);
    await this.record(cell, false, error);
  }

  async record(cell: string, passed: boolean, error?: unknown) {
    await this.info.attach("stage0-cell", {
      body: JSON.stringify({
        mechanism: this.mechanism,
        cell,
        passed,
        ...(error === undefined
          ? {}
          : { error: String((error as Error)?.stack ?? error).slice(0, 4000) }),
      }),
      contentType: "application/json",
    });
  }

  finish() {
    if (this.failures.length)
      throw new AggregateError(
        this.failures,
        `${this.mechanism}: ${this.failures.length} Stage 0 cells failed`,
      );
  }
}
