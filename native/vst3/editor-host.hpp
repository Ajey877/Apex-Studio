#pragma once

#ifdef _WIN32

#include "pluginterfaces/base/keycodes.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include <deque>
#include <functional>
#include <limits>
#include <mutex>
#include <sstream>

namespace ApexVst3Host {

// Acceptance-test seam. Empty in production: the queue is only populated by the
// host executable when it is explicitly compiled/run as a test build, so no
// product code path depends on it.
namespace tests {
using Action = std::function<void()>;
// Messages queued for the window (WM_KEYDOWN etc.) so a harness can inject real
// Win32 input without needing OS-level input injection permissions.
inline std::deque<std::pair<UINT, WPARAM>>& pendingMessages() {
  static std::deque<std::pair<UINT, WPARAM>> queue;
  return queue;
}
inline void queueMessage(UINT message, WPARAM wParam) { pendingMessages().emplace_back(message, wParam); }
inline std::deque<Action>& pendingActions() { static std::deque<Action> queue; return queue; }
inline void queueAction(Action action) { pendingActions().push_back(std::move(action)); }
inline void runPendingActions() {
  auto& queue = pendingActions();
  while (!queue.empty()) {
    Action action = std::move(queue.front());
    queue.pop_front();
    try { action(); } catch (...) { /* a harness action must never kill the helper */ }
  }
}
} // namespace tests

class NativeEditorSession;

class NativeEditorFrame final : public Steinberg::IPlugFrame {
  std::atomic<Steinberg::uint32> refCount{1};
  NativeEditorSession* owner;

public:
  explicit NativeEditorFrame(NativeEditorSession* session) : owner(session) {}
  Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID iid, void** obj) override;
  Steinberg::uint32 PLUGIN_API addRef() override {
    return refCount.fetch_add(1, std::memory_order_relaxed) + 1;
  }
  Steinberg::uint32 PLUGIN_API release() override {
    const auto remaining = refCount.fetch_sub(1, std::memory_order_acq_rel) - 1;
    if (remaining == 0) delete this;
    return remaining;
  }
  Steinberg::tresult PLUGIN_API resizeView(Steinberg::IPlugView* view,
                                            Steinberg::ViewRect* newSize) override;
};

class NativeEditorSession {
  IPtr<HostApplication> host = owned(new HostApplication());
  IPtr<HostComponentHandler> componentHandler = owned(new HostComponentHandler());
  VST3::Hosting::Module::Ptr module;
  IPtr<PlugProvider> provider;
  IPtr<IComponent> component;
  IPtr<IEditController> controller;
  IPtr<Steinberg::IPlugView> view;
  IPtr<Steinberg::IPlugViewContentScaleSupport> scaleSupport;
  IPtr<NativeEditorFrame> frame;
  std::set<ParamID> parameterIds;
  std::set<ParamID> readOnlyIds;
  std::vector<ParameterInfo> parameterInfo;
  std::map<ParamID, ParamValue> savedParameterOverrides;
  std::string classId;
  std::string pluginName;
  HWND window = nullptr;
  DWORD windowStyle = 0;
  bool resizable = false;
  bool openAttempted = false;
  bool attachAttempted = false;
  bool attached = false;
  bool resizingByPlugin = false;
  bool closed = false;
  bool lastCloseFailurePending = false;
  float contentScaleFactor = 1.f;
  std::optional<std::pair<int, int>> lastPluginResizeRequest;
  bool dirtyAtClose = false;
  bool editQueueOverflowAtClose = false;
  std::string lastNativeCloseError;
  std::vector<ParameterEditEvent> finalEditEvents;
  std::map<ParamID, ParamValue> finalEditedParameterValues;
  std::set<ParamID> finalActiveEditIds;
  json finalState;

  static constexpr int32 kMinViewDimension = 32;
  static constexpr int32 kMaxViewDimension = 8192;

  static LRESULT CALLBACK windowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    NativeEditorSession* self = reinterpret_cast<NativeEditorSession*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
      const auto* create = reinterpret_cast<const CREATESTRUCTW*>(lParam);
      self = static_cast<NativeEditorSession*>(create->lpCreateParams);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
      if (self) self->window = hwnd;
    }
    return self ? self->handleWindowMessage(hwnd, message, wParam, lParam)
                : DefWindowProcW(hwnd, message, wParam, lParam);
  }

  static std::string fromWide(const std::wstring& text) {
    if (text.empty()) return {};
    const int count = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                                          nullptr, 0, nullptr, nullptr);
    if (count <= 0) return {};
    std::string result(static_cast<size_t>(count), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                        result.data(), count, nullptr, nullptr);
    return result;
  }

  static std::wstring toWide(const std::string& text) {
    if (text.empty()) return {};
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                                         static_cast<int>(text.size()), nullptr, 0);
    if (count <= 0) return std::wstring(text.begin(), text.end());
    std::wstring result(static_cast<size_t>(count), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                        static_cast<int>(text.size()), result.data(), count);
    return result;
  }

  static std::wstring windowTitle(const std::string& name) {
    auto wide = toWide(name);
    if (wide.empty()) wide = L"VST3 effect";
    return L"Apex Studio VST3 Editor - " + wide;
  }

  static bool validRect(const Steinberg::ViewRect& rect) {
    return rect.left >= -kMaxViewDimension && rect.top >= -kMaxViewDimension &&
      rect.getWidth() >= kMinViewDimension && rect.getWidth() <= kMaxViewDimension &&
      rect.getHeight() >= kMinViewDimension && rect.getHeight() <= kMaxViewDimension;
  }

  static bool isSuccess(Steinberg::tresult result) {
    return result == Steinberg::kResultOk || result == Steinberg::kResultTrue;
  }

  static bool registerHostWindowClass() {
    static std::once_flag once;
    static bool registered = false;
    std::call_once(once, [] {
      WNDCLASSEXW klass{};
      klass.cbSize = sizeof(klass);
      klass.style = CS_HREDRAW | CS_VREDRAW;
      klass.lpfnWndProc = &NativeEditorSession::windowProc;
      klass.hInstance = GetModuleHandleW(nullptr);
      klass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
      klass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
      klass.lpszClassName = L"ApexStudioVst3EditorHostWindow";
      registered = RegisterClassExW(&klass) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
    });
    return registered;
  }

  static int16_t mapVirtualKey(WPARAM key) {
    using namespace Steinberg;
    switch (key) {
      case VK_BACK: return KEY_BACK;
      case VK_TAB: return KEY_TAB;
      case VK_RETURN: return KEY_RETURN;
      case VK_PAUSE: return KEY_PAUSE;
      case VK_ESCAPE: return KEY_ESCAPE;
      case VK_SPACE: return KEY_SPACE;
      case VK_PRIOR: return KEY_PAGEUP;
      case VK_NEXT: return KEY_PAGEDOWN;
      case VK_END: return KEY_END;
      case VK_HOME: return KEY_HOME;
      case VK_LEFT: return KEY_LEFT;
      case VK_UP: return KEY_UP;
      case VK_RIGHT: return KEY_RIGHT;
      case VK_DOWN: return KEY_DOWN;
      case VK_INSERT: return KEY_INSERT;
      case VK_DELETE: return KEY_DELETE;
      case VK_SHIFT: return KEY_SHIFT;
      case VK_CONTROL: return KEY_CONTROL;
      case VK_MENU: return KEY_ALT;
      case VK_F1: return KEY_F1;
      case VK_F2: return KEY_F2;
      case VK_F3: return KEY_F3;
      case VK_F4: return KEY_F4;
      case VK_F5: return KEY_F5;
      case VK_F6: return KEY_F6;
      case VK_F7: return KEY_F7;
      case VK_F8: return KEY_F8;
      case VK_F9: return KEY_F9;
      case VK_F10: return KEY_F10;
      case VK_F11: return KEY_F11;
      case VK_F12: return KEY_F12;
      default:
        if ((key >= '0' && key <= '9') || (key >= 'A' && key <= 'Z'))
          return static_cast<int16_t>(CharToVirtualKeyCode(static_cast<tchar>(key)));
        return 0;
    }
  }

  static int16_t keyModifiers() {
    int16_t result = 0;
    if (GetKeyState(VK_SHIFT) & 0x8000) result |= Steinberg::kShiftKey;
    if (GetKeyState(VK_MENU) & 0x8000) result |= Steinberg::kAlternateKey;
    if (GetKeyState(VK_CONTROL) & 0x8000) result |= Steinberg::kCommandKey;
    if (GetKeyState(VK_LWIN) & 0x8000 || GetKeyState(VK_RWIN) & 0x8000) result |= Steinberg::kControlKey;
    return result;
  }

  static uint32_t dpiForWindow(HWND hwnd) {
    using GetDpiForWindowFn = UINT(WINAPI*)(HWND);
    const auto user32 = GetModuleHandleW(L"user32.dll");
    const auto function = reinterpret_cast<GetDpiForWindowFn>(GetProcAddress(user32, "GetDpiForWindow"));
    return function && hwnd ? function(hwnd) : 96u;
  }

  void applyContentScale(uint32_t dpi) {
    if (!scaleSupport) return;
    const auto factor = static_cast<float>(dpi ? dpi : 96u) / 96.f;
    contentScaleFactor = factor;
    const auto result = scaleSupport->setContentScaleFactor(factor);
    if (result != Steinberg::kResultTrue && result != Steinberg::kResultOk &&
        result != Steinberg::kResultFalse && result != Steinberg::kNotImplemented) {
      throw std::runtime_error("VST3 editor rejected the Windows content scale factor");
    }
  }

  // A plug-in can call IComponentHandler::restartComponent while its editor is
  // open. Structural restarts cannot be applied to a live view, so they are
  // refused explicitly (the user is told) instead of leaving a stale window that
  // silently disagrees with the plug-in's state.
  void rejectStructuralRestartFlags(const char* context) {
    const auto flags = componentHandler->consumeRestartFlags();
    require((flags & (RestartFlags::kReloadComponent | RestartFlags::kIoChanged |
                      RestartFlags::kLatencyChanged)) == 0,
      std::string("VST3 plug-in requested an unsupported structural restart (") +
      std::to_string(flags) + ") while its editor was open during " + context +
      "; close the editor and re-open the insert");
  }

  void createHostWindow(const Steinberg::ViewRect& initialSize) {
    require(validRect(initialSize), "VST3 editor returned an invalid or unsupported initial size");
    require(registerHostWindowClass(), "Could not register the native VST3 editor window class");

    const auto canResizeResult = view->canResize();
    resizable = canResizeResult == Steinberg::kResultTrue;
    windowStyle = resizable
      ? (WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_THICKFRAME | WS_MAXIMIZEBOX)
      : (WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX);
    RECT bounds{0, 0, initialSize.getWidth(), initialSize.getHeight()};
    require(AdjustWindowRectEx(&bounds, windowStyle, FALSE, 0) != 0,
      "Could not calculate native VST3 editor window bounds");
    const auto title = windowTitle(pluginName);
    window = CreateWindowExW(WS_EX_APPWINDOW, L"ApexStudioVst3EditorHostWindow", title.c_str(),
      windowStyle, CW_USEDEFAULT, CW_USEDEFAULT, bounds.right - bounds.left,
      bounds.bottom - bounds.top, nullptr, nullptr, GetModuleHandleW(nullptr), this);
    require(window != nullptr, "Could not create the native VST3 editor window");
  }

  void applyInitialSize() {
    RECT client{};
    require(GetClientRect(window, &client) != 0, "Could not query the VST3 editor client area");
    Steinberg::ViewRect size{0, 0, client.right - client.left, client.bottom - client.top};
    require(validRect(size), "Native VST3 editor client size is invalid");
    const auto result = view->onSize(&size);
    require(isSuccess(result), "VST3 editor rejected the initial native window size");
  }

  json metadata() {
    json result = json::array();
    for (const auto& info : parameterInfo) {
      const auto value = controller->getParamNormalized(info.id);
      result.push_back({{"id", info.id}, {"name", StringConvert::convert(info.title)},
        {"shortTitle", StringConvert::convert(info.shortTitle)}, {"units", StringConvert::convert(info.units)},
        {"defaultValue", info.defaultNormalizedValue}, {"flags", info.flags}, {"stepCount", info.stepCount},
        {"currentValue", std::isfinite(value) && value >= 0. && value <= 1. ? json(value) : json(nullptr)}});
    }
    return result;
  }

  void restoreState(const json& state) {
    require(state.is_object() && state.value("schema", 0) == 1 &&
      state.value("classId", std::string()) == classId,
      "Saved VST3 effect state identity/schema mismatch; no substitute was loaded");

    if (state.contains("component")) {
      auto bytes = unhex(state.at("component").get<std::string>());
      require(bytes.size() <= 1024 * 1024, "Saved component state exceeds the 1 MiB limit");
      MemoryStream stream(bytes.data(), bytes.size());
      checked(component->setState(&stream), "Plugin rejected the saved component state");
      stream.seek(0, IBStream::kIBSeekSet, nullptr);
      const auto result = controller->setComponentState(&stream);
      require(result == kResultOk || result == kNotImplemented,
        "Controller rejected the saved component state");
    }

    if (state.contains("controller")) {
      auto bytes = unhex(state.at("controller").get<std::string>());
      require(bytes.size() <= 1024 * 1024, "Saved controller state exceeds the 1 MiB limit");
      MemoryStream stream(bytes.data(), bytes.size());
      checked(controller->setState(&stream), "Plugin rejected the saved controller state");
    }

    if (state.contains("parameters")) {
      const auto& values = state.at("parameters");
      require(values.is_array() && values.size() <= 4096, "Invalid saved VST3 parameter override list");
      for (const auto& item : values) {
        require(item.is_object() && item.contains("id") && item.contains("value") &&
          (item.at("id").is_number_integer() || item.at("id").is_number_unsigned()),
          "Invalid saved VST3 parameter override");
        const auto rawId = item.at("id").get<int64_t>();
        require(rawId >= 0 && static_cast<uint64_t>(rawId) <= UINT32_MAX,
          "Saved VST3 ParamID is out of range");
        const auto id = static_cast<ParamID>(rawId);
        const auto value = item.at("value").get<double>();
        require(parameterIds.count(id) != 0 && readOnlyIds.count(id) == 0,
          "Saved VST3 parameter is unknown or read-only");
        require(std::isfinite(value) && value >= 0. && value <= 1.,
          "Saved VST3 normalized parameter is outside [0,1]");
        checked(controller->setParamNormalized(id, value), "Controller rejected a saved normalized parameter");
        const auto accepted = controller->getParamNormalized(id);
        require(std::isfinite(accepted) && accepted >= 0. && accepted <= 1. &&
          std::abs(accepted - value) <= 1e-7,
          "Controller did not accept the saved normalized parameter");
        require(savedParameterOverrides.emplace(id, value).second,
          "Duplicate saved VST3 parameter override");
      }
    }
  }

  static json eventsToJson(const std::vector<ParameterEditEvent>& events) {
    json result = json::array();
    for (const auto& event : events) {
      json item{{"type", event.type}, {"id", event.id}};
      if (event.type == "perform") item["value"] = event.value;
      result.push_back(std::move(item));
    }
    return result;
  }

  static json parameterValuesToJson(const std::map<ParamID, ParamValue>& values) {
    json result = json::array();
    for (const auto& entry : values) result.push_back({{"id", entry.first}, {"value", entry.second}});
    return result;
  }

  static json activeEditIdsToJson(const std::set<ParamID>& ids) {
    return json(ids);
  }

  json captureState() {
    require(component && controller, "VST3 editor state is unavailable");
    json state{{"schema", 1}, {"classId", classId}, {"parameters", json::array()}};

    MemoryStream componentState;
    const auto componentResult = component->getState(&componentState);
    if (componentResult == Steinberg::kResultOk) {
      require(componentState.getSize() <= 1024 * 1024, "Plugin component state exceeds the 1 MiB limit");
      state["component"] = hex(componentState.getData(), componentState.getSize());
    } else {
      require(componentResult == Steinberg::kNotImplemented,
        "Plugin failed to capture component state; the editor remains open");
    }

    MemoryStream controllerState;
    const auto controllerResult = controller->getState(&controllerState);
    if (controllerResult == Steinberg::kResultOk) {
      require(controllerState.getSize() <= 1024 * 1024, "Plugin controller state exceeds the 1 MiB limit");
      state["controller"] = hex(controllerState.getData(), controllerState.getSize());
    } else {
      require(controllerResult == Steinberg::kNotImplemented,
        "Plugin failed to capture controller state; the editor remains open");
    }

    auto parameterValues = savedParameterOverrides;
    for (const auto& edit : componentHandler->editedParameterValues()) {
      require(parameterIds.count(edit.first) != 0 && readOnlyIds.count(edit.first) == 0 &&
        std::isfinite(edit.second) && edit.second >= 0. && edit.second <= 1.,
        "Plugin reported an invalid final parameter value; the editor remains open");
      parameterValues[edit.first] = edit.second;
    }
    for (const auto& entry : parameterValues) {
      state["parameters"].push_back({{"id", entry.first}, {"value", entry.second}});
    }
    require(state.dump().size() <= 4 * 1024 * 1024,
      "Captured VST3 editor state exceeds the 4 MiB project-state limit");
    return state;
  }

  void detachViewAndDestroyWindow() {
    if (view && attachAttempted) {
      const auto removedResult = view->removed();
      require(isSuccess(removedResult), "VST3 editor refused IPlugView::removed; its native window remains open");
      attached = false;
      attachAttempted = false;
      const auto frameResult = view->setFrame(nullptr);
      require(isSuccess(frameResult) || frameResult == Steinberg::kNotImplemented,
        "VST3 editor failed to release its IPlugFrame");
      view = nullptr;
    }
    scaleSupport = nullptr;
    frame = nullptr;
    if (window) {
      const HWND parent = window;
      if (IsWindow(parent)) require(DestroyWindow(parent) != 0,
        "Could not destroy the native VST3 editor window");
      window = nullptr;
    }
  }

  void forceDetachNoThrow() noexcept {
    if (view && attachAttempted) {
      try { view->removed(); } catch (...) { /* best-effort teardown after capture failure */ }
    }
    if (view) {
      try { view->setFrame(nullptr); } catch (...) { /* release below regardless */ }
    }
    attached = false;
    attachAttempted = false;
    scaleSupport = nullptr;
    view = nullptr;
    frame = nullptr;
    if (window) {
      const HWND parent = window;
      window = nullptr;
      if (IsWindow(parent)) DestroyWindow(parent);
    }
  }

  void releasePluginObjects() noexcept {
    if (controller) controller->setComponentHandler(nullptr);
    if (componentHandler) componentHandler->disableParameterCapture();
    view = nullptr;
    scaleSupport = nullptr;
    controller = nullptr;
    component = nullptr;
    provider = nullptr;
    componentHandler = nullptr;
    frame = nullptr;
    module.reset();
    PluginContextFactory::instance().setPluginContext(nullptr);
  }

  void finishClose() {
    if (closed) return;
    auto captured = captureState();
    dirtyAtClose = componentHandler->consumeDirty();
    editQueueOverflowAtClose = componentHandler->editQueueOverflowed();
    finalEditEvents = componentHandler->drainEditEvents();
    finalEditedParameterValues = componentHandler->editedParameterValues();
    finalActiveEditIds = componentHandler->activeEditIds();
    finalState = std::move(captured);
    // finishClose() has no throw path left here; keep any earlier window
    // diagnostic (resize/scale/restart refusal) for the close response.
    detachViewAndDestroyWindow();
    closed = true;
    releasePluginObjects();
  }

  // The capture failure is reported through the framed protocol (nativeCloseError)
  // and rendered by Apex's own panel. It must NOT be a modal MessageBox: a modal
  // dialog on this helper's UI thread never returns without a human click, which
  // would freeze the helper, block every later editorPoll, and make the state
  // capture unrecoverable in any unattended or automated session.
  void nativeCloseFromWindow() noexcept {
    if (closed) return;
    try {
      finishClose();
      lastNativeCloseError.clear();
    } catch (const std::exception& error) {
      lastNativeCloseError = error.what();
      if (lastNativeCloseError.size() > 1024) lastNativeCloseError.resize(1024);
      lastCloseFailurePending = true;
    } catch (...) {
      lastNativeCloseError = "Unknown editor state capture error";
      lastCloseFailurePending = true;
    }
  }

  LRESULT handleWindowMessage(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
      case WM_CLOSE:
        nativeCloseFromWindow();
        return 0;
      case WM_SETFOCUS:
        if (view) view->onFocus(1);
        break;
      case WM_KILLFOCUS:
        if (view) view->onFocus(0);
        break;
      case WM_SIZE:
        if (view && attached && !resizingByPlugin && wParam != SIZE_MINIMIZED) {
          const auto width = static_cast<int32>(LOWORD(lParam));
          const auto height = static_cast<int32>(HIWORD(lParam));
          if (width >= kMinViewDimension && height >= kMinViewDimension &&
              width <= kMaxViewDimension && height <= kMaxViewDimension) {
            Steinberg::ViewRect size{0, 0, width, height};
            const auto result = view->onSize(&size);
            if (!isSuccess(result)) lastNativeCloseError = "Plug-in rejected a host window resize";
          }
        }
        return 0;
      case WM_SIZING:
        if (view && attached && resizable && lParam) {
          auto* outer = reinterpret_cast<RECT*>(lParam);
          RECT extents{0, 0, 0, 0};
          AdjustWindowRectEx(&extents, windowStyle, FALSE, 0);
          const int frameWidth = extents.right - extents.left;
          const int frameHeight = extents.bottom - extents.top;
          Steinberg::ViewRect size{0, 0,
            std::max<int32>(kMinViewDimension, outer->right - outer->left - frameWidth),
            std::max<int32>(kMinViewDimension, outer->bottom - outer->top - frameHeight)};
          if (size.getWidth() <= kMaxViewDimension && size.getHeight() <= kMaxViewDimension) {
            view->checkSizeConstraint(&size);
            if (validRect(size)) {
              const int targetWidth = size.getWidth() + frameWidth;
              const int targetHeight = size.getHeight() + frameHeight;
              if (wParam == WMSZ_LEFT || wParam == WMSZ_TOPLEFT || wParam == WMSZ_BOTTOMLEFT)
                outer->left = outer->right - targetWidth;
              else outer->right = outer->left + targetWidth;
              if (wParam == WMSZ_TOP || wParam == WMSZ_TOPLEFT || wParam == WMSZ_TOPRIGHT)
                outer->top = outer->bottom - targetHeight;
              else outer->bottom = outer->top + targetHeight;
            }
          }
          return TRUE;
        }
        break;
      case WM_GETMINMAXINFO:
        if (view && !resizable && lParam) {
          Steinberg::ViewRect size{};
          if (isSuccess(view->getSize(&size)) && validRect(size)) {
            RECT outer{0, 0, size.getWidth(), size.getHeight()};
            AdjustWindowRectEx(&outer, windowStyle, FALSE, 0);
            auto* info = reinterpret_cast<MINMAXINFO*>(lParam);
            info->ptMinTrackSize.x = info->ptMaxTrackSize.x = outer.right - outer.left;
            info->ptMinTrackSize.y = info->ptMaxTrackSize.y = outer.bottom - outer.top;
            return 0;
          }
        }
        break;
      case WM_DPICHANGED: {
        const auto* suggested = reinterpret_cast<const RECT*>(lParam);
        if (suggested) SetWindowPos(hwnd, nullptr, suggested->left, suggested->top,
          suggested->right - suggested->left, suggested->bottom - suggested->top,
          SWP_NOZORDER | SWP_NOACTIVATE);
        try { applyContentScale(HIWORD(wParam)); }
        catch (const std::exception& error) { lastNativeCloseError = error.what(); }
        return 0;
      }
      case WM_MOUSEWHEEL:
        if (view && view->onWheel(static_cast<float>(GET_WHEEL_DELTA_WPARAM(wParam)) / WHEEL_DELTA) == Steinberg::kResultTrue)
          return 0;
        break;
      case WM_KEYDOWN:
      case WM_SYSKEYDOWN:
        if (view && view->onKeyDown(0, mapVirtualKey(wParam), keyModifiers()) == Steinberg::kResultTrue)
          return 0;
        break;
      case WM_KEYUP:
      case WM_SYSKEYUP:
        if (view && view->onKeyUp(0, mapVirtualKey(wParam), keyModifiers()) == Steinberg::kResultTrue)
          return 0;
        break;
      case WM_CHAR:
        if (view && view->onKeyDown(static_cast<Steinberg::char16>(wParam), 0, keyModifiers()) == Steinberg::kResultTrue)
          return 0;
        break;
      case WM_DESTROY:
        // This child process owns one editor window, but it must continue
        // servicing the framed stdin protocol after the plug-in window closes.
        return 0;
      default:
        break;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
  }

public:
  NativeEditorSession() = default;
  NativeEditorSession(const NativeEditorSession&) = delete;
  NativeEditorSession& operator=(const NativeEditorSession&) = delete;

  ~NativeEditorSession() {
    try { detachViewAndDestroyWindow(); } catch (...) { forceDetachNoThrow(); }
    releasePluginObjects();
  }

  json open(const json& request) {
    require(!openAttempted, "VST3 editor session can only be opened once");
    openAttempted = true;
    std::string error;
    module = VST3::Hosting::Module::create(request.at("path").get<std::string>(), error);
    require(bool(module), "Plugin module load failed: " + error);
    classId = request.at("classId").get<std::string>();
    const auto factory = module->getFactory();
    factory.setHostContext(host);
    PluginContextFactory::instance().setPluginContext(host);

    VST3::Hosting::ClassInfo selectedInfo;
    bool found = false;
    for (const auto& info : factory.classInfos()) {
      if (info.ID().toString() != classId) continue;
      require(audioEffect(info), "Selected class is not a VST3 Mixer audio effect");
      selectedInfo = info;
      found = true;
      break;
    }
    require(found, "Saved VST3 effect class ID is not present in this module");
    pluginName = selectedInfo.name();

    provider = owned(new PlugProvider(factory, selectedInfo, true));
    require(provider->initialize(), "Plugin component/controller initialization failed");
    component = provider->getComponentPtr();
    controller = provider->getControllerPtr();
    require(component && controller, "A native editor requires a VST3 component and edit controller");
    const auto handlerResult = controller->setComponentHandler(componentHandler);
    require(handlerResult == Steinberg::kResultOk || handlerResult == Steinberg::kNotImplemented,
      "setComponentHandler failed (VST result " + std::to_string(handlerResult) + ")");

    const auto count = controller->getParameterCount();
    require(count >= 0 && count <= 4096, "Too many VST3 editor parameters");
    for (int32 index = 0; index < count; ++index) {
      ParameterInfo info{};
      checked(controller->getParameterInfo(index, info), "Cannot query VST3 editor parameter metadata");
      require(parameterIds.insert(info.id).second, "Duplicate VST3 ParamID in editor metadata");
      require(std::isfinite(info.defaultNormalizedValue) && info.defaultNormalizedValue >= 0. &&
        info.defaultNormalizedValue <= 1. && info.stepCount >= 0,
        "Invalid VST3 editor parameter metadata");
      if (info.flags & ParameterInfo::kIsReadOnly) readOnlyIds.insert(info.id);
      parameterInfo.push_back(info);
    }

    if (request.contains("state")) restoreState(request.at("state"));
    else {
      // New inserts may still have meaningful factory state. Restore the
      // component's defaults into the split controller using the VST3 contract.
      MemoryStream stream;
      const auto result = component->getState(&stream);
      if (result == Steinberg::kResultOk) {
        stream.seek(0, IBStream::kIBSeekSet, nullptr);
        const auto controllerResult = controller->setComponentState(&stream);
        require(controllerResult == Steinberg::kResultOk || controllerResult == Steinberg::kNotImplemented,
          "Controller rejected the initial component state");
      } else require(result == Steinberg::kNotImplemented, "Plugin failed to initialize its default component state");
    }
    componentHandler->enableParameterCapture(parameterIds, readOnlyIds);

    view = owned(controller->createView(Steinberg::Vst::ViewType::kEditor));
    require(view, "Native editor unavailable: createView(\"editor\") returned no view");
    require(view->isPlatformTypeSupported(Steinberg::kPlatformTypeHWND) == Steinberg::kResultTrue,
      "Native editor unavailable: the plug-in does not support the Windows HWND platform type");
    scaleSupport = Steinberg::FUnknownPtr<Steinberg::IPlugViewContentScaleSupport>(view);
    frame = owned(new NativeEditorFrame(this));
    checked(view->setFrame(frame), "VST3 editor rejected the host IPlugFrame");

    Steinberg::ViewRect initialSize{};
    checked(view->getSize(&initialSize), "VST3 editor did not provide an initial size");
    createHostWindow(initialSize);
    attachAttempted = true;
    checked(view->attached(window, Steinberg::kPlatformTypeHWND),
      "VST3 editor failed to attach to the native HWND host window");
    attached = true;

    applyContentScale(dpiForWindow(window));
    applyInitialSize();
    rejectStructuralRestartFlags("editor open");
    ShowWindow(window, SW_SHOWNORMAL);
    UpdateWindow(window);
    SetForegroundWindow(window);
    SetFocus(window);

    return {{"available", true}, {"classId", classId}, {"name", pluginName},
      {"title", "Apex Studio VST3 Editor - " + pluginName},
      {"resizable", resizable}, {"width", initialSize.getWidth()}, {"height", initialSize.getHeight()},
      {"controllerAvailable", true}, {"parameters", metadata()}};
  }

  Steinberg::tresult resizeView(Steinberg::IPlugView* requestedView, Steinberg::ViewRect* newSize) {
    if (!view || requestedView != view || !window || closed || !newSize || !validRect(*newSize))
      return Steinberg::kInvalidArgument;
    RECT bounds{0, 0, newSize->getWidth(), newSize->getHeight()};
    if (!AdjustWindowRectEx(&bounds, windowStyle, FALSE, 0)) return Steinberg::kInternalError;
    lastPluginResizeRequest = {newSize->getWidth(), newSize->getHeight()};
    resizingByPlugin = true;
    const BOOL changed = SetWindowPos(window, nullptr, 0, 0, bounds.right - bounds.left,
      bounds.bottom - bounds.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    resizingByPlugin = false;
    if (!changed) return Steinberg::kInternalError;
    auto requestedSize = *newSize;
    return view->onSize(&requestedSize);
  }

  /** Deliver messages a harness injected, through the real window procedure. */
  void dispatchInjectedMessages() {
    auto& queue = tests::pendingMessages();
    while (!queue.empty() && window && !closed) {
      const auto [message, wParam] = queue.front();
      queue.pop_front();
      SendMessageW(window, message, wParam, 0);
    }
  }

  bool pumpMessages() {
    dispatchInjectedMessages();
    tests::runPendingActions();
    MSG message{};
    bool dispatched = false;
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      dispatched = true;
      if (message.message == WM_QUIT) {
        nativeCloseFromWindow();
        continue;
      }
      TranslateMessage(&message);
      DispatchMessageW(&message);
      dispatchInjectedMessages();
      tests::runPendingActions();
    }
    return dispatched;
  }

  /** Live HWND, for a harness that needs to post real input to it. Null when no
   * window exists. Deliberately narrow: no view/controller access is exposed. */
  HWND testWindowHandle() const { return window; }

  /** Deliver a real Win32 mouse message to this window's own procedure. VST3 has
   * no mouse entry point on IPlugView: Windows routes mouse input to whatever
   * child window is under the cursor, which is the plug-in's own child HWND. The
   * host's duty is therefore to *not swallow* the message and to report which
   * window would have received it. */
  LRESULT injectMouse(UINT message, LPARAM packedCoordinates) {
    return window && !closed ? SendMessageW(window, message, 0, packedCoordinates) : 0;
  }

  /** Note a size the plug-in asked the host for, so a harness can prove the
   * request was applied to the real window (resizeView may legitimately be
   * synchronous and already complete before it returns). */
  bool consumePluginResizeRequest(int* width, int* height) {
    if (!lastPluginResizeRequest) return false;
    if (width) *width = lastPluginResizeRequest->first;
    if (height) *height = lastPluginResizeRequest->second;
    lastPluginResizeRequest.reset();
    return true;
  }

  /** Ask the plug-in to resize itself through IPlugFrame::resizeView, which is
   * the only path a plug-in-owned resize handle takes. Returns false when the
   * plug-in does not request a resize, so the caller can report it honestly. */
  bool requestTestPluginResize(int width, int height) {
    if (!view || !frame || closed) return false;
    lastPluginResizeRequest.reset();
    Steinberg::ViewRect requested{0, 0, width, height};
    frame->resizeView(view, &requested);
    // The interesting fact is whether the plug-in asked for a size, not whether
    // the synchronous call had already finished applying it by the time it
    // returned -- so report the recorded request.
    return lastPluginResizeRequest.has_value();
  }

  json poll() {
    if (!closed) {
      try { rejectStructuralRestartFlags("editor poll"); }
      catch (const std::exception& error) {
        lastNativeCloseError = error.what();
        if (lastNativeCloseError.size() > 1024) lastNativeCloseError.resize(1024);
        componentHandler->consumeRestartFlags();
      }
    }
    auto rawEvents = closed ? finalEditEvents
      : (componentHandler ? componentHandler->drainEditEvents() : std::vector<ParameterEditEvent>{});
    const auto editedValues = closed ? finalEditedParameterValues
      : (componentHandler ? componentHandler->editedParameterValues() : std::map<ParamID, ParamValue>{});
    const auto activeIds = closed ? finalActiveEditIds
      : (componentHandler ? componentHandler->activeEditIds() : std::set<ParamID>{});
    json result{{"closed", closed}, {"events", eventsToJson(rawEvents)},
      {"editedParameters", parameterValuesToJson(editedValues)},
      {"activeEditIds", activeEditIdsToJson(activeIds)},
      {"dirty", componentHandler ? componentHandler->consumeDirty() : dirtyAtClose},
      {"eventQueueOverflow", componentHandler ? componentHandler->editQueueOverflowed() : editQueueOverflowAtClose}};
    if (!lastNativeCloseError.empty()) {
      result["nativeCloseError"] = lastNativeCloseError;
      lastNativeCloseError.clear();
    }
    if (closed) result["state"] = finalState;
    return result;
  }

  json closeAndCapture() {
    if (!closed) finishClose();
    json result{{"closed", true}, {"state", finalState}, {"dirty", dirtyAtClose},
      {"events", eventsToJson(finalEditEvents)},
      {"editedParameters", parameterValuesToJson(finalEditedParameterValues)},
      {"activeEditIds", activeEditIdsToJson(finalActiveEditIds)},
      {"eventQueueOverflow", editQueueOverflowAtClose}};
    // A diagnostic collected while the window was open travels with the close
    // response so the user still sees it after the window is gone.
    if (!lastNativeCloseError.empty()) {
      result["nativeCloseError"] = lastNativeCloseError;
      lastNativeCloseError.clear();
    }
    return result;
  }

  bool isClosed() const { return closed; }

  /** True while the plug-in window is up but its state could not be captured. */
  bool closeFailurePending() const { return lastCloseFailurePending; }

  /** Structured, passively-observable window state for acceptance evidence.
   * Reads only real Win32 state, so a check either observes the truth or fails. */
  json windowDiagnostics(const char* pluginClassId) {
    json result{{"closed", closed}, {"attached", attached}, {"windowCreated", window != nullptr},
      {"classId", pluginClassId ? pluginClassId : ""}, {"resizable", resizable}};
    if (window) {
      RECT client{};
      if (GetClientRect(window, &client)) {
        result["clientWidth"] = client.right - client.left;
        result["clientHeight"] = client.bottom - client.top;
      }
      RECT outer{};
      if (GetWindowRect(window, &outer)) {
        result["windowWidth"] = outer.right - outer.left;
        result["windowHeight"] = outer.bottom - outer.top;
      }
      result["visible"] = IsWindowVisible(window) != FALSE;
      result["iconic"] = IsIconic(window) != FALSE;
      result["ownsFocus"] = GetFocus() == window;
      result["activeWindowMatches"] = GetActiveWindow() == window;
      result["dpi"] = dpiForWindow(window);
      wchar_t title[512]{};
      if (GetWindowTextW(window, title, 512) > 0) result["title"] = fromWide(std::wstring(title));
      // Mouse input: VST3 forwards nothing through IPlugView, so what matters is
      // that real Win32 hit-testing lands on a live child window belonging to the
      // plug-in's view. WindowFromPoint is the OS's own answer, not our guess.
      RECT clientRect{};
      if (GetClientRect(window, &clientRect)) {
        POINT centre{clientRect.right / 2, clientRect.bottom / 2};
        ClientToScreen(window, &centre);
        const HWND hit = WindowFromPoint(centre);
        const bool hasTarget = hit != nullptr;
        const bool isChild = hit && hit != window && IsChild(window, hit) != FALSE;
        result["hitTestHasTarget"] = hasTarget;
        result["hitTestIsPlugInChild"] = isChild;
        result["hitTestIsHostWindow"] = hasTarget && hit == window;
        // A plug-in child window is what actually receives WM_MOUSEMOVE/LBUTTONDOWN.
        result["childWindowCount"] = [&] {
          int count = 0;
          EnumChildWindows(window, [](HWND, LPARAM data) -> BOOL {
            *reinterpret_cast<int*>(data) += 1;
            return TRUE;
          }, reinterpret_cast<LPARAM>(&count));
          return count;
        }();
      }
      result["threadId"] = static_cast<unsigned long>(GetCurrentThreadId());
      result["processId"] = static_cast<unsigned long>(GetCurrentProcessId());
      result["style"] = static_cast<unsigned long>(windowStyle);
      // Ask the plug-in what size it believes it has, so a host/plug-in size
      // disagreement after a resize or DPI change is visible rather than assumed.
      if (view && attached) {
        Steinberg::ViewRect viewSize{};
        if (isSuccess(view->getSize(&viewSize))) {
          result["viewWidth"] = viewSize.getWidth();
          result["viewHeight"] = viewSize.getHeight();
        }
        result["contentScale"] = contentScaleFactor;
      }
    }
    return result;
  }

  void shutdownNoThrow() noexcept {
    try { detachViewAndDestroyWindow(); } catch (...) { forceDetachNoThrow(); }
    releasePluginObjects();
  }
};

inline Steinberg::tresult PLUGIN_API NativeEditorFrame::queryInterface(const Steinberg::TUID iid,
                                                                         void** obj) {
  if (!obj) return Steinberg::kInvalidArgument;
  *obj = nullptr;
  if (Steinberg::FUnknownPrivate::iidEqual(iid, Steinberg::IPlugFrame::iid) ||
      Steinberg::FUnknownPrivate::iidEqual(iid, Steinberg::FUnknown::iid)) {
    addRef();
    *obj = static_cast<Steinberg::IPlugFrame*>(this);
    return Steinberg::kResultTrue;
  }
  return Steinberg::kNoInterface;
}

inline Steinberg::tresult PLUGIN_API NativeEditorFrame::resizeView(Steinberg::IPlugView* view,
                                                                     Steinberg::ViewRect* newSize) {
  return owner ? owner->resizeView(view, newSize) : Steinberg::kNotInitialized;
}

} // namespace ApexVst3Host

#endif // _WIN32
