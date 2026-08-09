// HYK-211-seat-select coder-1 (coder-task.md §5): resolveRoleBoundSeatHandle
// mutation-kill tests -- these import a *mutated sibling copy* of the live
// orca-adapter.mjs source (written to a disposable mkdtemp dir, relative
// imports rewritten to absolute file:// URLs -- same pattern as
// scripts/supervisor/{unconsumed,seat-idle,dispatch-start,seat-liveness}-
// wire.test.mjs) and assert that each of the five required mutations turns
// RED (proves the safeguard is load-bearing, not incidental). The
// production test suite (orca-adapter.test.mjs) exercises the real
// function directly; this file exists to prove those tests fail on the
// mutated variants they are meant to catch.
//
// 정직 한계: mutation 시험은 "커밋된 HEAD"가 아니라 디스크의 현재 소스를
// 읽는다(위 선례 동일 이유).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACES_ROOT } from "./orca-adapter.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const LIVE_SRC_PATH = join(THIS_DIR, "orca-adapter.mjs");
const LIVE_SRC = readFileSync(LIVE_SRC_PATH, "utf8");

const VALID_WORKTREE = `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk-211-mutant-fixture`;

function applyMutation(src, find, replacement) {
  const count = src.split(find).length - 1;
  assert.equal(
    count,
    1,
    `mutation target string must match exactly once in the source, got ${count} -- stale or ambiguous target`,
  );
  return src.replace(find, replacement);
}

function rewriteRelativeImportsToAbsolute(src, baseDir) {
  return src.replace(
    /from\s+(["'])(\.\.?\/[^"']+)\1/g,
    (whole, quote, relPath) => {
      const absPath = join(baseDir, relPath).replace(/\\/g, "/");
      return `from ${quote}file://${absPath}${quote}`;
    },
  );
}

async function importMutatedSibling(mutate, label) {
  const rewritten = rewriteRelativeImportsToAbsolute(
    mutate(LIVE_SRC),
    THIS_DIR,
  );
  const mutantDir = mkdtempSync(
    join(tmpdir(), `hyk211-seat-select-mutant-${label}-`),
  );
  const mutantPath = join(mutantDir, "orca-adapter.mutant.mjs");
  writeFileSync(mutantPath, rewritten, "utf8");
  try {
    return await import(`file://${mutantPath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

function terminalEntry(overrides = {}) {
  return {
    handle: "term_a",
    worktreePath: VALID_WORKTREE,
    tabId: "11111111-2222-3333-4444-555555555555",
    leafId: "99999999-8888-7777-6666-555555555555",
    title: "CODER",
    connected: true,
    writable: true,
    lastOutputAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function managedWorktreeStub(path = VALID_WORKTREE) {
  return { ok: true, result: { worktrees: [{ path }] } };
}
function terminalListStub(entries) {
  return { ok: true, result: { terminals: entries } };
}
function fakeExecFn(responses) {
  function fn(argv) {
    const key =
      argv[0] === "terminal" && argv[1] === "list"
        ? "terminal-list"
        : argv[0] === "orchestration" ||
            argv[0] === "worktree" ||
            argv[0] === "terminal"
          ? argv[1]
          : argv[0];
    const entry = responses[key];
    if (entry === undefined) {
      throw new Error(
        `fakeExecFn: no stub for '${key}' (argv=${JSON.stringify(argv)})`,
      );
    }
    return entry;
  }
  return fn;
}

// ---------------------------------------------------------------------------
// §5-1 (필수, ★★): 오늘 사고 재현 -- 앞단 분류가 무너져 role을 무시하고
// "첫 후보"를 고르게 하는 변조 -> RED (검토자 좌석이 뽑힌다).
// ---------------------------------------------------------------------------
test("NC mutation/role-bound-seat-select #1 (필수, §5-1): role 무시하고 첫 후보를 matched로 삼는 변조 -> RED (동석 상황에서 검토자 좌석이 뽑힌다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  const { matched, undetermined } = partitionByRole(collected.candidates, role);`,
        `  const matched = collected.candidates.length > 0 ? [collected.candidates[0]] : [];\n  const undetermined = [];`,
      ),
    "1",
  );
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    "terminal-list": terminalListStub([
      terminalEntry({ handle: "term_review", title: "REVIEW" }),
      terminalEntry({ handle: "term_coder", title: "CODER" }),
    ]),
  });
  const r = mutant.resolveRoleBoundSeatHandle(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.equal(
    r.handle,
    "term_review",
    "mutant must reproduce today's incident -- the wrong (REVIEW) seat is picked for a CODER request (RED signal; proves role-based partitioning is load-bearing)",
  );
});

// ---------------------------------------------------------------------------
// §5-2 (필수, ★★): "거짓 유일 승자" -- 역할 판별 불가 후보를 조용히
// 탈락시키고 남은 1개를 승자로 만드는 변조 -> RED.
// ---------------------------------------------------------------------------
test("NC mutation/role-bound-seat-select #2 (필수, §5-2): undetermined 차단 분기 제거 -> RED (판별 불가 후보가 있어도 유일 승자를 선언한다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (undetermined.length > 0) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.ROLE_UNDETERMINED,
      \`orca-adapter: resolveRoleBoundSeatHandle -- \${undetermined.length} candidate(s) in worktree '\${worktreePath}' have an undetermined role (title not one of \${JSON.stringify(KNOWN_SEAT_ROLES)}) -- refusing to declare a unique '\${role}' winner while any candidate's role is unknown (handles=\${undetermined.map((c) => c.handle).join(",")})\`,
      { matchedCount: matched.length, undeterminedCount: undetermined.length },
    );
  }`,
        `  // mutated: undetermined guard removed`,
      ),
    "2",
  );
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    "terminal-list": terminalListStub([
      terminalEntry({ handle: "term_unknown", title: "" }),
      terminalEntry({ handle: "term_coder", title: "CODER" }),
    ]),
  });
  const r = mutant.resolveRoleBoundSeatHandle(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.equal(
    r.ok,
    true,
    "mutant must declare a false unique winner despite an undetermined-role candidate present (RED signal; proves the §3-1 undetermined guard is load-bearing)",
  );
});

// ---------------------------------------------------------------------------
// §5-3 (필수): fail-loud 제거 -- 0개/2개+ 거부를 지우고 "첫 번째 후보"를
// 고르게 하는 변조 -> RED.
// ---------------------------------------------------------------------------
test("NC mutation/role-bound-seat-select #3 (필수, §5-3): 0개/2개+ 거부 제거 -> RED (2개 일치 후보 중 첫 번째를 조용히 고른다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (matched.length > 1) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.AMBIGUOUS_ROLE_MATCH,
      \`orca-adapter: resolveRoleBoundSeatHandle -- \${matched.length} seats in worktree '\${worktreePath}' are titled '\${role}', refusing to guess (handles=\${matched.map((c) => c.handle).join(",")})\`,
      { matchedCount: matched.length },
    );
  }
  if (matched.length === 0) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.NOT_FOUND,
      \`orca-adapter: resolveRoleBoundSeatHandle -- no seat titled '\${role}' found for worktreePath '\${worktreePath}' (\${collected.candidates.length} other candidate(s) present, all definitively a different known role)\`,
    );
  }
  return { ok: true, handle: matched[0].handle };`,
        `  // mutated: fail-loud 0/2+ guards removed, always pick candidates[0]
  return { ok: true, handle: collected.candidates[0]?.handle };`,
      ),
    "3",
  );
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    "terminal-list": terminalListStub([
      terminalEntry({ handle: "term_a", title: "CODER" }),
      terminalEntry({ handle: "term_b", title: "CODER" }),
    ]),
  });
  const r = mutant.resolveRoleBoundSeatHandle(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.equal(
    r.ok,
    true,
    "mutant must silently pick the first of two same-role candidates instead of refusing (RED signal; proves the AMBIGUOUS/NOT_FOUND fail-loud guards are load-bearing)",
  );
});

// ---------------------------------------------------------------------------
// §5-4 (필수): 역할 결속 제거 -- 역할 대조를 지워도 통과하는 변조 -> RED.
// ---------------------------------------------------------------------------
test("NC mutation/role-bound-seat-select #4 (필수, §5-4): title==role 대조를 지우고 '판별 가능하면 무조건 matched'로 바꾸는 변조 -> RED (역할과 무관하게 좌석이 뽑힌다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `    if (classified === role) matched.push(candidate);
    else if (classified === null) undetermined.push(candidate);`,
        `    if (classified !== null) matched.push(candidate);
    else undetermined.push(candidate);`,
      ),
    "4",
  );
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    "terminal-list": terminalListStub([
      terminalEntry({ handle: "term_review", title: "REVIEW" }),
      terminalEntry({ handle: "term_coder", title: "CODER" }),
    ]),
  });
  const r = mutant.resolveRoleBoundSeatHandle(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.notEqual(
    r.handle,
    "term_coder",
    "mutant must fail to single out the CODER seat once role binding is removed (both known-role seats become 'matched' -> AMBIGUOUS, not a correct pick) (RED signal; proves role binding actually drives selection)",
  );
});

// ---------------------------------------------------------------------------
// §5-5 (필수): 단좌석 회귀 -- 후보가 정확히 1개면 역할 대조를 건너뛰고
// 무조건 통과시키는 변조 -> RED (title이 요청 role과 달라도 통과한다).
// ---------------------------------------------------------------------------
test("NC mutation/role-bound-seat-select #5 (필수, §5-5): 후보 1개면 role 대조를 생략하는 변조 -> RED (title이 요청 role과 달라도 통과한다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  const collected = collectRoleBoundCandidates(worktreePath, opts);
  if (!collected.ok) return collected;`,
        `  const collected = collectRoleBoundCandidates(worktreePath, opts);
  if (!collected.ok) return collected;
  if (collected.candidates.length === 1) {
    return { ok: true, handle: collected.candidates[0].handle };
  }`,
      ),
    "5",
  );
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    "terminal-list": terminalListStub([
      terminalEntry({ handle: "term_review_only", title: "REVIEW" }),
    ]),
  });
  const r = mutant.resolveRoleBoundSeatHandle(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.equal(
    r.ok,
    true,
    "mutant must accept the sole seat even though its title ('REVIEW') does not match the requested role ('CODER') (RED signal; proves the single-seat happy path still goes through real role binding, not a candidate-count shortcut)",
  );
});
