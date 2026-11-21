// HYK-255-rescan-wire-1 (판정 #20261120-1424 3 레인 1 · #20261120-1519 · #20261120-2346 · PM 설계 (나) · 조각 R2) -- 전수 재조회 CLI.
//
// 무엇: 1-C 선언 직전 «캐시 끔 전수 재조회» 를 사람이 명령 하나로 여러 번 치면, 창 7일 동안 GitHub 사람 손(변경 요청 · 미병합 닫기 ·
// 대화 댓글 · 리뷰 줄 댓글 · Update branch · 기각된 리뷰)이 «미조회 없이» 중복 없이 세어지고, 다 셌을 때만 마지막 줄이
// «전수 재조회: 완료 — 남은 미조회 0» 이 된다. 판정 심장(상태 · 합집합 · 예산 계획 · 남은 미조회 판정 · 렌더)은 R1 core
// (partial-count-rescan-core.mjs) 한 벌이고, 이 파일은 «I/O» 만 한다 -- 망(GET) · git 읽기 · 상태 파일 · 보고 파일.
//
//   node scripts/supervisor/partial-count-rescan.mjs --from-day YYYY-MM-DD --days 7 --state <파일> --report-out <파일> [--max-calls N]
//
//   인자 다섯뿐(모르는 플래그 · 값 없음 · 중복 = 거부 · 기존 CLI 의 «모르는 플래그 무시» 와 다르다).
//   끝 신호: exit 0 = 완료(남은 미조회 0) · exit 3 = 미완(찍힌 시각 뒤에 같은 명령을 다시 친다) · exit 1 = 거부/고장(창 미종료 · 상태 깨짐 ·
//   fingerprint 불일치 · 인자 오류 · git 입력 못 읽음 · 저장 실패). 마지막 줄 문면이 신호의 정본이다.
//
// 캐시 끔의 뜻: partial-count-approval-cache.json · partial-count-daily* · watch 보고서를 읽지도 쓰지도 않는다. 모든 수는 이 재조회
// 실행들이 받은 REST 응답에서만 나온다. 승인(ㄱ) 판정은 하지 않는다(ㄴ 전용). 감시 회차(watch-run)와는 import 도 호출도 없다.
//
// 창 문(판정 #20261120-2346 3 · R1 검토 P2 둘째): 창이 닫히기 전 실행은 «모든 흡수 앞에서» 거부한다 -- 호출 0 · 쓰기 0 · 종료 값 1.
//   runRescanOnce(프로덕션 진입점) 도 같은 문이고, core 의 흡수 함수도 두 번째 벽으로 같은 문을 건다.
//
// 예산: 실행당 10 · 직전 60분 합 10(core planRunBudget). 403/429 는 그 실행을 «바로» 멈춘다(재시도 0 · 상태 보존).
//   원자 쓰기: 작업 단위 하나가 끝날 때마다 상태 파일을 tmp -> rename 으로 쓴다(프로세스가 죽어도 잃는 것은 단위 하나). 이번 실행이 쓴 호출 수는
//   그 시점마다 runs[] 에 같이 적혀 예산 합이 중간에 죽어도 줄지 않는다.
//
// ⚠️정직 한계: 상태 파일은 ORCH 가 쓸 수 있는 파일이라 독립 앵커가 아니다 · PR 쓸기는 한 실행 안에서 끝까지 넘기는 방식이라 PR 목록이 실행당
// 호출 한도(10쪽)를 넘는 창은 끝나지 않는다(미완 반복) · 나머지는 core RESCAN_HONESTY_LIMITS 와 docs/enforcement-known-gaps.md.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAnonymousFetchJson,
  measureRepoIdentity,
} from "./approval-authority-adapter.mjs";
import {
  GITHUB_LIST_PAGE_SIZE,
  githubListCoversWindow,
} from "./partial-count-core.mjs";
import {
  DEFAULT_ALLOWLIST_PATH,
  DEFAULT_GITHUB_BOT_ACCOUNTS_PATH,
  collectUpdateBranchCandidates,
  createProcessGitPort,
  fetchCommitResponse,
  hasWellFormedCommitShape,
  isVerifiedAllowlistedWebMerge,
  readExternalEvidenceAllowlist,
  readGithubBotLogins,
} from "./partial-count-report.mjs";
import {
  RESCAN_EXIT,
  RESCAN_MAX_CALLS_PER_RUN,
  absorbCommentPages,
  absorbPrSweep,
  absorbReviewPages,
  acceptRescanState,
  buildRescanFingerprint,
  computeRescanWindow,
  createRescanState,
  judgeWindowClosed,
  markUnitFailed,
  planRescanTargets,
  planRunBudget,
  recordRescanRun,
  recordUpdateBranchResult,
  registerUpdateBranchCandidates,
  renderRescanReport,
} from "./partial-count-rescan-core.mjs";

export const RESCAN_CLI_FLAGS = Object.freeze({
  "--from-day": "fromDay",
  "--days": "days",
  "--state": "statePath",
  "--report-out": "reportOut",
  "--max-calls": "maxCalls",
});

const GITHUB_API_REPOS = "https://api.github.com/repos";
const PR_MERGE_SUBJECT_RE = /^Merge pull request #(\d+)(?:\s|$)/;
const MERGE_LOG_FIELD_SEP = "\x1f";
const MERGE_LOG_FORMAT = ["%H", "%cI", "%s"].join("%x1f");
// 병합 로그 상한 -- 후보 고름(report CANDIDATE_LOG_MAX_MERGES)과 같은 크기의 여유.
const MERGE_LOG_MAX = 500;
const BLOB_ID_RE = /^[0-9a-f]{40}$/;
const NEXT_LINK_RE = /<[^>]*>\s*;\s*rel="next"/;
const NON_NEGATIVE_INT_RE = /^\d+$/;

const oneLine = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

const refused = (reason) => ({
  exit: RESCAN_EXIT.REFUSED,
  lines: [`전수 재조회: 거부 — ${oneLine(reason)}`],
  calls: 0,
  stop: null,
  wrote: { state: false, report: false },
});

// ---------------------------------------------------------------------------
// 인자 -- 다섯뿐 · 모르는 플래그 거부
// ---------------------------------------------------------------------------

function flagPairs(argv) {
  const pairs = [];
  for (let i = 0; i < argv.length; i += 2) {
    pairs.push([argv[i], argv[i + 1]]);
  }
  return pairs;
}

const numberFlag = (flag, text) =>
  NON_NEGATIVE_INT_RE.test(text) ? null : `${flag} 는 0 이상 정수여야 한다`;

// argv -> {ok:true, options:{fromDay, days, statePath, reportOut, maxCalls?}} | {ok:false, reason}
export function parseRescanArgs(argv) {
  const out = {};
  for (const [flag, value] of flagPairs(argv)) {
    if (!Object.hasOwn(RESCAN_CLI_FLAGS, flag)) {
      return { ok: false, reason: `모르는 플래그: ${oneLine(flag)}` };
    }
    const key = RESCAN_CLI_FLAGS[flag];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, reason: `${flag} 값 없음` };
    }
    if (Object.hasOwn(out, key)) {
      return { ok: false, reason: `${flag} 중복` };
    }
    out[key] = value;
  }
  const missing = ["--from-day", "--days", "--state", "--report-out"].filter(
    (flag) => !Object.hasOwn(out, RESCAN_CLI_FLAGS[flag]),
  );
  if (missing.length > 0) {
    return { ok: false, reason: `필수 인자 없음: ${missing.join(" ")}` };
  }
  const badNumber =
    numberFlag("--days", out.days) ??
    (out.maxCalls === undefined
      ? null
      : numberFlag("--max-calls", out.maxCalls));
  if (badNumber !== null) return { ok: false, reason: badNumber };
  return {
    ok: true,
    options: {
      ...out,
      days: Number(out.days),
      ...(out.maxCalls === undefined ? {} : { maxCalls: Number(out.maxCalls) }),
    },
  };
}

// ---------------------------------------------------------------------------
// 원자 쓰기(tmp -> rename · 기존 writeApprovalCache 방식) -- 실패는 사유 문자열(throw 0).
// ---------------------------------------------------------------------------

export const defaultRescanIo = Object.freeze({
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
});

export function writeTextAtomic({ io, filePath, text }) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    io.mkdirSync(path.dirname(filePath), { recursive: true });
    io.writeFileSync(tmp, text, "utf8");
    io.renameSync(tmp, filePath);
    return null;
  } catch (err) {
    try {
      io.unlinkSync(tmp);
    } catch {
      // 임시 파일이 안 만들어졌으면 지울 것도 없다.
    }
    return oneLine(err?.message ?? err);
  }
}

const stateText = (state) => `${JSON.stringify(state, null, 2)}\n`;

// ---------------------------------------------------------------------------
// git 읽기(망 0) -- 저장소 신원 · 봇 목록 blob · 봇 목록 · 창 안 PR 병합 번호 · D1 후보 · 허용 목록
// ---------------------------------------------------------------------------

async function gitStdout(git, args) {
  const result = await git.run(args);
  if (!result || result.code !== 0) {
    return { ok: false, detail: oneLine(result?.stderr || "git 실패") };
  }
  return { ok: true, text: String(result.stdout).trim() };
}

// origin/master 판본 봇 목록 파일의 blob id -- fingerprint 의 botListBlob(봇 목록이 바뀌면 상태를 섞지 않는다).
async function readBotListBlob({ git, botAccountsPath }) {
  const gitPath = botAccountsPath.split(path.sep).join("/");
  const read = await gitStdout(git, ["rev-parse", `origin/master:${gitPath}`]);
  if (!read.ok)
    return { ok: false, reason: `봇 목록 blob 읽기 실패: ${read.detail}` };
  return BLOB_ID_RE.test(read.text)
    ? { ok: true, blob: read.text }
    : { ok: false, reason: "봇 목록 blob id 모양 오류" };
}

// 창 안 first-parent 병합 커밋 제목의 «Merge pull request #N» -> PR 번호(목록 쓸기가 놓친 병합 PR 을 보강).
async function readMergedPrNumbers({ git, window }) {
  const log = await gitStdout(git, [
    "log",
    "--first-parent",
    "--merges",
    `--format=${MERGE_LOG_FORMAT}`,
    "-n",
    String(MERGE_LOG_MAX),
    "origin/master",
  ]);
  if (!log.ok)
    return { ok: false, reason: `병합 로그 읽기 실패: ${log.detail}` };
  const numbers = new Set();
  for (const line of log.text.split(/\r?\n/)) {
    const [, iso, subject = ""] = line.split(MERGE_LOG_FIELD_SEP);
    const tsMs = Date.parse(iso);
    const match = PR_MERGE_SUBJECT_RE.exec(subject);
    if (match && tsMs >= window.startMs && tsMs <= window.windowEndMs) {
      numbers.add(Number(match[1]));
    }
  }
  return { ok: true, numbers: [...numbers].sort((a, b) => a - b) };
}

async function readGitInputs({ git, window, botAccountsPath }) {
  const identity = await measureRepoIdentity({ git });
  if (!identity.ok) {
    return {
      ok: false,
      reason: `저장소 신원 측정 실패: ${oneLine(identity.detail)}`,
    };
  }
  const blob = await readBotListBlob({ git, botAccountsPath });
  if (!blob.ok) return blob;
  const bots = await readGithubBotLogins({ git, botAccountsPath });
  if (!bots.ok)
    return { ok: false, reason: `봇 목록 읽기 실패: ${oneLine(bots.reason)}` };
  const merged = await readMergedPrNumbers({ git, window });
  if (!merged.ok) return merged;
  const candidates = await collectUpdateBranchCandidates({
    git,
    windowStartMs: window.startMs,
    windowEndMs: window.windowEndMs,
  });
  if (!candidates.ok) {
    return {
      ok: false,
      reason: `D1 후보 고름 실패: ${oneLine(candidates.detail)}`,
    };
  }
  return {
    ok: true,
    repo: identity.repoFullName,
    botListBlob: blob.blob,
    botLogins: bots.logins,
    mergedPrs: merged.numbers,
    d1Candidates: candidates.candidates,
  };
}

// ---------------------------------------------------------------------------
// 상태 읽기 -- 없으면 새 상태 · 깨짐 / fingerprint 불일치 = 거부(쓰기 0)
// ---------------------------------------------------------------------------

function loadRescanState({ io, statePath, fingerprint }) {
  if (!io.existsSync(statePath)) {
    return {
      ok: true,
      state: createRescanState({ fingerprint }),
      rawText: null,
    };
  }
  let rawText;
  let value;
  try {
    rawText = io.readFileSync(statePath, "utf8");
    value = JSON.parse(rawText);
  } catch (err) {
    return {
      ok: false,
      reason: `상태 파일 읽기 실패: ${oneLine(err?.message ?? err)}`,
    };
  }
  const accepted = acceptRescanState({
    stateValue: value,
    expectedFingerprint: fingerprint,
  });
  return accepted.ok
    ? { ok: true, state: accepted.state, rawText }
    : { ok: false, reason: accepted.reason };
}

// ---------------------------------------------------------------------------
// 호출 -- 시도마다 1 · 예산 밖이면 부르지 않고 · 403/429 는 그 실행을 멈춘다
// ---------------------------------------------------------------------------

const hasNextLink = (link) =>
  typeof link === "string" && NEXT_LINK_RE.test(link);

function createCaller({ fetchJson, allowedCalls, run }) {
  return async function call(url) {
    if (run.halted) return { kind: "halted" };
    if (run.calls >= allowedCalls) {
      run.halted = true;
      run.stop = "budget";
      return { kind: "halted" };
    }
    run.calls += 1;
    let link = null;
    const result = await fetchCommitResponse(async (args) => {
      const resp = await fetchJson(args);
      link = resp?.linkHeader ?? null;
      return resp;
    }, url);
    if (result.kind === "rateLimited") {
      run.halted = true;
      run.stop = "rateLimit";
      run.stopDetail = result.detail;
    }
    return { ...result, link };
  };
}

// 쪽 넘김 -- finished(쪽, link) 가 참이 될 때까지(목록 = 창 덮음 · 리뷰 = Link next 끝). 쪽을 받은 만큼 돌려준다(부분 결과도 흡수한다).
async function fetchPages({ run, urlOf, finished }) {
  const pages = [];
  for (let k = 1; ; k += 1) {
    const r = await run.call(urlOf(k));
    if (r.kind === "halted" || r.kind === "rateLimited") {
      return { pages, status: "halted" };
    }
    if (r.kind === "failure")
      return { pages, status: "failed", detail: r.detail };
    if (!Array.isArray(r.json)) {
      return { pages, status: "failed", detail: "응답 모양 위반(배열 아님)" };
    }
    pages.push(r.json);
    if (finished(r.json, r.link)) return { pages, status: "done" };
  }
}

// ---------------------------------------------------------------------------
// 작업 단위 -- PR 쓸기 · PR 리뷰 · 대화/리뷰 줄 댓글 · D1(Update branch). 단위 하나가 끝날 때마다 persist(원자 쓰기).
// ---------------------------------------------------------------------------

const prListUrl = (run, k) =>
  `${GITHUB_API_REPOS}/${run.repo}/pulls?state=all&sort=updated&direction=desc&per_page=${GITHUB_LIST_PAGE_SIZE}&page=${k}`;
const reviewsUrl = (run, n, k) =>
  `${GITHUB_API_REPOS}/${run.repo}/pulls/${n}/reviews?per_page=${GITHUB_LIST_PAGE_SIZE}&page=${k}`;
function commentListUrl(run, listKey, k) {
  const since = `since=${new Date(run.window.startMs).toISOString()}&sort=created&direction=desc&per_page=${GITHUB_LIST_PAGE_SIZE}&page=${k}`;
  return listKey === "issueComments"
    ? `${GITHUB_API_REPOS}/${run.repo}/issues/comments?${since}`
    : `${GITHUB_API_REPOS}/${run.repo}/pulls/comments?${since}`;
}

const absorbArgs = (run) => ({
  window: run.window,
  nowMs: run.nowMs,
  botLogins: run.botLogins,
});

async function sweepUnit(run) {
  if (!planRescanTargets(run.state).sweep || run.halted) return;
  const got = await fetchPages({
    run,
    urlOf: (k) => prListUrl(run, k),
    finished: (page) =>
      githubListCoversWindow("closedPrs", page, run.window.startMs),
  });
  if (got.pages.length > 0) {
    run.state = absorbPrSweep({
      state: run.state,
      pages: got.pages,
      gitMergePrNumbers: run.mergedPrs,
      ...absorbArgs(run),
    });
  }
  if (got.status === "failed") {
    run.state = markUnitFailed({
      state: run.state,
      unit: "prSweep",
      reason: got.detail,
    });
  }
  if (got.pages.length > 0 || got.status === "failed") await run.persist();
}

async function reviewUnits(run) {
  for (const prNumber of planRescanTargets(run.state).reviews) {
    if (run.halted) return;
    const got = await fetchPages({
      run,
      urlOf: (k) => reviewsUrl(run, prNumber, k),
      finished: (_page, link) => !hasNextLink(link),
    });
    if (got.pages.length > 0) {
      run.state = absorbReviewPages({
        state: run.state,
        prNumber,
        pages: got.pages,
        complete: got.status === "done",
        ...absorbArgs(run),
      });
    }
    if (got.status === "failed") {
      run.state = markUnitFailed({
        state: run.state,
        unit: "reviews",
        key: prNumber,
        reason: got.detail,
      });
    }
    if (got.pages.length > 0 || got.status === "failed") await run.persist();
  }
}

async function listUnits(run) {
  for (const listKey of planRescanTargets(run.state).lists) {
    if (run.halted) return;
    const got = await fetchPages({
      run,
      urlOf: (k) => commentListUrl(run, listKey, k),
      finished: (page) =>
        githubListCoversWindow(listKey, page, run.window.startMs),
    });
    if (got.pages.length > 0) {
      run.state = absorbCommentPages({
        state: run.state,
        listKey,
        pages: got.pages,
        ...absorbArgs(run),
      });
    }
    if (got.status === "failed") {
      run.state = markUnitFailed({
        state: run.state,
        unit: "lists",
        key: listKey,
        reason: got.detail,
      });
    }
    if (got.pages.length > 0 || got.status === "failed") await run.persist();
  }
}

// D1 후보 등록은 git 만 쓴다(호출 0) -- 후보 수집을 «했다» 는 표지를 단위 앞에서 남긴다.
async function registerD1(run) {
  if (!planRescanTargets(run.state).d1Collect) return;
  run.state = registerUpdateBranchCandidates({
    state: run.state,
    shas: run.d1Candidates.map((c) => c.sha),
    window: run.window,
    nowMs: run.nowMs,
  });
  await run.persist();
}

function d1Failure(run, sha, reason) {
  run.state = markUnitFailed({
    state: run.state,
    unit: "d1",
    key: sha,
    reason,
  });
}

async function d1Units(run) {
  const tsBySha = new Map(run.d1Candidates.map((c) => [c.sha, c.tsMs]));
  for (const sha of planRescanTargets(run.state).d1) {
    if (run.halted) return;
    const r = await run.call(`${GITHUB_API_REPOS}/${run.repo}/commits/${sha}`);
    if (r.kind === "halted" || r.kind === "rateLimited") return;
    if (r.kind === "failure") {
      d1Failure(run, sha, r.detail);
    } else if (!hasWellFormedCommitShape(r.json, sha)) {
      d1Failure(run, sha, "응답 모양 위반");
    } else {
      run.state = recordUpdateBranchResult({
        state: run.state,
        sha,
        counted: isVerifiedAllowlistedWebMerge(r.json, run.allowlist),
        atMs: tsBySha.get(sha) ?? run.window.startMs,
        window: run.window,
        nowMs: run.nowMs,
      });
    }
    await run.persist();
  }
}

// 이번 실행이 쓴 호출 수를 runs[] 마지막 칸으로 같이 적은 «지금까지의 상태» -- 호출 0 이면 실행 기록을 만들지 않는다.
function withThisRun(run) {
  return run.calls > 0
    ? recordRescanRun({
        state: run.state,
        atMs: run.nowMs,
        calls: run.calls,
        stop: run.stop,
      })
    : run.state;
}

// ---------------------------------------------------------------------------
// 프로덕션 진입점 -- CLI 가 부르는 단 하나의 실행 함수. throw 0(깨지면 거부 결과).
// ---------------------------------------------------------------------------

const packageRoot = () =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRescanOptions(options) {
  const window = computeRescanWindow({
    fromDay: options.fromDay,
    days: options.days,
  });
  if (!window.ok) return { ok: false, reason: window.reason };
  if (
    typeof options.statePath !== "string" ||
    options.statePath === "" ||
    typeof options.reportOut !== "string" ||
    options.reportOut === ""
  ) {
    return { ok: false, reason: "state · report-out 경로가 필요하다" };
  }
  const maxCalls = options.maxCalls ?? RESCAN_MAX_CALLS_PER_RUN;
  if (!Number.isInteger(maxCalls) || maxCalls < 1) {
    return { ok: false, reason: "max-calls 는 1 이상 정수" };
  }
  return { ok: true, window, maxCalls, ...injectedPorts(options) };
}

// 주입이 없으면 실물(시계 · 실제 파일 · 익명 망 · 이 체크아웃의 git) -- 시험은 전부 주입한다.
function injectedPorts(options) {
  return {
    nowMs: options.nowMs ?? Date.now(),
    io: options.io ?? defaultRescanIo,
    fetchJson: options.fetchJson ?? createAnonymousFetchJson().fetchJson,
    git: options.git ?? createProcessGitPort(options.repoRoot ?? packageRoot()),
    botAccountsPath:
      options.botAccountsPath ?? DEFAULT_GITHUB_BOT_ACCOUNTS_PATH,
    allowlistPath: options.allowlistPath ?? DEFAULT_ALLOWLIST_PATH,
  };
}

// 실행 한 번 준비 -- 창 문 · git 입력 · 상태 읽기 · 예산. 거부면 {ok:false, reason}(여기까지 쓰기 0 · 호출 0).
async function prepareRun(options, input) {
  const gate = judgeWindowClosed({ window: input.window, nowMs: input.nowMs });
  if (!gate.ok) {
    return {
      ok: false,
      reason: `${gate.reason}(창 끝 ${input.window.endLabel} 이후에 실행한다)`,
    };
  }
  const git = await readGitInputs({
    git: input.git,
    window: input.window,
    botAccountsPath: input.botAccountsPath,
  });
  if (!git.ok) return git;
  const fingerprint = buildRescanFingerprint({
    fromDay: options.fromDay,
    days: options.days,
    repo: git.repo,
    botListBlob: git.botListBlob,
  });
  const loaded = loadRescanState({
    io: input.io,
    statePath: options.statePath,
    fingerprint,
  });
  if (!loaded.ok) return loaded;
  const budget = planRunBudget({
    state: loaded.state,
    nowMs: input.nowMs,
    maxCalls: input.maxCalls,
  });
  if (!budget.ok) return { ok: false, reason: budget.reason };
  const needsAllowlist =
    git.d1Candidates.length > 0 || Object.keys(loaded.state.d1.shas).length > 0;
  let allowlist = null;
  if (needsAllowlist) {
    const read = await readExternalEvidenceAllowlist({
      git: input.git,
      allowlistPath: input.allowlistPath,
    });
    if (!read.ok)
      return {
        ok: false,
        reason: `허용 목록 읽기 실패: ${oneLine(read.reason)}`,
      };
    allowlist = read.allowlist;
  }
  return { ok: true, git, loaded, budget, allowlist };
}

async function executeRescan(options) {
  const input = readRescanOptions(options);
  if (!input.ok) return refused(input.reason);
  const prep = await prepareRun(options, input);
  if (!prep.ok) return refused(prep.reason);
  const run = {
    state: prep.loaded.state,
    window: input.window,
    nowMs: input.nowMs,
    repo: prep.git.repo,
    botLogins: prep.git.botLogins,
    mergedPrs: prep.git.mergedPrs,
    d1Candidates: prep.git.d1Candidates,
    allowlist: prep.allowlist,
    calls: 0,
    halted: false,
    stop: null,
    stopDetail: null,
  };
  run.call = createCaller({
    fetchJson: input.fetchJson,
    allowedCalls: prep.budget.allowedCalls,
    run,
  });
  let lastText = prep.loaded.rawText;
  let stateWrites = 0;
  let saveFailure = null;
  run.persist = async () => {
    const text = stateText(withThisRun(run));
    if (text === lastText) return;
    const failure = writeTextAtomic({
      io: input.io,
      filePath: options.statePath,
      text,
    });
    if (failure !== null) throw new Error(`상태 저장 실패(${failure})`);
    lastText = text;
    stateWrites += 1;
  };
  try {
    await registerD1(run);
    await sweepUnit(run);
    await reviewUnits(run);
    await listUnits(run);
    await d1Units(run);
    await run.persist();
  } catch (err) {
    saveFailure = oneLine(err?.message ?? err);
  }
  if (saveFailure !== null) return refused(saveFailure);
  return finishRun({ run, input, options, stateWrites });
}

function finishRun({ run, input, options, stateWrites }) {
  const final = withThisRun(run);
  const report = renderRescanReport({
    state: final,
    window: input.window,
    nowMs: input.nowMs,
  });
  const reportFailure = writeTextAtomic({
    io: input.io,
    filePath: options.reportOut,
    text: `${report.lines.join("\n")}\n`,
  });
  if (reportFailure !== null) {
    return refused(`보고 파일 저장 실패(${reportFailure})`);
  }
  return {
    exit: report.exit,
    lines: report.lines,
    calls: run.calls,
    stop: run.stop,
    stopDetail: run.stopDetail,
    complete: report.complete,
    declarationReady: report.declarationReady,
    counts: report.counts,
    wrote: { state: stateWrites > 0, report: true },
    state: final,
  };
}

// options = {fromDay, days, statePath, reportOut, maxCalls?} + 주입(nowMs · fetchJson · git · io · botAccountsPath · allowlistPath · repoRoot).
export async function runRescanOnce(options = {}) {
  try {
    return await executeRescan(options);
  } catch (err) {
    return refused(`고장 — ${oneLine(err?.message ?? err)}`);
  }
}

// ---------------------------------------------------------------------------
// CLI -- 인자 해석 -> runRescanOnce -> 줄 출력 -> 종료 값. 주입(out · err)은 시험용.
// ---------------------------------------------------------------------------

export async function main(argv, deps = {}) {
  const out = deps.out ?? ((line) => console.log(line));
  const err = deps.err ?? ((line) => console.error(line));
  const parsed = parseRescanArgs(argv);
  if (!parsed.ok) {
    const result = refused(parsed.reason);
    for (const line of result.lines) out(line);
    return result.exit;
  }
  const run = deps.runRescanOnce ?? runRescanOnce;
  const result = await run({ ...parsed.options, ...(deps.inject ?? {}) });
  for (const line of result.lines) out(line);
  if (result.stop === "rateLimit") {
    err(
      `partial-count-rescan: GitHub 한도 응답으로 이 실행을 멈췄다(${result.stopDetail})`,
    );
  }
  return result.exit;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(
        `partial-count-rescan: FAILED -- ${error?.message ?? String(error)}`,
      );
      process.exitCode = RESCAN_EXIT.REFUSED;
    },
  );
}
