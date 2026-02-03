// src/core/soa.js
// Minimal Structure-of-Arrays helper (used by terrain job queues)
export function makeRingBuffer(capacity) {
  const buf = new Array(capacity);
  let head = 0, tail = 0, size = 0;
  return {
    push(v) {
      if (size >= capacity) return false;
      buf[tail] = v;
      tail = (tail + 1) % capacity;
      size++;
      return true;
    },
    shift() {
      if (size <= 0) return undefined;
      const v = buf[head];
      buf[head] = undefined;
      head = (head + 1) % capacity;
      size--;
      return v;
    },
    get size() { return size; },
    clear() { head = tail = size = 0; buf.fill(undefined); },
  };
}
