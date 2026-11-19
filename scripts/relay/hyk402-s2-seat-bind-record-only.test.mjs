import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DELIVERY_BIND_VERDICT,
  classifyReceiptBinding,
  decideSeatBindAtDelivery,
  parseTerminalListText,
} from "./seat-role-bind-core.mjs";
import {
  ENFORCEMENT_RELAY_FILES,
  ENFORCEMENT_CHECK_FILES,
} from "../../templates/harness-init/install.mjs";
import {
  extractExternalPathCallers,
  findCallerViolations,
} from "../check/installer-external-path-callers.mjs";

// HYK-402 S2 (seat-role-s2-1): 배달 순간 역할 결속 «기록만» (차단 0).
// 시험은 전부 mkdtemp 합성 입력이다 -- 합성 terminal list JSON · 합성 등록부 ·
// 합성 영수증 원장 · ps1 합성 사본. 실제 `orca` 실행 0 · 관제실 파일 접근 0 ·
// 네트워크 0. CLI 는 «자식 프로세스»로 구동하고 영수증 파일 · 종료코드 ·
// stdout 자기 토막만 단언한다(헛시험 금지 -- helper 만 부르는 시험은 «보조»).
// 출력 «전체» 문자열 동등 단언 금지(고정 문면 59 · 자기 토막만).

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(THIS_DIR, "..", "..");
const BIND_CLI = join(THIS_DIR, "seat-role-bind-cli.mjs");
const BIND_CORE_SRC = join(THIS_DIR, "seat-role-bind-core.mjs");
const RECEIPT_CLI = join(THIS_DIR, "dispatch-receipt-cli.mjs");
const PATCH_DOC = join(
  REPO_ROOT,
  "docs",
  "control-room-patches",
  "HYK-402-seat-role-bind-s2.md",
);

const WORKTREE = "C:/Users/Synthetic/orca/workspaces/PROJ/wt-one";
const CODER_PREVIEW = "Opus 4.7 · bypass permissions on (shift+tab to cycle)";
const REVIEW_PREVIEW = "gpt-5.6 high · MCP startup complete";
const BLANK_SHELL_PREVIEW = "Windows PowerShell\r\nPS C:\\Users\\Synthetic> ";

function seat(handle, tabId, leafId, preview, extra = {}) {
  return {
    handle,
    tabId,
    leafId,
    worktreePath: WORKTREE,
    title: "synthetic",
    preview,
    ...extra,
  };
}
const SEAT_CODER = seat("term_coder", "tabA", "leafA", CODER_PREVIEW);
const SEAT_REVIEW = seat("term_review", "tabB", "leafB", REVIEW_PREVIEW);
const SEAT_BLANK = seat("term_blank", "tabC", "leafC", BLANK_SHELL_PREVIEW);

function regRecord(paneKey, role, launchedAt = "2026-11-01T00:00:00.000Z") {
  return {
    paneKey,
    role,
    engine: null,
    model: null,
    effort: null,
    worktree: WORKTREE,
    launchedVia: "orca-worker-seat.ps1",
    launchedAt,
  };
}
const REG_CODER = regRecord("tabA:leafA", "CODER");
const REG_REVIEW = regRecord("tabB:leafB", "REVIEW");

const DELIVERED_MS = Date.parse("2026-11-18T07:35:35.000Z");

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk402-s2-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeList(dir, terminals, name = "list.json") {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ ok: true, result: { terminals } }));
  return p;
}
function writeRegistry(dir, records, name = "registry.jsonl") {
  const p = join(dir, name);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

// record-only 모드로 bind CLI 를 «자식 프로세스»로 구동 -> { exitCode, json, stdout }.
function runRecordOnly(args) {
  const r = spawnSync(process.execPath, [BIND_CLI, "--record-only", ...args], {
    encoding: "utf8",
  });
  let json = null;
  const line = (r.stdout ?? "")
    .split(/\r?\n/)
    .find((l) => l.startsWith('{"seat_bind"'));
  if (line) {
    try {
      json = JSON.parse(line).seat_bind;
    } catch {
      json = null;
    }
  }
  return { exitCode: r.status, json, stdout: r.stdout ?? "", stderr: r.stderr };
}

function baseArgs(dir, { terminals, records, role = "CODER", handle, at }) {
  const args = [
    "--terminal-list",
    writeList(dir, terminals),
    "--worktree",
    WORKTREE,
    "--role",
    role,
    "--registry-path",
    writeRegistry(dir, records),
    "--delivered-at-ms",
    String(at ?? DELIVERED_MS),
  ];
  if (handle) args.push("--handle", handle);
  return args;
}

const DISPATCH_OK = JSON.stringify({
  ok: true,
  result: {
    dispatch: {
      id: "ctx_s2",
      task_id: "task_s2",
      assignee_pane_key: "tabA:leafA",
      dispatched_at: "2026-11-18 07:35:35",
    },
  },
});

function runReceipt(dir, extraArgs, { receiptName = "receipts.jsonl" } = {}) {
  const receiptPath = join(dir, receiptName);
  const r = spawnSync(
    process.execPath,
    [
      RECEIPT_CLI,
      "--role",
      "CODER",
      "--task-label",
      "HYK-S2-synth-1",
      "--receipt-path",
      receiptPath,
      ...extraArgs,
    ],
    { input: DISPATCH_OK, encoding: "utf8" },
  );
  const text = existsSync(receiptPath) ? readFileSync(receiptPath, "utf8") : "";
  return {
    exitCode: r.status,
    stdout: r.stdout,
    text,
    row: text ? JSON.parse(text.trim().split("\n").pop()) : null,
  };
}

// ---- ⑴ 판정 4종이 모두 영수증에 기록되고 기록 거부 0 ----------------------

for (const verdict of ["MATCH", "MISMATCH", "UNDECIDABLE", "ERROR"]) {
  test(`영수증 기록: --seat-bind-verdict ${verdict} 는 거부 0 · 영수증 칸에 그대로 남는다`, () => {
    withTempDir((dir) => {
      const r = runReceipt(dir, [
        "--seat-bind-verdict",
        verdict,
        "--seat-bind-reason",
        "SOME_REASON",
        "--seat-bind-candidates",
        "tabA:leafA=CODER/REGISTERED_AGENT",
      ]);
      assert.equal(r.exitCode, 0, `exit=${r.exitCode} out=${r.stdout}`);
      assert.equal(r.row.seat_bind_verdict, verdict);
      assert.equal(r.row.seat_bind_reason, "SOME_REASON");
      assert.match(r.row.seat_bind_candidates, /tabA:leafA=CODER/);
      assert.match(r.stdout, /RECORDED /);
    });
  });
}

test("영수증 기록: 알 수 없는 판정값 · 빈 값 · 값 누락 · 소문자 · `=` 문법도 거부 0 (ERROR/정규화로 기록)", () => {
  withTempDir((dir) => {
    const weird = runReceipt(dir, ["--seat-bind-verdict", "MAYBE"], {
      receiptName: "w1.jsonl",
    });
    assert.equal(weird.exitCode, 0);
    assert.equal(weird.row.seat_bind_verdict, "ERROR");
    assert.match(weird.row.seat_bind_reason, /UNRECOGNIZED_VERDICT/);

    const lower = runReceipt(dir, ["--seat-bind-verdict", "match"], {
      receiptName: "w2.jsonl",
    });
    assert.equal(lower.exitCode, 0);
    assert.equal(lower.row.seat_bind_verdict, "MATCH");

    // 값이 아예 없는 꼬리 인자(뒤에 다른 플래그가 오는 경우 포함)
    const noValue = runReceipt(
      dir,
      ["--seat-bind-verdict", "--seat-bind-reason", "R1"],
      { receiptName: "w3.jsonl" },
    );
    assert.equal(noValue.exitCode, 0);
    assert.equal(noValue.row.seat_bind_verdict, "ERROR");
    // ⓔ(S2 후속 정리): 판정값 누락으로 ERROR 가 된 칸의 사유는 «누락 사유 + 받은 사유» 로 함께 남는다.
    assert.equal(
      noValue.row.seat_bind_reason,
      "SEAT_BIND_VERDICT_MISSING;given=R1",
    );

    const reasonOnly = runReceipt(dir, ["--seat-bind-reason", "ONLY_REASON"], {
      receiptName: "w4.jsonl",
    });
    assert.equal(reasonOnly.exitCode, 0);
    assert.equal(reasonOnly.row.seat_bind_verdict, "ERROR");

    const eq = runReceipt(dir, ["--seat-bind-verdict=UNDECIDABLE"], {
      receiptName: "w5.jsonl",
    });
    assert.equal(eq.exitCode, 0);
    assert.equal(eq.row.seat_bind_verdict, "UNDECIDABLE");
  });
});

// ⓒ (S2 후속 정리): 값이 `--` 로 시작해도 «기록만» 인자는 영수증을 거부하지 않는다.
test("영수증 기록: 값이 `--` 로 시작해도 거부 0 -- 알려진 플래그 이름이 아니면 «값» 이다 · 알려진 플래그 이름이면 값 누락으로 접는다", () => {
  withTempDir((dir) => {
    const odd = runReceipt(
      dir,
      [
        "--seat-bind-verdict",
        "ERROR",
        "--seat-bind-reason",
        "--odd-reason",
        "--seat-bind-candidates",
        "--odd-cand",
      ],
      { receiptName: "c1.jsonl" },
    );
    assert.equal(odd.exitCode, 0, `exit=${odd.exitCode} out=${odd.stdout}`);
    assert.equal(odd.row.seat_bind_verdict, "ERROR");
    assert.equal(odd.row.seat_bind_reason, "--odd-reason");
    assert.equal(odd.row.seat_bind_candidates, "--odd-cand");

    // 판정값 자리에 `--` 값 -> 알 수 없는 판정값(ERROR)으로 기록 · 거부 0
    const oddVerdict = runReceipt(dir, ["--seat-bind-verdict", "--MAYBE"], {
      receiptName: "c2.jsonl",
    });
    assert.equal(oddVerdict.exitCode, 0, oddVerdict.stdout);
    assert.equal(oddVerdict.row.seat_bind_verdict, "ERROR");
    assert.match(
      oddVerdict.row.seat_bind_reason,
      /UNRECOGNIZED_VERDICT_--MAYBE/,
    );

    // 알려진 플래그 이름(`--seat-bind-verdict`)은 값이 아니라 «다음 인자» -- 앞 인자는 값 누락(빈 값)
    const known = runReceipt(
      dir,
      ["--seat-bind-reason", "--seat-bind-verdict", "MATCH"],
      { receiptName: "c3.jsonl" },
    );
    assert.equal(known.exitCode, 0, known.stdout);
    assert.equal(known.row.seat_bind_verdict, "MATCH");
    assert.equal(known.row.seat_bind_reason, undefined);

    // 이 예외는 «기록만» 인자에만 -- 다른 모르는 플래그는 여전히 거부(기존 계약 무변)
    const stray = runReceipt(dir, ["--no-such-flag"], {
      receiptName: "c4.jsonl",
    });
    assert.equal(stray.exitCode, 1);
    assert.equal(stray.text, "");
  });
});

// ⓔ (S2 후속 정리): 판정값이 인식되지 않아 ERROR 가 된 칸에 호출자의 사유 인자가 «겹쳐» 와도
// ERROR 의 원인 사유가 사라지지 않는다(예전: 호출자 사유가 이겨서 ERROR/ROLE_MATCH 같은 거짓 조합).
test("영수증 기록: 인식 불가 판정값(ERROR) 칸에 사유 인자가 겹쳐도 ERROR 원인이 남는다 -- 받은 사유는 ;given= 뒤에 보존 · 120자 상한", () => {
  withTempDir((dir) => {
    const both = runReceipt(
      dir,
      ["--seat-bind-verdict", "MAYBE", "--seat-bind-reason", "ROLE_MATCH"],
      { receiptName: "e1.jsonl" },
    );
    assert.equal(both.exitCode, 0, both.stdout);
    assert.equal(both.row.seat_bind_verdict, "ERROR");
    assert.match(both.row.seat_bind_reason, /^UNRECOGNIZED_VERDICT_MAYBE/);
    assert.match(both.row.seat_bind_reason, /given=ROLE_MATCH/);
    assert.notEqual(both.row.seat_bind_reason, "ROLE_MATCH");

    const missing = runReceipt(dir, ["--seat-bind-reason", "ONLY_REASON"], {
      receiptName: "e2.jsonl",
    });
    assert.equal(missing.row.seat_bind_verdict, "ERROR");
    assert.match(missing.row.seat_bind_reason, /^SEAT_BIND_VERDICT_MISSING/);
    assert.match(missing.row.seat_bind_reason, /given=ONLY_REASON/);

    const long = runReceipt(
      dir,
      ["--seat-bind-verdict", "MAYBE", "--seat-bind-reason", "X".repeat(300)],
      { receiptName: "e3.jsonl" },
    );
    assert.ok(
      long.row.seat_bind_reason.length <= 120,
      long.row.seat_bind_reason,
    );
    assert.match(long.row.seat_bind_reason, /^UNRECOGNIZED_VERDICT_MAYBE/);

    // 인식되는 판정값이면 받은 사유가 그대로(겹침 없음 · 기존 계약 무변)
    const fine = runReceipt(
      dir,
      [
        "--seat-bind-verdict",
        "ERROR",
        "--seat-bind-reason",
        "BIND_CLI_TIMEOUT",
      ],
      { receiptName: "e4.jsonl" },
    );
    assert.equal(fine.row.seat_bind_reason, "BIND_CLI_TIMEOUT");
  });
});

test("영수증 기록: MISMATCH 를 줘도 기록 «거부» 가 아니다 -- 원장에 줄이 남고 기존 8칸은 그대로", () => {
  withTempDir((dir) => {
    const r = runReceipt(dir, [
      "--seat-bind-verdict",
      "MISMATCH",
      "--seat-bind-reason",
      "ROLE_MISMATCH",
    ]);
    assert.equal(r.exitCode, 0);
    assert.equal(r.text.trim().split("\n").length, 1);
    for (const k of [
      "recorded_at",
      "runtime_task_id",
      "dispatch_id",
      "assignee_pane_key",
      "dispatch_timestamp_utc",
      "dispatch_timestamp_source",
      "role",
      "harness_task_label",
    ]) {
      assert.ok(k in r.row, `기존 칸 ${k} 가 사라졌다`);
    }
    assert.equal(r.row.dispatch_id, "ctx_s2");
  });
});

// ---- ⑵ 새 인자 없음 = base 와 같은 영수증 바이트 --------------------------

test("새 인자 없음 = 지금과 바이트 같은 영수증 (칸 목록 · 키 순서 · stdout 접두)", () => {
  withTempDir((dir) => {
    const r = runReceipt(dir, []);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(Object.keys(r.row), [
      "recorded_at",
      "runtime_task_id",
      "dispatch_id",
      "assignee_pane_key",
      "dispatch_timestamp_utc",
      "dispatch_timestamp_source",
      "role",
      "harness_task_label",
    ]);
    assert.ok(
      !r.text.includes("seat_bind"),
      "새 칸 이름이 새 인자 없이 새어 나왔다",
    );
    assert.ok(!r.stdout.includes("seat_bind"));
    // 단 하나의 새 인자도 없을 때 이 줄 모양(recorded_at 제외)이 고정이다.
    const rest = { ...r.row };
    delete rest.recorded_at;
    assert.deepEqual(rest, {
      runtime_task_id: "task_s2",
      dispatch_id: "ctx_s2",
      assignee_pane_key: "tabA:leafA",
      dispatch_timestamp_utc: "2026-11-18 07:35:35",
      dispatch_timestamp_source: "response.dispatched_at",
      role: "CODER",
      harness_task_label: "HYK-S2-synth-1",
    });
  });
});

test("--bound-seat-role 거부 동작은 그대로 (S2 가 건드리지 않았다)", () => {
  withTempDir((dir) => {
    const r = runReceipt(dir, ["--bound-seat-role", "REVIEW"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /does not match --role/);
    assert.equal(r.text, "", "거부면 원장에 한 줄도 없어야 한다");
  });
});

// ---- ⑶ 배달 순간 판정 -- bind CLI --record-only (종료코드 0 고정) ----------

test("record-only: 일치 = MATCH · 종료코드 0 · stdout JSON", () => {
  withTempDir((dir) => {
    const r = runRecordOnly(
      baseArgs(dir, {
        terminals: [SEAT_CODER, SEAT_BLANK],
        records: [REG_CODER],
        handle: "term_coder",
      }),
    );
    assert.equal(r.exitCode, 0);
    assert.ok(r.json, `no JSON in stdout: ${r.stdout}`);
    assert.equal(r.json.verdict, "MATCH");
    assert.equal(r.json.reason, "ROLE_MATCH");
    assert.match(r.json.candidates, /tabA:leafA=CODER\/REGISTERED_AGENT/);
  });
});

test("record-only: 불일치 = MISMATCH 이지만 종료코드는 여전히 0 (배달을 막지 않는다)", () => {
  withTempDir((dir) => {
    const r = runRecordOnly(
      baseArgs(dir, {
        terminals: [SEAT_REVIEW],
        records: [REG_REVIEW],
        role: "CODER",
        handle: "term_review",
      }),
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.json.verdict, "MISMATCH");
    assert.equal(r.json.reason, "HANDLE_ROLE_MISMATCH");
  });
});

test("record-only: 등록부 공백(빈 파일 · 파일 없음) = UNDECIDABLE, 거부도 MISMATCH 도 아니다", () => {
  withTempDir((dir) => {
    const emptyReg = join(dir, "empty.jsonl");
    writeFileSync(emptyReg, "");
    const list = writeList(dir, [SEAT_CODER]);
    const empty = runRecordOnly([
      "--terminal-list",
      list,
      "--worktree",
      WORKTREE,
      "--role",
      "CODER",
      "--registry-path",
      emptyReg,
      "--handle",
      "term_coder",
      "--delivered-at-ms",
      String(DELIVERED_MS),
    ]);
    assert.equal(empty.exitCode, 0);
    assert.equal(empty.json.verdict, "UNDECIDABLE");
    assert.equal(empty.json.reason, "REGISTRY_EMPTY");

    const absent = runRecordOnly([
      "--terminal-list",
      list,
      "--worktree",
      WORKTREE,
      "--role",
      "CODER",
      "--registry-path",
      join(dir, "no-such-registry.jsonl"),
      "--handle",
      "term_coder",
    ]);
    assert.equal(absent.exitCode, 0);
    assert.equal(absent.json.verdict, "UNDECIDABLE");
    assert.equal(absent.json.reason, "REGISTRY_ABSENT");
  });
});

test("record-only: 등록이 배달보다 «늦다» = UNDECIDABLE (일치로 접지 않는다)", () => {
  withTempDir((dir) => {
    // 이 좌석의 유일한 등록이 배달 시각(DELIVERED_MS) 뒤에 찍혔다.
    const r = runRecordOnly(
      baseArgs(dir, {
        terminals: [SEAT_CODER],
        records: [regRecord("tabA:leafA", "CODER", "2026-11-18T07:40:00.000Z")],
        handle: "term_coder",
      }),
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.json.verdict, "UNDECIDABLE");
    assert.equal(r.json.reason, "PANE_REGISTERED_AFTER_DELIVERY");
    // 같은 등록이 배달보다 «앞»이면 MATCH -- 시각이 판정을 가른다는 대조.
    const early = runRecordOnly(
      baseArgs(dir, {
        terminals: [SEAT_CODER],
        records: [regRecord("tabA:leafA", "CODER", "2026-11-18T07:30:00.000Z")],
        handle: "term_coder",
      }),
    );
    assert.equal(early.json.verdict, "MATCH");
  });
});

// ⓓ (S2 후속 정리): «등록 시각을 읽을 수 없다» 와 «등록이 배달보다 늦다» 는 다른 사유 코드다.
// 판정은 둘 다 UNDECIDABLE 그대로(판정 4종 의미 무변).
test("record-only: 등록 시각 해석 불가 ≠ 등록이 배달보다 늦음 -- 둘 다 UNDECIDABLE · 사유 코드만 갈린다", () => {
  withTempDir((dir) => {
    const run = (records) =>
      runRecordOnly(
        baseArgs(dir, {
          terminals: [SEAT_CODER],
          records,
          handle: "term_coder",
        }),
      );
    const unreadableText = run([
      regRecord("tabA:leafA", "CODER", "not-a-date"),
    ]);
    const noField = run([{ ...REG_CODER, launchedAt: undefined }]);
    const later = run([
      regRecord("tabA:leafA", "CODER", "2026-11-18T07:40:00.000Z"),
    ]);
    for (const [name, r] of [
      ["시각 문자열 불량", unreadableText],
      ["launchedAt 칸 없음", noField],
      ["등록이 늦음", later],
    ]) {
      assert.equal(r.exitCode, 0, name);
      assert.equal(r.json.verdict, "UNDECIDABLE", name);
    }
    assert.equal(unreadableText.json.reason, "PANE_LAUNCHED_AT_UNREADABLE");
    assert.equal(noField.json.reason, "PANE_LAUNCHED_AT_UNREADABLE");
    assert.equal(later.json.reason, "PANE_REGISTERED_AFTER_DELIVERY");

    // 섞인 경우: 읽을 수 있는 «늦은» 등록이 하나라도 있으면 «늦음» · 읽을 수 있는 «앞선» 등록이 있으면 MATCH.
    const mixedLater = run([
      regRecord("tabA:leafA", "CODER", "not-a-date"),
      regRecord("tabA:leafA", "CODER", "2026-11-18T07:40:00.000Z"),
    ]);
    assert.equal(mixedLater.json.verdict, "UNDECIDABLE");
    assert.equal(mixedLater.json.reason, "PANE_REGISTERED_AFTER_DELIVERY");
    const mixedEarly = run([
      regRecord("tabA:leafA", "CODER", "not-a-date"),
      regRecord("tabA:leafA", "CODER", "2026-11-18T07:30:00.000Z"),
    ]);
    assert.equal(mixedEarly.json.verdict, "MATCH");
  });
});

test("지난 자료 집계(S1)는 시각 불량 등록의 사유 문자열을 바꾸지 않는다 (ⓓ 가 집계로 번지지 않았다는 무회귀)", () => {
  const v = classifyReceiptBinding(
    {
      dispatch_id: "ctx_x",
      role: "CODER",
      assignee_pane_key: "tabA:leafA",
      recorded_at: "2026-11-18T07:35:35.000Z",
    },
    [regRecord("tabA:leafA", "CODER", "not-a-date")],
  );
  assert.equal(v.verdict, "UNDECIDABLE");
  assert.equal(v.reason, "PANE_NOT_REGISTERED_AT_DISPATCH");
});

test("record-only: 등록부에 그 pane 이 없다 = UNDECIDABLE PANE_NOT_IN_REGISTRY", () => {
  withTempDir((dir) => {
    const r = runRecordOnly(
      baseArgs(dir, {
        terminals: [SEAT_CODER],
        records: [REG_REVIEW],
        handle: "term_coder",
      }),
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.json.verdict, "UNDECIDABLE");
    assert.equal(r.json.reason, "PANE_NOT_IN_REGISTRY");
  });
});

test("record-only: 오류 입력(깨진 terminal list · 모르는 역할 · 필수 인자 누락 · 시각 불량)도 종료코드 0 + ERROR JSON", () => {
  withTempDir((dir) => {
    const badList = join(dir, "bad.json");
    writeFileSync(badList, "{not json");
    const reg = writeRegistry(dir, [REG_CODER]);
    const cases = [
      {
        name: "terminal list 깨짐",
        args: [
          "--terminal-list",
          badList,
          "--worktree",
          WORKTREE,
          "--role",
          "CODER",
          "--registry-path",
          reg,
        ],
        reason: "TERMINAL_LIST_INVALID",
      },
      {
        name: "모르는 역할",
        args: [
          "--terminal-list",
          writeList(dir, [SEAT_CODER]),
          "--worktree",
          WORKTREE,
          "--role",
          "NOBODY",
          "--registry-path",
          reg,
        ],
        reason: "INVALID_ROLE",
      },
      {
        name: "필수 인자 누락",
        args: ["--worktree", WORKTREE],
        reason: "RECORD_ONLY_ARGS_MISSING",
      },
      {
        name: "모르는 인자",
        args: ["--no-such-flag", "x"],
        reason: "RECORD_ONLY_ARGS_INVALID",
      },
      {
        name: "배달 시각 불량",
        args: [
          "--terminal-list",
          writeList(dir, [SEAT_CODER]),
          "--worktree",
          WORKTREE,
          "--role",
          "CODER",
          "--registry-path",
          reg,
          "--delivered-at-ms",
          "yesterday",
        ],
        reason: "DELIVERED_AT_INVALID",
      },
    ];
    for (const c of cases) {
      const r = runRecordOnly(c.args);
      assert.equal(r.exitCode, 0, `${c.name}: exit=${r.exitCode}`);
      assert.ok(r.json, `${c.name}: JSON 없음 -- ${r.stdout}`);
      assert.equal(r.json.verdict, "ERROR", c.name);
      assert.equal(r.json.reason, c.reason, c.name);
    }
  });
});

test("record-only 없이(S1 모드) 같은 오류 입력은 여전히 비0 -- S1 계약 무변", () => {
  const r = spawnSync(process.execPath, [BIND_CLI, "--worktree", WORKTREE], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.ok(!(r.stdout ?? "").includes('{"seat_bind"'));
});

// 제목 정정(S2 후속 정리): 예전 제목은 «전수» 라고 했지만 3모양뿐이었다. 지금은 열거한 «5모양»만
// 주장하고(전수가 아니다 -- 후보 형태 전체 목록이 아니다), 빠져 있던 두 모양(등록은 있으나 화면이
// 셸 프롬프트인 좌석 · 이 워크트리에 좌석이 없음)을 «추가»했다. 단언도 «MATCH 아님» 에서
// «UNDECIDABLE + 그 사유» 로 좁혔다.
test("판정 불가는 일치로 접히지 않는다 -- 열거한 5가지 후보 모양(전수 아님)이 전부 UNDECIDABLE · 사유까지 값으로 고정", () => {
  const SEAT_DEAD_REGISTERED = seat(
    "term_dead",
    "tabA",
    "leafA",
    BLANK_SHELL_PREVIEW,
  );
  const shapes = [
    {
      name: "미등록 에이전트처럼 보이는 좌석 (등록부 공백)",
      terminals: [SEAT_CODER],
      records: [],
      handle: "term_coder",
      reason: "REGISTRY_EMPTY",
    },
    {
      name: "등록부에 없는 pane",
      terminals: [SEAT_CODER],
      records: [REG_REVIEW],
      handle: "term_coder",
      reason: "PANE_NOT_IN_REGISTRY",
    },
    {
      name: "빈 셸만",
      terminals: [SEAT_BLANK],
      records: [REG_CODER],
      handle: "term_blank",
      reason: "PANE_NOT_IN_REGISTRY",
    },
    {
      name: "등록은 있으나 화면이 셸 프롬프트인 좌석 (죽은 좌석)",
      terminals: [SEAT_DEAD_REGISTERED],
      records: [REG_CODER],
      handle: "term_dead",
      reason: "HANDLE_SEAT_NOT_LIVE_AGENT",
    },
    {
      name: "이 워크트리에 좌석이 없음",
      terminals: [],
      records: [REG_CODER],
      handle: "term_coder",
      reason: "NO_SEAT_IN_WORKTREE",
    },
  ];
  assert.equal(shapes.length, 5);
  for (const s of shapes) {
    const d = decideSeatBindAtDelivery({
      terminals: s.terminals,
      worktree: WORKTREE,
      role: "CODER",
      registryRecords: s.records,
      handle: s.handle,
      deliveredAtMs: DELIVERED_MS,
    });
    assert.notEqual(d.verdict, DELIVERY_BIND_VERDICT.MATCH, s.name);
    assert.equal(d.verdict, DELIVERY_BIND_VERDICT.UNDECIDABLE, s.name);
    assert.equal(d.reason, s.reason, s.name);
  }
});

// ---- ⑷ correction 키 건너뛰기는 «지난 자료 집계»에만 -----------------------

test("배달 순간 경로: correction* 키가 있는 입력도 건너뛰지 않는다 (불일치는 그대로 MISMATCH)", () => {
  withTempDir((dir) => {
    const reviewSeatWithCorrection = seat(
      "term_review",
      "tabB",
      "leafB",
      REVIEW_PREVIEW,
      { correction_note: "hand corrected" },
    );
    const regWithCorrection = {
      ...REG_REVIEW,
      correction_reason: "hand corrected registry line",
    };
    const r = runRecordOnly(
      baseArgs(dir, {
        terminals: [reviewSeatWithCorrection],
        records: [regWithCorrection],
        role: "CODER",
        handle: "term_review",
      }),
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.json.verdict, "MISMATCH");
    assert.notEqual(r.json.reason, "HAND_CORRECTION");
    assert.ok(!/SKIPPED/i.test(JSON.stringify(r.json)));
  });
});

test("배달 순간 경로: correction 키가 있는 일치 입력도 MATCH (건너뛰어 UNDECIDABLE 로 접히지 않는다)", () => {
  const d = decideSeatBindAtDelivery({
    terminals: [
      seat("term_coder", "tabA", "leafA", CODER_PREVIEW, { correction_x: 1 }),
    ],
    worktree: WORKTREE,
    role: "CODER",
    registryRecords: [{ ...REG_CODER, correctionNote: "x" }],
    handle: "term_coder",
    deliveredAtMs: DELIVERED_MS,
  });
  assert.equal(d.verdict, "MATCH");
});

test("지난 자료 집계는 correction 건너뛰기를 그대로 유지한다 (집계 전용으로 남음)", () => {
  const v = classifyReceiptBinding(
    {
      dispatch_id: "ctx_x",
      role: "CODER",
      assignee_pane_key: "tabA:leafA",
      recorded_at: "2026-11-18T07:35:35.000Z",
      correction_reason: "hand",
    },
    [REG_CODER],
  );
  assert.equal(v.verdict, "SKIPPED_CORRECTION");
});

test("구조 고정: 배달 순간 진입점 소스에는 classifyReceiptBinding · correction 건너뛰기가 없다", () => {
  const src = readFileSync(BIND_CORE_SRC, "utf8");
  const start = src.indexOf("export function decideSeatBindAtDelivery");
  assert.ok(start > 0, "decideSeatBindAtDelivery 가 없다");
  // 다음 export 직전까지가 배달 순간 구역(자기 토막만 본다).
  const rest = src.slice(start + 10);
  const nextExport = rest.search(/\nexport /);
  const body = nextExport === -1 ? rest : rest.slice(0, nextExport);
  assert.ok(!body.includes("classifyReceiptBinding"));
  assert.ok(!/startsWith\(\s*["']correction/.test(body));
  assert.ok(!/HAND_CORRECTION|SKIPPED_CORRECTION/.test(body));
});

// ---- 새 칸이 390 그림자 · 인자 계약과 부딪히지 않는다 (값으로) --------------

test("새 영수증 칸 이름은 correction 으로 시작하지 않고 기존 칸과 겹치지 않는다 (390 그림자 대조 입력 무충돌)", () => {
  withTempDir((dir) => {
    const withNew = runReceipt(dir, [
      "--seat-bind-verdict",
      "UNDECIDABLE",
      "--seat-bind-reason",
      "REGISTRY_EMPTY",
      "--seat-bind-candidates",
      "tabA:leafA=CODER/REGISTERED_AGENT",
    ]);
    const without = runReceipt(dir, [], { receiptName: "base.jsonl" });
    const added = Object.keys(withNew.row).filter((k) => !(k in without.row));
    assert.deepEqual(added.sort(), [
      "seat_bind_candidates",
      "seat_bind_reason",
      "seat_bind_verdict",
    ]);
    assert.ok(added.every((k) => !k.startsWith("correction")));
    // 그림자가 읽는 칸(dispatch_id · runtime_task_id · assignee_pane_key) 값은 새 인자 유무와 무관.
    for (const k of ["dispatch_id", "runtime_task_id", "assignee_pane_key"]) {
      assert.equal(withNew.row[k], without.row[k]);
    }
  });
});

// ---- 설치기 복사 목록 (#378 폐쇄 시험 기준) ---------------------------------

test("설치기: 새 두 파일이 relay 복사 목록에 있고 그 import 는 이미 check 목록에 있다", () => {
  for (const name of [
    "seat-role-bind-cli.mjs",
    "seat-role-bind-core.mjs",
    "seat-role-bind-cli.test.mjs",
  ]) {
    assert.ok(ENFORCEMENT_RELAY_FILES.includes(name), `${name} 가 목록에 없다`);
  }
  for (const dep of [
    "seat-origin-registry.mjs",
    "engine-profile.mjs",
    "engine-profiles.json",
  ]) {
    assert.ok(
      ENFORCEMENT_CHECK_FILES.includes(dep),
      `${dep} 가 check 목록에 없다`,
    );
  }
});

test("설치기 외부 경로 호출 가드: 패치 문서의 by-path 호출이 추출되고 복사 목록 위반 0", () => {
  const callers = extractExternalPathCallers();
  const mine = callers.filter((c) => c.file === "HYK-402-seat-role-bind-s2.md");
  assert.ok(
    mine.some((c) => c.rel === "scripts/relay/seat-role-bind-cli.mjs"),
    "S2 패치 문서가 bind CLI 를 by-path 로 부르는 줄이 추출돼야 한다",
  );
  assert.deepEqual(findCallerViolations(callers), []);
});

// ---- ps1 패치 블록 -- 합성 사본 · PowerShell 파서 오류 0 --------------------

function findPwsh() {
  for (const exe of ["pwsh", "powershell"]) {
    const r = spawnSync(
      exe,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$PSVersionTable.PSVersion.Major",
      ],
      { encoding: "utf8" },
    );
    if (r.status === 0) return exe;
  }
  return null;
}

// 패치 문서에서 «편집 N» 절의 앵커 줄(첫 코드펜스)과 삽입 블록(둘째 코드펜스)을 꺼낸다.
function readPatchBlocks() {
  const doc = readFileSync(PATCH_DOC, "utf8");
  const sections = {};
  const re = /^## 편집 ([ABC])[^\n]*\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(doc))) {
    const fences = [...m[2].matchAll(/```powershell\n([\s\S]*?)```/g)].map(
      (f) => f[1].replace(/\s+$/, ""),
    );
    sections[m[1]] = fences;
  }
  return sections;
}

// 합성 ps1 사본: 앵커 줄만 실물과 같은 모양으로 갖춘 껍데기(관제실 파일은 읽지도 않는다).
function buildSyntheticPs1(blocks) {
  const [anchorA, insertA] = blocks.A;
  const [anchorB, insertB] = blocks.B;
  return [
    "param([string]$Task, [string]$Worktree, [string]$Handle, [string]$ReceiptPath, [ValidateSet('CODER','REVIEW','VERIFY','PM')][string]$Role = 'CODER')",
    '$ErrorActionPreference = "Stop"',
    "$list = $null",
    '$handle = "term_coder"',
    "function Record-DispatchReceipt($dispatchOut, [string]$cliPath, [string]$role, [string]$label, [string]$receiptPath) {",
    anchorB,
    insertB,
    "  $receiptOut = ($dispatchOut | ConvertTo-Json -Depth 10 -Compress) | & node @cliArgs 2>&1",
    '  Write-Host "      $receiptOut"',
    '  if ($LASTEXITCODE -ne 0) { Write-Error "RECEIPT_FAILED (위 출력 참고)" }',
    "}",
    insertA,
    anchorA,
    "",
  ].join("\n");
}

test("패치 문서: 편집 A · B 두 블록이 문서에 있고 앵커가 한 줄이다", () => {
  const blocks = readPatchBlocks();
  for (const k of ["A", "B"]) {
    assert.ok(
      blocks[k] && blocks[k].length >= 2,
      `편집 ${k} 코드펜스 2개 필요`,
    );
    assert.equal(blocks[k][0].split("\n").length, 1, `편집 ${k} 앵커는 한 줄`);
  }
});

test("패치 문서: 삽입 블록에 exit · throw · Write-Error 가 없다 (배달을 막는 경로 0)", () => {
  const blocks = readPatchBlocks();
  for (const k of ["A", "B"]) {
    const code = blocks[k][1];
    assert.ok(
      !/(^|[^\w-])exit\b/im.test(code.replace(/#.*$/gm, "")),
      `편집 ${k}: exit`,
    );
    assert.ok(
      !/\bthrow\b/i.test(code.replace(/#.*$/gm, "")),
      `편집 ${k}: throw`,
    );
    assert.ok(
      !/Write-Error/i.test(code.replace(/#.*$/gm, "")),
      `편집 ${k}: Write-Error`,
    );
  }
});

test("합성 ps1 사본에 패치 블록을 적용하면 PowerShell 파서 오류 0 (pwsh 없으면 사유 있는 skip)", (t) => {
  const exe = findPwsh();
  if (!exe) {
    t.skip(
      "pwsh/powershell 이 이 기계에 없다 -- 파서 검증 불가(사유: 실행기 부재)",
    );
    return;
  }
  const blocks = readPatchBlocks();
  withTempDir((dir) => {
    const ps1 = join(dir, "synthetic-dispatch-worker.ps1");
    writeFileSync(ps1, "\uFEFF" + buildSyntheticPs1(blocks), "utf8");
    const parseCmd =
      `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${ps1.replace(/'/g, "''")}',[ref]$t,[ref]$e);` +
      "if($e.Count -gt 0){$e|ForEach-Object{'PARSE_ERROR: '+$_.Message+' @'+$_.Extent.StartLineNumber};exit 3}else{'PARSE_OK'}";
    const r = spawnSync(
      exe,
      ["-NoProfile", "-NonInteractive", "-Command", parseCmd],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /PARSE_OK/);
  });
});

// 블록 A 를 합성 ps1 조각으로 자식 pwsh 에서 «실행»한다(공용 -- 두 «실행» 칸이 같이 쓴다).
// stripTempEnv = 자식 «안»에서만 TEMP · TMP · TMPDIR 을 지운다(Linux pwsh 와 같은 모양).
// spawn 의 env 로 지우지 않는 이유: Windows 의 node(libuv)가 자식 env 에서 빠진 TEMP 를
// 되살려 준다(2026-11-18 이 기계 실측) -- 그러면 가정이 안 깨져 헛시험이 된다. 네 셸 ·
// 사용자 · 시스템 환경은 건드리지 않는다(자식 프로세스 env 만).
function runBlockAChild(
  exe,
  blocks,
  dir,
  worktree,
  { stripTempEnv = false, tempSeamDir = null, failDelete = false } = {},
) {
  // 배달기와 같은 전제: terminal list 의 좌석 worktreePath 가 $Worktree 와 같다.
  const terminals = {
    ok: true,
    result: { terminals: [{ ...SEAT_CODER, worktreePath: worktree }] },
  };
  const script = [
    stripTempEnv
      ? "foreach ($n in 'TEMP','TMP','TMPDIR') { Remove-Item -LiteralPath \"Env:$n\" -ErrorAction SilentlyContinue }"
      : "",
    // 임시 폴더 seam: 자식 pwsh «안»에서만 세 변수를 합성 폴더로 돌린다(Windows = TMP/TEMP ·
    // Linux = TMPDIR 을 .NET 이 읽는다 -- 세 변수를 다 맞춰 플랫폼 가정을 두지 않는다).
    tempSeamDir
      ? `$env:TEMP='${tempSeamDir.replace(/'/g, "''")}'; $env:TMP='${tempSeamDir.replace(/'/g, "''")}'; $env:TMPDIR='${tempSeamDir.replace(/'/g, "''")}'`
      : "",
    // 삭제 실패 seam: 함수는 cmdlet 보다 먼저 해석된다 -- 블록 A 의 Remove-Item 호출이 «종료 오류»로 실패한다.
    // (위의 변수 정리 줄이 이미 지나간 뒤에 정의한다.)
    failDelete
      ? 'function Remove-Item { [CmdletBinding()] param([string]$LiteralPath, [switch]$Force) throw "synthetic delete failure" }'
      : "",
    `$Task='task_synth'; $Worktree='${worktree.replace(/'/g, "''")}'; $Role='CODER'; $handle='term_coder'`,
    `$PSScriptRoot_override='${dir.replace(/'/g, "''")}'`,
    `$list = '${JSON.stringify(terminals).replace(/'/g, "''")}' | ConvertFrom-Json`,
    'Write-Output "ENV TEMP=[$($env:TEMP)] TMP=[$($env:TMP)] TMPDIR=[$($env:TMPDIR)]"',
    blocks.A[1].replace(/\$PSScriptRoot/g, "$PSScriptRoot_override"),
    'Write-Output "RESULT verdict=$($script:seatBindVerdict) reason=$($script:seatBindReason)"',
    'Write-Output "CONTINUED"',
  ].join("\n");
  return spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 90_000,
  });
}

test("합성 ps1 사본 · 블록 A 를 «실행»하면 판정이 변수에 담기고 CLI 부재는 UNDECIDABLE 로 기록 후 계속된다", (t) => {
  const exe = findPwsh();
  if (!exe) {
    t.skip(
      "pwsh/powershell 이 이 기계에 없다 -- 실행 검증 불가(사유: 실행기 부재)",
    );
    return;
  }
  const blocks = readPatchBlocks();
  withTempDir((dir) => {
    const registry = writeRegistry(
      dir,
      [REG_CODER],
      "seat-launch-registry.jsonl",
    );
    const runBlock = (worktree) => runBlockAChild(exe, blocks, dir, worktree);
    // (가) 실물 CLI 가 있는 워크트리(이 저장소) -- 등록부는 합성 사본(dir)
    const ok = runBlock(REPO_ROOT);
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /RESULT verdict=MATCH reason=ROLE_MATCH/);
    assert.match(ok.stdout, /CONTINUED/);
    // (나) CLI 가 없는 워크트리 -> UNDECIDABLE 후 계속
    const noCli = runBlock(join(dir, "empty-worktree"));
    assert.equal(noCli.status, 0, `${noCli.stdout}${noCli.stderr}`);
    assert.match(
      noCli.stdout,
      /RESULT verdict=UNDECIDABLE reason=SEAT_BIND_CLI_MISSING/,
    );
    assert.match(noCli.stdout, /CONTINUED/);
    assert.ok(existsSync(registry));
  });
});

// PR 383 CI(ubuntu · pwsh) 빨강의 원인 칸 -- 블록 A 가 `$env:TEMP` 를 가정했다.
// Linux pwsh 에는 TEMP · TMP 가 없다(TMPDIR 도 보통 없다). 그 모양을 Windows 에서
// 자식 pwsh «안»에서 변수를 지워 만든다 -- Linux 실행은 못 한다(WSL 0), 모양 흉내만.
// 기대값은 «값»으로 고정한다(조용한 skip 아님): 임시 폴더 변수가 없어도 MATCH/ROLE_MATCH.
test("합성 ps1 사본 · 임시 폴더 환경 변수(TEMP · TMP · TMPDIR)가 없는 자식 pwsh(Linux 와 같은 모양)에서도 블록 A 가 MATCH 로 기록 후 계속된다", (t) => {
  const exe = findPwsh();
  if (!exe) {
    t.skip(
      "pwsh/powershell 이 이 기계에 없다 -- 실행 검증 불가(사유: 실행기 부재)",
    );
    return;
  }
  const blocks = readPatchBlocks();
  withTempDir((dir) => {
    writeRegistry(dir, [REG_CODER], "seat-launch-registry.jsonl");
    const ok = runBlockAChild(exe, blocks, dir, REPO_ROOT, {
      stripTempEnv: true,
    });
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
    // 가정이 «정말 깨졌는지» 먼저 확인한다(안 깨졌으면 이 칸은 헛시험이다).
    assert.match(ok.stdout, /ENV TEMP=\[\] TMP=\[\] TMPDIR=\[\]/);
    assert.match(ok.stdout, /RESULT verdict=MATCH reason=ROLE_MATCH/);
    assert.ok(
      !/BIND_CALL_FAILED/.test(ok.stdout),
      "임시 폴더 변수 부재가 BIND_CALL_FAILED 로 떨어지면 안 된다",
    );
    assert.match(ok.stdout, /CONTINUED/);
    // CLI 부재 갈래도 같은 조건에서 UNDECIDABLE 로 기록 후 계속(임시 폴더 코드에 닿기 전).
    const noCli = runBlockAChild(
      exe,
      blocks,
      dir,
      join(dir, "empty-worktree"),
      {
        stripTempEnv: true,
      },
    );
    assert.equal(noCli.status, 0, `${noCli.stdout}${noCli.stderr}`);
    assert.match(noCli.stdout, /ENV TEMP=\[\] TMP=\[\] TMPDIR=\[\]/);
    assert.match(
      noCli.stdout,
      /RESULT verdict=UNDECIDABLE reason=SEAT_BIND_CLI_MISSING/,
    );
    assert.match(noCli.stdout, /CONTINUED/);
  });
});

// ---- S2 후속 정리 (HYK-402-s2-cleanup-1): 블록 A 가 임시 목록 파일을 «남기지 않는다» ----
// 임시 폴더를 합성 폴더로 돌려(tempSeamDir) 블록 A 실행 뒤 그 폴더를 «직접» 본다.
// 두 칸은 짝이다: 삭제 실패 seam 칸이 «파일이 그 폴더에 실제로 써진다»를 증명하므로
// 정상 칸의 «없음» 이 «애초에 안 썼다» 로 비는 헛시험이 되지 않는다.
const SEAT_BIND_TEMP_LIST_NAME =
  "hyk402-seat-bind-task_synth-terminal-list.json";

function seamFiles(seamDir) {
  return readdirSync(seamDir).filter((n) => n.startsWith("hyk402-seat-bind-"));
}

test("블록 A «실행» 뒤 임시 목록 파일이 남지 않는다 (임시 폴더를 합성 폴더로 돌린 자식 pwsh · 판정은 MATCH 그대로)", (t) => {
  const exe = findPwsh();
  if (!exe) {
    t.skip(
      "pwsh/powershell 이 이 기계에 없다 -- 실행 검증 불가(사유: 실행기 부재)",
    );
    return;
  }
  const blocks = readPatchBlocks();
  withTempDir((dir) => {
    writeRegistry(dir, [REG_CODER], "seat-launch-registry.jsonl");
    const seam = join(dir, "seam-tmp");
    mkdirSync(seam);
    const r = runBlockAChild(exe, blocks, dir, REPO_ROOT, {
      tempSeamDir: seam,
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /RESULT verdict=MATCH reason=ROLE_MATCH/);
    assert.match(r.stdout, /CONTINUED/);
    assert.deepEqual(
      seamFiles(seam),
      [],
      `임시 목록 파일이 남았다: ${seamFiles(seam).join(",")}`,
    );
    assert.ok(!r.stdout.includes("TEMP_LIST_DELETE_FAILED"), r.stdout);
  });
});

test("블록 A «실행» · 임시 목록 파일 삭제가 실패해도 배달은 무정지 -- 판정 그대로 · 기록만 · CONTINUED (삭제 실패 seam)", (t) => {
  const exe = findPwsh();
  if (!exe) {
    t.skip(
      "pwsh/powershell 이 이 기계에 없다 -- 실행 검증 불가(사유: 실행기 부재)",
    );
    return;
  }
  const blocks = readPatchBlocks();
  withTempDir((dir) => {
    writeRegistry(dir, [REG_CODER], "seat-launch-registry.jsonl");
    const seam = join(dir, "seam-tmp");
    mkdirSync(seam);
    const r = runBlockAChild(exe, blocks, dir, REPO_ROOT, {
      tempSeamDir: seam,
      failDelete: true,
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    // 삭제 실패는 판정을 덮어쓰지 않는다(BIND_CALL_FAILED 로 떨어지면 안 된다).
    assert.match(r.stdout, /RESULT verdict=MATCH reason=ROLE_MATCH/);
    assert.ok(!/BIND_CALL_FAILED/.test(r.stdout), r.stdout);
    assert.match(r.stdout, /TEMP_LIST_DELETE_FAILED/);
    assert.match(r.stdout, /CONTINUED/);
    // seam 이 «진짜로 파일이 써진 폴더»임을 확인 -- 위 정상 칸의 «없음» 이 헛시험이 아니라는 짝 증거.
    assert.ok(
      existsSync(join(seam, SEAT_BIND_TEMP_LIST_NAME)),
      "삭제 실패 seam 에서 파일이 seam 폴더에 있어야 한다(없으면 정상 칸의 «없음» 이 헛시험)",
    );
  });
});

test("패치 문서 블록 B를 «실행»하면 영수증 CLI 에 새 인자가 실려 영수증에 칸이 남는다 · 새 인자를 모르는 CLI 면 인자를 빼고 계속", (t) => {
  const exe = findPwsh();
  if (!exe) {
    t.skip(
      "pwsh/powershell 이 이 기계에 없다 -- 실행 검증 불가(사유: 실행기 부재)",
    );
    return;
  }
  const blocks = readPatchBlocks();
  withTempDir((dir) => {
    const oldCli = join(dir, "old-receipt-cli.mjs");
    writeFileSync(
      oldCli,
      "// pre-S2 stand-in: does not know the new flags\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log('OLD_CLI_OK '+process.argv.slice(2).join(' '))});\n",
    );
    const run = (cliPath, receipt) => {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `$Worktree='${dir.replace(/'/g, "''")}'`,
        "$script:seatBindVerdict='UNDECIDABLE'; $script:seatBindReason='REGISTRY_EMPTY'; $script:seatBindCandidates='tabA:leafA=CODER/REGISTERED_AGENT'",
        "function Record-DispatchReceipt($dispatchOut, [string]$cliPath, [string]$role, [string]$label, [string]$receiptPath) {",
        '  $cliArgs = @($cliPath, "--role", $role, "--task-label", $label, "--receipt-path", $receiptPath)',
        blocks.B[1],
        "  $receiptOut = ($dispatchOut | ConvertTo-Json -Depth 10 -Compress) | & node @cliArgs 2>&1",
        '  Write-Output "OUT: $receiptOut"',
        "}",
        `$o = '${DISPATCH_OK.replace(/'/g, "''")}' | ConvertFrom-Json`,
        `Record-DispatchReceipt $o '${cliPath.replace(/'/g, "''")}' 'CODER' 'HYK-S2-synth-1' '${receipt.replace(/'/g, "''")}'`,
        'Write-Output "DONE_B"',
      ].join("\n");
      return spawnSync(
        exe,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          timeout: 90_000,
        },
      );
    };
    const receiptNew = join(dir, "r-new.jsonl");
    const rNew = run(RECEIPT_CLI, receiptNew);
    assert.equal(rNew.status, 0, `${rNew.stdout}${rNew.stderr}`);
    const row = JSON.parse(readFileSync(receiptNew, "utf8").trim());
    assert.equal(row.seat_bind_verdict, "UNDECIDABLE");
    assert.equal(row.seat_bind_reason, "REGISTRY_EMPTY");
    assert.match(row.seat_bind_candidates, /tabA:leafA=CODER/);

    const rOld = run(oldCli, join(dir, "r-old.jsonl"));
    assert.equal(rOld.status, 0, `${rOld.stdout}${rOld.stderr}`);
    assert.match(rOld.stdout, /OLD_CLI_OK/);
    assert.ok(
      !rOld.stdout.includes("--seat-bind-verdict"),
      "옛 CLI 에 새 인자를 넘기면 안 된다",
    );
    assert.match(rOld.stdout, /DONE_B/);
    mkdirSync(join(dir, "x"), { recursive: true });
  });
});

test("보조: parseTerminalListText 가 ConvertTo-Json 모양({ok,result:{terminals}})을 받는다", () => {
  const p = parseTerminalListText(
    JSON.stringify({ ok: true, result: { terminals: [SEAT_CODER] } }),
  );
  assert.equal(p.ok, true);
});
