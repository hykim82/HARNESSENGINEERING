import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// HYK-400 2R (coder-task.md §1-2, 1R 검토 반려 P1-1/P1-2/P1-3 + P2 수리).
// 1R은 "대상 워크트리의 dispatch-receipt-cli.mjs를 판정기 자신의
// 프로세스 안에서 import해 파싱 성공 여부만 본다"였다 -- 검토가 실측으로
// 깬 세 가지:
//   P1-3 부작용 0 이 거짓이었다: import 순간 최상위 코드가 실행돼 실제
//     파일 쓰기가 일어났다("부작용 없다"는 «현재 정본 모듈»에 대한
//     추론이었지 «임의 대상»에 대한 보장이 아니었다).
//   P1-1 파싱 성공 == 이해 로 착각했다: 플래그를 다른 의미로 처리해도
//     {ok:true} 만 보고 supported:true 로 승인했다.
//   P1-2 경로 진위를 안 봤다: 대상이 다른 저장소를 가리키는 심링크여도
//     그대로 import해 승인했다.
// 2R은 이 세 축을 구조로 다시 세운다(구멍 메우기가 아니라 불변식):
//   I1(격리) -- scripts/check/hyk400-receiver-probe-runner.mjs 자신의
//     헤더 주석 참조. 대상 코드는 이 프로세스에서 «절대» 실행되지 않는다
//     -- 언제나 `node --permission --allow-fs-read=<worktree>` 로 뜬
//     별도 자식 프로세스 안에서만, execFileSync의 timeout으로 감시된
//     채로 실행된다. 타임아웃·비정상 종료·JSON 아닌 출력 = 전부 거부.
//   I2(의미) -- "파싱 성공"이 아니라 "우리가 넘긴 값이 실제로 응답에
//     반영됐는가"를 매번 다른 무작위 sentinel(§evaluateSemanticFidelity)
//     로 대조한다. 계약 필드(role/harnessTaskLabel/receiptPath)가
//     오염되지 않았는지도 함께 본다.
//   I3(경계) -- realpath로 해석한 대상 경로가 realpath로 해석한
//     워크트리 경계 «안»이어야 한다(resolveVerifiedTargetPath). 심링크가
//     다른 저장소를 가리키면 그 경로가 경계 밖으로 나가므로 거부된다.
//   I4(문 없애기) -- 검사할 플래그 집합은 호출자가 "이 플래그를 검사해
//     줘"라고 골라 넘기지 않는다(1R의 `flag` 파라미터, 안 넘기면
//     자동 통과하던 구멍). 대신 «이 배달이 실제로 보내는 인자 배열»
//     (deliveryArgs, ps1이 Record-DispatchReceipt에 실제로 넘기는 것과
//     바이트 동일해야 한다)을 통째로 받아, 그 안에서 필수 3필드를 뺀
//     나머지 --플래그를 기계로 뽑는다(deriveOptionalFlags). deliveryArgs가
//     비었거나 필수 3필드조차 없으면 "검사할 게 없다"로 조용히 통과하지
//     않고 거부한다(RECEIVER_GUARD_BAD_INPUT) -- "0개 검사"가 정당하려면
//     그 사실이 «형태를 갖춘 진짜 배달 인자»에서 유도돼야 한다.

const RECEIPT_CLI_RELATIVE_PATH = "scripts/relay/dispatch-receipt-cli.mjs";
const RUNNER_PATH = fileURLToPath(
  new URL("./hyk400-receiver-probe-runner.mjs", import.meta.url),
);
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const BASELINE_FIELD_FLAGS = Object.freeze([
  "--role",
  "--task-label",
  "--receipt-path",
]);

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function rejected(reason, extra = {}) {
  return { ok: false, supported: false, reason, ...extra };
}

// I4: 검사 대상 플래그 집합은 실제 배달 인자 배열에서 기계로 유도된다 --
// 호출자가 "이것만 봐 줘"라고 고르지 않는다. deliveryArgs가 비었거나
// 필수 3필드(계약상 항상 보내는 것, HYK-219)조차 없으면 그 자체가
// "이건 진짜 배달 인자가 아니다"라는 신호이므로 조용히 통과시키지 않고
// 거부한다.
export function deriveOptionalFlags(deliveryArgs) {
  if (!Array.isArray(deliveryArgs) || deliveryArgs.length === 0) {
    return {
      ok: false,
      reason:
        "RECEIVER_GUARD_BAD_INPUT: deliveryArgs가 비었다 -- 이 배달이 실제로 보내는 인자 배열을 그대로 넘겨야 한다(검사를 생략할 목적으로 빈 배열/미지정을 쓸 수 없다)",
    };
  }
  const missingBaseline = BASELINE_FIELD_FLAGS.filter(
    (f) => !deliveryArgs.includes(f),
  );
  if (missingBaseline.length > 0) {
    return {
      ok: false,
      reason: `RECEIVER_GUARD_BAD_INPUT: 필수 필드 플래그 누락(${missingBaseline.join(", ")}) -- 진짜 배달 인자 배열로 보이지 않는다`,
    };
  }
  const flags = [];
  for (const arg of deliveryArgs) {
    if (
      typeof arg === "string" &&
      arg.startsWith("--") &&
      !BASELINE_FIELD_FLAGS.includes(arg)
    ) {
      flags.push(arg);
    }
  }
  return { ok: true, flags: [...new Set(flags)] };
}

// I3: 대상 경로를 realpath로 해석해, 워크트리 자신도 realpath로 해석한
// 경계 «안»에 있는지 확인한다. 심링크가 다른 저장소를 가리키면
// targetReal이 그 경계 밖으로 나가 거부된다. realpathSync는 파일시스템
// 메타데이터만 읽는다(대상 코드를 실행하지 않는다) -- I1과 별개의 축.
export function resolveVerifiedTargetPath({ worktree }) {
  if (!isNonEmptyString(worktree)) {
    return rejected("RECEIVER_CLI_MISSING: worktree 경로가 비었다");
  }
  let worktreeReal;
  try {
    worktreeReal = realpathSync(worktree);
  } catch (err) {
    return rejected(
      `RECEIVER_CLI_MISSING: worktree를 realpath로 해석할 수 없다(${err.message})`,
    );
  }
  const candidatePath = join(worktree, RECEIPT_CLI_RELATIVE_PATH);
  if (!existsSync(candidatePath)) {
    return rejected(`RECEIVER_CLI_MISSING: ${candidatePath} 가 없다`);
  }
  let targetReal;
  try {
    targetReal = realpathSync(candidatePath);
  } catch (err) {
    return rejected(
      `RECEIVER_CLI_MISSING: ${candidatePath} 를 realpath로 해석할 수 없다(${err.message})`,
    );
  }
  const boundary = worktreeReal.endsWith(sep)
    ? worktreeReal
    : worktreeReal + sep;
  if (targetReal !== worktreeReal && !targetReal.startsWith(boundary)) {
    return rejected(
      `RECEIVER_CLI_BOUNDARY_ESCAPE: ${candidatePath} 가 워크트리 경계 밖(${targetReal})을 가리킨다(심링크/다른 저장소/경로 탈출 의심)`,
    );
  }
  return { ok: true, targetReal, worktreeReal };
}

function defaultExecFileSyncFn(cmd, args, opts) {
  return execFileSync(cmd, args, opts);
}

// I1: 대상을 절대 이 프로세스 안에서 import하지 않는다. 별도 자식
// 프로세스(node --permission, fs 쓰기·child_process 등은 기본 거부)를
// execFileSync의 timeout으로 감시하며 부른다. 타임아웃(무한 대기·무한
// 루프)·비정상 종료·JSON 아닌 출력은 전부 거부로 접는다(fail-open 금지).
function runIsolatedProbe({
  targetReal,
  worktreeReal,
  baselineArgs,
  flagArgs,
  execFileSyncFn,
  timeoutMs,
}) {
  const payload = Buffer.from(
    JSON.stringify({ targetPath: targetReal, baselineArgs, flagArgs }),
  ).toString("base64");

  let stdout;
  try {
    stdout = execFileSyncFn(
      process.execPath,
      ["--permission", `--allow-fs-read=${worktreeReal}`, RUNNER_PATH, payload],
      {
        cwd: worktreeReal,
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (err) {
    if (err.signal === "SIGKILL" || err.code === "ETIMEDOUT") {
      return rejected(
        "RECEIVER_CLI_PROBE_TIMEOUT: 격리 프로세스가 제한시간 내 응답하지 않았다(무한 대기/무한 루프 의심)",
      );
    }
    // execFileSync가 반환하는 유일한 경로가 종료코드 0·시그널 없음이다.
    // 예외에 stdout이 붙어 있어도 child는 비정상 종료했으므로 절대 읽지
    // 않고 거부한다 -- 그럴듯한 JSON이 종료 상태를 덮어쓸 수 없다.
    return rejected(
      `RECEIVER_CLI_PROBE_CRASHED: 격리 프로세스가 비정상 종료했다(status=${err.status ?? "unknown"}, signal=${err.signal ?? "none"}; ${err.message})`,
    );
  }

  const lastLine = stdout.trim().split("\n").pop();
  let parsed;
  try {
    parsed = JSON.parse(lastLine);
  } catch (err) {
    return rejected(
      `RECEIVER_CLI_PROBE_MALFORMED: 격리 프로세스 응답을 JSON으로 해석할 수 없다(${err.message})`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    return rejected(
      "RECEIVER_CLI_PROBE_MALFORMED: 격리 프로세스 응답이 객체가 아니다",
    );
  }
  if (parsed.ok !== true) {
    return rejected(parsed.reason ?? "RECEIVER_CLI_PROBE_MALFORMED: 사유 없음");
  }
  return { ok: true, baseline: parsed.baseline, withFlag: parsed.withFlag };
}

// I2: "파싱이 성공했다"가 아니라 "우리가 보낸 값이 실제로 반영됐다"를
// 본다. baseline/withFlag 두 응답을 대조해:
//   1) 계약 필드(role/harnessTaskLabel/receiptPath)가 baseline이 기대한
//      값 그대로인지(둘 다) -- 오염되면 거부.
//   2) withFlag의 harnessDir가 sentinel과 정확히 같은지 -- 이 플래그의
//      계약상 의미 필드에 값이 실제로 반영됐다는 증거다. 다른 필드에
//      sentinel을 복사하거나 고정 상수로 치환한 응답은 거부한다.
function matchesProbeContract(response, values) {
  return (
    response?.ok === true &&
    response.role === values.roleValue &&
    response.harnessTaskLabel === values.taskLabelValue &&
    response.receiptPath === values.receiptPathValue
  );
}

function classifyFlagFailure(withFlag, flag) {
  if (
    typeof withFlag?.reason === "string" &&
    withFlag.reason.includes(`unrecognized flag '${flag}'`)
  ) {
    return { ok: true, supported: false, reason: withFlag.reason };
  }
  return rejected(
    `RECEIVER_CLI_PROBE_INCONCLUSIVE: flag 포함 호출이 예상 밖 사유로 실패했다(${withFlag?.reason ?? "사유 없음"})`,
  );
}

function responseCarriesSentinel(baseline, withFlag, sentinel) {
  return withFlag?.harnessDir === sentinel && baseline?.harnessDir !== sentinel;
}

function evaluateSemanticFidelity({
  baseline,
  withFlag,
  roleValue,
  taskLabelValue,
  receiptPathValue,
  flag,
  sentinel,
}) {
  const probeValues = { roleValue, taskLabelValue, receiptPathValue };
  if (!matchesProbeContract(baseline, probeValues)) {
    return rejected(
      "RECEIVER_CLI_CONTRACT_MISMATCH: baseline 호출이 계약(role/harnessTaskLabel/receiptPath 그대로 반영)을 지키지 않는다",
    );
  }

  if (withFlag?.ok === false) {
    return classifyFlagFailure(withFlag, flag);
  }
  if (!matchesProbeContract(withFlag, probeValues)) {
    return rejected(
      "RECEIVER_CLI_CONTRACT_MISMATCH: flag 포함 호출이 계약 필드를 오염시켰거나 예상 밖 응답을 반환했다",
    );
  }

  if (!responseCarriesSentinel(baseline, withFlag, sentinel)) {
    return {
      ok: true,
      supported: false,
      reason: `RECEIVER_CLI_SEMANTIC_MISMATCH: '${flag}'가 파싱은 되지만(ok:true) 넘긴 값이 응답 어디에도 반영되지 않았다(다른 의미로 처리하거나 값을 버리는 것으로 의심)`,
    };
  }
  return { ok: true, supported: true, reason: null };
}

export async function checkReceiptCliFlagSupport({
  worktree,
  deliveryArgs,
  execFileSyncFn = defaultExecFileSyncFn,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) {
  const derived = deriveOptionalFlags(deliveryArgs);
  if (!derived.ok) {
    return rejected(derived.reason, { checkedFlags: [] });
  }
  if (derived.flags.length === 0) {
    return {
      ok: true,
      supported: true,
      reason: "NO_OPTIONAL_FLAGS_IN_DELIVERY",
      checkedFlags: [],
    };
  }

  const resolved = resolveVerifiedTargetPath({ worktree });
  if (!resolved.ok) {
    return { ...resolved, checkedFlags: derived.flags };
  }

  for (const flag of derived.flags) {
    const sentinel = `hyk400-sentinel-${randomUUID()}`;
    const roleValue = `hyk400-role-${randomUUID()}`;
    const taskLabelValue = `hyk400-label-${randomUUID()}`;
    const receiptPathValue = `hyk400-receipt-${randomUUID()}`;
    const baselineArgs = [
      "--role",
      roleValue,
      "--task-label",
      taskLabelValue,
      "--receipt-path",
      receiptPathValue,
    ];
    const flagArgs = [...baselineArgs, flag, sentinel];

    const probe = runIsolatedProbe({
      targetReal: resolved.targetReal,
      worktreeReal: resolved.worktreeReal,
      baselineArgs,
      flagArgs,
      execFileSyncFn,
      timeoutMs,
    });
    if (!probe.ok) {
      return { ...probe, checkedFlags: derived.flags, failedFlag: flag };
    }

    const verdict = evaluateSemanticFidelity({
      baseline: probe.baseline,
      withFlag: probe.withFlag,
      roleValue,
      taskLabelValue,
      receiptPathValue,
      flag,
      sentinel,
    });
    if (!verdict.supported) {
      return { ...verdict, checkedFlags: derived.flags, failedFlag: flag };
    }
  }

  return {
    ok: true,
    supported: true,
    reason: null,
    checkedFlags: derived.flags,
  };
}

function parseCliArgs(argv) {
  const out = { worktree: undefined, deliveryArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--worktree") {
      out.worktree = argv[++i];
    } else if (argv[i] === "--delivery-arg") {
      out.deliveryArgs.push(argv[++i]);
    }
  }
  return out;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/hyk400-receiver-guard.mjs");
if (invokedDirectly) {
  const { worktree, deliveryArgs } = parseCliArgs(process.argv.slice(2));
  if (!isNonEmptyString(worktree)) {
    console.error(
      "FAILED reason=usage: hyk400-receiver-guard.mjs --worktree <path> [--delivery-arg <token>]...",
    );
    process.exit(1);
  }
  const result = await checkReceiptCliFlagSupport({ worktree, deliveryArgs });
  if (result.ok && result.supported) {
    console.log(
      `SUPPORTED checked=${JSON.stringify(result.checkedFlags)} worktree=${worktree}`,
    );
    process.exit(0);
  }
  console.error(
    `REJECTED worktree=${worktree} checked=${JSON.stringify(result.checkedFlags ?? [])} reason=${result.reason}`,
  );
  process.exit(1);
}
