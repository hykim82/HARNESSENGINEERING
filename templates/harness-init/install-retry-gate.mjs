// HYK-464 H7c (coder-task.md §2 ⓐ, 책임자 판정 §3 원문): ONE shared
// retry-gate function both install-net-closure.test.mjs and
// install-g1-adapter-list.test.mjs's "(b) real installer ... 0 failures"
// cell call through for their own child `node --test` spawnSync -- a
// single standalone retry opens ONLY on a first-attempt ETIMEDOUT AND at
// least one of three on-the-spot signals: ⑴ free memory below threshold
// (H7b's original signal, unchanged) ⑵ the runner's own concurrency
// (HARNESS_TEST_CONCURRENCY, the exact literal isolated-suite-runner.mjs
// stamps into every sibling TEST_DIRS file's process.env under a real
// full-runner invocation) ⑶ system-wide node process count. 검토 1R
// (REVIEW-r2.md §7 P2-1) found free-memory alone misses the case where the
// real bottleneck is CPU/process-creation contention, not memory pressure
// (짝 시험 1R/2R 실측: concurrency 12 전건 러너에서 두 칸 모두 4/4 빨강이면서
// H7b의 free-only 게이트가 한 번도 안 열렸다, load-sensitive 0건). Extracted
// into its own file (product_scope §2ⓐ -- "두 칸이 같은 게이트 함수를 쓰게")
// so a future edit to the gate's own decision cannot silently drift between
// the two call sites (하나는 신호 추가, 다른 하나는 안 추가).
//
// Each test file still owns its OWN first-attempt/retry spawnSync CALL
// SHAPE (CLI args, cwd, env-building) -- those genuinely differ between the
// two files (one runs a single named installed file, the other runs two
// fixed names against a real-install target) and are out of this module's
// scope; this module owns only the cross-cutting GATE DECISION and the
// generic "run once, maybe retry once" control flow (attemptWithRetryGate).
import { countNodeProcesses } from "../../scripts/check/node-concurrency-sampler.mjs";
import { freemem } from "node:os";

// Signal ⑴ threshold -- unchanged from H7b (3,072 MB == 3.0GB), the same
// "저메모리" line worker-dispatch-rule's memory_rule already treats as
// contested ambient memory (coder-task.md 28행).
export const LOAD_RETRY_FREE_THRESHOLD_MB = 3072;

// Signal ⑵ threshold -- 4. Rationale (책임자 판정 §3 원문이 "러너 동시
// 실행 폭(HARNESS_TEST_CONCURRENCY ...) 4 이상"을 상수로 지정): this
// repo's own §12-1 temporary amendment sets `--concurrency 2` as the
// throttled LOW-memory floor, while a normal full-speed run on this
// 24-core machine resolves to floor(24/2) = 12 (isolated-suite-runner.mjs's
// resolveConcurrency). 4 sits strictly above the throttled floor (2) and
// well below a full-speed run (12), so it fires whenever the runner is
// genuinely pushing more than "a couple of files at a time" -- never on a
// solo/standalone invocation (no HARNESS_TEST_CONCURRENCY at all, see
// measureConcurrencySignal below).
export const RETRY_GATE_CONCURRENCY_THRESHOLD = 4;

// Signal ⑶ threshold -- 8. Rationale: at `--concurrency 12`, each
// isolated-suite-runner worker is its own `node --test` child (parent
// runner + up to 12 worker processes), and this round's own cells spawn
// ONE MORE nested `node --test` child from inside a worker -- so a
// healthy, loaded full-speed run already carries well more than a
// dozen-ish node processes system-wide. 8 is picked below that "all 12
// workers busy" ceiling but comfortably above what a single
// solo/standalone invocation (this test runner + its own one direct
// child == 2 processes) would ever show, so it reads as "the machine is
// genuinely carrying multiple concurrent node trees right now".
export const RETRY_GATE_NODE_COUNT_THRESHOLD = 8;

// The retry's own ceiling -- H7b's already-existing, already-reasoned
// 180,000ms (실측 최대 완주값의 1.29배 이상, install-net-closure.test.mjs's
// own header). Shared so neither call site invents a second number
// (⛔무조건 상향 금지 · ⛔180초 시한 변경 0, coder-task.md product_scope).
export const UNDER_FULL_RUNNER_TIMEOUT_MS = 180000;

// isolated-suite-runner.mjs's NESTED_CONCURRENCY_ENV_VAR literal,
// duplicated (not imported) by this repo's own consumer/producer
// decoupling convention (install-net-closure.test.mjs's own header already
// states the same reasoning for the same literal).
const HARNESS_TEST_CONCURRENCY_ENV_VAR = "HARNESS_TEST_CONCURRENCY";

// Node sets result.error.code === "ETIMEDOUT" when spawnSync's own
// `timeout` option kills the child. Any other spawn failure (ENOENT etc.)
// is a real defect unrelated to load and must never retry.
export function isSpawnTimeout(result) {
  return result.error?.code === "ETIMEDOUT";
}

// Signal ⑴: free memory, measured ON THE SPOT (callers must call this only
// AFTER a first-attempt ETIMEDOUT is already in hand -- a pre-call
// measurement would describe ambient conditions before the slow child ran,
// not whether load was actually present at the moment it timed out, the
// exact P2-3 defect H7b-r4 fixed). Measurement failure (throwing/
// non-finite) reports measured:false, never loaded:true -- a tool failure
// must never be read as evidence of load.
export function measureFreeMemSignal(freememImpl = freemem) {
  let freeNowMB;
  try {
    freeNowMB = Math.round(freememImpl() / (1024 * 1024));
  } catch {
    return { signal: "free", measured: false };
  }
  if (!Number.isFinite(freeNowMB)) return { signal: "free", measured: false };
  return {
    signal: "free",
    measured: true,
    value: freeNowMB,
    thresholdDesc: `<${LOAD_RETRY_FREE_THRESHOLD_MB}`,
    loaded: freeNowMB < LOAD_RETRY_FREE_THRESHOLD_MB,
  };
}

// Signal ⑵: runner concurrency, read from the SAME env var
// isolated-suite-runner.mjs stamps into every TEST_DIRS sibling's
// process.env under a real full-runner invocation. A missing/non-integer/
// non-positive value is measured:false (never loaded:true) -- "no signal"
// must never forge load, mirroring measureFreeMemSignal's own fail-closed
// rule. `env` is a required, explicit argument (never a hidden default)
// so callers always state which environment they mean -- the REAL process
// environment of the test runner itself, not an isolated child env object
// built for a spawned subprocess.
export function measureConcurrencySignal(env) {
  const raw = (env ?? {})[HARNESS_TEST_CONCURRENCY_ENV_VAR];
  if (raw == null || raw === "")
    return { signal: "concurrency", measured: false };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { signal: "concurrency", measured: false };
  }
  return {
    signal: "concurrency",
    measured: true,
    value: n,
    thresholdDesc: `>=${RETRY_GATE_CONCURRENCY_THRESHOLD}`,
    loaded: n >= RETRY_GATE_CONCURRENCY_THRESHOLD,
  };
}

// Signal ⑶: system-wide node process count, ON THE SPOT.
// countNodeProcessesImpl (node-concurrency-sampler.mjs's own
// countNodeProcesses, HYK-477) already returns null on measurement
// failure (its own fail-closed contract, never throws) -- that null is
// read as measured:false here too.
export function measureNodeCountSignal(
  countNodeProcessesImpl = countNodeProcesses,
) {
  const n = countNodeProcessesImpl();
  if (!Number.isInteger(n)) return { signal: "nodeCount", measured: false };
  return {
    signal: "nodeCount",
    measured: true,
    value: n,
    thresholdDesc: `>=${RETRY_GATE_NODE_COUNT_THRESHOLD}`,
    loaded: n >= RETRY_GATE_NODE_COUNT_THRESHOLD,
  };
}

// Evaluates all three signals ON THE SPOT (callers: only after a first
// ETIMEDOUT is already in hand) and decides whether the retry gate opens.
// Opens on ANY ONE signal reading loaded:true (OR, not AND -- 책임자 판정
// §3 원문 "다음 중 하나"). Returns every signal's own reading (for the
// diagnostic line) plus `opened` and the list of signal names that fired.
export function evaluateRetryGate({
  freemem: freememImpl = freemem,
  env = process.env,
  countNodeProcesses: countNodeProcessesImpl = countNodeProcesses,
} = {}) {
  const signals = [
    measureFreeMemSignal(freememImpl),
    measureConcurrencySignal(env),
    measureNodeCountSignal(countNodeProcessesImpl),
  ];
  const openedBy = signals
    .filter((s) => s.measured && s.loaded)
    .map((s) => s.signal);
  return { signals, opened: openedBy.length > 0, openedBy };
}

// Builds the one-line diagnostic string (§2ⓑ) naming exactly which
// signal(s) opened the gate (or that none did), their measured values and
// thresholds, and the retry's own outcome. Callers pass this string to
// `t.diagnostic(...)` -- see each test file's own call site for WHEN
// (reachability matters: H7b 검토 1R P2-2 found a post-loop-only
// diagnostic unreachable whenever the hard assertion on an unretried
// ETIMEDOUT throws first; both call sites in this round emit this line
// BEFORE that assertion, never after a loop that might never finish).
export function formatRetryGateDiagnostic({ rel, gate, retried }) {
  const signalDesc = gate.signals
    .map((s) =>
      s.measured
        ? `${s.signal}=${s.value}(기준${s.thresholdDesc})${s.loaded ? "★" : ""}`
        : `${s.signal}=측정불가`,
    )
    .join(", ");
  const outcome = gate.opened
    ? retried
      ? `연 신호=[${gate.openedBy.join(",")}] -> 단독 재시도 1회 성공`
      : `연 신호=[${gate.openedBy.join(",")}] -> 재시도도 ETIMEDOUT(진짜 멈춤, RED 유지)`
    : "연 신호 없음 -> 재시도 0(진짜 멈춤으로 판정, RED)";
  return `retry-gate(${rel}): ${signalDesc} | ${outcome}`;
}

// The shared control flow: run the first attempt exactly once
// (unconditionally); if it is not a spawn timeout, return it as-is; if it
// IS a timeout, evaluate the gate ON THE SPOT; if no signal opened it,
// return the original ETIMEDOUT result (⛔첫 ETIMEDOUT에 무신호 재시도
// 금지); otherwise run the retry EXACTLY ONCE and return ITS result,
// whatever it is -- a second ETIMEDOUT on the retry is never swallowed
// (⛔시한 초과를 통과로 삼키기 금지): the caller's own hard assertion on
// `result.error` still sees ETIMEDOUT and still goes RED.
//
// `runFirstAttempt`/`runRetry` are zero-arg thunks: each caller closes
// over its own spawnSync/env/path specifics (the two test files' call
// shapes differ) -- this function owns only the retry DECISION, never the
// spawn call shape itself.
export function attemptWithRetryGate(
  runFirstAttempt,
  runRetry,
  { freemem, env, countNodeProcesses } = {},
) {
  const firstResult = runFirstAttempt();
  if (!(firstResult.error !== undefined && isSpawnTimeout(firstResult))) {
    return { result: firstResult, gate: null, retried: false };
  }
  const gate = evaluateRetryGate({ freemem, env, countNodeProcesses });
  if (!gate.opened) {
    return { result: firstResult, gate, retried: false };
  }
  const retryResult = runRetry();
  const retried = retryResult.error === undefined;
  return { result: retryResult, gate, retried };
}
