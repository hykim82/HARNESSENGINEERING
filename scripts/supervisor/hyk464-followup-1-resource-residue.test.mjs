// HYK-464-followup-1 축C (coder-task.md §1 축C) -- 자원 잔재 «보고» 시험.
//
// 이 스위트가 증명하는 것:
// 1. 순수 판정 함수 세 개(computeWorktreeReasonResidue/computeIdleSeatResidue/
//    computeNodeProcessResidue) 각각이 잔재 3종을 올바르게 가르고,
//    "판별 불가"와 "잔재 없음"을 뭉뚱그리지 않는다(거짓 확신 금지).
// 2. `resourceResidue`를 opt-in으로 주지 않은 기존 `runWatchOnce` 호출자는
//    로그 줄이 한 글자도 달라지지 않는다(회귀 0, admissionSweep/wake와
//    동일 계약).
// 3. opt-in으로 주면 실제 프로덕션 진입점(runWatchOnce)을 통해서도
//    `residue_*` 세그먼트가 로그 줄에 남는다 -- 잔재가 있을 때도, 없을
//    때도(거짓 양성 0) 둘 다.
// 4. 자동 제거/자동 종료를 하지 않는다(이 파일이 close/rm/kill 계열 argv를
//    한 번도 만들지 않음을 정적으로 확인).
// 5. 시험이 프로덕션 export를 직접 구동한다(헛시험 방지, grep 확인은
//    coder.md에 별도로 적는다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runWatchOnce,
  buildLogLine,
  computeWorktreeReasonResidue,
  computeIdleSeatResidue,
  computeNodeProcessResidue,
  DEFAULT_RESIDUE_SCRIPT_MARKERS,
} from "./watch-run.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const NOW_MS = Date.parse("2026-09-16T20:00:00+09:00");

function tmpWatchDir() {
  return fs.mkdtempSync(join(tmpdir(), "nc-watch-run-residue-"));
}
function progressingExec() {
  return JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" });
}

// ---------------------------------------------------------------------------
// ⓐ computeWorktreeReasonResidue -- 순수 함수, 실 git/실 fs 없이 시험.
// ---------------------------------------------------------------------------
test("computeWorktreeReasonResidue: dropped_at 헤더가 있는 *-task.md가 하나라도 있으면 사유가 있다 -- 보고 대상 아님(조용함)", () => {
  const r = computeWorktreeReasonResidue({
    worktreePaths: ["C:/wt/has-reason"],
    collectEvidenceFn: () => ({
      items: [{ path: ".harness/coder-task.md", taskId: "HYK-1" }],
      failed: false,
    }),
  });
  assert.deepEqual(r.noReasonFile, []);
  assert.deepEqual(r.undetermined, []);
});

test("computeWorktreeReasonResidue: *-task.md가 하나도 없으면(dropped_at 헤더 있는 것 0개) NO_REASON_FILE로 보고한다", () => {
  const r = computeWorktreeReasonResidue({
    worktreePaths: ["C:/wt/no-reason"],
    collectEvidenceFn: () => ({ items: [], failed: false }),
  });
  assert.equal(r.noReasonFile.length, 1);
  assert.equal(r.noReasonFile[0].worktreePath, "C:/wt/no-reason");
  assert.deepEqual(r.undetermined, []);
});

test("computeWorktreeReasonResidue: .harness 읽기 자체가 실패하면(권한 등) UNDETERMINED로 보고한다 -- '사유 없음'으로 단정하지 않는다(거짓 확신 금지)", () => {
  const r = computeWorktreeReasonResidue({
    worktreePaths: ["C:/wt/unreadable"],
    collectEvidenceFn: () => ({ items: [], failed: true }),
  });
  assert.deepEqual(r.noReasonFile, []);
  assert.equal(r.undetermined.length, 1);
  assert.equal(r.undetermined[0].worktreePath, "C:/wt/unreadable");
});

test("computeWorktreeReasonResidue: 여러 워크트리를 섞으면 각각 독립적으로 분류된다(잔재 없는 워크트리가 섞여도 그건 조용하다)", () => {
  const evidenceByPath = {
    "C:/wt/a": { items: [{ path: ".harness/coder-task.md" }], failed: false },
    "C:/wt/b": { items: [], failed: false },
    "C:/wt/c": { items: [], failed: true },
  };
  const r = computeWorktreeReasonResidue({
    worktreePaths: ["C:/wt/a", "C:/wt/b", "C:/wt/c"],
    collectEvidenceFn: (wt) => evidenceByPath[wt],
  });
  assert.deepEqual(
    r.noReasonFile.map((e) => e.worktreePath),
    ["C:/wt/b"],
  );
  assert.deepEqual(
    r.undetermined.map((e) => e.worktreePath),
    ["C:/wt/c"],
  );
});

// ---------------------------------------------------------------------------
// ⓑ computeIdleSeatResidue -- seat-orphan-detect.mjs의 detectOrphans를
// 재사용할 뿐이므로(재구현 아님), 여기서는 "재사용이 실제로 결선됐는가"와
// "registryPath 없으면 UNDETERMINED"만 확인한다(detectOrphans 자체의
// 판정 로직 시험은 seat-orphan-detect.mjs 몫 -- 중복 시험 금지).
// ---------------------------------------------------------------------------
test("computeIdleSeatResidue: registryPath가 없으면 UNDETERMINED다 -- '유휴 좌석 0건'으로 지어내지 않는다", () => {
  const r = computeIdleSeatResidue({ terminals: [], registryPath: null });
  assert.equal(r.status, "UNDETERMINED");
  assert.deepEqual(r.orphanCandidates, []);
});

test("computeIdleSeatResidue: registryPath가 있으면 detectOrphans를 실제로 호출한다(등록부에 없는 에이전트-모양 좌석이 후보로 잡힌다)", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-idle-residue-"));
  try {
    const registryPath = join(dir, "seat-launch-registry.jsonl");
    // 등록부는 비어 있다 -- 아래 좌석은 등록되지 않았다.
    fs.writeFileSync(registryPath, "", "utf8");
    const terminals = [
      {
        handle: "term_unregistered_agent",
        tabId: "ta",
        leafId: "la",
        preview: "✻ Welcome to Claude Code!\n  bypass permissions on\n",
      },
    ];
    const r = computeIdleSeatResidue({ terminals, registryPath });
    assert.equal(r.status, "OK");
    assert.equal(r.orphanCandidates.length, 1);
    assert.equal(r.orphanCandidates[0].handle, "term_unregistered_agent");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓒ computeNodeProcessResidue -- 순수 함수, 실 OS 프로세스 열거 없이 시험.
// ---------------------------------------------------------------------------
test("computeNodeProcessResidue: 감시 스크립트를 가리키는 node 프로세스가(자기 자신 제외) 남아있으면 잔재로 잡는다", () => {
  const r = computeNodeProcessResidue({
    processRows: [
      {
        pid: 111,
        commandLine:
          "node C:\\repo\\scripts\\supervisor\\orch-stall-detect.mjs --repo-root C:\\wt",
      },
      { pid: 222, commandLine: "node C:\\some\\unrelated\\server.js" },
    ],
    selfPid: 999,
  });
  assert.equal(r.status, "OK");
  assert.equal(r.residue.length, 1);
  assert.equal(r.residue[0].pid, 111);
});

test("computeNodeProcessResidue: 자기 자신의 pid는 잔재에서 제외한다(러너 자신을 스스로를 잔재로 보고하지 않는다)", () => {
  const r = computeNodeProcessResidue({
    processRows: [
      {
        pid: 999,
        commandLine:
          "node C:\\repo\\scripts\\supervisor\\watch-run.mjs --repo-root C:\\wt",
      },
    ],
    selfPid: 999,
  });
  assert.equal(r.residue.length, 0);
});

test("computeNodeProcessResidue: 잔재가 없으면 조용하다(거짓 양성 0) -- 무관한 node 프로세스만 있을 때", () => {
  const r = computeNodeProcessResidue({
    processRows: [{ pid: 42, commandLine: "node C:\\some\\other\\app.js" }],
    selfPid: 999,
  });
  assert.equal(r.status, "OK");
  assert.deepEqual(r.residue, []);
});

test("computeNodeProcessResidue: 수집 자체가 안 됐으면(null) UNDETERMINED다 -- '잔재 없음'으로 지어내지 않는다", () => {
  const r = computeNodeProcessResidue({ processRows: null, selfPid: 999 });
  assert.equal(r.status, "UNDETERMINED");
  assert.deepEqual(r.residue, []);
});

// 변이 RED(§2 필수): DEFAULT_RESIDUE_SCRIPT_MARKERS를 빈 배열로 주면
// (마커가 하나도 없다) 진짜 잔재도 더 이상 잡히지 않아야 한다 -- 이
// 마커 목록이 실제로 판정을 가른다는 증거.
test("computeNodeProcessResidue 되돌림 변이(필수): scriptMarkers를 비우면 -> RED (진짜 잔재도 더 이상 안 잡힌다, 마커 목록이 결과를 가른다는 증거)", () => {
  const withMarkers = computeNodeProcessResidue({
    processRows: [
      {
        pid: 111,
        commandLine: "node ...\\orch-stall-detect.mjs --repo-root C:\\wt",
      },
    ],
    selfPid: 999,
  });
  assert.equal(withMarkers.residue.length, 1);
  const withoutMarkers = computeNodeProcessResidue({
    processRows: [
      {
        pid: 111,
        commandLine: "node ...\\orch-stall-detect.mjs --repo-root C:\\wt",
      },
    ],
    selfPid: 999,
    scriptMarkers: [],
  });
  assert.equal(
    withoutMarkers.residue.length,
    0,
    "mutant (empty marker list) must regress to catching nothing -- proves DEFAULT_RESIDUE_SCRIPT_MARKERS is load-bearing",
  );
});

test("DEFAULT_RESIDUE_SCRIPT_MARKERS: 이 러너 자신과 감지기 스크립트 이름을 담는다(다른 무관한 node 프로세스를 오탐하지 않도록 좁게 유지)", () => {
  assert.deepEqual(DEFAULT_RESIDUE_SCRIPT_MARKERS, [
    "orch-stall-detect.mjs",
    "watch-run.mjs",
  ]);
});

// ---------------------------------------------------------------------------
// 결선 -- 실 진입점(runWatchOnce)을 통해서도 opt-in/회귀0/보고가 실제로
// 표면화되는가.
// ---------------------------------------------------------------------------
test("HYK-464-followup-1 축C 회귀 0: resourceResidue를 opt-in으로 주지 않은 기존 runWatchOnce 호출은 로그 줄에 residue_ 세그먼트가 전혀 없다", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
    });
    assert.equal(result.line.includes("residue_"), false);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("buildLogLine: resourceResidueResult가 없으면 세그먼트 없이 기존과 동일한 모양(filter(Boolean) 확인)", () => {
  const line = buildLogLine({
    nowIso: "2026-09-16T00:00:00.000Z",
    detectorResult: { exitCode: 0, verdict: "PROGRESSING", reasonCode: "OK" },
    capResult: {},
    escalationDedupe: {},
  });
  assert.equal(line.includes("residue_"), false);
});

test("opt-in: resourceResidue를 주면 실제 runWatchOnce 진입점을 통해서도 세 잔재 종류가 전부 로그 줄에 표면화된다(잔재 있는 경우)", () => {
  const watchDir = tmpWatchDir();
  const registryDir = fs.mkdtempSync(join(tmpdir(), "nc-residue-registry-"));
  try {
    const registryPath = join(registryDir, "seat-launch-registry.jsonl");
    fs.writeFileSync(registryPath, "", "utf8"); // 아무도 등록 안 됨
    const orcaExecFn = (argv) => {
      assert.deepEqual(argv, ["terminal", "list", "--json"]);
      return {
        ok: true,
        result: {
          terminals: [
            {
              handle: "term_idle_agent",
              tabId: "ta",
              leafId: "la",
              preview: "✻ Welcome to Claude Code!\n  bypass permissions on\n",
            },
          ],
        },
      };
    };
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      resourceResidue: {
        registryPath,
        orcaExecFn,
        // 워크트리 열거는 실 git을 타지 않고 결정적으로 고정(§시험 결정성).
        worktreeListFn: () => ({ ok: true, worktrees: ["C:/wt/no-reason"] }),
        collectEvidenceFn: () => ({ items: [], failed: false }),
        listNodeProcessRowsFn: () => [
          {
            pid: 555555,
            commandLine: "node ...\\orch-stall-detect.mjs --repo-root C:\\wt",
          },
        ],
      },
    });
    assert.match(result.line, /residue_worktree_no_reason=1/);
    assert.match(result.line, /residue_worktree_undetermined=0/);
    assert.match(
      result.line,
      /residue_idle_seat_status=OK residue_idle_seat=1/,
    );
    assert.match(result.line, /residue_node_status=OK residue_node=1/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("opt-in: 잔재가 하나도 없으면 세 값 다 0/OK로 조용하다(거짓 양성 0)", () => {
  const watchDir = tmpWatchDir();
  const registryDir = fs.mkdtempSync(
    join(tmpdir(), "nc-residue-registry-clean-"),
  );
  try {
    const registryPath = join(registryDir, "seat-launch-registry.jsonl");
    fs.writeFileSync(registryPath, "", "utf8");
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      resourceResidue: {
        registryPath,
        orcaExecFn: () => ({ ok: true, result: { terminals: [] } }),
        worktreeListFn: () => ({ ok: true, worktrees: ["C:/wt/has-reason"] }),
        collectEvidenceFn: () => ({
          items: [{ path: ".harness/coder-task.md" }],
          failed: false,
        }),
        listNodeProcessRowsFn: () => [],
      },
    });
    assert.match(result.line, /residue_worktree_no_reason=0/);
    assert.match(result.line, /residue_worktree_undetermined=0/);
    assert.match(
      result.line,
      /residue_idle_seat_status=OK residue_idle_seat=0/,
    );
    assert.match(result.line, /residue_node_status=OK residue_node=0/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("opt-in: registryPath를 안 주면 idle-seat 축은 UNDETERMINED로 보고되고(거짓 확신 금지), 다른 두 축은 그대로 보고된다", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      resourceResidue: {
        worktreeListFn: () => ({ ok: true, worktrees: ["C:/wt/no-reason"] }),
        collectEvidenceFn: () => ({ items: [], failed: false }),
        listNodeProcessRowsFn: () => [],
      },
    });
    assert.match(
      result.line,
      /residue_idle_seat_status=UNDETERMINED residue_idle_seat=NONE/,
    );
    assert.match(result.line, /residue_worktree_no_reason=1/);
    assert.match(result.line, /residue_node_status=OK residue_node=0/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 안전판(coder-task.md §1 축C 비타협): 자동 제거·자동 종료 기능은 절대
// 만들지 않는다 -- 이 파일이 close/rm/kill 계열 argv를 한 번도 만들지
// 않음을 정적으로 확인한다(seat-orphan-detect.mjs가 이미 세운 원칙과
// 동일한 정적 확인 방식).
// ---------------------------------------------------------------------------
test("정적: watch-run.mjs의 축C 코드는 terminal close/worktree rm/task-update 같은 파괴적 argv를 조립하지 않는다(보고 전용 -- §요구 '자동 제거·자동 종료 금지')", () => {
  const src = fs.readFileSync(
    new URL("./watch-run.mjs", import.meta.url),
    "utf8",
  );
  const residueSectionStart = src.indexOf("HYK-464-followup-1 축C");
  assert.notEqual(
    residueSectionStart,
    -1,
    "축C 섹션을 찾지 못했다(파일 개편?)",
  );
  const residueSectionEnd = src.indexOf("resourceResidueLogSegment(result) {");
  const section = src.slice(
    residueSectionStart,
    residueSectionEnd > 0 ? residueSectionEnd + 2000 : src.length,
  );
  assert.doesNotMatch(section, /"terminal",\s*\n?\s*"close"/);
  assert.doesNotMatch(section, /"worktree",\s*\n?\s*"rm"/);
  assert.doesNotMatch(section, /"task-update"/);
  assert.doesNotMatch(section, /taskkill/i);
  assert.doesNotMatch(section, /Stop-Process/i);
});

// §2 요구 "시험이 프로덕션 export를 직접 구동하는지 grep으로 확인해
// 적어라(헛시험 방지)": 이 스위트는 watch-run.mjs가 실제로 export하는
// runWatchOnce/buildLogLine/computeWorktreeReasonResidue/
// computeIdleSeatResidue/computeNodeProcessResidue를 import해 직접
// 호출한다(위 import 문 그대로) -- 별도 재구현/모킹 레이어를 시험 대상
// 자리에 두지 않았다.
