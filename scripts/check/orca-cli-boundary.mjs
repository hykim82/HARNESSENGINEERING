import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

// HYK-169-coder-1 (G9): 정적 스캔 -- "orca" CLI를 실제로 실행(spawn)하는
// 호출이 `scripts/relay/adapters/orca-adapter.mjs` 밖에 0건임을 검사한다.
// 주석·문서 문자열의 "orca" 언급은 허용하되(태스크 지시), 실행 호출 함수
// (spawnSync/spawn/execFile(Sync)/exec(Sync))의 **첫 인자가 문자열 리터럴
// "orca"인 호출**만 위반으로 잡는다 -- 변수로 조립한 명령어(간접 호출)는
// 이 정적 판정의 범위 밖이다(honesty: 문자열 리터럴 검사이지 데이터-흐름
// 분석이 아니다).
//
// 정직 한계(항상 명시): 이 스캔은 아래 LEGACY_EXEMPT 파일 2종을 예외로
// 둔다 -- HYK-162 스파이크 시절 코드(orca-spike-live.mjs)로, 이 태스크가
// 손대지 말라고 지시한 기존 릴레이 자산은 아니지만(그 목록엔 없음) 이
// 태스크의 스코프 밖이라 이번에 이관하지 않았다. 즉 "G9=scripts/ 전체에서
// 0건"은 **아직 완전히 달성되지 않았다** -- 알려진, 추적되는 격차이지
// 조용한 예외가 아니다(정직 요구).
export const ADAPTER_PATH = "scripts/relay/adapters/orca-adapter.mjs";
export const LEGACY_EXEMPT = Object.freeze([
  // HYK-162 사이클2 라이브 스파이크: --live 플래그 없이는 아무 것도 안 하고,
  // 이 태스크에서도 호출되지 않는다(비타협 제약). 이관은 별도 후속 이슈 몫.
  "scripts/relay/orca-spike-live.mjs",
]);

const EXEC_CALL_RE =
  /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(\s*["'`]orca["'`]/;

// files: [{ path (repo-relative, posix), content }] -- 순수 함수(테스트 fixture
// 주입 가능), 실 파일시스템 순회는 scanRepoForOrcaExecCalls가 담당.
export function scanForOrcaExecCalls(
  files,
  { adapterPath = ADAPTER_PATH, legacyExempt = LEGACY_EXEMPT } = {},
) {
  const exempt = new Set([adapterPath, ...legacyExempt]);
  const violations = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (exempt.has(f.path)) continue;
    if (EXEC_CALL_RE.test(f.content)) violations.push(f.path);
  }
  return violations;
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

function walkMjsFiles(dir, root, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkMjsFiles(full, root, out);
      // *.test.mjs files are excluded from the real-tree scan: their fixture
      // strings legitimately contain the literal exec-call pattern as text
      // under test (e.g. this scan's own known-bad fixtures), which is not a
      // production call site. G9 is a production-code boundary.
    } else if (entry.endsWith(".mjs") && !entry.endsWith(".test.mjs")) {
      out.push({
        path: relative(root, full).replace(/\\/g, "/"),
        content: readFileSync(full, "utf8"),
      });
    }
  }
}

// 실 scripts/ 트리 순회(테스트가 실제 리포지토리 상태에 대해 회귀를 잡는다).
export function scanRepoForOrcaExecCalls(root = repoRoot()) {
  const files = [];
  walkMjsFiles(join(root, "scripts"), root, files);
  return scanForOrcaExecCalls(files);
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/orca-cli-boundary.mjs");
if (invokedDirectly) {
  const violations = scanRepoForOrcaExecCalls();
  if (violations.length > 0) {
    console.error(
      `orca-cli-boundary: BLOCK -- orca exec call found outside adapter: ${violations.join(", ")}`,
    );
    process.exit(1);
  }
  console.log(
    "orca-cli-boundary: PASS -- no orca exec calls outside the adapter (legacy exemptions logged in source)",
  );
  process.exit(0);
}
