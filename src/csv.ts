import { writeFileSync } from "node:fs";
import type { TelemetryRow } from "./telemetry.js";

const COLUMNS = [
  "timestampMs",
  "lon",
  "lat",
  "height",
  "yaw",
  "pitch",
  "roll",
  "fovX",
  "fovY",
  "targetLon",
  "targetLat",
  "targetElevation",
] as const;

export function writeTelemetryCsv(outputPath: string, rows: readonly TelemetryRow[]): void {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map((col) => (row[col] === undefined ? "" : String(row[col]))).join(","));
  }
  writeFileSync(outputPath, lines.join("\n") + "\n", "utf-8");
}
