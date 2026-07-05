import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function gitRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Unable to resolve git root");
  }

  return result.stdout.trim();
}

const root = gitRoot();
const statusPath = join(root, ".agents", ".project", "STATUS.md");

process.stdout.write(readFileSync(statusPath, "utf8"));
