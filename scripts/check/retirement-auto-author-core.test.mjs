// HYK-419-retire-author-1/2 -- tests for retirement-auto-author-core.mjs's
// evaluateAutoAuthorAuthorization.
//
// ★2R (검토 P1-1 반영): 1R의 앵커 검사는 "문자열이 비어 있지 않은가"만
// 봤다 -- 검토가 정상 OPEN facts에 `ownTaskArchivePath:
// "rounds/DOES-NOT-EXIST.md"` / `ownTaskArchiveFingerprint:
// "FORGED-FINGERPRINT"` / `recordedAt: "not-a-time"` /
// `successorLabelForRecord: "../../not-a-real-successor"`를 주입해
// AUTHORIZED_DRAFT를 뽑아냈다(원문 그대로 재현, 아래 "★검토 원문 재현"
// 절). 이 파일은 그 네 값을 문자 그대로 시험에 박고, 각각 구별되는 사유
// 코드로 거부되는지 고정한다 + 정상 경로(진짜 파일 + 진짜 지문 + 진짜
// 시각) 회귀 0 + 되돌림 변이 8건(문서 숫자와 일치).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateAutoAuthorAuthorization,
  AUTO_AUTHOR_STATE,
  HUMAN_REQUIRED_FIELDS,
} from "./retirement-auto-author-core.mjs";
import { NEVER_CONSUMED_RETIRE_STATE } from "./hyk412-never-consumed-retire-core.mjs";
import {
  checkRetirementRecord,
  RETIREMENT_RECORD_STATE,
} from "./retirement-record-core.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = join(CHECK_DIR, "retirement-auto-author-core.mjs");

test("retirement-auto-author-core.mjs imports exactly node:fs/node:crypto/node:path + the hyk412 gate core (2R: real verification needs real I/O, no more)", () => {
  const text = readFileSync(CORE_PATH, "utf8");
  const specifiers = [
    ...text.matchAll(/^import\s+[\s\S]*?\s+from\s+"([^"]+)";/gm),
  ].map((m) => m[1]);
  assert.deepEqual(specifiers, [
    "node:fs",
    "node:crypto",
    "node:path",
    "./hyk412-never-consumed-retire-core.mjs",
  ]);
});

function tmpHarnessDir() {
  return mkdtempSync(join(tmpdir(), "hyk419-auto-author-"));
}

function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

// 실제 archive 파일을 harnessDir 밑에 실제로 써 놓고, 그 실제 내용의 진짜
// 지문을 계산해 돌려준다 -- "정상 경로" 표본은 전부 이 함수로 만든다(문서
// 완료조건 §2⑷ "진짜 아카이브 파일 + 진짜 지문 + 진짜 시각").
function writeRealArchive(harnessDir, relPath, content) {
  const full = join(harnessDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return sha256Hex(content);
}

const REAL_ARCHIVE_REL_PATH = "rounds/coder-task-r1.md";
const REAL_ARCHIVE_CONTENT = "task_id: HYK-999-never-touched-1\n";
// 확실히 과거인 시각(테스트 실행 시점의 실제 시계와 무관하게 항상 과거).
const PAST_RECORDED_AT = "2020-01-01 00:00:00 KST";

function openFacts(harnessDir, fingerprint, overrides = {}) {
  return {
    role: "CODER",
    harnessTaskLabel: "HYK-999-never-touched-1",
    ledgerReservation: {
      exists: true,
      harnessTaskLabel: "HYK-999-never-touched-1",
      status: "ACTIVE",
      completedAt: null,
    },
    dispatchReceiptMatchCount: 1,
    resultArchiveExists: false,
    ownTaskArchiveExists: true,
    hasLaterRoundArchive: false,
    staleEnoughSinceAdmission: true,
    successorLabelForRecord: "HYK-999-never-touched-2",
    harnessDir,
    ownTaskArchivePath: REAL_ARCHIVE_REL_PATH,
    ownTaskArchiveFingerprint: fingerprint,
    recordedAt: PAST_RECORDED_AT,
    ...overrides,
  };
}

function withHarness(fn) {
  const harnessDir = tmpHarnessDir();
  try {
    const fingerprint = writeRealArchive(
      harnessDir,
      REAL_ARCHIVE_REL_PATH,
      REAL_ARCHIVE_CONTENT,
    );
    return fn(harnessDir, fingerprint);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. 게이트 재사용 (1R 회귀 유지)
// ---------------------------------------------------------------------------

test("CLOSED: hyk412 게이트가 LEDGER_RECORD_MISSING이면 -> GATE_CLOSED, gateState 그대로 전달", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { ledgerReservation: { exists: false } }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.GATE_CLOSED);
    assert.equal(r.ok, false);
    assert.equal(
      r.gateState,
      NEVER_CONSUMED_RETIRE_STATE.LEDGER_RECORD_MISSING,
    );
  });
});

test("CLOSED: hyk412 게이트가 SUCCESSOR_ROUND_EXISTS(case B)이면 -> GATE_CLOSED", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { hasLaterRoundArchive: true }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.GATE_CLOSED);
    assert.equal(
      r.gateState,
      NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_ROUND_EXISTS,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. ★검토 원문 재현 -- 네 값을 문자 그대로 주입, 각각 구별되는 사유 코드.
// ---------------------------------------------------------------------------

test("★검토 원문 재현 ⓐ: ownTaskArchivePath='rounds/DOES-NOT-EXIST.md' -> ARCHIVE_PATH_NOT_FOUND (초안 만들어지지 않음)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, {
        ownTaskArchivePath: "rounds/DOES-NOT-EXIST.md",
      }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.ARCHIVE_PATH_NOT_FOUND);
    assert.equal(r.ok, false);
    assert.equal(r.draftRecord, undefined);
  });
});

test("★검토 원문 재현 ⓑ: ownTaskArchiveFingerprint='FORGED-FINGERPRINT' -> FINGERPRINT_INVALID (초안 만들어지지 않음)", () => {
  withHarness((harnessDir) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, "FORGED-FINGERPRINT"),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.FINGERPRINT_INVALID);
    assert.equal(r.ok, false);
    assert.equal(r.draftRecord, undefined);
  });
});

test("★검토 원문 재현 ⓒ: recordedAt='not-a-time' -> RECORDED_AT_INVALID (초안 만들어지지 않음)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { recordedAt: "not-a-time" }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.RECORDED_AT_INVALID);
    assert.equal(r.ok, false);
    assert.equal(r.draftRecord, undefined);
  });
});

test("★검토 원문 재현 ⓓ: successorLabelForRecord='../../not-a-real-successor' -> SUCCESSOR_LABEL_GRAMMAR_INVALID (초안 만들어지지 않음)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, {
        successorLabelForRecord: "../../not-a-real-successor",
      }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.SUCCESSOR_LABEL_GRAMMAR_INVALID);
    assert.equal(r.ok, false);
    assert.equal(r.draftRecord, undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. 실물 검증 세부 -- 각 관문별 추가 표본.
// ---------------------------------------------------------------------------

test("ARCHIVE_PATH_TRAVERSAL: ownTaskArchivePath가 '..' 세그먼트를 포함하면 파일시스템에 닿기 전에 거부", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, {
        ownTaskArchivePath: "../outside/escape.md",
      }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.ARCHIVE_PATH_TRAVERSAL);
  });
});

test("ARCHIVE_PATH_TRAVERSAL: 절대경로/드라이브 표기도 거부(윈도우 드라이브 표기 포함)", () => {
  withHarness((harnessDir, fp) => {
    const r1 = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { ownTaskArchivePath: "/etc/passwd" }),
    );
    assert.equal(r1.state, AUTO_AUTHOR_STATE.ARCHIVE_PATH_TRAVERSAL);
    const r2 = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, {
        ownTaskArchivePath: "C:\\Windows\\System32\\config",
      }),
    );
    assert.equal(r2.state, AUTO_AUTHOR_STATE.ARCHIVE_PATH_TRAVERSAL);
  });
});

test("FINGERPRINT_INVALID: 형식은 맞지만(소문자 hex 64자) 실제 파일과 다른 지문은 거부(문자열 비교가 아니라 실제로 다시 해싱)", () => {
  withHarness((harnessDir) => {
    const wrongButWellFormed = "0".repeat(64);
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, wrongButWellFormed),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.FINGERPRINT_INVALID);
    assert.match(r.reason, /다시 해싱한 값/);
  });
});

test("FINGERPRINT_INVALID: 대문자 hex(형식 다름)도 거부(이 코어의 해시 출력 형식은 소문자로 고정)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp.toUpperCase()),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.FINGERPRINT_INVALID);
  });
});

test("ARCHIVE_UNREADABLE: 파일은 존재하지만 읽기 자체가 실패하면(주입된 seam) 별도 사유로 거부", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(openFacts(harnessDir, fp), {
      readFileFn: () => {
        throw new Error("synthetic read failure");
      },
    });
    assert.equal(r.state, AUTO_AUTHOR_STATE.ARCHIVE_UNREADABLE);
    assert.match(r.reason, /synthetic read failure/);
  });
});

test("RECORDED_AT_INVALID: 존재하지 않는 달력 날짜(2026-02-30)도 거부(정규식만으로는 못 잡는 값)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { recordedAt: "2026-02-30 10:00:00 KST" }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.RECORDED_AT_INVALID);
  });
});

test("RECORDED_AT_INVALID: 미래 시각은 형식이 멀쩡해도 거부", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { recordedAt: "2099-01-01 00:00:00 KST" }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.RECORDED_AT_INVALID);
    assert.match(r.reason, /미래 시각/);
  });
});

test("SUCCESSOR_LABEL_GRAMMAR_INVALID: 라벨 문법을 벗어나는 다른 형태(슬래시 포함)도 거부", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, {
        successorLabelForRecord: "HYK-1/../2",
      }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.SUCCESSOR_LABEL_GRAMMAR_INVALID);
  });
});

// ---------------------------------------------------------------------------
// 4. §2⑶ 미열거 기본값 = 닫힘 -- 타입 뒤섞기·null·객체.
// ---------------------------------------------------------------------------

for (const [field, weirdValue] of [
  ["harnessDir", 12345],
  ["harnessDir", null],
  ["harnessDir", {}],
  ["ownTaskArchivePath", 12345],
  ["ownTaskArchivePath", null],
  ["ownTaskArchivePath", {}],
  ["ownTaskArchiveFingerprint", 12345],
  ["ownTaskArchiveFingerprint", null],
  ["ownTaskArchiveFingerprint", {}],
  ["recordedAt", 12345],
  ["recordedAt", null],
  ["recordedAt", {}],
]) {
  test(`CLOSED(타입 위조): ${field}=${JSON.stringify(weirdValue)} -> 안전측 거부(진짜 값이 아니면 어떤 타입도 통과하지 못한다)`, () => {
    withHarness((harnessDir, fp) => {
      const r = evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, { [field]: weirdValue }),
      );
      assert.notEqual(r.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
      assert.equal(r.ok, false);
    });
  });
}

test("CLOSED(타입 위조): successorLabelForRecord가 숫자/객체면 hyk412 게이트 자체가 먼저 닫는다(SUCCESSOR_LABEL_MISSING, isNonEmptyString 실패)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { successorLabelForRecord: 12345 }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.GATE_CLOSED);
    assert.equal(
      r.gateState,
      NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_LABEL_MISSING,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 정상 경로 회귀 0 -- 진짜 아카이브 파일 + 진짜 지문 + 진짜 시각.
// ---------------------------------------------------------------------------

test("GREEN(완료조건 §2⑷ 정상 경로 회귀 0): 진짜 파일 + 진짜 SHA-256 + 과거 KST 시각 + 문법에 맞는 후속 이름표 -> AUTHORIZED_DRAFT", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(openFacts(harnessDir, fp));
    assert.equal(r.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
    assert.equal(r.ok, true);
    assert.equal(r.draftRecord.archivePath, REAL_ARCHIVE_REL_PATH);
    assert.equal(r.draftRecord.archiveFingerprintClaimed, fp);
    assert.equal(r.draftRecord.blockReasonCode, null);
    assert.deepEqual([...r.humanRequiredFields], ["blockReasonCode"]);
    assert.deepEqual(r.humanRequiredFields, HUMAN_REQUIRED_FIELDS);
  });
});

test("GREEN: 후속 이름표가 슬러그 없이 'HYK-<숫자>' 단독이어도 문법상 허용(과차단 방지)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { successorLabelForRecord: "HYK-1000" }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
  });
});

// ---------------------------------------------------------------------------
// 6. blockReasonCode 구조적 닫힘 + 통합 시험 (1R 회귀 유지)
// ---------------------------------------------------------------------------

test("GREEN: facts에 blockReasonCode를 위조해 넣어도 draftRecord.blockReasonCode는 항상 null", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, {
        blockReasonCode: "DONE_TIMESTAMP_NOT_PARSEABLE",
      }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
    assert.equal(r.draftRecord.blockReasonCode, null);
  });
});

test("통합: AUTHORIZED_DRAFT의 draftRecord를 checkRetirementRecord에 넣으면 INVALID_REASON_CODE로 거부됨", () => {
  withHarness((harnessDir, fp) => {
    const auto = evaluateAutoAuthorAuthorization(openFacts(harnessDir, fp));
    assert.equal(auto.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
    const verdict = checkRetirementRecord({
      role: auto.draftRecord.role,
      harnessTaskLabel: auto.draftRecord.harnessTaskLabel,
      candidates: [
        {
          record: auto.draftRecord,
          archiveExists: true,
          archiveFingerprintMatches: true,
          liveFingerprintMatches: null,
          blockReasonConfirmed: null,
        },
      ],
    });
    assert.equal(verdict.state, RETIREMENT_RECORD_STATE.INVALID_REASON_CODE);
  });
});

test("통합: 사람이 blockReasonCode를 채우면 구조적으로 RETIRED까지 통과할 수 있다", () => {
  withHarness((harnessDir, fp) => {
    const auto = evaluateAutoAuthorAuthorization(openFacts(harnessDir, fp));
    const humanFilled = {
      ...auto.draftRecord,
      blockReasonCode: "DONE_REWRITE_LOCKED",
    };
    const verdict = checkRetirementRecord({
      role: humanFilled.role,
      harnessTaskLabel: humanFilled.harnessTaskLabel,
      candidates: [
        {
          record: humanFilled,
          archiveExists: true,
          archiveFingerprintMatches: true,
          liveFingerprintMatches: true,
          blockReasonConfirmed: null,
        },
      ],
    });
    assert.equal(verdict.state, RETIREMENT_RECORD_STATE.RETIRED);
  });
});

// ---------------------------------------------------------------------------
// 7. 되돌림 변이(mutation) -- 정확히 8건, 문서(설계 문서 §7)의 숫자와 일치.
// 소스는 메모리에서만 읽어 고친 사본을 임시 디렉터리에 써서 동적 임포트
// 한다 -- 실 저장소 파일은 쓰기 대상이 아니므로 바이트 동일 복원이
// 구조적으로 보장된다(원복 증명은 그래도 각 시험 안에서 재확인한다).
// ---------------------------------------------------------------------------

function tmpMutantDir() {
  return mkdtempSync(join(tmpdir(), "hyk419-auto-author-mut-"));
}

async function importMutant(mutatedSource, dir) {
  writeFileSync(
    join(dir, "hyk412-never-consumed-retire-core.mjs"),
    readFileSync(
      join(CHECK_DIR, "hyk412-never-consumed-retire-core.mjs"),
      "utf8",
    ),
    "utf8",
  );
  const dest = join(dir, "retirement-auto-author-core.mjs");
  writeFileSync(dest, mutatedSource, "utf8");
  return import(`file://${dest}?t=${Date.now()}-${Math.random()}`);
}

function assertMutationTargetUnique(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `${label}: mutation target must appear exactly once (found ${count})`,
  );
}

function assertOriginalUnchanged(src) {
  assert.equal(
    readFileSync(CORE_PATH, "utf8"),
    src,
    "원복 증명 실패: 실제 retirement-auto-author-core.mjs가 시험 도중 바뀌었다",
  );
}

test("되돌림 변이 1/8: 게이트-닫힘 검사 제거 -> CLOSED facts도 AUTHORIZED_DRAFT로 잘못 열린다(RED), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  if (gate.state !== NEVER_CONSUMED_RETIRE_STATE.OPEN) {
    return {
      state: AUTO_AUTHOR_STATE.GATE_CLOSED,
      ok: false,
      gateState: gate.state,
      reason: \`retirement-auto-author: hyk412 게이트가 OPEN이 아님(\${gate.state}) -> 자동 작성 자격 없음, 거부(안전측 기본값). 게이트 사유: \${gate.reason}\`,
    };
  }
`;
  assertMutationTargetUnique(src, target, "mutation 1");
  const mutated = src.replace(target, "");
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = await withHarness((harnessDir, fp) =>
      mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, { ledgerReservation: { exists: false } }),
      ),
    );
    assert.equal(r.state, "AUTHORIZED_DRAFT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 2/8: 앵커-미완성(존재 확인) 검사 제거 -> 문자열이 아닌 harnessDir이 조용히 넘어가 예외로 새어 나간다(RED, 크래시 방지 목적이 실제로 이 관문임을 증명), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  const anchorFailure = checkMachineAnchorFacts({
    harnessDir,
    ownTaskArchivePath,
    ownTaskArchiveFingerprint,
    recordedAt,
  });
  if (anchorFailure) return anchorFailure;
`;
  assertMutationTargetUnique(src, target, "mutation 2");
  const mutated = src.replace(target, "");
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    await withHarness(async (harnessDir, fp) => {
      await assert.rejects(
        () =>
          Promise.resolve().then(() =>
            mod.evaluateAutoAuthorAuthorization(
              openFacts(harnessDir, fp, { harnessDir: 12345 }),
            ),
          ),
        /TypeError/,
        "RED: 앵커-미완성 검사가 없으면 harnessDir 타입 위조가 구조화된 거부 대신 예외로 새어 나간다",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 3/8: blockReasonCode 하드코딩 제거 -> 위조된 사유 코드가 draftRecord로 새어 나간다(RED), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = "      blockReasonCode: null,";
  assertMutationTargetUnique(src, target, "mutation 3");
  const mutated = src.replace(
    target,
    "      blockReasonCode: facts.blockReasonCode ?? null,",
  );
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = await withHarness((harnessDir, fp) =>
      mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, { blockReasonCode: "FORGED_REASON_CODE" }),
      ),
    );
    assert.equal(r.state, "AUTHORIZED_DRAFT");
    assert.equal(r.draftRecord.blockReasonCode, "FORGED_REASON_CODE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 4/8: resolveSafeArchivePath의 경로 탈출 방어 두 겹(문자열 휴리스틱 + resolve 결과 포함관계 재확인)을 통째로 제거하면 -> harnessDir 밖의 «실재하는» 파일까지 AUTHORIZED_DRAFT로 새어 나간다(RED, 진짜 경계 탈출이 실물로 증명됨), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  if (looksLikeTraversal(relPath)) return null;
  const base = resolve(harnessDir);
  const full = resolve(base, relPath);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
`;
  assertMutationTargetUnique(src, target, "mutation 4");
  const mutated = src.replace(
    target,
    `  const base = resolve(harnessDir);
  const full = resolve(base, relPath);
  return full;
`,
  );
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    // harnessDir 밖(형제 디렉터리)에 실재하는 decoy 파일을 두고, 그 파일의
    // 진짜 지문을 계산한다 -- "존재하지 않아서 어차피 막힌다"는 반론을
    // 원천 차단하려고 실물로 만든다(1차 시도에서 이 함정을 놓쳤다 --
    // looksLikeTraversal만 지운 변이는 resolveSafeArchivePath의 두 번째
    // 관문이 여전히 막아서 RED가 안 나왔다, 그래서 두 관문을 함께 제거).
    const outerDir = tmpHarnessDir();
    const harnessDir = join(outerDir, "harness");
    mkdirSync(harnessDir, { recursive: true });
    const decoyContent = "this file lives OUTSIDE the sandboxed harnessDir\n";
    const decoyFp = sha256Hex(decoyContent);
    writeFileSync(join(outerDir, "decoy.md"), decoyContent, "utf8");
    try {
      const r = mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, decoyFp, {
          ownTaskArchivePath: "../decoy.md",
        }),
      );
      assert.equal(
        r.state,
        "AUTHORIZED_DRAFT",
        "RED: 두 관문이 없으면 harnessDir 밖의 실재 파일도 그대로 조립된다 -- 이게 진짜 경계 탈출이다",
      );
      assert.equal(r.draftRecord.archivePath, "../decoy.md");
    } finally {
      rmSync(outerDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 5/8: 존재 확인 검사 제거 -> 'rounds/DOES-NOT-EXIST.md'(검토 원문)가 지문 단계로 새어 나간다(RED), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  const existsFailure = checkArchiveExists({
    harnessDir,
    ownTaskArchivePath,
    existsFn,
  });
  if (existsFailure) return existsFailure;
`;
  assertMutationTargetUnique(src, target, "mutation 5");
  const mutated = src.replace(target, "");
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = await withHarness((harnessDir, fp) =>
      mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, {
          ownTaskArchivePath: "rounds/DOES-NOT-EXIST.md",
        }),
      ),
    );
    assert.notEqual(r.state, "ARCHIVE_PATH_NOT_FOUND");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 6/8: 지문 검사 제거 -> 'FORGED-FINGERPRINT'(검토 원문)가 그대로 AUTHORIZED_DRAFT까지 새어 나간다(RED), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  const fingerprintFailure = checkFingerprint({
    harnessDir,
    ownTaskArchivePath,
    ownTaskArchiveFingerprint,
    readFileFn,
    hashFn,
  });
  if (fingerprintFailure) return fingerprintFailure;
`;
  assertMutationTargetUnique(src, target, "mutation 6");
  const mutated = src.replace(target, "");
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = await withHarness((harnessDir) =>
      mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, "FORGED-FINGERPRINT"),
      ),
    );
    assert.equal(r.state, "AUTHORIZED_DRAFT");
    assert.equal(r.draftRecord.archiveFingerprintClaimed, "FORGED-FINGERPRINT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 7/8: 기록시각 검사 제거 -> 'not-a-time'(검토 원문)이 그대로 AUTHORIZED_DRAFT까지 새어 나간다(RED), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  const recordedAtFailure = checkRecordedAt({ recordedAt, nowFn });
  if (recordedAtFailure) return recordedAtFailure;
`;
  assertMutationTargetUnique(src, target, "mutation 7");
  const mutated = src.replace(target, "");
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = await withHarness((harnessDir, fp) =>
      mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, { recordedAt: "not-a-time" }),
      ),
    );
    assert.equal(r.state, "AUTHORIZED_DRAFT");
    assert.equal(r.draftRecord.recordedAt, "not-a-time");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 8/8: 후속 이름표 문법 검사 제거 -> '../../not-a-real-successor'(검토 원문)가 그대로 AUTHORIZED_DRAFT까지 새어 나간다(RED), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  const successorGrammarFailure = checkSuccessorLabelGrammar(
    successorLabelForRecord,
  );
  if (successorGrammarFailure) return successorGrammarFailure;
`;
  assertMutationTargetUnique(src, target, "mutation 8");
  const mutated = src.replace(target, "");
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = await withHarness((harnessDir, fp) =>
      mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, {
          successorLabelForRecord: "../../not-a-real-successor",
        }),
      ),
    );
    assert.equal(r.state, "AUTHORIZED_DRAFT");
    assert.equal(r.draftRecord.successorLabel, "../../not-a-real-successor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});
