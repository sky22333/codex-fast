const std = @import("std");

const HRESULT = i32;
const DWORD = u32;
const ULONG = u32;
const LPCWSTR = [*:0]const u16;
const BOOL = i32;
const HWND = ?*anyopaque;
const HANDLE = ?*anyopaque;

const RECT = extern struct {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
};

const GUID = extern struct {
    Data1: u32,
    Data2: u16,
    Data3: u16,
    Data4: [8]u8,
};

const IApplicationActivationManager = extern struct {
    lpVtbl: *const VTable,

    const VTable = extern struct {
        QueryInterface: *const fn (*IApplicationActivationManager, *const GUID, *?*anyopaque) callconv(.winapi) HRESULT,
        AddRef: *const fn (*IApplicationActivationManager) callconv(.winapi) ULONG,
        Release: *const fn (*IApplicationActivationManager) callconv(.winapi) ULONG,
        ActivateApplication: *const fn (*IApplicationActivationManager, LPCWSTR, LPCWSTR, u32, *DWORD) callconv(.winapi) HRESULT,
        ActivateForFile: *const anyopaque,
        ActivateForProtocol: *const anyopaque,
    };
};

extern "ole32" fn CoInitializeEx(reserved: ?*anyopaque, flags: u32) callconv(.winapi) HRESULT;
extern "ole32" fn CoCreateInstance(clsid: *const GUID, outer: ?*anyopaque, context: u32, iid: *const GUID, object: *?*anyopaque) callconv(.winapi) HRESULT;
extern "ole32" fn CoUninitialize() callconv(.winapi) void;
extern "user32" fn EnumWindows(callback: *const fn (HWND, isize) callconv(.winapi) BOOL, parameter: isize) callconv(.winapi) BOOL;
extern "user32" fn IsWindowVisible(window: HWND) callconv(.winapi) BOOL;
extern "user32" fn IsIconic(window: HWND) callconv(.winapi) BOOL;
extern "user32" fn GetWindow(window: HWND, command: u32) callconv(.winapi) HWND;
extern "user32" fn GetWindowRect(window: HWND, rectangle: *RECT) callconv(.winapi) BOOL;
extern "user32" fn GetWindowThreadProcessId(window: HWND, process_id: *DWORD) callconv(.winapi) DWORD;
extern "kernel32" fn OpenProcess(access: u32, inherit_handle: BOOL, process_id: DWORD) callconv(.winapi) HANDLE;
extern "kernel32" fn QueryFullProcessImageNameW(process: HANDLE, flags: u32, path: [*]u16, size: *DWORD) callconv(.winapi) BOOL;
extern "kernel32" fn CloseHandle(handle: HANDLE) callconv(.winapi) BOOL;
extern "kernel32" fn Sleep(milliseconds: DWORD) callconv(.winapi) void;
extern "dwmapi" fn DwmGetWindowAttribute(window: HWND, attribute: u32, value: *anyopaque, size: DWORD) callconv(.winapi) HRESULT;

const CLSID_ApplicationActivationManager = GUID{
    .Data1 = 0x45BA127D,
    .Data2 = 0x10A8,
    .Data3 = 0x46EA,
    .Data4 = .{ 0x8A, 0xB7, 0x56, 0xEA, 0x90, 0x78, 0x94, 0x3C },
};

const IID_IApplicationActivationManager = GUID{
    .Data1 = 0x2E941141,
    .Data2 = 0x7F97,
    .Data3 = 0x4756,
    .Data4 = .{ 0xBA, 0x1D, 0x9D, 0xEC, 0xDE, 0x89, 0x4A, 0x3D },
};

const COINIT_APARTMENTTHREADED: u32 = 0x2;
const CLSCTX_LOCAL_SERVER: u32 = 0x4;
const AO_NONE: u32 = 0;
const GW_OWNER: u32 = 4;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const DWMWA_CLOAKED: u32 = 14;

var target_executable: []const u16 = &.{};
var found_process_id: DWORD = 0;

fn endsWithPathIgnoreCase(path: []const u16, suffix: []const u16) bool {
    if (path.len < suffix.len) return false;
    const tail = path[path.len - suffix.len ..];
    for (tail, suffix) |left_character, right_character| {
        const normalized_left = if (left_character >= 'A' and left_character <= 'Z') left_character + 32 else left_character;
        const normalized_right = if (right_character >= 'A' and right_character <= 'Z') right_character + 32 else right_character;
        if (normalized_left != normalized_right) return false;
    }
    return true;
}

fn enumWindow(window: HWND, _: isize) callconv(.winapi) BOOL {
    if (IsWindowVisible(window) == 0 or GetWindow(window, GW_OWNER) != null) return 1;
    var cloaked: DWORD = 0;
    if (!failed(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, @sizeOf(DWORD))) and cloaked != 0) return 1;
    var rectangle: RECT = undefined;
    if (GetWindowRect(window, &rectangle) == 0) return 1;
    if (IsIconic(window) == 0 and (rectangle.right - rectangle.left < 320 or rectangle.bottom - rectangle.top < 200)) return 1;

    var process_id: DWORD = 0;
    _ = GetWindowThreadProcessId(window, &process_id);
    if (process_id == 0) return 1;
    const process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
    if (process == null) return 1;
    defer _ = CloseHandle(process);
    var path_buffer: [32768]u16 = undefined;
    var path_size: DWORD = path_buffer.len;
    if (QueryFullProcessImageNameW(process, 0, &path_buffer, &path_size) == 0) return 1;
    if (!endsWithPathIgnoreCase(path_buffer[0..path_size], target_executable)) return 1;
    found_process_id = process_id;
    return 0;
}

fn failed(value: HRESULT) bool {
    return value < 0;
}

fn printHresult(value: HRESULT) void {
    const unsigned: u32 = @bitCast(value);
    std.debug.print("HRESULT=0x{X:0>8}\n", .{unsigned});
}

fn waitForWindow(allocator: std.mem.Allocator, executable_utf8: []const u8, timeout_utf8: []const u8) u8 {
    const executable = std.unicode.utf8ToUtf16LeAlloc(allocator, executable_utf8) catch {
        std.debug.print("ERROR=executable-utf16\n", .{});
        return 31;
    };
    defer allocator.free(executable);
    const timeout_ms = std.fmt.parseInt(DWORD, timeout_utf8, 10) catch {
        std.debug.print("ERROR=timeout\n", .{});
        return 32;
    };
    target_executable = executable;
    const iterations = @max(@as(DWORD, 1), timeout_ms / 100);
    var stable_process_id: DWORD = 0;
    var stable_count: u8 = 0;
    var iteration: DWORD = 0;
    while (iteration < iterations) : (iteration += 1) {
        found_process_id = 0;
        _ = EnumWindows(enumWindow, 0);
        if (found_process_id != 0) {
            if (found_process_id == stable_process_id) stable_count += 1 else {
                stable_process_id = found_process_id;
                stable_count = 1;
            }
            if (stable_count >= 3) {
                std.debug.print("WINDOW_PID={d}\n", .{found_process_id});
                return 0;
            }
        } else {
            stable_process_id = 0;
            stable_count = 0;
        }
        Sleep(100);
    }
    std.debug.print("ERROR=window-timeout\n", .{});
    return 30;
}

pub fn main(init: std.process.Init) u8 {
    const allocator = init.gpa;
    var iterator = std.process.Args.Iterator.initAllocator(init.minimal.args, allocator) catch {
        std.debug.print("ERROR=args\n", .{});
        return 10;
    };
    defer iterator.deinit();

    _ = iterator.next();
    const first_flag = iterator.next();
    if (first_flag != null and std.mem.eql(u8, first_flag.?, "--wait-window")) {
        const executable_flag = iterator.next();
        const executable_value = iterator.next();
        const timeout_flag = iterator.next();
        const timeout_value = iterator.next();
        if (executable_flag == null or executable_value == null or timeout_flag == null or timeout_value == null or iterator.next() != null or
            !std.mem.eql(u8, executable_flag.?, "--executable") or !std.mem.eql(u8, timeout_flag.?, "--timeout-ms"))
        {
            std.debug.print("ERROR=usage\n", .{});
            return 11;
        }
        return waitForWindow(allocator, executable_value.?, timeout_value.?);
    }

    const aumid_flag = first_flag;
    const aumid_value = iterator.next();
    const arguments_flag = iterator.next();
    const arguments_value = iterator.next();
    if (aumid_flag == null or aumid_value == null or arguments_flag == null or arguments_value == null or iterator.next() != null or
        !std.mem.eql(u8, aumid_flag.?, "--aumid") or !std.mem.eql(u8, arguments_flag.?, "--arguments"))
    {
        std.debug.print("ERROR=usage\n", .{});
        return 11;
    }

    const aumid = std.unicode.utf8ToUtf16LeAllocZ(allocator, aumid_value.?) catch {
        std.debug.print("ERROR=aumid-utf16\n", .{});
        return 12;
    };
    defer allocator.free(aumid);
    const arguments = std.unicode.utf8ToUtf16LeAllocZ(allocator, arguments_value.?) catch {
        std.debug.print("ERROR=arguments-utf16\n", .{});
        return 13;
    };
    defer allocator.free(arguments);

    const init_result = CoInitializeEx(null, COINIT_APARTMENTTHREADED);
    if (failed(init_result)) {
        printHresult(init_result);
        return 20;
    }
    defer CoUninitialize();

    var raw_manager: ?*anyopaque = null;
    const create_result = CoCreateInstance(
        &CLSID_ApplicationActivationManager,
        null,
        CLSCTX_LOCAL_SERVER,
        &IID_IApplicationActivationManager,
        &raw_manager,
    );
    if (failed(create_result) or raw_manager == null) {
        printHresult(create_result);
        return 21;
    }

    const manager: *IApplicationActivationManager = @ptrCast(@alignCast(raw_manager.?));
    defer _ = manager.lpVtbl.Release(manager);

    var process_id: DWORD = 0;
    const activate_result = manager.lpVtbl.ActivateApplication(
        manager,
        aumid.ptr,
        arguments.ptr,
        AO_NONE,
        &process_id,
    );
    if (failed(activate_result) or process_id == 0) {
        printHresult(activate_result);
        return 22;
    }

    std.debug.print("PID={d}\n", .{process_id});
    return 0;
}
