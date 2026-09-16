import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

test(
  "real OpenCode V2 records exactly what the loopback provider receives",
  {
    skip: !process.env.OPENCODE_BIN,
    timeout: 60_000,
  },
  async (t) => {
    const version = execFileSync(process.env.OPENCODE_BIN, ["--version"], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/)
      .at(-1)
      .replace(/^v/, "");
    const legacy = version.startsWith("0.0.0-beta-");
    const root = await mkdtemp(join(tmpdir(), "recorder-opencode-"));
    let child;
    let provider;
    t.after(async () => {
      if (child && child.exitCode === null) {
        const closed = once(child, "close");
        child.kill("SIGTERM");
        const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
        await closed;
        clearTimeout(timeout);
      }
      if (provider)
        await new Promise((resolve) => {
          provider.close(resolve);
          provider.closeAllConnections();
        });
      await rm(root, { recursive: true, force: true });
    });
    const home = join(root, "home");
    const directory = join(root, "project");
    const captures = join(root, "captures");
    const configDirectory = join(home, ".config/opencode");
    await mkdir(home);
    await mkdir(directory);
    await mkdir(configDirectory, { recursive: true });
    const received = [];
    provider = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const delta of [
        {
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "fixture response" },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ])
        res.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", ...delta })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
    }).listen(0, "127.0.0.1");
    await once(provider, "listening");
    await writeFile(
      join(configDirectory, "opencode.json"),
      JSON.stringify({
        plugins: [
          {
            package: resolve(process.env.RECORDER_PACKAGE_PATH ?? "."),
            options: { directory: captures },
          },
        ],
        model: "recorder-fixture/fixture",
        providers: {
          "recorder-fixture": {
            package: `${legacy ? "@opencode-ai" : "@opencode"}/ai/providers/openai-compatible`,
            env: ["RECORDER_FIXTURE_API_KEY"],
            settings: {
              baseURL: `http://127.0.0.1:${provider.address().port}/v1`,
            },
            models: {
              fixture: {
                name: "Local test fixture",
                limit: { context: 200000, output: 1000 },
              },
            },
          },
        },
      }),
    );
    const reservation = createServer().listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    child = spawn(
      process.env.OPENCODE_BIN,
      [
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
        "--print-logs",
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local/share"),
          XDG_STATE_HOME: join(home, ".local/state"),
          XDG_CACHE_HOME: join(home, ".cache"),
          TMPDIR: root,
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          RECORDER_FIXTURE_API_KEY: "fixture-not-a-real-key",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    child.stdout.on("data", (data) => {
      logs += data;
    });
    child.stderr.on("data", (data) => {
      logs += data;
    });
    const safeLogs = () =>
      logs
        .replace(/server password \S+/g, "server password [redacted]")
        .split("\n")
        .filter((line) => /WARN|ERROR|server listening/.test(line))
        .join("\n");
    const auth = () => {
      const password = logs.match(/server password (\S+)/)?.[1];
      return password
        ? {
            authorization:
              "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
          }
        : {};
    };
    const base = `http://127.0.0.1:${port}`;
    const location = "location[directory]=" + encodeURIComponent(directory);
    async function api(path, body) {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...auth() },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(
        response.ok,
        true,
        `${path}: ${response.status} ${await response.clone().text()}`,
      );
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null)
        throw new Error(`Isolated OpenCode exited: ${safeLogs()}`);
      try {
        const health = await fetch(base + (legacy ? "/api/health" : "/api/status"), {
          headers: auth(),
          signal: AbortSignal.timeout(500),
        });
        if (health.ok) {
          ready = true;
          break;
        }
      } catch {
        /* Wait only for this test's isolated server. */
      }
      await delay(100);
    }
    assert.equal(
      ready,
      true,
      `Isolated OpenCode did not become ready: ${safeLogs()}`,
    );
    if (legacy) await api(`/api/plugin/await-activation?${location}`, {});
    const { data: session } = await api("/api/session", {
      location: { directory },
      title: "Synthetic recorder test",
      model: { providerID: "recorder-fixture", id: "fixture" },
    });
    const control = (method) =>
      api(`/api/rpc/request-recorder/${method}?${location}`, {
        input: { sessionID: session.id },
      });
    const wait = () =>
      api(`/api/${legacy ? "" : "experimental/"}session/${session.id}/wait`, {});
    // RPC dispatch waits for plugin activation on stable V2.
    assert.equal((await control("status")).output.recording, false);
    const plugins = await api(`/api/plugin?${location}`);
    if (!JSON.stringify(plugins).includes("opencode-request-recorder")) {
      throw new Error(
        JSON.stringify({
          plugins: plugins.data.filter((p) => p.source.type !== "builtin"),
          config: await api(`/api/config?${location}`),
          logs: safeLogs(),
        }),
      );
    }
    await control("start");
    await api(`/api/session/${session.id}/prompt`, {
      text: "Reply with fixture response. Do not use tools.",
    });
    await wait();
    const stopped = await control("stop");
    const status = stopped.output;
    assert.equal(status.recording, false);
    assert.equal(
      status.requests,
      1,
      JSON.stringify({
        stopped,
        providerRequests: received.length,
        logs: safeLogs(),
      }),
    );
    const captureText = await readFile(status.file, "utf8");
    const [record] = captureText.trim().split("\n").map(JSON.parse);
    assert.ok(
      received.includes(record.body),
      "Capture differs from actual wire body",
    );
    assert.equal(record.kind, "primary");
    assert.equal(record.opencodeVersion, version);
    const payload = JSON.parse(record.body);
    assert.ok(payload.messages.some((m) => m.role === "system"));
    assert.ok(payload.tools.length > 0);
    assert.doesNotMatch(captureText, /fixture-not-a-real-key/);
    const count = received.length;
    await api(`/api/session/${session.id}/prompt`, {
      text: "Reply again without tools.",
    });
    await wait();
    assert.ok(received.length > count);
    assert.equal(await readFile(status.file, "utf8"), captureText);
  },
);
