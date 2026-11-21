import os from "node:os";
import { lstatSync } from "node:fs";

export default function checkBrowserOwner() {
  const owner = process.env.FLOWAI_BROWSER_OWNER;
  if (
    !owner || !/^\/tmp\/flowai-wui\.[A-Za-z0-9]{8}$/.test(owner) ||
    os.tmpdir() !== owner || process.env.FLOWAI_BROWSER_NATIVE_TMP !== owner
  ) {
    throw new Error("Web UI browser tests require an owned browser namespace");
  }
  const directory = lstatSync(owner);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o777) !== 0o700
  ) {
    throw new Error("Web UI browser namespace must be a private directory");
  }
}
