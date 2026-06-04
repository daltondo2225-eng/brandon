#include "SettingsDialog.h"
#include "Resource.h"
#include <CommCtrl.h>
#include <RichEdit.h>
#include <string>

#pragma comment(lib, "Comctl32.lib")

HWND SettingsDialog::s_hDlg = nullptr;
HWND SettingsDialog::s_hParent = nullptr;
AppSettings SettingsDialog::s_settings = {};
int SettingsDialog::s_originalTransparency = 100;

void SettingsDialog::Show(HWND hParent) {
    if (s_hDlg && IsWindow(s_hDlg)) {
        SetForegroundWindow(s_hDlg);
        return;
    }
    s_hParent = hParent;
    s_settings = LoadSettings();
    DialogBoxParamW(GetModuleHandle(nullptr), MAKEINTRESOURCEW(IDD_SETTINGS_DIALOG),
                    hParent, DialogProc, 0);
    s_hDlg = nullptr;
}

void SettingsDialog::Close() {
    if (s_hDlg && IsWindow(s_hDlg)) {
        EndDialog(s_hDlg, 0);
        s_hDlg = nullptr;
    }
}

AppSettings SettingsDialog::LoadSettings() {
    AppSettings settings = GetDefaultSettings();
    LoadFromRegistry(settings);
    return settings;
}

void SettingsDialog::SaveSettings(const AppSettings& settings) {
    SaveToRegistry(settings);
    s_settings = settings;
}

AppSettings SettingsDialog::GetDefaultSettings() {
    AppSettings settings = {};
    settings.darkMode = false;
    settings.setTop = true;
    settings.setInvisible = false;
    settings.middleButtonPaste = true;
    settings.middleButtonReplaceAll = true;
    settings.pressEnterAfterPaste = false;
    settings.transparency = 100;
    settings.autoCopyHotkey = { true, true, false, false, 'A' };
    settings.autoDeleteHotkey = { true, true, false, false, 'D' };
    settings.textSize = 12;
    settings.textColor = RGB(0, 0, 0);
    settings.bgColor = RGB(255, 255, 255);
    settings.selectedBgColor = RGB(168, 223, 142);
    return settings;
}

void SettingsDialog::LoadFromRegistry(AppSettings& settings) {
    HKEY hKey;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\LiveCaption", 0, KEY_READ, &hKey) == ERROR_SUCCESS) {
        DWORD dwValue, dwSize = sizeof(DWORD);
        if (RegQueryValueExW(hKey, L"DarkMode", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.darkMode = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"SetTop", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.setTop = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"SetInvisible", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.setInvisible = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"MiddleButtonPaste", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.middleButtonPaste = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"MiddleButtonReplaceAll", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.middleButtonReplaceAll = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"PressEnterAfterPaste", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.pressEnterAfterPaste = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"Transparency", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.transparency = (int)dwValue;
        if (RegQueryValueExW(hKey, L"AutoCopyCtrl", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.autoCopyHotkey.ctrl = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"AutoCopyShift", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.autoCopyHotkey.shift = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"AutoCopyAlt", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.autoCopyHotkey.alt = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"AutoCopyWin", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.autoCopyHotkey.win = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"AutoCopyKey", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.autoCopyHotkey.vkCode = (UINT)dwValue;
        if (RegQueryValueExW(hKey, L"AutoDeleteCtrl", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.autoDeleteHotkey.ctrl = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"AutoDeleteShift", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.autoDeleteHotkey.shift = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"AutoDeleteAlt", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.autoDeleteHotkey.alt = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"AutoDeleteWin", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.autoDeleteHotkey.win = (dwValue != 0);
        if (RegQueryValueExW(hKey, L"AutoDeleteKey", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.autoDeleteHotkey.vkCode = (UINT)dwValue;
        if (RegQueryValueExW(hKey, L"TextSize", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.textSize = (int)dwValue;
        if (RegQueryValueExW(hKey, L"TextColor", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.textColor = (COLORREF)dwValue;
        if (RegQueryValueExW(hKey, L"BgColor", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.bgColor = (COLORREF)dwValue;
        if (RegQueryValueExW(hKey, L"SelectedBgColor", nullptr, nullptr, (LPBYTE)&dwValue, &dwSize) == ERROR_SUCCESS)
            settings.selectedBgColor = (COLORREF)dwValue;
        RegCloseKey(hKey);
    }
}

void SettingsDialog::SaveToRegistry(const AppSettings& settings) {
    HKEY hKey;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\LiveCaption", 0, nullptr, 0, KEY_WRITE, nullptr, &hKey, nullptr) == ERROR_SUCCESS) {
        DWORD dwValue;
        dwValue = settings.darkMode ? 1 : 0;
        RegSetValueExW(hKey, L"DarkMode", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.setTop ? 1 : 0;
        RegSetValueExW(hKey, L"SetTop", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.setInvisible ? 1 : 0;
        RegSetValueExW(hKey, L"SetInvisible", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.middleButtonPaste ? 1 : 0;
        RegSetValueExW(hKey, L"MiddleButtonPaste", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.middleButtonReplaceAll ? 1 : 0;
        RegSetValueExW(hKey, L"MiddleButtonReplaceAll", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.pressEnterAfterPaste ? 1 : 0;
        RegSetValueExW(hKey, L"PressEnterAfterPaste", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.transparency;
        RegSetValueExW(hKey, L"Transparency", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.autoCopyHotkey.ctrl ? 1 : 0;
        RegSetValueExW(hKey, L"AutoCopyCtrl", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.autoCopyHotkey.shift ? 1 : 0;
        RegSetValueExW(hKey, L"AutoCopyShift", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.autoCopyHotkey.alt ? 1 : 0;
        RegSetValueExW(hKey, L"AutoCopyAlt", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.autoCopyHotkey.win ? 1 : 0;
        RegSetValueExW(hKey, L"AutoCopyWin", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.autoCopyHotkey.vkCode;
        RegSetValueExW(hKey, L"AutoCopyKey", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.autoDeleteHotkey.ctrl ? 1 : 0;
        RegSetValueExW(hKey, L"AutoDeleteCtrl", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.autoDeleteHotkey.shift ? 1 : 0;
        RegSetValueExW(hKey, L"AutoDeleteShift", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.autoDeleteHotkey.alt ? 1 : 0;
        RegSetValueExW(hKey, L"AutoDeleteAlt", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.autoDeleteHotkey.win ? 1 : 0;
        RegSetValueExW(hKey, L"AutoDeleteWin", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.autoDeleteHotkey.vkCode;
        RegSetValueExW(hKey, L"AutoDeleteKey", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.textSize;
        RegSetValueExW(hKey, L"TextSize", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.textColor;
        RegSetValueExW(hKey, L"TextColor", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.bgColor;
        RegSetValueExW(hKey, L"BgColor", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        dwValue = settings.selectedBgColor;
        RegSetValueExW(hKey, L"SelectedBgColor", 0, REG_DWORD, (LPBYTE)&dwValue, sizeof(DWORD));
        RegCloseKey(hKey);
    }
}

INT_PTR CALLBACK SettingsDialog::DialogProc(HWND hDlg, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_INITDIALOG:
        s_hDlg = hDlg;
        // Mirror the main window's display-affinity so the Settings panel is
        // also excluded from screen capture while invisible mode is active.
        if (s_settings.setInvisible) {
            SetWindowDisplayAffinity(hDlg, WDA_EXCLUDEFROMCAPTURE);
        }
        InitializeControls(hDlg);
        LoadSettingsToControls(hDlg);
        s_originalTransparency = s_settings.transparency; // remember for cancel restore
        return TRUE;
    case WM_COMMAND:
        if (LOWORD(wParam) == IDC_CLOSE_SETTINGS) {
            SaveControlsToSettings(hDlg);
            SaveSettings(s_settings);
            ApplySettings();
            Close();
            return TRUE;
        }
        if (LOWORD(wParam) == IDCANCEL) {
            PreviewMainWindowTransparency(s_originalTransparency); // revert live preview
            Close();
            return TRUE;
        }
        if (LOWORD(wParam) == IDC_RESTORE_DEFAULT) {
            RestoreDefaults(hDlg);
            return TRUE;
        }
        if (LOWORD(wParam) == IDC_DARKMODE) {
            s_settings.darkMode = !s_settings.darkMode;
            if (s_settings.darkMode) {
                s_settings.textColor = RGB(255, 255, 255);
                s_settings.bgColor = RGB(0, 0, 0);
                s_settings.selectedBgColor = RGB(0, 95, 2);
            } else {
                s_settings.textColor = RGB(0, 0, 0);
                s_settings.bgColor = RGB(255, 255, 255);
                s_settings.selectedBgColor = RGB(168, 223, 142);
            }
            InvalidateRect(GetDlgItem(hDlg, IDC_DARKMODE), nullptr, TRUE);
            InvalidateRect(GetDlgItem(hDlg, IDC_TEXT_COLOR_PICKER), nullptr, TRUE);
            InvalidateRect(GetDlgItem(hDlg, IDC_BG_COLOR_PICKER), nullptr, TRUE);
            InvalidateRect(GetDlgItem(hDlg, IDC_SELECTED_BG_COLOR_PICKER), nullptr, TRUE);
            InvalidateRect(GetDlgItem(hDlg, IDC_SETTOP), nullptr, TRUE);
            UpdatePreviewText(hDlg);
            return TRUE;
        }
        if (LOWORD(wParam) == IDC_SETTOP) {
            s_settings.setTop = !s_settings.setTop;
            InvalidateRect(GetDlgItem(hDlg, IDC_SETTOP), nullptr, TRUE);
            return TRUE;
        }
        if (LOWORD(wParam) == IDC_SETINVISIBLE) {
            s_settings.setInvisible = !s_settings.setInvisible;
            if (s_settings.setInvisible && !s_settings.setTop) {
                s_settings.setTop = true; // invisible mode requires topmost
                InvalidateRect(GetDlgItem(hDlg, IDC_SETTOP), nullptr, TRUE);
            }
            // Live-mirror the affinity on the dialog itself so the Settings
            // panel becomes invisible-to-capture in lockstep with the toggle.
            SetWindowDisplayAffinity(hDlg, s_settings.setInvisible ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE);
            InvalidateRect(GetDlgItem(hDlg, IDC_SETINVISIBLE), nullptr, TRUE);
            return TRUE;
        }
        if (LOWORD(wParam) == IDC_TEXT_COLOR_PICKER) {
            CHOOSECOLORW cc = {};
            static COLORREF customColors[16] = {};
            cc.lStructSize = sizeof(cc);
            cc.hwndOwner = hDlg;
            cc.lpCustColors = customColors;
            cc.rgbResult = s_settings.textColor;
            cc.Flags = CC_FULLOPEN | CC_RGBINIT;
            if (ChooseColorW(&cc)) {
                s_settings.textColor = cc.rgbResult;
                InvalidateRect(GetDlgItem(hDlg, IDC_TEXT_COLOR_PICKER), nullptr, TRUE);
                UpdatePreviewText(hDlg);
            }
            return TRUE;
        }
        if (LOWORD(wParam) == IDC_BG_COLOR_PICKER) {
            CHOOSECOLORW cc = {};
            static COLORREF customColors[16] = {};
            cc.lStructSize = sizeof(cc);
            cc.hwndOwner = hDlg;
            cc.lpCustColors = customColors;
            cc.rgbResult = s_settings.bgColor;
            cc.Flags = CC_FULLOPEN | CC_RGBINIT;
            if (ChooseColorW(&cc)) {
                s_settings.bgColor = cc.rgbResult;
                InvalidateRect(GetDlgItem(hDlg, IDC_BG_COLOR_PICKER), nullptr, TRUE);
                UpdatePreviewText(hDlg);
            }
            return TRUE;
        }
        if (LOWORD(wParam) == IDC_SELECTED_BG_COLOR_PICKER) {
            CHOOSECOLORW cc = {};
            static COLORREF customColors[16] = {};
            cc.lStructSize = sizeof(cc);
            cc.hwndOwner = hDlg;
            cc.lpCustColors = customColors;
            cc.rgbResult = s_settings.selectedBgColor;
            cc.Flags = CC_FULLOPEN | CC_RGBINIT;
            if (ChooseColorW(&cc)) {
                s_settings.selectedBgColor = cc.rgbResult;
                InvalidateRect(GetDlgItem(hDlg, IDC_SELECTED_BG_COLOR_PICKER), nullptr, TRUE);
                InvalidateRect(GetDlgItem(hDlg, IDC_SETTOP), nullptr, TRUE);
                UpdatePreviewText(hDlg);
            }
            return TRUE;
        }
        if (LOWORD(wParam) == IDC_MIDDLE_BUTTON_PASTE && HIWORD(wParam) == BN_CLICKED) {
            EnableWindow(GetDlgItem(hDlg, IDC_MIDDLE_BUTTON_REPLACE_ALL), IsDlgButtonChecked(hDlg, IDC_MIDDLE_BUTTON_PASTE) == BST_CHECKED);
            return TRUE;
        }
        break;
    case WM_DRAWITEM:
        {
            LPDRAWITEMSTRUCT lpDIS = (LPDRAWITEMSTRUCT)lParam;
            int controlId = (int)wParam;
            if (controlId == IDC_DARKMODE || controlId == IDC_SETTOP || controlId == IDC_SETINVISIBLE) {
                bool state = false;
                if (controlId == IDC_DARKMODE) state = s_settings.darkMode;
                else if (controlId == IDC_SETTOP) state = s_settings.setTop;
                else if (controlId == IDC_SETINVISIBLE) state = s_settings.setInvisible;
                ToggleButtonStyle style = GetToggleButtonStyle(controlId);
                DrawToggleButton(lpDIS, state, style);
                return TRUE;
            }
            if (controlId == IDC_TEXT_COLOR_PICKER || controlId == IDC_BG_COLOR_PICKER || controlId == IDC_SELECTED_BG_COLOR_PICKER) {
                COLORREF color = RGB(255, 255, 255);
                if (controlId == IDC_TEXT_COLOR_PICKER) color = s_settings.textColor;
                else if (controlId == IDC_BG_COLOR_PICKER) color = s_settings.bgColor;
                else if (controlId == IDC_SELECTED_BG_COLOR_PICKER) color = s_settings.selectedBgColor;
                HBRUSH hBrush = CreateSolidBrush(color);
                FillRect(lpDIS->hDC, &lpDIS->rcItem, hBrush);
                DeleteObject(hBrush);
                DrawEdge(lpDIS->hDC, &lpDIS->rcItem, EDGE_RAISED, BF_RECT);
                return TRUE;
            }
        }
        break;
    case WM_HSCROLL:
        if ((HWND)lParam == GetDlgItem(hDlg, IDC_TRANSPARENCY_SLIDER)) {
            int pos = (int)SendDlgItemMessageW(hDlg, IDC_TRANSPARENCY_SLIDER, TBM_GETPOS, 0, 0);
            SetDlgItemInt(hDlg, IDC_TRANSPARENCY_VALUE, pos, FALSE);
            PreviewMainWindowTransparency(pos);
        }
        if ((HWND)lParam == GetDlgItem(hDlg, IDC_TEXTSIZE_SLIDER)) {
            int pos = (int)SendDlgItemMessageW(hDlg, IDC_TEXTSIZE_SLIDER, TBM_GETPOS, 0, 0);
            SetDlgItemInt(hDlg, IDC_TEXTSIZE_VALUE, pos, FALSE);
            UpdatePreviewText(hDlg);
        }
        return TRUE;
    case WM_CLOSE:
        PreviewMainWindowTransparency(s_originalTransparency); // revert live preview
        Close();
        return TRUE;
    }
    return FALSE;
}

void SettingsDialog::InitializeControls(HWND hDlg) {
    SendDlgItemMessageW(hDlg, IDC_TRANSPARENCY_SLIDER, TBM_SETRANGE, TRUE, MAKELONG(0, 100));
    SendDlgItemMessageW(hDlg, IDC_TRANSPARENCY_SLIDER, TBM_SETPOS, TRUE, 100);
    SendDlgItemMessageW(hDlg, IDC_TEXTSIZE_SLIDER, TBM_SETRANGE, TRUE, MAKELONG(8, 28));
    SendDlgItemMessageW(hDlg, IDC_TEXTSIZE_SLIDER, TBM_SETPOS, TRUE, 12);
    // Win key combinations are intercepted by the OS and cannot be reliably used
    EnableWindow(GetDlgItem(hDlg, IDC_AUTOCOPY_WIN), FALSE);
    EnableWindow(GetDlgItem(hDlg, IDC_AUTODELETE_WIN), FALSE);
}

void SettingsDialog::LoadSettingsToControls(HWND hDlg) {
    InvalidateRect(GetDlgItem(hDlg, IDC_DARKMODE), nullptr, TRUE);
    InvalidateRect(GetDlgItem(hDlg, IDC_SETTOP), nullptr, TRUE);
    InvalidateRect(GetDlgItem(hDlg, IDC_SETINVISIBLE), nullptr, TRUE);
    SendDlgItemMessageW(hDlg, IDC_TRANSPARENCY_SLIDER, TBM_SETPOS, TRUE, s_settings.transparency);
    SetDlgItemInt(hDlg, IDC_TRANSPARENCY_VALUE, s_settings.transparency, FALSE);

    CheckDlgButton(hDlg, IDC_AUTOCOPY_CTRL, s_settings.autoCopyHotkey.ctrl ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(hDlg, IDC_AUTOCOPY_SHIFT, s_settings.autoCopyHotkey.shift ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(hDlg, IDC_AUTOCOPY_ALT, s_settings.autoCopyHotkey.alt ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(hDlg, IDC_AUTOCOPY_WIN, BST_UNCHECKED);
    wchar_t keyName[32];
    wsprintfW(keyName, L"%c", (wchar_t)s_settings.autoCopyHotkey.vkCode);
    SetDlgItemTextW(hDlg, IDC_AUTOCOPY_KEY, keyName);
    CheckDlgButton(hDlg, IDC_AUTODELETE_CTRL, s_settings.autoDeleteHotkey.ctrl ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(hDlg, IDC_AUTODELETE_SHIFT, s_settings.autoDeleteHotkey.shift ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(hDlg, IDC_AUTODELETE_ALT, s_settings.autoDeleteHotkey.alt ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(hDlg, IDC_AUTODELETE_WIN, BST_UNCHECKED);
    wsprintfW(keyName, L"%c", (wchar_t)s_settings.autoDeleteHotkey.vkCode);
    SetDlgItemTextW(hDlg, IDC_AUTODELETE_KEY, keyName);
    CheckDlgButton(hDlg, IDC_MIDDLE_BUTTON_PASTE, s_settings.middleButtonPaste ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(hDlg, IDC_MIDDLE_BUTTON_REPLACE_ALL, s_settings.middleButtonReplaceAll ? BST_CHECKED : BST_UNCHECKED);
    CheckDlgButton(hDlg, IDC_PRESS_ENTER, s_settings.pressEnterAfterPaste ? BST_CHECKED : BST_UNCHECKED);
    EnableWindow(GetDlgItem(hDlg, IDC_MIDDLE_BUTTON_REPLACE_ALL), IsDlgButtonChecked(hDlg, IDC_MIDDLE_BUTTON_PASTE) == BST_CHECKED);
    SendDlgItemMessageW(hDlg, IDC_TEXTSIZE_SLIDER, TBM_SETPOS, TRUE, s_settings.textSize);
    SetDlgItemInt(hDlg, IDC_TEXTSIZE_VALUE, s_settings.textSize, FALSE);
    InvalidateRect(GetDlgItem(hDlg, IDC_TEXT_COLOR_PICKER), nullptr, TRUE);
    InvalidateRect(GetDlgItem(hDlg, IDC_BG_COLOR_PICKER), nullptr, TRUE);
    InvalidateRect(GetDlgItem(hDlg, IDC_SELECTED_BG_COLOR_PICKER), nullptr, TRUE);
    UpdatePreviewText(hDlg);
}


void SettingsDialog::SaveControlsToSettings(HWND hDlg) {
    s_settings.transparency = (int)SendDlgItemMessageW(hDlg, IDC_TRANSPARENCY_SLIDER, TBM_GETPOS, 0, 0);
    s_settings.autoCopyHotkey.ctrl = (IsDlgButtonChecked(hDlg, IDC_AUTOCOPY_CTRL) == BST_CHECKED);
    s_settings.autoCopyHotkey.shift = (IsDlgButtonChecked(hDlg, IDC_AUTOCOPY_SHIFT) == BST_CHECKED);
    s_settings.autoCopyHotkey.alt = (IsDlgButtonChecked(hDlg, IDC_AUTOCOPY_ALT) == BST_CHECKED);
    s_settings.autoCopyHotkey.win = (IsDlgButtonChecked(hDlg, IDC_AUTOCOPY_WIN) == BST_CHECKED);
    wchar_t keyText[32];
    GetDlgItemTextW(hDlg, IDC_AUTOCOPY_KEY, keyText, 32);
    if (keyText[0]) s_settings.autoCopyHotkey.vkCode = (UINT)towupper(keyText[0]);
    s_settings.autoDeleteHotkey.ctrl = (IsDlgButtonChecked(hDlg, IDC_AUTODELETE_CTRL) == BST_CHECKED);
    s_settings.autoDeleteHotkey.shift = (IsDlgButtonChecked(hDlg, IDC_AUTODELETE_SHIFT) == BST_CHECKED);
    s_settings.autoDeleteHotkey.alt = (IsDlgButtonChecked(hDlg, IDC_AUTODELETE_ALT) == BST_CHECKED);
    s_settings.autoDeleteHotkey.win = (IsDlgButtonChecked(hDlg, IDC_AUTODELETE_WIN) == BST_CHECKED);
    GetDlgItemTextW(hDlg, IDC_AUTODELETE_KEY, keyText, 32);
    if (keyText[0]) s_settings.autoDeleteHotkey.vkCode = (UINT)towupper(keyText[0]);
    s_settings.middleButtonPaste = (IsDlgButtonChecked(hDlg, IDC_MIDDLE_BUTTON_PASTE) == BST_CHECKED);
    s_settings.middleButtonReplaceAll = (IsDlgButtonChecked(hDlg, IDC_MIDDLE_BUTTON_REPLACE_ALL) == BST_CHECKED);
    s_settings.pressEnterAfterPaste = (IsDlgButtonChecked(hDlg, IDC_PRESS_ENTER) == BST_CHECKED);
    s_settings.textSize = (int)SendDlgItemMessageW(hDlg, IDC_TEXTSIZE_SLIDER, TBM_GETPOS, 0, 0);
}

void SettingsDialog::ApplySettings() {
    if (s_hParent && IsWindow(s_hParent)) {
        SendMessageW(s_hParent, WM_APP_SETTINGS_CHANGED, 0, 0);
    }
}

void SettingsDialog::PreviewMainWindowTransparency(int transparency) {
    if (!s_hParent || !IsWindow(s_hParent)) return;
    LONG_PTR exStyle = GetWindowLongPtrW(s_hParent, GWL_EXSTYLE);
    if (!(exStyle & WS_EX_LAYERED)) {
        SetWindowLongPtrW(s_hParent, GWL_EXSTYLE, exStyle | WS_EX_LAYERED);
    }
    BYTE alpha = (BYTE)((transparency * 255) / 100);
    SetLayeredWindowAttributes(s_hParent, 0, alpha, LWA_ALPHA);
}

void SettingsDialog::RestoreDefaults(HWND hDlg) {
    s_settings = GetDefaultSettings();
    LoadSettingsToControls(hDlg);
    SaveSettings(s_settings);
    ApplySettings();
}

void SettingsDialog::UpdatePreviewText(HWND hDlg) {
    HWND hPreview = GetDlgItem(hDlg, IDC_PREVIEW_TEXT);
    SendMessageW(hPreview, EM_SETBKGNDCOLOR, 0, (LPARAM)s_settings.bgColor);
    int textSize = (int)SendDlgItemMessageW(hDlg, IDC_TEXTSIZE_SLIDER, TBM_GETPOS, 0, 0);
    SetWindowTextW(hPreview, L"LiveCaption is a Windows desktop application that captures text from Windows' built-in Live Caption feature and displays it in a customizable window.\n "
        L"The app monitors the Live Caption accessibility feature using UI Automation COM API and extracts the real-time transcribed text. It provides enhanced functionality beyond the default Live Caption, including persistent caption history, customizable appearance (colors, text size, transparency), and keyboard shortcuts for copying and clearing text.\n"
        L" The application allows users to keep captions visible even when the original Live Caption window is hidden, making it useful for accessibility, transcription, or recording purposes. All settings are stored in the Windows Registry and can be customized through a dedicated settings panel with features like dark mode, always-on-top mode, and adjustable window transparency.");
    CHARFORMAT2W cf = {};
    cf.cbSize = sizeof(CHARFORMAT2W);
    cf.dwMask = CFM_SIZE | CFM_COLOR | CFM_FACE;
    cf.yHeight = textSize * 20;
    cf.crTextColor = s_settings.textColor;
    wcscpy_s(cf.szFaceName, L"Segoe UI");
    SendMessageW(hPreview, EM_SETCHARFORMAT, SCF_ALL, (LPARAM)&cf);
    SendMessageW(hPreview, EM_SETSEL, 29, -1);
    CHARFORMAT2W cfSel = {};
    cfSel.cbSize = sizeof(CHARFORMAT2W);
    cfSel.dwMask = CFM_BACKCOLOR;
    cfSel.crBackColor = s_settings.selectedBgColor;
    SendMessageW(hPreview, EM_SETCHARFORMAT, SCF_SELECTION, (LPARAM)&cfSel);
    SendMessageW(hPreview, EM_SETSEL, 0, 0);
    SendMessageW(hPreview, EM_HIDESELECTION, TRUE, 0);
}


ToggleButtonStyle SettingsDialog::GetToggleButtonStyle(int controlId) {
    ToggleButtonStyle style = {};
    if (controlId == IDC_DARKMODE) {
        style.textOff = L"Light";
        style.textOn = L"Dark";
        style.colorOff = RGB(255, 255, 255);
        style.colorOn = RGB(0, 0, 0);
        style.textColorOff = RGB(0, 0, 0);
        style.textColorOn = RGB(255, 255, 255);
    }
    else if (controlId == IDC_SETTOP) {
        style.textOff = L"Utmost";
        style.textOn = L"Topmost";
        style.colorOff = RGB(240, 240, 240);
        style.colorOn = s_settings.selectedBgColor;
        style.textColorOff = s_settings.textColor;
        style.textColorOn = s_settings.textColor;
    }
    else if (controlId == IDC_SETINVISIBLE) {
        style.textOff = L"Visible";
        style.textOn = L"Invisible";
        style.colorOff = RGB(240, 240, 240);
        style.colorOn = RGB(128, 128, 128);
        style.textColorOff = RGB(0, 0, 0);
        style.textColorOn = RGB(255, 255, 255);
    }
    return style;
}

void SettingsDialog::DrawToggleButton(LPDRAWITEMSTRUCT lpDIS, bool state, const ToggleButtonStyle& style) {
    HDC hdc = lpDIS->hDC;
    RECT rc = lpDIS->rcItem;
    COLORREF bgColor = state ? style.colorOn : style.colorOff;
    COLORREF textColor = state ? style.textColorOn : style.textColorOff;
    const wchar_t* text = state ? style.textOn : style.textOff;
    HBRUSH hBrush = CreateSolidBrush(bgColor);
    FillRect(hdc, &rc, hBrush);
    DeleteObject(hBrush);
    if (lpDIS->itemState & ODS_SELECTED) {
        DrawEdge(hdc, &rc, EDGE_SUNKEN, BF_RECT);
    } else {
        DrawEdge(hdc, &rc, EDGE_RAISED, BF_RECT);
    }
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, textColor);
    HFONT hFont = CreateFontW(-MulDiv(9, 96, 72), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
        DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
    HFONT hOldFont = (HFONT)SelectObject(hdc, hFont);
    DrawTextW(hdc, text, -1, &rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(hdc, hOldFont);
    DeleteObject(hFont);
}