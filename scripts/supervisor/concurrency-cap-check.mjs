// HYK-193 1R (coder-task.md §4 요건1) -- 사람이 한 줄로 «값 파일 경로 +
// 현재 값»을 확인하는 CLI.
//
// 이 스크립트가 증명하는 것: 지금 커밋된 값 파일(`concurrency-cap.json`)
// 에 실제로 무엇이 적혀 있는지(어느 파일에서, 어떤 값을 읽었는지).
//
// 이 스크립트가 증명하지 않는 것: 이 값이 실제로 어떤 실행 중인
// supervisor에 쓰이고 있는지는 증명하지 않는다(live=false, 아직 이
// 값을 소비하는 상시 호출자가 없다 -- coder-task.md §8-3 "도달 경로 =
// 확인 명령 + 값 파일 자체"). ⚠️출력은 성공/실패 어느 경로든 항상
// 비어있지 않다 -- "안 돈 것"과 "값이 없는 것"을 사람이 구별할 수 있게
// 실패도 사유와 함께 한 줄로 찍는다.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readConcurrencyCap,
  CONCURRENCY_CAP_REASON,
} from "./concurrency-cap-adapter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CAP_PATH = path.join(__dirname, "concurrency-cap.json");

export const EXIT_CODE = Object.freeze({
  OK: 0,
  FAILED: 1,
});

// formatConcurrencyCapCheck({capPath, readFn}) -> {output, exitCode}
//
// capPath/readFn은 시험 주입용(기본은 실제 값 파일 + fs.readFileSync).
export function formatConcurrencyCapCheck(args = {}) {
  const capPath = args.capPath ?? DEFAULT_CAP_PATH;
  const result = readConcurrencyCap({ capPath, readFn: args.readFn });
  if (result.ok) {
    return {
      output: `concurrency-cap-check: file=${capPath} global_hard_cap=${result.cap}`,
      exitCode: EXIT_CODE.OK,
    };
  }
  return {
    output: `concurrency-cap-check: file=${capPath} FAILED reason=${result.reason} detail=${result.detail}`,
    exitCode: EXIT_CODE.FAILED,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/concurrency-cap-check.mjs");
if (invokedDirectly) {
  const { output, exitCode } = formatConcurrencyCapCheck();
  console.log(output);
  process.exit(exitCode);
}

// CONCURRENCY_CAP_REASON을 재수출 -- 호출자가 실패 사유를 프로그램적으로
// 검사하고 싶을 때 이 파일만 import하면 되게 한다(어댑터를 별도로
// import하지 않아도 되도록).
export { CONCURRENCY_CAP_REASON };
