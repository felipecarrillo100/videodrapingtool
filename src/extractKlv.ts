/**
 * Pulls the raw KLV metadata track out of the source video's MPEG-TS container, per `misb.js`'s own
 * README-documented approach: `ffmpeg -map 0:d:0 -codec copy -f data <output>`. Verified against the real
 * sample (`samples/day-flight.mpg`, `Stream #0:1[0x1f1]: Data: klv`): produces the exact same bytes
 * `ffprobe`'s own packet listing independently confirms.
 */
import { spawnSync } from "node:child_process";

/** Real, confirmed-live ffmpeg behavior when there's no data stream at that index: non-zero exit
 * (234 in testing — the specific code isn't documented/stable, so only its non-zero-ness is checked),
 * stderr containing "matches no streams". Detected here so the CLI can say something useful instead of
 * dumping a raw ffmpeg stack trace. */
export function extractKlvTrack(inputPath: string, outputPath: string): void {
  const result = spawnSync("ffmpeg", ["-y", "-i", inputPath, "-map", "0:d:0", "-codec", "copy", "-f", "data", outputPath]);
  const stderr = result.stderr?.toString() ?? "";
  if (result.status !== 0) {
    if (stderr.includes("matches no streams")) {
      throw new Error(
        `No data (KLV) stream found in "${inputPath}" at index 0. Run \`ffmpeg -i "${inputPath}"\` yourself ` +
          "to see what streams this file actually has.",
      );
    }
    throw new Error(`ffmpeg failed extracting the KLV track (exit ${result.status}):\n${stderr.slice(-2000)}`);
  }
}

/** `extractKlvTrack` above already throws on a real ffmpeg failure — an empty-but-present output at this
 * point means ffmpeg succeeded but the stream was genuinely silent for its whole duration (no packets at
 * all, not even the sparse handful the sample data has), worth a distinct message from "the stream
 * doesn't exist at all." */
export function assertNonEmpty(path: string, bytes: Buffer): void {
  if (bytes.length === 0) {
    throw new Error(`The KLV track in "${path}" extracted successfully but contains zero bytes — no telemetry to decode.`);
  }
}
