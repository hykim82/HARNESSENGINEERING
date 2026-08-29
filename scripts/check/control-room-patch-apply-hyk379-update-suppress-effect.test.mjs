// HYK-379-prompt-answer-1 (coder-task.md §2/§3, 불변식 P-ⓐ) -- does the
// applied orca-worker-seat.ps1 fixture ACTUALLY suppress the codex/claude
// startup update-check that produced the "Update now / Skip" trap (원 사고:
// 숫자 선택 전송이 막히고 Enter만 먹혀 기본값 Update now가 조용히 실행됐다)?
//
// Two layers (HYK-378 선례와 동일 분리):
//   1. 문자열/구조 검사 -- "적용본이 그 문장을 약속하는가"만 본다.
//   2. ★근본: 이 기계에 실제로 설치된 codex.exe/claude.exe(로컬 npm 전역
//      설치, orca 미개입)를 실제로 구동해 -- 적용본에서 그대로 추출한 플래그
//      문자열을 REAL 프로세스에 넘겨 -- "이 값이 실제로 그 설정을 뒤집는가"를
//      실측한다. `codex doctor`/`claude doctor`는 읽기 전용 진단 명령이라
//      좌석·orca 어느 쪽도 건드리지 않는다(§0-1 비저촉 -- 살아 있는 좌석을
//      조작하지 않는다, 로컬 바이너리를 직접 구동할 뿐이다).
//
// ⚠️정직 한계:
//  ⓐ 이 시험은 "codex/claude가 실제 업데이트가 있다고 판단하는 상황을 만들어
//     좌석을 띄우고 대화형 프롬프트 유무를 관찰"하지는 않는다 -- 그것은
//     §0-1이 금지하는 살아 있는 좌석 조작에 해당한다(코더.md §4 정직 한계
//     참조). 이 시험이 실측하는 것은 "그 설정 키가 실제로 존재하고 실제로
//     반전된다"까지다 -- "그래서 프롬프트가 안 뜬다"는 구조적 함의이지 이
//     시험이 직접 관찰한 사실이 아니다.
//  ⓑ codex.exe/claude.exe가 이 기계(CI 포함)에 없으면 레이어 2 전체를
//     SKIP_REASON과 함께 **시끄럽게** 건너뛴다(조용한 스킵 금지, HYK-365
//     형태 방지) -- 그 환경에서는 레이어 1(문자열 검사)만 남는다.
//  ⓒ claude 쪽은 원 사고(대화형 메뉴 트랩)를 재현하지 않는다 -- 방어적
//     조치일 뿐이라는 점은 패치 문서 §4/§1에 이미 명시했다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APPLIED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-orca-worker-seat-2026-08-29-hyk379-update-suppress-applied.ps1.txt",
    import.meta.url,
  ),
);

function loadApplied() {
  return readFileSync(APPLIED_PATH, "utf8");
}

// ---- doc-promise-presence checks (mutation-testable, string-level) --------

const CODEX_FLAG_SNIPPET =
  "codex --model $codexModel -a never -s danger-full-access -c check_for_update_on_startup=false";
const CLAUDE_ENV_SNIPPET = "$env:DISABLE_AUTOUPDATER = '1'";

function hasCodexFlagPromise(text) {
  return text.includes(CODEX_FLAG_SNIPPET);
}
function hasClaudeEnvPromise(text) {
  return text.includes(CLAUDE_ENV_SNIPPET);
}

test("claim: applied fixture's codex launch line carries -c check_for_update_on_startup=false", () => {
  assert.equal(hasCodexFlagPromise(loadApplied()), true);
});
test("claim: applied fixture sets $env:DISABLE_AUTOUPDATER = '1' before the claude launch line", () => {
  assert.equal(hasClaudeEnvPromise(loadApplied()), true);
});

test("★anti-vacuity (양방향): deleting the codex flag promise flips RED, the untouched original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(
    " -c check_for_update_on_startup=false",
    "",
  );
  assert.equal(hasCodexFlagPromise(mutatedRed), false);
  assert.equal(hasCodexFlagPromise(original), true);
});
test("★anti-vacuity (양방향): deleting the claude env promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(CLAUDE_ENV_SNIPPET, "");
  assert.equal(hasClaudeEnvPromise(mutatedRed), false);
  assert.equal(hasClaudeEnvPromise(original), true);
});

// ---------------------------------------------------------------------------
// ★근본: extract the REAL `-c check_for_update_on_startup=false` substring
// from the applied fixture's codex line (never re-typed by hand) and hand it
// to a REAL local `codex doctor --all` process -- does it actually flip the
// "startup update check" diagnostic field from true to false?
// ---------------------------------------------------------------------------

function extractCodexConfigOverride(appliedText) {
  const match = appliedText.match(/codex --model .* (-c [^\s]+)\s*$/m);
  if (!match) {
    throw new Error(
      "extractCodexConfigOverride: codex launch line with a -c override not found in applied fixture -- fixture drifted from what this test was written against",
    );
  }
  return match[1];
}

// ⚠️Windows note: `where <name>` lists every PATH match, and for npm-global
// shims that includes an extensionless POSIX shell-script shim ahead of the
// `.cmd` shim -- spawning THAT directly (shell:false) fails silently into
// an undefined stdout (caught during this round's own verification, see
// .harness/coder.md). So on win32 this resolves the `.cmd` shim explicitly
// (a real, directly-spawnable executable, no shell involved -- avoids the
// shell:true unescaped-argv warning/risk entirely); elsewhere it resolves
// via `which`.
function findExe(name) {
  const isWin = process.platform === "win32";
  const probe = spawnSync(isWin ? "where" : "which", [name], {
    encoding: "utf8",
  });
  if (probe.status !== 0) return null;
  const lines = probe.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!isWin) return lines[0] ?? null;
  return (
    lines.find((l) => l.toLowerCase().endsWith(".cmd")) ?? lines[0] ?? null
  );
}

// `.cmd` shims cannot be spawned directly on Windows without a shell (Node
// itself documents this: .bat/.cmd require shell:true or an explicit
// cmd.exe /c wrapper). Passing a pre-joined command STRING with an EMPTY
// args array avoids Node's DEP0190 warning (which fires only when a
// non-empty args array is combined with shell:true) -- every value quoted
// here is an internally-controlled literal (fixed subcommand names / the
// literal override string extracted from the applied fixture), never
// external input, so building the string ourselves carries no injection
// risk in this test.
function quoteForShell(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function runViaShell(exePath, args, opts = {}) {
  const command = [exePath, ...args].map(quoteForShell).join(" ");
  return spawnSync(command, [], { encoding: "utf8", shell: true, ...opts });
}

const CODEX_EXE = findExe("codex");
const CLAUDE_EXE = findExe("claude");
const CODEX_SKIP_REASON =
  "SKIP_REASON: no `codex` executable found on PATH (expected on CI without codex installed) -- coder-task.md §3 forbids a SILENT skip here, so this reason string is the loud marker; layer-1 string checks above still ran and still gate this file";
const CLAUDE_SKIP_REASON =
  "SKIP_REASON: no `claude` executable found on PATH (expected on CI without claude installed) -- loud marker, same rationale as CODEX_SKIP_REASON";

test("self-check: the -c override extracted from the applied fixture's codex line is exactly -c check_for_update_on_startup=false", () => {
  assert.equal(
    extractCodexConfigOverride(loadApplied()),
    "-c check_for_update_on_startup=false",
  );
});

test("★근본 행동: `codex doctor --all` WITHOUT the extracted override reports startup update check as true (baseline, before asserting the flip below)", (t) => {
  if (!CODEX_EXE) {
    t.skip(CODEX_SKIP_REASON);
    return;
  }
  const result = runViaShell(CODEX_EXE, ["doctor", "--all"]);
  assert.match(result.stdout, /startup update check\s+true/);
});

test("★근본 행동: `codex doctor --all` WITH the exact override extracted from the applied fixture flips startup update check to false", (t) => {
  if (!CODEX_EXE) {
    t.skip(CODEX_SKIP_REASON);
    return;
  }
  const override = extractCodexConfigOverride(loadApplied());
  const args = ["doctor", "--all", ...override.split(" ")];
  const result = runViaShell(CODEX_EXE, args);
  assert.match(
    result.stdout,
    /startup update check\s+false/,
    `expected the diagnostic to report false with ${override} applied; got:\n${result.stdout}`,
  );
});

test("★되돌림 변이 (행동 축): a mangled override key (typo) does NOT flip startup update check to false -- proves the GREEN result above is not vacuous (any -c flag would not do)", (t) => {
  if (!CODEX_EXE) {
    t.skip(CODEX_SKIP_REASON);
    return;
  }
  const result = runViaShell(CODEX_EXE, [
    "doctor",
    "--all",
    "-c",
    "check_for_update_on_startuppp=false",
  ]);
  assert.match(result.stdout, /startup update check\s+true/);
});

test("★근본 행동: `claude doctor` with DISABLE_AUTOUPDATER=1 (the exact value the applied fixture sets) reports auto-updates disabled by that env var", (t) => {
  if (!CLAUDE_EXE) {
    t.skip(CLAUDE_SKIP_REASON);
    return;
  }
  const result = runViaShell(CLAUDE_EXE, ["doctor"], {
    env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
  });
  assert.match(
    result.stdout,
    /Auto-updates:\s*disabled\s*\(set by env: DISABLE_AUTOUPDATER\)/,
    `expected doctor to attribute the disable to the env var; got:\n${result.stdout}`,
  );
});
