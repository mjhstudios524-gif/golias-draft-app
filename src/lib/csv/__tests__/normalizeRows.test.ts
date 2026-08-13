import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import { decodeCsvBuffer } from "../decode";
import { detectHeaderRow, detectMapping, type ColumnMapping } from "../headers";
import {
  computeDataTier,
  mappingErrors,
  normalizeRows,
  parsePosCell,
} from "../normalizeRows";

const parse = (text: string): string[][] =>
  Papa.parse<string[]>(text, { header: false, skipEmptyLines: "greedy" }).data;

function pipeline(text: string) {
  const rows = parse(text);
  const headerRowIndex = detectHeaderRow(rows);
  const { mapping } = detectMapping(rows, headerRowIndex);
  return { rows, headerRowIndex, mapping };
}

const FTN = `Rank,Player,Pos,Team,Bye,ADP
1,Ja'Marr Chase,WR,CIN,10,1.2
2,Bijan Robinson,RB,ATL,5,2.4
3,Broncos,DST,DEN,10,
4,Kyler Murray,QB,ARZ,14,88.5
5,Ravens,DST,BLT,13,`;

describe("normalizeRows — FTN-style fixture", () => {
  const { rows, headerRowIndex, mapping } = pipeline(FTN);
  const out = normalizeRows(rows, mapping, headerRowIndex);

  it("keeps every data row with the raw name preserved", () => {
    expect(out.map((r) => r.rawName)).toEqual([
      "Ja'Marr Chase", "Bijan Robinson", "Broncos", "Kyler Murray", "Ravens",
    ]);
  });

  it("canonicalizes legacy team codes (ARZ/BLT -> ARI/BAL)", () => {
    expect(out[3].team).toBe("ARI");
    expect(out[4].team).toBe("BAL");
    expect(out[0].team).toBe("CIN");
  });

  it("maps DST to the DEF position for nickname defenses", () => {
    expect(out[2].pos).toBe("DEF");
    expect(out[4].pos).toBe("DEF");
  });

  it("coerces blank ADP to null and keeps numeric ADP", () => {
    expect(out[2].adp).toBeNull();
    expect(out[3].adp).toBe(88.5);
  });

  it("carries bye weeks through, cleaned name alongside rawName", () => {
    expect(out.map((r) => r.byeWeek)).toEqual([10, 5, 10, 14, 13]);
    expect(out[0].name).toBe("Ja'Marr Chase");
  });

  it("computes RANK_ONLY tier for a rank/no-points file", () => {
    expect(computeDataTier(mapping)).toBe("RANK_ONLY");
    expect(out[0].rank).toBe(1);
    expect(out[4].rank).toBe(5);
  });

  it("numbers sourceRow 1-based including the header row", () => {
    expect(out[0].sourceRow).toBe(2);
    expect(out[4].sourceRow).toBe(6);
  });
});

const FP_ECR = `"RK","TIERS","PLAYER NAME","TEAM","POS","BYE WEEK","SOS SEASON","ECR VS. ADP"
"1","1","Ja'Marr Chase","CIN","WR1","10","3 out of 5 stars","0"
"2","1","Bijan Robinson","ATL","RB1","5","3 out of 5 stars","0"
"3","1","Justin Jefferson","MIN","WR2","6","4 out of 5 stars","+1"`;

describe("normalizeRows — combined FantasyPros pos column", () => {
  const { rows, headerRowIndex, mapping } = pipeline(FP_ECR);
  const out = normalizeRows(rows, mapping, headerRowIndex);

  it("splits WR1 into pos + posRank", () => {
    expect(out[0].pos).toBe("WR");
    expect(out[0].posRank).toBe(1);
    expect(out[2].pos).toBe("WR");
    expect(out[2].posRank).toBe(2);
  });
});

const FP_PROJ = `Player,Team,ATT,CMP,YDS,TDS,INTS,ATT,YDS,TDS,REC,YDS,TDS,FL,FPTS
Josh Allen,BUF,540,367,4300,29,14,120,530,12,0,0,0,3,378.2
Patrick Mahomes,KC,"580","401","4,821",31,11,60,310,3,-,-,-,2,371.9`;

describe("normalizeRows — FP projections (duplicate headers, coercion)", () => {
  const { rows, headerRowIndex, mapping } = pipeline(FP_PROJ);
  const out = normalizeRows(rows, mapping, headerRowIndex);

  it("computes FULL_STATS tier", () => {
    expect(computeDataTier(mapping)).toBe("FULL_STATS");
  });

  it("builds a Sleeper-keyed stat line per row", () => {
    expect(out[0].stats).toEqual({
      pass_att: 540, pass_cmp: 367, pass_yd: 4300, pass_td: 29, pass_int: 14,
      rush_att: 120, rush_yd: 530, rush_td: 12,
      rec: 0, rec_yd: 0, rec_td: 0,
      fum_lost: 3,
    });
    expect(out[0].projPoints).toBe(378.2);
  });

  it("strips thousands separators and treats '-' as null", () => {
    expect(out[1].stats?.pass_yd).toBe(4821);
    expect(out[1].stats?.rec).toBeUndefined();
    expect(out[1].stats?.rec_yd).toBeUndefined();
  });
});

describe("normalizeRows — bye coercion", () => {
  it("nulls out-of-range bye weeks (valid range 1-18)", () => {
    const rows = parse(`Player,Bye
Josh Allen,7
Lamar Jackson,0
Bijan Robinson,19
Jahmyr Gibbs,-`);
    const out = normalizeRows(rows, ["name", "bye"], 0);
    expect(out.map((r) => r.byeWeek)).toEqual([7, null, null, null]);
  });
});

describe("normalizeRows — row hygiene", () => {
  it("skips empty-name rows and mid-file repeated headers", () => {
    const text = `Rank,Player,Team,Pos
1,Josh Allen,BUF,QB
,,,
Rank,Player,Team,Pos
2,Lamar Jackson,BAL,QB`;
    const { rows, headerRowIndex, mapping } = pipeline(text);
    const out = normalizeRows(rows, mapping, headerRowIndex);
    expect(out.map((r) => r.rawName)).toEqual(["Josh Allen", "Lamar Jackson"]);
  });

  it("offsets sourceRow past preamble rows", () => {
    const text = `My Draft Cheat Sheet
Generated 2026-08-10

Rank,Player,Team,Pos
1,Josh Allen,BUF,QB
2,Lamar Jackson,BAL,QB`;
    const { rows, headerRowIndex, mapping } = pipeline(text);
    expect(headerRowIndex).toBe(2);
    const out = normalizeRows(rows, mapping, headerRowIndex);
    expect(out[0].sourceRow).toBe(4);
    expect(out[1].sourceRow).toBe(5);
  });

  it("round-trips windows-1252 curly apostrophes into rawName", () => {
    // "Rank,Player\n1,Ja’Marr Chase" with the 0x92 curly apostrophe
    const bytes = Uint8Array.from([
      0x52, 0x61, 0x6e, 0x6b, 0x2c, 0x50, 0x6c, 0x61, 0x79, 0x65, 0x72, 0x0a,
      0x31, 0x2c, 0x4a, 0x61, 0x92, 0x4d, 0x61, 0x72, 0x72, 0x20, 0x43, 0x68, 0x61, 0x73, 0x65,
    ]);
    const { text } = decodeCsvBuffer(bytes.buffer);
    const rows = parse(text);
    const out = normalizeRows(rows, ["rank", "name"], 0);
    expect(out[0].rawName).toBe("Ja’Marr Chase");
  });
});

describe("computeDataTier / mappingErrors", () => {
  it("tiers: rank -> RANK_ONLY, points -> POINTS, >=3 stats -> FULL_STATS", () => {
    expect(computeDataTier(["name", "rank"])).toBe("RANK_ONLY");
    expect(computeDataTier(["name", "points"])).toBe("POINTS");
    expect(computeDataTier(["name", "rank", "points"])).toBe("POINTS");
    expect(computeDataTier(["name", "rush_yd", "rush_td", "rec"])).toBe("FULL_STATS");
    expect(computeDataTier(["name", "points", "rush_yd", "rush_td", "rec"])).toBe("FULL_STATS");
  });

  it("two stat columns are not FULL_STATS", () => {
    const m: ColumnMapping = ["name", "rush_yd", "rush_td"];
    expect(computeDataTier(m)).toBeNull();
    expect(mappingErrors(m)).toHaveLength(1);
  });

  it("requires a name column and at least one tier source", () => {
    expect(mappingErrors([null, null])).toHaveLength(2);
    expect(mappingErrors(["name", "rank"])).toHaveLength(0);
  });
});

describe("parsePosCell", () => {
  it("handles combined and plain position spellings", () => {
    expect(parsePosCell("WR1")).toEqual({ pos: "WR", posRank: 1 });
    expect(parsePosCell("qb12")).toEqual({ pos: "QB", posRank: 12 });
    expect(parsePosCell("DST")).toEqual({ pos: "DEF", posRank: null });
    expect(parsePosCell("D/ST")).toEqual({ pos: "DEF", posRank: null });
    expect(parsePosCell("PK")).toEqual({ pos: "K", posRank: null });
    expect(parsePosCell("TE")).toEqual({ pos: "TE", posRank: null });
    expect(parsePosCell("linebacker")).toEqual({ pos: null, posRank: null });
    expect(parsePosCell("")).toEqual({ pos: null, posRank: null });
  });
});
