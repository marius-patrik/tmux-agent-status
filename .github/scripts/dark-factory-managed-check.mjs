#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const CONFIG_PATH = ".darkfactory/managed-repository.json";

function fail(message, file = CONFIG_PATH) {
  console.error(`::error file=${file}::${message}`);
  process.exitCode = 1;
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error("Missing DarkFactory managed repository config.");
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Managed repository config must be an object.");
  }
  if (config.schemaVersion !== 1) {
    throw new Error("Managed repository config must use schemaVersion 1.");
  }
  if (!Array.isArray(config.packageFiles) || !config.packageFiles.every(isNonEmptyString)) {
    throw new Error("Managed repository config packageFiles must be an array of paths.");
  }
  if (!Array.isArray(config.requiredFiles) || !config.requiredFiles.every(isNonEmptyString)) {
    throw new Error("Managed repository config requiredFiles must be an array of paths.");
  }
  if (!Array.isArray(config.removedFiles) || !config.removedFiles.every(isNonEmptyString)) {
    throw new Error("Managed repository config removedFiles must be an array of paths.");
  }
  return config;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

try {
  const config = readConfig();
  const requiredFiles = new Set(config.requiredFiles);
  const packageFiles = new Set(config.packageFiles);
  for (const file of config.packageFiles) {
    if (!requiredFiles.has(file)) fail("Package-owned managed file is not declared as required.", file);
  }
  for (const file of config.requiredFiles) {
    if (packageFiles.has(file)) continue;
    if (!existsSync(file)) fail("Missing DarkFactory managed file.", file);
  }
  for (const file of config.removedFiles) {
    if (existsSync(file)) fail("Obsolete DarkFactory managed file is still present.", file);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (process.exitCode === 1) process.exit(1);
