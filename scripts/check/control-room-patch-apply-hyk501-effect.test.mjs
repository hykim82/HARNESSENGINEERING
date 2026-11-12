// HYK-501-registry-consume-1 (piece E · step E1, coder-task.md §2 ⓒ) -- effect
// layer: does the APPLIED launcher fixture, run by a REAL PowerShell against a
// synthetic git worktree, resolve engine / model / effort from the worktree
// registry through the REAL engine-profile-cli.mjs, and refuse to start a seat
// (exit 3) whenever the registry cannot be read or trusted?
//
// Every cell builds a mkdtemp synthetic worktree: real engine-profile-cli.mjs
// + engine-profile.mjs copied byte-for-byte, a synthetic registry (model and
// effort values that exist nowhere else, so a leaked literal default cannot
// hide), `git init` + one commit + an `origin/master` ref pointing at it (no
// network). The seat-preflight step is an always-pass stub (the real one reads
// the machine's installed hooks). Nothing here touches the control-room, a real
// seat, `orca`, the network or the real ledger. Cells that run WITHOUT -DryRun
// define `claude` / `codex` as PowerShell functions in the calling scope, so a
// mutated launcher that wrongly proceeds can never start a real agent.
//
// Negative cells (design 조각E-설계 §(c)): N1 CLI missing · N2 registry missing
// · N3 broken JSON · N4 schema · N5 role absent · N6 codex registry · N7
// diverges from origin/master · N8 inherited decoy env · N9 engine override
// without model · N10 CLI output not JSON · N11 memory-gate dry-runs the
// launcher before it measures (synthetic drive, Windows only).
//
// ⚠️정직 한계: (ⓐ) the stub `seat-preflight` means the preflight hook check is
// not exercised; (ⓑ) these cells run on the machine that runs the test -- this
// round measured them on Windows pwsh only, a Linux CI pwsh run is not
// measured; (ⓒ) the live control-room files are never opened (E2 does that);
// (ⓓ) if no PowerShell exists the cells SKIP loudly with a reason -- the
// collect and literal tests still gate the document and the fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findPowerShell } from "./seat-proof-wrapper-behavior.mjs";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const LAUNCHER_APPLIED = here(
  "./fixtures/control-room-orca-worker-seat-2026-11-13-hyk501-registry-consume-applied.ps1.txt",
);
const GATE_APPLIED = here(
  "./fixtures/control-room-memory-gate-2026-11-13-hyk501-registry-consume-applied.ps1.txt",
);
const REAL_CLI = here("./engine-profile-cli.mjs");
const REAL_LIB = here("./engine-profile.mjs");
const REAL_REGISTRY = here("./engine-profiles.json");

const PS_EXE = findPowerShell();
const NO_PS_SKIP_REASON =
  "SKIP_REASON: no PowerShell executable found on PATH -- the behavioral layer for the HYK-501 registry-consume launcher cannot run here; the collect and literal tests still gate the document and the fixtures";
const NOT_WINDOWS_SKIP_REASON =
  "SKIP_REASON: the memory-gate synthetic drive needs Windows (state file writing uses Get-CimInstance / Get-Counter) -- the static N11 assertions in the literal test still run";

const REGISTRY_REL = "scripts/check/engine-profiles.json";
const ROLES = ["CODER", "REVIEW", "VERIFY", "PM"];
// Values that exist nowhere else in the repository.
const syn = (role) => ({
  engine: "claude",
  model: `syn-model-${role.toLowerCase()}`,
  effort: `syn-effort-${role.toLowerCase()}`,
});
const baseRegistry = JSON.parse(readFileSync(REAL_REGISTRY, "utf8"));
const registryWith = (roles) => ({ ...baseRegistry, roles });
const SYN_ROLES = Object.fromEntries(ROLES.map((r) => [r, syn(r)]));

function git(cwd, args) {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=syn",
      "-c",
      "user.email=syn@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// registry: an object (JSON.stringify), a raw string (written verbatim) or
// null (no registry file at all). cli: "real" | "missing" | {stub: "<js>"}.
function makeWorktree({
  registry = registryWith(SYN_ROLES),
  cli = "real",
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hyk501-effect-"));
  const wt = join(dir, "wt");
  mkdirSync(join(wt, "scripts", "check"), { recursive: true });
  git(wt, ["init", "-q"]);
  git(wt, ["symbolic-ref", "HEAD", "refs/heads/master"]);
  writeFileSync(
    join(wt, "scripts", "check", "seat-preflight.mjs"),
    "// synthetic always-pass stub (the real preflight reads the machine's hook install)\nprocess.exit(0);\n",
  );
  if (cli === "real") {
    copyFileSync(
      REAL_CLI,
      join(wt, "scripts", "check", "engine-profile-cli.mjs"),
    );
    copyFileSync(REAL_LIB, join(wt, "scripts", "check", "engine-profile.mjs"));
  } else if (cli !== "missing") {
    writeFileSync(
      join(wt, "scripts", "check", "engine-profile-cli.mjs"),
      cli.stub,
    );
  }
  if (registry !== null) {
    writeFileSync(
      join(wt, REGISTRY_REL),
      typeof registry === "string" ? registry : JSON.stringify(registry),
    );
  }
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "synthetic"]);
  // origin/master without a network: a remote-tracking ref at the commit.
  git(wt, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  const launcher = join(dir, "orca-worker-seat.ps1");
  copyFileSync(LAUNCHER_APPLIED, launcher);
  return {
    dir,
    wt,
    launcher,
    registryPath: join(wt, REGISTRY_REL),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!("HARNESS_ENGINE_PROFILES_PATH" in extra)) {
    delete env.HARNESS_ENGINE_PROFILES_PATH;
  }
  env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;
  return env;
}

const psArgs = (file, rest) => [
  "-NoProfile",
  "-NoLogo",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  file,
  ...rest,
];

// DryRun by default: nothing after the resolve step can ever run.
function runLauncher(ws, role, extra = [], { dryRun = true, env = {} } = {}) {
  const r = spawnSync(
    PS_EXE,
    psArgs(ws.launcher, [
      "-Role",
      role,
      "-Worktree",
      ws.wt,
      ...(dryRun ? ["-DryRun"] : []),
      ...extra,
    ]),
    { encoding: "utf8", timeout: 120000, env: childEnv(env) },
  );
  return {
    status: r.status,
    text: `${r.stdout}\n${r.stderr}`.replace(/\r/g, ""),
  };
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Non-DryRun cells: the agent commands are PowerShell functions in the calling
// scope -- the launcher script sees them, a real `claude` / `codex` never starts.
function runLauncherLive(ws, role, extra = []) {
  const logPath = join(ws.dir, "agent-launch.log");
  const harness = join(ws.dir, "harness.ps1");
  writeFileSync(
    harness,
    [
      "$ErrorActionPreference = 'Continue'",
      `$env:SYN_AGENT_LOG = ${q(logPath)}`,
      "function claude { Set-Content -LiteralPath $env:SYN_AGENT_LOG -Value ('claude ' + (@($args)[0..4] -join ' ')); $global:LASTEXITCODE = 0 }",
      "function codex { Set-Content -LiteralPath $env:SYN_AGENT_LOG -Value ('codex ' + (@($args)[0..1] -join ' ')); $global:LASTEXITCODE = 0 }",
      // parameter names stay bare (a quoted '-Model' would be a positional string)
      `& ${q(ws.launcher)} -Role ${role} -Worktree ${q(ws.wt)} ${extra
        .map((a) => (a.startsWith("-") ? a : q(a)))
        .join(" ")}`,
      "exit $LASTEXITCODE",
      "",
    ].join("\n"),
  );
  const r = spawnSync(PS_EXE, psArgs(harness, []), {
    encoding: "utf8",
    timeout: 120000,
    env: childEnv({ ORCA_PANE_KEY: "" }),
  });
  return {
    status: r.status,
    text: `${r.stdout}\n${r.stderr}`.replace(/\r/g, ""),
    agentLog: existsSync(logPath) ? readFileSync(logPath, "utf8").trim() : null,
    registryWritten: existsSync(join(ws.dir, "seat-launch-registry.jsonl")),
  };
}

function withWorktree(opts, fn) {
  const ws = makeWorktree(opts);
  try {
    return fn(ws);
  } finally {
    ws.cleanup();
  }
}

// The success line only -- a BLOCKED reason may also contain "engine-profile:".
const profileLine = (text) =>
  text.split("\n").find((l) => l.includes(" engine-profile: engine=")) ?? "";
// A refusal prints exactly ONE BLOCKED line. Two lines mean a branch lost its
// exit and fell through into a later check (M2 of the mutation round: deleting
// the exit of the resolve-failure branch stayed green while only the first
// BLOCKED line was inspected).
const blockedLine = (text) => {
  const lines = text.split("\n").filter((l) => l.includes("BLOCKED --"));
  assert.equal(
    lines.length,
    1,
    `expected exactly one BLOCKED line, got ${lines.length}:\n${text}`,
  );
  return lines[0];
};
const warnLines = (text) =>
  text
    .split("\n")
    .filter((l) => l.includes("WARN explicit overrides registry"));

function skipUnlessPs(t) {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return true;
  }
  return false;
}

const BLOB_RE = "registry_blob=[0-9a-f]{7} origin_blob=[0-9a-f]{7}";

test("★positive: DryRun of the applied launcher, 4 roles -- engine/model/effort come from the synthetic registry, match=yes, DRYRUN rc=0, exit 0, and nothing past the resolve step ran", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({}, (ws) => {
    for (const role of ROLES) {
      const r = runLauncher(ws, role);
      assert.equal(r.status, 0, `${role}: ${r.text}`);
      const want = syn(role);
      assert.match(
        profileLine(r.text),
        new RegExp(
          `\\[${role} seat\\] engine-profile: engine=claude\\(registry\\) model=${want.model}\\(registry\\) effort=${want.effort}\\(registry\\) ${BLOB_RE} match=yes`,
        ),
        `${role}: ${r.text}`,
      );
      assert.match(r.text, /DRYRUN rc=0/);
      assert.equal(warnLines(r.text).length, 0);
      // DryRun stops BEFORE the seat registry record, the launch-rules block and the engine start
      assert.doesNotMatch(
        r.text,
        /launch-rules|worktree=.*pane=|origin-registry/,
      );
    }
    assert.equal(existsSync(join(ws.dir, "seat-launch-registry.jsonl")), false);
  });
});

test("★positive: the printed registry blob equals the printed origin blob (7-char prefix of the real git blob)", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({}, (ws) => {
    const r = runLauncher(ws, "CODER");
    const m = profileLine(r.text).match(
      /registry_blob=(\S+) origin_blob=(\S+)/,
    );
    assert.ok(m, r.text);
    assert.equal(m[1], m[2]);
    const blob = git(ws.wt, [
      "rev-parse",
      `origin/master:${REGISTRY_REL}`,
    ]).trim();
    assert.equal(blob.startsWith(m[1]), true);
  });
});

test("★explicit wins per field: -Model only -> model(arg) + exactly one WARN; engine and effort still come from the registry", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({}, (ws) => {
    const r = runLauncher(ws, "CODER", ["-Model", "syn-explicit-model"]);
    assert.equal(r.status, 0, r.text);
    assert.match(
      profileLine(r.text),
      /engine=claude\(registry\) model=syn-explicit-model\(arg\) effort=syn-effort-coder\(registry\)/,
    );
    const warns = warnLines(r.text);
    assert.equal(warns.length, 1, r.text);
    assert.match(
      warns[0],
      /WARN explicit overrides registry: model syn-explicit-model \(registry syn-model-coder\)/,
    );
  });
});

test("explicit effort only -> effort(arg) + one WARN; an explicit value equal to the registry value is (arg) with no WARN", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({}, (ws) => {
    const a = runLauncher(ws, "REVIEW", ["-Effort", "syn-explicit-effort"]);
    assert.equal(a.status, 0, a.text);
    assert.match(
      profileLine(a.text),
      /model=syn-model-review\(registry\) effort=syn-explicit-effort\(arg\)/,
    );
    assert.equal(warnLines(a.text).length, 1);
    const b = runLauncher(ws, "REVIEW", ["-Model", "syn-model-review"]);
    assert.equal(b.status, 0, b.text);
    assert.match(profileLine(b.text), /model=syn-model-review\(arg\)/);
    assert.equal(warnLines(b.text).length, 0);
  });
});

test("all three explicit and equal to the registry -> every field (arg), no WARN, exit 0 (the registry is still read)", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({}, (ws) => {
    const w = syn("VERIFY");
    const r = runLauncher(ws, "VERIFY", [
      "-Engine",
      w.engine,
      "-Model",
      w.model,
      "-Effort",
      w.effort,
    ]);
    assert.equal(r.status, 0, r.text);
    assert.match(
      profileLine(r.text),
      new RegExp(
        `engine=claude\\(arg\\) model=${w.model}\\(arg\\) effort=${w.effort}\\(arg\\)`,
      ),
    );
    assert.equal(warnLines(r.text).length, 0);
  });
});

test("★N1: no engine-profile-cli.mjs in the worktree (old worktree) -> exit 3, ENGINE_PROFILE_CLI_MISSING with the rebase key, no engine-profile line", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({ cli: "missing" }, (ws) => {
    const r = runLauncher(ws, "CODER");
    assert.equal(r.status, 3, r.text);
    assert.match(blockedLine(r.text), /BLOCKED -- ENGINE_PROFILE_CLI_MISSING/);
    assert.equal(profileLine(r.text), "");
  });
});

test("★N2: registry file missing -> exit 3, ENGINE_PROFILE_RESOLVE_FAILED with the CLI reason CONFIG_FILE_UNREADABLE", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({ registry: null }, (ws) => {
    const r = runLauncher(ws, "CODER");
    assert.equal(r.status, 3, r.text);
    assert.match(
      blockedLine(r.text),
      /BLOCKED -- ENGINE_PROFILE_RESOLVE_FAILED rc=2 reason=.*CONFIG_FILE_UNREADABLE/,
    );
    assert.equal(profileLine(r.text), "");
  });
});

test("★N3: broken JSON -> exit 3, the reason keeps CONFIG_FILE_INVALID_JSON (stderr is not thrown away) -- also with all three explicit args (the read is mandatory)", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({ registry: "{ not json" }, (ws) => {
    const r = runLauncher(ws, "CODER");
    assert.equal(r.status, 3, r.text);
    assert.match(
      blockedLine(r.text),
      /BLOCKED -- ENGINE_PROFILE_RESOLVE_FAILED rc=2 reason=.*CONFIG_FILE_INVALID_JSON/,
    );
    const w = syn("CODER");
    const all3 = runLauncher(ws, "CODER", [
      "-Engine",
      w.engine,
      "-Model",
      w.model,
      "-Effort",
      w.effort,
    ]);
    assert.equal(all3.status, 3, all3.text);
    assert.match(blockedLine(all3.text), /ENGINE_PROFILE_RESOLVE_FAILED/);
    assert.equal(profileLine(all3.text), "");
  });
});

test("★N4: schema violation (empty model) -> exit 3, reason CONFIG_SCHEMA_INVALID", (t) => {
  if (skipUnlessPs(t)) return;
  const roles = { ...SYN_ROLES, CODER: { ...syn("CODER"), model: "" } };
  withWorktree({ registry: registryWith(roles) }, (ws) => {
    const r = runLauncher(ws, "CODER");
    assert.equal(r.status, 3, r.text);
    assert.match(
      blockedLine(r.text),
      /ENGINE_PROFILE_RESOLVE_FAILED rc=2 reason=.*CONFIG_SCHEMA_INVALID/,
    );
  });
});

test("★N5: the role is not in the registry -> exit 3, reason 'no profile for role'", (t) => {
  if (skipUnlessPs(t)) return;
  const rest = Object.fromEntries(
    Object.entries(SYN_ROLES).filter(([role]) => role !== "VERIFY"),
  );
  withWorktree({ registry: registryWith(rest) }, (ws) => {
    const r = runLauncher(ws, "VERIFY");
    assert.equal(r.status, 3, r.text);
    assert.match(
      blockedLine(r.text),
      /ENGINE_PROFILE_RESOLVE_FAILED rc=2 reason=.*no profile for role/,
    );
    // a role that IS present still resolves in the same worktree
    assert.equal(runLauncher(ws, "CODER").status, 0);
  });
});

test("★N6: the registry engine for the role is codex -> exit 3, ENGINE_CODEX_REFUSED, no engine-profile line", (t) => {
  if (skipUnlessPs(t)) return;
  const roles = { ...SYN_ROLES, REVIEW: { ...syn("REVIEW"), engine: "codex" } };
  withWorktree({ registry: registryWith(roles) }, (ws) => {
    const r = runLauncher(ws, "REVIEW");
    assert.equal(r.status, 3, r.text);
    assert.match(blockedLine(r.text), /BLOCKED -- ENGINE_CODEX_REFUSED/);
    assert.equal(profileLine(r.text), "");
    // the other roles are unaffected
    assert.equal(runLauncher(ws, "CODER").status, 0);
  });
});

test("★N7: working-tree registry differs from origin/master (uncommitted edit) -> exit 3, REGISTRY_DIVERGES_FROM_ORIGIN_MASTER; a partial explicit set does not help; all three explicit passes with match=no and (arg) everywhere", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({}, (ws) => {
    const edited = registryWith({
      ...SYN_ROLES,
      CODER: { ...syn("CODER"), model: "syn-branch-edited-model" },
    });
    writeFileSync(ws.registryPath, JSON.stringify(edited));
    const none = runLauncher(ws, "CODER");
    assert.equal(none.status, 3, none.text);
    assert.match(
      blockedLine(none.text),
      /BLOCKED -- REGISTRY_DIVERGES_FROM_ORIGIN_MASTER/,
    );
    assert.equal(profileLine(none.text), "");
    const partial = runLauncher(ws, "CODER", [
      "-Model",
      "syn-m",
      "-Effort",
      "syn-e",
    ]);
    assert.equal(partial.status, 3, partial.text);
    assert.match(
      blockedLine(partial.text),
      /REGISTRY_DIVERGES_FROM_ORIGIN_MASTER/,
    );
    const all3 = runLauncher(ws, "CODER", [
      "-Engine",
      "claude",
      "-Model",
      "syn-m",
      "-Effort",
      "syn-e",
    ]);
    assert.equal(all3.status, 0, all3.text);
    assert.match(
      profileLine(all3.text),
      /engine=claude\(arg\) model=syn-m\(arg\) effort=syn-e\(arg\).* match=no/,
    );
  });
});

test("N7 (branch commit): the registry was changed in a COMMIT on the branch while origin/master stayed behind -> same refusal", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({}, (ws) => {
    writeFileSync(
      ws.registryPath,
      JSON.stringify(
        registryWith({
          ...SYN_ROLES,
          CODER: { ...syn("CODER"), model: "syn-committed-on-branch" },
        }),
      ),
    );
    git(ws.wt, ["commit", "-q", "-am", "branch edits the registry"]);
    const r = runLauncher(ws, "CODER");
    assert.equal(r.status, 3, r.text);
    assert.match(blockedLine(r.text), /REGISTRY_DIVERGES_FROM_ORIGIN_MASTER/);
  });
});

test("N7 (no origin ref): a worktree without any origin/master ref cannot prove the registry is trusted -> refusal (safe direction); all three explicit still passes", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({}, (ws) => {
    git(ws.wt, ["update-ref", "-d", "refs/remotes/origin/master"]);
    const r = runLauncher(ws, "CODER");
    assert.equal(r.status, 3, r.text);
    assert.match(blockedLine(r.text), /REGISTRY_DIVERGES_FROM_ORIGIN_MASTER/);
    const all3 = runLauncher(ws, "CODER", [
      "-Engine",
      "claude",
      "-Model",
      "syn-m",
      "-Effort",
      "syn-e",
    ]);
    assert.equal(all3.status, 0, all3.text);
    assert.match(profileLine(all3.text), / match=no/);
  });
});

test("★N8: an inherited HARNESS_ENGINE_PROFILES_PATH (decoy registry) is ignored -- the worktree file is the only thing read", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({}, (ws) => {
    const decoy = join(ws.dir, "decoy-registry.json");
    writeFileSync(
      decoy,
      JSON.stringify(
        registryWith({
          ...SYN_ROLES,
          CODER: {
            engine: "claude",
            model: "decoy-model-must-not-appear",
            effort: "decoy-effort-must-not-appear",
          },
        }),
      ),
    );
    const r = runLauncher(ws, "CODER", [], {
      env: { HARNESS_ENGINE_PROFILES_PATH: decoy },
    });
    assert.equal(r.status, 0, r.text);
    assert.match(profileLine(r.text), /model=syn-model-coder\(registry\)/);
    assert.doesNotMatch(r.text, /decoy-model-must-not-appear/);
  });
});

test("★N9: -Engine differs from the registry engine and -Model/-Effort are missing -> exit 3, ENGINE_OVERRIDE_NEEDS_MODEL; with both given it passes with engine(arg)", (t) => {
  if (skipUnlessPs(t)) return;
  const roles = { ...SYN_ROLES, CODER: { ...syn("CODER"), engine: "codex" } };
  withWorktree({ registry: registryWith(roles) }, (ws) => {
    const engineOnly = runLauncher(ws, "CODER", ["-Engine", "claude"]);
    assert.equal(engineOnly.status, 3, engineOnly.text);
    assert.match(blockedLine(engineOnly.text), /ENGINE_OVERRIDE_NEEDS_MODEL/);
    const noEffort = runLauncher(ws, "CODER", [
      "-Engine",
      "claude",
      "-Model",
      "syn-m",
    ]);
    assert.equal(noEffort.status, 3, noEffort.text);
    const ok = runLauncher(ws, "CODER", [
      "-Engine",
      "claude",
      "-Model",
      "syn-m",
      "-Effort",
      "syn-e",
    ]);
    assert.equal(ok.status, 0, ok.text);
    assert.match(
      profileLine(ok.text),
      /engine=claude\(arg\) model=syn-m\(arg\) effort=syn-e\(arg\)/,
    );
    assert.equal(warnLines(ok.text).length, 3, ok.text);
  });
});

test("explicit -Engine codex: needs -Model (and -Effort when the registry engine differs); with them it passes -- the explicit path stays open, the registry path is refused (N6)", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({}, (ws) => {
    const none = runLauncher(ws, "REVIEW", ["-Engine", "codex"]);
    assert.equal(none.status, 3, none.text);
    assert.match(blockedLine(none.text), /ENGINE_OVERRIDE_NEEDS_MODEL/);
    const ok = runLauncher(ws, "REVIEW", [
      "-Engine",
      "codex",
      "-Model",
      "syn-codex-model",
      "-Effort",
      "syn-e",
    ]);
    assert.equal(ok.status, 0, ok.text);
    assert.match(
      profileLine(ok.text),
      /engine=codex\(arg\) model=syn-codex-model\(arg\)/,
    );
  });
  const roles = { ...SYN_ROLES, REVIEW: { ...syn("REVIEW"), engine: "codex" } };
  withWorktree({ registry: registryWith(roles) }, (ws) => {
    // registry engine is codex AND the caller names codex without a model
    const same = runLauncher(ws, "REVIEW", ["-Engine", "codex"]);
    assert.equal(same.status, 3, same.text);
    assert.match(blockedLine(same.text), /ENGINE_OVERRIDE_NEEDS_MODEL/);
  });
});

const stubCli = (body) => ({ stub: body });

test("★N10: the CLI prints something that is not JSON (exit 0) -> exit 3, ENGINE_PROFILE_OUTPUT_INVALID", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({ cli: stubCli('console.log("this is not json");\n') }, (ws) => {
    const r = runLauncher(ws, "CODER");
    assert.equal(r.status, 3, r.text);
    assert.match(
      blockedLine(r.text),
      /BLOCKED -- ENGINE_PROFILE_OUTPUT_INVALID/,
    );
    assert.equal(profileLine(r.text), "");
  });
});

test("N10: JSON with a missing key, and JSON naming an engine the launcher cannot start, are both refused (exit 3, OUTPUT_INVALID)", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree(
    { cli: stubCli('console.log(JSON.stringify({ engine: "claude" }));\n') },
    (ws) => {
      const r = runLauncher(ws, "CODER");
      assert.equal(r.status, 3, r.text);
      assert.match(blockedLine(r.text), /ENGINE_PROFILE_OUTPUT_INVALID/);
    },
  );
  withWorktree(
    {
      cli: stubCli(
        'console.log(JSON.stringify({ engine: "syn-unsupported", model: "m", effort: "e" }));\n',
      ),
    },
    (ws) => {
      const r = runLauncher(ws, "CODER");
      assert.equal(r.status, 3, r.text);
      assert.match(blockedLine(r.text), /ENGINE_PROFILE_OUTPUT_INVALID/);
      assert.match(blockedLine(r.text), /syn-unsupported/);
    },
  );
});

test("stderr of a failing CLI is carried into the reason (any CLI, not only the real one) -- a stub exiting 2 with a distinctive stderr", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree(
    {
      cli: stubCli(
        'console.error("syn-distinctive-stderr-reason");\nprocess.exit(2);\n',
      ),
    },
    (ws) => {
      const r = runLauncher(ws, "CODER");
      assert.equal(r.status, 3, r.text);
      assert.match(
        blockedLine(r.text),
        /ENGINE_PROFILE_RESOLVE_FAILED rc=2 reason=.*syn-distinctive-stderr-reason/,
      );
    },
  );
});

test("★fail-closed also WITHOUT -DryRun: a broken registry stops the real launch path before any agent command (agent stub never called, no seat registry written)", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({ registry: "{ not json" }, (ws) => {
    const r = runLauncherLive(ws, "CODER");
    assert.equal(r.status, 3, r.text);
    assert.match(blockedLine(r.text), /ENGINE_PROFILE_RESOLVE_FAILED/);
    assert.equal(r.agentLog, null, "no agent command may run");
    assert.equal(r.registryWritten, false);
  });
});

test("★real launch path (agent commands stubbed as functions): the claude command receives the REGISTRY model and effort -- no literal default in between", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({}, (ws) => {
    const r = runLauncherLive(ws, "CODER");
    assert.equal(r.status, 0, r.text);
    assert.equal(
      r.agentLog,
      "claude --model syn-model-coder --effort syn-effort-coder --dangerously-skip-permissions",
    );
    assert.match(profileLine(r.text), /model=syn-model-coder\(registry\)/);
    const override = runLauncherLive(ws, "CODER", [
      "-Model",
      "syn-explicit-model",
    ]);
    assert.equal(override.status, 0, override.text);
    assert.match(
      override.agentLog,
      /^claude --model syn-explicit-model --effort syn-effort-coder /,
    );
  });
});

test("real launch path: an explicit -Engine codex -Model -Effort reaches the codex command with the explicit model (no model literal in the codex branch)", (t) => {
  if (skipUnlessPs(t)) return;
  withWorktree({}, (ws) => {
    const r = runLauncherLive(ws, "REVIEW", [
      "-Engine",
      "codex",
      "-Model",
      "syn-codex-model",
      "-Effort",
      "syn-e",
    ]);
    assert.equal(r.status, 0, r.text);
    assert.equal(r.agentLog, "codex --model syn-codex-model");
  });
});

// ---- N11: memory-gate dry-runs the launcher before it measures ------------

const GATE_STUB_LAUNCHER = [
  "param([string]$Role,[string]$Worktree,[string]$Engine='',[string]$Model='',[string]$Effort='',[switch]$DryRun)",
  "Set-Content -LiteralPath (Join-Path $PSScriptRoot 'stub-args.txt') -Value (\"Role=$Role Worktree=$Worktree Engine=$Engine Model=$Model Effort=$Effort DryRun=$([bool]$DryRun)\")",
  "Write-Host 'STUB launcher: BLOCKED -- ENGINE_PROFILE_RESOLVE_FAILED (synthetic)'",
  "exit 3",
  "",
].join("\n");

function runGateSynthetic(extra) {
  const dir = mkdtempSync(join(tmpdir(), "hyk501-gate-"));
  try {
    copyFileSync(GATE_APPLIED, join(dir, "memory-gate.ps1"));
    writeFileSync(join(dir, "orca-worker-seat.ps1"), GATE_STUB_LAUNCHER);
    const wt = join(dir, "wt");
    mkdirSync(wt);
    const r = spawnSync(
      PS_EXE,
      psArgs(join(dir, "memory-gate.ps1"), [
        "-Round",
        "syn-round",
        "-Worktree",
        wt,
        "-Role",
        "CODER",
        "-Title",
        "syn-title",
        "-OrchHandle",
        "syn-handle",
        "-LogPath",
        join(dir, "gate.log"),
        "-StatePath",
        join(dir, "state.json"),
        "-HistoryPath",
        join(dir, "history.jsonl"),
        "-DryRun",
        ...extra,
      ]),
      { encoding: "utf8", timeout: 120000, env: childEnv() },
    );
    const read = (name) =>
      existsSync(join(dir, name))
        ? readFileSync(join(dir, name), "utf8")
        : null;
    return {
      status: r.status,
      text: `${r.stdout}\n${r.stderr}`.replace(/\r/g, ""),
      state: read("state.json"),
      log: read("gate.log"),
      stubArgs: read("stub-args.txt")?.trim() ?? null,
      wt,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gateSyntheticSkip(t) {
  if (skipUnlessPs(t)) return true;
  if (process.platform !== "win32") {
    t.skip(NOT_WINDOWS_SKIP_REASON);
    return true;
  }
  if (PS_EXE !== "pwsh") {
    t.skip(
      "SKIP_REASON: the memory-gate dry-runs the launcher with `pwsh`; only Windows PowerShell was found on PATH",
    );
    return true;
  }
  return false;
}

test("★N11 (synthetic drive, Windows): the applied memory-gate dry-runs the launcher BEFORE measuring; a non-zero launcher exit ends it with CLOSED_ENGINE_PROFILE_UNRESOLVED, no measurement step in the log, and only non-empty arguments were passed", (t) => {
  if (gateSyntheticSkip(t)) return;
  const r = runGateSynthetic([]);
  assert.equal(r.status, 0, r.text);
  const state = JSON.parse(r.state);
  assert.equal(state.verdict, "CLOSED_ENGINE_PROFILE_UNRESOLVED");
  assert.equal(state.status, "closed");
  assert.equal(state.dry_run, true);
  assert.match(r.log, /seat-dryrun rc=3/);
  assert.match(r.log, /VERDICT=CLOSED_ENGINE_PROFILE_UNRESOLVED rc=3/);
  assert.doesNotMatch(r.log, /mode=|ALIGN=|step1|discard-sample|settling/);
  assert.equal(
    r.stubArgs,
    `Role=CODER Worktree=${r.wt} Engine= Model= Effort= DryRun=True`,
  );
});

test("N11 (synthetic drive, Windows): explicit -Model/-Effort/-Engine reach the launcher dry-run; nothing explicit means nothing passed", (t) => {
  if (gateSyntheticSkip(t)) return;
  const r = runGateSynthetic([
    "-Engine",
    "claude",
    "-Model",
    "syn-m",
    "-Effort",
    "syn-e",
  ]);
  assert.equal(r.status, 0, r.text);
  assert.equal(
    r.stubArgs,
    `Role=CODER Worktree=${r.wt} Engine=claude Model=syn-m Effort=syn-e DryRun=True`,
  );
  assert.equal(JSON.parse(r.state).verdict, "CLOSED_ENGINE_PROFILE_UNRESOLVED");
});
