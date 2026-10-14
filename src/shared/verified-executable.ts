import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute } from "node:path";

/** Registration is explicit user trust. PE inspection rules out renamed scripts/launchers. */
export function executableIdentity(candidate: string): {
  path: string;
  identity: string;
} {
  if (
    !isAbsolute(candidate) ||
    candidate.includes("\0") ||
    extname(candidate).toLowerCase() !== ".exe"
  )
    throw new Error(
      "Choose an absolute Windows executable (.exe), not a shell script.",
    );
  if (lstatSync(candidate).isSymbolicLink())
    throw new Error("Register the executable itself, not a link.");
  const path = realpathSync(candidate);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 64)
    throw new Error("That executable is not a regular program file.");
  const file = openSync(path, "r");
  try {
    const header = Buffer.alloc(64);
    if (
      readSync(file, header, 0, 64, 0) !== 64 ||
      header.readUInt16LE(0) !== 0x5a4d
    )
      throw new Error("That file is not a Windows executable.");
    const offset = header.readUInt32LE(0x3c);
    const signature = Buffer.alloc(4);
    if (
      offset < 64 ||
      offset > Math.min(stat.size - 4, 1024 * 1024) ||
      readSync(file, signature, 0, 4, offset) !== 4 ||
      signature.readUInt32LE(0) !== 0x4550
    )
      throw new Error("That file has no valid Windows executable header.");
  } finally {
    closeSync(file);
  }
  return {
    path,
    identity: `${path.toLowerCase()}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
  };
}
