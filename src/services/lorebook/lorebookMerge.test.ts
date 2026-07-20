import { describe, expect, it } from "vitest";
import { applyLorebookDelta, type LorebookCheckpoint, type LorebookEntity } from "./lorebookMerge.js";

function emptyCheckpoint(overrides: Partial<LorebookCheckpoint> = {}): LorebookCheckpoint {
  return {
    characters: [],
    locations: [],
    items: [],
    rules: [],
    plot_threads: [],
    chronology: [],
    ...overrides,
  };
}

function char(name: string, blurb: string, extra: Partial<LorebookEntity> = {}): LorebookEntity {
  return { name, blurb, importance: "middle", ...extra };
}

describe("applyLorebookDelta — merge edge cases", () => {
  it("#9 does not merge a bare first name into one of two same-first-name characters", () => {
    const cp = emptyCheckpoint({
      characters: [
        char("Harry Potter", "The boy who lived"),
        char("Harry Osborn", "Green Goblin's son"),
      ],
    });

    const result = applyLorebookDelta(cp, { add: [char("Harry", "ambiguous newcomer")], update: [] });

    // Neither existing character should be corrupted by the ambiguous bare "Harry".
    expect(result.characters.find((c) => c.name === "Harry Potter")?.blurb).toBe("The boy who lived");
    expect(result.characters.find((c) => c.name === "Harry Osborn")?.blurb).toBe("Green Goblin's son");
    // Both distinct characters survive.
    expect(result.characters.filter((c) => c.name.startsWith("Harry")).length).toBeGreaterThanOrEqual(2);
  });

  it("#9 regression: a bare first name still merges when there is exactly one match", () => {
    const cp = emptyCheckpoint({ characters: [char("Hermione Granger", "brightest witch of her age")] });

    const result = applyLorebookDelta(cp, {
      add: [],
      update: [char("Hermione", "updated blurb", { status: "Alive" })],
    });

    // Only one entity, merged (not a second "Hermione").
    expect(result.characters.length).toBe(1);
    expect(result.characters[0]!.name).toBe("Hermione Granger");
    expect(result.characters[0]!.status).toBe("Alive");
  });

  it("#10 collapses a pre-existing duplicate of a non-canonical same-first-name entity", () => {
    const cp = emptyCheckpoint({
      characters: [
        char("Harry Potter", "canonical for 'harry'"),
        char("Harry Osborn", "first osborn"),
        char("Harry Osborn", "duplicate osborn — should collapse"),
      ],
    });

    const result = applyLorebookDelta(cp, { add: [], update: [] });

    expect(result.characters.filter((c) => c.name === "Harry Osborn").length).toBe(1);
    expect(result.characters.some((c) => c.name === "Harry Potter")).toBe(true);
  });

  it("4a unions aliases across an update and drops one equal to the canonical name", () => {
    const cp = emptyCheckpoint({
      characters: [char("Hermione Granger", "witch", { aliases: ["Mione"] })],
    });
    const result = applyLorebookDelta(cp, {
      add: [],
      update: [char("Hermione Granger", "witch", { aliases: ["Herm", "Mione", "Hermione Granger"] })],
    });
    const h = result.characters.find((c) => c.name === "Hermione Granger")!;
    expect(h.aliases).toContain("Mione");
    expect(h.aliases).toContain("Herm");
    // No duplicate of the existing alias, and the canonical name isn't stored as an alias.
    expect(h.aliases!.filter((a) => a.toLowerCase() === "mione")).toHaveLength(1);
    expect(h.aliases!.some((a) => a.toLowerCase() === "hermione granger")).toBe(false);
  });

  it("4b accumulates exposure_tags across extractions without duplicates", () => {
    const cp = emptyCheckpoint({
      characters: [char("Narcissa", "witch", { exposure_tags: ["muggle_tech:soda_fountain"] })],
    });
    const result = applyLorebookDelta(cp, {
      add: [],
      update: [char("Narcissa", "witch", { exposure_tags: ["muggle_tech:soda_fountain", "visited:cinema"] })],
    });
    const n = result.characters.find((c) => c.name === "Narcissa")!;
    expect(n.exposure_tags).toContain("muggle_tech:soda_fountain");
    expect(n.exposure_tags).toContain("visited:cinema");
    expect(n.exposure_tags!.filter((t) => t === "muggle_tech:soda_fountain")).toHaveLength(1);
  });

  it("#11 lets a genuinely new tag enter an entity already at the tag cap", () => {
    const tenTags = Array.from({ length: 10 }, (_, i) => `tag${i + 1}`);
    const cp = emptyCheckpoint({ characters: [char("Bob", "a guy", { tags: [...tenTags] })] });

    const result = applyLorebookDelta(cp, {
      add: [],
      update: [char("Bob", "a guy", { tags: [...tenTags, "freshtag"] })],
    });

    const bob = result.characters.find((c) => c.name === "Bob")!;
    expect(bob.tags).toContain("freshtag");
    expect(bob.tags!.length).toBeLessThanOrEqual(10);
  });
});
