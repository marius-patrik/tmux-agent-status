#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const mode = process.argv.includes("--mode")
  ? process.argv[process.argv.indexOf("--mode") + 1]
  : "release";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message, file) {
  if (file) console.error(`::error file=${file}::${message}`);
  else console.error(`::error::${message}`);
  process.exitCode = 1;
}

function run(command, args) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function packageManager() {
  if (existsSync("bun.lock") || existsSync("bun.lockb")) return "bun";
  if (existsSync("package-lock.json")) return "npm";
  if (existsSync("package.json")) return "npm";
  return null;
}

function installDependencies(manager) {
  if (manager === "bun") {
    run("bun", ["install", "--frozen-lockfile"]);
    return;
  }
  if (existsSync("package-lock.json")) run("npm", ["ci"]);
  else run("npm", ["install"]);
}

function findScript(packageJson, candidates) {
  const scripts = packageJson.scripts ?? {};
  return candidates.find((candidate) => typeof scripts[candidate] === "string");
}

function runPhase(manager, packageJson, phase, required, candidates) {
  const script = findScript(packageJson, candidates);
  if (!script) {
    const message = `No package script found for ${phase}; expected one of: ${candidates.join(", ")}`;
    if (required) throw new Error(message);
    console.log(message);
    return;
  }
  run(manager, ["run", script]);
}

function verifyManagedFiles() {
  const configPath = ".darkfactory/managed-repository.json";
  if (!existsSync(configPath)) {
    fail("Missing DarkFactory managed repository config.", configPath);
    return false;
  }

  const config = readJson(configPath);
  const requiredFiles = Array.isArray(config.requiredFiles) ? config.requiredFiles : [];
  for (const file of requiredFiles) {
    if (!existsSync(file)) fail("Missing DarkFactory managed file.", file);
  }

  if (!existsSync(".agents/.global/VERSION")) {
    fail("Missing managed agent version.", ".agents/.global/VERSION");
  } else {
    const version = readFileSync(".agents/.global/VERSION", "utf8").trim();
    if (!version.startsWith("agent-darkfactory@")) {
      fail(`Unexpected managed agent version '${version}'.`, ".agents/.global/VERSION");
    } else {
      console.log(`Managed agent version: ${version}`);
    }
  }

  return process.exitCode !== 1;
}

function verifyRelease() {
  if (!verifyManagedFiles()) return;
  if (!existsSync("package.json")) {
    console.log("No package.json found; release validation is limited to managed file checks.");
    return;
  }

  const policy = readJson(".darkfactory/release-policy.json").release;
  const manager = packageManager();
  if (!manager) throw new Error("No supported package manager files found.");
  const packageJson = readJson("package.json");

  installDependencies(manager);
  runPhase(manager, packageJson, "validate", Boolean(policy.required?.validate), policy.scripts?.validate ?? ["ci", "check", "test"]);
  runPhase(manager, packageJson, "build", Boolean(policy.required?.build), policy.scripts?.build ?? ["build:release", "release:build", "build"]);
  runPhase(manager, packageJson, "smoke", Boolean(policy.required?.smoke), policy.scripts?.smoke ?? ["smoke:release", "release:smoke", "test:release"]);
}

try {
  if (mode === "managed") verifyManagedFiles();
  else if (mode === "release") verifyRelease();
  else throw new Error(`Unknown DarkFactory checker mode: ${mode}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (process.exitCode === 1) process.exit(1);
