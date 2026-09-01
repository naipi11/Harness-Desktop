/** Windows native update supervisor build and process-ownership behavior. */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const windowsX64 = describe.runIf(process.platform === 'win32' && process.arch === 'x64')
const root = resolve(import.meta.dirname, '../../..')
const artifact = join(root, 'apps', 'desktop', 'out', 'native', 'win32-x64', 'windows-native-update-supervisor.exe')
const workerId = '55555555-5555-4555-8555-555555555555'
const cancelId = '66666666-6666-4666-8666-666666666666'
const privateFixtureValue = 'private-fixture-value'
const privateEnvironmentValue = 'key-shaped-fixture-value'
const temporaryDirectories = new Set<string>()
const ownedProcessIds = new Set<number>()
let buildPromise: Promise<SupervisorMetadata> | undefined
let launcherPromise: Promise<string> | undefined
let launcherDirectory: string | undefined

interface SupervisorMetadata {
  readonly machine: 'amd64'
  readonly subsystem: 'windows-gui'
}

interface SupervisorFixture {
  readonly directory: string
  readonly executablePath: string
  readonly scriptPath: string
  readonly planPath: string
  readonly workerProcessIdPath: string
  readonly stopPath: string
}

afterEach(async () => {
  for (const processId of ownedProcessIds) {
    try { process.kill(processId) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    ownedProcessIds.delete(processId)
  }
  await Promise.all([...temporaryDirectories].map(async (directory) => {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
    temporaryDirectories.delete(directory)
  }))
})

afterAll(async () => {
  if (launcherDirectory !== undefined) {
    await rm(launcherDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  }
})

windowsX64('windows-native-update-supervisor', () => {
  it('builds an AMD64 PE32+ Windows GUI executable', async () => {
    await expect(buildWindowsNativeUpdateSupervisor()).resolves.toEqual({
      machine: 'amd64',
      subsystem: 'windows-gui',
    })
  }, 30_000)

  it('outlives the fixture parent while its PowerShell worker remains active', async () => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture()
    const parentResult = await launchSupervisorFixture(fixture, 'detach')
    expect(parentResult).toMatchObject({ code: 0, stderr: '' })
    const supervisorProcessId = Number.parseInt(parentResult.stdout, 10)
    expect(Number.isSafeInteger(supervisorProcessId)).toBe(true)
    ownedProcessIds.add(supervisorProcessId)

    await waitForFile(fixture.workerProcessIdPath)
    const workerProcessId = await readProcessId(fixture.workerProcessIdPath)
    expect(isProcessAlive(supervisorProcessId)).toBe(true)
    expect(isProcessAlive(workerProcessId)).toBe(true)

    await writeFile(fixture.stopPath, 'stop\n')
    await waitForProcessExit(supervisorProcessId)
    await waitForProcessExit(workerProcessId)
  }, 20_000)

  it('kills the PowerShell worker when the supervisor exits unexpectedly', async () => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture()
    const parentResult = await launchSupervisorFixture(fixture, 'detach')
    expect(parentResult).toMatchObject({ code: 0, stderr: '' })
    const supervisorProcessId = Number.parseInt(parentResult.stdout, 10)
    ownedProcessIds.add(supervisorProcessId)
    await waitForFile(fixture.workerProcessIdPath)
    const workerProcessId = await readProcessId(fixture.workerProcessIdPath)
    expect(isProcessAlive(workerProcessId)).toBe(true)

    process.kill(supervisorProcessId)
    await waitForProcessExit(supervisorProcessId)
    await waitForProcessExit(workerProcessId)
  }, 20_000)

  it('propagates the PowerShell worker exit code', async () => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture('exit 23')
    const result = await launchSupervisorFixture(fixture, 'wait')
    expect(result).toMatchObject({ code: 23, stderr: '' })
    expect(result.stdout).toMatch(/^\d+$/u)
  }, 10_000)

  it('drains an empty Job and acknowledges a valid pre-published cancellation before PowerShell starts', async () => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture('exit 23')
    const cancelPath = join(fixture.directory, `native-update-cancel-${workerId}.req`)
    const drainedPath = join(fixture.directory, `native-update-drained-${workerId}.ack`)
    const record = `${workerId}:${cancelId}\n`
    await writeFile(cancelPath, record, { flag: 'wx' })

    const result = await launchSupervisorFixture(fixture, 'wait')

    expect(result.code).toBe(70)
    await expect(readFile(drainedPath, 'utf8')).resolves.toBe(record)
    await expect(readFile(fixture.workerProcessIdPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)

  it('acknowledges cancellation only after a transitive Job descendant is absent', async () => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture('spawn-child-wait')
    const cancelPath = join(fixture.directory, `native-update-cancel-${workerId}.req`)
    const drainedPath = join(fixture.directory, `native-update-drained-${workerId}.ack`)
    const record = `${workerId}:${cancelId}\n`
    const resultPromise = launchSupervisorFixture(fixture, 'wait')
    await waitForFile(fixture.workerProcessIdPath)
    const descendantProcessId = await readProcessId(fixture.workerProcessIdPath)
    expect(isProcessAlive(descendantProcessId)).toBe(true)

    await writeFile(cancelPath, record, { flag: 'wx' })
    await waitForFile(drainedPath)
    expect(isProcessAlive(descendantProcessId)).toBe(false)
    await expect(readFile(drainedPath, 'utf8')).resolves.toBe(record)
    const result = await resultPromise
    expect(result).toMatchObject({ code: 70, supervisorStdout: '', supervisorStderr: '' })
  }, 15_000)

  it.each(['malformed\n', `${workerId}:${cancelId}`])(
    'does not acknowledge malformed or partial cancellation request %j',
    async (record) => {
      await buildWindowsNativeUpdateSupervisor()
      const fixture = await createSupervisorFixture('exit 23')
      await writeFile(join(fixture.directory, `native-update-cancel-${workerId}.req`), record, { flag: 'wx' })
      const result = await launchSupervisorFixture(fixture, 'wait')
      expect(result.code).toBe(23)
      await expect(readFile(join(fixture.directory, `native-update-drained-${workerId}.ack`)))
        .rejects.toMatchObject({ code: 'ENOENT' })
    },
    10_000,
  )

  it('does not follow a cancellation request reparse point', async () => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture('exit 23')
    const target = join(fixture.directory, 'cancel-target.req')
    const cancelPath = join(fixture.directory, `native-update-cancel-${workerId}.req`)
    await writeFile(target, `${workerId}:${cancelId}\n`)
    await symlink(target, cancelPath, 'file')
    const result = await launchSupervisorFixture(fixture, 'wait')
    expect(result.code).toBe(23)
    await expect(readFile(join(fixture.directory, `native-update-drained-${workerId}.ack`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)

  it.each(['regular', 'link'] as const)('rejects a pre-existing drained %s before PowerShell starts', async (kind) => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture('exit 23')
    const drainedPath = join(fixture.directory, `native-update-drained-${workerId}.ack`)
    if (kind === 'regular') await writeFile(drainedPath, `${workerId}:${cancelId}\n`)
    else {
      const target = join(fixture.directory, 'drained-target.ack')
      await writeFile(target, `${workerId}:${cancelId}\n`)
      await symlink(target, drainedPath, 'file')
    }
    const result = await launchSupervisorFixture(fixture, 'wait')
    expect(result.code).toBe(71)
    await expect(readFile(fixture.workerProcessIdPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)

  it('resolves cancellation racing natural worker exit only as complete proof or normal completion', async () => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture()
    const cancelPath = join(fixture.directory, `native-update-cancel-${workerId}.req`)
    const drainedPath = join(fixture.directory, `native-update-drained-${workerId}.ack`)
    const record = `${workerId}:${cancelId}\n`
    const resultPromise = launchSupervisorFixture(fixture, 'wait')
    await waitForFile(fixture.workerProcessIdPath)
    await Promise.all([
      writeFile(cancelPath, record, { flag: 'wx' }),
      writeFile(fixture.stopPath, 'stop\n', { flag: 'wx' }),
    ])
    const result = await resultPromise
    expect([0, 70]).toContain(result.code)
    if (result.code === 70) await expect(readFile(drainedPath, 'utf8')).resolves.toBe(record)
    else await expect(readFile(drainedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('does not return from controlled PowerShell completion until the Job is quiescent', async () => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture('spawn-child')
    const result = await launchSupervisorFixture(fixture, 'wait')
    const descendantProcessId = await readProcessId(fixture.workerProcessIdPath)

    expect(result).toMatchObject({ code: 23, descendantExitedAfterReturn: true })
    expect(isProcessAlive(descendantProcessId)).toBe(false)
  }, 10_000)

  it('rejects mismatched private filenames without printing paths or keys', async () => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture()
    const mismatchedPlan = join(fixture.directory, 'native-rollback-plan-66666666-6666-4666-8666-666666666666.json')
    await writeFile(mismatchedPlan, `${JSON.stringify({ privateValue: privateFixtureValue })}\n`, { flag: 'wx' })
    const result = await launchSupervisorFixture({ ...fixture, planPath: mismatchedPlan }, 'wait')

    expect(result.code).not.toBe(0)
    expect(result.supervisorStdout).toBe('')
    expect(result.supervisorStderr).toBe('')
    expect(`${result.supervisorStdout}${result.supervisorStderr}`).not.toContain(privateEnvironmentValue)
    expect(`${result.supervisorStdout}${result.supervisorStderr}`).not.toContain(privateFixtureValue)
    expect(`${result.supervisorStdout}${result.supervisorStderr}`).not.toContain(fixture.directory)
    await expect(readFile(fixture.workerProcessIdPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)

  it('rejects a worker file reparse point before PowerShell starts', async () => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture()
    const target = join(fixture.directory, 'worker-target.ps1')
    await copyFile(fixture.scriptPath, target)
    await rm(fixture.scriptPath)
    await symlink(target, fixture.scriptPath, 'file')

    const result = await launchSupervisorFixture(fixture, 'wait')
    expect(result.code).toBe(65)
    await expect(readFile(fixture.workerProcessIdPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)

  it('rejects a plan file reparse point before PowerShell starts', async () => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture()
    const target = join(fixture.directory, 'plan-target.json')
    await copyFile(fixture.planPath, target)
    await rm(fixture.planPath)
    await symlink(target, fixture.planPath, 'file')

    const result = await launchSupervisorFixture(fixture, 'wait')
    expect(result.code).toBe(65)
    await expect(readFile(fixture.workerProcessIdPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)

  it('rejects inherited Job membership before PowerShell starts', async () => {
    await buildWindowsNativeUpdateSupervisor()
    const fixture = await createSupervisorFixture()
    const result = await launchSupervisorFixture(fixture, 'in-job')

    expect(result).toMatchObject({ code: 66, stderr: '' })
    expect(result.stdout).toMatch(/^\d+$/u)
    await expect(readFile(fixture.workerProcessIdPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)

  it.each(['29999', '600001', 'not-an-integer'])(
    'rejects invalid Job drain timeout %s before PowerShell starts',
    async (timeout) => {
      await buildWindowsNativeUpdateSupervisor()
      const fixture = await createSupervisorFixture()
      const result = await launchSupervisorFixture(fixture, 'wait', timeout)

      expect(result.code).toBe(64)
      await expect(readFile(fixture.workerProcessIdPath)).rejects.toMatchObject({ code: 'ENOENT' })
    },
    10_000,
  )
})

async function buildWindowsNativeUpdateSupervisor(): Promise<SupervisorMetadata> {
  buildPromise ??= (async () => {
    const command = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'
    await execFileAsync(command, ['/d', '/s', '/c', 'pnpm run prepare:desktop-native'], {
      cwd: root,
      windowsHide: true,
    })
    return inspectPortableExecutable(await readFile(artifact))
  })()
  return await buildPromise
}

async function launchSupervisorFixture(
  fixture: SupervisorFixture,
  mode: 'detach' | 'wait' | 'in-job',
  drainTimeout = '30000',
): Promise<{
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly supervisorStdout: string
  readonly supervisorStderr: string
  readonly descendantExitedAfterReturn: boolean
}> {
  const launcher = await buildBreakawayLauncher()
  const launcherProcessIdPath = join(fixture.directory, `launcher-${mode}.pid`)
  const resultPath = join(fixture.directory, `launcher-${mode}.result`)
  const stdoutPath = join(fixture.directory, `supervisor-${mode}.stdout`)
  const stderrPath = join(fixture.directory, `supervisor-${mode}.stderr`)
  const launcherCommand = [
    launcher, mode, fixture.executablePath, fixture.scriptPath, fixture.planPath, drainTimeout,
    launcherProcessIdPath, resultPath, stdoutPath, stderrPath, fixture.workerProcessIdPath,
  ]
    .map(quoteWindowsArgument).join(' ')
  const powershellCommand = [
    "$ErrorActionPreference = 'Stop'",
    `try { $Result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${powershellLiteral(launcherCommand)} } } catch { exit 70 }`,
    'if ($Result.ReturnValue -ne 0) { exit 71 }',
    '[Console]::Out.Write([string]$Result.ProcessId)',
  ].join('; ')
  const encodedCommand = Buffer.from(powershellCommand, 'utf16le').toString('base64')
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const providerResult = await collectExit(spawn(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand,
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
  if (providerResult.code !== 0) {
    return { ...providerResult, supervisorStdout: '', supervisorStderr: '', descendantExitedAfterReturn: false }
  }
  const parentProcessId = Number.parseInt(providerResult.stdout, 10)
  if (!Number.isSafeInteger(parentProcessId)) throw new Error('WMI fixture did not return its process identifier')
  ownedProcessIds.add(parentProcessId)
  await waitForFile(launcherProcessIdPath)
  const supervisorProcessId = await readProcessId(launcherProcessIdPath)
  if (mode === 'detach') {
    await waitForProcessExit(parentProcessId)
    return {
      code: 0,
      stdout: String(supervisorProcessId),
      stderr: '',
      supervisorStdout: await readFile(stdoutPath, 'utf8'),
      supervisorStderr: await readFile(stderrPath, 'utf8'),
      descendantExitedAfterReturn: false,
    }
  }
  await waitForFile(resultPath)
  const code = Number.parseInt(await readFile(resultPath, 'utf8'), 10)
  const descendantExitedAfterReturn = (await readFile(resultPath, 'utf8')).includes(':quiescent')
  await waitForProcessExit(parentProcessId)
  await waitForProcessExit(supervisorProcessId)
  return {
    code,
    stdout: String(supervisorProcessId),
    stderr: '',
    supervisorStdout: await readFile(stdoutPath, 'utf8'),
    supervisorStderr: await readFile(stderrPath, 'utf8'),
    descendantExitedAfterReturn,
  }
}

async function buildBreakawayLauncher(): Promise<string> {
  launcherPromise ??= (async () => {
    launcherDirectory = await mkdtemp(join(tmpdir(), 'harness-supervisor-launcher-'))
    const sourcePath = join(launcherDirectory, 'breakaway-launcher.c')
    const executablePath = join(launcherDirectory, 'breakaway-launcher.exe')
    const objectPath = join(launcherDirectory, 'breakaway-launcher.obj')
    await writeFile(sourcePath, breakawayLauncherSource, { flag: 'wx' })
    const programFiles = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles
    if (programFiles === undefined) throw new Error('Windows program files directory is unavailable')
    const vswhere = join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    const installation = (await execFileAsync(vswhere, [
      '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath',
    ], { windowsHide: true })).stdout.trim()
    const vsDevCmd = join(installation, 'Common7', 'Tools', 'VsDevCmd.bat')
    const command = [
      `call "${vsDevCmd}" -no_logo -arch=x64 -host_arch=x64`,
      `cl.exe /nologo /W4 /WX /O1 /MT /utf-8 "${sourcePath}" /Fo"${objectPath}" /Fe"${executablePath}" /link /SUBSYSTEM:CONSOLE /MACHINE:X64`,
    ].join(' && ')
    const compiler = spawn(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/c', command], {
      cwd: root,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const result = await collectExit(compiler)
    if (result.code !== 0) throw new Error(`breakaway launcher build failed: ${result.stdout}\n${result.stderr}`)
    return executablePath
  })()
  return await launcherPromise
}

const breakawayLauncherSource = String.raw`#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static BOOL write_number(const wchar_t *path, DWORD value) {
  char bytes[32];
  int length = _snprintf_s(bytes, sizeof(bytes), _TRUNCATE, "%lu", value);
  DWORD written = 0;
  HANDLE file;
  if (length < 0) return FALSE;
  file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return FALSE;
  if (!WriteFile(file, bytes, (DWORD)length, &written, NULL) || written != (DWORD)length) {
    CloseHandle(file);
    return FALSE;
  }
  return CloseHandle(file);
}

static BOOL process_is_alive_from_file(const wchar_t *path) {
  char bytes[32] = { 0 };
  DWORD read = 0;
  DWORD process_id;
  DWORD wait_result;
  HANDLE process;
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return FALSE;
  if (!ReadFile(file, bytes, sizeof(bytes) - 1, &read, NULL)) {
    CloseHandle(file);
    return FALSE;
  }
  CloseHandle(file);
  process_id = (DWORD)strtoul(bytes, NULL, 10);
  if (process_id == 0) return FALSE;
  process = OpenProcess(SYNCHRONIZE, FALSE, process_id);
  if (process == NULL) return FALSE;
  wait_result = WaitForSingleObject(process, 5000);
  CloseHandle(process);
  return wait_result == WAIT_TIMEOUT;
}

static BOOL write_result(const wchar_t *path, DWORD value, BOOL quiescent) {
  char bytes[64];
  int length = _snprintf_s(bytes, sizeof(bytes), _TRUNCATE, "%lu:%s", value, quiescent ? "quiescent" : "active");
  DWORD written = 0;
  HANDLE file;
  if (length < 0) return FALSE;
  file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return FALSE;
  if (!WriteFile(file, bytes, (DWORD)length, &written, NULL) || written != (DWORD)length) {
    CloseHandle(file);
    return FALSE;
  }
  return CloseHandle(file);
}

int wmain(int argc, wchar_t **argv) {
  STARTUPINFOW startup = { sizeof(startup) };
  PROCESS_INFORMATION process = { 0 };
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = { 0 };
  HANDLE job = NULL;
  HANDLE standard_output = INVALID_HANDLE_VALUE;
  HANDLE standard_error = INVALID_HANDLE_VALUE;
  SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
  wchar_t *command;
  size_t capacity;
  DWORD child_exit;
  BOOL wait;
  BOOL in_job;
  DWORD flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;
  if (argc == 5 && wcscmp(argv[1], L"descendant") == 0) {
    STARTUPINFOW descendant_startup = { sizeof(descendant_startup) };
    PROCESS_INFORMATION descendant = { 0 };
    size_t descendant_capacity = wcslen(argv[2]) + 64;
    wchar_t *descendant_command = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
      descendant_capacity * sizeof(wchar_t));
    if (descendant_command == NULL) return 74;
    if (_snwprintf_s(descendant_command, descendant_capacity, _TRUNCATE,
        L"\"%ls\" -e \"setTimeout(() => {}, 30000)\"", argv[2]) < 0) return 75;
    if (!CreateProcessW(argv[2], descendant_command, NULL, NULL, FALSE,
        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
        NULL, NULL, &descendant_startup, &descendant)) return 76;
    if (!write_number(argv[3], descendant.dwProcessId)) return 77;
    CloseHandle(descendant.hThread);
    CloseHandle(descendant.hProcess);
    HeapFree(GetProcessHeap(), 0, descendant_command);
    return 0;
  }
  if (argc != 11) return 64;
  wait = wcscmp(argv[1], L"wait") == 0 || wcscmp(argv[1], L"in-job") == 0;
  in_job = wcscmp(argv[1], L"in-job") == 0;
  if (!wait && wcscmp(argv[1], L"detach") != 0) return 65;
  capacity = wcslen(argv[2]) + wcslen(argv[3]) + wcslen(argv[4]) + wcslen(argv[5]) + 20;
  command = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, capacity * sizeof(wchar_t));
  if (command == NULL) return 66;
  if (_snwprintf_s(command, capacity, _TRUNCATE, L"\"%ls\" \"%ls\" \"%ls\" %ls", argv[2], argv[3], argv[4], argv[5]) < 0) return 67;
  standard_output = CreateFileW(argv[8], GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_DELETE, &security,
    CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  standard_error = CreateFileW(argv[9], GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_DELETE, &security,
    CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (standard_output == INVALID_HANDLE_VALUE || standard_error == INVALID_HANDLE_VALUE) return 73;
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = standard_output;
  startup.hStdError = standard_error;
  SetEnvironmentVariableW(L"DSH_FIXTURE_API_KEY", L"key-shaped-fixture-value");
  if (in_job) flags |= CREATE_SUSPENDED;
  if (!CreateProcessW(argv[2], command, NULL, NULL, TRUE, flags,
      NULL, NULL, &startup, &process)) return 68;
  CloseHandle(standard_output);
  CloseHandle(standard_error);
  if (in_job) {
    job = CreateJobObjectW(NULL, NULL);
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (job == NULL
        || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))
        || !AssignProcessToJobObject(job, process.hProcess)
        || ResumeThread(process.hThread) == (DWORD)-1) return 69;
  }
  if (!write_number(argv[6], process.dwProcessId)) return 70;
  CloseHandle(process.hThread);
  if (!wait) {
    CloseHandle(process.hProcess);
    HeapFree(GetProcessHeap(), 0, command);
    return 0;
  }
  if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0
      || !GetExitCodeProcess(process.hProcess, &child_exit)) return 71;
  if (!write_result(argv[7], child_exit, !process_is_alive_from_file(argv[10]))) return 72;
  CloseHandle(process.hProcess);
  if (job != NULL) CloseHandle(job);
  HeapFree(GetProcessHeap(), 0, command);
  return 0;
}
`

function quoteWindowsArgument(value: string): string {
  if (value.includes('"')) throw new Error('fixture path contains an unsupported quote')
  return `"${value}"`
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll('\'', '\'\'')}'`
}

function inspectPortableExecutable(bytes: Buffer): SupervisorMetadata {
  expect(bytes.subarray(0, 2).toString('ascii')).toBe('MZ')
  const peOffset = bytes.readUInt32LE(0x3c)
  expect(bytes.subarray(peOffset, peOffset + 4).toString('binary')).toBe('PE\0\0')
  expect(bytes.readUInt16LE(peOffset + 4)).toBe(0x8664)
  const optionalHeader = peOffset + 24
  expect(bytes.readUInt16LE(optionalHeader)).toBe(0x20b)
  expect(bytes.readUInt16LE(optionalHeader + 68)).toBe(2)
  return { machine: 'amd64', subsystem: 'windows-gui' }
}

async function createSupervisorFixture(workerTail?: string): Promise<SupervisorFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'harness-native-supervisor-'))
  temporaryDirectories.add(directory)
  const executablePath = join(directory, `native-update-supervisor-${workerId}.exe`)
  const scriptPath = join(directory, `native-rollback-worker-${workerId}.ps1`)
  const planPath = join(directory, `native-rollback-plan-${workerId}.json`)
  const workerProcessIdPath = join(directory, 'worker.pid')
  const stopPath = join(directory, 'stop')
  await mkdir(directory, { recursive: true })
  await copyFile(artifact, executablePath)
  await writeFile(planPath, `${JSON.stringify({ privateValue: privateFixtureValue })}\n`, { flag: 'wx' })
  const descendantLauncher = workerTail === 'spawn-child' || workerTail === 'spawn-child-wait'
    ? await buildBreakawayLauncher()
    : undefined
  const script = workerTail === undefined ? [
    'param([Parameter(Mandatory = $true)][string]$PlanPath)',
    "$ErrorActionPreference = 'Stop'",
    `Set-Content -LiteralPath ${powershellLiteral(workerProcessIdPath)} -Value $PID -Encoding ascii -NoNewline`,
    `while (-not (Test-Path -LiteralPath ${powershellLiteral(stopPath)} -PathType Leaf)) { Start-Sleep -Milliseconds 25 }`,
  ].join('\r\n') : workerTail === 'spawn-child' || workerTail === 'spawn-child-wait' ? [
    'param([Parameter(Mandatory = $true)][string]$PlanPath)',
    "$ErrorActionPreference = 'Stop'",
    `& ${powershellLiteral(descendantLauncher ?? '')} descendant ${powershellLiteral(process.execPath)} ${powershellLiteral(workerProcessIdPath)} unused`,
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    workerTail === 'spawn-child-wait' ? 'while ($true) { Start-Sleep -Seconds 1 }' : 'exit 23',
  ].join('\r\n') : [
    'param([Parameter(Mandatory = $true)][string]$PlanPath)',
    "$ErrorActionPreference = 'Stop'",
    workerTail,
  ].join('\r\n')
  await writeFile(scriptPath, script, { flag: 'wx' })
  return { directory, executablePath, scriptPath, planPath, workerProcessIdPath, stopPath }
}

function collectExit(child: ChildProcess): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => { resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }) })
  })
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      await readFile(path)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'EBUSY' && code !== 'EPERM') throw error
    }
    await delay(25)
  }
  throw new Error(`supervisor fixture did not create ${basename(path)}`)
}

async function readProcessId(path: string): Promise<number> {
  const processId = Number.parseInt(await readFile(path, 'utf8'), 10)
  if (!Number.isSafeInteger(processId)) throw new Error('supervisor fixture wrote an invalid process identifier')
  ownedProcessIds.add(processId)
  return processId
}

async function waitForProcessExit(processId: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!isProcessAlive(processId)) {
      ownedProcessIds.delete(processId)
      return
    }
    await delay(25)
  }
  throw new Error('supervisor-owned process remained alive after its owner exited')
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, milliseconds) })
}
