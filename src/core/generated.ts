import { createHash } from "node:crypto";
import type { ChangedFile } from "../types.ts";

/**
 * Removes target-framework-only noise before generated files are compared.
 *
 * Multi-target generators commonly emit identical source under `#if NET8_0`
 * and `#if NET10_0`. The target symbol does not change the behavior being
 * reviewed, so it is normalized; all other source remains exact.
 */
export function normalizeGeneratedContent(content: string): string {
  return content
    .replace(/^#if NET\d+_\d+\s*$/gm, "#if NET_TARGET")
    .replace(/\r\n/g, "\n")
    .trim();
}

function contentHash(content: string): string {
  return createHash("sha256").update(normalizeGeneratedContent(content)).digest("hex");
}

/**
 * Reviews one representative of each duplicate generated-file group.
 *
 * Unique generated files stay stat-only. A duplicate group promotes its first
 * path to review so the generated contract is still inspected once; every
 * twin records exactly which representative covers it.
 */
export function collapseGeneratedDuplicates(
  files: ChangedFile[],
  contents: Map<string, string>,
): ChangedFile[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    if (file.category !== "generated" || file.status === "delete") continue;
    const content = contents.get(file.path);
    if (!content) continue;
    const hash = contentHash(content);
    const group = groups.get(hash) ?? [];
    group.push(file.path);
    groups.set(hash, group);
  }

  const representativeByPath = new Map<string, string>();
  for (const paths of groups.values()) {
    if (paths.length < 2) continue;
    paths.sort((a, b) => a.localeCompare(b));
    const representative = paths[0];
    for (const path of paths) representativeByPath.set(path, representative);
  }

  return files.map((file) => {
    const representative = representativeByPath.get(file.path);
    if (!representative) return file;
    if (file.path === representative) {
      return {
        ...file,
        decision: "review",
        reason: "generated-representative",
        // Generated contracts are reviewed after handwritten source, but no
        // longer disappear entirely from semantic coverage.
        risk: Math.max(1, file.risk),
      };
    }
    return {
      ...file,
      decision: "stat-only",
      reason: `duplicate-of:${representative}`,
    };
  });
}
