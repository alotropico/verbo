import koffi from "koffi";

const FO_DELETE = 3;
const FOF_ALLOWUNDO = 0x0040;
const FOF_NOCONFIRMATION = 0x0010;
const FOF_NOERRORUI = 0x0400;
const FOF_SILENT = 0x0004;

const shell32 = koffi.load("shell32.dll");
koffi.struct("SHFILEOPSTRUCTW", {
  hwnd: "void *",
  wFunc: "uint",
  pFrom: "uint16 *",
  pTo: "uint16 *",
  fFlags: "uint16",
  fAnyOperationsAborted: "int",
  hNameMappings: "void *",
  lpszProgressTitle: "uint16 *",
});
const SHFileOperationW = shell32.func(
  "int __stdcall SHFileOperationW(_Inout_ SHFILEOPSTRUCTW *op)",
);

/**
 * Sends one existing path to the Windows Recycle Bin.
 * `FOF_ALLOWUNDO` is required. A non-zero code is a failure and the path is left in place.
 */
export function trashItem(absolutePath: string): void {
  const chars = new Uint16Array(absolutePath.length + 2);
  for (let index = 0; index < absolutePath.length; index += 1) {
    const code = absolutePath.charCodeAt(index);
    if (code > 0xffff) {
      throw new Error("That path cannot be sent to the Recycle Bin.");
    }
    chars[index] = code;
  }
  const code = SHFileOperationW({
    hwnd: null,
    wFunc: FO_DELETE,
    pFrom: chars,
    pTo: null,
    fFlags: FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI,
    fAnyOperationsAborted: 0,
    hNameMappings: null,
    lpszProgressTitle: null,
  }) as number;
  if (code !== 0) {
    throw new Error(`Recycle Bin rejected the item (${code}).`);
  }
}
