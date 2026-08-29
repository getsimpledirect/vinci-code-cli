#!/usr/bin/env node
// Stateful fake gh for publisher tests. PRs persist in FAKE_GH_STATE (JSON) across calls, so a
// test can assert PR CARDINALITY after retries. Models the real gh/GitHub shapes the publisher
// relies on: `pr list --head X` matches EVERY repo whose head branch is named X (forks too — gh
// issue #10945), and a PR's headRefOid is whatever the origin's branch currently points at
// (GitHub moves the PR head when the branch is pushed), unless the seeded PR pins one.
//   env: FAKE_GH_STATE   path of the JSON state file  ({ next, prs: [...] })
//        FAKE_GH_ORIGIN  bare origin dir used to resolve headRefOid for un-pinned PRs
//        FAKE_GH_OWNER   the origin's owner (created PRs and default seeds belong to it)
//        FAKE_GH_RECORD  argv log (one JSON line per call)
//        FAKE_GH_CREATE_EXIT  force `pr create` to fail with that status
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
if (process.env.FAKE_GH_RECORD) appendFileSync(process.env.FAKE_GH_RECORD, JSON.stringify(argv) + "\n");
const statePath = process.env.FAKE_GH_STATE;
const owner = process.env.FAKE_GH_OWNER || "test";
const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { next: 100, prs: [] };
const save = () => statePath && writeFileSync(statePath, JSON.stringify(state, null, 2));
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const originSha = (branch) => {
  try { return execFileSync("git", ["--git-dir", process.env.FAKE_GH_ORIGIN, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null; } catch { return null; }
};
const view = (pr) => ({
  number: pr.number, url: pr.url, state: pr.state, headRefName: pr.headRefName, baseRefName: pr.baseRefName,
  headRepositoryOwner: { login: pr.owner }, body: pr.body ?? "",
  headRefOid: pr.pinnedHead ?? (pr.owner === owner ? originSha(pr.headRefName) : pr.forkHead ?? "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0"),
});

if (argv[0] !== "pr") process.exit(1);
if (argv[1] === "list") {
  const head = flag("--head"); const want = (flag("--state") || "open").toUpperCase();
  const rows = state.prs.filter((pr) => pr.headRefName === head && (want === "ALL" || pr.state === want)).map(view);
  console.log(JSON.stringify(rows)); process.exit(0);
}
if (argv[1] === "view") {
  const pr = state.prs.find((entry) => entry.url === argv[2] || String(entry.number) === argv[2]);
  if (!pr) { console.error("no pull requests found"); process.exit(1); }
  console.log(JSON.stringify(view(pr))); process.exit(0);
}
if (argv[1] === "create") {
  if (process.env.FAKE_GH_CREATE_EXIT) { console.error("gh: create failed (forced)"); process.exit(Number(process.env.FAKE_GH_CREATE_EXIT)); }
  const head = flag("--head"); const base = flag("--base");
  const existing = state.prs.find((pr) => pr.headRefName === head && pr.owner === owner && pr.state === "OPEN");
  if (existing) { console.error(`a pull request for branch "${head}" into branch "${base}" already exists:\n${existing.url}`); process.exit(1); }
  const number = state.next++;
  const pr = { number, url: `https://github.com/${owner}/repo/pull/${number}`, state: "OPEN", headRefName: head, baseRefName: base, owner, body: flag("--body") ?? "" };
  state.prs.push(pr); save();
  console.log(pr.url); process.exit(0);
}
process.exit(1);
