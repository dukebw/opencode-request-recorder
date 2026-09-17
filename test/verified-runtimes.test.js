import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isRuntimeVerified,
  markRuntimeVerified,
} from "../verified-runtimes.js";

test("runtimes are unverified until stamped; stamps prune to the newest 16", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "verified-runtimes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.RECORDER_VERIFIED_PATH = join(root, "verified-runtimes.json");
  t.after(() => {
    delete process.env.RECORDER_VERIFIED_PATH;
  });

  assert.equal(await isRuntimeVerified("2.0.99"), false);
  await markRuntimeVerified("2.0.99");
  assert.equal(await isRuntimeVerified("2.0.99"), true);
  assert.equal(await isRuntimeVerified("2.0.6"), false);

  for (let i = 0; i < 20; i += 1) await markRuntimeVerified(`2.0.${i}`);
  const stamped = JSON.parse(
    await readFile(process.env.RECORDER_VERIFIED_PATH, "utf8"),
  );
  assert.equal(Object.keys(stamped).length, 16);
  assert.equal(await isRuntimeVerified("2.0.19"), true);
  assert.equal(await isRuntimeVerified("2.0.99"), false);

  // Re-stamping a version refreshes its position against pruning.
  await markRuntimeVerified("2.0.4");
  for (const version of ["2.0.20", "2.0.21"]) await markRuntimeVerified(version);
  assert.equal(await isRuntimeVerified("2.0.4"), true);
  assert.equal(await isRuntimeVerified("2.0.5"), false);
});
