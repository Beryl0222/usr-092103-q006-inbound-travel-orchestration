/** 进程内单调编号，供事件与凭证生成稳定 ID（生产实现应替换为 ULID/雪花）。 */
let seq = 0;

export function newId(prefix) {
  seq += 1;
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}

/** 仅供测试重置。 */
export function resetIds() {
  seq = 0;
}
