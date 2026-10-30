cmake_minimum_required(VERSION 3.25)
project(apex_vst3_host LANGUAGES CXX)

# Standalone executable: no Node/Electron ABI dependency; Windows x64 is the
# intended desktop target. Linux exists for reproducible DSP verification.
if(NOT WIN32 AND NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
  message(FATAL_ERROR "This prototype supports Windows and Linux only")
endif()
option(APEX_BUILD_VST3_FIXTURE "Build the MIT SDK mda instrument bundle for tests only" ON)
option(APEX_MDA_REZFILTER_TRACE "Diagnostic-only read-only MDA RezFilter internal-state trace" OFF)
set(SMTG_CREATE_MODULE_INFO OFF CACHE BOOL "" FORCE)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(SMTG_USE_STATIC_CRT ON CACHE BOOL "" FORCE)
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
  file(READ "${mda_dir}/mdaRezFilterProcessor.cpp" mda_rez)
  # Candidate fixture: the unspaced buf0=0.f needle is the denormal tail in
  # doProcessing, not setActive/setProcessing. Keep it on this isolated
  # diagnostic plugin variant so instrumented and uninstrumented candidate
  # plugins share the same DSP source. Production PR #292 is untouched.
  string(FIND "${mda_rez}" "buf0=0.f;" rez_offset)
  if(rez_offset EQUAL -1)
    message(FATAL_ERROR "Pinned mda RezFilter setActive buffer init no longer matches")
  endif()
  string(REPLACE "buf0=0.f;" "env=0.f; env2=0.f; phi=0.f; bufl=0.f; ttrig=0; tatt=0; buf0=0.f;" mda_rez "${mda_rez}")
  if(APEX_MDA_REZFILTER_TRACE)
    # Read-only snapshots of existing members. Does not assign env/phi/buffers.
    string(REPLACE "#include <cstdlib>" "#include <cstdlib>\n#include \"apexRezFilterTrace.h\"" mda_rez "${mda_rez}")
    string(REPLACE "\tallocParameters (10);\n}" "\tallocParameters (10);\n\tAPEX_REZ_SNAP(\"construct\");\n}" mda_rez "${mda_rez}")
    string(REPLACE "\t\trecalculate ();\n\t}\n\treturn res;\n}" "\t\trecalculate ();\n\t\tAPEX_REZ_SNAP(\"initialize\");\n\t}\n\treturn res;\n}" mda_rez "${mda_rez}")
    string(REPLACE "tresult PLUGIN_API RezFilterProcessor::setActive (TBool state)\n{\n\treturn BaseProcessor::setActive (state);\n}"
      "tresult PLUGIN_API RezFilterProcessor::setActive (TBool state)\n{\n\tAPEX_REZ_SNAP(state ? \"setActive-on\" : \"setActive-off\");\n\tconst auto _apex_active = BaseProcessor::setActive (state);\n\tAPEX_REZ_SNAP(state ? \"setActive-on-after\" : \"setActive-off-after\");\n\treturn _apex_active;\n}" mda_rez "${mda_rez}")
    string(REPLACE "\t\tbuf2 = 0.f;\n\t}\n\n\tBaseProcessor::setProcessing (state);\n\treturn kResultOk;\n}"
      "\t\tbuf2 = 0.f;\n\t}\n\tAPEX_REZ_SNAP(state ? \"setProcessing-on\" : \"setProcessing-off\");\n\tBaseProcessor::setProcessing (state);\n\treturn kResultOk;\n}" mda_rez "${mda_rez}")
    string(REPLACE "tresult PLUGIN_API RezFilterProcessor::terminate ()\n{\n\treturn BaseProcessor::terminate ();\n}"
      "tresult PLUGIN_API RezFilterProcessor::terminate ()\n{\n\tapexRezTraceFlush();\n\treturn BaseProcessor::terminate ();\n}" mda_rez "${mda_rez}")
    string(REPLACE "\tint32 lm=lfomode, ta=tatt, tt=ttrig;\n\n\t--in1;"
      "\tint32 lm=lfomode, ta=tatt, tt=ttrig;\n\tapexRezBeginBlock(static_cast<uint32_t>(sampleFrames));\n\tAPEX_REZ_SNAP(\"process-pre\");\n\n\t--in1;" mda_rez "${mda_rez}")
    string(REPLACE "\t\t\tf = ff + fe * e + bl; //freq\n\t\t\tif (f<0.f) i = 0.f; else i= (f>fm)? fm : f;"
      "\t\t\tf = ff + fe * e + bl; //freq\n\t\t\tapexRezAccumCutoff(f);\n\t\t\tif (f<0.f) i = 0.f; else i= (f>fm)? fm : f;\n\t\t\tif (i==0.f) apexRezAccumIZero();" mda_rez "${mda_rez}")
    string(REPLACE "\t\t\ta = *++in1 + *++in2;"
      "\t\t\ta = *++in1 + *++in2;\n\t\t\tapexRezAccumIn(a);" mda_rez "${mda_rez}")
    string(REPLACE "\t\t\t*++out1 = b1;\n\t\t\t*++out2 = b1;"
      "\t\t\t*++out1 = b1;\n\t\t\t*++out2 = b1;\n\t\t\tapexRezAccumOut(b1);" mda_rez "${mda_rez}")
    string(REPLACE "\tphi= (float)fmod(ph,6.2831853f);\n}"
      "\tphi= (float)fmod(ph,6.2831853f);\n\tAPEX_REZ_SNAP(\"process-post\");\n}" mda_rez "${mda_rez}")
    string(REPLACE "\tif (params[8]<0.1) tthr=0.f; else tthr = static_cast<float> (3.f * params[8] * params[8]);\n}"
      "\tif (params[8]<0.1) tthr=0.f; else tthr = static_cast<float> (3.f * params[8] * params[8]);\n\tAPEX_REZ_SNAP(\"recalculate\");\n}" mda_rez "${mda_rez}")
    string(FIND "${mda_rez}" "APEX_REZ_SNAP" snap_offset)
    if(snap_offset EQUAL -1)
      message(FATAL_ERROR "MDA RezFilter read-only trace injection failed")
    endif()
    string(FIND "${mda_rez}" "apexRezAccumCutoff" cutoff_offset)
    if(cutoff_offset EQUAL -1)
      message(FATAL_ERROR "MDA RezFilter cutoff accumulator injection failed")
    endif()
    file(WRITE "${CMAKE_BINARY_DIR}/trace-mdaRezFilterProcessor.cpp" "${mda_rez}")
    get_target_property(mda_sources mda-vst3 SOURCES)
    list(REMOVE_ITEM mda_sources source/mdaRezFilterProcessor.cpp)
    set_property(TARGET mda-vst3 PROPERTY SOURCES "${mda_sources}")
    target_sources(mda-vst3 PRIVATE "${CMAKE_BINARY_DIR}/trace-mdaRezFilterProcessor.cpp")
    target_include_directories(mda-vst3 PRIVATE "${mda_dir}" "${CMAKE_CURRENT_SOURCE_DIR}/diag")
    message(STATUS "MDA RezFilter diagnostic read-only per-instance trace enabled; DSP members are not assigned")
  else()
    file(WRITE "${CMAKE_BINARY_DIR}/fixture-mdaRezFilterProcessor.cpp" "${mda_rez}")
    get_target_property(mda_sources mda-vst3 SOURCES)
    list(REMOVE_ITEM mda_sources source/mdaRezFilterProcessor.cpp)
    set_property(TARGET mda-vst3 PROPERTY SOURCES "${mda_sources}")
    target_sources(mda-vst3 PRIVATE "${CMAKE_BINARY_DIR}/fixture-mdaRezFilterProcessor.cpp")
  endif()
  target_include_directories(mda-vst3 PRIVATE "${mda_dir}")
endif()

if(APEX_BUILD_VST3_FIXTURE)
  add_executable(apex-vst3-protocol-fault protocol-fault.cpp)
  set_target_properties(apex-vst3-protocol-fault PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
endif()
