import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// HYK-155-coder-2: M0.5 전면 봉인 패킷(REV1)은 사람 결정으로 미서명 보류됐다
// -- 이 모듈은 그 대신 사람이 채택한 "가벼운 보강 2종"의 ②다. 예방 게이트가
// 아니라 VERIFY 주간 루프에서 도는 순수 탐지(advisory)이며, W3 조사 메모
// (관제실 PM\산출물\하네스\2026-07-17-orca-이식감사\W3-조사-메모.md)가 실측
// 확인한 3개 로컬 파일 표면(재연결 상태·automations 저장소·터미널 기록 평문
// 영속)을 그대로 대상으로 삼는다. 한계(S4): 탐지는 사후이며 예방이 아니고,
// Orca의 로컬 파일 레이아웃에 의존(업데이트 시 드리프트 가능)하며, 로컬 파일
// 검사라 CI 미러가 불가하다.

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// 지문 = 길이+해시 쌍. CLI 경계에서 실제 시크릿으로부터 한 번만 계산되고,
// 그 뒤로는 평문이 어떤 exported 함수에도 전달되지 않는다 -- 그래서 유닛
// 테스트는 순전히 합성 지문만으로 FAIL 경로를 재현할 수 있고, 이 모듈은
// 실수로 값을 로그에 남길 방법이 구조적으로 없다.
export function secretFingerprint(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return { length: value.length, sha256: sha256Hex(value) };
}

// 슬라이딩 윈도우 containment 검사: 매치 위치·매치된 평문 어느 쪽도 반환하지
// 않는다 -- true/false만.
export function containsFingerprint(haystack, fingerprint) {
  if (!fingerprint || typeof haystack !== "string") return false;
  const { length, sha256 } = fingerprint;
  if (length <= 0 || haystack.length < length) return false;
  for (let i = 0; i + length <= haystack.length; i++) {
    if (sha256Hex(haystack.slice(i, i + length)) === sha256) return true;
  }
  return false;
}

// ---- ① linear-reconnect ---------------------------------------------------
// 두 하위 판정(토큰 디렉터리 / 워크스페이스 파일)을 별 함수로 쪼갠 것은
// 순전히 ESLint complexity(<=12) 예산 때문 -- checkLinearReconnect 하나에
// 다 몰아넣으면 분기 수가 한도를 넘는다.
function tokensDirVerdict({ tokensDirExists, tokensDir, readdirFn }) {
  if (!tokensDirExists) return { status: null };
  try {
    const tokenFiles = readdirFn(tokensDir);
    if (tokenFiles.length > 0) {
      return {
        status: "WARN",
        reason: `linear-tokens/에 파일 ${tokenFiles.length}개 존재 -- 재연결 감지`,
      };
    }
    return { status: null };
  } catch (err) {
    return {
      status: "UNJUDGABLE",
      reason: `linear-tokens/ 읽기 실패 (${err.message})`,
    };
  }
}

function workspacesFileVerdict({ workspacesPath, readFileFn }) {
  let parsed;
  try {
    parsed = JSON.parse(readFileFn(workspacesPath));
  } catch (err) {
    return {
      status: "UNJUDGABLE",
      reason: `linear-workspaces.json 파싱 실패 (${err.message})`,
    };
  }
  const workspaces = Array.isArray(parsed?.workspaces)
    ? parsed.workspaces
    : null;
  if (workspaces === null) {
    return {
      status: "UNJUDGABLE",
      reason:
        "linear-workspaces.json에 workspaces 배열이 없음 -- 스키마 불일치",
    };
  }
  if (workspaces.length > 0) {
    return {
      status: "WARN",
      reason: `linear-workspaces.json workspaces=${workspaces.length}개 -- 재연결 감지`,
    };
  }
  return {
    status: "OK",
    reason: "linear-workspaces.json workspaces=[] -- 해제 상태 유지",
  };
}

export function checkLinearReconnect({
  workspacesPath,
  tokensDir,
  existsFn = existsSync,
  readFileFn = (p) => readFileSync(p, "utf8"),
  readdirFn = readdirSync,
}) {
  const workspacesExist = existsFn(workspacesPath);
  const tokensDirExists = existsFn(tokensDir);
  if (!workspacesExist && !tokensDirExists) {
    return {
      status: "OK",
      reason:
        "linear-workspaces.json·linear-tokens/ 모두 부재 -- Orca 미설치이거나 해제 상태 유지",
    };
  }

  const tokens = tokensDirVerdict({ tokensDirExists, tokensDir, readdirFn });
  if (tokens.status) return tokens;

  if (!workspacesExist) {
    return {
      status: "OK",
      reason:
        "linear-workspaces.json 부재, linear-tokens/ 비어있음 -- 해제 상태 유지",
    };
  }
  return workspacesFileVerdict({ workspacesPath, readFileFn });
}

// ---- ② automations-present -------------------------------------------------
// 한계(honesty): runOrcaPostureCheck는 3종 체크에 동일한 readFileFn(utf8
// 텍스트 디코딩)을 공유 전달한다 -- orchestration.db는 SQLite 바이너리라
// utf8 디코딩이 일부 바이트열을 U+FFFD로 뭉갤 수 있으나, 검색 대상
// "automations"는 순수 ASCII라 통상 온전히 보존된다(SQLite 스키마 텍스트가
// 정확히 ASCII 테이블명으로 저장되는 한). 완전한 바이너리 안전 스캔이
// 필요해지면 latin1 전용 리더로 교체할 것 -- 이번 사이클은 SQLite 파서
// 의존 추가 금지 제약과 균형을 맞춘 최소 구현이다.
const AUTOMATIONS_MARKER = "automations";

export function checkAutomationsPresent({
  dbPath,
  existsFn = existsSync,
  readFileFn = (p) => readFileSync(p),
}) {
  if (!existsFn(dbPath)) {
    return {
      status: "OK",
      reason: "orchestration.db 부재 -- automations 없음(Orca 미사용 포함)",
    };
  }
  let buf;
  try {
    buf = readFileFn(dbPath);
  } catch (err) {
    return {
      status: "UNJUDGABLE",
      reason: `orchestration.db 읽기 실패 (${err.message})`,
    };
  }
  const text = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf);
  if (text.includes(AUTOMATIONS_MARKER)) {
    return {
      status: "WARN",
      reason:
        "orchestration.db 바이트열에 'automations' 문자열 발견 -- 존재 가능성(스키마 미검증, `orca automations list --json`로 확정 필요)",
    };
  }
  return {
    status: "UNJUDGABLE",
    reason:
      "orchestration.db 존재하나 바이트 스캔으로 'automations' 흔적을 못 찾음 -- 부재 단정 불가(거짓 OK 금지), 런타임 확인 필요",
  };
}

// ---- ③ terminal-history-secret-scan ----------------------------------------
export function checkTerminalHistorySecretScan({
  dir,
  fingerprints,
  existsFn = existsSync,
  readdirFn = readdirSync,
  readFileFn = (p) => readFileSync(p, "utf8"),
}) {
  if (!existsFn(dir)) {
    return { status: "OK", reason: "terminal-history/ 부재 -- 스캔 대상 없음" };
  }
  const list = Array.isArray(fingerprints) ? fingerprints.filter(Boolean) : [];
  if (list.length === 0) {
    return {
      status: "UNJUDGABLE",
      reason:
        "비교할 시크릿 지문이 없음 -- 지문 파일 미생성(init 필요: `node scripts/check/orca-posture-check.mjs fingerprint-init`), 스캔 스킵, 판정 불가",
    };
  }
  let files;
  try {
    files = readdirFn(dir);
  } catch (err) {
    return {
      status: "UNJUDGABLE",
      reason: `terminal-history/ 읽기 실패 (${err.message})`,
    };
  }
  for (const name of files) {
    let content;
    try {
      content = readFileFn(join(dir, name));
    } catch {
      continue;
    }
    for (const fp of list) {
      if (containsFingerprint(content, fp)) {
        return {
          status: "FAIL",
          reason: `terminal-history/${name}에 알려진 시크릿 지문 포함(값 미노출) -- 비밀 유출 실증`,
        };
      }
    }
  }
  return {
    status: "OK",
    reason: `terminal-history/ 파일 ${files.length}개 스캔, 지문 불일치(값 미노출)`,
  };
}

// ---- 지문 파일 (review-1 R1 수리) --------------------------------------------
// 기본 체크 경로는 실제 시크릿을 절대 열지 않는다 -- 대신 사람이 별도
// `fingerprint-init` 서브커맨드로 미리 생성해 둔 지문 전용 파일만 읽는다.
// 그 파일에는 {id,length,sha256}만 있고 원문은 없다. `.harness/`는 이미
// repo `.gitignore`(`.harness/`)로 커밋 경로에서 배제된다.
//
// review-2 R3 수리: 개별 항목 하나라도 스키마를 어기면(음수/0/비정수
// length, 64자리 hex가 아닌 sha256) 그 항목만 조용히 걸러내지 않고 파일
// 전체를 malformed 처리한다 -- 부분 수용은 손상된 지문 파일을 "정상"으로
// 오인시켜 terminal-history-secret-scan이 거짓 OK를 낼 수 있다(REVIEW
// negative control 실측: {length:-1, sha256:'not-a-sha256'} 혼재 시 이전
// 구현은 그 항목만 버리고 나머지로 스캔을 "정상 동작"시켜 OK를 반환했다).
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

function isValidFingerprintEntry(f) {
  return (
    f &&
    typeof f.length === "number" &&
    Number.isSafeInteger(f.length) &&
    f.length > 0 &&
    typeof f.sha256 === "string" &&
    SHA256_HEX_RE.test(f.sha256)
  );
}

export function loadFingerprints(
  fingerprintsPath,
  { existsFn = existsSync, readFileFn = (p) => readFileSync(p, "utf8") } = {},
) {
  if (!existsFn(fingerprintsPath)) {
    return { fingerprints: [], present: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileFn(fingerprintsPath));
  } catch {
    return { fingerprints: [], present: true, malformed: true };
  }
  const list = Array.isArray(parsed?.fingerprints) ? parsed.fingerprints : null;
  if (!list) {
    return { fingerprints: [], present: true, malformed: true };
  }
  if (list.some((f) => !isValidFingerprintEntry(f))) {
    return { fingerprints: [], present: true, malformed: true };
  }
  return { fingerprints: list, present: true };
}

// 실제 시크릿 원문을 읽는 이 모듈의 유일한 함수 -- 기본 체크 경로(위 3개
// checkXxx + runOrcaPostureCheck)에서는 절대 호출되지 않고, CLI의
// `fingerprint-init` 서브커맨드에서만 호출된다. 반환값·로그 어디에도 원문·
// 해시를 담지 않는다(호출부가 개수/경로만 출력).
export function runFingerprintInit({
  sources,
  outPath,
  existsFn = existsSync,
  readFileFn = (p) => readFileSync(p, "utf8"),
  writeFileFn = (p, c) => writeFileSync(p, c, "utf8"),
}) {
  const fingerprints = [];
  for (const src of sources) {
    if (!existsFn(src.path)) continue;
    const raw = readFileFn(src.path).trim();
    const fp = secretFingerprint(raw);
    if (fp)
      fingerprints.push({ id: src.id, length: fp.length, sha256: fp.sha256 });
  }
  writeFileFn(
    outPath,
    JSON.stringify(
      { generated_note: "sha256 지문만 -- 원문 없음", fingerprints },
      null,
      2,
    ),
  );
  return { count: fingerprints.length, outPath };
}

// 3종을 한 번에 돌려 결과 배열을 만든다 -- CLI와 테스트가 공유하는 조립점.
// fingerprints는 이미 로드된 지문 배열이어야 한다(이 함수는 시크릿 파일을
// 열지 않는다 -- 그건 runFingerprintInit만의 몫). existsFn/readFileFn/
// readdirFn은 아래 3개 개별 체크 전부에 그대로 전달된다 -- 테스트가 주입한
// 가짜 fs가 일부만 적용되고 나머지가 조용히 실제 파일시스템으로 새는 사고를
// 구조적으로 막는다.
export function runOrcaPostureCheck({
  orcaHome,
  appDataOrca,
  fingerprints = [],
  existsFn = existsSync,
  readFileFn = (p) => readFileSync(p, "utf8"),
  readdirFn = readdirSync,
}) {
  return [
    {
      id: "linear-reconnect",
      ...checkLinearReconnect({
        workspacesPath: join(orcaHome, "linear-workspaces.json"),
        tokensDir: join(orcaHome, "linear-tokens"),
        existsFn,
        readFileFn,
        readdirFn,
      }),
    },
    {
      id: "automations-present",
      ...checkAutomationsPresent({
        dbPath: join(appDataOrca, "orchestration.db"),
        existsFn,
        readFileFn,
      }),
    },
    {
      id: "terminal-history-secret-scan",
      ...checkTerminalHistorySecretScan({
        dir: join(appDataOrca, "terminal-history"),
        fingerprints,
        existsFn,
        readFileFn,
        readdirFn,
      }),
    },
  ];
}

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/orca-posture-check.mjs");
if (invokedDirectly) {
  const home = homedir();
  const appDataOrca = join(
    process.env.APPDATA || join(home, "AppData", "Roaming"),
    "orca",
  );
  const orcaHome = join(home, ".orca");
  const fingerprintsPath = join(
    repoRoot(),
    ".harness",
    "secret-fingerprints.json",
  );
  const subcommand = process.argv[2];

  // fingerprint-init: the ONLY path in this CLI that ever opens a real
  // secret file. Prints a count + the output path, never a value or hash.
  if (subcommand === "fingerprint-init") {
    const sources = [{ id: "bot_pat", path: join(home, ".bot_pat") }];
    const result = runFingerprintInit({ sources, outPath: fingerprintsPath });
    console.log(
      `fingerprint-init: ${result.count}개 지문 생성 -> ${result.outPath}`,
    );
    process.exit(0);
  }

  const { fingerprints, present, malformed } =
    loadFingerprints(fingerprintsPath);
  if (!present) {
    console.log(
      `orca-posture-check: 지문 파일 없음(${fingerprintsPath}) -- terminal-history-secret-scan은 UNJUDGABLE로 진행. init: node scripts/check/orca-posture-check.mjs fingerprint-init`,
    );
  } else if (malformed) {
    console.log(
      `orca-posture-check: 지문 파일 손상/스키마 불일치(${fingerprintsPath}) -- 재생성 필요`,
    );
  }

  const results = runOrcaPostureCheck({ orcaHome, appDataOrca, fingerprints });

  console.log(
    "orca-posture-check: 탐지 전용(advisory) -- 예방 아님 · Orca 로컬 파일 레이아웃 의존(업데이트 시 드리프트 가능) · CI 미러 불가(로컬 파일 검사)",
  );
  for (const r of results) {
    console.log(`  ${r.status.padEnd(11)} ${r.id} -- ${r.reason}`);
  }
  process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
}
