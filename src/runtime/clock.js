/** 可替换时钟与标识生成，测试可注入固定时间。 */
export class Clock {
  constructor(initial = new Date("2026-10-03T09:00:00+08:00")) {
    this.current = initial;
    this.seq = 0;
  }
  now() {
    return this.current.toISOString();
  }
  advance(ms) {
    this.current = new Date(this.current.getTime() + ms);
  }
  setTime(t) {
    this.current = new Date(t);
  }
  id(prefix) {
    this.seq += 1;
    return `${prefix}_${this.current.getTime().toString(36)}_${this.seq.toString(36)}`;
  }
}
