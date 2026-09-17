import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import plugin from "../index.js";
import { Recorder } from "../recorder.js";
import { markRuntimeVerified } from "../verified-runtimes.js";

/** Point the plugin at a throwaway stamp file for the duration of a test. */
function useStampFile(t, root) {
  process.env.RECORDER_VERIFIED_PATH = join(root, "verified-runtimes.json");
  t.after(() => {
    delete process.env.RECORDER_VERIFIED_PATH;
  });
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "request-recorder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "captures");
  const recorder = new Recorder({
    directory,
    version: "test",
    durationSec: 60,
    maxBytes: 1024 * 1024,
    ...options,
  });
  t.after(() => recorder.close());
  return { recorder, root, directory };
}

function event(
  sessionID = "ses_test",
  body = '{ "messages": [{"role":"user","content":"你好"}], "tools": [] }\n',
) {
  return {
    sessionID,
    agent: "build",
    kind: "primary",
    model: { providerID: "fixture", id: "fixture-model", variant: "test" },
    request: new Request(
      "http://127.0.0.1/v1/chat/completions?key=fixture-query-secret",
      {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fixture-header-secret",
        },
      },
    ),
  };
}

async function records(file) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

test("off by default; exact session opt-in; excludes auxiliary requests", async (t) => {
  const { recorder, root } = await fixture(t);
  await recorder.capture(event());
  assert.deepEqual(await readdir(root), []);
  const { file } = await recorder.start("ses_test");
  await recorder.capture(event("ses_other"));
  await recorder.capture(event("ses_test_child"));
  for (const kind of ["title", "compaction", "generate"])
    await recorder.capture({ ...event(), kind });
  assert.deepEqual(await records(file), []);
  await recorder.capture(event());
  assert.equal((await records(file)).length, 1);
});

test("captured body equals bytes received over HTTP; credentials and URL omitted", async (t) => {
  const { recorder, directory } = await fixture(t);
  let received;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks);
    res.end("ok");
  }).listen(0, "127.0.0.1");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  await once(server, "listening");
  const outgoing = event();
  outgoing.model.extraCredential = "fixture-unexpected-model-secret";
  const body = await outgoing.request.clone().text();
  outgoing.request = new Request(
    `http://127.0.0.1:${server.address().port}/v1/chat/completions?key=fixture-query-secret`,
    outgoing.request,
  );
  const { file } = await recorder.start(outgoing.sessionID);
  await recorder.capture(outgoing);
  assert.equal(outgoing.request.bodyUsed, false);
  assert.equal(
    outgoing.request.headers.get("authorization"),
    "Bearer fixture-header-secret",
  );
  const response = await fetch(outgoing.request);
  assert.equal(await response.text(), "ok");
  const [record] = await records(file);
  assert.equal(record.body, body);
  assert.deepEqual(Buffer.from(record.body), received);
  assert.equal(
    record.sha256,
    createHash("sha256").update(received).digest("hex"),
  );
  const contents = await readFile(file, "utf8");
  assert.doesNotMatch(
    contents,
    /fixture-header-secret|fixture-query-secret|fixture-unexpected-model-secret|127\.0\.0\.1/,
  );
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("interleaved sessions and requests cannot mix or corrupt JSONL", async (t) => {
  const { recorder } = await fixture(t);
  const a = await recorder.start("ses_a");
  const b = await recorder.start("ses_b");
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      recorder.capture(
        event(i % 2 ? "ses_a" : "ses_b", JSON.stringify({ input: [i] })),
      ),
    ),
  );
  for (const [state, id] of [
    [a, "ses_a"],
    [b, "ses_b"],
  ]) {
    const rows = await records(state.file);
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r) => r.sessionID === id));
    assert.equal(new Set(rows.map((r) => r.body)).size, 10);
  }
});

test("stop waits for admitted writes; restart creates a new file", async (t) => {
  const { recorder } = await fixture(t);
  const first = await recorder.start("ses_test");
  const pending = recorder.capture(event());
  const stopped = await recorder.stop("ses_test");
  assert.equal(stopped.requests, 1);
  assert.equal(stopped.recording, false);
  await pending;
  await recorder.capture(event());
  assert.equal((await records(first.file)).length, 1);
  const second = await recorder.start("ses_test");
  assert.notEqual(first.file, second.file);
  assert.equal(second.requests, 0);
  assert.equal((await records(first.file)).length, 1);
});

test("rejects duplicate starts and path traversal", async (t) => {
  const { recorder } = await fixture(t);
  const results = await Promise.allSettled([
    recorder.start("ses_test"),
    recorder.start("ses_test"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await assert.rejects(recorder.start("../escape"), /Invalid session/);
});

test("capture expires without needing a timer or a server restart", async (t) => {
  const { recorder } = await fixture(t);
  const { file } = await recorder.start("ses_test");
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 60_001);
  await recorder.capture(event());
  assert.equal(recorder.status("ses_test").reason, "expired");
  assert.equal(recorder.status("ses_test").recording, false);
  assert.deepEqual(await records(file), []);
});

test("size limit stops capture, not the original request", async (t) => {
  const { recorder } = await fixture(t, { maxBytes: 1 });
  t.mock.method(console, "error", () => {});
  const { file } = await recorder.start("ses_test");
  const outgoing = event();
  await recorder.capture(outgoing);
  assert.match(recorder.status("ses_test").reason, /size limit/);
  assert.equal(outgoing.request.bodyUsed, false);
  assert.deepEqual(await records(file), []);
});

test("invalid JSON and UTF-8 stop capture without logging body content", async (t) => {
  const { recorder } = await fixture(t);
  const messages = [];
  t.mock.method(console, "error", (line) => messages.push(line));
  for (const body of [
    "fixture-sensitive-invalid-json",
    new Uint8Array([0xff]),
  ]) {
    const { file } = await recorder.start("ses_test");
    const outgoing = event("ses_test", body);
    await recorder.capture(outgoing);
    assert.equal(recorder.status("ses_test").recording, false);
    assert.deepEqual(await records(file), []);
    assert.equal(outgoing.request.bodyUsed, false);
  }
  assert.doesNotMatch(messages.join("\n"), /fixture-sensitive/);
});

test("write failure remains visible and never resumes implicitly", async (t) => {
  const { recorder, directory } = await fixture(t);
  t.mock.method(console, "error", () => {});
  await recorder.start("ses_test");
  await rename(directory, `${directory}-moved`);
  await recorder.capture(event());
  assert.match(recorder.status("ses_test").reason, /writing capture/);
  await rename(`${directory}-moved`, directory);
  await recorder.capture(event());
  assert.equal(recorder.status("ses_test").requests, 0);
});

test("refuses shared capture directory and symlink replacement", async (t) => {
  const { recorder, root, directory } = await fixture(t);
  const { file } = await recorder.start("ses_test");
  await recorder.stop("ses_test");
  await chmod(directory, 0o755);
  await assert.rejects(recorder.start("ses_other"), /Could not create/);
  await chmod(directory, 0o700);
  const fresh = await recorder.start("ses_test");
  const victim = join(root, "unrelated");
  await writeFile(victim, "untouched");
  await unlink(fresh.file);
  await symlink(victim, fresh.file);
  t.mock.method(console, "error", () => {});
  await recorder.capture(event());
  assert.equal(await readFile(victim, "utf8"), "untouched");
  assert.equal(await readFile(file, "utf8"), "");
});

test("V2 setup registers control RPC and native hook without modifying history", async (t) => {
  const { directory, root } = await fixture(t);
  useStampFile(t, root);
  await markRuntimeVerified("2.0.4");
  let handlers, callback;
  const disposed = [];
  const context = {
    app: { version: "2.0.4" },
    options: { directory },
    location: { directory: "/project" },
    rpc: {
      register: async (definition, methods) => {
        assert.equal(definition.id, "request-recorder");
        handlers = methods;
        return { dispose: async () => disposed.push("rpc") };
      },
    },
    session: {
      get: async () => ({ location: { directory: "/project" } }),
      hook: async (name, handler) => {
        assert.equal(name, "http.request");
        callback = handler;
        return { dispose: async () => disposed.push("hook") };
      },
    },
  };
  const cleanup = await plugin.setup(context);
  assert.deepEqual(await handlers.status({ sessionID: "ses_test" }), {
    recording: false,
  });
  await handlers.start({ sessionID: "ses_test" });
  await callback(event());
  assert.equal((await handlers.stop({ sessionID: "ses_test" })).requests, 1);
  context.session.get = async () => ({
    location: { directory: "/other-project" },
  });
  await assert.rejects(
    handlers.start({ sessionID: "ses_elsewhere" }),
    /current directory/,
  );
  await cleanup();
  assert.deepEqual(disposed, ["hook", "rpc"]);
});

test("setup records only on runtimes stamped by the integration test", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "request-recorder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  useStampFile(t, root);
  const context = (version) => ({
    app: { version },
    options: {},
    location: { directory: "/project" },
    rpc: { register: async () => ({ dispose: async () => {} }) },
    session: { hook: async () => ({ dispose: async () => {} }) },
  });
  await assert.rejects(plugin.setup(context("2.0.5")), /has not passed/);
  await assert.rejects(plugin.setup(context("1.0.0")), /has not passed/);
  await markRuntimeVerified("2.0.5");
  const cleanup = await plugin.setup(context("2.0.5"));
  await cleanup();
  // A corrupt stamp file fails loudly instead of silently denying.
  await writeFile(process.env.RECORDER_VERIFIED_PATH, "{ not json");
  await assert.rejects(plugin.setup(context("2.0.5")), /verified-runtimes/);
});
