#pragma once
#include <string>
#include <cstdint>

// RFC4648 base64 encode. Used only to build the Sec-WebSocket-Key header.
std::string base64Encode(const uint8_t* data, size_t len);
