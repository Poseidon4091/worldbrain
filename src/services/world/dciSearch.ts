import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../utils/logger.js";
import type { SimilarWorldItem } from "../embedding/vectorSearch.js";

const logger = createLogger("world:dciSearch");

const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

// Unicode-aware word boundaries. JS `\b` is ASCII-only, so a name that starts or ends
// with an accented letter ("José", "Émile") would never match — the boundary assertion
// fails on the non-ASCII edge character. These lookarounds treat any Unicode letter or
// number as a word character instead.
const UNI_BOUNDARY_START = "(?<![\\p{L}\\p{N}_])";
const UNI_BOUNDARY_END = "(?![\\p{L}\\p{N}_])";

function wordMatch(term: string, text: string, caseSensitive = false): boolean {
  const escaped = term.replace(REGEX_ESCAPE, "\\$&");
  return new RegExp(`${UNI_BOUNDARY_START}${escaped}${UNI_BOUNDARY_END}`, caseSensitive ? "u" : "iu").test(text);
}

/**
 * Whole-phrase, Unicode-aware, case-insensitive word-boundary match with no token fallback.
 * Use for tag-gating and other exact-trigger checks where a multi-word term must appear in
 * full (tag "fire magic" must NOT fire on a bare "fire"), unlike nameAppearsInText which
 * intentionally falls back to first/last name tokens. Empty/whitespace terms never match.
 */
export function phraseAppearsInText(term: string, text: string): boolean {
  if (!term || !text) return false;
  const t = normalizeApostrophes(term).trim();
  if (!t) return false;
  return wordMatch(t.toLowerCase(), normalizeApostrophes(text));
}

/**
 * Tag-trigger match: like phraseAppearsInText but tolerant of a trailing plural/possessive
 * suffix, so a tag "notebook" still fires on "notebooks"/"notebook's" and "reform" on "reforms".
 * A leading word boundary is still required, so "art" does NOT fire on "start" or "artist".
 *
 * This restores the inflection matches lost when tag-gating moved from raw substring `.includes()`
 * to strict word-boundary matching — strict boundaries silently stopped tag-gated worlds from
 * triggering on plural references, leaving their content out of the prompt.
 */
export function tagAppearsInText(tag: string, text: string): boolean {
  if (!tag || !text) return false;
  const t = normalizeApostrophes(tag).trim();
  if (!t) return false;
  const escaped = t.toLowerCase().replace(REGEX_ESCAPE, "\\$&");
  const re = new RegExp(`${UNI_BOUNDARY_START}${escaped}(?:'s|es|s)?${UNI_BOUNDARY_END}`, "iu");
  return re.test(normalizeApostrophes(text));
}

// LLM prose uses typographic apostrophes ("Viktor’s", "D’Artagnan") while entity names
// usually carry straight ones — normalize both sides so they can't mismatch.
const normalizeApostrophes = (s: string) => s.replace(/[‘’]/g, "'");

// First tokens that are articles/honorifics/titles, not actual first names.
// Without this, "The Burrow" would match every message containing "the".
const FIRST_TOKEN_STOPWORDS = new Set([
  "the",
  "old",
  "new",
  "van",
  "von",
  "der",
  "den",
  "des",
  "la",
  "le",
  "los",
  "las",
  "del",
  "mr",
  "mrs",
  "ms",
  "dr",
  "sir",
  "lady",
  "lord",
  "miss",
  "madam",
  "madame",
  "professor",
  "captain",
  "general",
  "king",
  "queen",
  "prince",
  "princess",
  "saint",
  "st",
]);

// Name tokens that are also everyday English words. Measured on a realistic prose corpus,
// these produced a 7.6% false-positive rate under case-insensitive matching ("the black
// cat" → Sirius Black, "will you come" → Will Turner). For these tokens only, require the
// capitalized form in the text — a name in prose is capitalized, a common noun/verb isn't.
// Residual risk (sentence-start "Will the storm...") is accepted; unambiguous tokens like
// "viktor" stay case-insensitive so lowercase-typed messages still match.
const AMBIGUOUS_ENGLISH_WORDS = new Set([
  "will",
  "mark",
  "rose",
  "jack",
  "grace",
  "summer",
  "faith",
  "max",
  "ash",
  "hope",
  "dawn",
  "june",
  "august",
  "autumn",
  "winter",
  "ivy",
  "lily",
  "daisy",
  "violet",
  "hazel",
  "amber",
  "ruby",
  "pearl",
  "crystal",
  "melody",
  "harmony",
  "destiny",
  "joy",
  "love",
  "honey",
  "star",
  "sky",
  "rain",
  "storm",
  "snow",
  "river",
  "brook",
  "brooks",
  "rivers",
  "wolf",
  "fox",
  "hunter",
  "black",
  "white",
  "brown",
  "green",
  "gray",
  "grey",
  "wood",
  "woods",
  "stone",
  "steel",
  "silver",
  "gold",
  "bishop",
  "knight",
  "page",
  "dean",
  "duke",
  "earl",
  "marshall",
  "major",
  "art",
  "bill",
  "buck",
  "chip",
  "chase",
  "chance",
  "cliff",
  "colt",
  "dale",
  "don",
  "drew",
  "frank",
  "grant",
  "gene",
  "glen",
  "hank",
  "heath",
  "holly",
  "iris",
  "jasmine",
  "lane",
  "may",
  "mercy",
  "olive",
  "opal",
  "penny",
  "ray",
  "reed",
  "robin",
  "rowan",
  "sage",
  "victor",
  "wade",
  "sunny",
  "misty",
  "sandy",
  "rusty",
  "young",
]);

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

// Match a single name token: ambiguous English words must appear capitalized in the text;
// everything else matches case-insensitively.
function tokenMatch(tokenLower: string, text: string): boolean {
  if (AMBIGUOUS_ENGLISH_WORDS.has(tokenLower)) {
    return wordMatch(capitalize(tokenLower), text, true);
  }
  return wordMatch(tokenLower, text);
}

/**
 * Returns true if `name` appears in `text` as a standalone word (or sequence of words).
 *
 * Uses word-boundary matching, not raw substring inclusion, so:
 *   - entity "Ron" does NOT match "baron" / "iron" / "neuron"
 *   - entity "Joe" does NOT match "Joey" / "Joel"
 *
 * For multi-word names (e.g. "Viktor Krum"), also tests the first and last tokens alone:
 *   - first token at ≥3 chars — first names are the dominant reference form in RP
 *     ("Viktor smiled", "Ron grinned"); word boundaries already block substring hits
 *   - last token at ≥4 chars — catches surname-only references ("Krum spoke") while
 *     avoiding risky short surnames like "Lee" / "Wu" / "Ng" that collide with prose
 */
export function nameAppearsInText(name: string, text: string): boolean {
  if (!name || !text) return false;
  // Trim: checkpoint names can carry stray whitespace which breaks both the boundary
  // regex (spaces in the pattern) and token splitting (empty first/last tokens).
  const nameLower = normalizeApostrophes(name).trim().toLowerCase();
  if (nameLower.length < 3) return false;
  const textNorm = normalizeApostrophes(text);

  const tokens = nameLower.split(/\s+/);

  // Single-token names go through tokenMatch so ambiguous ones ("Rose") require capitals.
  if (tokens.length === 1) return tokenMatch(nameLower, textNorm);

  // Multi-word full-name match stays case-insensitive — the full phrase is unambiguous.
  if (wordMatch(nameLower, textNorm)) return true;

  const first = tokens[0];
  if (first && first.length >= 3 && !FIRST_TOKEN_STOPWORDS.has(first) && tokenMatch(first, textNorm)) {
    return true;
  }

  const last = tokens[tokens.length - 1];
  if (last && last.length >= 4 && tokenMatch(last, textNorm)) return true;

  return false;
}

/**
 * Identifies world entities whose names (or aliases/nicknames) appear in the given text
 * as standalone words. Used to determine which entities deserve full detail in the extractor
 * context, to drive DCI resurfacing, and to refresh recency.
 *
 * Matches on the canonical name OR any alias, but always reports the CANONICAL name — so a
 * nickname ("Mione") resolves to the real entity ("Hermione Granger") for downstream DCI
 * lookup (which keys on the canonical name) and recency stamping.
 *
 * See nameAppearsInText for matching semantics.
 */
export function extractMentionedEntities(text: string, checkpoint: any): Array<{ name: string; type: string }> {
  if (!text || !checkpoint) return [];

  const mentioned: Array<{ name: string; type: string }> = [];

  const check = (entity: any, type: string) => {
    const name = entity?.name;
    if (!name) return;
    const aliases: string[] = Array.isArray(entity?.aliases) ? entity.aliases : [];
    if (nameAppearsInText(name, text) || aliases.some((a) => a && nameAppearsInText(a, text))) {
      mentioned.push({ name, type });
    }
  };

  for (const c of checkpoint.characters ?? []) check(c, "character");
  for (const l of checkpoint.locations ?? []) check(l, "location");
  for (const i of checkpoint.items ?? []) check(i, "item");
  for (const k of checkpoint.knowledge ?? []) check(k, "knowledge");
  for (const e of checkpoint.events ?? []) check(e, "event");

  return mentioned;
}

/**
 * Formats world entities for the extractor system prompt with DCI-aware prioritization.
 *
 * Strategy:
 *   - Core entities → always rendered in full (they always matter)
 *   - Entities mentioned in this conversation turn → rendered in full
 *   - Everything else → brief one-liner (name + type + importance)
 *
 * This eliminates the hard 10,000-char truncation. The extractor gets complete data
 * for entities relevant to this extraction turn and lightweight stubs for the rest,
 * so nothing falls off the edge of a character limit.
 */
export function formatEntitiesForExtraction(checkpoint: any, mentionedNames: Set<string>): string {
  if (!checkpoint) return "None yet";

  const lines: string[] = [];
  const isMentioned = (name: string | undefined | null) => !!name && mentionedNames.has(name.toLowerCase());

  for (const c of checkpoint.characters ?? []) {
    const full = c.importance === "core" || isMentioned(c.name);
    if (full) {
      const rels = Object.entries(c.relationships || {})
        .map(([n, d]) => `${n}:${d}`)
        .join(", ");
      const recentFacts = (c.witnessed_facts || []).slice(-15).join("; ");
      const aliasStr = (c.aliases || []).length ? ` [AKA: ${(c.aliases || []).join(", ")}]` : "";
      lines.push(
        `${c.name} (${c.importance || "supporting"})${aliasStr} [Status: ${c.status || "None"}] [Traits: ${(c.traits || []).join(", ")}] [Rels: ${rels}] [Witnessed: ${recentFacts}]: ${c.blurb}`,
      );
    } else {
      lines.push(`${c.name} (${c.importance || "supporting"}) [Status: ${c.status || "None"}] — character`);
    }
  }

  for (const l of checkpoint.locations ?? []) {
    const full = l.importance === "core" || isMentioned(l.name);
    if (full) {
      lines.push(`[LOC] ${l.name} [Traits: ${(l.traits || []).join(", ")}]: ${l.blurb}`);
    } else {
      lines.push(`[LOC] ${l.name} (${l.importance || "supporting"}) — location`);
    }
  }

  for (const i of checkpoint.items ?? []) {
    const full = i.importance === "core" || isMentioned(i.name);
    if (full) {
      lines.push(`[ITEM] ${i.name} [Traits: ${(i.traits || []).join(", ")}]: ${i.blurb}`);
    } else {
      lines.push(`[ITEM] ${i.name} (${i.importance || "supporting"}) — item`);
    }
  }

  for (const k of checkpoint.knowledge ?? []) {
    const full = k.importance === "core" || isMentioned(k.name);
    lines.push(full ? `[KNOWLEDGE] ${k.name}: ${k.blurb}` : `[KNOWLEDGE] ${k.name} — knowledge`);
  }

  for (const e of checkpoint.events ?? []) {
    const full = e.importance === "core" || isMentioned(e.name);
    lines.push(full ? `[EVENT] ${e.name}: ${e.blurb}` : `[EVENT] ${e.name} — event`);
  }

  return lines.join("\n") || "None yet";
}

/**
 * DCI exact-match lookup: queries the world_items table by entity name.
 *
 * The `key` column in world_items stores the entity name verbatim (set by
 * itemSync.ts). A case-insensitive exact match on `key` guarantees
 * 100% recall for proper nouns that may fall below the vector similarity threshold
 * (unusual spellings, non-English names, short names with weak embeddings).
 *
 * Returns items shaped as SimilarWorldItem so they can be appended directly
 * to the hybridSearch result list in buildPrompt.ts.
 */
export async function dciLookupByNames(
  db: PrismaClient,
  worldIds: string[],
  names: string[],
  alreadyRetrievedKeys: Set<string> = new Set(),
): Promise<(SimilarWorldItem & { hybridScore: number })[]> {
  if (worldIds.length === 0 || names.length === 0) return [];

  // Trim to match itemSync, which stores keys as `String(entity.name).trim()` —
  // a whitespace-padded checkpoint name would otherwise never hit its own item row.
  const uniqueLower = [...new Set(names.map((n) => n.trim().toLowerCase()))].filter(
    (n) => n.length >= 3 && !alreadyRetrievedKeys.has(n),
  );

  if (uniqueLower.length === 0) return [];

  try {
    const rows = await db.$queryRawUnsafe<
      Array<{
        id: string;
        key: string;
        type: string;
        content: string;
        worldId: string;
        importanceScore: number;
        embeddingModel: string | null;
        canonBook: number | null;
        canonChapter: number | null;
        createdAt: Date;
      }>
    >(
      `
      SELECT id, key, type, content, "worldId", "importanceScore",
             "embeddingModel", "canonBook", "canonChapter", "createdAt"
      FROM world_items
      WHERE "worldId" = ANY($1::text[])
        AND lower(key) = ANY($2::text[])
      `,
      worldIds,
      uniqueLower,
    );

    logger.debug("DCI exact-match lookup", {
      queriedNames: uniqueLower.length,
      hits: rows.length,
    });

    return rows.map((row) => ({
      ...row,
      similarity: 1.0,
      hybridScore: 1.0,
    }));
  } catch (err) {
    logger.warn("DCI name lookup query failed", { err });
    return [];
  }
}

/**
 * Convenience wrapper used by buildPrompt.ts:
 * Scans all active world checkpoints to find entity names mentioned in the
 * user message, then runs dciLookupByNames to fetch their full DB records.
 *
 * Only returns items that weren't already retrieved by hybridSearch
 * (deduplication by lowercase key).
 */
export async function dciAugmentRetrievedItems(
  db: PrismaClient,
  userMessage: string,
  worldIds: string[],
  checkpoints: any[],
  alreadyRetrievedKeys: Set<string>,
): Promise<(SimilarWorldItem & { hybridScore: number })[]> {
  if (!userMessage || worldIds.length === 0 || checkpoints.length === 0) return [];

  const mentionedNames: string[] = [];
  for (const cp of checkpoints) {
    if (!cp) continue;
    const mentioned = extractMentionedEntities(userMessage, cp);
    mentionedNames.push(...mentioned.map((e) => e.name));
  }

  if (mentionedNames.length === 0) return [];

  return dciLookupByNames(db, worldIds, mentionedNames, alreadyRetrievedKeys);
}
