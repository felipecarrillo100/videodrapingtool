/**
 * The manifest: the one address a consumer is given, pointing at the video and the telemetry beside it.
 *
 * `videoStartUtc` is the single fact that relates the two timelines — the world instant of video `t=0`.
 * Telemetry rows carry absolute time (see `telemetry.ts`), so this is what lets playback be driven by the
 * video's own clock (`videoStartUtc + currentTime`) or by a world clock (the instant directly), from the
 * same data. It replaced `syncOffsetMs`, which said the same thing in the telemetry's own relative units
 * — units this format no longer has, since the relative column is gone.
 *
 * ISO 8601 with milliseconds rather than an epoch number, because manifests get hand-edited: someone
 * correcting a sync error should see a date, and `Date.parse` reads it back in one call.
 */
import { writeFileSync } from "node:fs";

export interface ManifestOptions {
  readonly variant: string;
  readonly videoFilename: string;
  readonly telemetryFilename: string;
  /** ISO 8601, UTC, with milliseconds — e.g. `"2009-06-17T16:53:05.099Z"`. */
  readonly videoStartUtc: string;
  /** Optional 3D mesh for the platform icon, resolved relative to this manifest by the consumer. Omitted
   * from the written JSON entirely when absent, rather than emitted as `null` — the consumer's own
   * default then applies. */
  readonly iconMeshUrl?: string;
}

export function writeManifest(outputPath: string, options: ManifestOptions): void {
  const manifest = {
    type: "videopanorama",
    variant: options.variant,
    videoUrl: `./${options.videoFilename}`,
    telemetryUrl: `./${options.telemetryFilename}`,
    videoStartUtc: options.videoStartUtc,
    ...(options.iconMeshUrl ? { iconMeshUrl: `./${options.iconMeshUrl}` } : {}),
  };
  writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}
