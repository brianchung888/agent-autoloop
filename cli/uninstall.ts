// `agent-autoloop uninstall`: takes away what the install put on this computer and nothing else. A link is ours only if it really
// leads to this program: someone else's agent-autoloop, or a folder of their own by that name, stays where it is.
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "../host/home.ts";
import { selfProgram } from "../host/self.ts";
import { removeService, stopUp } from "../host/service.ts";

const ROOT = path.join(import.meta.dirname, "..");

function removeLink(link: string, target: string) {
  if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  try {
    if (realpathSync(link) !== realpathSync(target)) return;
  } catch {
    return; // It leads nowhere, so not here.
  }
  // Not rmSync: Node 25.1 refuses it for a link that leads to a folder.
  unlinkSync(link);
  console.log(`删掉了 ${link}`);
}

/**
 * A shim is not a link: Windows cannot make one without being allowed to, so the install writes a little file that
 * names this program instead. It is ours only if that is the program it names — someone else's by that name stays.
 */
function removeShim(shim: string, program: string) {
  if (!existsSync(shim)) return;
  try {
    if (!readFileSync(shim, "utf8").includes(program)) return;
  } catch {
    return;
  }
  rmSync(shim, { force: true });
  console.log(`删掉了 ${shim}`);
}

/** Where an install puts something on PATH. The two Homebrew folders mean nothing off a Mac, and no shim goes there. */
const placesOnPath = () => {
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter((place) => path.isAbsolute(place));
  const usual =
    process.platform === "win32"
      ? [path.join(homedir(), ".local", "bin")]
      : [path.join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return new Set([...usual, ...onPath]);
};

/** How the install last put the skill into each Agent's folder. Nothing written down means: by a link. */
function skillWays(): Record<string, string> {
  try {
    const read = JSON.parse(readFileSync(path.join(HOME, "skill-link.json"), "utf8"));
    return typeof read === "object" && read !== null && !Array.isArray(read) ? read : {};
  } catch {
    return {};
  }
}

/** A copy of ours, and only that: the same SKILL.md, word for word. Anything someone has made their own stays. */
function removeCopiedSkill(folder: string, skill: string) {
  if (!existsSync(folder)) return;
  try {
    const here = readFileSync(path.join(folder, "SKILL.md"), "utf8");
    if (here !== readFileSync(path.join(skill, "SKILL.md"), "utf8")) return;
  } catch {
    return;
  }
  rmSync(folder, { recursive: true, force: true });
  console.log(`删掉了 ${folder}`);
}

function removeLinks() {
  // What a shim or a link has to name for it to be this install's and not somebody else's: the one word that is this
  // install (host/self.ts). The entry script in source mode, as it has always been; the executable in a packaged build.
  const program = selfProgram();
  const places = placesOnPath();
  for (const place of places) {
    if (process.platform === "win32") {
      // What install.ps1 writes, and what npm would have written beside it.
      for (const shim of ["agent-autoloop.cmd", "agent-autoloop.ps1"]) removeShim(path.join(place, shim), program);
    }
    removeLink(path.join(place, "agent-autoloop"), program);
  }
  const skill = path.join(ROOT, "skills", "agent-autoloop");
  // Where a link could not be made the install copied the folder, and said so. A copy leads nowhere, so nothing about
  // the folder itself can say whose it is: what the install wrote down is the only thing that can.
  const ways = skillWays();
  for (const agent of [".claude", ".codex"]) {
    const link = path.join(homedir(), agent, "skills", "agent-autoloop");
    if (ways[agent] === "copy") removeCopiedSkill(link, skill);
    else removeLink(link, skill);
  }
  rmSync(path.join(HOME, "skill-link.json"), { force: true });
}

/** Confirmation is about removing the program; data is never part of this command. */
export async function uninstall(yes: boolean, ask: ((question: string) => Promise<string>) | null) {
  if (!yes) {
    if (!ask) throw new Error("运行 agent-autoloop uninstall --yes 卸载程序，规则、密钥和记录会保留。");
    if (!/^y(es)?$/i.test((await ask("卸载程序并保留数据？[y/N] ")).trim())) {
      console.log("没有卸载。");
      return;
    }
  }
  removeService();
  stopUp();
  removeLinks();
  const installedApp = path.join(HOME, "app");
  if (existsSync(installedApp) && realpathSync(installedApp) === realpathSync(ROOT)) {
    rmSync(installedApp, { recursive: true });
  }
  console.log(existsSync(HOME) ? `卸载好了。规则、密钥和记录还留在 ${HOME}。` : "卸载好了。");
}
