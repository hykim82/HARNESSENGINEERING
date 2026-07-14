import { spawnSync } from "node:child_process";

// HYK-135 사이클5(coder-2, 그룹5 5B): Claude 엔진 어댑터 -- go-wait-supervisor.mjs(5A
// approved)가 정의한 adapterFn 계약을 그대로 구현한다:
//   ({task_id, attempt_id, lane, cwd, config, at}) => {exitCode, signal, question?}
// 제어 로직(claim/start/finish/재시도 금지/question 분류)은 전부 5A+그룹1~4 소유 --
// 이 파일은 "Claude를 1회, shell 없이, 명시 인자로 기동하고 종료를 결정론적으로 관찰"
// 하는 것만 한다(리서치 §1 supervisord no-shell/autorestart=false 정론).
//
// 실 Claude 바이너리 실전 기동은 이번 표면 밖이다(패킷 열린질문 Q2: role context·권한
// 재현 여부는 미확정 -- 그룹6 파일럿+사람 게이트 몫). 테스트는 전부 폐기 가능한 fake
// node 스크립트를 spawn 대상으로 주입한다.

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// question_packet 감지(templates/harness-init/question-packet.template.md 정본 형식):
// `question_packet:` 블록 존재 + 그 블록 **안**의 `question_id: "..."` 라인 추출. 어댑터는
// 감지·전달만 -- 분류/정지 판단은 supervisor(5A) 몫, 여기서 자동 응답·재개를 만들지 않는다.
//
// review-2 국소 수리(coder-3): 이전 버전은 "문서 어디든 marker 존재 + 문서 어디든
// question_id 존재"를 블록 소속과 무관하게 감지해, 산문 중 우연히 "question_packet:"이란
// 어구가 들어간 문장(예: 리뷰 코멘트가 템플릿 파일명을 인용하는 경우) + 그 뒤 전혀 무관한
// question_id 라인을 오탐(false positive QUESTION disarm)했다. 정본 템플릿은 `question_packet:`가
// **줄 전체**(들여쓰기 제외 다른 텍스트 없음)이고 그 자식 필드(`question_id` 포함)는 그
// 줄보다 **더 들여쓰기된 연속 블록**으로만 존재한다(YAML 매핑 구조) -- 그 구조를 그대로
// block-boundary 판정 기준으로 삼는다: marker 줄 자체가 산문에 섞여 있으면(줄 앞뒤에 다른
// 텍스트가 있으면) 애초에 marker로 인정하지 않고, marker 인정 후에도 그 직후 더 들여쓰기된
// 연속 줄들(빈 줄이나 같은/얕은 들여쓰기가 나오면 블록 종료) 안에서만 question_id를 찾는다.
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
      if (line.trim().length === 0) break; // blank line ends the block
      const lineIndent = line.match(/^[ \t]*/)[0].length;
      if (lineIndent <= markerIndent) break; // dedent (or sibling) ends the block
      const idMatch = line.match(QUESTION_ID_LINE_RE);
      if (idMatch && typeof idMatch[1] === "string" && idMatch[1].length > 0) {
        return { question_id: idMatch[1] };
      }
    }
  }
  return null;
}

// G7/G8: spawnSync 원시 결과 -> adapterFn 계약 shape. exitCode/signal은 유실 없이
// 채운다(silent 유실 0 -- supervisor의 classifyAttemptResult가 fail-closed로 처리하는
// 전제는 "여기서 관찰된 값이 그대로 온다"이다). question은 stdout+stderr 전체에서 감지.
export function classifyExecResult(raw) {
  const r = isPlainObject(raw) ? raw : {};
  const stdout = typeof r.stdout === "string" ? r.stdout : r.stdout ? String(r.stdout) : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : r.stderr ? String(r.stderr) : "";
  const exitCode = typeof r.status === "number" ? r.status : null;
  const signal = typeof r.signal === "string" && r.signal.length > 0 ? r.signal : null;
  const question = detectQuestionPacket(`${stdout}\n${stderr}`);
  return question ? { exitCode, signal, question } : { exitCode, signal };
}

// ---- 어댑터 팩토리: 명령·기본 인자·env를 구성 시점에 고정(1회 생성, 여러 attempt에
// 재사용 가능 -- 매 호출이 새 프로세스를 정확히 1회 기동하는 것과는 무관, 구성은 불변).
export function createClaudeAdapterFn(config) {
  const c = isPlainObject(config) ? config : {};
  const command = typeof c.command === "string" && c.command.length > 0 ? c.command : "claude";
  const baseArgs = Array.isArray(c.baseArgs) ? c.baseArgs.slice() : ["-p", "--output-format", "text"];
  // 시크릿 비노출(상시 준수): process.env를 그대로 넘기지 않는다 -- 호출자가 명시한
  // 키만 자식에 전달된다(리서치 §1 no-shell/명시 인자 정론과 동형 -- env도 명시만).
  const env = isPlainObject(c.env) ? { ...c.env } : {};
  const spawnSyncFn = typeof c.spawnSyncFn === "function" ? c.spawnSyncFn : spawnSync;

  return function claudeAdapterFn(ctx) {
    const t = isPlainObject(ctx) ? ctx : {};
    // no-shell: 인자는 배열로만 전달(문자열 연결·shell 해석 경로 0). task_id/attempt_id는
    // 프롬프트/식별자로 전달될 값이라 문자열 강제 변환만 하고 그 이상 가공하지 않는다.
    const args = [...baseArgs, String(t.task_id ?? ""), String(t.attempt_id ?? "")];
    const raw = spawnSyncFn(command, args, {
      cwd: typeof t.cwd === "string" && t.cwd.length > 0 ? t.cwd : undefined,
      env,
      shell: false,
      encoding: "utf8",
    });
    if (isPlainObject(raw) && raw.error && raw.signal == null && raw.status == null) {
      // 프로세스가 실제로는 한 번도 못 뜬 경우(ENOENT 등, exit/signal 관찰 자체가 없음)만
      // throw -- startTx/runSpawn의 기존 startup_failure 경로(그룹3/4A 승인)로 흡수시킨다.
      // spawnSync가 error와 함께 signal도 채우는 경우(예: timeout kill -- child는 실제로
      // 기동돼 실행 중이었다)는 그냥 삼키지 않는다: G8(종료·신호 유실 0)에 따라 그 signal을
      // classifyExecResult로 넘겨 정상 receipt(cli_abnormal_exit)에 담는다.
      throw raw.error;
    }
    return classifyExecResult(raw);
  };
}
