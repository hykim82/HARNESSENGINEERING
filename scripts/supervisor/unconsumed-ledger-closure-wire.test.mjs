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
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  judgeUnconsumedForRepo,
  judgeUnconsumedAcrossWorktrees,
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

// ★HYK-448 2R: 소비 영수증의 실물 모양 중 이 축이 읽는 필드 하나만 재현한다
// (consumption-receipt-writer.mjs 의 binding.resultFingerprint).
function writeReceipt(
  dir,
  { role = "CODER", round = 1, fingerprint, mtimeIso },
) {
  const receiptsDir = join(dir, ".harness", "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  const p = join(receiptsDir, `${role}-receipt-r${round}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      binding: { resultFingerprint: fingerprint },
      effects: {},
    }),
    "utf8",
  );
  setMtime(p, mtimeIso);
  return p;
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

test("★HYK-448 2R 배선/형태 A: 중단 종결 워크트리는 여전히 «발화하지 않는다» -- 다만 판정 이름은 CONSUMED 가 아니라 UNDECIDABLE/CLOSURE_ORDER_UNPROVABLE 다 (RED/GREEN 2/2)", () => {
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
    // ★2R(검토 1R P1): 1R 은 여기서 CONSUMED 를 냈다. 그러려면
    // «파일시계 < 원장시계»라는 순서 단정이 필요한데, 두 값의 출처가
    // 다르므로 그 단정 자체가 결함이었다. 이제는 판정 불가다.
    assert.equal(
      after.verdict,
      UNCONSUMED_VERDICT.UNDECIDABLE,
      "서로 다른 시계로는 «결과가 종결보다 앞섬»을 증명할 수 없다",
    );
    assert.equal(after.reasonCode, UNCONSUMED_REASON.CLOSURE_ORDER_UNPROVABLE);
    // ★★그리고 그것이 «상시 오탐 부활»이 아님을 결선 수준에서
    // 직접 보인다: 각성이 워크트리 이름을 실는 자리가 비어 있어야 한다.
    const scan = judgeUnconsumedAcrossWorktrees(
      { repoRoot: dir, now: NOW_MS },
      { admissionLedgerPath: ledgerPath },
    );
    assert.deepEqual(
      scan.worstWorktreePaths,
      [],
      "UNDECIDABLE 은 발화 등급이 아니므로 각성은 이 워크트리를 지목하지 않는다(형태 A 침묵 유지)",
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

// ===========================================================================
// ★HYK-448 2R -- 시계를 «전혀» 비교하지 않는 축이 결선 경로에서 실제로 도는가.
// 검토 1R P1 경계표 2행(«종결 후 수정인데 파일시계가 뒤로 보임»)은 시계만으로
// 닫을 수 없다. 이 축이 그 자리를 닫는다.
// ===========================================================================

test("★★HYK-448 2R 배선/지문 축: 파일시계가 «뒤로» 보여 시계 축이 판정 불가인 입력에서도, 영수증 지문이 갈리면 결선 경로가 MODIFIED_AFTER_CLOSURE 로 발화한다 (RED/GREEN 2/2)", () => {
  withTempDir("hyk448-fp-wire-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-449-marker-count-fence-1";
    writeTaskFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-06T20:10:00+09:00",
    });
    // ★결과 파일의 mtime 을 «종결보다 이르게» 둔다 -- 시계 축만으로는
    // 판정 불가가 한계인 바로 그 입력이다.
    writeResultFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-06T23:07:59+09:00",
      terminal: ">>> DONE: CODER @ 2026-09-06 23:05:00 KST",
    });
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: {
        status: "COMPLETED",
        completed_at: FACE_C_CLOSED_ISO,
        completion_reason: "OK",
      },
    });

    // RED -- 지문 축이 없으면(영수증 없음) 시계 축의 한계 그대로 판정 불가.
    const noReceipt = judgeFor(dir, NOW_MS, {
      admissionLedgerPath: ledgerPath,
    });
    assert.equal(
      noReceipt.verdict,
      UNCONSUMED_VERDICT.UNDECIDABLE,
      "시계만으로는 «앞선 것처럼 보이는» 이 입력을 종결 후 수정으로 단정할 수 없다",
    );
    assert.equal(
      noReceipt.reasonCode,
      UNCONSUMED_REASON.CLOSURE_ORDER_UNPROVABLE,
    );

    // GREEN -- 소비 시점 지문이 «지금» 파일과 다르다 = 종결 후 수정.
    writeReceipt(dir, {
      fingerprint:
        "a0a8014eaf59b050d57edafce0648139f1456724dabf669056782c24a8ffb6f1",
      mtimeIso: "2026-09-06T23:00:00+09:00",
    });
    const diverged = judgeFor(dir, NOW_MS, {
      admissionLedgerPath: ledgerPath,
    });
    assert.equal(
      diverged.verdict,
      UNCONSUMED_VERDICT.MODIFIED_AFTER_CLOSURE,
      "★시계를 한 번도 비교하지 않고 «바뀌었다»를 말한다",
    );
    assert.equal(
      diverged.reasonCode,
      UNCONSUMED_REASON.RESULT_FINGERPRINT_DIVERGED,
    );
    // 각성이 이 워크트리를 실제로 지목하는지까지 확인한다(발화 등급).
    const scan = judgeUnconsumedAcrossWorktrees(
      { repoRoot: dir, now: NOW_MS },
      { admissionLedgerPath: ledgerPath },
    );
    assert.deepEqual(scan.worstWorktreePaths.length, 1);
  });
});

test("★★HYK-448 2R 배선/지문 축은 «발화 전용»: 영수증 지문이 실제 파일과 «일치»해도 침묵으로 가지 않는다 -- 위조로 발화를 지울 수 없다 (2/2)", () => {
  withTempDir("hyk448-fp-forge-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-449-marker-count-fence-1";
    writeTaskFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-06T20:10:00+09:00",
    });
    writeResultFile(dir, {
      taskId: label,
      mtimeIso: FACE_C_RESULT_ISO, // 종결 «뒤» -- 시계 축이 발화하는 입력.
      terminal: ">>> DONE: CODER @ 2026-09-06 23:05:00 KST",
    });
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: {
        status: "COMPLETED",
        completed_at: FACE_C_CLOSED_ISO,
        completion_reason: "OK",
      },
    });
    // ★워커가 결과를 고친 뒤 영수증 지문도 «현재 파일에 맞춰» 고쳐 넣은 상황.
    const actual = createHash("sha256")
      .update(readFileSync(join(dir, ".harness", "coder.md"), "utf8"), "utf8")
      .digest("hex");
    writeReceipt(dir, {
      fingerprint: actual,
      mtimeIso: "2026-09-06T23:00:00+09:00",
    });

    const judged = judgeFor(dir, NOW_MS, { admissionLedgerPath: ledgerPath });
    assert.equal(
      judged.verdict,
      UNCONSUMED_VERDICT.MODIFIED_AFTER_CLOSURE,
      "지문 일치가 시계 축의 발화를 지우면 안 된다(발화 전용 계약)",
    );
    assert.equal(
      judged.reasonCode,
      UNCONSUMED_REASON.RESULT_EDITED_AFTER_CLOSURE,
      "지문이 같으면 그 축은 «없는 것»이고 시계 축 결과가 그대로 나온다",
    );
  });
});
