/** 세션 토큰·쿠키 등 민감정보는 절대 인자로 넘기지 않습니다. */
const ts = () => new Date().toISOString();
export const log = {
  info: (...a: unknown[]) => console.log(ts(), '[정보]', ...a),
  warn: (...a: unknown[]) => console.warn(ts(), '[경고]', ...a),
  error: (...a: unknown[]) => console.error(ts(), '[오류]', ...a),
};
