#!/usr/bin/env node
// Keep API credentials in the worker environment; only complete immutable snapshots wake the summarizer.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
type Config = {
  baseUrl: string;
  project?: string;
  projects?: string[];
  userId: number;
  label: string;
  closedUpdatedDays: number;
  timezone: string;
};
type Issue = {
  project_id: number;
  iid: number;
  title: string;
  description: string | null;
  web_url: string;
  state: string;
  updated_at: string;
  author: { id: number };
  assignees: { id: number }[];
  labels: string[];
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const limit = "超過摘要上限（100 個唯一 Issue / 512 KiB），請縮小專案或標籤範圍；不產生部分摘要";
async function main() {
  const token = process.env.GITLAB_TOKEN;
  if (!token?.trim()) throw new Error("請在收集主機的接單服務環境設定 GITLAB_TOKEN");
  if (process.argv.length !== 3) throw new Error("用法：node watch-gitlab-issues.ts <sources.json>");
  let config: Config;
  try {
    config = JSON.parse(readFileSync(process.argv[2], "utf8"));
  } catch {
    throw new Error("無法讀取 sources.json，請檢查路徑與 JSON");
  }
  if (
    !config ||
    !Number.isSafeInteger(config.userId) ||
    config.userId < 1 ||
    typeof config.label !== "string" ||
    !config.label.trim() ||
    /,/.test(config.label) ||
    ["any", "none"].includes(config.label.toLowerCase()) ||
    !Number.isInteger(config.closedUpdatedDays) ||
    config.closedUpdatedDays < 1 ||
    config.closedUpdatedDays > 365 ||
    typeof config.timezone !== "string"
  )
    throw new Error(
      "檢查 sources.json：userId 須為正整數；label 須為單一完整標籤（不含逗號，不能是 Any/None）；closedUpdatedDays 須為 1–365；填寫 timezone",
    );
  if (Object.hasOwn(config, "project") && Object.hasOwn(config, "projects"))
    throw new Error("project 與 projects 不能同時設定；多專案請使用 projects 陣列");
  const given = Object.hasOwn(config, "projects") ? config.projects : [config.project];
  if (
    !Array.isArray(given) ||
    !given.length ||
    given.length > 20 ||
    given.some((p) => typeof p !== "string" || !p.trim())
  )
    throw new Error("projects 須為 1–20 個專案路徑或數字 ID 字串；亦相容 project 單值");
  const requested = [...new Set((given as string[]).map((p) => p.trim()))].sort();
  let host: URL;
  try {
    host = new URL(config.baseUrl);
  } catch {
    throw new Error("GitLab baseUrl 格式錯誤");
  }
  if (
    host.username ||
    host.password ||
    host.search ||
    host.hash ||
    (host.protocol !== "https:" &&
      !(host.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(host.hostname)))
  )
    throw new Error("GitLab baseUrl 必須是 HTTPS 且不含帳密、查詢或 fragment（僅本機測試允許 HTTP）");
  const baseUrl = host.href.replace(/\/+$/, "");
  async function get(url: URL): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "PRIVATE-TOKEN": token! },
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error("GitLab API 連線失敗或逾時（每頁 30 秒）；請檢查網路與公司 CA");
    }
    if (!response.ok)
      throw new Error(`GitLab API HTTP ${response.status}；請檢查 token、專案權限或限流（不自動重試或重新導向）`);
    try {
      return { value: await response.json(), next: response.headers.get("x-next-page") };
    } catch {
      throw new Error("GitLab API 回傳無效 JSON 或讀取逾時");
    }
  }
  const canonical = new Map<number, { id: number; path: string }>();
  for (const name of requested) {
    const { value } = (await get(new URL(`${baseUrl}/api/v4/projects/${encodeURIComponent(name)}`))) as {
      value: { id: number; path_with_namespace: string };
    };
    if (
      !value ||
      !Number.isSafeInteger(value.id) ||
      value.id < 1 ||
      typeof value.path_with_namespace !== "string" ||
      !value.path_with_namespace.trim()
    )
      throw new Error("GitLab API 專案欄位格式錯誤");
    canonical.set(value.id, { id: value.id, path: value.path_with_namespace });
  }
  const projects = [...canonical.values()].sort((a, b) => a.id - b.id);
  const now = new Date();
  let period: string;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: config.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    period = `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    throw new Error("timezone 必須是有效的 IANA 時區，例如 Asia/Taipei");
  }
  // Use a UTC calendar boundary for a stable daily query, separate from the display-period timezone.
  const updatedAfter = new Date(
    Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) - config.closedUpdatedDays * 86400000,
  ).toISOString();
  const issues = new Map<string, Issue & { project: string; reasons: string[] }>();
  const filters = [
    { assignee_id: String(config.userId) },
    { author_id: String(config.userId) },
    { labels: config.label },
  ];
  for (const project of projects)
    for (const state of ["opened", "closed"])
      for (const filter of filters) {
        let page = 1;
        for (;;) {
          const url = new URL(`${baseUrl}/api/v4/projects/${project.id}/issues`);
          for (const [key, value] of Object.entries({
            scope: "all",
            state,
            per_page: "100",
            order_by: "updated_at",
            sort: "asc",
            page: String(page),
            ...(state === "closed" ? { updated_after: updatedAfter } : {}),
            ...filter,
          }))
            url.searchParams.set(key, value!);
          const { value: items, next } = (await get(url)) as { value: unknown; next: string | null };
          if (!Array.isArray(items)) throw new Error("GitLab API 回傳不是 Issue 清單");
          for (const item of items as Issue[]) {
            if (
              !item ||
              !Number.isSafeInteger(item.project_id) ||
              item.project_id < 1 ||
              item.project_id !== project.id ||
              !Number.isSafeInteger(item.iid) ||
              item.iid < 1 ||
              typeof item.title !== "string" ||
              (item.description !== null && typeof item.description !== "string") ||
              !["opened", "closed"].includes(item.state) ||
              !Number.isFinite(Date.parse(item.updated_at)) ||
              !Number.isSafeInteger(item.author?.id) ||
              !Array.isArray(item.assignees) ||
              item.assignees.some((a) => !Number.isSafeInteger(a?.id)) ||
              !Array.isArray(item.labels) ||
              item.labels.some((l) => typeof l !== "string")
            )
              throw new Error("GitLab API Issue 欄位格式錯誤");
            let link: URL;
            try {
              link = new URL(item.web_url);
              if (!["https:", "http:"].includes(link.protocol) || link.username || link.password) throw 0;
            } catch {
              throw new Error("GitLab API Issue 連結格式錯誤");
            }
            const reasons = [
              ...(item.assignees.some((a) => a.id === config.userId) ? ["assignee"] : []),
              ...(item.author.id === config.userId ? ["author"] : []),
              ...(item.labels.includes(config.label) ? ["label"] : []),
            ];
            if (
              !reasons.length ||
              item.state !== state ||
              (state === "closed" && Date.parse(item.updated_at) < Date.parse(updatedAfter))
            )
              continue;
            const key = `${item.project_id}:${item.iid}`;
            const old = issues.get(key);
            if (!old || Date.parse(item.updated_at) >= Date.parse(old.updated_at))
              issues.set(key, {
                project_id: item.project_id,
                project: project.path,
                iid: item.iid,
                title: item.title,
                description: item.description,
                web_url: link.href,
                state: item.state,
                updated_at: item.updated_at,
                author: { id: item.author.id },
                assignees: item.assignees.map((a) => ({ id: a.id })).sort((a, b) => a.id - b.id),
                labels: [...item.labels].sort(),
                reasons,
              });
            if (issues.size > 100) throw new Error(limit);
          }
          if (next === "" || (next === null && items.length < 100)) break;
          const following = next === null ? page + 1 : Number(next);
          if (!Number.isSafeInteger(following) || following <= page) throw new Error("GitLab API 分頁標頭無效");
          page = following;
        }
      }
  const content = {
    period,
    timezone: config.timezone,
    baseUrl,
    projects,
    userId: config.userId,
    label: config.label,
    closedUpdatedDays: config.closedUpdatedDays,
    updatedAfter,
    issues: [...issues.values()].sort((a, b) => a.project_id - b.project_id || a.iid - b.iid),
  };
  const id = hash(content);
  const data = JSON.stringify({ id, collectedAt: now.toISOString(), ...content }, null, 2) + "\n";
  if (Buffer.byteLength(data) > 512 * 1024) throw new Error(limit);
  const folder = "gitlab-inputs";
  mkdirSync(folder, { recursive: true });
  const destination = join(folder, `${id}.json`);
  if (!existsSync(destination)) {
    const temporary = join(folder, `${id}.${process.pid}.tmp`);
    writeFileSync(temporary, data, { mode: 0o600 });
    renameSync(temporary, destination);
  }
  console.log(
    `GitLab 個人 Issue 資料已完整讀取\n\n\`\`\`agent-autoloop\n${JSON.stringify({ events: [{ id, type: "brief.ready", subject: `gitlab-${hash({ baseUrl, projects: projects.map((p) => p.id), userId: config.userId, label: config.label }).slice(0, 32)}`, summary: "GitLab 個人 Issue 摘要資料已備妥" }] })}\n\`\`\``,
  );
}
main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
