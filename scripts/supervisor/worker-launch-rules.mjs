// HYK-439-launch-rules-1 (coder-task.md §2ⓐ): a single repo file holding
// the foreground-runner launch rule (관제실 worker-dispatch-rule.md §6-c의
// 뜻) as an engine-agnostic text block, so a launcher (PowerShell or any
// other dispatcher) can read ONE source instead of every dispatch task
// file repeating the same prose by hand. §6-c's own trigger: H7b 1R
// (2026-10-24) -- an agent started a long-running full test runner inside a
// BACKGROUND shell, and a low-memory reclaimer later killed that shell,
// taking the runner process tree down with it. The rule exists to make
// that failure mode structurally unreachable: the runner is always started
// and waited on through foreground tool calls, never a background one.
//
// 설계 원칙(coder-task.md §1 인용, 하드 제약): "새 강제 기능엔 엔진 무관
// 기반 선언 · Claude 전용 훅 단독 금지" -- 그래서 이 조각의 본문은 역할·
// 엔진에 따라 달라지지 않는다. 머리 1줄만 역할을 적고, 그 아래 본문은
// claude든 codex든 완전히 같은 바이트열이다.
//
// 가변값 금지: 이 본문은 관제실 경로·날짜·좌석 이름 같은 호출마다 바뀌는
// 값을 담지 않는다(그런 값은 `--worktree`/`--role` 같은 CLI 인자나 호출하는
// 쪽의 몫이다) -- 그래야 두 번 실행한 출력이 항상 바이트 단위로 같다
// (결정성, coder-task.md §2ⓒ).

export const KNOWN_ROLES = ["ORCH", "CODER", "REVIEW", "VERIFY", "PM"];
export const KNOWN_ENGINES = ["claude", "codex"];

// 본문 6항목은 coder-task.md §2ⓑ ⑴~⑹과 1:1 대응한다. 숫자를 넣은 것은
// 사람이 §6-c와 대조하기 쉽게 하기 위함이고, 시험은 숫자가 아니라 각 줄의
// 한국어 문구(동그라미 숫자가 아닌 실제 낱말)로 존재를 확인한다.
export const LAUNCH_RULE_BODY = `⛔⭐foreground 러너 착수 규칙(관제실 worker-dispatch-rule.md §6-c 의 뜻 · H7b 1R 사고 재발 금지):
1. 전건 러너 또는 몇 분 이상 걸리는 node 실행은 «앞 화면(foreground) 도구 호출 한 번» 안에서 Start-Process -PassThru 로 띄우고, 그 호출은 PID 를 출력한 뒤 바로 끝낸다.
2. 기다릴 때도 «앞 화면» 도구 호출로 Wait-Process -Id <PID> -Timeout 540 을 반복한다(각 호출은 10분 상한 안에서 끝낸다).
3. run_in_background · 배경 폴링 루프 · & 백그라운드 잡 · 배경 셸 안 Start-Process 는 전부 금지한다 -- 이 넷 중 하나라도 쓰면 그 셸이 끊길 때 러너 프로세스 트리가 함께 죽는다(H7b 1R 사고의 원인).
4. 로그 파일과 rc(종료코드) 파일은 워크트리 «밖» 고정 경로에 둔다.
5. 회차가 끊기면(배경 셸이 죽거나 회수되면) 결과 파일에 끊긴 시각 · 끊긴 프로세스(PID) · 영수증이 0 B 인지 여부를 1줄로 적는다 -- 끊긴 흔적을 지우지 않는다.
6. 이 규칙과 지시서(task 파일)의 launch_rule 이 다르면, 지시서가 더 좁게 정한 쪽을 우선한다(지시서가 이 규칙보다 범위를 좁힐 수 있다).`;

// buildLaunchRuleBlock({role, engine}) -- 역할 머리줄 1개 + 고정 본문.
// 본문은 role·engine 에 따라 달라지지 않는다(엔진 무관 증명, §2ⓒ) -- 두
// 인자는 알려진 값인지 검증만 하고, 반환 문자열의 내용에는 engine이
// 전혀 나타나지 않는다(미래에 엔진별 차이가 필요해지면 그 때 새 설계
// 결정을 거쳐야 한다는 뜻을 그대로 남긴다).
export function buildLaunchRuleBlock({ role, engine }) {
  if (typeof role !== "string" || !KNOWN_ROLES.includes(role)) {
    throw new Error(
      `worker-launch-rules: unknown role '${role}' (known: ${KNOWN_ROLES.join(", ")})`,
    );
  }
  if (typeof engine !== "string" || !KNOWN_ENGINES.includes(engine)) {
    throw new Error(
      `worker-launch-rules: unknown engine '${engine}' (known: ${KNOWN_ENGINES.join(", ")})`,
    );
  }
  return `[worker-launch-rules] role=${role}\n${LAUNCH_RULE_BODY}\n`;
}

function printUsage() {
  console.error(
    "usage: node scripts/supervisor/worker-launch-rules.mjs --role <ORCH|CODER|REVIEW|VERIFY|PM> --engine <claude|codex>",
  );
}

function parseArgs(argv) {
  let role = null;
  let engine = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--role") {
      role = argv[++i] ?? null;
    } else if (argv[i] === "--engine") {
      engine = argv[++i] ?? null;
    } else {
      return { ok: false, reason: `unknown argument '${argv[i]}'` };
    }
  }
  if (role === null) return { ok: false, reason: "missing --role" };
  if (engine === null) return { ok: false, reason: "missing --engine" };
  return { ok: true, role, engine };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/worker-launch-rules.mjs");
if (invokedDirectly) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    printUsage();
    console.error(`worker-launch-rules: ${parsed.reason}`);
    process.exit(2);
  }
  try {
    process.stdout.write(
      buildLaunchRuleBlock({ role: parsed.role, engine: parsed.engine }),
    );
    process.exit(0);
  } catch (err) {
    printUsage();
    console.error(`worker-launch-rules: ${err.message}`);
    process.exit(2);
  }
}
