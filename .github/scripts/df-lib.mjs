import { readFile, rm } from "node:fs/promises";
import path from "node:path";

export const API_ROOT = "https://api.github.com";
export const AGENT_OS_DATA_REPO = "marius-patrik/agents-data";
export const DARK_FACTORY_DATA_REPO = "marius-patrik/darkfactory-data";
export const PARKED_REPOS = new Set([
  "marius-patrik/fabrica",
  "marius-patrik/skyblock-agent",
  "marius-patrik/singularity",
  "marius-patrik/life-support"
]);
export const MANAGED_REPOS_PATH = ".darkfactory/managed-repos.json";
export const MANAGED_REPO_STATES = new Set(["active", "parked", "archived", "completed", "removed"]);

export const WORK_LABELS = [
  { name: "df:ready", color: "0E8A16", description: "DarkFactory work loop may pick up this issue" },
  { name: "df:running", color: "1D76DB", description: "DarkFactory worker is running for this issue" },
  { name: "df:blocked", color: "B60205", description: "DarkFactory worker is blocked on this issue" },
  { name: "df:done", color: "5319E7", description: "DarkFactory worker completed this issue" },
  { name: "df:ask-owner", color: "B60205", description: "DarkFactory needs owner input before continuing" },
  { name: "df:class:mechanical", color: "C5DEF5", description: "DarkFactory mechanical task with a narrow deterministic surface" },
  { name: "df:class:standard", color: "BFDADC", description: "DarkFactory standard task with normal implementation complexity" },
  { name: "df:class:hard", color: "D4C5F9", description: "DarkFactory hard task with substantial implementation complexity" }
];

export const PLANNING_LABELS = [
  { name: "roadmap", color: "5319E7", description: "DarkFactory roadmap item" },
  { name: "P0", color: "B60205", description: "Priority 0: urgent or release-blocking" },
  { name: "P1", color: "D93F0B", description: "Priority 1: important planned work" },
  { name: "P2", color: "FBCA04", description: "Priority 2: follow-up or lower urgency" },
  { name: "df:prd-drift", color: "B60205", description: "DarkFactory PRD drift report" },
  { name: "df:audit", color: "0E8A16", description: "DarkFactory audit finding" }
];

export const WORKER_PULL_REQUEST_AUTHORS = new Set([
  "github-actions[bot]",
  "mp-agents[bot]"
]);
export const WORKER_STATE_LABELS = ["df:running", "df:blocked", "df:done"];
export const PLANNER_RECONCILED_LABELS = [
  "df:ready",
  "df:class:mechanical",
  "df:class:standard",
  "df:class:hard",
  "df:prd-drift",
  "roadmap",
  "P0",
  "P1",
  "P2"
];

export function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function parseRepo(value) {
  const match = value.trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error(`Invalid repository name: ${value}`);
  return { owner: match[1], repo: match[2] };
}

export function repoName(repository) {
  return `${repository.owner}/${repository.repo}`;
}

export function normalizedRepoName(repository) {
  return repoName(repository).toLowerCase();
}

export function isParkedRepo(repository) {
  return PARKED_REPOS.has(normalizedRepoName(repository));
}

export function assertAllowedRepo(repository) {
  if (isParkedRepo(repository)) {
    throw new Error(`Refusing to touch parked repository: ${repoName(repository)}`);
  }
}

export async function readManagedRepoRegistry(root = process.cwd()) {
  const registry = await readRequiredJson(path.join(root, MANAGED_REPOS_PATH));
  if (!isRecord(registry) || registry.schemaVersion !== 1 || !isRecord(registry.repositories)) {
    throw new Error(`${MANAGED_REPOS_PATH} must define schemaVersion 1 and a repositories object.`);
  }
  return registry;
}

export function managedRepoLifecycleState(repository, registry) {
  const repositories = registry?.repositories && typeof registry.repositories === "object"
    ? registry.repositories
    : {};
  const entry = repositories[normalizedRepoName(repository)] ?? repositories[repoName(repository)];
  const state = typeof entry === "string" ? entry : entry?.state;
  if (!state) return "removed";
  if (!MANAGED_REPO_STATES.has(state)) {
    throw new Error(`Invalid DarkFactory managed repository state '${state}' for ${repoName(repository)}.`);
  }
  return state;
}

export function isActiveManagedRepo(repository, registry) {
  return managedRepoLifecycleState(repository, registry) === "active";
}

export function normalizeInstallationRepository(repository) {
  if (repository?.full_name) {
    return {
      repository: parseRepo(repository.full_name),
      archived: repository.archived === true,
      disabled: repository.disabled === true
    };
  }

  if (repository?.owner?.login && repository?.name) {
    return {
      repository: { owner: repository.owner.login, repo: repository.name },
      archived: repository.archived === true,
      disabled: repository.disabled === true
    };
  }

  return null;
}

export async function listInstallationRepositories(gh) {
  const repositories = [];
  for (let page = 1; page <= 20; page += 1) {
    const data = await gh.request("GET", `/installation/repositories?per_page=100&page=${page}`);
    if (!Array.isArray(data.repositories) || data.repositories.length === 0) break;
    repositories.push(...data.repositories);
    if (data.repositories.length < 100) break;
  }
  return repositories;
}

export async function listActiveManagedRepos(gh, controlRepo, options = {}) {
  const registry = options.registry ?? await readManagedRepoRegistry(options.root ?? process.cwd());
  const installationRepositories = options.repositories ?? await listInstallationRepositories(gh);
  const warn = options.warn ?? console.warn;
  const active = [];

  for (const installationRepository of installationRepositories) {
    const normalized = normalizeInstallationRepository(installationRepository);
    if (!normalized) continue;
    const { repository, archived, disabled } = normalized;
    if (repository.owner !== controlRepo.owner) continue;

    const state = managedRepoLifecycleState(repository, registry);
    if (archived || disabled) {
      warn(`DarkFactory skipped ${repoName(repository)} because GitHub reports archived=${archived} disabled=${disabled}.`);
      continue;
    }
    if (state !== "active") {
      warn(`DarkFactory skipped ${repoName(repository)} because managed lifecycle state is '${state}'.`);
      continue;
    }
    active.push(repository);
  }

  active.sort((a, b) => normalizedRepoName(a).localeCompare(normalizedRepoName(b)));
  return active;
}

export function isRepositoryReadOnlyError(error) {
  if (error?.status !== 403) return false;
  return /\b(archived|disabled|read-?only|read only)\b/i.test(error.message || "");
}

export function warnReadOnlyRepository(repository, error, action = "write", warn = console.warn) {
  if (!isRepositoryReadOnlyError(error)) return false;
  warn(`DarkFactory skipped ${action} for ${repoName(repository)} because the repository is archived, disabled, or read-only: ${error.message || String(error)}`);
  return true;
}

export function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export function taskClassFromLabels(labels) {
  const names = new Set(
    (Array.isArray(labels) ? labels : [])
      .map((label) => typeof label === "string" ? label : label?.name)
      .filter(Boolean)
  );

  if (names.has("df:class:mechanical")) return { taskClass: "mechanical" };
  if (names.has("df:class:hard")) return { taskClass: "hard" };
  return { taskClass: "standard" };
}

export function reconcileLabelDiff(currentLabels, desiredLabels, reconciledLabels) {
  const current = new Set((currentLabels || []).filter(Boolean));
  const desired = new Set((desiredLabels || []).filter(Boolean));
  const reconciled = new Set((reconciledLabels || []).filter(Boolean));

  return {
    add: [...desired].filter((label) => !current.has(label)),
    remove: [...reconciled].filter((label) => current.has(label) && !desired.has(label))
  };
}

export function plannedIssueLabelDiff(currentLabels, desiredLabels, options = {}) {
  const preserveWorkerState = options.preserveWorkerState !== false;
  const current = new Set((currentLabels || []).filter(Boolean));
  const hasWorkerState = WORKER_STATE_LABELS.some((label) => current.has(label));
  const desired = preserveWorkerState && hasWorkerState
    ? (desiredLabels || []).filter((label) => label !== "df:ready")
    : desiredLabels;
  const reconciled = preserveWorkerState
    ? PLANNER_RECONCILED_LABELS
    : [...PLANNER_RECONCILED_LABELS, ...WORKER_STATE_LABELS];

  return reconcileLabelDiff(currentLabels, desired, reconciled);
}

export function isDarkFactoryWorkerPullRequest(pull, repository) {
  const provenance = `${pull.title || ""}\n${pull.body || ""}`;
  const sameRepositoryHead = pull.headRepository?.owner?.login === repository.owner && pull.headRepository?.name === repository.repo;
  const markerIssue = darkFactoryWorkerIssueNumber(pull);
  const branchMatchesIssue = Number.isInteger(markerIssue) && markerIssue > 0 && pull.headRefName?.startsWith(`df/${markerIssue}-`);
  const bodyClosesIssue = extractClosingIssueNumbers(pull.body || "", repoName(repository)).includes(markerIssue);
  const allowedAuthor = WORKER_PULL_REQUEST_AUTHORS.has(pull.author?.login || "");

  return (
    sameRepositoryHead &&
    allowedAuthor &&
    markerIssue > 0 &&
    branchMatchesIssue &&
    bodyClosesIssue
  );
}

export async function findOpenWorkerPullRequestForIssue(gh, repository, issueNumber) {
  const query = `
    query WorkerPulls($owner: String!, $repo: String!, $cursor: String) {
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
            headRefName
            baseRefName
            headRepository {
              name
              owner { login }
            }
            author { login }
          }
        }
      }
    }`;
  let cursor = null;

  for (let page = 1; page <= 20; page += 1) {
    const data = await gh.graphql(query, { owner: repository.owner, repo: repository.repo, cursor });
    const connection = data.repository.pullRequests;
    const match = connection.nodes.find((pull) => {
      return (
        pull.headRefName?.startsWith(`df/${issueNumber}-`) &&
        darkFactoryWorkerIssueNumber(pull) === issueNumber &&
        isDarkFactoryWorkerPullRequest(pull, repository)
      );
    });
    if (match) return match;

    if (!connection.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return null;
}

export function darkFactoryWorkerIssueNumber(pull) {
  const provenance = `${pull.title || ""}\n${pull.body || ""}`;
  const marker = provenance.match(/<!--\s*dark-factory:worker-pr\s+issue=(\d+)\s*-->/i);
  return marker ? Number(marker[1]) : 0;
}

export async function cleanupTempRoot(tempRoot, warn = console.warn) {
  if (!tempRoot) return { ok: true, warning: "" };

  try {
    await rm(tempRoot, { recursive: true, force: true });
    return { ok: true, warning: "" };
  } catch (error) {
    if (isIgnorableCleanupError(error)) {
      return { ok: true, warning: "" };
    }

    const warning = `DarkFactory cleanup warning: ${error.message || String(error)}`;
    warn(warning);
    return { ok: false, warning };
  }
}

export function isIgnorableCleanupError(error) {
  return error?.code === "ENOENT";
}

export function createGithubClient(token, userAgent = "darkfactory") {
  return {
    async request(method, pathName, body) {
      const response = await fetch(`${API_ROOT}${pathName}`, {
        method,
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`${method} ${pathName} failed with ${response.status}: ${sanitize(text, token)}`);
        error.status = response.status;
        throw error;
      }

      if (response.status === 204) return null;
      return await response.json();
    },

    async graphql(query, variables) {
      const response = await fetch(`${API_ROOT}/graphql`, {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": userAgent
        },
        body: JSON.stringify({ query, variables })
      });
      const payload = await response.json();
      if (!response.ok || payload.errors?.length) {
        throw new Error(sanitize(JSON.stringify(payload.errors || payload), token));
      }
      return payload.data;
    }
  };
}

export async function ensureLabels(gh, repository, labels) {
  for (const label of labels) {
    try {
      await gh.request("POST", `/repos/${repoName(repository)}/labels`, label);
    } catch (error) {
      if (error.status !== 422) throw error;
      await gh.request("PATCH", `/repos/${repoName(repository)}/labels/${encodeURIComponent(label.name)}`, {
        color: label.color,
        description: label.description
      });
    }
  }
}

export async function getRepository(gh, repository) {
  return await gh.request("GET", `/repos/${repoName(repository)}`);
}

export async function getBranchProtection(gh, repository, branch) {
  try {
    const data = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/branches/${encodeURIComponent(branch)}/protection`
    );
    return { configured: true, data };
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      return {
        configured: false,
        status: error.status,
        reason: error.message || String(error)
      };
    }
    throw error;
  }
}

export async function preflightMergePolicy(gh, repository, baseBranch, repo) {
  const branchProtection = await getBranchProtection(gh, repository, baseBranch);
  const autoMergeSupported = repo.allow_auto_merge === true;
  const requiredContexts = branchProtection.configured
    ? await getRequiredStatusCheckContexts(gh, repository, baseBranch)
    : [];

  if (!branchProtection.configured || requiredContexts.length === 0) {
    const summary = branchProtection.configured
      ? `branch protection on \`${baseBranch}\` has no required status checks; green-PR sweep will squash-merge directly after checks`
      : `no branch protection on \`${baseBranch}\`; green-PR sweep will squash-merge directly after checks`;

    return {
      blocked: false,
      useAutomerge: false,
      autoMergeSupported,
      branchProtection,
      requiredChecks: requiredContexts,
      summary
    };
  }

  if (autoMergeSupported) {
    return {
      blocked: false,
      useAutomerge: true,
      autoMergeSupported,
      branchProtection,
      requiredChecks: requiredContexts,
      summary: `auto-merge is available for \`${baseBranch}\`; GitHub automerge will be attempted`
    };
  }

  return {
    blocked: true,
    reason: [
      `Target repository ${repoName(repository)} has branch protection with required status checks configured on \`${baseBranch}\`,`,
      "so DarkFactory policy requires GitHub auto-merge before dispatching a worker.",
      "Enable repository auto-merge or open managed setup work to enable it, then re-apply `df:ready`."
    ].join(" "),
    useAutomerge: false,
    autoMergeSupported,
    branchProtection,
    requiredChecks: requiredContexts,
    summary: `branch protection with required status checks is configured on \`${baseBranch}\`, but target repository auto-merge is disabled; worker dispatch is blocked`
  };
}

export async function getRequiredStatusCheckContexts(gh, repository, branch) {
  try {
    const data = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/branches/${encodeURIComponent(branch)}/protection`
    );
    const checks = data?.required_status_checks;
    if (!checks) return [];

    if (Array.isArray(checks.checks)) {
      return checks.checks.map((check) => check.context).filter(Boolean);
    }

    if (Array.isArray(checks.contexts)) return checks.contexts;
    return [];
  } catch (error) {
    if (error.status === 404) return [];
    if (error.status === 403) return [];
    throw error;
  }
}

export const CODEX_REVIEW_REQUIRED_CONTEXT = "Codex Review";

export function withCodexReviewRequiredContext(requiredContexts = []) {
  return [...new Set([...requiredContexts, CODEX_REVIEW_REQUIRED_CONTEXT].filter(Boolean))];
}

export async function getOptionalFileContent(gh, repository, filePath, ref) {
  try {
    const data = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/contents/${encodePath(filePath)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`
    );
    return decodeContentResponse(data);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function listIssues(gh, repository, state = "all") {
  const issues = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues?state=${state}&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) break;
  }
  return issues;
}

export function parsePrdItems(markdown, sourcePath = "PRD.md") {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const items = [];
  let section = "";

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }

    const bullet = line.match(/^-\s*(?:\[(?<check>[ xX])\]\s*)?\*\*(?<name>.+?)\*\*:?\s*(?<detail>.*)$/);
    if (!bullet) continue;
    if (!/^(core loops|milestones)$/i.test(section)) continue;

    const name = bullet.groups.name.trim();
    const detail = bullet.groups.detail.trim();
    const completed = /^(x|X)$/.test(bullet.groups.check || "");
    const acceptanceMatch = detail.match(/\bAcceptance:\s*(.+)$/i);
    const description = acceptanceMatch ? detail.slice(0, acceptanceMatch.index).trim() : detail;
    const acceptance = acceptanceMatch ? acceptanceMatch[1].trim() : "";
    const stableId = name.match(/^(M\d+|L\d+)\b/i)?.[1]?.toLowerCase() || slug(name);
    const priority = /^M[1-3]\b/i.test(name) || /^L[0-4]\b/i.test(name) ? "P1" : "P2";
    const markerPrefix = sourcePath === "PRD.md" ? "" : `${sourcePath}-`;
    const marker = `df-prd:${slug(`${markerPrefix}${section}-${stableId}`)}`;

    items.push({
      marker,
      slug: marker.slice("df-prd:".length),
      sourcePath,
      section,
      name,
      title: prdIssueTitle(name),
      description,
      acceptance,
      completed,
      priority,
      taskClass: classifyPrdItem(name, description)
    });
  }

  return items;
}

export function prdIssueBody(item, blockedBy = []) {
  const acceptance = item.acceptance
    ? `- ${item.acceptance}`
    : "- Keep implementation aligned with the PRD item and update this issue when the PRD changes.";
  const blockedByLines = blockedBy.length
    ? ["", "## Sequencing", "", ...blockedBy.map((issueNumber) => `Blocked-by: #${issueNumber}`)]
    : [];

  return [
    `<!-- ${item.marker} -->`,
    "## Source",
    "",
    `${item.sourcePath || "PRD.md"} > ${item.section} > ${item.name}`,
    "",
    "## PRD Item",
    "",
    item.description || item.name,
    "",
    "## Acceptance Criteria",
    "",
    acceptance,
    ...blockedByLines,
    "",
    "## Planning Notes",
    "",
    "- Generated by DarkFactory L4 planning using deterministic PRD parsing.",
    "- Stable marker keeps this issue linked to the PRD across title/body edits.",
    "- Execution boundary: planning is deterministic GitHub state; any local model work is delegated to Agent OS."
  ].join("\n");
}

export function driftIssueBody(targetRepoName, driftItems) {
  return [
    `<!-- df-prd-drift:${slug(targetRepoName)} -->`,
    "## Drift Report",
    "",
    `Target repository: \`${targetRepoName}\``,
    "",
    "DarkFactory found backlog or code state that no longer matches the tracked PRD files.",
    "",
    "## Findings",
    "",
    driftItems.map((item) => `- ${item}`).join("\n") || "- No drift details were provided.",
    "",
    "## Acceptance Criteria",
    "",
    "- Reconcile the repository state, backlog, or PRD so the contradiction is gone.",
    "- Re-run DarkFactory planning and confirm this drift report is no longer updated.",
    "",
    "## Token Use",
    "",
    "- AI tokens: 0 (deterministic drift detection)."
  ].join("\n");
}

export function auditIssueBody(targetRepoName, findings, metadata = {}) {
  const auditedAt = metadata.auditedAt || new Date().toISOString();
  const categories = Array.isArray(findings) ? findings : [];

  return [
    `<!-- df-audit:${slug(targetRepoName)} -->`,
    "## Audit Report",
    "",
    `Target repository: \`${targetRepoName}\``,
    `Audited at: \`${auditedAt}\``,
    "",
    "DarkFactory found repository health, enforcement, PRD, documentation, or git-state findings that need follow-up.",
    "",
    "## Findings",
    "",
    categories.length
      ? categories.map((finding) => `- **${finding.category}**: ${finding.message}`).join("\n")
      : "- No audit details were provided.",
    "",
    "## Acceptance Criteria",
    "",
    "- Resolve or explicitly accept each audit finding.",
    "- Re-run DarkFactory audit and confirm this issue is closed or updated with only remaining findings.",
    "",
    "## Audit Scope",
    "",
    "- Git state: default branch metadata and branch protection.",
    "- Health: latest GitHub Actions workflow conclusions on the default branch.",
    "- Enforcement conformance: required DarkFactory-managed files and workflows.",
    "- PRD drift: presence of tracked `PRD.md` files and PRD-backed backlog state.",
    "- Doc staleness: stale PRD/agent docs relative to recent repository activity.",
    "- AI tokens: 0 (deterministic audit checks).",
    "- Execution boundary: audit findings are deterministic GitHub state; any local model work is delegated to Agent OS."
  ].join("\n");
}

export function findPrdMarker(body) {
  return body?.match(/df-prd:[a-z0-9-]+/)?.[0] ?? "";
}

export function findDriftMarker(body) {
  return body?.match(/df-prd-drift:[a-z0-9-]+/)?.[0] ?? "";
}

export function findAuditMarker(body) {
  return body?.match(/df-audit:[a-z0-9-]+/)?.[0] ?? "";
}

export function checksAreGreen(statusCheckRollup, requiredContexts = []) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return requiredContexts.length === 0;
  }

  if (!statusCheckRollup.every(checkIsGreen)) return false;

  return requiredContexts.every((context) => {
    return statusCheckRollup.some((check) => checkContextName(check) === context);
  });
}

function checkIsGreen(check) {
  if (check.__typename === "CheckRun") {
    return check.status === "COMPLETED" && check.conclusion === "SUCCESS";
  }
  if (check.__typename === "StatusContext") {
    return check.state === "SUCCESS";
  }
  return false;
}

function checkContextName(check) {
  if (check.__typename === "CheckRun") return check.name || "";
  if (check.__typename === "StatusContext") return check.context || "";
  return "";
}

export function checksSummary(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) return "no checks configured";
  return statusCheckRollup.map((check) => {
    if (check.__typename === "CheckRun") return `${check.name}:${check.status}/${check.conclusion ?? "none"}`;
    if (check.__typename === "StatusContext") return `${check.context}:${check.state}`;
    return check.__typename ?? "unknown";
  }).join(", ");
}

export function extractClosingIssueNumbers(body, repositoryName = "") {
  const refs = new Set();
  const matches = body?.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#|#)(\d+)\b/gi) ?? [];
  const expectedRepo = repositoryName.toLowerCase();
  for (const match of matches) {
    const qualifiedRepo = match[1]?.toLowerCase() || "";
    if (qualifiedRepo && qualifiedRepo !== expectedRepo) continue;
    refs.add(Number(match[2]));
  }
  return [...refs].filter((number) => Number.isInteger(number) && number > 0);
}

export async function writeRunLedger(gh, dataRepo, kind, targetRepoName, ledger) {
  if (dataRepo !== DARK_FACTORY_DATA_REPO) {
    throw new Error(`DarkFactory ledger writes require the canonical ${DARK_FACTORY_DATA_REPO} repository.`);
  }
  const repository = parseRepo(DARK_FACTORY_DATA_REPO);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `runs/${targetRepoName}/${timestamp}-${kind}.json`;
  const body = `${JSON.stringify({
    kind,
    target_repo: targetRepoName,
    created_at: new Date().toISOString(),
    ...ledger
  }, null, 2)}\n`;
  const existing = await getOptionalContentWithSha(gh, repository, path);

  await gh.request("PUT", `/repos/${repoName(repository)}/contents/${encodePath(path)}`, {
    message: `Add DarkFactory ${kind} ledger for ${targetRepoName}`,
    content: Buffer.from(body, "utf8").toString("base64"),
    sha: existing?.sha
  });

  return { repository: repoName(repository), path };
}

export async function readRequiredJson(filePath) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read required JSON file ${filePath}: ${error.message || String(error)}`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message || String(error)}`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sanitize(value, ...secrets) {
  let out = String(value);
  for (const secret of secrets.filter(Boolean)) {
    out = out.split(secret).join("***");
    out = out.split(Buffer.from(`x-access-token:${secret}`).toString("base64")).join("***");
  }
  return out;
}

export function listPackagePaths(treeEntries) {
  const packageDirs = new Set();
  for (const entry of treeEntries || []) {
    if (entry?.type !== "blob" || typeof entry?.path !== "string" || !entry.path.endsWith("/package.json")) {
      continue;
    }
    const dir = entry.path.slice(0, -"/package.json".length);
    if (dir.includes("node_modules") || dir.includes("/.") || !dir) {
      continue;
    }
    packageDirs.add(dir);
  }
  return [...packageDirs].sort();
}

export function scaffoldPackagePrd(repositoryName, options = {}) {
  const { vision = "", packageName = "", isRoot = false } = options;
  const title = isRoot ? repositoryName : packageName || repositoryName;
  const firstParagraph = vision || "Define the product vision here, aligned with the Agent OS root product context.";

  return [
    `# ${title} PRD`,
    "",
    `> This file is the **source of truth** for ${title}. The backlog, branches, PRs, and releases are derived from it. Edits to this file are the primary way to steer the product.`,
    "",
    "## Vision",
    "",
    firstParagraph,
    "",
    "## Core loops",
    "",
    "- **L1 Sync**: Managed baseline files pushed to every installed repo.",
    "- **L2 Review**: Review gate on every PR.",
    "- **L3 Work**: Ready issues become branches, PRs, and merged code.",
    "- **L4 Planning**: PRD.md edits automatically reconcile sequenced backlog issues.",
    "",
    "## Milestones",
    "",
    "- **M1 — Scaffold**: Establish this PRD and initial backlog via DarkFactory L4 planning.",
    "",
    "## Non-goals",
    "",
    "- Multi-tenant / marketplace distribution.",
    "- A separate web dashboard — GitHub Projects/issues are the dashboard.",
    "",
    "## Operating rules",
    "",
    "- Issue = contract; acceptance criteria in the issue body are the definition of done.",
    "- Never force-push, never bypass gates, never merge red."
  ].join("\n");
}

export function extractReadmeFirstParagraph(readme) {
  if (typeof readme !== "string" || !readme.trim()) {
    return "";
  }
  const lines = readme.replace(/\r\n/g, "\n").split("\n");
  const paragraphs = [];
  let current = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current) {
        paragraphs.push(current.trim());
        current = "";
      }
      continue;
    }
    if (trimmed.startsWith("#")) {
      continue;
    }
    current += ` ${trimmed}`;
  }
  if (current) {
    paragraphs.push(current.trim());
  }

  const first = paragraphs[0] || "";
  return first.length > 300 ? `${first.slice(0, 297)}...` : first;
}

export function prdScaffoldPullRequestBody(targetRepoName, paths) {
  const files = paths.map((p) => `- \`${p}\``).join("\n");
  return [
    "<!-- dark-factory:prd-scaffold -->",
    "## Summary",
    "",
    `DarkFactory fleet bootstrap found missing PRD files in \`${targetRepoName}\` and is opening the smallest scaffold PR so L4 planning can reconcile the backlog from PRD sections.`,
    "",
    "## Files",
    "",
    files,
    "",
    "## Notes",
    "",
    "- This scaffold is derived from the repository README and the Agent OS root product context. The owner should edit the PRD before merge to reflect the actual product.",
    "- After merge, DarkFactory L4 planning will parse the PRD and file/update sequenced issues with stable `df-prd:` markers.",
    "- Parked repositories are never touched."
  ].join("\n");
}

function prdIssueTitle(name) {
  const normalized = name.replace(/\s+[—-]\s+/, " - ");
  return normalized.match(/^(M\d+|L\d+)\b/i) ? normalized : `PRD - ${normalized}`;
}

function classifyPrdItem(name, description) {
  const text = `${name} ${description}`.toLowerCase();
  if (/\b(label|docs?|comment|cleanup|mechanical|managed file)\b/.test(text)) return "mechanical";
  if (/\b(orchestrator|audit|semantic|cross-repo|cluster|scheduler|review gate)\b/.test(text)) return "hard";
  return "standard";
}

async function getOptionalContentWithSha(gh, repository, filePath) {
  try {
    const data = await gh.request("GET", `/repos/${repoName(repository)}/contents/${encodePath(filePath)}`);
    if (data?.type !== "file" || typeof data.sha !== "string") return null;
    return { sha: data.sha };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function decodeContentResponse(data) {
  if (!data || data.type !== "file" || typeof data.content !== "string") return null;
  const encoding = typeof data.encoding === "string" ? data.encoding : "base64";
  if (encoding !== "base64") return null;
  return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8").replace(/\r\n/g, "\n");
}

function encodePath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

export async function readLatestRunLedger(gh, dataRepo, kind, targetRepoName) {
  if (dataRepo !== DARK_FACTORY_DATA_REPO) {
    throw new Error(`DarkFactory ledger reads require the canonical ${DARK_FACTORY_DATA_REPO} repository.`);
  }
  const repository = parseRepo(DARK_FACTORY_DATA_REPO);
  const ledgerDir = `runs/${targetRepoName}`;
  const response = await gh.request("GET", `/repos/${repoName(repository)}/contents/${encodePath(ledgerDir)}`);
  if (!Array.isArray(response)) {
    return null;
  }

  const suffix = `-${kind}.json`;
  const matches = response
    .filter((entry) => isRecord(entry) && typeof entry.name === "string" && entry.name.endsWith(suffix) && entry.type === "file")
    .map((entry) => entry.name)
    .sort()
    .reverse();

  if (matches.length === 0) {
    return null;
  }

  const content = await getOptionalFileContent(gh, repository, `${ledgerDir}/${matches[0]}`);
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function parseWorkerClaim(ledger) {
  if (!isRecord(ledger)) {
    return null;
  }

  const issueText = typeof ledger.issue === "string" ? ledger.issue : "";
  const issueMatch = issueText.match(/([^/\s]+)\/([^/\s]+)#(\d+)$/);
  const issueNumber = Number.isInteger(ledger.issue_number)
    ? ledger.issue_number
    : (issueMatch ? Number(issueMatch[3]) : 0);
  const repoNameFromIssue = issueMatch ? `${issueMatch[1]}/${issueMatch[2]}` : "";
  const repoNameFromLedger = typeof ledger.target_repo === "string" ? ledger.target_repo : "";

  const provider = typeof ledger.token_usage?.provider === "string"
    ? ledger.token_usage.provider
    : (typeof ledger.provider === "string" ? ledger.provider : "");
  const model = typeof ledger.token_usage?.model === "string"
    ? ledger.token_usage.model
    : (typeof ledger.model === "string" ? ledger.model : "");

  return {
    repo: repoNameFromLedger || repoNameFromIssue || "",
    issueNumber,
    branch: typeof ledger.branch === "string" ? ledger.branch : "",
    baseBranch: typeof ledger.base_branch === "string" ? ledger.base_branch : "",
    pullRequestNumber: Number.isInteger(ledger.pull_request_number) ? ledger.pull_request_number : 0,
    pullRequestUrl: typeof ledger.pull_request === "string" ? ledger.pull_request : "",
    provider,
    model,
    status: typeof ledger.status === "string" ? ledger.status : "",
    summary: typeof ledger.worker_summary === "string" ? ledger.worker_summary : ""
  };
}

export async function verifyWorkerClaim(gh, claim, repository, issueNumber) {
  const mismatches = [];

  if (claim.repo) {
    try {
      const claimedRepo = parseRepo(claim.repo);
      if (normalizedRepoName(repository) !== normalizedRepoName(claimedRepo)) {
        mismatches.push(`Claimed repository ${claim.repo} does not match target ${repoName(repository)}.`);
      }
    } catch {
      mismatches.push(`Claimed repository ${claim.repo} is not a valid repository reference.`);
    }
  }

  if (Number.isInteger(claim.issueNumber) && claim.issueNumber > 0 && claim.issueNumber !== issueNumber) {
    mismatches.push(`Claimed issue #${claim.issueNumber} does not match target issue #${issueNumber}.`);
  }

  let issue;
  try {
    issue = await gh.request("GET", `/repos/${repoName(repository)}/issues/${issueNumber}`);
  } catch (error) {
    if (error.status === 404) {
      mismatches.push(`Target issue #${issueNumber} does not exist.`);
      return { verified: false, mismatches, issue: null, pullRequest: null };
    }
    throw error;
  }

  if (issue.state !== "open") {
    mismatches.push(`Target issue #${issueNumber} is ${issue.state}, not open.`);
  }

  const issueLabels = new Set((issue.labels || []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean));
  if (!issueLabels.has("df:running")) {
    mismatches.push(`Target issue #${issueNumber} is not labeled df:running.`);
  }

  let pullRequest = null;
  if (claim.pullRequestNumber > 0) {
    try {
      pullRequest = await gh.request("GET", `/repos/${repoName(repository)}/pulls/${claim.pullRequestNumber}`);
    } catch (error) {
      if (error.status === 404) {
        mismatches.push(`Claimed PR #${claim.pullRequestNumber} does not exist.`);
      } else {
        throw error;
      }
    }
  }

  if (!pullRequest && claim.branch) {
    const pulls = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/pulls?state=open&head=${encodeURIComponent(`${repository.owner}:${claim.branch}`)}`
    );
    if (Array.isArray(pulls) && pulls.length > 0) {
      pullRequest = pulls[0];
    }
  }

  if (!pullRequest) {
    mismatches.push(`No open PR found for issue #${issueNumber}${claim.branch ? ` (branch ${claim.branch})` : ""}.`);
    return { verified: false, mismatches, issue, pullRequest: null };
  }

  if (pullRequest.state !== "open") {
    mismatches.push(`PR #${pullRequest.number} is ${pullRequest.state}, not open.`);
  }

  const headRepo = pullRequest.head?.repo;
  if (!headRepo || headRepo.owner?.login !== repository.owner || headRepo.name !== repository.repo) {
    mismatches.push(`PR #${pullRequest.number} head repository is ${headRepo?.full_name || "unknown"}, not ${repoName(repository)}.`);
  }

  if (claim.branch && pullRequest.head?.ref !== claim.branch) {
    mismatches.push(`PR #${pullRequest.number} head branch is ${pullRequest.head?.ref}, not ${claim.branch}.`);
  }

  if (claim.baseBranch && pullRequest.base?.ref !== claim.baseBranch) {
    mismatches.push(`PR #${pullRequest.number} base branch is ${pullRequest.base?.ref}, not ${claim.baseBranch}.`);
  }

  const prAuthor = pullRequest.user?.login || "";
  if (!WORKER_PULL_REQUEST_AUTHORS.has(prAuthor)) {
    mismatches.push(`PR #${pullRequest.number} author ${prAuthor} is not an allowed worker author.`);
  }

  const closesIssues = extractClosingIssueNumbers(pullRequest.body || "", repoName(repository));
  if (!closesIssues.includes(issueNumber)) {
    mismatches.push(`PR #${pullRequest.number} body does not close issue #${issueNumber}.`);
  }

  const changedFiles = await listPullRequestFiles(gh, repository, pullRequest.number);
  if (changedFiles.length === 0) {
    mismatches.push(`PR #${pullRequest.number} has no changed files.`);
  }

  const branch = pullRequest.head?.ref;
  if (branch) {
    try {
      await gh.request("GET", `/repos/${repoName(repository)}/git/ref/heads/${encodeRefPath(branch)}`);
    } catch (error) {
      if (error.status === 404) {
        mismatches.push(`PR #${pullRequest.number} head branch ${branch} does not exist.`);
      } else {
        throw error;
      }
    }
  }

  return {
    verified: mismatches.length === 0,
    mismatches,
    issue,
    pullRequest,
    changedFiles
  };
}

async function listPullRequestFiles(gh, repository, pullNumber) {
  const files = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/pulls/${pullNumber}/files?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

function encodeRefPath(ref) {
  return String(ref || "").split("/").map(encodeURIComponent).join("/");
}

export function isVerifiedWorkerIssue(issue) {
  const labels = new Set((issue.labels || []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean));
  return labels.has("df:done");
}
