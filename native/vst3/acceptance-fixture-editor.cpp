// The genuine VSTGUI editor for ApexAcceptanceGain.
// See acceptance-fixture.hpp for provenance.
//
// This is the ONLY translation unit in the fixture that depends on VSTGUI. Keeping
// it separate means the processor, controller and their behavioural test build on a
// host without a GUI toolchain (headless Linux has no X11), while the Windows build
// links this file and gets a real editor.
//
// INSTRUMENTATION
// ---------------
// The packaged acceptance could not tell two very different failures apart:
//
//   C. the real CSlider receives the drag and its value never changes, or
//   D. its value changes and the edit lifecycle never calls
//      beginEdit / performEdit / endEdit.
//
// Nothing observable from outside the plug-in process distinguishes those, so the
// trace is taken here, inside the editor, on the real objects the user's mouse
// reaches. This class SUBCLASSES the shipping VST3Editor and forwards every call to
// it: the UI is still parsed from the same uidesc, the controls are still ordinary
// CControls, and the parameter path is the same one. Nothing is stubbed, replaced or
// called directly: the harness only reads the recorded trace afterwards.
//
// The trace records what happened, never what was expected, and is bounded so it can
// stay on unconditionally. The fixture is test-only and never staged into a build.
#include "acceptance-fixture-controller.hpp"

#if APEX_ACCEPTANCE_FIXTURE_HAS_VSTGUI

#include "vstgui/lib/cframe.h"
#include "vstgui/lib/controls/ccontrol.h"
#include "vstgui/lib/controls/cparamdisplay.h"
#include "vstgui/lib/controls/ctextedit.h"
#include "vstgui/lib/controls/cslider.h"
#include "vstgui/lib/cviewcontainer.h"
#include "vstgui/plugin-bindings/vst3editor.h"

#include <atomic>
#include <cstdlib>
#include <deque>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

namespace ApexAcceptanceGain {

namespace {

/**
 * The correlated trace of one gesture on the real editor.
 *
 * Entries are plain strings in the order they happened, so a single reproduction
 * reconstructs the whole gesture: which control the pointer reached, what its value
 * was at each phase, and whether the edit lifecycle ran and was accepted.
 */
class EditorTrace {
public:
  static EditorTrace& instance() {
    static EditorTrace trace;
    return trace;
  }

  void record(const std::string& line) {
    {
      std::lock_guard<std::mutex> guard(lock_);
      if (entries_.size() >= kMaxEntries) entries_.pop_front();
      entries_.push_back(line);
    }
    appendToSink(line);
  }

  /**
   * Mirror every entry to a file when the acceptance run asks for one.
   *
   * The editor lives inside the plug-in bundle, which the helper process loads and
   * the harness cannot call into. A file is the one channel that carries the
   * editor's own record of a gesture out of that process without adding a GUI
   * dependency to the host. Unset in every normal run, so nothing is written.
   */
  void appendToSink(const std::string& line) {
    const char* target = std::getenv("APEX_ACCEPTANCE_EDITOR_TRACE");
    if (!target || !*target) return;
    std::lock_guard<std::mutex> guard(sinkLock_);
    std::ofstream out(target, std::ios::app);
    if (out) out << line << '\n';
  }

  std::vector<std::string> snapshot() {
    std::lock_guard<std::mutex> guard(lock_);
    return std::vector<std::string>(entries_.begin(), entries_.end());
  }

  void clear() {
    std::lock_guard<std::mutex> guard(lock_);
    entries_.clear();
  }

  // Counters of the real lifecycle, so a test asserts on behaviour rather than on
  // the wording of a log line.
  std::atomic<int> mouseDownOnGainSlider{0};
  std::atomic<int> controlBeginEdit{0};
  std::atomic<int> controlEndEdit{0};
  std::atomic<int> valueChanged{0};
  std::atomic<int> controllerBeginEdit{0};
  std::atomic<int> controllerEndEdit{0};
  std::atomic<int> performEdit{0};

private:
  static constexpr size_t kMaxEntries = 600;
  std::mutex lock_;
  std::mutex sinkLock_;
  std::deque<std::string> entries_;
};

std::string formatFloat(float value) {
  std::ostringstream out;
  out << value;
  return out.str();
}

std::string formatDouble(double value) {
  std::ostringstream out;
  out << value;
  return out.str();
}

std::string escapeJson(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (char character : value) {
    if (character == '"' || character == '\\') {
      out.push_back('\\');
      out.push_back(character);
    } else if (character == '\n') {
      out += "\\n";
    } else {
      out.push_back(character);
    }
  }
  return out;
}

/** A control named by what it IS, not by a title: this VSTGUI has no class-name API. */
std::string describeControl(VSTGUI::CControl* control) {
  if (!control) return "none";
  std::ostringstream out;
  if (dynamic_cast<VSTGUI::CSlider*>(control)) out << "CSlider";
  else if (dynamic_cast<VSTGUI::CTextEdit*>(control)) out << "CTextEdit";
  else if (dynamic_cast<VSTGUI::CParamDisplay*>(control)) out << "CParamDisplay";
  else out << "otherCControl";
  out << " tag=" << control->getTag()
      << " value=" << formatFloat(control->getValue())
      << " normalized=" << formatFloat(control->getValueNormalized())
      << " editing=" << (control->isEditing() ? "true" : "false");
  return out.str();
}

/** The same description without assuming the caller has a CControl. */
std::string describeView(VSTGUI::CView* view) {
  if (!view) return "none";
  std::ostringstream out;
  if (auto* slider = dynamic_cast<VSTGUI::CSlider*>(view)) {
    out << "CSlider tag=" << slider->getTag()
        << " value=" << formatFloat(slider->getValue())
        << " editing=" << (slider->isEditing() ? "true" : "false");
  } else if (auto* control = dynamic_cast<VSTGUI::CControl*>(view)) {
    out << describeControl(control);
  } else if (dynamic_cast<VSTGUI::CViewContainer*>(view)) {
    out << "CViewContainer";
  } else {
    out << "otherCView";
  }
  out << " mouseEnabled=" << (view->getMouseEnabled() ? "true" : "false");
  auto size = view->getViewSize();
  out << " rect=" << size.left << "," << size.top << "," << size.right << "," << size.bottom;
  return out.str();
}

} // namespace

/**
 * The real editor, with the real control path, plus a trace.
 *
 * Every override forwards to VST3Editor and only observes. The base class already
 * registers itself as the frame's mouse observer in open(), so this subclass
 * receives the same callbacks without registering a second time -- a duplicate
 * registration would deliver every event twice.
 */
class TracedGainEditor final : public VSTGUI::VST3Editor {
public:
  TracedGainEditor(Steinberg::Vst::EditController* controller, VSTGUI::UTF8StringPtr viewName,
                   VSTGUI::UTF8StringPtr xmlFile)
    : VSTGUI::VST3Editor(controller, viewName, xmlFile) {}

  ~TracedGainEditor() override = default;

  /**
   * The binding facts, recorded the first time the frame can be inspected.
   *
   * Everything here is a prerequisite for any edit working at all: the real Gain
   * slider exists, it carries tag 0, its listener is this editor, and a
   * ParameterChangeListener was created for that tag. If any of these were false the
   * gesture could never become a performEdit, which is exactly case D -- so this is
   * measured rather than reasoned about.
   *
   * It runs on the first frame event because the view is built during attached(),
   * and a subclass cannot observe it from the constructor. Recording once keeps the
   * trace readable without losing the fact.
   */
  void recordBindingOnce() {
    if (bindingRecorded_) return;
    auto* frame = getFrame();
    if (!frame) return;
    bindingRecorded_ = true;
    auto* slider = findGainSlider(frame);
    std::ostringstream out;
    out << "editor:binding gainSliderPresent=" << (slider ? "true" : "false");
    if (slider) {
      out << " tag=" << slider->getTag()
          << " value=" << formatFloat(slider->getValue())
          << " normalized=" << formatFloat(slider->getValueNormalized())
          << " listenerIsEditor=" << (slider->getListener() == this ? "true" : "false")
          << " mouseEnabled=" << (slider->getMouseEnabled() ? "true" : "false")
          << " parameterListener=" << listenerState(slider);
      if (auto* controller = getController()) {
        if (auto* parameter = controller->getParameterObject(kParamGain)) {
          const auto& info = parameter->getInfo();
          out << " paramId=" << info.id
              << " readOnly=" << ((info.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) ? "true" : "false")
              << " automatable=" << ((info.flags & Steinberg::Vst::ParameterInfo::kCanAutomate) ? "true" : "false");
        } else {
          out << " paramObject=missing";
        }
        out << " controllerNormalized=" << controllerValue(kParamGain);
      }
    }
    EditorTrace::instance().record(out.str());
  }

  // ---- the real edit lifecycle -----------------------------------------------
  //
  // VST3Editor's beginEdit/endEdit are deliberately empty: the parameter lifecycle
  // is driven per control by controlBeginEdit/controlEndEdit. All four are traced
  // because only the per-control pair leads to beginEdit/performEdit/endEdit on the
  // component handler.
  void beginEdit(int32_t index) override {
    EditorTrace::instance().controllerBeginEdit++;
    EditorTrace::instance().record("frame:beginEdit index=" + std::to_string(index));
    VSTGUI::VST3Editor::beginEdit(index);
  }

  void endEdit(int32_t index) override {
    EditorTrace::instance().controllerEndEdit++;
    EditorTrace::instance().record("frame:endEdit index=" + std::to_string(index));
    VSTGUI::VST3Editor::endEdit(index);
  }

  void controlBeginEdit(VSTGUI::CControl* control) override {
    EditorTrace::instance().controlBeginEdit++;
    EditorTrace::instance().record("lifecycle:controlBeginEdit " + describeControl(control) +
      " parameterListener=" + listenerState(control));
    VSTGUI::VST3Editor::controlBeginEdit(control);
    EditorTrace::instance().record("lifecycle:afterControlBeginEdit hostBeginEditIndex=" +
      std::to_string(frameBeginEditCount()));
  }

  void controlEndEdit(VSTGUI::CControl* control) override {
    EditorTrace::instance().controlEndEdit++;
    EditorTrace::instance().record("lifecycle:controlEndEdit " + describeControl(control) +
      " parameterListener=" + listenerState(control));
    VSTGUI::VST3Editor::controlEndEdit(control);
    EditorTrace::instance().record("lifecycle:afterControlEndEdit controllerNormalized=" +
      controllerValue(control ? control->getTag() : -1));
  }

  /**
   * The moment a slider's changed value becomes a performEdit on the host.
   *
   * VST3Editor::valueChanged returns early unless the control isEditing() and a
   * ParameterChangeListener exists for its tag. Both conditions are recorded here,
   * before forwarding, so a silent no-op is visible instead of inferred.
   */
  void valueChanged(VSTGUI::CControl* control) override {
    EditorTrace::instance().valueChanged++;
    const int32_t tag = control ? control->getTag() : -1;
    const double before = controllerNormalized(tag);
    EditorTrace::instance().record("lifecycle:valueChanged pre " + describeControl(control) +
      " parameterListener=" + listenerState(control) +
      " controllerBefore=" + formatDouble(before));
    VSTGUI::VST3Editor::valueChanged(control);
    if (!control) return;
    const double after = controllerNormalized(tag);
    // ParameterChangeListener::performEdit only calls IComponentHandler::performEdit
    // when the controller accepted the value, and it sets it first. A controller value
    // that moved across the forward is therefore the observable receipt of a real
    // performEdit; one that did not move means the editor had nothing to forward.
    if (listenerState(control) == "present") {
      if (after != before) {
        EditorTrace::instance().performEdit++;
        EditorTrace::instance().record("controller:performEdit tag=" + std::to_string(tag) +
          " value=" + formatDouble(after) + " accepted=true");
      } else {
        EditorTrace::instance().record("controller:performEdit tag=" + std::to_string(tag) +
          " value=" + formatDouble(after) +
          " accepted=false(controllerValueUnchanged) controlValue=" +
          formatFloat(control->getValueNormalized()));
      }
    } else {
      EditorTrace::instance().record("controller:performEditSkipped tag=" + std::to_string(tag) +
        " reason=noParameterListener");
    }
  }

  // ---- what the real frame delivers ------------------------------------------
  //
  // The observer runs before the frame dispatches the event to any view, so a
  // MouseDown that names the Gain slider here proves the pointer reached the real
  // control's frame coordinates; the post-dispatch state then proves whether the
  // control itself acted on it.
  void onMouseEvent(VSTGUI::MouseEvent& event, VSTGUI::CFrame* frame) override {
    recordBindingOnce();
    VSTGUI::VST3Editor::onMouseEvent(event, frame);
    if (event.type != VSTGUI::EventType::MouseDown && event.type != VSTGUI::EventType::MouseMove &&
        event.type != VSTGUI::EventType::MouseUp) {
      return;
    }
    std::ostringstream out;
    out << "mouse:" << eventName(event.type)
        << " at=" << formatDouble(event.mousePosition.x) << "," << formatDouble(event.mousePosition.y)
        << " leftDown=" << (event.buttonState.isLeft() ? "true" : "false")
        << " shift=" << (event.modifiers.has(VSTGUI::ModifierKey::Shift) ? "true" : "false")
        << " hit=" << describeView(viewAt(event.mousePosition));
    EditorTrace::instance().record(out.str());

    if (event.type == VSTGUI::EventType::MouseDown) {
      auto* hit = dynamic_cast<VSTGUI::CControl*>(viewAt(event.mousePosition));
      if (hit && dynamic_cast<VSTGUI::CSlider*>(hit) && hit->getTag() == kParamGain) {
        EditorTrace::instance().mouseDownOnGainSlider++;
        EditorTrace::instance().record("mouse:downLandedOnGainSlider preValue=" +
          formatFloat(static_cast<VSTGUI::CControl*>(hit)->getValue()));
      }
    }

    // The observer runs BEFORE the frame routes the event (CFrame::dispatchMouseDownEvent
    // calls the observers, then dispatches), so reading the control here would report
    // the state the event started in, not what the control did with it.
    // doAfterEventProcessing runs once routing finished: that is the real post-state.
    const std::string stage = eventName(event.type);
    if (frame) {
      auto sharedFrame = VSTGUI::shared(frame);
      if (!sharedFrame->doAfterEventProcessing([this, sharedFrame, stage]() {
            traceAfterDispatch(stage);
          })) {
        // Not inside event handling, so no post-dispatch read is coming. Say so
        // explicitly: a missing `state:` line must never be mistaken for "the value
        // did not move", which is what case C would look like.
        EditorTrace::instance().record("state:" + stage +
          " afterDispatch=UNAVAILABLE(reason=notInEventProcessing)");
      }
    }
  }

private:
  static const char* eventName(VSTGUI::EventType type) {
    switch (type) {
      case VSTGUI::EventType::MouseDown: return "down";
      case VSTGUI::EventType::MouseMove: return "move";
      case VSTGUI::EventType::MouseUp: return "up";
      default: return "other";
    }
  }

  /**
   * The control under a point, resolved DEEPLY and read-only.
   *
   * CFrame::getViewAt() defaults to a shallow search that returns the first
   * mouse-enabled child container it meets, so it reports `panel` rather than the
   * slider inside it. Asking for a deep search with containers excluded is what
   * makes this probe answer the question it is being used for: did the press land on
   * the control itself. It only reads; nothing is dispatched.
   */
  VSTGUI::CView* viewAt(VSTGUI::CPoint point) {
    auto* frame = getFrame();
    if (!frame) return nullptr;
    return frame->getViewAt(point,
      VSTGUI::GetViewOptions().deep().mouseEnabled());
  }

  /**
   * Does this control have a live parameter binding, and is it writable?
   *
   * VST3Editor::controlBeginEdit/controlEndEdit/valueChanged are all no-ops when
   * getParameterChangeListener(tag) returns null, which is the whole of case D. The
   * map is private, but the subclass can ask the same question the editors asks.
   */
  std::string listenerState(VSTGUI::CControl* control) {
    if (!control) return "noControl";
    const int32_t tag = control->getTag();
    if (tag == -1) return "null(tag=-1)";
    auto* listener = getParameterChangeListener(tag);
    if (!listener) return "null(noListenerForTag)";
    return "present";
  }

  double controllerNormalized(int32_t tag) {
    if (tag < 0) return -1.0;
    auto* controller = getController();
    if (!controller) return -1.0;
    return controller->getParamNormalized(static_cast<Steinberg::Vst::ParamID>(tag));
  }

  std::string controllerValue(int32_t tag) {
    if (tag < 0) return "n/a";
    return formatDouble(controllerNormalized(tag));
  }

  int frameBeginEditCount() { return EditorTrace::instance().controllerBeginEdit.load(); }

  /**
   * Report the post-dispatch state of the real Gain slider exactly once per event.
   *
   * This is the measurement that separates C from D: if the slider's own value and
   * editing flag move, the control received and acted on the gesture; if they stay
   * put, the gesture never became an interaction with the control.
   */
  void traceAfterDispatch(const std::string& stage) {
    auto* frame = getFrame();
    if (!frame) return;
    // CFrame derives from CViewContainer, so the frame is the root to search.
    auto* slider = findGainSlider(frame);
    if (!slider) {
      EditorTrace::instance().record("state:" + stage + " gainSliderNotFound");
      return;
    }
    std::ostringstream out;
    out << "state:" << stage
        << " afterDispatch sliderValue=" << formatFloat(slider->getValue())
        << " sliderNormalized=" << formatFloat(slider->getValueNormalized())
        << " editing=" << (slider->isEditing() ? "true" : "false")
        << " dirty=" << (slider->isDirty() ? "true" : "false")
        << " controllerNormalized=" << controllerValue(slider->getTag())
        << " sync="
        << (std::abs(slider->getValueNormalized() -
                     static_cast<float>(controllerNormalized(slider->getTag()))) < 0.0005f
              ? "inSync" : "outOfSync");
    EditorTrace::instance().record(out.str());
  }

  bool bindingRecorded_{false};

  static VSTGUI::CSlider* findGainSlider(VSTGUI::CView* view) {
    if (!view) return nullptr;
    if (auto* slider = dynamic_cast<VSTGUI::CSlider*>(view)) {
      if (slider->getTag() == kParamGain) return slider;
    }
    if (auto* container = dynamic_cast<VSTGUI::CViewContainer*>(view)) {
      for (uint32_t index = 0; index < container->getNbViews(); ++index) {
        if (auto* found = findGainSlider(container->getView(index))) return found;
      }
    }
    return nullptr;
  }
};

IPlugView* createGainEditor(EditController* controller) {
  // A genuine VSTGUI editor: VST3Editor parses the packaged uidesc, builds the real
  // CControls (the Gain slider and value field), and routes their edits through the
  // component handler as beginEdit / performEdit / endEdit for kParamGain. That is
  // the shipping editor path, not an Apex-drawn substitute. The subclass observes it.
  return new TracedGainEditor(controller, "view", "acceptancegain.uidesc");
}

void acceptanceEditorTraceClear() { EditorTrace::instance().clear(); }

/**
 * The correlated trace, as a JSON-ready list of lines, plus the lifecycle counters.
 *
 * Read from the host process immediately after a real gesture so the evidence is the
 * editor's own record of what it did with that gesture.
 */
std::string acceptanceEditorTraceJson() {
  auto entries = EditorTrace::instance().snapshot();
  auto& trace = EditorTrace::instance();
  std::ostringstream out;
  out << "{\"entries\":[";
  for (size_t index = 0; index < entries.size(); ++index) {
    if (index) out << ',';
    out << '"' << escapeJson(entries[index]) << '"';
  }
  out << "],\"counters\":{"
      << "\"mouseDownOnGainSlider\":" << trace.mouseDownOnGainSlider.load() << ","
      << "\"controlBeginEdit\":" << trace.controlBeginEdit.load() << ","
      << "\"controlEndEdit\":" << trace.controlEndEdit.load() << ","
      << "\"valueChanged\":" << trace.valueChanged.load() << ","
      << "\"frameBeginEdit\":" << trace.controllerBeginEdit.load() << ","
      << "\"frameEndEdit\":" << trace.controllerEndEdit.load() << ","
      << "\"performEdit\":" << trace.performEdit.load()
      << "},\"entryCount\":" << entries.size() << "}";
  return out.str();
}

} // namespace ApexAcceptanceGain

#else

namespace ApexAcceptanceGain {

// No GUI toolchain in this build: the fixture still loads, processes audio and
// exposes its parameter, but reports no editor. The acceptance harness treats a
// missing editor as NOT_VERIFIED rather than a pass.
IPlugView* createGainEditor(EditController*) { return nullptr; }

void acceptanceEditorTraceClear() {}

std::string acceptanceEditorTraceJson() {
  return "{\"entries\":[],\"counters\":{},\"entryCount\":0,"
         "\"unavailable\":\"no VSTGUI in this build\"}";
}

} // namespace ApexAcceptanceGain

#endif
