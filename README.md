# OpenCode Request Recorder

Opt-in, local recording of OpenCode V2's outgoing JSON request bodies. Uses the
native `http.request` hook, not a proxy or transcript reconstruction. No runtime
dependencies, model calls, or uploads.

**Requires an OpenCode V2 `0.0.0-beta-*` runtime.** The plugin refuses other versions
until their hook contract has been tested. OpenCode V1 is not supported.

## Install

```sh
opencode plugin add github:dukebw/opencode-request-recorder
```

Use `opencode2` instead if that is your V2 executable's name. For a pinned install,
append `#<full-commit-sha>` to the Git package specification. Installing the plugin
does **not** enable recording.

## Record a session

Run these commands from the session's current working directory, connected to the
same OpenCode server. Use its exact session ID; child sessions are not opted in
automatically.

```sh
SESSION_ID=ses_your_session_id
opencode api post /api/rpc/request-recorder/start -d "{\"input\":{\"sessionID\":\"$SESSION_ID\"}}"
opencode api post /api/rpc/request-recorder/status -d "{\"input\":{\"sessionID\":\"$SESSION_ID\"}}"
opencode api post /api/rpc/request-recorder/stop -d "{\"input\":{\"sessionID\":\"$SESSION_ID\"}}"
```

`start` returns the capture file and expiry. Use OpenCode normally, then `stop`:
it waits for already-admitted writes before returning the final count. These
controls do not add conversation messages or trigger inference.

- Off by default; only the selected session's `primary` requests are captured.
- Title, compaction, and transient generation requests are excluded.
- Each start creates a new file; a second start while active is rejected.
- Recording stops after **one hour** or **512 MiB**, whichever comes first.
- Plugin reload/server restart disables recording; files are retained.
- Write, encoding, or size-limit failures stop recording and appear in `status`
  and the server log. They do not block the original inference request.

## Files and privacy

Default directory: `~/.local/share/opencode/request-recorder/`. Each capture is
`<session-id>-<random-id>.jsonl`. The directory must be private (`0700`) and not a
symlink; files are created exclusively with mode `0600`. Nothing is deleted
automatically. These permission checks target Linux/macOS.

Each line contains `timestamp`, `sessionID`, `agent`, `kind`, `model`,
`opencodeVersion`, `method`, `body`, and `sha256`.

**`body` is the original UTF-8 JSON text stored as a string**, including its
whitespace. Encoding that string as UTF-8 reproduces the captured body bytes;
`sha256` hashes those bytes. Request bodies are not rewritten or redacted.

Headers, URLs, cookies, and response bodies are not recorded. **Secrets or private
source code already present inside the request body are still captured.** Review
files before sharing; keep them outside Git and public artifact storage. Files
are plaintext, not encrypted. On a remote OpenCode server, they live on that server.

## Exactness and replay

The recorder observes the native request at its hook position. Configure it after
other request-modifying plugins; a later hook can otherwise change what is sent.
An integration test compares captured body bytes with what a loopback provider
actually receives from the supported OpenCode build.

Captures are **outgoing attempts**, not proof of successful generation. Retries
remain separate records. This plugin does not deduplicate, benchmark, or execute
tools. Non-JSON or invalid UTF-8 bodies stop recording rather than being converted.

For direct replay against SGLang's `/v1/chat/completions`, collect from a Chat
Completions provider. Original Responses/Anthropic request bodies use different
protocols; recording them does not make them compatible with Chat Completions.

## Options

Optional configuration in `opencode.json(c)`:

```json
{
  "plugins": [
    {
      "package": "github:dukebw/opencode-request-recorder",
      "options": {
        "directory": "/absolute/private/capture-directory",
        "durationSec": 3600,
        "maxBytes": 536870912
      }
    }
  ]
}
```

Use an absolute directory and positive integer limits. Options do not enable capture.

## Development

```sh
npm ci --ignore-scripts
npm run check
OPENCODE_BIN=/absolute/path/to/opencode2 npm test
```

The optional OpenCode integration test uses a temporary home/config, an isolated
server, a loopback mock provider, and synthetic data. It does not touch your
sessions or provider credentials. SDK dependencies are development-only; the
plugin itself imports only Node built-ins and its own recorder module.

For local plugin development, configure the absolute **repository directory**, not
`index.js`, as the plugin package path. Set `RECORDER_PACKAGE_PATH` when testing an
unpacked package instead of the working tree.
