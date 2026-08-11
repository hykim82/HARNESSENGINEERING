// HYK-229 1R: 아카이브 판정 코어 시험. §2 합격 기준 = "옮겨진다"가 아니라
// "안 옮겨진다"를 증명하는 것 -- 합성 픽스처 매트릭스(§2 표)를 그대로
// 재현한다. 실제 관제실 파일은 절대 건드리지 않는다(mkdtemp만 사용).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeCandidate,
  exactlyOneCopyInvariant,
  buildManifest,
  executeManifestEntry,
  executeManifest,
  sha256OfFile,
  performMove,
  verifyPostMoveOrRollback,
} from "./archive-core.mjs";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk229-archive-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // 고정 기준 시각(합성) -- 실시각에 의존하지 않는다.

function makeCandidate(
  srcDir,
  name,
  { content = "synthetic", ageMs = 0, locked = false } = {},
) {
  const path = join(srcDir, name);
  writeFileSync(path, content);
  return { path, mtimeMs: NOW - ageMs, sizeBytes: content.length, locked };
}

// ---------------------------------------------------------------------------
// §2 픽스처 매트릭스 -- 각 행을 개별 시험으로 대조한다.
// ---------------------------------------------------------------------------

test("fixture matrix: 오래됨 + 미참조 -> 이동됨 (유일하게)", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    const dst = join(dir, "dst");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "old-unreferenced.md", {
      ageMs: 30 * ONE_DAY_MS,
    });

    const judgement = judgeCandidate(c, { now: NOW, minAgeMs: 7 * ONE_DAY_MS });
    assert.equal(judgement.eligible, true);
    assert.equal(judgement.reason, "eligible");

    const manifest = buildManifest(
      [c],
      () => join(dst, "old-unreferenced.md"),
      {
        now: NOW,
        minAgeMs: 7 * ONE_DAY_MS,
      },
    );
    const results = executeManifest(manifest);
    assert.equal(results[0].status, "moved");
    assert.equal(existsSync(c.path), false);
    assert.equal(existsSync(results[0].destPath), true);
  });
});

test("fixture matrix: 오래됨 + 현재 참조 중 -> 이동 안 됨 (이슈의 존재 이유)", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "pr-body-hyk225.md", {
      ageMs: 30 * ONE_DAY_MS,
    });

    // §0 실증 반례 재현: bot-push-pr.sh --body-file 인자로 이 절대경로가 살아 있다.
    const judgement = judgeCandidate(c, {
      now: NOW,
      minAgeMs: 7 * ONE_DAY_MS,
      runningArgs: [`bot-push-pr.sh --body-file ${c.path}`],
    });
    assert.equal(judgement.eligible, false);
    assert.equal(judgement.reason, "running-arg-reference");
    assert.equal(existsSync(c.path), true);
  });
});

test("fixture matrix: 오래됨 + STATUS/태스크/받는함/발행절차 절대경로 참조 -> 이동 안 됨", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "referenced-elsewhere.md", {
      ageMs: 30 * ONE_DAY_MS,
    });

    const judgement = judgeCandidate(c, {
      now: NOW,
      minAgeMs: 7 * ONE_DAY_MS,
      referenceTexts: [
        `| CODER | in-progress, see ${c.path} | 2026-08-11 16:00 |`,
      ],
    });
    assert.equal(judgement.eligible, false);
    assert.equal(judgement.reason, "active-reference");
  });
});

test("fixture matrix: 최근 -> 이동 안 됨", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "recent.md", { ageMs: 1 * ONE_DAY_MS });

    const judgement = judgeCandidate(c, { now: NOW, minAgeMs: 7 * ONE_DAY_MS });
    assert.equal(judgement.eligible, false);
    assert.equal(judgement.reason, "too-recent");
  });
});

test("fixture matrix: 화이트리스트 -> 이동 안 됨", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "protected.md", { ageMs: 30 * ONE_DAY_MS });

    const judgement = judgeCandidate(c, {
      now: NOW,
      minAgeMs: 7 * ONE_DAY_MS,
      whitelist: new Set([c.path]),
    });
    assert.equal(judgement.eligible, false);
    assert.equal(judgement.reason, "whitelist");
  });
});

test("fixture matrix: 잠금 중 -> 이동 안 됨", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "locked.md", {
      ageMs: 30 * ONE_DAY_MS,
      locked: true,
    });

    const judgement = judgeCandidate(c, { now: NOW, minAgeMs: 7 * ONE_DAY_MS });
    assert.equal(judgement.eligible, false);
    assert.equal(judgement.reason, "locked");
  });
});

test("fixture matrix: 목적지 충돌 -> 이동 안 됨 (안전 실패, 원본 보존)", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    const dst = join(dir, "dst");
    mkdirSync(src, { recursive: true });
    mkdirSync(dst, { recursive: true });
    const c = makeCandidate(src, "conflict.md", { ageMs: 30 * ONE_DAY_MS });
    const destPath = join(dst, "conflict.md");
    writeFileSync(destPath, "already occupied");

    const manifest = buildManifest([c], () => destPath, {
      now: NOW,
      minAgeMs: 7 * ONE_DAY_MS,
    });
    const result = executeManifestEntry(manifest[0]);

    assert.equal(result.status, "failed");
    assert.equal(result.detail, "dest-conflict");
    assert.equal(existsSync(c.path), true);
    assert.equal(readFileSync(destPath, "utf8"), "already occupied");
  });
});

test("fixture matrix: 해시 불일치 -> 이동 안 됨 (안전 실패, 원본 보존)", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    const dst = join(dir, "dst");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "changed.md", { ageMs: 30 * ONE_DAY_MS });

    const manifest = buildManifest([c], () => join(dst, "changed.md"), {
      now: NOW,
      minAgeMs: 7 * ONE_DAY_MS,
    });
    // 매니페스트 생성 이후 파일이 변경됨(경합) -- 이동 전 재대조에서 잡혀야 한다.
    writeFileSync(c.path, "mutated after manifest was built");

    const result = executeManifestEntry(manifest[0]);
    assert.equal(result.status, "failed");
    assert.equal(result.detail, "hash-mismatch-pre-move");
    assert.equal(existsSync(c.path), true);
    assert.equal(existsSync(join(dst, "changed.md")), false);
  });
});

// ---------------------------------------------------------------------------
// §2-2: 이동 전건 SHA-256 무손실
// ---------------------------------------------------------------------------

test("이동된 파일은 SHA-256이 이동 전후 동일하다 (무손실)", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    const dst = join(dir, "dst");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "lossless.md", {
      content: "합성 페이로드 -- 이동 전후 바이트 동일해야 함",
      ageMs: 30 * ONE_DAY_MS,
    });
    const preHash = sha256OfFile(c.path);

    const manifest = buildManifest([c], () => join(dst, "lossless.md"), {
      now: NOW,
      minAgeMs: 7 * ONE_DAY_MS,
    });
    const [result] = executeManifest(manifest);

    assert.equal(result.status, "moved");
    const postHash = sha256OfFile(result.destPath);
    assert.equal(postHash, preHash);
    assert.equal(postHash, manifest[0].sha256);
  });
});

// ---------------------------------------------------------------------------
// §2-3: 부분 실패 주입 -> 파일 단위 원복 (RED -> GREEN 왕복)
// ---------------------------------------------------------------------------

test("부분 실패 주입 -> 파일 단위 원복 (RED -> GREEN 왕복)", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    const dst = join(dir, "dst");
    mkdirSync(src, { recursive: true });
    const originalContent = "롤백 대상";
    const c = makeCandidate(src, "rollback-me.md", {
      content: originalContent,
      ageMs: 30 * ONE_DAY_MS,
    });

    const manifest = buildManifest([c], () => join(dst, "rollback-me.md"), {
      now: NOW,
      minAgeMs: 7 * ONE_DAY_MS,
    });
    const entry = manifest[0];

    // RED: 이동 자체는 실행하되(performMove), 재대조 직전에 목적지 바이트를
    // 오염시킨다 -- 전송 중 손상·경합 같은 실제 사고의 대리 신호다. 이렇게
    // 해야 verifyPostMoveOrRollback의 실제 rollback 코드 경로가 도는지
    // 실측할 수 있다(사전 해시를 조작하면 이동 자체가 일어나지 않아
    // "부분 실패 후 원복"이 아니라 "애초에 시작 안 함"이 되어 버린다).
    performMove(entry);
    assert.equal(
      existsSync(c.path),
      false,
      "이동 직후에는 원본 자리가 비어 있어야 한다",
    );
    writeFileSync(entry.destPath, "손상된 바이트");

    const redResult = verifyPostMoveOrRollback(entry);
    assert.equal(redResult.ok, false);
    assert.equal(redResult.detail, "hash-mismatch-post-move");

    // 원복 확인: 정확히 원본 자리에만 파일이 있고 목적지엔 아무것도 없다.
    assert.equal(
      existsSync(c.path),
      true,
      "RED 이후 원본 자리가 복원되어야 한다",
    );
    assert.equal(
      existsSync(entry.destPath),
      false,
      "RED 이후 목적지에 잔류물이 없어야 한다",
    );
    assert.equal(
      exactlyOneCopyInvariant(
        { sourcePath: c.path, destPath: entry.destPath },
        existsSync,
      ),
      true,
    );

    // GREEN: 손상을 걷어내고(=운영자가 원본 바이트로 복구) 같은 항목을
    // 처음부터 다시 이동하면 성공한다.
    writeFileSync(c.path, originalContent);
    const greenResult = executeManifestEntry(entry);
    assert.equal(greenResult.status, "moved");
    assert.equal(existsSync(c.path), false);
    assert.equal(existsSync(greenResult.destPath), true);
    assert.equal(readFileSync(greenResult.destPath, "utf8"), originalContent);
  });
});

// ---------------------------------------------------------------------------
// §2-4: 원본 또는 목적지 중 정확히 한 정본만 남는다
// ---------------------------------------------------------------------------

test("정확히 한 정본 불변식: 이동 성공 -> destPath만 존재", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    const dst = join(dir, "dst");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "invariant-moved.md", {
      ageMs: 30 * ONE_DAY_MS,
    });

    const manifest = buildManifest([c], () => join(dst, "invariant-moved.md"), {
      now: NOW,
      minAgeMs: 7 * ONE_DAY_MS,
    });
    const [result] = executeManifest(manifest);

    assert.equal(result.status, "moved");
    assert.equal(exactlyOneCopyInvariant(result, existsSync), true);
  });
});

test("정확히 한 정본 불변식: 판정 거부(skip) -> sourcePath만 존재", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "invariant-recent.md", {
      ageMs: 1 * ONE_DAY_MS,
    });

    const manifest = buildManifest(
      [c],
      () => join(dir, "dst", "invariant-recent.md"),
      {
        now: NOW,
        minAgeMs: 7 * ONE_DAY_MS,
      },
    );
    const [result] = executeManifest(manifest);

    assert.equal(result.status, "skipped");
    assert.equal(exactlyOneCopyInvariant(result, existsSync), true);
  });
});

test("정확히 한 정본 불변식: 롤백 이후 -> sourcePath만 존재", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    const dst = join(dir, "dst");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "invariant-rollback.md", {
      ageMs: 30 * ONE_DAY_MS,
    });

    const manifest = buildManifest(
      [c],
      () => join(dst, "invariant-rollback.md"),
      {
        now: NOW,
        minAgeMs: 7 * ONE_DAY_MS,
      },
    );
    const poisoned = { ...manifest[0], sha256: "1".repeat(64) };
    const result = executeManifestEntry(poisoned);

    assert.equal(result.status, "failed");
    assert.equal(exactlyOneCopyInvariant(result, existsSync), true);
  });
});

// ---------------------------------------------------------------------------
// 기본값 안전: minAgeMs를 넘기지 않으면 아무것도 이동 대상이 되지 않는다
// (§3 PM 정직 한계 -- 기본값은 "아무것도 안 옮김").
// ---------------------------------------------------------------------------

test("기본값(minAgeMs 미지정) -> 아무리 오래된 파일도 이동 대상이 되지 않는다", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "very-old.md", { ageMs: 3650 * ONE_DAY_MS });

    const judgement = judgeCandidate(c, { now: NOW });
    assert.equal(judgement.eligible, false);
    assert.equal(judgement.reason, "too-recent");
  });
});

// ---------------------------------------------------------------------------
// 매니페스트 필수 항목(§1 PM 지정) 실측
// ---------------------------------------------------------------------------

test("매니페스트는 원본/목적지/크기/mtime/SHA-256/사유/판정을 모두 포함한다", () => {
  withFixtureDir((dir) => {
    const src = join(dir, "src");
    const dst = join(dir, "dst");
    mkdirSync(src, { recursive: true });
    const c = makeCandidate(src, "manifest-fields.md", {
      content: "필드 확인용",
      ageMs: 30 * ONE_DAY_MS,
    });

    const [entry] = buildManifest([c], () => join(dst, "manifest-fields.md"), {
      now: NOW,
      minAgeMs: 7 * ONE_DAY_MS,
    });

    assert.equal(entry.sourcePath, c.path);
    assert.equal(entry.destPath, join(dst, "manifest-fields.md"));
    assert.equal(entry.sizeBytes, Buffer.byteLength("필드 확인용"));
    assert.equal(typeof entry.mtimeMs, "number");
    assert.equal(entry.sha256, sha256OfFile(c.path));
    assert.equal(entry.reason, "eligible");
    assert.equal(entry.eligible, true);
  });
});
