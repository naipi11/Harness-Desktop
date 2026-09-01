#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE

#include <windows.h>
#include <shellapi.h>
#include <wchar.h>
#include <wctype.h>

#define UUID_LENGTH 36
#define CANCELLATION_RECORD_LENGTH (UUID_LENGTH * 2 + 2)
#define CANCELLATION_POLL_MS 25

enum SupervisorExitCode {
  SUPERVISOR_INVALID_ARGUMENTS = 64,
  SUPERVISOR_INVALID_IDENTITY = 65,
  SUPERVISOR_INHERITED_JOB = 66,
  SUPERVISOR_JOB_FAILURE = 67,
  SUPERVISOR_PROCESS_FAILURE = 68,
  SUPERVISOR_WAIT_FAILURE = 69,
  SUPERVISOR_CANCELLATION_COMPLETE = 70,
  SUPERVISOR_ACKNOWLEDGEMENT_FAILURE = 71
};

static BOOL is_separator(wchar_t value) {
  return value == L'\\' || value == L'/';
}

static BOOL is_absolute_path(const wchar_t *path) {
  if (path == NULL || path[0] == L'\0') return FALSE;
  if (is_separator(path[0]) && is_separator(path[1])) return TRUE;
  return iswalpha(path[0]) != 0 && path[1] == L':' && is_separator(path[2]);
}

static const wchar_t *file_name(const wchar_t *path) {
  const wchar_t *cursor = path;
  const wchar_t *name = path;
  while (*cursor != L'\0') {
    if (is_separator(*cursor)) name = cursor + 1;
    ++cursor;
  }
  return name;
}

static BOOL same_directory(const wchar_t *left, const wchar_t *right) {
  const wchar_t *left_name = file_name(left);
  const wchar_t *right_name = file_name(right);
  size_t left_length = (size_t)(left_name - left);
  size_t right_length = (size_t)(right_name - right);
  return left_length == right_length && _wcsnicmp(left, right, left_length) == 0;
}

static BOOL is_uuid(const wchar_t *value) {
  size_t index;
  if (wcslen(value) != UUID_LENGTH) return FALSE;
  for (index = 0; index < UUID_LENGTH; ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != L'-') return FALSE;
    } else if (!iswxdigit(value[index])) {
      return FALSE;
    }
  }
  return TRUE;
}

static BOOL extract_uuid(
  const wchar_t *path,
  const wchar_t *prefix,
  const wchar_t *suffix,
  wchar_t uuid[UUID_LENGTH + 1]
) {
  const wchar_t *name = file_name(path);
  size_t prefix_length = wcslen(prefix);
  size_t suffix_length = wcslen(suffix);
  size_t name_length = wcslen(name);
  if (name_length != prefix_length + UUID_LENGTH + suffix_length) return FALSE;
  if (_wcsnicmp(name, prefix, prefix_length) != 0) return FALSE;
  if (_wcsicmp(name + prefix_length + UUID_LENGTH, suffix) != 0) return FALSE;
  wmemcpy(uuid, name + prefix_length, UUID_LENGTH);
  uuid[UUID_LENGTH] = L'\0';
  return is_uuid(uuid);
}

static BOOL is_file(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  return attributes != INVALID_FILE_ATTRIBUTES
    && (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0;
}

static BOOL append_path(wchar_t *base, size_t capacity, const wchar_t *suffix) {
  size_t base_length = wcslen(base);
  size_t suffix_length = wcslen(suffix);
  if (base_length + suffix_length + 1 > capacity) return FALSE;
  wmemcpy(base + base_length, suffix, suffix_length + 1);
  return TRUE;
}

static BOOL build_control_path(
  const wchar_t *module_path,
  const wchar_t *prefix,
  const wchar_t *uuid,
  const wchar_t *suffix,
  wchar_t *result,
  size_t capacity
) {
  const wchar_t *name = file_name(module_path);
  size_t directory_length = (size_t)(name - module_path);
  int written;
  if (directory_length >= capacity) return FALSE;
  wmemcpy(result, module_path, directory_length);
  result[directory_length] = L'\0';
  written = _snwprintf_s(
    result + directory_length,
    capacity - directory_length,
    _TRUNCATE,
    L"%ls%ls%ls",
    prefix,
    uuid,
    suffix
  );
  return written >= 0;
}

static BOOL is_uuid_ascii(const char *value) {
  size_t index;
  for (index = 0; index < UUID_LENGTH; ++index) {
    char character = value[index];
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (character != '-') return FALSE;
    } else if (!((character >= '0' && character <= '9')
        || (character >= 'a' && character <= 'f')
        || (character >= 'A' && character <= 'F'))) {
      return FALSE;
    }
  }
  return TRUE;
}

static BOOL path_is_absent(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  DWORD error;
  if (attributes != INVALID_FILE_ATTRIBUTES) return FALSE;
  error = GetLastError();
  return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
}

static BOOL read_cancellation_request(
  const wchar_t *path,
  const wchar_t *worker_uuid,
  char record[CANCELLATION_RECORD_LENGTH]
) {
  HANDLE file;
  FILE_ATTRIBUTE_TAG_INFO attributes;
  DWORD read = 0;
  DWORD extra_read = 0;
  char extra;
  char expected_uuid[UUID_LENGTH + 1];
  size_t index;
  file = CreateFileW(
    path,
    GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
    NULL
  );
  if (file == INVALID_HANDLE_VALUE) return FALSE;
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes))
      || (attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0
      || !ReadFile(file, record, CANCELLATION_RECORD_LENGTH, &read, NULL)
      || read != CANCELLATION_RECORD_LENGTH
      || !ReadFile(file, &extra, 1, &extra_read, NULL)
      || extra_read != 0) {
    CloseHandle(file);
    return FALSE;
  }
  if (!CloseHandle(file)) return FALSE;
  for (index = 0; index < UUID_LENGTH; ++index) expected_uuid[index] = (char)worker_uuid[index];
  expected_uuid[UUID_LENGTH] = '\0';
  return _strnicmp(record, expected_uuid, UUID_LENGTH) == 0
    && record[UUID_LENGTH] == ':'
    && is_uuid_ascii(record + UUID_LENGTH + 1)
    && record[CANCELLATION_RECORD_LENGTH - 1] == '\n';
}

static BOOL publish_drained_acknowledgement(
  const wchar_t *path,
  const char record[CANCELLATION_RECORD_LENGTH]
) {
  HANDLE file = CreateFileW(
    path,
    GENERIC_WRITE,
    0,
    NULL,
    CREATE_NEW,
    FILE_ATTRIBUTE_NORMAL,
    NULL
  );
  DWORD written = 0;
  BOOL success;
  if (file == INVALID_HANDLE_VALUE) return FALSE;
  success = WriteFile(file, record, CANCELLATION_RECORD_LENGTH, &written, NULL)
    && written == CANCELLATION_RECORD_LENGTH
    && FlushFileBuffers(file);
  if (!CloseHandle(file)) success = FALSE;
  return success;
}

static wchar_t *build_command_line(
  const wchar_t *powershell,
  const wchar_t *script,
  const wchar_t *plan
) {
  static const wchar_t command_format[] =
    L"\"%ls\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%ls\" -PlanPath \"%ls\"";
  size_t capacity = wcslen(command_format) + wcslen(powershell) + wcslen(script) + wcslen(plan) + 1;
  wchar_t *command = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, capacity * sizeof(wchar_t));
  if (command == NULL) return NULL;
  if (_snwprintf_s(command, capacity, _TRUNCATE, command_format, powershell, script, plan) < 0) {
    HeapFree(GetProcessHeap(), 0, command);
    return NULL;
  }
  return command;
}

/* Accept only the caller's policy-selected native worker readiness bound. */
static BOOL parse_drain_timeout(const wchar_t *value, DWORD *timeout) {
  DWORD parsed = 0;
  const wchar_t *cursor = value;
  if (*cursor == L'\0') return FALSE;
  while (*cursor != L'\0') {
    if (*cursor < L'0' || *cursor > L'9') return FALSE;
    parsed = parsed * 10 + (DWORD)(*cursor - L'0');
    if (parsed > 600000) return FALSE;
    ++cursor;
  }
  if (parsed < 30000) return FALSE;
  *timeout = parsed;
  return TRUE;
}

static BOOL terminate_and_drain_job(HANDLE job, UINT exit_code, DWORD timeout) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  ULONGLONG deadline;
  if (!TerminateJobObject(job, exit_code)) return FALSE;
  deadline = GetTickCount64() + timeout;
  for (;;) {
    ULONGLONG now;
    DWORD delay;
    ZeroMemory(&accounting, sizeof(accounting));
    if (!QueryInformationJobObject(
      job,
      JobObjectBasicAccountingInformation,
      &accounting,
      sizeof(accounting),
      NULL
    )) return FALSE;
    if (accounting.ActiveProcesses == 0) return TRUE;
    now = GetTickCount64();
    if (now >= deadline) return FALSE;
    delay = (DWORD)(deadline - now);
    Sleep(delay < 10 ? delay : 10);
  }
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR raw_command_line, int show) {
  wchar_t module_path[32768];
  wchar_t powershell[32768];
  wchar_t supervisor_uuid[UUID_LENGTH + 1];
  wchar_t worker_uuid[UUID_LENGTH + 1];
  wchar_t plan_uuid[UUID_LENGTH + 1];
  wchar_t cancel_path[32768];
  wchar_t drained_path[32768];
  char cancellation_record[CANCELLATION_RECORD_LENGTH];
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  BOOL inherited_job = FALSE;
  HANDLE job = NULL;
  wchar_t *command = NULL;
  wchar_t **arguments;
  DWORD module_length;
  UINT system_length;
  DWORD wait_result;
  DWORD child_exit_code;
  DWORD drain_timeout;
  int argument_count;
  int result = SUPERVISOR_PROCESS_FAILURE;

  UNREFERENCED_PARAMETER(instance);
  UNREFERENCED_PARAMETER(previous);
  UNREFERENCED_PARAMETER(raw_command_line);
  UNREFERENCED_PARAMETER(show);

  arguments = CommandLineToArgvW(GetCommandLineW(), &argument_count);
  if (arguments == NULL || argument_count != 4 || !parse_drain_timeout(arguments[3], &drain_timeout)) {
    if (arguments != NULL) LocalFree(arguments);
    return SUPERVISOR_INVALID_ARGUMENTS;
  }

  module_length = GetModuleFileNameW(NULL, module_path, ARRAYSIZE(module_path));
  if (module_length == 0 || module_length >= ARRAYSIZE(module_path)
      || !is_absolute_path(arguments[1]) || !is_absolute_path(arguments[2])
      || !same_directory(module_path, arguments[1])
      || !same_directory(module_path, arguments[2])
      || !is_file(arguments[1]) || !is_file(arguments[2])
      || !extract_uuid(module_path, L"native-update-supervisor-", L".exe", supervisor_uuid)
      || !extract_uuid(arguments[1], L"native-rollback-worker-", L".ps1", worker_uuid)
      || !extract_uuid(arguments[2], L"native-rollback-plan-", L".json", plan_uuid)
      || _wcsicmp(supervisor_uuid, worker_uuid) != 0
      || _wcsicmp(supervisor_uuid, plan_uuid) != 0
      || !build_control_path(module_path, L"native-update-cancel-", supervisor_uuid, L".req", cancel_path, ARRAYSIZE(cancel_path))
      || !build_control_path(module_path, L"native-update-drained-", supervisor_uuid, L".ack", drained_path, ARRAYSIZE(drained_path))) {
    LocalFree(arguments);
    return SUPERVISOR_INVALID_IDENTITY;
  }

  if (!IsProcessInJob(GetCurrentProcess(), NULL, &inherited_job)) {
    LocalFree(arguments);
    return SUPERVISOR_JOB_FAILURE;
  }
  if (inherited_job) {
    LocalFree(arguments);
    return SUPERVISOR_INHERITED_JOB;
  }
  if (!path_is_absent(drained_path)) {
    LocalFree(arguments);
    return SUPERVISOR_ACKNOWLEDGEMENT_FAILURE;
  }

  job = CreateJobObjectW(NULL, NULL);
  if (job == NULL) {
    LocalFree(arguments);
    return SUPERVISOR_JOB_FAILURE;
  }
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags =
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    result = SUPERVISOR_JOB_FAILURE;
    goto cleanup;
  }
  if (read_cancellation_request(cancel_path, supervisor_uuid, cancellation_record)) {
    if (!terminate_and_drain_job(job, SUPERVISOR_CANCELLATION_COMPLETE, drain_timeout)) {
      result = SUPERVISOR_WAIT_FAILURE;
    } else if (!publish_drained_acknowledgement(drained_path, cancellation_record)) {
      result = SUPERVISOR_ACKNOWLEDGEMENT_FAILURE;
    } else {
      result = SUPERVISOR_CANCELLATION_COMPLETE;
    }
    goto cleanup;
  }
  system_length = GetSystemDirectoryW(powershell, ARRAYSIZE(powershell));
  if (system_length == 0 || system_length >= ARRAYSIZE(powershell)
      || !append_path(powershell, ARRAYSIZE(powershell), L"\\WindowsPowerShell\\v1.0\\powershell.exe")
      || !is_file(powershell)) {
    goto cleanup;
  }
  command = build_command_line(powershell, arguments[1], arguments[2]);
  if (command == NULL) goto cleanup;

  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  ZeroMemory(&process, sizeof(process));
  if (!CreateProcessW(
    powershell,
    command,
    NULL,
    NULL,
    FALSE,
    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
    NULL,
    NULL,
    &startup,
    &process
  )) {
    goto cleanup;
  }
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, SUPERVISOR_JOB_FAILURE);
    WaitForSingleObject(process.hProcess, INFINITE);
    result = SUPERVISOR_JOB_FAILURE;
    goto process_cleanup;
  }
  if (ResumeThread(process.hThread) == (DWORD)-1) {
    if (!terminate_and_drain_job(job, SUPERVISOR_PROCESS_FAILURE, drain_timeout)) {
      result = SUPERVISOR_WAIT_FAILURE;
    }
    goto process_cleanup;
  }

  for (;;) {
    wait_result = WaitForSingleObject(process.hProcess, CANCELLATION_POLL_MS);
    if (read_cancellation_request(cancel_path, supervisor_uuid, cancellation_record)) {
      if (!terminate_and_drain_job(job, SUPERVISOR_CANCELLATION_COMPLETE, drain_timeout)) {
        result = SUPERVISOR_WAIT_FAILURE;
      } else if (!publish_drained_acknowledgement(drained_path, cancellation_record)) {
        result = SUPERVISOR_ACKNOWLEDGEMENT_FAILURE;
      } else {
        result = SUPERVISOR_CANCELLATION_COMPLETE;
      }
      goto process_cleanup;
    }
    if (wait_result == WAIT_TIMEOUT) continue;
    if (wait_result != WAIT_OBJECT_0 || !GetExitCodeProcess(process.hProcess, &child_exit_code)) {
      result = SUPERVISOR_WAIT_FAILURE;
    } else {
      result = (int)child_exit_code;
    }
    break;
  }
  if (!terminate_and_drain_job(job, (UINT)result, drain_timeout)) {
    result = SUPERVISOR_WAIT_FAILURE;
  }

process_cleanup:
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
cleanup:
  if (command != NULL) HeapFree(GetProcessHeap(), 0, command);
  CloseHandle(job);
  LocalFree(arguments);
  return result;
}
