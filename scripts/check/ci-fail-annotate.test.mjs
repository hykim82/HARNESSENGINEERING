// HYK-459-ci-fail-annot-1: drives scripts/check/ci-fail-annotate.mjs for real
// (pure functions AND the CLI through a child node process) against output
// samples shaped like what `npm test` (isolated-suite-runner.mjs -> node
// --test spec reporter on stdout) writes, plus a structure check of the two
// enforce.yml steps this round touched.
//
// Sample provenance (universal-claim discipline): the spec/TAP SHAPES below
// were captured on this machine (Node v26.2.0, 2026-11-20) from a throwaway
// failing test file. Node 20 (CI's pin) was NOT run here -- the parser
// accepts both the `test at <rel>:L:C` and the `test at file:///<abs>:L:C`
// header spellings so a version difference in that one spelling cannot
// silently empty the extraction, but "the Node 20 spec reporter prints
// exactly this" is an unmeasured assumption; the first real CI failure is
// the first real Node 20 sample.
//
// Workflow reads use the WORKING-TREE enforce.yml (not `git show HEAD:`), the
// same choice hyk359-ambient-env-regression.test.mjs made and for the same
// reason: the mutation round proves RED against an in-place uncommitted edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_ANNOTATIONS,
  RUNNER_LOG_PREFIX,
  DEFAULT_LOG_DIR,
  extractFailures,
  extractFromLogDir,
  pickLatestRunnerLogs,
  buildAnnotations,
  annotateOutput,
  scrubName,
  normalizeTestPath,
} from "./ci-fail-annotate.mjs";
import {
  RUNNER_LOG_PREFIX as PRODUCER_LOG_PREFIX,
  allocateRunSlot,
} from "./runner-receipt-writer.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "ci-fail-annotate.mjs");
const ROOT = join(HERE, "..", "..");
const ENFORCE_YML_PATH = join(ROOT, ".github", "workflows", "enforce.yml");

// ---------------------------------------------------------------------------
// sample builders
// ---------------------------------------------------------------------------
const SPEC_SUMMARY = (tests, fail) =>
  [
    `ℹ tests ${tests}`,
    "ℹ suites 0",
    `ℹ pass ${tests - fail}`,
    `ℹ fail ${fail}`,
    "ℹ cancelled 0",
    "ℹ skipped 0",
    "ℹ todo 0",
    "ℹ duration_ms 94.2678",
  ].join("\n");

// `loc` is the `test at <loc>` spelling; err is an indented error body.
function specOutput(failures, { tests = 40, withSummary = true } = {}) {
  const stream = [
    "[isolated-suite-runner] test-concurrency=2 (auto)",
    "✔ passing one (0.7ms)",
    ...failures.map((f) => `✖ ${f.name} (1.1ms)`),
  ];
  const block = failures.flatMap((f) => [
    `test at ${f.loc}`,
    `✖ ${f.name} (1.1ms)`,
    // errLines = the error body exactly as the reporter prints it (each
    // message line indented by two spaces); default = a plain assertion
    ...(
      f.errLines ?? [
        "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
        "",
        "1 !== 2",
        ...(f.err ? [f.err] : []),
      ]
    ).map((l) => `  ${l}`),
    "      at TestContext.<anonymous> (file:///home/runner/work/x/y.mjs:1:1)",
    "",
  ]);
  const out = [...stream];
  if (withSummary) {
    out.push(SPEC_SUMMARY(tests, failures.length));
    if (failures.length > 0) out.push("", "✖ failing tests:", "", ...block);
  }
  return out.join("\n") + "\n";
}

function manyFailures(n) {
  return Array.from({ length: n }, (_, i) => ({
    loc: `scripts/check/file${i}.test.mjs:${10 + i}:3`,
    name: `case number ${i}`,
  }));
}

function annotationLines(lines) {
  return lines.filter((l) => l.startsWith("::"));
}

function runCli(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// A runner-log directory shaped like `.harness/` after `npm test`: the main
// pass log full-runner-<n>.log and, optionally, its -serial.log twin. `fn`
// gets the directory path.
function withLogDir(mainText, { serial = null, n = 1 } = {}, fn) {
  const dir = mkdtempSync(join(tmpdir(), "ci-fail-annotate-"));
  try {
    writeFileSync(join(dir, `${RUNNER_LOG_PREFIX}${n}.log`), mainText, "utf8");
    if (serial !== null) {
      writeFileSync(
        join(dir, `${RUNNER_LOG_PREFIX}${n}-serial.log`),
        serial,
        "utf8",
      );
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ⑴ failing output sample -> file + name annotations
// ---------------------------------------------------------------------------
test("⑴ 실패 출력 표본(spec): 실패 둘 -> 파일 경로 · 줄 · 이름이 든 ::error 주석 2건 (상대·절대·file:// 세 표기 모두 repo 상대 경로로)", () => {
  const text = specOutput([
    { loc: "scripts/check/foo.test.mjs:8:1", name: "failing top level" },
    {
      loc: "/home/runner/work/_temp/iso-clone-ab12/scripts/relay/bar.test.mjs:13:3",
      name: "nested failing case",
    },
    {
      loc: "file:///home/runner/work/_temp/iso-clone-ab12/templates/harness-init/baz.test.mjs:5:1",
      name: "third one",
    },
  ]);
  const r = extractFailures(text);
  assert.equal(r.items.length, 3);
  assert.deepEqual(
    r.items.map((i) => [i.file, i.line, i.name]),
    [
      ["scripts/check/foo.test.mjs", 8, "failing top level"],
      ["scripts/relay/bar.test.mjs", 13, "nested failing case"],
      ["templates/harness-init/baz.test.mjs", 5, "third one"],
    ],
  );
  const lines = annotationLines(buildAnnotations(r));
  assert.equal(lines.length, 3);
  assert.equal(
    lines[0],
    "::error file=scripts/check/foo.test.mjs,line=8,title=failed test::failing top level",
  );
  assert.match(
    lines[1],
    /^::error file=scripts\/relay\/bar\.test\.mjs,line=13,/,
  );
  assert.match(
    lines[2],
    /file=templates\/harness-init\/baz\.test\.mjs,line=5,/,
  );
});

test("⑴ CLI 구동: 러너 로그 디렉터리(full-runner-<N>.log)를 읽어 stdout 에 ::error 줄을 내고 종료 코드는 0 (실제 자식 node 프로세스)", () => {
  const text = specOutput([
    { loc: "scripts/check/foo.test.mjs:8:1", name: "failing top level" },
  ]);
  withLogDir(text, {}, (p) => {
    const res = runCli([p]);
    assert.equal(res.status, 0);
    const lines = annotationLines(res.stdout.split(/\r?\n/));
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /^::error file=scripts\/check\/foo\.test\.mjs,line=8,/,
    );
    assert.match(lines[0], /::failing top level$/);
  });
});

test("⑴ 윈도 모양 표본: 역슬래시 경로 · 드라이브 문자도 repo 상대 슬래시 경로로 (Windows 가정을 일부러 합성)", () => {
  assert.deepEqual(
    normalizeTestPath(
      "C:\\Users\\x\\clone-1\\scripts\\check\\foo.test.mjs:12:5",
    ),
    { file: "scripts/check/foo.test.mjs", line: 12 },
  );
  assert.deepEqual(normalizeTestPath("scripts/check/foo.test.mjs:7:1"), {
    file: "scripts/check/foo.test.mjs",
    line: 7,
  });
  assert.equal(normalizeTestPath("::error file=evil"), null);
});

test("⑴ TAP 모양 표본(not ok + location): 파일 · 줄 · 이름 추출", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: ok one",
    "ok 1 - ok one",
    "# Subtest: failing top level with : colon and 100% pct",
    "not ok 2 - failing top level with : colon and 100% pct",
    "  ---",
    "  duration_ms: 0.7035",
    "  type: 'test'",
    "  location: '/home/runner/work/_temp/iso/scripts/check/foo.test.mjs:8:1'",
    "  failureType: 'testCodeFailure'",
    "  ...",
    "1..2",
    "# tests 2",
    "# pass 1",
    "# fail 1",
  ].join("\n");
  const r = extractFailures(tap);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].file, "scripts/check/foo.test.mjs");
  assert.equal(r.items[0].line, 8);
  const line = annotationLines(buildAnnotations(r))[0];
  assert.match(line, /::failing top level with : colon and 100%25 pct$/);
});

// ---------------------------------------------------------------------------
// ⑵ sweep re-run failures
// ---------------------------------------------------------------------------
test('⑵ 스윕이 다시 돌린 실패("Failing test(s) (file:line -- name)"): 안쪽 실패 파일·이름이 주석으로, 바깥 시험(스윕 자신)도 함께', () => {
  const outerName =
    "HYK-359 완료조건4: CI-canonical 시험 디렉토리 전체가 떠도는 원장 env 아래에서도 fail 0";
  // the message hyk359-ambient-env-regression.test.mjs:492 builds, as the
  // spec reporter prints it inside the failing-tests block
  const text = specOutput(
    [
      {
        loc: "scripts/check/hyk359-ambient-env-regression.test.mjs:1587:1",
        name: outerName,
        errLines: [
          "AssertionError [ERR_ASSERTION]: 2 test(s) failed under a floating ambient ledger env across the swept CI-canonical set -- isolation regressed. Failing test(s) (file:line -- name):",
          "/home/runner/work/_temp/sweep-clone/scripts/check/inner-a.test.mjs:41:3 -- inner failing alpha",
          "scripts/relay/inner-b.test.mjs:7:1 -- inner failing beta",
          "full raw stdout preserved at: /tmp/hyk359-ambient-regression-abc/sweep-full-stdout.log",
          "status=1",
        ],
      },
    ],
    { tests: 5000 },
  );
  const r = extractFailures(text);
  const names = r.items.map((i) => i.name);
  assert.ok(names.includes("inner failing alpha"), JSON.stringify(names));
  assert.ok(names.includes("inner failing beta"), JSON.stringify(names));
  assert.ok(names.includes(outerName), JSON.stringify(names));
  const alpha = r.items.find((i) => i.name === "inner failing alpha");
  assert.equal(alpha.file, "scripts/check/inner-a.test.mjs");
  assert.equal(alpha.line, 41);
  // inner (specific) failures are ranked ahead of the generic wrapper test
  assert.ok(
    names.indexOf("inner failing alpha") < names.indexOf(outerName),
    "inner sweep failures must come before the wrapper test",
  );
  assert.equal(new Set(names).size, names.length, "no duplicate entries");
});

// ---------------------------------------------------------------------------
// ⑶ timeout-cut output
// ---------------------------------------------------------------------------
test("⑶ 시간 초과로 끊긴 출력(요약 줄 없음 · ✖ 없음): 뽑지 못했다 주석 정확히 1건 + 끊김 사유 (0건으로 조용히 끝나지 않는다)", () => {
  const cut = [
    "[isolated-suite-runner] test-concurrency=2 (auto)",
    "✔ passing one (0.7ms)",
    "✔ passing two (0.8ms)",
    "▶ suite still running",
  ].join("\n");
  const r = extractFailures(cut);
  assert.equal(r.items.length, 0);
  assert.equal(r.summary, null);
  const lines = annotationLines(buildAnnotations(r));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::error title=failed tests not extracted::/);
  assert.match(lines[0], /cut off|no test summary/);
});

test("⑶ 끊긴 출력이라도 그 전에 찍힌 ✖ 줄은 이름으로 쓴다 + 끊김 경고 1건", () => {
  const cut = [
    "✔ passing one (0.7ms)",
    "✖ already failed before the cut (3.1ms)",
    "▶ suite still running",
  ].join("\n");
  const r = extractFailures(cut);
  assert.deepEqual(
    r.items.map((i) => i.name),
    ["already failed before the cut"],
  );
  const lines = annotationLines(buildAnnotations(r));
  assert.equal(lines.filter((l) => l.startsWith("::error ")).length, 1);
  assert.equal(
    lines.filter((l) => /^::warning title=output cut off/.test(l)).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// ⑷ zero failures
// ---------------------------------------------------------------------------
test("⑷ 실패 0 출력: 함수 값은 items 0 · 주석 0 (이 단계가 failure() 에서만 돈다는 사실과 별개)", () => {
  const text = specOutput([], { tests: 100 });
  const r = extractFailures(text);
  assert.equal(r.items.length, 0);
  assert.equal(r.summary.fail, 0);
  assert.deepEqual(buildAnnotations(r, { stepFailed: false }), []);
});

test("⑷ 단계는 실패했는데 출력은 fail 0: CLI 는 조용히 0건으로 끝내지 않고 사유를 단 주석 1건", () => {
  withLogDir(specOutput([], { tests: 100 }), {}, (p) => {
    const res = runCli([p]);
    assert.equal(res.status, 0);
    const lines = annotationLines(res.stdout.split(/\r?\n/));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^::error title=failed tests not extracted::/);
    assert.match(lines[0], /fail 0/);
  });
});

// ---------------------------------------------------------------------------
// ⑸ over 10
// ---------------------------------------------------------------------------
test("⑸ 상한: 정확히 10건 -> 주석 10 · 나머지 줄 0 / 11건 -> 10 + 나머지 1건 줄 / 13건 -> 10 + 나머지 3건 줄", () => {
  assert.equal(MAX_ANNOTATIONS, 10);
  const mk = (n) =>
    annotationLines(
      buildAnnotations(
        extractFailures(specOutput(manyFailures(n), { tests: 80 })),
      ),
    );
  const ten = mk(10);
  assert.equal(ten.length, 10);
  assert.equal(ten.filter((l) => l.startsWith("::error ")).length, 10);
  const eleven = mk(11);
  assert.equal(eleven.filter((l) => l.startsWith("::error ")).length, 10);
  const rest11 = eleven.filter((l) => !l.startsWith("::error "));
  assert.equal(rest11.length, 1);
  assert.match(
    rest11[0],
    /^::warning title=more failed tests::1 more failed test\(s\)/,
  );
  const thirteen = mk(13);
  assert.equal(thirteen.filter((l) => l.startsWith("::error ")).length, 10);
  const rest13 = thirteen.filter((l) => !l.startsWith("::error "));
  assert.equal(rest13.length, 1);
  assert.match(rest13[0], /3 more failed test\(s\)/);
  assert.match(rest13[0], /13 failed in total/);
});

// ---------------------------------------------------------------------------
// ⑹ env-like / secret-like strings never reach an annotation
// ---------------------------------------------------------------------------
test("⑹ 환경 변수 모양 · 비밀 모양 문자열이 출력에 섞여도 주석에는 0 (이름 안 · 오류 본문 · 실제 env 값 세 경로)", () => {
  // built at run time so no secret-shaped literal sits in this source file
  const ghToken = "gh" + "p_" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2";
  const awsKey = "AK" + "IA" + "ABCDEFGHIJKLMNOP";
  const bearer = "Bearer " + "zz9plural-token-value-7f3a";
  const hex64 = "9f2c71ab".repeat(8);
  const envCanary = "canary-env-value-7e31-HYK459";
  const nameWithEnv = `reads NODE_AUTH_TOKEN=tok-${hex64.slice(0, 12)}xyz and ${bearer} then ${ghToken} ${awsKey} ${hex64} done`;
  const text = specOutput(
    [
      {
        loc: "scripts/check/foo.test.mjs:8:1",
        name: nameWithEnv,
        // key words split so this source line itself never looks like a
        // credential assignment to a secret scanner
        err: `GITHUB_${"TOKEN"}=${ghToken} AWS_SECRET_${"ACCESS_KEY"}=secret-body-value-1 PASS${"WORD"}: hunter2-body`,
      },
      {
        loc: "scripts/check/bar.test.mjs:9:1",
        name: `echoes HYK459_SECRET_KEY value ${envCanary} verbatim`,
      },
    ],
    { tests: 10 },
  );
  const lines = buildAnnotations(extractFailures(text), {
    env: { HYK459_SECRET_KEY: envCanary },
  });
  const joined = lines.join("\n");
  for (const forbidden of [
    ghToken,
    awsKey,
    bearer,
    "zz9plural-token-value-7f3a",
    hex64,
    "secret-body-value-1",
    "hunter2-body",
    envCanary,
    "tok-9f2c71ab9f2c",
  ]) {
    assert.equal(
      joined.includes(forbidden),
      false,
      `annotation text must not contain ${forbidden.slice(0, 12)}…`,
    );
  }
  assert.match(joined, /\[filtered\]/);
  assert.match(joined, /reads /, "the harmless part of the name survives");

  // the same through the real CLI + a real process env value
  withLogDir(text, {}, (p) => {
    const res = runCli([p], { env: { HYK459_SECRET_KEY: envCanary } });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.includes(envCanary), false);
    assert.equal(res.stdout.includes(ghToken), false);
    assert.equal(res.stderr.includes(envCanary), false);
  });
});

test("⑹ scrubName: 직접 구동 — 이름 안의 VAR=값 · 토큰 모양 · 긴 불투명 문자열은 [filtered], 평범한 이름은 그대로", () => {
  assert.equal(scrubName("plain test name 100% ok"), "plain test name 100% ok");
  assert.match(
    scrubName("uses MY_SECRET=abc123 inline"),
    /uses \[filtered\] inline/,
  );
  assert.equal(
    scrubName("x " + "9f2c71ab".repeat(6) + " y").includes("9f2c71ab"),
    false,
  );
});

// ---------------------------------------------------------------------------
// escaping + name safety
// ---------------------------------------------------------------------------
test("GitHub 명령 이스케이프: 이름 안의 % · 줄바꿈 · :: 가 한 줄 주석을 깨거나 새 명령을 만들지 못한다", () => {
  const r = {
    items: [
      {
        file: "scripts/check/a,b.test.mjs",
        line: 3,
        name: "50% done\n::error title=injected::boo\r\nend",
      },
    ],
    summary: { tests: 3, fail: 1 },
    cut: false,
  };
  const lines = buildAnnotations(r);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes("\n"), false);
  assert.equal(lines[0].includes("\r"), false);
  assert.match(lines[0], /50%25 done%0A/);
  // a comma in the path would end the file= property early -> escaped
  assert.match(lines[0], /file=scripts\/check\/a%2Cb\.test\.mjs,/);
  // only one command on the line
  assert.equal((lines[0].match(/::error /g) ?? []).length, 1);
});

test("긴 이름은 잘라서 한 줄 길이를 묶는다 · 제어 문자는 제거", () => {
  const lines = buildAnnotations({
    items: [{ file: null, line: null, name: "n".repeat(900) + "\u0007bell" }],
    summary: { tests: 1, fail: 1 },
    cut: false,
  });
  assert.ok(lines[0].length < 600, `line length ${lines[0].length}`);
  assert.equal(lines[0].includes("\u0007"), false);
});

// ---------------------------------------------------------------------------
// CLI always exits 0
// ---------------------------------------------------------------------------
test("CLI 는 어떤 입력에서도 종료 코드 0: 인자 없음(.harness 기본값) · 없는 디렉터리 · 로그 없는 디렉터리 · 파일을 디렉터리 자리에 · 쓰레기 바이트 · 빈 로그 — 그리고 매번 주석 1건 이상(조용한 0건 없음)", () => {
  const cases = [];
  // no args -> default ".harness" relative to the child's cwd; run it in an
  // empty temp dir so the real repo's .harness is never read
  const emptyCwd = mkdtempSync(join(tmpdir(), "ci-fail-annotate-cwd-"));
  try {
    cases.push([
      "no args",
      spawnSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        cwd: emptyCwd,
      }),
    ]);
  } finally {
    rmSync(emptyCwd, { recursive: true, force: true });
  }
  cases.push([
    "missing dir",
    runCli([join(tmpdir(), "ci-fail-annotate-nonexistent-dir-0")]),
  ]);
  const bareDir = mkdtempSync(join(tmpdir(), "ci-fail-annotate-bare-"));
  try {
    // a directory that exists but holds no full-runner-<N>.log
    cases.push(["no logs in dir", runCli([bareDir])]);
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
  }
  withLogDir("x", {}, (dir) => {
    // a FILE where a directory is expected
    cases.push([
      "file instead of dir",
      runCli([join(dir, "full-runner-1.log")]),
    ]);
  });
  withLogDir(
    Buffer.from([0, 255, 254, 1, 2, 3]).toString("latin1"),
    {},
    (p) => {
      cases.push(["garbage bytes", runCli([p])]);
    },
  );
  withLogDir("", {}, (p) => {
    cases.push(["empty log", runCli([p])]);
  });
  for (const [label, res] of cases) {
    assert.equal(
      res.status,
      0,
      `${label}: exit ${res.status} stderr=${res.stderr}`,
    );
    const lines = annotationLines(res.stdout.split(/\r?\n/));
    assert.ok(
      lines.length >= 1,
      `${label}: expected at least one annotation, got ${JSON.stringify(res.stdout)}`,
    );
    assert.match(
      lines[0],
      /^::error title=failed tests not extracted::/,
      label,
    );
  }
});

test("러너 로그 고르기: 가장 큰 N 의 full-runner-<N>.log 와 같은 N 의 -serial.log 쌍만 읽는다 (옛 N 의 실패는 섞이지 않는다) · 직렬 패스 실패도 합쳐진다", () => {
  assert.deepEqual(
    pickLatestRunnerLogs([
      "full-runner-1.log",
      "full-runner-10.log",
      "full-runner-9.log",
      "full-runner-9-serial.log",
      "full-runner-10-serial.log",
      "runner-receipt-run10.json",
      "full-runner-x.log",
    ]),
    {
      n: 10,
      main: "full-runner-10.log",
      serial: "full-runner-10-serial.log",
    },
  );
  assert.equal(pickLatestRunnerLogs(["runner-receipt-run1.json"]), null);
  assert.equal(
    pickLatestRunnerLogs(["full-runner-3.log", "full-runner-2-serial.log"])
      .serial,
    null,
  );

  const dir = mkdtempSync(join(tmpdir(), "ci-fail-annotate-pick-"));
  try {
    writeFileSync(
      join(dir, "full-runner-1.log"),
      specOutput([
        { loc: "scripts/check/stale.test.mjs:1:1", name: "stale run failure" },
      ]),
    );
    writeFileSync(
      join(dir, "full-runner-2.log"),
      specOutput([
        {
          loc: "scripts/check/main-pass.test.mjs:2:1",
          name: "main pass failure",
        },
      ]),
    );
    writeFileSync(
      join(dir, "full-runner-2-serial.log"),
      specOutput(
        [
          {
            loc: "templates/harness-init/serial.test.mjs:3:1",
            name: "serial pass failure",
          },
        ],
        { tests: 7 },
      ),
    );
    const r = extractFromLogDir(dir);
    assert.deepEqual(r.items.map((i) => i.name).sort(), [
      "main pass failure",
      "serial pass failure",
    ]);
    assert.equal(r.runNumber, 2);
    assert.equal(r.summary.fail, 2);
    assert.equal(r.summary.tests, 47);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("생산자-소비자 연결: runner-receipt-writer 의 allocateRunSlot 이 실제로 할당한 로그 경로를 이 스크립트가 읽는다 + 접두사·직렬 이름·디렉터리 이름이 러너 소스와 같다 (이름이 바뀌면 RED)", () => {
  assert.equal(RUNNER_LOG_PREFIX, PRODUCER_LOG_PREFIX);
  assert.equal(DEFAULT_LOG_DIR, ".harness");
  const runnerSource = readFileSync(
    join(HERE, "isolated-suite-runner.mjs"),
    "utf8",
  );
  assert.ok(
    runnerSource.includes('join(root, ".harness")'),
    'isolated-suite-runner.mjs no longer allocates its slot under join(root, ".harness")',
  );
  assert.ok(
    runnerSource.includes('mainLogPath.replace(/\\.log$/, "-serial.log")'),
    "isolated-suite-runner.mjs no longer derives the -serial.log name this reader pairs with",
  );
  const dir = mkdtempSync(join(tmpdir(), "ci-fail-annotate-slot-"));
  try {
    const slot = allocateRunSlot({ harnessDir: dir });
    writeFileSync(
      slot.logPath,
      specOutput([
        {
          loc: "scripts/check/real-slot.test.mjs:4:1",
          name: "found via the real allocator",
        },
      ]),
    );
    assert.equal(
      basename(slot.logPath),
      `${PRODUCER_LOG_PREFIX}${slot.runNumber}.log`,
    );
    const res = runCli([dir]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /found via the real allocator/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("annotateOutput(text) = extract + build 한 번에 (함수 직접)", () => {
  const out = annotateOutput(
    specOutput([{ loc: "scripts/check/foo.test.mjs:8:1", name: "one" }]),
  );
  assert.equal(annotationLines(out).length, 1);
});

// ---------------------------------------------------------------------------
// ⑺ enforce.yml structure (the working-tree file, parsed line-wise)
// ---------------------------------------------------------------------------
// the indented body of a `run: |` block that starts after line index `from`
function readRunBlock(lines, from) {
  const body = [];
  for (let j = from; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === "") {
      body.push("");
    } else if (/^ {9,}/.test(l)) {
      body.push(l.trim());
    } else {
      break;
    }
  }
  return body.join("\n").trim();
}

function readStepKeys(step) {
  step.keys = new Map();
  step.run = null;
  for (let i = 1; i < step.lines.length; i++) {
    const km = /^ {8}([A-Za-z][\w-]*):(.*)$/.exec(step.lines[i]);
    if (!km) continue;
    const value = km[2].trim();
    step.keys.set(km[1], value);
    if (km[1] !== "run") continue;
    step.run = /^[|>]/.test(value) ? readRunBlock(step.lines, i + 1) : value;
  }
}

function readSteps(text) {
  const steps = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {6}- name: (.*)$/.exec(line);
    if (m) {
      cur = { name: m[1].trim(), lines: [line] };
      steps.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  steps.forEach(readStepKeys);
  return steps;
}

const TEST_STEP_NAME =
  "check test suites (scripts/check + scripts/relay + scripts/relay/adapters + scripts/supervisor + templates/harness-init *.test.mjs)";

function workflow() {
  const text = readFileSync(ENFORCE_YML_PATH, "utf8");
  const steps = readSteps(text);
  const i = steps.findIndex((s) => s.name === TEST_STEP_NAME);
  return { text, steps, i };
}

// The `check test suites` step exactly as it stood at base 41df4ce (the head
// of PR 389): command, name and the two env lines. HYK-459 must not touch it
// -- the exit code of this step IS the job result, and an unchanged command
// with no pipe keeps it by construction. Pinned as a literal (not read from
// git) so the cell keeps working after the base commit stops being a
// convenient thing to fetch.
const BASE_TEST_STEP_TEXT = [
  `      - name: ${TEST_STEP_NAME}`,
  "        run: npm test",
  "        env:",
  '          HARNESS_FULL_AMBIENT_SWEEP: "1"',
  "          HARNESS_AMBIENT_SWEEP_MARKER: ${{ runner.temp }}/ambient-sweep-ran.json",
].join("\n");

test("⑺ enforce.yml 시험 단계: base 41df4ce 와 바이트 동일 — 이름 · run: npm test(파이프 · pipefail · tee 없음) · env 두 줄 · shell/if/예외 키 없음", () => {
  const { text, steps, i } = workflow();
  assert.notEqual(i, -1, "test step not found by its exact name");
  const step = steps[i];
  // byte-identical head of the step block, and it occurs exactly once
  assert.equal(
    step.lines.slice(0, 5).join("\n"),
    BASE_TEST_STEP_TEXT,
    "the test step's first five lines must equal the base-41df4ce text byte for byte",
  );
  assert.equal(text.split(BASE_TEST_STEP_TEXT).length - 1, 1);
  assert.equal(
    step.run,
    "npm test",
    "the test step must run exactly `npm test`",
  );
  for (const key of [
    "shell",
    "if",
    "continue-on-error",
    "timeout-minutes",
    "working-directory",
  ]) {
    assert.equal(
      step.keys.has(key),
      false,
      `the test step must not carry ${key}:`,
    );
  }
  assert.deepEqual([...step.keys.keys()], ["run", "env"]);
});

test("⑺ enforce.yml 요약 단계: 시험 단계 바로 다음 · if: failure() 정확히 그 값 · 예외 키 없음 · 러너 로그 디렉터리(.harness)로 새 스크립트 호출 · || echo 로 항상 exit 0 · 다음 단계는 ambient-sweep 보고 · 워크플로 전체에서 step-level if: 는 이것 하나", () => {
  const { text, steps, i } = workflow();
  const ann = steps[i + 1];
  assert.ok(ann, "no step after the test step");
  assert.match(ann.name, /^annotate failed test suites \(HYK-459 /);
  assert.equal(
    ann.keys.get("if"),
    "failure()",
    "summary step must run on failure() only",
  );
  for (const key of ["continue-on-error", "shell", "needs", "env"]) {
    assert.equal(
      ann.keys.has(key),
      false,
      `summary step must not carry ${key}:`,
    );
  }
  assert.equal(
    ann.run,
    `node scripts/check/ci-fail-annotate.mjs ${DEFAULT_LOG_DIR} || echo "::error title=failed tests not extracted::the annotate script itself failed to run -- open the step log"`,
  );
  // exit 0 by construction: the script itself exits 0 (CLI tests above) and a
  // failure to even start it is turned into an annotation, never a non-zero
  assert.equal(
    /\bexit\s+[1-9]/.test(ann.run),
    false,
    "no explicit non-zero exit",
  );
  assert.equal(/\bset -e\b/.test(ann.run), false);
  assert.match(steps[i + 2].name, /^ambient-sweep report \(HYK-477\)$/);
  // exactly one step-level if: in the whole workflow, and it is this one
  assert.deepEqual(
    steps.filter((s) => s.keys.has("if")).map((s) => s.name),
    [ann.name],
  );
  assert.equal(/continue-on-error/.test(text), false);
});

test("⑺ 합성 직접 구동: 구조 판독기는 파이프가 붙은 시험 단계 · if: always() 요약 단계 · 다른 키가 낀 단계를 구별한다 (헛시험이 아님)", () => {
  const fake = [
    "      - name: " + TEST_STEP_NAME,
    "        run: |",
    '          npm test 2>&1 | tee "$RUNNER_TEMP/x.log"',
    "        env:",
    '          HARNESS_FULL_AMBIENT_SWEEP: "1"',
    "      - name: annotate failed test suites (HYK-459 x)",
    "        if: always()",
    "        run: echo hi",
    "",
  ].join("\n");
  const steps = readSteps(fake);
  assert.equal(steps.length, 2);
  assert.notEqual(steps[0].run, "npm test");
  assert.notEqual(steps[0].lines.slice(0, 5).join("\n"), BASE_TEST_STEP_TEXT);
  assert.equal(steps[1].keys.get("if"), "always()");
});
