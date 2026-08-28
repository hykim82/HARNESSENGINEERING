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
  assert.deepEqual(r, {
    ok: true,
    totalBytes: 0,
    fileCount: 0,
    excludedSymlinkCount: 0,
  });
});

// ★4R -- 뿌리 신뢰 검사(claudeHomeDir·projects·projectDir 자신이 링크가
// 아닌지)가 실제 readdir/stat보다 먼저 도니, 이 조작(readdirFn이 실제
// 열거 실패를 낸다)을 시험하려면 뿌리 세 경로는 "존재하고 링크가
// 아니다"라고 lstatFn을 함께 주입해야 한다(그래야 readdirFn까지
// 도달한다) -- 실 파일시스템에 없는 가짜 경로라 lstatFn 없이는 항상
// ENOENT로 먼저 걸려 "없음"(정상)으로 접힌다.
const notLinkStat = { isSymbolicLink: () => false };
function fakeRootLstatFn(rootPaths) {
  return (p) => {
    if (rootPaths.includes(p)) return notLinkStat;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
}

test("collectTotalSessionBytes: ENOENT 아닌 열거 실패 -> ok:false(조용함으로 접지 않는다)", () => {
  const claudeHomeDir = "C:\\home";
  const r = collectTotalSessionBytes(
    { repoRoot: "C:\\wt", claudeHomeDir },
    {
      lstatFn: fakeRootLstatFn([
        claudeHomeDir,
        join(claudeHomeDir, "projects"),
        join(claudeHomeDir, "projects", deriveClaudeProjectDirName("C:\\wt")),
      ]),
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
  const claudeHomeDir = "C:\\home";
  const projectDir = join(
    claudeHomeDir,
    "projects",
    deriveClaudeProjectDirName("C:\\wt"),
  );
  const r = collectTotalSessionBytes(
    { repoRoot: "C:\\wt", claudeHomeDir },
    {
      lstatFn: fakeRootLstatFn([
        claudeHomeDir,
        join(claudeHomeDir, "projects"),
        projectDir,
      ]),
      realpathFn: (p) => p, // 가짜 경로라 실제 realpath 대신 그대로 돌려준다.
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
      assert.equal(
        r.excludedSymlinkCount,
        1,
        "★3R -- 배제 진단 신호(불변식 I)가 결과에 남아야 한다",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// ★HYK-378 3R(REVIEW P1-2 재반려 재현+수리) -- 검토자의 정확한 재현: 프로젝트
// 아래 `session`을 외부 디렉터리를 가리키는 junction으로 만들고 그 밖의
// `subagents/agent.jsonl` 400B를 두면, 2R까지는 `entry` 자신(디렉터리
// 항목)을 lstat하지 않아 `ok:true,totalBytes:400,fileCount:1`로 새어
// 나갔다. ★수리 후에는 그 디렉터리 항목 자체가 링크임을 먼저 확인해
// 안을 들여다보지도 않는다.
test("★HYK-378 3R P1-2 재현+수리: 세션 디렉터리 자체가 junction이면 그 안의 파일까지 통째로 제외된다(파일 링크뿐 아니라 디렉터리 링크도 안 따라감)", () => {
  withTempDir("dss-dirjunction-", (home) => {
    withTempDir("dss-dirjunction-outside-", (outside) => {
      const projectDir = join(
        home,
        "projects",
        deriveClaudeProjectDirName("C:\\wt"),
      );
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "main.jsonl"), "x".repeat(100), "utf8");

      // 프로젝트 밖 -- 신뢰 경계 밖 데이터.
      const outsideSubagents = join(outside, "subagents");
      mkdirSync(outsideSubagents, { recursive: true });
      writeFileSync(
        join(outsideSubagents, "agent.jsonl"),
        "x".repeat(400),
        "utf8",
      );

      // "session" 항목 자체가 밖을 가리키는 junction -- ★검토자의 정확한
      // 재현 레이아웃.
      const sessionLink = join(projectDir, "session");
      symlinkSync(outside, sessionLink, "junction");

      const r = collectTotalSessionBytes(
        { repoRoot: "C:\\wt", claudeHomeDir: home },
        { readdirFn: (p) => readdirSync(p) },
      );
      assert.equal(r.ok, true);
      assert.equal(
        r.totalBytes,
        100,
        "junction 밖의 400B가 섞여 들어오면 안 된다(2R까지는 500B로 샜다)",
      );
      assert.equal(r.fileCount, 1);
      assert.equal(
        r.excludedSymlinkCount,
        1,
        "디렉터리 링크 배제도 진단 신호에 잡혀야 한다",
      );
    });
  });
});

test("collectTotalSessionBytes: excludedSymlinkCount는 파일 링크 + 디렉터리 링크를 합산한다", () => {
  withTempDir("dss-mixed-links-", (home) => {
    withTempDir("dss-mixed-links-outside-", (outside) => {
      const projectDir = join(
        home,
        "projects",
        deriveClaudeProjectDirName("C:\\wt"),
      );
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "main.jsonl"), "x".repeat(10), "utf8");

      // 파일 링크 1개.
      const outsideFile = join(outside, "outside.jsonl");
      writeFileSync(outsideFile, "x".repeat(20), "utf8");
      symlinkSync(outsideFile, join(projectDir, "linked.jsonl"), "file");

      // 디렉터리 링크 1개 -- ★4R: containment 방식에서는 «발견된 파일이
      // 경계 밖일 때»만 세므로, 안에 실제로 뭔가 있어야 exclusion이
      // 잡힌다(빈 디렉터리 링크는 셀 대상 자체가 없다 -- 이 자체가
      // 정책 변경, coder.md §3R->4R 근거 참조).
      const outsideDir = join(outside, "outside-dir");
      const outsideDirSubagents = join(outsideDir, "subagents");
      mkdirSync(outsideDirSubagents, { recursive: true });
      writeFileSync(
        join(outsideDirSubagents, "agent.jsonl"),
        "x".repeat(400),
        "utf8",
      );
      symlinkSync(outsideDir, join(projectDir, "linked-session"), "junction");

      const r = collectTotalSessionBytes(
        { repoRoot: "C:\\wt", claudeHomeDir: home },
        { readdirFn: (p) => readdirSync(p) },
      );
      assert.equal(r.ok, true);
      assert.equal(r.totalBytes, 10);
      assert.equal(r.fileCount, 1);
      assert.equal(r.excludedSymlinkCount, 2);
    });
  });
});

// ---------------------------------------------------------------------------
// ★HYK-378 4R(REVIEW P1-2 세 번째 반려 재현+수리, 불변식 L "경로 관문")
// -- 검토자가 실측한 «한 겹 바깥» 세 경로를 그대로 재현한다. 3R까지의
// 층별 lstat 검사(세션 UUID 폴더만 확인)로는 이 셋을 못 잡았다 -- ★4R은
// 층별 검사를 폐기하고 "뿌리 신뢰 검사 + 최종 realpath containment"
// 단일 관문으로 교체했다.

// (a) projectDir 자신이 외부 폴더 junction -- 검토자 실측: 외부
// outside.jsonl 300B를 두면 수리 전엔 ok:true,totalBytes:300.
test("★HYK-378 4R P1-2 재현+수리(경로 a): projectDir 자신이 junction이면 그 안의 외부 바이트가 0으로 잡힌다(뿌리 신뢰 검사)", () => {
  withTempDir("dss-projectdir-junction-", (home) => {
    withTempDir("dss-projectdir-junction-outside-", (outside) => {
      const projectDir = join(
        home,
        "projects",
        deriveClaudeProjectDirName("C:\\wt"),
      );
      mkdirSync(join(home, "projects"), { recursive: true });
      writeFileSync(join(outside, "outside.jsonl"), "x".repeat(300), "utf8");
      // ★검토자의 정확한 재현: projectDir 자신이 junction.
      symlinkSync(outside, projectDir, "junction");

      const r = collectTotalSessionBytes(
        { repoRoot: "C:\\wt", claudeHomeDir: home },
        { readdirFn: (p) => readdirSync(p) },
      );
      assert.equal(r.ok, true);
      assert.equal(
        r.totalBytes,
        0,
        "projectDir 자신이 junction이면 그 밖 300B가 섞이면 안 된다(3R까지는 300B로 샜다)",
      );
      assert.equal(r.fileCount, 0);
      assert.equal(
        r.excludedSymlinkCount,
        1,
        "뿌리 자체가 배제됐다는 신호(1건)가 남아야 한다",
      );
    });
  });
});

// (b) session/subagents 자신이 외부 폴더 junction -- 2R·3R 지정 시험
// (세션 UUID 폴더 자체가 junction)과 다른 지점: 이번엔 세션 UUID
// 폴더는 real, 그 안의 "subagents" 폴더 자신이 junction.
test("★HYK-378 4R P1-2 재현+수리(경로 b): session/subagents 자신이 junction이어도 realpath containment로 잡힌다", () => {
  withTempDir("dss-subagentsdir-junction-", (home) => {
    withTempDir("dss-subagentsdir-junction-outside-", (outside) => {
      const projectDir = join(
        home,
        "projects",
        deriveClaudeProjectDirName("C:\\wt"),
      );
      const sessionUuid = "22222222-3333-4444-5555-666666666666";
      const sessionDir = join(projectDir, sessionUuid);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(outside, "agent.jsonl"), "x".repeat(400), "utf8");
      // ★검토자의 정확한 재현: "subagents" 폴더 자신이 junction(세션
      // UUID 폴더 자신은 real -- 3R이 이미 막은 지점과 다른 한 겹 아래).
      symlinkSync(outside, join(sessionDir, "subagents"), "junction");

      const r = collectTotalSessionBytes(
        { repoRoot: "C:\\wt", claudeHomeDir: home },
        { readdirFn: (p) => readdirSync(p) },
      );
      assert.equal(r.ok, true);
      assert.equal(r.totalBytes, 0, "3R까지는 400B로 샜다");
      assert.equal(r.fileCount, 0);
      assert.equal(r.excludedSymlinkCount, 1);
    });
  });
});

// (c) claudeHomeDir(또는 그 바로 아래 "projects") 자신이 junction --
// 검토자 실측: 외부 파일 250B.
test("★HYK-378 4R P1-2 재현+수리(경로 c): claudeHomeDir 자신이 junction이어도 뿌리 신뢰 검사에 걸린다", () => {
  withTempDir("dss-claudehome-junction-", (outer) => {
    withTempDir("dss-claudehome-junction-outside-", (outside) => {
      const claudeHomeDir = join(outer, "home");
      const projectDir = join(
        outside,
        "projects",
        deriveClaudeProjectDirName("C:\\wt"),
      );
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "leaked.jsonl"), "x".repeat(250), "utf8");
      // ★검토자의 정확한 재현: claudeHomeDir 자신이 junction(그 상위
      // 경로가 외부를 가리킴).
      symlinkSync(outside, claudeHomeDir, "junction");

      const r = collectTotalSessionBytes(
        { repoRoot: "C:\\wt", claudeHomeDir },
        { readdirFn: (p) => readdirSync(p) },
      );
      assert.equal(r.ok, true);
      assert.equal(r.totalBytes, 0, "3R까지는 250B로 샜다");
      assert.equal(r.fileCount, 0);
      assert.equal(r.excludedSymlinkCount, 1);
    });
  });
});

// ★4R 완료조건 3(불변식 M) -- 정상 세션(뿌리는 real, 파일 링크 하나만
// 신뢰 경계 밖)에서도 excludedSymlinkCount가 정확히 잡히는지 재확인
// (§M의 "생산 경로 소비" 시험은 dispatch-start-confirm-cli.test.mjs에
// 있다 -- 이 시험은 그 소비가 읽는 값의 어댑터 쪽 정확성만 고정한다).
test("★HYK-378 4R 완료조건 3(M 값 정확성): 정상 프로젝트 + 신뢰 경계 밖 파일 1개 -> excludedSymlinkCount:1", () => {
  withTempDir("dss-m-value-", (home) => {
    withTempDir("dss-m-value-outside-", (outside) => {
      const projectDir = join(
        home,
        "projects",
        deriveClaudeProjectDirName("C:\\wt"),
      );
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "main.jsonl"), "x".repeat(50), "utf8");
      writeFileSync(join(outside, "outside.jsonl"), "x".repeat(999), "utf8");
      symlinkSync(
        join(outside, "outside.jsonl"),
        join(projectDir, "linked.jsonl"),
        "file",
      );

      const r = collectTotalSessionBytes(
        { repoRoot: "C:\\wt", claudeHomeDir: home },
        { readdirFn: (p) => readdirSync(p) },
      );
      assert.equal(r.ok, true);
      assert.equal(r.totalBytes, 50);
      assert.equal(r.excludedSymlinkCount, 1);
    });
  });
});
