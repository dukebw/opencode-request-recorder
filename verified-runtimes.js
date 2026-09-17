import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** @typedef {{ verifiedAt: string }} VerifiedRuntime */
/** @typedef {Record<string, VerifiedRuntime>} VerifiedRuntimes */

// Stamps for pruned runtime installs are dead weight; insertion order decides
// which entries survive, so re-stamping a version refreshes its position.
const maxEntries = 16;

/** The stamp lives outside the configurable capture directory so the plugin
 * and the integration test agree on one location regardless of options. */
export function verifiedRuntimesPath() {
  return (
    process.env.RECORDER_VERIFIED_PATH ??
    join(
      homedir(),
      ".local/share/opencode/request-recorder/verified-runtimes.json",
    )
  );
}

/** @returns {Promise<VerifiedRuntimes>} */
async function readVerifiedRuntimes() {
  const file = verifiedRuntimesPath();
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT")
      return {};
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid verified-runtimes file at ${file}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`Invalid verified-runtimes file at ${file}`);
  return /** @type {VerifiedRuntimes} */ (parsed);
}

/** @param {string} version @returns {Promise<boolean>} */
export async function isRuntimeVerified(version) {
  return Object.hasOwn(await readVerifiedRuntimes(), version);
}

/** @param {string} version */
export async function markRuntimeVerified(version) {
  const runtimes = await readVerifiedRuntimes();
  delete runtimes[version];
  runtimes[version] = { verifiedAt: new Date().toISOString() };
  const stale = Object.keys(runtimes).slice(0, -maxEntries);
  for (const key of stale) delete runtimes[key];
  const file = verifiedRuntimesPath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(file));
  if (!directory.isDirectory() || directory.mode & 0o077)
    throw new Error(
      "Verified-runtimes directory must be private and not a symlink",
    );
  const temporary = join(
    dirname(file),
    `.verified-runtimes-${process.pid}.tmp`,
  );
  await writeFile(temporary, JSON.stringify(runtimes, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, file);
}
