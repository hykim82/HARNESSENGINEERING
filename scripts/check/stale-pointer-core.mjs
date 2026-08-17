// HYK-292 I3 (coder-task.md §3, §3-1) -- 문서 안에서 이미 끊긴 것으로
// 알려진 정본 포인터 문구를 찾는 순수 코어. I/O 0 -- 파일 내용은
// 호출부(stale-pointer-check.mjs)가 읽어서 넘긴다.
//
// PM 사람이 칠 명령(PM-r9.md I3)을 그대로 판정 로직으로 옮긴 것:
//   rg -n 'STATUS §8|STATUS\.md\(§1 슬롯·§4' <정책> <PHASE-HANDOFF> <통역 CLAUDE>
//   stale_pointer_hits=$($h.Count); if($h.Count){exit 1}
//
// ⚠️정직 한계: 아래 KNOWN_STALE_POINTER_PATTERNS는 PM-r9.md가 «이미
// 확인한» 끊긴 포인터 3종의 발췌 문구다 -- 미래에 새로 생기는 낡은
// 포인터를 이 목록이 자동으로 알아채지는 못한다(패턴은 사람이 보고서로
// 발견해서 추가해야 한다, 예산 숫자와 달리 이 값은 «판정 임계값»이
// 아니라 «알려진 결함의 서명»이라 S-5(HYK-193) 적용 대상이 아니다).
export const KNOWN_STALE_POINTER_PATTERNS = Object.freeze([
  Object.freeze({ label: "STATUS §8", pattern: "STATUS §8" }),
  Object.freeze({
    label: "STATUS.md(§1 슬롯·§4",
    pattern: "STATUS\\.md\\(§1 슬롯·§4",
  }),
]);

function toRegExp(patternSpec) {
  return new RegExp(patternSpec.pattern, "g");
}

// findStalePointerHits(files, patterns) -> [{path, lineNumber, line, label}]
// files: [{path, content}]. 파일마다 줄 단위로 나눠 각 패턴을 검사한다
// (rg -n과 같은 관측 단위 -- 파일:줄 좌표가 남아야 사람이 바로 고칠 수
// 있다).
export function findStalePointerHits(
  files,
  patterns = KNOWN_STALE_POINTER_PATTERNS,
) {
  const hits = [];
  for (const file of files) {
    const lines = (file.content ?? "").replace(/\r\n/g, "\n").split("\n");
    lines.forEach((line, idx) => {
      for (const patternSpec of patterns) {
        if (toRegExp(patternSpec).test(line)) {
          hits.push({
            path: file.path,
            lineNumber: idx + 1,
            line,
            label: patternSpec.label,
          });
        }
      }
    });
  }
  return hits;
}

// checkStalePointers({files, patterns}) -> {ok, hits, staleHits}
// fail-closed 방향: hits.length > 0 -> ok:false(끊긴 포인터가 있으면
// 통과시키지 않는다). 파일이 0개인 경우는 이 함수의 관심사가 아니다
// (호출부가 대상 파일 목록을 못 찾았을 때 별도로 다뤄야 한다 --
// "검사할 게 없으니 통과"가 아니라 "무엇을 검사했는지"를 CLI 계층이
// 출력해야 함).
export function checkStalePointers({
  files,
  patterns = KNOWN_STALE_POINTER_PATTERNS,
}) {
  const hits = findStalePointerHits(files, patterns);
  return { ok: hits.length === 0, hits, staleHits: hits.length };
}
