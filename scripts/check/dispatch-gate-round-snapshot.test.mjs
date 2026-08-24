// HYK-307-order-1 §1 -- 「소비 전에 지시서를 덮어쓰면 라운드가 영구
// 사망한다」(§0 실사고)를 닫는 delivery-time 스냅숏의 결선 시험.
//
// ★불변식: 소비되지 않은 라운드의 지시서 원문이, ORCH가 그 파일을
// 덮어써도 살아남아야 한다. dispatch-gate-decision.mjs는 실물 앵커
// (관제실 dispatch-worker.ps1:171)가 «배달 직전 항상» 부르는 지점이므로,
// 그 CLI 안에서 dropped_at을 기계로 찍는 바로 그 순간에 taskPath의
// 현재(=지금 배달하려는) 원문을 `.harness/rounds/<role>-task-r<N>.md`에
// 스냅숏한다(dispatch-gate-decision.mjs의 bestEffortSnapshotRoundTaskFile
// 자신의 헤더 주석에 "언제 스냅숏하면 직전 라운드 원문이 보장되는가"의
// 실측 근거가 적혀 있다). 이 시험은 실제 CLI를 spawn해서(직접 함수 호출이
// 아니다) 그 스냅숏이 파일시스템에 실제로 남는지 관측한다.
//
// ⛔합성 fixture만 쓴다 -- 실제 `.harness`는 절대 건드리지 않는다
// (dispatch-gate-live-path-guard.test.mjs가 이미 고정한 계약과 동일).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeLedger } from "./reject-streak.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-round-snapshot-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// HYK-342 4R §1: this file's fixtures never seed a sibling result file, so
// every run here is the "missing result file" bootstrap path. Give every
// call a readable, confirmably-empty receipt so these snapshot/ALLOW tests
// keep meaning "genuine first delivery" instead of hitting the new
// UNSET/REJECT case (receipt path unconfirmed -> reject).
const SHARED_EMPTY_RECEIPT_PATH = join(
  mkdtempSync(join(tmpdir(), "dispatch-gate-round-snapshot-test-receipts-")),
  "dispatch-receipts.jsonl",
);
writeFileSync(SHARED_EMPTY_RECEIPT_PATH, "", "utf8");

function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, DISPATCH_RECEIPT_PATH: SHARED_EMPTY_RECEIPT_PATH },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

function freshLedger(dir) {
  const ledgerPath = join(dir, "reject-streak.json");
  writeLedger(ledgerPath, { schema_version: 1, issues: {} });
  return ledgerPath;
}

function roundArchiveNames(dir) {
  try {
    return readdirSync(join(dir, "rounds"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// ⓐ 재현 시험 -- 오늘 사고를 합성으로 재현: 소비 없이 지시서를 덮어쓴
// 뒤, 직전 라운드 원문이 보관돼 있음을 단언.
// ---------------------------------------------------------------------------
test("(a) 재현: 배달 게이트가 라운드1을 배달한 뒤 ORCH가 «소비 없이» coder-task.md를 라운드2로 덮어써도, 라운드1의 원문이 rounds/에 살아남는다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = freshLedger(dir);

    // 라운드 1 배달.
    const round1Original = `task_id: HYK-9301-round1-1\ndropped_at: 2020-01-01 00:00 KST\nrole: CODER\n라운드1 지시서 본문 -- 이 문장이 살아남아야 한다.\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, round1Original, "utf8");
    const r1 = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /ALLOW/);

    // 배달 직후 스냅숏된 라운드1 실제 원문(방금 찍힌 dropped_at 포함)을
    // 미리 읽어 둔다 -- ORCH가 곧 덮어쓸 값이므로 이게 유일한 출처다.
    const round1Stamped = readFileSync(taskPath, "utf8");
    assert.notEqual(
      round1Stamped,
      round1Original,
      "dropped_at must have been machine-stamped",
    );

    const archivedAfterRound1 = roundArchiveNames(dir);
    assert.ok(
      archivedAfterRound1.some((n) => /^coder-task-r\d+\.md$/i.test(n)),
      "round-1 delivery must have produced a rounds/coder-task-r*.md snapshot",
    );

    // ★사고 재현: 워커가 결과를 남기지도, 소비 핸드셰이크가 돌지도 않은
    // 채로 ORCH가 coder-task.md를 곧장 라운드2 내용으로 덮어쓴다.
    const round2 = `task_id: HYK-9301-round2-1\ndropped_at: 2020-01-01 00:00 KST\nrole: CODER\n라운드2 지시서 본문.\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, round2, "utf8");
    assert.notEqual(
      readFileSync(taskPath, "utf8"),
      round1Stamped,
      "coder-task.md must now be overwritten with round 2 (the bug scenario)",
    );

    // 불변식: 라운드1 원문이 여전히 살아 있다(바이트 동일), taskPath가
    // 덮였는데도.
    const archiveDir = join(dir, "rounds");
    const preserved = roundArchiveNames(dir)
      .filter((n) => /^coder-task-r\d+\.md$/i.test(n))
      .map((n) => readFileSync(join(archiveDir, n), "utf8"))
      .find((body) => body.includes(round1Stamped));
    assert.ok(
      preserved,
      "round 1's exact original text (including its machine-stamped dropped_at) must be recoverable from rounds/ even after coder-task.md was overwritten unconsumed",
    );
  });
});

// ---------------------------------------------------------------------------
// ⓑ 회귀 방지 -- 미소비는 여전히 거부됨(§2-1): 이 스냅숏이 게이트의
// 「거부」 판정 자체를 무르게 만들지 않았음을 고정한다.
// ---------------------------------------------------------------------------
test("(b) 회귀: 스냅숏이 추가돼도 기존 REJECT 판정(streak 2, 봉투 없음)은 그대로 REJECT -- 스냅숏은 판정을 느슨하게 만들지 않는다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9302-reject-1\ndropped_at: 2020-01-01 00:00 KST\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9302": {
          streak: 2,
          history: [
            { task_id: "HYK-9302-coder-1", verdict: "rejected", at: "x" },
            { task_id: "HYK-9302-coder-2", verdict: "rejected", at: "y" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REJECT/);
    // 스냅숏 자체는(§3-c 요건과 별개로) best-effort로 여전히 돌아 원문을
    // 보존해도 되지만, 판정 결과(REJECT)는 절대 바뀌지 않는다 -- 이 축이
    // 이 시험이 고정하는 유일한 계약이다.
  });
});

// ---------------------------------------------------------------------------
// ⓒ 보관본 충돌 시 조용히 덮어쓰지 않음(거부 또는 구별되는 이름).
// ---------------------------------------------------------------------------
test("(c) 같은 라운드에 대해 게이트를 두 번 부르면(재시도), 이미 동일 원문이 보관돼 있으므로 중복 스냅숏을 만들지 않는다(조용한 덮어쓰기도, 무한 증식도 없음)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = freshLedger(dir);
    writeFileSync(
      taskPath,
      `task_id: HYK-9303-retry-1\ndropped_at: 2020-01-01 00:00 KST\nrole: CODER\n${ONE_B_BLOCK}`,
      "utf8",
    );

    const r1 = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r1.status, 0);
    const afterFirst = roundArchiveNames(dir).filter((n) =>
      /^coder-task-r\d+\.md$/i.test(n),
    );
    assert.equal(afterFirst.length, 1, "first delivery snapshots exactly once");

    const stampedOnce = readFileSync(taskPath, "utf8");

    // 재시도: 같은(이미 스탬프된) 파일 그대로 게이트를 다시 부른다 --
    // stampDroppedAt은 매번 새 시각을 계산하지만, dropped_at 문자열이
    // "분" 단위라 같은 분 안에서는 값이 바뀌지 않을 수 있다(이 시험은
    // 값이 바뀌든 안 바뀌든 성립해야 한다 -- 아래는 값이 같은 경우의
    // 스냅숏 개수만 고정한다: archiveRoundTaskFileIfNew의 동일-내용
    // 비교가 이 경우를 이미 스킵한다).
    const r2 = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r2.status, 0);

    const afterSecond = roundArchiveNames(dir).filter((n) =>
      /^coder-task-r\d+\.md$/i.test(n),
    );
    // stampDroppedAt이 매 호출 새 값을 만들 수 있으므로(분 경계), 두 번째
    // 스냅숏이 "추가"됐다면 그 내용은 반드시 첫 스냅숏과 달라야 한다
    // (=바이트 동일 중복이 아니어야 한다) -- 이게 이 축의 실제 계약이다.
    if (afterSecond.length > afterFirst.length) {
      const archiveDir = join(dir, "rounds");
      const bodies = afterSecond.map((n) =>
        readFileSync(join(archiveDir, n), "utf8"),
      );
      const unique = new Set(bodies);
      assert.equal(
        unique.size,
        bodies.length,
        "every archived round-task snapshot must be content-distinct -- no byte-identical duplicate ever written",
      );
    } else {
      assert.equal(afterSecond.length, afterFirst.length);
    }
    // 그리고 첫 스냅숏 파일 자체는 그대로 남아 있다(조용히 덮이지 않음).
    const archiveDir = join(dir, "rounds");
    const firstBody = readFileSync(join(archiveDir, afterFirst[0]), "utf8");
    assert.ok(
      firstBody.includes("HYK-9303-retry-1"),
      "the original first snapshot file must remain intact, never silently overwritten",
    );
    void stampedOnce;
  });
});

// ---------------------------------------------------------------------------
// ⓓ 기존 흐름 회귀 0 -- 정상 순서(배달 -> 소비 -> 새 지시서)에서 동작이
// 바뀌지 않는다: ALLOW 판정, 실제 소비 축(HYK-244 consumption receipt)
// 관측 가능한 문구 모두 그대로다. 여기서는 최소한(스냅숏이 있어도 ALLOW
// 판정 자체가 유지됨)만 고정한다 -- 소비 영수증 결선의 전체 계약은
// dispatch-gate-consumption-wire.test.mjs가 이미 촘촘히 고정하고 있고,
// 이 축은 그 파일이 계속 통과한다는 사실 자체로도 이미 증명된다(같은
// 스위프에서 함께 돈다).
// ---------------------------------------------------------------------------
test("(d) HYK-316-dropped-stamp-1: dropped_at 줄이 없지만 task_id: 는 있는 fixture -- 이제 dropped_at이 삽입되고, 그 삽입도 기존 스냅숏 축을 그대로 타서 rounds/에 남는다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // task_id: 는 있지만 dropped_at: 이 없는 fixture -- HYK-316 전에는
    // bestEffortStampDroppedAt의 no-op 분기(구조적 전제 미충족)를 탔지만,
    // 이제는 삽입 분기를 탄다(task_id: 존재가 그 경계).
    const original = `task_id: HYK-9304-nodropped-1\nrole: CODER\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = freshLedger(dir);
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);

    const stamped = readFileSync(taskPath, "utf8");
    assert.notEqual(
      stamped,
      original,
      "dropped_at must have been machine-inserted",
    );
    assert.match(stamped, /^dropped_at: \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST$/m);

    assert.deepEqual(
      roundArchiveNames(dir),
      ["coder-task-r1.md"],
      "an insertion is a real content-producing event, exactly like the existing overwrite branch -- it must snapshot the same way (bestEffortSnapshotRoundTaskFile), not skip",
    );
    const archived = readFileSync(
      join(dir, "rounds", "coder-task-r1.md"),
      "utf8",
    );
    assert.ok(
      archived.includes(stamped),
      "the snapshot must contain this round's final text, including the newly inserted dropped_at",
    );
  });
});

test("(e) 진짜 no-op: dropped_at: 도 task_id: 도 없는 fixture는 여전히 삽입도 스냅숏도 없다(§3-3 경계: task_id: 없으면 삽입하지 않는다)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original = `role: CODER\nno task_id header at all\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = freshLedger(dir);
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(readFileSync(taskPath, "utf8"), original);
    assert.deepEqual(roundArchiveNames(dir), []);
    void r;
  });
});
