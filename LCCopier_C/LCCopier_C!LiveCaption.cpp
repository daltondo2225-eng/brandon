#include "LiveCaption.h"
#include "SettingsDialog.h"
#include <commctrl.h>

HINSTANCE hInst;
WCHAR szTitle[MAX_LOADSTRING];
WCHAR szWindowClass[MAX_LOADSTRING];
HBRUSH g_hEditBrush = nullptr;
HFONT g_hCaptionFont = nullptr;
static std::wstring g_lastCaptionText;
static std::wstring g_captionHistory;
static std::wstring g_previousCaption;
static int g_anchorCharIndex = 0;
static int g_anchorHistoryIndex = 0;
static bool g_anchorSetByUser = false;
static volatile long g_pasteInProgress = 0;
static HWND g_hMainWnd = nullptr;
static HHOOK g_hKbHook = nullptr;
static HHOOK g_hMouseHook = nullptr;
static bool g_middleButtonPaste = true;
static bool g_middleButtonReplaceAll = true;
static bool g_pressEnterAfterPaste = false;
static bool g_userScrolledUp = false;
static HotkeyConfig g_autoCopyHotkey   = { true, true, false, false, 'A' };
static HotkeyConfig g_autoDeleteHotkey = { true, true, false, false, 'D' };
static bool g_altSuppressed = false; // true when we swallowed a VK_MENU keydown to prevent menu-bar activation
static bool g_altPhysicallyDown = false; // tracks if Alt key is physically pressed (regardless of suppression)
static ITaskbarList* g_pTaskbarList    = nullptr;
// Cached settings: refreshed in WM_CREATE and WM_APP_SETTINGS_CHANGED so paint
// handlers don't hit the registry on every WM_CTLCOLOREDIT / ApplyAnchorHighlight.
static AppSettings g_settings = {};
// Cached UIA singleton + last-known Live Captions HWND so the 400ms poll
// doesn't CoCreateInstance + EnumWindows on every tick.
static IUIAutomation* g_pAutomation = nullptr;
static HWND g_hwndCaption = nullptr;
// Tray icon: present only while invisible mode is on, since the taskbar button
// is hidden then and the user otherwise has no way to summon the window.
static bool g_trayIconAdded = false;
static const UINT TRAY_ICON_UID = 1;
ATOM MyRegisterClass(HINSTANCE hInstance);
BOOL InitInstance(HINSTANCE, int);
LRESULT CALLBACK WndProc(HWND, UINT, WPARAM, LPARAM);
std::wstring GetLiveCaptionText();
static BOOL CALLBACK FindLiveCaptionWindow(HWND hwnd, LPARAM lParam);
static bool CollectTextFromElement(IUIAutomation* pAutomation, IUIAutomationElement* pElement, std::wstring& out, bool skipRootName);
static bool IsUiChrome(const wchar_t* name);
static void ApplyAnchorHighlight(HWND hEdit);
static LRESULT CALLBACK LowLevelKbHook(int nCode, WPARAM wParam, LPARAM lParam);
static LRESULT CALLBACK LowLevelMouseHook(int nCode, WPARAM wParam, LPARAM lParam);
static LRESULT CALLBACK EditSubclassProc(HWND hWnd, UINT uMsg, WPARAM wParam, LPARAM lParam);
static bool PasteViaClipboard(const std::wstring& text);
static void DoFindAndCopyWork(bool replaceAll = false);
static void UpdateCaptionHistory(const std::wstring& currentText);
// Helper: returns true for any Alt virtual-key code.
// In a low-level keyboard hook, the physical Alt key reports as VK_LMENU (left)
// or VK_RMENU (right), NOT as VK_MENU.  We must handle all three.
static bool IsAltVk(DWORD vk) {
	return vk == VK_MENU || vk == VK_LMENU || vk == VK_RMENU;
}

static BOOL CALLBACK FindLiveCaptionWindow(HWND hwnd, LPARAM lParam) {
	WCHAR title[256] = {};
	if (!GetWindowTextW(hwnd, title, (int)std::size(title))) return TRUE;
	std::wstring t(title);
	std::transform(t.begin(), t.end(), t.begin(), ::towlower);
	if (t.find(L"live caption") != std::wstring::npos) {
		*reinterpret_cast<HWND*>(lParam) = hwnd;
		return FALSE;
	}
	return TRUE;
}

static bool IsUiChrome(const wchar_t* name) {
	if (!name || !*name) return true;
	std::wstring s(name);
	std::transform(s.begin(), s.end(), s.begin(), ::towlower);
	if (s.find(L"live caption") != std::wstring::npos) return true;
	if (s == L"settings" || s == L"position" || s == L"preferences") return true;
	if (s.find(L"caption style") != std::wstring::npos) return true;
	if (s.find(L"edit") == 0 && s.length() <= 5) return true;
	return false;
}

static bool CollectTextFromElement(IUIAutomation* pAutomation, IUIAutomationElement* pElement, std::wstring& out, bool skipRootName) {
	IUIAutomationTextPattern* pTextPattern = nullptr;
	HRESULT hr = pElement->GetCurrentPatternAs(UIA_TextPatternId, __uuidof(IUIAutomationTextPattern), reinterpret_cast<void**>(&pTextPattern));
	if (SUCCEEDED(hr) && pTextPattern) {
		IUIAutomationTextRange* pRange = nullptr;
		if (SUCCEEDED(pTextPattern->get_DocumentRange(&pRange)) && pRange) {
			BSTR bstr = nullptr;
			if (SUCCEEDED(pRange->GetText(-1, &bstr)) && bstr) {
				std::wstring candidate(bstr);
				SysFreeString(bstr);
				if (!candidate.empty() && !IsUiChrome(candidate.c_str())) {
					out = candidate;
					pRange->Release();
					pTextPattern->Release();
					return true;
				}
			}
			pRange->Release();
		}
		pTextPattern->Release();
	}
	BSTR name = nullptr;
	if (!skipRootName && SUCCEEDED(pElement->get_CurrentName(&name)) && name && *name) {
		if (!IsUiChrome(name)) {
			out += name;
			out += L"\r\n";
		}
		SysFreeString(name);
	}
	IUIAutomationTreeWalker* pWalker = nullptr;
	if (FAILED(pAutomation->get_ControlViewWalker(&pWalker)) || !pWalker) return false;
	IUIAutomationElement* pChild = nullptr;
	if (SUCCEEDED(pWalker->GetFirstChildElement(pElement, &pChild)) && pChild) {
		IUIAutomationElement* pNext = pChild;
		do {
			if (CollectTextFromElement(pAutomation, pNext, out, false)) {
				pNext->Release();
				if (pWalker) pWalker->Release();
				return true;
			}
			IUIAutomationElement* pSibling = nullptr;
			pWalker->GetNextSiblingElement(pNext, &pSibling);
			pNext->Release();
			pNext = pSibling;
		} while (pNext);
	}
	if (pWalker) pWalker->Release();
	return false;
}

static bool IsScrolledToBottom(HWND hEdit) {
	if (!hEdit) return true;
	SCROLLINFO si = {};
	si.cbSize = sizeof(SCROLLINFO);
	si.fMask = SIF_POS | SIF_RANGE | SIF_PAGE;
	if (!GetScrollInfo(hEdit, SB_VERT, &si)) return true;
	int maxScroll = si.nMax - (int)si.nPage + 1;
	return (si.nPos >= maxScroll - 5);
}

static void ScrollEditToBottom(HWND hEdit) {
	if (!hEdit) return;
	if (g_userScrolledUp) return;
	int len = GetWindowTextLengthW(hEdit);
	if (len <= 0) return;
	SendMessageW(hEdit, EM_SETSEL, (WPARAM)len, (LPARAM)len);
	SendMessageW(hEdit, EM_SCROLLCARET, 0, 0);
	SendMessageW(hEdit, WM_VSCROLL, SB_BOTTOM, 0);
}

static void ApplyAnchorHighlight(HWND hEdit) {
	if (!hEdit) return;
	int len = GetWindowTextLengthW(hEdit);
	if (len <= 0) return;
	g_anchorCharIndex = (std::min)(g_anchorCharIndex, len);
	const AppSettings& settings = g_settings;
	POINT ptScroll = {};
	SendMessageW(hEdit, EM_GETSCROLLPOS, 0, (LPARAM)&ptScroll);
	SendMessageW(hEdit, WM_SETREDRAW, FALSE, 0);
	CHARRANGE cr = {};
	CHARFORMAT2W cf = {};
	cf.cbSize = sizeof(cf);
	cr.cpMin = 0;
	cr.cpMax = g_anchorCharIndex;
	SendMessageW(hEdit, EM_EXSETSEL, 0, (LPARAM)&cr);
	cf.dwMask = CFM_BACKCOLOR | CFM_COLOR;
	cf.crTextColor = settings.textColor;
	cf.crBackColor = settings.bgColor;
	SendMessageW(hEdit, EM_SETCHARFORMAT, SCF_SELECTION, (LPARAM)&cf);
	cr.cpMin = g_anchorCharIndex;
	cr.cpMax = len;
	SendMessageW(hEdit, EM_EXSETSEL, 0, (LPARAM)&cr);
	cf.dwMask = CFM_BACKCOLOR | CFM_COLOR;
	cf.crTextColor = settings.textColor;
	cf.crBackColor = settings.selectedBgColor;
	SendMessageW(hEdit, EM_SETCHARFORMAT, SCF_SELECTION, (LPARAM)&cf);
	cr.cpMin = g_anchorCharIndex;
	cr.cpMax = g_anchorCharIndex;
	SendMessageW(hEdit, EM_EXSETSEL, 0, (LPARAM)&cr);
	SendMessageW(hEdit, EM_SETSCROLLPOS, 0, (LPARAM)&ptScroll);
	SendMessageW(hEdit, WM_SETREDRAW, TRUE, 0);
	InvalidateRect(hEdit, nullptr, TRUE);
}

static bool PasteViaClipboard(const std::wstring& text) {
	if (text.empty()) return false;
	if (!OpenClipboard(g_hMainWnd)) return false;
	HANDLE hOldData = GetClipboardData(CF_UNICODETEXT);
	std::wstring oldClipboard;
	if (hOldData) {
		wchar_t* pOldText = (wchar_t*)GlobalLock(hOldData);
		if (pOldText) {
			oldClipboard = pOldText;
			GlobalUnlock(hOldData);
		}
	}
	EmptyClipboard();
	size_t size = (text.length() + 1) * sizeof(wchar_t);
	HGLOBAL hMem = GlobalAlloc(GMEM_MOVEABLE, size);
	if (!hMem) {
		CloseClipboard();
		return false;
	}
	wchar_t* pMem = (wchar_t*)GlobalLock(hMem);
	if (pMem) {
		wcscpy_s(pMem, text.length() + 1, text.c_str());
		GlobalUnlock(hMem);
	}
	SetClipboardData(CF_UNICODETEXT, hMem);
	CloseClipboard();

	// If Alt is held (e.g. from an Alt+key hotkey), we must release it
	// before sending Ctrl+V.  Simply injecting Alt-up would look like a
	// "lone Alt tap" to the foreground app, which activates the menu bar
	// and swallows the subsequent Ctrl+V.
	//
	// Workaround: inject a Ctrl tap (down+up) WHILE Alt is still held.
	// This makes the app think "Alt was used as a modifier with Ctrl",
	// so releasing Alt afterwards won't activate the menu bar.
	// Then we release Alt and send the real Ctrl+V — all in one atomic
	// SendInput call so nothing can slip in between.
	if (g_altPhysicallyDown || (GetAsyncKeyState(VK_MENU) & 0x8000)) {
		INPUT inputs[8] = {};
		int n = 0;
		// 1) Ctrl down while Alt is held — breaks the "lone Alt" detection
		inputs[n].type = INPUT_KEYBOARD;
		inputs[n].ki.wVk = VK_CONTROL;
		n++;
		// 2) Ctrl up
		inputs[n].type = INPUT_KEYBOARD;
		inputs[n].ki.wVk = VK_CONTROL;
		inputs[n].ki.dwFlags = KEYEVENTF_KEYUP;
		n++;
		// 3) Alt up — no menu activation because Ctrl was pressed with Alt
		inputs[n].type = INPUT_KEYBOARD;
		inputs[n].ki.wVk = VK_MENU;
		inputs[n].ki.dwFlags = KEYEVENTF_KEYUP;
		n++;
		// 4-7) Clean Ctrl+V paste
		inputs[n].type = INPUT_KEYBOARD;
		inputs[n].ki.wVk = VK_CONTROL;
		n++;
		inputs[n].type = INPUT_KEYBOARD;
		inputs[n].ki.wVk = 'V';
		n++;
		inputs[n].type = INPUT_KEYBOARD;
		inputs[n].ki.wVk = 'V';
		inputs[n].ki.dwFlags = KEYEVENTF_KEYUP;
		n++;
		inputs[n].type = INPUT_KEYBOARD;
		inputs[n].ki.wVk = VK_CONTROL;
		inputs[n].ki.dwFlags = KEYEVENTF_KEYUP;
		n++;
		SendInput(n, inputs, sizeof(INPUT));
		g_altSuppressed = true;  // suppress the real physical Alt-keyup later
	}
	else {
		Sleep(10);
		// If user is holding Shift (e.g. autocopy=Ctrl+Shift+A), another tool's
		// global low-level hook (e.g. HotkeyP listening for Ctrl+Shift+V) sees
		// our injected V as Ctrl+Shift+V and steals it. Release Shift first so
		// the V arrives with only Ctrl held, looking like a plain paste.
		bool shiftDown = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
		INPUT inputs[5] = {};
		int n = 0;
		if (shiftDown) {
			inputs[n].type = INPUT_KEYBOARD;
			inputs[n].ki.wVk = VK_SHIFT;
			inputs[n].ki.dwFlags = KEYEVENTF_KEYUP;
			n++;
		}
		inputs[n].type = INPUT_KEYBOARD;
		inputs[n].ki.wVk = VK_CONTROL;
		n++;
		inputs[n].type = INPUT_KEYBOARD;
		inputs[n].ki.wVk = 'V';
		n++;
		inputs[n].type = INPUT_KEYBOARD;
		inputs[n].ki.wVk = 'V';
		inputs[n].ki.dwFlags = KEYEVENTF_KEYUP;
		n++;
		inputs[n].type = INPUT_KEYBOARD;
		inputs[n].ki.wVk = VK_CONTROL;
		inputs[n].ki.dwFlags = KEYEVENTF_KEYUP;
		n++;
		SendInput(n, inputs, sizeof(INPUT));
	}
	Sleep(50);
	if (!oldClipboard.empty()) {
		if (OpenClipboard(g_hMainWnd)) {
			EmptyClipboard();
			size_t oldSize = (oldClipboard.length() + 1) * sizeof(wchar_t);
			HGLOBAL hOldMem = GlobalAlloc(GMEM_MOVEABLE, oldSize);
			if (hOldMem) {
				wchar_t* pOldMem = (wchar_t*)GlobalLock(hOldMem);
				if (pOldMem) {
					wcscpy_s(pOldMem, oldClipboard.length() + 1, oldClipboard.c_str());
					GlobalUnlock(hOldMem);
					SetClipboardData(CF_UNICODETEXT, hOldMem);
				}
			}
			CloseClipboard();
		}
	}
	return true;
}

static void AddTrayIcon(HWND hWnd) {
	if (g_trayIconAdded) return;
	NOTIFYICONDATAW nid = {};
	nid.cbSize = sizeof(nid);
	nid.hWnd = hWnd;
	nid.uID = TRAY_ICON_UID;
	nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
	nid.uCallbackMessage = WM_APP_TRAY;
	nid.hIcon = LoadIconW(hInst, MAKEINTRESOURCEW(IDI_SMALL));
	wcscpy_s(nid.szTip, L"LiveCaption");
	if (Shell_NotifyIconW(NIM_ADD, &nid)) g_trayIconAdded = true;
}

static void RemoveTrayIcon(HWND hWnd) {
	if (!g_trayIconAdded) return;
	NOTIFYICONDATAW nid = {};
	nid.cbSize = sizeof(nid);
	nid.hWnd = hWnd;
	nid.uID = TRAY_ICON_UID;
	Shell_NotifyIconW(NIM_DELETE, &nid);
	g_trayIconAdded = false;
}

static void ShowTrayMenu(HWND hWnd) {
	POINT pt;
	GetCursorPos(&pt);
	HMENU hMenu = CreatePopupMenu();
	if (!hMenu) return;
	AppendMenuW(hMenu, MF_STRING, IDM_TRAY_SHOW,     L"Show");
	AppendMenuW(hMenu, MF_STRING, IDM_TRAY_SETTINGS, L"Settings");
	AppendMenuW(hMenu, MF_SEPARATOR, 0, nullptr);
	AppendMenuW(hMenu, MF_STRING, IDM_TRAY_EXIT,     L"Exit");
	// SetForegroundWindow is required so the popup auto-dismisses on click-away.
	SetForegroundWindow(hWnd);
	TrackPopupMenu(hMenu, TPM_BOTTOMALIGN | TPM_RIGHTALIGN, pt.x, pt.y, 0, hWnd, nullptr);
	DestroyMenu(hMenu);
}

static void DoFindAndCopyWork(bool replaceAll) {
	if (InterlockedCompareExchange(&g_pasteInProgress, 1, 0) != 0) return;
	try {
		if (g_captionHistory.empty()) {
			InterlockedExchange(&g_pasteInProgress, 0);
			return;
		}

		// When replaceAll (e.g. middle-button): select all in the focused control so paste replaces content
		if (replaceAll) {
			INPUT inputs[4] = {};
			inputs[0].type = INPUT_KEYBOARD;
			inputs[0].ki.wVk = VK_CONTROL;
			inputs[1].type = INPUT_KEYBOARD;
			inputs[1].ki.wVk = 'A';
			inputs[2].type = INPUT_KEYBOARD;
			inputs[2].ki.wVk = 'A';
			inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
			inputs[3].type = INPUT_KEYBOARD;
			inputs[3].ki.wVk = VK_CONTROL;
			inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;
			SendInput(4, inputs, sizeof(INPUT));
			Sleep(30);
		}

		// Ensure anchor index is valid - if it's at or beyond the end, copy from the beginning
		int startIndex = g_anchorHistoryIndex;
		if (startIndex < 0) startIndex = 0;
		if (startIndex >= (int)g_captionHistory.length()) startIndex = 0;

		// Copy from startIndex to end
		std::wstring textToCopy = g_captionHistory.substr(startIndex);
		if (!textToCopy.empty()) {
			PasteViaClipboard(textToCopy);
			// Optional: synthesize Enter so the captioned text is auto-submitted
			// (e.g., chat input fields). PasteViaClipboard already released Shift,
			// so the Enter arrives clean; Ctrl is also up by now.
			if (g_pressEnterAfterPaste) {
				Sleep(20);
				INPUT enter[2] = {};
				enter[0].type = INPUT_KEYBOARD;
				enter[0].ki.wVk = VK_RETURN;
				enter[1].type = INPUT_KEYBOARD;
				enter[1].ki.wVk = VK_RETURN;
				enter[1].ki.dwFlags = KEYEVENTF_KEYUP;
				SendInput(2, enter, sizeof(INPUT));
			}
		}
	}
	catch (...) {
	}
	InterlockedExchange(&g_pasteInProgress, 0);
}

static int FindWordStart(const std::wstring& text, int pos) {
	if (text.empty() || pos <= 0) return 0;
	if (pos >= (int)text.length()) pos = (int)text.length() - 1;
	while (pos > 0) {
		wchar_t ch = text[pos - 1];
		if (ch == L' ' || ch == L'\t' || ch == L'\r' || ch == L'\n' || ch == L'.' || ch == L',' || ch == L'!' || ch == L'?') {
			break;
		}
		pos--;
	}
	return pos;
}

static void AutoStartLiveCaption() {
	INPUT inputs[6] = {};
	inputs[0].type = INPUT_KEYBOARD;
	inputs[0].ki.wVk = VK_LWIN;
	inputs[1].type = INPUT_KEYBOARD;
	inputs[1].ki.wVk = VK_CONTROL;
	inputs[2].type = INPUT_KEYBOARD;
	inputs[2].ki.wVk = 'L';
	inputs[3].type = INPUT_KEYBOARD;
	inputs[3].ki.wVk = 'L';
	inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;
	inputs[4].type = INPUT_KEYBOARD;
	inputs[4].ki.wVk = VK_CONTROL;
	inputs[4].ki.dwFlags = KEYEVENTF_KEYUP;
	inputs[5].type = INPUT_KEYBOARD;
	inputs[5].ki.wVk = VK_LWIN;
	inputs[5].ki.dwFlags = KEYEVENTF_KEYUP;
	SendInput(6, inputs, sizeof(INPUT));
}

static void DoClearHistory() {
	std::wstring currentLiveCaption = GetLiveCaptionText();
	g_captionHistory.clear();
	g_previousCaption = currentLiveCaption;
	g_lastCaptionText = currentLiveCaption;
	g_anchorCharIndex = 0;
	g_anchorHistoryIndex = 0;
	g_anchorSetByUser = false;
	HWND hEdit = GetDlgItem(g_hMainWnd, IDC_CAPTION_EDIT);
	if (hEdit) {
		SendMessageW(hEdit, WM_SETREDRAW, FALSE, 0);
		SetWindowTextW(hEdit, L"");
		SendMessageW(hEdit, WM_SETREDRAW, TRUE, 0);
		InvalidateRect(hEdit, nullptr, TRUE);
	}
}

static void UpdateCaptionHistory(const std::wstring& currentText) {
	if (g_previousCaption.empty()) {
		g_captionHistory = currentText;
		g_previousCaption = currentText;
		return;
	}
	size_t prevLen = g_previousCaption.length();
	size_t currLen = currentText.length();
	if (currLen < prevLen) {
		g_previousCaption = currentText;
		return;
	}
	if (currLen <= prevLen + 1) {
		g_previousCaption = currentText;
		return;
	}
	const size_t patternLen = 20;
	bool foundPattern = false;
	std::wstring newPart;
	if (prevLen < patternLen) {
		g_captionHistory = currentText;
		g_previousCaption = currentText;
		return;
	}
	size_t maxShift = (std::min)(prevLen - patternLen, (size_t)200);
	std::wstring currentLower = currentText;
	std::transform(currentLower.begin(), currentLower.end(), currentLower.begin(), ::towlower);
	std::wstring pattern;

	for (size_t shift = 0; shift <= maxShift; shift++) {
		size_t endPos = prevLen - shift;
		size_t startPos = endPos - patternLen;
		pattern = g_previousCaption.substr(startPos, patternLen);
		std::wstring patternLower = pattern;
		std::transform(patternLower.begin(), patternLower.end(), patternLower.begin(), ::towlower);
		size_t pos = currentLower.rfind(patternLower);
		if (pos != std::wstring::npos) {
			newPart = currentText.substr(pos);
			foundPattern = true;
			break;
		}
	}
	if (foundPattern) {
		size_t hpos = g_captionHistory.rfind(pattern);
		if (hpos != std::wstring::npos) {
			std::wstring historyBeforePattern = g_captionHistory.substr(0, hpos);
			g_captionHistory = historyBeforePattern + newPart;
		}
		else {
			g_captionHistory += newPart;
		}
	}
	else {
		g_captionHistory += L" " + currentText;
	}
	g_previousCaption = currentText;
}

static LRESULT CALLBACK LowLevelKbHook(int nCode, WPARAM wParam, LPARAM lParam) {
	if (nCode == HC_ACTION && g_hMainWnd) {
		auto* p = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);

		// Track Alt physical state
		if (IsAltVk(p->vkCode)) {
			if (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN) {
				g_altPhysicallyDown = true;
			}
			else if (wParam == WM_KEYUP || wParam == WM_SYSKEYUP) {
				g_altPhysicallyDown = false;
				// If we injected an Alt-up in PasteViaClipboard, suppress the real
				// physical Alt-up so Windows doesn't activate the menu bar.
				if (g_altSuppressed) {
					g_altSuppressed = false;
					return 1;
				}
			}
		}

		// --- Hotkey matching on keydown / syskeydown ---
		if (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN) {
			// Skip the Alt key itself — we never consume Alt keydown so that
			// system shortcuts (Alt+Tab, Alt+F4, …) keep working.
			if (IsAltVk(p->vkCode))
				return CallNextHookEx(g_hKbHook, nCode, wParam, lParam);

			bool ctrlDown = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
			bool shiftDown = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
			bool winDown = ((GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) & 0x8000) != 0;

			// Alt detection: LLKHF_ALTDOWN is reliable here because we let
			// Alt through to the system.  Also check our physical tracking as fallback.
			bool altDown = (p->flags & LLKHF_ALTDOWN) != 0
				|| g_altPhysicallyDown
				|| ((GetAsyncKeyState(VK_MENU) & 0x8000) != 0);

			auto matches = [&](const HotkeyConfig& hk) {
				return hk.vkCode == p->vkCode
					&& hk.ctrl == ctrlDown && hk.shift == shiftDown
					&& hk.alt == altDown && hk.win == winDown;
				};
			if (matches(g_autoCopyHotkey)) {
				PostMessageW(g_hMainWnd, WM_APP_FIND_AND_COPY, 0, 0);
				return 1;
			}
			if (matches(g_autoDeleteHotkey)) {
				PostMessageW(g_hMainWnd, WM_APP_CLEAR_HISTORY, 0, 0);
				return 1;
			}
		}
	}
	return CallNextHookEx(g_hKbHook, nCode, wParam, lParam);
}

static LRESULT CALLBACK LowLevelMouseHook(int nCode, WPARAM wParam, LPARAM lParam) {
	if (nCode == HC_ACTION && g_hMainWnd && g_middleButtonPaste && wParam == WM_MBUTTONDOWN) {
		// wParam=1: replace all then paste; wParam=0: paste only (no replace)
		PostMessageW(g_hMainWnd, WM_APP_FIND_AND_COPY, g_middleButtonReplaceAll ? 1 : 0, 0);
		return 1;
	}
	return CallNextHookEx(g_hMouseHook, nCode, wParam, lParam);
}

static WNDPROC g_origEditProc = nullptr;
static bool g_suppressNextAnchorClick = false; // true when the next LButtonDown is an app-activation click

LRESULT CALLBACK EditSubclassProc(HWND hWnd, UINT uMsg, WPARAM wParam, LPARAM lParam) {
	if (uMsg == WM_MOUSEWHEEL || uMsg == WM_VSCROLL ||
		(uMsg == WM_KEYDOWN && (wParam == VK_UP || wParam == VK_DOWN || wParam == VK_PRIOR || wParam == VK_NEXT))) {
		LRESULT r = CallWindowProcW(g_origEditProc, hWnd, uMsg, wParam, lParam);
		bool atBottom = IsScrolledToBottom(hWnd);
		if (atBottom && g_userScrolledUp) {
			g_userScrolledUp = false;
		}
		else if (!atBottom && !g_userScrolledUp) {
			g_userScrolledUp = true;
		}
		return r;
	}
	if (uMsg == WM_MOUSEACTIVATE) {
		// Only suppress the upcoming WM_LBUTTONDOWN if this click is bringing the
		// application back from another app (main window is not the foreground window).
		// If the main window is already active, this is a normal intra-app click and
		// should update the anchor as usual.
		if (GetForegroundWindow() != g_hMainWnd) {
			g_suppressNextAnchorClick = true;
		}
		return CallWindowProcW(g_origEditProc, hWnd, uMsg, wParam, lParam);
	}
	if (uMsg == WM_LBUTTONDOWN) {
		g_suppressNextAnchorClick = false; // clear the flag regardless
		// Read click position from the message coordinates BEFORE calling the default
		// proc, because an activation click may have already moved the caret via
		// WM_SETFOCUS before WM_LBUTTONDOWN arrives, making EM_EXGETSEL unreliable.
		POINTL pt = { GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam) };
		int clickPos = (int)SendMessageW(hWnd, EM_CHARFROMPOS, 0, (LPARAM)&pt);
		if (clickPos < 0) clickPos = 0;
		LRESULT r = CallWindowProcW(g_origEditProc, hWnd, uMsg, wParam, lParam);
		int wordStart = FindWordStart(g_captionHistory, clickPos);
		g_anchorCharIndex = wordStart;
		g_anchorSetByUser = true;
		g_anchorHistoryIndex = wordStart;
		ApplyAnchorHighlight(hWnd);
		return r;
	}
	if (uMsg == WM_KEYDOWN) {
		bool ctrl = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
		bool shift = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
		// Use the same Alt detection logic as the low-level hook
		// GetKeyState may not work when Alt is suppressed, so check physical tracking too
		bool alt = (GetKeyState(VK_MENU) & 0x8000) != 0 || g_altPhysicallyDown || g_altSuppressed;
		bool win = ((GetKeyState(VK_LWIN) | GetKeyState(VK_RWIN)) & 0x8000) != 0;
		auto matches = [&](const HotkeyConfig& hk) {
			return hk.vkCode == (UINT)wParam
				&& hk.ctrl == ctrl && hk.shift == shift
				&& hk.alt == alt && hk.win == win;
			};
		if (matches(g_autoCopyHotkey)) {
			PostMessageW(GetParent(hWnd), WM_APP_FIND_AND_COPY, 0, 0);
			return 0;
		}
		if (matches(g_autoDeleteHotkey)) {
			PostMessageW(GetParent(hWnd), WM_APP_CLEAR_HISTORY, 0, 0);
			return 0;
		}
	}
	return CallWindowProcW(g_origEditProc, hWnd, uMsg, wParam, lParam);
}

std::wstring GetLiveCaptionText() {
	if (!g_pAutomation) {
		HRESULT hr = CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER,
			__uuidof(IUIAutomation), reinterpret_cast<void**>(&g_pAutomation));
		if (FAILED(hr) || !g_pAutomation) { g_pAutomation = nullptr; return L""; }
	}
	if (!g_hwndCaption || !IsWindow(g_hwndCaption)) {
		g_hwndCaption = nullptr;
		EnumWindows(FindLiveCaptionWindow, reinterpret_cast<LPARAM>(&g_hwndCaption));
		if (!g_hwndCaption) return L"";
	}
	IUIAutomationElement* pRoot = nullptr;
	HRESULT hr = g_pAutomation->ElementFromHandle(g_hwndCaption, &pRoot);
	if (FAILED(hr) || !pRoot) {
		g_hwndCaption = nullptr; // window may have died between IsWindow and now
		return L"";
	}
	std::wstring text;
	CollectTextFromElement(g_pAutomation, pRoot, text, true);
	pRoot->Release();
	while (!text.empty() && (text.back() == L'\r' || text.back() == L'\n')) text.pop_back();
	return text;
}

int APIENTRY wWinMain(_In_ HINSTANCE hInstance, _In_opt_ HINSTANCE hPrevInstance, _In_ LPWSTR lpCmdLine, _In_ int nCmdShow) {
	UNREFERENCED_PARAMETER(hPrevInstance);
	UNREFERENCED_PARAMETER(lpCmdLine);
	CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
	INITCOMMONCONTROLSEX iccex = { sizeof(iccex), ICC_BAR_CLASSES | ICC_STANDARD_CLASSES };
	InitCommonControlsEx(&iccex);
	LoadStringW(hInstance, IDS_APP_TITLE, szTitle, MAX_LOADSTRING);
	LoadStringW(hInstance, IDC_LIVECAPTION, szWindowClass, MAX_LOADSTRING);
	MyRegisterClass(hInstance);
	if (!InitInstance(hInstance, nCmdShow)) {
		return FALSE;
	}
	// Defer AutoStartLiveCaption (Win+Ctrl+L injection) via a polling timer:
	// the user is likely still holding the hotkey modifiers that just launched
	// LCCopier, and injecting on top of held keys garbles the keystroke so
	// Windows' Live Captions doesn't toggle.  WM_TIMER waits until modifiers
	// are released (or 2 seconds have passed) before injecting.
	SetTimer(g_hMainWnd, IDT_AUTO_START_LC, 100, nullptr);
	HACCEL hAccelTable = LoadAccelerators(hInstance, MAKEINTRESOURCE(IDC_LIVECAPTION));
	MSG msg;
	while (GetMessage(&msg, nullptr, 0, 0)) {
		if (!TranslateAccelerator(msg.hwnd, hAccelTable, &msg)) {
			TranslateMessage(&msg);
			DispatchMessage(&msg);
		}
	}
	CoUninitialize();
	return (int)msg.wParam;
}

ATOM MyRegisterClass(HINSTANCE hInstance) {
	WNDCLASSEXW wcex;
	wcex.cbSize = sizeof(WNDCLASSEX);
	wcex.style = CS_HREDRAW | CS_VREDRAW;
	wcex.lpfnWndProc = WndProc;
	wcex.cbClsExtra = 0;
	wcex.cbWndExtra = 0;
	wcex.hInstance = hInstance;
	wcex.hIcon = LoadIcon(hInstance, MAKEINTRESOURCE(IDI_LIVECAPTION));
	wcex.hCursor = LoadCursor(nullptr, IDC_ARROW);
	wcex.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
	wcex.lpszMenuName = nullptr;
	wcex.lpszClassName = szWindowClass;
	wcex.hIconSm = LoadIcon(wcex.hInstance, MAKEINTRESOURCE(IDI_SMALL));
	return RegisterClassExW(&wcex);
}

BOOL InitInstance(HINSTANCE hInstance, int nCmdShow) {
	hInst = hInstance;
	DWORD dwStyle = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX;
	HWND hWnd = CreateWindowW(szWindowClass, szTitle, dwStyle, CW_USEDEFAULT, 0, 640, 320, nullptr, nullptr, hInstance, nullptr);
	if (!hWnd) {
		return FALSE;
	}
	ShowWindow(hWnd, nCmdShow);
	UpdateWindow(hWnd);
	return TRUE;
}

LRESULT CALLBACK WndProc(HWND hWnd, UINT message, WPARAM wParam, LPARAM lParam)
{
	switch (message)
	{
	case WM_CREATE:
	{
		AppSettings settings = SettingsDialog::LoadSettings();
		g_settings = settings; // seed before any paint handler can fire
		HDC hdc = GetDC(hWnd);
		int logPixels = hdc ? GetDeviceCaps(hdc, LOGPIXELSY) : 96;
		if (hdc) ReleaseDC(hWnd, hdc);
		g_hCaptionFont = CreateFontW(
			-MulDiv(settings.textSize, logPixels, 72),
			0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
			DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
			DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
		g_hEditBrush = CreateSolidBrush(settings.bgColor);

		LoadLibraryW(L"Msftedit.dll");
		HWND hEdit = CreateWindowExW(WS_EX_CLIENTEDGE, L"RICHEDIT50W", nullptr,
			WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL,
			0, 0, 0, 0, hWnd, (HMENU)(INT_PTR)IDC_CAPTION_EDIT, hInst, nullptr);
		if (hEdit) {
			SendMessageW(hEdit, EM_SETBKGNDCOLOR, 0, (LPARAM)settings.bgColor);
			SendMessageW(hEdit, WM_SETFONT, (WPARAM)g_hCaptionFont, TRUE);
			SendMessageW(hEdit, EM_HIDESELECTION, TRUE, FALSE);
			g_origEditProc = (WNDPROC)SetWindowLongPtrW(hEdit, GWLP_WNDPROC, (LONG_PTR)EditSubclassProc);
			SetTimer(hWnd, IDT_POLL_CAPTION, POLL_INTERVAL_MS, nullptr);
		}
		g_hMainWnd = hWnd;
		g_hKbHook = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKbHook, nullptr, 0);
		g_hMouseHook = SetWindowsHookExW(WH_MOUSE_LL, LowLevelMouseHook, nullptr, 0);
		HMENU hSysMenu = GetSystemMenu(hWnd, FALSE);
		if (hSysMenu) {
			DeleteMenu(hSysMenu, SC_MAXIMIZE, MF_BYCOMMAND);
			InsertMenuW(hSysMenu, SC_CLOSE, MF_BYCOMMAND | MF_STRING, IDM_SETTINGS, L"Settings");
		}
		if (settings.setTop) {
			SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
		}
		if (settings.setInvisible) {
			SetWindowDisplayAffinity(hWnd, WDA_EXCLUDEFROMCAPTURE);
			SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE); // invisible forces topmost
			PostMessageW(hWnd, WM_APP_HIDE_TASKBAR, 1, 0); // deferred: hide taskbar button after window is shown
			LONG_PTR style = GetWindowLongPtrW(hWnd, GWL_STYLE);
			SetWindowLongPtrW(hWnd, GWL_STYLE, style & ~WS_MINIMIZEBOX);
			AddTrayIcon(hWnd);
		}
		{
			LONG_PTR exStyle = GetWindowLongPtrW(hWnd, GWL_EXSTYLE);
			BYTE alpha = (BYTE)((settings.transparency * 255) / 100);
			SetLayeredWindowAttributes(hWnd, 0, alpha, LWA_ALPHA);
		}
		g_autoCopyHotkey = settings.autoCopyHotkey;
		g_autoDeleteHotkey = settings.autoDeleteHotkey;
		g_middleButtonPaste = settings.middleButtonPaste;
		g_middleButtonReplaceAll = settings.middleButtonReplaceAll;
		g_pressEnterAfterPaste = settings.pressEnterAfterPaste;
		// Initialize ITaskbarList for taskbar button control
		CoCreateInstance(CLSID_TaskbarList, nullptr, CLSCTX_INPROC_SERVER,
			IID_ITaskbarList, reinterpret_cast<void**>(&g_pTaskbarList));
		if (g_pTaskbarList) g_pTaskbarList->HrInit();
	}
	break;
	case WM_APP_FIND_AND_COPY:
		DoFindAndCopyWork(wParam != 0);
		return 0;
	case WM_APP_CLEAR_HISTORY:
		DoClearHistory();
		return 0;
	case WM_APP_HIDE_TASKBAR:
		if (g_pTaskbarList) {
			if (wParam) g_pTaskbarList->DeleteTab(hWnd);
			else        g_pTaskbarList->AddTab(hWnd);
		}
		return 0;
	case WM_APP_SETTINGS_CHANGED:
	{
		AppSettings settings = SettingsDialog::LoadSettings();
		g_settings = settings;
		if (g_hEditBrush) {
			DeleteObject(g_hEditBrush);
		}
		g_hEditBrush = CreateSolidBrush(settings.bgColor);
		if (g_hCaptionFont) {
			DeleteObject(g_hCaptionFont);
		}
		HDC hdc = GetDC(hWnd);
		int logPixels = hdc ? GetDeviceCaps(hdc, LOGPIXELSY) : 96;
		if (hdc) ReleaseDC(hWnd, hdc);
		g_hCaptionFont = CreateFontW(
			-MulDiv(settings.textSize, logPixels, 72),
			0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
			DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
			DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
		HWND hEdit = GetDlgItem(hWnd, IDC_CAPTION_EDIT);
		if (hEdit) {
			SendMessageW(hEdit, EM_SETBKGNDCOLOR, 0, (LPARAM)settings.bgColor);
			SendMessageW(hEdit, WM_SETFONT, (WPARAM)g_hCaptionFont, TRUE);
			ApplyAnchorHighlight(hEdit);
			InvalidateRect(hEdit, nullptr, TRUE);
		}
		if (settings.setTop) {
			SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
		}
		else {
			SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
		}
		if (settings.setInvisible) {
			SetWindowDisplayAffinity(hWnd, WDA_EXCLUDEFROMCAPTURE);
			SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE); // invisible forces topmost
			if (g_pTaskbarList) g_pTaskbarList->DeleteTab(hWnd); // hide from taskbar without style change
			LONG_PTR style = GetWindowLongPtrW(hWnd, GWL_STYLE);
			SetWindowLongPtrW(hWnd, GWL_STYLE, style & ~WS_MINIMIZEBOX);
			SetWindowPos(hWnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
			AddTrayIcon(hWnd);
		}
		else {
			SetWindowDisplayAffinity(hWnd, WDA_NONE);
			if (g_pTaskbarList) g_pTaskbarList->AddTab(hWnd);    // restore taskbar button
			LONG_PTR style = GetWindowLongPtrW(hWnd, GWL_STYLE);
			SetWindowLongPtrW(hWnd, GWL_STYLE, style | WS_MINIMIZEBOX);
			SetWindowPos(hWnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
			RemoveTrayIcon(hWnd);
		}
		{
			LONG_PTR exStyle = GetWindowLongPtrW(hWnd, GWL_EXSTYLE);
			if (!(exStyle & WS_EX_LAYERED)) {
				SetWindowLongPtrW(hWnd, GWL_EXSTYLE, exStyle | WS_EX_LAYERED);
			}
			BYTE alpha = (BYTE)((settings.transparency * 255) / 100);
			SetLayeredWindowAttributes(hWnd, 0, alpha, LWA_ALPHA);
		}
		g_autoCopyHotkey = settings.autoCopyHotkey;
		g_autoDeleteHotkey = settings.autoDeleteHotkey;
		g_middleButtonPaste = settings.middleButtonPaste;
		g_middleButtonReplaceAll = settings.middleButtonReplaceAll;
		g_pressEnterAfterPaste = settings.pressEnterAfterPaste;
		return 0;
	}
	case WM_SIZE:
	{
		HWND hEdit = GetDlgItem(hWnd, IDC_CAPTION_EDIT);
		if (hEdit) SetWindowPos(hEdit, nullptr, 0, 0, LOWORD(lParam), HIWORD(lParam), SWP_NOZORDER);
	}
	break;
	case WM_CTLCOLOREDIT:
	{
		const AppSettings& settings = g_settings;
		SetTextColor((HDC)wParam, settings.textColor);
		SetBkColor((HDC)wParam, settings.bgColor);
		return (LRESULT)g_hEditBrush;
	}
	case WM_TIMER:
		if (wParam == IDT_AUTO_START_LC) {
			// Poll until the user releases the hotkey modifiers, then inject
			// Win+Ctrl+L cleanly.  Hard-cap at 20 polls (2s) so we eventually
			// inject even if the user keeps a modifier held forever.
			static int autoStartAttempts = 0;
			bool modsHeld =
				(GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 ||
				(GetAsyncKeyState(VK_SHIFT)   & 0x8000) != 0 ||
				(GetAsyncKeyState(VK_MENU)    & 0x8000) != 0 ||
				((GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) & 0x8000) != 0;
			if (!modsHeld || ++autoStartAttempts > 20) {
				KillTimer(hWnd, IDT_AUTO_START_LC);
				autoStartAttempts = 0;
				AutoStartLiveCaption();
			}
			return 0;
		}
		if (wParam == IDT_POLL_CAPTION) {
			std::wstring text = GetLiveCaptionText();
			if (text != g_lastCaptionText) {
				if (!text.empty()) {
					UpdateCaptionHistory(text);
				}
				g_lastCaptionText = std::move(text);
				HWND hEdit = GetDlgItem(hWnd, IDC_CAPTION_EDIT);
				if (hEdit) {
					SendMessageW(hEdit, WM_SETREDRAW, FALSE, 0);
					POINT ptScroll = {};
					if (g_userScrolledUp) {
						SendMessageW(hEdit, EM_GETSCROLLPOS, 0, (LPARAM)&ptScroll);
					}
					SetWindowTextW(hEdit, g_captionHistory.c_str());
					if (!g_anchorSetByUser) {
						g_anchorCharIndex = 0;
						g_anchorHistoryIndex = 0;
					}
					ApplyAnchorHighlight(hEdit);
					if (g_userScrolledUp) {
						SendMessageW(hEdit, EM_SETSCROLLPOS, 0, (LPARAM)&ptScroll);
					}
					else {
						ScrollEditToBottom(hEdit);
					}
					SendMessageW(hEdit, WM_SETREDRAW, TRUE, 0);
					InvalidateRect(hEdit, nullptr, TRUE);
				}
			}
		}
		break;
	case WM_SYSCOMMAND:
		if (wParam == IDM_SETTINGS) {
			SettingsDialog::Show(hWnd);
			return 0;
		}
		return DefWindowProc(hWnd, message, wParam, lParam);
	case WM_COMMAND:
		switch (LOWORD(wParam)) {
		case IDM_TRAY_SHOW:
			ShowWindow(hWnd, SW_SHOW);
			SetForegroundWindow(hWnd);
			return 0;
		case IDM_TRAY_SETTINGS:
			SettingsDialog::Show(hWnd);
			return 0;
		case IDM_TRAY_EXIT:
			DestroyWindow(hWnd);
			return 0;
		}
		return DefWindowProc(hWnd, message, wParam, lParam);
	case WM_APP_TRAY:
		if (LOWORD(lParam) == WM_RBUTTONUP) {
			ShowTrayMenu(hWnd);
		}
		else if (LOWORD(lParam) == WM_LBUTTONDBLCLK) {
			ShowWindow(hWnd, SW_SHOW);
			SetForegroundWindow(hWnd);
		}
		return 0;
	case WM_PAINT:
	{
		PAINTSTRUCT ps;
		HDC hdc = BeginPaint(hWnd, &ps);
		EndPaint(hWnd, &ps);
	}
	break;
	case WM_DESTROY:
		RemoveTrayIcon(hWnd);
		if (g_hKbHook) { UnhookWindowsHookEx(g_hKbHook); g_hKbHook = nullptr; }
		if (g_hMouseHook) { UnhookWindowsHookEx(g_hMouseHook); g_hMouseHook = nullptr; }
		KillTimer(hWnd, IDT_POLL_CAPTION);
		if (g_hEditBrush) { DeleteObject(g_hEditBrush); g_hEditBrush = nullptr; }
		if (g_hCaptionFont) { DeleteObject(g_hCaptionFont); g_hCaptionFont = nullptr; }
		if (g_pTaskbarList) { g_pTaskbarList->Release(); g_pTaskbarList = nullptr; }
		if (g_pAutomation) { g_pAutomation->Release(); g_pAutomation = nullptr; }
		g_hwndCaption = nullptr;
		PostQuitMessage(0);
		break;
	default:
		return DefWindowProc(hWnd, message, wParam, lParam);
	}
	return 0;
}
