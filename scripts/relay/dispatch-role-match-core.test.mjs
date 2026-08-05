// HYK-186 (coder-task.md §3) -- dispatch-role-match-core.mjs 시험.
//
// (a) 오늘 사고 재현: spec 역할 REVIEW / 좌석 역할 CODER (pane key는
//     일치한다는 전제, 오늘 사고의 핵심 -- 위조 검사는 통과했다) -> 거부.
//     HYK-186-role-match-3 (REVIEW P2 반려 수리): "pane key가 일치한다"는
//     조건이 이전엔 시험 제목·주석에만 있었고 실제 fixture 입력/단언으로는
//     검증되지 않았다 -- 이제 기존 상관 판정 코어(dispatch-correlation-
//     core.mjs의 judgeDispatchCorrelation, 재구현 금지)를 실제로 호출해
//     PROVEN을 코드로 확인한 뒤에만 역할 대조를 잇는다(주석이 아니라
//     코드로 pane key 일치를 증명).
// (b) 양방향: 같은 입력에서 역할만 바꾸면 결과가 뒤집힌다(pane key 일치는
//     양쪽 다 고정).
// (c) 판정 불가를 허용으로 접지 않는다: spec에 role: 없음 / 좌석 역할
//     없음 둘 다 UNDECIDABLE이고 ok:false.
// (d) 이름 규칙에 기대지 않음: 라벨에 "review"가 들어 있어도 명시
//     role: 필드가 없으면 UNDECIDABLE(추측 금지).
// (f) 필수 mutation: 매 실행마다 사본(저장소 밖 mkdtemp)에 결함을 심어
//     RED를 자동 확인한다. 이 파일은 아직 git HEAD에 없으므로(신규
//     파일) seat-liveness-wire.test.mjs 선례처럼 git show HEAD가 아니라
//     디스크의 실제 소스를 읽는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  judgeDispatchRoleMatch,
  extractRoleFromSpec,
  ROLE_MATCH_VERDICT,
  ROLE_MATCH_REASON,
} from "./dispatch-role-match-core.mjs";
import {
  judgeDispatchCorrelation,
  CORRELATION,
} from "./dispatch-correlation-core.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

// 오늘 실제로 쓰는 spec 형태(ORCH 실측, `orca orchestration task-list
// --json`의 `spec` 필드 원문) -- `go <라벨>` + `role:` 줄 + 안내문 +
// `worktree:` 줄이 공존한다.
function realSpecText(role, label) {
  return `go ${label}\nrole: ${role}\n\n작업 지시는 이 문구가 아니라 워크트리의 .harness/coder-task.md 에서 읽는다.\nworktree: C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\example`;
}

// HYK-186-role-match-3: 오늘 사고의 실제 pane key 형태(`<tabId>:<leafId>`,
// dispatch-correlation-core.mjs 실측 형태 재사용) -- seatRecord/dispatchShow/
// observed 세 값이 서로 일치해야 judgeDispatchCorrelation이 PROVEN을 낸다.
const INCIDENT_TAB_ID = "09338e28-c6a5-4045-8ddf-5082b97f951a";
const INCIDENT_LEAF_ID = "1b3a3ab8-d2f0-468f-8587-d8f9de950f22";
const INCIDENT_PANE_KEY = `${INCIDENT_TAB_ID}:${INCIDENT_LEAF_ID}`;
const INCIDENT_TASK_ID = "task_af43ff88ddfe";
const INCIDENT_DISPATCH_ID = "ctx_93f0eb82d906";

// pane key가 실제로 일치한다는 사실을 (주석이 아니라) judgeDispatchCorrelation
// 호출 결과로 코드가 직접 확인한다 -- PROVEN이 아니면 이 fixture 자체가
// "오늘 사고" 표본이 아니므로 테스트가 그 자리에서 실패해야 맞다.
function assertPaneKeyProven() {
  const correlation = judgeDispatchCorrelation({
    seatRecord: {
      paneKey: INCIDENT_PANE_KEY,
      taskId: INCIDENT_TASK_ID,
      dispatchId: INCIDENT_DISPATCH_ID,
    },
    dispatchShow: {
      ok: true,
      taskId: INCIDENT_TASK_ID,
      dispatchId: INCIDENT_DISPATCH_ID,
      assigneePaneKey: INCIDENT_PANE_KEY,
    },
    observed: {
      adoptionObservable: true,
      tabId: INCIDENT_TAB_ID,
      leafId: INCIDENT_LEAF_ID,
      taskId: INCIDENT_TASK_ID,
      dispatchId: INCIDENT_DISPATCH_ID,
    },
  });
  assert.equal(
    correlation.verdict,
    CORRELATION.PROVEN,
    "fixture이 실제로 pane-key-일치(PROVEN) 상태여야 '오늘 사고' 재현이 성립한다 -- 이 단언이 실패하면 fixture 자체가 잘못된 것",
  );
  return correlation;
}

// --- (a) 오늘 사고 재현 ---

test("HYK-186 (a)★ 오늘 사고 재현: pane key 실제 일치(PROVEN, 코드로 확인) + spec role REVIEW + seat role CODER -> MISMATCH/거부", () => {
  const correlation = assertPaneKeyProven();
  const result = judgeDispatchRoleMatch({
    specText: realSpecText("REVIEW", "HYK-186-role-match-1"),
    seatRole: "CODER",
  });
  assert.equal(result.ok, false, "역할이 어긋나면 pane key가 일치해도 거부");
  assert.equal(result.verdict, ROLE_MATCH_VERDICT.MISMATCH);
  assert.equal(result.reasonCode, ROLE_MATCH_REASON.ROLE_MISMATCH);
  // 결합 판정: pane key는 증명됐지만(위조 아님) 역할이 어긋나면 기동은
  // 여전히 막혀야 한다 -- 오늘 사고가 뚫었던 바로 그 지점.
  const combinedAllow = correlation.verdict === CORRELATION.PROVEN && result.ok;
  assert.equal(
    combinedAllow,
    false,
    "pane key 증명만으로는 역할 불일치를 덮지 못한다",
  );
});

// --- (b) 양방향: 역할만 바꾸면 결과가 뒤집힌다 (pane key 일치는 고정) ---

test("HYK-186 (b) 양방향: pane key 실제 일치(PROVEN) + 같은 spec/seat 쌍에서 역할이 같으면 MATCH(허용)", () => {
  const correlation = assertPaneKeyProven();
  const result = judgeDispatchRoleMatch({
    specText: realSpecText("CODER", "HYK-186-role-match-1"),
    seatRole: "CODER",
  });
  assert.equal(result.ok, true, "역할이 일치하면 허용");
  assert.equal(result.verdict, ROLE_MATCH_VERDICT.MATCH);
  const combinedAllow = correlation.verdict === CORRELATION.PROVEN && result.ok;
  assert.equal(
    combinedAllow,
    true,
    "pane key 증명 + 역할 일치 -> 정상 배달로 허용",
  );
});

test("HYK-186 (b) 양방향: pane key 실제 일치(PROVEN)는 고정한 채 역할만 바꾸면(REVIEW seat) 같은 spec이 거부로 뒤집힌다", () => {
  assertPaneKeyProven();
  const matched = judgeDispatchRoleMatch({
    specText: realSpecText("REVIEW", "HYK-186-role-match-1"),
    seatRole: "REVIEW",
  });
  assert.equal(matched.ok, true);
  const mismatched = judgeDispatchRoleMatch({
    specText: realSpecText("REVIEW", "HYK-186-role-match-1"),
    seatRole: "CODER",
  });
  assert.equal(mismatched.ok, false);
});

test("HYK-186 (b) 대소문자/공백은 판정에 영향 없음(같은 역할의 표기 차이일 뿐)", () => {
  const result = judgeDispatchRoleMatch({
    specText: realSpecText("  coder  ", "HYK-186-role-match-1"),
    seatRole: "CODER",
  });
  assert.equal(result.ok, true);
});

// --- (c) 판정 불가를 허용으로 접지 않는다 ---

test("HYK-186 (c)★ spec에 role: 필드가 아예 없으면 UNDECIDABLE, ok:false(허용 아님)", () => {
  const result = judgeDispatchRoleMatch({
    specText: "go HYK-9001\n\nworktree: C:\\example",
    seatRole: "CODER",
  });
  assert.equal(result.ok, false, "판정 불가는 허용이 아니다");
  assert.equal(result.verdict, ROLE_MATCH_VERDICT.UNDECIDABLE);
  assert.equal(result.reasonCode, ROLE_MATCH_REASON.SPEC_ROLE_MISSING);
});

test("HYK-186 (c)★ 좌석 역할이 비어 있으면(null/undefined/빈 문자열) UNDECIDABLE, ok:false", () => {
  for (const seatRole of [null, undefined, "", "   "]) {
    const result = judgeDispatchRoleMatch({
      specText: realSpecText("CODER", "HYK-9001"),
      seatRole,
    });
    assert.equal(result.ok, false, `seatRole=${JSON.stringify(seatRole)}`);
    assert.equal(result.verdict, ROLE_MATCH_VERDICT.UNDECIDABLE);
    assert.equal(result.reasonCode, ROLE_MATCH_REASON.SEAT_ROLE_MISSING);
  }
});

// --- (d) 이름 규칙에 기대지 않음 ---

test("HYK-186 (d)★ 라벨에 'review'가 들어 있어도 명시 role: 필드가 없으면 UNDECIDABLE(추측 금지)", () => {
  const result = judgeDispatchRoleMatch({
    specText: "go HYK-9001-review-1\n\nworktree: C:\\example",
    seatRole: "REVIEW",
  });
  assert.equal(
    result.ok,
    false,
    "라벨 문자열만으로 REVIEW를 추측해 통과시키면 안 된다",
  );
  assert.equal(result.verdict, ROLE_MATCH_VERDICT.UNDECIDABLE);
  assert.equal(result.reasonCode, ROLE_MATCH_REASON.SPEC_ROLE_MISSING);
});

test("HYK-186 (d) 본문 어딘가에 'role'이라는 단어가 등장해도(줄 시작이 아니면) 후보로 잡지 않는다", () => {
  const result = judgeDispatchRoleMatch({
    specText:
      "go HYK-9001\n\n이 태스크는 role 배정과 무관한 설명입니다(role: 이 아니라 그냥 단어).",
    seatRole: "CODER",
  });
  assert.equal(result.verdict, ROLE_MATCH_VERDICT.UNDECIDABLE);
});

test("extractRoleFromSpec: 타입이 문자열이 아니면 null", () => {
  assert.equal(extractRoleFromSpec(null), null);
  assert.equal(extractRoleFromSpec(undefined), null);
  assert.equal(extractRoleFromSpec(42), null);
});

// ---------------------------------------------------------------------------
// (f) 필수 mutation -- 저장소 밖 mkdtemp에 사본을 만들어 결함을 심는다.
// 이 파일은 신규(git HEAD에 아직 없음)이므로 디스크의 현재 소스를 그대로
// 읽는다(seat-liveness-wire.test.mjs 선례와 동형 -- git show HEAD가 아니라
// 실제 워킹트리 소스를 대상으로 한다는 점, 그 이유는 이 파일이 아직 커밋
// 전이라는 점이 다를 뿐 원칙은 같다).
// ---------------------------------------------------------------------------
const CORE_SRC_PATH = join(THIS_DIR, "dispatch-role-match-core.mjs");
const CORE_SRC = readFileSync(CORE_SRC_PATH, "utf8");

function applyMutation(src, find, replacement) {
  const count = src.split(find).length - 1;
  assert.equal(
    count,
    1,
    `mutation target string must match exactly once in the source, got ${count} -- stale or ambiguous target`,
  );
  return src.replace(find, replacement);
}

async function importMutatedCopy(mutate, label) {
  const mutantDir = mkdtempSync(join(tmpdir(), `hyk186-mutant-${label}-`));
  const mutantPath = join(mutantDir, "dispatch-role-match-core.mutant.mjs");
  writeFileSync(mutantPath, mutate(CORE_SRC), "utf8");
  try {
    return await import(`file://${mutantPath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

test("NC mutation/dispatch-role-match #1 (필수): SPEC_ROLE_MISSING 가드 제거(라벨 추측으로 대체) -> RED (오늘 사고 라벨-추측 방지가 로드베어링임을 증명)", async () => {
  const mutant = await importMutatedCopy(
    (src) =>
      applyMutation(
        src,
        'export function extractRoleFromSpec(specText) {\n  if (typeof specText !== "string") return null;\n  const m = specText.match(SPEC_ROLE_LINE_RE);\n  return m ? m[1] : null;\n}',
        'export function extractRoleFromSpec(specText) {\n  if (typeof specText !== "string") return null;\n  const m = specText.match(SPEC_ROLE_LINE_RE);\n  if (m) return m[1];\n  if (/review/i.test(specText)) return "REVIEW";\n  if (/coder/i.test(specText)) return "CODER";\n  return null;\n}',
      ),
    "1",
  );
  const result = mutant.judgeDispatchRoleMatch({
    specText: "go HYK-9001-review-1\n\nworktree: C:\\example",
    seatRole: "REVIEW",
  });
  assert.equal(
    result.ok,
    true,
    "mutant must guess REVIEW from the label and pass what the real gate refuses to judge (RED signal)",
  );
});

test("NC mutation/dispatch-role-match #2 (필수): 역할 비교를 항상 통과로 뒤집기 -> RED (오늘 사고 fixture가 더 이상 거부되지 않음을 증명)", async () => {
  const mutant = await importMutatedCopy(
    (src) =>
      applyMutation(
        src,
        "  if (specRole.trim().toUpperCase() !== seatRole.trim().toUpperCase()) {",
        "  if (false) {",
      ),
    "2",
  );
  const result = mutant.judgeDispatchRoleMatch({
    specText: realSpecText("REVIEW", "HYK-186-role-match-1"),
    seatRole: "CODER",
  });
  assert.equal(
    result.ok,
    true,
    "mutant must let today's actual mismatch (spec REVIEW / seat CODER) through as MATCH (RED signal; proves the comparison is load-bearing)",
  );
  assert.equal(result.verdict, ROLE_MATCH_VERDICT.MATCH);
});

test("NC mutation/dispatch-role-match #3 (필수): SEAT_ROLE_MISSING 가드 제거 -> RED (좌석 역할 미상을 허용으로 접지 않는다는 계약이 로드베어링임을 증명)", async () => {
  const mutant = await importMutatedCopy(
    (src) =>
      applyMutation(
        src,
        '  if (!isNonEmptyString(seatRole)) {\n    return verdict(\n      ROLE_MATCH_VERDICT.UNDECIDABLE,\n      ROLE_MATCH_REASON.SEAT_ROLE_MISSING,\n      "dispatch-role-match: seatRole is missing/empty -- cannot judge",\n    );\n  }\n',
        "",
      ),
    "3",
  );
  // 가드가 사라지면 seatRole(null)에 .trim()을 호출하다 예외를 던지거나,
  // 최소한 UNDECIDABLE/SEAT_ROLE_MISSING을 더 이상 내지 않는다 -- 둘 중
  // 어느 쪽이든 "판정 불가를 조용히 접지 않는다"는 계약이 깨졌다는 RED
  // 신호다.
  let threwOrChanged;
  try {
    const r = mutant.judgeDispatchRoleMatch({
      specText: realSpecText("CODER", "HYK-9001"),
      seatRole: null,
    });
    threwOrChanged = r.reasonCode !== ROLE_MATCH_REASON.SEAT_ROLE_MISSING;
  } catch {
    threwOrChanged = true;
  }
  assert.equal(
    threwOrChanged,
    true,
    "mutant must no longer cleanly report SEAT_ROLE_MISSING (RED signal; proves the guard is load-bearing)",
  );
});
