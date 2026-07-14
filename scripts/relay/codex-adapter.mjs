import { spawnSync } from "node:child_process";

// HYK-135 사이클5(coder-2, 그룹5 5B): codex 엔진 어댑터 -- claude-adapter.mjs와 동일한
// adapterFn 계약·no-shell·1회 기동 원칙(리서치 §1)을 `codex exec`(리서치 §1 인용) 명령
// 형태에 맞춰 구현한다. 제어 로직은 여기 없음(전부 5A+그룹1~4 소유, 호출만).
//
// 실 codex 바이너리 실전 기동은 표면 밖(Q2 미확정, 그룹6+사람 게이트 몫). 테스트는
// fake node 스크립트로만.

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// review-2 국소 수리(coder-3): claude-adapter.mjs와 동일한 block-boundary 판정(사유는
// 그쪽 주석 참조) -- `question_packet:`가 줄 전체인 marker 줄을 찾고, 그 직후 더
// 들여쓰기된 연속 블록 안에서만 `question_id`를 찾는다(문서 어디든의 우연한 어구·무관
// question_id 조합에 의한 오탐 QUESTION disarm을 방지).
const QUESTION_PACKET_MARKER_LINE_RE = /^([ \t]*)question_packet:\s*$/;
const QUESTION_ID_LINE_RE = /^[ \t]*question_id:\s*"?([^"\n]+?)"?\s*$/;

export function detectQuestionPacket(text) {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r\n|\n/);
  for (let i = 0; i < lines.length; i++) {
    const markerMatch = lines[i].match(QUESTION_PACKET_MARKER_LINE_RE);
    if (!markerMatch) continue;
    const markerIndent = markerMatch[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim().length === 0) break;
      const lineIndent = line.match(/^[ \t]*/)[0].length;
      if (lineIndent <= markerIndent) break;
      const idMatch = line.match(QUESTION_ID_LINE_RE);
      if (idMatch && typeof idMatch[1] === "string" && idMatch[1].length > 0) {
        return { question_id: idMatch[1] };
      }
    }
  }
  return null;
}

export function classifyExecResult(raw) {
  const r = isPlainObject(raw) ? raw : {};
  const stdout = typeof r.stdout === "string" ? r.stdout : r.stdout ? String(r.stdout) : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : r.stderr ? String(r.stderr) : "";
  const exitCode = typeof r.status === "number" ? r.status : null;
  const signal = typeof r.signal === "string" && r.signal.length > 0 ? r.signal : null;
  const question = detectQuestionPacket(`${stdout}\n${stderr}`);
  return question ? { exitCode, signal, question } : { exitCode, signal };
}

export function createCodexAdapterFn(config) {
  const c = isPlainObject(config) ? config : {};
  const command = typeof c.command === "string" && c.command.length > 0 ? c.command : "codex";
  const baseArgs = Array.isArray(c.baseArgs) ? c.baseArgs.slice() : ["exec"];
  const env = isPlainObject(c.env) ? { ...c.env } : {};
  const spawnSyncFn = typeof c.spawnSyncFn === "function" ? c.spawnSyncFn : spawnSync;

  return function codexAdapterFn(ctx) {
    const t = isPlainObject(ctx) ? ctx : {};
    const args = [...baseArgs, String(t.task_id ?? ""), String(t.attempt_id ?? "")];
    const raw = spawnSyncFn(command, args, {
      cwd: typeof t.cwd === "string" && t.cwd.length > 0 ? t.cwd : undefined,
      env,
      shell: false,
      encoding: "utf8",
    });
    if (isPlainObject(raw) && raw.error && raw.signal == null && raw.status == null) {
      // 클로드 어댑터와 동일한 구분(startup_failure vs 실제 관찰된 signal) -- 상세 사유는
      // claude-adapter.mjs 참조.
      throw raw.error;
    }
    return classifyExecResult(raw);
  };
}
