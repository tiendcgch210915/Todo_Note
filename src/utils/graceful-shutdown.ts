/**
 * Tắt máy gọn khi nhận SIGTERM/SIGINT (Render gửi SIGTERM mỗi lần deploy/restart): dừng các
 * vòng lặp thông báo (chờ nhịp đang gửi xong), đóng server, rồi thoát. Tách ra thành hàm tiêm
 * phụ thuộc để test được mà không cần gửi tín hiệu thật.
 */

export type ShutdownDeps = {
  /** Dừng các vòng lặp nền; phải tự giới hạn thời gian chờ. */
  stop: () => Promise<void>;
  /** Đóng server HTTP (chờ request đang xử lý). */
  close: () => Promise<void>;
  exit: (code: number) => void;
  log: {
    info: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
  /** Quá thời gian này thì thoát cứng (mã 1) kể cả khi chưa đóng xong. */
  hardTimeoutMs?: number;
};

export const createShutdownHandler = (deps: ShutdownDeps) => {
  let started = false;

  return async (signal: string): Promise<void> => {
    if (started) return;
    started = true;
    deps.log.info({ signal }, "Shutting down");

    const hardExit = setTimeout(() => {
      deps.log.error({ signal }, "Shutdown timed out; forcing exit");
      deps.exit(1);
    }, deps.hardTimeoutMs ?? 20_000);
    hardExit.unref();

    let code = 0;
    try {
      await deps.stop();
      await deps.close();
    } catch (error) {
      code = 1;
      deps.log.error(
        { signal, errorName: error instanceof Error ? error.name : "unknown" },
        "Error while shutting down"
      );
    }
    clearTimeout(hardExit);
    deps.exit(code);
  };
};
