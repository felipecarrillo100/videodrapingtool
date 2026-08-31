#!/usr/bin/env node
import { Command } from "commander";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireFfmpeg } from "./ffmpegBinary.js";
import { extractKlvTrack, assertNonEmpty } from "./extractKlv.js";
import { decodeSt0601Packets } from "./klv.js";
import { buildTelemetryRows, findAllEmptyColumns } from "./telemetry.js";
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
  .addHelpText(
    "after",
    "\nExample:\n  $ videodrapingtool samples/day-flight.mpg -o out/day-flight\n\n" +
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
  opts: { output: string; variant: string; syncOffset: string; crf: string; preset: string; fps: string },
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
    const emptyColumns = findAllEmptyColumns(rows);

    console.log("Writing telemetry.csv...");
    writeTelemetryCsv(join(outputDir, TELEMETRY_FILENAME), rows);

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
    console.log(`\nDone. ${packets.length} packets decoded, spanning ${(rows.at(-1)?.timestampMs ?? 0) / 1000}s.`);
    console.log(`  ${VIDEO_FILENAME}: ${(videoSize / 1024 / 1024).toFixed(1)} MB`);
    if (emptyColumns.length > 0) {
      console.log(`  Note: these columns were empty across every packet: ${emptyColumns.join(", ")}`);
    }
    console.log(`Output: ${outputDir}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

program.parseAsync(process.argv);
