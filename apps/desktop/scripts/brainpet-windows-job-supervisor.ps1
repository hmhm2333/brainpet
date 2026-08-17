param(
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$LaunchPermitPath,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$ResumePermitPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class BrainPetWindowsJobSupervisor
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_FAILED = 0xffffffff;
    private const uint INFINITE = 0xffffffff;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, uint informationLength, IntPtr returnLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    public static int Run(
        string command,
        string[] arguments,
        string currentDirectory,
        string[] environmentEntries,
        string runId,
        string readyPath,
        string resumePermitPath,
        string resultPath)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        bool jobAssigned = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            Ensure(job != IntPtr.Zero, "CreateJobObject");
            SetKillOnClose(job);

            environment = Marshal.StringToHGlobalUni(BuildEnvironmentBlock(environmentEntries));
            var startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(-10);
            startup.hStdOutput = GetStdHandle(-11);
            startup.hStdError = GetStdHandle(-12);
            var commandLine = new StringBuilder(BuildCommandLine(command, arguments));
            Ensure(CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                environment, currentDirectory, ref startup, out child), "CreateProcess");
            Ensure(AssignProcessToJobObject(job, child.hProcess), "AssignProcessToJobObject");
            jobAssigned = true;

            PublishJsonExclusive(readyPath, String.Format(
                "{{\"schemaVersion\":1,\"kind\":\"brainpet-windows-job-ready\",\"runId\":\"{0}\",\"pid\":{1}}}\n",
                JsonEscape(runId), child.dwProcessId));
            WaitForPermit(resumePermitPath, 30000);
            Ensure(ResumeThread(child.hThread) != 0xffffffff, "ResumeThread");
            uint wait = WaitForSingleObject(child.hProcess, INFINITE);
            Ensure(wait == WAIT_OBJECT_0, wait == WAIT_FAILED ? "WaitForSingleObject" : "Unexpected child wait result");
            uint exitCode;
            Ensure(GetExitCodeProcess(child.hProcess, out exitCode), "GetExitCodeProcess");

            uint remaining = QueryActiveProcesses(job);
            var quiescenceDeadline = Stopwatch.StartNew();
            while (remaining != 0 && quiescenceDeadline.ElapsedMilliseconds < 2000)
            {
                Thread.Sleep(50);
                remaining = QueryActiveProcesses(job);
            }
            bool quiescent = remaining == 0;
            if (!quiescent)
            {
                Ensure(TerminateJobObject(job, 254), "TerminateJobObject");
                var deadline = Stopwatch.StartNew();
                while (QueryActiveProcesses(job) != 0 && deadline.ElapsedMilliseconds < 10000) Thread.Sleep(50);
                Ensure(QueryActiveProcesses(job) == 0, "Job process tree did not terminate");
            }
            PublishJsonExclusive(resultPath, String.Format(
                "{{\"schemaVersion\":1,\"kind\":\"brainpet-windows-job-result\",\"runId\":\"{0}\",\"pid\":{1},\"exitCode\":{2},\"jobQuiescent\":{3},\"remainingProcesses\":{4}}}\n",
                JsonEscape(runId), child.dwProcessId, exitCode, quiescent ? "true" : "false", remaining));
            return quiescent && exitCode == 0 ? 0 : 1;
        }
        catch
        {
            if (jobAssigned) TerminateJobObject(job, 255);
            throw;
        }
        finally
        {
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    private static void SetKillOnClose(IntPtr job)
    {
        var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            Ensure(SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size), "SetInformationJobObject");
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    private static uint QueryActiveProcesses(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
        Ensure(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out information,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero), "QueryInformationJobObject");
        return information.ActiveProcesses;
    }

    private static void WaitForPermit(string path, int timeoutMilliseconds)
    {
        var timer = Stopwatch.StartNew();
        while (!File.Exists(path))
        {
            if (timer.ElapsedMilliseconds >= timeoutMilliseconds) throw new TimeoutException("Timed out waiting for the BrainPet job resume permit.");
            Thread.Sleep(25);
        }
    }

    private static string BuildEnvironmentBlock(string[] entries)
    {
        return String.Join("\0", entries.OrderBy(value => value, StringComparer.OrdinalIgnoreCase)) + "\0\0";
    }

    private static string BuildCommandLine(string command, string[] arguments)
    {
        var values = new List<string>();
        values.Add(QuoteArgument(command));
        values.AddRange(arguments.Select(QuoteArgument));
        return String.Join(" ", values);
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        var output = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            if (character == '"')
            {
                output.Append('\\', backslashes * 2 + 1);
                output.Append('"');
                backslashes = 0;
                continue;
            }
            output.Append('\\', backslashes);
            backslashes = 0;
            output.Append(character);
        }
        output.Append('\\', backslashes * 2);
        output.Append('"');
        return output.ToString();
    }

    private static void PublishJsonExclusive(string path, string json)
    {
        string temporary = path + "." + Process.GetCurrentProcess().Id + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temporary, json, new UTF8Encoding(false));
        try { File.Move(temporary, path); }
        catch { try { File.Delete(temporary); } catch { } throw; }
    }

    private static string JsonEscape(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private static void Ensure(bool condition, string operation)
    {
        if (!condition) throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }
}
'@

$launchDeadline = [Diagnostics.Stopwatch]::StartNew()
while (-not [IO.File]::Exists($LaunchPermitPath)) {
  if ($launchDeadline.ElapsedMilliseconds -ge 30000) { throw "Timed out waiting for the BrainPet job launch permit." }
  Start-Sleep -Milliseconds 25
}

$spec = $env:BRAINPET_WRAPPED_CHILD_SPEC | ConvertFrom-Json
if ($null -eq $spec -or [string]::IsNullOrWhiteSpace([string]$spec.command) -or $null -eq $spec.args -or [string]::IsNullOrWhiteSpace([string]$spec.cwd) -or $null -eq $spec.environmentEntries) {
  throw "BrainPet wrapped child specification is invalid."
}
$environmentEntries = [string[]]@($spec.environmentEntries)
$exitCode = [BrainPetWindowsJobSupervisor]::Run(
  [string]$spec.command,
  [string[]]@($spec.args),
  [string]$spec.cwd,
  [string[]]$environmentEntries,
  $RunId,
  $ReadyPath,
  $ResumePermitPath,
  $ResultPath
)
exit $exitCode
