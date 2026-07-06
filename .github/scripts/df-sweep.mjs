import {
  DEFAULT_DATA_REPO,
  assertAllowedRepo,
  checksAreGreen,
  checksSummary,
  createGithubClient,
  darkFactoryWorkerIssueNumber,
  extractClosingIssueNumbers,
  getRepository,
  getRequiredStatusCheckContexts,
  isDarkFactoryWorkerPullRequest as isWorkerPullRequest,
  isParkedRepo,
  listActiveManagedRepos,
  managedRepoLifecycleState,
  normalizedRepoName,
  parseRepo,
  readManagedRepoRegistry,
  repoName,
  requiredEnv,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";
import { pathToFileURL } from "node:url";

const MODE = process.env.DF_FOLLOW_THROUGH_MODE ?? "sweep";
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const DEFAULT_EXCLUDED_REPOS = "";
const WORK_BRANCH = process.env.DF_WORK_BRANCH || "";
const NO_CHECK_ALLOWLIST = new Set(
  repoList(process.env.DF_ALLOW_NO_CHECK_REPOS || "").map((repo) => repoName(repo).toLowerCase())
);
const EMPTY_CHECK_SETTLE_MS = 10 * 60 * 1000;
let gh;
let CONTROL_REPO;
let DATA_REPO = process.env.DF_DATA_REPO ?? DEFAULT_DATA_REPO;

export function configureSweepRuntime(options) {
  gh = options.gh;
  CONTROL_REPO = options.controlRepo;
  DATA_REPO = options.dataRepo ?? DEFAULT_DATA_REPO;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const token = process.env.DARK_FACTORY_TOKEN || "";
    console.error(String(error.stack || error.message || error).split(token).join("***"));
    process.exitCode = 1;
  });
}

async function main() {
  const token = requiredEnv("DARK_FACTORY_TOKEN");
  configureSweepRuntime({
    gh: createGithubClient(token, "darkfactory-sweep"),
    controlRepo: parseRepo(requiredEnv("DF_CONTROL_REPO")),
    dataRepo: process.env.DF_DATA_REPO ?? DEFAULT_DATA_REPO
  });

  if (MODE === "dev-merge") {
    await closeDevMergeIssuesFromEnv();
    return;
  }

  const repos = await targetRepositories();
  const excluded = new Set(repoList(process.env.DF_SWEEP_EXCLUDE_REPOS || DEFAULT_EXCLUDED_REPOS).map((repo) => repoName(repo).toLowerCase()));
  const ledger = {
    trigger: TRIGGER,
    mode: MODE,
    excluded_repos: [...excluded],
    actions: [],
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Green-PR sweep is deterministic and uses no model calls"
    }
  };

  for (const repository of repos) {
    if (isParkedRepo(repository)) {
      ledger.actions.push({ repo: repoName(repository), action: "skip", reason: "parked" });
      continue;
    }

    if (excluded.has(repoName(repository).toLowerCase())) {
      ledger.actions.push({ repo: repoName(repository), action: "skip", reason: "excluded" });
      continue;
    }

    try {
      assertAllowedRepo(repository);
      const { pulls, baseBranches } = await listOpenPullRequests(repository);
      console.log(`DarkFactory sweep listed ${pulls.length} open ${[...baseBranches].join(",")} worker candidate PRs for ${repoName(repository)}.`);
      for (const pull of pulls) {
        try {
          const result = await considerPullRequest(repository, pull);
          console.log(formatPullDecision(repository, pull, result));
          ledger.actions.push(result);
        } catch (error) {
          const result = {
            repo: repoName(repository),
            pr: `${repoName(repository)}#${pull.number}`,
            action: "error",
            reason: "consider-pull-request-failed",
            error: error.message || String(error)
          };
          console.error(formatPullDecision(repository, pull, result));
          ledger.actions.push(result);
        }
      }
      const closureResults = await closeRecentlyMergedDevIssues(repository);
      ledger.actions.push(...closureResults);
    } catch (error) {
      if (warnReadOnlyRepository(repository, error, "follow-through")) {
        ledger.actions.push({ repo: repoName(repository), action: "skip", reason: "read-only" });
        continue;
      }
      ledger.actions.push({ repo: repoName(repository), action: "error", error: error.message || String(error) });
    }
  }

  await writeLedger("df-sweep", "sweep", ledger);
  const merged = ledger.actions.filter((action) => action.action === "merge" || action.action === "enable-automerge");
  console.log(`DarkFactory sweep processed ${repos.length} repos; merge actions: ${merged.length}.`);
}

function formatPullDecision(repository, pull, result) {
  const decision = result.action === "skip"
    ? `skip:${result.reason || "unknown"}`
    : result.action === "error"
      ? `error:${result.reason || "unknown"}`
      : result.action;
  const error = result.error ? ` error=${String(result.error).replace(/\s+/g, " ")}` : "";
  return [
    `DarkFactory sweep decision ${repoName(repository)}#${pull.number}`,
    `base=${pull.baseRefName || "unknown"}`,
    `head=${pull.headRefName || "unknown"}`,
    `mergeable=${pull.mergeable || "unknown"}`,
    `draft=${pull.isDraft === true}`,
    `checks=${checksSummary(pull.statusCheckRollup)}`,
    `decision=${decision}${error}`
  ].join(" ");
}

export async function considerPullRequest(repository, pull) {
  const ref = `${repoName(repository)}#${pull.number}`;

  if (pull.isDraft) return { repo: repoName(repository), pr: ref, action: "skip", reason: "draft" };
  if (!isWorkerPullRequest(pull, repository)) return { repo: repoName(repository), pr: ref, action: "skip", reason: "not-worker-pr" };

  if (!emptyCheckRollupHasSettled(pull)) {
    return { repo: repoName(repository), pr: ref, action: "skip", reason: "checks-not-reported-yet" };
  }

  const requiredContexts = await getRequiredStatusCheckContexts(gh, repository, pull.baseRefName);
  const hasReportedChecks = Array.isArray(pull.statusCheckRollup) && pull.statusCheckRollup.length > 0;
  if (!hasReportedChecks && requiredContexts.length === 0 && !NO_CHECK_ALLOWLIST.has(repoName(repository).toLowerCase())) {
    const issueUpdate = await markWorkerIssueBlocked(repository, pull, "no-checks-not-allowed", [
      "No checks were reported and this repository is not in `DF_ALLOW_NO_CHECK_REPOS`."
    ]);
    return {
      repo: repoName(repository),
      pr: ref,
      action: "skip",
      reason: "no-checks-not-allowed",
      issue_update: issueUpdate,
      note: "Add the repository to DF_ALLOW_NO_CHECK_REPOS to permit direct merge with no checks."
    };
  }

  if (!checksAreGreen(pull.statusCheckRollup, requiredContexts)) {
    const reason = requiredContexts.length && !pull.statusCheckRollup?.length
      ? "required-checks-missing"
      : "checks-not-green";
    const issueUpdate = await markWorkerIssueBlocked(repository, pull, reason, [
      `Required checks: ${requiredContexts.length ? requiredContexts.join(", ") : "(none configured)"}`,
      `Reported checks: ${checksSummary(pull.statusCheckRollup) || "(none)"}`
    ]);
    return {
      repo: repoName(repository),
      pr: ref,
      action: "skip",
      reason,
      issue_update: issueUpdate,
      required_checks: requiredContexts,
      checks: checksSummary(pull.statusCheckRollup)
    };
  }
  if (pull.mergeable !== "MERGEABLE") {
    const reason = `mergeable-${pull.mergeable}`;
    const issueUpdate = await markWorkerIssueBlocked(repository, pull, reason, [
      `GitHub mergeability is \`${pull.mergeable || "unknown"}\`.`
    ]);
    return { repo: repoName(repository), pr: ref, action: "skip", reason, issue_update: issueUpdate };
  }

  const mergeGate = await getPullRequestMergeGate(repository, pull.number);
  const hasMergeGateChecks = Array.isArray(mergeGate.statusCheckRollup) && mergeGate.statusCheckRollup.length > 0;
  if ((!hasMergeGateChecks && !NO_CHECK_ALLOWLIST.has(repoName(repository).toLowerCase())) || !checksAreGreen(mergeGate.statusCheckRollup)) {
    const issueUpdate = await markWorkerIssueBlocked(repository, pull, "merge-checks-not-green", [
      "Fresh merge gate check failed immediately before merge.",
      `Reported checks: ${checksSummary(mergeGate.statusCheckRollup) || "(none)"}`
    ]);
    return {
      repo: repoName(repository),
      pr: ref,
      action: "skip",
      reason: "merge-checks-not-green",
      issue_update: issueUpdate,
      checks: checksSummary(mergeGate.statusCheckRollup)
    };
  }
  if (mergeGate.mergeable !== "MERGEABLE") {
    const reason = `mergeable-${mergeGate.mergeable}`;
    const issueUpdate = await markWorkerIssueBlocked(repository, pull, reason, [
      `Fresh GitHub mergeability is \`${mergeGate.mergeable || "unknown"}\`.`
    ]);
    return { repo: repoName(repository), pr: ref, action: "skip", reason, issue_update: issueUpdate };
  }

  const protectedBranch = await branchIsProtected(repository, pull.baseRefName);
  if (protectedBranch) {
    const enabled = await enableAutoMerge(pull.id);
    if (enabled.enabled) {
      return {
        repo: repoName(repository),
        pr: ref,
        url: pull.url,
        action: "enable-automerge",
        result: enabled,
        checks: checksSummary(pull.statusCheckRollup)
      };
    }

    if (!canDirectMergeAfterAutomergeFailure(enabled.reason)) {
      const issueUpdate = await markWorkerIssueBlocked(repository, pull, "protected-branch-automerge-failed", [
        `Auto-merge failed: ${enabled.reason || "unknown error"}`
      ]);
      return {
        repo: repoName(repository),
        pr: ref,
        url: pull.url,
        action: "skip",
        reason: "protected-branch-automerge-failed",
        automerge_error: enabled.reason,
        issue_update: issueUpdate,
        checks: checksSummary(pull.statusCheckRollup)
      };
    }

    const merged = await mergePullRequest(repository, mergeGate);
    return {
      repo: repoName(repository),
      pr: ref,
      url: pull.url,
      action: "merge",
      sha: merged.sha,
      base: pull.baseRefName,
      fallback_from_automerge: enabled.reason,
      checks: checksSummary(mergeGate.statusCheckRollup)
    };
  }

  const merged = await mergePullRequest(repository, mergeGate);
  return {
    repo: repoName(repository),
    pr: ref,
    url: pull.url,
    action: "merge",
    sha: merged.sha,
    base: pull.baseRefName,
    checks: checksSummary(mergeGate.statusCheckRollup)
  };
}

function emptyCheckRollupHasSettled(pull) {
  if (Array.isArray(pull.statusCheckRollup) && pull.statusCheckRollup.length > 0) return true;

  const changedAt = Date.parse(pull.updatedAt || pull.createdAt || "");
  return Number.isFinite(changedAt) && Date.now() - changedAt >= EMPTY_CHECK_SETTLE_MS;
}

function canDirectMergeAfterAutomergeFailure(reason) {
  return /pull request is in clean status/i.test(reason || "");
}

async function mergePullRequest(repository, pull) {
  const ref = `${repoName(repository)}#${pull.number}`;
  let merged;
  try {
    merged = await gh.request("PUT", `/repos/${repoName(repository)}/pulls/${pull.number}/merge`, {
      commit_title: pull.title,
      merge_method: "squash"
    });
  } catch (error) {
    console.error(`DarkFactory sweep merge error ${ref}: ${error.message || String(error)}`);
    throw error;
  }

  try {
    await closeIssuesIfDevMerge(repository, pull);
  } catch (error) {
    console.warn(`DarkFactory sweep dev-closure warning ${ref}: ${error.message || String(error)}`);
  }
  return merged;
}

async function markWorkerIssueBlocked(repository, pull, reason, details = []) {
  const issueNumber = darkFactoryWorkerIssueNumber(pull);
  if (!issueNumber) return { status: "skipped", reason: "missing-worker-marker" };

  await replaceIssueLabels(repository, issueNumber, ["df:blocked"], ["df:ready", "df:running", "df:done"]);

  const marker = `<!-- dark-factory:sweep-blocked pr=${pull.number} -->`;
  if (!(await hasSweepBlockedComment(repository, issueNumber, marker))) {
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, {
      body: [
        marker,
        "DarkFactory follow-through blocked this worker PR.",
        "",
        `PR: ${pull.url || `#${pull.number}`}`,
        `Reason: ${reason}`,
        ...details.map((detail) => `- ${detail}`)
      ].join("\n")
    });
  }

  return { status: "blocked", issue: `#${issueNumber}`, reason };
}

async function hasSweepBlockedComment(repository, issueNumber, marker) {
  const comments = await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}/comments?per_page=100`);
  return Array.isArray(comments) && comments.some((comment) => String(comment.body || "").includes(marker));
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

async function closeDevMergeIssuesFromEnv() {
  const payload = JSON.parse(process.env.GITHUB_EVENT_PAYLOAD || "{}");
  const pull = payload.pull_request;
  const repositoryPayload = payload.repository;
  if (!(pull?.merged || pull?.merged_at) || pull.base?.ref !== "dev" || !repositoryPayload?.full_name) {
    console.log("No merged dev pull request in event payload.");
    return;
  }

  const repository = parseRepo(repositoryPayload.full_name);
  assertAllowedRepo(repository);
  const ledger = {
    trigger: TRIGGER,
    mode: "dev-merge",
    actions: [],
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Issue closure on dev merge is deterministic"
    }
  };
  const action = await closeIssuesIfDevMerge(repository, {
    number: pull.number,
    title: pull.title || "",
    author: { login: pull.user?.login || "" },
    url: pull.html_url,
    body: pull.body || "",
    baseRefName: pull.base.ref,
    headRefName: pull.head?.ref || "",
    headRepository: {
      name: pull.head?.repo?.name || "",
      owner: { login: pull.head?.repo?.owner?.login || "" }
    }
  });
  ledger.actions.push(action);
  try {
    await writeLedger("df-sweep", repoName(repository), ledger);
  } catch (error) {
    console.warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}

async function closeIssuesIfDevMerge(repository, pull) {
  if (pull.baseRefName !== "dev") {
    return { repo: repoName(repository), pr: pull.url, action: "skip-dev-closure", reason: `base-${pull.baseRefName}` };
  }
  if (!isWorkerPullRequest(pull, repository)) {
    return { repo: repoName(repository), pr: pull.url, action: "skip-dev-closure", reason: "not-worker-pr" };
  }

  const issueNumbers = extractClosingIssueNumbers(pull.body || "", repoName(repository));
  const closed = [];
  for (const issue_number of issueNumbers) {
    if (await hasDevMergeComment(repository, issue_number, pull.url)) {
      continue;
    }
    await gh.request("POST", `/repos/${repoName(repository)}/issues/${issue_number}/comments`, {
      body: `merged to dev in ${pull.url}; releases with the next dev→main PR`
    });
    await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${issue_number}`, { state: "closed" });
    closed.push(issue_number);
  }
  return { repo: repoName(repository), pr: pull.url, action: "close-dev-merge-issues", issues: closed };
}

async function closeRecentlyMergedDevIssues(repository) {
  const pulls = await gh.request(
    "GET",
    `/repos/${repoName(repository)}/pulls?state=closed&sort=updated&direction=desc&per_page=50`
  );
  if (!Array.isArray(pulls)) return [];

  const results = [];
  for (const pull of pulls) {
    // The list endpoint does not reliably expose merged status; fetch the
    // single PR to get the exact merge timestamp and full payload.
    if (pull.base?.ref !== "dev") continue;
    const full = await gh.request("GET", `/repos/${repoName(repository)}/pulls/${pull.number}`);
    const normalized = normalizeRestPullRequest(full);
    if (!normalized.mergedAt || normalized.baseRefName !== "dev" || !isWorkerPullRequest(normalized, repository)) continue;
    const action = await closeIssuesIfDevMerge(repository, normalized);
    if (action.issues?.length) results.push(action);
  }
  return results;
}

async function hasDevMergeComment(repository, issueNumber, pullUrl) {
  const comments = await gh.request(
    "GET",
    `/repos/${repoName(repository)}/issues/${issueNumber}/comments?per_page=100`
  );
  return Array.isArray(comments) && comments.some((comment) => {
    return typeof comment.body === "string" && comment.body.includes(`merged to dev in ${pullUrl}`);
  });
}

async function targetRepositories() {
  const configured = repoList(process.env.DF_SWEEP_REPOS || "");
  if (configured.length) return await filterConfiguredActiveManagedRepos(configured);

  return await listActiveManagedRepos(gh, CONTROL_REPO);
}

async function filterConfiguredActiveManagedRepos(configured) {
  const registry = await readManagedRepoRegistry();
  const active = [];

  for (const repository of configured) {
    if (repository.owner !== CONTROL_REPO.owner) {
      console.warn(`DarkFactory skipped configured sweep repository ${repoName(repository)} because it is outside ${CONTROL_REPO.owner}.`);
      continue;
    }

    const state = managedRepoLifecycleState(repository, registry);
    if (state !== "active") {
      console.warn(`DarkFactory skipped configured sweep repository ${repoName(repository)} because managed lifecycle state is '${state}'.`);
      continue;
    }

    try {
      const repo = await getRepository(gh, repository);
      if (repo.archived === true || repo.disabled === true) {
        console.warn(`DarkFactory skipped configured sweep repository ${repoName(repository)} because GitHub reports archived=${repo.archived === true} disabled=${repo.disabled === true}.`);
        continue;
      }
    } catch (error) {
      if (warnReadOnlyRepository(repository, error, "configured follow-through")) continue;
      throw error;
    }

    active.push(repository);
  }

  active.sort((a, b) => normalizedRepoName(a).localeCompare(normalizedRepoName(b)));
  return active;
}

function repoList(value) {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseRepo);
}

async function listOpenPullRequests(repository) {
  const baseBranches = await sweepBaseBranches(repository);
  const query = `
    query Pulls($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            number
            title
            body
            url
            createdAt
            updatedAt
            isDraft
            mergeable
            baseRefName
            headRefName
            headRepository {
              name
              owner { login }
            }
            author { login }
            statusCheckRollup {
              contexts(first: 50) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                  }
                  ... on StatusContext {
                    context
                    state
                  }
                }
              }
            }
          }
        }
      }
    }`;
  const pulls = [];
  let cursor = null;

  for (let page = 1; page <= 20; page += 1) {
    const data = await gh.graphql(query, { owner: repository.owner, repo: repository.repo, cursor });
    const connection = data.repository.pullRequests;
    pulls.push(...connection.nodes.map((pull) => ({
      ...pull,
      statusCheckRollup: pull.statusCheckRollup?.contexts?.nodes || []
    })));

    if (!connection.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return {
    pulls: pulls.filter((pull) => {
      return baseBranches.has(pull.baseRefName) && String(pull.headRefName || "").startsWith("df/");
    }),
    baseBranches
  };
}

async function sweepBaseBranches(repository) {
  if (WORK_BRANCH) return new Set([WORK_BRANCH]);

  const repo = await getRepository(gh, repository);
  return new Set(["dev", repo.default_branch].filter(Boolean));
}

async function getPullRequestMergeGate(repository, pullNumber) {
  const query = `
    query PullForMergeGate($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          number
          title
          body
          url
          isDraft
          mergeable
          baseRefName
          headRefName
          headRepository {
            name
            owner { login }
          }
          author { login }
          statusCheckRollup {
            contexts(first: 100) {
              nodes {
                __typename
                ... on CheckRun {
                  name
                  status
                  conclusion
                }
                ... on StatusContext {
                  context
                  state
                }
              }
            }
          }
        }
      }
    }`;
  const data = await gh.graphql(query, { owner: repository.owner, repo: repository.repo, number: pullNumber });
  const pull = data.repository.pullRequest;
  return {
    ...pull,
    statusCheckRollup: pull.statusCheckRollup?.contexts?.nodes || []
  };
}

function normalizeRestPullRequest(pull) {
  // Preserve the REST merged_at field so the dev-merge closure backstop can
  // distinguish merged PRs from merely closed ones.
  const mergedAt = pull.merged_at || null;
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body || "",
    url: pull.html_url,
    author: { login: pull.user?.login || "" },
    headRefName: pull.head?.ref || "",
    headRepository: {
      name: pull.head?.repo?.name || "",
      owner: { login: pull.head?.repo?.owner?.login || "" }
    },
    baseRefName: pull.base?.ref || "",
    mergedAt
  };
}

async function branchIsProtected(repository, branch) {
  try {
    await gh.request("GET", `/repos/${repoName(repository)}/branches/${encodeURIComponent(branch)}/protection`);
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    if (error.status === 403) return false;
    throw error;
  }
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
    return { enabled: true };
  } catch (error) {
    return { enabled: false, reason: error.message || String(error) };
  }
}

async function writeLedger(kind, targetRepoName, ledger) {
  try {
    const written = await writeRunLedger(gh, DATA_REPO, kind, targetRepoName, ledger);
    console.log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    console.warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}
