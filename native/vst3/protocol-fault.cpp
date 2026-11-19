// IPC fault fixture ONLY. Not a plugin and never supplies test audio.
//
// It speaks to the parent through the same protocol channel as the real helper
// (protocol-channel.hpp), so the faults below reach the real frame parser:
//
//   hang          never answers (matched anywhere in the request line, as the
//                 DAW integration tests put the word in the plug-in path)
//   malformed     eight 0xFF bytes: an impossible frame header, then hang
//   oversized     a header announcing more PCM than a block can carry, then hang
//   truncated     a header and part of its body, then exit
//   duplicate     two complete frames for one request, in a single write
//   late-extra    one correct response, then a second frame nobody asked for
//   bad-json      a well-formed frame whose body is not JSON
//   bad-pcm       a well-formed frame carrying NaN samples
//   stdout-frame  a perfectly valid frame written to STDOUT, then hang
//   noise         `bytes` of text on stdout and on stderr, then a correct
//                 JSON-only response echoing `sequence`; the only command that
//                 keeps the fixture running
//
// Anything else (including `exit`, `crash` and `process`) exits with status 37.
#include "protocol-channel.hpp"
#include <chrono>
#include <cstdio>
#include <iostream>
#include <limits>
#include <string>
#include <thread>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {

bool isCommand(const std::string& line, const char* name) {
  return line.find(std::string("\"command\":\"") + name + "\"") != std::string::npos;
}

unsigned long long numberField(const std::string& line, const char* name) {
  const auto key = std::string("\"") + name + "\":";
  const auto at = line.find(key);
  if (at == std::string::npos) return 0;
  return std::strtoull(line.c_str() + at + key.size(), nullptr, 10);
}

void flood(std::FILE* stream, const char* label, unsigned long long bytes) {
  // Fixed-width 64-byte lines so the parent can check the exact byte count.
  char line[65];
  unsigned long long written = 0, index = 0;
  while (written < bytes) {
    std::snprintf(line, sizeof(line), "fixture %s line %012llu ..............................\n", label, index++);
    const auto chunk = static_cast<size_t>(bytes - written < 64 ? bytes - written : 64);
    std::fwrite(line, 1, chunk, stream);
    written += chunk;
  }
  std::fflush(stream);
}

void hang() { std::this_thread::sleep_for(std::chrono::seconds(60)); }

} // namespace

int main(int argc, char** argv) {
  auto& channel = ApexVst3Host::protocolChannel();
  std::string channelError;
  if (!channel.open(argc, argv, channelError)) {
    std::fprintf(stderr, "apex-vst3-protocol-fault: protocol channel unavailable: %s\n", channelError.c_str());
    return ApexVst3Host::kExitNoProtocolChannel;
  }
#ifdef _WIN32
  // Byte-exact diagnostics: no newline translation on the fixture's own text.
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stderr), _O_BINARY);
#endif
  std::string line;
  while (std::getline(std::cin, line)) {
    if (isCommand(line, "noise")) {
      const auto bytes = numberField(line, "bytes");
      flood(stdout, "stdout", bytes);
      flood(stderr, "stderr", bytes);
      ApexVst3Host::writeProtocolFrame("{\"ok\":true,\"sequence\":" + std::to_string(numberField(line, "sequence")) + "}");
      continue;
    }
    if (isCommand(line, "stdout-frame")) {
      const std::string body = "{\"ok\":true}";
      const char header[8] = { static_cast<char>(body.size()), 0, 0, 0, 0, 0, 0, 0 };
      std::fwrite(header, 1, sizeof(header), stdout);
      std::fwrite(body.data(), 1, body.size(), stdout);
      std::fflush(stdout);
      hang();
    } else if (isCommand(line, "oversized")) {
      // 16 MiB of "PCM": above the largest block the protocol allows.
      const char header[8] = { 2, 0, 0, 0, 0, 0, 0, 1 };
      channel.write(header, sizeof(header));
      hang();
    } else if (isCommand(line, "truncated")) {
      const char partial[12] = { 64, 0, 0, 0, 0, 0, 0, 0, '{', '"', 'o', 'k' };
      channel.write(partial, sizeof(partial));
    } else if (isCommand(line, "duplicate")) {
      const std::string body = "{\"ok\":true}";
      std::string frame;
      frame.push_back(static_cast<char>(body.size()));
      frame.append(7, '\0');
      frame.append(body);
      const std::string both = frame + frame;
      channel.write(both.data(), both.size());
      hang();
    } else if (isCommand(line, "late-extra")) {
      ApexVst3Host::writeProtocolFrame("{\"ok\":true,\"sequence\":" + std::to_string(numberField(line, "sequence")) + "}");
      std::this_thread::sleep_for(std::chrono::milliseconds(150));
      ApexVst3Host::writeProtocolFrame("{\"ok\":true,\"sequence\":0}");
      hang();
    } else if (isCommand(line, "bad-json")) {
      ApexVst3Host::writeProtocolFrame("this is not json");
      hang();
    } else if (isCommand(line, "bad-pcm")) {
      const float samples[2] = { std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::quiet_NaN() };
      ApexVst3Host::writeProtocolFrame("{\"ok\":true,\"frames\":1,\"channels\":2}",
        reinterpret_cast<const char*>(samples), sizeof(samples));
      hang();
    } else if (line.find("hang") != std::string::npos) {
      hang();
    } else if (line.find("malformed") != std::string::npos) {
      const char bytes[8] = { '\xff', '\xff', '\xff', '\xff', '\xff', '\xff', '\xff', '\xff' };
      channel.write(bytes, sizeof(bytes));
      // Stay alive so the parent reports the frame, not the exit that follows.
      hang();
    }
    break;
  }
  return 37; // Abrupt helper failure; parent must reject, never emit fake audio.
}
