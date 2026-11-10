// HYK-153-engine-profile-1 (piece B, coder-task.md §2 product_scope ⓘⓘⓘⓘ):
// a thin CLI over engine-profile.mjs so a control-room PowerShell file
// (orca-worker-seat.ps1 / dispatch-worker.ps1 / memory-gate.ps1) can read
// role defaults from scripts/check/engine-profiles.json without duplicating
// the lookup logic in PowerShell. This round does NOT wire it into any
// control-room file (⛔관제실 파일 직접 수정 0, hard constraint) -- see
// docs/control-room-patches/HYK-153-engine-profile.md for the proposed
// patch text a human applies.
//
// usage: node scripts/check/engine-profile-cli.mjs resolve --role <ROLE> [--json]
// exit 0 + prints {engine, model, effort} (JSON with --json, else one
// "key=value" line per field) when the role has a profile.
// exit 2 + stderr reason when the role is unknown or the config itself is
// missing/malformed (same honesty contract as engine-profile.mjs itself --
// no silent default).

import { getRoleProfile, loadEngineProfiles } from "./engine-profile.mjs";

function parseArgs(argv) {
  const out = { command: argv[0] ?? null, role: null, json: false };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--role") out.role = argv[++i] ?? null;
    else if (argv[i] === "--json") out.json = true;
  }
  return out;
}

function printUsage() {
  console.error(
    "usage: node scripts/check/engine-profile-cli.mjs resolve --role <ROLE> [--json]",
  );
}

export function runEngineProfileCli(argv) {
  const parsed = parseArgs(argv);
  if (parsed.command !== "resolve") {
    return {
      ok: false,
      reason: `unknown command ${JSON.stringify(parsed.command)}`,
    };
  }
  if (!parsed.role) {
    return { ok: false, reason: "missing --role" };
  }
  let profiles;
  try {
    profiles = loadEngineProfiles();
  } catch (err) {
    return { ok: false, reason: `config load failed: ${err.message}` };
  }
  const profile = getRoleProfile(parsed.role, profiles);
  if (!profile) {
    return {
      ok: false,
      reason: `no profile for role ${JSON.stringify(parsed.role)}`,
    };
  }
  return { ok: true, profile, json: parsed.json };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/engine-profile-cli.mjs");
if (invokedDirectly) {
  const result = runEngineProfileCli(process.argv.slice(2));
  if (!result.ok) {
    printUsage();
    console.error(`engine-profile-cli: ${result.reason}`);
    process.exit(2);
  }
  if (result.json) {
    process.stdout.write(JSON.stringify(result.profile) + "\n");
  } else {
    for (const [key, value] of Object.entries(result.profile)) {
      process.stdout.write(`${key}=${value}\n`);
    }
  }
  process.exit(0);
}
