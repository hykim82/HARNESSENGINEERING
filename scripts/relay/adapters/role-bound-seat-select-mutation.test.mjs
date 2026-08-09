// HYK-211-seat-select coder-1/2 (coder-task.md §4): resolveRoleBoundSeatHandle
// mutation-kill tests -- these import a *mutated sibling copy* of the live
// orca-adapter.mjs source (written to a disposable mkdtemp dir, relative
// imports rewritten to absolute file:// URLs -- same pattern as
// scripts/supervisor/{unconsumed,seat-idle,dispatch-start,seat-liveness}-
// wire.test.mjs) and assert that each of the required §4 mutations turns RED
// (proves the safeguard is load-bearing, not incidental). The production
// test suite (orca-adapter.test.mjs) exercises the real function directly;
// this file exists to prove those tests fail on the mutated variants they
// are meant to catch.
//
// 2R (HYK-211-seat-select-2, P1-1 수리): 앵커가 title -> seat-registry
// (ptyId 조인)로 바뀌었으므로 mutation target 문자열도 전부 갱신했다.
// §4-4(direct-entry 배선 절단)는 이 파일이 아니라
// role-bound-seat-select-cli.test.mjs가 자식 프로세스 시험으로 고정한다
// (그 변조는 orca-adapter.mjs가 아니라 CLI 파일 자체에 대한 것이므로 여기
// 범위 밖).
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
const REGISTRY_PATH = "fake/mutant-registry.json";

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
    ptyId: "pty_default",
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
function registryRecord({ ptyId, role }) {
  return {
    schemaVersion: 1,
    ptyId,
    handle: null,
    tabId: null,
    leafId: null,
    paneKey: null,
    worktreeId: null,
    worktreePath: null,
    role,
    taskId: null,
    dispatchId: null,
    capturedAt: null,
  };
}
function fakeRegistryFs(records) {
  const text = JSON.stringify({ schemaVersion: 1, seats: records });
  return { existsFn: () => true, readFn: () => text };
}
function resolveRoleBound(mutant, role, opts) {
  return mutant.resolveRoleBoundSeatHandle(
    { role, worktreePath: VALID_WORKTREE },
    { registryPath: REGISTRY_PATH, ...opts },
  );
}

// ---------------------------------------------------------------------------
// ★★§4-1 (필수): 대장 조인 제거(역할 확인 없이 통과) -> RED. classified를
// 대장 조회 없이 항상 요청받은 role로 취급하게 만든다 -- 이러면 실제로는
// REVIEW로 기록된 좌석도 CODER 요청에 "확인 없이" 통과해 버린다.
// ---------------------------------------------------------------------------
test("NC mutation/role-bound-seat-select #1 (필수, §4-1): 대장 조인을 건너뛰고 classified를 항상 요청 role로 취급하는 변조 -> RED (등록된 역할과 무관하게 통과)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `    const classified = classifySeatRoleFromRegistry(candidate.ptyId, registry);`,
        `    const classified = role; // mutated: registry join skipped, always "confirmed"`,
      ),
    "1",
  );
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    "terminal-list": terminalListStub([
      terminalEntry({ handle: "term_review_seat", ptyId: "pty_review" }),
    ]),
  });
  const r = resolveRoleBound(mutant, "CODER", {
    execFn,
    registryFs: fakeRegistryFs([
      registryRecord({ ptyId: "pty_review", role: "REVIEW" }),
    ]),
  });
  assert.equal(
    r.ok,
    true,
    "mutant must select a seat the registry actually recorded as REVIEW for a CODER request, because it never really checked the registry (RED signal; proves the registry join is load-bearing, not decorative)",
  );
  assert.equal(r.handle, "term_review_seat");
});

// ---------------------------------------------------------------------------
// ★★§4-2 (필수): "미확정 후보가 있어도 유일 승자 선언" -- 역할 판별 불가
// 후보를 조용히 탈락시키고 남은 1개를 승자로 만드는 변조 -> RED (§3-1
// 회귀 금지, 1R에서 통과한 방어를 앵커만 바꿔 승계).
// ---------------------------------------------------------------------------
test("NC mutation/role-bound-seat-select #2 (필수, §4-2): undetermined 차단 분기 제거 -> RED (판별 불가 후보가 있어도 유일 승자를 선언한다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (undetermined.length > 0) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.ROLE_UNDETERMINED,
      \`orca-adapter: resolveRoleBoundSeatHandle -- \${undetermined.length} candidate(s) in worktree '\${worktreePath}' have an undetermined role (no unique seat-registry match with a known role) -- refusing to declare a unique '\${role}' winner while any candidate's role is unknown (roles=\${rolesText})\`,
      {
        matchedCount: matched.length,
        undeterminedCount: undetermined.length,
        candidateRoles,
      },
    );
  }`,
        `  // mutated: undetermined guard removed`,
      ),
    "2",
  );
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    "terminal-list": terminalListStub([
      terminalEntry({ handle: "term_unknown", ptyId: "pty_unregistered" }),
      terminalEntry({ handle: "term_coder", ptyId: "pty_coder" }),
    ]),
  });
  const r = resolveRoleBound(mutant, "CODER", {
    execFn,
    registryFs: fakeRegistryFs([
      registryRecord({ ptyId: "pty_coder", role: "CODER" }),
    ]),
  });
  assert.equal(
    r.ok,
    true,
    "mutant must declare a false unique winner despite an unregistered (undetermined-role) candidate present (RED signal; proves the §3-1 undetermined guard is load-bearing)",
  );
});

// ---------------------------------------------------------------------------
// §4-3 (필수): fail-loud 제거 -- 0개/2개+ 거부를 지우고 "첫 번째 후보"를
// 고르게 하는 변조 -> RED.
// ---------------------------------------------------------------------------
test("NC mutation/role-bound-seat-select #3 (필수, §4-3): 0개/2개+ 거부 제거 -> RED (2개 일치 후보 중 첫 번째를 조용히 고른다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (matched.length > 1) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.AMBIGUOUS_ROLE_MATCH,
      \`orca-adapter: resolveRoleBoundSeatHandle -- \${matched.length} seats in worktree '\${worktreePath}' registry-match '\${role}', refusing to guess (roles=\${rolesText})\`,
      { matchedCount: matched.length, candidateRoles },
    );
  }
  if (matched.length === 0) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.NOT_FOUND,
      \`orca-adapter: resolveRoleBoundSeatHandle -- no seat registry-matches '\${role}' for worktreePath '\${worktreePath}' (roles=\${rolesText})\`,
      { candidateRoles },
    );
  }
  return { ok: true, handle: matched[0].handle, candidateRoles };`,
        `  // mutated: fail-loud 0/2+ guards removed, always pick candidates[0]
  return { ok: true, handle: candidateRoles[0]?.handle, candidateRoles };`,
      ),
    "3",
  );
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    "terminal-list": terminalListStub([
      terminalEntry({ handle: "term_a", ptyId: "pty_a" }),
      terminalEntry({ handle: "term_b", ptyId: "pty_b" }),
    ]),
  });
  const r = resolveRoleBound(mutant, "CODER", {
    execFn,
    registryFs: fakeRegistryFs([
      registryRecord({ ptyId: "pty_a", role: "CODER" }),
      registryRecord({ ptyId: "pty_b", role: "CODER" }),
    ]),
  });
  assert.equal(
    r.ok,
    true,
    "mutant must silently pick the first of two same-role candidates instead of refusing (RED signal; proves the AMBIGUOUS/NOT_FOUND fail-loud guards are load-bearing)",
  );
});

// ---------------------------------------------------------------------------
// ★§4-5 (필수): 역할이 결과를 바꾸는지 -- 역할 대조 제거 시 RED. matched
// 판정에서 요청 role과의 비교를 지우고 "판별만 가능하면 무조건 matched"로
// 바꾼다.
// ---------------------------------------------------------------------------
test("NC mutation/role-bound-seat-select #5 (필수, §4-5): 요청 role과의 대조를 지우고 '판별 가능하면 무조건 matched'로 바꾸는 변조 -> RED (역할과 무관하게 좌석이 뽑힌다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `    if (classified === role) matched.push(candidate);
    else if (classified === null) undetermined.push(candidate);`,
        `    if (classified !== null) matched.push(candidate);
    else undetermined.push(candidate);`,
      ),
    "5",
  );
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    "terminal-list": terminalListStub([
      terminalEntry({ handle: "term_review", ptyId: "pty_review" }),
      terminalEntry({ handle: "term_coder", ptyId: "pty_coder" }),
    ]),
  });
  const r = resolveRoleBound(mutant, "CODER", {
    execFn,
    registryFs: fakeRegistryFs([
      registryRecord({ ptyId: "pty_review", role: "REVIEW" }),
      registryRecord({ ptyId: "pty_coder", role: "CODER" }),
    ]),
  });
  assert.notEqual(
    r.handle,
    "term_coder",
    "mutant must fail to single out the CODER seat once role binding is removed (both known-role seats become 'matched' -> AMBIGUOUS, not a correct pick) (RED signal; proves role binding actually drives selection)",
  );
});

// ---------------------------------------------------------------------------
// §4-6 (필수): 단좌석 회귀 -- 후보가 정확히 1개면 역할 대조를 건너뛰고
// 무조건 통과시키는 변조 -> RED (등록된 role이 요청 role과 달라도
// 통과한다).
// ---------------------------------------------------------------------------
test("NC mutation/role-bound-seat-select #6 (필수, §4-6): 후보 1개면 role 대조를 생략하는 변조 -> RED (등록된 role이 요청 role과 달라도 통과한다)", async () => {
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
    "6",
  );
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    "terminal-list": terminalListStub([
      terminalEntry({ handle: "term_review_only", ptyId: "pty_review_only" }),
    ]),
  });
  const r = resolveRoleBound(mutant, "CODER", {
    execFn,
    registryFs: fakeRegistryFs([
      registryRecord({ ptyId: "pty_review_only", role: "REVIEW" }),
    ]),
  });
  assert.equal(
    r.ok,
    true,
    "mutant must accept the sole seat even though the registry records it as REVIEW, not the requested CODER (RED signal; proves the single-seat happy path still goes through real role binding, not a candidate-count shortcut)",
  );
});
