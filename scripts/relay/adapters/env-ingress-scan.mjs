// HYK-170 사이클2 coder-1 (A-3): 실행 가능한 env handle ingress 정적 검사.
// 기존 B2 시험(문자열 포함 여부 단언)은 헛시험이었다 -- 주석·문서에 마커
// 문자열이 등장하면 그대로 오탐하고, `process["env"]`/구조분해/계산 키/
// helper 경유/재수출 같은 실행 가능한 우회는 전혀 잡지 못했다. 이 모듈은
// 주석·문자열 리터럴 내부는 걷어내고(comment/string 안전 스트리퍼) 남은
// 실행 가능한 코드만 스캔한다 -- 그래서 G8 사유 주석에 "ORCA_TERMINAL_HANDLE"
// 을 그대로 적어도 PASS다(주석은 이미 걷어냈으므로).
//
// 정직 경계(잡지 못하는 것, 스캔 범위): 아래 KNOWN_LIMITATIONS 참조.
// 이 모듈은 문자열 리터럴 자체는 보존한다(계산 키 탐지가 리터럴 연결을
// 봐야 하므로) -- 주석만 제거한다.

// 줄 주석: 개행 직전까지 건너뛴다(개행 자체는 바깥 루프가 그대로 복사해
// 줄 번호를 보존한다).
function skipLineComment(src, i, n) {
  while (i < n && src[i] !== "\n") i++;
  return i;
}

// 블록 주석: 내용은 버리되 개행만 보존해 이후 매치의 줄 번호가 어긋나지
// 않게 한다.
function skipBlockComment(src, i, n, out) {
  i += 2;
  while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
    if (src[i] === "\n") out += "\n";
    i++;
  }
  return { i: i + 2, out };
}

// 문자열/템플릿 리터럴은 내용을 그대로 보존한다(계산 키 탐지가 리터럴
// 연결을 봐야 하므로) -- 이스케이프된 인용부호만 건너뛴다.
function copyStringLiteral(src, i, n, out) {
  const quote = src[i];
  out += quote;
  i++;
  while (i < n && src[i] !== quote) {
    if (src[i] === "\\" && i + 1 < n) {
      out += src[i] + src[i + 1];
      i += 2;
      continue;
    }
    out += src[i];
    i++;
  }
  if (i < n) {
    out += src[i];
    i++;
  }
  return { i, out };
}

export function stripJsComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (c === "/" && c2 === "/") {
      i = skipLineComment(src, i, n);
      continue;
    }
    if (c === "/" && c2 === "*") {
      ({ i, out } = skipBlockComment(src, i, n, out));
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      ({ i, out } = copyStringLiteral(src, i, n, out));
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// 실행 가능한 env handle ingress known-bad -- 태스크 지시(§4) 6종 전부.
const KNOWN_BAD_PATTERNS = Object.freeze([
  { id: "ENV_DOT_ACCESS", re: /\bprocess\s*\.\s*env\b/g },
  { id: "ENV_BRACKET_ACCESS", re: /\bprocess\s*\[\s*(['"`])env\1\s*\]/g },
  // 구조분해: const { env } = process; (별칭 { env: e } 포함)
  {
    id: "ENV_DESTRUCTURE",
    re: /\{[^{}=;]*\benv\b\s*(:[^{}=;]*)?[^{}=;]*\}\s*=\s*process\b(?!\s*\.\s*env)/g,
  },
  // 구조분해 별칭: const { ORCA_TERMINAL_HANDLE } = process.env;
  {
    id: "ENV_DESTRUCTURE_FROM_ENV",
    re: /\{[^{}=;]*\}\s*=\s*process\s*\.\s*env\b/g,
  },
  // 계산 키: 문자열 리터럴 두 개를 +로 이어붙이는 코드(예: "ORCA_" + "TERMINAL_HANDLE").
  {
    id: "COMPUTED_KEY_CONCAT",
    re: /(['"`])[^'"`]*\1\s*\+\s*(['"`])[^'"`]*\2/g,
  },
  // helper 함수 경유: import 바인딩 이름 자체에 env가 들어간 걸 그대로 쓰는 경우.
  {
    id: "HELPER_ENV_IMPORT",
    re: /import\s*\{[^}]*env[^}]*\}\s*from/gi,
  },
  // 재수출/간접 import: 모듈 지정자 자체에 env가 들어간 재수출.
  {
    id: "REEXPORT_ENV",
    re: /export\s*(\*|\{[^}]*\})\s*from\s*(['"`])[^'"`]*env[^'"`]*\2/gi,
  },
]);

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// src: 파일 원문 전체(주석 포함). 반환: 위반 목록(빈 배열 = clean).
export function scanEnvHandleIngress(src) {
  const stripped = stripJsComments(typeof src === "string" ? src : "");
  const violations = [];
  for (const { id, re } of KNOWN_BAD_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      violations.push({
        pattern: id,
        line: lineOf(stripped, m.index),
        match: m[0],
      });
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  return violations;
}

// A-3 §4 정직 요구: 이 스캐너가 잡지 못하는 구문·스캔 범위를 실행 코드가
// 아니라 이 배열로 정직하게 출력한다(테스트가 이 배열의 존재를 단언한다 --
// "잡지 못하는 것이 없다"는 조용한 주장을 막는다).
export const KNOWN_LIMITATIONS = Object.freeze([
  "computed-key detection only catches concatenation of two *string literals* with '+' -- variable-based concatenation (e.g. `prefix + '_HANDLE'`) is not detected",
  "helper-function indirection is only caught when the imported binding name itself contains 'env' (case-insensitive) -- a helper named e.g. `readTerminalHandle()` that internally does `process.env.X` in a *different* file is not detected unless that file is scanned separately",
  "re-export detection only catches module specifiers containing the literal substring 'env' -- a re-export from a differently-named module is not detected",
  "this module only scans the text handed to it -- callers are responsible for choosing which files to scan (see the file list asserted in orca-adapter.test.mjs)",
]);
