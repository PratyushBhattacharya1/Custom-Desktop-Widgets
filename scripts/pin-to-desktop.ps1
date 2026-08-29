param([long]$Hwnd)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class DesktopPin {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
    [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    public static IntPtr GetWorkerW() {
        IntPtr progman = FindWindow("Progman", null);
        IntPtr result;
        SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out result);

        IntPtr workerw = IntPtr.Zero;
        EnumWindows(new EnumWindowsProc((hWnd, lParam) => {
            IntPtr shellView = FindWindowEx(hWnd, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (shellView != IntPtr.Zero) {
                workerw = FindWindowEx(IntPtr.Zero, hWnd, "WorkerW", null);
            }
            return true;
        }), IntPtr.Zero);

        return workerw;
    }

    public static bool Pin(IntPtr target) {
        IntPtr workerw = GetWorkerW();
        if (workerw != IntPtr.Zero) {
            SetParent(target, workerw);
            return true;
        }
        return false;
    }
}
"@

$target = [IntPtr]$Hwnd
$ok = [DesktopPin]::Pin($target)
Write-Output $ok
