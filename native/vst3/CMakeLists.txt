cmake_minimum_required(VERSION 3.25)
project(apex_vst3_host VERSION 1.0.0 LANGUAGES CXX)

# Standalone executable: no Node/Electron ABI dependency; Windows x64 is the
# intended desktop target. Linux exists for reproducible DSP verification.
if(NOT WIN32 AND NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
  message(FATAL_ERROR "This prototype supports Windows and Linux only")
endif()
option(APEX_BUILD_VST3_FIXTURE "Build the MIT SDK mda instrument bundle for tests only" ON)
if(WIN32)
  option(APEX_BUILD_VST3_EDITOR_FIXTURE "Build the genuine VSTGUI editor fixtures (AGain + ApexAcceptanceGain) for editor tests only" ON)
else()
  option(APEX_BUILD_VST3_EDITOR_FIXTURE "Build the genuine VSTGUI editor fixtures (AGain + ApexAcceptanceGain) for editor tests only" OFF)
endif()
# AGain (the SDK sample) cannot build off Windows: its bundle needs the Windows
# resource/entry path. ApexAcceptanceGain CAN, and building it on Linux is how this
# repository compile-verifies the fixture and proves it loads and processes audio
# without needing a Windows runner for every iteration.
if(APEX_BUILD_VST3_EDITOR_FIXTURE AND NOT WIN32)
  set(APEX_SDK_EDITOR_FIXTURE_ONLY_WIN32 ON)
endif()
# Test-only acceptance fixture. It is a stereo-in/stereo-out effect with a genuine
# VSTGUI editor and a controller that exposes exactly the parameter its editor
# edits -- the one combination no pinned SDK sample provides. Built ONLY when the
# editor fixture option is on, and never referenced by any packaged/staged build.
# On by default: the DSP test needs no GUI, so it runs everywhere. The VSTGUI
# bundle half is gated separately below on VSTGUI availability.
option(APEX_BUILD_ACCEPTANCE_FIXTURE "Build the test-only ApexAcceptanceGain fixture and its DSP test" ON)
set(SMTG_CREATE_MODULE_INFO OFF CACHE BOOL "" FORCE)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(SMTG_USE_STATIC_CRT ON CACHE BOOL "" FORCE)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(APEX_BUILD_VST3_EDITOR_FIXTURE)
  set(SMTG_ENABLE_VSTGUI_SUPPORT ON CACHE BOOL "" FORCE)
else()
  set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
endif()
if(APEX_BUILD_VST3_FIXTURE OR APEX_BUILD_VST3_EDITOR_FIXTURE)
  set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES ON CACHE BOOL "" FORCE)
else()
  set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES OFF CACHE BOOL "" FORCE)
endif()
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ADD_VST3_UTILITIES OFF CACHE BOOL "" FORCE)
set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
if(NOT VST3_SDK_ROOT OR NOT JSON_ROOT)
  message(FATAL_ERROR "Run node scripts/setup-native-vst3.mjs first; pass VST3_SDK_ROOT and JSON_ROOT")
endif()
# Keep SDK targets in the top-level VS solution so explicit --target builds
# resolve their subdirectory .vcxproj files on Windows as well as Ninja.
add_subdirectory("${VST3_SDK_ROOT}" "${CMAKE_BINARY_DIR}/sdk")
set(SDK_ROOT "${VST3_SDK_ROOT}")
set(vstsdk_VERSION 3.8.0)
add_executable(apex-vst3-host host.cpp
  "${SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp"
  "${SDK_ROOT}/public.sdk/source/common/memorystream.cpp")
if(WIN32)
  target_sources(apex-vst3-host PRIVATE "${SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp")
  target_compile_definitions(apex-vst3-host PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_compile_options(apex-vst3-host PRIVATE $<$<CXX_COMPILER_ID:MSVC>:/fp:precise>)
  target_link_libraries(apex-vst3-host PRIVATE ole32 shell32 uuid)
else()
  target_sources(apex-vst3-host PRIVATE "${SDK_ROOT}/public.sdk/source/vst/hosting/module_linux.cpp")
  target_link_libraries(apex-vst3-host PRIVATE dl pthread)
endif()
target_link_libraries(apex-vst3-host PRIVATE sdk_hosting)
target_include_directories(apex-vst3-host PRIVATE "${JSON_ROOT}/single_include")
set_target_properties(apex-vst3-host PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")


# The pinned mda sample-accurate slicer consumes an event at offset 16 in the
# preceding 16-frame slice, whose synth loop never applies an end-of-slice
# event. Keep the SDK checkout immutable: compile a generated, attributed copy
# with this one-character fixture correction. This is NOT a host workaround.
if(APEX_BUILD_VST3_FIXTURE)
  set(mda_dir "${SDK_ROOT}/public.sdk/samples/vst/mda-vst3/source")
  file(READ "${mda_dir}/mdaBaseProcessor.cpp" mda_base)
  string(FIND "${mda_base}" "if (event.sampleOffset <= data.numSamples)" boundary_offset)
  if(boundary_offset EQUAL -1)
    message(FATAL_ERROR "Pinned mda event-boundary correction no longer matches")
  endif()
  string(REPLACE "if (event.sampleOffset <= data.numSamples)" "if (event.sampleOffset < data.numSamples)" mda_base "${mda_base}")
  file(WRITE "${CMAKE_BINARY_DIR}/fixture-mdaBaseProcessor.cpp" "${mda_base}")
  get_target_property(mda_sources mda-vst3 SOURCES)
  list(REMOVE_ITEM mda_sources source/mdaBaseProcessor.cpp)
  set_property(TARGET mda-vst3 PROPERTY SOURCES "${mda_sources}")
  target_sources(mda-vst3 PRIVATE "${CMAKE_BINARY_DIR}/fixture-mdaBaseProcessor.cpp")

  # Pinned mda RezFilterProcessor leaves env, env2, phi, bufl, lfomode, ttrig,
  # and tatt uninitialized in its constructor and setProcessing(true). When the
  # allocator reuses heap memory holding NaN bit patterns (e.g. 0xffffffff on
  # Windows CRT), 0.0f * NaN produces NaN cutoff modulation and clamps output to
  # 0.0f under MSVC /fp:fast for the entire session. Keep the SDK checkout
  # immutable and initialize those members in a generated fixture source.
  file(READ "${mda_dir}/mdaRezFilterProcessor.cpp" mda_rez)
  string(REPLACE "\r\n" "\n" mda_rez "${mda_rez}")
  set(rez_ctor_needle "\tsetControllerClass (RezFilterController::uid);\n\tallocParameters (10);")
  set(rez_ctor_init "\tsetControllerClass (RezFilterController::uid);\n\tallocParameters (10);\n\tbuf0 = 0.f; buf1 = 0.f; buf2 = 0.f;\n\tenv = 0.f; env2 = 0.f; phi = 0.f; bufl = 0.f;\n\tlfomode = 0; ttrig = 0; tatt = 0;")
  string(FIND "${mda_rez}" "${rez_ctor_needle}" rez_ctor_offset)
  if(rez_ctor_offset EQUAL -1)
    message(FATAL_ERROR "Pinned mda RezFilter constructor init needle no longer matches")
  endif()
  string(REPLACE "${rez_ctor_needle}" "${rez_ctor_init}" mda_rez "${mda_rez}")
  set(rez_proc_needle "\tif (state)\n\t{\n\t\tbuf0 = 0.f;\n\t\tbuf1 = 0.f;\n\t\tbuf2 = 0.f;\n\t}")
  set(rez_proc_init "\tif (state)\n\t{\n\t\tbuf0 = 0.f;\n\t\tbuf1 = 0.f;\n\t\tbuf2 = 0.f;\n\t\tenv = 0.f;\n\t\tenv2 = 0.f;\n\t\tphi = 0.f;\n\t\tbufl = 0.f;\n\t\tttrig = 0;\n\t\ttatt = 0;\n\t}")
  string(FIND "${mda_rez}" "${rez_proc_needle}" rez_proc_offset)
  if(rez_proc_offset EQUAL -1)
    message(FATAL_ERROR "Pinned mda RezFilter setProcessing init needle no longer matches")
  endif()
  string(REPLACE "${rez_proc_needle}" "${rez_proc_init}" mda_rez "${mda_rez}")
  file(WRITE "${CMAKE_BINARY_DIR}/fixture-mdaRezFilterProcessor.cpp" "${mda_rez}")
  get_target_property(mda_sources mda-vst3 SOURCES)
  list(REMOVE_ITEM mda_sources source/mdaRezFilterProcessor.cpp)
  set_property(TARGET mda-vst3 PROPERTY SOURCES "${mda_sources}")
  target_sources(mda-vst3 PRIVATE "${CMAKE_BINARY_DIR}/fixture-mdaRezFilterProcessor.cpp")
  target_include_directories(mda-vst3 PRIVATE "${mda_dir}")
endif()

if(APEX_BUILD_VST3_FIXTURE)
  add_executable(apex-vst3-protocol-fault protocol-fault.cpp)
  set_target_properties(apex-vst3-protocol-fault PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

  add_executable(apex-vst3-restart-flags-test restart-flags-test.cpp)
  if(WIN32)
    target_compile_definitions(apex-vst3-restart-flags-test PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    target_link_libraries(apex-vst3-restart-flags-test PRIVATE ole32 shell32 uuid)
  else()
    target_link_libraries(apex-vst3-restart-flags-test PRIVATE pthread)
  endif()
  target_link_libraries(apex-vst3-restart-flags-test PRIVATE sdk_hosting)
  set_target_properties(apex-vst3-restart-flags-test PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

  smtg_add_vst3plugin(apex-latency-vst3
    latency-fixture.cpp
    "${SDK_ROOT}/public.sdk/source/vst/vstsinglecomponenteffect.cpp"
  )
  if(WIN32)
    target_sources(apex-latency-vst3 PRIVATE "${SDK_ROOT}/public.sdk/source/main/dllmain.cpp")
    target_compile_definitions(apex-latency-vst3 PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  else()
    target_sources(apex-latency-vst3 PRIVATE "${SDK_ROOT}/public.sdk/source/main/linuxmain.cpp")
  endif()
  target_link_libraries(apex-latency-vst3 PRIVATE sdk)
  target_compile_options(apex-latency-vst3 PRIVATE $<$<CXX_COMPILER_ID:MSVC>:/fp:precise>)
endif()

# ---------------------------------------------------------------------------
# ApexAcceptanceGain -- test-only acceptance fixture (original Apex code; see
# native/vst3/acceptance-fixture.hpp for provenance and rationale).
#
# Only built for acceptance runs. It is never staged into a packaged build: the
# packaging step collects products from build/native-vst3 into resources/vst3 for
# the host binary only, and the editor harness points at this bundle explicitly.
# ---------------------------------------------------------------------------
if(APEX_BUILD_ACCEPTANCE_FIXTURE)
  # The DSP test always builds (see below); the bundle needs VSTGUI for its editor.
  if(APEX_BUILD_VST3_EDITOR_FIXTURE)
  smtg_add_vst3plugin(apex-acceptance-vst3
    acceptance-fixture-processor.cpp
    acceptance-fixture-processor.hpp
    acceptance-fixture-controller.cpp
    acceptance-fixture-controller.hpp
    acceptance-fixture-editor.cpp
    acceptance-fixture-entry.cpp
    acceptance-fixture.hpp
    "${SDK_ROOT}/public.sdk/source/vst/vstsinglecomponenteffect.cpp"
    "${SDK_ROOT}/public.sdk/source/vst/vsteditcontroller.cpp"
  )
  if(WIN32)
    target_sources(apex-acceptance-vst3 PRIVATE "${SDK_ROOT}/public.sdk/source/main/dllmain.cpp")
    target_compile_definitions(apex-acceptance-vst3 PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  else()
    target_sources(apex-acceptance-vst3 PRIVATE "${SDK_ROOT}/public.sdk/source/main/linuxmain.cpp")
  endif()
  target_link_libraries(apex-acceptance-vst3 PRIVATE sdk vstgui_support)
  target_include_directories(apex-acceptance-vst3 PRIVATE "${SMTG_VSTGUI_SOURCE_DIR}")
  target_compile_definitions(apex-acceptance-vst3 PRIVATE APEX_ACCEPTANCE_FIXTURE_HAS_VSTGUI=1)
  target_compile_features(apex-acceptance-vst3 PUBLIC cxx_std_17)
  target_compile_options(apex-acceptance-vst3 PRIVATE $<$<CXX_COMPILER_ID:MSVC>:/fp:precise>)
  # The uidesc ships inside the bundle's Resources directory, which is where
  # VSTGUI's UIDescription looks for it.
  smtg_target_add_plugin_resources(apex-acceptance-vst3
    RESOURCES
      "${CMAKE_CURRENT_SOURCE_DIR}/resources/acceptancegain.uidesc"
  )
  endif()

  # Behavioural test of the fixture's DSP, bus layout, state round-trip and
  # controller parameter exposure. Deliberately separate from the plugin bundle:
  # it does not touch VSTGUI, so it builds and runs on a headless Linux host where
  # the editor half cannot link (no X11).
  add_executable(apex-acceptance-vst3-test
    acceptance-fixture-test.cpp
    acceptance-fixture-processor.cpp
    acceptance-fixture-controller.cpp
    acceptance-fixture-editor.cpp
    acceptance-fixture.hpp
    acceptance-fixture-processor.hpp
    acceptance-fixture-controller.hpp
    "${SDK_ROOT}/public.sdk/source/common/memorystream.cpp"
    "${SDK_ROOT}/public.sdk/source/vst/hosting/parameterchanges.cpp"
    # vstsinglecomponenteffect.cpp already carries EditController's implementation,
    # so adding vsteditcontroller.cpp as well would define those symbols twice.
    "${SDK_ROOT}/public.sdk/source/vst/vstsinglecomponenteffect.cpp"
  )
  # The test links the GUI-free build of the editor seam (createView returns
  # nullptr there), so it needs no VSTGUI and runs on a headless host.
  target_link_libraries(apex-acceptance-vst3-test PRIVATE sdk)
  target_compile_definitions(apex-acceptance-vst3-test PRIVATE APEX_ACCEPTANCE_FIXTURE_HAS_VSTGUI=0)
  if(WIN32)
    target_compile_definitions(apex-acceptance-vst3-test PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    target_link_libraries(apex-acceptance-vst3-test PRIVATE ole32 shell32 uuid)
  endif()
  target_compile_features(apex-acceptance-vst3-test PUBLIC cxx_std_17)
  set_target_properties(apex-acceptance-vst3-test PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
endif()
