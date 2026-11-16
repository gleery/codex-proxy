/**
 * scripts/deploy/macos.sh `update` must not be blocked by local edits the
 * incoming commits don't touch (the running service rewrites
 * config/default.yaml when it bumps the client version), and must keep them.
 * git still refuses when an incoming commit would overwrite a local edit.
 */

import { afterEach, beforeEach, expect, it } from "vitest";
import { describePosix } from "@helpers/platform-test.js";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve("scripts/deploy/macos.sh");

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

let root: string;
let upstream: string;
let checkout: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

/** Commit a change to `file` in the upstream repo. */
function pushUpstream(file: string, content: string): void {
  writeFileSync(join(upstream, file), content);
  git(upstream, "add", file);
  git(upstream, "commit", "-qm", `change ${file}`);
}

/** Source the deploy script and run pull_latest against the test checkout. */
function pullLatest(): { status: number | null; output: string } {
  const res = spawnSync("bash", ["-c", 'source "$1"; REPO_DIR="$2"; pull_latest', "_", SCRIPT, checkout], {
    env: GIT_ENV,
    encoding: "utf8",
  });
  return { status: res.status, output: `${res.stdout}${res.stderr}` };
}

describePosix("deploy/macos.sh update — pull_latest", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deploy-update-"));
    upstream = join(root, "upstream");
    checkout = join(root, "checkout");
    execFileSync("git", ["init", "-q", upstream], { env: GIT_ENV });
    writeFileSync(join(upstream, "default.yaml"), "app_version: 1\n");
    writeFileSync(join(upstream, "app.ts"), "v1\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-qm", "init");
    execFileSync("git", ["clone", "-q", upstream, checkout], { env: GIT_ENV });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("fast-forwards and keeps a local edit the incoming commit does not touch", () => {
    writeFileSync(join(checkout, "default.yaml"), "app_version: 2\n");
    pushUpstream("app.ts", "v2\n");

    const { status, output } = pullLatest();

    expect(status).toBe(0);
    expect(output).toContain("Keeping local changes: default.yaml");
    expect(readFileSync(join(checkout, "app.ts"), "utf8")).toBe("v2\n");
    expect(readFileSync(join(checkout, "default.yaml"), "utf8")).toBe("app_version: 2\n");
  });

  it("stops without losing the edit when the incoming commit changes the same file", () => {
    writeFileSync(join(checkout, "default.yaml"), "app_version: 2\n");
    const before = git(checkout, "rev-parse", "HEAD");
    pushUpstream("default.yaml", "app_version: 3\n");

    const { status, output } = pullLatest();

    expect(status).not.toBe(0);
    expect(output).toContain("git pull failed");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(checkout, "default.yaml"), "utf8")).toBe("app_version: 2\n");
  });

  it("pulls quietly when the checkout is clean", () => {
    pushUpstream("app.ts", "v2\n");

    const { status, output } = pullLatest();

    expect(status).toBe(0);
    expect(output).not.toContain("Keeping local changes");
    expect(readFileSync(join(checkout, "app.ts"), "utf8")).toBe("v2\n");
  });
});
