import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DARK_FACTORY_DATA_REPO,
  PLANNING_LABELS,
  WORK_LABELS,
  assertAllowedRepo,
  createGithubClient,
  ensureLabels,
  findOpenWorkerPullRequestForIssue,
  getRepository,
  listActiveManagedRepos,
  normalizedRepoName,
  parseRepo,
  preflightMergePolicy,
  readRequiredJson,
  repoName,
  requiredEnv,
  warnReadOnlyRepository,
  writeRunLedger
} from "./df-lib.mjs";

const CONTROL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORCHESTRATION_POLICY_PATH = ".darkfactory/orchestration.json";
export const DASHBOARD_MARKER = "df-dashboard:orchestration";
export const ASK_OWNER_MARKER = "dark-factory:orchestrator-ask-owner";
export const RESUME_MARKER = "dark-factory:worker-resume";
export const REPEATED_FAILURE_THRESHOLD = 3;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  // GITHUB_TOKEN cannot perform cross-repo issue writes or dispatch workers in
  // every managed repository; the orchestrator must use the app installation token.
  const appInstallationToken = requiredEnv("DARK_FACTORY_TOKEN");
  const controlRepo = parseRepo(requiredEnv("DF_CONTROL_REPO"));
  const trigger = process.env.DF_TRIGGER ?? "unknown";
  const dispatchRequest = parseWorkflowDispatchRequest(
    process.env.DF_TARGET_REPO,
    process.env.DF_TARGET_ISSUE_NUMBER,
    process.env.DF_SOURCE_EVENT,
    console.warn
  );
  const gh = createGithubClient(appInstallationToken, "darkfactory-orchestrate");

  await orchestrate({ gh, controlRepo, trigger, root: CONTROL_ROOT, dispatchRequest });
}

export async function orchestrate(options) {
  const {
    gh,
    controlRepo,
    trigger = "unknown",
    root = CONTROL_ROOT,
    registry,
    repositories,
    dispatchRequest: dispatchRequestInput,
    policy: policyInput,
    writeLedger: shouldWriteLedger = true,
    updateDashboard: shouldUpdateDashboard = true,
    warn = console.warn,
    log = console.log
  } = options;

  assertAllowedRepo(controlRepo);
  const isEventTrigger = trigger === "issue_comment" || trigger === "issues";
  const eventRequest = parseEventRequest(process.env.GITHUB_EVENT_PAYLOAD || "", trigger, warn)
    ?? normalizeDispatchRequest(dispatchRequestInput, warn)
    ?? parseWorkflowDispatchRequest(
      process.env.DF_TARGET_REPO,
      process.env.DF_TARGET_ISSUE_NUMBER,
      process.env.DF_SOURCE_EVENT,
      warn
    );
  const policy = normalizeOrchestrationPolicy(policyInput ?? await readOrchestrationPolicy(root));
  let targets = [];
  if (eventRequest) {
    const activeTargets = await targetRepositories(gh, controlRepo, { root, registry, repositories, warn });
    const activeEventTarget = activeTargets.find((target) => repoName(target) === repoName(eventRequest.repository));
    if (activeEventTarget) {
      targets = [activeEventTarget];
      if (eventRequest.slashRun) {
        await readySlashRunIssue(gh, activeEventTarget, eventRequest.issueNumber);
      }
    } else {
      warn(`DarkFactory ignored event for unmanaged repository ${repoName(eventRequest.repository)}.`);
    }
  } else if (!isEventTrigger) {
    targets = await targetRepositories(gh, controlRepo, { root, registry, repositories, warn });
  }
  const snapshots = [];

  for (const target of targets) {
    try {
      snapshots.push({ repository: target, openIssues: await listOpenIssues(gh, target) });
    } catch (error) {
      if (warnReadOnlyRepository(target, error, "orchestration")) continue;
      warn(`Failed to inspect ${repoName(target)} for orchestration: ${error.message || String(error)}`);
    }
  }

  const scopedSnapshots = eventRequest
    ? snapshots.map((snapshot) => ({
      ...snapshot,
      openIssues: (snapshot.openIssues || []).filter((issue) => issue.number === eventRequest.issueNumber)
    }))
    : snapshots;
  const autoReadied = await autoReadySequencedIssues(gh, snapshots, warn, { targetIssue: eventRequest });
  const escalated = await escalateOwnerDecisionIssues(gh, scopedSnapshots, warn);
  const plan = buildOrchestrationPlan(scopedSnapshots, policy, { targetIssue: eventRequest });

  const interrupted = await detectInterruptedWorkerRuns(gh, scopedSnapshots, { warn });
  const recoveries = [];
  for (const item of interrupted) {
    const recovery = await resumeInterruptedWorker(gh, controlRepo, item.repository, item.issue, item.classification, { warn });
    recoveries.push(recovery);
  }

  const dispatched = [];

  for (const candidate of plan.candidates) {
    const target = candidate.repository;
    const issue = candidate.issue;
    try {
      const wasDispatched = await dispatchWorker(gh, controlRepo, target, issue.number);
      if (wasDispatched) dispatched.push({
        repo: repoName(target),
        issue: issue.number,
        wave: candidate.wave,
        streams: candidate.streams
      });
    } catch (error) {
      if (warnReadOnlyRepository(target, error, "worker dispatch")) continue;
      warn(`Failed to dispatch worker for ${repoName(target)}#${issue.number}: ${error.message || String(error)}`);
    }
  }

  const ledger = {
    trigger,
    control_repo: repoName(controlRepo),
    wave_order: policy.waves.map((wave) => wave.name),
    concurrency: policy.concurrency,
    repositories: plan.repositories,
    dispatched,
    recovery: recoveries,
    auto_readied: autoReadied,
    escalated,
    token_usage: {
      codex_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      note: "Orchestrator dispatch is deterministic and uses no model calls"
    }
  };

  if (shouldWriteLedger) {
    await writeLedger(gh, controlRepo, ledger, warn, log);
  }
  if (shouldUpdateDashboard && policy.dashboard.enabled) {
    await updateDashboardIssue(gh, controlRepo, policy, plan, dispatched, escalated, recoveries, trigger, warn, log);
  }
  log(`DarkFactory orchestrator dispatched ${dispatched.length} worker runs, recovered ${recoveries.length} interrupted runs, and escalated ${escalated.length} owner decisions.`);
  return { dispatched, recoveries, autoReadied, escalated, ledger };
}

export async function targetRepositories(gh, controlRepo, options = {}) {
  return await listActiveManagedRepos(gh, controlRepo, options);
}

export function parseEventRequest(payloadText, trigger = "unknown", warn = console.warn) {
  if (!payloadText || (trigger !== "issue_comment" && trigger !== "issues")) return null;

  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (error) {
    warn(`DarkFactory event payload warning: ${error.message || String(error)}`);
    return null;
  }

  const repository = payload.repository?.full_name ? parseRepo(payload.repository.full_name) : null;
  const issueNumber = Number(payload.issue?.number);
  if (!repository || !Number.isInteger(issueNumber) || issueNumber <= 0 || payload.issue?.pull_request) return null;

  if (trigger === "issue_comment") {
    const commentBody = String(payload.comment?.body || "");
    const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
    if (!/^\/df\s+run\b/im.test(commentBody) || !trustedAssociations.has(payload.comment?.author_association)) {
      return null;
    }
    return {
      repository,
      issueNumber,
      slashRun: true
    };
  }

  if (payload.label?.name !== "df:ready") return null;
  return {
    repository,
    issueNumber,
    slashRun: false,
    readyLabel: true
  };
}

export function parseWorkflowDispatchRequest(repoInput, issueNumberInput, sourceEventInput = "", warn = console.warn) {
  const repoText = String(repoInput || "").trim();
  const issueNumber = Number(String(issueNumberInput || "").trim());
  if (!repoText && !issueNumberInput) return null;
  if (!repoText || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    warn("DarkFactory workflow_dispatch scope ignored because repo or issue_number input is invalid.");
    return null;
  }

  const sourceEvent = String(sourceEventInput || "").trim();
  let repository;
  try {
    repository = parseRepo(repoText);
  } catch (error) {
    warn(`DarkFactory workflow_dispatch scope ignored: ${error.message || String(error)}`);
    return null;
  }

  return {
    repository,
    issueNumber,
    slashRun: sourceEvent === "issue_comment",
    readyLabel: sourceEvent === "issues"
  };
}

function normalizeDispatchRequest(request, warn = console.warn) {
  if (!request) return null;
  const repoText = request.repository ? repoName(request.repository) : request.repo;
  const issueNumber = request.issueNumber ?? request.issue_number;
  return parseWorkflowDispatchRequest(
    repoText,
    issueNumber,
    request.sourceEvent ?? request.source_event ?? "",
    warn
  );
}

export function isWorkerStartedComment(body) {
  return /DarkFactory worker started for/i.test(String(body || ""));
}

export function isWorkerTerminalComment(body) {
  const text = String(body || "");
  return /DarkFactory worker (opened|blocked|skipped|updated)/i.test(text)
    || /DarkFactory resumed this worker/i.test(text)
    || /DarkFactory detected an interrupted worker run/i.test(text);
}

function isWorkerComment(body) {
  return /DarkFactory worker (started|opened|blocked|skipped|updated)|DarkFactory resumed this worker|DarkFactory detected an interrupted worker run/i.test(String(body || ""));
}

export function isInterruptedWorkerRun(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return false;

  const workerComments = comments
    .filter((comment) => isWorkerComment(comment.body))
    .sort((a, b) => Date.parse(b.created_at || b.createdAt || "") - Date.parse(a.created_at || a.createdAt || ""));

  if (workerComments.length === 0) return false;

  const latest = workerComments[0];
  return isWorkerStartedComment(latest.body) && !isWorkerTerminalComment(latest.body);
}

export async function detectInterruptedWorkerRuns(gh, snapshots, options = {}) {
  const warn = options.warn ?? console.warn;
  const interrupted = [];

  for (const snapshot of snapshots) {
    const repository = snapshot.repository;
    for (const issue of (snapshot.openIssues || [])) {
      if (!issueLabelNames(issue).has("df:running")) continue;

      try {
        const comments = await listIssueComments(gh, repository, issue.number);
        if (!isInterruptedWorkerRun(comments)) continue;

        const classification = await classifyResumeTarget(gh, repository, issue);
        interrupted.push({ repository, issue, classification });
      } catch (error) {
        if (warnReadOnlyRepository(repository, error, "resume detection", warn)) continue;
        warn(`Failed to inspect resume state for ${repoName(repository)}#${issue.number}: ${error.message || String(error)}`);
      }
    }
  }

  return interrupted;
}

export async function classifyResumeTarget(gh, repository, issue) {
  const existingPullRequest = await findOpenWorkerPullRequestForIssue(gh, repository, issue.number);
  if (existingPullRequest) {
    return {
      type: "pr",
      pr: existingPullRequest,
      baseRef: existingPullRequest.baseRefName || "",
      branch: existingPullRequest.headRefName || ""
    };
  }

  const branch = await findPushedWorkerBranch(gh, repository, issue.number);
  if (branch) {
    const repo = await getRepository(gh, repository);
    const baseRef = await resolveWorkBaseBranch(gh, repository, repo.default_branch);
    return { type: "branch", branch, baseRef };
  }

  return { type: "none" };
}

async function findPushedWorkerBranch(gh, repository, issueNumber) {
  const prefix = `df/${issueNumber}-`;
  const refs = await gh.request(
    "GET",
    `/repos/${repoName(repository)}/git/matching-refs/heads/${encodeURIComponent(prefix)}`
  );
  if (!Array.isArray(refs)) return null;
  const match = refs.find((ref) => typeof ref.ref === "string" && ref.ref.startsWith(`refs/heads/${prefix}`));
  return match ? match.ref.slice("refs/heads/".length) : null;
}

export async function resumeInterruptedWorker(gh, controlRepo, repository, issue, classification, options = {}) {
  const warn = options.warn ?? console.warn;
  const target = `${repoName(repository)}#${issue.number}`;
  const recovery = {
    repo: repoName(repository),
    issue: issue.number,
    type: classification.type,
    action: "none",
    reason: ""
  };

  try {
    if (classification.type === "pr") {
      await dispatchWorkerResume(gh, controlRepo, repository, issue.number, {
        base_ref: classification.baseRef,
        resume_pr: String(classification.pr.number)
      });
      await createIssueComment(gh, repository, issue.number, resumeComment(target, classification));
      recovery.action = "resume-pr";
      recovery.pr = classification.pr.number;
      recovery.branch = classification.branch;
    } else if (classification.type === "branch") {
      await dispatchWorkerResume(gh, controlRepo, repository, issue.number, {
        base_ref: classification.baseRef,
        resume_branch: classification.branch
      });
      await createIssueComment(gh, repository, issue.number, resumeComment(target, classification));
      recovery.action = "resume-branch";
      recovery.branch = classification.branch;
    } else {
      await replaceIssueLabels(gh, repository, issue.number, ["df:ready"], ["df:running", "df:blocked", "df:done"]);
      await createIssueComment(gh, repository, issue.number, requeueComment(target, issue.number));
      recovery.action = "requeue";
      recovery.reason = "no-usable-branch";
    }
  } catch (error) {
    if (warnReadOnlyRepository(repository, error, "resume dispatch", warn)) {
      recovery.action = "error";
      recovery.error = "read-only repository";
      return recovery;
    }
    warn(`Failed to resume ${target}: ${error.message || String(error)}`);
    recovery.action = "error";
    recovery.error = error.message || String(error);
  }

  return recovery;
}

function resumeComment(target, classification) {
  const lines = [
    `<!-- ${RESUME_MARKER} issue=${classification.pr?.number || classification.issue?.number || ""} type=${classification.type} -->`,
    `DarkFactory resumed this worker for \`${target}\`.`,
    "",
    "Reason: the previous worker run ended without a terminal success/failure comment and was reconstructed from GitHub state.",
    ""
  ];

  if (classification.type === "pr") {
    lines.push(`Resuming against existing PR: ${classification.pr.url || `#${classification.pr.number}`}`);
    lines.push(`Branch: \`${classification.branch}\``);
    lines.push(`Base: \`${classification.baseRef}\``);
  } else if (classification.type === "branch") {
    lines.push(`Resuming from pushed branch: \`${classification.branch}\``);
    lines.push(`Base: \`${classification.baseRef}\``);
  }

  lines.push("");
  lines.push("The resumed worker will focus on the smallest merge-first task, such as resolving current review findings or getting the existing PR green.");

  return lines.join("\n");
}

function requeueComment(target, issueNumber) {
  return [
    `<!-- ${RESUME_MARKER} issue=${issueNumber} type=none -->`,
    `DarkFactory detected an interrupted worker run for \`${target}\` but found no usable branch or PR to resume from.`,
    "",
    "The issue has been requeued with `df:ready` so a fresh worker run can start on the next orchestrator tick."
  ].join("\n");
}

async function readySlashRunIssue(gh, repository, issueNumber) {
  assertAllowedRepo(repository);
  await ensureLabels(gh, repository, WORK_LABELS);
  await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/labels`, { labels: ["df:ready"] });
  await gh.request("POST", `/repos/${repoName(repository)}/issues/${issueNumber}/comments`, {
    body: "DarkFactory received `/df run` and queued this issue with `df:ready`."
  });
}

export async function listReadyIssues(gh, repository) {
  return selectDispatchableIssues(await listOpenIssues(gh, repository));
}

export async function listOpenIssues(gh, repository) {
  const issues = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues?state=open&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) break;
  }

  return issues;
}

export function selectDispatchableIssues(openIssues, options = {}) {
  const openIssueNumbers = new Set(openIssues.map((issue) => issue.number).filter(Number.isInteger));
  const currentRepoName = options.repository ? normalizedRepoName(options.repository) : null;

  return openIssues
    .filter((issue) => {
      const names = issueLabelNames(issue);
      if (!names.has("df:ready")) return false;
      if (names.has("df:running") || names.has("df:blocked") || names.has("df:done") || names.has("df:ask-owner")) return false;
      return blockedByRefsResolved(issue, {
        repository: options.repository,
        currentRepoOpenIssueNumbers: openIssueNumbers,
        openIssueIndex: options.openIssueIndex,
        knownRepositories: options.knownRepositories,
        currentRepoName
      });
    })
    .sort(compareReadyIssues);
}

export async function autoReadySequencedIssues(gh, snapshots, warn = console.warn, options = {}) {
  // Blocker resolution must always see the FULL open-issue state: a targeted
  // (event-scoped) run may only consider one candidate issue, but its
  // Blocked-by predecessors live in the unfiltered snapshots.
  const openIssueIndex = buildOpenIssueIndex(snapshots);
  const knownRepositories = buildKnownRepositories(snapshots);
  const targetIssue = options.targetIssue || null;
  const autoReadied = [];

  for (const snapshot of snapshots) {
    const repository = snapshot.repository;
    const openIssues = Array.isArray(snapshot.openIssues) ? snapshot.openIssues : [];
    const currentRepoName = normalizedRepoName(repository);
    const currentRepoOpenIssueNumbers = new Set(openIssues.map((issue) => issue.number).filter(Number.isInteger));
    const candidates = targetIssue
      ? openIssues.filter((issue) =>
        issue.number === targetIssue.issueNumber
          && normalizedRepoName(targetIssue.repository) === currentRepoName)
      : openIssues;

    for (const issue of candidates) {
      if (!shouldAutoReadySequencedIssue(issue, {
        repository,
        currentRepoOpenIssueNumbers,
        openIssueIndex,
        knownRepositories,
        currentRepoName
      })) continue;

      try {
        const escalation = repeatedFailureEscalation(await listIssueFailureHistory(gh, repository, issue.number));
        if (escalation) continue;
      } catch (error) {
        if (warnReadOnlyRepository(repository, error, "failure-history scan", warn)) continue;
        warn(`Failed to inspect failure history before auto-ready for ${repoName(repository)}#${issue.number}: ${error.message || String(error)}`);
        continue;
      }

      try {
        await replaceIssueLabels(gh, repository, issue.number, ["df:ready"], []);
        setIssueLabelNames(issue, [...issueLabelNames(issue), "df:ready"]);
        autoReadied.push({ repo: repoName(repository), issue: issue.number });
      } catch (error) {
        if (warnReadOnlyRepository(repository, error, "auto-ready sequencing", warn)) continue;
        warn(`Failed to auto-ready sequenced issue ${repoName(repository)}#${issue.number}: ${error.message || String(error)}`);
      }
    }
  }

  return autoReadied;
}

export function shouldAutoReadySequencedIssue(issue, options = {}) {
  const names = issueLabelNames(issue);
  if (names.has("df:ready") || names.has("df:running") || names.has("df:blocked") || names.has("df:done") || names.has("df:ask-owner")) {
    return false;
  }
  // Spec (#168): this pass is for Blocked-by successors ONLY — an issue with
  // no Blocked-by references is never auto-readied here (planned/PRD backlog
  // without dependencies is queued by planning, not by the orchestrator).
  if (blockedByIssueRefs(issue.body || "", options.repository).length === 0) return false;
  if (!hasPlanningSignal(issue)) return false;
  return blockedByRefsResolved(issue, options);
}

function hasPlanningSignal(issue) {
  const names = issueLabelNames(issue);
  return names.has("df:planned")
    || /\bdf-prd:/i.test(String(issue.body || ""))
    || blockedByIssueRefs(issue.body || "").length > 0;
}

function blockedByRefsResolved(issue, options = {}) {
  const refs = blockedByIssueRefs(issue.body || "", options.repository);
  const currentRepoName = options.currentRepoName
    ?? (options.repository ? normalizedRepoName(options.repository) : null);
  const currentRepoOpenIssueNumbers = options.currentRepoOpenIssueNumbers
    ?? new Set();

  return refs.every((ref) => {
    if (!Number.isInteger(ref.number)) return false;
    if (ref.repository && ref.repository !== currentRepoName) {
      // Cross-repo references only resolve as unblocked when the referenced
      // repository is part of the managed snapshot set and the issue is
      // positively observed as absent/closed there. Unknown repositories
      // hold the issue so work is never dispatched past an unverified blocker.
      if (!options.openIssueIndex || !options.knownRepositories?.has(ref.repository)) return false;
      return !options.openIssueIndex.has(openIssueKey(ref.repository, ref.number));
    }
    return !currentRepoOpenIssueNumbers.has(ref.number);
  });
}

export async function readOrchestrationPolicy(root = CONTROL_ROOT) {
  const policy = await readRequiredJson(path.join(root, ORCHESTRATION_POLICY_PATH));
  assertOrchestrationPolicy(policy);
  return policy;
}

function assertOrchestrationPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.schemaVersion !== 1) {
    throw new Error("orchestration policy must be an object using schemaVersion 1");
  }
  if (!policy.concurrency || typeof policy.concurrency !== "object" || Array.isArray(policy.concurrency)) {
    throw new Error("orchestration policy must define concurrency");
  }
  for (const key of ["global", "perRepository", "perStream"]) {
    if (!Number.isInteger(policy.concurrency[key]) || policy.concurrency[key] < 1) {
      throw new Error(`orchestration concurrency.${key} must be a positive integer`);
    }
  }
  if (!Array.isArray(policy.waves) || policy.waves.length === 0) {
    throw new Error("orchestration policy must define at least one wave");
  }
  for (const wave of policy.waves) {
    if (!wave || typeof wave !== "object" || typeof wave.name !== "string" || !wave.name.trim()) {
      throw new Error("each orchestration wave must define a non-empty name");
    }
    if (!Array.isArray(wave.streams) || wave.streams.length === 0 || !wave.streams.every((stream) => typeof stream === "string" && stream.trim())) {
      throw new Error(`orchestration wave '${wave.name}' must define non-empty streams`);
    }
  }
  if (!policy.dashboard || typeof policy.dashboard !== "object" || Array.isArray(policy.dashboard)) {
    throw new Error("orchestration policy must define dashboard settings");
  }
  if (typeof policy.dashboard.enabled !== "boolean" || typeof policy.dashboard.issueTitle !== "string" || !policy.dashboard.issueTitle.trim()) {
    throw new Error("orchestration dashboard settings are invalid");
  }
}

export function normalizeOrchestrationPolicy(policy) {
  assertOrchestrationPolicy(policy);
  const normalizedWaves = policy.waves
    .map((wave) => ({
      name: wave.name.trim().toLowerCase(),
      streams: wave.streams.map((stream) => stream.trim().toLowerCase())
    }))
    .filter((wave) => wave.name);

  return {
    schemaVersion: policy.schemaVersion,
    concurrency: {
      global: policy.concurrency.global,
      perRepository: policy.concurrency.perRepository,
      perStream: policy.concurrency.perStream
    },
    waves: normalizedWaves,
    dashboard: {
      enabled: policy.dashboard.enabled,
      issueTitle: policy.dashboard.issueTitle.trim()
    }
  };
}

export function buildOrchestrationPlan(snapshots, policyInput, options = {}) {
  const policy = normalizeOrchestrationPolicy(policyInput);
  const counts = activeConcurrencyCounts(snapshots);
  const gateWave = globalGateWave(snapshots, policy);
  const targetIssue = options.targetIssue || null;
  const openIssueIndex = buildOpenIssueIndex(snapshots);
  const knownRepositories = buildKnownRepositories(snapshots);
  const candidates = [];
  const repositories = [];

  for (const snapshot of snapshots) {
    const repository = snapshot.repository;
    const openIssues = Array.isArray(snapshot.openIssues) ? snapshot.openIssues : [];
    const repositoryName = repoName(repository);
    const repositoryWave = repositoryGateWave(openIssues, policy);
    const selected = selectDispatchableIssues(openIssues, { repository, openIssueIndex, knownRepositories })
      .map((issue) => ({
        repository,
        issue,
        wave: issueWave(issue, policy),
        waveRank: waveRank(issueWave(issue, policy), policy),
        streams: issueStreamKeys(issue),
        priority: priorityRank(issue)
      }))
      .filter((candidate) => !targetIssue || (
        repoName(candidate.repository) === repoName(targetIssue.repository)
        && candidate.issue.number === targetIssue.issueNumber
      ))
      .filter((candidate) => !gateWave || candidate.wave === gateWave);

    candidates.push(...selected);
    repositories.push({
      repo: repositoryName,
      gate_wave: gateWave || "none",
      repository_gate_wave: repositoryWave || "none",
      open_work: openIssues.filter(isWorkIssue).length,
      ready: openIssues.filter((issue) => issueLabelNames(issue).has("df:ready")).length,
      running: openIssues.filter((issue) => issueLabelNames(issue).has("df:running")).length,
      done: openIssues.filter((issue) => issueLabelNames(issue).has("df:done")).length,
      blocked: openIssues.filter((issue) => issueLabelNames(issue).has("df:blocked")).length,
      ask_owner: openIssues.filter((issue) => issueLabelNames(issue).has("df:ask-owner")).length,
      dispatchable: selected.length
    });
  }

  const planned = [];
  for (const candidate of candidates.sort(comparePlanCandidates)) {
    const repositoryKey = repoName(candidate.repository);
    if (counts.global >= policy.concurrency.global) break;
    if ((counts.byRepository.get(repositoryKey) || 0) >= policy.concurrency.perRepository) continue;
    if (candidate.streams.some((stream) => (counts.byStream.get(stream) || 0) >= policy.concurrency.perStream)) continue;

    planned.push(candidate);
    counts.global += 1;
    counts.byRepository.set(repositoryKey, (counts.byRepository.get(repositoryKey) || 0) + 1);
    for (const stream of candidate.streams) counts.byStream.set(stream, (counts.byStream.get(stream) || 0) + 1);
  }

  return {
    policy,
    gate_wave: gateWave || "none",
    candidates: planned,
    repositories,
    active: {
      global: counts.initialGlobal,
      byRepository: Object.fromEntries([...counts.initialByRepository.entries()].sort()),
      byStream: Object.fromEntries([...counts.initialByStream.entries()].sort())
    }
  };
}

export function globalGateWave(snapshots, policyInput) {
  const policy = normalizeOrchestrationPolicy(policyInput);
  let gate = null;
  for (const snapshot of snapshots) {
    const wave = repositoryGateWave(Array.isArray(snapshot.openIssues) ? snapshot.openIssues : [], policy);
    if (wave && (!gate || waveRank(wave, policy) < waveRank(gate, policy))) gate = wave;
  }
  return gate;
}

export function repositoryGateWave(openIssues, policyInput) {
  const policy = normalizeOrchestrationPolicy(policyInput);
  let gate = null;
  for (const issue of openIssues.filter(isWaveGateIssue)) {
    const wave = issueWave(issue, policy);
    if (!gate || waveRank(wave, policy) < waveRank(gate, policy)) gate = wave;
  }
  return gate;
}

export function issueWave(issue, policyInput) {
  const policy = normalizeOrchestrationPolicy(policyInput);
  const names = issueLabelNames(issue);
  const waveLabel = [...names].find((label) => /^wave:[^:\s]+$/i.test(label));
  if (waveLabel) return waveLabel.slice("wave:".length).toLowerCase();

  const streamsByWave = new Map();
  for (const wave of policy.waves) {
    for (const stream of wave.streams) streamsByWave.set(stream, wave.name);
  }
  for (const stream of issueStreamKeys(issue)) {
    const wave = streamsByWave.get(stream);
    if (wave) return wave;
  }

  const text = `${issue.title || ""}\n${issue.body || ""}`.toLowerCase();
  if (/\b(hygiene|bootstrap|setup|managed setup|sync|audit|documentation|docs)\b/.test(text)) return "hygiene";
  if (/\b(enforcement|review gate|codex review|branch protection|ci|release)\b/.test(text)) return "enforcement";
  return "features";
}

async function escalateOwnerDecisionIssues(gh, snapshots, warn = console.warn) {
  const escalated = [];
  const knownRepositories = buildKnownRepositories(snapshots);

  for (const snapshot of snapshots) {
    const repository = snapshot.repository;
    for (const issue of snapshot.openIssues || []) {
      let escalation = ownerDecisionEscalation(issue, knownRepositories);
      if (!escalation) {
        try {
          escalation = repeatedFailureEscalation(await listIssueFailureHistory(gh, repository, issue.number));
        } catch (error) {
          if (warnReadOnlyRepository(repository, error, "failure-history scan", warn)) continue;
          warn(`Failed to inspect failure history for ${repoName(repository)}#${issue.number}: ${error.message || String(error)}`);
        }
      }
      if (!escalation) continue;

      try {
        await ensureLabels(gh, repository, WORK_LABELS);
        await replaceIssueLabels(
          gh,
          repository,
          issue.number,
          ["df:ask-owner", "df:blocked"],
          ["df:ready", "df:running", "df:done"]
        );
        await createIssueComment(
          gh,
          repository,
          issue.number,
          askOwnerComment(repository, issue, escalation)
        );
        setIssueLabelNames(issue, [
          ...issueLabelNames(issue),
          "df:ask-owner",
          "df:blocked"
        ].filter((label) => !["df:ready", "df:running", "df:done"].includes(label)));
        escalated.push({
          repo: repoName(repository),
          issue: issue.number,
          reason: escalation.reason,
          detail: escalation.detail
        });
      } catch (error) {
        if (warnReadOnlyRepository(repository, error, "owner escalation", warn)) continue;
        warn(`Failed to escalate owner decision for ${repoName(repository)}#${issue.number}: ${error.message || String(error)}`);
      }
    }
  }

  return escalated;
}

export function ownerDecisionEscalation(issue, knownRepositories = new Set()) {
  const names = issueLabelNames(issue);
  if (names.has("df:ask-owner") || names.has("df:done") || names.has("df:running")) return null;
  if (!names.has("df:ready") && !names.has("df:blocked")) return null;

  const priorityLabels = ["P0", "P1", "P2"].filter((label) => names.has(label));
  if (priorityLabels.length > 1) {
    return {
      reason: "conflicting-priority-labels",
      detail: `Issue has multiple priority labels: ${priorityLabels.join(", ")}.`
    };
  }

  const waveLabels = [...names].filter((label) => /^wave:[^:\s]+$/i.test(label)).sort();
  if (waveLabels.length > 1) {
    return {
      reason: "conflicting-wave-labels",
      detail: `Issue has multiple wave labels: ${waveLabels.join(", ")}.`
    };
  }

  const refs = blockedByIssueRefs(issue.body || "");
  if (refs.some((ref) => !Number.isInteger(ref.number))) {
    return {
      reason: "ambiguous-blocked-by",
      detail: "Blocked-by lines must reference GitHub issues as #123 or owner/repo#123."
    };
  }

  const unknownCrossRepo = refs
    .filter((ref) => Number.isInteger(ref.number) && ref.repository && !knownRepositories.has(ref.repository))
    .map((ref) => ref.raw)
    .filter(Boolean);
  if (unknownCrossRepo.length) {
    return {
      reason: "unknown-cross-repo-blocked-by",
      detail: `Blocked-by references repositories outside the managed snapshot set: ${unknownCrossRepo.join("; ")}. The orchestrator cannot verify these blockers, so owner input is required.`
    };
  }

  return null;
}

export function repeatedFailureEscalation(history, threshold = REPEATED_FAILURE_THRESHOLD) {
  const evidence = repeatedFailureEvidenceSinceReset(history);
  if (evidence.count < threshold) return null;

  return {
    reason: "repeated-worker-failure",
    detail: [
      `Issue has ${evidence.count} worker failure evidence item(s) since the most recent owner reset.`,
      evidence.resetAt ? `Reset point: ${evidence.resetAt}.` : "No owner reset was found after the previous failure batch.",
      "Owner input is required before DarkFactory spends another worker run."
    ].join(" ")
  };
}

export function repeatedFailureEvidenceSinceReset(history = {}) {
  const events = [
    ...failureEvidenceItems(history.comments || []),
    ...failureLabelEvidenceItems(history.timeline || []),
    ...readyRelabelEvents(history.timeline || [])
  ].sort(compareHistoryItems);

  let resetAt = null;
  let seenFailureBeforeReady = false;
  for (const event of events) {
    if (event.kind === "failure") {
      seenFailureBeforeReady = true;
      continue;
    }
    if (event.kind === "ready" && seenFailureBeforeReady) {
      resetAt = event.createdAt;
    }
  }

  const count = events.filter((event) => {
    return event.kind === "failure" && (!resetAt || Date.parse(event.createdAt) > Date.parse(resetAt));
  }).length;

  return { count, resetAt };
}

function failureEvidenceItems(items) {
  return items
    .filter((item) => historyTimestamp(item) && isRepeatedFailureEvidence(item))
    .map((item) => ({ kind: "failure", createdAt: historyTimestamp(item) }));
}

function failureLabelEvidenceItems(items) {
  return items
    .filter((item) => historyTimestamp(item) && item?.event === "labeled" && /^df:fix-round:\d+$/i.test(labelName(item)))
    .map((item) => ({ kind: "failure", createdAt: historyTimestamp(item) }));
}

function readyRelabelEvents(items) {
  return items
    .filter((item) => historyTimestamp(item) && item?.event === "labeled" && labelName(item) === "df:ready")
    .map((item) => ({ kind: "ready", createdAt: historyTimestamp(item) }));
}

function isRepeatedFailureEvidence(item) {
  const body = String(item?.body || "");
  return (
    /\bdf:fix-round:\d+\b/i.test(body)
    || /DarkFactory worker blocked\./i.test(body)
    || /DarkFactory follow-through blocked this worker PR\./i.test(body)
    || /dark-factory:sweep-blocked/i.test(body)
  );
}

function labelName(item) {
  return String(item?.label?.name || item?.label || "").toLowerCase();
}

function historyTimestamp(item) {
  const timestamp = item?.created_at || item?.createdAt;
  return Number.isFinite(Date.parse(timestamp || "")) ? new Date(timestamp).toISOString() : "";
}

function compareHistoryItems(a, b) {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.kind === "failure" ? -1 : 1);
}

async function listIssueFailureHistory(gh, repository, issueNumber) {
  const [comments, timeline] = await Promise.all([
    listIssueComments(gh, repository, issueNumber),
    listIssueTimeline(gh, repository, issueNumber)
  ]);
  return { comments, timeline };
}

async function listIssueComments(gh, repository, issueNumber) {
  const comments = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues/${issueNumber}/comments?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

async function listIssueTimeline(gh, repository, issueNumber) {
  const events = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await gh.request(
      "GET",
      `/repos/${repoName(repository)}/issues/${issueNumber}/timeline?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    events.push(...batch);
    if (batch.length < 100) break;
  }
  return events;
}

function askOwnerComment(repository, issue, escalation) {
  return [
    `<!-- ${ASK_OWNER_MARKER} issue=${issue.number} reason=${escalation.reason} -->`,
    "DarkFactory orchestrator needs owner input before this issue can continue.",
    "",
    `Issue: \`${repoName(repository)}#${issue.number}\``,
    `Reason: \`${escalation.reason}\``,
    "",
    "Detail:",
    "",
    escalation.detail,
    "",
    "The orchestrator applied `df:ask-owner` and `df:blocked`, and removed runnable worker-state labels so no terminal session is needed to hold this decision."
  ].join("\n");
}

async function updateDashboardIssue(gh, controlRepo, policy, plan, dispatched, escalated, recoveries, trigger, warn = console.warn, log = console.log) {
  try {
    await ensureLabels(gh, controlRepo, PLANNING_LABELS);
    const title = policy.dashboard.issueTitle;
    const body = dashboardIssueBody(policy, plan, dispatched, escalated, recoveries, trigger);
    const existing = await findDashboardIssue(gh, controlRepo);
    if (existing) {
      await gh.request("PATCH", `/repos/${repoName(controlRepo)}/issues/${existing.number}`, { title, body });
      log(`DarkFactory dashboard updated at ${repoName(controlRepo)}#${existing.number}`);
      return { action: "update", issue: existing.number };
    }

    const created = await gh.request("POST", `/repos/${repoName(controlRepo)}/issues`, {
      title,
      body,
      labels: ["roadmap"]
    });
    log(`DarkFactory dashboard created at ${repoName(controlRepo)}#${created.number}`);
    return { action: "create", issue: created.number };
  } catch (error) {
    warn(`DarkFactory dashboard warning: ${error.message || String(error)}`);
    return { action: "warning", warning: error.message || String(error) };
  }
}

async function findDashboardIssue(gh, controlRepo) {
  for (let page = 1; page <= 10; page += 1) {
    const issues = await gh.request(
      "GET",
      `/repos/${repoName(controlRepo)}/issues?state=open&per_page=100&page=${page}`
    );
    if (!Array.isArray(issues) || issues.length === 0) break;
    const found = issues.find((issue) => !issue.pull_request && String(issue.body || "").includes(DASHBOARD_MARKER));
    if (found) return found;
    if (issues.length < 100) break;
  }
  return null;
}

function dashboardIssueBody(policy, plan, dispatched, escalated, recoveries, trigger) {
  const updatedAt = new Date().toISOString();
  const rows = plan.repositories.length
    ? plan.repositories.map((state) => {
      const dispatchedCount = dispatched.filter((item) => item.repo === state.repo).length;
      return `| \`${state.repo}\` | ${state.gate_wave} | ${state.open_work} | ${state.ready} | ${state.running} | ${state.done} | ${state.blocked} | ${state.ask_owner} | ${state.dispatchable} | ${dispatchedCount} |`;
    }).join("\n")
    : "| _none_ | none | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |";
  const dispatchRows = dispatched.length
    ? dispatched.map((item) => `- \`${item.repo}#${item.issue}\` (${item.wave}; ${item.streams.join(", ")})`).join("\n")
    : "- No worker dispatches in this tick.";
  const escalationRows = escalated.length
    ? escalated.map((item) => `- \`${item.repo}#${item.issue}\` (${item.reason})`).join("\n")
    : "- No owner escalations in this tick.";
  const recoveryRows = recoveries.length
    ? recoveries.map((item) => `- \`${item.repo}#${item.issue}\` (${item.action}${item.reason ? `; ${item.reason}` : ""})`).join("\n")
    : "- No worker recoveries in this tick.";

  return [
    `<!-- ${DASHBOARD_MARKER} -->`,
    "# DarkFactory L6 Orchestration Dashboard",
    "",
    `Updated: \`${updatedAt}\``,
    `Trigger: \`${trigger}\``,
    "",
    "## Wave Gates",
    "",
    `Order: ${policy.waves.map((wave) => `\`${wave.name}\``).join(" -> ")}`,
    `Current global gate: \`${plan.gate_wave}\``,
    "",
    "## Concurrency",
    "",
    `- Global active workers: \`${plan.active.global}/${policy.concurrency.global}\``,
    `- Per-repository cap: \`${policy.concurrency.perRepository}\``,
    `- Per-stream cap: \`${policy.concurrency.perStream}\``,
    "",
    "## Repositories",
    "",
    "| Repository | Gate | Open work | Ready | Running | Done | Blocked | Ask owner | Dispatchable | Dispatched |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    rows,
    "",
    "## Dispatches",
    "",
    dispatchRows,
    "",
    "## Worker Recoveries",
    "",
    recoveryRows,
    "",
    "## Owner Escalations",
    "",
    escalationRows,
    "",
    "## Notes",
    "",
    "- `Running` = worker claimed success but verification against GitHub reality is pending.",
    "- `Done` = worker claim was verified against GitHub reality and follow-through may merge.",
    "- Cross-repo waves, stream lanes, and concurrency caps are deterministic; AI tokens: 0.",
    "- Execution boundary: this is deterministic GitHub control-plane state; local worker turns run only through Agent OS."
  ].join("\n");
}

export function compareReadyIssues(a, b) {
  return priorityRank(a) - priorityRank(b) || a.number - b.number;
}

export function priorityRank(issue) {
  const names = issueLabelNames(issue);
  if (names.has("P0")) return 0;
  if (names.has("P1")) return 1;
  if (names.has("P2")) return 2;
  return 3;
}

export function issueStreamLanes(issue) {
  const streamLabels = [...issueLabelNames(issue)]
    .filter((label) => /^stream:[^:\s]+$/i.test(label))
    .sort((a, b) => a.localeCompare(b));
  return streamLabels.length ? streamLabels : ["stream:default"];
}

function issueStreamKeys(issue) {
  return issueStreamLanes(issue).map((lane) => lane.slice("stream:".length).toLowerCase());
}

export function blockedByIssueNumbers(body) {
  return blockedByIssueRefs(body).map((ref) => ref.number);
}

export function blockedByIssueRefs(body, currentRepository = null) {
  const refs = [];
  for (const line of String(body || "").split(/\r?\n/)) {
    const match = line.match(/^\s*Blocked-by:\s*(.+)$/i);
    if (!match) continue;

    const found = [...match[1].matchAll(/(?:(?<owner>[\w.-]+)\/(?<repo>[\w.-]+))?#(?<number>\d+)/g)];
    if (found.length === 0) {
      refs.push({ repository: null, number: Number.NaN, raw: match[1].trim() });
      continue;
    }

    // A Blocked-by payload must contain nothing but issue references and
    // separators. Leftover text (e.g. "Blocked-by: #12 or ask owner") makes
    // the line ambiguous, so a malformed marker is emitted alongside the
    // parsed refs and the issue escalates instead of dispatching on a
    // partially-parsed dependency line.
    const residue = match[1]
      .replace(/(?:[\w.-]+\/[\w.-]+)?#\d+/g, "")
      .replace(/[,\s]+/g, "");
    if (residue) {
      refs.push({ repository: null, number: Number.NaN, raw: match[1].trim() });
    }

    refs.push(...found.map((entry) => ({
      repository: entry.groups?.owner
        ? `${entry.groups.owner.toLowerCase()}/${entry.groups.repo.toLowerCase()}`
        : currentRepository
          ? normalizedRepoName(currentRepository)
          : null,
      number: Number(entry.groups?.number),
      raw: entry[0]
    })));
  }
  return refs;
}

function buildOpenIssueIndex(snapshots) {
  const index = new Set();
  for (const snapshot of snapshots) {
    for (const issue of snapshot.openIssues || []) {
      if (Number.isInteger(issue.number)) {
        index.add(openIssueKey(repoName(snapshot.repository), issue.number));
      }
    }
  }
  return index;
}

function buildKnownRepositories(snapshots) {
  const repositories = new Set();
  for (const snapshot of snapshots) {
    repositories.add(normalizedRepoName(snapshot.repository));
  }
  return repositories;
}

function openIssueKey(repositoryName, issueNumber) {
  return `${String(repositoryName).toLowerCase()}#${issueNumber}`;
}

function issueLabelNames(issue) {
  return new Set(
    (issue.labels || []).map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean)
  );
}

function setIssueLabelNames(issue, labels) {
  issue.labels = [...new Set(labels)].sort((a, b) => a.localeCompare(b)).map((name) => ({ name }));
}

function isWorkIssue(issue) {
  const names = issueLabelNames(issue);
  return [...names].some((label) => label.startsWith("df:") || label === "roadmap");
}

function isWaveGateIssue(issue) {
  const names = issueLabelNames(issue);
  if (names.has("df:done") || names.has("df:ask-owner") || names.has("df:blocked")) return false;
  return isWorkIssue(issue);
}

function activeConcurrencyCounts(snapshots) {
  const byRepository = new Map();
  const byStream = new Map();
  let global = 0;

  for (const snapshot of snapshots) {
    const repositoryKey = repoName(snapshot.repository);
    for (const issue of (snapshot.openIssues || [])) {
      if (!issueLabelNames(issue).has("df:running")) continue;
      global += 1;
      byRepository.set(repositoryKey, (byRepository.get(repositoryKey) || 0) + 1);
      for (const stream of issueStreamKeys(issue)) {
        byStream.set(stream, (byStream.get(stream) || 0) + 1);
      }
    }
  }

  return {
    global,
    byRepository,
    byStream,
    initialGlobal: global,
    initialByRepository: new Map(byRepository),
    initialByStream: new Map(byStream)
  };
}

function comparePlanCandidates(a, b) {
  return a.waveRank - b.waveRank
    || a.priority - b.priority
    || repoName(a.repository).localeCompare(repoName(b.repository))
    || a.issue.number - b.issue.number;
}

function waveRank(name, policy) {
  const index = policy.waves.findIndex((wave) => wave.name === name);
  return index === -1 ? policy.waves.length : index;
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

async function dispatchWorkerResume(gh, controlRepo, repository, issueNumber, inputs) {
  await gh.request("POST", `/repos/${repoName(controlRepo)}/actions/workflows/df-work.yml/dispatches`, {
    ref: "main",
    inputs: {
      repo: repoName(repository),
      issue_number: String(issueNumber),
      base_ref: inputs.base_ref || "",
      resume_pr: inputs.resume_pr || "",
      resume_branch: inputs.resume_branch || ""
    }
  });
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
  // Merge-policy blockers are owner decisions (repository setup), not code
  // failures: apply df:ask-owner alongside df:blocked so the lane stays
  // visible on the owner-decision queue and dashboards instead of stalling
  // silently.
  await replaceIssueLabels(gh, repository, issueNumber, ["df:ask-owner", "df:blocked"], ["df:ready", "df:running", "df:done"]);
  await createIssueComment(
    gh,
    repository,
    issueNumber,
    [
      `<!-- ${ASK_OWNER_MARKER} issue=${issueNumber} reason=merge-policy-blocked -->`,
      "DarkFactory blocked this issue before worker dispatch and escalated it for owner input.",
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
      "This is target repository setup work, not a code implementation failure.",
      "Resolve the repository merge policy, then remove `df:ask-owner`/`df:blocked` and reapply `df:ready`."
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

async function writeLedger(gh, controlRepo, ledger, warn = console.warn, log = console.log) {
  try {
    const written = await writeRunLedger(gh, DARK_FACTORY_DATA_REPO, "df-orchestrate", repoName(controlRepo), ledger);
    log(`DarkFactory ledger written to ${written.repository}/${written.path}`);
  } catch (error) {
    warn(`DarkFactory ledger warning: ${error.message || String(error)}`);
  }
}
