// HYK-186 2R §4 -- pure judge tests for the (B) trust-boundary audit core.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeInboxTimeAudit,
  judgeAuditValidityAfterChange,
  groupByFilenameMinute,
  INBOX_AUDIT_VERDICT,
  INBOX_AUDIT_REASON,
  AUDIT_VALIDITY,
  DEFAULT_TOLERANCE_MS,
} from "./inbox-time-audit-core.mjs";

// Minute-precision KST time -> epoch ms, for readable fixture literals.
function kst(y, m, d, hh, mm, ss = 0) {
  return Date.parse(
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}+09:00`,
  );
}

// --- ★이슈가 실측해 둔 반례 2건 (coder-task.md §4-3), 수치 그대로 ---

test("0104 표본: 본문 01:04 vs CreationTime 01:58:35 (55분 오기) -> MISMATCH (진짜 결함이 잡혀야 한다)", () => {
  const headerTimeMs = kst(2026, 8, 5, 1, 4);
  const creationTimeMs = kst(2026, 8, 5, 1, 58, 35);
  const result = judgeInboxTimeAudit({ headerTimeMs, creationTimeMs });
  assert.equal(result.verdict, INBOX_AUDIT_VERDICT.MISMATCH);
  assert.equal(result.reasonCode, INBOX_AUDIT_REASON.HEADER_CREATION_DISAGREE);
  assert.equal(result.details.evidence, "creationTime");
  assert.ok(
    Math.abs(result.details.deltaMs) > 50 * 60 * 1000,
    "delta must reflect the ~55min gap",
  );
});

test("0303 표본 (★정상 대조군 1/2): 본문 03:03 vs CreationTime 03:03:57(정상)인데 LastWriteTime만 26분 늦다 -> NORMAL (mtime 단독이면 오탐했을 사례)", () => {
  const headerTimeMs = kst(2026, 8, 5, 3, 3);
  const creationTimeMs = kst(2026, 8, 5, 3, 3, 57);
  const lastWriteTimeMs = kst(2026, 8, 5, 3, 29); // +26min, 처리됨\ 이동
  const result = judgeInboxTimeAudit({
    headerTimeMs,
    creationTimeMs,
    lastWriteTimeMs,
  });
  assert.equal(
    result.verdict,
    INBOX_AUDIT_VERDICT.NORMAL,
    "creationTime corroborates the header; the 26min LastWriteTime lag must NOT flip this to MISMATCH",
  );
  assert.equal(result.reasonCode, INBOX_AUDIT_REASON.HEADER_CREATION_AGREE);
  assert.equal(
    result.details.lastWriteDeltaMs,
    26 * 60 * 1000,
    "the lag is still surfaced, just as advisory detail, never as the verdict driver",
  );
});

// --- 완료조건6 (§4-2 ③): 정상 대조군 N=2, 조건 명시, 오탐 0/2 ---
// N=2: (a) 0303 표본(위, creationTime 정상 + mtime 지연) (b) 아래 filename
// fallback 정상 표본(creationTime 부재, filename만으로 corroborate).
test("HYK-186 §4 완료조건6: 정상 대조군 N=2 (0303 mtime-지연 표본 + filename-fallback 표본), 오탐 0/2", () => {
  const samples = [
    {
      label: "0303 (creationTime 정상, mtime 지연)",
      args: {
        headerTimeMs: kst(2026, 8, 5, 3, 3),
        creationTimeMs: kst(2026, 8, 5, 3, 3, 57),
        lastWriteTimeMs: kst(2026, 8, 5, 3, 29),
      },
    },
    {
      label: "filename-fallback (creationTime 부재, filename 정상)",
      args: {
        headerTimeMs: kst(2026, 8, 5, 9, 15),
        filenameTimeMs: kst(2026, 8, 5, 9, 15, 40),
        lastWriteTimeMs: kst(2026, 8, 5, 9, 50),
      },
    },
  ];
  let falsePositives = 0;
  for (const sample of samples) {
    const result = judgeInboxTimeAudit(sample.args);
    if (result.verdict !== INBOX_AUDIT_VERDICT.NORMAL) {
      falsePositives += 1;
      assert.fail(
        `false positive on '${sample.label}': ${result.verdict}/${result.reasonCode}`,
      );
    }
  }
  assert.equal(falsePositives, 0, `오탐 ${falsePositives}/${samples.length}`);
});

// --- 경계값 ---

test("경계: 정확히 toleranceMs 차이는 NORMAL, +1ms는 MISMATCH", () => {
  const headerTimeMs = kst(2026, 8, 5, 1, 0);
  const atBoundary = judgeInboxTimeAudit({
    headerTimeMs,
    creationTimeMs: headerTimeMs + DEFAULT_TOLERANCE_MS,
  });
  assert.equal(atBoundary.verdict, INBOX_AUDIT_VERDICT.NORMAL);

  const pastBoundary = judgeInboxTimeAudit({
    headerTimeMs,
    creationTimeMs: headerTimeMs + DEFAULT_TOLERANCE_MS + 1,
  });
  assert.equal(pastBoundary.verdict, INBOX_AUDIT_VERDICT.MISMATCH);
});

test("증거 없음(creationTime도 filenameTime도 없음) -> UNDECIDABLE, NORMAL로 조용히 접지 않는다", () => {
  const result = judgeInboxTimeAudit({
    headerTimeMs: kst(2026, 8, 5, 1, 0),
    lastWriteTimeMs: kst(2026, 8, 5, 1, 0),
  });
  assert.equal(result.verdict, INBOX_AUDIT_VERDICT.UNDECIDABLE);
  assert.equal(result.reasonCode, INBOX_AUDIT_REASON.NO_CORROBORATING_EVIDENCE);
});

test("헤더 시각 결손 -> UNDECIDABLE (예외 없이 항상 {ok,verdict,reasonCode,details})", () => {
  const result = judgeInboxTimeAudit({ creationTimeMs: kst(2026, 8, 5, 1, 0) });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, INBOX_AUDIT_VERDICT.UNDECIDABLE);
  assert.equal(result.reasonCode, INBOX_AUDIT_REASON.HEADER_TIME_MS_INVALID);
});

test("args 자체가 아니면 -> UNDECIDABLE, throw 없음", () => {
  assert.equal(
    judgeInboxTimeAudit(null).verdict,
    INBOX_AUDIT_VERDICT.UNDECIDABLE,
  );
  assert.equal(
    judgeInboxTimeAudit(undefined).verdict,
    INBOX_AUDIT_VERDICT.UNDECIDABLE,
  );
  assert.equal(
    judgeInboxTimeAudit("x").verdict,
    INBOX_AUDIT_VERDICT.UNDECIDABLE,
  );
});

// --- mutation counterfactual: mtime 단독으로 판정하면 0303이 다시 오탐한다 ---
test("mutation counterfactual (§5 변조4의 순수-로직 대응): lastWriteTimeMs를 creationTimeMs 자리에 잘못 넣으면(=mtime 단독 판정 흉내) 0303이 MISMATCH로 오탐한다 -- 이 코어의 실제 판정은 그렇게 안 한다는 대조", () => {
  const headerTimeMs = kst(2026, 8, 5, 3, 3);
  const lastWriteTimeMs = kst(2026, 8, 5, 3, 29);
  // 의도적으로 mtime을 creationTimeMs 인자 자리에 넣어본다(= mtime 단독
  // 판정으로 되돌린 것과 동일한 입력 모양).
  const mtimeOnlyResult = judgeInboxTimeAudit({
    headerTimeMs,
    creationTimeMs: lastWriteTimeMs,
  });
  assert.equal(
    mtimeOnlyResult.verdict,
    INBOX_AUDIT_VERDICT.MISMATCH,
    "mtime 단독으로 비교하면 0303 정상 표본이 오탐된다 -- 이것이 이 코어가 creationTime을 mtime과 구분해 받는 이유",
  );
  // 실제 코어 호출(정상 인자 배치)은 NORMAL이어야 한다.
  const real = judgeInboxTimeAudit({
    headerTimeMs,
    creationTimeMs: kst(2026, 8, 5, 3, 3, 57),
    lastWriteTimeMs,
  });
  assert.equal(real.verdict, INBOX_AUDIT_VERDICT.NORMAL);
});

// --- finalization 후 변경 정책 ---

test("judgeAuditValidityAfterChange: 감사 이후 변경 -> INVALIDATED", () => {
  const result = judgeAuditValidityAfterChange({
    auditedAtMs: kst(2026, 8, 5, 10, 0),
    contentChangedAtMs: kst(2026, 8, 5, 10, 5),
  });
  assert.equal(result.validity, AUDIT_VALIDITY.INVALIDATED);
});

test("judgeAuditValidityAfterChange: 변경이 감사보다 이전(또는 동시) -> VALID", () => {
  const auditedAtMs = kst(2026, 8, 5, 10, 0);
  const before = judgeAuditValidityAfterChange({
    auditedAtMs,
    contentChangedAtMs: kst(2026, 8, 5, 9, 0),
  });
  assert.equal(before.validity, AUDIT_VALIDITY.VALID);
  const same = judgeAuditValidityAfterChange({
    auditedAtMs,
    contentChangedAtMs: auditedAtMs,
  });
  assert.equal(same.validity, AUDIT_VALIDITY.VALID);
});

// --- 동일 분 파일명 충돌 ---

test("groupByFilenameMinute: 같은 분에 파일이 둘이면 병합/대표선정 없이 둘 다 보존한다", () => {
  const entries = [
    { minuteKey: "2026-08-05T01:04", file: "a.txt" },
    { minuteKey: "2026-08-05T01:04", file: "b.txt" },
    { minuteKey: "2026-08-05T03:03", file: "c.txt" },
  ];
  const groups = groupByFilenameMinute(entries);
  assert.equal(groups.get("2026-08-05T01:04").length, 2);
  assert.deepEqual(
    groups.get("2026-08-05T01:04").map((e) => e.file),
    ["a.txt", "b.txt"],
  );
  assert.equal(groups.get("2026-08-05T03:03").length, 1);
});

test("groupByFilenameMinute: 잘못된 입력은 조용히 건너뛴다(throw 없음)", () => {
  assert.equal(groupByFilenameMinute(null).size, 0);
  assert.equal(groupByFilenameMinute([null, {}, { minuteKey: 5 }]).size, 0);
});

// ---------------------------------------------------------------------------
// HYK-186 2R §5 변조3/변조4 (필수) -- inbox-time-audit-core.mjs 자체 변조.
// ---------------------------------------------------------------------------
import {
  readFileSync,
  writeFileSync as _wfs,
  mkdtempSync as _mkd,
  rmSync as _rm,
} from "node:fs";
import { join as _join, dirname as _dirname } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { tmpdir as _tmpdir } from "node:os";

const _HERE = _dirname(_fileURLToPath(import.meta.url));
const _CORE_PATH = _join(_HERE, "inbox-time-audit-core.mjs");

function _assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once (found ${count})`,
  );
}

async function _importMutant(mutatedSrc) {
  const dir = _mkd(_join(_tmpdir(), "inbox-audit-mut-"));
  const p = _join(dir, "mutant.mjs");
  _wfs(p, mutatedSrc, "utf8");
  try {
    return await import(`file://${p.replace(/\\/g, "/")}`);
  } finally {
    _rm(dir, { recursive: true, force: true });
  }
}

test("mutation 3 (필수): judgeInboxTimeAudit이 항상 NORMAL을 반환하도록 무력화 -> 0104(55분 오기) 표본이 정상으로 통과 -> RED", async () => {
  const src = readFileSync(_CORE_PATH, "utf8");
  const target = "export function judgeInboxTimeAudit(args) {\n";
  _assertExactlyOneMatch(src, target, "judgeInboxTimeAudit signature");
  const mutated = src.replace(
    target,
    'export function judgeInboxTimeAudit(args) {\n  return { ok: true, verdict: INBOX_AUDIT_VERDICT.NORMAL, reasonCode: "DISABLED", details: null };\n',
  );
  const mod = await _importMutant(mutated);
  const result = mod.judgeInboxTimeAudit({
    headerTimeMs: kst(2026, 8, 5, 1, 4),
    creationTimeMs: kst(2026, 8, 5, 1, 58, 35),
  });
  assert.equal(
    result.verdict,
    "NORMAL",
    "RED: with the judge disabled, the 55min-off 0104 sample wrongly reports NORMAL",
  );
});

test("mutation 4 (필수, ★핵심): 판정을 mtime(lastWriteTimeMs) 단독으로 되돌림 -> 0303 정상 표본이 오탐(MISMATCH)된다 -> RED (오탐 억제가 실제로 살아있다는 증거)", async () => {
  const src = readFileSync(_CORE_PATH, "utf8");
  // creationTimeMs 분기를 제거하고 lastWriteTimeMs만으로 판정하도록 되돌림
  // (mtime 단독 판정 = 이 이슈가 금지한 바로 그 실수).
  const target =
    "  if (isFiniteMs(creationTimeMs)) {\n    const agree = withinTolerance(headerTimeMs, creationTimeMs, toleranceMs);\n";
  _assertExactlyOneMatch(src, target, "creationTime branch guard");
  const mutated = src.replace(
    target,
    "  if (isFiniteMs(lastWriteTimeMs)) {\n    const agree = withinTolerance(headerTimeMs, lastWriteTimeMs, toleranceMs);\n",
  );
  const mod = await _importMutant(mutated);
  const result = mod.judgeInboxTimeAudit({
    headerTimeMs: kst(2026, 8, 5, 3, 3),
    creationTimeMs: kst(2026, 8, 5, 3, 3, 57), // 정상, 이제 안 쓰임(변조 후)
    lastWriteTimeMs: kst(2026, 8, 5, 3, 29), // +26분
  });
  assert.equal(
    result.verdict,
    "MISMATCH",
    "RED: mtime-only judging flips the genuinely-normal 0303 sample to a false MISMATCH -- this is exactly the false positive coder-task.md §4-2 ③ forbids",
  );
});

// ---------------------------------------------------------------------------
// HYK-186 3R P2 (독립 검토 조건 목록, 원문 그대로 하나씩) -- N을 넓힌다.
// 각 표본은 [조건 · 기대값 · 근거]를 명시한다. 이 판정기 범위 밖으로 판단해
// 뺀 조건은 "제외" 표로 별도 정리(맨 끝).
// ---------------------------------------------------------------------------

// 조건1: 자정 넘김과 날짜 anchor -- CORE 레벨(ms epoch 비교라 날짜 경계
// 자체는 문제가 안 됨을 보인다; wire 레이어의 날짜 anchor 유도 방식은
// 별개 -- 아래 "제외" 표 참고).
test("P2 조건1 (자정 넘김): header 08-05 23:59 / creation 08-06 00:01 (실제로는 2분 차) -> NORMAL, 기대값=NORMAL", () => {
  const result = judgeInboxTimeAudit({
    headerTimeMs: kst(2026, 8, 5, 23, 59),
    creationTimeMs: kst(2026, 8, 6, 0, 1),
  });
  assert.equal(result.verdict, INBOX_AUDIT_VERDICT.NORMAL);
});

// 조건2: KST/호스트 timezone 차이 -- CORE는 절대 epoch ms만 비교하므로
// "호스트가 어느 시간대인가"는 입력 시각이 이미 올바른 epoch로 해석된
// 이상 결과에 영향이 없다. Date.parse에 다른 오프셋(+09:00 vs +00:00)을
// 써도 같은 실제 순간이면 동일하게 판정됨을 보인다.
test("P2 조건2 (timezone 차이): 같은 실제 순간을 KST(+09:00) 오프셋과 UTC(+00:00) 오프셋으로 각각 표기해도 동일 판정 -> NORMAL, 기대값=NORMAL(epoch ms 비교라 시간대 무관)", () => {
  const headerKst = Date.parse("2026-08-05T12:00:00+09:00"); // 2026-08-05 03:00 UTC
  const creationUtc = Date.parse("2026-08-05T03:01:00+00:00"); // same instant +1min
  const result = judgeInboxTimeAudit({
    headerTimeMs: headerKst,
    creationTimeMs: creationUtc,
  });
  assert.equal(result.verdict, INBOX_AUDIT_VERDICT.NORMAL);
});

// 조건3: tolerance 경계와 초 단위 반올림 -- 헤더가 초를 안 적는 관례(분
// 단위)이므로 실제 creationTime의 초 성분이 얼마든(0~59초) tolerance
// 안쪽이면 NORMAL이어야 한다.
test("P2 조건3 (초 단위 반올림): 헤더는 분만(초=0 취급) 적혔는데 creationTime이 59초 -> tolerance(2분) 안쪽 -> NORMAL, 기대값=NORMAL", () => {
  const result = judgeInboxTimeAudit({
    headerTimeMs: kst(2026, 8, 5, 1, 4, 0),
    creationTimeMs: kst(2026, 8, 5, 1, 4, 59),
  });
  assert.equal(result.verdict, INBOX_AUDIT_VERDICT.NORMAL);
});

test("P2 조건3 (경계 재확인, 초 포함): 정확히 tolerance만큼(2분 0초) 차이 -> NORMAL / +1초 -> MISMATCH, 기대값 각각 명시", () => {
  const headerTimeMs = kst(2026, 8, 5, 1, 4, 0);
  const atBoundary = judgeInboxTimeAudit({
    headerTimeMs,
    creationTimeMs: kst(2026, 8, 5, 1, 6, 0), // +2:00
  });
  assert.equal(atBoundary.verdict, INBOX_AUDIT_VERDICT.NORMAL, "기대값=NORMAL");
  const pastBoundary = judgeInboxTimeAudit({
    headerTimeMs,
    creationTimeMs: kst(2026, 8, 5, 1, 6, 1), // +2:01
  });
  assert.equal(
    pastBoundary.verdict,
    INBOX_AUDIT_VERDICT.MISMATCH,
    "기대값=MISMATCH",
  );
});
