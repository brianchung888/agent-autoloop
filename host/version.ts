// Which code this is: the release tag on its commit, if any, and the commit. The tag is the one place a version number is
// written: a number in a file still names the last release on every commit after it, and goes stale wherever it's copied.
//
// A packaged build has no checkout to ask. What it has instead is what the build wrote into it — the two values below,
// put there by scripts/build-binary.{ps1,sh} — and asking git there would be worse than not knowing: the only
// repository such a build can reach is whichever one the executable happens to have been copied into, and reporting a
// stranger's commit in a bug report is a wrong answer where "dev" is an honest one.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { packaged } from "./assets.ts";
import { t } from "./i18n.ts";

const ROOT = path.join(import.meta.dirname, "..");

/**
 * What the build was told this code is, or nothing. In source mode these are unset and a checkout answers instead; a
 * packaged build has them replaced by the literal strings the build knew, so the answer travels inside the binary
 * rather than in whoever's environment it is started from.
 */
const TOLD = {
  commit: () => process.env.AGENT_AUTOLOOP_COMMIT || null,
  release: () => process.env.AGENT_AUTOLOOP_RELEASE || null,
};

/** What was deployed, or the checkout's commit. Git says: after a gc a branch's ref is no longer a file of its own. */
export function commitOf(root = ROOT) {
  const told = TOLD.commit();
  if (told) return told;
  // Nothing beside a packaged build is its own. A `.git` next to the executable is somebody else's, not this build's.
  if (packaged()) return "dev";
  try {
    // Only a checkout has its own .git entry; unpacked copies must not inherit a parent repository's commit.
    if (!existsSync(path.join(root, ".git"))) return "dev";
    const args = ["-C", root, "rev-parse", "HEAD"];
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return "dev";
  }
}

/** The release this commit is, if it is one. A try-out tag left on the same commit gives way to the release it became. */
export function releaseOf(root = ROOT) {
  const told = TOLD.release();
  if (told) return told;
  if (packaged()) return null;
  try {
    if (!existsSync(path.join(root, ".git"))) return null;
    const args = ["-C", root, "tag", "--points-at", "HEAD"];
    const tags = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).split("\n");
    return tags.find((tag) => /^v\d+\.\d+\.\d+$/.test(tag)) ?? tags.find((tag) => /^v\d+\.\d+\.\d+-/.test(tag)) ?? null;
  } catch {
    return null;
  }
}

/** What other programs are told this is. */
export function versionName(root = ROOT) {
  return releaseOf(root) ?? commitOf(root).slice(0, 12);
}

export function versionLine(root = ROOT) {
  return t("version.line", {
    release: releaseOf(root) ?? t("version.unreleased"),
    commit: commitOf(root).slice(0, 12),
  });
}
