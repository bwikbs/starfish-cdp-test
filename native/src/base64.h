#pragma once
#include <string>
#include <cstdint>

// RFC4648 base64 encode. Used only to build the Sec-WebSocket-Key header.
std::string base64Encode(const uint8_t* data, size_t len);

// RFC4648 base64 decode. Ignores whitespace; returns false on invalid input.
// Used by the CLI to decode Page.captureScreenshot data into raw PNG bytes.
bool base64Decode(const std::string& in, std::string& out);
