import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createLogger } from "../../utils/logger.js";
import type { IngestDocument, SourceConnector } from "./types.js";

const logger = createLogger("ingest:folder");

/**
 * Text formats worth extracting from. Binary formats (.pdf, .docx) would need a parser
 * dependency; skipped rather than fed to the LLM as mojibake, which produces confident nonsense
 * in the knowledge base.
 */
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".rst", ".org", ".json", ".yaml", ".yml"]);

/**
 * Guards against reading something enormous into memory and then paying to extract from it. A
 * single 50MB log file would otherwise stall the sync worker and blow the token budget.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Depth cap, so a symlink loop or a nested node_modules can't walk forever. */
const MAX_DEPTH = 4;

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    logger.warn("Could not read directory", { dir, err });
    return;
  }

  for (const entry of entries) {
    // Skip dotfiles and dependency directories: they are noise, and node_modules alone would
    // dominate every extraction pass.
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, depth + 1, out);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
}

/**
 * Watches a mounted directory. Drop a file in, and its content becomes part of the book.
 *
 * Polling rather than fs.watch: watch events are unreliable across Docker bind mounts and network
 * filesystems (the common case here), and the pipeline's content-hash dedupe already makes a
 * re-poll of unchanged files nearly free.
 */
export const folderConnector: SourceConnector = {
  type: "folder",

  async poll(config: Record<string, unknown>): Promise<IngestDocument[]> {
    const path = typeof config.path === "string" ? config.path : null;
    if (!path) {
      throw new Error("folder source is missing a `path` in its config");
    }

    const root = resolve(path);
    const stats = await stat(root).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new Error(`folder source path is not a readable directory: ${root}`);
    }

    const files: string[] = [];
    await walk(root, 0, files);

    const docs: IngestDocument[] = [];
    for (const file of files) {
      try {
        const info = await stat(file);
        if (info.size > MAX_FILE_BYTES) {
          logger.warn("Skipping oversized file", { file, bytes: info.size, max: MAX_FILE_BYTES });
          continue;
        }
        const content = await readFile(file, "utf8");
        if (!content.trim()) continue;

        // The absolute path is the externalId: stable across polls, and unique within the source.
        docs.push({ externalId: file, content, title: file.slice(root.length + 1) });
      } catch (err) {
        // One unreadable file must not abort the whole source.
        logger.warn("Could not read file", { file, err });
      }
    }

    logger.info("Folder poll complete", { root, files: docs.length });
    return docs;
  },
};
