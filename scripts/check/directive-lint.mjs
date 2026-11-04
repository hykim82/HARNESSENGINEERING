// HYK-488-directive-lint-1 (coder-task.md §1): H20 1R 실사고(작성자가 금지
// 줄의 앞 조각만 읽고 뒤에 낀 다른 금지를 못 읽어, env=1 단독 전수 스윕을
// 1회 실행) 재발 방지 -- 지시서 "머리"(첫 '---' 단독 줄 앞) 안에서 ⑴ 금지
// 키가 다른 금지·다른 키와 한 줄에 뭉쳐 있거나 ⑵ 생성기가 선언한 잔재
// 문자열이 그 키 줄 밖으로 샜거나 ⑶ 머리 값 안의 시각이 파일보다 미래이면
// 배달 전에 거부한다. 판정 원문(받는함 2026-11-02-0853 답, 판정 1/2/3)을
// 그대로 코드로 옮긴 것뿐, 이 판정 문면 밖으로 금지 키 정의를 넓히거나
// 좁히지 않는다(coder-task.md deviation_rule).
//
// S8: zero I/O -- 파일을 스스로 읽지 않는다. caller(dispatch-gate-
// decision.mjs)가 이미 읽어낸 텍스트와 mtime만 받는다(checkHeadCommit
// Precondition/checkOneBPrecondition과 같은 이 저장소의 기존 관례).

const KEY_TOKEN_RE = /(^|·\s)([a-z][a-z0-9_]*):/g;
const TIMESTAMP_RE = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/g;
const BAN_MARK = "⛔";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function findKeyTokens(line) {
  const tokens = [];
  const re = new RegExp(KEY_TOKEN_RE);
  let m;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[2]);
  }
  return tokens;
}

function isBanKey(key) {
  return key.endsWith("_ban") || key === "load_repro_rule";
}

// 판정 1(ⓘ): 금지 키(이름이 `_ban`으로 끝나는 키 + `load_repro_rule`) 줄에
// ⛔가 2개 이상이거나, 같은 줄에 다른 "키:" 모양(` · <소문자_키>: `)이 끼어
// 있으면 거부 -- 둘 중 하나만 성립해도 거부(OR).
function checkCombinedBanLines(headerLines, reasons) {
  headerLines.forEach((line) => {
    const tokens = findKeyTokens(line);
    if (tokens.length === 0) return;
    const banTokens = tokens.filter(isBanKey);
    if (banTokens.length === 0) return;
    const banMarkCount = (line.match(new RegExp(BAN_MARK, "g")) || []).length;
    const hasEmbeddedOtherKey = tokens.length >= 2;
    if (banMarkCount >= 2 || hasEmbeddedOtherKey) {
      reasons.push(
        `directive-lint: ⓘ 금지 키 결합 줄 -- key=${banTokens[0]}, line="${line.slice(0, 80)}"`,
      );
    }
  });
}

// 판정 2(ⓘⓘ): 머리에 `remnant_forbid:` 키가 있으면 그 값(` | ` 구분)의
// 문자열이 "그 키 줄 밖" 어디든(머리·본문 불문) 있으면 거부. 키가 없으면
// 통과(정직 한계: 생성기가 안 적으면 못 잡는다).
function checkRemnantForbid(rawLines, headerEndIndex, reasons) {
  const headerLines =
    headerEndIndex === -1 ? rawLines : rawLines.slice(0, headerEndIndex);
  const remnantIdx = headerLines.findIndex((l) =>
    /^remnant_forbid:\s*/.test(l),
  );
  if (remnantIdx === -1) return;
  const remnantLine = rawLines[remnantIdx];
  const value = remnantLine.replace(/^remnant_forbid:\s*/, "");
  const forbidden = value
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  forbidden.forEach((token) => {
    for (let i = 0; i < rawLines.length; i += 1) {
      if (i === remnantIdx) continue;
      if (rawLines[i].includes(token)) {
        reasons.push(
          `directive-lint: ⓘⓘ remnant_forbid 잔재 -- key=${token}, line="${rawLines[i].slice(0, 80)}"`,
        );
        return;
      }
    }
  });
}

// 판정 3(ⓘⓘⓘ): 머리 키 값 안의 `YYYY-MM-DD HH:MM` 시각(KST로 해석)이 파일
// mtime보다 미래면 거부. mtimeMs가 없으면(caller가 안 넘겼으면) 판정 불가로
// 보고 건너뛴다(S8 -- 이 함수는 파일을 스스로 stat하지 않는다).
function checkFutureTimestamp(headerLines, mtimeMs, reasons) {
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return;
  headerLines.forEach((line) => {
    const re = new RegExp(TIMESTAMP_RE);
    let m;
    while ((m = re.exec(line)) !== null) {
      const [, y, mo, d, hh, mi] = m;
      const utcMs =
        Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi)) -
        KST_OFFSET_MS;
      if (utcMs > mtimeMs) {
        reasons.push(
          `directive-lint: ⓘⓘⓘ 미래 시각 -- key=${m[0]}, line="${line.slice(0, 80)}"`,
        );
      }
    }
  });
}

// 판정 4(ⓘⓘⓘⓘ, HYK-424/HYK-488): 머리의 `role:` 값이 CODER면 `head_commit:`
// 키를 거부한다. 레거시로 "이 라운드의 base"를 뜻하던 그 키가 CODER
// 지시서 머리에 다시 실리면, 작업자가 결과 파일의 head_commit에 그 값을
// 그대로 베껴 쓰는 사고(HYK-424 원 사고, 419-wire-2/422-dispatch-run-1)가
// 재발할 수 있다. 정식 표기는 `base_commit_of_this_round:`(relay-
// handshake.mjs의 resolveBaseCopyGuard가 읽는 키, HYK-424). REVIEW
// 지시서의 `head_commit:`은 "판정 대상 커밋"이라는 다른 뜻(HYK-383
// resolveHeadCommitBinding 축 ⓐ)이라 그대로 허용한다. 머리에 `role:`
// 줄이 없으면(또는 CODER가 아니면) 이 축은 건너뛴다(fail-open -- 판정
// 1/2/3과 같은 관례, ⓘⓘ-neg-no-key 참조).
const ROLE_VALUE_RE = /(^|·\s)role:\s*(\S+)/;

function findHeaderRole(headerLines) {
  for (const line of headerLines) {
    const m = line.match(ROLE_VALUE_RE);
    if (m) return m[2];
  }
  return null;
}

function checkCoderHeadCommitHeader(headerLines, reasons) {
  const roleValue = findHeaderRole(headerLines);
  if (!roleValue || !/^coder/i.test(roleValue)) return;
  const offendingLine = headerLines.find((line) =>
    findKeyTokens(line).includes("head_commit"),
  );
  if (offendingLine) {
    reasons.push(
      `directive-lint: ⓘⓘⓘⓘ CODER 지시서 머리에 head_commit: 키(레거시 base 표기, HYK-424) -- 정식은 base_commit_of_this_round:, line="${offendingLine.slice(0, 80)}"`,
    );
  }
}

// 머리 = 첫 '---' 단독 줄(좌우 공백 제거 후 정확히 '---') 앞 전체. '---'
// 줄이 없으면 파일 전체를 머리로 본다.
export function lintDirective(text, { mtimeMs } = {}) {
  const reasons = [];
  const rawLines = String(text ?? "").split(/\r?\n/);
  const headerEndIndex = rawLines.findIndex((l) => l.trim() === "---");
  const headerLines =
    headerEndIndex === -1 ? rawLines : rawLines.slice(0, headerEndIndex);

  checkCombinedBanLines(headerLines, reasons);
  checkRemnantForbid(rawLines, headerEndIndex, reasons);
  checkFutureTimestamp(headerLines, mtimeMs, reasons);
  checkCoderHeadCommitHeader(headerLines, reasons);

  return { ok: reasons.length === 0, reasons };
}
