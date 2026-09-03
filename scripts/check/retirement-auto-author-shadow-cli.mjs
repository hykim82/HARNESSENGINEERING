// HYK-419-wire-1 (coder-task.md §2⑵) -- retire-author-shadow의 CLI 진입점.
//
// ★왜 CLI로 분리했는가 (relay-handshake.mjs에 직접 정적 import하지 않은
// 이유): 이 파일이 처음 이 관측을 relay-handshake.mjs 안에 assembleAuto
// AuthorFacts/evaluateAutoAuthorAuthorization의 **정적 import**로 심었을
// 때, 이 저장소의 격리 픽스처 시험 24개(admission-completion-spawn.test.mjs
// 등 -- relay-handshake.mjs를 "정확히 알려진 형제 파일 목록"(time-authority/
// reject-streak/envelope-archive)만 복사해 격리 디렉터리에서 서브프로세스로
// 돌리는 시험들)가 전부 MODULE_NOT_FOUND로 깨졌다(실측: npm test 5819개 중
// 60개 실패). abort-record-writer.mjs/admission-completion-adapter.mjs가
// 이미 정확히 같은 이유로 "정적 import 대신 서브프로세스 스폰"을 쓰고
// 있었다(spawnAbortRecordWriter의 자기 주석: "a 5th static import ... would
// break module resolution for every one of those tests at LOAD time; a spawn
// only fails at CALL time, absorbed by the try/catch") -- 이 라운드는 그
// 선례를 그대로 따른다: relay-handshake.mjs는 이 파일을 정적 import하지
// 않고, `node retirement-auto-author-shadow-cli.mjs <role> <taskId>
// [harnessDir] [doneAt]`로 스폰만 한다. 이 CLI 파일 자신이 격리 픽스처에
// 없으면 스폰이 실패하고(child_process 에러), 부모(relay-handshake.mjs)의
// 자체 try/catch가 그 실패를 흡수한다 -- 이 파일이 있든 없든 소비 자체는
// 절대 막히지 않는다(coder-task.md §2⑷ 차단 0).
//
// ★계약: 이 CLI는 무엇을 하든 표준출력에 정확히 한 줄
// (`retire-author-shadow: ...`)을 찍고 **항상 exit 0**으로 끝난다 -- 판정
// 불가/조립 불가/예상 밖 예외 어느 것도 이 CLI 자신의 종료코드에 반영되지
// 않는다(부모가 exit code를 읽지 않고 stdout만 그대로 console.log하기
// 때문에, exit 0이 아니면 부모의 execFileSync가 예외를 던져 그 stdout 자체를
// 잃는다 -- 이 CLI는 그 경로를 만들지 않는다).
import { assembleAutoAuthorFacts } from "./retirement-auto-author-facts.mjs";
import { evaluateAutoAuthorAuthorization } from "./retirement-auto-author-core.mjs";

export function buildShadowLine({ role, taskId, harnessDir, doneAt }) {
  try {
    const assembled = assembleAutoAuthorFacts({
      role,
      harnessTaskLabel: taskId,
      harnessDir,
      ledgerPath: process.env.ADMISSION_LEDGER_PATH,
      receiptPath: process.env.DISPATCH_RECEIPT_PATH,
      recordedAt: doneAt,
    });
    if (!assembled.ok) {
      return `retire-author-shadow: ASSEMBLE_FAILED reason=${assembled.code} label=${taskId} (shadow -- 아무것도 차단하지 않음)`;
    }
    const verdict = evaluateAutoAuthorAuthorization(assembled.facts);
    return `retire-author-shadow: JUDGED reason=${verdict.state} label=${taskId} (shadow -- 아무것도 차단하지 않음)`;
  } catch (err) {
    return `retire-author-shadow: OBSERVATION_ERROR reason=${err.message} label=${taskId} (shadow -- 아무것도 차단하지 않음)`;
  }
}

if (
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/retirement-auto-author-shadow-cli.mjs")
) {
  const [, , role, taskId, harnessDir, doneAt] = process.argv;
  console.log(buildShadowLine({ role, taskId, harnessDir, doneAt }));
  process.exit(0);
}
