// HYK-400 2R (I1) -- 이 파일은 판정기(hyk400-receiver-guard.mjs)의 부모
// 프로세스 «안에서는 절대» 실행되지 않는다. 언제나 별도 자식 프로세스로,
// `node --permission --allow-fs-read=<worktree 실경로>` (fs 쓰기·
// child_process·worker·addon·wasi는 전부 거부 상태) 로만 구동되고, 그
// 부모가 `execFileSync`의 `timeout`으로 감시한다(무한 top-level await·
// 무한 루프 대비, 적대 표본 ⓑ). 이 파일 자신은 신뢰 대상이다(저장소
// 추적 파일, 첫 인자로 받는 targetPath만 신뢰하지 않는다) -- 1R 검토가
// 잡은 P1-3("import 순간 최상위 코드가 실제로 파일을 썼다")는 이 파일이
// 스스로 대비하지 않는다. 격리는 «이 파일을 어떻게 실행하느냐»(부모의
// 프로세스 플래그)가 책임지고, 이 파일은 그 격리된 환경 안에서 대상을
// import해 순수 파서 함수만 두 번(베이스라인·플래그 포함) 호출한다.
//
// stdout에 JSON 한 줄만 낸다(부모가 그 한 줄만 신뢰) -- 그 외 어떤 출력
// 경로도 판정에 쓰이지 않는다.

import { pathToFileURL } from "node:url";

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function main() {
  const raw = process.argv[2];
  if (typeof raw !== "string" || raw.length === 0) {
    emit({
      ok: false,
      reason: "RECEIVER_CLI_PROBE_MALFORMED: 러너 입력 없음",
    });
    return;
  }

  let input;
  try {
    input = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch (err) {
    emit({
      ok: false,
      reason: `RECEIVER_CLI_PROBE_MALFORMED: 러너 입력 디코딩 실패(${err.message})`,
    });
    return;
  }

  const { targetPath, baselineArgs, flagArgs } = input;

  let mod;
  try {
    mod = await import(pathToFileURL(targetPath).href);
  } catch (err) {
    // I1 실측(2026-08-30 프로토타입): 최상위에서 파일을 쓰려는 대상은
    // --permission이 ERR_ACCESS_DENIED를 던지고, 그 예외가 여기 import()의
    // reject로 그대로 전파된다 -- 실제 쓰기는 일어나지 않은 채로 이 경로에
    // 도달한다(부작용 0이 이 러너의 설계가 아니라 프로세스 자체의 능력
    // 결여로 보장됨, "우리 코드가 조심해서"가 아니다).
    emit({ ok: false, reason: `RECEIVER_CLI_IMPORT_FAILED: ${err.message}` });
    return;
  }

  if (typeof mod.parseDispatchReceiptArgs !== "function") {
    emit({
      ok: false,
      reason:
        "RECEIVER_CLI_CONTRACT_MISSING: parseDispatchReceiptArgs export 없음",
    });
    return;
  }

  let baseline;
  try {
    baseline = mod.parseDispatchReceiptArgs(baselineArgs, {});
  } catch (err) {
    emit({
      ok: false,
      reason: `RECEIVER_CLI_PROBE_THREW: baseline 호출 실패(${err.message})`,
    });
    return;
  }

  let withFlag;
  try {
    withFlag = mod.parseDispatchReceiptArgs(flagArgs, {});
  } catch (err) {
    emit({
      ok: false,
      reason: `RECEIVER_CLI_PROBE_THREW: flag 호출 실패(${err.message})`,
    });
    return;
  }

  emit({ ok: true, baseline, withFlag });
}

main().catch((err) => {
  emit({
    ok: false,
    reason: `RECEIVER_CLI_PROBE_CRASHED: ${err && err.message}`,
  });
});
