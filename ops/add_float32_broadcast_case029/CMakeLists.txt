cmake_minimum_required(VERSION 3.16)

find_package(ASC REQUIRED)

project(add_float32_broadcast_case029 LANGUAGES ASC CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(add_float32_broadcast_case029
    add_float32_broadcast_case029.asc
)

target_compile_options(add_float32_broadcast_case029 PRIVATE
    $<$<COMPILE_LANGUAGE:ASC>:--npu-arch=dav-2201>
)
