/**
 * Thin wrapper around `misb.js`'s own `klv.decode` scanner (see `misb.d.ts` for why this needed a local
 * type declaration, and its own doc comment for how this was verified against real data). No custom
 * packet-splitting here — the library already does it, and does it more robustly (real BER-length
 * parsing, not an assumption that every packet is the same size the way this sample's packets happen to
 * be).
 */
import { st0601, klv, type Misb0601Field } from "@vidterra/misb.js";

export type St0601Packet = readonly Misb0601Field[];

export function decodeSt0601Packets(klvBytes: Buffer): St0601Packet[] {
  const result = klv.decode(klvBytes, [st0601], null, {});
  return result[st0601.name] ?? [];
}

/** Looks up one tag's numeric value by its exact MISB field name (e.g. `"Sensor Latitude"`) —
 * `undefined` if that packet didn't include the tag at all (not every packet necessarily carries every
 * tag), or if it did but the value wasn't numeric. */
export function numericField(packet: St0601Packet, name: string): number | undefined {
  const field = packet.find((f) => f.name === name);
  return typeof field?.value === "number" ? field.value : undefined;
}
