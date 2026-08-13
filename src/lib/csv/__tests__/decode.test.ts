import { describe, expect, it } from "vitest";
import { decodeCsvBuffer } from "../decode";

function buf(...parts: (number[] | Uint8Array)[]): ArrayBuffer {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p instanceof Uint8Array ? p : Uint8Array.from(p), off);
    off += p.length;
  }
  return out.buffer;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function utf16le(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

function utf16be(s: string): Uint8Array {
  const le = utf16le(s);
  for (let i = 0; i < le.length; i += 2) {
    const t = le[i];
    le[i] = le[i + 1];
    le[i + 1] = t;
  }
  return le;
}

const CSV = "Player,Team\nJosh Allen,BUF\n";

describe("decodeCsvBuffer", () => {
  it("decodes plain UTF-8 without a BOM", () => {
    const { text, encoding } = decodeCsvBuffer(buf(utf8(CSV)));
    expect(encoding).toBe("utf-8");
    expect(text).toBe(CSV);
  });

  it("strips a UTF-8 BOM", () => {
    const { text, encoding } = decodeCsvBuffer(buf([0xef, 0xbb, 0xbf], utf8(CSV)));
    expect(encoding).toBe("utf-8");
    expect(text).toBe(CSV);
  });

  it("strips a doubled UTF-8 BOM (residual U+FEFF)", () => {
    const { text } = decodeCsvBuffer(buf([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf], utf8(CSV)));
    expect(text).toBe(CSV);
  });

  it("decodes UTF-16LE via its BOM", () => {
    const { text, encoding } = decodeCsvBuffer(buf([0xff, 0xfe], utf16le(CSV)));
    expect(encoding).toBe("utf-16le");
    expect(text).toBe(CSV);
  });

  it("decodes UTF-16BE via its BOM", () => {
    const { text, encoding } = decodeCsvBuffer(buf([0xfe, 0xff], utf16be(CSV)));
    expect(encoding).toBe("utf-16be");
    expect(text).toBe(CSV);
  });

  it("keeps valid UTF-8 curly apostrophes as UTF-8", () => {
    const s = "Ja’Marr Chase,CIN\n";
    const { text, encoding } = decodeCsvBuffer(buf(utf8(s)));
    expect(encoding).toBe("utf-8");
    expect(text).toBe(s);
  });

  it("falls back to windows-1252 for Excel-legacy curly apostrophes", () => {
    // "Ja’Marr Chase,CIN" with the 0x92 right single quote — invalid UTF-8
    const bytes = [0x4a, 0x61, 0x92, 0x4d, 0x61, 0x72, 0x72, 0x20, 0x43, 0x68, 0x61, 0x73, 0x65, 0x2c, 0x43, 0x49, 0x4e];
    const { text, encoding } = decodeCsvBuffer(buf(bytes));
    expect(encoding).toBe("windows-1252");
    expect(text).toBe("Ja’Marr Chase,CIN");
  });
});
