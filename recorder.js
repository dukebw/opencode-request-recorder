import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** @typedef {import("@opencode-ai/plugin/promise/session").SessionHttpRequest} RequestEvent */
/** @typedef {{ active: boolean, file: string, requests: number, bytes: number, expiresAt: number, reason: string | null, pending: Promise<void> }} Recording */

export class Recorder {
  /** @type {Map<string, Recording>} */
  recordings = new Map();

  /** @param {{directory: string, version: string, durationSec: number, maxBytes: number}} options */
  constructor(options) {
    this.options = options;
  }

  /** @param {string} sessionID */
  status(sessionID) {
    const state = this.recordings.get(sessionID);
    if (!state) return { recording: false };
    if (state.active && Date.now() >= state.expiresAt) {
      state.active = false;
      state.reason = "expired";
    }
    return {
      recording: state.active,
      file: state.file,
      requests: state.requests,
      bytes: state.bytes,
      expiresAt: new Date(state.expiresAt).toISOString(),
      reason: state.reason,
    };
  }

  /** @param {string} sessionID */
  async start(sessionID) {
    if (!/^ses[a-zA-Z0-9_-]+$/.test(sessionID))
      throw new Error("Invalid session ID");
    if (this.status(sessionID).recording)
      throw new Error("Session is already recording");
    const previous = this.recordings.get(sessionID);
    const file = join(
      this.options.directory,
      `${sessionID}-${randomUUID()}.jsonl`,
    );
    /** @type {Recording} */
    const state = {
      active: true,
      file,
      requests: 0,
      bytes: 0,
      expiresAt: Date.now() + this.options.durationSec * 1000,
      reason: null,
      pending: Promise.resolve(),
    };
    this.recordings.set(sessionID, state);
    state.pending = (async () => {
      await previous?.pending;
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.options.directory);
      if (!directory.isDirectory() || directory.mode & 0o077) {
        throw new Error("Capture directory must be private and not a symlink");
      }
      await writeFile(file, "", { flag: "wx", mode: 0o600 });
    })();
    try {
      await state.pending;
    } catch {
      state.active = false;
      state.reason = "Could not create capture file";
      // Do not retain a rejected promise in later stop/status operations.
      state.pending = Promise.resolve();
      throw new Error(state.reason);
    }
    return this.status(sessionID);
  }

  /** @param {string} sessionID */
  async stop(sessionID) {
    const state = this.recordings.get(sessionID);
    if (state) {
      state.active = false;
      state.reason ??= "stopped";
      await state.pending;
    }
    return this.status(sessionID);
  }

  /** @param {RequestEvent} event */
  async capture(event) {
    if (event.kind !== "primary" || !this.status(event.sessionID).recording)
      return;
    const state = /** @type {Recording} */ (
      this.recordings.get(event.sessionID)
    );
    const timestamp = new Date().toISOString();
    // Capture this request now, not a later mutation of the hook event.
    let request;
    try {
      request = event.request.clone();
    } catch {
      state.active = false;
      state.reason = "Could not clone request body";
      console.error(
        "opencode-request-recorder: recording stopped; could not clone request",
      );
      return;
    }
    const identity = {
      sessionID: event.sessionID,
      agent: event.agent,
      kind: event.kind,
      model: {
        providerID: event.model.providerID,
        id: event.model.id,
        variant: event.model.variant,
      },
    };
    let stage = "reading request body";
    state.pending = state.pending
      .then(async () => {
        if (
          state.reason &&
          state.reason !== "stopped" &&
          state.reason !== "expired"
        )
          return;
        const bytes = Buffer.from(await request.arrayBuffer());
        stage = "decoding UTF-8";
        const body = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        stage = "validating JSON";
        JSON.parse(body);
        const line =
          JSON.stringify({
            timestamp,
            ...identity,
            opencodeVersion: this.options.version,
            method: request.method,
            body,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }) + "\n";
        const size = Buffer.byteLength(line);
        stage = "enforcing capture size limit";
        if (state.bytes + size > this.options.maxBytes)
          throw new Error("Capture size limit");
        stage = "writing capture file";
        await appendFile(state.file, line, {
          flag: constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
        });
        state.requests += 1;
        state.bytes += size;
      })
      .catch(() => {
        state.active = false;
        state.reason = `Capture failed while ${stage}`;
        console.error(
          `opencode-request-recorder: recording stopped; ${state.reason}`,
        );
      });
    await state.pending;
  }

  async close() {
    await Promise.all([...this.recordings.keys()].map((id) => this.stop(id)));
  }
}
