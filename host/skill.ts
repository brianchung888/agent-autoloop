// Where the Skill is: the folder an Agent's own `skills/` is linked to, so that the Agent knows what this program can
// do. One place says where, because three things have to agree about it — what the install links (cli/main.ts:
// linkSkill), what `doctor` tells someone to read, and what `uninstall` takes away again.
//
// In source mode it is the folder in the tree, as it has always been. A packaged build has no folder: it carries
// SKILL.md inside itself (host/assets.ts) and writes it out under this install's own HOME — the first place that is
// this install's and that an Agent's `skills/` can be linked to. Without that, `doctor` names a file nobody has
// (PoC: `C:\tmp\skills\agent-autoloop\SKILL.md`, the executable's parent folder, where there was nothing at all).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetText } from "./assets.ts";
import { HOME } from "./home.ts";
import { fromSource } from "./self.ts";

/** The Skill's one name, which is also the folder's, in both places it can be. */
export const SKILL = "agent-autoloop";
/** What a packaged build carries it as. The same path the repository spells it by (host/assets.ts: ASSETS). */
const CARRIED = "skills/agent-autoloop/SKILL.md";

/** Where this build's own copy of the Skill is, whether or not it is there yet. */
export const skillFolder = () =>
  fromSource() ? join(import.meta.dirname, "..", "skills", SKILL) : join(HOME, "skills", SKILL);

/**
 * That folder, with the Skill really in it, so that whoever is handed this path can read what is at the end of it.
 *
 * Nothing is written in source mode — the folder is the tree's. A packaged build writes it out, and only when what is
 * there is not already this: a file written at every start would move its own time for no reason, and an Agent that
 * has the folder linked would see a change that is not one.
 */
export function placeSkill() {
  const folder = skillFolder();
  if (fromSource()) return folder;
  const file = join(folder, "SKILL.md");
  const wanted = assetText(CARRIED);
  try {
    if (readFileSync(file, "utf8") === wanted) return folder;
  } catch {
    // Not there, or not readable: either way what follows is what makes it right.
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(file, wanted);
  return folder;
}
