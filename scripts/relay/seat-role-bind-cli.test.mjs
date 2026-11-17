import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEAT_BIND_REASON,
  looksLikeAgentPreview,
  lookupRegisteredRole,
  classifyReceiptBinding,
  summarizeReceiptBindings,
  selectRoleBoundSeat,
} from "./seat-role-bind-core.mjs";

// HYK-402 S1 (seat-role-s1-1): 역할 결속 좌석 선별 코어 + CLI + 영수증 칸.
// 시험은 전부 «합성» 입력이다 -- mkdtemp 아래 합성 terminal list JSON ·
// 합성 등록부 jsonl · 합성 영수증 원장. 실제 `orca` 실행 0 · 관제실 파일
// 접근 0. CLI 는 자식 프로세스로 구동하고 stdout · 종료코드를 단언한다
// (헛시험 금지: helper 함수만 부르는 시험은 이 파일의 «보조» 시험일 뿐이다).

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const BIND_CLI = join(THIS_DIR, "seat-role-bind-cli.mjs");
const RECEIPT_CLI = join(THIS_DIR, "dispatch-receipt-cli.mjs");

const WORKTREE = "C:/Users/Synthetic/orca/workspaces/PROJ/wt-one";

const CODER_PREVIEW = "Opus 4.7 · bypass permissions on (shift+tab to cycle)";
const REVIEW_PREVIEW = "gpt-5.6 high · MCP startup complete";
const BLANK_SHELL_PREVIEW = "Windows PowerShell\r\nPS C:\\Users\\Synthetic> ";

function seat(handle, tabId, leafId, preview, worktreePath = WORKTREE) {
  return {
    handle,
    tabId,
    leafId,
    worktreePath,
    title: "synthetic",
    preview,
  };
}

const SEAT_CODER = seat("term_coder", "tabA", "leafA", CODER_PREVIEW);
const SEAT_REVIEW = seat("term_review", "tabB", "leafB", REVIEW_PREVIEW);
const SEAT_BLANK = seat("term_blank", "tabC", "leafC", BLANK_SHELL_PREVIEW);
const SEAT_UNREGISTERED_AGENT = seat(
  "term_ghost",
  "tabG",
  "leafG",
  CODER_PREVIEW,
);

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

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk402-s1-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTerminalList(dir, terminals, { bare = false, bom = false } = {}) {
  const path = join(dir, "terminal-list.json");
  const body = JSON.stringify(
    bare ? terminals : { ok: true, result: { terminals } },
  );
  writeFileSync(path, (bom ? "\uFEFF" : "") + body, "utf8");
  return path;
}

function writeRegistry(dir, records) {
  const path = join(dir, "registry.jsonl");
  writeFileSync(
    path,
    records
      .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
      .join("\n") + (records.length > 0 ? "\n" : ""),
    "utf8",
  );
  return path;
}

function runBind(args) {
  const r = spawnSync(process.execPath, [BIND_CLI, ...args], {
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function bindArgs({ list, registry, role, worktree = WORKTREE, handle }) {
  const args = [
    "--terminal-list",
    list,
    "--worktree",
    worktree,
    "--role",
    role,
    "--registry-path",
    registry,
  ];
  if (handle) args.push("--handle", handle);
  return args;
}

// --- T1~T5: 선별 CLI (자식 프로세스 · stdout · 종료코드) -------------------

test("T1: 등록된 에이전트 2개(CODER·REVIEW) -> 어느 역할을 요청하든 MULTI_AGENT_SEAT_IN_WORKTREE + 두 pane=role 나열", () => {
  withTempDir((dir) => {
    const list = writeTerminalList(dir, [SEAT_CODER, SEAT_REVIEW]);
    const registry = writeRegistry(dir, [REG_CODER, REG_REVIEW]);
    for (const role of ["REVIEW", "CODER"]) {
      const r = runBind(bindArgs({ list, registry, role }));
      assert.notEqual(r.status, 0, `role=${role}`);
      assert.ok(
        r.stdout.includes("REFUSED reason=MULTI_AGENT_SEAT_IN_WORKTREE"),
        r.stdout,
      );
      assert.ok(r.stdout.includes("pane=tabA:leafA role=CODER"), r.stdout);
      assert.ok(r.stdout.includes("pane=tabB:leafB role=REVIEW"), r.stdout);
      assert.ok(!r.stdout.includes("SELECTED"), r.stdout);
    }
  });
});

test("T2: REVIEW 좌석 1개만 있는데 CODER 요청 -> ROLE_MISMATCH (이번 사고 모양)", () => {
  withTempDir((dir) => {
    const list = writeTerminalList(dir, [SEAT_REVIEW]);
    const registry = writeRegistry(dir, [REG_REVIEW]);
    const r = runBind(bindArgs({ list, registry, role: "CODER" }));
    assert.notEqual(r.status, 0);
    assert.ok(r.stdout.includes("REFUSED reason=ROLE_MISMATCH"), r.stdout);
    assert.ok(r.stdout.includes("pane=tabB:leafB role=REVIEW"), r.stdout);
    assert.ok(!r.stdout.includes("SELECTED"), r.stdout);
  });
});

test("T3: 미등록인데 preview 가 에이전트처럼 보이는 좌석 + 등록 CODER 1개 -> UNREGISTERED_AGENT 거부", () => {
  withTempDir((dir) => {
    const list = writeTerminalList(dir, [SEAT_CODER, SEAT_UNREGISTERED_AGENT]);
    const registry = writeRegistry(dir, [REG_CODER]);
    const r = runBind(bindArgs({ list, registry, role: "CODER" }));
    assert.notEqual(r.status, 0);
    assert.ok(r.stdout.includes("REFUSED reason=UNREGISTERED_AGENT"), r.stdout);
    assert.ok(r.stdout.includes("pane=tabG:leafG role=UNREGISTERED"), r.stdout);
    assert.ok(!r.stdout.includes("SELECTED"), r.stdout);
  });
});

test("T4: 등록 CODER 1개 + 빈 pwsh 탭(미등록 · 마커 없음) -> SELECTED (D12 회귀 방지)", () => {
  withTempDir((dir) => {
    const list = writeTerminalList(dir, [SEAT_BLANK, SEAT_CODER]);
    const registry = writeRegistry(dir, [REG_CODER]);
    const r = runBind(bindArgs({ list, registry, role: "CODER" }));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("SELECTED handle=term_coder"), r.stdout);
    assert.ok(r.stdout.includes("pane=tabA:leafA role=CODER"), r.stdout);
  });
});

test("T5: --handle 이 역할 불일치 좌석을 가리키면 HANDLE_ROLE_MISMATCH · 맞는 좌석을 가리키면 SELECTED", () => {
  withTempDir((dir) => {
    const list = writeTerminalList(dir, [SEAT_BLANK, SEAT_REVIEW]);
    const registry = writeRegistry(dir, [REG_REVIEW]);
    const bad = runBind(
      bindArgs({ list, registry, role: "CODER", handle: "term_review" }),
    );
    assert.notEqual(bad.status, 0);
    assert.ok(
      bad.stdout.includes("REFUSED reason=HANDLE_ROLE_MISMATCH"),
      bad.stdout,
    );
    const good = runBind(
      bindArgs({ list, registry, role: "REVIEW", handle: "term_review" }),
    );
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.ok(good.stdout.includes("SELECTED handle=term_review"), good.stdout);
  });
});

// --- T6: 영수증 CLI (자식 프로세스) ----------------------------------------

function dispatchResponse() {
  return JSON.stringify({
    ok: true,
    result: {
      dispatch: {
        id: "ctx_syn1",
        task_id: "task_syn1",
        assignee_pane_key: "tabA:leafA",
        dispatched_at: "2026-11-17 00:00:00",
      },
    },
  });
}

function runReceipt(args, stdin = dispatchResponse()) {
  const r = spawnSync(process.execPath, [RECEIPT_CLI, ...args], {
    encoding: "utf8",
    input: stdin,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("T6: 영수증 CLI --role CODER --bound-seat-role REVIEW -> 비0 · 원장에 쓴 줄 0", () => {
  withTempDir((dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    const r = runReceipt([
      "--role",
      "CODER",
      "--bound-seat-role",
      "REVIEW",
      "--task-label",
      "HYK-SYN-1",
      "--receipt-path",
      receiptPath,
    ]);
    assert.notEqual(r.status, 0);
    assert.ok(r.stdout.includes("FAILED"), r.stdout);
    assert.ok(r.stdout.includes("bound-seat-role"), r.stdout);
    assert.equal(
      existsSync(receiptPath),
      false,
      "no ledger line may be written",
    );
  });
});

test("영수증 CLI --bound-seat-role 이 --role 과 같으면(대소문자 무시) bound_seat_role 칸이 남는다", () => {
  withTempDir((dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    const r = runReceipt([
      "--role",
      "CODER",
      "--bound-seat-role",
      "coder",
      "--task-label",
      "HYK-SYN-1",
      "--receipt-path",
      receiptPath,
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("bound_seat_role=coder"), r.stdout);
    const lines = readFileSync(receiptPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).bound_seat_role, "coder");
  });
});

test("영수증 CLI --bound-seat-role 값이 비면 비0 · 원장 0줄", () => {
  withTempDir((dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    const r = runReceipt([
      "--role",
      "CODER",
      "--task-label",
      "HYK-SYN-1",
      "--receipt-path",
      receiptPath,
      "--bound-seat-role",
    ]);
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(receiptPath), false);
  });
});

test("영수증 CLI 인자 없음 무변: 기록 키 8개 그대로 · bound_seat_role 칸 없음 · RECORDED 줄에도 없음", () => {
  withTempDir((dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    const r = runReceipt([
      "--role",
      "CODER",
      "--task-label",
      "HYK-SYN-1",
      "--receipt-path",
      receiptPath,
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.startsWith("RECORDED dispatch_id=ctx_syn1"), r.stdout);
    assert.ok(!r.stdout.includes("bound_seat_role"), r.stdout);
    const rec = JSON.parse(readFileSync(receiptPath, "utf8").trim());
    assert.deepEqual(Object.keys(rec), [
      "recorded_at",
      "runtime_task_id",
      "dispatch_id",
      "assignee_pane_key",
      "dispatch_timestamp_utc",
      "dispatch_timestamp_source",
      "role",
      "harness_task_label",
    ]);
  });
});

// --- 선별 CLI 보조 경로 (입력 정규화 · 거부 사유 · 사용법) -----------------

test("워크트리 경로는 역슬래시 · 대소문자 · 끝 슬래시가 달라도 같은 워크트리로 본다", () => {
  withTempDir((dir) => {
    const list = writeTerminalList(dir, [SEAT_CODER]);
    const registry = writeRegistry(dir, [REG_CODER]);
    const r = runBind(
      bindArgs({
        list,
        registry,
        role: "coder",
        worktree: "c:\\users\\synthetic\\ORCA\\workspaces\\proj\\WT-ONE\\",
      }),
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("SELECTED handle=term_coder"), r.stdout);
  });
});

test("다른 워크트리 좌석 · 고아 좌석(worktreePath 빈 문자열)은 후보가 아니다", () => {
  withTempDir((dir) => {
    const other = seat(
      "term_other",
      "tabX",
      "leafX",
      REVIEW_PREVIEW,
      "C:/Users/Synthetic/orca/workspaces/PROJ/wt-two",
    );
    const orphan = seat("term_orphan", "tabY", "leafY", REVIEW_PREVIEW, "");
    const list = writeTerminalList(dir, [other, orphan, SEAT_CODER]);
    const registry = writeRegistry(dir, [
      REG_CODER,
      regRecord("tabX:leafX", "REVIEW"),
      regRecord("tabY:leafY", "REVIEW"),
    ]);
    const r = runBind(bindArgs({ list, registry, role: "CODER" }));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("SELECTED handle=term_coder"), r.stdout);
  });
});

test("후보 좌석 0개 -> NO_SEAT_IN_WORKTREE · 에이전트 좌석(등록 · 마커) 0개 -> NO_AGENT_SEAT", () => {
  withTempDir((dir) => {
    const registry = writeRegistry(dir, [REG_CODER]);
    const empty = runBind(
      bindArgs({
        list: writeTerminalList(dir, []),
        registry,
        role: "CODER",
      }),
    );
    assert.notEqual(empty.status, 0);
    assert.ok(
      empty.stdout.includes("REFUSED reason=NO_SEAT_IN_WORKTREE"),
      empty.stdout,
    );
    const blankOnly = runBind(
      bindArgs({
        list: writeTerminalList(dir, [SEAT_BLANK]),
        registry,
        role: "CODER",
      }),
    );
    assert.notEqual(blankOnly.status, 0);
    assert.ok(
      blankOnly.stdout.includes("REFUSED reason=NO_AGENT_SEAT"),
      blankOnly.stdout,
    );
  });
});

test("등록된 좌석이 D15 죽은 셸(preview 끝이 PS 프롬프트)이면 에이전트 좌석에서 뺀다", () => {
  withTempDir((dir) => {
    const deadReview = seat(
      "term_dead",
      "tabB",
      "leafB",
      "gpt-5.6 ... session ended\r\nPS C:\\Users\\Synthetic> ",
    );
    const list = writeTerminalList(dir, [SEAT_CODER, deadReview]);
    const registry = writeRegistry(dir, [REG_CODER, REG_REVIEW]);
    const r = runBind(bindArgs({ list, registry, role: "CODER" }));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("SELECTED handle=term_coder"), r.stdout);
  });
});

test("--handle 이 이 워크트리 좌석 목록에 없으면 HANDLE_NOT_IN_WORKTREE", () => {
  withTempDir((dir) => {
    const list = writeTerminalList(dir, [SEAT_CODER]);
    const registry = writeRegistry(dir, [REG_CODER]);
    const r = runBind(
      bindArgs({ list, registry, role: "CODER", handle: "term_nope" }),
    );
    assert.notEqual(r.status, 0);
    assert.ok(
      r.stdout.includes("REFUSED reason=HANDLE_NOT_IN_WORKTREE"),
      r.stdout,
    );
  });
});

test("--handle 이 미등록 좌석을 가리키면 HANDLE_SEAT_UNREGISTERED (역할을 확인할 수 없다)", () => {
  withTempDir((dir) => {
    const list = writeTerminalList(dir, [SEAT_BLANK]);
    const registry = writeRegistry(dir, [REG_CODER]);
    const r = runBind(
      bindArgs({ list, registry, role: "CODER", handle: "term_blank" }),
    );
    assert.notEqual(r.status, 0);
    assert.ok(
      r.stdout.includes("REFUSED reason=HANDLE_SEAT_UNREGISTERED"),
      r.stdout,
    );
  });
});

test("--handle 이 맞는 좌석을 가리켜도 같은 워크트리에 에이전트 좌석이 둘이면 거부한다(불변식은 handle 로 못 푼다)", () => {
  withTempDir((dir) => {
    const list = writeTerminalList(dir, [SEAT_CODER, SEAT_REVIEW]);
    const registry = writeRegistry(dir, [REG_CODER, REG_REVIEW]);
    const r = runBind(
      bindArgs({ list, registry, role: "CODER", handle: "term_coder" }),
    );
    assert.notEqual(r.status, 0);
    assert.ok(
      r.stdout.includes("REFUSED reason=MULTI_AGENT_SEAT_IN_WORKTREE"),
      r.stdout,
    );
  });
});

test("등록부가 없거나 읽을 수 없으면 REGISTRY_LOAD_FAILED 거부 · terminal list 가 깨졌으면 TERMINAL_LIST_INVALID 거부 (fail-closed)", () => {
  withTempDir((dir) => {
    const list = writeTerminalList(dir, [SEAT_CODER]);
    const noRegistry = runBind(
      bindArgs({ list, registry: join(dir, "absent.jsonl"), role: "CODER" }),
    );
    assert.notEqual(noRegistry.status, 0);
    assert.ok(
      noRegistry.stdout.includes("REFUSED reason=REGISTRY_LOAD_FAILED"),
      noRegistry.stdout,
    );
    const badListPath = join(dir, "bad-list.json");
    writeFileSync(badListPath, "{not json", "utf8");
    const registry = writeRegistry(dir, [REG_CODER]);
    const badList = runBind(
      bindArgs({ list: badListPath, registry, role: "CODER" }),
    );
    assert.notEqual(badList.status, 0);
    assert.ok(
      badList.stdout.includes("REFUSED reason=TERMINAL_LIST_INVALID"),
      badList.stdout,
    );
  });
});

test("terminal list 는 orca 원본 응답 · 맨 배열 · BOM 붙은 파일 모두 읽는다 / 손상된 등록부 줄은 건수로 드러난다", () => {
  withTempDir((dir) => {
    const registry = writeRegistry(dir, [REG_CODER, "{truncated"]);
    for (const opts of [{ bare: true }, { bom: true }, {}]) {
      const list = writeTerminalList(dir, [SEAT_CODER], opts);
      const r = runBind(bindArgs({ list, registry, role: "CODER" }));
      assert.equal(r.status, 0, JSON.stringify(opts) + r.stdout + r.stderr);
      assert.ok(r.stdout.includes("SELECTED handle=term_coder"), r.stdout);
      assert.ok(r.stdout.includes("registry_corrupted_lines=1"), r.stdout);
    }
  });
});

test("필수 인자 누락 · 모르는 역할은 사용법 오류(종료코드 2) · REFUSED 와 구분된다", () => {
  const noArgs = runBind([]);
  assert.equal(noArgs.status, 2);
  assert.ok(noArgs.stderr.includes("usage"), noArgs.stderr);
  withTempDir((dir) => {
    const list = writeTerminalList(dir, [SEAT_CODER]);
    const registry = writeRegistry(dir, [REG_CODER]);
    const badRole = runBind(bindArgs({ list, registry, role: "ORCH" }));
    assert.equal(badRole.status, 2);
    assert.ok(!badRole.stdout.includes("SELECTED"), badRole.stdout);
  });
});

test("REFUSED 는 종료코드 1 · SELECTED 는 0 (배달기가 종료코드로 분기할 수 있다)", () => {
  withTempDir((dir) => {
    const list = writeTerminalList(dir, [SEAT_REVIEW]);
    const registry = writeRegistry(dir, [REG_REVIEW]);
    assert.equal(
      runBind(bindArgs({ list, registry, role: "CODER" })).status,
      1,
    );
    assert.equal(
      runBind(bindArgs({ list, registry, role: "REVIEW" })).status,
      0,
    );
  });
});

// --- 읽기 전용 집계 모드: 지난 영수증 x 등록부 ----------------------------

function receipt(dispatchId, paneKey, role, recordedAt, extra = {}) {
  return {
    recorded_at: recordedAt,
    runtime_task_id: `task_${dispatchId}`,
    dispatch_id: dispatchId,
    assignee_pane_key: paneKey,
    dispatch_timestamp_utc: recordedAt.slice(0, 19).replace("T", " "),
    dispatch_timestamp_source: "response.dispatched_at",
    role,
    harness_task_label: `HYK-${dispatchId}`,
    ...extra,
  };
}

test("집계 모드: 일치 · 불일치 · 판정 불가를 건수와 dispatch_id 로 센다 (원장 · 등록부 파일은 바이트 그대로)", () => {
  withTempDir((dir) => {
    const registry = writeRegistry(dir, [
      regRecord("tabA:leafA", "CODER", "2026-11-01T00:00:00.000Z"),
      regRecord("tabB:leafB", "REVIEW", "2026-11-01T00:00:00.000Z"),
    ]);
    const ledgerPath = join(dir, "receipts.jsonl");
    const lines = [
      receipt("ctx_ok", "tabA:leafA", "CODER", "2026-11-02T00:00:00.000Z"),
      receipt("ctx_bad", "tabA:leafA", "REVIEW", "2026-11-02T00:00:01.000Z"),
      receipt("ctx_cold", "tabZ:leafZ", "CODER", "2026-11-02T00:00:02.000Z"),
      receipt("ctx_early", "tabA:leafA", "CODER", "2026-10-01T00:00:00.000Z"),
      receipt("ctx_corr", "tabA:leafA", "REVIEW", "2026-11-02T00:00:03.000Z", {
        correction: true,
      }),
    ];
    writeFileSync(
      ledgerPath,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );
    const beforeLedger = readFileSync(ledgerPath);
    const beforeRegistry = readFileSync(registry);
    const r = runBind([
      "--audit-receipts",
      ledgerPath,
      "--registry-path",
      registry,
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // 낱말 경계 없이 includes("MATCH=1") 로 보면 "MISMATCH=1" 에도 걸린다.
    assert.match(r.stdout, /(^|\s)MATCH=1(\s|$)/m, r.stdout);
    assert.match(r.stdout, /(^|\s)MISMATCH=1(\s|$)/m, r.stdout);
    assert.match(r.stdout, /(^|\s)UNDECIDABLE=2(\s|$)/m, r.stdout);
    assert.ok(r.stdout.includes("SKIPPED_CORRECTION=1"), r.stdout);
    assert.ok(r.stdout.includes("PANE_NOT_IN_REGISTRY=1"), r.stdout);
    assert.ok(r.stdout.includes("PANE_NOT_REGISTERED_AT_DISPATCH=1"), r.stdout);
    assert.ok(r.stdout.includes("MISMATCH_DISPATCH_IDS ctx_bad"), r.stdout);
    assert.deepEqual(readFileSync(ledgerPath), beforeLedger);
    assert.deepEqual(readFileSync(registry), beforeRegistry);
  });
});

// --- 코어 보조 시험 (순수 함수) -------------------------------------------

test("코어: 사유 코드는 CLI 가 찍는 문자열과 같은 상수로 고정돼 있다", () => {
  assert.equal(
    SEAT_BIND_REASON.MULTI_AGENT_SEAT_IN_WORKTREE,
    "MULTI_AGENT_SEAT_IN_WORKTREE",
  );
  assert.equal(SEAT_BIND_REASON.ROLE_MISMATCH, "ROLE_MISMATCH");
  assert.equal(SEAT_BIND_REASON.UNREGISTERED_AGENT, "UNREGISTERED_AGENT");
  assert.equal(SEAT_BIND_REASON.HANDLE_ROLE_MISMATCH, "HANDLE_ROLE_MISMATCH");
});

test("코어: looksLikeAgentPreview 는 마커가 있어도 tail 이 PS 프롬프트면 false(D15) · 빈 값 false", () => {
  assert.equal(looksLikeAgentPreview(CODER_PREVIEW), true);
  assert.equal(looksLikeAgentPreview(REVIEW_PREVIEW), true);
  assert.equal(looksLikeAgentPreview(BLANK_SHELL_PREVIEW), false);
  assert.equal(looksLikeAgentPreview("Opus ...\r\nPS C:\\x> "), false);
  assert.equal(looksLikeAgentPreview(""), false);
  assert.equal(looksLikeAgentPreview(undefined), false);
});

test("코어: 에이전트 배너 마커는 저장소 단일 설정(seatCensusAgentBanner)에서 온다 -- 설정판의 Fable · 대소문자 무시를 따른다", () => {
  assert.equal(looksLikeAgentPreview("FABLE 5.2 · weekly 12%"), true);
  assert.equal(looksLikeAgentPreview("fable"), true);
  assert.equal(looksLikeAgentPreview("just a plain scrollback line"), false);
});

test("코어: lookupRegisteredRole 은 asOf 이전 마지막 등록을 쓰고 이후 등록만 있으면 NOT_YET_REGISTERED", () => {
  const records = [
    regRecord("p:1", "CODER", "2026-11-01T00:00:00.000Z"),
    regRecord("p:1", "REVIEW", "2026-11-05T00:00:00.000Z"),
  ];
  assert.deepEqual(
    lookupRegisteredRole(records, "p:1", {
      asOfMs: Date.parse("2026-11-03T00:00:00.000Z"),
    }),
    { status: "FOUND", role: "CODER" },
  );
  assert.deepEqual(lookupRegisteredRole(records, "p:1"), {
    status: "FOUND",
    role: "REVIEW",
  });
  assert.equal(
    lookupRegisteredRole(records, "p:1", {
      asOfMs: Date.parse("2026-10-01T00:00:00.000Z"),
    }).status,
    "NOT_YET_REGISTERED",
  );
  assert.equal(lookupRegisteredRole(records, "p:2").status, "NOT_IN_REGISTRY");
});

test("코어: classifyReceiptBinding / summarizeReceiptBindings 는 판정 불가를 일치로 접지 않는다", () => {
  const records = [regRecord("p:1", "CODER", "2026-11-01T00:00:00.000Z")];
  const noRole = classifyReceiptBinding(
    receipt("ctx_a", "p:1", "", "2026-11-02T00:00:00.000Z"),
    records,
  );
  assert.equal(noRole.verdict, "UNDECIDABLE");
  assert.equal(noRole.reason, "ROLE_MISSING");
  const summary = summarizeReceiptBindings(
    [
      receipt("ctx_a", "p:1", "CODER", "2026-11-02T00:00:00.000Z"),
      receipt("ctx_b", "p:1", "REVIEW", "2026-11-02T00:00:00.000Z"),
    ],
    records,
  );
  assert.equal(summary.counts.MATCH, 1);
  assert.equal(summary.counts.MISMATCH, 1);
  assert.deepEqual(summary.mismatchDispatchIds, ["ctx_b"]);
});

test("코어: selectRoleBoundSeat 는 순수 함수다 -- 같은 입력이면 같은 결정 · 입력 배열을 바꾸지 않는다", () => {
  const terminals = [SEAT_BLANK, SEAT_CODER];
  const snapshot = JSON.stringify(terminals);
  const input = {
    terminals,
    worktree: WORKTREE,
    role: "CODER",
    registryRecords: [REG_CODER],
  };
  const a = selectRoleBoundSeat(input);
  const b = selectRoleBoundSeat(input);
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);
  assert.equal(a.handle, "term_coder");
  assert.equal(JSON.stringify(terminals), snapshot);
});
