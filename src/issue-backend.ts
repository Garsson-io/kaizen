/**
 * issue-backend.ts — Pluggable issue tracking backend for kaizen.
 *
 * Kaizen needs to create, list, view, edit, and comment on issues.
 * The default backend is GitHub (via `gh` CLI). Host projects can
 * configure a different backend (e.g., Linear) in kaizen.config.json:
 *
 *   {
 *     "issues": {
 *       "backend": "github",          // "github" | "linear" | "custom"
 *       "config": {                    // backend-specific config
 *         "customCli": "my-issue-cli"  // for "custom" backend
 *       }
 *     }
 *   }
 *
 * Usage from TypeScript:
 *   const backend = createIssueBackend(config);
 *   const issues = await backend.list({ state: "open", labels: ["kaizen"] });
 *
 * Usage from shell (via CLI):
 *   npx tsx src/issue-backend.ts list --state open --label kaizen --repo Garsson-io/kaizen
 *   npx tsx src/issue-backend.ts create --title "fix: bug" --body "description" --label kaizen
 *   npx tsx src/issue-backend.ts view 42 --repo Garsson-io/kaizen
 *   npx tsx src/issue-backend.ts edit 42 --add-label status:active
 *   npx tsx src/issue-backend.ts comment 42 --body "Working on this"
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

// ── Types ──

export interface Issue {
  number: number;
  title: string;
  state: string;
  labels: string[];
  body: string;
  url: string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
}

interface CreateIssueOpts {
  title: string;
  body: string;
  labels?: string[];
  repo?: string;
}

interface ListIssuesOpts {
  state?: "open" | "closed" | "all";
  labels?: string[];
  search?: string;
  limit?: number;
  repo?: string;
  json?: string[];
}

interface EditIssueOpts {
  number: number;
  addLabels?: string[];
  removeLabels?: string[];
  body?: string;
  repo?: string;
}

interface CommentOpts {
  number: number;
  body: string;
  repo?: string;
}

interface CreateResult {
  number: number;
  url: string;
}

// ── Backend Interface ──

interface IssueBackend {
  readonly name: string;

  create(opts: CreateIssueOpts): CreateResult;
  list(opts: ListIssuesOpts): Issue[];
  view(number: number, repo?: string): Issue;
  edit(opts: EditIssueOpts): void;
  comment(opts: CommentOpts): void;
  close(number: number, repo?: string): void;
}

// ── Shared helpers ──

/** Normalize a raw gh JSON issue into our Issue type. */
function parseRawIssue(r: Record<string, any>): Issue {
  return {
    number: r.number,
    title: r.title,
    state: r.state ?? "open",
    labels: (r.labels ?? []).map((l: any) => typeof l === "string" ? l : l.name),
    body: r.body ?? "",
    url: r.url ?? "",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    closedAt: r.closedAt,
  };
}

/** Shell-safe exec: quotes args containing spaces. */
function shellExec(bin: string, args: string[]): string {
  const cmd = `${bin} ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`;
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// ── GitHub Backend (default) ──

export class GitHubBackend implements IssueBackend {
  readonly name = "github";

  private gh(args: string[]): string {
    return shellExec("gh", args);
  }

  create(opts: CreateIssueOpts): CreateResult {
    const args = ["issue", "create"];
    if (opts.repo) args.push("--repo", opts.repo);
    args.push("--title", opts.title);
    args.push("--body", opts.body);
    for (const label of opts.labels ?? []) {
      args.push("--label", label);
    }
    const url = this.gh(args);
    const match = url.match(/\/(\d+)$/);
    return { number: match ? parseInt(match[1], 10) : 0, url };
  }

  list(opts: ListIssuesOpts): Issue[] {
    const args = ["issue", "list"];
    if (opts.repo) args.push("--repo", opts.repo);
    if (opts.state) args.push("--state", opts.state);
    for (const label of opts.labels ?? []) {
      args.push("--label", label);
    }
    if (opts.search) args.push("--search", opts.search);
    args.push("--limit", String(opts.limit ?? 50));

    const jsonFields = opts.json ?? ["number", "title", "state", "labels", "body", "url", "createdAt", "updatedAt"];
    args.push("--json", jsonFields.join(","));

    const output = this.gh(args);
    if (!output) return [];
    return (JSON.parse(output) as any[]).map(parseRawIssue);
  }

  view(number: number, repo?: string): Issue {
    const args = ["issue", "view", String(number)];
    if (repo) args.push("--repo", repo);
    args.push("--json", "number,title,state,labels,body,url,createdAt,updatedAt,closedAt");
    return parseRawIssue(JSON.parse(this.gh(args)));
  }

  edit(opts: EditIssueOpts): void {
    const args = ["issue", "edit", String(opts.number)];
    if (opts.repo) args.push("--repo", opts.repo);
    for (const label of opts.addLabels ?? []) {
      args.push("--add-label", label);
    }
    for (const label of opts.removeLabels ?? []) {
      args.push("--remove-label", label);
    }
    if (opts.body !== undefined) args.push("--body", opts.body);
    this.gh(args);
  }

  comment(opts: CommentOpts): void {
    const args = ["issue", "comment", String(opts.number)];
    if (opts.repo) args.push("--repo", opts.repo);
    args.push("--body", opts.body);
    this.gh(args);
  }

  close(number: number, repo?: string): void {
    const args = ["issue", "close", String(number)];
    if (repo) args.push("--repo", repo);
    this.gh(args);
  }
}

// ── Custom CLI Backend ──

/**
 * Wraps a custom CLI that follows the kaizen issue protocol:
 *   <cli> create --title "..." --body "..." --label "..." → JSON { number, url }
 *   <cli> list --state open --label "..." --limit 50 → JSON array of issues
 *   <cli> view <number> → JSON issue
 *   <cli> edit <number> --add-label "..." → void
 *   <cli> comment <number> --body "..." → void
 *   <cli> close <number> → void
 */
export class CustomCliBackend implements IssueBackend {
  readonly name = "custom";
  private cli: string;

  constructor(cli: string) {
    this.cli = cli;
  }

  private run(args: string[]): string {
    return shellExec(this.cli, args);
  }

  create(opts: CreateIssueOpts): CreateResult {
    const args = ["create", "--title", opts.title, "--body", opts.body];
    for (const label of opts.labels ?? []) args.push("--label", label);
    if (opts.repo) args.push("--repo", opts.repo);
    return JSON.parse(this.run(args));
  }

  list(opts: ListIssuesOpts): Issue[] {
    const args = ["list"];
    if (opts.state) args.push("--state", opts.state);
    for (const label of opts.labels ?? []) args.push("--label", label);
    if (opts.search) args.push("--search", opts.search);
    args.push("--limit", String(opts.limit ?? 50));
    if (opts.repo) args.push("--repo", opts.repo);
    return JSON.parse(this.run(args));
  }

  view(number: number, repo?: string): Issue {
    const args = ["view", String(number)];
    if (repo) args.push("--repo", repo);
    return JSON.parse(this.run(args));
  }

  edit(opts: EditIssueOpts): void {
    const args = ["edit", String(opts.number)];
    for (const label of opts.addLabels ?? []) args.push("--add-label", label);
    for (const label of opts.removeLabels ?? []) args.push("--remove-label", label);
    if (opts.body !== undefined) args.push("--body", opts.body);
    if (opts.repo) args.push("--repo", opts.repo);
    this.run(args);
  }

  comment(opts: CommentOpts): void {
    const args = ["comment", String(opts.number), "--body", opts.body];
    if (opts.repo) args.push("--repo", opts.repo);
    this.run(args);
  }

  close(number: number, repo?: string): void {
    const args = ["close", String(number)];
    if (repo) args.push("--repo", repo);
    this.run(args);
  }
}

// ── Config & Factory ──

export interface IssueBackendConfig {
  backend: "github" | "custom";
  config?: {
    customCli?: string;
  };
}

export function readIssueConfig(projectRoot?: string): IssueBackendConfig {
  const root = projectRoot ?? process.cwd();
  const configPath = join(root, "kaizen.config.json");

  if (!existsSync(configPath)) {
    return { backend: "github" };
  }

  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const issues = config.issues ?? {};

  return {
    backend: issues.backend ?? "github",
    config: issues.config,
  };
}

export function createIssueBackend(config?: IssueBackendConfig): IssueBackend {
  const resolved = config ?? readIssueConfig();

  switch (resolved.backend) {
    case "custom": {
      const cli = resolved.config?.customCli;
      if (!cli) throw new Error("Custom issue backend requires issues.config.customCli in kaizen.config.json");
      return new CustomCliBackend(cli);
    }
    case "github":
    default:
      return new GitHubBackend();
  }
}

// ── CLI entrypoint ──

if (process.argv[1]?.endsWith("issue-backend.ts") || process.argv[1]?.endsWith("issue-backend.js")) {
  const subcommand = process.argv[2];
  if (!subcommand || subcommand === "--help") {
    console.log(`Usage: npx tsx src/issue-backend.ts <command> [options]

Commands:
  create  --title "..." --body "..." [--label "..."] [--repo "..."]
  list    [--state open|closed] [--label "..."] [--search "..."] [--limit N] [--repo "..."]
  view    <number> [--repo "..."]
  edit    <number> [--add-label "..."] [--remove-label "..."] [--body "..."] [--repo "..."]
  comment <number> --body "..." [--repo "..."]
  close   <number> [--repo "..."]
  backend                     Print the configured backend name`);
    process.exit(0);
  }

  const backend = createIssueBackend();

  try {
    if (subcommand === "backend") {
      console.log(JSON.stringify({ backend: backend.name }));
    } else if (subcommand === "create") {
      const { values } = parseArgs({
        args: process.argv.slice(3),
        options: {
          title: { type: "string" },
          body: { type: "string" },
          label: { type: "string", multiple: true },
          repo: { type: "string" },
        },
      });
      const result = backend.create({
        title: values.title!,
        body: values.body!,
        labels: values.label as string[],
        repo: values.repo as string,
      });
      console.log(JSON.stringify(result));
    } else if (subcommand === "list") {
      const { values } = parseArgs({
        args: process.argv.slice(3),
        options: {
          state: { type: "string" },
          label: { type: "string", multiple: true },
          search: { type: "string" },
          limit: { type: "string" },
          repo: { type: "string" },
        },
      });
      const issues = backend.list({
        state: values.state as any,
        labels: values.label as string[],
        search: values.search as string,
        limit: values.limit ? parseInt(values.limit as string, 10) : undefined,
        repo: values.repo as string,
      });
      console.log(JSON.stringify(issues));
    } else if (subcommand === "view") {
      const num = parseInt(process.argv[3], 10);
      const { values } = parseArgs({
        args: process.argv.slice(4),
        options: { repo: { type: "string" } },
      });
      const issue = backend.view(num, values.repo as string);
      console.log(JSON.stringify(issue));
    } else if (subcommand === "edit") {
      const num = parseInt(process.argv[3], 10);
      const { values } = parseArgs({
        args: process.argv.slice(4),
        options: {
          "add-label": { type: "string", multiple: true },
          "remove-label": { type: "string", multiple: true },
          body: { type: "string" },
          repo: { type: "string" },
        },
      });
      backend.edit({
        number: num,
        addLabels: values["add-label"] as string[],
        removeLabels: values["remove-label"] as string[],
        body: values.body as string,
        repo: values.repo as string,
      });
    } else if (subcommand === "comment") {
      const num = parseInt(process.argv[3], 10);
      const { values } = parseArgs({
        args: process.argv.slice(4),
        options: {
          body: { type: "string" },
          repo: { type: "string" },
        },
      });
      backend.comment({ number: num, body: values.body!, repo: values.repo as string });
    } else if (subcommand === "close") {
      const num = parseInt(process.argv[3], 10);
      const { values } = parseArgs({
        args: process.argv.slice(4),
        options: { repo: { type: "string" } },
      });
      backend.close(num, values.repo as string);
    } else {
      console.error(`Unknown command: ${subcommand}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
}
