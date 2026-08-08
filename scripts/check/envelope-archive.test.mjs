// HYK-204 1R: 워커 봉투(`.harness/<role>.md`)는 라운드마다 덮어쓴다 -- 이
// 모듈은 그 원문을 라운드별로 별도 파일에 복제해 남긴다. §3-2 착수
// 기준(§5)의 핵심 실측: 같은 트랙에서 라운드 2회를 돌리면 두 라운드
// 원문이 각각 남아 있어야 한다(지금은 마지막 것만 남는다).
//
// ⛔합성 fixture만 쓴다 -- 실제 `.harness`는 절대 건드리지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import {
  archiveRoundEnvelope,
  nextArchiveFileName,
} from "./envelope-archive.mjs";
import { checkRelayHandshake } from "./relay-handshake.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW_GATE_CLI = join(HERE, "review-gate.mjs");

function withFixtureDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// pure: nextArchiveFileName
// ---------------------------------------------------------------------------

test("nextArchiveFileName: empty archive dir -> round 1", () => {
  assert.equal(nextArchiveFileName("coder", []), "coder-r1.md");
});

test("nextArchiveFileName: existing r1 -> next is r2 (never reuses r1)", () => {
  assert.equal(nextArchiveFileName("coder", ["coder-r1.md"]), "coder-r2.md");
});

test("nextArchiveFileName: only counts files for THIS role -- a sibling role's files never bump the counter", () => {
  assert.equal(
    nextArchiveFileName("coder", ["review-r1.md", "review-r2.md"]),
    "coder-r1.md",
  );
});

test("nextArchiveFileName: a gap (r1 deleted, r2 present) still advances past the max -- never reuses a past round number", () => {
  assert.equal(nextArchiveFileName("coder", ["coder-r2.md"]), "coder-r3.md");
});

// ---------------------------------------------------------------------------
// archiveRoundEnvelope: fs-backed behavior
// ---------------------------------------------------------------------------

test("archiveRoundEnvelope: writes a verbatim copy under <harnessDir>/rounds/<role>-r1.md", () => {
  withFixtureDir("envelope-archive-basic-", (dir) => {
    const content =
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-08 06:10 KST\n";
    const outcome = archiveRoundEnvelope({
      role: "coder",
      resultContent: content,
      harnessDir: dir,
    });
    assert.equal(outcome.ok, true);
    const written = readFileSync(join(dir, "rounds", "coder-r1.md"), "utf8");
    assert.ok(
      written.includes(content),
      "archived file must contain the round's actual content, not just exist",
    );
  });
});

test("archiveRoundEnvelope: <role>.md itself is never touched -- preservation is additive only, the envelope contract is unchanged", () => {
  withFixtureDir("envelope-archive-contract-", (dir) => {
    const resultPath = join(dir, "coder.md");
    const content =
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-08 06:10 KST\n";
    writeFileSync(resultPath, content, "utf8");
    archiveRoundEnvelope({
      role: "coder",
      resultContent: content,
      harnessDir: dir,
    });
    assert.equal(readFileSync(resultPath, "utf8"), content);
  });
});

test("archiveRoundEnvelope: two rounds for the same role -> BOTH original texts survive, each in its own file (core §3-2 실측)", () => {
  withFixtureDir("envelope-archive-two-rounds-", (dir) => {
    const round1 =
      "task_id: HYK-204\nverdict: rejected\n\n>>> DONE: REVIEW-CODEX @ 2026-08-08 06:00 KST\n";
    const round2 =
      "task_id: HYK-204\nverdict: approved\n\n>>> DONE: REVIEW-CODEX @ 2026-08-08 07:00 KST\n";

    const r1 = archiveRoundEnvelope({
      role: "review",
      resultContent: round1,
      harnessDir: dir,
    });
    const r2 = archiveRoundEnvelope({
      role: "review",
      resultContent: round2,
      harnessDir: dir,
    });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.notEqual(
      r1.path,
      r2.path,
      "round 1 and round 2 must land on distinct files",
    );

    const files = readdirSync(join(dir, "rounds"));
    assert.deepEqual(files.sort(), ["review-r1.md", "review-r2.md"]);

    const stored1 = readFileSync(join(dir, "rounds", "review-r1.md"), "utf8");
    const stored2 = readFileSync(join(dir, "rounds", "review-r2.md"), "utf8");
    assert.ok(stored1.includes(round1) && stored1.includes("rejected"));
    assert.ok(stored2.includes(round2) && stored2.includes("approved"));
  });
});

test("archiveRoundEnvelope: role missing -> ok:false, never throws", () => {
  withFixtureDir("envelope-archive-bad-role-", (dir) => {
    const outcome = archiveRoundEnvelope({
      role: "",
      resultContent: "x",
      harnessDir: dir,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /role missing/);
  });
});

// ---------------------------------------------------------------------------
// wiring: checkRelayHandshake (CODER + rejected-then-rechecked REVIEW path)
// ---------------------------------------------------------------------------

function writeTask(dir, role, taskId, droppedAt) {
  writeFileSync(
    join(dir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: ${droppedAt}\n`,
    "utf8",
  );
}

function writeResult(dir, role, taskId, doneAt, extra = "") {
  writeFileSync(
    join(dir, `${role}.md`),
    `task_id: ${taskId}\n${extra}\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`,
    "utf8",
  );
}

test("wiring: checkRelayHandshake ok -> archives the round AND still returns the same pass/fail contract as before (regression 0)", () => {
  withFixtureDir("relay-wiring-", (dir) => {
    writeTask(dir, "coder", "HYK-204", "2026-08-08 06:00 KST");
    writeResult(dir, "coder", "HYK-204", "2026-08-08 06:10 KST");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "relay handshake ok for HYK-204");
    assert.equal(
      readFileSync(join(dir, "rounds", "coder-r1.md"), "utf8").includes(
        "HYK-204",
      ),
      true,
    );
  });
});

test("wiring: checkRelayHandshake blocked (mismatch) -> no archive is written -- only CONFIRMED rounds are preserved", () => {
  withFixtureDir("relay-wiring-blocked-", (dir) => {
    writeTask(dir, "coder", "HYK-204", "2026-08-08 06:00 KST");
    writeResult(dir, "coder", "HYK-WRONG", "2026-08-08 06:10 KST");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(dir, "rounds")), false);
  });
});

// NOTE: these fixtures deliberately never write a real `verdict: approved`/
// `verdict: rejected` line. Role "review" makes reject-streak.mjs's own
// isReviewFamilyRole(role) true, and that module's ledger path is NOT
// injectable -- mainRepoRoot() always resolves THIS machine's actual main
// repo, not this test's mkdtemp fixture. A genuine verdict line here would
// silently write a synthetic entry into the REAL production
// `.harness/reject-streak.json`, exactly the "실제 .harness를 어지럽히지
// 마라" rule this suite must never violate (a 2026-08-08 실측 mistake this
// very track made and had to clean up by hand). An "outcome-note:" line
// keeps the round content distinguishable while parseReviewOutcome's own
// verdict-line requirement fails closed, so no write is ever attempted.
test("wiring: same track, two rounds re-checked via checkRelayHandshake -> both round texts survive under harnessDir/rounds (§5 착수 기준 그대로)", () => {
  withFixtureDir("relay-wiring-two-rounds-", (dir) => {
    // Round 1: rejected review, re-checked once ORCH re-verifies the
    // handshake for "다음 라운드" (relay-handshake.mjs's own comment on
    // why its auto-record wiring lives here).
    writeTask(dir, "review", "HYK-204", "2026-08-08 06:00 KST");
    writeResult(
      dir,
      "review",
      "HYK-204",
      "2026-08-08 06:10 KST",
      "outcome-note: needs-rework\n",
    );
    const first = checkRelayHandshake({ role: "review", harnessDir: dir });
    assert.equal(first.ok, true);

    // Round 2: same track, task file re-dropped for the next review pass,
    // result overwritten -- this overwrite is exactly what used to erase
    // round 1's text.
    writeTask(dir, "review", "HYK-204", "2026-08-08 07:00 KST");
    writeResult(
      dir,
      "review",
      "HYK-204",
      "2026-08-08 07:10 KST",
      "outcome-note: looks-good\n",
    );
    const second = checkRelayHandshake({ role: "review", harnessDir: dir });
    assert.equal(second.ok, true);

    const files = readdirSync(join(dir, "rounds")).sort();
    assert.deepEqual(files, ["review-r1.md", "review-r2.md"]);
    assert.match(
      readFileSync(join(dir, "rounds", "review-r1.md"), "utf8"),
      /needs-rework/,
    );
    assert.match(
      readFileSync(join(dir, "rounds", "review-r2.md"), "utf8"),
      /looks-good/,
    );
  });
});

// ---------------------------------------------------------------------------
// wiring: review-gate.mjs's commit-msg hook (the APPROVED terminal round --
// never re-checked by relay-handshake since there is no "next round")
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initPlainGitRepo(dir) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-m",
    "base",
    "--quiet",
  ]);
}

function runCli(scriptPath, args, opts = {}) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    ...opts,
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("wiring: review-gate.mjs commit-msg hook archives the APPROVED (winning, terminal) round -- the one round relay-handshake never re-checks", () => {
  withFixtureDir("review-gate-wiring-", (dir) => {
    initPlainGitRepo(dir);
    writeFileSync(
      join(dir, ".harness", "review.md"),
      "for: HYK-9800\ntask_id: HYK-9800\nrole: REVIEW-CODEX\nverdict: approved\n\n>>> DONE: REVIEW-CODEX @ 2026-08-08 12:00 KST\n",
      "utf8",
    );
    const commitMsgFile = join(dir, "commit-msg.txt");
    writeFileSync(commitMsgFile, "fix(check): HYK-9800 -- something\n", "utf8");

    const result = runCli(REVIEW_GATE_CLI, [commitMsgFile], { cwd: dir });
    assert.equal(result.exit, 0);
    const archived = readFileSync(
      join(dir, ".harness", "rounds", "review-r1.md"),
      "utf8",
    );
    assert.match(archived, /HYK-9800/);
    assert.match(archived, /verdict: approved/);
  });
});
