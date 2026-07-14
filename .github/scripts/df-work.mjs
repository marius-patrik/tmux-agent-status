import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DARK_FACTORY_DATA_REPO,
  WORK_LABELS,
  assertAllowedRepo,
  cleanupTempRoot,
  createGithubClient,
  darkFactoryWorkerIssueNumber,
  ensureLabels,
  findOpenWorkerPullRequestForIssue,
  getRepository,
  isDarkFactoryWorkerPullRequest,
  preflightMergePolicy,
  parseRepo,
  readManagedRepoRegistry,
  repoName,
  requiredEnv,
  sanitize,
  slug,
  taskClassFromLabels,
  writeRunLedger
} from "./df-lib.mjs";
import { evaluateEnforcementRules, loadEnforcementRules } from "./df-enforcement.mjs";

const CONTROL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOKEN = requiredEnv("DARK_FACTORY_TOKEN");
const CONTROL_REPO = parseRepo(requiredEnv("DF_CONTROL_REPO"));
const TARGET_REPO = parseRepo(requiredEnv("DF_TARGET_REPO"));
const TARGET_ISSUE_NUMBER = Number(requiredEnv("DF_TARGET_ISSUE_NUMBER"));
const TARGET_BASE_REF = process.env.DF_TARGET_BASE_REF?.trim() || "";
const RESUME_PR_NUMBER = process.env.DF_RESUME_PR?.trim() ? Number(process.env.DF_RESUME_PR.trim()) : 0;
const RESUME_BRANCH = process.env.DF_RESUME_BRANCH?.trim() || "";
const IS_RESUME = (Number.isInteger(RESUME_PR_NUMBER) && RESUME_PR_NUMBER > 0) || RESUME_BRANCH.length > 0;
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const DATA_REPO = DARK_FACTORY_DATA_REPO;
const GIT_BASIC_AUTH = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
const gh = createGithubClient(TOKEN, "darkfactory-worker");

main().catch((error) => {
  console.error(sanitize(error.stack || error.message || String(error), TOKEN));
  process.exitCode = 1;
});

async function main() {
  canonicalAgentsLauncher();

  if (!Number.isInteger(TARGET_ISSUE_NUMBER) || TARGET_ISSUE_NUMBER <= 0) {
    throw new Error(`Invalid issue number: ${process.env.DF_TARGET_ISSUE_NUMBER}`);
  }

  assertAllowedRepo(TARGET_REPO);

  const issue = await getIssue(TARGET_REPO, TARGET_ISSUE_NUMBER);
  const taskRouting = taskClassFromLabels(issue.labels);
  const target = `${repoName(TARGET_REPO)}#${TARGET_ISSUE_NUMBER}`;
  const resumeInfo = await buildResumeInfo(TARGET_REPO, TARGET_ISSUE_NUMBER);
  const branch = resumeInfo?.branch || `df/${TARGET_ISSUE_NUMBER}-${slug(issue.title)}`;

  const ledger = {
    trigger: TRIGGER,
    issue: target,
    branch,
    status: "started",
    actions: [],
    agent_os: {
      turns: 0,
      note: "Provider, model, identity, memory, and session state are resolved only by the canonical agents launcher."
    }
  };

  ledger.resume = resumeInfo ? { type: resumeInfo.type, branch: resumeInfo.branch } : null;
  let tempRoot = "";
  let pullRequest = null;

  const repo = await getRepository(gh, TARGET_REPO);
  const workBaseBranch = resumeInfo?.baseRef || await resolveWorkBaseBranch(TARGET_REPO, repo.default_branch, TARGET_BASE_REF);
  ledger.base_branch = workBaseBranch;

  const enforcementRules = await loadEnforcementRules(CONTROL_ROOT);
  const enforcement = await evaluateEnforcementRules(enforcementRules, {
    gh,
    repository: TARGET_REPO,
    baseBranch: workBaseBranch,
    registry: await readManagedRepoRegistry(CONTROL_ROOT),
    token: TOKEN
  });
  ledger.actions.push({ action: "enforcement-rules", result: enforcement });
  if (!enforcement.ok) {
    ledger.status = "blocked";
    ledger.error = enforcement.findings.map((finding) => `${finding.rule}: ${finding.message}`).join("\n");
    await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:blocked"], ["df:ready", "df:running", "df:done"]);
    await createIssueComment(
      TARGET_REPO,
      TARGET_ISSUE_NUMBER,
      enforcementBlockedComment(target, workBaseBranch, enforcement)
    );
    return;
  }

  // Ensure work labels exist before any preflight failure path tries to apply
  // `df:blocked` to the issue, so the blocker comment is always left reliably.
  // The control repo labels are best-effort: issue/comment triggers in managed
  // repositories run with the repository token, which cannot write to the
  // control repository.
  try {
    await ensureLabels(gh, CONTROL_REPO, WORK_LABELS);
  } catch (error) {
    console.warn(`Could not ensure labels in ${repoName(CONTROL_REPO)}: ${sanitize(error.message || String(error), TOKEN)}`);
  }
  await ensureLabels(gh, TARGET_REPO, WORK_LABELS);

  if (!resumeInfo) {
    const existingPullRequest = await findOpenWorkerPullRequestForIssue(gh, TARGET_REPO, TARGET_ISSUE_NUMBER);
    if (existingPullRequest) {
      ledger.status = "success";
      ledger.pull_request = existingPullRequest.url;
      ledger.actions.push({
        action: "existing-worker-pr",
        result: "noop",
        url: existingPullRequest.url,
        branch: existingPullRequest.headRefName
      });
      await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:running"], ["df:ready", "df:blocked", "df:done"]);
      await createIssueComment(
        TARGET_REPO,
        TARGET_ISSUE_NUMBER,
        [
          `DarkFactory worker skipped \`${target}\` because an open worker PR already exists.`,
          "",
          `PR: ${existingPullRequest.url || `#${existingPullRequest.number}`}`,
          `Branch: \`${existingPullRequest.headRefName || branch}\``,
          "",
          "No new worker run is needed; follow-through will evaluate the existing PR."
        ].join("\n")
      );
      return;
    }
  }

  const mergePolicy = await preflightMergePolicy(gh, TARGET_REPO, workBaseBranch, repo);
  ledger.actions.push({ action: "preflight-merge-policy", result: mergePolicy });
  if (mergePolicy.blocked) {
    ledger.status = "blocked";
    ledger.error = mergePolicy.reason;
    await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:blocked"], ["df:ready", "df:running", "df:done"]);
    await createIssueComment(
      TARGET_REPO,
      TARGET_ISSUE_NUMBER,
      preflightBlockedComment(target, workBaseBranch, mergePolicy)
    );
    return;
  }

  try {
    verifyAgentOs();
    await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:running"], ["df:ready", "df:blocked", "df:done"]);
    await createIssueComment(
      TARGET_REPO,
      TARGET_ISSUE_NUMBER,
      workerStartedComment(target, branch, taskRouting, mergePolicy.summary, resumeInfo)
    );

    tempRoot = await mkdtemp(path.join(tmpdir(), "df-work-"));
    const worktree = path.join(tempRoot, "repo");

    await cloneRepository(TARGET_REPO, worktree, workBaseBranch);
    if (resumeInfo) {
      if (!(await remoteBranchExists(TARGET_REPO, branch))) {
        throw new Error(`Resume branch \`${branch}\` does not exist on the remote.`);
      }
      runGit(["fetch", "origin", branch], worktree);
      runGit(["checkout", branch], worktree);
    } else {
      if (await remoteBranchExists(TARGET_REPO, branch)) {
        const staleBranchResult = await blockStaleWorkerBranch(branch);
        ledger.status = "blocked";
        ledger.error = staleBranchResult.message;
        ledger.actions.push(staleBranchResult);
        return;
      }
      runGit(["checkout", "-b", branch], worktree);
    }

    const briefInfo = await writeTaskBrief(worktree, issue, workBaseBranch, taskRouting, resumeInfo);
    ledger.agent_os.input_brief_characters = briefInfo.characters;

    await runAgentWorker(worktree);
    ledger.agent_os.turns = 1;

    const summary = await readWorkerSummary(worktree);
    await removeWorkerScratch(worktree);

    const changed = gitOutput(["status", "--porcelain"], worktree);
    if (changed.trim()) {
      runGit(["config", "user.name", "DarkFactory"], worktree);
      runGit(["config", "user.email", "darkfactory@users.noreply.github.com"], worktree);
      runGit(["add", "--all"], worktree);
      runGit(["commit", "-m", `feat: implement issue #${TARGET_ISSUE_NUMBER}`], worktree);
    }

    const ahead = Number(gitOutput(["rev-list", "--count", `origin/${workBaseBranch}..HEAD`], worktree));
    if (!Number.isInteger(ahead) || ahead < 0 || (ahead === 0 && !resumeInfo)) {
      throw new Error("Worker completed without producing a commit.");
    }

    runGit(["push", "origin", `HEAD:refs/heads/${branch}`], worktree);
    pullRequest = await openOrReusePullRequest(TARGET_REPO, workBaseBranch, branch, issue, summary, resumeInfo);
    ledger.pull_request = pullRequest.html_url;

    let automerge;
    try {
      automerge = mergePolicy.useAutomerge
        ? await enableAutoMerge(pullRequest.node_id)
        : { enabled: false, reason: "Direct green-PR sweep will merge after checks because branch protection is not configured." };
    } catch (automergeError) {
      automerge = {
        enabled: false,
        reason: sanitize(automergeError.message || String(automergeError), TOKEN)
      };
    }

    await createIssueComment(
      TARGET_REPO,
      TARGET_ISSUE_NUMBER,
      workerSuccessComment(pullRequest, summary, automerge, resumeInfo)
    );
    ledger.status = "success";
    ledger.actions.push({
      action: resumeInfo ? "resume-pr" : "open-pr",
      url: pullRequest.html_url,
      automerge,
      execution: "agent-os",
      resumed: !!resumeInfo
    });
  } catch (error) {
    ledger.status = "blocked";
    const baseError = sanitize(error.stack || error.message || String(error), TOKEN);
    ledger.error = baseError;
    if (pullRequest) {
      ledger.pull_request = pullRequest.html_url;
    }
    try {
      await markWorkerBlocked(TARGET_REPO, TARGET_ISSUE_NUMBER, ledger.error);
    } catch (updateError) {
      console.warn(`DarkFactory failed to mark issue blocked: ${sanitize(updateError.stack || updateError.message || String(updateError), TOKEN)}`);
    }
    throw error;
  } finally {
    const cleanup = await cleanupTempRoot(tempRoot, (warning) => console.warn(sanitize(warning, TOKEN)));
    ledger.cleanup = cleanup;
    await writeLedger(ledger);
  }
}

function workerStartedComment(target, branch, taskRouting, mergePolicySummary, resumeInfo) {
  const lines = resumeInfo
    ? [
        `DarkFactory worker resumed for \`${target}\` from \`${TRIGGER}\`.`,
        "",
        resumeInfo.type === "pr"
          ? `Resuming against existing PR: ${resumeInfo.pr.html_url || `#${resumeInfo.pr.number}`}`
          : `Resuming from pushed branch: \`${resumeInfo.branch}\``,
        `Branch: \`${branch}\``,
        `Task class: \`${taskRouting.taskClass}\``,
        "Execution authority: canonical Agent OS manager state.",
        `Merge policy: ${mergePolicySummary}`
      ]
    : [
        `DarkFactory worker started for \`${target}\` from \`${TRIGGER}\`.`,
        "",
        `Branch: \`${branch}\``,
        `Task class: \`${taskRouting.taskClass}\``,
        "Execution authority: canonical Agent OS manager state.",
        `Merge policy: ${mergePolicySummary}`
      ];
  return lines.join("\n");
}

function preflightBlockedComment(target, baseBranch, mergePolicy) {
  return [
    `DarkFactory blocked \`${target}\` before cloning or running a worker.`,
    "",
    "Blocker:",
    "",
    "```text",
    mergePolicy.reason,
    "```",
    "",
    `Target branch: \`${baseBranch}\``,
    `Repository auto-merge enabled: \`${mergePolicy.autoMergeSupported ? "yes" : "no"}\``,
    "",
    "This is target repository setup work, not a code implementation failure."
  ].join("\n");
}

function enforcementBlockedComment(target, baseBranch, enforcement) {
  return [
    `DarkFactory enforcement gate blocked \`${target}\` before cloning or running a worker.`,
    "",
    "Target branch:",
    "",
    `\`${baseBranch}\``,
    "",
    "Failed enforcement rules:",
    "",
    ...enforcement.findings
      .filter((finding) => finding.severity === "block")
      .map((finding) => `- **${finding.rule}**: ${finding.message}`),
    "",
    "This is a policy failure, not a code implementation failure."
  ].join("\n");
}

async function getIssue(repository, issueNumber) {
  const issue = await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`);
  if (issue.pull_request) {
    throw new Error(`${repoName(repository)}#${issueNumber} is a pull request, not an issue.`);
  }
  if (issue.state !== "open") {
    throw new Error(`${repoName(repository)}#${issueNumber} is not open.`);
  }
  return issue;
}

async function resolveWorkBaseBranch(repository, defaultBranch, requestedBranch = "") {
  if (requestedBranch) {
    await ensureBranchExists(repository, requestedBranch);
    return requestedBranch;
  }

  try {
    await ensureBranchExists(repository, "dev");
    return "dev";
  } catch (error) {
    if (error.status === 404) return defaultBranch;
    throw error;
  }
}

async function ensureBranchExists(repository, branch) {
  await gh.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeRefPath(branch)}`);
}

async function buildResumeInfo(repository, issueNumber) {
  if (RESUME_PR_NUMBER > 0) {
    const pr = await fetchResumePullRequest(repository, RESUME_PR_NUMBER);
    if (darkFactoryWorkerIssueNumber(pr) !== issueNumber) {
      throw new Error(`Resume PR #${RESUME_PR_NUMBER} is not a worker PR for issue #${issueNumber}`);
    }
    if (!isDarkFactoryWorkerPullRequest(pr, repository)) {
      throw new Error(`Resume PR #${RESUME_PR_NUMBER} is not a DarkFactory worker PR`);
    }
    return {
      type: "pr",
      pr: {
        number: pr.number,
        html_url: pr.html_url,
        node_id: pr.node_id
      },
      branch: pr.headRefName,
      baseRef: pr.baseRefName
    };
  }

  if (RESUME_BRANCH) {
    return { type: "branch", branch: RESUME_BRANCH, baseRef: "" };
  }

  return null;
}

async function fetchResumePullRequest(repository, pullNumber) {
  const pull = await gh.request("GET", `/repos/${repoName(repository)}/pulls/${pullNumber}`);
  if (pull.state !== "open") {
    throw new Error(`Resume PR #${pullNumber} is not open`);
  }
  return {
    number: pull.number,
    html_url: pull.html_url,
    node_id: pull.node_id,
    title: pull.title || "",
    body: pull.body || "",
    headRefName: pull.head?.ref || "",
    baseRefName: pull.base?.ref || "",
    headRepository: {
      name: pull.head?.repo?.name || "",
      owner: { login: pull.head?.repo?.owner?.login || "" }
    },
    author: { login: pull.user?.login || "" }
  };
}

async function openOrReusePullRequest(repository, base, branch, issue, summary, resumeInfo) {
  if (resumeInfo?.type === "pr") {
    return resumeInfo.pr;
  }

  const existing = await findOpenWorkerPullRequestForIssue(gh, repository, TARGET_ISSUE_NUMBER);
  if (existing) return existing;

  return createPullRequest(repository, base, branch, issue, summary);
}

function workerSuccessComment(pullRequest, summary, automerge, resumeInfo) {
  const action = resumeInfo ? "updated" : "opened";
  return [
    `DarkFactory worker ${action} ${pullRequest.html_url}.`,
    "",
    "Execution authority: canonical Agent OS manager state.",
    `Automerge: ${automerge.enabled ? "enabled" : `not enabled (${automerge.reason})`}.`,
    "The issue stays `df:running` until DarkFactory verifies the worker claim against GitHub reality.",
    "",
    "Worker summary:",
    "",
    truncate(summary, 5000)
  ].join("\n");
}

async function replaceIssueLabels(repository, issueNumber, add, remove) {
  if (add.length) {
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/labels`, { labels: add });
  }
  for (const label of remove) {
    try {
      await gh.request("DELETE", `/repos/${repoName(repository)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
}

async function createIssueComment(repository, issueNumber, body) {
  await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, { body });
}

async function markWorkerBlocked(repository, issueNumber, blocker) {
  // Removing df:running releases the stream lane for the next orchestrator tick.
  await replaceIssueLabels(repository, issueNumber, ["df:blocked"], ["df:ready", "df:running", "df:done"]);
  await createIssueComment(
    repository,
    issueNumber,
    [
      "DarkFactory worker blocked.",
      "",
      "Blocker:",
      "",
      "```text",
      truncate(blocker, 6000),
      "```"
    ].join("\n")
  );
}

async function cloneRepository(repository, worktree, branch) {
  const url = `https://github.com/${repoName(repository)}.git`;
  runGitWithAuth(["clone", "--depth", "1", "--branch", branch, url, worktree], process.cwd());
}

async function remoteBranchExists(repository, branch) {
  const refs = await gh.request(
    "GET",
    `/repos/${repoName(repository)}/git/matching-refs/heads/${encodeURIComponent(branch)}`
  );
  return Array.isArray(refs) && refs.some((ref) => ref.ref === `refs/heads/${branch}`);
}

async function blockStaleWorkerBranch(branch) {
  const message = [
    `Stale worker branch exists without an open worker PR. Owner/manual recovery is required.`,
    `Branch: ${branch}`,
    `DarkFactory found the branch before creating a new worker branch, but no open worker PR was found for #${TARGET_ISSUE_NUMBER}.`
  ].join(" ");

  await replaceIssueLabels(TARGET_REPO, TARGET_ISSUE_NUMBER, ["df:ask-owner", "df:blocked"], ["df:ready", "df:running", "df:done"]);
  await createIssueComment(
    TARGET_REPO,
    TARGET_ISSUE_NUMBER,
    [
      "DarkFactory blocked this worker before starting Agent OS execution.",
      "",
      "Blocker:",
      "",
      "```text",
      message,
      "```",
      "",
      "The stale branch must be deleted, connected to an open worker PR, or otherwise resolved by the owner before this issue can be retried."
    ].join("\n")
  );

  const askOwner = await upsertStaleBranchAskOwnerIssue(branch);
  return {
    action: "stale-worker-branch",
    result: "blocked",
    reason: "stale-worker-branch",
    branch,
    issue: `#${TARGET_ISSUE_NUMBER}`,
    ask_owner_issue: askOwner,
    message
  };
}

async function upsertStaleBranchAskOwnerIssue(branch) {
  // Recovery issues live in the CONTROL repository so owner decisions stay on
  // the central DarkFactory queue/dashboard regardless of which managed repo
  // the stale branch belongs to.
  const marker = `<!-- dark-factory:stale-worker-branch repo=${repoName(TARGET_REPO)} issue=${TARGET_ISSUE_NUMBER} branch=${slug(branch)} -->`;
  const title = `DarkFactory stale worker branch: ${repoName(TARGET_REPO)}#${TARGET_ISSUE_NUMBER}`;
  const body = [
    marker,
    "## Owner Decision Required",
    "",
    `Target repository: \`${repoName(TARGET_REPO)}\``,
    `Worker issue: #${TARGET_ISSUE_NUMBER}`,
    `Stale branch: \`${branch}\``,
    "",
    "DarkFactory cannot safely reuse or overwrite this branch because no open worker PR was found for the target issue.",
    "",
    "## Acceptance Criteria",
    "",
    "- Delete the stale branch, restore the missing worker PR, or document why the branch should be preserved.",
    "- Remove `df:ask-owner`/`df:blocked` from the original worker issue and reapply `df:ready` when it is safe to retry.",
    "",
    "## Token Use",
    "",
    "- AI tokens: 0 (deterministic worker preflight)."
  ].join("\n");
  const existing = await findOpenIssueByMarker(CONTROL_REPO, marker);

  if (existing) {
    const updated = await gh.request("PATCH", `/repos/${repoName(CONTROL_REPO)}/issues/${existing.number}`, {
      title,
      body
    });
    // The upsert path must enforce the escalation label on update as well as
    // create, or a recovery issue that lost df:ask-owner disappears from
    // label-driven dashboards and queues.
    await gh.request("POST", `/repos/${repoName(CONTROL_REPO)}/issues/${existing.number}/labels`, {
      labels: ["df:ask-owner"]
    });
    return `#${updated.number || existing.number}`;
  }

  const created = await gh.request("POST", `/repos/${repoName(CONTROL_REPO)}/issues`, {
    title,
    body,
    labels: ["df:ask-owner"]
  });
  return `#${created.number}`;
}

async function findOpenIssueByMarker(repository, marker) {
  for (let page = 1; page <= 10; page += 1) {
    const issues = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues?state=open&per_page=100&page=${page}`
    );
    if (!Array.isArray(issues) || issues.length === 0) break;
    const found = issues.find((issue) => !issue.pull_request && String(issue.body || "").includes(marker));
    if (found) return found;
    if (issues.length < 100) break;
  }
  return null;
}

function buildResumeContext(resumeInfo, defaultBranch) {
  if (!resumeInfo) return "";

  const lines = [
    "## Resume Context",
    "",
    "This worker run is resuming an interrupted previous run. Do not create a new branch or PR."
  ];

  if (resumeInfo.type === "pr") {
    lines.push(`Resuming against existing PR #${resumeInfo.pr.number} (${resumeInfo.pr.html_url}).`);
    lines.push(`Branch: \`${resumeInfo.branch}\`, base: \`${resumeInfo.baseRef}\`.`);
  } else if (resumeInfo.type === "branch") {
    lines.push(`Resuming from pushed branch \`${resumeInfo.branch}\`.`);
    lines.push(`Base: \`${defaultBranch}\`.`);
  }

  lines.push("Focus on the smallest merge-first task: resolve current review findings or get the existing PR green.");
  lines.push("");
  return lines.join("\n");
}

async function writeTaskBrief(worktree, issue, defaultBranch, taskRouting, resumeInfo = null) {
  const scratchDir = path.join(worktree, ".darkfactory");
  await mkdir(scratchDir, { recursive: true });

  const agentsContext = await readOptional(path.join(worktree, "AGENTS.md"));
  const prdContext = await readOptional(path.join(worktree, "PRD.md"));
  const issueLabels = Array.isArray(issue.labels)
    ? issue.labels.map((label) => typeof label === "string" ? label : label.name).filter(Boolean).join(", ")
    : "";

  const resumeContext = buildResumeContext(resumeInfo, defaultBranch);

  const brief = [
    "# DarkFactory Worker Brief",
    "",
    `Target repository: ${repoName(TARGET_REPO)}`,
    `Default branch: ${defaultBranch}`,
    `Issue: #${TARGET_ISSUE_NUMBER}`,
    `Title: ${issue.title}`,
    `Labels: ${issueLabels || "(none)"}`,
    `Task class: ${taskRouting.taskClass}`,
    "",
    "## Contract",
    "",
    "The issue body, especially any Acceptance Criteria section, is the definition of done.",
    "Implement only this issue. Do not push, create pull requests, merge, or force-push; DarkFactory handles GitHub writes after you finish.",
    "Run the repository's documented validation commands before finishing. If validation cannot be run, explain the blocker in the final summary.",
    "Keep secrets out of files and logs.",
    "",
    "## Issue Body",
    "",
    issue.body?.trim() || "(issue body is empty)",
    "",
    "## Acceptance Criteria",
    "",
    extractAcceptanceCriteria(issue.body || "") || "Use the issue body as the acceptance criteria.",
    "",
    resumeContext,
    "## Root AGENTS.md",
    "",
    agentsContext || "(AGENTS.md not present)",
    "",
    "## Root PRD.md",
    "",
    prdContext || "(PRD.md not present)"
  ].join("\n");

  await writeFile(path.join(scratchDir, "df-task-brief.md"), `${brief}\n`);
  return { characters: brief.length };
}

async function readWorkerSummary(worktree) {
  const summary = await readOptional(path.join(worktree, ".darkfactory", "df-worker-summary.md"));
  return summary?.trim() || "Worker completed without a written summary.";
}

async function removeWorkerScratch(worktree) {
  await rm(path.join(worktree, ".darkfactory", "df-task-brief.md"), { force: true });
  await rm(path.join(worktree, ".darkfactory", "df-worker-summary.md"), { force: true });
}

function verifyAgentOs() {
  runAgentCommand(["state", "doctor", "--json"], CONTROL_ROOT);
}

async function runAgentWorker(worktree) {
  const prompt = [
    "Read .darkfactory/df-task-brief.md and implement that task in the current repository.",
    "Use the repository guidance and run its authoritative verification gates.",
    "Do not push, open a pull request, merge, or modify Agent OS state.",
    "Write a concise final summary to .darkfactory/df-worker-summary.md before finishing."
  ].join(" ");
  const output = runAgentCommand(["run", "--mode", "default", prompt], worktree).trim();
  const summaryPath = path.join(worktree, ".darkfactory", "df-worker-summary.md");
  if (!existsSync(summaryPath)) {
    await writeFile(summaryPath, `${output || "Agent OS worker completed without a written summary."}\n`);
  }
}

function agentOsEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|AUTH_JSON|PRIVATE_KEY/i.test(name)) continue;
    env[name] = value;
  }
  return env;
}

function runAgentCommand(args, cwd) {
  const agentsLauncher = canonicalAgentsLauncher();
  return runCommand(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-File", agentsLauncher, ...args],
    cwd,
    agentOsEnvironment()
  );
}

function canonicalAgentsLauncher() {
  const agentsHome = requiredEnv("AGENTS_HOME");
  if (!path.isAbsolute(agentsHome)) {
    throw new Error("AGENTS_HOME must be an absolute path");
  }
  const agentsLauncher = path.join(agentsHome, "bin", "agents.ps1");
  if (!existsSync(agentsLauncher)) {
    throw new Error(`Canonical Agent OS launcher is missing at ${agentsLauncher}`);
  }
  return agentsLauncher;
}

async function createPullRequest(repository, base, branch, issue, summary) {
  return await gh.request("POST", `/repos/${repoName(repository)}/pulls`, {
    title: issue.title,
    head: branch,
    base,
    body: [
      `<!-- dark-factory:worker-pr issue=${TARGET_ISSUE_NUMBER} -->`,
      "## DarkFactory Worker Summary",
      "",
      truncate(summary, 10000),
      "",
      "Executed through the canonical Agent OS manager state.",
      "",
      `Closes #${TARGET_ISSUE_NUMBER}`
    ].join("\n")
  });
}

async function enableAutoMerge(pullRequestId) {
  try {
    await gh.graphql(
      `mutation EnableAutoMerge($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: SQUASH}) {
          pullRequest { url }
        }
      }`,
      { pullRequestId }
    );
    return { enabled: true, reason: "" };
  } catch (error) {
    return { enabled: false, reason: sanitize(error.message || String(error), TOKEN) };
  }
}

function runGit(args, cwd) {
  return runGitWithAuth(args, cwd);
}

function gitOutput(args, cwd) {
  return runGitWithAuth(args, cwd).trim();
}

function runGitWithAuth(args, cwd) {
  return runCommand("git", ["-c", authHeader(), ...args], cwd);
}

function authHeader() {
  return `http.https://github.com/.extraheader=AUTHORIZATION: basic ${GIT_BASIC_AUTH}`;
}

function encodeRefPath(ref) {
  return String(ref || "").split("/").map(encodeURIComponent).join("/");
}

function runCommand(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit ${result.status}\n${sanitize(result.stdout || "", TOKEN)}\n${sanitize(result.stderr || "", TOKEN)}`.trim());
  }
  return result.stdout || "";
}

async function readOptional(filePath) {
  if (!existsSync(filePath)) return "";
  return await readFile(filePath, "utf8");
}

function extractAcceptanceCriteria(body) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+acceptance criteria\s*$/i.test(line.trim()));
  if (start === -1) return "";
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+\S/.test(line.trim())) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[truncated from ${value.length} characters]`;
}

async function writeLedger(ledger) {
  try {
    ledger.ledger = await writeRunLedger(gh, DATA_REPO, "df-work", repoName(TARGET_REPO), ledger);
    console.log(`DarkFactory ledger written to ${ledger.ledger.repository}/${ledger.ledger.path}`);
  } catch (error) {
    console.warn(sanitize(`DarkFactory ledger warning: ${error.message || String(error)}`, TOKEN));
  }
}
