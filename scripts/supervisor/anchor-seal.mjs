// HYK-255-s1-anchor-seal-1 (S1 봉인 일지 · 판정 #20261119-1520 B · 설계 C3 (라) S1 행)
//
// 예약 감시(watch-run) 회차가 ㄱ «보조 원천»(통역 보내는함 · 받는함 · reject-streak
// 원장+체인 · 북극성 좌표 · 통역 세션 typed 턴)을 읽어 유형별 머클 뿌리로 접고,
// «뿌리가 바뀐 회차에만» 봉인 줄 1개를 전용 git 디렉터리에서 커밋해 원격
// `refs/heads/anchor-seal` 가지에 non-force push 한다. 올라가는 것은 유형별 뿌리 ·
// 시각 · 상태 낱말(`none` = 원천 없음 · `read_error` = 읽기 실패)뿐이다 -- 파일
// 이름 · 본문 · 경로 · sessionId 는 0.
//
// ⛔기본 꺼짐: watch-run 에 opt-in 인자(`--anchor-seal-remote`)가 없으면 이 모듈은
// 아예 호출되지 않고 watch.log 줄은 base 와 바이트 같다. 단계가 실패해도 감시
// 회차는 계속 돈다(watch-run 의 runAnchorSealStep 이 예외를 FAILED 구간으로 바꾼다).
//
// ─── 정규화 규칙 (v1 · ⛔바꾸면 지난 봉인과 비교가 깨진다 -- 버전 문자열부터 바꿔라) ───
//  잎(leaf)  = sha256( "hyk255-anchor-seal/v1" 0x00 유형키 0x00 바이트길이(10진 ASCII)
//                      0x00 바이트 )
//  바이트    = «파일 전체 바이트»(보내는함 · 받는함 · 원장 · 체인 · 북극성 파일) 또는
//              «정규 JSON 한 줄 {"sessionId":<UUID>,"ts":<타임스탬프>,"body":<64hex>}»
//              (세션 typed 턴 · v1 2R). body = 그 세션 jsonl 줄의 «원문 바이트» 의 sha256(hex)
//              -- 줄 끝 `\n` 앞까지가 해시 입력이다(`\r` 은 줄 바이트로 센다 · 마지막 줄에
//              개행이 없어도 같다 · 디코드 뒤 문자열이 아니라 바이트). ⛔원문 자체는 잎 ·
//              상태 파일 · 원격 · 로그 어디에도 넣지 않는다 -- 본문 해시만 잎에 들어간다.
//  ⛔시각 · 건수 · 이름처럼 «짧고 추측 가능한 값 하나만» 으로 잎을 만들지 않는다 --
//    잎 입력에는 파일 전체 본문 또는 UUID(122비트 이상 무작위)가 항상 들어 있다.
//    (본문이 짧고 뻔한 파일은 이 보장이 약하다 -- 정직 한계 8.)
//  ⛔본문 없는 잎(있었다는 사실만 · 열쇠 sessionId·ts 만)은 봉인 등급으로 세지 않는다 --
//    typed 턴 잎은 반드시 본문 해시를 포함한다(뺀 변이는 시험이 빨강으로 잡는다).
//  유형 뿌리 = 잎(32바이트)을 «바이트 순» 정렬 -> 두 개씩 sha256( 0x01 ‖ 왼 ‖ 오 ) ->
//              홀수 개면 마지막 하나를 그대로 위로 올림 -> 하나 남을 때까지 반복.
//  잎 0개    = 뿌리 없음 -> 낱말 `none`(빈 뿌리 · 0 으로 접지 않는다).
//  유형 키   = g1 g2 g3 g6 g7. (ㄱ-4 는 서버 원천(GitHub)이라 봉인 대상 «밖».)
//              ㄱ-2 와 ㄱ-6 은 같은 원장을 읽지만 유형 키가 잎에 들어가 뿌리가 다르다.
//  봉인 줄   = {"v":1,"at":<ISO 시각>,"roots":{"g1":<64hex|none|read_error>,...}}
//              한 줄 JSON · 파일 `seal.jsonl` 에 덧붙이기만 · 커밋 메시지 =
//              "anchor-seal <ISO 시각>" 고정 문구.
//
// ─── 유형별 원천 (설계 C3 (가) · (라) S1 행 -- 이 목록 밖으로 넓히지 않는다) ───
//  g1 = 보내는함 `*.md` 중 이름에 «게이트1»(partial-count-report.mjs:2363 같은 정의)
//       + 세션 typed 턴
//  g2 = reject-streak.json + reject-streak-chain.json 전체 바이트
//  g3 = 북극성 좌표 파일 전체 바이트(경로는 인자 · 관제실 경로를 코드에 박지 않는다)
//  g6 = g2 와 같은 원천(유형 키만 g6)
//  g7 = 보내는함 `*.md` 중 이름에 «판정-HHMM»/«상신HHMM» 짝 토큰(partial-count-
//       report.mjs:1747 같은 정의) + 받는함 `*.md` 중 이름에 «상신» + 세션 typed 턴
//  (세션 typed 턴 = 세션 jsonl 줄 중 `promptSource === "typed"` · 접기 = «잎 바이트까지
//   같은» 줄만 한 잎(이어하기가 줄을 통째로 복제한 경우) -- 열쇠 sessionId·ts 가 같아도
//   본문이 다르면 잎 둘 · 세션 폴더는 인자로 받는다 -- 인터프리터 세션 폴더만 가리켜야 한다.)
//
// ─── 상태 낱말 규칙 ───
//  원천 없음(경로 미지정 · ENOENT · 잎 0개) -> `none`.
//  읽기 실패(ENOENT 외 오류 · 깨진 typed 줄 · 읽던 파일 사라짐) -> `read_error`.
//  한 유형 안에서 하나라도 read_error 면 그 유형은 read_error -- 읽힌 일부로 뿌리를
//  만들어 «완전한 것처럼» 봉인하지 않는다. none / read_error 는 0 이 아니다.
//
// ─── 상태 파일 건강 칸 (2R · 판정 2121) ───
//  anchor-seal-state.json 에 칸 셋: failStreak(연속 실패 수) · lastFailureAt(마지막 실패
//  시각) · lastSuccessAt(마지막 성공 시각). 단계가 예외로 끝난 회차마다 failStreak +1 ·
//  예외 없이 끝난 회차(sealed · unchanged · cap_reached)는 failStreak = 0 + lastSuccessAt
//  (lastFailureAt 은 남는다 · REWRITE_SUSPECT 회차는 어느 쪽도 안 건드린다). watch.log 의
//  `anchor-seal: FAILED reason=... consecutive=N` 의 N 이 같은 값이다(상태 파일을 못 쓴
//  회차는 unknown). 원격에는 이 칸들이 가지 않는다 -- 원격은 뿌리뿐이다.
//
// ─── 봉인 «뒤» 변조는 어떻게 드러나는가 (2R · 사람 손 · 자동 아님) ───
//  봉인 뒤에 typed 턴 본문(또는 보조 원천 파일)을 한 바이트라도 고치면, 같은 원천에서 다시
//  계산한 뿌리가 봉인 줄의 뿌리와 달라진다(본문 해시가 잎에 들어 있으므로). 원격에는
//  뿌리만 있고 본문은 없으니, 대조는 «원천을 가진 쪽에서 뿌리를 다시 계산해 봉인 줄과
//  맞대는 것» 이다. 아래 한 줄이 그 대조다(원격 복제본 루트에서 `git fetch origin
//  anchor-seal` 뒤 · 유형별 match/mismatch/missing 을 봉인 줄마다 찍는다):
//   git show origin/anchor-seal:seal.jsonl | node --input-type=module -e "import{readFileSync as r}from'node:fs';import{parseSealJournal as p,computeAnchorRoots as c,compareSealToRoots as m}from'./scripts/supervisor/anchor-seal.mjs';const a=process.argv.slice(1);const k=c({outboxDir:a[0],inboxDir:a[1],ledgerDir:a[2],sessionsDirs:[a[3]],northStarFile:a[4]}).roots;for(const s of p(r(0,'utf8')).seals)console.log(s.at,JSON.stringify(m(s.roots,k)))" <보내는함> <받는함> <원장폴더> <세션폴더> <북극성파일>
//  읽는 법: 가장 최근 봉인 줄이 mismatch 면 «그 뒤 원천이 바뀌었다» 는 신호다 -- 정당한
//  새 기록인지 사후 변조인지는 이 대조가 가르지 못한다(사람이 본다 · 감시 회차가 바뀐
//  내용을 새 줄로 봉인하면 옛 줄만 mismatch 로 남는다). 이 대조는 아직 «사람 손» 이다 --
//  자동 대조는 S2 후보로 등재만 했고 만들지 않았다.
//
// ⛔⭐정직 한계 (판정 1520 B 조건 7 -- 줄이지 마라):
//  1. 봉인은 «사후 변조» 만 막는다. ORCH 가 처음부터 꾸민 내용을 봉인하는 것은 못 막는다.
//  2. 봉인 push 자격(봇)도 ORCH 손에 있다. 가지 보호(한용 설정 · 강제 push · 삭제 금지)
//     전에는 봉인 강도는 «약» 이다 -- 봇이 가지를 다시 쓸 수 있다. REWRITE_SUSPECT 검출은
//     «쓰는 쪽» 이 아는 만큼만 잡는다(상태 파일과 전용 git 디렉터리를 같이 잃으면 못 잡는다).
//  3. push 시각의 서버 증거는 git 객체 안에 없다 -- 커밋 시각(author/committer date)은
//     로컬 자기 신고다. 서버 시각 대조는 «읽는 쪽»(보고서 S2)의 몫이다.
//  4. 같은 뿌리를 여러 번 봉인하면 «가장 이른 줄» 이 정본이다(findCanonicalSeal) --
//     `at` 은 자기 신고라 순서 기준이 아니고, 줄 순서(= 커밋 순서)가 기준이다.
//  5. 하루 push 상한(24)에 닿으면 그 날 남은 변경은 봉인되지 않는다 -- 미봉인 회차 수를
//     상태 파일 · watch.log 에 남긴다(0 으로 접지 않는다). 중간 상태는 영영 봉인되지 않는다.
//  6. 이 단계는 «독립 분자» 에 합산되지 않는다(판정 1520 A) -- 1-C 자격 숫자는 안 바뀐다.
//  7. 회차마다 원천을 «전부» 다시 읽고 해시한다(받는함 수천 건) -- 읽기 부하는 선형이다.
//  8. 본문이 짧고 추측 가능한 파일은 잎 해시가 사전 대입으로 풀릴 수 있다.
//  9. typed 턴의 본문 해시는 «그 줄 바이트» 만 굳힌다 -- 줄이 세션 파일에서 통째로 지워지면
//     (잎이 줄어들어) 뿌리는 바뀌지만, 그 줄이 «원래 어떤 내용이었는지» 는 원격에 없다.
//     봉인 뒤 변조 대조(위 한 줄)는 아직 사람 손이고, 봉인 자격은 ORCH 손에 있다(한계 2).
//
// Node 20 호환 -- ESM 표준 API 만 사용. 외부 의존 0. 사용자 절대 경로 · 실제 원격 기본값 0.
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const ANCHOR_SEAL_VERSION = "hyk255-anchor-seal/v1";
export const ANCHOR_TYPE_KEYS = Object.freeze(["g1", "g2", "g3", "g6", "g7"]);
export const DAILY_PUSH_CAP = 24;
export const SEAL_BRANCH = "anchor-seal";
export const SEAL_FILE = "seal.jsonl";
export const STATE_FILE = "anchor-seal-state.json";
const SEAL_REF = `refs/heads/${SEAL_BRANCH}`;
const REMOTE_TIP_REF = "refs/seal/remote-tip";

// partial-count-report.mjs 의 «같은 정의» (시험이 원본 줄과 대조한다).
export const GATE1_OUTBOX_NAME_RE = /게이트1(?!\d)/;
export const GATE7_PAIR_TOKEN_RE =
  /(?<![\p{L}\p{N}])(?:판정-|상신)(\d{4})(?!\d)/gu;
const GATE7_PAIR_TOKEN_TEST = new RegExp(GATE7_PAIR_TOKEN_RE.source, "u");

// ───────────────────────── 해시 · 머클 ─────────────────────────

export function leafHash(typeKey, bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from(ANCHOR_SEAL_VERSION, "utf8"),
        Buffer.from([0]),
        Buffer.from(String(typeKey), "utf8"),
        Buffer.from([0]),
        Buffer.from(String(body.length), "utf8"),
        Buffer.from([0]),
        body,
      ]),
    )
    .digest("hex");
}

export function merkleRoot(hexLeaves) {
  if (!Array.isArray(hexLeaves) || hexLeaves.length === 0) return null;
  let level = hexLeaves.map((h) => Buffer.from(h, "hex")).sort(Buffer.compare);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
      } else {
        next.push(
          createHash("sha256")
            .update(Buffer.concat([Buffer.from([1]), level[i], level[i + 1]]))
            .digest(),
        );
      }
    }
    level = next;
  }
  return level[0].toString("hex");
}

// ───────────────────────── 원천 읽기 ─────────────────────────

function defaultSrcIo() {
  return { readFileFn: readFileSync, readdirFn: readdirSync };
}

function errCode(err) {
  return err && err.code ? String(err.code) : "ERR";
}

// 디렉터리 목록: 미지정 · ENOENT -> none, 그 밖 오류 -> read_error.
function listNames(dir, io, memo) {
  if (!dir) return { status: "none" };
  const key = `L\u0000${dir}`;
  if (memo.has(key)) return memo.get(key);
  let out;
  try {
    out = { status: "ok", names: [...io.readdirFn(dir)].map(String).sort() };
  } catch (err) {
    out =
      errCode(err) === "ENOENT"
        ? { status: "none" }
        : { status: "read_error", reason: errCode(err) };
  }
  memo.set(key, out);
  return out;
}

function readBytes(file, io, memo) {
  const key = `F\u0000${file}`;
  if (memo.has(key)) return memo.get(key);
  let out;
  try {
    out = { status: "ok", bytes: Buffer.from(io.readFileFn(file)) };
  } catch (err) {
    out =
      errCode(err) === "ENOENT"
        ? { status: "none" }
        : { status: "read_error", reason: errCode(err) };
  }
  memo.set(key, out);
  return out;
}

// 폴더 안 `.md` 파일 중 이름 조건에 맞는 것의 «전체 바이트» 목록.
function dirFileGroup({ dir, nameOk, ext }, io, memo) {
  const listing = listNames(dir, io, memo);
  if (listing.status !== "ok") return { status: listing.status, bytes: [] };
  const bytes = [];
  for (const name of listing.names) {
    if (!name.endsWith(ext) || !nameOk(name)) continue;
    const read = readBytes(path.join(dir, name), io, memo);
    if (read.status !== "ok") return { status: "read_error", bytes: [] };
    bytes.push(read.bytes);
  }
  return { status: "ok", bytes };
}

function singleFileGroup(file, io, memo) {
  if (!file) return { status: "none", bytes: [] };
  const read = readBytes(file, io, memo);
  if (read.status === "ok") return { status: "ok", bytes: [read.bytes] };
  return { status: read.status, bytes: [] };
}

// 세션 typed 턴 -> 잎 바이트 = 정규 JSON 한 줄 {sessionId, ts, body}. 접기 = «잎 바이트가
// 같은» 줄만 한 잎(이어하기가 줄을 통째로 복제한 경우) -- 열쇠(sessionId·ts)가 같아도
// 본문이 다르면 잎 둘이다(2R · 판정 2121).
function typedTurnGroup(sessionsDirs, io, memo) {
  const dirs = Array.isArray(sessionsDirs) ? sessionsDirs.filter(Boolean) : [];
  const seen = new Set();
  for (const dir of dirs) {
    const listing = listNames(dir, io, memo);
    if (listing.status === "read_error")
      return { status: "read_error", bytes: [] };
    if (listing.status !== "ok") continue;
    for (const name of listing.names) {
      if (!name.endsWith(".jsonl")) continue;
      const read = readBytes(path.join(dir, name), io, memo);
      if (read.status !== "ok") return { status: "read_error", bytes: [] };
      const leaves = typedTurnLeaves(read.bytes);
      if (leaves === null) return { status: "read_error", bytes: [] };
      for (const leaf of leaves) seen.add(leaf);
    }
  }
  return {
    status: "ok",
    bytes: [...seen].map((s) => Buffer.from(s, "utf8")),
  };
}

// 한 줄 -> 잎 문자열 | "" (typed 아님 · 건너뜀) | null (깨진 줄 -> read_error).
// body = 그 줄 «원문 바이트»(줄 끝 `\n` 앞까지 · `\r` 은 줄 바이트로 센다)의 sha256 hex.
function typedLeafOfLine(line) {
  let obj;
  try {
    obj = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || obj.promptSource !== "typed")
    return "";
  if (typeof obj.sessionId !== "string" || typeof obj.timestamp !== "string") {
    return null;
  }
  const body = createHash("sha256").update(line).digest("hex");
  return JSON.stringify({ sessionId: obj.sessionId, ts: obj.timestamp, body });
}

// 세션 jsonl «원문 바이트» -> typed 턴 잎 목록(줄 순서). 깨진 줄(promptSource 를 담은데
// JSON 이 아님 · 필드 없음)이 하나라도 있으면 null -> read_error. 줄은 바이트 0x0a 로만
// 자른다(디코드 뒤 문자열이 아니라 «원문 바이트» 로 해시하려는 것이다).
export function typedTurnLeaves(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const out = [];
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl;
    const line = buf.subarray(start, end);
    start = end + 1;
    if (!line.includes("promptSource")) continue;
    const leaf = typedLeafOfLine(line);
    if (leaf === null) return null;
    if (leaf !== "") out.push(leaf);
  }
  return out;
}

function foldGroups(typeKey, groups) {
  if (groups.some((g) => g.status === "read_error")) return "read_error";
  const leaves = groups.flatMap((g) =>
    g.bytes.map((b) => leafHash(typeKey, b)),
  );
  return merkleRoot(leaves) ?? "none";
}

// 유형별 뿌리 계산 -- 시험이 같은 원천으로 «다시 계산» 하는 정본 진입점.
export function computeAnchorRoots(sources = {}, srcIo = defaultSrcIo()) {
  const memo = new Map();
  const io = { ...defaultSrcIo(), ...srcIo };
  const { outboxDir, inboxDir, ledgerDir, sessionsDirs, northStarFile } =
    sources;
  const typed = typedTurnGroup(sessionsDirs, io, memo);
  const ledger = [
    singleFileGroup(
      ledgerDir && path.join(ledgerDir, "reject-streak.json"),
      io,
      memo,
    ),
    singleFileGroup(
      ledgerDir && path.join(ledgerDir, "reject-streak-chain.json"),
      io,
      memo,
    ),
  ];
  const roots = {
    g1: foldGroups("g1", [
      dirFileGroup(
        {
          dir: outboxDir,
          ext: ".md",
          nameOk: (n) => GATE1_OUTBOX_NAME_RE.test(n),
        },
        io,
        memo,
      ),
      typed,
    ]),
    g2: foldGroups("g2", ledger),
    g3: foldGroups("g3", [singleFileGroup(northStarFile, io, memo)]),
    g6: foldGroups("g6", ledger),
    g7: foldGroups("g7", [
      dirFileGroup(
        {
          dir: outboxDir,
          ext: ".md",
          nameOk: (n) => GATE7_PAIR_TOKEN_TEST.test(n),
        },
        io,
        memo,
      ),
      dirFileGroup(
        { dir: inboxDir, ext: ".md", nameOk: (n) => n.includes("상신") },
        io,
        memo,
      ),
      typed,
    ]),
  };
  return { roots };
}

// ───────────────────────── 읽기 쪽(정본 · 대조) ─────────────────────────

// 봉인 일지(seal.jsonl 본문) -> 줄 목록. 깨진 줄은 조용히 버리지 않고 센다.
export function parseSealJournal(text) {
  const seals = [];
  let malformed = 0;
  const lines = String(text ?? "").split("\n");
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    if (line === "") return;
    try {
      const obj = JSON.parse(line);
      const okShape =
        obj &&
        typeof obj === "object" &&
        typeof obj.at === "string" &&
        obj.roots &&
        typeof obj.roots === "object" &&
        !Array.isArray(obj.roots);
      if (!okShape) throw new Error("shape");
      seals.push({ index, v: obj.v, at: obj.at, roots: obj.roots });
    } catch {
      malformed += 1;
    }
  });
  return { seals, malformed };
}

// «처음 것이 정본» -- 같은 뿌리가 여러 줄이면 «줄 순서상 가장 이른 줄» (at 은 자기 신고).
export function findCanonicalSeal(journal, typeKey, root) {
  for (const seal of journal.seals) {
    if (seal.roots[typeKey] === root) return seal;
  }
  return null;
}

// 봉인 줄의 뿌리 vs 지금 원천에서 다시 계산한 뿌리: match | mismatch | missing.
export function compareSealToRoots(sealRoots, currentRoots) {
  const out = {};
  for (const key of ANCHOR_TYPE_KEYS) {
    if (!(key in sealRoots)) out[key] = "missing";
    else out[key] = sealRoots[key] === currentRoots[key] ? "match" : "mismatch";
  }
  return out;
}

// ───────────────────────── git · 자격 ─────────────────────────

export function redactSecret(text, secret) {
  const s = String(text ?? "");
  if (!secret) return s;
  return s.split(secret).join("***");
}

// 봇 push 방식(관제실 bot-push-pr.sh 와 같다): 토큰은 파일에서만 읽고 URL · argv 에
// 박지 않고 credential.helper 주입 + 환경변수로만 전달한다. force push 없음.
export function buildGitAuthArgs() {
  return [
    "-c",
    "credential.helper=",
    "-c",
    'credential.helper=!f(){ echo "username=$GIT_BOT_USER"; echo "password=$GIT_BOT_PAT"; };f',
  ];
}

export function buildGitAuthEnv(pat, botLogin) {
  return { GIT_BOT_PAT: pat, GIT_BOT_USER: botLogin };
}

const GIT_ENV_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

function cleanGitEnv(env) {
  const out = { ...env };
  for (const k of GIT_ENV_STRIP) delete out[k];
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

export function defaultGitFn(args, opts = {}) {
  const res = spawnSync("git", args, {
    cwd: opts.cwd,
    env: opts.env ?? cleanGitEnv(process.env),
    input: opts.input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ?? null,
  };
}

function defaultBotLogin() {
  const file = new URL("./github-bot-accounts.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const login = parsed?.bots?.[0]?.login;
  if (typeof login !== "string" || !login)
    throw new Error("bot_login_unavailable");
  return login;
}

const REMOTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function remoteNeedsCredentials(remote) {
  return REMOTE_URL_RE.test(remote) && !/^file:\/\//i.test(remote);
}

// ───────────────────────── 상태 ─────────────────────────

function parseState(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    // 깨진 상태 = «직전 봉인 없음». 원격 끝은 아래 어댑트 경로가 처리한다.
    return {};
  }
}

export function localDateKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function pruneDays(map, keep = 8) {
  const keys = Object.keys(map ?? {}).sort();
  const out = {};
  for (const k of keys.slice(-keep)) out[k] = map[k];
  return out;
}

function writeStateAtomic({ statePath, state, writeFn, renameFn, mkdirFn }) {
  mkdirFn(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  writeFn(tmp, `${JSON.stringify(state)}\n`, "utf8");
  renameFn(tmp, statePath);
}

// 상태 파일 «건강» 칸 셋(2R · 판정 2121): 연속 실패 수 · 마지막 실패 시각 · 마지막 성공 시각.
// 성공(예외 없이 sealed · unchanged · cap_reached 로 끝난 회차)이면 연속 실패 수는 0 으로
// 돌아가고 마지막 실패 시각은 «남는다». REWRITE_SUSPECT 회차는 어느 쪽도 건드리지 않는다.
function successHealth(state, ctx) {
  return {
    failStreak: 0,
    lastFailureAt: state.lastFailureAt ?? null,
    lastSuccessAt: new Date(ctx.now).toISOString(),
  };
}

function failureHealth(state, ctx) {
  const prev = Number(state.failStreak);
  return {
    failStreak: (Number.isFinite(prev) && prev > 0 ? prev : 0) + 1,
    lastFailureAt: new Date(ctx.now).toISOString(),
    lastSuccessAt: state.lastSuccessAt ?? null,
  };
}

function rootsEqual(a, b) {
  if (!a || !b) return false;
  return ANCHOR_TYPE_KEYS.every((k) => a[k] === b[k]);
}

function countWords(roots) {
  let none = 0;
  let readError = 0;
  for (const k of ANCHOR_TYPE_KEYS) {
    if (roots[k] === "none") none += 1;
    if (roots[k] === "read_error") readError += 1;
  }
  return { none, readError };
}

// ───────────────────────── 한 회차 ─────────────────────────

function firstLine(text, secret) {
  const line =
    String(text ?? "")
      .trim()
      .split(/\r?\n/)[0] ?? "";
  return redactSecret(line, secret).slice(0, 200);
}

function sameDir(a, b) {
  if (!a || !b) return false;
  return path.relative(path.resolve(a), path.resolve(b)) === "";
}

function makeRunner({ gitFn, sealDir, authArgs, pat, botLogin }) {
  const gitDir = path.join(sealDir, ".git");
  const base = [
    "--git-dir",
    gitDir,
    "--work-tree",
    sealDir,
    "-c",
    `core.hooksPath=${path.join(sealDir, ".no-hooks")}`,
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=anchor-seal",
    "-c",
    "user.email=anchor-seal@anchor-seal.invalid",
  ];
  const baseEnv = cleanGitEnv(process.env);
  return function run(sub, { net = false, allowFail = false, env = {} } = {}) {
    const args = [...base, ...(net ? authArgs : []), ...sub];
    const callEnv = {
      ...baseEnv,
      ...(net && pat ? buildGitAuthEnv(pat, botLogin) : {}),
      ...env,
    };
    const res = gitFn(args, { cwd: sealDir, env: callEnv });
    if (res.error) {
      throw new Error(`git ${sub[0]} start failed: ${errCode(res.error)}`);
    }
    if (res.status !== 0 && !allowFail) {
      throw new Error(
        `git ${sub[0]} exit ${res.status}: ${firstLine(res.stderr, pat)}`,
      );
    }
    return res;
  };
}

function ensureSealRepo({ sealDir, gitFn, run }) {
  mkdirSync(sealDir, { recursive: true });
  if (!existsSync(path.join(sealDir, ".git"))) {
    const init = gitFn(["init", "-q"], {
      cwd: sealDir,
      env: cleanGitEnv(process.env),
    });
    if (init.error || init.status !== 0) {
      throw new Error(
        `git init failed: ${init.error ? errCode(init.error) : init.status}`,
      );
    }
  }
  run(["symbolic-ref", "HEAD", SEAL_REF]);
}

function readRemoteTip(run, remote) {
  const res = run(["ls-remote", "--heads", remote, SEAL_REF], { net: true });
  const first = String(res.stdout).trim().split(/\r?\n/)[0] ?? "";
  const sha = first.split(/\s+/)[0];
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

// push 직전 원격 끝 검사 -- 결과: {suspect: reason|null, tip, adopted}
function inspectRemoteTip({ run, remote, lastCommit }) {
  const tip = readRemoteTip(run, remote);
  if (!tip) {
    return lastCommit
      ? { suspect: "remote_branch_missing", tip: null, adopted: false }
      : { suspect: null, tip: null, adopted: false };
  }
  run(["fetch", "-q", "--no-tags", remote, `+${SEAL_REF}:${REMOTE_TIP_REF}`], {
    net: true,
  });
  if (!lastCommit) return { suspect: null, tip, adopted: true };
  const anc = run(["merge-base", "--is-ancestor", lastCommit, tip], {
    allowFail: true,
  });
  if (anc.status === 0) return { suspect: null, tip, adopted: false };
  if (anc.status === 1) {
    return { suspect: "remote_tip_not_descendant", tip, adopted: false };
  }
  throw new Error(
    `git merge-base exit ${anc.status}: ${firstLine(anc.stderr)}`,
  );
}

function checkoutBase({ run, sealDir, tip }) {
  if (tip) {
    run(["update-ref", SEAL_REF, tip]);
    run(["reset", "-q", "--hard"]);
    return;
  }
  const has = run(["rev-parse", "--verify", "-q", SEAL_REF], {
    allowFail: true,
  });
  if (has.status === 0) run(["update-ref", "-d", SEAL_REF]);
  run(["read-tree", "--empty"]);
  const file = path.join(sealDir, SEAL_FILE);
  if (existsSync(file)) writeFileSync(file, "", "utf8");
}

function appendSealLine({ sealDir, line }) {
  const file = path.join(sealDir, SEAL_FILE);
  const prev = readTextOrEmpty(file);
  const sep = prev === "" || prev.endsWith("\n") ? "" : "\n";
  writeFileSync(file, `${prev}${sep}${line}\n`, "utf8");
}

function readTextOrEmpty(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function resolveCredentials({ remote, patFile, botLogin, readFn }) {
  if (!patFile) {
    if (remoteNeedsCredentials(remote))
      throw new Error("pat_file_required_for_url");
    return { pat: null, botLogin: null, authArgs: [] };
  }
  let pat;
  try {
    pat = String(readFn(patFile, "utf8")).replace(/[\s]+/g, "");
  } catch (err) {
    throw new Error(`pat_file_unreadable code=${errCode(err)}`, {
      cause: err,
    });
  }
  if (!pat) throw new Error("pat_file_empty");
  return {
    pat,
    botLogin: botLogin ?? defaultBotLogin(),
    authArgs: buildGitAuthArgs(),
  };
}

function persist({ state, statePath, io }) {
  writeStateAtomic({ statePath, state, ...io });
}

// runAnchorSealOnce -- 한 회차. ⛔던질 수 있다(watch-run 의 runAnchorSealStep 이 잡아
// FAILED 구간으로 바꾼다 · 던지는 문구는 토큰을 이미 가렸다). 모든 I/O 주입 가능.
export function runAnchorSealOnce(params) {
  const ctx = buildContext(params);
  const state = parseState(readStateText(ctx));
  try {
    if (!params.remote) throw new Error("remote_missing");
    const { roots } = computeAnchorRoots(params.sources, params.srcIo);
    const early = decideEarlyOutcome({ ctx, state, roots });
    if (early) return early;
    return sealAndPush({ ctx, state, roots });
  } catch (err) {
    throw recordFailure({ ctx, state, err });
  }
}

// 실패 회차: 연속 실패 수 +1 · 마지막 실패 시각을 상태 파일에 남기고, 던질 오류에 연속 값
// (`consecutiveFailures`)을 붙여 돌려준다 -- watch-run 이 FAILED 줄에 싣는다. ⛔상태 파일을
// 못 써도 원래 오류를 가리지 않는다(연속 값은 «알 수 없음» = 붙이지 않는다).
function recordFailure({ ctx, state, err }) {
  const error = err instanceof Error ? err : new Error(String(err));
  const health = failureHealth(state, ctx);
  try {
    persist({
      state: { ...state, ...health },
      statePath: ctx.statePath,
      io: ctx.writeIo,
    });
    error.consecutiveFailures = health.failStreak;
  } catch {
    // 상태 파일 쓰기 실패 -- 연속 값 없음(FAILED 줄은 consecutive=unknown).
  }
  return error;
}

function readStateText(ctx) {
  try {
    return ctx.readFn(ctx.statePath, "utf8");
  } catch {
    return null;
  }
}

// 기본값 해석은 여기서만 한다(본문 함수 complexity 상한 12 때문에 갈랐다).
function buildContext(p) {
  const watchDir = p.watchDir ?? ".";
  return {
    remote: p.remote,
    patFile: p.patFile,
    botLogin: p.botLogin,
    repoRoot: p.repoRoot,
    watchDir: p.watchDir,
    now: p.now ?? Date.now(),
    dailyCap: p.dailyCap ?? DAILY_PUSH_CAP,
    gitFn: p.gitFn ?? defaultGitFn,
    readFn: p.readFn ?? readFileSync,
    statePath: p.statePath ?? path.join(watchDir, STATE_FILE),
    sealDir: p.sealDir ?? path.join(watchDir, "anchor-seal-git"),
    writeIo: {
      writeFn: p.writeFn ?? writeFileSync,
      renameFn: p.renameFn ?? renameSync,
      mkdirFn: p.mkdirFn ?? mkdirSync,
    },
  };
}

// 뿌리가 같으면 unchanged(git 호출 0) · 하루 상한이면 cap_reached(push 0 · 미봉인 수).
// 그 밖에는 null -> 봉인 경로로 간다.
function decideEarlyOutcome({ ctx, state, roots }) {
  if (rootsEqual(state.last, roots)) {
    // 변경 없음도 «예외 없이 끝난 회차» -- 연속 실패 수를 0 으로 돌리고 성공 시각을 남긴다.
    persist({
      state: { ...state, ...successHealth(state, ctx) },
      statePath: ctx.statePath,
      io: ctx.writeIo,
    });
    return {
      notRun: false,
      status: "unchanged",
      roots,
      segment: "anchor-seal: unchanged",
    };
  }
  const day = localDateKey(ctx.now);
  if (Number(state.days?.[day] ?? 0) < ctx.dailyCap) return null;
  const unsealed = Number(state.unsealed?.[day] ?? 0) + 1;
  const unsealedMap = pruneDays({ ...state.unsealed, [day]: unsealed });
  persist({
    state: { ...state, unsealed: unsealedMap, ...successHealth(state, ctx) },
    statePath: ctx.statePath,
    io: ctx.writeIo,
  });
  return {
    notRun: false,
    status: "cap_reached",
    unsealed,
    cap: ctx.dailyCap,
    roots,
    segment: `anchor-seal: cap_reached unsealed=${unsealed} cap=${ctx.dailyCap}`,
  };
}

function openSealRepo(ctx) {
  if (
    sameDir(ctx.sealDir, ctx.repoRoot) ||
    sameDir(ctx.sealDir, ctx.watchDir)
  ) {
    throw new Error("seal_dir_unsafe");
  }
  const cred = resolveCredentials(ctx);
  const run = makeRunner({
    gitFn: ctx.gitFn,
    sealDir: ctx.sealDir,
    authArgs: cred.authArgs,
    pat: cred.pat,
    botLogin: cred.botLogin,
  });
  ensureSealRepo({ sealDir: ctx.sealDir, gitFn: ctx.gitFn, run });
  return run;
}

function suspectOutcome({ ctx, state, roots, reason }) {
  const cycles = Number(state.suspect?.cycles ?? 0) + 1;
  const suspect = { at: new Date(ctx.now).toISOString(), reason, cycles };
  persist({
    state: { ...state, suspect },
    statePath: ctx.statePath,
    io: ctx.writeIo,
  });
  return {
    notRun: false,
    status: "REWRITE_SUSPECT",
    reason,
    roots,
    segment: `anchor-seal: REWRITE_SUSPECT reason=${reason}`,
  };
}

// 봉인 줄 커밋 + non-force push + 상태 전진. ⛔상태는 push 가 «성공한 뒤에만» 전진한다.
function sealAndPush({ ctx, state, roots }) {
  const run = openSealRepo(ctx);
  const verdict = inspectRemoteTip({
    run,
    remote: ctx.remote,
    lastCommit: state.lastCommit,
  });
  if (verdict.suspect) {
    return suspectOutcome({ ctx, state, roots, reason: verdict.suspect });
  }
  const at = new Date(ctx.now).toISOString();
  checkoutBase({ run, sealDir: ctx.sealDir, tip: verdict.tip });
  appendSealLine({
    sealDir: ctx.sealDir,
    line: JSON.stringify({ v: 1, at, roots }),
  });
  run(["add", SEAL_FILE]);
  run(["commit", "-q", "-m", `anchor-seal ${at}`], {
    env: { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
  const commit = String(run(["rev-parse", "HEAD"]).stdout).trim();
  run(["push", "-q", ctx.remote, `${SEAL_REF}:${SEAL_REF}`], { net: true });
  const day = localDateKey(ctx.now);
  const next = {
    v: 1,
    last: roots,
    lastCommit: commit,
    lastSealAt: at,
    days: pruneDays({
      ...state.days,
      [day]: Number(state.days?.[day] ?? 0) + 1,
    }),
    unsealed: pruneDays(state.unsealed),
    suspect: null,
    ...successHealth(state, ctx),
  };
  persist({ state: next, statePath: ctx.statePath, io: ctx.writeIo });
  const { none, readError } = countWords(roots);
  return {
    notRun: false,
    status: "sealed",
    commit,
    roots,
    adoptedRemoteTip: verdict.adopted,
    segment: `anchor-seal: sealed none=${none} read_error=${readError}`,
  };
}
