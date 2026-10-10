/**
 * Logger dùng chung cho hạ tầng thông báo. Tách khỏi firebase.ts để các module nghiệp vụ
 * (todos, checklists, sync...) có thể log mà KHÔNG kéo theo config/env.ts: import env.ts sẽ
 * thoát tiến trình nếu thiếu biến môi trường, điều mà các test dịch vụ không mong muốn.
 */

export type PushLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

const consoleLogger: PushLogger = {
  info: (obj, msg) => console.info(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

let current: PushLogger = consoleLogger;

/** Logger luôn chuyển tiếp tới logger đang được cấu hình (server gắn `app.log` khi khởi động). */
export const pushLogger: PushLogger = {
  info: (obj, msg) => current.info(obj, msg),
  warn: (obj, msg) => current.warn(obj, msg),
  error: (obj, msg) => current.error(obj, msg),
};

export const setPushLogger = (logger: PushLogger | null): void => {
  current = logger ?? consoleLogger;
};
