// HYK-185-unconsumed-3 (coder-task.md §R3) -- «워커 결과가 갱신됐는데
// 총괄이 소비하지 않았다» 판정 "결선" 계약 시험.
//
// §R3 재설계(REVIEW 3R P1-3/P1-4 반려 수리): 소비 판정은 이제 `dropped_at`
// 헤더를 전혀 보지 않는다(실물 mtime 두 개만). 헤더 대조는 완전히 분리된
// header-time-projection-core.mjs(scanHeaderTimeProjection)로 옮겼고, 이
// 파일에서도 그 둘을 별개 절로 나눠 시험한다 -- 소비 축을 시험하는 절은
// 헤더를 아예 안 쓰고, projection 절은 소비 판정과 무관함을 직접 단언한다.
//
// ★가장 중요한 수리(REVIEW 3R 보강 지적): 2R까지의 이 파일은 `writeTaskFile`
// 이 task 파일의 mtime을 **헤더 문자열에서 계산**해 강제로 맞췄다 --
// 실물에 없는 완전 정렬(오차 0)을 전제해 헛시험이 됐고, 그 전제가 실측
// 편차(+68/+103/+118초)로 인한 실사고(P1-3, 살아있는 4 워크트리에서 판정
// 도달 0건)를 가렸다. 이 파일의 `writeTaskFile`은 이제 `mtimeIso`를
// **항상 명시로 요구한다**(기본 유도 없음) -- 헤더 문자열과 mtime을
// 호출자가 독립적으로 고르게 강제한다.
//
// 이 계약이 보장하지 않는 것(S11):
// 1. 여기 fixture(hyk185-unconsumed-2026-08-06-sample.json)의 실측 구간
//    (series_1344/series_1411)은 실제 시각을 그대로 쓰지만, 이 시험이
//    돌리는 것은 그 시각을 흉내낸 `mkdtemp` 합성 워크트리다.
// 2. judgeUnconsumed/judgeHeaderTimeProjection 코어 자신은 한 글자도
//    시험하지 않는다(각각 unconsumed-core.test.mjs·
//    header-time-projection-core.test.mjs가 함) -- 이 파일은 오직
//    "결선"만 본다.
// 3. mutation 시험은 디스크의 현재 소스를 읽는다(이번 태스크는 커밋 0이
//    조건이라 이 라운드 수정분이 git HEAD에 없다).
// 4. ★변이체는 저장소 밖 mkdtemp에 쓰고 상대 import는 file://로 치환한다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  judgeUnconsumedForRepo,
  judgeUnconsumedAcrossWorktrees,
  collectUnconsumedCandidates,
  scanHeaderTimeProjection,
  runOrchStallDetect,
  UNCONSUMED_WIRE_STATUS,
  UNCONSUMED_SCAN_FAILURE,
  selectMostRecentConsumableResult,
} from "./orch-stall-detect.mjs";
import { UNCONSUMED_VERDICT } from "./unconsumed-core.mjs";
import { HEADER_TIME_PROJECTION_VERDICT } from "./header-time-projection-core.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

const FIXTURE = JSON.parse(
  readFileSync(
    join(THIS_DIR, "hyk185-unconsumed-2026-08-06-sample.json"),
    "utf8",
  ),
);

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function git(cwd, args, env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}
// ★기준 커밋의 시각을 실제 벽시계가 아니라 이 표본들보다 한참 이전
// (2020-01-01)으로 고정한다 -- 안 그러면 이 시험을 실행하는 실제 "지금"이
// 표본의 합성 `--now`(2026-08-06 근방)보다 늦게 잡힐 때, 기준 커밋 자체가
// "결과 파일보다 나중"인 신호로 오인될 수 있다(2R에서 디버깅으로 재현).
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
// ★HYK-185-unconsumed-3 §R3-2 수리(REVIEW 3R 보강 지적, 이 파일의 이전
// 버전 :134 지점이 정확한 대상이었다): mtime은 이제 **항상 명시**로
// 받는다 -- droppedAt(헤더 문자열)에서 계산하는 기본값이 없다. 헤더
// 텍스트와 파일의 실제 mtime을 호출자가 서로 독립적으로 고르도록
// 강제해서, "완전 정렬을 전제한 헛시험"이 구조적으로 다시 나올 수 없게
// 한다. `droppedAt`을 생략하면 헤더 줄 자체가 안 써진다(P1-4 -- 헤더
// 없는 task 파일 표본).
function writeTaskFile(
  dir,
  { name = "coder-task.md", taskId, droppedAt, mtimeIso },
) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  const p = join(dir, ".harness", name);
  const headerLine = droppedAt ? `dropped_at: ${droppedAt} KST\n` : "";
  writeFileSync(p, `task_id: ${taskId}\n${headerLine}\n본문\n`, "utf8");
  const t = new Date(mtimeIso);
  utimesSync(p, t, t);
}
// 결과 파일을 쓰고, 그 mtime을 원하는 시각으로 고정한다(§3 표본이 실제
// 관측한 것은 "파일 mtime"이므로 이 시험도 mtime을 직접 통제해야 실물과
// 동형이다).
function writeResultFileAt(dir, { name = "coder.md", updatedAtIso }) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  const p = join(dir, ".harness", name);
  writeFileSync(p, "결과 본문\n>>> DONE: CODER @ test\n", "utf8");
  const t = new Date(updatedAtIso);
  utimesSync(p, t, t);
}
function commitAt(dir, iso, message = "consume") {
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
      message,
      "--quiet",
    ],
    { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  );
}

// ---------------------------------------------------------------------------
// (1) selectMostRecentConsumableResult -- 순수 헬퍼, 대상 선정 로직만
// (아이템 형태와 무관 -- resultFile 필드만 본다).
// ---------------------------------------------------------------------------
test("selectMostRecentConsumableResult: 결과 파일이 없으면(전부 exists:false) null (1/1)", () => {
  const items = [{ resultFile: { exists: false, mtimeMs: null } }];
  assert.equal(selectMostRecentConsumableResult(items), null);
});

test("selectMostRecentConsumableResult: 여러 결과 파일 중 mtime이 가장 최근인 것 하나를 고른다 (1/1)", () => {
  const items = [
    { path: "a", resultFile: { exists: true, mtimeMs: 1000 } },
    { path: "b", resultFile: { exists: true, mtimeMs: 3000 } },
    { path: "c", resultFile: { exists: true, mtimeMs: 2000 } },
  ];
  assert.equal(selectMostRecentConsumableResult(items).path, "b");
});

// ---------------------------------------------------------------------------
// (2) judgeUnconsumedForRepo -- §R3-1(A): 헤더 완전 배제, 실물 mtime
// 두 개만. 항목 형태에 `droppedAtMs`가 아예 없다(collectUnconsumedCandidates
// 가 만드는 실제 형태와 동일).
// ---------------------------------------------------------------------------
test("judgeUnconsumedForRepo: 판정 대상(존재하는 결과 파일) 자체가 없으면 -> NOT_APPLICABLE, git 호출 0회", () => {
  const commitTimeExecFn = () => {
    throw new Error("must not be called");
  };
  const r = judgeUnconsumedForRepo(
    { repoRoot: "C:/wt", taskFileCandidates: [], now: 1 },
    { commitTimeExecFn },
  );
  assert.equal(r.status, UNCONSUMED_WIRE_STATUS.NOT_APPLICABLE);
});

test("judgeUnconsumedForRepo: git log 조회 실패 -> COLLECTION_FAILED(판정 불가로 닫힘, «소비 없음»으로 단정하지 않는다) (1/1)", () => {
  const taskFileCandidates = [
    {
      path: ".harness/coder-task.md",
      taskFileMtimeMs: 1000,
      resultFile: { path: ".harness/coder.md", exists: true, mtimeMs: 2000 },
    },
  ];
  const r = judgeUnconsumedForRepo(
    { repoRoot: "C:/wt", taskFileCandidates, now: 999_999 },
    {
      commitTimeExecFn: () => {
        throw new Error("git unreachable");
      },
    },
  );
  assert.equal(r.status, UNCONSUMED_WIRE_STATUS.COLLECTION_FAILED);
  assert.notEqual(r.status, UNCONSUMED_WIRE_STATUS.JUDGED);
});

test("judgeUnconsumedForRepo: ★헤더가 아예 없는 항목(droppedAtMs 필드 자체가 없다)도 결과 파일보다 나중이면 CONSUMED -- P1-4 직접 고정 (1/1)", () => {
  const taskFileCandidates = [
    {
      path: ".harness/coder-task.md",
      taskFileMtimeMs: 1000,
      resultFile: { path: ".harness/coder.md", exists: true, mtimeMs: 2000 },
    },
    {
      // 다음 role의 task 파일 -- 헤더 관련 필드가 아예 없다(collectUnconsumedCandidates
      // 는 애초에 이 필드를 만들지 않는다). 결과 파일(mtimeMs 2000)보다
      // 나중(5000)에 갱신됨.
      path: ".harness/review-task.md",
      taskFileMtimeMs: 5000,
      resultFile: { path: ".harness/review.md", exists: false, mtimeMs: null },
    },
  ];
  const r = judgeUnconsumedForRepo(
    { repoRoot: "C:/wt", taskFileCandidates, now: 999_999 },
    { commitTimeExecFn: () => "1970-01-01T00:00:00.000Z" },
  );
  assert.equal(r.status, UNCONSUMED_WIRE_STATUS.JUDGED);
  assert.equal(r.verdict, UNCONSUMED_VERDICT.CONSUMED);
});

test("judgeUnconsumedForRepo: 새 커밋이 결과 파일보다 나중 -> JUDGED/CONSUMED via NEW_COMMIT_AFTER (1/1)", () => {
  const taskFileCandidates = [
    {
      path: ".harness/coder-task.md",
      taskFileMtimeMs: 1000,
      resultFile: { path: ".harness/coder.md", exists: true, mtimeMs: 2000 },
    },
  ];
  const r = judgeUnconsumedForRepo(
    { repoRoot: "C:/wt", taskFileCandidates, now: 999_999 },
    { commitTimeExecFn: () => "1970-01-01T00:00:10.000Z" }, // epoch+10s = 10000ms > 2000ms.
  );
  assert.equal(r.status, UNCONSUMED_WIRE_STATUS.JUDGED);
  assert.equal(r.verdict, UNCONSUMED_VERDICT.CONSUMED);
});

test("judgeUnconsumedForRepo: 신호 없음 + 임계 이내 -> JUDGED/UNDECIDABLE(조용히 보류, SUSPECTED로 새지 않는다) (1/1)", () => {
  const taskFileCandidates = [
    {
      path: ".harness/coder-task.md",
      taskFileMtimeMs: 1000,
      resultFile: { path: ".harness/coder.md", exists: true, mtimeMs: 2000 },
    },
  ];
  const r = judgeUnconsumedForRepo(
    { repoRoot: "C:/wt", taskFileCandidates, now: 2000 + 60_000 }, // 1분 뒤 -- 기본 임계 15분 이내.
    { commitTimeExecFn: () => "1970-01-01T00:00:00.000Z" },
  );
  assert.equal(r.status, UNCONSUMED_WIRE_STATUS.JUDGED);
  assert.equal(r.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
});

test("judgeUnconsumedForRepo: 신호 없음 + 임계 초과 -> JUDGED/SUSPECTED_UNCONSUMED (1/1)", () => {
  const taskFileCandidates = [
    {
      path: ".harness/coder-task.md",
      taskFileMtimeMs: 1000,
      resultFile: { path: ".harness/coder.md", exists: true, mtimeMs: 2000 },
    },
  ];
  const r = judgeUnconsumedForRepo(
    { repoRoot: "C:/wt", taskFileCandidates, now: 2000 + 16 * 60_000 }, // 16분 뒤 -- 기본 임계(15분) 초과.
    { commitTimeExecFn: () => "1970-01-01T00:00:00.000Z" },
  );
  assert.equal(r.status, UNCONSUMED_WIRE_STATUS.JUDGED);
  assert.equal(r.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);
});

test("judgeUnconsumedForRepo: taskFileMtimeMs를 못 구한 항목 -> TASK_FILE_MTIME_UNAVAILABLE(조용히 신호 0건으로 새지 않는다) (1/1)", () => {
  const taskFileCandidates = [
    {
      path: ".harness/coder-task.md",
      taskFileMtimeMs: 1000,
      resultFile: { path: ".harness/coder.md", exists: true, mtimeMs: 2000 },
    },
    {
      path: ".harness/review-task.md",
      taskFileMtimeMs: null, // 수집 실패(예: 경쟁 상태로 파일이 사라짐) -- 신뢰 불가.
      resultFile: { path: ".harness/review.md", exists: false, mtimeMs: null },
    },
  ];
  const r = judgeUnconsumedForRepo(
    { repoRoot: "C:/wt", taskFileCandidates, now: 999_999 },
    { commitTimeExecFn: () => "1970-01-01T00:00:00.000Z" },
  );
  assert.equal(r.status, UNCONSUMED_WIRE_STATUS.TASK_FILE_MTIME_UNAVAILABLE);
  assert.notEqual(r.status, UNCONSUMED_WIRE_STATUS.JUDGED);
});

// ---------------------------------------------------------------------------
// (2b) collectUnconsumedCandidates -- 자체 발견 반례: `*-task.md`라는
// 이름의 디렉터리는 statSync가 성공해 버리므로(파일과 구별 안 됨) 그
// mtime을 진짜 task 파일 mtime으로 착각할 뻔했다. 여기서 명시적으로
// 막았는지 단언한다.
// ---------------------------------------------------------------------------
test("★자체 발견 반례: collectUnconsumedCandidates는 `*-task.md` 디렉터리를 진짜 task 파일로 오인하지 않는다(failed:true로 닫힘) (1/1)", () => {
  withTempDir("hyk185-unconsumed-dirname-", (dir) => {
    initPlainGitRepo(dir);
    mkdirSync(join(dir, ".harness", "sneaky-task.md"), { recursive: true });
    const r = collectUnconsumedCandidates(dir);
    assert.equal(r.failed, true);
    assert.deepEqual(r.items, []);
  });
});

// ---------------------------------------------------------------------------
// (2c) §R4-1(REVIEW 4R D2 반례 고정) -- 결과 파일도 같은 디렉터리 검사를
// 받는다(R3에서는 task 파일 쪽만 검사받고 결과 파일은 `collectFileMtime`
// 에 그대로 맡겨, 디렉터리에서도 "성공"으로 새서 확정적
// SUSPECTED_UNCONSUMED를 냈다 -- 한용 명시 "없는 사고를 확정적으로
// 고발하는 방향은 그대로 두지 마라").
// ---------------------------------------------------------------------------
test("★R4-1 D2 반례 고정(검토자 실측 그대로): .harness/coder.md가 디렉터리 -- 판정 불가(HARNESS_READ_FAILED)로 닫히고 SUSPECTED_UNCONSUMED는 절대 나오지 않는다 (1/1)", () => {
  withTempDir("hyk185-unconsumed-r4-d2-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-r4-d2",
      droppedAt: "2026-08-06 13:13",
      mtimeIso: "2026-08-06T13:13:00+09:00",
    });
    // 검토자의 정확한 반례: 결과 파일 자리에 디렉터리(mtime 13:19:21).
    const resultDirPath = join(dir, ".harness", "coder.md");
    mkdirSync(resultDirPath, { recursive: true });
    const dirMtime = new Date("2026-08-06T13:19:21+09:00");
    utimesSync(resultDirPath, dirMtime, dirMtime);
    const now = Date.parse("2026-08-06T13:19:21+09:00") + 40 * 60_000; // +40분 -- 임계(15분) 훌쩍 초과, 수리 전이면 SUSPECTED_UNCONSUMED가 나왔을 시점.
    const r = judgeUnconsumedAcrossWorktrees({ repoRoot: dir, now }, {});
    assert.equal(r.status, UNCONSUMED_SCAN_FAILURE.HARNESS_READ_FAILED);
    assert.notEqual(r.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);
    assert.notEqual(r.status, UNCONSUMED_WIRE_STATUS.NOT_APPLICABLE); // "파일 없음"으로도 접히지 않는다.
  });
});

test("★R4-1(b) 정상 대조군: 결과 파일이 진짜 파일이면(디렉터리 아님) 같은 배치가 정상적으로 JUDGED까지 간다 -- 과잉 수리로 모든 결과 파일이 막히는 게 아니다 (1/1)", () => {
  withTempDir("hyk185-unconsumed-r4-d2-control-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-r4-d2-control",
      droppedAt: "2026-08-06 13:13",
      mtimeIso: "2026-08-06T13:13:00+09:00",
    });
    writeResultFileAt(dir, {
      name: "coder.md",
      updatedAtIso: "2026-08-06T13:19:21+09:00",
    });
    const now = Date.parse("2026-08-06T13:19:21+09:00") + 40 * 60_000;
    const r = judgeUnconsumedAcrossWorktrees({ repoRoot: dir, now }, {});
    // 정상 파일이면 판정이 실제로 나간다(HARNESS_READ_FAILED로 새지 않는다)
    // -- 디렉터리 케이스와 출력으로 구별된다(§R4-6-(b)).
    assert.equal(r.status, UNCONSUMED_WIRE_STATUS.JUDGED);
    assert.equal(r.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (2d) §R4-2(REVIEW 4R 둘째 갈래, 정직 기재) -- `existsSync`는 통과했는데
// `statSync`만 던지는 상태(권한 등)를 이 Windows 환경에서 실제 OS
// 메커니즘(예약 장치 이름 `CON`, 300자 초과 경로)으로 시도했으나
// **재현하지 못했다**(둘 다 `existsSync` 단계에서 이미 false/ENOENT로
// 막혀, "존재는 하는데 stat만 실패"하는 중간 상태 자체가 만들어지지
// 않았다). 검토자도 같은 이유로 실행 재현 없이 코드 경로로만 지적했다.
// ★수리는 재현 여부와 무관하게 적용했다(한용 명시) -- 아래 시험은 그
// 코드 경로를 opts.existsFn/opts.statFn **주입**으로 결정적으로
// 시험한다(실 OS 결함 재현이 아니라 코드 경로 시험이라는 것을 이름에도
// 명시한다).
// ---------------------------------------------------------------------------
test("★R4-2 코드 경로 시험(실 OS 재현 아님, 주입으로 결정적 재현): 결과 파일 existsSync는 참인데 statSync만 던지면 -- «파일 없음»으로 뭉개지지 않고 판정 불가로 닫힌다 (1/1)", () => {
  withTempDir("hyk185-unconsumed-r4-d3-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-r4-d3",
      droppedAt: "2026-08-06 13:13",
      mtimeIso: "2026-08-06T13:13:00+09:00",
    });
    const resultFull = join(dir, ".harness", "coder.md");
    const statFn = (p) => {
      if (p === resultFull) {
        throw Object.assign(new Error("EACCES (injected)"), { code: "EACCES" });
      }
      return statSync(p);
    };
    const existsFn = (p) => (p === resultFull ? true : existsSync(p));
    // ★collectUnconsumedCandidates를 직접 부른다(judgeUnconsumedAcrossWorktrees
    // 를 거치면 그 안의 `git worktree list --porcelain`이 경로를 posix
    // 스타일로 정규화해 반환해, 이 시험이 만든 네이티브 경로 문자열과
    // 더 이상 정확히 일치하지 않게 된다 -- 주입 매칭이 깨진다). 이 축
    // 자신의 결선(judgeUnconsumedForWorktree)이 opts.existsFn/statFn을
    // collectUnconsumedCandidates에 실제로 넘긴다는 것은 이미 코드로
    // 확인했고(§R4-2 수리), 워크트리 스캔 계층은 다른 시험들이 이미
    // 덮는다 -- 이 시험은 오직 "existsSync 참/statSync 던짐" 코드 경로
    // 자체만 격리해서 본다.
    const evidence = collectUnconsumedCandidates(dir, { existsFn, statFn });
    assert.equal(evidence.failed, true);
    assert.deepEqual(evidence.items, []);
  });
});

// ---------------------------------------------------------------------------
// (3) §R3-1(B) header-time-projection -- 완전히 분리된 신호. 소비 판정
// 함수는 이 신호를 호출하지 않는다(아래 (3c) "분리" 시험이 직접 증명).
// ---------------------------------------------------------------------------
test("scanHeaderTimeProjection: 헤더가 실물보다 미래를 주장 -> PROJECTED_FUTURE가 뜬다 (1/1)", () => {
  withTempDir("hyk185-projection-future-", (dir) => {
    initPlainGitRepo(dir);
    // 헤더는 13:50이라고 적지만, 그 파일의 실제 mtime은 13:00(헤더보다
    // 이르다) -- 검토자 2R 반례와 같은 형태(이번에는 소비 판정이 아니라
    // 이 축 자신을 시험한다).
    writeTaskFile(dir, {
      taskId: "HYK-185-projection-1",
      droppedAt: "2026-08-06 13:50",
      mtimeIso: "2026-08-06T13:00:00+09:00",
    });
    const r = scanHeaderTimeProjection(dir);
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 1);
    assert.equal(
      r.items[0].verdict,
      HEADER_TIME_PROJECTION_VERDICT.PROJECTED_FUTURE,
    );
  });
});

test("scanHeaderTimeProjection: 정상 방향(mtime이 헤더보다 늦음, 실측 편차 +103초) -> NORMAL, 크기와 무관 (1/1)", () => {
  withTempDir("hyk185-projection-normal-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-projection-2",
      droppedAt: "2026-08-06 13:50",
      mtimeIso: "2026-08-06T13:51:43+09:00", // 헤더(13:50:00)보다 103초 늦다.
    });
    const r = scanHeaderTimeProjection(dir);
    assert.equal(r.items[0].verdict, HEADER_TIME_PROJECTION_VERDICT.NORMAL);
  });
});

test("scanHeaderTimeProjection: 헤더가 없는 task 파일은 대조 대상에서 아예 빠진다(대조할 것이 없다) (1/1)", () => {
  withTempDir("hyk185-projection-noheader-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-projection-3",
      mtimeIso: "2026-08-06T13:50:00+09:00",
      // droppedAt 생략 -- 헤더 줄 자체가 없다.
    });
    const r = scanHeaderTimeProjection(dir);
    assert.equal(r.ok, true);
    assert.deepEqual(r.items, []);
  });
});

test("scanHeaderTimeProjection: .harness 읽기 실패 -> ok:false(판정 불가로 닫힘) (1/1)", () => {
  const r = scanHeaderTimeProjection("C:/wt", {
    harnessReaddirFn: () => {
      const err = new Error("EACCES");
      err.code = "EACCES";
      throw err;
    },
  });
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// (3c) ★«분리»를 깨는 시험(§R3-2 필수, 이게 없으면 "분리했다"는 근거 없는
// 주장이다) -- 같은 task/결과 파일 배치에서 헤더 텍스트만 "정상"/"미래
// 주장"으로 바꾸고, 두 경우 모두 소비 판정 결과가 완전히 동일함을
// 단언한다. scanHeaderTimeProjection의 verdict는 서로 다르다(대조군).
// ---------------------------------------------------------------------------
test("★분리 증명: header-time-projection이 PROJECTED_FUTURE를 내도 소비 판정(runOrchStallDetect의 result.unconsumed)은 조금도 바뀌지 않는다 (1/1)", () => {
  const taskId = "HYK-185-separation";
  const resultAtIso = "2026-08-06T13:19:21+09:00";
  const taskMtimeIso = "2026-08-06T13:50:00+09:00"; // review-task.md의 실제 mtime -- 두 세계에서 동일.
  const nowIso = new Date(Date.parse(taskMtimeIso) + 60_000).toISOString();

  // withTempDir는 콜백이 끝나면 디렉터리를 지우므로, projection 신호도
  // 같은 스코프(콜백 안) 안에서 함께 뽑아 돌려준다 -- dir이 사라진 뒤
  // 재조회할 수 없다.
  function buildWorld(dir, droppedAt) {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: `${taskId}-coder`,
      droppedAt: "2026-08-06 13:13",
      mtimeIso: "2026-08-06T13:13:00+09:00",
    });
    writeResultFileAt(dir, { name: "coder.md", updatedAtIso: resultAtIso });
    writeTaskFile(dir, {
      name: "review-task.md",
      taskId: `${taskId}-review`,
      droppedAt,
      mtimeIso: taskMtimeIso,
    });
    const detect = runOrchStallDetect(
      ["--repo-root", dir, "--now", nowIso, "--json"],
      {},
    );
    const projection = scanHeaderTimeProjection(dir);
    return { unconsumed: detect.result.unconsumed, projection };
  }

  const worldNormal = withTempDir(
    "hyk185-separation-normal-",
    (dir) => buildWorld(dir, "2026-08-06 13:49"), // 헤더가 실물(13:50:00)보다 이르다 -- NORMAL.
  );
  const worldProjected = withTempDir(
    "hyk185-separation-projected-",
    (dir) => buildWorld(dir, "2026-08-06 14:30"), // 헤더가 실물보다 미래를 주장 -- PROJECTED_FUTURE.
  );

  // 대조군: 두 세계의 projection 신호는 실제로 다르다(시험 자체가 헛시험이
  // 아님을 보증) -- 이게 없으면 "두 세계가 애초에 똑같아서" 소비 판정이
  // 같은 것도 당연해 보이는 헛시험이 된다.
  assert.equal(
    worldNormal.projection.items.find(
      (i) => i.path === ".harness/review-task.md",
    ).verdict,
    HEADER_TIME_PROJECTION_VERDICT.NORMAL,
  );
  assert.equal(
    worldProjected.projection.items.find(
      (i) => i.path === ".harness/review-task.md",
    ).verdict,
    HEADER_TIME_PROJECTION_VERDICT.PROJECTED_FUTURE,
  );

  // 본 단언: projection 신호가 서로 다른데도(NORMAL vs PROJECTED_FUTURE)
  // 소비 판정 결과는 완전히 동일하다 -- 분리가 실제로 지켜진다. `mkdtemp`
  // 경로 문자열 자체는 두 세계가 서로 달라 당연히 다르므로(무관한 잡음)
  // 그 필드만 지우고 비교한다.
  function stripWorktreePaths(unconsumedResult) {
    const rest = { ...unconsumedResult };
    delete rest.worktreePath;
    rest.worktrees = rest.worktrees.map((w) => {
      const wCopy = { ...w };
      delete wCopy.worktreePath;
      return wCopy;
    });
    return rest;
  }
  assert.deepEqual(
    stripWorktreePaths(worldNormal.unconsumed),
    stripWorktreePaths(worldProjected.unconsumed),
  );
});

test("★분리 증명의 대조군: 위와 동일한 두 헤더 값이 실제로 서로 다른 projection verdict를 낸다(시험이 헛시험이 아님을 보증) (2/2)", () => {
  const taskMtimeIso = "2026-08-06T13:50:00+09:00";
  withTempDir("hyk185-separation-control-normal-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      name: "review-task.md",
      taskId: "control-normal",
      droppedAt: "2026-08-06 13:49",
      mtimeIso: taskMtimeIso,
    });
    const r = scanHeaderTimeProjection(dir);
    assert.equal(r.items[0].verdict, HEADER_TIME_PROJECTION_VERDICT.NORMAL);
  });
  withTempDir("hyk185-separation-control-projected-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      name: "review-task.md",
      taskId: "control-projected",
      droppedAt: "2026-08-06 14:30",
      mtimeIso: taskMtimeIso,
    });
    const r = scanHeaderTimeProjection(dir);
    assert.equal(
      r.items[0].verdict,
      HEADER_TIME_PROJECTION_VERDICT.PROJECTED_FUTURE,
    );
  });
});

// ---------------------------------------------------------------------------
// (4) ★실물 재현(coder-task.md §R3-2/§5-a) -- fixture의 실측 ISO 시각을
// 그대로 쓰고, 경과 시간은 여기서 재계산한다(손으로 "31분"을 옮겨 적지
// 않는다, docs/task-contract.md Standing-B). mtime은 이제 fixture의 ISO
// 값을 **직접** writeTaskFile의 mtimeIso로 넘긴다(헤더에서 계산하지
// 않는다).
// ---------------------------------------------------------------------------
test("★실물 재현 13:44 계열(fixture series_1344): 다음 라운드가 드롭되기 전에는 SUSPECTED_UNCONSUMED, 드롭 신호가 들어오면 CONSUMED -- 실측 mtime을 그대로 쓴 mkdtemp 워크트리를 통한 e2e (2/2)", () => {
  withTempDir("hyk185-unconsumed-1344-", (dir) => {
    initPlainGitRepo(dir);
    const s = FIXTURE.series_1344;
    const resultAtMs = Date.parse(s.resultFileUpdatedAtIso);
    const dropAtMs = Date.parse(s.consumingTaskFileDroppedAtIso);
    const elapsedMinutes = (dropAtMs - resultAtMs) / 60_000;
    assert.ok(
      elapsedMinutes > 15,
      `fixture 재계산: 이 구간은 기본 임계(15분)를 넘겨야 실사고 재현이 성립한다 (재계산값 ${elapsedMinutes.toFixed(1)}분)`,
    );

    writeTaskFile(dir, {
      taskId: "HYK-185-claim-test-1",
      droppedAt: "2026-08-06 13:13",
      mtimeIso: "2026-08-06T13:13:36+09:00",
    });
    writeResultFileAt(dir, {
      name: "coder.md",
      updatedAtIso: s.resultFileUpdatedAtIso,
    });

    // (a) 다음 라운드가 아직 드롭되지 않은 채 임계를 넘긴 시점 관측 --
    // 오늘 실제로 관측됐을 «미소비» 구간과 동형.
    const beforeDrop = runOrchStallDetect(
      [
        "--repo-root",
        dir,
        "--now",
        new Date(resultAtMs + 20 * 60_000).toISOString(),
        "--json",
      ],
      {},
    );
    assert.equal(
      beforeDrop.result.unconsumed.status,
      UNCONSUMED_WIRE_STATUS.JUDGED,
    );
    assert.equal(
      beforeDrop.result.unconsumed.verdict,
      UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
    );

    // (b) 다음 라운드(review-task.md)가 실제로 드롭된 뒤(fixture의 실측
    // mtime을 그대로 씀) -- 정정되어 침묵한다.
    writeTaskFile(dir, {
      name: "review-task.md",
      taskId: "HYK-185-claim-test-2",
      droppedAt: "2026-08-06 13:50",
      mtimeIso: s.consumingTaskFileDroppedAtIso,
    });
    const afterDrop = runOrchStallDetect(
      [
        "--repo-root",
        dir,
        "--now",
        new Date(dropAtMs + 60_000).toISOString(),
        "--json",
      ],
      {},
    );
    assert.equal(
      afterDrop.result.unconsumed.status,
      UNCONSUMED_WIRE_STATUS.JUDGED,
    );
    assert.equal(
      afterDrop.result.unconsumed.verdict,
      UNCONSUMED_VERDICT.CONSUMED,
    );
  });
});

test("★실물 재현 14:11 계열(fixture series_1411): 재계산 실측 커밋 시각(2bffdcd, task 파일의 손글씨 근사값 '14:0x'가 아니라 `git show -s --format=%cI`로 다시 잰 값) 전에는 SUSPECTED_UNCONSUMED, 실제 커밋 뒤에는 CONSUMED -- 실 git 커밋을 그 시각에 만든 e2e (2/2)", () => {
  withTempDir("hyk185-unconsumed-1411-", (dir) => {
    initPlainGitRepo(dir);
    const s = FIXTURE.series_1411;
    const resultAtMs = Date.parse(s.resultFileUpdatedAtIso);
    const commitAtMs = Date.parse(s.consumingCommitAtIso);
    const elapsedMinutes = (commitAtMs - resultAtMs) / 60_000;
    assert.ok(
      elapsedMinutes > 15,
      `fixture 재계산: 이 구간은 기본 임계(15분)를 넘겨야 실사고 재현이 성립한다 (재계산값 ${elapsedMinutes.toFixed(1)}분)`,
    );

    writeTaskFile(dir, {
      taskId: "HYK-185-claim-test-review",
      droppedAt: "2026-08-06 13:50",
      mtimeIso: "2026-08-06T13:50:02+09:00",
    });
    writeResultFileAt(dir, {
      name: "coder.md",
      updatedAtIso: s.resultFileUpdatedAtIso,
    });

    const beforeCommit = runOrchStallDetect(
      [
        "--repo-root",
        dir,
        "--now",
        new Date(resultAtMs + 17 * 60_000).toISOString(),
        "--json",
      ],
      {},
    );
    assert.equal(
      beforeCommit.result.unconsumed.verdict,
      UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
    );

    commitAt(dir, s.consumingCommitAtIso, "docs(contract): consume");
    const afterCommit = runOrchStallDetect(
      [
        "--repo-root",
        dir,
        "--now",
        new Date(commitAtMs + 60_000).toISOString(),
        "--json",
      ],
      {},
    );
    assert.equal(
      afterCommit.result.unconsumed.verdict,
      UNCONSUMED_VERDICT.CONSUMED,
    );
  });
});

test("★P1-4 e2e(실물 mkdtemp): dropped_at 헤더가 아예 없는 task 파일이 결과 파일보다 나중에 갱신되면 -- CONSUMED로 정확히 판정된다(2R까지는 이 파일 자체가 evidence에서 사라져 SUSPECTED_UNCONSUMED로 오탐했다) (1/1)", () => {
  withTempDir("hyk185-unconsumed-p14-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-p14-coder",
      droppedAt: "2026-08-06 13:13",
      mtimeIso: "2026-08-06T13:13:00+09:00",
    });
    writeResultFileAt(dir, {
      name: "coder.md",
      updatedAtIso: "2026-08-06T13:19:21+09:00",
    });
    // 헤더 없는 다음 라운드 -- ORCH가 어떤 이유로든 dropped_at을 못 적은
    // 실물 형태(예: 기존 known-gap 표에 등재된 다른 실패 경로와 겹칠 때).
    writeTaskFile(dir, {
      name: "review-task.md",
      taskId: "HYK-185-p14-review",
      mtimeIso: "2026-08-06T13:50:02+09:00",
      // droppedAt 생략.
    });
    const now = Date.parse("2026-08-06T13:19:21+09:00") + 40 * 60_000;
    const { result } = runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      {},
    );
    assert.equal(result.unconsumed.verdict, UNCONSUMED_VERDICT.CONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (5) 오탐 0(§5-b) -- 정상적으로 빠르게 소비된 구간(fixture
// synthetic_fast_consumption, 명시적으로 합성)에서는 경과 시간과 무관하게
// 발화하지 않는다.
// ---------------------------------------------------------------------------
test("오탐 0: 합성 표본(fixture synthetic_fast_consumption, 3분 만에 정상 소비) -- 신호가 들어오면 임계 훨씬 이전이라도 CONSUMED, 같은 시각에 신호만 없으면 UNDECIDABLE(SUSPECTED로 새지 않는다) (2/2)", () => {
  withTempDir("hyk185-unconsumed-fastok-", (dir) => {
    initPlainGitRepo(dir);
    const s = FIXTURE.synthetic_fast_consumption;
    assert.equal(
      s._synthetic,
      true,
      "이 표본은 반드시 합성으로 표시돼 있어야 한다",
    );
    const dropAtMs = Date.parse(s.consumingTaskFileDroppedAtIso);

    writeTaskFile(dir, {
      taskId: "HYK-185-synthetic-1",
      droppedAt: "2026-08-06 08:57",
      mtimeIso: s.resultFileUpdatedAtIso,
    });
    writeResultFileAt(dir, {
      name: "coder.md",
      updatedAtIso: s.resultFileUpdatedAtIso,
    });
    writeTaskFile(dir, {
      name: "review-task.md",
      taskId: "HYK-185-synthetic-2",
      droppedAt: "2026-08-06 09:03",
      mtimeIso: s.consumingTaskFileDroppedAtIso,
    });

    const withSignal = runOrchStallDetect(
      [
        "--repo-root",
        dir,
        "--now",
        new Date(dropAtMs + 5000).toISOString(),
        "--json",
      ],
      {},
    );
    assert.equal(
      withSignal.result.unconsumed.verdict,
      UNCONSUMED_VERDICT.CONSUMED,
    );

    // 같은 시각(=아직 임계 15분에 한참 못 미친 시점)이라도 다음 라운드
    // task 파일이 애초에 없었다면 UNDECIDABLE(아직 이름)이지 SUSPECTED가
    // 아니다 -- 별도의 mkdtemp로 "신호 없음" 세계를 다시 만든다.
    withTempDir("hyk185-unconsumed-fastok-nosignal-", (dir2) => {
      initPlainGitRepo(dir2);
      writeTaskFile(dir2, {
        taskId: "HYK-185-synthetic-1",
        droppedAt: "2026-08-06 08:57",
        mtimeIso: s.resultFileUpdatedAtIso,
      });
      writeResultFileAt(dir2, {
        name: "coder.md",
        updatedAtIso: s.resultFileUpdatedAtIso,
      });
      const withoutSignal = runOrchStallDetect(
        [
          "--repo-root",
          dir2,
          "--now",
          new Date(dropAtMs + 5000).toISOString(),
          "--json",
        ],
        {},
      );
      assert.equal(
        withoutSignal.result.unconsumed.verdict,
        UNCONSUMED_VERDICT.UNDECIDABLE,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// (6) 판정 불가 경로(§5-d) -- 스캔 계층(워크트리 열거·harness 읽기 실패).
// ---------------------------------------------------------------------------
test("judgeUnconsumedAcrossWorktrees: git worktree list 자체가 실패 -> WORKTREE_LIST_FAILED(판정 불가), NOT_APPLICABLE로 접히지 않는다 (1/1)", () => {
  const r = judgeUnconsumedAcrossWorktrees(
    { repoRoot: "C:/wt", now: 1 },
    {
      gitWorktreeListExecFn: () => {
        throw new Error("git worktree list failed");
      },
    },
  );
  assert.equal(r.status, UNCONSUMED_SCAN_FAILURE.WORKTREE_LIST_FAILED);
  assert.notEqual(r.status, UNCONSUMED_WIRE_STATUS.NOT_APPLICABLE);
});

test("judgeUnconsumedAcrossWorktrees: 개별 워크트리 .harness 읽기 실패 -> HARNESS_READ_FAILED(판정 불가), git log 조회조차 시도하지 않는다 (1/1)", () => {
  const r = judgeUnconsumedAcrossWorktrees(
    { repoRoot: "C:/wt", now: 1 },
    {
      gitWorktreeListExecFn: () => "worktree C:/wt\n",
      harnessReaddirFn: () => {
        const err = new Error("EACCES");
        err.code = "EACCES";
        throw err;
      },
      commitTimeExecFn: () => {
        throw new Error("must not be called -- harness read already failed");
      },
    },
  );
  assert.equal(r.status, UNCONSUMED_SCAN_FAILURE.HARNESS_READ_FAILED);
  assert.notEqual(r.status, UNCONSUMED_WIRE_STATUS.NOT_APPLICABLE);
});

// ---------------------------------------------------------------------------
// (7) ★살아 있는 저장소 실측(§R3-2 필수, 한용이 요구한 확정 수단) -- 현재
// 등록된 워크트리 전부에 그대로 돌려 판정 도달 건수를 숫자로 남긴다.
// 2R에서는 전부 TASK_FILE_HEADER_MISMATCH(판정 도달 0건)였다.
// ---------------------------------------------------------------------------
test("★살아 있는 저장소 실측: 현재 등록된 워크트리 전부에 judgeUnconsumedAcrossWorktrees를 실제로 돌린다 -- 더 이상 TASK_FILE_HEADER_MISMATCH류로 전멸하지 않는다 (분모는 실행 시점의 실제 워크트리 수)", () => {
  const now = Date.now();
  const r = judgeUnconsumedAcrossWorktrees({ repoRoot: ROOT, now }, {});
  assert.ok(
    r.totalWorktrees >= 1,
    "이 저장소에 등록된 워크트리가 최소 1개는 있어야 한다(git worktree list 실측)",
  );
  for (const w of r.worktrees) {
    assert.notEqual(
      w.status,
      "UNCONSUMED_TASK_FILE_HEADER_MISMATCH", // 이 상태는 3R에서 완전히 삭제됐다 -- 어떤 워크트리도 이 문자열을 낼 수 없다.
      `${w.worktreePath}가 삭제된 상태값을 냈다(있을 수 없다)`,
    );
  }
  // 보고서에 옮길 실측 숫자(§R3-6-(e)) -- 이 콘솔 출력을 보고서가 그대로
  // 인용한다(손으로 다시 세지 않는다).
  console.log(
    `[HYK-185-unconsumed-3 실측] totalWorktrees=${r.totalWorktrees} worstStatus=${r.status} worstVerdict=${r.verdict ?? "N/A"} perWorktree=${JSON.stringify(
      r.worktrees.map((w) => ({
        path: w.worktreePath,
        status: w.status,
        verdict: w.verdict,
      })),
    )}`,
  );
});

// ---------------------------------------------------------------------------
// (8) 필수 mutation -- 디스크의 현재 소스를 읽는다(헤더 S11-3 참조).
// ---------------------------------------------------------------------------
const LIVE_SRC_PATH = join(THIS_DIR, "orch-stall-detect.mjs");
const LIVE_SRC = readFileSync(LIVE_SRC_PATH, "utf8");

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
    join(tmpdir(), `hyk185-unconsumed-mutant-${label}-`),
  );
  const mutantPath = join(mutantDir, "orch-stall-detect.mutant.mjs");
  writeFileSync(mutantPath, rewritten, "utf8");
  try {
    return await import(`file://${mutantPath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

test("NC mutation/unconsumed-wire #1 (필수): 결선 제거(코어를 부르지 않게) -> RED (실 미소비 구간인데도 SUSPECTED_UNCONSUMED가 되지 않는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "  const unconsumed = judgeUnconsumedAcrossWorktrees({ repoRoot, now }, opts);",
        "  const unconsumed = { status: UNCONSUMED_WIRE_STATUS.NOT_APPLICABLE };",
      ),
    "1",
  );
  await withTempDir("hyk185-unconsumed-mutant1-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-claim-test-1",
      droppedAt: "2026-08-06 13:13",
      mtimeIso: "2026-08-06T13:13:00+09:00",
    });
    writeResultFileAt(dir, {
      name: "coder.md",
      updatedAtIso: "2026-08-06T13:19:21+09:00",
    });
    const { result } = mutant.runOrchStallDetect(
      [
        "--repo-root",
        dir,
        "--now",
        new Date(
          Date.parse("2026-08-06T13:19:21+09:00") + 20 * 60_000,
        ).toISOString(),
        "--json",
      ],
      {},
    );
    assert.equal(
      result.unconsumed.status,
      "UNCONSUMED_NOT_APPLICABLE",
      "mutant must never actually judge the real unconsumed gap (RED signal; proves the wiring call is load-bearing)",
    );
  });
});

test("NC mutation/unconsumed-wire #2 (필수): 커밋 신호 생성 제거 -> RED (실제로 소비된 커밋 구간이 여전히 SUSPECTED_UNCONSUMED로 남는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        '  if (\n    commitInfo.ok &&\n    typeof commitInfo.commitTimeMs === "number" &&\n    commitInfo.commitTimeMs > targetMtimeMs\n  ) {\n    signals.push({\n      kind: UNCONSUMED_SIGNAL_KIND.NEW_COMMIT_AFTER,\n      atMs: commitInfo.commitTimeMs,\n    });\n  }\n',
        "",
      ),
    "2",
  );
  await withTempDir("hyk185-unconsumed-mutant2-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-claim-test-review",
      droppedAt: "2026-08-06 13:50",
      mtimeIso: "2026-08-06T13:50:02+09:00",
    });
    writeResultFileAt(dir, {
      name: "coder.md",
      updatedAtIso: "2026-08-06T13:54:38+09:00",
    });
    const commitIso = "2026-08-06T14:13:05+09:00";
    commitAt(dir, commitIso, "consume");
    const { result } = mutant.runOrchStallDetect(
      [
        "--repo-root",
        dir,
        "--now",
        new Date(Date.parse(commitIso) + 60_000).toISOString(),
        "--json",
      ],
      {},
    );
    assert.equal(
      result.unconsumed.verdict,
      "SUSPECTED_UNCONSUMED",
      "mutant must fail to see the real consuming commit (RED signal; proves the commit-signal construction is load-bearing)",
    );
  });
});

test("NC mutation/unconsumed-wire #3 (필수): 대상 선정을 뒤집음(가장 오래된 결과 파일을 고름) -> RED (최신 산출물의 미소비가 옛 결과 뒤로 가려진다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "    .sort((a, b) => b.resultFile.mtimeMs - a.resultFile.mtimeMs);",
        "    .sort((a, b) => a.resultFile.mtimeMs - b.resultFile.mtimeMs);",
      ),
    "3",
  );
  await withTempDir("hyk185-unconsumed-mutant3-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-old",
      droppedAt: "2026-08-06 08:00",
      mtimeIso: "2026-08-06T08:00:00+09:00",
    });
    writeResultFileAt(dir, {
      name: "coder.md",
      updatedAtIso: "2026-08-06T08:10:00+09:00",
    });
    writeTaskFile(dir, {
      name: "review-task.md",
      taskId: "HYK-185-new",
      droppedAt: "2026-08-06 13:13",
      mtimeIso: "2026-08-06T13:13:00+09:00",
    });
    writeResultFileAt(dir, {
      name: "review.md",
      updatedAtIso: "2026-08-06T13:19:21+09:00",
    });
    const { result } = mutant.runOrchStallDetect(
      [
        "--repo-root",
        dir,
        "--now",
        new Date(
          Date.parse("2026-08-06T13:19:21+09:00") + 20 * 60_000,
        ).toISOString(),
        "--json",
      ],
      {},
    );
    assert.notEqual(
      result.unconsumed.verdict,
      "SUSPECTED_UNCONSUMED",
      "mutant must pick the stale already-superseded result instead of the newest unconsumed one (RED signal; proves 'most recent' selection is load-bearing)",
    );
  });
});

test("NC mutation/unconsumed-wire #4 (필수, §R3-1(A)): taskFileMtimeMs 형식 가드 제거 -> RED (mtime을 못 구한 항목이 조용히 '신호 없음'으로 새고, TASK_FILE_MTIME_UNAVAILABLE로 닫히지 않는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        '    if (\n      typeof item.taskFileMtimeMs !== "number" ||\n      !Number.isFinite(item.taskFileMtimeMs)\n    ) {\n      return { ok: false, unavailablePath: item.path };\n    }\n',
        "",
      ),
    "4",
  );
  const taskFileCandidates = [
    {
      path: ".harness/coder-task.md",
      taskFileMtimeMs: 1000,
      resultFile: { path: ".harness/coder.md", exists: true, mtimeMs: 2000 },
    },
    {
      path: ".harness/review-task.md",
      taskFileMtimeMs: null,
      resultFile: { path: ".harness/review.md", exists: false, mtimeMs: null },
    },
  ];
  const r = mutant.judgeUnconsumedForRepo(
    { repoRoot: "C:/wt", taskFileCandidates, now: 999_999 },
    { commitTimeExecFn: () => "1970-01-01T00:00:00.000Z" },
  );
  assert.notEqual(
    r.status,
    "UNCONSUMED_TASK_FILE_MTIME_UNAVAILABLE",
    "mutant must silently drop the item with unavailable mtime instead of closing to TASK_FILE_MTIME_UNAVAILABLE (RED signal; proves the guard is load-bearing)",
  );
});

// ★HYK-185-unconsumed-4 §R4-1 재구성으로 실측 재확인: `statForUnconsumed`
// 는 디렉터리일 때 `mtimeMs` 자체를 안 돌려주므로(§R4-1 새 설계),
// task 파일 쪽의 이 가드를 지워도 "거짓 CONSUMED"까지는 더 이상
// 재현되지 않는다(디버깅으로 실측 확인) -- `taskFileMtimeMs`가
// `undefined`인 채로 넘어가 `buildUnconsumedSignals`의 형식 가드가
// 대신 잡아 `TASK_FILE_MTIME_UNAVAILABLE`로 닫힌다. 그래도 이 가드는
// 의미가 있다 -- 지우면 표면화되는 **상태 이름이 바뀐다**
// (`HARNESS_READ_FAILED`인 스캔 단계 실패 -> `TASK_FILE_MTIME_UNAVAILABLE`
// 인 판정 단계 실패). 그 자체가 계약이므로 mutation으로 고정한다.
test("NC mutation/unconsumed-wire #5 (필수, 자체 발견 반례 재확인): task 파일 디렉터리 가드 제거 -> RED (스캔 단계 HARNESS_READ_FAILED가 아니라 판정 단계 실패로 새어나간다 -- 여전히 안전하지만 계약이 깨진다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "  if (selfInfo.isDirectory) return null; // 디렉터리 위장(기존 자체 발견 반례, 회귀 0).\n",
        "",
      ),
    "5",
  );
  await withTempDir("hyk185-unconsumed-mutant5-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-p1-2-coder",
      droppedAt: "2026-08-06 13:13",
      mtimeIso: "2026-08-06T13:13:00+09:00",
    });
    writeResultFileAt(dir, {
      name: "coder.md",
      updatedAtIso: "2026-08-06T13:19:21+09:00",
    });
    const sneakyPath = join(dir, ".harness", "sneaky-task.md");
    mkdirSync(sneakyPath, { recursive: true });
    const sneakyMtime = new Date("2026-08-06T13:50:00+09:00");
    utimesSync(sneakyPath, sneakyMtime, sneakyMtime);
    const now = Date.parse("2026-08-06T13:19:21+09:00") + 40 * 60_000;
    const r = mutant.judgeUnconsumedAcrossWorktrees({ repoRoot: dir, now }, {});
    assert.notEqual(
      r.status,
      "UNCONSUMED_SCAN_HARNESS_READ_FAILED",
      "mutant must let a directory-shaped task file reach the collection stage instead of being rejected at scan time (RED signal; proves the early isDirectory guard is load-bearing for which failure stage surfaces)",
    );
  });
});

test("NC mutation/unconsumed-wire #6 (필수, §R3-1(B) 결선): scanHeaderTimeProjection이 실제 코어를 부르지 않게 함 -> RED (미래를 주장하는 헤더인데도 PROJECTED_FUTURE가 뜨지 않는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "      const judged = judgeHeaderTimeProjection({\n        headerFloorMs: item.droppedAtMs,\n        taskFileMtimeMs: item.taskFileMtimeMs,\n      });\n      return { path: item.path, ...judged };",
        '      return { path: item.path, ok: true, verdict: "NORMAL", reasonCode: "STUB", details: null };',
      ),
    "6",
  );
  await withTempDir("hyk185-unconsumed-mutant6-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-projection-mutant",
      droppedAt: "2026-08-06 14:30",
      mtimeIso: "2026-08-06T13:00:00+09:00", // 헤더가 훨씬 미래를 주장.
    });
    const r = mutant.scanHeaderTimeProjection(dir);
    assert.notEqual(
      r.items[0].verdict,
      "PROJECTED_FUTURE",
      "mutant must fail to detect a genuinely future-projected header (RED signal; proves the wiring to the real core is load-bearing)",
    );
  });
});

// ★디버깅 실측: 이 가드를 지우면(§R4-1 새 설계 기준) `resultInfo.exists
// && resultInfo.isDirectory`인 항목이 그대로 아이템에 실리는데,
// `statForUnconsumed`가 디렉터리엔 `mtimeMs`를 안 주므로
// `resultFile.mtimeMs`가 `undefined`가 된다 -- `selectMostRecentConsumableResult`
// 의 `typeof mtimeMs === "number"` 필터에 걸려 이 항목이 후보에서
// 통째로 빠지고, 다른 후보가 없으면 **`NOT_APPLICABLE`(정상)로 접힌다.**
// 이것이 바로 한용이 명시적으로 금지한 그 형태다("디렉터리를 «파일
// 없음»으로 접지 마라 -- 그러면 NOT_APPLICABLE이 되어 1R에서 반려된
// «판정 불가가 정상으로 접힘»과 같은 형태가 된다"). SUSPECTED_UNCONSUMED
// 가 아니라 NOT_APPLICABLE로 새는 형태라는 것을 디버깅으로 실측한 뒤
// 이 단언으로 고정했다(처음 예상은 SUSPECTED_UNCONSUMED였으나 실측과
// 달라 여기서 정정한다).
test("NC mutation/unconsumed-wire #7 (필수, §R4-1): 결과 파일 디렉터리 가드 제거 -> RED (검토자 D2 반례가 다시 NOT_APPLICABLE로 «정상» 처리된다 -- 한용이 명시적으로 금지한 형태)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "  if (resultInfo.exists && resultInfo.isDirectory) return null; // §R4-1: 결과 파일 디렉터리 위장.\n",
        "",
      ),
    "7",
  );
  await withTempDir("hyk185-unconsumed-mutant7-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-r4-d2-mutant",
      droppedAt: "2026-08-06 13:13",
      mtimeIso: "2026-08-06T13:13:00+09:00",
    });
    const resultDirPath = join(dir, ".harness", "coder.md");
    mkdirSync(resultDirPath, { recursive: true });
    const dirMtime = new Date("2026-08-06T13:19:21+09:00");
    utimesSync(resultDirPath, dirMtime, dirMtime);
    const now = Date.parse("2026-08-06T13:19:21+09:00") + 40 * 60_000;
    const r = mutant.judgeUnconsumedAcrossWorktrees({ repoRoot: dir, now }, {});
    assert.equal(
      r.status,
      "UNCONSUMED_NOT_APPLICABLE",
      "mutant must silently treat the directory-shaped result as 'no result' (NOT_APPLICABLE) instead of surfacing it as undecidable (RED signal; proves the result-file directory guard is load-bearing -- this is exactly the 'directory as no-file' pattern the task explicitly forbids)",
    );
  });
});

// ---------------------------------------------------------------------------
// 원상복구 단언(dispatch-start-wire.test.mjs와 동형).
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "unconsumed-wire.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "unconsumed-wire.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
