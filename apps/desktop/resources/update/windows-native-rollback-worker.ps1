param([Parameter(Mandatory = $true)][string]$PlanPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace HarnessDesktopUpdate {
  public sealed class CandidateJob : IDisposable {
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 258;
    const int JobObjectBasicProcessIdList = 3;
    const int JobObjectExtendedLimitInformation = 9;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle; public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags; public ushort wShowWindow; public ushort cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS { public BASIC_LIMITS BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    IntPtr job; IntPtr process; public readonly int ProcessId;
    CandidateJob(IntPtr jobHandle, IntPtr processHandle, int processId) { job = jobHandle; process = processHandle; ProcessId = processId; }
    static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static CandidateJob Launch(string executable) { return LaunchWithArguments(executable, ""); }
    public static CandidateJob LaunchWithArguments(string executable, string arguments) { return LaunchWithArgumentsCore(executable, arguments, false); }
    public static CandidateJob LaunchWithArguments(string executable, string arguments, string workingDirectory) { return LaunchWithArgumentsCoreWithDirectory(executable, arguments, workingDirectory, false); }
    public static CandidateJob Capture(int processId, IntPtr processHandle) {
      IntPtr job = CreateJobObjectW(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        EXTENDED_LIMITS limits = new EXTENDED_LIMITS(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(EXTENDED_LIMITS)); IntPtr buffer = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(limits, buffer, false); Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size)); } finally { Marshal.FreeHGlobal(buffer); }
        Check(AssignProcessToJobObject(job, processHandle));
        CandidateJob result = new CandidateJob(job, IntPtr.Zero, processId); job = IntPtr.Zero; return result;
      } finally { if (job != IntPtr.Zero) CloseHandle(job); }
    }
    public void Assign(IntPtr processHandle) { Check(AssignProcessToJobObject(job, processHandle)); }
    static CandidateJob LaunchWithArgumentsCore(string executable, string arguments, bool forceAssignmentFailure) { return LaunchWithArgumentsCoreWithDirectory(executable, arguments, null, forceAssignmentFailure); }
    static CandidateJob LaunchWithArgumentsCoreWithDirectory(string executable, string arguments, string workingDirectory, bool forceAssignmentFailure) {
      IntPtr job = IntPtr.Zero; PROCESS_INFORMATION info = new PROCESS_INFORMATION(); bool created = false; bool assigned = false;
      try {
        job = CreateJobObjectW(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        EXTENDED_LIMITS limits = new EXTENDED_LIMITS(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(EXTENDED_LIMITS)); IntPtr buffer = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(limits, buffer, false); Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size)); } finally { Marshal.FreeHGlobal(buffer); }
        STARTUPINFO startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)); StringBuilder command = new StringBuilder("\"" + executable.Replace("\"", "\\\"") + "\"" + (arguments.Length == 0 ? "" : " " + arguments));
        Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, workingDirectory, ref startup, out info));
        created = true; if (forceAssignmentFailure) throw new Exception("candidate Job assignment failed by test injection");
        Check(AssignProcessToJobObject(job, info.hProcess)); assigned = true; if (ResumeThread(info.hThread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error()); CloseHandle(info.hThread); info.hThread = IntPtr.Zero;
        CandidateJob result = new CandidateJob(job, info.hProcess, (int)info.dwProcessId); job = IntPtr.Zero; info.hProcess = IntPtr.Zero; return result;
      } finally { Exception cleanupError = null; if (created && !assigned && info.hProcess != IntPtr.Zero) { if (!TerminateProcess(info.hProcess, 1)) cleanupError = new Win32Exception(Marshal.GetLastWin32Error()); else if (WaitForSingleObject(info.hProcess, 30000) != WAIT_OBJECT_0) cleanupError = new Exception("unassigned candidate did not terminate"); } if (info.hThread != IntPtr.Zero) CloseHandle(info.hThread); if (info.hProcess != IntPtr.Zero) CloseHandle(info.hProcess); if (job != IntPtr.Zero) CloseHandle(job); if (cleanupError != null) throw cleanupError; }
    }
    public static int LaunchBreakaway(string executable) { return LaunchBreakaway(executable, null); }
    public static int LaunchBreakaway(string executable, string workingDirectory) {
      PROCESS_INFORMATION info = new PROCESS_INFORMATION();
      try {
        STARTUPINFO startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)); StringBuilder command = new StringBuilder("\"" + executable.Replace("\"", "\\\"") + "\"");
        Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false, CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, workingDirectory, ref startup, out info));
        return (int)info.dwProcessId;
      } finally { if (info.hThread != IntPtr.Zero) CloseHandle(info.hThread); if (info.hProcess != IntPtr.Zero) CloseHandle(info.hProcess); }
    }
    public ulong[] ProcessIds() { int capacity = 64; while (true) { int bytes = 8 + IntPtr.Size * capacity; IntPtr buffer = Marshal.AllocHGlobal(bytes); try { Marshal.WriteInt32(buffer, 0, capacity); uint returned; if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)bytes, out returned)) { int error = Marshal.GetLastWin32Error(); if (error == 234) { capacity *= 2; continue; } throw new Win32Exception(error); } int count = Marshal.ReadInt32(buffer, 4); ulong[] ids = new ulong[count]; for (int i=0;i<count;i++) ids[i] = IntPtr.Size == 8 ? (ulong)Marshal.ReadInt64(buffer, 8+i*8) : (uint)Marshal.ReadInt32(buffer, 8+i*4); return ids; } finally { Marshal.FreeHGlobal(buffer); } } }
    public bool HasMembers { get { return ProcessIds().Length != 0; } }
    public void TerminateAndWait(int timeoutMs) { Check(TerminateJobObject(job, 1)); Stopwatch timer = Stopwatch.StartNew(); while (timer.ElapsedMilliseconds < timeoutMs) { if (!HasMembers) return; Thread.Sleep(25); } if (HasMembers) throw new Exception("candidate Job Object did not become empty"); }
    public void ReleaseHealthy() { if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT) throw new Exception("candidate Main exited before healthy Job release"); EXTENDED_LIMITS limits = new EXTENDED_LIMITS(); int size = Marshal.SizeOf(typeof(EXTENDED_LIMITS)); IntPtr buffer = Marshal.AllocHGlobal(size); try { Marshal.StructureToPtr(limits, buffer, false); Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size)); } finally { Marshal.FreeHGlobal(buffer); } Dispose(); }
    public void Dispose() { if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; } if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; } }
  }
}
'@

function Require-Property([object]$Value, [string]$Name) {
  if ($null -eq $Value.PSObject.Properties[$Name]) { throw "Harness Desktop rollback request omits $Name" }
  return $Value.$Name
}

function Test-ExactProperties([object]$Value, [string[]]$Expected) {
  $Actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $SortedExpected = @($Expected | Sort-Object)
  return ($Actual -join ',') -eq ($SortedExpected -join ',')
}

function Require-AbsolutePath([object]$Value, [string]$Name) {
  $Path = [string](Require-Property $Value $Name)
  if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)') { throw "Harness Desktop rollback request has a relative $Name" }
  return [System.IO.Path]::GetFullPath($Path)
}

function Test-SemanticVersion([string]$Version) {
  return $Version -match '^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
}

function Test-Uuid([object]$Value) {
  return $Value -is [string] -and $Value -match '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
}

function Test-PositiveInteger([object]$Value) {
  if ($Value -isnot [byte] -and $Value -isnot [int16] -and $Value -isnot [int32] -and $Value -isnot [int64]) { return $false }
  return [int64]$Value -gt 0
}

function Test-BoundedTimeout([object]$Value) {
  return (Test-PositiveInteger $Value) -and [int64]$Value -ge 30000 -and [int64]$Value -le 600000
}

function Test-EpochMilliseconds([object]$Value) {
  if ($Value -isnot [byte] -and $Value -isnot [int16] -and $Value -isnot [int32] -and $Value -isnot [int64] -and $Value -isnot [double]) { return $false }
  return [double]$Value -gt 0 -and [double]$Value -le 9007199254740991 -and [double]$Value -eq [math]::Floor([double]$Value)
}

function Assert-ProcessReference([object]$Value, [string]$Name) {
  if ($Value -isnot [pscustomobject] -or -not (Test-ExactProperties $Value @('processId', 'executablePath', 'startedBeforeMs'))) {
    throw "Harness Desktop rollback request has an invalid $Name"
  }
  $ProcessId = Require-Property $Value 'processId'
  $ExecutablePath = Require-AbsolutePath $Value 'executablePath'
  $StartedBeforeMs = Require-Property $Value 'startedBeforeMs'
  if (-not (Test-PositiveInteger $ProcessId) -or -not (Test-EpochMilliseconds $StartedBeforeMs)) {
    throw "Harness Desktop rollback request has an invalid $Name"
  }
  return [pscustomobject]@{
    processId = [int]$ProcessId
    executablePath = $ExecutablePath
    startedBeforeMs = [int64]$StartedBeforeMs
  }
}

function Get-ExpectedProcess([pscustomobject]$Reference) {
  $Process = $null
  try {
    $Process = [System.Diagnostics.Process]::GetProcessById($Reference.processId)
  } catch [System.ArgumentException] {
    return $null
  }
  try {
    $Process.Refresh()
    if ($Process.HasExited) { return $null }
    $Module = $Process.MainModule
    if ($null -eq $Module) { throw 'Harness Desktop rollback worker cannot read the expected process identity' }
    $ExecutablePath = [System.IO.Path]::GetFullPath($Module.FileName)
    $StartedAtMs = ([DateTimeOffset]$Process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
    if (-not $ExecutablePath.Equals($Reference.executablePath, [System.StringComparison]::OrdinalIgnoreCase) -or $StartedAtMs -gt $Reference.startedBeforeMs) {
      return $null
    }
    $Expected = $Process
    $Process = $null
    return $Expected
  } catch [System.InvalidOperationException] {
    # Process identity members throw this only when the inspected process exited during the lookup.
    return $null
  } finally {
    if ($null -ne $Process) { $Process.Dispose() }
  }
}

function Test-ExpectedProcessAlive([pscustomobject]$Reference) {
  if ($null -ne $Reference.PSObject.Properties['job']) { return $Reference.job.HasMembers }
  $Process = Get-ExpectedProcess $Reference
  if ($null -eq $Process) { return $false }
  try { return $true } finally { $Process.Dispose() }
}

function Stop-ExpectedProcess([pscustomobject]$Reference, [int]$TimeoutMs, [scriptblock]$AfterSnapshot = $null) {
  $Process = Get-ExpectedProcess $Reference
  if ($null -eq $Process) { return }
  $Timer = [System.Diagnostics.Stopwatch]::StartNew()
  $TerminationJob = $null
  $KnownAncestors = @{}
  try {
    $Remaining = Get-RemainingProcessInspectionTimeout $Timer.ElapsedMilliseconds $TimeoutMs
    $KnownAncestors[$Process.Id] = Get-ExactProcessIdentity $Process $Timer $TimeoutMs
    if ($Timer.ElapsedMilliseconds -ge $TimeoutMs) { throw 'Harness Desktop rollback worker process-tree inspection timed out' }
    $TerminationJob = [HarnessDesktopUpdate.CandidateJob]::Capture($Process.Id, $Process.Handle)
    $FixedPointScans = 0
    while ($FixedPointScans -lt 2) {
      $Remaining = $TimeoutMs - [int]$Timer.ElapsedMilliseconds
      if ($Remaining -le 0) { throw 'Harness Desktop rollback worker process-tree inspection timed out' }
      $KnownBefore = $KnownAncestors.Count
      $BoundTree = @(Get-BoundProcessTree $Process $KnownAncestors $Remaining $Timer $TimeoutMs)
      if ($Timer.ElapsedMilliseconds -ge $TimeoutMs) { throw 'Harness Desktop rollback worker process-tree inspection timed out' }
      if ($null -ne $AfterSnapshot) { & $AfterSnapshot; $AfterSnapshot = $null }
      try {
        foreach ($Bound in @($BoundTree)) {
          if ($Bound.Id -eq $Process.Id) { continue }
          try { if (-not $Bound.HasExited) { $TerminationJob.Assign($Bound.Handle) } } catch [System.InvalidOperationException] { # The identity-bound descendant exited before Job assignment.
          }
        }
      } finally {
        foreach ($Bound in @($BoundTree)) { if ($Bound.Id -ne $Process.Id) { $Bound.Dispose() } }
      }
      if ($KnownAncestors.Count -eq $KnownBefore) { $FixedPointScans += 1 } else { $FixedPointScans = 0 }
      if ($FixedPointScans -lt 2) { Start-Sleep -Milliseconds 25 }
    }
    $Remaining = [math]::Max(1, $TimeoutMs - [int]$Timer.ElapsedMilliseconds)
    $TerminationJob.TerminateAndWait($Remaining)
  } finally {
    if ($null -ne $TerminationJob) { $TerminationJob.Dispose() }
    $Process.Dispose()
  }
}

function Get-BoundProcessTree([System.Diagnostics.Process]$Root, [hashtable]$KnownAncestors, [int]$TimeoutMs, [System.Diagnostics.Stopwatch]$Timer, [int]$TotalTimeoutMs) {
  [void]$Root.Handle
  $Searcher = New-BoundedManagementSearcher 'SELECT ProcessId, ParentProcessId, ExecutablePath, CreationDate FROM Win32_Process' $TimeoutMs
  $Rows = $null
  $Pairs = @()
  try {
    $Rows = $Searcher.Get()
    foreach ($Row in $Rows) {
      $Pairs += [pscustomobject]@{
        processId = [int]$Row.ProcessId
        parentProcessId = [int]$Row.ParentProcessId
        executablePath = if ($null -eq $Row.ExecutablePath) { $null } else { [System.IO.Path]::GetFullPath([string]$Row.ExecutablePath) }
        creationDate = if ($null -eq $Row.CreationDate) { $null } else { [string]$Row.CreationDate }
      }
    }
  } finally {
    if ($null -ne $Rows) { $Rows.Dispose() }
    $Searcher.Dispose()
  }
  if ($Timer.ElapsedMilliseconds -ge $TotalTimeoutMs) { throw 'Harness Desktop rollback worker process-tree inspection timed out' }
  if ($KnownAncestors.Count -eq 0) {
    $RootPair = $Pairs | Where-Object { $_.processId -eq $Root.Id } | Select-Object -First 1
    if ($null -eq $RootPair -or $null -eq $RootPair.executablePath -or $null -eq $RootPair.creationDate) {
      throw 'Harness Desktop rollback worker cannot bind the expected process topology'
    }
    $KnownAncestors[$Root.Id] = $RootPair
  }
  foreach ($KnownProcessId in @($KnownAncestors.Keys)) {
    $Current = $Pairs | Where-Object { $_.processId -eq $KnownProcessId } | Select-Object -First 1
    if ($null -ne $Current) {
      $Expected = $KnownAncestors[$KnownProcessId]
      $IdentityChanged = $null -eq $Current.executablePath -or $null -eq $Current.creationDate
      $IdentityChanged = $IdentityChanged -or -not $Current.executablePath.Equals($Expected.executablePath, [System.StringComparison]::OrdinalIgnoreCase)
      $IdentityChanged = $IdentityChanged -or $Current.creationDate -ne $Expected.creationDate
      if ($IdentityChanged) {
        throw 'Harness Desktop rollback worker detected a recycled process-tree identity'
      }
    }
  }
  $Tree = [System.Collections.Generic.List[int]]::new()
  foreach ($KnownProcessId in @($KnownAncestors.Keys)) { $Tree.Add([int]$KnownProcessId) }
  for ($Index = 0; $Index -lt $Tree.Count; $Index += 1) {
    $ParentProcessId = $Tree[$Index]
    foreach ($Pair in $Pairs) {
      if ($Pair.parentProcessId -eq $ParentProcessId -and -not $Tree.Contains($Pair.processId)) {
        Assert-CompleteLiveProcessIdentity $Pair
        $Tree.Add($Pair.processId)
        if (-not $KnownAncestors.ContainsKey($Pair.processId)) {
          $KnownAncestors[$Pair.processId] = $Pair
        }
      }
    }
  }
  $Bound = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
  $Bound.Add($Root)
  foreach ($ProcessId in @($Tree | Where-Object { $_ -ne $Root.Id })) {
    $Pair = $Pairs | Where-Object { $_.processId -eq $ProcessId } | Select-Object -First 1
    Assert-CompleteLiveProcessIdentity $Pair
    $Process = $null
    try {
      $Process = [System.Diagnostics.Process]::GetProcessById($ProcessId)
      $Remaining = $TotalTimeoutMs - [int]$Timer.ElapsedMilliseconds
      if ($Remaining -le 0) { throw 'Harness Desktop rollback worker process-tree inspection timed out' }
      if (Test-BoundProcessIdentity $Process $Pair.executablePath $Pair.creationDate $Remaining) {
        $Bound.Add($Process)
        $Process = $null
      } else { Assert-BoundLiveProcess $Process $false }
    } catch [System.ArgumentException] { # The discovered descendant exited before its handle could be bound.
    } catch [System.InvalidOperationException] { # The discovered descendant exited during identity capture.
    } finally {
      if ($null -ne $Process) { $Process.Dispose() }
    }
  }
  return $Bound.ToArray()
}

function Assert-CompleteLiveProcessIdentity([object]$Identity) {
  if ($null -eq $Identity -or $null -eq $Identity.executablePath -or $null -eq $Identity.creationDate) {
    throw 'Harness Desktop rollback worker cannot bind a live descendant identity'
  }
}

function Assert-BoundLiveProcess([System.Diagnostics.Process]$Process, [bool]$IdentityMatches) {
  if (-not $IdentityMatches -and -not $Process.HasExited) {
    throw 'Harness Desktop rollback worker detected an unbound live descendant'
  }
}

function Test-BoundProcessIdentity([System.Diagnostics.Process]$Process, [string]$ExpectedPath, [string]$ExpectedCreationDate, [int]$TimeoutMs = 5000) {
  [void]$Process.Handle
  $Process.Refresh()
  $ExecutablePath = [System.IO.Path]::GetFullPath($Process.MainModule.FileName)
  if (-not $ExecutablePath.Equals($ExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  $Searcher = New-BoundedManagementSearcher "SELECT ExecutablePath, CreationDate FROM Win32_Process WHERE ProcessId = $($Process.Id)" $TimeoutMs
  $Rows = $null
  try {
    $Rows = $Searcher.Get()
    $Current = @($Rows | Select-Object -First 1)[0]
    if ($null -eq $Current -or $null -eq $Current.ExecutablePath -or $null -eq $Current.CreationDate) { return $false }
    return [System.IO.Path]::GetFullPath([string]$Current.ExecutablePath).Equals($ExpectedPath, [System.StringComparison]::OrdinalIgnoreCase) -and [string]$Current.CreationDate -eq $ExpectedCreationDate
  } finally {
    if ($null -ne $Rows) { $Rows.Dispose() }
    $Searcher.Dispose()
  }
}

function Get-ExactProcessIdentity([System.Diagnostics.Process]$Process, [System.Diagnostics.Stopwatch]$Timer, [int]$TotalTimeoutMs) {
  $Remaining = Get-RemainingProcessInspectionTimeout $Timer.ElapsedMilliseconds $TotalTimeoutMs
  $Searcher = New-BoundedManagementSearcher "SELECT ProcessId, ExecutablePath, CreationDate FROM Win32_Process WHERE ProcessId = $($Process.Id)" $Remaining
  $Rows = $null
  try {
    $Rows = $Searcher.Get()
    $Row = @($Rows | Select-Object -First 1)[0]
    $Identity = [pscustomobject]@{
      processId = $Process.Id
      executablePath = if ($null -eq $Row -or $null -eq $Row.ExecutablePath) { $null } else { [System.IO.Path]::GetFullPath([string]$Row.ExecutablePath) }
      creationDate = if ($null -eq $Row -or $null -eq $Row.CreationDate) { $null } else { [string]$Row.CreationDate }
    }
    Assert-CompleteLiveProcessIdentity $Identity
    $Remaining = Get-RemainingProcessInspectionTimeout $Timer.ElapsedMilliseconds $TotalTimeoutMs
    if (-not (Test-BoundProcessIdentity $Process $Identity.executablePath $Identity.creationDate $Remaining)) {
      throw 'Harness Desktop rollback worker cannot bind the expected root identity'
    }
    [void](Get-RemainingProcessInspectionTimeout $Timer.ElapsedMilliseconds $TotalTimeoutMs)
    return $Identity
  } finally {
    if ($null -ne $Rows) { $Rows.Dispose() }
    $Searcher.Dispose()
  }
}

function Get-RemainingProcessInspectionTimeout([int64]$ElapsedMilliseconds, [int]$TotalTimeoutMs) {
  $Remaining = [int64]$TotalTimeoutMs - $ElapsedMilliseconds
  if ($Remaining -le 0 -or $Remaining -gt [int]::MaxValue) {
    throw 'Harness Desktop rollback worker process-tree inspection timed out'
  }
  return [int]$Remaining
}

function New-BoundedManagementSearcher([string]$Query, [int]$TimeoutMs) {
  if ($TimeoutMs -le 0) { throw 'Harness Desktop rollback worker WMI timeout is invalid' }
  $Searcher = [System.Management.ManagementObjectSearcher]::new($Query)
  $Searcher.Options.Timeout = [TimeSpan]::FromMilliseconds($TimeoutMs)
  return $Searcher
}

function Test-ProcessIdAlive([int]$ProcessId) {
  $Process = $null
  try {
    $Process = [System.Diagnostics.Process]::GetProcessById($ProcessId)
  } catch [System.ArgumentException] {
    return $false
  }
  try { return -not $Process.HasExited } catch [System.InvalidOperationException] {
    return $false
  } finally {
    if ($null -ne $Process) { $Process.Dispose() }
  }
}

function Wait-ForOwnedParentExit([System.Diagnostics.Process]$Parent, [int]$TimeoutMs) {
  try {
    return $Parent.WaitForExit($TimeoutMs)
  } catch [System.InvalidOperationException] {
    # The owned handle can throw only after the expected parent has already exited.
    return $true
  }
}

function Wait-ForOwnedParentExitBeforeCandidate([System.Diagnostics.Process]$Parent, [int]$TimeoutMs) {
  try {
    return $Parent.WaitForExit($TimeoutMs)
  } catch [System.InvalidOperationException] {
    # The owned handle can throw only after the expected parent has already exited.
    return $true
  }
}

function Wait-ForReferencedProcessExitBeforeCandidate([pscustomobject]$Reference, [int]$TimeoutMs) {
  $Timer = [System.Diagnostics.Stopwatch]::StartNew()
  while (Test-ExpectedProcessAlive $Reference) {
    if ($Timer.ElapsedMilliseconds -ge $TimeoutMs) { return $false }
    Start-Sleep -Milliseconds 100
  }
  return $true
}

function Stop-CandidateForRollback([pscustomobject]$Reference, [int]$TimeoutMs) {
  if ($null -ne $Reference.PSObject.Properties['job']) { $Reference.job.TerminateAndWait($TimeoutMs); return }
  Stop-ExpectedProcess $Reference $TimeoutMs
  if (-not (Wait-ForReferencedProcessExitBeforeCandidate $Reference $TimeoutMs)) {
    throw 'Harness Desktop rollback watchdog could not stop the unhealthy candidate'
  }
}

function Assert-RollbackPlan([object]$Plan, [bool]$Watch) {
  $Names = @('schemaVersion', 'platform', 'parentProcess', 'applicationPath', 'rollbackArtifactPath', 'rollbackSha256', 'rollbackFormat', 'healthCheckTimeoutMs')
  if ($Watch) { $Names += @('candidateArtifactPath', 'candidateSha256', 'candidateFormat', 'journalPath', 'candidateVersion', 'transactionId') }
  elseif ($Plan.PSObject.Properties.Name -contains 'transactionId') { $Names += 'transactionId' }
  if ($Plan -isnot [pscustomobject] -or -not (Test-ExactProperties $Plan $Names)) { throw 'Harness Desktop rollback request has unsupported fields' }
  if ((Require-Property $Plan 'schemaVersion') -ne 1 -or (Require-Property $Plan 'platform') -ne 'win32' -or (Require-Property $Plan 'rollbackFormat') -ne 'nsis') {
    throw 'Harness Desktop rollback request is not a Windows NSIS operation'
  }
  $ParentProcess = Assert-ProcessReference (Require-Property $Plan 'parentProcess') 'parentProcess'
  $HealthCheckTimeoutMs = Require-Property $Plan 'healthCheckTimeoutMs'
  if (-not (Test-BoundedTimeout $HealthCheckTimeoutMs)) {
    throw 'Harness Desktop rollback request process or timeout is invalid'
  }
  $ApplicationPath = Require-AbsolutePath $Plan 'applicationPath'
  $RollbackArtifactPath = Require-AbsolutePath $Plan 'rollbackArtifactPath'
  if (-not $ApplicationPath.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase) -or -not $RollbackArtifactPath.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Harness Desktop rollback request executable paths are invalid'
  }
  $RollbackSha256 = [string](Require-Property $Plan 'rollbackSha256')
  if (-not [System.Text.RegularExpressions.Regex]::IsMatch($RollbackSha256, '^[0-9a-f]{64}$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
    throw 'Harness Desktop rollback request digest is invalid'
  }
  $Result = [ordered]@{
    parentProcess = $ParentProcess
    applicationPath = $ApplicationPath
    rollbackArtifactPath = $RollbackArtifactPath
    rollbackSha256 = $RollbackSha256
    healthCheckTimeoutMs = [int]$HealthCheckTimeoutMs
  }
  if (-not $Watch -and $Plan.PSObject.Properties.Name -contains 'transactionId') {
    $TransactionId = [string](Require-Property $Plan 'transactionId')
    if (-not (Test-Uuid $TransactionId)) { throw 'Harness Desktop rollback transaction is invalid' }
    $Result.transactionId = $TransactionId
  }
  if ($Watch) {
    $CandidateArtifactPath = Require-AbsolutePath $Plan 'candidateArtifactPath'
    $CandidateSha256 = [string](Require-Property $Plan 'candidateSha256')
    $CandidateFormat = [string](Require-Property $Plan 'candidateFormat')
    $CandidateVersion = [string](Require-Property $Plan 'candidateVersion')
    $TransactionId = [string](Require-Property $Plan 'transactionId')
    if (-not $CandidateArtifactPath.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase) -or $CandidateFormat -ne 'nsis' -or -not [System.Text.RegularExpressions.Regex]::IsMatch($CandidateSha256, '^[0-9a-f]{64}$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) -or -not (Test-SemanticVersion $CandidateVersion) -or -not (Test-Uuid $TransactionId)) {
      throw 'Harness Desktop rollback watchdog fields are invalid'
    }
    $Result.candidateArtifactPath = $CandidateArtifactPath
    $Result.candidateSha256 = $CandidateSha256
    $Result.journalPath = Require-AbsolutePath $Plan 'journalPath'
    $Result.candidateVersion = $CandidateVersion
    $Result.transactionId = $TransactionId
  }
  return [pscustomobject]$Result
}

function Assert-WatchState([object]$State, [string]$CandidateVersion, [string]$TransactionId) {
  $Required = @('schemaVersion', 'transactionId', 'phase', 'currentVersion', 'version', 'channel', 'format', 'sha256', 'rollbackFormat', 'rollbackSha256')
  $WithCandidate = @($Required + 'candidateProcess')
  if ($State -isnot [pscustomobject] -or (-not (Test-ExactProperties $State $Required) -and -not (Test-ExactProperties $State $WithCandidate))) {
    throw 'Harness Desktop rollback watchdog journal has unsupported fields'
  }
  if ((Require-Property $State 'schemaVersion') -ne 1 -or (Require-Property $State 'version') -ne $CandidateVersion -or (Require-Property $State 'transactionId') -ne $TransactionId -or -not (Test-SemanticVersion ([string](Require-Property $State 'version'))) -or -not (Test-Uuid ([string](Require-Property $State 'transactionId')))) {
    throw 'Harness Desktop rollback watchdog journal is invalid'
  }
  $Phase = [string](Require-Property $State 'phase')
  if ($Phase -notin @('awaiting-dashboard-health', 'dashboard-health-checking', 'rollback-scheduled', 'applied')) {
    throw 'Harness Desktop rollback watchdog phase is invalid'
  }
  $HasCandidate = Test-ExactProperties $State $WithCandidate
  if ($Phase -eq 'awaiting-dashboard-health') {
    if ($HasCandidate) { throw 'Harness Desktop rollback watchdog awaiting journal has a candidate process' }
    return [pscustomobject]@{ phase = $Phase }
  }
  if ($Phase -eq 'dashboard-health-checking' -or $Phase -eq 'rollback-scheduled') {
    if (-not $HasCandidate) { throw 'Harness Desktop rollback watchdog journal omits the candidate process' }
    return [pscustomobject]@{ phase = $Phase; candidateProcess = Assert-ProcessReference (Require-Property $State 'candidateProcess') 'candidateProcess' }
  }
  if ($HasCandidate) {
    return [pscustomobject]@{ phase = $Phase; candidateProcess = Assert-ProcessReference (Require-Property $State 'candidateProcess') 'candidateProcess' }
  }
  return [pscustomobject]@{ phase = $Phase }
}

function Read-WatchState([string]$JournalPath, [string]$CandidateVersion, [string]$TransactionId) {
  if (-not (Test-Path -LiteralPath $JournalPath -PathType Leaf)) { return $null }
  try {
    $State = Get-Content -LiteralPath $JournalPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw 'Harness Desktop rollback watchdog journal is malformed'
  }
  return Assert-WatchState $State $CandidateVersion $TransactionId
}

function Get-ReadyPath([string]$RollbackArtifactPath, [string]$WorkerId) {
  $UpdatesDirectory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($RollbackArtifactPath))
  return Join-Path (Join-Path $UpdatesDirectory 'workers') "native-rollback-ready-$WorkerId.json"
}

function Get-FailurePath([string]$WorkerDirectory, [string]$WorkerId) {
  return Join-Path $WorkerDirectory "native-rollback-failure-$WorkerId.json"
}

function Get-AppliedPath([string]$RollbackArtifactPath, [string]$TransactionId) {
  $UpdatesDirectory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($RollbackArtifactPath))
  return Join-Path (Join-Path $UpdatesDirectory 'workers') "native-update-applied-$TransactionId.json"
}

function Get-HeartbeatPath([string]$RollbackArtifactPath, [string]$TransactionId) {
  $UpdatesDirectory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($RollbackArtifactPath))
  return Join-Path (Join-Path $UpdatesDirectory 'workers') "native-update-heartbeat-$TransactionId.json"
}

function Get-RolledBackPath([string]$RollbackArtifactPath, [string]$TransactionId) {
  $UpdatesDirectory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($RollbackArtifactPath))
  return Join-Path (Join-Path $UpdatesDirectory 'workers') "native-update-rolled-back-$TransactionId.json"
}

function Open-VerifiedInstallerSnapshot([string]$SnapshotPath, [string]$ExpectedSha256, [string]$Name) {
  $Snapshot = $null
  $Hasher = $null
  $Complete = $false
  try {
    $Snapshot = [System.IO.File]::Open($SnapshotPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    $Digest = -join ($Hasher.ComputeHash($Snapshot) | ForEach-Object { $_.ToString('x2') })
    if (-not $Digest.Equals($ExpectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Harness Desktop $Name installer digest changed"
    }
    $Snapshot.Position = 0
    $Complete = $true
    return $Snapshot
  } finally {
    if ($null -ne $Hasher) { $Hasher.Dispose() }
    if (-not $Complete -and $null -ne $Snapshot) { $Snapshot.Dispose() }
  }
}

function New-VerifiedInstallerSnapshot([string]$SourcePath, [string]$SnapshotPath, [string]$ExpectedSha256, [string]$Name) {
  $Source = $null
  $Snapshot = $null
  $Hasher = $null
  $RetainedSnapshot = $null
  $Complete = $false
  try {
    $Source = [System.IO.File]::Open($SourcePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $Snapshot = [System.IO.File]::Open($SnapshotPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $Source.CopyTo($Snapshot)
    $Snapshot.Flush($true)
    $Snapshot.Position = 0
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    $Digest = -join ($Hasher.ComputeHash($Snapshot) | ForEach-Object { $_.ToString('x2') })
    if (-not $Digest.Equals($ExpectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Harness Desktop $Name installer digest changed"
    }
    $Snapshot.Dispose()
    $Snapshot = $null
    $RetainedSnapshot = Open-VerifiedInstallerSnapshot $SnapshotPath $ExpectedSha256 $Name
    $Complete = $true
    return $RetainedSnapshot
  } finally {
    if ($null -ne $Hasher) { $Hasher.Dispose() }
    if ($null -ne $Source) { $Source.Dispose() }
    if ($null -ne $Snapshot) { $Snapshot.Dispose() }
    if (-not $Complete -and $null -ne $RetainedSnapshot) { $RetainedSnapshot.Dispose() }
    if (-not $Complete) { Remove-Item -LiteralPath $SnapshotPath -Force -ErrorAction SilentlyContinue }
  }
}

function Write-Ready([string]$ReadyPath, [string]$WorkerId) {
  $Encoding = [System.Text.UTF8Encoding]::new($false)
  $Stream = [System.IO.File]::Open($ReadyPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $Bytes = $Encoding.GetBytes("$WorkerId`n")
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
  } finally {
    $Stream.Dispose()
  }
}

function Write-WorkerFailure([string]$FailurePath, [string]$WorkerId, [string]$Phase) {
  $Encoding = [System.Text.UTF8Encoding]::new($false)
  $Stream = [System.IO.File]::Open($FailurePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
  try {
    $Bytes = $Encoding.GetBytes("$WorkerId`:$Phase`n")
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
  } finally {
    $Stream.Dispose()
  }
}

function Write-Applied([string]$AppliedPath, [string]$TransactionId) {
  $Encoding = [System.Text.UTF8Encoding]::new($false)
  $Stream = [System.IO.File]::Open($AppliedPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $Bytes = $Encoding.GetBytes("$TransactionId`n")
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
  } finally {
    $Stream.Dispose()
  }
}

function Write-RolledBack([string]$RolledBackPath, [string]$TransactionId) {
  $Encoding = [System.Text.UTF8Encoding]::new($false)
  $Stream = [System.IO.File]::Open($RolledBackPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $Bytes = $Encoding.GetBytes("$TransactionId`n")
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
  } finally {
    $Stream.Dispose()
  }
}

function Test-RollbackCompletion([string]$RolledBackPath, [string]$TransactionId) {
  try {
    return [System.IO.File]::ReadAllText($RolledBackPath, [System.Text.Encoding]::UTF8) -eq "$TransactionId`n"
  } catch [System.IO.FileNotFoundException] {
    return $false
  }
}

function Write-Heartbeat([string]$HeartbeatPath, [string]$TransactionId, [string]$LaunchNonce, [int64]$WrittenAtMs = 0) {
  $Encoding = [System.Text.UTF8Encoding]::new($false)
  $Stream = [System.IO.File]::Open($HeartbeatPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $Timestamp = if ($WrittenAtMs -gt 0) { $WrittenAtMs } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    if ($LaunchNonce -notmatch '^[0-9a-f]{32}$') { throw 'Harness Desktop candidate launch nonce is invalid' }
    $Bytes = $Encoding.GetBytes("$TransactionId`:$LaunchNonce`:$Timestamp`n")
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
  } finally {
    $Stream.Dispose()
  }
}

function Write-WorkerDiagnosticStage([string]$WorkerDirectory, [string]$WorkerId, [string]$Stage) {
  if ([Environment]::GetEnvironmentVariable('DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS', 'Process') -ne '1') { return }
  if ($Stage -notin @('candidate-installer', 'candidate-launch', 'candidate-identity', 'candidate-heartbeat', 'candidate-heartbeat-written')) { return }
  if ([string]::IsNullOrEmpty($WorkerDirectory) -or -not (Test-Uuid $WorkerId)) { return }
  try {
    $Path = Join-Path $WorkerDirectory "native-update-worker-stage-$Stage-$WorkerId.json"
    $Encoding = [System.Text.UTF8Encoding]::new($false)
    $Stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    try {
      $Bytes = $Encoding.GetBytes("$Stage`n")
      $Stream.Write($Bytes, 0, $Bytes.Length)
      $Stream.Flush($true)
    } finally {
      $Stream.Dispose()
    }
  } catch {
    # Test-only worker stage evidence cannot affect candidate recovery.
  }
}

function New-CandidateLaunchNonce {
  $Bytes = [byte[]]::new(16)
  $Generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $Generator.GetBytes($Bytes) } finally { $Generator.Dispose() }
  return -join ($Bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-CandidateLaunchArguments([string]$LaunchNonce) {
  if ($LaunchNonce -notmatch '^[0-9a-f]{32}$') { throw 'Harness Desktop candidate launch nonce is invalid' }
  return @("--dsh-native-update-launch-nonce=$LaunchNonce")
}

function Get-NsisInstallerArguments([pscustomobject]$Plan) {
  return @('/S', "/D=$(Get-ApplicationDirectory $Plan)")
}

function Get-ApplicationDirectory([pscustomobject]$Plan) {
  $InstallDirectory = [System.IO.Path]::GetDirectoryName([string]$Plan.applicationPath)
  if ([string]::IsNullOrEmpty($InstallDirectory)) { throw 'Harness Desktop installer destination is invalid' }
  return $InstallDirectory
}

function Invoke-Rollback([pscustomobject]$Plan, [string]$RollbackSnapshotPath, [string]$RolledBackPath = $null) {
  if ($null -eq $RolledBackPath -and $null -ne $Plan.PSObject.Properties['transactionId']) {
    $RolledBackPath = Get-RolledBackPath $Plan.rollbackArtifactPath $Plan.transactionId
  }
  if ($null -eq $Plan.PSObject.Properties['transactionId'] -or -not (Test-Uuid $Plan.transactionId)) {
    throw 'Harness Desktop rollback transaction identifier is invalid'
  }
  if ($null -eq $Plan.PSObject.Properties['healthCheckTimeoutMs'] -or $Plan.healthCheckTimeoutMs -isnot [int] -or $Plan.healthCheckTimeoutMs -le 0) {
    throw 'Harness Desktop rollback health timeout is invalid'
  }
  $RollbackMutex = [System.Threading.Mutex]::new($false, "Local\HarnessDesktopUpdateRollback-$($Plan.transactionId)")
  $RollbackMutexHeld = $false
  try {
    try {
      $RollbackMutexHeld = $RollbackMutex.WaitOne($Plan.healthCheckTimeoutMs)
    } catch [System.Threading.AbandonedMutexException] {
      $RollbackMutexHeld = $true
    }
    if (-not $RollbackMutexHeld) { throw 'Harness Desktop rollback transaction is still owned by another worker' }
    if ($null -ne $RolledBackPath -and (Test-RollbackCompletion $RolledBackPath $Plan.transactionId)) { return }
    $InstallDirectory = Get-ApplicationDirectory $Plan
    $Installer = Start-Process -FilePath $RollbackSnapshotPath -ArgumentList @(Get-NsisInstallerArguments $Plan) -WorkingDirectory $InstallDirectory -Wait -PassThru
    try {
      if ($Installer.ExitCode -ne 0) { throw 'Harness Desktop rollback installer failed' }
    } finally {
      $Installer.Dispose()
    }
    if ($null -ne $RolledBackPath) { Write-RolledBack $RolledBackPath $Plan.transactionId }
    [void][HarnessDesktopUpdate.CandidateJob]::LaunchBreakaway($Plan.applicationPath, $InstallDirectory)
  } finally {
    if ($RollbackMutexHeld) { $RollbackMutex.ReleaseMutex() }
    $RollbackMutex.Dispose()
  }
}

function Invoke-WatchdogRollback([pscustomobject]$Plan, [string]$RollbackSnapshotPath) {
  Invoke-Rollback $Plan $RollbackSnapshotPath (Get-RolledBackPath $Plan.rollbackArtifactPath $Plan.transactionId)
}

function New-StartedProcessReference([System.Diagnostics.Process]$Process, [string]$ExpectedPath) {
  try {
    $Process.Refresh()
    $ExecutablePath = [System.IO.Path]::GetFullPath($Process.MainModule.FileName)
    if (-not $ExecutablePath.Equals($ExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'Harness Desktop candidate process path changed'
    }
    $StartedBeforeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    return [pscustomobject]@{
      processId = $Process.Id
      executablePath = $ExecutablePath
      startedBeforeMs = $StartedBeforeMs
    }
  } finally {
    $Process.Dispose()
  }
}

function Invoke-CandidateInstall([pscustomobject]$Plan, [string]$CandidateSnapshotPath, [string]$WorkerDirectory = $null, [string]$WorkerId = $null) {
  $InstallDirectory = Get-ApplicationDirectory $Plan
  Write-WorkerDiagnosticStage $WorkerDirectory $WorkerId 'candidate-installer'
  $Installer = Start-Process -FilePath $CandidateSnapshotPath -ArgumentList @(Get-NsisInstallerArguments $Plan) -WorkingDirectory $InstallDirectory -Wait -PassThru
  try {
    if ($Installer.ExitCode -ne 0) { throw 'Harness Desktop candidate installer failed' }
  } finally {
    $Installer.Dispose()
  }
  $LaunchNonce = New-CandidateLaunchNonce
  $LaunchArguments = @(Get-CandidateLaunchArguments $LaunchNonce)
  Write-WorkerDiagnosticStage $WorkerDirectory $WorkerId 'candidate-launch'
  $CandidateJob = [HarnessDesktopUpdate.CandidateJob]::LaunchWithArguments($Plan.applicationPath, ($LaunchArguments -join ' '), $InstallDirectory)
  $Candidate = [System.Diagnostics.Process]::GetProcessById($CandidateJob.ProcessId)
  try {
    Write-WorkerDiagnosticStage $WorkerDirectory $WorkerId 'candidate-identity'
    $Reference = New-StartedProcessReference $Candidate $Plan.applicationPath
    $Reference | Add-Member -NotePropertyName job -NotePropertyValue $CandidateJob
    $Reference | Add-Member -NotePropertyName launchNonce -NotePropertyValue $LaunchNonce
    $CandidateJob = $null
    return $Reference
  } catch {
    try {
      if ($null -ne $CandidateJob) { $CandidateJob.TerminateAndWait($Plan.healthCheckTimeoutMs) }
      try { $Candidate.WaitForExit() } catch [System.InvalidOperationException] { # The candidate exited before identity capture.
      }
    } finally {
      $Candidate.Dispose()
      if ($null -ne $CandidateJob) { $CandidateJob.Dispose() }
    }
    throw
  }
}

function Test-ReportedCandidate([pscustomobject]$Launched, [pscustomobject]$Reported) {
  if ($null -eq $Launched.PSObject.Properties['job']) { return $false }
  $JobProcessIds = @($Launched.job.ProcessIds())
  $Matches = $Launched.processId -eq $Reported.processId
  $Matches = $Matches -and $Launched.executablePath.Equals($Reported.executablePath, [System.StringComparison]::OrdinalIgnoreCase)
  return $Matches -and $JobProcessIds -contains [uint64]$Reported.processId
}

function Invoke-Watchdog([pscustomobject]$Plan, [System.Diagnostics.Process]$Parent, [string]$RollbackSnapshotPath, [string]$CandidateSnapshotPath, [scriptblock]$ElapsedMilliseconds = $null, [string]$WorkerDirectory = $null, [string]$WorkerId = $null) {
  if (-not (Wait-ForOwnedParentExitBeforeCandidate $Parent $Plan.healthCheckTimeoutMs)) { return $false }
  try {
    $InitialState = Read-WatchState $Plan.journalPath $Plan.candidateVersion $Plan.transactionId
  } catch {
    Invoke-WatchdogRollback $Plan $RollbackSnapshotPath
    return $false
  }
  if ($null -eq $InitialState) {
    Invoke-WatchdogRollback $Plan $RollbackSnapshotPath
    return $false
  }
  if ($InitialState.phase -eq 'applied') { return $true }
  if ($InitialState.phase -ne 'awaiting-dashboard-health') {
    if ($null -ne $InitialState.candidateProcess) {
      Stop-CandidateForRollback $InitialState.candidateProcess $Plan.healthCheckTimeoutMs
    }
    Invoke-WatchdogRollback $Plan $RollbackSnapshotPath
    return $false
  }
  $CandidateProcess = $null
  try {
    $CandidateProcess = Invoke-CandidateInstall $Plan $CandidateSnapshotPath $WorkerDirectory $WorkerId
    Write-WorkerDiagnosticStage $WorkerDirectory $WorkerId 'candidate-heartbeat'
    Write-Heartbeat (Get-HeartbeatPath $Plan.rollbackArtifactPath $Plan.transactionId) $Plan.transactionId $CandidateProcess.launchNonce $CandidateProcess.startedBeforeMs
    Write-WorkerDiagnosticStage $WorkerDirectory $WorkerId 'candidate-heartbeat-written'
  } catch {
    if ($null -ne $CandidateProcess -and (Test-ExpectedProcessAlive $CandidateProcess)) {
      Stop-CandidateForRollback $CandidateProcess $Plan.healthCheckTimeoutMs
    }
    Invoke-WatchdogRollback $Plan $RollbackSnapshotPath
    return $false
  }
  if ($null -eq $ElapsedMilliseconds) {
    $HealthTimer = [System.Diagnostics.Stopwatch]::StartNew()
    $ElapsedMilliseconds = { return $HealthTimer.ElapsedMilliseconds }.GetNewClosure()
  }
  $Deadline = [int64](& $ElapsedMilliseconds) + $Plan.healthCheckTimeoutMs
  try {
    while ($true) {
      $State = Read-WatchState $Plan.journalPath $Plan.candidateVersion $Plan.transactionId
      if ($null -eq $State) { throw 'Harness Desktop rollback watchdog journal disappeared before health acknowledgement' }
      if ($State.phase -eq 'dashboard-health-checking') {
        if ($null -eq $State.candidateProcess -or -not (Test-ReportedCandidate $CandidateProcess $State.candidateProcess)) {
          throw 'Harness Desktop rollback watchdog candidate identity changed'
        }
      }
      if ($State.phase -eq 'applied') {
        if ($null -ne $State.candidateProcess -and (Test-ReportedCandidate $CandidateProcess $State.candidateProcess)) {
          $CandidateProcess.job.ReleaseHealthy()
          return $true
        }
        throw 'Harness Desktop rollback watchdog applied journal lacks the launched candidate identity'
      }
      if ($State.phase -eq 'rollback-scheduled' -or -not (Test-ExpectedProcessAlive $CandidateProcess)) {
        break
      }
      if ([int64](& $ElapsedMilliseconds) -ge $Deadline) {
        break
      }
      Start-Sleep -Milliseconds 100
    }
  } catch {
    # A missing or malformed journal cannot authorize the installed candidate to continue.
  }
  Stop-CandidateForRollback $CandidateProcess $Plan.healthCheckTimeoutMs
  Invoke-WatchdogRollback $Plan $RollbackSnapshotPath
  if ($null -ne $CandidateProcess.PSObject.Properties['job']) { $CandidateProcess.job.Dispose() }
  return $false
}

$CanCleanup = $false
$ReadyPath = $null
$FailurePath = $null
$FailurePhase = 'validating'
$ReadyWritten = $false
$WorkerId = $null
$RollbackSnapshotPath = $null
$CandidateSnapshotPath = $null
$RollbackSnapshot = $null
$CandidateSnapshot = $null
$ExpectedParent = $null
$PrivateScriptPath = $null
$PrivatePlanPath = $null
try {
  $PrivateScriptPath = [System.IO.Path]::GetFullPath($PSCommandPath)
  $PrivatePlanPath = [System.IO.Path]::GetFullPath($PlanPath)
  $WorkerName = [System.IO.Path]::GetFileName($PrivateScriptPath)
  if ($WorkerName -notmatch '^native-rollback-worker-([0-9a-f-]{36})\.ps1$') { throw 'Harness Desktop rollback worker path is invalid' }
  $WorkerId = $Matches[1]
  if ([System.IO.Path]::GetDirectoryName($PrivatePlanPath) -ne [System.IO.Path]::GetDirectoryName($PrivateScriptPath) -or [System.IO.Path]::GetFileName($PrivatePlanPath) -ne "native-rollback-plan-$WorkerId.json") {
    throw 'Harness Desktop rollback plan path is invalid'
  }
  $CanCleanup = $true
  $FailurePath = Get-FailurePath ([System.IO.Path]::GetDirectoryName($PrivateScriptPath)) $WorkerId
  $Request = Get-Content -LiteralPath $PrivatePlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Request -isnot [pscustomobject] -or -not (Test-ExactProperties $Request @('schemaVersion', 'workerId', 'readyPath', 'plan')) -or $Request.schemaVersion -ne 1 -or $Request.workerId -ne $WorkerId -or -not (Test-Uuid $Request.workerId)) {
    throw 'Harness Desktop rollback worker request is invalid'
  }
  $Plan = $Request.plan
  $Watch = $Plan.PSObject.Properties.Name -contains 'journalPath'
  $Validated = Assert-RollbackPlan $Plan $Watch
  $ReadyPath = Require-AbsolutePath $Request 'readyPath'
  if (-not $ReadyPath.Equals((Get-ReadyPath $Validated.rollbackArtifactPath $WorkerId), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Harness Desktop rollback worker readiness path is invalid'
  }
  if ($Watch) {
    $InitialState = Read-WatchState $Validated.journalPath $Validated.candidateVersion $Validated.transactionId
    if ($null -eq $InitialState -or $InitialState.phase -ne 'awaiting-dashboard-health') {
      throw 'Harness Desktop rollback watchdog is not ready'
    }
  }
  $WorkerDirectory = [System.IO.Path]::GetDirectoryName($PrivateScriptPath)
  $RollbackSnapshotPath = Join-Path $WorkerDirectory "native-rollback-installer-$WorkerId.exe"
  $FailurePhase = 'snapshotting-rollback'
  $RollbackSnapshot = New-VerifiedInstallerSnapshot $Validated.rollbackArtifactPath $RollbackSnapshotPath $Validated.rollbackSha256 'rollback'
  if ($Watch) {
    $CandidateSnapshotPath = Join-Path $WorkerDirectory "native-candidate-installer-$WorkerId.exe"
    $FailurePhase = 'snapshotting-candidate'
    $CandidateSnapshot = New-VerifiedInstallerSnapshot $Validated.candidateArtifactPath $CandidateSnapshotPath $Validated.candidateSha256 'candidate'
  }
  $FailurePhase = 'validating'
  $ExpectedParent = Get-ExpectedProcess $Validated.parentProcess
  if ($null -eq $ExpectedParent) {
    throw 'Harness Desktop rollback worker expected Main process is not alive'
  }
  Write-Ready $ReadyPath $WorkerId
  $ReadyWritten = $true
  if ($Watch) {
    $FailurePhase = 'watching-candidate'
    if (Invoke-Watchdog $Validated $ExpectedParent $RollbackSnapshotPath $CandidateSnapshotPath $null $WorkerDirectory $WorkerId) {
      Write-Applied (Get-AppliedPath $Validated.rollbackArtifactPath $Validated.transactionId) $Validated.transactionId
    }
  } else {
    $FailurePhase = 'waiting-parent'
    if (-not (Wait-ForOwnedParentExit $ExpectedParent $Validated.healthCheckTimeoutMs)) {
      Stop-ExpectedProcess $Validated.parentProcess $Validated.healthCheckTimeoutMs
      if (-not (Wait-ForReferencedProcessExitBeforeCandidate $Validated.parentProcess $Validated.healthCheckTimeoutMs)) {
        throw 'Harness Desktop rollback worker could not stop the current Main process before rollback'
      }
    }
    $FailurePhase = 'rolling-back'
    Invoke-Rollback $Validated $RollbackSnapshotPath
  }
} catch {
  if ($null -ne $FailurePath -and $null -ne $WorkerId) {
    try {
      Write-WorkerFailure $FailurePath $WorkerId $FailurePhase
    } catch {
      # The best-effort receipt never carries the original exception; the nonzero exit remains the failure signal.
    }
  }
  exit 1
} finally {
  if ($CanCleanup) {
    if ($null -ne $ExpectedParent) { $ExpectedParent.Dispose() }
    if ($null -ne $CandidateSnapshot) { $CandidateSnapshot.Dispose() }
    if ($null -ne $RollbackSnapshot) { $RollbackSnapshot.Dispose() }
    if ($null -ne $ReadyPath) { Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue }
    if ($null -ne $CandidateSnapshotPath) { Remove-Item -LiteralPath $CandidateSnapshotPath -Force -ErrorAction SilentlyContinue }
    if ($null -ne $RollbackSnapshotPath) { Remove-Item -LiteralPath $RollbackSnapshotPath -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $PrivatePlanPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PrivateScriptPath -Force -ErrorAction SilentlyContinue
  }
}
