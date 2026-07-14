import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DARK_FACTORY_DATA_REPO,
  PLANNING_LABELS,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  driftIssueBody,
  ensureLabels,
  extractClosingIssueNumbers,
  extractReadmeFirstParagraph,
  findDriftMarker,
  findPrdMarker,
  getOptionalFileContent,
  getRepository,
  isActiveManagedRepo,
  listActiveManagedRepos,
  listIssues,
  listPackagePaths,
  readManagedRepoRegistry,
  parsePrdItems,
  parseRepo,
  plannedIssueLabelDiff,
  prdIssueBody,
  prdScaffoldPullRequestBody,
  repoName,
  requiredEnv,
  scaffoldPackagePrd,
  slug,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";

const PLANNER_BOT_LOGINS = new Set(["github-actions[bot]", "mp-agents[bot]"]);

const DATA_REPO = DARK_FACTORY_DATA_REPO;
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const TARGET_REF = process.env.DF_TARGET_REF?.trim() || "";
const PLAN_ALL = process.env.DF_PLAN_ALL === "true";

let gh;
let TARGET_REPO;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const TOKEN = requiredEnv("DARK_FACTORY_TOKEN");
  const CONTROL_REPO = parseRepo(requiredEnv("DF_CONTROL_REPO"));
  TARGET_REPO = parseRepo(process.env.DF_TARGET_REPO?.trim() || repoName(CONTROL_REPO));
  gh = createGithubClient(TOKEN, "darkfactory-plan");

  const registry = await readManagedRepoRegistry();
  const targets = PLAN_ALL ? await listActiveManagedRepos(gh, CONTROL_REPO, { registry }) : [TARGET_REPO];
  for (const target of targets) {
    TARGET_REPO = target;
    if (!isActiveManagedRepo(TARGET_REPO, registry)) {
      console.warn(`DarkFactory planning skipped ${repoName(TARGET_REPO)} because managed lifecycle state is not active.`);
      continue;
    }
    const repo = await getRepository(gh, TARGET_REPO);
    if (repo.archived === true || repo.disabled === true) {
      console.warn(`DarkFactory planning skipped ${repoName(TARGET_REPO)} because GitHub reports archived=${repo.archived === true} disabled=${repo.disabled === true}.`);
      continue;
    }
    try {
      await reconcileTargetRepository(repo, CONTROL_REPO);
    } catch (error) {
      if (warnReadOnlyRepository(TARGET_REPO, error, "planning")) {
        try {
          await upsertPrdBlockerIssue(TARGET_REPO, repo.default_branch || "main", `Planning could not write to ${repoName(TARGET_REPO)} because the repository is archived, disabled, or read-only: ${error.message || String(error)}`);
        } catch (blockerError) {
          console.warn(`DarkFactory failed to file PRD blocker issue for ${repoName(TARGET_REPO)}: ${blockerError.message || String(blockerError)}`);
        }
        continue;
      }
      throw error;
    }
  }
}

async function reconcileTargetRepository(repo, controlRepo) {
  assertAllowedRepo(TARGET_REPO);
  if (repo.archived === true || repo.disabled === true) {
    console.warn(`DarkFactory planning skipped ${repoName(TARGET_REPO)} because GitHub reports archived=${repo.archived === true} disabled=${repo.disabled === true}.`);
    return;
  }

  await ensureLabels(gh, TARGET_REPO, [...PLANNING_LABELS, ...WORK_LABELS]);
  const sourceRef = PLAN_ALL ? repo.default_branch : TARGET_REF || repo.default_branch;
  const ledger = {
    trigger: TRIGGER,
    default_branch: repo.default_branch,
    source_ref: sourceRef,
    prd_files: [],
    actions: [],
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "L4 planning used deterministic PRD parsing only"
    }
  };

  const prdPresence = await ensurePrdPresence(TARGET_REPO, repo, sourceRef);
  ledger.prd_coverage = {
    root_present: prdPresence.rootPresent,
    package_prds: prdPresence.packagePrds.length,
    total_packages: prdPresence.packagePaths.length,
    missing: prdPresence.missingPaths
  };

  if (!prdPresence.rootPresent) {
    if (prdPresence.scaffoldPullRequest) {
      ledger.actions.push({
        action: "prd-scaffold-pr",
        state: prdPresence.scaffoldPullRequest.isNew ? "created" : "exists",
        pull_request: prdPresence.scaffoldPullRequest.ref,
        missing: prdPresence.missingPaths
      });
      console.log(`DarkFactory planning opened PRD scaffold PR ${prdPresence.scaffoldPullRequest.ref.url} for ${repoName(TARGET_REPO)}.`);
    } else {
      const issue = await upsertPrdBlockerIssue(TARGET_REPO, sourceRef, "Root PRD.md is missing and DarkFactory could not open a scaffold PR.");
      ledger.actions.push({ action: "prd-blocker-issue", reason: "missing-prd", issue });
    }
    await writeLedger(ledger);
    return;
  }

  if (prdPresence.scaffoldPullRequest) {
    ledger.actions.push({
      action: "package-prd-scaffold-pr",
      state: prdPresence.scaffoldPullRequest.isNew ? "created" : "exists",
      pull_request: prdPresence.scaffoldPullRequest.ref,
      missing: prdPresence.missingPaths
    });
  }

  const prdSources = await getPrdSources(TARGET_REPO, sourceRef, prdPresence.tree);
  ledger.prd_files = prdSources.map((source) => source.path);

  const items = prdSources.flatMap((source) => parsePrdItems(source.content, source.path));
  const issues = await listIssues(gh, TARGET_REPO, "all");
  const byMarker = new Map();
  const driftIssues = [];

  for (const issue of issues) {
    const marker = findPrdMarker(issue.body || "");
    if (marker) byMarker.set(marker, issue);
    if (findDriftMarker(issue.body || "")) driftIssues.push(issue);
  }

  const expectedMarkers = new Set(items.map((item) => item.marker));
  let previousIssueNumber = null;
  let previousOpenIssueNumber = null;

  for (const item of items) {
    const existing = byMarker.get(item.marker);
    const labels = [item.priority, "roadmap", `df:class:${item.taskClass}`];

    if (item.completed) {
      if (!existing) {
        const created = await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues`, {
          title: item.title,
          body: prdIssueBody(item, previousIssueNumber ? [previousIssueNumber] : []),
          labels
        });
        const closed = await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${created.number}`, {
          state: "closed"
        });
        await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues/${created.number}/comments`, {
          body: "DarkFactory L4 planning created and closed this issue because the PRD already marks this item as completed."
        });
        ledger.actions.push({ action: "create-closed-completed-prd-issue", marker: item.marker, issue: issueRef(closed) });
        previousIssueNumber = closed.number;
        continue;
      }
      if (existing.state === "closed") {
        ledger.actions.push({ action: "keep-closed", marker: item.marker, issue: issueRef(existing) });
        previousIssueNumber = existing.number;
        continue;
      }
      const closed = await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${existing.number}`, {
        state: "closed"
      });
      await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues/${existing.number}/comments`, {
        body: "DarkFactory L4 planning closed this issue because the PRD marks this item as completed."
      });
      ledger.actions.push({ action: "close-completed-prd-issue", marker: item.marker, issue: issueRef(closed) });
      previousIssueNumber = closed.number;
      continue;
    }

    // Keep deterministic PRD-order references even when the predecessor is
    // already closed, but only an unfinished predecessor blocks readiness.
    const blockedBy = previousIssueNumber ? [previousIssueNumber] : [];
    if (previousOpenIssueNumber === null) labels.push("df:ready");
    const body = prdIssueBody(item, blockedBy);

    if (!existing) {
      // Create the issue without the df:ready label; add it in a separate call so
      // GitHub emits a trusted `issues:labeled` event that the L3 worker trigger
      // can react to.
      const createLabels = labels.filter((label) => label !== "df:ready");
      const created = await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues`, {
        title: item.title,
        body,
        labels: createLabels
      });
      const labelUpdate = await setIssueLabels(gh, TARGET_REPO, created.number, labels);
      const dispatch = await dispatchIfNewlyReady(gh, TARGET_REPO, created.number, labelUpdate);
      ledger.actions.push({ action: "create-issue", marker: item.marker, issue: issueRef(created), labels });
      if (dispatch) ledger.actions.push(dispatch);
      previousIssueNumber = created.number;
      previousOpenIssueNumber = created.number;
      continue;
    }

    if (existing.state === "closed") {
      const { action, previousIssueNumber: nextPrevious, previousOpenIssueNumber: nextPreviousOpen } = await handleClosedIncompletePrdIssue(gh, TARGET_REPO, controlRepo, item, existing, labels, blockedBy);
      ledger.actions.push(action);
      previousIssueNumber = nextPrevious;
      previousOpenIssueNumber = nextPreviousOpen;
      continue;
    }

    // For open issues, apply the deterministic current-PRD sequence. Patch only
    // the Blocked-by section when sequencing changes; rewrite the whole body
    // when the PRD item content itself changes.
    const expectedBlockedBy = blockedBy;
    const existingBlockedBy = extractBlockedBy(existing.body || "");
    const contentBody = prdIssueBody(item, []);
    const contentChanged = removeBlockedBySection(existing.body || "").trim() !== contentBody.trim();
    const sequencingChanged = existingBlockedBy.join(",") !== expectedBlockedBy.join(",");

    const update = {};
    if (existing.title !== item.title) update.title = item.title;
    if (contentChanged) {
      update.body = prdIssueBody(item, expectedBlockedBy);
    } else if (sequencingChanged) {
      update.body = applyBlockedBy(existing.body || "", expectedBlockedBy);
    }
    if (Object.keys(update).length) {
      const updated = await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${existing.number}`, update);
      ledger.actions.push({ action: "update-issue", marker: item.marker, issue: issueRef(updated), fields: Object.keys(update) });
    }
    const labelUpdate = await setIssueLabels(gh, TARGET_REPO, existing.number, labels);
    ledger.actions.push({ action: "sequence-labels", marker: item.marker, issue: issueRef(existing), labels });
    const dispatch = await dispatchIfNewlyReady(gh, TARGET_REPO, existing.number, labelUpdate);
    if (dispatch) ledger.actions.push(dispatch);
    previousIssueNumber = existing.number;
    previousOpenIssueNumber = existing.number;
  }

  const staleMarkedIssues = [...byMarker.values()].filter((issue) => {
    const marker = findPrdMarker(issue.body || "");
    return issue.state === "open" && marker && !expectedMarkers.has(marker);
  });

  for (const issue of staleMarkedIssues) {
    await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues/${issue.number}/comments`, {
      body: "DarkFactory L4 planning closed this issue because its `df-prd:` marker is no longer present in any tracked `PRD.md` file."
    });
    await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${issue.number}`, { state: "closed" });
    ledger.actions.push({ action: "close-stale-prd-issue", issue: issueRef(issue) });
  }

  const driftFindings = await detectCodeDrift(TARGET_REPO, repo.default_branch, items, staleMarkedIssues);
  if (driftFindings.length) {
    const driftIssue = await upsertDriftIssue(TARGET_REPO, driftFindings);
    ledger.actions.push({ action: "drift-report", issue: driftIssue, findings: driftFindings });
  } else {
    for (const issue of driftIssues.filter((issue) => issue.state === "open")) {
      await gh.request("POST", `/repos/${repoName(TARGET_REPO)}/issues/${issue.number}/comments`, {
        body: "DarkFactory L4 planning no longer detects this drift condition."
      });
      await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${issue.number}`, { state: "closed" });
      ledger.actions.push({ action: "close-resolved-drift", issue: issueRef(issue) });
    }
  }

  await writeLedger(ledger);
  console.log(`DarkFactory planning reconciled ${items.length} PRD items for ${repoName(TARGET_REPO)}.`);
}

async function getPrdSources(repository, ref, tree) {
  const paths = await listPrdPaths(repository, ref, tree);
  const sources = [];
  for (const filePath of paths) {
    const content = await getOptionalFileContent(gh, repository, filePath, ref);
    if (content) sources.push({ path: filePath, content });
  }
  return sources;
}

async function listPrdPaths(repository, ref, tree) {
  if (!tree) {
    try {
      tree = await getRecursiveTree(repository, ref);
    } catch (error) {
      if (error.status !== 404) throw error;
      const root = await getOptionalFileContent(gh, repository, "PRD.md", ref);
      return root ? ["PRD.md"] : [];
    }
  }

  const paths = (tree.tree || [])
    .filter((entry) => entry.type === "blob" && (entry.path === "PRD.md" || entry.path.endsWith("/PRD.md")))
    .map((entry) => entry.path)
    .sort((a, b) => {
      if (a === "PRD.md") return -1;
      if (b === "PRD.md") return 1;
      return a.localeCompare(b);
    });
  return paths;
}

async function getRecursiveTree(repository, ref) {
  try {
    return await gh.request(
      "GET",
      `/repos/${repoName(repository)}/git/trees/${encodeURIComponent(ref)}?recursive=1`
    );
  } catch (error) {
    if (error.status !== 404 && error.status !== 409 && error.status !== 422) throw error;
    const commit = await gh.request("GET", `/repos/${repoName(repository)}/git/commits/${encodeURIComponent(ref)}`);
    const treeSha = commit?.tree?.sha;
    if (typeof treeSha !== "string" || !/^[0-9a-f]{40}$/i.test(treeSha)) throw error;
    return await gh.request(
      "GET",
      `/repos/${repoName(repository)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`
    );
  }
}

async function ensurePrdPresence(repository, repo, sourceRef) {
  const tree = await getRecursiveTree(repository, sourceRef);
  const prdPaths = await listPrdPaths(repository, sourceRef, tree);
  const packagePaths = listPackagePaths(tree.tree);
  const rootPresent = prdPaths.includes("PRD.md");
  const missingPackagePrds = packagePaths.filter((dir) => {
    const expected = dir === "." ? "PRD.md" : `${dir}/PRD.md`;
    return !prdPaths.includes(expected);
  });
  const missingPaths = [];
  if (!rootPresent) {
    missingPaths.push("PRD.md");
  }
  for (const pkg of missingPackagePrds) {
    missingPaths.push(pkg === "." ? "PRD.md" : `${pkg}/PRD.md`);
  }

  if (missingPaths.length === 0) {
    return {
      rootPresent: true,
      tree,
      prdPaths,
      packagePaths,
      packagePrds: packagePaths.map((dir) => dir === "." ? "PRD.md" : `${dir}/PRD.md`),
      missingPaths: [],
      scaffoldPullRequest: null
    };
  }

  const existingPr = await findOpenPrdScaffoldPullRequest(repository);
  if (existingPr) {
    return {
      rootPresent,
      tree,
      prdPaths,
      packagePaths,
      packagePrds: [],
      missingPaths,
      scaffoldPullRequest: { ref: existingPr, isNew: false }
    };
  }

  const files = await buildScaffoldFiles(repository, sourceRef, missingPaths);
  const pr = await createPrdScaffoldPullRequest(repository, repo.default_branch, files);
  return {
    rootPresent,
    tree,
    prdPaths,
    packagePaths,
    packagePrds: [],
    missingPaths,
    scaffoldPullRequest: { ref: pr, isNew: true }
  };
}

async function findOpenPrdScaffoldPullRequest(repository) {
  const marker = "<!-- dark-factory:prd-scaffold -->";
  for (let page = 1; page <= 5; page += 1) {
    const pulls = await gh.request("GET", `/repos/${repoName(repository)}/pulls?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(pulls) || pulls.length === 0) break;
    const match = pulls.find((pull) => typeof pull.body === "string" && pull.body.includes(marker));
    if (match) return issueRef(match);
    if (pulls.length < 100) break;
  }
  return null;
}

async function buildScaffoldFiles(repository, ref, missingPaths) {
  const readme = await getOptionalFileContent(gh, repository, "README.md", ref);
  const rootVision = extractReadmeFirstParagraph(readme);
  const files = [];

  for (const path of missingPaths) {
    const isRoot = path === "PRD.md";
    const dir = isRoot ? "." : path.slice(0, -"/PRD.md".length);
    let packageName = "";
    let vision = "";

    if (!isRoot) {
      packageName = dir.split("/").pop() || "";
      const packageReadme = await getOptionalFileContent(gh, repository, `${dir}/README.md`, ref);
      const packageJson = await getOptionalFileContent(gh, repository, `${dir}/package.json`, ref);
      vision = extractReadmeFirstParagraph(packageReadme);
      if (!vision && packageJson) {
        try {
          const parsed = JSON.parse(packageJson);
          vision = typeof parsed.description === "string" ? parsed.description : "";
        } catch {
          vision = "";
        }
      }
    } else {
      vision = rootVision;
    }

    files.push({
      path,
      content: scaffoldPackagePrd(repoName(repository), { vision, packageName, isRoot })
    });
  }

  return files;
}

async function createPrdScaffoldPullRequest(repository, baseBranch, files) {
  const timestamp = Date.now();
  const branch = `dark-factory/prd-scaffold-${timestamp}`;
  const baseRef = await gh.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  const baseSha = baseRef?.object?.sha;
  if (typeof baseSha !== "string") {
    throw new Error(`GitHub returned an invalid base ref for ${baseBranch}`);
  }

  const baseCommit = await gh.request("GET", `/repos/${repoName(repository)}/git/commits/${encodeURIComponent(baseSha)}`);
  const baseTreeSha = baseCommit?.tree?.sha;
  if (typeof baseTreeSha !== "string") {
    throw new Error(`GitHub returned an invalid base commit tree for ${baseBranch}`);
  }

  const newTree = await gh.request("POST", `/repos/${repoName(repository)}/git/trees`, {
    base_tree: baseTreeSha,
    tree: files.map((file) => ({
      path: file.path,
      mode: "100644",
      type: "blob",
      content: file.content
    }))
  });

  const newCommit = await gh.request("POST", `/repos/${repoName(repository)}/git/commits`, {
    message: "Add DarkFactory PRD scaffold",
    tree: newTree.sha,
    parents: [baseSha]
  });

  await gh.request("POST", `/repos/${repoName(repository)}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: newCommit.sha
  });

  const pull = await gh.request("POST", `/repos/${repoName(repository)}/pulls`, {
    title: "Add DarkFactory PRD scaffold",
    head: branch,
    base: baseBranch,
    body: prdScaffoldPullRequestBody(repoName(repository), files.map((file) => file.path))
  });

  return issueRef(pull);
}

async function upsertPrdBlockerIssue(repository, sourceRef, reason) {
  const marker = `df-prd-blocker:${slug(repoName(repository))}`;
  const issues = await listIssues(gh, repository, "all");
  const existing = issues.find((issue) => (issue.body || "").includes(marker));
  const body = [
    `<!-- ${marker} -->`,
    "## PRD Blocker",
    "",
    `Target repository: \`${repoName(repository)}\``,
    `Source ref: \`${sourceRef}\``,
    "",
    reason,
    "",
    "## Acceptance Criteria",
    "",
    "- Resolve the blocker so DarkFactory can open a PRD scaffold PR (e.g., enable writes, unarchive the repository, or create the PRD manually).",
    "- Re-run DarkFactory planning and confirm this blocker is closed.",
    "",
    "## Token Use",
    "",
    "- AI tokens: 0 (deterministic fleet bootstrap check)."
  ].join("\n");
  const title = `PRD scaffold blocked - ${repoName(repository)}`;
  const labels = ["P1", "df:ask-owner", "df:class:standard"];

  if (existing) {
    const updated = await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, {
      title,
      body,
      state: "open"
    });
    await setIssueLabels(gh, repository, existing.number, labels, { preserveWorkerState: false });
    return issueRef(updated);
  }

  const created = await gh.request("POST", `/repos/${repoName(repository)}/issues`, {
    title,
    body,
    labels
  });
  return issueRef(created);
}

async function setIssueLabels(gh, repository, issueNumber, labels, options = {}) {
  const current = await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`);
  const currentNames = new Set(
    (current.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean)
  );
  const { add, remove } = plannedIssueLabelDiff([...currentNames], labels, options);

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
  return { add, remove };
}

async function dispatchIfNewlyReady(gh, repository, issueNumber, labelUpdate) {
  if (!labelUpdate.add.includes("df:ready")) return null;
  return await dispatchReadyWorker(repository, issueNumber);
}

async function dispatchReadyWorker(repository, issueNumber) {
  // Planning never dispatches privileged workers with a repository-scoped token.
  // It queues readiness; the trusted control orchestrator dispatches workers
  // with the GitHub App installation token.
  return {
    action: "queue-worker",
    repo: repoName(repository),
    issue: `#${issueNumber}`,
    reason: "await-control-orchestrator"
  };
}

async function detectCodeDrift(repository, ref, items, staleMarkedIssues) {
  const findings = staleMarkedIssues.map((issue) => {
    const marker = findPrdMarker(issue.body || "");
    return `Backlog issue #${issue.number} still had stale marker \`${marker}\` after the PRD item was removed.`;
  });
  const itemText = items.map((item) => `${item.name} ${item.description}`).join("\n").toLowerCase();

  findings.push(...await detectPrdArtifactDrift(repository, ref, itemText));

  if (itemText.includes("l4 planning")) {
    const workflow = await getOptionalFileContent(gh, repository, ".github/workflows/df-plan.yml", ref);
    if (!workflow) findings.push("PRD requires L4 Planning, but `.github/workflows/df-plan.yml` is absent.");
  }

  if (itemText.includes("l3 work")) {
    const workflow = await getOptionalFileContent(gh, repository, ".github/workflows/df-work.yml", ref);
    if (!workflow) findings.push("PRD requires L3 Work, but `.github/workflows/df-work.yml` is absent.");
  }

  // General drift: open issues or PRs that are not tied to a PRD-tracked issue.
  // The PRD is the source of truth, so open planned work without a PRD marker is
  // a contradiction between the backlog and the PRD.
  const openIssues = await listIssues(gh, repository, "open");
  const prdTrackedNumbers = new Set(
    openIssues
      .filter((issue) => !issue.pull_request && findPrdMarker(issue.body || ""))
      .map((issue) => issue.number)
  );

  for (const issue of openIssues) {
    if (issue.pull_request) continue;
    if (findPrdMarker(issue.body || "")) continue;
    const labels = (issue.labels || []).map((label) => typeof label === "string" ? label : label.name);
    if (labels.includes("df:prd-drift") || labels.includes("df:ask-owner")) continue;
    if (!isDarkFactoryManagedIssue(labels)) continue;
    findings.push(`Open issue #${issue.number} is not tracked by any PRD item.`);
  }

  const pulls = await listOpenPullRequests(repository);
  for (const pull of pulls) {
    const closes = extractClosingIssueNumbers(pull.body || "", repoName(repository));
    const linkedToPrd = closes.some((number) => prdTrackedNumbers.has(number));
    if (!linkedToPrd) {
      findings.push(`Open PR #${pull.number} is not linked to a PRD-tracked issue.`);
    }
  }

  return findings;
}

async function detectPrdArtifactDrift(repository, ref, itemText) {
  const findings = [];
  const rules = [
    {
      capability: "PRD editing to automatically reconcile sequenced backlog issues",
      pattern: /\b(l4 planning|planning loop|prd enforcement|prd\W*backlog|reconciliation|editing prd\.md|prd edits?|sequenced issues)\b/i,
      artifacts: [
        {
          path: ".github/workflows/df-plan.yml",
          checks: [
            { snippet: "PRD.md", reason: "listen for PRD file changes" },
            { snippet: "schedule:", reason: "run recurring reconciliation" },
            { snippet: "workflow_dispatch:", reason: "support manual reconciliation" }
          ]
        },
        {
          path: ".github/scripts/df-plan.mjs",
          checks: [
            { snippet: "parsePrdItems", reason: "parse PRD items deterministically" },
            { snippet: "prdIssueBody", reason: "write PRD-backed issue bodies" },
            { snippet: "Blocked-by", reason: "maintain sequencing references" },
            { snippet: "df:ready", reason: "queue newly unblocked PRD issues" }
          ]
        }
      ]
    },
    {
      capability: "PRD drift reporting when code or backlog contradicts the PRD",
      pattern: /\b(drift report|prd drift|code contradicts prd|contradicts the prd|not tracked by any prd item|not linked to a prd-tracked issue)\b/i,
      artifacts: [
        {
          path: ".github/scripts/df-plan.mjs",
          checks: [
            { snippet: "detectCodeDrift", reason: "detect PRD contradictions" },
            { snippet: "upsertDriftIssue", reason: "file or update a drift report issue" },
            { snippet: "df-prd-drift", reason: "mark drift reports for idempotent updates" }
          ]
        }
      ]
    }
  ];

  for (const rule of rules) {
    if (!rule.pattern.test(itemText)) continue;
    for (const artifact of rule.artifacts) {
      const content = await getOptionalFileContent(gh, repository, artifact.path, ref);
      if (!content) {
        findings.push(`PRD requires ${rule.capability}, but \`${artifact.path}\` is absent.`);
        continue;
      }
      const checkContent = artifactContentForChecks(artifact.path, content);
      for (const check of artifact.checks) {
        if (!checkContent.includes(check.snippet)) {
          findings.push(`PRD requires ${rule.capability}, but \`${artifact.path}\` does not ${check.reason}.`);
        }
      }
    }
  }

  return findings;
}

function artifactContentForChecks(filePath, content) {
  if (filePath !== ".github/scripts/df-plan.mjs") return content;
  return content.replace(
    /\nasync function detectPrdArtifactDrift[\s\S]*?\nfunction isDarkFactoryManagedIssue/,
    "\nfunction isDarkFactoryManagedIssue"
  );
}

function isDarkFactoryManagedIssue(labels) {
  return labels.includes("roadmap") || labels.some((label) => /^df:(ready|running|blocked|done|class:)/.test(label));
}

async function listOpenPullRequests(repository) {
  const pulls = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/pulls?state=open&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    pulls.push(...batch);
    if (batch.length < 100) break;
  }
  return pulls;
}

async function upsertDriftIssue(repository, findings) {
  const marker = `df-prd-drift:${slug(repoName(repository))}`;
  const issues = await listIssues(gh, repository, "all");
  const existing = issues.find((issue) => (issue.body || "").includes(marker));
  const body = driftIssueBody(repoName(repository), findings);
  const title = `PRD drift report - ${repoName(repository)}`;

  if (existing) {
    const updated = await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, {
      title,
      body,
      state: "open"
    });
    await setIssueLabels(gh, repository, existing.number, ["P1", "df:prd-drift", "df:class:standard"]);
    return issueRef(updated);
  }

  const created = await gh.request("POST", `/repos/${repoName(repository)}/issues`, {
    title,
    body,
    labels: ["P1", "df:prd-drift", "df:class:standard"]
  });
  return issueRef(created);
}

async function writeLedger(ledger) {
  try {
    const written = await writeRunLedger(gh, DATA_REPO, "df-plan", repoName(TARGET_REPO), ledger);
    console.log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    console.warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}

function extractBlockedBy(body) {
  const numbers = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^Blocked-by:\s*#(\d+)\s*$/i);
    if (match) numbers.push(Number(match[1]));
  }
  return numbers;
}

function removeBlockedBySection(body) {
  const parts = body.split("\n## Planning Notes\n");
  let prefix = parts[0];
  prefix = prefix.replace(/\n## Sequencing\n[\s\S]*$/, "");
  return parts.length > 1 ? `${prefix}\n## Planning Notes\n${parts.slice(1).join("\n## Planning Notes\n")}` : prefix;
}

function applyBlockedBy(body, blockedBy) {
  const parts = body.split("\n## Planning Notes\n");
  let prefix = parts[0].replace(/\n## Sequencing\n[\s\S]*$/, "");
  if (blockedBy.length) {
    prefix += `\n## Sequencing\n\n${blockedBy.map((number) => `Blocked-by: #${number}`).join("\n")}`;
  }
  return parts.length > 1 ? `${prefix}\n## Planning Notes\n${parts.slice(1).join("\n## Planning Notes\n")}` : prefix;
}

function isPlannerBotClosure(issue) {
  const closedBy = issue?.closed_by;
  if (!closedBy || typeof closedBy.login !== "string") return false;
  if (closedBy.type !== "Bot") return false;
  return PLANNER_BOT_LOGINS.has(closedBy.login);
}

function humanClosedPrdComment(item) {
  return [
    "DarkFactory L4 planning noticed this issue is closed, but the tracked PRD item is still marked as incomplete.",
    "",
    `PRD source: ${item.sourcePath || "PRD.md"} > ${item.section} > ${item.name}`,
    "",
    "If this work is done, please edit the PRD to mark the item `[x]`; otherwise reopen this issue so DarkFactory can continue tracking it.",
    "",
    "This disagreement has been escalated to a `df:ask-owner` planning issue in the control repository."
  ].join("\n");
}

function askOwnerIssueMarker(repository, item) {
  return `df-ask-owner:human-closed-prd:${slug(repoName(repository))}:${item.slug}`;
}

function askOwnerIssueTitle(repository, item) {
  return `Human-closed PRD item - ${repoName(repository)} > ${item.name}`;
}

function askOwnerIssueBody(repository, item, issue) {
  const marker = askOwnerIssueMarker(repository, item);
  return [
    `<!-- ${marker} -->`,
    "## Human-closed PRD item",
    "",
    `Target repository: \`${repoName(repository)}\``,
    `Closed issue: ${issue.html_url || `#${issue.number}`}`,
    `PRD source: ${item.sourcePath || "PRD.md"} > ${item.section} > ${item.name}`,
    "",
    "### Question",
    "",
    `The PRD still lists **${item.name}** as incomplete, but the linked issue was closed by a human. Should DarkFactory:`,
    "",
    "- Mark the PRD item as completed by editing it to `[x]`, or",
    "- Reopen the issue so the loop continues to track it.",
    "",
    "### Acceptance Criteria",
    "",
    "- Edit the PRD or reopen the issue so the PRD/backlog contradiction is resolved.",
    "- Re-run DarkFactory planning and confirm this ask-owner issue is closed.",
    "",
    "### Token Use",
    "",
    "- AI tokens: 0 (deterministic planning escalation)."
  ].join("\n");
}

async function escalateHumanClosedPrdIssue(gh, controlRepo, repository, item, issue) {
  await ensureLabels(gh, controlRepo, [...PLANNING_LABELS, ...WORK_LABELS]);
  const marker = askOwnerIssueMarker(repository, item);
  const issues = await listIssues(gh, controlRepo, "all");
  const existing = issues.find((candidate) => (candidate.body || "").includes(marker));
  const title = askOwnerIssueTitle(repository, item);
  const body = askOwnerIssueBody(repository, item, issue);
  const labels = ["P1", "df:ask-owner", "df:class:standard"];

  if (existing) {
    const updated = await gh.request("PATCH", `/repos/${repoName(controlRepo)}/issues/${existing.number}`, {
      title,
      body,
      state: "open"
    });
    await setIssueLabels(gh, controlRepo, existing.number, labels, { preserveWorkerState: false });
    return {
      action: "escalate-human-closed-prd-issue",
      marker: item.marker,
      issue: issueRef(issue),
      ask_owner_issue: issueRef(updated)
    };
  }

  await gh.request("POST", `/repos/${repoName(repository)}/issues/${issue.number}/comments`, {
    body: humanClosedPrdComment(item)
  });
  const created = await gh.request("POST", `/repos/${repoName(controlRepo)}/issues`, {
    title,
    body,
    labels
  });
  return {
    action: "escalate-human-closed-prd-issue",
    marker: item.marker,
    issue: issueRef(issue),
    ask_owner_issue: issueRef(created),
    comment: true
  };
}

async function handleClosedIncompletePrdIssue(gh, repository, controlRepo, item, existing, labels, blockedBy) {
  if (isPlannerBotClosure(existing)) {
    const reopened = await gh.request("PATCH", `/repos/${repoName(repository)}/issues/${existing.number}`, {
      title: item.title,
      body: prdIssueBody(item, blockedBy),
      state: "open"
    });
    const labelUpdate = await setIssueLabels(gh, repository, existing.number, labels, { preserveWorkerState: false });
    const dispatch = await dispatchIfNewlyReady(gh, repository, existing.number, labelUpdate);
    const action = { action: "reopen-prd-issue", marker: item.marker, issue: issueRef(reopened), labels };
    if (dispatch) action.dispatch = dispatch;
    return { action, previousIssueNumber: reopened.number, previousOpenIssueNumber: reopened.number };
  }

  const escalation = await escalateHumanClosedPrdIssue(gh, controlRepo, repository, item, existing);
  return { action: escalation, previousIssueNumber: existing.number, previousOpenIssueNumber: null };
}

function issueRef(issue) {
  return { number: issue.number, url: issue.html_url };
}

export {
  PLANNER_BOT_LOGINS,
  isPlannerBotClosure,
  humanClosedPrdComment,
  askOwnerIssueMarker,
  askOwnerIssueTitle,
  askOwnerIssueBody,
  escalateHumanClosedPrdIssue,
  handleClosedIncompletePrdIssue
};
