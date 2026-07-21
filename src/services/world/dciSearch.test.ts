import { describe, expect, it, vi } from "vitest";
import {
  dciAugmentRetrievedItems,
  extractMentionedEntities,
  nameAppearsInText,
  phraseAppearsInText,
  tagAppearsInText,
} from "./dciSearch.js";

// ── nameAppearsInText ────────────────────────────────────────────────────────

describe("nameAppearsInText", () => {
  it("matches a standalone name", () => {
    expect(nameAppearsInText("Ron", "Ron walked into the room")).toBe(true);
  });

  it("does not match a substring inside another word", () => {
    expect(nameAppearsInText("Ron", "The baron and the iron gate")).toBe(false);
  });

  it("matches a surname reference for multi-word names", () => {
    expect(nameAppearsInText("Viktor Krum", "Krum spoke first")).toBe(true);
  });

  it("does not fall back to short risky surnames", () => {
    expect(nameAppearsInText("Bruce Lee", "I need to lee the building")).toBe(false);
  });

  it("matches a first-name reference for multi-word names", () => {
    expect(nameAppearsInText("Viktor Krum", "Viktor smiled warmly")).toBe(true);
    expect(nameAppearsInText("Hermione Granger", "Hermione waved")).toBe(true);
  });

  it("matches a short (3-char) first-name reference", () => {
    expect(nameAppearsInText("Ron Weasley", "Ron grinned")).toBe(true);
  });

  it("does not match first names as substrings", () => {
    expect(nameAppearsInText("Ron Weasley", "The baron scowled")).toBe(false);
  });

  it("does not treat articles or titles as first names", () => {
    expect(nameAppearsInText("The Burrow", "the evening was quiet")).toBe(false);
    expect(nameAppearsInText("Professor Sprout", "the professor entered")).toBe(false);
  });

  it("matches names ending in an accented letter (unicode boundaries)", () => {
    expect(nameAppearsInText("José", "José walked in")).toBe(true);
  });

  it("matches names starting with an accented letter", () => {
    expect(nameAppearsInText("Émile", "Émile sat down")).toBe(true);
  });

  it("still rejects accented names embedded in longer words", () => {
    expect(nameAppearsInText("José", "Joséphine walked in")).toBe(false);
  });

  it("requires capitals for name tokens that are common English words", () => {
    expect(nameAppearsInText("Sirius Black", "the black cat darted across the road")).toBe(false);
    expect(nameAppearsInText("Sirius Black", "Black scowled from the doorway")).toBe(true);
    expect(nameAppearsInText("Will Turner", "will you come with me")).toBe(false);
    expect(nameAppearsInText("Will Turner", "Will strode in confidently")).toBe(true);
  });

  it("applies the ambiguity rule to single-token names too", () => {
    expect(nameAppearsInText("Rose", "she picked a rose from the garden")).toBe(false);
    expect(nameAppearsInText("Rose", "Rose waved from the balcony")).toBe(true);
  });

  it("keeps unambiguous tokens case-insensitive", () => {
    expect(nameAppearsInText("Viktor Krum", "i hope viktor shows up")).toBe(true);
  });

  it("normalizes typographic apostrophes between name and text", () => {
    expect(nameAppearsInText("D'Artagnan", "D’Artagnan bowed politely")).toBe(true);
    expect(nameAppearsInText("Viktor Krum", "Viktor’s broom hissed")).toBe(true);
  });

  it("tolerates whitespace-padded names", () => {
    expect(nameAppearsInText("  Padded Name  ", "we met Padded Name at the gate")).toBe(true);
  });
});

// ── phraseAppearsInText (tag-gating primitive) ───────────────────────────────

describe("phraseAppearsInText", () => {
  it("matches a standalone tag word", () => {
    expect(phraseAppearsInText("art", "I love art class")).toBe(true);
  });

  it("does not match a tag as a substring of another word", () => {
    expect(phraseAppearsInText("art", "we should start now")).toBe(false);
    expect(phraseAppearsInText("cat", "pick a category")).toBe(false);
  });

  it("requires a multi-word tag to appear in full (no token fallback)", () => {
    expect(phraseAppearsInText("fire magic", "he studied fire magic")).toBe(true);
    expect(phraseAppearsInText("fire magic", "the fire spread quickly")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(phraseAppearsInText("Notebook", "she opened the NOTEBOOK")).toBe(true);
  });

  it("normalizes typographic apostrophes", () => {
    expect(phraseAppearsInText("d'artagnan's blade", "the d’artagnan’s blade gleamed")).toBe(true);
  });

  it("returns false for empty/whitespace tags", () => {
    expect(phraseAppearsInText("   ", "anything")).toBe(false);
    expect(phraseAppearsInText("", "anything")).toBe(false);
  });
});

// ── tagAppearsInText (inflection-tolerant tag trigger) ───────────────────────

describe("tagAppearsInText", () => {
  it("matches the exact tag", () => {
    expect(tagAppearsInText("notebook", "he opened the notebook")).toBe(true);
  });

  it("matches plural and possessive forms (the regression fix)", () => {
    expect(tagAppearsInText("notebook", "his notebooks were stacked")).toBe(true);
    expect(tagAppearsInText("notebook", "the notebook's pages")).toBe(true);
    expect(tagAppearsInText("quidditch reform", "the quidditch reforms passed")).toBe(true);
  });

  it("still rejects substring false positives", () => {
    expect(tagAppearsInText("art", "we should start now")).toBe(false);
    expect(tagAppearsInText("art", "she is an artist")).toBe(false);
    expect(tagAppearsInText("notebook", "notebooking is not a word here noteboo")).toBe(false);
  });

  it("returns false for empty tags", () => {
    expect(tagAppearsInText("  ", "anything")).toBe(false);
  });
});

// ── extractMentionedEntities ─────────────────────────────────────────────────

describe("extractMentionedEntities", () => {
  const checkpoint = {
    characters: [{ name: "Ron", importance: "supporting" }],
    locations: [{ name: "The Burrow", importance: "supporting" }],
  };

  it("finds entities mentioned verbatim in text", () => {
    const found = extractMentionedEntities("Ron ran to The Burrow", checkpoint);
    expect(found).toEqual([
      { name: "Ron", type: "character" },
      { name: "The Burrow", type: "location" },
    ]);
  });

  it("returns nothing when no entity names appear", () => {
    expect(extractMentionedEntities("A quiet evening passed", checkpoint)).toEqual([]);
  });

  it("matches an alias and reports the canonical name", () => {
    const cp = {
      characters: [{ name: "Hermione Granger", importance: "core", aliases: ["Mione", "Herm"] }],
    };
    // Canonical name isn't in the text, but a nickname is → resolves to canonical.
    const found = extractMentionedEntities("Mione flipped through the book", cp);
    expect(found).toEqual([{ name: "Hermione Granger", type: "character" }]);
  });

  it("does not match an alias as a substring of another word", () => {
    const cp = { characters: [{ name: "Ronald", importance: "core", aliases: ["Ron"] }] };
    expect(extractMentionedEntities("the environment was calm", cp)).toEqual([]);
  });
});

// ── dciAugmentRetrievedItems: complements RAG without duplicating it ────────

describe("dciAugmentRetrievedItems", () => {
  const checkpoint = {
    characters: [
      { name: "Zephyrine", importance: "supporting" }, // unusual name, RAG missed it
      { name: "Aria", importance: "core" }, // RAG already found this one
    ],
  };

  function mockDb(rows: Array<{ key: string }>) {
    return {
      $queryRawUnsafe: vi.fn().mockResolvedValue(
        rows.map((r, i) => ({
          id: `id-${i}`,
          key: r.key,
          type: "character",
          content: `${r.key} content`,
          worldId: "lb-1",
          importanceScore: 1,
          embeddingModel: null,
          canonBook: null,
          canonChapter: null,
          createdAt: new Date(),
        })),
      ),
    } as any;
  }

  it("adds an entity mentioned by name that vector RAG missed", async () => {
    const db = mockDb([{ key: "Zephyrine" }]);
    const alreadyRetrievedKeys = new Set<string>(["aria"]); // RAG already found Aria this turn
    const result = await dciAugmentRetrievedItems(
      db,
      "Zephyrine walked in with Aria",
      ["lb-1"],
      [checkpoint],
      alreadyRetrievedKeys,
    );

    // Only the un-retrieved name is queried/returned; "Aria" is skipped by the DB filter.
    expect(db.$queryRawUnsafe).toHaveBeenCalled();
    const queriedNames = db.$queryRawUnsafe.mock.calls[0][2];
    expect(queriedNames).toEqual(["zephyrine"]);
    expect(result.map((r) => r.key)).toEqual(["Zephyrine"]);
  });

  it("does not re-query or duplicate an entity RAG already retrieved", async () => {
    const db = mockDb([]);
    const alreadyRetrievedKeys = new Set(["aria"]); // RAG already found Aria this turn
    await dciAugmentRetrievedItems(
      db,
      "Aria smiled at Zephyrine", // both mentioned, but Aria is pre-filtered
      ["lb-1"],
      [checkpoint],
      alreadyRetrievedKeys,
    );

    const queriedNames = db.$queryRawUnsafe.mock.calls[0][2];
    expect(queriedNames).not.toContain("aria");
    expect(queriedNames).toContain("zephyrine");
  });

  it("returns nothing when no world entity is mentioned", async () => {
    const db = mockDb([]);
    const result = await dciAugmentRetrievedItems(
      db,
      "A quiet evening passed with no one around",
      ["lb-1"],
      [checkpoint],
      new Set(),
    );
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
