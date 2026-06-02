#include "base64.h"

static const char kTable[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const uint8_t* data, size_t len) {
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  size_t i = 0;
  while (i + 3 <= len) {
    uint32_t n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out.push_back(kTable[(n >> 18) & 0x3F]);
    out.push_back(kTable[(n >> 12) & 0x3F]);
    out.push_back(kTable[(n >> 6) & 0x3F]);
    out.push_back(kTable[n & 0x3F]);
    i += 3;
  }
  size_t rem = len - i;
  if (rem == 1) {
    uint32_t n = data[i] << 16;
    out.push_back(kTable[(n >> 18) & 0x3F]);
    out.push_back(kTable[(n >> 12) & 0x3F]);
    out.push_back('=');
    out.push_back('=');
  } else if (rem == 2) {
    uint32_t n = (data[i] << 16) | (data[i + 1] << 8);
    out.push_back(kTable[(n >> 18) & 0x3F]);
    out.push_back(kTable[(n >> 12) & 0x3F]);
    out.push_back(kTable[(n >> 6) & 0x3F]);
    out.push_back('=');
  }
  return out;
}

bool base64Decode(const std::string& in, std::string& out) {
  static int8_t rev[256];
  static bool init = false;
  if (!init) {
    for (int i = 0; i < 256; i++) rev[i] = -1;
    for (int i = 0; i < 64; i++) rev[(uint8_t)kTable[i]] = (int8_t)i;
    init = true;
  }
  out.clear();
  uint32_t acc = 0;
  int bits = 0;
  for (char ch : in) {
    uint8_t c = (uint8_t)ch;
    if (c == '=' ) break;
    if (ch == '\n' || ch == '\r' || ch == ' ' || ch == '\t') continue;
    int8_t v = rev[c];
    if (v < 0) return false;
    acc = (acc << 6) | (uint32_t)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back((char)((acc >> bits) & 0xFF));
    }
  }
  return true;
}
