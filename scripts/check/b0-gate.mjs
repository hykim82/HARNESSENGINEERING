import { readFileSync } from "node:fs";

// HYK-159: mechanizes the B0 사전 설계비평 loop's format/existence/order
// contract (design report §3.3, relay-terminal-setup.md §2's B0 트리거 및
// 교환 형식) -- a non-trivial ORCH design drop must be marked either
// "target" (needs a PM critique before a CODER drop) or "non-target" (a
// one-line reason is enough), and a target drop's three exchange blocks
// (ORCH request -> PM response -> ORCH consumption) must share one b0_id in
// order. Same pattern as pm-snapshot-gate.mjs: checks presence/shape only,
// never content quality (see honesty note on checkB0Contract below).

const B0_REQUEST_HEADER_RE = /^##\s*B0\s*사전\s*비평\s*요청\s*$/m;
const B0_RESPONSE_HEADER_RE = /^##\s*B0\s*사전\s*비평\s*답변\s*$/m;
// The 비대상 marker is deliberately a one-liner (relay-terminal-setup.md
// §2: "비대상은 한 줄 기록만") -- no block, no b0_id, just a 사유 field.
const B0_NONTARGET_LINE_RE =
  /^\s*B0\s*:\s*비대상\s*\(\s*사유\s*:\s*(.+?)\s*\)\s*$/m;
// The consumption record normally lives in a Linear issue comment
// (relay-terminal-setup.md §2), a channel this gate cannot read. This gate
// therefore requires ORCH to mirror that comment into a local HTML-comment
// block (same convention as reject-streak.mjs's envelope) wherever the
// caller points `consumptionText` at -- see the honesty note below for what
// that implies today.
const CONSUMPTION_BLOCK_RE = /<!--\s*b0-consumption([\s\S]*?)-->/i;
// HYK-160-coder-2 (review-1 결함 2, 처방 b): relay-terminal-setup.md §2's
// 정본 is the Linear issue comment itself -- a local `<!-- b0-consumption
// -->` mirror alone would create a second, unsynchronized ledger with
// nothing tying it back to that comment. Requiring a `linear_comment`
// pointer inside the mirror (a Linear web URL or a bare comment-id form)
// keeps the local mirror anchored to the real audit trail; format only,
// never fetched or verified against Linear itself (see honesty note above).
const LINEAR_COMMENT_FORMAT_RE =
  /^(https:\/\/linear\.app\/\S+|comment:[A-Za-z0-9_-]+)$/;

// HYK-160-coder-3 (review-2 조건 2·3): the fixed reason codes this module
// ever emits via `checkB0Contract`, and the CLI flags its `--drop`/
// `--response`/`--consumption` entry point recognizes -- exported purely so
// the doc-code contract test below can assert docs/enforcement-v1.md §H's
// prose (command line, reason list) against the real thing instead of
// trusting a human to keep the two in sync by hand. No logic change; these
// are the same literal strings `checkResponseBlock`/`checkConsumptionBlock`/
// `checkTargetContract`/`checkB0Contract` already embed in their reason text.
export const B0_REASON_CODES = [
  "B0_CLASSIFICATION_REQUIRED",
  "B0_EVIDENCE_REQUIRED",
  "B0_ID_MISMATCH",
  "B0_CONSUMPTION_EVIDENCE_REQUIRED",
];
export const B0_GATE_CLI_FLAGS = ["--drop", "--response", "--consumption"];

function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
}

// Slices out one `## <header>` section's body (everything up to the next
// `## ` heading or end of text) -- good enough for the flat two-block shape
// the B0 exchange templates use, without pulling in a full markdown parser.
function extractSectionBody(text, headerRe) {
  const t = normalizeNewlines(text);
  const m = headerRe.exec(t);
  if (!m) return null;
  const rest = t.slice(m.index + m[0].length);
  const nextHeaderIdx = rest.search(/^##\s/m);
  return nextHeaderIdx === -1 ? rest : rest.slice(0, nextHeaderIdx);
}

function fieldValue(body, name) {
  const re = new RegExp(`^${name}\\s*:\\s*(.*?)\\s*$`, "m");
  const m = (body ?? "").match(re);
  return m ? m[1] : null;
}

// Reads a drop's B0 표기 (classification marker) without judging anything
// else -- either a "## B0 사전 비평 요청" block (target) or a "B0: 비대상
// (사유: ...)" one-liner (non-target). Neither present -> null (caller
// turns this into B0_CLASSIFICATION_REQUIRED).
export function classifyB0(dropText) {
  const text = normalizeNewlines(dropText);
  if (B0_REQUEST_HEADER_RE.test(text)) return { classification: "target" };
  const nonTargetMatch = text.match(B0_NONTARGET_LINE_RE);
  if (nonTargetMatch)
    return {
      classification: "non-target",
      reasonNote: nonTargetMatch[1].trim(),
    };
  return { classification: null };
}

// G-<HYK-159>: the full contract check. `dropText` is the ORCH-authored
// drop being gated (where the classification marker and, for a target
// drop, the request block live); `responseText`/`consumptionText` are the
// PM response file and the local consumption-record mirror respectively --
// both optional (omit for a non-target drop, since neither is required).
//
// Honesty (S4, design §3.3): this verifies existence and b0_id linkage
// only. It never judges whether the PM critique is any good, whether ORCH's
// adoption decision was the right call, or whether a "비대상" self-judgment
// was honest -- a 비대상 fixture is only checked for a non-empty 사유 field,
// never for whether that reason is actually sound (design's explicit
// "남용을 자동 정상으로 주장 금지"). The consumption record's `linear_comment`
// pointer (HYK-160-coder-2, review-1 결함 2) is checked for presence/format
// only -- this gate never fetches Linear, so it cannot and does not verify
// the comment actually exists or says what the local mirror claims it says.

// Checks the PM response block against the already-confirmed requestId --
// extracted from checkB0Contract (HYK-160 quality-check: keeps
// checkB0Contract's own complexity under the repo's ESLint ceiling; pure
// refactor, same BLOCK/ok:true shape as before).
function checkResponseBlock(responseText, requestId) {
  const responseBody = extractSectionBody(responseText, B0_RESPONSE_HEADER_RE);
  if (!responseBody) {
    return {
      ok: false,
      reason: `b0-gate: B0_EVIDENCE_REQUIRED -- no 'B0 사전 비평 답변' block found (expected b0_id=${requestId})`,
    };
  }
  const responseId = fieldValue(responseBody, "b0_id");
  if (!responseId) {
    return {
      ok: false,
      reason: "b0-gate: B0_EVIDENCE_REQUIRED -- response block missing b0_id",
    };
  }
  if (responseId !== requestId) {
    return {
      ok: false,
      reason: `b0-gate: B0_ID_MISMATCH -- request b0_id='${requestId}' but response b0_id='${responseId}'`,
    };
  }
  return { ok: true };
}

// Checks the ORCH consumption record against the already-confirmed
// requestId -- same extraction rationale as checkResponseBlock.
function checkConsumptionBlock(consumptionText, requestId) {
  const consumptionMatch =
    normalizeNewlines(consumptionText).match(CONSUMPTION_BLOCK_RE);
  if (!consumptionMatch) {
    return {
      ok: false,
      reason: `b0-gate: B0_EVIDENCE_REQUIRED -- no consumption record found (expected b0_id=${requestId})`,
    };
  }
  const consumptionBody = consumptionMatch[1];
  const consumptionId = fieldValue(consumptionBody, "b0_id");
  if (!consumptionId) {
    return {
      ok: false,
      reason:
        "b0-gate: B0_EVIDENCE_REQUIRED -- consumption record missing b0_id",
    };
  }
  if (consumptionId !== requestId) {
    return {
      ok: false,
      reason: `b0-gate: B0_ID_MISMATCH -- request b0_id='${requestId}' but consumption b0_id='${consumptionId}'`,
    };
  }
  if (!fieldValue(consumptionBody, "결론")) {
    return {
      ok: false,
      reason:
        "b0-gate: B0_EVIDENCE_REQUIRED -- consumption record missing 결론 field",
    };
  }
  const linearComment = fieldValue(consumptionBody, "linear_comment");
  if (!linearComment || !LINEAR_COMMENT_FORMAT_RE.test(linearComment)) {
    return {
      ok: false,
      reason:
        "b0-gate: B0_CONSUMPTION_EVIDENCE_REQUIRED -- consumption record missing/malformed linear_comment (need a https://linear.app/... URL or 'comment:<id>')",
    };
  }
  return { ok: true };
}

// target-classification contract: request/response/consumption must all
// exist and share one b0_id, in order. Extracted from checkB0Contract for
// the same quality-check reason as the two helpers above.
function checkTargetContract(dropText, responseText, consumptionText) {
  const requestBody = extractSectionBody(dropText, B0_REQUEST_HEADER_RE);
  const requestId = fieldValue(requestBody, "b0_id");
  if (!requestId) {
    return {
      status: "BLOCK",
      ok: false,
      reason: "b0-gate: B0_EVIDENCE_REQUIRED -- request block missing b0_id",
    };
  }

  const response = checkResponseBlock(responseText, requestId);
  if (!response.ok)
    return { status: "BLOCK", ok: false, reason: response.reason };

  const consumption = checkConsumptionBlock(consumptionText, requestId);
  if (!consumption.ok)
    return { status: "BLOCK", ok: false, reason: consumption.reason };

  return {
    status: "PASS",
    ok: true,
    reason: `b0-gate: contract complete (b0_id=${requestId})`,
  };
}

export function checkB0Contract({
  dropText,
  responseText,
  consumptionText,
} = {}) {
  const cls = classifyB0(dropText);

  if (!cls.classification) {
    return {
      status: "BLOCK",
      ok: false,
      reason:
        "b0-gate: B0_CLASSIFICATION_REQUIRED -- drop has neither a 'B0 사전 비평 요청' block nor a 'B0: 비대상 (사유: ...)' marker",
    };
  }

  if (cls.classification === "non-target") {
    if (!cls.reasonNote) {
      return {
        status: "BLOCK",
        ok: false,
        reason:
          "b0-gate: B0_CLASSIFICATION_REQUIRED -- 'B0: 비대상' marker present but its 사유 field is empty",
      };
    }
    return {
      status: "PASS",
      ok: true,
      reason: `b0-gate: 비대상 (사유=${cls.reasonNote}) -- no further evidence required`,
    };
  }

  return checkTargetContract(dropText, responseText, consumptionText);
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--drop") out.drop = args[++i];
    else if (args[i] === "--response") out.response = args[++i];
    else if (args[i] === "--consumption") out.consumption = args[++i];
  }
  return out;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/b0-gate.mjs");
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.drop) {
    console.error(
      "usage: node b0-gate.mjs --drop <path> [--response <path>] [--consumption <path>]",
    );
    process.exit(1);
  }

  let dropText;
  try {
    dropText = readFileSync(args.drop, "utf8");
  } catch (err) {
    console.error(`b0-gate: failed to read drop file: ${err.message}`);
    process.exit(1);
  }
  const responseText = args.response
    ? (() => {
        try {
          return readFileSync(args.response, "utf8");
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const consumptionText = args.consumption
    ? (() => {
        try {
          return readFileSync(args.consumption, "utf8");
        } catch {
          return undefined;
        }
      })()
    : undefined;

  const result = checkB0Contract({ dropText, responseText, consumptionText });
  if (result.status === "BLOCK") {
    console.error(result.reason);
    process.exit(2);
  }
  console.log(result.reason);
  process.exit(0);
}
