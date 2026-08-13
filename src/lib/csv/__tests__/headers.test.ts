import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import {
  detectHeaderRow,
  detectMapping,
  headerFingerprint,
} from "../headers";

const parse = (text: string): string[][] =>
  Papa.parse<string[]>(text, { header: false, skipEmptyLines: "greedy" }).data;

// FantasyPros ECR export: combined POS column ("WR1"), star-rating noise cols.
const FP_ECR = `"RK","TIERS","PLAYER NAME","TEAM","POS","BYE WEEK","SOS SEASON","ECR VS. ADP"
"1","1","Ja'Marr Chase","CIN","WR1","10","3 out of 5 stars","0"
"2","1","Bijan Robinson","ATL","RB1","5","3 out of 5 stars","0"
"3","1","Justin Jefferson","MIN","WR2","6","4 out of 5 stars","+1"
"4","1","Saquon Barkley","PHI","RB2","9","3 out of 5 stars","-1"
"5","2","Jahmyr Gibbs","DET","RB3","8","3 out of 5 stars","0"`;

// FantasyPros projections export: header:true would clobber the repeated
// YDS/TDS/ATT — group inference must resolve them positionally.
const FP_PROJ = `Player,Team,ATT,CMP,YDS,TDS,INTS,ATT,YDS,TDS,REC,YDS,TDS,FL,FPTS
Josh Allen,BUF,540,367,4300,29,14,120,530,12,0,0,0,3,378.2
Bijan Robinson,ATL,0,0,0,0,0,310,1450,13,58,431,2,1,289.5`;

const FP_PROJ_RB = `Player,Team,ATT,YDS,TDS,REC,YDS,TDS,FL,FPTS
Bijan Robinson,ATL,310,1450,13,58,431,2,1,289.5
Jahmyr Gibbs,DET,270,1280,11,64,517,3,2,271.0`;

// FTN-style: legacy team codes, nickname DSTs, blank ADP cells.
const FTN = `Rank,Player,Pos,Team,Bye,ADP
1,Ja'Marr Chase,WR,CIN,10,1.2
2,Bijan Robinson,RB,ATL,5,2.4
3,Broncos,DST,DEN,10,
4,Kyler Murray,QB,ARZ,14,88.5
5,Ravens,DST,BLT,13,`;

const PREAMBLE = `My Draft Cheat Sheet
Generated 2026-08-10

Rank,Player,Team,Pos
1,Josh Allen,BUF,QB
2,Lamar Jackson,BAL,QB`;

const TSV = "Rank\tPlayer\tTeam\tPos\n1\tJosh Allen\tBUF\tQB\n2\tBijan Robinson\tATL\tRB";

const HEADERLESS = `1,Ja'Marr Chase,CIN,WR
2,Bijan Robinson,ATL,RB
3,Justin Jefferson,MIN,WR
4,Saquon Barkley,PHI,RB`;

describe("detectHeaderRow", () => {
  it("finds the first row with >=2 known header cells", () => {
    expect(detectHeaderRow(parse(FP_ECR))).toBe(0);
    expect(detectHeaderRow(parse(FP_PROJ))).toBe(0);
    expect(detectHeaderRow(parse(FTN))).toBe(0);
  });

  it("skips preamble rows (blank lines dropped by skipEmptyLines)", () => {
    const rows = parse(PREAMBLE);
    expect(rows[2][0]).toBe("Rank");
    expect(detectHeaderRow(rows)).toBe(2);
  });

  it("handles TSV via PapaParse delimiter auto-detection", () => {
    const rows = parse(TSV);
    expect(rows[0]).toEqual(["Rank", "Player", "Team", "Pos"]);
    expect(detectHeaderRow(rows)).toBe(0);
  });

  it("returns null for headerless files (fully-manual mode)", () => {
    expect(detectHeaderRow(parse(HEADERLESS))).toBeNull();
  });
});

describe("detectMapping — header regexes", () => {
  it("maps the FantasyPros ECR layout, leaving noise columns unmapped", () => {
    const rows = parse(FP_ECR);
    const { mapping, confidence } = detectMapping(rows, 0);
    expect(mapping).toEqual(["rank", null, "name", "team", "pos", "bye", null, null]);
    expect(confidence[0]).toBe("high");
    expect(confidence[2]).toBe("high");
    expect(confidence[4]).toBe("high");
    expect(confidence[1]).toBe("none");
  });

  it("maps FTN-style headers including the bye column", () => {
    const { mapping } = detectMapping(parse(FTN), 0);
    expect(mapping).toEqual(["rank", "name", "pos", "team", "bye", "adp"]);
  });
});

describe("detectMapping — FantasyPros duplicate-group inference", () => {
  it("resolves the classic pass/rush/rec layout positionally", () => {
    const { mapping, confidence } = detectMapping(parse(FP_PROJ), 0);
    expect(mapping).toEqual([
      "name", "team",
      "pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int",
      "rush_att", "rush_yd", "rush_td",
      "rec", "rec_yd", "rec_td",
      "fum_lost", "points",
    ]);
    // anchors are exact header matches; group members are inferred
    expect(confidence[3]).toBe("high");
    expect(confidence[2]).toBe("medium");
    expect(confidence[8]).toBe("medium");
    expect(confidence[11]).toBe("medium");
  });

  it("resolves an RB-only export (no passing group)", () => {
    const { mapping } = detectMapping(parse(FP_PROJ_RB), 0);
    expect(mapping).toEqual([
      "name", "team",
      "rush_att", "rush_yd", "rush_td",
      "rec", "rec_yd", "rec_td",
      "fum_lost", "points",
    ]);
  });

  it("never guesses: an INTS column without CMP leaves ATT/YDS/TDS unmapped", () => {
    const orphanInts = `Player,Team,ATT,YDS,TDS,INTS,FPTS
Josh Allen,BUF,540,4300,29,14,378.2`;
    const { mapping } = detectMapping(parse(orphanInts), 0);
    expect(mapping[2]).toBeNull();
    expect(mapping[3]).toBeNull();
    expect(mapping[4]).toBeNull();
    expect(mapping[5]).toBe("pass_int");
    expect(mapping[6]).toBe("points");
  });

  it("never guesses: two leftover YDS with no anchors stay unmapped", () => {
    const twoRuns = `Player,Team,YDS,TDS,YDS,TDS
A B,BUF,100,1,200,2`;
    const { mapping } = detectMapping(parse(twoRuns), 0);
    expect(mapping.slice(2)).toEqual([null, null, null, null]);
  });
});

describe("detectMapping — value sniffing (headerless / manual mode)", () => {
  it("sniffs rank, name, team, and pos from the first data rows", () => {
    const rows = parse(HEADERLESS);
    const { mapping, confidence } = detectMapping(rows, null);
    expect(mapping).toEqual(["rank", "name", "team", "pos"]);
    expect(confidence).toEqual(["medium", "medium", "medium", "medium"]);
  });

  it("does not sniff rank from non-monotonic integer columns (bye weeks)", () => {
    const rows = parse(`Josh Allen,BUF,7
Bijan Robinson,ATL,5
Justin Jefferson,MIN,6`);
    const { mapping } = detectMapping(rows, null);
    expect(mapping[2]).toBeNull();
    expect(mapping[0]).toBe("name");
    expect(mapping[1]).toBe("team");
  });

  it("recognizes legacy team codes through the alias map", () => {
    const rows = parse(`1,Kyler Murray,ARZ
2,Lamar Jackson,BLT
3,C.J. Stroud,HST`);
    const { mapping } = detectMapping(rows, null);
    expect(mapping[2]).toBe("team");
  });
});

describe("headerFingerprint", () => {
  it("is stable across case/whitespace variants", async () => {
    const a = await headerFingerprint(["RK", "PLAYER NAME", "TEAM"]);
    const b = await headerFingerprint([" rk ", "Player  Name", "team"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the header signature changes", async () => {
    const a = await headerFingerprint(["RK", "PLAYER NAME"]);
    const b = await headerFingerprint(["RK", "PLAYER NAME", "TEAM"]);
    expect(a).not.toBe(b);
  });

  it("strips a residual BOM from the first cell", async () => {
    const a = await headerFingerprint(["﻿Rank", "Player"]);
    const b = await headerFingerprint(["Rank", "Player"]);
    expect(a).toBe(b);
  });
});
