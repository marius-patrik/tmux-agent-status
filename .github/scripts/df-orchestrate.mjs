import {
  DEFAULT_DATA_REPO,
  assertAllowedRepo,
  createGithubClient,
  isParkedRepo,
  parseRepo,
  repoName,
  requiredEnv,
  writeRunLedger
} from "./df-lib.mjs";

const TOKEN = requiredEnv("DARK_FACTORY_TOKEN");
const CONTROL_REPO = parseRepo(requiredEnv("DF_CONTROL_REPO"));
const DATA_REPO = process.env.DF_DATA_REPO ?? DEFAULT_DATA_REPO;
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const gh = createGithubClient(TOKEN, "darkfactory-orchestrate");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  assertAllowedRepo(CONTROL_REPO);
  const targets = await targetRepositories();
  const dispatched = [];

  for (const target of targets) {
    if (isParkedRepo(target)) continue;
    const ready = await listReadyIssues(target);
    for (const issue of ready) {
      try {
        await dispatchWorker(target, issue.number);
        dispatched.push({ repo: repoName(target), issue: issue.number });
      } catch (error) {
        console.warn(`Failed to dispatch worker for ${repoName(target)}#${issue.number}: ${error.message || String(error)}`);
      }
    }
  }

  const ledger = {
    trigger: TRIGGER,
    control_repo: repoName(CONTROL_REPO),
    dispatched,
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Orchestrator dispatch is deterministic and uses no model calls"
    }
  };

  await writeLedger(ledger);
  console.log(`DarkFactory orchestrator dispatched ${dispatched.length} worker runs.`);
}

async function targetRepositories() {
  const repositories = [];
  for (let page = 1; page <= 20; page += 1) {
    const data = await gh.request("GET", `/installation/repositories?per_page=100&page=${page}`);
    if (!Array.isArray(data.repositories) || data.repositories.length === 0) break;
    repositories.push(...data.repositories);
    if (data.repositories.length < 100) break;
  }
  return repositories
    .map((repo) => parseRepo(repo.full_name))
    .filter((repo) => repo.owner === CONTROL_REPO.owner);
}

async function listReadyIssues(repository) {
  const issues = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues?state=open&labels=df:ready&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) break;
  }

  return issues.filter((issue) => {
    const body = issue.body || "";
    if (!/df-prd:[a-z0-9-]+/.test(body)) return false;
    const names = new Set(
      (issue.labels || []).map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean)
    );
    if (names.has("df:running") || names.has("df:blocked") || names.has("df:done")) return false;
    return true;
  });
}

async function dispatchWorker(repository, issueNumber) {
  // Claim the issue before dispatch so a subsequent orchestrator tick cannot
  // re-dispatch the same ready issue while the worker workflow is starting.
  await replaceIssueLabels(repository, issueNumber, ["df:running"], ["df:ready"]);
  try {
    await gh.request("POST", `/repos/${repoName(CONTROL_REPO)}/actions/workflows/df-work.yml/dispatches`, {
      ref: "main",
      inputs: {
        repo: repoName(repository),
        issue_number: String(issueNumber)
      }
    });
  } catch (error) {
    // Restore df:ready so the next orchestrator tick can retry; do not leave
    // the issue stranded in df:running when dispatch failed.
    await replaceIssueLabels(repository, issueNumber, ["df:ready"], ["df:running"]);
    throw error;
  }
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

async function writeLedger(ledger) {
  try {
    const written = await writeRunLedger(gh, DATA_REPO, "df-orchestrate", repoName(CONTROL_REPO), ledger);
    console.log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    console.warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}
