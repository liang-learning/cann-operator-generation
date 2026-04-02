cmake_minimum_required(VERSION 3.16)

get_filename_component(REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)

set(RUN_MODE "${RUN_MODE}" CACHE STRING "Run mode: npu or cpu")
set(SOC_VERSION "${SOC_VERSION}" CACHE STRING "Target SoC version for cpu/sim mode")
set(ASCENDC_CMAKE_PATH "$ENV{ASCENDC_CMAKE_PATH}" CACHE PATH "Path containing ASCConfig.cmake")
set(ASCENDC_DEVKIT_PATH "$ENV{ASCENDC_DEVKIT_PATH}" CACHE PATH "Path to a local asc-devkit checkout")
set(TIKICPU_CMAKE_PATH "$ENV{TIKICPU_CMAKE_PATH}" CACHE PATH "Path containing tikicpulib-config.cmake")

project(add_float32_broadcast_case029 LANGUAGES CXX)

set(ASC_SRC_FILE add_float32_broadcast_case029.asc)

if("${RUN_MODE}" STREQUAL "cpu")
    if(NOT TIKICPU_CMAKE_PATH AND DEFINED ENV{ASCEND_HOME_PATH})
        set(TIKICPU_CMAKE_PATH "$ENV{ASCEND_HOME_PATH}/tools/tikicpulib/lib/cmake")
    endif()
    if(TIKICPU_CMAKE_PATH AND EXISTS "${TIKICPU_CMAKE_PATH}/tikicpulib-config.cmake")
        list(APPEND CMAKE_PREFIX_PATH "${TIKICPU_CMAKE_PATH}")
    endif()
    find_package(tikicpulib REQUIRED)
    set_source_files_properties(${ASC_SRC_FILE} PROPERTIES LANGUAGE CXX)
else()
    if(ASCENDC_CMAKE_PATH AND EXISTS "${ASCENDC_CMAKE_PATH}/ASCConfig.cmake")
        list(APPEND CMAKE_PREFIX_PATH "${ASCENDC_CMAKE_PATH}")
    elseif(ASCENDC_DEVKIT_PATH AND EXISTS "${ASCENDC_DEVKIT_PATH}/cmake/asc")
        list(APPEND CMAKE_PREFIX_PATH "${ASCENDC_DEVKIT_PATH}/cmake/asc")
    elseif(EXISTS "${REPO_ROOT}/asc-devkit/cmake/asc")
        list(APPEND CMAKE_PREFIX_PATH "${REPO_ROOT}/asc-devkit/cmake/asc")
    else()
        message(FATAL_ERROR
            "Cannot locate Ascend C CMake modules. Set ASCENDC_CMAKE_PATH to the toolkit directory containing "
            "ASCConfig.cmake, or set ASCENDC_DEVKIT_PATH to a valid asc-devkit checkout."
        )
    endif()

    find_package(ASC REQUIRED)
    enable_language(ASC CXX)
endif()

add_executable(add_float32_broadcast_case029
    ${ASC_SRC_FILE}
)

if("${RUN_MODE}" STREQUAL "cpu")
    target_compile_options(add_float32_broadcast_case029 PRIVATE
        -x c++
        -g
        -O2
        -std=c++17
        -D_GLIBCXX_USE_CXX11_ABI=0
    )
    target_link_directories(add_float32_broadcast_case029 PRIVATE
        $ENV{ASCEND_HOME_PATH}/tools/tikicpulib/lib
    )
    target_link_libraries(add_float32_broadcast_case029 PRIVATE
        m
        ascendc_acl_stub
        tikicpulib::${SOC_VERSION}
    )
else()
    target_compile_options(add_float32_broadcast_case029 PRIVATE
        $<$<COMPILE_LANGUAGE:ASC>:--npu-arch=dav-2201>
    )
endif()
