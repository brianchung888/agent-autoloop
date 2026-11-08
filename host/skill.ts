// Where the Skill is: the folder an Agent's own `skills/` is linked to, so that the Agent knows what this program can
// do. One place says where, because three things have to agree about it — what the install links (cli/main.ts:
// linkSkill), what `doctor` tells someone to read, and what `uninstall` takes away again.
//
// There are two manuals, one per language (host/assets.ts), and an Agent reads whichever is at `SKILL.md`. So this also
// decides which of the two that is: `lang()` at the moment it is asked, which is the same answer every sentence of this
// run gets. `SKILL.md` in the tree is the 简体 one — the manual was written in it — so a 简体 source install is the one
// case where the folder in the tree already is what an Agent should read, and nothing is written.
//
// Anywhere else the wanted manual is not at that name yet, and it is written out under this install's own HOME — the
// first place that is this install's and that an Agent's `skills/` can be linked to. A packaged build has no folder at
// all (PoC: `doctor` named `C:\tmp\skills\agent-autoloop\SKILL.md`, the executable's parent folder, where there was
// nothing); a 正體 source install has one, but writing into it would be writing into somebody's checkout, which
// `agent-autoloop update` pulls over.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetText, type Asset } from "./assets.ts";
import { HOME } from "./home.ts";
import { lang, type Lang } from "./i18n.ts";
import { fromSource } from "./self.ts";

/** The Skill's one name, which is also the folder's, in both places it can be. */
export const SKILL = "agent-autoloop";
/** What a packaged build carries each of them as. The same paths the repository spells them by (host/assets.ts). */
const CARRIED: Record<Lang, Asset> = {
  "zh-CN": "skills/agent-autoloop/SKILL.md",
  "zh-TW": "skills/agent-autoloop/SKILL.zh-TW.md",
};
/** Which language the tree's own `SKILL.md` is already in: the one the manual was written in. */
const WRITTEN_IN: Lang = "zh-CN";

/** Whether the folder in the tree is already what an Agent should read, so that nothing has to be written. */
const inTree = () => fromSource() && lang() === WRITTEN_IN;

/** Where this build's own copy of the Skill is, whether or not it is there yet. */
export const skillFolder = () =>
  inTree() ? join(import.meta.dirname, "..", "skills", SKILL) : join(HOME, "skills", SKILL);

/**
 * That folder, with the Skill really in it, so that whoever is handed this path can read what is at the end of it.
 *
 * Nothing is written for a 简体 source install — the folder is the tree's. Every other case writes it out, and only
 * when what is there is not already this: a file written at every start would move its own time for no reason, and an
 * Agent that has the folder linked would see a change that is not one. Which also makes `agent-autoloop lang` enough
 * on its own — the next `up` or `init` finds the other language's bytes there and replaces them.
 */
export function placeSkill() {
  const folder = skillFolder();
  if (inTree()) return folder;
  const file = join(folder, "SKILL.md");
  const wanted = assetText(CARRIED[lang()]);
  try {
    if (readFileSync(file, "utf8") === wanted) return folder;
  } catch {
    // Not there, or not readable: either way what follows is what makes it right.
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(file, wanted);
  return folder;
}
