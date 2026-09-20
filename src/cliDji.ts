#!/usr/bin/env node
/**
 * Converts a DJI flight log (as exported by Flight Reader) into this tool's own canonical telemetry
 * format — the same `telemetry.csv` + `video.json` pair the STANAG pipeline produces, so a consumer has
 * one format to read rather than one per source.
 *
 * No video work at all: a DJI recording is already an ordinary mp4, so this writes the telemetry and the
 * manifest beside whatever video file is already there and leaves it untouched.
 *
 * ## Absolute time, from a one-second column
 *
 * A Flight Reader export carries two time columns: `time(millisecond)`, a precise offset from the start
 * of the flight log, and `datetime(utc)`, a real date at WHOLE-SECOND resolution. Neither alone is
 * enough — the first has no date, the second cannot tell apart the ten rows inside one second — so
 * absolute time is reconstructed from both:
 *
 *  1. Find the rows where `datetime(utc)` ticks over. Each such row is that whole second, ± one sample.
 *  2. For each tick, `anchor = wholeSecondEpochMs - time(millisecond)`.
 *  3. Take the MEDIAN of those anchors, not the first: real logs drop samples, so an individual tick can
 *     land late. Measured on `luciad.csv`, ticks are 1000 ms apart except one at 1100 ms.
 *  4. `unixMs = anchor + time(millisecond)`, which keeps the log's own 100 ms precision.
 *
 * That puts absolute time within about one sample of the truth, where parsing `datetime(utc)` per row
 * would have quantised a 10 Hz track down to 1 Hz — visible as a drone that jumps once a second.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { writeTelemetryCsv } from "./csv.js";
import { writeManifest } from "./manifest.js";
import type { TelemetryRow } from "./telemetry.js";

const TELEMETRY_FILENAME = "telemetry.csv";
const MANIFEST_FILENAME = "video.json";
const FEET_TO_METRES = 0.3048;

/** Flight Reader's own column names. This converter is for that shape specifically, not a generic CSV
 * importer — the names are its export's, not a DJI standard. */
const COLUMNS = {
  timeMs: "time(millisecond)",
  datetimeUtc: "datetime(utc)",
  lon: "longitude",
  lat: "latitude",
  heightFeet: "ascent(feet)",
  yaw: "gimbal_heading(degrees)",
  pitch: "gimbal_pitch(degrees)",
  roll: "gimbal_roll(degrees)",
} as const;

interface RawRow {
  readonly timeMs: number;
  readonly datetimeUtc: string;
  readonly lon: number;
  readonly lat: number;
  readonly heightMetres: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** `"2024-10-22 08:22:06"` — a space, no zone marker, and it IS UTC (the column says so), so the `T`/`Z`
 * are supplied rather than letting `Date.parse` treat it as local time. */
function parseUtcSecond(value: string): number {
  const parsed = Date.parse(`${value.trim().replace(" ", "T")}Z`);
  if (Number.isNaN(parsed)) throw new Error(`Could not read "${value}" as a UTC date.`);
  return parsed;
}

export function readFlightLog(csvText: string): readonly RawRow[] {
  const lines = csvText.split(/\r\n|\n/).filter((line) => line.length > 0);
  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  const index = Object.fromEntries(Object.entries(COLUMNS).map(([key, name]) => [key, header.indexOf(name)])) as Record<
    keyof typeof COLUMNS,
    number
  >;
  const missing = Object.entries(COLUMNS).filter(([key]) => index[key as keyof typeof COLUMNS] < 0);
  if (missing.length > 0) {
    throw new Error(`This CSV is missing the column(s) ${missing.map(([, name]) => `"${name}"`).join(", ")} — is it a Flight Reader export?`);
  }

  const rows: RawRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const row = {
      timeMs: parseFloat(c[index.timeMs] ?? ""),
      datetimeUtc: (c[index.datetimeUtc] ?? "").trim(),
      lon: parseFloat(c[index.lon] ?? ""),
      lat: parseFloat(c[index.lat] ?? ""),
      heightMetres: parseFloat(c[index.heightFeet] ?? "") * FEET_TO_METRES,
      yaw: parseFloat(c[index.yaw] ?? ""),
      pitch: parseFloat(c[index.pitch] ?? ""),
      roll: parseFloat(c[index.roll] ?? ""),
    };
    if (Number.isFinite(row.timeMs) && Number.isFinite(row.lon) && Number.isFinite(row.lat)) rows.push(row);
  }
  return rows.sort((a, b) => a.timeMs - b.timeMs);
}

/** The epoch-millisecond value that `time(millisecond) === 0` corresponds to — see this file's own header
 * comment for why this is a median over the `datetime(utc)` transitions rather than row zero's date. */
export function deriveEpochAnchorMs(rows: readonly RawRow[]): { anchorMs: number; tickCount: number } {
  const anchors: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.datetimeUtc === rows[i - 1]!.datetimeUtc) continue;
    anchors.push(parseUtcSecond(row.datetimeUtc) - row.timeMs);
  }
  if (anchors.length === 0) {
    // A log short enough to sit inside one second: row zero's date is all there is, and it is then only
    // accurate to the second — stated rather than silently pretended otherwise.
    const first = rows[0];
    if (!first) throw new Error("No usable rows in this flight log.");
    return { anchorMs: parseUtcSecond(first.datetimeUtc) - first.timeMs, tickCount: 0 };
  }
  return { anchorMs: median(anchors), tickCount: anchors.length };
}

export function toTelemetryRows(rows: readonly RawRow[], anchorMs: number): TelemetryRow[] {
  return rows.map((row) => ({
    unixMs: anchorMs + row.timeMs,
    lon: row.lon,
    lat: row.lat,
    height: row.heightMetres,
    yaw: row.yaw,
    pitch: row.pitch,
    roll: row.roll,
    // A DJI log reports none of these: no per-frame FOV (fixed-zoom camera) and no ground target.
    fovX: undefined,
    fovY: undefined,
    targetLon: undefined,
    targetLat: undefined,
    targetElevation: undefined,
  }));
}

const program = new Command();
program
  .name("videodrapingtool-dji")
  .description("Converts a DJI flight log (Flight Reader CSV) into this tool's canonical telemetry.csv + video.json.")
  .argument("<flight-log>", "path to the Flight Reader CSV export")
  .requiredOption("-o, --output <dir>", "output directory — created if it doesn't exist; the video is expected to be there already")
  .requiredOption("--video <filename>", "the existing video file's name, for the manifest's videoUrl (this tool does not touch it)")
  .option("--variant <name>", 'the video.json "variant" field', "dji")
  .option("--icon-mesh <filename>", 'the video.json "iconMeshUrl" field, if a mesh sits beside the video')
  .option(
    "--video-start <iso>",
    "the UTC instant of video t=0. Defaults to the first telemetry sample's own instant; override when the video does not begin where the log does",
  )
  .action((flightLog: string, opts: { output: string; video: string; variant: string; iconMesh?: string; videoStart?: string }) => {
    try {
      const outputDir = resolve(opts.output);
      mkdirSync(outputDir, { recursive: true });

      const raw = readFlightLog(readFileSync(resolve(flightLog), "utf-8"));
      if (raw.length === 0) throw new Error(`No usable rows found in "${flightLog}".`);
      const { anchorMs, tickCount } = deriveEpochAnchorMs(raw);
      const rows = toTelemetryRows(raw, anchorMs);

      writeTelemetryCsv(join(outputDir, TELEMETRY_FILENAME), rows);
      const videoStartUtc = opts.videoStart ?? new Date(rows[0]!.unixMs).toISOString();
      writeManifest(join(outputDir, MANIFEST_FILENAME), {
        variant: opts.variant,
        videoFilename: opts.video,
        telemetryFilename: TELEMETRY_FILENAME,
        videoStartUtc,
        ...(opts.iconMesh ? { iconMeshUrl: opts.iconMesh } : {}),
      });

      const spanMs = rows.at(-1)!.unixMs - rows[0]!.unixMs;
      console.log(`\nDone. ${rows.length} telemetry samples converted, spanning ${(spanMs / 1000).toFixed(3)}s.`);
      console.log(`  ${new Date(rows[0]!.unixMs).toISOString()} -> ${new Date(rows.at(-1)!.unixMs).toISOString()}`);
      console.log(
        tickCount > 0
          ? `  UTC anchored on the median of ${tickCount} datetime(utc) transition(s) — accurate to about one sample.`
          : `  UTC anchored on row zero's datetime(utc) alone (no transition in this log) — accurate only to the second.`,
      );
      console.log(`  videoStartUtc: ${videoStartUtc}${opts.videoStart ? " (from --video-start)" : " (first sample)"}`);
      try {
        const size = statSync(join(outputDir, opts.video)).size;
        console.log(`  ${opts.video}: ${(size / 1024 / 1024).toFixed(1)} MB (left untouched)`);
      } catch {
        console.log(`  Note: "${opts.video}" is not in ${outputDir} yet — the manifest points at it regardless.`);
      }
      console.log(`Output: ${outputDir}`);
    } catch (e) {
      console.error(`\nError: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
