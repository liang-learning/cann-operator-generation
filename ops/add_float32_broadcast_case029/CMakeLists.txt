cmake_minimum_required(VERSION 3.16)

get_filename_component(REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
list(APPEND CMAKE_PREFIX_PATH "${REPO_ROOT}/asc-devkit/cmake/asc")

find_package(ASC REQUIRED)

project(add_float32_broadcast_case029 LANGUAGES ASC CXX)

add_executable(add_float32_broadcast_case029
    add_float32_broadcast_case029.asc
)

target_compile_options(add_float32_broadcast_case029 PRIVATE
    $<$<COMPILE_LANGUAGE:ASC>:--npu-arch=dav-2201>
)
