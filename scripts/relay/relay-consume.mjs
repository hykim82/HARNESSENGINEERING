// HYK-390-auth-shadow-2 (판정 2026-11-17 17:05 ④ · 21:04 ③): relay 쪽 «소비
// 입구». ORCH 가 라운드를 소비할 때 옛
//   node scripts/check/relay-handshake.mjs <역할> <harnessDir>
// 대신 부르는 새 명령
//   node scripts/relay/relay-consume.mjs <역할> <harnessDir>
//
// 하는 일은 딱 둘이다.
//   ⑴ 실 Orca 조회(createDispatchAuthLookup)를 영수증 «진위 그림자»의 기본
//      조회로 결선한다(configureAuthShadowDefaults). 그러면 소비가 남기는 그림자
//      기록이 «결선 안 됨(lookup_not_wired)»이 아니라 실제 Orca 판정(진짜 ·
//      위조 의심 · 조회 실패)이 된다.
//   ⑵ 그 다음 옛 CLI 가 부르는 «같은» 함수(runRelayHandshakeCli)를 부른다 --
//      같은 인자 해석 · 같은 표준 출력/오류 · 같은 종료 코드. CLI 본문을 복사하지
//      않는다(relay-handshake.mjs 가 export 한 함수를 그대로 부른다).
//
// 왜 이 파일이 scripts/relay 에 있나: scripts/check/* 는 scripts/relay/* 를
// import 할 수 없다(eslint 경계 -- eslint.config.mjs 의 no-restricted-imports).
// 방향은 relay -> check 만 허용되므로 결선은 relay 쪽 이 파일이 한다. 경계
// 규칙은 손대지 않았고 동적 import 로 피하지도 않는다.
//
// ⛔그림자는 «기록 전용»이다(차단 0). 조회가 실패 · 시한 초과 · 비동기여도 소비
// 결과(ok · 사유 · 종료 코드)는 옛 명령과 같다. 이 파일은 `orca` 를 직접 실행하지
// 않는다 -- 실행은 어댑터의 createOrcaExecFn 한 곳뿐(G9).
//
// 조회 대기 상한 = 값 하나: relay-handshake.mjs 의 AUTH_SHADOW_DEFAULT_TIMEOUT_MS
// (10초). 실 조회의 spawn 시한에도 같은 값을 건다(어댑터의 별도 기본값을 쓰지
// 않는다). 소비 1건이 조회에 동기로 최대 이만큼 기다린다.
import {
  AUTH_SHADOW_DEFAULT_TIMEOUT_MS,
  configureAuthShadowDefaults,
  runRelayHandshakeCli,
} from "../check/relay-handshake.mjs";
import {
  createDispatchAuthLookup,
  createOrcaExecFn,
} from "./adapters/orca-adapter.mjs";

// 실 조회를 그림자 기본값으로 결선한다. 반환 = 이전 기본값(시험이 되돌리는 용).
// `spawnSyncFn` 은 시험이 실 orca 없이 어댑터 경로를 구동하는 주입 자리다 --
// 운영 호출은 인자 없이 부른다(어댑터의 실 spawnSync).
export function wireAuthShadowLookup({ spawnSyncFn } = {}) {
  const execFn = createOrcaExecFn({
    spawnSyncFn,
    timeoutMs: AUTH_SHADOW_DEFAULT_TIMEOUT_MS,
  });
  return configureAuthShadowDefaults({
    orcaDispatchLookup: createDispatchAuthLookup({ execFn }),
  });
}

// 결선 + 옛 CLI 와 같은 소비. 끝에서 process.exit 를 부른다(옛 CLI 와 같다).
export function runRelayConsume() {
  wireAuthShadowLookup();
  runRelayHandshakeCli();
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/relay-consume.mjs");
if (invokedDirectly) {
  runRelayConsume();
}
