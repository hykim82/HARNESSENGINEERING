// HYK-477-ambient-sweep-report-1: reads the JSON marker that
// hyk359-ambient-env-regression.test.mjs's own full-sweep test writes (only
// when HARNESS_AMBIENT_SWEEP_MARKER is set, i.e. only under enforce.yml's
// `npm test` step) and turns it into a single GitHub Actions workflow-
// command line -- `::notice` on success, `::error` on every other outcome,
// each failure reason distinct so a human reading the CI annotation (or a
// REST read of check-runs/<id>/annotations) can tell which one fired
// without opening the raw log.
//
// Deliberately NOT the inverse of "did the sweep run" alone: a marker can
// exist and still be stale (left over from a previous job on the same
// runner, or a previous commit on a reused self-hosted box) -- the head
// comparison below is what turns "a marker exists" into "THIS commit's
// sweep ran".
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function reportAmbientSweep({
  markerPath,
  head,
  readFile = readFileSync,
}) {
  let raw;
  try {
    raw = readFile(markerPath, "utf8");
  } catch {
    return {
      rc: 1,
      line: `::error title=ambient-sweep::marker not found at ${markerPath} -- the full ambient sweep did not run (or did not reach its own last assertion) in the npm test step above`,
    };
  }

  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
    return {
      rc: 1,
      line: `::error title=ambient-sweep::marker at ${markerPath} is not valid JSON`,
    };
  }

  if (!(Number(marker.files) >= 1)) {
    return {
      rc: 1,
      line: `::error title=ambient-sweep::marker reports files=${marker.files} (expected >= 1) -- the sweep ran but swept nothing`,
    };
  }

  if (marker.full_ambient_sweep !== "1") {
    return {
      rc: 1,
      line: `::error title=ambient-sweep::marker full_ambient_sweep=${JSON.stringify(marker.full_ambient_sweep)} (expected "1") -- HARNESS_FULL_AMBIENT_SWEEP was not actually "1" when the sweep ran`,
    };
  }

  if (marker.head !== head) {
    return {
      rc: 1,
      line: `::error title=ambient-sweep::marker head ${marker.head} does not match this step's head ${head} -- stale marker from a different commit`,
    };
  }

  const seconds = (Number(marker.duration_ms) / 1000).toFixed(1);
  const shortHead = String(marker.head).slice(0, 7);
  return {
    rc: 0,
    line: `::notice title=ambient-sweep::ran ${marker.files} files in ${seconds} s (HARNESS_FULL_AMBIENT_SWEEP=${marker.full_ambient_sweep} · head ${shortHead} · node ${marker.node})`,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/ambient-sweep-report.mjs");
if (invokedDirectly) {
  const markerPath = process.argv[2];
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const { rc, line } = reportAmbientSweep({ markerPath, head });
  console.log(line);
  process.exit(rc);
}
