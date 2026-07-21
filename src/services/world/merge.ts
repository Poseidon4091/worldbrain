import { RELATED_ENTRIES_MAX } from "../../config/limits.js";
/**
 * merge.ts
 *
 * Server-side merge logic for Lorekeeper delta updates.
 * Handles: deduplication (fuzzy name match), importance promotion,
 * chronology append, and safe merging without ever deleting existing entries.
 */

export interface WorldEntity {
  name: string;
  blurb: string;
  importance: "core" | "middle" | "minor";
  status?: string;
  tags?: string[];
  traits?: string[];
  tombstonedTraits?: string[]; // Traits the user explicitly removed — LLM may never re-add these
  relationships?: Record<string, string>;
  witnessed_facts?: string[];
  fixedContent?: string;
  /** Alternate names / nicknames this entity is referred to by (e.g. "Mione" for Hermione).
   *  Used by mention detection + DCI so a nickname resurfaces the canonical entity. */
  aliases?: string[];
  /** Exposure log: things this character has already experienced (e.g. "muggle_tech:soda_fountain").
   *  Injected so they react with familiarity instead of first-time wonder on repeat encounters. */
  exposure_tags?: string[];
  /** Extraction sequence at which this entity was last active (mentioned/updated/present).
   *  Populated by lifecycle.stampRecency. Consumed by the bounded-memory lifecycle
   *  (chronology rollup / entity dormancy) to decide what has gone cold. */
  lastSeenTurn?: number;
}

export interface WorldDelta {
  add: WorldEntity[];
  update: WorldEntity[];
  /** MICRO: Discrete narrative beats/events */
  new_memories?: WorldEntity[];
  /** MACRO: Rolling 'Story Thus Far' */
  narrative_summary?: string;
  chronology_entry?: {
    timestamp?: string;
    summary: string;
    key_events?: string[];
  };
  chronology_entries?: Array<{
    timestamp?: string;
    summary: string;
    key_events?: string[];
  }>;
  scene?: {
    location: string;
    present_characters: string[];
    activity: string;
    mood: string;
  };
  new_rules?: Array<{ name: string; blurb: string; tags?: string[]; importance?: string }>;
  new_plot_threads?: Array<{ title: string; status: string }>;
  atmosphere?: string;
  world_laws?: string[];
}

export interface WorldCheckpoint {
  characters: WorldEntity[];
  locations: WorldEntity[];
  items: WorldEntity[];
  rules: Array<{ name: string; blurb: string; tags?: string[]; importance?: string }>;
  plot_threads: Array<{ title: string; status: string }>;
  chronology: Array<{ timestamp?: string; summary: string; key_events: string[]; present_characters?: string[] }>;
  /** Rolling compressed breadcrumb of chronology beats that have been pruned from the active
   *  `chronology` array to keep it bounded. Full detail of pruned beats remains retrievable via
   *  RAG (they're embedded as chronology world_items). Maintained by lifecycle.rollupChronology. */
  chronology_archive?: string;
  knowledge?: WorldEntity[];
  events?: WorldEntity[];
  /** Macro-summary: Story Thus Far */
  summary?: string;
  /** Micro-memories: Specific beats */
  memories?: WorldEntity[];
  scene?: { location: string; present_characters: string[]; activity: string; mood: string };
  atmosphere?: string;
  world_laws?: string[];
  /** Monotonic extraction counter, incremented once per persisted extraction pass.
   *  The unit of "recency" for the bounded-memory lifecycle (see WorldEntity.lastSeenTurn). */
  _extractionSeq?: number;
}

/**
 * Ensures any text wrapped in [[FIXED]] ... [[/FIXED]] tags in the existing blurb
 * is preserved in the incoming blurb. If the incoming blurb lacks the block,
 * we prepend it to prevent deletion.
 */
function enforceFixedBlocks(existing: string, incoming: string): string {
  const regex = /\[\[(.+?)\]\]/gs;
  const blocks: string[] = [];
  let match;
  while ((match = regex.exec(existing)) !== null) {
    blocks.push(match[0]);
  }

  if (blocks.length === 0) return incoming;

  let result = incoming;
  for (const block of blocks) {
    if (!result.includes(block)) {
      result = block + "\n\n" + result;
    }
  }
  return result;
}

const IMPORTANCE_RANK: Record<string, number> = { core: 3, middle: 2, minor: 1 };

/** Normalize a name for fuzzy comparison: lowercase, strip punctuation, collapse spaces */
export function normalizeName(name?: string): string {
  if (!name) return "";
  // 1. Basic normalization: toLower, strip non-alphanumeric, collapse spaces
  const norm = name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Strip SillyTavern / card-import prefixes that the LLM sometimes uses as entity names
  // e.g. "Character Card — Hermione Jean Granger" → "hermione jean granger"
  return norm.replace(/^character\s+card\s+/i, "").trim();
}

/** Simple Levenshtein distance for short strings (names) */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Build dp table with explicit number[][] (no undefined)
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = [];
    for (let j = 0; j <= n; j++) {
      if (i === 0) dp[i]![j] = j;
      else if (j === 0) dp[i]![j] = i;
      else dp[i]![j] = 0;
    }
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = dp[i - 1]![j]! + 1;
      const ins = dp[i]![j - 1]! + 1;
      const sub = dp[i - 1]![j - 1]! + cost;
      dp[i]![j] = Math.min(del, ins, sub);
    }
  }

  return dp[m]![n]!;
}

/**
 * Finds an existing entity in the list that fuzzy-matches the given name.
 * Returns index or -1 if no match found.
 */
function findFuzzyMatch(list: WorldEntity[], name: string): number {
  if (!name) return -1;
  const norm = normalizeName(name);
  if (!norm) return -1;

  // Pass 1: exact normalized match (e.g. "Harry Potter" === "harry potter")
  for (let i = 0; i < list.length; i++) {
    if (normalizeName(list[i]!.name) === norm) return i;
  }

  // Pass 2: fuzzy Levenshtein (only for names ≥8 chars to prevent short name collisions)
  // Distance of 1 allows for minor typos (e.g. "Hermionee" vs "Hermione")
  if (norm.length >= 8) {
    for (let i = 0; i < list.length; i++) {
      const listNorm = normalizeName(list[i]!.name);
      if (listNorm.length >= 8 && levenshtein(norm, listNorm) <= 1) return i;
    }
  }

  // Pass 3: First-name/token match — handles "Harry" matching "Harry Potter" and vice versa.
  // Split both names into tokens and check if one is a prefix subset of the other.
  //
  // Collect ALL candidates rather than returning the first. A bare first name that prefixes
  // two DIFFERENT entities (incoming "Harry" when both "Harry Potter" and "Harry Osborn" exist)
  // is ambiguous — silently merging into whichever appears first would fuse two distinct
  // characters. In that case we bail (-1) and let the caller insert it as its own entity.
  const normTokens = norm.split(" ");
  const prefixMatches: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const listNorm = normalizeName(list[i]!.name);
    const listTokens = listNorm.split(" ");
    // Only match if the shorter name's tokens are all present at the START of the longer name
    // e.g. "harry" matches "harry potter" but "potter" alone won't match "harry potter"
    const [shorter, longer] =
      normTokens.length <= listTokens.length ? [normTokens, listTokens] : [listTokens, normTokens];
    if (shorter.length >= 1 && longer.slice(0, shorter.length).join(" ") === shorter.join(" ")) {
      prefixMatches.push(i);
    }
  }
  if (prefixMatches.length === 1) return prefixMatches[0]!;
  if (prefixMatches.length > 1) {
    // Only merge if every candidate is the SAME normalized name (real duplicates in the list).
    // Distinct fuller names → genuinely ambiguous → don't guess.
    const distinct = new Set(prefixMatches.map((i) => normalizeName(list[i]!.name)));
    return distinct.size === 1 ? prefixMatches[0]! : -1;
  }

  // Pass 4: Substring check — incoming name is fully contained in existing name or vice versa
  // Guards against "Fleur Delacour" vs "Fleur" and similar truncations. Same ambiguity guard.
  const substringMatches: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const listNorm = normalizeName(list[i]!.name);
    // Only allow this if the shorter name is at least 4 chars to avoid false positives
    const shorter = norm.length < listNorm.length ? norm : listNorm;
    const longer = norm.length < listNorm.length ? listNorm : norm;
    if (shorter.length >= 4 && longer.startsWith(shorter + " ")) substringMatches.push(i);
  }
  if (substringMatches.length === 1) return substringMatches[0]!;
  if (substringMatches.length > 1) {
    const distinct = new Set(substringMatches.map((i) => normalizeName(list[i]!.name)));
    return distinct.size === 1 ? substringMatches[0]! : -1;
  }

  return -1;
}

/**
 * Promote importance only — never demote.
 * e.g. minor -> middle is allowed, middle -> minor is ignored.
 */
function promoteImportance(
  current: WorldEntity["importance"],
  incoming: WorldEntity["importance"],
): WorldEntity["importance"] {
  const currentRank = IMPORTANCE_RANK[current] ?? 1;
  const incomingRank = IMPORTANCE_RANK[incoming] ?? 1;
  return incomingRank > currentRank ? incoming : current;
}

/**
 * Merges two tag lists with case-insensitive deduplication and a cap of TAG_CAP tags.
 *
 * The old logic concatenated [current, incoming], deduped first-seen, then kept the first 10.
 * Since established tags always occupied the leading slots, once an entity hit 10 tags NO new
 * tag could ever be added — genuinely new tags landed past index 10 and were sliced off forever.
 *
 * This version protects established tags but reserves a few slots so newly-observed tags can
 * always enter (and become "established" next turn), letting the tag set evolve slowly instead
 * of freezing.
 */
function mergeTags(current: string[] = [], incoming: string[] = []): string[] {
  if (incoming.length === 0) return current;

  const TAG_CAP = 10;
  const RESERVE_FOR_NEW = 3; // slots always available to brand-new incoming tags

  const dedupe = (tags: string[], skip?: Set<string>): { tags: string[]; norms: Set<string> } => {
    const norms = new Set<string>();
    const out: string[] = [];
    for (const tag of tags) {
      const normalized = tag.toLowerCase().trim();
      if (normalized && !norms.has(normalized) && !skip?.has(normalized)) {
        norms.add(normalized);
        out.push(tag.trim());
      }
    }
    return { tags: out, norms };
  };

  const established = dedupe(current);
  const incomingNew = dedupe(incoming, established.norms).tags; // incoming tags not already present

  const combined = [...established.tags, ...incomingNew];
  if (combined.length <= TAG_CAP) return combined;

  // Over cap: keep established tags but guarantee room for a few new ones so the set isn't frozen.
  const reserve = Math.min(incomingNew.length, RESERVE_FOR_NEW);
  const keepEstablished = established.tags.slice(0, TAG_CAP - reserve);
  const keepNew = incomingNew.slice(0, reserve);
  return [...keepEstablished, ...keepNew];
}

/**
 * Unions alias/nickname lists across extractions: case-insensitive dedupe, drops any alias that
 * equals the canonical name (redundant), and hard-caps to avoid unbounded growth. Established
 * aliases are kept first; new ones append.
 */
function mergeAliases(current: string[] = [], incoming: string[] = [], canonicalName?: string): string[] {
  const ALIAS_CAP = 12;
  const seen = new Set<string>();
  if (canonicalName) seen.add(canonicalName.toLowerCase().trim());
  const out: string[] = [];
  for (const alias of [...current, ...incoming]) {
    const normalized = (alias ?? "").toLowerCase().trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(alias.trim());
    }
  }
  return out.slice(0, ALIAS_CAP);
}

/**
 * Unions exposure-log tags across extractions. Exposures accumulate (a character never
 * "un-experiences" something), so this is a straight case-insensitive union with a generous
 * cap; when over the cap the OLDEST are dropped (a character's most recent experiences are
 * the ones most likely to still shape their reactions).
 */
function mergeExposureTags(current: string[] = [], incoming: string[] = []): string[] {
  const EXPOSURE_CAP = 40;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...current, ...incoming]) {
    const normalized = (tag ?? "").toLowerCase().trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(tag.trim());
    }
  }
  return out.length > EXPOSURE_CAP ? out.slice(out.length - EXPOSURE_CAP) : out;
}

/**
 * Finds an existing relationship key that fuzzy-matches the incoming key.
 * Handles: "Ron Weasley" vs "Ronald Bilius Weasley", "Hermione Jean Granger" vs "Hermione Jean Granger (5th Year)", etc.
 * Returns the canonical existing key, or null if no match.
 */
function findFuzzyRelationshipKey(existingKeys: string[], incoming: string): string | null {
  if (!incoming) return null;
  const norm = normalizeName(incoming);
  if (!norm) return null;

  // Pass 1: exact normalized match
  for (const key of existingKeys) {
    if (normalizeName(key) === norm) return key;
  }

  // Pass 2: Levenshtein ≤ 1 (minor typos, names ≥ 8 chars)
  if (norm.length >= 8) {
    for (const key of existingKeys) {
      const keyNorm = normalizeName(key);
      if (keyNorm.length >= 8 && levenshtein(norm, keyNorm) <= 1) return key;
    }
  }

  // Pass 3: prefix token subset — "Harry" matches "Harry Potter", "Hermione Jean Granger" matches "Hermione Jean Granger (5th Year)"
  const normTokens = norm.split(" ");
  for (const key of existingKeys) {
    const keyNorm = normalizeName(key);
    const keyTokens = keyNorm.split(" ");
    const [shorter, longer] = normTokens.length <= keyTokens.length ? [normTokens, keyTokens] : [keyTokens, normTokens];
    if (shorter.length >= 1 && longer.slice(0, shorter.length).join(" ") === shorter.join(" ")) {
      return key;
    }
  }

  // Pass 4: first + last name match — handles "Ron Weasley" vs "Ronald Bilius Weasley"
  // (first token of one is a prefix of the first token of the other, AND last tokens match)
  const normToks = norm.split(" ");
  if (normToks.length >= 2) {
    const normFirst = normToks[0]!;
    const normLast = normToks[normToks.length - 1]!;
    for (const key of existingKeys) {
      const keyNorm = normalizeName(key);
      const keyToks = keyNorm.split(" ");
      if (keyToks.length >= 2) {
        const keyFirst = keyToks[0]!;
        const keyLast = keyToks[keyToks.length - 1]!;
        if (normLast === keyLast && (normFirst.startsWith(keyFirst) || keyFirst.startsWith(normFirst))) {
          return key;
        }
      }
    }
  }

  return null;
}

/**
 * Sanitizes relationships by stripping "add," / "update," prefixes,
 * dropping entirely invalid keys (e.g. nested JSON hallucinated by LLMs),
 * and fuzzy-deduplicating keys so "Ron Weasley" and "Ronald Bilius Weasley"
 * don't create separate entries.
 */
function cleanRelationships(
  current: Record<string, string> = {},
  incoming: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {};

  // Clean current relationships first (self-healing)
  for (const [key, val] of Object.entries(current)) {
    if (!key || typeof key !== "string" || typeof val !== "string") continue;
    if (key.includes("}},") || key.includes(":{")) continue; // Drop bad keys

    let cleanVal = val.trim();
    if (cleanVal.toLowerCase().startsWith("add,")) cleanVal = cleanVal.slice(4).trim();
    if (cleanVal.toLowerCase().startsWith("update,")) cleanVal = cleanVal.slice(7).trim();

    result[key] = cleanVal;
  }

  // Merge incoming relationships — fuzzy-deduplicate keys to avoid Ron/Ronald Weasley duplicates
  for (const [key, val] of Object.entries(incoming)) {
    if (!key || typeof key !== "string" || typeof val !== "string") continue;
    if (key.includes("}},") || key.includes(":{")) continue; // Drop bad keys

    let cleanVal = val.trim();
    if (cleanVal.toLowerCase().startsWith("add,")) cleanVal = cleanVal.slice(4).trim();
    if (cleanVal.toLowerCase().startsWith("update,")) cleanVal = cleanVal.slice(7).trim();

    // Use existing canonical key if one fuzzy-matches, otherwise add as new
    const canonicalKey = findFuzzyRelationshipKey(Object.keys(result), key);
    result[canonicalKey ?? key] = cleanVal;
  }

  return result;
}

/**
 * Merges and cleans traits:
 * - Case-insensitive deduplication
 * - Trims whitespace
 * - Hard cap of 15 items (prioritizing existing/stable traits)
 * - Respects tombstonedTraits: traits the user explicitly removed are never re-added by the LLM
 */
function cleanTraits(current: string[] = [], incoming: string[] = [], tombstoned: string[] = []): string[] {
  const result: string[] = [];
  const fixedRegex = /^\[\[.+\]\]$/;
  // Normalize tombstone list for case-insensitive matching (strip brackets too)
  const tombstonedNorms = new Set(
    tombstoned.map((t) =>
      t
        .replace(/^\[\[|\]\]$/g, "")
        .toLowerCase()
        .trim(),
    ),
  );

  const isTombstoned = (trait: string) => {
    const norm = trait
      .replace(/^\[\[|\]\]$/g, "")
      .toLowerCase()
      .trim();
    return tombstonedNorms.has(norm);
  };

  // Clean current traits first (self-healing) — tombstoned traits are stripped out
  for (const t of current) {
    if (isTombstoned(t)) continue; // User removed this — don't carry it forward
    if (fixedRegex.test(t)) {
      result.push(t);
      continue;
    }
    let trimmed = t.trim();
    if (trimmed.toLowerCase().startsWith("add,")) trimmed = trimmed.slice(4).trim();
    if (trimmed.toLowerCase().startsWith("update,")) trimmed = trimmed.slice(7).trim();
    if (trimmed && !result.includes(trimmed)) result.push(trimmed);
  }

  for (const trait of incoming) {
    const trimmed = trait.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("add,")) {
      const actualTrait = trimmed.slice(4).trim();
      // Never re-add a tombstoned trait even if the LLM tries
      if (
        actualTrait &&
        !isTombstoned(actualTrait) &&
        !result.some((t) => t.toLowerCase() === actualTrait.toLowerCase())
      ) {
        result.push(actualTrait);
      }
    } else if (trimmed.startsWith("remove,")) {
      const actualTrait = trimmed.slice(7).trim();
      if (actualTrait) {
        const idx = result.findIndex((t) => {
          const tNorm = t.toLowerCase();
          const targetNorm = actualTrait.toLowerCase();
          // Never allow removing fixed traits via 'remove,' command
          return tNorm === targetNorm && !fixedRegex.test(t);
        });
        if (idx !== -1) result.splice(idx, 1);
      }
    } else {
      // Legacy behavior: If it's not a delta command, treat it as a suggestive add (deduped)
      const norm = trimmed.toLowerCase();
      if (!isTombstoned(trimmed) && !result.some((t) => t.toLowerCase() === norm)) {
        result.push(trimmed);
      }
    }
  }

  // De-duplicate any accidental repeats and keep fixed traits first
  const seen = new Set<string>();
  const final: string[] = [];

  // Move fixed traits to front
  for (const t of result) {
    if (fixedRegex.test(t.trim())) {
      const norm = t.toLowerCase();
      if (!seen.has(norm)) {
        seen.add(norm);
        final.push(t.trim());
      }
    }
  }

  // Add rest
  for (const t of result) {
    const norm = t.toLowerCase();
    if (!seen.has(norm)) {
      seen.add(norm);
      final.push(t.trim());
    }
  }

  return final.slice(0, RELATED_ENTRIES_MAX);
}

/**
 * Merge add + update delta lists into an existing entity array.
 * - Deduplicates via fuzzy name matching
 * - Promotes importance tier, never demotes
 * - Updates blurb/status when richer info is available
 * - Appends genuinely new entities
 * - Never deletes unmentioned entries
 */
function mergeEntities(
  existing: WorldEntity[],
  toAdd: WorldEntity[],
  toUpdate: WorldEntity[],
): WorldEntity[] {
  const merged: WorldEntity[] = [...existing];

  // Process updates first (targets known existing entries)
  for (const delta of toUpdate) {
    const idx = findFuzzyMatch(merged, delta.name);
    if (idx !== -1) {
      const current = merged[idx]!;
      // AUTHORITATIVE REPLACEMENT: The LLM now provides the full, curated list of traits.
      // We still deduplicate and cap to be safe. Tombstoned traits are never re-added.
      const newTraits = cleanTraits(current.traits, delta.traits, current.tombstonedTraits);
      let incomingBlurb = delta.blurb || current.blurb;

      // The LLM sometimes hallucinates 'add,' or 'update,' prefixes on the blurb itself
      if (incomingBlurb.toLowerCase().startsWith("add,")) incomingBlurb = incomingBlurb.slice(4).trim();
      if (incomingBlurb.toLowerCase().startsWith("update,")) incomingBlurb = incomingBlurb.slice(7).trim();

      let incomingStatus = delta.status ?? current.status;
      if (incomingStatus?.toLowerCase().startsWith("add,")) incomingStatus = incomingStatus.slice(4).trim();
      if (incomingStatus?.toLowerCase().startsWith("update,")) incomingStatus = incomingStatus.slice(7).trim();

      // Death is irreversible — never let a subsequent extraction pass resurrect a character.
      // Flashback passages or alive-Fred passages can fool the LLM into overwriting "Deceased".
      if (
        /\b(dead|deceased|killed|died)\b/i.test(current.status ?? "") &&
        !/\b(dead|deceased|killed|died)\b/i.test(incomingStatus ?? "")
      ) {
        incomingStatus = current.status;
      }

      merged[idx] = {
        name: current.name,
        blurb: enforceFixedBlocks(current.blurb, incomingBlurb),
        status: incomingStatus,
        tags: mergeTags(current.tags, delta.tags),
        aliases: mergeAliases(current.aliases, delta.aliases, current.name),
        exposure_tags: mergeExposureTags(current.exposure_tags, delta.exposure_tags),
        traits: newTraits,
        tombstonedTraits: current.tombstonedTraits, // Always carry forward — user intent is permanent
        relationships: cleanRelationships(current.relationships, delta.relationships),
        witnessed_facts:
          delta.witnessed_facts && Array.isArray(delta.witnessed_facts)
            ? Array.from(new Set([...(current.witnessed_facts || []), ...delta.witnessed_facts]))
            : current.witnessed_facts,
        fixedContent: current.fixedContent,
        importance: promoteImportance(current.importance, delta.importance),
        lastSeenTurn: current.lastSeenTurn,
      };
    } else {
      // Update target doesn't exist yet — treat as add (still clean traits)
      merged.push({ ...delta, traits: cleanTraits([], delta.traits, []) });
    }
  }

  // Process adds — only insert if not already present (dedup)
  for (const entity of toAdd) {
    const idx = findFuzzyMatch(merged, entity.name);
    if (idx === -1) {
      // Genuinely new — add it (clean traits in case LLM used delta syntax)
      merged.push({ ...entity, traits: cleanTraits([], entity.traits, []) });
    } else {
      // Duplicate detected — soft-merge: promote importance, keep richer blurb, authoritative traits
      const current = merged[idx]!;
      const newTraits = cleanTraits(current.traits, entity.traits, current.tombstonedTraits);

      let incomingBlurb = entity.blurb.length > current.blurb.length ? entity.blurb : current.blurb;
      if (incomingBlurb.toLowerCase().startsWith("add,")) incomingBlurb = incomingBlurb.slice(4).trim();
      if (incomingBlurb.toLowerCase().startsWith("update,")) incomingBlurb = incomingBlurb.slice(7).trim();

      let incomingStatus = entity.status ?? current.status;
      if (incomingStatus?.toLowerCase().startsWith("add,")) incomingStatus = incomingStatus.slice(4).trim();
      if (incomingStatus?.toLowerCase().startsWith("update,")) incomingStatus = incomingStatus.slice(7).trim();

      if (
        /\b(dead|deceased|killed|died)\b/i.test(current.status ?? "") &&
        !/\b(dead|deceased|killed|died)\b/i.test(incomingStatus ?? "")
      ) {
        incomingStatus = current.status;
      }

      merged[idx] = {
        name: current.name,
        blurb: enforceFixedBlocks(current.blurb, incomingBlurb),
        status: incomingStatus,
        tags: mergeTags(current.tags, entity.tags),
        aliases: mergeAliases(current.aliases, entity.aliases, current.name),
        exposure_tags: mergeExposureTags(current.exposure_tags, entity.exposure_tags),
        traits: newTraits,
        tombstonedTraits: current.tombstonedTraits, // Always carry forward — user intent is permanent
        importance: promoteImportance(current.importance, entity.importance),
        relationships: cleanRelationships(current.relationships, entity.relationships),
        witnessed_facts:
          entity.witnessed_facts && Array.isArray(entity.witnessed_facts)
            ? Array.from(new Set([...(current.witnessed_facts || []), ...entity.witnessed_facts]))
            : current.witnessed_facts,
        fixedContent: current.fixedContent,
        lastSeenTurn: current.lastSeenTurn,
      };
    }
  }

  // Final sweep: collapse any surviving duplicates that slipped through the merge logic.
  //
  // `seen` maps a first token to ALL result indices that share it — not just one. The old
  // single-index map meant that once two different characters shared a first name (e.g.
  // "Harry Potter" kept canonical for "harry", "Harry Osborn" kept separately), a later
  // duplicate of the SECOND one was compared only against the first and never deduped, so a
  // repeat "Harry Osborn" survived. Tracking every index and matching exact-normalized names
  // first closes that gap.
  const seen = new Map<string, number[]>(); // firstToken -> result indices sharing it
  const result: WorldEntity[] = [];

  const isFuzzyDup = (norm: string, existingNorm: string): boolean => {
    const shorterNorm = norm.length < existingNorm.length ? norm : existingNorm;
    const longerNorm = norm.length < existingNorm.length ? existingNorm : norm;
    if (longerNorm.startsWith(shorterNorm)) return true;
    // Same first + middle name (e.g. "Hermione Jean Granger" vs "Hermione Jean Potter") →
    // almost certainly the same person with a hallucinated surname.
    const normParts = norm.split(" ");
    const existingParts = existingNorm.split(" ");
    return (
      normParts.length >= 2 &&
      existingParts.length >= 2 &&
      normParts[0] === existingParts[0] &&
      normParts[1] === existingParts[1]
    );
  };

  for (const entity of merged) {
    const norm = normalizeName(entity.name);
    if (!norm) {
      result.push(entity);
      continue;
    }

    const firstToken = norm.split(" ")[0]!;
    const candidates = seen.get(firstToken) ?? [];

    // 1. Exact normalized duplicate wins outright — this is what catches a repeated
    //    non-canonical same-first-name entity that the old single-index map missed.
    let targetIdx = candidates.find((idx) => normalizeName(result[idx]!.name) === norm) ?? -1;

    // 2. Otherwise fall back to fuzzy prefix / shared-first-two-token matching. If more than
    //    one DISTINCT entity matches, it's ambiguous (bare "Harry" when both "Harry Potter"
    //    and "Harry Osborn" exist) — keep it separate rather than guessing.
    if (targetIdx === -1) {
      const fuzzy = candidates.filter((idx) => isFuzzyDup(norm, normalizeName(result[idx]!.name)));
      const distinct = new Set(fuzzy.map((idx) => normalizeName(result[idx]!.name)));
      if (distinct.size === 1) targetIdx = fuzzy[0]!;
    }

    if (targetIdx === -1) {
      const newIdx = result.length;
      result.push({ ...entity, importance: entity.importance || "minor" });
      seen.set(firstToken, [...candidates, newIdx]);
      continue;
    }

    // Merge into the matched entry, keeping the longer/more-complete name as canonical.
    const existing = result[targetIdx]!;
    const keepExisting = existing.name.length >= entity.name.length;
    const canonical = keepExisting ? existing : entity;
    const duplicate = keepExisting ? entity : existing;
    result[targetIdx] = {
      name: canonical.name,
      blurb: enforceFixedBlocks(
        canonical.blurb,
        canonical.blurb.length >= duplicate.blurb.length ? canonical.blurb : duplicate.blurb,
      ),
      importance: promoteImportance(canonical.importance, duplicate.importance),
      status: canonical.status ?? duplicate.status,
      tags: mergeTags(canonical.tags, duplicate.tags),
      aliases: mergeAliases(canonical.aliases, duplicate.aliases, canonical.name),
      exposure_tags: mergeExposureTags(canonical.exposure_tags, duplicate.exposure_tags),
      traits: cleanTraits(canonical.traits, duplicate.traits),
      relationships: cleanRelationships(canonical.relationships, duplicate.relationships),
      witnessed_facts: Array.from(
        new Set([...(canonical.witnessed_facts || []), ...(duplicate.witnessed_facts || [])]),
      ),
      fixedContent: canonical.fixedContent ?? duplicate.fixedContent,
      lastSeenTurn:
        canonical.lastSeenTurn === undefined
          ? duplicate.lastSeenTurn
          : duplicate.lastSeenTurn === undefined
            ? canonical.lastSeenTurn
            : Math.max(canonical.lastSeenTurn, duplicate.lastSeenTurn),
    };
  }

  return result;
}

/**
 * Normalize a chronology summary for dedup comparison.
 * Strips markdown bold markers, lowercases, collapses whitespace, and truncates to
 * the first 120 chars — enough to identify the same narrative beat even if the
 * tail wording differs slightly between LLM runs.
 */
function normalizeChronSummary(summary: string): string {
  return summary
    .replace(/\*\*/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 120);
}

/**
 * Returns true if `incoming` is already represented in `existing` chronology.
 * Checks exact prefix match on the first 120 normalized chars.
 */
function isChronologyDuplicate(existing: Array<{ summary: string }>, incoming: { summary: string }): boolean {
  const norm = normalizeChronSummary(incoming.summary);
  if (!norm) return false;
  return existing.some((e) => normalizeChronSummary(e.summary) === norm);
}

/**
 * Apply a Lorekeeper delta to an existing world checkpoint.
 * Returns the new merged checkpoint. Original is not mutated.
 */
export function applyDelta(checkpoint: WorldCheckpoint, delta: WorldDelta): WorldCheckpoint {
  if (!delta) return checkpoint;

  // Split delta entries by entity_type field (cast needed since types come from extractor)
  const allAdd = (delta.add ?? []) as Array<WorldEntity & { entity_type?: string }>;
  const allUpdate = (delta.update ?? []) as Array<WorldEntity & { entity_type?: string }>;

  // Use a helper to check type since the LLM might have used 'type' before our Zod fix
  const isType = (e: any, target: string) => {
    const actualType = e.entity_type || e.type || "character";
    return actualType === target;
  };

  const charAdd = allAdd.filter((e) => e.name && isType(e, "character"));
  const locAdd = allAdd.filter((e) => e.name && isType(e, "location"));
  const itemAdd = allAdd.filter((e) => e.name && isType(e, "item"));
  const knowAdd = allAdd.filter((e) => e.name && isType(e, "knowledge"));
  const eventAdd = allAdd.filter((e) => e.name && isType(e, "event"));

  const charUpd = allUpdate.filter((e) => e.name && isType(e, "character"));
  const locUpd = allUpdate.filter((e) => e.name && isType(e, "location"));
  const itemUpd = allUpdate.filter((e) => e.name && isType(e, "item"));
  const knowUpd = allUpdate.filter((e) => e.name && isType(e, "knowledge"));
  const eventUpd = allUpdate.filter((e) => e.name && isType(e, "event"));

  // Merge rules (dedup by name)
  const newRules = [...(checkpoint.rules ?? [])];
  for (const rule of delta.new_rules ?? []) {
    if (rule.name && !newRules.some((r) => normalizeName(r.name) === normalizeName(rule.name))) {
      newRules.push(rule);
    }
  }

  // Merge plot threads (dedup by title, update status)
  const newThreads = [...(checkpoint.plot_threads ?? [])];
  for (const thread of delta.new_plot_threads ?? []) {
    if (!thread.title) continue;
    const idx = newThreads.findIndex((t) => normalizeName(t.title) === normalizeName(thread.title));
    if (idx === -1) {
      newThreads.push({ title: thread.title, status: thread.status });
    } else {
      newThreads[idx] = { title: newThreads[idx]!.title, status: thread.status };
    }
  }

  // Append chronology entries — deduplicated against existing AND within the incoming batch.
  // The LLM can emit near-identical timeline entries in a single audit pass; we skip any
  // entry whose first 120 normalized chars match an already-seen entry.
  const newChronology = [...(checkpoint.chronology ?? [])];

  const sceneChars = delta.scene?.present_characters ?? checkpoint.scene?.present_characters;

  if (delta.chronology_entry) {
    const entry = {
      timestamp: delta.chronology_entry.timestamp,
      summary: delta.chronology_entry.summary,
      key_events: delta.chronology_entry.key_events ?? [],
      present_characters: sceneChars && sceneChars.length > 0 ? sceneChars : undefined,
    };
    if (!isChronologyDuplicate(newChronology, entry)) {
      newChronology.push(entry);
    }
  }

  if (delta.chronology_entries && Array.isArray(delta.chronology_entries)) {
    for (const ent of delta.chronology_entries) {
      const entry = {
        timestamp: ent.timestamp,
        summary: ent.summary,
        key_events: ent.key_events ?? [],
        present_characters: sceneChars && sceneChars.length > 0 ? sceneChars : undefined,
      };
      if (!isChronologyDuplicate(newChronology, entry)) {
        newChronology.push(entry);
      }
    }
  }

  // Append new discrete memories — deduplicated by normalized name (first 80 chars of summary as fallback)
  const newMemories = [...(checkpoint.memories ?? [])];
  if (delta.new_memories && Array.isArray(delta.new_memories)) {
    const memoryKey = (m: WorldEntity) =>
      (m.name ?? m.blurb ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 80);
    const existingMemoryKeys = new Set(newMemories.map(memoryKey));
    for (const mem of delta.new_memories) {
      const key = memoryKey(mem);
      if (key && !existingMemoryKeys.has(key)) {
        existingMemoryKeys.add(key);
        newMemories.push(mem);
      }
    }
  }

  return {
    ...checkpoint,
    characters: mergeEntities(checkpoint.characters ?? [], charAdd, charUpd),
    locations: mergeEntities(checkpoint.locations ?? [], locAdd, locUpd),
    items: mergeEntities(checkpoint.items ?? [], itemAdd, itemUpd),
    knowledge: mergeEntities(checkpoint.knowledge ?? [], knowAdd, knowUpd),
    events: mergeEntities(checkpoint.events ?? [], eventAdd, eventUpd),
    rules: newRules,
    plot_threads: newThreads,
    chronology: newChronology,
    scene: delta.scene ?? checkpoint.scene,
    /** MACRO: Story Thus Far */
    summary: delta.narrative_summary ?? checkpoint.summary,
    /** MICRO: Discrete beats */
    memories: newMemories,
    atmosphere: delta.atmosphere ?? checkpoint.atmosphere,
    world_laws:
      delta.world_laws && delta.world_laws.length > 0
        ? Array.from(
            new Set(
              [...(checkpoint.world_laws ?? []), ...delta.world_laws].map((w) => {
                let clean = w.trim();
                if (clean.toLowerCase().startsWith("add,")) clean = clean.slice(4).trim();
                if (clean.toLowerCase().startsWith("update,")) clean = clean.slice(7).trim();
                return clean;
              }),
            ),
          )
        : checkpoint.world_laws,
  };
}
