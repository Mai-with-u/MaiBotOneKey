// Hidden native regression fixture. It never sends input to another process.
#include "../../resources/installer/millennium.cpp"
#include <cstdio>

namespace {
HWND child(HWND parent, const wchar_t* cls, int id, DWORD style = 0) {
    return CreateWindowExW(0, cls, L"Test", WS_CHILD | WS_VISIBLE | style,
        0, 0, 10, 10, parent, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), GetModuleHandleW(nullptr), nullptr);
}
bool bounds(HWND window, HWND parent, int x, int y, int width) {
    RECT r{};
    GetWindowRect(window, &r);
    MapWindowPoints(nullptr, parent, reinterpret_cast<POINT*>(&r), 2);
    return r.left == px(x) && r.top == px(y) && r.right - r.left == px(width);
}
bool shown(HWND window) { return (GetWindowLongPtrW(window, GWL_STYLE) & WS_VISIBLE) != 0; }
}
int main() {
    INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_PROGRESS_CLASS | ICC_LISTVIEW_CLASSES};
    InitCommonControlsEx(&controls);
    HWND parent = CreateWindowExW(0, L"STATIC", L"Installer fixture", WS_OVERLAPPEDWINDOW,
        0, 0, 800, 600, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!parent) return 1;
    child(parent, L"Static", 1037);
    child(parent, L"Static", 1038);
    child(parent, L"Button", IDOK);
    child(parent, L"Button", IDCANCEL);
    child(parent, L"Button", 3);
    HWND welcome = child(parent, L"Static", 2000);
    child(welcome, L"Static", 2001);
    child(welcome, L"Static", 2002);
    HWND mode = child(parent, L"Static", 2010);
    child(mode, L"Static", 2011);
    HWND allUsers = child(mode, L"Button", 2012, BS_AUTORADIOBUTTON);
    HWND currentUser = child(mode, L"Button", 2013, BS_AUTORADIOBUTTON);
    child(mode, L"Static", 2014);
    HWND directory = child(parent, L"Static", 2020);
    child(directory, L"Static", 1006);
    HWND path = child(directory, L"Edit", 1019);
    child(directory, L"Button", 1001);
    child(directory, L"Static", 1020);
    child(directory, L"Static", 1023);
    child(directory, L"Static", 1024);
    Initialize(parent, L"test", 2052);
    bool passed = true;
    passed &= (GetWindowLongPtrW(parent, GWL_STYLE) & (WS_CAPTION | WS_THICKFRAME | WS_BORDER)) == 0;
    passed &= (GetWindowLongPtrW(parent, GWL_EXSTYLE) & (WS_EX_DLGMODALFRAME | WS_EX_CLIENTEDGE | WS_EX_WINDOWEDGE | WS_EX_STATICEDGE)) == 0;
    RECT client{};
    GetClientRect(parent, &client);
    passed &= client.right == px(700) && client.bottom == px(430);
    passed &= bounds(GetDlgItem(parent, minimizeId), parent, 616, 7, 30);
    passed &= bounds(GetDlgItem(parent, closeId), parent, 654, 7, 30);
    // Multiple live pages reproduce the condition which made FindWindow unsafe.
    for (int round = 0; round < 3; ++round) {
        StylePage(parent, welcome, 0);
        passed &= bounds(welcome, parent, 278, 82, 394) && !shown(GetDlgItem(parent, 1037));
        StylePage(parent, mode, 1);
        passed &= bounds(mode, parent, 278, 148, 394) && shown(GetDlgItem(parent, 1037));
        passed &= bounds(allUsers, mode, 0, 46, 394) && bounds(currentUser, mode, 0, 86, 394);
        StylePage(parent, directory, 2);
        passed &= bounds(directory, parent, 278, 148, 394) && bounds(path, directory, 0, 16, 292);
        passed &= !shown(GetDlgItem(directory, 1006));
        StylePage(parent, mode, 1);
        passed &= bounds(mode, parent, 278, 148, 394) && shown(GetDlgItem(parent, 1038));
    }
    DestroyWindow(parent);
    Shutdown();
    std::puts(passed ? "PASS: repeated forward/back layout with multiple live pages" : "FAIL: installer page layout");
    return passed ? 0 : 1;
}
