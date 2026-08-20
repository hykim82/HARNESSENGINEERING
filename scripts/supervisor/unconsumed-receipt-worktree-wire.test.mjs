// HYK-328-receipt-name-1 (coder-task.md §3/§5) -- «감지기 영수증에 미소비
// 워크트리 «이름»이 기록되는가» 결선 계약 시험.
//
// 오늘 실측(coder-task.md §1): watch.log/last-run.json은 이미
// `unconsumedWorstCount=2`를 찍었지만, «어느 2개»인지는 이름이 없어 사람이
// 정황으로 추측해야 했다. 이 파일은 그 결손이 실제로 닫혔는지를 -- ★헛시험
// 방지를 위해 -- watch-run.mjs의 실 프로덕션 진입점(runWatchOnce, watch-run.mjs
// CLI의 `invokedDirectly` 분기가 부르는 바로 그 함수)을 통해 orch-stall-
// detect.mjs를 진짜 자식 프로세스로 실행해 확인한다(테스트 helper가
// 판정을 재구현하지 않는다 -- helper는 오직 mkdtemp 워크트리 구성뿐).
//
// ★정직 기재(왜 `node watch-run.mjs ...`를 OS 프로세스로 직접 spawn하지
// 않았는가): watch-run.mjs CLI는 `--repo-root`만 받고, 감지기 스크립트
// 경로(detectorPath)는 그 `--repo-root` 밑의 `scripts/supervisor/orch-
// stall-detect.mjs`로 **고정 계산**한다(실 배포에서는 감시 대상 저장소와
// 스크립트 저장소가 항상 같은 곳이므로 문제되지 않는다). 이 시험은
// 워크트리 구성을 결정적으로 만들기 위해 이 저장소(ROOT) 자체가 아니라
// 별도 mkdtemp 메인 저장소를 감시 대상으로 삼는데(seat-liveness-wire.
// test.mjs §4-1과 동일 이유 -- "이 저장소 자체의 워크트리는 건드리지
// 않는다"), 그 합성 저장소에는 scripts/ 디렉터리가 없다. 그래서
// `runWatchOnce({ detectorPath: <이 저장소의 실물 orch-stall-detect.mjs
// 절대경로> })`로 그 한 지점만 주입한다 -- CLI가 내부적으로 호출하는
// 것과 완전히 동일한 프로덕션 함수이고, 감지기 자체는 여전히 진짜
// child_process spawn으로 실행된다(execFn을 주입하지 않는다 -- 기본값
// defaultExec가 실제 node 프로세스를 띄운다). 아래 마지막 시험은 이
// 타협 없이 `node watch-run.mjs`를 이 저장소(ROOT) 자체를 대상으로 그대로
// OS 프로세스로 실행해 CLI 배선 자체도 별도로 검증한다(비결정적 실측값
// 이므로 "죽지 않고 unconsumed_status 토큰을 낸다"만 본다).
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. judgeUnconsumed 코어 자신의 판정 규칙(신호 종류·임계값)은
//    unconsumed-core.test.mjs/unconsumed-wire.test.mjs가 전담한다 --
//    여기서는 "worst 워크트리 이름이 영수증까지 닿는가"만 본다.
// 2. 각성 발화 규칙·임계값·판정 로직(coder-task.md §0 비타협 7)은 이
//    시험이 조금도 건드리지 않는다 -- wake를 아예 주지 않는다.
// 3. 실제 git worktree를 이 저장소 자신에는 절대 만들지 않는다 -- 전부
//    별도 mkdtemp 메인 저장소 + 그 안의 링크드 워크트리다(seat-liveness-
//    wire.test.mjs와 동일 원칙).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runWatchOnce } from "./watch-run.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const WATCH_RUN_PATH = join(THIS_DIR, "watch-run.mjs");
const DETECTOR_PATH = join(THIS_DIR, "orch-stall-detect.mjs");

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd, args, env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

// ★자체 발견(unconsumed-wire.test.mjs BASE_COMMIT_DATE와 동일 이유로 재
// 발견): `git commit`을 실제 벽시계로 만들면 그 커밋 시각이 항상
// "지금"이 되어, 과거로 고정한 결과 파일 mtime(예: 20분 전)보다 뒤처지는
// 일이 절대 없다 -- buildUnconsumedSignals가 그것만으로 NEW_COMMIT_AFTER
// 신호를 만들어 SUSPECTED_UNCONSUMED로 남기려던 워크트리까지 전부
// CONSUMED로 새어버린다(이 파일 작성 중 직접 재현). 그래서 베이스 커밋
// 시각을 이 시험의 어떤 mtime보다도 훨씬 이전(2020-01-01)으로 고정한다.
const BASE_COMMIT_DATE = "2020-01-01T00:00:00+09:00";
function initPlainGitRepo(dir) {
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(
    dir,
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-m",
      "base",
      "--quiet",
    ],
    { GIT_AUTHOR_DATE: BASE_COMMIT_DATE, GIT_COMMITTER_DATE: BASE_COMMIT_DATE },
  );
}

// seat-liveness-wire.test.mjs의 addLinkedWorktree와 동일 원칙 -- mkdtemp
// 밖 실 저장소는 절대 건드리지 않고, 진짜 링크드 워크트리 쌍을 mkdtemp
// 임시 디렉터리 안에서만 만든다.
function addLinkedWorktree(mainDir, label) {
  const linkedDir = tmpDir(`hyk328-linked-${label}-`);
  rmSync(linkedDir, { recursive: true, force: true });
  const branch = `hyk328-wt-${label}-${process.pid}-${Math.random()
    .toString(36)
    .slice(2)}`;
  git(mainDir, ["worktree", "add", "-b", branch, linkedDir]);
  return linkedDir;
}

function listWorktreePaths(dir) {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: dir,
    encoding: "utf8",
  });
  return [...out.matchAll(/^worktree\s+(.+)$/gm)].map((m) => m[1].trim());
}

// dropped_at 헤더 존재 여부와 무관하게(§3 소비 판정은 헤더를 안 본다)
// mtime만 실제로 통제한다 -- unconsumed-wire.test.mjs의 writeTaskFile과
// 동일 원칙(mtimeIso를 항상 명시로 받는다).
function writeTaskFile(dir, name, taskId, mtimeIso) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  const p = join(dir, ".harness", name);
  writeFileSync(p, `task_id: ${taskId}\n\n본문\n`, "utf8");
  const t = new Date(mtimeIso);
  utimesSync(p, t, t);
}

function writeResultFile(dir, name, mtimeIso) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  const p = join(dir, ".harness", name);
  writeFileSync(p, "결과 본문\n>>> DONE: CODER @ test\n", "utf8");
  const t = new Date(mtimeIso);
  utimesSync(p, t, t);
}

// ★real wall-clock 사용: --now를 주입하지 않고(watch-run.mjs CLI에는
// 애초에 그런 플래그가 없다) 실제 "지금"을 기준으로 결과 파일 mtime을
// 임계(기본 15분)보다 훨씬 과거로 고정한다 -- 그러면 감지기가 실행될
// 실제 시각과 무관하게 항상 SUSPECTED_UNCONSUMED 조건을 만족한다.
// ★★worktree 초기화(git init/commit --allow-empty/worktree add)는
// 실행 시각("지금")에 커밋을 만든다 -- 그 커밋 시각이 target mtime(과거)
// 보다 항상 나중이 되면 NEW_COMMIT_AFTER 신호로 잡혀 CONSUMED가 되어
// 버린다(자체 발견). 그래서 SUSPECTED로 남기려는 워크트리는 결과 파일의
// mtime을 저장소 초기화 이후로, 즉 "베이스 커밋보다는 나중이지만 지금
// 으로부터 15분보다는 이전"으로 고정해야 한다 -- 아래 두 헬퍼가 실제로
// 관측한 순서(초기화 -> 결과 파일 작성)를 그대로 따른다.
function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function makeSuspectedWorktree(mainDir, label) {
  const dir = addLinkedWorktree(mainDir, label);
  writeTaskFile(
    dir,
    "coder-task.md",
    `HYK-328-${label}-coder`,
    isoMinutesAgo(30),
  );
  writeResultFile(dir, "coder.md", isoMinutesAgo(20));
  return dir;
}

// 다음 라운드 task 파일을 결과 파일보다 "나중"에 드롭시켜 CONSUMED
// 신호(TASK_FILE_DROPPED_AFTER)를 만든다 -- 실제 git commit 신호에
// 기대지 않는 가장 단순한 경로(unconsumed-wire.test.mjs의 실물 재현
// 시험과 동일 신호 종류).
function makeConsumedWorktree(mainDir, label) {
  const dir = addLinkedWorktree(mainDir, label);
  writeTaskFile(
    dir,
    "coder-task.md",
    `HYK-328-${label}-coder`,
    isoMinutesAgo(30),
  );
  writeResultFile(dir, "coder.md", isoMinutesAgo(20));
  writeTaskFile(
    dir,
    "review-task.md",
    `HYK-328-${label}-review`,
    isoMinutesAgo(1),
  );
  return dir;
}

// ★프로덕션 진입점: watch-run.mjs가 export하는 runWatchOnce 그 자체를
// 부른다(watch-run.mjs CLI의 `invokedDirectly` 분기가 부르는 것과 동일
// 함수) -- execFn을 주지 않으므로 기본값(defaultExec)이 실제 child_process
// spawn으로 orch-stall-detect.mjs를 실행한다. detectorPath만 이 저장소의
// 실물 경로로 명시한다(파일 헤더 "정직 기재" 참조 -- mainDir이 합성
// 저장소라 CLI의 기본 계산이 통하지 않는다).
function runWatchRun(mainDir, watchDir) {
  return runWatchOnce({
    repoRoot: mainDir,
    watchDir,
    detectorPath: DETECTOR_PATH,
  });
}

function lastWatchLogLine(watchDir) {
  const text = readFileSync(join(watchDir, "watch.log"), "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines[lines.length - 1];
}

function readLastRun(watchDir) {
  return JSON.parse(readFileSync(join(watchDir, "last-run.json"), "utf8"));
}

// 실측 경로 표현 선택 근거(coder-task.md §3 항2 "고른 이유를 결과 파일에
// 적어라" -- 여기 시험 쪽 근거): git worktree list가 돌려주는 경로는
// mkdtemp 원문 문자열과 대소문자/구분자/8.3 단축 경로가 다를 수 있다
// (seat-liveness-wire.test.mjs 실측과 동일 위험) -- basename만으로
// 대조한다.
function baseNameOf(p) {
  return p.split(/[\\/]/).filter(Boolean).pop();
}

function withMainWorktreeRepo(prefix, fn) {
  const mainDir = tmpDir(prefix);
  try {
    initPlainGitRepo(mainDir);
    return fn(mainDir);
  } finally {
    // 링크드 워크트리들은 mainDir 밖의 별도 tmpDir이므로, git이 아는
    // 워크트리 목록을 먼저 읽어 전부 지운다(고아 디렉터리를 남기지
    // 않는다).
    let linked = [];
    try {
      linked = listWorktreePaths(mainDir).slice(1);
    } catch {
      // 열거 자체가 실패하면(예: mainDir이 이미 반쯤 지워짐) 지울 링크드
      // 워크트리가 없다고 본다 -- linked는 이미 []다.
    }
    for (const p of linked) {
      rmSync(p, { recursive: true, force: true });
    }
    rmSync(mainDir, { recursive: true, force: true });
  }
}

function withWatchDir(prefix, fn) {
  const watchDir = tmpDir(prefix);
  try {
    return fn(watchDir);
  } finally {
    rmSync(watchDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (1) worst == 2 -- 오늘 실측 그대로("unconsumedWorstCount":2) 재현. 두
// 워크트리 이름이 «전부» watch.log 한 줄과 last-run.json에 실제로 나타나는지
// 프로덕션 진입점(진짜 child_process 감지기 실행)으로 고정한다.
// ---------------------------------------------------------------------------
test("HYK-328-receipt-name-1: worst 2건(오늘 실측 재현) -- 진짜 child_process 감지기 실행 결과가 watch.log와 last-run.json 둘 다에 두 워크트리 이름을 전부 남긴다 (1/1)", () => {
  withMainWorktreeRepo("hyk328-worst2-main-", (mainDir) => {
    const wt1 = makeSuspectedWorktree(mainDir, "a");
    const wt2 = makeSuspectedWorktree(mainDir, "b");
    withWatchDir("hyk328-worst2-watch-", (watchDir) => {
      runWatchRun(mainDir, watchDir);

      const line = lastWatchLogLine(watchDir);
      assert.match(line, /unconsumed_verdict=SUSPECTED_UNCONSUMED/, line);
      assert.match(line, /unconsumed_worst_count=2/, line);
      const detailMatch =
        /unconsumed_worst_worktrees=2 unconsumed_worst_worktree_detail=(\S+)/.exec(
          line,
        );
      assert.ok(
        detailMatch,
        `unconsumed_worst_worktree_detail token missing from: ${line}`,
      );
      const shownNames = detailMatch[1].split("|");
      assert.ok(
        shownNames.includes(baseNameOf(wt1)),
        `wt1 (${baseNameOf(wt1)}) missing from log detail: ${detailMatch[1]}`,
      );
      assert.ok(
        shownNames.includes(baseNameOf(wt2)),
        `wt2 (${baseNameOf(wt2)}) missing from log detail: ${detailMatch[1]}`,
      );

      const record = readLastRun(watchDir);
      assert.equal(record.unconsumedWorstCount, 2);
      assert.ok(
        Array.isArray(record.unconsumedWorstWorktrees),
        "last-run.json must carry unconsumedWorstWorktrees as an array",
      );
      const recordedBaseNames = record.unconsumedWorstWorktrees.map(baseNameOf);
      assert.ok(recordedBaseNames.includes(baseNameOf(wt1)));
      assert.ok(recordedBaseNames.includes(baseNameOf(wt2)));
      assert.ok(
        typeof record.unconsumedWorktreePath === "string" &&
          record.unconsumedWorktreePath.length > 0,
        "last-run.json must also carry the chain/binding-shaped singular unconsumedWorktreePath",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// (2) worst == 1 -- 단건일 때도 이름이 나온다(§5 체크리스트 2).
// ---------------------------------------------------------------------------
test("HYK-328-receipt-name-1: worst 1건 -- 이름이 여전히 watch.log/last-run.json에 나타난다 (1/1)", () => {
  withMainWorktreeRepo("hyk328-worst1-main-", (mainDir) => {
    const wt1 = makeSuspectedWorktree(mainDir, "solo");
    withWatchDir("hyk328-worst1-watch-", (watchDir) => {
      runWatchRun(mainDir, watchDir);

      const line = lastWatchLogLine(watchDir);
      assert.match(line, /unconsumed_worst_count=1/, line);
      const detailMatch =
        /unconsumed_worst_worktrees=1 unconsumed_worst_worktree_detail=(\S+)/.exec(
          line,
        );
      assert.ok(detailMatch, `token missing from: ${line}`);
      assert.equal(detailMatch[1], baseNameOf(wt1));

      const record = readLastRun(watchDir);
      assert.deepEqual(record.unconsumedWorstWorktrees.map(baseNameOf), [
        baseNameOf(wt1),
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// (3) worst > 상한(MAX_PARTIAL_FAILURE_ITEMS=2) -- N_more 관습대로
// watch.log에서 잘리고, 잘렸다는 사실이 건수로 드러난다(조용한 절단
// 금지, §5 체크리스트 3). last-run.json은 로그와 달리 상한을 두지 않고
// 전부(3건) 담는다(사람이 훑는 요약과 기계가 읽는 정본의 역할 분담).
// ---------------------------------------------------------------------------
test("HYK-328-receipt-name-1: worst 3건(상한 2 초과) -- watch.log는 '+1_more'로 잘리되 건수(3)는 드러나고, last-run.json은 3건 전부를 담는다 (1/1)", () => {
  withMainWorktreeRepo("hyk328-worst3-main-", (mainDir) => {
    const wts = [
      makeSuspectedWorktree(mainDir, "x"),
      makeSuspectedWorktree(mainDir, "y"),
      makeSuspectedWorktree(mainDir, "z"),
    ];
    withWatchDir("hyk328-worst3-watch-", (watchDir) => {
      runWatchRun(mainDir, watchDir);

      const line = lastWatchLogLine(watchDir);
      assert.match(line, /unconsumed_worst_count=3/, line);
      const detailMatch =
        /unconsumed_worst_worktrees=3 unconsumed_worst_worktree_detail=(\S+)/.exec(
          line,
        );
      assert.ok(detailMatch, `token missing from: ${line}`);
      assert.match(
        detailMatch[1],
        /\|\+1_more$/,
        `expected N_more truncation marker, got: ${detailMatch[1]}`,
      );
      const shownCount = detailMatch[1].split("|").length - 1; // 마지막 토큰은 +1_more.
      assert.equal(
        shownCount,
        2,
        "log detail must show exactly the cap (2) names, not all 3",
      );

      const record = readLastRun(watchDir);
      assert.equal(
        record.unconsumedWorstWorktrees.length,
        3,
        "the JSON record (the machine-readable source of truth) must not silently drop the third worktree",
      );
      const recordedBaseNames = record.unconsumedWorstWorktrees.map(baseNameOf);
      for (const wt of wts) {
        assert.ok(
          recordedBaseNames.includes(baseNameOf(wt)),
          `${baseNameOf(wt)} missing from last-run.json unconsumedWorstWorktrees`,
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// (4) 미소비 의심이 없을 때(CONSUMED) -- 새 필드가 소멸하지 않고
// null/빈 값으로 존재한다(§5 체크리스트 4, "필드 소멸 금지").
// ---------------------------------------------------------------------------
test("HYK-328-receipt-name-1: 미소비 의심 없음(CONSUMED) -- unconsumedWorstWorktrees 필드는 사라지지 않고 빈 배열로 남고, watch.log에는 worst 상세 토큰이 아예 안 붙는다 (1/1)", () => {
  withMainWorktreeRepo("hyk328-consumed-main-", (mainDir) => {
    makeConsumedWorktree(mainDir, "ok");
    withWatchDir("hyk328-consumed-watch-", (watchDir) => {
      runWatchRun(mainDir, watchDir);

      // ★자체 발견: 대표(worst) 항목은 "가장 나쁜 등급의 첫 번째 항목"이라
      // main 워크트리(항상 NOT_APPLICABLE, 이 severity도 NORMAL 등급)가
      // linked 워크트리(JUDGED/CONSUMED, 역시 NORMAL 등급)보다 먼저
      // 나열돼 대표로 뽑힐 수 있다(git worktree list가 main을 먼저 낸다)
      // -- 이건 이 축의 기존 worst-선택 규칙이고 이 라운드가 건드리는
      // 범위 밖이다(§0 비타협 7). 그래서 여기서는 verdict의 구체값을
      // 단언하지 않고, "SUSPECTED가 아니다"(worst_worktrees 토큰이 안
      // 붙는다)만 본다 -- 이 시험이 실제로 확인하려는 것.
      const line = lastWatchLogLine(watchDir);
      assert.doesNotMatch(
        line,
        /unconsumed_verdict=SUSPECTED_UNCONSUMED/,
        line,
      );
      assert.equal(
        line.includes("unconsumed_worst_worktrees="),
        false,
        `no-suspicion tick must not emit an unconsumed_worst_worktrees token: ${line}`,
      );

      const record = readLastRun(watchDir);
      assert.ok(
        "unconsumedWorstWorktrees" in record,
        "the key itself must exist even when there is nothing to show (no field disappearance)",
      );
      assert.deepEqual(record.unconsumedWorstWorktrees, []);
    });
  });
});

// ---------------------------------------------------------------------------
// (5) 감지기 stdout 자체가 파싱 실패(구버전/손상)일 때도 필드이 존재한다
// (emptyDetectorFields 기본 모양, §3 항1 "값 없음 기본 모양에도 null").
// 이 시험만은 execFn을 주입한다(파싱 실패 자체를 결정적으로 재현하려는
// 것이지 감지기 출력을 재구현하는 게 아니다 -- runWatchOnce/buildLogLine
// 자신은 여전히 프로덕션 코드 그대로 실행된다).
// ---------------------------------------------------------------------------
test("HYK-328-receipt-name-1: 감지기 stdout 파싱 실패 -> emptyDetectorFields 기본 모양에도 unconsumedWorktreePath/unconsumedWorstWorktrees가 null로 존재한다 (1/1)", () => {
  const watchDir = tmpDir("hyk328-parsefail-watch-");
  try {
    runWatchOnce({
      repoRoot: "C:/wt",
      watchDir,
      execFn: () => "not json",
    });
    const record = readLastRun(watchDir);
    assert.equal(record.unconsumedWorktreePath, null);
    assert.equal(record.unconsumedWorstWorktrees, null);
  } finally {
    rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (6) ★CLI 배선 자체(정직 기재의 "타협 없이" 절) -- `node watch-run.mjs`를
// 실제 OS 프로세스로, 이 저장소(ROOT) 자체를 대상으로 실행한다. ROOT의
// 실제 워크트리 구성은 실행 시점마다 다르므로 worst 이름의 구체값은
// 단언하지 않는다 -- "CLI 인자 파싱 -> runWatchOnce -> 자식 감지기 spawn
// -> watch.log/last-run.json 기록"이라는 전체 배선이 죽지 않고 끝까지
// 도는지, 그리고 unconsumedWorktreePath/unconsumedWorstWorktrees 키가
// 실제로 last-run.json에 존재하는지만 본다(§5 체크리스트 1 "필드 존재
// 보장"의 살아있는 저장소 실측).
// ---------------------------------------------------------------------------
test("★CLI 배선 실측: node watch-run.mjs --repo-root <이 저장소> 를 실제 프로세스로 실행해도 죽지 않고, last-run.json에 unconsumedWorktreePath/unconsumedWorstWorktrees 키가 존재한다 (1/1)", () => {
  const watchDir = tmpDir("hyk328-cli-live-watch-");
  try {
    const r = spawnSync(
      "node",
      [
        WATCH_RUN_PATH,
        "--repo-root",
        ROOT,
        "--watch-dir",
        watchDir,
        "--no-reach",
        "--no-partial-count",
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const line = lastWatchLogLine(watchDir);
    assert.match(line, /unconsumed_status=\S+/, line);
    const record = readLastRun(watchDir);
    assert.ok("unconsumedWorktreePath" in record);
    assert.ok("unconsumedWorstWorktrees" in record);
  } finally {
    rmSync(watchDir, { recursive: true, force: true });
  }
});
