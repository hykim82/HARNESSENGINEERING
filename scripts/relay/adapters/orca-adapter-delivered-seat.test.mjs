// HYK-185-seat-corr (coder-task.md §2, §3-c/d) -- resolveDeliveredSeat 단위
// 시험. §2 세 단계(task-list 후보 좁히기 -> dispatch-show pane key ->
// 살아있는 좌석 대조)를 fake execFn만으로 검증한다(실 orca 호출 0).
//
// HYK-185-seat-corr-2 (REVIEW P1 수리, 2026-08-06): 이 시험이 전에 쓰던
// "go <라벨>\nrole: ..." 형태는 **어제 실측**이었고, 오늘 이 배달 자신을
// `.harness/증거/task-list-raw-0806.json`에서 직접 꺼내 보니 이미 폐기돼
// 있었다(ORCH 자인: "두 형식 다 내가 쓴 것이고 하루 만에 바꿨다"). 그래서
// realSpec()은 **오늘 raw의 이 배달 항목 그대로**(`task_657777c22e40`)를
// 따른다:
//   "role: CODER\nharness_label: HYK-185-seat-corr-1\nworktree: C:\...\hyk185-seat-multi (branch hyk185-seat-corr)\ntask_file: .harness/coder-task.md\n요지: ..."
// dispatch-show의 result.dispatch 필드는 여전히 scripts/relay/
// hyk171-cycle4b2c-fixtures.mjs의 rawDispatchShowP2()와 동일 키 집합
// (이번 라운드에서 안 바뀜, 이 부분은 반려 대상이 아니었다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveDeliveredSeat,
  DELIVERED_SEAT_REASON,
  buildTaskListDispatchedCommand,
  buildDispatchShowCommand,
  parseWorktreeSpecLine,
  isValidBranchNameGrammar,
} from "./orca-adapter.mjs";

const WORKTREE =
  "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk185-gap83-3";
const LABEL = "HYK-185-gap83-3";

// branchTail(선택): 오늘 실측 raw가 실제로 보였던 "worktree: <경로>
// (branch <이름>)" 꼬리 메타데이터를 재현하는 옵션 인자 -- 기본은 없음
// (꼬리 없는 spec도 여전히 매치돼야 한다는 것을 별도 시험이 고정한다).
function realSpec(role, label, worktree, branchTail) {
  const worktreeField = branchTail
    ? `${worktree} (branch ${branchTail})`
    : worktree;
  return `role: ${role}\nharness_label: ${label}\nworktree: ${worktreeField}\ntask_file: .harness/coder-task.md\n요지: (시험용 축약).`;
}

const CODER_SEAT = {
  handle: "term_coder",
  worktreePath: WORKTREE,
  tabId: "b7011967-041a-45e4-843c-0cf8e2ccd418",
  leafId: "ecdf87c2-a552-4370-9ecf-98d455404f0a",
};
const REVIEW_SEAT = {
  handle: "term_review",
  worktreePath: WORKTREE,
  tabId: "922c554b-453f-46fc-aa29-b1bfd880b318",
  leafId: "64a59f5b-3ee7-4fb1-b505-11f365080a4b",
};
const OTHER_WORKTREE_SEAT = {
  handle: "term_other",
  worktreePath:
    "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/pm-lane",
  tabId: "aaaaaaaa-1111-1111-1111-111111111111",
  leafId: "bbbbbbbb-2222-2222-2222-222222222222",
};

function paneKeyOf(seat) {
  return `${seat.tabId}:${seat.leafId}`;
}

// quality-check 복잡도 상한(12) 준수 -- 경로별 핸들러로 분리(makeExecFn
// 자신은 라우팅만 한다).
function handleTaskList(tasks) {
  return { ok: true, result: { tasks: tasks ?? [] } };
}
function handleDispatchShow(argv, dispatchByTaskId) {
  const taskId = argv[argv.indexOf("--task") + 1];
  const dispatch = (dispatchByTaskId ?? {})[taskId] ?? null;
  return { ok: true, result: { dispatch } };
}
function handleTerminalList(seats) {
  return {
    ok: true,
    result: {
      terminals: (seats ?? []).map((s) => ({
        handle: s.handle,
        worktreePath: s.worktreePath,
        tabId: s.tabId,
        leafId: s.leafId,
      })),
    },
  };
}
function handleTerminalShow(argv, seats) {
  const handle = argv[argv.indexOf("--terminal") + 1];
  const seat = (seats ?? []).find((s) => s.handle === handle);
  if (!seat) return { ok: false, error: { code: "terminal_handle_stale" } };
  return {
    ok: true,
    result: { terminal: { tabId: seat.tabId, leafId: seat.leafId } },
  };
}

function makeExecFn({ tasks, dispatchByTaskId, seats }) {
  return function execFn(argv) {
    if (argv[0] === "orchestration" && argv[1] === "task-list") {
      return handleTaskList(tasks);
    }
    if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
      return handleDispatchShow(argv, dispatchByTaskId);
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return handleTerminalList(seats);
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      return handleTerminalShow(argv, seats);
    }
    throw new Error(`makeExecFn: unexpected argv ${JSON.stringify(argv)}`);
  };
}

test("buildTaskListDispatchedCommand/buildDispatchShowCommand: exact argv shape (real-CLI-measured, same shape teardown-inventory-adapter.mjs's deleted builders used)", () => {
  assert.deepEqual(buildTaskListDispatchedCommand(), [
    "orchestration",
    "task-list",
    "--status",
    "dispatched",
    "--json",
  ]);
  assert.deepEqual(buildDispatchShowCommand("task_abc"), [
    "orchestration",
    "dispatch-show",
    "--task",
    "task_abc",
    "--json",
  ]);
});

test("resolveDeliveredSeat: happy path -- exactly one task-list candidate + pane key matches exactly one live seat -> resolved", () => {
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: realSpec(
          "CODER",
          LABEL,
          "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
        ),
      },
    ],
    dispatchByTaskId: {
      task_1: {
        id: "dispatch_1",
        task_id: "task_1",
        assignee_handle: CODER_SEAT.handle,
        assignee_pane_key: paneKeyOf(CODER_SEAT),
        status: "dispatched",
      },
    },
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.handle, CODER_SEAT.handle);
  assert.equal(r.runtimeTaskId, "task_1");
});

// ---- HYK-185-seat-corr-2 (REVIEW P1 수리): worktree 줄 꼬리의 "(branch
// <이름>)" 메타데이터를 벗기는 정규화 규칙을 직접 고정한다 -- 오늘 실측
// raw가 실제로 이 꼬리를 달고 있었다(§2 반려 사유 원문). 꼬리가 있어도/
// 없어도 둘 다 매치해야 하고, 꼬리 안의 값 자체는 비교에 안 쓴다(경로만
// 비교).
test("resolveDeliveredSeat: worktree spec line with a trailing '(branch <name>)' tail (today's real raw shape) still matches after normalization", () => {
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: realSpec(
          "CODER",
          LABEL,
          "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
          "hyk185-seat-corr",
        ),
      },
    ],
    dispatchByTaskId: {
      task_1: {
        id: "dispatch_1",
        task_id: "task_1",
        assignee_handle: CODER_SEAT.handle,
        assignee_pane_key: paneKeyOf(CODER_SEAT),
        status: "dispatched",
      },
    },
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.handle, CODER_SEAT.handle);
});

test("resolveDeliveredSeat: worktree spec line WITHOUT a branch tail still matches (tail is optional, not required)", () => {
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        // branchTail omitted -- realSpec() falls back to a bare path.
        spec: realSpec(
          "CODER",
          LABEL,
          "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
        ),
      },
    ],
    dispatchByTaskId: {
      task_1: {
        id: "dispatch_1",
        task_id: "task_1",
        assignee_handle: CODER_SEAT.handle,
        assignee_pane_key: paneKeyOf(CODER_SEAT),
        status: "dispatched",
      },
    },
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.handle, CODER_SEAT.handle);
});

// ---- HYK-185-seat-corr-3 (REVIEW P2-2 counter-example, gate-2 round 3):
// the branch-tail strip used to accept ZERO leading whitespace, so a
// worktree line with NO space before "(branch ...)" collapsed onto the
// SAME normalized path as the correctly-spaced real one -- a genuinely
// different folder name (a prefix-collision worktree) could then be
// mistaken for the one actually requested and picked as the sole
// candidate. These three tests pin the fix: only "one-or-more space +
// exact tail shape + non-empty name" is stripped; anything else is left
// as literal text and therefore fails to match (fail-closed, never a
// silent pick).
function specWithRawWorktreeLine(label, rawWorktreeLine) {
  return `role: CODER\nharness_label: ${label}\nworktree: ${rawWorktreeLine}\ntask_file: .harness/coder-task.md\n요지: (시험용 축약).`;
}

test("resolveDeliveredSeat: REVIEW's exact counter-example -- worktree line with NO space before '(branch ...)' must NOT be treated as the same path as the correctly-spaced real one (prefix-collision guard)", () => {
  const realPath =
    "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3";
  // no space between the path and "(branch ...)" -- a different literal
  // string that must NOT normalize onto realPath.
  const collisionWorktreeLine = `${realPath}(branch hyk185-seat-corr)`;
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_prefix_collision",
        spec: specWithRawWorktreeLine(LABEL, collisionWorktreeLine),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

test("resolveDeliveredSeat: branch tail with an EMPTY name '(branch )' must NOT be stripped (non-empty name required)", () => {
  const realPath =
    "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3";
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: specWithRawWorktreeLine(LABEL, `${realPath} (branch )`),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

test("resolveDeliveredSeat: a DOUBLE branch tail '(branch a) (branch b)' only strips the outermost, leaving the inner tail attached -- still not a candidate", () => {
  const realPath =
    "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3";
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: specWithRawWorktreeLine(
          LABEL,
          `${realPath} (branch a) (branch b)`,
        ),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

test("resolveDeliveredSeat: branch tail with a SPACE-ONLY name '(branch   )' must NOT match (whitespace is not in the allowed name charset)", () => {
  const realPath =
    "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3";
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: specWithRawWorktreeLine(LABEL, `${realPath} (branch   )`),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

// ---- HYK-185-seat-corr-4 (§R4 "추가 권고" -- 문법 방식이면 이런 변형도
// 자동으로 막혀야 한다는 것을 직접 확인) ----
test("resolveDeliveredSeat: a TAB (not a space) before '(branch ...)' must NOT match (the grammar requires exactly one literal ASCII space, not \\s)", () => {
  const realPath =
    "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3";
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: specWithRawWorktreeLine(LABEL, `${realPath}\t(branch x)`),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

test("resolveDeliveredSeat: a U+00A0 NO-BREAK SPACE before '(branch ...)' must NOT match (only a literal ASCII U+0020 space qualifies, not any Unicode whitespace)", () => {
  const realPath =
    "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3";
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: specWithRawWorktreeLine(LABEL, `${realPath}\u00a0(branch x)`),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

test("resolveDeliveredSeat: a branch name containing a git-forbidden special char (e.g. '~') must NOT match (charset is a conservative subset, not full git ref-name validation)", () => {
  const realPath =
    "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3";
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: specWithRawWorktreeLine(LABEL, `${realPath} (branch a~b)`),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

// ---- HYK-192-seat-corr-5 (§4 -- 헤더 주장 ↔ 시험 대조표 작성 중 발견한
// 결손 2건): coder-task.md §0-C가 "4R이 이미 막은 것"으로 나열한 8개 중
// "미닫힌 꼬리"·"내장 개행" 둘은 4R 코드가 구조적으로 막고 있었지만
// (WITH_TAIL 정규식의 `\)$` 요구, specText가 줄 단위로 먼저 split되는
// 것) 그것을 직접 단언하는 시험이 없었다 -- 이번 라운드에서 보강한다
// (§4 요구 "뒷받침 안 되는 주장은 시험을 넣거나 문장을 지워라"를 "시험을
// 넣는" 쪽으로 이행).
test("resolveDeliveredSeat: an UNCLOSED branch tail (missing the closing ')') must NOT match -- WITH_TAIL requires the literal ')' right before '$'", () => {
  const realPath =
    "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3";
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        // note: no closing ")" at the end.
        spec: specWithRawWorktreeLine(LABEL, `${realPath} (branch main`),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

test("resolveDeliveredSeat: an EMBEDDED NEWLINE inside what would otherwise be the branch tail must NOT match -- the spec is split into lines before parsing, so the tail's closing part becomes a separate, unrelated line", () => {
  const realPath =
    "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3";
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        // a literal newline splits "(branch mai" from "n)" onto two
        // separate lines -- specWithRawWorktreeLine's own template
        // already inserts \n between spec fields, so we inject one more
        // \n mid-tail directly into the worktree line's raw text.
        spec: specWithRawWorktreeLine(LABEL, `${realPath} (branch mai\nn)`),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

// ---- HYK-185-seat-corr-4 (§3-c): 문법 자체(앵커·비되돌아가기·문자
// 집합)를 parseWorktreeSpecLine 레벨에서 직접 고정 -- resolveDeliveredSeat
// 를 거치지 않고 파서 함수 하나로 그 계약을 단언한다.
test("parseWorktreeSpecLine: grammar-level assertions (anchored, exactly two forms, conservative branch-name charset)", () => {
  // ① 꼬리 없음 -- 경로 그대로.
  assert.deepEqual(parseWorktreeSpecLine("worktree: C:\\a\\b"), {
    path: "C:\\a\\b",
    branchName: null,
  });
  // ② 꼬리 있음(실측 형식) -- 경로/브랜치명 분리.
  assert.deepEqual(
    parseWorktreeSpecLine("worktree: C:\\a\\b (branch hyk185-seat-corr)"),
    { path: "C:\\a\\b", branchName: "hyk185-seat-corr" },
  );
  // 문법 밖은 전부 null이거나(파싱 실패) 최소한 원래 경로와 다른 값 --
  // 아래는 둘 다 WITH_TAIL이 매치하지 않아 BARE_PATH로 떨어지므로
  // null은 아니지만, path에 "(branch ...)"가 그대로 섞여 실제 경로와는
  // 절대 같을 수 없다(resolveDeliveredSeat 레벨 시험들이 이를 이미
  // 확인했다 -- 여기서는 파서 자신의 반환 shape만 고정한다).
  assert.equal(
    parseWorktreeSpecLine("worktree: C:\\a\\b(branch x)").branchName,
    null,
  );
  assert.equal(
    parseWorktreeSpecLine("worktree: C:\\a\\b (branch )").branchName,
    null,
  );
  // 앵커 확인: 줄 앞뒤에 아무것도 못 붙는다 -- "worktree:" 접두가 줄
  // 중간에 있으면(앞에 다른 문자) 아예 매치하지 않는다(null). 두
  // 문법(꼬리 없음/꼬리 있음) 모두 각각 확인한다 -- 4R 당시엔
  // BARE_PATH 쪽만 이런 식으로 확인됐고 WITH_BRANCH_TAIL 쪽은
  // 개별적으로 단언된 적이 없었다(이번 라운드에서 §4 대조표 작성
  // 중 발견해 보강).
  assert.equal(parseWorktreeSpecLine("xworktree: C:\\a\\b"), null);
  assert.equal(
    parseWorktreeSpecLine("xworktree: C:\\a\\b (branch main)"),
    null,
  );
  // 빈 줄/undefined -- null(예외 던지지 않음).
  assert.equal(parseWorktreeSpecLine(""), null);
  assert.equal(parseWorktreeSpecLine(undefined), null);
});

// ---- HYK-192-seat-corr-5 (§3, 4R 반려 사유 직접 수리): 문자 집합("겹1")
// 안에 있지만 git refname 규칙이 그래도 금지하는 배치("겹2") -- REVIEW
// 반례 4개를 isValidBranchNameGrammar 레벨에서 직접 단언한다. 이 4개는
// 전부 `[A-Za-z0-9._/-]+`(겹1) 통과하는 문자들로만 구성돼 있으므로,
// 겹2가 없으면 4R 코드는 이들을 실제로 통과시켰다(4R 헤더의 "자동으로
// 거부된다"는 주장이 틀렸던 지점 -- 이번 라운드가 그 어긋남을 고친다).
test("isValidBranchNameGrammar: REVIEW's 4 counter-examples are all rejected (charset alone would have passed all 4 -- this is the structural layer that actually blocks them)", () => {
  assert.equal(isValidBranchNameGrammar(".."), false, "#1 bare '..'");
  assert.equal(
    isValidBranchNameGrammar("/main"),
    false,
    "#2 leading '/' -- '/main'",
  );
  assert.equal(
    isValidBranchNameGrammar("main/"),
    false,
    "#3 trailing '/' -- 'main/'",
  );
  assert.equal(
    isValidBranchNameGrammar("main..old"),
    false,
    "#4 embedded '..' -- 'main..old'",
  );
  // 정상 이름은 여전히 통과(넓히지 않되 좁히기만 한 것인지 확인).
  assert.equal(isValidBranchNameGrammar("hyk185-seat-corr"), true);
  assert.equal(isValidBranchNameGrammar("feature/sub-name"), true);
});

// ---- HYK-192-seat-corr-6 (§1, 독립 검토 반례 2개 -- 5R 헤더가 "의도적
//으로 구현하지 않는다"고 적었던 바로 그 두 규칙): 문자 집합(겹1)도
// 통과하고 옛 겹2(3규칙)에도 안 걸려 5R까지는 실제로 ok:true까지 갔던
// 반례들이다(coder-task.md §1, ORCH 독립 재현). git 실측(이 시험을
// 작성하며 직접 `git check-ref-format --branch`로 재확인, 출력
// 그대로): `feature//x`/`release.lock`/`a/b.lock/c` 전부 exit 128
// (거부) · `a.lockx`/`a/b.lockx/c`(접미사가 ".lock"이 아님)는 exit 0
// (허용) -- "포함"이 아니라 "구성요소가 정확히 .lock으로 끝나는가".
test("isValidBranchNameGrammar: independent review's 2 NEW counter-examples (found outside our 4 designated ones) are now rejected", () => {
  assert.equal(
    isValidBranchNameGrammar("feature//x"),
    false,
    "consecutive '//' ",
  );
  assert.equal(
    isValidBranchNameGrammar("release.lock"),
    false,
    "component ending in '.lock' (whole name)",
  );
  assert.equal(
    isValidBranchNameGrammar("a/b.lock/c"),
    false,
    "MIDDLE component ending in '.lock' -- git rejects this too, not just the last component",
  );
  // 과잉 거부 0: ".lock"이 아니라 "lockx"로 끝나는 구성요소는 git이
  // 실제로 허용한다(git check-ref-format 실측, 위 주석) -- "포함"이
  // 아니라 "정확히 그 접미사"만 막아야 한다는 것을 직접 확인한다.
  assert.equal(isValidBranchNameGrammar("a.lockx"), true);
  assert.equal(isValidBranchNameGrammar("a/b.lockx/c"), true);
});

// 같은 6개(기존 4 + 신규 2)를 resolveDeliveredSeat 레벨에서도 확인한다
// (§1 요구 3: "헬퍼만 부르는 시험으로 끝내지 마라" -- 가짜 task-list/
// dispatch-show/live-seat 응답으로 실제 프로덕션 경로를 직접 호출한다,
// 검토자와 같은 방식).
for (const [label, badName] of [
  ["#1 bare '..'", ".."],
  ["#2 leading '/' -- '/main'", "/main"],
  ["#3 trailing '/' -- 'main/'", "main/"],
  ["#4 embedded '..' -- 'main..old'", "main..old"],
  [
    "#5 (NEW, independent review) consecutive '//' -- 'feature//x'",
    "feature//x",
  ],
  [
    "#6 (NEW, independent review) '.lock' suffix -- 'release.lock'",
    "release.lock",
  ],
  [
    "#7 (NEW, self-added) MIDDLE component '.lock' -- 'a/b.lock/c'",
    "a/b.lock/c",
  ],
]) {
  test(`resolveDeliveredSeat: REVIEW counter-example (${label}) as a branch tail -- must NOT be treated as a valid candidate (git refname violation, in-charset but structurally invalid)`, () => {
    const realPath =
      "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3";
    const execFn = makeExecFn({
      tasks: [
        {
          id: "task_1",
          spec: specWithRawWorktreeLine(
            LABEL,
            `${realPath} (branch ${badName})`,
          ),
        },
      ],
      dispatchByTaskId: {},
      seats: [CODER_SEAT, REVIEW_SEAT],
    });
    const r = resolveDeliveredSeat(
      { harnessLabel: LABEL, worktreePath: WORKTREE },
      { execFn },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
  });
}

// ---- HYK-192-seat-corr-6 (§1 요구 4, §4-c: "과잉 거부 0" -- 정상
// 브랜치명·경로 안 괄호는 §1의 새 2규칙 이후에도 여전히 통과해야 한다).
// resolveDeliveredSeat 레벨에서 실제로 ok:true까지 나오는 것을
// 확인한다(헬퍼 단위 시험만으로 끝내지 않는다, 5R/§1 요구와 동일 원칙).
for (const [label, goodName] of [
  ["normal single-segment name -- 'feature/x'", "feature/x"],
  ["dotted version-like name -- 'v1.2.3'", "v1.2.3"],
  ["underscore+hyphen name -- 'a_b-c'", "a_b-c"],
  [
    "a component ending in 'lockx' (NOT '.lock') -- 'a/b.lockx/c' -- git accepts this, must not be over-rejected",
    "a/b.lockx/c",
  ],
]) {
  test(`resolveDeliveredSeat: over-rejection check (${label}) still resolves normally after §1's new rules`, () => {
    const execFn = makeExecFn({
      tasks: [
        {
          id: "task_1",
          spec: specWithRawWorktreeLine(
            LABEL,
            `${WORKTREE} (branch ${goodName})`,
          ),
        },
      ],
      dispatchByTaskId: {
        task_1: {
          id: "dispatch_1",
          task_id: "task_1",
          assignee_handle: CODER_SEAT.handle,
          assignee_pane_key: paneKeyOf(CODER_SEAT),
          status: "dispatched",
        },
      },
      seats: [CODER_SEAT, REVIEW_SEAT],
    });
    const r = resolveDeliveredSeat(
      { harnessLabel: LABEL, worktreePath: WORKTREE },
      { execFn },
    );
    assert.equal(r.ok, true);
    assert.equal(r.handle, CODER_SEAT.handle);
  });
}

// ---- HYK-192-seat-corr-6 (§0-C 통과 확인 사실 고정): `topic@{prior}`는
// git-refname 문법 위반이지만 §1의 새 2규칙과 무관하게 이미
// 겹1(문자 집합)만으로 거부된다('{'/'}' 는 BRANCH_NAME_CHARS 밖) --
// 검토자가 5R에서 이미 실측 확인한 사실을 시험으로 고정해 회귀를
// 막는다(이전에는 이 사실이 시험 없이 검토자의 관측으로만 남아 있었다).
test("resolveDeliveredSeat: 'topic@{prior}' is rejected via the charset layer alone (unrelated to §1's new rules, pinned per REVIEW's 5R observation)", () => {
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: specWithRawWorktreeLine(
          LABEL,
          `${WORKTREE} (branch topic@{prior})`,
        ),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

// ---- HYK-192-seat-corr-5 (§3-3, coder-task.md 요구 3): 경로 "안"의
// 괄호는 유효 입력이고 정상 통과해야 한다 -- §3의 새 구조 검사(겹2)는
// branchName 캡처 그룹에만 적용되고 path 캡처 그룹에는 절대 적용되지
// 않는다는 것을 직접 확인한다(회귀 없음).
test("resolveDeliveredSeat: parentheses INSIDE the path itself (not a branch tail) still match normally -- §3's new grammar layer only constrains the branch-name capture, never the path capture", () => {
  const pathWithParens =
    "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3 (copy)";
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: specWithRawWorktreeLine(LABEL, pathWithParens),
      },
    ],
    dispatchByTaskId: {
      task_1: {
        id: "dispatch_1",
        task_id: "task_1",
        assignee_handle: CODER_SEAT.handle,
        assignee_pane_key: paneKeyOf(CODER_SEAT),
        status: "dispatched",
      },
    },
    seats: [
      { ...CODER_SEAT, worktreePath: pathWithParens },
      { ...REVIEW_SEAT, worktreePath: pathWithParens },
    ],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: pathWithParens },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.handle, CODER_SEAT.handle);
});

test("resolveDeliveredSeat: harness_label line present but VALUE differs from the requested label -- not a candidate (exact match required, no partial/prefix match)", () => {
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: realSpec(
          "CODER",
          `${LABEL}-2`, // a different (but prefix-related) label
          "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
        ),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

// ---- HYK-185-seat-corr-2 (§3-a): 오늘 실측 raw로 상관이 실제로 성공한다
// (같은 워크트리·같은 배달 자신을 표본으로 삼는다, .harness/증거/
// {task-list,dispatch-show,terminal-list}-raw-0806.json 발췌 fixture) ----
const REAL_RAW = JSON.parse(
  readFileSync(
    new URL(
      "./hyk185-seat-corr-2026-08-06-real-dispatch-sample.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function makeExecFnFromRealRaw() {
  return function execFn(argv) {
    if (argv[0] === "orchestration" && argv[1] === "task-list") {
      return {
        ok: true,
        result: { tasks: REAL_RAW.taskListTasks },
      };
    }
    if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
      const taskId = argv[argv.indexOf("--task") + 1];
      return {
        ok: true,
        result: { dispatch: REAL_RAW.dispatchShowByTaskId[taskId] ?? null },
      };
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return {
        ok: true,
        result: {
          terminals: REAL_RAW.terminals.map((t) => ({
            handle: t.handle,
            worktreePath: t.worktreePath,
            tabId: t.tabId,
            leafId: t.leafId,
          })),
        },
      };
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      const handle = argv[argv.indexOf("--terminal") + 1];
      const seat = REAL_RAW.terminals.find((t) => t.handle === handle);
      if (!seat) return { ok: false, error: { code: "terminal_handle_stale" } };
      return {
        ok: true,
        result: { terminal: { tabId: seat.tabId, leafId: seat.leafId } },
      };
    }
    throw new Error(
      `makeExecFnFromRealRaw: unexpected argv ${JSON.stringify(argv)}`,
    );
  };
}

test("resolveDeliveredSeat: SUCCESS PATH on TODAY's real raw (2026-08-06, this very dispatch task_657777c22e40) -- correlation actually resolves, direct evidence P1 is closed", () => {
  const r = resolveDeliveredSeat(
    {
      harnessLabel: REAL_RAW.harnessLabel,
      worktreePath: REAL_RAW.worktreePath,
    },
    { execFn: makeExecFnFromRealRaw() },
  );
  assert.equal(r.ok, true);
  assert.equal(r.runtimeTaskId, "task_657777c22e40");
  assert.equal(r.handle, "term_3d3812a5-2031-4df0-9b4d-7865d7ddad2d");
});

// ---- (c) 형식 단언: tabId:leafId 벤더 형식이 깨지면 빨간불(gap#85 참조) ----
test("resolveDeliveredSeat: FORMAT ASSERTION -- pane key match requires the exact vendor format `${tabId}:${leafId}` (terminal-show-adapter.test.mjs asserts the same format for normalizeTerminalShow); any deviation must NOT match", () => {
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: realSpec(
          "CODER",
          LABEL,
          "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
        ),
      },
    ],
    dispatchByTaskId: {
      // assignee_pane_key intentionally uses a DIFFERENT separator/order --
      // if the vendor format ever changed (e.g. `${leafId}:${tabId}` or a
      // separator other than ':'), this must fail to match rather than
      // silently accepting a wrong seat.
      task_1: {
        id: "dispatch_1",
        task_id: "task_1",
        assignee_handle: CODER_SEAT.handle,
        assignee_pane_key: `${CODER_SEAT.leafId}:${CODER_SEAT.tabId}`,
        status: "dispatched",
      },
    },
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_LIVE_SEAT_MATCH);
});

test("resolveDeliveredSeat: FORMAT ASSERTION -- the exact correct format `${tabId}:${leafId}` (colon-joined, tabId first) does match", () => {
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: realSpec(
          "CODER",
          LABEL,
          "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
        ),
      },
    ],
    dispatchByTaskId: {
      task_1: {
        id: "dispatch_1",
        task_id: "task_1",
        assignee_handle: CODER_SEAT.handle,
        assignee_pane_key: `${CODER_SEAT.tabId}:${CODER_SEAT.leafId}`,
        status: "dispatched",
      },
    },
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.handle, CODER_SEAT.handle);
});

// ---- (d) 세 상관 실패 경로: 각각 조용히 통과하지 않고 실패로 드러나야 한다 ----

test("resolveDeliveredSeat: correlation-failure (1/3) -- ZERO task-list candidates (label+worktree match nothing) -> loud failure, never guesses", () => {
  const execFn = makeExecFn({
    tasks: [
      // 다른 워크트리를 가리키는 spec -- 후보가 아니다.
      {
        id: "task_other",
        spec: realSpec(
          "CODER",
          LABEL,
          "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\some-other-worktree",
        ),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

test("resolveDeliveredSeat: correlation-failure (2/3) -- TWO OR MORE task-list candidates match label+worktree -> loud failure, never picks one", () => {
  const spec = realSpec(
    "CODER",
    LABEL,
    "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
  );
  const execFn = makeExecFn({
    tasks: [
      { id: "task_1", spec },
      { id: "task_2", spec },
    ],
    dispatchByTaskId: {
      task_1: {
        id: "dispatch_1",
        task_id: "task_1",
        assignee_handle: CODER_SEAT.handle,
        assignee_pane_key: paneKeyOf(CODER_SEAT),
        status: "dispatched",
      },
    },
    seats: [CODER_SEAT, REVIEW_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.AMBIGUOUS_CANDIDATE_TASK);
});

test("resolveDeliveredSeat: correlation-failure (3/3) -- dispatch record's pane key matches NO live seat (dead-seat-only, ORCH-measured: 6/6 sampled dispatched records pointed at dead seats) -> loud failure, never trusts the record alone", () => {
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: realSpec(
          "CODER",
          LABEL,
          "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
        ),
      },
    ],
    dispatchByTaskId: {
      task_1: {
        id: "dispatch_1",
        task_id: "task_1",
        assignee_handle: "term_long_dead",
        // this pane key belongs to a seat that no longer appears in the
        // live terminal list at all (rotated/closed) -- the record exists
        // but the seat is dead.
        assignee_pane_key: "dead-tab-uuid:dead-leaf-uuid",
        status: "dispatched",
      },
    },
    seats: [CODER_SEAT, REVIEW_SEAT], // neither matches the dead pane key
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_LIVE_SEAT_MATCH);
});

test("resolveDeliveredSeat: candidate label matches but worktree path in spec points elsewhere -- not a candidate (label alone is not enough)", () => {
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: realSpec(
          "CODER",
          LABEL,
          "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\different-worktree",
        ),
      },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

test("resolveDeliveredSeat: a live seat in a DIFFERENT worktree sharing no pane key coincidence is not considered (worktree-scoped candidate filter, same principle as resolveSeatLivenessCandidate)", () => {
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: realSpec(
          "CODER",
          LABEL,
          "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
        ),
      },
    ],
    dispatchByTaskId: {
      task_1: {
        id: "dispatch_1",
        task_id: "task_1",
        assignee_handle: OTHER_WORKTREE_SEAT.handle,
        assignee_pane_key: paneKeyOf(OTHER_WORKTREE_SEAT),
        status: "dispatched",
      },
    },
    seats: [CODER_SEAT, REVIEW_SEAT, OTHER_WORKTREE_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_LIVE_SEAT_MATCH);
});

test("resolveDeliveredSeat: input validation -- missing harnessLabel/worktreePath refuses with INPUT_INVALID, zero execFn calls", () => {
  let calls = 0;
  const execFn = () => {
    calls++;
    throw new Error("must not be called");
  };
  const r1 = resolveDeliveredSeat({ worktreePath: WORKTREE }, { execFn });
  const r2 = resolveDeliveredSeat({ harnessLabel: LABEL }, { execFn });
  assert.equal(r1.ok, false);
  assert.equal(r1.reasonCode, DELIVERED_SEAT_REASON.INPUT_INVALID);
  assert.equal(r2.ok, false);
  assert.equal(r2.reasonCode, DELIVERED_SEAT_REASON.INPUT_INVALID);
  assert.equal(calls, 0);
});

test("resolveDeliveredSeat: task-list query failure (execFn throws) surfaces as TASK_LIST_QUERY_FAILED, not silently empty", () => {
  const execFn = () => {
    throw new Error("boom");
  };
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.TASK_LIST_QUERY_FAILED);
});

test("resolveDeliveredSeat: dispatch-show response missing dispatch record -> DISPATCH_SHOW_INVALID, no live-seat query attempted", () => {
  let terminalCalls = 0;
  const execFn = (argv) => {
    if (argv[0] === "orchestration" && argv[1] === "task-list") {
      return {
        ok: true,
        result: {
          tasks: [
            {
              id: "task_1",
              spec: realSpec(
                "CODER",
                LABEL,
                "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
              ),
            },
          ],
        },
      };
    }
    if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
      return { ok: true, result: { dispatch: null } };
    }
    terminalCalls++;
    throw new Error(`unexpected terminal query ${JSON.stringify(argv)}`);
  };
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.DISPATCH_SHOW_INVALID);
  assert.equal(terminalCalls, 0);
});

// ---- HYK-207-multiseat: 좌석 하나의 조회 실패가 축 전체를 눈멀게
// 하지 않는다 -- 규명 원문(수리 전): 2026-08-08 15:21/16:51/18:06 세 번
// 라이브 재현 당시, 이 워크트리에는 좌석이 2개 이상이었다(coder-task.md
// §1 실측). 위 fetchPaneKeyFromShow는 수리 전에는 조회 자체 실패(execFn
// throw -- 실제로는 실 orca CLI가 순간적으로 응답을 못 주거나, 프로세스
// 기동 자체가 실패했을 때(createOrcaExecFn, orca-adapter.mjs:2516-2537
// 참조) 벌어진다)를 {ok:false}로 그대로 전파해 resolveLiveSeatByPaneKey가
// 그 후보에서 즉시 순회를 중단했다 -- 좌석이 정확히 하나뿐이면 그 하나가
// 곧 우리가 찾는 좌석이라 이 결함이 드러나지 않지만, 좌석이 둘 이상이면
// "우리가 찾는 좌석과 무관한 다른 후보 하나"의 조회 실패만으로 축
// 전체가 COLLECTION_FAILED로 떨어진다 -- collectSeatObservationsForWorktree
// (seatIdle 축)가 이미 피해 간 "좌석 하나의 실패가 축 전체를 눈멀게
// 하는" 그 형태를, 이 상관 함수(seatLiveness/dispatchStart 축이 쓰는
// delivered-seat correlation retry)만 되풀이하고 있었다.
// ★이 시험을 고정한다: 좌석이 둘(CODER_SEAT + REVIEW_SEAT)이고, "우리가
// 찾는" 좌석이 아닌 쪽(REVIEW_SEAT)의 terminal show가 매번 throw해도,
// CODER_SEAT의 pane key가 assignee_pane_key와 정확히 일치하면 여전히
// 지목에 성공한다(고르지 않는 게 아니라, 무관한 후보의 실패에 흔들리지
// 않고 옳은 후보를 찾아낸다).
test("resolveDeliveredSeat: HYK-207-multiseat FIX -- one live seat's terminal show throws (transient CLI failure), the OTHER seat still correlates correctly (one seat's failure no longer blinds the whole axis)", () => {
  const execFn = (argv) => {
    if (argv[0] === "orchestration" && argv[1] === "task-list") {
      return handleTaskList([
        {
          id: "task_1",
          spec: realSpec(
            "CODER",
            LABEL,
            "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
          ),
        },
      ]);
    }
    if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
      return handleDispatchShow(argv, {
        task_1: {
          id: "dispatch_1",
          task_id: "task_1",
          assignee_handle: CODER_SEAT.handle,
          assignee_pane_key: paneKeyOf(CODER_SEAT),
          status: "dispatched",
        },
      });
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return handleTerminalList([CODER_SEAT, REVIEW_SEAT]);
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      const handle = argv[argv.indexOf("--terminal") + 1];
      if (handle === REVIEW_SEAT.handle) {
        throw new Error("transient orca CLI failure for this one candidate");
      }
      return handleTerminalShow(argv, [CODER_SEAT, REVIEW_SEAT]);
    }
    throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
  };
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.handle, CODER_SEAT.handle);
});

// 대칭 시험: throw하는 쪽이 우리가 "찾는" 좌석(CODER_SEAT) 자신이면 --
// 그 좌석의 pane key를 끝내 못 읽었으므로 매치 0개(NO_LIVE_SEAT_MATCH),
// 여전히 고르지 않고 실패로 드러난다(비타협 유지 -- 못 고르면 못
// 고른다고 말한다. "조회가 실패한 후보는 통과시켜 준다"는 뜻이 절대
// 아니다).
test("resolveDeliveredSeat: HYK-207-multiseat FIX -- if the seat we actually need throws (not some unrelated seat), correlation still fails loud (NO_LIVE_SEAT_MATCH), never silently accepted", () => {
  const execFn = (argv) => {
    if (argv[0] === "orchestration" && argv[1] === "task-list") {
      return handleTaskList([
        {
          id: "task_1",
          spec: realSpec(
            "CODER",
            LABEL,
            "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
          ),
        },
      ]);
    }
    if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
      return handleDispatchShow(argv, {
        task_1: {
          id: "dispatch_1",
          task_id: "task_1",
          assignee_handle: CODER_SEAT.handle,
          assignee_pane_key: paneKeyOf(CODER_SEAT),
          status: "dispatched",
        },
      });
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return handleTerminalList([CODER_SEAT, REVIEW_SEAT]);
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      const handle = argv[argv.indexOf("--terminal") + 1];
      if (handle === CODER_SEAT.handle) {
        throw new Error("transient orca CLI failure for the seat we need");
      }
      return handleTerminalShow(argv, [CODER_SEAT, REVIEW_SEAT]);
    }
    throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
  };
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_LIVE_SEAT_MATCH);
});

// 세 번째 축: 살아있는 후보 전부의 terminal show가 throw하면(정말
// "아무것도 못 봤다") -- 이건 "0개 일치"(NO_LIVE_SEAT_MATCH, 죽은 좌석
// 어휘)가 아니라 조회 자체가 전부 실패했다는 것이 더 정확한 사유이므로
// LIVE_SEAT_LIST_QUERY_FAILED로 구별해 드러낸다(합격기준 (d) 세 상관
// 실패 경로를 섞지 않는다는 원칙의 연장).
test("resolveDeliveredSeat: HYK-207-multiseat FIX -- ALL live seat candidates' terminal show throw -> distinguishable LIVE_SEAT_LIST_QUERY_FAILED (not conflated with dead-seat NO_LIVE_SEAT_MATCH)", () => {
  const execFn = (argv) => {
    if (argv[0] === "orchestration" && argv[1] === "task-list") {
      return handleTaskList([
        {
          id: "task_1",
          spec: realSpec(
            "CODER",
            LABEL,
            "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
          ),
        },
      ]);
    }
    if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
      return handleDispatchShow(argv, {
        task_1: {
          id: "dispatch_1",
          task_id: "task_1",
          assignee_handle: CODER_SEAT.handle,
          assignee_pane_key: paneKeyOf(CODER_SEAT),
          status: "dispatched",
        },
      });
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return handleTerminalList([CODER_SEAT, REVIEW_SEAT]);
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      throw new Error("transient orca CLI failure for every candidate");
    }
    throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
  };
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.LIVE_SEAT_LIST_QUERY_FAILED);
});

// fail-loud 비타협의 직접 고정: 두 live seat가 (드물지만) 같은
// pane key를 내면 -- resolveLiveSeatByPaneKey는 절대 matches[0]을
// 그냥 골라 지목하지 않는다(AMBIGUOUS_LIVE_SEAT_MATCH). 이 시험 이전에는
// 이 분기 자체를 직접 고정한 시험이 없었다(§5 "애매한데 아무거나 고르게"
// 변조가 조용히 살아남을 수 있는 구멍이었다) -- 이 함수를
// `return { ok: true, handle: matches[0].handle };`로 바꿔 "아무거나
// 고르게" 변조하면 이 시험이 RED로 떨어진다(수동 확인, 결과 파일 §5
// 변조 목록 참조).
test("resolveDeliveredSeat: fail-loud pin -- TWO live seats sharing the same pane key never silently pick the first one (AMBIGUOUS_LIVE_SEAT_MATCH)", () => {
  const sharedPaneKey = paneKeyOf(CODER_SEAT);
  const twinSeat = {
    handle: "term_twin",
    worktreePath: WORKTREE,
    tabId: CODER_SEAT.tabId,
    leafId: CODER_SEAT.leafId,
  };
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: realSpec(
          "CODER",
          LABEL,
          "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
        ),
      },
    ],
    dispatchByTaskId: {
      task_1: {
        id: "dispatch_1",
        task_id: "task_1",
        assignee_handle: CODER_SEAT.handle,
        assignee_pane_key: sharedPaneKey,
        status: "dispatched",
      },
    },
    seats: [CODER_SEAT, twinSeat],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.AMBIGUOUS_LIVE_SEAT_MATCH);
});

// HYK-207-multiseat 목록 밖 1종(§5 요구): ZERO live seats attached to this
// worktree at all(정상 침묵 -- 조회가 실패한 게 아니라 정말 아무 좌석도
// 없다)이면 여전히 NO_LIVE_SEAT_MATCH다. 위 fetchPaneKeyFromShow 수리로
// queryFailures 집계를 새로 들였으므로, "후보가 0개일 때 그 집계 조건
// (0===0)이 우연히 참이 되어 LIVE_SEAT_LIST_QUERY_FAILED로 잘못 분류되지
// 않는가"를 직접 고정한다 -- resolveLiveSeatByPaneKey의
// `resolved.candidates.length > 0` 가드가 바로 이 경계를 지킨다(그
// 가드를 지우면 이 시험이 RED로 떨어진다, 수동 확인·결과 파일 §5 참조).
test("resolveDeliveredSeat: HYK-207-multiseat -- ZERO live seats in the worktree at all is NO_LIVE_SEAT_MATCH (normal silence), not misclassified as a query failure by the new queryFailures accounting", () => {
  const execFn = makeExecFn({
    tasks: [
      {
        id: "task_1",
        spec: realSpec(
          "CODER",
          LABEL,
          "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk185-gap83-3",
        ),
      },
    ],
    dispatchByTaskId: {
      task_1: {
        id: "dispatch_1",
        task_id: "task_1",
        assignee_handle: CODER_SEAT.handle,
        assignee_pane_key: paneKeyOf(CODER_SEAT),
        status: "dispatched",
      },
    },
    seats: [], // this worktree has no live seats at all right now
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_LIVE_SEAT_MATCH);
});
