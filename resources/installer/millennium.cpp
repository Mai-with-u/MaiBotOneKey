// Presentation only. NSIS owns navigation, validation, extraction and launch.
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <algorithm>
#include <string>

namespace {
constexpr COLORREF shell = RGB(221,212,191), panel = RGB(235,228,210), hi = RGB(246,241,227), lo = RGB(189,179,156);
constexpr COLORREF ink = RGB(74,68,58), line = RGB(90,84,74), screen = RGB(251,249,240);
constexpr COLORREF mint = RGB(143,214,160), coral = RGB(240,138,93), key = RGB(243,238,225);
constexpr UINT_PTR subclassId = 0x4d4149;
constexpr int minimizeId = 29001, closeId = 29002;
struct Theme {
    HWND parent = nullptr;
    int dpi = 96, phase = 0;
    HFONT body = nullptr, heading = nullptr, smallFont = nullptr, brandFont = nullptr, screenFont = nullptr;
    HBRUSH shellBrush = nullptr, textureBrush = nullptr, screenBrush = nullptr;
    std::wstring version;
    bool chinese = true;
} ui;
int px(int n) { return MulDiv(n,ui.dpi,96); }
void place(HWND h,int x,int y,int w,int height) {
    if(h) MoveWindow(h,px(x),px(y),px(w),px(height),TRUE);
}
void fill(HDC dc,int x,int y,int w,int h,COLORREF color) {
    RECT r{px(x),px(y),px(x+w),px(y+h)};
    HBRUSH b=CreateSolidBrush(color); FillRect(dc,&r,b); DeleteObject(b);
}
void box(HDC dc,int x,int y,int w,int h,COLORREF color,bool sunk=false) {
    fill(dc,x,y,w,h,line); fill(dc,x+1,y+1,w-2,h-2,color);
    fill(dc,x+2,y+2,w-4,2,sunk?lo:hi); fill(dc,x+2,y+2,2,h-4,sunk?lo:hi);
    fill(dc,x+2,y+h-4,w-4,2,sunk?hi:lo); fill(dc,x+w-4,y+2,2,h-4,sunk?hi:lo);
}
void text(HDC dc,const wchar_t* s,int x,int y,int w,int h,HFONT f,COLORREF color=ink,UINT flags=DT_LEFT|DT_VCENTER|DT_SINGLELINE) {
    RECT r{px(x),px(y),px(x+w),px(y+h)};
    auto old=SelectObject(dc,f); SetBkMode(dc,TRANSPARENT); SetTextColor(dc,color);
    DrawTextW(dc,s,-1,&r,flags); SelectObject(dc,old);
}
HFONT font(int size,int weight) {
    return CreateFontW(-px(size),0,0,0,weight,FALSE,FALSE,FALSE,DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Microsoft YaHei UI");
}
void surface(HDC dc,HWND window) {
    RECT r{}; GetClientRect(window,&r);
    POINT origin{}; MapWindowPoints(window,ui.parent,&origin,1);
    SetBrushOrgEx(dc,-origin.x,-origin.y,nullptr);
    FillRect(dc,&r,ui.textureBrush);
}
void steps(HDC dc) {
    const int active=ui.phase==4?2:ui.phase==3?1:0;
    const wchar_t* zh[]={L"位置",L"安装",L"完成"};
    const wchar_t* en[]={L"Location",L"Install",L"Ready"};
    for(int i=0;i<3;++i) {
        int x=38+i*72;
        box(dc,x,334,9,9,i<active?mint:i==active?coral:shell);
        text(dc,ui.chinese?zh[i]:en[i],x+14,328,56,22,ui.smallFont,i<=active?ink:RGB(139,130,110));
        if(i<2) fill(dc,x+57,338,11,1,lo);
    }
}
void paintFrame(HDC dc) {
    // One continuous surface; only the computer and controls have bevels.
    surface(dc,ui.parent);
    fill(dc,0,0,700,1,lo); fill(dc,0,429,700,1,lo);
    fill(dc,0,0,1,430,lo); fill(dc,699,0,1,430,lo);
    // A shallow plastic title strip with native button semantics and drag area.
    fill(dc,0,0,700,2,hi); fill(dc,0,38,700,1,lo); fill(dc,0,39,700,1,hi);
    box(dc,16,15,9,9,mint);
    text(dc,L"MAIBOT ONEKEY",36,4,168,30,ui.brandFont);
    box(dc,207,11,68,19,coral);
    text(dc,ui.version.c_str(),210,10,62,20,ui.smallFont,ink,DT_CENTER|DT_VCENTER|DT_SINGLELINE);
    for(int x=294;x<604;x+=5) { fill(dc,x,14,2,12,lo); fill(dc,x+2,14,1,12,hi); }
    fill(dc,260,40,1,389,lo); fill(dc,261,40,1,389,hi);
    fill(dc,278,354,394,1,lo); fill(dc,278,355,394,1,hi);
    int saved=SaveDC(dc);
    SetGraphicsMode(dc,GM_ADVANCED);
    XFORM illustration{0.8f,0,0,0.8f,static_cast<FLOAT>(px(-3)),static_cast<FLOAT>(px(6))};
    SetWorldTransform(dc,&illustration);
    // CRT and disk drive follow the existing MillenniumComputer illustration.
    box(dc,48,123,236,191,panel); box(dc,62,138,208,137,lo,true);
    fill(dc,68,144,196,125,RGB(40,52,43));
    for(int y=146;y<267;y+=4) fill(dc,69,y,194,1,RGB(44,58,47));
    text(dc,ui.phase==3?L"INSTALLING...":L"HELLO, MAI!",78,178,176,32,ui.screenFont,mint,DT_CENTER|DT_VCENTER|DT_SINGLELINE);
    const wchar_t* status=ui.chinese?(ui.phase==4?L"安装完成":ui.phase==3?L"正在安装":L"准备安装"):
        (ui.phase==4?L"READY":ui.phase==3?L"PLEASE WAIT":L"READY TO INSTALL");
    text(dc,status,80,216,172,20,ui.smallFont,mint,DT_CENTER|DT_VCENTER|DT_SINGLELINE);
    fill(dc,65,287,68,15,line); text(dc,L"MAIBOT",69,286,60,16,ui.smallFont,key);
    for(int x=155;x<225;x+=7) fill(dc,x,288,2,12,lo);
    box(dc,251,288,11,11,mint); box(dc,143,314,46,12,lo);
    box(dc,34,326,264,59,panel); box(dc,48,339,90,24,key); fill(dc,55,348,73,4,line);
    for(int y=341;y<=365;y+=6) fill(dc,153,y,67,2,lo);
    box(dc,244,337,37,36,coral); fill(dc,261,345,2,10,ink);
    fill(dc,254,351,2,10,ink); fill(dc,269,351,2,10,ink); fill(dc,254,361,17,2,ink);
    fill(dc,49,385,27,4,line); fill(dc,256,385,27,4,line);
    RestoreDC(dc,saved);
    steps(dc);
    text(dc,ui.version.c_str(),278,380,56,20,ui.smallFont);
}
bool drawButton(HWND owner,NMHDR* header,LRESULT& result) {
    if(header->code!=NM_CUSTOMDRAW) return false;
    wchar_t cls[32]{}; GetClassNameW(header->hwndFrom,cls,32);
    if(lstrcmpiW(cls,L"Button")!=0) return false;
    auto d=reinterpret_cast<NMCUSTOMDRAW*>(header);
    if(d->dwDrawStage!=CDDS_PREPAINT) return false;
    LONG_PTR type=GetWindowLongPtrW(header->hwndFrom,GWL_STYLE)&BS_TYPEMASK;
    if(type!=BS_PUSHBUTTON && type!=BS_DEFPUSHBUTTON) return false;
    RECT r{}; GetClientRect(header->hwndFrom,&r);
    bool primary=owner==ui.parent && GetDlgCtrlID(header->hwndFrom)==IDOK;
    bool disabled=!IsWindowEnabled(header->hwndFrom), down=(d->uItemState&CDIS_SELECTED)!=0;
    HBRUSH b=CreateSolidBrush(line); FillRect(d->hdc,&r,b); DeleteObject(b);
    InflateRect(&r,-px(1),-px(1)); b=CreateSolidBrush(disabled?shell:primary?coral:key);
    FillRect(d->hdc,&r,b); DeleteObject(b);
    RECT edge=r; edge.bottom=edge.top+px(down?3:2); b=CreateSolidBrush(down?lo:hi);
    FillRect(d->hdc,&edge,b); DeleteObject(b);
    edge=r; edge.top=edge.bottom-px(down?1:4); b=CreateSolidBrush(primary?RGB(194,100,60):lo);
    FillRect(d->hdc,&edge,b); DeleteObject(b);
    wchar_t label[256]{}; GetWindowTextW(header->hwndFrom,label,256);
    auto old=SelectObject(d->hdc,ui.body); SetBkMode(d->hdc,TRANSPARENT);
    SetTextColor(d->hdc,disabled?RGB(139,130,110):ink); OffsetRect(&r,0,down?px(1):-px(1));
    DrawTextW(d->hdc,label,-1,&r,DT_CENTER|DT_VCENTER|DT_SINGLELINE); SelectObject(d->hdc,old);
    // Follow Windows' keyboard-cue visibility instead of showing a focus ring
    // whenever a mouse click happens to leave the button focused.
    const LRESULT cues=SendMessageW(header->hwndFrom,WM_QUERYUISTATE,0,0);
    if((d->uItemState&CDIS_FOCUS) && !(cues&UISF_HIDEFOCUS)) {
        InflateRect(&r,-px(4),-px(4));
        HBRUSH focus=CreateSolidBrush(line);
        FrameRect(d->hdc,&r,focus);
        DeleteObject(focus);
    }
    result=CDRF_SKIPDEFAULT; return true;
}
LRESULT CALLBACK surfaceProc(HWND h,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
    switch(msg) {
    case WM_NCCALCSIZE:
        if(h==ui.parent) return 0;
        break;
    case WM_GETMINMAXINFO:
        if(h==ui.parent) {
            auto limits=reinterpret_cast<MINMAXINFO*>(lp);
            limits->ptMinTrackSize={px(700),px(430)};
            limits->ptMaxTrackSize=limits->ptMinTrackSize;
            return 0;
        }
        break;
    case WM_NCHITTEST:
        if(h==ui.parent) {
            POINT point{static_cast<short>(LOWORD(lp)),static_cast<short>(HIWORD(lp))};
            ScreenToClient(h,&point);
            return point.y<px(40) && point.x<px(612) ? HTCAPTION : HTCLIENT;
        }
        break;
    case WM_NCLBUTTONDBLCLK:
        if(h==ui.parent && wp==HTCAPTION) return 0;
        break;
    case WM_COMMAND:
        if(h==ui.parent && LOWORD(wp)==minimizeId) { ShowWindow(h,SW_MINIMIZE); return 0; }
        if(h==ui.parent && LOWORD(wp)==closeId) { PostMessageW(h,WM_CLOSE,0,0); return 0; }
        break;
    case WM_UPDATEUISTATE: {
        LRESULT result=DefSubclassProc(h,msg,wp,lp);
        RedrawWindow(h,nullptr,nullptr,RDW_INVALIDATE|RDW_ALLCHILDREN);
        return result;
    }
    case WM_ERASEBKGND:
        if(h==ui.parent) paintFrame(reinterpret_cast<HDC>(wp));
        else surface(reinterpret_cast<HDC>(wp),h);
        return TRUE;
    case WM_CTLCOLORSTATIC: case WM_CTLCOLORBTN:
        {
            HDC dc=reinterpret_cast<HDC>(wp);
            POINT origin{}; MapWindowPoints(reinterpret_cast<HWND>(lp),ui.parent,&origin,1);
            SetBrushOrgEx(dc,-origin.x,-origin.y,nullptr);
            SetTextColor(dc,ink); SetBkMode(dc,TRANSPARENT);
            return reinterpret_cast<LRESULT>(ui.textureBrush);
        }
    case WM_CTLCOLOREDIT: case WM_CTLCOLORLISTBOX:
        SetTextColor(reinterpret_cast<HDC>(wp),ink); SetBkColor(reinterpret_cast<HDC>(wp),screen);
        return reinterpret_cast<LRESULT>(ui.screenBrush);
    case WM_NOTIFY: {
        LRESULT result=0; if(drawButton(h,reinterpret_cast<NMHDR*>(lp),result)) return result; break;
    }
    case WM_NCDESTROY: RemoveWindowSubclass(h,surfaceProc,subclassId); break;
    }
    return DefSubclassProc(h,msg,wp,lp);
}
LRESULT CALLBACK progressProc(HWND h,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
    if(msg==WM_PAINT) {
        PAINTSTRUCT ps{}; HDC dc=BeginPaint(h,&ps); RECT r{}; GetClientRect(h,&r);
        FillRect(dc,&r,ui.screenBrush); FrameRect(dc,&r,ui.shellBrush);
        PBRANGE range{}; SendMessageW(h,PBM_GETRANGE,FALSE,reinterpret_cast<LPARAM>(&range));
        int position=static_cast<int>(SendMessageW(h,PBM_GETPOS,0,0));
        int span=range.iHigh-range.iLow, width=r.right-px(6);
        int filled=span>0?MulDiv(width,std::clamp(position,range.iLow,range.iHigh)-range.iLow,span):0;
        HBRUSH green=CreateSolidBrush(mint);
        for(int x=px(3);x<px(3)+filled;x+=px(12)) {
            RECT cell{x,px(3),std::min(x+px(9),px(3)+filled),r.bottom-px(3)}; FillRect(dc,&cell,green);
        }
        DeleteObject(green); EndPaint(h,&ps); return 0;
    }
    LRESULT result=DefSubclassProc(h,msg,wp,lp);
    if(msg==PBM_SETPOS || msg==PBM_DELTAPOS || msg==PBM_STEPIT || msg==PBM_SETRANGE || msg==PBM_SETRANGE32)
        InvalidateRect(h,nullptr,FALSE);
    if(msg==WM_NCDESTROY) RemoveWindowSubclass(h,progressProc,subclassId);
    return result;
}
void styleChildren(HWND parent) {
    for(HWND c=GetWindow(parent,GW_CHILD);c;c=GetWindow(c,GW_HWNDNEXT))
        SendMessageW(c,WM_SETFONT,reinterpret_cast<WPARAM>(ui.body),FALSE);
}
void control(HWND page,int id,int x,int y,int w,int h) { place(GetDlgItem(page,id),x,y,w,h); }
}

extern "C" __declspec(dllexport) int __cdecl Initialize(HWND parent,LPCWSTR version,int language) {
    if(ui.parent) return 1;
    ui.parent=parent; HDC dc=GetDC(parent); ui.dpi=GetDeviceCaps(dc,LOGPIXELSX); ReleaseDC(parent,dc);
    ui.version=version; ui.chinese=PRIMARYLANGID(language)==LANG_CHINESE;
    ui.body=font(14,FW_NORMAL); ui.heading=font(24,FW_BOLD);
    ui.smallFont=font(11,FW_NORMAL); ui.brandFont=font(14,FW_BOLD); ui.screenFont=font(20,FW_NORMAL);
    ui.shellBrush=CreateSolidBrush(shell); ui.screenBrush=CreateSolidBrush(screen);
    // A low-contrast six-pixel grain tile, shared by pages and static controls.
    int tile=px(6);
    HDC bitmapDc=CreateCompatibleDC(nullptr);
    HDC parentDc=GetDC(parent);
    HBITMAP bitmap=CreateCompatibleBitmap(parentDc,tile,tile);
    ReleaseDC(parent,parentDc);
    auto oldBitmap=SelectObject(bitmapDc,bitmap);
    RECT tileRect{0,0,tile,tile}; FillRect(bitmapDc,&tileRect,ui.shellBrush);
    SetPixelV(bitmapDc,0,0,RGB(207,197,176));
    SetPixelV(bitmapDc,1,1,RGB(232,224,205));
    ui.textureBrush=CreatePatternBrush(bitmap);
    SelectObject(bitmapDc,oldBitmap); DeleteObject(bitmap); DeleteDC(bitmapDc);
    SetWindowSubclass(parent,surfaceProc,subclassId,0);
    // NSIS dialogs also carry extended modal/window edges. Remove both sets of
    // native edges so they cannot leave a white frame around the client chrome.
    LONG_PTR style=GetWindowLongPtrW(parent,GWL_STYLE);
    SetWindowLongPtrW(parent,GWL_STYLE,
        (style & ~(WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_MAXIMIZEBOX)) | WS_POPUP | WS_SYSMENU | WS_MINIMIZEBOX);
    LONG_PTR extendedStyle=GetWindowLongPtrW(parent,GWL_EXSTYLE);
    SetWindowLongPtrW(parent,GWL_EXSTYLE,
        extendedStyle & ~(WS_EX_DLGMODALFRAME | WS_EX_CLIENTEDGE | WS_EX_WINDOWEDGE | WS_EX_STATICEDGE));
    const DWORD borderAttribute=34, cornerAttribute=33, squareCorners=1, noNativeBorder=0xfffffffe;
    DwmSetWindowAttribute(parent,borderAttribute,&noNativeBorder,sizeof(noNativeBorder));
    DwmSetWindowAttribute(parent,cornerAttribute,&squareCorners,sizeof(squareCorners));
    MARGINS margins{0,0,0,0}; DwmExtendFrameIntoClientArea(parent,&margins);
    MONITORINFO info{}; info.cbSize=sizeof(info); GetMonitorInfoW(MonitorFromWindow(parent,MONITOR_DEFAULTTONEAREST),&info);
    int w=px(700),h=px(430);
    SetWindowPos(parent,nullptr,info.rcWork.left+(info.rcWork.right-info.rcWork.left-w)/2,
        info.rcWork.top+(info.rcWork.bottom-info.rcWork.top-h)/2,w,h,SWP_NOZORDER|SWP_NOACTIVATE|SWP_FRAMECHANGED);
    HWND minimize=CreateWindowExW(0,L"Button",L"−",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_PUSHBUTTON,
        0,0,0,0,parent,reinterpret_cast<HMENU>(minimizeId),GetModuleHandleW(nullptr),nullptr);
    HWND close=CreateWindowExW(0,L"Button",L"×",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_PUSHBUTTON,
        0,0,0,0,parent,reinterpret_cast<HMENU>(closeId),GetModuleHandleW(nullptr),nullptr);
    place(minimize,616,7,30,26); place(close,654,7,30,26);
    styleChildren(parent);
    SendMessageW(parent,WM_CHANGEUISTATE,MAKEWPARAM(UIS_SET,UISF_HIDEFOCUS),0);
    return 1;
}
extern "C" __declspec(dllexport) void __cdecl StylePage(HWND parent,HWND page,int phase) {
    if(!ui.parent || !page) return;
    ui.phase=phase; SetWindowSubclass(page,surfaceProc,subclassId,0);
    place(page,278,148,394,196); styleChildren(page);
    // Some NSIS stubs give the header separator an anonymous ID. Hide decorative
    // parent statics by class, preserving only the two live page headings.
    for(HWND c=GetWindow(parent,GW_CHILD);c;c=GetWindow(c,GW_HWNDNEXT)) {
        wchar_t cls[32]{}; GetClassNameW(c,cls,32);
        int id=GetDlgCtrlID(c);
        if(lstrcmpiW(cls,L"Static")==0 && id!=1037 && id!=1038) ShowWindow(c,SW_HIDE);
    }
    control(parent,1037,278,76,394,32); control(parent,1038,278,112,394,28);
    ShowWindow(GetDlgItem(parent,1037),SW_SHOW);
    ShowWindow(GetDlgItem(parent,1038),SW_SHOW);
    SendMessageW(GetDlgItem(parent,1037),WM_SETFONT,reinterpret_cast<WPARAM>(ui.heading),TRUE);
    control(parent,IDOK,550,372,122,36); control(parent,3,338,372,96,36); control(parent,IDCANCEL,444,372,96,36);
    if(phase==0 || phase==4) {
        ShowWindow(GetDlgItem(parent,1037),SW_HIDE); ShowWindow(GetDlgItem(parent,1038),SW_HIDE);
        place(page,278,82,394,250);
        int label=0,option=0;
        for(HWND c=GetWindow(page,GW_CHILD);c;c=GetWindow(c,GW_HWNDNEXT)) {
            wchar_t cls[32]{}; GetClassNameW(c,cls,32); LONG_PTR style=GetWindowLongPtrW(c,GWL_STYLE);
            if(lstrcmpiW(cls,L"Static")==0) {
                if((style&SS_TYPEMASK)==SS_BITMAP) { ShowWindow(c,SW_HIDE); continue; }
                if(label++==0) { place(c,0,0,394,44); SendMessageW(c,WM_SETFONT,reinterpret_cast<WPARAM>(ui.heading),TRUE); }
                else place(c,0,64,394,100);
            } else if(lstrcmpiW(cls,L"Button")==0) place(c,0,170+option++*30,394,28);
        }
    } else if(phase==1) {
        int label=0,option=0;
        for(HWND c=GetWindow(page,GW_CHILD);c;c=GetWindow(c,GW_HWNDNEXT)) {
            wchar_t cls[32]{}; GetClassNameW(c,cls,32);
            if(lstrcmpiW(cls,L"Static")==0) {
                if(label++==0) place(c,0,0,394,40);
                else place(c,0,132,394,60);
            } else if(lstrcmpiW(cls,L"Button")==0) place(c,0,46+option++*40,394,34);
        }
    } else if(phase==2) {
        // The concise header supplies the instruction; the stock paragraph
        // repeats it and can wrap underneath the path editor at larger scales.
        ShowWindow(GetDlgItem(page,1006),SW_HIDE); ShowWindow(GetDlgItem(page,1020),SW_HIDE);
        control(page,1019,0,16,292,32); control(page,1001,302,16,92,32);
        // Space requirements belong to one quiet metadata row below the path.
        control(page,1023,0,84,190,24); control(page,1024,200,84,194,24);
    } else if(phase==3) {
        SetWindowTextW(GetDlgItem(parent,1038),L"MaiBot OneKey"); ShowWindow(GetDlgItem(page,1006),SW_HIDE);
        control(page,1004,0,8,394,22); control(page,1027,0,44,138,28);
        control(page,1016,0,82,394,110);
        SetWindowSubclass(GetDlgItem(page,1004),progressProc,subclassId,0);
        ListView_SetBkColor(GetDlgItem(page,1016),screen); ListView_SetTextBkColor(GetDlgItem(page,1016),screen);
        ListView_SetTextColor(GetDlgItem(page,1016),ink);
    }
    RedrawWindow(parent,nullptr,nullptr,RDW_INVALIDATE|RDW_ERASE|RDW_ALLCHILDREN);
}
extern "C" __declspec(dllexport) void __cdecl Shutdown() {
    if(IsWindow(ui.parent)) RemoveWindowSubclass(ui.parent,surfaceProc,subclassId);
    for(HFONT h : {ui.body,ui.heading,ui.smallFont,ui.brandFont,ui.screenFont}) if(h) DeleteObject(h);
    for(HBRUSH h : {ui.shellBrush,ui.textureBrush,ui.screenBrush}) if(h) DeleteObject(h);
    ui=Theme{};
}
