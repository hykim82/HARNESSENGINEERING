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
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR_WIRE = dirname(fileURLToPath(import.meta.url));
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  judgeUnconsumedForRepo,
  judgeUnconsumedAcrossWorktrees,
  collectUnconsumedCandidates,
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

// ★HYK-448 3R: 중단 기록의 실물 모양 중 이 축이 읽는 필드만 재현한다
// (relay-handshake.mjs 가 spawnAbortRecordWriter 로 남기는 leftoverFingerprint).
function writeAbortRecord(
  dir,
  { role = "CODER", round = 1, leftoverFingerprint, mtimeIso },
) {
  const abortsDir = join(dir, ".harness", "aborts");
  mkdirSync(abortsDir, { recursive: true });
  const p = join(abortsDir, `${role}-abort-r${round}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      role,
      leftoverFingerprint,
      leftoverPath: ".harness\\coder.md",
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

test("★★HYK-448 3R 배선/형태 A ① «증거로» 조용해진다: 중단 기록의 leftoverFingerprint 가 현재 파일과 일치하면 CONSUMED_VIA_FINGERPRINT_MATCH (RED/GREEN 2/2)", () => {
  withTempDir("hyk448-face-a-evidence-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-437-admission-anchor-1";
    writeTaskFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-05T17:00:00+09:00",
    });
    // ⛔소비 영수증은 «없다» -- 중단 종결의 실제 모양이다.
    writeResultFile(dir, {
      taskId: label,
      mtimeIso: FACE_A_RESULT_ISO,
      terminal: ">>> BLOCKED: 러너 초록 미충족, 정지",
    });
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: {
        status: "COMPLETED",
        completed_at: FACE_A_CLOSED_ISO,
        completion_reason: "BLOCKED_TERMINATION_RELEASED",
      },
    });

    // RED -- 중단 기록이 없으면 증거가 없어 «순서 미증명» 이고,
    // ★5R 승격 덕분에 그것은 이제 «발화»다(사람에게 도달한다).
    const noEvidence = judgeFor(dir, NOW_MS, {
      admissionLedgerPath: ledgerPath,
    });
    assert.equal(
      noEvidence.reasonCode,
      UNCONSUMED_REASON.CLOSURE_ORDER_UNPROVABLE,
      "증거가 없으면 침묵하지 않는다",
    );
    const noEvidenceScan = judgeUnconsumedAcrossWorktrees(
      { repoRoot: dir, now: NOW_MS },
      { admissionLedgerPath: ledgerPath },
    );
    assert.equal(
      noEvidenceScan.worstWorktreePaths.length,
      1,
      "★증거 없는 «순서 미증명» 은 이제 사람에게 도달한다(검토 2R P1 해소)",
    );

    // GREEN -- 중단 기록의 지문을 «현재 파일 그대로» 넣는다
    // (= 종결 이후 안 바뀜다는 증거). ★이것이 실물 형태 A 다.
    const liveFingerprint = createHash("sha256")
      .update(readFileSync(join(dir, ".harness", "coder.md"), "utf8"), "utf8")
      .digest("hex");
    writeAbortRecord(dir, {
      leftoverFingerprint: liveFingerprint,
      mtimeIso: FACE_A_CLOSED_ISO,
    });

    const withEvidence = judgeFor(dir, NOW_MS, {
      admissionLedgerPath: ledgerPath,
    });
    assert.equal(
      withEvidence.verdict,
      UNCONSUMED_VERDICT.CONSUMED,
      "★중단 종결도 지문을 남긴다 -- «지문 축이 부재»라는 두 라운드의 전제가 틀렸다",
    );
    assert.equal(
      withEvidence.reasonCode,
      UNCONSUMED_REASON.CONSUMED_VIA_FINGERPRINT_MATCH,
    );
    const scan = judgeUnconsumedAcrossWorktrees(
      { repoRoot: dir, now: NOW_MS },
      { admissionLedgerPath: ledgerPath },
    );
    assert.deepEqual(
      scan.worstWorktreePaths,
      [],
      "★증거가 생기면 형태 A 는 다시 조용해진다 -- 그리고 이번엔 «몰라서»가 아니다",
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

test("★★HYK-448 3R 배선: 영수증 지문이 현재 파일과 일치하면 침묵한다 -- 그리고 그것이 «위조로 발화를 지우는 길»이기도 하다는 사실을 그대로 고정한다 (2/2)", () => {
  // ⚠️★이 시험은 «바람직함»이 아니라 «현재 계약»을 고정한다.
  // 3R 은 침묵의 근거를 «증거»로 바꿈으므로, 지문이 일치하면 시계가
  // 무엇을 말하든 침묵한다. ⇒ 결과를 고친 뒤 지문까지 함께 고치면
  // 시계 축이 냈을 발화를 지울 수 있다. ⛔그것이 이 라운드가 지불한
  // 대가이며 coder.md 정직 한계에 명시한다(자산은 오직 워커가 쓸 수
  // 없는 자리에 지문을 두는 것 -- HYK-452 의 단조 이벤트 출처).
  withTempDir("hyk448-fp-match-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-449-marker-count-fence-1";
    writeTaskFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-06T20:10:00+09:00",
    });
    writeResultFile(dir, {
      taskId: label,
      mtimeIso: FACE_C_RESULT_ISO, // 종결 «뒤» -- 시계 축만이라면 발화한다.
      terminal: ">>> DONE: CODER @ 2026-09-06 23:05:00 KST",
    });
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: {
        status: "COMPLETED",
        completed_at: FACE_C_CLOSED_ISO,
        completion_reason: "OK",
      },
    });
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
      UNCONSUMED_VERDICT.CONSUMED,
      "지문이 일치하면 내용이 안 바뀜 것이므로 침묵한다(3R 계약)",
    );
    assert.equal(
      judged.reasonCode,
      UNCONSUMED_REASON.CONSUMED_VIA_FINGERPRINT_MATCH,
    );
  });
});

test("★★HYK-448 3R: 지문이 갈리면 여전히 발화한다 -- 진짜 양성(어젠밤 실물 형태)이 이 라운드에서 죽지 않았다 (1/1)", () => {
  withTempDir("hyk448-fp-diverge-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-449-marker-count-fence-1";
    writeTaskFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-06T20:10:00+09:00",
    });
    writeResultFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-06T23:07:59+09:00", // 시계는 «앞선 것처럼» 보인다.
      terminal: ">>> DONE: CODER @ 2026-09-06 23:05:00 KST",
    });
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: {
        status: "COMPLETED",
        completed_at: FACE_C_CLOSED_ISO,
        completion_reason: "OK",
      },
    });
    writeReceipt(dir, {
      fingerprint:
        "a0a8014eaf59b050d57edafce0648139f1456724dabf669056782c24a8ffb6f1",
      mtimeIso: "2026-09-06T23:00:00+09:00",
    });
    const judged = judgeFor(dir, NOW_MS, { admissionLedgerPath: ledgerPath });
    assert.equal(
      judged.verdict,
      UNCONSUMED_VERDICT.MODIFIED_AFTER_CLOSURE,
      "시계를 한 번도 비교하지 않고 «바뀜다»를 말한다",
    );
    assert.equal(
      judged.reasonCode,
      UNCONSUMED_REASON.RESULT_FINGERPRINT_DIVERGED,
    );
    const scan = judgeUnconsumedAcrossWorktrees(
      { repoRoot: dir, now: NOW_MS },
      { admissionLedgerPath: ledgerPath },
    );
    assert.equal(scan.worstWorktreePaths.length, 1);
  });
});

// ===========================================================================
// ★★HYK-448 3R -- 승격의 «범위»가 좁다는 것을 결선에서 고정한다.
// `UNDECIDABLE` 은 열 가지 넘는 사유가 함께 쓰는 판정 이름이다. 판정 이름만
// 보고 발화 등급으로 올리면 ⛔형태 B(ROUND_NOT_FINISHED)와 «아직 이른
// 라운드»(NO_SIGNAL_TOO_EARLY)까지 매 주기 발화한다 = HYK-448 이 없애려던
// 것의 부활. 그래서 «순서 미증명» 사유 하나만 올렸고, 아래가 그 경계다.
// ===========================================================================

test("★★HYK-448 3R: 승격은 «사유 하나»에만 적용된다 -- 형태 B(아직 안 끝난 라운드)는 UNDECIDABLE 이어도 여전히 각성에 도달하지 않는다 (2/2)", () => {
  withTempDir("hyk448-scope-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-449-marker-count-fence-1";
    writeTaskFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-06T20:10:00+09:00",
    });
    // 종료 표지 0개 = 아직 안 끝난 라운드(형태 B).
    writeResultFile(dir, {
      taskId: label,
      mtimeIso: "2026-09-06T21:00:32+09:00",
      terminal: null,
    });
    const now = new Date("2026-09-06T21:29:00+09:00").getTime();

    const judged = judgeFor(dir, now, {});
    assert.equal(judged.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
    assert.equal(
      judged.reasonCode,
      UNCONSUMED_REASON.ROUND_NOT_FINISHED,
      "같은 «UNDECIDABLE» 이지만 사유가 다르다",
    );
    const scan = judgeUnconsumedAcrossWorktrees({ repoRoot: dir, now }, {});
    assert.deepEqual(
      scan.worstWorktreePaths,
      [],
      "★형태 B 는 승격 대상이 아니다 -- 여기가 비지 않으면 1R 이 없앤 오탐이 부활한 것이다",
    );
  });
});

// ===========================================================================
// ★HYK-448 3R -- 소비자 결선(심각도) 쪽 변이 2종. 코어 변이(#9)는
// unconsumed-core.test.mjs 에 있고, 여기서는 «사람에게 도달하는가»를 만드는
// 두 줄이 실제로 하중을 받는지 본다.
// ⛔코어 변이와 달리 이쪽은 모듈 상수를 바꾸는 것이라 소스 복사본을 만들어
// import 한다(같은 관용구, 실 소스는 건드리지 않는다).
// ===========================================================================

const DETECT_PATH = join(THIS_DIR_WIRE, "orch-stall-detect.mjs");

async function importMutatedDetector(find, replacement) {
  const src = readFileSync(DETECT_PATH, "utf8");
  const count = src.split(find).length - 1;
  assert.equal(
    count,
    1,
    `mutation target must appear exactly once, got ${count}`,
  );
  const dir = mkdtempSync(join(tmpdir(), "hyk448-detect-mutant-"));
  const filePath = join(dir, "orch-stall-detect.mutant.mjs");
  // 형제 모듈은 원래 자리에서 import 되어야 하므로 상대 경로를 절대 경로로 고친다.
  // ★절대경로 import 지정자는 Windows 에서 file:// URL 이어야 한다.
  const dirPosix = "file:///" + THIS_DIR_WIRE.split("\\").join("/");
  const rewritten = src
    .split('from "./')
    .join(`from "${dirPosix}/`)
    .split('from "../')
    .join(`from "${dirPosix}/../`)
    .replace(find, replacement);
  writeFileSync(filePath, rewritten, "utf8");
  try {
    const url = "file://" + filePath.split("\\").join("/");
    return await import(`${url}?t=${Date.now()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function faceAFixture(dir, { withEvidence }) {
  initPlainGitRepo(dir);
  const label = "HYK-437-admission-anchor-1";
  writeTaskFile(dir, { taskId: label, mtimeIso: "2026-09-05T17:00:00+09:00" });
  writeResultFile(dir, {
    taskId: label,
    mtimeIso: FACE_A_RESULT_ISO,
    terminal: ">>> BLOCKED: 러너 초록 미충족, 정지",
  });
  if (withEvidence) {
    writeAbortRecord(dir, {
      leftoverFingerprint: createHash("sha256")
        .update(readFileSync(join(dir, ".harness", "coder.md"), "utf8"), "utf8")
        .digest("hex"),
      mtimeIso: FACE_A_CLOSED_ISO,
    });
  }
  return writeAdmissionLedger(dir, {
    [label]: {
      status: "COMPLETED",
      completed_at: FACE_A_CLOSED_ISO,
      completion_reason: "BLOCKED_TERMINATION_RELEASED",
    },
  });
}

test("★★NC mutation/detector #1 (HYK-448 3R): 승격을 되돌리면(발화 집합에서 «순서 미증명» 제거) -> RED (검토 2R 의 P1 이 그대로 되살아난다: 판정은 나오는데 사람에게 안 간다)", async () => {
  const mutant = await importMutatedDetector(
    "  UNCONSUMED_SCAN_SEVERITY.CLOSURE_ORDER_UNPROVABLE,\n]);",
    "]);",
  );
  await new Promise((resolve) => {
    withTempDir("hyk448-mut-promote-", (dir) => {
      const ledgerPath = faceAFixture(dir, { withEvidence: false });
      const scan = mutant.judgeUnconsumedAcrossWorktrees(
        { repoRoot: dir, now: NOW_MS },
        { admissionLedgerPath: ledgerPath },
      );
      assert.deepEqual(
        scan.worstWorktreePaths,
        [],
        "mutant must stop surfacing the unprovable closure (RED signal; proves the promotion is what closes review 2R's P1)",
      );
      resolve();
    });
  });
});

test("★★NC mutation/detector #2 (HYK-448 3R): 승격을 «판정 이름 전체»로 넓히면 -> RED (형태 B 까지 발화해 1R 의 성과가 무너진다)", async () => {
  // ⛔이 변이가 잡아내는 것이 «UNDECIDABLE 을 통째로 올린다»는 손쉬운 오답이다.
  const mutant = await importMutatedDetector(
    "      return entry.reasonCode ===",
    "      return true ||\n        entry.reasonCode ===",
  );
  await new Promise((resolve) => {
    withTempDir("hyk448-mut-scope-", (dir) => {
      initPlainGitRepo(dir);
      const label = "HYK-449-marker-count-fence-1";
      writeTaskFile(dir, {
        taskId: label,
        mtimeIso: "2026-09-06T20:10:00+09:00",
      });
      writeResultFile(dir, {
        taskId: label,
        mtimeIso: "2026-09-06T21:00:32+09:00",
        terminal: null, // 형태 B.
      });
      const now = new Date("2026-09-06T21:29:00+09:00").getTime();
      const scan = mutant.judgeUnconsumedAcrossWorktrees(
        { repoRoot: dir, now },
        {},
      );
      assert.equal(
        scan.worstWorktreePaths.length,
        1,
        "mutant must surface the in-flight round too (RED signal; proves the promotion is deliberately scoped to ONE reason)",
      );
      resolve();
    });
  });
});
