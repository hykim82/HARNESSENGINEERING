import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

// HYK-229 1R: 아카이브 판정 코어 -- «옮기는 기능」이 아니라 «옮기면 안 될
// 때 안 옮기는 기능」이 이 이슈의 존재 이유다(§0). 이번 라운드는 합성
// 픽스처(mkdtemp)로만 검증한다 -- 실제 관제실 파일은 이 모듈이 건드리지
// 않는다(그건 HYK-230).
//
// ---------------------------------------------------------------------------
// CORE (pure judgment, I/O 0) -- hook-sync-check.mjs와 같은 관례: 모든
// 입력은 호출자가 값으로 주입한다(경로/읽기함수를 이 구간에 두지 않는다).
// I/O(파일 이동·해시 계산)는 아래 별도 구간에 둔다.
// ---------------------------------------------------------------------------

// PM 정직 한계(§3): N일 값·보존 기간·「활성 참조」 정본은 이 트랙이 정하지
// 않는다. 호출자가 minAgeMs를 넘기지 않으면 나이 조건은 항상 거짓이 되어
// 아무것도 "오래됨"으로 판정되지 않는다 -- 기본값은 "아무것도 안 옮김".
const DEFAULT_MIN_AGE_MS = Infinity;

// candidate: { path, sizeBytes, mtimeMs, locked }
// opts: {
//   whitelist?: Set<string> | string[],
//   runningArgs?: string[],           -- 실행 중 프로세스 인자 목록(문자열)
//   referenceTexts?: string[],        -- STATUS/태스크/받는함/발행절차 원문
//   now: number,                      -- 판정 기준 시각(ms epoch)
//   minAgeMs?: number,                -- 기본값 Infinity(=절대 오래됨 아님)
// }
// §1-2의 세 배제 사유(ⓐⓑⓒ) + 화이트리스트를, 순서대로 평가되는 규칙
// 목록으로 표현한다 -- judgeCandidate 자체의 분기 복잡도를 낮게 유지하고,
// "어느 사유가 먼저 걸리는지"를 이 배열 순서만 보고 알 수 있게 한다.
const EXCLUSION_RULES = [
  {
    reason: "whitelist",
    hit: (candidate, ctx) => ctx.whitelistSet.has(candidate.path),
  },
  {
    reason: "locked",
    hit: (candidate) => Boolean(candidate.locked),
  },
  {
    reason: "running-arg-reference",
    hit: (candidate, ctx) =>
      ctx.runningArgs.some((arg) => arg.includes(candidate.path)),
  },
  {
    reason: "active-reference",
    hit: (candidate, ctx) =>
      ctx.referenceTexts.some((text) => text.includes(candidate.path)),
  },
];

export function judgeCandidate(candidate, opts) {
  const {
    whitelist = new Set(),
    runningArgs = [],
    referenceTexts = [],
    now,
    minAgeMs = DEFAULT_MIN_AGE_MS,
  } = opts;
  if (now === undefined || now === null) {
    throw new Error("judgeCandidate: opts.now is required");
  }

  const ctx = {
    whitelistSet: whitelist instanceof Set ? whitelist : new Set(whitelist),
    runningArgs,
    referenceTexts,
  };

  const excluded = EXCLUSION_RULES.find((rule) => rule.hit(candidate, ctx));
  if (excluded) {
    return { eligible: false, reason: excluded.reason };
  }

  const ageMs = now - candidate.mtimeMs;
  if (!(ageMs >= minAgeMs)) {
    // NaN(잘못된 mtimeMs)도 이 비교에서 false가 되어 안전측(이동 금지)으로 떨어진다.
    return { eligible: false, reason: "too-recent" };
  }

  return { eligible: true, reason: "eligible" };
}

// 정확히 한 정본만 남아야 한다(§2-4): source/dest 중 하나만 존재해야 함.
// existsFn은 순수성을 지키기 위해 주입받는다(기본은 아래 I/O 구간의 실제 existsSync).
export function exactlyOneCopyInvariant(entry, existsFn) {
  const sourceExists = existsFn(entry.sourcePath);
  const destExists = entry.destPath ? existsFn(entry.destPath) : false;
  return sourceExists !== destExists;
}

// ---------------------------------------------------------------------------
// I/O (파일 해시·이동) -- CORE 구간의 순수 판정 결과를 받아 실제로 옮긴다.
// ---------------------------------------------------------------------------

export function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// 매니페스트 필수 항목(PM 지정, §1): 원본 경로 · 목적지 · 크기 · mtime ·
// SHA-256 · 선정 사유 · 활성 참조 판정. destPathFor(candidate)는 판정이
// eligible일 때만 호출된다(비대상 파일은 목적지를 계산할 이유가 없다).
export function buildManifest(candidates, destPathFor, opts) {
  return candidates.map((candidate) => {
    const judgement = judgeCandidate(candidate, opts);
    const stat = statSync(candidate.path);
    return {
      sourcePath: candidate.path,
      destPath: judgement.eligible ? destPathFor(candidate) : null,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: judgement.eligible ? sha256OfFile(candidate.path) : null,
      reason: judgement.reason,
      eligible: judgement.eligible,
    };
  });
}

// 세 단계로 쪼갠다(§1-4의 "매니페스트 선행 생성 -> SHA-256 대조 -> 이동 ->
// 재대조"를 각각 독립 함수로) -- executeManifestEntry가 정상 경로에서
// 순서대로 호출하지만, 시험은 이동과 재대조 «사이» 지점에 직접 결함을
// 주입하기 위해 이 함수들을 개별 호출할 수 있어야 한다(§2-3, RED->GREEN
// 왕복을 실제 rollback 코드 경로로 실증하려면 필요).
export function verifyPreMove(entry) {
  if (!existsSync(entry.sourcePath)) {
    return { ok: false, detail: "source-missing" };
  }
  if (existsSync(entry.destPath)) {
    return { ok: false, detail: "dest-conflict" };
  }
  const preHash = sha256OfFile(entry.sourcePath);
  if (preHash !== entry.sha256) {
    return { ok: false, detail: "hash-mismatch-pre-move" };
  }
  return { ok: true };
}

export function performMove(entry) {
  mkdirSync(dirname(entry.destPath), { recursive: true });
  renameSync(entry.sourcePath, entry.destPath);
}

// 이동 직후 재대조 -- 불일치 시 즉시 파일 단위 원복(§1-5)한다. 원복은
// destPath를 sourcePath로 되돌리는 것뿐이다(그 시점의 destPath 바이트가
// 무엇이든 그대로 되돌려 "정확히 한 정본"(§2-4) 불변식은 지키되, 손상된
// 바이트 자체를 복구하지는 않는다 -- 손상의 원인 수정은 이 모듈의 책임
// 밖이다).
export function verifyPostMoveOrRollback(entry) {
  let postHash;
  try {
    postHash = sha256OfFile(entry.destPath);
  } catch (err) {
    rollbackSingleMove(entry);
    return { ok: false, detail: `post-verify-error:${err.message}` };
  }
  if (postHash !== entry.sha256) {
    rollbackSingleMove(entry);
    return { ok: false, detail: "hash-mismatch-post-move" };
  }
  return { ok: true };
}

function rollbackSingleMove(entry) {
  if (existsSync(entry.destPath) && !existsSync(entry.sourcePath)) {
    renameSync(entry.destPath, entry.sourcePath);
  }
}

// 단일 항목 이동: 매니페스트 선행 생성 -> SHA-256 대조 -> 이동 -> 재대조
// (§1-4). 실패하면 그 파일은 원본에 그대로 남는다(원자적 rename 실패 시
// 목적지에 부분 산출물을 남기지 않으며, 이동 후 해시 불일치가 나면
// 즉시 원복한다) -- 이것이 "부분 실패 시 파일 단위 원복"(§1-5)이다.
export function executeManifestEntry(entry) {
  if (!entry.eligible) {
    return { ...entry, status: "skipped", detail: entry.reason };
  }

  const pre = verifyPreMove(entry);
  if (!pre.ok) {
    return { ...entry, status: "failed", detail: pre.detail };
  }

  try {
    performMove(entry);
  } catch (err) {
    return { ...entry, status: "failed", detail: `move-error:${err.message}` };
  }

  const post = verifyPostMoveOrRollback(entry);
  if (!post.ok) {
    return { ...entry, status: "failed", detail: post.detail };
  }

  return { ...entry, status: "moved" };
}

// 배치 실행: 각 항목은 독립적으로 처리된다(§1-5, "파일 단위" 원복) -- 한
// 항목의 실패가 이미 성공한 다른 항목들을 되돌리지 않는다.
export function executeManifest(manifest) {
  return manifest.map((entry) => executeManifestEntry(entry));
}
