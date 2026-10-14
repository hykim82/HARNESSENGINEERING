// install-g1-adapter-list.test.mjs -- HYK-209-install-list-g1-adapter-1.
//
// Reproduced fact (coder.md §1, ORCH-73's editor-reinstall-4 review P2-1/
// P2-2): relay-handshake-g1-dispatch-check.test.mjs (the §1 "result file
// top 3 lines" G1 dispatch-verification machine check) and admission-
// completion-adapter.mjs (the retirement-completion adapter relay-
// handshake.mjs spawns by path) were both entirely absent from
// ENFORCEMENT_CHECK_FILES -- an installed target repo's own CI had no
// regression net for either axis. install-copylist-closure.test.mjs's
// generic, list-wide import-closure check already covers requirement (b)
// (the two files' own static import closure) once the two names -- and
// admission-completion-adapter.mjs's own previously-missing dependency,
// ledger-pointer-shared.mjs -- are in the list (proven green by that file's
// existing "ⓐ' install copy-list closure" test; this file does not
// duplicate that proof). What that generic test does NOT cover is (a)
// whether these two SPECIFIC names remain in the list at all (nothing in
// this repo imports either of them back, so removing one would not surface
// as a closure violation -- see this file's own V1/V2 tests) and (c)
// whether an actual installed target's dry-run output names them as
// install targets (the closure test never shells out to the installer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENFORCEMENT_CHECK_FILES } from "./install.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const INSTALLER_PATH = path.join(
  REPO_ROOT,
  "templates",
  "harness-init",
  "install.mjs",
);

const NAMES = [
  "relay-handshake-g1-dispatch-check.test.mjs",
  "admission-completion-adapter.mjs",
];

// (a) 두 이름이 목록에 있다.
test("(a) ENFORCEMENT_CHECK_FILES contains both relay-handshake-g1-dispatch-check.test.mjs and admission-completion-adapter.mjs", () => {
  for (const name of NAMES) {
    assert.ok(
      ENFORCEMENT_CHECK_FILES.includes(name),
      `expected ENFORCEMENT_CHECK_FILES to include ${name}`,
    );
  }
});

// V1 / V2 음성 대조: neither name is imported by anything ELSE already in
// ENFORCEMENT_CHECK_FILES (confirmed live, `grep -rn`: nothing anywhere
// imports relay-handshake-g1-dispatch-check.test.mjs -- only a comment-text
// mention in hyk387-dispatch-record-required.test.mjs; admission-
// completion-adapter.mjs DOES have real importers -- hyk209-mask-
// readers.test.mjs, hyk461-archive-evidence.test.mjs, hyk468-3r-three-
// readers.test.mjs -- but none of those three files are themselves in this
// list, so they are invisible to install-copylist-closure.test.mjs's
// generic check, which only scans the list's own members) -- so that
// generic import-closure check cannot, on its own, notice either name
// going missing. These two tests are that otherwise-missing regression net
// made explicit, proving the (a) presence assertion above actually has
// teeth against each of V1 and V2 the way install-copylist-closure
// .test.mjs's own PAST_INCIDENTS block proves teeth for closure violations.
for (const removedName of NAMES) {
  test(`V1/V2 negative control: removing "${removedName}" from the (in-memory) list fails the (a) presence assertion`, () => {
    const reduced = ENFORCEMENT_CHECK_FILES.filter((n) => n !== removedName);
    assert.ok(
      reduced.length === ENFORCEMENT_CHECK_FILES.length - 1,
      `${removedName} must actually be present in the real list for this control to mean anything`,
    );
    assert.ok(
      !reduced.includes(removedName),
      `expected ${removedName} to be absent from the reduced list`,
    );
  });
}

function makeSyntheticTarget(prefix) {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  const targetRepo = path.join(base, "target-repo");
  mkdirSync(targetRepo, { recursive: true });
  execFileSync("git", ["-C", targetRepo, "init", "-q"]);
  return { base, targetRepo };
}

function runInstallDryRun(args) {
  return execFileSync("node", [INSTALLER_PATH, ...args, "--dry-run"], {
    encoding: "utf8",
  });
}

// (c) 합성 대상 dry-run 출력에 두 파일이 "설치 대상"으로 나온다.
test("(c) solo-full synthetic dry-run names both files as would-install targets", () => {
  const { base, targetRepo } = makeSyntheticTarget("hyk209-g1-adapter-dry-");
  try {
    const out = runInstallDryRun([
      "--profile",
      "solo-full",
      "--repo-path",
      targetRepo,
      "--control-room-path",
      path.join(base, "fake-control-room"),
      "--github-repo",
      "someorg/somerepo",
      "--bot-account",
      "bot-x",
      "--verify-cmd",
      "npm test",
      "--notify-dir",
      path.join(base, "notify"),
      "--approver-login",
      "approver-x",
      "--approver-id",
      "1",
      "--workspaces-root",
      path.join(base, "workspaces"),
      "--main-repo-path",
      path.join(base, "main-repo"),
    ]);
    for (const name of NAMES) {
      assert.match(
        out,
        new RegExp(
          `\\[dry-run\\] would install:.*scripts[\\\\/]check[\\\\/]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
        `expected dry-run output to name scripts/check/${name} as a would-install target`,
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
