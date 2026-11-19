// HYK-406-usage-watch-1 (조각 A) -- 예약 감시 사용량 임계 축 시험.
//
// ⭐프로덕션 회차(`runWatchOnce`)를 구동한다 -- 코어 함수 단독 시험은 헛시험이다
// (판정 2041 조건 5). 입력은 전부 합성: mkdtemp HUD 디렉터리 · mkdtemp watch
// 디렉터리 · mkdtemp 받는함. ⛔실제 홈 `.claude/hud` · 관제실 · 실제 받는함 무접촉.
// ⛔OBSERVER · 앵커 아님 (usage-threshold-core.mjs 머리).
//
// 단언 규율: 출력 «전체» 문자열 동등 단언 금지 -- 자기 토막만 본다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as watchRun from "./watch-run.mjs";
import { defaultHudDir } from "./usage-threshold-wire.mjs";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// 실제 홈(~/.claude)을 읽지 않게 이 시험 프로세스의 «홈» 자체를 합성 디렉터리로
// 돌린다 -- 프로덕션 회차 안의 기존 한도 정지 단계(rate-limit-stall)도
// os.homedir() 기준으로 세션 기록을 찾기 때문이다. 이 시험은 그 어떤 실제
// 홈 파일도 읽지 않는다. 종료 때 원래 값으로 되돌리고 합성 홈을 지운다.
const FAKE_HOME = fs.mkdtempSync(join(os.tmpdir(), "hyk406-home-"));
const SAVED_ENV = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
};
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;
process.on("exit", () => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});
const NOW = Date.parse("2026-11-18T12:00:00Z");
const MIN = 60 * 1000;
const { runWatchOnce } = watchRun;
const OK_DETECTOR = JSON.stringify({
  verdict: "PROGRESSING",
  reasonCode: "OK",
});

function sandbox() {
  const root = fs.mkdtempSync(join(os.tmpdir(), "hyk406-usage-"));
  const dirs = {
    root,
    hudDir: join(root, "hud"),
    watchDir: join(root, "watch"),
    notifyDir: join(root, "받는함"),
  };
  fs.mkdirSync(dirs.hudDir, { recursive: true });
  return dirs;
}

// harness-hud.mjs:139-142 와 같은 모양(at · role · model · ctx · five_hour ·
// seven_day · session_id · cwd)으로 쓴다.
function writeHud(hudDir, role, fields) {
  const snap = {
    at: new Date(NOW - 1 * MIN).toISOString(),
    role: role === "NOROLE" ? null : role,
    model: "synthetic",
    ctx: 10,
    five_hour: 10,
    seven_day: 10,
    session_id: "s-synthetic",
    cwd: "C:/synthetic",
    ...fields,
  };
  fs.writeFileSync(
    join(hudDir, `ratelimit-${role}.json`),
    `${JSON.stringify(snap)}\n`,
  );
}

function cycle(d, now = NOW, extra = {}) {
  return runWatchOnce({
    repoRoot: ROOT,
    watchDir: d.watchDir,
    notifyDir: d.notifyDir,
    now,
    execFn: () => OK_DETECTOR,
    usageThreshold: { hudDir: d.hudDir },
    ...extra,
  });
}

function notices(d) {
  if (!fs.existsSync(d.notifyDir)) return [];
  return fs
    .readdirSync(d.notifyDir)
    .filter((n) => n.startsWith("usage-threshold-notify-"))
    .sort()
    .map((n) => fs.readFileSync(join(d.notifyDir, n), "utf8"));
}

function firstLine(text) {
  return text.split("\n")[0];
}

function logText(d) {
  return fs.readFileSync(join(d.watchDir, "watch.log"), "utf8");
}

function stateOf(d) {
  return JSON.parse(
    fs.readFileSync(
      join(d.watchDir, "usage-threshold-notify-state.json"),
      "utf8",
    ),
  );
}

function withSandbox(fn) {
  const d = sandbox();
  try {
    return fn(d);
  } finally {
    fs.rmSync(d.root, { recursive: true, force: true });
  }
}

test("ORCH ctx 66 + wk 91 (at 1분 전) -> 받는함에 통지 1장 · 첫 줄은 한 줄 결론 · watch.log 에 usage-threshold: 구간", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: 66, seven_day: 91 });
    const r = cycle(d);
    const all = notices(d);
    assert.equal(all.length, 1);
    assert.match(
      firstLine(all[0]),
      /^ORCH 컨텍스트 66% — 교대 권장선 65% 넘음 · 교대 준비 \(외 1건\)$/,
    );
    assert.ok(all[0].includes("주간 사용량 91% — 접기선 90% 넘음"));
    assert.equal(r.usageThreshold.events.length, 2);
    assert.match(
      logText(d),
      /usage-threshold: ctx_band=ctx65 ctx_pct=66 wk_band=wk90 wk_pct=91/,
    );
    assert.match(logText(d), /events=2/);
  });
});

test("같은 표본으로 2회차 -> 통지 0 (같은 띠 반복 없음)", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: 66, seven_day: 91 });
    cycle(d);
    const r2 = cycle(d, NOW + 15 * MIN);
    assert.equal(notices(d).length, 1);
    assert.equal(r2.usageThreshold.events.length, 0);
    assert.match(logText(d).trim().split("\n").at(-1), /events=0/);
  });
});

test("ctx 65 -> 75 로 올라서면 두 번째 통지(띠에 새로 들어섰다) · 첫 줄은 하드선 결론", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: 66 });
    cycle(d);
    writeHud(d.hudDir, "ORCH", {
      ctx: 76,
      at: new Date(NOW + 14 * MIN).toISOString(),
    });
    cycle(d, NOW + 15 * MIN);
    const all = notices(d);
    assert.equal(all.length, 2);
    assert.match(
      firstLine(all[1]),
      /^ORCH 컨텍스트 76% — 하드선 75% 넘음 · 교대 필요$/,
    );
  });
});

test("wk 95 는 wk 90 과 다른 띠 -- 90 통지 뒤 96 이면 유휴선 통지가 따로 나간다", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { seven_day: 91 });
    cycle(d);
    writeHud(d.hudDir, "CODER", {
      seven_day: 96,
      at: new Date(NOW + 14 * MIN).toISOString(),
    });
    cycle(d, NOW + 15 * MIN);
    const all = notices(d);
    assert.equal(all.length, 2);
    assert.match(firstLine(all[1]), /^주간 사용량 96% — 유휴선 95% 넘음/);
    assert.ok(all[1].includes("값을 가진 가장 신선한 파일 = CODER"));
  });
});

test("ORCH 파일 at 이 61분 전 -> STALE 통지 1 · 첫 줄에 분 단위 나이", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", {
      ctx: 30,
      at: new Date(NOW - 61 * MIN).toISOString(),
    });
    const r = cycle(d);
    const all = notices(d);
    assert.equal(all.length, 1);
    assert.match(
      firstLine(all[0]),
      /^ORCH 사용량 값이 낡음 — 마지막 갱신 61분 전/,
    );
    assert.equal(r.usageThreshold.ctx.kind, "STALE");
    assert.match(logText(d), /ctx_band=STALE/);
  });
});

test("ORCH 파일 at 이 59분 전이면 낡음이 아니다(경계 직전은 통지 0)", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", {
      ctx: 30,
      at: new Date(NOW - 59 * MIN).toISOString(),
    });
    cycle(d);
    assert.equal(notices(d).length, 0);
  });
});

test("seven_day 가 null -> 관측 불가 통지 1 · 0% 로 접지 않는다", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: 10, seven_day: null });
    const r = cycle(d);
    const all = notices(d);
    assert.equal(all.length, 1);
    assert.match(
      firstLine(all[0]),
      /^주간 사용량을 읽을 수 없음 — .*0% 로 보지 않음$/,
    );
    assert.equal(r.usageThreshold.wk.kind, "UNOBSERVABLE");
    assert.equal(r.usageThreshold.wk.value, undefined);
    assert.match(logText(d), /wk_band=UNOBSERVABLE wk_pct=NONE/);
    assert.equal(
      stateOf(d).wkBand,
      "OK",
      "관측 불가가 «정상 0%» 띠를 기록하면 안 된다",
    );
    assert.equal(stateOf(d).wkAlert, "UNOBSERVABLE");
  });
});

test("ctx 가 null(벤더가 필드를 뺌) -> ORCH 컨텍스트 관측 불가 1 (0% 아님)", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: null });
    const r = cycle(d);
    assert.equal(r.usageThreshold.ctx.kind, "UNOBSERVABLE");
    assert.equal(r.usageThreshold.ctx.value, undefined);
    assert.ok(
      notices(d).some((t) =>
        /^ORCH 컨텍스트를 읽을 수 없음 — /.test(firstLine(t)),
      ),
    );
  });
});

test("깨진 JSON(쓰는 도중에 읽음) -> 관측 불가 통지 · 회차는 산다(last-run.json · watch.log 모두 생김)", () => {
  withSandbox((d) => {
    fs.writeFileSync(
      join(d.hudDir, "ratelimit-ORCH.json"),
      '{"at":"2026-11-18T1',
    );
    const r = cycle(d);
    assert.equal(r.usageThreshold.ctx.kind, "UNOBSERVABLE");
    assert.match(r.usageThreshold.ctx.reason, /깨진 JSON/);
    assert.ok(
      fs.existsSync(join(d.watchDir, "last-run.json")),
      "회차 생존 기록",
    );
    assert.ok(notices(d).length >= 1);
    assert.match(firstLine(notices(d)[0]), /^ORCH 컨텍스트를 읽을 수 없음/);
  });
});

test("HUD 디렉터리가 없다 -> 관측 불가 통지(던지지 않는다)", () => {
  withSandbox((d) => {
    fs.rmSync(d.hudDir, { recursive: true, force: true });
    const r = cycle(d);
    assert.equal(r.usageThreshold.failed, undefined);
    assert.equal(r.usageThreshold.ctx.kind, "UNOBSERVABLE");
    assert.equal(notices(d).length, 1);
    assert.match(r.usageThreshold.ctx.reason, /HUD 디렉터리를 읽을 수 없음/);
  });
});

test("NOROLE 파일이 ORCH 파일보다 새롭다 -> STALE 문면에 «역할 값 없이 뜬 좌석»", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", {
      ctx: 40,
      at: new Date(NOW - 70 * MIN).toISOString(),
    });
    writeHud(d.hudDir, "NOROLE", {
      ctx: 71,
      at: new Date(NOW - 2 * MIN).toISOString(),
    });
    cycle(d);
    const all = notices(d);
    assert.equal(all.length, 1);
    assert.match(
      firstLine(all[0]),
      /^ORCH 사용량 값이 낡음 — .*역할 값 없이 뜬 좌석/,
    );
    assert.ok(all[0].includes("ratelimit-NOROLE.json"));
    // NOROLE 의 ctx(71)는 어느 좌석 것인지 몰라 ORCH 판정에 섞지 않는다.
    assert.equal(
      all.some((t) => /하드선|교대 권장선/.test(firstLine(t))),
      false,
    );
  });
});

test("NOROLE 파일이 ORCH 파일보다 오래됐으면 «역할 값 없이 뜬 좌석» 말을 붙이지 않는다", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", {
      ctx: 40,
      at: new Date(NOW - 70 * MIN).toISOString(),
    });
    writeHud(d.hudDir, "NOROLE", {
      ctx: 71,
      at: new Date(NOW - 90 * MIN).toISOString(),
    });
    cycle(d);
    assert.equal(notices(d).length, 1);
    assert.equal(notices(d)[0].includes("역할 값 없이"), false);
  });
});

test("띠 하강(교대로 ctx 가 내려감) -> 통지 0 + 상태 초기화 + watch.log descended 1줄, 다시 올라서면 새로 통지", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: 80 });
    cycle(d);
    assert.equal(notices(d).length, 1);
    writeHud(d.hudDir, "ORCH", {
      ctx: 12,
      at: new Date(NOW + 14 * MIN).toISOString(),
    });
    const down = cycle(d, NOW + 15 * MIN);
    assert.equal(notices(d).length, 1, "하강은 통지하지 않는다");
    assert.equal(down.usageThreshold.descents.length, 1);
    assert.equal(stateOf(d).ctxBand, "OK");
    assert.match(logText(d), /descended=ctx:ctx75>OK/);
    writeHud(d.hudDir, "ORCH", {
      ctx: 70,
      at: new Date(NOW + 29 * MIN).toISOString(),
    });
    cycle(d, NOW + 30 * MIN);
    assert.equal(notices(d).length, 2, "초기화 뒤 다시 들어서면 통지");
  });
});

test("5h 만 높다 -> 통지 0 · 상태 파일에 기록만", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: 10, five_hour: 99, seven_day: 10 });
    const r = cycle(d);
    assert.equal(notices(d).length, 0);
    assert.equal(r.usageThreshold.events.length, 0);
    assert.equal(stateOf(d).fiveHour.value, 99);
    assert.match(logText(d), /h5_pct=99/);
  });
});

test("읽을 수 없음 -> 같은 띠로 복귀하면 다시 통지하지 않는다(깜박임 통지 0)", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: 66 });
    cycle(d);
    fs.writeFileSync(join(d.hudDir, "ratelimit-ORCH.json"), "{broken");
    cycle(d, NOW + 15 * MIN);
    assert.equal(notices(d).length, 2);
    writeHud(d.hudDir, "ORCH", {
      ctx: 66,
      at: new Date(NOW + 29 * MIN).toISOString(),
    });
    cycle(d, NOW + 30 * MIN);
    assert.equal(
      notices(d).length,
      2,
      "같은 띠(65)로 돌아온 것은 새 띠가 아니다",
    );
  });
});

test("같은 낡음이 이어지면 통지 0", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", {
      ctx: 30,
      at: new Date(NOW - 90 * MIN).toISOString(),
    });
    cycle(d);
    cycle(d, NOW + 15 * MIN);
    cycle(d, NOW + 30 * MIN);
    assert.equal(notices(d).length, 1);
  });
});

test("단계 예외가 회차를 죽이지 않는다 -- 받는함 쓰기 실패 -> failed 결과 + watch.log FAILED 구간 + 회차 생존", () => {
  withSandbox((d) => {
    fs.writeFileSync(d.notifyDir, "받는함 자리에 일반 파일이 있다");
    writeHud(d.hudDir, "ORCH", { ctx: 80 });
    const r = cycle(d);
    assert.equal(r.usageThreshold.failed, true);
    assert.match(logText(d), /usage-threshold: FAILED reason=/);
    assert.ok(fs.existsSync(join(d.watchDir, "last-run.json")));
    assert.equal(
      fs.existsSync(join(d.watchDir, "usage-threshold-notify-state.json")),
      false,
      "통지가 안 나갔으면 상태가 전진하면 안 된다(다음 회차에 다시 시도)",
    );
  });
});

test("opt-in 아님(usageThreshold 생략) -> 단계 미실행: 통지 0 · 상태 파일 0 · watch.log 에 구간 0", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: 99, seven_day: 99 });
    const r = runWatchOnce({
      repoRoot: ROOT,
      watchDir: d.watchDir,
      notifyDir: d.notifyDir,
      now: NOW,
      execFn: () => OK_DETECTOR,
    });
    assert.equal(r.usageThreshold.notRun, true);
    assert.equal(notices(d).length, 0);
    assert.equal(logText(d).includes("usage-threshold:"), false);
    assert.equal(
      fs.existsSync(join(d.watchDir, "usage-threshold-notify-state.json")),
      false,
    );
  });
});

test("notifyDir 이 없으면 단계 미실행(상태가 통지 없이 전진하는 일을 막는다)", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: 99 });
    const r = runWatchOnce({
      repoRoot: ROOT,
      watchDir: d.watchDir,
      now: NOW,
      execFn: () => OK_DETECTOR,
      usageThreshold: { hudDir: d.hudDir },
    });
    assert.equal(r.usageThreshold.notRun, true);
    assert.equal(
      fs.existsSync(join(d.watchDir, "usage-threshold-notify-state.json")),
      false,
    );
  });
});

test("CLI 인자: 기본 켜짐 · --usage-hud-dir 재정의 · --no-usage-threshold 끄기 · 기본 HUD 자리는 홈의 .claude/hud", () => {
  assert.deepEqual(
    watchRun.buildUsageThresholdFromArgv(["--repo-root", "x"]),
    {},
  );
  assert.deepEqual(
    watchRun.buildUsageThresholdFromArgv(["--usage-hud-dir", "H:/h"]),
    { hudDir: "H:/h" },
  );
  assert.equal(
    watchRun.buildUsageThresholdFromArgv(["--no-usage-threshold"]),
    null,
  );
  assert.equal(defaultHudDir(), join(os.homedir(), ".claude", "hud"));
});

test("통지 문면 표본 -- 첫 줄 뒤 빈 줄 · 끝에 OBSERVER 고지(앵커 아님)", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: 76 });
    cycle(d);
    const [text] = notices(d);
    const lines = text.split("\n");
    assert.match(lines[0], /^ORCH 컨텍스트 76% — 하드선 75% 넘음 · 교대 필요$/);
    assert.equal(lines[1], "");
    assert.ok(text.includes("OBSERVER"));
    assert.ok(text.includes("앵커"));
  });
});

// ---- HYK-406-wk-gate-1: 조각 A 검토 P2-1 · P2-2 (검토 1R REVIEW-r1.md §5) ----

test("P2-1 범위 밖 퍼센트(ctx 150 · -5) -> 사유는 «범위 밖» 이다 · «값이 비었다(null)» 가 아니다 · 0% 로 접지 않는다", () => {
  for (const bad of [150, -5]) {
    withSandbox((d) => {
      writeHud(d.hudDir, "ORCH", { ctx: bad });
      const r = cycle(d);
      assert.equal(r.usageThreshold.ctx.kind, "UNOBSERVABLE", `ctx ${bad}`);
      assert.equal(r.usageThreshold.ctx.value, undefined);
      assert.match(r.usageThreshold.ctx.reason, /범위 밖/);
      assert.match(r.usageThreshold.ctx.reason, new RegExp(String(bad)));
      assert.equal(
        r.usageThreshold.ctx.reason.includes("비었다"),
        false,
        "범위 밖 값을 «비었다» 라고 말하면 사유가 사실과 다르다",
      );
      assert.match(firstLine(notices(d)[0]), /범위 밖/);
    });
  }
});

test("P2-1 범위 밖이 아닌 null 은 종전 사유 그대로(«값이 비었다(null)») -- 문구를 갈라야지 지우면 안 된다", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: null });
    const r = cycle(d);
    assert.match(r.usageThreshold.ctx.reason, /비었다\(null\)/);
    assert.equal(r.usageThreshold.ctx.reason.includes("범위 밖"), false);
  });
});

test("P2-1 주간 seven_day 가 범위 밖(150)이면 관측 불가 사유에 «범위 밖» 이 실린다(0% 아님)", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: 10, seven_day: 150 });
    const r = cycle(d);
    assert.equal(r.usageThreshold.wk.kind, "UNOBSERVABLE");
    assert.equal(r.usageThreshold.wk.value, undefined);
    assert.match(r.usageThreshold.wk.reason, /범위 밖/);
    assert.match(logText(d), /wk_band=UNOBSERVABLE wk_pct=NONE/);
  });
});

test("P2-2 ORCH 파일만 없음(다른 역할 파일은 있음) -> ctx 관측 불가(파일 없음) · 주간은 다른 역할 파일로 관측된다", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "CODER", { ctx: 99, seven_day: 50 });
    const r = cycle(d);
    assert.equal(r.usageThreshold.ctx.kind, "UNOBSERVABLE");
    assert.match(r.usageThreshold.ctx.reason, /파일 없음/);
    assert.equal(r.usageThreshold.wk.kind, "OBSERVED");
    assert.equal(r.usageThreshold.wk.value, 50);
    assert.equal(r.usageThreshold.wk.role, "CODER");
    // CODER 의 ctx 99 는 ORCH 판정에 섞이지 않는다.
    assert.equal(
      notices(d).some((t) => /하드선|교대 권장선/.test(firstLine(t))),
      false,
    );
    assert.match(firstLine(notices(d)[0]), /^ORCH 컨텍스트를 읽을 수 없음/);
  });
});

test("P2-2 at 없음 -> ORCH ctx 관측 불가(at 이 없거나 형식이 틀림) · 주간도 그 파일 값을 쓰지 않는다", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: 80, seven_day: 91, at: undefined });
    const r = cycle(d);
    assert.equal(r.usageThreshold.ctx.kind, "UNOBSERVABLE");
    assert.match(
      r.usageThreshold.ctx.reason,
      /at\(시각\)이 없거나 형식이 틀림/,
    );
    assert.equal(r.usageThreshold.wk.kind, "UNOBSERVABLE");
    assert.match(logText(d), /ctx_band=UNOBSERVABLE/);
    assert.equal(
      notices(d).some((t) => /하드선|접기선/.test(firstLine(t))),
      false,
      "at 을 믿을 수 없는 파일의 80 · 91 로 띠 통지를 내면 안 된다",
    );
  });
});

test("P2-2 at 이 미래(10분 뒤) -> ORCH ctx 관측 불가(미래 시각) · 주간도 그 파일을 고르지 않는다", () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", {
      ctx: 80,
      seven_day: 91,
      at: new Date(NOW + 10 * MIN).toISOString(),
    });
    const r = cycle(d);
    assert.equal(r.usageThreshold.ctx.kind, "UNOBSERVABLE");
    assert.match(r.usageThreshold.ctx.reason, /미래 시각/);
    assert.equal(r.usageThreshold.wk.kind, "UNOBSERVABLE");
    assert.equal(
      notices(d).some((t) => /하드선|접기선/.test(firstLine(t))),
      false,
    );
  });
});

test('P2-2 값이 문자열(ctx "80" · seven_day "91") -> 숫자로 바꿔 읽지 않는다 · 띠 통지 0 · 관측 불가', () => {
  withSandbox((d) => {
    writeHud(d.hudDir, "ORCH", { ctx: "80", seven_day: "91" });
    const r = cycle(d);
    assert.equal(r.usageThreshold.ctx.kind, "UNOBSERVABLE");
    assert.equal(r.usageThreshold.ctx.value, undefined);
    assert.equal(r.usageThreshold.wk.kind, "UNOBSERVABLE");
    assert.equal(r.usageThreshold.wk.value, undefined);
    assert.match(logText(d), /ctx_pct=NONE wk_band=UNOBSERVABLE wk_pct=NONE/);
    assert.equal(stateOf(d).wkBand, "OK");
    assert.equal(stateOf(d).ctxBand, "OK");
  });
});
