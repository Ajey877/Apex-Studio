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

  /** One content-scale attempt and everything observable about it. */
  struct ScaleAttempt {
    float factor = 1.f;
    Steinberg::tresult result = Steinberg::kNotImplemented;
    bool supported = false;   // IPlugViewContentScaleSupport was present
    bool applied = false;     // the plug-in accepted and applied the factor
    int clientWidthBefore = 0;
    int clientHeightBefore = 0;
    int clientWidthAfter = 0;
    int clientHeightAfter = 0;
    bool pluginRequestedResize = false;
    int requestedWidth = 0;
    int requestedHeight = 0;
    bool captureBefore = true; // scale was applied at open, before any observation
  };
  ScaleAttempt lastScaleAttempt;

  /** Observed focus transitions. WM_SETFOCUS/WM_KILLFOCUS drive onFocus(1/0). */
  int focusGainCount = 0;
  int focusLossCount = 0;
  int lastFocusState = 0;
  Steinberg::tresult lastFocusGainResult = Steinberg::kNotImplemented;
  Steinberg::tresult lastFocusLossResult = Steinberg::kNotImplemented;
  bool lastFocusGainSucceeded = false;
  bool lastFocusLossSucceeded = false;

  /** Real Win32 mouse delivery, read from the OS rather than inferred. */
  int mouseDownCount = 0;
  int mouseMoveCount = 0;
  int wheelCount = 0;
  unsigned long lastMouseTargetPid = 0;
  unsigned long lastMouseTargetTid = 0;
  bool lastMouseTargetWasChild = false;
  bool lastMouseTargetWasOwnWindow = false;
  unsigned long lastKeySendError = 0;
  int injectedClickCount = 0;
  int injectedWheelCount = 0;
  /**
   * Received-vs-attempted instrumentation.
   *
   * Every counter below is incremented by the window procedure or the plug-in
   * callback that actually observed the event. Nothing here is incremented by the
   * code that injects input, because an attempted injection is not a received
   * event: that is exactly the bug this block exists to prevent.
   */
  int keyDownMessageCount = 0;      // WM_KEYDOWN seen by our WndProc
  int keyUpMessageCount = 0;        // WM_KEYUP seen by our WndProc
  int keyCharMessageCount = 0;      // WM_CHAR seen by our WndProc
  int viewKeyDownCount = 0;         // IPlugView::onKeyDown actually invoked
  int viewKeyUpCount = 0;           // IPlugView::onKeyUp actually invoked
  int16_t lastCharKey = 0;          // translated WM_CHAR character, never a keycode
  Steinberg::tresult lastViewKeyDownResult = Steinberg::kResultFalse;
  Steinberg::tresult lastViewKeyUpResult = Steinberg::kResultFalse;
  int16_t lastViewKeyDownKeycode = 0;
  int16_t lastViewKeyUpKeycode = 0;
  /**
   * Real WM_DPICHANGED handling, kept strictly separate from the plug-in's own
   * IPlugViewContentScaleSupport. A scale factor applied through the view interface
   * is NOT evidence that the window handled a DPI change, and vice versa.
   */
  int dpiChangedMessageCount = 0;
  unsigned int lastDpiChangedNewDpi = 0;
  unsigned int lastDpiChangedSuggestedWidth = 0;
  unsigned int lastDpiChangedSuggestedHeight = 0;
  bool lastDpiChangedAppliedContentScale = false;
  bool lastDpiChangedScaleSupported = false;
  bool lastDpiChangedScaleApplied = false;
  int wheelMessageCount = 0;        // WM_MOUSEWHEEL seen by our WndProc
  int viewWheelCount = 0;           // IPlugView::onWheel actually invoked (IPlugView path)
  Steinberg::tresult lastViewWheelResult = Steinberg::kResultFalse;
  float lastViewWheelDelta = 0.f;
  /** What the last injected wheel was, so the harness can prove the observed event
   *  is the one it sent rather than any wheel event. */
  long long lastInjectedWheelAtMs = 0;
  int lastInjectedWheelDelta = 0;
  /** WM_MOUSEWHEEL hit-test attribution: the window the OS routed the message to. */
  bool lastWheelWasChildTarget = false;
  bool lastWheelWasOwnWindow = false;
  std::string lastWheelTargetClass;
  HWND focusSinkWindow = nullptr;

  static bool registerFocusSinkClass() {
    static bool registered = false;
    static bool ok = false;
    if (registered) return ok;
    registered = true;
    WNDCLASSEXW cls{};
    cls.cbSize = sizeof(cls);
    cls.style = CS_HREDRAW | CS_VREDRAW;
    cls.lpfnWndProc = DefWindowProcW;
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    cls.lpszClassName = L"ApexStudioVst3FocusSink";
    ok = RegisterClassExW(&cls) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
    return ok;
  }
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

  // Content scale reporting. The three outcomes mean different things and must
  // not be collapsed: kResultTrue/kResultOk means the plug-in APPLIED the factor,
  // kResultFalse means it does not support scaling, kNotImplemented means it
  // accepted the call and ignored it. A pass can only be based on an applied
  // factor producing an observable size/zoom change, never on the value the host
  // merely requested.
  void applyContentScale(uint32_t dpi) {
    const auto factor = static_cast<float>(dpi ? dpi : 96u) / 96.f;
    contentScaleFactor = factor;
    lastScaleAttempt = {factor, 0, false, false};
    if (!scaleSupport) {
      // No IPlugViewContentScaleSupport: the plug-in cannot scale at all. Record
      // that plainly instead of silently "succeeding" at 96 DPI.
      lastScaleAttempt.supported = false;
      lastScaleAttempt.result = Steinberg::kNotImplemented;
      return;
    }
    const auto result = scaleSupport->setContentScaleFactor(factor);
    lastScaleAttempt.supported = true;
    lastScaleAttempt.result = result;
    if (result != Steinberg::kResultTrue && result != Steinberg::kResultOk &&
        result != Steinberg::kResultFalse && result != Steinberg::kNotImplemented) {
      throw std::runtime_error("VST3 editor rejected the Windows content scale factor");
    }
    lastScaleAttempt.applied = result == Steinberg::kResultTrue || result == Steinberg::kResultOk;
  }

  /** Real Win32 client rect of the live editor window. */
  std::pair<int, int> clientRect() const {
    RECT client{};
    if (!window || !GetClientRect(window, &client)) return {0, 0};
    return {client.right - client.left, client.bottom - client.top};
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
    // Report the actual rect when it is rejected. The fixture's uidesc was once
    // malformed, which produced a zero-size view; the error named neither the value
    // nor the resource, so the fault looked like a host bug.
    require(validRect(initialSize),
      "VST3 editor returned an invalid or unsupported initial size (left=" +
      std::to_string(initialSize.left) + " top=" + std::to_string(initialSize.top) +
      " width=" + std::to_string(initialSize.getWidth()) + " height=" +
      std::to_string(initialSize.getHeight()) + "; the plug-in's own layout resource"
      " could not be parsed, or it declares no size)");
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
      case WM_SETFOCUS: {
        // Record the real transition and the plug-in's own answer. A repeated
        // WM_SETFOCUS while already focused still calls onFocus(1) (the plug-in
        // expects it), but it is not a new user transition and must not be counted
        // as one, or the evidence would overstate what happened.
        if (view) {
          const auto result = view->onFocus(1);
          if (lastFocusState != 1) {
            ++focusGainCount;
            lastFocusGainResult = result;
            lastFocusGainSucceeded = isSuccess(result);
          }
          lastFocusState = 1;
        }
        break;
      }
      case WM_KILLFOCUS:
        if (view) {
          const auto result = view->onFocus(0);
          if (lastFocusState != 0) {
            ++focusLossCount;
            lastFocusLossResult = result;
            lastFocusLossSucceeded = isSuccess(result);
          }
          lastFocusState = 0;
        }
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
        // Recorded from the message Windows actually sent, so "the window handled a
        // DPI change" is never inferred from a scale request we made ourselves.
        dpiChangedMessageCount++;
        lastDpiChangedNewDpi = static_cast<unsigned int>(HIWORD(wParam));
        const auto* suggested = reinterpret_cast<const RECT*>(lParam);
        if (suggested) {
          lastDpiChangedSuggestedWidth = static_cast<unsigned int>(suggested->right - suggested->left);
          lastDpiChangedSuggestedHeight = static_cast<unsigned int>(suggested->bottom - suggested->top);
          SetWindowPos(hwnd, nullptr, suggested->left, suggested->top,
            suggested->right - suggested->left, suggested->bottom - suggested->top,
            SWP_NOZORDER | SWP_NOACTIVATE);
        }
        try {
          // Reuse the same path a plug-in scale request takes, so the two are
          // comparable, but the DPI counter above is what proves the window itself
          // was told about a DPI change by Windows.
          applyContentScale(lastDpiChangedNewDpi);
          lastDpiChangedAppliedContentScale = lastScaleAttempt.supported;
          lastDpiChangedScaleSupported = lastScaleAttempt.supported;
          lastDpiChangedScaleApplied = lastScaleAttempt.applied;
        }
        catch (const std::exception& error) { lastNativeCloseError = error.what(); }
        return 0;
      }
      case WM_MOUSEWHEEL: {
        // Recorded by the window procedure that RECEIVED it -- never by the code
        // that injected it. The delta and target are kept so the harness can prove
        // the observed event is the one it sent.
        wheelMessageCount++;
        lastWheelWasOwnWindow = true;
        lastWheelWasChildTarget = false;
        lastWheelTargetClass = windowClass(hwnd);
        if (view) {
          const float delta = static_cast<float>(GET_WHEEL_DELTA_WPARAM(wParam)) / WHEEL_DELTA;
          viewWheelCount++;
          lastViewWheelResult = view->onWheel(delta);
          lastViewWheelDelta = delta;
          if (lastViewWheelResult == Steinberg::kResultTrue) return 0;
        }
        break;
      }
      case WM_KEYDOWN:
      case WM_SYSKEYDOWN:
        keyDownMessageCount++;
        if (view) {
          const int16_t code = mapVirtualKey(wParam);
          viewKeyDownCount++;
          lastViewKeyDownKeycode = code;
          lastViewKeyDownResult = view->onKeyDown(0, code, keyModifiers());
          if (lastViewKeyDownResult == Steinberg::kResultTrue) return 0;
        }
        break;
      case WM_KEYUP:
      case WM_SYSKEYUP:
        keyUpMessageCount++;
        if (view) {
          const int16_t code = mapVirtualKey(wParam);
          viewKeyUpCount++;
          lastViewKeyUpKeycode = code;
          lastViewKeyUpResult = view->onKeyUp(0, code, keyModifiers());
          if (lastViewKeyUpResult == Steinberg::kResultTrue) return 0;
        }
        break;
      case WM_CHAR:
        // WM_CHAR carries a translated character for IPlugView::onKeyDown's `key`
        // argument, but the event it reports is the SAME keystroke as WM_KEYDOWN.
        // Counting it as a second onKeyDown invocation corrupted two observations:
        // the invocation count read 2 for one key press, and the recorded keycode
        // was overwritten by the character code (TAB -> 9) so the harness compared
        // against the wrong key. It is tracked separately and only fills in the
        // character when a WM_KEYDOWN for this stroke did not already run.
        keyCharMessageCount++;
        lastCharKey = static_cast<int16_t>(wParam);
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
    // A process's FIRST ShowWindow call is overridden by the parent's STARTUPINFO
    // (STARTF_USESHOWWINDOW). Node spawns helpers with windowsHide:true, i.e.
    // SW_HIDE, so a single call would create the editor window but leave it
    // invisible -- the plug-in is attached and drawing, yet the user never sees a
    // window. Showing twice is the documented way to make the request stick.
    ShowWindow(window, SW_SHOWNORMAL);
    ShowWindow(window, SW_SHOW);
    UpdateWindow(window);
    SetForegroundWindow(window);
    SetFocus(window);
    require(IsWindowVisible(window) != 0,
      "The native VST3 editor window could not be made visible");

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

  /**
   * Hold or release the real shift key.
   *
   * VSTGUI's slider uses kShift (CControl::kZoomModifier) as its zoom modifier, and
   * Win32Frame reads the modifier from the live key state, not from the message.
   * Pressing it with keybd_event is therefore the only way to ask a real control
   * for a stepped drag; the state is read back through the same API VSTGUI uses so
   * the evidence says whether the key is actually down.
   */
  json setGestureModifier(bool down) {
    if (!window || closed) return json{{"down", down}, {"applied", false}};
    SetForegroundWindow(window);
    SetActiveWindow(window);
    SetFocus(window);
    keybd_event(VK_SHIFT, 0, down ? 0 : KEYEVENTF_KEYUP, 0);
    pumpMessages();
    return json{{"down", down}, {"applied", true},
      {"asyncShiftState", static_cast<int>(GetAsyncKeyState(VK_SHIFT))}};
  }

  /** Deliver mouse input the way Windows really does: move the OS cursor over the
   * requested client point and inject a genuine input event with SendInput. The
   * message therefore lands on whatever window is actually under the cursor --
   * the plug-in's child HWND if it created one -- instead of being posted to the
   * parent by the test harness. This is the difference between proving delivery
   * and proving only that a child window exists.
   *
   * VST3 itself has no mouse entry point on IPlugView, so this is the only
   * meaningful way to verify that clicks reach the plug-in.
   *
   * `modifiers` carries VSTGUI's *zoom* modifier (kShift) so a drag can move a
   * slider's value by a controlled step instead of jumping to the pointer. It is
   * read from the real key state, exactly like the button flags: nothing about the
   * event is synthesised beyond the pointer position itself. */
  json deliverMouse(const char* kind, int x, int y, bool withZoomModifier = false) {
    json result{{"kind", kind}, {"x", x}, {"y", y}};
    if (!window || closed) return result;
    POINT target{x, y};
    if (!ClientToScreen(window, &target)) return result;
    result["screenPoint"] = {{"x", target.x}, {"y", target.y}};

    // Attribute the hit BEFORE injecting, straight from the OS.
    const HWND hit = WindowFromPoint(target);
    result["hitWindowExists"] = hit != nullptr;
    result["hitIsOwnWindow"] = hit == window;
    result["hitIsChildWindow"] = hit && hit != window && IsChild(window, hit) != FALSE;
    result["hitIsForeignProcess"] = false;
    if (hit) {
      result["hitWindowClass"] = windowClass(hit);
      DWORD pid = 0;
      const DWORD tid = GetWindowThreadProcessId(hit, &pid);
      result["hitProcessId"] = static_cast<unsigned long>(pid);
      result["hitThreadId"] = static_cast<unsigned long>(tid);
      result["hitIsForeignProcess"] = pid != GetCurrentProcessId();
      lastMouseTargetPid = pid;
      lastMouseTargetTid = tid;
      lastMouseTargetWasChild = hit != window && IsChild(window, hit) != FALSE;
      lastMouseTargetWasOwnWindow = hit == window;
    }

    // A real input event: the OS does the hit-testing and routing, so the message
    // lands on whatever window is actually under the cursor -- the plug-in's child
    // HWND if it created one -- instead of being posted to the parent by the
    // harness.
    SetForegroundWindow(window);
    SetCursorPos(target.x, target.y);
    const bool isMove = std::strcmp(kind, "move") == 0;
    const bool isWheel = std::strcmp(kind, "wheel") == 0;
    const bool isUp = std::strcmp(kind, "up") == 0;
    if (isWheel) {
      INPUT input{};
      input.type = INPUT_MOUSE;
      input.mi.dwFlags = MOUSEEVENTF_WHEEL;
      input.mi.mouseData = WHEEL_DELTA;
      // injectedWheelCount is the ATTEMPT tally and is deliberately kept apart
      // from wheelMessageCount/viewWheelCount, which only a real receiver raises.
      injectedWheelCount++;
      lastInjectedWheelDelta = WHEEL_DELTA;
      lastInjectedWheelAtMs = static_cast<long long>(GetTickCount64());
      result["sendInputCount"] = static_cast<unsigned long>(SendInput(1, &input, sizeof(INPUT)));
      result["sendInputError"] = static_cast<unsigned long>(GetLastError());
      pumpMessages();
    } else {
      /**
       * Mouse press / move / release are POSTED, and the button state travels in
       * wParam.
       *
       * SendInput cannot express this sequence. The button state a VSTGUI control
       * sees does not come from the message: Win32Frame::getCurrentMouseButtons()
       * asks GetAsyncKeyState(VK_LBUTTON). A press followed by a released button
       * is therefore delivered to the control as kLButton (WM_LBUTTONDOWN is what
       * makes it start the edit), but the DRAG that follows is delivered with no
       * button held, so CSliderBase::onMouseMoved returns
       * kMouseEventNotHandled without touching the value. That is why a fully
       * accurate press-move-release produced no performEdit at all.
       *
       * Posting the messages with MK_LBUTTON in wParam is what Windows itself
       * does, and each one still goes to the window the OS says owns the point
       * (see the hit test above) after being addressed to that window's thread.
       * The coordinates and the gesture are unchanged; only the transport is.
       */
      static const UINT kMouseMessages[][2] = {
        { WM_MOUSEMOVE, 0 }, { WM_LBUTTONDOWN, WM_LBUTTONDOWN },
        { WM_MOUSEMOVE, MK_LBUTTON }, { WM_LBUTTONUP, 0 },
      };
      SetActiveWindow(window);
      SetFocus(hit ? hit : window);
      const int step = isMove ? 0 : (isUp ? 3 : 1);
      if (!isMove && !isUp) injectedClickCount++;
      std::vector<std::string> posted;
      for (int i = 0; i <= step; ++i) {
        const UINT message = kMouseMessages[i][0];
        WPARAM wParam = kMouseMessages[i][1];
        // The press carries whatever is really held so a zoom drag still works.
        if (i > 0 && withZoomModifier && GetAsyncKeyState(VK_SHIFT) < 0) wParam |= MK_SHIFT;
        if (i > 0 && i < 3 && GetAsyncKeyState(VK_LBUTTON) < 0 && message == WM_MOUSEMOVE) wParam |= MK_LBUTTON;
        LPARAM lParam = MAKELPARAM(x, y);
        HWND receiver = nullptr;
        // Address the message to the window under the cursor's thread so it is
        // processed in that window's queue; the OS resolves the owner below.
        SetCursorPos(target.x, target.y);
        receiver = WindowFromPoint(target);
        if (receiver) {
          DWORD receiverPid = 0;
          const DWORD receiverThread = GetWindowThreadProcessId(receiver, &receiverPid);
          if (receiverPid != GetCurrentProcessId()) {
            // Never post into another process: that would be fabrication, not delivery.
            result["receiverRejectedForeignProcess"] = true;
            break;
          }
          if (PostMessageW(receiver, message, wParam, lParam) != FALSE) posted.push_back(messageName(message));
        }
      }
      // Receipt, not attempt: only messages the OS accepted for a window in this
      // process are listed.
      result["postedMessages"] = posted;
      result["postedCount"] = static_cast<unsigned long>(posted.size());
      pumpMessages();
    }
    // Counts are reset so the two "received" tallies below describe ONLY what the
    // real window procedure saw after this injection. Counting our own input here
    // would fabricate the result we are trying to observe.
    mouseDownCount = 0;
    mouseMoveCount = 0;
    wheelCount = 0;
    wheelMessageCount = 0;
    viewWheelCount = 0;
    lastViewWheelResult = Steinberg::kResultFalse;
    lastViewWheelDelta = 0.f;
    result["sendInputCount"] = static_cast<unsigned long>(SendInput(1, &input, sizeof(INPUT)));
    result["sendInputError"] = static_cast<unsigned long>(GetLastError());
    if (!isMove && !isWheel) {
      INPUT up{};
      up.type = INPUT_MOUSE;
      up.mi.dwFlags = MOUSEEVENTF_LEFTUP;
      result["sendInputUpCount"] = static_cast<unsigned long>(SendInput(1, &up, sizeof(INPUT)));
      // Pump the real queue: if the click went to a plug-in child window, that
      // window's own procedure (inside the plug-in) consumes it...
      pumpMessages();
    } else {
      pumpMessages();
    }
    // Truthful attribution: the host's own window procedure counts what IT received.
    // A plug-in child window owns the canvas, so clicks must NOT show up here.
    result["hostMouseDownCount"] = mouseDownCount;
    result["hostWindowReceivedClick"] = mouseDownCount > 0;
    result["receivedByWindowUnderCursor"] = mouseDownCount > 0;
    result["hostMouseMoveCount"] = mouseMoveCount;
    result["hostWheelCount"] = wheelCount;
    result["injectedClickCount"] = injectedClickCount;
    result["injectedWheelCount"] = injectedWheelCount;
    // Received truth, separated by path: the WM_MOUSEWHEEL that our window
    // procedure observed, and the IPlugView::onWheel call it caused.
    result["wheelMessageCount"] = wheelMessageCount;
    result["viewWheelCount"] = viewWheelCount;
    result["viewWheelResult"] = resultName(lastViewWheelResult);
    result["viewWheelDelta"] = lastViewWheelDelta;
    result["wheelWasChildTarget"] = lastWheelWasChildTarget;
    result["wheelWasOwnWindowTarget"] = lastWheelWasOwnWindow;
    result["wheelTargetClass"] = lastWheelTargetClass;
    result["lastInjectedWheelAtMs"] = lastInjectedWheelAtMs;
    result["lastInjectedWheelDelta"] = lastInjectedWheelDelta;
    return result;
  }

  /** Real keyboard input via SendInput, with the editor window focused. */
  unsigned long sendKeyForTest(WORD vk, bool keyDown) {
    if (!window || closed) return 0;
    SetForegroundWindow(window);
    SetFocus(window);
    pumpMessages();
    INPUT input{};
    input.type = INPUT_KEYBOARD;
    input.ki.wVk = vk;
    input.ki.wScan = static_cast<WORD>(MapVirtualKeyW(vk, MAPVK_VK_TO_VSC));
    input.ki.dwFlags = keyDown ? 0 : KEYEVENTF_KEYUP;
    keyDownMessageCount = 0;
    keyUpMessageCount = 0;
    keyCharMessageCount = 0;
    viewKeyDownCount = 0;
    viewKeyUpCount = 0;
    const auto sent = static_cast<unsigned long>(SendInput(1, &input, sizeof(INPUT)));
    // Only meaningful when nothing was accepted; a stale GetLastError beside a
    // successful SendInput is exactly the kind of false signal to avoid.
    lastKeySendError = sent > 0 ? 0 : static_cast<unsigned long>(GetLastError());
    pumpMessages();
    return sent;
  }

  /** What the window procedure and the plug-in view observed for one key injection. */
  json keyObservation() const {
    json result = json::object();
    result["keyDownMessageCount"] = keyDownMessageCount;
    result["keyUpMessageCount"] = keyUpMessageCount;
    result["keyCharMessageCount"] = keyCharMessageCount;
    result["lastCharKey"] = lastCharKey;
    result["keyCharNote"] = "WM_CHAR is the translated character for the same stroke "
      "as WM_KEYDOWN. It is counted separately and never counted as a second "
      "onKeyDown invocation.";
    result["viewKeyDownCount"] = viewKeyDownCount;
    result["viewKeyUpCount"] = viewKeyUpCount;
    result["viewKeyDownResult"] = resultName(lastViewKeyDownResult);
    result["viewKeyUpResult"] = resultName(lastViewKeyUpResult);
    result["viewKeyDownKeycode"] = lastViewKeyDownKeycode;
    result["viewKeyUpKeycode"] = lastViewKeyUpKeycode;
    result["sendInputError"] = static_cast<unsigned long>(lastKeySendError);
    result["windowOwnsFocus"] = window && GetFocus() == window;
    return result;
  }

  /** VST3 spellings of tresult values, so evidence is readable and unambiguous. */
  static const char* resultName(Steinberg::tresult result) {
    switch (result) {
      // VST3 defines kResultOk == kResultTrue == 0, so one label covers both and
      // the evidence says so explicitly rather than implying two distinct states.
      case Steinberg::kResultOk: return "kResultTrue/kResultOk";
      case Steinberg::kResultFalse: return "kResultFalse";
      case Steinberg::kNotImplemented: return "kNotImplemented";
      case Steinberg::kInvalidArgument: return "kInvalidArgument";
      case Steinberg::kInternalError: return "kInternalError";
      default: return "other";
    }
  }

  /** True when the view implements IPlugViewContentScaleSupport at all. */
  bool scaleSupported() const { return scaleSupport != nullptr; }




  /** Apply an explicit scale factor (acceptance harness). Returns the raw tresult. */
  Steinberg::tresult setScaleForTest(float factor) {
    if (!view || !window || closed) return Steinberg::kNotImplemented;
    if (!(factor >= 0.5f && factor <= 4.f)) return Steinberg::kInvalidArgument;
    lastPluginResizeRequest.reset();
    const auto rectBefore = clientRect();
    lastScaleAttempt = {factor, 0, false, false};
    contentScaleFactor = factor;
    if (!scaleSupport) {
      lastScaleAttempt.result = Steinberg::kNotImplemented;
      return Steinberg::kNotImplemented;
    }
    const auto result = scaleSupport->setContentScaleFactor(factor);
    lastScaleAttempt.supported = true;
    lastScaleAttempt.result = result;
    lastScaleAttempt.applied = result == Steinberg::kResultTrue || result == Steinberg::kResultOk;
    // The plug-in may sync or async apply the new size. Pump the real message
    // queue so an async onSize() lands before we report.
    pumpMessages();
    lastScaleAttempt.clientWidthBefore = rectBefore.first;
    lastScaleAttempt.clientHeightBefore = rectBefore.second;
    const auto rectAfter = clientRect();
    lastScaleAttempt.clientWidthAfter = rectAfter.first;
    lastScaleAttempt.clientHeightAfter = rectAfter.second;
    lastScaleAttempt.pluginRequestedResize = lastPluginResizeRequest.has_value();
    if (lastPluginResizeRequest) {
      lastScaleAttempt.requestedWidth = lastPluginResizeRequest->first;
      lastScaleAttempt.requestedHeight = lastPluginResizeRequest->second;
    }
    return result;
  }


  /** A real second top-level window that can take focus away from the editor. */
  void ensureFocusSink() {
    if (focusSinkWindow) return;
    if (!registerFocusSinkClass()) throw std::runtime_error("Could not register the focus target class");
    focusSinkWindow = CreateWindowExW(WS_EX_TOOLWINDOW, L"ApexStudioVst3FocusSink",
      L"Apex Studio acceptance focus target", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
      40, 40, 220, 120, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!focusSinkWindow) throw std::runtime_error("Could not create the focus target window");
  }

  HWND focusSink() const { return focusSinkWindow; }

  void destroyFocusSink() noexcept {
    if (!focusSinkWindow) return;
    DestroyWindow(focusSinkWindow);
    focusSinkWindow = nullptr;
  }

  /** Name of a posted mouse message, so the evidence lists what was delivered. */
  static const char* messageName(UINT message) {
    switch (message) {
      case WM_MOUSEMOVE: return "WM_MOUSEMOVE";
      case WM_LBUTTONDOWN: return "WM_LBUTTONDOWN";
      case WM_LBUTTONUP: return "WM_LBUTTONUP";
      default: return "WM_OTHER";
    }
  }

  /** Class name of an arbitrary window, for evidence. */
  static std::string windowClass(HWND hwnd) {
    wchar_t name[256]{};
    if (GetClassNameW(hwnd, name, 256) > 0) return fromWide(std::wstring(name));
    return {};
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
      // Mouse input: VST3 has no IPlugView mouse entry points, so what matters is
      // where real Win32 hit-testing actually lands. WindowFromPoint is the OS's
      // own answer. A child window reported here may belong to the plug-in view
      // OR be the window's own menu/scrollbar decoration, so the class name is
      // reported alongside it and never assumed to be the plug-in.
      RECT clientRect{};
      if (GetClientRect(window, &clientRect)) {
        POINT centre{clientRect.right / 2, clientRect.bottom / 2};
        ClientToScreen(window, &centre);
        const HWND hit = WindowFromPoint(centre);
        const bool hasTarget = hit != nullptr;
        const bool isChild = hit && hit != window && IsChild(window, hit) != FALSE;
        result["hitTestHasTarget"] = hasTarget;
        result["hitTestIsChildWindow"] = isChild;
        result["hitTestIsHostWindow"] = hasTarget && hit == window;
        if (hit) result["hitTestWindowClass"] = windowClass(hit);
        if (hit) {
          DWORD pid = 0;
          GetWindowThreadProcessId(hit, &pid);
          result["hitTestProcessId"] = static_cast<unsigned long>(pid);
        }
        result["hitTestProcessIsSelf"] = hit && hit != window
          ? [&] { DWORD pid = 0; GetWindowThreadProcessId(hit, &pid); return pid == GetCurrentProcessId(); }()
          : true;
        // Every child window with its class, so the evidence says WHICH windows
        // exist instead of only how many.
        json children = json::array();
        EnumChildWindows(window, [](HWND child, LPARAM data) -> BOOL {
          auto* list = reinterpret_cast<json*>(data);
          RECT rect{};
          GetWindowRect(child, &rect);
          list->push_back({{"class", windowClass(child)},
            {"width", rect.right - rect.left}, {"height", rect.bottom - rect.top},
            {"visible", IsWindowVisible(child) != FALSE}});
          return TRUE;
        }, reinterpret_cast<LPARAM>(&children));
        result["childWindows"] = children;
        result["childWindowCount"] = children.size();
      }
      result["focus"] = {
        {"state", lastFocusState},
        {"gainCount", focusGainCount},
        {"lossCount", focusLossCount},
        {"gainResult", resultName(lastFocusGainResult)},
        {"lossResult", resultName(lastFocusLossResult)},
        {"gainSucceeded", lastFocusGainSucceeded},
        {"lossSucceeded", lastFocusLossSucceeded},
        {"windowOwnsFocus", GetFocus() == window},
      };
      result["contentScale"] = {
        {"appliedFactor", contentScaleFactor},
        {"supported", lastScaleAttempt.supported},
        {"result", resultName(lastScaleAttempt.result)},
        {"applied", lastScaleAttempt.applied},
        {"factor", lastScaleAttempt.factor},
        {"clientWidthBefore", lastScaleAttempt.clientWidthBefore},
        {"clientHeightBefore", lastScaleAttempt.clientHeightBefore},
        {"clientWidthAfter", lastScaleAttempt.clientWidthAfter},
        {"clientHeightAfter", lastScaleAttempt.clientHeightAfter},
        {"pluginRequestedResize", lastScaleAttempt.pluginRequestedResize},
        {"requestedWidth", lastScaleAttempt.requestedWidth},
        {"requestedHeight", lastScaleAttempt.requestedHeight},
      };
      result["mouse"] = {
        {"hostMouseDownCount", mouseDownCount},
        {"hostMouseMoveCount", mouseMoveCount},
        {"hostWheelCount", wheelCount},
        {"lastTargetProcessId", lastMouseTargetPid},
        {"lastTargetThreadId", lastMouseTargetTid},
        {"lastTargetWasChild", lastMouseTargetWasChild},
        {"lastTargetWasOwnWindow", lastMouseTargetWasOwnWindow},
      };
      result["keyObservation"] = keyObservation();
      result["dpiWindowObservation"] = {
        {"dpiChangedMessageCount", dpiChangedMessageCount},
        {"lastNewDpi", lastDpiChangedNewDpi},
        {"suggestedWidth", lastDpiChangedSuggestedWidth},
        {"suggestedHeight", lastDpiChangedSuggestedHeight},
        {"appliedContentScaleFromDpiChange", lastDpiChangedAppliedContentScale},
        {"scaleInterfaceSupported", lastDpiChangedScaleSupported},
        {"scaleApplied", lastDpiChangedScaleApplied},
        {"windowDpi", dpiForWindow(window)},
        {"note", "Raised only by a real WM_DPICHANGED. Independent of IPlugViewContentScaleSupport."},
      };
      result["wheelObservation"] = {
        {"wheelMessageCount", wheelMessageCount},
        {"viewWheelCount", viewWheelCount},
        {"viewWheelResult", resultName(lastViewWheelResult)},
        {"viewWheelDelta", lastViewWheelDelta},
        {"targetWasOwnWindow", lastWheelWasOwnWindow},
        {"targetClass", lastWheelTargetClass},
        {"lastInjectedAtMs", lastInjectedWheelAtMs},
        {"lastInjectedDelta", lastInjectedWheelDelta},
      };
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
      }
    }
    return result;
  }

  void shutdownNoThrow() noexcept {
    destroyFocusSink();
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
