import path from "node:path";

import {
  checksAreGreen,
  checksSummary,
  isParkedRepo,
  normalizedRepoName,
  readRequiredJson,
  readManagedRepoRegistry,
  repoName
} from "./df-lib.mjs";

export const ENFORCEMENT_RULES_PATH = ".darkfactory/enforcement-rules.json";

export const BUILTIN_RULES = [
  "parked-repos-untouched",
  "work-PRs-target-dev",
  "never-merge-red",
  "no-force-push",
  "no-admin-bypass",
  "secrets-never-logged"
];

export function defaultEnforcementRules() {
  return {
    schemaVersion: 1,
    description: "DarkFactory enforcement-rule registry.",
    rules: BUILTIN_RULES.map((id) => ({
      id,
      enabled: true,
      severity: id === "secrets-never-logged" ? "warn" : "block",
      description: defaultRuleDescription(id)
    }))
  };
}

function defaultRuleDescription(id) {
  const descriptions = {
    "parked-repos-untouched": "DarkFactory must never dispatch workers or merge follow-through actions into parked repositories.",
    "work-PRs-target-dev": "Worker pull requests must target the integration branch (dev) per the repo branching model.",
    "never-merge-red": "All required status checks must report success before a worker PR may merge.",
    "no-force-push": "Worker branches must not be force-pushed after the worker PR is opened.",
    "no-admin-bypass": "DarkFactory must never use admin override to merge or push.",
    "secrets-never-logged": "Worker and follow-through logs must redact tokens and secrets."
  };
  return descriptions[id] || "";
}

export async function loadEnforcementRules(root = process.cwd()) {
  try {
    const raw = await readRequiredJson(path.join(root, ENFORCEMENT_RULES_PATH));
    assertEnforcementRulesConfig(raw);
    return normalizeEnforcementRules(raw);
  } catch (error) {
    throw new Error(`Failed to load ${ENFORCEMENT_RULES_PATH}: ${error.message || String(error)}`);
  }
}

function assertEnforcementRulesConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schemaVersion !== 1) {
    throw new Error("enforcement rules must be an object using schemaVersion 1");
  }
  if (!Array.isArray(raw.rules)) {
    throw new Error("enforcement rules must define a rules array");
  }
  for (const rule of raw.rules) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || typeof rule.id !== "string" || !rule.id.trim()) {
      throw new Error("each enforcement rule must define a non-empty id");
    }
    if (rule.severity !== undefined && rule.severity !== "block" && rule.severity !== "warn") {
      throw new Error(`enforcement rule '${rule.id}' has invalid severity`);
    }
  }
}

export function normalizeEnforcementRules(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.rules)) {
    throw new Error("enforcement rules must define a rules array");
  }

  const rules = raw.rules.filter((rule) => rule && typeof rule === "object" && typeof rule.id === "string");

  return {
    schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1,
    description: typeof raw.description === "string" ? raw.description : defaultEnforcementRules().description,
    rules: rules.map((rule) => ({
      id: rule.id,
      enabled: rule.enabled !== false,
      severity: rule.severity === "warn" ? "warn" : "block",
      description: typeof rule.description === "string" ? rule.description : defaultRuleDescription(rule.id),
      parameters: rule.parameters && typeof rule.parameters === "object" && !Array.isArray(rule.parameters)
        ? rule.parameters
        : {}
    }))
  };
}

export async function evaluateEnforcementRules(rules, context) {
  const findings = [];

  for (const rule of rules.rules ?? []) {
    if (!rule.enabled) continue;

    const evaluator = ruleRegistry[rule.id];
    if (!evaluator) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        message: `No evaluator registered for enforcement rule '${rule.id}'.`
      });
      continue;
    }

    const result = await evaluator(rule, context);
    if (result) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        message: result.message || `Enforcement rule '${rule.id}' triggered.`,
        detail: result.detail
      });
    }
  }

  const blocks = findings.filter((finding) => finding.severity === "block");
  return {
    ok: blocks.length === 0,
    findings
  };
}

const ruleRegistry = {
  "parked-repos-untouched": evaluateParkedReposUntouched,
  "work-PRs-target-dev": evaluateWorkPrsTargetDev,
  "never-merge-red": evaluateNeverMergeRed,
  "no-force-push": evaluateNoForcePush,
  "no-admin-bypass": evaluateNoAdminBypass,
  "secrets-never-logged": evaluateSecretsNeverLogged
};

export function listRegisteredEnforcementRules() {
  return Object.keys(ruleRegistry);
}

export function registerEnforcementRule(id, evaluator) {
  if (typeof id !== "string" || typeof evaluator !== "function") {
    throw new Error("Enforcement rule registration requires a string id and an evaluator function.");
  }
  ruleRegistry[id] = evaluator;
}

function evaluateParkedReposUntouched(rule, context) {
  const repository = context.repository;
  if (!repository) return null;

  if (isParkedRepo(repository)) {
    return {
      message: `Repository ${repoName(repository)} is parked; DarkFactory refuses to dispatch or merge.`,
      detail: { repository: repoName(repository) }
    };
  }

  if (context.registry) {
    const state = managedRepoLifecycleState(repository, context.registry);
    if (state === "parked") {
      return {
        message: `Repository ${repoName(repository)} is parked in managed-repos.json; DarkFactory refuses to dispatch or merge.`,
        detail: { repository: repoName(repository), state }
      };
    }
  }

  return null;
}

function evaluateWorkPrsTargetDev(rule, context) {
  const baseBranch = context.baseBranch || context.pull?.baseRefName;
  if (!baseBranch) return null;

  const expectedBranch = rule.parameters?.defaultBranch || "dev";
  if (baseBranch === expectedBranch) return null;

  return {
    message: `Worker PR targets \`${baseBranch}\`; expected integration branch is \`${expectedBranch}\`.`,
    detail: { expectedBranch, actualBranch: baseBranch }
  };
}

function evaluateNeverMergeRed(rule, context) {
  const requiredContexts = context.requiredContexts ?? [];
  const statusCheckRollup = context.statusCheckRollup ?? context.pull?.statusCheckRollup ?? [];

  if (checksAreGreen(statusCheckRollup, requiredContexts)) return null;

  return {
    message: `Required checks are not all green (${checksSummary(statusCheckRollup)}).`,
    detail: {
      requiredChecks: requiredContexts,
      checks: checksSummary(statusCheckRollup)
    }
  };
}

async function evaluateNoForcePush(rule, context) {
  if (!context.gh || !context.repository || !context.pull) return null;

  const timeline = await fetchPullRequestTimeline(context.gh, context.repository, context.pull.number);
  const forcePush = timeline.find((event) => event.event === "head_ref_force_pushed");

  if (!forcePush) return null;

  return {
    message: `Worker PR #${context.pull.number} was force-pushed after opening.`,
    detail: { event: "head_ref_force_pushed", createdAt: forcePush.created_at }
  };
}

async function evaluateNoAdminBypass(rule, context) {
  if (context.mergeAction) {
    const { mergeAction } = context;
    if (mergeAction.admin === true || mergeAction.bypass === true) {
      return {
        message: "Merge action requests admin or bypass override.",
        detail: { mergeAction }
      };
    }
  }

  if (context.gh && context.repository && context.pull) {
    try {
      const pull = await context.gh.request(
        "GET",
        `/repos/${repoName(context.repository)}/pulls/${context.pull.number}`
      );
      if (pull.merged === true && pull.merge_commit_sha && pull.merged_by?.type === "Bot") {
        return null;
      }
      if (pull.merged === true && pull.merged_by?.site_admin === true) {
        return {
          message: `Pull request #${context.pull.number} appears merged with a site-admin account; admin bypass is not allowed.`,
          detail: { mergedBy: pull.merged_by?.login }
        };
      }
    } catch {
      // Ignore timeline fetch failures; other gates will catch merge problems.
    }
  }

  return null;
}

function evaluateSecretsNeverLogged(rule, context) {
  const token = context.token;
  if (!token) return null;

  const haystacks = [];
  if (typeof context.loggedOutput === "string") haystacks.push(context.loggedOutput);
  if (typeof context.errorMessage === "string") haystacks.push(context.errorMessage);
  if (Array.isArray(context.loggedOutputs)) {
    haystacks.push(...context.loggedOutputs.filter((item) => typeof item === "string"));
  }

  if (haystacks.length === 0) return null;

  for (const haystack of haystacks) {
    if (haystack.includes(token)) {
      return {
        message: "Detected unredacted DarkFactory token in logged output.",
        detail: { location: "logged-output" }
      };
    }
  }

  return null;
}

async function fetchPullRequestTimeline(gh, repository, pullNumber) {
  if (!gh) return [];
  try {
    const events = [];
    for (let page = 1; page <= 10; page += 1) {
      const batch = await gh.request(
        "GET",
        `/repos/${repoName(repository)}/issues/${pullNumber}/timeline?per_page=100&page=${page}`
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      events.push(...batch);
      if (batch.length < 100) break;
    }
    return events;
  } catch {
    return [];
  }
}

function managedRepoLifecycleState(repository, registry) {
  const repositories = registry?.repositories && typeof registry.repositories === "object"
    ? registry.repositories
    : {};
  const entry = repositories[normalizedRepoName(repository)] ?? repositories[repoName(repository)];
  return typeof entry === "string" ? entry : entry?.state;
}
