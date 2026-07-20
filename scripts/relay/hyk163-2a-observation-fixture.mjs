// HYK-163 사이클3 2단 (pm-3 §5 step6, coder-task HYK-163-coder-6): 실 2A
// read-only 관측(관제실 `2026-07-21-hyk163-사이클3-2A-관측/2A-관측-receipt.md`
// + `raw/`, 사람 북극성 승인 2026-07-21 01:1x)을 auth-observation-receipt.mjs
// receipt 스키마로 옮겨 담은 **self-contained immutable fixture**다.
//
// M1: 이 파일은 런타임에 `D:\문서관리\하네스-관제실\` 경로를 읽지 않는다
// (HYK-160 enforce-CI "로컬 전용 파일 의존" 교훈 재발 방지). 아래 모든 리터럴은
// 2A 관측 시점에 ORCH가 raw 파일로 캡처한 값의 정적 복사본이며, raw_sha256/
// byte_length/collected_at을 provenance로 박아 원문과 대조 가능하게 한다. 이
// 파일도, 이 파일을 쓰는 테스트도 실 Orca를 호출하지 않는다(실 orca 접촉 0).

function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// G6 -- pm-3 §3.3 계약. 원문: raw/terminal-show-spike.json (2A 관측 #5).
// ---------------------------------------------------------------------------
export const G6_RAW_PROVENANCE = Object.freeze({
  source_file: "terminal-show-spike.json",
  raw_sha256:
    "2b1d8821d8bd8ea5572955dfec0a61cd889238d8455108f2b8bdcff4ea06c187",
  byte_length: 1613,
  // 관측창 2026-07-21 01:15:02~01:17:55 +09:00 내(receipt 헤더) -- ORCH가
  // 명령별 개별 타임스탬프를 따로 기록하지 않아 이 창 안의 근사치다(정직
  // 한계, 조작된 정밀도 아님).
  collected_at: "2026-07-21T01:16:00+09:00",
});

// 실측 원문(2A-관측-receipt.md §2)이 노출한 필드 전수: handle, ptyId,
// worktreeId, worktreePath, branch, tabId, leafId, title, connected, writable,
// lastOutputAt, preview, paneRuntimeId(관측값 -1), rendererGraphEpoch. 아래
// handle/worktree 두 값만 receipt 스키마의 target 식별자로 옮긴다 -- 나머지는
// judgeLivenessFromReceipt가 애초에 읽지 않는 보조 필드다(consumer 비권위
// 계약, connected/writable/title/preview/lastOutputAt 전부 배제).
const REAL_HANDLE = "term_ca5a062c-f6b4-4dc2-bd37-c33588407bbe";
const REAL_WORKTREE =
  "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/Documents/HARNESSENGINEERING";

// pm-3 §3.3 계약의 target/observed_target은 {handle, worktree, agent_instance}
// 셋을 요구하지만, 2A 실측 스키마 전체를 훑어도 agent_instance에 해당하는
// 필드가 없다(2A-관측-receipt.md §2 "결정적 agent instance ID 없음", 스키마
// scan 결과 alive/heartbeat/liveness/instance/agentId/started/freshness/
// lifecycle/readyForInject 필드 정의 0). 이 sentinel은 진짜 ID가 아니라 그
// 부재를 문서화하는 placeholder일 뿐이다 -- receipt 구조 검사(shape)를 통과
// 시키는 용도로만 쓰고, 진짜 실패 사유는 아래 liveness_signal/
// lifecycle_distinguished=false(실측 그대로)에서 나온다.
const AGENT_INSTANCE_NOT_EXPOSED =
  "NOT_EXPOSED_BY_ORCA_CLI__2A_OBSERVATION_2026-07-21";

export const G6_EXPECTED_TARGET = Object.freeze({
  handle: REAL_HANDLE,
  worktree: REAL_WORKTREE,
  agent_instance: AGENT_INSTANCE_NOT_EXPOSED,
});

// Orca `--version`이 `--help`와 바이트 단위로 동일한 출력을 반환함을 2A가
// 실측(raw/version.txt sha256 == raw/help-root.txt sha256) -- 이 CLI 표면에
// 별도 버전 문자열이 없다는 사실 그대로를 옮긴다(외삽 금지).
const ORCA_VERSION_NOTE =
  "unversioned: 'orca --version' returned output byte-identical to '--help' " +
  "(no distinct version string exposed), observed 2026-07-21 (raw/version.txt " +
  "sha256 == raw/help-root.txt sha256 in 2A manifest)";

export const REAL_2A_G6_RECEIPT = deepFreeze({
  canary_id: "hyk163-2a-g6-terminal-show-term_ca5a062c",
  target: {
    handle: REAL_HANDLE,
    worktree: REAL_WORKTREE,
    agent_instance: AGENT_INSTANCE_NOT_EXPOSED,
  },
  raw_sha256: G6_RAW_PROVENANCE.raw_sha256,
  byte_length: G6_RAW_PROVENANCE.byte_length,
  orca_version: ORCA_VERSION_NOTE,
  collected_at: G6_RAW_PROVENANCE.collected_at,
  // 8개 read-only 명령 전수(2A-관측-receipt.md §1) 전부 ok:true, 실패 0.
  exit_code: 0,
  // 2A는 read-only 탐색만 수행했다 -- hook logger armed-check(양성 대조)는
  // 2B active canary(G10) 범위이며 이번엔 수행하지 않았다. 정직하게 false.
  positive_control: false,
  // 2B canary(G10 hook hit/miss)를 수행하지 않았으므로 이 receipt는 hook
  // 판정 대상이 아니다 -- UNJUDGABLE이 정직한 값(HIT/MISS 둘 다 근거 없음).
  hook_result: "UNJUDGABLE",

  // ---- G6 전용 필드 (pm-3 §3.3 6조건, auth-observation-receipt.mjs
  // checkG6ExtraFields/checkLivenessAndLifecycle이 읽음) ----
  // 실측 그대로: 결정적 liveness 신호도, live/dead 대조 증거도 없다
  // (2A-관측-receipt.md §2 "후보 필드도 결정적 liveness 없음"). 추측으로
  // true를 넣지 않고 "없음"을 fail-closed 값 false로 정직 인코딩한다.
  observed_target: {
    handle: REAL_HANDLE,
    worktree: REAL_WORKTREE,
    agent_instance: AGENT_INSTANCE_NOT_EXPOSED,
  },
  liveness_signal: false,
  lifecycle_distinguished: false,
});

// ---------------------------------------------------------------------------
// G9 -- pm-3 §3.4 계약. 원문: raw/dispatch-show-preamble.json (2A 관측 #7).
// ---------------------------------------------------------------------------
export const G9_RAW_PROVENANCE = Object.freeze({
  source_file: "dispatch-show-preamble.json",
  raw_sha256:
    "75deb3259dd3d4085af0551d7ef0d65ed64c5850a40832a4cbab6aaf207f5134",
  byte_length: 5211,
  collected_at: "2026-07-21T01:17:30+09:00",
});

// 실제 주입 payload byte-complete 캡처(2A-관측-receipt.md §3, raw JSON
// `result.preamble` 필드 원문 그대로 -- 재타이핑 없이 JSON.stringify 출력을
// 그대로 옮긴 문자 단위 리터럴). `\n` 등은 JS 이스케이프 시퀀스이지 파일의
// 실 줄바꿈 바이트가 아니므로, 이 리터럴은 git checkout의 core.autocrlf
// LF<->CRLF 변환에 영향받지 않는다(coder-4 CRLF 교훈을 소스 자체에서 회피).
export const REAL_2A_CAPTURED_PAYLOAD =
  'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.\nYour coordinator\'s terminal handle is: term_4e89206a-76c5-405a-bb78-945737ef1dda\nYour task ID is: task_6409b3b68ae5\n\nYou talk to the coordinator only through the CLI commands below. Do not use\nSlack, GitHub comments, or any other channel to reach a human during the run.\n\n=== CLI COMMANDS ===\n\n  # Report task completion (REQUIRED when done — even on failure).\n  #\n  # RULE: --body must be a 3-sentence executive summary (what you did,\n  # what you found, what\'s left). Never send an empty body; the coordinator\n  # reads the body first and only opens artifacts if it needs more detail.\n  # If you produced a long-form artifact, include its path as\n  # payload.reportPath so the coordinator can find it without a file search.\n  #\n  # RULE: send worker_done exactly once. Failure is still a worker_done\n  # with subject like "Failed: <reason>" — never silently exit.\n  # Include BOTH taskId and dispatchId in the payload so a late completion\n  # from a failed retry cannot complete the current dispatch.\n  orca orchestration send --to term_4e89206a-76c5-405a-bb78-945737ef1dda --from term_27314538-1b6f-4363-9e37-7d27dd12395d \\\n    --type worker_done --subject "<short status>" \\\n    --body "<3-sentence summary: what you did, what you found, what\'s left>" \\\n    --task-id task_6409b3b68ae5 --dispatch-id ctx_a016468024e8 \\\n    --files-modified "path/a,path/b" \\\n    --report-path "<optional: path to the full artifact>"\n\n  # BEHAVIOR RULE: send a heartbeat every 5 minutes\n  # while actively working on the task. The coordinator uses this to\n  # distinguish "still thinking" from "hung / crashed." Skip heartbeats only\n  # while blocked inside `check --wait` or `ask` — those calls are\n  # themselves liveness signals.\n  #\n  # Include BOTH taskId and dispatchId in the payload: the coordinator\n  # attributes the heartbeat to the specific dispatch context, not just\n  # the task, so a straggler heartbeat from a previously-failed dispatch\n  # cannot mask a hung retry.\n  orca orchestration send --to term_4e89206a-76c5-405a-bb78-945737ef1dda --from term_27314538-1b6f-4363-9e37-7d27dd12395d \\\n    --type heartbeat --subject "alive" \\\n    --task-id task_6409b3b68ae5 --dispatch-id ctx_a016468024e8 \\\n    --phase "<short: investigating|implementing|reviewing|waiting>"\n\n  # Ask the coordinator a question and block until it answers.\n  #\n  # BEHAVIOR RULE #1 (MUST NOT VIOLATE):\n  # NEVER use AskUserQuestion; use `orca orchestration ask` or send\n  # --type decision_gate. AskUserQuestion opens a local TUI prompt that the\n  # coordinator cannot see and cannot answer — your session will hang forever\n  # waiting on a human. Every interactive question goes through `ask` below.\n  #\n  # The `ask` verb is a thin wrapper: it sends a decision_gate message and\n  # blocks on `check --wait` until the coordinator replies, then prints the\n  # reply body. Use it anywhere you would otherwise have reached for\n  # AskUserQuestion.\n  orca orchestration ask --to term_4e89206a-76c5-405a-bb78-945737ef1dda --from term_27314538-1b6f-4363-9e37-7d27dd12395d \\\n    --question "<your question>" \\\n    --options "<optional,comma,separated>" \\\n    --timeout-ms 600000\n\n  # Escalate a blocker or failure (pre-completion, when you need the\n  # coordinator to do something before you can continue):\n  orca orchestration send --to term_4e89206a-76c5-405a-bb78-945737ef1dda --from term_27314538-1b6f-4363-9e37-7d27dd12395d \\\n    --type escalation --subject "Blocked: <reason>" \\\n    --body "<details>" \\\n    --task-id task_6409b3b68ae5\n\n  # Check for messages from the coordinator:\n  orca orchestration check --terminal term_27314538-1b6f-4363-9e37-7d27dd12395d\n\n=== AFTER YOU SEND worker_done ===\n\nworker_done ends your turn for this task. Your dispatched work is complete:\nstop, return to an idle prompt, and take no further actions — do NOT start\nnew or unrelated work, do NOT run a sleep/poll loop, and do NOT keep calling\n`orca orchestration check`. The coordinator has already recorded your\ncompletion and expects no further output.\n\nDo not exit the shell. Your terminal stays available, and if the\ncoordinator has more for you it will re-engage this terminal with a fresh\npreamble + TASK block, which arrives as new input. When that happens,\nreset and start the new task; ignore the previous task\'s follow-ups.\n\n=== TASK ===\ngo SPIKE-LIVE-4';

export const REAL_2A_G9_EXPECTED_SPEC = "go SPIKE-LIVE-4";

export const REAL_2A_G9_RECEIPT = deepFreeze({
  canary_id: "task_6409b3b68ae5:ctx_a016468024e8",
  target: {
    handle: "term_27314538-1b6f-4363-9e37-7d27dd12395d",
    worktree: REAL_WORKTREE,
    agent_instance: AGENT_INSTANCE_NOT_EXPOSED,
  },
  raw_sha256: G9_RAW_PROVENANCE.raw_sha256,
  byte_length: G9_RAW_PROVENANCE.byte_length,
  orca_version: ORCA_VERSION_NOTE,
  collected_at: G9_RAW_PROVENANCE.collected_at,
  exit_code: 0,
  positive_control: false,
  hook_result: "UNJUDGABLE",

  // ---- G9 전용 필드 (pm-3 §3.4, judgePayloadFromReceipt가 읽음) ----
  // dispatch-show가 반환한 원문을 그대로 옮겼다(잘림 없음 -- raw_sha256/
  // byte_length로 대조 가능한 완전한 캡처, 2A-관측-receipt.md §3).
  payload_complete: true,
  captured_payload: REAL_2A_CAPTURED_PAYLOAD,
});
