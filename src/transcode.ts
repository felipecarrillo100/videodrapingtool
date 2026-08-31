/**
 * Size-optimized re-encode, via the same real `ffmpeg` binary `extractKlv.ts` already requires — not a
 * second dependency. Three knobs matter, not two: `-crf`/`-preset` are the usual H.264 size-vs-quality
 * pair, but the source's own framerate matters just as much here and is easy to miss, since re-encoding
 * "the same codec, just smaller" sounds like it should shrink things on its own — it doesn't. The
 * `samples/day-flight.mpg` source is ALREADY H.264 (confirmed via `ffmpeg -i`), so a same-fps re-encode
 * at conservative settings only saves what the bitrate/CRF difference buys, which isn't much (measured:
 * 102 MB source -> 57.5 MB at `crf 23, preset medium, source's native 60fps`). Slowly-panning aerial
 * footage viewed as a map texture doesn't benefit at all from 60fps; dropping to 30fps roughly halves the
 * encoded frame count for content that doesn't need the extra smoothness. Measured with all three levers
 * together (`crf 28, preset slow, 30fps`): 21.3 MB — a fifth of the source, not half. That's the new
 * default; all three stay CLI-overridable for anyone who wants to trade back up for quality.
 */
import { spawnSync } from "node:child_process";

export interface TranscodeOptions {
  readonly crf: number;
  readonly preset: string;
  readonly fps: number;
}

export function transcodeToOptimizedMp4(inputPath: string, outputPath: string, options: TranscodeOptions): void {
  const result = spawnSync("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-r",
    String(options.fps),
    "-c:v",
    "libx264",
    "-crf",
    String(options.crf),
    "-preset",
    options.preset,
    "-an",
    outputPath,
  ]);
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed transcoding the video (exit ${result.status}):\n${(result.stderr?.toString() ?? "").slice(-2000)}`);
  }
}
