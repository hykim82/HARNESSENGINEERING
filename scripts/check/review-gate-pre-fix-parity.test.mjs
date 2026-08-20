// HYK-314-binding-2: 검토 1R이 반려한 P1 -- "워커가 현재 작업트리의 유효한
// binding-fingerprint를 직접 계산해 공유 캐시(.harness/approved-reviews/
// <id>.md)에 role: REVIEW-* + 승인 판정을 심으면 통과한다"(review-r1-원문.md
// §공격 시도 근거 1) -- 가 HYK-314-binding-1이 만든 **새 회귀**인지, 아니면
// **이 저장소가 이미 갖고 있던 한계**인지를 실측으로 가른다.
//
// 방법: 수리 「전」 판(master ba0eb54, `git show`로 그대로 꺼낸 review-gate.mjs)
// 과 수리 「후」 판(이 워크트리의 현재 review-gate.mjs)에 **동일한 위조**(로컬
// `.harness/review.md`에 `role: REVIEW-CODEX` + `verdict: approved` +
// 워커가 스스로 계산한, 현재 작업트리와 실제로 일치하는 binding-fingerprint를
// 직접 기록)를 가하고 같은 커밋 메시지로 review-gate.mjs CLI를 돌려 종료
// 코드를 비교한다. review-approval-binding.mjs/reject-streak.mjs/
// envelope-archive.mjs/relay-handshake.mjs/time-authority.mjs는 ba0eb54와
// 현재 HEAD 사이에 한 바이트도 바뀌지 않았다(`git diff ba0eb54 HEAD --
// scripts/check/review-approval-binding.mjs ...`로 확인, 0줄) -- 그래서 두
// 판을 가르는 유일한 변수는 review-gate.mjs 자신이다.
//
// 결과(아래 시험이 고정): **두 판 모두 이 위조를 통과시킨다**(exit 0) --
// `hasIndependentReviewer = /role:\s*REVIEW/i.test(content)`는 서명이 아니라
// 텍스트 관례이고, `checkApprovalBinding`은 "그 서명이 진짜 REVIEW 라운드가
// 남긴 것인지"가 아니라 "지금 코드가 review.md에 적힌 지문과 일치하는지"만
// 검증한다 -- 이 두 함수는 HYK-314-binding-1이 손대지 않았다. 그러므로 P1은
// **회귀가 아니라 기존 한계**다(코더 결과 파일 §「최우선」참조, ORCH가 등재
// 여부를 판단한다).
//
// 완전히 저장소 밖 mkdtemp에 매번 새 합성 저장소를 만들어 실행한다 -- 실물
// 관제실·실물 원장은 전혀 건드리지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: HERE,
  encoding: "utf8",
}).trim();
const PRE_FIX_SHA = "ba0eb54242b569d0414bf3f9f07c4f25c66894b9";
const SHARED_DEPS = [
  "relay-handshake.mjs",
  "envelope-archive.mjs",
  "reject-streak.mjs",
  "review-approval-binding.mjs",
  "time-authority.mjs",
];

// ★확인 (이 시험 파일이 성립하는 전제): 위 5개 의존 파일은 ba0eb54와 현재
// HEAD 사이에 한 바이트도 다르지 않다 -- 그래서 "post-fix" 판을 만들 때
// 디스크의 현재 사본을 그대로 써도, ba0eb54 시점 그 파일들과 동일하다.
for (const f of SHARED_DEPS) {
  const diff = execFileSync(
    "git",
    ["diff", PRE_FIX_SHA, "HEAD", "--", `scripts/check/${f}`],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(
    diff,
    "",
    `sanity: scripts/check/${f} must be byte-identical between ${PRE_FIX_SHA} and HEAD for this parity test to be valid`,
  );
}

const PRE_FIX_REVIEW_GATE_SRC = execFileSync(
  "git",
  ["show", `${PRE_FIX_SHA}:scripts/check/review-gate.mjs`],
  { cwd: REPO_ROOT, encoding: "utf8" },
);
const POST_FIX_REVIEW_GATE_SRC = readFileSync(
  join(HERE, "review-gate.mjs"),
  "utf8",
);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Stages a synthetic repo with the given review-gate.mjs source + the
// (byte-identical pre/post) shared deps, commits it so the worktree starts
// CLEAN (a clean worktree binds to HEAD sha per HYK-281 -- this mirrors
// review-r1-원문.md's own probe exactly, no code diff needed to reproduce the
// forgery).
function stageRepo(reviewGateSrc) {
  const dir = tmpDir("hyk314-parity-");
  mkdirSync(join(dir, ".harness"), { recursive: true });
  mkdirSync(join(dir, "scripts", "check"), { recursive: true });
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
  writeFileSync(
    join(dir, "scripts", "check", "review-gate.mjs"),
    reviewGateSrc,
    "utf8",
  );
  for (const f of SHARED_DEPS) {
    writeFileSync(
      join(dir, "scripts", "check", f),
      readFileSync(join(HERE, f), "utf8"),
      "utf8",
    );
  }
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "scaffold",
    "--quiet",
  ]);
  return dir;
}

// Computes the binding-fingerprint block for `dir`'s CURRENT state by
// spawning a tiny helper script against `dir`'s own staged copy of
// review-approval-binding.mjs (never the parent process's import -- the
// staged copy is what the CLI under test will itself load).
function computeBindingBlockFor(dir) {
  const modUrl = pathToFileURL(
    join(dir, "scripts", "check", "review-approval-binding.mjs"),
  ).href;
  const helperPath = join(tmpDir("hyk314-parity-helper-"), "mkbinding.mjs");
  writeFileSync(
    helperPath,
    `const [,, moduleUrl, cwd] = process.argv;
const m = await import(moduleUrl);
const fp = m.computeFingerprint({ cwd });
if (!fp.ok) { console.error(fp.reason); process.exit(1); }
process.stdout.write(m.formatBindingBlock({ fingerprint: fp.fingerprint, entries: fp.entries }));
`,
    "utf8",
  );
  const res = spawnSync(process.execPath, [helperPath, modUrl, dir], {
    encoding: "utf8",
  });
  assert.equal(
    res.status,
    0,
    `binding block computation must succeed: ${res.stderr}`,
  );
  return res.stdout;
}

function writeCommitMsg(subject) {
  const msgDir = tmpDir("hyk314-parity-msg-");
  const p = join(msgDir, "commit-msg.txt");
  writeFileSync(p, `${subject}\n`, "utf8");
  return p;
}

function runReviewGateCli(dir, subject) {
  const commitMsgFile = writeCommitMsg(subject);
  const res = spawnSync(
    process.execPath,
    [join(dir, "scripts", "check", "review-gate.mjs"), commitMsgFile],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  assert.notEqual(res.status, null, "process must not be signal-killed");
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// 실측: 수리 전 판에 REVIEW의 P1 프로브(자기 계산 지문 + role: REVIEW-CODEX
// 로컬 review.md)를 가하면 통과한다 -- «회귀가 아니라 기존 한계»의 직접 증거.
// ---------------------------------------------------------------------------

test("★실측: PRE-FIX(ba0eb54) review-gate.mjs -- 워커가 스스로 계산한 지문 + role: REVIEW-CODEX 로 위조한 로컬 review.md 도 통과한다 (exit 0)", () => {
  const dir = stageRepo(PRE_FIX_REVIEW_GATE_SRC);
  try {
    const binding = computeBindingBlockFor(dir);
    writeFileSync(
      join(dir, ".harness", "review.md"),
      `for: HYK-9800-binding-2\ntask_id: HYK-9800-binding-2\nrole: REVIEW-CODEX\nverdict: approved\n${binding}\n>>> DONE: REVIEW-CODEX @ 2026-08-20 14:30 KST\n`,
      "utf8",
    );
    const run = runReviewGateCli(
      dir,
      "fix(x): HYK-9800-binding-2 -- self-forged local review.md (pre-fix probe)",
    );
    assert.equal(
      run.exit,
      0,
      `PRE-FIX must ALSO accept this forgery (proves it predates HYK-314-binding-1): ${run.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("★실측: POST-FIX(현재) review-gate.mjs -- 같은 위조가 «로컬」 review.md 경로에서도 여전히 통과한다 (exit 0, PRE-FIX와 동등)", () => {
  const dir = stageRepo(POST_FIX_REVIEW_GATE_SRC);
  try {
    const binding = computeBindingBlockFor(dir);
    writeFileSync(
      join(dir, ".harness", "review.md"),
      `for: HYK-9801-binding-2\ntask_id: HYK-9801-binding-2\nrole: REVIEW-CODEX\nverdict: approved\n${binding}\n>>> DONE: REVIEW-CODEX @ 2026-08-20 14:30 KST\n`,
      "utf8",
    );
    const run = runReviewGateCli(
      dir,
      "fix(x): HYK-9801-binding-2 -- self-forged local review.md (post-fix probe)",
    );
    assert.equal(
      run.exit,
      0,
      `POST-FIX local-review.md path must match PRE-FIX exactly: ${run.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★동등성 고정 (§2 do 항목2): PRE-FIX와 POST-FIX가 여러 축에서 정확히 같은
// 판정을 내려야 한다 -- POST-FIX가 어느 축에서든 PRE-FIX보다 «약해지면»
// (즉 PRE-FIX가 막는데 POST-FIX가 통과시키면) 이 시험이 잡는다. 이게 §5
// 변이 검증의 하중점이다 -- checkApprovalBinding 재검증을 무력화하면 D축
// (지문 불일치)에서 POST-FIX만 통과해 버려 이 시험이 RED가 된다(아래 결과
// 파일 §5에 실측 기록).
// ---------------------------------------------------------------------------

function probeExit(reviewGateSrc, { issueId, forge }) {
  const dir = stageRepo(reviewGateSrc);
  try {
    if (forge) forge(dir, issueId);
    const run = runReviewGateCli(dir, `fix(x): ${issueId} -- parity probe`);
    return run.exit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function forgeGenuineApproved(dir, issueId) {
  const binding = computeBindingBlockFor(dir);
  writeFileSync(
    join(dir, ".harness", "review.md"),
    `for: ${issueId}\ntask_id: ${issueId}\nrole: REVIEW-CODEX\nverdict: approved\n${binding}\n>>> DONE: REVIEW-CODEX @ 2026-08-20 14:30 KST\n`,
    "utf8",
  );
}

function forgeFingerprintMismatch(dir, issueId) {
  // A wrong-but-well-formed fingerprint -- simulates "approved, then code
  // drifted" without needing a second commit round.
  const fakeFp = "0".repeat(64);
  const binding = `binding-fingerprint: ${fakeFp}\n\`\`\`binding-entries\n(no changes)\n\`\`\`\n`;
  writeFileSync(
    join(dir, ".harness", "review.md"),
    `for: ${issueId}\ntask_id: ${issueId}\nrole: REVIEW-CODEX\nverdict: approved\n${binding}\n>>> DONE: REVIEW-CODEX @ 2026-08-20 14:30 KST\n`,
    "utf8",
  );
}

const PARITY_AXES = [
  { name: "승인 전무", forge: null, expectPass: false },
  {
    name: "위조 승인(자기계산 지문, role: REVIEW-CODEX)",
    forge: forgeGenuineApproved,
    expectPass: true,
  },
  {
    name: "지문 불일치(승인 후 코드 변경 시뮬레이션)",
    forge: forgeFingerprintMismatch,
    expectPass: false,
  },
];

test("★동등성 고정: PRE-FIX와 POST-FIX는 승인-전무/위조-승인/지문-불일치 세 축에서 정확히 같은 통과·차단 판정을 낸다", () => {
  for (const [i, axis] of PARITY_AXES.entries()) {
    const issueId = `HYK-98${20 + i}-binding-2`;
    const preExit = probeExit(PRE_FIX_REVIEW_GATE_SRC, {
      issueId,
      forge: axis.forge,
    });
    const postExit = probeExit(POST_FIX_REVIEW_GATE_SRC, {
      issueId,
      forge: axis.forge,
    });
    assert.equal(
      preExit === 0,
      axis.expectPass,
      `sanity: PRE-FIX '${axis.name}' expected pass=${axis.expectPass}, got exit=${preExit}`,
    );
    assert.equal(
      postExit,
      preExit,
      `POST-FIX must not diverge from PRE-FIX on axis '${axis.name}' (pre=${preExit}, post=${postExit}) -- a POST-FIX-only pass here would be a NEW regression, not the pre-existing limitation`,
    );
  }
});
