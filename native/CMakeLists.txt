cmake_minimum_required(VERSION 3.16)
project(starfish_cdp_native CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(-O2 -Wall)

find_package(Threads REQUIRED)

add_executable(starfish-cdp-native
  src/main.cpp
  src/ws_client.cpp
  src/cdp_client.cpp
  src/base64.cpp
)

target_link_libraries(starfish-cdp-native PRIVATE Threads::Threads)
