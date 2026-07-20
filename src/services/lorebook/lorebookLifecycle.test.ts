import { describe, expect, it } from "vitest";
import {
  buildActiveNameSet,
  isEntityDormant,
  nextExtractionSeq,
  rollupChronology,
  selectCoreFloor,
  stampRecency,
} from "./lorebookLifecycle.js";

const chron = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ timestamp: `t${i}`, summary: `event ${i}`, key_events: [] }));

const char = (name: string, extra: Record<string, any> = {}): any => ({
  name,
  blurb: "x",
  importance: "middle",
  ...extra,
});

describe("nextExtractionSeq", () => {
  it("returns 1 for a checkpoint with no sequence", () => {
    expect(nextExtractionSeq({})).toBe(1);
    expect(nextExtractionSeq(null)).toBe(1);
    expect(nextExtractionSeq(undefined)).toBe(1);
  });

  it("increments an existing sequence", () => {
    expect(nextExtractionSeq({ _extractionSeq: 7 })).toBe(8);
  });
});

describe("buildActiveNameSet", () => {
  it("normalizes and dedupes names, dropping empties", () => {
    const set = buildActiveNameSet(["Harry Potter", "harry potter", "  Ron  ", null, undefined, ""]);
    expect(set.has("harry potter")).toBe(true);
    expect(set.has("ron")).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe("stampRecency", () => {
  it("bumps the extraction sequence", () => {
    const out: any = stampRecency({ characters: [] } as any, {}, new Set(), 5);
    expect(out._extractionSeq).toBe(5);
  });

  it("stamps entities active this turn with the current seq", () => {
    const merged: any = { characters: [char("Reiko"), char("Amber")] };
    const active = buildActiveNameSet(["Reiko"]);
    const out: any = stampRecency(merged, {}, active, 3);
    expect(out.characters.find((c: any) => c.name === "Reiko").lastSeenTurn).toBe(3);
    // Amber not active and never stamped → backfilled to the current seq (grace baseline).
    expect(out.characters.find((c: any) => c.name === "Amber").lastSeenTurn).toBe(3);
  });

  it("preserves a prior stamp carried on the merged entity", () => {
    const merged: any = { characters: [char("Amber", { lastSeenTurn: 2 })] };
    const out: any = stampRecency(merged, {}, new Set(), 9);
    expect(out.characters[0].lastSeenTurn).toBe(2);
  });

  it("recovers a prior stamp from base when the merge dropped it", () => {
    // merged entity lost its lastSeenTurn (merge reconstructed it); base still has it.
    const merged: any = { characters: [char("Amber")] };
    const base: any = { characters: [char("Amber", { lastSeenTurn: 4 })] };
    const out: any = stampRecency(merged, base, new Set(), 9);
    expect(out.characters[0].lastSeenTurn).toBe(4);
  });

  it("active stamp wins over a prior stamp", () => {
    const merged: any = { characters: [char("Reiko", { lastSeenTurn: 1 })] };
    const out: any = stampRecency(merged, {}, buildActiveNameSet(["Reiko"]), 6);
    expect(out.characters[0].lastSeenTurn).toBe(6);
  });

  it("stamps across all entity arrays", () => {
    const merged: any = {
      characters: [char("Reiko")],
      locations: [char("The Bedroom")],
      items: [char("Chips")],
      knowledge: [char("Sleepover Rules")],
      events: [char("The Invasion")],
    };
    const active = buildActiveNameSet(["Reiko", "The Bedroom", "Chips", "Sleepover Rules", "The Invasion"]);
    const out: any = stampRecency(merged, {}, active, 2);
    for (const arr of ["characters", "locations", "items", "knowledge", "events"]) {
      expect(out[arr][0].lastSeenTurn).toBe(2);
    }
  });

  it("does not mutate the input checkpoints", () => {
    const merged: any = { characters: [char("Reiko")], _extractionSeq: 1 };
    const base: any = { characters: [char("Reiko", { lastSeenTurn: 1 })] };
    const snapshot = JSON.stringify(merged);
    stampRecency(merged, base, buildActiveNameSet(["Reiko"]), 5);
    expect(JSON.stringify(merged)).toBe(snapshot);
  });
});

describe("rollupChronology", () => {
  it("is a no-op when under the soft cap", () => {
    const cp: any = { chronology: chron(50) };
    const out: any = rollupChronology(cp, { softCap: 60, keep: 40 });
    expect(out).toBe(cp); // same reference — untouched
  });

  it("prunes to `keep` most-recent entries and archives the rest", () => {
    const cp: any = { chronology: chron(70) };
    const out: any = rollupChronology(cp, { softCap: 60, keep: 40 });
    expect(out.chronology).toHaveLength(40);
    // retained entries are the most recent (event 30..69)
    expect(out.chronology[0].summary).toBe("event 30");
    expect(out.chronology[39].summary).toBe("event 69");
    // archived breadcrumb holds the oldest (event 0..29)
    expect(out.chronology_archive).toContain("event 0");
    expect(out.chronology_archive).toContain("event 29");
    expect(out.chronology_archive).not.toContain("event 30");
  });

  it("appends to a prior archive in chronological order", () => {
    const cp: any = { chronology: chron(70), chronology_archive: "earlier stuff" };
    const out: any = rollupChronology(cp, { softCap: 60, keep: 40 });
    expect(out.chronology_archive.startsWith("earlier stuff")).toBe(true);
    expect(out.chronology_archive).toContain("event 0");
  });

  it("bounds the archive length, trimming oldest text", () => {
    const cp: any = { chronology: chron(200) };
    const out: any = rollupChronology(cp, { softCap: 60, keep: 40, maxArchiveChars: 200 });
    expect(out.chronology_archive.length).toBeLessThanOrEqual(201); // +1 for the ellipsis
    expect(out.chronology_archive.startsWith("…")).toBe(true);
  });

  it("does not mutate the input", () => {
    const cp: any = { chronology: chron(70) };
    const snapshot = JSON.stringify(cp);
    rollupChronology(cp, { softCap: 60, keep: 40 });
    expect(JSON.stringify(cp)).toBe(snapshot);
  });
});

describe("isEntityDormant", () => {
  it("treats unstamped entities as not dormant (grace)", () => {
    expect(isEntityDormant({}, 100, 10)).toBe(false);
    expect(isEntityDormant({ lastSeenTurn: undefined }, 100, 10)).toBe(false);
  });

  it("is not dormant within the threshold", () => {
    expect(isEntityDormant({ lastSeenTurn: 95 }, 100, 10)).toBe(false); // 5 < 10
  });

  it("is dormant at/after the threshold", () => {
    expect(isEntityDormant({ lastSeenTurn: 90 }, 100, 10)).toBe(true); // 10 >= 10
    expect(isEntityDormant({ lastSeenTurn: 50 }, 100, 10)).toBe(true);
  });
});

describe("selectCoreFloor", () => {
  const e = (name: string, lastSeenTurn?: number): any => ({ name, importance: "core", lastSeenTurn });

  it("drops dormant entities (they fall to RAG-only)", () => {
    const core = [e("Fresh", 98), e("Cold", 40)];
    const out = selectCoreFloor(core, 100, { threshold: 10 });
    expect(out.map((x: any) => x.name)).toEqual(["Fresh"]);
  });

  it("keeps the most-recently-active when over the cap", () => {
    const core = [e("A", 10), e("B", 99), e("C", 50), e("D", 98)];
    const out = selectCoreFloor(core, 100, { cap: 2, threshold: 1000 }); // high threshold → none dormant
    expect(out.map((x: any) => x.name)).toEqual(["B", "D"]);
  });

  it("keeps everything live when under the cap", () => {
    const core = [e("A", 99), e("B", 98)];
    const out = selectCoreFloor(core, 100, { cap: 8, threshold: 10 });
    expect(out).toHaveLength(2);
  });

  // The self-correcting loop: a dormant entity that is mentioned again is stamped fresh by
  // stampRecency and immediately re-enters the core floor — no persisted "dormant" flag to clear.
  it("self-corrects: re-mentioning a dormant entity restores it to the core floor", () => {
    let cp: any = { characters: [e("Amber", 40)], _extractionSeq: 99 };
    // Cold right now:
    expect(selectCoreFloor(cp.characters, 100, { threshold: 10 })).toHaveLength(0);
    // Amber is mentioned on the next extraction pass → stamped fresh:
    cp = stampRecency(cp, cp, buildActiveNameSet(["Amber"]), 100);
    expect(cp.characters[0].lastSeenTurn).toBe(100);
    // Now live again:
    expect(selectCoreFloor(cp.characters, 100, { threshold: 10 }).map((x: any) => x.name)).toEqual(["Amber"]);
  });
});
