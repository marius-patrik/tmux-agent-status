import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DATA_REPO,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  ensureLabels,
  findOpenWorkerPullRequestForIssue,
  getRepository,
  listActiveManagedRepos,
  parseRepo,
  preflightMergePolicy,
  repoName,
  requiredEnv,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";

const CONTROL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const token = requiredEnv("DARK_FACTORY_TOKEN");
  const controlRepo = parseRepo(requiredEnv("DF_CONTROL_REPO"));
  const dataRepo = process.env.DF_DATA_REPO ?? DEFAULT_DATA_REPO;
  const trigger = process.env.DF_TRIGGER ?? "unknown";
  const gh = createGithubClient(token, "darkfactory-orchestrate");

  await orchestrate({ gh, controlRepo, dataRepo, trigger, root: CONTROL_ROOT });
}

export async function orchestrate(options) {
  const {
    gh,
    controlRepo,
    dataRepo = DEFAULT_DATA_REPO,
    trigger = "unknown",
    root = CONTROL_ROOT,
    registry,
    repositories,
    writeLedger: shouldWriteLedger = true,
    warn = console.warn,
    log = console.log
  } = options;

  assertAllowedRepo(controlRepo);
  const targets = await targetRepositories(gh, controlRepo, { root, registry, repositories, warn });
  const dispatched = [];

  for (const target of targets) {
    try {
      const ready = await listReadyIssues(gh, target);
      for (const issue of ready) {
        try {
          const wasDispatched = await dispatchWorker(gh, controlRepo, target, issue.number);
          if (wasDispatched) dispatched.push({ repo: repoName(target), issue: issue.number });
        } catch (error) {
          if (warnReadOnlyRepository(target, error, "worker dispatch")) continue;
          warn(`Failed to dispatch worker for ${repoName(target)}#${issue.number}: ${error.message || String(error)}`);
        }
      }
    } catch (error) {
      if (warnReadOnlyRepository(target, error, "orchestration")) continue;
      warn(`Failed to orchestrate ${repoName(target)}: ${error.message || String(error)}`);
    }
  }

  const ledger = {
    trigger,
    control_repo: repoName(controlRepo),
    dispatched,
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Orchestrator dispatch is deterministic and uses no model calls"
    }
  };

  if (shouldWriteLedger) {
    await writeLedger(gh, dataRepo, controlRepo, ledger, warn, log);
  }
  log(`DarkFactory orchestrator dispatched ${dispatched.length} worker runs.`);
  return { dispatched, ledger };
}

export async function targetRepositories(gh, controlRepo, options = {}) {
  return await listActiveManagedRepos(gh, controlRepo, options);
}

export async function listReadyIssues(gh, repository) {
  const issues = [];
  for (let page = 1; page <= 20; page += 1) {
    const labels = encodeURIComponent("df:ready");
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues?state=open&labels=${labels}&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) break;
  }

  return issues.filter((issue) => {
    const names = new Set(
      (issue.labels || []).map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean)
    );
    if (!names.has("df:ready")) return false;
    if (names.has("df:running") || names.has("df:blocked") || names.has("df:done")) return false;
    return true;
  });
}

export async function dispatchWorker(gh, controlRepo, repository, issueNumber) {
  const existingPullRequest = await findOpenWorkerPullRequestForIssue(gh, repository, issueNumber);
  if (existingPullRequest) {
    await replaceIssueLabels(gh, repository, issueNumber, ["df:running"], ["df:ready"]);
    return false;
  }

  const repo = await getRepository(gh, repository);
  const workBaseBranch = await resolveWorkBaseBranch(gh, repository, repo.default_branch);
  const mergePolicy = await preflightMergePolicy(gh, repository, workBaseBranch, repo);
  if (mergePolicy.blocked) {
    await blockIssueBeforeDispatch(gh, repository, issueNumber, workBaseBranch, mergePolicy);
    return false;
  }

  // Claim the issue before dispatch so a subsequent orchestrator tick cannot
  // re-dispatch the same ready issue while the worker workflow is starting.
  await replaceIssueLabels(gh, repository, issueNumber, ["df:running"], ["df:ready"]);
  try {
    await gh.request("POST", `/repos/${repoName(controlRepo)}/actions/workflows/df-work.yml/dispatches`, {
      ref: "main",
      inputs: {
        repo: repoName(repository),
        issue_number: String(issueNumber)
      }
    });
  } catch (error) {
    // Restore df:ready so the next orchestrator tick can retry; do not leave
    // the issue stranded in df:running when dispatch failed.
    await replaceIssueLabels(gh, repository, issueNumber, ["df:ready"], ["df:running"]);
    throw error;
  }
  return true;
}

async function resolveWorkBaseBranch(gh, repository, defaultBranch) {
  try {
    await gh.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeURIComponent("dev")}`);
    return "dev";
  } catch (error) {
    if (error.status === 404) return defaultBranch;
    throw error;
  }
}

async function blockIssueBeforeDispatch(gh, repository, issueNumber, baseBranch, mergePolicy) {
  await ensureLabels(gh, repository, WORK_LABELS);
  await replaceIssueLabels(gh, repository, issueNumber, ["df:blocked"], ["df:ready", "df:running", "df:done"]);
  await createIssueComment(
    gh,
    repository,
    issueNumber,
    [
      "DarkFactory blocked this issue before worker dispatch.",
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
    ].join("\n")
  );
}

async function replaceIssueLabels(gh, repository, issueNumber, add, remove) {
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

async function createIssueComment(gh, repository, issueNumber, body) {
  await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, { body });
}

async function writeLedger(gh, dataRepo, controlRepo, ledger, warn = console.warn, log = console.log) {
  try {
    const written = await writeRunLedger(gh, dataRepo, "df-orchestrate", repoName(controlRepo), ledger);
    log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}
