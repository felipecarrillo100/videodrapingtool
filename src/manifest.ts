/**
 * Same manifest shape family as the app's existing `"dji"` sample `video.json` — just a different
 * `variant` string. NOT consumable by MapEvolution yet: no `"stanag-4609"` decoder exists there today, and
 * that's a deliberately separate, later piece of work — this file only has to match the shape a future
 * decoder would expect, not actually be loadable right now.
 */
import { writeFileSync } from "node:fs";

export interface ManifestOptions {
  readonly variant: string;
  readonly videoFilename: string;
  readonly telemetryFilename: string;
  readonly syncOffsetMs: number;
}

export function writeManifest(outputPath: string, options: ManifestOptions): void {
  const manifest = {
    type: "videopanorama",
    variant: options.variant,
    videoUrl: `./${options.videoFilename}`,
    telemetryUrl: `./${options.telemetryFilename}`,
    syncOffsetMs: options.syncOffsetMs,
  };
  writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}
