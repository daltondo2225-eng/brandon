// header.h : include file for standard system include files,
// or project specific include files
//

#pragma once

#include "targetver.h"
#define WIN32_LEAN_AND_MEAN             // Exclude rarely-used stuff from Windows headers
// Windows Header Files
#include <windows.h>
#include <windowsx.h>
#include <dwmapi.h>
#include <richedit.h>
#include <objbase.h>   // COM base (interface macro, IUnknown) before UIAutomation
#include <UIAutomation.h>
#include <ole2.h>
#include <shellapi.h>
#include <shlobj.h>    // ITaskbarList
#pragma comment(lib, "dwmapi.lib")
// C RunTime Header Files
#include <stdlib.h>
#include <malloc.h>
#include <memory.h>
#include <tchar.h>
#include <string>
#include <vector>
#include <algorithm>