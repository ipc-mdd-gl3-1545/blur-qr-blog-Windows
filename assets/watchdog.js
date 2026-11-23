/**
 * 前端 watchdog：捕获 JS 运行时错误 / 未处理的 Promise 拒绝 / 资源加载失败，
 * 上报到后端统一错误中心（/api/client-error），让后台「观测中心」能看到线上 bug。
 *
 * 设计原则：
 *  - 静默失败：上报失败绝不影响页面功能
 *  - 限流：同一页面最多上报 20 条，避免死循环刷屏
 *  - 去重：相同 message+stack 只报一次
 *  - 不采集用户输入/密码，只报错误信息、堆栈、页面 URL
 */
(function () {
  'use strict';
  var MAX = 20, sent = 0, seen = Object.create(null);

  function report(kind, message, stack, level) {
    if (sent >= MAX) return;
    var key = kind + '|' + message + '|' + (stack || '').slice(0, 120);
    if (seen[key]) return;
    seen[key] = 1;
    sent++;
    try {
      var body = JSON.stringify({
        message: String(message || '').slice(0, 900),
        stack: String(stack || '').slice(0, 4000),
        kind: kind,
        level: level || 'error',
        page: location.href.slice(0, 500)
      });
      if (navigator.sendBeacon) {
        // sendBeacon 用 text/plain 避免预检；后端 readJsonBody 仍可解析
        var blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
        navigator.sendBeacon('/api/client-error', blob);
      } else {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/client-error', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(body);
      }
    } catch (e) { /* 上报本身绝不能抛错 */ }
  }

  window.addEventListener('error', function (e) {
    // 资源加载失败（img/script/css）也捕获，但只记一条简短信息
    if (e.target && e.target !== window && e.target.tagName) {
      var tag = e.target.tagName.toLowerCase();
      var src = e.target.src || e.target.href || '';
      if (src) report('resource', '资源加载失败 <' + tag + '> ' + src, '', 'warn');
      return;
    }
    report('js', e.message || 'UnknownError', e.error && e.error.stack ? e.error.stack :
      (e.filename + ':' + e.lineno + ':' + e.colno), 'error');
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    var msg = reason && reason.message ? reason.message : String(reason);
    var stack = reason && reason.stack ? reason.stack : '';
    report('promise', '未处理的 Promise 拒绝: ' + msg, stack, 'error');
  });

  // 暴露一个手动上报接口，业务代码可主动记录非致命问题
  window.__reportBug = function (message, detail) {
    report('manual', message, detail || '', 'warn');
  };
})();
