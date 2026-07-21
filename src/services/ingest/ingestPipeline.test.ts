import { describe, expect, it } from "vitest";
import { chunk } from "./ingestPipeline.js";

/**
 * Chunking is pure and cheap to test, and its failure mode is quiet: an oversized chunk doesn't
 * throw, it just produces a thin, generic extraction that drops the specifics worth keeping.
 */
const CHUNK_CHARS = 12_000;
const MAX_CHUNKS = 12;

describe("chunk", () => {
  it("leaves a short document as a single chunk", () => {
    const text = "A short note about the project.";
    expect(chunk(text)).toEqual([text]);
  });

  it("splits on paragraph boundaries rather than mid-sentence", () => {
    const para = "x".repeat(5_000);
    const chunks = chunk([para, para, para].join("\n\n"));

    expect(chunks.length).toBeGreaterThan(1);
    // A boundary split means no chunk starts or ends mid-paragraph, so every chunk is a whole
    // number of the original paragraphs.
    for (const c of chunks) {
      expect(c.replace(/\n\s*\n/g, "").length % 5_000).toBe(0);
    }
  });

  it("never emits a chunk over the size limit", () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}. ${"y".repeat(2_000)}`);
    for (const c of chunk(paragraphs.join("\n\n"))) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS);
    }
  });

  it("hard-cuts a single paragraph that exceeds the chunk size", () => {
    // Minified JSON or a one-line log dump has no paragraph boundary to split on. Without the
    // fallback this returns one chunk far over the limit.
    const chunks = chunk("z".repeat(30_000));

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS);
    }
    expect(chunks.join("")).toHaveLength(30_000);
  });

  it("caps the number of chunks so one huge file can't monopolise a sync pass", () => {
    expect(chunk("q".repeat(CHUNK_CHARS * 40)).length).toBeLessThanOrEqual(MAX_CHUNKS);
  });

  it("drops nothing when content is exactly at the boundary", () => {
    const exact = "w".repeat(CHUNK_CHARS);
    expect(chunk(exact)).toEqual([exact]);
  });
});
