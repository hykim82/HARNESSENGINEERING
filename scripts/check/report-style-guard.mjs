import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { normalizeAbsolute, normalizeToRepoRelative } from "./path-normalize.mjs";

// HYK-143: 사람 대상 "보고 톤 지침"(관제실 orchestrator-report-style.md)이 워커 태스크
// 파일·템플릿·메모리 같은 작업 문서로 새어 들어가는 것을 기계로 차단하는 PreToolUse 가드.
// role-guard.mjs 전례(stdin JSON으로 tool_input을 받아 Write/Edit를 검사, block=exit 2)를 따른다.
//
// Tier: Claude 훅 경로만 차단 -- codex 워커·수동 편집은 미커버. 시그니처 기반이라 변형
// 표현은 미탐지. 훅 배선(.claude/settings.local.json) 전까지 무력(배선은 병합 후 ORCH가
// 사람 승인 하에 self-config). 자세한 한계는 docs/enforcement-v1.md 참조.

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TASK_FILENAME_RE = /-task\.md$/i;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

// 감시 대상 경로인지 판정하고, 맞으면 어떤 부류인지 라벨을 돌려준다(비대상=null).
// - control-room `PM/relay/*-task.md` 드롭(레포 밖) · 메모리 디렉터리(`/memory/`, 레포 밖)는
//   정규화된 절대경로 문자열로 검사한다.
// - repo `.harness/<role>-task.md` · `templates/**`는 repo-relative로 검사한다.
export function classifyWatchedPath(filePath, root) {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  const abs = normalizeAbsolute(filePath, root);
  const absLower = abs.toLowerCase();
  const basename = abs.split("/").pop() ?? "";

  if (/\/pm\/relay\//i.test(abs) && TASK_FILENAME_RE.test(basename)) return "pm-relay-task";
  if (absLower.includes("/memory/")) return "memory";

  const { relative, insideRepo } = normalizeToRepoRelative(filePath, root);
  if (insideRepo && typeof relative === "string") {
    if (/^\.harness\/[^/]+-task\.md$/i.test(relative)) return "harness-task";
    if (/^templates\//i.test(relative)) return "templates";
  }
  return null;
}

// 시그니처 A -- 보고 톤 지침 자체의 복사. **마크다운 헤딩 형태**로 지침의 정의 헤딩
// `기술 답변 톤` 또는 슬러그 `orchestrator-report-style`이 등장할 때만 매치한다.
//
// 왜 "헤딩 형태"만인가(계약 §2A 문구 정직화): 계약은 "`기술 답변 톤` 헤딩 또는
// `orchestrator-report-style` 문자열"이라 했으나, **바로 이 HYK-143 태스크 파일이 계약
// §2A 설명에서 backtick으로 슬러그를 인용**한다(그리고 known-good §5는 이 태스크 파일이
// 통과해야 한다고 명시). 즉 "슬러그 문자열 아무 곳" 매치는 known-good을 스스로 깨뜨린다.
// 인용(prose/backtick)은 지침을 "가리키는" 참조일 뿐 톤 유입이 아니고, 실제 지침 복사는
// 그 헤딩을 함께 가져오므로, 헤딩 형태를 유입의 결정 신호로 삼는다. 이 정직화는
// docs/enforcement-v1.md 한계 절에 명기한다.
const STYLE_HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+.*(?:기술[ \t]*답변[ \t]*톤|orchestrator-report-style)/i;
export function matchSignatureA(content) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (STYLE_HEADING_RE.test(lines[i])) {
      return { matched: true, signature: "A", line: i + 1, detail: `report-style-guide heading copied at line ${i + 1}: ${lines[i].trim()}` };
    }
  }
  return { matched: false };
}

// 시그니처 B -- 5단 보고 골격 "세트". `결론`·`진단`·`정직 한계`가 **모두** 헤딩/번호 항목
// 형태로 동시에 등장할 때만 매치. 개별 단어의 일반 산문 사용("이번 한계는...")은 통과.
// 구조적 형태 = 헤딩(`## 결론`) · 번호(`1. 결론`, `1) 결론`) · 굵게(`**결론**`, `**1. 결론**`)
// 이들의 조합(헤딩+번호 등)도 허용.
const REPORT_SKELETON_TOKENS = ["결론", "진단", "정직 한계"];
function structuralItemRe(token) {
  const t = token.replace(/\s+/g, "[ \\t]*"); // "정직 한계" -> "정직[ \t]*한계"
  // line start -> optional heading (#..) and/or bold (**) and/or number (N. / N)) lead -> token.
  // NOTE: `\b` is wrong here -- Korean syllables are not \w, so a `token\b` never matches.
  // Use a negative-lookahead hangul boundary so "결론" matches but "결론적으로" (prose) does not.
  return new RegExp(`^[ \\t]{0,3}(?:#{1,6}[ \\t]+)?(?:\\*\\*[ \\t]*)?(?:\\d+[.)][ \\t]+)?${t}(?![가-힣])`, "m");
}
export function matchSignatureB(content) {
  const found = {};
  for (const token of REPORT_SKELETON_TOKENS) {
    const re = structuralItemRe(token);
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      // require the token to be structurally led (heading/number/bold), not bare prose.
      if (re.test(lines[i]) && /^[ \t]{0,3}(#{1,6}[ \t]|\*\*|\d+[.)][ \t])/.test(lines[i])) {
        found[token] = i + 1;
        break;
      }
    }
  }
  const present = REPORT_SKELETON_TOKENS.filter((t) => found[t] !== undefined);
  if (present.length === REPORT_SKELETON_TOKENS.length) {
    return { matched: true, signature: "B", detail: `5-part report skeleton set present as structural items: ${present.map((t) => `${t}@L${found[t]}`).join(", ")}` };
  }
  return { matched: false };
}

// 순수 판정. status: SKIP(비대상/비Write) · UNJUDGABLE(입력 불확실, fail-open) ·
// BLOCK(확정 매치) · PASS(대상이나 매치 없음).
export function checkReportStyle({ toolName, filePath, toolInput, repoRoot: root } = {}) {
  if (!WRITE_TOOLS.has(toolName)) {
    return { status: "SKIP", ok: true, reason: `report-style-guard: tool '${toolName ?? ""}' is not a write; not checked` };
  }
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { status: "UNJUDGABLE", ok: true, reason: "report-style-guard: UNJUDGABLE -- no file path (fail-open)" };
  }
  const watched = classifyWatchedPath(filePath, root);
  if (!watched) {
    return { status: "SKIP", ok: true, reason: `report-style-guard: '${filePath}' is not a watched work-document path; not checked` };
  }
  const content = toolInput?.content ?? toolInput?.new_string;
  if (typeof content !== "string") {
    return { status: "UNJUDGABLE", ok: true, reason: `report-style-guard: UNJUDGABLE -- watched path (${watched}) but no string content on tool_input (fail-open)` };
  }

  const a = matchSignatureA(content);
  if (a.matched) {
    return { status: "BLOCK", ok: false, signature: "A", reason: `report-style-guard: BLOCK -- report-tone style guide leaking into ${watched} path '${filePath}' (signature A: ${a.detail})` };
  }
  const b = matchSignatureB(content);
  if (b.matched) {
    return { status: "BLOCK", ok: false, signature: "B", reason: `report-style-guard: BLOCK -- report skeleton leaking into ${watched} path '${filePath}' (signature B: ${b.detail})` };
  }
  return { status: "PASS", ok: true, reason: `report-style-guard: PASS -- ${watched} path '${filePath}' carries no report-style signature` };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/report-style-guard.mjs");
if (invokedDirectly) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    // No/malformed PreToolUse payload: nothing to check -> fail-open (house convention).
    process.exit(0);
  }
  const toolInput = hookInput.tool_input || {};
  const filePath = toolInput.file_path || toolInput.notebook_path;
  const result = checkReportStyle({ toolName: hookInput.tool_name, filePath, toolInput, repoRoot: repoRoot() });
  if (result.status === "BLOCK") {
    console.error(result.reason);
    process.exit(2);
  }
  if (result.status === "UNJUDGABLE") {
    // advisory only; fail-open (HYK-129 G3 convention).
    console.error(result.reason);
  }
  process.exit(0);
}
