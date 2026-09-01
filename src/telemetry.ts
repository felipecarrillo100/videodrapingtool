/**
 * Maps decoded ST 0601 packets to our own clean, minimal telemetry row shape — the actual contract this
 * whole tool exists to nail down empirically. Column names deliberately don't mimic MISB's own tag
 * numbering or the `"dji"` variant's own DJI-specific CSV columns (`ascent(feet)`, `gimbal_heading
 * (degrees)`, ...) — this is a NEW variant, free to define its own clean shape, per the "define our own
 * normalized schema" direction settled before building this tool.
 *
 * Confirmed present and populated in the real sample (`samples/day-flight.mpg`): Precision Time Stamp,
 * Sensor Latitude/Longitude/True Altitude, Sensor Horizontal/Vertical Field of View (0.365°/0.206° in
 * that sample — genuinely populated, not a stub), Platform Heading/Pitch/Roll, Sensor Relative
 * Azimuth/Elevation/Roll, and Target Location Latitude/Longitude/Elevation.
 */
import { numericField, type St0601Packet } from "./klv.js";

export interface TelemetryRow {
  readonly timestampMs: number;
  readonly lon: number;
  readonly lat: number;
  readonly height: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  readonly fovX: number | undefined;
  readonly fovY: number | undefined;
  readonly targetLon: number | undefined;
  readonly targetLat: number | undefined;
  readonly targetElevation: number | undefined;
}

function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS_METRES = 6371000;

/** Initial compass bearing from point 1 to point 2, degrees, 0-360, clockwise from north — the standard
 * spherical bearing formula. Verified this session against the sensor's own on-screen HUD `LOS` readout
 * (e.g. `046°`) across all 6 real packets in `samples/day-flight.mpg`, matching to within ~0.05°. */
function bearingDegrees(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = lat1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return wrap360(Math.atan2(y, x) * RAD2DEG);
}

/** Great-circle ground distance between two points, metres — spherical (haversine), not full ellipsoidal
 * geodesy. Verified this session to match MISB's own reported `Ground Range` within <1% at the ~2-11km
 * ranges in the real sample; ellipsoidal precision isn't needed at that scale. */
function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = lat1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const dPhi = phi2 - phi1;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(a));
}

/** Bearing/depression from the sensor to a ground point, degrees — the shared geometry both
 * position-based branches of `deriveYawPitch` below reduce to. */
function bearingAndPitchTo(
  sensorLat: number,
  sensorLon: number,
  sensorAlt: number,
  groundLat: number,
  groundLon: number,
  groundElevation: number,
): { yaw: number; pitch: number } {
  const yaw = bearingDegrees(sensorLat, sensorLon, groundLat, groundLon);
  const groundDistance = haversineMetres(sensorLat, sensorLon, groundLat, groundLon);
  const heightDiff = sensorAlt - groundElevation;
  const pitch = -Math.atan2(heightDiff, groundDistance) * RAD2DEG;
  return { yaw, pitch };
}

/**
 * What draping actually needs is where the camera points in absolute terms. ST 0601 reports this several
 * ways, in decreasing order of reliability: `Target Location Latitude/Longitude/Elevation` (an explicitly
 * lased/cued ground point), `Frame Center Latitude/Longitude/Elevation` (the platform's own computed
 * boresight/nadir ground intersection), or `Platform Heading/Pitch/Roll` + `Sensor Relative
 * Azimuth/Elevation/Roll` (attitude composed with the gimbal's offset, no ground point at all).
 *
 * The two position-based branches share the same bearing/depression geometry (`bearingAndPitchTo` above)
 * against `Sensor Latitude/Longitude/True Altitude` — confirmed against `samples/day-flight.mpg`'s own
 * on-screen HUD. In fact, in both `day-flight.mpg` and `night-flight-ir.mpg`, every single packet's
 * `Target Location Latitude` is bit-for-bit identical to its own `Frame Center Latitude` — this test data
 * only ever fills Target Location by copying Frame Center, so treating Frame Center as an equally valid
 * ground point (when Target Location itself is absent) isn't a new source of error, just recognizing a
 * source ST 0601 already exposes under a different tag.
 *
 * The real customer file (`EGMAFADKLVlI_VIDEO_From_FlyAway-0.ts`) has zero Target Location packets, but
 * DOES report Frame Center on every packet — so it takes the Frame Center branch, not the attitude
 * fallback. This matters because the attitude-composition fallback (`platformHeading + sensorRelAzimuth`)
 * has its own measurable error: cross-checked against that file's own Frame Center geometry at 6 sample
 * points, composed pitch matched within ~1° but composed yaw was off by up to ~11°, and the error tracked
 * `Platform Roll Angle` (~10° yaw error when roll was ~6.5°, <2° error when roll was under 1.5°) — exactly
 * what skipping the roll term in a rotation composition would produce. Frame Center's direct geometry
 * sidesteps that; the attitude fallback is now truly a last resort for a packet with neither ground point.
 */
function deriveYawPitch(packet: St0601Packet): { yaw: number; pitch: number } {
  const sensorLat = numericField(packet, "Sensor Latitude") ?? 0;
  const sensorLon = numericField(packet, "Sensor Longitude") ?? 0;
  const sensorAlt = numericField(packet, "Sensor True Altitude") ?? 0;

  const targetLat = numericField(packet, "Target Location Latitude");
  const targetLon = numericField(packet, "Target Location Longitude");
  if (targetLat !== undefined && targetLon !== undefined) {
    const targetElevation = numericField(packet, "Target Location Elevation") ?? 0;
    return bearingAndPitchTo(sensorLat, sensorLon, sensorAlt, targetLat, targetLon, targetElevation);
  }

  const frameCenterLat = numericField(packet, "Frame Center Latitude");
  const frameCenterLon = numericField(packet, "Frame Center Longitude");
  if (frameCenterLat !== undefined && frameCenterLon !== undefined) {
    const frameCenterElevation = numericField(packet, "Frame Center Elevation") ?? 0;
    return bearingAndPitchTo(sensorLat, sensorLon, sensorAlt, frameCenterLat, frameCenterLon, frameCenterElevation);
  }

  // No ground point at all on this packet — compose platform attitude with the sensor's own relative
  // offset, same convention `roll` already uses unconditionally below. Plain addition, not a full DCM
  // rotation composition (see this function's own doc comment for why that's a known source of yaw error
  // when roll is non-trivial) — kept simple since no real dataset on hand actually reaches this branch.
  const platformHeading = numericField(packet, "Platform Heading Angle") ?? 0;
  const platformPitch = numericField(packet, "Platform Pitch Angle") ?? 0;
  const sensorRelAzimuth = numericField(packet, "Sensor Relative Azimuth Angle") ?? 0;
  const sensorRelElevation = numericField(packet, "Sensor Relative Elevation Angle") ?? 0;
  return {
    yaw: wrap360(platformHeading + sensorRelAzimuth),
    pitch: platformPitch + sensorRelElevation, // signed, not wrapped — matches the position-based path's own pitch convention
  };
}

/** A packet with no reported position isn't a telemetry sample at all — it's an auxiliary ST 0601 packet
 * (`Mission ID`, `Security Local Set`, ...) that happens to share a timestamp with a real one. Real
 * customer streams (`EGMAFADKLVlI_VIDEO_From_FlyAway-0.ts`) interleave these every ~10s; treating them as
 * telemetry rows previously produced `lat=0, lon=0` samples (from this file's own `?? 0` defaulting) that
 * the app-side interpolator would briefly glide through as a real position. Filtering on field presence
 * (not packet "type") means any future non-positional packet type is handled the same way, with no new
 * special case needed. */
export function isPositionalPacket(packet: St0601Packet): boolean {
  return numericField(packet, "Sensor Latitude") !== undefined && numericField(packet, "Sensor Longitude") !== undefined;
}

/** One row per (positional) packet, timestamps normalized so the FIRST packet is `timestampMs: 0` —
 * matching the `"dji"` variant's own CSV convention (a relative offset, not a UNIX epoch value) exactly,
 * so the app-side decoder pattern this eventually feeds transfers directly. */
export function buildTelemetryRows(packets: readonly St0601Packet[]): TelemetryRow[] {
  const positional = packets.filter(isPositionalPacket);
  const rawTimestamps = positional.map((p) => numericField(p, "Precision Time Stamp") ?? 0);
  const firstTimestampUs = rawTimestamps[0] ?? 0;

  return positional.map((packet, i) => {
    const { yaw, pitch } = deriveYawPitch(packet);
    const platformRoll = numericField(packet, "Platform Roll Angle") ?? 0;
    const sensorRelRoll = numericField(packet, "Sensor Relative Roll Angle") ?? 0;
    return {
      timestampMs: (rawTimestamps[i]! - firstTimestampUs) / 1000,
      lon: numericField(packet, "Sensor Longitude") ?? 0,
      lat: numericField(packet, "Sensor Latitude") ?? 0,
      height: numericField(packet, "Sensor True Altitude") ?? 0,
      yaw,
      pitch,
      roll: wrap360(platformRoll + sensorRelRoll),
      fovX: numericField(packet, "Sensor Horizontal Field of View"),
      fovY: numericField(packet, "Sensor Vertical Field of View"),
      targetLon: numericField(packet, "Target Location Longitude"),
      targetLat: numericField(packet, "Target Location Latitude"),
      targetElevation: numericField(packet, "Target Location Elevation"),
    };
  });
}

/** Which of our own columns came back completely empty across the WHOLE file — surfaced to the CLI's
 * own summary output so a genuinely missing field is visible immediately, not discovered later by
 * someone staring at a CSV full of blanks. */
export function findAllEmptyColumns(rows: readonly TelemetryRow[]): readonly string[] {
  const optionalColumns: readonly (keyof TelemetryRow)[] = ["fovX", "fovY", "targetLon", "targetLat", "targetElevation"];
  return optionalColumns.filter((col) => rows.every((row) => row[col] === undefined));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Median of angles that may straddle the 0°/360° boundary — same shortest-signed-delta idea the CLIENT's
 * own `lerpAngle` (packages/ria/.../videopanorama.ts) already uses for interpolation, applied here to a
 * median instead of a lerp. Un-wraps every value in the window relative to `centerValue` before taking a
 * plain numeric median, then wraps the result back — avoids the naive-median failure mode where e.g.
 * [359, 1, 0.5, 358, 2] would numerically sort to a median near 180°, the farthest possible point from the
 * real cluster. */
function circularMedian(values: readonly number[], centerValue: number): number {
  const deltas = values.map((v) => (((v - centerValue) % 360) + 540) % 360 - 180);
  return wrap360(centerValue + median(deltas));
}

export interface SmoothAnglesResult {
  readonly rows: readonly TelemetryRow[];
  readonly windowSamples: number;
  readonly nominalSpacingMs: number;
}

/**
 * `Sensor Latitude/Longitude` and `Frame Center Latitude/Longitude` (see `deriveYawPitch` above) are
 * independently-sampled onboard values, each held/repeated between their own real updates, on cadences
 * that aren't in phase with each other — confirmed directly against a real customer file
 * (`EGMAFADKLVlI_VIDEO_From_FlyAway-0.ts`): `Frame Center` updates ~40ms offset from `Sensor Latitude`'s
 * own update boundary. Since `deriveYawPitch` recomputes the bearing between them fresh on every packet,
 * every time one field updates before the other catches up there's a brief window where the bearing
 * swings away from the true trend then swings back the instant both have updated — a real, ~5Hz
 * "beating" baked directly into the derived `yaw`/`pitch`, confirmed visually in the drape and numerically
 * in the CSV (e.g. `196.368° → 196.904° → 196.779°`, up then back down, every ~200ms).
 *
 * `roll` doesn't need this (computed differently — unconditional `platformRoll + sensorRelRoll`, no
 * cross-field staggering in this data) and neither does position (`lat`/`lon`/`height` are a straight
 * passthrough of one held field each, so they only ever step forward in a clean staircase, never reverse)
 * — scoped to exactly what's been diagnosed as broken, not applied defensively everywhere.
 *
 * `windowMs <= 0` is a no-op passthrough — the CLI's explicit disable path, and also what a file with too
 * few rows to filter degrades to. Otherwise `windowMs` is converted to an odd sample count using THIS
 * file's own median real sample spacing, so the same `windowMs` means the same real time span regardless
 * of a source's native packet rate. */
export function smoothAngles(rows: readonly TelemetryRow[], windowMs: number): SmoothAnglesResult {
  if (rows.length < 3 || windowMs <= 0) return { rows, windowSamples: 1, nominalSpacingMs: 0 };

  const deltas = rows.slice(1).map((r, i) => r.timestampMs - rows[i]!.timestampMs).filter((d) => d > 0);
  const nominalSpacingMs = deltas.length > 0 ? median(deltas) : 20;
  let windowSamples = Math.round(windowMs / nominalSpacingMs);
  if (windowSamples % 2 === 0) windowSamples += 1; // median needs an odd, well-defined middle element
  windowSamples = Math.max(1, Math.min(windowSamples, rows.length % 2 === 0 ? rows.length - 1 : rows.length));
  if (windowSamples <= 1) return { rows, windowSamples: 1, nominalSpacingMs };

  const half = (windowSamples - 1) / 2;
  const smoothed = rows.map((row, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(rows.length - 1, i + half);
    const windowRows = rows.slice(lo, hi + 1);
    return {
      ...row,
      yaw: circularMedian(windowRows.map((r) => r.yaw), row.yaw),
      pitch: median(windowRows.map((r) => r.pitch)),
    };
  });
  return { rows: smoothed, windowSamples, nominalSpacingMs };
}

export interface CollapseHeldPositionResult {
  readonly rows: readonly TelemetryRow[];
  readonly droppedCount: number;
}

/**
 * `Sensor Latitude/Longitude/True Altitude` only genuinely update roughly every ~227ms in the real
 * customer file — the raw KLV just repeats the last known value, bit-for-bit, for the packets in between
 * (confirmed: held values repeat identically, not approximately). Writing one row per packet regardless
 * makes the client's interpolator think a real update just happened every 20ms, so it renders "frozen" for
 * ~200ms then crams the whole real displacement into the one genuine 20ms transition — a ~10x-too-fast
 * burst, confirmed across the whole file (89.7% of steps frozen, the rest averaging 10x real speed).
 *
 * Collapses consecutive rows whose `lat`/`lon`/`height` are ALL exactly unchanged from the previous KEPT
 * row down to just the first occurrence of each distinct value — the same "sparse real samples, real
 * gaps" shape `day-flight.mpg`'s own 6-packet file already has, which the client's interpolation already
 * handles correctly (its own comments note real gaps up to 98 seconds). Scoped to position only, same
 * "only touch what's diagnosed as broken" reasoning as `smoothAngles` — `yaw`/`pitch`/`roll`/`fovX`/`fovY`
 * on a dropped row are discarded along with it, which is fine: those signals already interpolate/smooth
 * acceptably at coarser sampling (the same day/night files this reasoning cites have only 6/18 total
 * samples for their ENTIRE flight and already track correctly).
 */
export function collapseHeldPosition(rows: readonly TelemetryRow[]): CollapseHeldPositionResult {
  if (rows.length === 0) return { rows, droppedCount: 0 };
  const kept: TelemetryRow[] = [rows[0]!];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const last = kept[kept.length - 1]!;
    if (row.lat === last.lat && row.lon === last.lon && row.height === last.height) continue;
    kept.push(row);
  }
  return { rows: kept, droppedCount: rows.length - kept.length };
}
