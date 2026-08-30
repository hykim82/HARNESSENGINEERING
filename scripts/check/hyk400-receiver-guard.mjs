import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// HYK-400 (coder-task.md §1-2, 오늘 실사고 2회): 배달기(dispatch-worker.ps1)
// 는 "master 의" CLI가 아니라 "대상 워크트리의" CLI를 부른다(코드 실측,
// 배달기 312행 `$receiptCliPath = Join-Path $Worktree ...`). 워크트리가
// 옛 커밋 기준이면 그 CLI는 새 인자를 모르는 채로 불려 `unrecognized
// flag`로 깨진다 -- 배달 «후»에야 드러난다. 이 모듈은 배달 «전»에, 대상
// 워크트리의 dispatch-receipt-cli.mjs가 특정 플래그를 실제로 인식하는지
// 판정한다.
//
// Q1 설계 선택(부작용 없는 판정) -- 정적 텍스트 검사가 아니라 «동적
// import + 순수 파서 함수 호출»을 골랐다:
//   - 정적 정규식(예: 파일 텍스트에서 '--harness-dir' 문자열 검색)은
//     주석·문서 문자열에도 걸려 오탐한다(이 파일 자신도 위 헤더 주석에
//     그 플래그 이름을 언급한다 -- 순수 텍스트 검사였다면 자기 자신도
//     오염시켰을 것).
//   - `dispatch-receipt-cli.mjs`의 `parseDispatchReceiptArgs`는 이미
//     순수 함수다(파일시스템 접근 0, HYK-219-receipts-2) -- 그 CLI가
//     직접 실행될 때만 동작하는 부수효과 블록(`invokedDirectly` 가드,
//     `process.argv[1]`이 그 파일 경로로 끝날 때만 참)은 import만으로는
//     절대 실행되지 않는다(우리 호출자의 argv[1]은 그 경로가 아니다).
//     즉 대상 파일을 import해 그 파서 함수를 호출하는 것은 "실행해 보고
//     실패하면"과 달리 영수증 append 같은 부작용을 «전혀» 일으키지
//     않으면서도, 실제 런타임이 그 플래그를 인식하는지 «그대로» 답한다
//     (정적 검사보다 권위 있다 -- 파서 로직 자체를 실행한다).
//   - 대상이 이 계약(`parseDispatchReceiptArgs` export)조차 갖추지 못한
//     구버전/변형이면 판정을 내릴 수 없다 -- 그 경우도 거부다(P: 확인
//     자체가 실패하면 그것도 거부, fail-open 금지).

const RECEIPT_CLI_RELATIVE_PATH = "scripts/relay/dispatch-receipt-cli.mjs";

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

async function defaultImportFn(cliPath) {
  return import(pathToFileURL(cliPath).href);
}

// { worktree, flag, importFn? } -> { ok, supported, reason }
// - flag가 비어 있으면(그 배달이 이 능력을 요구하지 않는 경우) 판정 자체를
//   건너뛰고 통과한다(Q3-ⓓ, 회귀 0 -- "확인할 게 없음"과 "확인이
//   실패함"은 다른 상태다).
// - ok:false는 "판정 불가"(파일 없음·import 실패·계약 없음·파서가 예상
//   밖 모양을 반환) -- 이 경우도 supported:false로 접어 거부측에 둔다.
function missing(reason) {
  return { ok: false, supported: false, reason };
}

// 대상 CLI를 import하고, 그 순수 파서 함수를 계약(§Q1)대로 갖췄는지까지
// 확인한다 -- fs 접근·import 실패·계약 불일치를 이 한 곳에서 판정 불가로
// 접는다(호출부의 분기 수를 줄이기 위한 분리, 판정 기준은 그대로).
async function loadReceiptCliParser(worktree, importFn) {
  const cliPath = join(worktree, RECEIPT_CLI_RELATIVE_PATH);
  if (!existsSync(cliPath)) {
    return missing(`RECEIVER_CLI_MISSING: ${cliPath} 가 없다`);
  }
  let mod;
  try {
    mod = await importFn(cliPath);
  } catch (err) {
    return missing(`RECEIVER_CLI_IMPORT_FAILED: ${err.message}`);
  }
  if (typeof mod.parseDispatchReceiptArgs !== "function") {
    return missing(
      "RECEIVER_CLI_CONTRACT_MISSING: parseDispatchReceiptArgs export 없음",
    );
  }
  return { ok: true, parse: mod.parseDispatchReceiptArgs };
}

// 순수 파서를 합성 인자로 호출해 본 뒤(부작용 0, 파일시스템은 여기서
// 전혀 만지지 않는다) 그 결과를 세 값 중 하나로만 접는다: 지원함(ok:true,
// supported:true) · 미지원임을 확인함(ok:true, supported:false, 사유에
// 플래그 이름 포함) · 판정 불가(ok:false, fail-closed).
function classifyProbeResult(probe, flag) {
  if (!probe || typeof probe !== "object") {
    return missing(
      "RECEIVER_CLI_PROBE_INCONCLUSIVE: 파서가 객체를 반환하지 않음",
    );
  }
  if (probe.ok === true) {
    return { ok: true, supported: true, reason: null };
  }
  if (
    probe.ok === false &&
    typeof probe.reason === "string" &&
    probe.reason.includes(`unrecognized flag '${flag}'`)
  ) {
    return { ok: true, supported: false, reason: probe.reason };
  }
  return missing(
    `RECEIVER_CLI_PROBE_INCONCLUSIVE: ${probe.reason ?? "알 수 없는 파서 응답"}`,
  );
}

export async function checkReceiptCliFlagSupport({
  worktree,
  flag,
  importFn = defaultImportFn,
}) {
  if (!isNonEmptyString(flag)) {
    return { ok: true, supported: true, reason: "NO_FLAG_REQUESTED" };
  }
  if (!isNonEmptyString(worktree)) {
    return missing("RECEIVER_CLI_MISSING: worktree 경로가 비었다");
  }

  const loaded = await loadReceiptCliParser(worktree, importFn);
  if (!loaded.ok) return loaded;

  const probeArgs = [
    "--role",
    "PROBE",
    "--task-label",
    "hyk400-probe",
    "--receipt-path",
    "hyk400-probe-path",
    flag,
    "probe-value",
  ];
  let probe;
  try {
    probe = loaded.parse(probeArgs, {});
  } catch (err) {
    return missing(`RECEIVER_CLI_PROBE_THREW: ${err.message}`);
  }
  return classifyProbeResult(probe, flag);
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--worktree") out.worktree = argv[++i];
    else if (argv[i] === "--flag") out.flag = argv[++i];
  }
  return out;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/hyk400-receiver-guard.mjs");
if (invokedDirectly) {
  const { worktree, flag } = parseCliArgs(process.argv.slice(2));
  if (!isNonEmptyString(worktree) || !isNonEmptyString(flag)) {
    console.error(
      "FAILED reason=usage: hyk400-receiver-guard.mjs --worktree <path> --flag <flagname>",
    );
    process.exit(1);
  }
  const result = await checkReceiptCliFlagSupport({ worktree, flag });
  if (result.ok && result.supported) {
    console.log(`SUPPORTED flag=${flag} worktree=${worktree}`);
    process.exit(0);
  }
  console.error(
    `REJECTED flag=${flag} worktree=${worktree} reason=${result.reason}`,
  );
  process.exit(1);
}
