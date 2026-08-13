// CSV byte-decoding pipeline (PLAN.md §6 "Parse"): BOM sniff first, then
// strict UTF-8 with a windows-1252 fallback — Excel legacy exports deliver
// curly apostrophes ("Ja'Marr" arrives as 0x92) that are invalid UTF-8.

export type CsvEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export interface DecodedCsv {
  text: string;
  encoding: CsvEncoding;
}

export function decodeCsvBuffer(buf: ArrayBuffer): DecodedCsv {
  const bytes = new Uint8Array(buf);

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: strip(new TextDecoder("utf-8").decode(bytes.subarray(3))), encoding: "utf-8" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: strip(new TextDecoder("utf-16le").decode(bytes.subarray(2))), encoding: "utf-16le" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: strip(new TextDecoder("utf-16be").decode(bytes.subarray(2))), encoding: "utf-16be" };
  }

  try {
    return { text: strip(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), encoding: "utf-8" };
  } catch {
    return { text: strip(new TextDecoder("windows-1252").decode(bytes)), encoding: "windows-1252" };
  }
}

/** Defensive: a double-BOM'd file still carries U+FEFF after byte-level strip.
 * (Cell-level residual-BOM stripping happens again in headers.ts cleanCell.) */
function strip(text: string): string {
  return text.replace(/^﻿/, "");
}
