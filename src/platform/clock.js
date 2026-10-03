/** 可注入时钟：测试可推进时间以验证占用超时、重试退避与留存到期。 */
export class Clock {
  #epochMs;

  constructor(initial = "2026-10-03T09:00:00+08:00") {
    this.#epochMs = Date.parse(initial);
  }

  now() {
    return new Date(this.#epochMs).toISOString();
  }

  epochMs() {
    return this.#epochMs;
  }

  advance(ms) {
    this.#epochMs += ms;
    return this.now();
  }
}
