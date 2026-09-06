// ★HYK-448 (coder-task.md §1-§4) -- «영수증이 있는가»에서 «원장이 닫았는가»로
// 옮긴 판정이 ★코어가 아니라 실제 결선 경로(judgeUnconsumedForRepo)에서도
// 그대로 성립하는지 고정한다.
//
// 왜 별도 파일인가: unconsumed-core.test.mjs 는 순수 코어(I/O 0)를 보고,
// 이 파일은 «코어에 넘길 두 관측을 호출자가 제대로 만들어 주는가»를 본다 --
// ⓐ 결과 파일에서 종료 표지를 세고 ⓑ 그 라운드 라벨로 원장 종결을 읽는
// 두 자리다. 코어만 초록이고 이 배선이 없으면 실 운용에서는 아무것도
// 달라지지 않는다.
//
// ⛔격리(coder-task.md §0): 픽스처는 전부 독립 `git init` + mkdtemp 이고,
// 원장·배달영수증 경로는 **그 임시 폴더 안 파일을 opts 로 명시 주입**한다 --
// 전역 원장/영수증/watch 상태에 읽기도 쓰기도 하지 않는다(이 라운드가
// 고치는 코드가 «전역 원장을 읽는» 코드라 특히 조심한 지점).
//
// 픽스처의 수치는 ORCH-60 실측 원문에서 옮긴 것이다:
//   .harness/evidence-448/ORCH-measured-awakening-faces.txt
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
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

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

// 기준 커밋을 표본 시각보다 훨씬 이전으로 고정한다 -- 안 그러면 「지금」
// 만들어진 커밋이 NEW_COMMIT_AFTER 신호로 잡혀 이 시험이 보려는 자리
// (신호 0건)에 도달하지 못한다(unconsumed-receipt-signal.test.mjs 동일 관용구).
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

function setMtime(p, iso) {
  const t = new Date(iso);
  utimesSync(p, t, t);
}

function writeTaskFile(dir, { taskId, mtimeIso }) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  const p = join(dir, ".harness", "coder-task.md");
  writeFileSync(p, `task_id: ${taskId}\n\n본문\n`, "utf8");
  setMtime(p, mtimeIso);
}

// `terminal` = 이 결과 파일이 달고 끝나는 종료 표지. `null`이면 표지가
// 하나도 없는 «아직 안 끝난 라운드»(형태 B)를 만든다.
function writeResultFile(dir, { taskId, mtimeIso, terminal }) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  const p = join(dir, ".harness", "coder.md");
  const tail = terminal === null ? "작업 진행 중\n" : `${terminal}\n`;
  writeFileSync(p, `task_id: ${taskId}\n\n결과 본문\n${tail}`, "utf8");
  setMtime(p, mtimeIso);
}

// admission-ledger-core.mjs 의 completeReservation 이 «닫을 때» 적는 세
// 필드(status/completed_at/completion_reason)만 재현한다.
function writeAdmissionLedger(dir, reservations) {
  const p = join(dir, "admission-ledger.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: "admission-ledger/v1",
      epoch: "2020-01-01T00:00:00Z",
      reservations,
    }),
    "utf8",
  );
  return p;
}

function judgeFor(dir, now, opts = {}) {
  const evidence = collectUnconsumedCandidates(dir);
  assert.equal(evidence.failed, false, "candidate collection must not fail");
  return judgeUnconsumedForRepo(
    { repoRoot: dir, taskFileCandidates: evidence.items, now },
    opts,
  );
}

// ── ORCH-60 실측값 ────────────────────────────────────────────────────────
const FACE_A_RESULT_ISO = "2026-09-05T17:58:29+09:00"; // 중단 종결 결과 파일
const FACE_A_CLOSED_ISO = "2026-09-05T17:58:59+09:00"; // 원장이 그 뒤 닫았다
const FACE_C_CLOSED_ISO = "2026-09-06T23:08:29+09:00"; // 영수증 r10 = 소비 확정
const FACE_C_RESULT_ISO = "2026-09-06T23:11:36+09:00"; // ★그 뒤 워커가 고쳤다
const NOW_ISO = "2026-09-07T02:48:00+09:00"; // 각성이 실제로 발화한 시점대
const NOW_MS = new Date(NOW_ISO).getTime();

test("★HYK-448 배선/형태 A: 중단으로 끝나 영수증이 0개인 워크트리 -- 원장이 닫았다고 말하면 결선 경로가 CONSUMED/CONSUMED_VIA_LEDGER_CLOSURE 로 조용해진다 (RED/GREEN 2/2)", () => {
  withTempDir("hyk448-face-a-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-437-admission-anchor-1";
    writeTaskFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-05T17:00:00+09:00",
    });
    // ⛔영수증 디렉터리를 «만들지 않는다» -- 중단 종결 경로가 설계상
    // 영수증을 안 남기는 바로 그 상태를 그대로 재현한다.
    writeResultFile(dir, {
      taskId: label,
      mtimeIso: FACE_A_RESULT_ISO,
      terminal: ">>> BLOCKED: 러너 초록 미충족, 정지",
    });

    // RED -- 원장을 못 읽는 상태(경로 미주입 == 실 운용에서 env 미설정과 동형).
    // 이것이 «매 주기» 발화하던 판정이다.
    const before = judgeFor(dir, NOW_MS, {});
    assert.equal(before.status, UNCONSUMED_WIRE_STATUS.JUDGED);
    assert.equal(
      before.verdict,
      UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
      "수리 전(원장 없음) 재현: 영수증이 없다는 이유만으로 미소비로 발화",
    );

    // GREEN -- 원장이 그 라운드를 BLOCKED_TERMINATION_RELEASED 로 닫았다.
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: {
        status: "COMPLETED",
        completed_at: FACE_A_CLOSED_ISO,
        completion_reason: "BLOCKED_TERMINATION_RELEASED",
      },
    });
    const after = judgeFor(dir, NOW_MS, { admissionLedgerPath: ledgerPath });
    assert.equal(
      after.verdict,
      UNCONSUMED_VERDICT.CONSUMED,
      "원장이 닫은 라운드는 영수증 파일이 없어도 소비된 것이다",
    );
    assert.equal(
      after.reasonCode,
      UNCONSUMED_REASON.CONSUMED_VIA_LEDGER_CLOSURE,
    );
    assert.equal(
      after.details.completionReason,
      "BLOCKED_TERMINATION_RELEASED",
      "왜 닫혔는지가 판정에 실려 사람이 사유를 볼 수 있어야 한다",
    );
  });
});

test("★HYK-448 배선/형태 B: 아직 안 끝난 라운드(종료 표지 0개) -- 결선 경로가 UNDECIDABLE/ROUND_NOT_FINISHED 로 조용해진다. 같은 파일에 표지를 하나 달면 다시 발화한다 (RED/GREEN 2/2)", () => {
  withTempDir("hyk448-face-b-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-449-marker-count-fence-1";
    writeTaskFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-06T20:10:00+09:00",
    });
    // ★실측: 결과 파일은 갱신되는데 종료 표지가 하나도 없었다.
    writeResultFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-06T21:00:32+09:00",
      terminal: null,
    });
    const now = new Date("2026-09-06T21:29:00+09:00").getTime();

    const inFlight = judgeFor(dir, now, {});
    assert.equal(
      inFlight.verdict,
      UNCONSUMED_VERDICT.UNDECIDABLE,
      "끝나지 않은 라운드는 「미소비」라고 말할 수 없다",
    );
    assert.equal(inFlight.reasonCode, UNCONSUMED_REASON.ROUND_NOT_FINISHED);

    // ★대조군(이게 없으면 「표지를 안 보면 전부 침묵」인지 구별이 안 된다):
    // 같은 픽스처에 종료 표지를 하나 달면 그 라운드는 «끝난» 것이므로
    // 소비 흔적이 없는 한 여전히 발화해야 한다.
    writeResultFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-06T21:00:32+09:00",
      terminal: ">>> DONE: CODER @ 2026-09-06 21:00:32 KST",
    });
    const finished = judgeFor(dir, now, {});
    assert.equal(
      finished.verdict,
      UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
      "끝난 라운드가 소비되지 않았으면 여전히 발화한다(침묵으로 새지 않는다)",
    );
  });
});

test("★★HYK-448 배선/진짜 1건(§1-4): 원장이 «닫은» 라운드라도 결과 파일이 그 뒤에 바뀌었으면 결선 경로가 MODIFIED_AFTER_CLOSURE 로 발화한다 (1/1)", () => {
  withTempDir("hyk448-face-c-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-449-marker-count-fence-1";
    writeTaskFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-06T20:10:00+09:00",
    });
    // 소비가 끝난 «뒤» 워커가 다시 고친 결과 파일(DONE 은 그대로 달려 있다).
    writeResultFile(dir, {
      taskId: label,
      mtimeIso: FACE_C_RESULT_ISO,
      terminal: ">>> DONE: CODER @ 2026-09-06 23:05:00 KST",
    });
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: {
        status: "COMPLETED",
        completed_at: FACE_C_CLOSED_ISO,
        completion_reason: "OK",
      },
    });

    const judged = judgeFor(dir, NOW_MS, { admissionLedgerPath: ledgerPath });
    assert.equal(
      judged.verdict,
      UNCONSUMED_VERDICT.MODIFIED_AFTER_CLOSURE,
      "★이 발화가 사라지면 「소비 후 편집」을 아무도 모른다 -- 원장이 닫았다고 무조건 침묵시키지 않았다는 증거",
    );
    assert.equal(
      judged.reasonCode,
      UNCONSUMED_REASON.RESULT_EDITED_AFTER_CLOSURE,
    );
    assert.equal(
      judged.details.editedAfterClosureMs,
      187_000,
      "실측된 편집 지연(23:08:29 -> 23:11:36 = 187초)이 그대로 실린다",
    );
  });
});

test("★HYK-448 배선/fail-closed: 원장 항목이 있어도 «닫히지 않았거나»(ACTIVE) «completed_at 이 시각이 아니면» 종전대로 발화한다 (2/2)", () => {
  // ⛔모르면 침묵이 아니다 -- 원장이 이상할 때 조용해지면 진짜 미소비를 잃는다.
  for (const [label, entry] of [
    ["ACTIVE", { status: "ACTIVE" }],
    [
      "completed_at 이 파싱 불가",
      { status: "COMPLETED", completed_at: "어제쯤" },
    ],
  ]) {
    withTempDir("hyk448-failclosed-", (dir) => {
      initPlainGitRepo(dir);
      const roundLabel = "HYK-448-failclosed-1";
      writeTaskFile(dir, {
        taskId: roundLabel,
        mtimeIso: "2026-09-05T17:00:00+09:00",
      });
      writeResultFile(dir, {
        taskId: roundLabel,
        mtimeIso: FACE_A_RESULT_ISO,
        terminal: ">>> DONE: CODER @ 2026-09-05 17:58:29 KST",
      });
      const ledgerPath = writeAdmissionLedger(dir, { [roundLabel]: entry });
      const judged = judgeFor(dir, NOW_MS, { admissionLedgerPath: ledgerPath });
      assert.equal(
        judged.verdict,
        UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
        `${label}: 닫혔다는 근거가 못 되면 발화를 유지해야 한다`,
      );
    });
  }
});
