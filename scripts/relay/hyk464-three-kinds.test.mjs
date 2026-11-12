// HYK-464-teardown-3kinds-1 (coder-task.md §2, 1b_exec_line) -- 무장 teardown
// 이 «구조적으로 못 지우던 3부류» 중 기계 증거만으로 닫히는 둘(ⓑ patch-id
// 동등 · ⓒ 관제실 PM 영수증 결속)과 무장 실행 직전 HEAD 재대조(N13)의 시험.
// (ⓐ 은퇴 표지는 CODER-2 -- 이 파일에 없다.)
//
// 시험 대상 = 프로덕션 export 만이다 -- judgeArchiveEligibility(코어) ·
// observePatchEquivalence / observePmReceiptBinding(어댑터) · runWatchOnce /
// defaultPatchIdFn(watch-run 의 판정·무장 경로). 사본 import 0.
// 합성 자료만 쓴다: mkdtemp 합성 git 저장소(origin bare + main + 워크트리) +
// mkdtemp 합성 관제실(seat-launch-registry.jsonl · dispatch-receipts.jsonl ·
// PM/relay/receipts/PM-receipt-r*.json · PM/relay/pm-task.md · watch/).
// 실제 관제실·원장·다른 워크트리 쓰기 0 (live_send_ban).
//
// 이름공간 import(`import * as`)를 쓰는 이유: base(96740b9)에는 새 export 가
// 없다 -- 이름 지정 import 면 파일 전체가 SyntaxError 로 로드조차 안 돼 «칸별
// RED 원문»을 얻을 수 없다. 이름공간이면 칸마다 따로 거부/오류로 보인다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import * as watchRun from "../supervisor/watch-run.mjs";
import * as adapter from "./adapters/teardown-inventory-adapter.mjs";
import {
  judgeArchiveEligibility,
  ELIGIBILITY,
  REASON,
} from "./teardown-core.mjs";

const NOW_MS = Date.parse("2026-11-12T20:00:00+09:00");
const R_NOT_MERGED = REASON.NOT_MERGED_TO_MASTER;
const R_NO_EVIDENCE = REASON.NO_ROUND_EVIDENCE;
const R_ELIGIBLE = REASON.ARCHIVE_ELIGIBLE;

// ───────────────────────── 합성 git 저장소 ─────────────────────────
function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function setupRepo() {
  const parent = fs.mkdtempSync(path.join(tmpdir(), "nc-hyk464-3k-repo-"));
  const originRoot = path.join(parent, "origin.git");
  const mainRoot = path.join(parent, "main");
  fs.mkdirSync(originRoot, { recursive: true });
  git(originRoot, ["init", "-q", "--bare"]);
  fs.mkdirSync(mainRoot, { recursive: true });
  git(mainRoot, ["init", "-q", "-b", "master"]);
  git(mainRoot, ["config", "user.email", "t@example.com"]);
  git(mainRoot, ["config", "user.name", "T"]);
  git(mainRoot, ["config", "core.autocrlf", "false"]);
  git(mainRoot, ["remote", "add", "origin", originRoot]);
  fs.writeFileSync(path.join(mainRoot, "README.md"), "root\n");
  fs.writeFileSync(path.join(mainRoot, ".gitignore"), ".harness/\n");
  git(mainRoot, ["add", "."]);
  git(mainRoot, ["commit", "-q", "-m", "init"]);
  git(mainRoot, ["push", "-q", "origin", "master"]);
  return { parent, originRoot, mainRoot };
}

function listWorktreePaths(mainRoot) {
  return git(mainRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

// git 이 «실제로 보고하는» 경로 문자열을 돌려준다(8.3 짧은 이름 함정 --
// hyk491 시험 머리 주석 참조).
function addWorktree(repo, name, branch) {
  const wtPath = path.join(repo.parent, name);
  git(repo.mainRoot, ["worktree", "add", "-q", "-b", branch, wtPath, "master"]);
  const reported = listWorktreePaths(repo.mainRoot).find((p) =>
    p.toLowerCase().endsWith(`/${name}`.toLowerCase()),
  );
  assert.ok(reported, `git must report worktree ${name}`);
  return reported;
}

function commitFile(cwd, file, content, msg) {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", msg]);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

function headOf(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

function writeHarnessFile(wtPath, relPath, content) {
  const full = path.join(wtPath, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function withReceipts(wtPath) {
  writeHarnessFile(
    wtPath,
    ".harness/receipts/CODER-receipt-r1.json",
    JSON.stringify({ ok: true }),
  );
  writeHarnessFile(wtPath, ".harness/coder.md", "task_id: FIXTURE-1\n");
}

// 리베이스 후 병합 모양: 브랜치 커밋이 master 에 «다른 SHA, 같은 patch» 로
// 들어간다(cherry-pick). 옵션으로 반례 모양을 만든다.
function buildRebasedScenario(o = {}) {
  const repo = setupRepo();
  const wtPath = addWorktree(repo, "wt-rebased", "feature/rebased");
  const matched = [commitFile(wtPath, "f1.txt", "one\n", "c1")];
  matched.push(commitFile(wtPath, "f2.txt", "two\n", "c2"));
  commitFile(repo.mainRoot, "other.txt", "m\n", "m1"); // master 가 갈라진다.
  if (o.mergeCommit) git(wtPath, ["merge", "-q", "--no-edit", "master"]);
  if (o.emptyCommit) git(wtPath, ["commit", "-q", "--allow-empty", "-m", "e"]);
  if (o.uniqueCommit) commitFile(wtPath, "u.txt", "uniq\n", "unique");
  git(repo.mainRoot, ["cherry-pick", ...matched]);
  git(repo.mainRoot, ["push", "-q", "origin", "master"]);
  return { repo, wtPath, matched };
}

// ───────────────────────── 합성 관제실 ─────────────────────────
function makeControlRoom() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "nc-hyk464-3k-cr-"));
  // «시작 전» 전제 단언: 합성 관제실이 mkdtemp 아래가 아니면 즉시 실패.
  const tmpRoot = fs.realpathSync(tmpdir()).toLowerCase();
  assert.ok(
    fs.realpathSync(root).toLowerCase().startsWith(tmpRoot),
    "synthetic control room must live under the mkdtemp area",
  );
  const watchDir = path.join(root, "watch");
  fs.mkdirSync(watchDir, { recursive: true });
  fs.mkdirSync(path.join(root, "PM", "relay", "receipts"), { recursive: true });
  return { root, watchDir };
}

const PANE_A = "pane-a:leaf-a";
const PANE_B = "pane-b:leaf-b";
// 배달 = UTC 03:27:08 (= 12:27:08 KST) · 영수증 doneAt 은 그 뒤.
const DISPATCH_UTC = "2026-11-10 03:27:08";
const DONE_AFTER = "2026-11-10 12:42:54 KST";
const DONE_BEFORE = "2026-11-10 12:00:00 KST";

function regRow(paneKey, worktree, role = "PM") {
  return { paneKey, role, engine: "claude", worktree };
}
function disRow(paneKey, label, ts = DISPATCH_UTC, role = "PM") {
  return {
    assignee_pane_key: paneKey,
    dispatch_timestamp_utc: ts,
    role,
    harness_task_label: label,
  };
}
function receiptBody(taskId, doneAt, role = "PM") {
  return { binding: { taskId, role, doneAt } };
}

function writeControlRoom(cr, spec) {
  const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  if (spec.registry) {
    fs.writeFileSync(
      path.join(cr.root, "seat-launch-registry.jsonl"),
      typeof spec.registry === "string" ? spec.registry : jsonl(spec.registry),
    );
  }
  if (spec.dispatches) {
    fs.writeFileSync(
      path.join(cr.root, "dispatch-receipts.jsonl"),
      jsonl(spec.dispatches),
    );
  }
  (spec.receipts ?? []).forEach((r, i) => {
    fs.writeFileSync(
      path.join(
        cr.root,
        "PM",
        "relay",
        "receipts",
        `PM-receipt-r${i + 1}.json`,
      ),
      JSON.stringify(r),
    );
  });
  if (spec.pmTask !== undefined) {
    fs.writeFileSync(
      path.join(cr.root, "PM", "relay", "pm-task.md"),
      spec.pmTask,
    );
  }
}

const toBackslash = (p) => p.replace(/\//g, "\\");

// ───────────────────────── 실행 도구 ─────────────────────────
function unconsumedNaExecFn(paths) {
  const entries = paths.map((worktreePath) => ({
    worktreePath,
    status: "UNCONSUMED_NOT_APPLICABLE",
  }));
  return () =>
    JSON.stringify({
      verdict: "PROGRESSING",
      reasonCode: "OK",
      unconsumed: {
        status: "JUDGED",
        totalWorktrees: entries.length,
        worstWorktreePaths: [],
        worstCount: 0,
        worktrees: entries,
      },
    });
}

function runTick({
  repo,
  cr,
  teardownShadow = {},
  orcaExecFn,
  armed = false,
  execFn,
}) {
  const notifyDir = fs.mkdtempSync(path.join(tmpdir(), "nc-hyk464-3k-notify-"));
  if (armed) {
    fs.writeFileSync(
      path.join(cr.watchDir, "teardown-arm.json"),
      JSON.stringify({ armed: true }),
    );
  }
  const result = watchRun.runWatchOnce({
    repoRoot: repo.mainRoot,
    watchDir: cr.watchDir,
    notifyDir,
    now: NOW_MS,
    execFn: execFn ?? unconsumedNaExecFn(listWorktreePaths(repo.mainRoot)),
    resourceResidue: {
      worktreeListFn: () => ({
        ok: true,
        worktrees: listWorktreePaths(repo.mainRoot),
      }),
      teardownShadow,
      ...(orcaExecFn ? { orcaExecFn } : {}),
    },
  });
  return {
    shadow: result.resourceResidueResult.teardownShadowResult,
    notifyDir,
    result,
  };
}

function entryOf(shadow, wtPath) {
  const e = shadow.entries.find((x) => x.worktreePath === wtPath);
  assert.ok(e, `entry for ${wtPath}`);
  return e;
}
const verdictOf = (e) => ({ eligibility: e.eligibility, reason: e.reason });

function cleanup(dirs) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

// ═══════════════════ §(f) 4칸 (프로덕션 진입점 · 실 git · 합성 관제실) ═══════════════════

test("HYK-464-3kinds: ⓑ patch-id equivalent -> ELIGIBLE", () => {
  const { repo, wtPath } = buildRebasedScenario();
  const cr = makeControlRoom();
  try {
    withReceipts(wtPath);
    const { shadow, notifyDir } = runTick({ repo, cr });
    const e = entryOf(shadow, wtPath);
    // 조상이 아님을 먼저 못 박는다(이게 ⓑ 의 전제).
    const anc = (() => {
      try {
        git(wtPath, ["merge-base", "--is-ancestor", "HEAD", "origin/master"]);
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(anc, false, "fixture: HEAD must NOT be an ancestor of master");
    assert.deepEqual(verdictOf(e), {
      eligibility: ELIGIBILITY.ELIGIBLE,
      reason: R_ELIGIBLE,
    });
    assert.equal(e.headSha, headOf(wtPath));
    assert.deepEqual(e.openedBy, { merge: "PATCH_ID", round: "RECEIPTS" });
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, cr.root]);
  }
});

test("HYK-464-3kinds: ⓑ one unique commit -> NOT_MERGED_TO_MASTER", () => {
  const { repo, wtPath } = buildRebasedScenario({ uniqueCommit: true });
  const cr = makeControlRoom();
  try {
    withReceipts(wtPath);
    const { shadow, notifyDir } = runTick({ repo, cr });
    assert.deepEqual(verdictOf(entryOf(shadow, wtPath)), {
      eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
      reason: R_NOT_MERGED,
    });
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, cr.root]);
  }
});

function buildPmScenario() {
  const repo = setupRepo();
  const wtPath = addWorktree(repo, "pm-x-1", "feature/pm-x");
  const cr = makeControlRoom();
  return { repo, wtPath, cr };
}

test("HYK-464-3kinds: ⓒ PM receipt bound -> ELIGIBLE", () => {
  const { repo, wtPath, cr } = buildPmScenario();
  try {
    writeControlRoom(cr, {
      registry: [regRow(PANE_A, toBackslash(wtPath))],
      dispatches: [disRow(PANE_A, "HYK-X-pm-1")],
      receipts: [receiptBody("HYK-X-pm-1", DONE_AFTER)],
    });
    const { shadow, notifyDir } = runTick({ repo, cr });
    const e = entryOf(shadow, wtPath);
    assert.deepEqual(verdictOf(e), {
      eligibility: ELIGIBILITY.ELIGIBLE,
      reason: R_ELIGIBLE,
    });
    assert.deepEqual(e.openedBy, { merge: "ANCESTOR", round: "PM_BINDING" });
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, cr.root]);
  }
});

test("HYK-464-3kinds: ⓒ unbound -> NO_ROUND_EVIDENCE", () => {
  const { repo, wtPath, cr } = buildPmScenario();
  try {
    // 관제실에 이 워크트리 행이 없다.
    writeControlRoom(cr, {
      registry: [regRow(PANE_B, "C:\\elsewhere\\other-wt")],
      dispatches: [disRow(PANE_B, "HYK-Y-pm-1")],
      receipts: [receiptBody("HYK-Y-pm-1", DONE_AFTER)],
    });
    const { shadow, notifyDir } = runTick({ repo, cr });
    assert.deepEqual(verdictOf(entryOf(shadow, wtPath)), {
      eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
      reason: R_NO_EVIDENCE,
    });
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, cr.root]);
  }
});

// ═══════════════════ 음성 칸 (프로덕션 진입점 · 실 git) ═══════════════════

function shadowVerdictForRebased(o, setup) {
  const { repo, wtPath } = buildRebasedScenario(o);
  const cr = makeControlRoom();
  try {
    withReceipts(wtPath);
    if (setup) setup({ repo, wtPath, cr });
    const { shadow, notifyDir } = runTick({ repo, cr });
    cleanup([notifyDir]);
    return verdictOf(entryOf(shadow, wtPath));
  } finally {
    cleanup([repo.parent, cr.root]);
  }
}
const REJECT_NOT_MERGED = {
  eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
  reason: R_NOT_MERGED,
};

test("HYK-464-3kinds N6/N7/N8: 병합 커밋 1 + 대응 커밋(hyk394 모양) -> 거부", () => {
  assert.deepEqual(
    shadowVerdictForRebased({ mergeCommit: true }),
    REJECT_NOT_MERGED,
  );
});

test("HYK-464-3kinds N8: 빈 커밋 1(커밋 수 != patch-id 줄 수) -> 거부", () => {
  assert.deepEqual(
    shadowVerdictForRebased({ emptyCommit: true }),
    REJECT_NOT_MERGED,
  );
});

test("HYK-464-3kinds N3: keep-reason.md 있음 + patch-id 동등 -> KEEP_REASON_PRESENT (검사 3 이 새 길보다 앞)", () => {
  const v = shadowVerdictForRebased({}, ({ wtPath }) =>
    writeHarnessFile(wtPath, ".harness/keep-reason.md", "keep this\n"),
  );
  assert.deepEqual(v, {
    eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
    reason: REASON.KEEP_REASON_PRESENT,
  });
});

test("HYK-464-3kinds N12: patchIdFn 이 던지면(시간 초과 등) 관측 안 됨 -> 기존 NOT_MERGED_TO_MASTER 로 거부", () => {
  const { repo, wtPath } = buildRebasedScenario();
  const cr = makeControlRoom();
  try {
    withReceipts(wtPath);
    const { shadow, notifyDir } = runTick({
      repo,
      cr,
      teardownShadow: {
        patchIdFn: () => {
          throw new Error("timeout");
        },
      },
    });
    assert.deepEqual(verdictOf(entryOf(shadow, wtPath)), REJECT_NOT_MERGED);
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, cr.root]);
  }
});

function pmNegativeCases() {
  return [...pmNegativeCasesStructure(), ...pmNegativeCasesTiming()];
}

function pmNegativeCasesStructure() {
  return [
    {
      name: "N4 진행 중 PM 좌석(배달 O · 영수증 0)",
      spec: (wt) => ({
        registry: [regRow(PANE_A, toBackslash(wt))],
        dispatches: [disRow(PANE_A, "HYK-X-pm-1")],
        receipts: [],
      }),
    },
    {
      name: "N4b pm-153-2 모양: 배달 2 · 영수증 1 (두 번째 영수증 0)",
      spec: (wt) => ({
        registry: [
          regRow(PANE_A, toBackslash(wt)),
          regRow(PANE_B, toBackslash(wt)),
        ],
        dispatches: [
          disRow(PANE_A, "HYK-X-pm-1"),
          disRow(PANE_B, "HYK-X-pm-2"),
        ],
        receipts: [receiptBody("HYK-X-pm-1", DONE_AFTER)],
      }),
    },
    {
      name: "C1 REVIEW 행 혼입",
      spec: (wt) => ({
        registry: [
          regRow(PANE_A, toBackslash(wt)),
          regRow(PANE_B, toBackslash(wt), "REVIEW"),
        ],
        dispatches: [disRow(PANE_A, "HYK-X-pm-1")],
        receipts: [receiptBody("HYK-X-pm-1", DONE_AFTER)],
      }),
    },
    {
      name: "C2 paneKey 중복(등록부 전체 2행)",
      spec: (wt) => ({
        registry: [
          regRow(PANE_A, toBackslash(wt)),
          regRow(PANE_A, "C:\\elsewhere\\dup"),
        ],
        dispatches: [disRow(PANE_A, "HYK-X-pm-1")],
        receipts: [receiptBody("HYK-X-pm-1", DONE_AFTER)],
      }),
    },
  ];
}

function pmNegativeCasesTiming() {
  return [
    {
      name: "C4 영수증이 배달보다 이전(시각 거꾸로)",
      spec: (wt) => ({
        registry: [regRow(PANE_A, toBackslash(wt))],
        dispatches: [disRow(PANE_A, "HYK-X-pm-1")],
        receipts: [receiptBody("HYK-X-pm-1", DONE_BEFORE)],
      }),
    },
    {
      name: "C4 영수증 role 이 PM 이 아님(REVIEW 영수증 혼입)",
      spec: (wt) => ({
        registry: [regRow(PANE_A, toBackslash(wt))],
        dispatches: [disRow(PANE_A, "HYK-X-pm-1")],
        receipts: [receiptBody("HYK-X-pm-1", DONE_AFTER, "REVIEW")],
      }),
    },
    {
      name: "C5/N5 pm-task.md 배달 전 구간(task_id 영수증 없음 · worktree 첫 토큰 == 이 워크트리)",
      spec: (wt) => ({
        registry: [regRow(PANE_A, toBackslash(wt))],
        dispatches: [disRow(PANE_A, "HYK-X-pm-1")],
        receipts: [receiptBody("HYK-X-pm-1", DONE_AFTER)],
        pmTask: `task_id: HYK-NEXT-pm-1\nworktree: ${toBackslash(wt)} (좌석 cwd 용 · 읽기 전용 사본)\n`,
      }),
    },
    {
      name: "C5 pm-task.md worktree 줄을 해석할 수 없음",
      spec: (wt) => ({
        registry: [regRow(PANE_A, toBackslash(wt))],
        dispatches: [disRow(PANE_A, "HYK-X-pm-1")],
        receipts: [receiptBody("HYK-X-pm-1", DONE_AFTER)],
        pmTask: "task_id: HYK-NEXT-pm-1\nno worktree line here\n",
      }),
    },
    {
      name: "N12 등록부 JSON 줄이 깨짐(관측 안 됨)",
      spec: (wt) => ({
        registry: `${JSON.stringify(regRow(PANE_A, toBackslash(wt)))}\n{broken\n`,
        dispatches: [disRow(PANE_A, "HYK-X-pm-1")],
        receipts: [receiptBody("HYK-X-pm-1", DONE_AFTER)],
      }),
    },
  ];
}

test("HYK-464-3kinds N4/N5/N9/N12/C1/C2: 관제실 결속 음성 칸 전수 (프로덕션 진입점)", () => {
  for (const c of pmNegativeCases()) {
    const { repo, wtPath, cr } = buildPmScenario();
    try {
      writeControlRoom(cr, c.spec(wtPath));
      const { shadow, notifyDir } = runTick({ repo, cr });
      assert.deepEqual(
        verdictOf(entryOf(shadow, wtPath)),
        {
          eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
          reason: R_NO_EVIDENCE,
        },
        c.name,
      );
      cleanup([notifyDir]);
    } finally {
      cleanup([repo.parent, cr.root]);
    }
  }
});

test("HYK-464-3kinds N9: 관제실 루트가 아닌 watch/ 아래 낡은 사본만 있으면 관측 안 됨 -> 거부", () => {
  const { repo, wtPath, cr } = buildPmScenario();
  try {
    // 루트에는 아무것도 없고 watch/ 아래에만 «완벽히 묶이는» 사본이 있다.
    fs.writeFileSync(
      path.join(cr.watchDir, "seat-launch-registry.jsonl"),
      JSON.stringify(regRow(PANE_A, toBackslash(wtPath))) + "\n",
    );
    fs.writeFileSync(
      path.join(cr.watchDir, "dispatch-receipts.jsonl"),
      JSON.stringify(disRow(PANE_A, "HYK-X-pm-1")) + "\n",
    );
    const { shadow, notifyDir } = runTick({ repo, cr });
    assert.deepEqual(verdictOf(entryOf(shadow, wtPath)), {
      eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
      reason: R_NO_EVIDENCE,
    });
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, cr.root]);
  }
});

test("HYK-464-3kinds 양성: pm-153-2 모양(pane 2 · 배달 2 · 영수증 2 · 번호는 라벨 결속과 무관) + 다른 워크트리 PM 행은 무관 -> bound", () => {
  const { repo, wtPath, cr } = buildPmScenario();
  try {
    writeControlRoom(cr, {
      registry: [
        regRow(PANE_A, toBackslash(wtPath)),
        regRow(PANE_B, toBackslash(wtPath).toUpperCase()),
        regRow("pane-z:leaf-z", "C:\\elsewhere\\other", "REVIEW"),
      ],
      dispatches: [
        disRow(PANE_A, "HYK-X-pm-1"),
        disRow(PANE_B, "HYK-X-pm-2", "2026-11-11 02:00:00"),
        disRow(
          "pane-z:leaf-z",
          "HYK-Z-review-1",
          "2026-11-11 02:00:00",
          "REVIEW",
        ),
      ],
      // 번호 r1 ↔ 두 번째 라벨, r2 ↔ 첫 라벨 (번호로 묶으면 틀린다).
      receipts: [
        receiptBody("HYK-X-pm-2", "2026-11-11 12:00:00 KST"),
        receiptBody("HYK-X-pm-1", DONE_AFTER),
      ],
      pmTask: "task_id: HYK-X-pm-2\nworktree: C:\\elsewhere\\next\n",
    });
    const { shadow, notifyDir } = runTick({ repo, cr });
    assert.deepEqual(verdictOf(entryOf(shadow, wtPath)), {
      eligibility: ELIGIBILITY.ELIGIBLE,
      reason: R_ELIGIBLE,
    });
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, cr.root]);
  }
});

test("HYK-464-3kinds N1: 본체 체크아웃은 PM 결속이 있어도 MAIN_CHECKOUT 으로 거부 (검사 5 가 새 길보다 앞)", () => {
  const { repo, wtPath, cr } = buildPmScenario();
  try {
    const mainPath = listWorktreePaths(repo.mainRoot)[0];
    writeControlRoom(cr, {
      registry: [regRow(PANE_A, toBackslash(mainPath))],
      dispatches: [disRow(PANE_A, "HYK-X-pm-1")],
      receipts: [receiptBody("HYK-X-pm-1", DONE_AFTER)],
    });
    const { shadow, notifyDir } = runTick({ repo, cr });
    assert.deepEqual(verdictOf(entryOf(shadow, mainPath)), {
      eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
      reason: REASON.MAIN_CHECKOUT,
    });
    assert.ok(wtPath);
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, cr.root]);
  }
});

// ═══════════════════ 코어: 숫자 불변식 재확인 · 순서 · fail-closed ═══════════════════

const H = "a".repeat(40);
const R = "b".repeat(40);
const MB = "c".repeat(40);
const CM = (n) => String(n).repeat(40).slice(0, 40);

function goodPatchEquivalence(o = {}) {
  return {
    observable: true,
    equivalent: true,
    cause: null,
    headSha: H,
    remoteMasterSha: R,
    mergeBaseSha: MB,
    branchMergeCount: 0,
    branchCommitCount: 2,
    masterCommitCount: 21,
    patchIdLineCount: 2,
    matchedCount: 2,
    unmatched: [],
    ...o,
  };
}
function goodPmBinding(o = {}) {
  return {
    observable: true,
    bound: true,
    cause: null,
    paneCount: 2,
    dispatchCount: 2,
    consumedCount: 2,
    nonPmRowCount: 0,
    ambiguousPaneCount: 0,
    unconsumedLabels: [],
    preDispatchWindowOpen: false,
    ...o,
  };
}
function baseInv(o = {}) {
  return {
    mergeStatus: {
      observable: true,
      isAncestorOfRemoteMaster: true,
      headSha: H,
      remoteMasterSha: R,
    },
    unconsumedRounds: {
      observable: true,
      count: 0,
      consumedViaRetirement: false,
    },
    keepReason: { observable: true, present: false, firstLine: null },
    archiveManifest: {
      observable: true,
      files: [{ path: ".harness/coder.md", bytes: 1, sha256: "a".repeat(64) }],
    },
    mainCheckout: { observable: true, isMain: false },
    roundEvidence: { observable: true, count: 1 },
    ...o,
  };
}
const notAncestor = {
  observable: true,
  isAncestorOfRemoteMaster: false,
  headSha: H,
  remoteMasterSha: R,
};
const judge = (inventory) => judgeArchiveEligibility({ inventory });

test("HYK-464-3kinds core: 기존 길은 무변 -- 조상 + 영수증 -> ELIGIBLE, openedBy = ANCESTOR / RECEIPTS", () => {
  const r = judge(baseInv());
  assert.equal(r.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.deepEqual(r.evidence.openedBy, {
    merge: "ANCESTOR",
    round: "RECEIPTS",
  });
  assert.equal(r.allowSink, false);
});

test("HYK-464-3kinds core ⓑ: 어댑터 증거가 숫자 불변식을 전부 만족하면 PATCH_ID 로 병합 통과", () => {
  const r = judge(
    baseInv({
      mergeStatus: notAncestor,
      patchEquivalence: goodPatchEquivalence(),
    }),
  );
  assert.equal(r.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.deepEqual(r.evidence.openedBy, {
    merge: "PATCH_ID",
    round: "RECEIPTS",
  });
});

test("HYK-464-3kinds core ⓑ 재확인(M1·M3 코어 자리): equivalent:true 를 믿지 않고 숫자 불변식 하나라도 깨지면 거부", () => {
  const forged = [
    // 다른 숫자는 전부 «맞게» 두고 unmatched 만 비어 있지 않게 -- M1(unmatched.length===0 삭제) 표적.
    ["미대응 1개인데 equivalent:true", { unmatched: [CM(1)] }],
    ["unmatched 가 배열이 아님", { unmatched: null }],
    ["병합 커밋 1개인데 equivalent:true", { branchMergeCount: 1 }],
    ["patch-id 줄 수 != 커밋 수", { patchIdLineCount: 1 }],
    ["matchedCount != 커밋 수", { matchedCount: 1 }],
    [
      "브랜치 커밋 0개",
      { branchCommitCount: 0, patchIdLineCount: 0, matchedCount: 0 },
    ],
    [
      "브랜치 상한 50 초과",
      { branchCommitCount: 51, patchIdLineCount: 51, matchedCount: 51 },
    ],
    ["master 쪽 상한 1000 초과", { masterCommitCount: 1001 }],
    ["숫자가 문자열", { branchCommitCount: "2" }],
    ["headSha 가 mergeStatus 와 다름", { headSha: "d".repeat(40) }],
    [
      "remoteMasterSha 가 mergeStatus 와 다름",
      { remoteMasterSha: "d".repeat(40) },
    ],
    ["headSha 없음", { headSha: undefined }],
  ];
  for (const [name, patch] of forged) {
    const r = judge(
      baseInv({
        mergeStatus: notAncestor,
        patchEquivalence: goodPatchEquivalence(patch),
      }),
    );
    assert.equal(r.reason, R_NOT_MERGED, name);
    assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE, name);
  }
});

test("HYK-464-3kinds core ⓑ 경계: 브랜치 50 · master 1000 은 통과(상한 «이하»)", () => {
  const r = judge(
    baseInv({
      mergeStatus: notAncestor,
      patchEquivalence: goodPatchEquivalence({
        branchCommitCount: 50,
        patchIdLineCount: 50,
        matchedCount: 50,
        masterCommitCount: 1000,
      }),
    }),
  );
  assert.equal(r.eligibility, ELIGIBILITY.ELIGIBLE);
});

test("HYK-464-3kinds core M9: observable 이 정확히 true 가 아니면(false · 필드 없음 · 문자열) 숫자가 완벽해도 새 길로 못 연다", () => {
  for (const observable of [false, undefined, "true", 1, null]) {
    const pe = goodPatchEquivalence();
    if (observable === undefined) delete pe.observable;
    else pe.observable = observable;
    const r = judge(
      baseInv({ mergeStatus: notAncestor, patchEquivalence: pe }),
    );
    assert.equal(r.reason, R_NOT_MERGED, `pe.observable=${String(observable)}`);
    const pm = goodPmBinding();
    if (observable === undefined) delete pm.observable;
    else pm.observable = observable;
    const r2 = judge(
      baseInv({ roundEvidence: { observable: true, count: 0 }, pmBinding: pm }),
    );
    assert.equal(
      r2.reason,
      R_NO_EVIDENCE,
      `pm.observable=${String(observable)}`,
    );
  }
  // 증거 필드 자체가 없거나 모양이 틀려도 마찬가지.
  for (const pe of [undefined, null, "x", [], {}]) {
    const r = judge(
      baseInv({ mergeStatus: notAncestor, patchEquivalence: pe }),
    );
    assert.equal(r.reason, R_NOT_MERGED);
  }
});

test("HYK-464-3kinds core ⓑ: mergeStatus 자체가 관측 안 됨이면 patchEquivalence 가 완벽해도 새 길은 못 연다 (기존 UNKNOWN 사유 그대로)", () => {
  const r = judge(
    baseInv({
      mergeStatus: { observable: false },
      patchEquivalence: goodPatchEquivalence(),
    }),
  );
  assert.equal(r.reason, REASON.MERGE_STATUS_UNKNOWN);
});

test("HYK-464-3kinds core ⓒ: pmBinding 숫자 불변식이 전부 맞을 때만 PM_BINDING 으로 라운드 증거 통과 (receipts 0)", () => {
  const ok = judge(
    baseInv({
      roundEvidence: { observable: true, count: 0 },
      pmBinding: goodPmBinding(),
    }),
  );
  assert.equal(ok.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.deepEqual(ok.evidence.openedBy, {
    merge: "ANCESTOR",
    round: "PM_BINDING",
  });
  const forged = [
    ["consumedCount < dispatchCount (C4 전칭)", { consumedCount: 1 }],
    ["consumedCount > dispatchCount", { consumedCount: 3 }],
    ["dispatchCount 0", { dispatchCount: 0, consumedCount: 0 }],
    ["paneCount 0", { paneCount: 0 }],
    ["PM 이 아닌 행 혼입", { nonPmRowCount: 1 }],
    ["모호한 paneKey", { ambiguousPaneCount: 1 }],
    ["미소비 라벨 존재", { unconsumedLabels: ["HYK-X-pm-2"] }],
    ["unconsumedLabels 가 배열이 아님", { unconsumedLabels: undefined }],
    ["배달 전 구간 열림", { preDispatchWindowOpen: true }],
    ["bound:false", { bound: false }],
  ];
  for (const [name, patch] of forged) {
    const r = judge(
      baseInv({
        roundEvidence: { observable: true, count: 0 },
        pmBinding: goodPmBinding(patch),
      }),
    );
    assert.equal(r.reason, R_NO_EVIDENCE, name);
  }
});

test("HYK-464-3kinds core ⓒ: roundEvidence 자체가 관측 안 됨이면 pmBinding 이 완벽해도 기존 ROUND_EVIDENCE_UNKNOWN", () => {
  const r = judge(
    baseInv({
      roundEvidence: { observable: false },
      pmBinding: goodPmBinding(),
    }),
  );
  assert.equal(r.reason, REASON.ROUND_EVIDENCE_UNKNOWN);
});

test("HYK-464-3kinds core M8: 검사 순서 불변 -- 새 길이 열려도 앞선 검사가 먼저 거부한다", () => {
  const openMerge = {
    mergeStatus: notAncestor,
    patchEquivalence: goodPatchEquivalence(),
  };
  const openRound = {
    roundEvidence: { observable: true, count: 0 },
    pmBinding: goodPmBinding(),
  };
  // 검사 2 (미소비) · 3 (keep-reason) · 4 (목록) · 5 (본체) 가 새 길(1·6)과 함께 열려도 먼저 거부.
  const cases = [
    [
      {
        unconsumedRounds: {
          observable: true,
          count: 1,
          consumedViaRetirement: false,
        },
      },
      REASON.UNCONSUMED_ROUNDS_PRESENT,
    ],
    [
      { keepReason: { observable: true, present: true, firstLine: "k" } },
      REASON.KEEP_REASON_PRESENT,
    ],
    [
      { archiveManifest: { observable: false } },
      REASON.ARCHIVE_MANIFEST_UNAVAILABLE,
    ],
    [
      { mainCheckout: { observable: true, isMain: true } },
      REASON.MAIN_CHECKOUT,
    ],
  ];
  for (const [extra, reason] of cases) {
    const a = judge(baseInv({ ...openMerge, ...extra }));
    assert.equal(a.reason, reason, `merge-opened + ${reason}`);
    const b = judge(baseInv({ ...openRound, ...extra }));
    assert.equal(b.reason, reason, `round-opened + ${reason}`);
    const c = judge(baseInv({ ...openMerge, ...openRound, ...extra }));
    assert.equal(c.reason, reason, `both-opened + ${reason}`);
  }
  // 둘 다 막혀 있으면 가장 이른 검사(병합)의 사유가 이긴다.
  const both = judge(
    baseInv({
      mergeStatus: notAncestor,
      roundEvidence: { observable: true, count: 0 },
    }),
  );
  assert.equal(both.reason, R_NOT_MERGED);
  // 새 길 둘 다 열리면 ELIGIBLE, openedBy 에 둘 다 표기.
  const all = judge(baseInv({ ...openMerge, ...openRound }));
  assert.equal(all.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.deepEqual(all.evidence.openedBy, {
    merge: "PATCH_ID",
    round: "PM_BINDING",
  });
});

test("HYK-464-3kinds core: 거부 evidence 에만 새 필드가 실린다 (사유 코드는 그대로)", () => {
  const rej = judge(
    baseInv({
      mergeStatus: notAncestor,
      patchEquivalence: goodPatchEquivalence({
        unmatched: [CM(1)],
        matchedCount: 1,
        equivalent: false,
        cause: "UNMATCHED",
      }),
    }),
  );
  assert.equal(rej.reason, R_NOT_MERGED);
  assert.equal(rej.evidence.patchEquivalence.cause, "UNMATCHED");
  const rej2 = judge(
    baseInv({
      roundEvidence: { observable: true, count: 0 },
      pmBinding: { observable: true, bound: false, cause: "NO_RECEIPT" },
    }),
  );
  assert.equal(rej2.reason, R_NO_EVIDENCE);
  assert.equal(rej2.evidence.pmBinding.cause, "NO_RECEIPT");
});

// ═══════════════════ 어댑터: observePatchEquivalence (주입형 · 프로세스 실행 0) ═══════════════════

function fakeGit(script) {
  const calls = [];
  const fn = (argv) => {
    calls.push(argv);
    if (argv[0] === "merge-base") return `${script.mergeBase ?? MB}\n`;
    if (argv[0] === "rev-list" && argv.includes("--merges")) {
      return `${script.merges ?? 0}\n`;
    }
    if (argv[0] === "rev-list" && argv.includes("--count")) {
      return `${script.masterCount ?? 5}\n`;
    }
    if (argv[0] === "rev-list") return script.branchList.join("\n") + "\n";
    throw new Error(`unexpected git argv: ${argv.join(" ")}`);
  };
  fn.calls = calls;
  return fn;
}
function fakePatchId(script) {
  const calls = [];
  const fn = (argv) => {
    calls.push(argv);
    const range = argv[argv.length - 1];
    return range.endsWith(`..${H}`) ? script.branchOut : script.masterOut;
  };
  fn.calls = calls;
  return fn;
}
const pid = (n) => String(n).repeat(40).slice(0, 40);
const lines = (pairs) => pairs.map(([p, c]) => `${p} ${c}`).join("\n") + "\n";

function observePe(script, patchScript, mergeStatus = notAncestor) {
  const gitFn = fakeGit(script);
  const patchIdFn = fakePatchId(patchScript);
  const r = adapter.observePatchEquivalence("/wt/x", mergeStatus, {
    gitFn,
    patchIdFn,
  });
  return { r, gitFn, patchIdFn };
}

test("HYK-464-3kinds adapter ⓑ: 대응 전부 -> equivalent:true + 숫자 칸", () => {
  const { r, patchIdFn } = observePe(
    { branchList: [CM(1), CM(2)], masterCount: 4 },
    {
      branchOut: lines([
        [pid(7), CM(1)],
        [pid(8), CM(2)],
      ]),
      masterOut: lines([
        [pid(7), CM(3)],
        [pid(8), CM(4)],
        [pid(9), CM(5)],
      ]),
    },
  );
  assert.equal(r.observable, true);
  assert.equal(r.equivalent, true);
  assert.equal(r.headSha, H);
  assert.equal(r.remoteMasterSha, R);
  assert.equal(r.branchMergeCount, 0);
  assert.equal(r.branchCommitCount, 2);
  assert.equal(r.patchIdLineCount, 2);
  assert.equal(r.matchedCount, 2);
  assert.deepEqual(r.unmatched, []);
  assert.equal(r.masterCommitCount, 4);
  // M2 자리: 로그 argv 는 --binary 를 반드시 싣고, 병합 커밋을 제외한다.
  assert.ok(patchIdFn.calls.length >= 2);
  for (const argv of patchIdFn.calls) {
    assert.equal(argv[0], "log");
    assert.ok(argv.includes("-p"));
    assert.ok(argv.includes("--binary"), "--binary 필수");
    assert.ok(argv.includes("--no-merges"));
  }
});

test("HYK-464-3kinds adapter ⓑ 조건 7 (M1 어댑터 자리): 미대응 1개 -> equivalent:false cause UNMATCHED", () => {
  const { r } = observePe(
    { branchList: [CM(1), CM(2)] },
    {
      branchOut: lines([
        [pid(7), CM(1)],
        [pid(6), CM(2)],
      ]),
      masterOut: lines([[pid(7), CM(3)]]),
    },
  );
  assert.equal(r.observable, true);
  assert.equal(r.equivalent, false);
  assert.equal(r.cause, "UNMATCHED");
  assert.deepEqual(r.unmatched, [CM(2)]);
});

test("HYK-464-3kinds adapter ⓑ 조건 5 (M2): patch-id 줄 수 != 커밋 수(빈 커밋) -> PATCH_ID_COUNT_MISMATCH", () => {
  const { r } = observePe(
    { branchList: [CM(1), CM(2), CM(3)] },
    {
      branchOut: lines([
        [pid(7), CM(1)],
        [pid(8), CM(2)],
      ]), // 3번째는 빈 커밋.
      masterOut: lines([
        [pid(7), CM(4)],
        [pid(8), CM(5)],
      ]),
    },
  );
  assert.equal(r.observable, true);
  assert.equal(r.equivalent, false);
  assert.equal(r.cause, "PATCH_ID_COUNT_MISMATCH");
});

test("HYK-464-3kinds adapter ⓑ 조건 5: 줄 수는 같아도 출력 커밋 집합이 rev-list 와 다르면 MISMATCH", () => {
  const { r } = observePe(
    { branchList: [CM(1), CM(2)] },
    {
      branchOut: lines([
        [pid(7), CM(1)],
        [pid(8), CM(9)],
      ]),
      masterOut: lines([
        [pid(7), CM(4)],
        [pid(8), CM(5)],
      ]),
    },
  );
  assert.equal(r.equivalent, false);
  assert.equal(r.cause, "PATCH_ID_COUNT_MISMATCH");
});

test("HYK-464-3kinds adapter ⓑ 조건 2 (M3 어댑터 자리): 병합 커밋 1개 -> HAS_MERGE (patch-id 는 아예 안 돈다)", () => {
  const { r, patchIdFn } = observePe(
    { merges: 1, branchList: [CM(1)] },
    {
      branchOut: lines([[pid(7), CM(1)]]),
      masterOut: lines([[pid(7), CM(2)]]),
    },
  );
  assert.equal(r.observable, true);
  assert.equal(r.equivalent, false);
  assert.equal(r.cause, "HAS_MERGE");
  assert.equal(r.branchMergeCount, 1);
  assert.equal(patchIdFn.calls.length, 0);
});

test("HYK-464-3kinds adapter ⓑ 조건 3·4: 브랜치 51개 · master 1001개 -> RANGE_EXCEEDED, 이하(50·1000)는 통과", () => {
  const many = Array.from({ length: 51 }, (_, i) =>
    String(i).padStart(40, "e"),
  );
  const a = observePe({ branchList: many }, { branchOut: "", masterOut: "" });
  assert.equal(a.r.equivalent, false);
  assert.equal(a.r.cause, "RANGE_EXCEEDED");
  assert.equal(a.patchIdFn.calls.length, 0);
  const b = observePe(
    { branchList: [CM(1)], masterCount: 1001 },
    {
      branchOut: lines([[pid(7), CM(1)]]),
      masterOut: lines([[pid(7), CM(2)]]),
    },
  );
  assert.equal(b.r.equivalent, false);
  assert.equal(b.r.cause, "RANGE_EXCEEDED");
  const c = observePe(
    { branchList: [CM(1)], masterCount: 1000 },
    {
      branchOut: lines([[pid(7), CM(1)]]),
      masterOut: lines([[pid(7), CM(2)]]),
    },
  );
  assert.equal(c.r.equivalent, true);
});

function patchEquivalenceUnobservableCases() {
  return [
    ...patchEquivalenceUnobservableCasesCalls(),
    ...patchEquivalenceUnobservableCasesShapes(),
  ];
}

function patchEquivalenceUnobservableCasesCalls() {
  return [
    [
      "gitFn 없음",
      (m) => adapter.observePatchEquivalence("/wt", m, { patchIdFn: () => "" }),
    ],
    [
      "patchIdFn 없음",
      (m) =>
        adapter.observePatchEquivalence("/wt", m, {
          gitFn: fakeGit({ branchList: [CM(1)] }),
        }),
    ],
    [
      "merge-base 가 던짐",
      (m) =>
        adapter.observePatchEquivalence("/wt", m, {
          gitFn: () => {
            throw new Error("no merge base");
          },
          patchIdFn: () => "",
        }),
    ],
    [
      "merge-base 출력이 sha 가 아님",
      (m) =>
        adapter.observePatchEquivalence("/wt", m, {
          gitFn: () => "garbage\n",
          patchIdFn: () => "",
        }),
    ],
    [
      "병합 수가 숫자가 아님",
      (m) =>
        adapter.observePatchEquivalence("/wt", m, {
          gitFn: (argv) => (argv[0] === "merge-base" ? `${MB}\n` : "many\n"),
          patchIdFn: () => "",
        }),
    ],
    [
      "patchIdFn 이 던짐(시간 초과)",
      (m) =>
        adapter.observePatchEquivalence("/wt", m, {
          gitFn: fakeGit({ branchList: [CM(1)] }),
          patchIdFn: () => {
            throw new Error("ETIMEDOUT");
          },
        }),
    ],
  ];
}

function patchEquivalenceUnobservableCasesShapes() {
  const good = {
    branchOut: lines([[pid(7), CM(1)]]),
    masterOut: lines([[pid(7), CM(2)]]),
  };
  return [
    [
      "patchIdFn 이 문자열이 아님",
      (m) =>
        adapter.observePatchEquivalence("/wt", m, {
          gitFn: fakeGit({ branchList: [CM(1)] }),
          patchIdFn: () => 42,
        }),
    ],
    [
      "patch-id 줄 모양이 틀림",
      (m) =>
        adapter.observePatchEquivalence("/wt", m, {
          gitFn: fakeGit({ branchList: [CM(1)] }),
          patchIdFn: () => "not a patch id line\n",
        }),
    ],
    [
      "mergeStatus 가 관측 안 됨",
      () =>
        adapter.observePatchEquivalence(
          "/wt",
          { observable: false },
          {
            gitFn: fakeGit({ branchList: [CM(1)] }),
            patchIdFn: fakePatchId(good),
          },
        ),
    ],
    [
      "mergeStatus 가 이미 조상(적용 대상 아님)",
      () =>
        adapter.observePatchEquivalence(
          "/wt",
          { ...notAncestor, isAncestorOfRemoteMaster: true },
          {
            gitFn: fakeGit({ branchList: [CM(1)] }),
            patchIdFn: fakePatchId(good),
          },
        ),
    ],
  ];
}

test("HYK-464-3kinds adapter ⓑ N12: 호출이 던지거나 모양이 틀리면 observable:false (거짓 «아니다»도 «맞다»도 지어내지 않는다)", () => {
  const bad = patchEquivalenceUnobservableCases();
  for (const [name, run] of bad) {
    const r = run(notAncestor);
    assert.deepEqual(r, { observable: false }, name);
  }
});

test("HYK-464-3kinds adapter ⓑ: 파괴 argv 0 -- git 호출은 조회성(merge-base · rev-list · log)뿐", () => {
  const { gitFn, patchIdFn } = observePe(
    { branchList: [CM(1)] },
    {
      branchOut: lines([[pid(7), CM(1)]]),
      masterOut: lines([[pid(7), CM(2)]]),
    },
  );
  const verbs = new Set([...gitFn.calls, ...patchIdFn.calls].map((a) => a[0]));
  for (const v of verbs)
    assert.ok(["merge-base", "rev-list", "log"].includes(v), v);
});

// ═══════════════════ 어댑터: 실 git 으로 patch-id (프로덕션 기본 patchIdFn) ═══════════════════

function realGitFn(argv, cwd) {
  return execFileSync("git", argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function observeRealPe(repo, wtPath) {
  const headSha = headOf(wtPath);
  const remoteSha = git(repo.mainRoot, ["rev-parse", "origin/master"]).trim();
  return adapter.observePatchEquivalence(
    wtPath,
    {
      observable: true,
      isAncestorOfRemoteMaster: false,
      headSha,
      remoteMasterSha: remoteSha,
    },
    { gitFn: realGitFn, patchIdFn: watchRun.defaultPatchIdFn },
  );
}

test("HYK-464-3kinds 실 git: 리베이스 모양 -> equivalent:true / 고유 커밋 -> UNMATCHED / 병합 -> HAS_MERGE / 빈 커밋 -> PATCH_ID_COUNT_MISMATCH", () => {
  const cases = [
    [{}, true, null],
    [{ uniqueCommit: true }, false, "UNMATCHED"],
    [{ mergeCommit: true }, false, "HAS_MERGE"],
    [{ emptyCommit: true }, false, "PATCH_ID_COUNT_MISMATCH"],
  ];
  for (const [opts, equivalent, cause] of cases) {
    const { repo, wtPath } = buildRebasedScenario(opts);
    try {
      const r = observeRealPe(repo, wtPath);
      assert.equal(r.observable, true, JSON.stringify(opts));
      assert.equal(r.equivalent, equivalent, JSON.stringify(opts));
      assert.equal(r.cause ?? null, cause, JSON.stringify(opts));
      if (equivalent) {
        assert.equal(r.branchCommitCount, 2);
        assert.equal(r.patchIdLineCount, 2);
        assert.equal(r.matchedCount, 2);
        assert.equal(r.branchMergeCount, 0);
      }
    } finally {
      cleanup([repo.parent]);
    }
  }
});

test("HYK-464-3kinds 실 git: 브랜치 커밋 51개(빈 커밋) -> RANGE_EXCEEDED (상한 50)", () => {
  const repo = setupRepo();
  const wtPath = addWorktree(repo, "wt-many", "feature/many");
  try {
    for (let i = 0; i < 51; i++) {
      git(wtPath, ["commit", "-q", "--allow-empty", "-m", `e${i}`]);
    }
    commitFile(repo.mainRoot, "other.txt", "m\n", "m1");
    git(repo.mainRoot, ["push", "-q", "origin", "master"]);
    const r = observeRealPe(repo, wtPath);
    assert.equal(r.observable, true);
    assert.equal(r.equivalent, false);
    assert.equal(r.cause, "RANGE_EXCEEDED");
  } finally {
    cleanup([repo.parent]);
  }
});

test("HYK-464-3kinds 실 git: 이진 변경 2개는 --binary 로 서로 다른 patch-id 를 낸다 (이 git 판에서 --binary 없이 같은 patch-id 가 되는 모양은 만들지 못했다 -- 그래서 --binary 필수는 argv 칸으로 지킨다)", () => {
  const repo = setupRepo();
  try {
    const mk = (name, bytes) => {
      const wt = addWorktree(repo, name, `feature/${name}`);
      fs.writeFileSync(path.join(wt, "b.bin"), Buffer.from(bytes));
      git(wt, ["add", "b.bin"]);
      git(wt, ["commit", "-q", "-m", name]);
      return wt;
    };
    const w1 = mk("bin-a", [0, 1, 2, 65, 65, 65, 65]);
    const w2 = mk("bin-b", [0, 1, 2, 66, 66, 66, 66]);
    const idOf = (wt) =>
      watchRun
        .defaultPatchIdFn(
          [
            "log",
            "-p",
            "--binary",
            "--no-merges",
            "--no-color",
            "master..HEAD",
          ],
          wt,
        )
        .split(" ")[0];
    assert.notEqual(idOf(w1), idOf(w2));
  } finally {
    cleanup([repo.parent]);
  }
});

test("HYK-464-3kinds 기본 patchIdFn: 잘못된 cwd 면 던진다 (관측 안 됨으로 접힌다)", () => {
  assert.throws(() =>
    watchRun.defaultPatchIdFn(
      ["log", "-p", "--binary", "--no-merges", "HEAD"],
      path.join(tmpdir(), "nc-hyk464-3k-does-not-exist"),
    ),
  );
});

// ═══════════════════ 어댑터: observePmReceiptBinding (주입형 · 합성 파일 맵) ═══════════════════

const CR_ROOT = "/cr";
function fsFake(files, dirs = {}) {
  const reads = [];
  return {
    reads,
    existsFn: (p) => Object.hasOwn(files, p),
    readFileFn: (p) => {
      reads.push(p);
      if (!Object.hasOwn(files, p)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    readdirFn: (d) => {
      reads.push(d);
      if (!Object.hasOwn(dirs, d)) throw new Error(`ENOENT ${d}`);
      return dirs[d];
    },
  };
}
function crFiles({ registry, dispatches, receipts = [], pmTask }) {
  const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const files = {};
  if (registry)
    files[`${CR_ROOT}/seat-launch-registry.jsonl`] =
      typeof registry === "string" ? registry : jsonl(registry);
  if (dispatches)
    files[`${CR_ROOT}/dispatch-receipts.jsonl`] = jsonl(dispatches);
  const names = [];
  receipts.forEach((r, i) => {
    const name = `PM-receipt-r${i + 1}.json`;
    names.push(name);
    files[`${CR_ROOT}/PM/relay/receipts/${name}`] =
      typeof r === "string" ? r : JSON.stringify(r);
  });
  if (pmTask !== undefined) files[`${CR_ROOT}/PM/relay/pm-task.md`] = pmTask;
  return fsFake(files, { [`${CR_ROOT}/PM/relay/receipts`]: names });
}
const WT_PM = "C:/wt/pm-x-1";
const observePm = (opts) =>
  adapter.observePmReceiptBinding(WT_PM, CR_ROOT, opts);

test("HYK-464-3kinds adapter ⓒ: pm-153-2 모양(pane 2 · 배달 2 · 영수증 2) -> bound, 숫자 칸 채움", () => {
  const r = observePm(
    crFiles({
      registry: [regRow(PANE_A, "C:\\WT\\PM-X-1"), regRow(PANE_B, WT_PM)],
      dispatches: [disRow(PANE_A, "L1"), disRow(PANE_B, "L2")],
      receipts: [receiptBody("L2", DONE_AFTER), receiptBody("L1", DONE_AFTER)],
    }),
  );
  assert.equal(r.observable, true);
  assert.equal(r.bound, true);
  assert.equal(r.paneCount, 2);
  assert.equal(r.dispatchCount, 2);
  assert.equal(r.consumedCount, 2);
  assert.equal(r.nonPmRowCount, 0);
  assert.equal(r.ambiguousPaneCount, 0);
  assert.deepEqual(r.unconsumedLabels, []);
  assert.equal(r.preDispatchWindowOpen, false);
});

test("HYK-464-3kinds adapter ⓒ M4: C4 는 전칭 -- 두 번째 배달의 영수증이 0 이면 첫 번째 영수증이 있어도 bound:false", () => {
  const r = observePm(
    crFiles({
      registry: [regRow(PANE_A, WT_PM), regRow(PANE_B, WT_PM)],
      dispatches: [disRow(PANE_A, "L1"), disRow(PANE_B, "L2")],
      receipts: [receiptBody("L1", DONE_AFTER)],
    }),
  );
  assert.equal(r.observable, true);
  assert.equal(r.bound, false);
  assert.equal(r.cause, "NO_RECEIPT");
  assert.deepEqual(r.unconsumedLabels, ["L2"]);
});

test("HYK-464-3kinds adapter ⓒ M5: C1 은 모든 행이 PM -- REVIEW 행 혼입이면 bound:false", () => {
  const r = observePm(
    crFiles({
      registry: [regRow(PANE_A, WT_PM), regRow(PANE_B, WT_PM, "REVIEW")],
      dispatches: [disRow(PANE_A, "L1")],
      receipts: [receiptBody("L1", DONE_AFTER)],
    }),
  );
  assert.equal(r.observable, true);
  assert.equal(r.bound, false);
  assert.equal(r.cause, "NON_PM_ROW");
  assert.equal(r.nonPmRowCount, 1);
});

test("HYK-464-3kinds adapter ⓒ: 등록부 행 0 / 배달 0 / paneKey 중복 / 배달 role 혼입 / 시각 역전 / 영수증 중복 -> bound:false", () => {
  const cases = [
    [
      "행 0",
      {
        registry: [regRow(PANE_A, "C:/other")],
        dispatches: [disRow(PANE_A, "L1")],
        receipts: [receiptBody("L1", DONE_AFTER)],
      },
      "NO_REGISTRY_ROW",
    ],
    [
      "배달 0",
      {
        registry: [regRow(PANE_A, WT_PM)],
        dispatches: [],
        receipts: [receiptBody("L1", DONE_AFTER)],
      },
      "NO_DISPATCH",
    ],
    [
      "paneKey 중복",
      {
        registry: [regRow(PANE_A, WT_PM), regRow(PANE_A, "C:/dup")],
        dispatches: [disRow(PANE_A, "L1")],
        receipts: [receiptBody("L1", DONE_AFTER)],
      },
      "AMBIGUOUS_PANE",
    ],
    [
      "배달 role 이 PM 아님",
      {
        registry: [regRow(PANE_A, WT_PM)],
        dispatches: [disRow(PANE_A, "L1", DISPATCH_UTC, "REVIEW")],
        receipts: [receiptBody("L1", DONE_AFTER)],
      },
      "NON_PM_DISPATCH",
    ],
    [
      "영수증 시각이 배달보다 앞",
      {
        registry: [regRow(PANE_A, WT_PM)],
        dispatches: [disRow(PANE_A, "L1")],
        receipts: [receiptBody("L1", DONE_BEFORE)],
      },
      "RECEIPT_BEFORE_DISPATCH",
    ],
    [
      "같은 라벨 영수증 2개",
      {
        registry: [regRow(PANE_A, WT_PM)],
        dispatches: [disRow(PANE_A, "L1")],
        receipts: [
          receiptBody("L1", DONE_AFTER),
          receiptBody("L1", DONE_AFTER),
        ],
      },
      "AMBIGUOUS_RECEIPT",
    ],
    [
      "영수증 role 이 PM 아님",
      {
        registry: [regRow(PANE_A, WT_PM)],
        dispatches: [disRow(PANE_A, "L1")],
        receipts: [receiptBody("L1", DONE_AFTER, "REVIEW")],
      },
      "NO_RECEIPT",
    ],
  ];
  for (const [name, spec, cause] of cases) {
    const r = observePm(crFiles(spec));
    assert.equal(r.observable, true, name);
    assert.equal(r.bound, false, name);
    assert.equal(r.cause, cause, name);
  }
});

test("HYK-464-3kinds adapter ⓒ C5: pm-task.md -- 영수증 없는 task_id + 이 워크트리 첫 경로 토큰 -> 배달 전 구간(거부) / 영수증 있는 task_id 이거나 다른 워크트리면 통과", () => {
  const base = {
    registry: [regRow(PANE_A, WT_PM)],
    dispatches: [disRow(PANE_A, "L1")],
    receipts: [receiptBody("L1", DONE_AFTER)],
  };
  const pre = observePm(
    crFiles({
      ...base,
      pmTask: "task_id: L9\nworktree: C:\\wt\\pm-x-1 (산문 · 괄호)\n",
    }),
  );
  assert.equal(pre.bound, false);
  assert.equal(pre.cause, "PRE_DISPATCH_WINDOW");
  assert.equal(pre.preDispatchWindowOpen, true);
  const unparsable = observePm(crFiles({ ...base, pmTask: "task_id: L9\n" }));
  assert.equal(unparsable.bound, false);
  assert.equal(unparsable.cause, "PRE_DISPATCH_WINDOW");
  const consumed = observePm(
    crFiles({ ...base, pmTask: "task_id: L1\nworktree: C:\\wt\\pm-x-1\n" }),
  );
  assert.equal(consumed.bound, true);
  const other = observePm(
    crFiles({ ...base, pmTask: "task_id: L9\nworktree: C:\\wt\\other-one\n" }),
  );
  assert.equal(other.bound, true);
  const none = observePm(crFiles(base));
  assert.equal(none.bound, true);
});

test("HYK-464-3kinds adapter ⓒ N9/N12: 관제실 루트 밖(watch/)은 읽지 않는다 · 파일 없음/깨짐/경로 미설정 -> observable:false", () => {
  const spec = {
    registry: [regRow(PANE_A, WT_PM)],
    dispatches: [disRow(PANE_A, "L1")],
    receipts: [receiptBody("L1", DONE_AFTER)],
  };
  const f = crFiles(spec);
  const r = observePm(f);
  assert.equal(r.bound, true);
  assert.ok(f.reads.length > 0);
  for (const p of f.reads) {
    assert.ok(p.startsWith(`${CR_ROOT}/`), p);
    assert.equal(p.includes("/watch/"), false, p);
  }
  // 루트에는 없고 watch/ 아래 사본만 있는 파일 맵 -> 관측 안 됨.
  const stale = fsFake({
    [`${CR_ROOT}/watch/seat-launch-registry.jsonl`]: JSON.stringify(
      regRow(PANE_A, WT_PM),
    ),
    [`${CR_ROOT}/watch/dispatch-receipts.jsonl`]: JSON.stringify(
      disRow(PANE_A, "L1"),
    ),
  });
  assert.deepEqual(observePm(stale), { observable: false });
  const broken = [
    crFiles({
      ...spec,
      registry: `${JSON.stringify(regRow(PANE_A, WT_PM))}\n{x\n`,
    }),
    crFiles({ ...spec, receipts: ["{not json"] }),
    crFiles({ ...spec, dispatches: undefined }),
    crFiles({ ...spec, receipts: [receiptBody("L1", "yesterday")] }),
    crFiles({ ...spec, dispatches: [disRow(PANE_A, "L1", "not a time")] }),
  ];
  for (const b of broken) assert.deepEqual(observePm(b), { observable: false });
  assert.deepEqual(adapter.observePmReceiptBinding(WT_PM, "", crFiles(spec)), {
    observable: false,
  });
  assert.deepEqual(
    adapter.observePmReceiptBinding(WT_PM, undefined, crFiles(spec)),
    { observable: false },
  );
  assert.deepEqual(observePm({}), { observable: false });
});

// ═══════════════════ N13: 무장 실행 직전 HEAD 재대조 ═══════════════════

function findBranchFor(mainRoot, targetPath) {
  for (const block of git(mainRoot, ["worktree", "list", "--porcelain"]).split(
    /\n\n+/,
  )) {
    if (block.split(/\r?\n/)[0] !== `worktree ${targetPath}`) continue;
    const m = /^branch refs\/heads\/(.+)$/m.exec(block);
    if (m) return m[1];
  }
  return null;
}
function fakeOrca(mainRoot) {
  const calls = [];
  const exec = (argv) => {
    calls.push(argv);
    if (argv[0] === "worktree" && argv[1] === "list") {
      return {
        ok: true,
        result: {
          worktrees: listWorktreePaths(mainRoot).map((p) => ({
            path: p,
            id: `wtid:${p}`,
          })),
        },
      };
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return { ok: true, result: { terminals: [] } };
    }
    if (argv[0] === "worktree" && argv[1] === "rm") {
      const target = argv
        .find((a) => a.startsWith("path:"))
        .slice("path:".length);
      const branch = findBranchFor(mainRoot, target);
      git(mainRoot, ["worktree", "remove", "--force", target]);
      if (branch) {
        try {
          git(mainRoot, ["branch", "-D", branch]);
        } catch {
          // 실제 orca 처럼 조용히 무시.
        }
      }
      return { ok: true, result: {} };
    }
    return { ok: false, reason: `unexpected argv: ${JSON.stringify(argv)}` };
  };
  exec.calls = calls;
  return exec;
}
const rmCalls = (exec) =>
  exec.calls.filter((a) => a[0] === "worktree" && a[1] === "rm");

test("HYK-464-3kinds 무장 end-to-end ⓑ: 리베이스 전 커밋에 머문 워크트리를 무장 정리가 기계 증거만으로 지운다 (받는함에 열린 문 PATCH_ID 표기, 브랜치는 SHA 로 복원)", () => {
  const { repo, wtPath } = buildRebasedScenario();
  const cr = makeControlRoom();
  const archiveRoot = fs.mkdtempSync(path.join(tmpdir(), "nc-hyk464-3k-arch-"));
  try {
    withReceipts(wtPath);
    const headBefore = headOf(wtPath);
    const orca = fakeOrca(repo.mainRoot);
    const { shadow, notifyDir } = runTick({
      repo,
      cr,
      armed: true,
      orcaExecFn: orca,
      teardownShadow: { archiveRoot },
    });
    assert.equal(rmCalls(orca).length, 1);
    assert.equal(fs.existsSync(wtPath), false);
    assert.equal(
      git(repo.mainRoot, ["rev-parse", "feature/rebased"]).trim(),
      headBefore,
    );
    assert.equal(shadow.armResult.results[0].ok, true);
    const notice = fs
      .readdirSync(notifyDir)
      .filter((n) => n.startsWith("teardown-arm-notify-"))
      .map((n) => fs.readFileSync(path.join(notifyDir, n), "utf8"))
      .join("\n");
    assert.match(notice, /PATCH_ID/);
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, cr.root, archiveRoot]);
  }
});

test("HYK-464-3kinds 무장 N13: 판정 뒤 무장 직전에 HEAD 가 움직이면 그 워크트리를 건너뛴다 (제거 0 · 워크트리 그대로 · TEARDOWN_ARM_HEAD_MOVED · 받는함에 두 SHA)", () => {
  const { repo, wtPath } = buildRebasedScenario();
  const cr = makeControlRoom();
  const archiveRoot = fs.mkdtempSync(path.join(tmpdir(), "nc-hyk464-3k-arch-"));
  try {
    withReceipts(wtPath);
    const judgedHead = headOf(wtPath);
    let headReads = 0;
    const moving = (argv, cwd) => {
      if (argv[0] === "rev-parse" && argv[1] === "HEAD" && cwd === wtPath) {
        headReads += 1;
        // 1번째 = 판정 때 · 2번째 = 무장 직전 재관측 -- 그 직전에 HEAD 를 진짜로 옮긴다.
        if (headReads === 2) commitFile(wtPath, "late.txt", "late\n", "late");
      }
      return realGitFn(argv, cwd);
    };
    const orca = fakeOrca(repo.mainRoot);
    const { shadow, notifyDir } = runTick({
      repo,
      cr,
      armed: true,
      orcaExecFn: orca,
      teardownShadow: { archiveRoot, gitFn: moving },
    });
    const e = entryOf(shadow, wtPath);
    assert.equal(e.eligibility, ELIGIBILITY.ELIGIBLE);
    assert.equal(e.headSha, judgedHead);
    assert.equal(headReads >= 2, true);
    assert.equal(
      rmCalls(orca).length,
      0,
      "HEAD 가 움직인 워크트리는 제거 호출 0",
    );
    assert.equal(fs.existsSync(wtPath), true);
    const r = shadow.armResult.results.find((x) => x.worktreePath === wtPath);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "TEARDOWN_ARM_HEAD_MOVED");
    const notice = fs
      .readdirSync(notifyDir)
      .filter((n) => n.startsWith("teardown-arm-notify-"))
      .map((n) => fs.readFileSync(path.join(notifyDir, n), "utf8"))
      .join("\n");
    assert.match(notice, /TEARDOWN_ARM_HEAD_MOVED/);
    assert.ok(notice.includes(judgedHead));
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, cr.root, archiveRoot]);
  }
});

test("HYK-464-3kinds 무장 N13: HEAD 이동은 «건너뜀» -- 뒤 워크트리는 계속 처리된다 (전체 중단 아님)", () => {
  const { repo, wtPath } = buildRebasedScenario();
  const second = addWorktree(repo, "wt-second", "feature/second");
  const cr = makeControlRoom();
  const archiveRoot = fs.mkdtempSync(path.join(tmpdir(), "nc-hyk464-3k-arch-"));
  try {
    withReceipts(wtPath);
    writeHarnessFile(second, ".harness/receipts/CODER-receipt-r1.json", "{}");
    let reads = 0;
    const moving = (argv, cwd) => {
      if (argv[0] === "rev-parse" && argv[1] === "HEAD" && cwd === wtPath) {
        reads += 1;
        if (reads === 2) commitFile(wtPath, "late.txt", "late\n", "late");
      }
      return realGitFn(argv, cwd);
    };
    const orca = fakeOrca(repo.mainRoot);
    const { shadow } = runTick({
      repo,
      cr,
      armed: true,
      orcaExecFn: orca,
      teardownShadow: { archiveRoot, gitFn: moving },
    });
    // 헛시험 방지: HEAD 가 움직인 워크트리는 판정 때 «ELIGIBLE» 이었어야 한다.
    assert.equal(entryOf(shadow, wtPath).eligibility, ELIGIBILITY.ELIGIBLE);
    const removed = rmCalls(orca).map((a) =>
      a.find((x) => x.startsWith("path:")).slice(5),
    );
    assert.deepEqual(removed, [second]);
    assert.equal(fs.existsSync(wtPath), true);
  } finally {
    cleanup([repo.parent, cr.root, archiveRoot]);
  }
});

// ═══════════════════ ⓐ 사람 승인 은퇴 표지 (HYK-464-teardown-3kinds-2 · CODER-2) ═══════════════════
// 표지는 검사 6(라운드 증거)의 «통과» OR 묶음 끝 항목 하나다. 쓰는 도구는 없다 --
// 아래 writeMarker 류는 «시험 안에서 합성 관제실에» 쓰는 시험 helper 일 뿐이다.
// 시험 대상 = 프로덕션 export(judgeArchiveEligibility · adapter.observeRetireMarker ·
// runWatchOnce). 합성 관제실은 mkdtemp 아래(관제실/통역 형제 폴더 포함)에만 만든다.

const AT_OK = "2026-11-12T19:00:00+09:00"; // NOW_MS(20:00 KST) 한 시간 전.
const RETIRE_SCHEMA = "teardown-retire-v1";

// 합성 관제실: <mkdtemp>/관제실 + 형제 <mkdtemp>/통역 (실물 형제 폴더 모양).
function makeRetireRoom() {
  const parent = fs.mkdtempSync(path.join(tmpdir(), "nc-hyk464-3k-ret-"));
  const tmpRoot = fs.realpathSync(tmpdir()).toLowerCase();
  assert.ok(
    fs.realpathSync(parent).toLowerCase().startsWith(tmpRoot),
    "synthetic control room must live under the mkdtemp area",
  );
  const root = path.join(parent, "관제실");
  const room = {
    parent,
    root,
    watchDir: path.join(root, "watch"),
    retireDir: path.join(root, "watch", "teardown-retire"),
    approvals: path.join(root, "approvals"),
    interp: path.join(parent, "통역"),
    outside: path.join(parent, "outside"),
  };
  for (const d of [
    room.retireDir,
    room.approvals,
    room.interp,
    room.outside,
    path.join(root, "PM", "relay", "receipts"),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return room;
}

// 워크트리 하나 + 그 표지/승인 근거를 합성 관제실에 만든다.
function addRetireCase(repo, room, name, o = {}) {
  const wtPath = addWorktree(repo, name, `feature/${name}`);
  const head = headOf(wtPath);
  const approvalDir = o.approvalDir ?? room.approvals;
  const approvalPath = path.join(approvalDir, `approval-${name}.md`);
  const text =
    o.approvalText ?? `승인 근거: ${name} @ ${head.slice(0, 7)} 무효 라운드\n`;
  if (o.writeApproval !== false) fs.writeFileSync(approvalPath, text);
  const body = {
    schema: RETIRE_SCHEMA,
    worktree: name,
    headSha: head,
    reasonCode: "INVALID_ROUND_LABEL",
    approvalRef: o.approvalRef ?? approvalPath,
    confirmed_by: "한용",
    at: AT_OK,
    ...(o.marker ?? {}),
  };
  for (const k of o.dropKeys ?? []) delete body[k];
  if (o.writeMarker !== false) {
    fs.writeFileSync(
      path.join(room.retireDir, `${name}.json`),
      o.rawMarker ?? JSON.stringify(body),
    );
  }
  return { wtPath, head, approvalPath, body };
}

const retireVerdict = (shadow, wtPath) => verdictOf(entryOf(shadow, wtPath));
const ELIGIBLE_V = { eligibility: ELIGIBILITY.ELIGIBLE, reason: R_ELIGIBLE };
const NO_EVIDENCE_V = {
  eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
  reason: R_NO_EVIDENCE,
};

test("HYK-464-3kinds: ⓐ marker valid -> ELIGIBLE", () => {
  const repo = setupRepo();
  const room = makeRetireRoom();
  try {
    // 승인 근거가 관제실 루트 아래(INVALID_ROUND_LABEL) / 형제 통역 폴더 아래(ABANDONED_ROUND).
    const inRoot = addRetireCase(repo, room, "rm-ok-root");
    const inInterp = addRetireCase(repo, room, "rm-ok-interp", {
      approvalDir: room.interp,
      marker: { reasonCode: "ABANDONED_ROUND" },
    });
    // 표지 없는 워크트리는 그대로 거부(기존 사유).
    const noMarker = addRetireCase(repo, room, "rm-ok-none", {
      writeMarker: false,
    });
    const { shadow, notifyDir } = runTick({ repo, cr: room });
    assert.deepEqual(retireVerdict(shadow, inRoot.wtPath), ELIGIBLE_V);
    assert.deepEqual(retireVerdict(shadow, inInterp.wtPath), ELIGIBLE_V);
    assert.deepEqual(retireVerdict(shadow, noMarker.wtPath), NO_EVIDENCE_V);
    const e = entryOf(shadow, inRoot.wtPath);
    assert.deepEqual(e.openedBy, { merge: "ANCESTOR", round: "RETIRE_MARKER" });
    assert.equal(e.headSha, inRoot.head);
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, room.parent]);
  }
});

test("HYK-464-3kinds: ⓐ 관제실에 watch/teardown-retire/ 폴더 자체가 없어도(실물 현재 상태) 판정이 죽지 않고 기존 사유로 거부", () => {
  const repo = setupRepo();
  const room = makeRetireRoom();
  try {
    const c = addRetireCase(repo, room, "rm-nodir", { writeMarker: false });
    fs.rmSync(room.retireDir, { recursive: true, force: true });
    const { shadow, notifyDir } = runTick({ repo, cr: room });
    assert.deepEqual(retireVerdict(shadow, c.wtPath), NO_EVIDENCE_V);
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, room.parent]);
  }
});

// 위조·불완전 표지 -- 전부 NO_ROUND_EVIDENCE. 한 저장소·한 회차에 워크트리 여럿을 둔다.
function retireForgedCases(repo, room) {
  const cases = {};
  const add = (key, o) => {
    cases[key] = addRetireCase(repo, room, `rm-${key}`, o);
    return cases[key];
  };
  // N10: 표지 뒤 커밋 -- 승인 근거 본문에는 «새 HEAD 앞 7자리» 도 적어 headSha 대조만 홀로 막게 한다.
  const n10 = add("n10");
  commitFile(n10.wtPath, "after.txt", "after\n", "after marker");
  // 새 HEAD 도 master 에 들어가 «병합됨» 은 유지한다 -- 막는 것이 표지의 headSha 대조뿐이게.
  git(n10.wtPath, ["push", "-q", "origin", "HEAD:master"]);
  fs.writeFileSync(
    n10.approvalPath,
    `승인 근거: rm-n10 @ ${n10.head.slice(0, 7)} / ${headOf(n10.wtPath).slice(0, 7)}\n`,
  );
  // N11: 승인 근거 파일 없음 · 이름 없음 · SHA 없음 · 이름이 더 긴 이름의 일부 · SHA 가 다른 해시의 일부.
  add("noapproval", { writeApproval: false });
  add("noname", { approvalText: "승인 근거: 이름 없음 aaaaaaa\n" });
  const nosha = add("nosha", {});
  fs.writeFileSync(nosha.approvalPath, "승인 근거: rm-nosha 만 있다\n");
  const longer = add("longer", {});
  fs.writeFileSync(
    longer.approvalPath,
    `승인: rm-longer-2 @ ${longer.head.slice(0, 7)}\n`,
  );
  const embedded = add("embedded", {});
  fs.writeFileSync(
    embedded.approvalPath,
    `승인: rm-embedded @ f${embedded.head.slice(0, 7)}\n`,
  );
  // 키 개수 · 값 규격.
  add("keys6", { dropKeys: ["confirmed_by"] });
  add("keys8", { marker: { extra: "x" } });
  add("reason", { marker: { reasonCode: "OTHER_REASON" } });
  add("schema", { marker: { schema: "teardown-retire-v2" } });
  add("wtfield", { marker: { worktree: "rm-someone-else" } });
  add("short", { marker: { headSha: "abc1234" } });
  add("whoempty", { marker: { confirmed_by: "" } });
  // 시각.
  add("future", { marker: { at: "2026-11-12T21:00:00+09:00" } });
  add("old15", { marker: { at: "2026-10-28T19:00:00+09:00" } });
  add("nooffset", { marker: { at: "2026-11-12T19:00:00" } });
  add("badday", { marker: { at: "2026-02-30T00:00:00+09:00" } });
  // 표지 2개: 같은 워크트리를 가리키는 두 번째 파일.
  const dup = add("dup");
  fs.writeFileSync(
    path.join(room.retireDir, "rm-dup-copy.json"),
    JSON.stringify(dup.body),
  );
  // approvalRef 위치: 관제실·통역 밖 / 상대경로 / 표지 파일 자기 자신.
  const outsideFile = path.join(room.outside, "approval-out.md");
  add("outside", { writeApproval: false, approvalRef: outsideFile });
  fs.writeFileSync(
    outsideFile,
    `승인: rm-outside @ ${cases.outside.head.slice(0, 7)}\n`,
  );
  add("relative", { approvalRef: "approvals/approval-rm-relative.md" });
  const selfRef = add("selfref", {});
  fs.writeFileSync(
    path.join(room.retireDir, "rm-selfref.json"),
    JSON.stringify({
      ...selfRef.body,
      approvalRef: path.join(room.retireDir, "rm-selfref.json"),
    }),
  );
  // JSON 깨짐 · 객체가 아님.
  add("broken", { rawMarker: "{ not json" });
  add("array", { rawMarker: "[]" });
  // 워크트리 안 .harness/retirements/ 만 있고 관제실 표지는 없다(재사용 금지).
  const inWt = add("inwt", { writeMarker: false });
  writeHarnessFile(
    inWt.wtPath,
    ".harness/retirements/CODER-retire-r1.json",
    JSON.stringify(inWt.body),
  );
  return cases;
}

test("HYK-464-3kinds: ⓐ marker forged|incomplete -> NO_ROUND_EVIDENCE (N10 표지 뒤 커밋 · N11 근거 없음/이름 없음/SHA 없음 · 키 6/8 · reasonCode 밖 · at 미래/15일 · 표지 2개 · approvalRef 루트 밖 · 워크트리 안 retirements 만 · JSON 깨짐)", () => {
  const repo = setupRepo();
  const room = makeRetireRoom();
  try {
    const cases = retireForgedCases(repo, room);
    const control = addRetireCase(repo, room, "rm-control"); // 같은 틀의 정상 표지 -- 헛시험 방지.
    const { shadow, notifyDir } = runTick({ repo, cr: room });
    assert.deepEqual(
      retireVerdict(shadow, control.wtPath),
      ELIGIBLE_V,
      "정상 표지 대조군은 ELIGIBLE 이어야 한다(아니면 아래 거부는 헛시험)",
    );
    for (const [key, c] of Object.entries(cases)) {
      assert.deepEqual(
        retireVerdict(shadow, c.wtPath),
        NO_EVIDENCE_V,
        `case ${key} must stay NO_ROUND_EVIDENCE`,
      );
    }
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, room.parent]);
  }
});

test("HYK-464-3kinds: ⓐ marker + junction -- 관제실 밖으로 빠지는 junction 은 거부, 관제실 안으로 도는 junction 은 해석 뒤 안이라 통과", (t) => {
  const repo = setupRepo();
  const room = makeRetireRoom();
  try {
    const escapeDir = path.join(room.approvals, "link-out");
    const innerLink = path.join(room.interp, "link-in");
    try {
      fs.symlinkSync(room.outside, escapeDir, "junction");
      fs.symlinkSync(room.approvals, innerLink, "junction");
    } catch (err) {
      t.skip(`junction 을 만들 수 없다(${err.code ?? err.message}) -- 못 쟀다`);
      return;
    }
    const esc = addRetireCase(repo, room, "rm-jesc", { writeApproval: false });
    fs.writeFileSync(
      path.join(room.outside, "approval-jesc.md"),
      `승인: rm-jesc @ ${esc.head.slice(0, 7)}\n`,
    );
    fs.writeFileSync(
      path.join(room.retireDir, "rm-jesc.json"),
      JSON.stringify({
        ...esc.body,
        approvalRef: path.join(escapeDir, "approval-jesc.md"),
      }),
    );
    const inn = addRetireCase(repo, room, "rm-jin");
    fs.writeFileSync(
      path.join(room.retireDir, "rm-jin.json"),
      JSON.stringify({
        ...inn.body,
        approvalRef: path.join(innerLink, "approval-rm-jin.md"),
      }),
    );
    const { shadow, notifyDir } = runTick({ repo, cr: room });
    assert.deepEqual(retireVerdict(shadow, esc.wtPath), NO_EVIDENCE_V);
    assert.deepEqual(retireVerdict(shadow, inn.wtPath), ELIGIBLE_V);
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, room.parent]);
  }
});

test("HYK-464-3kinds N1: 본체 체크아웃은 표지가 있어도 MAIN_CHECKOUT 으로 거부 (검사 5 가 표지보다 앞)", () => {
  const repo = setupRepo();
  const room = makeRetireRoom();
  try {
    const mainName = path.basename(repo.mainRoot);
    const mainHead = headOf(repo.mainRoot);
    const approval = path.join(room.approvals, "approval-main.md");
    fs.writeFileSync(approval, `승인: ${mainName} @ ${mainHead.slice(0, 7)}\n`);
    fs.writeFileSync(
      path.join(room.retireDir, `${mainName}.json`),
      JSON.stringify({
        schema: RETIRE_SCHEMA,
        worktree: mainName,
        headSha: mainHead,
        reasonCode: "ABANDONED_ROUND",
        approvalRef: approval,
        confirmed_by: "한용",
        at: AT_OK,
      }),
    );
    const { shadow, notifyDir } = runTick({ repo, cr: room });
    assert.equal(
      entryOf(shadow, listWorktreePaths(repo.mainRoot)[0]).reason,
      REASON.MAIN_CHECKOUT,
    );
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, room.parent]);
  }
});

test("HYK-464-3kinds N2: 미소비 결과 파일이 있는 무효 라운드는 표지가 있어도 UNCONSUMED_ROUNDS_PRESENT (표지는 검사 6 만 대신)", () => {
  const repo = setupRepo();
  const room = makeRetireRoom();
  try {
    const c = addRetireCase(repo, room, "rm-n2");
    writeHarnessFile(c.wtPath, ".harness/coder.md", "task_id: HYK-N2-1\n");
    const execFn = () =>
      JSON.stringify({
        verdict: "PROGRESSING",
        reasonCode: "OK",
        unconsumed: {
          status: "JUDGED",
          totalWorktrees: 1,
          worstWorktreePaths: [c.wtPath],
          worstCount: 1,
          worktrees: [
            {
              worktreePath: c.wtPath,
              status: "UNCONSUMED_JUDGED",
              verdict: "UNCONSUMED",
              resultFile: { path: ".harness/coder.md" },
            },
          ],
        },
      });
    const { shadow, notifyDir } = runTick({ repo, cr: room, execFn });
    assert.equal(
      entryOf(shadow, c.wtPath).reason,
      REASON.UNCONSUMED_ROUNDS_PRESENT,
    );
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, room.parent]);
  }
});

test("HYK-464-3kinds N3: keep-reason.md 있음 + 표지 -> KEEP_REASON_PRESENT / 병합 안 됨 + 표지 -> NOT_MERGED_TO_MASTER (표지는 검사 3·1 을 대신하지 않는다)", () => {
  const repo = setupRepo();
  const room = makeRetireRoom();
  try {
    const keep = addRetireCase(repo, room, "rm-n3");
    writeHarnessFile(
      keep.wtPath,
      ".harness/keep-reason.md",
      "보존\n2026-11-12\n",
    );
    const unmerged = addRetireCase(repo, room, "rm-unmerged");
    commitFile(unmerged.wtPath, "uniq.txt", "u\n", "unique");
    // 표지의 headSha·승인 근거를 «새 HEAD» 에 맞춰 다시 쓴다 -- 병합 검사만 홀로 막게 한다.
    const newHead = headOf(unmerged.wtPath);
    fs.writeFileSync(
      unmerged.approvalPath,
      `승인: rm-unmerged @ ${newHead.slice(0, 7)}\n`,
    );
    fs.writeFileSync(
      path.join(room.retireDir, "rm-unmerged.json"),
      JSON.stringify({ ...unmerged.body, headSha: newHead }),
    );
    const { shadow, notifyDir } = runTick({ repo, cr: room });
    assert.equal(
      entryOf(shadow, keep.wtPath).reason,
      REASON.KEEP_REASON_PRESENT,
    );
    assert.equal(entryOf(shadow, unmerged.wtPath).reason, R_NOT_MERGED);
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, room.parent]);
  }
});

test("HYK-464-3kinds 무장 end-to-end ⓐ: 표지가 맞는 무효 라운드 워크트리를 무장 정리가 지운다 (받는함 열린 문 RETIRE_MARKER · 브랜치는 SHA 로 복원) / 표지 없는 이웃은 그대로", () => {
  const repo = setupRepo();
  const room = makeRetireRoom();
  const archiveRoot = fs.mkdtempSync(path.join(tmpdir(), "nc-hyk464-3k-arch-"));
  try {
    const c = addRetireCase(repo, room, "rm-arm");
    const neighbor = addRetireCase(repo, room, "rm-arm-none", {
      writeMarker: false,
    });
    const orca = fakeOrca(repo.mainRoot);
    const { shadow, notifyDir } = runTick({
      repo,
      cr: room,
      armed: true,
      orcaExecFn: orca,
      teardownShadow: { archiveRoot },
    });
    assert.deepEqual(
      rmCalls(orca).map((a) => a.find((x) => x.startsWith("path:")).slice(5)),
      [c.wtPath],
    );
    assert.equal(fs.existsSync(c.wtPath), false);
    assert.equal(fs.existsSync(neighbor.wtPath), true);
    assert.equal(
      git(repo.mainRoot, ["rev-parse", "feature/rm-arm"]).trim(),
      c.head,
    );
    assert.equal(shadow.armResult.results[0].ok, true);
    const notice = fs
      .readdirSync(notifyDir)
      .filter((n) => n.startsWith("teardown-arm-notify-"))
      .map((n) => fs.readFileSync(path.join(notifyDir, n), "utf8"))
      .join("\n");
    assert.match(notice, /RETIRE_MARKER/);
    cleanup([notifyDir]);
  } finally {
    cleanup([repo.parent, room.parent, archiveRoot]);
  }
});

// ───────── 코어: judgeArchiveEligibility 의 ROUND_EVIDENCE_OPENERS 끝 항목 ─────────

function goodRetireMarker(o = {}) {
  return {
    observable: true,
    valid: true,
    cause: null,
    worktree: "rm-x",
    headSha: H,
    reasonCode: "INVALID_ROUND_LABEL",
    approvalRef: "/cr/approvals/a.md",
    confirmedBy: "한용",
    at: AT_OK,
    markerCount: 1,
    approvalNamesWorktree: true,
    approvalNamesHeadPrefix: true,
    approvalInsideAllowedRoot: true,
    atNotFuture: true,
    atWithin14Days: true,
    ...o,
  };
}
const zeroReceipts = { roundEvidence: { observable: true, count: 0 } };

test("HYK-464-3kinds core ⓐ: 표지 증거가 전부 맞으면 RETIRE_MARKER 로 라운드 증거 통과 (receipts 0) -- 기존 길이 먼저 열리면 그 표기가 이긴다", () => {
  const r = judge(
    baseInv({ ...zeroReceipts, retireMarker: goodRetireMarker() }),
  );
  assert.equal(r.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.deepEqual(r.evidence.openedBy, {
    merge: "ANCESTOR",
    round: "RETIRE_MARKER",
  });
  const withReceipts = judge(
    baseInv({
      roundEvidence: { observable: true, count: 2 },
      retireMarker: goodRetireMarker(),
    }),
  );
  assert.equal(withReceipts.evidence.openedBy.round, "RECEIPTS");
  const withPm = judge(
    baseInv({
      ...zeroReceipts,
      pmBinding: goodPmBinding(),
      retireMarker: goodRetireMarker(),
    }),
  );
  assert.equal(withPm.evidence.openedBy.round, "PM_BINDING");
});

function retireMarkerBreakers() {
  return [
    ["valid:false", { valid: false }],
    ["valid 없음", { valid: undefined }],
    ["valid 문자열", { valid: "true" }],
    ["observable:false", { observable: false }],
    ["observable 없음", { observable: undefined }],
    ["observable 문자열", { observable: "true" }],
    ["observable 1", { observable: 1 }],
    ["headSha 불일치(표지 뒤 커밋)", { headSha: "d".repeat(40) }],
    ["headSha 짧음", { headSha: "aaaaaaa" }],
    ["reasonCode 집합 밖", { reasonCode: "OTHER_REASON" }],
    ["reasonCode 없음", { reasonCode: undefined }],
    ["markerCount 2", { markerCount: 2 }],
    ["markerCount 0", { markerCount: 0 }],
    ["markerCount 문자열", { markerCount: "1" }],
    ["confirmedBy 빈 값", { confirmedBy: "" }],
    ["approvalRef 빈 값", { approvalRef: "" }],
    ["근거 본문에 이름 없음", { approvalNamesWorktree: false }],
    ["근거 본문에 SHA 없음", { approvalNamesHeadPrefix: false }],
    ["근거 위치 밖", { approvalInsideAllowedRoot: false }],
    ["at 미래", { atNotFuture: false }],
    ["at 14일 초과", { atWithin14Days: false }],
    ["근거 이름 플래그 없음", { approvalNamesWorktree: undefined }],
    ["at 플래그 문자열", { atNotFuture: "true" }],
  ];
}

test("HYK-464-3kinds core ⓐ 재확인(M6·M7 코어 자리): 어댑터가 valid:true 를 줘도 숫자·플래그 하나라도 깨지면 NO_ROUND_EVIDENCE, 거부 evidence 에만 retireMarker", () => {
  for (const [label, patch] of retireMarkerBreakers()) {
    const rm = goodRetireMarker();
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete rm[k];
      else rm[k] = v;
    }
    const r = judge(baseInv({ ...zeroReceipts, retireMarker: rm }));
    assert.equal(r.reason, R_NO_EVIDENCE, label);
    assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE, label);
    assert.deepEqual(r.evidence.retireMarker, rm, `${label}: evidence`);
  }
  // 표지 키 자체가 없으면 evidence 에 retireMarker 키도 없다(기존 거부 evidence 모양 무변).
  const none = judge(baseInv({ ...zeroReceipts }));
  assert.equal(none.reason, R_NO_EVIDENCE);
  assert.equal(Object.hasOwn(none.evidence, "retireMarker"), false);
  // 비객체.
  for (const bad of [null, "x", 1, [], true]) {
    const r = judge(baseInv({ ...zeroReceipts, retireMarker: bad }));
    assert.equal(r.reason, R_NO_EVIDENCE, `비객체 ${JSON.stringify(bad)}`);
  }
});

test("HYK-464-3kinds core ⓐ M8: 표지는 검사 6 만 대신한다 -- 앞선 검사 1~5 는 표지가 완벽해도 먼저 거부한다", () => {
  const open = { ...zeroReceipts, retireMarker: goodRetireMarker() };
  const cases = [
    [{ mergeStatus: notAncestor }, R_NOT_MERGED],
    [
      {
        unconsumedRounds: {
          observable: true,
          count: 1,
          consumedViaRetirement: false,
        },
      },
      REASON.UNCONSUMED_ROUNDS_PRESENT,
    ],
    [
      { keepReason: { observable: true, present: true, firstLine: "k" } },
      REASON.KEEP_REASON_PRESENT,
    ],
    [
      { archiveManifest: { observable: false } },
      REASON.ARCHIVE_MANIFEST_UNAVAILABLE,
    ],
    [
      { mainCheckout: { observable: true, isMain: true } },
      REASON.MAIN_CHECKOUT,
    ],
  ];
  for (const [extra, reason] of cases) {
    const r = judge(baseInv({ ...open, ...extra }));
    assert.equal(r.reason, reason, `marker-open + ${reason}`);
    assert.notEqual(r.eligibility, ELIGIBILITY.ELIGIBLE);
  }
});

test("HYK-464-3kinds core ⓐ: roundEvidence 자체가 관측 안 됨이면 표지가 완벽해도 기존 ROUND_EVIDENCE_UNKNOWN", () => {
  const r = judge(
    baseInv({
      roundEvidence: { observable: false },
      retireMarker: goodRetireMarker(),
    }),
  );
  assert.equal(r.reason, REASON.ROUND_EVIDENCE_UNKNOWN);
});

// ───────── 어댑터: observeRetireMarker (주입형 · 프로세스 실행 0) ─────────

const RM_ROOT = "/cr";
const RM_WT = "C:/wt/rm-x";
const RM_HEAD = "a".repeat(40);
const RM_STATUS = {
  observable: true,
  isAncestorOfRemoteMaster: true,
  headSha: RM_HEAD,
  remoteMasterSha: "b".repeat(40),
};
const RM_APPROVAL = `${RM_ROOT}/approvals/a.md`;
const RM_MARKER_PATH = `${RM_ROOT}/watch/teardown-retire/rm-x.json`;
const RM_NOW = NOW_MS;

function rmMarkerBody(o = {}) {
  return {
    schema: RETIRE_SCHEMA,
    worktree: "rm-x",
    headSha: RM_HEAD,
    reasonCode: "INVALID_ROUND_LABEL",
    approvalRef: RM_APPROVAL,
    confirmed_by: "한용",
    at: AT_OK,
    ...o,
  };
}

function rmMarkerWithout(key) {
  const m = rmMarkerBody();
  delete m[key];
  return m;
}

// o.files 로 파일을 더하고/덮고, o.dir 로 목록을 바꾼다. null 값 = 파일 없음.
function retireFake(o = {}) {
  const files = {
    [RM_MARKER_PATH]: JSON.stringify(o.marker ?? rmMarkerBody()),
    [RM_APPROVAL]: o.approval ?? "근거: rm-x @ aaaaaaa 승인\n",
    ...(o.files ?? {}),
  };
  for (const k of Object.keys(files)) if (files[k] === null) delete files[k];
  const dirs = {
    [`${RM_ROOT}/watch/teardown-retire`]: o.dir ?? ["rm-x.json"],
  };
  const reads = [];
  const real = o.real ?? {};
  return {
    reads,
    existsFn: (p) => Object.hasOwn(files, p),
    readFileFn: (p) => {
      reads.push(p);
      if (o.throwRead?.includes(p)) throw new Error(`EIO ${p}`);
      if (!Object.hasOwn(files, p)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    readdirFn: (d) => {
      reads.push(d);
      if (o.throwDir) throw new Error(`EIO ${d}`);
      if (!Object.hasOwn(dirs, d)) throw new Error(`ENOENT ${d}`);
      return dirs[d];
    },
    realpathFn: (p) => {
      if (o.throwReal?.includes(p)) throw new Error(`EIO real ${p}`);
      return real[p] ?? p;
    },
    nowMs: RM_NOW,
    ...(o.opts ?? {}),
  };
}
const observeRm = (fake, mergeStatus = RM_STATUS, root = RM_ROOT) =>
  adapter.observeRetireMarker(RM_WT, root, mergeStatus, fake);

test("HYK-464-3kinds adapter ⓐ: 정상 표지 -> valid:true + 필드·플래그 채움 / 읽은 경로는 표지 폴더와 승인 근거뿐", () => {
  const fake = retireFake();
  const r = observeRm(fake);
  assert.equal(r.observable, true);
  assert.equal(r.valid, true);
  assert.equal(r.cause, null);
  assert.equal(r.worktree, "rm-x");
  assert.equal(r.headSha, RM_HEAD);
  assert.equal(r.reasonCode, "INVALID_ROUND_LABEL");
  assert.equal(r.confirmedBy, "한용");
  assert.equal(r.markerCount, 1);
  for (const k of [
    "approvalNamesWorktree",
    "approvalNamesHeadPrefix",
    "approvalInsideAllowedRoot",
    "atNotFuture",
    "atWithin14Days",
  ]) {
    assert.equal(r[k], true, k);
  }
  for (const p of fake.reads) {
    assert.ok(
      p.startsWith(`${RM_ROOT}/watch/teardown-retire`) || p === RM_APPROVAL,
      `unexpected read: ${p}`,
    );
    assert.equal(p.includes(".harness/retirements"), false);
  }
});

test("HYK-464-3kinds adapter ⓐ: 표지 폴더의 JSON 이 아닌 이웃 파일은 표지가 될 수 없어 무시한다 (깨진 JSON 한 개가 모든 표지를 막지 않는다)", () => {
  const r = observeRm(
    retireFake({
      files: {
        "/cr/watch/teardown-retire/zz.json": "{ no",
        "/cr/watch/teardown-retire/notes.txt": "x",
      },
      dir: ["rm-x.json", "zz.json", "notes.txt"],
    }),
  );
  assert.equal(r.valid, true);
  assert.equal(r.markerCount, 1);
});

test("HYK-464-3kinds adapter ⓐ: 통역 형제 폴더 아래 승인 근거도 통과 (reasonCode ABANDONED_ROUND)", () => {
  const approval = "/통역/a.md";
  const r = observeRm(
    retireFake({
      marker: rmMarkerBody({
        approvalRef: approval,
        reasonCode: "ABANDONED_ROUND",
      }),
      files: { [approval]: "rm-x aaaaaaa\n" },
    }),
  );
  assert.equal(r.valid, true);
});

// 표지 본문(키 · 이름 · HEAD · 사유 · 시각)이 어긋난 칸.
function retireInvalidBodyCases() {
  return [
    ["no marker file", { files: { [RM_MARKER_PATH]: null } }, "NO_MARKER"],
    ["keys 6", { marker: rmMarkerWithout("confirmed_by") }, "SHAPE_MISMATCH"],
    ["keys 8", { marker: rmMarkerBody({ extra: "x" }) }, "SHAPE_MISMATCH"],
    ["array", { marker: [] }, "SHAPE_MISMATCH"],
    ["schema", { marker: rmMarkerBody({ schema: "v2" }) }, "SCHEMA_MISMATCH"],
    [
      "worktree",
      { marker: rmMarkerBody({ worktree: "rm-y" }) },
      "WORKTREE_MISMATCH",
    ],
    [
      "headSha short",
      { marker: rmMarkerBody({ headSha: "aaaaaaa" }) },
      "HEAD_INVALID",
    ],
    [
      "headSha moved (M6)",
      { marker: rmMarkerBody({ headSha: "c".repeat(40) }) },
      "HEAD_MISMATCH",
    ],
    [
      "reasonCode",
      { marker: rmMarkerBody({ reasonCode: "OTHER" }) },
      "REASON_CODE_INVALID",
    ],
    [
      "confirmed_by empty",
      { marker: rmMarkerBody({ confirmed_by: "" }) },
      "CONFIRMED_BY_EMPTY",
    ],
    [
      "at no offset",
      { marker: rmMarkerBody({ at: "2026-11-12T19:00:00" }) },
      "AT_INVALID",
    ],
    [
      "at bad day",
      { marker: rmMarkerBody({ at: "2026-02-30T00:00:00+09:00" }) },
      "AT_INVALID",
    ],
    [
      "at future",
      { marker: rmMarkerBody({ at: "2026-11-12T20:00:01+09:00" }) },
      "AT_FUTURE",
    ],
    [
      "at 14d + 1s",
      { marker: rmMarkerBody({ at: "2026-10-29T19:59:59+09:00" }) },
      "AT_STALE",
    ],
  ];
}

// 표지 개수와 승인 근거(위치 · 본문)가 어긋난 칸.
function retireInvalidApprovalCases() {
  const dup = {
    "/cr/watch/teardown-retire/rm-x-copy.json": JSON.stringify(rmMarkerBody()),
  };
  return [
    [
      "two markers",
      { files: dup, dir: ["rm-x.json", "rm-x-copy.json"] },
      "MULTIPLE_MARKERS",
    ],
    [
      "approvalRef relative",
      { marker: rmMarkerBody({ approvalRef: "approvals/a.md" }) },
      "APPROVAL_REF_INVALID",
    ],
    [
      "approval missing",
      { files: { [RM_APPROVAL]: null } },
      "APPROVAL_NOT_FOUND",
    ],
    [
      "approval outside",
      {
        marker: rmMarkerBody({ approvalRef: "/elsewhere/a.md" }),
        files: { "/elsewhere/a.md": "rm-x aaaaaaa" },
      },
      "APPROVAL_OUTSIDE_ROOT",
    ],
    [
      "approval is a marker file",
      {
        marker: rmMarkerBody({ approvalRef: RM_MARKER_PATH }),
      },
      "APPROVAL_IS_MARKER",
    ],
    [
      "approval lacks name (M7)",
      { approval: "근거: aaaaaaa 승인\n" },
      "APPROVAL_MISSING_NAME",
    ],
    [
      "approval lacks head prefix",
      { approval: "근거: rm-x 승인\n" },
      "APPROVAL_MISSING_HEAD",
    ],
    [
      "name only inside a longer name",
      { approval: "근거: rm-x-2 aaaaaaa\n" },
      "APPROVAL_MISSING_NAME",
    ],
    [
      "head prefix only inside another hash",
      { approval: "근거: rm-x faaaaaaa\n" },
      "APPROVAL_MISSING_HEAD",
    ],
  ];
}

test("HYK-464-3kinds adapter ⓐ: 위조·불완전 표지 -> valid:false + 닫힌 cause (observable:true)", () => {
  const all = [...retireInvalidBodyCases(), ...retireInvalidApprovalCases()];
  for (const [label, o, cause] of all) {
    const r = observeRm(retireFake(o));
    assert.equal(r.observable, true, label);
    assert.equal(r.valid, false, label);
    assert.equal(r.cause, cause, label);
  }
  // 어댑터는 표지가 «적은» headSha 를 그대로 싣는다 -- 관측 HEAD 로 덮어쓰면 코어의 재대조가 빈 껍데기가 된다.
  const moved = observeRm(
    retireFake({ marker: rmMarkerBody({ headSha: "c".repeat(40) }) }),
  );
  assert.equal(moved.headSha, "c".repeat(40));
});

test("HYK-464-3kinds adapter ⓐ: 14일 경계 -- 정확히 14일 전은 통과, 1초 지나면 AT_STALE / 현재 시각과 같은 at 은 미래가 아니다", () => {
  const at14 = "2026-10-29T20:00:00+09:00"; // NOW_MS 정확히 14일 전.
  assert.equal(
    observeRm(retireFake({ marker: rmMarkerBody({ at: at14 }) })).valid,
    true,
  );
  const atNow = "2026-11-12T20:00:00+09:00";
  assert.equal(
    observeRm(retireFake({ marker: rmMarkerBody({ at: atNow }) })).valid,
    true,
  );
  // UTC 표기(Z)와 소수초도 같은 순간으로 읽는다.
  const z = "2026-11-12T10:00:00.000Z"; // = 19:00 KST
  assert.equal(
    observeRm(retireFake({ marker: rmMarkerBody({ at: z }) })).valid,
    true,
  );
});

test("HYK-464-3kinds adapter ⓐ M9 자리: 읽기 실패·JSON 깨짐·주입 부재·잘못된 입력 -> observable:false (valid 를 지어내지 않는다)", () => {
  const unobservable = [
    ["marker read throws", retireFake({ throwRead: [RM_MARKER_PATH] })],
    ["marker JSON broken", retireFake({ files: { [RM_MARKER_PATH]: "{ no" } })],
    ["approval read throws", retireFake({ throwRead: [RM_APPROVAL] })],
    ["approval realpath throws", retireFake({ throwReal: [RM_APPROVAL] })],
    ["root realpath throws", retireFake({ throwReal: [RM_ROOT] })],
    ["readdir throws", retireFake({ throwDir: true })],
    [
      "sibling read throws",
      retireFake({
        files: { "/cr/watch/teardown-retire/zz.json": "{}" },
        dir: ["rm-x.json", "zz.json"],
        throwRead: ["/cr/watch/teardown-retire/zz.json"],
      }),
    ],
    ["own file missing from listing", retireFake({ dir: [] })],
    ["no readFileFn", retireFake({ opts: { readFileFn: undefined } })],
    ["no existsFn", retireFake({ opts: { existsFn: undefined } })],
    ["no readdirFn", retireFake({ opts: { readdirFn: undefined } })],
    ["no realpathFn", retireFake({ opts: { realpathFn: undefined } })],
    ["no nowMs", retireFake({ opts: { nowMs: undefined } })],
    ["nowMs NaN", retireFake({ opts: { nowMs: Number.NaN } })],
    ["exists non-boolean", retireFake({ opts: { existsFn: () => "yes" } })],
  ];
  for (const [label, fake] of unobservable) {
    assert.deepEqual(observeRm(fake), { observable: false }, label);
  }
  assert.deepEqual(observeRm(retireFake(), { observable: false }), {
    observable: false,
  });
  assert.deepEqual(observeRm(retireFake(), { observable: true }), {
    observable: false,
  });
  assert.deepEqual(observeRm(retireFake(), RM_STATUS, ""), {
    observable: false,
  });
  assert.deepEqual(
    adapter.observeRetireMarker("", RM_ROOT, RM_STATUS, retireFake()),
    { observable: false },
  );
});

test("HYK-464-3kinds adapter ⓐ: 승인 근거 위치는 해석된 실경로로 판정한다 -- 링크가 밖으로 나가면 거부, 안으로 돌면 통과 (루트 검사 제거 변이 자리)", () => {
  const link = `${RM_ROOT}/approvals/link.md`;
  const base = {
    marker: rmMarkerBody({ approvalRef: link }),
    files: { [link]: "rm-x aaaaaaa" },
  };
  const escaped = observeRm(
    retireFake({ ...base, real: { [link]: "/elsewhere/real.md" } }),
  );
  assert.equal(escaped.valid, false);
  assert.equal(escaped.cause, "APPROVAL_OUTSIDE_ROOT");
  assert.equal(escaped.approvalInsideAllowedRoot, false);
  const inner = observeRm(
    retireFake({ ...base, real: { [link]: `${RM_ROOT}/approvals/real.md` } }),
  );
  assert.equal(inner.valid, true);
  // 접두사만 같은 형제 폴더(/cr-evil)는 안이 아니다.
  const sibling = observeRm(
    retireFake({ ...base, real: { [link]: "/cr-evil/real.md" } }),
  );
  assert.equal(sibling.cause, "APPROVAL_OUTSIDE_ROOT");
  // 통역 형제 폴더가 없어도(realpath 던짐) 관제실 안 근거는 통과한다.
  const noInterp = observeRm(retireFake({ throwReal: ["/통역"] }));
  assert.equal(noInterp.valid, true);
});

test("HYK-464-3kinds adapter ⓐ: 표지 폴더 밖의 낡은 사본은 읽지 않는다 (watch/ 의 다른 파일 · 워크트리 .harness/retirements/ 0 reads)", () => {
  const fake = retireFake({
    files: {
      "/cr/watch/teardown-retire-stale.json": JSON.stringify(rmMarkerBody()),
      [`${RM_WT}/.harness/retirements/CODER-retire-r1.json`]:
        JSON.stringify(rmMarkerBody()),
    },
  });
  observeRm(fake);
  assert.equal(
    fake.reads.some((p) => p.includes("stale")),
    false,
  );
  assert.equal(
    fake.reads.some((p) => p.startsWith(RM_WT)),
    false,
  );
});
