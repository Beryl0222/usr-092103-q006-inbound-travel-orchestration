/** 领域错误：携带稳定 code，供编排层区分可恢复故障与不可恢复前置条件失败。 */
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new DomainError(code, message, details);
}
