/**
 * `ffmpeg` is a real, required external binary — not an npm dependency — for both the KLV-track
 * extraction step (see `extractKlv.ts`) and the size-optimized re-encode (see `transcode.ts`). Checked
 * once up front so a missing install fails with one clear message instead of a cryptic ENOENT partway
 * through the pipeline.
 */
import { spawnSync } from "node:child_process";

export function requireFfmpeg(): void {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error(
      "ffmpeg is required but was not found on PATH. Install it first — e.g. `brew install ffmpeg` on macOS.",
    );
  }
}
