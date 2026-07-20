/** Tunable limits for the worldbrain framework (ported subset from Aria's config/limits). */

/** Max related chronology/relationship entries folded into merge/embedding context. */
export const LOREBOOK_RELATED_MAX = 15;

/** Max chars of an entity's fixedContent folded into its embedding text. */
export const EMBEDDING_FIXED_CONTENT_MAX_CHARS = 400;

/** Max chars of cross-linked (related events/chronology) text folded into embedding text. */
export const EMBEDDING_CROSS_LINK_MAX_CHARS = 600;

// ── Extraction hygiene caps ──────────────────────────────────────────────────
// Applied by intelligence/types.ts to LLM-extracted string arrays. A trait or alias is a
// short label; when the model returns a paragraph there it has misunderstood the field, so
// the entry is dropped (with a log) rather than allowed to bloat the entity card.

/** Max chars for a single trait. Longer entries are blurb bleed and get dropped. */
export const TRAIT_MAX_CHARS = 120;

/** Max traits retained per entity. */
export const TRAITS_MAX_COUNT = 20;

/** Max chars for a relationship description. Oversized objects are clipped, not dropped. */
export const RELATIONSHIP_VALUE_MAX_CHARS = 300;

/** Max chars for a single alias/nickname. */
export const ALIAS_MAX_CHARS = 60;

/** Max aliases retained per entity. */
export const ALIASES_MAX_COUNT = 12;

/** Max chars for a single exposure tag (e.g. "muggle_tech:soda_fountain"). */
export const EXPOSURE_TAG_MAX_CHARS = 80;

/** Max exposure tags retained per entity. */
export const EXPOSURE_TAGS_MAX_COUNT = 40;
