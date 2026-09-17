/**
 * Minimal gitignore-style glob matching.
 *
 * Written by hand rather than pulled from a package because the toolkit ships
 * as a committed bundle with no install step: one dependency here would have to
 * be vendored anyway. The supported syntax is deliberately small — `**`, `*`,
 * `?`, character classes and `{a,b}` alternation — which covers every pattern
 * shape a review rule needs.
 */

const SPECIAL = /[.+^$()|\\]/g;

function segmentToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**` spans directory separators; `**/` may also match zero segments.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    if (char === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close > i) {
        const body = glob.slice(i + 1, close).replace(/^!/, "^");
        out += `[${body}]`;
        i = close;
        continue;
      }
      out += "\\[";
      continue;
    }
    if (char === "{") {
      const close = glob.indexOf("}", i + 1);
      if (close > i) {
        const options = glob.slice(i + 1, close).split(",");
        out += `(?:${options.map(segmentToRegex).join("|")})`;
        i = close;
        continue;
      }
      out += "\\{";
      continue;
    }
    out += char.replace(SPECIAL, "\\$&");
  }
  return out;
}

/** Compiles a glob into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim();
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  // A trailing slash means "everything under this directory".
  if (pattern.endsWith("/")) pattern += "**";
  // A bare name with no separator matches at any depth, as gitignore does.
  const anchored = pattern.includes("/") ? pattern : `**/${pattern}`;
  return new RegExp(`^${segmentToRegex(anchored)}$`);
}

const cache = new Map<string, RegExp>();

/** Reports whether a repository-relative path matches a glob. */
export function matchesGlob(path: string, glob: string): boolean {
  let regex = cache.get(glob);
  if (!regex) {
    regex = globToRegExp(glob);
    cache.set(glob, regex);
  }
  return regex.test(path.replace(/^\//, ""));
}

/** Reports whether a path matches any glob in the list. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob));
}
