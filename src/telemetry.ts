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

/**
 * What draping actually needs is where the camera points in absolute terms. ST 0601 reports this two
 * different ways: `Platform Heading/Pitch/Roll` + `Sensor Relative Azimuth/Elevation/Roll` (attitude
 * composed with the gimbal's offset), or `Sensor Latitude/Longitude/True Altitude` +
 * `Target Location Latitude/Longitude/Elevation` (two independent positions).
 *
 * This tool used to compose the angle triples (first via plain addition, then via full DCM rotation
 * composition) — both wrong on this tool's own real sample. Extracting real video frames and reading the
 * sensor's own on-screen HUD directly (`ffmpeg -ss <t> -frames:v 1`, then comparing against the printed
 * `LOS` bearing/range) proved the angle-composition approach was never going to work for this file: the
 * HUD's own `LOS` bearing matches raw `Sensor Relative Azimuth Angle` ALONE (platform heading plays no
 * role at all), and the geometrically-required depression angle didn't match any composition of
 * `Platform Pitch`/`Sensor Relative Elevation Angle` either — the residual error was real and systematic,
 * not noise, across all 6 real packets.
 *
 * The position-based path sidesteps the whole question: `Sensor Latitude/Longitude/True Altitude` and
 * `Target Location Latitude/Longitude/Elevation` are both independently reliable (confirmed against the
 * HUD's printed aircraft/target coordinates), so `yaw`/`pitch` can be computed directly as the
 * bearing/depression angle from one to the other — no angle composition needed. Falls back to the
 * (less-trustworthy, since it's what we know is wrong for THIS file, but at least self-contained) relative
 * angle fields only when a packet doesn't report target location at all.
 */
function deriveYawPitch(packet: St0601Packet): { yaw: number; pitch: number } {
  const sensorLat = numericField(packet, "Sensor Latitude") ?? 0;
  const sensorLon = numericField(packet, "Sensor Longitude") ?? 0;
  const sensorAlt = numericField(packet, "Sensor True Altitude") ?? 0;
  const targetLat = numericField(packet, "Target Location Latitude");
  const targetLon = numericField(packet, "Target Location Longitude");
  const targetElevation = numericField(packet, "Target Location Elevation");

  if (targetLat !== undefined && targetLon !== undefined) {
    const yaw = bearingDegrees(sensorLat, sensorLon, targetLat, targetLon);
    const groundDistance = haversineMetres(sensorLat, sensorLon, targetLat, targetLon);
    const heightDiff = sensorAlt - (targetElevation ?? 0);
    const pitch = -Math.atan2(heightDiff, groundDistance) * RAD2DEG;
    return { yaw, pitch };
  }

  // No target location on this packet — fall back to the relative angle fields directly. `azimuth alone`
  // is proven right for this file's own convention (see doc comment above); `elevation alone` is an
  // unverified best-effort guess, not independently checked against anything, since every packet in our
  // real sample DOES report target location and never exercises this branch.
  const sensorRelAzimuth = numericField(packet, "Sensor Relative Azimuth Angle") ?? 0;
  const sensorRelElevation = numericField(packet, "Sensor Relative Elevation Angle") ?? 0;
  return { yaw: wrap360(sensorRelAzimuth), pitch: sensorRelElevation };
}

/** One row per packet, timestamps normalized so the FIRST packet is `timestampMs: 0` — matching the
 * `"dji"` variant's own CSV convention (a relative offset, not a UNIX epoch value) exactly, so the
 * app-side decoder pattern this eventually feeds transfers directly. */
export function buildTelemetryRows(packets: readonly St0601Packet[]): TelemetryRow[] {
  const rawTimestamps = packets.map((p) => numericField(p, "Precision Time Stamp") ?? 0);
  const firstTimestampUs = rawTimestamps[0] ?? 0;

  return packets.map((packet, i) => {
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
