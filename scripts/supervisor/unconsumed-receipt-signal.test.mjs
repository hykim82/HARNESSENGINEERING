// HYK-340-vanished-unresolved (coder-task.md §3) -- «세 번째 소비 흔적
// (소비 완료 영수증)» 결선 계약 시험.
//
// §0 M1 재현: 「마지막 라운드」(결과 파일이 가장 최신 + 그 뒤 새
// task 파일도 새 커밋도 없음)에서, 영수증(.harness/receipts/<role>-
// receipt-r<N>.json)만 결과 파일보다 새것이면 이제 SUSPECTED_UNCONSUMED가
// 아니라 CONSUMED(reasonCode=CONSUMED_VIA_RECEIPT)여야 한다.
//
// 이 계약이 보장하지 않는 것(S11):
// 1. judgeUnconsumed 코어 자신의 3신호/임계 판정 로직은 unconsumed-
//    core.test.mjs가 전담한다 -- 여기는 "영수증 파일 -> 세 번째 신호"
//    결선만 본다.
// 2. consumption-receipt-writer.mjs가 실제로 그 파일을 올바른 모양으로
//    쓰는지는 그 파일 자신의 시험(consumption-receipt-writer.test.mjs)이
//    전담한다 -- 여기는 "파일 하나가 그 자리에 있고 mtime이 새것이면"만
//    가정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  judgeUnconsumedForRepo,
  collectUnconsumedCandidates,
  UNCONSUMED_WIRE_STATUS,
} from "./orch-stall-detect.mjs";
import { UNCONSUMED_VERDICT, UNCONSUMED_REASON } from "./unconsumed-core.mjs";

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function git(cwd, args, env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}
// unconsumed-wire.test.mjs와 동일 이유(기준 커밋을 표본 시각보다 훨씬
// 이전으로 고정 -- 실행 시각의 "지금"이 기준 커밋 신호로 오인되지 않게).
const BASE_COMMIT_DATE = "2020-01-01T00:00:00+09:00";
function initPlainGitRepo(dir) {
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(
    dir,
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-m",
      "base",
      "--quiet",
    ],
    { GIT_AUTHOR_DATE: BASE_COMMIT_DATE, GIT_COMMITTER_DATE: BASE_COMMIT_DATE },
  );
}
function writeTaskFile(dir, { name = "coder-task.md", taskId, mtimeIso }) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  const p = join(dir, ".harness", name);
  writeFileSync(p, `task_id: ${taskId}\n\n본문\n`, "utf8");
  const t = new Date(mtimeIso);
  utimesSync(p, t, t);
}
function writeResultFileAt(dir, { name = "coder.md", updatedAtIso }) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  const p = join(dir, ".harness", name);
  writeFileSync(p, "결과 본문\n>>> DONE: CODER @ test\n", "utf8");
  const t = new Date(updatedAtIso);
  utimesSync(p, t, t);
}
function writeReceiptAt(dir, { role, round = 1, mtimeIso }) {
  const receiptsDir = join(dir, ".harness", "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  const p = join(receiptsDir, `${role}-receipt-r${round}.json`);
  writeFileSync(p, JSON.stringify({ binding: {}, effects: {} }), "utf8");
  const t = new Date(mtimeIso);
  utimesSync(p, t, t);
}
function judgeFor(dir, now) {
  const evidence = collectUnconsumedCandidates(dir);
  assert.equal(evidence.failed, false, "candidate collection must not fail");
  return judgeUnconsumedForRepo({
    repoRoot: dir,
    taskFileCandidates: evidence.items,
    now,
  });
}

// ---------------------------------------------------------------------------
// (1) §0 M1 재현: 마지막 라운드 + 영수증이 결과 파일보다 새것 -> CONSUMED
// via CONSUMED_VIA_RECEIPT (요구1).
// ---------------------------------------------------------------------------
test("HYK-340: 마지막 라운드에서 소비 영수증(coder-receipt-r1.json)이 결과 파일보다 새것이면 -- SUSPECTED_UNCONSUMED가 아니라 CONSUMED/CONSUMED_VIA_RECEIPT (1/1)", () => {
  withTempDir("hyk340-receipt-consumed-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-340-t",
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:15:00Z" });
    const now = new Date("2026-08-24T01:00:00Z").getTime(); // 임계(900초) 훌쩍 초과
    const result = judgeFor(dir, now);
    assert.equal(result.status, UNCONSUMED_WIRE_STATUS.JUDGED);
    assert.equal(result.verdict, UNCONSUMED_VERDICT.CONSUMED);
    assert.equal(result.reasonCode, UNCONSUMED_REASON.CONSUMED_VIA_RECEIPT);
  });
});

// ---------------------------------------------------------------------------
// (2) 340 회귀: 영수증이 없는 진짜 미소비는 여전히 SUSPECTED_UNCONSUMED
// (요구2 -- 오탐 반대 방향인 위양성 방지가 아니라, 새 신호가 없다고
// 기존 판정을 조용히 CONSUMED로 낙관하지 않는지 확인).
// ---------------------------------------------------------------------------
test("HYK-340 회귀: 영수증도 다른 소비 흔적도 전혀 없으면 -- 임계 초과 후 여전히 SUSPECTED_UNCONSUMED (1/1)", () => {
  withTempDir("hyk340-no-evidence-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-340-t2",
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now);
    assert.equal(result.status, UNCONSUMED_WIRE_STATUS.JUDGED);
    assert.equal(result.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (3) 영수증이 결과 파일보다 "이전"(정상적인 이전 라운드 잔재)이면 신호가
// 아니다 -- 여전히 SUSPECTED_UNCONSUMED(§2 unconsumed-core.mjs의 기존
// SIGNAL_BEFORE_RESULT 원칙과 동형).
// ---------------------------------------------------------------------------
test("HYK-340: 영수증이 결과 파일보다 이전(이전 라운드 잔재)이면 신호로 인정되지 않는다 -- SUSPECTED_UNCONSUMED 그대로 (1/1)", () => {
  withTempDir("hyk340-stale-receipt-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-340-t3",
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:05:00Z" });
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now);
    assert.equal(result.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (4) 다른 role의 영수증은 무시된다(예: review-receipt-r1.json이 새것이어도
// coder 결과를 소비한 증거로 오인하지 않는다).
// ---------------------------------------------------------------------------
test("HYK-340: 다른 role의 영수증(review-receipt-r1.json)은 coder 결과의 소비 흔적으로 인정되지 않는다 (1/1)", () => {
  withTempDir("hyk340-wrong-role-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-340-t4",
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    writeReceiptAt(dir, { role: "review", mtimeIso: "2026-08-24T00:15:00Z" });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now);
    assert.equal(result.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (5) 대소문자 무관 매칭: consumption-receipt-writer.mjs는 role을 호출자
// 표기 그대로 파일명에 쓴다(binding.role만 대문자로 정규화, 파일명 자체는
// 안 바뀐다) -- 실 운용에서 "CODER-receipt-r1.json"(대문자)가 생길 수
// 있으므로, task 파일 이름 관례의 소문자 role("coder")과도 대소문자
// 무관으로 매칭돼야 한다(consumption-receipt-writer.mjs의 nextReceiptFileName
// 과 동일 계약, 그 파일 60-72행 주석 참조).
// ---------------------------------------------------------------------------
test("HYK-340: 대문자 CODER-receipt-r1.json도 role='coder' task 파일의 소비 흔적으로 인정된다(대소문자 무관, Windows 실 운용 관례) (1/1)", () => {
  withTempDir("hyk340-case-insensitive-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-340-t5",
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    writeReceiptAt(dir, { role: "CODER", mtimeIso: "2026-08-24T00:15:00Z" });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now);
    assert.equal(result.verdict, UNCONSUMED_VERDICT.CONSUMED);
    assert.equal(result.reasonCode, UNCONSUMED_REASON.CONSUMED_VIA_RECEIPT);
  });
});

// ---------------------------------------------------------------------------
// (6) receipts 디렉터리 자체가 아직 없음(정상 -- 첫 라운드) -> 판정불가로
// 닫히지 않고 그냥 "영수증 신호 없음"으로 계속 판정한다.
// ---------------------------------------------------------------------------
test("HYK-340: .harness/receipts 디렉터리가 아예 없어도(정상, 첫 라운드) 판정불가(COLLECTION_FAILED)로 닫히지 않는다 (1/1)", () => {
  withTempDir("hyk340-no-receipts-dir-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-340-t6",
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    const now = new Date("2026-08-24T00:20:00Z").getTime(); // 임계 이내
    const result = judgeFor(dir, now);
    assert.equal(result.status, UNCONSUMED_WIRE_STATUS.JUDGED);
    assert.equal(result.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
  });
});

// ---------------------------------------------------------------------------
// (7) receipts 디렉터리 읽기 자체가 실패(ENOENT 아닌 다른 오류)하면
// 판정불가(COLLECTION_FAILED)로 닫힌다 -- "영수증 없음"으로 뭉개지 않는다
// (§3 코어 헤더 "판정할 수 없으면 조용히 정상으로 접지 않는다"와 동형).
// ---------------------------------------------------------------------------
test("HYK-340: receipts 디렉터리 조회 자체가 실패(EACCES 등)하면 -- '영수증 없음'으로 뭉개지 않고 COLLECTION_FAILED로 닫힌다 (1/1)", () => {
  withTempDir("hyk340-receipts-read-fail-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-340-t7",
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const evidence = collectUnconsumedCandidates(dir);
    const result = judgeUnconsumedForRepo(
      { repoRoot: dir, taskFileCandidates: evidence.items, now },
      {
        receiptsReaddirFn: () => {
          const err = new Error("permission denied");
          err.code = "EACCES";
          throw err;
        },
      },
    );
    assert.equal(result.status, UNCONSUMED_WIRE_STATUS.COLLECTION_FAILED);
    assert.match(result.reason, /receipts/);
  });
});
