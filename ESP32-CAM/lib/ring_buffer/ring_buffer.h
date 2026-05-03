#pragma once

#include <cstddef>
#include <string>

namespace hf {

// Fixed-capacity byte ring buffer.
//
// Backing storage is supplied by the caller (so embedded code can put it in
// a static array, while host tests can use a stack array). Once `capacity`
// bytes have been written, the oldest bytes are overwritten on the next
// append. snapshot() always returns the contents in chronological order:
// oldest byte first, newest byte last.
//
// Used by the firmware's telemetry log (logbuf.cpp): every line emitted by
// logf() is appended; each image upload includes the latest snapshot in
// its `logs` JSON field so failures in the field can be diagnosed after
// the fact.
class RingBuffer {
public:
    RingBuffer(char* storage, std::size_t capacity);

    // Append `len` bytes from `data`. Wraps and overwrites oldest bytes
    // once the buffer fills. Calling with len=0 or null storage is a no-op.
    void append(const char* data, std::size_t len);

    // Current contents, oldest byte first. Returned string has no trailing
    // null and may contain embedded nulls.
    std::string snapshot() const;

    bool wrapped() const noexcept { return wrapped_; }
    std::size_t head() const noexcept { return head_; }
    std::size_t capacity() const noexcept { return capacity_; }

private:
    char* storage_;
    std::size_t capacity_;
    std::size_t head_ = 0;
    bool wrapped_ = false;
};

}  // namespace hf
