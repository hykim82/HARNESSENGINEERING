import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTotalSessionBytes } from "./dispatch-start-size-adapter.mjs";
import { deriveClaudeProjectDirName } from "./rate-limit-stall-adapter.mjs";

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("collectTotalSessionBytes: 디렉터리 없음 -> 정상(totalBytes:0), 결손 아님", () => {
  const r = collectTotalSessionBytes(
    { repoRoot: "C:\\wt", claudeHomeDir: "C:\\nope-zzz" },
    {
      readdirFn: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    },
  );
  assert.deepEqual(r, { ok: true, totalBytes: 0, fileCount: 0 });
});

test("collectTotalSessionBytes: ENOENT 아닌 열거 실패 -> ok:false(조용함으로 접지 않는다)", () => {
  const r = collectTotalSessionBytes(
    { repoRoot: "C:\\wt", claudeHomeDir: "C:\\home" },
    {
      readdirFn: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    },
  );
  assert.equal(r.ok, false);
});

test("collectTotalSessionBytes: 여러 jsonl 파일의 크기를 더한다", () => {
  withTempDir("dss-", (home) => {
    const projectDir = join(
      home,
      "projects",
      deriveClaudeProjectDirName("C:\\wt"),
    );
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "a.jsonl"), "x".repeat(10), "utf8");
    writeFileSync(join(projectDir, "b.jsonl"), "x".repeat(25), "utf8");
    writeFileSync(join(projectDir, "not-jsonl.txt"), "x".repeat(999), "utf8");

    const r = collectTotalSessionBytes(
      { repoRoot: "C:\\wt", claudeHomeDir: home },
      { readdirFn: (p) => readdirSync(p) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.totalBytes, 35);
    assert.equal(r.fileCount, 2);
  });
});

test("collectTotalSessionBytes: stat 실패는 ok:false(STAT_FAILED)", () => {
  const r = collectTotalSessionBytes(
    { repoRoot: "C:\\wt", claudeHomeDir: "C:\\home" },
    {
      readdirFn: () => ["a.jsonl"],
      statFn: () => {
        throw new Error("boom");
      },
    },
  );
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// ★HYK-378 사례1 재구성(coder.md §1 첨부 원문
// orch-evidence-sample1-HYK337-1.md의 실사고를 낳은 «실제 디스크 레이아웃»
// 그대로 -- 발췌 아님, 오늘 실측으로 직접 확인한 경로 구조를 그대로 씀):
//   <projectDir>/84260e74-....jsonl               <- 본 세션(정체됨)
//   <projectDir>/84260e74-.../subagents/agent-*.jsonl <- 하위 에이전트(계속 자람)
// 고치기 전에는 두 번째 파일이 전혀 안 세졌다(프로젝트 디렉터리 "바로
// 아래"만 훑었으므로) -- 그래서 하위 에이전트가 아무리 활발해도 본
// 세션은 "안 자란 것처럼" 보였다.
test("★HYK-378 사례1 재구성: <세션UUID>/subagents/*.jsonl(하위 에이전트 전사록)도 총합에 포함된다", () => {
  withTempDir("dss-subagent-", (home) => {
    const projectDir = join(
      home,
      "projects",
      deriveClaudeProjectDirName("C:\\wt\\hyk337-pledge-stall"),
    );
    const sessionUuid = "84260e74-7b3c-4ea1-b981-d062debece4a";
    const subagentsDir = join(projectDir, sessionUuid, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    // 본 세션 jsonl -- 실사고 당시 정체돼 있던 파일.
    writeFileSync(
      join(projectDir, `${sessionUuid}.jsonl`),
      "x".repeat(395579),
      "utf8",
    );
    // 하위 에이전트 전사록 -- 실사고 당시 계속 자라고 있던 파일(★고치기
    // 전에는 이 바이트가 총합에서 통째로 빠졌다).
    writeFileSync(
      join(subagentsDir, "agent-a6bfcf6dd9c3cf211.jsonl"),
      "x".repeat(956214),
      "utf8",
    );
    writeFileSync(
      join(subagentsDir, "agent-a6bfcf6dd9c3cf211.meta.json"),
      "x".repeat(173),
      "utf8", // .jsonl이 아니므로 제외돼야 한다.
    );

    const r = collectTotalSessionBytes(
      { repoRoot: "C:\\wt\\hyk337-pledge-stall", claudeHomeDir: home },
      { readdirFn: (p) => readdirSync(p) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.totalBytes, 395579 + 956214);
    assert.equal(r.fileCount, 2);
  });
});

test("collectTotalSessionBytes: 세션 디렉터리에 subagents 폴더가 없으면(하위 에이전트 미가동) 조용히 건너뛴다(결손 아님)", () => {
  withTempDir("dss-no-subagent-", (home) => {
    const projectDir = join(
      home,
      "projects",
      deriveClaudeProjectDirName("C:\\wt"),
    );
    const sessionUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mkdirSync(join(projectDir, sessionUuid), { recursive: true }); // subagents 폴더 없음.
    writeFileSync(
      join(projectDir, `${sessionUuid}.jsonl`),
      "x".repeat(100),
      "utf8",
    );

    const r = collectTotalSessionBytes(
      { repoRoot: "C:\\wt", claudeHomeDir: home },
      { readdirFn: (p) => readdirSync(p) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.totalBytes, 100);
    assert.equal(r.fileCount, 1);
  });
});

// ---------------------------------------------------------------------------
// ★HYK-378 2R(REVIEW P1-2 반려 수리+재현) -- 1R은 `subagents` 열거의 모든
// 예외(폴더 부재 포함)를 `[]`(=정상, 하위 에이전트 미가동)로 삼켰다.
// 검토자 실측 재현: 본 세션 100B + 하위 전사록 200B가 있는 상태에서
// `subagents` 열거에 `EACCES`를 주입하면 1R은 `ok:true/totalBytes:100`을
// 냈다(활성 하위 작업을 못 읽었는데 정상 관측으로 둔갑) -- ★수리 후에는
// `ok:false`(COLLECTION_FAILED 경로로 이어짐)여야 한다(불변식 E).
test("★HYK-378 2R P1-2 재현+수리: subagents 열거에 EACCES를 주입하면 ok:false(더는 fail-open 아님)", () => {
  withTempDir("dss-eacces-", (home) => {
    const projectDir = join(
      home,
      "projects",
      deriveClaudeProjectDirName("C:\\wt"),
    );
    const sessionUuid = "eeeeeeee-1111-2222-3333-444444444444";
    const subagentsDir = join(projectDir, sessionUuid, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${sessionUuid}.jsonl`),
      "x".repeat(100),
      "utf8",
    );
    writeFileSync(join(subagentsDir, "agent-x.jsonl"), "x".repeat(200), "utf8");

    const readdirFn = (p) => {
      if (p === subagentsDir) {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      }
      return readdirSync(p);
    };
    const r = collectTotalSessionBytes(
      { repoRoot: "C:\\wt", claudeHomeDir: home },
      { readdirFn },
    );
    assert.equal(
      r.ok,
      false,
      "EACCES는 정상 관측(ok:true)으로 둔갑하면 안 된다 -- 1R의 정확한 재현 지점",
    );
  });
});

// 대조군 -- 폴더 부재(ENOENT)는 여전히 정상(빈 집합)이어야 한다(불변식 E
// "부재는 정상 · 그 밖은 실패"의 절반, 위 P1-2 시험이 나머지 절반).
// 기존 "subagents 폴더가 없으면 조용히 건너뛴다" 시험이 이미 실물
// readdirSync로 이걸 보이지만, 여기서는 ENOTDIR도 같은 벤치마크로
// 명시적으로 고정한다(entryName이 애초에 디렉터리가 아닌 흔한 경우 --
// existing "not-jsonl.txt" 시험이 실 OS에서 ENOENT를 내는 것도 실측
// 확인함, 이 시험은 ENOTDIR을 직접 주입해 그 코드 분기도 명시적으로
// 통과시킨다).
test("collectTotalSessionBytes: subagents 열거의 ENOTDIR도 여전히 정상(빈 집합)이다", () => {
  withTempDir("dss-enotdir-", (home) => {
    const projectDir = join(
      home,
      "projects",
      deriveClaudeProjectDirName("C:\\wt"),
    );
    const sessionUuid = "ffffffff-5555-6666-7777-888888888888";
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${sessionUuid}.jsonl`),
      "x".repeat(50),
      "utf8",
    );
    const subagentsDir = join(projectDir, sessionUuid, "subagents");
    const readdirFn = (p) => {
      if (p === subagentsDir) {
        throw Object.assign(new Error("ENOTDIR: not a directory"), {
          code: "ENOTDIR",
        });
      }
      return readdirSync(p);
    };
    const r = collectTotalSessionBytes(
      { repoRoot: "C:\\wt", claudeHomeDir: home },
      { readdirFn },
    );
    assert.equal(r.ok, true);
    assert.equal(r.totalBytes, 50);
    assert.equal(r.fileCount, 1);
  });
});

// ---------------------------------------------------------------------------
// ★HYK-378 2R(REVIEW P2 대응 -- 범위 고정 시험) -- 한 단계만 순회한다는
// 방침(coder.md·adapter 주석 참조)을 시험으로 고정한다: 검토자가 만든
// 정확히 같은 레이아웃(`subagents/nested/deep.jsonl`)에서 그 중첩 파일은
// 총합에서 제외돼야 한다(다음 사람이 조용히 재귀를 넓히면 이 시험이
// 잡는다).
test("★HYK-378 2R P2 범위 고정: subagents 바로 아래 한 단계만 본다 -- 그 아래 nested/deep.jsonl은 제외된다", () => {
  withTempDir("dss-nested-", (home) => {
    const projectDir = join(
      home,
      "projects",
      deriveClaudeProjectDirName("C:\\wt"),
    );
    const sessionUuid = "11111111-2222-3333-4444-555555555555";
    const subagentsDir = join(projectDir, sessionUuid, "subagents");
    const nestedDir = join(subagentsDir, "nested");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${sessionUuid}.jsonl`),
      "x".repeat(100),
      "utf8",
    );
    writeFileSync(join(subagentsDir, "direct.jsonl"), "x".repeat(200), "utf8");
    writeFileSync(join(nestedDir, "deep.jsonl"), "x".repeat(300), "utf8"); // ★제외돼야 함.

    const r = collectTotalSessionBytes(
      { repoRoot: "C:\\wt", claudeHomeDir: home },
      { readdirFn: (p) => readdirSync(p) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.totalBytes, 100 + 200); // 300(nested)은 빠진다.
    assert.equal(r.fileCount, 2);
  });
});

// ---------------------------------------------------------------------------
// ★HYK-378 2R(REVIEW P2 대응 -- 심볼릭 링크 정책 고정) -- 검토자 실측
// 재현: 프로젝트 "밖"을 가리키는 심볼릭 링크가 있으면 `statSync`가 그
// 링크를 따라가 바깥 바이트가 합계에 섞여 들어왔다. ★결정(어댑터 주석
// 근거 그대로): 이 세션 기록 폴더는 신뢰 경계이므로 링크는 «따라가지
// 않는다»(총합·개수 양쪽에서 제외).
test("★HYK-378 2R P2 정책 고정: 프로젝트 밖을 가리키는 심볼릭 링크는 총합에서 제외된다(안 따라감)", () => {
  withTempDir("dss-symlink-", (home) => {
    withTempDir("dss-symlink-outside-", (outside) => {
      const projectDir = join(
        home,
        "projects",
        deriveClaudeProjectDirName("C:\\wt"),
      );
      const sessionUuid = "99999999-aaaa-bbbb-cccc-dddddddddddd";
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, `${sessionUuid}.jsonl`),
        "x".repeat(100),
        "utf8",
      );
      const outsideTarget = join(outside, "outside-target.jsonl");
      writeFileSync(outsideTarget, "x".repeat(400), "utf8"); // 신뢰 경계 밖.
      const linkPath = join(projectDir, "linked.jsonl");
      symlinkSync(outsideTarget, linkPath, "file");

      const r = collectTotalSessionBytes(
        { repoRoot: "C:\\wt", claudeHomeDir: home },
        { readdirFn: (p) => readdirSync(p) },
      );
      assert.equal(r.ok, true);
      assert.equal(
        r.totalBytes,
        100,
        "링크가 가리키는 밖의 400B가 섞여 들어오면 안 된다",
      );
      assert.equal(r.fileCount, 1, "링크 자체도 개수에서 제외된다");
    });
  });
});
