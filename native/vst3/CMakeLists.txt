cmake_minimum_required(VERSION 3.25)
project(apex_vst3_host LANGUAGES CXX)

# Standalone executable: no Node/Electron ABI dependency; Windows x64 is the
# intended desktop target. Linux exists for reproducible DSP verification.
if(NOT WIN32 AND NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
  message(FATAL_ERROR "This prototype supports Windows and Linux only")
endif()
option(APEX_BUILD_VST3_FIXTURE "Build the MIT SDK mda instrument bundle for tests only" ON)
set(SMTG_CREATE_MODULE_INFO OFF CACHE BOOL "" FORCE)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES ${APEX_BUILD_VST3_FIXTURE} CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ADD_VST3_UTILITIES OFF CACHE BOOL "" FORCE)
set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
if(NOT VST3_SDK_ROOT OR NOT JSON_ROOT)
  message(FATAL_ERROR "Run node scripts/setup-native-vst3.mjs first; pass VST3_SDK_ROOT and JSON_ROOT")
endif()
add_subdirectory("${VST3_SDK_ROOT}" "${CMAKE_BINARY_DIR}/sdk" EXCLUDE_FROM_ALL)
set(SDK_ROOT "${VST3_SDK_ROOT}")
set(vstsdk_VERSION 3.8.0)
add_executable(apex-vst3-host host.cpp
  "${SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp"
  "${SDK_ROOT}/public.sdk/source/common/memorystream.cpp")
if(WIN32)
  target_sources(apex-vst3-host PRIVATE "${SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp")
  target_compile_definitions(apex-vst3-host PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
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
  target_include_directories(mda-vst3 PRIVATE "${mda_dir}")
endif()

if(APEX_BUILD_VST3_FIXTURE)
  add_executable(apex-vst3-protocol-fault protocol-fault.cpp)
  set_target_properties(apex-vst3-protocol-fault PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
endif()
