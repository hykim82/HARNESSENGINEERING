// orca-shim-core.mjs -- HYK-389 조각 1 (기록 단계 · 앵커 아님).
//
// 순수 함수 코어(zero-import: 이 파일은 어떤 모듈도 import 하지 않는다 --
// fs · child_process · process 전역도 읽지 않는다. 시각 · 환경 값은 전부
// 호출자가 인자로 넘긴다). 하는 일은 셋뿐이다:
//   (1) argv 를 «쓰기 동사 / 조회 / 도움말» 로 분류한다.
//   (2) `--help` 가 «독립 토큰» 인지 판정한다(보존 브랜치 hyk389-send-boundary-1
//       의 SHA 6fa3be2 사례 -- `--text=--help` · `--text "a --help"` 는 도움말이
//       아니다).
//   (3) 원장 한 줄을 조립한다(`--text` 는 «길이만» · 본문 0).
//
// ⚠️정직 한계(항상 명시): 이것은 OBSERVER(기록기)다. 차단하지 않는다 -- 거부
// 모드(비0 차단)는 조각 4 이고 여기엔 없다. 기록 단계는 «습관 경로 · 실수
// 경로» 만 덮는다: 절대 경로로 부른 `orca.exe` · PATH 재설정 · node spawn 은 이
// shim 을 타지 않아 기록되지 않는다. 앵커가 아니다(docs/enforcement-known-gaps.md
// gap#102).

// 쓰기 동사 목록 -- 이 한 곳에만 둔다(판정 0805 ④ · 설계 (마) 1행).
//   terminal      : 좌석에 입력 · 구조 변경을 만드는 동사
//   orchestration : 배정 · 상태 · 메시지를 만드는 동사
export const WRITE_VERBS = Object.freeze({
  terminal: Object.freeze([
    "send",
    "create",
    "close",
    "stop",
    "rename",
    "switch",
    "split",
  ]),
  orchestration: Object.freeze(["dispatch", "task-update", "send"]),
});

// 조회 동사 목록(참고용 · 기록 0). 목록에 없는 동사 · 도메인도 «기록 0» 이다
// -- 그것이 이 단계의 한계이지 «위반 없음» 의 증명이 아니다.
export const READ_VERBS = Object.freeze({
  terminal: Object.freeze(["list", "show", "read"]),
  orchestration: Object.freeze([
    "check",
    "dispatch-show",
    "task-list",
    "task-show",
  ]),
});

// 값을 «다음 토큰으로» 받는 옵션. `--help` 가 이 옵션 바로 뒤에 오면 그것은
// 도움말 요청이 아니라 «값» 이다(`--text --help`).
export const VALUE_OPTIONS = Object.freeze([
  "--text",
  "--body",
  "--subject",
  "--terminal",
  "--to",
  "--from",
  "--id",
  "--type",
  "--task-id",
  "--dispatch-id",
  "--worktree",
  "--title",
  "--command",
  "--name",
  "--status",
]);

export const LEDGER_SCHEMA = "orca-direct-ledger/1";

function stringArgv(argv) {
  return Array.isArray(argv) ? argv.filter((a) => typeof a === "string") : [];
}

// `--help` 가 «독립 토큰» 인가. argv 는 이미 토큰화돼 있으므로 정확히 `--help`
// 와 같은 원소여야 하고(`--text=--help` · `a --help` 는 다른 문자열), 값을
// 받는 옵션 바로 뒤의 원소는 값이므로 제외한다. includes 를 쓰면 안 된다.
export function hasStandaloneHelp(argv) {
  const tokens = stringArgv(argv);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== "--help") continue;
    const previous = i > 0 ? tokens[i - 1] : null;
    if (previous !== null && VALUE_OPTIONS.includes(previous)) continue;
    return true;
  }
  return false;
}

// 옵션 값 읽기: `--name value` 와 `--name=value` 두 모양. 없으면 null.
export function optionValue(argv, name) {
  const tokens = stringArgv(argv);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === name) {
      return i + 1 < tokens.length ? tokens[i + 1] : null;
    }
    if (tokens[i].startsWith(`${name}=`)) {
      return tokens[i].slice(name.length + 1);
    }
  }
  return null;
}

function codePointLength(value) {
  return value === null ? null : Array.from(value).length;
}

// 대상 handle: terminal 계열은 --terminal(없으면 --worktree), orchestration
// 계열은 --to(없으면 --id).
function targetOf(domain, argv) {
  const order =
    domain === "terminal"
      ? ["--terminal", "--worktree"]
      : ["--to", "--id", "--terminal"];
  for (const name of order) {
    const value = optionValue(argv, name);
    if (value !== null) return value;
  }
  return null;
}

// argv 분류. 반환 kind:
//   "help"  -- 독립 토큰 `--help` 가 있다(쓰기 동사여도 기록 0)
//   "write" -- 쓰기 동사(원장 1줄 대상)
//   "read"  -- 그 밖의 전부(조회 동사 · 목록 밖 동사 · 도메인 · 빈 argv)
export function classifyArgv(argv) {
  const tokens = stringArgv(argv);
  const domain = tokens.length > 0 ? tokens[0] : null;
  const verb = tokens.length > 1 ? tokens[1] : null;
  const base = { domain, verb };
  if (hasStandaloneHelp(tokens)) return { kind: "help", ...base };
  const writeList =
    domain !== null && Object.hasOwn(WRITE_VERBS, domain)
      ? WRITE_VERBS[domain]
      : [];
  if (verb !== null && writeList.includes(verb)) {
    return {
      kind: "write",
      ...base,
      target: targetOf(domain, tokens),
      textLen: codePointLength(optionValue(tokens, "--text")),
      bodyLen: codePointLength(optionValue(tokens, "--body")),
    };
  }
  return { kind: "read", ...base };
}

export function isWriteVerb(domain, verb) {
  return (
    typeof domain === "string" &&
    Object.hasOwn(WRITE_VERBS, domain) &&
    WRITE_VERBS[domain].includes(verb)
  );
}

// actor 판정: 환경의 HARNESS_ROLE 이 정확히 "ORCH" 면 orch, 그 밖(비어 있음
// 포함)은 unattributed. «unattributed» 는 «사람» 이라는 뜻이 아니다 -- 누가
// 했는지 이 shim 이 모른다는 뜻이다.
export function judgeActor(role) {
  return role === "ORCH" ? "orch" : "unattributed";
}

// 원장 한 줄(JSON 객체) 조립. 본문은 넣지 않는다 -- `--text` 는 길이만,
// `--body` 도 길이만.
export function buildLedgerEntry({ classified, env, cwd, nowIso }) {
  const e = env && typeof env === "object" ? env : {};
  const text = (name) =>
    typeof e[name] === "string" && e[name] !== "" ? e[name] : null;
  return {
    schema: LEDGER_SCHEMA,
    ts: nowIso,
    pane_key: text("ORCA_PANE_KEY"),
    role: text("HARNESS_ROLE"),
    cwd: typeof cwd === "string" ? cwd : null,
    domain: classified.domain,
    verb: classified.verb,
    target: classified.target ?? null,
    caller_script: text("HARNESS_ORCA_SHIM_CALLER"),
    text_len: classified.textLen ?? null,
    body_len: classified.bodyLen ?? null,
    actor: judgeActor(text("HARNESS_ROLE")),
  };
}

export function formatLedgerLine(entry) {
  return `${JSON.stringify(entry)}\n`;
}
