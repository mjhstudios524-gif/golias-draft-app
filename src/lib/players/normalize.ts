// Player-name normalizer (PLAN.md §6). ONE shared implementation: it runs
// client-side for mapper preview match rates and server-side for the
// authoritative match — results must be identical, so it lives outside
// src/server. The output convention deliberately matches Sleeper's
// search_full_name (lowercase alphanumerics only) so seeded keys align.

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

export interface NormalizedName {
  /** lowercase alphanumerics only, suffix stripped: "D'Andre Swift" → "dandreswift" */
  nameKey: string;
  /** stripped suffix token, if any: "jr" | "sr" | "ii" | ... */
  suffix: string | null;
}

export function normalizeName(raw: string): NormalizedName {
  let s = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining marks (diacritics)
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'") // curly/modifier apostrophes → ascii
    .replace(/\s+/g, " ") // the source data itself has "Keenan  Allen"
    .trim();

  // strip a word-final suffix token (allowing a trailing period: "Jr.")
  let suffix: string | null = null;
  const words = s.split(" ");
  if (words.length > 1) {
    const last = words[words.length - 1].replace(/\.$/, "");
    if (SUFFIXES.has(last)) {
      suffix = last;
      words.pop();
      s = words.join(" ");
    }
  }

  return { nameKey: s.replace(/[^a-z0-9]/g, ""), suffix };
}

/** Alias keys for a team defense (PLAN.md §6 DST branch): every naming variant
 * a rankings CSV plausibly uses, normalized through the same normalizer. */
export function dstAliasKeys(city: string, nickname: string, code: string): string[] {
  const variants = [
    nickname, // "Broncos"
    city, // "Denver"
    `${city} ${nickname}`, // "Denver Broncos"
    `${city} D/ST`,
    `${code} DST`,
    `${code} D/ST`,
    code,
    `${nickname} D/ST`,
    `${nickname} DST`,
    `${nickname} Defense`,
    `${city} Defense`,
  ];
  return [...new Set(variants.map((v) => normalizeName(v).nameKey))];
}
