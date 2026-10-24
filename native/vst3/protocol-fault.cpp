// IPC fault fixture ONLY. Not a plugin and never supplies test audio.
#include <chrono>
#include <iostream>
#include <string>
#include <thread>
int main() {
  std::string line;
  std::getline(std::cin, line);
  if (line.find("hang") != std::string::npos) {
    std::this_thread::sleep_for(std::chrono::seconds(60));
  } else if (line.find("malformed") != std::string::npos) {
    for (int i = 0; i < 8; ++i) std::cout.put(static_cast<char>(255));
    std::cout.flush();
  }
  return 37; // Abrupt helper failure; parent must reject, never emit fake audio.
}
