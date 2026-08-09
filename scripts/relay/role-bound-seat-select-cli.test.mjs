import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRoleBoundSeatSelectArgs,
  formatRoleBoundSeatSelectResult,
  runRoleBoundSeatSelectCli,
} from "./role-bound-seat-select-cli.mjs";
import {
  ROLE_BOUND_SEAT_REASON,
  WORKSPACES_ROOT,
} from "./adapters/orca-adapter.mjs";

const VALID_WORKTREE = `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk-cli-fixture`;

// HYK-211-seat-select coder-1 (coder-task.md §4 "1-B 세 요건"): CLI 파싱 +
// 사람이 읽는 출력 포맷 시험. 실 orca 호출 0(execFn fake 주입).

test("parseRoleBoundSeatSelectArgs: requires --role and --worktree", () => {
  assert.equal(parseRoleBoundSeatSelectArgs([]).ok, false);
  assert.equal(parseRoleBoundSeatSelectArgs(["--role", "CODER"]).ok, false);
  const ok = parseRoleBoundSeatSelectArgs([
    "--role",
    "CODER",
    "--worktree",
    "/wt",
  ]);
  assert.deepEqual(ok, { ok: true, role: "CODER", worktreePath: "/wt" });
});

test("parseRoleBoundSeatSelectArgs: rejects unrecognized flags and '='-syntax", () => {
  assert.equal(parseRoleBoundSeatSelectArgs(["--bogus", "x"]).ok, false);
  assert.equal(parseRoleBoundSeatSelectArgs(["--role=CODER"]).ok, false);
});

test("formatRoleBoundSeatSelectResult: ok:true shows the selected handle", () => {
  assert.equal(
    formatRoleBoundSeatSelectResult({ ok: true, handle: "term_coder" }),
    "SELECTED handle=term_coder",
  );
});

test("formatRoleBoundSeatSelectResult: ok:false shows the reason code and detail", () => {
  const line = formatRoleBoundSeatSelectResult({
    ok: false,
    roleBoundSeatReason: ROLE_BOUND_SEAT_REASON.NOT_FOUND,
    reason: "no seat titled 'CODER' found",
  });
  assert.match(line, /^REJECTED code=ROLE_BOUND_SEAT_NOT_FOUND reason=/);
});

test("runRoleBoundSeatSelectCli: bad args -> ok:false before any execFn call", () => {
  let called = false;
  const r = runRoleBoundSeatSelectCli([], {
    execFn: () => {
      called = true;
      return { ok: true, result: {} };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test("runRoleBoundSeatSelectCli: good args reach resolveRoleBoundSeatHandle via injected execFn", () => {
  const execFn = (argv) => {
    if (argv[0] === "worktree" && argv[1] === "list") {
      return { ok: true, result: { worktrees: [{ path: VALID_WORKTREE }] } };
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return {
        ok: true,
        result: {
          terminals: [
            {
              handle: "term_coder",
              worktreePath: VALID_WORKTREE,
              title: "CODER",
            },
          ],
        },
      };
    }
    throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
  };
  const r = runRoleBoundSeatSelectCli(
    ["--role", "CODER", "--worktree", VALID_WORKTREE],
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.handle, "term_coder");
});
