// 32-бітний Mulberry32 дає ту саму послідовність для того самого seed включно з 0
// повертаю функцію яка пам'ятає state і при виклику дає наступне число від 0 включно до 1 невключно
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}
