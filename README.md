# VideoDrapingTool

Converts drone/UAV footage carrying **STANAG 4609 / MISB ST 0601** telemetry — KLV metadata embedded
directly in the video's MPEG-TS container — into the three assets a video-panorama viewer needs to drape
that footage onto a map: an optimized video file, a per-frame telemetry CSV, and a small manifest.

This is a standalone tool, not tied to any particular app. It exists so the telemetry CSV's own column
schema is grounded in real, decoded data — not a format guessed at ahead of time.

## Requirements

- Node.js 18+
- **ffmpeg** on your `PATH` (e.g. `brew install ffmpeg` on macOS) — used both to pull the KLV track out of
  the source video and to re-encode it.

## Install

```sh
npm install
```

## Usage

```sh
npx tsx src/cli.ts <input-video> -o <output-dir> [options]
```

(Or, once built: `npm run build && videodrapingtool <input-video> -o <output-dir>`.)

```
Options:
  -o, --output <dir>      output directory — created if it doesn't exist (required)
  --variant <name>        the video.json "variant" field (default: "stanag-4609")
  --video-start <iso>     the video.json "videoStartUtc" field — the UTC instant of video t=0
                          (default: the first telemetry sample's own instant)
  --crf <n>               ffmpeg -crf for the re-encode — lower = higher quality, larger file (default: "28")
  --preset <name>         ffmpeg -preset for the re-encode — slower = smaller file at the same -crf (default: "slow")
  --fps <n>               frame rate for the re-encode (default: "30")
  --smooth-angles <ms>    smooths yaw/pitch to remove sensor-update artifacts ("beating") — raise if
                          beating persists, set to 0 to disable (default: "120")
  --no-collapse-held-position   keep one row per decoded packet even when position hasn't changed
                          (disables the fix below, for comparison/debugging)
```

## Converting a DJI flight log

A second entry point, for the other source this format has to cover: a DJI recording plus its Flight
Reader CSV export. It writes the same canonical `telemetry.csv` + `video.json`, so a consumer reads one
format rather than one per source, and it does **no video work at all** — a DJI recording is already an
ordinary mp4, so the manifest simply points at whatever is already there.

```bash
npx tsx src/cliDji.ts <flight-reader.csv> -o <dir> --video <filename> [--icon-mesh <filename>]
```

**Absolute time is reconstructed, not read.** A Flight Reader export has two time columns and neither is
sufficient alone: `time(millisecond)` is precise but has no date, and `datetime(utc)` has the date at
WHOLE-SECOND resolution — ten rows of a 10 Hz log share one value. So the converter finds the rows where
`datetime(utc)` ticks over, computes `wholeSecond − time(millisecond)` at each tick, takes the **median**
of those (real logs drop samples: one tick in `luciad.csv` lands 1100 ms after its neighbour rather than
1000), and adds the log's own millisecond offsets back on. That places the track within about one sample
of true UTC, where parsing `datetime(utc)` per row would have quantised a 10 Hz track to 1 Hz — a drone
that jumps once a second.

**On `--smooth-angles`**: some sources' `Sensor Latitude/Longitude` and `Frame Center Latitude/Longitude`
(the two positions `yaw`/`pitch` are derived from when a packet has no `Target Location`) are sampled by
independent onboard subsystems, each holding its last value between its own real updates, on cadences that
aren't in phase with each other. Recomputing the bearing between them fresh on every packet then produces
a real, rhythmic "beating" — the derived angle swings away from the true trend and snaps back every time
one field updates before the other catches up, confirmed on a real customer file (~5Hz, up to ~1°/step).
This flag applies a windowed median filter to `yaw`/`pitch` only (not `roll`, not position — neither shows
this artifact) to remove it, on by default since it's a strict improvement with no observed downside on
sources that don't exhibit the artifact. The window is in milliseconds, not a raw sample count, so it
means the same real time span regardless of a source's native packet rate; pass `0` to compare against raw
values.

**On `--collapse-held-position`**: some sources' `Sensor Latitude/Longitude/True Altitude` genuinely update
far slower than the packet rate (confirmed on a real customer file: ~4.4Hz, once every ~227ms, against a
50Hz packet stream) — the raw KLV just repeats the last known value, bit-for-bit, for the packets in
between. Writing one row per packet regardless makes a consumer's interpolation think a real update just
happened every packet, so it renders the position frozen for ~200ms then crams the *entire* real
displacement into the one genuine transition where the value actually changes — confirmed on that same
file: 89.7% of steps showed zero motion, the rest averaging 10x the aircraft's real speed. This is not a
tradeoff against accuracy; it's a correction toward it — the current per-packet behavior already
misrepresents position for 90% of the time (frozen and growing staler right up to the snap), while
collapsing repeated rows down to their real update boundaries lets a linear interpolation (the standard
technique flight-radar/ADS-B displays already use for exactly this) bridge the *real* gap with the *real*
values, matching the ground truth exactly at both endpoints instead of only one. On by default; pass
`--no-collapse-held-position` to compare against the raw per-packet rows.

**On the defaults**: the source video's own codec is typically already H.264 — re-encoding to H.264 again
doesn't shrink anything on its own, only the bitrate/CRF/framerate choices do. Measured on the real sample
(`samples/day-flight.mpg`, 102 MB source, native 60fps): a conservative re-encode at the source's own 60fps
(`crf 23, preset medium`) only reached 57.5 MB. Slowly-panning aerial footage viewed as a map texture
doesn't benefit from 60fps at all — dropping to 30fps plus a more aggressive `crf 28, preset slow` reached
21.3 MB, roughly a fifth of the source rather than half. That's why `--fps 30`/`--crf 28`/`--preset slow`
are the defaults; raise quality back up via these flags if a specific dataset needs it.

Run `npx tsx src/cli.ts --help` for the full list, always up to date with what the CLI actually accepts.

### Example

```sh
npx tsx src/cli.ts samples/day-flight.mpg -o out/day-flight
```

## Input

A video file whose MPEG-TS container has an embedded **data** stream carrying MISB ST 0601 KLV metadata
(check with `ffmpeg -i <file>` — look for a line like `Stream #0:1[...]: Data: klv`). This is the standard
STANAG 4609 way of carrying telemetry alongside full-motion video — not a separate sidecar file.

## Output

Given `-o out/day-flight`, produces:

| File | Contents |
|---|---|
| `out/day-flight/video.mp4` | Size-optimized re-encode of the source footage (video only — audio is dropped; irrelevant for map draping). |
| `out/day-flight/telemetry.csv` | One row per decoded KLV packet. Columns below. |
| `out/day-flight/video.json` | `{ type: "videopanorama", variant: "stanag-4609", videoUrl: "./video.mp4", telemetryUrl: "./telemetry.csv", videoStartUtc: "2009-06-17T16:53:05.099Z" }` |

### Time: one column, one anchor

Two facts, stored once each:

- **`unixMs`, per row** — when the sample was measured, in world time.
- **`videoStartUtc`, in the manifest** — the world instant of video `t=0`.

Everything else about time is derived from those. A consumer can therefore drive the same telemetry from
either clock, from the same data:

```
video-driven:  sampleAt(videoStartUtc + video.currentTime * 1000)
clock-driven:  sampleAt(worldClockInstant)
```

This replaced a relative `timestampMs` column plus a `syncOffsetMs` manifest field. The column was exactly
`unixMs[i] - unixMs[0]` — derivable, and it hid the "normalise the first packet to zero" convention inside
the data — while `syncOffsetMs` said what `videoStartUtc` says, in units the format no longer has. Storing
absolute time per row also means the telemetry stays true if the video is trimmed or re-encoded (only the
anchor changes), and that two clips from one sortie can share one telemetry file.

`videoStartUtc` defaults to the first sample's own instant, i.e. "the video begins where the telemetry
does". **That is an assumption, not a measurement**: the KLV track in an MPEG-TS carries no presentation
timestamps (`ffprobe -select_streams d:0 -show_entries packet=pts_time` returns `N/A` for every packet), so
where packet 0 sits in video time cannot be read from the file. `--video-start <iso>` overrides it, and
because it is one value in the manifest, correcting it never means regenerating the CSV.

### `telemetry.csv` schema

A clean schema this tool defines itself — deliberately not mimicking either MISB's own raw tag numbering
or the DJI-flight-log column names an existing `"dji"` video-panorama variant uses elsewhere. This is the
actual contract a future STANAG decoder in the consuming app needs to target.

| Column | Meaning |
|---|---|
| `unixMs` | **When this sample was measured**: milliseconds since the UNIX epoch, UTC, fractional — straight from `Precision Time Stamp` (ST 0601 tag 2), microsecond resolution preserved. Ascending, and the only time column this format has. A packet without tag 2 fails the run rather than producing an untimed row. |
| `lon`, `lat` | Sensor position (WGS84 degrees) — from MISB's `Sensor Longitude`/`Sensor Latitude` tags. |
| `height` | Sensor altitude, metres — from `Sensor True Altitude`. |
| `yaw`, `pitch` | **Absolute** sensor pointing angles, degrees (`yaw` wrapped to 0–360°). Computed from two independent *positions* — `Sensor Latitude/Longitude/True Altitude` and `Target Location Latitude/Longitude/Elevation` — as the bearing and depression angle from one to the other, **not** by composing MISB's `Platform Heading/Pitch/Roll` with `Sensor Relative Azimuth/Elevation/Roll`. That angle-composition approach was tried first (plain addition, then full DCM rotation composition) and both were proven wrong on this tool's own real sample: extracting real video frames and reading the sensor's own on-screen HUD directly showed its printed `LOS` bearing matches raw `Sensor Relative Azimuth Angle` ALONE (platform heading plays no role at all in this file), and the geometrically-required depression angle didn't match any angle-composition attempt either. Falls back to `yaw = Sensor Relative Azimuth Angle` / `pitch = Sensor Relative Elevation Angle` directly when a packet doesn't report target location — untested against real data, since every packet in our sample does report it. |
| `roll` | Absolute sensor roll, degrees (wrapped to 0–360°) — `Platform Roll Angle + Sensor Relative Roll Angle`, plain addition. Unlike yaw/pitch, roll isn't determined by target-tracking geometry (it's the image's own rotation about the boresight axis, not a bearing); the real sample's own values stay small and near-zero throughout, consistent with a stabilized gimbal keeping the horizon level regardless of aircraft attitude. |
| `fovX`, `fovY` | Sensor horizontal/vertical field of view, degrees — from `Sensor Horizontal/Vertical Field of View`. **Confirmed genuinely populated** in real sample data (a sub-degree reading during a zoomed-in shot, not a stub) — this is what lets draping account for the sensor actually zooming in and out mid-flight, unlike a fixed-FOV camera. Left blank for any packet where the source data didn't include it, rather than guessed. |
| `targetLon`, `targetLat`, `targetElevation` | The ground target's own position (WGS84 degrees / metres) — from MISB's `Target Location Latitude/Longitude/Elevation`. This is what `yaw`/`pitch` above are derived from; a consuming app can also use it directly to re-derive pointing angle AFTER interpolating between sparse samples (see the note on sparse packets below), which a stored angle can't do correctly on its own. |

If every packet in a run is missing an optional column (currently `fovX`/`fovY`/`targetLon`/`targetLat`/
`targetElevation` are treated as optional), the CLI says so plainly in its summary output at the end — a
genuinely absent field is meant to be obvious immediately, not discovered later by scrolling through a CSV
full of blanks.

**A note on sparse packets and interpolation**: real MISB streams can carry KLV packets many seconds apart
(the real sample has gaps up to 98 seconds). A consuming app that linearly interpolates `yaw`/`pitch`
between two sparse samples is implicitly assuming the sensor swept smoothly between two angles — correct
for a platform flying straight and level with a fixed gimbal angle, but wrong whenever the platform is
orbiting a fixed target (the real sample's own scenario: `targetLon`/`targetLat` are constant across all 6
packets while the aircraft circles it). In that case, interpolating the *target position* (which barely
moves) alongside the sensor's own position, then re-deriving bearing/depression at each interpolated
timestamp, tracks reality far better than interpolating the stored angle directly.

## What this tool deliberately does NOT do

- **Load anything into an app.** The output `video.json`'s `"variant": "stanag-4609"` isn't consumable by any
  app yet — that needs a matching decoder on the consuming side, which is separate, later work. This tool
  only has to produce the right *shape*.
- **Full rotation-matrix angle composition.** See the `yaw`/`pitch`/`roll` schema note above.
- **Handle any KLV standard other than ST 0601.** `@vidterra/misb.js` also supports ST 0902/0806/0904;
  this tool only asks it to decode ST 0601, the one that actually carries position/orientation/FOV.
