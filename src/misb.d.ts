/**
 * `@vidterra/misb.js` ships no TypeScript types and is plain CommonJS (no `"type": "module"` in its own
 * package.json, no `.d.ts` anywhere in the published package — confirmed by reading it directly, not
 * assumed). This is a minimal ambient declaration for exactly the shapes this project actually uses,
 * verified against real parsed output from `samples/day-flight.mpg`'s own KLV track — not the library's
 * full surface (it also exports st0102/st0104/st0806/st0903, unused here).
 */
declare module "@vidterra/misb.js" {
  /** One decoded MISB tag from an ST 0601 packet — e.g. `{ key: 16, name: "Sensor Horizontal Field of
   * View", value: 0.365, unit: "°" }`. `value` is a plain number for every numeric tag seen so far;
   * string for the few textual ones (`Image Source Sensor`, `Image Coordinate System`). */
  export interface Misb0601Field {
    readonly key: number;
    readonly name: string;
    readonly value: number | string;
    readonly unit?: string;
  }

  export const st0601: {
    readonly name: "st0601";
    readonly key: Buffer;
    parse(hex: string, options?: { readonly debug?: boolean }): Misb0601Field[];
  };

  interface Standard {
    readonly name: string;
    readonly key: Buffer;
  }

  export const klv: {
    /** Scans `data` for every occurrence of any given standard's key, decodes each match, and returns
     * one array per standard name. Verified live: finds all 6 real packets in
     * `samples/day-flight.mpg`'s extracted KLV track in one call, matching `ffprobe`'s own independent
     * packet count exactly — handles BER length parsing itself, no manual packet-splitting needed. */
    decode(
      data: Buffer | string,
      standards: readonly Standard[],
      callback: null,
      options?: { readonly debug?: boolean; readonly complete?: boolean },
    ): Record<string, Misb0601Field[][]>;
  };
}
