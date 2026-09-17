import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifySeatText,
  classifySeat,
  censusSeats,
  formatCensus,
  applyRegistryGuard,
  SEAT_KIND,
  runSeatCensusCli,
  LAUNCHER_ORIGIN_MARKER,
} from "./seat-census.mjs";
import {
  appendLaunchRecord,
  buildLaunchRecord,
} from "./seat-origin-registry.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "check", "seat-census.mjs");

// 실측 표본(2026-09-16, 이 라운드 자신의 워크트리 관측, orca terminal
// list --json 그대로): 빈 pwsh(D12 자동 생성분)의 preview는 프롬프트
// 한 줄뿐이다.
const REAL_EMPTY_SHELL_PREVIEW =
  "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk485-477-runner-receipt-1>";

// 실측: 방금 뜬 CODER 좌석의 preview 그대로(orca terminal list --json,
// 2026-09-16) -- "[CODER seat]"는 orca-worker-seat.ps1이 찍는 문구이지
// AGENT_BANNER_MARKERS의 "[CODER]"(codex 쪽 go 텍스트 마커, 대괄호 안이
// "seat" 없이 역할명만)와 다른 문자열이라 매치하지 않는다. 진행 중인
// 실제 에이전트인데도 이 스냅샷 하나만 보면 확정 마커가 없다 -- 그래서
// 이 값은 "확실한 에이전트" 픽스처가 아니라 "미상(ambiguous)" 픽스처로
// 쓴다(아래 대로).
const REAL_MIDTURN_PREVIEW_NO_MARKER =
  "sers\\Administrator\\...) match versioned hooks/. 좌석 기동 가능.\n" +
  "[CODER seat] worktree=C:\\...  pane=...\n✢ Percolating…";

// 확정 마커 픽스처(원 Looks-Like-Agent 마커 집합 그대로 재현) -- claude는
// --dangerously-skip-permissions 기동 시 "bypass permissions" 문구를,
// codex는 goText가 "[REVIEW]"를 화면에 남긴다(관제실 dispatch-worker.ps1
// 583-588행 goText 조립 -- $Role을 [ ] 안에 역할명만 넣어 보낸다, "seat"
// 접미어 없음 -- orca-worker-seat.ps1의 "[$Role seat]" 문구와는 다른 값).
const CONFIRMED_CLAUDE_AGENT_PREVIEW =
  "✻ Welcome to Claude Code!\n  bypass permissions on\n";
const CONFIRMED_CODEX_AGENT_PREVIEW =
  "너는 하네스 릴레이 [REVIEW] 워커다. D:\\...worker-dispatch-rule.md를 읽고...";

// 실측: ORCH 좌석(오래 실행됨) -- 배너 마커가 스크롤백 밖으로 밀려나
// 이번 관측의 preview 꼬리에는 하나도 안 남아 있었다(이 라운드 §정직
// 한계 근거 원문 그대로 사용).
const REAL_LONG_RUNNING_AGENT_PREVIEW =
  "❯ 사소한 문구 확인 1건:         지시에    «점검표(481    병합   전이라    손  기입   유지)»라    하셨는데     점검표    기계   주입은    480(미병합)이고";

// HYK-464-followup-1 축A 실측(ORCH 2026-09-16 19:16, 좌석 2, coder-task.md
// §1 축A 원문 그대로): 방금 기동한 CODER 좌석의 preview -- origin-registry
// RECORDED 줄이 있는데도(구 판정기가 이걸 못 봐서) AGENT_BANNER_MARKERS만
// 대조하면 미상으로 떨어졌던 그 표본.
const REAL_LAUNCHER_ORIGIN_PREVIEW =
  "sers\\Administrator\\...) match versioned hooks/. 좌석 기동 가능.\n" +
  "[4/4] 엔진 선별: engine=claude source=default role=CODER baseline_mode=off\n" +
  "[origin-registry] RECORDED paneKey=e6a43258-c71f-425f-97da-f5b1e62a3d1f:178d6f84-27f7-4fd0-9759-b95eeb3ad454 role=CODER engine=claude\n" +
  "· Hatching…";

test("classifySeatText: launcher's own [origin-registry] RECORDED line -> agent, positively identified (HYK-464-followup-1 축A ⓐ)", () => {
  assert.equal(classifySeatText(REAL_LAUNCHER_ORIGIN_PREVIEW), SEAT_KIND.AGENT);
});

test("LAUNCHER_ORIGIN_MARKER: matches seat-origin-registry.mjs's own record stdout shape (RECORDED paneKey=.. role=.. engine=..), mutation RED if the marker regex is dropped/narrowed", () => {
  assert.match(
    "RECORDED paneKey=tab:leaf role=REVIEW engine=codex",
    LAUNCHER_ORIGIN_MARKER,
  );
  // ⓑ: 마커의 세 조각(paneKey=/role=/engine=) 중 하나라도 빠지면 더 이상
  // "런처가 스스로 찍은 줄"이라는 확정 증거가 아니다 -- 그런 부분 일치를
  // AGENT로 오인하지 않는다(과대 매칭 방지, fail-closed 유지).
  assert.doesNotMatch("RECORDED paneKey=tab:leaf", LAUNCHER_ORIGIN_MARKER);
  assert.equal(
    classifySeatText("RECORDED paneKey=tab:leaf (role missing)"),
    SEAT_KIND.AMBIGUOUS,
  );
});

test("classifySeatText: without the launcher marker, an unrecognized mid-turn preview stays ambiguous, NOT empty_shell or agent (HYK-464-followup-1 축A ⓑ, ⓒ -- no false empty_shell revival)", () => {
  const withoutMarker = REAL_LAUNCHER_ORIGIN_PREVIEW.replace(
    /\[origin-registry\] RECORDED[^\n]*\n/,
    "",
  );
  assert.equal(classifySeatText(withoutMarker), SEAT_KIND.AMBIGUOUS);
});

test("classifySeatText: bare single-line prompt -> empty_shell (D12 auto-created blank tab)", () => {
  assert.equal(
    classifySeatText(REAL_EMPTY_SHELL_PREVIEW),
    SEAT_KIND.EMPTY_SHELL,
  );
});

// HYK-464 추기 수리(fail-closed 되돌리기): preview가 비었다는 사실은
// "증거 없음"이지 "빈 셸이라는 증거"가 아니다 -- 실측(2026-09-16
// ORCH-71)으로 살아 있는 ORCH 에이전트 좌석의 preview가 빈 문자열이었던
// 사례가 나왔다. 예전 버전은 이 케이스를 EMPTY_SHELL로 단정해 "꺼도
// 된다"는 거짓 확신을 만들었다(HYK-467 계열 재현) -- 이제 AMBIGUOUS로
// 정직하게 남긴다.
test("classifySeatText: empty string -> ambiguous (no evidence, NOT proof of empty shell)", () => {
  assert.equal(classifySeatText(""), SEAT_KIND.AMBIGUOUS);
  assert.equal(classifySeatText("   "), SEAT_KIND.AMBIGUOUS);
  assert.equal(classifySeatText(undefined), SEAT_KIND.AMBIGUOUS);
});

test("classifySeatText: fresh agent seat with recognizable banner -> agent", () => {
  assert.equal(
    classifySeatText(CONFIRMED_CLAUDE_AGENT_PREVIEW),
    SEAT_KIND.AGENT,
  );
  assert.equal(
    classifySeatText(CONFIRMED_CODEX_AGENT_PREVIEW),
    SEAT_KIND.AGENT,
  );
});

test("classifySeatText: explicit engine banner substrings -> agent", () => {
  assert.equal(
    classifySeatText("model: gpt-5.6-terra\nWeekly limit: 97% left"),
    SEAT_KIND.AGENT,
  );
  assert.equal(
    classifySeatText("Opus 5 · claude-opus-5\nbypass permissions on"),
    SEAT_KIND.AGENT,
  );
});

test("classifySeatText: long-running agent whose banner scrolled out of view -> ambiguous, NOT empty_shell", () => {
  // 이 케이스가 이 모듈을 새로 만든 이유다: 낡은 Looks-Like-Agent를 그대로
  // 재사용해 "마커 없으면 빈 셸"로 이분류했다면 실제로 일하고 있는 ORCH
  // 좌석이 "빈 셸"로 오분류됐을 것이다.
  assert.equal(
    classifySeatText(REAL_LONG_RUNNING_AGENT_PREVIEW),
    SEAT_KIND.AMBIGUOUS,
  );
});

test("classifySeatText: mid-turn CODER seat banner (orca-worker-seat.ps1's own log line) -> ambiguous, not a false empty_shell", () => {
  // [CODER seat] != AGENT_BANNER_MARKERS의 [CODER] (다른 문자열, 위 정의
  // 주석 참고) -- 이 라운드 자신을 띄운 실제 좌석의 실측 preview.
  assert.equal(
    classifySeatText(REAL_MIDTURN_PREVIEW_NO_MARKER),
    SEAT_KIND.AMBIGUOUS,
  );
});

test("classifySeatText: multi-line but non-prompt, non-banner content -> ambiguous (honest unknown, not forced into a bucket)", () => {
  assert.equal(
    classifySeatText("some random shell output\nline two\nline three"),
    SEAT_KIND.AMBIGUOUS,
  );
});

test("classifySeat: reads .preview off a terminal object", () => {
  assert.equal(
    classifySeat({ preview: REAL_EMPTY_SHELL_PREVIEW }),
    SEAT_KIND.EMPTY_SHELL,
  );
  assert.equal(
    classifySeat({ preview: CONFIRMED_CLAUDE_AGENT_PREVIEW }),
    SEAT_KIND.AGENT,
  );
});

test("censusSeats: counts agent/empty_shell/ambiguous and totals match the real 5-seat sample", () => {
  const terminals = [
    {
      handle: "term_a",
      worktreePath: "wt1",
      title: "t1",
      tabId: "ta",
      leafId: "la",
      preview: CONFIRMED_CLAUDE_AGENT_PREVIEW,
    },
    {
      handle: "term_b",
      worktreePath: "wt1",
      title: "t2",
      tabId: "tb",
      leafId: "lb",
      preview: REAL_EMPTY_SHELL_PREVIEW,
    },
    {
      handle: "term_c",
      worktreePath: "wt2",
      title: "t3",
      tabId: "tc",
      leafId: "lc",
      preview: CONFIRMED_CODEX_AGENT_PREVIEW,
    },
    {
      handle: "term_d",
      worktreePath: "wt2",
      title: "t4",
      tabId: "td",
      leafId: "ld",
      preview: REAL_EMPTY_SHELL_PREVIEW,
    },
    {
      handle: "term_e",
      worktreePath: "wt3",
      title: "t5",
      tabId: "te",
      leafId: "le",
      preview: REAL_LONG_RUNNING_AGENT_PREVIEW,
    },
  ];
  const census = censusSeats(terminals);
  assert.equal(census.total, 5);
  assert.equal(census.agentCount, 2);
  assert.equal(census.emptyShellCount, 2);
  assert.equal(census.ambiguousCount, 1);
  assert.equal(census.rows[0].paneKey, "ta:la");
});

// HYK-464 §2 범위 A 항목 2 + 시험 ⓓ: 등록부에 있는 pane key + 빈 셸처럼
// 보이는 preview -> 에이전트 또는 미상(빈 셸 아님), 근거가 출력에 남는다.
test("applyRegistryGuard: a registered pane key can never be reported empty_shell (downgraded to ambiguous, reason surfaces)", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "seat-launch-registry.jsonl");
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({ paneKey: "reg-tab:reg-leaf", role: "ORCH" }),
    );
    const census = censusSeats([
      {
        handle: "term_registered",
        worktreePath: "wt1",
        title: "t1",
        tabId: "reg-tab",
        leafId: "reg-leaf",
        preview: REAL_EMPTY_SHELL_PREVIEW, // looks like a bare shell prompt
      },
    ]);
    assert.equal(census.rows[0].kind, SEAT_KIND.EMPTY_SHELL); // before guard
    const guarded = applyRegistryGuard(census, registryPath);
    assert.equal(guarded.rows[0].kind, SEAT_KIND.AMBIGUOUS); // NOT empty_shell
    assert.equal(guarded.emptyShellCount, 0);
    assert.equal(guarded.ambiguousCount, 1);
    assert.match(
      guarded.rows[0].registryNote,
      /REGISTERED_PANE_CANNOT_BE_EMPTY_SHELL/,
    );
    assert.match(formatCensus(guarded), /registry-guard/); // rationale visible in output
  });
});

test("applyRegistryGuard: an unregistered pane key is left alone (no false negative widening) and a null registryPath is a no-op", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "seat-launch-registry.jsonl");
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({ paneKey: "some-other-pane", role: "CODER" }),
    );
    const census = censusSeats([
      {
        handle: "term_unregistered",
        tabId: "ta",
        leafId: "la",
        preview: REAL_EMPTY_SHELL_PREVIEW,
      },
    ]);
    const guarded = applyRegistryGuard(census, registryPath);
    assert.equal(guarded.rows[0].kind, SEAT_KIND.EMPTY_SHELL); // untouched
    assert.equal(guarded.registryOverrideCount, 0);

    const untouched = applyRegistryGuard(
      censusSeats([
        {
          handle: "term_x",
          tabId: "tx",
          leafId: "lx",
          preview: REAL_EMPTY_SHELL_PREVIEW,
        },
      ]),
      null,
    );
    assert.equal(untouched.rows[0].kind, SEAT_KIND.EMPTY_SHELL);
    assert.equal(untouched.registryOverrideCount, undefined);
  });
});

// HYK-464 §3 범위 B (P2-1): 등록 실패(손상된 줄)가 조용히 지나가지 않는다.
test("applyRegistryGuard: P2-1 -- corrupted registry lines are surfaced, not silently dropped", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "seat-launch-registry.jsonl");
    writeFileSync(
      registryPath,
      '{"paneKey":"good:1","role":"CODER"}\n{not json at all\n',
      "utf8",
    );
    const census = censusSeats([
      { handle: "term_a", tabId: "ta", leafId: "la", preview: "" },
    ]);
    const guarded = applyRegistryGuard(census, registryPath);
    assert.equal(guarded.registryCorruptedLineCount, 1);
    assert.match(formatCensus(guarded), /손상 줄 1건/);
  });
});

test("formatCensus: human-readable summary line names what was counted", () => {
  const census = censusSeats([
    {
      handle: "term_a",
      preview: CONFIRMED_CLAUDE_AGENT_PREVIEW,
      tabId: "ta",
      leafId: "la",
    },
  ]);
  const text = formatCensus(census);
  assert.match(text, /좌석 수\(정본\): 전체=1/);
  assert.match(text, /에이전트=1/);
});

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "seat-census-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runSeatCensusCli: --terminal-list-file reads orca terminal list --json shape offline (no live orca needed, CI-safe)", () => {
  withTempDir((dir) => {
    const file = join(dir, "terminals.json");
    writeFileSync(
      file,
      JSON.stringify({
        result: {
          terminals: [
            {
              handle: "term_a",
              preview: CONFIRMED_CLAUDE_AGENT_PREVIEW,
              tabId: "ta",
              leafId: "la",
            },
            {
              handle: "term_b",
              preview: REAL_EMPTY_SHELL_PREVIEW,
              tabId: "tb",
              leafId: "lb",
            },
          ],
        },
      }),
      "utf8",
    );
    const outcome = runSeatCensusCli(["--terminal-list-file", file]);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.census.total, 2);
    assert.equal(outcome.census.agentCount, 1);
    assert.equal(outcome.census.emptyShellCount, 1);
  });
});

test("runSeatCensusCli: rejects a JSON shape without .result.terminals[]", () => {
  withTempDir((dir) => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ nope: true }), "utf8");
    assert.throws(() => runSeatCensusCli(["--terminal-list-file", file]));
  });
});

test("CLI end-to-end: --json prints machine-readable census", () => {
  withTempDir((dir) => {
    const file = join(dir, "terminals.json");
    writeFileSync(
      file,
      JSON.stringify({
        result: {
          terminals: [{ handle: "term_a", preview: REAL_EMPTY_SHELL_PREVIEW }],
        },
      }),
      "utf8",
    );
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT_PATH, "--terminal-list-file", file, "--json"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.total, 1);
    assert.equal(parsed.emptyShellCount, 1);
  });
});

// HYK-464 시험 ⓓ, CLI 통합 층: --terminal-list-file + --registry-path를
// 함께 넘기면(둘 다 오프라인 파일 기반이라 CI-safe) 등록된 pane이 빈
// 셸로 보고되지 않는다.
test("CLI end-to-end: --registry-path downgrades a registered-but-bare-looking pane away from empty_shell", () => {
  withTempDir((dir) => {
    const terminalsFile = join(dir, "terminals.json");
    const registryPath = join(dir, "seat-launch-registry.jsonl");
    writeFileSync(
      terminalsFile,
      JSON.stringify({
        result: {
          terminals: [
            {
              handle: "term_registered",
              tabId: "rt",
              leafId: "rl",
              preview: REAL_EMPTY_SHELL_PREVIEW,
            },
          ],
        },
      }),
      "utf8",
    );
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({ paneKey: "rt:rl", role: "ORCH" }),
    );
    const stdout = execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        "--terminal-list-file",
        terminalsFile,
        "--registry-path",
        registryPath,
        "--json",
      ],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.emptyShellCount, 0);
    assert.equal(parsed.ambiguousCount, 1);
    assert.equal(parsed.registryOverrideCount, 1);
  });
});
