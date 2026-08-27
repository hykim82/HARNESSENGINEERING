// HYK-274-stale-screen-1 (coder-task.md §6, 완료 조건 4 -- RED 시험) -- "판정
// 절차를 화면 단독 의존으로 되돌리면 빨간불이 된다"를 성질(property)로
// 잡는 변이(mutation) 시험.
//
// ★배경(coder.md 실측 요약, 이 파일 헤더에도 옮긴다): ORCH grep이 "화면
// 소비자"로 지목한 3파일(dispatch-start-confirm-cli.mjs·dispatch-start-
// size-core.mjs·rate-limit-stall-adapter.mjs)은 재조사 결과 이미 orca 호출
// 0·화면 미사용(세션 로그 크기/jsonl 구조화 필드 기반)이었다 -- 그 헤더
// 주석의 "화면(`orca terminal read`)…" 언급이 grep을 오탐시켰을 뿐이다.
// 이 시험은 "화면 미사용"이 우연이 아니라 **성질로 고정**되어 있음을
// 증명한다 -- 문자열 부재 확인(옆 구멍으로 새는 방식, §6 경고)이 아니라
// "판정이 화면 밖 근거(관측 배열)만으로 결정되고, 관측에 화면 유래
// 필드가 섞여 들어와도 그 필드가 판정을 못 바꾼다"를 실제로 변이시켜
// 확인한다.
//
// 대상 = dispatch-start-size-core.mjs(순수 코어, I/O 0 -- 변이 주입이
// 가장 깨끗하게 되는 자리). 나머지 두 파일(confirm-cli/rate-limit-stall-
// adapter)은 이 코어를 소비하거나(confirm-cli) 별도의 화면 밖 근거
// (jsonl 구조화 필드)만 쓰므로, 이 코어의 성질이 지켜지는 한 그 위
// 소비자도 화면 단독 의존으로 새지 않는다 -- 우회 후보 목록(§ 하단)이
// 그 경계를 명시한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeDispatchStartBySize,
  DISPATCH_START_SIZE_VERDICT,
} from "./dispatch-start-size-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();

const DISPATCHED_AT_MS = 1_000_000;
const TIMEOUT_MS = 60_000;
const STALL_THRESHOLD_MS = 60_000;

// ---------------------------------------------------------------------------
// (a) 정적 검사 -- 화면 관련 식별자가 코드에 아예 없다(주석 제외).
//     ⚠️이것만으로는 §6 "옆 구멍" 경고에 걸린다(문자열만 우회하면 통과) --
//     그래서 (c)의 변이 시험이 진짜 게이트다. 이 검사는 회귀를 조기에
//     싸게 잡는 1차 신호일 뿐이다.
// ---------------------------------------------------------------------------
const SRC_TEXT = fs.readFileSync(
  join(ROOT, "scripts", "supervisor", "dispatch-start-size-core.mjs"),
  "utf8",
);
test("static(1차 신호): dispatch-start-size-core.mjs 코드부에 preview/title/screen 식별자가 없다", () => {
  const codeOnly = SRC_TEXT.replace(/\/\/.*$/gm, "");
  assert.equal(/\bpreview\b/.test(codeOnly), false);
  assert.equal(/\btitle\b/.test(codeOnly), false);
  assert.equal(/\bscreenText\b/.test(codeOnly), false);
});
test("static(1차 신호): dispatch-start-size-core.mjs는 orca를 spawn하지 않는다(I/O 0)", () => {
  const codeOnly = SRC_TEXT.replace(/\/\/.*$/gm, "");
  assert.equal(
    /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(\s*["'`]orca["'`]/.test(
      codeOnly,
    ),
    false,
  );
  assert.equal(
    /^import[\s\S]*?from\s+["'].+["'];?\s*$/gm.test(codeOnly),
    false,
  );
});

// ---------------------------------------------------------------------------
// (b) 성질 시험(실제 코어) -- 관측에 화면 유래 필드(screenText)가 섞여
//     들어와도(호출자가 실수로 얹어도) 판정은 바뀌지 않는다. 이건 GREEN
//     이어야 정상(실제 코어가 그 필드를 아예 안 본다).
// ---------------------------------------------------------------------------
test("성질: 관측에 screenText가 섞여도(값이 달라도) 동일 시간축 판정은 바뀌지 않는다(2/2 쌍)", () => {
  const base = {
    dispatchedAtMs: DISPATCHED_AT_MS,
    now: DISPATCHED_AT_MS + 30_000,
    timeoutMs: TIMEOUT_MS,
    stallThresholdMs: STALL_THRESHOLD_MS,
  };
  const screenStrings = [
    "FRESH -- 좌석 정상",
    "STALE -- 좌석 죽은 것처럼 보임(76초 전 화면)",
  ];
  const results = screenStrings.map((screenText) =>
    judgeDispatchStartBySize({
      ...base,
      observations: [
        { observedAtMs: DISPATCHED_AT_MS, totalBytes: 0, screenText },
        { observedAtMs: DISPATCHED_AT_MS + 5000, totalBytes: 5000, screenText },
      ],
    }),
  );
  assert.equal(results[0].verdict, results[1].verdict);
  assert.equal(results[0].verdict, DISPATCH_START_SIZE_VERDICT.STARTED);
});

// ---------------------------------------------------------------------------
// (c) ★완료 조건 4의 급소 -- 변이(mutation) 시험. 코어 소스에 "화면 유래
//     필드(screenText)가 판정에 실제로 관여하는" 한 줄을 주입한 사본을
//     동적 import로 실행해, 위 (b)와 동일한 입력 쌍이 이제는 **다른
//     판정**을 내는지 본다. 다르면 RED(=이 시험이 잡아낸다) -- 즉 "화면
//     단독 판정으로 되돌리면 이 시험이 반드시 실패한다"를 실증한다.
// ---------------------------------------------------------------------------
function applyMutation(src, find, replacement) {
  const count = src.split(find).length - 1;
  assert.equal(
    count,
    1,
    `mutation target string must match exactly once, got ${count} -- 대상 문자열이 낡았거나(실제 구현과 불일치) 모호하다(여러 곳에 매치)`,
  );
  return src.replace(find, replacement);
}

async function importMutatedCopy(mutate) {
  const dir = fs.mkdtempSync(
    join(tmpdir(), "hyk274-dispatch-start-size-core-mutant-"),
  );
  const mutated = mutate(SRC_TEXT);
  const filePath = join(dir, "dispatch-start-size-core.mutant.mjs");
  fs.writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("★변이(필수, 완료 조건 4): 화면 유래 필드(screenText)를 판정에 실제로 섞으면 -- RED(같은 시간관측이 문구만으로 다르게 판정된다)", async () => {
  const mutant = await importMutatedCopy((src) =>
    applyMutation(
      src,
      "export function judgeDispatchStartBySize(args) {\n  if (!isPlainObject(args)) {",
      'export function judgeDispatchStartBySize(args) {\n  if (isPlainObject(args) && Array.isArray(args.observations) && args.observations[0] && args.observations[0].screenText === "STALE -- 좌석 죽은 것처럼 보임(76초 전 화면)") {\n    return { ok: true, verdict: "NOT_STARTED", reasonCode: "MUTANT_SCREEN_FORCED", details: null };\n  }\n  if (!isPlainObject(args)) {',
    ),
  );
  const base = {
    dispatchedAtMs: DISPATCHED_AT_MS,
    now: DISPATCHED_AT_MS + 30_000,
    timeoutMs: TIMEOUT_MS,
    stallThresholdMs: STALL_THRESHOLD_MS,
  };
  const screenStrings = [
    "FRESH -- 좌석 정상",
    "STALE -- 좌석 죽은 것처럼 보임(76초 전 화면)",
  ];
  const results = screenStrings.map((screenText) =>
    mutant.judgeDispatchStartBySize({
      ...base,
      observations: [
        { observedAtMs: DISPATCHED_AT_MS, totalBytes: 0, screenText },
        { observedAtMs: DISPATCHED_AT_MS + 5000, totalBytes: 5000, screenText },
      ],
    }),
  );
  assert.notEqual(
    results[0].verdict,
    results[1].verdict,
    "mutant must let screenText alone flip the verdict for identical time/byte observations (RED signal; proves the real core's screen-independence is load-bearing, not incidental)",
  );
});

// ---------------------------------------------------------------------------
// 우회 후보 수색 목록(§6 요구 -- 스스로 수색) -- 아래는 이 변이 시험이
// «못 잡는» 형태다. coder.md 본문에 그대로 옮겨 사람이 검토하게 한다.
// (1) 이 코어를 부르는 «소비자»(dispatch-start-confirm-cli.mjs)가 코어
//     호출부를 우회해 자체적으로 orca terminal read를 새로 spawn하는
//     경우 -- 이 시험은 코어 파일만 보므로 못 잡는다. 방어: confirm-cli
//     자신의 static "orca spawn 0" 검사(coder-task.md 원본 확인 필요,
//     현재 그 파일엔 이 형태의 정적 검사가 없다 -- ★신규 미비, 상신 대상).
// (2) 관측 배열 자체가 아니라 `dispatchedAtMs`/`timeoutMs`/
//     `stallThresholdMs`에 화면 유래 값을 몰래 실어 보내는 경우 -- 이
//     시험은 필드 이름(screenText)으로 주입했으므로 다른 필드명으로
//     숨기면 이 특정 변이는 못 잡는다(다른 필드명마다 별도 변이가
//     필요 -- 무한 회귀). 완화: (a)의 정적 검사가 "screenText" 외
//     "preview"/"title"도 함께 금지해 흔한 이름은 잡는다.
// (3) 코어 밖(호출부)에서 verdict를 받은 뒤 화면 값으로 덮어쓰는 경우
//     (예: `if (screenSaysStale) result.verdict = "STALLED_AFTER_START"`)
//     -- 이 코어 자체는 순수하므로 이 시험 범위 밖. 소비자 파일마다
//     동일 패턴의 변이 시험이 각각 필요하다(이번 조각은 코어 1개에만
//     적용 -- 완료 조건 4의 "급소"가 코어라는 판단, 나머지는 남은 것에
//     기록).
