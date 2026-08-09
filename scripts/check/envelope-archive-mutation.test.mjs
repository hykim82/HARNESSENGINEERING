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
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

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

function writeFixture(dir, role, taskId, droppedAt, doneAt, extra = "") {
  writeFileSync(
    join(dir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: ${droppedAt}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, `${role}.md`),
    `task_id: ${taskId}\n${extra}\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// mutation ⓐ (필수): the archive call site removed from relay-handshake.mjs
// -> the handshake still passes, but the round's text is never preserved --
// exactly the 2026-08-08 incident, now silent again.
// ---------------------------------------------------------------------------

test("mutation ⓐ (필수): autoArchiveRoundEnvelope call removed from checkRelayHandshake -> handshake still passes but no round text survives -> RED", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  autoArchiveRoundEnvelope({ role, resultContent, harnessDir });\n";
  assertExactlyOneMatch(src, target, "autoArchiveRoundEnvelope call site");
  const mutated = src.replace(target, "");

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
      "2026-08-08 06:10 KST",
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

    let roundsExist = true;
    try {
      readdirSync(join(harnessDir, "rounds"));
    } catch {
      roundsExist = false;
    }
    assert.equal(
      roundsExist,
      false,
      "RED: without the wiring, a confirmed round leaves nothing preserved -- the original 2026-08-08 incident, reintroduced silently",
    );
  });
});

// ---------------------------------------------------------------------------
// mutation ⓑ (필수): nextArchiveFileName ignores existing files and always
// returns round 1 -> two genuinely distinct rounds land on the SAME
// filename -> the second overwrites the first (덮어쓰기 재발).
// ---------------------------------------------------------------------------

test("mutation ⓑ (필수): nextArchiveFileName hardcoded to always return round 1 -> round 2 silently overwrites round 1's archive -> RED", async () => {
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
      "2026-08-08 06:10 KST",
      "outcome-note: needs-rework\n",
    );
    const first = mod.checkRelayHandshake({ role: "review", harnessDir });
    assert.equal(first.ok, true);

    writeFixture(
      harnessDir,
      "review",
      "HYK-9901",
      "2026-08-08 07:00 KST",
      "2026-08-08 07:10 KST",
      "outcome-note: looks-good\n",
    );
    const second = mod.checkRelayHandshake({ role: "review", harnessDir });
    assert.equal(second.ok, true);

    const files = readdirSync(join(harnessDir, "rounds"));
    assert.deepEqual(
      files,
      ["review-r1.md"],
      "RED-setup: only one file exists because the mutant always names round 1",
    );
    const survivor = readFileSync(
      join(harnessDir, "rounds", "review-r1.md"),
      "utf8",
    );
    assert.doesNotMatch(
      survivor,
      /needs-rework/,
      "RED: round 1's text ('needs-rework') is gone -- round 2 ('looks-good') silently overwrote it, the exact 덮어쓰기 재발 this feature exists to prevent",
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
      "2026-08-08 06:10 KST",
      "some report body with real detail\n",
    );

    const mod = await import(
      `file://${join(scriptsCheckDir, "relay-handshake.mjs")}?t=${Date.now()}`
    );
    const result = mod.checkRelayHandshake({ role: "coder", harnessDir });
    assert.equal(result.ok, true);

    const files = readdirSync(join(harnessDir, "rounds"));
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
