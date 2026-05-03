#include "metrics.h"

namespace hf {

HttpCodeRing::HttpCodeRing(int* storage, std::size_t capacity)
    : storage_(storage), capacity_(capacity) {}

void HttpCodeRing::note(int code) {
    if (!storage_ || capacity_ == 0) return;
    storage_[head_] = code;
    head_ = (head_ + 1) % capacity_;
    if (count_ < capacity_) ++count_;
}

std::vector<int> HttpCodeRing::snapshot() const {
    std::vector<int> out;
    if (!storage_ || capacity_ == 0) return out;
    out.reserve(count_);
    // Mirrors the existing logbuf.cpp loop: when count_ < capacity_, the
    // oldest entry is at index 0 and the formula reduces to (i). When the
    // ring is full, the oldest entry sits at head_ and the formula walks
    // forward. Same expression handles both phases.
    for (std::size_t i = 0; i < count_; ++i) {
        std::size_t idx = (head_ + capacity_ - count_ + i) % capacity_;
        out.push_back(storage_[idx]);
    }
    return out;
}

}  // namespace hf
