// HYK-460 축 C (coder-task.md §C-5) -- seat-origin-warn.mjs 시험 5종 +
// dispatch-gate-decision.mjs 결선 확인 + 변이 RED(sha256 바이트 동일
// 복원). ⛔production export(evaluateSeatOriginWarningForWorktree /
// runDispatchGateDecision)를 직접 구동한다 -- 재구현·모킹으로 흉내내지
// 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  evaluateSeatOriginWarning,
  evaluateSeatOriginWarningForWorktree,
  readOverrideFacts,
  SEAT_ORIGIN_WARN_REASON,
} from "./seat-origin-warn.mjs";
import {
  appendLaunchRecord,
  buildLaunchRecord,
} from "./seat-origin-registry.mjs";
import { runDispatchGateDecision } from "./dispatch-gate-decision.mjs";
import { writeLedger } from "./reject-streak.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAT_ORIGIN_WARN_PATH = join(HERE, "seat-origin-warn.mjs");

// HYK-460 CI 수리(§0/§3-1): fn(dir)이 프라미스를 돌려주면(예: 마지막
// 변이 RED 시험의 dynamic import), 이전 구현의 try/finally는 그 프라미스가
// 아직 대기 중인데도 즉시 rmSync를 실행해 임시 디렉터리를 지워버렸다 --
// 시험이 "끝난" 뒤(콜백이 반환된 시점)에도 실제로는 비동기 작업이 계속
// 그 디렉터리를 읽고 있어 늦게 도착한 접근이 ENOENT로 실패하고, 그 실패가
// node:test에는 "테스트 종료 후 비동기 활동"으로 잡힌다(CI 로그 3077행).
// 이제 fn(dir)의 반환값이 thenable이면 그 프라미스가 정착(settle)된
// "뒤에" 정리하고, 아니면 기존처럼 즉시 정리한다 -- 임시 자원은 그것을
// 쓰는 모든 비동기 작업이 끝난 뒤에만 지운다.
function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === "function") {
    return result.then(
      (value) => {
        cleanup();
        return value;
      },
      (err) => {
        cleanup();
        throw err;
      },
    );
  }
  cleanup();
  return result;
}

// ---------------------------------------------------------------------------
// 순수 판정 (evaluateSeatOriginWarning) -- 프로덕션 export 직접 구동
// ---------------------------------------------------------------------------

test("evaluateSeatOriginWarning: paneKey 없으면 경고 없음(판정 불가)", () => {
  const r = evaluateSeatOriginWarning({ paneKey: null, registered: false });
  assert.equal(r.warn, false);
  assert.equal(r.reason, SEAT_ORIGIN_WARN_REASON.PANE_KEY_MISSING);
});

test("§C-5 시험1: 등록부에 있는 좌석 -> 경고 0", () => {
  const r = evaluateSeatOriginWarning({
    paneKey: "tab1:leaf1",
    registered: true,
  });
  assert.equal(r.warn, false);
  assert.equal(r.reason, SEAT_ORIGIN_WARN_REASON.REGISTERED);
});

test("§C-5 시험2: 등록부에 없는 좌석 -> 경고 발생(그러나 배달을 막는 필드는 전혀 없다)", () => {
  const r = evaluateSeatOriginWarning({
    paneKey: "tab1:leaf1",
    registered: false,
    overridePresent: false,
    overrideValid: false,
  });
  assert.equal(r.warn, true);
  assert.equal(r.reason, SEAT_ORIGIN_WARN_REASON.UNREGISTERED_NO_OVERRIDE);
  assert.ok(
    !("allow" in r),
    "이 판정 결과는 allow 필드를 갖지 않는다 -- 배달 허용/거부에 관여하지 않는다",
  );
});

test("§C-5 시험3: 등록부에 없고 + override 있음(3항목 충족) -> 경고 0(탈출구 동작)", () => {
  const r = evaluateSeatOriginWarning({
    paneKey: "tab1:leaf1",
    registered: false,
    overridePresent: true,
    overrideValid: true,
  });
  assert.equal(r.warn, false);
  assert.equal(r.reason, SEAT_ORIGIN_WARN_REASON.OVERRIDE_VALID);
});

test("§C-5 시험4: override가 필수 3항목 중 하나라도 빠지면 탈출구로 인정하지 않는다", () => {
  const r = evaluateSeatOriginWarning({
    paneKey: "tab1:leaf1",
    registered: false,
    overridePresent: true,
    overrideValid: false,
  });
  assert.equal(r.warn, true);
  assert.equal(r.reason, SEAT_ORIGIN_WARN_REASON.UNREGISTERED_OVERRIDE_INVALID);
});

// HYK-460 검토 1R P2-2: 위 시험4개는 전부 reason(열거값)만 단정했다 --
// message(사람이 실제로 읽는 경고 «본문» 문자열)는 아무도 단정하지
// 않아, 그 내용이 바뀌거나 빠져도 이 파일의 어떤 시험도 잡지 못했다.
// 여기서는 UNREGISTERED_NO_OVERRIDE(가장 흔한 실사고 경로 -- 런처
// 미경유)의 message가 ⓐ좌석 식별자(paneKey, 어느 좌석인지 특정 못하면
// 경고를 봐도 누구 것인지 알 수 없다) ⓑ탈출구 안내(seat-override.md +
// 세 필수 키 reason:/handle:/author:, 이게 없으면 경고를 본 사람이
// 무엇을 해야 하는지 알 방법이 없다) 둘 다를 실제로 담고 있는지 값으로
// 확인한다.
test("§C-5 시험5(P2-2): UNREGISTERED_NO_OVERRIDE의 message 본문이 좌석 식별자와 탈출구 안내를 담는다", () => {
  const r = evaluateSeatOriginWarning({
    paneKey: "tab1:leaf1",
    registered: false,
    overridePresent: false,
    overrideValid: false,
  });
  assert.ok(
    r.message.includes("tab1:leaf1"),
    `message에 paneKey가 그대로 실려야 한다: ${r.message}`,
  );
  assert.ok(
    r.message.includes("seat-override.md"),
    `message에 탈출구 파일명이 있어야 한다: ${r.message}`,
  );
  assert.ok(
    r.message.includes("reason:") &&
      r.message.includes("handle:") &&
      r.message.includes("author:"),
    `message에 탈출구 필수 3키 안내가 있어야 한다: ${r.message}`,
  );
});

// ---------------------------------------------------------------------------
// readOverrideFacts -- 빈 파일/부분 필드로 우회 불가
// ---------------------------------------------------------------------------

test("readOverrideFacts: 파일 없음 -> present:false", () => {
  withTempDir("seat-origin-warn-override-", (dir) => {
    const p = join(dir, "seat-override.md");
    assert.deepEqual(readOverrideFacts(p), { present: false, valid: false });
  });
});

test("readOverrideFacts: 빈 파일 -> present:true, valid:false(빈 파일로 우회 불가)", () => {
  withTempDir("seat-origin-warn-override-", (dir) => {
    const p = join(dir, "seat-override.md");
    writeFileSync(p, "", "utf8");
    const facts = readOverrideFacts(p);
    assert.equal(facts.present, true);
    assert.equal(facts.valid, false);
  });
});

test("readOverrideFacts: 3항목 중 handle만 빠짐 -> valid:false", () => {
  withTempDir("seat-origin-warn-override-", (dir) => {
    const p = join(dir, "seat-override.md");
    writeFileSync(
      p,
      "reason: 런처 죽음, 복구 좌석 수동 기동\nauthor: ORCH\n",
      "utf8",
    );
    assert.equal(readOverrideFacts(p).valid, false);
  });
});

test("readOverrideFacts: 3항목 전부 있음 -> valid:true", () => {
  withTempDir("seat-origin-warn-override-", (dir) => {
    const p = join(dir, "seat-override.md");
    writeFileSync(
      p,
      "reason: 런처 죽음, 복구 좌석 수동 기동\nhandle: term_abc\nauthor: ORCH\n",
      "utf8",
    );
    assert.equal(readOverrideFacts(p).valid, true);
  });
});

// ---------------------------------------------------------------------------
// 어댑터 (evaluateSeatOriginWarningForWorktree) -- 실제 등록부 파일 + 실제
// override 파일을 놓고 구동
// ---------------------------------------------------------------------------

test("evaluateSeatOriginWarningForWorktree: 등록부에 실제로 기록된 pane -> 경고 0", () => {
  withTempDir("seat-origin-warn-adapter-", (dir) => {
    const worktree = join(dir, "wt");
    mkdirSync(join(worktree, ".harness"), { recursive: true });
    const registryPath = join(dir, "seat-launch-registry.jsonl");
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({ paneKey: "tab1:leaf1", role: "CODER" }),
    );
    const outcome = evaluateSeatOriginWarningForWorktree({
      worktree,
      registryPath,
      paneKey: "tab1:leaf1",
    });
    assert.equal(outcome.warn, false);
  });
});

test("evaluateSeatOriginWarningForWorktree: 등록부에 없는 pane -> 경고, override 파일을 실제로 만들면 사라진다", () => {
  withTempDir("seat-origin-warn-adapter-", (dir) => {
    const worktree = join(dir, "wt");
    mkdirSync(join(worktree, ".harness"), { recursive: true });
    const registryPath = join(dir, "seat-launch-registry.jsonl");
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({ paneKey: "OTHER:pane", role: "CODER" }),
    );
    const before = evaluateSeatOriginWarningForWorktree({
      worktree,
      registryPath,
      paneKey: "tab1:leaf1",
    });
    assert.equal(before.warn, true);

    writeFileSync(
      join(worktree, ".harness", "seat-override.md"),
      "reason: 시험용\nhandle: term_test\nauthor: tester\n",
      "utf8",
    );
    const after = evaluateSeatOriginWarningForWorktree({
      worktree,
      registryPath,
      paneKey: "tab1:leaf1",
    });
    assert.equal(after.warn, false);
    assert.equal(after.reason, SEAT_ORIGIN_WARN_REASON.OVERRIDE_VALID);
  });
});

// ---------------------------------------------------------------------------
// §C-5 마지막 항목: 시험이 production export를 직접 구동하는지 grep 확인
// (기계로 고정 -- 이 파일 자신을 grep한다)
// ---------------------------------------------------------------------------

test("§C-5: 이 시험 파일은 seat-origin-warn.mjs를 (재구현이 아니라) 직접 import한다", () => {
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.match(self, /from "\.\/seat-origin-warn\.mjs"/);
  assert.match(self, /from "\.\/dispatch-gate-decision\.mjs"/);
});

// ---------------------------------------------------------------------------
// dispatch-gate-decision.mjs 결선: 경고가 있어도 배달(allow)이 진행된다
// (1단계 -- 거부 아님), 그리고 등록부에 있으면 경고 줄 자체가 없다.
// ---------------------------------------------------------------------------

function seedLedgerAndOneB(dir, taskPath, issueId) {
  const ledgerPath = join(dir, "reject-streak.json");
  writeLedger(ledgerPath, { issues: {} });
  const text =
    `task_id: ${issueId}-seed-1\n` +
    "1b_exec_line: x\n1b_shown: y\n1b_reach_path: z\n";
  writeFileSync(taskPath, text, "utf8");
  // 소비 완료 영수증 축(evaluateConsumptionDecision)이 "확인 불가"로
  // 거부하지 않도록, 빈 영수증 로그를 실재 파일로 준다(진짜 부트스트랩 --
  // hyk241-oneb-gate-mutation.test.mjs의 SHARED_EMPTY_RECEIPT_PATH와 같은
  // 관례).
  const receiptPath = join(dir, "dispatch-receipts.jsonl");
  writeFileSync(receiptPath, "", "utf8");
  return { ledgerPath, receiptPath };
}

test("결선: 미등록 pane이어도 dispatch-gate-decision은 여전히 ALLOW하고 경고 줄만 덧붙인다(1단계, 거부 아님)", () => {
  withTempDir("seat-origin-warn-wire-", (dir) => {
    const taskPath = join(dir, "coder-task.md");
    const { ledgerPath, receiptPath } = seedLedgerAndOneB(
      dir,
      taskPath,
      "HYK-460",
    );
    const registryPath = join(dir, "seat-launch-registry.jsonl"); // 존재하지 않음
    const { allow, lines } = runDispatchGateDecision([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      receiptPath,
      "--pane-key",
      "tab9:leaf9",
      "--seat-registry-path",
      registryPath,
    ]);
    assert.equal(allow, true, lines.join("\n"));
    assert.ok(
      lines.some((l) => l.startsWith("seat-origin-warn: WARN")),
      `경고 줄이 lines에 있어야 한다: ${lines.join("\n")}`,
    );
  });
});

test("결선: 등록부에 있는 pane -> 경고 줄 없음", () => {
  withTempDir("seat-origin-warn-wire-", (dir) => {
    const taskPath = join(dir, "coder-task.md");
    const { ledgerPath, receiptPath } = seedLedgerAndOneB(
      dir,
      taskPath,
      "HYK-460",
    );
    const registryPath = join(dir, "seat-launch-registry.jsonl");
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({ paneKey: "tab9:leaf9", role: "CODER" }),
    );
    const { allow, lines } = runDispatchGateDecision([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      receiptPath,
      "--pane-key",
      "tab9:leaf9",
      "--seat-registry-path",
      registryPath,
    ]);
    assert.equal(allow, true, lines.join("\n"));
    assert.ok(!lines.some((l) => l.startsWith("seat-origin-warn: WARN")));
  });
});

// HYK-460 검토 1R P2-3ⓒ: 탈출구(OVERRIDE_VALID)가 실제로 쓰였을 때
// 배달 로그(runDispatchGateDecision의 lines)에 그 사용 사실이 줄로
// 남는지 값으로 확인한다. 고치기 전에는 outcome.warn이 false라는 이유로
// 이 경로가 lines에 아무것도 남기지 않았다(검토자가 지적한 "사용 흔적
// 0"). 이 시험은 그 회귀를 막는다.
test("결선(P2-3ⓒ): 탈출구(override valid)가 쓰이면 경고는 아니지만 배달 로그에 사용 사실이 줄로 남는다", () => {
  withTempDir("seat-origin-warn-wire-", (dir) => {
    const taskPath = join(dir, "coder-task.md");
    const { ledgerPath, receiptPath } = seedLedgerAndOneB(
      dir,
      taskPath,
      "HYK-460",
    );
    // 등록부에는 없는 pane -- 그러나 워크트리(taskPath의 dirname)에
    // 필수 3항목을 갖춘 seat-override.md가 있다.
    const registryPath = join(dir, "seat-launch-registry.jsonl");
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({ paneKey: "OTHER:pane", role: "CODER" }),
    );
    mkdirSync(join(dir, ".harness"), { recursive: true });
    writeFileSync(
      join(dir, ".harness", "seat-override.md"),
      "reason: 시험용 결선 확인\nhandle: term_test\nauthor: tester\n",
      "utf8",
    );
    const { allow, lines } = runDispatchGateDecision([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      receiptPath,
      "--pane-key",
      "tab9:leaf9",
      "--seat-registry-path",
      registryPath,
    ]);
    assert.equal(allow, true, lines.join("\n"));
    assert.ok(
      !lines.some((l) => l.startsWith("seat-origin-warn: WARN")),
      `OVERRIDE_VALID는 경고가 아니다 -- WARN 줄이 있으면 안 된다: ${lines.join("\n")}`,
    );
    assert.ok(
      lines.some(
        (l) => l.startsWith("seat-origin-warn:") && l.includes("경고 생략"),
      ),
      `탈출구 사용 사실이 lines에 한 줄로 남아야 한다(감사 축): ${lines.join("\n")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 변이 RED (§C-5 비타협): 경고 판정을 «항상 통과(warn:false)»로 되돌리면
// 이 시험이 빨강이 되는지, 합성 표적(임시 사본)에서 확인한다. 원본은 절대
// 건드리지 않는다 -- 복원 후 sha256 바이트 동일을 단정한다.
// ---------------------------------------------------------------------------

test("변이 RED: '경고 판정 항상 통과'로 되돌리면 이 시험이 실패한다(합성 표적, 원본 바이트 동일 복원)", () => {
  const original = readFileSync(SEAT_ORIGIN_WARN_PATH, "utf8");
  const originalSha = createHash("sha256").update(original).digest("hex");

  const TARGET =
    "reason: SEAT_ORIGIN_WARN_REASON.UNREGISTERED_OVERRIDE_INVALID,";
  const count = original.split(TARGET).length - 1;
  assert.equal(count, 1, "mutation target must appear exactly once");

  // "미등록+override 무효" WARN 분기를 실제로 되돌린 항상-통과 변이본을
  // 시험한다.
  withTempDir("seat-origin-warn-mutation-", (dir) => {
    // seat-origin-warn.mjs imports ./seat-origin-registry.mjs -- stage a
    // real sibling copy so the mutant module can actually load.
    writeFileSync(
      join(dir, "seat-origin-registry.mjs"),
      readFileSync(join(HERE, "seat-origin-registry.mjs"), "utf8"),
      "utf8",
    );
    const mutantPath = join(dir, "seat-origin-warn.mjs");
    const mutated = original.replace(
      `      warn: true,\n      ${TARGET}`,
      `      warn: false,\n      ${TARGET}`,
    );
    assert.notEqual(
      mutated,
      original,
      "mutation target(UNREGISTERED_OVERRIDE_INVALID warn:true) not found in current source",
    );
    writeFileSync(mutantPath, mutated, "utf8");
    const mod = `${pathToFileURL(mutantPath).href}?cachebust=${Date.now()}`;
    return import(mod).then((m) => {
      const r = m.evaluateSeatOriginWarning({
        paneKey: "tab1:leaf1",
        registered: false,
        overridePresent: true,
        overrideValid: false,
      });
      assert.equal(
        r.warn,
        false,
        "변이본은 잘못 통과시킨다(RED가 되어야 할 자리에서 GREEN처럼 보임 -- 이 assert 자체가 변이가 실제로 판정을 뒤집었음을 증명)",
      );
      // 위 assert.equal(r.warn, false)가 통과했다는 것은 원본(변이 전)의
      // 같은 입력이 warn:true였다면 이 변이가 그 시험(§C-5 시험4)을 RED로
      // 뒤집는다는 뜻이다 -- 아래로 원본 자체에서 그 전제를 재확인한다.
      const originalOutcome = evaluateSeatOriginWarning({
        paneKey: "tab1:leaf1",
        registered: false,
        overridePresent: true,
        overrideValid: false,
      });
      assert.equal(
        originalOutcome.warn,
        true,
        "원본은 이 입력에서 warn:true여야 변이가 RED를 낸다는 주장이 성립한다",
      );
    });
  }).then(() => {
    const restored = readFileSync(SEAT_ORIGIN_WARN_PATH, "utf8");
    const restoredSha = createHash("sha256").update(restored).digest("hex");
    assert.equal(
      restoredSha,
      originalSha,
      "원본 파일은 이 시험 도중 절대 바뀌지 않아야 한다(합성 표적에서만 변이)",
    );
  });
});
