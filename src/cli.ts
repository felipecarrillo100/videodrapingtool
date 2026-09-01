#!/usr/bin/env node
import { Command } from "commander";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireFfmpeg } from "./ffmpegBinary.js";
import { extractKlvTrack, assertNonEmpty } from "./extractKlv.js";
import { decodeSt0601Packets } from "./klv.js";
import { buildTelemetryRows, collapseHeldPosition, findAllEmptyColumns, smoothAngles } from "./telemetry.js";
import { writeTelemetryCsv } from "./csv.js";
import { transcodeToOptimizedMp4 } from "./transcode.js";
import { writeManifest } from "./manifest.js";

const VIDEO_FILENAME = "video.mp4";
const TELEMETRY_FILENAME = "telemetry.csv";
const MANIFEST_FILENAME = "video.json";

const program = new Command();

program
  .name("videodrapingtool")
  .description(
    "Converts STANAG 4609 / MISB ST 0601 KLV drone footage into a video.json + telemetry.csv + " +
      "size-optimized mp4 — the three assets a video-panorama app loads for one flight.",
  )
  .argument("<input-video>", "path to the source video (an MPEG-TS file with an embedded KLV data track)")
  .requiredOption("-o, --output <dir>", "output directory — created if it doesn't exist")
  .option("--variant <name>", "the video.json \"variant\" field", "stanag-4609")
  .option("--sync-offset <ms>", "the video.json \"syncOffsetMs\" field, if the video and telemetry need a manual nudge", "0")
  .option("--crf <n>", "ffmpeg -crf for the re-encode (lower = higher quality, larger file)", "28")
  .option("--preset <name>", "ffmpeg -preset for the re-encode (slower = smaller file at the same -crf)", "slow")
  .option(
    "--fps <n>",
    "frame rate for the re-encode — most source drone footage is 60fps, which buys nothing for slowly-panning aerial footage viewed as a map texture",
    "30",
  )
  .option(
    "--smooth-angles <ms>",
    "smooths yaw/pitch to remove sensor-update artifacts (\"beating\") — raise if beating persists, set to 0 to disable",
    "120",
  )
  .option(
    "--no-collapse-held-position",
    "keep one row per decoded packet even when position hasn't changed (disables the fix for a freeze-then-teleport artifact, for comparison/debugging)",
  )
  .addHelpText(
    "after",
    "\nExamples:\n" +
      "  $ videodrapingtool samples/day-flight.mpg -o out/day-flight\n" +
      "  $ videodrapingtool samples/internal.ts -o out/internal --smooth-angles 200   # stronger smoothing if beating persists\n" +
      "  $ videodrapingtool samples/internal.ts -o out/internal --smooth-angles 0     # disable, compare against raw values\n" +
      "  $ videodrapingtool samples/internal.ts -o out/internal --no-collapse-held-position   # keep raw per-packet position rows\n\n" +
      `Produces, in the given output directory:\n  ${VIDEO_FILENAME}        size-optimized re-encode of the source video\n` +
      `  ${TELEMETRY_FILENAME}    one row per decoded KLV packet: timestampMs,lon,lat,height,yaw,pitch,roll,fovX,fovY,targetLon,targetLat,targetElevation\n` +
      `  ${MANIFEST_FILENAME}       manifest pointing at the two files above\n`,
  )
  .action((inputVideo: string, opts) => {
    run(inputVideo, opts).catch((e) => {
      console.error(`\nError: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    });
  });

async function run(
  inputVideoArg: string,
  opts: {
    output: string;
    variant: string;
    syncOffset: string;
    crf: string;
    preset: string;
    fps: string;
    smoothAngles: string;
    collapseHeldPosition: boolean;
  },
): Promise<void> {
  const inputVideo = resolve(inputVideoArg);
  const outputDir = resolve(opts.output);
  mkdirSync(outputDir, { recursive: true });

  console.log("Checking for ffmpeg...");
  requireFfmpeg();

  const tempDir = mkdtempSync(join(tmpdir(), "videodrapingtool-"));
  try {
    console.log("Extracting KLV metadata track...");
    const klvPath = join(tempDir, "klv.bin");
    extractKlvTrack(inputVideo, klvPath);
    const klvBytes = readFileSync(klvPath);
    assertNonEmpty(inputVideo, klvBytes);

    console.log("Decoding ST 0601 packets...");
    const packets = decodeSt0601Packets(klvBytes);
    if (packets.length === 0) {
      throw new Error(
        `Extracted a KLV track from "${inputVideo}" but decoded zero ST 0601 packets from it — ` +
          "is this really MISB ST 0601 telemetry, or a different KLV standard?",
      );
    }

    const rows = buildTelemetryRows(packets);
    const skippedCount = packets.length - rows.length;
    const emptyColumns = findAllEmptyColumns(rows);

    const smoothWindowMs = Number(opts.smoothAngles);
    const { rows: smoothedRows, windowSamples, nominalSpacingMs } = smoothAngles(rows, smoothWindowMs);

    const { rows: finalRows, droppedCount: heldPositionCount } = opts.collapseHeldPosition
      ? collapseHeldPosition(smoothedRows)
      : { rows: smoothedRows, droppedCount: 0 };

    console.log("Writing telemetry.csv...");
    writeTelemetryCsv(join(outputDir, TELEMETRY_FILENAME), finalRows);

    console.log(`Transcoding video (crf=${opts.crf}, preset=${opts.preset}, fps=${opts.fps})...`);
    transcodeToOptimizedMp4(inputVideo, join(outputDir, VIDEO_FILENAME), {
      crf: Number(opts.crf),
      preset: opts.preset,
      fps: Number(opts.fps),
    });

    console.log("Writing video.json...");
    writeManifest(join(outputDir, MANIFEST_FILENAME), {
      variant: opts.variant,
      videoFilename: VIDEO_FILENAME,
      telemetryFilename: TELEMETRY_FILENAME,
      syncOffsetMs: Number(opts.syncOffset),
    });

    const videoSize = statSync(join(outputDir, VIDEO_FILENAME)).size;
    console.log(`\nDone. ${finalRows.length} telemetry samples decoded, spanning ${(finalRows.at(-1)?.timestampMs ?? 0) / 1000}s.`);
    console.log(`  ${VIDEO_FILENAME}: ${(videoSize / 1024 / 1024).toFixed(1)} MB`);
    if (skippedCount > 0) {
      console.log(`  Skipped ${skippedCount} non-positional packet(s) (no Sensor Latitude/Longitude) sharing a timestamp with a real sample.`);
    }
    if (smoothWindowMs > 0) {
      console.log(`  Smoothed yaw/pitch: window=${smoothWindowMs}ms (~${windowSamples} samples at this file's ~${nominalSpacingMs.toFixed(1)}ms spacing).`);
    } else {
      console.log(`  Yaw/pitch smoothing disabled (--smooth-angles 0).`);
    }
    if (heldPositionCount > 0) {
      const avgSpacingMs = finalRows.length > 1 ? finalRows.at(-1)!.timestampMs / finalRows.length : 0;
      console.log(`  Collapsed ${heldPositionCount} held-position packet(s) into their real update boundaries (~${avgSpacingMs.toFixed(0)}ms avg spacing).`);
    } else if (!opts.collapseHeldPosition) {
      console.log(`  Held-position collapsing disabled (--no-collapse-held-position).`);
    }
    if (emptyColumns.length > 0) {
      console.log(`  Note: these columns were empty across every packet: ${emptyColumns.join(", ")}`);
    }
    console.log(`Output: ${outputDir}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

program.parseAsync(process.argv);
