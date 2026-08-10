// HYK-186 2R §3ⓐ -- 완료조건7은 양수 조건이다: "최소 1개 비Claude 실제
// 경로가 동일 future/우회 negative-control을 차단한다." 이 저장소에서
// 비Claude 엔진 = codex 좌석의 REVIEW/VERIFY 완료 경로(scripts/relay/
// codex-adapter.mjs가 그 좌석을 기동한다). ★그 완료 경로가 최종적으로
// 판정받는 지점은 CODER와 완전히 동일한 프로덕션 진입점이다 --
// relay-handshake.mjs/watch-result.mjs는 애초에 어떤 엔진이 결과 파일을
// 썼는지 구분하는 코드 경로가 0개다(role 문자열만 받는다, "coder"든
// "review"든 "verify"든 같은 파서·같은 상한 검사를 거친다). 이 시험은
// Claude 전용 어댑터를 흉내 낸 대역이 아니라, role="review"/"verify"로
// 그 프로덕션 진입점을 직접 구동해 이 사실을 실측으로 고정한다.
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
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_CLI = join(HERE, "relay-handshake.mjs");
const WATCH_RESULT_CLI = join(HERE, "..", "relay", "watch-result.mjs");
const RELAY_HANDSHAKE_PATH = RELAY_HANDSHAKE_CLI;
const TIME_AUTHORITY_PATH = join(HERE, "time-authority.mjs");
const REJECT_STREAK_PATH = join(HERE, "reject-streak.mjs");
const ENVELOPE_ARCHIVE_PATH = join(HERE, "envelope-archive.mjs");

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nc-codex-lane-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(scriptPath, args) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
  });
  assert.equal(res.error, undefined, `spawn must succeed: ${res.error?.message}`);
  assert.notEqual(res.status, null, "process must not be signal-killed");
  return { exit: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// codex REVIEW seat's own DONE-line convention (role-tagged label, see
// hyk183-ledger-fix-mutation.test.mjs's own fixtures: "REVIEW-CODEX").
function writeCodexReviewFixture(dir, { droppedAt, doneAt }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "review-task.md"),
    `task_id: HYK-9186-codex\ndropped_at: ${droppedAt}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "review.md"),
    `task_id: HYK-9186-codex\n\n>>> DONE: REVIEW-CODEX @ ${doneAt}\n`,
    "utf8",
  );
}

test("codex REVIEW lane, production CLI (relay-handshake.mjs review <dir>): now+상한+1분 -> blocked, state=FUTURE_DONE", () => {
  withDir((dir) => {
    writeCodexReviewFixture(dir, {
      droppedAt: "2026-08-01 00:00 KST",
      doneAt: "2099-01-01 00:00 KST",
    });
    const res = runCli(RELAY_HANDSHAKE_CLI, ["review", dir]);
    assert.notEqual(res.exit, 0, "the codex REVIEW lane's own result file must be blocked by the SAME upper bound as CODER's");
    assert.match(res.stderr, /ahead of authority now/);
  });
});

test("codex REVIEW lane, boundary control: DONE well within the past -> passes (positive control, same CLI, same role)", () => {
  withDir((dir) => {
    writeCodexReviewFixture(dir, {
      droppedAt: "2026-08-01 00:00 KST",
      doneAt: "2026-08-01 00:10 KST",
    });
    const res = runCli(RELAY_HANDSHAKE_CLI, ["review", dir]);
    assert.equal(res.exit, 0, "a genuinely normal codex REVIEW result must still pass -- optimization is 0/N false positives here too");
  });
});

test("codex VERIFY lane, production CLI: same future-block fires for role=verify too (not a coder-only code path)", () => {
  withDir((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "verify-task.md"),
      "task_id: HYK-9186-codex-v\ndropped_at: 2026-08-01 00:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "verify.md"),
      "task_id: HYK-9186-codex-v\n\n>>> DONE: VERIFY-CODEX @ 2099-01-01 00:00 KST\n",
      "utf8",
    );
    const res = runCli(RELAY_HANDSHAKE_CLI, ["verify", dir]);
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /ahead of authority now/);
  });
});

// watch-result.mjs's own EXIT_FUTURE_REJECTED(7), driven for the codex lane.
test("codex REVIEW lane, production CLI (watch-result.mjs --role review): future DONE -> exit 7 (EXIT_FUTURE_REJECTED), same wiring as CODER's", () => {
  withDir((dir) => {
    writeCodexReviewFixture(dir, {
      droppedAt: "2026-08-01 00:00 KST",
      doneAt: "2099-01-01 00:00 KST",
    });
    const res = runCli(WATCH_RESULT_CLI, [
      "--role",
      "review",
      "--harness-dir",
      dir,
      "--max-wait-s",
      "1",
    ]);
    assert.equal(res.exit, 7);
    assert.match(res.stderr, /WATCH_FUTURE_REJECTED: FUTURE_DONE/);
  });
});

// ---------------------------------------------------------------------------
// §5 변조2 (codex 경로 확장) -- 상한 검사 제거 시 codex REVIEW 경로에서도
// 미래 시각이 다시 통과하는지 실측. hyk186-time-authority-mutation.test.mjs
// 의 mutation 2와 같은 변조(같은 코드 경로가 role-agnostic이므로)를,
// role="review" 입력으로 별도 고정한다 -- "coder 경로만 우연히 잡혔다"는
// 의심을 이 자리에서 직접 닫는다.
// ---------------------------------------------------------------------------
function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

function stageMutantTree(mutatedRelaySrc) {
  const root = mkdtempSync(join(tmpdir(), "nc-codex-lane-mut-"));
  const checkDir = join(root, "scripts", "check");
  mkdirSync(checkDir, { recursive: true });
  writeFileSync(join(checkDir, "relay-handshake.mjs"), mutatedRelaySrc, "utf8");
  writeFileSync(
    join(checkDir, "time-authority.mjs"),
    readFileSync(TIME_AUTHORITY_PATH, "utf8"),
    "utf8",
  );
  writeFileSync(
    join(checkDir, "reject-streak.mjs"),
    readFileSync(REJECT_STREAK_PATH, "utf8"),
    "utf8",
  );
  writeFileSync(
    join(checkDir, "envelope-archive.mjs"),
    readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8"),
    "utf8",
  );
  return join(checkDir, "relay-handshake.mjs");
}

test("mutation (§5 변조2, codex 경로 고정): future-skew 호출 제거 -> codex REVIEW 결과의 미래 DONE이 다시 통과 -> RED", () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  const doneFuture = checkFutureSkew({\n    candidateDate: doneAt,\n    rawText: doneMatch[1],\n    field: TIME_FIELD.RESULT_DONE_AT,\n    now,\n  });\n  if (doneFuture) return doneFuture;\n";
  assertExactlyOneMatch(src, target, "doneFuture checkFutureSkew call site");
  const mutantPath = stageMutantTree(src.replace(target, ""));

  withDir((dir) => {
    writeCodexReviewFixture(dir, {
      droppedAt: "2026-08-01 00:00 KST",
      doneAt: "2099-01-01 00:00 KST",
    });
    const res = runCli(mutantPath, ["review", dir]);
    assert.equal(
      res.exit,
      0,
      "RED: with the future check removed, the codex REVIEW lane's own future-dated DONE passes again -- same shape as the CODER-lane repro, proving this is not a coder-only branch",
    );
  });
});
