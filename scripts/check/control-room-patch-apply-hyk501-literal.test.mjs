// HYK-501-registry-consume-1 (piece E · step E1) -- literal-absence layer.
// The point of piece E: the launcher and the memory gate must not carry
// engine / model / effort DEFAULT literals any more -- the worktree registry
// (scripts/check/engine-profiles.json, read through engine-profile-cli.mjs)
// decides. These tests read the two APPLIED fixtures as text and pin:
//   * zero occurrences of the five literal shapes the design (조각E-설계 §(a)
//     L1~L7 and §(f) 칠 명령) names,
//   * the structural promises the effect layer cannot see by running
//     (no 2>$null on the registry read, env decoy removal present, the
//     resolve step sits right after seat-preflight and BEFORE the seat
//     registry record, the memory gate dry-runs the launcher BEFORE it
//     starts measuring and passes only non-empty arguments).
// The BEFORE fixtures must still contain the literals (anti-vacuity: the
// scanner is proven able to see them) and a reintroduced literal must flip
// the scanner RED.
//
// ⚠️정직 한계: text checks only. Behaviour (what a real PowerShell does with
// these lines) is the effect test's job; the live control-room files are
// never opened here (E2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel) => readFileSync(here(rel), "utf8");

const SEAT_BEFORE = read(
  "./fixtures/control-room-orca-worker-seat-2026-11-13-hyk501-registry-consume-before.ps1.txt",
);
const SEAT_APPLIED = read(
  "./fixtures/control-room-orca-worker-seat-2026-11-13-hyk501-registry-consume-applied.ps1.txt",
);
const GATE_BEFORE = read(
  "./fixtures/control-room-memory-gate-2026-11-13-hyk501-registry-consume-before.ps1.txt",
);
const GATE_APPLIED = read(
  "./fixtures/control-room-memory-gate-2026-11-13-hyk501-registry-consume-applied.ps1.txt",
);

// The five shapes of design §(f) "지금 리터럴 자리" grep.
const LITERALS = [
  "claude-sonnet-5",
  "gpt-5.6-",
  '"medium"',
  '"codex" } else',
  "-Engine claude",
];

function findLiterals(text) {
  return LITERALS.filter((lit) => text.includes(lit));
}

test("★applied launcher carries none of the five default-literal shapes", () => {
  assert.deepEqual(findLiterals(SEAT_APPLIED), []);
});

test("★applied memory-gate carries none of the five default-literal shapes", () => {
  assert.deepEqual(findLiterals(GATE_APPLIED), []);
});

test("anti-vacuity: the BEFORE launcher still carries all four launcher shapes and the BEFORE memory-gate both gate shapes (the scanner can see them)", () => {
  assert.deepEqual(findLiterals(SEAT_BEFORE), [
    "claude-sonnet-5",
    "gpt-5.6-",
    '"medium"',
    '"codex" } else',
  ]);
  assert.deepEqual(findLiterals(GATE_BEFORE), [
    "claude-sonnet-5",
    "-Engine claude",
  ]);
});

test("anti-vacuity: reintroducing any single literal into an applied fixture flips the scanner RED", () => {
  for (const lit of LITERALS) {
    assert.deepEqual(findLiterals(`${SEAT_APPLIED}\n# ${lit}\n`), [lit]);
    assert.deepEqual(findLiterals(`${GATE_APPLIED}\n# ${lit}\n`), [lit]);
  }
});

// ---- launcher structure ---------------------------------------------------

const idx = (text, needle) => {
  const at = text.indexOf(needle);
  assert.notEqual(at, -1, `expected to find ${JSON.stringify(needle)}`);
  return at;
};

test("launcher: the registry read keeps stderr (design §(b) 3: no 2>$null -- the old proposal threw the reason away)", () => {
  assert.equal(SEAT_APPLIED.includes("2>$null"), false);
  assert.match(
    SEAT_APPLIED,
    /& node \$profileCli resolve --role \$Role --json 2>&1/,
  );
});

test("launcher: the decoy-env removal line is present and sits BEFORE the CLI call (N8)", () => {
  const removal = idx(
    SEAT_APPLIED,
    "Remove-Item Env:HARNESS_ENGINE_PROFILES_PATH",
  );
  const call = idx(SEAT_APPLIED, "& node $profileCli resolve");
  assert.ok(removal < call);
});

test("launcher: the resolve step sits right after seat-preflight, before the control-room rule is read, and BEFORE the seat registry record", () => {
  const preflight = idx(SEAT_APPLIED, "node scripts/check/seat-preflight.mjs");
  const resolve = idx(SEAT_APPLIED, "& node $profileCli resolve");
  const ruleRead = idx(SEAT_APPLIED, "$rule = Get-Content");
  const record = idx(SEAT_APPLIED, "& node $seatRegistryCliPath record");
  assert.ok(preflight < resolve);
  assert.ok(resolve < ruleRead);
  assert.ok(resolve < record);
});

test("launcher: -DryRun is a switch and the DRYRUN exit comes before the seat registry record, the launch-rules block and any engine start", () => {
  assert.match(SEAT_APPLIED, /\[switch\]\$DryRun/);
  const dry = idx(SEAT_APPLIED, "if ($DryRun)");
  assert.ok(dry < idx(SEAT_APPLIED, "& node $seatRegistryCliPath record"));
  assert.ok(dry < idx(SEAT_APPLIED, "worker-launch-rules.mjs"));
  assert.ok(dry < idx(SEAT_APPLIED, "claude --model"));
  assert.ok(dry < idx(SEAT_APPLIED, "codex --model"));
});

test("launcher: every fail-closed branch names its reason code and exits 3", () => {
  for (const code of [
    "ENGINE_PROFILE_CLI_MISSING",
    "ENGINE_PROFILE_RESOLVE_FAILED",
    "ENGINE_PROFILE_OUTPUT_INVALID",
    "REGISTRY_DIVERGES_FROM_ORIGIN_MASTER",
    "ENGINE_CODEX_REFUSED",
    "ENGINE_OVERRIDE_NEEDS_MODEL",
  ]) {
    const at = idx(SEAT_APPLIED, `BLOCKED -- ${code}`);
    const tail = SEAT_APPLIED.slice(at, at + 700);
    assert.match(tail, /exit 3/, `${code} must be followed by exit 3`);
  }
});

test("launcher: the explicit-argument priority is per field and the origin blob comparison exists (N7)", () => {
  assert.match(
    SEAT_APPLIED,
    /git -C \$Worktree rev-parse "origin\/master:\$regRel"/,
  );
  assert.match(SEAT_APPLIED, /git -C \$Worktree hash-object -- \$regRel/);
});

test("launcher: the claude branch passes the resolved values, not a fallback", () => {
  assert.match(SEAT_APPLIED, /\$claudeModel = \$Model\r?\n/);
  assert.match(SEAT_APPLIED, /\$claudeEffort = \$Effort\r?\n/);
  assert.match(SEAT_APPLIED, /\$codexModel = \$Model\r?\n/);
});

// ---- memory-gate structure ------------------------------------------------

test("memory-gate: Engine/Model/Effort default to empty (no literal default; N11 prerequisite)", () => {
  assert.match(GATE_APPLIED, /\[string\]\$Engine = ''/);
  assert.match(GATE_APPLIED, /\[string\]\$Model = ''/);
  assert.match(GATE_APPLIED, /\[string\]\$Effort = ''/);
});

test("★N11 (static): memory-gate dry-runs the launcher BEFORE the first measurement step and closes with CLOSED_ENGINE_PROFILE_UNRESOLVED on a non-zero exit", () => {
  const callSite = idx(
    GATE_APPLIED,
    "& pwsh -NoLogo -File $seatLauncherPs1 -Role $Role -Worktree $WT @seatOptArr -DryRun",
  );
  const verdict = idx(GATE_APPLIED, 'Finish "CLOSED_ENGINE_PROFILE_UNRESOLVED');
  const firstMeasure = idx(GATE_APPLIED, "$g = Get-GameCount");
  assert.ok(callSite < firstMeasure, "dry-run must come before measurement");
  assert.ok(verdict < firstMeasure, "the verdict must come before measurement");
  assert.ok(callSite < verdict);
  const between = GATE_APPLIED.slice(callSite, verdict);
  assert.match(between, /\$seatDryRc -ne 0/);
  // the dry-run call is the .ps1 itself next to memory-gate, never the -NoExit wrapper
  assert.match(
    GATE_APPLIED,
    /\$seatLauncherPs1 = Join-Path \$PSScriptRoot 'orca-worker-seat\.ps1'/,
  );
  // a launcher that cannot even be started closes the gate too (no silent pass)
  assert.match(
    between,
    /catch \{\r?\n\s+\$seatDryOut = \$_\.Exception\.Message\r?\n\s+\$seatDryRc = -1/,
  );
});

test("memory-gate: only non-empty arguments reach the launcher (both the dry-run call and the real launch command)", () => {
  for (const name of ["Engine", "Model", "Effort"]) {
    assert.match(
      GATE_APPLIED,
      new RegExp(
        `if \\(\\$${name}\\) \\{ \\$seatOptArr \\+= @\\('-${name}', \\$${name}\\) \\}`,
      ),
      `-${name} must be appended only when non-empty`,
    );
  }
  // the real launch still goes through the canonical wrapper and reuses the same array
  assert.match(
    GATE_APPLIED,
    /\$cmd = '& "D:\\[^"]*orca-worker-seat\.cmd" -Role ' \+ \$Role \+ ' -Worktree "' \+ \$WT \+ '"'\r?\n/,
  );
  assert.match(
    GATE_APPLIED,
    /if \(\$seatOptArr\.Count -gt 0\) \{ \$cmd \+= ' ' \+ \(\$seatOptArr -join ' '\) \}/,
  );
});
