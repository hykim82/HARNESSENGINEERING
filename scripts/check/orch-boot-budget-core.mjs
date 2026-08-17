// HYK-292 I2 (coder-task.md §3, §3-1 요건 4) -- ORCH 부팅 필독 집합의
// 바이트 합이 커밋된 예산(docs-budget-config.json의
// orch_boot_budget_bytes)을 넘지 않는지 판정하는 순수 코어. I/O 0 --
// 각 파일의 바이트 크기는 호출부(orch-boot-budget-check.mjs)가 넘긴다.
//
// 4R (coder-task.md §1·§2 -- 책임자가 ORCH 부팅 필독 집합의 정본을
// `relay-terminal-setup.md` §1.5 = 2파일로 확정) -- 2R이 만든 "번호
// 목록에서 유도" 방식은 유도 원천을 `통역\CLAUDE.md`로 잡았는데, 그
// 문서는 책임자 자신의 부팅 절차이지 ORCH 예산 대상이 아니다(1-1).
// ORCH가 계약 문서(`relay-terminal-setup.md`) 안에 기계 판독 표식
// `<!-- orch-boot-set: PHASE-HANDOFF.md, STATUS.md -->`을 산문 바로
// 아래에 추가했으므로(원문 한 글자도 안 바꿈), 이 코어는 이제 그
// 표식 블록 하나만 읽는다 -- 부팅줄 산문은 더 이상 파싱하지 않는다
// (요건 1 -- "부팅줄 산문을 파싱하지 마라. 표식 블록만 본다").
//
// 무엇을 항목으로 인정하는가: `<!-- orch-boot-set: ... -->` 주석 안의
// 콤마로 구분된 파일명 목록을 그대로 집합으로 쓴다(경로 조작·필터링
// 없음 -- 표식 자체가 이미 사람이 확정한 필독 집합이다).
//
// fail-closed(요건 2): 표식이 하나도 없거나, 있어도 파일명이 0개면
// 실패로 보고한다(reason: "no_marker" | "empty_marker") -- 손으로
// "두 파일만 쓴다"로 조용히 축소하지 않는다.
//
// 표식이 둘 이상이면 거부(요건 3): 어느 것이 정본인지 결정할 수
// 없으므로 조용히 첫 번째를 고르지 않고 실패로 보고한다
// (reason: "multiple_markers") -- 저장소의 기존 "표지 2개면 멈춘다"
// 원칙과 같은 축.
//
// ⚠️정직 한계(요건 5의 반대편 -- 이 방식이 못 막는 것) -- 표식과
// 그 위 부팅줄 산문이 어긋나도(예: 산문은 3파일을 말하는데 표식은
// 2파일만 나열) 이 코어는 표식만 신뢰하고 산문과 대조하지 않는다.
// 표식·산문 동기화는 "목록 변경 시 두 곳을 함께 고칠 것"이라는
// 표식 옆 주석의 사람 규약에 의존한다 -- 기계가 그 어긋남을 잡지
// 않는다.
const ORCH_BOOT_SET_MARKER_RE = /<!--\s*orch-boot-set:\s*(.*?)\s*-->/g;

// findOrchBootSetMarkers(charterText) -> [<raw comma list>, ...]
// (문서 안에서 발견된 표식마다 주석 안 원문 목록 문자열 하나씩)
export function findOrchBootSetMarkers(charterText) {
  const re = new RegExp(
    ORCH_BOOT_SET_MARKER_RE.source,
    ORCH_BOOT_SET_MARKER_RE.flags,
  );
  const matches = [];
  let m;
  while ((m = re.exec(charterText ?? "")) !== null) {
    matches.push(m[1]);
  }
  return matches;
}

// parseOrchBootSetList(rawList) -> [<basename>, ...] (콤마 분리, 트림,
// 빈 항목 제외)
export function parseOrchBootSetList(rawList) {
  return (rawList ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// deriveOrchBootManifest(charterDocs) ->
//   {ok:true, files, sources} |
//   {ok:false, reason:"no_marker"|"empty_marker"|"multiple_markers", markerCount?}
//
// charterDocs: [{path, text}, ...] -- 호출부가 계약 문서 경로에서 읽어
// 넘긴다(경로는 CLI 인자로 주입되고 이 코어엔 하드코딩 0). 여러 문서를
// 넘겨도 표식은 전체를 통틀어 정확히 하나여야 한다(요건 3).
export function deriveOrchBootManifest(charterDocs) {
  let markerCount = 0;
  let singleMarkerDoc = null;
  let singleMarkerRaw = null;

  for (const doc of charterDocs ?? []) {
    const markers = findOrchBootSetMarkers(doc.text);
    markerCount += markers.length;
    if (markers.length > 0) {
      singleMarkerDoc = doc;
      singleMarkerRaw = markers[0];
    }
  }

  if (markerCount === 0) {
    return { ok: false, reason: "no_marker" };
  }
  if (markerCount > 1) {
    return { ok: false, reason: "multiple_markers", markerCount };
  }

  const basenames = parseOrchBootSetList(singleMarkerRaw);
  if (basenames.length === 0) {
    return { ok: false, reason: "empty_marker" };
  }

  return {
    ok: true,
    files: basenames.map((basename) => ({
      basename,
      source: singleMarkerDoc.path,
    })),
    sources: [{ path: singleMarkerDoc.path, count: basenames.length }],
  };
}

// checkOrchBootBudget({fileSizes, orchBootBudgetBytes}) ->
//   {ok, totalBytes, files, reasons}
//
// fileSizes: [{basename, bytes}] -- 호출부가 deriveOrchBootManifest로
// 얻은 basename마다 실제 바이트 크기를 재서 넘긴다.
export function checkOrchBootBudget({ fileSizes, orchBootBudgetBytes }) {
  const totalBytes = fileSizes.reduce((sum, f) => sum + f.bytes, 0);
  const reasons = [];
  if (totalBytes > orchBootBudgetBytes) {
    reasons.push(
      `orch-boot-budget: ORCH_BOOT_BYTES=${totalBytes}가 예산 ${orchBootBudgetBytes}를 초과함`,
    );
  }
  return { ok: reasons.length === 0, totalBytes, files: fileSizes, reasons };
}
