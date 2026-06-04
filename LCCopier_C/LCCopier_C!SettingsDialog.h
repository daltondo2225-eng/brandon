#pragma once
#include <Windows.h>

struct HotkeyConfig {
    bool ctrl;
    bool shift;
    bool alt;
    bool win;
    UINT vkCode;
};

struct AppSettings {
    bool darkMode;
    bool setTop;
    bool setInvisible;
    bool middleButtonPaste;
    bool middleButtonReplaceAll;
    bool pressEnterAfterPaste;
    int transparency;
    HotkeyConfig autoCopyHotkey;
    HotkeyConfig autoDeleteHotkey;
    int textSize;
    COLORREF textColor;
    COLORREF bgColor;
    COLORREF selectedBgColor;
};

struct ToggleButtonStyle {
    const wchar_t* textOff;
    const wchar_t* textOn;
    COLORREF colorOff;
    COLORREF colorOn;
    COLORREF textColorOff;
    COLORREF textColorOn;
};

class SettingsDialog {
public:
    static void Show(HWND hParent);
    static void Close();
    static AppSettings LoadSettings();
    static void SaveSettings(const AppSettings& settings);

private:
    static HWND s_hDlg;
    static HWND s_hParent;
    static AppSettings s_settings;
    static int s_originalTransparency;

    static INT_PTR CALLBACK DialogProc(HWND hDlg, UINT message, WPARAM wParam, LPARAM lParam);
    static void InitializeControls(HWND hDlg);
    static void LoadSettingsToControls(HWND hDlg);
    static void SaveControlsToSettings(HWND hDlg);
    static void ApplySettings();
    static void RestoreDefaults(HWND hDlg);
    static void UpdatePreviewText(HWND hDlg);
    static void PreviewMainWindowTransparency(int transparency);
    static void DrawToggleButton(LPDRAWITEMSTRUCT lpDIS, bool state, const ToggleButtonStyle& style);
    static ToggleButtonStyle GetToggleButtonStyle(int controlId);

    static AppSettings GetDefaultSettings();
    static void LoadFromRegistry(AppSettings& settings);
    static void SaveToRegistry(const AppSettings& settings);
};

