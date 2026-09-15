// HYK-468 3R §3 -- ★★★"헛시험 축"의 수리. 2R의 지정 시험선은 54/54
// PASS였지만 검토자가 손으로 만든 12칸 표(실제 독자 3개 x 입력 4개)를
// 아무 시험도 때리지 않아 P1 2건을 둘 다 놓쳤다(REVIEW-r27.md 표적 1).
// 이 파일 하나가 그 12칸을 그대로 자동 시험으로 박는다 -- 세 독자의
// «실제 export된» 판정 함수에 «같은 네 입력»을 직접 주입해 12칸 전부를
// deepEqual로 단정한다(검토자의 손 조사를 재현 가능한 기계 증거로 바꾼다).
//
// 세 독자:
//   - relay-handshake.mjs의 resolveResultTaskId (이미 export)
//   - dispatch-gate-decision.mjs의 classifyTaskIdLabel (이 라운드부터 export,
//     이유는 그 함수 자신의 헤더 주석 참조 -- REVIEW-r27.md "정직 한계":
//     2R 검토자는 이게 export가 아니어서 메모리 전용 probe로 우회해야 했다)
//   - admission-completion-adapter.mjs의 resolveHeaderTaskId (같은 이유로
//     이 라운드부터 __probeResolveHeaderTaskId라는 이름으로 export)
//
// 네 입력(검토자 표 그대로):
//   ⓐ 산문 인용 1 + 헤더 선언 1
//   ⓑ 선언 0
//   ⓒ 같은 블록 선언 2
//   ⓓ NC-2: 빈 줄로 갈린 «구조적» 선언 2 (HYK-183 모양) -- ★admission만
//     여기서 「옛 값」을 확정하던 것이 P1-1의 실물이었다.
//
// HYK-468 4R §2-3 (P1, 검토자 REVIEW-r28.md 반려 재수리): 위 12칸에 다섯
// 칸을 더한다 -- "task_id:" 바로 뒤를 ASCII 스페이스/탭이 아닌 다른
// 유니코드 공백류(NBSP U+00A0 · 표의문자 공백 U+3000 · EM 스페이스
// U+2003 · VT U+000B · FF U+000C) 하나로 채운 선언 한 줄뿐인 입력이다.
// relay-handshake.mjs 507행이 `\s*`로 갈라졌던 회귀는 정확히 이 다섯
// 문자에서 fail-open(값을 지어냄)이 났다(§1 표). 이 다섯 입력 각각에서
// 세 독자 «전부»가 fail-closed(선언을 인정하지 않음)임을 단정한다 --
// 하나라도 빠지면 그 자리가 다음 구멍이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { resolveResultTaskId } from "./relay-handshake.mjs";
import { classifyTaskIdLabel } from "./dispatch-gate-decision.mjs";
import { __probeResolveHeaderTaskId } from "./admission-completion-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_PATH = join(HERE, "relay-handshake.mjs");
const DISPATCH_PATH = join(HERE, "dispatch-gate-decision.mjs");
const ADMISSION_PATH = join(HERE, "admission-completion-adapter.mjs");

// relay-handshake.mjs's own static import graph (each of these only
// imports node: builtins -- see hyk468-2r-real-reader.test.mjs's own
// comment on the same list).
const RELAY_SIBLINGS = [
  "reject-streak.mjs",
  "envelope-archive.mjs",
  "time-authority.mjs",
  "child-probe-timeout-policy.mjs",
];

// dispatch-gate-decision.mjs's own static import graph (dispatch-gate-
// abort-wire.test.mjs's stageScriptsCheckDir already proves this exact
// list is sufficient -- reused verbatim here).
const DISPATCH_SIBLINGS = [
  "dispatch-gate-decision-core.mjs",
  "reject-streak.mjs",
  "reject-streak-chain.mjs",
  "consumption-receipt-core.mjs",
  "dropped-at-stamp-core.mjs",
  "abort-record-core.mjs",
  "retirement-record-core.mjs",
  "retirement-block-reason-shared.mjs",
  "envelope-archive.mjs",
];

// admission-completion-adapter.mjs's own static import graph
// (admission-completion-worktree-isolation.test.mjs's stageAdapterSiblingDeps
// already proves this exact split -- reused verbatim here).
const ADMISSION_SUPERVISOR_SIBLINGS = [
  "admission-ledger-core.mjs",
  "admission-ledger-store.mjs",
];
const ADMISSION_CHECK_SIBLINGS = [
  "ledger-pointer-shared.mjs",
  "retirement-record-core.mjs",
  "retirement-block-reason-shared.mjs",
  "envelope-archive.mjs",
];

const INPUTS = {
  // ⓐ 산문 인용 1 + 헤더 선언 1 -- 검토자의 2R 반려 재현 그대로
  // (hyk468-2r-real-reader.test.mjs REVIEWER_REPRO_CONTENT와 동형).
  a:
    "task_id: HYK-468-header-1\n" +
    "for: HYK-468\n" +
    "role: CODER\n" +
    "\n" +
    "예를 들어 다음과 같은 줄이 주입된다:\n" +
    "task_id: HYK-9201-inject-1\n" +
    "dropped_at: 2026-09-14 10:58 KST\n",
  // ⓑ 선언 0
  b: "for: HYK-468\nrole: CODER\n",
  // ⓒ 같은 블록 선언 2
  c: "task_id: A-1\ntask_id: A-2\n",
  // ⓓ NC-2: 빈 줄로 갈린 «구조적» 선언 2 (HYK-183 모양, 산문 없음).
  d:
    "task_id: HYK-0000-stale-round\n" +
    ">>> DONE: old round @ 2026-07-30 09:00 KST\n" +
    "\n" +
    "task_id: HYK-9001-x\n" +
    ">>> DONE: new round @ 2026-07-31 10:05 KST\n",
  // HYK-468 4R §2-3: "task_id:" 바로 뒤가 ASCII 스페이스/탭이 아닌 다른
  // 공백류 한 문자뿐인, 그 외에는 완전히 정상인 선언 한 줄(파일 맨 앞이라
  // hasStructuralPredecessor 자체는 항상 참). §1 표가 지목한 다섯 문자
  // 그대로.
  nbsp: "task_id: HYK-9999-ws-nbsp\n",
  ideographicSpace: "task_id:　HYK-9999-ws-ideographic\n",
  emSpace: "task_id: HYK-9999-ws-em\n",
  verticalTab: "task_id:HYK-9999-ws-vt\n",
  formFeed: "task_id:HYK-9999-ws-ff\n",
};

// 검토자가 REVIEW-r27.md 표적 1에서 손으로 관측한 12칸 그대로(오늘 실제
// exported 함수를 직접 호출해 재확인, sha256은 아래 GREEN 시험이 화면에
// 찍는다).
const EXPECTED = {
  a: {
    relay: { ok: true, id: "HYK-468-header-1" },
    dispatch: {
      kind: "VALID",
      value: "HYK-468-header-1",
      looseLines: 1,
      strictCount: 1,
    },
    admission: { ok: true, id: "HYK-468-header-1" },
  },
  b: {
    relay: {
      ok: false,
      kind: "MISSING",
      reason: "result missing task_id echo (need a `task_id: <id>` line)",
    },
    dispatch: { kind: "MISSING", looseLines: 0, strictCount: 0 },
    admission: { ok: false, count: 0 },
  },
  c: {
    relay: {
      ok: false,
      kind: "AMBIGUOUS",
      reason:
        "result has 2 standalone 'task_id:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve)",
    },
    dispatch: { kind: "BROKEN", looseLines: 2, strictCount: 2 },
    admission: { ok: false, count: 2 },
  },
  d: {
    relay: {
      ok: false,
      kind: "AMBIGUOUS",
      reason:
        "result has 2 standalone 'task_id:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve)",
    },
    dispatch: { kind: "BROKEN", looseLines: 2, strictCount: 2 },
    // ★P1-1의 정본 실증: 2R까지는 여기가
    // { ok: true, id: "HYK-0000-stale-round" }(옛 값을 조용히 확정)이었다.
    admission: { ok: false, count: 2 },
  },
};

// HYK-468 4R §2-3: 다섯 공백류 입력 전부 같은 모양의 fail-closed 삼중주다
// -- TASK_ID_LINE_RE(정본과 세 독자 모두 `[ \t]`로 좁힌 뒤)는 이 중 어느
// 문자도 매치하지 않아 "구조적으로 유효한 선언 0개"로 떨어지고, 그런데도
// TASK_ID_ANYWHERE_RE(relay)/looseLineIdxs(dispatch)처럼 "task_id: 토큰
// 자체는 어딘가에 있다"를 보는 더 느슨한 축은 `\s`를 그대로 쓰므로 이
// 문자들을 여전히 인식한다 -- 그래서 relay는 MISSING이 아니라 MID_LINE,
// dispatch는 looseLines:1인데 strictCount:0인 BROKEN이 된다(둘 다
// ok:false/kind!=="VALID" 이므로 fail-closed 판정 자체는 동일하다).
const WHITESPACE_FAIL_CLOSED_EXPECTED = {
  relay: {
    ok: false,
    kind: "MID_LINE",
    reason:
      "result task_id echo not at line start (must be a standalone `task_id: <id>` line at column 0, found mid-line)",
  },
  dispatch: { kind: "BROKEN", looseLines: 1, strictCount: 0 },
  admission: { ok: false, count: 0 },
};
for (const label of [
  "nbsp",
  "ideographicSpace",
  "emSpace",
  "verticalTab",
  "formFeed",
]) {
  EXPECTED[label] = WHITESPACE_FAIL_CLOSED_EXPECTED;
}

test("GREEN(17칸 전부, 12+공백류5): 실제 export된 세 독자에 같은 아홉 입력(REVIEW-r27.md 표적 1의 네 입력 + REVIEW-r28.md가 지목한 NBSP·전각공백·EM공백·VT·FF 다섯 입력)을 직접 주입 -- 다섯 문자 전부 세 독자 fail-closed를 기계 시험으로 고정", () => {
  const cells = {};
  for (const [label, content] of Object.entries(INPUTS)) {
    cells[label] = {
      relay: resolveResultTaskId(content),
      dispatch: classifyTaskIdLabel(content),
      admission: __probeResolveHeaderTaskId(content),
    };
  }
  console.log(
    "HYK-468 3R §3 12칸 원문:",
    JSON.stringify(cells, null, 2),
    "sha256(three-readers.test.mjs 이 파일 자신)=",
    createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url), "utf8"), "utf8")
      .digest("hex"),
  );
  assert.deepEqual(cells, EXPECTED);
});

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once (found ${count})`,
  );
}

function stageSiblings(dir, subpath, names, sourceDir) {
  const outDir = join(dir, ...subpath);
  mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    writeFileSync(
      join(outDir, name),
      readFileSync(join(sourceDir, name), "utf8"),
      "utf8",
    );
  }
  return outDir;
}

// -----------------------------------------------------------------------
// 되돌림 변이 1/4 (coder-task.md §3 요구1): relay-handshake.mjs의 구조적
// 선행 맥락 검사를 제거하면 ⓐ가 다시 AMBIGUOUS로 샌다.
// -----------------------------------------------------------------------
test("RED(변이 1/4, 필수): relay의 구조 검사를 제거하면 ⓐ가 다시 AMBIGUOUS로 샌다", async () => {
  const realSource = readFileSync(RELAY_PATH, "utf8");
  const target =
    '  const lines = scan.replace(/\\r\\n/g, "\\n").split("\\n");\n  const resultIdMatches = [];\n  for (let i = 0; i < lines.length; i++) {\n    const m = lines[i].match(TASK_ID_LINE_RE);\n    if (!m) continue;\n    if (!hasStructuralPredecessor(lines, i)) continue;\n    resultIdMatches.push(m);\n  }';
  assertExactlyOneMatch(realSource, target, "relay 구조 검사");
  const mutatedSource = realSource.replace(
    target,
    '  const lines = scan.replace(/\\r\\n/g, "\\n").split("\\n");\n  // MUTATED(HYK-468 4R RED 1/4): structural-predecessor check removed.\n  const resultIdMatches = [...scan.matchAll(new RegExp(TASK_ID_LINE_RE.source, "gim"))];',
  );

  const dir = mkdtempSync(join(tmpdir(), "hyk468-3r-relay-red-"));
  try {
    for (const name of RELAY_SIBLINGS) {
      writeFileSync(
        join(dir, name),
        readFileSync(join(HERE, name), "utf8"),
        "utf8",
      );
    }
    const mutantPath = join(dir, "relay-handshake.mjs");
    writeFileSync(mutantPath, mutatedSource, "utf8");
    const mutant = await import(pathToFileURL(mutantPath).href);
    const result = mutant.resolveResultTaskId(INPUTS.a);
    assert.equal(
      result.ok,
      false,
      "RED: structural-predecessor 검사가 빠지면 ⓐ가 다시 AMBIGUOUS여야 한다",
    );
    assert.equal(result.kind, "AMBIGUOUS");

    const beforeSha = createHash("sha256")
      .update(realSource, "utf8")
      .digest("hex");
    const afterSource = readFileSync(RELAY_PATH, "utf8");
    const afterSha = createHash("sha256")
      .update(afterSource, "utf8")
      .digest("hex");
    console.log("RED 1/4 원복 sha256:", beforeSha, "==", afterSha);
    assert.equal(
      afterSource,
      realSource,
      "원복 증명: 실 소스 파일은 바이트 동일해야 한다",
    );
    assert.equal(beforeSha, afterSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------
// 되돌림 변이 2/4 (coder-task.md §3 요구2): dispatch-gate-decision.mjs의
// 구조적 선행 맥락 검사를 제거하면 ⓐ가 다시 BROKEN으로 샌다.
// -----------------------------------------------------------------------
test("RED(변이 2/4, 필수): dispatch의 구조 검사를 제거하면 ⓐ가 다시 BROKEN으로 샌다", async () => {
  const realSource = readFileSync(DISPATCH_PATH, "utf8");
  const target =
    "  const looseLineIdxs = [];\n  for (let i = 0; i < lines.length; i++) {\n    if (!/^task_id:.*$/i.test(lines[i])) continue;\n    if (!hasStructuralPredecessor(lines, i)) continue;\n    looseLineIdxs.push(i);\n  }";
  assertExactlyOneMatch(realSource, target, "dispatch 구조 검사");
  const mutatedSource = realSource.replace(
    target,
    "  // MUTATED(HYK-468 3R RED 2/4): structural-predecessor check removed.\n  const looseLineIdxs = [];\n  for (let i = 0; i < lines.length; i++) {\n    if (!/^task_id:.*$/i.test(lines[i])) continue;\n    looseLineIdxs.push(i);\n  }",
  );

  const dir = mkdtempSync(join(tmpdir(), "hyk468-3r-dispatch-red-"));
  try {
    const scriptsCheckDir = stageSiblings(
      dir,
      ["scripts", "check"],
      DISPATCH_SIBLINGS,
      HERE,
    );
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");
    writeFileSync(mutantPath, mutatedSource, "utf8");
    const mutant = await import(pathToFileURL(mutantPath).href);
    const result = mutant.classifyTaskIdLabel(INPUTS.a);
    assert.equal(
      result.kind,
      "BROKEN",
      "RED: structural-predecessor 검사가 빠지면 ⓐ가 다시 BROKEN이어야 한다(산문 인용까지 looseLines로 셈)",
    );
    assert.equal(result.looseLines, 2);

    const beforeSha = createHash("sha256")
      .update(realSource, "utf8")
      .digest("hex");
    const afterSource = readFileSync(DISPATCH_PATH, "utf8");
    const afterSha = createHash("sha256")
      .update(afterSource, "utf8")
      .digest("hex");
    console.log("RED 2/4 원복 sha256:", beforeSha, "==", afterSha);
    assert.equal(
      afterSource,
      realSource,
      "원복 증명: 실 소스 파일은 바이트 동일해야 한다",
    );
    assert.equal(beforeSha, afterSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------
// 되돌림 변이 3/4 (coder-task.md §3 요구3, ★P1-1이 실제로 잡힌다는 기계
// 증거): admission-completion-adapter.mjs를 옛 blankLineIdx(첫 빈 줄
// 이전만 읽는) 방식으로 되돌리면 ⓓ가 다시 「옛 값」으로 조용히 확정된다.
// -----------------------------------------------------------------------
test("RED(변이 3/4, 필수, P1-1 실증): admission을 옛 blankLineIdx 방식으로 되돌리면 ⓓ가 다시 「옛 값」으로 확정된다", async () => {
  const realSource = readFileSync(ADMISSION_PATH, "utf8");
  const target =
    'function resolveHeaderTaskId(content) {\n  const lines = maskQuotedMarkerRegionsLocal(\n    (content ?? "").replace(/\\r\\n/g, "\\n"),\n  ).split("\\n");\n  const candidates = [];\n  for (let i = 0; i < lines.length; i++) {\n    const m = lines[i].match(TASK_ID_LINE_RE);\n    if (!m) continue;\n    if (!hasStructuralPredecessor(lines, i)) continue;\n    candidates.push(m[1]);\n  }\n  if (candidates.length !== 1) return { ok: false, count: candidates.length };\n  return { ok: true, id: candidates[0] };\n}';
  assertExactlyOneMatch(realSource, target, "admission resolveHeaderTaskId");
  const mutatedSource = realSource.replace(
    target,
    '// MUTATED(HYK-468 3R RED 3/4): reverted to the 2R blankLineIdx (first-blank-line-only) shape -- exactly the P1-1 regression.\nfunction resolveHeaderTaskId(content) {\n  const normalized = (content ?? "").replace(/\\r\\n/g, "\\n");\n  const blankLineIdx = normalized.search(/\\n[ \\t]*\\n/);\n  const header =\n    blankLineIdx === -1 ? normalized : normalized.slice(0, blankLineIdx);\n  const matches = [...header.matchAll(/^task_id:[ \\t]*(\\S+)/gim)];\n  if (matches.length !== 1) return { ok: false, count: matches.length };\n  return { ok: true, id: matches[0][1] };\n}',
  );

  const dir = mkdtempSync(join(tmpdir(), "hyk468-3r-admission-red-"));
  try {
    stageSiblings(
      dir,
      ["scripts", "supervisor"],
      ADMISSION_SUPERVISOR_SIBLINGS,
      join(HERE, "..", "supervisor"),
    );
    const scriptsCheckDir = stageSiblings(
      dir,
      ["scripts", "check"],
      ADMISSION_CHECK_SIBLINGS,
      HERE,
    );
    const mutantPath = join(
      scriptsCheckDir,
      "admission-completion-adapter.mjs",
    );
    writeFileSync(mutantPath, mutatedSource, "utf8");
    const mutant = await import(pathToFileURL(mutantPath).href);
    const result = mutant.__probeResolveHeaderTaskId(INPUTS.d);
    assert.deepEqual(
      result,
      { ok: true, id: "HYK-0000-stale-round" },
      "RED: 옛 blankLineIdx 방식으로 되돌리면 ⓓ(NC-2)가 다시 「옛 값」을 조용히 확정해야 한다 -- P1-1이 실제로 이 시험에 잡힌다는 증거",
    );

    const beforeSha = createHash("sha256")
      .update(realSource, "utf8")
      .digest("hex");
    const afterSource = readFileSync(ADMISSION_PATH, "utf8");
    const afterSha = createHash("sha256")
      .update(afterSource, "utf8")
      .digest("hex");
    console.log("RED 3/4 원복 sha256:", beforeSha, "==", afterSha);
    assert.equal(
      afterSource,
      realSource,
      "원복 증명: 실 소스 파일은 바이트 동일해야 한다",
    );
    assert.equal(beforeSha, afterSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
