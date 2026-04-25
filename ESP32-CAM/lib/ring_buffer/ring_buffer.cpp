#include "ring_buffer.h"

namespace hf {

RingBuffer::RingBuffer(char* storage, std::size_t capacity)
    : storage_(storage), capacity_(capacity) {}

void RingBuffer::append(const char* data, std::size_t len) {
    if (!storage_ || capacity_ == 0 || !data || len == 0) return;
    for (std::size_t i = 0; i < len; ++i) {
        storage_[head_++] = data[i];
        if (head_ >= capacity_) {
            head_ = 0;
            wrapped_ = true;
        }
    }
}

std::string RingBuffer::snapshot() const {
    if (!storage_ || capacity_ == 0) return {};
    if (!wrapped_) {
        return std::string(storage_, head_);
    }
    std::string out;
    out.reserve(capacity_);
    for (std::size_t i = 0; i < capacity_; ++i) {
        std::size_t idx = (head_ + i) % capacity_;
        out.push_back(storage_[idx]);
    }
    return out;
}

}  // namespace hf
