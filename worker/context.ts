// Context-only copies share the rule's workspace trust domain; they do not grant access to private run files.
import { mkdtempSync, writeFileSync, realpathSync, lstatSync, rmSync } from "node:fs";
import path from "node:path";
import type { Job } from "../protocol/job.ts";
import { spawnSync } from "node:child_process";
const PREFIX = ".agent-autoloop-context-";
export type ContextCopy = { cwd: string; root: string; folder: string; file: string };
export function copyContext(cwd: string, context: Job["context"]): ContextCopy {
  const workspace = realpathSync(cwd);
  const metadata = spawnSync("git", ["-C", workspace, "rev-parse", "--absolute-git-dir"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const root = metadata.status === 0 ? realpathSync(metadata.stdout.trim()) : workspace;
  const folder = mkdtempSync(path.join(root, PREFIX));
  const copy = { cwd: workspace, root, folder, file: path.join(folder, "context.json") };
  try {
    const { events, answers, timers, waiting, open, decided } = context;
    writeFileSync(copy.file, JSON.stringify({ events, answers, timers, waiting, open, decided }), {
      mode: 0o600,
      flag: "wx",
    });
    return copy;
  } catch (error) {
    removeContext(copy);
    throw error;
  }
}
export function removeContext(copy: ContextCopy) {
  const folder = path.resolve(copy.folder);
  if (
    path.dirname(folder) !== copy.root ||
    !new RegExp(`^\\${PREFIX}[a-zA-Z0-9]+$`).test(path.basename(folder)) ||
    copy.file !== path.join(folder, "context.json")
  )
    throw new Error("Invalid context-copy cleanup path");
  const entry = lstatSync(folder, { throwIfNoEntry: false });
  if (!entry) return;
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    realpathSync(folder) !== folder ||
    realpathSync(copy.cwd) !== copy.cwd ||
    realpathSync(copy.root) !== copy.root
  )
    throw new Error("Context-copy cleanup refuses a redirected path");
  rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
}
