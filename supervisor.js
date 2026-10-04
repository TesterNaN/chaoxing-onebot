'use strict';
/**
 * 守护进程：把适配器作为**子进程**拉起来，收到重启请求就重启它
 *
 * 为什么不直接把适配器跑成一个 worker 线程：学习通**同一账号不能保持两个连接**（会互踢），
 * 而进程退出 = 连接彻底释放，隔离性最干净；反过来 worker 与主线程共享进程，
 * 原生插件出问题会一起带走，也不好单独观测。
 *
 * 用法：
 *   node supervisor.js                  # 等价于 npm start
 *   node supervisor.js --reverse-ws=ws://127.0.0.1:6199/ws    # 参数原样透传给子进程
 *
 * 它处理三件事：
 *   1. 子进程请求重启（set_restart）→ 等一小会儿再拉起新的（给学习通释放会话留时间）
 *   2. 子进程**意外崩溃** → 带退避重启；窗口内崩太多次就放弃，避免疯狂重登触发风控
 *   3. Ctrl+C / SIGTERM 是**有意停止** → 转发给子进程后一起退出，不会把它当崩溃拉起来
 */
const { fork } = require('child_process');
const path = require('path');

const CHILD = path.join(__dirname, 'onebot.js');
const CHILD_ARGS = process.argv.slice(2);

// 重启间隔：子进程断开学习通 → 新子进程连上，中间留出服务端释放会话的时间
const RESTART_GAP_MS = Number(process.env.CX_RESTART_GAP_MS || 1500);
// 崩溃退避：窗口内最多重启几次
const CRASH_WINDOW_MS = 60000;
const MAX_CRASH_IN_WINDOW = 3;

let child = null;
let stopping = false;      // 有意停止（Ctrl+C），不再拉起
let restartPending = false; // 子进程主动请求重启
let crashTimes = [];

const stamp = () => new Date().toLocaleTimeString('zh-CN');
const log = (...a) => console.log(`[supervisor ${stamp()}]`, ...a);

function spawnChild(reason) {
  log(`启动子进程（${reason}）`);
  child = fork(CHILD, CHILD_ARGS, { cwd: __dirname, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });

  child.on('message', (m) => {
    if (m && m.type === 'restart') {
      restartPending = true;
      log('子进程请求重启');
    }
  });

  child.on('exit', (code, signal) => {
    const bySignal = signal ? `信号 ${signal}` : `退出码 ${code}`;
    child = null;
    if (stopping) { log(`子进程已退出（${bySignal}），父进程随之结束`); process.exit(0); }

    if (restartPending) {
      restartPending = false;
      log(`重启中…（${bySignal}，等 ${RESTART_GAP_MS}ms 让学习通释放会话）`);
      setTimeout(() => spawnChild('set_restart'), RESTART_GAP_MS);
      return;
    }

    // 非请求型退出 = 崩溃
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    crashTimes.push(now);
    if (crashTimes.length > MAX_CRASH_IN_WINDOW) {
      log(`⚠️ ${CRASH_WINDOW_MS / 1000}s 内已崩溃 ${crashTimes.length - 1} 次，放弃自动重启。`);
      log('   检查日志后手动启动；反复重登学习通可能触发风控。');
      process.exit(1);
    }
    log(`⚠️ 子进程意外退出（${bySignal}），${CRASH_WINDOW_MS / 1000}s 内第 ${crashTimes.length} 次，5s 后重启`);
    setTimeout(() => spawnChild('崩溃后自动重启'), 5000);
  });

  child.on('error', (e) => log('子进程错误:', e.message));
}

function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${sig}，转发给子进程并退出`);
  if (child) {
    try { child.kill(sig); } catch (_) {}
    // 兜底：10s 还没退就强杀
    setTimeout(() => { if (child) { try { child.kill('SIGKILL'); } catch (_) {} } }, 10000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log(`守护启动（子进程 ${path.basename(CHILD)}，重启间隔 ${RESTART_GAP_MS}ms）`);
spawnChild('首次启动');
