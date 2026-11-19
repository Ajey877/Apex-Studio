// Dedicated response channel for the native VST3 helper.
//
// The helper used to write its length-prefixed response frames to stdout.
// stdout belongs to every piece of code in the process, including the plug-in:
// mda Piano, for one, printf()s from its audio loop. That text landed between
// frames and the parent rejected the session ("Invalid VST3 helper frame").
//
// Responses now travel on a descriptor of their own, which the parent creates
// as a fourth stdio pipe and names on the command line (`--protocol-fd=3`).
// stdout and stderr carry diagnostics only, so nothing a plug-in prints, by
// any route (printf, std::cout, a private C runtime, a raw write to descriptor
// 1 or to the Win32 standard output handle), can reach the frame parser.
//
// Header-only so the helper and the protocol fault fixture share one
// implementation.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#ifdef _WIN32
#include <windows.h>
#include <io.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace ApexVst3Host {

// Exit status when the helper is started without a usable protocol channel.
constexpr int kExitNoProtocolChannel = 3;
// Exit status when the parent stopped reading responses (it is gone).
constexpr int kExitProtocolChannelBroken = 4;

class ProtocolChannel {
public:
  /** Adopt the descriptor named by `--protocol-fd=<n>`. Returns false, with a
   *  reason in `error`, when the argument is missing or the descriptor is not
   *  an open pipe/socket/file. Never falls back to stdout. */
  bool open(int argc, char** argv, std::string& error) {
    int fd = -1;
    static const char prefix[] = "--protocol-fd=";
    for (int i = 1; i < argc; ++i) {
      if (std::strncmp(argv[i], prefix, sizeof(prefix) - 1) != 0) continue;
      const char* text = argv[i] + sizeof(prefix) - 1;
      char* end = nullptr;
      const long value = std::strtol(text, &end, 10);
      // 0-2 are the standard streams; they are never a protocol channel.
      if (end == text || *end != '\0' || value < 3 || value > 255) {
        error = "invalid --protocol-fd value";
        return false;
      }
      fd = static_cast<int>(value);
    }
    if (fd < 0) {
      error = "no --protocol-fd=<n> argument; responses are never written to stdout";
      return false;
    }
#ifdef _WIN32
    // _get_osfhandle() on a descriptor the parent did not pass runs the CRT
    // invalid-parameter handler, which terminates the process by default.
    // Report a normal error instead.
    const auto previous = _set_thread_local_invalid_parameter_handler(ignoreInvalidParameter);
    const intptr_t raw = _get_osfhandle(fd);
    _set_thread_local_invalid_parameter_handler(previous);
    if (raw == -1 || raw == -2) {
      error = "descriptor " + std::to_string(fd) + " is not open";
      return false;
    }
    const HANDLE handle = reinterpret_cast<HANDLE>(raw);
    if (GetFileType(handle) == FILE_TYPE_UNKNOWN) {
      error = "descriptor " + std::to_string(fd) + " is not a usable handle";
      return false;
    }
    // A plug-in may start child processes; they must not inherit this pipe.
    SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
    handle_ = handle;
#else
    struct stat info {};
    if (::fstat(fd, &info) != 0) {
      error = "descriptor " + std::to_string(fd) + " is not open";
      return false;
    }
    const int flags = ::fcntl(fd, F_GETFD);
    if (flags != -1) ::fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
    fd_ = fd;
#endif
    open_ = true;
    return true;
  }

  /** Write the whole buffer or mark the channel broken. A frame is passed in
   *  one call so that it is contiguous on the pipe. */
  bool write(const char* data, size_t size) {
    if (!open_ || broken_) return false;
    while (size > 0) {
#ifdef _WIN32
      const DWORD chunk = size > (1u << 20) ? (1u << 20) : static_cast<DWORD>(size);
      DWORD written = 0;
      if (!WriteFile(handle_, data, chunk, &written, nullptr) || written == 0) { broken_ = true; return false; }
      data += written;
      size -= written;
#else
      const ssize_t written = ::write(fd_, data, size);
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) { broken_ = true; return false; }
      data += written;
      size -= static_cast<size_t>(written);
#endif
    }
    return true;
  }

  bool isOpen() const { return open_; }
  /** True once a write failed: the parent can no longer be answered. */
  bool isBroken() const { return broken_; }

private:
#ifdef _WIN32
  static void ignoreInvalidParameter(const wchar_t*, const wchar_t*, const wchar_t*, unsigned int, uintptr_t) {}
  HANDLE handle_ = nullptr;
#else
  int fd_ = -1;
#endif
  bool open_ = false;
  bool broken_ = false;
};

inline ProtocolChannel& protocolChannel() {
  static ProtocolChannel channel;
  return channel;
}

/** Binary framing: little-endian uint32 JSON length, uint32 payload byte
 *  length, UTF-8 JSON, then the payload. Returns false if the parent is gone. */
inline bool writeProtocolFrame(const std::string& json, const char* payload = nullptr, size_t payloadBytes = 0) {
  std::string frame;
  frame.reserve(8 + json.size() + payloadBytes);
  const auto put32 = [&frame](uint32_t value) {
    for (int i = 0; i < 4; ++i) frame.push_back(static_cast<char>((value >> (8 * i)) & 255));
  };
  put32(static_cast<uint32_t>(json.size()));
  put32(static_cast<uint32_t>(payloadBytes));
  frame.append(json);
  if (payloadBytes) frame.append(payload, payloadBytes);
  return protocolChannel().write(frame.data(), frame.size());
}

} // namespace ApexVst3Host
