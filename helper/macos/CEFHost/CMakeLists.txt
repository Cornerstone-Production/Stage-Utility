# The browser host: libStageUtilityCEFHost.dylib (the C API in
# ../Sources/StageUtilityCEFHostAPI/include/stage_cef_host.h, over CEF) and the one
# helper executable the five helper apps are made from. build-app.sh drives this;
# it does not make the app bundle, which build-app.sh assembles.
#
#   cmake -S CEFHost -B .cef-build/arm64 -G Ninja -DCEF_ROOT=.cef/arm64 -DPROJECT_ARCH=arm64
cmake_minimum_required(VERSION 3.21)
set(CMAKE_CONFIGURATION_TYPES Release CACHE STRING "" FORCE)
project(StageUtilityCEFHost)

if(NOT CEF_ROOT)
  message(FATAL_ERROR "Pass -DCEF_ROOT=<unpacked CEF distribution>; fetch-cef.sh makes one")
endif()
set(CMAKE_MODULE_PATH ${CMAKE_MODULE_PATH} "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)
add_subdirectory(${CEF_LIBCEF_DLL_WRAPPER_PATH} libcef_dll_wrapper)

SET_CEF_TARGET_OUT_DIR()
list(APPEND CEF_COMPILER_FLAGS -fobjc-arc)
set(API_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/../Sources/StageUtilityCEFHostAPI/include")

add_library(StageUtilityCEFHost SHARED cef_host_mac.mm)
SET_LIBRARY_TARGET_PROPERTIES(StageUtilityCEFHost)
add_dependencies(StageUtilityCEFHost libcef_dll_wrapper)
target_include_directories(StageUtilityCEFHost PRIVATE ${API_INCLUDE})
target_link_libraries(StageUtilityCEFHost libcef_dll_wrapper ${CEF_STANDARD_LIBS})
# A dylib, so the executable-only -pie from CEF's flags does not apply.
set_property(TARGET StageUtilityCEFHost PROPERTY LINK_FLAGS "-Wl,-search_paths_first -Wl,-ObjC -Wl,-dead_strip")
set_target_properties(StageUtilityCEFHost PROPERTIES
  INSTALL_NAME_DIR "@rpath"
  BUILD_WITH_INSTALL_NAME_DIR ON)

add_executable(stage_cef_helper process_helper_mac.cc)
SET_EXECUTABLE_TARGET_PROPERTIES(stage_cef_helper)
add_dependencies(stage_cef_helper libcef_dll_wrapper)
target_link_libraries(stage_cef_helper libcef_dll_wrapper ${CEF_STANDARD_LIBS})
