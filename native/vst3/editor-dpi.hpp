// DPI sizing decisions for the native VST3 editor window.
//
// This header is deliberately free of Win32 and VST3 types so the decisions can be
// unit-tested on every platform (see editor-dpi-test.cpp). editor-host.hpp supplies
// the observed facts and carries out the plan against the real HWND.
//
// The rules encode what a Windows per-monitor-v2 VST3 host has to get right:
//
//   * The plug-in owns its editor size. On a DPI change the host tells the plug-in
//     the new scale FIRST; a scale-aware plug-in then asks for its new size through
//     IPlugFrame::resizeView, and that size wins.
//   * Windows' suggested rectangle scales the old client area linearly. Applying it
//     before the plug-in has been told the scale makes the plug-in see a "resize" at
//     the OLD scale, and the later scale call then multiplies an already enlarged
//     view a second time. The suggested size is therefore only a fallback for a
//     resizable plug-in that accepted the scale but left sizing to the host.
//   * A plug-in that does not scale keeps its own pixel size. Stretching the window
//     around it would only add blank area.
//   * The window frame is a property of the window's DPI, not of the DPI the process
//     started at, so the outer size is always derived from the client size and the
//     frame measured for the current DPI.
#pragma once

#include <algorithm>
#include <cmath>

namespace ApexVst3Host {
namespace dpi {

constexpr unsigned kDefaultDpi = 96;
constexpr int kMinClient = 32;
constexpr int kMaxClient = 8192;

struct Size {
  int width = 0;
  int height = 0;
  bool operator==(const Size& other) const { return width == other.width && height == other.height; }
  bool operator!=(const Size& other) const { return !(*this == other); }
};

inline bool validClient(const Size& size) {
  return size.width >= kMinClient && size.height >= kMinClient &&
         size.width <= kMaxClient && size.height <= kMaxClient;
}

/** VST3 content scale factor for a Windows DPI value (96 DPI == 1.0). */
inline float scaleFactorForDpi(unsigned dpi) {
  return static_cast<float>(dpi ? dpi : kDefaultDpi) / static_cast<float>(kDefaultDpi);
}

/** Non-client extents of a window: how much larger the outer rect is than the client. */
struct Frame {
  int width = 0;
  int height = 0;
};

inline Size outerForClient(const Size& client, const Frame& frame) {
  return {client.width + frame.width, client.height + frame.height};
}

inline Size clientForOuter(const Size& outer, const Frame& frame) {
  return {std::max(0, outer.width - frame.width), std::max(0, outer.height - frame.height)};
}

/** Linear rescale of a client size between two DPI values (Windows' own rule). */
inline Size rescaleClient(const Size& client, unsigned fromDpi, unsigned toDpi) {
  const double from = fromDpi ? fromDpi : kDefaultDpi;
  const double to = toDpi ? toDpi : kDefaultDpi;
  return {static_cast<int>(std::lround(client.width * to / from)),
          static_cast<int>(std::lround(client.height * to / from))};
}

enum class ClientSource {
  /** The plug-in asked for this size through IPlugFrame::resizeView. */
  PluginRequested,
  /** The plug-in reports this size itself (it did not ask the host to resize). */
  PluginReported,
  /** The plug-in accepted the scale and is resizable; the host proposes Windows' size. */
  HostProposed,
  /** Nothing better is known; the client area is left as it was. */
  Unchanged,
};

inline const char* clientSourceName(ClientSource source) {
  switch (source) {
    case ClientSource::PluginRequested: return "plugin-requested";
    case ClientSource::PluginReported: return "plugin-reported";
    case ClientSource::HostProposed: return "host-proposed";
    case ClientSource::Unchanged: return "unchanged";
  }
  return "unknown";
}

/** Everything observed after the plug-in has been told the new scale. */
struct ScaleOutcome {
  Size clientBefore;               // real client area before the scale was applied
  Size hostProposal;               // client area the host would choose (Windows' suggestion)
  bool hostProposalValid = false;
  bool scaleSupported = false;     // IPlugViewContentScaleSupport is implemented
  bool scaleApplied = false;       // setContentScaleFactor returned kResultTrue/kResultOk
  bool pluginResized = false;      // the plug-in called resizeView and accepted the size
  Size pluginRequested;            // the size it asked for
  bool pluginSizeKnown = false;    // IPlugView::getSize succeeded with a usable size
  Size pluginSize;                 // what IPlugView::getSize reports now
  bool resizable = false;          // IPlugView::canResize
};

struct ClientPlan {
  Size client;
  ClientSource source = ClientSource::Unchanged;
  /** True when the host chose the size, so the plug-in must be told with onSize. */
  bool notifyPlugin = false;
  /** True when a host-proposed size must first go through checkSizeConstraint. */
  bool constrain = false;
};

/**
 * Decide the editor's client size after a scale change (window DPI change, or the
 * first scale applied at open).
 */
inline ClientPlan planClientAfterScale(const ScaleOutcome& outcome) {
  ClientPlan plan;
  if (outcome.pluginResized && validClient(outcome.pluginRequested)) {
    // The plug-in sized itself and already saw onSize from resizeView.
    plan.client = outcome.pluginRequested;
    plan.source = ClientSource::PluginRequested;
    return plan;
  }
  if (outcome.scaleSupported && outcome.scaleApplied && outcome.resizable &&
      outcome.hostProposalValid && validClient(outcome.hostProposal) &&
      !(outcome.pluginSizeKnown && outcome.pluginSize != outcome.clientBefore)) {
    // It took the scale, can be resized, and neither asked for a size nor changed
    // the size it reports: the host proposes one, subject to the plug-in's limits.
    plan.client = outcome.hostProposal;
    plan.source = ClientSource::HostProposed;
    plan.notifyPlugin = plan.client != outcome.clientBefore;
    plan.constrain = true;
    return plan;
  }
  if (outcome.pluginSizeKnown && validClient(outcome.pluginSize)) {
    // Not scale-aware, or fixed-size: the plug-in's own pixel size is the truth.
    plan.client = outcome.pluginSize;
    plan.source = ClientSource::PluginReported;
    plan.notifyPlugin = plan.client != outcome.clientBefore;
    return plan;
  }
  plan.client = outcome.clientBefore;
  plan.source = ClientSource::Unchanged;
  return plan;
}

/**
 * Min/max tracking for a fixed-size editor. While the host is applying a size the
 * plug-in itself asked for (or a DPI transition), the window must not be pinned to
 * the size the plug-in reported BEFORE that request, or the request is clamped away.
 */
inline bool shouldPinFixedSize(bool resizable, bool applyingPluginResize, bool applyingDpiChange,
                               bool fittingClient) {
  return !resizable && !applyingPluginResize && !applyingDpiChange && !fittingClient;
}

} // namespace dpi
} // namespace ApexVst3Host
