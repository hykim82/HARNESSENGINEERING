// HYK-191-reach-1 (coder-task.md §1 요건3-b, §4) -- "이상 전이" 판정
// 순수 코어. I/O 0(상태 파일 읽기/쓰기·알림 파일 쓰기는 reach-report.mjs가
// 한다).
//
// 설계(coder-task.md §4의 결정적 교훈을 그대로 반영): 매 실행마다
// reach-report-core.mjs의 computeOpenAnomalies를 **전체 로그에서 처음부터
// 다시 계산**하고(그 axis가 지금 열려 있다면 sinceMs는 항상 "그 연속
// 구간이 실제로 시작된 시각"), 그 sinceMs를 직전에 저장해 둔 상태
// (previousState)의 sinceMs와 비교한다. sinceMs가 달라졌다는 것은 그
// 사이에 한 번은 정상으로 돌아왔다가 다시 열렸다는 뜻이므로 "새 전이"다.
// sinceMs가 같으면 "같은 이상이 계속되는 중"이므로 다시 통지하지 않는다
// (coder-task.md §7-(d) 반복 재통지 금지).
//
// ★이 설계는 호출 주기에 의존하지 않는다 -- 이 함수가 하루에 한 번만
// 불려도, 매 15분마다 불려도 같은 결과를 낸다(로그 자체가 "언제부터
// 열렸는지"의 유일한 증거이기 때문). 그래서 watch-run.mjs의 매 tick과
// 사람이 수동으로 --report를 돌리는 것 둘 다 안전하게 이 함수를 부를 수
// 있다.

// previousState: {[axisKey]: {sinceMs: number}} | null/undefined(첫 실행 --
// 상태 파일이 아직 없음, 빈 객체와 동일하게 취급).
// openAnomalies: reach-report-core.mjs의 computeOpenAnomalies(...) 반환값.
// 반환: {nextState, toNotify} -- toNotify는 "새로 열린" 이상들의 배열
// (openAnomalies의 원소 형태 그대로), 없으면 빈 배열.
export function decideNotifications({ previousState, openAnomalies }) {
  const prev =
    previousState && typeof previousState === "object" ? previousState : {};
  const openByAxis = new Map();
  for (const a of Array.isArray(openAnomalies) ? openAnomalies : []) {
    openByAxis.set(a.axisKey, a);
  }
  const nextState = {};
  const toNotify = [];
  for (const [axisKey, anomaly] of openByAxis) {
    const prevEntry = prev[axisKey];
    const isSameOngoingAnomaly =
      prevEntry &&
      typeof prevEntry.sinceMs === "number" &&
      prevEntry.sinceMs === anomaly.sinceMs;
    if (!isSameOngoingAnomaly) {
      toNotify.push(anomaly);
    }
    nextState[axisKey] = { sinceMs: anomaly.sinceMs };
  }
  // openByAxis에 없는(=지금은 정상인) axis는 nextState에서 그냥 빠진다 --
  // 다음 번에 다시 이상해지면 sinceMs가 새 값이라 자동으로 "새 전이"로
  // 판정된다(별도 "닫힘" 통지는 이 조각 범위 밖 -- coder-task.md §3 범위:
  // 알림 이외의 개입 0, 신규 통지 종류 추가는 최소화).
  return { nextState, toNotify };
}

function formatKstIsh(ms) {
  return new Date(ms).toISOString();
}

// 알림 파일 1장의 본문(coder-task.md §1 요건3-b "새 이상이 전이할 때
// 받는함에 파일 1장"). 이번 tick에서 새로 열린 이상이 여럿이어도 파일은
// 1장(묶어서 싣는다).
export function buildNoticeText({ toNotify, nowMs }) {
  const lines = [];
  lines.push(`# 예약 감시 이상 전이 통지 -- ${formatKstIsh(nowMs)}`);
  lines.push("");
  lines.push(
    "새로 열린 이상(반복 재통지 아님 -- 같은 이상이 계속되면 다시 오지 않습니다):",
  );
  lines.push("");
  for (const a of toNotify) {
    lines.push(
      `- **${a.label}** (${a.verdict ?? a.status}) -- ${formatKstIsh(a.sinceMs)}부터`,
    );
  }
  lines.push("");
  lines.push(
    "이 파일이 정본입니다. 계속 열려 있는지·언제부터인지는 아침 보고(morning-report.md)에서 다시 확인하십시오.",
  );
  return lines.join("\n") + "\n";
}

// 알림 파일명(파일명·형식은 이 조각이 정한다, coder-task.md §1 요건1
// 주석과 동일한 재량). UTC ISO를 그대로 쓴다 -- ⛔TZ 강제 금지(coder-task.md
// §6-6)라 로컬 KST 포맷을 이 코드가 계산하지 않는다.
export function buildNoticeFileName(nowMs) {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  return `reach-notify-${iso}.md`;
}
