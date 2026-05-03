#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace hf {

// Fixed-capacity ring of recent HTTP response codes.
//
// The firmware records every /upload response (or negative sentinel for
// pre-HTTP failures: -1 camera, -2 connect, -3 body write, -4 invalid
// response). The most recent `capacity` codes ride along in the
// telemetry JSON sent with each image as `last_http_codes` — chronological
// order, oldest first.
//
// Storage is caller-supplied so the firmware can place it in BSS while
// host tests use stack arrays.
class HttpCodeRing {
public:
    HttpCodeRing(int* storage, std::size_t capacity);

    // Insert a new code. Overwrites the oldest entry if the ring is full.
    void note(int code);

    // Snapshot in chronological order, oldest first. Empty if no codes
    // have been recorded yet.
    std::vector<int> snapshot() const;

    std::size_t size() const noexcept { return count_; }
    std::size_t capacity() const noexcept { return capacity_; }

private:
    int* storage_;
    std::size_t capacity_;
    std::size_t head_ = 0;
    std::size_t count_ = 0;
};

// Monotonic counter for WiFi reconnect attempts. A trivial wrapper —
// the type exists so that the telemetry-builder API can take a const
// reference to a metrics struct rather than a free uint32_t, which
// keeps the eventual firmware refactor self-explanatory.
class ReconnectCounter {
public:
    void increment() noexcept { ++value_; }
    std::uint32_t value() const noexcept { return value_; }

private:
    std::uint32_t value_ = 0;
};

}  // namespace hf
