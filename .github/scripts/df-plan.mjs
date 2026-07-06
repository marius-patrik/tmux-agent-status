import {
  DEFAULT_DATA_REPO,
  PLANNING_LABELS,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  driftIssueBody,
  ensureLabels,
  extractClosingIssueNumbers,
  findDriftMarker,
  findPrdMarker,
  getOptionalFileContent,
  getRepository,
  isActiveManagedRepo,
  listActiveManagedRepos,
  listIssues,
  readManagedRepoRegistry,
  parsePrdItems,
  parseRepo,
  plannedIssueLabelDiff,
  prdIssueBody,
  repoName,
  requiredEnv,
  slug,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";

const TOKEN = requiredEnv("DARK_FACTORY_TOKEN");
const CONTROL_REPO = parseRepo(requiredEnv("DF_CONTROL_REPO"));
let TARGET_REPO = parseRepo(process.env.DF_TARGET_REPO?.trim() || repoName(CONTROL_REPO));
const DATA_REPO = process.env.DF_DATA_REPO ?? DEFAULT_DATA_REPO;
const TRIGGER = process.env.DF_TRIGGER ?? "unknown";
const TARGET_REF = process.env.DF_TARGET_REF?.trim() || "";
const PLAN_ALL = process.env.DF_PLAN_ALL === "true";
const gh = createGithubClient(TOKEN, "darkfactory-plan");

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const registry = await readManagedRepoRegistry();
  const targets = PLAN_ALL ? await listActiveManagedRepos(gh, CONTROL_REPO, { registry }) : [TARGET_REPO];
  for (const target of targets) {
    TARGET_REPO = target;
    if (!isActiveManagedRepo(TARGET_REPO, registry)) {
      console.warn(`DarkFactory planning skipped ${repoName(TARGET_REPO)} because managed lifecycle state is not active.`);
      continue;
    }
    try {
      await reconcileTargetRepository();
    } catch (error) {
      if (warnReadOnlyRepository(TARGET_REPO, error, "planning")) continue;
      throw error;
    }
  }
}

async function reconcileTargetRepository() {
  assertAllowedRepo(TARGET_REPO);
  const repo = await getRepository(gh, TARGET_REPO);
  if (repo.archived === true || repo.disabled === true) {
    console.warn(`DarkFactory planning skipped ${repoName(TARGET_REPO)} because GitHub reports archived=${repo.archived === true} disabled=${repo.disabled === true}.`);
    return;
  }

  await ensureLabels(gh, TARGET_REPO, [...PLANNING_LABELS, ...WORK_LABELS]);
  const sourceRef = PLAN_ALL ? repo.default_branch : TARGET_REF || repo.default_branch;
  const prdSources = await getPrdSources(TARGET_REPO, sourceRef);
  const ledger = {
    trigger: TRIGGER,
    default_branch: repo.default_branch,
    source_ref: sourceRef,
    prd_files: prdSources.map((source) => source.path),
    actions: [],
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "L4 planning used deterministic PRD parsing only"
    }
  };

  if (prdSources.length === 0) {
    const issue = await upsertDriftIssue(TARGET_REPO, [`No \`PRD.md\` files were found on \`${sourceRef}\`.`]);
    ledger.actions.push({ action: "drift-report", reason: "missing-prd", issue });
    await writeLedger(ledger);
    return;
  }

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
      const labelUpdate = await setIssueLabels(TARGET_REPO, created.number, labels);
      const dispatch = await dispatchIfNewlyReady(TARGET_REPO, created.number, labelUpdate);
      ledger.actions.push({ action: "create-issue", marker: item.marker, issue: issueRef(created), labels });
      if (dispatch) ledger.actions.push(dispatch);
      previousIssueNumber = created.number;
      previousOpenIssueNumber = created.number;
      continue;
    }

    if (existing.state === "closed") {
      const reopened = await gh.request("PATCH", `/repos/${repoName(TARGET_REPO)}/issues/${existing.number}`, {
        title: item.title,
        body,
        state: "open"
      });
      const labelUpdate = await setIssueLabels(TARGET_REPO, existing.number, labels, { preserveWorkerState: false });
      const dispatch = await dispatchIfNewlyReady(TARGET_REPO, existing.number, labelUpdate);
      ledger.actions.push({ action: "reopen-prd-issue", marker: item.marker, issue: issueRef(reopened), labels });
      if (dispatch) ledger.actions.push(dispatch);
      previousIssueNumber = reopened.number;
      previousOpenIssueNumber = reopened.number;
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
    const labelUpdate = await setIssueLabels(TARGET_REPO, existing.number, labels);
    ledger.actions.push({ action: "sequence-labels", marker: item.marker, issue: issueRef(existing), labels });
    const dispatch = await dispatchIfNewlyReady(TARGET_REPO, existing.number, labelUpdate);
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

async function getPrdSources(repository, ref) {
  const paths = await listPrdPaths(repository, ref);
  const sources = [];
  for (const filePath of paths) {
    const content = await getOptionalFileContent(gh, repository, filePath, ref);
    if (content) sources.push({ path: filePath, content });
  }
  return sources;
}

async function listPrdPaths(repository, ref) {
  try {
    const tree = await getRecursiveTree(repository, ref);
    const paths = (tree.tree || [])
      .filter((entry) => entry.type === "blob" && (entry.path === "PRD.md" || entry.path.endsWith("/PRD.md")))
      .map((entry) => entry.path)
      .sort((a, b) => {
        if (a === "PRD.md") return -1;
        if (b === "PRD.md") return 1;
        return a.localeCompare(b);
      });
    return paths;
  } catch (error) {
    if (error.status !== 404) throw error;
    const root = await getOptionalFileContent(gh, repository, "PRD.md", ref);
    return root ? ["PRD.md"] : [];
  }
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

async function setIssueLabels(repository, issueNumber, labels, options = {}) {
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

async function dispatchIfNewlyReady(repository, issueNumber, labelUpdate) {
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
    await setIssueLabels(repository, existing.number, ["P1", "df:prd-drift", "df:class:standard"]);
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

function issueRef(issue) {
  return { number: issue.number, url: issue.html_url };
}
