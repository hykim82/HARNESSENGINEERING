// HYK-204 1R §4: 변조 3종 RED. 원복은 하지 않는다 -- 각 시험이 현재 작업
// 트리 소스를 읽어 문자열 치환으로 임시 사본을 만들고, 그 사본만 실행한다
// (원본 파일은 절대 건드리지 않는다). §2-2와 동일한 비타협: 실제
// `.harness`는 절대 건드리지 않는다 -- mkdtemp 밖으로 나가지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENVELOPE_ARCHIVE_PATH = join(HERE, "envelope-archive.mjs");
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
const REJECT_STREAK_PATH = join(HERE, "reject-streak.mjs");
// HYK-186: relay-handshake.mjs now also imports "./time-authority.mjs".
const TIME_AUTHORITY_PATH = join(HERE, "time-authority.mjs");

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

// Builds an isolated scripts/check/ copy in a tmp dir so a mutated
// relay-handshake.mjs can `import "./envelope-archive.mjs"` and
// `import "./reject-streak.mjs"` by relative path without touching the
// real repo tree. Returns the scripts/check dir.
function stageScriptsCheckDir(rootDir, overrides) {
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  const files = {
    "relay-handshake.mjs": readFileSync(RELAY_HANDSHAKE_PATH, "utf8"),
    "reject-streak.mjs": readFileSync(REJECT_STREAK_PATH, "utf8"),
    "envelope-archive.mjs": readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8"),
    "time-authority.mjs": readFileSync(TIME_AUTHORITY_PATH, "utf8"),
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(scriptsCheckDir, name), content, "utf8");
  }
  return scriptsCheckDir;
}

function writeFixture(
  dir,
  role,
  taskId,
  droppedAt,
  doneAt,
  extra = "",
  headCommit = "",
) {
  writeFileSync(
    join(dir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: ${droppedAt}\n${headCommit ? `head_commit: ${headCommit}\n` : ""}`,
    "utf8",
  );
  writeFileSync(
    join(dir, `${role}.md`),
    // HYK-418 §2-1: relay-handshake now rejects a well-formed DONE line
    // with no finalize-done marker (fail-closed) -- this file's own
    // subject is envelope-archive mutation coverage, not the marker gate,
    // so carry the marker to reach that axis unmasked.
    `task_id: ${taskId}\n${headCommit ? `head_commit: ${headCommit}\n` : ""}${extra}\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

// HYK-383: REVIEW 계열 소비는 head_commit: 축(축 ⓐ+ⓑ)도 통과해야 한다 --
// 축 ⓑ가 harnessDir에서 `git rev-parse HEAD`를 직접 읽으므로(위로
// 탐색하니 harnessDir가 이 rootDir의 서브디렉터리여도 된다), rootDir를
// 진짜 git 저장소로 만들고 그 실제 HEAD를 반환한다.
function ensureGitHeadCommit(dir) {
  if (!existsSync(join(dir, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: dir,
    });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
    execFileSync(
      "git",
      [
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "envelope-archive-mutation test fixture",
      ],
      { cwd: dir },
    );
  }
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

// ---------------------------------------------------------------------------
// mutation ⓐ (필수): the archive call site removed from relay-handshake.mjs
// -> the handshake still passes, but the round's text is never preserved --
// exactly the 2026-08-08 incident, now silent again.
// ---------------------------------------------------------------------------

test("mutation ⓐ (필수): autoArchiveRoundEnvelope call removed from checkRelayHandshake -> handshake still passes but no round text survives -> RED", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  // HYK-244 2R-a: the call site now captures a return value (`const
  // envelopeArchived = ...`) for the consumption-receipt wiring, so the
  // target isolates just the call expression (not the whole statement) --
  // replacing it with `undefined` keeps `envelopeArchived` declared (no
  // ReferenceError downstream) while still skipping the actual archive
  // side effect, which is exactly what this mutation needs to prove RED.
  const target =
    "autoArchiveRoundEnvelope({\n    role,\n    resultContent,\n    harnessDir,\n  })";
  assertExactlyOneMatch(src, target, "autoArchiveRoundEnvelope call site");
  const mutated = src.replace(target, "undefined");

  await withTempDir("hyk204-mut-a-", async (dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "relay-handshake.mjs": mutated,
    });
    const harnessDir = join(dir, "harness-fixture");
    mkdirSync(harnessDir, { recursive: true });
    writeFixture(
      harnessDir,
      "coder",
      "HYK-9900",
      "2026-08-08 06:00 KST",
      "2026-08-08 06:10:00 KST",
    );

    const mod = await import(
      `file://${join(scriptsCheckDir, "relay-handshake.mjs")}?t=${Date.now()}`
    );
    const result = mod.checkRelayHandshake({ role: "coder", harnessDir });
    assert.equal(
      result.ok,
      true,
      "the handshake decision itself must be untouched by this mutation",
    );

    // HYK-241 §2 조각1: checkRelayHandshake now ALSO archives the round's
    // TASK file at a SEPARATE, unmutated call site (autoArchiveRoundTaskFile)
    // -- so `rounds/` itself now exists (holding coder-task-r1.md) even
    // under this mutation. This test's own target is the RESULT envelope
    // specifically, so the RED assertion narrows to "no coder-r*.md exists",
    // not "the whole rounds/ dir is absent".
    let resultEnvelopeFiles;
    try {
      resultEnvelopeFiles = readdirSync(join(harnessDir, "rounds")).filter(
        (f) => /^coder-r\d+\.md$/.test(f),
      );
    } catch {
      resultEnvelopeFiles = [];
    }
    assert.deepEqual(
      resultEnvelopeFiles,
      [],
      "RED: without the wiring, a confirmed round leaves the RESULT envelope unpreserved -- the original 2026-08-08 incident, reintroduced silently",
    );
  });
});

// ---------------------------------------------------------------------------
// mutation ⓑ: nextArchiveFileName ignores existing files and always returns
// round 1 -> two genuinely distinct rounds would land on the SAME filename.
//
// HYK-244 gate-unblock-1 §1 조각1 갱신 (이 시험이 RED에서 GREEN으로 바뀐
// 이유, 무르게 만든 것이 아니다): 이 시험은 원래 "번호 매기기가 틀리면
// 조용히 덮어쓴다"는 위험을 RED로 증명했다. 이번 라운드가 archiveRoundEnvelope
// 자체에 독립적인 안전장치(findCaseInsensitiveCollision, 쓰기 직전 재확인)
// 를 추가했으므로, 이제는 번호 매기기가 이렇게 고장 나도 그 안전장치가
// 충돌을 잡아 쓰기를 거부한다 -- 그래서 이 정확히 같은 변이가 더 이상
// 조용한 덮어쓰기로 이어지지 않는다(라운드 1 생존, 라운드 2는 그저 보존
// 실패로 안전하게 물러날 뿐). 이 시험은 이제 "그 방어가 실제로 작동한다"
// 는 GREEN 증거다 -- 원래 위험이 사라졌다고 주장하는 게 아니라(번호
// 매기기 자체는 여전히 고장난 채로 있다, mutated 그대로), 두 번째
// 방어선이 그 고장의 결과를 무력화한다는 것만 보인다.
// ---------------------------------------------------------------------------

test("mutation ⓑ 갱신: nextArchiveFileName이 항상 round 1을 반환하도록 고장 나도, archiveRoundEnvelope 자신의 대소문자 무관 충돌 재확인(gate-unblock-1 §1 조각1)이 덮어쓰기를 거부해 round 1이 살아남는다", async () => {
  const src = readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8");
  const target = "  return `${role}-r${maxRound + 1}.md`;\n";
  assertExactlyOneMatch(src, target, "nextArchiveFileName return line");
  const mutated = src.replace(target, "  return `${role}-r1.md`;\n");

  await withTempDir("hyk204-mut-b-", async (dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "envelope-archive.mjs": mutated,
    });
    const harnessDir = join(dir, "harness-fixture");
    mkdirSync(harnessDir, { recursive: true });
    const headCommit = ensureGitHeadCommit(dir);

    const mod = await import(
      `file://${join(scriptsCheckDir, "relay-handshake.mjs")}?t=${Date.now()}`
    );

    // NOTE: content deliberately avoids a real `verdict: approved`/
    // `verdict: rejected` line -- role "review" makes reject-streak.mjs's
    // own isReviewFamilyRole(role) true, and that module's ledger path is
    // NOT injectable (mainRepoRoot() always resolves THIS machine's actual
    // main repo, not this test's mkdtemp fixture). A genuine verdict line
    // would silently write a synthetic entry into the REAL production
    // `.harness/reject-streak.json` -- exactly the "실제 .harness를
    // 어지럽히지 마라" rule this suite must never violate.
    writeFixture(
      harnessDir,
      "review",
      "HYK-9901",
      "2026-08-08 06:00 KST",
      "2026-08-08 06:10:00 KST",
      "outcome-note: needs-rework\n",
      headCommit,
    );
    const first = mod.checkRelayHandshake({ role: "review", harnessDir });
    assert.equal(first.ok, true);

    writeFixture(
      harnessDir,
      "review",
      "HYK-9901",
      "2026-08-08 07:00 KST",
      "2026-08-08 07:10:00 KST",
      "outcome-note: looks-good\n",
      headCommit,
    );
    const second = mod.checkRelayHandshake({ role: "review", harnessDir });
    assert.equal(second.ok, true);

    // HYK-241 §2 조각1: nextTaskArchiveFileName (task-file side) is a
    // SEPARATE, unmutated function with its own return line -- filtered out
    // here since this test's target is nextArchiveFileName (result side)
    // specifically.
    const files = readdirSync(join(harnessDir, "rounds")).filter((f) =>
      /^review-r\d+\.md$/.test(f),
    );
    assert.deepEqual(
      files,
      ["review-r1.md"],
      "번호 매기기 자체는 여전히 고장 나 있다(mutated 그대로) -- round 2가 자기만의 파일을 갖지 못한다는 것은 변하지 않는다(그 자체는 이 시험의 별개 관심사가 아니다)",
    );
    const survivor = readFileSync(
      join(harnessDir, "rounds", "review-r1.md"),
      "utf8",
    );
    assert.match(
      survivor,
      /needs-rework/,
      "GREEN(gate-unblock-1 §1 조각1): round 1의 원문('needs-rework')이 살아남아야 한다 -- 번호 매기기가 고장 나 round 2가 같은 파일명을 노려도, 쓰기 직전 재확인(findCaseInsensitiveCollision)이 그 충돌을 잡아 덮어쓰기를 거부한다(조용한 덮어쓰기 재발 0)",
    );
  });
});

// ---------------------------------------------------------------------------
// mutation ⓒ (자유 선택): archiveRoundEnvelope keeps the filename scheme
// correct (round numbers still advance) but writes empty content instead of
// the round's actual text -- files "exist" per round, but hold nothing.
// This is the §4 핵심 반증 case: existence is not enough, content must be
// checked too.
// ---------------------------------------------------------------------------

test("mutation ⓒ (자유 선택): archiveRoundEnvelope writes a blank body instead of the round's verbatim text -> archive files exist (one per round) but are empty -> RED", async () => {
  const src = readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8");
  const target = '    writeFileFn(destPath, header + resultContent, "utf8");\n';
  assertExactlyOneMatch(src, target, "archive write call");
  const mutated = src.replace(
    target,
    '    writeFileFn(destPath, header, "utf8");\n',
  );

  await withTempDir("hyk204-mut-c-", async (dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "envelope-archive.mjs": mutated,
    });
    const harnessDir = join(dir, "harness-fixture");
    mkdirSync(harnessDir, { recursive: true });
    writeFixture(
      harnessDir,
      "coder",
      "HYK-9902",
      "2026-08-08 06:00 KST",
      "2026-08-08 06:10:00 KST",
      "some report body with real detail\n",
    );

    const mod = await import(
      `file://${join(scriptsCheckDir, "relay-handshake.mjs")}?t=${Date.now()}`
    );
    const result = mod.checkRelayHandshake({ role: "coder", harnessDir });
    assert.equal(result.ok, true);

    // HYK-241 §2 조각1: archiveRoundTaskFile's own write call uses a
    // DIFFERENT variable (`taskContent`, not `resultContent`) so this
    // mutation target still matches exactly once (unaffected) -- but it
    // still produces its own coder-task-r1.md via the separate call site,
    // filtered out here since this test's target is the RESULT side only.
    const files = readdirSync(join(harnessDir, "rounds")).filter((f) =>
      /^coder-r\d+\.md$/.test(f),
    );
    assert.deepEqual(
      files,
      ["coder-r1.md"],
      "RED-setup: the file DOES exist -- an existence-only check would wrongly pass this mutant",
    );
    const archived = readFileSync(
      join(harnessDir, "rounds", "coder-r1.md"),
      "utf8",
    );
    assert.doesNotMatch(
      archived,
      /some report body with real detail/,
      "RED: the archive file exists but its content is not the round's actual text -- preserved-in-name-only, the exact 핵심 반증 case",
    );
  });
});
