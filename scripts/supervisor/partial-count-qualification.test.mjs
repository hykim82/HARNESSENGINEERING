// HYK-255-p2b-qual-1 -- «1-C 판정 자격» 줄 계산: P2a 기계 계수 범위 기준 «충족» ∧ 종류 설정(partial-count-uncountable-kinds.json) 읽기 성공 = «부분 있음»,
// 아니면 지금 문면(«없음») 바이트 그대로. 종류 이름 · 수 · 처리는 설정 파일에서만 온다. 처음 «부분 있음» 이 된 회차에 받는함 통지 1장.
//
// ⛔헛시험 금지: 프로덕션 export(runPartialCountOnce · buildPartialCountReport · runReachOnce)를 직접 구동한다 -- 사본 import 0.
// ⛔시험 단언 규율: 보고서 줄 «전체» 문자열 동등 단언 0 -- 자기 줄(`1-C 판정 자격: 부분 있음 …` · `종류 설정 진단: …`)의 토막만 읽는다.
// 예외 = «1-C 판정 자격: 없음 …» 줄 바이트 무변 단언(그 줄 자체가 계약). mkdtemp 합성 저장소 · 합성 받는함 · 주입 시계만. 네트워크 · gh · 관제실 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";
import { runReachOnce } from "./reach-report.mjs";

const NOW = Date.parse("2026-11-15T15:00:00+09:00");
const SCOPE_CONFIG_PATH = "scripts/supervisor/partial-count-machine-scope.json";
const KINDS_CONFIG_PATH =
  "scripts/supervisor/partial-count-uncountable-kinds.json";
const KINDS_SCHEMA = "partial-count-uncountable-kinds/v1";
const QUAL_PREFIX = "1-C 판정 자격: ";
const DIAG_PREFIX = "종류 설정 진단: ";
const SCOPE_PREFIX = "기계 계수 범위 기준: ";
// HYK-255-p2d-nonecause-1 바뀐 단언(판정 2026-11-16 1804 상신 1): 옛 단일 상수 줄 NONE_LINE -> «없음» 원인 3종의 프로덕션 렌더 출력(칸마다 실제 갈래의 원인을 단언).
// 머리 · 꼬리 뜻 무변 -- 줄 원인 구분 시험 자체는 partial-count-nonecause.test.mjs.
const noneLine = (cause) =>
  core.renderQualificationLine({ state: "none", cause });
const NONE_UNMET = noneLine(core.QUALIFICATION_NONE_CAUSE.SCOPE_UNMET);
const NONE_UNREADABLE = noneLine(
  core.QUALIFICATION_NONE_CAUSE.SCOPE_UNREADABLE,
);
const NONE_KINDS = noneLine(core.QUALIFICATION_NONE_CAUSE.KINDS_CONFIG);
const PROOF_DEVICE = "scripts/synthetic-proof-device.mjs";
const FAIL404 = { ok: false, status: 404, json: null, linkHeader: null };

const cleanups = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}
test.after(() => {
  for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
});

// ---- 합성 일별 줄 · 합성 저장소 ---------------------------------------------------------------------------------------
const dayStr = (offset) =>
  new Date(Date.UTC(2026, 10, 15 + offset)).toISOString().slice(0, 10);
const dayLine = (offset, over = {}) => ({
  schema: core.DAILY_SCHEMA,
  day: dayStr(offset),
  lnConfirmed: 0,
  lnUnchecked: 0,
  collectorFails: [],
  coverageGaps: { count: 0, totalMs: 0 },
  concurrentTracksMax: 2,
  uncountedExampleIds: [],
  // HYK-255-p2c-nofield-1 -- 칸 없는 줄 = 끊김(판정 1404): «깨끗한 날» 은 권한 두 칸 + GitHub 칸이 있고 값 0 이다.
  permissionHumanAnswers: 0,
  permissionUndecidable: 0,
  githubHumanActions: 0,
  ...over,
});
const dayLines = (from, to, over = () => ({})) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    dayLine(from + i, over(from + i)),
  );
const MET_LINES = dayLines(-7, -1); // 7일 연속 · 동시 2 = 설정 7/2 에서 «충족»
const UNMET_LINES = dayLines(-6, -1); // 6일 = «미충족»

function git(cwd, args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim();
}

const scopeJson = (over = {}) =>
  JSON.stringify({
    schema_version: "partial-count-machine-scope/v1",
    observationDays: 7,
    minConcurrentTracks: 2,
    ...over,
  });

// kindsConfig: 문자열 = 그 내용의 종류 설정을 origin/master 판본에 심는다 · null = 파일 없음. files = 같이 심을 저장소 상대 파일.
function buildRepo(
  kindsConfig,
  { scopeConfig = scopeJson(), files = [] } = {},
) {
  const dir = tmpDir("nc-qual-");
  git(dir, ["init", "-q"]);
  fs.mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
  fs.writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  fs.writeFileSync(join(dir, SCOPE_CONFIG_PATH), scopeConfig, "utf8");
  if (kindsConfig !== null) {
    fs.writeFileSync(join(dir, KINDS_CONFIG_PATH), kindsConfig, "utf8");
  }
  for (const f of files) fs.writeFileSync(join(dir, f), "// device\n", "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "root"]);
  git(dir, ["remote", "add", "origin", "https://example.invalid/f.git"]);
  git(dir, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  return dir;
}

// 합성 종류 설정 -- 행 하나 = [handling, extra].
const kindRow = (i, handling, extra = {}) => ({
  id: `k${String(i).padStart(2, "0")}`,
  name: `합성 종류 ${i}`,
  handling,
  source: `synthetic:${i}`,
  ...extra,
});
const kindsJson = (rows, over = {}) =>
  JSON.stringify({ schema_version: KINDS_SCHEMA, kinds: rows, ...over });
const rowsOf = (partial, excluded = 0, proof = 0) => [
  ...Array.from({ length: proof }, (_, i) =>
    kindRow(100 + i, "prevention-proof", { proofDevice: PROOF_DEVICE }),
  ),
  ...Array.from({ length: partial }, (_, i) => kindRow(i + 1, "partial-scope")),
  ...Array.from({ length: excluded }, (_, i) =>
    kindRow(200 + i, "excluded-by-definition-provisional"),
  ),
];
const REAL_KINDS = fs.readFileSync(
  new URL("./partial-count-uncountable-kinds.json", import.meta.url),
  "utf8",
);

async function runReport(repoDir, extra = {}, root = tmpDir("nc-qual-run-")) {
  return report.runPartialCountOnce({
    now: NOW,
    repoRoot: repoDir,
    dispatchReceiptsPath: join(root, "none.jsonl"),
    watchLogPath: join(root, "watch.log"),
    extraRepoRoots: [],
    archiveRoot: join(root, "archive-missing"),
    fetchJson: async () => FAIL404,
    git: report.createProcessGitPort(repoDir),
    gitWorktreeListExecFn: () => "",
    ...extra,
  });
}
const linesOf = (text) => text.split("\n");
const qualOf = (text) => linesOf(text).find((l) => l.startsWith(QUAL_PREFIX));
const diagOf = (text) => linesOf(text).find((l) => l.startsWith(DIAG_PREFIX));
const kindsOf = (line) =>
  /알려진 못 세는 종류 (\d+) = 예방 증명 (\d+) \/ 부분 범위 (\d+) \/ 정의상 제외\(잠정\) (\d+)/
    .exec(line)
    ?.slice(1)
    .map(Number);
const scopeOf = (line) =>
  /연속 (\d+)일 \/ 기준 (\d+)일 · 동시 배달 최대 ≥ (\d+)\)/
    .exec(line)
    ?.slice(1)
    .map(Number);

// ---- ⑴ 기준 충족 + 종류 설정 읽기 성공 = 부분 있음 -----------------------------------------------------------------------

test("기준 충족 + 설정 15행(실물 설정 파일): 자격 줄 = 부분 있음 · 알려진 못 세는 종류 15 = 예방 증명 0 / 부분 범위 14 / 정의상 제외(잠정) 1 · «ㄴ=0» 판정 아님", async () => {
  const { reportText } = await runReport(buildRepo(REAL_KINDS), {
    machineScopeDailyLines: MET_LINES,
  });
  const line = qualOf(reportText);
  assert.ok(line.startsWith(`${QUAL_PREFIX}부분 있음`), "부분 있음");
  assert.deepEqual(kindsOf(line), [15, 0, 14, 1]);
  assert.match(line, /알려진 못 세는 종류/, "열린 집합 낱말 «알려진»");
  assert.match(line, /«ㄴ=0» 판정 아님/);
  assert.equal(line.includes("없음"), false, "«없음» 낱말 0");
  assert.equal(diagOf(reportText), undefined, "읽기 성공 = 진단 줄 0");
  assert.equal(
    linesOf(reportText).filter((l) => l.startsWith(QUAL_PREFIX)).length,
    1,
    "자격 줄은 한 줄(상수 줄이 같이 남지 않는다)",
  );
});

test("긍정 문면 금지: 부분 있음 줄에 «자격 있음» · «완료» · «ㄴ=0 달성» 류 낱말 0 -- 값 범위 표기만", async () => {
  const { reportText } = await runReport(buildRepo(REAL_KINDS), {
    machineScopeDailyLines: MET_LINES,
  });
  const line = qualOf(reportText);
  for (const banned of ["자격 있음", "완료", "달성", "통과", "합격"]) {
    assert.equal(line.includes(banned), false, banned);
  }
});

test("N · D · C = P2a 기계 계수 범위 기준 줄의 값 그대로 -- 설정 3/1 이면 줄도 3/1 · 연속 3일 (코드 리터럴 0)", async () => {
  const lines = dayLines(-3, -1, () => ({ concurrentTracksMax: 1 }));
  const loose = await runReport(
    buildRepo(REAL_KINDS, {
      scopeConfig: scopeJson({ observationDays: 3, minConcurrentTracks: 1 }),
    }),
    { machineScopeDailyLines: lines },
  );
  const qual = qualOf(loose.reportText);
  assert.deepEqual(scopeOf(qual), [3, 3, 1]);
  const scopeLine = linesOf(loose.reportText).find((l) =>
    l.startsWith(SCOPE_PREFIX),
  );
  assert.match(scopeLine, /충족/);
  assert.match(scopeLine, /연속 3일 \/ 기준 3일\(동시 배달 최대 ≥ 1/);
  const strict = await runReport(buildRepo(REAL_KINDS), {
    machineScopeDailyLines: MET_LINES,
  });
  assert.deepEqual(scopeOf(qualOf(strict.reportText)), [7, 7, 2]);
});

test("a + b + c = K = 설정 종류 수 -- 설정 3행(예방 증명 1 · 부분 범위 1 · 정의상 제외 1)이면 줄도 3 = 1 / 1 / 1 (코드 리터럴 0 증명)", async () => {
  const rows = [
    kindRow(1, "prevention-proof", { proofDevice: PROOF_DEVICE }),
    kindRow(2, "partial-scope"),
    kindRow(3, "excluded-by-definition-provisional"),
  ];
  const { reportText } = await runReport(
    buildRepo(kindsJson(rows), { files: [PROOF_DEVICE] }),
    { machineScopeDailyLines: MET_LINES },
  );
  const [k, a, b, c] = kindsOf(qualOf(reportText));
  assert.deepEqual([k, a, b, c], [3, 1, 1, 1]);
  assert.equal(a + b + c, k);
  const other = await runReport(buildRepo(kindsJson(rowsOf(4, 2))), {
    machineScopeDailyLines: MET_LINES,
  });
  assert.deepEqual(kindsOf(qualOf(other.reportText)), [6, 0, 4, 2]);
});

test("종류 옮기기 = 설정만: 같은 15행에서 8행(정의상 제외)을 partial-scope 로 옮기면 c 0 · b 15 -- 코드 경로 0", async () => {
  const cfg = JSON.parse(REAL_KINDS);
  cfg.kinds = cfg.kinds.map((k) =>
    k.id === "k08" ? { ...k, handling: "partial-scope" } : k,
  );
  const { reportText } = await runReport(buildRepo(JSON.stringify(cfg)), {
    machineScopeDailyLines: MET_LINES,
  });
  assert.deepEqual(kindsOf(qualOf(reportText)), [15, 0, 15, 0]);
});

// ---- ⑵ 없음 경로 바이트 무변 ------------------------------------------------------------------------------------------

test("기준 미충족(6일) + 설정 15행: «없음» 줄 바이트 그대로 · 진단 줄 0 · 종류 설정을 읽지 않은 것과 같은 보고서", async () => {
  const root = tmpDir("nc-qual-run-");
  const withKinds = await runReport(
    buildRepo(REAL_KINDS),
    { machineScopeDailyLines: UNMET_LINES },
    root,
  );
  const withoutKinds = await runReport(
    buildRepo(null),
    { machineScopeDailyLines: UNMET_LINES },
    root,
  );
  assert.equal(qualOf(withKinds.reportText), NONE_UNMET); // 기준 미충족 6일 = 원인 미충족
  assert.equal(diagOf(withKinds.reportText), undefined);
  assert.equal(withKinds.reportText, withoutKinds.reportText);
});

test("일별 줄 입력이 없거나(미결선) 못 읽었거나(null) 기계 계수 설정이 깨졌으면: «없음» 줄 바이트 그대로 · 종류 진단 줄 0", async () => {
  const cases = [
    [buildRepo(REAL_KINDS), undefined],
    [buildRepo(REAL_KINDS), null],
    [buildRepo(REAL_KINDS, { scopeConfig: "{not json" }), MET_LINES],
  ];
  for (const [repo, lines] of cases) {
    const { reportText } = await runReport(repo, {
      machineScopeDailyLines: lines,
    });
    // 미결선 · 못 읽음 · 기계 계수 설정 깨짐 = 기준을 모른다 = 원인 판독 불가.
    assert.equal(qualOf(reportText), NONE_UNREADABLE, String(lines?.length));
    assert.equal(diagOf(reportText), undefined);
  }
});

test("종류 설정 없음 · 깨짐 · 스키마 불일치 · 모르는 handling · 빈 목록 · 증명 장치 없음/미실재 · id 꼴/중복 오류 = 기준 충족이어도 «없음» 줄 바이트 그대로 + 진단 사유 1개 (기본 목록으로 대체 0)", async () => {
  const proofRow = kindRow(1, "prevention-proof", {
    proofDevice: PROOF_DEVICE,
  });
  const cases = [
    ["파일 없음", null, []],
    ["JSON 깨짐", "{not json", []],
    ["스키마 불일치", kindsJson(rowsOf(2), { schema_version: "x/v9" }), []],
    [
      "kinds 가 배열 아님",
      JSON.stringify({ schema_version: KINDS_SCHEMA }),
      [],
    ],
    ["빈 목록", kindsJson([]), []],
    ["모르는 handling", kindsJson([kindRow(1, "invented-kind")]), []],
    [
      "handling 칸 없음",
      kindsJson([{ ...kindRow(1, "x"), handling: undefined }]),
      [],
    ],
    [
      "예방 증명인데 proofDevice 없음",
      kindsJson([kindRow(1, "prevention-proof")]),
      [],
    ],
    ["예방 증명 장치가 저장소에 없음", kindsJson([proofRow]), []],
    [
      "id 꼴 오류(U1)",
      kindsJson([{ ...kindRow(1, "partial-scope"), id: "U1" }]),
      [],
    ],
    [
      "id 중복",
      kindsJson([kindRow(1, "partial-scope"), kindRow(1, "partial-scope")]),
      [],
    ],
    [
      "name 없음",
      kindsJson([{ ...kindRow(1, "partial-scope"), name: "" }]),
      [],
    ],
  ];
  for (const [name, config, files] of cases) {
    const { reportText } = await runReport(buildRepo(config, { files }), {
      machineScopeDailyLines: MET_LINES,
    });
    assert.equal(qualOf(reportText), NONE_KINDS, name); // 기준 충족 + 종류 설정 읽기 실패 = 원인 종류 설정
    const diag = diagOf(reportText);
    assert.notEqual(diag, undefined, `${name}: 진단 줄`);
    assert.equal(
      linesOf(reportText).filter((l) => l.startsWith(DIAG_PREFIX)).length,
      1,
      `${name}: 진단 사유 1개`,
    );
    assert.equal(
      diag.includes("부분 있음"),
      false,
      `${name}: 진단이 긍정을 말하지 않는다`,
    );
  }
});

test("증명 장치가 저장소에 실재하면 예방 증명 1 -- 장치 경로가 저장소 밖(.. · 절대 경로)이면 설정 오류", async () => {
  const ok = await runReport(
    buildRepo(
      kindsJson([
        kindRow(1, "prevention-proof", { proofDevice: PROOF_DEVICE }),
      ]),
      { files: [PROOF_DEVICE] },
    ),
    { machineScopeDailyLines: MET_LINES },
  );
  assert.deepEqual(kindsOf(qualOf(ok.reportText)), [1, 1, 0, 0]);
  for (const bad of ["../escape.mjs", "/abs/device.mjs", "C:/abs/device.mjs"]) {
    const { reportText } = await runReport(
      buildRepo(
        kindsJson([kindRow(1, "prevention-proof", { proofDevice: bad })]),
      ),
      { machineScopeDailyLines: MET_LINES },
    );
    assert.equal(qualOf(reportText), NONE_KINDS, bad);
    assert.notEqual(diagOf(reportText), undefined, bad);
  }
});

// ---- ⑵ 일별 줄 · 나머지 보고서 무변 -------------------------------------------------------------------------------------

test("일별 줄 칸 · 결과 키 무변 + 자격 줄 · 진단 줄 말고는 보고서 바이트 무변 (종류 설정이 있든 없든)", async () => {
  const root = tmpDir("nc-qual-run-");
  const withKinds = await runReport(
    buildRepo(REAL_KINDS),
    { machineScopeDailyLines: MET_LINES },
    root,
  );
  const without = await runReport(
    buildRepo(null),
    { machineScopeDailyLines: MET_LINES },
    root,
  );
  assert.deepEqual(withKinds.dailyTick, without.dailyTick, "일별 칸 무변");
  assert.deepEqual(
    Object.keys(withKinds).sort(),
    Object.keys(without).sort(),
    "결과 키 무변",
  );
  const strip = (text) =>
    linesOf(text)
      .filter((l) => !l.startsWith(QUAL_PREFIX) && !l.startsWith(DIAG_PREFIX))
      .join("\n");
  assert.equal(strip(withKinds.reportText), strip(without.reportText));
  assert.equal(
    linesOf(withKinds.reportText).length,
    linesOf(without.reportText).length - 1,
    "읽기 성공은 진단 줄 1개가 빠진 만큼 짧다(자격 줄은 자리만 바뀜)",
  );
});

// ---- ⑵ 설정 파일 실물 ---------------------------------------------------------------------------------------------------

test("설정 파일 실물 = 스키마대로 15행 · id k01~k15 · handling 은 세 값뿐 · 8행만 정의상 제외(잠정) · proofDevice 는 예방 증명 행에만 · 코드에 종류 이름 리터럴 0", () => {
  const cfg = JSON.parse(REAL_KINDS);
  assert.equal(cfg.schema_version, KINDS_SCHEMA);
  assert.equal(cfg.kinds.length, 15);
  assert.deepEqual(
    cfg.kinds.map((k) => k.id),
    Array.from({ length: 15 }, (_, i) => `k${String(i + 1).padStart(2, "0")}`),
  );
  const allowed = new Set([
    "prevention-proof",
    "partial-scope",
    "excluded-by-definition-provisional",
  ]);
  for (const k of cfg.kinds) {
    assert.ok(allowed.has(k.handling), k.id);
    assert.equal(typeof k.name, "string");
    assert.equal(typeof k.source, "string");
    assert.equal("proofDevice" in k, k.handling === "prevention-proof", k.id);
  }
  assert.deepEqual(
    cfg.kinds
      .filter((k) => k.handling === "excluded-by-definition-provisional")
      .map((k) => k.id),
    ["k08"],
  );
  for (const file of ["partial-count-core.mjs", "partial-count-report.mjs"]) {
    const src = fs
      .readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
      .replace(/\/\/.*$/gm, "");
    for (const k of cfg.kinds) {
      assert.equal(src.includes(k.name), false, `${file} 에 종류 이름 ${k.id}`);
    }
  }
});

// ---- ⑵ 전이 통지(reach-report 길 · 합성 받는함 · 합성 상태 파일) --------------------------------------------------------

// 프로덕션 보고 진입점이 쓴 보고서 텍스트를 그대로 합성 partial-count-report.md 로 심고 프로덕션 runReachOnce 를 구동한다.
async function stateReports() {
  const partial = await runReport(buildRepo(REAL_KINDS), {
    machineScopeDailyLines: MET_LINES,
  });
  const none = await runReport(buildRepo(REAL_KINDS), {
    machineScopeDailyLines: UNMET_LINES,
  });
  const unreadable = await runReport(buildRepo("{not json"), {
    machineScopeDailyLines: MET_LINES,
  });
  return {
    partial: partial.reportText,
    none: none.reportText,
    unreadable: unreadable.reportText,
  };
}

function makeReach() {
  const root = tmpDir("nc-qual-reach-");
  const watchLogPath = join(root, "watch.log");
  const partialCountPath = join(root, "partial-count-report.md");
  const fx = {
    root,
    notifyDir: join(root, "받는함"),
    tick(reportText, offsetMs = 0) {
      if (reportText !== null) {
        fs.writeFileSync(partialCountPath, reportText, "utf8");
      } else {
        fs.rmSync(partialCountPath, { force: true });
      }
      return runReachOnce({
        watchLogPath,
        partialCountPath,
        reportOutPath: join(root, "morning-report.md"),
        statePath: join(root, "state.json"),
        notifyDir: fx.notifyDir,
        now: NOW + offsetMs,
      });
    },
    files() {
      return fs.existsSync(fx.notifyDir) ? fs.readdirSync(fx.notifyDir) : [];
    },
  };
  return fx;
}

test("전이: 없음 -> 부분 있음 첫 회차 받는함 1장(줄의 값 포함) · 같은 상태 다음 회차 0장 · 그 뒤에도 0장", async () => {
  const reports = await stateReports();
  const fx = makeReach();
  assert.equal(fx.tick(reports.none).noticePath, null, "없음 기준선 = 0장");
  const first = fx.tick(reports.partial, 1000);
  assert.ok(first.noticePath, "처음 부분 있음 = 1장");
  assert.equal(fx.files().length, 1);
  const body = fs.readFileSync(first.noticePath, "utf8");
  assert.match(body, /1-C 판정 자격/);
  assert.match(body, /없음 -> 부분 있음/);
  assert.match(
    body,
    /알려진 못 세는 종류 15 = 예방 증명 0 \/ 부분 범위 14 \/ 정의상 제외\(잠정\) 1/,
  );
  assert.match(body, /«ㄴ=0» 판정이 아닙니다/);
  assert.equal(
    fx.tick(reports.partial, 2000).noticePath,
    null,
    "같은 상태 = 0장",
  );
  assert.equal(fx.tick(reports.partial, 3000).noticePath, null);
  assert.equal(fx.files().length, 1);
});

test("전이: 부분 있음 -> 없음 = 통지 0장 · 그 뒤 다시 없음 -> 부분 있음 이면 새 전이라 1장 더", async () => {
  const reports = await stateReports();
  const fx = makeReach();
  assert.ok(fx.tick(reports.partial).noticePath, "첫 관측부터 부분 있음 = 1장");
  assert.equal(
    fx.tick(reports.none, 1000).noticePath,
    null,
    "부분 있음 -> 없음 = 0장",
  );
  assert.equal(fx.files().length, 1);
  assert.equal(fx.tick(reports.none, 2000).noticePath, null);
  assert.ok(
    fx.tick(reports.partial, 3000).noticePath,
    "없음 -> 부분 있음 다시 = 1장",
  );
  assert.equal(fx.files().length, 2);
});

test("전이: 종류 설정을 못 읽은 회차(진단 줄) · 자격 줄이 없는 보고서 · 보고서 없음 = 변화가 아니다 -- 통지 0장이고 직전 상태는 기억된다", async () => {
  const reports = await stateReports();
  const fx = makeReach();
  assert.ok(fx.tick(reports.partial).noticePath);
  assert.equal(fx.tick(reports.unreadable, 1000).noticePath, null);
  assert.equal(fx.tick(null, 2000).noticePath, null);
  assert.equal(
    fx.tick("집계 성격: PARTIAL — 전수 아님\n", 3000).noticePath,
    null,
  );
  assert.equal(
    fx.tick(reports.partial, 4000).noticePath,
    null,
    "실패를 사이에 두고 돌아와도 같은 상태면 0장",
  );
  assert.equal(fx.files().length, 1);
});

test("전이 + 외부 독립 증거 N 변화가 같은 회차에 겹쳐도 받는함은 1장 -- 두 절이 함께 실리고 외부 N 통지 조건은 무변", async () => {
  const reports = await stateReports();
  const fx = makeReach();
  // 보고서가 이미 가진 «외부 독립 증거 후보» 줄의 확인 건수만 바꾼다(없으면 덧붙인다).
  const EXT_RE = /^- 외부 독립 증거 후보: .*$/m;
  const withExt = (text, n) => {
    const line = `- 외부 독립 증거 후보: 확인 ${n} · 미조회 0 · ㄴ 분자 반영`;
    return EXT_RE.test(text)
      ? text.replace(EXT_RE, line)
      : `${text}\n${line}\n`;
  };
  const ext = (n) => n;
  assert.equal(fx.tick(withExt(reports.none, ext(0))).noticePath, null);
  const both = fx.tick(withExt(reports.partial, ext(1)), 1000);
  assert.ok(both.noticePath);
  assert.equal(fx.files().length, 1, "1장");
  const body = fs.readFileSync(both.noticePath, "utf8");
  assert.match(body, /1-C 판정 자격/);
  assert.match(body, /외부 독립 증거 후보/);
  const extOnly = fx.tick(withExt(reports.partial, ext(2)), 2000);
  assert.ok(extOnly.noticePath, "외부 N 증가는 따로 1장");
  assert.equal(
    /없음 -> 부분 있음/.test(fs.readFileSync(extOnly.noticePath, "utf8")),
    false,
    "자격 전이 절은 전이 회차에만",
  );
});
