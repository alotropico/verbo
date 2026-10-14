import koffi from "koffi";

let native: { attach: (pid: number) => () => void } | undefined;

/** An unnamed Windows job owns only our lazy browser worker and its descendants.
 * The non-inheritable handle prevents PID reuse from selecting unrelated processes.
 * https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects */
export function ownBrowserProcessTree(pid: number): () => void {
  if (process.platform !== "win32") return () => undefined;
  if (!Number.isInteger(pid) || pid < 1)
    throw new Error("browser_isolation_unavailable");
  if (!native) {
    const kernel = koffi.load("kernel32.dll");
    const basic = koffi.struct({
      PerProcessUserTimeLimit: "int64",
      PerJobUserTimeLimit: "int64",
      LimitFlags: "uint32",
      MinimumWorkingSetSize: "size_t",
      MaximumWorkingSetSize: "size_t",
      ActiveProcessLimit: "uint32",
      Affinity: "uintptr_t",
      PriorityClass: "uint32",
      SchedulingClass: "uint32",
    });
    const io = koffi.struct({
      ReadOperationCount: "uint64",
      WriteOperationCount: "uint64",
      OtherOperationCount: "uint64",
      ReadTransferCount: "uint64",
      WriteTransferCount: "uint64",
      OtherTransferCount: "uint64",
    });
    const limits = koffi.struct("VerboBrowserJobLimits", {
      BasicLimitInformation: basic,
      IoInfo: io,
      ProcessMemoryLimit: "size_t",
      JobMemoryLimit: "size_t",
      PeakProcessMemoryUsed: "size_t",
      PeakJobMemoryUsed: "size_t",
    });
    const create = kernel.func(
      "void * __stdcall CreateJobObjectW(void *attributes, str16 name)",
    );
    const configure = kernel.func(
      "bool __stdcall SetInformationJobObject(void *job, uint32 informationClass, VerboBrowserJobLimits *limits, uint32 length)",
    );
    const open = kernel.func(
      "void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)",
    );
    const assign = kernel.func(
      "bool __stdcall AssignProcessToJobObject(void *job, void *process)",
    );
    const close = kernel.func("bool __stdcall CloseHandle(void *handle)");
    native = {
      attach: (processId) => {
        const job = create(null, null) as bigint;
        if (!job) throw new Error("browser_isolation_unavailable");
        let processHandle: bigint | undefined;
        try {
          const configured = configure(
            job,
            9,
            {
              BasicLimitInformation: {
                PerProcessUserTimeLimit: 0,
                PerJobUserTimeLimit: 0,
                LimitFlags: 0x2000,
                MinimumWorkingSetSize: 0,
                MaximumWorkingSetSize: 0,
                ActiveProcessLimit: 0,
                Affinity: 0,
                PriorityClass: 0,
                SchedulingClass: 0,
              },
              IoInfo: {
                ReadOperationCount: 0,
                WriteOperationCount: 0,
                OtherOperationCount: 0,
                ReadTransferCount: 0,
                WriteTransferCount: 0,
                OtherTransferCount: 0,
              },
              ProcessMemoryLimit: 0,
              JobMemoryLimit: 0,
              PeakProcessMemoryUsed: 0,
              PeakJobMemoryUsed: 0,
            },
            koffi.sizeof(limits),
          );
          if (!configured) throw new Error("browser_isolation_unavailable");
          processHandle = open(0x0100 | 0x0001, false, processId) as bigint;
          if (!processHandle || !assign(job, processHandle))
            throw new Error("browser_isolation_unavailable");
        } catch (error) {
          close(job);
          throw error;
        } finally {
          if (processHandle) close(processHandle);
        }
        let released = false;
        return () => {
          if (!released) {
            released = true;
            close(job);
          }
        };
      },
    };
  }
  return native.attach(pid);
}
