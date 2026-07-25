import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifySeatCandidate,
  normalizeSeatCandidate,
  normalizeSeatCandidates,
  collectSeatCandidates,
  createReferenceSeatCandidateDetector,
  CANDIDATE_STATE,
} from "./seat-candidate-adapter.mjs";

// 이 파일은 orca를 실제로 spawn하지 않는다(G9 -- collectSeatCandidates
// 호출 시 execFn을 항상 fake로 주입한다).
function poisonedExecFn() {
  throw new Error("poisoned execFn: real orca CLI must never be invoked in tests");
}

// ---------------------------------------------------------------------------
// classifySeatCandidate / normalizeSeatCandidate: capability 주입 계약
// ---------------------------------------------------------------------------

test("capability(classify) 미주입 -> state:unknown, observable:false(자동 real detector 0)", () => {
  const out = classifySeatCandidate({ tail: "Sonnet 5\n? for shortcuts" }, {});
  assert.equal(out.state, CANDIDATE_STATE.UNKNOWN);
  assert.equal(out.observable, false);
});

test("capability.classify가 함수가 아니면 값이 뭐든 unknown", () => {
  const out = classifySeatCandidate({ tail: "x" }, { classify: "not-a-fn" });
  assert.equal(out.state, CANDIDATE_STATE.UNKNOWN);
});

test("classify가 인식 못 하는 값을 반환하면 unknown(지어내지 않는다)", () => {
  const out = classifySeatCandidate({ tail: "x" }, { classify: () => "mystery" });
  assert.equal(out.state, CANDIDATE_STATE.UNKNOWN);
  assert.equal(out.observable, false);
});

test("classify가 던지면(예외) unknown -- 코어에 예외를 흘리지 않는다", () => {
  const out = classifySeatCandidate(
    { tail: "x" },
    {
      classify() {
        throw new Error("boom");
      },
    },
  );
  assert.equal(out.state, CANDIDATE_STATE.UNKNOWN);
});

test("classify:'shell' -> state shell, occupied undefined", () => {
  const out = classifySeatCandidate({ tail: "PS C:\\> " }, { classify: () => "shell" });
  assert.equal(out.state, CANDIDATE_STATE.SHELL);
  assert.equal(out.occupied, undefined);
  assert.equal(out.observable, true);
});

test("classify:'starting' -> state starting", () => {
  const out = classifySeatCandidate({ tail: "booting..." }, { classify: () => "starting" });
  assert.equal(out.state, CANDIDATE_STATE.STARTING);
});

test("classify:'busy' -> state agent(살아있으나 idle 아님)", () => {
  const out = classifySeatCandidate({ tail: "generating..." }, { classify: () => "busy" });
  assert.equal(out.state, CANDIDATE_STATE.AGENT);
});

test("classify:'idle' + detectActiveWork 미주입 -> idle-or-ready, occupied:false", () => {
  const out = classifySeatCandidate({ tail: "? for shortcuts" }, { classify: () => "idle" });
  assert.equal(out.state, CANDIDATE_STATE.IDLE_OR_READY);
  assert.equal(out.occupied, false);
});

test("classify:'idle' + detectActiveWork:true(이미 일함) -> idle-or-ready이지만 occupied:true", () => {
  const out = classifySeatCandidate(
    { tail: "? for shortcuts", handle: "h1" },
    { classify: () => "idle", detectActiveWork: () => true },
  );
  assert.equal(out.state, CANDIDATE_STATE.IDLE_OR_READY);
  assert.equal(out.occupied, true);
});

test("detectActiveWork가 던지면 unknown(예외를 코어로 흘리지 않는다)", () => {
  const out = classifySeatCandidate(
    { tail: "? for shortcuts" },
    {
      classify: () => "idle",
      detectActiveWork() {
        throw new Error("boom");
      },
    },
  );
  assert.equal(out.state, CANDIDATE_STATE.UNKNOWN);
  assert.equal(out.observable, false);
});

test("normalizeSeatCandidate: schemaVersion·handle을 얹는다", () => {
  const out = normalizeSeatCandidate(
    { handle: "seat-h", tail: "? for shortcuts" },
    { classify: () => "idle" },
  );
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.handle, "seat-h");
  assert.equal(out.state, CANDIDATE_STATE.IDLE_OR_READY);
});

test("normalizeSeatCandidates: 후보 전체를 정규화(선택은 하지 않는다)", () => {
  const out = normalizeSeatCandidates(
    [
      { handle: "a", tail: "PS C:\\> " },
      { handle: "b", tail: "? for shortcuts" },
    ],
    { classify: (t) => (t.includes("PS") ? "shell" : "idle") },
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].state, CANDIDATE_STATE.SHELL);
  assert.equal(out[1].state, CANDIDATE_STATE.IDLE_OR_READY);
});

test("normalizeSeatCandidates: candidates가 배열이 아니면 null", () => {
  assert.equal(normalizeSeatCandidates(null, {}), null);
});

// ---------------------------------------------------------------------------
// reference detector (opt-in, UNVERIFIED) -- D15/substring 방어
// ---------------------------------------------------------------------------

test("reference detector: 마지막 줄이 PS 프롬프트면 스크롤백에 옛 agent 마커가 있어도 shell(D15)", () => {
  const detector = createReferenceSeatCandidateDetector();
  const tail = [
    "Sonnet 5 [CODER] bypass permissions",
    "some old agent output...",
    "PS C:\\Users\\Administrator\\orca\\workspaces\\wt> ",
  ].join("\n");
  assert.equal(detector.classify(tail), "shell");
});

test("reference detector: plain shell이 마커 문자열을 화면에 띄웠어도(cat 등) tail이 프롬프트면 shell(mutation 7)", () => {
  const detector = createReferenceSeatCandidateDetector();
  const tail = [
    "PS C:\\wt> Get-Content task.md",
    "role: CODER  engine: gpt-5.6  model: Sonnet",
    "PS C:\\wt> ",
  ].join("\n");
  assert.equal(detector.classify(tail), "shell");
});

test("reference detector: 빈 tail -> shell", () => {
  const detector = createReferenceSeatCandidateDetector();
  assert.equal(detector.classify(""), "shell");
  assert.equal(detector.classify("   \n  "), "shell");
});

test("reference detector: 마커도 없고 프롬프트도 아니면 starting(부팅 중, 마커 미표출)", () => {
  const detector = createReferenceSeatCandidateDetector();
  assert.equal(detector.classify("Loading...\nplease wait"), "starting");
});

test("reference detector: claude 마커 + idle 프롬프트 마커 -> idle", () => {
  const detector = createReferenceSeatCandidateDetector();
  const tail = "Sonnet 5 [CODER] bypass permissions on\n? for shortcuts";
  assert.equal(detector.classify(tail), "idle");
});

test("reference detector: codex 마커만 있고 idle 프롬프트 마커 없음 -> busy", () => {
  const detector = createReferenceSeatCandidateDetector();
  const tail = "gpt-5.6 generating response...";
  assert.equal(detector.classify(tail), "busy");
});

// ---------------------------------------------------------------------------
// collectSeatCandidates: 후보 "전체" 관측 계약(PM 반증 c) -- 2+ 후보라도
// preview를 전부 읽는다(resolveSeatHandle의 즉시-AMBIGUOUS와 다르다).
// ---------------------------------------------------------------------------

function terminalListResponse(entries) {
  return { ok: true, result: { terminals: entries } };
}
function seatShowResponse(preview) {
  return { ok: true, result: { terminal: { preview } } };
}

test("collectSeatCandidates: 같은 워크트리 후보 여러 개를 전부 정규화(선택 0)", () => {
  const calls = [];
  const execFn = (argv) => {
    calls.push(argv);
    if (argv[0] === "terminal" && argv[1] === "list") {
      return terminalListResponse([
        { handle: "h-dead", worktreePath: "C:/wt/x", tabId: "abc-1" },
        { handle: "h-good", worktreePath: "C:/wt/x", tabId: "abc-2" },
        { handle: "h-other", worktreePath: "C:/wt/y", tabId: "abc-3" },
        { handle: "h-orphan", worktreePath: "", tabId: "abc-4" },
        { handle: "h-ghost", worktreePath: "C:/wt/x", tabId: "pty:abc-5" },
      ]);
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      const handle = argv[argv.indexOf("--terminal") + 1];
      if (handle === "h-dead") return seatShowResponse("PS C:\\wt\\x> ");
      if (handle === "h-good") return seatShowResponse("Sonnet 5 [CODER]\n? for shortcuts");
      throw new Error(`unexpected show for ${handle}`);
    }
    throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
  };

  const out = collectSeatCandidates(
    { worktreePath: "C:/wt/x" },
    { execFn, capabilities: createReferenceSeatCandidateDetector() },
  );

  assert.equal(out.length, 2);
  const byHandle = Object.fromEntries(out.map((c) => [c.handle, c]));
  assert.equal(byHandle["h-dead"].state, CANDIDATE_STATE.SHELL);
  assert.equal(byHandle["h-good"].state, CANDIDATE_STATE.IDLE_OR_READY);
  // h-other(다른 워크트리)·h-orphan(고아)·h-ghost(유령 탭)는 후보에서 빠졌다.
  assert.equal("h-other" in byHandle, false);
  assert.equal("h-orphan" in byHandle, false);
  assert.equal("h-ghost" in byHandle, false);
});

test("collectSeatCandidates: terminal list 실패 -> null(raw 관측 실패, 판정은 코어가 UNOBSERVABLE로 접는다)", () => {
  const execFn = () => ({ ok: false });
  const out = collectSeatCandidates({ worktreePath: "C:/wt/x" }, { execFn });
  assert.equal(out, null);
});

test("collectSeatCandidates: terminal show가 실패한 후보는 개별적으로 unknown/observable:false", () => {
  const execFn = (argv) => {
    if (argv[1] === "list") {
      return terminalListResponse([{ handle: "h1", worktreePath: "C:/wt/x", tabId: "a" }]);
    }
    if (argv[1] === "show") return { ok: false };
    throw new Error("unexpected");
  };
  const out = collectSeatCandidates(
    { worktreePath: "C:/wt/x" },
    { execFn, capabilities: createReferenceSeatCandidateDetector() },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].state, CANDIDATE_STATE.UNKNOWN);
  assert.equal(out[0].observable, false);
});

test("collectSeatCandidates: execFn이 던지면(poisoned) 삼켜서 null -- 실 orca spawn을 강제하지 않는다", () => {
  const out = collectSeatCandidates({ worktreePath: "C:/wt/x" }, { execFn: poisonedExecFn });
  assert.equal(out, null);
});
