import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Recorder } from "./recorder.js";

const input = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
};
const output = { type: "object" };
const rpc = {
  id: "request-recorder",
  methods: {
    start: { input, output },
    stop: { input, output },
    status: { input, output },
  },
  events: {},
};

/** @param {unknown} value @param {number} fallback @param {string} name */
function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

// The whole 0.0.0-beta-* line shares the tested hook contract; other releases must be
// tested before recording against them.
const testedVersionPrefix = "0.0.0-beta-";

/** @type {import("@opencode-ai/plugin/promise/plugin").Plugin} */
const plugin = {
  id: "opencode-request-recorder",
  async setup(ctx) {
    if (!ctx.app.version.startsWith(testedVersionPrefix)) {
      throw new Error(
        `Request Recorder is tested with OpenCode V2 ${testedVersionPrefix}*; use a tested runtime/plugin pair`,
      );
    }
    const directory =
      ctx.options.directory ??
      join(homedir(), ".local/share/opencode/request-recorder");
    if (typeof directory !== "string" || !isAbsolute(directory))
      throw new Error("directory must be an absolute path");
    const recorder = new Recorder({
      directory,
      version: ctx.app.version,
      durationSec: positiveInteger(
        ctx.options.durationSec,
        3600,
        "durationSec",
      ),
      maxBytes: positiveInteger(
        ctx.options.maxBytes,
        512 * 1024 * 1024,
        "maxBytes",
      ),
    });
    const registration = await ctx.rpc.register(rpc, {
      start: async (value) => {
        const { sessionID } = /** @type {{sessionID: string}} */ (value);
        const session = await ctx.session.get({ sessionID });
        if (session.location.directory !== ctx.location.directory) {
          throw new Error(
            "Run this command from the session's current directory",
          );
        }
        return recorder.start(sessionID);
      },
      stop: (value) =>
        recorder.stop(/** @type {{sessionID: string}} */ (value).sessionID),
      status: async (value) =>
        recorder.status(/** @type {{sessionID: string}} */ (value).sessionID),
    });
    const hook = await ctx.session.hook("http.request", (event) =>
      recorder.capture(event),
    );
    return async () => {
      await hook.dispose();
      await registration.dispose();
      await recorder.close();
    };
  },
};

export default plugin;
